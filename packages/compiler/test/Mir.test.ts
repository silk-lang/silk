import * as AnalysisFixture from './support/AnalysisFixture.js'
import { nativeCorpus, narrowEffectRecord, outputStorageSource } from './support/corpus.js'
import { readFileSync } from 'node:fs'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Analysis from '../src/Analysis.js'
import * as CAbi from '../src/CAbi.js'
import * as Lifetime from '../src/Lifetime.js'
import * as Mir from '../src/Mir.js'
import * as MirEncoding from '../src/MirEncoding.js'
import * as MirVerification from '../src/MirVerification.js'
import * as Target from '../src/Target.js'
import * as Tir from '../src/Tir.js'
import * as Type from '../src/Type.js'
import * as MirSamples from './support/mirSamples.js'

const ascii = (value: string): Uint8Array =>
  Uint8Array.from(value, (character) => character.charCodeAt(0))

it('preserves access, safety, and outcome contracts when adapting physical operands', () => {
  const owner = { module: 'mir/operands', name: 'adapt' }
  const first = { environment: Lifetime.bound(owner, 0, 'a'), lifetimeBinders: [] }
  const second = { environment: Lifetime.bound(owner, 1, 'b'), lifetimeBinders: [] }
  const shared = Type.effect('i32', [], first)
  const taken = Type.effect('i32', [], second, 'Take')
  assert.isTrue(Mir.acceptsRuntimeOperand(shared, taken))
  assert.isFalse(Mir.acceptsRuntimeOperand(taken, shared))
  assert.isFalse(Mir.acceptsRuntimeOperand(shared, Type.effect('bool', [], second, 'Take')))
  assert.isFalse(Mir.acceptsRuntimeOperand(shared, Type.effect('i32', ['bool'], second, 'Take')))

  const callback = Type.callable(['i32'], shared, first)
  const parameter = Type.callable(['i32'], taken, second, 'Take')
  assert.isTrue(Mir.acceptsRuntimeOperand(callback, parameter))
  assert.isFalse(Mir.acceptsRuntimeOperand(parameter, callback))
  assert.isFalse(Mir.acceptsRuntimeOperand({ ...callback, unsafe: true }, parameter))
  assert.isFalse(Mir.acceptsRuntimeOperand(callback, { ...parameter, parameters: ['bool'] }))

  for (const make of [Type.reference, Type.slice]) {
    const exclusive = make('Exclusive', 'i32', first.environment)
    const sharedView = make('Shared', 'i32', second.environment)
    assert.isTrue(Mir.acceptsRuntimeOperand(exclusive, sharedView))
    assert.isFalse(Mir.acceptsRuntimeOperand(sharedView, exclusive))
    assert.isFalse(Mir.acceptsRuntimeOperand(exclusive, make('Shared', 'bool', second.environment)))
  }
})

it('erases lifetime argument positions without erasing runtime specialization arguments', () => {
  const lifetime = Lifetime.bound({ module: 'mir/arguments', name: 'select' }, 0, 'a')
  assert.isTrue(Mir.runtimeArgumentsEqual([lifetime], []))
  assert.isTrue(Mir.runtimeArgumentsEqual([lifetime, 'i32'], ['i32', Lifetime.staticLifetime]))
  assert.isFalse(Mir.runtimeArgumentsEqual([lifetime, 'i32'], []))
  assert.isFalse(Mir.runtimeArgumentsEqual([lifetime, 'i32'], ['bool']))
})

const golden = (name: string): string =>
  readFileSync(new URL(`./goldens/${name}`, import.meta.url), 'utf8')

const raise = (message: string): never => {
  throw new Error(message)
}

const operationRegion = (region: Mir.Region | undefined): Mir.OperationRegion => {
  if (region?._tag !== 'OperationRegion') throw new Error('expected an operation region')
  return region
}

it.effect('captures by-value call arguments before later arguments mutate their source', () =>
  Effect.gen(function* () {
    const program =
      nativeCorpus.find((entry) => entry.name === 'scalar-reference-argument-order') ??
      raise('expected argument-order corpus case')
    const snapshot = yield* AnalysisFixture.retainingMain(
      'mir/call-argument-order',
      ascii(program.source),
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    for (const mode of ['debug', 'release'] as const) {
      const artifact = yield* Analysis.codegen(snapshot, { mode })
      const main =
        artifact.ir.match(
          /define[^\n]+@silk_mir_call_argument_order_main[^\n]+\n([\s\S]*?)\n}/,
        )?.[1] ?? raise('expected main LLVM body')
      const mutation = main.indexOf('call i32 @silk_mir_call_argument_order_change')
      const first =
        main.match(/call i32 @silk_mir_call_argument_order_add[^\n]*\(i32 ([^,]+),/)?.[1] ??
        raise('expected first argument')
      assert.isAtLeast(mutation, 0)
      if (first === '20') continue
      const capture = main.indexOf(`${first} =`)
      assert.isAtLeast(capture, 0)
      assert.isBelow(capture, mutation, `${mode}: first argument must be read before change`)
    }
  }),
)

it.effect('reads borrowed match scalars before lowering builtin value operations', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'mir/borrowed-match-scalar',
      ascii(`union Flag { Present { enabled: bool }, Absent }
fn disabled(value: &Flag) -> bool {
  return match & value.* {
    Flag.Present { enabled } => !enabled
    _ => false
  }
}
pub fn main() -> i32 {
  let value = Flag.Absent
  if disabled(&value) { return 1 }
  return 0
}`),
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    const program = Analysis.loweredMir(snapshot)
    const disabled =
      program.functions.find((fn) => fn.id.name === 'disabled') ??
      raise('expected disabled function')
    const operations = MirVerification.operations(disabled)
    const match = operations.find((operation) => operation._tag === 'Match')
    const binding = match?.arms.at(0)?.bindings.at(0)
    assert.strictEqual(binding?.type._tag, 'EnvironmentBorrow')
    const read = operations.find((operation) => operation._tag === 'ReadPlace')
    assert.strictEqual(read?.root.ordinal, binding?.destination.ordinal)
    assert.strictEqual(read?.type._tag, 'bool')
    const negation = operations.find(
      (operation) => operation._tag === 'Binary' && operation.operator === 'Equals',
    )
    if (negation?._tag !== 'Binary') return raise('expected scalar negation')
    assert.strictEqual(negation.left.ordinal, read?.destination.ordinal)
    assert.strictEqual(negation.type._tag, 'bool')
    const literals = operations.filter((operation) => operation._tag === 'Literal')
    assert.isAbove(literals.length, 0)
    assert.isTrue(literals.every((operation) => operation.type._tag === 'bool'))
    assert.deepEqual(yield* MirVerification.verify(program), [])
  }),
)

