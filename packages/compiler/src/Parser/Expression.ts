import * as Option from 'effect/Option'
import * as Diagnostic from '../Diagnostic.js'
import type { ElementsResult, NodeResult, State } from '../internal/ParseState.js'
import {
  addDiagnostic,
  advance,
  advanceTo,
  consumeTrivia,
  currentToken,
  expect,
  insertionOffset,
  isTrivia,
  missingToken,
  nextSignificantKind,
  peek,
  syntaxNode,
} from '../internal/ParseState.js'
import * as Operator from '../Operator.js'
import * as SourceFile from '../SourceFile.js'
import * as SourceSpan from '../SourceSpan.js'
import * as SyntaxTree from '../SyntaxTree.js'
import type * as Token from '../Token.js'
import * as ExpressionNesting from './ExpressionNesting.js'
import { expressionFollowing, expressionStarts, typeStarts } from './Grammar.js'
import { endsBlock, parseBlock } from './Statement.js'
import {
  parseFailureRow,
  parseParameterList,
  parseRequirementRow,
  parseReturnType,
  parseTypeArgumentList,
  parseTypePrimary,
} from './Type.js'

const overBudgetBoundaries: ReadonlyArray<Token.TokenKind> = [
  'Comma',
  'Semicolon',
  'RightParenthesis',
  'RightBracket',
  'RightBrace',
  'FatArrow',
  'LetKeyword',
  'ConstKeyword',
  'IfKeyword',
  'WhileKeyword',
  'BreakKeyword',
  'ContinueKeyword',
  'ReturnKeyword',
  'FailKeyword',
  'DropKeyword',
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
  'ImplKeyword',
  'ServiceKeyword',
  'InterfaceKeyword',
  'RoleKeyword',
  'EndOfFile',
]

const closingDelimiter = (
  kind: Token.TokenKind,
): 'RightParenthesis' | 'RightBracket' | 'RightBrace' | undefined => {
  if (kind === 'LeftParenthesis') return 'RightParenthesis'
  if (kind === 'LeftBracket') return 'RightBracket'
  if (kind === 'LeftBrace') return 'RightBrace'
  return undefined
}

const recoverOverBudgetExpression = (
  initial: State,
  attemptedDepth: number,
  allowStructLiteral: boolean,
): NodeResult => {
  const leading = consumeTrivia(initial)
  const first = currentToken(leading.state)
  if (first === undefined) {
    return { state: initial, node: syntaxNode(initial, 'Error', []) }
  }

  let index = initial.index
  const elements: Array<Token.Token> = []
  const delimiters: Array<'RightParenthesis' | 'RightBracket' | 'RightBrace'> = []
  let significantConsumed = false

  // This is the attacker-controlled hot path: scan once with mutable local arrays, then freeze.
  while (index < initial.lexical.tokens.length) {
    const token = initial.lexical.tokens.at(index)
    if (token === undefined || token.kind === 'EndOfFile') break
    if (!isTrivia(token.kind)) {
      const expected = delimiters.at(-1)
      const atOwnerBoundary =
        delimiters.length === 0 &&
        significantConsumed &&
        (overBudgetBoundaries.includes(token.kind) ||
          (token.kind === 'LeftBrace' && !allowStructLiteral))
      if (atOwnerBoundary) break

      if (
        token.kind === 'RightParenthesis' ||
        token.kind === 'RightBracket' ||
        token.kind === 'RightBrace'
      ) {
        if (expected !== token.kind) break
        delimiters.pop()
      } else {
        const closing = closingDelimiter(token.kind)
        if (closing !== undefined) delimiters.push(closing)
      }
      significantConsumed = true
    }
    elements.push(token)
    index += 1
  }

  const state = advanceTo(initial, index)
  const node = syntaxNode(state, 'Error', elements)
  return {
    state: addDiagnostic(
      state,
      Diagnostic.expressionNestingLimitExceeded(
        ExpressionNesting.limit,
        attemptedDepth,
        first.span,
      ),
    ),
    node,
  }
}

const parseChildExpression = (
  initial: State,
  parentDepth: number,
  allowStructLiteral: boolean,
  parse: (depth: number) => NodeResult,
): NodeResult => {
  const depth = ExpressionNesting.child(parentDepth)
  return ExpressionNesting.exceedsLimit(depth) &&
    expressionStarts.includes(nextSignificantKind(initial) ?? 'EndOfFile')
    ? recoverOverBudgetExpression(initial, depth, allowStructLiteral)
    : parse(depth)
}

export const reservedTemplateStart = (state: State): boolean => {
  let index = state.index
  let token = state.lexical.tokens.at(index)
  while (token !== undefined && isTrivia(token.kind)) {
    index += 1
    token = state.lexical.tokens.at(index)
  }
  if (token?.kind !== 'Less') return false
  index += 1
  token = state.lexical.tokens.at(index)
  while (token !== undefined && isTrivia(token.kind)) {
    index += 1
    token = state.lexical.tokens.at(index)
  }
  return (
    token?.kind === 'Greater' ||
    token?.kind === 'Lifetime' ||
    (token !== undefined && typeStarts.includes(token.kind))
  )
}

/** True only for `callee<T, ...>(` with balanced angles; comparisons never enter call parsing. */
export const hasCompleteAppliedPostfix = (
  state: State,
  postfix: 'LeftParenthesis' | 'LeftBrace',
): boolean => {
  let index = state.index
  const significant = (): Token.Token | undefined => {
    let token = state.lexical.tokens.at(index)
    while (token !== undefined && isTrivia(token.kind)) {
      index += 1
      token = state.lexical.tokens.at(index)
    }
    return token
  }
  if (significant()?.kind !== 'Identifier') return false
  index += 1
  if (significant()?.kind === 'Dot') {
    index += 1
    if (significant()?.kind !== 'Identifier') return false
    index += 1
  }
  if (significant()?.kind !== 'Less') return false
  let depth = 0
  while (index < state.lexical.tokens.length) {
    const token = significant()
    if (token === undefined) return false
    if (token.kind === 'Less') depth += 1
    else if (token.kind === 'Greater') {
      depth -= 1
      if (depth === 0) {
        index += 1
        return significant()?.kind === postfix
      }
    } else if (
      token.kind !== 'Identifier' &&
      token.kind !== 'Lifetime' &&
      token.kind !== 'ForKeyword' &&
      token.kind !== 'LeftBracket' &&
      token.kind !== 'Dot' &&
      token.kind !== 'Comma' &&
      token.kind !== 'LeftParenthesis' &&
      token.kind !== 'RightParenthesis' &&
      token.kind !== 'RightBracket' &&
      token.kind !== 'Semicolon' &&
      token.kind !== 'DecimalInteger' &&
      token.kind !== 'Pipe' &&
      token.kind !== 'Ampersand' &&
      token.kind !== 'At' &&
      token.kind !== 'MutKeyword' &&
      token.kind !== 'Star' &&
      token.kind !== 'ConstKeyword' &&
      // Callable contracts as type arguments: `fn(i32) -> i32`, `once fn() -> A`,
      // `effect fn() -> A ! E ? &R`.
      token.kind !== 'FnKeyword' &&
      token.kind !== 'OnceKeyword' &&
      token.kind !== 'EffectKeyword' &&
      token.kind !== 'Arrow' &&
      token.kind !== 'Bang' &&
      token.kind !== 'Question'
    )
      return false
    index += 1
  }
  return false
}

/** True for an applied parent followed by a member, including a locally recoverable missing `>`. */
export const hasAppliedMember = (state: State): boolean => {
  let previousIndex = state.index - 1
  let previous = state.lexical.tokens.at(previousIndex)
  while (previous !== undefined && isTrivia(previous.kind)) {
    previousIndex -= 1
    previous = state.lexical.tokens.at(previousIndex)
  }
  const recoverableQualifierContext =
    previous?.kind === 'Equals' || previous?.kind === 'PipeGreater'
  let index = state.index
  const significant = (): Token.Token | undefined => {
    let token = state.lexical.tokens.at(index)
    while (token !== undefined && isTrivia(token.kind)) {
      index += 1
      token = state.lexical.tokens.at(index)
    }
    return token
  }
  if (significant()?.kind !== 'Identifier') return false
  index += 1
  let qualifiedOwner = false
  if (significant()?.kind === 'Dot') {
    qualifiedOwner = true
    index += 1
    if (significant()?.kind !== 'Identifier') return false
    index += 1
  }
  const compactOpening = state.lexical.tokens.at(index)?.kind === 'Less'
  if (significant()?.kind !== 'Less') return false
  let depth = 0
  // A closing bracket without its opener inside the scan ends the enclosing group, so no
  // argument list can continue past it. Stopping there keeps `i < n` comparisons from scanning
  // to the end of every enclosing body.
  let nesting = 0
  while (index < state.lexical.tokens.length) {
    const token = significant()
    if (token === undefined) return false
    if (
      token.kind === 'LeftParenthesis' ||
      token.kind === 'LeftBracket' ||
      token.kind === 'LeftBrace'
    )
      nesting += 1
    else if (
      token.kind === 'RightParenthesis' ||
      token.kind === 'RightBracket' ||
      token.kind === 'RightBrace'
    ) {
      if (nesting === 0) return false
      nesting -= 1
    } else if (token.kind === 'Less') depth += 1
    else if (token.kind === 'Greater') {
      depth -= 1
      if (depth === 0) {
        index += 1
        if (significant()?.kind !== 'Dot') return false
        index += 1
        const member = significant()?.kind
        return member === 'Identifier' || member === 'LeftParenthesis'
      }
    } else if (
      token.kind === 'Dot' &&
      depth === 1 &&
      recoverableQualifierContext &&
      !qualifiedOwner &&
      compactOpening &&
      state.lexical.tokens.at(index - 1)?.kind === 'Identifier'
    ) {
      let lookahead = index + 1
      const nextSignificant = (): Token.Token | undefined => {
        let candidate = state.lexical.tokens.at(lookahead)
        while (candidate !== undefined && isTrivia(candidate.kind)) {
          lookahead += 1
          candidate = state.lexical.tokens.at(lookahead)
        }
        return candidate
      }
      const member = nextSignificant()
      if (member?.kind === 'LeftParenthesis') return true
      if (member?.kind === 'Identifier') {
        lookahead += 1
        const following = nextSignificant()?.kind
        if (
          following === 'LeftParenthesis' ||
          following === 'LetKeyword' ||
          following === 'ConstKeyword' ||
          following === 'ReturnKeyword' ||
          following === 'RightBrace' ||
          following === 'EndOfFile'
        )
          return true
      }
    }
    index += 1
  }
  return false
}

