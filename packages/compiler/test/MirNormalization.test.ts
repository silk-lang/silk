import * as AnalysisFixture from './support/AnalysisFixture.js'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Json from './support/Json.js'
import * as Analysis from '../src/Analysis.js'
import type * as Mir from '../src/Mir.js'
import * as MirEncoding from '../src/MirEncoding.js'
import * as MirNormalization from '../src/MirNormalization.js'
import * as MirVerification from '../src/MirVerification.js'
import * as ProvisionalMir from '../src/ProvisionalMir.js'
import * as Projections from './support/projections.js'
import { unreachable } from './support/raise.js'

const encoder = new TextEncoder()
const source = `import silk.effect { Effect }
import silk.result { Result }
effect fn succeed(value: i32) -> i32 { return value }
fn addOne(value: i32) -> i32 { return value + 1 }
effect fn userMap(self: once Effect<i32>, onSuccess: once fn(i32) -> i32) -> i32 {
  let completed = run Effect.result(move self)
  return match move completed {
      Result<i32, never>.Success { value } => onSuccess(move value)
      Result<i32, never>.Failure { error } => move error
  }
}
pub fn main() -> i32 { return run succeed(41) |> userMap(addOne) }`

const snapshot = (normalizeMir: boolean) =>
  AnalysisFixture.retainingMain(
    'test/mir-normalization',
    encoder.encode(source),
    'wasm32-unknown-unknown',
    { normalizeMir },
  )

const mainOperations = (program: Mir.Module): ReadonlyArray<Mir.Operation> => {
  const main = program.functions.find((fn) => fn.id.name === 'main')
  return main === undefined ? Object.freeze([]) : MirVerification.operations(main)
}

const allOperations = (program: Mir.Module): ReadonlyArray<Mir.Operation> =>
  program.functions.flatMap(MirVerification.operations)

const provisionalOf = (self: Analysis.Snapshot): ProvisionalMir.Module => {
  const provisional = Projections.provisionalMirOf(self)
  if (provisional._tag === 'Unavailable') throw provisional.error
  return provisional.value
}

