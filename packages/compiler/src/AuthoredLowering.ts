import * as Effect from 'effect/Effect'
import * as AuthoredHir from './AuthoredHir.js'
import * as AuthoredIdentity from './AuthoredIdentity.js'
import * as AuthoredModule from './AuthoredModule.js'
import * as AuthoredPool from './AuthoredPool.js'
import * as AuthoredPresentation from './AuthoredPresentation.js'
import type * as AuthoredEncoding from './AuthoredEncoding.js'
import * as Diagnostic from './Diagnostic.js'
import * as DocBlock from './DocBlock.js'
import * as DigitSeparator from './internal/DigitSeparator.js'
import * as DurationLiteral from './internal/DurationLiteral.js'
import * as IntegerLiteral from './internal/IntegerLiteral.js'
import * as LiteralForm from './LiteralForm.js'
import * as Operator from './Operator.js'
import * as SourceFile from './SourceFile.js'
import type * as SourceSpan from './SourceSpan.js'
import type * as SyntaxFile from './SyntaxFile.js'
import * as SyntaxTree from './SyntaxTree.js'
import * as StaticText from './StaticText.js'
import type * as Token from './Token.js'

/**
 * Local lowering: one complete lossless `SyntaxFile` becomes one immutable authored module and one
 * separate presentation artifact. Every loaded form is lowered, including static bodies and both
 * arms of every `static if`; nothing is selected, resolved, typed, or evaluated here.
 */
export interface Lowered {
  readonly _tag: 'AuthoredLowering'
  readonly module: AuthoredHir.Module
  readonly presentation: AuthoredPresentation.Presentation
}

export type LoweringError =
  | AuthoredEncoding.AuthoredEncodingError
  | AuthoredModule.AuthoredModuleError
  | AuthoredPool.AuthoredPoolError
  | AuthoredPresentation.AuthoredPresentationError
  | AuthoredIdentity.AuthoredIdentityError

type Tag = AuthoredHir.Record['_tag']

/** How one concrete grammar category reaches the authored boundary. */
export type Disposition =
  | Tag
  | readonly Tag[]
  | { readonly container: string }
  | { readonly recovery: readonly Tag[]; readonly reason: string }

/**
 * Compile-time grammar inventory for the authored boundary. Containers contribute ordered fields to
 * their parent. Adding a grammar kind or removing its authored representation requires a deliberate
 * update here and in the lowering below.
 */
export const coverage = {
  SourceFile: { container: 'AuthoredModule.declarations and its module-owned pool' },
  ImportDeclaration: 'ImportHeader',
  StaticConditionalDeclaration: 'ConditionalHeader',
  DeclarationGroup: 'GroupHeader',
  ImportPath: 'Path',
  ImportAlias: 'Name',
  ImportMemberList: { container: 'ImportHeader.members in authored order' },
  ImportMember: 'ImportMember',
  StructDeclaration: 'StructHeader',
  TupleDeclaration: 'TupleHeader',
  EnumDeclaration: 'EnumHeader',
  EnumMember: 'EnumMember',
  UnionDeclaration: 'UnionHeader',
  UnionVariant: 'Variant',
  UnionVariantField: 'Field',
  AppliedMemberSelector: 'MemberSelector',
  AppliedMemberExpression: 'MemberExpression',
  UnionVariantPattern: 'VariantPattern',
  ServiceDeclaration: 'ServiceHeader',
  InterfaceDeclaration: 'InterfaceHeader',
  RoleDeclaration: 'RoleHeader',
  RequirementSelector: 'RequirementSelector',
  ServiceOperation: 'OperationHeader',
  OperatorMarker: { container: 'OperationHeader.operator preserves the operation marker' },
  ServiceInvalidMember: {
    recovery: ['InvalidDeclarationHeader'],
    reason: 'Retain the local recovery cause and healthy member structure',
  },
  ConstantDeclaration: 'ConstantHeader',
  PackageParameterDeclaration: 'PackageParameterHeader',
  PackageParameterValidation: { container: 'PackageParameterBody.validation expression' },
  TypeAliasDeclaration: 'AliasHeader',
  StructField: 'Field',
  ImplDeclaration: 'ImplHeader',
  ImplOperation: 'ImplAliasHeader',
  TypeParameterList: { container: 'Ordered generic parameters on the owning header or contract' },
  TypeParameter: ['TypeParameter', 'RowParameter'],
  LifetimeParameter: 'LifetimeParameter',
  LifetimeType: 'Lifetime',
  LifetimeBinderList: { container: 'Ordered LifetimeParameter binders' },
  EffectEnvironment: {
    container: 'CallableContract.environment preserves explicit empty presence',
  },
  CallableEnvironment: { container: 'CallableType.environment lifetime' },
  TypePath: 'NamedType',
  AppliedType: 'AppliedType',
  TypeArgumentList: 'TypeArguments',
  FixedArrayType: 'FixedArrayType',
  SliceType: 'SliceType',
  ReferenceType: 'ReferenceType',
  PointerType: 'PointerType',
  PointerQualifier: 'PointerQualifier',
  CallableType: 'CallableType',
  ForeignFunctionType: 'ForeignFunctionType',
  ExactRepresentationType: 'ExactRepresentationType',
  OpaqueResultType: 'OpaqueResultType',
  UnitType: 'UnitType',
  ParenthesizedType: {
    container: 'The enclosed type; grouping has no independent authored meaning',
  },
  UnionType: 'UnionType',
  FunctionDeclaration: 'FunctionHeader',
  ForeignFunctionDeclaration: 'FunctionHeader',
  ModulePropertyDeclaration: 'ModulePropertyHeader',
  FunctionPropertyClause: 'PropertyClause',
  FunctionProperty: 'Property',
  ForeignStaticDeclaration: 'StaticHeader',
  ExportStaticDeclaration: 'StaticHeader',
  FailureRow: { container: 'CallableContract.failures or TypeArguments.failures type' },
  RequirementRow: 'RequirementRow',
  Requirement: 'Requirement',
  RowWithout: 'RowWithout',
  WhereClause: { container: 'CallableContract.constraints in authored order' },
  MembershipConstraint: 'MembershipConstraint',
  ProviderConstraint: 'ProviderConstraint',
  ParameterList: { container: 'CallableContract.parameters in authored order and variadic marker' },
  ParameterDeclaration: 'Parameter',
  ReturnType: { container: 'CallableContract.result type' },
  Block: 'Block',
  ExpressionStatement: 'ExpressionStatement',
  ErrorStatement: {
    recovery: ['MissingStatement', 'InvalidStatement'],
    reason: 'Keep statement-local causes and any healthy retained expressions or statements',
  },
  BindingStatement: 'BindingStatement',
  PatternBindingStatement: 'PatternBindingStatement',
  AssignmentStatement: 'AssignmentStatement',
  ConditionalStatement: 'ConditionalStatement',
  StaticConditionalStatement: 'StaticConditionalStatement',
  StaticForStatement: 'StaticForStatement',
  PatternConditionalStatement: 'PatternConditionalStatement',
  WhileStatement: 'WhileStatement',
  BreakStatement: 'BreakStatement',
  ContinueStatement: 'ContinueStatement',
  ReturnStatement: 'ReturnStatement',
  FailStatement: 'FailStatement',
  DropStatement: 'DropStatement',
  UnsafeStatement: 'UnsafeStatement',
  UnsafeExpression: 'UnsafeExpression',
  CompileErrorExpression: 'CompileErrorExpression',
  IntegerLiteralExpression: 'IntegerLiteral',
  DurationLiteralExpression: ['DurationLiteral', 'InvalidExpression'],
  FloatingLiteralExpression: ['FloatingLiteral', 'InvalidExpression'],
  StaticTextLiteralExpression: ['TextLiteral', 'BytesLiteral', 'InvalidExpression'],
  CharacterLiteralExpression: ['CharacterLiteral', 'InvalidExpression'],
  UnitExpression: 'UnitLiteral',
  BooleanLiteralExpression: 'BooleanLiteral',
  IdentifierExpression: 'IdentifierExpression',
  MoveExpression: 'MoveExpression',
  AnonymousCallableExpression: 'CallableExpression',
  EffectExpression: 'EffectExpression',
  RunExpression: 'RunExpression',
  BorrowExpression: 'BorrowExpression',
  MatchExpression: 'MatchExpression',
  MatchAccess: {
    container: 'MatchExpression.access preserves default, place, move and borrow modes',
  },
  MatchArm: 'MatchArm',
  ErrorPattern: {
    recovery: ['MissingPattern', 'InvalidPattern'],
    reason: 'Keep pattern-local causes and healthy retained patterns',
  },
  EnumMemberPattern: 'EnumPattern',
  IntegerPattern: 'IntegerPattern',
  NominalPattern: 'NominalPattern',
  BindingPattern: 'BindingPattern',
  UniversalPattern: 'UniversalPattern',
  PatternField: 'PatternField',
  RestPattern: 'RestPattern',
  StructLiteralExpression: 'StructExpression',
  TupleLiteralExpression: 'TupleExpression',
  ContextualRecordLiteralExpression: 'RecordExpression',
  ArrayLiteralExpression: 'ArrayExpression',
  StructFieldInitializer: 'FieldInitializer',
  FieldProjectionExpression: 'FieldExpression',
  OrdinalProjectionExpression: 'OrdinalExpression',
  ReferentProjectionExpression: 'ReferentExpression',
  IndexProjectionExpression: 'IndexExpression',
  CallExpression: 'CallExpression',
  CallTypeArgumentList: 'TypeArguments',
  GroupedExpression: {
    container: 'The enclosed expression; grouping is already reflected in operand structure',
  },
  PrefixExpression: 'PrefixExpression',
  InfixExpression: 'InfixExpression',
  PipelineExpression: 'PipelineExpression',
  ArgumentList: { container: 'CallExpression.arguments in evaluation order' },
  Error: {
    recovery: [
      'MissingExpression',
      'InvalidExpression',
      'MissingType',
      'InvalidType',
      'MissingName',
      'MissingPattern',
      'InvalidPattern',
      'MissingStatement',
      'InvalidStatement',
      'InvalidDeclarationHeader',
    ],
    reason: 'The containing semantic position chooses its recovery record and retains local causes',
  },
} as const satisfies Record<SyntaxTree.NodeKind, Disposition>

// ---------------------------------------------------------------------------------------------
// Construction state
// ---------------------------------------------------------------------------------------------

/** One position in an owner's authored structure; children allocate same-role occurrences. */
interface Cursor {
  readonly owner: AuthoredIdentity.Identity
  readonly path: ReadonlyArray<AuthoredIdentity.LocalSegment>
  readonly counts: Map<string, number>
}

/** Lexical names visible at one point of a body; frames nest per block, arm and callable. */
interface Frame {
  readonly names: Map<string, AuthoredHir.LexicalReference>
  readonly parent: Frame | undefined
}

interface Draft {
  readonly syntax: SyntaxFile.SyntaxFile
  readonly source: SourceFile.SourceFile
  readonly texts: string[]
  readonly textIndex: Map<string, number>
  readonly bytes: number[][]
  readonly byteIndex: Map<string, number>
  readonly entries: AuthoredPresentation.Entry[]
  /** Frontend diagnostic codes by exact span key, for recovery causes. */
  readonly codesBySpan: Map<string, ReadonlyArray<string>>
  readonly frontendDiagnostics: ReadonlyArray<Diagnostic.Diagnostic>
  /** Declaration header anchors by source range, for diagnostic presentation anchors. */
  readonly declarationAnchors: Array<{
    readonly span: SourceSpan.SourceSpan
    readonly anchor: AuthoredHir.Anchor
  }>
  /** Why a literal failed to decode, presented at its own anchor for the semantic diagnostic. */
  readonly literalDiagnostics: AuthoredPresentation.Diagnostic[]
}

const decoder = new TextDecoder()

const spanKey = (span: { readonly start: number; readonly end: number }): string =>
  `${span.start}:${span.end}`

const triviaKinds: ReadonlySet<Token.TokenKind> = new Set<Token.TokenKind>([
  'Whitespace',
  'LineComment',
  'DocComment',
  'ModuleDocComment',
])

/** Where a syntax element is presented from: its first byte that is not leading trivia. */
export const firstSignificantStart = (element: SyntaxTree.Element): number | undefined => {
  if (SyntaxTree.isToken(element))
    return triviaKinds.has(element.kind) ? undefined : element.span.start
  if (SyntaxTree.isMissingToken(element)) return element.span.start
  for (const child of element.children) {
    const start = firstSignificantStart(child)
    if (start !== undefined) return start
  }
  return undefined
}

/** Parser nodes carry their leading trivia; presentation spans start at the first significant byte. */
const spanOf = (element: SyntaxTree.Element): SourceSpan.SourceSpan => {
  if (!SyntaxTree.isNode(element)) return element.span
  const start = firstSignificantStart(element)
  return start === undefined || start === element.span.start
    ? element.span
    : { ...element.span, start }
}

const rootCursor = (owner: AuthoredIdentity.Identity): Cursor =>
  ({ owner, path: [], counts: new Map() }) as const

const child = (cursor: Cursor, role: string): Cursor => {
  const occurrence = cursor.counts.get(role) ?? 0
  cursor.counts.set(role, occurrence + 1)
  return {
    owner: cursor.owner,
    // Exact-size copy: anchors retain these paths for the whole compilation.
    path: cursor.path.concat({ _tag: 'LocalSegment', role, occurrence }),
    counts: new Map(),
  }
}

const anchorOf = (cursor: Cursor): AuthoredHir.Anchor => ({
  _tag: 'AuthoredAnchor',
  owner: cursor.owner,
  path: cursor.path,
})

const authored: AuthoredHir.Origin = { _tag: 'Authored' }
/** Shared by every undamaged node; publication clones preserve the sharing, freezing it once. */
const noCauses: ReadonlyArray<AuthoredHir.Cause> = []

const slice = (draft: Draft, span: SourceSpan.SourceSpan): Uint8Array =>
  draft.source.bytes.slice(span.start, span.end)

const spellingOf = (draft: Draft, span: SourceSpan.SourceSpan): string =>
  decoder.decode(slice(draft, span))

const text = (draft: Draft, value: string): AuthoredPool.TextRef => {
  const existing = draft.textIndex.get(value)
  if (existing !== undefined) return { _tag: 'TextRef', index: existing }
  const index = draft.texts.length
  draft.texts.push(value)
  draft.textIndex.set(value, index)
  return { _tag: 'TextRef', index }
}

const bytes = (draft: Draft, value: ReadonlyArray<number>): AuthoredPool.BytesRef => {
  const key = value.join(',')
  const existing = draft.byteIndex.get(key)
  if (existing !== undefined) return { _tag: 'BytesRef', index: existing }
  const index = draft.bytes.length
  draft.bytes.push([...value])
  draft.byteIndex.set(key, index)
  return { _tag: 'BytesRef', index }
}

/** Builds the shared node fields at a cursor and records its current presentation. */
const node = (
  draft: Draft,
  cursor: Cursor,
  span: SourceSpan.SourceSpan,
  display: {
    readonly spelling?: string | undefined
    readonly documentation?: string | undefined
  } = {},
  origin: AuthoredHir.Origin = authored,
): AuthoredHir.Node => {
  const anchor = anchorOf(cursor)
  draft.entries.push({
    anchor,
    span: { start: span.start, end: span.end },
    ...(display.spelling === undefined ? {} : { spelling: display.spelling }),
    ...(display.documentation === undefined ? {} : { documentation: display.documentation }),
  })
  return { anchor, origin, causes: noCauses }
}

/** Recovery causes name the frontend diagnostic covering the damaged region when one exists. */
const causesAt = (
  draft: Draft,
  cursor: Cursor,
  span: SourceSpan.SourceSpan,
  fallback: string,
): AuthoredHir.RecoveryCauses => {
  const anchor = anchorOf(cursor)
  const exact = draft.codesBySpan.get(spanKey(span))
  const codes =
    exact ??
    draft.frontendDiagnostics
      .filter((d) => d.span.start >= span.start && d.span.end <= span.end)
      .map((d) => d.code)
  const distinct = [...new Set(codes.length === 0 ? [fallback] : codes)]
  const [first, ...rest] = distinct.map((code): AuthoredHir.Cause => ({
    _tag: 'Cause',
    anchor,
    code,
  }))
  return [first ?? { _tag: 'Cause', anchor, code: fallback }, ...rest]
}