/** True only for an operation-owned `<...>` suffix followed by its required argument list. */
const hasCompleteAppliedMemberCallSuffix = (state: State): boolean => {
  let index = state.index
  const significant = (): Token.Token | undefined => {
    let token = state.lexical.tokens.at(index)
    while (token !== undefined && isTrivia(token.kind)) {
      index += 1
      token = state.lexical.tokens.at(index)
    }
    return token
  }
  if (significant()?.kind !== 'Less') return false
  let depth = 0
  while (index < state.lexical.tokens.length) {
    const token = significant()
    if (token === undefined) return false
    if (token.kind === 'Less') depth += 1
    else if (token.kind === 'Greater') {
      depth -= 1
      if (depth === 0) {
        index += 1
        return significant()?.kind === 'LeftParenthesis'
      }
    }
    index += 1
  }
  return false
}

export const parseIntegerLiteralExpression = (initial: State): NodeResult => {
  if (nextSignificantKind(initial) === 'Minus') {
    const minus = expect(initial, 'Minus', ['DecimalInteger', ...expressionFollowing])
    const integer = expect(minus.state, 'DecimalInteger', expressionFollowing)
    return {
      state: integer.state,
      node: syntaxNode(integer.state, 'IntegerLiteralExpression', [
        ...minus.elements,
        ...integer.elements,
      ]),
    }
  }
  const integer = expect(initial, 'DecimalInteger', expressionFollowing)
  return {
    state: integer.state,
    node: syntaxNode(integer.state, 'IntegerLiteralExpression', integer.elements),
  }
}

export const parseFloatingLiteralExpression = (initial: State): NodeResult => {
  if (nextSignificantKind(initial) === 'Minus') {
    const minus = expect(initial, 'Minus', ['DecimalFloat', ...expressionFollowing])
    const literal = expect(minus.state, 'DecimalFloat', expressionFollowing)
    return {
      state: literal.state,
      node: syntaxNode(literal.state, 'FloatingLiteralExpression', [
        ...minus.elements,
        ...literal.elements,
      ]),
    }
  }
  const literal = expect(initial, 'DecimalFloat', expressionFollowing)
  return {
    state: literal.state,
    node: syntaxNode(literal.state, 'FloatingLiteralExpression', literal.elements),
  }
}

export const parseDurationLiteralExpression = (initial: State): NodeResult => {
  const kind =
    nextSignificantKind(initial) === 'InvalidDurationLiteral'
      ? 'InvalidDurationLiteral'
      : 'DurationLiteral'
  const literal = expect(initial, kind, expressionFollowing)
  return {
    state: literal.state,
    node: syntaxNode(literal.state, 'DurationLiteralExpression', literal.elements),
  }
}

export const parseIdentifierExpression = (initial: State): NodeResult => {
  const identifier = expect(initial, 'Identifier', [
    'Dot',
    'LeftBracket',
    'LeftParenthesis',
    ...expressionFollowing,
  ])
  return {
    state: identifier.state,
    node: syntaxNode(identifier.state, 'IdentifierExpression', identifier.elements),
  }
}

export const parseBooleanLiteralExpression = (initial: State): NodeResult => {
  const keyword = expect(
    initial,
    nextSignificantKind(initial) === 'FalseKeyword' ? 'FalseKeyword' : 'TrueKeyword',
    expressionFollowing,
  )
  return {
    state: keyword.state,
    node: syntaxNode(keyword.state, 'BooleanLiteralExpression', keyword.elements),
  }
}

export const parseStaticTextLiteralExpression = (initial: State): NodeResult => {
  const next = nextSignificantKind(initial)
  let kind: 'ByteStringLiteral' | 'InvalidStaticLiteral' | 'TextLiteral'
  if (next === 'ByteStringLiteral') {
    kind = 'ByteStringLiteral'
  } else if (next === 'InvalidStaticLiteral') {
    kind = 'InvalidStaticLiteral'
  } else {
    kind = 'TextLiteral'
  }
  const literal = expect(initial, kind, expressionFollowing)
  return {
    state: literal.state,
    node: syntaxNode(literal.state, 'StaticTextLiteralExpression', literal.elements),
  }
}

export const parseCharacterLiteralExpression = (initial: State): NodeResult => {
  const literal = expect(initial, 'CharLiteral', expressionFollowing)
  return {
    state: literal.state,
    node: syntaxNode(literal.state, 'CharacterLiteralExpression', literal.elements),
  }
}

export const primaryKind = (
  state: State,
  recoveryKind: 'Integer' | 'Identifier',
  allowStructLiteral: boolean,
):
  | 'Integer'
  | 'Duration'
  | 'Floating'
  | 'StaticText'
  | 'Character'
  | 'Boolean'
  | 'Identifier'
  | 'Move'
  | 'AnonymousCallable'
  | 'Effect'
  | 'Run'
  | 'Borrow'
  | 'Unsafe'
  | 'CompileError'
  | 'Call'
  | 'StructLiteral'
  | 'AppliedMember'
  | 'ContextualRecordLiteral'
  | 'ArrayLiteral'
  | 'Match'
  | 'Grouped'
  | 'Prefix'
  | 'ReservedTemplate' => {
  if (reservedTemplateStart(state)) return 'ReservedTemplate'
  let index = state.index
  let token = state.lexical.tokens.at(index)

  while (token !== undefined) {
    if (token.kind === 'DecimalInteger') return 'Integer'
    if (token.kind === 'DecimalFloat') return 'Floating'
    if (token.kind === 'DurationLiteral' || token.kind === 'InvalidDurationLiteral')
      return 'Duration'
    if (
      token.kind === 'TextLiteral' ||
      token.kind === 'ByteStringLiteral' ||
      token.kind === 'InvalidStaticLiteral'
    )
      return 'StaticText'
    if (token.kind === 'CharLiteral') return 'Character'
    if (token.kind === 'Minus') {
      if (peek(state, 1) === 'DecimalInteger') return 'Integer'
      if (peek(state, 1) === 'DecimalFloat') return 'Floating'
      return 'Prefix'
    }
    if (token.kind === 'Bang' || token.kind === 'Tilde') return 'Prefix'
    if (token.kind === 'TrueKeyword' || token.kind === 'FalseKeyword') return 'Boolean'
    if (token.kind === 'MoveKeyword') return 'Move'
    if (
      token.kind === 'FnKeyword' &&
      peek(state, 1) !== 'Identifier' &&
      peek(state, 1) !== 'DropKeyword'
    )
      return 'AnonymousCallable'
    if (
      token.kind === 'EffectKeyword' &&
      peek(state, 1) === 'FnKeyword' &&
      peek(state, 2) !== 'Identifier' &&
      peek(state, 2) !== 'DropKeyword'
    )
      return 'AnonymousCallable'
    if (token.kind === 'EffectKeyword' && peek(state, 1) === 'LeftBrace') return 'Effect'
    if (token.kind === 'RunKeyword') return 'Run'
    if (token.kind === 'Ampersand') return 'Borrow'
    if (token.kind === 'UnsafeKeyword') return 'Unsafe'
    if (token.kind === 'CompileErrorKeyword') return 'CompileError'
    if (token.kind === 'MatchKeyword') return 'Match'
    if (token.kind === 'LeftBracket') return 'ArrayLiteral'
    if (token.kind === 'Dot' && peek(state, 1) === 'LeftBrace') return 'ContextualRecordLiteral'
    if (token.kind === 'Identifier') {
      if (hasAppliedMember(state)) return 'AppliedMember'
      const following = peek(state, 1)
      if (hasCompleteAppliedPostfix(state, 'LeftParenthesis')) return 'Call'
      if (hasCompleteAppliedPostfix(state, 'LeftBrace')) {
        return allowStructLiteral ? 'StructLiteral' : 'Identifier'
      }
      if (following === 'LeftParenthesis') return 'Call'
      if (following === 'LeftBrace') return allowStructLiteral ? 'StructLiteral' : 'Identifier'
      if (following === 'Dot') {
        const member = peek(state, 2)
        if (member === 'LeftParenthesis') return 'Call'
        const afterMember = peek(state, 3)
        if (afterMember === 'LeftParenthesis') return 'Call'
        if (afterMember === 'LeftBrace') return allowStructLiteral ? 'StructLiteral' : 'Identifier'
      }
      return 'Identifier'
    }
    if (token.kind === 'LeftBrace') return allowStructLiteral ? 'StructLiteral' : recoveryKind
    if (token.kind === 'LeftParenthesis') return 'Grouped'
    if (
      token.kind === 'Comma' ||
      token.kind === 'RightParenthesis' ||
      token.kind === 'RightBracket' ||
      token.kind === 'RightBrace' ||
      token.kind === 'FatArrow' ||
      token.kind === 'LetKeyword' ||
      token.kind === 'StaticKeyword' ||
      token.kind === 'IfKeyword' ||
      token.kind === 'ReturnKeyword' ||
      token.kind === 'FailKeyword' ||
      token.kind === 'PubKeyword' ||
      token.kind === 'StructKeyword' ||
      token.kind === 'TupleKeyword' ||
      token.kind === 'EnumKeyword' ||
      token.kind === 'UnionKeyword' ||
      token.kind === 'TypeKeyword' ||
      token.kind === 'ExternKeyword' ||
      token.kind === 'ExportKeyword' ||
      token.kind === 'EffectKeyword' ||
      token.kind === 'ImportKeyword' ||
      token.kind === 'WhileKeyword' ||
      token.kind === 'BreakKeyword' ||
      token.kind === 'ContinueKeyword' ||
      token.kind === 'DropKeyword' ||
      token.kind === 'ElseKeyword' ||
      token.kind === 'EndOfFile'
    ) {
      return recoveryKind
    }
    index += 1
    token = state.lexical.tokens.at(index)
  }

  return recoveryKind
}

