import * as AnalysisFixture from './support/AnalysisFixture.js'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Analysis from '../src/Analysis.js'
import * as CoroutineFrame from '../src/CoroutineFrame.js'
import * as ExecutionAffinity from '../src/ExecutionAffinity.js'
import type * as ExecutionTransition from '../src/ExecutionTransition.js'
import * as Mir from '../src/Mir.js'
import * as MirVerification from '../src/MirVerification.js'
import * as Type from '../src/Type.js'
import { independentExecutionMultiplePackages } from './support/corpus.js'

const replaceMirOperation = (
  module: Mir.Module,
  target: Mir.Operation,
  replacement: object,
): Mir.Module => {
  const rewrite = (operation: Mir.Operation): Mir.Operation => {
    // This boundary deliberately admits malformed operation shapes so verifier-negative tests can
    // prove rejection of values TypeScript correctly excludes from the valid MIR union.
    if (operation === target) return replacement as Mir.Operation
    if (operation._tag === 'Conditional')
      return Object.freeze({
        ...operation,
        taken: Mir.mapExecutionOperations(operation.taken, (operations) => operations.map(rewrite)),
        otherwise: Mir.mapExecutionOperations(operation.otherwise, (operations) =>
          operations.map(rewrite),
        ),
      })
    if (operation._tag === 'ShortCircuit')
      return Object.freeze({
        ...operation,
        right: Mir.mapExecutionOperations(operation.right, (operations) => operations.map(rewrite)),
      })
    if (operation._tag !== 'Match') return operation
    return Object.freeze({
      ...operation,
      arms: Object.freeze(
        operation.arms.map((arm) =>
          Object.freeze({
            ...arm,
            ...(arm.guard === undefined
              ? {}
              : {
                  guard: Object.freeze({
                    ...arm.guard,
                    execution: Mir.mapExecutionOperations(arm.guard.execution, (operations) =>
                      operations.map(rewrite),
                    ),
                  }),
                }),
            selected: Object.freeze({
              ...arm.selected,
              execution: Mir.mapExecutionOperations(arm.selected.execution, (operations) =>
                operations.map(rewrite),
              ),
            }),
          }),
        ),
      ),
    })
  }
  return Object.freeze({
    ...module,
    functions: Object.freeze(
      module.functions.map((fn) =>
        Object.freeze({
          ...fn,
          regions: Object.freeze(
            fn.regions.map((region): Mir.Region =>
              region._tag === 'OperationRegion'
                ? Object.freeze({
                    ...region,
                    operations: Object.freeze(region.operations.map(rewrite)),
                  })
                : region,
            ),
          ),
        }),
      ),
    ),
  })
}

const source = `import silk.allocator { Allocator, OutOfMemoryError }
import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.execution { Execution }
import silk.layout { Layout }
import silk.shared { Shared }
struct Empty {}
struct Waiting { wake: Intrinsic.Wake }
struct WaiterState { slot: Empty | Waiting }
struct Guard { storage: Allocation state: Shared<WaiterState> }
fn install(state: &mut WaiterState, wake: Intrinsic.Wake) -> () {
  let previous = Intrinsic.replace(state.slot, Waiting { wake: move wake })
  drop previous
  return ()
}
fn extract(state: &mut WaiterState) -> Empty | Waiting {
  return Intrinsic.replace(state.slot, Empty {})
}
fn signal(state: &Shared<WaiterState>) -> () {
  let selected = Shared.withMut(state, extract)
  return match move selected {
    Empty {} => ()
    Waiting { wake } => Intrinsic.wake(move wake)
  }
}
fn register(
  wake: Intrinsic.Wake,
  storage: Allocation,
  state: Shared<WaiterState>
) -> Guard {
  let installing = install(move wake)
  let installed = Shared.withMut(&state, move installing)
  signal(&state)
  return Guard { storage: move storage, state: move state }
}
effect fn parked(storage: Allocation, state: Shared<WaiterState>) -> () {
  let retained = Shared.clone(&state)
  let registration = register(move storage, move state)
  let resumed = run Execution.park(move registration)
  drop retained
  return ()
}
fn ready(state: &()) -> () { return () }
effect fn program() -> () ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let guardStorage = run Allocator.allocate(Layout.of<i32>())
    |> Effect.provideMut<Allocator>(&mut allocator)
  let state = run Shared.make<WaiterState>(WaiterState { slot: Empty {} })
    |> Effect.provideMut<Allocator>(&mut allocator)
  let mut execution = run Execution.make(parked(move guardStorage, move state), (), ready)
    |> Effect.provideMut<Allocator>(&mut allocator)
  Execution.notifyInitial(&mut execution)
  drop execution
  return ()
}
effect fn recover(error: OutOfMemoryError) -> () { return () }
pub fn main() -> () { return run Effect.catchAll(program(), recover) }`

