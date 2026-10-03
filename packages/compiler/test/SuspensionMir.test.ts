import * as AnalysisFixture from './support/AnalysisFixture.js'
import { assert, it } from '@effect/vitest'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Analysis from '../src/Analysis.js'
import type * as Mir from '../src/Mir.js'
import * as MirEncoding from '../src/MirEncoding.js'
import * as MirVerification from '../src/MirVerification.js'
import * as SuspensionMir from '../src/SuspensionMir.js'
import { ownedAllocatorSuspensionFailure } from './support/ownedAllocatorSuspension.js'

const encoder = new TextEncoder()

const source = `import silk.effect { Effect }
effect fn delayed() -> i32 {
  return run Effect.suspend(effect { return 2 })
}
effect fn program() -> i32 {
  return 40 + run delayed()
}
pub fn main() -> i32 { return run program() }`

const snapshot = (input = source) =>
  AnalysisFixture.retainingMain(
    'suspension-mir/main',
    encoder.encode(input),
    'wasm32-unknown-unknown',
  )

/** One realization of the default suspended program, shared by the tests that inspect it. */
const Suspended = Context.Service<Analysis.Snapshot>('SuspensionMir/suspended')

const suspensionRegions = (program: Mir.Module): ReadonlyArray<Mir.SuspensionRegion> =>
  program.functions.flatMap((fn) => fn.suspension?.regions ?? [])

const stateful = (
  program: Mir.Module,
): readonly [
  Mir.MirFunction,
  Extract<Mir.SuspensionRegion, { _tag: 'RunSuspendableEffectRegion' }>,
] => {
  for (const fn of program.functions)
    for (const region of fn.suspension?.regions ?? [])
      if (
        fn.id.name.startsWith('program$effect$') &&
        region._tag === 'RunSuspendableEffectRegion' &&
        region.relay.state !== undefined
      )
        return [fn, region]
  throw new RangeError(SuspensionMir.summary(program))
}

const replaceSuspensionRegion = (
  program: Mir.Module,
  owner: Mir.MirFunction,
  previous: Mir.SuspensionRegion,
  next: Mir.SuspensionRegion,
): Mir.Module =>
  Object.freeze({
    ...program,
    functions: Object.freeze(
      program.functions.map((fn) => {
        if (fn !== owner || fn.suspension === undefined) return fn
        return Object.freeze({
          ...fn,
          suspension: Object.freeze({
            ...fn.suspension,
            regions: Object.freeze(
              fn.suspension.regions.map((region) => (region === previous ? next : region)),
            ),
          }),
        })
      }),
    ),
  })
const hasRule = Effect.fnUntraced(function* (
  program: Mir.Module,
  rule: Mir.Violation['rule'],
): Effect.fn.Return<boolean> {
  return (yield* MirVerification.verify(program)).some((violation) => violation.rule === rule)
})

it.effect('keeps synchronous recovery out of its protected recipe suspension regions', () =>
  Effect.gen(function* () {
    const self = yield* snapshot(ownedAllocatorSuspensionFailure)
    assert.deepEqual(Analysis.diagnostics(self), [])
    const program = Analysis.loweredMir(self)
    assert.deepEqual(yield* MirVerification.verify(program), [])
    const regions = suspensionRegions(program)
    assert.isTrue(regions.some((region) => region._tag === 'SuspendEffectRegion'))
    assert.isFalse(
      regions.some(
        (region) =>
          region._tag === 'RunSuspendableEffectRegion' &&
          region.runner.declaration?.module === 'suspension-mir/main' &&
          region.runner.declaration.name === 'recover$effect$-1',
      ),
    )
  }),
)

