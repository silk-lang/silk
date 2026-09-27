import * as AnalysisFixture from './support/AnalysisFixture.js'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Analysis from '../src/Analysis.js'
import * as MirVerification from '../src/MirVerification.js'

const ascii = (value: string): Uint8Array =>
  Uint8Array.from(value, (character) => character.charCodeAt(0))

const analyzed = (name: string, source: string) =>
  AnalysisFixture.retainingMain(name, ascii(source))

const messages = (snapshot: Analysis.Snapshot): ReadonlyArray<string> =>
  Analysis.diagnostics(snapshot).map((diagnostic) => diagnostic.message)

it.effect('enforces unsafe operation variance and bound-call acknowledgement', () =>
  Effect.gen(function* () {
    const accepted = yield* analyzed(
      'user-witness/unsafe-operation',
      `interface Read {
  unsafe fn read(value: &Self) -> i32
}
struct Cell { value: i32 }
fn readCell(value: &Cell) -> i32 { return value.value }
impl Read for Cell { read: Cell.readCell }
fn readGeneric<T: Read>(value: T) -> i32 { return unsafe Read.read(&value) }
pub fn main() -> i32 { return readGeneric<Cell>(Cell { value: 7 }) }`,
    )
    assert.deepEqual(messages(accepted), [])

    const missingAcknowledgement = yield* analyzed(
      'user-witness/unsafe-bound-call',
      `interface Read { unsafe fn read(value: &Self) -> i32 }
fn readGeneric<T: Read>(value: T) -> i32 { return Read.read(&value) }`,
    )
    assert.include(
      Analysis.diagnostics(missingAcknowledgement).map((diagnostic) => diagnostic.code),
      'SEM0082',
    )

    const unsafeWitness = yield* analyzed(
      'user-witness/unsafe-witness-for-safe-operation',
      `interface Read { fn read(value: &Self) -> i32 }
struct Cell { value: i32 }
unsafe fn readCell(value: &Cell) -> i32 { return value.value }
impl Read for Cell { read: Cell.readCell }`,
    )
    assert.isTrue(
      messages(unsafeWitness).some((message) =>
        message.includes('unsafe witness cannot satisfy a safe operation contract'),
      ),
    )
  }),
)

it.effect('rejects a conformance that leaves one operation unmapped, naming it', () =>
  Effect.gen(function* () {
    const snapshot = yield* analyzed(
      'user-witness/missing-operation',
      `interface Blend {
  operator + fn add(left: &Self, right: &Self) -> Self
  operator < fn lessThan(left: &Self, right: &Self) -> bool
}

struct Cell {
  weight: i32
}

fn cellLess(left: &Cell, right: &Cell) -> bool {
  return left.weight < right.weight
}

impl Blend for Cell {
  lessThan: Cell.cellLess
}

pub fn main() -> i32 { return 0 }`,
    )
    assert.deepEqual(messages(snapshot), ['Invalid conformance: missing add'])
  }),
)

it.effect('rejects a bounded specialization at a type whose conformance is incomplete', () =>
  Effect.gen(function* () {
    // The coverage check reaches the call site too: a half-mapped witness cannot satisfy a bound.
    const snapshot = yield* analyzed(
      'user-witness/incomplete-specialization',
      `interface Blend {
  operator + fn add(left: &Self, right: &Self) -> Self
  operator < fn lessThan(left: &Self, right: &Self) -> bool
}

struct Cell {
  weight: i32
}

fn cellLess(left: &Cell, right: &Cell) -> bool {
  return left.weight < right.weight
}

impl Blend for Cell {
  lessThan: Cell.cellLess
}

fn ordered<T: Blend>(left: T, right: T) -> bool {
  return (&left) < (&right)
}

pub fn main() -> i32 {
  if ordered<Cell>(Cell { weight: 1 }, Cell { weight: 2 }) { return 1 }
  return 0
}`,
    )
    assert.include(
      messages(snapshot),
      'Invalid conformance: user-witness/incomplete-specialization.Cell does not implement Blend.add',
    )
  }),
)

