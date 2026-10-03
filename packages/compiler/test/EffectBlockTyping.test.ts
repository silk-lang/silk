import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Analysis from '../src/Analysis.js'
import * as AnalysisFixture from './support/AnalysisFixture.js'
import * as Tir from '../src/Tir.js'
import * as Type from '../src/Type.js'

const ascii = (value: string): Uint8Array =>
  Uint8Array.from(value, (character) => character.charCodeAt(0))

const analyze = (text: string) => Analysis.ofSource('root', ascii(text))

const codes = (self: Analysis.FrontendSnapshot): ReadonlyArray<string> =>
  Analysis.diagnostics(self).map((diagnostic) => diagnostic.code)

it.effect('provides a conditional generic callback context with extended rows', () =>
  Effect.gen(function* () {
    const source = `import silk.effect {Effect}
struct Problem {}
service Audit { effect fn record() -> () ? &mut Audit }
service Context<P, A, E, ?R> { effect<'env> fn use<'env>(provider: P) -> A ! E ? R | &mut Context<P, A, E, R> }
interface Handler<P, A, E, ?R> { effect<'env> fn handle<'env>(handler: Self, provider: P) -> A ! E ? R }
struct Consumer<P, A, E, ?R, H> { handler: H }
effect fn unavailable<A>() -> A { return run unavailable<A>() }
effect<'env> fn acquire<P: 'env,A,E,?R, 'env>(provider: P) -> A ! E ? R | &mut Context<P,A,E,R> { drop provider return run unavailable<A>() }
impl<P, A, E, ?R, H: Handler<P, A, E ? R>> Context<P, A, E | Problem ? R | &mut Audit> for Consumer<P, A, E, R, H> {
  effect<'env> fn use<'env>(self: &mut Self, provider: P) -> A ! E | Problem ? R | &mut Audit { drop provider return run unavailable<A>() }
}
effect<'env> fn invoke<P: 'env, A, E, ?R, H: Handler<P, A, E ? R> + 'env, 'env>(provider: P, handler: H) -> A ! E | Problem ? R | &mut Audit {
  let mut context = Consumer<P, A, E, R, H> {handler: move handler}
  return run acquire<P, A, E | Problem, R | &mut Audit>(move provider)
    |> Effect.provideMut<Context<P, A, E | Problem ? R | &mut Audit>>(&mut context)
}
effect<'env> fn unproven<P: 'env, A, E, ?R, H: 'env, 'env>(provider: P, handler: H) -> A ! E | Problem ? R | &mut Audit {
  let mut context = Consumer<P, A, E, R, H> {handler: move handler}
  return run acquire<P, A, E | Problem, R | &mut Audit>(move provider)
    |> Effect.provideMut<Context<P, A, E | Problem ? R | &mut Audit>>(&mut context)
}
pub fn main() -> i32 { return 0 }`
    const self = yield* Analysis.ofSource('conditional-provider', ascii(source))
    assert.deepEqual(codes(self), ['SEM0123'])
    const diagnostic = Analysis.diagnostics(self).at(0)
    assert.strictEqual(diagnostic?.span.start, source.lastIndexOf('acquire<P, A, E | Problem'))
  }),
)

it.effect('surfaces disagreeing effect-block return types instead of last-return-wins', () =>
  Effect.gen(function* () {
    // Joinable-but-different return types form the canonical union join, so the block types as
    // Effect<bool | i32> and the surrounding i32 context rejects it — never a silent adoption of
    // the lexically last return's type. (A join with no union form reports SEM0163 directly.)
    const self = yield* analyze(`pub fn main() -> i32 {
  let flag = true
  let deferred = effect {
    if flag { return true }
    return 1
  }
  return run deferred
}`)
    assert.include(codes(self), 'SEM0040')
  }),
)

it.effect('keeps a failure raised inside an unsafe block in the effect failure row', () =>
  Effect.gen(function* () {
    // Pre-fix, terminals under `unsafe { }` were invisible to effect-block typing, so this run
    // site was accepted with an empty failure row and the failure escaped unchecked.
    const self = yield* analyze(`struct Boom { code: i32 }
pub fn main() -> i32 {
  let flag = true
  let deferred = effect {
    if flag { unsafe { fail Boom { code: 1 } } }
    return 42
  }
  return run deferred
}`)
    assert.include(codes(self), 'SEM0066')
  }),
)

it.effect('keeps a generic value-parameter failure in the effect failure row', () =>
  Effect.gen(function* () {
    // Pre-fix the nominal-only filter dropped the type-parameter failure, so the specialized
    // failure escaped the run site's unhandled-failure check.
    const self = yield* analyze(`struct Boom { code: i32 }
fn wrap<E>(flag: bool, problem: E) -> i32 {
  let deferred = effect {
    if flag { fail move problem }
    return 1
  }
  return run deferred
}
pub fn main() -> i32 { return wrap<Boom>(true, Boom { code: 7 }) }`)
    assert.include(codes(self), 'SEM0066')
  }),
)

