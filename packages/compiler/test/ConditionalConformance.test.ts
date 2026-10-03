import * as AnalysisFixture from './support/AnalysisFixture.js'
import { readFileSync } from 'node:fs'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Analysis from '../src/Analysis.js'
import * as ConformanceProof from '../src/ConformanceProof.js'
import * as ConformanceGoal from '../src/ConformanceGoal.js'
import * as ConformanceHead from '../src/ConformanceHead.js'
import * as DeclarationIndex from '../src/DeclarationIndex.js'
import * as Tir from '../src/Tir.js'
import * as Lifetime from '../src/Lifetime.js'
import * as MirEncoding from '../src/MirEncoding.js'
import * as MirVerification from '../src/MirVerification.js'
import * as Type from '../src/Type.js'
import * as Projections from './support/projections.js'
import { raise } from './support/raise.js'

const ascii = (value: string): Uint8Array => Uint8Array.from(value, (unit) => unit.charCodeAt(0))

const golden = (name: string): string =>
  readFileSync(new URL(`./goldens/${name}`, import.meta.url), 'utf8')

const analyze = (name: string, source: string) =>
  AnalysisFixture.retainingMain(name, ascii(source), 'wasm32-unknown-unknown')

it.effect('selects capability-bound parameters for one reusable provider', () =>
  Effect.gen(function* () {
    const module = 'conformance/capability-bound-parameters'
    const source = `interface Echo<T> {
  fn echo(self: &Self, value: T) -> T
}
struct Client {}
impl<T> Echo<T> for Client {
  fn echo(self: &Self, value: T) -> T { return move value }
}
interface Pick<T, R> { fn pick(self: &Self, value: T) -> R }
impl<T> Pick<T, i32> for Client {
  fn pick(self: &Self, value: T) -> i32 { drop value return 1 }
}
fn choose<R, C: Pick<bool, R>>(client: &C) -> R {
  return Pick<bool, R>.pick(client, true)
}
fn calls(client: &Client) -> i32 {
  let flag = Echo<bool>.echo(client, true)
  let inferred = choose(client)
  if flag { return Echo<i32>.echo(client, 42) + inferred }
  return 0
}
interface Unfixed<T> {}
impl<T> Unfixed<T> for Client {}
fn unknown<A, C: Unfixed<A>>(client: &C) -> () { drop client }
fn rejected(client: &Client) -> () { return unknown(client) }`
    const snapshot = yield* AnalysisFixture.frontend(module, ascii(source))
    assert.deepEqual(
      Analysis.diagnostics(snapshot).map((diagnostic) => ({
        code: diagnostic.code,
        span: source.slice(diagnostic.span.start, diagnostic.span.end).trim(),
      })),
      [{ code: 'SEM0099', span: 'unknown(client)' }],
    )
    for (const argument of ['i32', 'bool'] as const) {
      const proof = ConformanceProof.prove(
        Analysis.declarationIndex(snapshot),
        Type.nominal(module, 'Client'),
        Type.nominal(module, 'Echo', [argument]),
      )
      assert.strictEqual(proof._tag, 'Proved')
      if (proof._tag === 'Proved')
        assert.deepEqual(proof.typeArguments.map(Type.encodeGenericArgument), [argument])
    }
    const index = Analysis.declarationIndex(snapshot)
    const goal = ConformanceGoal.make(
      Type.nominal(module, 'Echo', ['i32']),
      Type.nominal(module, 'Client'),
    )
    assert.lengthOf(ConformanceProof.conformanceCandidates(index, goal), 1)
    // A new immutable module collection must not inherit the warmed discovery index.
    const withoutImpls = DeclarationIndex.make(
      index.stage,
      index.modules.map((headers) => ({ ...headers, conformances: [] })),
      index.diagnostics,
      index.generatedAggregates,
    )
    assert.isEmpty(ConformanceProof.conformanceCandidates(withoutImpls, goal))
    assert.lengthOf(ConformanceProof.conformanceCandidates(index, goal), 1)
  }),
)