it.effect(
  'lowers scalar enum constants, projection, equality, and matches with logical identity',
  () =>
    Effect.gen(function* () {
      const snapshot = yield* AnalysisFixture.retainingMain(
        'mir/scalar-enum',
        ascii(`enum State { Ready = 3, Done = 7 }
enum Other { Ready = 3 }
pub fn main() -> i32 {
  let state = State.Ready
  let other = Other.Ready
  drop other
  let raw = State.value(state)
  drop raw
  let equal = state == State.Done
  drop equal
  return match state {
    State.Ready => 1
    State.Done => 2
  }
}`),
      )
      assert.deepEqual(Analysis.diagnostics(snapshot), [])
      const program = Analysis.loweredMir(snapshot)
      assert.deepEqual(yield* MirVerification.verify(program), [])
      const operations = program.functions.flatMap((fn) => MirVerification.operations(fn))
      assert.strictEqual(
        operations.filter((operation) => operation._tag === 'EnumConstant').length,
        3,
      )
      assert.strictEqual(operations.filter((operation) => operation._tag === 'EnumValue').length, 1)
      assert.strictEqual(
        operations.filter((operation) => operation._tag === 'EnumEquality').length,
        1,
      )
      const match = operations.find((operation) => operation._tag === 'Match')
      assert.strictEqual(match?.scrutineeType._tag, 'Enum')
      if (match?._tag !== 'Match') return
      assert.deepEqual(
        match.members.map((member) =>
          member._tag === 'EnumMember' ? member.member.name : member._tag,
        ),
        ['Ready', 'Done'],
      )
      assert.strictEqual(MirEncoding.encode(program), MirEncoding.encode(program))
    }),
)

