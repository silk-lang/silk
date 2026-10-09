import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Analysis from '../src/Analysis.js'
import { unreachable } from './support/raise.js'

/**
 * Aggregate receiver access for Effect representations stored in nominal fields.
 *
 * These receiver rules remain the ownership admission boundary after proven nominal realizations
 * cross the layout fence.
 */

const ascii = (value: string): Uint8Array =>
  Uint8Array.from(value, (character) => character.charCodeAt(0))

const analyzed = Effect.fnUntraced(function* (name: string, source: string) {
  return yield* Analysis.ofSource(name, ascii(source))
})

const codesOf = (snapshot: Analysis.FrontendSnapshot): ReadonlyArray<string> =>
  Analysis.diagnostics(snapshot).map((diagnostic) => diagnostic.code)

const declarations = `struct Shared<'env, F: Effect<'env; i32>> { operation: F }
struct Exclusive<'env, F: mut Effect<'env; i32>> { operation: F }
struct Once<'env, F: once Effect<'env; i32>> { operation: F }
`

it.effect('runs a shared stored Effect through a shared aggregate borrow', () =>
  Effect.gen(function* () {
    const snapshot = yield* analyzed(
      'stored-effect-ownership/shared-through-shared',
      `${declarations}fn runShared<'env, F: Effect<'env; i32>>(value: &Shared<'env, F>) -> i32 {
  return run value.operation
}
pub fn main() -> i32 { return 0 }`,
    )

    assert.notInclude(codesOf(snapshot), 'OWN0015')
  }),
)

it.effect('rejects an exclusive stored Effect through a shared aggregate borrow', () =>
  Effect.gen(function* () {
    const snapshot = yield* analyzed(
      'stored-effect-ownership/exclusive-through-shared',
      `${declarations}fn runExclusive<'env, F: mut Effect<'env; i32>>(value: &Exclusive<'env, F>) -> i32 {
  return run value.operation
}
pub fn main() -> i32 { return 0 }`,
    )
    const diagnostic =
      Analysis.diagnostics(snapshot).find((candidate) => candidate.code === 'OWN0015') ??
      unreachable('expected a stored-Effect run access rejection')

    assert.strictEqual(diagnostic.reason._tag, 'StoredEffectRunAccess')
    if (diagnostic.reason._tag !== 'StoredEffectRunAccess') return
    assert.strictEqual(diagnostic.reason.receiver, 'Shared')
    assert.strictEqual(diagnostic.reason.required, 'Exclusive')
    assert.strictEqual(diagnostic.reason.field, '#0')
  }),
)

it.effect('runs an exclusive stored Effect through an exclusive aggregate borrow', () =>
  Effect.gen(function* () {
    const snapshot = yield* analyzed(
      'stored-effect-ownership/exclusive-through-exclusive',
      `${declarations}fn runExclusive<'env, F: mut Effect<'env; i32>>(value: &mut Exclusive<'env, F>) -> i32 {
  return run value.operation
}
pub fn main() -> i32 { return 0 }`,
    )

    assert.notInclude(codesOf(snapshot), 'OWN0015')
  }),
)

it.effect('rejects a consuming stored Effect through shared and exclusive aggregate borrows', () =>
  Effect.gen(function* () {
    const shared = yield* analyzed(
      'stored-effect-ownership/consuming-through-shared',
      `${declarations}fn runOnce<'env, F: once Effect<'env; i32>>(value: &Once<'env, F>) -> i32 {
  return run value.operation
}
pub fn main() -> i32 { return 0 }`,
    )
    const exclusive = yield* analyzed(
      'stored-effect-ownership/consuming-through-exclusive',
      `${declarations}fn runOnce<'env, F: once Effect<'env; i32>>(value: &mut Once<'env, F>) -> i32 {
  return run value.operation
}
pub fn main() -> i32 { return 0 }`,
    )

    assert.deepEqual(
      [shared, exclusive].map((snapshot) => {
        const diagnostic = Analysis.diagnostics(snapshot).find(
          (candidate) => candidate.code === 'OWN0015',
        )
        return diagnostic?.reason._tag === 'StoredEffectRunAccess'
          ? [diagnostic.reason.receiver, diagnostic.reason.required]
          : undefined
      }),
      [
        ['Shared', 'Take'],
        ['Exclusive', 'Take'],
      ],
    )
  }),
)

