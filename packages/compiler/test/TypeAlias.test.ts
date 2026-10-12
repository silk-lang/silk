import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Analysis from '../src/Analysis.js'
import * as Diagnostic from '../src/Diagnostic.js'
import * as SourceResolver from '../src/SourceResolver.js'
import * as Type from '../src/Type.js'
import * as Json from './support/Json.js'

const ascii = (value: string): Uint8Array =>
  Uint8Array.from(value, (character) => character.charCodeAt(0))

const analyze = (text: string) => Analysis.ofSource('root', ascii(text))

const analyzeModules = (entries: ReadonlyArray<readonly [string, string]>) =>
  Analysis.make({ root: 'root' }).pipe(
    Effect.provide(
      SourceResolver.memory(
        new Map(entries.map(([module, text]) => [module, ascii(text)] as const)),
      ),
    ),
  )

const codes = (self: Analysis.FrontendSnapshot): ReadonlyArray<string> =>
  Analysis.diagnostics(self).map((diagnostic) => diagnostic.code)

const messages = (self: Analysis.FrontendSnapshot): ReadonlyArray<string> =>
  Analysis.diagnostics(self).map((diagnostic) => diagnostic.message)

const memberType = (
  self: Analysis.FrontendSnapshot,
  module: string,
  spelling: string,
): string | undefined => {
  const lookup = Analysis.memberByName(self, module, spelling)
  if (lookup._tag !== 'Resolved') return undefined
  const member = lookup.declaration
  if (member._tag === 'AliasDeclaration')
    return member.target._tag === 'Resolved' ? Type.encode(member.target.type) : undefined
  if (member._tag === 'StructDeclaration') {
    const field = member.fields.at(0)
    return field?.declaredType._tag === 'Resolved'
      ? Type.encode(field.declaredType.type)
      : undefined
  }
  if (member._tag === 'FunctionDeclaration') {
    const parameter = member.parameters.at(0)
    return parameter?.declaredType._tag === 'Resolved'
      ? Type.encode(parameter.declaredType.type)
      : undefined
  }
  return undefined
}

const failureMembers = (
  self: Analysis.FrontendSnapshot,
  module: string,
  spelling: string,
): ReadonlyArray<string> => {
  const lookup = Analysis.memberByName(self, module, spelling)
  if (lookup._tag !== 'Resolved' || lookup.declaration._tag !== 'FunctionDeclaration') return []
  return lookup.declaration.failureRow.failures.map(Type.encode)
}

it.effect('erases a union alias and injects a member at the return boundary', () =>
  Effect.gen(function* () {
    const self = yield* analyze(`struct Circle {}
struct Square {}
type Shape = Circle | Square
fn make(flag: bool) -> Shape {
  if flag { return Circle {} }
  return Square {}
}
fn describe(shape: Shape) -> i32 {
  return match move shape {
    Circle {} => 1
    Square {} => 2
  }
}
pub fn main() -> i32 { return describe(make(false)) }`)
    assert.deepEqual(codes(self), [])
    assert.strictEqual(memberType(self, 'root', 'Shape'), memberType(self, 'root', 'describe'))
    assert.strictEqual(memberType(self, 'root', 'Shape'), 'root.Circle | root.Square')
  }),
)

it.effect('constructs through an applied alias with the alias arguments, not inferred ones', () =>
  Effect.gen(function* () {
    const program = (head: string) => `struct Point<T> { x: T y: T }
type PointI32 = Point<i32>
pub fn main() -> i32 {
  let point = ${head} { x: true, y: false }
  return 0
}`
    const aliased = yield* analyze(program('PointI32'))
    const direct = yield* analyze(program('Point<i32>'))
    assert.deepEqual(codes(aliased), codes(direct))
    assert.include(codes(aliased), Diagnostic.typeArgumentConflictCode)
  }),
)

