import * as Diagnostic from '../Diagnostic.js'
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
  syntaxNode,
} from '../internal/ParseState.js'
import * as Operator from '../Operator.js'
import * as SyntaxTree from '../SyntaxTree.js'
import * as Token from '../Token.js'
import {
  hasContextualSpelling,
  hasContextualSpellingAt,
  parseExpression,
  parseIntegerLiteralExpression,
} from './Expression.js'
import * as ExpressionNesting from './ExpressionNesting.js'
import { expressionStarts, topLevelFollowing, typeStarts } from './Grammar.js'
import { parseImportDeclaration } from './Import.js'
import { parseBlock, parseImplicitUnitReturnStatement } from './Statement.js'
import {
  parseFailureRow,
  parseEffectEnvironmentLifetimes,
  parseParameterList,
  parseRequirementRow,
  parseReturnType,
  parseType,
  parseTypeParameterList,
  parseTypePath,
  parseWhereClause,
} from './Type.js'

/** `extern` and `export` mark a function header with a native ABI literal in the same slot. */
const isAbiMarker = (
  kind: Token.TokenKind | undefined,
): kind is 'ExternKeyword' | 'ExportKeyword' => kind === 'ExternKeyword' || kind === 'ExportKeyword'

/**
 * `static` opens a function declaration before `fn`, or before a foreign or exported header whose
 * `static` is retained for semantic rejection.
 */
const staticBeginsFunction = (state: State, offset: number): boolean => {
  const following = peek(state, offset)
  return (
    following === 'FnKeyword' ||
    isAbiMarker(following) ||
    (following === 'UnsafeKeyword' && isAbiMarker(peek(state, offset + 1)))
  )
}

/** `test` stays an identifier outside the declaration-modifier position. */
const testBeginsFunction = (state: State, offset: number): boolean => {
  if (!hasContextualSpellingAt(state, 'test', offset)) return false
  const following = peek(state, offset + 1)
  return (
    following === 'FnKeyword' ||
    following === 'EffectKeyword' ||
    following === 'StaticKeyword' ||
    following === 'UnsafeKeyword' ||
    isAbiMarker(following)
  )
}

/** Recognizes the ABI-bearing prefix that reserves an existing struct declaration node. */
const externBeginsStruct = (state: State, offset: number): boolean => {
  if (peek(state, offset) !== 'ExternKeyword') return false
  const following = peek(state, offset + 1)
  return (
    following === 'StructKeyword' ||
    (following === 'TextLiteral' && peek(state, offset + 2) === 'StructKeyword')
  )
}

/** Recognizes either foreign-static spelling without treating ordinary static functions as data. */
const beginsForeignStatic = (state: State): boolean => {
  const kind = nextSignificantKind(state)
  if (kind === 'UnsafeKeyword')
    return (
      peek(state, 1) === 'ExternKeyword' &&
      peek(state, 2) === 'TextLiteral' &&
      peek(state, 3) === 'StaticKeyword'
    )
  return (
    kind === 'ExportKeyword' &&
    peek(state, 1) === 'TextLiteral' &&
    peek(state, 2) === 'StaticKeyword'
  )
}

export const beginsTopLevelDeclaration = (state: State): boolean => {
  const kind = nextSignificantKind(state)
  if (testBeginsFunction(state, 0)) return true
  if (kind === 'StaticKeyword')
    return peek(state, 1) === 'IfKeyword' || staticBeginsFunction(state, 1)
  if (
    kind === 'ImportKeyword' ||
    kind === 'ConstKeyword' ||
    kind === 'ParamKeyword' ||
    kind === 'FnKeyword' ||
    kind === 'EffectKeyword' ||
    kind === 'UnsafeKeyword' ||
    isAbiMarker(kind) ||
    kind === 'StructKeyword' ||
    kind === 'TupleKeyword' ||
    kind === 'EnumKeyword' ||
    kind === 'UnionKeyword' ||
    kind === 'TypeKeyword' ||
    kind === 'ServiceKeyword' ||
    kind === 'InterfaceKeyword' ||
    kind === 'RoleKeyword' ||
    kind === 'ImplKeyword'
  )
    return true
  if (kind !== 'PubKeyword') return false
  const following = peek(state, 1)
  return (
    following === 'ImportKeyword' ||
    testBeginsFunction(state, 1) ||
    (following === 'StaticKeyword' && staticBeginsFunction(state, 2)) ||
    following === 'FnKeyword' ||
    following === 'EffectKeyword' ||
    isAbiMarker(following) ||
    (following === 'UnsafeKeyword' &&
      (peek(state, 2) === 'FnKeyword' ||
        peek(state, 2) === 'EffectKeyword' ||
        isAbiMarker(peek(state, 2)))) ||
    following === 'StructKeyword' ||
    following === 'TupleKeyword' ||
    following === 'EnumKeyword' ||
    following === 'UnionKeyword' ||
    following === 'TypeKeyword' ||
    following === 'ServiceKeyword' ||
    following === 'InterfaceKeyword' ||
    following === 'RoleKeyword' ||
    following === 'ConstKeyword' ||
    following === 'ParamKeyword'
  )
}

const parseInvalidStaticDeclaration = (initial: State): NodeResult => {
  const leading = consumeTrivia(initial)
  let state = leading.state
  let children: ReadonlyArray<SyntaxTree.Element> = leading.elements
  let braces = 0
  let sawBrace = false
  let token = currentToken(state)

  while (token !== undefined && token.kind !== 'EndOfFile') {
    if (children.length > leading.elements.length && sawBrace && braces === 0) {
      if (beginsTopLevelDeclaration(state)) break
    }
    children = [...children, token]
    state = advance(state)
    if (token.kind === 'LeftBrace') {
      sawBrace = true
      braces += 1
    } else if (token.kind === 'RightBrace' && braces > 0) {
      braces -= 1
    }
    token = currentToken(state)
  }

  const node = syntaxNode(state, 'Error', children)
  return {
    state: addDiagnostic(
      state,
      Diagnostic.unexpectedTokens(
        children.filter(SyntaxTree.isToken).map((item) => item.kind),
        'syntax',
        ['`static fn`'],
        node.span,
      ),
    ),
    node,
  }
}

export const parseConstantDeclaration = (initial: State): NodeResult => {
  const hasPublicModifier = nextSignificantKind(initial) === 'PubKeyword'
  const pubKeyword = hasPublicModifier
    ? expect(initial, 'PubKeyword', ['ConstKeyword', 'Identifier', ...topLevelFollowing])
    : { state: initial, elements: [] }
  const keyword = expect(pubKeyword.state, 'ConstKeyword', [
    'Identifier',
    'Colon',
    ...topLevelFollowing,
  ])
  const name = expect(keyword.state, 'Identifier', ['Colon', ...typeStarts, ...topLevelFollowing])
  const colon = expect(name.state, 'Colon', [...typeStarts, 'Equals', ...topLevelFollowing])
  const type = parseType(colon.state, ['Equals', ...topLevelFollowing])
  const equals = expect(type.state, 'Equals', [...expressionStarts, ...topLevelFollowing])
  const initializer = parseExpression(equals.state, 0, 'Integer', false, ExpressionNesting.root)
  return {
    state: initializer.state,
    node: syntaxNode(initializer.state, 'ConstantDeclaration', [
      ...pubKeyword.elements,
      ...keyword.elements,
      ...name.elements,
      ...colon.elements,
      type.node,
      ...equals.elements,
      initializer.node,
    ]),
  }
}

