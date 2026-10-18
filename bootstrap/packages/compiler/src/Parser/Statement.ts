import * as Diagnostic from '../Diagnostic.js'
import type { ElementsResult, NodeResult, State } from '../internal/ParseState.js'
import {
  addDiagnostic,
  advance,
  consumeTrivia,
  currentToken,
  expect,
  isTrivia,
  missingToken,
  nextSignificantKind,
  peek,
  syntaxNode,
} from '../internal/ParseState.js'
import * as SyntaxTree from '../SyntaxTree.js'
import type * as Token from '../Token.js'
import {
  hasContextualSpelling,
  isUniversalPatternStart,
  parseExpression,
  parseIdentifierExpression,
  parsePattern,
  parseProjectionChain,
} from './Expression.js'
import * as ExpressionNesting from './ExpressionNesting.js'
import { expressionFollowing, expressionStarts, typeStarts } from './Grammar.js'
import { parseType } from './Type.js'

export const parseReturnStatement = (initial: State): NodeResult => {
  const keyword = expect(initial, 'ReturnKeyword', [...expressionStarts, 'RightBrace'])
  if (nextSignificantKind(keyword.state) === 'RightBrace') {
    const expression = syntaxNode(keyword.state, 'UnitExpression', [])
    return {
      state: keyword.state,
      node: syntaxNode(keyword.state, 'ReturnStatement', [...keyword.elements, expression]),
    }
  }
  const expression = parseExpression(keyword.state, 0, 'Integer', true, ExpressionNesting.root)
  return {
    state: expression.state,
    node: syntaxNode(expression.state, 'ReturnStatement', [...keyword.elements, expression.node]),
  }
}

export const parseImplicitUnitReturnStatement = (initial: State): NodeResult => {
  const expression = syntaxNode(initial, 'UnitExpression', [])
  return {
    state: initial,
    node: syntaxNode(initial, 'ReturnStatement', [expression]),
  }
}

export const parseFailStatement = (initial: State): NodeResult => {
  const keyword = expect(initial, 'FailKeyword', ['MoveKeyword', ...expressionStarts])
  const move =
    nextSignificantKind(keyword.state) === 'MoveKeyword'
      ? expect(keyword.state, 'MoveKeyword', [...expressionStarts, ...expressionFollowing])
      : { state: keyword.state, elements: [] }
  const expression = parseExpression(move.state, 0, 'Identifier', true, ExpressionNesting.root)
  return {
    state: expression.state,
    node: syntaxNode(expression.state, 'FailStatement', [
      ...keyword.elements,
      ...move.elements,
      expression.node,
    ]),
  }
}

export const parseDropStatement = (initial: State): NodeResult => {
  const keyword = expect(initial, 'DropKeyword', expressionStarts)
  const expression = parseExpression(keyword.state, 0, 'Identifier', true, ExpressionNesting.root)
  return {
    state: expression.state,
    node: syntaxNode(expression.state, 'DropStatement', [...keyword.elements, expression.node]),
  }
}

export const parseExpressionStatement = (initial: State): NodeResult => {
  const expression = parseExpression(initial, 0, 'Identifier', true, ExpressionNesting.root)
  return {
    state: expression.state,
    node: syntaxNode(expression.state, 'ExpressionStatement', [expression.node]),
  }
}

export const parseUnsafeStatement = (initial: State): NodeResult => {
  const keyword = expect(initial, 'UnsafeKeyword', ['LeftBrace', 'RightBrace'])
  const block = parseBlock(keyword.state, false)
  return {
    state: block.state,
    node: syntaxNode(block.state, 'UnsafeStatement', [...keyword.elements, block.node]),
  }
}