it.effect('admits a consuming stored Effect only through whole-owner aggregate access', () =>
  Effect.gen(function* () {
    const snapshot = yield* analyzed(
      'stored-effect-ownership/consuming-through-owner',
      `${declarations}fn runOnce<'env, F: once Effect<'env; i32>>(value: Once<'env, F>) -> i32 {
  return run value.operation
}
pub fn main() -> i32 { return 0 }`,
    )

    assert.notInclude(codesOf(snapshot), 'OWN0015')
  }),
)

it.effect('consumes the whole aggregate when its take-once Effect runs', () =>
  Effect.gen(function* () {
    const snapshot = yield* analyzed(
      'stored-effect-ownership/whole-owner-move',
      `${declarations}fn runTwice<'env, F: once Effect<'env; i32>>(value: Once<'env, F>) -> i32 {
  let first = run value.operation
  return first + run value.operation
}
pub fn main() -> i32 { return 0 }`,
    )

    assert.include(codesOf(snapshot), 'OWN0001')
    const facts =
      snapshot.ownership.get('stored-effect-ownership/whole-owner-move') ??
      unreachable('expected ownership facts')
    const runTwice = facts.functions.at(0) ?? unreachable('expected runTwice ownership')
    const owner =
      runTwice.bindings.find((binding) => binding.name === 'value') ??
      unreachable('expected value binding')
    assert.notStrictEqual(owner.movedAt, undefined)
  }),
)

it.effect('consumes the outer owner through a nested stored Effect projection', () =>
  Effect.gen(function* () {
    const snapshot = yield* analyzed(
      'stored-effect-ownership/nested-owner-move',
      `${declarations}struct Boxed<'env, F: once Effect<'env; i32>> { inner: Once<'env, F> }
fn runTwice<'env, F: once Effect<'env; i32>>(value: Boxed<'env, F>) -> i32 {
  let first = run value.inner.operation
  return first + run value.inner.operation
}
pub fn main() -> i32 { return 0 }`,
    )

    assert.include(codesOf(snapshot), 'OWN0001')
  }),
)

it.effect(
  'transfers a represented Effect field directly while retaining its initialized sibling',
  () =>
    Effect.gen(function* () {
      const snapshot = yield* analyzed(
        'stored-effect-ownership/extraction',
        `struct Once<'env, F: once Effect<'env; i32>> { operation: F sibling: i32 }
pub fn main() -> i32 {
  let deferred = Once { operation: effect { return 42 }, sibling: 1 }
  let operation = move deferred.operation
  return deferred.sibling
}`,
      )
      assert.deepEqual(Analysis.diagnostics(snapshot), [])
      const main =
        snapshot.ownership.get('stored-effect-ownership/extraction')?.functions.at(0) ??
        unreachable('expected main ownership')
      assert.isTrue(
        main.transitions.some(
          (transition) =>
            transition.kind === 'Move' &&
            transition.path.length === 1 &&
            transition.path[0]?._tag === 'Field' &&
            transition.path[0].ordinal === 0,
        ),
      )
    }),
)

it.effect('retains a stored Effect loan until the enclosing aggregate is consumed', () =>
  Effect.gen(function* () {
    const module = 'stored-effect-ownership/retained-loan'
    const source = `struct Deferred<'env, F: Effect<'env; i32>> { operation: F }
effect fn inspect(values: &[i32]) -> i32 { return values[0] }
pub fn main() -> i32 {
  let mut values = [1]
  let recipe = inspect(&values)
  let deferred = Deferred { operation: move recipe }
  values[0] = 2
  drop deferred
  return values[0]
}`
    const snapshot = yield* analyzed(module, source)
    const facts = snapshot.ownership.get(module) ?? unreachable('expected ownership facts')
    const loan = facts.functions.flatMap((fn) => [...fn.loans]).at(0)

    assert.notStrictEqual(loan, undefined)
    assert.strictEqual(loan?.origin, 'ReturnedView')
    assert.include(codesOf(snapshot), 'OWN0011')
    assert.strictEqual(
      loan === undefined ? undefined : source.slice(loan.endSpan.start, loan.endSpan.end).trim(),
      'drop deferred',
    )
  }),
)

