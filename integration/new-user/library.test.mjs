// Round 44: a library package with an interface, generic functions and a generic struct, used
// from a program in the same workspace (book chapters 6 and 12, reference Generics and
// Interfaces and impls).
import { strict as assert } from 'node:assert'
import { before, test } from 'node:test'
import { here, join, read, sharedHome, sh, show, silk, write } from './lib.mjs'

const h = sharedHome()
let serial = 0

const library = '[package]\nname = "geo"\nversion = "0.1.0"\nsilk-version = "0.0.0"\nkind = "library"\nexports = ["lib"]\n'
const program = '[package]\nname = "app"\nsilk-version = "0.0.0"\n\n[dependencies]\ngeo = { path = "../geo" }\n'

// A workspace with geo (library) and app (program), returning its folder.
function workspace(lib, main, geoManifest = library) {
  const dir = join(h.work, `shapes-${++serial}`)
  write(join(dir, 'silk.toml'), '[workspace]\nmembers = ["geo", "app"]\n')
  write(join(dir, 'geo/silk.toml'), geoManifest)
  write(join(dir, 'geo/src/lib.silk'), lib)
  write(join(dir, 'app/silk.toml'), program)
  write(join(dir, 'app/src/main.silk'), main)
  return dir
}

const appBinary = (dir) => join(dir, 'build/llvm/x86_64-unknown-linux-gnu/debug/app')

let geo
before(() => {
  geo = workspace(read(join(here, 'programs/geo/lib.silk')), read(join(here, 'programs/geo/main.silk')))
})

test('a program uses a library interface, its default operation and generic helpers', () => {
  const built = silk(h, ['build', '-p', 'app'], { cwd: geo })
  assert.equal(built.status, 0, show(built))
  const ran = sh(h, appBinary(geo), { cwd: geo })
  assert.equal(ran.status, 0, show(ran))
})

test('the library test passes from the workspace root', () => {
  const result = silk(h, ['test', '--no-cache'], { cwd: geo })
  assert.equal(result.status, 0, show(result))
  assert.match(result.stdout, /Workspace summary: 2 packages succeeded, 0 failed/)
})

test('changing a default operation in the library reaches the program on the next build', () => {
  const path = join(geo, 'geo/src/lib.silk')
  const original = read(path)
  write(path, original.replace('fn corners(shape: &Self) -> i64 {\n    return 0', 'fn corners(shape: &Self) -> i64 {\n    return 7'))
  try {
    assert.equal(silk(h, ['build', '-p', 'app'], { cwd: geo }).status, 0)
    assert.equal(sh(h, appBinary(geo), { cwd: geo }).status, 2, 'three circles now have 21 corners')
  } finally {
    write(path, original)
  }
  assert.equal(silk(h, ['build', '-p', 'app'], { cwd: geo }).status, 0)
  assert.equal(sh(h, appBinary(geo), { cwd: geo }).status, 0)
})

test('changing a generic body in the library reaches the program on the next build', () => {
  const path = join(geo, 'geo/src/lib.silk')
  const original = read(path)
  write(path, original.replace('total = total + shapes[index].area()', 'total = total + shapes[index].area() + 1'))
  try {
    assert.equal(silk(h, ['build', '-p', 'app'], { cwd: geo }).status, 0)
    assert.equal(sh(h, appBinary(geo), { cwd: geo }).status, 2)
  } finally {
    write(path, original)
  }
  assert.equal(silk(h, ['build', '-p', 'app'], { cwd: geo }).status, 0)
  assert.equal(sh(h, appBinary(geo), { cwd: geo }).status, 0)
})

test('a bound the program type does not meet names the type and the bound', () => {
  const dir = workspace(read(join(here, 'programs/geo/lib.silk')), read(join(here, 'programs/geo/main.silk')).replace('impl Copy for Circle {}', ''))
  const result = silk(h, ['check', '-p', 'app'], { cwd: dir })
  assert.equal(result.status, 1, show(result))
  assert.match(result.stderr, /error\[SEM0121\] `main\.Circle: Copy` cannot be proved/)
})

test('an extra member in an impl of a library interface is named', () => {
  const main = read(join(here, 'programs/geo/main.silk')).replace('    return 3 * shape.radius * shape.radius\n  }', '    return 3 * shape.radius * shape.radius\n  }\n\n  fn sides(shape: &Self) -> i64 {\n    return 1\n  }')
  const result = silk(h, ['check', '-p', 'app'], { cwd: workspace(read(join(here, 'programs/geo/lib.silk')), main) })
  assert.match(result.stderr, /error\[SEM0083\] Invalid conformance: `sides` is not an operation of `Shape`/)
})

const smallLib = `pub interface Shape {
  fn area(shape: &Self) -> i64
}

pub struct Square {
  side: i64,
}

pub struct Best<T> {
  pub value: T,
  pub score: i64,
}

pub fn keep<T>(value: T) -> Best<T> {
  let best = Best<T> { value: move value, score: 1 }
  return move best
}
`

test('an impl of a library interface for a type of neither package says where impls may live', () => {
  const main = 'import geo.lib { Shape }\n\nimpl Shape for i64 {\n  fn area(shape: &Self) -> i64 {\n    return 0\n  }\n}\n\npub fn main() -> i32 {\n  return 0\n}\n'
  const result = silk(h, ['check', '-p', 'app'], { cwd: workspace(smallLib, main) })
  assert.match(result.stderr, /error\[SEM0083\]/)
  assert.doesNotMatch(result.stderr, /An invalid source-declared capability implementation/)
  assert.match(result.stderr, /`i64` is a builtin type, so this impl must be in `geo\.lib`/)
})

test('a mistake in a library generic body is reported once, in the library', () => {
  const main = 'import geo.lib { keep }\n\npub fn main() -> i32 {\n  let kept = keep(5)\n  return 0\n}\n'
  const result = silk(h, ['check', '-p', 'app'], { cwd: workspace(smallLib.replace('return move best', 'return best'), main) })
  assert.equal(result.status, 1, show(result))
  assert.match(result.stderr, /geo\/src\/lib\.silk:16:10: error\[OWN0003\] Moving best requires an explicit move/)
  assert.doesNotMatch(result.stderr, /app\/src\/main\.silk:\d+:\d+: error/)
})

test('a library type in a message carries its package, not only its module', () => {
  const main = 'import geo.lib { Square }\n\npub fn main() -> i32 {\n  let square = Square { side: 2 }\n  return 0\n}\n'
  const result = silk(h, ['check', '-p', 'app'], { cwd: workspace(smallLib, main) })
  assert.match(result.stderr, /error\[SEM0021\] Cannot construct geo\.lib\.Square here/)
})

test('a library manifest without kind hints at kind = "library"', () => {
  const main = 'import geo.lib { Square }\n\npub fn main() -> i32 {\n  return 0\n}\n'
  const result = silk(h, ['check'], { cwd: workspace(smallLib, main, '[package]\nname = "geo"\nsilk-version = "0.0.0"\n') })
  assert.match(result.stderr, /kind = "library"/)
})

test('mismatched array elements name both types', () => {
  const main = 'struct Circle {\n  radius: i64,\n}\n\nstruct Tri {\n  base: i64,\n}\n\npub fn main() -> i32 {\n  let mixed = [Circle { radius: 1 }, Tri { base: 2 }]\n  return 0\n}\n'
  const result = silk(h, ['check', '-p', 'app'], { cwd: workspace(smallLib, main) })
  assert.match(result.stderr, /error\[SEM0030\].*Circle.*Tri|error\[SEM0030\].*Tri.*Circle/)
})