const isNode = SyntaxTree.isNode
const isToken = SyntaxTree.isToken
const isMissing = SyntaxTree.isMissingToken

const nodes = (parent: SyntaxTree.Node): ReadonlyArray<SyntaxTree.Node> =>
  parent.children.filter(isNode)

const token = (parent: SyntaxTree.Node, kind: Token.TokenKind): Token.Token | undefined =>
  SyntaxTree.directToken(parent, kind)

const missing = (
  parent: SyntaxTree.Node,
  expected: Token.TokenKind,
): SyntaxTree.MissingToken | undefined =>
  parent.children.find(
    (element): element is SyntaxTree.MissingToken =>
      isMissing(element) && element.expected === expected,
  )

const hasToken = (parent: SyntaxTree.Node, kind: Token.TokenKind): boolean =>
  token(parent, kind) !== undefined

/**
 * Presents one written modifier keyword at its own cursor, so a diagnostic about that modifier can
 * name the keyword alone. Absent when the header does not spell it.
 */
const modifierAnchor = (
  draft: Draft,
  cursor: Cursor,
  parent: SyntaxTree.Node,
  kind: Token.TokenKind,
  role: string,
): AuthoredHir.Anchor | undefined => {
  const marker = token(parent, kind)
  return marker === undefined ? undefined : node(draft, child(cursor, role), marker.span).anchor
}

/** A contextual modifier must precede `fn`; an ordinary function named `test` is not a marker. */
const contextualModifier = (
  draft: Draft,
  cursor: Cursor,
  parent: SyntaxTree.Node,
  spelling: string,
  role: string,
): AuthoredHir.Anchor | undefined => {
  const tokens = parent.children.filter(isToken)
  const fnIndex = tokens.findIndex((candidate) => candidate.kind === 'FnKeyword')
  const marker = tokens
    .slice(0, fnIndex < 0 ? 0 : fnIndex)
    .find(
      (candidate) =>
        candidate.kind === 'Identifier' && spellingOf(draft, spanOf(candidate)) === spelling,
    )
  return marker === undefined ? undefined : node(draft, child(cursor, role), marker.span).anchor
}

const spelled = (
  draft: Draft,
  parent: SyntaxTree.Node,
  spelling: string,
): Token.Token | undefined =>
  parent.children.find(
    (element): element is Token.Token =>
      isToken(element) &&
      element.kind === 'Identifier' &&
      spellingOf(draft, spanOf(element)) === spelling,
  )

/** Direct error regions of a node, each becoming one local cause on the enclosing record. */
const errorRegions = (parent: SyntaxTree.Node): ReadonlyArray<SyntaxTree.Node> =>
  nodes(parent).filter((n) => n.kind === 'Error')

const damage = (
  draft: Draft,
  cursor: Cursor,
  parent: SyntaxTree.Node,
): ReadonlyArray<AuthoredHir.Cause> => {
  const causes: AuthoredHir.Cause[] = []
  for (const element of parent.children) {
    if (isMissing(element)) {
      causes.push(...causesAt(draft, cursor, spanOf(element), Diagnostic.missingTokenCode))
    } else if (isNode(element) && element.kind === 'Error') {
      causes.push(...causesAt(draft, cursor, spanOf(element), Diagnostic.unexpectedTokensCode))
    }
  }
  return causes
}

const withCauses = <N extends AuthoredHir.Node>(
  record: N,
  causes: ReadonlyArray<AuthoredHir.Cause>,
): N => (causes.length === 0 ? record : { ...record, causes: [...record.causes, ...causes] })

// ---------------------------------------------------------------------------------------------
// Names, paths, literals
// ---------------------------------------------------------------------------------------------

const nameFromToken = (draft: Draft, cursor: Cursor, tokenValue: Token.Token): AuthoredHir.Name => {
  const spelling = spellingOf(draft, tokenValue.span)
  return {
    ...node(draft, cursor, tokenValue.span, { spelling }),
    _tag: 'Name',
    text: text(draft, spelling),
  }
}

const missingName = (
  draft: Draft,
  cursor: Cursor,
  span: SourceSpan.SourceSpan,
  fallback: string = Diagnostic.missingTokenCode,
): AuthoredHir.Name => {
  const base = node(draft, cursor, span)
  return { ...base, _tag: 'MissingName', causes: causesAt(draft, cursor, span, fallback) }
}

/** A name from the first direct token of the accepted kinds, or an explicit missing name. */
const nameIn = (
  draft: Draft,
  cursor: Cursor,
  parent: SyntaxTree.Node,
  kinds: ReadonlyArray<Token.TokenKind>,
  role = 'name',
): AuthoredHir.Name => {
  const own = child(cursor, role)
  for (const element of parent.children) {
    if (isToken(element) && kinds.includes(element.kind)) return nameFromToken(draft, own, element)
    if (isMissing(element) && kinds.includes(element.expected))
      return missingName(draft, own, spanOf(element))
  }
  return missingName(draft, own, spanOf(parent))
}

/** The name immediately after `fn`, excluding contextual modifiers retained as identifiers. */
const callableNameIn = (
  draft: Draft,
  cursor: Cursor,
  parent: SyntaxTree.Node,
): AuthoredHir.Name => {
  const own = child(cursor, 'name')
  let afterFn = false
  for (const element of parent.children) {
    if (isToken(element) && element.kind === 'FnKeyword') {
      afterFn = true
      continue
    }
    if (!afterFn) continue
    if (isToken(element) && (element.kind === 'Identifier' || element.kind === 'DropKeyword'))
      return nameFromToken(draft, own, element)
    if (
      isMissing(element) &&
      (element.expected === 'Identifier' || element.expected === 'DropKeyword')
    )
      return missingName(draft, own, spanOf(element))
  }
  return missingName(draft, own, spanOf(parent))
}

/** Every accepted name token of a node in order, each as an authored name. */
const namesIn = (
  draft: Draft,
  cursor: Cursor,
  parent: SyntaxTree.Node,
  kinds: ReadonlyArray<Token.TokenKind>,
  role: string,
): ReadonlyArray<AuthoredHir.Name> => {
  const names: AuthoredHir.Name[] = []
  for (const element of parent.children) {
    if (isToken(element) && kinds.includes(element.kind))
      names.push(nameFromToken(draft, child(cursor, role), element))
    else if (isMissing(element) && kinds.includes(element.expected))
      names.push(missingName(draft, child(cursor, role), spanOf(element)))
  }
  return names
}

const identifierKinds: ReadonlyArray<Token.TokenKind> = ['Identifier']

/** Import paths admit contextual keyword segments; every retained segment token is a name. */
const importSegmentKinds: ReadonlyArray<Token.TokenKind> = [
  'Identifier',
  'PubKeyword',
  'StructKeyword',
  'EnumKeyword',
  'UnionKeyword',
  'TypeKeyword',
  'ServiceKeyword',
  'InterfaceKeyword',
  'RoleKeyword',
  'EffectKeyword',
  'FnKeyword',
  'RunKeyword',
  'FailKeyword',
  'DropKeyword',
  'UnsafeKeyword',
  'ImplKeyword',
  'ForKeyword',
  'ReturnKeyword',
  'ImportKeyword',
  'AsKeyword',
  'LetKeyword',
  'ConstKeyword',
  'MutKeyword',
  'OnceKeyword',
  'MoveKeyword',
  'MatchKeyword',
  'IfKeyword',
  'ElseKeyword',
  'WhileKeyword',
  'BreakKeyword',
  'ContinueKeyword',
  'TrueKeyword',
  'FalseKeyword',
]

const pathOf = (
  draft: Draft,
  cursor: Cursor,
  parent: SyntaxTree.Node,
  kinds: ReadonlyArray<Token.TokenKind>,
): AuthoredHir.Path => {
  const own = child(cursor, 'path')
  const base = node(draft, own, spanOf(parent))
  const segments = namesIn(draft, own, parent, kinds, 'segment')
  return withCauses(
    {
      ...base,
      _tag: 'Path',
      segments:
        segments.length === 0
          ? [missingName(draft, child(own, 'segment'), spanOf(parent))]
          : segments,
    },
    damage(draft, own, parent),
  )
}

const integerFromToken = (
  draft: Draft,
  cursor: Cursor,
  span: SourceSpan.SourceSpan,
  digits: Token.Token,
  negative: boolean,
): AuthoredHir.IntegerLiteral => {
  const raw = slice(draft, digits.span)
  const magnitude = IntegerLiteral.magnitude(raw)
  const radix = IntegerLiteral.recognize(raw).radix
  return {
    ...node(draft, cursor, span, { spelling: spellingOf(draft, span) }),
    _tag: 'IntegerLiteral',
    value: negative ? -magnitude : magnitude,
    radix,
    suffix: undefined,
  }
}

/** `[Minus?, DecimalInteger]` in expression, pattern, or bare-token position. */
const integerLiteral = (
  draft: Draft,
  cursor: Cursor,
  parent: SyntaxTree.Node,
): AuthoredHir.IntegerLiteral | AuthoredHir.MissingExpression => {
  const digits = token(parent, 'DecimalInteger')
  if (digits === undefined) return missingExpression(draft, cursor, spanOf(parent))
  return integerFromToken(draft, cursor, spanOf(parent), digits, hasToken(parent, 'Minus'))
}

const missingExpression = (
  draft: Draft,
  cursor: Cursor,
  span: SourceSpan.SourceSpan,
  fallback: string = Diagnostic.missingTokenCode,
): AuthoredHir.MissingExpression => ({
  ...node(draft, cursor, span),
  _tag: 'MissingExpression',
  causes: causesAt(draft, cursor, span, fallback),
})

const invalidExpression = (
  draft: Draft,
  cursor: Cursor,
  span: SourceSpan.SourceSpan,
  fallback: string,
  retained: ReadonlyArray<AuthoredHir.Expression> = [],
): AuthoredHir.InvalidExpression => ({
  ...node(draft, cursor, span),
  _tag: 'InvalidExpression',
  causes: causesAt(draft, cursor, span, fallback),
  retained,
})

/**
 * A literal whose spelling lexes but does not decode. The lexer accepted it, so no frontend
 * diagnostic explains the damage: the decoder's reason is presented for elaboration to report.
 */
const undecodableLiteral = (
  draft: Draft,
  cursor: Cursor,
  span: SourceSpan.SourceSpan,
  detail: string,
): AuthoredHir.InvalidExpression => {
  const invalid = invalidExpression(draft, cursor, span, Diagnostic.invalidStaticLiteralCode)
  draft.literalDiagnostics.push({
    anchor: invalid.anchor,
    span: { start: span.start, end: span.end },
    code: Diagnostic.invalidStaticLiteralCode,
    message: detail,
  })
  return invalid
}

const decimalFloat = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/

const floatingLiteral = (
  draft: Draft,
  cursor: Cursor,
  parent: SyntaxTree.Node,
): AuthoredHir.Expression => {
  const digits = token(parent, 'DecimalFloat')
  if (digits === undefined) return missingExpression(draft, cursor, spanOf(parent))
  const match = decimalFloat.exec(DigitSeparator.strip(slice(draft, digits.span)))
  if (match === null)
    return invalidExpression(draft, cursor, spanOf(parent), Diagnostic.missingExponentDigitsCode)
  const whole = match[1] ?? ''
  const fraction = match[2] ?? ''
  const exponent = BigInt(match[3] ?? '0') - BigInt(fraction.length)
  return {
    ...node(draft, cursor, spanOf(parent), { spelling: spellingOf(draft, spanOf(parent)) }),
    _tag: 'FloatingLiteral',
    sign: hasToken(parent, 'Minus') ? 'Negative' : 'Positive',
    coefficient: BigInt(`${whole}${fraction}`),
    exponent,
    suffix: undefined,
  }
}

const durationLiteral = (
  draft: Draft,
  cursor: Cursor,
  parent: SyntaxTree.Node,
): AuthoredHir.Expression => {
  const literal = token(parent, 'DurationLiteral')
  if (literal === undefined) {
    const invalid = token(parent, 'InvalidDurationLiteral')
    return invalid === undefined
      ? missingExpression(draft, cursor, spanOf(parent))
      : invalidExpression(draft, cursor, invalid.span, Diagnostic.invalidDurationAmountCode)
  }
  const parsed = DurationLiteral.parse(slice(draft, literal.span))
  if (parsed._tag !== 'Valid')
    return invalidExpression(draft, cursor, literal.span, Diagnostic.invalidDurationAmountCode)
  const base = node(draft, cursor, literal.span, { spelling: spellingOf(draft, literal.span) })
  return {
    ...base,
    _tag: 'DurationLiteral',
    components: parsed.components.map((component) => ({
      ...node(draft, child(cursor, 'component'), literal.span),
      _tag: 'DurationComponent',
      magnitude: component.amount,
      unit: component.unit,
    })),
  }
}

const staticTextLiteral = (
  draft: Draft,
  cursor: Cursor,
  parent: SyntaxTree.Node,
): AuthoredHir.Expression => {
  const invalid = token(parent, 'InvalidStaticLiteral')
  if (invalid !== undefined)
    return invalidExpression(draft, cursor, invalid.span, Diagnostic.unterminatedStaticLiteralCode)
  const literal = token(parent, 'TextLiteral') ?? token(parent, 'ByteStringLiteral')
  if (literal === undefined) return missingExpression(draft, cursor, spanOf(parent))
  const raw = Array.from(slice(draft, literal.span))
  const form = LiteralForm.recognize(raw)
  const decoded = form === undefined ? undefined : StaticText.decode(raw, form)
  if (decoded?._tag === 'Invalid')
    return undecodableLiteral(draft, cursor, literal.span, decoded.detail)
  if (decoded === undefined || decoded._tag !== 'Decoded')
    return invalidExpression(draft, cursor, literal.span, Diagnostic.unterminatedStaticLiteralCode)
  const base = node(draft, cursor, literal.span, { spelling: spellingOf(draft, literal.span) })
  if (decoded.data.kind === 'Bytes')
    return { ...base, _tag: 'BytesLiteral', value: bytes(draft, decoded.data.bytes) }
  return {
    ...base,
    _tag: 'TextLiteral',
    value: text(draft, decoder.decode(Uint8Array.from(decoded.data.bytes))),
  }
}

const characterLiteral = (
  draft: Draft,
  cursor: Cursor,
  parent: SyntaxTree.Node,
): AuthoredHir.Expression => {
  const literal = token(parent, 'CharLiteral')
  if (literal === undefined) return missingExpression(draft, cursor, spanOf(parent))
  const raw = Array.from(slice(draft, literal.span))
  const form = LiteralForm.recognize(raw)
  const decoded = form === undefined ? undefined : StaticText.decodeScalar(raw, form)
  if (decoded?._tag === 'Invalid')
    return undecodableLiteral(draft, cursor, literal.span, decoded.detail)
  if (decoded === undefined || decoded._tag !== 'Scalar')
    return invalidExpression(
      draft,
      cursor,
      literal.span,
      Diagnostic.characterLiteralScalarCountCode,
    )
  return {
    ...node(draft, cursor, literal.span, { spelling: spellingOf(draft, literal.span) }),
    _tag: 'CharacterLiteral',
    scalar: decoded.value,
  }
}

/** An ABI or symbol text literal token in header position, or its explicit absence. */
const textLiteralToken = (
  draft: Draft,
  cursor: Cursor,
  parent: SyntaxTree.Node,
  role: string,
  index = 0,
): AuthoredHir.TextLiteral | AuthoredHir.MissingExpression | AuthoredHir.InvalidExpression => {
  const own = child(cursor, role)
  const literals = parent.children.filter(
    (element): element is Token.Token => isToken(element) && element.kind === 'TextLiteral',
  )
  const literal = literals[index]
  if (literal === undefined) {
    const absent = missing(parent, 'TextLiteral')
    return missingExpression(draft, own, absent?.span ?? spanOf(parent))
  }
  const raw = Array.from(slice(draft, literal.span))
  const form = LiteralForm.recognize(raw)
  const decoded = form === undefined ? undefined : StaticText.decode(raw, form)
  if (decoded === undefined || decoded._tag !== 'Decoded' || decoded.data.kind !== 'Text')
    return invalidExpression(draft, own, literal.span, Diagnostic.unterminatedStaticLiteralCode)
  return {
    ...node(draft, own, literal.span, { spelling: spellingOf(draft, literal.span) }),
    _tag: 'TextLiteral',
    value: text(draft, decoder.decode(Uint8Array.from(decoded.data.bytes))),
  }
}

