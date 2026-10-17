import * as AnalysisFixture from './support/AnalysisFixture.js'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Analysis from '../src/Analysis.js'
import * as MirVerification from '../src/MirVerification.js'
import type * as Mir from '../src/Mir.js'

const ascii = (value: string): Uint8Array =>
  Uint8Array.from(value, (character) => character.charCodeAt(0))

it.effect('rejects invalid replace places with assignment diagnostics', () =>
  Effect.gen(function* () {
    const immutable = yield* AnalysisFixture.retainingMain(
      'place-replace/immutable',
      ascii(`pub fn main() -> i32 {
  let value = 1
  let old = Intrinsic.replace(value, 2)
  return old
}`),
    )
    assert.include(
      Analysis.diagnostics(immutable).map((diagnostic) => diagnostic.code),
      'SEM0035',
    )

    const sharedRoot = yield* AnalysisFixture.retainingMain(
      'place-replace/shared',
      ascii(`struct Counter {
  value: i32
}
fn peek(self: &Counter) -> i32 {
  let old = Intrinsic.replace(self.value, 2)
  return old
}
pub fn main() -> i32 { return 0 }`),
    )
    assert.include(
      Analysis.diagnostics(sharedRoot).map((diagnostic) => diagnostic.code),
      'SEM0036',
    )

    const missingRoot = yield* AnalysisFixture.retainingMain(
      'place-replace/missing',
      ascii(`pub fn main() -> i32 {
  let old = Intrinsic.replace(missing, 2)
  return old
}`),
    )
    assert.deepEqual(
      Analysis.diagnostics(missingRoot).map((diagnostic) => diagnostic.code),
      ['SEM0006'],
    )

    const arity = yield* AnalysisFixture.retainingMain(
      'place-replace/arity',
      ascii(`pub fn main() -> i32 {
  let mut value = 1
  let old = Intrinsic.replace(value)
  return old
}`),
    )
    assert.include(
      Analysis.diagnostics(arity).map((diagnostic) => diagnostic.code),
      'SEM0007',
    )
  }),
)

it.effect('writes through a match &mut binding and keeps a nested place binding read-only', () =>
  Effect.gen(function* () {
    const writes = yield* AnalysisFixture.retainingMain(
      'place-replace/exclusive-binding',
      ascii(`struct Token { value: i32 }
union Packet { Empty, Ready { left: Token, right: Token } }
pub fn main() -> i32 {
  let mut packet = Packet.Ready { left: Token { value: 1 }, right: Token { value: 2 } }
  let mut seen = 0
  match &mut packet {
    Packet.Ready { left, right } => {
      left = Token { value: 4 }
      right.value = 5
      let displaced = Intrinsic.replace(left, Token { value: 6 })
      seen = displaced.value
    }
    Packet.Empty => {}
  }
  return seen
}`),
    )
    assert.deepEqual(Analysis.diagnostics(writes), [])
    assert.deepEqual(yield* MirVerification.verify(Analysis.loweredMir(writes)), [])

    const nested = yield* AnalysisFixture.retainingMain(
      'place-replace/exclusive-nested-place',
      ascii(`struct Token { value: i32 }
union Packet { Empty, Ready { left: Token, right: Token } }
struct Holder {
  packet: Packet
  n: i32
}
union Slot { Vacant, Filled { holder: Holder } }
pub fn main() -> i32 {
  let mut slot = Slot.Filled { holder: Holder { packet: Packet.Empty, n: 0 } }
  match &mut slot {
    Slot.Filled { holder } => {
      match place holder.packet {
        Packet.Ready { left, .. } => { left.value = 5 }
        Packet.Empty => {}
      }
    }
    Slot.Vacant => {}
  }
  return 0
}`),
    )
    assert.deepEqual(
      Analysis.diagnostics(nested).map((diagnostic) => diagnostic.code),
      ['SEM0035'],
    )
  }),
)

it.effect('validates replacement cleanup of a lifetime-bearing union field', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'place-replace/borrowed-union',
      ascii(`union Choice<'a> {
  Empty,
  Full { text: string<'a> },
}
struct Holder<'a> { value: Choice<'a> }
fn make<'a>() -> Holder<'a> { return Holder<'a> { value: Choice<'a>.Empty } }
pub fn main() -> i32 {
  let mut holder = make<'static>()
  holder.value = Choice<'static>.Full { text: "hello" }
  return 42
}`),
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    const mir = Analysis.loweredMir(snapshot)
    assert.deepEqual(yield* MirVerification.verify(mir), [])
    const invalid: Mir.Module = {
      ...mir,
      functions: mir.functions.map((fn) => ({
        ...fn,
        regions: fn.regions.map((region) =>
          region._tag !== 'OperationRegion'
            ? region
            : {
                ...region,
                operations: region.operations.map((operation) =>
                  operation._tag !== 'Drop'
                    ? operation
                    : {
                        ...operation,
                        cleanup: { _tag: 'NoCleanup' as const, type: 'i32' as const },
                      },
                ),
              },
        ),
      })),
    }
    assert.include(
      (yield* MirVerification.verify(invalid)).map((violation) => violation.rule),
      'InvalidAggregateOperation',
    )
  }),
)