export const remainingRightParentheses = (state: State): number => {
  let count = 0
  // A braced argument subtree may contain ordinary statements and its own calls.
  // Neither those statement boundaries nor their parentheses belong to the enclosing call.
  let braceDepth = 0
  for (let index = state.index; index < state.lexical.tokens.length; index += 1) {
    const token = state.lexical.tokens.at(index)
    if (token === undefined) break
    if (token.kind === 'LeftBrace') {
      braceDepth += 1
      continue
    }
    if (token.kind === 'RightBrace' && braceDepth > 0) {
      braceDepth -= 1
      continue
    }
    if (braceDepth > 0) continue
    let followingIndex = index + 1
    let following = state.lexical.tokens.at(followingIndex)
    while (following !== undefined && isTrivia(following.kind)) {
      followingIndex += 1
      following = state.lexical.tokens.at(followingIndex)
    }
    const anonymousCallableStart =
      token.kind === 'FnKeyword' && following?.kind === 'LeftParenthesis'
    if (token.kind === 'RightParenthesis') count += 1
    if (
      token.kind === 'RightBrace' ||
      token.kind === 'StaticKeyword' ||
      token.kind === 'PubKeyword' ||
      token.kind === 'StructKeyword' ||
      token.kind === 'TupleKeyword' ||
      token.kind === 'EnumKeyword' ||
      token.kind === 'UnionKeyword' ||
      token.kind === 'TypeKeyword' ||
      token.kind === 'ExternKeyword' ||
      token.kind === 'ExportKeyword' ||
      (token.kind === 'FnKeyword' && !anonymousCallableStart) ||
      token.kind === 'ImportKeyword' ||
      token.kind === 'LetKeyword' ||
      token.kind === 'ReturnKeyword' ||
      token.kind === 'IfKeyword' ||
      token.kind === 'WhileKeyword' ||
      token.kind === 'BreakKeyword' ||
      token.kind === 'ContinueKeyword' ||
      token.kind === 'FailKeyword' ||
      token.kind === 'DropKeyword' ||
      token.kind === 'ElseKeyword' ||
      token.kind === 'EndOfFile'
    ) {
      break
    }
  }
  return count
}

export const expectCallRightParenthesis = (
  initial: State,
  reservedForEnclosingCalls: number,
): ElementsResult => {
  const leading = consumeTrivia(initial)
  const token = currentToken(leading.state)
  if (
    token?.kind === 'RightParenthesis' &&
    remainingRightParentheses(leading.state) <= reservedForEnclosingCalls
  ) {
    const missing = missingToken(leading.state, 'RightParenthesis')
    return {
      state: addDiagnostic(
        leading.state,
        Diagnostic.missingToken('RightParenthesis', missing.span),
      ),
      elements: [...leading.elements, missing],
    }
  }
  return expect(initial, 'RightParenthesis', [
    'RightBrace',
    'StaticKeyword',
    'PubKeyword',
    'StructKeyword',
    'TupleKeyword',
    'EnumKeyword',
    'UnionKeyword',
    'TypeKeyword',
    'ExternKeyword',
    'ExportKeyword',
    'FnKeyword',
    'ImportKeyword',
    'LetKeyword',
    'ReturnKeyword',
    'IfKeyword',
    'WhileKeyword',
    'BreakKeyword',
    'ContinueKeyword',
    'FailKeyword',
    'DropKeyword',
    'ElseKeyword',
  ])
}

export function parseArgumentList(
  initial: State,
  reservedForEnclosingCalls: number,
  depth: number,
): NodeResult {
  const leftParenthesis = expect(initial, 'LeftParenthesis', [
    ...expressionStarts,
    'RightParenthesis',
    'RightBrace',
    'StaticKeyword',
    'PubKeyword',
    'StructKeyword',
    'TupleKeyword',
    'EnumKeyword',
    'UnionKeyword',
    'TypeKeyword',
    'ExternKeyword',
    'ExportKeyword',
    'FnKeyword',
    'ImportKeyword',
  ])
  let state = leftParenthesis.state
  let children: ReadonlyArray<SyntaxTree.Element> = leftParenthesis.elements
  let kind = nextSignificantKind(state)

  while (
    kind !== undefined &&
    kind !== 'RightParenthesis' &&
    kind !== 'RightBrace' &&
    kind !== 'StaticKeyword' &&
    kind !== 'PubKeyword' &&
    kind !== 'StructKeyword' &&
    kind !== 'TupleKeyword' &&
    kind !== 'EnumKeyword' &&
    kind !== 'UnionKeyword' &&
    kind !== 'TypeKeyword' &&
    kind !== 'ExternKeyword' &&
    kind !== 'ExportKeyword' &&
    !(kind === 'FnKeyword' && peek(state, 1) === 'Identifier') &&
    !(
      kind === 'EffectKeyword' &&
      peek(state, 1) === 'FnKeyword' &&
      peek(state, 2) === 'Identifier'
    ) &&
    kind !== 'ImportKeyword' &&
    kind !== 'EndOfFile'
  ) {
    const argumentStart = consumeTrivia(state).state.index
    const argument = parseChildExpression(state, depth, true, (childDepth) =>
      parseExpression(state, reservedForEnclosingCalls + 1, 'Identifier', true, childDepth),
    )
    children = [...children, argument.node]
    state = argument.state
    kind = nextSignificantKind(state)

    if (
      kind === 'RightParenthesis' ||
      kind === 'RightBrace' ||
      kind === 'StaticKeyword' ||
      kind === 'PubKeyword' ||
      kind === 'StructKeyword' ||
      kind === 'TupleKeyword' ||
      kind === 'EnumKeyword' ||
      kind === 'UnionKeyword' ||
      kind === 'TypeKeyword' ||
      kind === 'ExternKeyword' ||
      kind === 'ExportKeyword' ||
      (kind === 'FnKeyword' && peek(state, 1) === 'Identifier') ||
      (kind === 'EffectKeyword' &&
        peek(state, 1) === 'FnKeyword' &&
        peek(state, 2) === 'Identifier') ||
      kind === 'ImportKeyword'
    )
      break

    const comma = expect(state, 'Comma', [
      ...expressionStarts,
      'RightParenthesis',
      'RightBrace',
      'StaticKeyword',
      'PubKeyword',
      'StructKeyword',
      'TupleKeyword',
      'EnumKeyword',
      'UnionKeyword',
      'TypeKeyword',
      'ExternKeyword',
      'ExportKeyword',
      'FnKeyword',
      'ImportKeyword',
    ])
    children = [...children, ...comma.elements]
    state = comma.state

    // Malformed expression starts may be synchronization tokens for both the expression and the
    // comma expectation. Consume one concrete token when neither parser advanced so this recovery
    // loop has a structural progress guarantee.
    const stalled = consumeTrivia(state)
    if (stalled.state.index === argumentStart) {
      const token = currentToken(stalled.state)
      if (token !== undefined && token.kind !== 'EndOfFile') {
        const advanced = advance(stalled.state)
        const error = syntaxNode(advanced, 'Error', [...stalled.elements, token])
        children = [...children, error]
        state = addDiagnostic(
          advanced,
          Diagnostic.unexpectedTokens(
            [token.kind],
            'syntax',
            ['an expression', '`,`', '`)`'],
            error.span,
          ),
        )
      }
    }
    kind = nextSignificantKind(state)
  }

  const rightParenthesis = expectCallRightParenthesis(state, reservedForEnclosingCalls)
  return {
    state: rightParenthesis.state,
    node: syntaxNode(rightParenthesis.state, 'ArgumentList', [
      ...children,
      ...rightParenthesis.elements,
    ]),
  }
}

export function parseCallExpression(
  initial: State,
  reservedForEnclosingCalls: number,
  depth: number,
): NodeResult {
  let callee = parseIdentifierExpression(initial)
  let state = callee.state
  if (nextSignificantKind(state) === 'Dot') {
    const dot = expect(state, 'Dot', ['Identifier', 'LeftParenthesis'])
    // `drop` stays a statement keyword, but as an operation name after a dot it is ordinary.
    const operation = expect(
      dot.state,
      nextSignificantKind(dot.state) === 'DropKeyword' ? 'DropKeyword' : 'Identifier',
      ['LeftParenthesis'],
    )
    state = operation.state
    callee = {
      state,
      node: syntaxNode(state, 'FieldProjectionExpression', [
        callee.node,
        ...dot.elements,
        ...operation.elements,
      ]),
    }
  }
  let typeArguments: SyntaxTree.Node | undefined
  if (nextSignificantKind(state) === 'Less') {
    const arguments_ = parseTypeArgumentList(state, 'CallTypeArgumentList', ['LeftParenthesis'])
    state = arguments_.state
    typeArguments = arguments_.node
  }
  const argumentsList = parseArgumentList(state, reservedForEnclosingCalls, depth)
  let result: NodeResult = {
    state: argumentsList.state,
    node: syntaxNode(argumentsList.state, 'CallExpression', [
      callee.node,
      ...(typeArguments === undefined ? [] : [typeArguments]),
      argumentsList.node,
    ]),
  }
  while (nextSignificantKind(result.state) === 'LeftParenthesis') {
    const nextArguments = parseArgumentList(result.state, reservedForEnclosingCalls, depth)
    result = {
      state: nextArguments.state,
      node: syntaxNode(nextArguments.state, 'CallExpression', [result.node, nextArguments.node]),
    }
  }
  return result
}

