import * as AnalysisFixture from './support/AnalysisFixture.js'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Analysis from '../src/Analysis.js'
import * as CleanupPlan from '../src/CleanupPlan.js'
import * as FieldRealization from '../src/FieldRealization.js'
import * as InstanceDiagnostics from '../src/InstanceDiagnostics.js'
import * as Type from '../src/Type.js'
import { unreachable } from './support/raise.js'

/**
 * Exactly-once cleanup for callables stored in nominal fields.
 *
 * An aggregate that stores a callable owes its owned capture lanes one release. Which lanes those
 * are is a fact of the complete specialization, so ownership records the obligation symbolically
 * and the shared runtime realization resolves it. Recording nothing — which is what a represented
 * field used to contribute — would silently drop every owned capture the stored callable holds.
 *
 * These plan-level proofs are paired with the LLVM lowering assertions and native corpus cases.
 */

const ascii = (value: string): Uint8Array =>
  Uint8Array.from(value, (character) => character.charCodeAt(0))

const realized = Effect.fnUntraced(function* (name: string, source: string) {
  return yield* AnalysisFixture.retainingMain(name, ascii(source), 'wasm32-unknown-unknown')
})

const bindingCleanup = (
  snapshot: Analysis.Snapshot,
  module: string,
  name: string,
): CleanupPlan.CleanupPlan => {
  const facts = snapshot.ownership.get(module) ?? unreachable(`expected ownership for ${module}`)
  const binding = facts.functions
    .flatMap((fn) => [...fn.bindings])
    .find((candidate) => candidate.name === name)
  return binding?.cleanup ?? unreachable(`expected a cleanup plan for ${name}`)
}

const soleRealization = (snapshot: Analysis.Snapshot): FieldRealization.CallableRealization =>
  InstanceDiagnostics.callableFieldRealizations(snapshot.instances, snapshot.index)
    .entries.flatMap((entry) =>
      entry.support._tag === 'Supported' &&
      FieldRealization.isCallableRealization(entry.support.realization)
        ? [entry.support.realization]
        : [],
    )
    .at(0) ?? unreachable('expected one supported callable field realization')

const realizationOf = (
  snapshot: Analysis.Snapshot,
  owner: string,
): FieldRealization.CallableRealization =>
  InstanceDiagnostics.callableFieldRealizations(snapshot.instances, snapshot.index)
    .entries.flatMap((entry) =>
      entry.support._tag === 'Supported' &&
      FieldRealization.isCallableRealization(entry.support.realization) &&
      entry.support.realization.instance.name === owner
        ? [entry.support.realization]
        : [],
    )
    .at(0) ?? unreachable(`expected a supported callable field realization for ${owner}`)

const fieldCleanup = (plan: CleanupPlan.CleanupPlan, ordinal: number): CleanupPlan.CleanupPlan => {
  assert.strictEqual(plan._tag, 'StructCleanup')
  if (plan._tag !== 'StructCleanup') return unreachable('expected a struct cleanup')
  return (
    plan.fields.find((field) => field.field.ordinal === ordinal)?.cleanup ??
    unreachable(`expected a cleanup plan for field #${ordinal}`)
  )
}

const takeCapture = `struct Token { value: i32 }
struct Holder<F: once fn<'static>(i32) -> i32> { step: F }
fn consume(value: i32, token: Token) -> i32 { return value }
`

it.effect('records the stored callable obligation on its enclosing aggregate', () =>
  Effect.gen(function* () {
    const module = 'stored-callable-cleanup/obligation'
    const snapshot = yield* realized(
      module,
      `${takeCapture}pub fn main() -> i32 {
  let token = Token { value: 1 }
  let holder = Holder { step: consume(move token) }
  return 0
}`,
    )
    const stored = fieldCleanup(bindingCleanup(snapshot, module, 'holder'), 0)

    // The aggregate no longer plans "nothing to clean" for the callable it stores.
    assert.strictEqual(stored._tag, 'RepresentedCallableCleanup')
    if (stored._tag !== 'RepresentedCallableCleanup') return
    assert.strictEqual(Type.encode(stored.contract), "once fn<'static>(i32) -> i32")
  }),
)

