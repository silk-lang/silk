import { records } from './support/records.js'
import {
  borrowedCaptureSection,
  constrainedCallableForwarding,
  constrainedSectionGenericOwner,
  genericItemPipelineInGenericOwner,
  ownerTypedDirectSection,
  relayedSection,
} from './support/corpus.js'
import * as Layer from 'effect/Layer'
import * as AnalysisFixture from './support/AnalysisFixture.js'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Analysis from '../src/Analysis.js'
import * as Backend from '../src/Backend.js'
import * as BodyView from '../src/BodyView.js'
import * as DeclarationFacts from '../src/DeclarationFacts.js'
import * as Diagnostic from '../src/Diagnostic.js'
import * as FormattedDocument from '../src/FormattedDocument.js'
import * as Instances from '../src/Instances.js'
import * as Layout from '../src/Layout.js'
import * as Lifetime from '../src/Lifetime.js'
import * as TypeInference from '../src/internal/TypeInference.js'
import * as Lexer from '../src/Lexer.js'
import * as Mir from '../src/Mir.js'
import * as MirEncoding from '../src/MirEncoding.js'
import * as MirVerification from '../src/MirVerification.js'
import * as ModuleSurface from '../src/ModuleSurface.js'
import * as Parser from '../src/Parser.js'
import * as RowAlgebra from '../src/RowAlgebra.js'
import * as OwnershipEncoding from '../src/OwnershipEncoding.js'
import * as SourceFile from '../src/SourceFile.js'
import * as SourceResolver from '../src/SourceResolver.js'
import * as SourceSpan from '../src/SourceSpan.js'
import type * as StaticValue from '../src/StaticValue.js'
import * as Tir from '../src/Tir.js'
import * as SyntaxFormatter from '../src/SyntaxFormatter.js'
import * as SyntaxTree from '../src/SyntaxTree.js'
import * as Type from '../src/Type.js'
import * as TypeOutlives from '../src/TypeOutlives.js'
import * as Json from './support/Json.js'
import * as Projections from './support/projections.js'
import { unreachable } from './support/raise.js'

const source = `fn identity<T>(value: T) -> T { return move value }
pub fn main() -> i32 {
  let flag = identity(true)
  return identity<i32>(42)
}`

const file = SourceFile.make('generics/Main', new TextEncoder().encode(source))

const descendants = (node: SyntaxTree.Node): ReadonlyArray<SyntaxTree.Node> =>
  node.children.flatMap((child): ReadonlyArray<SyntaxTree.Node> =>
    SyntaxTree.isNode(child) ? [child, ...descendants(child)] : [],
  )

it.effect('admits detached generic nominal failure payloads', () =>
  Effect.gen(function* () {
    const source = `struct Failure<E> { error: E }
effect<'env> fn wrap<E: Intrinsic.Detached + 'env, F, 'env>(error: E) -> () ! Failure<E> | F {
  fail Failure<E> { error: move error }
}
effect<'env> fn reject<E: 'env, 'env>(error: E) -> () ! Failure<E> {
  fail Failure<E> { error: move error }
}`
    const snapshot = yield* Analysis.ofSource(
      'generics/nominal-failure',
      new TextEncoder().encode(source),
    )
    assert.deepEqual(
      Analysis.diagnostics(snapshot).map((diagnostic) => diagnostic.code),
      ['SEM0061', 'SEM0061'],
    )
    assert.isTrue(
      Analysis.diagnostics(snapshot).every(
        (diagnostic) => diagnostic.span.start >= source.indexOf("effect<'env> fn reject<"),
      ),
    )
    const wrap =
      snapshot.index.modules
        .flatMap((module) => module.declarations)
        .filter((declaration) => declaration._tag === 'FunctionDeclaration')
        .find(
          (declaration) =>
            declaration.name._tag === 'Present' && declaration.name.spelling === 'wrap',
        ) ?? unreachable('missing wrap')
    const failures = RowAlgebra.positiveConcreteMembers(
      Type.failureRowPolicy(),
      wrap.failureRow.row,
    )
    assert.strictEqual(failures.length, 1)
    assert.isTrue(failures.some((failure) => Type.isNominal(failure) && failure.name === 'Failure'))
  }),
)

