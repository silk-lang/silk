// The Package parameters reference: `param` declarations, defaults, `where`, bindings in
// [[build.bindings]] and in a profile, precedence, and the refusals the page lists.
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { initPackage, join, read, sharedHome, show, silk, write } from './lib.mjs'

const h = sharedHome()
let serial = 0

// A package with `source` as src/main.silk and `extra` appended to its silk.toml.
function pkg(source, extra = '') {
  const dir = initPackage(h, `params-${++serial}`)
  write(join(dir, 'src/main.silk'), source)
  if (extra !== '') write(join(dir, 'silk.toml'), `${read(join(dir, 'silk.toml'))}\n${extra}`)
  return dir
}

const nameOf = (dir) => dir.split('/').at(-1)
const binding = (dir, parameter, value, table = 'build.bindings') =>
  `[[${table}]]\npackage = "${nameOf(dir)}@0.1.0"\nmodule = "main"\nparameter = "${parameter}"\nvalue = ${value}\norigin = { source = "silk.toml", provenance = "literal" }\n`

// The page's first example: defaults, a `where`, a dependent default and a static argument.
const example = `pub param verbose: bool = false

pub param workers: i32 = 4 where workers > 0 && workers <= 64

param queueDepth: i32 = workers * 8

pub param label: string = "service"

fn spread(static count: i32, items: i32) -> i32 {
  return items / count
}

pub fn main() -> i32 {
  static if verbose {
    return 1
  }
  if queueDepth != 32 {
    return 2
  }
  if label != "service" {
    return 3
  }
  return spread(workers, 8) - 2
}
`

test('the defaults example runs and exits 0', () => {
  const result = silk(h, ['run'], { cwd: pkg(example) })
  assert.equal(result.status, 0, show(result))
})

test('a project binding changes a parameter and its dependents', () => {
  const dir = pkg(example)
  write(join(dir, 'silk.toml'), `${read(join(dir, 'silk.toml'))}\n${binding(dir, 'workers', '{ kind = "integer", value = "8" }')}`)
  // workers 8: queueDepth is 64, so main returns 2.
  const result = silk(h, ['run'], { cwd: dir })
  assert.equal(result.status, 2, show(result))
})

test('a binding that breaks the where predicate is refused at the predicate', () => {
  const dir = pkg(example)
  write(join(dir, 'silk.toml'), `${read(join(dir, 'silk.toml'))}\n${binding(dir, 'workers', '{ kind = "integer", value = "65" }')}`)
  const result = silk(h, ['check'], { cwd: dir })
  assert.notEqual(result.status, 0, show(result))
  assert.match(result.stderr, /src\/main\.silk:3:\d+: error\[SEM0214\] Invalid compilation configuration: the bound value of package parameter `workers` does not satisfy its `where` predicate/)
})

test('a profile binding beats a project binding, and both are type-checked', () => {
  const dir = pkg(`pub param port: u16
pub param verbose: bool = false
param retries: i32 = 3 where retries >= 0

pub fn main() -> i32 {
  if port != 8080 { return 1 }
  static if !verbose { return 2 }
  return retries - 3
}
`)
  const base = read(join(dir, 'silk.toml'))
  const manifest = `${base}\n[build]\nprofile = "dev"\n\n${binding(dir, 'port', '{ kind = "integer", value = "8080" }')}\n[profiles.dev]\ntarget = "x86_64-unknown-linux-gnu"\n\n${binding(dir, 'verbose', '{ kind = "boolean", value = true }', 'profiles.dev.bindings')}`
  write(join(dir, 'silk.toml'), manifest)
  const dev = silk(h, ['run'], { cwd: dir })
  assert.equal(dev.status, 0, show(dev))
  // --release builds without the profile: only the project binding applies, so verbose stays false.
  const release = silk(h, ['run', '--release'], { cwd: dir })
  assert.equal(release.status, 2, show(release))
})

test('a pub param with no default and no binding is reported at its declaration', () => {
  const result = silk(h, ['check'], { cwd: pkg('pub param x: i32\n\npub fn main() -> i32 {\n  return x\n}\n') })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /src\/main\.silk:1:1: error\[SEM0214\] Invalid compilation configuration: package parameter `x` has no default value and no binding; give it a default or bind it in `\[build\]\.bindings` of silk\.toml/)
})