// ---------------------------------------------------------------------------------------------
// Types, generics, contracts
// ---------------------------------------------------------------------------------------------

const lifetimeFromToken = (
  draft: Draft,
  cursor: Cursor,
  tokenValue: Token.Token,
): AuthoredHir.Lifetime => ({
  ...node(draft, cursor, tokenValue.span, { spelling: spellingOf(draft, tokenValue.span) }),
  _tag: 'Lifetime',
  name: nameFromToken(draft, child(cursor, 'name'), tokenValue),
})

const lifetimesIn = (
  draft: Draft,
  cursor: Cursor,
  parent: SyntaxTree.Node,
  role = 'lifetime',
): ReadonlyArray<AuthoredHir.Lifetime> =>
  parent.children
    .filter((element): element is Token.Token => isToken(element) && element.kind === 'Lifetime')
    .map((element) => lifetimeFromToken(draft, child(cursor, role), element))

const missingType = (
  draft: Draft,
  cursor: Cursor,
  span: SourceSpan.SourceSpan,
  fallback: string = Diagnostic.missingTokenCode,
): AuthoredHir.Type => ({
  ...node(draft, cursor, span),
  _tag: 'MissingType',
  causes: causesAt(draft, cursor, span, fallback),
})

const invalidType = (
  draft: Draft,
  cursor: Cursor,
  span: SourceSpan.SourceSpan,
  retained: ReadonlyArray<AuthoredHir.Type>,
): AuthoredHir.Type => ({
  ...node(draft, cursor, span),
  _tag: 'InvalidType',
  causes: causesAt(draft, cursor, span, Diagnostic.unexpectedTokensCode),
  retained,
})

const accessOf = (parent: SyntaxTree.Node): AuthoredHir.Access =>
  hasToken(parent, 'MutKeyword') ? 'Mutable' : 'Shared'

const parameterMode = (parent: SyntaxTree.Node): AuthoredHir.Parameter['mode'] => {
  if (hasToken(parent, 'StaticKeyword')) return 'Static'
  if (hasToken(parent, 'MutKeyword')) return 'Mutable'
  return 'Value'
}

const callableMode = (parent: SyntaxTree.Node): AuthoredHir.CallableMode | undefined => {
  if (hasToken(parent, 'MutKeyword')) return 'Mutable'
  if (hasToken(parent, 'OnceKeyword')) return 'Once'
  return undefined
}

/** Type nodes admitted as one operand position, or the explicit absence at `parent`. */
const typeChildren = (parent: SyntaxTree.Node): ReadonlyArray<SyntaxTree.Node> =>
  nodes(parent).filter((n) => isTypeKind(n.kind))

const typeKinds: ReadonlySet<SyntaxTree.NodeKind> = new Set<SyntaxTree.NodeKind>([
  'TypePath',
  'AppliedType',
  'FixedArrayType',
  'SliceType',
  'ReferenceType',
  'PointerType',
  'CallableType',
  'ForeignFunctionType',
  'ExactRepresentationType',
  'OpaqueResultType',
  'UnitType',
  'ParenthesizedType',
  'UnionType',
  'RowWithout',
  'LifetimeType',
  'Requirement',
  'Error',
])

const isTypeKind = (kind: SyntaxTree.NodeKind): boolean => typeKinds.has(kind)

const rowOperand = (
  draft: Draft,
  cursor: Cursor,
  syntax: SyntaxTree.Node,
): AuthoredHir.RowOperand =>
  syntax.kind === 'Requirement' ? requirement(draft, cursor, syntax) : type(draft, cursor, syntax)

const requirement = (
  draft: Draft,
  cursor: Cursor,
  syntax: SyntaxTree.Node,
): AuthoredHir.Requirement => {
  const own = child(cursor, 'requirement')
  const base = node(draft, own, spanOf(syntax))
  const typed = typeChildren(syntax).filter((n) => n.kind !== 'Requirement')
  const capability = typed[0]
  const rolePath = nodes(syntax).find((n) => n.kind === 'TypePath' && n !== capability)
  const access: AuthoredHir.Access | undefined = hasToken(syntax, 'Ampersand')
    ? accessOf(syntax)
    : undefined
  return withCauses(
    {
      ...base,
      _tag: 'Requirement',
      access,
      capability:
        capability === undefined
          ? missingType(draft, child(own, 'capability'), spanOf(syntax))
          : type(draft, child(own, 'capability'), capability),
      role:
        rolePath === undefined
          ? undefined
          : pathOf(draft, child(own, 'role'), rolePath, identifierKinds),
    },
    damage(draft, own, syntax),
  )
}

const requirementRow = (
  draft: Draft,
  cursor: Cursor,
  syntax: SyntaxTree.Node,
): AuthoredHir.RequirementRow => {
  const own = child(cursor, 'requirements')
  const base = node(draft, own, spanOf(syntax))
  return withCauses(
    {
      ...base,
      _tag: 'RequirementRow',
      members: nodes(syntax)
        .filter((n) => n.kind !== 'Error')
        .map((member) => rowOperand(draft, own, member)),
    },
    damage(draft, own, syntax),
  )
}

const typeArguments = (
  draft: Draft,
  cursor: Cursor,
  syntax: SyntaxTree.Node,
): AuthoredHir.TypeArguments => {
  const own = child(cursor, 'arguments')
  const base = node(draft, own, spanOf(syntax))
  const environment = nodes(syntax).find((n) => n.kind === 'EffectEnvironment')
  const failures = nodes(syntax).find((n) => n.kind === 'FailureRow')
  const requirements = nodes(syntax).find((n) => n.kind === 'RequirementRow')
  const argumentList: AuthoredHir.GenericArgument[] = []
  for (const element of nodes(syntax)) {
    if (element.kind === 'LifetimeType') {
      const lifetime = token(element, 'Lifetime')
      if (lifetime !== undefined)
        argumentList.push(lifetimeFromToken(draft, child(own, 'argument'), lifetime))
    } else if (element.kind === 'RequirementSelector') {
      argumentList.push(requirementSelector(draft, own, element))
    } else if (isTypeKind(element.kind) && element.kind !== 'Error') {
      argumentList.push(type(draft, child(own, 'argument'), element))
    }
  }
  return withCauses(
    {
      ...base,
      _tag: 'TypeArguments',
      arguments: argumentList,
      environment:
        environment === undefined
          ? undefined
          : lifetimesIn(draft, child(own, 'environment'), environment),
      failures: failures === undefined ? undefined : failureRow(draft, own, failures),
      requirements:
        requirements === undefined ? undefined : requirementRow(draft, own, requirements),
    },
    damage(draft, own, syntax),
  )
}

const requirementSelector = (
  draft: Draft,
  cursor: Cursor,
  syntax: SyntaxTree.Node,
): AuthoredHir.RequirementSelector => {
  const own = child(cursor, 'selector')
  const base = node(draft, own, spanOf(syntax))
  const [subject, role] = nodes(syntax)
  return withCauses(
    {
      ...base,
      _tag: 'RequirementSelector',
      subject:
        subject === undefined
          ? missingType(draft, child(own, 'subject'), spanOf(syntax))
          : type(draft, child(own, 'subject'), subject),
      role:
        role === undefined
          ? {
              ...node(draft, child(own, 'role'), spanOf(syntax)),
              _tag: 'Path',
              segments: [missingName(draft, child(own, 'role-name'), spanOf(syntax))],
            }
          : pathOf(draft, child(own, 'role'), role, identifierKinds),
    },
    damage(draft, own, syntax),
  )
}

const failureRow = (draft: Draft, cursor: Cursor, syntax: SyntaxTree.Node): AuthoredHir.Type => {
  const own = child(cursor, 'failures')
  const members = typeChildren(syntax)
  return members[0] === undefined
    ? missingType(draft, own, spanOf(syntax))
    : type(draft, own, members[0])
}

const genericParameters = (
  draft: Draft,
  cursor: Cursor,
  syntax: SyntaxTree.Node | undefined,
): ReadonlyArray<AuthoredHir.GenericParameter> => {
  if (syntax === undefined) return []
  const own = child(cursor, 'generics')
  const parameters: AuthoredHir.GenericParameter[] = []
  for (const element of nodes(syntax)) {
    if (element.kind !== 'TypeParameter' && element.kind !== 'LifetimeParameter') continue
    const parameterCursor = child(own, 'generic')
    const base = node(draft, parameterCursor, spanOf(element))
    const bounds = nodes(element).flatMap(
      (bound): AuthoredHir.Type | AuthoredHir.Lifetime | never[] => {
        if (bound.kind === 'LifetimeType') {
          const lifetime = token(bound, 'Lifetime')
          return lifetime === undefined
            ? []
            : lifetimeFromToken(draft, child(parameterCursor, 'bound'), lifetime)
        }
        if (bound.kind === 'Error') return []
        return type(draft, child(parameterCursor, 'bound'), bound)
      },
    )
    const causes = damage(draft, parameterCursor, element)
    if (element.kind === 'LifetimeParameter') {
      parameters.push(
        withCauses(
          {
            ...base,
            _tag: 'LifetimeParameter',
            name: nameIn(draft, parameterCursor, element, ['Lifetime']),
            bounds,
          },
          causes,
        ),
      )
    } else if (hasToken(element, 'Question')) {
      parameters.push(
        withCauses(
          {
            ...base,
            _tag: 'RowParameter',
            name: nameIn(draft, parameterCursor, element, identifierKinds),
          },
          causes,
        ),
      )
    } else {
      parameters.push(
        withCauses(
          {
            ...base,
            _tag: 'TypeParameter',
            name: nameIn(draft, parameterCursor, element, identifierKinds),
            bounds,
          },
          causes,
        ),
      )
    }
  }
  return parameters
}

const propertyClause = (
  draft: Draft,
  cursor: Cursor,
  syntax: SyntaxTree.Node,
): AuthoredHir.PropertyClause => {
  const own = child(cursor, 'property-clause')
  const base = node(draft, own, spanOf(syntax))
  const identifiers = syntax.children.filter(
    (element): element is Token.Token => isToken(element) && element.kind === 'Identifier',
  )
  // `with` is the first identifier; namespace and operation follow it.
  const namespaceToken = identifiers[1]
  const operationToken = identifiers[2]
  return withCauses(
    {
      ...base,
      _tag: 'PropertyClause',
      namespace:
        namespaceToken === undefined
          ? missingName(draft, child(own, 'namespace'), spanOf(syntax))
          : nameFromToken(draft, child(own, 'namespace'), namespaceToken),
      operation:
        operationToken === undefined
          ? missingName(draft, child(own, 'operation'), spanOf(syntax))
          : nameFromToken(draft, child(own, 'operation'), operationToken),
      properties: nodes(syntax)
        .filter((n) => n.kind === 'FunctionProperty')
        .map((property) => {
          const propertyCursor = child(own, 'property')
          const propertyBase = node(draft, propertyCursor, spanOf(property))
          const value = nodes(property)[0]
          return withCauses(
            {
              ...propertyBase,
              _tag: 'Property',
              name: nameIn(draft, propertyCursor, property, identifierKinds),
              value:
                value === undefined
                  ? missingExpression(draft, child(propertyCursor, 'value'), spanOf(property))
                  : expression(draft, child(propertyCursor, 'value'), value, undefined),
            },
            damage(draft, propertyCursor, property),
          )
        }),
    },
    damage(draft, own, syntax),
  )
}

const propertyClauses = (
  draft: Draft,
  cursor: Cursor,
  parent: SyntaxTree.Node,
): ReadonlyArray<AuthoredHir.PropertyClause> =>
  nodes(parent)
    .filter((n) => n.kind === 'FunctionPropertyClause')
    .map((clause) => propertyClause(draft, cursor, clause))

const parameterList = (
  draft: Draft,
  cursor: Cursor,
  syntax: SyntaxTree.Node | undefined,
  frame: Frame | undefined,
): { readonly parameters: ReadonlyArray<AuthoredHir.Parameter>; readonly variadic: boolean } => {
  if (syntax === undefined) return { parameters: [], variadic: false }
  const own = child(cursor, 'parameters')
  const parameters: AuthoredHir.Parameter[] = []
  for (const element of nodes(syntax)) {
    if (element.kind !== 'ParameterDeclaration') continue
    const parameterCursor = child(own, 'parameter')
    const base = node(draft, parameterCursor, spanOf(element), {
      documentation: documentationOf(draft, element),
    })
    const name = nameIn(draft, parameterCursor, element, identifierKinds)
    const typed = typeChildren(element)[0]
    const parameter: AuthoredHir.Parameter = withCauses(
      {
        ...base,
        _tag: 'Parameter',
        name,
        type:
          typed === undefined
            ? missingType(draft, child(parameterCursor, 'type'), spanOf(element))
            : type(draft, child(parameterCursor, 'type'), typed),
        mode: parameterMode(element),
      },
      damage(draft, parameterCursor, element),
    )
    parameters.push(parameter)
    if (frame !== undefined && name._tag === 'Name')
      frame.names.set(draft.texts[name.text.index] ?? '', {
        _tag: 'LexicalReference',
        owner: parameter.anchor.owner,
        path: parameter.anchor.path,
      })
  }
  return { parameters, variadic: hasToken(syntax, 'Ellipsis') }
}

const returnType = (
  draft: Draft,
  cursor: Cursor,
  syntax: SyntaxTree.Node | undefined,
): AuthoredHir.Type | undefined => {
  if (syntax === undefined) return undefined
  const own = child(cursor, 'result')
  const result = typeChildren(syntax)[0]
  return result === undefined ? missingType(draft, own, spanOf(syntax)) : type(draft, own, result)
}

/**
 * The contract of a function, operation, or anonymous callable. Header tokens live on `header`;
 * the contract pieces are direct child nodes of that same header node.
 */
const callableContract = (
  draft: Draft,
  cursor: Cursor,
  header: SyntaxTree.Node,
  frame: Frame | undefined,
): AuthoredHir.CallableContract => {
  const own = child(cursor, 'contract')
  const base = node(draft, own, header.span)
  const parts = nodes(header)
  const genericList = parts.find((n) => n.kind === 'TypeParameterList')
  const generics = genericParameters(draft, own, genericList)
  const { parameters, variadic } = parameterList(
    draft,
    own,
    parts.find((n) => n.kind === 'ParameterList'),
    frame,
  )
  const failures = parts.find((n) => n.kind === 'FailureRow')
  const requirements = parts.find((n) => n.kind === 'RequirementRow')
  const environment = parts.find((n) => n.kind === 'EffectEnvironment')
  const where = parts.find((n) => n.kind === 'WhereClause')
  const testAnchor = contextualModifier(draft, own, header, 'test', 'testMarker')
  return {
    ...base,
    _tag: 'CallableContract',
    generics,
    parameters,
    variadic,
    result: returnType(
      draft,
      own,
      parts.find((n) => n.kind === 'ReturnType'),
    ),
    failures: failures === undefined ? undefined : failureRow(draft, own, failures),
    requirements: requirements === undefined ? undefined : requirementRow(draft, own, requirements),
    constraints: where === undefined ? [] : constraints(draft, own, where),
    effect: hasToken(header, 'EffectKeyword'),
    test: testAnchor !== undefined,
    environment:
      environment === undefined
        ? undefined
        : lifetimesIn(draft, child(own, 'environment'), environment),
    unsafe: hasToken(header, 'UnsafeKeyword'),
    static: hasToken(header, 'StaticKeyword'),
    effectAnchor: modifierAnchor(draft, own, header, 'EffectKeyword', 'effectMarker'),
    testAnchor,
    unsafeAnchor: modifierAnchor(draft, own, header, 'UnsafeKeyword', 'unsafeMarker'),
    staticAnchor: modifierAnchor(draft, own, header, 'StaticKeyword', 'staticMarker'),
    genericsAnchor:
      genericList === undefined
        ? undefined
        : node(draft, child(own, 'genericList'), spanOf(genericList)).anchor,
    failuresAnchor:
      failures === undefined
        ? undefined
        : node(draft, child(own, 'failureRow'), spanOf(failures)).anchor,
    constraintsAnchor:
      where === undefined
        ? undefined
        : node(draft, child(own, 'whereClause'), spanOf(where)).anchor,
  }
}

