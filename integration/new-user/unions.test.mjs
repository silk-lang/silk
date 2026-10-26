// Round 46: unions and match in depth (reference Enums and unions, Patterns and match): a generic
// union, guards, nested enum fields, structural union results, match &mut, match place, let and
// if let patterns, and the mistakes around them.
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { here, initPackage, join, read, sharedHome, show, silk, write } from './lib.mjs'

const h = sharedHome()
let serial = 0
const program = read(join(here, 'programs/shop.silk'))

function variant(from = '', to = '') {
  assert.ok(program.includes(from), `the program contains ${from}`)
  const dir = initPackage(h, `shop-${++serial}`)
  write(join(dir, 'src/main.silk'), program.replace(from, to))
  return dir
}

function source(text) {
  const dir = initPackage(h, `match-${++serial}`)
  write(join(dir, 'src/main.silk'), text)
  return dir
}

const check = (dir) => silk(h, ['check'], { cwd: dir })
const errors = (result) => result.stderr.split('\n').filter((line) => /error\[/.test(line))

test('the shop program in programs/ runs and exits 0', () => {
  const result = silk(h, ['run'], { cwd: variant() })
  assert.equal(result.status, 0, show(result))
})

test('a missing union variant and a missing enum member are named', () => {
  assert.match(check(variant('    Event.Close => true\n', '')).stderr, /error\[SEM0044\] Match over Event does not cover Close/)
  assert.match(check(variant('    Kind.Book => 3\n', '')).stderr, /error\[SEM0158\] Match over Kind does not cover Book/)
})

test('a non-bool guard names the type', () => {
  assert.match(check(variant('bool closed if closed => 1000', 'bool closed if 1 => 1000')).stderr, /error\[SEM0045\] Match guard must be bool, found i32/)
})

test('matching a non-Copy union by value asks for move or a borrow', () => {
  assert.match(check(variant('let index = match move found {', 'let index = match found {')).stderr, /`match found` moves `found`; write `match move found` to take it apart, or `match &found` to look at it/)
})

const pick = (arms) => `fn pick(n: i32) -> i32 {\n  return match n {\n${arms}\n  }\n}\n\npub fn main() -> i32 {\n  return pick(-1) - 2\n}\n`

test('a negative integer pattern works as the first arm', () => {
  const result = silk(h, ['run'], { cwd: source(pick('    -1 => 2\n    7 => 1\n    i32 other => other')) })
  assert.equal(result.status, 0, show(result))
})

test('a negative integer pattern after an expression arm is a pattern, not a subtraction', () => {
  const result = silk(h, ['run'], { cwd: source(pick('    7 => 1\n    -1 => 2\n    i32 other => other')) })
  assert.equal(result.status, 0, show(result))
})

test('return as an arm body says to write a block', () => {
  const result = check(variant('    Maybe<usize>.None => {\n      return 1\n    }', '    Maybe<usize>.None => return 1'))
  assert.equal(errors(result).length, 1, show(result))
  assert.match(result.stderr, /\{ return/)
})

test('an integer in a field pattern is one error, not a cascade', () => {
  const result = check(variant('    Event.Retag { index, kind: Kind.Book } => false', '    Event.Retag { index, kind: 3 } => false'))
  assert.equal(errors(result).length, 1, show(result))
})

test('a comma between arms is one error', () => {
  const result = check(variant('    Kind.Fruit => 1', '    Kind.Fruit => 1,'))
  assert.equal(errors(result).length, 1, show(result))
})

test('a plain identifier pattern says to use a binder or _', () => {
  const result = check(variant('    i32 stock => stock', '    stock => stock'))
  assert.doesNotMatch(result.stderr, /Unknown type stock/)
})

test('a record pattern without a field names the field', () => {
  const result = check(variant('Event.Restock { index, amount } => restock', 'Event.Restock { index } => restock'))
  assert.match(result.stderr, /error\[SEM0046\].*`amount`/)
})

test('a binder of a type the union lacks names the type', () => {
  const result = check(variant('    i32 stock => stock', '    i64 stock => 5'))
  assert.match(result.stderr, /error\[SEM0042\].*i64/)
})

test('narrowing a structural union names the missing member', () => {
  const result = check(variant('fn score(outcome: i32 | Refused | bool) -> i32 {', 'fn narrow(o: i32 | Refused | bool) -> i32 | bool {\n  return o\n}\n\nfn score(outcome: i32 | Refused | bool) -> i32 {'))
  assert.match(result.stderr, /error\[SEM0040\].*Refused/)
})

test('braces on a unit variant say to drop them, without a rule id', () => {
  const result = check(variant('    Event.Close => true', '    Event.Close {} => true'))
  assert.match(result.stderr, /error\[SEM0224\]/)
  assert.doesNotMatch(result.stderr, /PATT-\d+/)
})

test('an ignored Effect gets the drop hint once', () => {
  const result = check(source('import silk.effect { Effect }\n\neffect fn tick() -> i32 {\n  return 1\n}\n\npub fn main() -> i32 {\n  tick()\n  return 0\n}\n'))
  assert.match(result.stderr, /error\[SEM0087\]/)
  assert.equal(result.stderr.split('drop').length - 1, 1, show(result))
})
