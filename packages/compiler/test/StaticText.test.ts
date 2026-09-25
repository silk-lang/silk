import { records } from './support/records.js'
import { locationAt } from './support/location.js'
import * as Layer from 'effect/Layer'
import * as AnalysisFixture from './support/AnalysisFixture.js'
import * as Schema from 'effect/Schema'
import * as SourceResolver from '../src/SourceResolver.js'
import { createHash } from 'node:crypto'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Tracer from 'effect/Tracer'
import * as Analysis from '../src/Analysis.js'
import * as CompilationProfile from '../src/CompilationProfile.js'
import * as CompilerTrace from '../src/CompilerTrace.js'
import * as PackageConfiguration from '../src/PackageConfiguration.js'
import * as ProfileBootstrap from '../src/ProfileBootstrap.js'
import * as ConfigurationOrigin from '../src/ConfigurationOrigin.js'
import * as ConfigurationValue from '../src/ConfigurationValue.js'
import * as PackageParameter from '../src/PackageParameter.js'
import * as FloatingPoint from '../src/FloatingPoint.js'
import * as DeclarationFacts from '../src/DeclarationFacts.js'
import * as Tir from '../src/Tir.js'
import * as BodyBuilder from '../src/BodyBuilder.js'
import * as Instances from '../src/Instances.js'
import * as Lexer from '../src/Lexer.js'
import * as Lifetime from '../src/Lifetime.js'
import * as LiteralForm from '../src/LiteralForm.js'
import * as OwnershipEncoding from '../src/OwnershipEncoding.js'
import * as Parser from '../src/Parser.js'
import * as Residualization from '../src/Residualization.js'
import * as Semantic from '../src/Semantic.js'
import type * as AuthoredHir from '../src/AuthoredHir.js'
import * as AuthoredIdentity from '../src/AuthoredIdentity.js'
import * as AuthoredLowering from '../src/AuthoredLowering.js'
import * as SemanticContext from '../src/SemanticContext.js'
import * as SourceFile from '../src/SourceFile.js'
import * as Location from '../src/Location.js'
import * as Evaluation from '../src/Evaluation.js'
import * as StaticText from '../src/StaticText.js'
import * as StaticValue from '../src/StaticValue.js'
import * as SyntaxTree from '../src/SyntaxTree.js'
import * as Target from '../src/Target.js'
import * as Type from '../src/Type.js'
import * as Projections from './support/projections.js'
import { unreachable } from './support/raise.js'

const encoder = new TextEncoder()
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

it.effect('traces application execution and cache reuse under one operation identity', () =>
  Effect.gen(function* () {
    const profile = yield* CompilationProfile.normalize({ target: Target.x8664UnknownLinuxGnu.id })
    const spans: Array<Tracer.Span> = []
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options)
        spans.push(span)
        return span
      },
    })
    yield* Effect.gen(function* () {
      const trace = yield* CompilerTrace.capture()
      const evaluation = Evaluation.make<string>(profile, Evaluation.defaultLimits, '', trace)
      const request = application('trace')
      Evaluation.evaluate(evaluation, request, () => Evaluation.complete('fresh'))
      Evaluation.evaluate(evaluation, request, () => Evaluation.complete('unused'))
    }).pipe(Effect.withTracer(tracer))
    const evaluations = spans.filter((span) => span.name === 'Evaluation.evaluate')
    assert.deepEqual(
      evaluations.map((span) => span.attributes.get('evaluation.branch')),
      ['execute', 'reuse'],
    )
    assert.deepEqual(
      evaluations.map((span) => span.attributes.get('evaluation.reuse')),
      [false, true],
    )
  }),
)

const syntaxNodes = (node: SyntaxTree.Node): ReadonlyArray<SyntaxTree.Node> =>
  Object.freeze([
    node,
    ...node.children.flatMap((child) => (SyntaxTree.isNode(child) ? syntaxNodes(child) : [])),
  ])

const completedValue = (outcome: Evaluation.Outcome<StaticValue.Value>): StaticValue.Value => {
  if (outcome._tag === 'Failed')
    throw new Error(`expected completed static value: ${outcome.failure._tag}`)
  return outcome.value
}

const formOf = (value: string): LiteralForm.LiteralForm => {
  const form = LiteralForm.recognize(encoder.encode(value))
  if (form === undefined) throw new Error(`expected a recognized literal form: ${value}`)
  return form
}

const admitted = (value: StaticValue.Admission): StaticValue.Value => {
  if (value._tag === 'Rejected') throw new Error(`expected admitted static value: ${value.detail}`)
  return value.value
}

const staticSpan = locationAt('static/evaluation')

const staticArgument = admitted(
  StaticValue.admit({ _tag: 'IntegerValue', type: 'i32', value: 42n }, { pointerBits: 64 }),
)

const application = (
  name: string,
  value: StaticValue.Value = staticArgument,
): Evaluation.Application =>
  Object.freeze({
    declaration: Object.freeze({
      _tag: 'CanonicalDeclarationId',
      module: 'example.static',
      name,
    }),
    typeArguments: Object.freeze(['i32']),
    evidence: Object.freeze(['Copy<i32>']),
    contractRow: Object.freeze(['result:i32']),
    staticArguments: Object.freeze([value]),
    span: staticSpan,
  })

it.effect('keys and caches complete static applications by target and canonical values', () =>
  Effect.gen(function* () {
    const profilewasm32UnknownUnknown = yield* CompilationProfile.normalize({
      target: Target.wasm32UnknownUnknown.id,
    })
    const profilex8664UnknownLinuxGnu = yield* CompilationProfile.normalize({
      target: Target.x8664UnknownLinuxGnu.id,
    })

    const evaluation = Evaluation.make<string>(profilex8664UnknownLinuxGnu)
    const unrelatedRevision = Evaluation.make<string>(
      profilex8664UnknownLinuxGnu,
      Evaluation.defaultLimits,
      'unrelated-source-revision',
    )
    const request = application('render')
    assert.notStrictEqual(
      Evaluation.applicationKey(evaluation.environment, request),
      Evaluation.applicationKey(unrelatedRevision.environment, request),
    )
    const semanticIdentity = Evaluation.semanticApplicationKey(request)
    const semanticVariants: ReadonlyArray<Evaluation.Application> = [
      { ...request, declaration: { ...request.declaration, name: 'other' } },
      { ...request, typeArguments: ['i64'] },
      { ...request, evidence: ['Clone<i32>'] },
      { ...request, contractRow: ['result:i64'] },
      {
        ...request,
        staticArguments: [
          admitted(
            StaticValue.admit(
              { _tag: 'IntegerValue', type: 'i32', value: 43n },
              { pointerBits: 64 },
            ),
          ),
        ],
      },
    ]
    assert.strictEqual(Evaluation.semanticApplicationKey({ ...request }), semanticIdentity)
    for (const variant of semanticVariants)
      assert.notStrictEqual(Evaluation.semanticApplicationKey(variant), semanticIdentity)
    let calls = 0
    const callback: Evaluation.EvaluationCallback<string> = (context) => {
      calls += 1
      assert.strictEqual(context.step(), undefined)
      assert.strictEqual(context.retain(staticArgument), undefined)
      return Evaluation.complete('residual body')
    }
    const first = Evaluation.evaluate(evaluation, request, callback)
    const second = Evaluation.evaluate(evaluation, request, callback)

    assert.strictEqual(first._tag, 'Complete')
    assert.strictEqual(first.cached, false)
    assert.strictEqual(second._tag, 'Complete')
    assert.strictEqual(second.cached, true)
    assert.strictEqual(first.key, second.key)
    assert.strictEqual(calls, 1)
    assert.strictEqual(evaluation.environment.compilation.target.architecture, 'x86_64')
    assert.deepEqual(Evaluation.budget(evaluation), {
      steps: 1,
      callDepth: 0,
      maximumCallDepth: 1,
      retainedValueBytes: StaticValue.retainedSize(staticArgument),
      residualNodes: 0,
    })
    assert.strictEqual(Evaluation.cacheEntries(evaluation).at(0)?.state._tag, 'Complete')

    const wasm = Evaluation.make<string>(profilewasm32UnknownUnknown)
    const wasmResult = Evaluation.evaluate(wasm, application('render'), callback)
    assert.notStrictEqual(first.key, wasmResult.key)
    assert.strictEqual(wasm.environment.compilation.target.architecture, 'wasm32')
  }),
)

it.effect(
  'admits shared evaluation hits at their recorded cost and isolates residual queries',
  () =>
    Effect.gen(function* () {
      const analyzed = yield* AnalysisFixture.retainingMain(
        'static/shared-evaluation-query',
        encoder.encode('pub fn main() -> i32 { return 42 }'),
      )
      const profile = analyzed.profile ?? unreachable('realized compilation profile')
      const first = Semantic.makeSession(
        'shared-evaluation-one',
        analyzed.index,
        analyzed.resolution,
      )
      const policy = {
        steps: 10,
        callDepth: 4,
        retainedValueBytes: 10_000,
        residualNodes: 10,
      }
      let evaluationCalls = 0
      let residualCalls = 0
      const execute: Evaluation.EvaluationCallback<string> = (context) => {
        evaluationCalls += 1
        context.step(3)
        return Evaluation.complete('evaluated')
      }
      const construct: Evaluation.EvaluationCallback<string> = (context) => {
        residualCalls += 1
        context.growResidual(2)
        return Evaluation.complete('residual')
      }
      const request = application('shared')
      const evaluated = Semantic.evaluate(
        first,
        Evaluation.make<string>(profile, policy),
        request,
        execute,
      )
      const residual = Semantic.constructResidual(
        first,
        Evaluation.make<string>(profile, policy),
        request,
        construct,
      )
      assert.strictEqual(evaluated._tag, 'Complete')
      assert.strictEqual(residual._tag, 'Complete')
      assert.strictEqual(evaluationCalls, 1)
      assert.strictEqual(residualCalls, 1)

      const second = Semantic.makeSession(
        'shared-evaluation-two',
        analyzed.index,
        analyzed.resolution,
        'default',
        Semantic.snapshot(first),
      )
      const admitted = Semantic.evaluate(
        second,
        Evaluation.make<string>(profile, policy),
        request,
        execute,
      )
      assert.strictEqual(admitted._tag, 'Complete')
      assert.strictEqual(admitted.cached, true)
      assert.strictEqual(admitted.budget.steps, 3)
      assert.strictEqual(evaluationCalls, 1)
      assert.deepEqual(Semantic.queryCounters(second), {
        _tag: 'SemanticQueryCounters',
        validations: 1,
        executions: 0,
        reuses: 1,
      })
      const reconstructed = Semantic.constructResidual(
        second,
        Evaluation.make<string>(profile, { ...policy, residualNodes: 11 }),
        request,
        construct,
      )
      assert.strictEqual(reconstructed._tag, 'Complete')
      assert.strictEqual(reconstructed.cached, false)
      assert.strictEqual(residualCalls, 2)

      const changedPolicy = Semantic.makeSession(
        'shared-evaluation-policy',
        analyzed.index,
        analyzed.resolution,
        'default',
        Semantic.snapshot(first),
      )
      const recomputed = Semantic.evaluate(
        changedPolicy,
        Evaluation.make<string>(profile, { ...policy, steps: 11 }),
        request,
        execute,
      )
      assert.strictEqual(recomputed._tag, 'Complete')
      assert.strictEqual(recomputed.cached, false)
      assert.strictEqual(evaluationCalls, 2)
    }),
)

it.effect('detects pending cycles with logical application and selected-arm frames', () =>
  Effect.gen(function* () {
    const profilex8664UnknownLinuxGnu = yield* CompilationProfile.normalize({
      target: Target.x8664UnknownLinuxGnu.id,
    })

    const evaluation = Evaluation.make<string>(profilex8664UnknownLinuxGnu)
    const render = application('render')
    const result = Evaluation.evaluate(evaluation, render, (context) => {
      const selected = context.withTrace(Evaluation.selectedArmFrame('Taken', staticSpan))
      const nested = selected.evaluate(render, () => Evaluation.complete('unreachable'))
      return nested._tag === 'Failed'
        ? Evaluation.failed(nested.failure)
        : Evaluation.complete(nested.value)
    })

    assert.strictEqual(result._tag, 'Failed')
    if (result._tag === 'Failed') {
      assert.strictEqual(result.failure._tag, 'Cycle')
      assert.deepEqual(
        result.failure.trace.map((frame) => frame._tag),
        ['StaticApplicationFrame', 'SelectedStaticArmFrame', 'StaticApplicationFrame'],
      )
    }
    assert.strictEqual(Evaluation.cacheEntries(evaluation).at(0)?.state._tag, 'Failed')
  }),
)

