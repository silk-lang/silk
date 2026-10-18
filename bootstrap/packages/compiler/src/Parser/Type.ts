import { parseFunctionPropertyList } from './Declaration.js'
import * as Diagnostic from '../Diagnostic.js'
import type { ElementsResult, NodeResult, State } from '../internal/ParseState.js'
import {
  addDiagnostic,
  consumeTrivia,
  expect,
  missingToken,
  nextSignificantKind,
  peek,
  syntaxNode,
} from '../internal/ParseState.js'
import * as SyntaxTree from '../SyntaxTree.js'
import type * as Token from '../Token.js'
import {
  hasContextualSpelling,
  isExactRepresentationStart,
  isOpaqueResultStart,
  isRowWithoutStart,
} from './Expression.js'
import { typeStarts } from './Grammar.js'

const nullablePointerStarts = (state: State): boolean =>
  nextSignificantKind(state) === 'Question' &&
  (peek(state, 1) === 'Star' || (peek(state, 1) === 'LeftBracket' && peek(state, 2) === 'Star'))

const argumentStarts: ReadonlyArray<Token.TokenKind> = ['Lifetime', ...typeStarts]

const parseLifetime = (initial: State, following: ReadonlyArray<Token.TokenKind>): NodeResult => {
  const lifetime = expect(initial, 'Lifetime', following)
  return {
    state: lifetime.state,
    node: syntaxNode(lifetime.state, 'LifetimeType', lifetime.elements),
  }
}

/** Parses a finite intersection only in an Effect environment position. */
export const parseEffectEnvironmentLifetimes = (
  initial: State,
  following: ReadonlyArray<Token.TokenKind>,
): ElementsResult => {
  let result = expect(initial, 'Lifetime', ['Ampersand', ...following])
  while (nextSignificantKind(result.state) === 'Ampersand') {
    const separator = expect(result.state, 'Ampersand', ['Lifetime', ...following])
    const member = expect(separator.state, 'Lifetime', ['Ampersand', ...following])
    result = {
      state: member.state,
      elements: [...result.elements, ...separator.elements, ...member.elements],
    }
  }
  return result
}

const hasEffectEnvironment = (state: State): boolean => {
  if (nextSignificantKind(state) === 'Semicolon') return true
  let offset = 0
  if (peek(state, offset) !== 'Lifetime') return false
  offset += 1
  while (peek(state, offset) === 'Ampersand' && peek(state, offset + 1) === 'Lifetime') offset += 2
  return peek(state, offset) === 'Semicolon'
}

export const parseTypePath = (
  initial: State,
  following: ReadonlyArray<Token.TokenKind>,
  preserveFieldStart = false,
): NodeResult => {
  const fieldStartsHere =
    preserveFieldStart &&
    nextSignificantKind(initial) === 'Identifier' &&
    peek(initial, 1) === 'Colon'
  let first: ElementsResult
  if (fieldStartsHere) {
    const leading = consumeTrivia(initial)
    const missing = missingToken(leading.state, 'Identifier')
    first = {
      state: addDiagnostic(leading.state, Diagnostic.missingToken('Identifier', missing.span)),
      elements: [...leading.elements, missing],
    }
  } else first = expect(initial, 'Identifier', ['Dot', ...following])
  let state = first.state
  let children: ReadonlyArray<SyntaxTree.Element> = first.elements
  const tokenAfterQualifiedMember = peek(state, 2)
  const dotStartsRecoveredEnclosingMember =
    following.includes('Dot') &&
    nextSignificantKind(state) === 'Dot' &&
    peek(state, 1) === 'Identifier' &&
    (tokenAfterQualifiedMember === 'LeftParenthesis' ||
      tokenAfterQualifiedMember === 'LetKeyword' ||
      tokenAfterQualifiedMember === 'ConstKeyword' ||
      tokenAfterQualifiedMember === 'ReturnKeyword' ||
      tokenAfterQualifiedMember === 'RightBrace' ||
      tokenAfterQualifiedMember === 'EndOfFile')
  if (
    !fieldStartsHere &&
    nextSignificantKind(state) === 'Dot' &&
    !dotStartsRecoveredEnclosingMember
  ) {
    const dot = expect(state, 'Dot', ['Identifier', ...following])
    const member = expect(dot.state, 'Identifier', following)
    state = member.state
    children = [...children, ...dot.elements, ...member.elements]
  }
  return { state, node: syntaxNode(state, 'TypePath', children) }
}

