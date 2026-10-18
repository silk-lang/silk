import * as Option from 'effect/Option'
import type * as SourceFile from './SourceFile.js'
import * as SourceSpan from './SourceSpan.js'
import type * as SyntaxFile from './SyntaxFile.js'
import * as SyntaxTree from './SyntaxTree.js'
import type * as Token from './Token.js'

export type Kind = 'Declaration' | 'Module'

/** One source-owned block of attached documentation comments, before Markdown interpretation. */
export interface DocBlock {
  readonly _tag: 'DocBlock'
  readonly kind: Kind
  readonly comments: ReadonlyArray<Token.Token>
  readonly span: SourceSpan.SourceSpan
}

const documentableKinds: ReadonlySet<SyntaxTree.NodeKind> = new Set([
  'StructDeclaration',
  'EnumDeclaration',
  'UnionDeclaration',
  'ServiceDeclaration',
  'InterfaceDeclaration',
  'RoleDeclaration',
  'ConstantDeclaration',
  'PackageParameterDeclaration',
  'TypeAliasDeclaration',
  'ImplDeclaration',
  'FunctionDeclaration',
  'ForeignFunctionDeclaration',
  'StructField',
  'EnumMember',
  'UnionVariant',
  'UnionVariantField',
  'TypeParameter',
  'ParameterDeclaration',
  'ServiceOperation',
  'ImplOperation',
])

/** Tests whether one concrete-syntax kind participates in Silk's documentation model. */
export const isDocumentableKind = (kind: SyntaxTree.NodeKind): boolean =>
  documentableKinds.has(kind)

const isTrivia = (token: Token.Token): boolean =>
  token.kind === 'Whitespace' ||
  token.kind === 'LineComment' ||
  token.kind === 'DocComment' ||
  token.kind === 'ModuleDocComment'

const lineBreaks = (source: SourceFile.SourceFile, token: Token.Token): number => {
  let count = 0
  let index = token.span.start
  while (index < token.span.end) {
    const byte = source.bytes[index]
    if (byte === 0x0d) {
      count += 1
      if (source.bytes[index + 1] === 0x0a) index += 1
    } else if (byte === 0x0a) {
      count += 1
    }
    index += 1
  }
  return count
}

const startsLine = (source: SourceFile.SourceFile, token: Token.Token): boolean => {
  let index = token.span.start
  while (index > 0) {
    const byte = source.bytes[index - 1]
    if (byte === 0x0a || byte === 0x0d) return true
    if (byte !== 0x20 && byte !== 0x09) return false
    index -= 1
  }
  return true
}

const make = (
  source: SourceFile.SourceFile,
  kind: Kind,
  comments: ReadonlyArray<Token.Token>,
): DocBlock => {
  const first = comments.at(0)
  const last = comments.at(-1)
  if (first === undefined || last === undefined)
    throw new RangeError('DocBlock requires at least one documentation comment')
  const span = Option.getOrThrowWith(
    SourceSpan.make(source, first.span.start, last.span.end),
    () => new RangeError('DocBlock comments do not belong to one source'),
  )
  return {
    _tag: 'DocBlock' as const,
    kind,
    comments: Array.from(comments),
    span,
  }
}

const attachedAtEnd = (
  source: SourceFile.SourceFile,
  leading: ReadonlyArray<Token.Token>,
  kind: Kind,
): DocBlock | undefined => {
  const commentKind = kind === 'Declaration' ? 'DocComment' : 'ModuleDocComment'
  let index = leading.length - 1
  const trailing = leading[index]
  if (trailing?.kind !== 'Whitespace' || lineBreaks(source, trailing) !== 1) return undefined
  index -= 1
  const last = leading[index]
  if (last?.kind !== commentKind || !startsLine(source, last)) return undefined
  const comments: Array<Token.Token> = [last]
  index -= 1
  while (index >= 1) {
    const whitespace = leading[index]
    const comment = leading[index - 1]
    if (whitespace?.kind !== 'Whitespace' || lineBreaks(source, whitespace) !== 1) break
    if (comment?.kind !== commentKind) break
    if (!startsLine(source, comment)) return undefined
    comments.unshift(comment)
    index -= 2
  }
  return make(source, kind, comments)
}

const directLeadingTrivia = (node: SyntaxTree.Node): ReadonlyArray<Token.Token> => {
  const leading: Array<Token.Token> = []
  for (const child of node.children) {
    if (SyntaxTree.isToken(child)) {
      if (!isTrivia(child)) break
      leading.push(child)
      continue
    }
    if (leading.length === 0 && SyntaxTree.isNode(child)) {
      leading.push(...directLeadingTrivia(child))
    }
    break
  }
  return leading
}

const moduleAtStart = (
  source: SourceFile.SourceFile,
  leading: ReadonlyArray<Token.Token>,
): DocBlock | undefined => {
  const first = leading.at(0)
  if (first?.kind !== 'ModuleDocComment' || !startsLine(source, first)) return undefined
  const comments: Array<Token.Token> = [first]
  let index = 1
  while (index + 1 < leading.length) {
    const whitespace = leading[index]
    const comment = leading[index + 1]
    if (whitespace?.kind !== 'Whitespace' || lineBreaks(source, whitespace) !== 1) break
    if (comment?.kind !== 'ModuleDocComment') break
    if (!startsLine(source, comment)) return undefined
    comments.push(comment)
    index += 2
  }
  return make(source, 'Module', comments)
}

/** Returns the raw `///` block immediately attached to one declaration-like syntax node. */
export const ofNode = (
  syntax: SyntaxFile.SyntaxFile,
  node: SyntaxTree.Node,
): DocBlock | undefined =>
  isDocumentableKind(node.kind) && node.span.sourceId === syntax.source.id
    ? attachedAtEnd(syntax.source, directLeadingTrivia(node), 'Declaration')
    : undefined

/** Returns the leading raw `//!` block attached to the source module. */
export const ofModule = (syntax: SyntaxFile.SyntaxFile): DocBlock | undefined => {
  const leading: Array<Token.Token> = []
  for (const token of syntax.tokens) {
    if (!isTrivia(token)) break
    leading.push(token)
  }
  return moduleAtStart(syntax.source, leading)
}

/** Returns every source-owned documentation block in physical source order. */
export const all = (syntax: SyntaxFile.SyntaxFile): ReadonlyArray<DocBlock> => {
  const blocks: Array<DocBlock> = []
  const module = ofModule(syntax)
  if (module !== undefined) blocks.push(module)

  const visit = (node: SyntaxTree.Node): void => {
    if (isDocumentableKind(node.kind)) {
      const block = ofNode(syntax, node)
      if (block !== undefined) blocks.push(block)
    }
    for (const child of node.children) if (SyntaxTree.isNode(child)) visit(child)
  }
  visit(syntax.root)

  const seen = new Set<string>()
  return blocks
    .sort((left, right) => left.span.start - right.span.start || left.span.end - right.span.end)
    .filter((block) => {
      const key = `${block.span.sourceId}:${block.span.start}:${block.span.end}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}
