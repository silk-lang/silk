import type * as ModuleClosure from '@silklang/compiler/ModuleClosure'
import { assert, it } from '@effect/vitest'
import * as Analysis from '@silklang/compiler/Analysis'
import * as Lexer from '@silklang/compiler/Lexer'
import * as ModuleSummary from '@silklang/compiler/ModuleSummary'
import * as Parser from '@silklang/compiler/Parser'
import * as ProjectAnalysis from '@silklang/compiler/ProjectAnalysis'
import * as SourceFile from '@silklang/compiler/SourceFile'
import * as SourceOrigin from '@silklang/compiler/SourceOrigin'
import * as SourceResolver from '@silklang/compiler/SourceResolver'
import * as Stdlib from '@silklang/compiler/Stdlib'
import * as WorkspaceInventory from '@silklang/compiler/WorkspaceInventory'
import * as Arr from 'effect/Array'
import * as Effect from 'effect/Effect'
import * as Inspectable from 'effect/Inspectable'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import { CompletionItemKind, DiagnosticSeverity, SymbolKind } from 'vscode-languageserver-types'
import * as Document from '../src/Document.js'
import * as EmbeddedFormatting from './fixtures/embeddedFormatting.js'

const encoder = new TextEncoder()

const open = (
  text: string,
  target?: string,
): Effect.Effect<
  {
    readonly document: Document.Document
    readonly snapshot: Analysis.FrontendSnapshot
  },
  ModuleClosure.ModuleClosureError
> =>
  Effect.gen(function* () {
    const bytes = encoder.encode(text)
    const snapshot = yield* Analysis.ofSource('main', bytes, target)
    const document = Document.make({
      uri: 'file:///project/main.silk',
      version: 1,
      workspace: 'project:/project/silk.toml',
      module: 'main',
      sourceRoot: '/project',
      bytes,
    })
    return { document, snapshot }
  })

const positionAt = (source: string, offset: number) => {
  const before = source.slice(0, offset)
  const lineStart = before.lastIndexOf('\n') + 1
  return { line: before.split('\n').length - 1, character: offset - lineStart }
}

const positionOf = (source: string, spelling: string, occurrence = 0) => {
  let offset = -1
  for (let index = 0; index <= occurrence; index += 1) offset = source.indexOf(spelling, offset + 1)
  return positionAt(source, offset)
}

it.effect('publishes compiler errors as protocol diagnostics', () =>
  Effect.gen(function* () {
    const source = 'pub fn main() -> i32 { return missing() }'
    const { document, snapshot } = yield* open(source)
    const diagnostics = Document.diagnostics(document, snapshot, () => undefined)
    assert.strictEqual(diagnostics.length, 1)
    const diagnostic = diagnostics[0]
    assert.strictEqual(diagnostic?.code, 'SEM0004')
    assert.strictEqual(diagnostic?.source, 'silk')
    assert.strictEqual(diagnostic?.range.start.line, 0)
    assert.strictEqual(diagnostic?.range.start.character, source.indexOf('missing'))
  }),
)

it.effect('reports a final expression separately from its missing terminal return', () =>
  Effect.gen(function* () {
    const source = 'pub fn foo() -> i32 {\n          a\n}'
    const { document, snapshot } = yield* open(source)

    assert.deepEqual(
      Document.diagnostics(document, snapshot, () => undefined).map(({ code, message, range }) => ({
        code,
        message,
        range,
      })),
      [
        {
          code: 'SEM0006',
          message: 'Unknown value a',
          range: {
            start: { line: 1, character: 10 },
            end: { line: 1, character: 11 },
          },
        },
        {
          code: 'SEM0130',
          message: 'A reachable path must return i32',
          range: {
            start: { line: 2, character: 0 },
            end: { line: 2, character: 1 },
          },
        },
      ],
    )
  }),
)

it.effect('reports no diagnostics for a valid program', () =>
  Effect.gen(function* () {
    const { document, snapshot } = yield* open('pub fn main() -> i32 { return 42 }')
    assert.deepEqual(
      Document.diagnostics(document, snapshot, () => undefined),
      [],
    )
  }),
)

it.effect('hovers the type of the smallest enclosing expression', () =>
  Effect.gen(function* () {
    const source = 'pub fn main() -> i32 { return 42 }'
    const { document, snapshot } = yield* open(source)
    const hover = Document.hover(document, snapshot, {
      line: 0,
      character: source.indexOf('42'),
    })
    assert.isDefined(hover)
    assert.deepEqual(hover?.contents, { kind: 'markdown', value: '```silk\ni32\n```' })
  }),
)

it.effect('hovers a type alias use with its erased target', () =>
  Effect.gen(function* () {
    const source = `pub struct Circle {}
pub struct Square {}
pub type Shape = Circle | Square
pub fn pick(shape: Shape) -> i32 { return 0 }`
    const { document, snapshot } = yield* open(source)
    const hover = Document.hover(document, snapshot, positionOf(source, 'Shape) -> i32'))
    assert.isDefined(hover)
    const contents = hover?.contents
    const entries = Array.isArray(contents) ? contents : [contents]
    const text = entries
      .map((entry) => (typeof entry === 'string' ? entry : (entry?.value ?? '')))
      .join('\n')
    assert.include(text, 'Circle')
    assert.include(text, 'Square')
  }),
)

it.effect('hovers the exact default float width', () =>
  Effect.gen(function* () {
    const source = 'fn value() -> f64 { return 1.25e2 }'
    const { document, snapshot } = yield* open(source)
    const hover = Document.hover(document, snapshot, positionOf(source, '1.25e2'))
    assert.deepEqual(hover?.contents, { kind: 'markdown', value: '```silk\nf64\n```' })
  }),
)

it.effect('hovers nothing outside typed expressions', () =>
  Effect.gen(function* () {
    const { document, snapshot } = yield* open('pub fn main() -> i32 { return 42 }')
    assert.isUndefined(Document.hover(document, snapshot, { line: 0, character: 0 }))
  }),
)

it.effect('maps hover and definition positions after non-ASCII recovery bytes', () =>
  Effect.gen(function* () {
    const source = `🙂 pub fn main() -> i32 { return 42 }`
    const { document, snapshot } = yield* open(source)
    const position = positionOf(source, 'main')
    const hover = Document.hover(document, snapshot, position)
    const definition = Document.definition(document, snapshot, position, () => undefined)
    assert.include(
      typeof hover?.contents === 'object' && 'value' in hover.contents ? hover.contents.value : '',
      'fn main()',
    )
    assert.deepEqual(definition?.targetSelectionRange.start, position)
  }),
)

it.effect('distinguishes a binding and a source-owned standard-library namespace', () =>
  Effect.gen(function* () {
    const source = `import silk.allocator { Allocator, SystemAllocator }
pub fn main() -> i32 {
  let mut allocator = Allocator.systemAllocatorProvider()
  return 0
}`
    const { document, snapshot } = yield* open(source)
    const hoverText = (spelling: string, occurrence = 0) => {
      const hover = Document.hover(document, snapshot, positionOf(source, spelling, occurrence))
      return typeof hover?.contents === 'object' && 'value' in hover.contents
        ? hover.contents.value
        : undefined
    }
    assert.strictEqual(
      hoverText('allocator', 1),
      '```silk\nlet mut allocator: SystemAllocator\n```\n\n**Implements**\n\n- `Allocator`',
      Inspectable.toStringUnknown(Analysis.diagnostics(snapshot)),
    )
    assert.include(hoverText('Allocator', 2) ?? '', 'pub service Allocator')
    assert.strictEqual(
      hoverText('systemAllocatorProvider'),
      '```silk\npub fn systemAllocatorProvider() -> SystemAllocator\n```\n\nCreates a process-backed allocator provider without allocating storage.\n\n**Implements**\n\n- `Allocator`',
    )
  }),
)

it.effect('uses one source-like effect function hover at declarations and references', () =>
  Effect.gen(function* () {
    const source = `effect fn recover(error: OutOfMemoryError) -> i32 { return 0 }
pub fn main() -> i32 {
  return run Effect.catchAll(store(), recover)
}`
    const { document, snapshot } = yield* open(source)
    const declaration = Document.hover(document, snapshot, positionOf(source, 'recover', 0))
    const reference = Document.hover(document, snapshot, positionOf(source, 'recover', 1))
    assert.deepEqual(declaration?.contents, {
      kind: 'markdown',
      value: "```silk\neffect<'static> fn recover(error: OutOfMemoryError) -> i32\n```",
    })
    assert.deepEqual(reference?.contents, declaration?.contents)
  }),
)

it.effect('preserves unsafe callable contracts in hover, signatures, and completion', () =>
  Effect.gen(function* () {
    const source = `pub unsafe effect fn read(value: i32) -> i32 { return value }
pub effect fn main() -> i32 {
  return run unsafe read(1)
}`
    const { document, snapshot } = yield* open(source)
    const declaration = Document.hover(document, snapshot, positionOf(source, 'read', 0))
    const reference = Document.hover(document, snapshot, positionOf(source, 'read', 1))
    assert.deepEqual(declaration?.contents, {
      kind: 'markdown',
      value: "```silk\npub unsafe effect<'static> fn read(value: i32) -> i32\n```",
    })
    assert.deepEqual(reference?.contents, declaration?.contents)

    const signature = Document.signatureHelp(
      document,
      snapshot,
      positionAt(source, source.indexOf('read(1)') + 'read('.length),
    )
    assert.strictEqual(
      signature?.signatures[0]?.label,
      "pub unsafe effect<'static> fn read(value: i32) -> i32",
    )

    const completion = yield* Document.completion(
      document,
      snapshot,
      positionAt(source, source.indexOf('read(1)') + 2),
    )
    assert.include(
      completion.items.find((item) => item.label === 'read')?.detail ?? '',
      "unsafe effect<'static> fn read",
    )
  }),
)

it.effect('hovers and hints raw pointer types with their mutability', () =>
  Effect.gen(function* () {
    const source = `fn fill(buffer: *mut u8, length: usize) -> *const u8 { return buffer }
fn use(buffer: *mut u8) -> *const u8 {
  let p = fill(buffer, 1)
  return p
}`
    const { document, snapshot } = yield* open(source)
    const declaration = Document.hover(document, snapshot, positionOf(source, 'fill', 0))
    const reference = Document.hover(document, snapshot, positionOf(source, 'fill', 1))
    assert.deepEqual(declaration?.contents, {
      kind: 'markdown',
      value: '```silk\nfn fill(buffer: *mut u8, length: usize) -> *const u8\n```',
    })
    assert.deepEqual(reference?.contents, declaration?.contents)
    const buffer = Document.hover(document, snapshot, positionOf(source, 'buffer', 1))
    assert.deepEqual(buffer?.contents, { kind: 'markdown', value: '```silk\nbuffer: *mut u8\n```' })
    assert.deepEqual(
      Document.inlayHints(document, snapshot, {
        start: { line: 2, character: 0 },
        end: { line: 2, character: 30 },
      }),
      [
        {
          position: { line: 2, character: 7 },
          label: ': *const u8',
          kind: 1,
          paddingLeft: false,
          paddingRight: false,
        },
      ],
    )
  }),
)

it.effect('hovers a foreign function with its unsafe signature and native symbol', () =>
  Effect.gen(function* () {
    const source = `pub unsafe extern "C" fn cAbs(value: i32) -> i32 as "abs"
pub fn main() -> i32 { return unsafe cAbs(-1) }`
    const { document, snapshot } = yield* open(source)
    const declaration = Document.hover(document, snapshot, positionOf(source, 'cAbs', 0))
    const reference = Document.hover(document, snapshot, positionOf(source, 'cAbs', 1))
    assert.deepEqual(declaration?.contents, {
      kind: 'markdown',
      value: '```silk\npub unsafe extern "C" fn cAbs(value: i32) -> i32 as "abs"\n```',
    })
    assert.deepEqual(reference?.contents, declaration?.contents)
  }),
)

it.effect('hovers an exported function with its export marker and native symbol', () =>
  Effect.gen(function* () {
    const source = `pub export "C" fn double(value: i32) -> i32 as "silk_test_double_v1" { return value * 2 }
pub fn main() -> i32 { return double(2) }`
    const { document, snapshot } = yield* open(source)
    const declaration = Document.hover(document, snapshot, positionOf(source, 'double', 0))
    // Occurrence 1 is inside the `"silk_test_double_v1"` literal; the call is occurrence 2.
    const reference = Document.hover(document, snapshot, positionOf(source, 'double', 2))
    assert.deepEqual(declaration?.contents, {
      kind: 'markdown',
      value: '```silk\npub export "C" fn double(value: i32) -> i32 as "silk_test_double_v1"\n```',
    })
    assert.deepEqual(reference?.contents, declaration?.contents)
  }),
)

it.effect('appends full declaration documentation to definition and reference hovers', () =>
  Effect.gen(function* () {
    const source = `/// Recovers a problem.
///
/// # Examples
/// \`\`\`silk
/// recover(problem)
/// \`\`\`
effect fn recover(problem: Problem) -> i32 { return problem.code }
pub fn main() -> i32 { return recover(Problem { code: 1 }) }
pub struct Problem { pub code: i32 }
`
    const { document, snapshot } = yield* open(source)
    const definition = Document.hover(document, snapshot, positionOf(source, 'recover', 1))
    const reference = Document.hover(document, snapshot, positionOf(source, 'recover', 2))
    const expected = `\`\`\`silk
effect<'static> fn recover(problem: Problem) -> i32
\`\`\`

Recovers a problem.

***
Examples
***

\`\`\`silk
recover(problem)
\`\`\``
    assert.deepEqual(definition?.contents, { kind: 'markdown', value: expected })
    assert.deepEqual(reference?.contents, definition?.contents)
  }),
)