it.effect('emits native never-driven package cleanup', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'external-wake-parking/native-cleanup',
      new TextEncoder().encode(source),
      'aarch64-apple-darwin',
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    assert.deepEqual(yield* MirVerification.verify(Analysis.loweredMir(snapshot)), [])
    yield* Analysis.codegen(snapshot, { mode: 'release' })
  }),
)

it.effect(
  'rejects forged execution package and take-once callback authorities before lowering',
  () =>
    Effect.gen(function* () {
      const snapshot = yield* AnalysisFixture.retainingMain(
        'independent-execution/forged-mir-authority',
        new TextEncoder().encode(independentExecutionMultiplePackages),
        'wasm32-unknown-unknown',
      )
      assert.deepEqual(Analysis.diagnostics(snapshot), [])
      assert.strictEqual(snapshot.mir._tag, 'Available')
      assert.strictEqual(snapshot.layout._tag, 'Available')
      if (snapshot.mir._tag !== 'Available' || snapshot.layout._tag !== 'Available') return
      const module = snapshot.mir.value
      const operations = module.functions.flatMap(MirVerification.operations)
      const initialize = operations.find(
        (
          operation,
        ): operation is Extract<
          Mir.Operation,
          {
            readonly _tag: 'ExecutionFromAllocation'
          }
        > => operation._tag === 'ExecutionFromAllocation',
      )
      const drive = operations.find(
        (
          operation,
        ): operation is Extract<
          Mir.Operation,
          {
            readonly _tag: 'ExecutionDrive'
          }
        > => operation._tag === 'ExecutionDrive',
      )
      const wake = operations.find(
        (
          operation,
        ): operation is Extract<
          Mir.Operation,
          {
            readonly _tag: 'ExecutionWake'
          }
        > => operation._tag === 'ExecutionWake',
      )
      const otherPlan = snapshot.layout.value.executionPackages.plans.find(
        (plan) => plan.provenance !== initialize?.plan.provenance,
      )
      assert.isDefined(initialize)
      assert.isDefined(drive)
      assert.isDefined(wake)
      assert.isDefined(otherPlan)
      if (
        initialize === undefined ||
        drive === undefined ||
        wake === undefined ||
        otherPlan === undefined
      )
        return
      const authority = module.executionTransitions.at(0)
      const registerEdge = authority?.edges.find((edge) => edge.event === 'Register')
      const pendingEdge = authority?.edges.find((edge) => edge.after.execution === 'DestroyPending')
      assert.isDefined(authority)
      assert.isDefined(registerEdge)
      assert.isDefined(pendingEdge)
      if (authority === undefined || registerEdge === undefined || pendingEdge === undefined) return
      const authorityForgeries: ReadonlyArray<ExecutionTransition.Authority> = [
        Object.freeze({ ...authority, edges: Object.freeze(authority.edges.slice(1)) }),
        Object.freeze({
          ...authority,
          edges: Object.freeze(
            authority.edges.map((edge) => {
              if (edge !== registerEdge || edge.after.wake === undefined) return edge
              return Object.freeze({
                ...edge,
                after: Object.freeze({
                  ...edge.after,
                  wake: Object.freeze({
                    ...edge.after.wake,
                    generation: edge.after.wake.generation + 1,
                  }),
                }),
              })
            }),
          ),
        }),
        Object.freeze({
          ...authority,
          edges: Object.freeze(
            authority.edges.map((edge) =>
              edge === pendingEdge
                ? Object.freeze({ ...edge, cleanup: Object.freeze(['Endpoint' as const]) })
                : edge,
            ),
          ),
        }),
      ]
      const forgeries: ReadonlyArray<Mir.Module> = [
        replaceMirOperation(module, initialize, Object.freeze({ ...initialize, plan: otherPlan })),
        replaceMirOperation(module, drive, Object.freeze({ ...drive, completionAccess: 'Shared' })),
        replaceMirOperation(module, wake, Object.freeze({ ...wake, wakeAccess: 'Shared' })),
        ...authorityForgeries.map((forgedAuthority) =>
          Object.freeze({
            ...module,
            executionTransitions: Object.freeze([
              forgedAuthority,
              ...module.executionTransitions.slice(1),
            ]),
          }),
        ),
      ]
      for (const forged of forgeries)
        assert.include(
          (yield* MirVerification.verify(forged)).map((violation) => violation.rule),
          'InvalidExecutionOperation',
        )
    }),
)