it.layer(Layer.effect(Suspended, snapshot()))((it) => {
  it.effect('finalizes target-neutral origin, relay, resume, and logical layout facts', () =>
    Effect.gen(function* () {
      const self = yield* Suspended
      assert.deepEqual(Analysis.diagnostics(self), [])
      const mir = Analysis.loweredMir(self)
      assert.deepEqual(yield* MirVerification.verify(mir), [], SuspensionMir.summary(mir))
      // A conservative discovery result for a synchronous constructor must not acquire a
      // transfer ABI merely because a separate retained runner originates suspension.
      const constructor = mir.functions.find((fn) => fn.id.name === 'program')
      assert.isDefined(constructor)
      if (constructor === undefined) return
      assert.isUndefined(constructor.suspension)
      const conservative = SuspensionMir.finalize(
        mir,
        {
          _tag: 'ProvisionalMirModule',
          module: 'suspension-mir/main',
          executions: [
            {
              _tag: 'ProvisionalExecution',
              classification: 'Unknown',
              regions: [],
              key: {
                _tag: 'InstanceExecution',
                instance: constructor.instance,
                functionOrdinal: 0,
                identity: 'conservative-constructor',
              },
            },
          ],
        },
        {
          _tag: 'SuspensionOwnershipModule',
          module: 'suspension-mir/main',
          plans: [],
          executionPackages: [],
          violations: [],
        },
        self.index,
      )
      assert.isUndefined(conservative.functions.find((fn) => fn.id === constructor.id)?.suspension)
      assert.isTrue(
        suspensionRegions(conservative).some((region) => region._tag === 'SuspendEffectRegion'),
      )
      const regions = suspensionRegions(mir)
      assert.lengthOf(
        regions.filter((region) => region._tag === 'SuspendEffectRegion'),
        1,
      )
      assert.isAtLeast(
        regions.filter((region) => region._tag === 'RunSuspendableEffectRegion').length,
        1,
      )
      const [, relay] = stateful(mir)
      assert.deepEqual(relay.relay.preserves, ['Child', 'Origin', 'TypedOutcome'])
      assert.strictEqual(relay.complete._tag, 'CompleteInCurrentActivation')
      assert.strictEqual(relay.relay.frame, 'StatefulRelay')
      assert.isDefined(relay.relay.state)
      assert.deepEqual(
        relay.relay.state?.slots.map((slot) => slot.local.ordinal),
        relay.liveLocals.map((local) => local.ordinal),
      )
    }),
  )

  it.effect(
    'rejects malformed logical layouts, resumes, runner contracts, and orphan machinery',
    () =>
      Effect.gen(function* () {
        const self = yield* Suspended
        const program = Analysis.loweredMir(self)
        const [owner, relay] = stateful(program)
        const descriptor = relay.relay.state
        assert.isDefined(descriptor)
        if (descriptor === undefined) return

        const omitted = Object.freeze({
          ...relay,
          relay: Object.freeze({
            ...relay.relay,
            state: Object.freeze({
              ...descriptor,
              slots: Object.freeze(descriptor.slots.slice(1)),
            }),
          }),
        })
        assert.isTrue(
          yield* hasRule(
            replaceSuspensionRegion(program, owner, relay, omitted),
            'InvalidCoroutineFrame',
          ),
        )

        const firstSlot = descriptor.slots.at(0)
        if (firstSlot !== undefined) {
          const incompatibleAccess = Object.freeze({
            ...relay,
            relay: Object.freeze({
              ...relay.relay,
              state: Object.freeze({
                ...descriptor,
                slots: Object.freeze([
                  Object.freeze({
                    ...firstSlot,
                    type: Object.freeze({
                      _tag: firstSlot.type._tag === 'bool' ? 'i32' : 'bool',
                    }),
                  }),
                  ...descriptor.slots.slice(1),
                ]),
              }),
            }),
          })
          assert.isTrue(
            yield* hasRule(
              replaceSuspensionRegion(program, owner, relay, incompatibleAccess),
              'InvalidCoroutineFrame',
            ),
          )
        }

        const duplicate = Object.freeze({
          ...relay,
          liveLocals: Object.freeze([...relay.liveLocals, ...relay.liveLocals.slice(0, 1)]),
        })
        assert.isTrue(
          yield* hasRule(
            replaceSuspensionRegion(program, owner, relay, duplicate),
            'InvalidCoroutineFrame',
          ),
        )

        const undeclared = Object.freeze({
          ...relay,
          liveLocals: Object.freeze([
            ...relay.liveLocals,
            Object.freeze({ _tag: 'Local' as const, ordinal: owner.localTypes.length }),
          ]),
        })
        assert.isTrue(
          yield* hasRule(
            replaceSuspensionRegion(program, owner, relay, undeclared),
            'InvalidCoroutineFrame',
          ),
        )

        const badResume = Object.freeze({
          ...relay,
          relay: Object.freeze({
            ...relay.relay,
            state: Object.freeze({
              ...descriptor,
              success: Object.freeze({
                ...descriptor.success,
                resume: Object.freeze({ ...descriptor.success.resume, path: 'Failure' as const }),
              }),
            }),
          }),
        })
        assert.isTrue(
          yield* hasRule(
            replaceSuspensionRegion(program, owner, relay, badResume),
            'InvalidCoroutineFrame',
          ),
        )

        const badRunner = Object.freeze({
          ...relay,
          runner: Object.freeze({ ...relay.runner, classification: 'Synchronous' as const }),
        })
        assert.isTrue(
          yield* hasRule(
            replaceSuspensionRegion(program, owner, relay, badRunner),
            'InvalidSuspension',
          ),
        )

        const badOutcome = Object.freeze({
          ...relay,
          runner: Object.freeze({
            ...relay.runner,
            outcome: Object.freeze({ ...relay.runner.outcome, success: 'bool' as const }),
          }),
        })
        assert.isTrue(
          yield* hasRule(
            replaceSuspensionRegion(program, owner, relay, badOutcome),
            'InvalidSuspension',
          ),
        )

        const differentOwner = program.functions.find((fn) => fn !== owner)
        assert.isDefined(differentOwner)
        if (differentOwner !== undefined) {
          const badIdentity = Object.freeze({
            ...relay,
            point: Object.freeze({ ...relay.point, owner: differentOwner.instance }),
          })
          assert.isTrue(
            yield* hasRule(
              replaceSuspensionRegion(program, owner, relay, badIdentity),
              'InvalidSuspension',
            ),
          )
        }

        const noDescriptor = Object.freeze({
          ...relay,
          relay: Object.freeze({
            _tag: 'RelayExistingTransfer' as const,
            preserves: relay.relay.preserves,
            frame: 'StatefulRelay' as const,
          }),
        })
        assert.isTrue(
          yield* hasRule(
            replaceSuspensionRegion(program, owner, relay, noDescriptor),
            'InvalidCoroutineFrame',
          ),
        )

        const orphan: Mir.Module = Object.freeze({
          ...program,
          functions: Object.freeze(
            program.functions.map((fn) =>
              fn.suspension === undefined
                ? fn
                : Object.freeze({
                    ...fn,
                    suspension: Object.freeze({
                      ...fn.suspension,
                      regions: Object.freeze(
                        fn.suspension.regions.filter(
                          (region) => region._tag !== 'SuspendEffectRegion',
                        ),
                      ),
                    }),
                  }),
            ),
          ),
        })
        assert.isTrue(yield* hasRule(orphan, 'OrphanSuspensionMachinery'))
        assert.notInclude(MirEncoding.encode(program), 'provisional-mir')
      }),
  )
})