it.effect('distinguishes Effect, catch, and a nominal type argument', () =>
  Effect.gen(function* () {
    const source = `import silk.effect { Effect }
struct Problem {}
effect fn recover(error: Problem) -> i32 { return 0 }
pub fn main() -> i32 {
  let recipe = relay(0)
    |> Effect.catchAll(recover)
  return run recipe
}`
    const { document, snapshot } = yield* open(source)
    const text = (spelling: string, occurrence = 0) => {
      const hover = Document.hover(document, snapshot, positionOf(source, spelling, occurrence))
      return typeof hover?.contents === 'object' && 'value' in hover.contents
        ? hover.contents.value
        : undefined
    }
    // The imported owner hovers as the struct that declares the combinators, doc and all.
    const owner = text('Effect') ?? ''
    assert.strictEqual(
      owner.slice(0, owner.indexOf('\n\n***')),
      '```silk\npub struct Effect\n```\n\nThe owner of the Effect combinators.',
    )
    assert.include(text('catch') ?? '', "pub effect<'env> fn catch")
    assert.strictEqual(text('Problem', 1), '```silk\nstruct Problem\n```')
  }),
)

it.effect('returns inferred local type inlay hints in the requested range', () =>
  Effect.gen(function* () {
    const source = `import silk.allocator { Allocator, SystemAllocator }
pub fn main() -> i32 {
  let mut allocator = Allocator.systemAllocatorProvider()
  return 0
}`
    const { document, snapshot } = yield* open(source)
    assert.deepEqual(
      Document.inlayHints(document, snapshot, {
        start: { line: 0, character: 0 },
        end: { line: 3, character: 1 },
      }),
      [
        {
          position: { line: 2, character: 19 },
          label: ': SystemAllocator',
          kind: 1,
          paddingLeft: false,
          paddingRight: false,
        },
      ],
    )
  }),
)

it.effect('renders proved hover contracts and inferred provider selectors', () =>
  Effect.gen(function* () {
    const source = `import silk.os_writer { StdoutWriter }
import silk.writer { Writer, WriterError }
import silk.effect { Effect }

pub effect fn main() -> () ! WriterError {
  let mut streams = StdoutWriter.make()
  // π🙂 keeps the selector position on UTF-16 coordinates
  return run Writer.writeAll(b"Hello\\n")
    |> Effect.provideMut(&mut streams)
}`
    const { document, snapshot } = yield* open(source, 'x86_64-unknown-linux-gnu')
    const hover = Document.hover(document, snapshot, positionOf(source, 'streams', 1))
    assert.deepEqual(hover?.contents, {
      kind: 'markdown',
      value: '```silk\nlet mut streams: StdoutWriter\n```\n\n**Implements**\n\n- `Writer`',
    })

    const selectorOffset = source.indexOf('provideMut(') + 'provideMut'.length
    const bindingEnd = source.indexOf('let mut streams') + 'let mut streams'.length
    assert.deepEqual(
      Document.inlayHints(document, snapshot, {
        start: { line: 0, character: 0 },
        end: positionAt(source, source.length),
      }),
      [
        {
          position: positionAt(source, bindingEnd),
          label: ': StdoutWriter',
          kind: 1,
          paddingLeft: false,
          paddingRight: false,
        },
        {
          position: positionAt(source, selectorOffset),
          label: '<Writer>',
          kind: 1,
          paddingLeft: false,
          paddingRight: false,
        },
      ],
    )
    assert.deepEqual(
      Document.inlayHints(document, snapshot, {
        start: { line: 0, character: 0 },
        end: positionAt(source, selectorOffset),
      }).map((hint) => hint.label),
      [': StdoutWriter'],
    )
    const selectorRange = {
      start: positionAt(source, selectorOffset),
      end: positionAt(source, selectorOffset + 1),
    }
    const clipped = Document.inlayHints(document, snapshot, selectorRange)
    assert.deepEqual(Document.inlayHints(document, snapshot, selectorRange), clipped)
    assert.deepEqual(
      clipped.map((hint) => hint.label),
      ['<Writer>'],
    )
  }),
)

it.effect('preserves hover Markdown across contract subjects and recovered source', () =>
  Effect.gen(function* () {
    const source = `service Beta {}
service Alpha {}
struct Provider {}
struct Plain {}
impl Beta for Provider {}
impl Alpha for Provider {}

/// Constructs a provider.
fn make() -> Provider { return Provider {} }

pub fn main() -> i32 {
  let provider = make()
  let plain = Plain {}
  return 0
}

pub fn broken() -> i32 { return missing() }`
    const { document, snapshot } = yield* open(source)
    assert.isAbove(Document.diagnostics(document, snapshot, () => undefined).length, 0)
    const markdownAt = (spelling: string, occurrence = 0) => {
      const contents = Document.hover(
        document,
        snapshot,
        positionOf(source, spelling, occurrence),
      )?.contents
      return typeof contents === 'object' && 'value' in contents ? contents.value : undefined
    }
    const implementations = '**Implements**\n\n- `Alpha`\n- `Beta`'

    assert.strictEqual(
      markdownAt('Provider'),
      `\`\`\`silk\nstruct Provider\n\`\`\`\n\n${implementations}`,
    )
    assert.strictEqual(
      markdownAt('Provider', 3),
      `\`\`\`silk\nstruct Provider\n\`\`\`\n\n${implementations}`,
    )
    assert.strictEqual(
      markdownAt('make'),
      `\`\`\`silk\nfn make() -> Provider\n\`\`\`\n\nConstructs a provider.\n\n${implementations}`,
    )
    assert.strictEqual(
      markdownAt('make', 1),
      `\`\`\`silk\nfn make() -> Provider\n\`\`\`\n\nConstructs a provider.\n\n${implementations}`,
    )
    assert.strictEqual(
      markdownAt('provider', 1),
      `\`\`\`silk\nlet provider: Provider\n\`\`\`\n\n${implementations}`,
    )
    assert.strictEqual(markdownAt('plain'), '```silk\nlet plain: Plain\n```')
    assert.strictEqual(markdownAt('0'), '```silk\ni32\n```')
  }),
)

it.effect('does not duplicate an explicitly written provider selector', () =>
  Effect.gen(function* () {
    const source = `import silk.os_writer { StdoutWriter }
import silk.writer { Writer, WriterError }
import silk.effect { Effect }
pub effect fn main() -> () ! WriterError {
  let mut streams = StdoutWriter.make()
  return run Writer.writeAll(b"ok\\n")
    |> Effect.provideMut<Writer>(&mut streams)
}`
    const { document, snapshot } = yield* open(source, 'x86_64-unknown-linux-gnu')
    assert.deepEqual(
      Document.inlayHints(document, snapshot, {
        start: { line: 0, character: 0 },
        end: positionAt(source, source.length),
      }).map((hint) => hint.label),
      [': StdoutWriter'],
    )
  }),
)

it.effect('clips inferred hints, skips unavailable bindings, and maps Unicode snapshots', () =>
  Effect.gen(function* () {
    const source = `import silk.allocator { Allocator, SystemAllocator }
pub fn main() -> i32 {
  let broken = missing()
  // π🙂
  let mut allocator = Allocator.systemAllocatorProvider()
  return 0
}`
    const { document, snapshot } = yield* open(source)
    const range = {
      start: { line: 4, character: 0 },
      end: { line: 4, character: 50 },
    }
    const first = Document.inlayHints(document, snapshot, range)
    assert.deepEqual(Document.inlayHints(document, snapshot, range), first)
    assert.deepEqual(first, [
      {
        position: { line: 4, character: 19 },
        label: ': SystemAllocator',
        kind: 1,
        paddingLeft: false,
        paddingRight: false,
      },
    ])
    assert.deepEqual(
      Document.inlayHints(document, snapshot, {
        start: { line: 0, character: 0 },
        end: { line: 2, character: 0 },
      }),
      [],
    )
  }),
)

it.effect('completes standard-library namespace and source service operations', () =>
  Effect.gen(function* () {
    const source = `import silk.effect { Effect }
pub fn main() -> i32 {
  return Effect.
}`
    const { document, snapshot } = yield* open(source)
    const completion = yield* Document.completion(
      document,
      snapshot,
      {
        line: 2,
        character: '  return Effect.'.length,
      },
      Effect.die('Member completion must not load the auto-import catalog'),
    )
    assert.include(
      completion.items.map((item) => item.label),
      'catch',
    )
    assert.include(
      completion.items.find((item) => item.label === 'catch')?.detail ?? '',
      "pub effect<'env> fn catch",
    )

    const allocatorSource = `import silk.allocator { Allocator, SystemAllocator }
pub fn main() -> i32 {
  return Allocator.
}`
    const allocator = yield* open(allocatorSource)
    const allocatorCompletion = yield* Document.completion(allocator.document, allocator.snapshot, {
      line: 2,
      character: '  return Allocator.'.length,
    })
    assert.include(
      allocatorCompletion.items.map((item) => item.label),
      'allocate',
    )
    assert.include(
      allocatorCompletion.items.find((item) => item.label === 'allocate')?.detail ?? '',
      "effect<'static> fn allocate",
    )
  }),
)

it.effect('completes visible values through a partial identifier replacement', () =>
  Effect.gen(function* () {
    const source = `fn recover(value: i32) -> i32 { return value }
pub fn main() -> i32 {
  return rec
}`
    const { document, snapshot } = yield* open(source)
    const completion = yield* Document.completion(document, snapshot, {
      line: 2,
      character: '  return rec'.length,
    })
    const recover = completion.items.find((item) => item.label === 'recover')
    assert.isDefined(recover)
    assert.deepEqual(recover?.textEdit, {
      range: {
        start: { line: 2, character: '  return '.length },
        end: { line: 2, character: '  return rec'.length },
      },
      newText: 'recover',
    })
  }),
)

it.effect('completes fields from an inferred local subject type', () =>
  Effect.gen(function* () {
    const source = `struct Pair { left: i32 }
pub fn main() -> i32 {
  let pair = Pair { left: 1 }
  return pair.
}`
    const { document, snapshot } = yield* open(source)
    const completion = yield* Document.completion(document, snapshot, {
      line: 3,
      character: '  return pair.'.length,
    })
    assert.include(
      completion.items.map((item) => item.label),
      'left',
    )
  }),
)

it.effect('keeps anonymous record identities local while serving editor structure', () =>
  Effect.gen(function* () {
    const source = `pub fn main() -> i32 {
  let args = .{ name: 1, age: 41 }
  return args.age
}`
    const { document, snapshot } = yield* open(source)
    assert.deepEqual(
      Document.diagnostics(document, snapshot, () => undefined),
      [],
    )

    const argsUse = positionOf(source, 'args', 1)
    const hover = Document.hover(document, snapshot, argsUse)
    const hoverText =
      typeof hover?.contents === 'object' && 'value' in hover.contents ? hover.contents.value : ''
    assert.include(hoverText, 'anonymous record')
    assert.notInclude(hoverText, '@Anonymous')

    const completionSource = `pub fn main() -> i32 {
  let args = .{ name: 1, age: 41 }
  return args.
}`
    const completionDocument = yield* open(completionSource)
    const completion = yield* Document.completion(
      completionDocument.document,
      completionDocument.snapshot,
      positionAt(completionSource, completionSource.indexOf('args.') + 'args.'.length),
    )
    assert.include(
      completion.items.map((item) => item.label),
      'age',
    )
    const ageUse = positionOf(source, 'age', 1)
    assert.deepEqual(
      Document.definition(document, snapshot, ageUse, () => undefined)?.targetSelectionRange.start,
      positionOf(source, 'age'),
    )
  }),
)

it.effect('presents named positional aggregates as tuples', () =>
  Effect.gen(function* () {
    const source = `tuple Point(i32)
pub fn main() -> i32 { let point = Point(42) return point.0 }`
    const { document, snapshot } = yield* open(source)
    assert.deepEqual(
      Document.diagnostics(document, snapshot, () => undefined),
      [],
    )
    const hover = Document.hover(document, snapshot, positionOf(source, 'Point', 1))
    assert.include(
      typeof hover?.contents === 'object' && 'value' in hover.contents ? hover.contents.value : '',
      'tuple Point',
    )
  }),
)

it.effect('uses semantic qualifier lookup and lets a local shadow an intrinsic actor', () =>
  Effect.gen(function* () {
    const source = `struct Pair { left: i32 }
pub fn main() -> i32 {
  let Effect = Pair { left: 1 }
  return Effect.
}`
    const { document, snapshot } = yield* open(source)
    const completion = yield* Document.completion(document, snapshot, {
      line: 3,
      character: '  return Effect.'.length,
    })
    assert.include(
      completion.items.map((item) => item.label),
      'left',
    )
    assert.notInclude(
      completion.items.map((item) => item.label),
      'catch',
    )
  }),
)

it.effect('completes types in damaged parameter and generic-argument positions', () =>
  Effect.gen(function* () {
    const parameterSource = `struct Problem {}
type Trouble = Problem
fn identity<T>(value: ) -> i32 { return 0 }`
    const parameter = yield* open(parameterSource)
    const parameterCompletion = yield* Document.completion(parameter.document, parameter.snapshot, {
      line: 2,
      character: 'fn identity<T>(value: '.length,
    })
    assert.include(
      parameterCompletion.items.map((item) => item.label),
      'Problem',
    )
    assert.include(
      parameterCompletion.items.map((item) => item.label),
      'Trouble',
    )
    assert.notInclude(
      parameterCompletion.items.map((item) => item.label),
      'true',
    )

    const argumentSource = `struct Problem {}
pub fn main() -> i32 { return Effect.catch< }`
    const argument = yield* open(argumentSource)
    const argumentCompletion = yield* Document.completion(argument.document, argument.snapshot, {
      line: 1,
      character: 'pub fn main() -> i32 { return Effect.catch<'.length,
    })
    assert.include(
      argumentCompletion.items.map((item) => item.label),
      'Problem',
    )
    assert.notInclude(
      argumentCompletion.items.map((item) => item.label),
      'false',
    )
  }),
)

