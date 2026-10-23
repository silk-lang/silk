// `silk test` as the Testing page describes it, including what happens when tests fail.
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { initPackage, join, read, sharedHome, show, silk, write } from './lib.mjs'

const h = sharedHome()
let serial = 0
const library = () => initPackage(h, `lib-${++serial}`, ['--lib'])

const failing = `
test effect fn failsOnPurpose() -> ()
  ! AssertionError<'static> {
  run Testing.expect(add(2, 2) == 5, "2 + 2 is 5")
}
`
const trapping = `
test fn trapsOnPurpose() {
  let values: [i32; 2] = [1, 2]
  let mut index: usize = 5
  let x = values[index]
}
`

test('silk init --lib makes a library with a passing test', () => {
  const dir = library()
  assert.match(read(join(dir, 'silk.toml')), /root = "src\/lib\.silk"\nsource-root = "src"\nexports = \["lib"\]\n\n\[build\]\nartifact = "static-library"/)
  const result = silk(h, ['test', '--no-cache'], { cwd: dir })
  assert.equal(result.status, 0, show(result))
  assert.match(result.stdout, /  lib::addsTwoNumbers\n    PASS /)
  assert.match(result.stdout, /Tests  1 passed, 0 failed \(0 cached, 1 executed, 1 selected, 1 discovered\)/)
})

test('plain silk test runs the tests', { todo: 'finding 2: needs --no-cache' }, () => {
  const result = silk(h, ['test'], { cwd: library() })
  assert.equal(result.status, 0, show(result))
})

test('a failing assertion fails the run with its message', () => {
  const dir = library()
  write(join(dir, 'src/lib.silk'), read(join(dir, 'src/lib.silk')) + failing)
  const result = silk(h, ['test', '--no-cache'], { cwd: dir })
  assert.equal(result.status, 1, show(result))
  assert.match(result.stdout, /  lib::failsOnPurpose\n    assertion failed: 2 \+ 2 is 5\n    FAIL /)
  assert.match(result.stdout, /Tests  1 passed, 1 failed/)
})

test('a failing assertion prints no unhandled-error trace', { todo: 'finding 3' }, () => {
  const dir = library()
  write(join(dir, 'src/lib.silk'), read(join(dir, 'src/lib.silk')) + failing)
  const result = silk(h, ['test', '--no-cache'], { cwd: dir })
  assert.doesNotMatch(result.stderr, /unhandled error/)
})

test('a test that traps fails, the rest still run, and the run exits 1', { todo: 'finding 1: the runner dies and silk test exits 0' }, () => {
  const dir = library()
  write(join(dir, 'src/lib.silk'), read(join(dir, 'src/lib.silk')) + trapping + '\ntest fn runsAfterTheTrap() {}\n')
  const result = silk(h, ['test', '--no-cache'], { cwd: dir })
  assert.equal(result.status, 1, show(result))
  assert.match(result.stdout, /lib::trapsOnPurpose\n(.*\n)*    FAIL /)
  assert.match(result.stdout, /lib::runsAfterTheTrap\n    PASS /)
  assert.match(result.stdout, /Tests  2 passed, 1 failed/)
})

test('--filter selects tests, and a filter that matches nothing is an error', () => {
  const dir = library()
  write(join(dir, 'src/lib.silk'), read(join(dir, 'src/lib.silk')) + '\ntest fn other() {}\n')
  const picked = silk(h, ['test', '--no-cache', '--filter', 'adds'], { cwd: dir })
  assert.equal(picked.status, 0, show(picked))
  assert.match(picked.stdout, /1 selected, 2 discovered/)
  const none = silk(h, ['test', '--no-cache', '--filter', 'nothing'], { cwd: dir })
  assert.equal(none.status, 1)
  assert.match(none.stderr, /no tests matched the --file or --filter selection/)
})

test('SEM0218 for a test with parameters', () => {
  const dir = library()
  write(join(dir, 'src/lib.silk'), read(join(dir, 'src/lib.silk')) + '\ntest fn withParam(x: i32) {\n}\n')
  const result = silk(h, ['check'], { cwd: dir })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /error\[SEM0218\]/)
})
