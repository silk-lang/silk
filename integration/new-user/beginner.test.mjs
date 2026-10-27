// Mistakes a newcomer from another language makes in the first hour, and whether the error says
// what to write instead. Each program is checked with `silk check`.
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { initPackage, join, read, sharedHome, show, silk, write } from './lib.mjs'

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

test('matching a union by value names the binding and offers move or &', () => {
  const result = check('union U {\n  A,\n  B,\n}\n\npub fn main() -> i32 {\n  let u = U.A\n  return match u {\n    U.A => 0\n    U.B => 1\n  }\n}\n')
  assert.match(result.stderr, /OWN0003\].*\bu\b/, show(result))
  assert.match(result.stderr, /match move u|match &u/, show(result))
})

test('a value effect call without run says to write run', () => {
  const result = check('effect fn f() -> i32 ! () {\n  return 1\n}\n\npub fn main() -> i32 {\n  let x = f()\n  return x\n}\n')
  assert.match(result.stderr, /run/, show(result))
  assert.doesNotMatch(result.stderr, /An explicit return whose value violates the declaration result/, show(result))
})

test('a struct literal that omits fields names them', () => {
  const result = check('struct P {\n  x: i32,\n  y: i32,\n  z: i32,\n}\n\npub fn main() -> i32 {\n  let p = P { x: 0 }\n  return p.x\n}\n')
  assert.match(result.stderr, /SEM0024\].*\by\b.*\bz\b/, show(result))
})

// Habits from other languages: one error each, saying what Silk spells instead.
for (const [name, source, hint] of [
  ['x += 1', 'pub fn main() -> i32 {\n  let mut i = 0\n  i += 1\n  return i - 1\n}\n', /i = i \+ 1|compound assignment/],
  ['i++', 'pub fn main() -> i32 {\n  let mut i = 0\n  i++\n  return i - 1\n}\n', /[xi] = [xi] \+ 1/],
  ['for i in 0..10', 'pub fn main() -> i32 {\n  let mut s = 0\n  for i in 0..10 {\n    s = s + i\n  }\n  return s - 45\n}\n', /while/],
  ['var x = 0', 'pub fn main() -> i32 {\n  var x = 0\n  return x\n}\n', /let mut/],
  ['c ? a : b', 'pub fn main() -> i32 {\n  let x = 1\n  return x > 0 ? 0 : 1\n}\n', /no `c \? a : b`/],
]) {
  test(`${name} gets one error that names the Silk spelling`, () => {
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
  ['SEM0058', 'fn bump(x: &mut i32) -> () {\n  x.* = x.* + 1\n}\n\nfn f(x: &i32) -> () {\n  bump(&mut x.*)\n}\n\npub fn main() -> i32 {\n  let n = 0\n  f(&n)\n  return n\n}\n', /`x`/, /take a `&mut` reference/],
  ['OWN0010', kept('fn bump(p: &mut P) -> () {\n  p.x = p.x + 1\n}\n\npub fn main() -> i32 {\n  let mut p = P { x: 0 }\n  let r = keep(&p)\n  bump(&mut p)\n  return r.*\n}\n'), /`p`/, /the earlier borrow starts here/],
  ['OWN0011', kept('pub fn main() -> i32 {\n  let mut p = P { x: 0 }\n  let r = keep(&p)\n  p = P { x: 1 }\n  return r.*\n}\n'), /`p`/, /the borrow starts here/],
  ['OWN0019', 'pub fn main() -> i32 {\n  let y = 0\n  let mut r: &i32 = &y\n  if true {\n    let x = 5\n    r = &x\n  }\n  return r.*\n}\n', /`r` is used after `x`/, /the borrow starts here/],
  ['SEM0063', 'struct E {\n  m: i32,\n}\n\nfn f() -> i32 {\n  fail E { m: 1 }\n}\n\npub fn main() -> i32 {\n  return 0\n}\n', /\bf\b/, /effect fn|! E/],
  ['SEM0066', 'struct E {\n  m: i32,\n}\n\neffect fn f() -> () ! E {\n  fail E { m: 1 }\n}\n\npub effect fn main() -> () {\n  run f()\n}\n', /\bE\b/, /! E|Effect\.result/],
  ['SEM0071', 'import silk.effect { Effect }\nimport silk.logger { LogError, Logger }\n\neffect fn say() -> () ! LogError ? &mut Logger {\n  run Effect.log("hi\\n", &.{})\n}\n\npub effect fn main() -> () ! LogError {\n  run say()\n}\n', /Logger/, /provideMut|\? &mut Logger/],
  ['SEM0077', 'pub fn main() -> i32 {\n  let mut n = 0\n  let f = fn() -> () {\n    n = n + 1\n  }\n  f()\n  return n - 1\n}\n', /\bf\b/, /let mut f/],
]) {
  test(`${code} names the binding and the fix`, () => {
    const result = check(source)
    const line = errors(result).find((l) => l.includes(`[${code}]`)) ?? ''
    assert.ok(line !== '', `no ${code}\n${show(result)}`)
    const message = line.replace(/^.*?\] /, '')
    assert.match(message, name, show(result))
    assert.match(result.stderr, fix, show(result))
  })
}

