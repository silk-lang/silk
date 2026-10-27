// Round 55: sorting and searching (std/list sort and binarySearch, std/order): a user Order on a
// struct that owns a String, stability, descending order through a wrapper type, 5000 values, empty
// and one-element lists, and the messages for types without an Order.
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { here, initPackage, join, read, sharedHome, show, silk, write } from './lib.mjs'

const h = sharedHome()
let serial = 0

function project(source) {
  const dir = initPackage(h, `sorting-${++serial}`)
  write(join(dir, 'src/main.silk'), source)
  return dir
}

test('the sorting program in programs/ passes all its checks', () => {
  const result = silk(h, ['run'], { cwd: project(read(join(here, 'programs/sorting.silk'))) })
  assert.equal(result.status, 0, show(result))
})

const sortOf = (type, value) => `import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.list { List }

struct P {
  x: i32,
}

pub effect fn main() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let mut l = List<${type}>.make()
  run List<${type}>.append(&mut l, ${value}) |> Effect.provideMut<Allocator>(&mut allocator)
  run List<${type}>.sort(&mut l) |> Effect.provideMut<Allocator>(&mut allocator)
  return 0
}
`

test('sorting a struct without Order names the type', () => {
  const result = silk(h, ['check'], { cwd: project(sortOf('P', 'P { x: 1 }')) })
  assert.match(result.stderr, /SEM0121\] `main\.P: [\w.]*Order` cannot be proved: no implementation of `[\w.]*Order` exists for `main\.P`/, show(result))
})

test('comparing structs by value says to compare borrows', () => {
  const result = silk(h, ['check'], { cwd: project('import silk.order { Order, Ordering }\n\nstruct P {\n  x: i32,\n}\n\nfn cmp(left: &P, right: &P) -> Ordering {\n  return Ordering.Equal\n}\n\nimpl Order for P {\n  compare: P.cmp\n}\n\npub fn main() -> i32 {\n  let a = P { x: 1 }\n  let b = P { x: 2 }\n  if a < b { return 1 }\n  return 0\n}\n') })
  assert.match(result.stderr, /SEM0135\] Operator < does not accept \(main\.P, main\.P\); compare shared borrows, as in `&a < &b`/, show(result))
})

// Finding 169, fixed by #2403: the Order a user imports is silk.order.Order.
test('a missing Order names silk.order.Order, not the intrinsic path', () => {
  const result = silk(h, ['check'], { cwd: project(sortOf('P', 'P { x: 1 }')) })
  assert.doesNotMatch(result.stderr, /intrinsic\.operators\.Order/, show(result))
})

// #2405: Order for string (byte-wise) and f32/f64 (IEEE totalOrder), and Option.isSome/isNone.
test('strings and floats sort, and binarySearch answers isSome/isNone', () => {
  const result = silk(h, ['run', '--quiet'], { cwd: project(`import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.list { List }
import silk.option { Option }

effect fn body() -> i32 ! OutOfMemoryError ? &mut Allocator {
  let mut words = List<string>.make()
  run List<string>.append(&mut words, "pear")
  run List<string>.append(&mut words, "Apple")
  run List<string>.append(&mut words, "app")
  run List<string>.append(&mut words, "apple")
  run List<string>.sort(&mut words)
  let w = List<string>.asSlice(&words)
  if w[0] != "Apple" || w[1] != "app" || w[2] != "apple" || w[3] != "pear" { return 1 }
  let found = List<string>.binarySearch(&words, "apple")
  let missing = List<string>.binarySearch(&words, "plum")
  if !Option<usize>.isSome(&found) || !Option<usize>.isNone(&missing) { return 2 }
  let mut xs = List<f64>.make()
  run List<f64>.append(&mut xs, 2.5)
  run List<f64>.append(&mut xs, -0.0)
  run List<f64>.append(&mut xs, -3.0)
  run List<f64>.append(&mut xs, 0.0)
  run List<f64>.sort(&mut xs)
  let x = List<f64>.asSlice(&xs)
  if x[0] != -3.0 || x[3] != 2.5 { return 3 }
  return 0
}

effect fn recover(error: OutOfMemoryError) -> i32 {
  return 9
}

pub fn main() -> i32 {
  let mut allocator = Allocator.systemAllocatorProvider()
  return run Effect.catchAll(body() |> Effect.provideMut<Allocator>(&mut allocator), recover)
}
`) })
  assert.equal(result.status, 0, show(result))
})
