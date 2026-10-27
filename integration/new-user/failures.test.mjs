// Round 56: typed failures across two modules of one package (reference Typed failures, book
// chapter 7): struct and union failures declared in bank.silk, propagation through run, catch of
// one member, catchAll with a match, mapError, Effect.result, ensuring, and drops on failure.
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { here, initPackage, join, read, sharedHome, show, silk, write } from './lib.mjs'

const h = sharedHome()
let serial = 0
const bank = read(join(here, 'programs/bank/bank.silk'))
const main = read(join(here, 'programs/bank/main.silk'))

function project(mainSource = main, bankSource = bank) {
  const dir = initPackage(h, `bank-${++serial}`)
  write(join(dir, 'src/main.silk'), mainSource)
  write(join(dir, 'src/bank.silk'), bankSource)
  return dir
}

test('the bank program runs, drops each receipt once and runs the finalizer once', () => {
  const result = silk(h, ['run', '--quiet'], { cwd: project() })
  assert.equal(result.status, 0, show(result))
  assert.equal(result.stderr.match(/^drop withdraw$/gm)?.length, 5, show(result))
  assert.match(result.stderr, /^finalizer\ndone\n/m, show(result))
})

const privateField = () => project(main, bank.replace('Missing { pub id: i32 }', 'Missing { id: i32 }'))

test('binding a private variant field from another module is SEM0028', () => {
  const result = silk(h, ['check'], { cwd: privateField() })
  assert.match(result.stderr, /error\[SEM0028\]/, show(result))
})

// Finding 170, fixed by #2410.
test('the SEM0028 message for a pattern names the variant field and the fix', () => {
  const result = silk(h, ['check'], { cwd: privateField() })
  assert.match(result.stderr, /SEM0028\] Pattern names private field `id` of variant `Missing`; skip it with `\.\.`, or mark it `pub id` to use it outside its module/, show(result))
})

// Finding 170, fixed by #2410: a catchAll handler whose parameter accepts more than the remaining
// failures gets SEM0067 naming both types. Accepting it is pending a decision.
const wider = main.replace('Effect.catchAll(onFrozen)', 'Effect.catchAll(onAny)')

test('a catchAll handler that also accepts an already handled failure gets SEM0067 with both types', () => {
  const result = silk(h, ['check'], { cwd: project(wider) })
  assert.notEqual(result.status, 0, show(result))
  assert.match(result.stderr, /error\[SEM0067\][^\n]*Overdrawn[^\n]*Frozen|error\[SEM0067\][^\n]*Frozen[^\n]*Overdrawn/, show(result))
})

test('the same handler outside a pipeline gets a coded error, not an unsupported construct', () => {
  const result = silk(h, ['check'], { cwd: project(wider.replace('let d = run Effect.catch(twice(50), onShort) |> Effect.catchAll(onAny)', 'let caught = Effect.catch(twice(50), onShort)\n  let d = run Effect.catchAll(move caught, onAny)')) })
  assert.doesNotMatch(result.stderr, /unsupported: this construct is not supported/, show(result))
  assert.match(result.stderr, /error\[SEM0067\]/, show(result))
})