export const parseBindingStatement = (initial: State): NodeResult => {
  const keyword = expect(initial, 'LetKeyword', [
    'StaticKeyword',
    'MutKeyword',
    'Identifier',
    'Equals',
    'ReturnKeyword',
    'UnsafeKeyword',
    'RightBrace',
  ])
  let modifier: ElementsResult = {
    state: keyword.state,
    elements: [],
  }
  if (nextSignificantKind(keyword.state) === 'StaticKeyword')
    modifier = expect(keyword.state, 'StaticKeyword', ['Identifier', 'Equals', 'RightBrace'])
  else if (nextSignificantKind(keyword.state) === 'MutKeyword')
    modifier = expect(keyword.state, 'MutKeyword', ['Identifier', 'Equals', 'RightBrace'])
  const name = expect(modifier.state, 'Identifier', [
    'Colon',
    'Equals',
    'LetKeyword',
    'ReturnKeyword',
    'RightBrace',
  ])
  const annotation =
    nextSignificantKind(name.state) === 'Colon'
      ? (() => {
          const colon = expect(name.state, 'Colon', [...typeStarts, 'Equals'])
          const type = parseType(colon.state, ['Equals'])
          return { state: type.state, elements: [...colon.elements, type.node] }
        })()
      : { state: name.state, elements: [] as SyntaxTree.Element[] }
  const equals = expect(annotation.state, 'Equals', [
    ...expressionStarts,
    'LetKeyword',
    'ReturnKeyword',
    'RightBrace',
  ])
  const expression = parseExpression(equals.state, 0, 'Integer', true, ExpressionNesting.root)
  return {
    state: expression.state,
    node: syntaxNode(expression.state, 'BindingStatement', [
      ...keyword.elements,
      ...modifier.elements,
      ...name.elements,
      ...annotation.elements,
      ...equals.elements,
      expression.node,
    ]),
  }
}

export const startsPatternBindingStatement = (initial: State): boolean => {
  if (peek(initial, 1) === 'MutKeyword' || peek(initial, 1) === 'StaticKeyword') return false
  if (peek(initial, 1) === 'Equals') return false
  if (peek(initial, 1) !== 'Identifier') return true
  if (peek(initial, 2) === 'Colon') return false
  const keyword = expect(initial, 'LetKeyword', ['Identifier', 'Equals'])
  return isUniversalPatternStart(keyword.state) || peek(initial, 2) !== 'Equals'
}

export const parsePatternBindingStatement = (initial: State): NodeResult => {
  const keyword = expect(initial, 'LetKeyword', ['Identifier', 'LeftBracket', 'Equals'])
  const pattern = parsePattern(keyword.state, ['Equals', 'RightBrace'])
  const equals = expect(pattern.state, 'Equals', [...expressionStarts, 'RightBrace'])
  const expression = parseExpression(equals.state, 0, 'Identifier', true, ExpressionNesting.root)
  return {
    state: expression.state,
    node: syntaxNode(expression.state, 'PatternBindingStatement', [
      ...keyword.elements,
      pattern.node,
      ...equals.elements,
      expression.node,
    ]),
  }
}

export const parseAssignmentStatement = (initial: State): NodeResult => {
  const place = parseProjectionChain(parseIdentifierExpression(initial), ExpressionNesting.root)
  const equals = expect(place.state, 'Equals', [
    ...expressionStarts,
    'LetKeyword',
    'IfKeyword',
    'WhileKeyword',
    'BreakKeyword',
    'ContinueKeyword',
    'ReturnKeyword',
    'FailKeyword',
    'RightBrace',
  ])
  const expression = parseExpression(equals.state, 0, 'Identifier', true, ExpressionNesting.root)
  return {
    state: expression.state,
    node: syntaxNode(expression.state, 'AssignmentStatement', [
      place.node,
      ...equals.elements,
      expression.node,
    ]),
  }
}

export const startsAssignmentStatement = (state: State): boolean => {
  const place = parseProjectionChain(parseIdentifierExpression(state), ExpressionNesting.root)
  return nextSignificantKind(place.state) === 'Equals'
}