export const parseTypeArgumentList = (
  initial: State,
  kind: 'TypeArgumentList' | 'CallTypeArgumentList',
  following: ReadonlyArray<Token.TokenKind>,
): NodeResult => {
  const left = expect(initial, 'Less', [
    ...argumentStarts,
    ...(kind === 'TypeArgumentList' ? (['Bang', 'Question'] as const) : []),
    'Greater',
    ...following,
  ])
  let state = left.state
  let children: ReadonlyArray<SyntaxTree.Element> = left.elements
  if (kind === 'TypeArgumentList' && hasEffectEnvironment(state)) {
    const lifetime = parseEffectEnvironmentLifetimes(state, [
      'Semicolon',
      ...typeStarts,
      ...following,
    ])
    const separator = expect(lifetime.state, 'Semicolon', [...typeStarts, 'Greater', ...following])
    state = separator.state
    children = [
      ...children,
      syntaxNode(state, 'EffectEnvironment', [...lifetime.elements, ...separator.elements]),
    ]
  }
  if (nextSignificantKind(state) === 'Greater') {
    const missing = missingToken(state, 'Identifier')
    state = addDiagnostic(state, Diagnostic.missingToken('Identifier', missing.span))
    children = [...children, missing]
  }
  while (
    nextSignificantKind(state) !== 'Greater' &&
    nextSignificantKind(state) !== 'EndOfFile' &&
    !(kind === 'TypeArgumentList' && nextSignificantKind(state) === 'Bang') &&
    !(
      kind === 'TypeArgumentList' &&
      nextSignificantKind(state) === 'Question' &&
      !nullablePointerStarts(state)
    ) &&
    (!following.includes(nextSignificantKind(state) ?? 'EndOfFile') ||
      nullablePointerStarts(state) ||
      nextSignificantKind(state) === 'Identifier' ||
      nextSignificantKind(state) === 'LeftParenthesis')
  ) {
    const argumentFollowing: ReadonlyArray<Token.TokenKind> = [
      'Comma',
      'Bang',
      'Question',
      'Greater',
      ...following,
    ]
    const argument =
      nextSignificantKind(state) === 'Lifetime'
        ? parseLifetime(state, argumentFollowing)
        : parseType(state, argumentFollowing)
    if (kind === 'CallTypeArgumentList' && hasContextualSpelling(argument.state, 'at')) {
      const at = expect(argument.state, 'Identifier', [
        'Identifier',
        'Comma',
        'Greater',
        ...following,
      ])
      const role = parseTypePath(at.state, ['Comma', 'Greater', ...following])
      children = [
        ...children,
        syntaxNode(role.state, 'RequirementSelector', [argument.node, ...at.elements, role.node]),
      ]
      state = role.state
    } else {
      children = [...children, argument.node]
      state = argument.state
    }
    if (nextSignificantKind(state) !== 'Comma') break
    const comma = expect(state, 'Comma', [...argumentStarts, 'Greater', ...following])
    children = [...children, ...comma.elements]
    state = comma.state
  }
  if (kind === 'TypeArgumentList' && nextSignificantKind(state) === 'Bang') {
    const failure = parseFailureRow(state, ['Question', 'Greater', ...following])
    children = [...children, failure.node]
    state = failure.state
  }
  if (
    kind === 'TypeArgumentList' &&
    nextSignificantKind(state) === 'Question' &&
    !nullablePointerStarts(state)
  ) {
    const requirements = parseRequirementRow(state, ['Greater', ...following])
    children = [...children, requirements.node]
    state = requirements.state
  }
  const right = expect(state, 'Greater', following)
  return {
    state: right.state,
    node: syntaxNode(right.state, kind, [...children, ...right.elements]),
  }
}

export const parseTypeParameterList = (
  initial: State,
  following: ReadonlyArray<Token.TokenKind>,
  invocationBinders = false,
): NodeResult => {
  const parameterStarts: ReadonlyArray<Token.TokenKind> = ['Lifetime', 'Identifier', 'Question']
  const left = expect(initial, 'Less', [...parameterStarts, 'Greater', ...following])
  let state = left.state
  let children: ReadonlyArray<SyntaxTree.Element> = left.elements
  if (nextSignificantKind(state) === 'Greater') {
    const missing = missingToken(state, 'Identifier')
    state = addDiagnostic(state, Diagnostic.missingToken('Identifier', missing.span))
    children = [...children, missing]
  }
  while (
    nextSignificantKind(state) !== 'Greater' &&
    nextSignificantKind(state) !== 'EndOfFile' &&
    (!following.includes(nextSignificantKind(state) ?? 'EndOfFile') || nullablePointerStarts(state))
  ) {
    // `use` is contextual only in a callable's outer `for` list, never a declaration generic.
    const invocationUse = invocationBinders && hasContextualSpelling(state, 'use')
    const use = invocationUse
      ? expect(state, 'Identifier', ['Lifetime', 'Comma', 'Greater', ...following])
      : undefined
    const markerKind = nextSignificantKind(use?.state ?? state)
    const marker =
      !invocationUse && markerKind === 'Question'
        ? expect(state, markerKind, ['Identifier', 'Comma', 'Greater', ...following])
        : undefined
    const lifetimeParameter = invocationUse || markerKind === 'Lifetime'
    const name = expect(
      marker?.state ?? use?.state ?? state,
      lifetimeParameter ? 'Lifetime' : 'Identifier',
      ['Colon', 'Comma', 'Greater', ...following],
    )
    const colon =
      marker === undefined && nextSignificantKind(name.state) === 'Colon'
        ? expect(name.state, 'Colon', [...argumentStarts, 'Comma', 'Greater', ...following])
        : undefined
    let boundState = colon?.state
    let boundElements: ReadonlyArray<SyntaxTree.Element> = []
    if (colon !== undefined) {
      while (boundState !== undefined) {
        const bound =
          nextSignificantKind(boundState) === 'Lifetime'
            ? parseLifetime(boundState, ['Plus', 'Comma', 'Greater', ...following])
            : parseType(boundState, ['Plus', 'Comma', 'Greater', ...following], true)
        boundElements = [...boundElements, bound.node]
        boundState = bound.state
        if (nextSignificantKind(boundState) !== 'Plus') break
        const plus = expect(boundState, 'Plus', [
          ...argumentStarts,
          'Comma',
          'Greater',
          ...following,
        ])
        boundElements = [...boundElements, ...plus.elements]
        boundState = plus.state
      }
    }
    const completedState = boundState ?? name.state
    children = [
      ...children,
      syntaxNode(completedState, lifetimeParameter ? 'LifetimeParameter' : 'TypeParameter', [
        ...(use?.elements ?? []),
        ...(marker?.elements ?? []),
        ...name.elements,
        ...(colon?.elements ?? []),
        ...boundElements,
      ]),
    ]
    state = completedState
    if (nextSignificantKind(state) !== 'Comma') break
    const comma = expect(state, 'Comma', [...parameterStarts, 'Greater', ...following])
    children = [...children, ...comma.elements]
    state = comma.state
  }
  const right = expect(state, 'Greater', following)
  return {
    state: right.state,
    node: syntaxNode(right.state, 'TypeParameterList', [...children, ...right.elements]),
  }
}

