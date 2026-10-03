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

it.effect('rejects a parameterized alias without reporting its parameters as unknown', () =>
  Effect.gen(function* () {
    const self = yield* analyze(`struct Point<T> { x: T y: T }
type Pair<T> = Point<T>
pub fn main() -> i32 { return 0 }`)
    assert.deepEqual(codes(self), [Diagnostic.typeAliasParametersCode])
    assert.strictEqual(memberType(self, 'root', 'Pair'), undefined)
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
