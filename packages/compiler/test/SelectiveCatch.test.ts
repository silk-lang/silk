import * as Layer from 'effect/Layer'
import * as AnalysisFixture from './support/AnalysisFixture.js'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Analysis from '../src/Analysis.js'
import * as Tir from '../src/Tir.js'
import * as Mir from '../src/Mir.js'
import * as MirNormalization from '../src/MirNormalization.js'
import * as MirLinearization from '../src/MirLinearization.js'
import * as MirEncoding from '../src/MirEncoding.js'
import * as MirVerification from '../src/MirVerification.js'
import * as RowAlgebra from '../src/RowAlgebra.js'
import * as SourceFile from '../src/SourceFile.js'
import * as SourceResolver from '../src/SourceResolver.js'
import * as Stdlib from '../src/Stdlib.js'
import * as Type from '../src/Type.js'
import * as Projections from './support/projections.js'
import { unreachable } from './support/raise.js'

const ascii = (value: string): Uint8Array =>
  Uint8Array.from(value, (character) => character.charCodeAt(0))

const analyze = (text: string, target?: string) =>
  Analysis.makeRealized({
    root: 'root',
    configuration: AnalysisFixture.configuration('root', target),
  }).pipe(
    Effect.provide(
      SourceResolver.overlay([SourceFile.make('root', ascii(text))]).pipe(
        Layer.provideMerge(SourceResolver.memory(new Map())),
      ),
    ),
  )

const codes = (self: Analysis.Snapshot): ReadonlyArray<string> =>
  Analysis.diagnostics(self).map((diagnostic) => diagnostic.code)

const failureMembers = (row: Type.FailureRow): ReadonlyArray<string> => {
  const concrete = RowAlgebra.concretize(Type.failureRowPolicy(), row)
  return concrete._tag === 'Concrete' ? concrete.row.members.map(Type.encode) : []
}

// Mutate control evidence while retaining authentic opened type and source proof objects.
const replaceMirOperation = (
  module: Mir.Module,
  selected: Mir.Operation,
  replacement: Mir.Operation,
): Mir.Module => {
  const execution = (value: Mir.Execution): Mir.Execution =>
    Mir.mapExecutionOperations(value, (operations) => operations.map(operation))
  const operation = (value: Mir.Operation): Mir.Operation => {
    if (value === selected) return replacement
    switch (value._tag) {
      case 'Match':
        return {
          ...value,
          arms: value.arms.map((arm) => ({
            ...arm,
            ...(arm.guard === undefined
              ? {}
              : { guard: { execution: execution(arm.guard.execution) } }),
            selected: { ...arm.selected, execution: execution(arm.selected.execution) },
          })),
        }
      case 'Conditional':
        return { ...value, taken: execution(value.taken), otherwise: execution(value.otherwise) }
      case 'ShortCircuit':
        return { ...value, right: execution(value.right) }
      case 'DiagnosticScope':
        return { ...value, body: execution(value.body) }
      default:
        return value
    }
  }
  return {
    ...module,
    functions: module.functions.map((fn) => ({
      ...fn,
      regions: execution({ entry: fn.entry, regions: fn.regions }).regions,
    })),
  }
}

/** A two-member failure row plus a handler for each member on its own. */
const preamble = `pub struct A { code: i32 }
pub struct B { code: i32 }
effect fn risky(flag: bool) -> i32 ! A | B {
  if flag { fail A { code: 10 } }
  fail B { code: 20 }
}
effect fn recoverA(problem: A) -> i32 { return problem.code + 1 }
effect fn recoverB(problem: B) -> i32 { return problem.code + 2 }
effect fn recoverRow(problem: A | B) -> i32 { return 99 }
`

it.effect('uses nominal variant coverage when catching a mixed failure row', () =>
  Effect.gen(function* () {
    const self = yield* analyze(`import silk.effect { Effect }
pub union Problem { Detailed { pub code: i32 }, Empty }
pub struct Other { pub value: usize }
effect fn risky(flag: bool) -> i32 ! Problem | Other {
  if flag { fail Problem.Detailed { code: 7 } }
  fail Other { value: 1 }
}
effect fn recoverProblem(error: Problem) -> i32 { drop error return 20 }
effect fn recoverOther(error: Other) -> i32 { return 22 }
effect fn recoverAll(error: Problem | Other) -> i32 { drop error return 42 }
effect fn selective(flag: bool) -> i32 ! Other {
  return run Effect.catch<Problem>(risky(flag), recoverProblem)
}
pub fn main() -> i32 {
  let all = run Effect.catchAll(risky(true), recoverAll)
  let selected = run Effect.catchAll(selective(false), recoverOther)
  return all + selected
}`)
    assert.deepEqual(codes(self), [])
    const module = Analysis.loweredMir(self)
    assert.deepEqual(yield* MirVerification.verify(module), [])
    const matches = module.functions.flatMap((fn) =>
      MirVerification.operations(fn).filter(
        (operation) =>
          operation._tag === 'Match' &&
          operation.members.some((member) => member._tag === 'NominalUnionVariant'),
      ),
    )
    assert.isNotEmpty(matches)
    // The Other payload widens the shared carrier containing Problem's i32 variant tag.
    const artifact = yield* Analysis.codegen(self, { mode: 'release' })
    assert.match(artifact.ir, /trunc i64 %[^\n]+ to i32/)
  }),
)