const constraints = (
  draft: Draft,
  cursor: Cursor,
  syntax: SyntaxTree.Node,
): ReadonlyArray<AuthoredHir.Constraint> =>
  nodes(syntax).flatMap((constraint): AuthoredHir.Constraint | never[] => {
    if (constraint.kind !== 'MembershipConstraint' && constraint.kind !== 'ProviderConstraint')
      return []
    const own = child(cursor, 'constraint')
    const base = node(draft, own, spanOf(constraint))
    const operands = typeChildren(constraint)
    const operand = (index: number, role: string): AuthoredHir.Type => {
      const operandSyntax = operands[index]
      return operandSyntax === undefined
        ? missingType(draft, child(own, role), spanOf(constraint))
        : type(draft, child(own, role), operandSyntax)
    }
    // A row position admits a written requirement such as `&Work`, which is not a type.
    const row = (index: number, role: string): AuthoredHir.RowOperand => {
      const operandSyntax = operands[index]
      return operandSyntax === undefined
        ? missingType(draft, child(own, role), spanOf(constraint))
        : rowOperand(draft, child(own, role), operandSyntax)
    }
    const lowered: AuthoredHir.Constraint =
      constraint.kind === 'MembershipConstraint'
        ? {
            ...base,
            _tag: 'MembershipConstraint',
            subject: row(0, 'subject'),
            source: row(1, 'source'),
          }
        : {
            ...base,
            _tag: 'ProviderConstraint',
            provider: operand(0, 'provider'),
            selected: row(1, 'selected'),
            source: row(2, 'source'),
          }
    return withCauses(lowered, damage(draft, own, constraint))
  })

/** Lowers one type node in one authored position. Grouping parentheses have no meaning. */
const type = (draft: Draft, cursor: Cursor, syntax: SyntaxTree.Node): AuthoredHir.Type => {
  if (syntax.kind === 'ParenthesizedType') {
    const inner = typeChildren(syntax)[0]
    return inner === undefined
      ? missingType(draft, child(cursor, 'type'), spanOf(syntax))
      : type(draft, cursor, inner)
  }
  const own = child(cursor, 'type')
  const causes = damage(draft, own, syntax)
  const done = <T extends AuthoredHir.Type>(record: T): T => withCauses(record, causes)
  switch (syntax.kind) {
    case 'TypePath':
      return done({
        ...node(draft, own, spanOf(syntax), { spelling: spellingOf(draft, spanOf(syntax)) }),
        _tag: 'NamedType',
        path: pathOf(draft, own, syntax, identifierKinds),
        mode: callableMode(syntax),
      })
    case 'AppliedType': {
      const [target, argumentList] = nodes(syntax)
      const argumentsSyntax = nodes(syntax).find((n) => n.kind === 'TypeArgumentList')
      const targetSyntax = target?.kind === 'TypeArgumentList' ? undefined : target
      // The parser attaches `once`/`mut` of `once Effect<...>` to the applied node; the mode belongs
      // to the named target the arguments apply to.
      const mode = callableMode(syntax)
      const lowered =
        targetSyntax === undefined
          ? missingType(draft, child(own, 'target'), spanOf(syntax))
          : type(draft, child(own, 'target'), targetSyntax)
      return done({
        ...node(draft, own, spanOf(syntax)),
        _tag: 'AppliedType',
        target:
          mode !== undefined && lowered._tag === 'NamedType' && lowered.mode === undefined
            ? { ...lowered, mode }
            : lowered,
        arguments:
          argumentsSyntax === undefined
            ? {
                ...node(draft, child(own, 'arguments'), argumentList?.span ?? spanOf(syntax)),
                _tag: 'TypeArguments',
                arguments: [],
                environment: undefined,
                failures: undefined,
                requirements: undefined,
              }
            : typeArguments(draft, own, argumentsSyntax),
      })
    }
    case 'FixedArrayType': {
      const element = typeChildren(syntax)[0]
      const length = token(syntax, 'DecimalInteger')
      return done({
        ...node(draft, own, spanOf(syntax)),
        _tag: 'FixedArrayType',
        element:
          element === undefined
            ? missingType(draft, child(own, 'element'), spanOf(syntax))
            : type(draft, child(own, 'element'), element),
        length:
          length === undefined
            ? missingExpression(
                draft,
                child(own, 'length'),
                missing(syntax, 'DecimalInteger')?.span ?? spanOf(syntax),
              )
            : integerFromToken(draft, child(own, 'length'), length.span, length, false),
      })
    }
    case 'SliceType': {
      const element = typeChildren(syntax)[0]
      const lifetime = token(syntax, 'Lifetime')
      return done({
        ...node(draft, own, spanOf(syntax)),
        _tag: 'SliceType',
        element:
          element === undefined
            ? missingType(draft, child(own, 'element'), spanOf(syntax))
            : type(draft, child(own, 'element'), element),
        access: accessOf(syntax),
        lifetime:
          lifetime === undefined
            ? undefined
            : lifetimeFromToken(draft, child(own, 'lifetime'), lifetime),
      })
    }
    case 'ReferenceType': {
      const referent = typeChildren(syntax)[0]
      const lifetime = token(syntax, 'Lifetime')
      const role = hasToken(syntax, 'At') ? token(syntax, 'Identifier') : undefined
      return done({
        ...node(draft, own, spanOf(syntax)),
        _tag: 'ReferenceType',
        referent:
          referent === undefined
            ? missingType(draft, child(own, 'referent'), spanOf(syntax))
            : type(draft, child(own, 'referent'), referent),
        access: accessOf(syntax),
        lifetime:
          lifetime === undefined
            ? undefined
            : lifetimeFromToken(draft, child(own, 'lifetime'), lifetime),
        role: role === undefined ? undefined : nameFromToken(draft, child(own, 'role'), role),
      })
    }
    case 'PointerType': {
      const pointee = typeChildren(syntax)[0]
      return done({
        ...node(draft, own, spanOf(syntax)),
        _tag: 'PointerType',
        pointee:
          pointee === undefined
            ? missingType(draft, child(own, 'pointee'), spanOf(syntax))
            : type(draft, child(own, 'pointee'), pointee),
        access: accessOf(syntax),
        nullable: hasToken(syntax, 'Question'),
        multiplicity: hasToken(syntax, 'LeftBracket') ? 'Many' : 'Single',
        qualifiers: nodes(syntax)
          .filter((n) => n.kind === 'PointerQualifier')
          .map((qualifier) => {
            const qualifierCursor = child(own, 'qualifier')
            const value = token(qualifier, 'DecimalInteger')
            return withCauses(
              {
                ...node(draft, qualifierCursor, spanOf(qualifier)),
                _tag: 'PointerQualifier',
                name: nameIn(draft, qualifierCursor, qualifier, identifierKinds),
                value:
                  value === undefined
                    ? missingExpression(draft, child(qualifierCursor, 'value'), spanOf(qualifier))
                    : integerFromToken(
                        draft,
                        child(qualifierCursor, 'value'),
                        value.span,
                        value,
                        false,
                      ),
              },
              damage(draft, qualifierCursor, qualifier),
            )
          }),
      })
    }
    case 'CallableType': {
      const parts = nodes(syntax)
      const binders = parts.find((n) => n.kind === 'LifetimeBinderList')
      const environment = parts.find((n) => n.kind === 'CallableEnvironment')
      const operands = typeChildren(syntax).filter((n) => n.kind !== 'Error')
      const result = operands.at(-1)
      const parameters = operands.slice(0, -1)
      const environmentLifetime =
        environment === undefined ? undefined : token(environment, 'Lifetime')
      return done({
        ...node(draft, own, spanOf(syntax)),
        _tag: 'CallableType',
        mode: callableMode(syntax) ?? 'Shared',
        unsafe: hasToken(syntax, 'UnsafeKeyword'),
        binders: genericParameters(draft, own, binders),
        environment:
          environmentLifetime === undefined
            ? undefined
            : lifetimeFromToken(draft, child(own, 'environment'), environmentLifetime),
        parameters: parameters.map((parameter) => type(draft, child(own, 'parameter'), parameter)),
        result:
          result === undefined || !hasToken(syntax, 'Arrow')
            ? missingType(
                draft,
                child(own, 'result'),
                missing(syntax, 'Arrow')?.span ?? spanOf(syntax),
              )
            : type(draft, child(own, 'result'), result),
      })
    }
    case 'ForeignFunctionType': {
      const parts = nodes(syntax)
      const binders = parts.find((n) => n.kind === 'LifetimeBinderList')
      const operands = typeChildren(syntax).filter((n) => n.kind !== 'Error')
      const result = operands.at(-1)
      const parameters = operands.slice(0, -1)
      return done({
        ...node(draft, own, spanOf(syntax)),
        _tag: 'ForeignFunctionType',
        abi: textLiteralToken(draft, own, syntax, 'abi'),
        binders: genericParameters(draft, own, binders),
        parameters: parameters.map((parameter) => type(draft, child(own, 'parameter'), parameter)),
        result:
          result === undefined || !hasToken(syntax, 'Arrow')
            ? missingType(
                draft,
                child(own, 'result'),
                missing(syntax, 'Arrow')?.span ?? spanOf(syntax),
              )
            : type(draft, child(own, 'result'), result),
        properties: propertyClauses(draft, own, syntax),
      })
    }
    case 'ExactRepresentationType': {
      const subject = typeChildren(syntax)[0]
      return done({
        ...node(draft, own, spanOf(syntax)),
        _tag: 'ExactRepresentationType',
        subject:
          subject === undefined
            ? missingType(draft, child(own, 'subject'), spanOf(syntax))
            : type(draft, child(own, 'subject'), subject),
      })
    }
    case 'OpaqueResultType': {
      const binders = nodes(syntax).find((n) => n.kind === 'TypeParameterList')
      const result = typeChildren(syntax)[0]
      return done({
        ...node(draft, own, spanOf(syntax)),
        _tag: 'OpaqueResultType',
        binders: genericParameters(draft, own, binders),
        result:
          result === undefined
            ? missingType(draft, child(own, 'result'), spanOf(syntax))
            : type(draft, child(own, 'result'), result),
      })
    }
    case 'UnitType':
      return done({ ...node(draft, own, spanOf(syntax)), _tag: 'UnitType' })
    case 'UnionType':
      return done({
        ...node(draft, own, spanOf(syntax)),
        _tag: 'UnionType',
        members: nodes(syntax)
          .filter((n) => n.kind !== 'Error')
          .map((member) => rowOperand(draft, child(own, 'member'), member)),
      })
    case 'RowWithout': {
      const [source, removed] = nodes(syntax).filter((n) => n.kind !== 'Error')
      return done({
        ...node(draft, own, spanOf(syntax)),
        _tag: 'RowWithout',
        source:
          source === undefined
            ? missingType(draft, child(own, 'source'), spanOf(syntax))
            : rowOperand(draft, child(own, 'source'), source),
        removed:
          removed === undefined
            ? missingType(draft, child(own, 'removed'), spanOf(syntax))
            : rowOperand(draft, child(own, 'removed'), removed),
      })
    }
    case 'LifetimeType': {
      // A lifetime where a type is required is retained as an invalid type.
      return invalidType(draft, own, spanOf(syntax), [])
    }
    case 'Requirement':
      return invalidType(draft, own, spanOf(syntax), [])
    case 'Error':
      return invalidType(draft, own, spanOf(syntax), [])
    default:
      return invalidType(draft, own, spanOf(syntax), [])
  }
}

// ---------------------------------------------------------------------------------------------
// Owners and lexical frames
// ---------------------------------------------------------------------------------------------

const identityKey = (identity: AuthoredIdentity.Identity): string =>
  JSON.stringify([
    identity.namespace,
    identity.module,
    identity.path.map((part) => [part.kind, part.name ?? null, part.role ?? null, part.occurrence]),
  ])

/** Same-key sibling counters per parent owner; mirrors `AuthoredIdentity.children` incrementally. */
const ownerCounts = new WeakMap<Draft, Map<string, Map<string, number>>>()

const ownerChild = (
  draft: Draft,
  parent: AuthoredIdentity.Identity,
  key: AuthoredIdentity.Key,
): AuthoredIdentity.Identity => {
  const perDraft = ownerCounts.get(draft) ?? new Map<string, Map<string, number>>()
  ownerCounts.set(draft, perDraft)
  const parentKey = identityKey(parent)
  const counts = perDraft.get(parentKey) ?? new Map<string, number>()
  perDraft.set(parentKey, counts)
  const encoded = JSON.stringify([key.kind, key.name ?? null, key.role ?? null])
  const occurrence = counts.get(encoded) ?? 0
  counts.set(encoded, occurrence + 1)
  return {
    _tag: 'AuthoredIdentity',
    namespace: parent.namespace,
    module: parent.module,
    // `concat` allocates exactly; `[...path, segment]` leaves ~16 slots of slack per retained path.
    path: parent.path.concat({
      _tag: 'OwnerSegment',
      kind: key.kind,
      ...(key.name === undefined ? {} : { name: key.name }),
      ...(key.role === undefined ? {} : { role: key.role }),
      occurrence,
    }),
  }
}

const frame = (parent: Frame | undefined): Frame => ({ names: new Map(), parent })

const lookup = (
  frame: Frame | undefined,
  spelling: string,
): AuthoredHir.LexicalReference | undefined => {
  for (let current = frame; current !== undefined; current = current.parent) {
    const found = current.names.get(spelling)
    if (found !== undefined) return found
  }
  return undefined
}

const bind = (
  target: Frame | undefined,
  name: AuthoredHir.Name,
  binder: AuthoredHir.Node,
  draft: Draft,
): void => {
  if (target === undefined || name._tag !== 'Name') return
  target.names.set(draft.texts[name.text.index] ?? '', {
    _tag: 'LexicalReference',
    owner: binder.anchor.owner,
    path: binder.anchor.path,
  })
}

const documentationOf = (draft: Draft, syntax: SyntaxTree.Node): string | undefined => {
  const block = DocBlock.ofNode(draft.syntax, syntax)
  return block === undefined ? undefined : spellingOf(draft, block.span)
}

// ---------------------------------------------------------------------------------------------
// Expressions
// ---------------------------------------------------------------------------------------------

const expressionKinds: ReadonlySet<SyntaxTree.NodeKind> = new Set<SyntaxTree.NodeKind>([
  'UnsafeExpression',
  'CompileErrorExpression',
  'IntegerLiteralExpression',
  'DurationLiteralExpression',
  'FloatingLiteralExpression',
  'StaticTextLiteralExpression',
  'CharacterLiteralExpression',
  'UnitExpression',
  'BooleanLiteralExpression',
  'IdentifierExpression',
  'MoveExpression',
  'AnonymousCallableExpression',
  'EffectExpression',
  'RunExpression',
  'BorrowExpression',
  'MatchExpression',
  'StructLiteralExpression',
  'TupleLiteralExpression',
  'ContextualRecordLiteralExpression',
  'ArrayLiteralExpression',
  'FieldProjectionExpression',
  'OrdinalProjectionExpression',
  'ReferentProjectionExpression',
  'IndexProjectionExpression',
  'CallExpression',
  'GroupedExpression',
  'PrefixExpression',
  'InfixExpression',
  'PipelineExpression',
  'AppliedMemberExpression',
  'Error',
])

const isExpressionKind = (kind: SyntaxTree.NodeKind): boolean => expressionKinds.has(kind)

const expressionChildren = (parent: SyntaxTree.Node): ReadonlyArray<SyntaxTree.Node> =>
  nodes(parent).filter((n) => isExpressionKind(n.kind))

