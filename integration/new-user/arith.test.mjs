// Round 61: integer arithmetic policies (reference Values and primitive types) and nominal
// tuples (reference Structs, tuples and arrays): FNV-1a with wrapping math, saturating and
// checked operations, shifts and rotates, signed division, conversions, traps, and tuples.
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { here, initPackage, join, read, sharedHome, show, silk, write } from './lib.mjs'

const h = sharedHome()
let serial = 0
const program = read(join(here, 'programs/arith.silk'))

function variant(from = '', to = '') {
  assert.ok(program.includes(from), `the program contains ${from}`)
  const dir = initPackage(h, `arith-${++serial}`)
  write(join(dir, 'src/main.silk'), program.replace(from, to))
  return dir
}

const end = '  return 0\n}'
const check = (dir) => silk(h, ['check'], { cwd: dir })
const run = (dir) => silk(h, ['run', '--quiet'], { cwd: dir })
const trapped = (result) => result.signal === 'SIGILL' || result.status === 132

test('the arith program in programs/ passes all its checks', () => {
  const result = silk(h, ['run'], { cwd: variant() })
  assert.equal(result.status, 0, show(result))
})

test('the arith program passes in a release build', () => {
  const result = silk(h, ['run', '--release'], { cwd: variant() })
  assert.equal(result.status, 0, show(result))
})

const traps = [
  ['u8 addition past MAX', 'let big: u8 = u8.MAX\n  let more = big + u8.wrappingAdd(0, 1)\n  return u8.toI32(more)\n}', /fatal trap: arithmetic overflow\n\s+at main\.main \(main:\d+:\d+\)/],
  ['i32.MIN / -1', 'let lo = i32.MIN\n  let neg = 0 - 1\n  return lo / neg\n}', /fatal trap: arithmetic overflow\n\s+at main\.main/],
  ['i32.toU8(300)', 'let n = 300\n  return u8.toI32(i32.toU8(n))\n}', /fatal trap: i32\.toU8: the value is outside the u8 range\n\s+at main\.main/],
]

for (const [name, code, text] of traps) {
  test(`${name} traps with its kind and the caller's line`, () => {
    const result = run(variant(end, `  ${code}`))
    assert.ok(trapped(result), show(result))
    assert.match(result.stderr, text, show(result))
  })
}

const rules = [
  ['a constant sum past u8', /SEM0247\] 200 \+ 100 is 300, outside the u8 range, 0 through 255, so it always traps/, () => variant(end, '  let x: u8 = 200 + 100\n' + end)],
  ['an anonymous tuple type', /PAR0008\] Silk has no anonymous tuple types/, () => variant('let lit: Range = (2, 5)', 'let lit: (i32, i32) = (2, 5)')],
  ['i32 plus i64', /SEM0135\] Operator \+ does not accept \(i32, i64\)/, () => variant('  // Tuples.', '  let small: i32 = 1\n  let wide: i64 = 2\n  if small + wide != 3 { return 30 }\n  // Tuples.')],
  ['an as cast', /PAR0002\] Silk has no `as` cast/, () => variant('if u8.toI32(u8.MAX) != 255', 'if (u8.MAX as i32) != 255')],
  ['a tuple built with one element too few', /SEM0172\]/, () => variant('let r = Range(3, 10)', 'let r = Range(3)')],
  ['a tuple ordinal past the end', /SEM0027\]/, () => variant('if width(r) != 7', 'if r.2 != 7')],
]

for (const [name, text, make] of rules) {
  test(`${name} is reported`, () => {
    const result = check(make())
    assert.notEqual(result.status, 0, show(result))
    assert.match(result.stderr, text, show(result))
  })
}

// Finding 177: arithmetic and tuple mistakes with messages that name nothing, and a shift trap
// reported inside the standard library.
test('a shift count of 32 traps at the caller line', { todo: 'finding 177' }, () => {
  const result = run(variant(end, '  let n: u32 = 32\n  return u32.toI32(u32.shiftLeft(1, n))\n}'))
  assert.ok(trapped(result), show(result))
  assert.match(result.stderr, /fatal trap: [^\n]*shift[^\n]*\n\s+at main\.main/, show(result))
})

test('.len on a slice suggests .length', { todo: 'finding 177' }, () => {
  const result = check(variant('bytes.length', 'bytes.len'))
  assert.match(result.stderr, /SEM0027\][^\n]*len[\s\S]*length/, show(result))
})

test('a tuple ordinal past the end names the tuple and its element count', { todo: 'finding 177' }, () => {
  const result = check(variant('if width(r) != 7', 'if r.2 != 7'))
  assert.match(result.stderr, /SEM0027\][^\n]*Range[^\n]*2/, show(result))
})

test('a tuple built with the wrong count says how many elements it takes', { todo: 'finding 177' }, () => {
  const result = check(variant('let r = Range(3, 10)', 'let r = Range(3)'))
  assert.match(result.stderr, /SEM0172\][^\n]*Range[^\n]*2/, show(result))
})

test('a >> operator points at shiftRight', { todo: 'finding 177' }, () => {
  const result = check(variant('if i32.shiftRight(-8, 1) != -4', 'if (-8 >> 1) != -4'))
  assert.notEqual(result.status, 0, show(result))
  assert.match(result.stderr, /shiftRight/, show(result))
})