test('declaration mistakes are SEM0214 with the reason the page gives', () => {
  for (const [source, message] of [
    ['param x: i32\n', /a private package parameter needs a default value/],
    ['pub param o: f64 = 1.0\n', /a package parameter's type must be bool, an integer, a string, or a fixed array of them/],
    ['import silk.option { Option }\n\npub param e: Option<i32> = Option<i32>.None\n', /package parameter `e` has an enum, struct, union or optional type, which package parameters do not support yet/],
    ['param a: i32 = true\n', /the default value of package parameter `a` does not have its type `i32`/],
    ['pub param w: i32 = 4 where 1\n', /the `where` predicate of package parameter `w` is not a `bool`/],
  ]) {
    const result = silk(h, ['check'], { cwd: pkg(`${source}\npub fn main() -> i32 {\n  return 0\n}\n`) })
    assert.notEqual(result.status, 0, `${source}\n${show(result)}`)
    assert.match(result.stderr, /error\[SEM0214\] Invalid compilation configuration: /, show(result))
    assert.match(result.stderr, message, show(result))
  }
})

test('assigning to a parameter is SEM0036, and defaults that read each other are SEM0223', () => {
  const assigned = silk(h, ['check'], { cwd: pkg('param x: i32 = 1\n\npub fn main() -> i32 {\n  x = 2\n  return x\n}\n') })
  assert.match(assigned.stderr, /error\[SEM0036\]/, show(assigned))
  const cycle = silk(h, ['check'], { cwd: pkg('param a: i32 = b + 1\nparam b: i32 = a + 1\n\npub fn main() -> i32 {\n  return a\n}\n') })
  assert.match(cycle.stderr, /error\[SEM0223\]/, show(cycle))
})

test('bad bindings are refused at their silk.toml line and name the parameter', () => {
  const source = 'pub param x: i32 = 1\n\npub fn main() -> i32 {\n  return x\n}\n'
  for (const [parameter, value, message] of [
    ['x', '{ kind = "boolean", value = true }', /error\[SEM0214\] invalid package parameter binding: the value bound to `x` does not have its parameter's type/],
    ['x', '{ kind = "integer", value = "99999999999" }', /error\[SEM0214\] invalid package parameter binding: .*`x`/],
    ['y', '{ kind = "integer", value = "1" }', /module `main\.silk` declares no package parameter `y`/],
  ]) {
    const dir = pkg(source)
    const manifest = `${read(join(dir, 'silk.toml'))}\n${binding(dir, parameter, value)}`
    write(join(dir, 'silk.toml'), manifest)
    const result = silk(h, ['check'], { cwd: dir })
    assert.notEqual(result.status, 0, show(result))
    const line = manifest.slice(0, manifest.indexOf(`parameter = "${parameter}"`)).split('\n').length
    assert.match(result.stderr, new RegExp(`silk\\.toml:${line}: `), show(result))
    assert.match(result.stderr, message, show(result))
  }
})

test('a binding for a private parameter is refused', () => {
  const dir = pkg('param x: i32 = 1\n\npub fn main() -> i32 {\n  return x\n}\n')
  write(join(dir, 'silk.toml'), `${read(join(dir, 'silk.toml'))}\n${binding(dir, 'x', '{ kind = "integer", value = "2" }')}`)
  const result = silk(h, ['check'], { cwd: dir })
  assert.notEqual(result.status, 0, show(result))
  assert.match(result.stderr, /`x`/, show(result))
})

test('two project bindings for one parameter conflict, even with equal values', () => {
  const dir = pkg('pub param x: i32 = 1\n\npub fn main() -> i32 {\n  return x\n}\n')
  const one = binding(dir, 'x', '{ kind = "integer", value = "2" }')
  write(join(dir, 'silk.toml'), `${read(join(dir, 'silk.toml'))}\n${one}\n${one}`)
  const result = silk(h, ['check'], { cwd: dir })
  assert.notEqual(result.status, 0, show(result))
})

test('a secret binding stops every build, even in a profile nobody selects', () => {
  const dir = pkg('pub param x: i32 = 1\n\npub fn main() -> i32 {\n  return x\n}\n')
  const secret = binding(dir, 'x', '{ kind = "integer", value = "2" }', 'profiles.unused.bindings').replace('provenance = "literal"', 'provenance = "secret"')
  write(join(dir, 'silk.toml'), `${read(join(dir, 'silk.toml'))}\n[profiles.unused]\ntarget = "x86_64-unknown-linux-gnu"\n\n${secret}`)
  const result = silk(h, ['build'], { cwd: dir })
  assert.equal(result.status, 2, show(result))
  assert.match(result.stderr, /ForbiddenProvenance: profiles\.unused\.bindings: origin\.provenance = "secret" cannot be bound in a manifest/)
})

test('binding mistakes in the table itself are named', () => {
  const source = 'pub param x: i32 = 1\n\npub fn main() -> i32 {\n  return x\n}\n'
  for (const [edit, message] of [
    [(b) => b.replace(/package = .*\n/, ''), /InvalidInput: build\.bindings: package is missing; a binding names its package, module and parameter/],
    [(b) => b.replace(/value = .*\n/, 'value = 3\n'), /InvalidInput: build\.bindings: value must be a table with a kind, such as \{ kind = "integer", value = "1" \}/],
    [(b) => b.replace('kind = "integer"', 'kind = "float"'), /value\.kind must be integer, boolean, string, enum, none, some, array or record/],
    [(b) => `${b}extra = 1\n`, /build\.bindings\.extra is not a supported field/],
    [(b) => b.replace('provenance = "literal"', 'provenance = "bogus"'), /InvalidInput: build\.bindings: origin\.provenance = "bogus" is not literal, translated-public, secret, physical-supply or runtime/],
  ]) {
    const dir = pkg(source)
    write(join(dir, 'silk.toml'), `${read(join(dir, 'silk.toml'))}\n${edit(binding(dir, 'x', '{ kind = "integer", value = "2" }'))}`)
    const result = silk(h, ['check'], { cwd: dir })
    assert.equal(result.status, 2, show(result))
    assert.match(result.stderr, message, show(result))
  }
})

test('a module-level static if can choose declarations on a parameter', () => {
  const dir = pkg('pub param fast: bool = false\n\nstatic if fast {\n  fn speed() -> i32 {\n    return 9\n  }\n} else {\n  fn speed() -> i32 {\n    return 1\n  }\n}\n\npub fn main() -> i32 {\n  return speed()\n}\n')
  const plain = silk(h, ['run'], { cwd: dir })
  assert.equal(plain.status, 1, show(plain))
  write(join(dir, 'silk.toml'), `${read(join(dir, 'silk.toml'))}\n${binding(dir, 'fast', '{ kind = "boolean", value = true }')}`)
  const fast = silk(h, ['run'], { cwd: dir })
  assert.equal(fast.status, 9, show(fast))
})