it.effect('reports compile errors, phase violations, and four distinct deterministic limits', () =>
  Effect.gen(function* () {
    const profilex8664UnknownLinuxGnu = yield* CompilationProfile.normalize({
      target: Target.x8664UnknownLinuxGnu.id,
    })

    const trace = Object.freeze([
      Evaluation.selectedArmFrame('Otherwise', staticSpan),
      Evaluation.staticTextFrame(staticSpan, 3),
    ])
    assert.strictEqual(
      Evaluation.compileError('bad template', staticSpan, trace)._tag,
      'CompileError',
    )
    assert.strictEqual(
      Evaluation.phaseViolation('call', 'ordinary function', staticSpan, trace)._tag,
      'PhaseViolation',
    )

    const limited = (
      policy: Evaluation.Limits,
      callback: Evaluation.EvaluationCallback<string>,
    ) => {
      const evaluation = Evaluation.make<string>(profilex8664UnknownLinuxGnu, policy)
      return Evaluation.evaluate(evaluation, application('limited'), callback)
    }
    const base = { steps: 10, callDepth: 10, retainedValueBytes: 10_000, residualNodes: 10 }
    const step = limited({ ...base, steps: 0 }, (context) => {
      context.step()
      return Evaluation.complete('partial')
    })
    const retained = limited({ ...base, retainedValueBytes: 0 }, (context) => {
      context.retain(staticArgument)
      return Evaluation.complete('partial')
    })
    const residual = limited({ ...base, residualNodes: 0 }, (context) => {
      context.growResidual()
      return Evaluation.complete('partial')
    })
    const depth = limited({ ...base, callDepth: 1 }, (context) => {
      const nested = context.evaluate(application('nested'), () => Evaluation.complete('partial'))
      return nested._tag === 'Failed'
        ? Evaluation.failed(nested.failure)
        : Evaluation.complete(nested.value)
    })

    const failureTag = (result: Evaluation.ApplicationResult<string>): string =>
      result._tag === 'Failed' ? result.failure._tag : 'Complete'
    assert.deepEqual([step, depth, retained, residual].map(failureTag), [
      'StepLimit',
      'CallDepthLimit',
      'RetainedValueLimit',
      'ResidualGrowthLimit',
    ])
    assert.deepEqual(
      [step, depth, retained, residual].map((result) => {
        if (result._tag !== 'Failed' || !('limit' in result.failure)) return []
        return [result.failure.limit, result.failure.attempted]
      }),
      [
        [0, 1],
        [1, 2],
        [0, StaticValue.retainedSize(staticArgument)],
        [0, 1],
      ],
    )
  }),
)

it.effect('accounts budgets so neither caching nor ordering changes what is accepted', () =>
  Effect.gen(function* () {
    const profile = yield* CompilationProfile.normalize({ target: Target.x8664UnknownLinuxGnu.id })
    const evaluation = Evaluation.make<string>(profile, {
      steps: 10,
      callDepth: 4,
      retainedValueBytes: 10_000,
      residualNodes: 10,
    })
    const spend =
      (steps: number, nested?: string): Evaluation.EvaluationCallback<string> =>
      (context) => {
        for (let step = 0; step < steps; step += 1) context.step()
        if (nested === undefined) return Evaluation.complete('done')
        const inner = context.evaluate(application(nested), spend(4))
        return inner._tag === 'Failed'
          ? Evaluation.failed(inner.failure)
          : Evaluation.complete('done')
      }
    const entry = (name: string) =>
      Evaluation.cacheEntries(evaluation).find((candidate) => candidate.key.includes(name))?.state

    // `f` leaves its nested `g` too little: `f` is rejected, and nothing is recorded for `g`.
    const f = Evaluation.evaluate(evaluation, application('outerFirst'), spend(9, 'nestedWork'))
    assert.strictEqual(f._tag === 'Failed' ? f.failure._tag : f._tag, 'StepLimit')
    assert.strictEqual(entry('outerFirst')?._tag, 'Failed')
    assert.isUndefined(entry('nestedWork'))

    // Asked again as a root, `g` has the whole allowance and records what it cost.
    const g = Evaluation.evaluate(evaluation, application('nestedWork'), spend(4))
    assert.strictEqual(g._tag, 'Complete')
    const recorded = entry('nestedWork')
    assert.deepEqual(recorded?._tag === 'Complete' ? recorded.cost : undefined, {
      steps: 4,
      callDepth: 1,
      retainedValueBytes: 0,
      residualNodes: 0,
    })

    // A hit is charged like an execution: `h` continues, and `tight` exhausts exactly as it would
    // have by executing `g` itself.
    const h = Evaluation.evaluate(evaluation, application('outerSecond'), spend(5, 'nestedWork'))
    assert.strictEqual(h._tag, 'Complete')
    assert.strictEqual(h.budget.steps, 9)
    const tight = Evaluation.evaluate(evaluation, application('outerThird'), spend(8, 'nestedWork'))
    assert.strictEqual(tight._tag === 'Failed' ? tight.failure._tag : tight._tag, 'StepLimit')
    assert.strictEqual(entry('nestedWork')?._tag, 'Complete')
  }),
)

it('canonicalizes finite static values without observing construction identity', () => {
  const left = admitted(
    StaticValue.admit(
      {
        _tag: 'AggregateValue',
        identity: {
          _tag: 'NominalAggregateIdentity',
          declaration: {
            _tag: 'CanonicalDeclarationId',
            module: 'example.values',
            name: 'Pair',
          },
          typeArguments: ['i32'],
        },
        fields: [
          { ordinal: 1, value: { _tag: 'TextValue', bytes: [...encoder.encode('hé')] } },
          { ordinal: 0, value: { _tag: 'IntegerValue', type: 'i32', value: 42n } },
        ],
      },
      { pointerBits: 64 },
    ),
  )
  const right = admitted(
    StaticValue.admit(
      {
        _tag: 'AggregateValue',
        identity: {
          _tag: 'NominalAggregateIdentity',
          declaration: {
            _tag: 'CanonicalDeclarationId',
            module: 'example.values',
            name: 'Pair',
          },
          typeArguments: ['i32'],
        },
        fields: [
          { ordinal: 0, value: { _tag: 'IntegerValue', type: 'i32', value: 42n } },
          { ordinal: 1, value: { _tag: 'TextValue', bytes: [...encoder.encode('hé')] } },
        ],
      },
      { pointerBits: 64 },
    ),
  )

  assert.strictEqual(StaticValue.encode(left), StaticValue.encode(right))
  assert.strictEqual(StaticValue.key(left), StaticValue.key(right))
  assert.strictEqual(StaticValue.equals(left, right), true)
  assert.strictEqual(
    StaticValue.retainedSize(left),
    encoder.encode(StaticValue.encode(left)).byteLength,
  )
  assert.strictEqual(
    StaticValue.presentation(left),
    'example.values.Pair<i32> { #0: 42i32, #1: "hé" }',
  )
  if (left._tag === 'AggregateValue') {
  }
})

it('retains static text provenance without adding it to canonical identity', () => {
  const bytes = Array.from(encoder.encode('template'))
  const originOrdinal = (value: StaticValue.Value | undefined): number | undefined => {
    const from = value?._tag === 'TextValue' ? value.origin?.at(0)?.from : undefined
    return from?._tag === 'Parameter' ? from.ordinal : undefined
  }
  const left = admitted(
    StaticValue.admit(
      {
        _tag: 'TextValue',
        bytes,
        origin: Evaluation.parameterTextOrigin(0, bytes.length),
      },
      { pointerBits: 64 },
    ),
  )
  const right = admitted(
    StaticValue.admit(
      {
        _tag: 'TextValue',
        bytes,
        origin: Evaluation.parameterTextOrigin(3, bytes.length),
      },
      { pointerBits: 64 },
    ),
  )
  assert.strictEqual(StaticValue.equals(left, right), true)
  assert.strictEqual(StaticValue.key(left), StaticValue.key(right))
  assert.strictEqual(originOrdinal(left), 0)
  assert.strictEqual(originOrdinal(right), 3)

  const aggregate = admitted(
    StaticValue.admit(
      {
        _tag: 'AggregateValue',
        identity: {
          _tag: 'NominalAggregateIdentity',
          declaration: {
            _tag: 'CanonicalDeclarationId',
            module: 'example.values',
            name: 'TemplatePart',
          },
          typeArguments: [],
        },
        fields: [{ ordinal: 0, value: left }],
      },
      { pointerBits: 64 },
    ),
  )
  const nested = aggregate._tag === 'AggregateValue' ? aggregate.fields.at(0)?.value : undefined
  assert.strictEqual(originOrdinal(nested), 0)
})

it('canonicalizes nominal reflection descriptors and heterogeneous field collections', () => {
  const owner = {
    _tag: 'TypeDescriptorValue',
    owner: Type.nominal('example.reflection', 'Person'),
    kind: 'Named',
  }
  const authorization = {
    _tag: 'CanonicalDeclarationId',
    module: 'example.format',
    name: 'render',
  }
  const fields = [
    {
      _tag: 'FieldDescriptorValue',
      owner,
      declarationOrdinal: 1,
      member: { _tag: 'LabeledField', label: 'age' },
      valueType: 'u32',
      authorization,
      provenance: { anchor: Location.anchorOf(locationAt('example/reflection.silk', 1)) },
    },
    {
      _tag: 'FieldDescriptorValue',
      owner,
      declarationOrdinal: 0,
      member: { _tag: 'LabeledField', label: 'name' },
      valueType: Type.string(Lifetime.staticLifetime),
      authorization,
      provenance: { anchor: Location.anchorOf(locationAt('example/reflection.silk')) },
    },
  ]
  const collection = admitted(
    StaticValue.admit({ _tag: 'FieldCollectionValue', owner, fields }, { pointerBits: 64 }),
  )
  const equivalent = admitted(
    StaticValue.admit(
      { _tag: 'FieldCollectionValue', owner, fields: [...fields].reverse() },
      { pointerBits: 64 },
    ),
  )

  assert.strictEqual(collection._tag, 'FieldCollectionValue')
  if (collection._tag !== 'FieldCollectionValue') return
  assert.deepEqual(
    collection.fields.map((field) => field.declarationOrdinal),
    [0, 1],
  )
  assert.strictEqual(StaticValue.equals(collection, equivalent), true)
  assert.strictEqual(
    StaticValue.presentation(collection),
    "fields<example.reflection.Person>[field<example.reflection.Person, string<'static>>(name@0), field<example.reflection.Person, u32>(age@1)]",
  )
  assert.strictEqual(
    StaticValue.retainedSize(collection),
    encoder.encode(StaticValue.encode(collection)).byteLength,
  )

  const distinctOwner = admitted(
    StaticValue.admit(
      {
        _tag: 'TypeDescriptorValue',
        owner: Type.nominal('example.reflection', 'OtherPerson'),
        kind: 'Named',
      },
      { pointerBits: 64 },
    ),
  )
  assert.strictEqual(StaticValue.equals(collection.owner, distinctOwner), false)
  assert.strictEqual(
    StaticValue.admit(
      { _tag: 'FieldCollectionValue', owner: distinctOwner, fields },
      { pointerBits: 64 },
    )._tag,
    'Rejected',
  )
  assert.strictEqual(
    StaticValue.admit(
      {
        _tag: 'TypeDescriptorValue',
        owner: { _tag: 'NominalType' },
        kind: 'Named',
      },
      { pointerBits: 64 },
    )._tag,
    'Rejected',
  )
})

