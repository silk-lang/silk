import * as Layer from 'effect/Layer'
import * as ForeignContract from '../src/ForeignContract.js'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Analysis from '../src/Analysis.js'
import * as CleanupPlan from '../src/CleanupPlan.js'
import * as ConformanceProof from '../src/ConformanceProof.js'
import * as DeclarationFacts from '../src/DeclarationFacts.js'
import * as Diagnostic from '../src/Diagnostic.js'
import type * as DeclarationIndex from '../src/DeclarationIndex.js'
import * as LifetimeElision from '../src/LifetimeElision.js'
import type * as AuthoredHir from '../src/AuthoredHir.js'
import * as AuthoredWalk from '../src/AuthoredWalk.js'
import type * as DeclarationLifetime from '../src/DeclarationLifetime.js'
import * as SemanticContext from '../src/SemanticContext.js'
import type * as SyntaxFile from '../src/SyntaxFile.js'
import * as Option from 'effect/Option'
import * as Lifetime from '../src/Lifetime.js'
import * as ModuleClosure from '../src/ModuleClosure.js'
import * as NameResolution from '../src/NameResolution.js'
import * as SemanticDisplay from '../src/SemanticDisplay.js'
import type * as Scalar from '../src/Scalar.js'
import * as SourceFile from '../src/SourceFile.js'
import * as SourceResolver from '../src/SourceResolver.js'
import * as Type from '../src/Type.js'
import { unreachable } from './support/raise.js'

const ascii = (value: string): Uint8Array =>
  Uint8Array.from(value, (character) => character.charCodeAt(0))

/** An index as these tests read it: its diagnostics carry the fixture's spans. */
type PublishedIndex = DeclarationIndex.Index & {
  readonly published: ReadonlyArray<Diagnostic.Diagnostic>
}

const published = (closure: ModuleClosure.Facts): PublishedIndex => {
  const index = NameResolution.analyze(closure).index
  return Object.freeze({
    ...index,
    published: Diagnostic.merge(
      Diagnostic.publishAll(index.diagnostics, SemanticContext.fromModules(closure.modules)),
    ),
  })
}

const collect = (
  rootModule: string,
  entries: ReadonlyArray<readonly [string, string]>,
): Effect.Effect<PublishedIndex, ModuleClosure.ModuleClosureError> => {
  const rootText = entries.find(([name]) => name === rootModule)?.[1]
  if (rootText === undefined) throw new RangeError(`Fixture has no root source ${rootModule}`)
  return Effect.map(
    ModuleClosure.load({ root: rootModule }).pipe(
      Effect.provide(
        SourceResolver.overlay([SourceFile.make(rootModule, ascii(rootText))]).pipe(
          Layer.provideMerge(
            SourceResolver.memory(
              new Map(
                entries
                  .filter(([name]) => name !== rootModule)
                  .map(([name, text]) => [name, ascii(text)] as const),
              ),
            ),
          ),
        ),
      ),
    ),
    published,
  )
}

/**
 * The closure alongside its index, for the refactor that plans text edits.
 *
 * `LifetimeElision.makeExplicit` is a source action, so it needs the closure module's concrete
 * syntax for byte offsets; every lifetime decision it applies still comes from the elaboration.
 */
const collectWithClosure = (
  rootModule: string,
  entries: ReadonlyArray<readonly [string, string]>,
): Effect.Effect<
  { readonly index: PublishedIndex; readonly closure: ModuleClosure.Facts },
  ModuleClosure.ModuleClosureError
> => {
  const rootText = entries.find(([name]) => name === rootModule)?.[1]
  if (rootText === undefined) throw new RangeError(`Fixture has no root source ${rootModule}`)
  return Effect.map(
    ModuleClosure.load({ root: rootModule }).pipe(
      Effect.provide(
        SourceResolver.overlay([SourceFile.make(rootModule, ascii(rootText))]).pipe(
          Layer.provideMerge(
            SourceResolver.memory(
              new Map(
                entries
                  .filter(([name]) => name !== rootModule)
                  .map(([name, text]) => [name, ascii(text)] as const),
              ),
            ),
          ),
        ),
      ),
    ),
    (closure) => Object.freeze({ index: published(closure), closure }),
  )
}

/** The root module's concrete syntax, which the lifetime source action edits. */
const rootSyntax = (closure: ModuleClosure.Facts) => {
  const found = closure.modules.find((module) => module.name === 'root')?.syntax
  if (found === undefined) throw new RangeError('Fixture closure has no root module')
  return found
}

/**
 * Plans one header expansion.
 *
 * The elaboration is plain data, so the refactor takes the semantic context and the authored
 * declaration beside it; both come from the closure the index was collected from.
 */
const planExplicit = (
  closure: ModuleClosure.Facts,
  syntax: SyntaxFile.SyntaxFile,
  member: { readonly anchor: AuthoredHir.Anchor },
  context: DeclarationLifetime.Context,
  executable?: Type.ExecutableLifetimes,
) => {
  const registry = SemanticContext.fromModules(closure.modules)
  const semantic = registry.of(member.anchor)
  if (semantic === undefined) throw new RangeError('Fixture closure has no semantic context')
  const declaration = AuthoredWalk.declarationOf(semantic.module, member.anchor.owner)
  if (declaration === undefined) throw new RangeError('Fixture closure has no authored declaration')
  return LifetimeElision.makeExplicit(syntax, semantic, declaration, context, executable)
}

it.effect('indexes canonical scalar enums with exact representations and bigint sequences', () =>
  Effect.gen(function* () {
    const index = yield* collect('root', [
      [
        'root',
        `pub enum Direction { North, East = 5, South }
enum(i64) Signed { Minimum = -9223372036854775808, Next }`,
      ],
    ])
    const enums = index.modules.at(0)?.enums ?? []
    const direction = enums.at(0)
    const signed = enums.at(1)

    assert.strictEqual(direction?.canonical._tag, 'Canonical')
    assert.deepEqual(direction?.canonical, {
      _tag: 'Canonical',
      id: { _tag: 'CanonicalDeclarationId', module: 'root', name: 'Direction' },
    })
    assert.strictEqual(direction?.visibility, 'Public')
    assert.strictEqual(direction?.representation._tag, 'Available')
    assert.strictEqual(
      direction?.representation._tag === 'Available'
        ? direction.representation.scalar.spelling
        : undefined,
      'u8',
    )
    assert.strictEqual(
      direction?.representation._tag === 'Available'
        ? direction.representation.explicit
        : undefined,
      false,
    )
    assert.deepEqual(
      direction?.members.map((member) => ({
        canonical: member.canonical,
        value:
          member.discriminant._tag === 'Available'
            ? member.discriminant.value
            : member.discriminant._tag,
        source: member.discriminant.source,
      })),
      [
        {
          canonical: {
            _tag: 'Canonical',
            id: {
              _tag: 'CanonicalEnumMemberId',
              enum: { _tag: 'CanonicalDeclarationId', module: 'root', name: 'Direction' },
              name: 'North',
            },
          },
          value: 0n,
          source: 'Implicit',
        },
        {
          canonical: {
            _tag: 'Canonical',
            id: {
              _tag: 'CanonicalEnumMemberId',
              enum: { _tag: 'CanonicalDeclarationId', module: 'root', name: 'Direction' },
              name: 'East',
            },
          },
          value: 5n,
          source: 'Explicit',
        },
        {
          canonical: {
            _tag: 'Canonical',
            id: {
              _tag: 'CanonicalEnumMemberId',
              enum: { _tag: 'CanonicalDeclarationId', module: 'root', name: 'Direction' },
              name: 'South',
            },
          },
          value: 6n,
          source: 'Implicit',
        },
      ],
    )
    assert.strictEqual(
      signed?.representation._tag === 'Available'
        ? signed.representation.scalar.spelling
        : undefined,
      'i64',
    )
    assert.deepEqual(
      signed?.members.map((member) =>
        member.discriminant._tag === 'Available'
          ? member.discriminant.value
          : member.discriminant._tag,
      ),
      [-9223372036854775808n, -9223372036854775807n],
    )
    assert.deepEqual(index.published, [])
  }),
)

it.effect('accepts default and all fixed-width enum representations at exact boundaries', () =>
  Effect.gen(function* () {
    const source = `enum Default { Only }
enum(u8) U8 { Minimum = 0, Maximum = 255 }
enum(u16) U16 { Minimum = 0, Maximum = 65535 }
enum(u32) U32 { Minimum = 0, Maximum = 4294967295 }
enum(u64) U64 { Minimum = 0, Maximum = 18446744073709551615 }
enum(i8) I8 { Minimum = -128, Maximum = 127 }
enum(i16) I16 { Minimum = -32768, Maximum = 32767 }
enum(i32) I32 { Minimum = -2147483648, Maximum = 2147483647 }
enum(i64) I64 { Minimum = -9223372036854775808, Maximum = 9223372036854775807 }`
    const expected: Array<{
      spelling: Scalar.EnumRepresentationSpelling
      explicit: boolean
      values: Array<bigint>
    }> = [
      { spelling: 'u8', explicit: false, values: [0n] },
      { spelling: 'u8', explicit: true, values: [0n, 255n] },
      { spelling: 'u16', explicit: true, values: [0n, 65535n] },
      { spelling: 'u32', explicit: true, values: [0n, 4294967295n] },
      { spelling: 'u64', explicit: true, values: [0n, 18446744073709551615n] },
      { spelling: 'i8', explicit: true, values: [-128n, 127n] },
      { spelling: 'i16', explicit: true, values: [-32768n, 32767n] },
      { spelling: 'i32', explicit: true, values: [-2147483648n, 2147483647n] },
      { spelling: 'i64', explicit: true, values: [-9223372036854775808n, 9223372036854775807n] },
    ]
    const index = yield* collect('root', [['root', source]])

    assert.deepEqual(
      index.modules.at(0)?.enums.map((declaration) => ({
        spelling:
          declaration.representation._tag === 'Available'
            ? declaration.representation.scalar.spelling
            : declaration.representation._tag,
        explicit:
          declaration.representation._tag === 'Available'
            ? declaration.representation.explicit
            : undefined,
        values: declaration.members.map((member) =>
          member.discriminant._tag === 'Available'
            ? member.discriminant.value
            : member.discriminant._tag,
        ),
      })),
      expected,
    )
    assert.deepEqual(index.published, [])
  }),
)

it.effect('keeps enums in one source-ordered flat nominal namespace', () =>
  Effect.gen(function* () {
    const index = yield* collect('root', [
      ['root', 'struct State {}\nenum State { Ready }\nfn State() -> i32 { return 0 }'],
    ])
    const module = index.modules.at(0)

    assert.deepEqual(
      module?.members.map((member) => member._tag),
      ['StructDeclaration', 'EnumDeclaration', 'FunctionDeclaration'],
    )
    assert.deepEqual(
      module?.enums,
      module?.members.filter(
        (member): member is DeclarationFacts.EnumFact => member._tag === 'EnumDeclaration',
      ),
    )
    assert.strictEqual(module?.enums.at(0)?.canonical._tag, 'Duplicate')
    assert.strictEqual(module?.members.at(1)?.canonical._tag, 'Duplicate')
    assert.strictEqual(DeclarationFacts.enumByName(index, 'root', 'State')._tag, 'Ambiguous')
    assert.deepEqual(
      index.published.map((diagnostic) => diagnostic.code),
      ['SEM0003', 'SEM0003'],
    )
  }),
)

it.effect('diagnoses enum declaration and discriminant failures with local unavailable facts', () =>
  Effect.gen(function* () {
    const source = `enum Empty {}
enum(usize) Unsupported { Value }
enum DuplicateName { Same, Same }
enum DuplicateValue { First = 3, Second = 3 }
enum Negative { Below = -1 }
enum(i8) ExplicitUnderflow { TooSmall = -129 }
enum(i8) ExplicitOverflow { TooLarge = 128 }
enum(u64) ExplicitWideOverflow { TooLarge = 18446744073709551616 }
enum ImplicitOverflow { Last = 255, After }
enum Good { Ready }`
    const index = yield* collect('root', [['root', source]])
    const enums = index.modules.at(0)?.enums ?? []
    const byName = (name: string) =>
      enums.find((declaration) =>
        declaration.name._tag === 'Present' ? declaration.name.spelling === name : false,
      )

    assert.deepEqual(
      index.published.map((diagnostic) => ({
        code: diagnostic.code,
        text: source.slice(diagnostic.span.start, diagnostic.span.end),
        related: diagnostic.relatedSpans?.map((related) =>
          source.slice(related.span.start, related.span.end),
        ),
      })),
      [
        { code: 'SEM0146', text: 'enum Empty {}', related: undefined },
        { code: 'SEM0147', text: 'usize', related: undefined },
        { code: 'SEM0148', text: 'Same', related: ['Same'] },
        { code: 'SEM0149', text: 'Second = 3', related: ['First = 3'] },
        { code: 'SEM0152', text: '-1', related: undefined },
        { code: 'SEM0150', text: '-129', related: undefined },
        { code: 'SEM0150', text: '128', related: undefined },
        { code: 'SEM0150', text: '18446744073709551616', related: undefined },
        { code: 'SEM0151', text: 'After', related: undefined },
      ],
    )
    assert.strictEqual(byName('Unsupported')?.representation._tag, 'Unavailable')
    assert.strictEqual(byName('DuplicateName')?.members.at(1)?.canonical._tag, 'Duplicate')
    assert.strictEqual(byName('DuplicateValue')?.members.at(1)?.discriminant._tag, 'Unavailable')
    assert.strictEqual(byName('Negative')?.members.at(0)?.discriminant._tag, 'Unavailable')
    assert.strictEqual(byName('ExplicitUnderflow')?.members.at(0)?.discriminant._tag, 'Unavailable')
    assert.strictEqual(byName('ExplicitOverflow')?.members.at(0)?.discriminant._tag, 'Unavailable')
    assert.strictEqual(
      byName('ExplicitWideOverflow')?.members.at(0)?.discriminant._tag,
      'Unavailable',
    )
    assert.strictEqual(byName('ImplicitOverflow')?.members.at(1)?.discriminant._tag, 'Unavailable')
    assert.strictEqual(byName('Good')?.validity._tag, 'Valid')
    assert.strictEqual(byName('Good')?.members.at(0)?.discriminant._tag, 'Available')
  }),
)

