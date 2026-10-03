import * as Option from 'effect/Option'
import * as Diagnostic from '../Diagnostic.js'
import type * as Lexer from '../Lexer.js'
import * as SyntaxTree from '../SyntaxTree.js'
import * as Token from '../Token.js'

export interface State {
  readonly lexical: Lexer.LexicalResult
  readonly index: number
  readonly diagnostics: ReadonlyArray<Diagnostic.Diagnostic>
  readonly recovering: boolean
  /** Parent expression depth retained while parsing ordinary statements inside a match arm. */
  readonly expressionDepth?: number
}

export interface ElementsResult {
  readonly state: State
  readonly elements: ReadonlyArray<SyntaxTree.Element>
}

export interface NodeResult {
  readonly state: State
  readonly node: SyntaxTree.Node
}

export const isTrivia = (kind: Token.TokenKind): boolean =>
  kind === 'Whitespace' ||
  kind === 'LineComment' ||
  kind === 'DocComment' ||
  kind === 'ModuleDocComment'

export const currentToken = (state: State): Token.Token | undefined =>
  state.lexical.tokens.at(state.index)

export const nextSignificantKind = (state: State): Token.TokenKind | undefined => {
  let index = state.index
  let token = state.lexical.tokens.at(index)

  while (token !== undefined && isTrivia(token.kind)) {
    index += 1
    token = state.lexical.tokens.at(index)
  }

  return token?.kind
}

/** Peeks past trivia by a zero-based number of significant tokens. */
export const peek = (state: State, significantCount: number): Token.TokenKind | undefined => {
  let index = state.index
  let remaining = significantCount
  while (index < state.lexical.tokens.length) {
    const token = state.lexical.tokens.at(index)
    if (token === undefined) return undefined
    index += 1
    if (isTrivia(token.kind)) continue
    if (remaining === 0) return token.kind
    remaining -= 1
  }
  return undefined
}

export const advance = (state: State): State => ({
  ...state,
  index: state.index + 1,
})

/** Advances to a previously scanned token index with one immutable state update. */
export const advanceTo = (state: State, index: number): State => ({
  ...state,
  index,
})

export const addDiagnostic = (state: State, diagnostic: Diagnostic.Diagnostic): State =>
  state.recovering
    ? state
    : {
        ...state,
        diagnostics: [...state.diagnostics, diagnostic],
        recovering: true,
      }

export const synchronize = (state: State): State =>
  !state.recovering
    ? state
    : {
        ...state,
        recovering: false,
      }

export const insertionOffset = (state: State): number =>
  currentToken(state)?.span.start ?? state.lexical.source.bytes.length

export const syntaxNode = (
  state: State,
  kind: SyntaxTree.NodeKind,
  children: ReadonlyArray<SyntaxTree.Element>,
): SyntaxTree.Node =>
  Option.getOrThrowWith(
    SyntaxTree.make(state.lexical.source, kind, children, insertionOffset(state)),
    () => new RangeError(`Parser produced invalid ordered children for ${kind}`),
  )

export const missingToken = (state: State, expected: Token.TokenKind): SyntaxTree.MissingToken =>
  Option.getOrThrowWith(
    SyntaxTree.missingToken(state.lexical.source, expected, insertionOffset(state)),
    () => new RangeError(`Parser produced an invalid insertion position for ${expected}`),
  )

export const consumeTrivia = (initial: State): ElementsResult => {
  let state = initial
  let elements: ReadonlyArray<SyntaxTree.Element> = []
  let token = currentToken(state)

  while (token !== undefined && isTrivia(token.kind)) {
    elements = [...elements, token]
    state = advance(state)
    token = currentToken(state)
  }

  return { state, elements }
}

const isSynchronizationKind = (
  kind: Token.TokenKind,
  expected: Token.TokenKind,
  following: ReadonlyArray<Token.TokenKind>,
): boolean => kind === expected || kind === 'EndOfFile' || following.includes(kind)

export const expect = (
  initial: State,
  expected: Token.TokenKind,
  following: ReadonlyArray<Token.TokenKind>,
): ElementsResult => {
  const leading = consumeTrivia(initial)
  let state = leading.state
  let elements = leading.elements
  let token = currentToken(state)

  if (token?.kind === expected) {
    return {
      state: synchronize(advance(state)),
      elements: [...elements, token],
    }
  }

  let unexpected: ReadonlyArray<Token.Token> = []
  while (token !== undefined && !isSynchronizationKind(token.kind, expected, following)) {
    unexpected = [...unexpected, token]
    state = advance(state)
    token = currentToken(state)
  }

  if (unexpected.length > 0) {
    const error = syntaxNode(state, 'Error', unexpected)
    state = addDiagnostic(
      state,
      Diagnostic.unexpectedTokens(
        unexpected.map((item) => item.kind),
        'syntax',
        [Token.describe(expected)],
        error.span,
      ),
    )
    elements = [...elements, error]
  }

  if (token?.kind === expected) {
    return {
      state: synchronize(advance(state)),
      elements: [...elements, token],
    }
  }

  const missing = missingToken(state, expected)
  return {
    state: addDiagnostic(state, Diagnostic.missingToken(expected, missing.span)),
    elements: [...elements, missing],
  }
}