/** Parses the one callable or Effect representation binder admitted by an opaque result. */
export const parseOpaqueResultBinderList = (
  initial: State,
  following: ReadonlyArray<Token.TokenKind>,
): NodeResult => {
  const left = expect(initial, 'Less', ['Identifier', 'Greater', ...following])
  const name = expect(left.state, 'Identifier', ['Colon', 'Greater', ...following])
  const colon = expect(name.state, 'Colon', [...typeStarts, 'Greater', ...following])
  const bound = parseType(colon.state, ['Comma', 'Greater', ...following], true)
  // A comma proves that source supplied more than the single binder this form admits. Consume the
  // extra binder region through the real `>` so parsing resumes at the result. Otherwise, type
  // starts synchronize a missing `>` without consuming the result type that follows it.
  const right =
    nextSignificantKind(bound.state) === 'Comma'
      ? expect(bound.state, 'Greater', following)
      : expect(bound.state, 'Greater', [...typeStarts, ...following])
  return {
    state: right.state,
    node: syntaxNode(right.state, 'TypeParameterList', [
      ...left.elements,
      syntaxNode(bound.state, 'TypeParameter', [...name.elements, ...colon.elements, bound.node]),
      ...right.elements,
    ]),
  }
}

/** Parses one named type reference: a path with an optional applied type-argument list. */
export const parseNamedTypeReference = (
  initial: State,
  following: ReadonlyArray<Token.TokenKind>,
  preserveFieldStart = false,
): NodeResult => {
  const path = parseTypePath(initial, ['Less', ...following], preserveFieldStart)
  if (nextSignificantKind(path.state) !== 'Less') return path
  const arguments_ = parseTypeArgumentList(path.state, 'TypeArgumentList', following)
  return {
    state: arguments_.state,
    node: syntaxNode(arguments_.state, 'AppliedType', [path.node, arguments_.node]),
  }
}

/**
 * One `Without` operand: requirement entries (`&mut Clock at Primary`), row parameters (`R`),
 * service-role keys (`Clock`, `Clock at Primary`), or nested subtractions, joined by `|`.
 */
const parseRowOperand = (initial: State, following: ReadonlyArray<Token.TokenKind>): NodeResult => {
  const parseMember = (state: State): NodeResult => {
    if (nextSignificantKind(state) === 'Ampersand')
      return parseRequirement(state, ['Pipe', ...following])
    if (isRowWithoutStart(state)) return parseTypePrimary(state, ['Pipe', ...following])
    const path = parseNamedTypeReference(state, ['Pipe', ...following])
    if (!hasContextualSpelling(path.state, 'at')) return path
    const at = expect(path.state, 'Identifier', ['Identifier', 'Pipe', ...following])
    const role = parseTypePath(at.state, ['Pipe', ...following])
    return {
      state: role.state,
      node: syntaxNode(role.state, 'Requirement', [path.node, ...at.elements, role.node]),
    }
  }
  const first = parseMember(initial)
  let state = first.state
  let children: ReadonlyArray<SyntaxTree.Element> = [first.node]
  while (nextSignificantKind(state) === 'Pipe') {
    const pipe = expect(state, 'Pipe', ['Ampersand', 'Identifier', ...following])
    const member = parseMember(pipe.state)
    children = [...children, ...pipe.elements, member.node]
    state = member.state
  }
  return children.length === 1 ? first : { state, node: syntaxNode(state, 'UnionType', children) }
}