export function parseStructLiteralExpression(
  initial: State,
  reservedForEnclosingCalls: number,
  depth: number,
): NodeResult {
  const first = expect(initial, 'Identifier', ['Dot', 'Less', 'LeftBrace', ...expressionFollowing])
  let state = first.state
  let targetChildren: ReadonlyArray<SyntaxTree.Element> = first.elements
  if (nextSignificantKind(state) === 'Dot') {
    const dot = expect(state, 'Dot', ['Identifier', 'Less', 'LeftBrace'])
    const second = expect(dot.state, 'Identifier', ['Less', 'LeftBrace'])
    state = second.state
    targetChildren = [...targetChildren, ...dot.elements, ...second.elements]
  }
  const path = syntaxNode(state, 'TypePath', targetChildren)
  const applied =
    nextSignificantKind(state) === 'Less'
      ? parseTypeArgumentList(state, 'TypeArgumentList', ['LeftBrace'])
      : undefined
  if (applied !== undefined) state = applied.state
  const target =
    applied === undefined ? path : syntaxNode(applied.state, 'AppliedType', [path, applied.node])
  const leftBrace = expect(state, 'LeftBrace', ['Identifier', 'RightBrace', ...expressionFollowing])
  state = leftBrace.state
  let children: ReadonlyArray<SyntaxTree.Element> = [target, ...leftBrace.elements]
  let kind = nextSignificantKind(state)

  while (
    kind !== undefined &&
    kind !== 'RightBrace' &&
    kind !== 'LetKeyword' &&
    kind !== 'IfKeyword' &&
    kind !== 'ReturnKeyword' &&
    kind !== 'PubKeyword' &&
    kind !== 'StructKeyword' &&
    kind !== 'TupleKeyword' &&
    kind !== 'EnumKeyword' &&
    kind !== 'UnionKeyword' &&
    kind !== 'TypeKeyword' &&
    kind !== 'ExternKeyword' &&
    kind !== 'ExportKeyword' &&
    kind !== 'FnKeyword' &&
    kind !== 'ImportKeyword' &&
    kind !== 'EndOfFile'
  ) {
    const field = expect(state, 'Identifier', ['Colon', ...expressionStarts, 'RightBrace'])
    const colon = expect(field.state, 'Colon', [...expressionStarts, 'Comma', 'RightBrace'])
    const value = parseChildExpression(colon.state, depth, true, (childDepth) =>
      parseExpression(colon.state, 0, 'Identifier', true, childDepth),
    )
    const initializer = syntaxNode(value.state, 'StructFieldInitializer', [
      ...field.elements,
      ...colon.elements,
      value.node,
    ])
    children = [...children, initializer]
    state = value.state
    kind = nextSignificantKind(state)
    if (kind === 'RightBrace') break
    const comma = expect(state, 'Comma', [...expressionStarts, 'RightBrace'])
    children = [...children, ...comma.elements]
    state = comma.state
    kind = nextSignificantKind(state)
    if (kind === 'RightBrace') break
  }

  const rightBrace = expect(state, 'RightBrace', expressionFollowing)
  return {
    state: rightBrace.state,
    node: syntaxNode(rightBrace.state, 'StructLiteralExpression', [
      ...children,
      ...rightBrace.elements,
    ]),
  }
}

/** Parses the targetless record form `.{ field: value, ... }`. */
export function parseContextualRecordLiteralExpression(
  initial: State,
  reservedForEnclosingCalls: number,
  depth: number,
): NodeResult {
  const dot = expect(initial, 'Dot', ['LeftBrace'])
  const left = expect(dot.state, 'LeftBrace', ['Identifier', 'RightBrace', ...expressionFollowing])
  let state = left.state
  let children: ReadonlyArray<SyntaxTree.Element> = [...dot.elements, ...left.elements]
  while (
    nextSignificantKind(state) !== 'RightBrace' &&
    nextSignificantKind(state) !== 'EndOfFile' &&
    !expressionFollowing.includes(nextSignificantKind(state) ?? 'EndOfFile')
  ) {
    const field = expect(state, 'Identifier', ['Colon', ...expressionStarts, 'RightBrace'])
    const colon = expect(field.state, 'Colon', [...expressionStarts, 'Comma', 'RightBrace'])
    const value = parseChildExpression(colon.state, depth, true, (childDepth) =>
      parseExpression(colon.state, 0, 'Identifier', true, childDepth),
    )
    children = [
      ...children,
      syntaxNode(value.state, 'StructFieldInitializer', [
        ...field.elements,
        ...colon.elements,
        value.node,
      ]),
    ]
    state = value.state
    if (nextSignificantKind(state) === 'RightBrace') break
    const comma = expect(state, 'Comma', ['Identifier', 'RightBrace', ...expressionFollowing])
    children = [...children, ...comma.elements]
    state = comma.state
  }
  const right = expect(state, 'RightBrace', expressionFollowing)
  return {
    state: right.state,
    node: syntaxNode(right.state, 'ContextualRecordLiteralExpression', [
      ...children,
      ...right.elements,
    ]),
  }
}

export const parseAppliedMemberSelector = (
  initial: State,
  following: ReadonlyArray<Token.TokenKind>,
): NodeResult => {
  const parent = hasAppliedMember(initial)
    ? parseTypePrimary(initial, ['Dot', ...following])
    : (() => {
        const name = expect(initial, 'Identifier', ['Dot', ...following])
        return {
          state: name.state,
          node: syntaxNode(name.state, 'TypePath', name.elements),
        }
      })()
  const dot = expect(parent.state, 'Dot', ['Identifier', ...following])
  const variant = expect(dot.state, 'Identifier', following)
  return {
    state: variant.state,
    node: syntaxNode(variant.state, 'AppliedMemberSelector', [
      parent.node,
      ...dot.elements,
      ...variant.elements,
    ]),
  }
}

export function parseAppliedMemberExpression(
  initial: State,
  reservedForEnclosingCalls: number,
  depth: number,
): NodeResult {
  const selector = parseAppliedMemberSelector(initial, [
    'Less',
    'LeftParenthesis',
    'LeftBrace',
    ...expressionFollowing,
  ])
  if (nextSignificantKind(selector.state) !== 'LeftBrace') {
    return {
      state: selector.state,
      node: syntaxNode(selector.state, 'AppliedMemberExpression', [selector.node]),
    }
  }
  const left = expect(selector.state, 'LeftBrace', [
    'Identifier',
    'RightBrace',
    ...expressionFollowing,
  ])
  let state = left.state
  let children: ReadonlyArray<SyntaxTree.Element> = [selector.node, ...left.elements]
  while (
    nextSignificantKind(state) !== 'RightBrace' &&
    nextSignificantKind(state) !== 'EndOfFile' &&
    !expressionFollowing.includes(nextSignificantKind(state) ?? 'EndOfFile')
  ) {
    const field = expect(state, 'Identifier', ['Colon', ...expressionStarts, 'RightBrace'])
    const colon = expect(field.state, 'Colon', [...expressionStarts, 'Comma', 'RightBrace'])
    const value = parseChildExpression(colon.state, depth, true, (childDepth) =>
      parseExpression(colon.state, 0, 'Identifier', true, childDepth),
    )
    children = [
      ...children,
      syntaxNode(value.state, 'StructFieldInitializer', [
        ...field.elements,
        ...colon.elements,
        value.node,
      ]),
    ]
    state = value.state
    if (nextSignificantKind(state) === 'RightBrace') break
    const comma = expect(state, 'Comma', ['Identifier', 'RightBrace', ...expressionFollowing])
    children = [...children, ...comma.elements]
    state = comma.state
  }
  const right = expect(state, 'RightBrace', expressionFollowing)
  return {
    state: right.state,
    node: syntaxNode(right.state, 'AppliedMemberExpression', [...children, ...right.elements]),
  }
}

export function parseGroupedExpression(
  initial: State,
  reservedForEnclosingCalls: number,
  depth: number,
): NodeResult {
  const left = expect(initial, 'LeftParenthesis', [...expressionStarts, 'RightParenthesis'])
  if (nextSignificantKind(left.state) === 'RightParenthesis') {
    const right = expectCallRightParenthesis(left.state, reservedForEnclosingCalls)
    return {
      state: right.state,
      node: syntaxNode(right.state, 'UnitExpression', [...left.elements, ...right.elements]),
    }
  }
  const expression = parseChildExpression(left.state, depth, true, (childDepth) =>
    parseExpression(left.state, reservedForEnclosingCalls + 1, 'Identifier', true, childDepth),
  )
  if (nextSignificantKind(expression.state) === 'Comma') {
    let state = expression.state
    let children: ReadonlyArray<SyntaxTree.Element> = [...left.elements, expression.node]
    while (nextSignificantKind(state) === 'Comma') {
      const comma = expect(state, 'Comma', [...expressionStarts, 'RightParenthesis'])
      children = [...children, ...comma.elements]
      state = comma.state
      if (nextSignificantKind(state) === 'RightParenthesis') break
      const element = parseChildExpression(state, depth, true, (childDepth) =>
        parseExpression(state, reservedForEnclosingCalls + 1, 'Identifier', true, childDepth),
      )
      children = [...children, element.node]
      state = element.state
    }
    const right = expectCallRightParenthesis(state, reservedForEnclosingCalls)
    return {
      state: right.state,
      node: syntaxNode(right.state, 'TupleLiteralExpression', [...children, ...right.elements]),
    }
  }
  const right = expectCallRightParenthesis(expression.state, reservedForEnclosingCalls)
  return {
    state: right.state,
    node: syntaxNode(right.state, 'GroupedExpression', [
      ...left.elements,
      expression.node,
      ...right.elements,
    ]),
  }
}