it.effect('lowers relay calls carrying a section environment named before its applications', () =>
  Effect.gen(function* () {
    // `select(true)` leaves `U` unapplied; the relay instance is keyed by the section's closed
    // callable type, and each relay call in `main` must select exactly that instance.
    const snapshot = yield* AnalysisFixture.retainingMain(
      'generics/relayed-section',
      new TextEncoder().encode(relayedSection),
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    const mir = Analysis.loweredMir(snapshot)
    assert.deepEqual(yield* MirVerification.verify(mir), [])
    const main = mir.functions.find((fn) => fn.id.name === 'main') ?? unreachable('expected main')
    assert.isFalse(
      main.regions.some(
        (region) => region._tag === 'OperationRegion' && region.outcome._tag === 'Trap',
      ),
    )
    const relays = main.regions.flatMap((region) =>
      region._tag === 'OperationRegion'
        ? region.operations.flatMap((operation) =>
            operation._tag === 'Call' && operation.target.name === 'forward'
              ? [operation.typeArguments.map(Type.genericArgumentKey).join()]
              : [],
          )
        : [],
    )
    const recorded = Analysis.instancesOf(snapshot)
      .calls.filter(
        (call) =>
          call.owner.declaration.name === 'main' && call.target.declaration.name === 'forward',
      )
      .map((call) => call.target.typeArguments.map(Type.genericArgumentKey).join())
    assert.strictEqual(relays.length, 2)
    assert.sameMembers(relays, recorded)
    // Both relay instances share one visible key and differ only in the hidden callable identity;
    // each is exactly one recorded relay call, and neither body traps.
    const forwards = mir.functions.filter((fn) => fn.id.name === 'forward')
    assert.strictEqual(forwards.length, 2)
    assert.strictEqual(
      new Set(
        forwards.map((fn) =>
          fn.instance.typeArguments
            .filter((argument) => !Type.isHiddenExecutableArgument(argument))
            .map(Type.genericArgumentKey)
            .join(),
        ),
      ).size,
      1,
    )
    assert.sameMembers(
      forwards.map((fn) => fn.instance.typeArguments.map(Type.genericArgumentKey).join()),
      recorded,
    )
    for (const fn of forwards)
      assert.isFalse(
        fn.regions.some(
          (region) => region._tag === 'OperationRegion' && region.outcome._tag === 'Trap',
        ),
      )
  }),
)

it.effect('infers literal lifetimes alongside empty and concrete requirement rows', () =>
  Effect.gen(function* () {
    const snapshot = yield* Analysis.ofSource(
      'generics/literal-row-lifetimes',
      new TextEncoder().encode(`service Clock {}
service Logger {}
struct Context<'value, ?R> { value: &'value i32 }
fn construct<?R>(value: &i32) -> () {
  let empty = Context<never> { value: value }
  let concrete = Context<(&mut Clock) | (&Logger)> { value: value }
  let generic = Context<R> { value: value }
  drop empty
  drop concrete
  drop generic
  return ()
}`),
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
  }),
)

it.effect('selects applied services explicitly from open provider constraint rows', () =>
  Effect.gen(function* () {
    const snapshot = yield* Analysis.ofSource(
      'generics/applied-provider-constraint',
      new TextEncoder().encode(`service Envelope<T> {}
struct Provider {}
impl Envelope<i32> for Provider {}
fn require<?R, P>(provider: &mut P) -> ()
where &mut P provides &Envelope<i32> from R | &mut Envelope<i32> {
  drop provider
  return ()
}
fn invoke<?R>(provider: &mut Provider) -> () {
  return require<R>(move provider)
}`),
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
  }),
)

it.effect('specializes retained service lifetimes at named operation calls', () =>
  Effect.gen(function* () {
    const snapshot = yield* Analysis.ofSource(
      'generics/service-retained-lifetime',
      new TextEncoder().encode(`struct Request<'policy> { value: &'policy i32 }
struct Handler<'policy, E, ?R> { value: &'policy i32 }
struct Response<'policy, A> {
  value: A
  policy: &'policy i32
}
service Dispatch<'policy, H, A, E, ?R> {
  effect<'env> fn use<'env>(value: Request<'policy>, handler: H) -> A ! E ? R | &mut Dispatch<'policy, H, A, E, R>
}
fn prepare<'policy>(value: Request<'policy>) -> Request<'policy> { return move value }
effect<'env> fn forward<'policy, A, E: 'env, ?R, 'env>(value: Request<'policy>, handler: Handler<'policy, E, R>) -> Response<'policy, A>
! E ? R | &mut Dispatch<'policy, Handler<'policy, E, R>, Response<'policy, A>, E, R> {
  let prepared = prepare(move value)
  return run Dispatch.use<'policy, Handler<'policy, E, R>, Response<'policy, A>, E, R>(move prepared, move handler)
}
pub fn main() -> i32 { return 0 }`),
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
  }),
)

it.effect('infers an applied interface provider independently of invocation lifetimes', () =>
  Effect.gen(function* () {
    const source = `struct View<'value, T> { value: &'value mut T }
struct Uri<'value> { value: &'value i32 }
fn uri<'value>(value: &'value i32) -> Uri<'value> { return Uri<'value> {value: value} }
interface Handle<T> {
  fn handle<'call, 'view: 'call>(handler: Self, name: Uri<'call>, view: &'call mut View<'view, T>) -> ()
}
fn forward<'call, 'view: 'call, T, H: Handle<T>>(
  handler: H, value: &'call i32, view: &'call mut View<'view, T>,
) -> () {
  return Handle<T>.handle(move handler, uri(value), move view)
}
fn wrong<'call, 'view: 'call, T, H: Handle<T>>(
  handler: H, view: &'call mut View<'view, T>,
) -> () {
  return Handle<T>.handle(move handler, true, move view)
}`
    const snapshot = yield* Analysis.ofSource(
      'generics/applied-provider-lifetimes',
      new TextEncoder().encode(source),
    )
    assert.deepEqual(
      Analysis.diagnostics(snapshot).map((diagnostic) => ({
        code: diagnostic.code,
        start: diagnostic.span.start,
      })),
      [{ code: 'SEM0012', start: source.lastIndexOf('true') }],
    )
  }),
)

it.effect('preserves access in nonfinal concrete nominal requirement arguments', () =>
  Effect.gen(function* () {
    const snapshot = yield* Analysis.ofSource(
      'generics/nominal-row-access',
      new TextEncoder().encode(`service Clock {}
service Logger {}
struct Rows<?Acquisition, ?Handler> {}
fn preserve<?R>(value: Rows<R | (&mut Clock) | (&Logger), never>) -> () {
  drop value
}`),
    )
    assert.deepEqual(
      Analysis.diagnostics(snapshot).map((diagnostic) => diagnostic.code),
      [],
    )
    const parameter = Analysis.declarationIndex(snapshot)
      .modules.at(0)
      ?.declarations.find(
        (declaration) =>
          declaration.name._tag === 'Present' && declaration.name.spelling === 'preserve',
      )
      ?.parameters.at(0)?.declaredType
    if (parameter?._tag !== 'Resolved' || !Type.isNominal(parameter.type))
      return unreachable('expected resolved Rows parameter')
    const row = parameter.type.arguments.at(0)
    if (row === undefined || !Type.isRequirementRowArgument(row))
      return unreachable('expected acquisition requirement row')
    assert.deepEqual(
      Type.requirementMembers(row).map((requirement) => [
        requirement.capability.name,
        requirement.access,
      ]),
      [
        ['Clock', 'Exclusive'],
        ['Logger', 'Shared'],
      ],
    )
    assert.deepEqual(
      Type.requirementRowParameters(row).map((rowParameter) => rowParameter.name),
      ['R'],
    )
  }),
)

it.effect('keeps operation-local lifetime bounds out of nominal contract applications', () =>
  Effect.gen(function* () {
    const module = 'generics/contract-local-lifetimes'
    const snapshot = yield* Analysis.ofSource(
      module,
      new TextEncoder().encode(`
service Context<P> { effect<'env> fn use<'env>(value: P) -> () ? &mut Context<P> }
interface Handler<P> { effect<'env> fn handle<'env>(handler: Self, value: P) -> () }
service Bounded<'data, P: 'data> {}
struct Holder<'data, P> { value: &'data P }
pub fn main() -> i32 { return 0 }
`),
    )
    assert.deepEqual(
      Analysis.diagnostics(snapshot).map((diagnostic) => diagnostic.code),
      [],
    )
    const scope = TypeOutlives.context(snapshot.index.modules)
    const argument = Type.parameter({ module, name: 'caller' }, 0, 'T')
    for (const name of ['Context', 'Handler'])
      assert.deepEqual(TypeOutlives.application(Type.nominal(module, name, [argument]), scope), [])
    for (const name of ['Bounded', 'Holder']) {
      const failures = TypeOutlives.application(
        Type.nominal(module, name, [Lifetime.staticLifetime, argument]),
        scope,
      )
      assert.strictEqual(failures.length, 1)
      assert.deepEqual(failures.at(0)?.required, Lifetime.staticLifetime)
    }
  }),
)

it.effect('preserves access in nonfinal concrete call requirement arguments', () =>
  Effect.gen(function* () {
    const module = 'generics/call-row-access'
    const snapshot = yield* Analysis.ofSource(
      module,
      new TextEncoder().encode(`service Clock {}
service Logger {}
fn select<?Acquisition, ?Handler>() -> i32 { return 42 }
pub fn main() -> i32 {
  return select<&mut Clock | &Logger, never>()
}`),
    )
    assert.deepEqual(
      Analysis.diagnostics(snapshot).map((diagnostic) => diagnostic.code),
      [],
    )
    const returned = records(Analysis.rootAnalysis(snapshot)).functions.find(
      (candidate) =>
        candidate.declaration.name._tag === 'Present' &&
        candidate.declaration.name.spelling === 'main',
    )?.returnedExpression
    assert.strictEqual(returned?._tag, 'Call')
    if (returned?._tag !== 'Call') return
    assert.deepEqual(returned.typeArguments.map(Type.encodeGenericArgument), [
      `? &mut ${module}.Clock | &${module}.Logger`,
      '? ',
    ])
  }),
)

it.effect('does not bind erased implicit service-row lifetimes to the provider', () =>
  Effect.gen(function* () {
    const snapshot = yield* Analysis.ofSource(
      'generics/conformance-service-row-lifetimes',
      new TextEncoder().encode(`service Clock {}
service Allocator {}
interface Contract<?Acquisition, ?Handler> {}
struct Provider {}
impl Contract<&mut Clock | &mut Allocator, never> for Provider {}`),
    )
    const conformance = Analysis.declarationIndex(snapshot).modules.at(0)?.conformances.at(0)
    assert.isDefined(conformance)
    if (conformance === undefined) return
    assert.strictEqual(
      conformance.typeParameters.filter((parameter) => parameter.implicitLifetime === true).length,
      0,
    )
    assert.deepEqual(
      conformance.provider._tag === 'Resolved'
        ? Type.freeLifetimes(conformance.provider.type).map(Lifetime.key)
        : undefined,
      [],
    )
    assert.deepEqual(
      conformance.capability._tag === 'Resolved'
        ? Type.freeLifetimes(conformance.capability.type).map(Lifetime.key)
        : undefined,
      [],
    )
    assert.deepEqual(
      Analysis.diagnostics(snapshot).map((diagnostic) => diagnostic.code),
      [],
    )
  }),
)

it.effect('retains source-shaped row expressions and callable constraints in module facts', () =>
  Effect.gen(function* () {
    const constrained = `service Binder {
  effect fn bind<?S, A, P, E, ?R>(self: once Effect<A ! E ? R>, provider: &mut P) -> A
  ! E
  ? Without<R, S>
  where &mut P provides S from R, S in R
}
pub fn main() -> i32 { return 0 }`
    const snapshot = yield* AnalysisFixture.retainingMain(
      'generics/constraint-facts',
      new TextEncoder().encode(constrained),
    )
    const index = Analysis.declarationIndex(snapshot)
    const operation = index.modules.at(0)?.services.at(0)?.operations.at(0)

    assert.isDefined(operation)
    if (operation === undefined) return
    assert.strictEqual(operation.requirementRow.expression._tag, 'WithoutRowExpression')
    assert.deepEqual(
      operation.constraints.map((constraint) => constraint._tag),
      ['ProviderConstraint', 'MembershipConstraint'],
    )
    assert.deepEqual(
      operation.constraintContracts.map((constraint) => constraint._tag),
      ['ProviderSelectionConstraint', 'RequirementSubsetConstraint'],
    )
    assert.strictEqual(
      RowAlgebra.encode(
        Type.requirementRowPolicy(),
        operation.requirementRow.row,
        (member) => `${member.access}:${Type.encode(member.capability)}@${member.role}`,
        Type.encode,
        (member) => `${member.access}:${member.capability.name}@${member.role}`,
      ),
      'Without<R, S>',
    )
    const provider = operation.constraints.at(0)
    assert.strictEqual(provider?._tag, 'ProviderConstraint')
    if (provider?._tag === 'ProviderConstraint') {
      assert.strictEqual(provider.mode, 'Exclusive')
      assert.strictEqual(provider.selected._tag, 'RowParameterExpression')
      assert.strictEqual(provider.source._tag, 'RowParameterExpression')
    }
    const contract = DeclarationFacts.callableContract(operation)
    assert.strictEqual(contract.constraints.length, 2)
    assert.strictEqual(Type.isEffect(contract.result), true)
    assert.include(Type.encode(contract.result), 'Without<R, S>')
    const surface = ModuleSurface.fromIndex(index).get('generics/constraint-facts')
    assert.isDefined(surface)
    assert.include(surface?.canonical ?? '', 'ProviderConstraint')
    assert.include(surface?.canonical ?? '', 'WithoutRowExpression')
  }),
)

/** Every layout environment realized for a section of `target`, with its owner name. */
const sectionEnvironments = (snapshot: Analysis.Snapshot, target: string) => {
  const layout = Analysis.layoutOf(snapshot)
  return layout._tag !== 'Available'
    ? []
    : layout.value.callableEnvironments.flatMap((environment) =>
        environment._tag === 'CallableEnvironment' &&
        environment.callable.target._tag === 'DeclarationCallableTarget' &&
        environment.callable.target.declaration.name === target
          ? [environment.callable]
          : [],
      )
}

/** Section binders may appear only inside a section's own hidden callable identity. */
const leaksSectionBinder = (type: Type.Type): boolean =>
  Type.parameters(type).some(Type.isSectionBinder)

it.effect('admits and lowers a constrained callable relayed through bound calls', () =>
  Effect.gen(function* () {
    // `forwardAgain` binds the result of `forward` before returning it, so the relay resolves a
    // body local to the parameter the caller supplies. The relays carry the section before its
    // application, so their hidden identity names the one environment the section constructs.
    const snapshot = yield* AnalysisFixture.retainingMain(
      'generics/constrained-relay',
      new TextEncoder().encode(constrainedCallableForwarding),
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    const mir = Analysis.loweredMir(snapshot)
    assert.deepEqual(yield* MirVerification.verify(mir), [])
    const [environment, ...others] = sectionEnvironments(snapshot, 'Effect.provide')
    assert.isDefined(environment)
    assert.deepEqual(others, [])
    for (const name of ['forward', 'forwardAgain']) {
      const relays = mir.functions.filter((fn) => fn.id.name === name)
      assert.strictEqual(relays.length, 1, name)
      const relay = relays[0] ?? unreachable(`expected ${name}`)
      assert.isFalse(
        relay.regions.some(
          (region) => region._tag === 'OperationRegion' && region.outcome._tag === 'Trap',
        ),
        name,
      )
      const identity = relay.instance.typeArguments.find(Type.isCallableIdentityArgument)
      assert.deepEqual(
        identity?.typeArguments.map(Type.runtimeGenericArgumentKey),
        environment?.typeArguments.map(Type.runtimeGenericArgumentKey),
        name,
      )
    }
    for (const fn of mir.functions) {
      assert.isFalse(fn.instance.typeArguments.filter(Type.isTypeArgument).some(leaksSectionBinder))
      assert.isFalse(fn.localTypes.some((type) => leaksSectionBinder(Mir.semanticType(type))))
    }
  }),
)

it.effect('shares one section environment across applications at different types', () =>
  Effect.gen(function* () {
    // Both applications solve the section's leading Effect differently, but its captures do not
    // mention those binders, so one environment serves two distinct invocations.
    const snapshot = yield* AnalysisFixture.retainingMain(
      'generics/constrained-section-two-applications',
      new TextEncoder().encode(`import silk.effect { Effect }
service Counter { effect fn get() -> i32 ? &Counter }
struct Fixed { value: i32 }
effect fn get(self: &Fixed) -> i32 { return self.value }
impl Counter for Fixed { get: Fixed.get }
effect fn seed() -> i32 ? &Counter { return run Counter.get() }
effect fn flag() -> bool ? &Counter {
  let value = run Counter.get()
  return value == 42
}
pub fn main() -> i32 {
  let fixed = Fixed { value: 42 }
  let bind = Effect.provide<Counter>(&fixed)
  let number = run bind(seed())
  let ok = run bind(flag())
  if ok { return number }
  return 0
}`),
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    assert.deepEqual(yield* MirVerification.verify(Analysis.loweredMir(snapshot)), [])
    assert.strictEqual(sectionEnvironments(snapshot, 'Effect.provide').length, 1)
    const invoked = Analysis.instancesOf(snapshot).instances.filter(
      (instance) => instance.key.declaration.name === 'Effect.provide',
    )
    assert.strictEqual(new Set(invoked.map((instance) => Instances.keyText(instance.key))).size, 2)
  }),
)

it.effect('keeps constrained section environments exact per site and selection', () =>
  Effect.gen(function* () {
    // `open` leaves the protected success unapplied while `fixedSuccess` selects it; each site keeps
    // its own environment and selection. `repeat` sections itself, so its capture selects the
    // section's binder with the enclosing function's own parameter, which owner substitution
    // closes. `dropped` owns a capture and is never applied.
    const snapshot = yield* AnalysisFixture.retainingMain(
      'generics/constrained-section-identities',
      new TextEncoder().encode(`import silk.effect { Effect }
service Counter { effect fn get() -> i32 ? &Counter }
struct Fixed { value: i32 }
effect fn get(self: &Fixed) -> i32 { return self.value }
impl Counter for Fixed { get: Fixed.get }
struct Token { value: i32 }
effect fn seed() -> i32 ? &Counter { return run Counter.get() }
effect fn guarded<A>(pending: once Effect<A>, token: Token) -> A {
  drop token
  return run move pending
}
effect fn ready() -> i32 { return 1 }
fn increment(value: i32) -> i32 { return value + 1 }
fn repeat<A>(value: A, step: fn(A) -> A, count: i32) -> A {
  if count == 0 { return move value }
  let next = repeat(step, count - 1)
  return next(step(move value))
}
pub fn main() -> i32 {
  let fixed = Fixed { value: 40 }
  let open = Effect.provide<Counter>(&fixed)
  let fixedSuccess = Effect.provide<Counter, i32>(&fixed)
  let dropped = guarded(Token { value: 0 })
  drop dropped
  let left = run open(seed())
  let right = run fixedSuccess(seed())
  let direct = run guarded(ready(), Token { value: 1 })
  return repeat(left + right - 80, increment, 2) + direct - 1
}`),
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    const mir = Analysis.loweredMir(snapshot)
    assert.deepEqual(yield* MirVerification.verify(mir), [])
    const provides = sectionEnvironments(snapshot, 'Effect.provide')
    assert.strictEqual(provides.length, 2)
    const unapplied = provides.filter((environment) =>
      Type.namesUnappliedSection(
        Type.callableIdentityArgument(
          '',
          Tir.callableTargetIdentity(environment.target),
          environment.typeArguments,
        ),
      ),
    )
    // Both sections leave binders open (the failure and requirement remainder), but only `open`
    // leaves the success open; `fixedSuccess` keeps its selected `i32`.
    assert.strictEqual(unapplied.length, 2)
    assert.isTrue(
      provides.some((environment) =>
        environment.typeArguments.some(
          (argument) => Type.genericArgumentKey(argument) === 'builtin:i32',
        ),
      ),
    )
    // A section dropped without any application still has its one environment, so its owned
    // capture is released; the obligation of its unapplied binder is erased with it.
    assert.strictEqual(sectionEnvironments(snapshot, 'guarded').length, 1)
    assert.isFalse(
      mir.functions.some((fn) =>
        fn.regions.some(
          (region) => region._tag === 'OperationRegion' && region.outcome._tag === 'Trap',
        ),
      ),
    )
    assert.isAtLeast(sectionEnvironments(snapshot, 'repeat').length, 1)
    for (const fn of mir.functions)
      assert.isFalse(fn.localTypes.some((type) => leaksSectionBinder(Mir.semanticType(type))))
  }),
)

it.effect('lowers a constrained section that is relayed but never applied', () =>
  Effect.gen(function* () {
    const source = constrainedCallableForwarding.replace(
      'let bind = forwardAgain(Effect.provide<Counter>(&fixed))\n  return run bind(read())',
      'let bind = forwardAgain(Effect.provide<Counter>(&fixed))\n  drop bind\n  return 42',
    )
    assert.notStrictEqual(source, constrainedCallableForwarding)
    const snapshot = yield* AnalysisFixture.retainingMain(
      'generics/constrained-relay-unapplied',
      new TextEncoder().encode(source),
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    const mir = Analysis.loweredMir(snapshot)
    assert.deepEqual(yield* MirVerification.verify(mir), [])
    // Trap bodies verify, so the absence of traps is asserted directly.
    assert.isFalse(
      mir.functions.some((fn) =>
        fn.regions.some(
          (region) => region._tag === 'OperationRegion' && region.outcome._tag === 'Trap',
        ),
      ),
    )
    const [environment, ...others] = sectionEnvironments(snapshot, 'Effect.provide')
    assert.deepEqual(others, [])
    const relay = mir.functions.find((fn) => fn.id.name === 'forward')
    assert.deepEqual(
      relay?.instance.typeArguments
        .find(Type.isCallableIdentityArgument)
        ?.typeArguments.map(Type.runtimeGenericArgumentKey),
      environment?.typeArguments.map(Type.runtimeGenericArgumentKey),
    )
  }),
)

it.effect('applies a section environment holding borrows by value', () =>
  Effect.gen(function* () {
    // `pick(&mut count, &seen, &items, 1)` stores each borrow itself and a Copy `i32` by value; each
    // application passes the stored descriptors to the target's parameters as stored.
    const snapshot = yield* AnalysisFixture.retainingMain(
      'generics/borrowed-capture-section',
      new TextEncoder().encode(borrowedCaptureSection),
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    const mir = Analysis.loweredMir(snapshot)
    assert.deepEqual(yield* MirVerification.verify(mir), [])
    const main = mir.functions.find((fn) => fn.id.name === 'main') ?? unreachable('expected main')
    assert.isFalse(
      main.regions.some(
        (region) => region._tag === 'OperationRegion' && region.outcome._tag === 'Trap',
      ),
    )
    const applications = main.regions.flatMap((region) =>
      region._tag === 'OperationRegion'
        ? region.operations.flatMap((operation) =>
            operation._tag === 'ApplyCallable' && operation.callable !== undefined
              ? [operation]
              : [],
          )
        : [],
    )
    assert.deepEqual(
      applications.map((operation) =>
        operation.typeArguments.filter(Type.isTypeArgument).map(Type.encodeGenericArgument),
      ),
      [['i32'], ['bool']],
    )
    const callable =
      applications.at(0)?.callable ?? unreachable('expected an application through a value')
    const value = main.localTypes.at(callable.ordinal)
    if (value?._tag !== 'CallableValue' || value.environment === undefined)
      return unreachable('expected a section environment')
    const environment = value.environment
    const descriptor = (type: DeclarationFacts.SemanticType) => {
      if (Type.isReference(type)) return `reference ${type.access}`
      if (Type.isSlice(type)) return `slice ${type.access}`
      return 'value'
    }
    assert.deepEqual(
      environment.fields.map((field) => [
        field.representation,
        field.access,
        descriptor(field.type),
      ]),
      [
        ['Value', 'Exclusive', 'reference Exclusive'],
        ['Value', 'Shared', 'reference Shared'],
        ['Value', 'Shared', 'slice Shared'],
        ['Value', 'Copy', 'value'],
      ],
    )
    // Each forged field must be rejected at the application: a borrow access on a non-descriptor,
    // an access disagreeing with its descriptor, and a descriptor the parameter cannot accept.
    const forging = (
      forge: (field: Layout.CallableEnvironmentField) => Layout.CallableEnvironmentField,
    ) =>
      MirVerification.verify({
        ...mir,
        functions: mir.functions.map((fn) =>
          fn !== main
            ? fn
            : {
                ...fn,
                localTypes: fn.localTypes.map((type, ordinal) =>
                  ordinal === callable.ordinal
                    ? {
                        ...value,
                        environment: { ...environment, fields: environment.fields.map(forge) },
                      }
                    : type,
                ),
              },
        ),
      }).pipe(
        Effect.map((violations) =>
          violations.some(
            (violation) =>
              violation.rule === 'InvalidCallableOperation' &&
              violation.detail.startsWith('callable application'),
          ),
        ),
      )
    assert.isTrue(
      yield* forging((field) =>
        field.access === 'Copy' ? { ...field, access: 'Exclusive' } : field,
      ),
    )
    assert.isTrue(
      yield* forging((field) =>
        field.access === 'Exclusive' ? { ...field, access: 'Shared' } : field,
      ),
    )
    assert.isTrue(
      yield* forging((field) =>
        Type.isSlice(field.type) ? { ...field, type: { ...field.type, element: 'bool' } } : field,
      ),
    )
  }),
)

it.effect('verifies pre-application section construction and application exactly', () =>
  Effect.gen(function* () {
    // `guarded` and `after` leave the protected success open; `after` also captures a callable.
    // Each is applied through its value, which invokes a complete instance; one is only dropped.
    const snapshot = yield* AnalysisFixture.retainingMain(
      'generics/constrained-section-verification',
      new TextEncoder().encode(`import silk.effect { Effect }
struct Token { value: i32 }
effect fn guarded<A>(pending: once Effect<A>, token: Token) -> A {
  drop token
  return run move pending
}
effect fn after<A>(pending: once Effect<A>, step: fn(i32) -> i32) -> A {
  let value = run move pending
  drop step
  return move value
}
fn increment(value: i32) -> i32 { return value + 1 }
effect fn ready() -> i32 { return 1 }
pub fn main() -> i32 {
  let dropped = guarded(Token { value: 0 })
  drop dropped
  let applied = guarded(Token { value: 1 })
  let stepped = after(increment)
  let first = run applied(ready())
  let second = run stepped(ready())
  return first + second
}`),
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    const mir = Analysis.loweredMir(snapshot)
    assert.deepEqual(yield* MirVerification.verify(mir), [])
    const main = mir.functions.find((fn) => fn.id.name === 'main') ?? unreachable('expected main')
    assert.isFalse(
      main.regions.some(
        (region) => region._tag === 'OperationRegion' && region.outcome._tag === 'Trap',
      ),
    )
    const operations = main.regions.flatMap((region) =>
      region._tag === 'OperationRegion' ? region.operations : [],
    )
    type Construction = Extract<Mir.Operation, { readonly _tag: 'MakeCallable' }>
    type Application = Extract<Mir.Operation, { readonly _tag: 'ApplyCallable' }>
    const constructionOf = (name: string): Construction =>
      operations.find(
        (operation): operation is Construction =>
          operation._tag === 'MakeCallable' &&
          operation.target._tag === 'DeclarationCallableTarget' &&
          operation.target.declaration.name === name,
      ) ?? unreachable(`expected a ${name} construction`)
    const guarded = constructionOf('guarded')
    const after = constructionOf('after')
    const application =
      operations.find(
        (operation): operation is Application =>
          operation._tag === 'ApplyCallable' &&
          operation.callable !== undefined &&
          main.localTypes.at(operation.callable.ordinal)?._tag === 'CallableValue',
      ) ?? unreachable('expected an application through a section value')
    const rules = (module: Mir.Module) =>
      MirVerification.verify(module).pipe(
        Effect.map((violations) => violations.map((violation) => violation.rule)),
      )
    // Replaces operations and local types of `main` together, so each mutation stays consistent.
    const mutated = (
      operationsBy: ReadonlyMap<Mir.Operation, Mir.Operation>,
      localsBy: ReadonlyMap<number, Mir.Type> = new Map(),
    ): Mir.Module => ({
      ...mir,
      functions: mir.functions.map((fn) =>
        fn !== main
          ? fn
          : {
              ...fn,
              localTypes: fn.localTypes.map((type, ordinal) => localsBy.get(ordinal) ?? type),
              regions: fn.regions.map((region) =>
                region._tag !== 'OperationRegion'
                  ? region
                  : {
                      ...region,
                      operations: region.operations.map(
                        (operation) => operationsBy.get(operation) ?? operation,
                      ),
                    },
              ),
            },
      ),
    })
    const environmentOf = (construction: Construction) =>
      construction.type.environment ?? unreachable('expected a construction environment')
    // A construction whose environment identity is rewritten consistently everywhere it appears.
    const reidentified = (
      construction: Construction,
      identity: ReadonlyArray<Type.GenericArgument>,
      captured?: ReadonlyArray<Type.GenericArgument>,
    ): Mir.Module => {
      const environment = environmentOf(construction)
      const changed = {
        ...environment,
        callable: { ...environment.callable, typeArguments: identity },
      }
      const type = { ...construction.type, environment: changed }
      const typeArguments = [
        ...identity,
        ...(captured ?? Layout.callableTargetArguments(environment).slice(identity.length)),
      ]
      return mutated(
        new Map([[construction, { ...construction, type, typeArguments }]]),
        new Map([[construction.destination.ordinal, type]]),
      )
    }
    const identityOf = (construction: Construction) =>
      environmentOf(construction).callable.typeArguments
    const binderOf = (construction: Construction) =>
      identityOf(construction).find(
        (argument) => Type.isTypeArgument(argument) && Type.isSectionBinder(argument),
      ) ?? unreachable('expected a section binder')
    const replacing = (
      arguments_: ReadonlyArray<Type.GenericArgument>,
      from: Type.GenericArgument,
      to: Type.GenericArgument,
    ) => arguments_.map((argument) => (argument === from ? to : argument))
    const binder = binderOf(guarded)
    const ordinary = Type.parameter({ module: 'generics/construction', name: 'free' }, 0, 'A')
    const foreign = Type.sectionBinder(
      Type.parameter({ module: 'generics/construction', name: 'other' }, 0, 'A'),
    )

    // Construction: the identity closes only its own target's section binders.
    assert.include(
      yield* rules(reidentified(guarded, replacing(identityOf(guarded), binder, ordinary))),
      'InvalidCallableOperation',
    )
    assert.include(
      yield* rules(reidentified(guarded, replacing(identityOf(guarded), binder, foreign))),
      'InvalidCallableOperation',
    )
    // A section binder in the captured-identity segment is never closed.
    assert.include(
      yield* rules(reidentified(after, identityOf(after), [binderOf(after)])),
      'InvalidCallableOperation',
    )
    // The construction target must be its environment's target.
    assert.include(
      yield* rules(mutated(new Map([[guarded, { ...guarded, target: after.target }]]))),
      'InvalidCallableOperation',
    )
    // Arguments that disagree with the environment (operation only) are rejected on their own.
    assert.include(
      yield* rules(
        mutated(
          new Map([[guarded, { ...guarded, typeArguments: guarded.typeArguments.slice(1) }]]),
        ),
      ),
      'InvalidCallableOperation',
    )

    // Application: the invocation must be a complete instance of the environment's identity.
    const applyWith = (changes: Partial<Application>) =>
      rules(mutated(new Map([[application, { ...application, ...changes }]])))
    assert.include(yield* applyWith({ target: guarded.target }), 'InvalidCallableOperation')
    assert.include(
      yield* applyWith({ typeArguments: [...application.typeArguments, binder] }),
      'InvalidCallableOperation',
    )
    assert.include(
      yield* applyWith({ typeArguments: ['bool', ...application.typeArguments.slice(1)] }),
      'InvalidCallableOperation',
    )
    assert.include(
      yield* applyWith({ callableType: { ...application.callableType, result: 'i64' } }),
      'InvalidCallableOperation',
    )
    assert.include(
      yield* applyWith({
        callableType: {
          ...application.callableType,
          parameters: [
            Type.nominal('generics/constrained-section-verification', 'Token', []),
            ...application.callableType.parameters,
          ],
        },
      }),
      'InvalidCallableOperation',
    )
    // Captured fields: ordinals are unique and in range, and pass as the backend passes them.
    const source = application.callable ?? unreachable('expected an applied value')
    const value = main.localTypes.at(source.ordinal)
    if (value?._tag !== 'CallableValue' || value.environment === undefined)
      return unreachable('expected an applied environment value')
    const environment = value.environment
    const withFields = (fields: typeof environment.fields) =>
      rules(
        mutated(
          new Map(),
          new Map([[source.ordinal, { ...value, environment: { ...environment, fields } }]]),
        ),
      )
    const [field] = environment.fields
    if (field === undefined) return unreachable('expected a captured field')
    assert.include(yield* withFields([field, field]), 'InvalidCallableOperation')
    assert.include(
      yield* withFields([{ ...field, parameterOrdinal: 9 }]),
      'InvalidCallableOperation',
    )
    assert.include(
      yield* withFields([{ ...field, representation: 'Borrow', access: 'Shared' }]),
      'InvalidCallableOperation',
    )
    // The applied value's own target must be its environment's target: a relayed or parameter
    // value has no construction in this body to vouch for it.
    assert.include(
      yield* rules(
        mutated(new Map(), new Map([[source.ordinal, { ...value, target: after.target }]])),
      ),
      'InvalidCallableOperation',
    )
  }),
)

it.effect('binds each captured callable to its own invoked parameter', () =>
  Effect.gen(function* () {
    // `forward` and `backward` capture the same two same-signature callables in opposite order.
    // Each application must invoke the instance whose hidden callable identities match its own
    // captures position by position; the other instance exists and has the same signature.
    const snapshot = yield* AnalysisFixture.retainingMain(
      'generics/constrained-section-callable-positions',
      new TextEncoder().encode(`import silk.effect { Effect }
effect fn both<A>(pending: once Effect<A>, first: fn(i32) -> i32, second: fn(i32) -> i32) -> A {
  let value = run move pending
  drop first
  drop second
  return move value
}
fn increment(value: i32) -> i32 { return value + 1 }
fn decrement(value: i32) -> i32 { return value - 1 }
effect fn ready() -> i32 { return 1 }
pub fn main() -> i32 {
  let forward = both(increment, decrement)
  let backward = both(decrement, increment)
  let left = run forward(ready())
  let right = run backward(ready())
  return left + right
}`),
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    const mir = Analysis.loweredMir(snapshot)
    assert.deepEqual(yield* MirVerification.verify(mir), [])
    const main = mir.functions.find((fn) => fn.id.name === 'main') ?? unreachable('expected main')
    const applications = main.regions
      .flatMap((region) => (region._tag === 'OperationRegion' ? region.operations : []))
      .filter(
        (operation): operation is Extract<Mir.Operation, { readonly _tag: 'ApplyCallable' }> =>
          operation._tag === 'ApplyCallable' && operation.callable !== undefined,
      )
    const [forward, backward] = applications
    if (forward === undefined || backward === undefined)
      return unreachable('expected both applications')
    assert.notDeepEqual(
      forward.typeArguments.map(Type.genericArgumentKey),
      backward.typeArguments.map(Type.genericArgumentKey),
    )
    // The swapped application names `backward`'s real instance and result, so every other premise
    // holds; only the positions of the captured callables disagree.
    const swapped: Mir.Module = {
      ...mir,
      functions: mir.functions.map((fn) =>
        fn !== main
          ? fn
          : {
              ...fn,
              localTypes: fn.localTypes.map((type, ordinal) =>
                ordinal === forward.destination.ordinal ? backward.type : type,
              ),
              regions: fn.regions.map((region) =>
                region._tag !== 'OperationRegion'
                  ? region
                  : {
                      ...region,
                      operations: region.operations.map((operation) =>
                        operation === forward
                          ? {
                              ...forward,
                              typeArguments: backward.typeArguments,
                              callableType: backward.callableType,
                              type: backward.type,
                            }
                          : operation,
                      ),
                    },
              ),
            },
      ),
    }
    assert.include(
      (yield* MirVerification.verify(swapped)).map((violation) => violation.rule),
      'InvalidCallableOperation',
    )
  }),
)

it('instantiates a nested section identity only with a consistent solution', () => {
  const owner = { module: 'generics/nested', name: 'wrap' }
  const a = Type.sectionBinder(Type.parameter(owner, 0, 'A'))
  const option = (argument: Type.Type) => Type.nominal('silk/option', 'Option', [argument])
  const target = { _tag: 'Declaration' as const, module: owner.module, name: owner.name }
  assert.isTrue(Type.instantiatesSectionIdentity(target, [a, option(a)], ['i32', option('i32')]))
  assert.isFalse(Type.instantiatesSectionIdentity(target, [a, option(a)], ['i32', option('bool')]))
  // A selected position must stay as the section chose it.
  assert.isFalse(Type.instantiatesSectionIdentity(target, [a, 'bool'], ['i32', 'i64']))
  // A binder that no top-level position binds leaves the invocation unrelated to the identity.
  assert.isFalse(Type.instantiatesSectionIdentity(target, [option(a)], [option('i32')]))
})

it.effect('keeps ordinary environment applications checked by their value type', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'generics/ordinary-environment-application',
      new TextEncoder().encode(`fn add(left: i32, right: i32) -> i32 { return left + right }
pub fn main() -> i32 { let plusTwo = add(2) return plusTwo(40) }`),
    )
    const mir = Analysis.loweredMir(snapshot)
    assert.deepEqual(yield* MirVerification.verify(mir), [])
    const main = mir.functions.find((fn) => fn.id.name === 'main') ?? unreachable('expected main')
    const application =
      main.regions
        .flatMap((region) => (region._tag === 'OperationRegion' ? region.operations : []))
        .find(
          (operation): operation is Extract<Mir.Operation, { readonly _tag: 'ApplyCallable' }> =>
            operation._tag === 'ApplyCallable',
        ) ?? unreachable('expected an application')
    const changed: Mir.Module = {
      ...mir,
      functions: mir.functions.map((fn) =>
        fn !== main
          ? fn
          : {
              ...fn,
              regions: fn.regions.map((region) =>
                region._tag !== 'OperationRegion'
                  ? region
                  : {
                      ...region,
                      operations: region.operations.map((operation) =>
                        operation !== application
                          ? operation
                          : {
                              ...application,
                              callableType: { ...application.callableType, parameters: ['bool'] },
                            },
                      ),
                    },
              ),
            },
      ),
    }
    assert.include(
      (yield* MirVerification.verify(changed)).map((violation) => violation.rule),
      'InvalidCallableOperation',
    )
  }),
)

it.effect('applies a section built inside a generic owner at each owner instance', () =>
  Effect.gen(function* () {
    // `select(true)` leaves `U` open; inside `pickOne<T>` its application solves `U := T`, the
    // owner's own parameter, which each owner instance then makes concrete.
    const snapshot = yield* AnalysisFixture.retainingMain(
      'generics/constrained-section-generic-owner',
      new TextEncoder().encode(constrainedSectionGenericOwner),
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    const mir = Analysis.loweredMir(snapshot)
    assert.deepEqual(yield* MirVerification.verify(mir), [])
    assert.isFalse(
      mir.functions.some((fn) =>
        fn.regions.some(
          (region) => region._tag === 'OperationRegion' && region.outcome._tag === 'Trap',
        ),
      ),
    )
    // One environment per owner instance, and one concrete invocation of `select` per owner.
    const byName = (left: string, right: string) => left.localeCompare(right)
    const owners = sectionEnvironments(snapshot, 'select')
      .map((environment) => environment.owner.typeArguments.map(Type.encodeGenericArgument).join())
      .sort(byName)
    const invoked = Analysis.instancesOf(snapshot)
      .calls.filter((call) => call.target.declaration.name === 'select')
      .map((call) => call.target.typeArguments.map(Type.encodeGenericArgument).join())
      .sort(byName)
    const expected = ['generics/constrained-section-generic-owner.Token', 'i32'].sort(byName)
    assert.deepEqual(owners, expected)
    assert.deepEqual(invoked, expected)
  }),
)

it.effect('applies a generic function item piped inside a generic owner', () =>
  Effect.gen(function* () {
    // `move value |> keep` solves `U := T` in `pass<T>`'s terms; each owner instance makes it
    // concrete and invokes its own `keep<…>`.
    const snapshot = yield* AnalysisFixture.retainingMain(
      'generics/generic-item-pipeline-owner',
      new TextEncoder().encode(genericItemPipelineInGenericOwner),
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    const mir = Analysis.loweredMir(snapshot)
    assert.deepEqual(yield* MirVerification.verify(mir), [])
    assert.isFalse(
      mir.functions.some((fn) =>
        fn.regions.some(
          (region) => region._tag === 'OperationRegion' && region.outcome._tag === 'Trap',
        ),
      ),
    )
    const byName = (left: string, right: string) => left.localeCompare(right)
    assert.deepEqual(
      Analysis.instancesOf(snapshot)
        .instances.filter((instance) => instance.key.declaration.name === 'keep')
        .map((instance) => instance.key.typeArguments.map(Type.encodeGenericArgument).join())
        .sort(byName),
      ['generics/generic-item-pipeline-owner.Token', 'i32'].sort(byName),
    )
  }),
)

it.effect('invokes an owner-typed section with its complete call at each owner type', () =>
  Effect.gen(function* () {
    // `pair(move right)` selects `A := T` through its capture. Applied directly in a pipeline
    // (`choose`) or through a value (`chooseBound`), each application invokes exactly `pair<T>`
    // for the owner instance, named by its own complete call.
    const snapshot = yield* AnalysisFixture.retainingMain(
      'generics/owner-typed-direct-section',
      new TextEncoder().encode(ownerTypedDirectSection),
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    const mir = Analysis.loweredMir(snapshot)
    assert.deepEqual(yield* MirVerification.verify(mir), [])
    assert.isFalse(
      mir.functions.some((fn) =>
        fn.regions.some(
          (region) => region._tag === 'OperationRegion' && region.outcome._tag === 'Trap',
        ),
      ),
    )
    const byName = (left: string, right: string) => left.localeCompare(right)
    for (const owner of ['choose', 'chooseBound']) {
      const applications = mir.functions
        .filter((fn) => fn.id.name === owner)
        .flatMap((fn) =>
          fn.regions.flatMap((region) =>
            region._tag === 'OperationRegion'
              ? region.operations.flatMap((operation) =>
                  operation._tag === 'ApplyCallable'
                    ? [operation.typeArguments.map(Type.encodeGenericArgument).join()]
                    : [],
                )
              : [],
          ),
        )
        .sort(byName)
      assert.deepEqual(
        applications,
        ['generics/owner-typed-direct-section.Token', 'i32'].sort(byName),
        owner,
      )
    }
    assert.deepEqual(
      Analysis.instancesOf(snapshot)
        .calls.filter(
          (call) =>
            call.owner.declaration.name === 'choose' && call.target.declaration.name === 'pair',
        )
        .map((call) => call.target.typeArguments.map(Type.encodeGenericArgument).join())
        .sort(byName),
      ['generics/owner-typed-direct-section.Token', 'i32'].sort(byName),
    )
  }),
)

it.effect('rejects applying a take-once constrained section twice', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'generics/constrained-section-once',
      new TextEncoder().encode(`import silk.effect { Effect }
struct Token { value: i32 }
effect fn guarded<A>(pending: once Effect<A>, token: Token) -> A {
  drop token
  return run move pending
}
effect fn ready() -> i32 { return 1 }
pub fn main() -> i32 {
  let once = guarded(Token { value: 0 })
  let first = run once(ready())
  let second = run once(ready())
  return first + second
}`),
    )
    assert.isTrue(
      Analysis.diagnostics(snapshot).some((diagnostic) => diagnostic.code.startsWith('OWN')),
    )
  }),
)

it.effect('rejects residual rows at the complete-application specialization frontier', () =>
  Effect.gen(function* () {
    const module = 'generics/frontier'
    const snapshot = yield* AnalysisFixture.retainingMain(
      module,
      new TextEncoder()
        .encode(`effect fn forward<A, E, ?R>(self: once Effect<A ! E ? R>) -> A ! E ? R {
  return run self
}
pub fn main() -> i32 { return 0 }`),
    )
    const result = Analysis.rootAnalysis(snapshot)
    const body = result.bodies.find(
      (candidate) =>
        candidate.declaration.canonical._tag === 'Canonical' &&
        candidate.declaration.canonical.id.name === 'forward',
    )
    const fn = body?.function
    assert.isDefined(fn)
    if (body === undefined || fn === undefined) return
    const registry = snapshot.resolution.contexts
    assert.isUndefined(
      Instances.specialize(
        BodyView.make(body),
        new Map(),
        Analysis.declarationIndex(snapshot),
        registry,
      ),
    )
    const diagnostic = Diagnostic.nonConcreteSpecialization(
      `${module}.forward`,
      registry.spanOf(fn.declaration.anchor),
    )
    assert.strictEqual(diagnostic.code, 'SEM0122')
    assert.strictEqual(diagnostic.reason._tag, 'NonConcreteSpecialization')
  }),
)

it.effect('renormalizes concrete difference after generic nominal keys collide', () =>
  Effect.gen(function* () {
    const self = yield* Analysis.ofSource(
      'generics/without-substitution-collision',
      new TextEncoder().encode(`struct Problem<T> { value: T }
effect fn erase<A, B>() -> () ! Without<Problem<A>, Problem<B>> { return () }
pub effect fn main() -> () { return run erase<i32, i32>() }`),
    )
    assert.deepEqual(Analysis.diagnostics(self), [])
  }),
)

it.effect('binds provider-selected rows before checking subset constraints', () =>
  Effect.gen(function* () {
    const self = yield* Analysis.ofSource(
      'generics/provider-bound-subset',
      new TextEncoder().encode(`import silk.effect { Effect }
service Clock { effect fn value() -> i32 ? &mut Clock }
struct FixedClock {}
effect fn clockValue(self: &mut FixedClock) -> i32 { return 0 }
impl Clock for FixedClock { value: FixedClock.clockValue }
effect fn read() -> i32 ? &mut Clock { return 7 }
effect fn provideBoth<?S, A, P, E, ?R>(
  self: once Effect<A ! E ? R>,
  provider: &mut P
) -> A ! E ? Without<R, S>
where &mut P provides S from R, S in R {
  return run Effect.provideMut<S>(move self, move provider)
}
pub fn main() -> i32 {
  let mut clock = FixedClock {}
  let provided = provideBoth(read(), &mut clock)
  return run provided
}`),
    )
    assert.deepEqual(Analysis.diagnostics(self), [])
  }),
)

it('parses declaration parameters and explicit call specialization losslessly', () => {
  const syntax = Parser.parse(Lexer.lex(file))
  const kinds = descendants(syntax.root).map((node) => node.kind)

  assert.include(kinds, 'TypeParameterList')
  assert.include(kinds, 'TypeParameter')
  assert.include(kinds, 'CallTypeArgumentList')
  assert.deepEqual(syntax.parserDiagnostics, [])
})

it('parses channel-kinded generic binders losslessly', () => {
  const channelSource = `effect fn transform<A, E, ?R>(self: Effect<A ! E ? R>) -> Effect<A ! E ? R> {
  return self
}`
  const syntax = Parser.parse(
    Lexer.lex(SourceFile.make('generics/Channels', new TextEncoder().encode(channelSource))),
  )
  const parameters = descendants(syntax.root).filter((node) => node.kind === 'TypeParameter')

  assert.deepEqual(
    parameters.map((parameter) =>
      SyntaxTree.tokens(parameter)
        .filter((token) => token.kind !== 'Whitespace')
        .map((token) => token.kind),
    ),
    [['Identifier'], ['Identifier'], ['Question', 'Identifier']],
  )
  assert.deepEqual(syntax.parserDiagnostics, [])
})

it('normalizes contract rows and infers selected-entry remainders', () => {
  const owner = { module: 'generics/Rows', name: 'transform' }
  const failureRemainder = Type.parameter(owner, 0, 'E')
  const requirementRemainder = Type.parameter(owner, 1, 'R', 'RequirementRow')
  const problem = Type.nominal('generics/Rows', 'Problem')
  const other = Type.nominal('generics/Rows', 'Other')
  const clock = Type.nominal('generics/Rows', 'Clock')
  const allocator = Type.nominal('generics/Rows', 'Allocator')
  const pattern = Type.effect(
    'i32',
    [failureRemainder],
    { environment: Lifetime.staticLifetime, lifetimeBinders: [] },
    'Shared',
    [{ capability: clock, role: 'Primary', access: 'Shared' }],
    [requirementRemainder],
  )
  const actual = Type.effect(
    'i32',
    [other, problem, other],
    { environment: Lifetime.staticLifetime, lifetimeBinders: [] },
    'Shared',
    [
      { capability: clock, role: 'Primary', access: 'Shared' },
      { capability: allocator, role: 'DefaultRole', access: 'Exclusive' },
    ],
  )
  const inferred = new Map<string, Type.GenericArgument>()

  assert.strictEqual(TypeInference.infer(pattern, actual, inferred), true)
  assert.strictEqual(
    Type.encodeGenericArgument(inferred.get(Type.key(failureRemainder)) ?? 'never'),
    'generics/Rows.Other | generics/Rows.Problem',
  )
  assert.strictEqual(
    Type.encodeGenericArgument(inferred.get(Type.key(requirementRemainder)) ?? 'never'),
    '? &mut generics/Rows.Allocator',
  )
  assert.strictEqual(Type.encode(Type.substitute(pattern, inferred)), Type.encode(actual))
})

it('checks computed rows forward-only without reconstructing their operands', () => {
  const owner = { module: 'generics/ForwardRows', name: 'without' }
  const source = Type.parameter(owner, 0, 'E')
  const selected = Type.parameter(owner, 1, 'S')
  const problem = Type.nominal('generics/ForwardRows', 'Problem')
  const other = Type.nominal('generics/ForwardRows', 'Other')
  const origin =
    SourceSpan.fromOffsets('generics/ForwardRows', 10, 11) ??
    unreachable('expected a valid source span')
  const computed = RowAlgebra.without(
    Type.failureRowPolicy(),
    RowAlgebra.singleton(Type.failureRowPolicy(), Type.failureMemberShape(source), origin),
    RowAlgebra.singleton(Type.failureRowPolicy(), Type.failureMemberShape(selected), origin),
  )
  const independentlyBound = new Map<string, Type.GenericArgument>([
    [Type.key(source), Type.failureValue([problem, other])],
    [Type.key(selected), problem],
  ])
  assert.strictEqual(
    Type.encode(Type.failureType(Type.substituteFailureRow(computed, independentlyBound))),
    'generics/ForwardRows.Other',
  )

  const requirementSource = Type.parameter(owner, 2, 'R', 'RequirementRow')
  const transport = {
    capability: Type.nominal('generics/ForwardRows', 'Transport'),
    role: 'DefaultRole',
    access: 'Exclusive' as const,
  }
  const audit = {
    capability: Type.nominal('generics/ForwardRows', 'Audit'),
    role: 'DefaultRole',
    access: 'Exclusive' as const,
  }
  const requirementPattern = Type.effectWithRows(
    'i32',
    RowAlgebra.concrete(Type.failureRowPolicy(), []),
    { environment: Lifetime.staticLifetime, lifetimeBinders: [] },
    'Shared',
    RowAlgebra.without(
      Type.requirementRowPolicy(),
      RowAlgebra.parameter(requirementSource),
      RowAlgebra.concrete(Type.requirementRowPolicy(), [transport]),
    ),
  )
  const requirementActual = Type.effect(
    'i32',
    [],
    { environment: Lifetime.staticLifetime, lifetimeBinders: [] },
    'Shared',
    [audit],
  )
  assert.isFalse(TypeInference.infer(requirementPattern, requirementActual, new Map()))
})

it('preserves symbolic failure members when a singleton specializes to a mixed union', () => {
  const owner = { module: 'generics/MixedFailureSpecialization', name: 'forward' }
  const inner = Type.parameter(owner, 0, 'InnerE')
  const outer = Type.parameter(owner, 1, 'OuterE')
  const fixed = Type.nominal('generics/MixedFailureSpecialization', 'FixedFailure')
  const origin =
    SourceSpan.fromOffsets('generics/MixedFailureSpecialization', 20, 26) ??
    unreachable('expected a valid source span')
  const source = RowAlgebra.singleton(
    Type.failureRowPolicy(),
    Type.failureMemberShape(inner),
    origin,
  )

  const specialized = Type.specializeFailureRow(
    source,
    new Map([[Type.key(inner), Type.failureValue([fixed, outer])]]),
  )

  assert.strictEqual(specialized._tag, 'Substituted')
  if (specialized._tag !== 'Substituted') return
  assert.deepEqual(Type.failureMembers(specialized.row), [fixed])
  assert.deepEqual(Type.failureMemberParameters(specialized.row), [outer])
  assert.deepEqual(
    specialized.row.memberWellFormed.map((obligation) => ({
      parameter: obligation.member.parameter,
      origins: obligation.origins,
    })),
    [{ parameter: outer, origins: [origin] }],
  )
})

it('infers failure and requirement row arguments nested in nominal applications', () => {
  const owner = { module: 'generics/NominalRows', name: 'Carrier' }
  const failures = Type.parameter(owner, 0, 'E')
  const requirements = Type.parameter(owner, 1, 'R', 'RequirementRow')
  const problem = Type.nominal('generics/NominalRows', 'Problem')
  const other = Type.nominal('generics/NominalRows', 'Other')
  const clock = Type.nominal('generics/NominalRows', 'Clock')
  const allocator = Type.nominal('generics/NominalRows', 'Allocator')
  const pattern = Type.nominal('generics/NominalRows', 'Carrier', [
    failures,
    Type.requirementRowArgument(
      [{ capability: clock, role: 'DefaultRole', access: 'Shared' }],
      [requirements],
    ),
  ])
  const actual = Type.nominal('generics/NominalRows', 'Carrier', [
    Type.failureValue([problem, other]),
    Type.requirementRowArgument([
      { capability: clock, role: 'DefaultRole', access: 'Shared' },
      { capability: allocator, role: 'DefaultRole', access: 'Exclusive' },
    ]),
  ])
  const inferred = new Map<string, Type.GenericArgument>()

  assert.isTrue(TypeInference.infer(pattern, actual, inferred))
  assert.strictEqual(
    Type.encodeGenericArgument(inferred.get(Type.key(failures)) ?? 'never'),
    'generics/NominalRows.Other | generics/NominalRows.Problem',
  )
  assert.strictEqual(
    Type.encodeGenericArgument(inferred.get(Type.key(requirements)) ?? 'never'),
    '? &mut generics/NominalRows.Allocator',
  )

  const repeated = Type.nominal('generics/NominalRows', 'Repeated', [failures, failures])
  assert.isFalse(
    TypeInference.infer(
      repeated,
      Type.nominal('generics/NominalRows', 'Repeated', [
        Type.failureValue([problem]),
        Type.failureValue([other]),
      ]),
      new Map(),
    ),
  )

  const repeatedRequirements = Type.nominal('generics/NominalRows', 'Repeated', [
    Type.requirementRowArgument([], [requirements]),
    Type.requirementRowArgument([], [requirements]),
  ])
  assert.isFalse(
    TypeInference.infer(
      repeatedRequirements,
      Type.nominal('generics/NominalRows', 'Repeated', [
        Type.requirementRowArgument([{ capability: clock, role: 'DefaultRole', access: 'Shared' }]),
        Type.requirementRowArgument([
          { capability: allocator, role: 'DefaultRole', access: 'Exclusive' },
        ]),
      ]),
      new Map(),
    ),
  )

  const openFailures = Type.parameter(owner, 2, 'OpenE')
  const openRequirements = Type.parameter(owner, 3, 'OpenR', 'RequirementRow')
  assert.isFalse(
    TypeInference.infer(
      pattern,
      Type.nominal('generics/NominalRows', 'Carrier', [
        Type.failureValue([problem, openFailures]),
        Type.requirementRowArgument(
          [{ capability: clock, role: 'DefaultRole', access: 'Shared' }],
          [openRequirements],
        ),
      ]),
      new Map(),
    ),
  )

  const x = Type.parameter(owner, 4, 'X', 'Value')
  const y = Type.parameter(owner, 5, 'Y', 'Value')
  const a = Type.nominal('generics/NominalRows', 'A')
  const b = Type.nominal('generics/NominalRows', 'B')
  const c = Type.nominal('generics/NominalRows', 'C')
  const pair = (left: Type.Type, right: Type.Type): Type.Nominal =>
    Type.nominal('generics/NominalRows', 'Pair', [left, right])
  const requirement = (capability: Type.Nominal): Type.Requirement =>
    Object.freeze({ capability, role: 'DefaultRole', access: 'Shared' })
  const ambiguousRequirements = new Map<string, Type.GenericArgument>()
  assert.isTrue(
    TypeInference.infer(
      Type.nominal('generics/NominalRows', 'Backtracking', [
        Type.requirementRowArgument([requirement(pair(a, y)), requirement(pair(x, b))]),
      ]),
      Type.nominal('generics/NominalRows', 'Backtracking', [
        Type.requirementRowArgument([requirement(pair(a, b)), requirement(pair(a, c))]),
      ]),
      ambiguousRequirements,
    ),
  )
  assert.strictEqual(
    Type.encodeGenericArgument(ambiguousRequirements.get(Type.key(x)) ?? 'never'),
    Type.encodeGenericArgument(a),
  )
  assert.strictEqual(
    Type.encodeGenericArgument(ambiguousRequirements.get(Type.key(y)) ?? 'never'),
    Type.encodeGenericArgument(c),
  )
})

it('uses an ordinary type parameter directly as an effect failure value', () => {
  const owner = { module: 'generics/Rows', name: 'result' }
  const failures = Type.parameter(owner, 0, 'E')
  const problem = Type.nominal('generics/Rows', 'Problem')
  const other = Type.nominal('generics/Rows', 'Other')
  const concrete = Type.union([problem, other])
  assert.strictEqual(concrete._tag, 'Normalized')
  if (concrete._tag !== 'Normalized') return

  const inferred = new Map<string, Type.GenericArgument>()
  assert.strictEqual(TypeInference.infer(failures, concrete.type, inferred), true)
  assert.strictEqual(
    Type.encode(Type.substitute(failures, inferred)),
    'generics/Rows.Other | generics/Rows.Problem',
  )

  const syntax = Parser.parse(
    Lexer.lex(
      SourceFile.make(
        'generics/Projection',
        new TextEncoder().encode(
          'effect fn keep<E>(value: Effect<i32 ! E>) -> Effect<i32 ! E> { return value }',
        ),
      ),
    ),
  )
  assert.deepEqual(syntax.parserDiagnostics, [])
  assert.strictEqual(
    descendants(syntax.root).filter((node) => node.kind === 'FailureRow').length,
    2,
  )
})

it('distinguishes row inference failure causes deterministically', () => {
  const owner = { module: 'generics/Rows', name: 'diagnose' }
  const firstRequirement = Type.parameter(owner, 2, 'R', 'RequirementRow')
  const secondRequirement = Type.parameter(owner, 3, 'S', 'RequirementRow')
  const problem = Type.nominal('generics/Rows', 'Problem')
  const clock = Type.nominal('generics/Rows', 'Clock')
  const requirement = { capability: clock, role: 'Primary', access: 'Shared' as const }
  const closed = Type.effect(
    'i32',
    [],
    { environment: Lifetime.staticLifetime, lifetimeBinders: [] },
    'Shared',
  )
  const absentFailure = TypeInference.inferenceFailure(
    Type.effect('i32', [problem], { environment: Lifetime.staticLifetime, lifetimeBinders: [] }),
    closed,
  )

  assert.strictEqual(absentFailure?._tag, 'AbsentFailureMember')
  if (absentFailure !== undefined)
    assert.deepEqual(
      {
        code: Diagnostic.inferenceFailure(absentFailure, Parser.parse(Lexer.lex(file)).root.span)
          .code,
        reason: Diagnostic.inferenceFailure(absentFailure, Parser.parse(Lexer.lex(file)).root.span)
          .reason._tag,
      },
      { code: 'SEM0089', reason: 'ContractRowInference' },
    )
  assert.strictEqual(
    TypeInference.inferenceFailure(
      Type.effect(
        'i32',
        [],
        { environment: Lifetime.staticLifetime, lifetimeBinders: [] },
        'Shared',
        [requirement],
      ),
      closed,
    )?._tag,
    'AbsentRequirementMember',
  )
  assert.strictEqual(
    TypeInference.inferenceFailure(
      Type.effect(
        'i32',
        [],
        { environment: Lifetime.staticLifetime, lifetimeBinders: [] },
        'Shared',
        [requirement],
      ),
      Type.effect(
        'i32',
        [],
        { environment: Lifetime.staticLifetime, lifetimeBinders: [] },
        'Shared',
        [{ ...requirement, role: 'Secondary' }],
      ),
    )?._tag,
    'IncompatibleRequirementRole',
  )
  assert.strictEqual(
    TypeInference.inferenceFailure(
      Type.effect(
        'i32',
        [],
        { environment: Lifetime.staticLifetime, lifetimeBinders: [] },
        'Shared',
        [requirement],
      ),
      Type.effect(
        'i32',
        [],
        { environment: Lifetime.staticLifetime, lifetimeBinders: [] },
        'Shared',
        [{ ...requirement, access: 'Exclusive' }],
      ),
    )?._tag,
    'IncompatibleRequirementAccess',
  )
  assert.strictEqual(
    TypeInference.inferenceFailure(
      Type.effect(
        'i32',
        [],
        { environment: Lifetime.staticLifetime, lifetimeBinders: [] },
        'Shared',
        [],
        [firstRequirement, secondRequirement],
      ),
      closed,
    )?._tag,
    'AmbiguousRequirementRemainder',
  )
  assert.strictEqual(
    TypeInference.inferenceFailure(
      Type.effect(
        'i32',
        [],
        { environment: Lifetime.staticLifetime, lifetimeBinders: [] },
        'Shared',
        [],
        [],
      ),
      Type.effect(
        'i32',
        [],
        { environment: Lifetime.staticLifetime, lifetimeBinders: [] },
        'Shared',
        [],
        [secondRequirement],
      ),
    )?._tag,
    'NonFiniteRequirementRow',
  )
  const forwarded = Type.effect(
    'i32',
    [],
    { environment: Lifetime.staticLifetime, lifetimeBinders: [] },
    'Shared',
    [],
    [firstRequirement],
  )
  assert.strictEqual(TypeInference.inferenceFailure(forwarded, forwarded), undefined)

  const callee = { module: 'generics/Rows', name: 'callee' }
  const calleeFailure = Type.parameter(callee, 0, 'E')
  const outerFailure = Type.parameter(owner, 4, 'OuterE')
  const failureInference = new Map<string, Type.GenericArgument>()
  assert.strictEqual(
    TypeInference.infer(
      Type.effect('i32', [calleeFailure], {
        environment: Lifetime.staticLifetime,
        lifetimeBinders: [],
      }),
      Type.effect('i32', [problem, outerFailure], {
        environment: Lifetime.staticLifetime,
        lifetimeBinders: [],
      }),
      failureInference,
    ),
    true,
  )
  const inferredFailure = failureInference.get(Type.key(calleeFailure))
  const expectedFailure = Type.union([problem, outerFailure])
  assert.strictEqual(expectedFailure._tag, 'Normalized')
  assert.strictEqual(
    inferredFailure === undefined ? undefined : Type.encodeGenericArgument(inferredFailure),
    expectedFailure._tag === 'Normalized' ? Type.encode(expectedFailure.type) : undefined,
  )
  assert.strictEqual(
    TypeInference.infer(
      Type.effect('i32', [calleeFailure], {
        environment: Lifetime.staticLifetime,
        lifetimeBinders: [],
      }),
      Type.effect('i32', [problem, calleeFailure], {
        environment: Lifetime.staticLifetime,
        lifetimeBinders: [],
      }),
      new Map(),
    ),
    false,
  )
  assert.strictEqual(
    TypeInference.infer(
      Type.effect('i32', [problem, calleeFailure], {
        environment: Lifetime.staticLifetime,
        lifetimeBinders: [],
      }),
      Type.effect('i32', [problem, outerFailure], {
        environment: Lifetime.staticLifetime,
        lifetimeBinders: [],
      }),
      new Map(),
    ),
    false,
  )

  const calleeRequirement = Type.parameter(callee, 1, 'R', 'RequirementRow')
  const outerRequirement = Type.parameter(owner, 5, 'OuterR', 'RequirementRow')
  const requirementInference = new Map<string, Type.GenericArgument>()
  assert.strictEqual(
    TypeInference.infer(
      Type.effect(
        'i32',
        [],
        { environment: Lifetime.staticLifetime, lifetimeBinders: [] },
        'Shared',
        [],
        [calleeRequirement],
      ),
      Type.effect(
        'i32',
        [],
        { environment: Lifetime.staticLifetime, lifetimeBinders: [] },
        'Shared',
        [requirement],
        [outerRequirement],
      ),
      requirementInference,
    ),
    true,
  )
  const inferredRequirement = requirementInference.get(Type.key(calleeRequirement))
  assert.strictEqual(
    inferredRequirement === undefined ? undefined : Type.encodeGenericArgument(inferredRequirement),
    Type.encodeGenericArgument(Type.requirementRowArgument([requirement], [outerRequirement])),
  )
  assert.strictEqual(
    TypeInference.infer(
      Type.effect(
        'i32',
        [],
        { environment: Lifetime.staticLifetime, lifetimeBinders: [] },
        'Shared',
        [],
        [calleeRequirement],
      ),
      Type.effect(
        'i32',
        [],
        { environment: Lifetime.staticLifetime, lifetimeBinders: [] },
        'Shared',
        [requirement],
        [calleeRequirement],
      ),
      new Map(),
    ),
    false,
  )
  assert.strictEqual(
    TypeInference.infer(
      Type.effect(
        'i32',
        [],
        { environment: Lifetime.staticLifetime, lifetimeBinders: [] },
        'Shared',
        [],
        [calleeRequirement, secondRequirement],
      ),
      Type.effect(
        'i32',
        [],
        { environment: Lifetime.staticLifetime, lifetimeBinders: [] },
        'Shared',
        [requirement],
        [outerRequirement],
      ),
      new Map(),
    ),
    false,
  )
})

it('orders Effect access bounds from reusable through take-capable', () => {
  const shared = Type.effect(
    'i32',
    [],
    { environment: Lifetime.staticLifetime, lifetimeBinders: [] },
    'Shared',
  )
  const exclusive = Type.effect(
    'i32',
    [],
    { environment: Lifetime.staticLifetime, lifetimeBinders: [] },
    'Exclusive',
  )
  const take = Type.effect(
    'i32',
    [],
    { environment: Lifetime.staticLifetime, lifetimeBinders: [] },
    'Take',
  )

  assert.isTrue(TypeInference.infer(take, shared, new Map()))
  assert.isTrue(TypeInference.infer(take, exclusive, new Map()))
  assert.isTrue(TypeInference.infer(take, take, new Map()))
  assert.isTrue(TypeInference.infer(exclusive, shared, new Map()))
  assert.isTrue(TypeInference.infer(exclusive, exclusive, new Map()))
  assert.isFalse(TypeInference.infer(exclusive, take, new Map()))
  assert.isFalse(TypeInference.infer(shared, exclusive, new Map()))
  assert.isFalse(TypeInference.infer(shared, take, new Map()))
})

it('keeps generic angles contextual and recovers damaged lists deterministically', () => {
  const comparisons = Parser.parse(
    Lexer.lex(
      SourceFile.make(
        'generics/Comparison',
        new TextEncoder().encode('pub fn main() -> i32 { if 1 < 2 { return 42 } return 0 }'),
      ),
    ),
  )
  assert.notInclude(
    descendants(comparisons.root).map((node) => node.kind),
    'CallTypeArgumentList',
  )
  assert.deepEqual(comparisons.parserDiagnostics, [])

  const missingArgument = Parser.parse(
    Lexer.lex(
      SourceFile.make(
        'generics/MissingArgument',
        new TextEncoder().encode(
          'fn identity<T>(value: T) -> T { return move value }\npub fn main() -> i32 { return identity<>(1) }',
        ),
      ),
    ),
  )
  assert.include(
    descendants(missingArgument.root).map((node) => node.kind),
    'CallTypeArgumentList',
  )
  assert.include(
    missingArgument.parserDiagnostics.map((diagnostic) => diagnostic.code),
    'PAR0001',
  )

  const missingClose = Parser.parse(
    Lexer.lex(
      SourceFile.make(
        'generics/MissingClose',
        new TextEncoder().encode(
          'struct Box<T> { value: T }\nfn broken(value: Box<i32) -> i32 { return 0 }',
        ),
      ),
    ),
  )
  assert.include(
    missingClose.parserDiagnostics.map((diagnostic) => diagnostic.code),
    'PAR0001',
  )
})

it.effect('formats generic declarations, applications, and calls idempotently', () =>
  Effect.gen(function* () {
    const syntax = Parser.parse(
      Lexer.lex(
        SourceFile.make(
          'generics/format',
          new TextEncoder().encode(
            'struct Box < T >{value:T}\nfn keep < T >(value:Box < T >)->Box<T>{return identity < T >(value)}',
          ),
        ),
      ),
    )
    const formatted = yield* SyntaxFormatter.format(syntax)
    const text = new TextDecoder().decode(FormattedDocument.toUint8Array(formatted))
    assert.strictEqual(
      text,
      'struct Box<T> {\n  value: T\n}\n\nfn keep<T>(value: Box<T>) -> Box<T> {\n  return identity<T>(value)\n}\n',
    )
    const again = yield* SyntaxFormatter.format(
      Parser.parse(Lexer.lex(SourceFile.make('generics/format', new TextEncoder().encode(text)))),
    )
    assert.strictEqual(new TextDecoder().decode(FormattedDocument.toUint8Array(again)), text)
  }),
)

it.effect('formats channel-kinded generic binders idempotently', () =>
  Effect.gen(function* () {
    const syntax = Parser.parse(
      Lexer.lex(
        SourceFile.make(
          'generics/channel-format',
          new TextEncoder().encode(
            'effect fn transform < A , E , ? R >(self:Effect<A ! E ? R>)->Effect<A ! E ? R>{return self}',
          ),
        ),
      ),
    )
    const formatted = yield* SyntaxFormatter.format(syntax)
    const text = new TextDecoder().decode(FormattedDocument.toUint8Array(formatted))
    assert.strictEqual(
      text,
      `effect fn transform<A, E, ?R>(self: Effect<A ! E ? R>) -> Effect<A ! E ? R> {
  return self
}
`,
    )
    const again = yield* SyntaxFormatter.format(
      Parser.parse(
        Lexer.lex(SourceFile.make('generics/channel-format', new TextEncoder().encode(text))),
      ),
    )
    assert.strictEqual(new TextDecoder().decode(FormattedDocument.toUint8Array(again)), text)
  }),
)

it.effect('accepts failure-row and requirement-row arguments in an explicit prefix', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'generics/RowPrefix',
      new TextEncoder().encode(`struct First {}
struct Second {}
service Clock {}
service Logger {}
service Dispatch<A, ?R> { effect fn read() -> A ? R | &mut Dispatch<A, R> }
effect fn useDispatch<?R>() -> i32 ? R | &mut Clock | &mut Logger | &mut Dispatch<i32 ? R | &mut Clock | &mut Logger> {
  return run Dispatch.read<i32, R | &mut Clock | &mut Logger>()
}
effect fn risky() -> i32 ! First | Second { fail First {} }
effect fn read() -> i32 ? &Clock { return 42 }
effect fn keepFailures<E>(self: once Effect<i32 ! E>) -> i32 ! E { return run self }
effect fn keepRequirements<?R>(self: once Effect<i32 ? R>) -> i32 ? R { return run self }
effect fn useFailures() -> i32 ! First | Second {
  return run keepFailures<First | Second>(risky())
}
effect fn useRequirements() -> i32 ? &Clock {
  return run keepRequirements<Clock>(read())
}
pub fn main() -> i32 { return 0 }`),
    )

    assert.deepEqual(snapshot.diagnostics, [])
  }),
)

it.effect('rejects a borrowed explicit failure type', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'generics/WrongRowPrefix',
      new TextEncoder().encode(`struct Problem {}
struct Clock {}
effect fn risky() -> i32 ! Problem { fail Problem {} }
effect fn keepFailures<E>(self: once Effect<i32 ! E>) -> i32 ! E { return run self }
effect fn invalid() -> i32 ! Problem { return run keepFailures<Clock>(risky()) }
pub fn main() -> i32 { return 0 }`),
    )

    assert.include(
      snapshot.diagnostics.map((diagnostic) => diagnostic.code),
      'SEM0100',
    )
  }),
)

it.effect('names the parameter an explicit prefix leaves undetermined', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'generics/UninferredRemainder',
      new TextEncoder().encode(`fn phantom<A, B>(value: A) -> A { return move value }
pub fn main() -> i32 { return phantom<i32>(1) }`),
    )

    assert.deepEqual(
      snapshot.diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.message]),
      [['SEM0099', 'Cannot infer type argument B of phantom from supplied values']],
    )
    assert.strictEqual(snapshot.mir._tag, 'Unavailable')
  }),
)