it.effect('rejects malformed scalar enum MIR before execution engines', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'mir/invalid-scalar-enum',
      ascii(`enum State { Ready = 3, Done = 7 }
enum Other { Ready = 3 }
pub fn main() -> i32 {
  let state = State.Ready
  let other = Other.Ready
  drop other
  let raw = State.value(state)
  drop raw
  let equal = state == State.Done
  drop equal
  return match state {
    State.Ready => 1
    State.Done => 2
  }
}`),
    )
    const program = Analysis.loweredMir(snapshot)
    const fn = program.functions.at(0) ?? raise('expected scalar enum function')
    const operations = MirVerification.operations(fn)
    const constants = operations.filter((operation) => operation._tag === 'EnumConstant')
    const stateReady = constants.find((operation) => operation.member.enum.name === 'State')
    const stateDone = constants.find(
      (operation) => operation.member.enum.name === 'State' && operation.member.name === 'Done',
    )
    const otherReady = constants.find((operation) => operation.member.enum.name === 'Other')
    const projection = operations.find((operation) => operation._tag === 'EnumValue')
    const equality = operations.find((operation) => operation._tag === 'EnumEquality')
    const match = operations.find((operation) => operation._tag === 'Match')
    if (
      stateReady === undefined ||
      stateDone === undefined ||
      otherReady === undefined ||
      projection === undefined ||
      equality === undefined ||
      match === undefined
    )
      return raise('expected complete scalar enum MIR')

    const replace = (target: Mir.Operation, replacement: Mir.Operation): Mir.Module => ({
      ...program,
      functions: program.functions.map((candidate) => {
        if (candidate !== fn) return candidate
        return {
          ...candidate,
          regions: candidate.regions.map((region) => {
            if (region._tag !== 'OperationRegion' || !region.operations.includes(target)) {
              return region
            }
            return {
              ...region,
              operations: region.operations.map((operation) =>
                operation === target ? replacement : operation,
              ),
            }
          }),
        }
      }),
    })
    const ruleSet = Effect.fnUntraced(function* (candidate: Mir.Module) {
      return (yield* MirVerification.verify(candidate)).map((violation) => violation.rule)
    })

    assert.include(
      yield* ruleSet(replace(stateReady, { ...stateReady, member: otherReady.member })),
      'InvalidEnumOperation',
    )
    assert.include(
      yield* ruleSet(replace(stateReady, { ...stateReady, discriminant: 99n })),
      'InvalidEnumOperation',
    )
    assert.include(
      yield* ruleSet(
        replace(equality, {
          ...equality,
          right: otherReady.destination,
        }),
      ),
      'InvalidEnumOperation',
    )
    assert.include(
      yield* ruleSet(
        replace(projection, {
          ...projection,
          enum: otherReady.enum,
        }),
      ),
      'InvalidEnumOperation',
    )
    const wrongLane = 'u16' as const
    const wrongBits = 16 as const
    assert.include(
      yield* ruleSet(
        replace(stateDone, {
          ...stateDone,
          representation: {
            ...stateDone.representation,
            scalar: wrongLane,
            bits: wrongBits,
          },
        }),
      ),
      'InvalidEnumOperation',
    )

    const firstMember = match.members.at(0) ?? raise('expected first enum match member')
    const firstDecision = match.decisions.at(0) ?? raise('expected first enum match decision')
    const incomplete = replace(match, {
      ...match,
      members: [firstMember],
      decisions: [firstDecision],
      arms: match.arms.slice(0, 1),
    })
    const duplicate = replace(match, {
      ...match,
      members: [firstMember, firstMember],
      decisions: [firstDecision, firstDecision],
    })
    const foreign = replace(match, {
      ...match,
      members: [
        firstMember,
        {
          _tag: 'EnumMember',
          enum: otherReady.enum,
          member: otherReady.member,
          type: otherReady.type.type,
        },
      ],
    })
    for (const malformed of [incomplete, duplicate, foreign]) {
      assert.include(yield* ruleSet(malformed), 'InvalidMatchDecision')
      assert.deepEqual(
        yield* MirVerification.verify(malformed),
        yield* MirVerification.verify(malformed),
      )
    }
  }),
)
it.effect(
  'verifies the hand-built samples clean',
  Effect.fnUntraced(function* () {
    for (const sample of yield* MirSamples.samples()) {
      assert.deepEqual(yield* MirVerification.verify(sample), [])
    }
  }),
)
it.effect(
  'rejects nested unavailable values at the monomorphic MIR frontier',
  Effect.fnUntraced(function* () {
    const [straight] = yield* MirSamples.samples()
    const sample = straight ?? raise('expected sample')
    const fn = sample.functions.at(0) ?? raise('expected sample function')
    const unavailable = Type.nominal('sample://unavailable.silk', 'Outer', [
      Type.nominal('sample://unavailable.silk', 'Inner', [
        Type.unavailableGenericArgument('Value', 'unresolved MIR argument'),
      ]),
    ])
    const unavailableLocal: Mir.Module = {
      ...sample,
      functions: [
        {
          ...fn,
          localTypes: [...fn.localTypes, { _tag: 'Nominal', type: unavailable }],
        },
      ],
    }
    assert.include(
      (yield* MirVerification.verify(unavailableLocal)).map((violation) => violation.rule),
      'InvalidInstance',
    )

    const unavailableInstance = {
      ...fn.instance,
      typeArguments: [unavailable],
    }
    const unavailableIdentity: Mir.Module = {
      ...sample,
      retainedRoots: [unavailableInstance],
      functions: [{ ...fn, instance: unavailableInstance }],
    }
    assert.include(
      (yield* MirVerification.verify(unavailableIdentity)).map((violation) => violation.rule),
      'InvalidInstance',
    )
  }),
)
it.effect(
  'retains invalid return types as a verifier invariant',
  Effect.fnUntraced(function* () {
    const [straight] = yield* MirSamples.samples()
    const sample = straight ?? raise('expected sample')
    const fn = sample.functions.at(0) ?? raise('expected sample function')
    const invalid: Mir.Module = {
      ...sample,
      functions: [{ ...fn, result: { _tag: 'bool' } }],
    }

    assert.include(
      (yield* MirVerification.verify(invalid)).map((violation) => violation.rule),
      'InvalidReturn',
    )
  }),
)
it.effect('accepts a returned Effect that realizes the declared result contract', () =>
  Effect.gen(function* () {
    // `fallible` returns a fail-only block (`never` success) under a declared `i32` success, and
    // `pending` returns a take-once witness Effect under a declared shared Effect. Both returned
    // values pin the same realization the MIR result names.
    const snapshot = yield* AnalysisFixture.retainingMain(
      'mir/effect-return-realization',
      ascii(`import silk.effect { Effect }
struct Problem { code: i32 }
interface Decoder<S, Arguments> {
  effect<'env> fn decode<'env>(self: &S, arguments: Arguments) -> i32 ! Problem
}
struct Schema { value: i32 }
effect fn decodeSchema(self: &Schema, encoded: i32) -> i32 ! Problem {
  return self.value + encoded
}
impl Decoder<Schema, i32> for Schema { decode: Schema.decodeSchema }
fn pending<T: Decoder<T, i32>>(value: &T) -> Effect<i32 ! Problem> {
  return Decoder.decode(value, 2)
}
fn fallible() -> Effect<'static; i32 ! Problem> {
  return effect { fail Problem { code: 40 } }
}
effect fn recover(problem: Problem) -> i32 { return problem.code }
pub fn main() -> i32 {
  let schema = Schema { value: 40 }
  let decoded = run Effect.catch<Problem>(pending<Schema>(&schema), recover)
  let recovered = run Effect.catch<Problem>(fallible(), recover)
  return decoded + recovered - 40
}`),
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    const mir = Analysis.loweredMir(snapshot)
    assert.deepEqual(yield* MirVerification.verify(mir), [])

    const effectReturn = (name: string) => {
      const fn =
        mir.functions.find((candidate) => candidate.id.name === name) ?? raise(`expected ${name}`)
      const value =
        fn.regions.flatMap((region) =>
          region._tag === 'OperationRegion' && region.outcome._tag === 'Return'
            ? [region.outcome.value]
            : [],
        )[0] ?? raise(`expected ${name} to return`)
      const returned = fn.localTypes.at(value.ordinal)
      const result = fn.result
      if (result._tag !== 'EffectValue' || returned?._tag !== 'EffectValue')
        return raise(`expected ${name} to return an Effect value`)
      return { fn, ordinal: value.ordinal, returned, result }
    }
    const fallible = effectReturn('fallible')
    const pending = effectReturn('pending')
    const original = snapshot.instances.instances.find(
      (instance) => instance.key.declaration.name === 'fallible',
    )
    const producer = original?.function.statements
      .flatMap(Tir.statementExpressions)
      .find((expression) => expression._tag === 'EffectBlock')
    assert.isTrue(
      producer?._tag === 'EffectBlock' &&
        Type.isEffect(producer.type) &&
        Type.isNever(producer.type.success),
    )
    // The checked declaration supplies the physical success carrier once, including the runner.
    assert.strictEqual(fallible.returned.type.success, 'i32')
    assert.strictEqual(fallible.returned.environment.effect.success, 'i32')
    assert.isTrue(Mir.realizesReturn(fallible.returned, fallible.result))
    assert.isTrue(Mir.realizesReturn(pending.returned, pending.result))
    // A declared `never` success does not accept a realized value.
    const bottomResult: Mir.Type = {
      ...fallible.returned,
      type: { ...fallible.returned.type, success: 'never' },
    }
    assert.isTrue(Mir.realizesReturn(bottomResult, fallible.result))
    assert.isFalse(Mir.realizesReturn(fallible.result, bottomResult))
    // The site and environment instance each pin the realization.
    assert.isFalse(
      Mir.realizesReturn(fallible.returned, { ...fallible.result, site: pending.result.site }),
    )
    assert.isFalse(
      Mir.realizesReturn(fallible.returned, {
        ...fallible.result,
        environment: {
          ...fallible.result.environment,
          instance: pending.result.environment.instance,
        },
      }),
    )
    // Failure and requirement rows stay exact, including requirement access.
    const withRows = (
      failures: ReadonlyArray<Type.Type>,
      access: 'Shared' | 'Exclusive',
    ): Mir.Type => ({
      ...fallible.result,
      type: Type.effect('i32', failures, fallible.result.type, 'Shared', [
        { capability: Type.nominal('mir/rows', 'Clock', []), role: 'DefaultRole', access },
      ]),
    })
    assert.isTrue(Mir.realizesReturn(withRows([], 'Shared'), withRows([], 'Shared')))
    assert.isFalse(Mir.realizesReturn(withRows([], 'Shared'), withRows(['bool'], 'Shared')))
    assert.isFalse(Mir.realizesReturn(withRows([], 'Shared'), withRows([], 'Exclusive')))

    const reversed: Mir.Module = {
      ...mir,
      functions: mir.functions.map((fn) =>
        fn === fallible.fn
          ? {
              ...fn,
              result: bottomResult,
              localTypes: fn.localTypes.map((type, ordinal) =>
                ordinal === fallible.ordinal ? fallible.result : type,
              ),
            }
          : fn,
      ),
    }
    assert.include(
      (yield* MirVerification.verify(reversed)).map((violation) => violation.rule),
      'InvalidReturn',
    )
  }),
)
it.effect(
  'reports broken graphs deterministically as data',
  Effect.fnUntraced(function* () {
    const [straight] = yield* MirSamples.samples()
    const fn = straight?.functions.at(0) ?? raise('expected the sample function')
    const first = operationRegion(fn.regions.at(0))
    const broken: Mir.Module = {
      _tag: 'MirModule',
      module: 'sample://broken.silk',
      intrinsics: straight?.intrinsics ?? raise('expected the sample intrinsic inventory'),
      foreignCalls: Object.freeze([]),
      foreignExports: Object.freeze([]),
      foreignStatics: Object.freeze([]),
      layout: straight?.layout ?? raise('expected the sample layout'),
      executionTransitions: straight?.executionTransitions ?? Object.freeze([]),
      functions: [
        { ...fn, entry: { _tag: 'Region', ordinal: 9 } },
        {
          ...fn,
          regions: [
            {
              ...first,
              operations: first.operations.map((operation) =>
                operation._tag === 'Literal'
                  ? { ...operation, destination: { _tag: 'Local' as const, ordinal: 7 } }
                  : operation,
              ),
              outcome: {
                _tag: 'Forward',
                target: { _tag: 'Region', ordinal: 9 },
                provenance: { span: first.outcome.provenance.span, generated: true },
              },
            },
          ],
        },
      ],
    }
    const violations = yield* MirVerification.verify(broken)
    assert.deepEqual(
      violations.map((violation) => violation.rule),
      [
        'MissingEntryRegion',
        'InvalidInstance',
        'UnknownRegionTarget',
        'UndeclaredLocal',
        'InvalidIntegerOperation',
      ],
    )
    assert.deepEqual(yield* MirVerification.verify(broken), violations)
  }),
)
it.effect(
  'rejects structural cycles without treating lexical repetition as an edge',
  Effect.fnUntraced(function* () {
    const [straight] = yield* MirSamples.samples()
    const sample = straight ?? raise('expected sample')
    const fn = sample.functions.at(0) ?? raise('expected sample function')
    const first = operationRegion(fn.regions.at(0))
    const cyclic: Mir.Module = {
      ...sample,
      functions: [
        {
          ...fn,
          regions: [
            {
              ...first,
              operations: [],
              outcome: {
                _tag: 'Forward',
                target: first.id,
                provenance: first.outcome.provenance,
              },
            },
          ],
        },
      ],
    }

    assert.include(
      (yield* MirVerification.verify(cyclic)).map((violation) => violation.rule),
      'StructuralCycle',
    )
  }),
)
it.effect(
  'rejects repeat and exit ports that name no lexical loop owner',
  Effect.fnUntraced(function* () {
    const [straight] = yield* MirSamples.samples()
    const sample = straight ?? raise('expected sample')
    const fn = sample.functions.at(0) ?? raise('expected sample function')
    const first = operationRegion(fn.regions.at(0))
    const invalid: Mir.Module = {
      ...sample,
      functions: [
        {
          ...fn,
          regions: [
            {
              ...first,
              outcome: {
                _tag: 'Repeat',
                loop: { _tag: 'Loop', ordinal: 99 },
                provenance: first.outcome.provenance,
              },
            },
          ],
        },
      ],
    }

    assert.include(
      (yield* MirVerification.verify(invalid)).map((violation) => violation.rule),
      'InvalidLoopTarget',
    )
  }),
)
it.effect(
  'requires every yield to be one uniquely owned loop condition',
  Effect.fnUntraced(function* () {
    const [, branching] = yield* MirSamples.samples()
    const sample = branching ?? raise('expected branching sample')
    const fn = sample.functions.at(0) ?? raise('expected sample function')
    const returned = operationRegion(fn.regions.at(1))
    const provenance = returned.outcome.provenance
    const region = (ordinal: number): Mir.RegionId => ({ _tag: 'Region', ordinal })
    const loop = (ordinal: number): Mir.LoopId => ({ _tag: 'Loop', ordinal })
    const loop0 = loop(0)
    const condition: Mir.OperationRegion = {
      _tag: 'OperationRegion',
      id: region(1),
      ownerLoop: loop0,
      operations: [],
      outcome: { _tag: 'Yield', provenance },
    }
    const body: Mir.OperationRegion = {
      _tag: 'OperationRegion',
      id: region(2),
      ownerLoop: loop0,
      operations: [],
      outcome: { _tag: 'Exit', loop: loop0, provenance },
    }
    const following: Mir.OperationRegion = { ...returned, id: region(3) }
    const owner: Mir.LoopRegion = {
      _tag: 'LoopRegion',
      id: region(0),
      loop: loop0,
      condition: condition.id,
      conditionValue: { _tag: 'Local', ordinal: 0 },
      body: body.id,
      following: following.id,
      provenance,
    }
    const withRegions = (regions: ReadonlyArray<Mir.Region>): Mir.Module => ({
      ...sample,
      functions: [{ ...fn, entry: owner.id, regions }],
    })
    const valid = withRegions([owner, condition, body, following])
    assert.deepEqual(yield* MirVerification.verify(valid), [])

    const unownedYield = withRegions([
      owner,
      condition,
      { ...body, outcome: { _tag: 'Yield', provenance } },
      following,
    ])
    assert.include(
      (yield* MirVerification.verify(unownedYield)).map((violation) => violation.rule),
      'InvalidLoopTarget',
    )

    const nonYieldCondition = withRegions([
      owner,
      { ...condition, outcome: { _tag: 'Exit', loop: loop0, provenance } },
      body,
      following,
    ])
    assert.include(
      (yield* MirVerification.verify(nonYieldCondition)).map((violation) => violation.rule),
      'InvalidLoopTarget',
    )

    const sharedCondition: Mir.LoopRegion = {
      ...owner,
      id: region(4),
      loop: loop(1),
    }
    assert.include(
      (yield* MirVerification.verify(
        withRegions([owner, condition, body, following, sharedCondition]),
      )).map((violation) => violation.rule),
      'InvalidLoopTarget',
    )
  }),
)
it.effect(
  'carries and encodes exactly one compiler-owned target layout plan',
  Effect.fnUntraced(function* () {
    const [straight] = yield* MirSamples.samples()
    const sample = straight ?? raise('expected sample')

    assert.strictEqual(sample.layout.entries.at(0)?.size, 4)
    assert.include(MirEncoding.encode(sample), `target ${Target.encode(sample.layout.target)}`)
    assert.include(MirEncoding.encode(sample), 'layout i32 size=4 align=4 repr=signed-i32')
  }),
)
it.effect(
  'marks generated outcomes and preserves programmer provenance',
  Effect.fnUntraced(function* () {
    const [, branching] = yield* MirSamples.samples()
    const encoded = MirEncoding.encode(branching ?? raise('expected branching sample'))

    assert.include(encoded, 'conditional condition=%0')
    assert.include(encoded, 'trap "otherwise" [25, 34) generated')
  }),
)
it.effect(
  'matches the MIR golden encodings byte-for-byte',
  Effect.fnUntraced(function* () {
    const [straight, branching] = yield* MirSamples.samples()

    assert.strictEqual(
      MirEncoding.encode(straight ?? raise('expected sample')),
      golden('straight.mir.txt'),
    )
    assert.strictEqual(
      MirEncoding.encode(branching ?? raise('expected sample')),
      golden('branching.mir.txt'),
    )
  }),
)
it.effect(
  'constructs and encodes byte-identically across repeated runs',
  Effect.fnUntraced(function* () {
    const first = yield* MirSamples.samples()
    const second = yield* MirSamples.samples()

    assert.deepEqual(first, second)
    assert.deepEqual(first.map(MirEncoding.encode), second.map(MirEncoding.encode))
  }),
)

it.effect('lowers a foreign call to one ForeignCall carrying the classified C signature', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'mir/foreign-call',
      ascii(`unsafe extern "C" fn abs(value: i32) -> i32
pub fn main() -> i32 { return unsafe abs(-42) }`),
      'aarch64-apple-darwin',
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    const program = Analysis.loweredMir(snapshot)
    const main = program.functions.find((fn) => fn.id.name === 'main') ?? raise('expected main')
    const calls = main.regions.flatMap((region) =>
      region._tag === 'OperationRegion'
        ? region.operations.flatMap((operation) =>
            operation._tag === 'ForeignCall' ? [operation] : [],
          )
        : [],
    )
    assert.deepEqual(
      calls.map((call) => ({
        symbol: call.symbol,
        abi: call.abi,
        signature: CAbi.signatureKey(call.signature),
        arguments: call.arguments.map((local) => main.localTypes.at(local.ordinal)?._tag),
        destination: main.localTypes.at(call.destination.ordinal)?._tag,
      })),
      [
        {
          symbol: 'abs',
          abi: 'C',
          signature:
            '(i32)->i32!readwrite/external/capture:/borrow:/callbacks:/returned:-/noreturn:false/unwind:forbidden',
          arguments: ['i32'],
          destination: 'i32',
        },
      ],
    )
    assert.deepEqual(yield* MirVerification.verify(program), [])
    const encoded = MirEncoding.encode(program)
    assert.include(
      encoded,
      'foreign abs abi=C signature=(i32)->i32!readwrite/external/capture:/borrow:/callbacks:/returned:-/noreturn:false/unwind:forbidden declaration=mir/foreign-call.abs',
    )
    assert.include(
      encoded,
      '= foreign-call abs abi=C signature=(i32)->i32!readwrite/external/capture:/borrow:/callbacks:/returned:-/noreturn:false/unwind:forbidden(',
    )
    assert.strictEqual(MirEncoding.encode(program), encoded)
  }),
)
it.effect(
  'verifies foreign call arity and C classes as structural violations',
  Effect.fnUntraced(function* () {
    const valid = yield* MirSamples.foreignCallSample(Target.aarch64AppleDarwin)
    assert.deepEqual(yield* MirVerification.verify(valid), [])
    assert.strictEqual(MirEncoding.encode(valid), MirEncoding.encode(valid))
    const arityMismatch = yield* MirSamples.foreignCallSample(Target.aarch64AppleDarwin, [])
    assert.deepEqual(
      (yield* MirVerification.verify(arityMismatch)).map((violation) => violation.rule),
      ['InvalidForeignCall'],
    )
  }),
)