export const parseTypePrimary = (
  initial: State,
  following: ReadonlyArray<Token.TokenKind>,
  preserveFieldStart = false,
): NodeResult => {
  if (nextSignificantKind(initial) === 'ForKeyword') {
    const keyword = expect(initial, 'ForKeyword', ['Less', ...typeStarts, ...following])
    const parameters = parseTypeParameterList(
      keyword.state,
      ['FnKeyword', 'MutKeyword', 'OnceKeyword', 'UnsafeKeyword', 'ExternKeyword', ...following],
      true,
    )
    const binders = syntaxNode(parameters.state, 'LifetimeBinderList', parameters.node.children)
    const callable = parseTypePrimary(parameters.state, following, preserveFieldStart)
    const state =
      callable.node.kind === 'CallableType' || callable.node.kind === 'ForeignFunctionType'
        ? callable.state
        : addDiagnostic(callable.state, Diagnostic.missingToken('FnKeyword', callable.node.span))
    return {
      state,
      node: syntaxNode(
        state,
        callable.node.kind === 'ForeignFunctionType' ? 'ForeignFunctionType' : 'CallableType',
        [...keyword.elements, binders, ...callable.node.children],
      ),
    }
  }
  if (isRowWithoutStart(initial)) {
    const keyword = expect(initial, 'Identifier', ['Less', ...following])
    const left = expect(keyword.state, 'Less', [...typeStarts, ...following])
    const source = parseRowOperand(left.state, ['Comma', 'Greater', ...following])
    const comma = expect(source.state, 'Comma', [...typeStarts, 'Greater', ...following])
    const selected = parseRowOperand(comma.state, ['Greater', ...following])
    const right = expect(selected.state, 'Greater', following)
    return {
      state: right.state,
      node: syntaxNode(right.state, 'RowWithout', [
        ...keyword.elements,
        ...left.elements,
        source.node,
        ...comma.elements,
        selected.node,
        ...right.elements,
      ]),
    }
  }
  if (isExactRepresentationStart(initial)) {
    const keyword = expect(initial, 'Identifier', ['LeftParenthesis', ...following])
    const left = expect(keyword.state, 'LeftParenthesis', [
      'Identifier',
      'RightParenthesis',
      ...following,
    ])
    const item = parseNamedTypeReference(left.state, ['RightParenthesis', ...following])
    const right = expect(item.state, 'RightParenthesis', following)
    return {
      state: right.state,
      node: syntaxNode(right.state, 'ExactRepresentationType', [
        ...keyword.elements,
        ...left.elements,
        item.node,
        ...right.elements,
      ]),
    }
  }
  if (nextSignificantKind(initial) === 'ExternKeyword') {
    const externKeyword = expect(initial, 'ExternKeyword', [
      'TextLiteral',
      'FnKeyword',
      ...following,
    ])
    const abi = expect(externKeyword.state, 'TextLiteral', ['FnKeyword', ...following])
    const fn = expect(abi.state, 'FnKeyword', ['LeftParenthesis', ...following])
    const left = expect(fn.state, 'LeftParenthesis', [
      ...typeStarts,
      'RightParenthesis',
      'Arrow',
      ...following,
    ])
    let state = left.state
    let parameters: ReadonlyArray<SyntaxTree.Element> = []
    while (
      nextSignificantKind(state) !== 'RightParenthesis' &&
      nextSignificantKind(state) !== 'Arrow' &&
      nextSignificantKind(state) !== 'EndOfFile'
    ) {
      const parameter = parseType(state, ['Comma', 'RightParenthesis', 'Arrow', ...following])
      parameters = [...parameters, parameter.node]
      state = parameter.state
      if (nextSignificantKind(state) !== 'Comma') break
      const comma = expect(state, 'Comma', [
        ...typeStarts,
        'RightParenthesis',
        'Arrow',
        ...following,
      ])
      parameters = [...parameters, ...comma.elements]
      state = comma.state
    }
    const right = expect(state, 'RightParenthesis', ['Arrow', ...following])
    const arrow = expect(right.state, 'Arrow', [...typeStarts, ...following])
    const result = parseType(arrow.state, following)
    const properties = parseFunctionPropertyList(result.state)
    return {
      state: properties.state,
      node: syntaxNode(properties.state, 'ForeignFunctionType', [
        ...externKeyword.elements,
        ...abi.elements,
        ...fn.elements,
        ...left.elements,
        ...parameters,
        ...right.elements,
        ...arrow.elements,
        result.node,
        ...properties.elements,
      ]),
    }
  }
  const unsafeCallable = nextSignificantKind(initial) === 'UnsafeKeyword'
  const unsafe = unsafeCallable
    ? expect(initial, 'UnsafeKeyword', ['MutKeyword', 'OnceKeyword', 'FnKeyword', ...following])
    : undefined
  const callableStart = unsafe?.state ?? initial
  const callableMode = nextSignificantKind(callableStart)
  if (
    !unsafeCallable &&
    (callableMode === 'MutKeyword' || callableMode === 'OnceKeyword') &&
    peek(callableStart, 1) === 'Identifier'
  ) {
    const mode = expect(callableStart, callableMode, typeStarts)
    const subject = parseTypePrimary(mode.state, following, preserveFieldStart)
    return {
      state: subject.state,
      node: syntaxNode(subject.state, subject.node.kind, [
        ...mode.elements,
        ...subject.node.children,
      ]),
    }
  }
  if (
    callableMode === 'FnKeyword' ||
    callableMode === 'MutKeyword' ||
    callableMode === 'OnceKeyword'
  ) {
    const mode =
      callableMode === 'MutKeyword' || callableMode === 'OnceKeyword'
        ? expect(callableStart, callableMode, ['FnKeyword', 'LeftParenthesis', ...following])
        : undefined
    const fn = expect(mode?.state ?? callableStart, 'FnKeyword', [
      'Less',
      'LeftParenthesis',
      ...following,
    ])
    let environment: NodeResult | undefined
    if (nextSignificantKind(fn.state) === 'Less') {
      const left = expect(fn.state, 'Less', [
        'Lifetime',
        'Greater',
        'LeftParenthesis',
        ...following,
      ])
      const lifetime = expect(left.state, 'Lifetime', ['Greater', 'LeftParenthesis', ...following])
      const right = expect(lifetime.state, 'Greater', ['LeftParenthesis', ...following])
      environment = {
        state: right.state,
        node: syntaxNode(right.state, 'CallableEnvironment', [
          ...left.elements,
          ...lifetime.elements,
          ...right.elements,
        ]),
      }
    }
    const left = expect(environment?.state ?? fn.state, 'LeftParenthesis', [
      ...typeStarts,
      'RightParenthesis',
      'Arrow',
      ...following,
    ])
    let state = left.state
    let parameters: ReadonlyArray<SyntaxTree.Element> = []
    while (
      nextSignificantKind(state) !== 'RightParenthesis' &&
      nextSignificantKind(state) !== 'Arrow' &&
      nextSignificantKind(state) !== 'EndOfFile'
    ) {
      const parameter = parseType(state, ['Comma', 'RightParenthesis', 'Arrow', ...following])
      parameters = [...parameters, parameter.node]
      state = parameter.state
      if (nextSignificantKind(state) !== 'Comma') break
      const comma = expect(state, 'Comma', [
        ...typeStarts,
        'RightParenthesis',
        'Arrow',
        ...following,
      ])
      parameters = [...parameters, ...comma.elements]
      state = comma.state
    }
    const right = expect(state, 'RightParenthesis', ['Arrow', ...following])
    const arrow = expect(right.state, 'Arrow', [...typeStarts, ...following])
    const result = parseType(arrow.state, following)
    return {
      state: result.state,
      node: syntaxNode(result.state, 'CallableType', [
        ...(unsafe?.elements ?? []),
        ...(mode?.elements ?? []),
        ...fn.elements,
        ...(environment === undefined ? [] : [environment.node]),
        ...left.elements,
        ...parameters,
        ...right.elements,
        ...arrow.elements,
        result.node,
      ]),
    }
  }
  if (
    nextSignificantKind(initial) === 'Star' ||
    nullablePointerStarts(initial) ||
    (nextSignificantKind(initial) === 'LeftBracket' && peek(initial, 1) === 'Star')
  ) {
    const nullable =
      nextSignificantKind(initial) === 'Question'
        ? expect(initial, 'Question', ['Star', 'LeftBracket'])
        : undefined
    const start = nullable?.state ?? initial
    const left =
      nextSignificantKind(start) === 'LeftBracket'
        ? expect(start, 'LeftBracket', ['Star'])
        : undefined
    const star = expect(left?.state ?? start, 'Star', [
      'RightBracket',
      'ConstKeyword',
      'MutKeyword',
      ...following,
    ])
    const right =
      left === undefined
        ? undefined
        : expect(star.state, 'RightBracket', ['ConstKeyword', 'MutKeyword'])
    const accessState = right?.state ?? star.state
    const mutability = expect(
      accessState,
      nextSignificantKind(accessState) === 'MutKeyword' ? 'MutKeyword' : 'ConstKeyword',
      [...typeStarts, ...following],
    )
    let state = mutability.state
    const qualifiers: Array<SyntaxTree.Node> = []
    while (
      (hasContextualSpelling(state, 'align') || hasContextualSpelling(state, 'addrspace')) &&
      peek(state, 1) === 'LeftParenthesis'
    ) {
      const name = expect(state, 'Identifier', ['LeftParenthesis'])
      const open = expect(name.state, 'LeftParenthesis', ['DecimalInteger'])
      const value = expect(open.state, 'DecimalInteger', ['RightParenthesis'])
      const close = expect(value.state, 'RightParenthesis', [...typeStarts, ...following])
      qualifiers.push(
        syntaxNode(close.state, 'PointerQualifier', [
          ...name.elements,
          ...open.elements,
          ...value.elements,
          ...close.elements,
        ]),
      )
      state = close.state
    }
    const pointee = parseTypePrimary(state, following)
    return {
      state: pointee.state,
      node: syntaxNode(pointee.state, 'PointerType', [
        ...(nullable?.elements ?? []),
        ...(left?.elements ?? []),
        ...star.elements,
        ...(right?.elements ?? []),
        ...mutability.elements,
        ...qualifiers,
        pointee.node,
      ]),
    }
  }
  if (nextSignificantKind(initial) === 'Ampersand') {
    const ampersand = expect(initial, 'Ampersand', [
      'Lifetime',
      'MutKeyword',
      'LeftBracket',
      ...typeStarts,
      ...following,
    ])
    const lifetime =
      nextSignificantKind(ampersand.state) === 'Lifetime'
        ? expect(ampersand.state, 'Lifetime', [
            'MutKeyword',
            'LeftBracket',
            ...typeStarts,
            ...following,
          ])
        : undefined
    const accessState = lifetime?.state ?? ampersand.state
    const mut =
      nextSignificantKind(accessState) === 'MutKeyword'
        ? expect(accessState, 'MutKeyword', ['LeftBracket', ...typeStarts, ...following])
        : undefined
    if (nextSignificantKind(mut?.state ?? accessState) !== 'LeftBracket') {
      const subject = parseTypePrimary(mut?.state ?? accessState, ['At', ...following])
      let role: ElementsResult | undefined
      if (nextSignificantKind(subject.state) === 'At') {
        const at = expect(subject.state, 'At', ['Identifier', ...following])
        const name = expect(at.state, 'Identifier', following)
        role = {
          state: name.state,
          elements: [...at.elements, ...name.elements],
        }
      }
      return {
        state: role?.state ?? subject.state,
        node: syntaxNode(role?.state ?? subject.state, 'ReferenceType', [
          ...ampersand.elements,
          ...(lifetime?.elements ?? []),
          ...(mut?.elements ?? []),
          subject.node,
          ...(role?.elements ?? []),
        ]),
      }
    }
    const left = expect(mut?.state ?? accessState, 'LeftBracket', [
      ...typeStarts,
      'RightBracket',
      ...following,
    ])
    const element = parseType(left.state, ['RightBracket', ...following])
    const right = expect(element.state, 'RightBracket', following)
    return {
      state: right.state,
      node: syntaxNode(right.state, 'SliceType', [
        ...ampersand.elements,
        ...(lifetime?.elements ?? []),
        ...(mut?.elements ?? []),
        ...left.elements,
        element.node,
        ...right.elements,
      ]),
    }
  }
  if (nextSignificantKind(initial) === 'LeftParenthesis') {
    const left = expect(initial, 'LeftParenthesis', [
      ...typeStarts,
      'RightParenthesis',
      ...following,
    ])
    if (nextSignificantKind(left.state) === 'RightParenthesis') {
      const right = expect(left.state, 'RightParenthesis', following)
      return {
        state: right.state,
        node: syntaxNode(right.state, 'UnitType', [...left.elements, ...right.elements]),
      }
    }
    const type = parseType(left.state, ['RightParenthesis', ...following])
    const right = expect(type.state, 'RightParenthesis', following)
    return {
      state: right.state,
      node: syntaxNode(right.state, 'ParenthesizedType', [
        ...left.elements,
        type.node,
        ...right.elements,
      ]),
    }
  }
  if (nextSignificantKind(initial) !== 'LeftBracket')
    return parseNamedTypeReference(initial, following, preserveFieldStart)
  const left = expect(initial, 'LeftBracket', [...typeStarts, ...following])
  const element = parseType(left.state, ['Semicolon', 'RightBracket', ...following])
  const semicolon = expect(element.state, 'Semicolon', [
    'DecimalInteger',
    'RightBracket',
    ...following,
  ])
  const length = expect(semicolon.state, 'DecimalInteger', ['RightBracket', ...following])
  const right = expect(length.state, 'RightBracket', following)
  return {
    state: right.state,
    node: syntaxNode(right.state, 'FixedArrayType', [
      ...left.elements,
      element.node,
      ...semicolon.elements,
      ...length.elements,
      ...right.elements,
    ]),
  }
}

