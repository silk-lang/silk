// Round 48: fibers and cancellation (book chapter 10, reference Suspension and cancellation): a
// race of three workers under LocalScheduler, where the late one is cancelled when the root
// returns. Its Drop guard and its ensuringNonParking finalizer still run.
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { here, initPackage, join, read, sh, sharedHome, show, silk, write } from './lib.mjs'

const h = sharedHome()
let serial = 0
const program = read(join(here, 'programs/race.silk'))

function variant(from = '', to = '') {
  assert.ok(program.includes(from), `the program contains ${from}`)
  const dir = initPackage(h, `race-${++serial}`)
  write(join(dir, 'src/main.silk'), program.replace(from, to))
  return dir
}

const binary = (dir) => join(dir, 'build/llvm/x86_64-unknown-linux-gnu/debug', dir.split('/').pop())

test('the race program cancels the late worker and still runs its cleanup', () => {
  const dir = variant()
  const built = silk(h, ['build'], { cwd: dir })
  assert.equal(built.status, 0, show(built))
  const started = Date.now()
  const ran = sh(h, binary(dir), { cwd: dir })
  assert.equal(ran.status, 0, show(ran))
  assert.ok(Date.now() - started < 1500, 'the 2 s worker was cancelled, not waited for')
})

test('an Effect.ensuring finalizer does not run on cancellation', () => {
  const dir = variant('Effect.ensuringNonParking(finish', 'Effect.ensuring(finish')
  assert.equal(silk(h, ['build'], { cwd: dir }).status, 0)
  assert.equal(sh(h, binary(dir), { cwd: dir }).status, 22, 'two finalizers ran, not three')
})

test('a join that can be cancelled asks for Cancelled in the row', () => {
  const result = silk(h, ['check'], { cwd: variant('  ! OutOfMemoryError | TaskIdExhaustedError | Cancelled\n  ? &mut Scheduler', '  ! OutOfMemoryError | TaskIdExhaustedError\n  ? &mut Scheduler') })
  assert.match(result.stderr, /error\[SEM0066\] This `run` can fail with `Cancelled`, which the enclosing function does not declare; add `! Cancelled`/)
})

test('a callback of Shared.withMut that runs an Effect says what it runs', { todo: 'finding 158' }, () => {
  const result = silk(h, ['check'], { cwd: variant('fn countFinal(log: &mut Log) -> () {', 'effect fn noisy() -> () {\n}\n\nfn countFinal(log: &mut Log) -> () {\n  run noisy()') })
  assert.match(result.stderr, /error\[OWN0016\]/)
  assert.doesNotMatch(result.stderr, /An access-scoped local-shared borrow escaping or crossing suspension/)
})

test('a parking finalizer for ensuringNonParking names NonParking and what parks', { todo: 'finding 159' }, () => {
  const result = silk(h, ['build'], { cwd: variant('effect fn finish(log: Shared<Log>) -> () {', 'effect fn finish(log: Shared<Log>) -> () ? &mut MonotonicClock {\n  run Effect.sleep(1)') })
  assert.match(result.stderr, /error\[SEM0139\]/)
  assert.match(result.stderr, /NonParking|park/)
})