it.effect('verifies a foreign pointer argument against the declared pointee', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'mir/foreign-pointer-argument',
      ascii(`import silk.pointer { Pointer }
unsafe extern "C" fn inspect(value: *const i32) -> i32
pub fn main() -> i32 {
  let mut value = 1
  return unsafe inspect(Pointer.fromMutRef(&mut value))
}`),
      'aarch64-apple-darwin',
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    const program = Analysis.loweredMir(snapshot)
    assert.deepEqual(yield* MirVerification.verify(program), [])
    // The same `*mut i32` argument against a `*const u8` parameter is one violation.
    const rewritten: Mir.Module = Object.freeze({
      ...program,
      functions: Object.freeze(
        program.functions.map((fn) =>
          Object.freeze({
            ...fn,
            regions: Object.freeze(
              fn.regions.map((region) =>
                region._tag !== 'OperationRegion'
                  ? region
                  : Object.freeze({
                      ...region,
                      operations: Object.freeze(
                        region.operations.map((operation) =>
                          operation._tag !== 'ForeignCall'
                            ? operation
                            : Object.freeze({
                                ...operation,
                                signature: Object.freeze({
                                  ...operation.signature,
                                  parameters: Object.freeze([
                                    Object.freeze({
                                      _tag: 'Pointer' as const,
                                      type: Type.pointer({
                                        mutable: false,
                                        pointee: 'u8',
                                        nullable: false,
                                        extent: 'Single',
                                        alignment: 'Natural',
                                        addressSpace: 0,
                                      }),
                                    }),
                                  ]),
                                }),
                              }),
                        ),
                      ),
                    }),
              ),
            ),
          }),
        ),
      ),
    })
    assert.deepEqual(
      (yield* MirVerification.verify(rewritten)).map((violation) => violation.rule),
      ['InvalidForeignCall'],
    )
  }),
)