it.effect('admits a value witness only when the interface literally transfers ownership', () =>
  Effect.gen(function* () {
    // There is no blanket adaptation: authored value ownership matches an authored value witness.
    const snapshot = yield* analyzed(
      'user-witness/by-value-operand',
      `interface Ordered {
  fn lessThan(left: Self, right: Self) -> bool
}

struct Cell {
  weight: i32
}

fn cellLess(left: Cell, right: Cell) -> bool {
  return left.weight < right.weight
}

impl Ordered for Cell {
  lessThan: Cell.cellLess
}

pub fn main() -> i32 { return 0 }`,
    )
    assert.deepEqual(messages(snapshot), [])
  }),
)

it.effect('rejects a witness whose result disagrees with the contract', () =>
  Effect.gen(function* () {
    const snapshot = yield* analyzed(
      'user-witness/wrong-result',
      `interface Ordered {
  fn lessThan(left: &Self, right: &Self) -> bool
}

struct Cell {
  weight: i32
}

fn cellLess(left: &Cell, right: &Cell) -> i32 {
  return left.weight - right.weight
}

impl Ordered for Cell {
  lessThan: Cell.cellLess
}

pub fn main() -> i32 { return 0 }`,
    )
    assert.deepEqual(
      Analysis.diagnostics(snapshot).map((diagnostic) => [
        diagnostic.code,
        diagnostic.span.start,
        diagnostic.span.end,
      ]),
      [['SEM0083', 216, 239]],
    )
  }),
)

it.effect('rejects a mapping that names a function the provider actor does not declare', () =>
  Effect.gen(function* () {
    const snapshot = yield* analyzed(
      'user-witness/absent-function',
      `interface Ordered {
  fn lessThan(left: &Self, right: &Self) -> bool
}

struct Cell {
  weight: i32
}

impl Ordered for Cell {
  lessThan: Cell.absent
}

pub fn main() -> i32 { return 0 }`,
    )
    assert.deepEqual(messages(snapshot), [
      'Invalid conformance: mapped operation Cell.absent does not exist',
    ])
  }),
)

it.effect('selects source application result policies without storing an erased Effect', () =>
  Effect.gen(function* () {
    const snapshot = yield* analyzed(
      'user-witness/application-result',
      `import silk.effect { Effect }
struct Application<T> {}
interface EntryResult<T> { fn code(value: T) -> i32 }
impl EntryResult<i32> for Application<i32> { fn code(value: i32) -> i32 { return value } }
impl EntryResult<()> for Application<()> { fn code(value: ()) -> i32 { return 0 } }
effect<'env> fn failed<E: 'env, 'env>(error: E) -> i32 { drop error return 1 }
effect fn succeeded(value: ()) -> i32 { return 0 }
impl<'env, E> EntryResult<Effect<'env; () ! E>> for Application<Effect<'env; () ! E>> {
  fn code(value: Effect<'env; () ! E>) -> i32 {
    let computation = Effect.flatMap(move value, succeeded)
    return run Effect.catchAll(move computation, failed)
  }
}
struct Problem {}
effect fn test() -> () ! Problem { fail Problem {} }
effect fn successEffect() -> () {}
fn select<T>(value: &T) -> Application<T> { return Application<T> {} }
fn adapt<T, P: EntryResult<T>>(value: T, provider: P) -> i32 { return EntryResult<T>.code(move value) }
pub fn main() -> i32 {
  let value = test()
  let provider = select(&value)
  let failedCode = adapt(move value, move provider)
  let successfulEffect = successEffect()
  let effectProvider = select(&successfulEffect)
  let effectCode = adapt(move successfulEffect, move effectProvider)
  let success: i32 = 41
  let successProvider = select(&success)
  let unit = ()
  let unitProvider = select(&unit)
  return effectCode + failedCode + adapt(success, move successProvider) + adapt(unit, move unitProvider)
}
`,
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    assert.strictEqual(snapshot.mir._tag, 'Available')
    if (snapshot.mir._tag === 'Available')
      assert.deepEqual(yield* MirVerification.verify(snapshot.mir.value), [])
  }),
)
