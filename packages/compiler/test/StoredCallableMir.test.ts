import * as AnalysisFixture from './support/AnalysisFixture.js'
import * as SourceResolver from '../src/SourceResolver.js'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Analysis from '../src/Analysis.js'
import * as Backend from '../src/Backend.js'
import * as Instances from '../src/Instances.js'
import * as Lifetime from '../src/Lifetime.js'
import * as AuthoredIdentity from '../src/AuthoredIdentity.js'
import * as LayoutEncode from '../src/LayoutEncode.js'
import * as MirEncoding from '../src/MirEncoding.js'
import * as MirVerification from '../src/MirVerification.js'
import * as Target from '../src/Target.js'
import * as Type from '../src/Type.js'
import * as RowAlgebra from '../src/RowAlgebra.js'
import { unreachable } from './support/raise.js'

const ascii = (value: string): Uint8Array =>
  Uint8Array.from(value, (character) => character.charCodeAt(0))

const lowerAnalyzed = Effect.fnUntraced(function* (frontend: Analysis.SingleRootFrontendSnapshot) {
  const snapshot = yield* Analysis.realize(
    frontend,
    AnalysisFixture.configuration(frontend.closure.rootModule, Target.wasm32UnknownUnknown.id),
    {
      normalizeMir: false,
    },
  ).pipe(Effect.provide(SourceResolver.empty))
  assert.deepEqual(Analysis.diagnostics(snapshot), [])
  const layout =
    snapshot.layout._tag === 'Available' ? snapshot.layout.value : unreachable('expected layout')
  return { module: Analysis.loweredMir(snapshot), layout }
})

const lowerStored = Effect.fnUntraced(function* (name: string, source: string) {
  return yield* lowerAnalyzed(
    yield* AnalysisFixture.retainingMain(name, ascii(source), Target.wasm32UnknownUnknown.id),
  )
})