it.effect('rejects every Silk callable without one exact exported C address', () =>
  Effect.gen(function* () {
    const source = `unsafe extern "C" fn install(callback: extern "C" fn(i32) -> i32) -> () with Intrinsic.foreign(callbacks: ("callback",))
fn private(value: i32) -> i32 { return value }
effect fn effectful(value: i32) -> i32 { return value }
fn generic<T>(value: T) -> T { return move value }
export "C" fn wrong(value: u32) -> u32 { return value }
fn invalidPointer(callback: extern "C" fn(bool) -> i32) { drop callback }
pub fn main() -> i32 {
  let captured = 1
  unsafe {
    install(private)
    install(effectful)
    install(generic)
    install(wrong)
    install(fn(value: i32) -> i32 { return value + captured })
  }
  return 0
}`
    const snapshot = yield* AnalysisFixture.retainingMain(
      'mir/invalid-foreign-callbacks',
      ascii(source),
      'aarch64-apple-darwin',
    )
    const diagnostics = Analysis.diagnostics(snapshot).filter(
      (diagnostic) => diagnostic.code === 'SEM0207',
    )
    const invalidPointer = Analysis.diagnostics(snapshot).filter(
      (diagnostic) => diagnostic.code === 'SEM0187',
    )
    assert.deepEqual(
      invalidPointer.map((diagnostic) => source.slice(diagnostic.span.start, diagnostic.span.end)),
      ['extern "C" fn(bool) -> i32'],
    )
    assert.deepEqual(
      diagnostics.map((diagnostic) => diagnostic.reason._tag),
      [
        'InvalidForeignCallback',
        'InvalidForeignCallback',
        'InvalidForeignCallback',
        'InvalidForeignCallback',
        'InvalidForeignCallback',
      ],
    )
    assert.deepEqual(
      diagnostics.map((diagnostic) => source.slice(diagnostic.span.start, diagnostic.span.end)),
      [
        'private',
        'effectful',
        'generic',
        'wrong',
        'fn(value: i32) -> i32 { return value + captured }',
      ],
    )
  }),
)