test('main returning a string is told what main may return', () => {
  const result = check('pub fn main() -> string {\n  return "x"\n}\n')
  assert.match(result.stderr, /SEM0225\]/, show(result))
})

// Book chapters 9 to 13: fibers, modules and packages. Errors that still state the rule without
// naming the thing or the fix. Each row: files beside src/main.silk, the program, and a pattern the
// error should match.
const fiberImports = 'import silk.effect { Effect }\nimport silk.fiber { Fiber }\nimport silk.logger { Logger, LogError }\nimport silk.monotonic_clock { MonotonicClock }\nimport silk.allocator { OutOfMemoryError }\nimport silk.scheduler { Scheduler, TaskIdExhaustedError }\nimport silk.string { String }\n\n'
const root = (body) => `effect fn root<'text>(title: string<'text>) -> () ! OutOfMemoryError | TaskIdExhaustedError ? &mut Scheduler | &mut MonotonicClock {\n  ${body}\n  drop fiber\n}\n\npub fn main() -> i32 {\n  return 0\n}\n`
for (const [code, files, source, want] of [
  ['SEM0076', {}, `${fiberImports}effect fn shout() -> () ! LogError ? &mut Logger {\n  run Effect.log("reminder!\\n", &())\n}\n\n${root('let fiber = run Fiber<(), LogError>.forkChild(shout())')}`, /Logger.*(Scheduler|MonotonicClock)|(Scheduler|MonotonicClock).*Logger/],
  ['SEM0212', {}, `${fiberImports}effect fn measure(title: string) -> usize ? &mut Scheduler | &mut MonotonicClock {\n  return String.byteLength(title)\n}\n\n${root('let fiber = run Fiber<usize, never>.forkChild(measure(title))')}`, /'static|'text|title/],
  ['SEM0015', { 'src/geo/shapes.silk': 'fn secret() -> i32 {\n  return 0\n}\n' }, 'import geo.shapes { secret }\n\npub fn main() -> i32 {\n  return secret()\n}\n', /`secret`.*pub|pub.*`secret`/],
  ['SEM0016', { 'src/geo/shapes.silk': 'pub fn shapes() -> i32 {\n  return 0\n}\n' }, 'import geo.shapes\nimport geo.shapes { shapes }\n\npub fn main() -> i32 {\n  return shapes()\n}\n', /\bas\b/],
  ['SEM0028', { 'src/geo/shapes.silk': 'pub struct P {\n  x: i32,\n}\n\npub fn make() -> P {\n  return P { x: 0 }\n}\n' }, 'import geo.shapes { P, make }\n\npub fn main() -> i32 {\n  let p = make()\n  return p.x\n}\n', /`x`|field x/],
  ['SEM0001', {}, 'fn dup<C: Copy>(c: C) -> C {\n  return c\n}\n\npub fn main() -> i32 {\n  return dup(1)\n}\n', /import silk\.ownership \{ Copy \}/],
  ['MOD0001', { 'src/geo/shapes.silk': 'pub fn f() -> i32 {\n  return 0\n}\n' }, 'import geo.shape { f }\n\npub fn main() -> i32 {\n  return f()\n}\n', /geo\.shapes/],
]) {
  test(`${code} from the later chapters names the thing and the fix`, () => {
    const dir = initPackage(h, `beginner-${++serial}`)
    for (const [path, text] of Object.entries(files)) write(join(dir, path), text)
    write(join(dir, 'src/main.silk'), source)
    const result = silk(h, ['check'], { cwd: dir })
    const line = errors(result).find((l) => l.includes(`[${code}]`)) ?? ''
    assert.ok(line !== '', `no ${code}\n${show(result)}`)
    assert.match(result.stderr, want, show(result))
  })
}