it.effect(
  'retains anonymous source inputs and lexical captures under a contextual invocation',
  () =>
    Effect.gen(function* () {
      const source = `struct Owner { value: i32 }
struct Guard { offset: i32 }
impl Drop for Guard { fn drop(self: &mut Guard) -> () { return () } }
effect<'data> fn applyOwned<'data>(owner: &'data Owner, callback: for<use 'call> once fn<'static>(&'data Owner) -> once Effect<'call; i32>) -> i32 {
  return run callback(owner)
}
fn probe<'data>(owner: &'data Owner) -> i32 {
  let guard = Guard { offset: 2 }
  return run applyOwned<'data>(owner, effect fn(input: &'data Owner) -> i32 {
    let consumed = move guard
    return input.value + consumed.offset
  })
}
pub fn main() -> i32 {
  let owner = Owner { value: 40 }
  return probe(&owner)
}`
      const snapshot = yield* AnalysisFixture.retainingMain(
        'stored-callable-mir/anonymous-invocation-provenance',
        ascii(source),
        Target.wasm32UnknownUnknown.id,
        { normalizeMir: false },
      )
      assert.deepEqual(Analysis.diagnostics(snapshot), [])
      const section = Analysis.expressionsOf(snapshot, snapshot.closure.rootModule).find(
        (expression) =>
          expression._tag === 'CallableSection' && expression.type.invocationUse !== undefined,
      )
      if (section?._tag !== 'CallableSection')
        return unreachable('expected contextual anonymous section')
      const schema = section.type.schema ?? unreachable('expected original anonymous schema')
      const usage = section.type.invocationUse ?? unreachable('expected source invocation binder')
      const result = section.type.result
      if (!Type.isEffect(result)) return unreachable('expected scoped anonymous Effect result')
      assert.deepEqual(Type.callableInputOrdinals(schema.contract), [0])
      assert.deepEqual(schema.contract.captures, [{ parameter: 1, capture: 0 }])
      assert.deepEqual(section.invocationParameters, [0])
      assert.deepEqual(section.remainingParameters, [0])
      assert.deepEqual(
        section.captures.map((capture) => [
          capture.ordinal,
          capture.parameterOrdinal,
          capture.access,
        ]),
        [[0, 1, 'Take']],
      )
      assert.isTrue(
        Lifetime.equals(
          result.environment,
          Lifetime.intersection([usage.lifetime, section.type.environment]),
        ),
      )
      assert.strictEqual(section.target._tag, 'DeclarationCallableTarget')
      if (section.target._tag !== 'DeclarationCallableTarget')
        return unreachable('expected original hidden declaration target')
      assert.deepEqual(schema.source, section.target.declaration)
      const hidden = [...snapshot.results.values()]
        .flatMap((result) => result.bodies)
        .find(
          (body) =>
            body.hidden &&
            body.declaration.canonical._tag === 'Canonical' &&
            body.declaration.canonical.id.name === schema.source?.name,
        )
      if (hidden === undefined) return unreachable('expected original anonymous source body')
      assert.strictEqual(schema.contract.parameters.length, hidden.declaration.parameterCount)
      assert.strictEqual(schema.binders.length, hidden.declaration.typeParameters.length)
      assert.isTrue(
        schema.binders.every((binder, ordinal) => {
          const original = hidden.declaration.typeParameters.at(ordinal)?.type
          return original !== undefined && Type.key(original) === Type.key(binder)
        }),
      )
      assert.isTrue(
        [...section.substitution].every(([identity, argument]) => {
          const selected = schema.substitution.get(identity)
          return selected !== undefined && Type.equalsGenericArgument(selected, argument)
        }),
      )
      assert.deepEqual(yield* MirVerification.verify(Analysis.loweredMir(snapshot)), [])
      const borrowedCaptureSource = source.replace(
        'let consumed = move guard\n    return input.value + consumed.offset',
        'return input.value + guard.offset',
      )
      const borrowedCapture = yield* AnalysisFixture.frontend(
        'stored-callable-mir/anonymous-invocation-borrowed-capture',
        ascii(borrowedCaptureSource),
        Target.wasm32UnknownUnknown.id,
      )
      const start = borrowedCaptureSource.indexOf('effect fn(')
      const end = borrowedCaptureSource.indexOf('\n  })', start) + 4
      assert.deepEqual(
        Analysis.diagnostics(borrowedCapture).map((diagnostic) => [
          diagnostic.code,
          diagnostic.span.start,
          diagnostic.span.end,
        ]),
        [['SEM0076', start, end]],
      )
    }),
)

it.effect(
  'carries one stored callable fact from construction through projection and invocation',
  () =>
    Effect.gen(function* () {
      const source = `struct Parser<F: fn<'static>(i32) -> i32> { parse: F }
fn decode(value: i32) -> i32 { return value + 1 }
pub fn main() -> i32 {
  let parser = Parser { parse: decode }
  return parser.parse(1)
}`
      const { module } = yield* lowerStored('stored-callable-mir/named', source)
      const operations = module.functions.flatMap(MirVerification.operations)
      const construction = operations.find((operation) => operation._tag === 'Construct')
      const invocation = operations.find((operation) => operation._tag === 'ApplyCallable')
      const projected =
        invocation?._tag === 'ApplyCallable' && invocation.callable !== undefined
          ? module.functions
              .flatMap((fn) => fn.localTypes)
              .find(
                (type) =>
                  type._tag === 'CallableValue' &&
                  type.storage !== undefined &&
                  type.storage.realization.target._tag === 'Declaration' &&
                  type.storage.realization.target.name === 'decode',
              )
          : undefined

      assert.strictEqual(construction?._tag, 'Construct')
      const constructionStorage =
        construction?._tag === 'Construct' ? construction.fields.at(0)?.stored : undefined
      assert.strictEqual(
        constructionStorage?._tag === 'StoredCallableField'
          ? constructionStorage.realization.target._tag
          : undefined,
        'Declaration',
      )
      assert.strictEqual(projected?._tag, 'CallableValue')
      assert.strictEqual(
        projected?._tag === 'CallableValue' ? projected.storage?._tag : undefined,
        'StoredCallableField',
      )
      assert.strictEqual(invocation?._tag, 'ApplyCallable')
      assert.strictEqual(
        invocation?._tag === 'ApplyCallable' ? invocation.realization : undefined,
        'Environment',
      )
      assert.deepEqual(yield* MirVerification.verify(module), [])
    }),
)