it.effect('requires an unsafe boundary to read an imported C static', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'mir/unsafe-foreign-static',
      ascii(`unsafe extern "C" static environment: *mut *mut u8 as "environ"
pub fn main() -> i32 { let value = environment return 0 }`),
      'aarch64-apple-darwin',
    )
    assert.deepEqual(
      Analysis.diagnostics(snapshot).map((diagnostic) => diagnostic.code),
      ['SEM0082'],
    )
  }),
)

it.effect('keeps a C static binding immutable independently of pointee mutability', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'mir/immutable-foreign-static',
      ascii(`export "C" static answer: i32 = 42
pub fn main() -> i32 { answer = 1 return answer }`),
      'aarch64-apple-darwin',
    )
    assert.deepEqual(
      Analysis.diagnostics(snapshot).map((diagnostic) => diagnostic.code),
      ['SEM0035'],
    )
  }),
)

it.effect('rejects a pointer-sized C static initializer outside the selected target', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'mir/foreign-static-target-range',
      ascii(`export "C" static wide: usize = 4294967296
pub fn main() -> i32 { return 0 }`),
      'wasm32-unknown-unknown',
    )
    assert.deepEqual(
      Analysis.diagnostics(snapshot).map((diagnostic) => diagnostic.code),
      ['SEM0086'],
    )
    assert.strictEqual(snapshot.mir._tag, 'Unavailable')
  }),
)