/** An unconditional package-owned static parameter with optional default and validation. */
export const parsePackageParameterDeclaration = (initial: State): NodeResult => {
  const pubKeyword =
    nextSignificantKind(initial) === 'PubKeyword'
      ? expect(initial, 'PubKeyword', ['ParamKeyword', ...topLevelFollowing])
      : { state: initial, elements: [] }
  const keyword = expect(pubKeyword.state, 'ParamKeyword', ['Identifier', ...topLevelFollowing])
  const name = expect(keyword.state, 'Identifier', ['Colon', ...topLevelFollowing])
  const colon = expect(name.state, 'Colon', [...typeStarts, ...topLevelFollowing])
  const type = parseType(colon.state, ['Equals', ...topLevelFollowing])
  let state = type.state
  const children: Array<SyntaxTree.Element> = [
    ...pubKeyword.elements,
    ...keyword.elements,
    ...name.elements,
    ...colon.elements,
    type.node,
  ]
  if (nextSignificantKind(state) === 'Equals') {
    const equals = expect(state, 'Equals', expressionStarts)
    const initializer = parseExpression(equals.state, 0, 'Integer', false, ExpressionNesting.root)
    state = initializer.state
    children.push(...equals.elements, initializer.node)
  }
  if (hasContextualSpelling(state, 'where')) {
    const where = expect(state, 'Identifier', expressionStarts)
    const predicate = parseExpression(where.state, 0, 'Integer', false, ExpressionNesting.root)
    state = predicate.state
    children.push(
      syntaxNode(state, 'PackageParameterValidation', [...where.elements, predicate.node]),
    )
  }
  return { state, node: syntaxNode(state, 'PackageParameterDeclaration', children) }
}

/** Parses an imported or exported C data symbol. Both forms are immutable Silk bindings. */
export const parseForeignStaticDeclaration = (initial: State): NodeResult => {
  const imported = nextSignificantKind(initial) === 'UnsafeKeyword'
  const unsafeKeyword = imported
    ? expect(initial, 'UnsafeKeyword', ['ExternKeyword', 'TextLiteral', 'StaticKeyword'])
    : { state: initial, elements: [] }
  const markerKind = imported ? 'ExternKeyword' : 'ExportKeyword'
  const marker = expect(unsafeKeyword.state, markerKind, ['TextLiteral', 'StaticKeyword'])
  const abi = expect(marker.state, 'TextLiteral', ['StaticKeyword', 'Identifier'])
  const staticKeyword = expect(abi.state, 'StaticKeyword', ['Identifier', 'Colon'])
  const name = expect(staticKeyword.state, 'Identifier', ['Colon', ...typeStarts])
  const colon = expect(name.state, 'Colon', [...typeStarts, 'AsKeyword', 'Equals'])
  const type = parseType(colon.state, ['AsKeyword', 'Equals', ...topLevelFollowing])
  const symbol = parseSymbolTail(type.state, ['Equals', ...topLevelFollowing])
  if (imported) {
    const properties = parseFunctionPropertyList(symbol.state)
    return {
      state: properties.state,
      node: syntaxNode(properties.state, 'ForeignStaticDeclaration', [
        ...unsafeKeyword.elements,
        ...marker.elements,
        ...abi.elements,
        ...staticKeyword.elements,
        ...name.elements,
        ...colon.elements,
        type.node,
        ...symbol.elements,
        ...properties.elements,
      ]),
    }
  }
  const equals = expect(symbol.state, 'Equals', [...expressionStarts, ...topLevelFollowing])
  const initializer = parseExpression(equals.state, 0, 'Integer', false, ExpressionNesting.root)
  return {
    state: initializer.state,
    node: syntaxNode(initializer.state, 'ExportStaticDeclaration', [
      ...marker.elements,
      ...abi.elements,
      ...staticKeyword.elements,
      ...name.elements,
      ...colon.elements,
      type.node,
      ...symbol.elements,
      ...equals.elements,
      initializer.node,
    ]),
  }
}

export const parseTypeAliasDeclaration = (initial: State): NodeResult => {
  const hasPublicModifier = nextSignificantKind(initial) === 'PubKeyword'
  const pubKeyword = hasPublicModifier
    ? expect(initial, 'PubKeyword', ['TypeKeyword', 'Identifier', ...topLevelFollowing])
    : { state: initial, elements: [] }
  const keyword = expect(pubKeyword.state, 'TypeKeyword', [
    'Identifier',
    'Equals',
    ...topLevelFollowing,
  ])
  const name = expect(keyword.state, 'Identifier', [
    'Less',
    'Equals',
    ...typeStarts,
    ...topLevelFollowing,
  ])
  // The parameter list is retained so semantic analysis can reject it at its exact span.
  const typeParameters =
    nextSignificantKind(name.state) === 'Less'
      ? parseTypeParameterList(name.state, ['Equals'])
      : undefined
  const equals = expect(typeParameters?.state ?? name.state, 'Equals', [
    ...typeStarts,
    ...topLevelFollowing,
  ])
  const target = parseType(equals.state, topLevelFollowing)
  return {
    state: target.state,
    node: syntaxNode(target.state, 'TypeAliasDeclaration', [
      ...pubKeyword.elements,
      ...keyword.elements,
      ...name.elements,
      ...(typeParameters === undefined ? [] : [typeParameters.node]),
      ...equals.elements,
      target.node,
    ]),
  }
}

export const parseRoleDeclaration = (initial: State): NodeResult => {
  const hasPublicModifier = nextSignificantKind(initial) === 'PubKeyword'
  const pubKeyword = hasPublicModifier
    ? expect(initial, 'PubKeyword', ['RoleKeyword', 'Identifier', ...topLevelFollowing])
    : { state: initial, elements: [] }
  const keyword = expect(pubKeyword.state, 'RoleKeyword', ['Identifier', ...topLevelFollowing])
  const name = expect(keyword.state, 'Identifier', topLevelFollowing)
  return {
    state: name.state,
    node: syntaxNode(name.state, 'RoleDeclaration', [
      ...pubKeyword.elements,
      ...keyword.elements,
      ...name.elements,
    ]),
  }
}

export const parseStructField = (initial: State): NodeResult => {
  const hasPublicModifier = nextSignificantKind(initial) === 'PubKeyword'
  const pubKeyword = hasPublicModifier
    ? expect(initial, 'PubKeyword', ['Identifier', 'RightBrace', ...topLevelFollowing])
    : { state: initial, elements: [] }
  const name = expect(pubKeyword.state, 'Identifier', ['Colon', 'RightBrace', ...topLevelFollowing])
  const colon = expect(name.state, 'Colon', [...typeStarts, 'RightBrace', ...topLevelFollowing])
  const type = parseType(colon.state, ['PubKeyword', 'RightBrace', ...topLevelFollowing], true)
  return {
    state: type.state,
    node: syntaxNode(type.state, 'StructField', [
      ...pubKeyword.elements,
      ...name.elements,
      ...colon.elements,
      type.node,
    ]),
  }
}