const operandAt = (
  draft: Draft,
  cursor: Cursor,
  parent: SyntaxTree.Node,
  index: number,
  role: string,
  frame: Frame | undefined,
): AuthoredHir.Expression => {
  const operands = expressionChildren(parent)
  const operand = operands[index]
  return operand === undefined
    ? missingExpression(draft, child(cursor, role), spanOf(parent))
    : expression(draft, child(cursor, role), operand, frame)
}

const fieldInitializers = (
  draft: Draft,
  cursor: Cursor,
  parent: SyntaxTree.Node,
  frame: Frame | undefined,
): ReadonlyArray<AuthoredHir.FieldInitializer> =>
  nodes(parent)
    .filter((n) => n.kind === 'StructFieldInitializer')
    .map((initializer) => {
      const own = child(cursor, 'field')
      return withCauses(
        {
          ...node(draft, own, spanOf(initializer)),
          _tag: 'FieldInitializer',
          name: nameIn(draft, own, initializer, identifierKinds),
          value: operandAt(draft, own, initializer, 0, 'value', frame),
        },
        damage(draft, own, initializer),
      )
    })

const memberSelector = (
  draft: Draft,
  cursor: Cursor,
  syntax: SyntaxTree.Node,
): AuthoredHir.MemberSelector => {
  const own = child(cursor, 'selector')
  const subject = typeChildren(syntax)[0]
  const identifiers = syntax.children.filter(
    (element): element is Token.Token => isToken(element) && element.kind === 'Identifier',
  )
  const member = identifiers.at(-1)
  return withCauses(
    {
      ...node(draft, own, spanOf(syntax)),
      _tag: 'MemberSelector',
      subject:
        subject === undefined
          ? missingType(draft, child(own, 'subject'), spanOf(syntax))
          : type(draft, child(own, 'subject'), subject),
      member:
        member === undefined
          ? missingName(
              draft,
              child(own, 'member'),
              missing(syntax, 'Identifier')?.span ?? spanOf(syntax),
            )
          : nameFromToken(draft, child(own, 'member'), member),
    },
    damage(draft, own, syntax),
  )
}

const prefixOperator = (syntax: SyntaxTree.Node): AuthoredHir.PrefixOperator => {
  if (hasToken(syntax, 'Bang')) return 'Not'
  if (hasToken(syntax, 'Tilde')) return 'BitwiseNot'
  return 'Negate'
}

/**
 * The anchor of the operator token an expression is written with. A damaged expression whose
 * operator is gone falls back to the expression itself.
 */
const operatorAnchor = (
  draft: Draft,
  cursor: Cursor,
  syntax: SyntaxTree.Node,
  own: AuthoredHir.Anchor,
): AuthoredHir.Anchor => {
  const written = syntax.children.find(
    (element): element is Token.Token =>
      isToken(element) &&
      (Operator.infix(element.kind) !== undefined || Operator.prefix(element.kind) !== undefined),
  )
  return written === undefined ? own : node(draft, child(cursor, 'operator'), written.span).anchor
}

const infixOperator = (syntax: SyntaxTree.Node): AuthoredHir.InfixOperator | undefined => {
  for (const element of syntax.children) {
    if (!isToken(element)) continue
    const info = Operator.infix(element.kind)
    if (info !== undefined) return info.operator
  }
  return undefined
}

type MatchAccess = Extract<AuthoredHir.Expression, { readonly _tag: 'MatchExpression' }>['access']

const matchAccess = (draft: Draft, syntax: SyntaxTree.Node | undefined): MatchAccess => {
  if (syntax === undefined) return 'Default'
  if (hasToken(syntax, 'MoveKeyword')) return 'Move'
  if (hasToken(syntax, 'Ampersand')) return hasToken(syntax, 'MutKeyword') ? 'Mutable' : 'Shared'
  if (spelled(draft, syntax, 'place') !== undefined) return 'Place'
  return 'Default'
}

const expression = (
  draft: Draft,
  cursor: Cursor,
  syntax: SyntaxTree.Node,
  frame: Frame | undefined,
): AuthoredHir.Expression => {
  const causes = damage(draft, cursor, syntax)
  const done = <T extends AuthoredHir.Expression>(record: T): T => withCauses(record, causes)
  switch (syntax.kind) {
    case 'GroupedExpression': {
      const inner = expressionChildren(syntax)[0]
      return inner === undefined
        ? missingExpression(draft, cursor, spanOf(syntax))
        : expression(draft, cursor, inner, frame)
    }
    case 'IntegerLiteralExpression':
      return done(integerLiteral(draft, cursor, syntax))
    case 'FloatingLiteralExpression':
      return done(floatingLiteral(draft, cursor, syntax))
    case 'DurationLiteralExpression':
      return done(durationLiteral(draft, cursor, syntax))
    case 'StaticTextLiteralExpression':
      return done(staticTextLiteral(draft, cursor, syntax))
    case 'CharacterLiteralExpression':
      return done(characterLiteral(draft, cursor, syntax))
    case 'UnitExpression':
      return done({ ...node(draft, cursor, spanOf(syntax)), _tag: 'UnitLiteral' })
    case 'BooleanLiteralExpression':
      return done({
        ...node(draft, cursor, spanOf(syntax)),
        _tag: 'BooleanLiteral',
        value: hasToken(syntax, 'TrueKeyword'),
      })
    case 'IdentifierExpression': {
      const name = nameIn(draft, cursor, syntax, identifierKinds)
      return done({
        ...node(draft, cursor, spanOf(syntax), { spelling: spellingOf(draft, spanOf(syntax)) }),
        _tag: 'IdentifierExpression',
        name,
        binding:
          name._tag === 'Name' ? lookup(frame, draft.texts[name.text.index] ?? '') : undefined,
      })
    }
    case 'MoveExpression':
      return done({
        ...node(draft, cursor, spanOf(syntax)),
        _tag: 'MoveExpression',
        operand: operandAt(draft, cursor, syntax, 0, 'operand', frame),
      })
    case 'BorrowExpression':
      return done({
        ...node(draft, cursor, spanOf(syntax)),
        _tag: 'BorrowExpression',
        access: accessOf(syntax),
        operand: operandAt(draft, cursor, syntax, 0, 'operand', frame),
      })
    case 'RunExpression':
      return done({
        ...node(draft, cursor, spanOf(syntax)),
        _tag: 'RunExpression',
        operand: operandAt(draft, cursor, syntax, 0, 'operand', frame),
      })
    case 'UnsafeExpression':
      return done({
        ...node(draft, cursor, spanOf(syntax)),
        _tag: 'UnsafeExpression',
        operand: operandAt(draft, cursor, syntax, 0, 'operand', frame),
      })
    case 'CompileErrorExpression':
      return done({
        ...node(draft, cursor, spanOf(syntax)),
        _tag: 'CompileErrorExpression',
        message: operandAt(draft, cursor, syntax, 0, 'message', frame),
      })
    case 'EffectExpression': {
      const body = nodes(syntax).find((n) => n.kind === 'Block')
      return done({
        ...node(draft, cursor, spanOf(syntax)),
        _tag: 'EffectExpression',
        body:
          body === undefined
            ? emptyBlock(draft, child(cursor, 'body'), spanOf(syntax))
            : block(draft, child(cursor, 'body'), body, frame),
      })
    }
    case 'AnonymousCallableExpression':
      return done(callableExpression(draft, cursor, syntax, frame))
    case 'MatchExpression': {
      const access = nodes(syntax).find((n) => n.kind === 'MatchAccess')
      return done({
        ...node(draft, cursor, spanOf(syntax)),
        _tag: 'MatchExpression',
        access: matchAccess(draft, access),
        subject: operandAt(draft, cursor, syntax, 0, 'subject', frame),
        arms: nodes(syntax)
          .filter((n) => n.kind === 'MatchArm')
          .map((arm) => matchArm(draft, child(cursor, 'arm'), arm, frame)),
      })
    }
    case 'StructLiteralExpression': {
      const target = typeChildren(syntax)[0]
      return done({
        ...node(draft, cursor, spanOf(syntax)),
        _tag: 'StructExpression',
        type:
          target === undefined
            ? missingType(draft, child(cursor, 'type'), spanOf(syntax))
            : type(draft, child(cursor, 'type'), target),
        fields: fieldInitializers(draft, cursor, syntax, frame),
      })
    }
    case 'ContextualRecordLiteralExpression':
      return done({
        ...node(draft, cursor, spanOf(syntax)),
        _tag: 'RecordExpression',
        fields: fieldInitializers(draft, cursor, syntax, frame),
      })
    case 'AppliedMemberExpression': {
      const selector = nodes(syntax).find((n) => n.kind === 'AppliedMemberSelector')
      return done({
        ...node(draft, cursor, spanOf(syntax)),
        _tag: 'MemberExpression',
        selector:
          selector === undefined
            ? {
                ...node(draft, child(cursor, 'selector'), spanOf(syntax)),
                _tag: 'MemberSelector',
                subject: missingType(draft, child(cursor, 'subject'), spanOf(syntax)),
                member: missingName(draft, child(cursor, 'member'), spanOf(syntax)),
              }
            : memberSelector(draft, cursor, selector),
        fields: hasToken(syntax, 'LeftBrace')
          ? fieldInitializers(draft, cursor, syntax, frame)
          : undefined,
      })
    }
    case 'TupleLiteralExpression':
      return done({
        ...node(draft, cursor, spanOf(syntax)),
        _tag: 'TupleExpression',
        elements: expressionChildren(syntax).map((element) =>
          expression(draft, child(cursor, 'element'), element, frame),
        ),
      })
    case 'ArrayLiteralExpression':
      return done({
        ...node(draft, cursor, spanOf(syntax)),
        _tag: 'ArrayExpression',
        elements: expressionChildren(syntax).map((element) =>
          expression(draft, child(cursor, 'element'), element, frame),
        ),
      })
    case 'FieldProjectionExpression':
      return done({
        ...node(draft, cursor, spanOf(syntax)),
        _tag: 'FieldExpression',
        subject: operandAt(draft, cursor, syntax, 0, 'subject', frame),
        field: nameIn(draft, cursor, syntax, ['Identifier', 'DropKeyword'], 'field'),
      })
    case 'OrdinalProjectionExpression': {
      const ordinal = token(syntax, 'DecimalInteger')
      return done({
        ...node(draft, cursor, spanOf(syntax)),
        _tag: 'OrdinalExpression',
        subject: operandAt(draft, cursor, syntax, 0, 'subject', frame),
        ordinal:
          ordinal === undefined
            ? missingExpression(draft, child(cursor, 'ordinal'), spanOf(syntax))
            : integerFromToken(draft, child(cursor, 'ordinal'), ordinal.span, ordinal, false),
      })
    }
    case 'ReferentProjectionExpression':
      return done({
        ...node(draft, cursor, spanOf(syntax)),
        _tag: 'ReferentExpression',
        subject: operandAt(draft, cursor, syntax, 0, 'subject', frame),
      })
    case 'IndexProjectionExpression':
      return done({
        ...node(draft, cursor, spanOf(syntax)),
        _tag: 'IndexExpression',
        subject: operandAt(draft, cursor, syntax, 0, 'subject', frame),
        index: operandAt(draft, cursor, syntax, 1, 'index', frame),
      })
    case 'CallExpression': {
      const generics = nodes(syntax).find((n) => n.kind === 'CallTypeArgumentList')
      const argumentList = nodes(syntax).find((n) => n.kind === 'ArgumentList')
      const listCursor = child(cursor, 'arguments-list')
      return done({
        ...node(draft, cursor, spanOf(syntax)),
        _tag: 'CallExpression',
        callee: operandAt(draft, cursor, syntax, 0, 'callee', frame),
        generics: generics === undefined ? undefined : typeArguments(draft, cursor, generics),
        arguments:
          argumentList === undefined
            ? []
            : withCausesList(
                expressionChildren(argumentList)
                  .filter((n) => n.kind !== 'Error')
                  .map((argument) =>
                    expression(draft, child(listCursor, 'argument'), argument, frame),
                  ),
                damage(draft, listCursor, argumentList),
                draft,
                listCursor,
                argumentList.span,
              ),
      })
    }
    case 'PrefixExpression': {
      const base = node(draft, cursor, spanOf(syntax))
      return done({
        ...base,
        _tag: 'PrefixExpression',
        operator: prefixOperator(syntax),
        operatorAnchor: operatorAnchor(draft, cursor, syntax, base.anchor),
        operand: operandAt(draft, cursor, syntax, 0, 'operand', frame),
      })
    }
    case 'InfixExpression': {
      const operator = infixOperator(syntax)
      const left = operandAt(draft, cursor, syntax, 0, 'left', frame)
      const right = operandAt(draft, cursor, syntax, 1, 'right', frame)
      if (operator === undefined)
        return invalidExpression(draft, cursor, spanOf(syntax), Diagnostic.unexpectedTokensCode, [
          left,
          right,
        ])
      const base = node(draft, cursor, spanOf(syntax))
      return done({
        ...base,
        _tag: 'InfixExpression',
        operator,
        operatorAnchor: operatorAnchor(draft, cursor, syntax, base.anchor),
        left,
        right,
      })
    }
    case 'PipelineExpression':
      return done({
        ...node(draft, cursor, spanOf(syntax)),
        _tag: 'PipelineExpression',
        input: operandAt(draft, cursor, syntax, 0, 'input', frame),
        target: operandAt(draft, cursor, syntax, 1, 'target', frame),
      })
    case 'Error':
      return invalidExpression(draft, cursor, spanOf(syntax), Diagnostic.unexpectedTokensCode)
    default:
      return invalidExpression(draft, cursor, spanOf(syntax), Diagnostic.unexpectedTokensCode)
  }
}

/** Damaged argument regions become one invalid argument so the call keeps its healthy arguments. */
const withCausesList = (
  arguments_: ReadonlyArray<AuthoredHir.Expression>,
  causes: ReadonlyArray<AuthoredHir.Cause>,
  draft: Draft,
  cursor: Cursor,
  span: SourceSpan.SourceSpan,
): ReadonlyArray<AuthoredHir.Expression> => {
  if (causes.length === 0) return arguments_
  const [first, ...rest] = causes
  if (first === undefined) return arguments_
  return [
    ...arguments_,
    {
      ...node(draft, child(cursor, 'argument'), span),
      _tag: 'InvalidExpression',
      causes: [first, ...rest],
      retained: [],
    },
  ]
}

const emptyBlock = (
  draft: Draft,
  cursor: Cursor,
  span: SourceSpan.SourceSpan,
): AuthoredHir.Block => ({
  ...node(draft, cursor, span),
  _tag: 'Block',
  statements: [],
})

const callableExpression = (
  draft: Draft,
  cursor: Cursor,
  syntax: SyntaxTree.Node,
  frame: Frame | undefined,
): AuthoredHir.Expression => {
  const owner = ownerChild(draft, cursor.owner, { kind: 'callable', role: 'anonymous' })
  const root = rootCursor(owner)
  const own = child(root, 'callable')
  const inner: Frame = { names: new Map(), parent: frame }
  const body = nodes(syntax).find((n) => n.kind === 'Block')
  return {
    ...node(draft, own, spanOf(syntax)),
    _tag: 'CallableExpression',
    contract: callableContract(draft, own, syntax, inner),
    body:
      body === undefined
        ? emptyBlock(draft, child(own, 'body'), spanOf(syntax))
        : block(draft, child(own, 'body'), body, inner),
  }
}

// ---------------------------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------------------------

const patternKinds: ReadonlySet<SyntaxTree.NodeKind> = new Set<SyntaxTree.NodeKind>([
  'ErrorPattern',
  'EnumMemberPattern',
  'IntegerPattern',
  'NominalPattern',
  'BindingPattern',
  'UniversalPattern',
  'UnionVariantPattern',
])

const missingPattern = (
  draft: Draft,
  cursor: Cursor,
  span: SourceSpan.SourceSpan,
): AuthoredHir.Pattern => ({
  ...node(draft, cursor, span),
  _tag: 'MissingPattern',
  causes: causesAt(draft, cursor, span, Diagnostic.missingTokenCode),
})