it.effect('keeps parser-damaged enum values explicitly unavailable without losing siblings', () =>
  Effect.gen(function* () {
    const index = yield* collect('root', [
      ['root', 'enum Broken { Missing =, Next }\nenum Good { Ready }'],
    ])
    const broken = index.modules.at(0)?.enums.at(0)
    const good = index.modules.at(0)?.enums.at(1)

    assert.strictEqual(broken?.validity._tag, 'Invalid')
    assert.strictEqual(broken?.members.at(0)?.discriminant._tag, 'Unavailable')
    assert.strictEqual(broken?.members.at(1)?.discriminant._tag, 'Unavailable')
    assert.strictEqual(good?.validity._tag, 'Valid')
    assert.strictEqual(good?.members.at(0)?.discriminant._tag, 'Available')
    assert.deepEqual(index.published, [])
  }),
)

it.effect('assigns distinct canonical identities to same-named declarations across modules', () =>
  Effect.gen(function* () {
    const index = yield* collect('root', [
      ['root', 'import lib\npub fn answer() -> i32 { return 1 }'],
      ['lib', 'pub fn answer() -> i32 { return 2 }'],
    ])

    const canonicals = index.modules.flatMap((module) =>
      module.declarations.map((declaration) => declaration.canonical),
    )
    assert.deepEqual(canonicals, [
      { _tag: 'Canonical', id: { _tag: 'CanonicalDeclarationId', module: 'lib', name: 'answer' } },
      { _tag: 'Canonical', id: { _tag: 'CanonicalDeclarationId', module: 'root', name: 'answer' } },
    ])
    assert.deepEqual(index.published, [])
  }),
)

it.effect('keeps same-spelled dependency roles distinct across modules', () =>
  Effect.gen(function* () {
    const index = yield* collect('root', [
      [
        'root',
        `import left
import right
service Clock {}
effect fn compare() -> i32 ? &Clock at left.Audit | &Clock at right.Audit { return 0 }`,
      ],
      ['left', 'pub role Audit'],
      ['right', 'pub role Audit'],
    ])
    const declaration = index.modules.find((module) => module.module === 'root')?.declarations.at(0)

    assert.deepEqual(index.published, [])
    assert.deepEqual(
      declaration?.requirementRow.requirements.map((requirement) => requirement.role),
      ['left::Audit', 'right::Audit'],
    )
  }),
)

it.effect('indexes source services and their operation contracts as distinct canonical facts', () =>
  Effect.gen(function* () {
    const index = yield* collect('root', [
      [
        'root',
        `pub struct WriteFailure {}
pub service Logger<T> {
  effect<'env> fn log<'env>(static template: string<'static>, message: &[u8], value: T) -> () ! WriteFailure ? &mut Logger<T> with Intrinsic.nonParking()
  fn enabled() -> bool
}`,
      ],
    ])
    const service = index.modules.at(0)?.services.at(0)

    assert.strictEqual(service?._tag, 'ServiceDeclaration')
    assert.deepEqual(service?.canonical, {
      _tag: 'Canonical',
      id: { _tag: 'CanonicalDeclarationId', module: 'root', name: 'Logger' },
    })
    assert.deepEqual(
      service?.operations.map((operation) => ({
        name: operation.name._tag === 'Present' ? operation.name.spelling : 'Unavailable',
        state: operation.state._tag,
        kind: operation.functionKind,
        properties: operation.staticProperties,
        parameters: operation.parameters.map((parameter) =>
          parameter.declaredType._tag === 'Resolved'
            ? Type.encode(parameter.declaredType.type)
            : parameter.declaredType._tag,
        ),
        result:
          operation.returnType._tag === 'Resolved'
            ? Type.encode(operation.returnType.type)
            : operation.returnType._tag,
        failures: operation.failureRow.failures.map(Type.encode),
        requirements: operation.requirementRow.requirements.map((requirement) => ({
          type: Type.encode(requirement.capability),
          access: requirement.access,
        })),
      })),
      [
        {
          name: 'log',
          state: 'Unique',
          kind: 'Effect',
          properties: ['Intrinsic.NonParking'],
          parameters: ["string<'static>", "&'life2 [u8]", 'T'],
          result: '()',
          failures: ['root.WriteFailure'],
          requirements: [{ type: 'root.Logger<T>', access: 'Exclusive' }],
        },
        {
          name: 'enabled',
          state: 'Unique',
          kind: 'Ordinary',
          properties: [],
          parameters: [],
          result: 'bool',
          failures: [],
          requirements: [],
        },
      ],
    )
    const log = service?.operations.at(0)
    assert.strictEqual(
      log === undefined ? undefined : SemanticDisplay.serviceOperation(log).text,
      "effect<'env> fn log<'env, 'life2: 'env>(static template: string<'static>, message: &'life2 [u8], value: T) -> () ! WriteFailure ? &mut root.Logger<T> with Intrinsic.nonParking()",
    )
    assert.deepEqual(index.published, [])
  }),
)

it.effect('rejects malformed service operation executable properties', () =>
  Effect.gen(function* () {
    const index = yield* collect('root', [
      [
        'root',
        `service Invalid {
  fn ordinary() -> () with Intrinsic.nonParking()
  effect fn arguments() -> () with Intrinsic.nonParking(value: true)
  effect fn unsupported() -> () with Intrinsic.detached()
  effect fn duplicate() -> () with Intrinsic.nonParking() with Intrinsic.nonParking()
}`,
      ],
    ])

    assert.deepEqual(
      index.published.map((diagnostic) => diagnostic.code),
      ['SEM0090', 'SEM0090', 'SEM0090', 'SEM0090'],
    )
  }),
)

it.effect('rejects service operation bodies in semantic declaration analysis', () =>
  Effect.gen(function* () {
    const index = yield* collect('root', [
      ['root', 'service Logger { fn enabled() -> bool { return true } }'],
    ])

    assert.deepEqual(
      index.published.map((diagnostic) => ({
        code: diagnostic.code,
        reason: diagnostic.reason._tag,
      })),
      [{ code: 'SEM0090', reason: 'InvalidServiceDeclaration' }],
    )
  }),
)

it.effect('validates arbitrary source service conformances without recognizing service names', () =>
  Effect.gen(function* () {
    const index = yield* collect('root', [
      [
        'root',
        `pub struct Problem {}
pub service Logger {
  effect fn log(message: i32) -> i32 ! Problem ? &mut Logger
  fn enabled() -> bool ? &Logger
}
pub struct Console {}
effect fn log(self: &mut Console, message: i32) -> i32 ! Problem { return message }
fn enabled(self: &Console) -> bool { return true }
impl Logger for Console { enabled: Console.enabled log: Console.log }`,
      ],
    ])
    const logger = Type.nominal('root', 'Logger')
    const console = Type.nominal('root', 'Console')
    const witness = ConformanceProof.witness(index, console, logger)

    assert.strictEqual(witness?._tag, 'SourceConformanceWitness')
    assert.deepEqual(witness?._tag === 'SourceConformanceWitness' ? witness.operations : [], [
      {
        name: 'log',
        implementation: {
          _tag: 'CanonicalDeclarationId',
          module: 'root',
          name: 'log',
        },
      },
      {
        name: 'enabled',
        implementation: {
          _tag: 'CanonicalDeclarationId',
          module: 'root',
          name: 'enabled',
        },
      },
    ])
    assert.deepEqual(index.published, [])
  }),
)

it.effect('adapts provider lookup into neutral source evidence without emitting diagnostics', () =>
  Effect.gen(function* () {
    const index = yield* collect('root', [
      [
        'root',
        `service Clock { effect fn read() -> i32 ? &Clock }
struct SystemClock {}
effect fn readClock(self: &SystemClock) -> i32 { return 42 }
impl Clock for SystemClock { read: SystemClock.readClock }
pub fn main() -> i32 { return 0 }`,
      ],
    ])
    const result = ConformanceProof.providerMatch(
      index,
      Type.nominal('root', 'SystemClock'),
      Type.nominal('root', 'Clock'),
    )

    assert.strictEqual(result._tag, 'Unique')
    if (result._tag === 'Unique') {
      assert.strictEqual(result.match._tag, 'Conformance')
      if (result.match._tag === 'Conformance')
        assert.strictEqual(result.match.witness.origin._tag, 'SourceWitness')
    }
    assert.deepEqual(index.published, [])
  }),
)

it.effect('rejects incomplete and stronger source service operation mappings', () =>
  Effect.gen(function* () {
    const index = yield* collect('root', [
      [
        'root',
        `pub struct Problem {}
pub struct Extra {}
pub service Logger {
  effect fn log(message: i32) -> i32 ! Problem ? &Logger
  fn enabled() -> bool
}
pub struct Console {}
effect fn log(self: &mut Console, message: i32) -> i32 ! Problem | Extra { return message }
impl Logger for Console { log: Console.log unknown: Console.unknown }`,
      ],
    ])

    assert.deepEqual(
      index.published.map((diagnostic) => diagnostic.reason._tag),
      ['InvalidConformance'],
    )
    assert.include(index.published.at(0)?.message ?? '', 'missing enabled')
    assert.include(index.published.at(0)?.message ?? '', 'unknown unknown')
  }),
)

it.effect('substitutes concrete generic service contracts during conformance', () =>
  Effect.gen(function* () {
    const index = yield* collect('root', [
      [
        'root',
        `pub service Store<T> {
  effect<'env> fn load<'env>(fallback: T) -> T ? &Store<T>
}
pub struct IntStore {}
effect fn load(self: &IntStore, fallback: i32) -> i32 { return fallback }
impl Store<i32> for IntStore { load: IntStore.load }`,
      ],
    ])
    const store = Type.nominal('root', 'Store', ['i32'])
    const provider = Type.nominal('root', 'IntStore')
    const witness = ConformanceProof.witness(index, provider, store)

    assert.deepEqual(index.published, [])
    assert.deepEqual(witness?._tag === 'SourceConformanceWitness' ? witness.operations : [], [
      {
        name: 'load',
        implementation: {
          _tag: 'CanonicalDeclarationId',
          module: 'root',
          name: 'load',
        },
      },
    ])
  }),
)

it.effect('rejects a mapped service implementation with stronger access and failure rows', () =>
  Effect.gen(function* () {
    const index = yield* collect('root', [
      [
        'root',
        `pub struct Problem {}
pub struct Extra {}
pub service Logger {
  effect fn log(message: i32) -> i32 ! Problem ? &Logger
}
pub struct Console {}
effect fn log(self: &mut Console, message: i32) -> i32 ! Problem | Extra { return message }
impl Logger for Console { log: Console.log }`,
      ],
    ])

    assert.deepEqual(
      index.published.map((diagnostic) => diagnostic.reason._tag),
      ['InvalidConformance'],
    )
    assert.include(index.published.at(0)?.message ?? '', 'incompatible with Logger.log')
  }),
)

it.effect('rejects an inline scalar witness that adds a failure', () =>
  Effect.gen(function* () {
    const index = yield* collect('root', [
      [
        'root',
        `pub struct Problem {}
pub struct Extra {}
pub interface Present {
  effect fn present(value: &Self) -> i32 ! Problem
}
impl Present for i32 {
  effect fn present(value: &Self) -> i32 ! Problem | Extra { return 42 }
}`,
      ],
    ])

    assert.deepEqual(
      index.published.map((diagnostic) => ({
        code: diagnostic.code,
        message: diagnostic.message,
      })),
      [
        {
          code: 'SEM0083',
          message:
            'Invalid conformance: i32.impl@0.present is incompatible with Present.present: witness adds failure root.Extra',
        },
      ],
    )
  }),
)

it.effect('keeps inline, nominal mapped, and intrinsic interface witnesses distinct', () =>
  Effect.gen(function* () {
    const index = yield* collect('root', [
      [
        'root',
        `interface Present { fn present(value: &Self) -> i32 }
struct Box {}
fn presentBox(value: &Box) -> i32 { return 1 }
impl Present for Box { present: Box.presentBox }
impl Present for i32 {
  fn present(value: &Self) -> i32 { return 2 }
}

interface Combined { operator + fn add(left: Self, right: Self) -> Self }
impl Combined for i32 { add: Intrinsic.i32WrappingAdd }
interface Compared { operator < fn less(left: &Self, right: &Self) -> bool }
impl Compared for i32 { fn less(left: &Self, right: &Self) -> bool { return false } }`,
      ],
    ])
    const present = Type.nominal('root', 'Present')
    const combined = Type.nominal('root', 'Combined')
    const box = Type.nominal('root', 'Box')

    const inline = ConformanceProof.interfaceWitnessImplementation(index, 'i32', present, 'present')
    const mapped = ConformanceProof.interfaceWitnessImplementation(index, box, present, 'present')
    const intrinsic = ConformanceProof.interfaceOperationIntrinsic(index, 'i32', combined, 'add')

    assert.deepEqual(index.published, [])
    assert.strictEqual(inline?.module, 'root')
    assert.match(inline?.name ?? '', /^impl@\d+\.present$/)
    assert.strictEqual(mapped?.name, 'presentBox')
    assert.isUndefined(
      ConformanceProof.interfaceOperationIntrinsic(index, 'i32', present, 'present'),
    )
    assert.isUndefined(
      ConformanceProof.interfaceWitnessImplementation(index, 'i32', combined, 'add'),
    )
    assert.strictEqual(intrinsic?.id.name, 'i32WrappingAdd')
    const comparison = index.modules
      .at(0)
      ?.interfaces.find(
        (member) => member.name._tag === 'Present' && member.name.spelling === 'Compared',
      )
      ?.operations.at(0)
    assert.deepEqual(
      comparison?.typeParameters.map((parameter) => parameter.type.kind),
      ['Lifetime', 'Lifetime'],
    )
    assert.strictEqual(comparison?.operator?.operator, 'LessThan')
    assert.isDefined(
      ConformanceProof.interfaceWitnessImplementation(
        index,
        'i32',
        Type.nominal('root', 'Compared'),
        'less',
      ),
    )
  }),
)

