import * as Layer from 'effect/Layer'
import { assert, it } from '@effect/vitest'
import * as Analysis from '@silklang/compiler/Analysis'
import * as ProjectAnalysis from '@silklang/compiler/ProjectAnalysis'
import * as SourceFile from '@silklang/compiler/SourceFile'
import * as SourceResolver from '@silklang/compiler/SourceResolver'
import * as Arr from 'effect/Array'
import * as Effect from 'effect/Effect'
import * as Project from '../src/Project.js'
import * as Reference from '../src/Reference.js'

const encoder = new TextEncoder()

it.effect(
  'separates incompatible selected documentation while sharing identical profile pages',
  () =>
    Effect.gen(function* () {
      const roots: Arr.NonEmptyReadonlyArray<SourceFile.SourceFile> = [
        SourceFile.make(
          'platform',
          encoder.encode(`
static if Intrinsic.targetOperatingSystem() == "darwin" {
  /// The Darwin declaration.
  pub fn nativeOnly() -> i32 { return 1 }
} else {
  /// The other declaration.
  pub fn otherOnly() -> i32 { return 2 }
}`),
        ),
        SourceFile.make(
          'facade',
          encoder.encode(`
static if Intrinsic.targetOperatingSystem() == "darwin" {
  pub import platform { nativeOnly as selected }
} else {
  pub import platform { otherOnly as selected }
}`),
        ),
      ]
      const projects = []
      for (const target of [
        'aarch64-apple-darwin',
        'x86_64-unknown-linux-gnu',
        'wasm32-unknown-unknown',
      ]) {
        const analysis = yield* ProjectAnalysis.make(
          Arr.map(roots, (source) => source.id),
          {
            configuration: { profile: { target, artifact: 'object', entry: { kind: 'none' } } },
          },
        ).pipe(
          Effect.provide(
            SourceResolver.overlay(roots).pipe(Layer.provideMerge(SourceResolver.empty)),
          ),
        )
        const project = Project.fromProjectAnalysis(analysis)
        const alias = project.modules.find((module) => module.name === 'facade')?.items[0]
        assert.strictEqual(alias?.name, 'selected')
        assert.strictEqual(
          alias?.signature.text,
          `pub import platform { ${target === 'aarch64-apple-darwin' ? 'nativeOnly' : 'otherOnly'} as selected }`,
        )
        projects.push({ name: target, project })
      }
      const result = Reference.makeProfiles(
        [{ module: 'platform', namespace: 'Platform' }],
        projects,
      )
      assert.strictEqual(result._tag, 'Success')
      if (result._tag !== 'Success') return
      assert.lengthOf(result.reference.files, 3)
      const native =
        result.reference.files.find((file) => file.path === 'platform.md')?.contents ?? ''
      const other =
        result.reference.files.find((file) => file.path === 'platform.profile-2.md')?.contents ?? ''
      assert.include(native, 'nativeOnly')
      assert.notInclude(native, 'otherOnly')
      assert.include(other, 'otherOnly')
      assert.notInclude(other, 'nativeOnly')
      assert.include(other, 'x86_64-unknown-linux-gnu')
      assert.include(other, 'wasm32-unknown-unknown')
      assert.deepEqual(
        Reference.makeProfiles([{ module: 'platform', namespace: 'Platform' }], projects),
        result,
      )
    }),
)

const source = `//! Coordinates recoverable work.
//!
//! # Details
//! - Operations preserve source order.
//! - See [\`Recovery\`] for the provider contract.

/// Recovers one numeric problem.
///
/// # Details
/// The provider receives the caller's value unchanged.
pub service Recovery {
  /// Recovers one problem code.
  effect fn recover(
    /// The problem code interpreted by the selected provider.
    problem: i32,
    fallback: i32,
  ) -> i32 ? &mut Recovery
}

/// A recovery provider used by examples.
pub struct Provider {}

effect fn recoverWithProvider(self: &mut Provider, problem: i32, fallback: i32) -> i32 {
  return problem
}

/// Selects Provider as a Recovery implementation.
impl Recovery for Provider {
  /// Routes Recovery.recover to Provider's implementation.
  recover: Provider.recoverWithProvider
}

/// Returns a value without changing it.
///
/// # Examples
/// ## Preserve an integer
/// \`\`\`silk
/// pub fn main() -> i32 { return 1 }
/// \`\`\`
/// ## Preserve another integer
/// \`\`\`silk
/// pub fn main() -> i32 { return 2 }
/// \`\`\`
///
/// # See also
/// - [\`Recovery\`] can interpret a value.
/// - [\`Missing\`] remains readable when unresolved.
pub fn identity<
  /// The owned value type preserved by the function.
  T,
>(
  /// The owned value returned to the caller.
  value: T,
) -> T { return move value }

struct HiddenNode {}
impl Copy for HiddenNode {}
pub struct Container<T> { value: T }
impl Copy for Container<HiddenNode> {}
interface HiddenContract {}
impl HiddenContract for Provider {}

/// Private implementation helper.
fn helper() -> i32 { return 0 }

/// Computes an absolute value through libc.
pub unsafe extern "C" fn cAbs(value: i32) -> i32 as "abs"

/// Doubles a value for C callers.
pub export "C" fn double(value: i32) -> i32 as "silk_test_double_v1" { return value * 2 }

/// Fills a raw buffer and returns a read-only view of it.
pub fn fill(buffer: *mut u8, length: usize) -> *const u8 { return buffer }
`