it.effect(
  'attributes Effect uses to operations and outcomes without counting repeated references',
  () =>
    Effect.gen(function* () {
      const raw = yield* AnalysisFixture.retainingMain(
        'test/mir-normalization-use-attribution',
        encoder.encode(`effect fn succeed(value: i32) -> i32 { return value }
pub fn main() -> i32 {
  return run succeed(42)
}`),
        'wasm32-unknown-unknown',
        { normalizeMir: false },
      )
      assert.deepEqual(Analysis.diagnostics(raw), [])
      const program = Analysis.loweredMir(raw)
      const provisional = provisionalOf(raw)
      const main = program.functions.find((fn) => fn.id.name === 'main') ?? unreachable()
      const region =
        main.regions.find((candidate) => candidate._tag === 'OperationRegion') ?? unreachable()
      const call =
        region.operations.find((operation) => operation._tag === 'Call') ??
        unreachable(MirEncoding.encode(program))
      const constructor = program.functions.find((fn) => fn.id === call.target) ?? unreachable()
      const definition =
        MirVerification.operations(constructor).find(
          (operation) => operation._tag === 'MakeEffect',
        ) ?? unreachable()
      // Narrowing constructor candidates must retain module identity, static specialization,
      // and first-match semantics when more than one instance shares a declaration.
      const normalizeWithCandidates = (candidates: ReadonlyArray<Mir.MirFunction>) =>
        MirNormalization.normalize(
          { ...program, functions: [...candidates, ...program.functions] },
          provisional,
        ).normalization?.filter(
          (verdict) => verdict.function === main.id && verdict.local === call.destination,
        ) ?? []
      const complexConstructor = { ...constructor, regions: [] }
      const unrelatedCandidates: ReadonlyArray<Mir.MirFunction> = [
        {
          ...complexConstructor,
          id: { ...constructor.id, module: 'test/unrelated-module' },
        },
        {
          ...complexConstructor,
          instance: {
            ...constructor.instance,
            staticArguments: [{ _tag: 'BooleanValue', value: true }],
          },
        },
      ]
      assert.isTrue(
        normalizeWithCandidates(unrelatedCandidates).some(
          (verdict) => verdict._tag === 'Normalized' && verdict.kind === 'FoldedConstructor',
        ),
      )
      assert.isTrue(
        normalizeWithCandidates([complexConstructor]).some(
          (verdict) => verdict._tag === 'Rejected' && verdict.reason === 'ComplexConstructor',
        ),
      )
      const construction = { ...definition, destination: call.destination }
      const run =
        region.operations.find((operation) => operation._tag === 'RunEffectValue') ??
        unreachable(MirEncoding.encode(program))
      const verdicts = (regions: ReadonlyArray<Mir.Region>) =>
        MirNormalization.normalize(
          {
            ...program,
            functions: program.functions.map((fn) => (fn === main ? { ...fn, regions } : fn)),
          },
          provisional,
        ).normalization?.filter((verdict) => verdict.function === main.id) ?? []

      // Repeated references inside one object graph are one use, including cycles and metadata.
      const references: Array<unknown> = [construction.destination, construction.destination]
      references.push(references)
      const repeatedReferences = { ...run, references }
      const singleUse = verdicts([{ ...region, operations: [construction, repeatedReferences] }])
      assert.isTrue(
        singleUse.some(
          (verdict) => verdict._tag === 'Normalized' && verdict.kind === 'DirectStaticRun',
        ),
      )

      // Two appearances of the same operation object remain two separate uses.
      const reused = verdicts([{ ...region, operations: [construction, run, run] }])
      assert.isTrue(
        reused.some((verdict) => verdict._tag === 'Rejected' && verdict.reason === 'EffectReused'),
      )

      const escaped = verdicts([
        {
          ...region,
          operations: [construction],
          outcome: { _tag: 'Return', value: construction.destination, provenance: run.provenance },
        },
      ])
      assert.isTrue(
        escaped.some(
          (verdict) => verdict._tag === 'Rejected' && verdict.reason === 'EffectEscapes',
        ),
      )

      const cleanup = verdicts([
        {
          ...region,
          operations: [construction],
          outcome: { _tag: 'Complete', provenance: run.provenance },
        },
        {
          _tag: 'CleanupRegion',
          id: { _tag: 'Region', ordinal: 1000 },
          releases: [],
          outcome: { _tag: 'Return', value: construction.destination, provenance: run.provenance },
        },
      ])
      assert.isTrue(
        cleanup.some(
          (verdict) => verdict._tag === 'Rejected' && verdict.reason === 'CrossRegionUse',
        ),
      )
    }),
)

it.effect('retains concrete suspendable runs without a global suspension mode', () =>
  Effect.gen(function* () {
    const raw = yield* AnalysisFixture.retainingMain(
      'test/mir-normalization-suspendable',
      encoder.encode(`import silk.effect { Effect }
effect fn delayed(value: i32) -> i32 {
  return run Effect.suspend(effect { return value })
}
pub fn main() -> i32 {
  return run delayed(42)
}`),
      'wasm32-unknown-unknown',
      { normalizeMir: false },
    )
    assert.deepEqual(Analysis.diagnostics(raw), [])
    const program = Analysis.loweredMir(raw)
    const provisional = provisionalOf(raw)
    const rejected = MirNormalization.normalize(program, provisional)
    assert.strictEqual(MirEncoding.encode(rejected).includes('run-static-effect'), false)
    assert.isTrue(
      (rejected.normalization ?? []).some(
        (verdict) => verdict._tag === 'Rejected' && verdict.reason === 'SuspendableRunner',
      ),
    )
    assert.include(ProvisionalMir.encode(provisional), 'relay=existing')
    assert.deepEqual(yield* MirVerification.verify(rejected), [])
  }),
)

