// Mistakes a newcomer from another language makes in the first hour, and whether the error says
// what to write instead. Each program is checked with `silk check`.
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { initPackage, join, sharedHome, show, silk, write } from './lib.mjs'

const h = sharedHome()
let serial = 0

function check(source) {
  const dir = initPackage(h, `beginner-${++serial}`)
  write(join(dir, 'src/main.silk'), source)
  const result = silk(h, ['check'], { cwd: dir })
  assert.notEqual(result.status, 0, show(result))
  return result
}

const errors = (result) => result.stderr.split('\n').filter((line) => /error\[/.test(line))

// The messages that already say what to write.
for (const [name, source, message] of [
  ['a missing import', 'pub fn main() -> i32 {\n  let xs = List<i32>.make()\n  return 0\n}\n', /Unknown name List; is `import silk\.list \{ List \}` missing\?/],
  ['assigning to a let', 'pub fn main() -> i32 {\n  let x = 1\n  x = 2\n  return x\n}\n', /SEM0035\] Cannot assign through immutable binding x/],
  ['a use after move', 'struct B {\n  v: i32,\n}\n\nfn take(b: B) -> i32 {\n  return b.v\n}\n\npub fn main() -> i32 {\n  let b = B { v: 1 }\n  let a = take(move b)\n  return take(move b) + a\n}\n', /OWN0001\] b was moved and cannot be used again/],
  ['a missing move', 'import silk.list { List }\n\nfn take(b: List<i32>) -> i32 {\n  return 0\n}\n\npub fn main() -> i32 {\n  let b = List<i32>.make()\n  return take(b)\n}\n', /OWN0003\] Moving b requires an explicit move/],
  ['a missing borrow', 'struct P {\n  x: i32,\n}\n\nfn get(p: &P) -> i32 {\n  return p.x\n}\n\npub fn main() -> i32 {\n  let p = P { x: 0 }\n  return get(p)\n}\n', /SEM0012\] Expected &main\.P but received main\.P/],
  ['mixed integer widths', 'pub fn main() -> i32 {\n  let a: i64 = 1\n  let b: i32 = 2\n  return a + b\n}\n', /SEM0135\] Operator \+ does not accept \(i64, i32\)/],
  ['an int condition', 'pub fn main() -> i32 {\n  if 1 {\n    return 0\n  }\n  return 1\n}\n', /SEM0011\] Condition must be bool, found i32/],
  ['a const without a type', 'const limit = 3\n\npub fn main() -> i32 {\n  return limit - 3\n}\n', /a constant requires a type annotation, as in `const NAME: i32 = 5`/],
  ['an effect statement without run', 'import silk.logger { LogError }\n\neffect fn f() -> () ! LogError {\n}\n\npub effect fn main() -> () ! LogError {\n  f()\n}\n', /write `run` before it to run it/],
  ['a reference to a local', 'fn f() -> &i32 {\n  let x = 1\n  return &x\n}\n\npub fn main() -> i32 {\n  return f().* - 1\n}\n', /SEM0210\] The result is a borrow, but the function has no borrowed input/],
]) {
  test(`${name} gets an error that says what to write`, () => {
    const result = check(source)
    assert.match(result.stderr, message, show(result))
  })
}

test('matching a union by value names the binding and offers move or &', { todo: 'finding 115' }, () => {
  const result = check('union U {\n  A,\n  B,\n}\n\npub fn main() -> i32 {\n  let u = U.A\n  return match u {\n    U.A => 0\n    U.B => 1\n  }\n}\n')
  assert.match(result.stderr, /OWN0003\].*\bu\b/, show(result))
  assert.match(result.stderr, /match move u|match &u/, show(result))
})

test('a value effect call without run says to write run', { todo: 'finding 116' }, () => {
  const result = check('effect fn f() -> i32 ! () {\n  return 1\n}\n\npub fn main() -> i32 {\n  let x = f()\n  return x\n}\n')
  assert.match(result.stderr, /run/, show(result))
  assert.doesNotMatch(result.stderr, /An explicit return whose value violates the declaration result/, show(result))
})

test('a struct literal that omits fields names them', { todo: 'finding 117' }, () => {
  const result = check('struct P {\n  x: i32,\n  y: i32,\n  z: i32,\n}\n\npub fn main() -> i32 {\n  let p = P { x: 0 }\n  return p.x\n}\n')
  assert.match(result.stderr, /SEM0024\].*\by\b.*\bz\b/, show(result))
})