it.effect('rejects type arguments applied to an alias of a non-nominal type', () =>
  Effect.gen(function* () {
    const self = yield* analyze(`struct Circle {}
struct Square {}
type Shape = Circle | Square
type Meters = i32
fn shape(value: Shape<i32>) -> i32 { return 0 }
fn meters(value: Meters<bool>) -> i32 { return 0 }
pub fn main() -> i32 { return 0 }`)
    assert.deepEqual(codes(self), [
      Diagnostic.typeArgumentArityCode,
      Diagnostic.typeArgumentArityCode,
    ])
  }),
)

it.effect('presents the erased target and not the alias name in diagnostics', () =>
  Effect.gen(function* () {
    const self = yield* analyze(`struct Circle {}
struct Square {}
struct Triangle {}
type Shape = Circle | Square
fn take(shape: Shape) -> i32 { return 0 }
pub fn main() -> i32 { return take(Triangle {}) }`)
    const mismatch = messages(self).find((message) => message.includes('Circle'))
    assert.notStrictEqual(mismatch, undefined, Json.stringify(messages(self)))
    assert.include(mismatch ?? '', 'Square')
    assert.notInclude(mismatch ?? '', 'Shape')
  }),
)

it.effect('rejects a two-alias cycle once per declaration and keeps other aliases available', () =>
  Effect.gen(function* () {
    const self = yield* analyze(`type A = B
type B = A
type Fine = i32
fn use(value: A) -> i32 { return 0 }
pub fn main() -> i32 { return 0 }`)
    const cyclic = Analysis.diagnostics(self).filter(
      (diagnostic) => diagnostic.code === Diagnostic.cyclicTypeAliasCode,
    )
    assert.strictEqual(cyclic.length, 2, Json.stringify(messages(self)))
    assert.deepEqual(
      cyclic.map((diagnostic) => diagnostic.relatedSpans?.length ?? 0),
      [1, 1],
    )
    assert.strictEqual(memberType(self, 'root', 'A'), undefined)
    assert.strictEqual(memberType(self, 'root', 'B'), undefined)
    assert.strictEqual(memberType(self, 'root', 'Fine'), 'i32')
  }),
)

it.effect('rejects a self-referential alias through a union', () =>
  Effect.gen(function* () {
    const self = yield* analyze(`struct Leaf {}
type Tree = Leaf | Tree
pub fn main() -> i32 { return 0 }`)
    assert.deepEqual(
      codes(self).filter((code) => code === Diagnostic.cyclicTypeAliasCode),
      [Diagnostic.cyclicTypeAliasCode],
    )
    assert.strictEqual(memberType(self, 'root', 'Tree'), undefined)
  }),
)

it.effect('rejects an alias name that collides with another declaration', () =>
  Effect.gen(function* () {
    const source = `struct Token {}
type Token = i32
pub fn main() -> i32 { return 0 }`
    const self = yield* analyze(source)
    const collision = Analysis.diagnostics(self).find(
      (diagnostic) => diagnostic.code === Diagnostic.duplicateDeclarationNameCode,
    )
    assert.isDefined(collision)
    assert.strictEqual(collision?.span.start, source.indexOf('Token = i32'))
    assert.strictEqual(
      collision?.reason._tag === 'DuplicateDeclarationName'
        ? collision.reason.originalSpan.start
        : undefined,
      source.indexOf('Token {}'),
    )
  }),
)

