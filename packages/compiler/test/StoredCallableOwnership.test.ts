import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Analysis from '../src/Analysis.js'
import { unreachable } from './support/raise.js'

/**
 * Aggregate receiver access for callables stored in nominal fields.
 *
 * Invoking a callable field uses its enclosing aggregate's access to bound the invocation modes
 * its environment admits: a shared receiver invokes `fn`, an
 * exclusive receiver also invokes `mut fn`, and only a whole owner may consume a `once fn` — which
 * takes the whole aggregate rather than extracting the field out of it.
 *
 * The rule is stated once, on `FieldRealization`, and these tests pin the ownership half of
 * it. Runtime acceptance for supported realized fields is covered separately; unsupported bare
 * structural fields remain fenced by `SEM0103`.
 */

const ascii = (value: string): Uint8Array =>
  Uint8Array.from(value, (character) => character.charCodeAt(0))

const analyzed = Effect.fnUntraced(function* (name: string, source: string) {
  return yield* Analysis.ofSource(name, ascii(source))
})

const codesOf = (snapshot: Analysis.FrontendSnapshot): ReadonlyArray<string> =>
  Analysis.diagnostics(snapshot).map((diagnostic) => diagnostic.code)

const declarations = `struct Parser<'env, F: fn<'env>(i32) -> i32> { parse: F }
struct Stepper<'env, F: mut fn<'env>(i32) -> i32> { step: F }
struct Once<'env, F: once fn<'env>(i32) -> i32> { step: F }
struct Boxed<'env, F: once fn<'env>(i32) -> i32> { inner: Once<'env, F> }
fn decode(value: i32) -> i32 { return value }
`

it.effect('reuses a shared stored callable through a shared borrow', () =>
  Effect.gen(function* () {
    const snapshot = yield* analyzed(
      'stored-callable-ownership/shared-reuse',
      `${declarations}fn parseTwice<'env, F: fn<'env>(i32) -> i32>(parser: &Parser<'env, F>) -> i32 {
  return parser.parse(1) + parser.parse(2)
}
pub fn main() -> i32 { return 0 }`,
    )

    // Repeated invocation neither consumes the parser nor demands a stronger receiver.
    assert.notInclude(codesOf(snapshot), 'OWN0014')
    assert.notInclude(codesOf(snapshot), 'OWN0001')
  }),
)

it.effect('rejects take-only invocation through a shared borrow', () =>
  Effect.gen(function* () {
    const snapshot = yield* analyzed(
      'stored-callable-ownership/take-through-shared',
      `${declarations}fn consume<'env, F: once fn<'env>(i32) -> i32>(value: &Once<'env, F>) -> i32 {
  return value.step(1)
}
pub fn main() -> i32 { return 0 }`,
    )
    const diagnostic =
      Analysis.diagnostics(snapshot).find((candidate) => candidate.code === 'OWN0014') ??
      unreachable('expected a stored-callable invocation access rejection')

    assert.strictEqual(diagnostic.reason._tag, 'StoredCallableInvocationAccess')
    if (diagnostic.reason._tag !== 'StoredCallableInvocationAccess') return
    // The rejection identifies the whole-owner take access the mode demands.
    assert.strictEqual(diagnostic.reason.receiver, 'Shared')
    assert.strictEqual(diagnostic.reason.required, 'Take')
    assert.strictEqual(diagnostic.reason.field, '#0')
    // The take is rejected as an invocation, not reinterpreted as a field extraction.
  }),
)

it.effect('rejects exclusive invocation through a shared borrow', () =>
  Effect.gen(function* () {
    const snapshot = yield* analyzed(
      'stored-callable-ownership/exclusive-through-shared',
      `${declarations}fn advance<'env, F: mut fn<'env>(i32) -> i32>(stepper: &Stepper<'env, F>) -> i32 {
  return stepper.step(1)
}
pub fn main() -> i32 { return 0 }`,
    )
    const diagnostic =
      Analysis.diagnostics(snapshot).find((candidate) => candidate.code === 'OWN0014') ??
      unreachable('expected a stored-callable invocation access rejection')

    assert.strictEqual(diagnostic.reason._tag, 'StoredCallableInvocationAccess')
    if (diagnostic.reason._tag !== 'StoredCallableInvocationAccess') return
    assert.strictEqual(diagnostic.reason.receiver, 'Shared')
    assert.strictEqual(diagnostic.reason.required, 'Exclusive')
  }),
)

