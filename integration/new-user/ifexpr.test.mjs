// Round 51: if/else and value blocks as expressions (#2354): if with a final else in let, return,
// operands, fields and parentheses, else-if chains, if let, branches that move or return, and
// match arm blocks that yield their last expression.
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { here, initPackage, join, read, sharedHome, show, silk, write } from './lib.mjs'

const h = sharedHome()
let serial = 0
const program = read(join(here, 'programs/ifexpr.silk'))
const end = '  return 0\n}'

function variant(from = '', to = '') {
  assert.ok(program.includes(from), `the program contains ${from}`)
  const dir = initPackage(h, `ifexpr-${++serial}`)
  write(join(dir, 'src/main.silk'), program.replace(from, to))
  return dir
}

const run = (dir) => silk(h, ['run'], { cwd: dir })

test('the if-expression program in programs/ runs and exits 0', () => {
  const result = run(variant())
  assert.equal(result.status, 0, show(result))
})

for (const [name, code] of [
  ['an operand', '  let s = 1 + if nested > 1 { 3 } else { 4 }\n  return s - 4\n}'],
  ['a field value', '  let b = Box { value: if nested > 1 { 3 } else { 4 } }\n  return b.value - 3\n}'],
  ['a parenthesized call argument', '  let s = twice((if nested > 1 { 3 } else { 4 }))\n  return s - 6\n}'],
  ['an assignment', '  let mut z = 0\n  z = if nested > 1 { 3 } else { 4 }\n  return z - 3\n}'],
  ['a return value', '  return if nested > 1 { 0 } else { 4 }\n}'],
]) {
  test(`an if expression works as ${name}`, () => {
    const result = run(variant(end, code))
    assert.equal(result.status, 0, show(result))
  })
}

// Findings 163 and 164 fixed by #2367.
test('an if expression works as a call argument', () => {
  const result = run(variant(end, '  let s = twice(if nested > 1 { 3 } else { 4 })\n  return s - 6\n}'))
  assert.equal(result.status, 0, show(result))
})

test('an if expression works as an array element', () => {
  const result = run(variant(end, '  let arr = [if nested > 1 { 3 } else { 4 }, 5]\n  return arr[0] - 3\n}'))
  assert.equal(result.status, 0, show(result))
})

test('a branch that ends in a let names the branch, not match arms', () => {
  const result = silk(h, ['check'], { cwd: variant(end, '  let t = if nested > 1 {\n    let a = 3\n  } else {\n    4\n  }\n  return 0\n}') })
  assert.match(result.stderr, /error\[SEM0049\]/)
  assert.doesNotMatch(result.stderr, /Match arms whose result types have no common type/)
})

test('an if statement with value branches says the if is a statement', () => {
  const result = silk(h, ['check'], { cwd: variant(end, '  if nested > 1 { 3 } else { 4 }\n  return 0\n}') })
  assert.match(result.stderr, /error\[SEM0087\].*\bif\b/)
})