it.effect('lowers fully handled intrinsic catches in ordinary functions and destructors', () =>
  Effect.gen(function* () {
    const self = yield* analyze(`${preamble}
struct Guard {}
impl Drop for Guard {
  fn drop(self: &mut Guard) -> () {
    let recovered = run Intrinsic.catchFailure<A | B>(risky(false), recoverRow)
    return ()
  }
}
pub fn main() -> i32 {
  let guard = Guard {}
  drop guard
  return run Intrinsic.catchFailure<A | B>(risky(true), recoverRow)
}`)
    assert.deepEqual(codes(self), [])
    const module = Analysis.loweredMir(self)
    const owners = module.functions.filter(
      (fn) => fn.id.module === 'root' && (fn.id.name === 'main' || fn.id.name.startsWith('drop@')),
    )
    assert.strictEqual(owners.length, 2)
    for (const owner of owners)
      assert.isTrue(
        MirVerification.operations(owner).some((operation) => operation._tag === 'CatchEffect'),
      )
    assert.deepEqual(yield* MirVerification.verify(module), [])
  }),
)

it.effect('retains captured callback identities through suspending error mapping', () =>
  Effect.gen(function* () {
    const self = yield* analyze(`${preamble}
import silk.effect { Effect }
struct C { code: i32 }
struct Adjustment { offset: i32 }
fn mapped(error: A | B, adjustment: Adjustment) -> C { return C { code: adjustment.offset } }
effect fn recover(error: C) -> i32 { return error.code }
pub fn main() -> i32 {
  let protected = Effect.suspend(risky(false))
  let changed = Effect.mapError(move protected, mapped(Adjustment { offset: 42 }))
  return run Effect.catchAll(move changed, recover)
}`)
    assert.deepEqual(codes(self), [])
    const module = Analysis.loweredMir(self)
    assert.deepEqual(yield* MirVerification.verify(module), [])
    assert.isTrue(
      module.functions.some((fn) =>
        MirVerification.operations(fn).some(
          (operation) =>
            operation._tag === 'ApplyCallable' &&
            operation.typeArguments.some(
              (argument) =>
                typeof argument !== 'string' && argument._tag === 'CallableIdentityArgument',
            ),
        ),
      ),
    )
    const artifact = yield* Analysis.codegen(self, { mode: 'release' })
    assert.strictEqual(artifact._tag, 'LlvmBitcodeArtifact')
  }),
)

it.effect('admits a union-valued failure only when every member is declared', () =>
  Effect.gen(function* () {
    const source = `import silk.effect { Effect }
struct A {}
struct B {}
effect fn relay(problem: A | B) -> i32 ! A | B { fail move problem }
effect fn recover(problem: A | B) -> i32 { return run Intrinsic.suspendEffect(effect { return 42 }) }
pub fn main() -> i32 { return run Effect.catchAll(relay(A {}), recover) }`
    const accepted = yield* analyze(source)
    assert.deepEqual(codes(accepted), [])
    const module = Analysis.loweredMir(accepted)
    assert.deepEqual(yield* MirVerification.verify(module), [])
    assert.isTrue(
      module.functions.some((fn) =>
        MirVerification.operations(fn).some(
          (operation) => operation._tag === 'PackEffectFailureUnion',
        ),
      ),
    )
    const handlers = module.functions.flatMap((fn) =>
      fn.id.name === 'Effect.catchAll$effect$-1'
        ? (fn.suspension?.regions.filter(
            (region) =>
              region._tag === 'RunSuspendableEffectRegion' &&
              region.runner.declaration?.name === 'recover$effect$-1',
          ) ?? [])
        : [],
    )
    assert.lengthOf(handlers, 2)
    assert.strictEqual(new Set(handlers.map((handler) => handler.point.ordinal)).size, 2)
    const rejectedSource = source.replace('! A | B', '! A')
    const rejected = yield* analyze(rejectedSource)
    const diagnostic =
      Analysis.diagnostics(rejected).find((entry) => entry.code === 'SEM0064') ??
      unreachable('expected the undeclared union member diagnostic')
    const start = rejectedSource.indexOf(' problem }') + 1
    assert.deepEqual(
      [diagnostic.span.start, diagnostic.span.end],
      [start, start + 'problem'.length],
    )
  }),
)