export function parseConditionalStatement(initial: State): NodeResult {
  const keyword = expect(initial, 'IfKeyword', [...expressionStarts, 'LeftBrace', 'RightBrace'])
  if (nextSignificantKind(keyword.state) === 'LetKeyword') {
    const letKeyword = expect(keyword.state, 'LetKeyword', ['Identifier', 'LeftBracket', 'Equals'])
    const pattern = parsePattern(letKeyword.state, ['Equals', 'LeftBrace', 'RightBrace'])
    const equals = expect(pattern.state, 'Equals', [...expressionStarts, 'LeftBrace'])
    const subject = parseExpression(equals.state, 0, 'Identifier', false, ExpressionNesting.root)
    const taken = parseBlock(subject.state, false)
    let state = taken.state
    let children: ReadonlyArray<SyntaxTree.Element> = [
      ...keyword.elements,
      ...letKeyword.elements,
      pattern.node,
      ...equals.elements,
      subject.node,
      taken.node,
    ]
    if (nextSignificantKind(state) === 'ElseKeyword') {
      const elseKeyword = expect(state, 'ElseKeyword', ['LeftBrace', 'IfKeyword'])
      const otherwise =
        nextSignificantKind(elseKeyword.state) === 'IfKeyword'
          ? parseConditionalStatement(elseKeyword.state)
          : parseBlock(elseKeyword.state, false)
      state = otherwise.state
      children = [...children, ...elseKeyword.elements, otherwise.node]
    }
    return {
      state,
      node: syntaxNode(state, 'PatternConditionalStatement', children),
    }
  }
  const condition = parseExpression(keyword.state, 0, 'Identifier', false, ExpressionNesting.root)
  const taken = parseBlock(condition.state, false)
  let state = taken.state
  let children: ReadonlyArray<SyntaxTree.Element> = [
    ...keyword.elements,
    condition.node,
    taken.node,
  ]

  if (nextSignificantKind(state) === 'ElseKeyword') {
    const elseKeyword = expect(state, 'ElseKeyword', ['LeftBrace', 'IfKeyword'])
    const otherwise =
      nextSignificantKind(elseKeyword.state) === 'IfKeyword'
        ? parseConditionalStatement(elseKeyword.state)
        : parseBlock(elseKeyword.state, false)
    state = otherwise.state
    children = [...children, ...elseKeyword.elements, otherwise.node]
  }

  return {
    state,
    node: syntaxNode(state, 'ConditionalStatement', children),
  }
}

export const parseStaticConditionalStatement = (initial: State): NodeResult => {
  const staticKeyword = expect(initial, 'StaticKeyword', ['IfKeyword', ...expressionStarts])
  const ifKeyword = expect(staticKeyword.state, 'IfKeyword', [
    ...expressionStarts,
    'LeftBrace',
    'RightBrace',
  ])
  const condition = parseExpression(ifKeyword.state, 0, 'Identifier', false, ExpressionNesting.root)
  const taken = parseBlock(condition.state, false)
  let state = taken.state
  let children: ReadonlyArray<SyntaxTree.Element> = [
    ...staticKeyword.elements,
    ...ifKeyword.elements,
    condition.node,
    taken.node,
  ]
  if (nextSignificantKind(state) === 'ElseKeyword') {
    const elseKeyword = expect(state, 'ElseKeyword', ['LeftBrace'])
    const otherwise = parseBlock(elseKeyword.state, false)
    state = otherwise.state
    children = [...children, ...elseKeyword.elements, otherwise.node]
  }
  return {
    state,
    node: syntaxNode(state, 'StaticConditionalStatement', children),
  }
}

const missingExpected = (initial: State, expected: Token.TokenKind): ElementsResult => {
  const leading = consumeTrivia(initial)
  const missing = missingToken(leading.state, expected)
  return {
    state: addDiagnostic(leading.state, Diagnostic.missingToken(expected, missing.span)),
    elements: [...leading.elements, missing],
  }
}

const staticForBodyBoundary: ReadonlyArray<Token.TokenKind> = [
  'LetKeyword',
  'StaticKeyword',
  'IfKeyword',
  'WhileKeyword',
  'BreakKeyword',
  'ContinueKeyword',
  'ReturnKeyword',
  'FailKeyword',
  'DropKeyword',
  'UnsafeKeyword',
  ...expressionStarts,
  'RightBrace',
  'ElseKeyword',
  'PubKeyword',
  'ConstKeyword',
  'StructKeyword',
  'TupleKeyword',
  'EnumKeyword',
  'UnionKeyword',
  'TypeKeyword',
  'ExternKeyword',
  'ExportKeyword',
  'ServiceKeyword',
  'InterfaceKeyword',
  'RoleKeyword',
  'FnKeyword',
  'EffectKeyword',
  'ImportKeyword',
  'ImplKeyword',
  'EndOfFile',
]

const parseStaticForBody = (initial: State): NodeResult => {
  if (nextSignificantKind(initial) === 'LeftBrace') return parseBlock(initial, false)

  const leftBrace = expect(initial, 'LeftBrace', staticForBodyBoundary)
  const rightBrace = expect(leftBrace.state, 'RightBrace', staticForBodyBoundary)
  return {
    state: rightBrace.state,
    node: syntaxNode(rightBrace.state, 'Block', [...leftBrace.elements, ...rightBrace.elements]),
  }
}