it.effect('marks later duplicates as caused duplicates of the first occurrence', () =>
  Effect.gen(function* () {
    const index = yield* collect('root', [
      ['root', 'pub fn same() -> i32 { return 1 }\npub fn same() -> i32 { return 2 }'],
    ])
    const headers = index.modules.at(0)?.declarations ?? []

    assert.strictEqual(headers.at(0)?.canonical._tag, 'Canonical')
    const duplicate = headers.at(1)?.canonical
    assert.strictEqual(duplicate?._tag, 'Duplicate')
    if (duplicate?._tag !== 'Duplicate') return
    assert.deepEqual(duplicate.original, {
      _tag: 'CanonicalDeclarationId',
      module: 'root',
      name: 'same',
    })
    assert.strictEqual(duplicate.cause.code, 'SEM0003')
    assert.deepEqual(
      index.published.map((diagnostic) => diagnostic.code),
      ['SEM0003'],
    )
  }),
)

it.effect('keeps unavailable names unidentified without extra diagnostics', () =>
  Effect.gen(function* () {
    const index = yield* collect('root', [['root', 'pub fn () -> i32 { return 0 }']])
    const header = index.modules.at(0)?.declarations.at(0)

    assert.strictEqual(header?.canonical._tag, 'Unidentified')
    assert.strictEqual(header?.name._tag, 'Unavailable')
    assert.deepEqual(index.published, [])
  }),
)

it.effect('resolves header signatures and diagnoses unknown types at exact spans', () =>
  Effect.gen(function* () {
    const index = yield* collect('root', [
      ['root', 'pub fn choose(left: i32, right: Mystery) -> i32 { return left }'],
    ])
    const header = index.modules.at(0)?.declarations.at(0)

    assert.strictEqual(header?.parameterCount, 2)
    assert.strictEqual(header?.parameters.at(0)?.declaredType._tag, 'Resolved')
    assert.strictEqual(header?.parameters.at(1)?.declaredType._tag, 'Unresolved')
    assert.strictEqual(header?.returnType._tag, 'Resolved')
    assert.deepEqual(
      index.published.map((diagnostic) => ({
        code: diagnostic.code,
        start: diagnostic.span.start,
        end: diagnostic.span.end,
      })),
      [{ code: 'SEM0001', start: 32, end: 39 }],
    )
  }),
)

it.effect('retains static function and parameter modes with a deterministic body template', () =>
  Effect.gen(function* () {
    const index = yield* collect('root', [
      [
        'root',
        `pub static fn parse(value: string) -> i32 { return 1 }
pub fn render(static template: string, value: i32) -> i32 {
  let static parsed = parse(template)
  return value
}`,
      ],
    ])
    const parse = index.modules.at(0)?.declarations.at(0)
    const render = index.modules.at(0)?.declarations.at(1)

    assert.strictEqual(parse?.phase, 'Static')
    assert.strictEqual(parse?.parameters.at(0)?.phase, 'Static')
    assert.strictEqual(render?.phase, 'Runtime')
    assert.strictEqual(render?.parameters.at(0)?.phase, 'Static')
    assert.strictEqual(render?.parameters.at(1)?.phase, 'Runtime')
    assert.strictEqual(parse?.bodyTemplate?._tag, 'FunctionBodyTemplate')
    assert.strictEqual(render?.bodyTemplate?._tag, 'FunctionBodyTemplate')
    assert.include(parse?.bodyTemplate?.canonical ?? '', 'ReturnStatement')
    // The authored encoding spells a binding's markers positionally as `name mutable static`,
    // so the retained static binding reads `"parsed" false true` rather than naming a keyword.
    assert.include(render?.bodyTemplate?.canonical ?? '', 'BindingStatement')
    assert.include(render?.bodyTemplate?.canonical ?? '', 'Name( [ ] "parsed" ) false true')
  }),
)

it.effect('resolves string in signatures and generic arguments without treating it as scalar', () =>
  Effect.gen(function* () {
    const index = yield* collect('root', [
      [
        'root',
        `pub struct Box<T> { value: T }
pub fn identity(value: string, boxed: Box<string>) -> string { return value }`,
      ],
    ])
    const declaration = index.modules.at(0)?.declarations.at(0)
    const parameterTypes = declaration?.parameters.map((parameter) =>
      parameter.declaredType._tag === 'Resolved'
        ? parameter.declaredType.type
        : parameter.declaredType._tag,
    )

    assert.deepEqual(
      parameterTypes?.map((type) => (typeof type === 'string' ? type : Type.encode(type))),
      ["string<'life0>", "root.Box<string<'life1>>"],
    )
    assert.strictEqual(
      declaration?.returnType._tag === 'Resolved'
        ? Type.isString(declaration.returnType.type)
        : false,
      true,
    )
    assert.strictEqual(Type.isBuiltin(Type.string(Lifetime.staticLifetime)), false)
    assert.strictEqual(ConformanceProof.copyType(index, Type.string(Lifetime.staticLifetime)), true)
    assert.strictEqual(
      DeclarationFacts.containsLexicalBorrow(index, Type.string(Lifetime.staticLifetime)),
      true,
    )
    assert.deepEqual(index.published, [])
  }),
)

it.effect('resolves references and slices around string through ordinary type facts', () =>
  Effect.gen(function* () {
    const index = yield* collect('root', [
      [
        'root',
        'fn duplicate(first: &string, second: &mut string, third: &[string]) -> () { return () }',
      ],
    ])
    const declaration = index.modules.at(0)?.declarations.at(0)

    assert.deepEqual(
      declaration?.parameters.map((parameter) => parameter.declaredType._tag),
      ['Resolved', 'Resolved', 'Resolved'],
    )
    assert.deepEqual(index.published, [])
  }),
)

it.effect('resolves callable parameter and result contracts canonically', () =>
  Effect.gen(function* () {
    const index = yield* collect('root', [
      [
        'root',
        'fn apply<T>(shared: fn(T) -> T, exclusive: mut fn(T) -> bool, consuming: once fn() -> T) -> T { return shared }',
      ],
    ])
    const declaration = index.modules.at(0)?.declarations.at(0)

    assert.deepEqual(
      declaration?.parameters.map((parameter) =>
        parameter.declaredType._tag === 'Resolved'
          ? Type.encode(parameter.declaredType.type)
          : parameter.declaredType._tag,
      ),
      ["fn<'life1>(T) -> T", "mut fn<'life2>(T) -> bool", "once fn<'life3>() -> T"],
    )
    assert.deepEqual(index.published, [])
  }),
)

it.effect('indexes failure payloads as values and requirements as row binders', () =>
  Effect.gen(function* () {
    const index = yield* collect('root', [
      [
        'root',
        "effect<'env> fn transform<A: 'env, E, ?R, 'env>(self: Effect<'static; A ! E ? R>, value: A) -> Effect<'static; A ! E ? R> ! E ? R { return self }",
      ],
    ])
    const declaration = index.modules.at(0)?.declarations.at(0)

    assert.deepEqual(
      declaration?.typeParameters.map((parameter) => ({
        name: parameter.type.name,
        kind: parameter.type.kind,
      })),
      [
        { name: 'A', kind: 'Value' },
        { name: 'E', kind: 'Value' },
        { name: 'R', kind: 'RequirementRow' },
        { name: "'env", kind: 'Lifetime' },
      ],
    )
    assert.deepEqual(declaration?.failureRow.parameters, [])
    assert.deepEqual(
      declaration?.requirementRow.parameters.map((parameter) => parameter.name),
      ['R'],
    )
    const parameterEffect = declaration?.parameters.at(0)?.declaredType
    const returnEffect = declaration?.returnType
    assert.strictEqual(parameterEffect?._tag, 'Resolved')
    assert.strictEqual(returnEffect?._tag, 'Resolved')
    if (
      parameterEffect?._tag === 'Resolved' &&
      Type.isEffect(parameterEffect.type) &&
      returnEffect?._tag === 'Resolved' &&
      Type.isEffect(returnEffect.type)
    ) {
      assert.deepEqual(
        [parameterEffect.type, returnEffect.type].map((effect) => ({
          failures: Type.failureMemberParameters(effect).map((parameter) => parameter.name),
          requirements: Type.requirementRowParameters(effect).map((parameter) => parameter.name),
        })),
        [
          { failures: ['E'], requirements: ['R'] },
          { failures: ['E'], requirements: ['R'] },
        ],
      )
    }
    assert.deepEqual(index.published, [])
  }),
)

it.effect('diagnoses generic row binders used in the wrong channel and unbound row names', () =>
  Effect.gen(function* () {
    const index = yield* collect('root', [
      [
        'root',
        `effect<'env> fn bad<E: 'env, ?R, 'env>(left: E, right: R) -> E ! R ? E { return left }
effect fn unbound() -> i32 ? MissingRow { return 0 }`,
      ],
    ])

    assert.deepEqual(
      index.published.map((diagnostic) => ({
        code: diagnostic.code,
        reason: diagnostic.reason._tag,
      })),
      [
        { code: 'SEM0088', reason: 'GenericParameterKindMismatch' },
        { code: 'SEM0088', reason: 'GenericParameterKindMismatch' },
        { code: 'SEM0088', reason: 'GenericParameterKindMismatch' },
        { code: 'SEM0001', reason: 'UnknownType' },
      ],
    )
  }),
)

it.effect('keeps cross-kind duplicate binders attached to the first canonical identity', () =>
  Effect.gen(function* () {
    const index = yield* collect('root', [
      ['root', "effect<'env> fn duplicate<A: 'env, A, ?A, 'env>(value: A) -> A { return value }"],
    ])
    const parameters = index.modules.at(0)?.declarations.at(0)?.typeParameters ?? []

    assert.strictEqual(parameters.at(1)?.type, parameters.at(0)?.type)
    assert.strictEqual(parameters.at(2)?.type, parameters.at(0)?.type)
    assert.strictEqual(parameters.at(1)?.duplicateOf, parameters.at(0)?.type)
    assert.strictEqual(parameters.at(2)?.duplicateOf, parameters.at(0)?.type)
    assert.strictEqual(parameters.at(0)?.type.kind, 'Value')
    assert.deepEqual(
      index.published.map((diagnostic) => diagnostic.code),
      ['SEM0050', 'SEM0050'],
    )
  }),
)

it.effect('normalizes effect failure rows while retaining source members', () =>
  Effect.gen(function* () {
    const index = yield* collect('root', [
      [
        'root',
        'struct First {}\nstruct Second {}\n' +
          'effect fn work() -> i32 ! Second | First | Second { return 1 }\n' +
          'fn plain() -> i32 { return 0 }',
      ],
    ])
    const effect = index.modules.at(0)?.declarations.at(0)
    const plain = index.modules.at(0)?.declarations.at(1)

    assert.strictEqual(effect?.functionKind, 'Effect')
    assert.strictEqual(effect?.failureRow.members.length, 3)
    assert.deepEqual(effect?.failureRow.failures.map(Type.encode), ['root.First', 'root.Second'])
    assert.strictEqual(effect?.failureRow.available, true)
    assert.strictEqual(plain?.functionKind, 'Ordinary')
    assert.deepEqual(plain?.failureRow.failures, [])
    assert.deepEqual(index.published, [])
  }),
)

it.effect('resolves imported failure members and preserves invalid row facts', () =>
  Effect.gen(function* () {
    const index = yield* collect('root', [
      [
        'root',
        'import errors.Error\n' +
          'effect fn imported() -> i32 ! Error.Error { return 1 }\n' +
          'effect fn generic<T>() -> i32 ! T { return 1 }\n' +
          'effect fn scalar() -> i32 ! i32 { return 1 }\n' +
          'effect fn missing() -> i32 ! Mystery { return 1 }',
      ],
      ['errors/Error', 'pub struct Error {}'],
    ])
    const declarations =
      index.modules.find((module) => module.module === 'root')?.declarations ?? []

    assert.deepEqual(
      declarations.map((declaration) => ({
        available: declaration.failureRow.available,
        failures: declaration.failureRow.failures.map(Type.encode),
      })),
      [
        { available: true, failures: ['errors/Error.Error'] },
        { available: true, failures: [] },
        { available: true, failures: ['i32'] },
        { available: false, failures: [] },
      ],
    )
    assert.deepEqual(
      index.published.map((diagnostic) => diagnostic.code),
      ['SEM0001'],
    )
  }),
)

it.effect('rejects failure rows on ordinary functions without losing the row', () =>
  Effect.gen(function* () {
    const index = yield* collect('root', [
      ['root', 'struct Problem {}\nfn bad() -> i32 ! Problem { return 0 }'],
    ])
    const declaration = index.modules.at(0)?.declarations.at(0)

    assert.strictEqual(declaration?.functionKind, 'Ordinary')
    assert.deepEqual(declaration?.failureRow.failures.map(Type.encode), ['root.Problem'])
    assert.deepEqual(
      index.published.map((diagnostic) => diagnostic.code),
      ['SEM0062'],
    )
  }),
)

it.effect('resolves explicit Effect contracts and canonical requirement rows', () =>
  Effect.gen(function* () {
    const index = yield* collect('root', [
      [
        'root',
        `struct Problem {}
service FileSystem {}
service Allocator {}
role Scratch
fn later() -> Effect<'static; i32 ! Problem ? &FileSystem | &mut Allocator at Scratch> {
  return effect { return 1 }
}
effect fn work() -> i32 ! Problem ? &FileSystem | &mut Allocator at Scratch { return 1 }`,
      ],
    ])
    const [later, work] = index.modules.at(0)?.declarations ?? []
    assert.deepEqual(index.published, [])
    assert.strictEqual(later?.returnType._tag, 'Resolved')
    const laterType = later?.returnType._tag === 'Resolved' ? later.returnType.type : undefined
    assert.isTrue(laterType !== undefined && Type.isEffect(laterType))
    if (laterType === undefined || !Type.isEffect(laterType)) return
    assert.deepEqual(Type.failureMembers(laterType).map(Type.encode), ['root.Problem'])
    assert.deepEqual(
      Type.requirementMembers(laterType).map((requirement) => ({
        capability: requirement.capability.name,
        role: requirement.role,
        access: requirement.access,
      })),
      [
        { capability: 'Allocator', role: 'root::Scratch', access: 'Exclusive' },
        { capability: 'FileSystem', role: 'DefaultRole', access: 'Shared' },
      ],
    )
    assert.deepEqual(work?.requirementRow.requirements, Type.requirementMembers(laterType))
  }),
)