const shorthandName = (
  draft: Draft,
  cursor: Cursor,
  field: SyntaxTree.Node,
  nameToken: Token.Token | undefined,
  bindingToken: Token.Token | undefined,
  origin: AuthoredHir.Origin,
): AuthoredHir.Name => {
  if (bindingToken !== undefined) return nameFromToken(draft, cursor, bindingToken)
  if (nameToken === undefined) return missingName(draft, cursor, spanOf(field))
  return { ...nameFromToken(draft, cursor, nameToken), origin }
}

const patternFields = (
  draft: Draft,
  cursor: Cursor,
  syntax: SyntaxTree.Node,
  binders: Frame | undefined,
): ReadonlyArray<AuthoredHir.PatternField | AuthoredHir.RestPattern> =>
  nodes(syntax).flatMap((field): AuthoredHir.PatternField | AuthoredHir.RestPattern | never[] => {
    if (field.kind === 'RestPattern')
      return { ...node(draft, child(cursor, 'rest'), spanOf(field)), _tag: 'RestPattern' }
    if (field.kind !== 'PatternField') return []
    const own = child(cursor, 'field')
    const base = node(draft, own, spanOf(field))
    const identifiers = field.children.filter(
      (element): element is Token.Token => isToken(element) && element.kind === 'Identifier',
    )
    const nameToken = identifiers[0]
    const name =
      nameToken === undefined
        ? missingName(draft, child(own, 'name'), spanOf(field))
        : nameFromToken(draft, child(own, 'name'), nameToken)
    const nested = nodes(field).find((n) => patternKinds.has(n.kind))
    let lowered: AuthoredHir.Pattern
    if (nested !== undefined) {
      lowered = pattern(draft, child(own, 'pattern'), nested, binders)
    } else {
      const bindingToken = identifiers[1]
      const bindingCursor = child(own, 'pattern')
      const origin: AuthoredHir.Origin =
        bindingToken === undefined
          ? { _tag: 'Synthetic', anchor: base.anchor, role: 'shorthand', occurrence: 0 }
          : authored
      const bindingName = shorthandName(
        draft,
        child(bindingCursor, 'name'),
        field,
        nameToken,
        bindingToken,
        origin,
      )
      const binding: AuthoredHir.Pattern = {
        ...node(draft, bindingCursor, bindingToken?.span ?? spanOf(field), {}, origin),
        _tag: 'BindingPattern',
        type: undefined,
        name: bindingName,
      }
      bind(binders, bindingName, binding, draft)
      lowered = binding
    }
    const patternField: AuthoredHir.PatternField = {
      ...base,
      _tag: 'PatternField',
      name,
      pattern: lowered,
    }
    return withCauses(patternField, damage(draft, own, field))
  })

const pattern = (
  draft: Draft,
  cursor: Cursor,
  syntax: SyntaxTree.Node,
  binders: Frame | undefined,
): AuthoredHir.Pattern => {
  const causes = damage(draft, cursor, syntax)
  const done = <T extends AuthoredHir.Pattern>(record: T): T => withCauses(record, causes)
  switch (syntax.kind) {
    case 'EnumMemberPattern':
      return done({
        ...node(draft, cursor, spanOf(syntax)),
        _tag: 'EnumPattern',
        path: pathOf(draft, cursor, syntax, identifierKinds),
      })
    case 'IntegerPattern': {
      const digits = token(syntax, 'DecimalInteger')
      if (digits === undefined) return missingPattern(draft, cursor, spanOf(syntax))
      return done({
        ...node(draft, cursor, spanOf(syntax)),
        _tag: 'IntegerPattern',
        value: integerFromToken(
          draft,
          child(cursor, 'value'),
          spanOf(syntax),
          digits,
          hasToken(syntax, 'Minus'),
        ),
      })
    }
    case 'NominalPattern': {
      const target = typeChildren(syntax)[0]
      return done({
        ...node(draft, cursor, spanOf(syntax)),
        _tag: 'NominalPattern',
        type:
          target === undefined
            ? missingType(draft, child(cursor, 'type'), spanOf(syntax))
            : type(draft, child(cursor, 'type'), target),
        fields: patternFields(draft, cursor, syntax, binders),
      })
    }
    case 'BindingPattern': {
      const target = typeChildren(syntax)[0]
      const name = nameIn(draft, cursor, syntax, identifierKinds)
      const binding: AuthoredHir.Pattern = done({
        ...node(draft, cursor, spanOf(syntax)),
        _tag: 'BindingPattern',
        type: target === undefined ? undefined : type(draft, child(cursor, 'type'), target),
        name,
      })
      bind(binders, name, binding, draft)
      return binding
    }
    case 'UniversalPattern':
      return done({
        ...node(draft, cursor, spanOf(syntax)),
        _tag: 'UniversalPattern',
        name: undefined,
      })
    case 'UnionVariantPattern': {
      const selector = nodes(syntax).find((n) => n.kind === 'AppliedMemberSelector')
      return done({
        ...node(draft, cursor, spanOf(syntax)),
        _tag: 'VariantPattern',
        selector:
          selector === undefined
            ? {
                ...node(draft, child(cursor, 'selector'), spanOf(syntax)),
                _tag: 'MemberSelector',
                subject: missingType(draft, child(cursor, 'subject'), spanOf(syntax)),
                member: missingName(draft, child(cursor, 'member'), spanOf(syntax)),
              }
            : memberSelector(draft, cursor, selector),
        fields: hasToken(syntax, 'LeftBrace')
          ? patternFields(draft, cursor, syntax, binders)
          : undefined,
      })
    }
    case 'ErrorPattern': {
      if (errorRegions(syntax).length === 0) return missingPattern(draft, cursor, spanOf(syntax))
      return {
        ...node(draft, cursor, spanOf(syntax)),
        _tag: 'InvalidPattern',
        causes: causesAt(draft, cursor, spanOf(syntax), Diagnostic.unexpectedTokensCode),
        retained: [],
      }
    }
    default:
      return {
        ...node(draft, cursor, spanOf(syntax)),
        _tag: 'InvalidPattern',
        causes: causesAt(draft, cursor, spanOf(syntax), Diagnostic.unexpectedTokensCode),
        retained: [],
      }
  }
}

const matchArm = (
  draft: Draft,
  cursor: Cursor,
  syntax: SyntaxTree.Node,
  outer: Frame | undefined,
): AuthoredHir.MatchArm => {
  const base = node(draft, cursor, spanOf(syntax))
  const arm = frame(outer)
  const patternSyntax = nodes(syntax).find((n) => patternKinds.has(n.kind))
  const lowered =
    patternSyntax === undefined
      ? missingPattern(draft, child(cursor, 'pattern'), spanOf(syntax))
      : pattern(draft, child(cursor, 'pattern'), patternSyntax, arm)
  const operands = nodes(syntax).filter((n) => isExpressionKind(n.kind) || n.kind === 'Block')
  const hasGuard = hasToken(syntax, 'IfKeyword')
  const guardSyntax = hasGuard ? operands[0] : undefined
  const resultSyntax = hasGuard ? operands[1] : operands[0]
  const armResult = (): AuthoredHir.Expression | AuthoredHir.Block => {
    if (resultSyntax === undefined)
      return missingExpression(
        draft,
        child(cursor, 'result'),
        missing(syntax, 'FatArrow')?.span ?? spanOf(syntax),
      )
    if (resultSyntax.kind === 'Block')
      return block(draft, child(cursor, 'result'), resultSyntax, arm)
    return expression(draft, child(cursor, 'result'), resultSyntax, arm)
  }
  const result = armResult()
  return withCauses(
    {
      ...base,
      _tag: 'MatchArm',
      pattern: lowered,
      guard:
        guardSyntax === undefined || guardSyntax.kind === 'Block'
          ? undefined
          : expression(draft, child(cursor, 'guard'), guardSyntax, arm),
      result,
    },
    damage(draft, cursor, syntax),
  )
}

// ---------------------------------------------------------------------------------------------
// Statements and blocks
// ---------------------------------------------------------------------------------------------

const block = (
  draft: Draft,
  cursor: Cursor,
  syntax: SyntaxTree.Node,
  outer: Frame | undefined,
): AuthoredHir.Block => {
  const base = node(draft, cursor, spanOf(syntax))
  const scope = frame(outer)
  const statements: AuthoredHir.Statement[] = []
  for (const element of nodes(syntax))
    statements.push(statement(draft, child(cursor, 'statement'), element, scope, base.anchor))
  return withCauses({ ...base, _tag: 'Block', statements }, damage(draft, cursor, syntax))
}

const blockAt = (
  draft: Draft,
  cursor: Cursor,
  syntax: SyntaxTree.Node | undefined,
  outer: Frame | undefined,
  span: SourceSpan.SourceSpan,
): AuthoredHir.Block =>
  syntax === undefined ? emptyBlock(draft, cursor, span) : block(draft, cursor, syntax, outer)

const conditional = (
  draft: Draft,
  cursor: Cursor,
  syntax: SyntaxTree.Node,
  scope: Frame | undefined,
): AuthoredHir.Conditional => {
  const base = node(draft, cursor, spanOf(syntax))
  const blocks = nodes(syntax).filter((n) => n.kind === 'Block')
  const chained = nodes(syntax).find(
    (n) =>
      n.kind === 'ConditionalStatement' ||
      n.kind === 'PatternConditionalStatement' ||
      n.kind === 'StaticConditionalStatement',
  )
  const elseOf = (): AuthoredHir.Block | AuthoredHir.Conditional | undefined => {
    if (!hasToken(syntax, 'ElseKeyword')) return undefined
    if (chained !== undefined) return conditional(draft, child(cursor, 'else'), chained, scope)
    return blockAt(draft, child(cursor, 'else'), blocks[1], scope, spanOf(syntax))
  }
  const elseBranch = elseOf()
  const causes = damage(draft, cursor, syntax)
  if (syntax.kind === 'PatternConditionalStatement') {
    const binders = frame(scope)
    const patternSyntax = nodes(syntax).find((n) => patternKinds.has(n.kind))
    const lowered =
      patternSyntax === undefined
        ? missingPattern(draft, child(cursor, 'pattern'), spanOf(syntax))
        : pattern(draft, child(cursor, 'pattern'), patternSyntax, binders)
    return withCauses(
      {
        ...base,
        _tag: 'PatternConditionalStatement',
        pattern: lowered,
        subject: operandAt(draft, cursor, syntax, 0, 'subject', scope),
        thenBranch: blockAt(draft, child(cursor, 'then'), blocks[0], binders, spanOf(syntax)),
        elseBranch,
      },
      causes,
    )
  }
  const condition = operandAt(draft, cursor, syntax, 0, 'condition', scope)
  const thenBranch = blockAt(draft, child(cursor, 'then'), blocks[0], scope, spanOf(syntax))
  return withCauses(
    syntax.kind === 'StaticConditionalStatement'
      ? { ...base, _tag: 'StaticConditionalStatement', condition, thenBranch, elseBranch }
      : { ...base, _tag: 'ConditionalStatement', condition, thenBranch, elseBranch },
    causes,
  )
}

const statement = (
  draft: Draft,
  cursor: Cursor,
  syntax: SyntaxTree.Node,
  scope: Frame,
  enclosing: AuthoredHir.Anchor,
): AuthoredHir.Statement => {
  const causes = damage(draft, cursor, syntax)
  const done = <T extends AuthoredHir.Statement>(record: T): T => withCauses(record, causes)
  switch (syntax.kind) {
    case 'ExpressionStatement':
      return done({
        ...node(draft, cursor, spanOf(syntax)),
        _tag: 'ExpressionStatement',
        expression: operandAt(draft, cursor, syntax, 0, 'expression', scope),
      })
    case 'BindingStatement': {
      const initializer = operandAt(draft, cursor, syntax, 0, 'initializer', scope)
      const typed = typeChildren(syntax)[0]
      const name = nameIn(draft, cursor, syntax, identifierKinds)
      const binding: AuthoredHir.Statement = done({
        ...node(draft, cursor, spanOf(syntax)),
        _tag: 'BindingStatement',
        name,
        mutable: hasToken(syntax, 'MutKeyword'),
        static: hasToken(syntax, 'StaticKeyword'),
        type: typed === undefined ? undefined : type(draft, child(cursor, 'type'), typed),
        initializer,
      })
      bind(scope, name, binding, draft)
      return binding
    }
    case 'PatternBindingStatement': {
      const initializer = operandAt(draft, cursor, syntax, 0, 'initializer', scope)
      const patternSyntax = nodes(syntax).find((n) => patternKinds.has(n.kind))
      const lowered =
        patternSyntax === undefined
          ? missingPattern(draft, child(cursor, 'pattern'), spanOf(syntax))
          : pattern(draft, child(cursor, 'pattern'), patternSyntax, scope)
      return done({
        ...node(draft, cursor, spanOf(syntax)),
        _tag: 'PatternBindingStatement',
        pattern: lowered,
        initializer,
      })
    }
    case 'AssignmentStatement':
      return done({
        ...node(draft, cursor, spanOf(syntax)),
        _tag: 'AssignmentStatement',
        target: operandAt(draft, cursor, syntax, 0, 'target', scope),
        value: operandAt(draft, cursor, syntax, 1, 'value', scope),
      })
    case 'ConditionalStatement':
    case 'PatternConditionalStatement':
    case 'StaticConditionalStatement':
      return conditional(draft, cursor, syntax, scope)
    case 'StaticForStatement': {
      const base = node(draft, cursor, spanOf(syntax))
      const identifiers = syntax.children.filter(
        (element): element is Token.Token => isToken(element) && element.kind === 'Identifier',
      )
      const bindingToken = identifiers.find(
        (candidate) => spellingOf(draft, candidate.span) !== 'in',
      )
      const binding =
        bindingToken === undefined
          ? missingName(
              draft,
              child(cursor, 'binding'),
              missing(syntax, 'Identifier')?.span ?? spanOf(syntax),
            )
          : nameFromToken(draft, child(cursor, 'binding'), bindingToken)
      const iterable = operandAt(draft, cursor, syntax, 0, 'iterable', scope)
      const inner = frame(scope)
      bind(inner, binding, base, draft)
      const body = blockAt(
        draft,
        child(cursor, 'body'),
        nodes(syntax).find((n) => n.kind === 'Block'),
        inner,
        spanOf(syntax),
      )
      return done({ ...base, _tag: 'StaticForStatement', binding, iterable, body })
    }
    case 'WhileStatement':
      return done({
        ...node(draft, cursor, spanOf(syntax)),
        _tag: 'WhileStatement',
        condition: operandAt(draft, cursor, syntax, 0, 'condition', scope),
        body: blockAt(
          draft,
          child(cursor, 'body'),
          nodes(syntax).find((n) => n.kind === 'Block'),
          scope,
          spanOf(syntax),
        ),
      })
    case 'BreakStatement':
      return done({ ...node(draft, cursor, spanOf(syntax)), _tag: 'BreakStatement' })
    case 'ContinueStatement':
      return done({ ...node(draft, cursor, spanOf(syntax)), _tag: 'ContinueStatement' })
    case 'ReturnStatement': {
      const implicit =
        !hasToken(syntax, 'ReturnKeyword') && missing(syntax, 'ReturnKeyword') === undefined
      const origin: AuthoredHir.Origin = implicit
        ? { _tag: 'Synthetic', anchor: enclosing, role: 'implicit-return', occurrence: 0 }
        : authored
      const value = expressionChildren(syntax)[0]
      return done({
        ...node(draft, cursor, spanOf(syntax), {}, origin),
        _tag: 'ReturnStatement',
        value:
          value === undefined
            ? undefined
            : {
                ...expression(draft, child(cursor, 'value'), value, scope),
                ...(implicit ? { origin } : {}),
              },
      })
    }
    case 'FailStatement':
      return done({
        ...node(draft, cursor, spanOf(syntax)),
        _tag: 'FailStatement',
        move: hasToken(syntax, 'MoveKeyword'),
        value: operandAt(draft, cursor, syntax, 0, 'value', scope),
      })
    case 'DropStatement':
      return done({
        ...node(draft, cursor, spanOf(syntax)),
        _tag: 'DropStatement',
        value: operandAt(draft, cursor, syntax, 0, 'value', scope),
      })
    case 'UnsafeStatement':
      return done({
        ...node(draft, cursor, spanOf(syntax)),
        _tag: 'UnsafeStatement',
        body: blockAt(
          draft,
          child(cursor, 'body'),
          nodes(syntax).find((n) => n.kind === 'Block'),
          scope,
          spanOf(syntax),
        ),
      })
    case 'ErrorStatement': {
      if (errorRegions(syntax).length === 0)
        return {
          ...node(draft, cursor, spanOf(syntax)),
          _tag: 'MissingStatement',
          causes: causesAt(draft, cursor, spanOf(syntax), Diagnostic.missingTokenCode),
        }
      return {
        ...node(draft, cursor, spanOf(syntax)),
        _tag: 'InvalidStatement',
        causes: causesAt(draft, cursor, spanOf(syntax), Diagnostic.unexpectedTokensCode),
        retained: [],
      }
    }
    default:
      return {
        ...node(draft, cursor, spanOf(syntax)),
        _tag: 'InvalidStatement',
        causes: causesAt(draft, cursor, spanOf(syntax), Diagnostic.unexpectedTokensCode),
        retained: [],
      }
  }
}