it.effect('propagates fixed and outer generic failures through ensuringNonParking', () =>
  Effect.gen(function* () {
    const accepted = yield* analyze(`import silk.effect { Effect }
struct FixedFailure { code: i32 }
effect fn forward<'env, A, E>(
  protected: once Effect<'env; A ! E | FixedFailure>,
  finalizer: once Effect<'env; ()>,
) -> A ! E | FixedFailure {
  return run Effect.ensuringNonParking(move protected, move finalizer)
}
pub fn main() -> i32 { return 42 }`)
    assert.notInclude(codes(accepted), 'SEM0066')

    const rejected = yield* analyze(`struct FixedFailure { code: i32 }
effect fn reject<'env, A, E>(protected: once Effect<'env; A ! E | FixedFailure>) -> A ! E {
  return run move protected
}
pub fn main() -> i32 { return 42 }`)
    assert.include(codes(rejected), 'SEM0066')
  }),
)

it.effect('excludes one service from an otherwise open callback requirement row', () =>
  Effect.gen(function* () {
    const accepted = yield* analyze(`struct Lease {}
service Duplex { effect fn touch() -> () ? &mut Duplex }
service Audit { effect fn record() -> () ? &mut Audit }
service Envelope<P> {}
effect fn consume<?R>() -> () ? R where R in Without<R, &mut Duplex> { return () }
effect fn extendGeneric<P, ?R>() -> () ? R | &mut Envelope<P> where R in Without<R, &mut Duplex> {
  return run consume<R | &mut Envelope<P>>()
}
effect fn extend<?R>() -> () ? R | &mut Audit where R in Without<R, &mut Duplex> {
  return run consume<R | &mut Audit>()
}
effect fn scoped<'env, A, E, ?R>(
  lease: &'env mut Lease,
  callback: for<'call> once fn<'env>(
    &'call mut Lease
  ) -> once Effect<'call; A ! E ? R>,
) -> A ! E ? R | &mut Duplex
where R in Without<R, &mut Duplex> {
  return run callback(move lease)
}
effect fn forward<'env, A, E, ?R>(
  lease: &'env mut Lease,
  callback: for<'call> once fn<'env>(&'call mut Lease) -> once Effect<'call; A ! E ? R>,
) -> A ! E ? R | &mut Duplex
where R in Without<R, &mut Duplex> {
  return run scoped(move lease, move callback)
}
effect fn audited(lease: &mut Lease) -> i32 ? &mut Audit { drop lease run Audit.record() return 42 }
effect fn accepted(lease: &mut Lease) -> i32 ? &mut Audit | &mut Duplex { return run forward(move lease, audited) }
pub fn main() -> i32 { return 42 }`)
    assert.deepEqual(codes(accepted), [])

    const rejected = yield* analyze(`struct Lease {}
service Duplex { effect fn touch() -> () ? &mut Duplex }
service Audit { effect fn record() -> () ? &mut Audit }
effect fn consume<?R>() -> () ? R where R in Without<R, &mut Duplex> { return () }
effect fn unproven<?R>() -> () ? R | &mut Audit {
  return run consume<R | &mut Audit>()
}
effect fn forbidden<?R>() -> () ? R | &mut Duplex where R in Without<R, &mut Duplex> {
  return run consume<R | &mut Duplex>()
}
effect fn scoped<'env, A, E, ?R>(
  lease: &'env mut Lease,
  callback: for<'call> once fn<'env>(
    &'call mut Lease
  ) -> once Effect<'call; A ! E ? R>,
) -> A ! E ? R | &mut Duplex
where R in Without<R, &mut Duplex> {
  return run callback(move lease)
}
effect fn bypass(lease: &mut Lease) -> i32 ? &mut Duplex { drop lease run Duplex.touch() return 42 }
effect fn rejected(lease: &mut Lease) -> i32 ? &mut Duplex { return run scoped(move lease, bypass) }
pub fn main() -> i32 { return 42 }`)
    assert.deepEqual(codes(rejected), ['SEM0074', 'SEM0074', 'SEM0074'])
  }),
)

it.effect('retains failure and service rows of operations run inside a deferred block', () =>
  Effect.gen(function* () {
    const self = yield* AnalysisFixture.retainingMain(
      'root',
      ascii(`import silk.host_input { HostInput, HostInputError }
effect fn deferred() -> Effect<'static; usize ! HostInputError ? &mut HostInput> ! HostInputError ? &mut HostInput {
  return effect { return run HostInput.argumentCount() }
}
pub fn main() -> i32 { let value = deferred() drop value return 42 }`),
    )
    assert.deepEqual(codes(self), [])
    const blocks = self.instances.instances
      .flatMap((instance) => instance.function.statements)
      .flatMap(Tir.statementExpressions)
      .flatMap(Tir.expressionTree)
      .flatMap((expression) =>
        expression._tag === 'EffectBlock' && expression.type.success === 'usize'
          ? [expression]
          : [],
      )
    assert.isAbove(blocks.length, 0)
    for (const block of blocks) {
      assert.deepEqual(Type.failureMembers(block.type).map(Type.encode), [
        'silk/host_input.HostInputError',
      ])
      assert.deepEqual(
        Type.requirementMembers(block.type).map((requirement) =>
          Type.encode(requirement.capability),
        ),
        ['silk/host_input.HostInput'],
      )
    }
  }),
)