it.effect('lowers pointer formation, offset, write, and read to explicit pointer operations', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'mir/pointer-slice',
      ascii(`import silk.pointer { Pointer }
pub fn main() -> i32 {
  let mut values = [1, 2, 3]
  let pointer = Pointer.fromMutSlice(&mut values)
  if Pointer.isNullMany(pointer) { return 0 }
  unsafe {
    let many = Intrinsic.pointerRequalify<?[*]mut i32, [*]mut i32>(pointer)
    let third = Pointer.atMut(many, 2)
    Pointer.write(third, 9)
    return Pointer.read(third)
  }
  return 0
}`),
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    const program = Analysis.loweredMir(snapshot)
    assert.deepEqual(yield* MirVerification.verify(program), [])
    const described = program.functions.flatMap((fn) =>
      MirVerification.operations(fn).flatMap((operation) => {
        if (operation._tag === 'PointerFromStorage')
          return [
            `${operation._tag} ${fn.localTypes.at(operation.source.ordinal)?._tag} -> ${Type.encode(operation.type.type)}`,
          ]
        if (operation._tag === 'PointerAt')
          return [
            `${operation._tag} ${fn.localTypes.at(operation.count.ordinal)?._tag} -> ${Type.encode(operation.type.type)}`,
          ]
        if (operation._tag === 'PointerRead')
          return [`${operation._tag} -> ${Type.encode(Mir.semanticType(operation.type))}`]
        if (operation._tag === 'PointerWrite')
          return [`${operation._tag} ${fn.localTypes.at(operation.value.ordinal)?._tag}`]
        return []
      }),
    )
    assert.deepEqual(described.sort(), [
      'PointerAt usize -> *mut i32',
      'PointerFromStorage Slice -> ?[*]mut i32',
      'PointerRead -> i32',
      'PointerWrite i32',
    ])
    const encoded = MirEncoding.encode(program)
    assert.include(encoded, '= pointer-from-storage ')
    assert.include(encoded, '= pointer-at ')
    assert.include(encoded, '= pointer-write ')
    assert.include(encoded, '= pointer-read ')
    assert.strictEqual(MirEncoding.encode(program), encoded)
  }),
)

it.effect('rejects a direct-intrinsic pointer write of a move-only pointee as data', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'mir/pointer-move-only-write',
      ascii(`struct Owned { value: i32 }
pub fn main() -> i32 {
  let mut holder = Owned { value: 1 }
  let pointer = Intrinsic.pointerFromMutRef<Owned>(&mut holder)
  unsafe {
    Intrinsic.pointerWrite<Owned>(pointer, Owned { value: 2 })
  }
  return holder.value
}`),
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    const program = Analysis.loweredMir(snapshot)
    assert.deepEqual(
      (yield* MirVerification.verify(program)).map((violation) => violation.rule),
      ['InvalidPointerOperation'],
    )
  }),
)

it.effect('rejects copying a non-Copy slot element with a conformance diagnostic', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'slot-copy/non-copy',
      ascii(`import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.layout { Layout }
import silk.raw_buffer { RawBuffer }
import silk.slot { Slot }
struct Guard { storage: Allocation }
effect fn store() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let allocation = run Allocator.allocate(Layout.of<[Guard; 1]>())
    |> Effect.provideMut(&mut allocator)
  let payload = run Allocator.allocate(Layout.of<[i32; 1]>())
    |> Effect.provideMut(&mut allocator)
  unsafe {
    let mut buffer = RawBuffer.from<Guard>(move allocation, 1)
    let written = Slot.write(RawBuffer.slot(&mut buffer, 0), Guard { storage: move payload })
    let copied = Slot.copy(RawBuffer.slot(&mut buffer, 0))
    drop copied
    drop buffer
    return 42
  }
  return 0
}
effect fn recover(error: OutOfMemoryError) -> i32 { return 7 }
pub fn main() -> i32 { return run Effect.catchAll(store(), recover) }`),
    )
    assert.deepEqual(
      Analysis.diagnostics(snapshot).map((diagnostic) => diagnostic.code),
      ['SEM0083'],
    )
  }),
)

