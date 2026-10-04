import * as AnalysisFixture from './support/AnalysisFixture.js'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Analysis from '../src/Analysis.js'
import type * as CleanupPlan from '../src/CleanupPlan.js'
import * as Layout from '../src/Layout.js'
import * as LayoutEncode from '../src/LayoutEncode.js'
import * as Lower from '../src/Lower.js'
import type * as Mir from '../src/Mir.js'
import * as MirVerification from '../src/MirVerification.js'
import * as OpaqueRealization from '../src/OpaqueRealization.js'
import * as Target from '../src/Target.js'
import * as Type from '../src/Type.js'
import * as SemanticContext from '../src/SemanticContext.js'
import { unreachable } from './support/raise.js'

const ascii = (value: string): Uint8Array =>
  Uint8Array.from(value, (character) => character.charCodeAt(0))

const lowerStored = Effect.fnUntraced(function* (name: string, source: string) {
  const snapshot = yield* AnalysisFixture.retainingMain(
    name,
    ascii(source),
    Target.wasm32UnknownUnknown.id,
  )
  assert.deepEqual(Analysis.diagnostics(snapshot), [])
  const catalog = yield* Layout.computeTypes(
    Target.wasm32UnknownUnknown,
    snapshot.index,
    snapshot.resolution.contexts,
  )
  const layout = yield* Layout.computeRuntime(catalog, snapshot.instances, snapshot.index)
  const lowered = Lower.lowerProgram(
    snapshot.instances,
    layout,
    snapshot.index,
    OpaqueRealization.catalogOf(snapshot),
    SemanticContext.fromModules(snapshot.results.values()),
  )
  assert.deepEqual(lowered.diagnostics, [])
  return Object.freeze({ catalog, module: lowered.program })
})

const replaceDrop = (
  module: Mir.Module,
  target: Extract<Mir.Operation, { readonly _tag: 'Drop' }>,
  replacement: Extract<Mir.Operation, { readonly _tag: 'Drop' }>,
): Mir.Module =>
  Object.freeze({
    ...module,
    functions: Object.freeze(
      module.functions.map((fn) =>
        Object.freeze({
          ...fn,
          regions: Object.freeze(
            fn.regions.map((region) => {
              if (region._tag === 'OperationRegion') {
                return Object.freeze({
                  ...region,
                  operations: Object.freeze(
                    region.operations.map((operation) =>
                      operation === target ? replacement : operation,
                    ),
                  ),
                })
              }
              if (region._tag === 'CleanupRegion') {
                return Object.freeze({
                  ...region,
                  releases: Object.freeze(
                    region.releases.map((operation) =>
                      operation === target ? replacement : operation,
                    ),
                  ),
                })
              }
              return region
            }),
          ),
        }),
      ),
    ),
  })