it('builds immutable homogeneous static sequences by complete replacement', () => {
  const empty = StaticValue.emptySequence('i32')
  const first = admitted(
    StaticValue.admit({ _tag: 'IntegerValue', type: 'i32', value: 1n }, { pointerBits: 64 }),
  )
  const second = admitted(
    StaticValue.admit({ _tag: 'IntegerValue', type: 'i32', value: 2n }, { pointerBits: 64 }),
  )
  const one = StaticValue.appendSequence(empty, 'i32', first)
  assert.notStrictEqual(one, undefined)
  if (one === undefined) return
  const two = StaticValue.appendSequence(one, 'i32', second)
  assert.notStrictEqual(two, undefined)
  if (two === undefined) return
  const combined = StaticValue.concatenateSequences(one, one)
  assert.notStrictEqual(combined, undefined)
  if (combined === undefined) return

  assert.strictEqual(StaticValue.sequenceLength(empty), 0)
  assert.strictEqual(StaticValue.sequenceLength(one), 1)
  assert.strictEqual(StaticValue.sequenceLength(two), 2)
  assert.strictEqual(StaticValue.sequenceElement(two, 0), first)
  assert.strictEqual(StaticValue.sequenceElement(two, 1), second)
  assert.strictEqual(StaticValue.sequenceElement(two, -1), undefined)
  assert.strictEqual(StaticValue.sequenceElement(two, 2), undefined)
  assert.deepEqual(combined.elements, [first, first])
  assert.deepEqual(empty.elements, [])
  assert.deepEqual(one.elements, [first])
  assert.strictEqual(StaticValue.appendSequence(one, 'u32', second), undefined)
  assert.strictEqual(
    StaticValue.concatenateSequences(one, StaticValue.emptySequence('u32')),
    undefined,
  )

  const pair = admitted(
    StaticValue.admit(
      {
        _tag: 'AggregateValue',
        identity: {
          _tag: 'NominalAggregateIdentity',
          declaration: {
            _tag: 'CanonicalDeclarationId',
            module: 'example.sequence',
            name: 'Pair',
          },
          typeArguments: ['builtin:i32'],
        },
        fields: [
          { ordinal: 0, value: { _tag: 'IntegerValue', type: 'i32', value: 1n } },
          { ordinal: 1, value: { _tag: 'IntegerValue', type: 'i32', value: 2n } },
        ],
      },
      { pointerBits: 64 },
    ),
  )
  const aggregateSequence = StaticValue.appendSequence(
    StaticValue.emptySequence(Type.nominal('example.sequence', 'Pair', ['i32'])),
    Type.nominal('example.sequence', 'Pair', ['i32']),
    pair,
  )
  assert.notStrictEqual(aggregateSequence, undefined)
  if (aggregateSequence === undefined) return
  assert.strictEqual(StaticValue.sequenceElement(aggregateSequence, 0), pair)
  assert.strictEqual(
    StaticValue.equals(
      aggregateSequence,
      admitted(StaticValue.admit(aggregateSequence, { pointerBits: 64 })),
    ),
    true,
  )

  const readmitted = admitted(StaticValue.admit(two, { pointerBits: 64 }))
  assert.strictEqual(StaticValue.equals(two, readmitted), true)
  assert.strictEqual(StaticValue.presentation(two), 'sequence<i32>[1i32, 2i32]')
  assert.strictEqual(
    StaticValue.retainedSize(two),
    encoder.encode(StaticValue.encode(two)).byteLength,
  )

  const cyclicElements: Array<unknown> = []
  const cyclic = {
    _tag: 'StaticSequenceValue',
    elementType: 'i32',
    elements: cyclicElements,
  }
  cyclicElements.push(cyclic)
  const rejectedCycle = StaticValue.admit(cyclic, { pointerBits: 64 })
  assert.strictEqual(rejectedCycle._tag, 'Rejected')
  if (rejectedCycle._tag === 'Rejected') {
    assert.strictEqual(rejectedCycle.reason, 'CyclicValue')
    assert.deepEqual(rejectedCycle.path, [0])
  }
})

it('normalizes float NaNs and rejects resource-bearing or malformed candidates', () => {
  const firstNaN = admitted(
    StaticValue.admit({ _tag: 'FloatValue', type: 'f32', bits: 0x7f80_0001n }, { pointerBits: 64 }),
  )
  const secondNaN = admitted(
    StaticValue.admit({ _tag: 'FloatValue', type: 'f32', bits: 0x7fff_ffffn }, { pointerBits: 64 }),
  )
  assert.strictEqual(StaticValue.encode(firstNaN), StaticValue.encode(secondNaN))
  assert.deepEqual(
    StaticValue.admit(
      { _tag: 'EffectValue', service: 'filesystem', handle: { ticket: 1 } },
      { pointerBits: 64 },
    ),
    {
      _tag: 'Rejected',
      reason: 'UnsupportedValue',
      path: [],
      detail: 'static evaluation does not admit EffectValue',
    },
  )
  const nestedResource = StaticValue.admit(
    {
      _tag: 'AggregateValue',
      identity: { _tag: 'ArrayAggregateIdentity', element: 'Resource', length: 1 },
      fields: [{ ordinal: 0, value: { _tag: 'BorrowValue', address: 42 } }],
    },
    { pointerBits: 64 },
  )
  assert.strictEqual(nestedResource._tag, 'Rejected')
  if (nestedResource._tag === 'Rejected') {
    assert.strictEqual(nestedResource.reason, 'UnsupportedValue')
    assert.deepEqual(nestedResource.path, [0])
  }
  assert.strictEqual(
    StaticValue.admit({ _tag: 'TextValue', bytes: [0xff] }, { pointerBits: 64 })._tag,
    'Rejected',
  )
  assert.strictEqual(
    StaticValue.admit(
      { _tag: 'IntegerValue', type: 'usize', value: 1n << 32n },
      { pointerBits: 32 },
    )._tag,
    'Rejected',
  )
})

const loweredLiterals = Effect.fn('loweredLiterals')(function* (
  sourceId: string,
  text: string,
): Effect.fn.Return<
  {
    readonly context: SemanticContext.SemanticContext
    readonly literal: (tag: AuthoredHir.Literal['_tag']) => AuthoredHir.Literal
  },
  never
> {
  const file = SourceFile.make(sourceId, encoder.encode(text))
  const parsed = Parser.parse(Lexer.lex(file))
  assert.deepEqual(parsed.lexicalDiagnostics, [])
  assert.deepEqual(parsed.parserDiagnostics, [])
  const lowered = yield* AuthoredLowering.lower(
    parsed,
    AuthoredIdentity.module('fixture', sourceId),
  ).pipe(Effect.orDie)
  const found: Array<AuthoredHir.Literal> = []
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item)
      return
    }
    if (typeof value !== 'object' || value === null) return
    const record = value as Record<string, unknown>
    if (typeof record._tag === 'string' && literalTags.has(record._tag))
      found.push(value as AuthoredHir.Literal)
    for (const nested of Object.values(record)) walk(nested)
  }
  walk(lowered.module.declarations)
  return {
    context: SemanticContext.make(lowered),
    literal: (tag) => {
      const selected = found.find((candidate) => candidate._tag === tag)
      if (selected === undefined) throw new Error(`expected a ${tag}`)
      return selected
    },
  }
})

const literalTags: ReadonlySet<string> = new Set([
  'UnitLiteral',
  'BooleanLiteral',
  'CharacterLiteral',
  'IntegerLiteral',
  'FloatingLiteral',
  'TextLiteral',
  'BytesLiteral',
  'DurationLiteral',
])

it.effect('evaluates authored literals with contextual scalar and target ranges', () =>
  Effect.gen(function* () {
    const profilewasm32UnknownUnknown = yield* CompilationProfile.normalize({
      target: Target.wasm32UnknownUnknown.id,
    })
    const profilex8664UnknownLinuxGnu = yield* CompilationProfile.normalize({
      target: Target.x8664UnknownLinuxGnu.id,
    })

    const { context, literal } = yield* loweredLiterals(
      'static/literals',
      `pub fn main() -> () {
  let unit = ()
  let boolean = true
  let character = 'é'
  let integer = -42
  let floating = -1.5
  let text = "hé"
  return ()
}`,
    )
    const environment = Evaluation.targetEnvironment(profilex8664UnknownLinuxGnu)
    const evaluate = (tag: AuthoredHir.Literal['_tag'], expected: Evaluation.LiteralExpectation) =>
      Evaluation.evaluateLiteral(environment, context, literal(tag), expected)

    assert.strictEqual(completedValue(evaluate('UnitLiteral', 'unit'))._tag, 'UnitValue')
    assert.deepEqual(completedValue(evaluate('BooleanLiteral', 'bool')), {
      _tag: 'BooleanValue',
      value: true,
    })
    assert.deepEqual(completedValue(evaluate('CharacterLiteral', 'char')), {
      _tag: 'CharacterValue',
      value: 0xe9,
    })
    assert.deepEqual(completedValue(evaluate('CharacterLiteral', 'u8')), {
      _tag: 'IntegerValue',
      type: 'u8',
      value: 233n,
    })
    assert.strictEqual(evaluate('CharacterLiteral', 'i8')._tag, 'Failed')
    assert.deepEqual(completedValue(evaluate('IntegerLiteral', 'i8')), {
      _tag: 'IntegerValue',
      type: 'i8',
      value: -42n,
    })
    assert.deepEqual(completedValue(evaluate('FloatingLiteral', 'f32')), {
      _tag: 'FloatValue',
      type: 'f32',
      bits: 0xbfc0_0000n,
    })
    assert.deepEqual(completedValue(evaluate('TextLiteral', 'string')), {
      _tag: 'TextValue',
      bytes: [0x68, 0xc3, 0xa9],
    })

    // The target's pointer width, not the literal's spelling, decides whether a `usize` admits it.
    const wide = yield* loweredLiterals(
      'static/target-range',
      'pub fn main() -> usize { return 4294967296 }',
    )
    assert.strictEqual(
      Evaluation.evaluateLiteral(
        Evaluation.targetEnvironment(profilewasm32UnknownUnknown),
        wide.context,
        wide.literal('IntegerLiteral'),
        'usize',
      )._tag,
      'Failed',
    )
    assert.strictEqual(
      Evaluation.evaluateLiteral(environment, wide.context, wide.literal('IntegerLiteral'), 'usize')
        ._tag,
      'Complete',
    )
  }),
)

it.effect('evaluates checked primitive, enum, text, aggregate, and target-profile operations', () =>
  Effect.gen(function* () {
    const profilex8664UnknownLinuxGnu = yield* CompilationProfile.normalize({
      target: Target.x8664UnknownLinuxGnu.id,
    })

    const environment = Evaluation.targetEnvironment(profilex8664UnknownLinuxGnu)
    const integer = (type: 'i8' | 'i32' | 'usize', value: bigint): StaticValue.Value =>
      admitted(StaticValue.admit({ _tag: 'IntegerValue', type, value }, { pointerBits: 64 }))
    const floating = (type: 'f32' | 'f64', value: number): StaticValue.Value => {
      const encoded = FloatingPoint.fromNumber(value, type === 'f32' ? 32 : 64)
      return admitted(
        StaticValue.admit({ _tag: 'FloatValue', type, bits: encoded.bits }, { pointerBits: 64 }),
      )
    }
    assert.deepEqual(
      completedValue(
        Evaluation.evaluatePrimitive(
          environment,
          'Multiply',
          [integer('i32', 6n), integer('i32', 7n)],
          staticSpan,
        ),
      ),
      { _tag: 'IntegerValue', type: 'i32', value: 42n },
    )
    assert.strictEqual(
      Evaluation.evaluatePrimitive(
        environment,
        'Add',
        [integer('i8', 127n), integer('i8', 1n)],
        staticSpan,
      )._tag,
      'Failed',
    )
    assert.deepEqual(
      completedValue(
        Evaluation.evaluatePrimitive(
          environment,
          'Add',
          [floating('f32', 1.5), floating('f32', 2.25)],
          staticSpan,
        ),
      ),
      { _tag: 'FloatValue', type: 'f32', bits: 0x4070_0000n },
    )
    assert.deepEqual(
      completedValue(
        Evaluation.evaluatePrimitive(environment, 'Not', [StaticValue.boolean(true)], staticSpan),
      ),
      { _tag: 'BooleanValue', value: false },
    )

    const enumType = Object.freeze({
      _tag: 'CanonicalDeclarationId' as const,
      module: 'silk.target',
      name: 'Architecture',
    })
    const native = completedValue(
      Evaluation.constructEnum(environment, enumType, 'X86_64', 'u8', 0n, staticSpan),
    )
    const wasm = completedValue(
      Evaluation.constructEnum(environment, enumType, 'Wasm32', 'u8', 1n, staticSpan),
    )
    if (native._tag !== 'EnumValue' || wasm._tag !== 'EnumValue')
      throw new Error('expected scalar enum values')
    assert.deepEqual(
      completedValue(Evaluation.evaluateEnumEquality('NotEquals', native, wasm, staticSpan)),
      { _tag: 'BooleanValue', value: true },
    )

    const text = admitted(
      StaticValue.admit(
        { _tag: 'TextValue', bytes: Array.from(encoder.encode('hé')) },
        { pointerBits: 64 },
      ),
    )
    if (text._tag !== 'TextValue') throw new Error('expected static text')
    assert.deepEqual(
      completedValue(Evaluation.staticTextByteLength(environment, text, staticSpan)),
      {
        _tag: 'IntegerValue',
        type: 'usize',
        value: 3n,
      },
    )
    assert.deepEqual(
      completedValue(Evaluation.staticTextByteAt(environment, text, 1n, staticSpan)),
      {
        _tag: 'IntegerValue',
        type: 'u8',
        value: 0xc3n,
      },
    )
    assert.deepEqual(
      completedValue(Evaluation.staticTextConcat(environment, text, text, staticSpan)),
      { _tag: 'TextValue', bytes: [0x68, 0xc3, 0xa9, 0x68, 0xc3, 0xa9] },
    )
    assert.deepEqual(
      completedValue(Evaluation.staticTextSlice(environment, text, 1n, 3n, staticSpan)),
      { _tag: 'TextValue', bytes: [0xc3, 0xa9] },
    )
    const splitScalar = Evaluation.staticTextSlice(environment, text, 1n, 2n, staticSpan)
    assert.strictEqual(splitScalar._tag, 'Failed')
    if (splitScalar._tag === 'Failed') {
      assert.strictEqual(splitScalar.failure._tag, 'PhaseViolation')
      assert.strictEqual(splitScalar.failure.trace.at(-1)?._tag, 'StaticTextFrame')
      const diagnostic = Evaluation.diagnostic(splitScalar.failure, environment.target)
      if (diagnostic.reason._tag !== 'StaticPhaseViolation')
        throw new Error('expected a static phase diagnostic')
      assert.deepEqual(diagnostic.reason.trace.at(-1), {
        kind: 'StaticText',
        label: 'static text byte 1',
        arguments: ['byteOffset=1'],
        span: staticSpan,
      })
    }

    const aggregate = completedValue(
      Evaluation.constructAggregate(
        environment,
        { _tag: 'ArrayAggregateIdentity', element: 'i32', length: 2 },
        [
          { ordinal: 0, value: integer('i32', 4n) },
          { ordinal: 1, value: integer('i32', 2n) },
        ],
        staticSpan,
      ),
    )
    assert.strictEqual(aggregate._tag, 'AggregateValue')
    assert.deepEqual(
      completedValue(
        Evaluation.profileFact(environment, 'targetPointerBits', [], staticSpan) ??
          unreachable('expected profile fact'),
      ),
      {
        _tag: 'IntegerValue',
        type: 'u32',
        value: 64n,
      },
    )
  }),
)

