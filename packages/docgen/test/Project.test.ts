import * as Layer from 'effect/Layer'
import { assert, it } from '@effect/vitest'
import * as Analysis from '@silklang/compiler/Analysis'
import * as ProjectAnalysis from '@silklang/compiler/ProjectAnalysis'
import * as SourceFile from '@silklang/compiler/SourceFile'
import * as SourceResolver from '@silklang/compiler/SourceResolver'
import * as Effect from 'effect/Effect'
import * as Example from '../src/Example.js'
import * as Json from '../src/Json.js'
import * as Model from '../src/Model.js'
import * as Project from '../src/Project.js'
import * as Site from '../src/Site.js'

const encode = (value: string): Uint8Array => new TextEncoder().encode(value)

it.effect('builds public-first project JSON with first-class child documentation', () =>
  Effect.gen(function* () {
    const source = `//! Recovery utilities.

/// Default recovery code.
pub const defaultCode: i32 = 7

/// Primary dependency position.
pub role Primary

/// Public recovery.
pub fn recover(
  /// The failure to inspect.
  problem: Problem
) -> i32 { return problem.code }

/// Not part of public output.
fn helper() -> i32 { return 0 }
struct Hidden {}
impl Copy for Hidden {}

/// A recoverable problem.
pub struct Problem {
  /// Stable numeric code.
  pub code: i32
  privateCode: i32
}

/// One recovery state.
pub enum State {
  /// The operation can start.
  Ready
}

/// A computation with a [\`Success\`] variant.
pub union Outcome<T> {
  /// A successful payload.
  Success { pub value: T },
  /// No payload is available.
  Empty
}

/// A name for the recoverable problem.
pub type Trouble = Problem
`
    const snapshot = yield* Analysis.ofSource('project/main', encode(source))
    const publicProject = Project.make(snapshot)
    const module = publicProject.modules.at(0)
    assert.isDefined(module)
    assert.strictEqual(module.documentation?.markdown, 'Recovery utilities.')
    assert.deepStrictEqual(
      module.items.filter((item) => item.kind !== 'Implementation').map((item) => item.name),
      ['defaultCode', 'Primary', 'recover', 'Problem', 'State', 'Outcome', 'Trouble'],
    )
    const trouble = module.items.find((item) => item.name === 'Trouble')
    assert.strictEqual(trouble?.kind, 'Alias')
    assert.include(trouble?.signature.text, 'Problem')
    assert.strictEqual(trouble?.documentation?.markdown, 'A name for the recoverable problem.')
    const defaultCode = module.items.find((item) => item.name === 'defaultCode')
    assert.strictEqual(defaultCode?.kind, 'Constant')
    assert.strictEqual(defaultCode?.signature.text, 'pub const defaultCode: i32')
    assert.strictEqual(defaultCode?.documentation?.markdown, 'Default recovery code.')
    const primary = module.items.find((item) => item.name === 'Primary')
    assert.strictEqual(primary?.kind, 'Role')
    assert.strictEqual(primary?.signature.text, 'pub role Primary')
    assert.strictEqual(primary?.documentation?.markdown, 'Primary dependency position.')
    const recover = module.items.find((item) => item.name === 'recover')
    assert.strictEqual(recover?.children.at(0)?.documentation?.markdown, 'The failure to inspect.')
    const problem = module.items.find((item) => item.name === 'Problem')
    assert.deepStrictEqual(
      problem?.children.map((item) => item.name),
      ['code'],
    )
    const state = module.items.find((item) => item.name === 'State')
    assert.strictEqual(state?.kind, 'Enum')
    assert.strictEqual(state?.documentation?.markdown, 'One recovery state.')
    assert.strictEqual(state?.children.at(0)?.name, 'Ready')
    assert.strictEqual(state?.children.at(0)?.documentation?.markdown, 'The operation can start.')
    const outcome = module.items.find((item) => item.name === 'Outcome')
    assert.strictEqual(outcome?.kind, 'Union')
    assert.strictEqual(outcome?.signature.text, 'pub union Outcome<T>')
    const variants = outcome?.children.filter((item) => item.kind === 'UnionVariant')
    assert.deepEqual(
      variants?.map((item) => [item.kind, item.name, item.children.length]),
      [
        ['UnionVariant', 'Success', 1],
        ['UnionVariant', 'Empty', 0],
      ],
    )
    assert.strictEqual(variants?.at(0)?.documentation?.markdown, 'A successful payload.')
    assert.strictEqual(variants?.at(0)?.children.at(0)?.name, 'value')
    const outcomeLink = outcome?.documentation?.blocks
      .flatMap((block) => (block._tag === 'Paragraph' ? block.children : []))
      .find((inline) => inline._tag === 'SymbolLink')
    assert.strictEqual(outcomeLink?._tag, 'SymbolLink')
    if (outcomeLink?._tag === 'SymbolLink') {
      assert.strictEqual(outcomeLink.target?.kind, 'UnionVariant')
      assert.strictEqual(outcomeLink.target?.id, 'project/main::Outcome::variant:0')
    }

    const privateProject = Project.make(snapshot, { includePrivate: true })
    assert.isTrue(privateProject.modules[0]?.items.some((item) => item.name === 'helper'))
    assert.strictEqual(
      privateProject.modules[0]?.items.find((item) => item.name === 'Copy for Hidden')?.visibility,
      'Private',
    )
    assert.isTrue(
      privateProject.modules[0]?.items
        .find((item) => item.name === 'Problem')
        ?.children.some((item) => item.name === 'privateCode'),
    )

    const json = Json.encode(publicProject)
    assert.strictEqual(json, Json.encode(publicProject))
    assert.match(json, /"schema": "silk-documentation"/)
    assert.isTrue(json.endsWith('\n'))
  }),
)

