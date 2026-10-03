import * as OpaqueRealization from '../src/OpaqueRealization.js'
import * as CoroutineFrame from '../src/CoroutineFrame.js'
import * as Layout from '../src/Layout.js'
import * as Lifetime from '../src/Lifetime.js'
import * as Target from '../src/Target.js'
import * as Type from '../src/Type.js'
import * as AnalysisFixture from './support/AnalysisFixture.js'
import { unreachable } from './support/raise.js'
import { partialSuspension } from './support/partialSuspension.js'
import { assert, it } from '@effect/vitest'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Analysis from '../src/Analysis.js'
import * as Instances from '../src/Instances.js'
import * as Diagnostic from '../src/Diagnostic.js'
import * as MirVerification from '../src/MirVerification.js'
import * as SuspensionOwnership from '../src/SuspensionOwnership.js'
import * as Projections from './support/projections.js'

const encoder = new TextEncoder()

const snapshot = (source: string) =>
  AnalysisFixture.retainingMain(
    'suspension-ownership/main',
    encoder.encode(source),
    'wasm32-unknown-unknown',
  )

const available = (self: Analysis.Snapshot): SuspensionOwnership.Module => {
  const ownership = Projections.suspensionOwnershipOf(self)
  assert.strictEqual(ownership._tag, 'Available')
  if (ownership._tag === 'Available') return ownership.value
  throw new RangeError('expected suspension ownership')
}

const plansFor = (
  self: SuspensionOwnership.Module,
  declaration: string,
): ReadonlyArray<SuspensionOwnership.Plan> =>
  self.plans.filter((plan) => plan.function.declaration.name.startsWith(`${declaration}$effect$`))

const source = `import silk.allocator { Allocator }
import silk.allocator { OutOfMemoryError }
import silk.allocator { Allocator }
import silk.allocator { SystemAllocator }
import silk.effect { Effect }
import silk.layout { Layout }
struct Owner { value: i32 }
effect fn delayed(value: i32) -> i32 {
  return run Effect.suspend(effect { return value })
}
effect fn scalar() -> i32 {
  let dead = 100
  return 40 + run delayed(2)
}
effect fn owned() -> i32 ! OutOfMemoryError ? &mut Allocator {
  let firstLayout = Layout.of<i32>()
  let first = run Allocator.allocate(move firstLayout)
  let secondLayout = Layout.of<i32>()
  let second = run Allocator.allocate(move secondLayout)
  let right = run delayed(2)
  return 8 + right
}
effect fn borrowed(owner: &mut Owner) -> i32 {
  let right = run delayed(2)
  return owner.value + right
}
effect fn shared(owner: &Owner) -> i32 {
  let right = run delayed(2)
  return owner.value + right
}
effect fn branched(flag: bool, left: i32, right: i32) -> i32 {
  let value = run delayed(1)
  if flag { return left + value }
  return right + value
}
effect fn recover(error: OutOfMemoryError) -> i32 { return 0 }
pub fn main() -> i32 {
  let scalarValue = run scalar()
  let mut ownedAllocator = Allocator.systemAllocatorProvider()
  let ownedPending = owned() |> Effect.provideMut(&mut ownedAllocator)
  let ownedValue = run Effect.catchAll(move ownedPending, recover)
  let mut owner = Owner { value: 20 }
  let borrowedValue = run borrowed(&mut owner)
  let sharedValue = run shared(&owner)
  let branchedValue = run branched(true, 30, 12)
  return scalarValue + ownedValue + borrowedValue + sharedValue + branchedValue
}`

/** One realization of the relay program, shared by the tests that inspect it. */
const Relayed = Context.Service<Analysis.Snapshot>('SuspensionOwnership/relayed')

