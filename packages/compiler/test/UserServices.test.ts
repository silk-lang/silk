import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Analysis from '../src/Analysis.js'
import * as ConformanceProof from '../src/ConformanceProof.js'
import * as Instances from '../src/Instances.js'
import * as SourceCallView from '../src/SourceCallView.js'
import * as Tir from '../src/Tir.js'
import * as Type from '../src/Type.js'
import * as AnalysisFixture from './support/AnalysisFixture.js'
import { unreachable } from './support/raise.js'

const encoder = new TextEncoder()

const sourceId = 'user-services/main'

const snapshot = (source: string) => Analysis.ofSource(sourceId, encoder.encode(source))

const realized = (source: string, target?: string) =>
  AnalysisFixture.retainingMain(sourceId, encoder.encode(source), target)

const sharedSource = `import silk.effect { Effect }
service Counter { effect fn get() -> i32 ? &Counter }
struct Fixed { value: i32 }
effect fn get(self: &Fixed) -> i32 { return self.value }
impl Counter for Fixed { get: Fixed.get }
effect fn read() -> i32 ? &Counter { return run Counter.get() }
pub fn main() -> i32 {
  let fixed = Fixed { value: 42 }
  return run Effect.provide(read(), &fixed)
}`

it.effect('lowers shared source service dispatch through native LLVM', () =>
  Effect.gen(function* () {
    const native = yield* realized(sharedSource, 'aarch64-apple-darwin')
    assert.deepEqual(Analysis.diagnostics(native), [])
    const llvm = yield* Analysis.codegen(native, { mode: 'release' })
    assert.include(llvm.ir, 'define')
    assert.notInclude(llvm.ir, 'Counter')
  }),
)

