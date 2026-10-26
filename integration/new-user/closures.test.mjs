// Round 45: closures and callable types (reference Closures and callable types): returned
// closures, staged calls, a generic struct holding a callable, bound methods in all three modes,
// mut fn and once fn parameters, and the mistakes around them.
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { here, initPackage, join, read, sharedHome, show, silk, write } from './lib.mjs'

const h = sharedHome()
let serial = 0
const program = read(join(here, 'programs/closures.silk'))

// A package whose main.silk is the closures program with one replacement applied.
function variant(from = '', to = '') {
  assert.ok(program.includes(from), `the program contains ${from}`)
  const dir = initPackage(h, `closures-${++serial}`)
  write(join(dir, 'src/main.silk'), program.replace(from, to))
  return dir
}

const check = (dir) => silk(h, ['check'], { cwd: dir })

test('the closures program in programs/ runs and exits 0', () => {
  const result = silk(h, ['run'], { cwd: variant() })
  assert.equal(result.status, 0, show(result))
})

test('calling a once fn parameter twice is OWN0001', () => {
  const result = check(variant('fn callOnce(f: once fn() -> i32) -> i32 {\n  return f()', 'fn callOnce(f: once fn() -> i32) -> i32 {\n  let a = f()\n  return f()'))
  assert.match(result.stderr, /error\[OWN0001\] f was moved and cannot be used again/)
})

test('a once fn for a mut fn parameter names both modes', () => {
  const result = check(variant('if callOnce(move finish) != 50 {', 'if callMut(move finish) != 50 {'))
  assert.match(result.stderr, /error\[SEM0076\] Callable value with mode `once` cannot satisfy a parameter with mode `mut`/)
})

test('a mutating bound method in a plain let says to declare it let mut', () => {
  const result = check(variant('let mut bump = counter.bump', 'let bump = counter.bump'))
  assert.match(result.stderr, /error\[SEM0077\] `bump` changes what it captures, so calling it needs a mutable binding; declare it `let mut bump`/)
})

test('writing a field while a shared bound method is live is OWN0011', () => {
  const result = check(variant('let peek = counter.peek', 'let peek = counter.peek\n  counter.count = 9'))
  assert.match(result.stderr, /error\[OWN0011\] Assigning `counter\.count` while a borrow of it is still in use/)
})

test('passing a once bound method without move asks for move', () => {
  const result = check(variant('if callOnce(move finish) != 50 {', 'if callOnce(finish) != 50 {'))
  assert.match(result.stderr, /error\[OWN0003\] Moving finish requires an explicit move/)
})

const borrowingAdder = 'fn adder(n: i32) -> fn<\'static>(i32) -> i32 {\n  let base = Counter { count: n }\n  return fn(x: i32) -> i32 {\n    return x + base.peek()\n  }\n}'
const adder = 'fn adder(n: i32) -> fn<\'static>(i32) -> i32 {\n  return fn(x: i32) -> i32 {\n    return x + n\n  }\n}'

test('returning a closure that borrows a local names the local', () => {
  const result = check(variant(adder, borrowingAdder))
  assert.match(result.stderr, /error\[OWN0018\]/)
  assert.match(result.stderr, /`base`/)
})

test('a callable result without a lifetime suggests fn<\'static>', () => {
  const result = check(variant("fn adder(n: i32) -> fn<'static>(i32) -> i32 {", 'fn adder(n: i32) -> fn(i32) -> i32 {'))
  assert.match(result.stderr, /error\[SEM0210\]/)
  assert.match(result.stderr, /fn<'static>/)
})

test('a use after a consuming bound method names the binding', () => {
  const result = check(variant('let finish = counter.finish', 'let finish = counter.finish\n  let after = counter.peek()'))
  assert.match(result.stderr, /error\[OWN0001\] counter was moved/)
})

test('assigning a different function to a callable binding says each function has its own type', () => {
  const result = check(variant('let finish = counter.finish', 'let mut finish = counter.finish\n  finish = counter.peek'))
  assert.match(result.stderr, /error\[SEM0037\]/)
  assert.doesNotMatch(result.stderr, /An assigned value whose type mismatches its place/)
})

test('an ignored call result hints drop', () => {
  const result = check(variant('drop bump(2)', 'bump(2)'))
  assert.match(result.stderr, /error\[SEM0087\].*`drop/)
})
