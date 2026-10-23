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
  assert.match(read(join(dir, 'silk.toml')), /\nkind = "library"\nexports = \["lib"\]\n$/)
  const result = silk(h, ['test', '--no-cache'], { cwd: dir })
  assert.equal(result.status, 0, show(result))
  assert.match(result.stdout, /  lib::addsTwoNumbers\n    PASS /)
  assert.match(result.stdout, /Tests  1 passed, 0 failed \(0 cached, 1 executed, 1 selected, 1 discovered\)/)
})

test('plain silk test runs the tests', () => {
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

test('a failing assertion prints no unhandled-error trace', () => {
  const dir = library()
  write(join(dir, 'src/lib.silk'), read(join(dir, 'src/lib.silk')) + failing)
  const result = silk(h, ['test', '--no-cache'], { cwd: dir })
  assert.doesNotMatch(result.stderr, /unhandled error/)
})

test('a test that traps fails, the rest still run, and the run exits 1', () => {
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

// Many small tests, as a package grows them.
function manyTests(count, broken = -1) {
  let text = "import silk.testing { AssertionError, Testing }\n\n"
  for (let i = 0; i < count; i++) {
    const want = i === broken ? i + 2 : i + 1
    text += `test effect fn t${i}() -> ()\n  ! AssertionError<'static> {\n  run Testing.expect(${i} + 1 == ${want}, "sum")\n}\n\n`
  }
  return text
}

const seconds = (start) => Number(process.hrtime.bigint() - start) / 1e9

test('after an edit, the second silk test reuses the test build', { todo: 'finding 90' }, () => {
  const dir = library()
  write(join(dir, 'src/lib.silk'), manyTests(200))
  const cold = silk(h, ['test'], { cwd: dir })
  assert.equal(cold.status, 0, show(cold))
  write(join(dir, 'src/lib.silk'), manyTests(200, 5))
  const edited = silk(h, ['test'], { cwd: dir })
  assert.equal(edited.status, 1, show(edited))
  const start = process.hrtime.bigint()
  const again = silk(h, ['test'], { cwd: dir })
  assert.equal(again.status, 1, show(again))
  assert.ok(seconds(start) < 1.5, `the unchanged rerun took ${seconds(start)} s`)
})

test('silk doctest runs the examples, so an example that returns 1 fails', { todo: 'finding 92' }, () => {
  const dir = initPackage(h, `doc-${++serial}`, ['--lib'])
  write(join(dir, 'src/lib.silk'), `/// Six times \`radius\`.\n///\n/// \`\`\`silk\n/// import lib { circumference }\n///\n/// pub fn main() -> i32 {\n///   return circumference(2) - 11\n/// }\n/// \`\`\`\npub fn circumference(radius: i32) -> i32 {\n  return radius * 6\n}\n`)
  const doc = silk(h, ['doc'], { cwd: dir })
  assert.equal(doc.status, 0, show(doc))
  const checked = silk(h, ['doctest', '-i', 'build/documentation.json', '--source-root', 'src'], { cwd: dir })
  assert.equal(checked.status, 1, show(checked))
  assert.match(checked.stdout, /FAILED/, show(checked))
})

test('silk doctest in a package needs no flags', { todo: 'finding 92' }, () => {
  const dir = library()
  const checked = silk(h, ['doctest'], { cwd: dir })
  assert.notEqual(checked.status, 2, show(checked))
  assert.doesNotMatch(checked.stderr, /pass --input/, show(checked))
})

test('a doc example imports a package with a hyphen in its name the way a dependent does', { todo: 'finding 93' }, () => {
  const dir = initPackage(h, `doc-${++serial}`, ['--lib'])
  const name = dir.split('/').at(-1).replaceAll('-', '_')
  write(join(dir, 'src/lib.silk'), `/// Six times \`radius\`.\n///\n/// \`\`\`silk\n/// import ${name}.lib { circumference }\n///\n/// pub fn main() -> i32 {\n///   return circumference(2) - 12\n/// }\n/// \`\`\`\npub fn circumference(radius: i32) -> i32 {\n  return radius * 6\n}\n`)
  const doc = silk(h, ['doc'], { cwd: dir })
  assert.equal(doc.status, 0, show(doc))
  const checked = silk(h, ['doctest', '-i', 'build/documentation.json', '--source-root', 'src'], { cwd: dir })
  assert.equal(checked.status, 0, show(checked))
})