it.effect('distinguishes an unknown summary from missing exact execution facts', () =>
  Effect.gen(function* () {
    const raw = yield* snapshot(false)
    const program = Analysis.loweredMir(raw)
    const provisional = provisionalOf(raw)
    const unknownMain: ProvisionalMir.Module = Object.freeze({
      ...provisional,
      executions: Object.freeze(
        provisional.executions.map((execution) =>
          execution.key._tag === 'InstanceExecution' &&
          execution.key.instance.declaration.name === 'main'
            ? Object.freeze({ ...execution, classification: 'Unknown' as const })
            : execution,
        ),
      ),
    })
    const knownRuns = MirNormalization.normalize(program, unknownMain)
    assert.isTrue(
      mainOperations(knownRuns).some((operation) => operation._tag === 'RunStaticEffect'),
    )
    const missingMain: ProvisionalMir.Module = {
      ...provisional,
      executions: provisional.executions.filter(
        (execution) =>
          execution.key._tag !== 'InstanceExecution' ||
          execution.key.instance.declaration.name !== 'main',
      ),
    }
    const retained = MirNormalization.normalize(program, missingMain)
    assert.isFalse(
      mainOperations(retained).some((operation) => operation._tag === 'RunStaticEffect'),
    )
    assert.isTrue(
      (retained.normalization ?? []).some(
        (verdict) => verdict._tag === 'Rejected' && verdict.reason === 'SuspensionUnknown',
      ),
    )
    assert.isTrue(
      retained.functions
        .filter((fn) => fn.id.name !== 'main')
        .flatMap(MirVerification.operations)
        .some((operation) => operation._tag === 'RunStaticEffect'),
      MirEncoding.encode(retained),
    )
  }),
)

it.effect('retains suspendable catch control', () =>
  Effect.gen(function* () {
    const caught = yield* AnalysisFixture.retainingMain(
      'test/mir-normalization-catch-suspendable',
      encoder.encode(`import silk.effect { Effect }
struct Problem {}
effect fn seed(value: i32) -> i32 ! Problem {
  return run Effect.suspend(effect { return value })
}
effect fn recover(problem: Problem) -> i32 { return 0 }
pub fn main() -> i32 {
  return run seed(42) |> Effect.catchAll(recover)
}`),
      'wasm32-unknown-unknown',
    )
    assert.deepEqual(Analysis.diagnostics(caught), [])
    const caughtProgram = Analysis.loweredMir(caught)
    assert.isTrue(
      allOperations(caughtProgram).some((operation) => operation._tag === 'CatchEffect'),
      MirEncoding.encode(caughtProgram),
    )
    assert.isFalse(allOperations(caughtProgram).some((operation) => operation._tag === 'Allocate'))
    for (const program of [caughtProgram]) {
      assert.isTrue(
        (program.normalization ?? []).some(
          (verdict) => verdict._tag === 'Rejected' && verdict.reason === 'SuspendableRunner',
        ),
        MirEncoding.encode(program),
      )
    }
  }),
)

it.effect('retains a provider-specialized suspendable runner', () =>
  Effect.gen(function* () {
    const self = yield* AnalysisFixture.retainingMain(
      'test/mir-normalization-provided-suspendable',
      encoder.encode(`import silk.effect { Effect }
service Value {
  effect fn get() -> i32 ? &Value
}
struct SuspendedValue { value: i32 }
effect fn get(self: &SuspendedValue) -> i32 {
  return run Effect.suspend(effect { return self.value })
}
impl Value for SuspendedValue { get: SuspendedValue.get }
effect fn read() -> i32 ? &Value { return run Value.get() }
pub fn main() -> i32 {
  let provider = SuspendedValue { value: 42 }
  return run Effect.provide(read(), &provider)
}`),
      'wasm32-unknown-unknown',
    )
    assert.deepEqual(Analysis.diagnostics(self), [])
    const program = Analysis.loweredMir(self)
    assert.isTrue(
      allOperations(program).some(
        (operation) =>
          (operation._tag === 'RunEffectValue' || operation._tag === 'CatchEffect') &&
          operation.runner.name.includes('$provided$'),
      ),
      MirEncoding.encode(program),
    )
    assert.isTrue(
      (program.normalization ?? []).some(
        (verdict) => verdict._tag === 'Rejected' && verdict.reason === 'SuspendableRunner',
      ),
      MirEncoding.encode(program),
    )
  }),
)