it.effect('lowers a generic service witness that names its retained environment', () =>
  Effect.gen(function* () {
    const self = yield* realized(`import silk.effect { Effect }
service Dispatch<H> { effect<'env> fn with<'env>(handler: H) -> i32 ? &mut Dispatch<H> }
struct Provider<H> {}
impl<H> Dispatch<H> for Provider<H> {
  effect<'env> fn with<'env>(self: &mut Self, handler: H) -> i32 { drop handler return 5 }
}
effect fn useDispatch() -> i32 ? &mut Dispatch<i32> { return run Dispatch.with<i32>(5) }
pub fn main() -> i32 {
  let mut provider = Provider<i32> {}
  return run useDispatch() |> Effect.provideMut<Dispatch<i32>>(&mut provider)
}`)
    assert.deepEqual(Analysis.diagnostics(self), [])
    const mir = Analysis.loweredMir(self)
    assert.isTrue(mir.functions.some((fn) => fn.id.name.includes('with')))
    const discovery = Analysis.instancesOf(self)
    const caller =
      discovery.instances.find((instance) => instance.key.declaration.name === 'useDispatch') ??
      unreachable('missing generic service caller')
    const subject = caller.function.statements
      .flatMap(Tir.statementExpressions)
      .flatMap(Tir.expressionTree)
      .find(
        (node): node is Extract<Tir.Expression, { readonly _tag: 'ServiceEffectConstruct' }> =>
          node._tag === 'ServiceEffectConstruct',
      )
    if (subject === undefined) return unreachable('missing original generic service operation')
    const call = discovery.calls.find(
      (candidate) =>
        Instances.keyText(candidate.owner) === Instances.keyText(caller.key) &&
        candidate.node?.ordinal === subject.id?.ordinal,
    )
    if (call === undefined) return unreachable('missing original generic service call')
    const implementation = discovery.instances.find(
      (instance) => Instances.keyText(instance.key) === Instances.keyText(call.target),
    )
    if (implementation === undefined) return unreachable('missing selected generic implementation')
    const root = implementation.function.statements
      .flatMap(Tir.statementExpressions)
      .find((node) => node._tag === 'EffectBlock')
    if (root?._tag !== 'EffectBlock') return unreachable('missing original generic Effect body')
    const capture = root.captures.find((entry) => entry.parameter?.ordinal === 1)
    assert.strictEqual(capture?.access, 'Take')
    assert.strictEqual(implementation.specialization.parameters.at(1), 'i32')
    const environment = mir.layout.effectEnvironments.find(
      (candidate) =>
        candidate._tag === 'EffectEnvironment' &&
        Instances.keyText(candidate.instance) === Instances.keyText(call.target) &&
        Instances.effectIdentity(candidate.instance, candidate.site) === call.resultEffect,
    )
    if (environment?._tag !== 'EffectEnvironment')
      return unreachable('missing actual generic capture environment')
    assert.strictEqual(environment.fields.find((field) => field.ordinal === 1)?.access, 'Take')
    const receiver = implementation.specialization.parameters.at(0)
    if (receiver === undefined || !Type.isReference(receiver) || !Type.isNominal(receiver.target))
      return unreachable('missing original generic provider receiver')
    const capability = Type.substitute(subject.service, caller.substitution)
    if (!Type.isNominal(capability)) return unreachable('missing generic service capability')
    const witness = ConformanceProof.witness(
      Analysis.declarationIndex(self),
      receiver.target,
      capability,
    )
    if (witness?._tag !== 'SourceConformanceWitness')
      return unreachable('missing original generic service witness')
    const provider = {
      capability,
      providerType: receiver.target,
      witness,
      role: subject.role,
      access: subject.access,
      requirementAccess: subject.access,
    }
    const held = {
      owner: caller,
      index: Analysis.declarationIndex(self),
      instances: discovery.instances,
      calls: discovery.calls,
      layout: mir.layout,
      semantic: (type: Type.Type) => Type.substitute(type, caller.substitution),
    }
    assert.isDefined(SourceCallView.service(held, subject, call, provider, environment.effect))
    const copyCapture = {
      ...mir.layout,
      effectEnvironments: mir.layout.effectEnvironments.map((candidate) =>
        candidate === environment
          ? {
              ...environment,
              fields: environment.fields.map((field) =>
                field.ordinal === 1 ? { ...field, access: 'Copy' as const } : field,
              ),
            }
          : candidate,
      ),
    }
    assert.isUndefined(
      SourceCallView.service(
        { ...held, layout: copyCapture },
        subject,
        call,
        provider,
        environment.effect,
      ),
    )
    const copiedRoot = {
      ...root,
      captures: root.captures.map((entry) =>
        entry === capture ? { ...entry, access: 'Copy' as const } : entry,
      ),
    }
    const copiedFunction: Tir.TirFunction = {
      ...implementation.function,
      statements: implementation.function.statements.map((statement) =>
        statement._tag === 'Return' && statement.expression === root
          ? { ...statement, expression: copiedRoot }
          : statement,
      ),
    }
    assert.include(copiedFunction.statements.flatMap(Tir.statementExpressions), copiedRoot)
    const copiedImplementation = { ...implementation, function: copiedFunction }
    assert.isUndefined(
      SourceCallView.service(
        {
          ...held,
          instances: discovery.instances.map((candidate) =>
            candidate === implementation ? copiedImplementation : candidate,
          ),
          layout: copyCapture,
        },
        subject,
        call,
        provider,
        environment.effect,
      ),
    )
  }),
)

it.effect('rejects a generic service witness bound its header never promises', () =>
  Effect.gen(function* () {
    const self = yield* snapshot(`interface Marker<T> { fn mark(value: T) -> i32 }
interface Other<T> { fn mark(value: T) -> i32 }
service Counter<Value> { effect fn get(value: &Value) -> i32 ? &Counter<Value> }
struct Fixed<S> {}
effect fn get<S: Other>(self: &Fixed<S>, value: &S) -> i32 { return 42 }
impl<S: Marker<S>> Counter<S> for Fixed<S> { get: Fixed.get }
pub fn main() -> i32 { return 0 }`)
    const invalid = Analysis.diagnostics(self).filter((diagnostic) => diagnostic.code === 'SEM0083')
    assert.strictEqual(invalid.length, 1)
    assert.include(invalid.at(0)?.message ?? '', 'does not require')
    assert.include(invalid.at(0)?.message ?? '', 'Other')
  }),
)

