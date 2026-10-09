import * as AnalysisFixture from './support/AnalysisFixture.js'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Analysis from '../src/Analysis.js'
import * as Instances from '../src/Instances.js'
import * as SuspensionMode from '../src/SuspensionMode.js'
import { unreachable } from './support/raise.js'

/** Mutation callbacks cannot return a retained value borrow or park while holding one. */
const ascii = (value: string): Uint8Array =>
  Uint8Array.from(value, (character) => character.charCodeAt(0))
const analyzed = (name: string, source: string) =>
  AnalysisFixture.retainingMain(name, ascii(source))
const imports = `import silk.hash { Hash, Word }
import silk.hash_map { HashMap }`

const codesOf = (snapshot: Analysis.Snapshot): ReadonlyArray<string> =>
  Analysis.diagnostics(snapshot).map((diagnostic) => diagnostic.code)

it.effect('rejects a value borrow returned from the mutation callback', () =>
  Effect.gen(function* () {
    const source = `${imports}
struct Box { value: i32 }
fn expose(value: &mut Box) -> &mut Box { return move value }
fn escaped(map: &mut HashMap<Word, Box>, key: Word) -> bool {
  return HashMap.withMut(move map, move key, expose)
}
pub fn main() -> i32 { return 0 }`
    const snapshot = yield* analyzed('hashed-ownership/callback-escape', source)
    const diagnostics = Analysis.diagnostics(snapshot)
    assert.deepEqual(codesOf(snapshot), ['SEM0052'])
    const reason = (diagnostics.at(0) ?? unreachable('expected one diagnostic')).reason
    assert.strictEqual(reason._tag, 'TypeArgumentInference')
    if (reason._tag !== 'TypeArgumentInference') return
    assert.strictEqual(reason.target, 'HashMap.withMut')
  }),
)

it.effect('rejects a callback that parks while holding the value borrow', () =>
  Effect.gen(function* () {
    const source = `${imports}
import silk.execution { Execution, Wake }
struct Guard {}
struct Box { value: i32 }
fn register(wake: Wake) -> Guard { drop wake return Guard {} }
fn parking(value: &mut Box) -> () {
  let parked = run Execution.park(register)
  value.value = value.value
  return ()
}
pub fn main() -> i32 {
  let mut map = HashMap.make<Word, Box>(Hash.seed(9))
  let attempted = HashMap.withMut(&mut map, Hash.word(1), parking)
  drop attempted
  return 0
}
`
    const snapshot = yield* analyzed('hashed-ownership/callback-parking', source)
    const diagnostics = Analysis.diagnostics(snapshot)
    assert.deepEqual(codesOf(snapshot), ['SEM0139'])
    const reason = (
      diagnostics.find((diagnostic) => diagnostic.code === 'SEM0139') ??
      unreachable('expected the callback property diagnostic')
    ).reason
    assert.strictEqual(reason._tag, 'UnsatisfiedExecutableProperty')
    if (reason._tag !== 'UnsatisfiedExecutableProperty') return
    assert.strictEqual(reason.property, 'Intrinsic.NonParking')
    const discovery = Analysis.instancesOf(snapshot)
    const parking =
      discovery.instances.find((instance) => instance.key.declaration.name === 'parking') ??
      unreachable('expected the selected parking callback to be discovered')
    assert.isTrue(
      SuspensionMode.has(Instances.suspensionOf(discovery, parking.key), 'ExternalPark'),
    )
  }),
)