export const parseEnumMember = (initial: State): NodeResult => {
  const name = expect(initial, 'Identifier', [
    'Equals',
    'Comma',
    'RightBrace',
    ...topLevelFollowing,
  ])
  if (nextSignificantKind(name.state) !== 'Equals') {
    return {
      state: name.state,
      node: syntaxNode(name.state, 'EnumMember', name.elements),
    }
  }

  const equals = expect(name.state, 'Equals', [
    'Minus',
    'DecimalInteger',
    'Comma',
    'RightBrace',
    ...topLevelFollowing,
  ])
  const discriminant = parseIntegerLiteralExpression(equals.state)
  return {
    state: discriminant.state,
    node: syntaxNode(discriminant.state, 'EnumMember', [
      ...name.elements,
      ...equals.elements,
      discriminant.node,
    ]),
  }
}

export const parseEnumDeclaration = (initial: State): NodeResult => {
  const hasPublicModifier = nextSignificantKind(initial) === 'PubKeyword'
  const pubKeyword = hasPublicModifier
    ? expect(initial, 'PubKeyword', ['EnumKeyword', 'LeftParenthesis', 'Identifier', 'LeftBrace'])
    : { state: initial, elements: [] }
  const keyword = expect(pubKeyword.state, 'EnumKeyword', [
    'LeftParenthesis',
    'Identifier',
    'LeftBrace',
  ])
  const representationLeft =
    nextSignificantKind(keyword.state) === 'LeftParenthesis'
      ? expect(keyword.state, 'LeftParenthesis', [...typeStarts, 'RightParenthesis', 'Identifier'])
      : undefined
  const representation =
    representationLeft === undefined
      ? undefined
      : parseType(representationLeft.state, ['RightParenthesis', 'Identifier', 'LeftBrace'])
  const representationRight =
    representation === undefined
      ? undefined
      : expect(representation.state, 'RightParenthesis', ['Identifier', 'LeftBrace'])
  const afterRepresentation = representationRight?.state ?? keyword.state
  const name = expect(afterRepresentation, 'Identifier', ['LeftBrace', ...topLevelFollowing])
  const left = expect(name.state, 'LeftBrace', ['Identifier', 'RightBrace', ...topLevelFollowing])
  let state = left.state
  let children: ReadonlyArray<SyntaxTree.Element> = [
    ...pubKeyword.elements,
    ...keyword.elements,
    ...(representationLeft?.elements ?? []),
    ...(representation === undefined ? [] : [representation.node]),
    ...(representationRight?.elements ?? []),
    ...name.elements,
    ...left.elements,
  ]

  while (
    !beginsTopLevelDeclaration(state) &&
    nextSignificantKind(state) !== 'RightBrace' &&
    nextSignificantKind(state) !== 'EndOfFile'
  ) {
    const member = parseEnumMember(state)
    children = [...children, member.node]
    state = member.state
    if (nextSignificantKind(state) === 'RightBrace') break
    const comma = expect(state, 'Comma', ['Identifier', 'RightBrace', ...topLevelFollowing])
    children = [...children, ...comma.elements]
    state = comma.state
    if (nextSignificantKind(state) === 'RightBrace') break
  }

  const right = expect(state, 'RightBrace', topLevelFollowing)
  return {
    state: right.state,
    node: syntaxNode(right.state, 'EnumDeclaration', [...children, ...right.elements]),
  }
}

export const parseStructDeclaration = (initial: State): NodeResult => {
  const hasPublicModifier = nextSignificantKind(initial) === 'PubKeyword'
  const pubKeyword = hasPublicModifier
    ? expect(initial, 'PubKeyword', ['ExternKeyword', 'StructKeyword', 'Identifier', 'LeftBrace'])
    : { state: initial, elements: [] }
  const hasForeignLayout = nextSignificantKind(pubKeyword.state) === 'ExternKeyword'
  const externKeyword = hasForeignLayout
    ? expect(pubKeyword.state, 'ExternKeyword', ['TextLiteral', 'StructKeyword'])
    : { state: pubKeyword.state, elements: [] }
  const abi = hasForeignLayout
    ? expect(externKeyword.state, 'TextLiteral', ['StructKeyword'])
    : { state: externKeyword.state, elements: [] }
  const keyword = expect(abi.state, 'StructKeyword', ['Identifier', 'LeftBrace'])
  const name = expect(keyword.state, 'Identifier', ['Less', 'LeftBrace', ...topLevelFollowing])
  const typeParameters =
    nextSignificantKind(name.state) === 'Less'
      ? parseTypeParameterList(name.state, ['LeftBrace'])
      : undefined
  const afterName = typeParameters?.state ?? name.state
  const left = expect(afterName, 'LeftBrace', [
    'PubKeyword',
    'Identifier',
    'RightBrace',
    ...topLevelFollowing,
  ])
  let state = left.state
  let children: ReadonlyArray<SyntaxTree.Element> = [
    ...pubKeyword.elements,
    ...externKeyword.elements,
    ...abi.elements,
    ...keyword.elements,
    ...name.elements,
    ...(typeParameters === undefined ? [] : [typeParameters.node]),
    ...left.elements,
  ]

  while (
    !beginsTopLevelDeclaration(state) &&
    (nextSignificantKind(state) === 'PubKeyword' || nextSignificantKind(state) === 'Identifier')
  ) {
    const field = parseStructField(state)
    children = [...children, field.node]
    state = field.state
  }

  const right = expect(state, 'RightBrace', topLevelFollowing)
  return {
    state: right.state,
    node: syntaxNode(right.state, 'StructDeclaration', [...children, ...right.elements]),
  }
}

/** Parses the nominal positional aggregate declaration `tuple Name(T0, T1, ...)`. */
export const parseTupleDeclaration = (initial: State): NodeResult => {
  const hasPublicModifier = nextSignificantKind(initial) === 'PubKeyword'
  const pubKeyword = hasPublicModifier
    ? expect(initial, 'PubKeyword', ['TupleKeyword', 'Identifier', 'LeftParenthesis'])
    : { state: initial, elements: [] }
  const keyword = expect(pubKeyword.state, 'TupleKeyword', ['Identifier', 'LeftParenthesis'])
  const name = expect(keyword.state, 'Identifier', [
    'Less',
    'LeftParenthesis',
    ...topLevelFollowing,
  ])
  const typeParameters =
    nextSignificantKind(name.state) === 'Less'
      ? parseTypeParameterList(name.state, ['LeftParenthesis'])
      : undefined
  const left = expect(typeParameters?.state ?? name.state, 'LeftParenthesis', [
    ...typeStarts,
    'RightParenthesis',
  ])
  let state = left.state
  let children: ReadonlyArray<SyntaxTree.Element> = [
    ...pubKeyword.elements,
    ...keyword.elements,
    ...name.elements,
    ...(typeParameters === undefined ? [] : [typeParameters.node]),
    ...left.elements,
  ]
  let first = true
  while (
    nextSignificantKind(state) !== 'RightParenthesis' &&
    nextSignificantKind(state) !== 'EndOfFile' &&
    !beginsTopLevelDeclaration(state)
  ) {
    if (!first) {
      const comma = expect(state, 'Comma', [...typeStarts, 'RightParenthesis'])
      children = [...children, ...comma.elements]
      state = comma.state
      if (nextSignificantKind(state) === 'RightParenthesis') break
    }
    const element = parseType(state, ['Comma', 'RightParenthesis', ...topLevelFollowing], true)
    children = [...children, element.node]
    state = element.state
    first = false
  }
  const right = expect(state, 'RightParenthesis', topLevelFollowing)
  return {
    state: right.state,
    node: syntaxNode(right.state, 'TupleDeclaration', [...children, ...right.elements]),
  }
}