it.effect('rejects a runtime static iterable before elaborating its body', () =>
  Effect.gen(function* () {
    const source = `fn invalid(values: [i32; 1]) -> i32 {
  static for value in values {
    compileError("the rejected body must stay untouched")
  }
  return 42
}

pub fn main() -> i32 { return invalid([1]) }`
    const snapshot = yield* AnalysisFixture.retainingMain(
      'static/runtime-iteration',
      encoder.encode(source),
      Target.x8664UnknownLinuxGnu.id,
    )
    assert.deepEqual(
      Analysis.diagnostics(snapshot).map((diagnostic) => diagnostic.code),
      ['SEM0176'],
    )
    assert.isFalse(
      Analysis.diagnostics(snapshot).some((diagnostic) => diagnostic.code === 'SEM0177'),
    )
    const declaration = records(snapshot.results.get('static/runtime-iteration'))?.functions.find(
      (candidate) =>
        candidate.declaration.name._tag === 'Present' &&
        candidate.declaration.name.spelling === 'invalid',
    )?.declaration
    assert.notStrictEqual(declaration, undefined)
    assert.strictEqual(snapshot.target._tag, 'Resolved')
    if (
      declaration === undefined ||
      declaration.canonical._tag !== 'Canonical' ||
      snapshot.target._tag !== 'Resolved'
    )
      return
    const residual = Residualization.residualize(
      Residualization.make(
        snapshot.profile ?? unreachable('expected completed profile'),
        snapshot.results,
        snapshot.resolution,
        snapshot.index,
      ),
      Object.freeze({
        declaration: declaration.canonical.id,
        typeArguments: Object.freeze([]),
        evidence: Object.freeze([]),
        contractRow: Object.freeze([]),
        staticArguments: Object.freeze([]),
      }),
    )
    assert.strictEqual(residual._tag, 'ResidualBody')
    if (residual._tag !== 'ResidualBody') return
    assert.deepEqual(
      residual.results.staticIterations.map((iteration) => ({
        state: iteration.state,
        scopes: iteration.elements.length,
      })),
      [{ state: 'Rejected', scopes: 0 }],
    )
    assert.strictEqual(residual.function.statements.length, 1)
  }),
)

it.effect('rolls back every earlier static iteration when a later element fails', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'static/iteration-rollback',
      encoder.encode(`import silk.static_sequence { StaticSequence }

fn rejected() -> i32 {
  let mut count = 0
  let static values = StaticSequence.append<i32>(
    StaticSequence.append<i32>(StaticSequence.empty<i32>(), 1),
    2,
  )
  static for value in values {
    static if value == 2 { compileError("later iteration failed") }
    count = count + 1
  }
  return count
}

pub fn main() -> i32 { return rejected() }`),
      Target.x8664UnknownLinuxGnu.id,
    )
    assert.deepEqual(
      Analysis.diagnostics(snapshot).map((diagnostic) => diagnostic.code),
      ['SEM0177'],
    )
    const selectedFailure = Analysis.diagnostics(snapshot).at(0)
    assert.strictEqual(selectedFailure?.reason?._tag, 'SelectedCompileError')
    if (selectedFailure?.reason?._tag === 'SelectedCompileError')
      assert.isTrue(
        selectedFailure.reason.trace.some((frame) => frame.label === 'static for element 1'),
      )
    const declaration = records(snapshot.results.get('static/iteration-rollback'))?.functions.find(
      (candidate) =>
        candidate.declaration.name._tag === 'Present' &&
        candidate.declaration.name.spelling === 'rejected',
    )?.declaration
    assert.notStrictEqual(declaration, undefined)
    assert.strictEqual(snapshot.target._tag, 'Resolved')
    if (
      declaration === undefined ||
      declaration.canonical._tag !== 'Canonical' ||
      snapshot.target._tag !== 'Resolved'
    )
      return
    const residual = Residualization.residualize(
      Residualization.make(
        snapshot.profile ?? unreachable('expected completed profile'),
        snapshot.results,
        snapshot.resolution,
        snapshot.index,
      ),
      Object.freeze({
        declaration: declaration.canonical.id,
        typeArguments: Object.freeze([]),
        evidence: Object.freeze([]),
        contractRow: Object.freeze([]),
        staticArguments: Object.freeze([]),
      }),
    )
    assert.strictEqual(residual._tag, 'ResidualBody')
    if (residual._tag !== 'ResidualBody') return
    assert.deepEqual(
      residual.results.staticIterations.map((iteration) => ({
        state: iteration.state,
        scopes: iteration.elements.length,
      })),
      [{ state: 'Rejected', scopes: 0 }],
    )
    assert.isFalse(residual.function.statements.some((statement) => statement._tag === 'Write'))
    assert.isFalse(
      Analysis.instancesOf(snapshot).instances.some(
        (instance) => instance.key.declaration.name === 'rejected',
      ),
    )
  }),
)

it.effect('derives ordered visible descriptors for every concrete aggregate kind', () =>
  Effect.gen(function* () {
    const sourceId = 'static/reflection-descriptors'
    const snapshot = yield* AnalysisFixture.retainingMain(
      sourceId,
      encoder.encode(`import silk.reflect { Reflect, labeledFieldKind }

struct Box<T> { pub value: T hidden: i32 }
tuple Point(u32, u64)

fn inspect<Owner>(value: Owner) -> i32 {
  let static ownerKind = Reflect.typeKind(Reflect.typeOf<Owner>())
  static for field in Reflect.fields<Owner>() {
    static if Reflect.fieldKind(field) == labeledFieldKind {
      let static label = Reflect.fieldLabel(field)
    } else {
      let static ordinal = Reflect.fieldOrdinal(field)
    }
  }
  return 1
}

pub fn main() -> i32 {
  let named = inspect(Box<string> { value: "Julia", hidden: 32 })
  let namedTuple = inspect(Point(20, 22))
  let anonymousTuple = inspect((true, 42))
  let anonymousRecord = inspect(.{ name: "Julia", age: 32 })
  return named + namedTuple + anonymousTuple + anonymousRecord
}`),
      Target.x8664UnknownLinuxGnu.id,
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    assert.strictEqual(snapshot.target._tag, 'Resolved')
    if (snapshot.target._tag !== 'Resolved') return
    const declaration = records(snapshot.results.get(sourceId))?.functions.find(
      (candidate) =>
        candidate.declaration.name._tag === 'Present' &&
        candidate.declaration.name.spelling === 'inspect',
    )?.declaration
    assert.notStrictEqual(declaration, undefined)
    if (declaration === undefined || declaration.canonical._tag !== 'Canonical') return
    const declarationId = declaration.canonical.id
    const coordinator = Residualization.make(
      snapshot.profile ?? unreachable('expected completed profile'),
      snapshot.results,
      snapshot.resolution,
      snapshot.index,
    )
    const descriptors = (owner: Type.Nominal): ReadonlyArray<StaticValue.FieldDescriptorValue> => {
      const residual = Residualization.residualize(
        coordinator,
        Object.freeze({
          declaration: declarationId,
          typeArguments: Object.freeze([owner]),
          evidence: Object.freeze([]),
          contractRow: Object.freeze([]),
          staticArguments: Object.freeze([]),
        }),
      )
      assert.strictEqual(residual._tag, 'ResidualBody')
      if (residual._tag !== 'ResidualBody') return Object.freeze([])
      const iteration = residual.results.staticIterations.at(0)
      assert.strictEqual(iteration?.state, 'Expanded')
      return Object.freeze(
        (iteration?.elements ?? []).flatMap((element) =>
          element?._tag === 'FieldDescriptorValue' ? [element] : [],
        ),
      )
    }
    const encoded = (fields: ReadonlyArray<StaticValue.FieldDescriptorValue>) =>
      fields.map((field) => ({
        ownerKind: field.owner.kind,
        declarationOrdinal: field.declarationOrdinal,
        member:
          field.member._tag === 'LabeledField' ? field.member.label : `#${field.member.ordinal}`,
        valueType: Type.encode(field.valueType),
        authorization: `${field.authorization.module}.${field.authorization.name}`,
        provenance: field.provenance.anchor.owner.module,
      }))

    assert.deepEqual(
      encoded(descriptors(Type.nominal(sourceId, 'Box', [Type.string(Lifetime.staticLifetime)]))),
      [
        {
          ownerKind: 'Named',
          declarationOrdinal: 0,
          member: 'value',
          valueType: "string<'static>",
          authorization: 'silk/reflect.Reflect.fields',
          provenance: sourceId,
        },
      ],
    )
    assert.deepEqual(encoded(descriptors(Type.nominal(sourceId, 'Point'))), [
      {
        ownerKind: 'Positional',
        declarationOrdinal: 0,
        member: '#0',
        valueType: 'u32',
        authorization: 'silk/reflect.Reflect.fields',
        provenance: sourceId,
      },
      {
        ownerKind: 'Positional',
        declarationOrdinal: 1,
        member: '#1',
        valueType: 'u64',
        authorization: 'silk/reflect.Reflect.fields',
        provenance: sourceId,
      },
    ])
    const generated = [...snapshot.index.generatedAggregates.values()]
    const anonymousTuple = generated.find(
      (aggregate) => aggregate.aggregateKind === 'AnonymousPositional',
    )
    const anonymousRecord = generated.find(
      (aggregate) => aggregate.aggregateKind === 'AnonymousNamed',
    )
    assert.strictEqual(anonymousTuple?.canonical._tag, 'Canonical')
    assert.strictEqual(anonymousRecord?.canonical._tag, 'Canonical')
    if (
      anonymousTuple?.canonical._tag !== 'Canonical' ||
      anonymousRecord?.canonical._tag !== 'Canonical'
    )
      return
    assert.deepEqual(
      encoded(
        descriptors(
          Type.nominal(anonymousTuple.canonical.id.module, anonymousTuple.canonical.id.name),
        ),
      ).map(({ ownerKind, declarationOrdinal, member, valueType }) => ({
        ownerKind,
        declarationOrdinal,
        member,
        valueType,
      })),
      [
        {
          ownerKind: 'AnonymousPositional',
          declarationOrdinal: 0,
          member: '#0',
          valueType: 'bool',
        },
        { ownerKind: 'AnonymousPositional', declarationOrdinal: 1, member: '#1', valueType: 'i32' },
      ],
    )
    assert.deepEqual(
      encoded(
        descriptors(
          Type.nominal(anonymousRecord.canonical.id.module, anonymousRecord.canonical.id.name),
        ),
      ).map(({ ownerKind, declarationOrdinal, member, valueType }) => ({
        ownerKind,
        declarationOrdinal,
        member,
        valueType,
      })),
      [
        {
          ownerKind: 'AnonymousNamed',
          declarationOrdinal: 0,
          member: 'name',
          valueType: "string<'static>",
        },
        { ownerKind: 'AnonymousNamed', declarationOrdinal: 1, member: 'age', valueType: 'i32' },
      ],
    )
  }),
)

it.effect('rejects phase-only descriptor types from runtime signatures, bindings, and calls', () =>
  Effect.gen(function* () {
    const sourceId = 'static/phase-only-types'
    const program = `import silk.reflect { Reflect, labeledFieldKind }

tuple Pair(i32)

fn consume<Value>(value: Value) -> () {}
fn invalidParameter(value: Intrinsic.Type<Pair>) -> () {}
fn invalidReturn() -> Intrinsic.Fields<Pair> { return Reflect.fields<Pair>() }

fn exercise() -> () {
  let static descriptor = Reflect.typeOf<Pair>()
  let leaked = descriptor
  consume(descriptor)
}

pub fn main() -> () { exercise() }`
    const snapshot = yield* AnalysisFixture.retainingMain(
      sourceId,
      encoder.encode(program),
      Target.x8664UnknownLinuxGnu.id,
    )
    const violations = Analysis.diagnostics(snapshot).filter(
      (diagnostic) => diagnostic.code === 'SEM0176',
    )
    assert.isTrue(
      violations.some(
        (diagnostic) => diagnostic.span.start === program.indexOf('value: Intrinsic'),
      ),
    )
    assert.isTrue(
      violations.some((diagnostic) => {
        const position = program.indexOf('Intrinsic.Fields')
        return diagnostic.span.start <= position && diagnostic.span.end >= position
      }),
    )
    assert.isTrue(
      violations.some((diagnostic) => {
        const position = program.indexOf('leaked')
        return diagnostic.span.start <= position && diagnostic.span.end >= position
      }),
    )
    const callArgument = program.lastIndexOf('descriptor)')
    assert.isTrue(violations.some((diagnostic) => diagnostic.span.start === callArgument))
  }),
)

it.effect('caches real residual applications and enforces their growth budget', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'static/residual-budget',
      encoder.encode(`fn choose(static selected: bool, value: i32) -> i32 {
  static if selected { return value } else { return 0 }
}

pub fn main() -> i32 { return choose(true, 42) }`),
      Target.x8664UnknownLinuxGnu.id,
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    if (snapshot.target._tag !== 'Resolved') throw new Error('expected selected target')
    const selected = Analysis.instancesOf(snapshot).instances.find(
      (instance) => instance.key.declaration.name === 'choose',
    )
    if (selected === undefined) throw new Error('expected selected residual instance')
    const application: Residualization.ApplicationKey = Object.freeze({
      declaration: selected.key.declaration,
      typeArguments: selected.key.typeArguments,
      evidence: selected.key.evidence,
      contractRow: selected.key.contractRow,
      staticArguments: selected.key.staticArguments,
    })
    const coordinator = Residualization.make(
      snapshot.profile ?? unreachable('expected completed profile'),
      snapshot.results,
      snapshot.resolution,
      snapshot.index,
    )
    const first = Residualization.residualize(coordinator, application)
    const second = Residualization.residualize(coordinator, application)
    assert.strictEqual(first._tag, 'ResidualBody')
    assert.strictEqual(second, first)
    if (first._tag === 'ResidualBody') {
      assert.strictEqual(first.artifact.request._tag, 'Specialize')
      if (first.artifact.request._tag === 'Specialize')
        assert.strictEqual(
          first.artifact.request.application,
          Evaluation.semanticApplicationKey({
            declaration: application.declaration,
            typeArguments: application.typeArguments.map(Type.genericArgumentKey),
            evidence: application.evidence,
            contractRow: application.contractRow,
            staticArguments: application.staticArguments,
            span: staticSpan,
          }),
        )
    }
    assert.deepEqual(Residualization.counters(coordinator), {
      _tag: 'ResidualizationCounters',
      requests: 2,
      sourceReused: 0,
      checked: 1,
      cacheReused: 1,
      rejected: 0,
      failures: 0,
    })
    assert.deepEqual(Residualization.observations(coordinator), [
      {
        application: Residualization.applicationIdentity(coordinator, application),
        declaration: application.declaration,
        reason: 'StaticArguments',
        dependencies: [],
        complete: true,
        counters: Residualization.counters(coordinator),
      },
    ])

    const limited = Residualization.make(
      snapshot.profile ?? unreachable('expected completed profile'),
      snapshot.results,
      snapshot.resolution,
      snapshot.index,
      { ...Evaluation.defaultLimits, residualNodes: 0 },
    )
    const failed = Residualization.residualize(limited, application)
    assert.strictEqual(failed._tag, 'StaticFailure')
    if (failed._tag === 'StaticFailure')
      assert.strictEqual(failed.failure._tag, 'ResidualGrowthLimit')
    assert.deepEqual(Residualization.residualize(limited, application), failed)
    assert.deepEqual(Residualization.counters(limited), {
      _tag: 'ResidualizationCounters',
      requests: 2,
      sourceReused: 0,
      checked: 1,
      cacheReused: 1,
      rejected: 0,
      failures: 2,
    })
  }),
)

