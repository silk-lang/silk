import * as AnalysisFixture from './support/AnalysisFixture.js'
import { assert, it } from '@effect/vitest'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Analysis from '../src/Analysis.js'
import * as CoroutineFrame from '../src/CoroutineFrame.js'
import * as Instances from '../src/Instances.js'
import * as Mir from '../src/Mir.js'
import * as MirEncoding from '../src/MirEncoding.js'
import * as MirVerification from '../src/MirVerification.js'
import * as Layout from '../src/Layout.js'
import * as NativeType from '../src/NativeType.js'
import * as ValueStorage from '../src/ValueStorage.js'
import { unreachable } from './support/raise.js'

const encoder = new TextEncoder()

const suspended = `import silk.effect { Effect }
effect fn delayed(value: i32) -> i32 {
  return run Effect.suspend(effect { return value })
}
effect fn program() -> i32 {
  let left = run delayed(40)
  let right = run delayed(2)
  return left + right
}
pub fn main() -> i32 { return run program() }`

const analyze = (source = suspended) =>
  AnalysisFixture.retainingMain(
    'coroutine-frame/main',
    encoder.encode(source),
    'wasm32-unknown-unknown',
  )

/** One realization of the default suspended program, shared by the tests that inspect it. */
const Suspended = Context.Service<Analysis.Snapshot>('CoroutineFrame/suspended')

it.effect('reserves canonical outcome padding when planning retained payloads', () =>
  Effect.gen(function* () {
    const snapshot = yield* analyze(`import silk.effect { Effect }
struct Padded { first: u8 wide: i64 last: u8 }
effect fn values() -> [Padded; 2] {
  return [Padded { first: 1, wide: 2, last: 3 }, Padded { first: 4, wide: 5, last: 6 }]
}
pub fn main() -> i32 {
  let payload = run values()
  let resumed = run Effect.suspend(effect { return 42 })
  drop payload
  return resumed
}`)
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    const program = Analysis.loweredMir(snapshot)
    const result = program.functions.find((fn) => fn.id.name.startsWith('values$effect$'))?.result
    if (result?._tag !== 'EffectOutcome') return unreachable('expected an outcome')
    const slot =
      program.functions
        .flatMap((fn) => fn.suspension?.frame?.states.flatMap((state) => state.slots) ?? [])
        .at(0) ?? unreachable('expected a retained slot')
    const stored = ValueStorage.outcome(program.layout, result.type)
    const payload =
      Layout.entry(program.layout, result.type.success) ?? unreachable('expected array layout')
    assert.isAtLeast(stored.size, stored.payloadOffset + payload.size)
    assert.deepEqual(
      CoroutineFrame.storageOf(program, { ...slot, type: result }),
      NativeType.addressLayout(program.layout, result),
    )
  }),
)

