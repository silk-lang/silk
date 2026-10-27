// Round 60: when destructors run (reference Ownership and moves): reverse declaration order,
// drop, assignment, temporaries, maybe-moved bindings, partial moves, arrays and struct fields,
// break and early return, mut parameters, Intrinsic.replace, and a typed failure.
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { here, initPackage, join, read, sharedHome, show, silk, write } from './lib.mjs'

const h = sharedHome()
let serial = 0
const program = read(join(here, 'programs/drops.silk'))

function variant(from = '', to = '') {
  assert.ok(program.includes(from), `the program contains ${from}`)
  const dir = initPackage(h, `drops-${++serial}`)
  write(join(dir, 'src/main.silk'), program.replace(from, to))
  return dir
}

const check = (dir) => silk(h, ['check'], { cwd: dir })
const swappedTail = '  let c = tracer(3, log)\n  return ()\n}\n\n// A failing'

test('the drops program in programs/ passes all its checks', () => {
  const result = silk(h, ['run'], { cwd: variant() })
  assert.equal(result.status, 0, show(result))
})

test('the drops program gives the same order in a release build', () => {
  const result = silk(h, ['run', '--release'], { cwd: variant() })
  assert.equal(result.status, 0, show(result))
})

function copyOnDrop() {
  const dir = variant('import silk.ownership { Drop }', 'import silk.ownership { Copy, Drop }')
  write(join(dir, 'src/main.silk'), read(join(dir, 'src/main.silk')).replace('struct Oops {', 'impl Copy for Tracer {}\n\nstruct Oops {'))
  return dir
}

const rules = [
  ['a Drop hook taking self by value', 'SEM0084', /Invalid Drop hook: the hook is `fn drop\(self: &mut Self\) -> \(\)`/, () => variant('fn drop(self: &mut Tracer) -> () {', 'fn drop(self: Tracer) -> () {')],
  ['let _ = on a value', 'SEM0087', /write `drop` before the expression/, () => variant('  let b = tracer(2, log)\n  let c = tracer(3, log)', '  let _ = tracer(2, log)\n  let c = tracer(3, log)')],
  ['passing a value without move', 'OWN0003', /Moving a requires an explicit move/, () => variant('    consume(move a)', '    consume(a)')],
  ['reading a field after drop', 'OWN0001', /first\.id was moved and cannot be used again/, () => variant('  drop first\n  let c = tracer(3, log)', '  drop first\n  let c = tracer(first.id, log)')],
  ['a partial move out of a Drop type', 'OWN0002', null, () => variant('  let first = move pair.first', '  let t = tracer(9, log)\n  let tlog = move t.log\n  let first = move pair.first')],
  ['moving an outer owner inside a loop', 'OWN0005', null, () => variant('    let inner = tracer(i, log)', '    let inner = tracer(i, log)\n    consume(move outer)')],
  ['Copy on a type with a Drop hook', 'SEM0083', null, copyOnDrop],
]

for (const [name, code, text, make] of rules) {
  test(`${name} is ${code}`, () => {
    const result = check(make())
    assert.notEqual(result.status, 0, show(result))
    assert.match(result.stderr, new RegExp(`${code}\\]`), show(result))
    if (text) assert.match(result.stderr, text, show(result))
  })
}

// Finding 176, fixed by #2427: ownership and drop mistakes whose messages read like rule titles or
// described something else.
test('a bare block says Silk has no bare blocks', () => {
  const result = check(variant(swappedTail, '  {\n    let c = tracer(3, log)\n  }\n  return ()\n}\n\n// A failing'))
  assert.notEqual(result.status, 0, show(result))
  assert.doesNotMatch(result.stderr, /Expected identifier/, show(result))
  assert.match(result.stderr, /block/, show(result))
})

test('Intrinsic.replace(&mut slot, v) says replace takes the place itself', () => {
  const result = check(variant('Intrinsic.replace(slot,', 'Intrinsic.replace(&mut slot,'))
  assert.notEqual(result.status, 0, show(result))
  assert.doesNotMatch(result.stderr, /Assignment requires/, show(result))
})

test('a partial move out of a Drop type names the type and its Drop hook', () => {
  const result = check(variant('  let first = move pair.first', '  let t = tracer(9, log)\n  let tlog = move t.log\n  let first = move pair.first'))
  assert.match(result.stderr, /OWN0002\][^\n]*Tracer/, show(result))
})

test('a move inside a loop names the owner', () => {
  const result = check(variant('    let inner = tracer(i, log)', '    let inner = tracer(i, log)\n    consume(move outer)'))
  assert.match(result.stderr, /OWN0005\][^\n]*outer/, show(result))
})

test('dropping a binding twice names it, as reading a dropped field does', () => {
  const result = check(variant('  drop first', '  drop first\n  drop first'))
  assert.match(result.stderr, /OWN0001\][^\n]*first/, show(result))
})

test('Copy on a Drop type says why it is invalid', () => {
  const result = check(copyOnDrop())
  assert.match(result.stderr, /SEM0083\][^\n]*(Drop|Tracer)/, show(result))
})

test('calling the drop hook directly points at the drop statement', () => {
  const result = check(variant(swappedTail, '  let mut c = tracer(3, log)\n  c.drop()\n  return ()\n}\n\n// A failing'))
  assert.match(result.stderr, /SEM0010\][\s\S]*drop c/, show(result))
})