it.effect('assigns only the sealed nominal Wake the local-execution affinity seed', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'external-wake-parking/affinity',
      new TextEncoder().encode(`import silk.shared { Shared }
struct Wake {}
struct Empty {}
struct Holder { wake: Intrinsic.Wake }
fn intrinsic(value: Intrinsic.Wake) -> () { drop value return () }
fn ordinary(value: Wake) -> () { drop value return () }
fn aggregate(value: Holder) -> () { drop value return () }
fn unionValue(value: Intrinsic.Wake | Empty) -> () { drop value return () }
fn array(value: [Intrinsic.Wake; 1]) -> () { drop value return () }
fn shared(value: Shared<Holder>) -> () { drop value return () }
pub fn main() -> i32 { return 42 }`),
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    const declarations = snapshot.index.modules.at(0)?.declarations ?? []
    const parameter = (name: string): Type.Type | undefined => {
      const declared = declarations
        .find(
          (declaration) =>
            declaration.name._tag === 'Present' && declaration.name.spelling === name,
        )
        ?.parameters.at(0)?.declaredType
      return declared?._tag === 'Resolved' ? declared.type : undefined
    }
    const intrinsic = parameter('intrinsic')
    const ordinary = parameter('ordinary')
    assert.isTrue(intrinsic !== undefined && Type.isWake(intrinsic))
    assert.strictEqual(Type.wake.sealed, 'Intrinsic.Wake')
    assert.strictEqual(
      intrinsic === undefined
        ? 'Unrestricted'
        : ExecutionAffinity.ofType(snapshot.index, intrinsic)._tag,
      'LocalExecution',
    )
    assert.strictEqual(
      ordinary === undefined ? 'Missing' : ExecutionAffinity.ofType(snapshot.index, ordinary)._tag,
      'Unrestricted',
    )
    for (const name of ['aggregate', 'unionValue', 'array', 'shared']) {
      const type = parameter(name)
      assert.strictEqual(
        type === undefined ? 'Missing' : ExecutionAffinity.ofType(snapshot.index, type)._tag,
        'LocalExecution',
      )
    }
  }),
)

it.effect(
  'retains a park-capable library function without imposing executable startup policy',
  () =>
    Effect.gen(function* () {
      const snapshot = yield* AnalysisFixture.retainingMain(
        'external-wake-parking/unowned-entry',
        new TextEncoder().encode(`import silk.execution { Execution }
struct Guard {}
fn register(wake: Intrinsic.Wake) -> Guard { drop wake return Guard {} }
pub fn main() -> () { return run Execution.park(register) }`),
      )
      assert.deepEqual(
        Analysis.diagnostics(snapshot).map((diagnostic) => diagnostic.code),
        [],
      )
    }),
)

it.effect('rejects a second signal as an ordinary use after move', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'external-wake-parking/double-signal',
      new TextEncoder().encode(`fn duplicate(wake: Intrinsic.Wake) -> () {
  Intrinsic.wake(move wake)
  Intrinsic.wake(move wake)
  return ()
}
pub fn main() -> i32 { return 42 }`),
    )
    assert.deepEqual(
      Analysis.diagnostics(snapshot).map((diagnostic) => diagnostic.code),
      ['OWN0001'],
    )
  }),
)