it.effect('reports a contradicted explicit type argument at what the call wrote', () =>
  Effect.gen(function* () {
    const text = `fn pair<A, B>(left: A, right: B) -> A { return move left }
pub fn main() -> i32 { return pair<bool>(1, true) }`
    const snapshot = yield* AnalysisFixture.retainingMain(
      'generics/ContradictedPrefix',
      new TextEncoder().encode(text),
    )

    const diagnostic = snapshot.diagnostics.at(0)
    assert.strictEqual(snapshot.diagnostics.length, 1, Json.stringify(snapshot.diagnostics))
    assert.strictEqual(diagnostic?.code, 'SEM0100')
    assert.strictEqual(
      diagnostic?.message,
      'Type argument A of pair is bool, but the supplied values imply i32',
    )
    // The span covers the written type argument itself, not the call and not the argument that
    // disagrees with it.
    assert.strictEqual(text.slice(diagnostic?.span.start, diagnostic?.span.end), 'bool')
  }),
)

it.effect('retains unresolved type-argument causes without fabricating arity failures', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'generics/UnresolvedArgument',
      new TextEncoder().encode(
        'struct Box<T> { value: T }\nfn bad(value: Box<Missing>) -> i32 { return 0 }\npub fn main() -> i32 { return 42 }',
      ),
    )
    const codes = snapshot.diagnostics.map((diagnostic) => diagnostic.code)
    assert.include(codes, 'SEM0001')
    assert.notInclude(codes, 'SEM0051')
  }),
)