it.effect('substitutes the written arguments into a generic alias and renormalizes unions', () =>
  Effect.gen(function* () {
    const self = yield* analyze(`struct Pair<A, B> { first: A second: B }
struct IoError {}
struct Left {}
struct Right {}
type IntPair<V> = Pair<i32, V>
type Fallible<T> = T | IoError
type Ref<'a, T> = &'a T
fn pair(value: IntPair<bool>) -> i32 { return 0 }
fn direct(value: Pair<i32, bool>) -> i32 { return 0 }
fn collapsed(value: Fallible<IoError>) -> i32 { return 0 }
fn widened(value: Fallible<Left | Right>) -> i32 { return 0 }
fn nested(value: Fallible<Fallible<Left>>) -> i32 { return 0 }
fn borrowed<'a>(value: Ref<'a, i32>) -> &'a i32 { return value }
pub fn main() -> i32 { return 0 }`)
    assert.deepEqual(codes(self), [], Json.stringify(messages(self)))
    assert.strictEqual(memberType(self, 'root', 'pair'), memberType(self, 'root', 'direct'))
    assert.strictEqual(memberType(self, 'root', 'collapsed'), 'root.IoError')
    assert.strictEqual(memberType(self, 'root', 'widened'), 'root.IoError | root.Left | root.Right')
    assert.strictEqual(memberType(self, 'root', 'nested'), 'root.IoError | root.Left')
  }),
)

it.effect('elides a lifetime an alias target omits at each use, as a struct header does', () =>
  Effect.gen(function* () {
    const source = `type Borrow = &i32
type Bytes = &[u8]
type Use = fn(i32) -> i32
type Generic<T> = &T
fn same(value: Borrow) -> Borrow { return value }
fn first(bytes: Bytes) -> u8 { return bytes[0] }
fn call(callback: Use) -> i32 { return callback(1) }
fn generic(value: Generic<i32>) -> i32 { return value.* }
fn two(left: Borrow, right: Borrow) -> Borrow { return left }
fn twoWritten(left: &i32, right: &i32) -> &i32 { return left }
pub fn main() -> i32 { return 0 }`
    const self = yield* analyze(source)
    // Each use elides as the written-out target would. An ambiguous output is reported like one
    // on a struct header: the elision failure, then the use's missing lifetime argument.
    assert.deepEqual(
      Analysis.diagnostics(self).map((diagnostic) => [diagnostic.code, diagnostic.span.start]),
      [
        [Diagnostic.typeArgumentArityCode, source.indexOf('Borrow { return left }')],
        [Diagnostic.ambiguousLifetimeElisionCode, source.indexOf('Borrow { return left }')],
        [Diagnostic.ambiguousLifetimeElisionCode, source.indexOf('&i32 { return left }')],
      ],
      Json.stringify(messages(self)),
    )
  }),
)

it.effect('rejects bounded, row-kind and unused generic alias parameters at the parameter', () =>
  Effect.gen(function* () {
    const source = `interface Marker {}
struct Point<T> { x: T y: T }
type Bounded<T: Marker> = Point<T>
type Rowed<?R> = Effect<i32 ? R>
type Unused<T> = i32
fn bounded(value: Bounded<i32>) -> i32 { return 0 }
fn rowed(value: Rowed<?>) -> i32 { return 0 }
fn unused(value: Unused<bool>) -> i32 { return 0 }
pub fn main() -> i32 { return 0 }`
    const self = yield* analyze(source)
    const rejected = Analysis.diagnostics(self).filter(
      (diagnostic) => diagnostic.code === Diagnostic.typeAliasParametersCode,
    )
    assert.deepEqual(
      rejected.map((diagnostic) => [
        diagnostic.span.start,
        diagnostic.reason._tag === 'TypeAliasParameters' ? diagnostic.reason.problem : undefined,
      ]),
      [
        [source.indexOf('T: Marker'), 'Bounded'],
        [source.indexOf('?R>'), 'Kind'],
        [source.indexOf('T> = i32'), 'Unused'],
      ],
      Json.stringify(messages(self)),
    )
  }),
)