it.effect('commits deterministic residual, specialization, ownership, and cleanup encodings', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'static/encoding',
      encoder.encode(`fn choose(static selected: bool, value: i32) -> i32 {
  static if selected {
    let result = value + 1
    return result
  } else {
    return 0
  }
}

pub fn main() -> i32 { return choose(true, 41) }`),
      Target.x8664UnknownLinuxGnu.id,
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    const selected = Analysis.instancesOf(snapshot).instances.find(
      (instance) => instance.key.declaration.name === 'choose',
    )
    if (selected === undefined) throw new Error('expected selected residual instance')
    const tir = Tir.encode(
      Object.freeze({
        _tag: 'TirModule',
        module: 'static/encoding',
        functions: Object.freeze([selected.function]),
      }),
    )
    const ownership = OwnershipEncoding.encode(
      Object.freeze({
        _tag: 'OwnershipFacts',
        module: 'static/encoding',
        functions: Object.freeze([selected.ownership]),
        diagnostics: Object.freeze([]),
      }),
    )
    assert.strictEqual(
      sha256(Instances.keyText(selected.key)),
      'eec2210666e5c049b8352f5c4c07c94c97b0492768591d37ebfd4a044fcb3926',
    )
    assert.strictEqual(
      sha256(tir),
      'ee710839225f50f0ae65868d962918b1f2e12120d23ea6f5c89ae1bb22effd10',
    )
    assert.strictEqual(
      sha256(ownership),
      '7b219d1f31e63fc6e755aa5fb60d4d3dd986b2300df19bf464d5e618c3bffb31',
    )

    const alternateEvidence = Object.freeze({
      ...selected.key,
      evidence: Object.freeze([...selected.key.evidence, 'SelectedEvidence']),
    })
    assert.notStrictEqual(Instances.keyText(alternateEvidence), Instances.keyText(selected.key))
  }),
)

it.effect(
  'reports selected static failures and runtime phase crossings at their source spans',
  () =>
    Effect.gen(function* () {
      const selectedFailure = `fn guarded(static enabled: bool) -> i32 {
  static if enabled { return 42 } else { compileError("guard disabled") }
}

pub fn main() -> i32 { return guarded(false) }`
      const failed = yield* AnalysisFixture.retainingMain(
        'static/selected-failure',
        encoder.encode(selectedFailure),
        Target.x8664UnknownLinuxGnu.id,
      )
      const messageStart = selectedFailure.indexOf('"guard disabled"') + 1
      assert.deepEqual(
        Analysis.diagnostics(failed).map((diagnostic) => ({
          code: diagnostic.code,
          sourceId: diagnostic.span.sourceId,
          start: diagnostic.span.start,
          end: diagnostic.span.end,
        })),
        [
          {
            code: 'SEM0177',
            sourceId: 'static/selected-failure',
            start: messageStart,
            end: messageStart + 'guard disabled'.length,
          },
        ],
      )

      const phaseCrossing = `fn invalid(static enabled: bool, runtime: bool) -> i32 {
  static if runtime { return 1 } else { return 0 }
}

pub fn main() -> i32 { return invalid(true, false) }`
      const crossed = yield* AnalysisFixture.retainingMain(
        'static/phase-crossing',
        encoder.encode(phaseCrossing),
        Target.x8664UnknownLinuxGnu.id,
      )
      const runtimeStart = phaseCrossing.indexOf('runtime {')
      assert.deepEqual(
        Analysis.diagnostics(crossed).map((diagnostic) => ({
          code: diagnostic.code,
          sourceId: diagnostic.span.sourceId,
          start: diagnostic.span.start,
          end: diagnostic.span.end,
        })),
        [
          {
            code: 'SEM0176',
            sourceId: 'static/phase-crossing',
            start: runtimeStart,
            end: runtimeStart + 'runtime'.length,
          },
        ],
      )
    }),
)

it.effect('retains mixed specialization, selected arm, and helper call in static traces', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'static/nested-trace',
      encoder.encode(`static fn reject(value: i32) -> i32 { compileError("nested") }

fn choose(static enabled: bool) -> i32 {
  static if enabled { let static result = reject(1) return result }
  else { return 0 }
}

pub fn main() -> i32 { return choose(true) }`),
      Target.wasm32UnknownUnknown.id,
    )
    const diagnostic = Analysis.diagnostics(snapshot).find(
      (candidate) => candidate.code === 'SEM0177',
    )
    assert.isDefined(diagnostic)
    if (diagnostic?.reason._tag !== 'SelectedCompileError')
      throw new Error('expected selected compile error')
    assert.deepEqual(
      diagnostic.reason.trace.map((frame) => ({ kind: frame.kind, label: frame.label })),
      [
        { kind: 'Call', label: 'static/nested-trace.choose' },
        { kind: 'SelectedArm', label: 'selected static if arm' },
        { kind: 'Call', label: 'static/nested-trace.reject' },
      ],
    )
  }),
)

it.effect('preserves nested static cycle classification through static calls', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'static/nested-cycle',
      encoder.encode(`static fn recurse(value: i32) -> i32 { return recurse(value) }

pub fn main() -> i32 { return recurse(42) }`),
      Target.x8664UnknownLinuxGnu.id,
    )
    assert.strictEqual(snapshot.mir._tag, 'Unavailable')
    const diagnostics = Analysis.diagnostics(snapshot)
    assert.deepEqual(
      diagnostics.map((diagnostic) => diagnostic.code),
      ['SEM0178'],
    )
    const diagnostic = diagnostics.at(0)
    if (diagnostic?.reason._tag !== 'StaticEvaluationCycle')
      throw new Error('expected static evaluation cycle')
    assert.deepEqual(
      diagnostic.reason.trace.map((frame) => frame.label),
      ['static/nested-cycle.main', 'static/nested-cycle.recurse', 'static/nested-cycle.recurse'],
    )
  }),
)

it.effect('preserves static text provenance through nested source wrappers', () =>
  Effect.gen(function* () {
    const nestedTextFailure = `import silk.static_text { StaticText }

static fn inspect() -> bool { return StaticText.byteAt("é", 3) == 0 }

pub fn main() -> i32 {
  static if inspect() { return 42 } else { return 0 }
}`
    const snapshot = yield* AnalysisFixture.retainingMain(
      'static/nested-text-failure',
      encoder.encode(nestedTextFailure),
      Target.x8664UnknownLinuxGnu.id,
    )
    const diagnostics = Analysis.diagnostics(snapshot)
    assert.deepEqual(
      diagnostics.map((diagnostic) => diagnostic.code),
      ['SEM0176'],
    )
    const diagnostic = diagnostics.at(0)
    if (diagnostic?.reason._tag !== 'StaticPhaseViolation')
      throw new Error('expected static phase violation')
    assert.deepEqual(
      diagnostic.reason.trace.map((frame) => frame.kind),
      ['Call', 'Call', 'Call', 'StaticText'],
    )
    const staticTextFrame = diagnostic.reason.trace.at(-1)
    assert.strictEqual(staticTextFrame?.label, 'static text byte 3')
    const literalStart = nestedTextFailure.indexOf('"é"')
    assert.strictEqual(staticTextFrame?.span.sourceId, 'static/nested-text-failure')
    assert.strictEqual(staticTextFrame?.span.start, literalStart)
    assert.strictEqual(staticTextFrame?.span.end, literalStart + encoder.encode('"é"').byteLength)
  }),
)