it.layer(Layer.effect(Relayed, snapshot(source)))((it) => {
  it.effect('classifies exact post-normalization MIR locals across relay', () =>
    Effect.gen(function* () {
      const self = yield* Relayed
      assert.deepEqual(Analysis.diagnostics(self), [])
      const ownership = available(self)
      const sharedStart = source.indexOf('run shared(&owner)')
      const caller = Analysis.loweredMir(self).functions.find((fn) => fn.id.name === 'main')
      const loan =
        caller === undefined
          ? undefined
          : MirVerification.operations(caller).find(
              (operation) =>
                operation._tag === 'BeginLoan' &&
                operation.access === 'Shared' &&
                operation.sourceType._tag === 'Nominal' &&
                operation.sourceType.type.name === 'Owner',
            )
      const callerPlan = ownership.plans.find((plan) => plan.span.start === sharedStart)
      assert.isTrue(
        loan?._tag === 'BeginLoan' &&
          callerPlan?.slots.some(
            (slot) => slot.local.ordinal === loan.root.ordinal && slot.type._tag === 'Nominal',
          ),
        'the last shared loan retains its actual owner storage independently of cleanup',
      )
      const scalar = plansFor(ownership, 'scalar').find((plan) => plan.frame === 'StatefulRelay')
      const owned = plansFor(ownership, 'owned').find(
        (plan) =>
          plan.frame === 'StatefulRelay' &&
          plan.slots.filter((slot) => slot.access._tag === 'AffineTransfer').length === 2,
      )
      const borrowed = plansFor(ownership, 'borrowed').find(
        (plan) => plan.frame === 'StatefulRelay',
      )
      const shared = plansFor(ownership, 'shared').find((plan) => plan.frame === 'StatefulRelay')
      const branched = plansFor(ownership, 'branched').find(
        (plan) => plan.frame === 'StatefulRelay',
      )
      assert.isDefined(scalar, SuspensionOwnership.encode(ownership))
      assert.isDefined(owned, SuspensionOwnership.encode(ownership))
      assert.isDefined(borrowed, SuspensionOwnership.encode(ownership))
      assert.isDefined(shared, SuspensionOwnership.encode(ownership))
      assert.isDefined(branched, SuspensionOwnership.encode(ownership))
      if (
        scalar === undefined ||
        owned === undefined ||
        borrowed === undefined ||
        shared === undefined ||
        branched === undefined
      )
        return
      const copiedScalars = scalar.slots.filter(
        (slot) => slot.access._tag === 'Copy' && slot.type._tag === 'i32',
      )
      assert.lengthOf(copiedScalars, 1, SuspensionOwnership.encode(ownership))
      assert.isTrue(
        owned.slots.some(
          (slot) => slot.access._tag === 'AffineTransfer' && slot.type._tag === 'Nominal',
        ),
        SuspensionOwnership.encode(ownership),
      )
      assert.isTrue(
        borrowed.slots.some(
          (slot) =>
            slot.access._tag === 'BorrowedDependency' &&
            slot.access.access === 'Exclusive' &&
            slot.access.loan._tag === 'BorrowedParameter',
        ),
        SuspensionOwnership.encode(ownership),
      )
      assert.isTrue(
        shared.slots.some(
          (slot) =>
            slot.access._tag === 'BorrowedDependency' &&
            slot.access.access === 'Shared' &&
            slot.access.loan._tag === 'BorrowedParameter',
        ),
        SuspensionOwnership.encode(ownership),
      )
      const affine = owned.slots.filter((slot) => slot.access._tag === 'AffineTransfer')
      const dependency =
        borrowed.slots.find((slot) => slot.access._tag === 'BorrowedDependency') ??
        unreachable('expected borrowed dependency')
      const module = Analysis.loweredMir(self)
      // Lifetime authority cannot truncate the transported descriptor to one pointer.
      for (const target of [Target.wasm32UnknownUnknown, Target.aarch64AppleDarwin]) {
        const slice = Type.slice('Shared', 'i32', Lifetime.staticLifetime)
        const layout = {
          ...module.layout,
          target,
          entries: [Layout.sliceEntry(target, slice, Layout.scalarEntry(target, 'i32'))],
        }
        assert.deepEqual(
          CoroutineFrame.storageOf(
            { ...module, layout },
            { ...dependency, type: { _tag: 'Slice', type: slice } },
          ),
          {
            size: target.pointerSize * 2,
            alignment: target.pointerAlignment,
          },
        )
        assert.deepEqual(
          CoroutineFrame.storageOf(
            { ...module, layout },
            { ...dependency, type: { _tag: 'EnvironmentBorrow', type: slice, access: 'Shared' } },
          ),
          {
            size: target.pointerSize,
            alignment: target.pointerAlignment,
          },
        )
      }
      assert.lengthOf(affine, 2)
      const affineLocals = affine.map((slot) => slot.local.ordinal)
      assert.deepEqual(
        owned.failure.releases
          .map((release) => release.local.ordinal)
          .filter((local) => affineLocals.includes(local)),
        [...affineLocals].reverse(),
      )
      // Only the user borrow is retained; private frame storage is not a source dependency.
      assert.lengthOf(
        borrowed.slots.filter((slot) => slot.access._tag === 'BorrowedDependency'),
        1,
      )
      assert.lengthOf(borrowed.failure.loanEnds, 1)
      assert.lengthOf(borrowed.success.loanEnds, 0)
      assert.deepEqual(
        branched.slots
          .filter((slot) => slot.local.ordinal < 3 && slot.access._tag === 'Copy')
          .map((slot) => slot.local.ordinal),
        [0, 1, 2],
      )
      assert.deepEqual(ownership.violations, [])
    }),
  )

  it.effect('restores every retained state slot on success', () =>
    Effect.gen(function* () {
      for (const plan of available(yield* Relayed).plans) {
        assert.deepEqual(
          plan.success.restores,
          plan.slots.map((slot) => slot.ordinal),
          Instances.keyText(plan.function),
        )
      }
    }),
  )
})