const borrowedMatchSource = (catch_: string): string => `import silk.effect { Effect }
struct Selected { code: i32 }
struct Token { value: i32 }
struct Left {}
struct Right {}
effect fn risky() -> i32 ! Selected { fail Selected { code: 1 } }
effect fn recover(problem: Selected, token: &Token) -> i32 {
  return problem.code + token.value
}
fn choose(choice: Left | Right) -> i32 {
  let token = Token { value: 41 }
  let caught = ${catch_}(risky(), recover(&token))
  let result = match move choice {
    Left {} => run move caught
    Right {} => run move caught
  }
  return result
}
pub fn main() -> i32 { return choose(Left {}) + choose(Right {}) }`

const infallibleRunLoanSource = `import silk.effect { Effect }
import silk.result { Result }
struct Token { value: i32 }
effect fn succeed(value: i32) -> i32 { return value }
fn add(value: i32, token: &Token) -> i32 { return value + token.value }
effect fn userMap(self: once Effect<i32>, onSuccess: once fn(i32) -> i32) -> i32 {
  let completed = run Effect.result(move self)
  return match move completed {
      Result<i32, never>.Success { value } => onSuccess(move value)
      Result<i32, never>.Failure { error } => move error
  }
}
pub fn main() -> i32 {
  let token = Token { value: 22 }
  return run succeed(20) |> userMap(add(&token))
}`

it.effect('delimits selected recovery application and execution without marking propagation', () =>
  Effect.gen(function* () {
    const self = yield* analyze(`import silk.effect { Effect }
${preamble}
effect fn selective(flag: bool) -> i32 ! B {
  return run Effect.catch<A>(risky(flag), recoverA)
}
pub fn main() -> i32 { return run Effect.catchAll(selective(true), recoverB) }`)
    assert.deepEqual(codes(self), [])
    const module = Analysis.loweredMir(self)
    assert.deepEqual(yield* MirVerification.verify(module), [])
    let selectedApplications = 0
    let selectedRuns = 0
    let completedRecoveries = 0
    let unselectedPropagations = 0
    for (const fn of module.functions) {
      const caught = MirVerification.operations(fn).filter(
        (operation) => operation._tag === 'CatchEffect',
      )
      if (caught.length === 0) continue
      const outcomes = new Set(caught.map((operation) => operation.outcome.ordinal))
      const blocks = MirLinearization.linearize(fn)
      for (const block of blocks) {
        for (const outcome of block.recoveryOutcomes ?? [])
          assert.isTrue(outcomes.has(outcome.ordinal))
        const recovering = (block.recoveryOutcomes?.length ?? 0) > 0
        if (block.operations.some((operation) => operation._tag === 'ApplyCallable'))
          assert.isTrue(recovering)
        selectedApplications += block.operations.filter(
          (operation) => recovering && operation._tag === 'ApplyCallable',
        ).length
        selectedRuns += block.operations.filter(
          (operation) => recovering && operation._tag === 'RunEffectValue',
        ).length
        for (const operation of block.operations) {
          if (operation._tag !== 'ReleaseDiagnosticOutcome') continue
          assert.isTrue(recovering)
          assert.isTrue(outcomes.has(operation.outcome.ordinal))
          assert.strictEqual(block.operations.at(-1), operation)
          completedRecoveries += 1
        }
        if (block.terminator._tag === 'PropagateEffectFailure') {
          assert.isFalse(recovering)
          assert.isTrue(outcomes.has(block.terminator.outcome.ordinal))
          assert.notStrictEqual(block.terminator.outcome.ordinal, block.terminator.source.ordinal)
          unselectedPropagations += 1
        }
        if (block.terminator._tag === 'Return') assert.isFalse(recovering)
      }
    }
    assert.strictEqual(selectedApplications, 2)
    assert.strictEqual(selectedRuns, 2)
    assert.strictEqual(completedRecoveries, 2)
    assert.strictEqual(unselectedPropagations, 1)
    assert.include(MirEncoding.encode(module), 'recovery=%')
    const propagation = module.functions
      .flatMap(MirVerification.operations)
      .find((operation) => operation._tag === 'PropagateEffectFailure')
    if (propagation?._tag !== 'PropagateEffectFailure')
      return unreachable('expected unselected failure propagation')
    const wrongPropagationOwner = replaceMirOperation(module, propagation, {
      ...propagation,
      outcome: propagation.source,
    })
    assert.include(
      (yield* MirVerification.verify(wrongPropagationOwner)).map((violation) => violation.rule),
      'InvalidEffectOperation',
    )
    const selectedMatch = module.functions
      .flatMap(MirVerification.operations)
      .find(
        (operation) =>
          operation._tag === 'Match' &&
          operation.arms.some((arm) => arm.selected.execution.recoveryOutcome !== undefined),
      )
    if (selectedMatch?._tag !== 'Match') return unreachable('expected selected recovery match')
    const selected = selectedMatch.arms.find(
      (arm) => arm.selected.execution.recoveryOutcome !== undefined,
    )
    if (selected === undefined) return unreachable('expected selected recovery execution')
    const forged = replaceMirOperation(module, selectedMatch, {
      ...selectedMatch,
      arms: selectedMatch.arms.map((arm) =>
        arm !== selected
          ? arm
          : {
              ...arm,
              selected: {
                ...arm.selected,
                execution: {
                  ...arm.selected.execution,
                  recoveryOutcome: { _tag: 'Local', ordinal: -1 },
                },
              },
            },
      ),
    })
    assert.include(
      (yield* MirVerification.verify(forged)).map((violation) => violation.rule),
      'InvalidMatchJoin',
    )
    let successScope = module
    let forgedSuccess = false
    for (const fn of module.functions) {
      const operations = MirVerification.operations(fn)
      const caught = operations.find((operation) => operation._tag === 'CatchEffect')
      if (caught === undefined) continue
      const conditional = operations.find(
        (operation) =>
          operation._tag === 'Conditional' &&
          operation.condition.ordinal === caught.destination.ordinal,
      )
      if (conditional?._tag !== 'Conditional') continue
      successScope = replaceMirOperation(module, conditional, {
        ...conditional,
        taken: { ...conditional.taken, recoveryOutcome: caught.outcome },
      })
      forgedSuccess = true
      break
    }
    assert.isTrue(forgedSuccess)
    assert.include(
      (yield* MirVerification.verify(successScope)).map((violation) => violation.rule),
      'InvalidEffectOperation',
    )
  }),
)