export const parseUnionVariantField = (initial: State): NodeResult => {
  const field = parseStructField(initial)
  return {
    state: field.state,
    node: syntaxNode(field.state, 'UnionVariantField', field.node.children),
  }
}

export const parseUnionVariant = (initial: State): NodeResult => {
  const name = expect(initial, 'Identifier', [
    'LeftBrace',
    'Comma',
    'RightBrace',
    ...topLevelFollowing,
  ])
  if (nextSignificantKind(name.state) !== 'LeftBrace') {
    return {
      state: name.state,
      node: syntaxNode(name.state, 'UnionVariant', name.elements),
    }
  }

  const left = expect(name.state, 'LeftBrace', [
    'PubKeyword',
    'Identifier',
    'RightBrace',
    ...topLevelFollowing,
  ])
  let state = left.state
  let children: ReadonlyArray<SyntaxTree.Element> = [...name.elements, ...left.elements]

  while (
    !beginsTopLevelDeclaration(state) &&
    nextSignificantKind(state) !== 'RightBrace' &&
    nextSignificantKind(state) !== 'EndOfFile'
  ) {
    const field = parseUnionVariantField(state)
    children = [...children, field.node]
    state = field.state
    if (nextSignificantKind(state) === 'RightBrace') break
    const comma = expect(state, 'Comma', [
      'PubKeyword',
      'Identifier',
      'RightBrace',
      ...topLevelFollowing,
    ])
    children = [...children, ...comma.elements]
    state = comma.state
    if (nextSignificantKind(state) === 'RightBrace') break
  }

  const right = expect(state, 'RightBrace', ['Comma', 'Identifier', ...topLevelFollowing])
  return {
    state: right.state,
    node: syntaxNode(right.state, 'UnionVariant', [...children, ...right.elements]),
  }
}

export const parseUnionDeclaration = (initial: State): NodeResult => {
  const hasPublicModifier = nextSignificantKind(initial) === 'PubKeyword'
  const pubKeyword = hasPublicModifier
    ? expect(initial, 'PubKeyword', ['UnionKeyword', 'Identifier', 'LeftBrace'])
    : { state: initial, elements: [] }
  const keyword = expect(pubKeyword.state, 'UnionKeyword', ['Identifier', 'LeftBrace'])
  const name = expect(keyword.state, 'Identifier', ['Less', 'LeftBrace', ...topLevelFollowing])
  const typeParameters =
    nextSignificantKind(name.state) === 'Less'
      ? parseTypeParameterList(name.state, ['LeftBrace'])
      : undefined
  const left = expect(typeParameters?.state ?? name.state, 'LeftBrace', [
    'Identifier',
    'RightBrace',
    ...topLevelFollowing,
  ])
  let state = left.state
  let children: ReadonlyArray<SyntaxTree.Element> = [
    ...pubKeyword.elements,
    ...keyword.elements,
    ...name.elements,
    ...(typeParameters === undefined ? [] : [typeParameters.node]),
    ...left.elements,
  ]

  while (
    !beginsTopLevelDeclaration(state) &&
    nextSignificantKind(state) !== 'RightBrace' &&
    nextSignificantKind(state) !== 'EndOfFile'
  ) {
    const variant = parseUnionVariant(state)
    children = [...children, variant.node]
    state = variant.state
    if (nextSignificantKind(state) === 'RightBrace') break
    const comma = expect(state, 'Comma', ['Identifier', 'RightBrace', ...topLevelFollowing])
    children = [...children, ...comma.elements]
    state = comma.state
    if (nextSignificantKind(state) === 'RightBrace') break
  }

  const right = expect(state, 'RightBrace', topLevelFollowing)
  return {
    state: right.state,
    node: syntaxNode(right.state, 'UnionDeclaration', [...children, ...right.elements]),
  }
}

export const serviceOperationFollowing: ReadonlyArray<Token.TokenKind> = [
  'FnKeyword',
  'EffectKeyword',
  'UnsafeKeyword',
  'RightBrace',
  ...topLevelFollowing,
]

export const startsServiceOperation = (state: State): boolean =>
  nextSignificantKind(state) === 'FnKeyword' ||
  nextSignificantKind(state) === 'EffectKeyword' ||
  nextSignificantKind(state) === 'UnsafeKeyword' ||
  hasContextualSpelling(state, 'operator')

export const parseOperatorMarker = (initial: State): NodeResult => {
  const keyword = expect(initial, 'Identifier', [
    ...Operator.declarationTokenKinds,
    'EffectKeyword',
    'FnKeyword',
    ...serviceOperationFollowing,
  ])
  const kind = nextSignificantKind(keyword.state)
  const token =
    kind !== undefined && Operator.isDeclarationToken(kind)
      ? expect(keyword.state, kind, ['EffectKeyword', 'FnKeyword', ...serviceOperationFollowing])
      : expect(keyword.state, 'Star', ['EffectKeyword', 'FnKeyword', ...serviceOperationFollowing])
  return {
    state: token.state,
    node: syntaxNode(token.state, 'OperatorMarker', [...keyword.elements, ...token.elements]),
  }
}

interface CallableContractTail {
  readonly state: State
  readonly typeParameters?: NodeResult
  readonly parameters: NodeResult
  readonly returnType?: NodeResult
  readonly failureRow?: NodeResult
  readonly requirementRow?: NodeResult
  readonly whereClause?: NodeResult
}

