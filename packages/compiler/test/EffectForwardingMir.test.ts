import * as Layer from 'effect/Layer'
import * as FunctionLowering from '../src/FunctionLowering.js'
import * as Instances from '../src/Instances.js'
import * as Lifetime from '../src/Lifetime.js'
import * as SourceSpan from '../src/SourceSpan.js'
import * as Type from '../src/Type.js'
import type * as Tir from '../src/Tir.js'
import * as Option from 'effect/Option'
import { unreachable } from './support/raise.js'
import * as AnalysisFixture from './support/AnalysisFixture.js'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Analysis from '../src/Analysis.js'
import * as SourceFile from '../src/SourceFile.js'
import * as SourceResolver from '../src/SourceResolver.js'
import * as MirEncoding from '../src/MirEncoding.js'
import * as MirVerification from '../src/MirVerification.js'

const encoder = new TextEncoder()

it.effect('terminates direct recursion discovered through a bound service implementation', () =>
  Effect.gen(function* () {
    const self = yield* AnalysisFixture.retainingMain(
      'effect-forwarding/direct-service-recursion',
      encoder.encode(`import silk.effect { Effect }
service Loop {
  effect fn next() -> i32 ? &mut Loop
}
struct Provider {}
effect fn next(self: &mut Provider) -> i32 ? &mut Loop {
  return run Loop.next()
}
impl Loop for Provider { next: Provider.next }
effect fn program() -> i32 ? &mut Loop {
  return run Loop.next()
}
pub fn main() -> i32 {
  let provider = Provider {}
  return run Effect.bindRequirementOwned<Loop>(program(), move provider)
}`),
    )

    assert.deepEqual(Analysis.diagnostics(self), [])
    const implementations = Analysis.instancesOf(self).instances.filter(
      (instance) => instance.key.declaration.name === 'next',
    )
    assert.strictEqual(implementations.length, 1)
  }),
)

it.effect('retains provider targets through expression and ordinary statement arms', () =>
  Effect.gen(function* () {
    const self = yield* AnalysisFixture.retainingMain(
      'effect-forwarding/service-branches',
      encoder.encode(`import silk.effect { Effect }
service Choice {
  effect fn left() -> i32 ? &mut Choice
  effect fn right() -> i32 ? &mut Choice
}
struct Provider {}
effect fn left(self: &mut Provider) -> i32 { return 20 }
effect fn right(self: &mut Provider) -> i32 { return 22 }
impl Choice for Provider { left: Provider.left right: Provider.right }
struct First {}
struct Second {}
effect fn select(input: First | Second) -> i32 ? &mut Choice {
  return match move input {
    First {} => {
      let operation = effect { return run Choice.left() }
      return run operation
    }
    Second {} => run Choice.right()
  }
}
effect fn use(input: First | Second) -> i32 ? &mut Choice {
  return run select(move input)
}
pub fn main() -> i32 {
  let provider = Provider {}
  return run Effect.bindRequirementOwned<Choice>(use(Second {}), move provider)
}`),
    )

    assert.deepEqual(Analysis.diagnostics(self), [])
    const providerTargets = Analysis.instancesOf(self).calls.filter(
      (call) =>
        call.owner.declaration.name === 'select' &&
        (call.target.declaration.name === 'left' || call.target.declaration.name === 'right'),
    )
    assert.deepEqual(providerTargets.map((call) => call.target.declaration.name).sort(), [
      'left',
      'right',
    ])
    const mir = Analysis.loweredMir(self)
    assert.deepEqual(yield* MirVerification.verify(mir), [], MirEncoding.encode(mir))
  }),
)

it.effect('keeps provided recovery families and contextual constructor contracts exact', () =>
  Effect.gen(function* () {
    const self = yield* AnalysisFixture.retainingMain(
      'effect-forwarding/execution-contract',
      encoder.encode(`import silk.effect { Effect }
import silk.allocator { Allocator, OutOfMemoryError }
import silk.vector { Vector }
service Input { effect fn count() -> i32 ? &mut Input }
struct Provider {}
effect fn count(self: &mut Provider) -> i32 { return 42 }
impl Input for Provider { count: Provider.count }
struct Payload { value: i32 }
struct FirstFailure {}
struct SecondFailure {}
effect fn first() -> i32 ! FirstFailure ? &mut Input { return run Input.count() }
effect fn second() -> Payload ! SecondFailure ? &mut Input {
  let value = run Input.count()
  return Payload { value: value }
}
effect fn append() -> () ! OutOfMemoryError ? &mut Allocator {
  let mut values = Vector.make<i32>()
  run Vector.append(&mut values, 42)
  drop values
  return ()
}
pub fn main() -> i32 {
  let mut provider = Provider {}
  let firstResult = run Effect.result(first()) |> Effect.provideMut<Input>(&mut provider)
  let secondResult = run Effect.result(second()) |> Effect.provideMut<Input>(&mut provider)
  let mut allocator = Allocator.systemAllocatorProvider()
  let appended = run Effect.result(append()) |> Effect.provideMut<Allocator>(&mut allocator)
  drop firstResult
  drop secondResult
  drop appended
  return 0
}`),
    )
    assert.deepEqual(Analysis.diagnostics(self), [])
    const mir = Analysis.loweredMir(self)
    assert.deepEqual(yield* MirVerification.verify(mir), [])
    const constructors = mir.functions.filter((fn) => fn.id.name === 'Vector.append')
    assert.isNotEmpty(constructors)
    const constructor = constructors.at(0)
    assert.strictEqual(constructor?.result._tag, 'EffectValue')
    if (constructor?.result._tag !== 'EffectValue') return
    const wrongContract = {
      ...constructor,
      result: {
        ...constructor.result,
        type: { ...constructor.result.type, success: 'i64' as const },
      },
    }
    const corrupted = {
      ...mir,
      functions: mir.functions.map((fn) => (fn === constructor ? wrongContract : fn)),
    }
    assert.isTrue(
      (yield* MirVerification.verify(corrupted)).some(
        (violation) => violation.rule === 'InvalidCallShape',
      ),
    )
  }),
)