const rendered = Effect.fnUntraced(function* () {
  const snapshot = yield* Analysis.ofSource('test/reference', encoder.encode(source))
  const project = Project.make(snapshot)
  return Reference.make([{ module: 'test/reference', namespace: 'Recovery' }], project)
})

it.effect('renders the complete public hierarchy in source order with accurate counts', () =>
  Effect.gen(function* () {
    const result = yield* rendered()
    assert.strictEqual(result._tag, 'Success')
    if (result._tag !== 'Success') return
    const index = result.reference.files.find((file) => file.path === 'index.md')?.contents
    assert.isDefined(index)
    assert.include(index, '[Language reference](../../reference/)')
    const page = result.reference.files.find((file) => file.path === 'reference.md')?.contents
    assert.isDefined(page)
    assert.include(page, 'Import as `Recovery` with `import test.reference { Recovery }`.')
    assert.include(page, 'Public declarations: 7.')
    assert.include(page, '## `cAbs`')
    assert.include(page, 'pub unsafe extern "C" fn cAbs(value: i32) -> i32 as "abs"')
    assert.include(page, '## `double`')
    assert.include(page, 'pub export "C" fn double(value: i32) -> i32 as "silk_test_double_v1"')
    assert.include(page, '## `fill`')
    assert.include(page, 'pub fn fill(buffer: *mut u8, length: usize) -> *const u8')
    assert.include(page, 'Computes an absolute value through libc.')
    assert.include(page, '### Operation `recover`')
    assert.include(page, '#### Parameter `problem`')
    assert.notInclude(page, 'Parameter `fallback`')
    assert.include(page, '### Type parameter `T`')
    assert.include(page, '### Parameter `value`')
    assert.include(page, '## Implementation `Recovery for Provider`')
    assert.notInclude(page, 'helper')
    assert.include(page, '## `Container`')
    assert.notInclude(page, 'HiddenNode')
    assert.notInclude(page, 'HiddenContract')
    assert.isBelow(page.indexOf('`Recovery`'), page.indexOf('`Provider`'))
    assert.isBelow(page.indexOf('`Provider`'), page.indexOf('Implementation'))
    assert.isBelow(page.indexOf('Implementation'), page.indexOf('`identity`'))
  }),
)

it.effect('distinguishes primitive, public declaration, and module alias imports', () =>
  Effect.gen(function* () {
    const snapshot = yield* Analysis.ofSource('test/reference', encoder.encode(source))
    const project = Project.make(snapshot)
    for (const { namespace, statement } of [
      { namespace: 'i32', statement: 'import test.reference' },
      { namespace: 'Recovery', statement: 'import test.reference { Recovery }' },
      { namespace: 'Client', statement: 'import test.reference as Client' },
      { namespace: 'HiddenNode', statement: 'import test.reference as HiddenNode' },
    ]) {
      const result = Reference.make([{ module: 'test/reference', namespace }], project)
      assert.strictEqual(result._tag, 'Success')
      if (result._tag !== 'Success') return
      const page = result.reference.files.find((file) => file.path === 'reference.md')?.contents
      assert.isDefined(page)
      assert.include(page, `Import as \`${namespace}\` with \`${statement}\`.`)
    }
  }),
)

it.effect('rebases headings, preserves lists and titled fences, and renders semantic links', () =>
  Effect.gen(function* () {
    const result = yield* rendered()
    assert.strictEqual(result._tag, 'Success')
    if (result._tag !== 'Success') return
    const page = result.reference.files.find((file) => file.path === 'reference.md')?.contents
    assert.isDefined(page)
    assert.include(page, '## Details\n\n- Operations preserve source order.')
    assert.include(page, '### Details\n\nThe provider receives')
    assert.include(page, '### Examples')
    assert.include(page, '#### Preserve an integer')
    assert.include(page, '#### Preserve another integer')
    assert.include(page, 'pub fn main() -> i32 { return 1 }')
    assert.include(page, 'pub fn main() -> i32 { return 2 }')
    assert.include(
      page,
      `[\`Recovery\`](#${Reference.declarationAnchor('test/reference::Recovery')})`,
    )
    assert.include(page, '`Missing` remains readable')
  }),
)

it.effect('produces byte-identical files for repeated input', () =>
  Effect.gen(function* () {
    const first = yield* rendered()
    const second = yield* rendered()
    assert.deepStrictEqual(first, second)
  }),
)