it.effect('keeps affine captures materialized and ownership explicit', () =>
  Effect.gen(function* () {
    const raw = yield* snapshot(false)
    assert.deepEqual(Analysis.diagnostics(raw), [])
    const rawProgram = Analysis.loweredMir(raw)
    const affineProgram: Mir.Module = Object.freeze({
      ...rawProgram,
      functions: Object.freeze(
        rawProgram.functions.map((fn) =>
          Object.freeze({
            ...fn,
            regions: Object.freeze(
              fn.regions.map((region) => {
                if (region._tag !== 'OperationRegion') return region
                return Object.freeze({
                  ...region,
                  operations: Object.freeze(
                    region.operations.map((operation): Mir.Operation => {
                      if (operation._tag !== 'MakeEffect') return operation
                      return Object.freeze({
                        ...operation,
                        captures: Object.freeze(
                          operation.captures.map((capture) =>
                            Object.freeze({ ...capture, access: 'Take' }),
                          ),
                        ),
                      })
                    }),
                  ),
                })
              }),
            ),
          }),
        ),
      ),
    })
    const program = MirNormalization.normalize(affineProgram, provisionalOf(raw))
    assert.isTrue(
      (program.normalization ?? []).some(
        (verdict) => verdict._tag === 'Rejected' && verdict.reason === 'AffineCapture',
      ),
    )
    assert.isFalse(
      mainOperations(program).some((operation) => operation._tag === 'RunStaticEffect'),
    )
  }),
)

it.effect('reports complex constructors and reusable Effects without partial static dispatch', () =>
  Effect.gen(function* () {
    const complex = yield* AnalysisFixture.retainingMain(
      'test/mir-normalization-complex',
      encoder.encode(`fn complex(value: i32) -> Effect<'static; i32> {
  let adjusted = value + 1
  return effect { return adjusted }
}
pub fn main() -> i32 { return run complex(41) }`),
      'wasm32-unknown-unknown',
    )
    const reused = yield* AnalysisFixture.retainingMain(
      'test/mir-normalization-reused',
      encoder.encode(`effect fn succeed() -> i32 { return 21 }
pub fn main() -> i32 {
  let pending = succeed()
  let first = run pending
  let second = run pending
  return first + second
}`),
      'wasm32-unknown-unknown',
    )
    assert.deepEqual(Analysis.diagnostics(complex), [])
    assert.deepEqual(Analysis.diagnostics(reused), [])
    assert.isTrue(
      Analysis.effectNormalizationOf(complex).some(
        (verdict) => verdict._tag === 'Rejected' && verdict.reason === 'ComplexConstructor',
      ),
    )
    assert.isTrue(
      Analysis.effectNormalizationOf(reused).some(
        (verdict) => verdict._tag === 'Rejected' && verdict.reason === 'EffectEscapes',
      ),
      Json.stringify(Analysis.effectNormalizationOf(reused)),
    )
    assert.isFalse(
      mainOperations(Analysis.loweredMir(complex)).some(
        (operation) => operation._tag === 'RunStaticEffect',
      ),
    )
    assert.isFalse(
      mainOperations(Analysis.loweredMir(reused)).some(
        (operation) => operation._tag === 'RunStaticEffect',
      ),
    )
  }),
)

