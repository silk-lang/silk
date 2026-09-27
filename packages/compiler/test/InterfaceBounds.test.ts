import * as Layer from 'effect/Layer'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Analysis from '../src/Analysis.js'
import * as SourceFile from '../src/SourceFile.js'
import * as SourceResolver from '../src/SourceResolver.js'

const encoder = new TextEncoder()

const snapshot = (source: string) =>
  Analysis.ofSource('interface-bounds/main', encoder.encode(source))

const messages = (self: Analysis.FrontendSnapshot): ReadonlyArray<string> =>
  Analysis.diagnostics(self).map((diagnostic) => diagnostic.message)

/**
 * Two operations on one bound. `combine` calls both — `+` selects `add` and `-` selects
 * `subtract` — over the canonical parameter, once, before any concrete argument exists.
 */
const twoOperations = `pub interface Arith {
  operator + fn add(left: Self, right: Self) -> Self
  operator - fn subtract(left: Self, right: Self) -> Self
}
impl Arith for i32 { add: Intrinsic.i32Add subtract: Intrinsic.i32Subtract }
pub fn combine<T: Arith>(left: T, right: T, offset: T) -> T {
  return (move left + move right) - move offset
}
pub fn main() -> i32 { return combine(40, 44, 40) }`

it.effect('rejects a type argument whose witness omits one bound operation', () =>
  Effect.gen(function* () {
    const self = yield* snapshot(`pub interface Arith {
  operator + fn add(left: Self, right: Self) -> Self
  operator - fn subtract(left: Self, right: Self) -> Self
}
impl Arith for i32 { add: Intrinsic.i32Add }
pub fn combine<T: Arith>(left: T, right: T, offset: T) -> T {
  return (move left + move right) - move offset
}
pub fn main() -> i32 { return combine(40, 44, 40) }`)
    // The specialization names the operation the witness never supplied, not just the interface.
    assert.include(messages(self), 'Invalid conformance: i32 does not implement Arith.subtract')
  }),
)

it.effect('rejects a type argument with no witness for the bound', () =>
  Effect.gen(function* () {
    const self = yield* snapshot(`pub interface Arith {
  operator + fn add(left: &Self, right: &Self) -> Self
  operator - fn subtract(left: &Self, right: &Self) -> Self
}
impl Arith for i32 { add: Intrinsic.i32Add subtract: Intrinsic.i32Subtract }
pub fn combine<T: Arith>(left: T, right: T) -> T {
  return &((&left) + (&right)) - (&left)
}
pub fn main() -> i32 {
  let wide = combine<i64>(40, 44)
  return 0
}`)
    assert.include(messages(self), 'Invalid conformance: i64 does not implement Arith')
  }),
)

it.effect('reports a bound that names no reachable interface', () =>
  Effect.gen(function* () {
    const self = yield* snapshot(`pub struct Holder<T> { value: T }
pub fn combine<T: Holder>(left: T, right: T) -> T { return left + right }
pub fn main() -> i32 { return combine(40, 2) }`)
    assert.include(messages(self), 'Invalid conformance: unknown interface constraint Holder')
  }),
)

it.effect('rejects an unrun effectful bound operation at the generic return boundary', () =>
  Effect.gen(function* () {
    const self = yield* snapshot(`interface Decoder {
  effect fn decode(value: &Self) -> i32
}
struct Schema {}
effect fn decodeSchema(value: &Schema) -> i32 { return 42 }
impl Decoder for Schema { decode: Schema.decodeSchema }
effect fn decodeWith<T: Decoder>(value: &T) -> i32 {
  return Decoder.decode(value)
}
pub fn main() -> i32 {
  let schema = Schema {}
  return run decodeWith<Schema>(&schema)
}`)

    assert.deepEqual(
      Analysis.diagnostics(self).map((diagnostic) => ({
        code: diagnostic.code,
        reason: diagnostic.reason._tag,
        sourceId: diagnostic.span.sourceId,
      })),
      // The bound operation's borrowed input is retained by its Effect exactly as a direct
      // generic call's is, so escaping that Effect also expires the borrow.
      [
        { code: 'OWN0019', reason: 'ExpiredLifetime', sourceId: 'interface-bounds/main' },
        { code: 'OWN0019', reason: 'ExpiredLifetime', sourceId: 'interface-bounds/main' },
        { code: 'SEM0129', reason: 'ReturnTypeMismatch', sourceId: 'interface-bounds/main' },
      ],
    )
  }),
)