it.effect('requires every generic alias argument at the use and never infers one', () =>
  Effect.gen(function* () {
    const source = `struct IoError {}
struct Left {}
type Fallible<T> = T | IoError
fn bare(value: Fallible) -> i32 { return 0 }
fn extra(value: Fallible<Left, Left>) -> i32 { return 0 }
fn take<T>(value: Fallible<T>) -> i32 { return 0 }
pub fn main() -> i32 {
  let inferred = take(Left {})
  return take<Left>(Left {})
}`
    const self = yield* analyze(source)
    assert.deepEqual(
      Analysis.diagnostics(self).map((diagnostic) => [diagnostic.code, diagnostic.span.start]),
      [
        [Diagnostic.typeArgumentArityCode, source.indexOf('Fallible) ->')],
        [Diagnostic.typeArgumentArityCode, source.indexOf('Fallible<Left, Left>')],
        [Diagnostic.typeArgumentInferenceCode, source.indexOf('take(Left')],
      ],
      Json.stringify(messages(self)),
    )
  }),
)

it.effect('accepts an applied target and rejects further arguments on the alias', () =>
  Effect.gen(function* () {
    const accepted = yield* analyze(`struct Point<T> { x: T y: T }
type Pair = Point<i32>
pub fn main() -> i32 { return 0 }`)
    assert.deepEqual(codes(accepted), [])
    assert.include(memberType(accepted, 'root', 'Pair') ?? '', 'Point<i32>')
    const rejected = yield* analyze(`struct Point<T> { x: T y: T }
type Pair = Point<i32>
fn use(value: Pair<bool>) -> i32 { return 0 }
pub fn main() -> i32 { return 0 }`)
    assert.include(codes(rejected), Diagnostic.typeArgumentArityCode)
  }),
)

it.effect('rejects a public alias that exposes a private type', () =>
  Effect.gen(function* () {
    const self = yield* analyze(`struct Hidden {}
pub type Leaked = Hidden
pub fn main() -> i32 { return 0 }`)
    assert.include(codes(self), Diagnostic.privateTypeExposureCode)
    assert.strictEqual(memberType(self, 'root', 'Leaked'), undefined)
  }),
)

it.effect('refuses an alias in value position', () =>
  Effect.gen(function* () {
    const self = yield* analyze(`type Count = i32
pub fn main() -> i32 { return Count }`)
    assert.include(codes(self), Diagnostic.unknownValueReferenceCode)
    assert.notInclude(codes(self), Diagnostic.cyclicTypeAliasCode)
  }),
)

it.effect('resolves a public alias through selected and qualified imports', () =>
  Effect.gen(function* () {
    const lib = `pub struct HttpError {}
pub struct JsonError {}
pub type FetchError = HttpError | JsonError
type Secret = i32
pub effect fn fetch() -> i32 ! FetchError { fail HttpError {} }`
    const self = yield* analyzeModules([
      [
        'root',
        `import lib
import lib { FetchError }
effect fn selected() -> i32 ! FetchError { return run lib.fetch() }
effect fn qualified() -> i32 ! lib.FetchError { return run lib.fetch() }
pub fn main() -> i32 { return 0 }`,
      ],
      ['lib', lib],
    ])
    assert.deepEqual(codes(self), [])
    assert.deepEqual(failureMembers(self, 'root', 'selected'), failureMembers(self, 'lib', 'fetch'))
    assert.deepEqual(
      failureMembers(self, 'root', 'qualified'),
      failureMembers(self, 'lib', 'fetch'),
    )
    const hidden = yield* analyzeModules([
      [
        'root',
        `import lib\nfn use(value: lib.Secret) -> i32 { return 0 }\npub fn main() -> i32 { return 0 }`,
      ],
      ['lib', lib],
    ])
    assert.include(codes(hidden), Diagnostic.inaccessibleImportedMemberCode)
  }),
)

it.effect('names an interface through an alias in bounds, impl heads and operation calls', () =>
  Effect.gen(function* () {
    const self = yield* analyze(`interface Label { fn label(value: &Self) -> i32 }
interface Combine<Right, Output> { fn combine(left: Self, right: Right) -> Output }
type Labeled = Label
type CombineTag = Combine<i32, i32>
struct Tag { value: i32 }
impl Tag {
  fn tagLabel(value: &Tag) -> i32 { return value.value }
  fn tagCombine(left: Tag, right: i32) -> i32 { return left.value + right }
}
impl Labeled for Tag { label: Tag.tagLabel }
impl CombineTag for Tag { combine: Tag.tagCombine }
fn bounded<T: Labeled>(value: &T) -> i32 { return Labeled.label(value) }
pub fn main() -> i32 {
  let tag = Tag { value: 1 }
  return bounded(&tag) + Labeled.label(&tag) + CombineTag.combine(move tag, 2)
}`)
    assert.deepEqual(codes(self), [], Json.stringify(messages(self)))
  }),
)