it.effect('does not fabricate a second identity for duplicate type parameters', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'generics/DuplicateIdentity',
      new TextEncoder().encode(
        'fn bad<T, T>(value: T) -> T { return move value }\npub fn main() -> i32 { return 42 }',
      ),
    )
    const declaration = Projections.genericDeclarationsOf(snapshot).at(0)
    const first = declaration?.typeParameters.at(0)
    const duplicate = declaration?.typeParameters.at(1)
    assert.notStrictEqual(first, undefined)
    assert.strictEqual(duplicate?.type, first?.type)
    assert.strictEqual(duplicate?.duplicateOf, first?.type)
  }),
)

it.effect('keeps open cleanup symbolic and specializes it before MIR', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'generics/Cleanup',
      new TextEncoder().encode(`struct Payload {}
fn discard<T>(value: T) -> i32 { return 42 }
pub fn main() -> i32 { return discard<Payload>(Payload {}) }`),
    )
    assert.deepEqual(snapshot.diagnostics, [])
    const ownership = Analysis.ownershipOf(snapshot, 'generics/Cleanup')
    assert.notStrictEqual(ownership, undefined)
    if (ownership !== undefined) {
      assert.include(OwnershipEncoding.encode(ownership), 'release p0')
      const discard = ownership.functions.find(
        (fn) =>
          fn.declaration.canonical._tag === 'Canonical' &&
          fn.declaration.canonical.id.name === 'discard',
      )
      assert.strictEqual(discard?.exits.at(0)?.releases.at(0)?.cleanup._tag, 'ParameterCleanup')
    }
    assert.strictEqual(snapshot.mir._tag, 'Available')
    if (snapshot.mir._tag !== 'Available') return
    assert.notInclude(MirEncoding.encode(snapshot.mir.value), 'TypeParameter')
  }),
)