// Runtime traps a beginner hits. The language's own traps name the reason and the user's line.
function run(source) {
  const dir = initPackage(h, `beginner-${++serial}`)
  write(join(dir, 'src/main.silk'), source)
  return silk(h, ['run', '--quiet'], { cwd: dir })
}

for (const [name, source, reason, at] of [
  ['an index out of range', 'fn at(i: usize) -> i32 {\n  let a = [1, 2, 3]\n  return a[i]\n}\n\npub fn main() -> i32 {\n  return at(5)\n}\n', 'index out of bounds', 'main.at (main:3:10)'],
  ['an i32 overflow', 'fn add(a: i32, b: i32) -> i32 {\n  return a + b\n}\n\npub fn main() -> i32 {\n  return add(2147483647, 1)\n}\n', 'arithmetic overflow', 'main.add (main:2:10)'],
  ['a u8 underflow', 'fn sub(a: u8, b: u8) -> u8 {\n  return a - b\n}\n\npub fn main() -> i32 {\n  let x = sub(1, 2)\n  return 0\n}\n', 'arithmetic overflow', 'main.sub (main:2:10)'],
  ['a division by zero', 'fn div(a: i32, b: i32) -> i32 {\n  return a / b\n}\n\npub fn main() -> i32 {\n  return div(1, 0)\n}\n', 'division by zero', 'main.div (main:2:10)'],
  ['a remainder by zero', 'fn m(a: i32, b: i32) -> i32 {\n  return a % b\n}\n\npub fn main() -> i32 {\n  return m(1, 0)\n}\n', 'division by zero', 'main.m (main:2:10)'],
  ['MIN / -1', 'fn div(a: i32, b: i32) -> i32 {\n  return a / b\n}\n\npub fn main() -> i32 {\n  return div(-2147483647 - 1, -1)\n}\n', 'arithmetic overflow', 'main.div (main:2:10)'],
]) {
  test(`${name} traps with its reason and line`, () => {
    const result = run(source)
    assert.notEqual(result.status, 0, show(result))
    assert.ok(result.stderr.includes(`fatal trap: ${reason}\n  at ${at}`), show(result))
  })
}

test('unbounded recursion reports a stack overflow', () => {
  const result = run('fn r(n: i64) -> i64 {\n  return r(n + 1) + 1\n}\n\npub fn main() -> i32 {\n  let x = r(0)\n  return 0\n}\n')
  assert.match(result.stderr, /fatal trap: stack overflow/, show(result))
})