it.effect('groups inherent members under their owner and resolves member links', () =>
  Effect.gen(function* () {
    const snapshot = yield* Analysis.ofSource(
      'test/option',
      encoder.encode(`//! Optional values; see [\`map\`] and [\`none\`].

/// An optional value.
pub union Option<T> { None, Some { pub value: T } }

impl<T> Option<T> {
  /// Transform.
  pub fn map<U>(self: Self, transform: once fn(T) -> U) -> Option<U> {
    return match move self {
      Option<T>.Some { value } => Option<U>.Some { value: transform(move value) }
      Option<T>.None => Option<U>.None
    }
  }
  /// Nothing.
  pub fn none() -> Self { return Option<T>.None }
  fn hidden() -> i32 { return 0 }
}
`),
    )
    const project = Project.make(snapshot)
    const module = project.modules.at(0)
    assert.deepStrictEqual(
      module?.items.map((item) => item.name),
      ['Option'],
    )
    const option = module?.items.at(0)
    assert.deepStrictEqual(
      option?.children
        .filter((item) => item.kind === 'Method' || item.kind === 'AssociatedFunction')
        .map((item) => [item.kind, item.name, item.documentation?.markdown]),
      [
        ['Method', 'Option.map', 'Transform.'],
        ['AssociatedFunction', 'Option.none', 'Nothing.'],
      ],
    )
    const links = module?.documentation?.blocks
      .flatMap((block) => (block._tag === 'Paragraph' ? block.children : []))
      .flatMap((inline) => (inline._tag === 'SymbolLink' ? [inline.target?.id] : []))
    assert.deepStrictEqual(links, ['test/option::Option.map', 'test/option::Option.none'])

    const result = Reference.make([{ module: 'test/option', namespace: 'Option' }], project)
    assert.strictEqual(result._tag, 'Success')
    if (result._tag !== 'Success') return
    const page = result.reference.files.find((file) => file.path === 'option.md')?.contents
    assert.isDefined(page)
    assert.include(page, 'Public declarations: 1.')
    assert.include(page, '### Method `Option.map`')
    assert.include(page, '### Associated function `Option.none`')
    assert.notInclude(page, 'hidden')
    assert.include(page, `[\`map\`](#${Reference.declarationAnchor('test/option::Option.map')})`)
    assert.isBelow(page.indexOf('## `Option`'), page.indexOf('### Method `Option.map`'))
  }),
)

const item = (id: string, start: number): Project.Item =>
  Object.freeze({
    id,
    kind: 'Struct',
    name: id,
    visibility: 'Public',
    signature: Object.freeze({ text: `pub struct ${id}` }),
    source: Object.freeze({ sourceId: 'collision', start, end: start + 1 }),
    children: Object.freeze([]),
  })

it('rejects deterministic module-path and declaration-anchor collisions', () => {
  const project: Project.Project = Object.freeze({
    schema: 'silk-documentation',
    experimental: true,
    modules: Object.freeze([
      Object.freeze({
        name: 'test/a_b',
        sourceId: 'test/a_b',
        items: Object.freeze([item('test/a_b::duplicate', 1), item('test/a_b::duplicate', 2)]),
      }),
      Object.freeze({ name: 'test/a-b', sourceId: 'test/a-b', items: Object.freeze([]) }),
    ]),
  })
  const result = Reference.make(
    [
      { module: 'test/a_b', namespace: 'First' },
      { module: 'test/a-b', namespace: 'Second' },
    ],
    project,
  )
  assert.strictEqual(result._tag, 'Failure')
  if (result._tag !== 'Failure') return
  assert.isTrue(
    result.errors.some((error) => error._tag === 'Collision' && error.kind === 'ModulePath'),
  )
  assert.isTrue(
    result.errors.some((error) => error._tag === 'Collision' && error.kind === 'DeclarationAnchor'),
  )
})

it.effect('omits API examples from a module whose entire surface is inactive', () =>
  Effect.gen(function* () {
    const analysis = yield* ProjectAnalysis.make(['empty/platform'], {
      configuration: {
        profile: {
          target: 'wasm32-unknown-unknown',
          artifact: 'object',
          entry: { kind: 'none' },
        },
      },
    }).pipe(
      Effect.provide(
        SourceResolver.overlay([
          SourceFile.make(
            'empty/platform',
            encoder.encode(`//! Native API example.
//! \`\`\`silk
//! import empty.platform { nativeOnly }
//! pub fn main() -> i32 { return nativeOnly() }
//! \`\`\`
static if Intrinsic.targetOperatingSystem() == "darwin" {
  pub fn nativeOnly() -> i32 { return 1 }
}`),
          ),
        ]).pipe(Layer.provideMerge(SourceResolver.empty)),
      ),
    )
    const module = Project.fromProjectAnalysis(analysis).modules.find(
      (module) => module.name === 'empty/platform',
    )
    assert.deepEqual(module?.items, [])
    assert.isUndefined(module?.documentation)
  }),
)