export function parseArrayLiteralExpression(
  initial: State,
  reservedForEnclosingCalls: number,
  depth: number,
): NodeResult {
  const left = expect(initial, 'LeftBracket', [...expressionStarts, 'RightBracket'])
  let state = left.state
  let children: ReadonlyArray<SyntaxTree.Element> = left.elements
  let first = true
  while (
    nextSignificantKind(state) !== 'RightBracket' &&
    nextSignificantKind(state) !== 'RightBrace' &&
    nextSignificantKind(state) !== 'EndOfFile'
  ) {
    if (!first) {
      const comma = expect(state, 'Comma', [...expressionStarts, 'RightBracket'])
      children = [...children, ...comma.elements]
      state = comma.state
      if (nextSignificantKind(state) === 'RightBracket') break
    }
    const element = parseChildExpression(state, depth, true, (childDepth) =>
      parseExpression(state, reservedForEnclosingCalls, 'Identifier', true, childDepth),
    )
    children = [...children, element.node]
    state = element.state
    first = false
  }
  const right = expect(state, 'RightBracket', expressionFollowing)
  return {
    state: right.state,
    node: syntaxNode(right.state, 'ArrayLiteralExpression', [...children, ...right.elements]),
  }
}

export const significantToken = (state: State): Token.Token | undefined => {
  let index = state.index
  let token = state.lexical.tokens.at(index)
  while (token !== undefined && isTrivia(token.kind)) {
    index += 1
    token = state.lexical.tokens.at(index)
  }
  return token
}

export const isUniversalPatternStart = (state: State): boolean => {
  const token = significantToken(state)
  return (
    token?.kind === 'Identifier' &&
    Option.contains(SourceFile.spelling(state.lexical.source, token.span), '_')
  )
}

/**
 * True for one contextual identifier spelling.
 *
 * Contextual spellings stay ordinary identifiers in the lexer so that source may still name a
 * value `typeof` or `some`; only the parser recognizes them, and only where the surrounding
 * grammar admits no other reading.
 */
export const hasContextualSpelling = (state: State, spelling: string): boolean => {
  const token = significantToken(state)
  return (
    token?.kind === 'Identifier' &&
    Option.contains(SourceFile.spelling(state.lexical.source, token.span), spelling)
  )
}

/** True for one contextual identifier at a significant-token offset from the current state. */
export const hasContextualSpellingAt = (
  state: State,
  spelling: string,
  offset: number,
): boolean => {
  let index = state.index
  let remaining = offset
  let token = state.lexical.tokens.at(index)
  while (token !== undefined) {
    if (!isTrivia(token.kind)) {
      if (remaining === 0)
        return (
          token.kind === 'Identifier' &&
          Option.contains(SourceFile.spelling(state.lexical.source, token.span), spelling)
        )
      remaining -= 1
    }
    index += 1
    token = state.lexical.tokens.at(index)
  }
  return false
}

/** True only for `typeof(`; an ordinary type path is never followed by a parenthesis. */
export const isExactRepresentationStart = (state: State): boolean =>
  hasContextualSpelling(state, 'typeof') && peek(state, 1) === 'LeftParenthesis'

/**
 * True only for `some<` at the start of a result.
 *
 * The binder is contextual and scoped to result position alone, so an ordinary applied type keeps
 * the `some<...>` spelling everywhere else in the grammar.
 */
export const isOpaqueResultStart = (state: State): boolean =>
  hasContextualSpelling(state, 'some') && peek(state, 1) === 'Less'

export const isRowWithoutStart = (state: State): boolean =>
  hasContextualSpelling(state, 'Without') && peek(state, 1) === 'Less'

export const isNominalPatternStart = (state: State): boolean => {
  if (nextSignificantKind(state) !== 'Identifier') return false
  if (hasAppliedMember(state)) return true
  if (hasCompleteAppliedPostfix(state, 'LeftBrace')) return true
  const following = peek(state, 1)
  if (following === 'LeftBrace') return true
  return following === 'Dot' && peek(state, 3) === 'LeftBrace'
}

/**
 * True for `[element; count] name`: a complete fixed-array type followed by its whole-value
 * binding (PATT-016, PATT-018). Any other `[` in pattern position stays a damaged pattern.
 */
const isFixedArrayBindingPatternStart = (state: State): boolean => {
  let index = state.index
  let depth = 0
  for (; index < state.lexical.tokens.length; index += 1) {
    const token = state.lexical.tokens.at(index)
    if (token === undefined || token.kind === 'EndOfFile') return false
    if (token.kind === 'LeftBracket') depth += 1
    else if (token.kind === 'RightBracket') {
      depth -= 1
      if (depth === 0) break
    } else if (token.kind === 'FatArrow' || token.kind === 'Equals' || token.kind === 'LeftBrace')
      return false
  }
  index += 1
  let token = state.lexical.tokens.at(index)
  while (token !== undefined && isTrivia(token.kind)) {
    index += 1
    token = state.lexical.tokens.at(index)
  }
  return token?.kind === 'Identifier'
}

export const isEnumMemberPatternStart = (state: State): boolean => {
  if (
    nextSignificantKind(state) !== 'Identifier' ||
    peek(state, 1) !== 'Dot' ||
    peek(state, 2) !== 'Identifier'
  )
    return false
  const following = peek(state, 3)
  return following === 'IfKeyword' || following === 'FatArrow' || following === 'RightBrace'
}

export const parseEnumMemberPattern = (initial: State): NodeResult => {
  const qualifier = expect(initial, 'Identifier', ['Dot', 'IfKeyword', 'FatArrow', 'RightBrace'])
  const dot = expect(qualifier.state, 'Dot', ['Identifier', 'IfKeyword', 'FatArrow', 'RightBrace'])
  const member = expect(dot.state, 'Identifier', ['IfKeyword', 'FatArrow', 'RightBrace'])
  return {
    state: member.state,
    node: syntaxNode(member.state, 'EnumMemberPattern', [
      ...qualifier.elements,
      ...dot.elements,
      ...member.elements,
    ]),
  }
}

export const parseIntegerPattern = (initial: State): NodeResult => {
  const literal = parseIntegerLiteralExpression(initial)
  return {
    state: literal.state,
    node: syntaxNode(literal.state, 'IntegerPattern', literal.node.children),
  }
}

export const parseErrorPattern = (
  initial: State,
  following: ReadonlyArray<Token.TokenKind>,
): NodeResult => {
  const leading = consumeTrivia(initial)
  let state = leading.state
  let unexpected: ReadonlyArray<Token.Token> = []
  let token = currentToken(state)
  let braceDepth = 0

  while (
    token !== undefined &&
    token.kind !== 'EndOfFile' &&
    !(
      following.includes(nextSignificantKind(state) ?? 'EndOfFile') &&
      (nextSignificantKind(state) !== 'RightBrace' || braceDepth === 0)
    )
  ) {
    unexpected = [...unexpected, token]
    if (token.kind === 'LeftBrace') braceDepth += 1
    else if (token.kind === 'RightBrace' && braceDepth > 0) braceDepth -= 1
    state = advance(state)
    token = currentToken(state)
  }

  if (unexpected.length === 0) {
    const missing = missingToken(state, 'Identifier')
    return {
      state: addDiagnostic(state, Diagnostic.missingToken('Identifier', missing.span)),
      node: syntaxNode(state, 'ErrorPattern', [...leading.elements, missing]),
    }
  }

  const error = syntaxNode(state, 'Error', unexpected)
  return {
    state: addDiagnostic(
      state,
      Diagnostic.unexpectedTokens(
        unexpected.map((item) => item.kind),
        'syntax',
        ['a nominal pattern', 'a qualified enum member', 'an integer literal', '`_`'],
        error.span,
      ),
    ),
    node: syntaxNode(state, 'ErrorPattern', [...leading.elements, error]),
  }
}

export function parsePattern(
  initial: State,
  following: ReadonlyArray<Token.TokenKind>,
): NodeResult {
  if (isUniversalPatternStart(initial)) {
    const identifier = expect(initial, 'Identifier', ['IfKeyword', 'FatArrow', 'RightBrace'])
    return {
      state: identifier.state,
      node: syntaxNode(identifier.state, 'UniversalPattern', identifier.elements),
    }
  }
  if (isEnumMemberPatternStart(initial)) return parseEnumMemberPattern(initial)
  if (hasAppliedMember(initial)) return parseUnionVariantPattern(initial)
  const kind = nextSignificantKind(initial)
  if (kind === 'DecimalInteger' || (kind === 'Minus' && peek(initial, 1) === 'DecimalInteger'))
    return parseIntegerPattern(initial)
  const nonNominalTypePrimary =
    kind === 'Ampersand' ||
    (kind === 'LeftBracket' && !isFixedArrayBindingPatternStart(initial)) ||
    kind === 'LeftParenthesis' ||
    kind === 'FnKeyword' ||
    kind === 'UnsafeKeyword' ||
    ((kind === 'MutKeyword' || kind === 'OnceKeyword') && peek(initial, 1) !== 'Identifier') ||
    isRowWithoutStart(initial) ||
    isExactRepresentationStart(initial)
  return nonNominalTypePrimary
    ? parseErrorPattern(initial, following)
    : parseNominalPattern(initial)
}