it.effect('rejects a registration callback that transitively parks', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'external-wake-parking/non-parking-registration',
      new TextEncoder().encode(`import silk.execution { Execution }
struct Guard {}
fn harmless(wake: Intrinsic.Wake) -> Guard { drop wake return Guard {} }
effect fn nested() -> () { return run Execution.park(harmless) }
fn invalid(wake: Intrinsic.Wake) -> Guard {
  drop wake
  let parked = run nested()
  return Guard {}
}
pub fn main() -> () { return run Execution.park(invalid) }`),
    )
    assert.deepEqual(
      Analysis.diagnostics(snapshot).map((diagnostic) => diagnostic.code),
      ['SEM0139'],
    )
  }),
)

it.effect('rejects wake and direct or transitive park while Shared source access is active', () =>
  Effect.gen(function* () {
    const variants = [
      {
        callback: `fn selected(value: &Pair) -> i32 {
  let parked = run Execution.park(register)
  return value.value
}`,
        access: 'with',
      },
      {
        callback: `fn inner(value: &mut Pair) -> i32 {
  let parked = run Execution.park(register)
  return value.value
}
fn selected(value: &mut Pair) -> i32 { return inner(move value) }`,
        access: 'withMut',
      },
      {
        callback: `fn parks() -> i32 {
  let parked = run Execution.park(register)
  return 1
}
fn selected(value: &mut Pair) -> i32 { return parks() }`,
        access: 'withMut',
      },
    ]
    for (const [ordinal, variant] of variants.entries()) {
      const snapshot = yield* AnalysisFixture.retainingMain(
        `external-wake-parking/shared-access-${ordinal}`,
        new TextEncoder().encode(`import silk.execution { Execution }
import silk.shared { Shared }
struct Guard {}
struct Pair { value: i32 }
fn register(wake: Intrinsic.Wake) -> Guard { drop wake return Guard {} }
${variant.callback}
fn access(self: &Shared<Pair>) -> i32 { return Shared.${variant.access}(self, selected) }
pub fn main() -> i32 { return 42 }`),
      )
      assert.deepEqual(
        Analysis.diagnostics(snapshot)
          .filter((diagnostic) => diagnostic.code === 'OWN0016')
          .map((diagnostic) => diagnostic.code),
        ['OWN0016'],
        `variant ${ordinal}`,
      )
    }

    const wakeSnapshot = yield* AnalysisFixture.retainingMain(
      'external-wake-parking/shared-access-wake',
      new TextEncoder().encode(`import silk.shared { Shared }
struct Empty {}
struct Armed { wake: Intrinsic.Wake }
struct State { slot: Empty | Armed }
fn signalInside(state: &mut State) -> () {
  let selected = Intrinsic.replace(state.slot, Empty {})
  return match move selected {
    Empty {} => ()
    Armed { wake } => Intrinsic.wake(move wake)
  }
}
fn access(self: &Shared<State>) -> () {
  return Shared.withMut(self, signalInside)
}
pub fn main() -> i32 { return 42 }`),
    )
    assert.deepEqual(
      Analysis.diagnostics(wakeSnapshot).map((diagnostic) => diagnostic.code),
      ['OWN0016'],
    )
  }),
)

