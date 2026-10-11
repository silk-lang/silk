import { assert, it } from '@effect/vitest'
import { unreachable } from '../../../test/support/raise.js'
import * as DocBlock from '../src/DocBlock.js'
import * as Lexer from '../src/Lexer.js'
import * as Parser from '../src/Parser.js'
import * as SourceFile from '../src/SourceFile.js'
import * as SyntaxTree from '../src/SyntaxTree.js'

const encoder = new TextEncoder()

const parse = (source: string) =>
  Parser.parse(Lexer.lex(SourceFile.make('memory://documentation.silk', encoder.encode(source))))

const descendants = (node: SyntaxTree.Node): ReadonlyArray<SyntaxTree.Node> => [
  node,
  ...node.children.flatMap((child): ReadonlyArray<SyntaxTree.Node> =>
    SyntaxTree.isNode(child) ? descendants(child) : [],
  ),
]

const node = (syntax: ReturnType<typeof parse>, kind: SyntaxTree.NodeKind, occurrence = 0) =>
  descendants(syntax.root)
    .filter((candidate) => candidate.kind === kind)
    .at(occurrence)

const requiredNode = (
  syntax: ReturnType<typeof parse>,
  kind: SyntaxTree.NodeKind,
  occurrence = 0,
): SyntaxTree.Node => node(syntax, kind, occurrence) ?? unreachable(`expected ${kind}`)

const spellings = (block: DocBlock.DocBlock | undefined, source: string) =>
  block?.comments.map((comment) => source.slice(comment.span.start, comment.span.end))

it('attaches raw module and declaration documentation at every declaration level', () => {
  const source = `//! Recovery operations.
//! Shared by the complete module.
import silk.allocator { Allocator }
import silk.allocator { SystemAllocator }
/// A problem.
pub struct Problem {
  /// Numeric code.
  pub code: i32
}
/// One recovery state.
pub enum State {
  /// The operation can start.
  Ready
}
/// Recovers a problem.
pub effect fn recover(
  /// Problem to inspect.
  problem: Problem,
) -> i32 {
  return problem.code
}
impl Allocator for SystemAllocator {
  /// Allocation operation.
  allocate: SystemAllocator.allocate
}
/// Inherent members of a problem.
impl Problem {
  /// Reads the numeric code.
  pub fn code(self: &Self) -> i32 { return self.code }
}
`
  const syntax = parse(source)

  assert.deepEqual(spellings(DocBlock.ofModule(syntax), source), [
    '//! Recovery operations.',
    '//! Shared by the complete module.',
  ])
  assert.deepEqual(
    spellings(DocBlock.ofNode(syntax, requiredNode(syntax, 'StructDeclaration')), source),
    ['/// A problem.'],
  )
  assert.deepEqual(
    spellings(DocBlock.ofNode(syntax, requiredNode(syntax, 'StructField')), source),
    ['/// Numeric code.'],
  )
  assert.deepEqual(
    spellings(DocBlock.ofNode(syntax, requiredNode(syntax, 'EnumDeclaration')), source),
    ['/// One recovery state.'],
  )
  assert.deepEqual(spellings(DocBlock.ofNode(syntax, requiredNode(syntax, 'EnumMember')), source), [
    '/// The operation can start.',
  ])
  assert.deepEqual(
    spellings(DocBlock.ofNode(syntax, requiredNode(syntax, 'FunctionDeclaration')), source),
    ['/// Recovers a problem.'],
  )
  assert.deepEqual(
    spellings(DocBlock.ofNode(syntax, requiredNode(syntax, 'ParameterDeclaration')), source),
    ['/// Problem to inspect.'],
  )
  assert.deepEqual(
    spellings(DocBlock.ofNode(syntax, requiredNode(syntax, 'ImplOperation')), source),
    ['/// Allocation operation.'],
  )
  assert.deepEqual(
    spellings(DocBlock.ofNode(syntax, requiredNode(syntax, 'ImplDeclaration', 1)), source),
    ['/// Inherent members of a problem.'],
  )
  assert.deepEqual(
    spellings(DocBlock.ofNode(syntax, requiredNode(syntax, 'FunctionDeclaration', 1)), source),
    ['/// Reads the numeric code.'],
  )
})

it('does not attach across blank lines or ordinary comments', () => {
  const blank = parse('/// separated\n\nfn answer() -> i32 { return 42 }')
  const ordinary = parse('/// separated\n// note\nfn answer() -> i32 { return 42 }')

  assert.isUndefined(DocBlock.ofNode(blank, requiredNode(blank, 'FunctionDeclaration')))
  assert.isUndefined(DocBlock.ofNode(ordinary, requiredNode(ordinary, 'FunctionDeclaration')))
})

it('inventories only documentable blocks in physical source order', () => {
  const source = `//! Module docs.
/// Struct docs.
pub struct Box<
  /// Type parameter docs.
  T,
> {
  /// Field docs.
  pub value: T
}
/// Function docs.
pub fn unwrap(
  /// Value parameter docs.
  box: Box<i32>,
) -> i32 {
  /// Statement-local docs are not API documentation.
  let value = box.value
  return value
}
/// Interface docs.
interface Read {
  /// Service operation docs.
  fn read() -> i32
}
/// Conformance docs.
impl Read for Box<i32> {
  /// Implementation operation docs.
  read: unwrap
}
/// Unattached docs.

pub const answer: i32 = 42
//! Nonleading module-like trivia.
pub const next: i32 = 43
pub const trailing: i32 = 44 /// \`\`\`silk
/// pub fn injected()->i32{return 1}
/// \`\`\`
pub const afterTrailing: i32 = 45
`
  const syntax = parse(source)
  assert.deepEqual(
    DocBlock.all(syntax).map((block) => spellings(block, source)),
    [
      ['//! Module docs.'],
      ['/// Struct docs.'],
      ['/// Type parameter docs.'],
      ['/// Field docs.'],
      ['/// Function docs.'],
      ['/// Value parameter docs.'],
      ['/// Interface docs.'],
      ['/// Service operation docs.'],
      ['/// Conformance docs.'],
      ['/// Implementation operation docs.'],
    ],
  )
  assert.isUndefined(DocBlock.ofNode(syntax, requiredNode(syntax, 'BindingStatement')))
})