it.effect(
  'uses canonical scalar enum identities for hover, completion, navigation, references, and symbols',
  () =>
    Effect.gen(function* () {
      const source = `enum Status { Unknown = 1, Ready }
pub fn main() -> i32 {
  let status = Status.Ready
  return match status { Status.Unknown => 0 Status.Ready => 42 }
}`
      const { document, snapshot } = yield* open(source)
      const readyReference = positionOf(source, 'Ready', 1)
      const hover = Document.hover(document, snapshot, readyReference)
      assert.deepEqual(hover?.contents, {
        kind: 'markdown',
        value: '```silk\nStatus.Ready: Status\n```',
      })

      const completion = yield* Document.completion(
        document,
        snapshot,
        positionAt(source, source.indexOf('Status.Ready') + 'Status.'.length),
      )
      assert.deepEqual(
        completion.items.map((item) => item.label),
        ['Ready', 'Unknown', 'value'],
      )
      assert.strictEqual(
        completion.items.find((item) => item.label === 'Ready')?.detail,
        'Status.Ready: Status',
      )

      const definition = Document.definition(document, snapshot, readyReference, () => undefined)
      assert.deepEqual(definition?.targetSelectionRange.start, positionOf(source, 'Ready', 0))
      assert.deepEqual(
        Document.references(document, snapshot, readyReference, true, () => undefined)?.map(
          ({ range }) => range.start,
        ),
        [positionOf(source, 'Ready', 0), readyReference, positionOf(source, 'Ready', 2)],
      )

      const symbols = Document.symbols(document, snapshot)
      assert.deepEqual(
        symbols[0]?.children?.map((symbol) => [symbol.name, symbol.kind]),
        [
          ['Unknown', SymbolKind.EnumMember],
          ['Ready', SymbolKind.EnumMember],
        ],
      )
    }),
)

it.effect('nests inherent members under their impl symbol and hovers the full contract', () =>
  Effect.gen(function* () {
    const source = `pub struct Counter { count: i32 }
impl Counter {
  pub fn make(count: i32) -> Self { return Counter { count: count } }
  pub fn value(self: &Self) -> i32 { return self.count }
}
pub fn main() -> i32 { let counter = Counter.make(1) return Counter.value(&counter) }`
    const { document, snapshot } = yield* open(source)
    const symbols = Document.symbols(document, snapshot)
    assert.deepEqual(
      symbols.map((symbol) => [
        symbol.name,
        symbol.kind,
        symbol.children?.map((child) => [child.name, child.kind]),
      ]),
      [
        ['Counter', SymbolKind.Struct, [['count', SymbolKind.Field]]],
        [
          'impl Counter',
          SymbolKind.Object,
          [
            ['make', SymbolKind.Function],
            ['value', SymbolKind.Method],
          ],
        ],
        ['main', SymbolKind.Function, undefined],
      ],
    )
    const expected = {
      kind: 'markdown' as const,
      value: "```silk\npub fn value<'life0>(self: &'life0 Counter) -> i32\n```",
    }
    assert.deepEqual(
      Document.hover(document, snapshot, positionOf(source, 'value(self'))?.contents,
      expected,
    )
    assert.deepEqual(
      Document.hover(document, snapshot, positionOf(source, 'value(&counter)'))?.contents,
      expected,
    )
  }),
)

it.effect(
  'uses canonical nominal union identities for editor navigation and constructor help',
  () =>
    Effect.gen(function* () {
      const source = `union Option<T> { Some { value: T }, None }
fn unwrap(option: Option<i32>) -> i32 {
  return match move option { Option<i32>.Some { value } => value Option<i32>.None => 0 }
}
pub fn main() -> i32 {
  let option = Option<i32>.Some { value: 42 }
  return unwrap(move option)
}`
      const { document, snapshot } = yield* open(source)
      const someReference = positionOf(source, 'Some', 1)
      const hover = Document.hover(document, snapshot, someReference)
      assert.deepEqual(hover?.contents, {
        kind: 'markdown',
        value: '```silk\nOption<T>.Some { value: T }: Option<T>\n```',
      })

      const completionSource = `union Option<T> { Some { value: T }, None }
pub fn main() -> i32 { let option = Option. return 0 }`
      const completionState = yield* open(completionSource)
      const completion = yield* Document.completion(
        completionState.document,
        completionState.snapshot,
        positionAt(completionSource, completionSource.indexOf('Option.') + 'Option.'.length),
      )
      assert.deepEqual(
        completion.items
          .filter((item) => item.kind === CompletionItemKind.Constructor)
          .map((item) => item.label),
        ['None', 'Some'],
      )

      const definition = Document.definition(document, snapshot, someReference, () => undefined)
      assert.deepEqual(definition?.targetSelectionRange.start, positionOf(source, 'Some', 0))
      assert.deepEqual(
        Document.references(document, snapshot, someReference, true, () => undefined)?.map(
          ({ range }) => range.start,
        ),
        [positionOf(source, 'Some', 0), someReference, positionOf(source, 'Some', 2)],
      )

      const help = Document.signatureHelp(
        document,
        snapshot,
        positionAt(source, source.indexOf('value: 42') + 'value:'.length),
      )
      assert.strictEqual(help?.signatures.at(0)?.label, 'Option<T>.Some { value: T }: Option<T>')
      assert.deepEqual(
        help?.signatures.at(0)?.parameters?.map((parameter) => parameter.label),
        ['value: T'],
      )

      const symbols = Document.symbols(document, snapshot)
      assert.deepEqual(
        symbols.at(0)?.children?.map((symbol) => [symbol.name, symbol.kind]),
        [
          ['Some', SymbolKind.EnumMember],
          ['None', SymbolKind.EnumMember],
        ],
      )
      assert.deepEqual(
        symbols
          .at(0)
          ?.children?.at(0)
          ?.children?.map((symbol) => [symbol.name, symbol.kind]),
        [['value', SymbolKind.Field]],
      )
    }),
)

it.effect('lists constants, roles, functions, and structs with fields as document symbols', () =>
  Effect.gen(function* () {
    const source = `pub const defaultAnswer: i32 = 42
pub role Primary
pub type Answer = i32
pub struct Box { answer: i32 }
pub unsafe extern "C" fn cAbs(value: i32) -> i32 as "abs"
export "C" fn double(value: i32) -> i32 as "silk_test_double_v1" { return value * 2 }
pub fn main() -> i32 { return 42 }`
    const { document, snapshot } = yield* open(source)
    const symbols = Document.symbols(document, snapshot)
    assert.deepEqual(
      symbols.map((symbol) => [symbol.name, symbol.kind]),
      [
        ['defaultAnswer', SymbolKind.Constant],
        ['Primary', SymbolKind.Enum],
        ['Answer', SymbolKind.Interface],
        ['Box', SymbolKind.Struct],
        ['cAbs', SymbolKind.Function],
        ['double', SymbolKind.Function],
        ['main', SymbolKind.Function],
      ],
    )
    assert.deepEqual(
      symbols[3]?.children?.map((child) => [child.name, child.kind]),
      [['answer', SymbolKind.Field]],
    )
  }),
)

it.effect('formats a non-canonical document with one whole-document edit', () =>
  Effect.gen(function* () {
    const { document, snapshot } = yield* open('pub fn main() -> i32 { return   42 }')
    const edits = yield* Document.format(document, snapshot)
    assert.strictEqual(edits.length, 1)
    assert.include(edits[0]?.newText, 'return 42')
  }),
)

it.effect('formats a damaged document with no edits', () =>
  Effect.gen(function* () {
    const { document, snapshot } = yield* open('pub fn main( -> {')
    assert.deepEqual(yield* Document.format(document, snapshot), [])
  }),
)

it.effect('formats active documentation examples with the shared canonical bytes', () =>
  Effect.gen(function* () {
    const { document, snapshot } = yield* open(EmbeddedFormatting.source)
    const edits = yield* Document.format(document, snapshot)
    assert.deepEqual(
      edits.map((edit) => edit.newText),
      [EmbeddedFormatting.canonical],
    )
  }),
)

it.effect('returns no edit for embedded syntax damage', () =>
  Effect.gen(function* () {
    const source = `/// \`\`\`silk
/// @@@
/// \`\`\`
pub fn main() -> i32 { return 42 }
`
    const { document, snapshot } = yield* open(source)
    assert.deepEqual(yield* Document.format(document, snapshot), [])
  }),
)

it.effect('converts local, parameter, callable, and field targets into definition links', () =>
  Effect.gen(function* () {
    const source = `struct Pair { left: i32 }
fn identity(value: i32) -> i32 {
  let pair = Pair { left: value }
  return pair.left
}
pub fn main() -> i32 { return identity(42) }`
    const { document, snapshot } = yield* open(source)
    const definitionAt = (spelling: string, occurrence: number) => {
      let character = -1
      for (let index = 0; index <= occurrence; index += 1)
        character = source.indexOf(spelling, character + 1)
      const before = source.slice(0, character)
      const line = before.split('\n').length - 1
      const lineStart = before.lastIndexOf('\n') + 1
      return Document.definition(
        document,
        snapshot,
        { line, character: character - lineStart },
        () => undefined,
      )
    }

    assert.strictEqual(definitionAt('value', 1)?.targetSelectionRange.start.line, 1)
    assert.strictEqual(definitionAt('pair', 1)?.targetSelectionRange.start.line, 2)
    assert.strictEqual(definitionAt('left', 2)?.targetSelectionRange.start.line, 0)
    assert.strictEqual(definitionAt('identity', 1)?.targetSelectionRange.start.line, 1)
  }),
)

it.effect('navigates imported module paths', () =>
  Effect.gen(function* () {
    const source = `import silk.vector { Vector }
import silk.effect { Effect }`
    const { document, snapshot } = yield* open(source)
    const definitionAt = (spelling: string, occurrence = 0) =>
      Document.definition(document, snapshot, positionOf(source, spelling, occurrence), uriOfModule)

    assert.strictEqual(definitionAt('vector')?.targetUri, uriOfModule('silk/vector'))
    assert.strictEqual(definitionAt('effect')?.targetUri, uriOfModule('silk/effect'))
    assert.strictEqual(definitionAt('silk')?.targetUri, uriOfModule('silk/vector'))
    assert.strictEqual(definitionAt('silk', 1)?.targetUri, uriOfModule('silk/effect'))
  }),
)

it.effect('navigates higher-order callable references to their declaration', () =>
  Effect.gen(function* () {
    const source = `import silk.vector { Vector }
import silk.effect { Effect }

fn identity(value: Vector<i32>) -> Vector<i32> {
  return move value
}

pub fn main() -> () {
  let value = Vector.make<i32>()
  drop Effect.of(move value)
    |> Effect.map(identity)
}`
    const { document, snapshot } = yield* open(source)
    const definitionAt = (occurrence: number) =>
      Document.definition(
        document,
        snapshot,
        positionOf(source, 'identity', occurrence),
        uriOfModule,
      )

    assert.deepEqual(definitionAt(0)?.targetSelectionRange.start, {
      line: 3,
      character: 3,
    })
    assert.deepEqual(definitionAt(1)?.targetSelectionRange.start, {
      line: 3,
      character: 3,
    })

    const vectorQualifier = positionOf(source, 'Vector', 3)
    assert.strictEqual(
      Document.definition(document, snapshot, vectorQualifier, uriOfModule)?.targetUri,
      uriOfModule('silk/vector'),
    )
    const vectorHover = Document.hover(document, snapshot, vectorQualifier)
    assert.include(
      typeof vectorHover?.contents === 'object' && 'value' in vectorHover.contents
        ? vectorHover.contents.value
        : '',
      'struct Vector<T>',
    )
  }),
)

it.effect('navigates local declaration names but not library imports', () =>
  Effect.gen(function* () {
    const source = `import silk.allocator { Allocator }
struct Problem {}
fn recover<T>(error: Problem, value: T) -> T { return value }
pub fn main() -> i32 {
  let allocator = Allocator.systemAllocatorProvider()
  return recover<i32>(0, 0)
}`
    const { document, snapshot } = yield* open(source)
    const definitionAt = (spelling: string, occurrence = 0) =>
      Document.definition(
        document,
        snapshot,
        positionOf(source, spelling, occurrence),
        () => undefined,
      )

    assert.deepEqual(definitionAt('Problem')?.targetSelectionRange.start, {
      line: 1,
      character: 7,
    })
    assert.deepEqual(definitionAt('Problem', 1)?.targetSelectionRange.start, {
      line: 1,
      character: 7,
    })
    assert.deepEqual(definitionAt('T', 1)?.targetSelectionRange.start, {
      line: 2,
      character: 11,
    })
    assert.deepEqual(definitionAt('recover', 1)?.targetSelectionRange.start, {
      line: 2,
      character: 3,
    })
    assert.isUndefined(definitionAt('SystemAllocator', 1))
    assert.isUndefined(definitionAt('make'))
    assert.isUndefined(definitionAt('i32', 1))
  }),
)