it.effect('retains represented callable registration guards in ExecutionPark cleanup facts', () =>
  Effect.gen(function* () {
    const module = 'external-wake-parking/callable-guard'
    const source = `import silk.allocator { Allocator, OutOfMemoryError }
import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.execution { Execution }
import silk.layout { Layout }
fn use(value: (), holder: &Allocation) -> () { return () }
fn register(wake: Intrinsic.Wake, holder: &Allocation) -> once fn(()) -> () {
  drop wake
  return use(holder)
}
effect fn parked(holder: Allocation) -> () {
  let registration = register(&holder)
  let resumed = run Execution.park(move registration)
  drop holder
  return ()
}
fn ready(state: &()) -> () { return () }
effect fn program() -> () ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let holder = run Allocator.allocate(Layout.of<i32>())
    |> Effect.provideMut<Allocator>(&mut allocator)
  let execution = run Execution.make(parked(move holder), (), ready)
    |> Effect.provideMut<Allocator>(&mut allocator)
  drop execution
  return ()
}
effect fn recover(error: OutOfMemoryError) -> () { return () }
pub fn main() -> () { return run Effect.catchAll(program(), recover) }`
    const snapshot = yield* AnalysisFixture.retainingMain(module, new TextEncoder().encode(source))
    const capture = snapshot.ownership
      .get(module)
      ?.functions.flatMap((fn) => [...fn.loans])
      .find((loan) => loan.origin === 'CallableCapture')
    assert.strictEqual(
      capture === undefined
        ? undefined
        : source.slice(capture.endSpan.start, capture.endSpan.end).trim(),
      'run Execution.park(move registration)',
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    assert.strictEqual(snapshot.mir._tag, 'Available')
    if (snapshot.mir._tag !== 'Available') return
    const parks = snapshot.mir.value.functions
      .flatMap(MirVerification.operations)
      .filter((operation) => operation._tag === 'ExecutionPark')
    assert.lengthOf(parks, 1)
    assert.strictEqual(parks.at(0)?.guardCleanup._tag, 'CallableCleanup')
    const parked = snapshot.mir.value.functions.find((fn) =>
      MirVerification.operations(fn).some((operation) => operation === parks.at(0)),
    )
    const parkRegion = parked?.suspension?.regions
      .flatMap((region) =>
        region._tag === 'RunSuspendableEffectRegion' && region.operation === parks.at(0)
          ? [region]
          : [],
      )
      .at(0)
    const state = parkRegion?.relay.state
    assert.deepEqual(
      state?.failure.releases.map((release) => release.cleanup._tag),
      ['CallableCleanup'],
    )
    const layout =
      state === undefined ? undefined : CoroutineFrame.stateLayout(snapshot.mir.value, state.point)
    assert.isDefined(layout)
    if (parked !== undefined && layout !== undefined)
      assert.deepEqual(
        CoroutineFrame.cleanupReleases(parked, layout).map((field) => field.access.cleanup._tag),
        ['CallableCleanup'],
      )
    const caller = snapshot.mir.value.functions.find((fn) =>
      fn.id.name.startsWith('parked$effect$'),
    )
    const callerState = caller?.suspension?.regions
      .flatMap((region) =>
        region._tag === 'RunSuspendableEffectRegion' ? [region.relay.state] : [],
      )
      .find((candidate) => candidate !== undefined)
    assert.deepEqual(
      callerState?.failure.releases.map((release) => release.cleanup._tag),
      ['AllocationCleanup'],
    )
    const callerLayout =
      callerState === undefined
        ? undefined
        : CoroutineFrame.stateLayout(snapshot.mir.value, callerState.point)
    assert.isDefined(callerLayout)
    if (caller !== undefined && callerLayout !== undefined)
      assert.deepEqual(
        CoroutineFrame.cleanupReleases(caller, callerLayout).map(
          (field) => field.access.cleanup._tag,
        ),
        ['AllocationCleanup'],
      )
    assert.deepEqual(yield* MirVerification.verify(snapshot.mir.value), [])
  }),
)

it.effect(
  'accepts a timer-shaped extract-then-signal boundary without privileged actor policy',
  () =>
    Effect.gen(function* () {
      const snapshot = yield* AnalysisFixture.retainingMain(
        'external-wake-parking/timer-shaped',
        new TextEncoder().encode(`import silk.execution { Execution }
import silk.shared { Shared }
struct Empty {}
struct Armed { wake: Intrinsic.Wake }
struct TimerState { registration: Empty | Armed }
struct Unlink { state: Shared<TimerState> }
fn install(state: &mut TimerState, wake: Intrinsic.Wake) -> () {
  let previous = Intrinsic.replace(state.registration, Armed { wake: move wake })
  drop previous
  return ()
}
fn take(state: &mut TimerState) -> Empty | Armed {
  return Intrinsic.replace(state.registration, Empty {})
}
fn fire(state: &Shared<TimerState>) -> () {
  let selected = Shared.withMut(state, take)
  return match move selected {
    Empty {} => ()
    Armed { wake } => Intrinsic.wake(move wake)
  }
}
fn register(wake: Intrinsic.Wake, state: Shared<TimerState>) -> Unlink {
  let installing = install(move wake)
  let installed = Shared.withMut(&state, move installing)
  return Unlink { state: move state }
}
effect fn sleep(state: Shared<TimerState>) -> () {
  let retained = Shared.clone(&state)
  let registration = register(move state)
  let resumed = run Execution.park(move registration)
  drop retained
  return ()
}
pub fn main() -> i32 { return 42 }`),
      )
      assert.deepEqual(Analysis.diagnostics(snapshot), [])
    }),
)
