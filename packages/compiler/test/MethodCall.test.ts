import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Analysis from '../src/Analysis.js'
import * as SemanticOccurrence from '../src/SemanticOccurrence.js'
import * as SourceResolver from '../src/SourceResolver.js'

const ascii = (value: string): Uint8Array =>
  Uint8Array.from(value, (character) => character.charCodeAt(0))

const analyze = (text: string) => Analysis.ofSource('main', ascii(text))

const analyzeModules = (rootModule: string, entries: ReadonlyArray<readonly [string, string]>) =>
  Analysis.make({ root: rootModule }).pipe(
    Effect.provide(
      SourceResolver.memory(
        new Map(entries.map(([module, text]) => [module, ascii(text)] as const)),
      ),
    ),
  )

const codes = (self: Analysis.FrontendSnapshot): ReadonlyArray<string> =>
  Analysis.diagnostics(self).map((diagnostic) => diagnostic.code)

const identityAt = (
  snapshot: Analysis.FrontendSnapshot,
  source: string,
  spelling: string,
  occurrence = 0,
): string | undefined => {
  let offset = -1
  for (let index = 0; index <= occurrence; index += 1) offset = source.indexOf(spelling, offset + 1)
  const found = Analysis.semanticOccurrenceAt(snapshot, 'main', offset)
  return found?.resolution._tag === 'Available'
    ? SemanticOccurrence.identityKey(found.resolution.identity)
    : undefined
}

const option = `pub union Option<T> { None, Some { pub value: T } }
impl<T> Option<T> {
  pub fn some(value: T) -> Self { return Option.Some { value: move value } }
  pub fn map<U>(self: Self, transform: once fn(T) -> U) -> Option<U> {
    return match move self {
      Option<T>.Some { value } => Option.Some { value: transform(move value) }
      Option<T>.None => Option<U>.None
    }
  }
  pub fn unwrapOr(self: Self, fallback: T) -> T {
    return match move self {
      Option<T>.Some { value } => keep<T>(move value, move fallback)
      Option<T>.None => move fallback
    }
  }
}
fn keep<T>(present: T, unused: T) -> T {
  drop unused
  return move present
}
fn addOne(value: i32) -> i32 { return value + 1 }
`

const counter = `pub struct Counter { value: i32 }
impl Counter {
  pub fn zero() -> Self { return Counter { value: 0 } }
  pub fn read(self: &Self) -> i32 { return self.value }
  pub fn bump(self: &mut Self) -> i32 {
    self.value = self.value + 1
    return self.value
  }
  pub fn add(self: &Self, other: &Self) -> i32 { return self.value + other.value }
  pub fn take(self: Self) -> i32 { return self.value }
}
`

const printable = `interface Printable { fn print(value: &Self) -> i32 }
interface Debug { fn print(value: &Self) -> i32 }
struct Document { size: i32 }
impl Printable for Document { fn print(value: &Self) -> i32 { return value.size } }
`

it.effect('opens both receiver and written argument lifetimes before checking a member call', () =>
  Effect.gen(function* () {
    const self = yield* analyze(`${counter}
pub fn main() -> i32 {
  let left = Counter { value: 20 }
  let right = Counter { value: 22 }
  return left.add(&right)
}`)
    assert.deepEqual(Analysis.diagnostics(self), [])
  }),
)

it.effect('completes and hovers the value side with receiver-bound members', () =>
  Effect.gen(function* () {
    const source = `${counter}
pub fn main() -> i32 {
  let value = Counter { value: 42 }
  let read = value.read()
  return value.
}`
    const self = yield* analyze(source)
    const completion = Analysis.completionAt(self, 'main', source.lastIndexOf('value.') + 6)
    assert.deepEqual(completion?.context, { _tag: 'ValueMemberContext', state: 'Available' })
    assert.deepEqual(
      completion?.candidates.map((candidate) => [candidate.label, candidate.kind]),
      [
        ['value', 'Field'],
        ['add', 'Method'],
        ['bump', 'Method'],
        ['read', 'Method'],
        ['take', 'Method'],
      ],
    )
    assert.strictEqual(
      completion?.candidates.find((candidate) => candidate.label === 'add')?.detail?.text,
      "fn<'life0, 'life1>(other: &'life1 Counter) -> i32",
    )
    // Receiver syntax hovers the receiver-bound contract; the type side keeps the whole contract.
    const method = Analysis.hoverSubjectAt(self, 'main', source.indexOf('value.read()') + 6)
    assert.strictEqual(method?.presentation.text, "fn<'life0>() -> i32")
    const explicit = yield* analyze(`${counter}
pub fn main() -> i32 {
  let value = Counter { value: 42 }
  return Counter.read(&value)
}`)
    const typeSide = Analysis.hoverSubjectAt(
      explicit,
      'main',
      `${counter}\npub fn main() -> i32 {\n  let value = Counter { value: 42 }\n  return Counter.`
        .length,
    )
    assert.strictEqual(
      typeSide?.presentation.text,
      "pub fn read<'life0>(self: &'life0 Counter) -> i32",
    )
  }),
)

it.effect('rejects associated functions selected from values', () =>
  Effect.gen(function* () {
    for (const body of ['return value.zero().read()', 'let zero = value.zero\n  return 0']) {
      const snapshot = yield* analyze(`${counter}
pub fn main() -> i32 {
  let value = Counter { value: 1 }
  ${body}
}`)
      assert.deepEqual(codes(snapshot), ['SEM0198'])
    }
  }),
)