export function parseType(
  initial: State,
  following: ReadonlyArray<Token.TokenKind>,
  preserveFieldStart = false,
): NodeResult {
  const first = parseTypePrimary(initial, ['Pipe', ...following], preserveFieldStart)
  let state = first.state
  let children: ReadonlyArray<SyntaxTree.Element> = [first.node]
  while (nextSignificantKind(state) === 'Pipe') {
    const pipe = expect(state, 'Pipe', [...typeStarts, ...following])
    const member = parseTypePrimary(pipe.state, ['Pipe', ...following], preserveFieldStart)
    children = [...children, ...pipe.elements, member.node]
    state = member.state
  }
  return children.length === 1 ? first : { state, node: syntaxNode(state, 'UnionType', children) }
}

export const parseReturnType = (
  initial: State,
  following: ReadonlyArray<Token.TokenKind> = ['Bang', 'Question', 'LeftBrace'],
): NodeResult => {
  const arrow = expect(initial, 'Arrow', [...typeStarts, ...following])
  if (isOpaqueResultStart(arrow.state)) {
    const keyword = expect(arrow.state, 'Identifier', ['Less', ...following])
    // The binder list is followed by a type, so its recovery set must exclude every type start:
    // `parseTypeParameterList` stops at any token it is told follows the list.
    const binders = parseOpaqueResultBinderList(keyword.state, following)
    const result = parseType(binders.state, following)
    const opaque = syntaxNode(result.state, 'OpaqueResultType', [
      ...keyword.elements,
      binders.node,
      result.node,
    ])
    return {
      state: result.state,
      node: syntaxNode(result.state, 'ReturnType', [...arrow.elements, opaque]),
    }
  }
  const type = parseType(arrow.state, following)
  return {
    state: type.state,
    node: syntaxNode(type.state, 'ReturnType', [...arrow.elements, type.node]),
  }
}

