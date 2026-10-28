// Mistakes a newcomer makes in a first program, and the error each one should get: a stable
// code at the right place, and a message that names what is wrong.
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { initPackage, join, sharedHome, show, silk, write } from './lib.mjs'

const h = sharedHome()
const dir = initPackage(h, 'mistakes')
const logging = `import silk.core.effect { Effect }
import silk.io.logger { LogError }
import silk.io.logger_native { StdoutLogger }
pub effect fn main() -> () ! LogError {
  let mut logger = StdoutLogger.make()
`

function check(source) {
  write(join(dir, 'src/main.silk'), source)
  const result = silk(h, ['check', '--quiet'], { cwd: dir })
  const errors = result.stderr.split('\n').filter((line) => /error\[/.test(line))
  return { ...result, errors }
}

// [what the newcomer did, program, the first error line it must print]
const cases = [
  ['forgot the return', 'pub fn main() -> i32 {\n  let x = 1\n}\n', /^src\/main\.silk:3:1: error\[SEM0130\] A reachable path must return i32$/],
  ['called println', 'pub fn main() {\n  println("hi")\n}\n', /error\[SEM0004\] Unknown function println$/],
  ['imported a module that does not exist', 'import silk.io { print }\npub fn main() {}\n', /error\[MOD0001\] Unknown module silk\.io$/],
  ['put a string in an i32', 'pub fn main() -> i32 {\n  let x: i32 = "hello"\n  return x\n}\n', /2:16: error\[SEM0037\] Assignment expected i32 but received string<'static>$/],
  ['assigned to a let', 'pub fn main() -> i32 {\n  let x = 1\n  x = 2\n  return x\n}\n', /3:3: error\[SEM0035\] Cannot assign through immutable binding x$/],
  ['passed too many arguments', 'fn f(a: i32) -> i32 { return a }\npub fn main() -> i32 {\n  return f(1, 2)\n}\n', /error\[SEM0007\] Expected 1 argument but received 2$/],
  ['ended lines with semicolons', 'pub fn main() -> i32 {\n  let x = 1;\n  return x\n}\n', /2:12: error\[PAR0002\] Unexpected `;`/],
  ['left out main', 'fn helper() -> i32 { return 1 }\n', /error\[SEM0225\] Entry point `main` is missing/],
  ['made main private', 'fn main() -> i32 { return 0 }\n', /error\[SEM0225\] Entry point `main` must be `pub`$/],
  ['added two strings', 'pub fn main() -> i32 {\n  let s = "a" + "b"\n  return 0\n}\n', /error\[SEM0135\] Operator \+ does not accept \(string<'static>, string<'static>\)$/],
  ['mixed integer types', 'pub fn main() -> i32 {\n  let a: i64 = 1\n  let b: i32 = 2\n  return a + b\n}\n', /error\[SEM0135\] Operator \+ does not accept \(i64, i32\)$/],
  ['used null', 'pub fn main() -> i32 {\n  let x = null\n  return 0\n}\n', /error\[SEM0006\] Unknown value null$/],
  ['logged a string variable (strings copy, no move needed)', `${logging}  let tea = "x"\n  run Effect.log("{t}", &.{ t: tea }) |> Effect.provideMut(&mut logger)\n}\n`, null],
  ['logged without a provider', 'import silk.core.effect { Effect }\nimport silk.io.logger { LogError }\npub effect fn main() -> () ! LogError {\n  run Effect.log("hi", &())\n}\n', /error\[SEM0071\]/],
  ['did not declare the failure', 'import silk.core.effect { Effect }\nimport silk.io.logger_native { StdoutLogger }\npub effect fn main() -> () {\n  let mut logger = StdoutLogger.make()\n  run Effect.log("hi", &()) |> Effect.provideMut(&mut logger)\n}\n', /error\[SEM0066\]/],
  ['misspelled a placeholder', `${logging}  run Effect.log("hi {nmae}", &.{ name: 1 }) |> Effect.provideMut(&mut logger)\n}\n`, /error\[SEM0177\] template field \{nmae\} not found; available visible fields: name$/],
  ['left a placeholder open', `${logging}  run Effect.log("hi {name", &.{ name: 1 }) |> Effect.provideMut(&mut logger)\n}\n`, /error\[SEM0177\] template placeholder is not closed: \{name$/],
  ['logged a struct with no Display', `struct P { x: i32 }\n${logging}  let p = P { x: 1 }\n  run Effect.log("{p}", &.{ p: move p }) |> Effect.provideMut(&mut logger)\n}\n`, /error\[SEM0121\] `main\.P: silk[./]format\.Display` cannot be proved/],
  ['wrote a typed literal', 'pub fn main() -> i32 {\n  let x = 5u64\n  return 0\n}\n', /error\[LEX0014\] Numeric literals take no type suffix/],
]

for (const [what, source, first] of cases) {
  test(`a newcomer who ${what} gets a clear error`, () => {
    const result = check(source)
    if (first === null) {
      assert.equal(result.status, 0, show(result))
      return
    }
    assert.equal(result.status, 1, show(result))
    assert.match(result.errors[0] ?? '', first, show(result))
  })
}

test('a placeholder with no record fields gets the template error', { todo: 'finding 15: SEM0176 instead' }, () => {
  const result = check(`${logging}  run Effect.log("hi {name}", &()) |> Effect.provideMut(&mut logger)\n}\n`)
  assert.match(result.errors[0] ?? '', /error\[SEM0177\] template field \{name\} not found/, show(result))
})

test('a template that is not a literal says it must be static', { todo: 'finding 15: SEM0176 instead' }, () => {
  const result = check(`${logging}  let t = "x"\n  run Effect.log(t, &()) |> Effect.provideMut(&mut logger)\n}\n`)
  assert.doesNotMatch(result.errors[0] ?? '', /SEM0176/, show(result))
})

test('returning a literal as plain string suggests string<\'static>', { todo: 'finding 27' }, () => {
  const result = check('fn noun() -> string {\n  return "task"\n}\npub fn main() -> i32 { return 0 }\n')
  assert.match(result.errors[0] ?? '', /error\[SEM0210\]/, show(result))
  assert.match(result.errors[0] ?? '', /'static/, show(result))
})

test('a type mismatch on a call result names both types', { todo: 'finding 21' }, () => {
  const result = check('fn total() -> i32 { return 1 }\npub fn main() -> i32 {\n  let s: string = total()\n  return 0\n}\n')
  assert.match(result.errors[0] ?? '', /expected string.* received i32|string.*i32/, show(result))
})

test('silk check --json writes one object per diagnostic on standard error', () => {
  write(join(dir, 'src/main.silk'), 'pub fn main() -> i32 {\n  let x: i32 = "a"\n  return y\n}\n')
  const result = silk(h, ['check', '--json'], { cwd: dir })
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  const objects = result.stderr.trim().split('\n').map((line) => JSON.parse(line))
  assert.deepEqual(objects.map((object) => [object.code, object.line, object.column]), [['SEM0037', 2, 16], ['SEM0006', 3, 10]])
  assert.ok(objects.every((object) => object.path.endsWith('/src/main.silk') && object.severity === 'error'))
})