it.effect('completes bound operations after a generic receiver', () =>
  Effect.gen(function* () {
    const source = `${printable}
fn show<T: Printable>(value: &T) -> i32 { return value. }
pub fn main() -> i32 { return 0 }`
    const self = yield* analyze(source)
    const completion = Analysis.completionAt(self, 'main', source.indexOf('value. }') + 6)
    assert.deepEqual(completion?.context, { _tag: 'ValueMemberContext', state: 'Available' })
    assert.deepEqual(
      completion?.candidates.map((candidate) => [candidate.label, candidate.kind]),
      [['print', 'Method']],
    )
    assert.strictEqual(completion?.candidates.at(0)?.detail?.text, 'fn() -> i32')
  }),
)

it.effect('substitutes the owner binders a receiver fixes in hover and completion', () =>
  Effect.gen(function* () {
    const source = `${option}
pub fn main() -> i32 {
  let value = Option.some<i32>(41)
  let mapped = value.map(addOne)
  let more = value.
  return mapped.unwrapOr(0)
}`
    const self = yield* analyze(source)
    const hover = Analysis.hoverSubjectAt(self, 'main', source.indexOf('value.map(') + 6)
    assert.strictEqual(
      hover?.presentation.text,
      "fn<U, 'life2>(transform: once fn<'life2>(i32) -> U) -> Option<U>",
    )
    const completion = Analysis.completionAt(self, 'main', source.indexOf('value.\n') + 6)
    assert.deepEqual(
      completion?.candidates.map((candidate) => [candidate.label, candidate.detail?.text]),
      [
        ['map', "fn<U, 'life2>(transform: once fn<'life2>(i32) -> U) -> Option<U>"],
        ['unwrapOr', 'fn(fallback: i32) -> i32'],
      ],
    )
  }),
)

it.effect('keeps visibility, navigation, and own-binder rules across the value side', () =>
  Effect.gen(function* () {
    const hidden = yield* analyzeModules('app', [
      [
        'widgets',
        `pub struct Gadget { pub size: i32 }
impl Gadget { fn secret(self: &Self) -> i32 { return self.size } }
`,
      ],
      [
        'app',
        `import widgets { Gadget }
pub fn main() -> i32 {
  let gadget = Gadget { size: 1 }
  return gadget.secret()
}`,
      ],
    ])
    assert.deepEqual(codes(hidden), ['SEM0015'])
    const source = `${printable}
fn show<T: Printable>(value: &T) -> i32 { return value.print() }
pub fn main() -> i32 {
  let document = Document { size: 42 }
  return show(&document)
}`
    const bounded = yield* analyze(source)
    const key = identityAt(bounded, source, 'print() }', 0)
    assert.isDefined(key)
    assert.isTrue(key?.startsWith('service-operation:'), key)
    assert.strictEqual(identityAt(bounded, source, 'print(value: &Self)', 0), key)
    // An operation with its own type parameters is not a member through either spelling.
    const ownBinders = yield* analyze(`interface Widen { fn widen<U>(value: &Self, seed: U) -> U }
struct Cell { value: i32 }
impl Widen for Cell { fn widen<U>(value: &Self, seed: U) -> U { return move seed } }
fn show<T: Widen>(value: &T) -> i32 { return value.widen(1) }
pub fn main() -> i32 { return 0 }`)
    assert.deepEqual(codes(ownBinders), ['SEM0026'])
  }),
)

it.effect('hovers the explicit form with the complete contract', () =>
  Effect.gen(function* () {
    const source = `${option}
pub fn main() -> i32 {
  let value = Option.some<i32>(41)
  let mapped = Option.map(move value, addOne)
  return mapped.unwrapOr(0)
}`
    const self = yield* analyze(source)
    const hover = Analysis.hoverSubjectAt(self, 'main', source.indexOf('Option.map(') + 7)
    assert.strictEqual(
      hover?.presentation.text,
      "pub fn map<T, U, 'life2>(self: Option<T>, transform: once fn<'life2>(T) -> U) -> main.Option<U>",
    )
  }),
)

const borrowedHolder = `struct Holder {
  slice: &[i32]
  index: usize
}
impl Holder {
  fn next(self: &mut Self) -> i32 {
    let slice = self.slice
    let index = self.index
    self.index = index + 1
    return slice[index]
  }
}
`

it.effect('keeps repeated receiver loans on a holder separate from its stored shared slice', () =>
  Effect.gen(function* () {
    for (const call of ['holder.next()', 'Holder.next(&mut holder)']) {
      const snapshot = yield* analyze(`${borrowedHolder}
pub fn main() -> i32 {
  let values: [i32; 2] = [20, 22]
  let mut holder = Holder { slice: &values, index: 0 }
  let first = ${call}
  return first + ${call}
}`)
      assert.deepEqual(Analysis.diagnostics(snapshot), [])
    }
  }),
)

it.effect('retains real wrapper and backing-owner conflicts for receiver calls', () =>
  Effect.gen(function* () {
    for (const [before, after, expectedCodes, rejected] of [
      ['let loan = &holder', 'if loan.index == 0 { return 1 } return 0', ['OWN0010'], 'holder'],
      ['values[0] = 9', 'return 0', ['OWN0011', 'OWN0019'], 'values[0]'],
    ] as const) {
      const source = `${borrowedHolder}
pub fn main() -> i32 {
  let mut values: [i32; 2] = [20, 22]
  let mut holder = Holder { slice: &values, index: 0 }
  ${before}
  let first = holder.next()
  ${after}
}`
      const snapshot = yield* analyze(source)
      assert.deepEqual(
        Analysis.diagnostics(snapshot).map((diagnostic) => diagnostic.code),
        [...expectedCodes],
      )
      const diagnostic = Analysis.diagnostics(snapshot).at(0)
      assert.strictEqual(
        diagnostic === undefined
          ? undefined
          : source.slice(diagnostic.span.start, diagnostic.span.end).trim(),
        rejected,
      )
    }
  }),
)
