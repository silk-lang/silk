import type * as Diagnostic from './Diagnostic.js'
import type { State } from './internal/ParseState.js'
import { expect, nextSignificantKind, syntaxNode } from './internal/ParseState.js'
import type * as Lexer from './Lexer.js'
import { parseTopLevelDeclaration } from './Parser/Declaration.js'
import * as SyntaxFile from './SyntaxFile.js'
import type * as SyntaxTree from './SyntaxTree.js'

const compareDiagnostics = (left: Diagnostic.Diagnostic, right: Diagnostic.Diagnostic): number => {
  const spanOrder = left.span.start - right.span.start || left.span.end - right.span.end
  if (spanOrder !== 0) return spanOrder
  if (left.code < right.code) return -1
  if (left.code > right.code) return 1
  return 0
}

/** Parses zero or more bootstrap declarations with lossless local recovery. */
export const parse = (lexical: Lexer.LexicalResult): SyntaxFile.SyntaxFile => {
  const initial: State = {
    lexical,
    index: 0,
    diagnostics: [],
    recovering: false,
  }
  let state = initial
  let declarations: ReadonlyArray<SyntaxTree.Node> = []
  let significantKind = nextSignificantKind(state)

  while (significantKind !== undefined && significantKind !== 'EndOfFile') {
    const declaration = parseTopLevelDeclaration(state)
    declarations = [...declarations, declaration.node]
    state = declaration.state
    significantKind = nextSignificantKind(state)
  }

  const endOfFile = expect(state, 'EndOfFile', [])
  const root = syntaxNode(endOfFile.state, 'SourceFile', [...declarations, ...endOfFile.elements])

  return SyntaxFile.make(
    lexical.source,
    lexical.tokens,
    root,
    lexical.diagnostics,
    [...endOfFile.state.diagnostics].sort(compareDiagnostics),
  )
}