it.effect('orders modules canonically and answers per-module lookups', () =>
  Effect.gen(function* () {
    const index = yield* collect('zeta', [
      ['zeta', 'import alpha\npub fn main() -> i32 { return 42 }'],
      ['alpha', 'pub fn helper() -> i32 { return 1 }'],
    ])

    assert.deepEqual(
      index.modules.map((module) => module.module),
      ['alpha', 'zeta'],
    )
    assert.strictEqual(DeclarationFacts.lookup(index, 'zeta', 'main')._tag, 'Resolved')
    assert.strictEqual(DeclarationFacts.lookup(index, 'zeta', 'helper')._tag, 'Missing')
    assert.strictEqual(DeclarationFacts.lookup(index, 'alpha', 'helper')._tag, 'Resolved')
  }),
)

it.effect('collects identical indexes across repeated fresh runs', () =>
  Effect.gen(function* () {
    const entries: ReadonlyArray<readonly [string, string]> = [
      ['root', 'import lib\npub fn main() -> Mystery { return lib }'],
      ['lib', 'pub fn same() -> i32 { return 1 }\npub fn same() -> i32 { return 2 }'],
    ]
    const first = yield* collect('root', entries)
    const second = yield* collect('root', [...entries].reverse())

    assert.deepEqual(first, second)
  }),
)

it.effect('indexes mixed struct and function declarations in one canonical namespace', () =>
  Effect.gen(function* () {
    const index = yield* collect('root', [
      [
        'root',
        'pub struct Token { pub kind: i32 lexeme: bool }\n' +
          'pub fn make(kind: i32) -> i32 { return kind }\n' +
          'fn Token() -> i32 { return 0 }',
      ],
    ])
    const module = index.modules.at(0)

    assert.deepEqual(
      module?.members.map((member) => member._tag),
      ['StructDeclaration', 'FunctionDeclaration', 'FunctionDeclaration'],
    )
    assert.strictEqual(module?.structs.at(0)?.fields.at(0)?.visibility, 'Public')
    assert.strictEqual(module?.structs.at(0)?.fields.at(1)?.visibility, 'Private')
    assert.strictEqual(module?.members.at(2)?.canonical._tag, 'Duplicate')
    assert.deepEqual(
      index.published.map((diagnostic) => diagnostic.code),
      ['SEM0003'],
    )
  }),
)

it.effect('retains valid nested C-layout contracts across module resolution', () =>
  Effect.gen(function* () {
    const index = yield* collect('root', [
      [
        'root',
        `import dep { Inner }
struct Opaque {}
pub extern "C" struct Packet {
  tag: i8
  count: usize
  address: *mut Opaque
  samples: [f32; 3]
  inner: Inner
}`,
      ],
      ['dep', 'pub extern "C" struct Inner { low: i32 high: f64 }'],
    ])
    const packet = index.modules.find((module) => module.module === 'root')?.structs.at(1)
    const inner = index.modules.find((module) => module.module === 'dep')?.structs.at(0)

    assert.deepEqual(index.published, [])
    assert.strictEqual(packet?.layout._tag, 'Foreign')
    assert.strictEqual(inner?.layout._tag, 'Foreign')
    if (packet?.layout._tag === 'Foreign') assert.strictEqual(packet.layout.abi, 'C')
    assert.deepEqual(
      packet?.fields.map((field) =>
        field.declaredType._tag === 'Resolved'
          ? field.declaredType.spelling
          : field.declaredType._tag,
      ),
      ['i8', 'usize', '*mut root.Opaque', 'Array<f32, 3>', 'Inner'],
    )
  }),
)

it.effect('withholds invalid C-layout promises with stable source-owned diagnostics', () =>
  Effect.gen(function* () {
    const source = `struct Ordinary { value: i32 }
extern "system" struct Wrong { value: i32 }
extern "C" struct Generic<T> { value: T }
extern "C" struct Bad {
  flag: bool
  zero: [u8; 0]
  nested: Ordinary
}`
    const index = yield* collect('records', [['records', source]])
    const structs = index.modules.at(0)?.structs ?? []
    const named = (name: string) =>
      structs.find((struct) => struct.name._tag === 'Present' && struct.name.spelling === name)

    assert.deepEqual(
      index.published.map((diagnostic) => ({
        code: diagnostic.code,
        reason: diagnostic.reason._tag,
        text: source.slice(diagnostic.span.start, diagnostic.span.end),
      })),
      [
        { code: 'SEM0185', reason: 'UnsupportedForeignAbi', text: '"system"' },
        { code: 'SEM0205', reason: 'GenericCLayoutRecord', text: '<T>' },
        { code: 'SEM0206', reason: 'UnsupportedCLayoutField', text: 'bool' },
        { code: 'SEM0206', reason: 'UnsupportedCLayoutField', text: '[u8; 0]' },
        { code: 'SEM0206', reason: 'UnsupportedCLayoutField', text: 'Ordinary' },
      ],
    )
    assert.strictEqual(named('Ordinary')?.layout._tag, 'Silk')
    assert.strictEqual(named('Wrong')?.layout._tag, 'InvalidForeign')
    assert.strictEqual(named('Generic')?.layout._tag, 'InvalidForeign')
    assert.strictEqual(named('Bad')?.layout._tag, 'InvalidForeign')
  }),
)

it.effect('withholds direct and mutual recursive C-layout promises', () =>
  Effect.gen(function* () {
    const index = yield* collect('records', [
      [
        'records',
        `extern "C" struct Direct { next: Direct }
extern "C" struct Left { right: Right }
extern "C" struct Right { left: Left }`,
      ],
    ])
    const structs = index.modules.at(0)?.structs ?? []

    assert.deepEqual(
      structs.map((struct) => struct.layout._tag),
      ['InvalidForeign', 'InvalidForeign', 'InvalidForeign'],
    )
    assert.deepEqual(
      index.published.map((diagnostic) => diagnostic.code),
      ['SEM0020', 'SEM0206', 'SEM0020', 'SEM0206', 'SEM0206'],
    )
  }),
)

it.effect('indexes generic nominal unions with parent-scoped variants and fields', () =>
  Effect.gen(function* () {
    const index = yield* collect('root', [
      [
        'root',
        `pub union Result<A, E> { Success { pub value: A, next: Other }, Failure { error: E }, Pending }
union Other { Success { value: bool } }`,
      ],
    ])
    const module = index.modules.at(0)
    const result = module?.unions.at(0)
    const other = module?.unions.at(1)

    assert.deepEqual(
      module?.members.map((member) => member._tag),
      ['UnionDeclaration', 'UnionDeclaration'],
    )
    assert.deepEqual(
      result?.typeParameters.map((parameter) => parameter.type.name),
      ['A', 'E'],
    )
    assert.deepEqual(
      result?.variants.map((variant) => [
        variant.name._tag === 'Present' ? variant.name.spelling : '_',
        variant.kind,
      ]),
      [
        ['Success', 'Fields'],
        ['Failure', 'Fields'],
        ['Pending', 'Unit'],
      ],
    )
    assert.strictEqual(result?.validity._tag, 'Valid')
    assert.strictEqual(result?.variants.at(0)?.fields.at(0)?.visibility, 'Public')
    assert.strictEqual(result?.variants.at(0)?.fields.at(1)?.declaredType._tag, 'Resolved')
    assert.notDeepEqual(result?.variants.at(0)?.canonical, other?.variants.at(0)?.canonical)
    assert.notDeepEqual(
      result?.variants.at(0)?.fields.at(0)?.id,
      other?.variants.at(0)?.fields.at(0)?.id,
    )
    assert.deepEqual(index.published, [])
  }),
)

it.effect('diagnoses invalid nominal unions while preserving valid siblings', () =>
  Effect.gen(function* () {
    const source = `union Empty {}
union Damaged { Same, Same, EmptyFields {}, Good { value: Missing }, Tail }
struct Damaged {}`
    const index = yield* collect('root', [['root', source]])
    const unions = index.modules.at(0)?.unions ?? []
    const damaged = unions.at(1)

    assert.deepEqual(
      damaged?.variants.map((variant) =>
        variant.name._tag === 'Present' ? variant.name.spelling : '_',
      ),
      ['Same', 'Same', 'EmptyFields', 'Good', 'Tail'],
    )
    assert.strictEqual(damaged?.variants.at(4)?.canonical._tag, 'Canonical')
    assert.strictEqual(damaged?.validity._tag, 'Invalid')
    assert.deepEqual(
      index.published.map((diagnostic) => diagnostic.code),
      ['SEM0164', 'SEM0165', 'SEM0166', 'SEM0001', 'SEM0003'],
    )
    const duplicate = index.published.find((diagnostic) => diagnostic.code === 'SEM0165')
    assert.deepEqual(
      duplicate?.relatedSpans?.map((related) => source.slice(related.span.start, related.span.end)),
      ['Same'],
    )
    assert.strictEqual(
      duplicate === undefined ? undefined : source.slice(duplicate.span.start, duplicate.span.end),
      'Same',
    )
  }),
)

it.effect('retains duplicate and damaged struct fields without losing later fields', () =>
  Effect.gen(function* () {
    const index = yield* collect('root', [
      ['root', 'struct Pair { value: i32 value: bool pub : i32 tail: bool }'],
    ])
    const fields = index.modules.at(0)?.structs.at(0)?.fields ?? []

    assert.deepEqual(
      fields.map((field) => field.state._tag),
      ['Unique', 'Duplicate', 'Unidentified', 'Unique'],
    )
    assert.strictEqual(fields.at(3)?.declaredType._tag, 'Resolved')
    assert.deepEqual(
      index.published.map((diagnostic) => diagnostic.code),
      ['SEM0017'],
    )
  }),
)

it.effect('diagnoses private exposure and inline recursive struct components canonically', () =>
  Effect.gen(function* () {
    const exposedSource =
      'struct Hidden {}\n' +
      'pub struct Public { pub hidden: Hidden private: Hidden }\n' +
      'pub fn reveal(value: Hidden) -> Hidden { return value }'
    const exposed = yield* collect('root', [['root', exposedSource]])
    assert.deepEqual(
      exposed.published.map((diagnostic) => diagnostic.code),
      ['SEM0019', 'SEM0019', 'SEM0019'],
    )
    assert.deepEqual(
      exposed.published.map((diagnostic) =>
        exposedSource.slice(diagnostic.span.start, diagnostic.span.end),
      ),
      ['Hidden', 'Hidden', 'Hidden'],
    )

    const requiredSource =
      'service Clock { effect fn now() -> i32 ? &Clock }\n' +
      'pub effect fn read() -> i32 ? &Clock { return 0 }\n' +
      'effect fn quiet() -> i32 ? &Clock { return 0 }'
    const required = yield* collect('required', [['required', requiredSource]])
    assert.deepEqual(
      required.published.map((diagnostic) => [
        diagnostic.code,
        requiredSource.slice(diagnostic.span.start, diagnostic.span.end),
        diagnostic.span.start,
      ]),
      [
        [
          'SEM0019',
          'Clock',
          requiredSource.indexOf('&Clock', requiredSource.indexOf('pub effect')) + 1,
        ],
      ],
    )

    const exposedUnion = yield* collect('union-exposure', [
      [
        'union-exposure',
        'struct Hidden {}\npub union Public { Value { pub visible: Hidden, private: Hidden } }',
      ],
    ])
    assert.deepEqual(
      exposedUnion.published.map((diagnostic) => diagnostic.code),
      ['SEM0019'],
    )
    assert.strictEqual(exposedUnion.modules.at(0)?.unions.at(0)?.validity._tag, 'Invalid')
    assert.strictEqual(exposedUnion.modules.at(0)?.unions.at(0)?.dependency._tag, 'Unavailable')

    const recursiveSource = 'import b.B\npub struct A { value: B.B }'
    const recursive = yield* collect('a/A', [
      ['a/A', recursiveSource],
      ['b/B', 'import a.A\npub struct B { value: A.A }'],
    ])
    assert.deepEqual(
      recursive.published.map((diagnostic) => diagnostic.code),
      ['SEM0020'],
    )
    assert.deepEqual(
      recursive.published.map((diagnostic) => ({
        sourceId: diagnostic.span.sourceId,
        text: recursiveSource.slice(diagnostic.span.start, diagnostic.span.end),
      })),
      [{ sourceId: 'a/A', text: 'A' }],
    )
    assert.strictEqual(recursive.modules.at(0)?.structs.at(0)?.dependency._tag, 'Unavailable')
    assert.strictEqual(recursive.modules.at(1)?.structs.at(0)?.dependency._tag, 'Unavailable')

    const direct = yield* collect('direct', [
      ['direct', 'struct Node { next: Node }\npub fn main() -> i32 { return 0 }'],
    ])
    assert.deepEqual(
      direct.published.map((diagnostic) => diagnostic.code),
      ['SEM0020'],
    )
    assert.strictEqual(direct.modules.at(0)?.structs.at(0)?.dependency._tag, 'Unavailable')

    const mixed = yield* collect('mixed', [
      ['mixed', 'union Link { Next { node: Node }, End }\nstruct Node { link: Link }'],
    ])
    assert.deepEqual(
      mixed.published.map((diagnostic) => diagnostic.code),
      ['SEM0020'],
    )
    assert.strictEqual(mixed.modules.at(0)?.unions.at(0)?.dependency._tag, 'Unavailable')
    assert.strictEqual(mixed.modules.at(0)?.structs.at(0)?.dependency._tag, 'Unavailable')
  }),
)

it.effect('resolves forward nominal fields into a canonical acyclic dependency set', () =>
  Effect.gen(function* () {
    const index = yield* collect('geometry', [
      [
        'geometry',
        'struct Span { first: Position second: Position }\n' +
          'struct Position { x: i32 }\n' +
          'pub fn main() -> i32 { return 0 }',
      ],
    ])
    const span = index.modules.at(0)?.structs.at(0)

    assert.strictEqual(span?.dependency._tag, 'Available')
    assert.deepEqual(span?.dependency.types, [
      { _tag: 'NominalType', module: 'geometry', name: 'Position', arguments: [] },
    ])
    assert.deepEqual(
      span?.fields.map((field) =>
        field.declaredType._tag === 'Resolved' ? field.declaredType.type : field.declaredType._tag,
      ),
      [
        { _tag: 'NominalType', module: 'geometry', name: 'Position', arguments: [] },
        { _tag: 'NominalType', module: 'geometry', name: 'Position', arguments: [] },
      ],
    )
  }),
)

