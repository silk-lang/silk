import * as Option from 'effect/Option'
import type * as Diagnostic from './Diagnostic.js'
import * as SourceFile from './SourceFile.js'
import * as SyntaxTree from './SyntaxTree.js'
import type * as Token from './Token.js'

/** A deterministic identity for one syntax element within its owning artifact. */
export interface SyntaxId {
  readonly _tag: 'SyntaxId'
  readonly sourceId: string
  readonly ordinal: number
}

/**
 * The per-module lossless syntax artifact: source bytes, trivia-preserving token stream,
 * source-faithful surface tree, and both frontend diagnostic collections.
 */
export interface SyntaxFile {
  readonly _tag: 'SyntaxFile'
  readonly source: SourceFile.SourceFile
  readonly tokens: ReadonlyArray<Token.Token>
  readonly root: SyntaxTree.Node
  readonly lexicalDiagnostics: ReadonlyArray<Diagnostic.Diagnostic>
  readonly parserDiagnostics: ReadonlyArray<Diagnostic.Diagnostic>
}

/** Bundles one parsed module into its immutable artifact. */
export const make = (
  source: SourceFile.SourceFile,
  tokens: ReadonlyArray<Token.Token>,
  root: SyntaxTree.Node,
  lexicalDiagnostics: ReadonlyArray<Diagnostic.Diagnostic>,
  parserDiagnostics: ReadonlyArray<Diagnostic.Diagnostic>,
): SyntaxFile => ({
  _tag: 'SyntaxFile',
  source,
  tokens,
  root,
  lexicalDiagnostics,
  parserDiagnostics,
})

const identityCache = new WeakMap<SyntaxFile, Map<SyntaxTree.Element, number>>()

const collect = (element: SyntaxTree.Element, ordinals: Map<SyntaxTree.Element, number>): void => {
  ordinals.set(element, ordinals.size)
  if (SyntaxTree.isNode(element)) {
    for (const child of element.children) collect(child, ordinals)
  }
}

const ordinals = (self: SyntaxFile): Map<SyntaxTree.Element, number> => {
  const cached = identityCache.get(self)
  if (cached !== undefined) return cached
  const built = new Map<SyntaxTree.Element, number>()
  collect(self.root, built)
  identityCache.set(self, built)
  return built
}

/**
 * Returns the deterministic identity of one element of this artifact: the element's pre-order
 * position in the surface tree, qualified by the source identity. Foreign elements answer `None`.
 */
export const idOf = (self: SyntaxFile, element: SyntaxTree.Element): Option.Option<SyntaxId> => {
  const ordinal = ordinals(self).get(element)
  return ordinal === undefined
    ? Option.none()
    : Option.some({ _tag: 'SyntaxId' as const, sourceId: self.source.id, ordinal })
}

const isPrintable = (byte: number): boolean => byte >= 0x20 && byte <= 0x7e

const escapeBytes = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => {
    if (byte === 0x22 || byte === 0x5c) {
      return `\\${String.fromCharCode(byte)}`
    }
    if (isPrintable(byte)) {
      return String.fromCharCode(byte)
    }
    return `\\x${byte.toString(16).toUpperCase().padStart(2, '0')}`
  }).join('')

const sliceOf = (self: SyntaxFile, span: Token.Token['span']): string => {
  const bytes = Option.getOrThrowWith(
    SourceFile.slice(self.source, span),
    () => new RangeError(`Syntax encoder span does not belong to source ${self.source.id}`),
  )
  return escapeBytes(bytes)
}

const spanText = (span: Token.Token['span']): string => `[${span.start}, ${span.end})`

const encodeElement = (self: SyntaxFile, element: SyntaxTree.Element, depth: number): string => {
  const indent = '  '.repeat(depth)
  if (SyntaxTree.isMissingToken(element)) {
    return `${indent}missing ${element.expected} ${spanText(element.span)}`
  }
  if (SyntaxTree.isToken(element)) {
    return `${indent}token ${element.kind} ${spanText(element.span)} "${sliceOf(self, element.span)}"`
  }
  return [
    `${indent}${element.kind} ${spanText(element.span)}`,
    ...element.children.map((child) => encodeElement(self, child, depth + 1)),
  ].join('\n')
}

const encodeDiagnostics = (
  label: string,
  diagnostics: ReadonlyArray<Diagnostic.Diagnostic>,
): ReadonlyArray<string> =>
  diagnostics.map((diagnostic) => `  ${label} ${diagnostic.code} ${spanText(diagnostic.span)}`)

/**
 * Deterministic textual encoding of a completed artifact for debugging, inspection, and golden
 * tests. Identical input bytes with identical source identity encode byte-identically. No
 * compatibility promise attaches to this format.
 */
export const encode = (self: SyntaxFile): string =>
  [
    `syntax-file ${self.source.id} bytes=${self.source.bytes.length}`,
    'tokens:',
    ...self.tokens.map(
      (token, ordinal) =>
        `  ${ordinal} ${token.kind} ${spanText(token.span)} "${sliceOf(self, token.span)}"`,
    ),
    'tree:',
    encodeElement(self, self.root, 1),
    'diagnostics:',
    ...encodeDiagnostics('lexical', self.lexicalDiagnostics),
    ...encodeDiagnostics('parser', self.parserDiagnostics),
    '',
  ].join('\n')