// ---------------------------------------------------------------------------------------------
// Declarations
// ---------------------------------------------------------------------------------------------

const identifierSpellings = (draft: Draft, syntax: SyntaxTree.Node | undefined): string =>
  syntax === undefined
    ? ''
    : SyntaxTree.tokens(syntax)
        .filter((candidate) => candidate.kind === 'Identifier')
        .map((candidate) => spellingOf(draft, candidate.span))
        .join('.')

const declarationName = (draft: Draft, syntax: SyntaxTree.Node): string | undefined => {
  if (syntax.kind === 'FunctionDeclaration' || syntax.kind === 'ForeignFunctionDeclaration') {
    let afterFn = false
    for (const element of syntax.children) {
      if (isToken(element) && element.kind === 'FnKeyword') {
        afterFn = true
        continue
      }
      if (!afterFn) continue
      if (isToken(element) && (element.kind === 'Identifier' || element.kind === 'DropKeyword'))
        return spellingOf(draft, spanOf(element))
      if (isMissing(element) && element.expected === 'Identifier') return undefined
    }
    return undefined
  }
  for (const element of syntax.children) {
    if (isToken(element) && (element.kind === 'Identifier' || element.kind === 'DropKeyword'))
      return spellingOf(draft, spanOf(element))
    if (isMissing(element) && element.expected === 'Identifier') return undefined
  }
  return undefined
}

/** The authored owner key of one declaration syntax node: kind, name, and a local role. */
const ownerKey = (draft: Draft, syntax: SyntaxTree.Node): AuthoredIdentity.Key => {
  const named = (kind: string): AuthoredIdentity.Key => {
    const name = declarationName(draft, syntax)
    return name === undefined ? { kind } : { kind, name }
  }
  switch (syntax.kind) {
    case 'ImportDeclaration': {
      const path = nodes(syntax).find((n) => n.kind === 'ImportPath')
      const alias = nodes(syntax).find((n) => n.kind === 'ImportAlias')
      const aliasName = alias === undefined ? undefined : declarationName(draft, alias)
      return {
        kind: 'import',
        name: identifierSpellings(draft, path),
        ...(aliasName === undefined ? {} : { role: aliasName }),
      }
    }
    case 'StaticConditionalDeclaration':
      return { kind: 'conditional' }
    case 'DeclarationGroup':
      return { kind: 'group' }
    case 'ModulePropertyDeclaration':
      return { kind: 'module-property' }
    case 'ConstantDeclaration':
      return named('constant')
    case 'PackageParameterDeclaration':
      return named('package-parameter')
    case 'ForeignStaticDeclaration':
    case 'ExportStaticDeclaration':
      return named('static')
    case 'TypeAliasDeclaration':
      return named('alias')
    case 'RoleDeclaration':
      return named('role')
    case 'EnumDeclaration':
      return named('enum')
    case 'StructDeclaration':
      return named('struct')
    case 'TupleDeclaration':
      return named('tuple')
    case 'UnionDeclaration':
      return named('union')
    case 'ServiceDeclaration':
      return named('service')
    case 'InterfaceDeclaration':
      return named('interface')
    case 'ServiceOperation':
      return named('operation')
    case 'ServiceInvalidMember':
      return { kind: 'invalid-member' }
    case 'ImplDeclaration': {
      const [subject, target] = typeChildren(syntax)
      const spelling = identifierSpellings(draft, subject)
      const targetSpelling = identifierSpellings(draft, target)
      return {
        kind: 'impl',
        name: targetSpelling === '' ? spelling : `${spelling} for ${targetSpelling}`,
      }
    }
    case 'ImplOperation':
      return named('alias')
    case 'FunctionDeclaration':
    case 'ForeignFunctionDeclaration':
      return named('function')
    default:
      return { kind: 'error' }
  }
}

const invalidHeader = (
  draft: Draft,
  cursor: Cursor,
  syntax: SyntaxTree.Node,
  fallback: string,
): AuthoredHir.DeclarationHeader => ({
  ...node(draft, cursor, spanOf(syntax)),
  _tag: 'InvalidDeclarationHeader',
  causes: causesAt(draft, cursor, spanOf(syntax), fallback),
  retained: [],
})

const linkageDirection = (syntax: SyntaxTree.Node): 'Import' | 'Export' | undefined => {
  if (hasToken(syntax, 'ExternKeyword')) return 'Import'
  if (hasToken(syntax, 'ExportKeyword')) return 'Export'
  return undefined
}

const linkage = (
  draft: Draft,
  cursor: Cursor,
  syntax: SyntaxTree.Node,
  direction: 'Import' | 'Export',
): AuthoredHir.Linkage => {
  const own = child(cursor, 'linkage')
  return {
    ...node(draft, own, spanOf(syntax)),
    _tag: 'Linkage',
    direction,
    abi: textLiteralToken(draft, own, syntax, 'abi', 0),
    symbol: hasToken(syntax, 'AsKeyword')
      ? textLiteralToken(draft, own, syntax, 'symbol', 1)
      : undefined,
  }
}

const fields = (
  draft: Draft,
  cursor: Cursor,
  parent: SyntaxTree.Node,
  kind: 'StructField' | 'UnionVariantField',
): ReadonlyArray<AuthoredHir.Field> =>
  nodes(parent)
    .filter((n) => n.kind === kind)
    .map((field) => {
      const own = child(cursor, 'field')
      const typed = typeChildren(field)[0]
      return withCauses(
        {
          ...node(draft, own, spanOf(field), { documentation: documentationOf(draft, field) }),
          _tag: 'Field',
          name: nameIn(draft, own, field, identifierKinds),
          public: hasToken(field, 'PubKeyword'),
          type:
            typed === undefined
              ? missingType(draft, child(own, 'type'), spanOf(field))
              : type(draft, child(own, 'type'), typed),
        },
        damage(draft, own, field),
      )
    })

interface DeclarationParts {
  readonly header: AuthoredHir.DeclarationHeader
  readonly body: AuthoredHir.DeclarationBody
}

const callableParts = (
  draft: Draft,
  root: Cursor,
  syntax: SyntaxTree.Node,
  operation: boolean,
): DeclarationParts => {
  const header = child(root, 'header')
  const scope = frame(undefined)
  const base = node(draft, header, spanOf(syntax), {
    documentation: documentationOf(draft, syntax),
  })
  const name = callableNameIn(draft, header, syntax)
  const contract = callableContract(draft, header, syntax, scope)
  const properties = propertyClauses(draft, header, syntax)
  const bodySyntax = nodes(syntax).find((n) => n.kind === 'Block')
  const body: AuthoredHir.DeclarationBody = {
    _tag: 'CallableBody',
    block:
      bodySyntax === undefined ? undefined : block(draft, child(root, 'body'), bodySyntax, scope),
  }
  const common = { ...base, name, public: hasToken(syntax, 'PubKeyword') }
  const causes = damage(draft, header, syntax)
  if (operation) {
    const marker = nodes(syntax).find((n) => n.kind === 'OperatorMarker')
    const operatorToken = marker?.children.find(
      (element): element is Token.Token =>
        isToken(element) && Operator.isDeclarationToken(element.kind),
    )
    const operatorOf = (): AuthoredHir.Name | undefined => {
      if (marker === undefined) return undefined
      if (operatorToken === undefined)
        return missingName(draft, child(header, 'operator'), spanOf(marker))
      return nameFromToken(draft, child(header, 'operator'), operatorToken)
    }
    const operator = operatorOf()
    return {
      header: withCauses(
        { ...common, _tag: 'OperationHeader', contract, operator, properties },
        causes,
      ),
      body,
    }
  }
  const direction = linkageDirection(syntax)
  return {
    header: withCauses(
      {
        ...common,
        _tag: 'FunctionHeader',
        contract,
        linkage: direction === undefined ? undefined : linkage(draft, header, syntax, direction),
        properties,
      },
      causes,
    ),
    body,
  }
}

const members = (
  draft: Draft,
  owner: AuthoredIdentity.Identity,
  parent: SyntaxTree.Node,
  accept: (kind: SyntaxTree.NodeKind) => boolean,
): AuthoredHir.DeclarationBody => ({
  _tag: 'MembersBody',
  members: nodes(parent)
    .filter((n) => accept(n.kind))
    .map((member) => declaration(draft, owner, member)),
})

const implTarget = (
  draft: Draft,
  header: Cursor,
  syntax: SyntaxTree.Node,
  target: SyntaxTree.Node | undefined,
): AuthoredHir.Type | undefined => {
  if (!hasToken(syntax, 'ForKeyword')) return undefined
  if (target === undefined) return missingType(draft, child(header, 'target'), spanOf(syntax))
  return type(draft, child(header, 'target'), target)
}

const declarationParts = (
  draft: Draft,
  owner: AuthoredIdentity.Identity,
  root: Cursor,
  syntax: SyntaxTree.Node,
): DeclarationParts => {
  const header = child(root, 'header')
  const documentation = documentationOf(draft, syntax)
  const base = () => node(draft, header, spanOf(syntax), { documentation })
  const named = () => ({
    ...base(),
    name: nameIn(draft, header, syntax, identifierKinds),
    public: hasToken(syntax, 'PubKeyword'),
  })
  const causes = () => damage(draft, header, syntax)
  const generics = () =>
    genericParameters(
      draft,
      header,
      nodes(syntax).find((n) => n.kind === 'TypeParameterList'),
    )
  const genericsAnchor = (): AuthoredHir.Anchor | undefined => {
    const list = nodes(syntax).find((n) => n.kind === 'TypeParameterList')
    return list === undefined
      ? undefined
      : node(draft, child(header, 'genericList'), spanOf(list)).anchor
  }
  const firstType = (role: string): AuthoredHir.Type => {
    const typed = typeChildren(syntax)[0]
    return typed === undefined
      ? missingType(draft, child(header, role), spanOf(syntax))
      : type(draft, child(header, role), typed)
  }
  const initializer = (): AuthoredHir.Expression | undefined => {
    const value = expressionChildren(syntax).find((n) => n.kind !== 'Error')
    return value === undefined
      ? undefined
      : expression(draft, child(root, 'body'), value, undefined)
  }
  switch (syntax.kind) {
    case 'ImportDeclaration': {
      const path = nodes(syntax).find((n) => n.kind === 'ImportPath')
      const alias = nodes(syntax).find((n) => n.kind === 'ImportAlias')
      const memberList = nodes(syntax).find((n) => n.kind === 'ImportMemberList')
      return {
        header: withCauses(
          {
            ...base(),
            _tag: 'ImportHeader',
            public: hasToken(syntax, 'PubKeyword'),
            path:
              path === undefined
                ? {
                    ...node(draft, child(header, 'path'), spanOf(syntax)),
                    _tag: 'Path',
                    segments: [missingName(draft, child(header, 'segment'), spanOf(syntax))],
                  }
                : pathOf(draft, header, path, importSegmentKinds),
            alias:
              alias === undefined
                ? undefined
                : nameIn(draft, header, alias, identifierKinds, 'alias'),
            members:
              memberList === undefined
                ? undefined
                : nodes(memberList)
                    .filter((n) => n.kind === 'ImportMember')
                    .map((member) => {
                      const own = child(header, 'member')
                      const memberAlias = nodes(member).find((n) => n.kind === 'ImportAlias')
                      return withCauses(
                        {
                          ...node(draft, own, spanOf(member)),
                          _tag: 'ImportMember',
                          name: nameIn(draft, own, member, identifierKinds),
                          alias:
                            memberAlias === undefined
                              ? undefined
                              : nameIn(draft, own, memberAlias, identifierKinds, 'alias'),
                        },
                        damage(draft, own, member),
                      )
                    }),
          },
          [...causes(), ...(memberList === undefined ? [] : damage(draft, header, memberList))],
        ),
        body: { _tag: 'NoBody' },
      }
    }
    case 'StaticConditionalDeclaration': {
      const [condition, thenArm, elseArm] = nodes(syntax)
      const conditionNode: AuthoredHir.Expression =
        condition === undefined || !isExpressionKind(condition.kind)
          ? missingExpression(draft, child(header, 'condition'), spanOf(syntax))
          : expression(draft, child(header, 'condition'), condition, undefined)
      const branch = (arm: SyntaxTree.Node, role: 'then' | 'else'): AuthoredHir.Declaration => {
        if (arm.kind === 'StaticConditionalDeclaration') return declaration(draft, owner, arm, role)
        const groupOwner = ownerChild(draft, owner, { kind: 'group', role })
        const groupRoot = rootCursor(groupOwner)
        const groupHeader = child(groupRoot, 'header')
        return {
          _tag: 'Declaration',
          owner: groupOwner,
          header: withCauses(
            {
              ...node(draft, groupHeader, spanOf(arm)),
              _tag: 'GroupHeader',
              branch: role === 'then' ? 'Then' : 'Else',
            },
            damage(draft, groupHeader, arm),
          ),
          body: members(draft, groupOwner, arm, (kind) => kind !== 'Error' || true),
        }
      }
      const thenBranch =
        thenArm === undefined || thenArm.kind !== 'DeclarationGroup'
          ? {
              _tag: 'Declaration' as const,
              owner: ownerChild(draft, owner, { kind: 'group', role: 'then' }),
              header: invalidHeader(
                draft,
                child(
                  rootCursor(ownerChild(draft, owner, { kind: 'group', role: 'then' })),
                  'header',
                ),
                syntax,
                Diagnostic.missingTokenCode,
              ),
              body: { _tag: 'NoBody' as const },
            }
          : branch(thenArm, 'then')
      return {
        header: withCauses(
          { ...base(), _tag: 'ConditionalHeader', condition: conditionNode },
          causes(),
        ),
        body: {
          _tag: 'ConditionalBody',
          thenBranch,
          elseBranch: elseArm === undefined ? undefined : branch(elseArm, 'else'),
        },
      }
    }
    case 'ModulePropertyDeclaration':
      return {
        header: withCauses(
          {
            ...base(),
            _tag: 'ModulePropertyHeader',
            properties: propertyClauses(draft, header, syntax),
          },
          causes(),
        ),
        body: { _tag: 'NoBody' },
      }
    case 'ConstantDeclaration':
      return {
        header: withCauses(
          {
            ...named(),
            _tag: 'ConstantHeader',
            type: typeChildren(syntax)[0] === undefined ? undefined : firstType('type'),
          },
          causes(),
        ),
        body: { _tag: 'InitializerBody', value: initializer() },
      }
    case 'PackageParameterDeclaration': {
      const validation = nodes(syntax).find((n) => n.kind === 'PackageParameterValidation')
      const predicate = validation === undefined ? undefined : expressionChildren(validation)[0]
      return {
        header: withCauses(
          { ...named(), _tag: 'PackageParameterHeader', type: firstType('type') },
          causes(),
        ),
        body: {
          _tag: 'PackageParameterBody',
          default: initializer(),
          validation:
            predicate === undefined
              ? undefined
              : expression(draft, child(root, 'validation'), predicate, undefined),
        },
      }
    }
    case 'ForeignStaticDeclaration':
      return {
        header: withCauses(
          {
            ...named(),
            _tag: 'StaticHeader',
            type: firstType('type'),
            mutable: false,
            linkage: linkage(draft, header, syntax, 'Import'),
            properties: propertyClauses(draft, header, syntax),
          },
          causes(),
        ),
        body: { _tag: 'NoBody' },
      }
    case 'ExportStaticDeclaration':
      return {
        header: withCauses(
          {
            ...named(),
            _tag: 'StaticHeader',
            type: firstType('type'),
            mutable: false,
            linkage: linkage(draft, header, syntax, 'Export'),
            properties: propertyClauses(draft, header, syntax),
          },
          causes(),
        ),
        body: { _tag: 'InitializerBody', value: initializer() },
      }
    case 'TypeAliasDeclaration':
      return {
        header: withCauses(
          { ...named(), _tag: 'AliasHeader', generics: generics(), target: firstType('target') },
          causes(),
        ),
        body: { _tag: 'NoBody' },
      }
    case 'RoleDeclaration':
      return {
        header: withCauses({ ...named(), _tag: 'RoleHeader' }, causes()),
        body: { _tag: 'NoBody' },
      }
    case 'EnumDeclaration':
      return {
        header: withCauses(
          {
            ...named(),
            _tag: 'EnumHeader',
            representation:
              typeChildren(syntax)[0] === undefined ? undefined : firstType('representation'),
            members: nodes(syntax)
              .filter((n) => n.kind === 'EnumMember')
              .map((member) => {
                const own = child(header, 'member')
                const value = nodes(member).find((n) => n.kind === 'IntegerLiteralExpression')
                return withCauses(
                  {
                    ...node(draft, own, spanOf(member), {
                      documentation: documentationOf(draft, member),
                    }),
                    _tag: 'EnumMember',
                    name: nameIn(draft, own, member, identifierKinds),
                    value:
                      value === undefined
                        ? undefined
                        : expression(draft, child(own, 'value'), value, undefined),
                  },
                  damage(draft, own, member),
                )
              }),
          },
          causes(),
        ),
        body: { _tag: 'NoBody' },
      }
    case 'StructDeclaration':
      return {
        header: withCauses(
          {
            ...named(),
            _tag: 'StructHeader',
            generics: generics(),
            genericsAnchor: genericsAnchor(),
            fields: fields(draft, header, syntax, 'StructField'),
            abi: hasToken(syntax, 'ExternKeyword')
              ? textLiteralToken(draft, header, syntax, 'abi')
              : undefined,
          },
          causes(),
        ),
        body: { _tag: 'NoBody' },
      }
    case 'TupleDeclaration':
      return {
        header: withCauses(
          {
            ...named(),
            _tag: 'TupleHeader',
            generics: generics(),
            elements: typeChildren(syntax)
              .filter((n) => n.kind !== 'Error')
              .map((element) => type(draft, child(header, 'element'), element)),
          },
          causes(),
        ),
        body: { _tag: 'NoBody' },
      }
    case 'UnionDeclaration':
      return {
        header: withCauses(
          {
            ...named(),
            _tag: 'UnionHeader',
            generics: generics(),
            variants: nodes(syntax)
              .filter((n) => n.kind === 'UnionVariant')
              .map((variant) => {
                const own = child(header, 'variant')
                return withCauses(
                  {
                    ...node(draft, own, spanOf(variant), {
                      documentation: documentationOf(draft, variant),
                    }),
                    _tag: 'Variant',
                    name: nameIn(draft, own, variant, identifierKinds),
                    fields: fields(draft, own, variant, 'UnionVariantField'),
                    braces: hasToken(variant, 'LeftBrace'),
                  },
                  damage(draft, own, variant),
                )
              }),
          },
          causes(),
        ),
        body: { _tag: 'NoBody' },
      }
    case 'ServiceDeclaration':
    case 'InterfaceDeclaration':
      return {
        header: withCauses(
          {
            ...named(),
            _tag: syntax.kind === 'ServiceDeclaration' ? 'ServiceHeader' : 'InterfaceHeader',
            generics: generics(),
          },
          causes(),
        ),
        body: members(
          draft,
          owner,
          syntax,
          (kind) => kind === 'ServiceOperation' || kind === 'ServiceInvalidMember',
        ),
      }
    case 'ServiceOperation':
      return callableParts(draft, root, syntax, true)
    case 'ServiceInvalidMember':
      return {
        header: invalidHeader(draft, header, syntax, Diagnostic.unexpectedTokensCode),
        body: { _tag: 'NoBody' },
      }
    case 'ImplDeclaration': {
      const [subject, target] = typeChildren(syntax).filter((n) => n.kind !== 'Error')
      return {
        header: withCauses(
          {
            ...base(),
            _tag: 'ImplHeader',
            generics: generics(),
            subject:
              subject === undefined
                ? missingType(draft, child(header, 'subject'), spanOf(syntax))
                : type(draft, child(header, 'subject'), subject),
            target: implTarget(draft, header, syntax, target),
          },
          causes(),
        ),
        body: members(
          draft,
          owner,
          syntax,
          (kind) =>
            kind === 'ImplOperation' ||
            kind === 'FunctionDeclaration' ||
            kind === 'ForeignFunctionDeclaration',
        ),
      }
    }
    case 'ImplOperation': {
      const path = nodes(syntax).find((n) => n.kind === 'TypePath')
      return {
        header: withCauses(
          {
            ...named(),
            _tag: 'ImplAliasHeader',
            target:
              path === undefined
                ? {
                    ...node(draft, child(header, 'path'), spanOf(syntax)),
                    _tag: 'Path',
                    segments: [missingName(draft, child(header, 'segment'), spanOf(syntax))],
                  }
                : pathOf(draft, header, path, identifierKinds),
          },
          causes(),
        ),
        body: { _tag: 'NoBody' },
      }
    }
    case 'FunctionDeclaration':
    case 'ForeignFunctionDeclaration':
      return callableParts(draft, root, syntax, false)
    default:
      return {
        header: invalidHeader(draft, header, syntax, Diagnostic.unexpectedTokensCode),
        body: { _tag: 'NoBody' },
      }
  }
}