it.effect('resolves generic slice storage and diagnoses an ambiguous returned slice', () =>
  Effect.gen(function* () {
    const source =
      'fn scan<T>(shared: &[T], exclusive: &mut [T]) -> i32 { return 0 }\n' +
      'fn badParameter(values: [&[i32]; 1]) -> i32 { return 0 }\n' +
      'fn badReturn() -> &[i32] { return 0 }\n' +
      'struct BadField { values: &[i32] }'
    const index = yield* collect('slices', [['slices', source]])
    const scan = index.modules.at(0)?.declarations.at(0)

    assert.deepEqual(
      scan?.parameters.map((parameter) =>
        parameter.declaredType._tag === 'Resolved'
          ? parameter.declaredType.spelling
          : parameter.declaredType._tag,
      ),
      ["&'life1 [T]", "&'life2 mut [T]"],
    )
    assert.deepEqual(
      index.published.map((diagnostic) => diagnostic.code),
      ['SEM0210'],
    )
  }),
)

it.effect('indexes nominal service conformance without erasing the provider type', () =>
  Effect.gen(function* () {
    const index = yield* collect('allocator', [
      [
        'allocator',
        `service Allocator { effect fn allocate(layout: i32) -> i32 ? &mut Allocator }
struct TestAllocator { remaining: i32 }
effect fn allocate(self: &mut TestAllocator, layout: i32) -> i32 { return layout }
impl Allocator for TestAllocator { allocate: TestAllocator.allocate }
pub fn main() -> i32 { return 0 }`,
      ],
    ])
    const witness = index.modules.at(0)?.conformances.at(0)
    assert.strictEqual(witness?.capability._tag, 'Resolved')
    assert.strictEqual(witness?.provider._tag, 'Resolved')
    assert.deepEqual(
      witness?.operations.map((operation) => operation.name._tag),
      ['Present'],
    )
    assert.isTrue(
      ConformanceProof.conforms(
        index,
        Type.nominal('allocator', 'TestAllocator'),
        Type.nominal('allocator', 'Allocator'),
      ),
    )
  }),
)

it.effect('admits conditional interface-owned nominal heads and checks their overlap', () =>
  Effect.gen(function* () {
    const index = yield* collect('contracts', [
      ['model', 'pub struct Wrapper<T> { value: T }'],
      [
        'contracts',
        `import model { Wrapper }
interface Present { fn present(value: &Self) -> i32 }
impl<T: Copy> Present for Wrapper<T> {
  fn present(value: &Self) -> i32 { return 1 }
}
impl<U: Copy> Present for Wrapper<U> {
  fn present(value: &Self) -> i32 { return 2 }
}`,
      ],
    ])
    assert.deepEqual(
      index.published.map((diagnostic) => diagnostic.code),
      ['SEM0119'],
    )
    assert.deepEqual(
      index.modules
        .find((module) => module.module === 'contracts')
        ?.conformances.map((conformance) => [
          conformance.validity._tag,
          conformance.coherence._tag,
          conformance.termination._tag,
        ]),
      [
        ['ValidConformance', 'Coherent', 'Terminating'],
        ['InvalidConformance', 'Overlapping', 'Terminating'],
      ],
    )
    assert.isTrue(
      ConformanceProof.conforms(
        index,
        Type.nominal('model', 'Wrapper', ['i32']),
        Type.nominal('contracts', 'Present'),
      ),
    )
  }),
)

it.effect('does not grant service modules ownership of foreign nominal providers', () =>
  Effect.gen(function* () {
    const index = yield* collect('contracts', [
      ['model', 'pub struct Remote {}'],
      [
        'contracts',
        `import model { Remote }
service Gate { effect fn read() -> i32 ? &Gate }
impl Gate for Remote {}`,
      ],
    ])
    assert.deepEqual(
      index.published.map((diagnostic) => diagnostic.code),
      ['SEM0083'],
    )
  }),
)

it.effect('validates service mappings and rejects duplicate or foreign witnesses', () =>
  Effect.gen(function* () {
    const valid = yield* collect('allocator-valid', [
      [
        'allocator-valid',
        `service Allocator { effect fn allocate(layout: i32) -> i32 ? &mut Allocator }
struct TestAllocator { remaining: i32 }
effect fn allocate(self: &mut TestAllocator, layout: i32) -> i32 { return layout }
impl Allocator for TestAllocator { allocate: TestAllocator.allocate }`,
      ],
    ])
    assert.deepEqual(valid.published, [])
    assert.deepEqual(
      valid.modules.at(0)?.conformances.map((conformance) => conformance.validity._tag),
      ['ValidConformance'],
    )
    assert.isTrue(
      ConformanceProof.conforms(
        valid,
        Type.nominal('allocator-valid', 'TestAllocator'),
        Type.nominal('allocator-valid', 'Allocator'),
      ),
    )

    const invalid = yield* collect('allocator-invalid', [
      [
        'allocator-invalid',
        `service Allocator { effect fn allocate(layout: i32) -> i32 ? &mut Allocator }
struct TestAllocator { remaining: i32 }
fn allocate(self: &TestAllocator) -> i32 { return 0 }
impl Allocator for TestAllocator { allocate: Foreign.allocate }
impl Allocator for TestAllocator { allocate: TestAllocator.allocate }`,
      ],
    ])
    assert.deepEqual(
      invalid.published
        .filter((diagnostic) => diagnostic.code === 'SEM0083')
        .map((diagnostic) => diagnostic.reason._tag),
      ['InvalidConformance', 'InvalidConformance'],
    )
    assert.deepEqual(
      invalid.modules.at(0)?.conformances.map((conformance) => conformance.validity._tag),
      ['InvalidConformance', 'InvalidConformance'],
    )
    assert.isFalse(
      ConformanceProof.conforms(
        invalid,
        Type.nominal('allocator-invalid', 'TestAllocator'),
        Type.nominal('allocator-invalid', 'Allocator'),
      ),
    )
  }),
)

it.effect('accepts Drop for unmarked structs and rejects malformed headers', () =>
  Effect.gen(function* () {
    const index = yield* collect('drop-hooks', [
      [
        'drop-hooks',
        `struct Guard { allocation: Allocation }
struct CopyValue { value: i32 }
struct Left { value: i32 }
struct Right { value: i32 }
struct UnionHolder { value: Left | Right }
struct Malformed { allocation: Allocation }
struct Missing { allocation: Allocation }
struct Problem {}
struct Fallible { allocation: Allocation }
impl Drop for Guard { fn drop(self: &mut Guard) -> () { return () } }
impl Drop for CopyValue { fn drop(self: &mut CopyValue) -> () { return () } }
impl Drop for UnionHolder { fn drop(self: &mut UnionHolder) -> () { return () } }
impl Drop for Malformed { fn drop(self: &Malformed) -> () { return () } }
impl Drop for Missing {}
impl Drop for Fallible { fn drop(self: &mut Fallible) -> () ! Problem { return () } }
impl Drop for Guard { effect fn dispose(value: &Guard) -> i32 { return 0 } }`,
      ],
    ])
    const copyValue = Type.nominal('drop-hooks', 'CopyValue')
    const malformed = Type.nominal('drop-hooks', 'Malformed')
    const missing = Type.nominal('drop-hooks', 'Missing')
    const fallible = Type.nominal('drop-hooks', 'Fallible')
    for (const rejected of [malformed, missing, fallible]) {
      assert.strictEqual(
        index.modules
          .at(0)
          ?.conformances.find(
            (conformance) =>
              conformance.provider._tag === 'Resolved' &&
              Type.equals(conformance.provider.type, rejected),
          )?.validity._tag,
        'InvalidConformance',
      )
      assert.strictEqual(
        ConformanceProof.prove(index, rejected, Type.dropCapability)._tag,
        'Unproved',
      )
      assert.isUndefined(ConformanceProof.witness(index, rejected, Type.dropCapability))
      assert.isFalse(ConformanceProof.conforms(index, rejected, Type.dropCapability))
    }
    const guard = Type.nominal('drop-hooks', 'Guard')
    assert.strictEqual(ConformanceProof.prove(index, guard, Type.dropCapability)._tag, 'Proved')
    assert.isDefined(ConformanceProof.witness(index, guard, Type.dropCapability))
    assert.isTrue(ConformanceProof.conforms(index, guard, Type.dropCapability))
    for (const accepted of [copyValue, Type.nominal('drop-hooks', 'UnionHolder')]) {
      assert.strictEqual(
        ConformanceProof.prove(index, accepted, Type.dropCapability)._tag,
        'Proved',
      )
      assert.isTrue(ConformanceProof.conforms(index, accepted, Type.dropCapability))
    }
    assert.deepEqual(
      index.published
        .filter((diagnostic) => diagnostic.code === 'SEM0084')
        .map((diagnostic) =>
          diagnostic.reason._tag === 'InvalidDropHook' ? diagnostic.reason.detail : undefined,
        ),
      [
        'the hook must be fn drop(self: &mut Provider) -> () with no generics, failures, or requirements',
        'Drop requires one inline fn drop hook and no operation mappings',
        'the hook must be fn drop(self: &mut Provider) -> () with no generics, failures, or requirements',
      ],
    )
    assert.include(
      index.published
        .filter((diagnostic) => diagnostic.code === 'SEM0083')
        .map((diagnostic) =>
          diagnostic.reason._tag === 'InvalidConformance' ? diagnostic.reason.detail : undefined,
        ),
      'duplicate Drop implementation for drop-hooks.Guard',
    )
  }),
)

it.effect('rejects user Copy and Drop conformances for sealed scalar enums', () =>
  Effect.gen(function* () {
    const index = yield* collect('root', [
      [
        'root',
        `enum State { Ready }
impl Copy for State {}
impl Drop for State { fn drop(self: &mut State) -> () { return () } }`,
      ],
    ])

    assert.deepEqual(
      index.published.map((diagnostic) => ({
        code: diagnostic.code,
        reason: diagnostic.reason._tag,
      })),
      [
        { code: 'SEM0083', reason: 'InvalidConformance' },
        { code: 'SEM0083', reason: 'InvalidConformance' },
      ],
    )
    assert.deepEqual(
      index.modules.at(0)?.conformances.map((conformance) => conformance.validity._tag),
      ['InvalidConformance', 'InvalidConformance'],
    )
  }),
)

it.effect('rejects source Copy implementations for reference and structural providers', () =>
  Effect.gen(function* () {
    const index = yield* collect('reference-copy', [
      [
        'reference-copy',
        `impl Copy for &u32 {}
impl Copy for &mut u32 {}
impl Copy for u32 {}`,
      ],
    ])

    assert.deepEqual(
      index.published.map((diagnostic) => diagnostic.code),
      ['SEM0083', 'SEM0083', 'SEM0083'],
    )
    assert.deepEqual(
      index.modules.at(0)?.conformances.map((conformance) => conformance.validity._tag),
      ['InvalidConformance', 'InvalidConformance', 'InvalidConformance'],
    )
    assert.strictEqual(
      ConformanceProof.copyType(index, Type.reference('Shared', 'u32', Lifetime.staticLifetime)),
      true,
    )
    assert.strictEqual(
      ConformanceProof.copyType(index, Type.reference('Exclusive', 'u32', Lifetime.staticLifetime)),
      false,
    )
  }),
)

it.effect('publishes Copy only from one valid empty sealed impl', () =>
  Effect.gen(function* () {
    const index = yield* collect('copy-property', [
      [
        'copy-property',
        `struct Point { x: i32, y: i32 }
impl Copy for Point {}
struct Token { value: i32 }
struct Pair<T> { first: T, second: T }
impl<T: Copy> Copy for Pair<T> {}
struct Bad { token: Token }
impl Copy for Bad {}
struct Owned { allocation: Allocation }
impl Copy for Owned {}
struct Droppable { value: i32 }
impl Drop for Droppable { fn drop(self: &mut Droppable) -> () { return () } }
impl Copy for Droppable {}
service Clock {}
struct FixedClock {}
impl Copy for FixedClock {}
impl Clock for FixedClock {}`,
      ],
    ])
    const point = Type.nominal('copy-property', 'Point')
    const token = Type.nominal('copy-property', 'Token')
    const pairOf = (element: Type.Type): Type.Nominal =>
      Type.nominal('copy-property', 'Pair', [element])

    assert.isTrue(ConformanceProof.copyType(index, point))
    assert.isTrue(ConformanceProof.copyType(index, Type.nominal('copy-property', 'FixedClock')))
    assert.isFalse(ConformanceProof.copyType(index, token))
    assert.isTrue(ConformanceProof.copyType(index, pairOf('i32')))
    assert.isFalse(ConformanceProof.copyType(index, pairOf(token)))
    assert.isTrue(ConformanceProof.copyType(index, Type.fixedArray(point, 2)))
    const union = Type.union([point, pairOf('i32')])
    assert.strictEqual(union._tag, 'Normalized')
    if (union._tag === 'Normalized') assert.isTrue(ConformanceProof.copyType(index, union.type))

    assert.deepEqual(
      index.modules
        .at(0)
        ?.conformances.filter(
          (conformance) =>
            conformance.capability._tag === 'Resolved' &&
            Type.equals(conformance.capability.type, Type.copyCapability),
        )
        .map((conformance) => conformance.validity._tag),
      [
        'ValidConformance',
        'ValidConformance',
        'InvalidConformance',
        'InvalidConformance',
        'InvalidConformance',
        'ValidConformance',
      ],
    )
    assert.strictEqual(
      index.published.filter((diagnostic) => diagnostic.code === 'SEM0083').length,
      3,
    )
  }),
)