it.effect('applies ordinary take-once ownership to the direct intrinsic operands', () =>
  Effect.gen(function* () {
    const self = yield* analyze(`struct A {}
struct Payload { value: i32 }
effect fn risky(payload: Payload) -> i32 ! A { fail A {} }
effect fn recoverA(problem: A) -> i32 { return 1 }
effect fn misuse() -> i32 ! A {
  let payload = Payload { value: 1 }
  let candidate = risky(move payload)
  let handled = Intrinsic.catchFailure<A>(move candidate, recoverA)
  let second = run candidate
  drop second
  return run handled
}
pub fn main() -> i32 { return 0 }`)
    assert.deepEqual(codes(self), ['OWN0001'])
  }),
)

it.effect('catch and catchAll produce different result types on the same input', () =>
  Effect.gen(function* () {
    // Same protected Effect, same recovery site, only the operation differs. catchAll erases the
    // whole row, so running it where no failure may escape is accepted.
    const wholeRow = yield* analyze(`import silk.effect { Effect }
${preamble}
pub fn main() -> i32 { return run Effect.catchAll(risky(true), recoverRow) }`)
    assert.deepEqual(codes(wholeRow), [])

    // The selective form keeps B, so the identical run site now has a failure left to handle.
    const selective = yield* analyze(`import silk.effect { Effect }
${preamble}
pub fn main() -> i32 { return run Effect.catch<A>(risky(true), recoverA) }`)
    assert.deepEqual(codes(selective), ['SEM0066'])
  }),
)