it.effect('carries the obligation through a nested representation-bearing nominal', () =>
  Effect.gen(function* () {
    const module = 'stored-callable-cleanup/nested'
    const snapshot = yield* realized(
      module,
      `${takeCapture}struct Boxed<F: once fn<'static>(i32) -> i32> { inner: Holder<F> }
fn nest<F: once fn<'static>(i32) -> i32>(inner: Holder<F>) -> Boxed<F> {
  return Boxed<F> { inner: move inner }
}
pub fn main() -> i32 {
  let token = Token { value: 1 }
  let holder = Holder { step: consume(move token) }
  let boxed = nest(move holder)
  return 0
}`,
    )
    const inner = fieldCleanup(bindingCleanup(snapshot, module, 'boxed'), 0)

    // Nesting does not lose the obligation: the outer aggregate still reaches the stored lanes.
    assert.strictEqual(fieldCleanup(inner, 0)._tag, 'RepresentedCallableCleanup')
  }),
)

it.effect('resolves the obligation into ordered owned lanes from the shared realization', () =>
  Effect.gen(function* () {
    const module = 'stored-callable-cleanup/resolved'
    const snapshot = yield* realized(
      module,
      `${takeCapture}pub fn main() -> i32 {
  let token = Token { value: 1 }
  let holder = Holder { step: consume(move token) }
  return 0
}`,
    )
    const realization = soleRealization(snapshot)
    const resolved = CleanupPlan.realizedCallableCleanup(snapshot.index, realization)

    // Every fact comes from the realization: the specialized site and its owned capture lanes.
    assert.deepEqual(realization.cleanup.lanes, [0])
    assert.strictEqual(realization.cleanup.consumedByInvocation, true)
    assert.strictEqual(resolved._tag, 'CallableCleanup')
    if (resolved._tag !== 'CallableCleanup') return
    assert.strictEqual(resolved.environment._tag, 'CallableEnvironmentIdentity')
    assert.strictEqual(
      resolved.environment._tag === 'CallableEnvironmentIdentity' &&
        realization.environment !== undefined &&
        Type.equalsCallableEnvironmentIdentity(
          resolved.environment.identity,
          realization.environment,
        ),
      true,
    )
    assert.deepEqual(
      resolved.slots.map((slot) => slot.ordinal),
      [0],
    )
    assert.strictEqual(resolved.slots.at(0)?.cleanup._tag, 'StructCleanup')
  }),
)

it.effect('owes nothing for a stored callable whose captures are all Copy', () =>
  Effect.gen(function* () {
    const module = 'stored-callable-cleanup/copy'
    const snapshot = yield* realized(
      module,
      `import silk.i32
struct Adder<F: fn<'static>(i32) -> i32> { step: F }
pub fn main() -> i32 {
  let adder = Adder { step: i32.add(1) }
  return adder.step(2)
}`,
    )
    const realization = soleRealization(snapshot)
    const resolved = CleanupPlan.realizedCallableCleanup(snapshot.index, realization)

    // A Copy lane is neither loaned nor cleaned, so the aggregate carries no drop obligation.
    assert.deepEqual(realization.cleanup.lanes, [])
    assert.strictEqual(resolved._tag, 'NoCleanup')
  }),
)

it.effect('classifies a captured Drop hook as effective without a reclaim ticket', () =>
  Effect.gen(function* () {
    const module = 'stored-callable-cleanup/hook-only'
    const snapshot = yield* realized(
      module,
      `import silk.ownership { Drop }
struct Guard<F: once fn<'static>(i32) -> i32> {
  tag: i32
  marker: F
}
impl<F: once fn<'static>(i32) -> i32> Drop for Guard<F> {
  fn drop(self: &mut Guard<F>) -> () { return () }
}
fn marker(value: i32) -> i32 { return value }
struct Holder<F: once fn<'static>(i32) -> i32> { step: F }
fn consume<F: once fn<'static>(i32) -> i32>(value: i32, guard: Guard<F>) -> i32 {
  return value + guard.tag
}
pub fn main() -> i32 {
  let guard = Guard { tag: 2, marker: marker }
  let holder = Holder { step: consume(move guard) }
  return 42
}`,
    )
    const resolved = CleanupPlan.realizedCallableCleanup(
      snapshot.index,
      realizationOf(snapshot, 'Holder'),
    )

    assert.strictEqual(resolved._tag, 'CallableCleanup')
    assert.isTrue(CleanupPlan.hasHook(resolved))
    assert.isFalse(CleanupPlan.reclaims(resolved))
    assert.isTrue(CleanupPlan.hasEffect(resolved))
    const captured = resolved._tag === 'CallableCleanup' ? resolved.slots.at(0)?.cleanup : undefined
    assert.strictEqual(captured?._tag, 'HookCleanup')
    const hookArgument = captured?._tag === 'HookCleanup' ? captured.typeArguments.at(0) : undefined
    assert.isTrue(hookArgument !== undefined && Type.isExactRepresentationArgument(hookArgument))
  }),
)