/** Parses the contract suffix shared by functions and service/interface operations. */
const parseCallableContractTail = (
  initial: State,
  following: ReadonlyArray<Token.TokenKind>,
): CallableContractTail => {
  const typeParameters =
    nextSignificantKind(initial) === 'Less'
      ? parseTypeParameterList(initial, ['LeftParenthesis', ...following])
      : undefined
  const parameters = parseParameterList(typeParameters?.state ?? initial)
  const returnType =
    nextSignificantKind(parameters.state) === 'Arrow'
      ? parseReturnType(parameters.state)
      : undefined
  const afterReturnType = returnType?.state ?? parameters.state
  const failureRow =
    nextSignificantKind(afterReturnType) === 'Bang'
      ? parseFailureRow(afterReturnType, ['Question', ...following])
      : undefined
  const requirementRow =
    nextSignificantKind(failureRow?.state ?? afterReturnType) === 'Question'
      ? parseRequirementRow(failureRow?.state ?? afterReturnType, following)
      : undefined
  const afterContract = requirementRow?.state ?? failureRow?.state ?? afterReturnType
  const whereClause = hasContextualSpelling(afterContract, 'where')
    ? parseWhereClause(afterContract, ['LeftBrace', ...following])
    : undefined
  return {
    state: whereClause?.state ?? afterContract,
    ...(typeParameters === undefined ? {} : { typeParameters }),
    parameters,
    ...(returnType === undefined ? {} : { returnType }),
    ...(failureRow === undefined ? {} : { failureRow }),
    ...(requirementRow === undefined ? {} : { requirementRow }),
    ...(whereClause === undefined ? {} : { whereClause }),
  }
}

const parseEffectDeclarationEnvironment = (initial: State): NodeResult => {
  const left = expect(initial, 'Less', ['Lifetime', 'Greater', 'FnKeyword'])
  const lifetime = parseEffectEnvironmentLifetimes(left.state, ['Greater', 'FnKeyword'])
  const right = expect(lifetime.state, 'Greater', ['FnKeyword', 'Identifier'])
  return {
    state: right.state,
    node: syntaxNode(right.state, 'EffectEnvironment', [
      ...left.elements,
      ...lifetime.elements,
      ...right.elements,
    ]),
  }
}

export const parseServiceOperation = (initial: State): NodeResult => {
  const operatorMarker = hasContextualSpelling(initial, 'operator')
    ? parseOperatorMarker(initial)
    : undefined
  const unsafeKeyword =
    nextSignificantKind(operatorMarker?.state ?? initial) === 'UnsafeKeyword'
      ? expect(operatorMarker?.state ?? initial, 'UnsafeKeyword', [
          'EffectKeyword',
          'FnKeyword',
          'Identifier',
          ...serviceOperationFollowing,
        ])
      : {
          state: operatorMarker?.state ?? initial,
          elements: [],
        }
  const effectKeyword =
    nextSignificantKind(unsafeKeyword.state) === 'EffectKeyword'
      ? expect(unsafeKeyword.state, 'EffectKeyword', [
          'Less',
          'FnKeyword',
          'Identifier',
          ...serviceOperationFollowing,
        ])
      : {
          state: unsafeKeyword.state,
          elements: [],
        }
  const effectEnvironment =
    effectKeyword.elements.length > 0 && nextSignificantKind(effectKeyword.state) === 'Less'
      ? parseEffectDeclarationEnvironment(effectKeyword.state)
      : undefined
  const fnKeyword = expect(effectEnvironment?.state ?? effectKeyword.state, 'FnKeyword', [
    'Identifier',
    'LeftParenthesis',
    ...serviceOperationFollowing,
  ])
  const name = expect(fnKeyword.state, 'Identifier', [
    'Less',
    'LeftParenthesis',
    ...serviceOperationFollowing,
  ])
  const contract = parseCallableContractTail(name.state, serviceOperationFollowing)
  const properties = parseFunctionPropertyList(contract.state)
  const body =
    nextSignificantKind(properties.state) === 'LeftBrace'
      ? parseBlock(properties.state, false)
      : undefined
  const state = body?.state ?? properties.state
  return {
    state,
    node: syntaxNode(state, 'ServiceOperation', [
      ...(operatorMarker === undefined ? [] : [operatorMarker.node]),
      ...unsafeKeyword.elements,
      ...effectKeyword.elements,
      ...(effectEnvironment === undefined ? [] : [effectEnvironment.node]),
      ...fnKeyword.elements,
      ...name.elements,
      ...(contract.typeParameters === undefined ? [] : [contract.typeParameters.node]),
      contract.parameters.node,
      ...(contract.returnType === undefined ? [] : [contract.returnType.node]),
      ...(contract.failureRow === undefined ? [] : [contract.failureRow.node]),
      ...(contract.requirementRow === undefined ? [] : [contract.requirementRow.node]),
      ...(contract.whereClause === undefined ? [] : [contract.whereClause.node]),
      ...properties.elements,
      ...(body === undefined ? [] : [body.node]),
    ]),
  }
}

export const parseServiceInvalidMember = (initial: State): NodeResult => {
  const leading = consumeTrivia(initial)
  let state = leading.state
  let token = currentToken(state)
  let unexpected: ReadonlyArray<Token.Token> = []
  while (
    token !== undefined &&
    token.kind !== 'EndOfFile' &&
    !serviceOperationFollowing.includes(token.kind) &&
    !hasContextualSpelling(state, 'operator')
  ) {
    unexpected = [...unexpected, token]
    state = advance(state)
    token = currentToken(state)
  }
  if (unexpected.length === 0) {
    const missing = missingToken(state, 'FnKeyword')
    return {
      state: addDiagnostic(state, Diagnostic.missingToken('FnKeyword', missing.span)),
      node: syntaxNode(state, 'ServiceInvalidMember', [...leading.elements, missing]),
    }
  }
  const error = syntaxNode(state, 'Error', unexpected)
  state = addDiagnostic(
    state,
    Diagnostic.unexpectedTokens(
      unexpected.map((item) => item.kind),
      'syntax',
      [Token.describe('FnKeyword'), Token.describe('EffectKeyword')],
      error.span,
    ),
  )
  return {
    state,
    node: syntaxNode(state, 'ServiceInvalidMember', [...leading.elements, error]),
  }
}

const parseServiceLikeDeclaration = (initial: State, kind: 'Service' | 'Interface'): NodeResult => {
  const keywordKind = kind === 'Service' ? 'ServiceKeyword' : 'InterfaceKeyword'
  const nodeKind = kind === 'Service' ? 'ServiceDeclaration' : 'InterfaceDeclaration'
  const hasPublicModifier = nextSignificantKind(initial) === 'PubKeyword'
  const pubKeyword = hasPublicModifier
    ? expect(initial, 'PubKeyword', [keywordKind, 'Identifier', 'LeftBrace'])
    : { state: initial, elements: [] }
  const keyword = expect(pubKeyword.state, keywordKind, ['Identifier', 'LeftBrace'])
  const name = expect(keyword.state, 'Identifier', ['Less', 'LeftBrace', ...topLevelFollowing])
  const typeParameters =
    nextSignificantKind(name.state) === 'Less'
      ? parseTypeParameterList(name.state, ['LeftBrace', ...topLevelFollowing])
      : undefined
  const left = expect(typeParameters?.state ?? name.state, 'LeftBrace', [
    'FnKeyword',
    'EffectKeyword',
    'RightBrace',
    ...topLevelFollowing,
  ])
  let state = left.state
  let children: ReadonlyArray<SyntaxTree.Element> = [
    ...pubKeyword.elements,
    ...keyword.elements,
    ...name.elements,
    ...(typeParameters === undefined ? [] : [typeParameters.node]),
    ...left.elements,
  ]
  while (
    nextSignificantKind(state) !== 'RightBrace' &&
    nextSignificantKind(state) !== 'EndOfFile' &&
    nextSignificantKind(state) !== 'ImportKeyword' &&
    nextSignificantKind(state) !== 'PubKeyword' &&
    nextSignificantKind(state) !== 'ConstKeyword' &&
    nextSignificantKind(state) !== 'StructKeyword' &&
    nextSignificantKind(state) !== 'TupleKeyword' &&
    nextSignificantKind(state) !== 'EnumKeyword' &&
    nextSignificantKind(state) !== 'UnionKeyword' &&
    nextSignificantKind(state) !== 'TypeKeyword' &&
    nextSignificantKind(state) !== 'ExternKeyword' &&
    nextSignificantKind(state) !== 'ExportKeyword' &&
    nextSignificantKind(state) !== 'ServiceKeyword' &&
    nextSignificantKind(state) !== 'InterfaceKeyword' &&
    nextSignificantKind(state) !== 'ImplKeyword'
  ) {
    const operation = startsServiceOperation(state)
      ? parseServiceOperation(state)
      : parseServiceInvalidMember(state)
    children = [...children, operation.node]
    if (operation.state.index === state.index) break
    state = operation.state
  }
  const right = expect(state, 'RightBrace', topLevelFollowing)
  return {
    state: right.state,
    node: syntaxNode(right.state, nodeKind, [...children, ...right.elements]),
  }
}