it.effect('uses exact cross-module snapshot sources for qualified definition links', () =>
  Effect.gen(function* () {
    const root = 'import lib\npub fn main() -> i32 { return lib.answer() }'
    const lib = 'pub fn answer() -> i32 { return 42 }'
    const snapshot = yield* Analysis.make({
      root: 'root',
    }).pipe(
      Effect.provide(
        SourceResolver.overlay([SourceFile.make('root', encoder.encode(root))]).pipe(
          Layer.provideMerge(SourceResolver.memory(new Map([['lib', encoder.encode(lib)]]))),
        ),
      ),
    )
    const document = Document.make({
      uri: 'file:///project/root.silk',
      version: 1,
      workspace: 'project:/project/silk.toml',
      module: 'root',
      sourceRoot: '/project',
      bytes: encoder.encode(root),
    })
    const link = Document.definition(
      document,
      snapshot,
      { line: 1, character: root.slice(root.indexOf('\n') + 1).indexOf('answer') },
      (module) => (module === 'lib' ? 'file:///project/lib.silk' : undefined),
    )
    assert.strictEqual(link?.targetUri, 'file:///project/lib.silk')
    assert.deepEqual(link?.targetSelectionRange, {
      start: { line: 0, character: 7 },
      end: { line: 0, character: 13 },
    })
    const qualifier = Document.definition(
      document,
      snapshot,
      positionOf(root, 'lib', 1),
      () => undefined,
    )
    assert.deepEqual(qualifier?.targetSelectionRange, {
      start: { line: 0, character: 7 },
      end: { line: 0, character: 10 },
    })
  }),
)

it.effect('returns no definition for unavailable targets and trivia', () =>
  Effect.gen(function* () {
    const source = 'pub fn main() -> i32 { return missing() }'
    const { document, snapshot } = yield* open(source)
    assert.isUndefined(
      Document.definition(
        document,
        snapshot,
        { line: 0, character: source.indexOf('missing') },
        () => undefined,
      ),
    )
    assert.isUndefined(
      Document.definition(document, snapshot, { line: 0, character: 3 }, () => undefined),
    )
  }),
)

interface ProjectModule {
  readonly module: string
  readonly text: string
}

/**
 * Mirrors `Workspace.uriOf`: a toolchain-shipped module answers with its real installed
 * `file://` href, so an edit aimed at the standard library is visible as such in a test.
 */
const uriOfModule = (module: string): string =>
  Stdlib.find(module)?.sourceUrl.href ?? `file:///project/${module}.silk`

/**
 * Mirrors the installed toolchain resolver: project modules come from memory while reserved
 * standard-library modules carry the `ToolchainFile` origin a real installation reports.
 */
const toolchainResolver = (
  sources: ReadonlyMap<string, Uint8Array>,
): Layer.Layer<SourceResolver.SourceResolver> =>
  Layer.succeed(SourceResolver.SourceResolver, {
    resolve: (module) => {
      const bytes = sources.get(module)
      return Effect.succeed(
        bytes === undefined
          ? Option.none()
          : Option.some(SourceResolver.resolved(bytes, SourceOrigin.memory())),
      )
    },
    resolveStandardLibrary: (module) => {
      const entry = Stdlib.find(module)
      return Effect.succeed(
        entry === undefined
          ? Option.none()
          : Option.some(
              SourceResolver.resolved(
                entry.bytes,
                SourceOrigin.toolchainFile(entry.sourceUrl.href),
              ),
            ),
      )
    },
  })

/** Opens several modules as one analyzed project and focuses one of them as the request document. */
const openProject = (
  modules: Arr.NonEmptyReadonlyArray<ProjectModule>,
  focus: string,
): Effect.Effect<
  {
    readonly document: Document.Document
    readonly snapshot: Analysis.FrontendSnapshot
  },
  ModuleClosure.ModuleClosureError
> =>
  Effect.gen(function* () {
    const bytes = new Map(
      modules.map(({ module, text }) => [module, encoder.encode(text)] as const),
    )
    const project = yield* ProjectAnalysis.make(Arr.map(modules, ({ module }) => module)).pipe(
      Effect.provide(
        SourceResolver.overlay(
          modules.map(({ module }) =>
            SourceFile.make(module, bytes.get(module) ?? new Uint8Array()),
          ),
        ).pipe(Layer.provideMerge(toolchainResolver(bytes))),
      ),
    )
    const snapshot = ProjectAnalysis.view(project, focus)
    if (snapshot === undefined) throw new Error(`Project analysis lost focused root ${focus}`)
    return {
      document: Document.make({
        uri: uriOfModule(focus),
        version: 1,
        workspace: 'project:/project/silk.toml',
        module: focus,
        sourceRoot: '/project',
        bytes: bytes.get(focus) ?? new Uint8Array(),
      }),
      snapshot,
    }
  })

const geometry = 'pub fn area(width: i32, height: i32) -> i32 { return width }'
const consumer =
  'import geometry\npub fn main() -> i32 { return geometry.area(2, 3) + geometry.area(4, 5) }'

it.effect('finds every use of one declaration across two modules', () =>
  Effect.gen(function* () {
    const { document, snapshot } = yield* openProject(
      [
        { module: 'geometry', text: geometry },
        { module: 'main', text: consumer },
      ],
      'geometry',
    )
    const position = positionOf(geometry, 'area')
    assert.deepEqual(
      Document.references(document, snapshot, position, true, uriOfModule)?.map(
        ({ uri, range }) => ({ uri, line: range.start.line, character: range.start.character }),
      ),
      [
        { uri: uriOfModule('geometry'), line: 0, character: geometry.indexOf('area') },
        { uri: uriOfModule('main'), line: 1, character: consumer.split('\n')[1]?.indexOf('area') },
        {
          uri: uriOfModule('main'),
          line: 1,
          character: consumer.split('\n')[1]?.indexOf('area', 40),
        },
      ],
    )
    // Excluding the declaration drops exactly the declaration-site occurrence.
    assert.deepEqual(
      Document.references(document, snapshot, position, false, uriOfModule)?.map(({ uri }) => uri),
      [uriOfModule('main'), uriOfModule('main')],
    )
  }),
)

it.effect('renames a declaration with one workspace edit covering both modules', () =>
  Effect.gen(function* () {
    const { document, snapshot } = yield* openProject(
      [
        { module: 'geometry', text: geometry },
        { module: 'main', text: consumer },
      ],
      'geometry',
    )
    const renamed = Document.rename(
      document,
      snapshot,
      positionOf(geometry, 'area'),
      'surface',
      uriOfModule,
    )
    assert.strictEqual(renamed?._tag, 'RenameEdit')
    if (renamed?._tag !== 'RenameEdit') return
    const changes = renamed.edit.changes ?? {}
    assert.deepEqual(Object.keys(changes).sort(), [uriOfModule('geometry'), uriOfModule('main')])
    assert.deepEqual(
      changes[uriOfModule('geometry')]?.map((edit) => edit.newText),
      ['surface'],
    )
    assert.deepEqual(
      changes[uriOfModule('main')]?.map((edit) => edit.newText),
      ['surface', 'surface'],
    )
  }),
)

it.effect('refuses a rename that collides with a top-level name in any edited module', () =>
  Effect.gen(function* () {
    const local = yield* openProject(
      [{ module: 'geometry', text: `${geometry}\npub fn surface() -> i32 { return 1 }` }],
      'geometry',
    )
    const refusedLocally = Document.rename(
      local.document,
      local.snapshot,
      positionOf(geometry, 'area'),
      'surface',
      uriOfModule,
    )
    assert.deepEqual(refusedLocally, {
      _tag: 'RenameRefusal',
      code: 'SEM0016',
      message: 'Multiple bindings claim surface',
    })

    // The importing module's flat namespace counts too: its selected member would collide there.
    const importer = 'import geometry { area }\npub fn surface() -> i32 { return area(1, 2) }'
    const across = yield* openProject(
      [
        { module: 'geometry', text: geometry },
        { module: 'main', text: importer },
      ],
      'geometry',
    )
    assert.deepEqual(
      Document.rename(
        across.document,
        across.snapshot,
        positionOf(geometry, 'area'),
        'surface',
        uriOfModule,
      ),
      { _tag: 'RenameRefusal', code: 'SEM0016', message: 'Multiple bindings claim surface' },
    )
  }),
)

it.effect('prepares a rename on a name token but fails on a keyword', () =>
  Effect.gen(function* () {
    const { document, snapshot } = yield* openProject(
      [{ module: 'geometry', text: geometry }],
      'geometry',
    )
    assert.deepEqual(Document.prepareRename(document, snapshot, positionOf(geometry, 'area')), {
      range: {
        start: { line: 0, character: geometry.indexOf('area') },
        end: { line: 0, character: geometry.indexOf('area') + 'area'.length },
      },
      placeholder: 'area',
    })
    assert.isUndefined(
      Document.prepareRename(document, snapshot, positionOf(geometry, 'pub')),
      'a keyword token has no renameable declaration',
    )
    assert.isUndefined(Document.prepareRename(document, snapshot, positionOf(geometry, 'return')))
  }),
)

it.effect('renames the imported source name without disturbing a local alias', () =>
  Effect.gen(function* () {
    const aliased =
      'import geometry { area as region }\npub fn main() -> i32 { return region(1, 2) }'
    const { document, snapshot } = yield* openProject(
      [
        { module: 'geometry', text: geometry },
        { module: 'main', text: aliased },
      ],
      'geometry',
    )
    const renamed = Document.rename(
      document,
      snapshot,
      positionOf(geometry, 'area'),
      'surface',
      uriOfModule,
    )
    assert.strictEqual(renamed?._tag, 'RenameEdit')
    if (renamed?._tag !== 'RenameEdit') return
    const changes = renamed.edit.changes ?? {}
    // Only the `area` half of `area as region` moves; `region` and its uses keep their spelling.
    assert.deepEqual(
      changes[uriOfModule('main')]?.map((edit) => ({
        line: edit.range.start.line,
        character: edit.range.start.character,
        newText: edit.newText,
      })),
      [{ line: 0, character: aliased.indexOf('area'), newText: 'surface' }],
    )
  }),
)

const toolchainUri = Stdlib.find('silk/bool')?.sourceUrl.href
const boolConsumer =
  'import silk.bool { equals }\npub fn main() -> bool { return equals(true, true) }'

it.effect('refuses to rename a declaration the installed toolchain owns', () =>
  Effect.gen(function* () {
    const { document, snapshot } = yield* openProject(
      [{ module: 'main', text: boolConsumer }],
      'main',
    )
    assert.isDefined(toolchainUri)
    // The import binding and the call site both reach the same toolchain-owned declaration.
    for (const occurrence of [0, 1]) {
      const position = positionOf(boolConsumer, 'equals', occurrence)
      const renamed = Document.rename(document, snapshot, position, 'sameAs', uriOfModule)
      assert.strictEqual(renamed?._tag, 'RenameRefusal')
      if (renamed?._tag !== 'RenameRefusal') return
      assert.strictEqual(renamed.code, 'LSP0002')
      assert.include(renamed.message, 'silk/bool')
      // The editor is never offered the rename UI for a toolchain-owned declaration either.
      assert.isUndefined(Document.prepareRename(document, snapshot, position))
    }
  }),
)

const boolAlias =
  'import silk.bool { equals as eq }\npub fn main() -> bool { return eq(true, true) }'
// `eq` never spells `equals`, so these two offsets are the whole extent of the alias.
const aliasBinding = boolAlias.indexOf(' as eq') + ' as '.length
const aliasCall = boolAlias.indexOf('eq(')

it.effect('renames a local alias of a toolchain import, which the project owns', () =>
  Effect.gen(function* () {
    const { document, snapshot } = yield* openProject([{ module: 'main', text: boolAlias }], 'main')
    assert.isDefined(toolchainUri)
    // The alias is renameable from its binding and from its use: both name `main`'s own binding.
    for (const offset of [aliasBinding, aliasCall]) {
      const position = positionAt(boolAlias, offset)
      const renamed = Document.rename(document, snapshot, position, 'same', uriOfModule)
      assert.strictEqual(renamed?._tag, 'RenameEdit')
      if (renamed?._tag !== 'RenameEdit') return
      const changes = renamed.edit.changes ?? {}
      // Only the project module is edited: the `equals` half of the clause keeps its spelling.
      assert.deepEqual(Object.keys(changes), [uriOfModule('main')])
      assert.deepEqual(
        changes[uriOfModule('main')]?.map((edit) => ({
          ...edit.range.start,
          newText: edit.newText,
        })),
        [
          { ...positionAt(boolAlias, aliasBinding), newText: 'same' },
          { ...positionAt(boolAlias, aliasCall), newText: 'same' },
        ],
      )
      // Prepare must never grey out F2 where the rename itself succeeds.
      assert.deepEqual(Document.prepareRename(document, snapshot, position), {
        range: {
          start: position,
          end: { line: position.line, character: position.character + 'eq'.length },
        },
        placeholder: 'eq',
      })
    }
  }),
)

it.effect('refuses a toolchain-owned rename before any flat-namespace collision', () =>
  Effect.gen(function* () {
    const { document, snapshot } = yield* openProject(
      [{ module: 'main', text: boolConsumer }],
      'main',
    )
    // `main` already occupies this module's flat namespace, so both refusals apply at once and
    // the toolchain one must win: no new spelling can make this rename legal.
    const both = Document.rename(
      document,
      snapshot,
      positionOf(boolConsumer, 'equals'),
      'main',
      uriOfModule,
    )
    assert.strictEqual(both?._tag, 'RenameRefusal')
    if (both?._tag !== 'RenameRefusal') return
    assert.strictEqual(both.code, 'LSP0002')
    // A collision with no toolchain edit behind it still reports the binding conflict.
    assert.deepEqual(
      Document.rename(document, snapshot, positionOf(boolConsumer, 'main'), 'equals', uriOfModule),
      { _tag: 'RenameRefusal', code: 'SEM0016', message: 'Multiple bindings claim equals' },
    )
  }),
)

const boolHelper =
  'import silk.bool { equals }\npub fn same(left: bool, right: bool) -> bool { return equals(left, right) }'