it.effect('releases the stored obligation exactly once through a whole-value move', () =>
  Effect.gen(function* () {
    const module = 'stored-callable-cleanup/moved'
    const snapshot = yield* realized(
      module,
      `${takeCapture}fn keep<F: once fn<'static>(i32) -> i32>(holder: Holder<F>) -> i32 { return 0 }
pub fn main() -> i32 {
  let token = Token { value: 1 }
  let holder = Holder { step: consume(move token) }
  return keep(move holder)
}`,
    )
    const facts =
      snapshot.ownership.get(module) ?? unreachable('expected ownership for the moved module')
    const main =
      facts.functions.find(
        (fn) => fn.declaration.name._tag === 'Present' && fn.declaration.name.spelling === 'main',
      ) ?? unreachable('expected the entry function')
    const holder =
      main.bindings.find((binding) => binding.name === 'holder') ??
      unreachable('expected the holder binding')

    // The move transfers the whole environment, so no exit releases the moved aggregate again.
    assert.notStrictEqual(holder.movedAt, undefined)
    assert.deepEqual(
      main.exits.flatMap((exit) =>
        exit.releases.filter((release) => release.binding.name === 'holder'),
      ),
      [],
    )
  }),
)

it.effect('releases an uncalled stored callable once at scope exit', () =>
  Effect.gen(function* () {
    const module = 'stored-callable-cleanup/uncalled'
    const snapshot = yield* realized(
      module,
      `${takeCapture}pub fn main() -> i32 {
  let token = Token { value: 1 }
  let holder = Holder { step: consume(move token) }
  return 0
}`,
    )
    const facts = snapshot.ownership.get(module) ?? unreachable('expected ownership facts')
    const main =
      facts.functions.find(
        (fn) => fn.declaration.name._tag === 'Present' && fn.declaration.name.spelling === 'main',
      ) ?? unreachable('expected the entry function')
    const releases = main.exits.flatMap((exit) =>
      exit.releases.filter((release) => release.binding.name === 'holder'),
    )

    // An uncalled stored callable is still owned, so exactly one exit releases the aggregate.
    assert.strictEqual(releases.length, 1)
    assert.strictEqual(
      fieldCleanup(releases.at(0)?.cleanup ?? unreachable('expected a release plan'), 0)._tag,
      'RepresentedCallableCleanup',
    )
  }),
)

it.effect('releases a stored callable on a typed-failure exit', () =>
  Effect.gen(function* () {
    const module = 'stored-callable-cleanup/typed-failure'
    const snapshot = yield* realized(
      module,
      `import silk.allocator { Allocator }
import silk.allocator { OutOfMemoryError }
import silk.allocator { Allocator }
import silk.allocator { SystemAllocator }
import silk.effect { Effect }
import silk.layout { Layout }
${takeCapture}effect fn build() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let layout = Layout.of<[i32; 2]>()
  let recipe = Allocator.allocate(move layout) |> Effect.provideMut(&mut allocator)
  let token = Token { value: 1 }
  let holder = Holder { step: consume(move token) }
  let allocation = run recipe
  return 42
}
effect fn recover(error: OutOfMemoryError) -> i32 { return 7 }
pub fn main() -> i32 { return run Effect.catchAll(build(), recover) }`,
    )
    const facts = snapshot.ownership.get(module) ?? unreachable('expected ownership facts')
    const build =
      facts.functions.find(
        (fn) => fn.declaration.name._tag === 'Present' && fn.declaration.name.spelling === 'build',
      ) ?? unreachable('expected the fallible function')
    const propagation = build.exits.filter((exit) => exit.kind === 'Propagation')

    // The stranded aggregate is released on the failure path, not only on the success path.
    assert.notStrictEqual(propagation.length, 0)
    assert.include(
      propagation.flatMap((exit) => exit.releases.map((release) => release.binding.name)),
      'holder',
    )
  }),
)

