import * as OpaqueRealization from '../src/OpaqueRealization.js'
import * as AuthoredIdentity from '../src/AuthoredIdentity.js'
import * as CoroutineFrame from '../src/CoroutineFrame.js'
import * as Layout from '../src/Layout.js'
import * as DeclarationFacts from '../src/DeclarationFacts.js'
import * as Mir from '../src/Mir.js'
import * as Tir from '../src/Tir.js'
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

it.effect(
  'retains actual invocation input contents without owning the consumed parameter twice',
  () =>
    Effect.gen(function* () {
      const self = yield* snapshot(`import silk.effect { Effect }
struct Owner { value: i32 }
impl Drop for Owner { fn drop(self: &mut Owner) -> () { return () } }
struct Borrowed<'a> { owner: &'a Owner }
struct NestedReturn {}
fn invoke<T>(value: T, callback: for<use 'call> once fn<'static>(T) -> once Effect<'call; i32>) -> i32 {
  return run callback(move value)
}
effect fn read<'a>(value: Borrowed<'a>) -> i32 {
  let resumed = run Effect.suspend(effect { return 2 })
  return value.owner.value + resumed
}
fn local(callback: for<use 'call> once fn<'static>(Borrowed<'call>) -> once Effect<'call; i32>) -> i32 {
  let owner = Owner { value: 10 }
  let value = Borrowed { owner: &owner }
  return run callback(move value)
}
fn identity<'data>(value: &'data i32) -> &'data i32 { return value }
fn nested<'data>(value: &'data i32, callback: for<use 'call> fn<'static>(&'call i32) -> &'call i32) -> &'data i32 {
  let scoped = callback(value)
  let choice = NestedReturn {}
  match &choice { NestedReturn {} => { return value } }
}
pub fn main() -> i32 {
  let owner = Owner { value: 40 }
  let value = Borrowed { owner: &owner }
  let marker = 0
  return invoke(move value, read) + local(read) + nested(&marker, identity).*
}`)
      assert.deepEqual(Analysis.diagnostics(self), [])
      const program = Analysis.loweredMir(self)
      assert.deepEqual(yield* MirVerification.verify(program), [])
      const fn =
        program.functions.find((fn) => fn.id.name === 'invoke') ??
        unreachable('expected the real selected invoke body')
      const applied = MirVerification.operations(fn).find(
        (operation) =>
          operation._tag === 'ApplyCallable' && operation.invocationUse?.kind === 'Source',
      )
      assert.isTrue(applied?._tag === 'ApplyCallable')
      if (applied?._tag !== 'ApplyCallable' || applied.invocationUse === undefined)
        return unreachable('expected actual source invocation metadata')
      const invocation = applied.invocationUse
      assert.strictEqual(invocation.result.ordinal, applied.destination.ordinal)
      assert.lengthOf(invocation.inputs, 1)
      assert.strictEqual(invocation.inputs.at(0)?.parameter, 0)
      assert.strictEqual(
        invocation.inputs.at(0)?.argument.ordinal,
        applied.arguments.at(0)?.ordinal,
      )
      const ownership = available(self)
      const plan =
        ownership.plans.find(
          (plan) =>
            plan.function.declaration.name === 'invoke' &&
            plan.invocationUses.some((retention) => retention.invocation === invocation),
        ) ?? unreachable('expected the actual parked callback result ownership plan')
      const retention =
        plan.invocationUses.find((retention) => retention.invocation === invocation) ??
        unreachable('expected exact invocation retention')
      const dependency =
        retention.dependencies.at(0) ?? unreachable('expected parameter input authority')
      assert.strictEqual(dependency.parameter, 0)
      assert.deepEqual(dependency.referents, [])
      assert.lengthOf(dependency.contents, 1)
      const content = dependency.contents.at(0) ?? unreachable('expected header borrowed contents')
      assert.strictEqual(content.parameter, 0)
      assert.lengthOf(content.path, 1)
      const component = content.path.at(0)
      assert.strictEqual(component?._tag, 'DeclaredContents')
      if (component?._tag !== 'DeclaredContents')
        return unreachable('expected exact incoming declared contents authority')
      assert.strictEqual(component.component, 0)
      const parameter = fn.localTypes.at(0)
      assert.isTrue(parameter?._tag === 'Nominal' && parameter.type.name === 'Borrowed')
      if (parameter?._tag !== 'Nominal')
        return unreachable('expected actual selected nominal parameter')
      assert.isTrue(Type.equals(content.type, parameter.type))
      const input = invocation.inputs.at(0) ?? unreachable('expected actual invocation input')
      assert.isTrue(Type.equals(input.type, parameter.type))
      const headerRegion = parameter.type.arguments.at(0)
      assert.isTrue(headerRegion !== undefined && Lifetime.isLifetime(headerRegion))
      if (headerRegion === undefined || !Lifetime.isLifetime(headerRegion))
        return unreachable('expected actual selected incoming lifetime')
      assert.isTrue(Lifetime.equals(content.region, headerRegion))
      const retainedRegions = Type.retention(parameter.type).regions
      assert.lengthOf(retainedRegions, 1)
      assert.isTrue(retainedRegions.every((region) => Lifetime.equals(region, content.region)))
      const entry =
        Layout.entry(program.layout, parameter.type) ??
        unreachable('expected real physical incoming layout')
      assert.isFalse(
        Type.equals(entry.type, parameter.type),
        'erased layout coordinates cannot supply the incoming semantic lifetime',
      )
      const headerLayout = entry.representation
      assert.isTrue(headerLayout?._tag === 'Aggregate')
      if (headerLayout?._tag !== 'Aggregate')
        return unreachable('expected genuine nominal header storage')
      const declaredField =
        headerLayout.fields.at(0) ?? unreachable('expected authored owner field')
      assert.strictEqual(
        DeclarationFacts.fieldDeclaration(declaredField.id).sourceId,
        parameter.type.module,
      )
      assert.strictEqual(declaredField.id.ordinal, 0)
      assert.isTrue(Type.isReference(declaredField.type) && declaredField.type.access === 'Shared')
      const caller =
        program.functions.find((candidate) => candidate.id.name === 'main') ??
        unreachable('expected actual caller body')
      const incoming = MirVerification.operations(caller).find(
        (operation) =>
          operation._tag === 'Call' &&
          operation.target.module === fn.id.module &&
          operation.target.name === fn.id.name,
      )
      if (incoming?._tag !== 'Call') return unreachable('expected real main-to-invoke application')
      const supplied = incoming.arguments.at(0)
      const suppliedType =
        supplied === undefined ? undefined : caller.localTypes.at(supplied.ordinal)
      assert.isTrue(
        suppliedType?._tag === 'Nominal' && Type.equals(suppliedType.type, parameter.type),
      )
      assert.isFalse(
        plan.slots.some(
          (slot) => slot.local.ordinal === 0 && slot.access._tag === 'AffineTransfer',
        ),
      )
      const state =
        fn.suspension?.frame?.states.find((state) =>
          state.invocationUses?.some((retention) => retention.invocation === invocation),
        ) ?? unreachable('expected canonical frame retention metadata')
      assert.deepEqual(state.invocationUses, plan.invocationUses)

      const local =
        program.functions.find((fn) => fn.id.name === 'local') ??
        unreachable('expected concrete local caller')
      const localCall =
        MirVerification.operations(local).find(
          (operation) =>
            operation._tag === 'ApplyCallable' && operation.invocationUse !== undefined,
        ) ?? unreachable('expected local source call')
      if (localCall._tag !== 'ApplyCallable' || localCall.invocationUse === undefined)
        return unreachable('expected actual local invocation')
      const localPlan =
        ownership.plans.find(
          (plan) =>
            plan.function.declaration.name === 'local' &&
            plan.invocationUses.some(
              (retention) => retention.invocation === localCall.invocationUse,
            ),
        ) ?? unreachable('expected local invocation parking plan')
      const localRetention =
        localPlan.invocationUses.find(
          (retention) => retention.invocation === localCall.invocationUse,
        ) ?? unreachable('expected actual local holder')
      const referent =
        localRetention.dependencies.flatMap((dependency) => dependency.referents).at(0) ??
        unreachable('expected source loan root through the constructed Borrowed value')
      assert.strictEqual(referent.loan._tag, 'MirLoan')
      const owner =
        localPlan.slots.find((slot) => slot.local.ordinal === referent.root.ordinal) ??
        unreachable('expected retained external referent storage')
      assert.isTrue(owner.type._tag === 'Nominal' && owner.type.type.name === 'Owner')
      assert.strictEqual(owner.access._tag, 'AffineTransfer')
      const loan = MirVerification.operations(local).find(
        (operation) =>
          operation._tag === 'BeginLoan' && operation.root.ordinal === owner.local.ordinal,
      )
      assert.isTrue(
        loan?._tag === 'BeginLoan' &&
          referent.loan._tag === 'MirLoan' &&
          Tir.borrowKey(loan.borrow) === Tir.borrowKey(referent.loan.borrow),
      )
      assert.lengthOf(
        localPlan.failure.releases.filter(
          (release) => release.local.ordinal === owner.local.ordinal,
        ),
        1,
      )
      assert.isFalse(
        localPlan.slots.some(
          (slot) =>
            slot.local.ordinal === localCall.arguments.at(0)?.ordinal &&
            slot.access._tag === 'AffineTransfer',
        ),
      )

      // The real match arm returns independent data. Its malformed copy returns the scoped
      // callback reference instead; lifetime erasure keeps the ordinary return ABI valid.
      const nested =
        program.functions.find((candidate) => candidate.id.name === 'nested') ??
        unreachable('expected the actual nested return caller')
      const nestedCall = MirVerification.operations(nested).find(
        (operation) =>
          operation._tag === 'ApplyCallable' && operation.invocationUse?.kind === 'Source',
      )
      if (nestedCall?._tag !== 'ApplyCallable' || nestedCall.invocationUse === undefined)
        return unreachable('expected actual pure marked invocation')
      const nestedUse = nestedCall.invocationUse
      const scopedType =
        nested.localTypes.at(nestedUse.result.ordinal) ??
        unreachable('expected actual scoped callback result type')
      const scopedSemantic = Mir.semanticType(scopedType)
      assert.isTrue(
        Type.isReference(scopedSemantic) &&
          scopedSemantic.access === 'Shared' &&
          scopedSemantic.target === 'i32' &&
          Lifetime.equals(scopedSemantic.lifetime, nestedUse.lifetime),
      )
      const independentResult = Mir.semanticType(nested.result)
      assert.isTrue(
        Type.isReference(independentResult) &&
          independentResult.access === 'Shared' &&
          independentResult.target === 'i32' &&
          !Lifetime.equals(independentResult.lifetime, nestedUse.lifetime),
      )
      const dataHeader =
        nested.sourceParameters?.find((parameter) => parameter.parameter === 0) ??
        unreachable('expected the actual independent data parameter header')
      assert.isTrue(Type.equals(dataHeader.type, independentResult))
      assert.isTrue(
        Mir.realizesReturn(scopedType, nested.result),
        'the malformed return must keep the real physical result contract',
      )
      assert.deepEqual(MirVerification.invocationEscapeIssues(nested, program), [])
      const nestedMatch = MirVerification.operations(nested).find(
        (operation) => operation._tag === 'Match',
      )
      if (nestedMatch?._tag !== 'Match')
        return unreachable('expected the actual authored match execution')
      let changedNestedReturns = 0
      const escapingMatch: Mir.MatchOperation = {
        ...nestedMatch,
        arms: nestedMatch.arms.map((arm) => ({
          ...arm,
          selected: {
            ...arm.selected,
            execution: {
              ...arm.selected.execution,
              regions: arm.selected.execution.regions.map((region): Mir.Region => {
                if (
                  (region._tag !== 'OperationRegion' && region._tag !== 'CleanupRegion') ||
                  region.outcome._tag !== 'Return'
                )
                  return region
                changedNestedReturns += 1
                assert.isFalse(region.outcome.value.ordinal === nestedUse.result.ordinal)
                return { ...region, outcome: { ...region.outcome, value: nestedUse.result } }
              }),
            },
          },
        })),
      }
      const escaping: Mir.MirFunction = {
        ...nested,
        regions: nested.regions.map((region): Mir.Region =>
          region._tag !== 'OperationRegion'
            ? region
            : {
                ...region,
                operations: region.operations.map((operation) =>
                  operation === nestedMatch ? escapingMatch : operation,
                ),
              },
        ),
      }
      assert.strictEqual(changedNestedReturns, 1)
      assert.isFalse(
        nested.regions.some(
          (region) =>
            (region._tag === 'OperationRegion' || region._tag === 'CleanupRegion') &&
            region.outcome._tag === 'Return' &&
            region.outcome.value.ordinal === nestedUse.result.ordinal,
        ),
      )
      const nestedEscapes = MirVerification.invocationEscapeIssues(escaping, program)
      assert.lengthOf(nestedEscapes, 1)
      assert.strictEqual(nestedEscapes.at(0)?.operation, nestedCall)
      assert.strictEqual(nestedEscapes.at(0)?._tag, 'InvalidInvocationUse')

      // An unmarked source target retains the primitive's genuine required recipe binder.
      // Changing only its owner must fail even when ordinal, finite use and runtime types agree.
      const recoveries = program.functions.flatMap((caller) =>
        MirVerification.operations(caller).flatMap((operation) => {
          if (
            operation._tag !== 'ApplyCallable' ||
            operation.invocationUse?.kind !== 'Recovery' ||
            operation.callable === undefined
          )
            return []
          const actual = caller.localTypes.at(operation.callable.ordinal)
          if (
            actual?._tag !== 'CallableValue' ||
            actual.environment !== undefined ||
            actual.storage !== undefined ||
            actual.target._tag !== 'DeclarationCallableTarget'
          )
            return []
          const target = actual.target.declaration
          const selected = program.functions.filter((candidate) =>
            Mir.matchesCall(
              candidate,
              target,
              actual.typeArguments ?? [],
              undefined,
              operation.type,
            ),
          )
          const source = selected.length === 1 ? selected.at(0) : undefined
          if (
            source === undefined ||
            source.sourceInvocationUse !== undefined ||
            source.sourceOwner === undefined ||
            source.sourceOwner.module !== target.module ||
            source.sourceOwner.name !== target.name
          )
            return []
          return [{ caller, operation, source }]
        }),
      )
      const recovery =
        recoveries.at(0) ?? unreachable('expected an actual unmarked source recovery target')
      const recoveryOperation = recovery.operation
      const recoveryUse =
        recoveryOperation.invocationUse ?? unreachable('expected actual recovery use')
      const recoveryInput =
        recoveryUse.inputs.at(0) ?? unreachable('expected selected failure input')
      const recoveryHeader =
        recovery.source.sourceParameters?.find((parameter) => parameter.parameter === 0) ??
        unreachable('expected the actual unmarked source input header')
      assert.isTrue(Type.equals(recoveryHeader.type, recoveryInput.type))
      const executions = (operation: Mir.Operation): ReadonlyArray<Mir.Execution> => {
        if (operation._tag === 'Conditional') return [operation.taken, operation.otherwise]
        if (operation._tag === 'DiagnosticScope') return [operation.body]
        if (operation._tag === 'ShortCircuit') return [operation.right]
        if (operation._tag === 'Match')
          return operation.arms.flatMap((arm) => [
            ...(arm.guard === undefined ? [] : [arm.guard.execution]),
            arm.selected.execution,
          ])
        return []
      }
      const recoveryScopes = MirVerification.operations(recovery.caller)
        .flatMap(executions)
        .filter(
          (execution) =>
            execution.recoveryInvocation !== undefined &&
            execution.recoveryOutcome !== undefined &&
            Mir.executionOperations(execution).includes(recoveryOperation),
        )
      assert.lengthOf(recoveryScopes, 1)
      const recoveryScope =
        recoveryScopes.at(0) ?? unreachable('expected genuine selected caught scope')
      const recipe =
        recoveryScope.recoveryInvocation ?? unreachable('expected checked primitive recipe')
      assert.isTrue(Lifetime.equals(recipe.binder, recoveryUse.binder))
      assert.isTrue(Lifetime.equals(recipe.lifetime, recoveryUse.lifetime))
      assert.deepEqual(recipe.owner, recoveryUse.owner)
      assert.strictEqual(
        AuthoredIdentity.anchorKey(recipe.origin),
        AuthoredIdentity.anchorKey(recoveryUse.origin),
      )
      assert.isTrue(Type.equals(recipe.selected, recoveryInput.type))
      assert.deepEqual(MirVerification.invocationUseIssues(recovery.caller, program), [])
      const wrongRecovery: Extract<Mir.Operation, { readonly _tag: 'ApplyCallable' }> = {
        ...recoveryOperation,
        invocationUse: {
          ...recoveryUse,
          binder: {
            ...recoveryUse.binder,
            owner: {
              ...recoveryUse.binder.owner,
              name: `${recoveryUse.binder.owner.name}:wrong-source`,
            },
          },
        },
      }
      assert.strictEqual(wrongRecovery.invocationUse?.binder.ordinal, recipe.binder.ordinal)
      assert.strictEqual(wrongRecovery.invocationUse?.lifetime, recoveryUse.lifetime)
      assert.strictEqual(wrongRecovery.invocationUse?.inputs, recoveryUse.inputs)
      let changedRecoveries = 0
      const replaceRecovery = (operation: Mir.Operation): Mir.Operation => {
        if (operation === recoveryOperation) {
          changedRecoveries += 1
          return wrongRecovery
        }
        const map = (execution: Mir.Execution): Mir.Execution =>
          Mir.mapExecutionOperations(execution, (operations) => operations.map(replaceRecovery))
        if (operation._tag === 'Conditional')
          return { ...operation, taken: map(operation.taken), otherwise: map(operation.otherwise) }
        if (operation._tag === 'DiagnosticScope') return { ...operation, body: map(operation.body) }
        if (operation._tag === 'ShortCircuit') return { ...operation, right: map(operation.right) }
        if (operation._tag === 'Match')
          return {
            ...operation,
            arms: operation.arms.map((arm) => ({
              ...arm,
              ...(arm.guard === undefined
                ? {}
                : { guard: { ...arm.guard, execution: map(arm.guard.execution) } }),
              selected: { ...arm.selected, execution: map(arm.selected.execution) },
            })),
          }
        return operation
      }
      const wrongRecoveryRegions = Mir.mapExecutionOperations(
        { entry: recovery.caller.entry, regions: recovery.caller.regions },
        (operations) => operations.map(replaceRecovery),
      ).regions
      assert.strictEqual(changedRecoveries, 1)
      const wrongRecoveryIssues = MirVerification.invocationUseIssues(
        { ...recovery.caller, regions: wrongRecoveryRegions },
        program,
      )
      assert.lengthOf(wrongRecoveryIssues, 1)
      assert.strictEqual(wrongRecoveryIssues.at(0)?._tag, 'InvalidInvocationUse')
      assert.strictEqual(wrongRecoveryIssues.at(0)?.operation, wrongRecovery)

      // Mutate the authentic lowered call, not a fabricated passing MIR program.
      let replaced = false
      const invalidCall = {
        ...fn,
        regions: fn.regions.map((region): Mir.Region => {
          if (region._tag !== 'OperationRegion') return region
          return {
            ...region,
            operations: region.operations.map((operation): Mir.Operation => {
              if (operation !== applied) return operation
              replaced = true
              return {
                ...applied,
                invocationUse: {
                  ...invocation,
                  inputs: invocation.inputs.map((input) => ({ ...input, parameter: 1 })),
                },
              }
            }),
          }
        }),
      }
      assert.isTrue(replaced, 'the malformed copy must reach the actual call node')
      assert.isTrue(
        MirVerification.invocationUseIssues(invalidCall, program).some(
          (issue) =>
            issue._tag === 'InvalidInvocationUse' && issue.operation._tag === 'ApplyCallable',
        ),
      )
      const staleBinder = {
        ...fn,
        regions: fn.regions.map((region): Mir.Region =>
          region._tag !== 'OperationRegion'
            ? region
            : {
                ...region,
                operations: region.operations.map((operation): Mir.Operation =>
                  operation !== applied
                    ? operation
                    : {
                        ...applied,
                        invocationUse: {
                          ...invocation,
                          binder: { ...invocation.binder, ordinal: invocation.binder.ordinal + 1 },
                        },
                      },
                ),
              },
        ),
      }
      assert.isTrue(
        MirVerification.invocationUseIssues(staleBinder, program).some(
          (issue) =>
            issue._tag === 'InvalidInvocationUse' && issue.operation._tag === 'ApplyCallable',
        ),
      )
      const missingAuthority = {
        ...program,
        functions: program.functions.map((candidate) =>
          candidate !== fn || candidate.suspension?.frame === undefined
            ? candidate
            : {
                ...candidate,
                suspension: {
                  ...candidate.suspension,
                  frame: {
                    ...candidate.suspension.frame,
                    states: candidate.suspension.frame.states.map((candidateState) =>
                      candidateState !== state
                        ? candidateState
                        : { ...candidateState, invocationUses: [] },
                    ),
                  },
                },
              },
        ),
      }
      assert.isTrue(
        (yield* MirVerification.verify(missingAuthority)).some(
          (violation) =>
            violation.rule === 'InvalidCoroutineFrame' && violation.function?.name === 'invoke',
        ),
      )
    }),
)