it.effect('preserves static text provenance through returned text and source composition', () =>
  Effect.gen(function* () {
    const cases = [
      {
        sourceId: 'static/provenance-identity',
        literal: '"é"',
        source: `import silk.static_text { StaticText }

static fn identity(value: string) -> string { return value }

static fn inspect() -> bool {
  let result = identity("é")
  return StaticText.byteAt(result, 3) == 0
}

pub fn main() -> i32 { static if inspect() { return 42 } else { return 0 } }`,
      },
      {
        sourceId: 'static/provenance-slice',
        literal: '"é"',
        source: `import silk.static_text { StaticText }

static fn inspect() -> bool {
  let result = StaticText.slice("é", 0, 2)
  return StaticText.byteAt(result, 3) == 0
}

pub fn main() -> i32 { static if inspect() { return 42 } else { return 0 } }`,
      },
      {
        sourceId: 'static/provenance-ambiguous',
        literal: '"é"',
        source: `import silk.static_text { StaticText }

static fn second<'a, 'b>(first: string<'a>, value: string<'b>) -> string<'b> { return value }

static fn inspect() -> bool {
  let result = second("éx", "é")
  return StaticText.byteAt(result, 3) == 0
}

pub fn main() -> i32 { static if inspect() { return 42 } else { return 0 } }`,
      },
      {
        sourceId: 'static/provenance-cached-ascii',
        literal: '"abc"',
        source: `import silk.static_text { StaticText }

static fn second<'a, 'b>(first: string<'a>, value: string<'b>) -> string<'b> { return value }

static fn inspect() -> bool {
  let a = second("abcx", "abc")
  let ok = StaticText.byteAt(a, 0) == 97
  let b = second("abcx", "abc")
  return ok && StaticText.byteAt(b, 9) == 0
}

pub fn main() -> i32 { static if inspect() { return 42 } else { return 0 } }`,
      },
    ] as const
    for (const testCase of cases) {
      const snapshot = yield* AnalysisFixture.retainingMain(
        testCase.sourceId,
        encoder.encode(testCase.source),
        Target.x8664UnknownLinuxGnu.id,
      )
      const diagnostic = Analysis.diagnostics(snapshot).at(0)
      assert.strictEqual(diagnostic?.code, 'SEM0176')
      if (diagnostic?.reason._tag !== 'StaticPhaseViolation')
        throw new Error('expected static phase violation')
      const frame = diagnostic.reason.trace.at(-1)
      const literalCharacterStart = testCase.source.lastIndexOf(testCase.literal)
      const literalStart = encoder.encode(
        testCase.source.slice(0, literalCharacterStart),
      ).byteLength
      const literalEnd = encoder.encode(
        testCase.source.slice(0, literalCharacterStart + testCase.literal.length),
      ).byteLength
      assert.strictEqual(frame?.kind, 'StaticText')
      assert.strictEqual(frame?.span.sourceId, testCase.sourceId)
      assert.strictEqual(frame?.span.start, literalStart)
      assert.strictEqual(frame?.span.end, literalEnd)
    }
  }),
)

it.effect('anchors compileError to a nested static-text slice of a non-literal parameter', () =>
  Effect.gen(function* () {
    const sourceId = 'static/compile-error-slice'
    const program = `import silk.static_text { StaticText }

static fn inner(value: string) -> string { return StaticText.slice(value, 1, 4) }
static fn outer(value: string) -> string { return StaticText.slice(inner(value), 0, 2) }

fn reject(static template: string) -> i32 { compileError(outer(template)) }

pub fn main() -> i32 { return reject("aéz") }`
    const snapshot = yield* AnalysisFixture.retainingMain(
      sourceId,
      encoder.encode(program),
      Target.x8664UnknownLinuxGnu.id,
    )
    const diagnostic = Analysis.diagnostics(snapshot).at(0)
    assert.strictEqual(diagnostic?.code, 'SEM0177')
    const literalCharacterStart = program.lastIndexOf('"aéz"')
    const prefixBytes = encoder.encode(program.slice(0, literalCharacterStart)).length
    assert.strictEqual(diagnostic?.span.sourceId, sourceId)
    assert.strictEqual(diagnostic?.span.start, prefixBytes + 2)
    assert.strictEqual(diagnostic?.span.end, prefixBytes + 4)
  }),
)

it.effect('reports joined static text at every literal it was copied from', () =>
  Effect.gen(function* () {
    const sourceId = 'static/compile-error-concat'
    const program = `import silk.static_text { StaticText }

static fn label(value: string) -> string { return StaticText.concat("bad: ", value) }

fn reject(static template: string) -> i32 { compileError(label(StaticText.slice(template, 1, 3))) }

pub fn main() -> i32 { return reject("aéz") }`
    const snapshot = yield* AnalysisFixture.retainingMain(
      sourceId,
      encoder.encode(program),
      Target.x8664UnknownLinuxGnu.id,
    )
    const diagnostic = Analysis.diagnostics(snapshot).at(0)
    assert.strictEqual(diagnostic?.code, 'SEM0177')
    const bytesBefore = (text: string): number =>
      encoder.encode(program.slice(0, program.lastIndexOf(text))).length
    // The callee's literal comes first in the value; the caller's argument is the rest of it.
    assert.deepEqual(
      [
        diagnostic?.span,
        ...(diagnostic?.relatedSpans ?? [])
          .filter((related) => related.label === 'continues here')
          .map((related) => related.span),
      ].map((span) => [span?.start, span?.end]),
      [
        [bytesBefore('"bad: "') + 1, bytesBefore('"bad: "') + 6],
        [bytesBefore('"aéz"') + 2, bytesBefore('"aéz"') + 4],
      ],
    )
  }),
)

it.effect('reports a shared residual failure at every call that selects it', () =>
  Effect.gen(function* () {
    const sourceId = 'static/compile-error-shared-specialization'
    const program = `import silk.static_text { StaticText }

fn reject(static template: string) -> i32 { compileError(StaticText.slice(template, 1, 3)) }

fn relay(static forwarded: string) -> i32 { return reject(forwarded) }

pub fn main() -> i32 {
  let first = reject("aéz")
  let second = relay("bèy")
  return reject("aéz")
}`
    const snapshot = yield* AnalysisFixture.retainingMain(
      sourceId,
      encoder.encode(program),
      Target.x8664UnknownLinuxGnu.id,
    )
    // One specialization per static value, whoever asks for it and wherever they wrote it.
    assert.deepEqual(
      Analysis.instancesOf(snapshot)
        .unavailableOwnership.map((candidate) => candidate.key.declaration.name)
        .sort(),
      ['reject', 'reject'],
    )
    // The failure is one fact about the application; each selecting call is its own mistake, so
    // each reports at what it wrote, also through a caller that only forwards it.
    const bytesBefore = (index: number): number => encoder.encode(program.slice(0, index)).length
    const literals = [
      program.indexOf('"aéz"'),
      program.indexOf('"bèy"'),
      program.lastIndexOf('"aéz"'),
    ].map(bytesBefore)
    assert.deepEqual(
      Analysis.diagnostics(snapshot)
        .filter((diagnostic) => diagnostic.code === 'SEM0177')
        .map((diagnostic) => [diagnostic.span.start, diagnostic.span.end]),
      literals.map((start) => [start + 2, start + 4]),
    )
  }),
)

it.effect('retains ownership evidence for an unavailable selected residual specialization', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'static/unavailable-residual',
      encoder.encode(`fn choose(static selected: bool) -> i32 {
  static if selected { return missing() } else { return 0 }
}

pub fn main() -> i32 { return choose(true) }`),
      Target.x8664UnknownLinuxGnu.id,
    )
    assert.deepEqual(
      Analysis.diagnostics(snapshot).map((diagnostic) => diagnostic.code),
      ['SEM0004'],
    )
    const discovery = Analysis.instancesOf(snapshot)
    assert.deepEqual(
      discovery.instances.map((instance) => instance.key.declaration.name),
      ['main'],
    )
    assert.strictEqual(discovery.unavailableOwnership.length, 1)
    const unavailable = discovery.unavailableOwnership.at(0)
    assert.strictEqual(unavailable?.key.declaration.name, 'choose')
    assert.deepEqual(unavailable?.key.staticArguments, [{ _tag: 'BooleanValue', value: true }])
    assert.strictEqual(unavailable?.ownership.verdict._tag, 'Unavailable')
    if (unavailable?.ownership.verdict._tag === 'Unavailable')
      assert.isDefined(unavailable.ownership.verdict.cause)
  }),
)

it('lexes and parses literal spelling losslessly', () => {
  const file = SourceFile.make('static/lossless', encoder.encode('"hé\\n" b"life\\x0a"'))
  const lexical = Lexer.lex(file)
  assert.deepEqual(
    lexical.tokens.map((token) => token.kind),
    ['TextLiteral', 'Whitespace', 'ByteStringLiteral', 'EndOfFile'],
  )
  assert.deepEqual(lexical.diagnostics, [])

  const parsed = Parser.parse(
    Lexer.lex(
      SourceFile.make(
        'static/parse',
        encoder.encode('pub fn main() -> i32 { let value = "hé\\n" return value.length }'),
      ),
    ),
  )
  const literals = syntaxNodes(parsed.root).filter(
    (node) => node.kind === 'StaticTextLiteralExpression',
  )
  assert.strictEqual(literals.length, 1)
  assert.deepEqual(parsed.lexicalDiagnostics, [])
  assert.deepEqual(parsed.parserDiagnostics, [])
})

it('decodes UTF-8 and exact bytes atomically', () => {
  const textSpelling = '"hé\\n\\u{1f642}"'
  const text = StaticText.decode(Array.from(encoder.encode(textSpelling)), formOf(textSpelling))
  assert.strictEqual(text._tag, 'Decoded')
  if (text._tag === 'Decoded') {
    assert.deepEqual(text.data.bytes, Array.from(encoder.encode('hé\n🙂')))
    assert.deepEqual(text.data.sourceRanges, [
      { start: 1, end: 2 },
      { start: 2, end: 3 },
      { start: 3, end: 4 },
      { start: 4, end: 6 },
      { start: 6, end: 15 },
      { start: 6, end: 15 },
      { start: 6, end: 15 },
      { start: 6, end: 15 },
    ])
    assert.deepEqual(text.data.contentRange, { start: 1, end: 15 })
    assert.strictEqual(text.data.utf8, true)
  }
  const byteSpelling = 'b"\\x00\\xff"'
  assert.deepEqual(
    StaticText.decode(Array.from(encoder.encode(byteSpelling)), formOf(byteSpelling)),
    {
      _tag: 'Decoded',
      data: {
        _tag: 'StaticData',
        id: 'bytes:00ff',
        kind: 'Bytes',
        bytes: [0, 255],
        sourceRanges: [
          { start: 2, end: 6 },
          { start: 6, end: 10 },
        ],
        contentRange: { start: 2, end: 10 },
        utf8: false,
      },
    },
  )
  assert.strictEqual(
    StaticText.decode(Array.from(encoder.encode('b"\\u{100}"')), formOf('b"\\u{100}"'))._tag,
    'Invalid',
  )
  assert.strictEqual(
    StaticText.decode(Array.from(encoder.encode('"\\q"')), formOf('"\\q"'))._tag,
    'Invalid',
  )
})

it('composes decoded static-text ranges through source and parameter slices', () => {
  const spelling = '"hé\\n\\u{1f642}"'
  const decoded = StaticText.decode(Array.from(encoder.encode(spelling)), formOf(spelling))
  assert.strictEqual(decoded._tag, 'Decoded')
  if (decoded._tag !== 'Decoded') return
  // Provenance holds value offsets only; the literal's presentation maps them to its spelling.
  const text = `pub fn f() -> i32 { return g(${spelling}) }`
  const lowered = Effect.runSync(
    AuthoredLowering.lower(
      Parser.parse(Lexer.lex(SourceFile.make('static/origin', encoder.encode(text)))),
      AuthoredIdentity.module('memory', 'static/origin'),
    ),
  )
  const literal =
    lowered.presentation.entries.find((entry) => entry.spelling === spelling)?.anchor ??
    unreachable('expected the literal to be presented')
  const registry = SemanticContext.registryOf(SemanticContext.make(lowered))
  const written = (origin: Evaluation.TextOrigin): string => {
    const location =
      Evaluation.textOriginLocation(origin, literal) ?? unreachable('expected a location')
    const span = Location.resolve(location, registry).span
    return new TextDecoder().decode(encoder.encode(text).slice(span.start, span.end))
  }
  const origin = Evaluation.sourceTextOrigin(literal, decoded.data.bytes.length)
  const newline = Evaluation.sliceTextOrigin(origin, 3, 4)
  if (newline === undefined) throw new Error('expected newline origin')
  assert.strictEqual(written(newline), '\\n')
  const emoji = Evaluation.sliceTextOrigin(origin, 4, 8)
  if (emoji === undefined) throw new Error('expected emoji origin')
  assert.strictEqual(written(emoji), '\\u{1f642}')
  assert.deepEqual(
    Evaluation.sliceTextOrigin(Evaluation.parameterTextOrigin(0, decoded.data.bytes.length), 3, 8),
    [
      {
        value: { start: 0, end: 5 },
        from: { _tag: 'Parameter', ordinal: 0, range: { start: 3, end: 8 } },
      },
    ],
  )
})

