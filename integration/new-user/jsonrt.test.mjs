// Round 58: JSON documents through std/json_value and std/json_codec: escapes, surrogate pairs,
// number spellings kept as written, nesting depth 64 and 65, and the reason and offset of each
// kind of bad input.
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { here, initPackage, join, read, sharedHome, show, silk, write } from './lib.mjs'

const h = sharedHome()
let serial = 0
const program = read(join(here, 'programs/jsonrt.silk'))

function project(source) {
  const dir = initPackage(h, `jsonrt-${++serial}`)
  write(join(dir, 'src/main.silk'), source)
  return dir
}

const expected = `mixed: {"a":[1,2.50,-0,1e3,12345678901234567890],"b":"xé\\n\\"","c":{"d":null,"e":true}}
pair: "🎉"
lone: error InvalidEscape at Some(7)
trailing comma: error UnexpectedByte at Some(3)
duplicate: error DuplicateKey at Some(7)
open: error UnexpectedEnd at Some(1)
two values: error TrailingContent at Some(2)
leading zero: error InvalidNumber at Some(1)
control: error UnexpectedByte at Some(2)
word: error UnexpectedEnd at Some(3)
colon: error UnexpectedByte at Some(5)
utf8: error InvalidUtf8 at Some(1)
empty: error UnexpectedEnd at Some(0)
depth 64: [[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]
depth 65: error DepthExceeded at Some(64)
range: error NumberOutOfRange at Some(4)
`

test('the JSON program in programs/ prints each document or its error as documented', () => {
  const result = silk(h, ['run', '--quiet'], { cwd: project(program) })
  assert.equal(result.status, 0, show(result))
  assert.equal(result.stdout, expected, show(result))
})

// Finding 172: matching on Result without importing it.
test('a match on Result.Success without the import says the import is missing', { todo: 'finding 172' }, () => {
  const result = silk(h, ['check'], { cwd: project(program.replace('import silk.result { Result }\n', '')) })
  assert.notEqual(result.status, 0, show(result))
  assert.match(result.stderr, /import silk\.result/, show(result))
  assert.doesNotMatch(result.stderr, /A match arm naming a member its scrutinee type does not have/, show(result))
})
