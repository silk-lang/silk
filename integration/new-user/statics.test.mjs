// Round 47: work at compile time (book chapter 11, reference Static evaluation and Static control
// flow and reflection): static fn, constants, let static, static text, static parameters with
// static if recursion, static for over Reflect.fields, target queries and compileError.
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { here, initPackage, join, read, sharedHome, show, silk, write } from './lib.mjs'

const h = sharedHome()
let serial = 0
const program = read(join(here, 'programs/statics.silk'))

function variant(from = '', to = '') {
  assert.ok(program.includes(from), `the program contains ${from}`)
  const dir = initPackage(h, `statics-${++serial}`)
  write(join(dir, 'src/main.silk'), program.replace(from, to))
  return dir
}

const check = (dir) => silk(h, ['check'], { cwd: dir })

test('the statics program in programs/ runs and exits 0', () => {
  const result = silk(h, ['run'], { cwd: variant() })
  assert.equal(result.status, 0, show(result))
})

test('a compileError reached through a static argument points at the call', () => {
  const result = check(variant('let static size = checkedSize(SIZE)', 'let static size = checkedSize(0)'))
  assert.match(result.stderr, /error\[SEM0177\] size must be positive\n  note: src\/main\.silk:\d+:\d+: related location/)
})

test('a runtime value for a static parameter names the value', () => {
  const result = check(variant('if power(10, 2) != 1024', 'let e: u32 = 3\n  if power(e, 2) != 1024'))
  assert.match(result.stderr, /error\[SEM0176\] reading the runtime value `e` is not available during static evaluation/)
})

test('a constant without a type shows the form', () => {
  const result = check(variant('const SIZE: usize = 4', 'const SIZE = 4'))
  assert.match(result.stderr, /error\[SEM0086\] Invalid constant: a constant requires a type annotation, as in `const NAME: i32 = 5`/)
})

test('a static loop that never ends stops at the step budget', () => {
  const result = check(variant('const FIB_20: u64 = fib(20)', 'static fn spin() -> u64 {\n  let mut i: u64 = 0\n  while true {\n    i = i + 0\n  }\n  return i\n}\n\nconst FIB_20: u64 = fib(20) + spin()'))
  assert.match(result.stderr, /error\[SEM0179\]/)
})

test('Reflect.fields lists only pub fields in the declaring module too', { todo: 'finding 155' }, () => {
  const dir = initPackage(h, `statics-${++serial}`)
  write(join(dir, 'src/main.silk'), 'import silk.reflect { Reflect }\n\npub struct Stats {\n  pub hits: i32,\n  secret: i32,\n}\n\nfn countFields() -> i32 {\n  let mut count = 0\n  static for field in Reflect.fields<Stats>() {\n    count = count + 1\n  }\n  return count\n}\n\npub fn main() -> i32 {\n  return countFields()\n}\n')
  const result = silk(h, ['run'], { cwd: dir })
  assert.equal(result.status, 1, show(result))
})

const crossing = /Crossing from static evaluation into unavailable runtime work/

test('integer overflow during static evaluation says overflow', { todo: 'finding 156' }, () => {
  const result = check(variant('const FIB_20: u64 = fib(20)', 'const FIB_20: u64 = fib(200)'))
  assert.match(result.stderr, /error\[SEM0176\]/)
  assert.doesNotMatch(result.stderr, crossing)
  assert.match(result.stderr, /overflow/)
})

test('division by zero during static evaluation says so', { todo: 'finding 156' }, () => {
  const result = check(variant('const FIB_20: u64 = fib(20)', 'const FIB_20: u64 = fib(20) / (fib(0))'))
  assert.match(result.stderr, /zero/)
})

test('calling an ordinary fn from a static fn names the function', { todo: 'finding 156' }, () => {
  const result = check(variant('const FIB_20: u64 = fib(20)', 'fn plain(n: u64) -> u64 {\n  return n\n}\n\nstatic fn wrap() -> u64 {\n  return plain(6765)\n}\n\nconst FIB_20: u64 = wrap()'))
  assert.match(result.stderr, /`plain`/)
})

test('Reflect.fields in a runtime binding names no internal target placeholder', { todo: 'finding 156' }, () => {
  const result = check(variant('    total = total + Reflect.borrowField(stats, field).*', '    total = total + Reflect.borrowField(stats, field).* + 1\n    let f = Reflect.fields<Stats>()'))
  assert.match(result.stderr, /error\[SEM0176\]/)
  assert.doesNotMatch(result.stderr, /unselected-target/)
})

test('a constant cycle names the constants once', { todo: 'finding 157' }, () => {
  const result = check(variant('const GREETING: string = "hello"', 'const GREETING: string = "hello"\nconst A: i32 = B\nconst B: i32 = A'))
  assert.equal(result.stderr.split('error[SEM0223]').length - 1, 1, show(result))
  assert.match(result.stderr, /`A`/)
})
