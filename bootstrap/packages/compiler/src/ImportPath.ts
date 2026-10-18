import type * as AuthoredHir from './AuthoredHir.js'
import * as SemanticContext from './SemanticContext.js'
import type * as SourceFile from './SourceFile.js'
import type * as SyntaxTree from './SyntaxTree.js'
import type * as Token from './Token.js'

/**
 * Contextual keywords a source module may still spell as an import-path segment. Authored paths
 * retain the exact spelling and syntax paths retain the token kind, so both views derive from one
 * table.
 */
const reservedSegments: ReadonlyArray<readonly [string, Token.TokenKind]> = [
  ['pub', 'PubKeyword'],
  ['struct', 'StructKeyword'],
  ['enum', 'EnumKeyword'],
  ['union', 'UnionKeyword'],
  ['type', 'TypeKeyword'],
  ['service', 'ServiceKeyword'],
  ['interface', 'InterfaceKeyword'],
  ['role', 'RoleKeyword'],
  ['effect', 'EffectKeyword'],
  ['fn', 'FnKeyword'],
  ['run', 'RunKeyword'],
  ['fail', 'FailKeyword'],
  ['drop', 'DropKeyword'],
  ['unsafe', 'UnsafeKeyword'],
  ['impl', 'ImplKeyword'],
  ['for', 'ForKeyword'],
  ['return', 'ReturnKeyword'],
  ['import', 'ImportKeyword'],
  ['as', 'AsKeyword'],
  ['let', 'LetKeyword'],
  ['const', 'ConstKeyword'],
  ['mut', 'MutKeyword'],
  ['once', 'OnceKeyword'],
  ['move', 'MoveKeyword'],
  ['match', 'MatchKeyword'],
  ['if', 'IfKeyword'],
  ['else', 'ElseKeyword'],
  ['while', 'WhileKeyword'],
  ['break', 'BreakKeyword'],
  ['continue', 'ContinueKeyword'],
  ['true', 'TrueKeyword'],
  ['false', 'FalseKeyword'],
]

const reservedSegmentKinds: ReadonlySet<Token.TokenKind> = new Set(
  reservedSegments.map(([, kind]) => kind),
)

const reservedSpellings: ReadonlySet<string> = new Set(
  reservedSegments.map(([spelling]) => spelling),
)

/** Tests whether a token kind can name one contextual import-path segment. */
export const isSegmentKind = (kind: Token.TokenKind): boolean =>
  kind === 'Identifier' || reservedSegmentKinds.has(kind)

/** Tests whether a contextual path segment is unavailable as an ordinary source binding. */
export const isReservedSegment = (token: Token.Token): boolean => token.kind !== 'Identifier'

/** Returns the ordered contextual segment tokens retained by an import-path node. */
export const segments = (self: SyntaxTree.Node): ReadonlyArray<Token.Token> =>
  self.children.filter(
    (element): element is Token.Token => element._tag === 'Token' && isSegmentKind(element.kind),
  )

const decoder = new TextDecoder()

const tokenText = (source: SourceFile.SourceFile, token: Token.Token): string =>
  decoder.decode(source.bytes.slice(token.span.start, token.span.end))

/** Renders a syntax import path as source spells it; source-edit tooling only. */
export const spelling = (
  source: SourceFile.SourceFile,
  path: SyntaxTree.Node,
): string | undefined => {
  const pathSegments = segments(path)
  if (pathSegments.length === 0) return undefined
  return pathSegments.map((segment) => tokenText(source, segment)).join('.')
}

/** Renders a syntax import path as a canonical module identity; source-edit tooling only. */
export const canonicalTarget = (
  source: SourceFile.SourceFile,
  path: SyntaxTree.Node,
): string | undefined => {
  const pathSegments = segments(path)
  if (pathSegments.length === 0) return undefined
  return pathSegments.map((segment) => tokenText(source, segment)).join('/')
}

/**
 * The spellings of every authored import-path segment, or `undefined` when any segment is
 * missing. An authored path is complete or unavailable; a partially spelled path names no module.
 */
export const authoredSegments = (
  context: SemanticContext.SemanticContext,
  path: AuthoredHir.Path,
): ReadonlyArray<string> | undefined => {
  if (path.segments.length === 0) return undefined
  const spellings: Array<string> = []
  for (const segment of path.segments) {
    const text = SemanticContext.nameText(context, segment)
    if (text === undefined) return undefined
    spellings.push(text)
  }
  return spellings
}

/** Renders one authored import path exactly as source modules spell it (segments joined by "."). */
export const authoredSpelling = (
  context: SemanticContext.SemanticContext,
  path: AuthoredHir.Path,
): string | undefined => authoredSegments(context, path)?.join('.')

/** Renders one authored import path as the resolver's canonical identity (joined by "/"). */
export const authoredTarget = (
  context: SemanticContext.SemanticContext,
  path: AuthoredHir.Path,
): string | undefined => authoredSegments(context, path)?.join('/')

/**
 * Whether an authored segment spelling is unavailable as an ordinary source binding. Authored
 * names retain their exact spelling, so a contextual keyword is recognized by spelling alone.
 */
export const isReservedSpelling = (spelling: string): boolean => reservedSpellings.has(spelling)