export const parseStaticForStatement = (initial: State): NodeResult => {
  const staticKeyword = expect(initial, 'StaticKeyword', ['ForKeyword', 'Identifier'])
  const forKeyword = expect(staticKeyword.state, 'ForKeyword', [
    'Identifier',
    ...expressionStarts,
    'LeftBrace',
    'RightBrace',
  ])
  const binding = hasContextualSpelling(forKeyword.state, 'in')
    ? missingExpected(forKeyword.state, 'Identifier')
    : expect(forKeyword.state, 'Identifier', [...expressionStarts, 'LeftBrace', 'RightBrace'])
  const inKeyword = hasContextualSpelling(binding.state, 'in')
    ? expect(binding.state, 'Identifier', [...expressionStarts, 'LeftBrace', 'RightBrace'])
    : missingExpected(binding.state, 'Identifier')
  const iterable = parseExpression(inKeyword.state, 0, 'Identifier', false, ExpressionNesting.root)
  const body = parseStaticForBody(iterable.state)
  return {
    state: body.state,
    node: syntaxNode(body.state, 'StaticForStatement', [
      ...staticKeyword.elements,
      ...forKeyword.elements,
      ...binding.elements,
      ...inKeyword.elements,
      iterable.node,
      body.node,
    ]),
  }
}

export function parseWhileStatement(initial: State): NodeResult {
  const keyword = expect(initial, 'WhileKeyword', [...expressionStarts, 'LeftBrace', 'RightBrace'])
  const condition = parseExpression(keyword.state, 0, 'Identifier', false, ExpressionNesting.root)
  const body = parseBlock(condition.state, false)
  return {
    state: body.state,
    node: syntaxNode(body.state, 'WhileStatement', [
      ...keyword.elements,
      condition.node,
      body.node,
    ]),
  }
}

export const parseTransferStatement = (
  initial: State,
  keyword: 'BreakKeyword' | 'ContinueKeyword',
  kind: 'BreakStatement' | 'ContinueStatement',
): NodeResult => {
  const result = expect(initial, keyword, [
    'LetKeyword',
    'IfKeyword',
    'WhileKeyword',
    'BreakKeyword',
    'ContinueKeyword',
    'ReturnKeyword',
    'RightBrace',
  ])
  return {
    state: result.state,
    node: syntaxNode(result.state, kind, result.elements),
  }
}

export const startsBlockStatement = (state: State): boolean => {
  const kind = nextSignificantKind(state)
  if (kind === undefined) return false
  return (
    kind === 'LetKeyword' ||
    kind === 'ReturnKeyword' ||
    kind === 'FailKeyword' ||
    kind === 'DropKeyword' ||
    kind === 'UnsafeKeyword' ||
    (kind === 'StaticKeyword' && peek(state, 1) === 'IfKeyword') ||
    (kind === 'StaticKeyword' && peek(state, 1) === 'ForKeyword') ||
    kind === 'IfKeyword' ||
    kind === 'WhileKeyword' ||
    kind === 'BreakKeyword' ||
    kind === 'ContinueKeyword' ||
    expressionStarts.includes(kind)
  )
}

export const endsBlock = (state: State): boolean => {
  const kind = nextSignificantKind(state)
  return (
    kind === undefined ||
    kind === 'RightBrace' ||
    kind === 'EndOfFile' ||
    kind === 'ElseKeyword' ||
    kind === 'ImportKeyword' ||
    kind === 'PubKeyword' ||
    kind === 'ConstKeyword' ||
    kind === 'StructKeyword' ||
    kind === 'TupleKeyword' ||
    kind === 'EnumKeyword' ||
    kind === 'UnionKeyword' ||
    kind === 'TypeKeyword' ||
    kind === 'ExternKeyword' ||
    kind === 'ExportKeyword' ||
    (kind === 'FnKeyword' && peek(state, 1) === 'Identifier') ||
    kind === 'ImplKeyword' ||
    (kind === 'StaticKeyword' && peek(state, 1) === 'FnKeyword') ||
    (kind === 'EffectKeyword' && peek(state, 1) === 'FnKeyword' && peek(state, 2) === 'Identifier')
  )
}