// Like List.get since #2278: the stdlib function names the reason, and the frame is the caller's.
for (const [name, source, reason] of [
  ['i32.toUsize(-1)', 'import silk.i32\n\nfn conv(x: i32) -> usize {\n  return i32.toUsize(x)\n}\n\npub fn main() -> i32 {\n  let y = conv(-1)\n  return 0\n}\n', /i32\.toUsize: .*negative|i32\.toUsize: .*fit/],
  ['u32.toU8(300)', 'import silk.u32\n\nfn conv(x: u32) -> u8 {\n  return u32.toU8(x)\n}\n\npub fn main() -> i32 {\n  let y = conv(300)\n  return 0\n}\n', /u32\.toU8: the value is outside the u8 range/],
  ['String.slice past the end', 'import silk.string { String }\n\nfn cut(s: string) -> string {\n  return String.slice(s, 2, 10)\n}\n\npub fn main() -> i32 {\n  let t = cut("abc")\n  return 0\n}\n', /String\.slice: /],
]) {
  test(`${name} traps with the stdlib reason at the caller's line`, () => {
    const result = run(source)
    assert.match(result.stderr, reason, show(result))
    assert.match(result.stderr, /at main\.(conv|cut) \(main:4:/, show(result))
  })
}

for (const [name, body, code] of [
  ['a constant division by zero', 'return 1 / 0', 'SEM0248'],
  ['a constant remainder by zero', 'return 1 % 0', 'SEM0248'],
  ['a constant overflow', 'let x: i32 = 2147483647 + 1\n  return x', 'SEM0247'],
]) {
  test(`${name} is refused by silk check`, () => {
    const result = check(`pub fn main() -> i32 {\n  ${body}\n}\n`)
    assert.match(result.stderr, new RegExp(`error\\[${code}\\]`), show(result))
  })
}

test('an out-of-range literal names the value and the range', () => {
  const result = check('pub fn main() -> i32 {\n  let x: u8 = 300\n  return 0\n}\n')
  assert.match(result.stderr, /SEM0002\].*300.*(255|u8)/, show(result))
})

// Hand edits to silk.toml. `body` replaces everything above the silk-version line that `silk init` wrote.
function manifest(body) {
  const dir = initPackage(h, `beginner-${++serial}`)
  const pin = read(join(dir, 'silk.toml')).split('\n').find((l) => l.startsWith('silk-version')) ?? ''
  write(join(dir, 'silk.toml'), body.replace('version = "0.1.0"\n', `version = "0.1.0"\n${pin}\n`))
  const result = silk(h, ['check'], { cwd: dir })
  assert.notEqual(result.status, 0, show(result))
  return result
}

test('an unknown field in silk.toml is reported at its line', () => {
  const result = manifest('[package]\nnmae = "p"\nversion = "0.1.0"\n')
  assert.match(result.stderr, /silk\.toml:2: package\.nmae is not a supported field/, show(result))
})

test('a dependency written as a version string says to write a table', () => {
  const result = manifest('[package]\nname = "p"\nversion = "0.1.0"\n\n[dependencies]\nfoo = "1.0"\n')
  assert.match(result.stderr, /a dependency must be a table such as \{ path = "\.\.\/library" \}/, show(result))
})

for (const [name, body, line, reason] of [
  ['an unquoted string', '[package]\nname = p\nversion = "0.1.0"\n', 2, /quote|string|value/i],
  ['an unclosed table header', '[package\nname = "p"\nversion = "0.1.0"\n', 1, /\]|table header/],
  ['a duplicate key', '[package]\nname = "p"\nversion = "0.1.0"\nname = "q"\n', 5, /name|duplicate|twice|again/i],
]) {
  test(`${name} in silk.toml gets the TOML line and reason`, () => {
    const result = manifest(body)
    assert.match(result.stderr, new RegExp(`silk\\.toml:${line}(:\\d+)?: `), show(result))
    assert.match(result.stderr.split('\n').find((l) => l.includes('silk.toml')) ?? '', reason, show(result))
  })
}

for (const [name, body, line, value] of [
  ['a version that is not semver', '[package]\nname = "p"\nversion = "1.0"\n', 3, /1\.0/],
  ['an uppercase name', '[package]\nname = "MyApp"\nversion = "0.1.0"\n', 2, /MyApp/],
  ['kind = "lib"', '[package]\nname = "p"\nversion = "0.1.0"\nkind = "lib"\n', 5, /"lib"/],
]) {
  test(`${name} is reported at its line with the value`, () => {
    const result = manifest(body)
    assert.match(result.stderr, new RegExp(`silk\\.toml:${line}: `), show(result))
    assert.match(result.stderr, value, show(result))
  })
}

test('a missing package name says it is missing', () => {
  const result = manifest('[package]\nversion = "0.1.0"\n')
  assert.match(result.stderr, /package\.name is missing|missing package\.name|needs a name/, show(result))
})