const borrowCapture = `struct Holder<'env, F: mut fn<'env>(i32) -> i32> { step: F }
fn read(value: i32, values: &mut [i32]) -> i32 { return value }
`

it.effect('retains a stored capture loan for as long as the aggregate holds the callable', () =>
  Effect.gen(function* () {
    const module = 'stored-callable-cleanup/retained-loan'
    const snapshot = yield* realized(
      module,
      `${borrowCapture}pub fn main() -> i32 {
  let mut values = [1]
  let holder = Holder { step: read(&mut values) }
  values[0] = 2
  return holder.step(42)
}`,
    )
    const facts = snapshot.ownership.get(module) ?? unreachable('expected ownership facts')
    const loan = facts.functions.flatMap((fn) => [...fn.loans]).at(0)

    // The borrow is captured inside the aggregate, so writing through the owner while the
    // aggregate still holds it conflicts exactly as it does for a callable bound directly.
    assert.strictEqual(loan?.origin, 'CallableCapture')
    assert.strictEqual(loan?.access, 'Exclusive')
    assert.include(
      Analysis.diagnostics(snapshot).map((diagnostic) => diagnostic.code),
      'OWN0011',
    )
  }),
)

it.effect('releases a stored capture loan when the aggregate is dropped', () =>
  Effect.gen(function* () {
    const module = 'stored-callable-cleanup/released-loan'
    const snapshot = yield* realized(
      module,
      `${borrowCapture}pub fn main() -> i32 {
  let mut values = [1]
  let holder = Holder { step: read(&mut values) }
  drop holder
  values[0] = 2
  return values[0]
}`,
    )

    // Dropping the aggregate ends the environment it stored, so the owner is writable again.
    assert.notInclude(
      Analysis.diagnostics(snapshot).map((diagnostic) => diagnostic.code),
      'OWN0011',
    )
  }),
)

it.effect('retargets a stored capture loan through a nested whole-value move', () =>
  Effect.gen(function* () {
    const module = 'stored-callable-cleanup/nested-loan-transfer'
    const source = `${borrowCapture}struct Boxed<'env, F: mut fn<'env>(i32) -> i32> { inner: Holder<'env, F> }
pub fn main() -> i32 {
  let mut values = [1]
  let holder = Holder { step: read(&mut values) }
  let boxed = Boxed { inner: move holder }
  drop boxed
  values[0] = 2
  return values[0]
}`
    const snapshot = yield* realized(module, source)

    assert.notInclude(
      Analysis.diagnostics(snapshot).map((diagnostic) => diagnostic.code),
      'OWN0011',
    )
    const loan = snapshot.ownership
      .get(module)
      ?.functions.flatMap((fn) => [...fn.loans])
      .find((candidate) => candidate.origin === 'CallableCapture')
    const retained = loan ?? unreachable('expected the transferred callable capture loan')
    assert.strictEqual(
      source.slice(retained.endSpan.start, retained.endSpan.end).trim(),
      'drop boxed',
    )
  }),
)

it.effect('omits cleanup for a stored Effect whose exact environment is Copy', () =>
  Effect.gen(function* () {
    const module = 'stored-callable-cleanup/effect'
    const snapshot = yield* realized(
      module,
      `struct Deferred<F: Effect<i32>> { operation: F }
pub fn main() -> i32 {
  let deferred = Deferred { operation: effect { return 1 } }
  return 0
}`,
    )
    const stored = fieldCleanup(bindingCleanup(snapshot, module, 'deferred'), 0)

    assert.strictEqual(stored._tag, 'NoCleanup')
  }),
)