// Habits from other languages: one error each, saying what Silk spells instead.
for (const [name, source, hint] of [
  ['x += 1', 'pub fn main() -> i32 {\n  let mut i = 0\n  i += 1\n  return i - 1\n}\n', /i = i \+ 1|compound assignment/],
  ['i++', 'pub fn main() -> i32 {\n  let mut i = 0\n  i++\n  return i - 1\n}\n', /i = i \+ 1/],
  ['for i in 0..10', 'pub fn main() -> i32 {\n  let mut s = 0\n  for i in 0..10 {\n    s = s + i\n  }\n  return s - 45\n}\n', /while/],
  ['var x = 0', 'pub fn main() -> i32 {\n  var x = 0\n  return x\n}\n', /let mut/],
  ['c ? a : b', 'pub fn main() -> i32 {\n  let x = 1\n  return x > 0 ? 0 : 1\n}\n', /if .* else|ternary/],
]) {
  test(`${name} gets one error that names the Silk spelling`, { todo: 'finding 118' }, () => {
    const result = check(source)
    assert.equal(errors(result).length, 1, show(result))
    assert.match(result.stderr, hint, show(result))
  })
}

// The ownership and effects chapters: errors that state the rule but name neither the binding nor
// the fix. Each row: the program, the name the error should mention, and the fix it should offer.
const kept = (p) => `struct P {\n  x: i32,\n}\n\nfn keep<'a>(p: &'a P) -> &'a i32 {\n  return &p.x\n}\n\n${p}`
for (const [code, source, name, fix] of [
  ['SEM0057', 'fn bump(x: &mut i32) -> () {\n  x.* = x.* + 1\n}\n\npub fn main() -> i32 {\n  let n = 0\n  bump(&mut n)\n  return n\n}\n', /\bn\b/, /let mut n/],
  ['SEM0058', 'fn bump(x: &mut i32) -> () {\n  x.* = x.* + 1\n}\n\nfn f(x: &i32) -> () {\n  bump(&mut x.*)\n}\n\npub fn main() -> i32 {\n  let n = 0\n  f(&n)\n  return n\n}\n', /\bx\b/, /&mut i32/],
  ['OWN0010', kept('fn bump(p: &mut P) -> () {\n  p.x = p.x + 1\n}\n\npub fn main() -> i32 {\n  let mut p = P { x: 0 }\n  let r = keep(&p)\n  bump(&mut p)\n  return r.*\n}\n'), /\bp\b/, /\br\b/],
  ['OWN0011', kept('pub fn main() -> i32 {\n  let mut p = P { x: 0 }\n  let r = keep(&p)\n  p = P { x: 1 }\n  return r.*\n}\n'), /\bp\b/, /\br\b/],
  ['OWN0019', 'pub fn main() -> i32 {\n  let mut r: &i32 = &0\n  if true {\n    let x = 5\n    r = &x\n  }\n  return r.*\n}\n', /\bx\b/, /\br\b/],
  ['SEM0063', 'struct E {\n  m: i32,\n}\n\nfn f() -> i32 {\n  fail E { m: 1 }\n}\n\npub fn main() -> i32 {\n  return 0\n}\n', /\bf\b/, /effect fn|! E/],
  ['SEM0066', 'struct E {\n  m: i32,\n}\n\neffect fn f() -> () ! E {\n  fail E { m: 1 }\n}\n\npub effect fn main() -> () {\n  run f()\n}\n', /\bE\b/, /! E|Effect\.result/],
  ['SEM0071', 'import silk.effect { Effect }\nimport silk.logger { LogError, Logger }\n\neffect fn say() -> () ! LogError ? &mut Logger {\n  run Effect.log("hi\\n", &.{})\n}\n\npub effect fn main() -> () ! LogError {\n  run say()\n}\n', /Logger/, /provideMut|\? &mut Logger/],
  ['SEM0077', 'pub fn main() -> i32 {\n  let mut n = 0\n  let f = fn() -> () {\n    n = n + 1\n  }\n  f()\n  return n - 1\n}\n', /\bf\b/, /let mut f/],
]) {
  test(`${code} names the binding and the fix`, { todo: 'finding 119' }, () => {
    const result = check(source)
    const line = errors(result).find((l) => l.includes(`[${code}]`)) ?? ''
    assert.ok(line !== '', `no ${code}\n${show(result)}`)
    const message = line.replace(/^.*?\] /, '')
    assert.match(message, name, show(result))
    assert.match(result.stderr, fix, show(result))
  })
}

test('main returning a string is told what main may return', { todo: 'finding 120' }, () => {
  const result = check('pub fn main() -> string {\n  return "x"\n}\n')
  assert.match(result.stderr, /SEM0225\]/, show(result))
})