it.effect('records the protected, selected, handler, and residual rows as facts', () =>
  Effect.gen(function* () {
    const self = yield* analyze(`import silk.effect { Effect }
${preamble}
effect fn selective(flag: bool) -> i32 ! B {
  return run Effect.catch<A>(risky(flag), recoverA)
}
pub fn main() -> i32 { return run Effect.catchAll(selective(true), recoverB) }`)
    const catches = self.instances.instances.flatMap((instance) =>
      instance.function.statements
        .flatMap(Tir.statementExpressions)
        .flatMap((root) => [...Tir.expressionTree(root)])
        .filter((expression) => expression._tag === 'EffectCatch')
        .map((expression) => Object.freeze({ expression, substitution: instance.substitution }))
        .filter(
          ({ expression, substitution }) =>
            Type.encode(Type.substitute(expression.selected, substitution)) === 'root.A',
        ),
    )
    assert.strictEqual(catches.length, 1)
    const found = catches.at(0)
    const fact = found?.expression
    if (fact?._tag !== 'EffectCatch' || found === undefined) {
      return unreachable('missing EffectCatch fact')
    }
    assert.deepEqual(
      {
        selected: Type.encode(Type.substitute(fact.selected, found.substitution)),
        protectedRow: failureMembers(
          Type.substituteFailureRow(fact.protectedRow, found.substitution),
        ),
        handlerRow: failureMembers(Type.substituteFailureRow(fact.handlerRow, found.substitution)),
        residualRow: failureMembers(
          Type.substituteFailureRow(fact.residualRow, found.substitution),
        ),
      },
      {
        selected: 'root.A',
        protectedRow: ['root.A', 'root.B'],
        handlerRow: [],
        residualRow: ['root.B'],
      },
    )
  }),
)

it.effect('rejects a selector the protected Effect cannot fail with', () =>
  Effect.gen(function* () {
    const self = yield* analyze(`import silk.effect { Effect }
${preamble}
struct C { code: i32 }
effect fn recoverC(problem: C) -> i32 { return 0 }
effect fn selective(flag: bool) -> i32 ! A | B {
  return run Effect.catch<C>(risky(flag), recoverC)
}
pub fn main() -> i32 { return 0 }`)
    assert.deepEqual(codes(self), ['SEM0067'])
  }),
)

it.effect('rejects a handler that does not accept the selected member', () =>
  Effect.gen(function* () {
    const self = yield* analyze(`import silk.effect { Effect }
${preamble}
effect fn selective(flag: bool) -> i32 ! B {
  return run Effect.catch<A>(risky(flag), recoverB)
}
pub fn main() -> i32 { return 0 }`)
    assert.deepEqual(codes(self), ['SEM0100'])
  }),
)

for (const [name, selected, handler] of [
  ['empty selector', 'never', 'recoverNever'],
  ['absent scalar selector', 'i32', 'recoverInteger'],
] as const) {
  it.effect(`rejects a ${name} before availability`, () =>
    Effect.gen(function* () {
      const self = yield* analyze(`import silk.effect { Effect }
${preamble}
effect fn recoverNever(problem: never) -> i32 { return 0 }
effect fn recoverUnion(problem: A | B) -> i32 { return 0 }
effect fn recoverInteger(problem: i32) -> i32 { return problem }
effect fn invalid(flag: bool) -> i32 ! A | B {
  return run Effect.catch<${selected}>(risky(flag), ${handler})
}
pub fn main() -> i32 { return 0 }`)
      assert.include(codes(self), 'SEM0067')
      assert.notInclude(codes(self), 'SEM0098')
    }),
  )
}

it.effect('does not let nominal membership evidence discharge a failure by itself', () =>
  Effect.gen(function* () {
    const self = yield* analyze(`${preamble}
effect fn lie<S, A, E>(self: once Effect<A ! E>) -> A ! Without<E, S>
where S in E {
  return run self
}
pub fn main() -> i32 { return 0 }`)
    assert.include(codes(self), 'SEM0066')
  }),
)

it.effect('does not let subset evidence discharge a requirement by itself', () =>
  Effect.gen(function* () {
    const self = yield* analyze(`struct Clock {}
effect fn lie<?S, A, ?R>(self: once Effect<A ? R>) -> A ? Without<R, S>
where S in R {
  return run self
}
pub fn main() -> i32 { return 0 }`)
    assert.include(codes(self), 'SEM0071')
  }),
)

/**
 * The gap this operation closes was user-visible as a contract mismatch: a helper narrowed to one
 * member could not accept a two-member Effect, and there was no way to spell the narrowing.
 */
it.effect('regression: narrowing a two-member row by contract still reports the mismatch', () =>
  Effect.gen(function* () {
    const source = `import silk.effect { Effect }
${preamble}
effect fn handleA(self: once Effect<i32 ! A>) -> i32 {
  return run Effect.catchAll(move self, recoverA)
}
pub fn main() -> i32 { return run handleA(risky(true)) }`
    const self = yield* Analysis.ofSource('root', ascii(source))
    assert.deepEqual(
      Analysis.diagnostics(self).map((diagnostic) => ({
        code: diagnostic.code,
        source: source.slice(diagnostic.span.start, diagnostic.span.end),
      })),
      [{ code: 'SEM0052', source: 'handleA(risky(true))' }],
    )
  }),
)

