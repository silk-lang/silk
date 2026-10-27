// Round 59: scalar enums (reference Enums and unions): representations, explicit and implicit
// values in every literal form, value(), methods in an impl, exhaustive match, if let, enums in
// structs and arrays, and the SEM0146..SEM0162 rules a new user hits first.
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { here, initPackage, join, read, sharedHome, show, silk, write } from './lib.mjs'

const h = sharedHome()
let serial = 0
const program = read(join(here, 'programs/enums.silk'))

function variant(from = '', to = '') {
  assert.ok(program.includes(from), `the program contains ${from}`)
  const dir = initPackage(h, `enums-${++serial}`)
  write(join(dir, 'src/main.silk'), program.replace(from, to))
  return dir
}

const main = 'pub fn main() -> i32 {\n'
const check = (dir) => silk(h, ['check'], { cwd: dir })
const declare = (decl) => check(variant(main, `${decl}\n\n${main}`))
const body = (code) => check(variant(main, `${main}  ${code}\n`))

test('the enums program in programs/ passes all its checks', () => {
  const result = silk(h, ['run'], { cwd: variant() })
  assert.equal(result.status, 0, show(result))
})

const rules = [
  ['an enum with no members', 'SEM0146', () => declare('enum Nothing {}')],
  ['a float representation', 'SEM0147', () => declare('enum(f32) Ratio { Half }')],
  ['a repeated member name', 'SEM0148', () => declare('enum Twice { A, A }')],
  ['a repeated value', 'SEM0149', () => declare('enum Same { A = 1, B = 1 }')],
  ['a value outside u8', 'SEM0150', () => declare('enum(u8) Big { A = 256 }')],
  ['an implicit successor past 255', 'SEM0151', () => declare('enum(u8) Edge { A = 255, B }')],
  ['a negative value under u8', 'SEM0152', () => declare('enum(u8) Below { A = -1 }')],
  ['an unknown member', 'SEM0153', () => body('let gone = Status.Gone')],
  ['a member of the wrong enum', 'SEM0154', () => body('let wrong = Reply { status: Light.Red, retries: 0 }')],
  ['an enum compared with an integer', 'SEM0155', () => body('if Status.Ok == 200 { return 20 }')],
  ['an enum read into an integer', 'SEM0155', () => body('let code: u16 = Status.Ok')],
  ['equality between two enums', 'SEM0156', () => body('if Light.Red == Level.Low { return 20 }')],
  ['an ordering comparison', 'SEM0157', () => body('if Status.Ok < Status.Created { return 20 }')],
  ['a match that misses a member', 'SEM0158', () => body('let n = match Light.Red { Light.Red => 1  Light.Green => 2 }')],
  ['a repeated match arm', 'SEM0159', () => body('let n = match Light.Red { Light.Red => 1  Light.Red => 2  _ => 3 }')],
  ['a pattern from another enum', 'SEM0161', () => body('let n = match Light.Red { Level.Low => 1  _ => 2 }')],
  ['an integer pattern', 'SEM0162', () => body('let n = match Light.Red { 0 => 1  _ => 2 }')],
]

for (const [name, code, run] of rules) {
  test(`${name} is ${code}`, () => {
    const result = run()
    assert.notEqual(result.status, 0, show(result))
    assert.match(result.stderr, new RegExp(`${code}\\]`), show(result))
  })
}

test('a missed match member is named', () => {
  const result = body('let n = match Light.Red { Light.Red => 1  Light.Green => 2 }')
  assert.match(result.stderr, /SEM0158\] Match over main\.Light does not cover Yellow|SEM0158\] Match over Light does not cover Yellow/, show(result))
})

// Finding 174, fixed by #2423: scalar enum diagnostics name the enum, member, value and range.
test('an unknown member names the enum and the member', () => {
  const result = body('let gone = Status.Gone')
  assert.match(result.stderr, /SEM0153\][^\n]*Status[^\n]*Gone|SEM0153\][^\n]*Gone[^\n]*Status/, show(result))
})

test('a value outside the representation names the value and the range', () => {
  const result = declare('enum(u8) Big { A = 256 }')
  assert.match(result.stderr, /SEM0150\][^\n]*256[^\n]*255/, show(result))
})

test('a member of the wrong enum names both enums', () => {
  const result = body('let wrong = Reply { status: Light.Red, retries: 0 }')
  assert.match(result.stderr, /SEM0154\][^\n]*Light[^\n]*Status|SEM0154\][^\n]*Status[^\n]*Light/, show(result))
})

test('mixing an enum with an integer points at value()', () => {
  const result = body('if Status.Ok == 200 { return 20 }')
  assert.match(result.stderr, /SEM0155\][\s\S]*Status\.value\(/, show(result))
})

test('the receiver form e.value() points at Name.value(e)', () => {
  const result = body('let code = Status.Ok.value()')
  assert.match(result.stderr, /SEM0010\][\s\S]*Status\.value\(/, show(result))
})