it.effect('resolves stored owned-capture cleanup before MIR', () =>
  Effect.gen(function* () {
    const source = `struct Token { value: i32 }
impl Drop for Token { fn drop(self: &mut Token) -> () { return () } }
struct Holder<F: once fn<'static>(i32) -> i32> { step: F }
fn read(value: i32, token: Token) -> i32 { return value }
pub fn main() -> i32 {
  let callback = read(Token { value: 2 })
  drop callback
  let token = Token { value: 1 }
  let holder = Holder { step: read(move token) }
  return 0
}`
    const { module } = yield* lowerStored('stored-callable-mir/cleanup', source)
    const cleanups = module.functions
      .flatMap(MirVerification.operations)
      .flatMap((operation) => (operation._tag === 'Drop' ? [operation.cleanup] : []))

    assert.notInclude(
      cleanups.map((cleanup) => cleanup._tag),
      'RepresentedCallableCleanup',
    )
    assert.isTrue(
      cleanups.some(
        (cleanup) =>
          cleanup._tag === 'CallableCleanup' &&
          cleanup.slots.some((slot) => slot.cleanup._tag === 'HookCleanup'),
      ),
    )
    assert.include(
      cleanups.flatMap((cleanup) =>
        cleanup._tag === 'StructCleanup'
          ? cleanup.fields.map((field) => field.cleanup._tag)
          : [cleanup._tag],
      ),
      'CallableCleanup',
    )
    assert.deepEqual(yield* MirVerification.verify(module), [])
  }),
)

it.effect('keeps nested layouts, instance keys, symbols, and MIR text deterministic', () =>
  Effect.gen(function* () {
    const source = `import silk.i32
struct Parser<F: fn<'static>(i32) -> i32> { parse: F }
struct Boxed<F: fn<'static>(i32) -> i32> { inner: Parser<F> }
fn box<F: fn<'static>(i32) -> i32>(inner: Parser<F>) -> Boxed<F> {
  return Boxed<F> { inner: move inner }
}
pub fn main() -> i32 {
  let parser = Parser { parse: i32.add(1) }
  let boxed = box(move parser)
  return boxed.inner.parse(2)
}`
    const frontend = yield* Analysis.ofSource('stored-callable-mir/determinism', ascii(source))
    const first = yield* lowerAnalyzed(frontend)
    const second = yield* lowerAnalyzed(frontend)
    const facts = (snapshot: typeof first) => ({
      layout: LayoutEncode.encode(snapshot.layout),
      instances: snapshot.module.functions.map((fn) => Instances.keyText(fn.instance)),
      symbols: snapshot.module.functions.map((fn) => Backend.symbolFor(fn)),
      mir: MirEncoding.encode(snapshot.module),
    })
    const encoded = facts(first)

    assert.deepEqual(encoded, facts(second))
    assert.isTrue(
      first.module.functions.some((fn) =>
        fn.instance.typeArguments.some(
          (argument) =>
            Type.isExactRepresentationArgument(argument) &&
            Type.isCallableIdentityArgument(argument.identity) &&
            argument.identity.target._tag === 'Declaration' &&
            argument.identity.target.module === 'silk/i32' &&
            argument.identity.target.name === 'add',
        ),
      ),
    )
    assert.include(encoded.symbols.join('\n'), 'silk_stored_callable_mir_determinism_box__')
    assert.include(encoded.mir, 'stored=silk/i32.add')
    assert.isTrue(
      first.module.functions
        .flatMap(MirVerification.operations)
        .some(
          (operation) =>
            operation._tag === 'ReadPlace' &&
            operation.selectors.length === 2 &&
            operation.selectors.every(
              (selector) => selector._tag === 'FieldSelector' && selector.field.ordinal === 0,
            ),
        ),
    )
    assert.deepEqual(yield* MirVerification.verify(first.module), [])
  }),
)