it('decodes multiline content exactly without dedenting and normalizes only physical CRLF', () => {
  const spelling = '"""\r\n  first  \r\n second\n"""'
  const decoded = StaticText.decode(Array.from(encoder.encode(spelling)), formOf(spelling))
  assert.strictEqual(decoded._tag, 'Decoded')
  if (decoded._tag === 'Decoded') {
    assert.deepEqual(decoded.data.bytes, Array.from(encoder.encode('\n  first  \n second\n')))
  }

  const explicit = 'b"""\\r\\n"""'
  const explicitDecoded = StaticText.decode(Array.from(encoder.encode(explicit)), formOf(explicit))
  assert.strictEqual(explicitDecoded._tag, 'Decoded')
  if (explicitDecoded._tag === 'Decoded') assert.deepEqual(explicitDecoded.data.bytes, [13, 10])

  const continuation = '"""before\\\nafter"""'
  assert.strictEqual(
    StaticText.decode(Array.from(encoder.encode(continuation)), formOf(continuation))._tag,
    'Invalid',
  )
})

it('parses all four literal forms as pipeline operands', () => {
  const parsed = Parser.parse(
    Lexer.lex(
      SourceFile.make(
        'static/pipelines',
        encoder.encode(`import silk.string { String }
pub fn main() -> i32 {
  let a = "abc" |> String.uppercase
  let b = b"abc" |> String.uppercase
  let c = """abc""" |> String.uppercase
  let d = b"""abc""" |> String.uppercase
  return 0
}`),
      ),
    ),
  )
  const nodes = (node: SyntaxTree.Node): ReadonlyArray<SyntaxTree.Node> =>
    Object.freeze([
      node,
      ...node.children.flatMap((child) => (SyntaxTree.isNode(child) ? nodes(child) : [])),
    ])
  assert.strictEqual(
    nodes(parsed.root).filter((node) => node.kind === 'PipelineExpression').length,
    4,
  )
  assert.deepEqual(parsed.lexicalDiagnostics, [])
  assert.deepEqual(parsed.parserDiagnostics, [])
})

it.effect('recovers malformed escapes before the following declaration', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'static/recovery',
      encoder.encode(`fn broken() -> i32 { let bad = "\\q" return 0 }
pub fn main() -> i32 { return 42 }`),
    )
    assert.deepEqual(
      Analysis.diagnostics(snapshot).map((diagnostic) => diagnostic.code),
      ['SEM0085'],
    )
    assert.strictEqual(Projections.tirOf(snapshot, 'static/recovery')?.functions.length, 2)
  }),
)

it.effect('keeps lexical literal sentinels out of parser and semantic diagnostic cascades', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'static/lexical-sentinel',
      encoder.encode(`pub fn main() -> i32 {
  let bad = future"value"
  return 42
}`),
    )
    assert.deepEqual(
      Analysis.diagnostics(snapshot).map((diagnostic) => diagnostic.code),
      ['LEX0002'],
    )
    assert.strictEqual(Projections.tirOf(snapshot, 'static/lexical-sentinel')?.functions.length, 1)
  }),
)