it.effect('rejects failure-only loan metadata on every infallible MIR run form', () =>
  Effect.gen(function* () {
    const raw = yield* AnalysisFixture.retainingMain(
      'test/infallible-run-failure-loans',
      ascii(infallibleRunLoanSource),
      'wasm32-unknown-unknown',
      { normalizeMir: false },
    )
    assert.deepEqual(Analysis.diagnostics(raw), [])
    const rawModule = Analysis.loweredMir(raw)
    const provisional = Projections.provisionalMirOf(raw)
    const normalizedModule = MirNormalization.normalize(
      rawModule,
      provisional._tag === 'Unavailable'
        ? unreachable(`expected provisional MIR: ${provisional.error.message}`)
        : provisional.value,
    )
    assert.deepEqual(yield* MirVerification.verify(rawModule), [])
    assert.deepEqual(yield* MirVerification.verify(normalizedModule), [])

    const withFailureMetadata = (
      module: Mir.Module,
      form: 'RunEffect' | 'RunEffectValue' | 'RunStaticEffect',
      includeMetadata: boolean,
    ): Mir.Module => {
      const sourceTag = form === 'RunStaticEffect' ? 'RunStaticEffect' : 'RunEffectValue'
      const owner =
        module.functions.find(
          (fn) =>
            MirVerification.operations(fn).some((operation) => operation._tag === sourceTag) &&
            MirVerification.operations(fn).some((operation) => operation._tag === 'EndLoan'),
        ) ?? unreachable(`expected ${sourceTag} with a caller loan for ${form}`)
      const candidate = MirVerification.operations(owner).find(
        (
          operation,
        ): operation is Extract<
          Mir.Operation,
          {
            readonly _tag: 'RunEffectValue' | 'RunStaticEffect'
          }
        > => operation._tag === sourceTag,
      )
      if (candidate === undefined)
        return unreachable(`expected infallible ${sourceTag} for ${form}`)
      const ending = MirVerification.operations(owner).find(
        (operation): operation is Mir.EndLoanOperation => operation._tag === 'EndLoan',
      )
      if (ending === undefined) return unreachable(`expected ${form} caller loan ending`)
      const replacement: Mir.Operation =
        form === 'RunEffect' && candidate._tag === 'RunEffectValue'
          ? {
              ...candidate,
              _tag: 'RunEffect',
              target: candidate.runner,
              typeArguments: candidate.runnerTypeArguments,
              arguments: Object.freeze([candidate.effect, ...candidate.arguments]),
            }
          : candidate
      return replaceMirOperation(module, candidate, {
        ...replacement,
        ...(includeMetadata ? { failureLoanEnds: Object.freeze([ending]) } : {}),
      })
    }

    for (const [module, form, rule] of [
      [rawModule, 'RunEffect', 'InvalidEffectOperation'],
      [rawModule, 'RunEffectValue', 'InvalidEffectOperation'],
      [normalizedModule, 'RunStaticEffect', 'InvalidNormalization'],
    ] as const) {
      assert.notInclude(
        (yield* MirVerification.verify(withFailureMetadata(module, form, false))).map(
          (violation) => violation.rule,
        ),
        rule,
        `expected a valid infallible ${form} template`,
      )
      assert.include(
        (yield* MirVerification.verify(withFailureMetadata(module, form, true))).map(
          (violation) => violation.rule,
        ),
        rule,
        `${form} must reject unreachable failure-only loan metadata`,
      )
    }
  }),
)

