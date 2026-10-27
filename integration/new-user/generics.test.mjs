// Round 57: generic structs with interface bounds (reference Generics, Interfaces and impls):
// conditional conformance through Pair<T> and Boxed<T>, a default operation and its override,
// generic interface operations (#2407) with written and inferred type arguments, bounded helpers.
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { here, initPackage, join, read, sharedHome, show, silk, write } from './lib.mjs'

const h = sharedHome()
let serial = 0
const program = read(join(here, 'programs/generics.silk'))

function variant(from = '', to = '') {
  assert.ok(program.includes(from), `the program contains ${from}`)
  const dir = initPackage(h, `generics-${++serial}`)
  write(join(dir, 'src/main.silk'), program.replace(from, to))
  return dir
}

const end = '  return 0\n}\n'
const check = (dir) => silk(h, ['check'], { cwd: dir })

test('the generics program in programs/ passes all its checks', () => {
  const result = silk(h, ['run'], { cwd: variant() })
  assert.equal(result.status, 0, show(result))
})

test('a Pair of a type without the bound names the missing conformance', () => {
  const result = check(variant(end, '  let cp = Pair<Coin> { left: heads, right: tails }\n  if cp.weight() != 0 { return 10 }\n' + end))
  assert.match(result.stderr, /SEM0121\] `main\.Coin: main\.Weight` cannot be proved: no implementation of `main\.Weight` exists for `main\.Coin`/, show(result))
})

test('a written string<\'static> type argument works', () => {
  const result = check(variant('if heads.pick("a", "b") != "a"', 'if heads.pick<string<\'static>>("a", "b") != "a"'))
  assert.equal(result.status, 0, show(result))
})

// Finding 171, fixed by #2416.
test('a written string type argument checks', () => {
  const result = check(variant('if heads.pick("a", "b") != "a"', 'if heads.pick<string>("a", "b") != "a"'))
  assert.equal(result.status, 0, show(result))
  assert.doesNotMatch(result.stderr, /unsupported: this construct/, show(result))
})

test('too many type arguments for an operation says how many it takes', () => {
  const result = check(variant(end, '  if Pick.pick<i32, i32>(&heads, 1, 2) != 1 { return 10 }\n' + end))
  assert.match(result.stderr, /SEM0051\]/, show(result))
  assert.doesNotMatch(result.stderr, /An application with the wrong number of type arguments\n/, show(result))
})