it.effect(
  'names a generic interface alias in bounds, impl heads and qualified operation calls',
  () =>
    Effect.gen(function* () {
      const source = `interface Combine<Right, Output> {
  fn combine(left: Self, right: Right) -> Output
}
type Same<T> = Combine<T, T>
struct Tag { value: i32 }
impl Tag { fn tagCombine(left: Tag, right: i32) -> i32 { return left.value + right } }
impl Same<i32> for Tag { combine: Tag.tagCombine }
fn bounded<T: Same<i32>>(value: T) -> i32 { return Same<i32>.combine(move value, 1) }
fn bare(value: Tag) -> i32 { return Same.combine(move value, 1) }
pub fn main() -> i32 { return bounded(Tag { value: 1 }) }`
      const self = yield* analyze(source)
      assert.deepEqual(
        Analysis.diagnostics(self).map((diagnostic) => [diagnostic.code, diagnostic.span.start]),
        [[Diagnostic.typeArgumentArityCode, source.indexOf('Same.combine')]],
        Json.stringify(messages(self)),
      )
    }),
)

it.effect('calls through an applied interface alias with the alias arguments', () =>
  Effect.gen(function* () {
    const program = (qualifier: string) => `interface Combine<Right, Output> {
  fn combine(left: Self, right: Right) -> Output
}
type CombineTag = Combine<i32, i32>
struct Tag { value: i32 }
impl Tag { fn tagCombine(left: Tag, right: i32) -> i32 { return left.value + right } }
impl CombineTag for Tag { combine: Tag.tagCombine }
pub fn main() -> i32 { return ${qualifier}.combine(Tag { value: 1 }, true) }`
    const aliased = yield* analyze(program('CombineTag'))
    const direct = yield* analyze(program('Combine<i32, i32>'))
    assert.deepEqual(codes(aliased), codes(direct))
    assert.deepEqual(codes(aliased), [Diagnostic.argumentTypeMismatchCode])
  }),
)

it.effect('applies use-site arguments to an alias of an unapplied generic declaration', () =>
  Effect.gen(function* () {
    const source = `interface Combine<Right, Output> {
  fn combine(left: Self, right: Right) -> Output
}
struct Point<T> { x: T y: T }
type Combining = Combine
type Pointed = Point
struct Tag { value: i32 }
impl Tag { fn tagCombine(left: Tag, right: i32) -> i32 { return left.value + right } }
impl Combining<i32, i32> for Tag { combine: Tag.tagCombine }
fn bounded<T: Combining<i32, i32>>(value: T) -> i32 { return Combining<i32, i32>.combine(move value, 1) }
fn first(point: Pointed<i32>) -> i32 { return point.x }
fn bare(point: Pointed) -> i32 { return 0 }
fn extra(point: Pointed<i32, i32>) -> i32 { return 0 }
pub fn main() -> i32 {
  return bounded(Tag { value: 1 }) + first(Pointed<i32> { x: 2, y: 3 }) + Combining.combine(Tag { value: 4 }, 5)
}`
    const self = yield* analyze(source)
    assert.deepEqual(
      Analysis.diagnostics(self).map((diagnostic) => [diagnostic.code, diagnostic.span.start]),
      [
        [Diagnostic.typeArgumentArityCode, source.indexOf('Pointed) ->')],
        [Diagnostic.typeArgumentArityCode, source.indexOf('Pointed<i32, i32>')],
      ],
      Json.stringify(messages(self)),
    )
    assert.strictEqual(memberType(self, 'root', 'first'), 'root.Point<i32>')
  }),
)