it.effect('builds one documentation model from a shared multi-root analysis', () =>
  Effect.gen(function* () {
    const roots = [
      SourceFile.make(
        'app/A',
        encode(`import shared.Core

/// Public A.
pub fn a() -> i32 { return Core.answer() }

/// Private A helper.
fn helper() -> i32 { return 0 }
`),
      ),
      SourceFile.make(
        'app/B',
        encode(`import shared.Core

/// Public B.
pub fn b() -> i32 { return Core.answer() }
`),
      ),
    ]
    const analysis = yield* ProjectAnalysis.make(roots.map((source) => source.id)).pipe(
      Effect.provide(
        SourceResolver.overlay(roots).pipe(
          Layer.provideMerge(
            SourceResolver.memory(
              new Map([
                [
                  'shared/Core',
                  encode(`/// Shared answer.
pub fn answer() -> i32 { return 42 }
`),
                ],
              ]),
            ),
          ),
        ),
      ),
    )

    const publicProject = Project.fromProjectAnalysis(analysis)
    assert.deepStrictEqual(
      publicProject.modules.map((module) => module.name),
      ['app/A', 'app/B', 'shared/Core'],
    )
    assert.strictEqual(new Set(publicProject.modules.map((module) => module.name)).size, 3)
    assert.isFalse(
      publicProject.modules
        .find((module) => module.name === 'app/A')
        ?.items.some((item) => item.name === 'helper') ?? true,
    )

    const privateProject = Project.fromProjectAnalysis(analysis, { includePrivate: true })
    assert.isTrue(
      privateProject.modules
        .find((module) => module.name === 'app/A')
        ?.items.some((item) => item.name === 'helper') ?? false,
    )
    const closure = ProjectAnalysis.phases(analysis).find((phase) => phase.phase === 'closure')
    assert.strictEqual(closure?.inputs, 2)
    assert.strictEqual(closure?.outputs, 3)
    assert.strictEqual(closure?.diagnostics, 0)
  }),
)

// A two-module slice of the real standard library owns the emitter-to-renderer JSON boundary on
// real documentation. `documentation:examples` (`silk doctest --stdlib`) documents and decodes the
// whole shipped manifest; Site.test.ts covers writer details on a synthetic document.
it.effect('renders encoded standard-library documentation through the JSON boundary', () =>
  Effect.gen(function* () {
    const analysis = yield* ProjectAnalysis.make(['silk/base64', 'silk/option'], {
      configuration: { profile: { target: 'wasm32-unknown-unknown' } },
    }).pipe(Effect.provide(SourceResolver.empty))
    const documentation = Project.fromProjectAnalysis(analysis, { includePrivate: true })
    const modules = documentation.modules.map((module) => module.name)
    const parsed = Json.decodeSync(Json.encode(documentation))
    const examples = Example.collect(parsed)
    assert.isAbove(examples.length, 0)
    assert.deepStrictEqual(examples, Example.collect(documentation))
    const decoded = Model.decode(parsed)
    assert.strictEqual(decoded._tag, 'Decoded')
    if (decoded._tag !== 'Decoded') return
    assert.deepStrictEqual(
      decoded.documentation.modules.map((module) => module.name),
      modules,
    )
    const site = Site.render(decoded.documentation, { title: 'Silk standard library' })
    const pages = site.files.filter((file) => file.path.endsWith('.html'))
    assert.lengthOf(pages, modules.length + 1)
    const index = pages.find((file) => file.path === 'index.html')
    assert.isDefined(index)
    for (const module of modules) assert.include(index.contents, module)
    const option = pages.find((file) => file.path === 'silk-option.html')
    assert.isDefined(option)
    assert.include(option.contents, 'unwrapOr')
  }),
)