it.effect('restores projected static ownership without replacing its enclosing aggregate', () =>
  Effect.gen(function* () {
    const profilewasm32UnknownUnknown = yield* CompilationProfile.normalize({
      target: Target.wasm32UnknownUnknown.id,
    })

    const source = `struct Token { value: i32 }
struct Pair { left: Token right: Token }
struct State { pair: Pair values: [Token; 2] }
static fn computed() -> i32 {
  let mut state = State {
    pair: Pair { left: Token { value: 1 }, right: Token { value: 2 } },
    values: [Token { value: 3 }, Token { value: 4 }],
  }
  let extracted = move state.pair.left
  state.pair.left = Token { value: extracted.value + 1 }
  let element = move state.values[0]
  state.values[0] = Token { value: element.value + 1 }
  let before = state.pair.left.value + state.pair.right.value + state.values[0].value + state.values[1].value
  state.pair = Pair { left: Token { value: 5 }, right: Token { value: 6 } }
  return before + state.pair.left.value + state.pair.right.value
}`
    const snapshot = yield* Analysis.ofSource(
      'static/projected-restoration',
      encoder.encode(source),
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    const computed =
      records(Analysis.rootAnalysis(snapshot)).functions.at(0) ?? unreachable('static body')
    const result = completedValue(
      Evaluation.evaluateStatements(
        BodyBuilder.staticLowering(
          SemanticContext.make(Analysis.rootAnalysis(snapshot).authored),
        ).statements(computed.statements),
        {
          environment: Evaluation.targetEnvironment(profilewasm32UnknownUnknown),
          lookup: (id) => DeclarationFacts.byCanonical(snapshot.index, id),
          values: new Map(),
          valueSpans: new Map(),
          valueOrigins: new Map(),
          expressionSpans: new Map(),
          expressionOrigins: new Map(),
          trace: [],
          reflect: () => unreachable('fixture does not reflect'),
          call: () => unreachable('fixture does not call another function'),
        },
      ),
    )
    assert.strictEqual(result._tag, 'IntegerValue')
    if (result._tag === 'IntegerValue') assert.strictEqual(result.value, 23n)
  }),
)

it.effect('evaluates statement arms and carries transfers through eager static expressions', () =>
  Effect.gen(function* () {
    const source = `struct Payload { value: i32 }
struct Pair { left: i32 right: i32 }
enum Flag { Ready, Waiting }
union Choice { Some { value: i32 }, None }
static fn identity(value: i32) -> i32 { return value }
static fn early() -> i32 {
  return identity(match 0 { _ => { return 17 } }) + (1 / 0)
}
static fn aggregate() -> i32 {
  let pair = Pair { left: match 0 { _ => { return 19 } }, right: 1 / 0 }
  return pair.right
}
static fn canonical() -> i32 {
  let choice = Choice.Some { value: 7 }
  let selected = match choice {
    Choice.Some { value } => value
    Choice.None => 0
  }
  return match Flag.Ready { Flag.Waiting => 1 / 0 Flag.Ready => selected }
}
static fn guarded() -> i32 {
  return match (Payload { value: 3 }) {
    Payload { value } if false => 1 / 0
    Payload { value } if match value { _ => { return value } } => 1 / 0
    _ => 1 / 0
  }
}
static fn loops() -> i32 {
  let mut count = 0
  let mut total = 0
  while count < 4 {
    count = count + 1
    match count {
      _ if count == 1 => { continue }
      _ if count == 4 => { break }
      _ => { while true { break } total = total + count }
    }
  }
  match total { _ => { drop 42 } }
  return total
}
pub fn main() -> i32 {
  static if early() == 17 && aggregate() == 19 && canonical() == 7 && guarded() == 3 && loops() == 5 {
    return 42
  } else { compileError("incorrect statement-arm evaluation") }
}`
    const snapshot = yield* AnalysisFixture.retainingMain(
      'static/match-arm-transfers',
      encoder.encode(source),
      Target.x8664UnknownLinuxGnu.id,
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    const main = Analysis.instancesOf(snapshot).instances.find(
      (instance) => instance.key.declaration.name === 'main',
    )
    assert.isDefined(main)
  }),
)

it.effect(
  'projects source-owned records, arrays, enums and optional shapes into typed bindings',
  () =>
    Effect.gen(function* () {
      const source = `pub enum Mode { Fast, Careful }
pub union Presence<T> { Empty, Full { item: T } }
pub struct Settings {
  pub count: u64
  pub enabled: bool
  pub label: string<'static>
  pub modes: [Mode; 2]
  pub extra: Presence<i32>
}
pub param settings: Settings
pub param pointerWidth: usize
pub fn main() -> i32 { return 0 }`
      const snapshot = yield* Analysis.ofSource('config', encoder.encode(source))
      assert.deepEqual(Analysis.diagnostics(snapshot), [])
      const parameters =
        snapshot.index.modules.find((module) => module.module === 'config')?.constants ?? []
      const settings =
        parameters.find(
          (parameter) =>
            parameter.name._tag === 'Present' && parameter.name.spelling === 'settings',
        ) ?? unreachable('expected settings')
      const pointerWidth =
        parameters.find(
          (parameter) =>
            parameter.name._tag === 'Present' && parameter.name.spelling === 'pointerWidth',
        ) ?? unreachable('expected pointerWidth')
      if (
        settings.declaredType._tag !== 'Resolved' ||
        pointerWidth.declaredType._tag !== 'Resolved'
      )
        return unreachable('expected concrete schemas')
      const origin = ConfigurationOrigin.literal('typed binding')
      const context: PackageParameter.Context = {
        index: snapshot.index,
        target: Target.x8664UnknownLinuxGnu,
        packages: new Map(
          snapshot.index.modules.map((module) => [
            module.module,
            { package: 'demo@1.0.0', module: module.module },
          ]),
        ),
      }
      const schema = yield* PackageParameter.describe(context, settings.declaredType.type, origin)
      const input = {
        kind: 'record',
        fields: {
          count: { kind: 'integer', value: '18446744073709551615' },
          enabled: { kind: 'boolean', value: true },
          label: { kind: 'string', value: 'configured' },
          modes: {
            kind: 'array',
            values: [
              { kind: 'enum', type: 'demo@1.0.0/config/Mode', member: 'Careful' },
              { kind: 'enum', type: 'demo@1.0.0/config/Mode', member: 'Fast' },
            ],
          },
          extra: { kind: 'some', value: { kind: 'integer', value: '-42' } },
        },
      }
      const bound = yield* PackageParameter.bind(schema, input, origin, context.target)
      const roundtrip = yield* PackageParameter.unbind(schema, bound, origin, context.target)
      const canonical = yield* ConfigurationValue.decode(input, origin)
      assert.strictEqual(ConfigurationValue.encode(roundtrip), ConfigurationValue.encode(canonical))
      for (const extra of [
        { kind: 'none' },
        { kind: 'some', value: { kind: 'integer', value: '2147483648' } },
      ]) {
        const candidate = { ...input, fields: { ...input.fields, extra } }
        if (extra.kind === 'none') {
          const value = yield* PackageParameter.bind(schema, candidate, origin, context.target)
          assert.deepEqual(
            yield* PackageParameter.unbind(schema, value, origin, context.target),
            yield* ConfigurationValue.decode(candidate, origin),
          )
        } else
          assert.strictEqual(
            (yield* Effect.flip(PackageParameter.bind(schema, candidate, origin, context.target)))
              .code,
            'InvalidType',
          )
      }
      const wrongEnum = {
        ...input,
        fields: {
          ...input.fields,
          modes: {
            kind: 'array',
            values: [
              { kind: 'enum', type: 'other@1.0.0/config/Mode', member: 'Fast' },
              { kind: 'enum', type: 'demo@1.0.0/config/Mode', member: 'Fast' },
            ],
          },
        },
      }
      assert.strictEqual(
        (yield* Effect.flip(PackageParameter.bind(schema, wrongEnum, origin, context.target))).code,
        'InvalidType',
      )
      const integerSchema = yield* PackageParameter.describe(
        context,
        pointerWidth.declaredType.type,
        origin,
      )
      assert.strictEqual(
        (yield* Effect.flip(
          PackageParameter.bind(
            integerSchema,
            { kind: 'integer', value: '4294967296' },
            origin,
            Target.wasm32UnknownUnknown,
          ),
        )).code,
        'InvalidType',
      )
    }),
)

const bootstrapSource = (
  snapshot: Analysis.SingleRootFrontendSnapshot,
): ProfileBootstrap.Source => ({
  index: snapshot.index,
  contexts: snapshot.resolution.contexts,
  results: snapshot.results,
  resolution: snapshot.resolution,
  modules: snapshot.closure.modules.map((module) => ({
    canonical: module.name,
    package: 'demo@1.0.0',
    module: module.name,
    bytes: module.syntax.source.bytes,
  })),
})

it.effect('bootstraps final-value defaults and predicates with explicit binding precedence', () =>
  Effect.gen(function* () {
    const source = `pub param enabled: bool = false
pub param count: i32 = choose() where count > 0
param hidden: i32 = 9
static fn choose() -> i32 { if enabled { return 42 } else { return 7 } }
pub fn main() -> i32 { return 0 }`
    const snapshot = yield* Analysis.ofSource('config', encoder.encode(source))
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    const graph = bootstrapSource(snapshot)
    const initial = yield* CompilationProfile.normalize({ target: Target.x8664UnknownLinuxGnu.id })
    const origin = ConfigurationOrigin.literal('project input')
    const binding: PackageConfiguration.Binding = {
      package: 'demo@1.0.0',
      module: 'config',
      parameter: 'enabled',
      tier: 'project',
      value: { kind: 'boolean', value: true },
      origin,
    }
    const invalidTarget = yield* Effect.flip(
      ProfileBootstrap.complete(
        { ...initial, target: { ...initial.target, pointerAlignment: 4 } },
        graph,
      ),
    )
    assert.strictEqual(invalidTarget.operation, 'ProfileBootstrap.complete')
    const defaulted = yield* ProfileBootstrap.complete(initial, graph)
    const enabled = yield* ProfileBootstrap.complete(initial, graph, [binding])
    const count = (profile: CompilationProfile.CompilationProfile) =>
      CompilationProfile.parameter(profile, {
        package: 'demo@1.0.0',
        module: 'config',
        parameter: 'count',
      })?.value
    assert.deepEqual(count(defaulted.profile), { kind: 'integer', value: '7' })
    assert.deepEqual(count(enabled.profile), { kind: 'integer', value: '42' })
    assert.notStrictEqual(defaulted.profile.identity, enabled.profile.identity)
    const artifact: PackageConfiguration.Binding = {
      ...binding,
      tier: 'artifact',
      value: { kind: 'boolean', value: false },
    }
    assert.strictEqual(
      (yield* ProfileBootstrap.complete(initial, graph, [artifact, binding])).profile.identity,
      defaulted.profile.identity,
    )
    const conflict = yield* Effect.flip(
      ProfileBootstrap.complete(initial, graph, [binding, { ...artifact, tier: 'workspace' }]),
    )
    assert.strictEqual(conflict.code, 'ConflictingBindings')
    assert.strictEqual(conflict.origins.length, 2)
    const rejected = yield* Effect.flip(
      ProfileBootstrap.complete(initial, graph, [
        { ...binding, parameter: 'count', value: { kind: 'integer', value: '-1' } },
      ]),
    )
    assert.strictEqual(rejected.code, 'ValidationFailed')
    for (const [parameter, code] of [
      ['hidden', 'PrivateParameter'],
      ['typo', 'UnknownParameter'],
    ] as const)
      assert.strictEqual(
        (yield* Effect.flip(ProfileBootstrap.complete(initial, graph, [{ ...binding, parameter }])))
          .code,
        code,
      )
    const secret = yield* Effect.flip(
      ProfileBootstrap.complete(initial, graph, [
        {
          ...binding,
          value: 'DO_NOT_ECHO_123',
          origin: { source: 'secret store', provenance: 'secret' },
        },
      ]),
    )
    assert.strictEqual(secret.code, 'ForbiddenProvenance')
    assert.notInclude(
      yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(secret),
      'DO_NOT_ECHO_123',
    )
    const translated = {
      ...binding,
      origin: {
        source: 'public capability',
        provenance: 'translated-public' as const,
        translator: 'capabilities-v1',
      },
    }
    assert.strictEqual(
      (yield* ProfileBootstrap.complete(initial, graph, [translated])).profile.identity,
      enabled.profile.identity,
    )
    assert.strictEqual(
      (yield* Effect.flip(
        ProfileBootstrap.complete(initial, {
          ...graph,
          modules: [
            ...graph.modules,
            {
              canonical: 'alias',
              package: 'demo@1.0.0',
              module: 'config',
              bytes: Uint8Array.of(1),
            },
          ],
        }),
      )).code,
      'PackageIdentityConflict',
    )
  }),
)

it.effect('reports demanded default cycles while explicit values break the cycle', () =>
  Effect.gen(function* () {
    const snapshot = yield* Analysis.ofSource(
      'cycle',
      encoder.encode(`pub param first: i32 = helper()
pub param second: i32 = first
static fn helper() -> i32 { return second }
static fn unused() -> i32 { return unused() }
pub fn main() -> i32 { return 0 }`),
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    const initial = yield* CompilationProfile.normalize({ target: Target.wasm32UnknownUnknown.id })
    const graph = bootstrapSource(snapshot)
    const failed = yield* Effect.flip(ProfileBootstrap.complete(initial, graph))
    assert.strictEqual(failed.code, 'DependencyCycle')
    assert.strictEqual(failed.staticFailure?._tag, 'Cycle')
    const completed = yield* ProfileBootstrap.complete(initial, graph, [
      {
        package: 'demo@1.0.0',
        module: 'cycle',
        parameter: 'second',
        tier: 'profile',
        value: { kind: 'integer', value: '12' },
        origin: ConfigurationOrigin.literal('cycle override'),
      },
    ])
    assert.deepEqual(
      completed.profile.parameters.map((parameter) => parameter.value),
      [
        { kind: 'integer', value: '12' },
        { kind: 'integer', value: '12' },
      ],
    )
  }),
)

it.effect('specializes one source under distinct same-target completed profiles', () =>
  Effect.gen(function* () {
    const source = `pub param enabled: bool = false
pub param count: i32 = choose() where count > 0
static fn choose() -> i32 { if enabled { return 42 } else { return 7 } }
pub fn main() -> i32 { static if enabled { return count } else { return 0 } }`
    const selected = AnalysisFixture.configuration('configured', Target.wasm32UnknownUnknown.id)
    const frontend = yield* Analysis.make({
      root: 'configured',
      configuration: selected,
    }).pipe(
      Effect.provide(
        SourceResolver.overlay([SourceFile.make('configured', encoder.encode(source))]).pipe(
          Layer.provideMerge(SourceResolver.empty),
        ),
      ),
    )
    for (const enabled of [false, true]) {
      const snapshot = yield* Analysis.realize(frontend, {
        ...selected,
        modules: [{ canonical: 'configured', package: 'demo@1.0.0', module: 'configured' }],
        bindings: [
          {
            package: 'demo@1.0.0',
            module: 'configured',
            parameter: 'enabled',
            tier: 'profile',
            value: { kind: 'boolean', value: enabled },
            origin: ConfigurationOrigin.literal('test profile'),
          },
        ],
      }).pipe(Effect.provide(SourceResolver.empty))
      assert.deepEqual(Analysis.diagnostics(snapshot), [])
      assert.strictEqual(snapshot.mir._tag, 'Available')
      assert.deepEqual(
        snapshot.profile?.parameters.find((parameter) => parameter.parameter === 'count')?.value,
        { kind: 'integer', value: enabled ? '42' : '7' },
      )
    }
  }),
)

it.effect('resolves imported defaults and validates overrides using final target facts', () =>
  Effect.gen(function* () {
    const root = `import config.helper
pub param count: u32 = helper.choose() where helper.validate(count)
pub fn main() -> i32 { return 0 }`
    const helper = `pub param word: u32 = Intrinsic.targetPointerBits()
pub static fn choose() -> u32 { return word }
pub static fn validate(value: u32) -> bool { if value == 0 { compileError("count must be positive") } return true }
static fn unused() -> u32 { return unused() }`
    const snapshot = yield* Analysis.make({
      root: 'main',
    }).pipe(
      Effect.provide(
        SourceResolver.overlay([SourceFile.make('main', encoder.encode(root))]).pipe(
          Layer.provideMerge(
            SourceResolver.memory(new Map([['config/helper', encoder.encode(helper)]])),
          ),
        ),
      ),
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    const source = bootstrapSource(snapshot)
    for (const target of [Target.wasm32UnknownUnknown, Target.aarch64AppleDarwin]) {
      const initial = yield* CompilationProfile.normalize({ target: target.id })
      const completed = yield* ProfileBootstrap.complete(initial, source)
      assert.deepEqual(
        completed.profile.parameters.find((parameter) => parameter.parameter === 'count')?.value,
        {
          kind: 'integer',
          value: String(target.pointerSize * 8),
        },
      )
      assert.notInclude(completed.bootstrapIdentity, 'unused')
      const invalid = yield* Effect.flip(
        ProfileBootstrap.complete(initial, source, [
          {
            package: 'demo@1.0.0',
            module: 'main',
            parameter: 'count',
            tier: 'project',
            value: { kind: 'integer', value: '0' },
            origin: ConfigurationOrigin.literal('explicit zero'),
          },
        ]),
      )
      assert.strictEqual(invalid.code, 'ValidationFailed')
      assert.strictEqual(invalid.staticFailure?._tag, 'CompileError')
      assert.isAbove(invalid.staticFailure?.trace.length ?? 0, 0)
    }
  }),
)

it.effect(
  'rejects missing required values and duplicate equal bindings before defaults execute',
  () =>
    Effect.gen(function* () {
      const snapshot = yield* Analysis.ofSource(
        'required',
        encoder.encode('pub param enabled: bool\npub fn main() -> i32 { return 0 }'),
      )
      const initial = yield* CompilationProfile.normalize({
        target: Target.wasm32UnknownUnknown.id,
      })
      const source = bootstrapSource(snapshot)
      assert.strictEqual(
        (yield* Effect.flip(ProfileBootstrap.complete(initial, source))).code,
        'MissingParameter',
      )
      const binding: PackageConfiguration.Binding = {
        package: 'demo@1.0.0',
        module: 'required',
        parameter: 'enabled',
        tier: 'project',
        value: { kind: 'boolean', value: true },
        origin: ConfigurationOrigin.literal('required binding'),
      }
      assert.strictEqual(
        (yield* Effect.flip(
          ProfileBootstrap.complete(initial, source, [binding, { ...binding, tier: 'workspace' }]),
        )).code,
        'ConflictingBindings',
      )
      assert.deepEqual(
        (yield* ProfileBootstrap.complete(initial, source, [binding])).profile.parameters[0]?.value,
        { kind: 'boolean', value: true },
      )
    }),
)

it.effect('rejects recursive schema shapes before attempting a required default', () =>
  Effect.gen(function* () {
    const snapshot = yield* Analysis.ofSource(
      'schema-cycle',
      encoder.encode(
        'pub struct Node { pub next: Node }\npub param node: Node\npub fn main() -> i32 { return 0 }',
      ),
    )
    const initial = yield* CompilationProfile.normalize({ target: Target.wasm32UnknownUnknown.id })
    const error = yield* Effect.flip(ProfileBootstrap.complete(initial, bootstrapSource(snapshot)))
    assert.strictEqual(error.code, 'DependencyCycle')
    assert.isAbove(error.dependencies.length, 1)
  }),
)

it.effect('tracks demanded source changes separately from completed logical value identity', () =>
  Effect.gen(function* () {
    const initial = yield* CompilationProfile.normalize({ target: Target.wasm32UnknownUnknown.id })
    const completed: Array<ProfileBootstrap.Completion> = []
    for (const [used, unused] of [
      ['32', '1'],
      ['16 + 16', '1'],
      ['16 + 16', '2'],
    ]) {
      const source = `pub param count: u32 = selected()\nstatic fn selected() -> u32 { return ${used} }\nstatic fn unused() -> u32 { return ${unused} }\npub fn main() -> i32 { return 0 }`
      const snapshot = yield* Analysis.ofSource('dependencies', encoder.encode(source))
      completed.push(yield* ProfileBootstrap.complete(initial, bootstrapSource(snapshot)))
    }
    const first = completed[0] ?? unreachable('expected first profile')
    const second = completed[1] ?? unreachable('expected second profile')
    const third = completed[2] ?? unreachable('expected third profile')
    assert.strictEqual(first.profile.identity, second.profile.identity)
    assert.notStrictEqual(first.bootstrapIdentity, second.bootstrapIdentity)
    assert.strictEqual(second.bootstrapIdentity, third.bootstrapIdentity)
  }),
)

it.effect('snapshots configuration bindings before publishing a frontend', () =>
  Effect.gen(function* () {
    const value = { kind: 'boolean', value: false }
    const profile = { target: 'wasm32-unknown-unknown', debug: false }
    const frontend = yield* Analysis.make({
      root: 'main',
      configuration: {
        package: 'demo@1.0.0',
        profile,
        bindings: [
          {
            package: 'demo@1.0.0',
            module: 'main',
            parameter: 'enabled',
            tier: 'profile',
            value,
            origin: ConfigurationOrigin.literal('request'),
          },
        ],
      },
    }).pipe(
      Effect.provide(
        SourceResolver.overlay([
          SourceFile.make(
            'main',
            encoder.encode('pub param enabled: bool\npub fn main() -> i32 { return 0 }'),
          ),
        ]).pipe(Layer.provideMerge(SourceResolver.empty)),
      ),
    )
    value.value = true
    profile.debug = true
    const completed = yield* Analysis.realize(frontend).pipe(Effect.provide(SourceResolver.empty))
    assert.deepEqual(Analysis.diagnostics(completed), [])
    assert.strictEqual(completed.profile?.debug, false)
    assert.deepEqual(completed.profile?.parameters[0]?.value, { kind: 'boolean', value: false })
  }),
)