it.effect('rejects uncovered match endings and path-exclusive endings replayed by a loop', () =>
  Effect.gen(function* () {
    const self = yield* analyze(
      borrowedMatchSource('Effect.catch<Selected>'),
      'wasm32-unknown-unknown',
    )
    const mir = Analysis.loweredMir(self)
    const chooseIndex = mir.functions.findIndex((fn) => fn.id.name === 'choose')
    const choose = mir.functions.at(chooseIndex) ?? unreachable('expected choose MIR')
    const replaceChoose = (fn: Mir.MirFunction): Mir.Module =>
      Object.freeze({
        ...mir,
        functions: Object.freeze([
          ...mir.functions.slice(0, chooseIndex),
          fn,
          ...mir.functions.slice(chooseIndex + 1),
        ]),
      })

    let removed = false
    const uncovered: Mir.MirFunction = Object.freeze({
      ...choose,
      regions: Object.freeze(
        choose.regions.map((region) => {
          if (region._tag !== 'OperationRegion') return region
          return Object.freeze({
            ...region,
            operations: Object.freeze(
              region.operations.map((operation) => {
                if (operation._tag !== 'Match') return operation
                return Object.freeze({
                  ...operation,
                  arms: Object.freeze(
                    operation.arms.map((arm, ordinal) => {
                      if (ordinal !== 0) return arm
                      return Object.freeze({
                        ...arm,
                        selected: Object.freeze({
                          ...arm.selected,
                          execution: Mir.mapExecutionOperations(
                            arm.selected.execution,
                            (operations) =>
                              operations.filter((nested) => {
                                if (removed || nested._tag !== 'EndLoan') return true
                                removed = true
                                return false
                              }),
                          ),
                        }),
                      })
                    }),
                  ),
                })
              }),
            ),
          })
        }),
      ),
    })
    assert.strictEqual(removed, true)
    assert.include(
      (yield* MirVerification.verify(replaceChoose(uncovered))).map((violation) => violation.rule),
      'InvalidLoan',
    )

    const operations = MirVerification.operations(choose)
    const beginningCandidate = operations.find((operation) => operation._tag === 'BeginLoan')
    const beginning =
      beginningCandidate?._tag === 'BeginLoan'
        ? beginningCandidate
        : unreachable('expected one loan beginning')
    const endings = operations.filter(
      (
        operation,
      ): operation is Extract<
        Mir.Operation,
        {
          readonly _tag: 'EndLoan'
        }
      > => operation._tag === 'EndLoan',
    )
    const firstEnding = endings.at(0) ?? unreachable('expected first match-arm ending')
    const secondEnding = endings.at(1) ?? unreachable('expected second match-arm ending')
    const initialCandidate = choose.regions.find((region) => region.id.ordinal === 0)
    const initial =
      initialCandidate?._tag === 'OperationRegion'
        ? initialCandidate
        : unreachable('expected choose initial region')
    const loop: Mir.LoopId = Object.freeze({ _tag: 'Loop', ordinal: 0 })
    const region = (ordinal: number): Mir.RegionId => Object.freeze({ _tag: 'Region', ordinal })
    const provenance = initial.outcome.provenance
    const alternating: Mir.MirFunction = Object.freeze({
      ...choose,
      entry: region(0),
      regions: Object.freeze([
        Object.freeze({
          ...initial,
          operations: Object.freeze([...initial.operations, beginning]),
          outcome: Object.freeze({ _tag: 'Forward', target: region(1), provenance }),
        }),
        Object.freeze({
          _tag: 'LoopRegion',
          id: region(1),
          loop,
          condition: region(2),
          conditionValue: Object.freeze({ _tag: 'Local', ordinal: 0 }),
          body: region(3),
          following: region(7),
          provenance,
        }),
        Object.freeze({
          _tag: 'OperationRegion',
          id: region(2),
          ownerLoop: loop,
          operations: Object.freeze([]),
          outcome: Object.freeze({ _tag: 'Yield', provenance }),
        }),
        Object.freeze({
          _tag: 'OperationRegion',
          id: region(3),
          ownerLoop: loop,
          operations: Object.freeze([]),
          outcome: Object.freeze({ _tag: 'Forward', target: region(4), provenance }),
        }),
        Object.freeze({
          _tag: 'ConditionalRegion',
          id: region(4),
          ownerLoop: loop,
          condition: Object.freeze({ _tag: 'Local', ordinal: 0 }),
          taken: region(5),
          otherwise: region(6),
          provenance,
        }),
        Object.freeze({
          _tag: 'CleanupRegion',
          id: region(5),
          ownerLoop: loop,
          releases: Object.freeze([firstEnding]),
          outcome: Object.freeze({ _tag: 'Repeat', loop, provenance }),
        }),
        Object.freeze({
          _tag: 'CleanupRegion',
          id: region(6),
          ownerLoop: loop,
          releases: Object.freeze([secondEnding]),
          outcome: Object.freeze({ _tag: 'Repeat', loop, provenance }),
        }),
        Object.freeze({
          _tag: 'OperationRegion',
          id: region(7),
          operations: Object.freeze([]),
          outcome: Object.freeze({ _tag: 'Trap', reason: 'loop finished', provenance }),
        }),
      ]),
    })
    assert.include(
      (yield* MirVerification.verify(replaceChoose(alternating))).map(
        (violation) => violation.rule,
      ),
      'InvalidLoan',
    )
  }),
)