it.effect('keeps a mapped witness with an invalid body out of target-dependent phases', () =>
  Effect.gen(function* () {
    const self = yield* snapshot(`interface Decoder {
  fn decode(value: &Self) -> i32
}
struct Schema {}
fn decodeSchema(value: &Schema) -> i32 { return true }
impl Decoder for Schema { decode: Schema.decodeSchema }
fn decodeWith<T: Decoder>(value: &T) -> i32 { return Decoder.decode(value) }
pub fn main() -> i32 {
  let schema = Schema {}
  return decodeWith<Schema>(&schema)
}`)

    assert.deepEqual(
      Analysis.diagnostics(self).map((diagnostic) => diagnostic.code),
      ['SEM0129'],
    )
  }),
)

it.effect('rejects a repeated normalized member of a bound conjunction', () =>
  Effect.gen(function* () {
    const self = yield* snapshot(`interface Display { fn display(value: &Self) -> i32 }
fn inspect<T: Display + Display>(value: &T) -> i32 { return Display.display(value) }
pub fn main() -> i32 { return 0 }`)
    assert.include(messages(self), 'Invalid conformance: duplicate bound Display')
  }),
)

it.effect('admits an interface-owned implementation for an imported nominal provider', () =>
  Effect.gen(function* () {
    const model = encoder.encode('pub struct Rectangle {}')
    const root = SourceFile.make(
      'contracts',
      encoder.encode(`import model { Rectangle }
pub interface Shape { fn area(value: &Self) -> i32 }
impl Shape for Rectangle {
  fn area(value: &Self) -> i32 { return 42 }
}`),
    )
    const self = yield* Analysis.make({ root: root.id }).pipe(
      Effect.provide(
        SourceResolver.overlay([root]).pipe(
          Layer.provideMerge(SourceResolver.memory(new Map([['model', model]]))),
        ),
      ),
    )
    assert.deepEqual(Analysis.diagnostics(self), [])
  }),
)

it.effect('rejects a conformance outside both the interface and provider modules', () =>
  Effect.gen(function* () {
    const model = encoder.encode(`pub interface Shape { fn area(value: &Self) -> i32 }
pub struct Rectangle {}`)
    const root = SourceFile.make(
      'consumer',
      encoder.encode(`import model { Shape, Rectangle }
impl Shape for Rectangle {
  fn area(value: &Self) -> i32 { return 42 }
}
pub fn main() -> i32 { return 0 }`),
    )
    const self = yield* Analysis.make({ root: root.id }).pipe(
      Effect.provide(
        SourceResolver.overlay([root]).pipe(
          Layer.provideMerge(SourceResolver.memory(new Map([['model', model]]))),
        ),
      ),
    )
    assert.deepEqual(
      Analysis.diagnostics(self).map((diagnostic) => ({
        code: diagnostic.code,
        span: diagnostic.span.sourceId,
      })),
      [{ code: 'SEM0083', span: 'consumer' }],
    )
  }),
)

it.effect('keeps provider-owned implementations valid', () =>
  Effect.gen(function* () {
    const contracts = encoder.encode('pub interface Shape { fn area(value: &Self) -> i32 }')
    const root = SourceFile.make(
      'model',
      encoder.encode(`import contracts { Shape }
pub struct Rectangle {}
impl Shape for Rectangle {
  fn area(value: &Self) -> i32 { return 42 }
}`),
    )
    const self = yield* Analysis.make({ root: root.id }).pipe(
      Effect.provide(
        SourceResolver.overlay([root]).pipe(
          Layer.provideMerge(SourceResolver.memory(new Map([['contracts', contracts]]))),
        ),
      ),
    )
    assert.deepEqual(Analysis.diagnostics(self), [])
  }),
)

it.effect('keeps a scalar conformance in the source contract module', () =>
  Effect.gen(function* () {
    const contracts = encoder.encode(`pub interface Present {
  fn present(value: &Self) -> i32
}`)
    const root = SourceFile.make(
      'consumer',
      encoder.encode(`import contracts { Present }
impl Present for i32 {
  fn present(value: &Self) -> i32 { return 42 }
}
pub fn main() -> i32 { return 0 }`),
    )
    const self = yield* Analysis.make({ root: root.id }).pipe(
      Effect.provide(
        SourceResolver.overlay([root]).pipe(
          Layer.provideMerge(SourceResolver.memory(new Map([['contracts', contracts]]))),
        ),
      ),
    )
    assert.include(
      messages(self),
      "Invalid conformance: implementation for i32 must be declared in contracts, the contract's module for scalar and string providers",
    )
  }),
)