it.effect('rejects missing normal match results and invented results on transferring arms', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'mir/ordinary-arm-results',
      ascii(`enum Choice { First, Last }
fn inspect(value: Choice) -> i32 {
  return match value { Choice.First => { return 7 } Choice.Last => 9 }
}
pub fn main() -> i32 { return inspect(Choice.Last) }`),
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    const program = Analysis.loweredMir(snapshot)
    assert.deepEqual(yield* MirVerification.verify(program), [])
    const fn = program.functions.find((fn) => fn.id.name === 'inspect') ?? raise('expected inspect')
    const match =
      MirVerification.operations(fn).find((operation) => operation._tag === 'Match') ??
      raise('expected match')
    const transferring = match.arms.at(0) ?? raise('expected transferring arm')
    const completing = match.arms.at(1) ?? raise('expected completing arm')
    const result = completing.selected.execution.result ?? raise('expected normal arm result')
    const replace = (replacement: Mir.MatchOperation): Mir.Module => ({
      ...program,
      functions: program.functions.map((candidate) =>
        candidate !== fn
          ? candidate
          : {
              ...candidate,
              regions: candidate.regions.map((region) =>
                region._tag !== 'OperationRegion'
                  ? region
                  : {
                      ...region,
                      operations: region.operations.map((operation) =>
                        operation === match ? replacement : operation,
                      ),
                    },
              ),
            },
      ),
    })
    const withoutResult: Mir.Execution = {
      entry: completing.selected.execution.entry,
      regions: completing.selected.execution.regions,
    }
    const absent = replace({
      ...match,
      arms: [
        transferring,
        { ...completing, selected: { ...completing.selected, execution: withoutResult } },
      ],
    })
    assert.include(
      (yield* MirVerification.verify(absent)).map((violation) => violation.rule),
      'InvalidMatchJoin',
    )
    const invented = replace({
      ...match,
      arms: [
        {
          ...transferring,
          selected: {
            ...transferring.selected,
            execution: { ...transferring.selected.execution, result },
          },
        },
        completing,
      ],
    })
    assert.include(
      (yield* MirVerification.verify(invented)).map((violation) => violation.rule),
      'InvalidMatchJoin',
    )
    const uninitialized: Mir.LocalId = { _tag: 'Local', ordinal: fn.localTypes.length }
    const missingWrite = replace({
      ...match,
      arms: [
        transferring,
        {
          ...completing,
          selected: {
            ...completing.selected,
            execution: { ...completing.selected.execution, result: uninitialized },
          },
        },
      ],
    })
    assert.include(
      (yield* MirVerification.verify({
        ...missingWrite,
        functions: missingWrite.functions.map((candidate) =>
          candidate.id.name === 'inspect'
            ? { ...candidate, localTypes: [...candidate.localTypes, { _tag: 'i32' }] }
            : candidate,
        ),
      })).map((violation) => violation.rule),
      'InvalidMatchJoin',
    )
  }),
)

it.effect('forms an output slot address without reading or initializing its value', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'mir/output-storage',
      ascii(outputStorageSource),
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    const program = Analysis.loweredMir(snapshot)
    assert.deepEqual(yield* MirVerification.verify(program), [])
    const addressFunctions = program.functions.filter((fn) =>
      MirVerification.operations(fn).some((operation) => operation._tag === 'PointerFromStorage'),
    )
    assert.strictEqual(addressFunctions.length, 1)
    for (const fn of addressFunctions) {
      const operations = MirVerification.operations(fn)
      assert.strictEqual(
        operations.some(
          (operation) =>
            operation._tag === 'SlotTake' ||
            operation._tag === 'SlotCopy' ||
            operation._tag === 'SlotWrite',
        ),
        false,
      )
    }
  }),
)

it.effect(
  'projects external record bytes without loading a nominal record and verifies readonly qualifiers',
  () =>
    Effect.gen(function* () {
      const snapshot = yield* AnalysisFixture.retainingMain(
        'mir/pointer-bytes',
        ascii(`import silk.pointer { Pointer }
extern "C" struct Record {
 first: i32
 second: i32
}
export "C" fn inspect(pointer: ?*const Record) -> usize {
  unsafe { return Pointer.addressMany(Pointer.bytes(pointer)) }
}
pub fn main() -> i32 { let ignored = inspect(Pointer.null<Record>()) return 42 }`),
        'aarch64-apple-darwin',
      )
      assert.deepEqual(Analysis.diagnostics(snapshot), [])
      const program = Analysis.loweredMir(snapshot)
      assert.deepEqual(yield* MirVerification.verify(program), [])
      const operations = program.functions.flatMap(MirVerification.operations)
      assert.strictEqual(operations.filter((op) => op._tag === 'PointerBytes').length, 1)
      assert.strictEqual(operations.filter((op) => op._tag === 'PointerRead').length, 0)
      assert.include(MirEncoding.encode(program), '= pointer-bytes ')
      for (const qualifier of [{ mutable: true }, { pointee: 'i32' as const }]) {
        const forged: Mir.Module = {
          ...program,
          functions: program.functions.map((fn) => ({
            ...fn,
            localTypes: fn.localTypes.map((type, ordinal) =>
              type._tag === 'Pointer' &&
              MirVerification.operations(fn).some(
                (op) => op._tag === 'PointerBytes' && op.destination.ordinal === ordinal,
              )
                ? { ...type, type: Type.pointer({ ...type.type, ...qualifier }) }
                : type,
            ),
          })),
        }
        assert.include(
          (yield* MirVerification.verify(forged)).map((v) => v.rule),
          'InvalidPointerOperation',
        )
      }
    }),
)

it.effect('reads narrow success fields from their stored Effect outcome payload', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'mir/narrow-effect-record',
      ascii(narrowEffectRecord),
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    const artifact = yield* Analysis.codegen(snapshot, { mode: 'debug' })
    const check =
      artifact.ir.match(
        /define[^\n]+@silk_mir_narrow_effect_record_check_effect__[^\n]+\n([\s\S]*?)\n}/,
      )?.[1] ?? raise('expected the check Effect runner')
    // The success member keeps its four-byte struct layout even though the failure member
    // needs two i64 fields. Read the selected fields at their own widths and offsets.
    assert.match(check, /effect_success\w+ = getelementptr i8, ptr %\w+, i32 8/)
    assert.match(check, /@llvm\.memmove[^\n]+%effect_success\w+, i32 4,/)
    // The first field is read at the payload base itself, without a zero-offset projection.
    assert.match(check, /%\w+ = load i16, ptr %\w+, align 2/)
    assert.notMatch(check, /getelementptr i8, ptr %\w+, i32 0\n/)
    assert.match(
      check,
      /%(\w+) = getelementptr i8, ptr %\w+, i32 2\n\s+%\w+ = load i8, ptr %\1, align 1/,
    )
  }),
)