it.effect('preserves observed application closure parameters through native startup', () =>
  Effect.gen(function* () {
    const self = yield* Analysis.makeRealized({
      root: 'effect-forwarding/native-start',
      configuration: { profile: { target: 'x86_64-unknown-linux-gnu', artifact: 'executable' } },
    }).pipe(
      Effect.provide(
        SourceResolver.overlay([
          SourceFile.make(
            'effect-forwarding/native-start',
            encoder.encode('pub fn main() -> i32 { return 42 }'),
          ),
        ]).pipe(Layer.provideMerge(SourceResolver.empty)),
      ),
    )
    assert.deepEqual(Analysis.diagnostics(self), [])
    assert.deepEqual(yield* MirVerification.verify(Analysis.loweredMir(self)), [])
  }),
)

it.effect('reuses exact provider runners across distinct lexical proof origins', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'effect-forwarding/contextual-provider',
      encoder.encode(`import silk.effect {Effect}
service Clock { effect fn tick() -> i32 ? &mut Clock }
service Input { effect fn read() -> i32 ? &mut Input | &mut Clock }
struct ClockProvider {}
struct InputProvider {}
impl Clock for ClockProvider {
  effect fn tick(self: &mut Self) -> i32 { return 21 }
}
impl Input for InputProvider {
  effect fn read(self: &mut Self) -> i32 ? &mut Clock { return run Clock.tick() }
}
struct Holder<P> { provider: P }
impl<P> Holder<P> {
  effect fn read(self: &mut Self) -> i32 ? &mut Clock
  where &mut P provides &Input from &mut Input | &mut Clock {
    return run Input.read() |> Effect.provideMut<Input>(&mut self.provider)
  }
}
effect fn first<P>(holder: &mut Holder<P>) -> i32 ? &mut Clock
where &mut P provides &Input from &mut Input | &mut Clock {
  return run Holder.read(&mut holder.*)
}
effect fn second<P>(holder: &mut Holder<P>) -> i32 ? &mut Clock
where &mut P provides &Input from &mut Input | &mut Clock {
  return run Holder.read(&mut holder.*)
}
pub fn main() -> i32 {
  let mut clock = ClockProvider {}
  let mut holder = Holder {provider: InputProvider {}}
  let a = run first(&mut holder) |> Effect.provideMut<Clock>(&mut clock)
  let b = run second(&mut holder) |> Effect.provideMut<Clock>(&mut clock)
  return a + b
}
`),
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    assert.deepEqual(yield* MirVerification.verify(Analysis.loweredMir(snapshot)), [])
  }),
)

it('recovers admitted call providers across proof lifetimes without changing physical targets', () => {
  const key = (name: string): Instances.InstanceKey => ({
    _tag: 'InstanceKey',
    declaration: { _tag: 'CanonicalDeclarationId', module: 'provider-lookup', name },
    typeArguments: [],
    evidence: [],
    staticArguments: [],
    contractRow: [],
  })
  const owner = key('caller')
  const span = Option.getOrElse(
    SourceSpan.make(SourceFile.make('provider-lookup', encoder.encode('x')), 0, 1),
    () => unreachable('valid span'),
  )
  const capability = Type.nominal('provider-lookup', 'Transport', [])
  const first = Lifetime.local(owner.declaration, 'read', 0)
  const second = Lifetime.local(owner.declaration, 'write', 0)
  const provider = (lifetime: Lifetime.Local, name = 'Loan'): Instances.CallProvider => ({
    capability,
    role: 'DefaultRole',
    providerType: Type.nominal('provider-lookup', name, [lifetime]),
  })
  const retained: Instances.CallInstance = {
    _tag: 'CallInstance',
    owner,
    span,
    target: key('result'),
    providers: [provider(first)],
    resultEffect: 'first',
  }
  const select = (calls: ReadonlyArray<Instances.CallInstance>, selected: Instances.CallProvider) =>
    FunctionLowering.selectCall(calls, owner, { span }, undefined, [], [], [selected])
  assert.strictEqual(select([retained], provider(first)), retained)
  assert.strictEqual(select([retained], provider(second)), retained)
  const required = provider(second)
  assert.strictEqual(
    FunctionLowering.selectCall(
      [retained],
      owner,
      { span },
      retained.target.declaration,
      [],
      [],
      [required],
      required,
    ),
    retained,
  )
  assert.isUndefined(select([retained], provider(second, 'OtherLoan')))
  const exact = { ...retained, target: key('exact'), providers: [provider(second)] }
  assert.strictEqual(select([retained, exact], provider(second)), exact)
  const ambiguous = { ...retained, target: key('otherTarget') }
  assert.isUndefined(select([retained, ambiguous], provider(second)))
  assert.isUndefined(select([retained], { ...provider(second), role: 'OtherRole' }))
  assert.isUndefined(
    select([retained], {
      ...provider(second),
      capability: Type.nominal('provider-lookup', 'OtherTransport', []),
    }),
  )
})