it.effect('validates Copy over every specialized nominal union variant field', () =>
  Effect.gen(function* () {
    const index = yield* collect('union-copy', [
      [
        'union-copy',
        `union Choice<T> { Empty, Present { value: T } }
impl<T: Copy> Copy for Choice<T> {}
union Implicit { Left { value: i32 }, Right }
union Owned { Empty, Present { allocation: Allocation } }
impl Copy for Owned {}`,
      ],
    ])
    const choice = (element: Type.Type): Type.Nominal =>
      Type.nominal('union-copy', 'Choice', [element])

    assert.isTrue(ConformanceProof.copyType(index, choice('i32')))
    assert.isFalse(ConformanceProof.copyType(index, choice(Type.nominal('union-copy', 'Implicit'))))
    assert.isFalse(ConformanceProof.copyType(index, Type.nominal('union-copy', 'Implicit')))
    assert.isFalse(ConformanceProof.copyType(index, Type.nominal('union-copy', 'Owned')))
    assert.deepEqual(
      index.modules.at(0)?.conformances.map((conformance) => conformance.validity._tag),
      ['ValidConformance', 'InvalidConformance'],
    )
    assert.deepEqual(
      index.published.map((diagnostic) => diagnostic.code),
      ['SEM0083'],
    )
  }),
)

it.effect('indexes parametric conformances with bound parameters', () =>
  Effect.gen(function* () {
    const index = yield* collect('parametric', [
      [
        'parametric',
        `struct Vector<T> { storage: Allocation }
impl<T> Drop for Vector<T> { fn drop(self: &mut Vector<T>) -> () { return () } }
pub fn main() -> i32 { return 0 }`,
      ],
    ])
    assert.deepEqual(index.published, [])
    const conformance = index.modules.at(0)?.conformances.at(0)
    assert.strictEqual(conformance?.typeParameters.length, 1)
    assert.strictEqual(conformance?.provider._tag, 'Resolved')
    if (conformance?.provider._tag === 'Resolved' && Type.isNominal(conformance.provider.type)) {
      const argument = conformance.provider.type.arguments.at(0)
      assert.isTrue(
        argument !== undefined && Type.isTypeArgument(argument) && Type.isParameter(argument),
      )
    }
  }),
)

it.effect('rejects unbound, duplicate, and overlapping parametric conformances', () =>
  Effect.gen(function* () {
    const details = (index: DeclarationIndex.Index, code: string) =>
      index.diagnostics
        .filter((diagnostic) => diagnostic.code === code)
        .map((diagnostic) =>
          'detail' in diagnostic.reason ? diagnostic.reason.detail : diagnostic.reason._tag,
        )

    const unbound = yield* collect('parametric-unbound', [
      [
        'parametric-unbound',
        `struct Vector<T> { storage: Allocation }
impl<T, U> Drop for Vector<T> { fn drop(self: &mut Vector<T>) -> () { return () } }`,
      ],
    ])
    assert.deepEqual(details(unbound, 'SEM0083'), [
      'impl type parameter U is not used by the provider type',
    ])

    const duplicate = yield* collect('parametric-duplicate', [
      [
        'parametric-duplicate',
        `struct Vector<T> { storage: Allocation }
impl<T, T> Drop for Vector<T> { fn drop(self: &mut Vector<T>) -> () { return () } }`,
      ],
    ])
    assert.deepEqual(
      duplicate.published.map((diagnostic) => diagnostic.code),
      ['SEM0050'],
    )

    const overlapping = yield* collect('parametric-overlap', [
      [
        'parametric-overlap',
        `struct Vector<T> { storage: Allocation }
impl<T> Drop for Vector<T> { fn drop(self: &mut Vector<T>) -> () { return () } }
impl<U> Drop for Vector<U> { fn drop(self: &mut Vector<U>) -> () { return () } }`,
      ],
    ])
    assert.deepEqual(details(overlapping, 'SEM0083'), [
      'duplicate Drop implementation for parametric-overlap.Vector<U>',
    ])
  }),
)

const spans = (index: PublishedIndex, source: string, code: string): ReadonlyArray<string> =>
  index.published
    .filter((diagnostic) => diagnostic.code === code)
    .map((diagnostic) => source.slice(diagnostic.span.start, diagnostic.span.end).trim())

it.effect('indexes foreign headers as unsafe bodiless function facts with a native symbol', () =>
  Effect.gen(function* () {
    const index = yield* collect('root', [
      [
        'root',
        `pub unsafe extern "C" fn abs(value: i32) -> i32
unsafe extern "C" fn closeSocket(value: i32) -> i32 as "close$NOCANCEL"
unsafe extern "C" fn every(a: i8, b: u8, c: i16, d: u16, e: i32, f: u32, g: i64, h: u64, i: isize, j: usize, k: f32, l: f64) -> ()
unsafe extern "C" fn bare(value: u8)`,
      ],
    ])
    const [abs, renamed, every, bare] = index.modules.at(0)?.declarations ?? []

    assert.deepEqual(index.published, [])
    assert.deepEqual(abs?.foreign, {
      variadic: false,
      abi: 'C',
      symbol: 'abs',
      contract: ForeignContract.conservative,
    })
    assert.strictEqual(abs?.unsafe, true)
    assert.strictEqual(abs?.visibility, 'Public')
    assert.strictEqual(abs?.phase, 'Runtime')
    assert.strictEqual(abs?.functionKind, 'Ordinary')
    assert.strictEqual(abs?.bodyTemplate, undefined)
    assert.strictEqual(abs?.returnType._tag, 'Resolved')
    assert.deepEqual(
      abs === undefined ? undefined : Type.encode(DeclarationFacts.callableContract(abs).result),
      'i32',
    )
    assert.strictEqual(
      abs === undefined ? undefined : DeclarationFacts.callableContract(abs).unsafe,
      true,
    )
    assert.deepEqual(renamed?.foreign, {
      variadic: false,
      abi: 'C',
      symbol: 'close$NOCANCEL',
      contract: ForeignContract.conservative,
    })
    assert.strictEqual(renamed?.visibility, 'Private')
    const spelling = (declaration: DeclarationFacts.DeclarationFact): string | undefined =>
      declaration.name._tag === 'Present' ? declaration.name.spelling : undefined
    assert.strictEqual(renamed === undefined ? undefined : spelling(renamed), 'closeSocket')
    assert.deepEqual(
      (index.modules.at(0)?.declarations ?? [])
        .filter((declaration) => spelling(declaration) === 'abs')
        .map((declaration) => declaration.visibility),
      ['Public'],
    )
    assert.strictEqual(every?.returnType._tag, 'Resolved')
    assert.strictEqual(every?.parameters.length, 12)
    assert.strictEqual(bare?.returnType._tag, 'Resolved')
    assert.strictEqual(DeclarationFacts.lookup(index, 'root', 'abs')._tag, 'Resolved')
  }),
)

it.effect('reports the same-module collision between a foreign and an ordinary function', () =>
  Effect.gen(function* () {
    const index = yield* collect('root', [
      [
        'root',
        `fn abs(value: i32) -> i32 { return value }
unsafe extern "C" fn abs(value: i32) -> i32`,
      ],
    ])

    assert.deepEqual(
      index.published.map((diagnostic) => diagnostic.code),
      ['SEM0003'],
    )
    assert.strictEqual(index.modules.at(0)?.declarations.at(1)?.canonical._tag, 'Duplicate')
  }),
)

it.effect('rejects foreign headers outside the C contract and publishes no callable', () =>
  Effect.gen(function* () {
    const cases: ReadonlyArray<readonly [string, string, ReadonlyArray<string>]> = [
      ['unsafe extern "fastcall" fn f() -> ()', 'SEM0185', ['"fastcall"']],
      ['extern "C" fn abs(value: i32) -> i32', 'SEM0186', ['abs']],
      ['pub static unsafe extern "C" fn f() -> i32', 'SEM0188', ['static']],
      ['unsafe extern "C" effect fn f() -> ()', 'SEM0188', ['effect']],
      ['unsafe extern "C" fn bad<T>(value: T) -> T', 'SEM0188', ['<T>']],
      ['struct Problem {}\nunsafe extern "C" fn f() -> i32 ! Problem', 'SEM0188', ['! Problem']],
      ['struct Clock {}\nunsafe extern "C" fn f() -> i32 ? &Clock', 'SEM0188', ['? &Clock']],
      [
        'unsafe extern "C" fn f<?S, P, ?R>() -> i32 where P provides S from R',
        'SEM0188',
        ['<?S, P, ?R>', 'where P provides S from R'],
      ],
      ['unsafe extern "C" fn bad() -> i32 { return 1 }', 'SEM0188', ['{ return 1 }']],
      ['unsafe extern "C" fn bad(text: string) -> ()', 'SEM0187', ['string']],
      ['unsafe extern "C" fn bad(flag: bool) -> char', 'SEM0187', ['bool', 'char']],
      ['unsafe extern "C" fn bad(bytes: &[u8]) -> ()', 'SEM0187', ['&[u8]']],
      ['unsafe extern "C" fn bad(value: &mut i32) -> ()', 'SEM0187', ['&mut i32']],
      ['unsafe extern "C" fn f() -> () as "not a symbol"', 'SEM0190', ['"not a symbol"']],
      ['unsafe extern "C" fn f() -> () as "$leading"', 'SEM0190', ['"$leading"']],
      ['unsafe extern "C" fn f() -> () as "a\\0b"', 'SEM0190', ['"a\\0b"']],
      ['unsafe extern "C" fn f() -> () as "\\u{FC}n\\u{EF}"', 'SEM0190', ['"\\u{FC}n\\u{EF}"']],
      [
        'unsafe extern "C" fn f() -> i32 as "__silk_foreign_personality"',
        'SEM0191',
        ['"__silk_foreign_personality"'],
      ],
    ]

    for (const [source, code, expected] of cases) {
      const index = yield* collect('root', [['root', source]])
      const header = index.modules.at(0)?.declarations.at(-1)

      assert.deepEqual(spans(index, source, code), expected, source)
      assert.strictEqual(header?.foreign?.abi, 'C', source)
      assert.strictEqual(header?.returnType._tag, 'Unavailable', source)
    }
  }),
)

it.effect('indexes exported functions as ordinary facts with a native export symbol', () =>
  Effect.gen(function* () {
    const index = yield* collect('root', [
      [
        'root',
        `export "C" fn double(value: i32) -> i32 { return value * 2 }
pub export "C" fn twice(value: i32) -> i32 as "silk$test$double_v1" { return value * 2 }
pub fn plain(value: i32) -> i32 { return value }`,
      ],
    ])
    const [named, renamed, plain] = index.modules.at(0)?.declarations ?? []

    assert.deepEqual(index.published, [])
    assert.deepEqual(named?.foreignExport, {
      variadic: false,
      abi: 'C',
      symbol: 'double',
      contract: ForeignContract.conservative,
    })
    assert.strictEqual(named?.foreign, undefined)
    assert.strictEqual(named?.visibility, 'Private')
    assert.strictEqual(named?.unsafe, false)
    assert.strictEqual(named?.phase, 'Runtime')
    assert.strictEqual(named?.functionKind, 'Ordinary')
    assert.strictEqual(named?._tag, 'FunctionDeclaration')
    assert.strictEqual(named?.returnType._tag, 'Resolved')
    assert.strictEqual(
      named === undefined ? undefined : DeclarationFacts.callableContract(named).unsafe,
      false,
    )
    assert.deepEqual(renamed?.foreignExport, {
      variadic: false,
      abi: 'C',
      symbol: 'silk$test$double_v1',
      contract: ForeignContract.conservative,
    })
    assert.strictEqual(renamed?.visibility, 'Public')
    assert.strictEqual(plain?.foreignExport, undefined)
    assert.strictEqual(plain?.visibility, 'Public')
    assert.strictEqual(DeclarationFacts.lookup(index, 'root', 'double')._tag, 'Resolved')
  }),
)

it.effect('indexes imported and exported C statics as immutable typed data symbols', () =>
  Effect.gen(function* () {
    const index = yield* collect('root', [
      [
        'root',
        `unsafe extern "C" static environment: *mut *mut u8 as "environ$data"
export "C" static answer: i32 as "silk$data" = 42`,
      ],
    ])
    const [environment, answer] = index.modules.at(0)?.members ?? []

    assert.deepEqual(index.published, [])
    assert.strictEqual(environment?._tag, 'ForeignStaticDeclaration')
    assert.strictEqual(answer?._tag, 'ForeignStaticDeclaration')
    if (
      environment?._tag !== 'ForeignStaticDeclaration' ||
      answer?._tag !== 'ForeignStaticDeclaration'
    )
      return
    assert.strictEqual(environment.direction, 'Import')
    assert.deepEqual(environment.foreign, { abi: 'C', symbol: 'environ$data' })
    assert.strictEqual(environment.declaredType._tag, 'Resolved')
    assert.strictEqual(answer.direction, 'Export')
    assert.deepEqual(answer.foreign, { abi: 'C', symbol: 'silk$data' })
    assert.deepEqual(answer.literal?._tag, 'IntegerLiteral')
    assert.strictEqual(answer.declaredType._tag, 'Resolved')
  }),
)

it.effect('rejects a non-C function-pointer ABI at its type declaration', () =>
  Effect.gen(function* () {
    const index = yield* collect('root', [
      ['root', 'fn install(callback: extern "system" fn(i32) -> i32) -> () {}'],
    ])
    assert.deepEqual(
      index.published.map((diagnostic) => diagnostic.code),
      ['SEM0185'],
    )
  }),
)

it.effect('rejects exported C statics without a matching scalar literal', () =>
  Effect.gen(function* () {
    const index = yield* collect('root', [
      [
        'root',
        'export "C" static pointer: *mut u8 = 0\nexport "C" static count: i32 = 1.5\nexport "C" static byte: u8 = 256',
      ],
    ])
    assert.deepEqual(
      index.published.map((diagnostic) => diagnostic.code),
      ['SEM0086', 'SEM0086', 'SEM0086'],
    )
    assert.deepEqual(
      index.modules
        .at(0)
        ?.members.filter((declaration) => declaration._tag === 'ForeignStaticDeclaration')
        .map((declaration) => declaration.declaredType._tag),
      ['Unavailable', 'Unavailable', 'Unavailable'],
    )
  }),
)

