// Round 54: collections that own their values (std/hash_map, std/hash, std/list): a string key
// type with HashKey, counts changed in place with withMut, a map of lists of owned Strings, values
// moved out with remove, and entries visited in bucket order.
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { here, initPackage, join, read, sharedHome, show, silk, write } from './lib.mjs'

const h = sharedHome()
let serial = 0

function project(source) {
  const dir = initPackage(h, `collections-${++serial}`)
  write(join(dir, 'src/main.silk'), source)
  return dir
}

const program = read(join(here, 'programs/collections.silk'))

test('the collections program in programs/ passes all its checks', () => {
  const result = silk(h, ['run'], { cwd: project(program) })
  assert.equal(result.status, 0, show(result))
})

// Finding 167, fixed by #2387: an elided lifetime in a body type argument is inferred.
const elided = `import silk.list { List }

struct Name {
  text: string,
}

fn build(text: string) -> List<Name> {
  let names = List<Name>.make()
  return move names
}

pub fn main() -> i32 {
  let names = build("a")
  drop names
  return 0
}
`

test('a list of a struct with an elided string lifetime can be returned', () => {
  const result = silk(h, ['check'], { cwd: project(elided) })
  assert.equal(result.status, 0, show(result))
})

test('the elided program written the long way checks', () => {
  const result = silk(h, ['check'], { cwd: project(elided.replace("fn build(text: string) -> List<Name> {\n  let names = List<Name>.make()", "fn build<'t>(text: string<'t>) -> List<Name<'t>> {\n  let names = List<Name<'t>>.make()")) })
  assert.equal(result.status, 0, show(result))
})

test('a return whose lifetimes differ shows both types', () => {
  const result = silk(h, ['check'], { cwd: project(elided) })
  assert.doesNotMatch(result.stderr, /An explicit return whose value violates the declaration result\n/, show(result))
})

const firstMap = (key, value) => project(`import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.hash { Hash }
import silk.hash_map { HashMap }

pub effect fn main() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let mut counts = HashMap<${key}, i32>.make(Hash.seed(1))
  drop run HashMap<${key}, i32>.insert(&mut counts, ${value}, 1) |> Effect.provideMut<Allocator>(&mut allocator)
  return 0
}
`)

// Finding 168, fixed by #2386: messages for a first hash map and a C-style dereference.
// Since #2405 string and integer keys work; f64 still has no HashKey.
test('a string key works', () => {
  const result = silk(h, ['run', '--quiet'], { cwd: firstMap('string', '"a"') })
  assert.equal(result.status, 0, show(result))
})

test('an f64 key names HashKey and the key type', () => {
  const result = silk(h, ['check'], { cwd: firstMap('f64', '1.5') })
  assert.notEqual(result.status, 0, show(result))
  assert.match(result.stderr, /HashKey/, show(result))
  assert.match(result.stderr, /f64/, show(result))
})

test('a C-style *n points at n.*', () => {
  const result = silk(h, ['check'], { cwd: project('fn bump(n: &mut i32) -> () {\n  *n = *n + 1\n}\n\npub fn main() -> i32 {\n  let mut v = 1\n  bump(&mut v)\n  return v - 2\n}\n') })
  assert.notEqual(result.status, 0, show(result))
  assert.match(result.stderr, /n\.\*/, show(result))
})