it.effect('cuts off recursive generic calls that change an ancestor specialization', () =>
  Effect.gen(function* () {
    const recursive = SourceFile.make(
      'generics/Recursive',
      new TextEncoder().encode(`fn expand<T>(value: T) -> i32 {
  return expand<[T; 1]>([move value])
}
pub fn main() -> i32 { return expand<i32>(1) }`),
    )
    const snapshot = yield* Analysis.makeRealized({
      root: recursive.id,
      configuration: AnalysisFixture.configuration(recursive.id),
    }).pipe(
      Effect.provide(
        SourceResolver.overlay([recursive]).pipe(
          Layer.provideMerge(SourceResolver.memory(new Map())),
        ),
      ),
    )

    assert.strictEqual(snapshot.instances.violations.length, 1)
    assert.deepEqual(
      snapshot.instances.violations.at(0)?.target.typeArguments.map(Type.encodeGenericArgument),
      ['Array<i32, 1>'],
    )
    assert.strictEqual(snapshot.instances.instances.length, 2)
    assert.deepEqual(
      snapshot.diagnostics.map((diagnostic) => diagnostic.code),
      ['SEM0053'],
    )
    assert.strictEqual(snapshot.layout._tag, 'Unavailable')
    assert.strictEqual(snapshot.mir._tag, 'Unavailable')
  }),
)