export const parseErrorStatement = (initial: State): NodeResult => {
  const leading = consumeTrivia(initial)
  let state = leading.state
  let unexpected: ReadonlyArray<Token.Token> = []
  let token = currentToken(state)

  while (token !== undefined) {
    if (unexpected.length > 0 && (startsBlockStatement(state) || endsBlock(state))) break
    unexpected = [...unexpected, token]
    state = advance(state)
    token = currentToken(state)
  }

  const error = syntaxNode(state, 'Error', unexpected)
  state = addDiagnostic(
    state,
    Diagnostic.unexpectedTokens(
      unexpected.map((item) => item.kind),
      'statement',
      [
        '`let`',
        '`return`',
        '`if`',
        '`static if`',
        '`static for`',
        '`while`',
        '`fail`',
        '`drop`',
        '`unsafe`',
        'an expression',
        '`}`',
      ],
      error.span,
    ),
  )
  return {
    state,
    node: syntaxNode(state, 'ErrorStatement', [...leading.elements, error]),
  }
}

export const blockTerminatesSyntactically = (
  children: ReadonlyArray<SyntaxTree.Element>,
): boolean => {
  const statementTerminates = (statement: SyntaxTree.Node): boolean => {
    if (statement.kind === 'ReturnStatement' || statement.kind === 'FailStatement') return true
    if (statement.kind === 'UnsafeStatement') {
      const block = SyntaxTree.directNode(statement, 'Block')
      return block !== undefined && blockTerminatesSyntactically(block.children)
    }
    if (statement.kind !== 'ConditionalStatement') return false
    const blocks = SyntaxTree.directNodes(statement, 'Block')
    const taken = blocks.at(0)
    if (taken === undefined || !blockTerminatesSyntactically(taken.children)) return false
    const chained = SyntaxTree.directNode(statement, 'ConditionalStatement')
    if (chained !== undefined) return statementTerminates(chained)
    const otherwise = blocks.at(1)
    return otherwise !== undefined && blockTerminatesSyntactically(otherwise.children)
  }
  for (const child of children) {
    if (SyntaxTree.isNode(child) && statementTerminates(child)) return true
  }
  return false
}

const parseBlockChild = (state: State): NodeResult => {
  const kind = nextSignificantKind(state)
  switch (kind) {
    case 'LetKeyword':
      if (startsPatternBindingStatement(state)) return parsePatternBindingStatement(state)
      return parseBindingStatement(state)
    case 'IfKeyword':
      return parseConditionalStatement(state)
    case 'StaticKeyword':
      if (peek(state, 1) === 'IfKeyword') return parseStaticConditionalStatement(state)
      if (peek(state, 1) === 'ForKeyword') return parseStaticForStatement(state)
      return parseErrorStatement(state)
    case 'WhileKeyword':
      return parseWhileStatement(state)
    case 'BreakKeyword':
      return parseTransferStatement(state, 'BreakKeyword', 'BreakStatement')
    case 'ContinueKeyword':
      return parseTransferStatement(state, 'ContinueKeyword', 'ContinueStatement')
    case 'ReturnKeyword':
      return parseReturnStatement(state)
    case 'FailKeyword':
      return parseFailStatement(state)
    case 'DropKeyword':
      return parseDropStatement(state)
    case 'Identifier':
      if (startsAssignmentStatement(state)) return parseAssignmentStatement(state)
      break
    case 'UnsafeKeyword':
      if (peek(state, 1) === 'LeftBrace') return parseUnsafeStatement(state)
      break
  }
  if (startsBlockStatement(state)) return parseExpressionStatement(state)
  return parseErrorStatement(state)
}