it.effect('verifier rejects dangling normalization identities', () =>
  Effect.gen(function* () {
    const normalized = yield* snapshot(true)
    const program = Analysis.loweredMir(normalized)
    const verdict = program.normalization?.at(0)
    assert.isDefined(verdict)
    if (verdict === undefined) return
    const malformed: Mir.Module = Object.freeze({
      ...program,
      normalization: Object.freeze([
        Object.freeze({
          ...verdict,
          region: Object.freeze({ _tag: 'Region', ordinal: 999 }),
        }),
      ]),
    })
    assert.isTrue(
      (yield* MirVerification.verify(malformed)).some(
        (violation) => violation.rule === 'InvalidNormalization',
      ),
    )

    const main = program.functions.find((fn) => fn.id.name === 'main')
    const mainRegion = main?.regions.find(
      (region): region is Mir.OperationRegion => region._tag === 'OperationRegion',
    )
    const run = mainRegion?.operations.find(
      (
        operation,
      ): operation is Extract<
        Mir.Operation,
        {
          readonly _tag: 'RunStaticEffect'
        }
      > => operation._tag === 'RunStaticEffect',
    )
    assert.isDefined(main)
    assert.isDefined(mainRegion)
    assert.isDefined(run)
    if (main === undefined || mainRegion === undefined || run === undefined) return
    const inconsistent: Mir.Module = Object.freeze({
      ...program,
      functions: Object.freeze(
        program.functions.map((fn) => {
          if (fn !== main) return fn
          return Object.freeze({
            ...fn,
            regions: Object.freeze(
              fn.regions.map((region) => {
                if (region !== mainRegion) return region
                return Object.freeze({
                  ...region,
                  operations: Object.freeze(
                    region.operations.map((operation) => {
                      if (operation !== run) return operation
                      return Object.freeze({ ...run, captures: Object.freeze([]) })
                    }),
                  ),
                })
              }),
            ),
          })
        }),
      ),
    })
    assert.isTrue(
      (yield* MirVerification.verify(inconsistent)).some(
        (violation) => violation.rule === 'InvalidNormalization',
      ),
    )
  }),
)

