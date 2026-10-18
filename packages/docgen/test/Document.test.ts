import { assert, it } from '@effect/vitest'
import * as Analysis from '@silklang/compiler/Analysis'
import * as Effect from 'effect/Effect'
import * as Document from '../src/Document.js'

const encode = (value: string): Uint8Array => new TextEncoder().encode(value)

it.effect(
  'parses CommonMark, examples, links, and source provenance without compiler coupling',
  () =>
    Effect.gen(function* () {
      const source = `/// Recovers a [\`Problem\`] with **care**.
///
/// # Examples
/// \`\`\`silk
/// recover(problem)
/// \`\`\`
pub fn recover(problem: Problem) -> i32 { return problem.code }
`
      const snapshot = yield* Analysis.ofSource('docs/main', encode(source))
      const headers = Analysis.declarationIndex(snapshot).modules.at(0)
      const declaration = headers?.declarations.at(0)
      assert.isDefined(declaration)
      const raw = Analysis.documentationOfAnchor(snapshot, declaration.anchor)
      assert.isDefined(raw)
      const sourceFile = Analysis.sources(snapshot).get('docs/main')
      assert.isDefined(sourceFile)

      const parsed = Document.parse(sourceFile, raw)
      assert.strictEqual(parsed.fallback, false)
      assert.strictEqual(parsed.examples.length, 1)
      assert.strictEqual(parsed.examples[0]?.language, 'silk')
      assert.strictEqual(parsed.examples[0]?.code, 'recover(problem)')
      assert.strictEqual(parsed.source.sourceId, 'docs/main')
      assert.match(Document.toMarkdown(parsed), /`Problem`/)
      assert.match(Document.toMarkdown(parsed), /# Examples/)
    }),
)

it.effect('treats incomplete Markdown as documentation instead of a diagnostic', () =>
  Effect.gen(function* () {
    const source = `/// This **never closes and [neither does this
pub fn recover() -> i32 { return 1 }
`
    const snapshot = yield* Analysis.ofSource('malformed/main', encode(source))
    const declaration = Analysis.declarationIndex(snapshot).modules.at(0)?.declarations.at(0)
    assert.isDefined(declaration)
    const raw = Analysis.documentationOfAnchor(snapshot, declaration.anchor)
    const sourceFile = Analysis.sources(snapshot).get('malformed/main')
    assert.isDefined(raw)
    assert.isDefined(sourceFile)

    const parsed = Document.parse(sourceFile, raw)
    assert.match(Document.toMarkdown(parsed), /never closes/)
  }),
)

it.effect('renders intra-doc symbol references as inline code for editor hover', () =>
  Effect.gen(function* () {
    const source = `/// Uses [\`Problem\`] and [\`Missing\`].
pub fn recover(problem: Problem) -> i32 { return problem.code }

pub struct Problem { pub code: i32 }
`
    const snapshot = yield* Analysis.ofSource('links/main', encode(source))
    const declaration = Analysis.declarationIndex(snapshot).modules.at(0)?.declarations.at(0)
    assert.isDefined(declaration)
    const raw = Analysis.documentationOfAnchor(snapshot, declaration.anchor)
    const sourceFile = Analysis.sources(snapshot).get('links/main')
    assert.isDefined(raw)
    assert.isDefined(sourceFile)
    const documentation = Document.parse(sourceFile, raw)
    const paragraph = documentation.blocks.at(0)
    assert.strictEqual(paragraph?._tag, 'Paragraph')
    if (paragraph?._tag !== 'Paragraph') return
    const links = paragraph.children.filter((child) => child._tag === 'SymbolLink')
    assert.strictEqual(links.length, 2)
    assert.strictEqual(links[0]?.spelling, 'Problem')
    assert.strictEqual(links[1]?.spelling, 'Missing')
    assert.match(Document.toMarkdown(documentation), /`Problem`/)
    assert.match(Document.toMarkdown(documentation), /`Missing`/)
  }),
)