/** Looks for a guard separator without recursively parsing expression-owned statement blocks. */
const guardHasArmSeparator = (state: State): boolean => {
  const closing: Array<Token.TokenKind> = []
  let expressionBodies = 0
  let previous: Token.TokenKind | undefined
  let hasExpression = false
  for (let index = state.index; index < state.lexical.tokens.length; index += 1) {
    const kind = state.lexical.tokens.at(index)?.kind
    if (kind === undefined || isTrivia(kind)) continue
    if (closing.length === 0) {
      if (kind === 'FatArrow') return hasExpression
      if (kind === 'MatchKeyword' || kind === 'EffectKeyword') expressionBodies += 1
      else if (kind === 'FnKeyword' && previous !== 'EffectKeyword') expressionBodies += 1
      else if (kind === 'LeftBrace') {
        // With struct literals disallowed at a guard's root, a brace belongs either to an
        // expression introduced by match/fn/effect or to a following ordinary if statement.
        if (expressionBodies === 0) return false
        expressionBodies -= 1
      } else if (
        kind === 'RightBrace' ||
        kind === 'Comma' ||
        kind === 'EndOfFile' ||
        kind === 'LetKeyword' ||
        kind === 'IfKeyword' ||
        kind === 'WhileKeyword' ||
        kind === 'ReturnKeyword' ||
        kind === 'FailKeyword' ||
        kind === 'DropKeyword' ||
        kind === 'BreakKeyword' ||
        kind === 'ContinueKeyword' ||
        kind === 'ElseKeyword' ||
        kind === 'PubKeyword' ||
        kind === 'ImportKeyword' ||
        kind === 'UnsafeKeyword' ||
        kind === 'StaticKeyword'
      )
        return false
      hasExpression = true
    }
    if (kind === 'LeftParenthesis') closing.push('RightParenthesis')
    else if (kind === 'LeftBracket') closing.push('RightBracket')
    else if (kind === 'LeftBrace') closing.push('RightBrace')
    else if (kind === 'RightParenthesis' || kind === 'RightBracket' || kind === 'RightBrace') {
      if (closing.pop() !== kind) return false
    }
    previous = kind
  }
  return false
}

/** Recognizes a complete pattern prefix without committing speculative diagnostics or tokens. */
const startsFollowingMatchArm = (state: State): boolean => {
  const kind = nextSignificantKind(state)
  if (kind !== 'Identifier' && kind !== 'DecimalInteger' && kind !== 'Minus') return false
  const pattern = parsePattern({ ...state, diagnostics: [], recovering: false }, [
    'IfKeyword',
    'FatArrow',
    'RightBrace',
  ])
  if (pattern.state.diagnostics.length !== 0) return false
  if (nextSignificantKind(pattern.state) === 'FatArrow') return true
  if (nextSignificantKind(pattern.state) !== 'IfKeyword') return false
  const keyword = expect(pattern.state, 'IfKeyword', [...expressionStarts, 'FatArrow'])
  return guardHasArmSeparator(keyword.state)
}

export function parseBlock(
  initial: State,
  requireReturn: boolean,
  implicitUnitReturn = false,
  matchArm = false,
): NodeResult {
  const leftBrace = expect(initial, 'LeftBrace', [
    'LetKeyword',
    'StaticKeyword',
    'IfKeyword',
    'WhileKeyword',
    'BreakKeyword',
    'ContinueKeyword',
    'ReturnKeyword',
    ...expressionStarts,
    'RightBrace',
  ])
  let state = leftBrace.state
  let children: ReadonlyArray<SyntaxTree.Element> = leftBrace.elements

  while (!endsBlock(state) && !(matchArm && startsFollowingMatchArm(state))) {
    const parsed = parseBlockChild(state)
    // Expression recovery can deliberately leave a declaration/statement boundary untouched.
    // If that token is not a block boundary here, consume it as an error rather than retrying
    // the same zero-width statement forever.
    const statement = parsed.state.index > state.index ? parsed : parseErrorStatement(parsed.state)
    children = [...children, statement.node]
    state = statement.state
  }

  if ((requireReturn || implicitUnitReturn) && !blockTerminatesSyntactically(children)) {
    const statement = parseImplicitUnitReturnStatement(state)
    children = [...children, statement.node]
  }

  const rightBrace = expect(state, 'RightBrace', [
    ...(matchArm ? ['Identifier' as const, 'DecimalInteger' as const, 'Minus' as const] : []),
    'LetKeyword',
    'IfKeyword',
    'WhileKeyword',
    'BreakKeyword',
    'ContinueKeyword',
    'ReturnKeyword',
    'FailKeyword',
    'UnsafeKeyword',
    'StaticKeyword',
    'ElseKeyword',
    'PubKeyword',
    'StructKeyword',
    'TupleKeyword',
    'EnumKeyword',
    'UnionKeyword',
    'TypeKeyword',
    'ExternKeyword',
    'ExportKeyword',
    'FnKeyword',
    'EffectKeyword',
    'ImportKeyword',
  ])
  return {
    state: rightBrace.state,
    node: syntaxNode(rightBrace.state, 'Block', [...children, ...rightBrace.elements]),
  }
}