it.effect('retains checked invocation operands when folding an Effect constructor', () =>
  Effect.gen(function* () {
    const raw = yield* AnalysisFixture.retainingMain(
      'test/mir-normalization-invocation-use',
      encoder.encode(`effect fn construct(value: i32) -> i32 { return value }
pub fn main() -> i32 {
  return run Intrinsic.catchFailure(effect { fail 42 }, construct)
}`),
      'wasm32-unknown-unknown',
      { normalizeMir: false },
    )
    assert.deepStrictEqual(Analysis.diagnostics(raw), [])
    const program = Analysis.loweredMir(raw)
    const main = program.functions.find((fn) => fn.id.name === 'main') ?? unreachable()
    const invocation =
      MirVerification.operations(main).find(
        (operation) =>
          (operation._tag === 'Call' || operation._tag === 'ApplyCallable') &&
          operation.invocationUse !== undefined,
      ) ?? unreachable('expected genuine marked invocation')
    if (invocation._tag !== 'Call' && invocation._tag !== 'ApplyCallable')
      return assert.fail('expected checked actual invocation')
    if (
      invocation._tag !== 'ApplyCallable' ||
      invocation.callable === undefined ||
      invocation.target?._tag !== 'DeclarationCallableTarget'
    )
      return assert.fail('expected actual recovery handler declaration and callable')
    const descriptor = main.localTypes.at(invocation.callable.ordinal)
    assert.strictEqual(descriptor?._tag, 'CallableValue')
    if (descriptor?._tag !== 'CallableValue')
      return assert.fail('expected actual callable descriptor')
    assert.deepStrictEqual(invocation.target, descriptor.target)
    assert.strictEqual(
      invocation.target.declaration.module,
      'test/mir-normalization-invocation-use',
    )
    assert.strictEqual(invocation.target.declaration.name, 'construct')
    const target = invocation.target.declaration
    const constructor =
      program.functions.find(
        (fn) => fn.id.module === target.module && fn.id.name === target.name,
      ) ?? unreachable('expected actual source constructor body')
    assert.strictEqual(constructor.parameterCount, 1)
    assert.strictEqual(constructor.localTypes.at(0)?._tag, 'i32')
    const original =
      MirVerification.operations(constructor).find(
        (operation) => operation._tag === 'MakeEffect',
      ) ?? unreachable('expected actual constructor definition')
    if (original._tag !== 'MakeEffect') return assert.fail('expected actual Effect construction')
    const proof = invocation.invocationUse ?? unreachable('expected actual input-use record')
    assert.strictEqual(proof.kind, 'Recovery')
    assert.strictEqual(proof.inputs.at(0)?.parameter, 0)
    assert.strictEqual(proof.inputs.at(0)?.argument.ordinal, invocation.arguments.at(0)?.ordinal)
    assert.strictEqual(invocation.arguments.length, 1)
    const actualInput = invocation.arguments.at(0) ?? unreachable('expected source operand')
    assert.strictEqual(proof.result.ordinal, invocation.destination.ordinal)
    const normalized = MirNormalization.normalize(program, provisionalOf(raw))
    assert.isTrue(
      (normalized.normalization ?? []).some(
        (verdict) =>
          verdict.function === main.id &&
          verdict.local.ordinal === invocation.destination.ordinal &&
          verdict._tag === 'Normalized' &&
          verdict.kind === 'FoldedConstructor',
      ),
      'expected selected-source constructor fold',
    )
    const normalizedCaller =
      normalized.functions.find((fn) => fn.id === main.id) ??
      unreachable('expected normalized caller')
    const folded =
      MirVerification.operations(normalizedCaller).find(
        (operation) => operation._tag === 'MakeEffect' && operation.invocationSource === invocation,
      ) ?? unreachable('expected selected-source constructor fold')
    if (folded._tag !== 'MakeEffect') return assert.fail('expected folded checked constructor')
    assert.strictEqual(folded.invocationSource, invocation)
    assert.strictEqual(folded.destination.ordinal, invocation.destination.ordinal)
    assert.deepStrictEqual(folded.runner, original.runner)
    assert.deepStrictEqual(folded.runnerTypeArguments, original.runnerTypeArguments)
    assert.strictEqual(folded.captures.length, 1)
    const capture = folded.captures.at(0) ?? unreachable('expected actual scalar capture')
    assert.strictEqual(capture.source.ordinal, actualInput.ordinal)
    assert.strictEqual(capture.access, 'Copy')
    assert.isTrue(MirNormalization.invocationConstructionValid(normalized, folded))
    assert.isTrue(
      (normalized.normalization ?? []).some(
        (verdict) =>
          verdict.function === main.id &&
          verdict.local.ordinal === folded.destination.ordinal &&
          verdict._tag === 'Rejected' &&
          verdict.reason === 'InvocationUse',
      ),
    )
    assert.isFalse(
      (normalized.normalization ?? []).some(
        (verdict) =>
          verdict.function === main.id &&
          verdict.local.ordinal === folded.destination.ordinal &&
          verdict._tag === 'Normalized' &&
          verdict.kind === 'DirectStaticRun',
      ),
    )
    // Select a different real caller local. The positive graph and every packet/identity
    // stay untouched; only the original operand or its physical capture is altered.
    const other = invocation.destination
    assert.notStrictEqual(other.ordinal, actualInput.ordinal)
    const wrongInvocation = { ...invocation, arguments: [other] }
    assert.isFalse(
      MirNormalization.invocationConstructionValid(normalized, {
        ...folded,
        invocationSource: wrongInvocation,
      }),
    )
    assert.isFalse(
      MirNormalization.invocationConstructionValid(normalized, {
        ...folded,
        captures: [{ ...capture, source: other }],
      }),
    )
  }),
)