const boolCaller = 'import helper { same }\npub fn main() -> bool { return same(true, true) }'

it.effect('renames a project declaration used beside toolchain imports without touching them', () =>
  Effect.gen(function* () {
    const { document, snapshot } = yield* openProject(
      [
        { module: 'helper', text: boolHelper },
        { module: 'main', text: boolCaller },
      ],
      'helper',
    )
    const renamed = Document.rename(
      document,
      snapshot,
      positionOf(boolHelper, 'same'),
      'identical',
      uriOfModule,
    )
    assert.strictEqual(renamed?._tag, 'RenameEdit')
    if (renamed?._tag !== 'RenameEdit') return
    const changes = renamed.edit.changes ?? {}
    assert.deepEqual(Object.keys(changes).sort(), [uriOfModule('helper'), uriOfModule('main')])
    // No edit may land in the toolchain installation, whatever the project's closure contains.
    assert.isEmpty(
      Object.keys(changes).filter((uri) => uri === toolchainUri || uri.includes('/stdlib/')),
    )
  }),
)

it.effect('still lists the toolchain declaration among a standard-library name references', () =>
  Effect.gen(function* () {
    const { document, snapshot } = yield* openProject(
      [{ module: 'main', text: boolConsumer }],
      'main',
    )
    const locations = Document.references(
      document,
      snapshot,
      positionOf(boolConsumer, 'equals'),
      true,
      uriOfModule,
    )
    assert.isDefined(locations)
    // References stay read-only and complete: the toolchain declaration is useful to show.
    assert.include(
      locations?.map(({ uri }) => uri),
      toolchainUri,
    )
    assert.include(
      locations?.map(({ uri }) => uri),
      uriOfModule('main'),
    )
  }),
)

const stdlibAliases =
  'import silk.vector { Vector as ProjectVector }\npub fn main() -> i32 { return 0 }'
// Locate the local binding in the selected import clause.
const vectorAliasBinding = stdlibAliases.indexOf('Vector as ProjectVector') + 'Vector as '.length

it.effect('renames a project alias without renaming the standard-library owner', () =>
  Effect.gen(function* () {
    const { document, snapshot } = yield* openProject(
      [{ module: 'main', text: stdlibAliases }],
      'main',
    )
    const position = positionAt(stdlibAliases, vectorAliasBinding)
    // The project owns this alias; the canonical Vector declaration remains read-only.
    const renamed = Document.rename(document, snapshot, position, 'newVector', uriOfModule)
    assert.strictEqual(renamed?._tag, 'RenameEdit')
    if (renamed?._tag !== 'RenameEdit') return
    const changes = renamed.edit.changes ?? {}
    assert.deepEqual(Object.keys(changes), [uriOfModule('main')])
    assert.deepEqual(
      changes[uriOfModule('main')]?.map((edit) => ({ ...edit.range.start, newText: edit.newText })),
      [{ ...position, newText: 'newVector' }],
    )
    // No edit may reach the installation under any module name it ships.
    assert.isEmpty(Object.keys(changes).filter((uri) => uri.includes('/stdlib/')))
    // Prepare answers from the same facts, so the editor offers the rename it will accept.
    assert.deepEqual(Document.prepareRename(document, snapshot, position), {
      range: {
        start: position,
        end: {
          line: position.line,
          character: position.character + 'ProjectVector'.length,
        },
      },
      placeholder: 'ProjectVector',
    })
    // Confining the *rename* leaves the read-only reference list whole: every occurrence of the
    // declaration, standard-library ones included, is still worth showing.
    const locations = Document.references(document, snapshot, position, true, uriOfModule)
    assert.isDefined(locations)
    assert.include(
      locations?.map(({ uri }) => uri),
      uriOfModule('main'),
    )
    assert.isNotEmpty(
      (locations ?? []).filter(({ uri }) => uri === Stdlib.find('silk/vector')?.sourceUrl.href),
    )
  }),
)

const alphaAlias = 'import geometry { area as region }\npub fn one() -> i32 { return region(1, 2) }'
const betaAlias = 'import geometry { area as region }\npub fn two() -> i32 { return region(3, 4) }'

it.effect('keeps one module alias rename out of another module that chose the same alias', () =>
  Effect.gen(function* () {
    const { document, snapshot } = yield* openProject(
      [
        { module: 'geometry', text: geometry },
        { module: 'alpha', text: alphaAlias },
        { module: 'beta', text: betaAlias },
      ],
      'alpha',
    )
    const binding = positionAt(alphaAlias, alphaAlias.indexOf('area as region') + 'area as '.length)
    const renamed = Document.rename(document, snapshot, binding, 'zone', uriOfModule)
    assert.strictEqual(renamed?._tag, 'RenameEdit')
    if (renamed?._tag !== 'RenameEdit') return
    const changes = renamed.edit.changes ?? {}
    // `beta` chose the same spelling for the same declaration; it is not `alpha`'s name to change.
    assert.deepEqual(Object.keys(changes), [uriOfModule('alpha')])
    assert.deepEqual(
      changes[uriOfModule('alpha')]?.map((edit) => ({
        ...edit.range.start,
        newText: edit.newText,
      })),
      [
        { ...binding, newText: 'zone' },
        { ...positionAt(alphaAlias, alphaAlias.indexOf('region(1, 2)')), newText: 'zone' },
      ],
    )
  }),
)

const wholeDocument = (text: string) => ({
  start: { line: 0, character: 0 },
  end: positionAt(text, text.length),
})

it.effect('warns on an unused authored import binding and removes only its selector', () =>
  Effect.gen(function* () {
    const source =
      'import geometry { area, perimeter as boundary }\npub fn main() -> i32 { return area(1, 2) }'
    const modules: Arr.NonEmptyReadonlyArray<ProjectModule> = [
      {
        module: 'geometry',
        text: 'pub fn area(width: i32, height: i32) -> i32 { return width * height }\npub fn perimeter(width: i32, height: i32) -> i32 { return width + height }',
      },
      { module: 'main', text: source },
    ]
    const { document, snapshot } = yield* openProject(modules, 'main')
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    const warning = Document.diagnostics(document, snapshot, uriOfModule).find(
      (diagnostic) => diagnostic.code === 'LSP0004',
    )
    assert.strictEqual(warning?.severity, DiagnosticSeverity.Warning)
    assert.deepEqual(warning?.range, {
      start: positionOf(source, 'boundary'),
      end: positionAt(source, source.indexOf('boundary') + 'boundary'.length),
    })
    const action = (yield* Document.codeActions(
      document,
      snapshot,
      wholeDocument(source),
      uriOfModule,
      Effect.die('Unused import actions must not load the auto-import catalog'),
    )).find((candidate) => candidate.diagnostics?.[0]?.code === 'LSP0004')
    assert.strictEqual(action?.title, 'Remove unused import')
    assert.isUndefined(action?.edit)
    assert.isDefined(action)
    if (action === undefined) return
    const resolved = yield* Document.resolveCodeAction(
      document,
      snapshot,
      Effect.die('Resolving an unused import must not load the auto-import catalog'),
      action,
      uriOfModule,
    )
    const edits = resolved.edit?.changes?.[uriOfModule('main')]
    assert.deepEqual(edits, [
      {
        range: {
          start: positionAt(source, source.indexOf(', perimeter')),
          end: positionAt(source, source.indexOf(' }')),
        },
        newText: '',
      },
    ])
    assert.isDefined(edits)
    if (edits === undefined) return
    const revised = applyDocumentEdits(source, edits)
    const accepted = yield* openProject(
      Arr.map(modules, (entry) => (entry.module === 'main' ? { ...entry, text: revised } : entry)),
      'main',
    )
    assert.deepEqual(Analysis.diagnostics(accepted.snapshot), [])
    assert.isEmpty(
      Document.diagnostics(accepted.document, accepted.snapshot, uriOfModule).filter(
        (diagnostic) => diagnostic.code === 'LSP0004',
      ),
    )

    const stale = Document.make({ ...document, version: 2 })
    assert.include(
      (yield* Document.resolveCodeAction(
        stale,
        snapshot,
        Effect.succeed(inventoryOf(modules)),
        action,
        uriOfModule,
      )).disabled?.reason ?? '',
      'revision',
    )
  }),
)

it.effect('attributes import use to the exact authored binding', () =>
  Effect.gen(function* () {
    const library =
      'pub fn area(width: i32, height: i32) -> i32 { return width * height }\npub fn perimeter(width: i32, height: i32) -> i32 { return width + height }'
    const cases = [
      {
        label: 'qualified access does not use a direct selector',
        source:
          'import geometry { area }\nimport geometry as geo\npub fn main() -> i32 { return geo.area(1, 2) }',
        unused: ['area'],
      },
      {
        label: 'only the unreferenced alias of one declaration is unused',
        source:
          'import geometry { area as used, area as idle }\npub fn main() -> i32 { return used(1, 2) }',
        unused: ['idle'],
      },
      {
        label: 'a direct hybrid selector does not use its namespace',
        source: 'import geometry as geo { area }\npub fn main() -> i32 { return area(1, 2) }',
        unused: ['geo'],
      },
      {
        label: 'a hybrid namespace use does not use its direct selector',
        source: 'import geometry as geo { area }\npub fn main() -> i32 { return geo.area(1, 2) }',
        unused: ['area'],
      },
      {
        label: 'a local parameter shadows rather than uses an import',
        source: 'import geometry { area }\npub fn main(area: i32) -> i32 { return area }',
        unused: ['area'],
      },
    ]
    for (const testCase of cases) {
      const { snapshot } = yield* openProject(
        [
          { module: 'geometry', text: library },
          { module: 'main', text: testCase.source },
        ],
        'main',
      )
      assert.deepEqual(Analysis.diagnostics(snapshot), [], testCase.label)
      assert.deepEqual(
        Analysis.unusedImports(snapshot, 'main').map(({ spelling }) => spelling),
        testCase.unused,
        testCase.label,
      )
    }

    const repeated =
      'import geometry { area }\nimport geometry { area }\npub fn main() -> i32 { return area(1, 2) }'
    const { snapshot } = yield* openProject(
      [
        { module: 'geometry', text: library },
        { module: 'main', text: repeated },
      ],
      'main',
    )
    assert.deepEqual(Analysis.unusedImports(snapshot, 'main'), [])
  }),
)

it.effect('counts conformance heads and mappings as import uses', () =>
  Effect.gen(function* () {
    const library = `pub interface Printable { fn print(value: &Self) -> i32 }
pub struct Witness {}
impl Witness { pub fn printItem(value: &Witness) -> i32 { return 1 } }`
    const source = `import library { Printable, Witness }
pub struct Item {}
impl Printable for Item { print: Witness.printItem }`
    const { snapshot } = yield* openProject(
      [
        { module: 'library', text: library },
        { module: 'main', text: source },
      ],
      'main',
    )
    // The incompatible witness is intentional: a rejected mapping still semantically references
    // its authored target and must not cascade into an unrelated unused-import warning.
    assert.deepEqual(
      Analysis.diagnostics(snapshot).map(({ code }) => code),
      ['SEM0083'],
    )
    assert.deepEqual(Analysis.unusedImports(snapshot, 'main'), [])
  }),
)

it.effect('plans only trivia-safe import removals', () =>
  Effect.gen(function* () {
    const declaration = `pub fn area(width: i32, height: i32) -> i32 { return width * height }
pub fn perimeter(width: i32, height: i32) -> i32 { return width + height }
pub fn diagonal(width: i32, height: i32) -> i32 { return width + height }`
    const removalText = (
      source: string,
      snapshot: Analysis.FrontendSnapshot,
      spelling: string,
    ): string | undefined => {
      const binding = Analysis.unusedImports(snapshot, 'main').find(
        (candidate) => candidate.spelling === spelling,
      )
      const edit = binding?.change?.changes.get('main')?.at(0)
      return edit === undefined ? undefined : source.slice(edit.span.start, edit.span.end)
    }

    const listCases = [
      {
        source:
          'import geometry { area, perimeter }\npub fn main() -> i32 { return perimeter(1, 2) }',
        spelling: 'area',
        removed: ' area,',
      },
      {
        source:
          'import geometry { area, perimeter, diagonal }\npub fn main() -> i32 { return area(1, 2) + diagonal(1, 2) }',
        spelling: 'perimeter',
        removed: ' perimeter,',
      },
      {
        source: 'import geometry { area, perimeter }\npub fn main() -> i32 { return area(1, 2) }',
        spelling: 'perimeter',
        removed: ', perimeter',
      },
    ]
    for (const testCase of listCases) {
      const { snapshot } = yield* openProject(
        [
          { module: 'geometry', text: declaration },
          { module: 'main', text: testCase.source },
        ],
        'main',
      )
      assert.strictEqual(
        removalText(testCase.source, snapshot, testCase.spelling),
        testCase.removed,
      )
    }

    const hybridNamespace =
      'import geometry as geo { area }\npub fn main() -> i32 { return area(1, 2) }'
    const direct = yield* openProject(
      [
        { module: 'geometry', text: declaration },
        { module: 'main', text: hybridNamespace },
      ],
      'main',
    )
    assert.strictEqual(removalText(hybridNamespace, direct.snapshot, 'geo'), ' as geo')

    const hybridMember =
      'import geometry as geo { area }\npub fn main() -> i32 { return geo.area(1, 2) }'
    const qualified = yield* openProject(
      [
        { module: 'geometry', text: declaration },
        { module: 'main', text: hybridMember },
      ],
      'main',
    )
    assert.strictEqual(removalText(hybridMember, qualified.snapshot, 'area'), ' { area }')

    const nonFirst =
      'import geometry\nimport unused\npub fn main() -> i32 { return geometry.area(1, 2) }'
    const whole = yield* openProject(
      [
        { module: 'geometry', text: declaration },
        { module: 'unused', text: 'pub fn value() -> i32 { return 1 }' },
        { module: 'main', text: nonFirst },
      ],
      'main',
    )
    assert.strictEqual(removalText(nonFirst, whole.snapshot, 'unused'), 'import unused\n')

    const crlf = 'import geometry\r\npub fn main() -> i32 { return 0 }'
    const windows = yield* openProject(
      [
        { module: 'geometry', text: declaration },
        { module: 'main', text: crlf },
      ],
      'main',
    )
    assert.strictEqual(removalText(crlf, windows.snapshot, 'geometry'), 'import geometry\r\n')

    const commented =
      'import geometry { area, perimeter // belongs to perimeter\n}\npub fn main() -> i32 { return area(1, 2) }'
    const comment = yield* openProject(
      [
        { module: 'geometry', text: declaration },
        { module: 'main', text: commented },
      ],
      'main',
    )
    assert.strictEqual(removalText(commented, comment.snapshot, 'perimeter'), undefined)

    const recovered = 'import geometry { area'
    const recovery = yield* openProject(
      [
        { module: 'geometry', text: declaration },
        { module: 'main', text: recovered },
      ],
      'main',
    )
    assert.isNotEmpty(Analysis.diagnostics(recovery.snapshot))
    assert.deepEqual(Analysis.unusedImports(recovery.snapshot, 'main'), [])

    const invalid = `import alpha { value }
import beta { value }
import library { hidden, missing, width }`
    const failures = yield* openProject(
      [
        { module: 'alpha', text: 'pub fn value() -> i32 { return 1 }' },
        { module: 'beta', text: 'pub fn value() -> i32 { return 2 }' },
        {
          module: 'library',
          text: `fn hidden() -> i32 { return 0 }
pub struct Gadget { pub size: i32 }
impl Gadget { pub fn width(self: &Self) -> i32 { return self.size } }`,
        },
        { module: 'main', text: invalid },
      ],
      'main',
    )
    assert.isAtLeast(Analysis.diagnostics(failures.snapshot).length, 4)
    assert.deepEqual(Analysis.unusedImports(failures.snapshot, 'main'), [])
  }),
)