export function parseUnionVariantPattern(initial: State): NodeResult {
  const selector = parseAppliedMemberSelector(initial, [
    'LeftBrace',
    'IfKeyword',
    'FatArrow',
    'RightBrace',
  ])
  if (nextSignificantKind(selector.state) !== 'LeftBrace') {
    return {
      state: selector.state,
      node: syntaxNode(selector.state, 'UnionVariantPattern', [selector.node]),
    }
  }
  const left = expect(selector.state, 'LeftBrace', [
    'Identifier',
    'DotDot',
    'RightBrace',
    'IfKeyword',
    'FatArrow',
  ])
  let state = left.state
  let children: ReadonlyArray<SyntaxTree.Element> = [selector.node, ...left.elements]
  while (
    nextSignificantKind(state) !== 'RightBrace' &&
    nextSignificantKind(state) !== 'IfKeyword' &&
    nextSignificantKind(state) !== 'FatArrow' &&
    nextSignificantKind(state) !== 'EndOfFile'
  ) {
    if (nextSignificantKind(state) === 'DotDot') {
      const rest = expect(state, 'DotDot', ['Comma', 'RightBrace', 'IfKeyword', 'FatArrow'])
      children = [...children, syntaxNode(rest.state, 'RestPattern', rest.elements)]
      state = rest.state
    } else {
      const name = expect(state, 'Identifier', [
        'Colon',
        'Comma',
        'RightBrace',
        'IfKeyword',
        'FatArrow',
      ])
      state = name.state
      let fieldChildren: ReadonlyArray<SyntaxTree.Element> = name.elements
      if (nextSignificantKind(state) === 'Colon' || isNominalPatternStart(state)) {
        const colon = expect(state, 'Colon', [
          'Identifier',
          'Comma',
          'RightBrace',
          'IfKeyword',
          'FatArrow',
        ])
        state = colon.state
        if (isNominalPatternStart(state)) {
          const nested = hasAppliedMember(state)
            ? parseUnionVariantPattern(state)
            : parseNominalPattern(state)
          fieldChildren = [...fieldChildren, ...colon.elements, nested.node]
          state = nested.state
        } else {
          const binding = expect(state, 'Identifier', [
            'Comma',
            'RightBrace',
            'IfKeyword',
            'FatArrow',
          ])
          fieldChildren = [...fieldChildren, ...colon.elements, ...binding.elements]
          state = binding.state
        }
      }
      children = [...children, syntaxNode(state, 'PatternField', fieldChildren)]
    }
    if (nextSignificantKind(state) === 'RightBrace') break
    const comma = expect(state, 'Comma', [
      'Identifier',
      'DotDot',
      'RightBrace',
      'IfKeyword',
      'FatArrow',
    ])
    children = [...children, ...comma.elements]
    state = comma.state
  }
  const right = expect(state, 'RightBrace', ['IfKeyword', 'FatArrow', 'Identifier', 'RightBrace'])
  return {
    state: right.state,
    node: syntaxNode(right.state, 'UnionVariantPattern', [...children, ...right.elements]),
  }
}

export function parseNominalPattern(initial: State): NodeResult {
  const target = parseTypePrimary(initial, ['LeftBrace', 'IfKeyword', 'FatArrow', 'RightBrace'])
  // `Member name` binds the whole member value instead of destructuring its fields.
  if (nextSignificantKind(target.state) === 'Identifier') {
    const binding = expect(target.state, 'Identifier', ['IfKeyword', 'FatArrow', 'RightBrace'])
    return {
      state: binding.state,
      node: syntaxNode(binding.state, 'BindingPattern', [target.node, ...binding.elements]),
    }
  }
  const left = expect(target.state, 'LeftBrace', [
    'Identifier',
    'DotDot',
    'RightBrace',
    'IfKeyword',
    'FatArrow',
  ])
  let state = left.state
  let children: ReadonlyArray<SyntaxTree.Element> = [target.node, ...left.elements]

  while (
    nextSignificantKind(state) !== 'RightBrace' &&
    nextSignificantKind(state) !== 'IfKeyword' &&
    nextSignificantKind(state) !== 'FatArrow' &&
    nextSignificantKind(state) !== 'EndOfFile'
  ) {
    if (nextSignificantKind(state) === 'DotDot') {
      const rest = expect(state, 'DotDot', ['Comma', 'RightBrace', 'IfKeyword', 'FatArrow'])
      children = [...children, syntaxNode(rest.state, 'RestPattern', rest.elements)]
      state = rest.state
    } else {
      const name = expect(state, 'Identifier', [
        'Colon',
        'Comma',
        'RightBrace',
        'IfKeyword',
        'FatArrow',
      ])
      state = name.state
      let fieldChildren: ReadonlyArray<SyntaxTree.Element> = name.elements
      if (nextSignificantKind(state) === 'Colon' || isNominalPatternStart(state)) {
        const colon = expect(state, 'Colon', [
          'Identifier',
          'Comma',
          'RightBrace',
          'IfKeyword',
          'FatArrow',
        ])
        state = colon.state
        if (isNominalPatternStart(state)) {
          const nested = parseNominalPattern(state)
          fieldChildren = [...fieldChildren, ...colon.elements, nested.node]
          state = nested.state
        } else {
          const binding = expect(state, 'Identifier', [
            'Comma',
            'RightBrace',
            'IfKeyword',
            'FatArrow',
          ])
          fieldChildren = [...fieldChildren, ...colon.elements, ...binding.elements]
          state = binding.state
        }
      }
      children = [...children, syntaxNode(state, 'PatternField', fieldChildren)]
    }

    if (nextSignificantKind(state) === 'RightBrace') break
    const comma = expect(state, 'Comma', [
      'Identifier',
      'DotDot',
      'RightBrace',
      'IfKeyword',
      'FatArrow',
    ])
    children = [...children, ...comma.elements]
    state = comma.state
  }

  const right = expect(state, 'RightBrace', ['IfKeyword', 'FatArrow', 'Identifier', 'RightBrace'])
  return {
    state: right.state,
    node: syntaxNode(right.state, 'NominalPattern', [...children, ...right.elements]),
  }
}

export function parseMatchArm(
  initial: State,
  reservedForEnclosingCalls: number,
  depth: number,
): NodeResult {
  const pattern = parsePattern(initial, ['IfKeyword', 'FatArrow', 'RightBrace'])
  let state = pattern.state
  let children: ReadonlyArray<SyntaxTree.Element> = [pattern.node]

  if (nextSignificantKind(state) === 'IfKeyword') {
    const keyword = expect(state, 'IfKeyword', [...expressionStarts, 'FatArrow'])
    const guard = parseChildExpression(keyword.state, depth, false, (childDepth) =>
      parseExpression(keyword.state, reservedForEnclosingCalls, 'Identifier', false, childDepth),
    )
    children = [...children, ...keyword.elements, guard.node]
    state = guard.state
  }

  const arrow = expect(state, 'FatArrow', [
    ...expressionStarts,
    'LeftBrace',
    'Identifier',
    'RightBrace',
  ])
  const result = parseChildExpression(arrow.state, depth, true, (childDepth) => {
    if (nextSignificantKind(arrow.state) !== 'LeftBrace')
      return parseExpression(arrow.state, reservedForEnclosingCalls, 'Identifier', true, childDepth)
    const block = parseBlock({ ...arrow.state, expressionDepth: childDepth }, false, false, true)
    const { expressionDepth: _depth, ...following } = block.state
    return {
      node: block.node,
      state: {
        ...following,
        ...(arrow.state.expressionDepth === undefined
          ? {}
          : { expressionDepth: arrow.state.expressionDepth }),
      },
    }
  })
  state = result.state
  children = [...children, ...arrow.elements, result.node]
  return { state, node: syntaxNode(state, 'MatchArm', children) }
}

export function parseMatchExpression(
  initial: State,
  reservedForEnclosingCalls: number,
  depth: number,
): NodeResult {
  const keyword = expect(initial, 'MatchKeyword', ['MoveKeyword', 'Ampersand', ...expressionStarts])
  let state = keyword.state
  let accessChildren: ReadonlyArray<SyntaxTree.Element> = []
  if (hasContextualSpelling(state, 'place') && peek(state, 1) === 'Identifier') {
    const place = expect(state, 'Identifier', expressionStarts)
    state = place.state
    accessChildren = place.elements
  } else if (nextSignificantKind(state) === 'MoveKeyword') {
    const move = expect(state, 'MoveKeyword', expressionStarts)
    state = move.state
    accessChildren = move.elements
  } else if (nextSignificantKind(state) === 'Ampersand') {
    const ampersand = expect(state, 'Ampersand', ['MutKeyword', ...expressionStarts])
    state = ampersand.state
    accessChildren = ampersand.elements
    if (nextSignificantKind(state) === 'MutKeyword') {
      const mut = expect(state, 'MutKeyword', expressionStarts)
      state = mut.state
      accessChildren = [...accessChildren, ...mut.elements]
    }
  }
  const access = syntaxNode(state, 'MatchAccess', accessChildren)
  const scrutinee = parseChildExpression(state, depth, false, (childDepth) =>
    parseExpression(state, reservedForEnclosingCalls, 'Identifier', false, childDepth),
  )
  const left = expect(scrutinee.state, 'LeftBrace', ['Identifier', 'RightBrace'])
  state = left.state
  let children: ReadonlyArray<SyntaxTree.Element> = [
    ...keyword.elements,
    access,
    scrutinee.node,
    ...left.elements,
  ]

  while (!endsBlock(state)) {
    const arm = parseMatchArm(state, reservedForEnclosingCalls, depth)
    children = [...children, arm.node]
    state = arm.state
  }

  const right = expect(state, 'RightBrace', expressionFollowing)
  return {
    state: right.state,
    node: syntaxNode(right.state, 'MatchExpression', [...children, ...right.elements]),
  }
}