it('selects independently expanded calls that share one authored span', () => {
  const key = (name: string): Instances.InstanceKey => ({
    _tag: 'InstanceKey',
    declaration: { _tag: 'CanonicalDeclarationId', module: 'static-expansion', name },
    typeArguments: [],
    evidence: [],
    staticArguments: [],
    contractRow: [],
  })
  const owner = key('caller')
  const span = Option.getOrElse(
    SourceSpan.make(SourceFile.make('static-expansion', encoder.encode('x')), 0, 1),
    () => unreachable('valid span'),
  )
  const first: Instances.CallInstance = {
    _tag: 'CallInstance',
    owner,
    node: { _tag: 'TirNode', ordinal: 1 },
    span,
    target: key('first'),
  }
  const second: Instances.CallInstance = {
    _tag: 'CallInstance',
    owner,
    node: { _tag: 'TirNode', ordinal: 2 },
    span,
    target: key('second'),
  }

  assert.strictEqual(
    FunctionLowering.selectCall(
      [first, second],
      owner,
      { span, id: { _tag: 'TirNode', ordinal: 2 } },
      undefined,
      [],
      [],
    ),
    second,
  )
})

it('selects the admitted service edge in its original provider context', () => {
  const key = (name: string): Instances.InstanceKey => ({
    _tag: 'InstanceKey',
    declaration: { _tag: 'CanonicalDeclarationId', module: 'service-edge', name },
    typeArguments: [],
    evidence: [],
    staticArguments: [],
    contractRow: [],
  })
  const owner = key('caller')
  const span = Option.getOrElse(
    SourceSpan.make(SourceFile.make('service-edge', encoder.encode('x')), 0, 1),
    () => unreachable('valid span'),
  )
  const selected: Instances.CallProvider = {
    capability: Type.nominal('service-edge', 'FileSystem', []),
    providerType: Type.nominal('service-edge', 'Files', []),
    role: 'DefaultRole',
  }
  const unrelated: Instances.CallProvider = {
    capability: Type.nominal('service-edge', 'Clock', []),
    providerType: Type.nominal('service-edge', 'Timer', []),
    role: 'DefaultRole',
  }
  const node: Tir.NodeId = { _tag: 'TirNode', ordinal: 1 }
  const contextFree: Instances.CallInstance = {
    _tag: 'CallInstance',
    owner,
    node,
    span,
    target: key('removeFile'),
    resultEffect: 'original-result',
  }
  const contextual: Instances.CallInstance = { ...contextFree, providers: [selected] }
  const select = (
    calls: ReadonlyArray<Instances.CallInstance>,
    available: ReadonlyArray<Instances.CallProvider> = [selected, unrelated],
  ) =>
    FunctionLowering.selectCall(
      calls,
      owner,
      { span, id: node },
      contextFree.target.declaration,
      [],
      [],
      available,
      selected,
    )
  assert.strictEqual(select([contextFree, contextual]), contextual)
  assert.strictEqual(select([contextFree]), contextFree)
  assert.isUndefined(select([contextFree], [unrelated]))
  assert.strictEqual(
    select([
      contextFree,
      { ...contextual, providers: [{ ...selected, providerType: unrelated.providerType }] },
    ]),
    contextFree,
  )
  assert.strictEqual(
    select([contextFree, { ...contextual, target: key('otherTarget') }]),
    contextFree,
  )
  assert.strictEqual(
    select([
      contextFree,
      {
        ...contextual,
        target: {
          ...contextual.target,
          typeArguments: [Type.nominal('service-edge', 'ForeignArgument', [])],
        },
      },
    ]),
    contextFree,
  )
  assert.isUndefined(select([contextual], [unrelated]))
  assert.isUndefined(select([{ ...contextual, providers: [unrelated] }]))
  assert.isUndefined(select([{ ...contextual, providers: [{ ...selected, role: 'OtherRole' }] }]))
  assert.isUndefined(
    select([{ ...contextual, providers: [{ ...selected, providerType: unrelated.providerType }] }]),
  )
  assert.isUndefined(select([{ ...contextual, target: key('otherTarget') }]))
  assert.isUndefined(select([contextual, { ...contextual, resultEffect: 'foreign-result' }]))
})