export const parseFailureRow = (
  initial: State,
  following: ReadonlyArray<Token.TokenKind> = ['Question', 'LeftBrace'],
): NodeResult => {
  const bang = expect(initial, 'Bang', [...typeStarts, ...following])
  const members = parseType(bang.state, following)
  return {
    state: members.state,
    node: syntaxNode(members.state, 'FailureRow', [...bang.elements, members.node]),
  }
}

export const parseRequirement = (
  initial: State,
  following: ReadonlyArray<Token.TokenKind>,
): NodeResult => {
  const ampersand = expect(initial, 'Ampersand', ['MutKeyword', 'Identifier', ...following])
  const mut =
    nextSignificantKind(ampersand.state) === 'MutKeyword'
      ? expect(ampersand.state, 'MutKeyword', ['Identifier', ...following])
      : undefined
  const capability = parseTypePrimary(mut?.state ?? ampersand.state, following)
  let role: ElementsResult | undefined
  if (hasContextualSpelling(capability.state, 'at')) {
    const at = expect(capability.state, 'Identifier', ['Identifier', ...following])
    const path = parseTypePath(at.state, following)
    role = { state: path.state, elements: [...at.elements, path.node] }
  }
  return {
    state: role?.state ?? capability.state,
    node: syntaxNode(role?.state ?? capability.state, 'Requirement', [
      ...ampersand.elements,
      ...(mut?.elements ?? []),
      capability.node,
      ...(role?.elements ?? []),
    ]),
  }
}

