import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Analysis from '../src/Analysis.js'

const encoder = new TextEncoder()

const snapshot = (name: string, source: string) =>
  Analysis.ofSource(`stabilization/${name}`, encoder.encode(source))

const diagnostics = Effect.fnUntraced(function* (name: string, source: string) {
  const self = yield* snapshot(name, source)
  return Analysis.diagnostics(self).map((diagnostic) => [
    diagnostic.code,
    diagnostic.span.start,
    diagnostic.span.end,
  ])
})

// ISSUE-50 — EFFECT-OWN-001: an Effect may not escape with a borrow of function-owned storage.
it.effect('rejects an Effect escaping with a borrow of a local owner', () =>
  Effect.gen(function* () {
    assert.deepEqual(
      yield* diagnostics(
        'effect-escape-local',
        `effect fn inspect(values: &[i32]) -> i32 { return values[0] }
fn make() -> Effect<'static; i32> {
  let v = [21]
  return inspect(&v)
}
pub fn main() -> i32 { return run make() }`,
      ),
      [
        ['OWN0019', 122, 133],
        ['OWN0018', 130, 132],
        ['SEM0212', 130, 132],
      ],
    )
    assert.deepEqual(
      yield* diagnostics(
        'effect-escape-temp-view',
        `fn identity(values: &[i32]) -> &[i32] { return values }
fn make() -> Effect<'static; i32> {
  let view = identity(&[1, 2])
  return effect { return view[0] }
}
pub fn main() -> i32 { let e = make() return run e }`,
      ),
      [
        ['SEM0212', 114, 121],
        ['OWN0019', 132, 157],
        ['OWN0018', 148, 152],
      ],
    )
    assert.deepEqual(
      yield* diagnostics(
        'effect-escape-bound',
        `effect fn inspect(values: &[i32]) -> i32 { return values[0] }
fn make() -> Effect<'static; i32> {
  let v = [21]
  let e = inspect(&v)
  return e
}
pub fn main() -> i32 { return run make() }`,
      ),
      [
        ['OWN0018', 131, 133],
        ['SEM0212', 131, 133],
        ['OWN0019', 144, 145],
      ],
    )
  }),
)

// EFFECT-OWN-001 / LIFE-004: an ordinary helper retains only its result contract's inputs.
const secondEffect = `effect fn inspect<'a>(values: &'a [i32]) -> i32 { return values[0] }
fn second<'a, 'b>(first: &'a [i32], kept: &'b [i32]) -> Effect<'b; i32> {
  drop first
  return inspect(kept)
}`

it.effect('accepts an Effect helper result that does not retain its local argument', () =>
  Effect.gen(function* () {
    const source = `${secondEffect}
fn make(staticKept: &'static [i32]) -> Effect<'static; i32> {
  let localFirst = [1]
  return second(&localFirst, staticKept)
}`
    assert.deepEqual(yield* diagnostics('effect-helper-unretained-local', source), [])
  }),
)

it.effect('attributes an escaping Effect helper result only to its retained local argument', () =>
  Effect.gen(function* () {
    const source = `${secondEffect}
fn make() -> Effect<'static; i32> {
  let localFirst = [1]
  let localKept = [2]
  return second(&localFirst, &localKept)
}`
    const start = source.indexOf('&localKept')
    const actual = yield* diagnostics('effect-helper-retained-local', source)
    assert.deepEqual(
      actual.filter(([code]) => code === 'OWN0018'),
      [['OWN0018', start, start + '&localKept'.length]],
    )
  }),
)

it.effect('rejects both local inputs when an Effect helper result retains both', () =>
  Effect.gen(function* () {
    const source = `effect fn inspectBoth<'a, 'b>(first: &'a [i32], kept: &'b [i32]) -> i32 {
  return first[0] + kept[0]
}
fn both<'a, 'b>(first: &'a [i32], kept: &'b [i32]) -> Effect<'a & 'b; i32> {
  return inspectBoth(first, kept)
}
fn make() -> Effect<'static; i32> {
  let localFirst = [1]
  let localKept = [2]
  return both(&localFirst, &localKept)
}`
    const actual = yield* diagnostics('effect-helper-both-local', source)
    assert.deepEqual(
      actual.filter(([code]) => code === 'OWN0018'),
      ['&localFirst', '&localKept'].map((spelling) => {
        const start = source.indexOf(spelling)
        return ['OWN0018', start, start + spelling.length]
      }),
    )
  }),
)

// ISSUE-103 — CONST-001: a constant has no address and cannot be borrowed.
it.effect('rejects borrowing a constant', () =>
  Effect.gen(function* () {
    assert.deepEqual(
      yield* diagnostics(
        'const-borrow',
        'const x: i32 = 1\nfn peek(v: &i32) -> i32 { return 5 }\npub fn main() -> i32 { return peek(&x) }',
      ),
      [['SEM0086', 89, 91]],
    )
    assert.deepEqual(
      yield* diagnostics(
        'const-mut-borrow',
        'const x: i32 = 1\nfn poke(v: &mut i32) -> i32 { return 5 }\npub fn main() -> i32 { return poke(&mut x) }',
      ),
      [['SEM0086', 93, 99]],
    )
  }),
)