it.effect('keeps redundancy ownership local to its import declaration', () =>
  Effect.gen(function* () {
    const source = `import geometry { area }
import geometry { area }
import geometry as unused
pub fn main() -> i32 { return area(1, 2) }`
    const { document, snapshot } = yield* openProject(
      [
        { module: 'geometry', text: geometry },
        { module: 'main', text: source },
      ],
      'main',
    )
    assert.deepEqual(
      Document.diagnostics(document, snapshot, uriOfModule)
        .filter(({ source: owner }) => owner === 'silk-lsp')
        .map(({ code }) => code),
      ['LSP0001', 'LSP0004'],
    )
  }),
)

const redundantAlias =
  'import geometry as geometry\npub fn main() -> i32 { return geometry.area(1, 2) }'

it.effect('offers one quick fix that deletes a redundant alias clause', () =>
  Effect.gen(function* () {
    const { document, snapshot } = yield* openProject(
      [
        { module: 'geometry', text: geometry },
        { module: 'main', text: redundantAlias },
      ],
      'main',
    )
    const actions = yield* Document.codeActions(
      document,
      snapshot,
      wholeDocument(redundantAlias),
      uriOfModule,
    )
    assert.strictEqual(actions.length, 1)
    const action = actions[0]
    assert.strictEqual(action?.title, 'Remove the redundant alias')
    assert.strictEqual(action?.kind, 'quickfix')
    // The action names the diagnostic it corrects, so the editor attaches it to that lightbulb.
    assert.strictEqual(action?.diagnostics?.[0]?.code, 'LSP0002')
    assert.deepEqual(action?.edit?.changes?.[uriOfModule('main')], [
      {
        range: {
          start: positionAt(redundantAlias, redundantAlias.indexOf(' as geometry')),
          end: positionAt(
            redundantAlias,
            redundantAlias.indexOf(' as geometry') + ' as geometry'.length,
          ),
        },
        newText: '',
      },
    ])
  }),
)

it.effect('warns about combinable imports and consolidates them without compiler involvement', () =>
  Effect.gen(function* () {
    const source =
      'import geometry { area }\nimport geometry { perimeter as boundary }\npub fn main() -> i32 { return area(1, 2) }'
    const { document, snapshot } = yield* openProject(
      [
        {
          module: 'geometry',
          text: 'pub fn area(width: i32, height: i32) -> i32 { return width * height }\npub fn perimeter(width: i32, height: i32) -> i32 { return width + height }',
        },
        { module: 'main', text: source },
      ],
      'main',
    )
    assert.deepEqual(
      Document.diagnostics(document, snapshot, uriOfModule)
        .filter((diagnostic) => diagnostic.source === 'silk-lsp')
        .map((diagnostic) => diagnostic.code),
      ['LSP0003'],
    )
    const action = (yield* Document.codeActions(
      document,
      snapshot,
      wholeDocument(source),
      uriOfModule,
    )).find((candidate) => candidate.diagnostics?.[0]?.code === 'LSP0003')
    assert.deepEqual(action?.edit?.changes?.[uriOfModule('main')], [
      {
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 'import geometry { area }'.length },
        },
        newText: 'import geometry { area, perimeter as boundary }',
      },
      {
        range: {
          start: { line: 1, character: 0 },
          end: { line: 2, character: 0 },
        },
        newText: '',
      },
    ])
  }),
)

it.effect('offers no code action for a diagnostic that carries no edit', () =>
  Effect.gen(function* () {
    const source = 'pub fn main() -> i32 { return missing() }'
    const { document, snapshot } = yield* open(source)
    assert.strictEqual(
      Document.diagnostics(document, snapshot, () => undefined)[0]?.code,
      'SEM0004',
    )
    assert.deepEqual(
      yield* Document.codeActions(document, snapshot, wholeDocument(source), () => undefined),
      [],
    )
  }),
)

const inventoryOf = (
  modules: ReadonlyArray<ProjectModule>,
  stdlibModules: ReadonlyArray<string> = [],
): WorkspaceInventory.WorkspaceInventory =>
  WorkspaceInventory.make({
    project: modules.map(({ module, text }) => {
      const source = SourceFile.make(module, encoder.encode(text))
      return [module, ModuleSummary.make(Parser.parse(Lexer.lex(source)))] as const
    }),
    toolchain: stdlibModules.map((module) => {
      const bytes = Stdlib.sources.get(module)
      if (bytes === undefined) throw new Error(`missing stdlib module ${module}`)
      const source = SourceFile.make(module, bytes)
      return [module, ModuleSummary.make(Parser.parse(Lexer.lex(source)))] as const
    }),
  })

it.effect('completes catalog declarations with explicit collision-aware imports', () =>
  Effect.gen(function* () {
    const source = 'struct Logger {}\npub fn main() -> i32 { Logg return 0 }'
    const { document, snapshot } = yield* open(source)
    const inventory = inventoryOf([
      { module: 'main', text: source },
      { module: 'silk/logger', text: 'pub union Logger { Empty }' },
    ])
    const completion = yield* Document.completion(
      document,
      snapshot,
      positionAt(source, source.indexOf('Logg') + 'Logg'.length),
      Effect.succeed(inventory),
    )
    const imported = completion.items.find(
      (item) => item.label === 'Logger' && item.detail === 'Import from silk/logger',
    )
    assert.strictEqual(imported?.kind, CompletionItemKind.Enum)
    assert.deepEqual(imported?.textEdit, {
      range: {
        start: positionAt(source, source.indexOf('Logg')),
        end: positionAt(source, source.indexOf('Logg') + 'Logg'.length),
      },
      newText: 'LoggerLogger',
    })
    assert.deepEqual(imported?.additionalTextEdits, [
      {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        newText: 'import silk.logger { Logger as LoggerLogger }\n',
      },
    ])
  }),
)

it.effect('completes partial and complete Effect spellings with a member import', () =>
  Effect.gen(function* () {
    for (const spelling of ['Eff', 'Effect']) {
      const source = `pub fn main() -> i32 { ${spelling} return 0 }`
      const { document, snapshot } = yield* open(source)
      const completion = yield* Document.completion(
        document,
        snapshot,
        positionAt(source, source.indexOf(spelling) + spelling.length),
        Effect.succeed(inventoryOf([{ module: 'main', text: source }], ['silk/effect'])),
      )
      // The anchored Effect member makes the namespace form redundant.
      assert.notInclude(
        completion.items.map((item) => item.detail),
        'Import namespace from silk/effect',
      )
      const imported = completion.items.find(
        (item) => item.label === 'Effect' && item.detail === 'Import from silk/effect',
      )
      assert.deepEqual(imported?.textEdit, {
        range: {
          start: positionAt(source, source.indexOf(spelling)),
          end: positionAt(source, source.indexOf(spelling) + spelling.length),
        },
        newText: 'Effect',
      })
      assert.deepEqual(imported?.additionalTextEdits, [
        {
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
          newText: 'import silk.effect { Effect }\n',
        },
      ])
    }
  }),
)

it.effect('keeps Effect type completion import-free', () =>
  Effect.gen(function* () {
    const source = 'fn retain(value: Eff) -> i32 { return 0 }'
    const { document, snapshot } = yield* open(source)
    const completion = yield* Document.completion(
      document,
      snapshot,
      positionAt(source, source.indexOf('Eff') + 'Eff'.length),
      Effect.succeed(inventoryOf([{ module: 'main', text: source }], ['silk/effect'])),
    )
    const effect = completion.items.find(
      (item) => item.label === 'Effect' && item.additionalTextEdits === undefined,
    )
    assert.isDefined(effect)
    assert.notInclude(
      completion.items.map((item) => item.detail),
      'Import namespace from silk/effect',
    )
  }),
)

it.effect('aliases a colliding Effect member completion deterministically', () =>
  Effect.gen(function* () {
    const source = 'struct Effect {}\npub fn main() -> i32 { Eff return 0 }'
    const { document, snapshot } = yield* open(source)
    const completion = yield* Document.completion(
      document,
      snapshot,
      positionAt(source, source.lastIndexOf('Eff') + 'Eff'.length),
      Effect.succeed(inventoryOf([{ module: 'main', text: source }], ['silk/effect'])),
    )
    assert.notInclude(
      completion.items.map((item) => item.detail),
      'Import namespace from silk/effect',
    )
    const imported = completion.items.find(
      (item) => item.label === 'Effect' && item.detail === 'Import from silk/effect',
    )
    assert.strictEqual(imported?.textEdit?.newText, 'EffectEffect')
    assert.strictEqual(
      imported?.additionalTextEdits?.[0]?.newText,
      'import silk.effect { Effect as EffectEffect }\n',
    )
  }),
)

it.effect('does not duplicate an existing equivalent Effect import', () =>
  Effect.gen(function* () {
    for (const declaration of ['import silk.effect { Effect }', 'import silk.effect {Effect}']) {
      const source = `${declaration}\npub fn main() -> i32 { Eff return 0 }`
      const { document, snapshot } = yield* open(source)
      const completion = yield* Document.completion(
        document,
        snapshot,
        positionAt(source, source.lastIndexOf('Eff') + 'Eff'.length),
        Effect.succeed(inventoryOf([{ module: 'main', text: source }], ['silk/effect'])),
      )
      assert.strictEqual(
        completion.items.filter((item) => item.detail === 'Import namespace from silk/effect')
          .length,
        0,
        declaration,
      )
      // The member form is the canonical import: with it in place nothing re-imports Effect. The
      // legacy namespace alias leaves the member unimported, so the ordinary collision-aliased
      // member suggestion may still appear there.
      if (declaration === 'import silk.effect { Effect }')
        assert.strictEqual(
          completion.items.filter(
            (item) => item.label === 'Effect' && item.detail === 'Import from silk/effect',
          ).length,
          0,
          declaration,
        )
      const effect = completion.items.find((item) => item.label === 'Effect')
      assert.isDefined(effect, declaration)
      assert.isUndefined(effect?.additionalTextEdits, declaration)
    }
  }),
)

const applyDocumentEdits = (
  source: string,
  edits: ReadonlyArray<{
    range: { start: { line: number; character: number }; end: { line: number; character: number } }
    newText: string
  }>,
): string => {
  const offset = (position: { line: number; character: number }): number => {
    const lines = source.split('\n')
    return (
      lines.slice(0, position.line).reduce((total, line) => total + line.length + 1, 0) +
      position.character
    )
  }
  let revised = source
  for (const edit of [...edits].sort(
    (left, right) => offset(right.range.start) - offset(left.range.start),
  ))
    revised = `${revised.slice(0, offset(edit.range.start))}${edit.newText}${revised.slice(offset(edit.range.end))}`
  return revised
}