it.effect('detects parameter-changing recursion across a mutual generic cycle', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'generics/MutualRecursion',
      new TextEncoder().encode(`fn first<T>(value: T) -> i32 {
  return second<[T; 1]>([move value])
}
fn second<U>(value: U) -> i32 {
  return first<U>(move value)
}
pub fn main() -> i32 { return first<i32>(1) }`),
    )
    assert.deepEqual(
      snapshot.diagnostics.map((diagnostic) => diagnostic.code),
      ['SEM0053'],
    )
    assert.strictEqual(snapshot.instances.violations.length, 1)
    assert.strictEqual(snapshot.layout._tag, 'Unavailable')
    assert.strictEqual(snapshot.mir._tag, 'Unavailable')
  }),
)

it.effect('checks repeated instances under every recursive ancestor context', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'generics/ContextualRecursion',
      new TextEncoder().encode(`fn a<T>(value: T) -> i32 { return x<T>(move value) }
fn x<T>(value: T) -> i32 {
  if false { return a<bool>(true) }
  return 0
}
pub fn main() -> i32 {
  let first = a<i32>(1)
  let second = a<bool>(true)
  return x<i32>(first + second)
}`),
    )
    assert.include(
      snapshot.diagnostics.map((diagnostic) => diagnostic.code),
      'SEM0053',
    )
    assert.isAtLeast(snapshot.instances.violations.length, 1)
    assert.strictEqual(snapshot.layout._tag, 'Unavailable')
    assert.strictEqual(snapshot.mir._tag, 'Unavailable')
  }),
)