export const parseServiceDeclaration = (initial: State): NodeResult =>
  parseServiceLikeDeclaration(initial, 'Service')

export const parseInterfaceDeclaration = (initial: State): NodeResult =>
  parseServiceLikeDeclaration(initial, 'Interface')

export const parseImplOperation = (initial: State): NodeResult => {
  const name = expect(initial, 'Identifier', ['Colon', 'RightBrace', ...topLevelFollowing])
  const colon = expect(name.state, 'Colon', ['Identifier', 'RightBrace', ...topLevelFollowing])
  const operation = parseTypePath(colon.state, ['Identifier', 'RightBrace', ...topLevelFollowing])
  return {
    state: operation.state,
    node: syntaxNode(operation.state, 'ImplOperation', [
      ...name.elements,
      ...colon.elements,
      operation.node,
    ]),
  }
}

/**
 * An impl declaration is either a conformance `impl [<T>] Contract for Provider { ... }` or an
 * inherent member block `impl [<T>] Owner { ... }`. Both share one node kind; the absence of the
 * `for` token after the first type is what makes the declaration inherent.
 */
export const parseImplDeclaration = (initial: State): NodeResult => {
  const keyword = expect(initial, 'ImplKeyword', ['Identifier', 'ForKeyword', ...topLevelFollowing])
  const typeParameters =
    nextSignificantKind(keyword.state) === 'Less'
      ? parseTypeParameterList(keyword.state, ['ForKeyword', 'LeftBrace', ...topLevelFollowing])
      : undefined
  const capability = parseType(typeParameters?.state ?? keyword.state, [
    'ForKeyword',
    'Identifier',
    'LeftBrace',
    ...topLevelFollowing,
  ])
  const inherent = nextSignificantKind(capability.state) !== 'ForKeyword'
  const forKeyword = inherent
    ? { state: capability.state, elements: [] }
    : expect(capability.state, 'ForKeyword', [...typeStarts, 'LeftBrace', ...topLevelFollowing])
  const target = inherent
    ? undefined
    : parseType(forKeyword.state, ['Identifier', 'LeftBrace', ...topLevelFollowing])
  const headEnd = target?.state ?? forKeyword.state
  const whereClause = hasContextualSpelling(headEnd, 'where')
    ? parseWhereClause(headEnd, ['LeftBrace', ...topLevelFollowing])
    : undefined
  const bodyStart = whereClause?.state ?? headEnd
  const hasBody = nextSignificantKind(bodyStart) === 'LeftBrace'
  const left = expect(bodyStart, 'LeftBrace', [
    'PubKeyword',
    'StaticKeyword',
    'FnKeyword',
    'Identifier',
    'RightBrace',
    ...topLevelFollowing,
  ])
  let state = left.state
  let children: ReadonlyArray<SyntaxTree.Element> = [
    ...keyword.elements,
    ...(typeParameters === undefined ? [] : [typeParameters.node]),
    capability.node,
    ...forKeyword.elements,
    ...(target === undefined ? [] : [target.node]),
    ...(whereClause === undefined ? [] : [whereClause.node]),
    ...left.elements,
  ]

  if (hasBody) {
    while (
      nextSignificantKind(state) === 'Identifier' ||
      nextSignificantKind(state) === 'PubKeyword' ||
      nextSignificantKind(state) === 'StaticKeyword' ||
      nextSignificantKind(state) === 'UnsafeKeyword' ||
      nextSignificantKind(state) === 'FnKeyword' ||
      nextSignificantKind(state) === 'EffectKeyword'
    ) {
      if (nextSignificantKind(state) === 'Identifier' && !testBeginsFunction(state, 0)) {
        const operation = parseImplOperation(state)
        state = operation.state
        children = [...children, operation.node]
      } else {
        const operation = parseFunctionDeclaration(state, true)
        state = operation.state
        children = [...children, operation.node]
      }
    }
  }

  const right = expect(state, 'RightBrace', topLevelFollowing)
  return {
    state: right.state,
    node: syntaxNode(right.state, 'ImplDeclaration', [...children, ...right.elements]),
  }
}

const parseDeclarationGroup = (initial: State): NodeResult => {
  const left = expect(initial, 'LeftBrace', [...topLevelFollowing, 'RightBrace'])
  let state = left.state
  const children: Array<SyntaxTree.Element> = [...left.elements]
  while (
    nextSignificantKind(state) !== undefined &&
    nextSignificantKind(state) !== 'EndOfFile' &&
    nextSignificantKind(state) !== 'RightBrace' &&
    nextSignificantKind(state) !== 'ElseKeyword'
  ) {
    const declaration = parseTopLevelDeclaration(state)
    children.push(declaration.node)
    if (declaration.state.index === state.index) break
    state = declaration.state
    if (declaration.node.kind === 'PackageParameterDeclaration')
      state = addDiagnostic(
        state,
        Diagnostic.unexpectedTokens(
          ['ParamKeyword'],
          'syntax',
          ['unconditional package parameter declaration'],
          declaration.node.span,
        ),
      )
  }
  const right = expect(state, 'RightBrace', ['ElseKeyword', ...topLevelFollowing])
  return {
    state: right.state,
    node: syntaxNode(right.state, 'DeclarationGroup', [...children, ...right.elements]),
  }
}