export const parseRequirementRow = (
  initial: State,
  following: ReadonlyArray<Token.TokenKind>,
): NodeResult => {
  const memberStarts: ReadonlyArray<Token.TokenKind> = ['Ampersand', 'Identifier']
  const question = expect(initial, 'Question', [...memberStarts, ...following])
  const parseMember = (state: State): NodeResult => {
    if (nextSignificantKind(state) === 'Ampersand') {
      return parseRequirement(state, ['Pipe', ...following])
    }
    if (isRowWithoutStart(state)) {
      return parseType(state, ['Pipe', ...following])
    }
    return parseTypePath(state, ['Pipe', ...following])
  }
  let member = parseMember(question.state)
  let state = member.state
  let children: ReadonlyArray<SyntaxTree.Element> = [...question.elements, member.node]
  while (nextSignificantKind(state) === 'Pipe') {
    const pipe = expect(state, 'Pipe', [...memberStarts, ...following])
    member = parseMember(pipe.state)
    children = [...children, ...pipe.elements, member.node]
    state = member.state
  }
  return { state, node: syntaxNode(state, 'RequirementRow', children) }
}

export const parseConstraint = (
  initial: State,
  following: ReadonlyArray<Token.TokenKind>,
): NodeResult => {
  const subject = parseType(initial, ['Identifier', 'Comma', ...following])
  if (hasContextualSpelling(subject.state, 'in')) {
    const keyword = expect(subject.state, 'Identifier', [...typeStarts, ...following])
    const source = parseType(keyword.state, following)
    return {
      state: source.state,
      node: syntaxNode(source.state, 'MembershipConstraint', [
        subject.node,
        ...keyword.elements,
        source.node,
      ]),
    }
  }
  const provides = expect(subject.state, 'Identifier', [...typeStarts, ...following])
  const selected = parseType(provides.state, ['Identifier', ...following])
  const from = expect(selected.state, 'Identifier', [...typeStarts, ...following])
  const source = parseType(from.state, following)
  return {
    state: source.state,
    node: syntaxNode(source.state, 'ProviderConstraint', [
      subject.node,
      ...provides.elements,
      selected.node,
      ...from.elements,
      source.node,
    ]),
  }
}

export const parseWhereClause = (
  initial: State,
  following: ReadonlyArray<Token.TokenKind>,
): NodeResult => {
  const where = expect(initial, 'Identifier', [...typeStarts, ...following])
  let constraint = parseConstraint(where.state, ['Comma', ...following])
  let state = constraint.state
  let children: ReadonlyArray<SyntaxTree.Element> = [...where.elements, constraint.node]
  while (nextSignificantKind(state) === 'Comma') {
    const comma = expect(state, 'Comma', [...typeStarts, ...following])
    constraint = parseConstraint(comma.state, ['Comma', ...following])
    children = [...children, ...comma.elements, constraint.node]
    state = constraint.state
  }
  return { state, node: syntaxNode(state, 'WhereClause', children) }
}