it.effect('resolves explicit lifetime edits only for the analyzed document revision and text', () =>
  Effect.gen(function* () {
    const source = `// π🙂 preserved
struct View<T> { value: &T }`
    const { document, snapshot } = yield* open(source)
    const inventory = inventoryOf([{ module: 'main', text: source }])
    const actions = yield* Document.codeActions(
      document,
      snapshot,
      wholeDocument(source),
      uriOfModule,
    )
    const selected = actions.find((action) => action.title === 'Make lifetimes explicit')
    assert.isDefined(selected)
    if (selected === undefined) return
    assert.isUndefined(selected.edit)
    const resolved = yield* Document.resolveCodeAction(
      document,
      snapshot,
      Effect.succeed(inventory),
      selected,
      uriOfModule,
    )
    const edits = resolved.edit?.changes?.[document.uri]
    assert.isDefined(edits)
    if (edits === undefined) return
    const revised = applyDocumentEdits(source, edits)
    assert.strictEqual(
      revised,
      `// π🙂 preserved
struct View<T, 'life1> { value: &'life1 T }`,
    )
    const result = yield* Analysis.ofSource('main', encoder.encode(revised))
    assert.deepEqual(Analysis.diagnostics(result), [])
    assert.deepEqual(
      Analysis.explicitLifetimes(result, 'main', 0, encoder.encode(revised).length),
      [],
    )
    for (const stale of [
      Document.make({ ...document, version: 2 }),
      Document.make({ ...document, bytes: encoder.encode(source.replace('value', 'other')) }),
    ]) {
      const rejected = yield* Document.resolveCodeAction(
        stale,
        snapshot,
        Effect.succeed(inventory),
        resolved,
        uriOfModule,
      )
      assert.isDefined(rejected.disabled)
      assert.isUndefined(rejected.edit)
    }
  }),
)

it.effect('withholds lifetime expansions from invalid headers and requests inside a body', () =>
  Effect.gen(function* () {
    for (const source of [
      'fn ambiguous(left: &i32, right: &i32) -> &i32 { return left }',
      'struct Invalid { value: &Missing }',
      'fn inspect(value: &i32) -> i32 { return 1 }',
    ]) {
      const { document, snapshot } = yield* open(source)
      const body = source.indexOf('return')
      const range = source.startsWith('fn inspect')
        ? { start: positionAt(source, body), end: positionAt(source, body + 6) }
        : wholeDocument(source)
      assert.deepEqual(
        (yield* Document.codeActions(document, snapshot, range, uriOfModule)).filter(
          (action) => action.title === 'Make lifetimes explicit',
        ),
        [],
        source,
      )
    }
  }),
)

it.effect('offers compiling failure propagation and recovery actions', () =>
  Effect.gen(function* () {
    const source = `pub struct Problem {}
effect fn risky() -> i32 ! Problem { fail Problem {} }
effect fn recover(error: Problem) -> i32 { return 42 }
pub effect fn main() -> i32 { return run risky() }`
    const { document, snapshot } = yield* open(source)
    const actions = (yield* Document.codeActions(
      document,
      snapshot,
      wholeDocument(source),
      uriOfModule,
    )).filter((action) => action.kind === 'quickfix')
    assert.deepEqual(
      actions.map((action) => action.title),
      ['Propagate Problem from this Effect', 'Recover this Effect with recover'],
    )
    for (const action of actions) {
      const edits = action.edit?.changes?.[document.uri]
      assert.isDefined(edits, action.title)
      if (edits === undefined) continue
      const revised = applyDocumentEdits(source, edits)
      const result = yield* Analysis.ofSource('main', encoder.encode(revised))
      assert.deepEqual(Analysis.diagnostics(result), [], `${action.title}\n${revised}`)
    }
  }),
)

it.effect('offers compiling requirement propagation and provision actions', () =>
  Effect.gen(function* () {
    const source = `pub service Clock { effect fn read() -> i32 ? &Clock }
struct FixedClock {}
effect fn read(self: &FixedClock) -> i32 { return 42 }
impl Clock for FixedClock { read: FixedClock.read }
pub effect fn main() -> i32 {
  let provider = FixedClock {}
  return run Clock.read()
}`
    const { document, snapshot } = yield* open(source)
    const actions = (yield* Document.codeActions(
      document,
      snapshot,
      wholeDocument(source),
      uriOfModule,
    )).filter((action) => action.kind === 'quickfix')
    assert.deepEqual(
      actions.map((action) => action.title),
      ['Propagate &Clock from this Effect', 'Provide this Effect with provider'],
    )
    for (const action of actions) {
      const edits = action.edit?.changes?.[document.uri]
      assert.isDefined(edits, action.title)
      if (edits === undefined) continue
      const revised = applyDocumentEdits(source, edits)
      const result = yield* Analysis.ofSource('main', encoder.encode(revised))
      assert.deepEqual(Analysis.diagnostics(result), [], `${action.title}\n${revised}`)
    }
  }),
)

it.effect('discovers ambiguous auto-import descriptors and resolves the selected new import', () =>
  Effect.gen(function* () {
    const source = 'pub fn main() -> i32 { return calculate() }'
    const modules = [
      { module: 'main', text: source },
      { module: 'alpha', text: 'pub fn calculate() -> i32 { return 1 }' },
      { module: 'beta', text: 'pub fn calculate() -> i32 { return 2 }' },
      { module: 'private', text: 'fn calculate() -> i32 { return 3 }' },
    ]
    const { document, snapshot } = yield* open(source)
    const inventory = inventoryOf(modules)
    const actions = yield* Document.codeActions(
      document,
      snapshot,
      wholeDocument(source),
      uriOfModule,
      Effect.succeed(inventory),
    )

    assert.deepEqual(
      actions.map((action) => action.title),
      ['Import calculate from alpha', 'Import calculate from beta'],
    )
    assert.deepEqual(actions[0]?.edit?.changes?.[document.uri], [
      {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        newText: 'import alpha { calculate }\n',
      },
    ])
    const selected = actions[0]
    assert.isDefined(selected)
    if (selected === undefined) return
    const resolved = yield* Document.resolveCodeAction(
      document,
      snapshot,
      Effect.succeed(inventory),
      selected,
      uriOfModule,
    )
    assert.deepEqual(resolved.edit?.changes?.[document.uri], [
      {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        newText: 'import alpha { calculate }\n',
      },
    ])

    const stale = Document.make({ ...document, version: 2 })
    assert.include(
      (yield* Document.resolveCodeAction(
        stale,
        snapshot,
        Effect.succeed(inventory),
        selected,
        uriOfModule,
      )).disabled?.reason ?? '',
      'revision',
    )
  }),
)

it.effect(
  'extends an existing import with UTF-16 ranges and filters actions outside the request',
  () =>
    Effect.gen(function* () {
      const library = `pub fn existing() -> i32 { return 1 }
pub fn calculate() -> i32 { return 2 }`
      const source = `// π🙂
import library { existing }
pub fn main() -> i32 { return calculate() }`
      const modules: Arr.NonEmptyReadonlyArray<ProjectModule> = [
        { module: 'library', text: library },
        { module: 'main', text: source },
      ]
      const { document, snapshot } = yield* openProject(modules, 'main')
      const inventory = inventoryOf(modules)
      assert.deepEqual(
        yield* Document.codeActions(
          document,
          snapshot,
          { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } },
          uriOfModule,
          Effect.succeed(inventory),
        ),
        [],
      )
      const actions = yield* Document.codeActions(
        document,
        snapshot,
        wholeDocument(source),
        uriOfModule,
        Effect.succeed(inventory),
      )
      const action = actions.find((candidate) => candidate.title.includes('calculate'))
      assert.isDefined(action)
      if (action === undefined) return
      const resolved = yield* Document.resolveCodeAction(
        document,
        snapshot,
        Effect.succeed(inventory),
        action,
        uriOfModule,
      )
      assert.deepEqual(resolved.edit?.changes?.[document.uri], [
        {
          range: {
            start: { line: 1, character: 'import library { existing'.length },
            end: { line: 1, character: 'import library { existing'.length },
          },
          newText: ', calculate',
        },
      ])
    }),
)

const twoAliases = `import geometry as geometry
import shapes as shapes
pub fn main() -> i32 { return geometry.area(1, 2) + shapes.sides() }`

it.effect('returns the quick fixes of two diagnostics in diagnostic order', () =>
  Effect.gen(function* () {
    const { document, snapshot } = yield* openProject(
      [
        { module: 'geometry', text: geometry },
        { module: 'shapes', text: 'pub fn sides() -> i32 { return 4 }' },
        { module: 'main', text: twoAliases },
      ],
      'main',
    )
    const actions = yield* Document.codeActions(
      document,
      snapshot,
      wholeDocument(twoAliases),
      uriOfModule,
    )
    assert.deepEqual(
      actions.map((action) => action.edit?.changes?.[uriOfModule('main')]?.[0]?.range.start),
      [
        positionAt(twoAliases, twoAliases.indexOf(' as geometry')),
        positionAt(twoAliases, twoAliases.indexOf(' as shapes')),
      ],
    )
  }),
)

const nonAsciiAlias = `// π🙂
import geometry as geometry
pub fn main() -> i32 { return geometry.area(1, 2) }`

it.effect('measures a quick fix range in UTF-16 units after non-ASCII source', () =>
  Effect.gen(function* () {
    const { document, snapshot } = yield* openProject(
      [
        { module: 'geometry', text: geometry },
        { module: 'main', text: nonAsciiAlias },
      ],
      'main',
    )
    const actions = yield* Document.codeActions(
      document,
      snapshot,
      wholeDocument(nonAsciiAlias),
      uriOfModule,
    )
    // `positionAt` counts UTF-16 units, which is what the negotiated encoding measures; a byte
    // offset would place the clause later on its line.
    assert.deepEqual(actions[0]?.edit?.changes?.[uriOfModule('main')]?.[0]?.range, {
      start: positionAt(nonAsciiAlias, nonAsciiAlias.indexOf(' as geometry')),
      end: positionAt(nonAsciiAlias, nonAsciiAlias.indexOf(' as geometry') + ' as geometry'.length),
    })
  }),
)

it.effect('offers no quick fix for a diagnostic outside the requested range', () =>
  Effect.gen(function* () {
    const { document, snapshot } = yield* openProject(
      [
        { module: 'geometry', text: geometry },
        { module: 'main', text: redundantAlias },
      ],
      'main',
    )
    assert.deepEqual(
      yield* Document.codeActions(
        document,
        snapshot,
        { start: { line: 1, character: 0 }, end: { line: 1, character: 4 } },
        uriOfModule,
      ),
      [],
    )
  }),
)

const clamp = `pub fn clamp(value: i32, low: i32, high: i32) -> i32 { return value }
pub fn main() -> i32 { return clamp(3, 0, 10) }
`

it.effect('labels a call signature with its declaration and one label per parameter', () =>
  Effect.gen(function* () {
    const { document, snapshot } = yield* open(clamp)
    const help = Document.signatureHelp(
      document,
      snapshot,
      positionAt(clamp, clamp.indexOf('clamp(3') + 'clamp('.length),
    )
    assert.strictEqual(help?.signatures.length, 1)
    assert.strictEqual(
      help?.signatures[0]?.label,
      'pub fn clamp(value: i32, low: i32, high: i32) -> i32',
    )
    assert.deepEqual(
      help?.signatures[0]?.parameters?.map((parameter) => parameter.label),
      ['value: i32', 'low: i32', 'high: i32'],
    )
    assert.strictEqual(help?.activeSignature, 0)
  }),
)

it.effect('advances the active parameter across each comma of the call', () =>
  Effect.gen(function* () {
    const { document, snapshot } = yield* open(clamp)
    const call = clamp.indexOf('clamp(3')
    const activeAt = (offset: number) =>
      Document.signatureHelp(document, snapshot, positionAt(clamp, offset))?.activeParameter
    assert.strictEqual(activeAt(call + 'clamp('.length), 0)
    assert.strictEqual(activeAt(call + 'clamp(3, '.length), 1)
    assert.strictEqual(activeAt(call + 'clamp(3, 0, '.length), 2)
  }),
)

it.effect('returns no signature help outside a call', () =>
  Effect.gen(function* () {
    const { document, snapshot } = yield* open(clamp)
    assert.isUndefined(Document.signatureHelp(document, snapshot, positionOf(clamp, 'clamp', 0)))
    assert.isUndefined(
      Document.signatureHelp(
        document,
        snapshot,
        positionAt(clamp, clamp.indexOf('clamp(3, 0, 10)') + 'clamp(3, 0, 10)'.length),
      ),
    )
  }),
)

it.effect('answers signature help from the recovered call of a source with a parser error', () =>
  Effect.gen(function* () {
    const source = `pub fn clamp(value: i32, low: i32, high: i32) -> i32 { return value }
pub fn main() -> i32 { return clamp(3,
}
`
    const { document, snapshot } = yield* open(source)
    assert.isTrue(
      Document.diagnostics(document, snapshot, () => undefined).length > 0,
      'the source is expected not to compile',
    )
    const help = Document.signatureHelp(
      document,
      snapshot,
      positionAt(source, source.indexOf('clamp(3,') + 'clamp(3,'.length),
    )
    assert.strictEqual(
      help?.signatures[0]?.label,
      'pub fn clamp(value: i32, low: i32, high: i32) -> i32',
    )
    assert.strictEqual(help?.activeParameter, 1)
  }),
)

it.effect('carries the documentation of the called declaration as Markdown', () =>
  Effect.gen(function* () {
    const source = `/// Clamps a value into a range.
pub fn clamp(value: i32, low: i32, high: i32) -> i32 { return value }
pub fn main() -> i32 { return clamp(3, 0, 10) }
`
    const { document, snapshot } = yield* open(source)
    const help = Document.signatureHelp(
      document,
      snapshot,
      positionAt(source, source.indexOf('clamp(3') + 'clamp('.length),
    )
    assert.deepEqual(help?.signatures[0]?.documentation, {
      kind: 'markdown',
      value: 'Clamps a value into a range.',
    })
  }),
)

it.effect('selects the inner call when two calls nest', () =>
  Effect.gen(function* () {
    const source = `pub fn clamp(value: i32, low: i32, high: i32) -> i32 { return value }
pub fn double(value: i32) -> i32 { return value }
pub fn main() -> i32 { return clamp(double(1), 0, 10) }
`
    const { document, snapshot } = yield* open(source)
    const help = Document.signatureHelp(
      document,
      snapshot,
      positionAt(source, source.indexOf('double(1') + 'double('.length),
    )
    assert.strictEqual(help?.signatures[0]?.label, 'pub fn double(value: i32) -> i32')
    assert.strictEqual(help?.activeParameter, 0)
  }),
)