it.effect('duplicates an explicitly Copy aggregate whose realized Effect captures are Copy', () =>
  Effect.gen(function* () {
    const snapshot = yield* analyzed(
      'stored-effect-ownership/copy-realization',
      `struct Offset { value: i32 }
impl Copy for Offset {}
struct Deferred<'env, F: Effect<'env; i32>> { operation: F }
impl<'env, F: Effect<'env; i32>> Copy for Deferred<'env, F> {}
effect fn compute(value: i32, offset: Offset) -> i32 { return value + offset.value }
fn consume<'env, F: Effect<'env; i32>>(value: Deferred<'env, F>) -> () { drop value }
pub fn main() -> i32 {
  let offset = Offset { value: 2 }
  let deferred = Deferred { operation: compute(40, move offset) }
  consume(deferred)
  consume(deferred)
  return 0
}`,
    )

    assert.notInclude(codesOf(snapshot), 'SEM0083')
    assert.notInclude(codesOf(snapshot), 'OWN0001')
  }),
)

it.effect('keeps an executable aggregate affine when its realized Effect owns a capture', () =>
  Effect.gen(function* () {
    const snapshot = yield* analyzed(
      'stored-effect-ownership/affine-realization',
      `struct Token { value: i32 }
impl Drop for Token { fn drop(self: &mut Token) -> () { return () } }
struct Deferred<'env, F: once Effect<'env; i32>> { operation: F }
impl<'env, F: once Effect<'env; i32>> Copy for Deferred<'env, F> {}
fn consume<'env, F: once Effect<'env; i32>>(value: Deferred<'env, F>) -> () { drop value }
pub fn main() -> i32 {
  let token = Token { value: 42 }
  let deferred = Deferred { operation: effect {
    let owned = move token
    return owned.value
  } }
  consume(move deferred)
  consume(move deferred)
  return 0
}`,
    )

    assert.include(codesOf(snapshot), 'OWN0001')
  }),
)

it.effect('runs a mut Effect only from a mutable binding', () =>
  Effect.gen(function* () {
    const source = (binding: string) => `
pub fn main() -> i32 {
  let mut count = 0
  ${binding} pending = effect { count = count + 1 return count }
  let first = run pending
  return first
}`
    const immutable = yield* analyzed('stored-effect-ownership/immutable-mut-run', source('let'))
    const diagnostic =
      Analysis.diagnostics(immutable).find((candidate) => candidate.code === 'SEM0077') ??
      unreachable('expected an exclusive run access rejection')
    const text = source('let')
    const start = text.indexOf('pending', text.indexOf('run pending'))
    assert.strictEqual(diagnostic.span.start, start)
    assert.strictEqual(diagnostic.span.end, start + 'pending'.length)
    const mutable = yield* analyzed('stored-effect-ownership/mutable-mut-run', source('let mut'))
    assert.notInclude(codesOf(mutable), 'SEM0077')
    assert.notInclude(codesOf(mutable), 'SEM0068')
    const shared = yield* analyzed(
      'stored-effect-ownership/mutable-shared-recipe',
      `pub fn main() -> i32 {
  let mut pending = effect { return 1 }
  return run pending
}`,
    )
    assert.include(codesOf(shared), 'SEM0068')
  }),
)

it.effect('runs and lends a mut Effect parameter only from a mutable binding', () =>
  Effect.gen(function* () {
    const source = (binding: string) => `
import silk.effect { Effect }
effect fn twice<'env>(${binding}pending: mut Effect<'env; i32>) -> i32 {
  let first = run pending
  return first + run pending
}
effect fn lend<'env>(${binding}lent: mut Effect<'env; i32>) -> i32 {
  let completed = run Effect.result(lent)
  return run lent
}
pub fn main() -> i32 {
  let mut count = 0
  return run twice(effect { count = count + 1 return count })
}`
    const text = source('')
    const immutable = yield* analyzed('stored-effect-ownership/immutable-mut-parameter', text)
    const starts = Analysis.diagnostics(immutable)
      .filter((candidate) => candidate.code === 'SEM0077')
      .map((candidate) => candidate.span.start)
    assert.include(starts, text.indexOf('pending', text.indexOf('run pending')))
    assert.include(starts, text.indexOf('lent', text.indexOf('result(')))
    const mutable = yield* analyzed('stored-effect-ownership/mutable-mut-parameter', source('mut '))
    assert.notInclude(codesOf(mutable), 'SEM0077')
  }),
)