it.effect('admits a witness provides constraint only when its header promises it', () =>
  Effect.gen(function* () {
    const source = (head: string) => `service Source { effect fn get() -> i32 ? &Source }
service Port { effect fn value() -> i32 ? &mut Port }
struct Wrap<P> { provider: P }
impl<P> Wrap<P> {
  effect fn read(self: &mut Self) -> i32 where &mut P provides &Source from &mut Source {
    return 42
  }
}
impl<P> Port for Wrap<P>${head} { value: Wrap.read }
pub fn main() -> i32 { return 0 }`
    const promised = yield* snapshot(source(' where &mut P provides &Source from &mut Source'))
    const unpromised = yield* snapshot(source(''))
    const invalid = Analysis.diagnostics(unpromised).filter(
      (diagnostic) => diagnostic.code === 'SEM0083',
    )
    assert.deepEqual(Analysis.diagnostics(promised), [])
    assert.strictEqual(invalid.length, 1)
    assert.include(invalid.at(0)?.message ?? '', 'requires a where constraint on P')
    const inline = yield* snapshot(`service Source { effect fn get() -> i32 ? &Source }
service Port { effect fn value() -> i32 ? &mut Port }
struct Wrap<P> { provider: P }
impl<P> Wrap<P> {
  effect fn read(self: &mut Self) -> i32 where &mut P provides &Source from &mut Source {
    return 42
  }
}
impl<P> Port for Wrap<P> where &mut P provides &Source from &mut Source {
  effect fn value(self: &mut Self) -> i32 { return run Wrap.read(move self) }
}
pub fn main() -> i32 { return 0 }`)
    assert.deepEqual(Analysis.diagnostics(inline), [])
  }),
)

it.effect('rejects a where clause on an inherent implementation head', () =>
  Effect.gen(function* () {
    const self = yield* snapshot(`service Source { effect fn get() -> i32 ? &Source }
struct Wrap<P> { provider: P }
impl<P> Wrap<P> where &mut P provides &Source from &mut Source {}
pub fn main() -> i32 { return 0 }`)
    assert.deepEqual(
      Analysis.diagnostics(self).map((diagnostic) => diagnostic.code),
      ['SEM0194'],
    )
  }),
)