const declaration = (
  draft: Draft,
  parent: AuthoredIdentity.Identity,
  syntax: SyntaxTree.Node,
  role?: string,
): AuthoredHir.Declaration => {
  const key = ownerKey(draft, syntax)
  const owner = ownerChild(draft, parent, role === undefined ? key : { ...key, role })
  const root = rootCursor(owner)
  const parts = declarationParts(draft, owner, root, syntax)
  draft.declarationAnchors.push({ span: spanOf(syntax), anchor: parts.header.anchor })
  return { _tag: 'Declaration', owner, header: parts.header, body: parts.body }
}

// ---------------------------------------------------------------------------------------------
// Module publication
// ---------------------------------------------------------------------------------------------

/** A cheap deterministic revision token for presentation; content identity lives in A1 digests. */
const revisionOf = (source: SourceFile.SourceFile): string => {
  // ponytail: FNV-1a over source bytes; presentation only needs a stable per-revision label.
  let hash = 0xcbf29ce484222325n
  for (const byte of source.bytes) {
    hash ^= BigInt(byte)
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn
  }
  return hash.toString(16).padStart(16, '0')
}

const moduleAnchor = (owner: AuthoredIdentity.Identity): AuthoredHir.Anchor => ({
  _tag: 'AuthoredAnchor',
  owner,
  path: [],
})

const presentationDiagnostics = (
  draft: Draft,
  owner: AuthoredIdentity.Identity,
): ReadonlyArray<AuthoredPresentation.Diagnostic> =>
  draft.frontendDiagnostics.map((diagnostic) => {
    const enclosing = draft.declarationAnchors.find(
      (candidate) =>
        candidate.span.start <= diagnostic.span.start && diagnostic.span.end <= candidate.span.end,
    )
    return {
      anchor: enclosing?.anchor ?? moduleAnchor(owner),
      span: { start: diagnostic.span.start, end: diagnostic.span.end },
      code: diagnostic.code,
      message: diagnostic.message,
    }
  })

/**
 * Lowers one complete syntax artifact for the given logical module owner. Requires no resolver,
 * imported semantics, target profile, or evaluator, and retains no syntax in its outputs.
 */
export const lower = Effect.fn('AuthoredLowering.lower')(function* (
  syntax: SyntaxFile.SyntaxFile,
  owner: AuthoredIdentity.Identity,
): Effect.fn.Return<Lowered, LoweringError> {
  const frontendDiagnostics = [...syntax.lexicalDiagnostics, ...syntax.parserDiagnostics]
  const codesBySpan = new Map<string, string[]>()
  for (const diagnostic of frontendDiagnostics) {
    const key = spanKey(diagnostic.span)
    codesBySpan.set(key, [...(codesBySpan.get(key) ?? []), diagnostic.code])
  }
  const draft: Draft = {
    syntax,
    source: syntax.source,
    texts: [],
    textIndex: new Map(),
    bytes: [],
    byteIndex: new Map(),
    entries: [],
    codesBySpan,
    frontendDiagnostics,
    declarationAnchors: [],
    literalDiagnostics: [],
  }
  const moduleDocumentation = DocBlock.ofModule(syntax)
  if (moduleDocumentation !== undefined) {
    draft.entries.push({
      anchor: moduleAnchor(owner),
      span: { start: moduleDocumentation.span.start, end: moduleDocumentation.span.end },
      documentation: spellingOf(draft, moduleDocumentation.span),
    })
  }
  const declarations = nodes(syntax.root).map((element) => declaration(draft, owner, element))
  const pool = yield* AuthoredPool.make(draft.texts, draft.bytes)
  const module = yield* AuthoredModule.seal({ _tag: 'AuthoredModule', owner, pool, declarations })
  const presentation = yield* AuthoredPresentation.make(
    syntax.source.id,
    revisionOf(syntax.source),
    draft.entries,
    [...presentationDiagnostics(draft, owner), ...draft.literalDiagnostics],
  )
  return { _tag: 'AuthoredLowering', module, presentation }
})

// ---------------------------------------------------------------------------------------------
// Semantic consumers: locating authored owners and deriving syntax-free reuse keys
// ---------------------------------------------------------------------------------------------

const namespaceOf = (origin: SourceFile.SourceFile['origin']): string => {
  if (origin._tag === 'ProjectFile') return 'project'
  if (origin._tag === 'ToolchainFile') return 'toolchain'
  return 'memory'
}

/** The logical module owner of one loaded source: origin kind as namespace, canonical module name. */
export const moduleOwner = (
  module: string,
  origin: SourceFile.SourceFile['origin'],
): AuthoredIdentity.Identity => {
  return AuthoredIdentity.module(namespaceOf(origin), module)
}

const allDeclarations = (module: AuthoredHir.Module): ReadonlyArray<AuthoredHir.Declaration> => {
  const found: AuthoredHir.Declaration[] = []
  const visit = (declaration: AuthoredHir.Declaration): void => {
    found.push(declaration)
    if (declaration.body._tag === 'MembersBody') declaration.body.members.forEach(visit)
    if (declaration.body._tag === 'ConditionalBody') {
      visit(declaration.body.thenBranch)
      if (declaration.body.elseBranch !== undefined) visit(declaration.body.elseBranch)
    }
  }
  module.declarations.forEach(visit)
  return found
}

const byOwner = new WeakMap<Lowered, ReadonlyMap<string, AuthoredHir.Declaration>>()

/** The authored declaration one owner identity names, at any nesting depth of the module. */
export const declarationOf = (
  self: Lowered,
  owner: AuthoredIdentity.Identity,
): AuthoredHir.Declaration | undefined => {
  let index = byOwner.get(self)
  if (index === undefined) {
    index = new Map(
      allDeclarations(self.module).map((declaration) => [
        identityKey(declaration.owner),
        declaration,
      ]),
    )
    byOwner.set(self, index)
  }
  return index.get(identityKey(owner))
}

const textOf = (module: AuthoredHir.Module, reference: AuthoredPool.TextRef): string =>
  module.pool.texts[reference.index]?.value ?? ''

/** Lifetime binders introduced by one body node, which scope every lifetime spelled beneath it. */
const lifetimeBinders = (
  record: Readonly<Record<string, unknown>>,
): ReadonlyArray<AuthoredHir.GenericParameter> | undefined => {
  if (Array.isArray(record.binders)) return record.binders as AuthoredHir.GenericParameter[]
  const contract = record.contract
  if (record._tag === 'CallableExpression' && typeof contract === 'object' && contract !== null)
    return (contract as AuthoredHir.CallableContract).generics
  return undefined
}

/**
 * A canonical rendering of one authored body for reuse keys: pool references resolve to their
 * text, lifetime binders are alpha-normalized to their binding depth and ordinal, and only
 * semantic fields participate. Equal keys mean equal authored meaning up to lifetime spelling.
 */
export const canonicalBody = (self: Lowered, declaration: AuthoredHir.Declaration): string => {
  const module = self.module
  const frameOf = (
    generics: ReadonlyArray<AuthoredHir.GenericParameter>,
    depth: number,
  ): ReadonlyMap<string, string> => {
    const frame = new Map<string, string>()
    for (const [ordinal, generic] of generics.entries()) {
      if (generic._tag === 'LifetimeParameter' && generic.name._tag === 'Name')
        frame.set(textOf(module, generic.name.text), `${depth}:${ordinal}`)
    }
    return frame
  }
  const header = declaration.header
  const frames: Array<ReadonlyMap<string, string>> = [
    'contract' in header ? frameOf(header.contract.generics, 0) : new Map(),
  ]
  const resolve = (text: string): string | undefined => {
    for (let depth = frames.length - 1; depth >= 0; depth -= 1) {
      const key = frames[depth]?.get(text)
      if (key !== undefined) return key
    }
    return undefined
  }
  const parts: string[] = []
  const visit = (value: unknown, lifetime: boolean): void => {
    if (typeof value === 'bigint') return void parts.push(`${value}n`)
    if (typeof value !== 'object' || value === null) return void parts.push(String(value))
    if (Array.isArray(value)) {
      parts.push('[')
      for (const item of value) visit(item, lifetime)
      parts.push(']')
      return
    }
    if (!('_tag' in value) || typeof value._tag !== 'string') return
    const tag = value._tag
    if (tag === 'TextRef' && 'index' in value && typeof value.index === 'number') {
      const text = module.pool.texts[value.index]?.value ?? ''
      const key = lifetime ? resolve(text) : undefined
      return void parts.push(key === undefined ? `"${text}"` : `'${key}`)
    }
    if (tag === 'BytesRef' && 'index' in value && typeof value.index === 'number')
      return void parts.push(`b[${module.pool.bytes[value.index]?.value.join(',') ?? ''}]`)
    if (tag === 'LexicalReference' || tag === 'AuthoredAnchor' || tag === 'Authored') return
    if (tag === 'Cause')
      return void parts.push(`cause:${'code' in value ? String(value.code) : ''}`)
    const record = value as Readonly<Record<string, unknown>>
    const binders = lifetimeBinders(record)
    if (binders !== undefined) frames.push(frameOf(binders, frames.length))
    parts.push(`${tag}(`)
    const order = AuthoredHir.fields[tag as keyof typeof AuthoredHir.fields] ?? []
    for (const key of order) {
      if (key === 'anchor' || key === 'origin') continue
      const field = record[key]
      if (field === undefined) parts.push('_')
      else visit(field, lifetime || tag === 'Lifetime' || tag === 'LifetimeParameter')
    }
    parts.push(')')
    if (binders !== undefined) frames.pop()
  }
  visit(declaration.body, false)
  return parts.join(' ')
}

/** Every authored name spelled inside one declaration body, for scope-sensitive reuse keys. */
export const bodyNames = (
  self: Lowered,
  declaration: AuthoredHir.Declaration,
): ReadonlySet<string> => {
  const names = new Set<string>()
  const pending: unknown[] = [declaration.body]
  while (pending.length > 0) {
    const value = pending.pop()
    if (value === null || typeof value !== 'object') continue
    if ('_tag' in value && value._tag === 'Name' && 'text' in value) {
      const reference = value.text
      if (
        typeof reference === 'object' &&
        reference !== null &&
        'index' in reference &&
        typeof reference.index === 'number'
      )
        names.add(self.module.pool.texts[reference.index]?.value ?? '')
      continue
    }
    for (const child of Object.values(value)) pending.push(child)
  }
  return names
}
