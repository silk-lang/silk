import * as Option from 'effect/Option'
import * as Diagnostic from '../Diagnostic.js'
import * as ImportPath from '../ImportPath.js'
import type { ElementsResult, NodeResult, State } from '../internal/ParseState.js'
import {
  addDiagnostic,
  advance,
  consumeTrivia,
  currentToken,
  expect,
  missingToken,
  nextSignificantKind,
  peek,
  synchronize,
  syntaxNode,
} from '../internal/ParseState.js'
import * as SourceFile from '../SourceFile.js'
import type * as SyntaxTree from '../SyntaxTree.js'
import type * as Token from '../Token.js'
import { topLevelFollowing } from './Grammar.js'

export const expectImportPathSegment = (
  initial: State,
  following: ReadonlyArray<Token.TokenKind>,
  afterDot: boolean,
): ElementsResult => {
  const leading = consumeTrivia(initial)
  let state = leading.state
  let elements = leading.elements
  let token = currentToken(state)

  const isAcceptedSegment = (candidate: Token.Token): boolean =>
    ImportPath.isSegmentKind(candidate.kind) &&
    (afterDot ||
      !following.includes(candidate.kind) ||
      ['Dot', 'AsKeyword', 'LeftBrace', 'EndOfFile'].includes(peek(state, 1) ?? 'EndOfFile'))

  if (token !== undefined && isAcceptedSegment(token)) {
    return {
      state: synchronize(advance(state)),
      elements: [...elements, token],
    }
  }

  let unexpected: ReadonlyArray<Token.Token> = []
  while (
    token !== undefined &&
    token.kind !== 'EndOfFile' &&
    !isAcceptedSegment(token) &&
    !following.includes(token.kind)
  ) {
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
        ['module path segment'],
        error.span,
      ),
    )
    elements = [...elements, error]
  }

  if (token !== undefined && isAcceptedSegment(token)) {
    return {
      state: synchronize(advance(state)),
      elements: [...elements, token],
    }
  }

  const missing = missingToken(state, 'Identifier')
  return {
    state: addDiagnostic(state, Diagnostic.missingToken('Identifier', missing.span)),
    elements: [...elements, missing],
  }
}

export const parseImportAlias = (initial: State): NodeResult => {
  const keyword = expect(initial, 'AsKeyword', ['Identifier', 'LeftBrace', ...topLevelFollowing])
  const name = expect(keyword.state, 'Identifier', ['LeftBrace', ...topLevelFollowing])
  return {
    state: name.state,
    node: syntaxNode(name.state, 'ImportAlias', [...keyword.elements, ...name.elements]),
  }
}

export const parseImportPath = (initial: State): NodeResult => {
  const first = expectImportPathSegment(
    initial,
    ['Dot', 'AsKeyword', 'LeftBrace', ...topLevelFollowing],
    false,
  )
  let state = first.state
  let children: ReadonlyArray<SyntaxTree.Element> = first.elements
  while (nextSignificantKind(state) === 'Dot') {
    const dot = expect(state, 'Dot', ['Identifier', 'AsKeyword', 'LeftBrace', ...topLevelFollowing])
    const segment = expectImportPathSegment(
      dot.state,
      ['Dot', 'AsKeyword', 'LeftBrace', ...topLevelFollowing],
      true,
    )
    children = [...children, ...dot.elements, ...segment.elements]
    state = segment.state
  }
  return { state, node: syntaxNode(state, 'ImportPath', children) }
}

export const parseImportMember = (initial: State): NodeResult => {
  const name = expect(initial, 'Identifier', [
    'AsKeyword',
    'Comma',
    'RightBrace',
    ...topLevelFollowing,
  ])
  let state = name.state
  let children: ReadonlyArray<SyntaxTree.Element> = name.elements
  if (nextSignificantKind(state) === 'AsKeyword') {
    const alias = parseImportAlias(state)
    state = alias.state
    children = [...children, alias.node]
  }
  return { state, node: syntaxNode(state, 'ImportMember', children) }
}

export const parseImportMemberList = (initial: State): NodeResult => {
  const left = expect(initial, 'LeftBrace', ['Identifier', 'RightBrace', ...topLevelFollowing])
  let state = left.state
  let children: ReadonlyArray<SyntaxTree.Element> = left.elements
  let first = true
  while (
    nextSignificantKind(state) !== 'RightBrace' &&
    !topLevelFollowing.includes(nextSignificantKind(state) ?? 'EndOfFile')
  ) {
    if (!first) {
      const comma = expect(state, 'Comma', ['Identifier', 'RightBrace', ...topLevelFollowing])
      children = [...children, ...comma.elements]
      state = comma.state
      if (nextSignificantKind(state) === 'RightBrace') break
    }
    const member = parseImportMember(state)
    children = [...children, member.node]
    state = member.state
    first = false
  }
  if (first) {
    const member = parseImportMember(state)
    children = [...children, member.node]
    state = member.state
  }
  const right = expect(state, 'RightBrace', topLevelFollowing)
  return {
    state: right.state,
    node: syntaxNode(right.state, 'ImportMemberList', [...children, ...right.elements]),
  }
}

export const parseImportDeclaration = (initial: State): NodeResult => {
  const publicKeyword =
    nextSignificantKind(initial) === 'PubKeyword'
      ? expect(initial, 'PubKeyword', ['ImportKeyword'])
      : { state: initial, elements: [] }
  const keyword = expect(publicKeyword.state, 'ImportKeyword', ['Identifier', ...topLevelFollowing])
  const path = parseImportPath(keyword.state)
  let state = path.state
  let children: ReadonlyArray<SyntaxTree.Element> = [
    ...publicKeyword.elements,
    ...keyword.elements,
    path.node,
  ]
  let hasAlias = false
  let hasMembers = false
  if (nextSignificantKind(state) === 'AsKeyword') {
    const alias = parseImportAlias(state)
    state = alias.state
    children = [...children, alias.node]
    hasAlias = true
  }
  if (nextSignificantKind(state) === 'LeftBrace') {
    const members = parseImportMemberList(state)
    state = members.state
    children = [...children, members.node]
    hasMembers = true
  }
  const finalSegment = ImportPath.segments(path.node).at(-1)
  if (publicKeyword.elements.length > 0 && !hasMembers) {
    const missing = missingToken(state, 'LeftBrace')
    state = addDiagnostic(state, Diagnostic.missingToken('LeftBrace', missing.span))
    children = [...children, missing]
  }
  if (
    finalSegment !== undefined &&
    ImportPath.isReservedSegment(finalSegment) &&
    !hasAlias &&
    !hasMembers
  ) {
    const spelling = Option.getOrElse(
      SourceFile.spelling(state.lexical.source, finalSegment.span),
      () => '<reserved>',
    )
    state = addDiagnostic(state, Diagnostic.reservedImportBinding(spelling, finalSegment.span))
  }
  return { state, node: syntaxNode(state, 'ImportDeclaration', children) }
}