it.effect('admits exclusive invocation through an exclusive borrow', () =>
  Effect.gen(function* () {
    const snapshot = yield* analyzed(
      'stored-callable-ownership/exclusive-through-exclusive',
      `${declarations}fn advance<'env, F: mut fn<'env>(i32) -> i32>(stepper: &mut Stepper<'env, F>) -> i32 {
  return stepper.step(1)
}
pub fn main() -> i32 { return 0 }`,
    )

    assert.notInclude(codesOf(snapshot), 'OWN0014')
  }),
)

it.effect('consumes the whole aggregate for a take-once invocation', () =>
  Effect.gen(function* () {
    const snapshot = yield* analyzed(
      'stored-callable-ownership/take-through-owner',
      `${declarations}fn consumeTwice<'env, F: once fn<'env>(i32) -> i32>(value: Once<'env, F>) -> i32 {
  let first = value.step(1)
  let second = value.step(2)
  return first + second
}
pub fn main() -> i32 { return 0 }`,
    )

    // The first invocation takes the whole owner, so the second use is a plain use-after-move —
    // never a partial move of the field out of the aggregate.
    assert.include(codesOf(snapshot), 'OWN0001')
    assert.notInclude(codesOf(snapshot), 'OWN0002')
  }),
)

it.effect('admits one take-once invocation through a whole owner', () =>
  Effect.gen(function* () {
    const snapshot = yield* analyzed(
      'stored-callable-ownership/take-once',
      `${declarations}fn consumeOnce<'env, F: once fn<'env>(i32) -> i32>(value: Once<'env, F>) -> i32 {
  return value.step(1)
}
pub fn main() -> i32 { return 0 }`,
    )

    assert.notInclude(codesOf(snapshot), 'OWN0014')
    assert.notInclude(codesOf(snapshot), 'OWN0001')
  }),
)

it.effect('weakens a nested receiver to the borrow it is reached through', () =>
  Effect.gen(function* () {
    const shared = yield* analyzed(
      'stored-callable-ownership/nested-shared',
      `${declarations}fn consume<'env, F: once fn<'env>(i32) -> i32>(value: &Boxed<'env, F>) -> i32 {
  return value.inner.step(1)
}
pub fn main() -> i32 { return 0 }`,
    )
    const owned = yield* analyzed(
      'stored-callable-ownership/nested-owned',
      `${declarations}fn consume<'env, F: once fn<'env>(i32) -> i32>(value: Boxed<'env, F>) -> i32 {
  return value.inner.step(1)
}
pub fn main() -> i32 { return 0 }`,
    )

    // The borrow is two projections above the callable field and still bounds it.
    assert.include(codesOf(shared), 'OWN0014')
    assert.notInclude(codesOf(owned), 'OWN0014')
  }),
)

it.effect('respects shared, exclusive, and moved match-pattern roots', () =>
  Effect.gen(function* () {
    const shared = yield* analyzed(
      'stored-callable-ownership/match-shared',
      `${declarations}fn consume<'env, F: once fn<'env>(i32) -> i32>(value: Boxed<'env, F>) -> i32 {
  return match &value { Boxed<'env, F> { inner } => inner.step(1) }
}
pub fn main() -> i32 { return 0 }`,
    )
    const exclusive = yield* analyzed(
      'stored-callable-ownership/match-exclusive',
      `${declarations}fn consume<'env, F: once fn<'env>(i32) -> i32>(value: Boxed<'env, F>) -> i32 {
  let mut local = move value
  return match &mut local { Boxed<'env, F> { inner } => inner.step(1) }
}
pub fn main() -> i32 { return 0 }`,
    )
    const moved = yield* analyzed(
      'stored-callable-ownership/match-moved',
      `${declarations}fn consume<'env, F: once fn<'env>(i32) -> i32>(value: Boxed<'env, F>) -> i32 {
  return match move value { Boxed<'env, F> { inner } => inner.step(1) }
}
pub fn main() -> i32 { return 0 }`,
    )

    assert.include(
      codesOf(shared),
      'OWN0014',
      Analysis.diagnostics(shared)
        .map((diagnostic) => diagnostic.message)
        .join('\n'),
    )
    assert.include(
      codesOf(exclusive),
      'OWN0014',
      Analysis.diagnostics(exclusive)
        .map((diagnostic) => diagnostic.message)
        .join('\n'),
    )
    assert.notInclude(codesOf(moved), 'OWN0014')
    assert.notInclude(codesOf(moved), 'OWN0001')
  }),
)