// The local-stage ownership actor has construction recipes in its own body. This helper's
// authored annotation exposes only one input; the actual incoming instance retains all three.
it.effect('opens an incoming staged callable and retains every original stored input', () =>
  Effect.gen(function* () {
    const source = `effect<'held> fn combine<'held>(first: &'held i32, second: &'held i32, third: &'held i32) -> i32 {
  return first.* + second.* + third.*
}
fn apply<'env>(callback: for<use 'call> once fn<'env>(&'call i32) -> once Effect<'call & 'env; i32>, value: &'env i32) -> i32 {
  return run callback(value)
}
struct Owner { value: i32 }
struct Guard { offset: i32 }
impl Drop for Guard { fn drop(self: &mut Guard) -> () { return () } }
effect<'held> fn recovered<'data: 'held, 'held>(owner: &'data Owner, guard: Guard) -> i32 {
  return owner.value + guard.offset
}
effect<'data> fn applyOwned<'data, ?S>(owner: &'data Owner, callback: for<use 'call> once fn<'static>(&'data Owner) -> once Effect<'call; i32 ? S>) -> i32 ? S {
  return run callback(owner)
}
pub fn main() -> i32 {
  let first = 1
  let second = 2
  let third = 3
  let callback: for<use 'call> once fn<'static>(&'call i32, &'call i32, &'call i32) -> once Effect<'call; i32> = combine
  let firstStage = callback(&third)
  let secondStage = firstStage(&second)
  let owner = Owner { value: 40 }
  let selected = run applyOwned(&owner, recovered(Guard { offset: 2 }))
  return apply(move secondStage, &first) + selected
}
`
    const snapshot = yield* AnalysisFixture.retainingMain(
      'stored-callable-mir/incoming-staged',
      ascii(source),
      Target.wasm32UnknownUnknown.id,
      { normalizeMir: false },
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    const module = Analysis.loweredMir(snapshot)
    const fn =
      module.functions.find(
        (fn) => fn.id.module === 'stored-callable-mir/incoming-staged' && fn.id.name === 'apply',
      ) ?? unreachable('expected genuine selected apply instance')
    const calls = MirVerification.operations(fn).filter(
      (operation) => operation._tag === 'ApplyCallable',
    )
    assert.strictEqual(calls.length, 1)
    const call = calls.at(0) ?? unreachable('expected actual incoming invocation')
    const invocation = call.invocationUse ?? unreachable('expected retained use record')
    const container = call.callable ?? unreachable('expected actual incoming callable local')
    const actual = fn.localTypes.at(container.ordinal)
    if (actual?._tag !== 'CallableValue' || actual.environment === undefined)
      return unreachable('expected real retained callable environment')
    const original = actual.type.schema?.invocationAdapter
    if (original === undefined || actual.type.invocationUse === undefined)
      return unreachable('expected original marked target schema')
    assert.deepEqual(original.originalInputs, [0, 1, 2])
    assert.deepEqual(original.parameters, [0])
    assert.strictEqual(Type.invocationUseState(call.callableType), 'Opened')
    assert.isTrue(Lifetime.equals(invocation.binder, actual.type.invocationUse.lifetime))
    const openedUse =
      call.callableType.invocationUse ?? unreachable('expected actual opened designation')
    assert.isTrue(Lifetime.equals(openedUse.lifetime, invocation.lifetime))
    const schema =
      call.callableType.schema ?? unreachable('expected authentic original callable schema')
    assert.strictEqual(
      (schema.source ?? unreachable('expected selected source target')).name,
      'combine',
    )
    const held =
      schema.contract.binders.find(
        (binder) => binder.kind === 'Lifetime' && binder.ordinal === 0,
      ) ?? unreachable('expected original combine lifetime slot zero')
    assert.strictEqual(held.owner.name, 'combine')
    const selection = schema.substitution.get(Type.key(held))
    assert.isTrue(
      selection !== undefined &&
        Lifetime.isLifetime(selection) &&
        Lifetime.equals(selection, invocation.lifetime),
    )
    const emitted = call.typeArguments.at(0)
    assert.isTrue(
      emitted !== undefined &&
        Lifetime.isLifetime(emitted) &&
        Lifetime.equals(emitted, invocation.lifetime),
    )
    assert.deepEqual(
      invocation.inputs.map((input) => input.parameter).sort((a, b) => a - b),
      [0, 1, 2],
    )
    const visible =
      invocation.inputs.find((input) => input.parameter === 0) ??
      unreachable('expected visible original input')
    assert.strictEqual(visible.capture, undefined)
    assert.strictEqual(visible.argument.ordinal, call.arguments.at(0)?.ordinal)
    const header =
      fn.sourceParameters?.find((parameter) => parameter.local.ordinal === container.ordinal) ??
      unreachable('expected genuine source parameter authority')
    assert.strictEqual(header.parameter, 0)
    const firstStored =
      invocation.inputs.find((input) => input.parameter === 1) ??
      unreachable('expected stored second input')
    const secondStored =
      invocation.inputs.find((input) => input.parameter === 2) ??
      unreachable('expected stored third input')
    assert.strictEqual(firstStored.capture, 1)
    assert.strictEqual(secondStored.capture, 0)
    for (const input of [firstStored, secondStored]) {
      const field =
        actual.environment.fields.at(input.capture ?? -1) ??
        unreachable('expected actual physical capture field')
      assert.strictEqual(field.parameterOrdinal, input.parameter)
      assert.isTrue(Type.equals(input.type, field.type))
      assert.strictEqual(input.argument.ordinal, container.ordinal)
      const authority = input.header ?? unreachable('expected real incoming header authority')
      const source = input.source ?? unreachable('expected original incoming parameter anchor')
      assert.strictEqual(authority.parameter, header.parameter)
      assert.strictEqual(
        AuthoredIdentity.anchorKey(authority.source),
        AuthoredIdentity.anchorKey(header.source),
      )
      assert.strictEqual(
        AuthoredIdentity.anchorKey(source),
        AuthoredIdentity.anchorKey(header.source),
      )
      assert.strictEqual(input.capturePath, undefined)
      if (!Type.isReference(input.type)) return unreachable('expected genuine borrowed payload')
      assert.strictEqual(input.type.lifetime._tag, 'LocalLifetime')
    }
    assert.isFalse(Type.equals(firstStored.type, secondStored.type))
    // Unlike combine, this source item was unmarked until its genuine Guard suffix formed.
    // Its two original data/use selections and the inferred consumer row must stay independent.
    const ownedInvocations = module.functions.flatMap((owner) =>
      MirVerification.operations(owner).flatMap((operation) =>
        operation._tag === 'ApplyCallable' &&
        operation.callableType.schema?.source?.name === 'recovered'
          ? [{ owner, operation }]
          : [],
      ),
    )
    assert.strictEqual(ownedInvocations.length, 1)
    const owned = ownedInvocations.at(0) ?? unreachable('expected actual owned staged invocation')
    const ownedCall = owned.operation
    const ownedUse = ownedCall.invocationUse ?? unreachable('expected owned invocation proof')
    const ownedSchema =
      ownedCall.callableType.schema ?? unreachable('expected original recovered schema')
    const ownedAdapter =
      ownedSchema.invocationAdapter ?? unreachable('expected completed section adapter')
    assert.deepEqual(ownedAdapter.originalInputs, [0, 1])
    assert.deepEqual(ownedAdapter.parameters, [0])
    assert.deepEqual(
      ownedSchema.contract.binders.map((binder) => [
        binder.owner.name,
        binder.ordinal,
        binder.kind,
      ]),
      [
        ['recovered', 0, 'Lifetime'],
        ['recovered', 1, 'Lifetime'],
      ],
    )
    const dataSlot =
      ownedSchema.contract.binders.at(0) ?? unreachable('expected original data slot')
    const heldSlot =
      ownedSchema.contract.binders.at(1) ?? unreachable('expected original held slot')
    const ownedInput =
      ownedUse.inputs.find((input) => input.parameter === 0) ??
      unreachable('expected actual borrowed Owner input')
    if (!Type.isReference(ownedInput.type)) return unreachable('expected real borrowed Owner')
    assert.strictEqual(ownedInput.type.lifetime._tag, 'LocalLifetime')
    const dataSelection = ownedSchema.substitution.get(Type.key(dataSlot))
    const heldSelection = ownedSchema.substitution.get(Type.key(heldSlot))
    assert.isTrue(
      dataSelection !== undefined &&
        Lifetime.isLifetime(dataSelection) &&
        Lifetime.equals(dataSelection, ownedInput.type.lifetime),
    )
    assert.isTrue(
      heldSelection !== undefined &&
        Lifetime.isLifetime(heldSelection) &&
        Lifetime.equals(heldSelection, ownedUse.lifetime),
    )
    assert.isFalse(Lifetime.equals(ownedInput.type.lifetime, ownedUse.lifetime))
    assert.strictEqual(ownedCall.typeArguments.length, 2)
    assert.isTrue(
      ownedCall.typeArguments.every((argument, ordinal) => {
        const selected = ordinal === 0 ? dataSelection : heldSelection
        return selected !== undefined && Type.equalsGenericArgument(argument, selected)
      }),
    )
    const ownedContainer =
      ownedCall.callable ?? unreachable('expected actual retained Guard container')
    const ownedDescriptor = owned.owner.localTypes.at(ownedContainer.ordinal)
    if (ownedDescriptor?._tag !== 'CallableValue' || ownedDescriptor.environment === undefined)
      return unreachable('expected physical section storage')
    const guardInput =
      ownedUse.inputs.find((input) => input.parameter === 1) ??
      unreachable('expected original Guard input')
    assert.strictEqual(guardInput.capture, 0)
    assert.strictEqual(guardInput.argument.ordinal, ownedContainer.ordinal)
    const guardField =
      ownedDescriptor.environment.fields.at(0) ?? unreachable('expected actual Guard field')
    assert.strictEqual(guardField.parameterOrdinal, 1)
    assert.isTrue(Type.equals(guardField.type, guardInput.type))
    assert.isTrue(Type.isNominal(guardInput.type) && guardInput.type.name === 'Guard')
    const declaredGuard = module.functions.find((fn) => fn.id.name === 'recovered')
    assert.strictEqual(declaredGuard?.parameterCount, 2)
    const ownedResult = ownedCall.callableType.result
    if (!Type.isEffect(ownedResult)) return unreachable('expected actual returned computation')
    assert.isTrue(Type.equals(ownedResult.success, 'i32'))
    assert.isTrue(
      RowAlgebra.equals(
        Type.requirementRowPolicy(),
        ownedResult.requirementRow,
        RowAlgebra.concrete(Type.requirementRowPolicy(), []),
      ),
    )
    assert.deepEqual(MirVerification.invocationUseIssues(owned.owner, module), [])
    assert.deepEqual(MirVerification.invocationUseIssues(fn, module), [])
    assert.deepEqual(yield* MirVerification.verify(module), [])
    // Mutate only the observed proof record: swapped equal-referent storage is not authority.
    const wrong = {
      ...call,
      invocationUse: {
        ...invocation,
        inputs: invocation.inputs.map((input) =>
          input.parameter === 1 ? { ...input, capture: 0 } : input,
        ),
      },
    }
    let replaced = 0
    const corrupted = {
      ...fn,
      regions: fn.regions.map((region) =>
        region._tag === 'OperationRegion'
          ? {
              ...region,
              operations: region.operations.map((operation) => {
                if (operation !== call) return operation
                replaced += 1
                return wrong
              }),
            }
          : region,
      ),
    }
    assert.strictEqual(replaced, 1)
    assert.isTrue(
      MirVerification.invocationUseIssues(corrupted, module).some(
        (issue) => issue._tag === 'InvalidInvocationUse',
      ),
    )
  }),
)