export const reservedTemplateBoundaries: ReadonlyArray<Token.TokenKind> = [
  'Comma',
  'RightParenthesis',
  'RightBracket',
  'RightBrace',
  'LetKeyword',
  'StaticKeyword',
  'IfKeyword',
  'WhileKeyword',
  'BreakKeyword',
  'ContinueKeyword',
  'ReturnKeyword',
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
  'ImportKeyword',
  'EndOfFile',
]

export const parseReservedTemplateExpression = (initial: State): NodeResult => {
  const leading = consumeTrivia(initial)
  let state = leading.state
  let elements: ReadonlyArray<SyntaxTree.Element> = leading.elements
  let token = currentToken(state)
  const start = token?.span.start ?? insertionOffset(state)
  let braceDepth = 0
  let bracketDepth = 0
  let parenthesisDepth = 0

  while (token !== undefined) {
    const nested = braceDepth > 0 || bracketDepth > 0 || parenthesisDepth > 0
    if (elements.length > leading.elements.length && !nested) {
      if (reservedTemplateBoundaries.includes(token.kind)) break
    }

    elements = [...elements, token]
    state = advance(state)

    if (token.kind === 'LeftBrace') braceDepth += 1
    else if (token.kind === 'RightBrace' && braceDepth > 0) braceDepth -= 1
    else if (token.kind === 'LeftBracket') bracketDepth += 1
    else if (token.kind === 'RightBracket' && bracketDepth > 0) bracketDepth -= 1
    else if (token.kind === 'LeftParenthesis') parenthesisDepth += 1
    else if (token.kind === 'RightParenthesis' && parenthesisDepth > 0) parenthesisDepth -= 1

    if (
      token.kind === 'Greater' &&
      braceDepth === 0 &&
      bracketDepth === 0 &&
      parenthesisDepth === 0
    ) {
      break
    }
    token = currentToken(state)
  }

  const node = syntaxNode(state, 'Error', elements)
  const end = elements.filter(SyntaxTree.isToken).at(-1)?.span.end ?? start
  const span = Option.getOrThrowWith(
    SourceSpan.make(state.lexical.source, start, end),
    () => new RangeError(`Parser produced an invalid reserved template span [${start}, ${end})`),
  )
  return {
    state: addDiagnostic(state, Diagnostic.reservedTemplateSyntax(span)),
    node,
  }
}

export const parseEffectExpression = (initial: State): NodeResult => {
  const keyword = expect(initial, 'EffectKeyword', ['LeftBrace', ...expressionFollowing])
  const block = parseBlock(keyword.state, true)
  return {
    state: block.state,
    node: syntaxNode(block.state, 'EffectExpression', [...keyword.elements, block.node]),
  }
}

const anonymousCallableFollowing: ReadonlyArray<Token.TokenKind> = [
  'Comma',
  'RightParenthesis',
  'RightBracket',
  'RightBrace',
  ...expressionFollowing,
  'EndOfFile',
]

const parseMissingAnonymousCallableBlock = (initial: State): NodeResult => {
  const leftBrace = expect(initial, 'LeftBrace', anonymousCallableFollowing)
  return {
    state: leftBrace.state,
    node: syntaxNode(leftBrace.state, 'Block', leftBrace.elements),
  }
}

/** Parses an ordinary or effectful anonymous callable with an explicit source contract. */
export const parseAnonymousCallableExpression = (initial: State): NodeResult => {
  const effectKeyword =
    nextSignificantKind(initial) === 'EffectKeyword'
      ? expect(initial, 'EffectKeyword', ['FnKeyword', ...anonymousCallableFollowing])
      : undefined
  const fnKeyword = expect(effectKeyword?.state ?? initial, 'FnKeyword', [
    'LeftParenthesis',
    ...anonymousCallableFollowing,
  ])
  const parameters = parseParameterList(fnKeyword.state)
  const returnType = parseReturnType(parameters.state, [
    'Bang',
    'Question',
    'LeftBrace',
    ...anonymousCallableFollowing,
  ])
  const failureRow =
    nextSignificantKind(returnType.state) === 'Bang'
      ? parseFailureRow(returnType.state, ['Question', 'LeftBrace', ...anonymousCallableFollowing])
      : undefined
  const requirementRow =
    nextSignificantKind(failureRow?.state ?? returnType.state) === 'Question'
      ? parseRequirementRow(failureRow?.state ?? returnType.state, [
          'LeftBrace',
          ...anonymousCallableFollowing,
        ])
      : undefined
  const afterContract = requirementRow?.state ?? failureRow?.state ?? returnType.state
  const unitResult = SyntaxTree.directNode(returnType.node, 'UnitType') !== undefined
  const block =
    nextSignificantKind(afterContract) === 'LeftBrace'
      ? parseBlock(afterContract, !unitResult, unitResult)
      : parseMissingAnonymousCallableBlock(afterContract)
  return {
    state: block.state,
    node: syntaxNode(block.state, 'AnonymousCallableExpression', [
      ...(effectKeyword?.elements ?? []),
      ...fnKeyword.elements,
      parameters.node,
      returnType.node,
      ...(failureRow === undefined ? [] : [failureRow.node]),
      ...(requirementRow === undefined ? [] : [requirementRow.node]),
      block.node,
    ]),
  }
}

export const parseCompileErrorExpression = (
  initial: State,
  reservedForEnclosingCalls: number,
  depth: number,
): NodeResult => {
  const keyword = expect(initial, 'CompileErrorKeyword', [
    'LeftParenthesis',
    ...expressionFollowing,
  ])
  const left = expect(keyword.state, 'LeftParenthesis', [
    ...expressionStarts,
    'RightParenthesis',
    ...expressionFollowing,
  ])
  const message = parseChildExpression(left.state, depth, true, (childDepth) =>
    parseExpression(left.state, reservedForEnclosingCalls + 1, 'Identifier', true, childDepth),
  )
  const right = expectCallRightParenthesis(message.state, reservedForEnclosingCalls)
  return {
    state: right.state,
    node: syntaxNode(right.state, 'CompileErrorExpression', [
      ...keyword.elements,
      ...left.elements,
      message.node,
      ...right.elements,
    ]),
  }
}

/** Parses the expression form that acknowledges exactly one direct invocation. */
export const parseUnsafeExpression = (
  initial: State,
  reservedForEnclosingCalls: number,
  depth: number,
): NodeResult => {
  const keyword = expect(initial, 'UnsafeKeyword', ['Identifier', ...expressionFollowing])
  const call = parseChildExpression(keyword.state, depth, true, (childDepth) =>
    parseCallExpression(keyword.state, reservedForEnclosingCalls, childDepth),
  )
  return {
    state: call.state,
    node: syntaxNode(call.state, 'UnsafeExpression', [...keyword.elements, call.node]),
  }
}

export function parsePrimaryExpression(
  initial: State,
  reservedForEnclosingCalls: number,
  recoveryKind: 'Integer' | 'Identifier',
  allowStructLiteral: boolean,
  depth: number,
): NodeResult {
  const kind = primaryKind(initial, recoveryKind, allowStructLiteral)
  if (kind === 'ReservedTemplate') return parseReservedTemplateExpression(initial)
  if (kind === 'CompileError')
    return parseCompileErrorExpression(initial, reservedForEnclosingCalls, depth)
  if (kind === 'Call') return parseCallExpression(initial, reservedForEnclosingCalls, depth)
  if (kind === 'StructLiteral')
    return parseStructLiteralExpression(initial, reservedForEnclosingCalls, depth)
  if (kind === 'AppliedMember')
    return parseAppliedMemberExpression(initial, reservedForEnclosingCalls, depth)
  if (kind === 'ContextualRecordLiteral')
    return parseContextualRecordLiteralExpression(initial, reservedForEnclosingCalls, depth)
  if (kind === 'ArrayLiteral')
    return parseArrayLiteralExpression(initial, reservedForEnclosingCalls, depth)
  if (kind === 'Match') return parseMatchExpression(initial, reservedForEnclosingCalls, depth)
  if (kind === 'AnonymousCallable') return parseAnonymousCallableExpression(initial)
  if (kind === 'Effect') return parseEffectExpression(initial)
  if (kind === 'Unsafe') return parseUnsafeExpression(initial, reservedForEnclosingCalls, depth)
  if (kind === 'Run') {
    const keyword = expect(initial, 'RunKeyword', [...expressionStarts, ...expressionFollowing])
    const operand = parseChildExpression(keyword.state, depth, allowStructLiteral, (childDepth) =>
      parseExpression(
        keyword.state,
        reservedForEnclosingCalls,
        recoveryKind,
        allowStructLiteral,
        childDepth,
      ),
    )
    return {
      state: operand.state,
      node: syntaxNode(operand.state, 'RunExpression', [...keyword.elements, operand.node]),
    }
  }
  if (kind === 'Move') {
    const keyword = expect(initial, 'MoveKeyword', ['Identifier', ...expressionFollowing])
    const projected = parseChildExpression(keyword.state, depth, true, (childDepth) =>
      parseProjectionChain(parseIdentifierExpression(keyword.state), childDepth),
    )
    return {
      state: projected.state,
      node: syntaxNode(projected.state, 'MoveExpression', [...keyword.elements, projected.node]),
    }
  }
  if (kind === 'Borrow') {
    const ampersand = expect(initial, 'Ampersand', ['MutKeyword', ...expressionStarts])
    const mut =
      nextSignificantKind(ampersand.state) === 'MutKeyword'
        ? expect(ampersand.state, 'MutKeyword', expressionStarts)
        : undefined
    const operandState = mut?.state ?? ampersand.state
    const operand = parseChildExpression(operandState, depth, allowStructLiteral, (childDepth) =>
      parseProjectionChain(
        parsePrimaryExpression(
          operandState,
          reservedForEnclosingCalls,
          recoveryKind,
          allowStructLiteral,
          childDepth,
        ),
        childDepth,
      ),
    )
    return {
      state: operand.state,
      node: syntaxNode(operand.state, 'BorrowExpression', [
        ...ampersand.elements,
        ...(mut?.elements ?? []),
        operand.node,
      ]),
    }
  }
  if (kind === 'Boolean') return parseBooleanLiteralExpression(initial)
  if (kind === 'StaticText') return parseStaticTextLiteralExpression(initial)
  if (kind === 'Character') return parseCharacterLiteralExpression(initial)
  if (kind === 'Duration') return parseDurationLiteralExpression(initial)
  if (kind === 'Floating') return parseFloatingLiteralExpression(initial)
  if (kind === 'Identifier') return parseIdentifierExpression(initial)
  if (kind === 'Grouped') return parseGroupedExpression(initial, reservedForEnclosingCalls, depth)
  return parseIntegerLiteralExpression(initial)
}

