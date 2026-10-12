import { records } from './support/records.js'
import * as AnalysisFixture from './support/AnalysisFixture.js'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Analysis from '../src/Analysis.js'
import * as Lifetime from '../src/Lifetime.js'
import * as LoanView from '../src/LoanView.js'
import * as MirVerification from '../src/MirVerification.js'
import * as Tir from '../src/Tir.js'
import * as Projections from './support/projections.js'

const ascii = (value: string): Uint8Array =>
  Uint8Array.from(value, (character) => character.charCodeAt(0))

const snapshot = (source: string, target = 'wasm32-unknown-unknown') =>
  AnalysisFixture.retainingMain('mutable-loops/main', ascii(source), target)

it.effect('diagnoses immutable writes and transfers outside loops', () =>
  Effect.gen(function* () {
    const self = yield* snapshot(`pub fn main() -> i32 {
  let value = 1
  value = 2
  break
  return value
}`)
    assert.deepEqual(
      Analysis.diagnostics(self).map((diagnostic) => diagnostic.code),
      ['SEM0035', 'SEM0038'],
    )
  }),
)

it.effect('keeps assignment and equality tokens distinct beside mutable loops', () =>
  Effect.gen(function* () {
    const self = yield* snapshot(
      'pub fn main() -> i32 { let mut value = 0 while value == 0 { value = 42 } return value }',
    )
    const kinds = (Projections.syntaxOf(self, 'mutable-loops/main')?.tokens ?? []).map(
      (token) => token.kind,
    )
    assert.strictEqual(kinds.filter((kind) => kind === 'Equals').length, 2)
    assert.strictEqual(kinds.filter((kind) => kind === 'EqualEqual').length, 1)
    assert.deepEqual(Analysis.diagnostics(self), [])
  }),
)

it.effect('recovers damaged mutable statements without losing following declarations', () =>
  Effect.gen(function* () {
    const self = yield* snapshot(`pub fn damaged() -> i32 {
  let mut value = 0
  value = @
  return value
}
pub fn main() -> i32 { return 42 }`)
    const analysis = Analysis.rootAnalysis(self)
    const syntax = Projections.syntaxOf(self, 'mutable-loops/main')
    assert.isAbove(syntax?.parserDiagnostics.length ?? 0, 0)
    assert.strictEqual(records(analysis).functions.length, 2)
    const name = records(analysis).functions.at(1)?.declaration.name
    assert.strictEqual(name?._tag, 'Present')
    if (name?._tag === 'Present') assert.strictEqual(name.spelling, 'main')
  }),
)

it.effect('publishes immutable facade facts for writes, loops, transfers, and DAG edges', () =>
  Effect.gen(function* () {
    const self = yield* snapshot(`pub fn main() -> i32 {
  let mut value = 0
  while value < 2 { value = value + 1 if value == 1 { continue } }
  return value
}`)
    const bindings = Projections.bindingsOf(self, 'mutable-loops/main')
    const writes = Projections.writesOf(self, 'mutable-loops/main')
    const loops = Projections.loopsOf(self, 'mutable-loops/main')
    const transfers = Projections.transfersOf(self, 'mutable-loops/main')
    const regions = Projections.controlRegionsOf(self)
    const edges = Projections.controlEdgesOf(self)
    const fixedPoints = Projections.ownershipFixedPointsOf(self, 'mutable-loops/main')

    assert.strictEqual(bindings.at(0)?.mutability, 'Mutable')
    assert.strictEqual(writes.length, 1)
    assert.strictEqual(loops.length, 1)
    assert.strictEqual(transfers.at(0)?._tag, 'Continue')
    assert.isAbove(regions.length, 0)
    assert.isAbove(edges.length, 0)
    assert.strictEqual(fixedPoints.at(0)?.compatible, true)
  }),
)

it.effect('rejects incompatible repeating owner states and overlapping replacement', () =>
  Effect.gen(function* () {
    const incompatible = yield* snapshot(`struct Token { value: i32 }
pub fn main() -> i32 {
  let mut token = Token { value: 1 }
  let mut iteration = 0
  while iteration < 1 {
    if iteration == 0 { let old = move token continue }
    iteration = iteration + 1
  }
  return 42
}`)
    assert.include(
      Analysis.diagnostics(incompatible).map((diagnostic) => diagnostic.code),
      'OWN0005',
    )

    const overlapping = yield* snapshot(`struct Token { value: i32 }
pub fn main() -> i32 {
  let mut token = Token { value: 1 }
  token = move token
  return 42
}`)
    assert.include(
      Analysis.diagnostics(overlapping).map((diagnostic) => diagnostic.code),
      'OWN0004',
    )
  }),
)