const parseStaticConditionalDeclaration = (initial: State): NodeResult => {
  const staticKeyword = expect(initial, 'StaticKeyword', ['IfKeyword'])
  const keyword = expect(staticKeyword.state, 'IfKeyword', expressionStarts)
  const condition = parseExpression(keyword.state, 0, 'Identifier', false, ExpressionNesting.root)
  const taken = parseDeclarationGroup(condition.state)
  let state = taken.state
  const children: Array<SyntaxTree.Element> = [
    ...staticKeyword.elements,
    ...keyword.elements,
    condition.node,
    taken.node,
  ]
  if (nextSignificantKind(state) === 'ElseKeyword') {
    const otherwiseKeyword = expect(state, 'ElseKeyword', ['LeftBrace', 'StaticKeyword'])
    const otherwise =
      nextSignificantKind(otherwiseKeyword.state) === 'StaticKeyword'
        ? parseStaticConditionalDeclaration(otherwiseKeyword.state)
        : parseDeclarationGroup(otherwiseKeyword.state)
    children.push(...otherwiseKeyword.elements, otherwise.node)
    state = otherwise.state
  }
  return {
    state,
    node: syntaxNode(state, 'StaticConditionalDeclaration', children),
  }
}

export const parseTopLevelDeclaration = (state: State): NodeResult => {
  if (hasContextualSpelling(state, 'module')) {
    const keyword = expect(state, 'Identifier', ['Identifier'])
    const property = parseFunctionProperties(keyword.state)
    if (property !== undefined)
      return {
        state: property.state,
        node: syntaxNode(property.state, 'ModulePropertyDeclaration', [
          ...keyword.elements,
          property.node,
        ]),
      }
  }
  const kind = nextSignificantKind(state)
  const following = kind === 'PubKeyword' ? peek(state, 1) : undefined
  if (kind === 'StaticKeyword' && peek(state, 1) === 'IfKeyword')
    return parseStaticConditionalDeclaration(state)
  if (beginsForeignStatic(state)) return parseForeignStaticDeclaration(state)
  if (
    (kind === 'StaticKeyword' && !staticBeginsFunction(state, 1)) ||
    (kind === 'PubKeyword' && following === 'StaticKeyword' && !staticBeginsFunction(state, 2))
  )
    return parseInvalidStaticDeclaration(state)
  if (kind === 'ImportKeyword' || following === 'ImportKeyword')
    return parseImportDeclaration(state)
  if (kind === 'ConstKeyword' || following === 'ConstKeyword')
    return parseConstantDeclaration(state)
  if (kind === 'ParamKeyword' || following === 'ParamKeyword')
    return parsePackageParameterDeclaration(state)
  if (kind === 'RoleKeyword' || following === 'RoleKeyword') return parseRoleDeclaration(state)
  if (kind === 'ImplKeyword') return parseImplDeclaration(state)
  if (kind === 'InterfaceKeyword' || following === 'InterfaceKeyword')
    return parseInterfaceDeclaration(state)
  if (kind === 'ServiceKeyword' || following === 'ServiceKeyword')
    return parseServiceDeclaration(state)
  if (
    kind === 'StructKeyword' ||
    following === 'StructKeyword' ||
    externBeginsStruct(state, kind === 'PubKeyword' ? 1 : 0)
  )
    return parseStructDeclaration(state)
  if (kind === 'TupleKeyword' || following === 'TupleKeyword') return parseTupleDeclaration(state)
  if (kind === 'EnumKeyword' || following === 'EnumKeyword') return parseEnumDeclaration(state)
  if (kind === 'UnionKeyword' || following === 'UnionKeyword') return parseUnionDeclaration(state)
  if (kind === 'TypeKeyword' || following === 'TypeKeyword') return parseTypeAliasDeclaration(state)
  return parseFunctionDeclaration(state)
}