it.effect(
  'rejects exported headers outside the C contract and publishes no callable or export',
  () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<readonly [string, string, ReadonlyArray<string>]> = [
        ['export "fastcall" fn f() -> () { }', 'SEM0185', ['"fastcall"']],
        ['pub static export "C" fn f() -> i32 { return 1 }', 'SEM0188', ['static']],
        ['unsafe export "C" fn f() -> i32 { return 1 }', 'SEM0188', ['unsafe']],
        ['export "C" effect fn f() -> () { }', 'SEM0188', ['effect']],
        ['export "C" fn bad<T>(value: T) -> T { return move value }', 'SEM0188', ['<T>']],
        [
          'struct Problem {}\nexport "C" fn f() -> i32 ! Problem { return 1 }',
          'SEM0188',
          ['! Problem'],
        ],
        [
          'struct Clock {}\nexport "C" fn f() -> i32 ? &Clock { return 1 }',
          'SEM0188',
          ['? &Clock'],
        ],
        [
          'export "C" fn f<?S, P, ?R>() -> i32 where P provides S from R { return 1 }',
          'SEM0188',
          ['<?S, P, ?R>', 'where P provides S from R'],
        ],
        ['export "C" fn bad() -> string<\'static> { return "" }', 'SEM0187', ["string<'static>"]],
        ['export "C" fn bad(flag: bool) -> char { return \'a\' }', 'SEM0187', ['bool', 'char']],
        ['export "C" fn f() -> () as "not a symbol" { }', 'SEM0190', ['"not a symbol"']],
      ]

      for (const [source, code, expected] of cases) {
        const index = yield* collect('root', [['root', source]])
        const header = index.modules.at(0)?.declarations.at(-1)

        assert.deepEqual(spans(index, source, code), expected, source)
        assert.strictEqual(header?.foreignExport, undefined, source)
        assert.strictEqual(header?.returnType._tag, 'Unavailable', source)
      }
    }),
)

it.effect('does not double-report a foreign header whose ABI literal the parser lost', () =>
  Effect.gen(function* () {
    const index = yield* collect('root', [['root', 'unsafe extern fn f() -> i32']])

    assert.deepEqual(
      index.published.map((diagnostic) => diagnostic.code),
      [],
    )
    assert.strictEqual(index.modules.at(0)?.declarations.at(0)?.foreign?.symbol, 'f')
  }),
)

it.effect('resolves raw pointer types in every position and proves them Copy without impl', () =>
  Effect.gen(function* () {
    const index = yield* collect('pointers', [
      [
        'pointers',
        `struct Opaque {}
struct Handle { raw: *mut Opaque }
impl Copy for Handle {}
fn take(value: *const i32, nested: *mut *const u8, handle: *mut Handle) -> *mut Handle { return handle }`,
      ],
    ])
    const module = index.modules.at(0)
    const take = module?.declarations.find((declaration) => declaration.parameterCount === 3)
    const encoded = (fact: DeclarationFacts.DeclaredTypeFact | undefined) =>
      fact?._tag === 'Resolved' ? Type.encode(fact.type) : fact?._tag

    assert.deepEqual(index.published, [])
    assert.deepEqual(
      take?.parameters.map((parameter) => encoded(parameter.declaredType)),
      ['*const i32', '*mut *const u8', '*mut pointers.Handle'],
    )
    assert.strictEqual(encoded(take?.returnType), '*mut pointers.Handle')
    assert.strictEqual(
      encoded(module?.structs.at(1)?.fields.at(0)?.declaredType),
      '*mut pointers.Opaque',
    )
    assert.deepEqual(
      module?.conformances.map((conformance) => conformance.validity._tag),
      ['ValidConformance'],
    )
    const handle = Type.nominal('pointers', 'Handle')
    assert.strictEqual(ConformanceProof.copyType(index, handle), true)
    assert.strictEqual(
      ConformanceProof.copyType(
        index,
        Type.pointer({
          mutable: true,
          pointee: handle,
          nullable: false,
          extent: 'Single',
          alignment: 'Natural',
          addressSpace: 0,
        }),
      ),
      true,
    )
    assert.strictEqual(CleanupPlan.cleanupPlan(index, handle)._tag, 'NoCleanup')
    assert.strictEqual(
      CleanupPlan.cleanupPlan(
        index,
        Type.pointer({
          mutable: false,
          pointee: Type.nominal('pointers', 'Opaque'),
          nullable: false,
          extent: 'Single',
          alignment: 'Natural',
          addressSpace: 0,
        }),
      )._tag,
      'NoCleanup',
    )
  }),
)

it.effect('elaborates lifetime headers independently of function bodies and source offsets', () =>
  Effect.gen(function* () {
    const header = `struct View<'a, T: 'a> { value: &'a T }
fn choose<'a: 'b, 'b>(left: &'a i32, right: &'b i32) -> &'b i32 { return right }
fn identity(value: &i32) -> &i32 { return value }
fn visit(callback: for<'a> fn(&'a i32) -> &'a i32) {}`
    const first = yield* collect('root', [['root', header]])
    const second = yield* collect('root', [
      ['root', `// offset change\n${header.replace('return value', 'return value;')}`],
    ])
    assert.deepEqual(
      first.published.map((diagnostic) => diagnostic.code),
      [],
    )
    assert.deepEqual(
      second.published.map((diagnostic) => diagnostic.code),
      [],
    )
    const signatures = (index: DeclarationIndex.Index) =>
      index.modules.at(0)?.declarations.map((declaration) => ({
        parameters: declaration.parameters.map((parameter) =>
          parameter.declaredType._tag === 'Resolved'
            ? Type.key(parameter.declaredType.type)
            : parameter.declaredType._tag,
        ),
        result:
          declaration.returnType._tag === 'Resolved'
            ? Type.key(declaration.returnType.type)
            : declaration.returnType._tag,
        binders: declaration.typeParameters.map((parameter) => Type.key(parameter.type)),
      }))
    assert.deepEqual(signatures(first), signatures(second))
    const identity = first.modules
      .at(0)
      ?.declarations.find(
        (declaration) =>
          declaration.name._tag === 'Present' && declaration.name.spelling === 'identity',
      )
    assert.strictEqual(identity?.typeParameters.length, 1)
    assert.strictEqual(identity?.typeParameters.at(0)?.implicitLifetime, true)
    const choose = first.modules
      .at(0)
      ?.declarations.find(
        (declaration) =>
          declaration.name._tag === 'Present' && declaration.name.spelling === 'choose',
      )
    assert.strictEqual(choose?.typeParameters.at(0)?.lifetimeBounds?.length, 1)
    if (choose !== undefined)
      assert.strictEqual(DeclarationFacts.executableLifetimes(choose).lifetimeBounds?.length, 1)
  }),
)

it.effect(
  'elaborates invocation-use role with original bound coordinates and complete positional inputs',
  () =>
    Effect.gen(function* () {
      const source = `fn mixed(callback: for<'data, use 'call> fn<'static>(&'data i32, i32) -> i32) {}
fn pure<E>(callback: for<use 'call> fn<'static>(E) -> i32) {}
fn ordinary(callback: for<'call> fn<'static>(i32) -> i32) {}`
      const index = yield* collect('root', [['root', source]])
      assert.deepEqual(index.published, [])
      const declarations = index.modules.at(0)?.declarations ?? []
      const contract = (name: string) => {
        const declaration =
          declarations.find(
            (value) => value.name._tag === 'Present' && value.name.spelling === name,
          ) ?? unreachable(`expected ${name}`)
        const context =
          declaration.lifetimeElaboration ?? unreachable('expected lifetime elaboration')
        const raw = [...context.callables.values()].at(0) ?? unreachable('expected raw callable')
        const resolved = declaration.parameters.at(0)?.declaredType
        if (resolved?._tag !== 'Resolved' || !Type.isCallable(resolved.type))
          return unreachable('expected resolved callable parameter')
        return { context, raw, selected: resolved.type }
      }
      const mixed = contract('mixed')
      const use = mixed.raw.invocationUse ?? unreachable('expected invocation-use role')
      assert.deepEqual(use.parameters, [0, 1])
      assert.deepEqual(use.lifetime, Lifetime.bound(mixed.context.owner, 1, "'call", [0]))
      assert.deepEqual(mixed.raw.lifetimeBinders.at(1), use.lifetime)
      assert.deepEqual(mixed.selected.invocationUse, use)
      assert.strictEqual(mixed.raw.lifetimeBounds?.length, 0)
      // Role retention does not depend on a reference or returned computation mentioning κ.
      const pure = contract('pure')
      assert.deepEqual(pure.raw.invocationUse, {
        lifetime: Lifetime.bound(pure.context.owner, 0, "'call", [0]),
        parameters: [0],
      })
      assert.deepEqual(pure.selected.invocationUse, pure.raw.invocationUse)
      assert.strictEqual(pure.selected.lifetimeBinders.length, 1)
      assert.strictEqual(contract('ordinary').raw.invocationUse, undefined)
      assert.strictEqual(contract('ordinary').selected.invocationUse, undefined)
    }),
)

it.effect(
  'rejects bounded, repeated, static, foreign and nested invocation-use roles at authored spans',
  () =>
    Effect.gen(function* () {
      const source = `fn bounded(callback: for<use 'call: 'static> fn<'static>(i32) -> i32) {}
fn repeated(callback: for<use 'first, use 'second> fn<'static>(i32) -> i32) {}
fn staticRole(callback: for<use 'static> fn<'static>(i32) -> i32) {}
fn foreignRole(callback: for<use 'call> extern "C" fn(i32) -> i32) {}
fn nested(callback: fn<'static>(for<use 'inner> fn<'static>(i32) -> i32) -> i32) {}`
      const index = yield* collect('root', [['root', source]])
      const errors = index.published.filter(
        (diagnostic) => diagnostic.code === Diagnostic.invalidLifetimeBinderCode,
      )
      const fragments = [
        "use 'call: 'static",
        "use 'second",
        "use 'static",
        "use 'call",
        "for<use 'inner> fn<'static>(i32) -> i32",
      ]
      assert.strictEqual(errors.length, fragments.length)
      for (const [ordinal, fragment] of fragments.entries()) {
        const after = ordinal === 3 ? source.indexOf('fn foreignRole') : 0
        const start = source.indexOf(fragment, after)
        assert.isAtLeast(start, 0)
        assert.isTrue(
          errors.some(
            (diagnostic) =>
              diagnostic.span.sourceId === 'root' &&
              diagnostic.span.start === start &&
              diagnostic.span.end === start + fragment.length,
          ),
        )
      }
      for (const declaration of index.modules.at(0)?.declarations ?? [])
        for (const contract of declaration.lifetimeElaboration?.callables.values() ?? [])
          assert.strictEqual(contract.invocationUse, undefined)
    }),
)

it.effect('diagnoses ambiguous outputs and unknown lifetime names at authored annotations', () =>
  Effect.gen(function* () {
    const text = `fn ambiguous(left: &i32, right: &i32) -> &i32 { return left }
fn missing(value: &'lost i32) {}`
    const index = yield* collect('root', [['root', text]])
    const diagnostics = index.published.filter(
      (diagnostic) => diagnostic.code === 'SEM0210' || diagnostic.code === 'SEM0209',
    )
    assert.deepEqual([...new Set(diagnostics.map((diagnostic) => diagnostic.code))].sort(), [
      'SEM0209',
      'SEM0210',
    ])
    assert.isTrue(
      diagnostics.some(
        (diagnostic) => text.slice(diagnostic.span.start, diagnostic.span.end).trim() === '&i32',
      ),
    )
    assert.isTrue(
      diagnostics.some(
        (diagnostic) => text.slice(diagnostic.span.start, diagnostic.span.end) === "'lost",
      ),
    )
  }),
)

it.effect('fills omitted nominal lifetime arguments after resolving their declarations', () =>
  Effect.gen(function* () {
    const index = yield* collect('root', [
      [
        'root',
        `struct View<'a, T> { value: &'a T }
fn implicit(left: View<i32>, right: Wrapper) {}
struct Wrapper { value: Text }
struct Text { value: &i32 }
fn explicit<'a>(value: View<'a, i32>) {}`,
      ],
    ])
    assert.deepEqual(
      index.published.map((diagnostic) => diagnostic.code),
      [],
    )
    const implicit = index.modules
      .at(0)
      ?.declarations.find(
        (declaration) =>
          declaration.name._tag === 'Present' && declaration.name.spelling === 'implicit',
      )
    assert.deepEqual(
      implicit?.typeParameters.map((parameter) => parameter.type.kind),
      ['Lifetime', 'Lifetime'],
    )
    assert.deepEqual(
      implicit?.parameters.map((parameter) =>
        parameter.declaredType._tag === 'Resolved' && Type.isNominal(parameter.declaredType.type)
          ? parameter.declaredType.type.arguments.length
          : -1,
      ),
      [2, 1],
    )
  }),
)

it.effect('rejects a witness lifetime bound stronger than the quantified interface contract', () =>
  Effect.gen(function* () {
    const text = `interface Select { fn choose<'a, 'b>(left: &'a i32, right: &'b i32) -> &'a i32 }
impl Select for i32 { fn choose<'x: 'y, 'y>(left: &'x i32, right: &'y i32) -> &'x i32 { return left } }
interface Bounded { fn choose<'a: 'b, 'b>(left: &'a i32, right: &'b i32) -> &'a i32 }
impl Bounded for i32 { fn choose<'x: 'y, 'y>(left: &'x i32, right: &'y i32) -> &'x i32 { return left } }`
    const index = yield* collect('root', [['root', text]])
    assert.deepEqual(
      index.published.map((diagnostic) => diagnostic.code),
      ['SEM0083'],
    )
    const diagnostic = index.published.at(0)
    assert.isTrue(
      diagnostic !== undefined && diagnostic.span.start < text.indexOf('interface Bounded'),
    )
  }),
)