it.effect('accepts failure and requirement rows promised by a generic service header', () =>
  Effect.gen(function* () {
    const self = yield* snapshot(`interface Marker<T> { fn mark(value: T) -> i32 }

service Counter<E, ?R, Value> {
  effect fn get(value: &Value) -> i32 ! E ? R | &Counter<E, R, Value>
}

struct Fixed<S, E, ?R> {}
effect fn get<S: Marker, E, ?R>(self: &Fixed<S, E, R>, value: &S) -> i32 ! E ? R {
  return 42
}
impl<S: Marker<S>, E, ?R> Counter<E, R, S> for Fixed<S, E, R> { get: Fixed.get }

pub fn main() -> i32 { return 0 }`)
    assert.deepEqual(
      Analysis.diagnostics(self).map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`),
      [],
    )
  }),
)

it.effect('keeps InsecureSeed fields private', () =>
  Effect.gen(function* () {
    const self = yield* Analysis.ofSource(
      'insecure-seed/private',
      encoder.encode(`import silk.insecure_seed { InsecureSeed }
pub fn main() -> i32 {
  let provider = InsecureSeed.fixed(1, 2)
  return provider.seed.first
}`),
    )
    assert.deepEqual(
      Analysis.diagnostics(self).map((diagnostic) => diagnostic.code),
      ['SEM0028'],
    )
  }),
)

it.effect('keeps ordinary Report conformance static and out of requirement rows', () =>
  Effect.gen(function* () {
    // Realized so the default runtime's startup analyzes main. Startup does not reject a leaked
    // non-service requirement, so the declaration's requirement row is asserted directly.
    const self = yield* Analysis.ofSourceRealized(
      sourceId,
      encoder.encode(`pub struct Problem {}
pub effect fn main() -> () ! Problem { return () }`),
    )
    assert.deepEqual(Analysis.diagnostics(self), [])
    const main = Analysis.memberByName(self, sourceId, 'main')
    assert.deepEqual(
      main._tag === 'Resolved' && main.declaration._tag === 'FunctionDeclaration'
        ? main.declaration.requirementRow.requirements.map((requirement) =>
            Type.encode(requirement.capability),
          )
        : main,
      [],
    )
  }),
)

it.effect('rejects an ordinary interface as an Effect dependency', () =>
  Effect.gen(function* () {
    const self = yield* snapshot(`interface Clock { fn now(value: &Self) -> i32 }
effect fn read() -> i32 ? &Clock { return 42 }
pub fn main() -> i32 { return 0 }`)
    assert.isTrue(
      Analysis.diagnostics(self).some(
        (diagnostic) => diagnostic.code === 'SEM0070' && diagnostic.message.includes('Clock'),
      ),
    )
  }),
)

it.effect('allows a service to participate in an ordinary compile-time bound', () =>
  Effect.gen(function* () {
    const self = yield* snapshot(`service Clock { effect fn now() -> i32 ? &Clock }
struct Fixed {}
effect fn now(self: &Fixed) -> i32 { return 42 }
impl Clock for Fixed { now: Fixed.now }
fn preserve<T: Clock>(value: T) -> T { return move value }
pub fn main() -> i32 { return 0 }`)
    assert.deepEqual(Analysis.diagnostics(self), [])
  }),
)

it.effect('resolves same-named mapped operations within each provider', () =>
  Effect.gen(function* () {
    const self = yield* snapshot(`import silk.effect { Effect }
service Counter { effect fn get() -> i32 ? &Counter }
struct First { value: i32 }
struct Second { value: i32 }
struct Third { value: i32 }
effect fn get(self: &Third) -> i32 { return self.value }
impl Counter for Third { get: Third.get }
impl First { effect fn get(self: &Self) -> i32 { return self.value } }
impl Second { effect fn get(self: &Self) -> i32 { return self.value } }
impl Counter for First { get: First.get }
impl Counter for Second { get: Second.get }
effect fn read() -> i32 ? &Counter { return run Counter.get() }
pub fn main() -> i32 {
  let first = First { value: 20 }
  let second = Second { value: 22 }
  let left = run Effect.provide(read(), &first)
  let right = run Effect.provide(read(), &second)
  return left + right
}`)
    assert.deepEqual(Analysis.diagnostics(self), [])
  }),
)

it.effect('discharges a concrete named callback provider constraint before passing its value', () =>
  Effect.gen(function* () {
    const source = `import silk.effect { Effect }
service Counter { effect fn get() -> i32 ? &Counter }
struct Fixed { value: i32 }
effect fn get(self: &Fixed) -> i32 { return self.value }
impl Counter for Fixed { get: Fixed.get }
effect<'call> fn callback<'call, P>(provider: &'call P) -> i32
where &'call P provides &Counter from &Counter {
  return run Effect.provide<Counter>(Counter.get(), move provider)
}
fn invoke<P>(
  provider: P,
  callback: for<'call> fn(&'call P) -> Effect<'call; i32>,
) -> i32 { return run callback(&provider) }
pub fn main() -> i32 { return invoke(Fixed { value: 42 }, callback) }`
    const accepted = yield* snapshot(source)
    assert.deepEqual(Analysis.diagnostics(accepted), [])
    const rejected = yield* snapshot(
      source.replace('impl Counter for Fixed { get: Fixed.get }', ''),
    )
    assert.include(
      Analysis.diagnostics(rejected).map((diagnostic) => diagnostic.code),
      'SEM0123',
    )
  }),
)