// A first test, written from the Testing page.
const testing = 'import silk.testing { AssertionError, Testing }\n\n'
test('a run inside a plain test fn says to make it an effect fn', () => {
  const result = check(`${testing}test fn adds() {\n  run Testing.expect(1 + 1 == 2, "1 + 1 is 2")\n}\n`)
  assert.match(result.stderr, /effect fn/, show(result))
})

test('a failure row on a plain fn says to make it an effect fn', () => {
  const result = check(`${testing}test fn adds() -> () ! AssertionError<'static> {\n  run Testing.expect(true, "x")\n}\n`)
  assert.match(result.stderr, /SEM0062\].*effect fn/, show(result))
})

for (const [name, source, reason] of [
  ['a parameter', 'test fn withParam(x: i32) {\n}\n', /param/i],
  ['a bool result', 'test fn adds() -> bool {\n  return true\n}\n', /\(\)|bool/],
  ['a type parameter', 'test fn g<T>() {\n}\n', /type parameter|generic/i],
]) {
  test(`a test fn with ${name} says what a test may not have`, () => {
    const result = check(source)
    const line = errors(result).find((l) => l.includes('[SEM0218]')) ?? ''
    assert.ok(line !== '', show(result))
    assert.match(line.replace(/^.*?\] /, ''), reason, show(result))
  })
}

test('a failing first test names its message and line', () => {
  const dir = initPackage(h, `beginner-${++serial}`)
  write(join(dir, 'src/main.silk'), `${testing}fn add(a: i32, b: i32) -> i32 {\n  return a + b\n}\n\ntest effect fn adds() ! AssertionError<'static> {\n  run Testing.expect(add(2, 2) == 5, "2 + 2 is 5")\n}\n\npub fn main() -> i32 {\n  return 0\n}\n`)
  const result = silk(h, ['test'], { cwd: dir })
  assert.equal(result.status, 1, show(result))
  assert.match(result.stdout + result.stderr, /main::adds\n\s+assertion failed: 2 \+ 2 is 5\n\s+at main\.adds \(main:8:3\)\n\s+FAIL/, show(result))
})

// Finding 133: SEM0010 falls back to the code's description for some receivers.
for (const [name, source] of [
  ['a tuple', 'pub fn main() -> i32 {\n  let t = (1, 2)\n  return t.frob()\n}\n'],
  ['a StdoutLogger value', 'import silk.os_logger { StdoutLogger }\n\npub fn main() -> i32 {\n  let l = StdoutLogger.make()\n  l.info("x")\n  return 0\n}\n'],
  ['the StdoutLogger type', 'import silk.os_logger { StdoutLogger }\n\npub fn main() -> i32 {\n  let l = StdoutLogger.frob()\n  return 0\n}\n'],
]) {
  test(`an unknown method on ${name} names the type and the method`, () => {
    const result = check(source)
    assert.match(result.stderr, /SEM0010\][^\n]*`(frob|info)`/, show(result))
  })
}

// Finding 136: `==` on two values of a type whose Equal works on references.
test('== on two values of an Equal type says to compare borrows', () => {
  const result = check('import silk.equal { Equal }\n\nstruct Id {\n  n: i32,\n}\n\nfn same(l: &Id, r: &Id) -> bool {\n  return l.n == r.n\n}\n\nimpl Equal for Id { equals: same }\n\npub fn main() -> i32 {\n  let a = Id { n: 1 }\n  let b = Id { n: 1 }\n  if a == b {\n    return 0\n  }\n  return 1\n}\n')
  assert.match(result.stderr, /SEM0135\]/, show(result))
  assert.match(result.stderr, /&a == &b|borrow|reference/, show(result))
})

// Finding 137: importing a name that the module only imports itself.
test('importing a name another module only imports says where it is declared', () => {
  const result = check('import silk.i64 { ParseError }\n\npub fn main() -> i32 {\n  return 0\n}\n')
  assert.match(result.stderr, /SEM0015\]/, show(result))
  assert.match(result.stderr, /silk\.format/, show(result))
  assert.doesNotMatch(result.stderr, /mark it `pub` there/, show(result))
})