export const parseParameterList = (initial: State): NodeResult => {
  const leftParenthesis = expect(initial, 'LeftParenthesis', [
    'Ellipsis',
    'StaticKeyword',
    'MutKeyword',
    'Identifier',
    'RightParenthesis',
    'Arrow',
  ])
  let state = leftParenthesis.state
  let children: ReadonlyArray<SyntaxTree.Element> = leftParenthesis.elements
  let kind = nextSignificantKind(state)

  while (
    kind !== undefined &&
    kind !== 'RightParenthesis' &&
    kind !== 'Arrow' &&
    !(kind === 'StaticKeyword' && peek(state, 1) === 'FnKeyword') &&
    kind !== 'PubKeyword' &&
    kind !== 'StructKeyword' &&
    kind !== 'TupleKeyword' &&
    kind !== 'EnumKeyword' &&
    kind !== 'UnionKeyword' &&
    kind !== 'TypeKeyword' &&
    kind !== 'ExternKeyword' &&
    kind !== 'ExportKeyword' &&
    kind !== 'ServiceKeyword' &&
    kind !== 'FnKeyword' &&
    kind !== 'EffectKeyword' &&
    kind !== 'RightBrace' &&
    kind !== 'ImportKeyword' &&
    kind !== 'EndOfFile'
  ) {
    if (kind === 'Ellipsis') {
      const marker = expect(state, 'Ellipsis', ['RightParenthesis'])
      children = [...children, ...marker.elements]
      state = marker.state
      break
    }
    let modifier: ElementsResult = { state, elements: [] }
    if (nextSignificantKind(state) === 'StaticKeyword')
      modifier = expect(state, 'StaticKeyword', [
        'Identifier',
        'Colon',
        'Comma',
        'RightParenthesis',
        'Arrow',
      ])
    else if (nextSignificantKind(state) === 'MutKeyword')
      modifier = expect(state, 'MutKeyword', [
        'Identifier',
        'Colon',
        'Comma',
        'RightParenthesis',
        'Arrow',
      ])
    const name = expect(modifier.state, 'Identifier', [
      'Colon',
      'Comma',
      'RightParenthesis',
      'Arrow',
    ])
    const colon = expect(name.state, 'Colon', [
      ...typeStarts.filter((candidate) => candidate !== 'MutKeyword'),
      'Comma',
      'RightParenthesis',
      'Arrow',
    ])
    const type = parseType(colon.state, ['Comma', 'RightParenthesis', 'Arrow'])
    const parameter = syntaxNode(type.state, 'ParameterDeclaration', [
      ...modifier.elements,
      ...name.elements,
      ...colon.elements,
      type.node,
    ])
    children = [...children, parameter]
    state = type.state
    kind = nextSignificantKind(state)

    if (
      kind === 'RightParenthesis' ||
      kind === 'Arrow' ||
      (kind === 'StaticKeyword' && peek(state, 1) === 'FnKeyword') ||
      kind === 'PubKeyword' ||
      kind === 'StructKeyword' ||
      kind === 'TupleKeyword' ||
      kind === 'EnumKeyword' ||
      kind === 'UnionKeyword' ||
      kind === 'TypeKeyword' ||
      kind === 'ExternKeyword' ||
      kind === 'ExportKeyword' ||
      kind === 'ServiceKeyword' ||
      kind === 'FnKeyword' ||
      kind === 'EffectKeyword' ||
      kind === 'RightBrace' ||
      kind === 'ImportKeyword'
    )
      break

    const comma = expect(state, 'Comma', [
      'Ellipsis',
      'StaticKeyword',
      'MutKeyword',
      'Identifier',
      'RightParenthesis',
      'Arrow',
      'PubKeyword',
      'StructKeyword',
      'TupleKeyword',
      'EnumKeyword',
      'UnionKeyword',
      'TypeKeyword',
      'ExternKeyword',
      'ExportKeyword',
      'ServiceKeyword',
      'FnKeyword',
      'EffectKeyword',
      'RightBrace',
      'ImportKeyword',
    ])
    children = [...children, ...comma.elements]
    state = comma.state
    kind = nextSignificantKind(state)
  }

  const rightParenthesis = expect(state, 'RightParenthesis', [
    'Arrow',
    'PubKeyword',
    'StructKeyword',
    'TupleKeyword',
    'EnumKeyword',
    'UnionKeyword',
    'TypeKeyword',
    'ExternKeyword',
    'ExportKeyword',
    'ServiceKeyword',
    'FnKeyword',
    'EffectKeyword',
    'RightBrace',
    'ImportKeyword',
    'StaticKeyword',
  ])
  return {
    state: rightParenthesis.state,
    node: syntaxNode(rightParenthesis.state, 'ParameterList', [
      ...children,
      ...rightParenthesis.elements,
    ]),
  }
}
