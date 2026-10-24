// The Package parameters reference: `param` declarations, defaults, `where`, values in [config]
// and in a profile's config, precedence, and the refusals the manifest gives.
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

const lineOf = (text, needle) => text.slice(0, text.indexOf(needle)).split('\n').length

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


test('a [config] value changes a parameter and its dependents', () => {
  // workers 8: queueDepth is 64, so main returns 2.
  const result = silk(h, ['run'], { cwd: pkg(example, '[config]\nmain.workers = 8\n') })
  assert.equal(result.status, 2, show(result))
})

test('a value that breaks the where predicate is refused at the predicate', () => {
  const result = silk(h, ['check'], { cwd: pkg(example, '[config]\nmain.workers = 65\n') })
  assert.notEqual(result.status, 0, show(result))
  assert.match(result.stderr, /src\/main\.silk:3:\d+: error\[SEM0214\] Invalid compilation configuration: the bound value of package parameter `workers` does not satisfy its `where` predicate/)
})

test('a profile config value beats [config], and --release keeps only [config]', () => {
  const dir = pkg(`pub param port: u16
pub param verbose: bool = false
param retries: i32 = 3 where retries >= 0

pub fn main() -> i32 {
  if port != 8080 { return 1 }
  static if !verbose { return 2 }
  return retries - 3
}
`, '[build]\nprofile = "dev"\n\n[config]\nmain.port = 8080\nmain.verbose = false\n\n[profiles.dev]\ntarget = "x86_64-unknown-linux-gnu"\nconfig.main.verbose = true\n')
  const dev = silk(h, ['run'], { cwd: dir })
  assert.equal(dev.status, 0, show(dev))
  const release = silk(h, ['run', '--release'], { cwd: dir })
  assert.equal(release.status, 2, show(release))
})

test('a pub param with no default and no binding is reported at its declaration', () => {
  const result = silk(h, ['check'], { cwd: pkg('pub param x: i32\n\npub fn main() -> i32 {\n  return x\n}\n') })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /src\/main\.silk:1:1: error\[SEM0214\] Invalid compilation configuration: package parameter `x` has no default value and no binding; give it a default or set it under `\[config\]` in silk\.toml/)
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


test('bad values are refused at the line of their key', () => {
  const source = 'pub param x: i32 = 1\n\npub fn main() -> i32 {\n  return x\n}\n'
  for (const [config, key, message] of [
    ['[config]\nmain.x = true\n', 'main.x', /`x`/],
    ['[config]\nmain.x = 99999999999\n', 'main.x', /`x`/],
    ['[config]\nmain.y = 1\n', 'main.y', /declares no package parameter `y`/],
    ['[config]\nmain.x = 1.5\n', 'main.x', /InvalidInput: config\.main\.x: a package parameter value is an integer, a boolean, a string or an array of them/],
    ['[config]\nx = 1\n', 'x = 1', /InvalidInput: config\.x: name the module before the parameter, as config\.main\.x/],
  ]) {
    const dir = pkg(source, config)
    const manifest = read(join(dir, 'silk.toml'))
    const result = silk(h, ['check'], { cwd: dir })
    assert.notEqual(result.status, 0, `${config}\n${show(result)}`)
    assert.match(result.stderr, new RegExp(`silk\\.toml:${lineOf(manifest, `\n${key}`) + 1}: `), `${config}\n${show(result)}`)
    assert.match(result.stderr, message, `${config}\n${show(result)}`)
  }
})

test('a value for a private parameter is refused', () => {
  const result = silk(h, ['check'], { cwd: pkg('param x: i32 = 1\n\npub fn main() -> i32 {\n  return x\n}\n', '[config]\nmain.x = 2\n') })
  assert.notEqual(result.status, 0, show(result))
  assert.match(result.stderr, /`x`/, show(result))
})

test('the earlier binding tables are refused and name [config]', () => {
  const source = 'pub param x: i32 = 1\n\npub fn main() -> i32 {\n  return x\n}\n'
  for (const [extra, message] of [
    ['[[build.bindings]]\nparameter = "x"\n', /build\.bindings is an earlier spelling; write config, as config\.main\.limit = 42/],
    ['[profiles.p]\ntarget = "x86_64-unknown-linux-gnu"\nbindings = []\n', /InvalidInput: profiles\.p\.bindings is an earlier spelling; write config/],
  ]) {
    const result = silk(h, ['check'], { cwd: pkg(source, extra) })
    assert.equal(result.status, 2, show(result))
    assert.match(result.stderr, message, show(result))
  }
})

test('a module-level static if can choose declarations on a parameter', () => {
  const source = 'pub param fast: bool = false\n\nstatic if fast {\n  fn speed() -> i32 {\n    return 9\n  }\n} else {\n  fn speed() -> i32 {\n    return 1\n  }\n}\n\npub fn main() -> i32 {\n  return speed()\n}\n'
  const plain = silk(h, ['run'], { cwd: pkg(source) })
  assert.equal(plain.status, 1, show(plain))
  const fast = silk(h, ['run'], { cwd: pkg(source, '[config]\nmain.fast = true\n') })
  assert.equal(fast.status, 9, show(fast))
})