/** True when a line break separates the parser position from the next significant token. */
const lineBreakBefore = (state: State): boolean => {
  for (let index = state.index; index < state.lexical.tokens.length; index += 1) {
    const token = state.lexical.tokens.at(index)
    if (token === undefined || !isTrivia(token.kind)) return false
    if (
      token.kind === 'Whitespace' &&
      Option.exists(SourceFile.spelling(state.lexical.source, token.span), (text) =>
        text.includes('\n'),
      )
    )
      return true
  }
  return false
}

export function parseProjectionChain(initial: NodeResult, depth: number): NodeResult {
  let result = initial
  while (
    nextSignificantKind(result.state) === 'Dot' ||
    // An index projection stays on the line of its subject: a `[` opening the next line starts a
    // new construct, such as a fixed-array type pattern in the next match arm.
    (nextSignificantKind(result.state) === 'LeftBracket' && !lineBreakBefore(result.state)) ||
    nextSignificantKind(result.state) === 'LeftParenthesis' ||
    (result.node.kind === 'AppliedMemberExpression' &&
      hasCompleteAppliedMemberCallSuffix(result.state))
  ) {
    if (
      result.node.kind === 'AppliedMemberExpression' &&
      hasCompleteAppliedMemberCallSuffix(result.state)
    ) {
      const typeArguments = parseTypeArgumentList(result.state, 'CallTypeArgumentList', [
        'LeftParenthesis',
      ])
      const arguments_ = parseArgumentList(typeArguments.state, 0, depth)
      result = {
        state: arguments_.state,
        node: syntaxNode(arguments_.state, 'CallExpression', [
          result.node,
          typeArguments.node,
          arguments_.node,
        ]),
      }
      continue
    }
    if (nextSignificantKind(result.state) === 'LeftParenthesis') {
      const arguments_ = parseArgumentList(result.state, 0, depth)
      result = {
        state: arguments_.state,
        node: syntaxNode(arguments_.state, 'CallExpression', [result.node, arguments_.node]),
      }
      continue
    }
    if (nextSignificantKind(result.state) === 'Dot') {
      const dot = expect(result.state, 'Dot', [
        'Identifier',
        'Star',
        'DecimalInteger',
        ...expressionFollowing,
      ])
      if (nextSignificantKind(dot.state) === 'Star') {
        const star = expect(dot.state, 'Star', expressionFollowing)
        result = {
          state: star.state,
          node: syntaxNode(star.state, 'ReferentProjectionExpression', [
            result.node,
            ...dot.elements,
            ...star.elements,
          ]),
        }
        continue
      }
      if (nextSignificantKind(dot.state) === 'DecimalInteger') {
        const ordinal = expect(dot.state, 'DecimalInteger', expressionFollowing)
        result = {
          state: ordinal.state,
          node: syntaxNode(ordinal.state, 'OrdinalProjectionExpression', [
            result.node,
            ...dot.elements,
            ...ordinal.elements,
          ]),
        }
        continue
      }
      const field = expect(
        dot.state,
        nextSignificantKind(dot.state) === 'DropKeyword' ? 'DropKeyword' : 'Identifier',
        expressionFollowing,
      )
      result = {
        state: field.state,
        node: syntaxNode(field.state, 'FieldProjectionExpression', [
          result.node,
          ...dot.elements,
          ...field.elements,
        ]),
      }
      continue
    }
    const left = expect(result.state, 'LeftBracket', [...expressionStarts, 'RightBracket'])
    const index = parseChildExpression(left.state, depth, true, (childDepth) =>
      parseExpression(left.state, 0, 'Identifier', true, childDepth),
    )
    const right = expect(index.state, 'RightBracket', [
      'Dot',
      'LeftBracket',
      ...expressionFollowing,
    ])
    result = {
      state: right.state,
      node: syntaxNode(right.state, 'IndexProjectionExpression', [
        result.node,
        ...left.elements,
        index.node,
        ...right.elements,
      ]),
    }
  }
  return result
}

export function parsePrefixExpression(
  initial: State,
  reservedForEnclosingCalls: number,
  recoveryKind: 'Integer' | 'Identifier',
  allowStructLiteral: boolean,
  depth: number,
): NodeResult {
  const kind = primaryKind(initial, recoveryKind, allowStructLiteral)
  if (kind !== 'Prefix')
    return parseProjectionChain(
      parsePrimaryExpression(
        initial,
        reservedForEnclosingCalls,
        recoveryKind,
        allowStructLiteral,
        depth,
      ),
      depth,
    )
  const nextKind = nextSignificantKind(initial)
  const tokenKind = nextKind === 'Bang' || nextKind === 'Tilde' ? nextKind : 'Minus'
  const operator = expect(initial, tokenKind, [...expressionStarts, ...expressionFollowing])
  const operand = parseChildExpression(operator.state, depth, allowStructLiteral, (childDepth) =>
    parsePrefixExpression(
      operator.state,
      reservedForEnclosingCalls,
      recoveryKind,
      allowStructLiteral,
      childDepth,
    ),
  )
  return {
    state: operand.state,
    node: syntaxNode(operand.state, 'PrefixExpression', [...operator.elements, operand.node]),
  }
}

export function parseInfixExpression(
  initial: State,
  reservedForEnclosingCalls: number,
  recoveryKind: 'Integer' | 'Identifier',
  minimumPrecedence: number,
  allowStructLiteral: boolean,
  depth: number,
): NodeResult {
  let left = parsePrefixExpression(
    initial,
    reservedForEnclosingCalls,
    recoveryKind,
    allowStructLiteral,
    depth,
  )
  let nonAssociativePrecedence: number | undefined
  // Each iteration nests the accumulated left operand one edge deeper, so the chain length counts
  // toward the EXPR-006 budget exactly as an explicitly nested tree would.
  let chainDepth = depth

  for (;;) {
    const kind = nextSignificantKind(left.state)
    if (kind === undefined) break
    const info = Operator.infix(kind)
    if (info === undefined || info.precedence < minimumPrecedence) break
    if (info.associativity === 'None' && nonAssociativePrecedence === info.precedence) break

    const operator = expect(left.state, kind, [...expressionStarts, ...expressionFollowing])
    const right = parseChildExpression(
      operator.state,
      chainDepth,
      allowStructLiteral,
      (childDepth) =>
        parseInfixExpression(
          operator.state,
          reservedForEnclosingCalls,
          recoveryKind,
          info.precedence + 1,
          allowStructLiteral,
          childDepth,
        ),
    )
    left = {
      state: right.state,
      node: syntaxNode(right.state, 'InfixExpression', [
        left.node,
        ...operator.elements,
        right.node,
      ]),
    }
    if (right.node.kind === 'Error') break
    chainDepth = ExpressionNesting.child(chainDepth)
    if (info.associativity === 'None') nonAssociativePrecedence = info.precedence
  }

  return left
}

export function parseExpression(
  initial: State,
  reservedForEnclosingCalls: number,
  recoveryKind: 'Integer' | 'Identifier',
  allowStructLiteral = true,
  depth = ExpressionNesting.root,
): NodeResult {
  const activeDepth = Math.max(depth, initial.expressionDepth ?? ExpressionNesting.root)
  let left = parseInfixExpression(
    initial,
    reservedForEnclosingCalls,
    recoveryKind,
    0,
    allowStructLiteral,
    activeDepth,
  )
  let chainDepth = activeDepth
  while (nextSignificantKind(left.state) === 'PipeGreater') {
    const pipe = expect(left.state, 'PipeGreater', [...expressionStarts, ...expressionFollowing])
    const target = parseChildExpression(pipe.state, chainDepth, allowStructLiteral, (childDepth) =>
      parseInfixExpression(
        pipe.state,
        reservedForEnclosingCalls,
        'Identifier',
        0,
        allowStructLiteral,
        childDepth,
      ),
    )
    left = {
      state: target.state,
      node: syntaxNode(target.state, 'PipelineExpression', [
        left.node,
        ...pipe.elements,
        target.node,
      ]),
    }
    if (target.node.kind === 'Error') break
    chainDepth = ExpressionNesting.child(chainDepth)
  }
  return left
}