it.effect('rejects incomplete cleanup inside nested Effect and callable captures', () =>
  Effect.gen(function* () {
    const { catalog, module } = yield* lowerStored(
      'stored-effect-cleanup-verification/nested-executables',
      `struct Token<F: once fn<'static>(i32) -> i32> { value: i32 marker: F }
struct Deferred<F: once Effect<'static; i32>> { operation: F }
fn marker(value: i32) -> i32 { return value }
fn consume<F: once fn<'static>(i32) -> i32>(value: i32, token: Token<F>) -> i32 {
  return value + token.value
}
impl<F: once fn<'static>(i32) -> i32> Drop for Token<F> {
  fn drop(self: &mut Token<F>) -> () { return () }
}
pub fn main() -> i32 {
  let effectToken = Token { value: 1, marker: marker }
  let nested = effect { return consume(1, move effectToken) }
  let callableToken = Token { value: 2, marker: marker }
  let transform = consume(move callableToken)
  let deferred = Deferred { operation: effect {
    let value = run move nested
    let ownedTransform = move transform
    return ownedTransform(value)
  } }
  return 0
}`,
    )
    assert.deepEqual(yield* MirVerification.verify(module), [])
    const construct = module.functions
      .flatMap(MirVerification.operations)
      .find(
        (operation) =>
          operation._tag === 'Construct' &&
          operation.fields.some((field) => field.stored?._tag === 'StoredEffectField'),
      )
    const stored =
      construct?._tag === 'Construct'
        ? construct.fields.find((field) => field.stored?._tag === 'StoredEffectField')?.stored
        : undefined
    assert.strictEqual(stored?._tag, 'StoredEffectField')
    if (stored?._tag !== 'StoredEffectField') return
    assert.deepEqual(
      stored.realization.environment.map((field) => ({
        access: field.access,
        effect: field.effectIdentity !== undefined,
        callable: field.callableIdentity !== undefined,
      })),
      [
        { access: 'Take', effect: true, callable: false },
        { access: 'Take', effect: false, callable: true },
      ],
    )
    const drop = module.functions.flatMap(MirVerification.operations).find(
      (
        operation,
      ): operation is Extract<
        Mir.Operation,
        {
          readonly _tag: 'Drop'
        }
      > =>
        operation._tag === 'Drop' &&
        operation.cleanup._tag === 'StructCleanup' &&
        operation.cleanup.fields.some((field) => field.cleanup._tag === 'EffectCleanup'),
    )
    assert.isDefined(drop)
    if (drop === undefined || drop.cleanup._tag !== 'StructCleanup') return
    const structCleanup = drop.cleanup
    const outerField = structCleanup.fields.find((field) => field.cleanup._tag === 'EffectCleanup')
    assert.strictEqual(outerField?.cleanup._tag, 'EffectCleanup')
    if (outerField?.cleanup._tag !== 'EffectCleanup') return
    const outer = outerField.cleanup
    assert.deepEqual(
      outer.slots.map((slot) => slot.cleanup._tag),
      ['CallableCleanup', 'EffectCleanup'],
    )
    const effectSlot = outer.slots.find((slot) => slot.cleanup._tag === 'EffectCleanup')
    const callableSlot = outer.slots.find((slot) => slot.cleanup._tag === 'CallableCleanup')
    assert.strictEqual(effectSlot?.cleanup._tag, 'EffectCleanup')
    assert.strictEqual(callableSlot?.cleanup._tag, 'CallableCleanup')
    if (
      effectSlot?.cleanup._tag !== 'EffectCleanup' ||
      callableSlot?.cleanup._tag !== 'CallableCleanup'
    )
      return

    const replaceOuter = (
      cleanup: CleanupPlan.CleanupPlan,
      selected: CleanupPlan.CleanupPlan,
    ): Extract<
      Mir.Operation,
      {
        readonly _tag: 'Drop'
      }
    > =>
      Object.freeze({
        ...drop,
        cleanup: Object.freeze({
          ...structCleanup,
          fields: Object.freeze(
            structCleanup.fields.map((field) => {
              if (field !== outerField) return field
              return Object.freeze({
                ...field,
                cleanup: Object.freeze({
                  ...outer,
                  slots: Object.freeze(
                    outer.slots.map((slot) =>
                      slot.cleanup === selected ? Object.freeze({ ...slot, cleanup }) : slot,
                    ),
                  ),
                }),
              })
            }),
          ),
        }),
      })

    const nestedEffectSlot =
      effectSlot.cleanup.slots.at(0) ?? unreachable('expected nested Effect cleanup slot')
    assert.strictEqual(nestedEffectSlot.cleanup._tag, 'HookCleanup')
    if (nestedEffectSlot.cleanup._tag !== 'HookCleanup') return
    const hookedEntry = module.layout.entries.find(
      (entry): entry is Layout.Entry =>
        entry._tag === 'LayoutEntry' &&
        entry.representation._tag === 'Aggregate' &&
        entry.representation.cleanupHook !== undefined,
    )
    assert.isDefined(hookedEntry)
    if (hookedEntry === undefined || hookedEntry.representation._tag !== 'Aggregate') return
    assert.isUndefined(Layout.catalogEntry(catalog, hookedEntry.type))
    assert.include(LayoutEncode.encode(module.layout), 'cleanup-hook=')
    const strippedHook: CleanupPlan.CleanupPlan = Object.freeze({
      ...effectSlot.cleanup,
      slots: Object.freeze([
        Object.freeze({ ...nestedEffectSlot, cleanup: nestedEffectSlot.cleanup.inner }),
      ]),
    })
    const malformed: ReadonlyArray<readonly [CleanupPlan.CleanupPlan, CleanupPlan.CleanupPlan]> = [
      [Object.freeze({ _tag: 'NoCleanup', type: effectSlot.cleanup.type }), effectSlot.cleanup],
      [strippedHook, effectSlot.cleanup],
      [
        Object.freeze({
          ...effectSlot.cleanup,
          slots: Object.freeze([
            Object.freeze({
              ...nestedEffectSlot,
              laneOffset: nestedEffectSlot.laneOffset + 1,
            }),
          ]),
        }),
        effectSlot.cleanup,
      ],
      [Object.freeze({ _tag: 'NoCleanup', type: callableSlot.cleanup.type }), callableSlot.cleanup],
      [Object.freeze({ ...callableSlot.cleanup, slots: Object.freeze([]) }), callableSlot.cleanup],
      [
        Object.freeze({
          ...callableSlot.cleanup,
          type: Type.callable(
            callableSlot.cleanup.type.parameters,
            'i64',
            callableSlot.cleanup.type,
            callableSlot.cleanup.type.mode,
            callableSlot.cleanup.type.schema,
            callableSlot.cleanup.type.unsafe,
          ),
        }),
        callableSlot.cleanup,
      ],
    ]
    for (const [cleanup, selected] of malformed) {
      assert.include(
        (yield* MirVerification.verify(
          replaceDrop(module, drop, replaceOuter(cleanup, selected)),
        )).map((violation) => violation.rule),
        'InvalidAggregateOperation',
      )
    }
  }),
)