it.effect('applies use-site arguments to a public alias of a generic interface', () =>
  Effect.gen(function* () {
    const source = `pub interface Add0<Right, Output> {
  fn add(left: Self, right: Right) -> Output
}
pub type Add = Add0
struct Tag { value: i32 }
impl Tag { fn tagAdd(left: Tag, right: i32) -> i32 { return left.value + right } }
impl Add<i32, i32> for Tag { add: Tag.tagAdd }
fn sum<T: Add<i32, i32>>(left: T, right: i32) -> i32 { return Add.add(move left, right) }
fn miscounted<T: Add<i32>>(left: T) -> i32 { return 0 }
fn unapplied<T: Add>(left: T) -> i32 { return 0 }
pub fn main() -> i32 { return sum(Tag { value: 1 }, 2) }`
    const self = yield* analyze(source)
    assert.deepEqual(
      Analysis.diagnostics(self).map((diagnostic) => [diagnostic.code, diagnostic.span.start]),
      [
        [Diagnostic.typeArgumentArityCode, source.indexOf('Add<i32>>')],
        [Diagnostic.typeArgumentArityCode, source.indexOf('Add>(')],
      ],
      Json.stringify(messages(self)),
    )
  }),
)

it.effect('names the sealed Copy and Drop properties through Intrinsic and silk.ownership', () =>
  Effect.gen(function* () {
    const self = yield* analyze(`import silk.ownership
import silk.ownership { Copy }
type Dup = Intrinsic.Copy
struct Pixel { value: i32 }
impl ownership.Copy for Pixel {}
struct Point { x: i32 }
impl Copy for Point {}
struct Cell { value: i32 }
impl Dup for Cell {}
struct Handle { value: i32 }
impl Intrinsic.Drop for Handle { fn drop(self: &mut Handle) -> () { return () } }
struct Guard { value: i32 }
impl ownership.Drop for Guard { fn drop(self: &mut Guard) -> () { return () } }
fn qualified<T: Intrinsic.Copy>(value: T) -> i32 { let first = value let second = value return 1 }
fn imported<T: ownership.Copy>(value: T) -> i32 { let first = value let second = value return 1 }
fn aliased<T: Dup>(value: T) -> i32 { let first = value let second = value return 1 }
pub fn main() -> i32 {
  return qualified(Pixel { value: 1 }) + imported(Point { x: 1 }) + aliased(Cell { value: 1 })
}`)
    assert.deepEqual(codes(self), [], Json.stringify(messages(self)))
  }),
)

it.effect('treats every spelling of Copy as one conformance and one bound', () =>
  Effect.gen(function* () {
    const source = `import silk.ownership
type Dup = Intrinsic.Copy
struct Pixel { value: i32 }
impl ownership.Copy for Pixel {}
impl Intrinsic.Copy for Pixel {}
impl Dup for Pixel {}
struct Owned { value: i32 }
fn qualified<T: Intrinsic.Copy>(value: T) -> i32 { return 0 }
fn imported<T: ownership.Copy>(value: T) -> i32 { return 0 }
pub fn main() -> i32 {
  let first = qualified(Owned { value: 1 })
  let second = imported(Owned { value: 2 })
  return 0
}`
    const self = yield* analyze(source)
    assert.deepEqual(
      Analysis.diagnostics(self).map((diagnostic) => [diagnostic.code, diagnostic.span.start]),
      [
        [Diagnostic.invalidConformanceCode, source.indexOf('impl Intrinsic.Copy for Pixel')],
        [Diagnostic.invalidConformanceCode, source.indexOf('impl Dup for Pixel')],
        [Diagnostic.invalidConformanceCode, source.indexOf('qualified(Owned')],
        [Diagnostic.invalidConformanceCode, source.indexOf('imported(Owned')],
      ],
      Json.stringify(messages(self)),
    )
  }),
)