it.effect('plans lexical cleanup for continue and break without releasing outer owners', () =>
  Effect.gen(function* () {
    const self = yield* snapshot(`struct Token { value: i32 }
pub fn main() -> i32 {
  let outer = Token { value: 42 }
  let mut iteration = 0
  while iteration < 1 {
    let inner = Token { value: 1 }
    if iteration == 0 { continue }
    break
  }
  return outer.value
}`)
    const transfers = Projections.cleanupExitsOf(self, 'mutable-loops/main').filter(
      (exit) => exit.kind === 'Continue' || exit.kind === 'Break',
    )
    assert.deepEqual(
      transfers.map((exit) => ({
        kind: exit.kind,
        releases: exit.releases.map((release) => release.binding.name),
      })),
      [
        { kind: 'Continue', releases: ['inner'] },
        { kind: 'Break', releases: ['inner'] },
      ],
    )
    assert.strictEqual(
      transfers.some((exit) => exit.releases.some((release) => release.binding.name === 'outer')),
      false,
    )
  }),
)

it.effect('does not retain unrelated call borrows in an effect loop', () =>
  Effect.gen(function* () {
    const self = yield* snapshot(`import silk.vector { Vector }
union Attempt<'a> { Retry, Ready { view: &'a i32 } }
struct Profile<'a> { view: &'a i32 }
impl<'a> Copy for Profile<'a> {}
fn current<'a>(value: &'a i32, candidates: &'a [i32], path: &Vector<usize>) -> &'a i32 {
  if Vector<usize>.length(path) == 0 { return value }
  return &candidates[Vector<usize>.get(path, 0)]
}
fn inspect<'a>(profile: Profile<'a>, candidates: &'a [i32], path: &Vector<usize>, retry: bool) -> Attempt<'a> {
  if Vector<usize>.length(path) > 0 {
    return Attempt<'a>.Ready {view: &candidates[Vector<usize>.get(path, 0)]}
  }
  if retry { return Attempt<'a>.Retry }
  return Attempt<'a>.Ready {view: profile.view}
}
effect fn search<'a>(value: &'a i32, candidates: &'a [i32]) -> i32 {
  let mut path = Vector<usize>.make()
  let mut outer = 0
  while outer < 2 {
    outer = outer + 1
    let profile = Profile {view: value}
    let subject = current(value, candidates, &path)
    let attempt = inspect(profile, candidates, &path, outer == 1)
    let view = match move attempt {
      Attempt.Retry => {
        let removed = Vector<usize>.pop(&mut path)
        continue
      }
      Attempt.Ready {view} => view
    }
    if subject.* == 42 && view.* == 42 { return 42 }
  }
  return 0
}
pub fn main() -> i32 {
  let value = 42
  let candidates: [i32; 1] = [41]
  return run search(&value, &candidates)
}`)

    assert.deepEqual(Analysis.diagnostics(self), [])
    const calls = [...self.results.values()].flatMap((result) =>
      result.tir.functions.flatMap((fn) =>
        fn.statements
          .flatMap(Tir.statementExpressions)
          .flatMap(Tir.expressionTree)
          .flatMap((expression) =>
            expression._tag === 'Call' &&
            (expression.target.name === 'current' || expression.target.name === 'inspect')
              ? [
                  {
                    target: expression.target.name,
                    loans: expression.heldLoans.map((loan) => loan.ordinal),
                  },
                ]
              : [],
          ),
      ),
    )
    assert.deepEqual(calls, [
      { target: 'current', loans: [] },
      { target: 'inspect', loans: [] },
    ])
    assert.deepEqual(yield* MirVerification.verify(Analysis.loweredMir(self)), [])
  }),
)

it.effect('retains a runtime borrow after a static call argument', () =>
  Effect.gen(function* () {
    const self = yield* snapshot(`fn choose<'a>(static selected: bool, value: &'a i32) -> &'a i32 {
  static if selected { return value } else { return value }
}
pub fn main() -> i32 {
  let value = 41
  let view = choose(true, &value)
  return view.*
}`)

    assert.deepEqual(Analysis.diagnostics(self), [])
    const main = Analysis.rootAnalysis(self).tir.functions.find(
      (fn) => fn.declaration.name._tag === 'Present' && fn.declaration.name.spelling === 'main',
    )
    assert.isDefined(main)
    if (main === undefined) return
    const body = LoanView.ofTir(main, Analysis.declarationIndex(self), Tir.functionArtifact(main))
    const retained: Array<{
      readonly loans: ReadonlyArray<number>
      readonly arguments: ReadonlyArray<number>
      readonly selected: ReadonlyArray<number>
    }> = []
    LoanView.visitExpressions(body.statements, (expression) => {
      if (expression._tag !== 'Call' || expression.heldLoans?.length !== 1) return
      retained.push({
        loans: expression.heldLoans.map((loan) => loan.ordinal),
        arguments: expression.arguments.map((argument) => argument.id.ordinal),
        selected: LoanView.retainedResultArguments(expression, Lifetime.assumptions([])).map(
          (argument) => argument.id.ordinal,
        ),
      })
    })
    assert.deepEqual(retained, [{ loans: [1], arguments: [1], selected: [1] }])
  }),
)
