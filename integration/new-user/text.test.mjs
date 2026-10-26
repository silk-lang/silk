// Round 53: text that is not ASCII (std/string, reference Lexical structure): scalar traversal,
// byte offsets, find and findLast, slice and isCharBoundary, split on a multi-byte separator,
// Unicode whitespace in trim, byte-exact startsWith, building a String, and the mistakes a new
// user makes with text.
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { here, initPackage, join, read, sharedHome, show, silk, write } from './lib.mjs'

const h = sharedHome()
let serial = 0

function project(source) {
  const dir = initPackage(h, `text-${++serial}`)
  write(join(dir, 'src/main.silk'), source)
  return dir
}

const body = (line) => `import silk.string { String }\n\npub fn main() -> i32 {\n  let text = "café"\n  ${line}\n  return 0\n}\n`

test('the text program in programs/ passes all its checks', () => {
  const result = silk(h, ['run'], { cwd: project(read(join(here, 'programs/text.silk'))) })
  assert.equal(result.status, 0, show(result))
})

test('slicing inside a scalar traps with the reason', () => {
  const result = silk(h, ['run', '--quiet'], { cwd: project(body('if String.slice(text, 0, 4) != "caf" { return 1 }')) })
  assert.notEqual(result.status, 0, show(result))
  assert.match(result.stderr, /String\.slice: the range does not start and end on character boundaries/, show(result))
})

test('slicing past the end traps with the reason', () => {
  const result = silk(h, ['run', '--quiet'], { cwd: project(body('if String.slice(text, 2, 9) != "f" { return 1 }')) })
  assert.notEqual(result.status, 0, show(result))
  assert.match(result.stderr, /String\.slice: the range ends past the end of the text/, show(result))
})

test('a character literal with two scalars counts them', () => {
  const result = silk(h, ['check'], { cwd: project(body("let c: char = 'ab'")) })
  assert.match(result.stderr, /LEX0007\] Character literal must hold exactly one Unicode scalar, but holds 2/, show(result))
})

// Finding 166: escapes and string mistakes that could say what to write.
for (const [name, line, wanted] of [
  ['a surrogate escape says it is a surrogate', 'let c = "\\u{D800}"', /surrogate/i],
  ['an escape past U+10FFFF says the limit', "let c = '\\u{110000}'", /10FFFF/i],
  ['a byte string escape above FF says the limit', 'let b = b"\\u{100}"', /\bFF\b/],
  ['text.length points at String.byteLength', 'let n = text.length', /String\.byteLength/],
  ['indexing text points at the bytes or scalars', 'let c = text[0]', /String\.(utf8Bytes|nextScalar)/],
  ['a string method call points at the String function', 'if text.startsWith("c") { return 1 }', /String\.startsWith\(text/],
  ['adding strings points at String.append or a template', 'let s = text + "!"', /String\.append|Format/],
]) {
  test(name, { todo: 'finding 166' }, () => {
    const result = silk(h, ['check'], { cwd: project(body(line)) })
    assert.notEqual(result.status, 0, show(result))
    assert.match(result.stderr, wanted, show(result))
  })
}