const invalidCases: ReadonlyArray<readonly [string, string, string]> = [
  [
    'duplicate parameter',
    'fn bad<T, T>(value: T) -> T { return move value }\npub fn main() -> i32 { return 0 }',
    'SEM0050',
  ],
  [
    'unbound parameter',
    'fn bad<T>(value: U) -> T { return move value }\npub fn main() -> i32 { return 0 }',
    'SEM0001',
  ],
  [
    'missing nominal arguments',
    'struct Box<T> { value: T }\nfn bad(value: Box) -> i32 { return 0 }\npub fn main() -> i32 { return 0 }',
    'SEM0051',
  ],
  [
    'non-generic nominal application',
    'struct Plain { value: i32 }\nfn bad(value: Plain<i32>) -> i32 { return 0 }\npub fn main() -> i32 { return 0 }',
    'SEM0051',
  ],
  [
    'excess explicit arguments',
    'fn id<T>(value: T) -> T { return move value }\npub fn main() -> i32 { return id<i32, bool>(1) }',
    'SEM0051',
  ],
  [
    'excess explicit arguments past a complete prefix',
    'fn pair<A, B>(left: A, right: B) -> A { return move left }\npub fn main() -> i32 { return pair<i32, bool, u8>(1, true) }',
    'SEM0051',
  ],
  [
    'non-generic builtin specialization',
    'import silk.i32\npub fn main() -> i32 { return i32.add<i32>(40, 2) }',
    'SEM0051',
  ],
  [
    'conflicting inference',
    'fn same<T>(left: T, right: T) -> T { return move left }\npub fn main() -> i32 { return same(1, true) }',
    'SEM0052',
  ],
  [
    'return-only inference',
    'fn make<T>() -> T {}\npub fn main() -> i32 { return make() }',
    'SEM0052',
  ],
  [
    'concrete-only operation in an open body',
    'import silk.i32\nfn addOne<T>(value: T) -> i32 { return i32.add(move value, 1) }\npub fn main() -> i32 { return addOne<i32>(41) }',
    'SEM0012',
  ],
]

for (const [name, text, code] of invalidCases) {
  it.effect(`diagnoses ${name} before target-dependent phases`, () =>
    Effect.gen(function* () {
      const snapshot = yield* AnalysisFixture.retainingMain(
        `generics/invalid/${name.replaceAll(' ', '-')}`,
        new TextEncoder().encode(text),
      )
      assert.include(
        snapshot.diagnostics.map((diagnostic) => diagnostic.code),
        code,
      )
      assert.strictEqual(snapshot.instances.instances.length, 0)
      assert.strictEqual(snapshot.layout._tag, 'Unavailable')
      assert.strictEqual(snapshot.mir._tag, 'Unavailable')
    }),
  )
}

it.effect('classifies generic writes after substituting the concrete element type', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'generics/Write',
      new TextEncoder().encode(`fn replace<T>(values: [T; 1], value: T) -> i32 {
  let mut result = move values
  result[0] = move value
  return 42
}
pub fn main() -> i32 { return replace<i32>([1], 2) }`),
    )
    assert.deepEqual(snapshot.diagnostics, [])
    assert.strictEqual(snapshot.mir._tag, 'Available')
    if (snapshot.mir._tag !== 'Available') return
    const replacements = snapshot.mir.value.functions
      .flatMap((fn) => fn.regions)
      .flatMap((region) => (region._tag === 'OperationRegion' ? region.operations : []))
      .flatMap(Mir.operationTree)
      .flatMap((operation) => (operation._tag === 'WritePlace' ? [operation.replacement] : []))
    assert.deepEqual(replacements, ['Copy'])
  }),
)

it.effect('links an open TIR call through every reached caller instance', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'generics/Facade',
      new TextEncoder().encode(`fn inner<T>(value: T) -> T { return move value }
fn outer<T>(value: T) -> T { return inner<T>(move value) }
pub fn main() -> i32 {
  let flag = outer(true)
  if flag { return outer(42) }
  return 0
}`),
    )
    const call = Projections.genericCallsOf(snapshot).find(
      (candidate) => candidate.target.name === 'inner',
    )
    assert.notStrictEqual(call, undefined)
    if (call === undefined) return
    assert.deepEqual(
      Projections.instancesOfCall(snapshot, call).map((link) =>
        link.target.key.typeArguments.map(Type.encodeGenericArgument),
      ),
      [['bool'], ['i32']],
    )
  }),
)