it.effect('does not let an unreachable loan ending follow failure propagation', () =>
  Effect.gen(function* () {
    const snapshot = yield* analyze(
      `import silk.effect { Effect }
struct Selected { code: i32 }
struct Residual { code: i32 }
struct Token { value: i32 }
struct Left {}
struct Right {}
effect fn risky() -> i32 ! Selected | Residual { fail Residual { code: 20 } }
effect fn recover(problem: Selected, token: &Token) -> i32 {
  return problem.code + token.value
}
effect fn recoverResidual(problem: Residual) -> i32 { return problem.code + 2 }
effect fn choose(choice: Left | Right) -> i32 ! Residual {
  let token = Token { value: 41 }
  let caught = Effect.catch<Selected>(risky(), recover(&token))
  let result = match move choice {
    Left {} => run move caught
    Right {} => run move caught
  }
  return result
}
pub fn main() -> i32 {
  return run Effect.catchAll(choose(Left {}), recoverResidual)
}`,
      'wasm32-unknown-unknown',
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    const module = Analysis.loweredMir(snapshot)
    assert.deepEqual(yield* MirVerification.verify(module), [])
    const chooseIndex = module.functions.findIndex((fn) => fn.id.name === 'choose$effect$-1')
    const choose =
      module.functions.at(chooseIndex) ?? unreachable('expected effectful choose runner')
    const propagationCandidate = module.functions
      .flatMap(MirVerification.operations)
      .find((operation) => operation._tag === 'PropagateEffectFailure')
    const propagation =
      propagationCandidate?._tag === 'PropagateEffectFailure'
        ? propagationCandidate
        : unreachable('expected selective failure propagation')
    let injected = false
    const injectBeforeEnding = (
      nested: ReadonlyArray<Mir.Operation>,
    ): ReadonlyArray<Mir.Operation> =>
      Object.freeze(
        nested.flatMap((operation): ReadonlyArray<Mir.Operation> => {
          if (!injected && operation._tag === 'EndLoan') {
            injected = true
            return [propagation, operation]
          }
          if (operation._tag === 'Conditional')
            return [
              Object.freeze({
                ...operation,
                taken: Mir.mapExecutionOperations(operation.taken, injectBeforeEnding),
                otherwise: Mir.mapExecutionOperations(operation.otherwise, injectBeforeEnding),
              }),
            ]
          if (operation._tag === 'ShortCircuit')
            return [
              Object.freeze({
                ...operation,
                right: Mir.mapExecutionOperations(operation.right, injectBeforeEnding),
              }),
            ]
          if (operation._tag === 'Match')
            return [
              Object.freeze({
                ...operation,
                arms: Object.freeze(
                  operation.arms.map((arm) =>
                    Object.freeze({
                      ...arm,
                      ...(arm.guard === undefined
                        ? {}
                        : {
                            guard: Object.freeze({
                              ...arm.guard,
                              execution: Mir.mapExecutionOperations(
                                arm.guard.execution,
                                injectBeforeEnding,
                              ),
                            }),
                          }),
                      selected: Object.freeze({
                        ...arm.selected,
                        execution: Mir.mapExecutionOperations(
                          arm.selected.execution,
                          injectBeforeEnding,
                        ),
                      }),
                    }),
                  ),
                ),
              }),
            ]
          return [operation]
        }),
      )
    const forgedChoose: Mir.MirFunction = Object.freeze({
      ...choose,
      regions: Object.freeze(
        choose.regions.map((region): Mir.Region =>
          region._tag === 'OperationRegion'
            ? Object.freeze({
                ...region,
                operations: injectBeforeEnding(region.operations),
              })
            : region,
        ),
      ),
    })
    assert.strictEqual(injected, true)
    const replaceChoose = (replacement: Mir.MirFunction): Mir.Module =>
      Object.freeze({
        ...module,
        functions: Object.freeze([
          ...module.functions.slice(0, chooseIndex),
          replacement,
          ...module.functions.slice(chooseIndex + 1),
        ]),
      })
    assert.include(
      (yield* MirVerification.verify(replaceChoose(forgedChoose))).map(
        (violation) => violation.rule,
      ),
      'InvalidLoan',
    )
  }),
)

it('catch and catchAll no longer share a doc comment', () => {
  const bytes = Stdlib.sources.get('silk/effect')
  if (bytes === undefined) unreachable('silk/effect source is missing')
  const effects = new TextDecoder().decode(bytes)
  const docOf = (name: string): string => {
    const declaration = effects.indexOf(`pub effect fn ${name}<`)
    if (declaration < 0) unreachable(`${name} is missing from silk/effect`)
    const before = effects.slice(0, declaration).split('\n')
    const lines: Array<string> = []
    for (let index = before.length - 2; index >= 0; index -= 1) {
      const line = before[index] ?? ''
      if (!line.trimStart().startsWith('///')) break
      lines.unshift(line)
    }
    return lines.join('\n')
  }
  const catchDoc = docOf('catch')
  const catchAllDoc = docOf('catchAll')
  assert.notStrictEqual(catchDoc, '')
  assert.notStrictEqual(catchAllDoc, '')
  assert.notStrictEqual(catchDoc, catchAllDoc)
})