it.effect('retains a proved interface target across lifetime-only application differences', () =>
  Effect.gen(function* () {
    const module = 'conformance/witness-application-lifetimes'
    const snapshot = yield* AnalysisFixture.frontend(
      module,
      ascii(`struct Request<'a> { value: &'a i32 }
interface Read<'a> { effect fn read(self: &Self, request: Request<'a>) -> Request<'a> }
struct Client<'a> { value: &'a i32 }
impl<'a> Read<'a> for Client<'a> {
  effect fn read(self: &Self, request: Request<'a>) -> Request<'a> { return move request }
}
effect fn invoke<'a, C: Read<'a>>(client: &C, request: Request<'a>) -> Request<'a> {
  return run Read<'a>.read(client, move request)
}`),
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    const tir = Projections.tirOf(snapshot, module) ?? raise('expected TIR')
    const fn =
      tir.functions.find(
        (fn) => fn.declaration.name._tag === 'Present' && fn.declaration.name.spelling === 'invoke',
      ) ?? raise('expected invocation')
    const call =
      fn.statements
        .flatMap(Tir.statementExpressions)
        .flatMap(Tir.expressionTree)
        .find((expression) => expression._tag === 'InterfaceOperationCall') ??
      raise('expected interface call')
    if (call._tag !== 'InterfaceOperationCall') return
    const owner = { module, name: 'main' }
    const provider = Type.nominal(module, 'Client', [Lifetime.local(owner, 'provider', 0)])
    const substitution = new Map<string, Type.GenericArgument>(
      fn.declaration.typeParameters.map((parameter, ordinal) => [
        Type.key(parameter.type),
        parameter.type.kind === 'Lifetime'
          ? Lifetime.local(owner, 'application', ordinal)
          : provider,
      ]),
    )
    const capability = Type.substitute(call.capability, substitution)
    if (!Type.isNominal(capability)) return raise('expected capability')
    const index = Analysis.declarationIndex(snapshot)
    assert.strictEqual(ConformanceProof.prove(index, provider, capability)._tag, 'Proved')
    const target = ConformanceProof.interfaceWitnessTarget(
      index,
      provider,
      capability,
      call.operation,
      call.contract,
      substitution,
    )
    assert.strictEqual(target?.implementation.name, 'impl@0.read')
    const wrongApplication = {
      ...call.contract,
      operands: call.contract.operands.map((operand, ordinal) =>
        ordinal === 1 && operand.type._tag === 'Resolved'
          ? { ...operand, type: { ...operand.type, type: 'bool' as const } }
          : operand,
      ),
    }
    assert.strictEqual(
      ConformanceProof.interfaceWitnessTarget(
        index,
        provider,
        capability,
        call.operation,
        wrongApplication,
        substitution,
      ),
      undefined,
    )
  }),
)

it.effect('does not invent witness lifetimes for concrete requirement-row access', () =>
  Effect.gen(function* () {
    const source = `service Clock {}
service Selected<T, E, ?R> {}
interface Use<'policy, E, ?R> {
  effect fn use(self: &mut Self, policy: &'policy i32) -> () ! E ? R
}
struct Client<'policy, E, ?R> {policy: &'policy i32}
impl<'policy, E, ?R>
Use<'policy, E, R | &mut Selected<&'policy i32, E, R> | &mut Clock>
for Client<'policy, E, R> {
  effect fn use(self: &mut Self, policy: &'policy i32) -> ()
  ! E ? R | &mut Selected<&'policy i32, E, R> | &mut Clock { return () }
}`
    const snapshot = yield* AnalysisFixture.frontend(
      'conformance/row-access-lifetimes',
      ascii(source),
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
  }),
)

const effectContext = `interface Handler<P, A, E, ?R> {
  effect<'env> fn handle<'env>(handler: Self, provider: &mut P) -> A ! E ? R
}

interface Contextual<P, A, E, ?R> {
  effect<'env> fn use<'env>(context: Self, provider: &mut P) -> A ! E ? R
}

struct Context<P, A, E, ?R, H> { handler: H }

impl<P, A, E, ?R, OuterH> Context<P, A, E, R, OuterH> {
  effect<'env> fn use<H: Handler<P, A, E ? R> + 'env, 'env>(
    context: Context<P, A, E, R, H>,
    provider: &mut P,
  ) -> A ! E ? R {
    let Context<P, A, E, R, H> {handler} = move context
    return run Handler<P, A, E ? R>.handle(move handler, move provider)
  }
}

impl<P, A, E, ?R, H: Handler<P, A, E ? R>>
  Contextual<P, A, E ? R> for Context<P, A, E, R, H> {
  use: Context.use
}

effect<'env> fn acquire<P, A, E, ?R, C: Contextual<P, A, E ? R> + 'env, 'env>(
  provider: &mut P,
  context: C,
) -> A ! E ? R {
  return run Contextual<P, A, E ? R>.use(move context, move provider)
}
`

const splitContext = `service ByteDuplex {}
service Clock {}
struct Problem {}
struct OtherProblem {}
interface SplitHandler<A, E, ?R> {
  effect<'env> fn handle<'env>(handler: Self) -> A ! E ? R
}
interface Split<A, E, ?R, ?Q> {
  effect<'env> fn use<'env>(context: Self) -> A ! E ? R | Q
}
struct SplitContext<A, E, ?R, H> { handler: H }
impl<A, E, ?R, OuterH> SplitContext<A, E, R, OuterH> {
  effect<'env> fn use<H: SplitHandler<A, E ? R> + 'env, 'env>(context: SplitContext<A, E, R, H>)
  -> A ! E | Problem ? R | &mut Clock {
    let SplitContext<A, E, R, H> {handler} = move context
    return run SplitHandler<A, E ? R>.handle(move handler)
  }
}
impl<A, E, ?R, H: SplitHandler<A, E ? R>>
  Split<A, E | Problem, R ? &mut Clock> for SplitContext<A, E, R, H> {
  use: SplitContext.use
}
effect<'env> fn acceptSplit<A, E, ?R, ?Q, C: Split<A, E, R ? Q> + 'env, 'env>(context: C) -> A ! E ? R | Q
where R in Without<R, ByteDuplex>, Q in Without<Q, ByteDuplex> {
  return run Split<A, E, R ? Q>.use(move context)
}
effect<'env> fn splitBridge<A, E, ?R, H: SplitHandler<A, E ? R> + 'env, 'env>(handler: H)
-> A ! E | Problem ? R | &mut Clock
where R in Without<R, ByteDuplex> {
  return run acceptSplit<A, E | Problem, R>(
    SplitContext<A, E, R, H> {handler: move handler},
  )
}
`

it.effect('resolves nested conditional contexts from exact enclosing bounds', () =>
  Effect.gen(function* () {
    const source = `interface Ready {}
struct Wrapper<T> { value: T }
impl<T: Ready> Ready for Wrapper<T> {}
fn accept<T: Ready>(value: T) -> () { drop value }
fn forward<T: Ready>(value: T) -> () {
  return accept(Wrapper<Wrapper<T>> {value: Wrapper<T> {value: move value}})
}
fn missing<T>(value: T) -> () {
  return accept(Wrapper<Wrapper<T>> {value: Wrapper<T> {value: move value}})
}`
    const snapshot = yield* Analysis.ofSource(
      'conditional-conformance/nested-context',
      ascii(source),
    )
    assert.deepEqual(
      Analysis.diagnostics(snapshot).map((diagnostic) => ({
        code: diagnostic.code,
        start: diagnostic.span.start,
      })),
      [{ code: 'SEM0121', start: source.lastIndexOf('accept(') }],
    )
  }),
)

it.effect('infers exact Effect-polymorphic and split-row conditional contexts', () =>
  Effect.gen(function* () {
    const snapshot = yield* analyze(
      'conditional-conformance/effect-context',
      `${effectContext}
${splitContext}

effect<'env> fn bridge<P, A, E, ?R, H: Handler<P, A, E ? R> + 'env, 'env>(
  provider: &mut P,
  handler: H,
) -> A ! E ? R {
  let context = Context<P, A, E, R, H> {handler: move handler}
  return run acquire(move provider, move context)
}

struct Provider {}
struct ConcreteHandler {}
impl Handler<Provider, i32, never ? never> for ConcreteHandler {
  effect fn handle(handler: Self, provider: &mut Provider) -> i32 {
    drop handler
    drop provider
    return 42
  }
}

struct SplitValue {}
impl SplitHandler<i32, Problem | OtherProblem ? never> for SplitValue {
  effect fn handle(handler: Self) -> i32 ! Problem | OtherProblem {
    drop handler
    return 42
  }
}

pub fn main() -> i32 {
  let pending = splitBridge(SplitValue {})
  drop pending
  let mut provider = Provider {}
  return run bridge(&mut provider, ConcreteHandler {})
}`,
    )
    const tir = Projections.tirOf(snapshot, 'conditional-conformance/effect-context')
    const discovery = Analysis.instancesOf(snapshot)
    assert.deepEqual(
      discovery.specializationFailures.map((failure) => ({
        declaration: failure.key.declaration.name,
        typeArguments: failure.key.typeArguments.map(Type.encodeGenericArgument),
        contractRow: failure.key.contractRow,
        evidence: failure.key.evidence,
      })),
      [],
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    // The concrete provider fixes E before E | Problem is normalized in the capability head.
    assert.isTrue(
      discovery.instances.some((instance) => instance.key.declaration.name === 'splitBridge'),
    )
    const conformance = Analysis.declarationIndex(snapshot)
      .modules.flatMap((module) => module.conformances)
      .find((candidate) =>
        candidate.operations.some(
          (operation) =>
            operation.target._tag === 'TypePath' && operation.target.spelling === 'Context.use',
        ),
      )
    const mapping = conformance?.operations.at(0)
    // The witness writes its retained environment, so it also binds `'env`.
    assert.strictEqual(mapping?.targetArguments?.length, 7)
    assert.deepEqual(mapping?.targetArguments?.slice(0, 5).map(Type.encodeGenericArgument), [
      'P',
      'A',
      'E',
      '? R',
      'H',
    ])
    const acquireInstance = discovery.instances.find(
      (instance) => instance.key.declaration.name === 'acquire',
    )
    const contextualOperation = acquireInstance?.function.statements
      .flatMap(Tir.statementExpressions)
      .flatMap(Tir.expressionTree)
      .find((expression) => expression._tag === 'InterfaceOperationCall')
    assert.strictEqual(contextualOperation?._tag, 'InterfaceOperationCall')
    if (acquireInstance === undefined || contextualOperation?._tag !== 'InterfaceOperationCall')
      return
    const capability = Type.substitute(contextualOperation.capability, acquireInstance.substitution)
    const provider = Type.substitute(contextualOperation.provider, acquireInstance.substitution)
    assert.isTrue(Type.isNominal(capability))
    if (!Type.isNominal(capability)) return
    const target = ConformanceProof.interfaceWitnessTarget(
      Analysis.declarationIndex(snapshot),
      provider,
      capability,
      contextualOperation.operation,
      contextualOperation.contract,
      acquireInstance.substitution,
    )
    assert.deepEqual(target?.selection, {
      _tag: 'SourceSelection',
      module: 'conditional-conformance/effect-context',
      ordinal: conformance?.ordinal,
    })
    assert.strictEqual(target?.implementation.name, 'Context.use')
    const realized = discovery.instances.find(
      (instance) => instance.key.declaration.name === 'Context.use',
    )
    assert.isDefined(realized)
    assert.deepEqual(realized?.key.evidence, [])
    assert.deepEqual(realized?.specialization.evidence, [])
    const mir = Analysis.loweredMir(snapshot)
    assert.deepEqual(yield* MirVerification.verify(mir), [])
    const runner = mir.functions.find((fn) => fn.id.name === 'acquire$effect$0')
    assert.isDefined(runner)
    if (runner === undefined) return
    const witnessCalls = MirVerification.operations(runner).filter(
      (operation) =>
        operation._tag === 'MakeEffect' && operation.runner.name === 'Context.use$effect$-1',
    )
    assert.lengthOf(witnessCalls, 1)
    assert.isTrue(
      witnessCalls.every(
        (call) =>
          call._tag === 'MakeEffect' &&
          call.runnerTypeArguments.every(Type.isRuntimeConcreteGenericArgument),
      ),
    )
    const acquireCall = tir?.functions
      .flatMap((fn) => fn.statements)
      .flatMap(Tir.statementExpressions)
      .flatMap(Tir.expressionTree)
      .find(
        (expression) =>
          expression._tag === 'EffectConstruct' && expression.target.name === 'acquire',
      )
    assert.strictEqual(acquireCall?._tag, 'EffectConstruct')
    if (acquireCall?._tag !== 'EffectConstruct') return
    assert.deepEqual(
      acquireCall.symbolicConformances.map((selection) => selection.selection),
      [
        {
          _tag: 'SourceSelection',
          module: 'conditional-conformance/effect-context',
          ordinal: conformance?.ordinal,
        },
      ],
    )
  }),
)

it.effect('rejects conditional Effect contexts without the exact handler evidence', () =>
  Effect.gen(function* () {
    const negativeSource = `${effectContext}

effect<'env> fn missing<P, A, E, ?R, H: 'env, 'env>(provider: &mut P, handler: H) -> A ! E ? R {
  let context = Context<P, A, E, R, H> {handler: move handler}
  return run acquire(move provider, move context)
}

effect<'env> fn mismatch<P, A, E, ?R, ?S, H: Handler<P, A, E ? R> + 'env, 'env>(
  provider: &mut P,
  handler: H,
) -> A ! E ? S {
  let context = Context<P, A, E, S, H> {handler: move handler}
  return run acquire(move provider, move context)
}

pub fn main() -> i32 { return 0 }`
    const snapshot = yield* analyze(
      'conditional-conformance/effect-context-invalid',
      negativeSource,
    )
    const responsibleExpression = 'acquire(move provider, move context)'
    const missingCallStart = negativeSource.indexOf(responsibleExpression)
    const mismatchedCallStart = negativeSource.lastIndexOf(responsibleExpression)
    assert.deepEqual(
      Analysis.diagnostics(snapshot).map((entry) => ({
        code: entry.code,
        message: entry.message,
        notes: entry.notes,
        span: negativeSource.slice(entry.span.start, entry.span.end),
        spanStart: entry.span.start,
      })),
      [
        {
          code: 'SEM0121',
          message:
            'conditional-conformance/effect-context-invalid.Contextual<P, A, E, ? R> for conditional-conformance/effect-context-invalid.Context<P, A, E, ? R, H> cannot be proved: the exact enclosing bound is not declared',
          notes: [
            'required by conditional-conformance/effect-context-invalid.Contextual<P, A, E, ? R> for conditional-conformance/effect-context-invalid.Context<P, A, E, ? R, H>',
            '  conditional-conformance/effect-context-invalid.Handler<P, A, E, ? R> for H: the exact enclosing bound is not declared',
          ],
          span: responsibleExpression,
          spanStart: missingCallStart,
        },
        {
          code: 'SEM0121',
          message:
            'conditional-conformance/effect-context-invalid.Contextual<P, A, E, ? S> for conditional-conformance/effect-context-invalid.Context<P, A, E, ? S, H> cannot be proved: declared conditional-conformance/effect-context-invalid.Handler<P, A, E, ? R> does not exactly match required conditional-conformance/effect-context-invalid.Handler<P, A, E, ? S>',
          notes: [
            'required by conditional-conformance/effect-context-invalid.Contextual<P, A, E, ? S> for conditional-conformance/effect-context-invalid.Context<P, A, E, ? S, H>',
            '  conditional-conformance/effect-context-invalid.Handler<P, A, E, ? S> for H: declared conditional-conformance/effect-context-invalid.Handler<P, A, E, ? R> does not exactly match required conditional-conformance/effect-context-invalid.Handler<P, A, E, ? S>',
          ],
          span: responsibleExpression,
          spanStart: mismatchedCallStart,
        },
      ],
    )
  }),
)

/**
 * One wrapper whose decoder conformance holds exactly when its source type has one.
 *
 * The wrapper adds one to whatever its source decodes, so a specialization that reached the wrong
 * witness, or that answered without following the requirement, cannot produce the expected number
 * by accident.
 */
const mappedDecoder = `interface Decoder {
  fn decode(value: &Self) -> i32
}

struct Schema { tag: i32 }

fn schemaDecode(value: &Schema) -> i32 { return value.tag }

impl Decoder for Schema { decode: Schema.schemaDecode }

struct MappedSchema<S> { source: S }

fn mappedDecode<S: Decoder>(value: &MappedSchema<S>) -> i32 {
  return Decoder.decode(&value.source) + 1
}

impl<S: Decoder> Decoder for MappedSchema<S> {
  decode: MappedSchema.mappedDecode
}

fn decodeOf<T: Decoder>(value: T) -> i32 { return Decoder.decode(&value) }`

it.effect('proves a conditional conformance through its declared requirement', () =>
  Effect.gen(function* () {
    const snapshot = yield* analyze(
      'conditional-conformance/mapped',
      `${mappedDecoder}

pub fn main() -> i32 {
  return decodeOf<MappedSchema<Schema>>(MappedSchema<Schema> { source: Schema { tag: 41 } })
}`,
    )
    assert.deepEqual(
      Analysis.diagnostics(snapshot).map(
        (diagnostic) => `${diagnostic.code}: ${diagnostic.message}`,
      ),
      [],
    )
  }),
)

it.effect('records the requirement and canonical head of a conditional conformance', () =>
  Effect.gen(function* () {
    const snapshot = yield* analyze(
      'conditional-conformance/facts',
      `${mappedDecoder}

pub fn main() -> i32 { return 0 }`,
    )
    const index = Analysis.declarationIndex(snapshot)
    const conformances = index.modules.flatMap((module) => module.conformances)
    const conditional = conformances.find((conformance) => conformance.requirements.length === 1)
    assert.isDefined(conditional)
    assert.strictEqual(conditional?.visibility, 'Public')
    assert.strictEqual(conditional?.coherence._tag, 'Coherent')
    assert.strictEqual(conditional?.termination._tag, 'Terminating')
    assert.strictEqual(conditional?.requirements.at(0)?.spelling, 'Decoder')
  }),
)

it.effect('proves one goal per concrete specialization and follows it to the base witness', () =>
  Effect.gen(function* () {
    const snapshot = yield* analyze(
      'conditional-conformance/proof',
      `${mappedDecoder}

pub fn main() -> i32 { return 0 }`,
    )
    const index = Analysis.declarationIndex(snapshot)
    const schema = Type.nominal('conditional-conformance/proof', 'Schema')
    const wrapped = Type.nominal('conditional-conformance/proof', 'MappedSchema', [schema])
    const proof = ConformanceProof.prove(
      index,
      wrapped,
      Type.nominal('conditional-conformance/proof', 'Decoder'),
    )
    assert.strictEqual(proof._tag, 'Proved')
    if (proof._tag !== 'Proved') return
    assert.strictEqual(proof.selection._tag, 'SourceSelection')
    assert.strictEqual(proof.requirements.length, 1)
    assert.strictEqual(proof.typeArguments.length, 1)
    assert.strictEqual(
      Type.genericArgumentKey(proof.typeArguments.at(0) ?? raise('expected one bound argument')),
      Type.key(schema),
    )
  }),
)

it.effect('rejects a specialization whose source type has no witness', () =>
  Effect.gen(function* () {
    const snapshot = yield* analyze(
      'conditional-conformance/missing-base',
      `${mappedDecoder}

struct Loose { weight: i32 }

pub fn main() -> i32 {
  return decodeOf<MappedSchema<Loose>>(MappedSchema<Loose> { source: Loose { weight: 1 } })
}`,
    )
    assert.isAbove(Analysis.diagnostics(snapshot).length, 0)
  }),
)

it.effect('reports the requirement chain that a failed specialization broke', () =>
  Effect.gen(function* () {
    const snapshot = yield* analyze(
      'conditional-conformance/trace',
      `${mappedDecoder}

struct Loose { weight: i32 }

pub fn main() -> i32 {
  return decodeOf<MappedSchema<Loose>>(MappedSchema<Loose> { source: Loose { weight: 1 } })
}`,
    )
    const unproven = Analysis.diagnostics(snapshot).filter(
      (diagnostic) => diagnostic.code === 'SEM0121',
    )
    assert.strictEqual(unproven.length, 1)
    const reported = unproven.at(0)
    assert.deepEqual(reported?.notes, [
      'required by Decoder for conditional-conformance/trace.MappedSchema<conditional-conformance/trace.Loose>',
      '  Decoder for conditional-conformance/trace.Loose: no conformance declares this specialization',
    ])
  }),
)

/**
 * Two wrappers over one base, so a proof chain has depth two and two unrelated specializations of
 * one conditional header exist in one program.
 */
const nestedDecoder = `interface Decoder {
  fn decode(value: &Self) -> i32
}

struct Schema { tag: i32 }
struct Other { code: i32 }

fn schemaDecode(value: &Schema) -> i32 { return value.tag }
fn otherDecode(value: &Other) -> i32 { return value.code }

impl Decoder for Schema { decode: Schema.schemaDecode }
impl Decoder for Other { decode: Other.otherDecode }

struct OptionalSchema<S> { source: S }

fn optionalDecode<S: Decoder>(value: &OptionalSchema<S>) -> i32 {
  return Decoder.decode(&value.source) + 1
}

impl<S: Decoder> Decoder for OptionalSchema<S> {
  decode: OptionalSchema.optionalDecode
}

fn decodeOf<T: Decoder>(value: T) -> i32 { return Decoder.decode(&value) }`

it.effect('discovers one witness instance per concrete specialization of one header', () =>
  Effect.gen(function* () {
    const snapshot = yield* analyze(
      'conditional-conformance/specializations',
      `${nestedDecoder}

pub fn main() -> i32 {
  let outer = decodeOf<OptionalSchema<Schema>>(OptionalSchema<Schema> { source: Schema { tag: 1 } })
  let other = decodeOf<OptionalSchema<Other>>(OptionalSchema<Other> { source: Other { code: 2 } })
  return outer + other
}`,
    )
    assert.deepEqual(
      Analysis.diagnostics(snapshot).map(
        (diagnostic) => `${diagnostic.code}: ${diagnostic.message}`,
      ),
      [],
    )
    const instances = Analysis.instancesOf(snapshot).instances
    const wrappers = instances.filter(
      (instance) => instance.key.declaration.name === 'optionalDecode',
    )
    // One conditional header, two concrete providers, two witness instances — and no third for the
    // unsubstituted form.
    assert.strictEqual(wrappers.length, 2)
    assert.deepEqual(
      wrappers
        .map((instance) => Type.runtimeArgumentKeys(instance.key.typeArguments).join(','))
        .toSorted(),
      [
        Type.runtimeKey(Type.nominal('conditional-conformance/specializations', 'Other')),
        Type.runtimeKey(Type.nominal('conditional-conformance/specializations', 'Schema')),
      ].toSorted(),
    )
    // The base witnesses are reached through the wrapper's own proof, not by being called directly.
    assert.strictEqual(
      instances.filter((instance) => instance.key.declaration.name === 'schemaDecode').length,
      1,
    )
    assert.strictEqual(
      instances.filter((instance) => instance.key.declaration.name === 'otherDecode').length,
      1,
    )
  }),
)

it.effect('discovers proved base witnesses even when the wrapper operation never calls them', () =>
  Effect.gen(function* () {
    const snapshot = yield* analyze(
      'conditional-conformance/unused-requirement',
      `interface Decoder { fn decode(value: &Self) -> i32 }

struct Schema { tag: i32 }
fn schemaDecode(value: &Schema) -> i32 { return value.tag }
impl Decoder for Schema { decode: Schema.schemaDecode }

struct Wrapper<S> { source: S }
fn wrapperDecode<S: Decoder>(value: &Wrapper<S>) -> i32 { return 7 }
impl<S: Decoder> Decoder for Wrapper<S> { decode: Wrapper.wrapperDecode }

fn decodeOf<Self: Decoder>(value: Self) -> i32 { return Decoder.decode(&value) }

pub fn main() -> i32 {
  return decodeOf<Wrapper<Schema>>(Wrapper<Schema> { source: Schema { tag: 41 } })
}`,
    )
    assert.deepEqual(
      Analysis.diagnostics(snapshot).map(
        (diagnostic) => `${diagnostic.code}: ${diagnostic.message}`,
      ),
      [],
    )
    const instances = Analysis.instancesOf(snapshot).instances
    assert.strictEqual(
      instances.filter((instance) => instance.key.declaration.name === 'wrapperDecode').length,
      1,
    )
    assert.strictEqual(
      instances.filter((instance) => instance.key.declaration.name === 'schemaDecode').length,
      1,
    )
  }),
)

it.effect('marks only proof dependencies, never the selected witness root, as descending', () =>
  Effect.gen(function* () {
    const snapshot = yield* analyze(
      'conditional-conformance/root-edge',
      `${mappedDecoder}

pub fn main() -> i32 { return 0 }`,
    )
    const schema = Type.nominal('conditional-conformance/root-edge', 'Schema')
    const wrapper = Type.nominal('conditional-conformance/root-edge', 'MappedSchema', [schema])
    const capability = Type.nominal('conditional-conformance/root-edge', 'Decoder')
    const target = ConformanceProof.interfaceWitnessTarget(
      Analysis.declarationIndex(snapshot),
      wrapper,
      capability,
      'decode',
    )
    assert.isDefined(target)
    assert.notProperty(target ?? {}, 'structurallyDescending')
    assert.strictEqual(target?.implementation.name, 'mappedDecode')
    assert.strictEqual(target?.structuralProvider === undefined, false)
  }),
)

it.effect('lowers a conditional witness to one direct static call and no runtime dispatch', () =>
  Effect.gen(function* () {
    const snapshot = yield* analyze(
      'conditional-conformance/lowering',
      `${nestedDecoder}

pub fn main() -> i32 {
  return decodeOf<OptionalSchema<Schema>>(OptionalSchema<Schema> { source: Schema { tag: 41 } })
}`,
    )
    const mir = Analysis.loweredMir(snapshot)
    const encoded = MirEncoding.encode(mir)
    // Every call names a declaration and its concrete arguments. Nothing selects a witness at run
    // time, so no dictionary, interface tag, or actor-name lookup can appear.
    for (const spelling of ['dictionary', 'vtable', 'witnessTable', 'interfaceTag', 'typeTag'])
      assert.isFalse(encoded.includes(spelling), `${spelling} reached MIR`)
    const witnessCalls = mir.functions.flatMap((fn) =>
      fn.regions.flatMap((region) =>
        region._tag === 'OperationRegion'
          ? region.operations.filter(
              (operation) =>
                operation._tag === 'Call' && operation.target.name === 'optionalDecode',
            )
          : [],
      ),
    )
    assert.strictEqual(witnessCalls.length, 1)
    const witnessCall = witnessCalls.at(0)
    assert.deepEqual(
      witnessCall?._tag === 'Call'
        ? Type.runtimeArgumentKeys(witnessCall.typeArguments)
        : ['no call'],
      [Type.runtimeKey(Type.nominal('conditional-conformance/lowering', 'Schema'))],
    )
  }),
)

it.effect('diagnoses unresolved and conflicting target binders deterministically', () =>
  Effect.gen(function* () {
    const unresolved = yield* analyze(
      'conditional-conformance/unresolved-target-binder',
      `interface Mixer<S, A> { fn mix(left: &S, right: &A) -> i32 }
struct Box<T> { value: T }
fn mix<T, U>(left: &Box<T>, right: &bool) -> i32 { return 0 }
impl Mixer<Box<i32>, bool> for Box<i32> { mix: Box.mix }
pub fn main() -> i32 { return 0 }`,
    )
    const conflicting = yield* analyze(
      'conditional-conformance/conflicting-target-binder',
      `interface Mixer<S, A> { fn mix(left: &S, right: &A) -> i32 }
struct Box<T> { value: T }
fn mix<T>(left: &Box<T>, right: &T) -> i32 { return 0 }
impl Mixer<Box<i32>, bool> for Box<i32> { mix: Box.mix }
pub fn main() -> i32 { return 0 }`,
    )
    const repeated = yield* analyze(
      'conditional-conformance/repeated-conflicting-target-binder',
      `interface Inspect<S> { fn inspect(value: &S) -> i32 }
struct Pair<A, B> { left: A right: B }
fn inspect<T>(value: &Pair<T, T>) -> i32 { return 0 }
impl Inspect<Pair<i32, bool>> for Pair<i32, bool> { inspect: Pair.inspect }
pub fn main() -> i32 { return 0 }`,
    )

    assert.deepEqual(
      Analysis.diagnostics(unresolved).map((diagnostic) => diagnostic.message),
      ['Invalid conformance: Box.mix: cannot infer witness target binder U'],
    )
    assert.deepEqual(
      Analysis.diagnostics(conflicting).map((diagnostic) => diagnostic.message),
      [
        'Invalid conformance: Box.mix: witness target binder T is i32 from receiver left but bool from parameter right',
      ],
    )
    assert.deepEqual(
      Analysis.diagnostics(repeated).map((diagnostic) => diagnostic.message),
      [
        'Invalid conformance: Pair.inspect: witness target binder T is i32 from receiver value (earlier occurrence) but bool from receiver value (later occurrence)',
      ],
    )
  }),
)

it.effect('keeps the conditional witness question unresolved in generic TIR', () =>
  Effect.gen(function* () {
    const snapshot = yield* analyze(
      'conditional-conformance/generic-tir',
      `${nestedDecoder}

pub fn main() -> i32 {
  return decodeOf<OptionalSchema<Schema>>(OptionalSchema<Schema> { source: Schema { tag: 1 } })
}`,
    )
    const tir = Projections.tirOf(snapshot, 'conditional-conformance/generic-tir')
    assert.isDefined(tir)
    if (tir === undefined) return
    const encoded = Tir.encode(tir)
    // The wrapper's body names the interface, the operation, and the bounded parameter it dispatches
    // over — and no witness. Which conformance answers it is decided per specialization, so a
    // generic body that already carried an answer would have to carry one answer for every provider.
    assert.isTrue(
      encoded.includes('interface conditional-conformance/generic-tir.Decoder.decode over S'),
    )
    for (const spelling of ['witness', 'dictionary', 'vtable'])
      assert.isFalse(encoded.includes(spelling), `${spelling} reached generic TIR`)
  }),
)

it.effect('rejects two headers whose bounds are the only difference between them', () =>
  Effect.gen(function* () {
    const snapshot = yield* analyze(
      'conditional-conformance/bound-distinguished',
      `interface Decoder { fn decode(value: &Self) -> i32 }
interface Left { fn decode(value: &Self) -> i32 }
interface Right { fn decode(value: &Self) -> i32 }

struct Wrap<S> { source: S }

fn viaLeft<S: Left>(value: &Wrap<S>) -> i32 { return Left.decode(&value.source) }
fn viaRight<S: Right>(value: &Wrap<S>) -> i32 { return Right.decode(&value.source) }

impl<S: Left> Decoder for Wrap<S> { decode: Wrap.viaLeft }
impl<S: Right> Decoder for Wrap<S> { decode: Wrap.viaRight }

pub fn main() -> i32 { return 0 }`,
    )
    // No type satisfies both bounds today, and that is deliberately not consulted: whether a bound
    // is satisfiable moves as a program grows, so a coherence answer that read it would move too.
    const overlaps = Analysis.diagnostics(snapshot).filter(
      (diagnostic) => diagnostic.code === 'SEM0119',
    )
    assert.strictEqual(overlaps.length, 1)
    assert.include(overlaps.at(0)?.message ?? '', 'may overlap')
  }),
)

it.effect('rejects a witness demanding a bound its header never promises', () =>
  Effect.gen(function* () {
    const snapshot = yield* analyze(
      'conditional-conformance/unpromised',
      `interface Decoder { fn decode(value: &Self) -> i32 }
interface Encoder { fn decode(value: &Self) -> i32 }

struct Wrap<S> { source: S }

fn viaEncoder<S: Encoder>(value: &Wrap<S>) -> i32 { return Encoder.decode(&value.source) }

impl<S: Decoder> Decoder for Wrap<S> { decode: Wrap.viaEncoder }

pub fn main() -> i32 { return 0 }`,
    )
    // The header promises a decoder for the source and the witness asks for an encoder. Admitting
    // it would leave that obligation proved nowhere, and the call would lower to nothing.
    const details = Analysis.diagnostics(snapshot)
      .filter((diagnostic) => diagnostic.code === 'SEM0083')
      .map((diagnostic) => diagnostic.message)
    assert.isTrue(
      details.some((detail) => detail.includes('which Decoder for') && detail.includes('Encoder')),
      details.join(' | '),
    )
  }),
)
it.effect('requires witness type lifetime bounds to follow from the conformance', () =>
  Effect.gen(function* () {
    const source = `interface Decoder<A> { fn decode(value: A) -> i32 }
interface StaticDecoder<A> { fn decode(value: A) -> i32 }
struct Cell<'a> { value: &'a i32 }
fn decodeTyped<T: 'static>(value: T) -> i32 { drop value return 0 }
impl<'a> Decoder<&'a i32> for Cell<'a> { decode: Cell.decodeTyped }
impl<'a: 'static> StaticDecoder<&'a i32> for Cell<'a> { decode: Cell.decodeTyped }
struct Pending<T> { value: T }
service Scheduler {
  effect fn prepare<T: 'static>(child: once Effect<'static; T>) -> Pending<T> ? &mut Scheduler
}
struct Provider {}
effect fn prepare<T: 'static>(self: &mut Provider, child: once Effect<'static; T>) -> Pending<T> {
  let value = run move child
  return Pending { value: move value }
}
impl Scheduler for Provider { prepare: Provider.prepare }
pub fn main() -> i32 { return 0 }`
    const snapshot = yield* Analysis.ofSource(
      'conditional-conformance/type-lifetime-bounds',
      new TextEncoder().encode(source),
    )
    assert.deepEqual(
      Analysis.diagnostics(snapshot).map((diagnostic) => ({
        code: diagnostic.code,
        source: source.slice(diagnostic.span.start, diagnostic.span.end).trim(),
      })),
      [{ code: 'SEM0083', source: 'decode: Cell.decodeTyped' }],
    )
  }),
)

/**
 * One base interface, one base witness for each of two unrelated types, and two wrappers whose
 * decoder conformances hold exactly when their source type has one.
 *
 * The declarations are written in a deliberately unhelpful order: the outer wrapper precedes the
 * inner one, and both precede every base witness they can only be proved through. Nothing here may
 * be answered by reading the file top to bottom, so a canonical fact that survives this ordering
 * survives any ordering. Each wrapper also adds a distinct amount to what its source decodes, so a
 * specialization that reached the wrong witness cannot produce the expected number by accident.
 */
const scrambledDecoders = `interface Decoder {
  fn decode(value: &Self) -> i32
}

struct OptionalSchema<S> { source: S }

fn optionalDecode<S: Decoder>(value: &OptionalSchema<S>) -> i32 {
  return Decoder.decode(&value.source) + 2
}

impl<S: Decoder> Decoder for OptionalSchema<S> {
  decode: OptionalSchema.optionalDecode
}

struct MappedSchema<S> { source: S }

fn mappedDecode<S: Decoder>(value: &MappedSchema<S>) -> i32 {
  return Decoder.decode(&value.source) + 1
}

impl<S: Decoder> Decoder for MappedSchema<S> {
  decode: MappedSchema.mappedDecode
}

struct Loose { weight: i32 }

struct Tally { count: i32 }

fn tallyDecode(value: &Tally) -> i32 { return value.count }

impl Decoder for Tally { decode: Tally.tallyDecode }

struct Schema { tag: i32 }

fn schemaDecode(value: &Schema) -> i32 { return value.tag }

impl Decoder for Schema { decode: Schema.schemaDecode }

fn decodeOf<T: Decoder>(value: T) -> i32 { return Decoder.decode(&value) }

pub fn main() -> i32 {
  let nested = decodeOf<OptionalSchema<MappedSchema<Schema>>>(
    OptionalSchema<MappedSchema<Schema>> {
      source: MappedSchema<Schema> { source: Schema { tag: 41 } }
    }
  )
  let plain = decodeOf<MappedSchema<Tally>>(MappedSchema<Tally> { source: Tally { count: 7 } })
  return nested + plain
}`

it.effect(
  'answers conditional proofs, heads, and instances independently of declaration and asking order',
  () =>
    Effect.gen(function* () {
      const module = 'conditional-conformance/order'
      const qualified = (spelling: string): string => `${module}.${spelling}`
      const nominal = (name: string, arguments_: ReadonlyArray<Type.Type> = []) =>
        Type.nominal(module, name, arguments_)
      const snapshot = yield* analyze(module, scrambledDecoders)
      assert.deepEqual(
        Analysis.diagnostics(snapshot).map((diagnostic) => diagnostic.code),
        [],
      )
      const index = Analysis.declarationIndex(snapshot)
      const decoder = nominal('Decoder')
      const schema = nominal('Schema')
      const tally = nominal('Tally')
      const mappedSchema = nominal('MappedSchema', [schema])
      const nestedSchema = nominal('OptionalSchema', [mappedSchema])
      const optionalLoose = nominal('OptionalSchema', [nominal('Loose')])
      const mappedTally = nominal('MappedSchema', [tally])

      // The deepest goal comes first, so every memo entry a shallower goal could reuse is written by
      // a proof already in flight; the unprovable goal sits between two provable ones; and one base
      // goal is asked before the wrapper that descends into it while the other is asked after.
      const askedProviders = [nestedSchema, schema, optionalLoose, mappedTally, tally, mappedSchema]
      const dependencies = (proof: ConformanceGoal.Proof): ReadonlyArray<string> => {
        const found = new Set<string>()
        const visit = (current: ConformanceGoal.Proof): void => {
          if (current._tag !== 'Proved') return
          for (const requirement of current.requirements) visit(requirement)
          found.add(ConformanceGoal.key(current.goal))
        }
        visit(proof)
        return [...found]
      }
      // Answers are listed in canonical goal-key order: asking order is provenance and must not
      // reach any recorded fact.
      const proveAll = (self: DeclarationIndex.Index, providers: ReadonlyArray<Type.Type>) =>
        providers
          .map((provider) => {
            const goal = ConformanceGoal.make(decoder, provider)
            const proof = ConformanceProof.prove(self, provider, decoder)
            return {
              goal: ConformanceGoal.key(goal),
              encoded: ConformanceGoal.encode(goal),
              proved: proof._tag === 'Proved',
              selection: proof._tag === 'Proved' ? proof.selection._tag : proof.failure._tag,
              typeArguments:
                proof._tag === 'Proved' ? proof.typeArguments.map(Type.genericArgumentKey) : [],
              dependencies: dependencies(proof),
              trace: ConformanceGoal.traceLines(proof),
            }
          })
          .toSorted(
            (left, right) => Number(left.goal > right.goal) - Number(left.goal < right.goal),
          )
      const proofs = proveAll(index, askedProviders)
      // Proof memoization is per index, so a fresh index over a fresh module collection reaches the
      // search with an empty memo. The same goals asked backwards must produce the same answers.
      const unwarmed = DeclarationIndex.make(
        index.stage,
        [...index.modules],
        index.diagnostics,
        index.generatedAggregates,
      )
      assert.deepEqual(proveAll(unwarmed, askedProviders.toReversed()), proofs)

      assert.strictEqual(proofs.length, 6)
      assert.strictEqual(proofs.filter((proof) => proof.proved).length, 5)
      const proofOf = (provider: Type.Type) =>
        proofs.find(
          (proof) => proof.goal === ConformanceGoal.key(ConformanceGoal.make(decoder, provider)),
        ) ?? raise(`expected a proof for ${Type.key(provider)}`)
      const nested = proofOf(nestedSchema)
      assert.strictEqual(nested.proved, true)
      assert.strictEqual(nested.selection, 'SourceSelection')
      assert.strictEqual(nested.typeArguments.length, 1)
      // The depth-2 chain: the mapped wrapper, then the base schema, then the goal itself.
      assert.strictEqual(nested.dependencies.length, 3)
      const mapped = proofOf(mappedSchema)
      const tallied = proofOf(mappedTally)
      assert.strictEqual(mapped.dependencies.length, 2)
      assert.strictEqual(tallied.dependencies.length, 2)
      assert.notStrictEqual(mapped.typeArguments.at(0), tallied.typeArguments.at(0))
      const base = proofOf(schema)
      assert.strictEqual(base.dependencies.length, 1)
      assert.strictEqual(base.typeArguments.length, 0)
      const missing = proofOf(optionalLoose)
      assert.strictEqual(missing.proved, false)
      assert.strictEqual(missing.selection, 'MissingWitness')
      assert.deepEqual(missing.trace, [
        `required by Decoder for ${qualified('OptionalSchema')}<${qualified('Loose')}>`,
        `  Decoder for ${qualified('Loose')}: no conformance declares this specialization`,
      ])

      const conformances =
        index.modules.find((headers) => headers.module === module)?.conformances ??
        raise('expected the root module headers')
      assert.strictEqual(conformances.length, 4)
      const conditional = conformances.filter(
        (conformance) => conformance.requirements.length === 1,
      )
      const headOf = (conformance: (typeof conformances)[number]) =>
        conformance.head ?? raise('expected a declared head')
      assert.deepEqual(
        conditional.map((conformance) => ({
          coherence: conformance.coherence._tag,
          termination: conformance.termination._tag,
          requirement: conformance.requirements.at(0)?.spelling,
          requirementProviders: headOf(conformance).requirements.length,
          parameters: headOf(conformance).parameters.length,
        })),
        Array.from({ length: 2 }, () => ({
          coherence: 'Coherent' as const,
          termination: 'Terminating' as const,
          requirement: 'Decoder',
          requirementProviders: 1,
          parameters: 1,
        })),
      )
      // Both spellings of the normalized binder: identity renumbers it, prose renames it.
      assert.isTrue(
        conditional.every((conformance) =>
          ConformanceHead.key(headOf(conformance)).includes('.impl:0'),
        ),
      )
      assert.deepEqual(
        conditional.map((conformance) => ConformanceHead.encode(headOf(conformance))),
        [
          `${qualified('Decoder')} for ${qualified('OptionalSchema')}<%0>`,
          `${qualified('Decoder')} for ${qualified('MappedSchema')}<%0>`,
        ],
      )

      // Every distinct ordered pair of declared heads, so an asymmetric overlap answer cannot hide
      // behind one arbitrary orientation.
      const heads = conformances.flatMap((conformance) =>
        conformance.head === undefined ? [] : [conformance.head],
      )
      const overlaps = heads.flatMap((left, leftOrdinal) =>
        heads.flatMap((right, rightOrdinal) =>
          leftOrdinal === rightOrdinal ? [] : [ConformanceHead.mayOverlap(left, right)],
        ),
      )
      assert.deepEqual(
        overlaps,
        Array.from({ length: 12 }, () => false),
      )

      // Two concrete specializations of one conditional conformance, and one of the other.
      const instances = Analysis.instancesOf(snapshot).instances.filter(
        (instance) => instance.key.declaration.module === module,
      )
      const mappedInstances = instances.filter(
        (instance) => instance.key.declaration.name === 'mappedDecode',
      )
      assert.strictEqual(mappedInstances.length, 2)
      assert.strictEqual(
        new Set(
          mappedInstances.map((instance) =>
            Type.genericArgumentKey(
              instance.key.typeArguments.at(0) ?? raise('expected an argument'),
            ),
          ),
        ).size,
        2,
      )
      assert.strictEqual(
        instances.filter((instance) => instance.key.declaration.name === 'optionalDecode').length,
        1,
      )
      assert.strictEqual(instances.length, 8)

      // The committed MIR pins witness selection and instance order byte for byte.
      assert.strictEqual(
        MirEncoding.encode(Analysis.loweredMir(snapshot)),
        golden('conditional-conformance.mir.txt'),
      )
    }),
)