it.layer(Layer.effect(Suspended, analyze()))((it) => {
  it.effect('plans one maximum frame per specialized invocation', () =>
    Effect.gen(function* () {
      const self = yield* Suspended
      const mir = Analysis.loweredMir(self)
      assert.deepEqual(Analysis.diagnostics(self), [])
      assert.deepEqual(yield* MirVerification.verify(mir), [])
      assert.isDefined(mir.coroutineFrames)
      if (mir.coroutineFrames === undefined) return

      const descriptors = mir.functions.flatMap((fn) =>
        fn.suspension?.frame === undefined ? [] : [fn.suspension.frame],
      )
      assert.lengthOf(mir.coroutineFrames.entries, descriptors.length)
      for (const descriptor of descriptors) {
        const entry: Mir.CoroutineFrameTargetLayout | undefined = mir.coroutineFrames.entries.find(
          (candidate) =>
            Instances.keyText(candidate.function) === Instances.keyText(descriptor.function),
        )
        assert.isDefined(entry)
        if (entry === undefined) continue
        assert.deepEqual(
          entry.header.map((field) => field.role),
          ['Parent', 'State'],
        )
        assert.deepEqual(
          entry.header.map((field) => field.offset),
          [0, 4],
        )
        assert.lengthOf(entry.states, descriptor.states.length)
        assert.strictEqual(entry.size % entry.alignment, 0)
        assert.isAtLeast(entry.size, Math.max(...entry.states.map((state) => state.size)))
        for (const state of entry.states) {
          assert.strictEqual(state.size % state.alignment, 0)
          assert.deepEqual(
            state.payload.map((field) => field.slot),
            state.payload.map((_field, ordinal) => ordinal),
          )
        }
      }
      assert.notInclude(MirEncoding.encode(mir), 'Allocator')
      assert.notInclude(CoroutineFrame.summary(mir.coroutineFrames), 'allocator')
    }),
  )

  it.effect('uses distinct resume states in one reusable invocation frame', () =>
    Effect.gen(function* () {
      const self = yield* Suspended
      const program = Analysis.loweredMir(self)
      assert.deepEqual(Analysis.diagnostics(self), [])
      assert.deepEqual(yield* MirVerification.verify(program), [])
      const owner = program.functions.find((fn) => fn.id.name.startsWith('program$effect$'))
      const descriptor = owner?.suspension?.frame
      assert.isDefined(descriptor)
      if (descriptor === undefined) return
      assert.isAtLeast(descriptor.states.length, 2)
      const frame = program.coroutineFrames?.entries.find(
        (entry) => Instances.keyText(entry.function) === Instances.keyText(descriptor.function),
      )
      assert.isDefined(frame)
      assert.lengthOf(frame?.states ?? [], descriptor.states.length)
      assert.strictEqual(
        new Set(descriptor.states.map((state) => state.point.ordinal)).size,
        descriptor.states.length,
      )
    }),
  )

  it.effect('rejects missing, stale, and physically incomplete frame plans', () =>
    Effect.gen(function* () {
      const self = yield* Suspended
      const program = Analysis.loweredMir(self)
      const plan = program.coroutineFrames
      assert.isDefined(plan)
      if (plan === undefined) return
      const { coroutineFrames: _coroutineFrames, ...logicalProgram } = program
      const withoutPlan: Mir.Module = Object.freeze(logicalProgram)
      assert.isTrue(
        (yield* MirVerification.verify(withoutPlan)).some(
          (violation) => violation.rule === 'InvalidCoroutineFrame',
        ),
      )
      const first = plan.entries.at(0)
      const firstState = first?.states.at(0)
      assert.isDefined(first)
      assert.isDefined(firstState)
      if (first === undefined || firstState === undefined) return
      const malformed: Mir.Module = Object.freeze({
        ...program,
        coroutineFrames: Object.freeze({
          ...plan,
          entries: Object.freeze([
            Object.freeze({
              ...first,
              states: Object.freeze([
                Object.freeze({ ...firstState, size: firstState.size + firstState.alignment }),
                ...first.states.slice(1),
              ]),
            }),
            ...plan.entries.slice(1),
          ]),
        }),
      })
      assert.isTrue(
        (yield* MirVerification.verify(malformed)).some(
          (violation) => violation.rule === 'InvalidCoroutineFrame',
        ),
      )
      const stale: Mir.Module = Object.freeze({
        ...program,
        coroutineFrames: Object.freeze({
          ...plan,
          entries: Object.freeze([...plan.entries, first]),
        }),
      })
      assert.isTrue(
        (yield* MirVerification.verify(stale)).some(
          (violation) => violation.rule === 'InvalidCoroutineFrame',
        ),
      )
    }),
  )
})

it.effect('keeps synchronous MIR free of coroutine-frame storage', () =>
  Effect.gen(function* () {
    const self = yield* analyze(
      'effect fn seed(value: i32) -> i32 { return value } pub fn main() -> i32 { return run seed(42) }',
    )
    const program = Analysis.loweredMir(self)
    assert.deepEqual(Analysis.diagnostics(self), [])
    assert.deepEqual(yield* MirVerification.verify(program), [])
    assert.isUndefined(program.coroutineFrames)
    assert.notInclude(MirEncoding.encode(program), 'coroutine-frame ')
  }),
)

it.effect('keeps borrowed local addresses stable across changing live sets', () =>
  Effect.gen(function* () {
    const self = yield* analyze(`import silk.effect { Effect }
effect fn delayed(value: &i32) -> i32 {
  return run Effect.suspend(effect { return value.* })
}
effect fn program() -> i32 {
  let prefix = 40
  let value = 1
  let first = run delayed(&value)
  let total = prefix + first
  let second = run delayed(&value)
  return total + second
}
pub fn main() -> i32 { return run program() }`)
    assert.deepEqual(Analysis.diagnostics(self), [])
    assert.deepEqual(yield* MirVerification.verify(Analysis.loweredMir(self)), [])
    const program = Analysis.loweredMir(self)
    const owner = program.functions.find((fn) => fn.id.name.startsWith('program$effect$'))
    assert.isDefined(owner)
    if (owner === undefined) return
    const frame = program.coroutineFrames?.entries.find(
      (entry) => Instances.keyText(entry.function) === Instances.keyText(owner.instance),
    )
    assert.isDefined(frame)
    if (frame === undefined) return
    const borrowedRoots = owner.regions
      .flatMap(Mir.operationsOf)
      .flatMap(Mir.operationTree)
      .flatMap((operation) => (operation._tag === 'BeginLoan' ? [operation.root.ordinal] : []))
    const retained = [...new Set(borrowedRoots)]
      .map((local) =>
        frame.states.flatMap((state) =>
          state.payload.filter((field) => field.local.ordinal === local),
        ),
      )
      .filter((fields) => fields.length > 1)
    assert.isNotEmpty(retained)
    for (const fields of retained)
      assert.strictEqual(new Set(fields.map((field) => field.offset)).size, 1)
  }),
)