it.effect('labels struct construction with visible fields and selects the named initializer', () =>
  Effect.gen(function* () {
    const source = `struct Pair<A, B> {
  first: A
  second: B
}

pub fn main() -> i32 {
  let pair = Pair<i32> { first: 1, second: true }
  return pair.first
}
`
    const { document, snapshot } = yield* open(source)
    const help = Document.signatureHelp(
      document,
      snapshot,
      positionAt(source, source.indexOf('second: true') + 'second:'.length),
    )
    assert.strictEqual(help?.signatures[0]?.label, 'struct Pair<A, B> { first: A, second: B }')
    assert.deepEqual(
      help?.signatures[0]?.parameters?.map((parameter) => parameter.label),
      ['first: A', 'second: B'],
    )
    assert.strictEqual(help?.activeParameter, 1)
  }),
)

/** Decodes the protocol's delta encoding back into absolute, readable tokens. */
const decodeSemanticTokens = (tokens: {
  readonly data: ReadonlyArray<number>
}): ReadonlyArray<{
  readonly line: number
  readonly character: number
  readonly length: number
  readonly type: string
}> => {
  const decoded: Array<{
    line: number
    character: number
    length: number
    type: string
  }> = []
  let line = 0
  let character = 0
  for (let index = 0; index + 4 < tokens.data.length; index += 5) {
    const deltaLine = tokens.data[index] ?? 0
    const deltaCharacter = tokens.data[index + 1] ?? 0
    line += deltaLine
    character = deltaLine === 0 ? character + deltaCharacter : deltaCharacter
    decoded.push({
      line,
      character,
      length: tokens.data[index + 2] ?? 0,
      type: Document.semanticTokenTypes[tokens.data[index + 3] ?? 0] ?? 'unknown',
    })
  }
  return decoded
}

const semanticTokenAt = (
  decoded: ReadonlyArray<{
    readonly line: number
    readonly character: number
    readonly length: number
    readonly type: string
  }>,
  source: string,
  spelling: string,
  occurrence = 0,
) => {
  const { line, character } = positionOf(source, spelling, occurrence)
  return decoded.find((token) => token.line === line && token.character === character)
}

it.effect('marks compiler-selected inactive tokens without exposing inactive symbols', () =>
  Effect.gen(function* () {
    const source =
      'static if Intrinsic.targetOperatingSystem() == "darwin" { pub fn active() -> i32 { return 1 } } else { pub fn inactive() -> i32 { return 2 } }'
    const bytes = encoder.encode(source)
    const project = yield* ProjectAnalysis.make(['main'], {
      configuration: {
        profile: { target: 'aarch64-apple-darwin', artifact: 'object', entry: { kind: 'none' } },
      },
    }).pipe(
      Effect.provide(
        SourceResolver.overlay([SourceFile.make('main', bytes)]).pipe(
          Layer.provideMerge(SourceResolver.empty),
        ),
      ),
    )
    const snapshot = ProjectAnalysis.view(project, 'main')
    assert.ok(snapshot)
    const document = Document.make({
      uri: 'file:///project/main.silk',
      version: 1,
      workspace: 'project',
      module: 'main',
      sourceRoot: '/project',
      bytes,
    })
    const tokens = Document.semanticTokens(document, snapshot)
    const decoded = decodeSemanticTokens(tokens)
    const inactive = decoded.findIndex((token) => token.character === source.indexOf('inactive()'))
    const active = decoded.findIndex((token) => token.character === source.indexOf('active()'))
    assert.isAtLeast(inactive, 0)
    assert.isAtLeast(active, 0)
    assert.strictEqual(tokens.data[inactive * 5 + 4], 1)
    assert.strictEqual(tokens.data[active * 5 + 4], 0)
    assert.strictEqual(Analysis.memberByName(snapshot, 'main', 'inactive')._tag, 'Missing')
  }),
)

it.effect('serves shared-pattern bindings through completion hover navigation and tokens', () =>
  Effect.gen(function* () {
    const source = `struct Full { value: i32 }
pub fn main() -> i32 {
  let first = Full { value: 40 }
  let Full { value } = move first
  let second = Full { value: 2 }
  if let Full inner = &second { return value + inner.value } else { return value }
}`
    const { document, snapshot } = yield* open(source)
    assert.deepEqual(
      Document.diagnostics(document, snapshot, () => undefined),
      [],
    )
    const finalUse = positionOf(source, 'value', 6)
    const completion = yield* Document.completion(document, snapshot, {
      ...finalUse,
      character: finalUse.character + 3,
    })
    assert.include(
      completion.items.map((item) => item.label),
      'value',
    )
    const hover = Document.hover(document, snapshot, finalUse)
    assert.include(
      typeof hover?.contents === 'object' && 'value' in hover.contents ? hover.contents.value : '',
      'let value: i32',
    )
    assert.deepEqual(
      Document.definition(document, snapshot, finalUse, () => undefined)?.targetSelectionRange
        .start,
      positionOf(source, 'value', 2),
    )
    const decoded = decodeSemanticTokens(Document.semanticTokens(document, snapshot))
    assert.strictEqual(semanticTokenAt(decoded, source, 'value', 2)?.type, 'variable')
    assert.strictEqual(semanticTokenAt(decoded, source, 'inner', 1)?.type, 'variable')
  }),
)

it.effect('colors a type name and a variable name with different token types', () =>
  Effect.gen(function* () {
    const source = `pub struct Point { x: i32 }
pub fn main() -> i32 {
  let total = 1
  return total
}
`
    const { document, snapshot } = yield* open(source)
    const decoded = decodeSemanticTokens(Document.semanticTokens(document, snapshot))
    const type = semanticTokenAt(decoded, source, 'Point')
    const variable = semanticTokenAt(decoded, source, 'total', 1)
    assert.strictEqual(type?.type, 'type')
    assert.strictEqual(variable?.type, 'variable')
    // The lexer's own kinds carry the rest, so a keyword never depends on a resolved name.
    assert.strictEqual(semanticTokenAt(decoded, source, 'pub')?.type, 'keyword')
    assert.strictEqual(semanticTokenAt(decoded, source, 'main')?.type, 'function')
  }),
)

it.effect('colors one duration literal as a single numeric semantic token', () =>
  Effect.gen(function* () {
    const source = 'pub fn main() -> u64 { return 01h05m00s }'
    const { document, snapshot } = yield* open(source)
    assert.deepEqual(
      Document.diagnostics(document, snapshot, () => undefined),
      [],
    )

    const decoded = decodeSemanticTokens(Document.semanticTokens(document, snapshot))
    const duration = semanticTokenAt(decoded, source, '01h05m00s')
    assert.strictEqual(duration?.type, 'number')
    assert.strictEqual(duration?.length, 9)
  }),
)

it.effect('colors contextual import path segments as namespaces', () =>
  Effect.gen(function* () {
    const source = `import silk.vector { Vector }
import silk.effect { Effect }
effect fn value() -> i32 { return 1 }
`
    const { document, snapshot } = yield* open(source)
    const decoded = decodeSemanticTokens(Document.semanticTokens(document, snapshot))
    assert.strictEqual(semanticTokenAt(decoded, source, 'effect')?.type, 'namespace')
    assert.strictEqual(semanticTokenAt(decoded, source, 'vector')?.type, 'namespace')
    assert.strictEqual(semanticTokenAt(decoded, source, 'effect', 1)?.type, 'keyword')
  }),
)

it.effect('colors only the contextual test qualifier as a keyword', () =>
  Effect.gen(function* () {
    const source = `test fn checked() {}
fn use(test: i32) -> i32 { return test }
`
    const { document, snapshot } = yield* open(source)
    const decoded = decodeSemanticTokens(Document.semanticTokens(document, snapshot))
    assert.strictEqual(semanticTokenAt(decoded, source, 'test')?.type, 'keyword')
    assert.strictEqual(semanticTokenAt(decoded, source, 'test', 1)?.type, 'parameter')
    assert.strictEqual(semanticTokenAt(decoded, source, 'test', 2)?.type, 'parameter')
  }),
)

it.effect('folds a function body from its open brace to its close brace', () =>
  Effect.gen(function* () {
    const source = `pub fn main() -> i32 {
  let total = 1
  return total
}
`
    const { document, snapshot } = yield* open(source)
    assert.deepEqual(
      Document.foldingRanges(document, snapshot).map(({ startLine, endLine }) => ({
        startLine,
        endLine,
      })),
      [{ startLine: 0, endLine: 3 }],
    )
  }),
)

it.effect('folds a run of comment lines as one block', () =>
  Effect.gen(function* () {
    const source = `// first
// second
// third
pub fn main() -> i32 { return 1 }
`
    const { document, snapshot } = yield* open(source)
    assert.deepEqual(Document.foldingRanges(document, snapshot), [
      { startLine: 0, endLine: 2, kind: 'comment' },
    ])
  }),
)

const calleeModule = 'pub fn helper(value: i32) -> i32 { return value }'

it.effect('lists two callers of one function across two modules', () =>
  Effect.gen(function* () {
    const first = 'import helper\npub fn caller() -> i32 { return helper.helper(1) }'
    const second = 'import helper\npub fn main() -> i32 { return helper.helper(3) }'
    const { document, snapshot } = yield* openProject(
      [
        { module: 'helper', text: calleeModule },
        { module: 'caller', text: first },
        { module: 'main', text: second },
      ],
      'helper',
    )
    const prepared = Document.prepareCallHierarchy(
      document,
      snapshot,
      positionOf(calleeModule, 'helper'),
      uriOfModule,
    )
    assert.strictEqual(prepared.length, 1)
    assert.strictEqual(prepared[0]?.name, 'helper')
    assert.strictEqual(prepared[0]?.detail, 'pub fn helper(value: i32) -> i32')
    const item = prepared[0]
    if (item === undefined) throw new Error('prepare produced no item')
    assert.deepEqual(
      Document.incomingCalls(document, snapshot, item, uriOfModule).map(({ from, fromRanges }) => ({
        name: from.name,
        uri: from.uri,
        calls: fromRanges.length,
      })),
      [
        { name: 'caller', uri: uriOfModule('caller'), calls: 1 },
        { name: 'main', uri: uriOfModule('main'), calls: 1 },
      ],
    )
  }),
)

it.effect('places structural answers with the negotiated position encoding', () =>
  Effect.gen(function* () {
    // The comment holds an astral character, which is one UTF-16 surrogate pair and four bytes:
    // a byte-counted column would put every answer after it two columns too far right.
    const source = `// 😀
pub fn helper(value: i32) -> i32 { return value }
pub fn main() -> i32 {
  return helper(1)
}
`
    const { document, snapshot } = yield* open(source)
    const decoded = decodeSemanticTokens(Document.semanticTokens(document, snapshot))
    assert.deepEqual(
      decoded.filter((token) => token.line === 1 && token.type === 'function'),
      // `helper` sits at UTF-16 column 7 of its own line, unshifted by the astral character above.
      [{ line: 1, character: 7, length: 6, type: 'function' }],
    )
    assert.deepEqual(
      Document.foldingRanges(document, snapshot).map(({ startLine, endLine }) => ({
        startLine,
        endLine,
      })),
      [
        { startLine: 0, endLine: 0 },
        { startLine: 1, endLine: 1 },
        { startLine: 2, endLine: 4 },
      ].filter(({ startLine, endLine }) => endLine > startLine),
    )
    const prepared = Document.prepareCallHierarchy(
      document,
      snapshot,
      positionOf(source, 'main'),
      () => undefined,
    )
    const item = prepared[0]
    if (item === undefined) throw new Error('prepare produced no item')
    assert.deepEqual(
      Document.outgoingCalls(document, snapshot, item, () => undefined).map(
        ({ to, fromRanges }) => ({ name: to.name, ranges: fromRanges }),
      ),
      [
        {
          name: 'helper',
          ranges: [{ start: { line: 3, character: 9 }, end: { line: 3, character: 15 } }],
        },
      ],
    )
  }),
)

it.effect('lists the functions one function calls', () =>
  Effect.gen(function* () {
    const source = `pub fn helper(value: i32) -> i32 { return value }
pub fn double(value: i32) -> i32 { return value }
pub fn main() -> i32 { return helper(1) + double(2) + helper(3) }
`
    const { document, snapshot } = yield* open(source)
    const prepared = Document.prepareCallHierarchy(
      document,
      snapshot,
      positionOf(source, 'main'),
      () => undefined,
    )
    const item = prepared[0]
    if (item === undefined) throw new Error('prepare produced no item')
    assert.deepEqual(
      Document.outgoingCalls(document, snapshot, item, () => undefined).map(
        ({ to, fromRanges }) => ({ name: to.name, calls: fromRanges.length }),
      ),
      [
        { name: 'helper', calls: 2 },
        { name: 'double', calls: 1 },
      ],
    )
  }),
)

it.effect('shows retained generic requirements outside the hover source signature', () =>
  Effect.gen(function* () {
    const source = `effect<'env> fn retain<T: 'env, 'env>(value: T) -> i32 { return 0 }
fn hold<T>(value: T) -> i32 {
  let pending = retain(move value)
  drop pending
  return 0
}`
    const { document, snapshot } = yield* open(source)
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    const hover = Document.hover(document, snapshot, positionOf(source, 'pending'))
    const markdown = hover?.contents
    assert.isTrue(typeof markdown === 'object' && 'value' in markdown)
    if (typeof markdown !== 'object' || !('value' in markdown)) return
    assert.match(markdown.value, /```\n\nLifetime requirements: `T: '[^`]+`\./)
  }),
)
