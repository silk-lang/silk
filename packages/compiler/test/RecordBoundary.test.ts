import * as Fs from 'node:fs'
import * as Path from 'node:path'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as AggregateIdentity from '../src/AggregateIdentity.js'
import * as Analysis from '../src/Analysis.js'
import * as Intrinsic from '../src/Intrinsic.js'
import * as Type from '../src/Type.js'
import * as AnalysisFixture from './support/AnalysisFixture.js'
import { unreachable } from './support/raise.js'

const source = Path.join(import.meta.dirname, '..', 'src')

it.effect('shares ordinary positional facts with occurrence-owned intrinsic pair results', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'record/result-pairs',
      new TextEncoder().encode(`fn element() -> usize { return 1 }
      pub fn main() -> usize {
        let first = (element(), element())
        let second = (element(), element())
        return first.0 + second.1
      }`),
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    const tuples = [...snapshot.index.generatedAggregates.values()].filter(
      (aggregate) => aggregate.aggregateKind === 'AnonymousPositional',
    )
    assert.lengthOf(tuples, 2)
    const first = tuples.at(0) ?? unreachable('expected the first selected tuple occurrence')
    const second = tuples.at(1) ?? unreachable('expected the second selected tuple occurrence')
    const occurrence =
      first.identity?._tag === 'AnonymousAggregateIdentity'
        ? first.identity
        : unreachable('expected first retained anonymous tuple identity')
    const otherOccurrence =
      second.identity?._tag === 'AnonymousAggregateIdentity'
        ? second.identity
        : unreachable('expected second retained anonymous tuple identity')
    const generatedFacts: Array<ReturnType<typeof AggregateIdentity.generated>> = []
    const selected = Intrinsic.instantiateResult(
      Intrinsic.generatedUsizePair,
      new Map(),
      (fields) => {
        const facts = AggregateIdentity.generated(
          occurrence,
          first.anchor,
          fields.map((type) => ({ type, anchor: first.anchor })),
        )
        generatedFacts.push(facts)
        return facts.type
      },
    )
    assert.lengthOf(generatedFacts, 1)
    const facts = generatedFacts.at(0) ?? unreachable('expected generated owned pair facts')
    assert.isTrue(Type.equals(selected, AggregateIdentity.nominal(occurrence)))
    assert.deepEqual(
      facts.struct.fields.map((field) => [
        field.member,
        field.visibility,
        field.declaredType._tag === 'Resolved' ? field.declaredType.type : undefined,
      ]),
      [
        [{ _tag: 'OrdinalAggregateMember', ordinal: 0 }, 'Public', 'usize'],
        [{ _tag: 'OrdinalAggregateMember', ordinal: 1 }, 'Public', 'usize'],
      ],
    )
    const replay = Intrinsic.instantiateResult(
      Intrinsic.generatedUsizePair,
      new Map(),
      (fields) =>
        AggregateIdentity.generated(
          occurrence,
          first.anchor,
          fields.map((type) => ({ type, anchor: first.anchor })),
        ).type,
    )
    const other = Intrinsic.instantiateResult(
      Intrinsic.generatedUsizePair,
      new Map(),
      (fields) =>
        AggregateIdentity.generated(
          otherOccurrence,
          second.anchor,
          fields.map((type) => ({ type, anchor: second.anchor })),
        ).type,
    )
    assert.isTrue(
      Type.equals(selected, replay),
      'the selected artifact/NodeRef owns stable result facts',
    )
    assert.isFalse(
      Type.equals(selected, other),
      'a different occurrence does not share a fabricated nominal result',
    )
    assert.deepEqual(facts.struct.identity, occurrence)
    assert.strictEqual(facts.struct.name._tag, 'Unavailable')
  }),
)

it('has no public re-analysis surface or legacy lowering module', () => {
  const files = Fs.readdirSync(source, { recursive: true, encoding: 'utf8' })
  assert.notInclude(files, 'TirLowering.ts')
  assert.notInclude(files, 'BodyConstruction.ts')
  const legacyNames = [
    /\bFunctionFact\b/,
    /\bStatementFact\b/,
    /\bExpressionFact\b/,
    /\bTirLowering\b/,
    /Elaboration\.records\b/,
  ]
  for (const file of files.filter((candidate) => candidate.endsWith('.ts'))) {
    const text = Fs.readFileSync(Path.join(source, file), 'utf8')
    assert.notMatch(text, /Elaboration\.(records|executableFunctions)\b/, file)
    for (const legacyName of legacyNames) assert.notMatch(text, legacyName, file)
  }
})

it('has no rebinding of cached bodies', () => {
  const files = Fs.readdirSync(source, { recursive: true, encoding: 'utf8' })
  assert.notInclude(files, 'SemanticRebinding.ts')
  for (const file of files.filter((candidate) => candidate.endsWith('.ts')))
    assert.notMatch(Fs.readFileSync(Path.join(source, file), 'utf8'), /SemanticRebinding/, file)
})