it.effect('rejects residual open MIR and keeps specialization symbols injective', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'generics/MirBoundary',
      new TextEncoder().encode(source),
    )
    assert.strictEqual(snapshot.mir._tag, 'Available')
    if (snapshot.mir._tag !== 'Available') return
    const fn = snapshot.mir.value.functions.at(0)
    assert.notStrictEqual(fn, undefined)
    if (fn === undefined) return
    const parameter = Type.parameter({ module: 'malformed', name: 'fn' }, 0, 'T')
    const malformed = Object.freeze({
      ...snapshot.mir.value,
      functions: Object.freeze([
        Object.freeze({
          ...fn,
          instance: Object.freeze({ ...fn.instance, typeArguments: Object.freeze([parameter]) }),
        }),
      ]),
    })
    assert.include(
      (yield* MirVerification.verify(malformed)).map((violation) => violation.rule),
      'InvalidInstance',
    )

    const collision = (module: string): Mir.MirFunction => {
      const declaration = Object.freeze({
        _tag: 'CanonicalDeclarationId' as const,
        module,
        name: 'same',
      })
      return Object.freeze({
        ...fn,
        id: declaration,
        instance: Object.freeze({ ...fn.instance, declaration }),
      })
    }
    assert.notStrictEqual(Backend.symbolFor(collision('a/b')), Backend.symbolFor(collision('a_b')))
    const withStaticArgument = (byte: number): Mir.MirFunction => {
      const argument: StaticValue.TextValue = Object.freeze({
        _tag: 'TextValue',
        bytes: Object.freeze([byte]),
      })
      return Object.freeze({
        ...fn,
        instance: Object.freeze({
          ...fn.instance,
          staticArguments: Object.freeze([argument]),
        }),
      })
    }
    assert.notStrictEqual(
      Backend.symbolFor(withStaticArgument(97)),
      Backend.symbolFor(withStaticArgument(98)),
    )
  }),
)

it.effect('infers T from pointer arguments and widens *mut to *const only at a boundary', () =>
  Effect.gen(function* () {
    const program = (body: string) =>
      AnalysisFixture.retainingMain(
        'generics/pointer-boundary',
        new TextEncoder().encode(`fn identity<T>(value: T) -> T { return move value }
fn readOnly(value: *const u8) -> i32 { return 0 }
fn nested(value: *mut *const u8) -> i32 { return 0 }
fn writable(value: *mut u8) -> i32 { return 0 }
fn caller(pointer: *mut u8, shared: *const u8, deep: *mut *mut u8) -> i32 { ${body} }
pub fn main() -> i32 { return 0 }`),
      )
    const codes = (snapshot: Analysis.FrontendSnapshot) =>
      Analysis.diagnostics(snapshot).map((diagnostic) => diagnostic.code)

    const accepted = yield* program('let copy = identity(pointer) return readOnly(copy)')
    assert.deepEqual(codes(accepted), [])
    const first = Analysis.declarationIndex(accepted)
      .modules.at(0)
      ?.declarations.find((declaration) => declaration.parameterCount === 3)
      ?.parameters.at(0)?.declaredType
    assert.strictEqual(
      first?._tag === 'Resolved' ? Type.encode(first.type) : first?._tag,
      '*mut u8',
    )
    assert.deepEqual(codes(yield* program('return writable(shared)')), ['SEM0012'])
    assert.deepEqual(codes(yield* program('return nested(deep)')), ['SEM0012'])
  }),
)

it.effect('keeps specialization identities stable across native and LLVM-Wasm targets', () =>
  Effect.gen(function* () {
    const bytes = new TextEncoder().encode(`fn identity<T>(value: T) -> T { return move value }
pub fn main() -> i32 { let flag = identity(true) if flag { return identity<i32>(42) } return 0 }`)
    const native = yield* AnalysisFixture.retainingMain(
      'generics/cross-target-identities',
      bytes,
      'aarch64-apple-darwin',
    )
    const wasm = yield* AnalysisFixture.retainingMain(
      'generics/cross-target-identities',
      bytes,
      'wasm32-unknown-unknown',
    )
    assert.deepEqual(Analysis.diagnostics(native), [])
    assert.deepEqual(Analysis.diagnostics(wasm), [])
    const identities = (snapshot: Analysis.Snapshot) =>
      Analysis.instancesOf(snapshot).instances.map((instance) => ({
        declaration: instance.key.declaration,
        typeArguments: instance.key.typeArguments.map(Type.encodeGenericArgument),
      }))
    assert.deepEqual(identities(native), identities(wasm))

    const nativeArtifact = yield* Analysis.codegen(native, { mode: 'release' })
    const wasmArtifact = yield* Analysis.codegen(wasm, { mode: 'release' })
    assert.deepEqual(
      nativeArtifact.symbols.map(({ symbol, declaration }) => ({ symbol, declaration })),
      wasmArtifact.symbols.map(({ symbol, declaration }) => ({ symbol, declaration })),
    )
  }),
)

it.effect('infers the service row of a named generic scoped callback', () =>
  Effect.gen(function* () {
    const source = `struct Resource<'data, P> { provider: &'data mut P }
service ByteDuplex { effect fn read() -> i32 ? &ByteDuplex }
service Audit { effect fn record() -> () ? &mut Audit }
fn accept<'env, A, E, ?R, P>(
  provider: &'env mut P,
  callback: for<'call> once fn<'env>(&'call mut Resource<'call, P>) -> once Effect<'call; A ! E ? R>,
) -> () where R in Without<R, ByteDuplex> {
  drop provider
  drop callback
  return ()
}
effect<'transport> fn authenticated<'transport, P>(resource: &'transport mut Resource<'transport, P>) -> i32 ? &mut Audit {
  drop resource
  run Audit.record()
  return 42
}
fn connect<'env, P>(provider: &'env mut P) -> () {
  return accept<i32, never>(move provider, authenticated)
}
pub fn main() -> i32 { return 42 }`
    const snapshot = yield* Analysis.ofSource('row-probe', new TextEncoder().encode(source))
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
  }),
)

it.effect('infers direct interface arguments only from a known provider conformance', () =>
  Effect.gen(function* () {
    const text = `service Clock {}
struct Transport {}
struct OtherTransport {}
struct Output {}
struct Problem {}

interface Contextual<P, A, E, ?R> {}
interface Carries<C> {}

struct Positive {}
impl Contextual<Transport, Output, Problem ? &mut Clock> for Positive {}

struct Ambiguous {}
impl Contextual<Transport, Output, Problem ? &mut Clock> for Ambiguous {}
impl Contextual<OtherTransport, Output, Problem ? &mut Clock> for Ambiguous {}

struct Missing {}
struct Chained {}
impl Carries<Positive> for Chained {}
struct GenericContext<P, A, E, ?R> { value: A }
impl<P, A, E, ?R> Contextual<P, A, E ? R> for GenericContext<P, A, E, R> {}

fn infer<P, A, E, ?R, C: Contextual<P, A, E ? R>>(context: C) -> i32 {
  drop context
  return 11
}

fn inferWithProvider<P, A, E, ?R, C: Contextual<P, A, E ? R>>(
  provider: &P,
  context: C,
) -> i32 {
  drop provider
  drop context
  return 12
}

fn inferUnknown<P, A, E, ?R, C: Contextual<P, A, E ? R>>() -> i32 { return 13 }
fn inferChained<P, A, E, ?R, C: Contextual<P, A, E ? R>, W: Carries<C>>(
  wrapper: W,
) -> i32 { drop wrapper return 14 }
fn inferChainedReversed<W: Carries<C>, P, A, E, ?R, C: Contextual<P, A, E ? R>>(
  wrapper: W,
) -> i32 { drop wrapper return 16 }
union Optional<T> { None, Some { value: T } }
fn resultOnly<T>() -> Optional<T> { return Optional<T>.None }
fn inverseRows<?S, ?R>() -> i32 where S in R { return 15 }

fn genericAdapter<P, A, E, ?R>(
  provider: &P,
  context: GenericContext<P, A, E, R>,
) -> i32 {
  return inferWithProvider(provider, move context)
}

fn positive() -> i32 { return infer(Positive {}) }
fn explicitAgrees() -> i32 { return infer<Transport>(Positive {}) }
fn agrees() -> i32 {
  let transport = Transport {}
  return inferWithProvider(&transport, Positive {})
}
fn chained() -> i32 { return inferChained(Chained {}) }
fn chainedReversed() -> i32 { return inferChainedReversed(Chained {}) }
fn conflicts() -> i32 {
  let transport = OtherTransport {}
  return inferWithProvider(&transport, Positive {})
}
fn explicitConflicts() -> i32 { return infer<OtherTransport>(Positive {}) }
fn ambiguous() -> i32 { return infer(Ambiguous {}) }
fn missing() -> i32 { return infer(Missing {}) }
fn backwards() -> i32 { return inferUnknown() }
fn expectedResult() -> Optional<i32> { return resultOnly() }
fn inverseRow() -> i32 { return inverseRows<Clock>() }

pub fn main() -> i32 {
  return positive() + explicitAgrees() + agrees() + chained() + chainedReversed()
}`
    const snapshot = yield* Analysis.ofSource(
      'generics/known-provider-conformance',
      new TextEncoder().encode(text),
    )
    const root = Analysis.rootAnalysis(snapshot)
    const returnedCall = (name: string) => {
      const fn = records(root).functions.find(
        (candidate) =>
          candidate.declaration.name._tag === 'Present' &&
          candidate.declaration.name.spelling === name,
      )
      assert.isDefined(fn)
      const returned = fn?.returnedExpression
      assert.strictEqual(returned?._tag, 'Call')
      return returned?._tag === 'Call' ? returned : undefined
    }
    const selectedEvidenceCount = (
      name: string,
      call: Extract<Tir.Expression, { readonly _tag: 'Call' }> | undefined,
    ): number | undefined => {
      if (call === undefined) return undefined
      const body = root.bodies.find(
        (candidate) =>
          candidate.declaration.name._tag === 'Present' &&
          candidate.declaration.name.spelling === name,
      )
      return body === undefined
        ? undefined
        : BodyView.selectedEvidence(BodyView.make(body), call.evidence)?.conformances.length
    }
    for (const name of ['positive', 'explicitAgrees', 'agrees']) {
      const call = returnedCall(name)
      if (call === undefined) continue
      const arguments_ = call.typeArguments.map(Type.encodeGenericArgument)
      assert.deepEqual(arguments_.slice(0, 5), [
        'generics/known-provider-conformance.Transport',
        'generics/known-provider-conformance.Output',
        'generics/known-provider-conformance.Problem',
        '? &mut generics/known-provider-conformance.Clock',
        'generics/known-provider-conformance.Positive',
      ])
      assert.isTrue(arguments_.slice(5).every((argument) => argument.startsWith("'")))
      assert.strictEqual(selectedEvidenceCount(name, call), 1)
      assert.isFalse(
        call.typeArguments.some(
          (argument) => Type.isTypeArgument(argument) && Type.isRepresented(argument),
        ),
      )
    }
    const chained = returnedCall('chained')
    const chainedArguments =
      chained?.typeArguments.map(Type.encodeGenericArgument).slice(0, 6) ?? []
    assert.deepEqual(chainedArguments, [
      'generics/known-provider-conformance.Transport',
      'generics/known-provider-conformance.Output',
      'generics/known-provider-conformance.Problem',
      '? &mut generics/known-provider-conformance.Clock',
      'generics/known-provider-conformance.Positive',
      'generics/known-provider-conformance.Chained',
    ])
    assert.strictEqual(selectedEvidenceCount('chained', chained), 2)
    const chainedReversed = returnedCall('chainedReversed')
    const reversedArguments =
      chainedReversed?.typeArguments.map(Type.encodeGenericArgument).slice(0, 6) ?? []
    assert.deepEqual(reversedArguments, [
      'generics/known-provider-conformance.Chained',
      'generics/known-provider-conformance.Transport',
      'generics/known-provider-conformance.Output',
      'generics/known-provider-conformance.Problem',
      '? &mut generics/known-provider-conformance.Clock',
      'generics/known-provider-conformance.Positive',
    ])
    assert.deepEqual(
      reversedArguments.length === 6
        ? [
            reversedArguments[1],
            reversedArguments[2],
            reversedArguments[3],
            reversedArguments[4],
            reversedArguments[5],
            reversedArguments[0],
          ]
        : [],
      chainedArguments,
    )
    assert.strictEqual(selectedEvidenceCount('chainedReversed', chainedReversed), 2)
    const genericAdapter = returnedCall('genericAdapter')
    assert.strictEqual(selectedEvidenceCount('genericAdapter', genericAdapter), 1)

    const diagnostics = Analysis.diagnostics(snapshot).map((diagnostic) => ({
      code: diagnostic.code,
      source: text.slice(diagnostic.span.start, diagnostic.span.end).trim(),
    }))
    assert.deepEqual(diagnostics, [
      { code: 'SEM0100', source: 'inferWithProvider(&transport, Positive {})' },
      { code: 'SEM0100', source: 'infer<OtherTransport>(Positive {})' },
      { code: 'SEM0099', source: 'infer(Ambiguous {})' },
      { code: 'SEM0099', source: 'infer(Missing {})' },
      { code: 'SEM0099', source: 'inferUnknown()' },
      { code: 'SEM0052', source: 'resultOnly()' },
      { code: 'SEM0074', source: 'inverseRows<Clock>()' },
    ])
  }),
)
