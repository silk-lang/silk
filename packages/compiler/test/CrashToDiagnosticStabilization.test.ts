import * as AnalysisFixture from './support/AnalysisFixture.js'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Analysis from '../src/Analysis.js'
import * as Diagnostic from '../src/Diagnostic.js'
import * as MirVerification from '../src/MirVerification.js'

/**
 * INV-1: `Analysis.*` never throws. Every program here used to die inside the compiler (a stack
 * overflow, a lost invariant, or a parser gap turning into a semantic defect); each must now be
 * either a valid program or a typed diagnostic.
 */

const ascii = (value: string): Uint8Array =>
  Uint8Array.from(value, (character) => character.charCodeAt(0))

const target = 'wasm32-unknown-unknown'

const realized = (id: string, source: string) =>
  AnalysisFixture.retainingMain(id, ascii(source), target)

const codes = (snapshot: Analysis.FrontendSnapshot): ReadonlyArray<string> =>
  Analysis.diagnostics(snapshot).map((diagnostic) => diagnostic.code)

const spans = (
  snapshot: Analysis.FrontendSnapshot,
  code: Diagnostic.Code,
): ReadonlyArray<readonly [number, number]> =>
  Analysis.diagnostics(snapshot)
    .filter((diagnostic) => diagnostic.code === code)
    .map((diagnostic) => [diagnostic.span.start, diagnostic.span.end] as const)

const chain = (count: number, operator: string, term: string): string =>
  Array.from({ length: count }, () => term).join(` ${operator} `)

it.effect('lowers a 257-term left-nested arithmetic chain without host recursion', () =>
  Effect.gen(function* () {
    const snapshot = yield* realized(
      'stabilization/chain-257',
      `pub fn main() -> i32 {\n  return ${chain(257, '+', '1')}\n}\n`,
    )
    assert.deepEqual(codes(snapshot), [])
    assert.deepEqual(yield* MirVerification.verify(Analysis.loweredMir(snapshot)), [])
  }),
)

it.effect('rejects a chain nesting past EXPR-006 with PAR0005 instead of overflowing', () =>
  Effect.gen(function* () {
    const plus = yield* realized(
      'stabilization/chain-300',
      `pub fn main() -> i32 {\n  return ${chain(300, '+', '1')}\n}\n`,
    )
    assert.deepEqual(codes(plus), [Diagnostic.expressionNestingLimitExceededCode])
    const and = yield* realized(
      'stabilization/and-2000',
      `pub fn main() -> i32 {\n  let t = true\n  if ${chain(2000, '&&', 't')} { return 1 }\n  return 0\n}\n`,
    )
    assert.deepEqual(codes(and), [Diagnostic.expressionNestingLimitExceededCode])
    const pipe = yield* realized(
      'stabilization/pipe-2000',
      `fn id(x: i32) -> i32 { return x }\npub fn main() -> i32 {\n  return 0${' |> id'.repeat(2000)}\n}\n`,
    )
    assert.deepEqual(codes(pipe), [Diagnostic.expressionNestingLimitExceededCode])
  }),
)

it.effect(
  'lowers a 5000-statement function without host recursion',
  () =>
    Effect.gen(function* () {
      const snapshot = yield* realized(
        'stabilization/statements-5000',
        `pub fn main() -> i32 {\n  let mut x = 0\n${'  x = x + 1\n'.repeat(5000)}  return x - 4958\n}\n`,
      )
      assert.deepEqual(codes(snapshot), [])
      assert.deepEqual(yield* MirVerification.verify(Analysis.loweredMir(snapshot)), [])
    }),
  240000,
)

// ISSUE-43 — a callable contract as an explicit generic argument in expression position.

it.effect('parses a callable contract type argument on a generic call or literal', () =>
  Effect.gen(function* () {
    const choose = `fn choose<A, B>(left: A, right: B) -> A {\n  drop right\n  return move left\n}\n`
    const call = yield* realized(
      'stabilization/generic-callable-call',
      `${choose}pub fn main() -> i32 { return choose<fn(i32) -> i32>(1, true) }\n`,
    )
    assert.deepEqual(codes(call), [Diagnostic.typeArgumentConflictCode])
    const once = yield* realized(
      'stabilization/generic-callable-once',
      `${choose}pub fn main() -> i32 {\n  choose<once fn(i32) -> i32>(1, true)\n  return 1\n}\n`,
    )
    assert.deepEqual(codes(once), [Diagnostic.typeArgumentConflictCode])
    const literal = yield* realized(
      'stabilization/generic-callable-literal',
      `struct Pair<A, B> {\n  first: A\n  second: B\n}\npub fn main() -> i32 {\n  let p = Pair<fn(i32) -> i32> { first: 1, second: true }\n  return 1\n}\n`,
    )
    assert.deepEqual(codes(literal), [Diagnostic.typeArgumentConflictCode])
    const validSource = `fn add(a: i32, b: i32) -> i32 { return a + b }\nfn makeAdder(base: i32) -> fn<'static>(i32) -> i32 { return add(base) }\nfn apply<A>(x: i32, f: once fn(i32) -> A) -> A { return f(x) }\npub fn main() -> i32 {\n  let f = apply<fn<'static>(i32) -> i32>(2, makeAdder)\n  return f(40)\n}\n`
    const valid = yield* realized('stabilization/generic-callable-valid', validSource)
    // The applied parameter names its exact target, whose instance fixes the callable result.
    assert.deepEqual(
      Analysis.diagnostics(valid).map((diagnostic) => ({
        code: diagnostic.code,
        span: validSource.slice(diagnostic.span.start, diagnostic.span.end),
      })),
      [],
    )
    assert.deepEqual(yield* MirVerification.verify(Analysis.loweredMir(valid)), [])
  }),
)

// ISSUE-89 — a bodiless `export "C" fn` is a parser diagnostic.

it.effect('reports a missing exported function body as a parser diagnostic', () =>
  Effect.gen(function* () {
    const snapshot = yield* realized(
      'stabilization/export-bodiless',
      `export "C" fn bad(value: i32) -> i32\npub fn main() -> i32 { return 0 }\n`,
    )
    assert.include(codes(snapshot), Diagnostic.missingTokenCode)
  }),
)

// ISSUE-3 — a static function has no runtime function item (STATIC-001).

it.effect('rejects a static function used as a runtime callable value', () =>
  Effect.gen(function* () {
    const source = `static fn c(v: i32) -> i32 { return v }\nfn apply(f: fn(i32) -> i32) -> i32 { return f(1) }\npub fn main() -> i32 {\n  let g = c\n  return apply(c)\n}\n`
    const snapshot = yield* realized('stabilization/static-as-value', source)
    assert.deepEqual(
      spans(snapshot, Diagnostic.staticPhaseViolationCode).map(([start, end]) =>
        source.slice(start, end).trim(),
      ),
      ['c', 'c'],
    )
    const runtimeCall = yield* realized(
      'stabilization/static-runtime-call',
      `static fn c(v: i32) -> i32 { return v + 41 }\npub fn main() -> i32 {\n  let n = 1\n  return c(n)\n}\n`,
    )
    assert.deepEqual(codes(runtimeCall), [Diagnostic.staticPhaseViolationCode])
  }),
)