it.effect('bounds a bare stored callable field by the same receiver rule', () =>
  Effect.gen(function* () {
    const snapshot = yield* analyzed(
      'stored-callable-ownership/bare-field',
      `struct Once { step: once fn(i32) -> i32 }
fn consume(value: &Once) -> i32 { return value.step(1) }
pub fn main() -> i32 { return 0 }`,
    )

    // A field whose declared type is the structural contract stores a callable just the same.
    assert.include(codesOf(snapshot), 'OWN0014')
  }),
)

it.effect('keeps direct callable bindings on their existing rules', () =>
  Effect.gen(function* () {
    const snapshot = yield* analyzed(
      'stored-callable-ownership/direct-binding',
      `fn apply(step: once fn(i32) -> i32) -> i32 {
  let first = step(1)
  let second = step(2)
  return first + second
}
pub fn main() -> i32 { return 0 }`,
    )

    // A callable parameter is not stored in an aggregate, so the receiver rule never applies.
    assert.notInclude(codesOf(snapshot), 'OWN0014')
    assert.include(codesOf(snapshot), 'OWN0001')
  }),
)

it.effect('duplicates an explicitly Copy aggregate whose realized callable captures are Copy', () =>
  Effect.gen(function* () {
    const snapshot = yield* analyzed(
      'stored-callable-ownership/copy-realization',
      `import silk.ownership {Copy}
struct Offset { value: i32 }
impl Copy for Offset {}
struct Parser<'env, F: fn<'env>(i32) -> i32> { parse: F }
impl<'env, F: fn<'env>(i32) -> i32> Copy for Parser<'env, F> {}
fn decode(value: i32, offset: Offset) -> i32 { return value + offset.value }
fn consume<'env, F: fn<'env>(i32) -> i32>(parser: Parser<'env, F>, value: i32) -> i32 {
  return parser.parse(value)
}
pub fn main() -> i32 {
  let offset = Offset { value: 1 }
  let parser = Parser { parse: decode(move offset) }
  return consume(parser, 1) + consume(parser, 2)
}`,
    )

    assert.notInclude(codesOf(snapshot), 'SEM0083')
    assert.notInclude(codesOf(snapshot), 'OWN0001')
  }),
)

it.effect('keeps an executable aggregate affine when its realized callable owns a capture', () =>
  Effect.gen(function* () {
    const snapshot = yield* analyzed(
      'stored-callable-ownership/affine-realization',
      `import silk.ownership {Copy, Drop}
struct Token { value: i32 }
impl Drop for Token { fn drop(self: &mut Token) -> () { return () } }
struct Parser<'env, F: once fn<'env>(i32) -> i32> { parse: F }
impl<'env, F: once fn<'env>(i32) -> i32> Copy for Parser<'env, F> {}
fn decode(value: i32, token: Token) -> i32 { return value + token.value }
fn consume<'env, F: once fn<'env>(i32) -> i32>(parser: Parser<'env, F>, value: i32) -> i32 {
  return parser.parse(value)
}
pub fn main() -> i32 {
  let token = Token { value: 1 }
  let parser = Parser { parse: decode(move token) }
  return consume(move parser, 1) + consume(move parser, 2)
}`,
    )

    assert.include(codesOf(snapshot), 'OWN0001')
  }),
)