// Finding 138: a template value that has Debug but not Display.
test('a template value with Debug but no Display suggests {:?}', () => {
  const result = check('import silk.effect { Effect }\nimport silk.logger { LogError }\nimport silk.option { Option }\nimport silk.os_logger { StdoutLogger }\n\npub effect fn main() -> () ! LogError {\n  let mut logger = StdoutLogger.make()\n  let o: Option<i32> = Option.some(1)\n  run Effect.log("{o}\\n", &.{ o: move o }) |> Effect.provideMut(&mut logger)\n}\n')
  assert.match(result.stderr, /SEM0121\]/, show(result))
  assert.match(result.stderr, /\{o:\?\}|:\?/, show(result))
})

// Finding 139: SEM0135 on fields read through references loses the operator and types.
test('< on two string fields read through references names the operator and types', () => {
  const result = check("struct W<'t> { text: string<'t> }\n\nfn f(l: &W, r: &W) -> bool {\n  return l.text < r.text\n}\n\npub fn main() -> i32 {\n  return 0\n}\n")
  assert.match(result.stderr, /SEM0135\] Operator < does not accept/, show(result))
})

// Finding 140: a block arm that ends in a bare value.
// Since #2354 a block arm of a match used as a value yields its last expression.
test('a block arm ending in a value yields it when the match is a value', () => {
  const dir = initPackage(h, `beginner-${++serial}`)
  write(join(dir, 'src/main.silk'), 'pub fn main() -> i32 {\n  let n = 1\n  let v = match n {\n    1 => {\n      0\n    }\n    _ => 2\n  }\n  return v\n}\n')
  const result = silk(h, ['check'], { cwd: dir })
  assert.equal(result.status, 0, show(result))
})

test('a statement match whose block arm ends in a value says the match is a statement', () => {
  const result = check('pub fn main() -> i32 {\n  let n = 1\n  match n {\n    1 => {\n      7\n    }\n    _ => {}\n  }\n  return 0\n}\n')
  assert.match(result.stderr, /SEM0087\] This match is a statement, so the last value of its arm block is ignored/, show(result))
})

// Finding 141: a private stdlib field whose accessor lives elsewhere.
test('reading Instant.seconds as a method points at SystemClock.seconds, not at editing the stdlib', () => {
  const result = check('import silk.system_clock { Instant, SystemClock }\n\npub fn main() -> i32 {\n  let now = SystemClock.make(5, 0)\n  if now.seconds() == 5 {\n    return 0\n  }\n  return 1\n}\n')
  assert.match(result.stderr, /SEM0028\]/, show(result))
  assert.doesNotMatch(result.stderr, /mark it `pub seconds`/, show(result))
  assert.match(result.stderr, /SystemClock\.seconds/, show(result))
})

// Finding 142: provider messages.
const bell = 'import silk.effect { Effect }\nimport silk.system_clock { SystemClock }\nimport silk.testing { AssertionError, Testing }\n\nservice Doorbell {\n  effect fn ring() -> () ? &mut Doorbell\n}\n\nstruct Counting {\n  rings: i32,\n}\n\nimpl Doorbell for Counting {\n  effect fn ring(self: &mut Self) -> () {\n    self.rings = self.rings + 1\n  }\n}\n\neffect fn visit() -> () ? &mut Doorbell {\n  run Doorbell.ring()\n}\n\npub fn main() -> i32 {\n  return 0\n}\n\n'
test('providing a value for the wrong service names the provider and the service', () => {
  const result = check(`${bell}test effect fn rings() ! AssertionError<'static> {\n  let mut b = Counting { rings: 0 }\n  run visit() |> Effect.provideMut<SystemClock>(&mut b)\n  run Testing.expect(b.rings == 1, "one ring")\n}\n`)
  assert.match(result.stderr, /SEM0123\][^\n]*(Counting|SystemClock)/, show(result))
})
test('a missing provider inside a test does not suggest a requirement row', () => {
  const result = check(`${bell}test effect fn rings() ! AssertionError<'static> {\n  run visit()\n  run Testing.expect(true, "ran")\n}\n`)
  assert.match(result.stderr, /SEM0071\]/, show(result))
  assert.doesNotMatch(result.stderr, /add `\? &mut Doorbell` to its signature/, show(result))
})