it.effect('keeps a string conformance inline in the source contract module', () =>
  Effect.gen(function* () {
    const self = yield* snapshot(`interface Present {
  fn present(value: &Self) -> i32
}
impl<'text> Present for string<'text> {
  fn present(value: &Self) -> i32 { return 42 }
}
fn present<T: Present>(value: &T) -> i32 { return Present.present(value) }
pub fn main() -> i32 { let text = "Silk" return present(&text) }`)
    assert.deepEqual(Analysis.diagnostics(self), [])
  }),
)

it.effect('admits borrowed string and imported owned String in one interface module', () =>
  Effect.gen(function* () {
    const self = yield* snapshot(`import silk.string { String }
interface Present {
  fn present(value: &Self) -> i32
}
impl<'text> Present for string<'text> {
  fn present(value: &Self) -> i32 { return 1 }
}
impl Present for String {
  fn present(value: &Self) -> i32 { return 2 }
}
pub fn main() -> i32 { return 0 }`)
    assert.deepEqual(Analysis.diagnostics(self), [])
  }),
)

it.effect('rejects a string conformance outside the source contract module', () =>
  Effect.gen(function* () {
    const contracts = encoder.encode(`pub interface Present {
  fn present(value: &Self) -> i32
}`)
    const root = SourceFile.make(
      'consumer',
      encoder.encode(`import contracts { Present }
impl<'text> Present for string<'text> {
  fn present(value: &Self) -> i32 { return 42 }
}
pub fn main() -> i32 { return 0 }`),
    )
    const self = yield* Analysis.make({ root: root.id }).pipe(
      Effect.provide(
        SourceResolver.overlay([root]).pipe(
          Layer.provideMerge(SourceResolver.memory(new Map([['contracts', contracts]]))),
        ),
      ),
    )
    assert.deepEqual(
      Analysis.diagnostics(self).map((diagnostic) => diagnostic.code),
      ['SEM0083'],
    )
  }),
)

it.effect('rejects structural source-interface providers', () =>
  Effect.gen(function* () {
    const self = yield* snapshot(`interface Present {
  fn present(value: &Self) -> i32
}
impl Present for [i32; 1] {
  fn present(value: &Self) -> i32 { return 42 }
}
pub fn main() -> i32 { return 0 }`)
    assert.include(
      messages(self),
      'Invalid conformance: interface and service providers must be nominal types, scalar types, or string',
    )
  }),
)

it.effect('reports a bound operation reachable through two bounded parameters', () =>
  Effect.gen(function* () {
    const self = yield* snapshot(`pub interface Mixer {
  fn mix(left: Self, right: Self) -> Self
}
impl Mixer for i32 { mix: Intrinsic.i32WrappingAdd }
pub fn blend<A: Mixer, B: Mixer>(left: A, right: B) -> A {
  return Mixer.mix(move left, move left)
}
pub fn main() -> i32 { return blend<i32, i32>(40, 2) }`)
    assert.include(messages(self), 'Mixer.mix is ambiguous across bounded type parameters A, B')
  }),
)

it.effect('reports a bound operation the interface never declares', () =>
  Effect.gen(function* () {
    const self = yield* snapshot(`pub interface Mixer {
  fn mix(left: Self, right: Self) -> Self
}
impl Mixer for i32 { mix: Intrinsic.i32WrappingAdd }
pub fn blend<T: Mixer>(left: T, right: T) -> T {
  return Mixer.stir(move left, move right)
}
pub fn main() -> i32 { return blend(40, 2) }`)
    assert.include(messages(self), 'Mixer has no operation stir')
  }),
)

it.effect('records the resolved bound contract on the declaration it belongs to', () =>
  Effect.gen(function* () {
    const self = yield* snapshot(twoOperations)
    const declaration = Analysis.declarationIndex(self)
      .modules.find((module) => module.module === 'interface-bounds/main')
      ?.declarations.find(
        (candidate) => candidate.name._tag === 'Present' && candidate.name.spelling === 'combine',
      )
    const bound = declaration?.typeParameters.at(0)?.bounds.at(0)
    assert.strictEqual(bound?._tag, 'ResolvedBound')
    if (bound?._tag !== 'ResolvedBound') return
    assert.strictEqual(bound.spelling, 'Arith')
    assert.deepEqual(bound.application.declaration, {
      _tag: 'CanonicalDeclarationId',
      module: 'interface-bounds/main',
      name: 'Arith',
    })
    assert.deepEqual(
      bound.application.operations.map((operation) =>
        operation.declaration.name._tag === 'Present'
          ? operation.declaration.name.spelling
          : 'Unavailable',
      ),
      ['add', 'subtract'],
    )
  }),
)