it.effect('preserves partial owner state across suspension and cancellation', () =>
  Effect.gen(function* () {
    const source = `struct Token { value: i32 }
impl Drop for Token { fn drop(self: &mut Token) -> () { return () } }
struct Pair { left: Token right: Token }
effect fn delayed() -> i32 { return run Intrinsic.suspendEffect(effect { return 2 }) }
effect fn partial() -> i32 {
  let owner = Pair { left: Token { value: 1 }, right: Token { value: 2 } }
  let extracted = move owner.left
  drop extracted
  let result = run delayed()
  return owner.right.value + result
}
effect fn complete() -> i32 {
  let owner = Pair { left: Token { value: 1 }, right: Token { value: 2 } }
  let result = run delayed()
  return owner.left.value + owner.right.value + result
}
effect fn conditional(flag: bool) -> i32 {
  let mut owner = Pair { left: Token { value: 1 }, right: Token { value: 2 } }
  if flag { let extracted = move owner.left drop extracted }
  let result = run delayed()
  owner.left = Token { value: 3 }
  return owner.left.value + owner.right.value + result
}
pub fn main() -> i32 { let first = run partial() let second = run conditional(true) return first + second + run complete() }`
    const self = yield* snapshot(source)
    assert.deepEqual(Analysis.diagnostics(self), [])
    const program = Analysis.loweredMir(self)
    assert.deepEqual(yield* MirVerification.verify(program), [])
    const plan = plansFor(available(self), 'partial').at(0)
    const owner = plan?.slots.find(
      (slot) => slot.type._tag === 'Nominal' && slot.type.type.name === 'Pair',
    )
    assert.deepEqual(
      owner?.initialization?.state.children.map((child) => ({
        selector: child.selector,
        initialization: child.state.initialization,
      })),
      [{ selector: { _tag: 'Field', ordinal: 0 }, initialization: 'Missing' }],
    )
    assert.deepEqual(
      plan?.failure.releases.find((release) => release.local.ordinal === owner?.local.ordinal)
        ?.initialization,
      owner?.initialization,
    )
    const conditional = plansFor(available(self), 'conditional').at(0)
    const partial = conditional?.slots.find((slot) =>
      slot.initialization?.state.children.some((child) => child.state.initialization === 'Maybe'),
    )
    assert.isDefined(partial)
    assert.lengthOf(partial?.initialization?.flags ?? [], 1)
    assert.isTrue(
      partial?.initialization?.flags.every((flag) =>
        conditional?.slots.some(
          (slot) => slot.local.ordinal === flag.local.ordinal && slot.type._tag === 'bool',
        ),
      ),
    )
    const provisional = Projections.provisionalMirOf(self)
    assert.strictEqual(provisional._tag, 'Available')
    if (provisional._tag !== 'Available') return
    const missingFlags = {
      ...program,
      functions: program.functions.map((fn) => ({ ...fn, initializationFlags: [] })),
    }
    const violations = SuspensionOwnership.plan(
      missingFlags,
      provisional.value,
      self.index,
      OpaqueRealization.catalogOf(self),
    ).violations
    assert.isNotEmpty(violations)
    assert.deepEqual(
      violations.map((violation) => {
        const diagnostic = Diagnostic.invalidSuspensionOwnership(violation.detail, violation.span)
        return {
          code: diagnostic.code,
          span: source.slice(diagnostic.span.start, diagnostic.span.end).trim(),
        }
      }),
      [{ code: 'OWN0020', span: 'run delayed()' }],
    )
    const missingRead = source.replace(
      'return owner.right.value + result',
      'return owner.left.value + result',
    )
    const rejected = yield* snapshot(missingRead)
    assert.deepEqual(
      Analysis.diagnostics(rejected).map((d) => ({
        code: d.code,
        span: missingRead.slice(d.span.start, d.span.end).trim(),
      })),
      [{ code: 'OWN0001', span: 'owner.left.value' }],
    )
  }),
)

it.effect('retains conditional owners inside independently cancellable frames', () =>
  Effect.gen(function* () {
    const self = yield* snapshot(partialSuspension)
    assert.deepEqual(Analysis.diagnostics(self), [])
    const program = Analysis.loweredMir(self)
    assert.deepEqual(yield* MirVerification.verify(program), [])
    const corrupted = {
      ...program,
      functions: program.functions.map((fn) =>
        fn.suspension === undefined
          ? fn
          : {
              ...fn,
              suspension: {
                ...fn.suspension,
                regions: fn.suspension.regions.map((region) =>
                  region._tag !== 'RunSuspendableEffectRegion' || region.relay.state === undefined
                    ? region
                    : {
                        ...region,
                        relay: {
                          ...region.relay,
                          state: {
                            ...region.relay.state,
                            slots: region.relay.state.slots.map((slot) => ({
                              ...slot,
                              initialization: undefined,
                            })),
                          },
                        },
                      },
                ),
              },
            },
      ),
    }
    assert.isTrue(
      (yield* MirVerification.verify(corrupted)).some(
        (violation) => violation.rule === 'InvalidCoroutineFrame',
      ),
    )
    const frames = program.coroutineFrames ?? unreachable('expected coroutine frame layouts')
    const lostPayloadFlags = {
      ...program,
      coroutineFrames: {
        ...frames,
        entries: frames.entries.map((entry) => ({
          ...entry,
          states: entry.states.map((state) => ({
            ...state,
            payload: state.payload.map((field) => ({ ...field, initialization: undefined })),
          })),
        })),
      },
    }
    assert.isTrue(
      (yield* MirVerification.verify(lostPayloadFlags)).some(
        (violation) => violation.rule === 'InvalidCoroutineFrame',
      ),
    )
  }),
)