it.effect('makes lifetime headers explicit without changing canonical contracts or comments', () =>
  Effect.gen(function* () {
    const source = `struct Pair<T> { // independent views
  first: &T
  second: &[T]
}
fn apply<T>(value: &T, callback: fn(&T) -> &T) -> &T { return value }`
    const collected = yield* collectWithClosure('root', [['root', source]])
    const original = collected.index
    const syntax = rootSyntax(collected.closure)
    assert.deepEqual(
      original.published.map((diagnostic) => diagnostic.code),
      [],
    )
    const contexts =
      original.modules
        .at(0)
        ?.members.flatMap((member) =>
          'lifetimeElaboration' in member && member.lifetimeElaboration !== undefined
            ? [{ member, context: member.lifetimeElaboration }]
            : [],
        ) ?? []
    const plans = contexts.map(({ member, context }) =>
      Option.getOrThrow(planExplicit(collected.closure, syntax, member, context)),
    )
    const edits = plans
      .flatMap((plan) => plan.plan.changes.get('root') ?? [])
      .sort((left, right) => right.span.start - left.span.start)
    const expanded = edits.reduce(
      (text, edit) =>
        `${text.slice(0, edit.span.start)}${edit.replacement}${text.slice(edit.span.end)}`,
      source,
    )
    assert.include(expanded, '// independent views')
    assert.include(expanded, "Pair<T, 'life1, 'life2>")
    assert.include(expanded, "for<'call0> fn<'life2>")
    const reparsed = yield* collectWithClosure('root', [['root', expanded]])
    const explicit = reparsed.index
    const explicitSyntax = rootSyntax(reparsed.closure)
    assert.deepEqual(
      explicit.published.map((diagnostic) => diagnostic.code),
      [],
    )
    const keys = (index: DeclarationIndex.Index) =>
      index.modules.at(0)?.members.map((member) => ({
        parameters:
          'typeParameters' in member
            ? member.typeParameters.map((parameter) => Type.key(parameter.type))
            : [],
        fields:
          member._tag === 'StructDeclaration'
            ? member.fields.map((field) =>
                field.declaredType._tag === 'Resolved'
                  ? Type.key(field.declaredType.type)
                  : field.declaredType._tag,
              )
            : [],
        contract:
          member._tag === 'FunctionDeclaration'
            ? member.parameters.map((parameter) =>
                parameter.declaredType._tag === 'Resolved'
                  ? Type.key(parameter.declaredType.type)
                  : parameter.declaredType._tag,
              )
            : [],
      }))
    assert.deepEqual(keys(explicit), keys(original))
    assert.isTrue(
      explicit.modules
        .at(0)
        ?.members.every(
          (member) =>
            !('lifetimeElaboration' in member) ||
            member.lifetimeElaboration === undefined ||
            Option.isNone(
              planExplicit(reparsed.closure, explicitSyntax, member, member.lifetimeElaboration),
            ),
        ),
    )
  }),
)

it.effect('elaborates omitted Effect environments from the regions inputs retain', () =>
  Effect.gen(function* () {
    const source = `struct Held<'a> { value: &'a i32 }
effect fn owned(input: i32) -> i32 { return input }
effect fn two(left: &i32, right: &i32) -> i32 { return left.* + right.* }
effect fn held<'a>(value: Held<'a>) -> i32 { return value.value.* }
effect fn pending<A>(value: once Effect<A>) -> A { return run move value }
effect fn view<T>(value: &T) -> i32 { return 0 }
effect fn keep<T>(value: T) -> i32 { drop value return 0 }
effect<'env> fn keepNamed<T: 'env, 'env>(value: T) -> i32 { drop value return 0 }
fn closed() -> Effect<i32> { return effect { return 42 } }
fn later(value: i32) -> Effect<i32> { return effect { return value } }
fn heldLater<'a>(value: Held<'a>) -> Effect<i32> { return effect { return 1 } }
fn twoLater(left: &i32, right: &i32) -> Effect<i32> { return effect { return 1 } }
effect fn nested() -> Effect<i32> { return owned(1) }
fn borrowedLater(value: &i32) -> Effect<i32> { return effect { return value.* } }
fn heldBorrowedLater<'a>(value: &i32, held: Held<'a>) -> Effect<i32> { return effect { return value.* } }
effect fn borrowedSuccess(value: &i32) -> Effect<i32> { return owned(value.*) }
effect fn callback<F: fn(i32) -> i32>(f: F) -> i32 { return f(1) }
effect fn staticCallback<F: fn<'static>(i32) -> i32 + Intrinsic.Detached>(f: F) -> i32 { return f(1) }
effect fn detached<T: Intrinsic.Detached>(value: T) -> i32 { drop value return 0 }`
    const index = yield* collect('root', [['root', source]])
    const declarations = index.modules.at(0)?.declarations ?? []
    const named = (name: string) =>
      declarations.find(
        (declaration) => declaration.name._tag === 'Present' && declaration.name.spelling === name,
      ) ?? unreachable(`expected ${name}`)
    const environment = (name: string) =>
      Lifetime.display(DeclarationFacts.executableLifetimes(named(name)).environment)
    const resultEnvironment = (name: string) => {
      const result = named(name).returnType
      return result._tag === 'Resolved' && Type.isEffect(result.type)
        ? Lifetime.display(result.type.environment)
        : undefined
    }
    assert.strictEqual(environment('owned'), "'static")
    assert.strictEqual(
      Lifetime.key(DeclarationFacts.executableLifetimes(named('two')).environment),
      Lifetime.key(
        Lifetime.intersection(
          named('two').parameters.flatMap((parameter) =>
            parameter.declaredType._tag === 'Resolved' &&
            Type.isReference(parameter.declaredType.type)
              ? [parameter.declaredType.type.lifetime]
              : [],
          ),
        ),
      ),
    )
    assert.strictEqual(environment('held'), "'a")
    assert.notStrictEqual(environment('pending'), "'static")
    assert.notStrictEqual(environment('view'), "'static")
    assert.strictEqual(environment('keepNamed'), "'env")
    assert.strictEqual(resultEnvironment('closed'), "'static")
    assert.strictEqual(resultEnvironment('later'), "'static")
    // LIFE-003 keeps supplying a sole borrowed input's region, also for an effect fn success.
    const borrowedRegion = (name: string) => {
      const parameter = named(name).parameters.at(0)?.declaredType
      return parameter?._tag === 'Resolved' && Type.isReference(parameter.type)
        ? Lifetime.display(parameter.type.lifetime)
        : unreachable(`expected a borrowed input of ${name}`)
    }
    assert.strictEqual(resultEnvironment('borrowedLater'), borrowedRegion('borrowedLater'))
    assert.strictEqual(resultEnvironment('heldBorrowedLater'), borrowedRegion('heldBorrowedLater'))
    assert.strictEqual(resultEnvironment('borrowedSuccess'), borrowedRegion('borrowedSuccess'))
    // A representation parameter retains its contract's environment, nothing when detached. A
    // plain detached value parameter still has unknown contents, as the reference states.
    assert.notStrictEqual(environment('callback'), "'static")
    assert.strictEqual(environment('staticCallback'), "'static")
    assert.deepEqual(
      index.published.map((diagnostic) => [
        diagnostic.code,
        source.slice(diagnostic.span.start, diagnostic.span.end),
        source.slice(0, diagnostic.span.start).split('\n').length,
      ]),
      [
        ['SEM0210', 'T', 7],
        ['SEM0210', 'Effect<i32>', 11],
        ['SEM0210', 'Effect<i32>', 12],
        ['SEM0210', 'Effect<i32>', 13],
        ['SEM0210', 'T', 19],
      ],
    )
  }),
)

it.effect('infers a witness binder that names only its written Effect environment', () =>
  Effect.gen(function* () {
    const source = `interface Consume<T> { effect<'env> fn consume<'env>(self: &Self, value: T) -> i32 }
struct Counter {}
impl<T> Consume<T> for Counter {
  effect<'env> fn consume<'env>(self: &Self, value: T) -> i32 { drop value return 1 }
}
struct Split {}
impl<T> Consume<T> for Split {
  effect<'a & 'b> fn consume<'a, 'b>(self: &Self, value: T) -> i32 { drop value return 1 }
}
struct Held<'a> { value: &'a i32 }
interface Tick { effect<'static> fn tick(self: Self) -> i32 }
impl<'a> Tick for Held<'a> { effect<'a> fn tick(self: Self) -> i32 { return self.value.* } }
struct Plain {}
impl Tick for Plain { effect fn tick(self: Self) -> i32 { drop self return 0 } }`
    const index = yield* collect('root', [['root', source]])
    // One promised region cannot choose between two otherwise unconstrained witness binders.
    assert.deepEqual(
      index.published.map((diagnostic) => [
        diagnostic.code,
        source.slice(diagnostic.span.start, diagnostic.span.end).split('(')[0],
      ]),
      [
        ['SEM0083', "effect<'a & 'b> fn consume<'a, 'b>"],
        // A witness environment shorter than the promised one is rejected.
        ['SEM0083', "effect<'a> fn tick"],
      ],
    )
  }),
)

it.effect('keeps an owned operand lent to a witness from escaping through its success', () =>
  Effect.gen(function* () {
    const source = `struct Token { value: i32 }
interface Decode { effect<'env> fn decode<'env>(value: Self) -> i32 }
effect fn decode(value: &Token) -> i32 { return value.value }
impl Decode for Token { decode: Token.decode }
struct Peeked { value: i32 }
interface Peek { effect<'env> fn peek<'env>(value: Self) -> &'static i32 }
effect fn peek(value: &Peeked) -> &i32 { return &value.value }
impl Peek for Peeked { peek: Peeked.peek }
struct Deferred { value: i32 }
interface Later { fn later(value: Self) -> Effect<'static; i32> }
fn later(value: &Deferred) -> Effect<i32> { return effect { return value.value } }
impl Later for Deferred { later: Deferred.later }`
    const index = yield* collect('root', [['root', source]])
    // The lent borrow may stay inside the adapter's Effect, but never in the promised success.
    assert.deepEqual(
      index.published.map((diagnostic) => [
        diagnostic.code,
        source.slice(0, diagnostic.span.start).split('\n').length,
      ]),
      [
        ['SEM0083', 8],
        ['SEM0083', 12],
      ],
    )
  }),
)

it.effect('makes retained Effect environments explicit without strengthening the contract', () =>
  Effect.gen(function* () {
    const source = `struct Held<'a> { value: &'a i32 }
effect fn owned(value: i32) -> i32 { return value }
effect fn combine<'a, 'b>(left: &'a i32, right: &'b i32) -> i32 { return left.* + right.* }
effect fn held<'a>(value: Held<'a>) -> i32 { return value.value.* }
service Work { effect<'static> fn tick() -> i32 }`
    const collected = yield* collectWithClosure('root', [['root', source]])
    const original = collected.index
    const syntax = rootSyntax(collected.closure)
    assert.deepEqual(original.published, [])
    const declarations = original.modules.at(0)?.declarations ?? []
    const edits = declarations
      .flatMap((declaration) => {
        const context = declaration.lifetimeElaboration
        if (context === undefined) return []
        const expansion = Option.getOrThrow(
          planExplicit(
            collected.closure,
            syntax,
            declaration,
            context,
            DeclarationFacts.executableLifetimes(declaration),
          ),
        )
        return expansion.plan.changes.get('root') ?? []
      })
      .sort((left, right) => right.span.start - left.span.start)
    const expanded = edits.reduce(
      (text, edit) =>
        `${text.slice(0, edit.span.start)}${edit.replacement}${text.slice(edit.span.end)}`,
      source,
    )
    assert.include(expanded, "effect<'static> fn owned(")
    assert.include(expanded, "effect<'a & 'b> fn combine<'a, 'b>(")
    assert.include(expanded, "effect<'a> fn held<'a>(")
    const reparsed = yield* collectWithClosure('root', [['root', expanded]])
    const explicit = reparsed.index
    const explicitSyntax = rootSyntax(reparsed.closure)
    assert.deepEqual(explicit.published, [])
    const contracts = (index: DeclarationIndex.Index) =>
      index.modules
        .at(0)
        ?.declarations.map((declaration) =>
          Type.key(Type.effect('i32', [], DeclarationFacts.executableLifetimes(declaration))),
        )
    assert.deepEqual(contracts(explicit), contracts(original))
    for (const declaration of explicit.modules.at(0)?.declarations ?? []) {
      const context = declaration.lifetimeElaboration
      if (context !== undefined)
        assert.isTrue(
          Option.isNone(
            planExplicit(
              reparsed.closure,
              explicitSyntax,
              declaration,
              context,
              DeclarationFacts.executableLifetimes(declaration),
            ),
          ),
        )
    }
  }),
)

it.effect(
  'keeps ordinary exclusive access, abstract Drop storage, and callable invocation outcomes admitted',
  () =>
    Effect.gen(function* () {
      const source = `struct Cell { value: i32 }
fn inspect(value: &mut Cell) -> i32 { return value.value }
struct Guard<T> { value: T }
impl<T> Drop for Guard<T> { fn drop(self: &mut Guard<T>) -> () { return () } }
fn retain<T>(value: T) -> i32 { let held = Guard { value: move value } return 0 }
fn invoke<'env>(callback: for<'a> fn<'env>(&'a i32) -> &'a i32) -> i32 { return 0 }
effect fn staticText() -> string<'static> { return "ready" }`
      const snapshot = yield* Analysis.ofSource('admission-valid', ascii(source))
      assert.deepEqual(Analysis.diagnostics(snapshot), [])
    }),
)

it.effect('retains nested pointer qualifiers and diagnoses invalid qualifier values', () =>
  Effect.gen(function* () {
    const valid = yield* collect('qualified', [
      [
        'qualified',
        `
unsafe extern "C" fn entries() -> ?[*]const ?*mut align(1) addrspace(0) i32
pub struct Nested<T> { value: ?[*]const ?*mut align(1) T }
`,
      ],
    ])
    assert.deepEqual(valid.published, [])
    const result = valid.modules[0]?.declarations[0]?.returnType
    assert.strictEqual(result?._tag, 'Resolved')
    if (result?._tag === 'Resolved')
      assert.strictEqual(Type.encode(result.type), '?[*]const ?*mut align(1) i32')
    for (const qualifier of ['align(0)', 'align(3)', 'addrspace(1)', 'align(1) align(2)']) {
      const invalid = yield* collect('invalid', [
        ['invalid', `unsafe extern "C" fn value() -> *const ${qualifier} i32`],
      ])
      const diagnostics = invalid.published.filter((diagnostic) => diagnostic.code === 'SEM0215')
      assert.strictEqual(diagnostics.length, 1)
      assert.strictEqual(diagnostics[0]?.span.sourceId, 'invalid')
      assert.isAbove(diagnostics[0]?.span.start ?? 0, 0)
    }
  }),
)