export const parseFunctionDeclaration = (initial: State, allowDropName = false): NodeResult => {
  let lookahead = initial.index
  let lookaheadToken = initial.lexical.tokens.at(lookahead)
  let hasPublicModifier = false
  while (
    lookaheadToken !== undefined &&
    lookaheadToken.kind !== 'FnKeyword' &&
    lookaheadToken.kind !== 'StaticKeyword' &&
    lookaheadToken.kind !== 'EffectKeyword' &&
    lookaheadToken.kind !== 'UnsafeKeyword' &&
    lookaheadToken.kind !== 'ExternKeyword' &&
    lookaheadToken.kind !== 'ExportKeyword' &&
    lookaheadToken.kind !== 'StructKeyword' &&
    lookaheadToken.kind !== 'TupleKeyword' &&
    lookaheadToken.kind !== 'EnumKeyword' &&
    lookaheadToken.kind !== 'UnionKeyword' &&
    lookaheadToken.kind !== 'TypeKeyword' &&
    lookaheadToken.kind !== 'ServiceKeyword' &&
    lookaheadToken.kind !== 'InterfaceKeyword' &&
    lookaheadToken.kind !== 'RoleKeyword' &&
    lookaheadToken.kind !== 'ConstKeyword' &&
    lookaheadToken.kind !== 'ParamKeyword' &&
    lookaheadToken.kind !== 'EndOfFile'
  ) {
    if (lookaheadToken.kind === 'PubKeyword') {
      hasPublicModifier = true
      break
    }
    lookahead += 1
    lookaheadToken = initial.lexical.tokens.at(lookahead)
  }
  const pubKeyword = hasPublicModifier
    ? expect(initial, 'PubKeyword', [
        'StaticKeyword',
        'UnsafeKeyword',
        'ExternKeyword',
        'ExportKeyword',
        'EffectKeyword',
        'FnKeyword',
        'Identifier',
        'LeftParenthesis',
      ])
    : { state: initial, elements: [] }
  const testKeyword = hasContextualSpelling(pubKeyword.state, 'test')
    ? expect(pubKeyword.state, 'Identifier', [
        'StaticKeyword',
        'UnsafeKeyword',
        'ExternKeyword',
        'ExportKeyword',
        'EffectKeyword',
        'FnKeyword',
      ])
    : { state: pubKeyword.state, elements: [] }
  const staticKeyword =
    nextSignificantKind(testKeyword.state) === 'StaticKeyword'
      ? expect(testKeyword.state, 'StaticKeyword', [
          'UnsafeKeyword',
          'ExternKeyword',
          'ExportKeyword',
          'FnKeyword',
          'Identifier',
          'LeftParenthesis',
        ])
      : { state: testKeyword.state, elements: [] }
  const unsafeKeyword =
    nextSignificantKind(staticKeyword.state) === 'UnsafeKeyword'
      ? expect(staticKeyword.state, 'UnsafeKeyword', [
          'ExternKeyword',
          'ExportKeyword',
          'EffectKeyword',
          'FnKeyword',
          'Identifier',
          'LeftParenthesis',
        ])
      : { state: staticKeyword.state, elements: [] }
  // `extern <abi>` marks a foreign header and `export <abi>` an exported one; a missing ABI literal
  // recovers inside the declaration.
  const markerKind = nextSignificantKind(unsafeKeyword.state)
  const marker = isAbiMarker(markerKind)
    ? expect(unsafeKeyword.state, markerKind, [
        'TextLiteral',
        'EffectKeyword',
        'FnKeyword',
        'Identifier',
        'LeftParenthesis',
      ])
    : undefined
  const abi =
    marker === undefined
      ? undefined
      : expect(marker.state, 'TextLiteral', [
          'EffectKeyword',
          'FnKeyword',
          'Identifier',
          'LeftParenthesis',
        ])
  const afterExtern = abi?.state ?? unsafeKeyword.state
  const effectKeyword =
    nextSignificantKind(afterExtern) === 'EffectKeyword'
      ? expect(afterExtern, 'EffectKeyword', ['Less', 'FnKeyword', 'Identifier', 'LeftParenthesis'])
      : { state: afterExtern, elements: [] }
  const effectEnvironment =
    effectKeyword.elements.length > 0 && nextSignificantKind(effectKeyword.state) === 'Less'
      ? parseEffectDeclarationEnvironment(effectKeyword.state)
      : undefined
  const fnKeyword = expect(effectEnvironment?.state ?? effectKeyword.state, 'FnKeyword', [
    'Identifier',
    ...(allowDropName ? (['DropKeyword'] as const) : []),
    'LeftParenthesis',
  ])
  const nameKind =
    allowDropName && nextSignificantKind(fnKeyword.state) === 'DropKeyword'
      ? 'DropKeyword'
      : 'Identifier'
  const name = expect(fnKeyword.state, nameKind, ['Less', 'LeftParenthesis'])
  const contract = parseCallableContractTail(
    name.state,
    marker === undefined ? ['LeftBrace'] : ['AsKeyword', 'LeftBrace'],
  )
  const unitResult =
    contract.returnType === undefined ||
    SyntaxTree.directNode(contract.returnType.node, 'UnitType') !== undefined
  const header: ReadonlyArray<SyntaxTree.Element> = [
    ...pubKeyword.elements,
    ...testKeyword.elements,
    ...staticKeyword.elements,
    ...unsafeKeyword.elements,
    ...(marker?.elements ?? []),
    ...(abi?.elements ?? []),
    ...effectKeyword.elements,
    ...(effectEnvironment === undefined ? [] : [effectEnvironment.node]),
    ...fnKeyword.elements,
    ...name.elements,
    ...(contract.typeParameters === undefined ? [] : [contract.typeParameters.node]),
    contract.parameters.node,
    ...(contract.returnType === undefined ? [] : [contract.returnType.node]),
    ...(contract.failureRow === undefined ? [] : [contract.failureRow.node]),
    ...(contract.requirementRow === undefined ? [] : [contract.requirementRow.node]),
    ...(contract.whereClause === undefined ? [] : [contract.whereClause.node]),
  ]

  if (marker === undefined) {
    const properties = parseFunctionPropertyList(contract.state)
    const block = parseBlock(properties.state, !unitResult, unitResult)
    return {
      state: block.state,
      node: syntaxNode(block.state, 'FunctionDeclaration', [
        ...header,
        ...properties.elements,
        block.node,
      ]),
    }
  }

  const symbol = parseSymbolTail(contract.state)
  const properties = parseFunctionPropertyList(symbol.state)
  const afterProperties = properties.state
  if (markerKind === 'ExportKeyword') {
    // An exported function requires a body; without one the declaration closes on an empty block
    // so the next top-level declaration parses intact.
    const block =
      nextSignificantKind(afterProperties) === 'LeftBrace'
        ? parseBlock(afterProperties, !unitResult, unitResult)
        : parseMissingBlock(afterProperties)
    return {
      state: block.state,
      node: syntaxNode(block.state, 'FunctionDeclaration', [
        ...header,
        ...symbol.elements,
        ...properties.elements,
        block.node,
      ]),
    }
  }

  // A foreign header has no body; `static`, `effect`, rows, and a block are retained for semantic
  // rejection so their diagnostics stay navigable.
  const body =
    nextSignificantKind(afterProperties) === 'LeftBrace'
      ? parseBlock(afterProperties, !unitResult, unitResult)
      : undefined
  const state = body?.state ?? afterProperties
  return {
    state,
    node: syntaxNode(state, 'ForeignFunctionDeclaration', [
      ...header,
      ...symbol.elements,
      ...properties.elements,
      ...(body === undefined ? [] : [body.node]),
    ]),
  }
}

export const parseFunctionPropertyList = (initial: State): ElementsResult => {
  let state = initial
  const elements: Array<SyntaxTree.Element> = []
  while (hasContextualSpelling(state, 'with')) {
    const property = parseFunctionProperties(state)
    if (property === undefined) break
    elements.push(property.node)
    state = property.state
  }
  return { state, elements: elements }
}

/** Retains sealed declaration properties as syntax; completion validates their owner and literals. */
const parseFunctionProperties = (initial: State): NodeResult | undefined => {
  if (!hasContextualSpelling(initial, 'with')) return undefined
  const withToken = expect(initial, 'Identifier', ['Identifier'])
  const namespace = expect(withToken.state, 'Identifier', ['Dot'])
  const dot = expect(namespace.state, 'Dot', ['Identifier'])
  const operation = expect(dot.state, 'Identifier', ['LeftParenthesis'])
  const left = expect(operation.state, 'LeftParenthesis', ['Identifier', 'RightParenthesis'])
  const children: Array<SyntaxTree.Element> = [
    ...withToken.elements,
    ...namespace.elements,
    ...dot.elements,
    ...operation.elements,
    ...left.elements,
  ]
  let state = left.state
  while (nextSignificantKind(state) === 'Identifier') {
    const name = expect(state, 'Identifier', ['Colon'])
    const colon = expect(name.state, 'Colon', expressionStarts)
    const value = parseExpression(colon.state, 1, 'Identifier', false)
    children.push(
      syntaxNode(value.state, 'FunctionProperty', [
        ...name.elements,
        ...colon.elements,
        value.node,
      ]),
    )
    state = value.state
    if (nextSignificantKind(state) !== 'Comma') break
    const comma = expect(state, 'Comma', ['Identifier', 'RightParenthesis'])
    children.push(...comma.elements)
    state = comma.state
  }
  const right = expect(state, 'RightParenthesis', ['LeftBrace', ...topLevelFollowing])
  return {
    state: right.state,
    node: syntaxNode(right.state, 'FunctionPropertyClause', [...children, ...right.elements]),
  }
}

/** The optional `as <symbol>` tail shared by foreign and exported function headers. */
const parseSymbolTail = (
  initial: State,
  following: ReadonlyArray<Token.TokenKind> = ['LeftBrace', ...topLevelFollowing],
): ElementsResult => {
  if (nextSignificantKind(initial) !== 'AsKeyword') return { state: initial, elements: [] }
  const asKeyword = expect(initial, 'AsKeyword', ['TextLiteral', ...following])
  const symbol = expect(asKeyword.state, 'TextLiteral', following)
  return {
    state: symbol.state,
    elements: [...asKeyword.elements, ...symbol.elements],
  }
}

const parseMissingBlock = (initial: State): NodeResult => {
  const leftBrace = expect(initial, 'LeftBrace', topLevelFollowing)
  // Semantic analysis relies on every function block ending in a terminal statement; the missing
  // block keeps that guarantee the same way an authored block without a return does.
  const terminal = parseImplicitUnitReturnStatement(leftBrace.state)
  return {
    state: terminal.state,
    node: syntaxNode(terminal.state, 'Block', [...leftBrace.elements, terminal.node]),
  }
}