it.effect('keeps final synchronous MIR free of suspension machinery', () =>
  Effect.gen(function* () {
    const self = yield* snapshot(
      'effect fn seed(value: i32) -> i32 { return value } pub fn main() -> i32 { return run seed(42) }',
    )
    const program = Analysis.loweredMir(self)
    assert.deepEqual(Analysis.diagnostics(self), [])
    assert.deepEqual(yield* MirVerification.verify(program), [])
    assert.deepEqual(suspensionRegions(program), [])
    assert.notInclude(MirEncoding.encode(program), 'suspension-classification')
  }),
)

it.effect('keeps static runner identity in suspension reachability', () =>
  Effect.gen(function* () {
    const self = yield* snapshot(`import silk.effect { Effect }
struct Problem {}
effect fn work(static label: string<'static>) -> i32 ! Problem {
  return run Effect.suspend(effect { fail Problem {} })
}
pub fn main() -> i32 {
  let ignored = run Effect.result(work("x"))
  return 42
}`)
    assert.deepEqual(Analysis.diagnostics(self), [])
    const program = Analysis.loweredMir(self)
    assert.deepEqual(yield* MirVerification.verify(program), [])
  }),
)

it.effect('retains the caller continuation after a direct suspension primitive', () =>
  Effect.gen(function* () {
    const analysis = yield* snapshot(`effect fn application() -> i32 {
  let value = run Intrinsic.suspendEffect(effect { return 1 })
  return 42 / value
}
pub fn main() -> i32 { return run application() }`)
    assert.deepEqual(Analysis.diagnostics(analysis), [])
    const program = Analysis.loweredMir(analysis)
    assert.deepEqual(yield* MirVerification.verify(program), [])
    const caller = program.functions.find((fn) => fn.id.name === 'application$effect$-1')
    assert.isDefined(caller)
    assert.isTrue(
      caller?.suspension?.regions.some(
        (region) =>
          region._tag === 'RunSuspendableEffectRegion' && region.relay.state !== undefined,
      ),
    )
    assert.isFalse(
      caller?.suspension?.regions.some((region) => region._tag === 'SuspendEffectRegion'),
    )
    assert.isTrue(
      program.functions.some(
        (fn) =>
          fn !== caller &&
          fn.suspension?.regions.some((region) => region._tag === 'SuspendEffectRegion'),
      ),
    )
  }),
)
