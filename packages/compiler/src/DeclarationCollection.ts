import * as Location from './Location.js'
import * as MachineFunction from './MachineFunction.js'
import * as DeclarationProperty from './DeclarationProperty.js'
import * as NativeRequirement from './NativeRequirement.js'
import * as ForeignContract from './ForeignContract.js'
import * as AggregateIdentity from './AggregateIdentity.js'
import type {
  ArrayLengthFact,
  BoundFact,
  CanonicalEnumMemberId,
  CanonicalId,
  CanonicalState,
  CanonicalUnionVariantId,
  ConformanceFact,
  ConformanceRequirementFact,
  ConstantFact,
  ConstantLiteralFact,
  ConstraintFact,
  DeclarationFact,
  InherentImplFact,
  DeclarationId,
  DeclaredName,
  DeclaredTypeFact,
  EnumDiscriminantFact,
  EnumFact,
  EnumMemberFact,
  EnumMemberId,
  EnumRepresentationFact,
  FailureRowFact,
  FieldFact,
  FieldId,
  FieldOwnerId,
  FieldState,
  ForeignStaticFact,
  FunctionBodyTemplate,
  InterfaceFact,
  MemberFact,
  ModuleHeaders,
  OpaqueResultFact,
  ParameterFact,
  RequirementRoleFact,
  RequirementRowFact,
  ReturnTypeFact,
  RowExpressionDecision,
  ServiceFact,
  ServiceOperationFact,
  ServiceOperationId,
  ServiceOperationState,
  StaticExpressionTemplate,
  StructFact,
  TypeParameterFact,
  TypePathFact,
  TypeResolution,
  UnionFact,
  UnionVariantFact,
  UnionVariantId,
} from './DeclarationFacts.js'
import {
  enumValueOperation,
  interfaceOperationContracts,
  presentParameterEntries,
  requirementRoleIdentity,
} from './DeclarationFacts.js'
import type * as AuthoredHir from './AuthoredHir.js'
import * as AuthoredIdentity from './AuthoredIdentity.js'
import * as AuthoredWalk from './AuthoredWalk.js'
import * as AuthoredLowering from './AuthoredLowering.js'
import * as DeclarationLifetime from './DeclarationLifetime.js'
import * as Lifetime from './Lifetime.js'
import * as DeclarationIndex from './DeclarationIndex.js'
import * as Diagnostic from './Diagnostic.js'
import * as ForeignSymbol from './ForeignSymbol.js'
import type * as ModuleClosure from './ModuleClosure.js'
import * as Operator from './Operator.js'
import * as RequirementRow from './RequirementRow.js'
import * as RowAlgebra from './RowAlgebra.js'
import * as Scalar from './Scalar.js'
import * as SemanticContext from './SemanticContext.js'
import * as StaticText from './StaticText.js'
import * as Type from './Type.js'

type Context = SemanticContext.SemanticContext

const noDiagnostics: ReadonlyArray<Diagnostic.Located> = []

/** The spelling of an authored name, or `undefined` when recovery left none. */
const nameText = (context: Context, name: AuthoredHir.Name): string | undefined =>
  SemanticContext.nameText(context, name)

/** A declared-name fact for one authored name: present only when a spelling survived recovery. */
export const declaredName = (context: Context, name: AuthoredHir.Name): DeclaredName => {
  const spelling = nameText(context, name)
  return spelling === undefined
    ? { _tag: 'Unavailable', anchor: name.anchor }
    : { _tag: 'Present', spelling, anchor: name.anchor }
}

/** A header's declared name; headers that declare none are unavailable at their own anchor. */
const headerName = (context: Context, header: AuthoredHir.DeclarationHeader): DeclaredName =>
  'name' in header
    ? declaredName(context, header.name)
    : { _tag: 'Unavailable', anchor: header.anchor }

const unavailable = (anchor: AuthoredHir.Anchor): DeclaredTypeFact => ({
  _tag: 'Unavailable',
  anchor,
})

const unavailableResolution = (anchor: AuthoredHir.Anchor): TypeResolution => ({
  fact: unavailable(anchor),
  diagnostics: noDiagnostics,
})

/** The type path an authored path denotes, or `undefined` when no segment kept a spelling. */
const typePathOf = (context: Context, path: AuthoredHir.Path): TypePathFact | undefined => {
  const segments = path.segments.flatMap((segment) => {
    const spelling = nameText(context, segment)
    return spelling === undefined ? [] : [{ spelling, anchor: segment.anchor }]
  })
  return segments.length === 0
    ? undefined
    : {
        _tag: 'TypePath',
        spelling: segments.map((segment) => segment.spelling).join('.'),
        segments: segments,
        anchor: path.anchor,
      }
}

/** The role an authored requirement selects; a requirement without a role keeps the default. */
export const collectedRequirementRole = (
  context: Context,
  requirement: AuthoredHir.Requirement,
): RequirementRoleFact => {
  const path = requirement.role === undefined ? undefined : typePathOf(context, requirement.role)
  return path === undefined ? { _tag: 'DefaultRole' } : { _tag: 'UnresolvedRole', path }
}

/** The single type path a named type names directly, used to recognize a binder occurrence. */
const parameterAtType = (
  context: Context,
  type: AuthoredHir.Type,
  typeParameters: ReadonlyMap<string, Type.Parameter>,
): Type.Parameter | undefined => {
  if (type._tag !== 'NamedType' || type.path.segments.length !== 1) return undefined
  const segment = type.path.segments[0]
  if (segment === undefined) return undefined
  const spelling = nameText(context, segment)
  return spelling === undefined ? undefined : typeParameters.get(spelling)
}

/**
 * The first spelled segment of a named type, for diagnostics that quote the written name.
 *
 * An applied type names the same nominal as its target, so `App<i32>` and `string<'text>` answer
 * `App` and `string`; a conformance head spelled with arguments names a provider just as a bare
 * one does.
 */
const firstSegment = (
  context: Context,
  type: AuthoredHir.Type,
): { readonly spelling: string; readonly anchor: AuthoredHir.Anchor } | undefined => {
  if (type._tag === 'AppliedType') return firstSegment(context, type.target)
  if (type._tag !== 'NamedType') return undefined
  for (const segment of type.path.segments) {
    const spelling = nameText(context, segment)
    if (spelling !== undefined) return { spelling, anchor: segment.anchor }
  }
  return undefined
}

/** Whether one authored body mentions a construct only static evaluation can reduce. */
const requiresStaticEvaluation = (block: AuthoredHir.Block): boolean => {
  let found = false
  const visitExpression = (expression: AuthoredHir.Expression): void => {
    if (found) return
    if (expression._tag === 'CompileErrorExpression') found = true
    for (const child of expressionChildren(expression)) visitExpression(child)
  }
  const visitStatement = (statement: AuthoredHir.Statement): void => {
    if (found) return
    if (statement._tag === 'StaticConditionalStatement' || statement._tag === 'StaticForStatement')
      found = true
    if (statement._tag === 'BindingStatement' && statement.static) found = true
    for (const expression of statementExpressions(statement)) visitExpression(expression)
    for (const nested of nestedBlocks(statement)) visitBlock(nested)
  }
  const visitBlock = (current: AuthoredHir.Block | AuthoredHir.Conditional): void => {
    if (current._tag !== 'Block') return visitStatement(current)
    for (const statement of current.statements) visitStatement(statement)
  }
  visitBlock(block)
  return found
}

const nestedBlocks = (
  statement: AuthoredHir.Statement,
): ReadonlyArray<AuthoredHir.Block | AuthoredHir.Conditional> => {
  switch (statement._tag) {
    case 'ConditionalStatement':
    case 'PatternConditionalStatement':
    case 'StaticConditionalStatement':
      return statement.elseBranch === undefined
        ? [statement.thenBranch]
        : [statement.thenBranch, statement.elseBranch]
    case 'StaticForStatement':
    case 'WhileStatement':
    case 'UnsafeStatement':
      return [statement.body]
    default:
      return []
  }
}

const statementExpressions = (
  statement: AuthoredHir.Statement,
): ReadonlyArray<AuthoredHir.Expression> => {
  switch (statement._tag) {
    case 'ExpressionStatement':
      return [statement.expression]
    case 'BindingStatement':
    case 'PatternBindingStatement':
      return [statement.initializer]
    case 'AssignmentStatement':
      return [statement.target, statement.value]
    case 'StaticForStatement':
      return [statement.iterable]
    case 'WhileStatement':
    case 'ConditionalStatement':
    case 'StaticConditionalStatement':
      return [statement.condition]
    case 'PatternConditionalStatement':
      return [statement.subject]
    case 'ReturnStatement':
      return statement.value === undefined ? [] : [statement.value]
    case 'FailStatement':
    case 'DropStatement':
      return [statement.value]
    default:
      return []
  }
}

const expressionChildren = (
  expression: AuthoredHir.Expression,
): ReadonlyArray<AuthoredHir.Expression> => {
  switch (expression._tag) {
    case 'MoveExpression':
    case 'BorrowExpression':
    case 'RunExpression':
    case 'UnsafeExpression':
    case 'PrefixExpression':
      return [expression.operand]
    case 'CompileErrorExpression':
      return [expression.message]
    case 'MatchExpression':
      return [expression.subject]
    case 'StructExpression':
    case 'RecordExpression':
      return expression.fields.map((field) => field.value)
    case 'TupleExpression':
    case 'ArrayExpression':
      return expression.elements
    case 'MemberExpression':
      return expression.fields === undefined ? [] : expression.fields.map((field) => field.value)
    case 'FieldExpression':
    case 'ReferentExpression':
    case 'OrdinalExpression':
      return [expression.subject]
    case 'IndexExpression':
      return [expression.subject, expression.index]
    case 'CallExpression':
      return [expression.callee, ...expression.arguments]
    case 'InfixExpression':
      return [expression.left, expression.right]
    case 'PipelineExpression':
      return [expression.input, expression.target]
    case 'InvalidExpression':
      return expression.retained
    default:
      return []
  }
}

/**
 * One retained body plus its deterministic encoding.
 *
 * Authored HIR is already trivia-free and source-independent, so the canonical body encoding
 * replaces the token template the syntax collector had to rebuild from source bytes.
 */
const bodyTemplate = (
  lowered: AuthoredLowering.Lowered,
  declaration: AuthoredHir.Declaration,
  // A statically phased callable is evaluated whole, so its body is retained whatever it contains;
  // a runtime callable only needs a template when some construct inside it demands evaluation.
  staticPhase = false,
): FunctionBodyTemplate | undefined => {
  if (declaration.body._tag !== 'CallableBody') return undefined
  const block = declaration.body.block
  if (block === undefined || !(staticPhase || requiresStaticEvaluation(block))) return undefined
  return {
    _tag: 'FunctionBodyTemplate',
    anchor: block.anchor,
    canonical: AuthoredLowering.canonicalBody(lowered, declaration),
  }
}

/** A static initializer's deterministic encoding, taken from the declaration that owns it. */
const staticExpressionTemplate = (
  lowered: AuthoredLowering.Lowered,
  declaration: AuthoredHir.Declaration,
  expression: AuthoredHir.Expression,
): StaticExpressionTemplate => ({
  _tag: 'StaticExpressionTemplate',
  anchor: expression.anchor,
  canonical: `${AuthoredIdentity.anchorKey(expression.anchor)}=${AuthoredLowering.canonicalBody(
    lowered,
    declaration,
  )}`,
})

/** The constant value an authored initializer denotes without any evaluation. */
export const constantLiteral = (
  context: Context,
  initializer: AuthoredHir.Expression,
): ConstantLiteralFact => {
  const anchor = initializer.anchor
  if (initializer._tag === 'BooleanLiteral')
    return { _tag: 'BooleanLiteral', value: initializer.value, anchor }
  if (initializer._tag === 'CharacterLiteral')
    return { _tag: 'CharacterLiteral', value: initializer.scalar, anchor }
  if (initializer._tag === 'IntegerLiteral')
    return {
      _tag: 'IntegerLiteral',
      value: initializer.value,
      spelling: integerSpelling(initializer),
      anchor,
    }
  if (initializer._tag === 'DurationLiteral') {
    const value = initializer.components.reduce(
      (total, component) => total + component.magnitude * durationScale[component.unit],
      0n,
    )
    return {
      _tag: 'DurationLiteral',
      value,
      spelling: initializer.components
        .map((component) => `${component.magnitude}${component.unit}`)
        .join(''),
      anchor,
    }
  }
  if (initializer._tag === 'FloatingLiteral')
    return {
      _tag: 'FloatingLiteral',
      spelling: floatingSpelling(initializer),
      anchor,
    }
  if (initializer._tag === 'InvalidExpression') {
    // A literal that lexes but does not decode keeps the decoder's reason in its presentation.
    const key = AuthoredIdentity.anchorKey(anchor)
    const undecodable = context.presentation.diagnostics.find(
      (entry) =>
        entry.code === Diagnostic.invalidStaticLiteralCode &&
        AuthoredIdentity.anchorKey(entry.anchor) === key,
    )
    if (undecodable !== undefined) return { _tag: 'Malformed', detail: undecodable.message, anchor }
  }
  if (initializer._tag === 'TextLiteral')
    return {
      _tag: 'StringLiteral',
      data: staticData('Text', Array.from(utf8.encode(context.textOf(initializer.value)))),
      anchor,
    }
  if (initializer._tag === 'BytesLiteral')
    return {
      _tag: 'StringLiteral',
      data: staticData('Bytes', Array.from(context.bytesOf(initializer.value))),
      anchor,
    }
  // A prefix negation over an integer or float is part of the literal a constant header admits.
  if (initializer._tag === 'PrefixExpression' && initializer.operator === 'Negate') {
    const operand = constantLiteral(context, initializer.operand)
    if (operand._tag === 'IntegerLiteral')
      return {
        _tag: 'IntegerLiteral',
        value: -operand.value,
        spelling: `-${operand.spelling}`,
        anchor,
      }
    if (operand._tag === 'FloatingLiteral')
      return {
        _tag: 'FloatingLiteral',
        spelling: `-${operand.spelling}`,
        anchor,
      }
  }
  return { _tag: 'Unavailable', anchor }
}

const utf8 = new TextEncoder()

/**
 * The compiler-owned payload of one authored literal.
 *
 * Authored HIR already carries the decoded bytes, so the header no longer re-lexes the literal;
 * the identity stays the byte digest every later phase compares.
 */
const staticData = (
  kind: StaticText.Data['kind'],
  bytes: ReadonlyArray<number>,
): StaticText.Data => ({
  _tag: 'StaticData',
  id: `${kind === 'Text' ? 'text' : 'bytes'}:${bytes
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')}`,
  kind,
  bytes: [...bytes],
  utf8: kind === 'Text',
})

const durationScale: Readonly<Record<AuthoredHir.DurationComponent['unit'], bigint>> = {
  w: 604800000000000n,
  d: 86400000000000n,
  h: 3600000000000n,
  m: 60000000000n,
  s: 1000000000n,
  ms: 1000000n,
  us: 1000n,
  ns: 1n,
}

const radixPrefix: Readonly<Record<AuthoredHir.IntegerLiteral['radix'], string>> = {
  2: '0b',
  8: '0o',
  10: '',
  16: '0x',
}

/** The decimal spelling a consumer compares and re-renders; the radix prefix is preserved. */
const integerSpelling = (literal: AuthoredHir.IntegerLiteral): string =>
  `${radixPrefix[literal.radix]}${literal.value.toString(literal.radix)}`

const floatingSpelling = (
  literal: Extract<AuthoredHir.Literal, { readonly _tag: 'FloatingLiteral' }>,
): string => {
  const magnitude = `${literal.coefficient}e${literal.exponent}`
  return literal.sign === 'Negative' ? `-${magnitude}` : magnitude
}

interface AppliedRequirement {
  readonly capability: TypeResolution
  readonly role: RequirementRoleFact
  readonly access: 'Shared' | 'Exclusive'
  readonly anchor: AuthoredHir.Anchor
}

interface AppliedRows {
  readonly failureAnchor: AuthoredHir.Anchor | undefined
  readonly failures: ReadonlyArray<TypeResolution>
  readonly requirementAnchor: AuthoredHir.Anchor | undefined
  readonly requirements: ReadonlyArray<AppliedRequirement>
  readonly requirementParameters: ReadonlyArray<Type.Parameter>
  readonly rowParameterComponents: ReadonlyArray<DeclaredTypeFact>
  /** The row as one expression, present only when the row subtracts (`Without<R, K>`). */
  readonly requirementExpression: RowExpressionDecision | undefined
  readonly diagnostics: ReadonlyArray<Diagnostic.Located>
}

/** The members a failure operand contributes: a union spreads, anything else stands alone. */
const failureMembers = (failures: AuthoredHir.Type): ReadonlyArray<AuthoredHir.Type> =>
  failures._tag === 'UnionType'
    ? failures.members.flatMap((member) => (member._tag === 'Requirement' ? [] : [member]))
    : [failures]

/** Analyzes the failure and requirement arguments shared by Effect and nominal applications. */
const analyzeAppliedRows = (
  context: Context,
  argumentList: AuthoredHir.TypeArguments,
  typeParameters: ReadonlyMap<string, Type.Parameter>,
  lifetimeContext?: DeclarationLifetime.Context,
): AppliedRows => {
  const diagnostics: Array<Diagnostic.Located> = []
  const failureNodes =
    argumentList.failures === undefined ? [] : failureMembers(argumentList.failures)
  const failures = failureNodes.flatMap((member): ReadonlyArray<TypeResolution> => {
    const parameter = parameterAtType(context, member, typeParameters)
    if (parameter?.kind !== 'RequirementRow')
      return [analyzeDeclaredType(context, member, typeParameters, false, lifetimeContext)]
    const segment = firstSegment(context, member)
    if (segment !== undefined)
      diagnostics.push(
        Diagnostic.genericParameterKindMismatch(
          segment.spelling,
          'Value',
          parameter.kind,
          Location.at(segment.anchor),
        ),
      )
    return []
  })
  const row = argumentList.requirements
  const requirements = (row?.members ?? []).flatMap((member): ReadonlyArray<AppliedRequirement> =>
    member._tag !== 'Requirement'
      ? []
      : [
          {
            capability: analyzeDeclaredType(
              context,
              member.capability,
              typeParameters,
              false,
              lifetimeContext,
            ),
            role: collectedRequirementRole(context, member),
            access: member.access === 'Mutable' ? ('Exclusive' as const) : ('Shared' as const),
            anchor: member.anchor,
          },
        ],
  )
  // A bare path inside a requirement row names a row parameter, never a capability.
  const parameterPaths = (row?.members ?? []).flatMap((member): ReadonlyArray<AuthoredHir.Type> =>
    member._tag === 'Requirement' ? [] : [member],
  )
  const requirementParameters = parameterPaths.flatMap((path): ReadonlyArray<Type.Parameter> => {
    const parameter = parameterAtType(context, path, typeParameters)
    if (parameter?.kind === 'RequirementRow') return [parameter]
    const segment = firstSegment(context, path)
    if (segment !== undefined)
      diagnostics.push(
        parameter === undefined
          ? Diagnostic.unknownType(segment.spelling, Location.at(segment.anchor))
          : Diagnostic.genericParameterKindMismatch(
              segment.spelling,
              'RequirementRow',
              parameter.kind,
              Location.at(segment.anchor),
            ),
      )
    return []
  })
  const rowParameterComponents = parameterPaths.flatMap((path): ReadonlyArray<DeclaredTypeFact> => {
    const segment = firstSegment(context, path)
    const parameter = parameterAtType(context, path, typeParameters)
    return segment === undefined || parameter?.kind !== 'RequirementRow'
      ? []
      : [
          {
            _tag: 'Resolved' as const,
            type: parameter,
            spelling: segment.spelling,
            anchor: path.anchor,
          },
        ]
  })
  const subtracts = (row?.members ?? []).some(
    (member) => member._tag !== 'Requirement' && member._tag === 'RowWithout',
  )
  const requirementExpression =
    row !== undefined && subtracts
      ? rowExpressionOf(context, row, typeParameters, lifetimeContext)
      : undefined
  return {
    failureAnchor: argumentList.failures?.anchor,
    failures: failures,
    requirementAnchor: row?.anchor,
    requirements: requirements,
    requirementParameters: requirementParameters,
    rowParameterComponents: rowParameterComponents,
    requirementExpression,
    diagnostics: diagnostics,
  }
}

const unreportedLifetimeDiagnostic = (
  diagnostic: Diagnostic.Located,
  context: DeclarationLifetime.Context | undefined,
): ReadonlyArray<Diagnostic.Located> =>
  context?.diagnostics.some(
    (reported) =>
      reported.code === diagnostic.code && Location.equals(reported.span, diagnostic.span),
  )
    ? noDiagnostics
    : [diagnostic]

/**
 * Resolves one authored type annotation into a declared-type fact.
 *
 * Every construct is a named field of the authored vocabulary, so the analysis is a closed
 * dispatch over `AuthoredHir.Type` rather than a scan over untyped syntax children.
 */
export const analyzeDeclaredType = (
  context: Context,
  type: AuthoredHir.Type | AuthoredHir.Lifetime,
  typeParameters: ReadonlyMap<string, Type.Parameter> = new Map(),
  genericArgumentPosition = false,
  lifetimeContext?: DeclarationLifetime.Context,
): TypeResolution => {
  const anchor = type.anchor
  if (type._tag === 'Lifetime') {
    const ticked = tickedLifetimeName(context, type.name)
    const lifetime =
      (lifetimeContext === undefined
        ? undefined
        : DeclarationLifetime.regionOf(lifetimeContext, anchor)) ??
      (ticked === undefined ? undefined : DeclarationLifetime.named(ticked, typeParameters))
    if (ticked !== undefined && lifetime !== undefined && genericArgumentPosition)
      return {
        fact: { _tag: 'Lifetime', lifetime, spelling: ticked, anchor },
        diagnostics: noDiagnostics,
      }
    const diagnostic =
      ticked === undefined
        ? Diagnostic.invalidLifetimeBinder('Expected a lifetime argument', Location.at(anchor))
        : Diagnostic.unknownLifetime(ticked, Location.at(type.name.anchor))
    return {
      fact: { _tag: 'Unavailable', anchor, cause: Diagnostic.identity(diagnostic) },
      diagnostics: unreportedLifetimeDiagnostic(diagnostic, lifetimeContext),
    }
  }
  /** The region elaboration assigned to one annotation, or the one its own lifetime names. */
  const regionOf = (
    node: AuthoredHir.Type,
    written: AuthoredHir.Lifetime | undefined,
  ): Lifetime.Lifetime | undefined => {
    const assigned =
      lifetimeContext === undefined
        ? undefined
        : DeclarationLifetime.regionOf(lifetimeContext, node.anchor)
    if (assigned !== undefined) return assigned
    if (written === undefined) return undefined
    const spelling = nameText(context, written.name)
    if (spelling === undefined) return undefined
    return DeclarationLifetime.named(
      spelling.startsWith("'") ? spelling : `'${spelling}`,
      typeParameters,
    )
  }
  const missingLifetime = (written: AuthoredHir.Lifetime | undefined): TypeResolution => {
    const spelling = written === undefined ? undefined : nameText(context, written.name)
    const diagnostic =
      spelling === undefined
        ? Diagnostic.ambiguousLifetimeElision(Location.at(anchor))
        : Diagnostic.unknownLifetime(
            spelling.startsWith("'") ? spelling : `'${spelling}`,
            Location.at(written?.anchor ?? anchor),
          )
    return {
      fact: { _tag: 'Unavailable', anchor, cause: Diagnostic.identity(diagnostic) },
      diagnostics: unreportedLifetimeDiagnostic(diagnostic, lifetimeContext),
    }
  }
  if (type._tag === 'UnitType')
    return {
      fact: { _tag: 'Resolved', type: Type.unit, spelling: '()', anchor },
      diagnostics: noDiagnostics,
    }
  if (type._tag === 'MissingType' || type._tag === 'InvalidType')
    return unavailableResolution(anchor)
  // Recovery keeps an absent type as a named type over a missing name: the parser owns that damage.
  if (type._tag === 'NamedType' && type.path.segments.some((segment) => segment._tag !== 'Name'))
    return unavailableResolution(anchor)
  if (type._tag === 'CallableType') {
    const lifetimes =
      lifetimeContext === undefined
        ? undefined
        : DeclarationLifetime.callableOf(lifetimeContext, anchor)
    if (lifetimes === undefined) return missingLifetime(undefined)
    const mode: Type.CallableMode = callableMode(type.mode)
    const parameters = type.parameters.map((parameter) =>
      analyzeDeclaredType(context, parameter, typeParameters, false, lifetimeContext),
    )
    const result = analyzeDeclaredType(context, type.result, typeParameters, false, lifetimeContext)
    const diagnostics = [...parameters, result].flatMap((entry) => Array.from(entry.diagnostics))
    if (
      result.fact._tag === 'Resolved' &&
      parameters.every((entry) => entry.fact._tag === 'Resolved')
    ) {
      const contract = Type.callable(
        parameters.flatMap((entry) => (entry.fact._tag === 'Resolved' ? [entry.fact.type] : [])),
        result.fact.type,
        lifetimes,
        mode,
        undefined,
        type.unsafe,
      )
      return {
        fact: {
          _tag: 'Resolved',
          type: contract,
          spelling: Type.encode(contract),
          anchor,
          components: [...parameters.map((entry) => entry.fact), result.fact],
        },
        diagnostics,
      }
    }
    const cause = [...parameters.map((entry) => entry.fact), result.fact]
      .flatMap((fact) => ('cause' in fact && fact.cause !== undefined ? [fact.cause] : []))
      .at(-1)
    return {
      fact: {
        _tag: 'Callable',
        lifetimes,
        unsafe: type.unsafe,
        mode,
        parameters: parameters.map((entry) => entry.fact),
        result: result.fact,
        spelling: `${type.unsafe ? 'unsafe ' : ''}${mode === 'Exclusive' ? 'mut ' : ''}${
          mode === 'Take' ? 'once ' : ''
        }fn(...)`,
        anchor,
        ...(cause === undefined ? {} : { cause }),
      },
      diagnostics,
    }
  }
  if (type._tag === 'ForeignFunctionType') {
    const lifetimes = (lifetimeContext === undefined
      ? undefined
      : DeclarationLifetime.callableOf(lifetimeContext, anchor)) ?? {
      environment: Lifetime.staticLifetime,
      lifetimeBinders: [],
    }
    const parameters = type.parameters.map((parameter) =>
      analyzeDeclaredType(context, parameter, typeParameters, false, lifetimeContext),
    )
    const result = analyzeDeclaredType(context, type.result, typeParameters, false, lifetimeContext)
    const behavior = ForeignContract.analyze(
      context,
      type.properties[0],
      parameters.map((entry, ordinal) => ({
        name: String(ordinal),
        type: entry.fact._tag === 'Resolved' ? entry.fact.type : undefined,
        at: Location.at(entry.fact.anchor),
      })),
      result.fact._tag === 'Resolved' ? result.fact.type : undefined,
    )
    const diagnostics: Array<Diagnostic.Located> = [...parameters, result].flatMap((entry) =>
      Array.from(entry.diagnostics),
    )
    diagnostics.push(...behavior.diagnostics)
    for (const clause of type.properties.slice(1))
      diagnostics.push(
        Diagnostic.foreignDeclarationRestriction(
          'duplicate foreign contract',
          Location.at(clause.anchor),
        ),
      )
    const abi = type.abi._tag === 'TextLiteral' ? context.textOf(type.abi.value) : undefined
    if (type.abi._tag === 'TextLiteral' && abi !== 'C')
      diagnostics.push(Diagnostic.unsupportedForeignAbi(abi ?? '', Location.at(type.abi.anchor)))
    if (
      diagnostics.length === 0 &&
      result.fact._tag === 'Resolved' &&
      parameters.every((entry) => entry.fact._tag === 'Resolved')
    ) {
      const contract = Type.foreignFunction(
        parameters.flatMap((entry) => (entry.fact._tag === 'Resolved' ? [entry.fact.type] : [])),
        result.fact.type,
        behavior.contract,
        lifetimes,
      )
      return {
        fact: {
          _tag: 'Resolved',
          type: contract,
          spelling: Type.encode(contract),
          anchor,
          components: [...parameters.map((entry) => entry.fact), result.fact],
        },
        diagnostics: diagnostics,
      }
    }
    const cause = diagnostics.at(-1)
    return {
      fact: {
        _tag: 'ForeignFunction',
        lifetimes,
        contract: behavior.contract,
        parameters: parameters.map((entry) => entry.fact),
        result: result.fact,
        spelling: 'extern "C" fn(...)',
        anchor,
        ...(cause === undefined ? {} : { cause: Diagnostic.identity(cause) }),
      },
      diagnostics: diagnostics,
    }
  }
  if (type._tag === 'UnionType') {
    const members = type.members.flatMap((member) =>
      member._tag === 'Requirement'
        ? []
        : [
            analyzeDeclaredType(
              context,
              member,
              typeParameters,
              genericArgumentPosition,
              lifetimeContext,
            ),
          ],
    )
    const diagnostics: Array<Diagnostic.Located> = members.flatMap((member) =>
      Array.from(member.diagnostics),
    )
    const facts = members.map((member) => member.fact)
    if (facts.every((fact) => fact._tag === 'Resolved')) {
      const resolved = facts.filter(
        (fact): fact is Extract<DeclaredTypeFact, { readonly _tag: 'Resolved' }> =>
          fact._tag === 'Resolved',
      )
      const normalized = Type.union(resolved.map((fact) => fact.type))
      if (normalized._tag === 'Normalized')
        return {
          fact: {
            _tag: 'Resolved',
            type: normalized.type,
            spelling: Type.encode(normalized.type),
            anchor,
            unionSource: { _tag: 'UnionSource', members: facts, anchor },
          },
          diagnostics: diagnostics,
        }
      if (normalized._tag === 'InvalidMembers')
        for (const invalid of normalized.members) {
          const sourceFact = resolved.find((fact) => Type.equals(fact.type, invalid))
          diagnostics.push(
            Diagnostic.invalidUnionMember(
              Type.encode(invalid),
              Location.at(sourceFact?.anchor ?? anchor),
            ),
          )
        }
    }
    const cause = diagnostics.at(-1)
    return {
      fact: {
        _tag: 'Union',
        members: facts,
        spelling: facts
          .map((fact) => (fact._tag === 'Resolved' ? Type.encode(fact.type) : 'unavailable'))
          .join(' | '),
        anchor,
        ...(cause === undefined ? {} : { cause: Diagnostic.identity(cause) }),
      },
      diagnostics: diagnostics,
    }
  }
  if (type._tag === 'SliceType') {
    const lifetime = regionOf(type, type.lifetime)
    if (lifetime === undefined) return missingLifetime(type.lifetime)
    const access: Type.Slice['access'] = type.access === 'Mutable' ? 'Exclusive' : 'Shared'
    const element = analyzeDeclaredType(
      context,
      type.element,
      typeParameters,
      false,
      lifetimeContext,
    )
    if (element.fact._tag === 'Resolved') {
      const sliced = Type.slice(access, element.fact.type, lifetime)
      return {
        fact: {
          _tag: 'Resolved',
          type: sliced,
          spelling: Type.encode(sliced),
          anchor,
          components: [element.fact],
        },
        diagnostics: element.diagnostics,
      }
    }
    return {
      fact: {
        _tag: 'Slice',
        lifetime,
        access,
        element: element.fact,
        spelling: `${access === 'Exclusive' ? '&mut' : '&'}[unavailable]`,
        anchor,
        ...('cause' in element.fact && element.fact.cause !== undefined
          ? { cause: element.fact.cause }
          : {}),
      },
      diagnostics: element.diagnostics,
    }
  }
  if (type._tag === 'ReferenceType') {
    const lifetime = regionOf(type, type.lifetime)
    if (lifetime === undefined) return missingLifetime(type.lifetime)
    const access: 'Shared' | 'Exclusive' = type.access === 'Mutable' ? 'Exclusive' : 'Shared'
    const target = analyzeDeclaredType(
      context,
      type.referent,
      typeParameters,
      false,
      lifetimeContext,
    )
    return {
      fact: {
        _tag: 'Reference',
        lifetime,
        access,
        target: target.fact,
        spelling: `${access === 'Exclusive' ? '&mut ' : '&'}unavailable`,
        anchor,
        ...('cause' in target.fact && target.fact.cause !== undefined
          ? { cause: target.fact.cause }
          : {}),
      },
      diagnostics: target.diagnostics,
    }
  }
  if (type._tag === 'PointerType') {
    const extent: Type.Pointer['extent'] = type.multiplicity === 'Many' ? 'Many' : 'Single'
    let alignment: Type.Pointer['alignment'] = 'Natural'
    const seen = new Set<string>()
    const qualifierDiagnostics: Array<Diagnostic.Located> = []
    for (const qualifier of type.qualifiers) {
      const name = nameText(context, qualifier.name)
      if (name === undefined || qualifier.value._tag !== 'IntegerLiteral') continue
      const value = Number(qualifier.value.value)
      let detail: string | undefined
      if (seen.has(name)) detail = 'qualifier is repeated'
      else if (name === 'align') {
        if (Type.isPointerAlignment(value)) alignment = value
        else detail = 'alignment must be a positive power of two no greater than 536870912'
      } else if (name === 'addrspace' && value !== 0)
        detail = 'only ordinary data address space zero is admitted'
      seen.add(name)
      if (detail !== undefined)
        qualifierDiagnostics.push(
          Diagnostic.invalidPointerQualifier(name, detail, Location.at(qualifier.value.anchor)),
        )
    }
    const qualifiers = {
      mutable: type.access === 'Mutable',
      nullable: type.nullable,
      extent,
      alignment,
      addressSpace: 0 as const,
    }
    const invalid = qualifierDiagnostics[0]
    if (invalid !== undefined)
      return {
        fact: { _tag: 'Unavailable', anchor, cause: Diagnostic.identity(invalid) },
        diagnostics: qualifierDiagnostics,
      }
    const pointee = analyzeDeclaredType(
      context,
      type.pointee,
      typeParameters,
      false,
      lifetimeContext,
    )
    if (pointee.fact._tag === 'Resolved') {
      const pointer = Type.pointer({ ...qualifiers, pointee: pointee.fact.type })
      return {
        fact: {
          _tag: 'Resolved',
          type: pointer,
          spelling: Type.encode(pointer),
          anchor,
          components: [pointee.fact],
        },
        diagnostics: pointee.diagnostics,
      }
    }
    return {
      fact: {
        _tag: 'Pointer',
        ...qualifiers,
        pointee: pointee.fact,
        spelling: `${qualifiers.mutable ? '*mut ' : '*const '}unavailable`,
        anchor,
        ...('cause' in pointee.fact && pointee.fact.cause !== undefined
          ? { cause: pointee.fact.cause }
          : {}),
      },
      diagnostics: pointee.diagnostics,
    }
  }
  if (type._tag === 'FixedArrayType') {
    const element = analyzeDeclaredType(
      context,
      type.element,
      typeParameters,
      false,
      lifetimeContext,
    )
    const diagnostics: Array<Diagnostic.Located> = [...element.diagnostics]
    let length: ArrayLengthFact
    if (type.length._tag !== 'IntegerLiteral') {
      length = { _tag: 'Unavailable', anchor: type.length.anchor }
    } else {
      const spelling = integerSpelling(type.length)
      const value = Number(type.length.value)
      if (!Number.isSafeInteger(value) || value > 2147483647) {
        const diagnostic = Diagnostic.integerOutOfRange(
          spelling,
          'i32',
          { minimum: -2147483648n, maximum: 2147483647n },
          Location.at(type.length.anchor),
        )
        diagnostics.push(diagnostic)
        length = {
          _tag: 'OutOfRange',
          spelling,
          anchor: type.length.anchor,
          cause: Diagnostic.identity(diagnostic),
        }
      } else {
        length = {
          _tag: 'Available',
          value,
          spelling,
          anchor: type.length.anchor,
        }
      }
    }
    if (element.fact._tag === 'Resolved' && length._tag === 'Available') {
      const array = Type.fixedArray(element.fact.type, length.value)
      return {
        fact: {
          _tag: 'Resolved',
          type: array,
          spelling: Type.encode(array),
          anchor,
          components: [element.fact],
        },
        diagnostics: diagnostics,
      }
    }
    return {
      fact: {
        _tag: 'FixedArray',
        element: element.fact,
        length,
        spelling: `Array<${
          element.fact._tag === 'Resolved' ? Type.encode(element.fact.type) : 'unavailable'
        }, ${length._tag === 'Available' ? length.value : 'unavailable'}>`,
        anchor,
      },
      diagnostics: diagnostics,
    }
  }
  if (type._tag === 'OpaqueResultType')
    // The binder belongs to the declaration that carries it, so its representation parameters and
    // family key can only be minted where that canonical identity is known. Until the declaration
    // site supplies it, the result stays deterministically unavailable.
    return unavailableResolution(anchor)
  if (type._tag === 'ExactRepresentationType') {
    const subject = type.subject
    const path = nominalPath(context, subject)
    if (path === undefined) return unavailableResolution(anchor)
    const arguments_ = (subject._tag === 'AppliedType' ? subject.arguments.arguments : []).flatMap(
      (argument) =>
        argument._tag === 'RequirementSelector'
          ? []
          : [analyzeDeclaredType(context, argument, typeParameters, true, lifetimeContext)],
    )
    return {
      fact: {
        _tag: 'ExactRepresentation',
        item: path,
        arguments: arguments_.map((argument) => argument.fact),
        spelling: `typeof(${path.spelling})`,
        anchor,
      },
      diagnostics: arguments_.flatMap((argument) => argument.diagnostics),
    }
  }
  if (type._tag === 'RowWithout') return unavailableResolution(anchor)
  if (type._tag === 'AppliedType') {
    const target = analyzeDeclaredType(context, type.target, typeParameters, false, lifetimeContext)
    const arguments_ = type.arguments.arguments.flatMap((argument) =>
      argument._tag === 'RequirementSelector'
        ? []
        : [analyzeDeclaredType(context, argument, typeParameters, true, lifetimeContext)],
    )
    const targetPath =
      type.target._tag === 'NamedType' ? typePathOf(context, type.target.path) : undefined
    const bare =
      targetPath !== undefined && targetPath.segments.length === 1 ? targetPath.spelling : undefined
    if (bare === 'string') {
      const argument = arguments_.at(0)?.fact
      if (arguments_.length !== 1 || argument?._tag !== 'Lifetime') {
        const diagnostic = Diagnostic.invalidLifetimeBinder(
          'string requires exactly one lifetime argument',
          Location.at(anchor),
        )
        return {
          fact: {
            _tag: 'Unavailable',
            anchor,
            cause: Diagnostic.identity(diagnostic),
          },
          diagnostics: [...arguments_.flatMap((entry) => entry.diagnostics), diagnostic],
        }
      }
      return {
        fact: {
          _tag: 'Resolved',
          type: Type.string(argument.lifetime),
          spelling: `string<${Lifetime.display(argument.lifetime)}>`,
          anchor,
          components: [argument],
        },
        diagnostics: noDiagnostics,
      }
    }
    if (bare === 'Effect') {
      const environment = regionOf(type, undefined)
      if (environment === undefined) return missingLifetime(undefined)
      const lifetimes: Type.ExecutableLifetimes = {
        environment,
        lifetimeBinders: [],
      }
      const access: Type.Effect['access'] = callableMode(
        type.target._tag === 'NamedType' ? type.target.mode : undefined,
      )
      const rows = analyzeAppliedRows(context, type.arguments, typeParameters, lifetimeContext)
      const diagnostics = [
        ...rows.diagnostics,
        ...arguments_.flatMap((argument) => argument.diagnostics),
        ...rows.failures.flatMap((failure) => failure.diagnostics),
        ...rows.requirements.flatMap((requirement) => requirement.capability.diagnostics),
      ]
      const success = arguments_.at(0)?.fact
      if (arguments_.length !== 1)
        diagnostics.push(
          Diagnostic.typeArgumentArity(
            'Effect',
            1,
            arguments_.length,
            Location.at(type.target.anchor),
          ),
        )
      const resolvedFailures = rows.failures.flatMap((failure) =>
        failure.fact._tag === 'Resolved' && Type.isTypeArgument(failure.fact.type)
          ? [failure.fact.type]
          : [],
      )
      const resolvedRequirements = rows.requirements.flatMap((requirement) =>
        requirement.capability.fact._tag === 'Resolved' &&
        requirementRoleIdentity(requirement.role) !== undefined &&
        (Type.isNominal(requirement.capability.fact.type) ||
          (Type.isParameter(requirement.capability.fact.type) &&
            requirement.capability.fact.type.kind === 'Value'))
          ? [
              {
                capability: requirement.capability.fact.type,
                role: requirementRoleIdentity(requirement.role) ?? RequirementRow.defaultRole,
                access: requirement.access,
              },
            ]
          : [],
      )
      const failuresAvailable = rows.failures.every(
        (failure) => failure.fact._tag === 'Resolved' && Type.isTypeArgument(failure.fact.type),
      )
      // A subtracting row is resolved with the module graph, where the row algebra runs.
      if (
        arguments_.length === 1 &&
        success?._tag === 'Resolved' &&
        failuresAvailable &&
        rows.requirementExpression === undefined &&
        resolvedRequirements.length === rows.requirements.length
      ) {
        const effect = Type.effect(
          success.type,
          resolvedFailures,
          lifetimes,
          access,
          resolvedRequirements,
          rows.requirementParameters,
        )
        return {
          fact: {
            _tag: 'Resolved',
            type: effect,
            spelling: Type.encode(effect),
            anchor,
            components: [
              target.fact,
              ...arguments_.map((argument) => argument.fact),
              ...rows.requirements.map((requirement) => requirement.capability.fact),
              ...rows.rowParameterComponents,
            ],
          },
          diagnostics: diagnostics,
        }
      }
      return {
        fact: {
          _tag: 'Effect',
          lifetimes,
          access,
          success: success ?? unavailable(type.arguments.anchor),
          failures: rows.failures.map((failure) => failure.fact),
          requirements: rows.requirements.map((requirement) => ({
            capability: requirement.capability.fact,
            role: requirement.role,
            access: requirement.access,
            anchor: requirement.anchor,
          })),
          requirementParameters: rows.requirementParameters,
          ...(rows.requirementExpression === undefined
            ? {}
            : { requirementExpression: rows.requirementExpression }),
          spelling: 'Effect',
          anchor,
        },
        diagnostics: diagnostics,
      }
    }
    const rows = analyzeAppliedRows(context, type.arguments, typeParameters, lifetimeContext)
    const implicit =
      lifetimeContext === undefined
        ? undefined
        : DeclarationLifetime.nominalArgumentsOf(lifetimeContext, anchor)
    return {
      fact: {
        _tag: 'Applied',
        ...(implicit === undefined ? {} : { implicitLifetimeArguments: implicit }),
        target: target.fact,
        arguments: arguments_.map((argument) => argument.fact),
        ...(rows.requirementAnchor === undefined
          ? {}
          : {
              requirementRow: {
                requirements: rows.requirements.map((requirement) => ({
                  capability: requirement.capability.fact,
                  role: requirement.role,
                  access: requirement.access,
                  anchor: requirement.anchor,
                })),
                parameters: rows.requirementParameters,
                anchor: rows.requirementAnchor,
              },
            }),
        spelling: appliedSpelling(context, type),
        anchor,
      },
      diagnostics: Diagnostic.collect(
        target.diagnostics,
        ...arguments_.map((argument) => argument.diagnostics),
        ...rows.failures.map((failure) => failure.diagnostics),
        ...rows.requirements.map((requirement) => requirement.capability.diagnostics),
        rows.diagnostics,
      ),
    }
  }
  const path = typePathOf(context, type.path)
  if (path === undefined) return unavailableResolution(anchor)
  const first = path.segments[0]
  if (first === undefined) return unavailableResolution(anchor)
  const bare = path.segments.length === 1 ? first.spelling : undefined
  if (bare === 'string') {
    const lifetime = regionOf(type, undefined)
    if (lifetime === undefined) return missingLifetime(undefined)
    return {
      fact: {
        _tag: 'Resolved',
        type: Type.string(lifetime),
        spelling: `string<${Lifetime.display(lifetime)}>`,
        anchor,
        path,
      },
      diagnostics: noDiagnostics,
    }
  }
  if (bare !== undefined && (Type.isBuiltin(bare) || bare === 'never'))
    return {
      fact: { _tag: 'Resolved', type: bare, spelling: bare, anchor, path },
      diagnostics: noDiagnostics,
    }
  const intrinsicNominal = bare === undefined ? undefined : Type.intrinsicNominals.get(bare)
  if (intrinsicNominal !== undefined && bare !== undefined)
    return {
      fact: {
        _tag: 'Resolved',
        type: intrinsicNominal,
        spelling: bare,
        anchor,
        path,
      },
      diagnostics: noDiagnostics,
    }
  const parameterType = bare === undefined ? undefined : typeParameters.get(bare)
  if (parameterType !== undefined && bare !== undefined) {
    if (
      parameterType.kind === 'CallableRepresentation' ||
      parameterType.kind === 'EffectRepresentation'
    ) {
      const bound = parameterType.representationBound
      if (bound === undefined)
        return {
          fact: {
            _tag: 'RepresentationParameter',
            parameter: parameterType,
            spelling: bare,
            anchor,
            path,
          },
          diagnostics: noDiagnostics,
        }
      const represented = Type.represented(
        bound,
        bound,
        Type.representationParameterArgument(parameterType),
      )
      return {
        fact: {
          _tag: 'Resolved',
          type: represented,
          spelling: bare,
          anchor,
          path,
        },
        diagnostics: noDiagnostics,
      }
    }
    if (parameterType.kind !== 'Value' && !genericArgumentPosition) {
      const diagnostic = Diagnostic.genericParameterKindMismatch(
        bare,
        'Value',
        parameterType.kind,
        Location.at(first.anchor),
      )
      return {
        fact: {
          _tag: 'Unavailable',
          anchor,
          cause: Diagnostic.identity(diagnostic),
        },
        diagnostics: [diagnostic],
      }
    }
    return {
      fact: {
        _tag: 'Resolved',
        type: parameterType,
        spelling: bare,
        anchor,
        path,
      },
      diagnostics: noDiagnostics,
    }
  }
  const implicit =
    lifetimeContext === undefined
      ? undefined
      : DeclarationLifetime.nominalArgumentsOf(lifetimeContext, anchor)
  return {
    fact: {
      _tag: 'Unresolved',
      ...(implicit === undefined ? {} : { implicitLifetimeArguments: implicit }),
      spelling: path.spelling,
      anchor,
      path,
    },
    diagnostics: noDiagnostics,
  }
}

/** The written spelling of an applied type, rebuilt from authored names rather than source. */
const appliedSpelling = (
  context: Context,
  type: Extract<AuthoredHir.Type, { readonly _tag: 'AppliedType' }>,
): string => {
  const target =
    type.target._tag === 'NamedType' ? (typePathOf(context, type.target.path)?.spelling ?? '') : ''
  const arguments_ = type.arguments.arguments
    .map((argument) => argumentSpelling(context, argument))
    .join(',')
  const failures =
    type.arguments.failures === undefined
      ? ''
      : `!${operandSpelling(context, type.arguments.failures)}`
  const requirements =
    type.arguments.requirements === undefined
      ? ''
      : `?${type.arguments.requirements.members.map((member) => operandSpelling(context, member)).join('|')}`
  return `${target}<${arguments_}${failures}${requirements}>`
}

/** A borrow marker as it is written, without the space a formatter would add. */
const borrowSpelling = (
  context: Context,
  access: AuthoredHir.Access | undefined,
  lifetime: AuthoredHir.Lifetime | undefined,
): string => {
  if (access === undefined) return ''
  const region = lifetime === undefined ? '' : (nameText(context, lifetime.name) ?? '')
  return `&${region}${access === 'Mutable' ? 'mut' : ''}`
}

/** One row member or type argument in the compact form a declaration head is quoted with. */
const operandSpelling = (context: Context, operand: AuthoredHir.RowOperand): string => {
  switch (operand._tag) {
    case 'Requirement':
      return `${borrowSpelling(context, operand.access, undefined)}${operandSpelling(context, operand.capability)}`
    case 'NamedType':
      return typePathOf(context, operand.path)?.spelling ?? ''
    case 'AppliedType':
      return appliedSpelling(context, operand)
    case 'ReferenceType':
      return `${borrowSpelling(context, operand.access, operand.lifetime)}${operandSpelling(context, operand.referent)}`
    case 'UnionType':
      return operand.members.map((member) => operandSpelling(context, member)).join('|')
    case 'UnitType':
      return '()'
    default:
      return operand._tag
  }
}

const argumentSpelling = (context: Context, argument: AuthoredHir.GenericArgument): string => {
  if (argument._tag === 'Lifetime') return nameText(context, argument.name) ?? ''
  if (argument._tag === 'RequirementSelector') return ''
  return operandSpelling(context, argument)
}

const analyzeParameter = (
  context: Context,
  parameter: AuthoredHir.Parameter,
  functionId: DeclarationId,
  ordinal: number,
  typeParameters: ReadonlyMap<string, Type.Parameter> = new Map(),
  lifetimeContext?: DeclarationLifetime.Context,
): {
  readonly fact: ParameterFact
  readonly diagnostics: ReadonlyArray<Diagnostic.Located>
} => {
  const type = analyzeDeclaredType(context, parameter.type, typeParameters, false, lifetimeContext)
  return {
    fact: {
      _tag: 'ParameterDeclaration',
      id: { _tag: 'ParameterId', function: functionId, ordinal },
      name: declaredName(context, parameter.name),
      phase: parameter.mode === 'Static' ? 'Static' : 'Runtime',
      bindingMutability: parameter.mode === 'Mutable' ? 'Mutable' : 'Immutable',
      declaredType: type.fact,
      anchor: parameter.anchor,
    },
    diagnostics: type.diagnostics,
  }
}

const duplicateParameterDiagnostics = (
  context: Context,
  parameters: ReadonlyArray<ParameterFact>,
) => {
  const first = new Map<string, ReturnType<typeof presentParameterEntries>[number]>()
  const diagnostics: Array<Diagnostic.Located> = []
  for (const entry of presentParameterEntries(parameters)) {
    const original = first.get(entry.spelling)
    if (original === undefined) first.set(entry.spelling, entry)
    else
      diagnostics.push(
        Diagnostic.duplicateParameterName(
          entry.spelling,
          Location.at(original.anchor),
          Location.at(entry.anchor),
        ),
      )
  }
  return diagnostics
}

const collectFields = (
  context: Context,
  fieldNodes: ReadonlyArray<AuthoredHir.Field>,
  owner: FieldOwnerId,
  typeParameters: ReadonlyMap<string, Type.Parameter>,
  lifetimeContext?: DeclarationLifetime.Context,
) => {
  const first = new Map<string, { readonly id: FieldId; readonly anchor: AuthoredHir.Anchor }>()
  const diagnostics: Array<Diagnostic.Located> = []
  const fields = fieldNodes.map((field, ordinal): FieldFact => {
    const id: FieldId = { _tag: 'FieldId', owner, ordinal }
    const name = declaredName(context, field.name)
    const type = analyzeDeclaredType(context, field.type, typeParameters, false, lifetimeContext)
    diagnostics.push(...type.diagnostics)
    let state: FieldState
    if (name._tag !== 'Present') state = { _tag: 'Unidentified' }
    else {
      const original = first.get(name.spelling)
      if (original === undefined) {
        first.set(name.spelling, { id, anchor: name.anchor })
        state = { _tag: 'Unique', id }
      } else {
        const diagnostic = Diagnostic.duplicateFieldName(
          name.spelling,
          Location.at(original.anchor),
          Location.at(name.anchor),
        )
        diagnostics.push(diagnostic)
        state = {
          _tag: 'Duplicate',
          original: original.id,
          cause: Diagnostic.identity(diagnostic),
        }
      }
    }
    return {
      _tag: 'AggregateField',
      id,
      member: AggregateIdentity.labeled(name._tag === 'Present' ? name.spelling : ''),
      state,
      visibility: field.public ? 'Public' : 'Private',
      name,
      declaredType: type.fact,
      anchor: field.anchor,
    }
  })
  return { fields: fields, diagnostics: diagnostics }
}

/** Collects declaration-ordered tuple positions without inventing source field spellings. */
const collectPositionalFields = (
  context: Context,
  elements: ReadonlyArray<AuthoredHir.Type>,
  owner: FieldOwnerId,
  typeParameters: ReadonlyMap<string, Type.Parameter>,
  lifetimeContext?: DeclarationLifetime.Context,
) => {
  const diagnostics: Array<Diagnostic.Located> = []
  const fields = elements.map((element, ordinal): FieldFact => {
    const id: FieldId = { _tag: 'FieldId', owner, ordinal }
    const declaredType = analyzeDeclaredType(
      context,
      element,
      typeParameters,
      false,
      lifetimeContext,
    )
    diagnostics.push(...declaredType.diagnostics)
    return {
      _tag: 'AggregateField',
      id,
      member: AggregateIdentity.ordinal(ordinal),
      state: { _tag: 'Unique', id },
      visibility: 'Public',
      name: { _tag: 'Unavailable', anchor: element.anchor },
      declaredType: declaredType.fact,
      anchor: element.anchor,
    }
  })
  return { fields: fields, diagnostics: diagnostics }
}

/** A generic binder's written name, normalized so a lifetime binder keeps its leading tick. */
const binderName = (context: Context, generic: AuthoredHir.GenericParameter): DeclaredName => {
  const name = declaredName(context, generic.name)
  if (generic._tag !== 'LifetimeParameter' || name._tag !== 'Present') return name
  return name.spelling.startsWith("'")
    ? name
    : { _tag: 'Present', spelling: `'${name.spelling}`, anchor: name.anchor }
}

/** The sealed static property a bound names, when the bound is `Intrinsic.<Property>`. */
const staticPropertyOf = (
  context: Context,
  bound: AuthoredHir.Type | AuthoredHir.Lifetime,
): Type.SealedStaticProperty | undefined => {
  if (bound._tag !== 'NamedType') return undefined
  const path = typePathOf(context, bound.path)
  if (path === undefined || path.segments.length !== 2) return undefined
  if (path.segments[0]?.spelling !== 'Intrinsic') return undefined
  const property = path.segments[1]?.spelling
  return property === 'Detached' || property === 'NonParking' ? `Intrinsic.${property}` : undefined
}

/** Whether a bound is the `Effect<...>` application that makes a binder an effect representation. */
const isEffectBound = (
  context: Context,
  bound: AuthoredHir.Type | AuthoredHir.Lifetime,
): boolean => {
  if (bound._tag !== 'AppliedType' || bound.target._tag !== 'NamedType') return false
  const path = typePathOf(context, bound.target.path)
  return path?.segments.length === 1 && path.segments[0]?.spelling === 'Effect'
}

const collectTypeParameters = (
  context: Context,
  owner: AuthoredHir.Declaration,
  generics: ReadonlyArray<AuthoredHir.GenericParameter>,
  ownerName: string,
  ordinalOffset = 0,
  enclosing: ReadonlyArray<TypeParameterFact> = [],
): {
  readonly facts: ReadonlyArray<TypeParameterFact>
  readonly environment: ReadonlyMap<string, Type.Parameter>
  readonly diagnostics: ReadonlyArray<Diagnostic.Located>
  readonly lifetimeContext: DeclarationLifetime.Context
} => {
  const moduleName = context.module.owner.module
  const environment = new Map<string, Type.Parameter>(
    enclosing.flatMap((parameter) =>
      parameter.name._tag === 'Present' ? [[parameter.name.spelling, parameter.type] as const] : [],
    ),
  )
  const originals = new Map<string, AuthoredHir.Anchor>(
    enclosing.flatMap((parameter) =>
      parameter.name._tag === 'Present'
        ? [[parameter.name.spelling, parameter.name.anchor] as const]
        : [],
    ),
  )
  const diagnostics: Array<Diagnostic.Located> = []
  // Every binder is visible to every bound, so the environment is seeded before any bound resolves.
  for (const [ordinal, generic] of generics.entries()) {
    const name = binderName(context, generic)
    if (name._tag === 'Present' && !environment.has(name.spelling))
      environment.set(
        name.spelling,
        Type.parameter(
          { module: moduleName, name: ownerName },
          ordinalOffset + ordinal,
          name.spelling,
          generic._tag === 'LifetimeParameter' ? 'Lifetime' : 'Value',
        ),
      )
  }
  const lifetimeContext = DeclarationLifetime.forHeader(
    context,
    { module: moduleName, name: ownerName },
    owner,
    environment,
  )
  diagnostics.push(...lifetimeContext.diagnostics)
  const facts = generics.map((generic, ordinal): TypeParameterFact => {
    const name = binderName(context, generic)
    if (
      generic._tag === 'LifetimeParameter' &&
      name._tag === 'Present' &&
      name.spelling === "'static"
    )
      diagnostics.push(
        Diagnostic.invalidLifetimeBinder(
          'static cannot be declared as a lifetime parameter',
          Location.at(name.anchor),
        ),
      )
    const declaredBounds = generic._tag === 'RowParameter' ? [] : generic.bounds
    const lifetimeBounds = declaredBounds.flatMap((bound) => {
      if (bound._tag !== 'Lifetime') return []
      const ticked = tickedLifetimeName(context, bound.name)
      const region =
        ticked === undefined ? undefined : DeclarationLifetime.named(ticked, environment)
      if (region === undefined && ticked !== undefined)
        diagnostics.push(
          ...unreportedLifetimeDiagnostic(
            Diagnostic.unknownLifetime(ticked, Location.at(bound.anchor)),
            lifetimeContext,
          ),
        )
      return region === undefined ? [] : [region]
    })
    const typeBounds = declaredBounds.flatMap((bound) => (bound._tag === 'Lifetime' ? [] : [bound]))
    if (generic._tag === 'LifetimeParameter' && typeBounds.length > 0)
      diagnostics.push(
        Diagnostic.invalidLifetimeBinder(
          'A lifetime parameter accepts only lifetime outlives bounds',
          Location.at(generic.anchor),
        ),
      )
    const boundNode = typeBounds.at(0)
    const boundResolution =
      boundNode === undefined
        ? undefined
        : analyzeDeclaredType(context, boundNode, environment, false, lifetimeContext)
    let representationKind: Type.ParameterKind | undefined
    if (boundNode?._tag === 'CallableType') representationKind = 'CallableRepresentation'
    else if (boundNode !== undefined && isEffectBound(context, boundNode))
      representationKind = 'EffectRepresentation'
    else representationKind = undefined
    const firstStaticProperty =
      boundNode === undefined ? undefined : staticPropertyOf(context, boundNode)
    const rawStaticProperties = (
      representationKind === undefined && firstStaticProperty !== undefined
        ? typeBounds
        : typeBounds.slice(1)
    ).map((bound) => staticPropertyOf(context, bound))
    const staticPropertySet = new Set(
      rawStaticProperties.filter(
        (property): property is Type.SealedStaticProperty => property !== undefined,
      ),
    )
    const staticProperties: ReadonlyArray<Type.SealedStaticProperty> = (
      ['Intrinsic.Detached', 'Intrinsic.NonParking'] as const
    ).filter((property) => staticPropertySet.has(property))
    const representationContract =
      boundResolution?.fact._tag === 'Resolved' &&
      (Type.isCallable(boundResolution.fact.type) || Type.isEffect(boundResolution.fact.type))
        ? boundResolution.fact.type
        : undefined
    if (representationKind !== undefined && boundResolution !== undefined) {
      diagnostics.push(...boundResolution.diagnostics)
      for (const [conjunctOrdinal, property] of rawStaticProperties.entries()) {
        if (property !== undefined) continue
        const conjunct = typeBounds.at(conjunctOrdinal + 1)
        const segment = conjunct === undefined ? undefined : firstSegment(context, conjunct)
        if (conjunct !== undefined && segment !== undefined)
          diagnostics.push(
            Diagnostic.invalidExecutablePropertyConjunct(
              segment.spelling,
              Location.at(conjunct.anchor),
            ),
          )
      }
    }
    if (representationKind === undefined && staticProperties.includes('Intrinsic.NonParking')) {
      const propertyNode = typeBounds.find(
        (candidate) => staticPropertyOf(context, candidate) === 'Intrinsic.NonParking',
      )
      const segment = propertyNode === undefined ? undefined : firstSegment(context, propertyNode)
      if (propertyNode !== undefined && segment !== undefined)
        diagnostics.push(
          Diagnostic.invalidExecutablePropertyConjunct(
            segment.spelling,
            Location.at(propertyNode.anchor),
          ),
        )
    }
    const bounds: ReadonlyArray<BoundFact> =
      representationKind !== undefined || declaredBounds.length === 0
        ? []
        : typeBounds.flatMap((candidate): ReadonlyArray<BoundFact> => {
            if (staticPropertyOf(context, candidate) !== undefined) return []
            const segment = firstSegment(context, candidate)
            const path = nominalPath(context, candidate)
            // A bound recovery left without a name is still a written obligation: it stays an
            // unavailable requirement, so nothing downstream proves the binder unconstrained.
            if (
              (segment === undefined || path === undefined) &&
              !AuthoredWalk.isAvailable(candidate)
            )
              return [
                {
                  _tag: 'UnresolvedBound' as const,
                  spelling: '',
                  path: {
                    _tag: 'TypePath' as const,
                    spelling: '',
                    segments: [],
                    anchor: candidate.anchor,
                  },
                  application: unavailable(candidate.anchor),
                },
              ]
            if (segment === undefined || path === undefined) return []
            const resolution = analyzeDeclaredType(
              context,
              candidate,
              environment,
              false,
              lifetimeContext,
            )
            return [
              {
                _tag: 'UnresolvedBound' as const,
                spelling: segment.spelling,
                path: {
                  _tag: 'TypePath' as const,
                  spelling: segment.spelling,
                  segments: [{ spelling: segment.spelling, anchor: segment.anchor }],
                  anchor: candidate.anchor,
                },
                application: resolution.fact,
              },
            ]
          })
    const duplicateOf =
      name._tag === 'Present' && originals.has(name.spelling)
        ? environment.get(name.spelling)
        : undefined
    let parameterKind: Type.ParameterKind = representationKind ?? 'Value'
    if (generic._tag === 'LifetimeParameter') parameterKind = 'Lifetime'
    else if (generic._tag === 'RowParameter') parameterKind = 'RequirementRow'
    const parameterType =
      duplicateOf ??
      Type.parameter(
        { module: moduleName, name: ownerName },
        ordinalOffset + ordinal,
        name._tag === 'Present' ? name.spelling : `#${ordinal}`,
        parameterKind,
        representationContract,
        representationKind === undefined
          ? staticProperties.filter((property) => property === 'Intrinsic.Detached')
          : staticProperties,
      )
    if (name._tag === 'Present' && duplicateOf === undefined) {
      environment.set(name.spelling, parameterType)
      originals.set(name.spelling, name.anchor)
    } else if (name._tag === 'Present') {
      const originalAnchor = originals.get(name.spelling)
      if (originalAnchor !== undefined)
        diagnostics.push(
          Diagnostic.duplicateTypeParameter(
            name.spelling,
            Location.at(originalAnchor),
            Location.at(name.anchor),
          ),
        )
    }
    return {
      _tag: 'TypeParameterDeclaration' as const,
      type: parameterType,
      name,
      anchor: generic.anchor,
      bounds,
      lifetimeBounds: lifetimeBounds,
      staticProperties:
        representationKind === undefined
          ? staticProperties.filter((property) => property === 'Intrinsic.Detached')
          : staticProperties,
      ...(duplicateOf === undefined ? {} : { duplicateOf }),
      ...(representationKind === undefined ||
      boundNode === undefined ||
      boundResolution === undefined
        ? {}
        : {
            representationBound: {
              _tag: 'RepresentationBound' as const,
              kind:
                representationKind === 'CallableRepresentation'
                  ? ('Callable' as const)
                  : ('Effect' as const),
              contract: boundResolution.fact,
              anchor: boundNode.anchor,
            },
          }),
    }
  })
  const implicitFacts = implicitLifetimeParameters(lifetimeContext, environment)
  return {
    facts: [...facts, ...implicitFacts],
    lifetimeContext: {
      ...lifetimeContext,
      parameters: new Map(
        [...environment].filter(
          ([name]) => !lifetimeContext.implicit.some((binder) => binder.parameter.name === name),
        ),
      ),
    },
    environment,
    diagnostics: diagnostics,
  }
}

const implicitLifetimeParameters = (
  lifetimeContext: DeclarationLifetime.Context,
  environment: Map<string, Type.Parameter>,
): ReadonlyArray<TypeParameterFact> =>
  lifetimeContext.implicit.map((binder) => {
    environment.set(binder.parameter.name, binder.parameter)
    return {
      _tag: 'TypeParameterDeclaration',
      type: binder.parameter,
      name: {
        _tag: 'Present',
        spelling: binder.parameter.name,
        anchor: binder.anchor,
      },
      anchor: binder.anchor,
      bounds: [],
      staticProperties: [],
      lifetimeBounds: [],
      implicitLifetime: true,
    }
  })

/**
 * The declared result of one contract, plus the opaque binder it introduces.
 *
 * An `impl Bound` result owns a hidden binder whose identity belongs to the declaring header, so
 * the binder is minted here where the canonical owner name is known.
 */
const collectReturnType = (
  context: Context,
  owner: AuthoredHir.Declaration,
  result: AuthoredHir.Type,
  ownerName: string,
  typeParameters: ReadonlyArray<TypeParameterFact>,
  ambientParameters: ReadonlyMap<string, Type.Parameter> = new Map(),
  lifetimeContext?: DeclarationLifetime.Context,
): {
  readonly fact: ReturnTypeFact
  readonly opaqueResult?: OpaqueResultFact
  readonly diagnostics: ReadonlyArray<Diagnostic.Located>
} => {
  if (result._tag !== 'OpaqueResultType') {
    const analyzed = analyzeDeclaredType(
      context,
      result,
      new Map([
        ...ambientParameters,
        ...typeParameters.flatMap((parameter) =>
          parameter.name._tag === 'Present'
            ? [[parameter.name.spelling, parameter.type] as const]
            : [],
        ),
      ]),
      false,
      lifetimeContext,
    )
    return { fact: analyzed.fact, diagnostics: analyzed.diagnostics }
  }
  const collected = collectTypeParameters(
    context,
    owner,
    result.binders,
    ownerName,
    typeParameters.length,
    typeParameters,
  )
  const binder = collected.facts.at(0)
  if (binder === undefined)
    return {
      fact: unavailable(result.anchor),
      diagnostics: collected.diagnostics,
    }
  const analyzed = analyzeDeclaredType(
    context,
    result.result,
    new Map([...ambientParameters, ...collected.environment]),
    false,
    lifetimeContext,
  )
  return {
    fact: analyzed.fact,
    opaqueResult: {
      _tag: 'OpaqueResult',
      binder,
      family: {
        _tag: 'OpaqueFamilyKey',
        producer: { module: context.module.owner.module, name: ownerName },
        binderOrdinal: 0,
      },
      publicSignature: {
        bound:
          binder.type.representationBound === undefined
            ? 'unavailable'
            : Type.key(binder.type.representationBound),
        result:
          analyzed.fact._tag === 'Resolved' ? Type.key(analyzed.fact.type) : analyzed.fact._tag,
        enclosingKinds: typeParameters.map((parameter) => parameter.type.kind),
      },
      anchor: result.anchor,
    },
    diagnostics: [...collected.diagnostics, ...analyzed.diagnostics],
  }
}

/**
 * `bareKeys` admits a service-role key written without access (`Clock`, `Clock at Primary`), the
 * form a `Without` operand names; elsewhere a bare path is a row parameter.
 */
const collectRowExpression = (
  context: Context,
  operand: AuthoredHir.RowOperand,
  typeParameters: ReadonlyMap<string, Type.Parameter>,
  leaf: 'Failure' | 'Requirement',
  bareKeys = false,
  lifetimeContext?: DeclarationLifetime.Context,
): {
  readonly fact: RowExpressionDecision
  readonly diagnostics: ReadonlyArray<Diagnostic.Located>
} => {
  const anchor = operand.anchor
  if (operand._tag === 'RowWithout') {
    const sourceRow = collectRowExpression(
      context,
      operand.source,
      typeParameters,
      leaf,
      true,
      lifetimeContext,
    )
    const selected = collectRowExpression(
      context,
      operand.removed,
      typeParameters,
      leaf,
      true,
      lifetimeContext,
    )
    return {
      fact: {
        _tag: 'WithoutRowExpression',
        source: sourceRow.fact,
        selected: selected.fact,
        anchor,
      },
      diagnostics: [...sourceRow.diagnostics, ...selected.diagnostics],
    }
  }
  if (operand._tag === 'UnionType') {
    const collected = operand.members.map((member) =>
      collectRowExpression(context, member, typeParameters, leaf, bareKeys, lifetimeContext),
    )
    return {
      fact: {
        _tag: 'UnionRowExpression',
        operands: collected.map((member) => member.fact),
        anchor,
      },
      diagnostics: collected.flatMap((member) => member.diagnostics),
    }
  }
  if (leaf === 'Failure') {
    if (operand._tag === 'Requirement')
      return {
        fact: { _tag: 'UnavailableRowExpression', anchor },
        diagnostics: noDiagnostics,
      }
    const analyzed = analyzeDeclaredType(context, operand, typeParameters, false, lifetimeContext)
    return {
      fact: { _tag: 'FailureMemberExpression', member: analyzed.fact, anchor },
      diagnostics: analyzed.diagnostics,
    }
  }
  if (operand._tag !== 'Requirement') {
    const parameter = parameterAtType(context, operand, typeParameters)
    if (parameter?.kind === 'RequirementRow')
      return {
        fact: { _tag: 'RowParameterExpression', parameter, anchor },
        diagnostics: noDiagnostics,
      }
    if (bareKeys && operand._tag === 'NamedType') {
      const analyzed = analyzeDeclaredType(context, operand, typeParameters, false, lifetimeContext)
      return {
        fact: {
          _tag: 'RequirementMemberExpression',
          capability: analyzed.fact,
          access: 'Shared',
          role: { _tag: 'DefaultRole' },
          anchor,
        },
        diagnostics: analyzed.diagnostics,
      }
    }
    // A row position that parses as a type spells a borrowed requirement as a reference type.
    if (operand._tag === 'ReferenceType') {
      const analyzed = analyzeDeclaredType(
        context,
        operand.referent,
        typeParameters,
        false,
        lifetimeContext,
      )
      return {
        fact: {
          _tag: 'RequirementMemberExpression',
          capability: analyzed.fact,
          access: operand.access === 'Mutable' ? 'Exclusive' : 'Shared',
          role: { _tag: 'DefaultRole' },
          anchor,
        },
        diagnostics: analyzed.diagnostics,
      }
    }
    return {
      fact: { _tag: 'UnavailableRowExpression', anchor },
      diagnostics: noDiagnostics,
    }
  }
  const analyzed = analyzeDeclaredType(
    context,
    operand.capability,
    typeParameters,
    false,
    lifetimeContext,
  )
  return {
    fact: {
      _tag: 'RequirementMemberExpression',
      capability: analyzed.fact,
      access: operand.access === 'Mutable' ? 'Exclusive' : 'Shared',
      role: collectedRequirementRole(context, operand),
      anchor,
    },
    diagnostics: analyzed.diagnostics,
  }
}

const emptyRowExpression: RowExpressionDecision = { _tag: 'EmptyRowExpression' }

/** Joins one requirement row's members into a single row expression. */
const rowExpressionOf = (
  context: Context,
  row: AuthoredHir.RequirementRow,
  typeParameters: ReadonlyMap<string, Type.Parameter>,
  lifetimeContext?: DeclarationLifetime.Context,
): RowExpressionDecision =>
  row.members
    .map((member) =>
      collectRowExpression(context, member, typeParameters, 'Requirement', false, lifetimeContext),
    )
    .reduce<RowExpressionDecision>(
      (left, right) =>
        left._tag === 'EmptyRowExpression'
          ? right.fact
          : {
              _tag: 'UnionRowExpression',
              operands: [left, right.fact],
              anchor: row.anchor,
            },
      emptyRowExpression,
    )

const emptyFailureRow = RowAlgebra.concrete(Type.failureRowPolicy(), [])
const emptyRequirementRow = RowAlgebra.concrete(Type.requirementRowPolicy(), [])

const absentFailureRow: FailureRowFact = {
  _tag: 'FailureRow',
  members: [],
  parameters: [],
  failures: [],
  available: true,
  expression: emptyRowExpression,
  row: emptyFailureRow,
}

const absentRequirementRow: RequirementRowFact = {
  _tag: 'RequirementRow',
  entries: [],
  parameters: [],
  requirements: [],
  available: true,
  expression: emptyRowExpression,
  row: emptyRequirementRow,
}

const collectFailureRow = (
  context: Context,
  failures: AuthoredHir.Type | undefined,
  typeParameters: ReadonlyMap<string, Type.Parameter>,
  lifetimeContext?: DeclarationLifetime.Context,
): {
  readonly fact: FailureRowFact
  readonly diagnostics: ReadonlyArray<Diagnostic.Located>
} => {
  if (failures === undefined) return { fact: absentFailureRow, diagnostics: noDiagnostics }
  const expression = collectRowExpression(
    context,
    failures,
    typeParameters,
    'Failure',
    false,
    lifetimeContext,
  )
  // The member facts remain the single diagnostic owner while the row expression is retained as
  // the semantic shape. Reporting both would emit one source member's error twice.
  const diagnostics: Array<Diagnostic.Located> = []
  const members = failureMembers(failures).flatMap((member): ReadonlyArray<DeclaredTypeFact> => {
    const parameter = parameterAtType(context, member, typeParameters)
    if (parameter?.kind === 'RequirementRow') {
      const segment = firstSegment(context, member)
      if (segment !== undefined)
        diagnostics.push(
          Diagnostic.genericParameterKindMismatch(
            segment.spelling,
            'Value',
            parameter.kind,
            Location.at(segment.anchor),
          ),
        )
      return []
    }
    const analyzed = analyzeDeclaredType(context, member, typeParameters, false, lifetimeContext)
    diagnostics.push(...analyzed.diagnostics)
    return [analyzed.fact]
  })
  return {
    fact: {
      _tag: 'FailureRow',
      members: members,
      parameters: [],
      failures: [],
      anchor: failures.anchor,
      available: false,
      expression: expression.fact,
      row: emptyFailureRow,
    },
    diagnostics: diagnostics,
  }
}

const collectRequirementRow = (
  context: Context,
  row: AuthoredHir.RequirementRow | undefined,
  typeParameters: ReadonlyMap<string, Type.Parameter>,
  lifetimeContext?: DeclarationLifetime.Context,
): {
  readonly fact: RequirementRowFact
  readonly diagnostics: ReadonlyArray<Diagnostic.Located>
} => {
  if (row === undefined) return { fact: absentRequirementRow, diagnostics: noDiagnostics }
  const diagnostics: Array<Diagnostic.Located> = []
  // Entry collection owns the source diagnostics; the expression facts are structural and must
  // not duplicate the same diagnostic occurrence.
  const expression = rowExpressionOf(context, row, typeParameters, lifetimeContext)
  const entries = row.members.flatMap((member) => {
    if (member._tag !== 'Requirement') return []
    const analyzed = analyzeDeclaredType(
      context,
      member.capability,
      typeParameters,
      false,
      lifetimeContext,
    )
    diagnostics.push(...analyzed.diagnostics)
    return [
      {
        capability: analyzed.fact,
        role: collectedRequirementRole(context, member),
        access: member.access === 'Mutable' ? ('Exclusive' as const) : ('Shared' as const),
        anchor: member.anchor,
      },
    ]
  })
  const parameters = row.members.flatMap((member): ReadonlyArray<Type.Parameter> => {
    if (member._tag === 'Requirement' || member._tag !== 'NamedType') return []
    const parameter = parameterAtType(context, member, typeParameters)
    if (parameter?.kind === 'RequirementRow') return [parameter]
    const segment = firstSegment(context, member)
    if (segment !== undefined)
      diagnostics.push(
        parameter === undefined
          ? Diagnostic.unknownType(segment.spelling, Location.at(segment.anchor))
          : Diagnostic.genericParameterKindMismatch(
              segment.spelling,
              'RequirementRow',
              parameter.kind,
              Location.at(segment.anchor),
            ),
      )
    return []
  })
  return {
    fact: {
      _tag: 'RequirementRow',
      entries: entries,
      parameters: parameters,
      requirements: [],
      anchor: row.anchor,
      available: false,
      expression,
      row: emptyRequirementRow,
    },
    diagnostics: diagnostics,
  }
}

/** Whether any operand below one row expression names a requirement-row binder. */
const mentionsRowParameter = (
  context: Context,
  operand: AuthoredHir.RowOperand,
  typeParameters: ReadonlyMap<string, Type.Parameter>,
): boolean => {
  if (operand._tag === 'Requirement') return true
  if (operand._tag === 'RowWithout')
    return (
      mentionsRowParameter(context, operand.source, typeParameters) ||
      mentionsRowParameter(context, operand.removed, typeParameters)
    )
  if (operand._tag === 'UnionType')
    return operand.members.some((member) => mentionsRowParameter(context, member, typeParameters))
  return parameterAtType(context, operand, typeParameters)?.kind === 'RequirementRow'
}

const constraintDomain = (
  context: Context,
  operand: AuthoredHir.RowOperand,
  typeParameters: ReadonlyMap<string, Type.Parameter>,
): 'Failure' | 'Requirement' =>
  mentionsRowParameter(context, operand, typeParameters) ? 'Requirement' : 'Failure'

const collectConstraints = (
  context: Context,
  constraints: ReadonlyArray<AuthoredHir.Constraint>,
  typeParameters: ReadonlyMap<string, Type.Parameter>,
): {
  readonly facts: ReadonlyArray<ConstraintFact>
  readonly diagnostics: ReadonlyArray<Diagnostic.Located>
} => {
  if (constraints.length === 0) return { facts: [], diagnostics: noDiagnostics }
  const diagnostics: Array<Diagnostic.Located> = []
  const facts = constraints.map((constraint): ConstraintFact => {
    if (constraint._tag === 'MembershipConstraint') {
      const domain = constraintDomain(context, constraint.source, typeParameters)
      const selected = collectRowExpression(context, constraint.subject, typeParameters, domain)
      const sourceRow = collectRowExpression(context, constraint.source, typeParameters, domain)
      diagnostics.push(...selected.diagnostics, ...sourceRow.diagnostics)
      return {
        _tag: 'MembershipConstraint',
        domain,
        selected: selected.fact,
        source: sourceRow.fact,
        anchor: constraint.anchor,
      }
    }
    // A provider written as a borrow selects a shared or exclusive mode; a bare type takes it.
    const provider = constraint.provider
    const providerType = provider._tag === 'ReferenceType' ? provider.referent : provider
    const analyzed = analyzeDeclaredType(context, providerType, typeParameters)
    const selected = collectRowExpression(
      context,
      constraint.selected,
      typeParameters,
      'Requirement',
    )
    const sourceRow = collectRowExpression(
      context,
      constraint.source,
      typeParameters,
      'Requirement',
    )
    diagnostics.push(...analyzed.diagnostics, ...selected.diagnostics, ...sourceRow.diagnostics)
    let mode: Type.CallableMode
    if (provider._tag !== 'ReferenceType') mode = 'Take'
    else if (provider.access === 'Mutable') mode = 'Exclusive'
    else mode = 'Shared'
    return {
      _tag: 'ProviderConstraint',
      mode,
      provider: analyzed.fact,
      selected: selected.fact,
      source: sourceRow.fact,
      anchor: constraint.anchor,
    }
  })
  return { facts: facts, diagnostics: diagnostics }
}

/**
 * The header a nested callable expression owns, so elaboration can treat it as a declaration.
 *
 * Lowering already mints an anonymous callable as its own owner, so the contract it carries is a
 * complete header: wrapping it is a view over authored structure, not a synthesized declaration.
 */
const missingName = (anchor: AuthoredHir.Anchor, origin: AuthoredHir.Origin): AuthoredHir.Name => ({
  _tag: 'MissingName',
  anchor,
  origin,
  causes: [{ _tag: 'Cause', anchor, code: 'AnonymousCallable' }],
})

export const anonymousDeclaration = (
  node: Extract<AuthoredHir.Expression, { readonly _tag: 'CallableExpression' }>,
): AuthoredHir.Declaration => ({
  _tag: 'Declaration',
  owner: node.anchor.owner,
  header: {
    _tag: 'FunctionHeader',
    anchor: node.anchor,
    origin: node.origin,
    causes: node.causes,
    // A hidden callable has no authored name; the canonical identity supplies its spelling.
    name: missingName(node.anchor, node.origin),
    public: false,
    contract: node.contract,
    linkage: undefined,
    properties: [],
  },
  body: { _tag: 'CallableBody', block: node.body },
})

/**
 * Collects the declaration-shaped contract owned by one anonymous callable occurrence.
 *
 * The occurrence elaborates and lowers as a hidden private declaration carrying the enclosing
 * declaration's binders, so a call through it infers exactly as a named function would.
 */
export const collectAnonymousCallableDeclaration = (
  context: Context,
  node: AuthoredHir.Expression,
  id: DeclarationId,
  canonical: CanonicalId,
  inheritedTypeParameters: ReadonlyArray<TypeParameterFact>,
): {
  readonly fact: DeclarationFact
  readonly diagnostics: ReadonlyArray<Diagnostic.Located>
} => {
  const environment = new Map(
    inheritedTypeParameters.flatMap((parameter) =>
      parameter.name._tag === 'Present' ? [[parameter.name.spelling, parameter.type] as const] : [],
    ),
  )
  const name: DeclaredName =
    node._tag === 'CallableExpression'
      ? { _tag: 'Present', spelling: canonical.name, anchor: node.anchor }
      : { _tag: 'Unavailable', anchor: node.anchor }
  if (node._tag !== 'CallableExpression')
    return {
      fact: {
        _tag: 'FunctionDeclaration',
        id,
        canonical: { _tag: 'Canonical', id: canonical },
        visibility: 'Private',
        phase: 'Runtime',
        functionKind: 'Ordinary',
        test: false,
        unsafe: false,
        typeParameters: [...inheritedTypeParameters],
        parameterCount: 0,
        parameters: [],
        name,
        returnType: unavailable(node.anchor),
        failureRow: absentFailureRow,
        requirementRow: absentRequirementRow,
        constraints: [],
        constraintContracts: [],
        owner: node.anchor.owner,
        anchor: node.anchor,
      },
      diagnostics: noDiagnostics,
    }
  const declaration = anonymousDeclaration(node)
  const contract = node.contract
  const lifetimeContext = DeclarationLifetime.forHeader(
    context,
    canonical,
    declaration,
    environment,
  )
  const parameters = contract.parameters.map((parameter, ordinal) =>
    analyzeParameter(context, parameter, id, ordinal, environment, lifetimeContext),
  )
  const returnType: {
    readonly fact: ReturnTypeFact
    readonly opaqueResult?: OpaqueResultFact
    readonly diagnostics: ReadonlyArray<Diagnostic.Located>
  } =
    contract.result === undefined
      ? {
          fact: unavailable(node.anchor),
          diagnostics: noDiagnostics,
        }
      : collectReturnType(
          context,
          declaration,
          contract.result,
          canonical.name,
          inheritedTypeParameters,
          environment,
          lifetimeContext,
        )
  const failureRow = collectFailureRow(context, contract.failures, environment, lifetimeContext)
  const requirementRow = collectRequirementRow(
    context,
    contract.requirements,
    environment,
    lifetimeContext,
  )
  const parameterFacts = parameters.map((parameter) => parameter.fact)
  const diagnostics = [
    ...lifetimeContext.diagnostics,
    ...parameters.flatMap((parameter) => parameter.diagnostics),
    ...duplicateParameterDiagnostics(context, parameterFacts),
    ...returnType.diagnostics,
    ...failureRow.diagnostics,
    ...requirementRow.diagnostics,
    ...(!contract.effect && failureRow.fact.anchor !== undefined
      ? [Diagnostic.failureChannelOnOrdinary(Location.at(failureRow.fact.anchor))]
      : []),
  ]
  return {
    fact: {
      _tag: 'FunctionDeclaration',
      lifetimeElaboration: lifetimeContext,
      id,
      canonical: { _tag: 'Canonical', id: canonical },
      visibility: 'Private',
      phase: 'Runtime',
      functionKind: contract.effect ? 'Effect' : 'Ordinary',
      test: false,
      unsafe: false,
      typeParameters: [
        ...inheritedTypeParameters,
        ...implicitLifetimeParameters(lifetimeContext, environment),
      ],
      parameterCount: parameterFacts.length,
      parameters: parameterFacts,
      name,
      returnType: returnType.fact,
      ...(returnType.opaqueResult === undefined ? {} : { opaqueResult: returnType.opaqueResult }),
      failureRow: failureRow.fact,
      requirementRow: requirementRow.fact,
      constraints: [],
      constraintContracts: [],
      owner: node.anchor.owner,
      anchor: node.anchor,
    },
    diagnostics,
  }
}

const enumRepresentation = (
  context: Context,
  header: Extract<AuthoredHir.DeclarationHeader, { readonly _tag: 'EnumHeader' }>,
  diagnostics: Array<Diagnostic.Located>,
): EnumRepresentationFact => {
  const representation = header.representation
  if (representation === undefined)
    return {
      _tag: 'Available',
      scalar: Scalar.defaultEnumRepresentation,
      explicit: false,
      anchor: header.anchor,
    }
  if (representation._tag === 'MissingType' || representation._tag === 'InvalidType')
    return { _tag: 'Unavailable', explicit: true, anchor: representation.anchor }
  const segment = firstSegment(context, representation)
  const spelling = segment?.spelling ?? '<unavailable>'
  const scalar = Scalar.enumRepresentation(spelling)
  if (scalar !== undefined)
    return {
      _tag: 'Available',
      scalar,
      explicit: true,
      anchor: representation.anchor,
    }
  const diagnostic = Diagnostic.unsupportedEnumRepresentation(
    spelling,
    Scalar.enumRepresentations().map((candidate) => candidate.spelling),
    Location.at(representation.anchor),
  )
  diagnostics.push(diagnostic)
  return {
    _tag: 'Unavailable',
    explicit: true,
    anchor: representation.anchor,
    spelling,
    cause: Diagnostic.identity(diagnostic),
  }
}

const collectEnum = (
  context: Context,
  declaration: AuthoredHir.Declaration,
  header: Extract<AuthoredHir.DeclarationHeader, { readonly _tag: 'EnumHeader' }>,
  id: DeclarationId,
  canonical: CanonicalState,
  visibility: 'Private' | 'Public',
  name: DeclaredName,
  diagnostics: Array<Diagnostic.Located>,
): EnumFact => {
  const enumDiagnostics: Array<Diagnostic.Located> = []
  const representation = enumRepresentation(context, header, enumDiagnostics)
  if (header.members.length === 0)
    enumDiagnostics.push(
      Diagnostic.emptyEnum(
        name._tag === 'Present' ? name.spelling : '<anonymous>',
        Location.at(header.anchor),
      ),
    )
  const firstNames = new Map<
    string,
    {
      readonly id: EnumMemberId
      readonly canonical?: CanonicalEnumMemberId
      readonly anchor: AuthoredHir.Anchor
    }
  >()
  const firstDiscriminants = new Map<bigint, AuthoredHir.Anchor>()
  const representationScalar =
    representation._tag === 'Available' ? representation.scalar : undefined
  const range =
    representationScalar === undefined ? undefined : Scalar.range(representationScalar, 64)
  let previous: bigint | undefined
  const members = header.members.map((member, ordinal): EnumMemberFact => {
    const memberId: EnumMemberId = { _tag: 'EnumMemberId', enum: id, ordinal }
    const memberName = declaredName(context, member.name)
    let memberCanonical: EnumMemberFact['canonical'] = { _tag: 'Unidentified' }
    if (memberName._tag === 'Present') {
      const original = firstNames.get(memberName.spelling)
      if (original === undefined) {
        const canonicalMember =
          canonical._tag === 'Canonical'
            ? {
                _tag: 'CanonicalEnumMemberId' as const,
                enum: canonical.id,
                name: memberName.spelling,
              }
            : undefined
        firstNames.set(memberName.spelling, {
          id: memberId,
          anchor: memberName.anchor,
          ...(canonicalMember === undefined ? {} : { canonical: canonicalMember }),
        })
        if (canonicalMember !== undefined)
          memberCanonical = { _tag: 'Canonical', id: canonicalMember }
      } else {
        const diagnostic = Diagnostic.duplicateEnumMemberName(
          memberName.spelling,
          Location.at(original.anchor),
          Location.at(memberName.anchor),
        )
        enumDiagnostics.push(diagnostic)
        if (original.canonical !== undefined)
          memberCanonical = {
            _tag: 'Duplicate',
            original: original.canonical,
            cause: Diagnostic.identity(diagnostic),
          }
      }
    }
    const explicit = member.value
    const sourceKind: EnumDiscriminantFact['source'] =
      explicit === undefined ? 'Implicit' : 'Explicit'
    let attempted: bigint | undefined
    if (explicit !== undefined) {
      const literal = constantLiteral(context, explicit)
      if (literal._tag === 'IntegerLiteral') attempted = literal.value
    } else if (ordinal === 0) attempted = 0n
    else if (previous !== undefined) attempted = previous + 1n

    let discriminant: EnumDiscriminantFact
    const discriminantAnchor = explicit?.anchor ?? member.anchor
    if (attempted === undefined || range === undefined || representationScalar === undefined) {
      discriminant = {
        _tag: 'Unavailable',
        source: sourceKind,
        anchor: discriminantAnchor,
        ...(attempted === undefined ? {} : { attempted }),
        ...(representation._tag === 'Unavailable' && representation.cause !== undefined
          ? { cause: representation.cause }
          : {}),
      }
    } else if (
      sourceKind === 'Explicit' &&
      representationScalar.signedness === 'Unsigned' &&
      attempted < 0n
    ) {
      const diagnostic = Diagnostic.unsignedEnumNegativeDiscriminant(
        representationScalar.spelling,
        attempted,
        Location.at(discriminantAnchor),
      )
      enumDiagnostics.push(diagnostic)
      discriminant = {
        _tag: 'Unavailable',
        source: sourceKind,
        anchor: discriminantAnchor,
        attempted,
        cause: Diagnostic.identity(diagnostic),
      }
    } else if (attempted < range.minimum || attempted > range.maximum) {
      const diagnostic =
        sourceKind === 'Explicit'
          ? Diagnostic.enumDiscriminantOutOfRange(
              representationScalar.spelling,
              attempted,
              range.minimum,
              range.maximum,
              Location.at(discriminantAnchor),
            )
          : Diagnostic.enumImplicitDiscriminantOverflow(
              representationScalar.spelling,
              previous ?? range.maximum,
              range.maximum,
              Location.at(member.anchor),
            )
      enumDiagnostics.push(diagnostic)
      discriminant = {
        _tag: 'Unavailable',
        source: sourceKind,
        anchor: discriminantAnchor,
        attempted,
        cause: Diagnostic.identity(diagnostic),
      }
    } else {
      const original = firstDiscriminants.get(attempted)
      if (original === undefined) {
        firstDiscriminants.set(attempted, member.anchor)
        discriminant = {
          _tag: 'Available',
          value: attempted,
          source: sourceKind,
          anchor: discriminantAnchor,
        }
      } else {
        const diagnostic = Diagnostic.duplicateEnumDiscriminant(
          attempted,
          Location.at(original),
          Location.at(member.anchor),
        )
        enumDiagnostics.push(diagnostic)
        discriminant = {
          _tag: 'Unavailable',
          source: sourceKind,
          anchor: discriminantAnchor,
          attempted,
          cause: Diagnostic.identity(diagnostic),
        }
      }
    }
    previous =
      attempted !== undefined &&
      range !== undefined &&
      attempted >= range.minimum &&
      attempted <= range.maximum
        ? attempted
        : undefined
    return {
      _tag: 'EnumMember',
      id: memberId,
      canonical: memberCanonical,
      name: memberName,
      discriminant,
      anchor: member.anchor,
    }
  })
  diagnostics.push(...enumDiagnostics)
  const associatedOperation = enumValueOperation({ canonical, representation })
  const valid =
    enumDiagnostics.length === 0 &&
    representation._tag === 'Available' &&
    members.every(
      (member) =>
        member.name._tag === 'Present' &&
        member.canonical._tag === 'Canonical' &&
        member.discriminant._tag === 'Available',
    )
  return {
    _tag: 'EnumDeclaration',
    id,
    canonical,
    visibility,
    typeParameters: [],
    name,
    representation,
    members: members,
    associatedOperations: associatedOperation === undefined ? [] : [associatedOperation],
    validity: valid
      ? { _tag: 'Valid' }
      : {
          _tag: 'Invalid',
          causes: enumDiagnostics.map((diagnostic) => Diagnostic.identity(diagnostic)),
        },
    anchor: declaration.header.anchor,
  }
}

const collectUnion = (
  context: Context,
  declaration: AuthoredHir.Declaration,
  header: Extract<AuthoredHir.DeclarationHeader, { readonly _tag: 'UnionHeader' }>,
  id: DeclarationId,
  canonical: CanonicalState,
  visibility: 'Private' | 'Public',
  name: DeclaredName,
  typeParameters: ReturnType<typeof collectTypeParameters>,
  diagnostics: Array<Diagnostic.Located>,
): UnionFact => {
  const unionDiagnostics: Array<Diagnostic.Located> = []
  if (header.variants.length === 0)
    unionDiagnostics.push(
      Diagnostic.emptyNominalUnion(
        name._tag === 'Present' ? name.spelling : '<anonymous>',
        Location.at(header.anchor),
      ),
    )
  const first = new Map<
    string,
    {
      readonly id: UnionVariantId
      readonly canonical?: CanonicalUnionVariantId
      readonly anchor: AuthoredHir.Anchor
    }
  >()
  const variants = header.variants.map((variant, ordinal): UnionVariantFact => {
    const variantId: UnionVariantId = { _tag: 'UnionVariantId', union: id, ordinal }
    const variantName = declaredName(context, variant.name)
    let variantCanonical: UnionVariantFact['canonical'] = { _tag: 'Unidentified' }
    if (variantName._tag === 'Present') {
      const original = first.get(variantName.spelling)
      if (original === undefined) {
        const canonicalVariant =
          canonical._tag === 'Canonical'
            ? {
                _tag: 'CanonicalUnionVariantId' as const,
                union: canonical.id,
                name: variantName.spelling,
              }
            : undefined
        first.set(variantName.spelling, {
          id: variantId,
          anchor: variantName.anchor,
          ...(canonicalVariant === undefined ? {} : { canonical: canonicalVariant }),
        })
        if (canonicalVariant !== undefined)
          variantCanonical = { _tag: 'Canonical', id: canonicalVariant }
      } else {
        const diagnostic = Diagnostic.duplicateUnionVariant(
          variantName.spelling,
          Location.at(original.anchor),
          Location.at(variantName.anchor),
        )
        unionDiagnostics.push(diagnostic)
        if (original.canonical !== undefined)
          variantCanonical = {
            _tag: 'Duplicate',
            original: original.canonical,
            cause: Diagnostic.identity(diagnostic),
          }
      }
    }
    const collected = collectFields(
      context,
      variant.fields,
      { _tag: 'UnionVariantFieldOwnerId', variant: variantId },
      typeParameters.environment,
      typeParameters.lifetimeContext,
    )
    unionDiagnostics.push(...collected.diagnostics)
    // Written braces with nothing in them are neither a unit variant nor a field variant; the
    // author has to pick one, so the braces are reported rather than silently treated as a unit.
    // An empty block still lowers one unnamed placeholder field, so emptiness is "no field was
    // actually named" rather than an empty list.
    if (
      variant.braces &&
      variantName._tag === 'Present' &&
      variant.fields.every((field) => field.name._tag !== 'Name')
    )
      unionDiagnostics.push(
        Diagnostic.emptyUnionVariant(variantName.spelling, Location.at(variant.anchor)),
      )
    return {
      _tag: 'UnionVariant',
      id: variantId,
      canonical: variantCanonical,
      name: variantName,
      kind: variant.fields.length === 0 ? 'Unit' : 'Fields',
      fields: collected.fields,
      anchor: variant.anchor,
    }
  })
  diagnostics.push(...unionDiagnostics)
  const valid =
    unionDiagnostics.length === 0 &&
    variants.length > 0 &&
    variants.every(
      (variant) =>
        variant.name._tag === 'Present' &&
        variant.canonical._tag === 'Canonical' &&
        variant.fields.every((field) => field.state._tag === 'Unique'),
    )
  return {
    _tag: 'UnionDeclaration',
    lifetimeElaboration: typeParameters.lifetimeContext,
    id,
    canonical,
    visibility,
    typeParameters: typeParameters.facts,
    name,
    variants: variants,
    dependency: { _tag: 'Available', types: [] },
    validity: valid
      ? { _tag: 'Valid' }
      : {
          _tag: 'Invalid',
          causes: unionDiagnostics.map((diagnostic) => Diagnostic.identity(diagnostic)),
        },
    anchor: declaration.header.anchor,
  }
}

/** The text an authored ABI or symbol operand carries; a computed expression has none. */
const literalText = (
  context: Context,
  value: AuthoredHir.TextLiteral | AuthoredHir.MissingExpression | AuthoredHir.InvalidExpression,
): string | undefined => (value._tag === 'TextLiteral' ? context.textOf(value.value) : undefined)

/** A malformed or unsupported foreign marker is retained without granting a layout promise. */
const collectStructLayout = (
  context: Context,
  header: Extract<AuthoredHir.DeclarationHeader, { readonly _tag: 'StructHeader' }>,
): {
  readonly fact: StructFact['layout']
  readonly diagnostics: ReadonlyArray<Diagnostic.Located>
} => {
  const marker = header.abi
  if (marker === undefined) return { fact: { _tag: 'Silk' }, diagnostics: noDiagnostics }
  const abiSpan = context.spanOf(marker.anchor)
  const abi = literalText(context, marker)
  if (abi === undefined)
    return {
      fact: { _tag: 'InvalidForeign', abi: undefined, abiSpan },
      diagnostics: noDiagnostics,
    }
  if (abi === 'C')
    return {
      fact: { _tag: 'Foreign', abi, abiSpan },
      diagnostics: noDiagnostics,
    }
  return {
    fact: { _tag: 'InvalidForeign', abi, abiSpan },
    diagnostics: [Diagnostic.unsupportedForeignAbi(abi, Location.at(marker.anchor))],
  }
}

/** The header shapes a foreign or exported function may not carry, with the written wording. */
const foreignRestrictions = (
  context: Context,
  contract: AuthoredHir.CallableContract,
  body: AuthoredHir.DeclarationBody,
  direction: 'Foreign' | 'Export',
): ReadonlyArray<readonly [detail: string, anchor: AuthoredHir.Anchor]> => {
  const found: Array<readonly [string, AuthoredHir.Anchor]> = []
  if (contract.static) found.push(['static', contract.staticAnchor ?? contract.anchor])
  if (contract.effect) found.push(['effect', contract.effectAnchor ?? contract.anchor])
  // An exported header may still bind lifetimes; any other binder is rejected.
  const rejectedBinders =
    direction === 'Export'
      ? contract.generics.filter((generic) => generic._tag !== 'LifetimeParameter')
      : contract.generics
  if (rejectedBinders.length > 0)
    found.push([
      'type parameters',
      // The whole written list is the subject only when every binder in it is rejected; an export
      // that keeps its lifetimes must point at the first offending binder instead.
      (rejectedBinders.length === contract.generics.length
        ? contract.genericsAnchor
        : rejectedBinders[0]?.anchor) ??
        rejectedBinders[0]?.anchor ??
        contract.anchor,
    ])
  if (contract.failures !== undefined)
    found.push(['failure row', contract.failuresAnchor ?? contract.failures.anchor])
  if (contract.requirements !== undefined)
    found.push(['requirement row', contract.requirements.anchor])
  if (contract.constraints.length > 0)
    found.push([
      'where clause',
      contract.constraintsAnchor ?? contract.constraints[0]?.anchor ?? contract.anchor,
    ])
  if (direction === 'Foreign' && body._tag === 'CallableBody' && body.block !== undefined)
    found.push(['body', body.block.anchor])
  if (direction === 'Export' && contract.unsafe)
    found.push(['unsafe', contract.unsafeAnchor ?? contract.anchor])
  return found
}

/**
 * The header checks shared by `extern` and `export` functions: ABI, the mandatory `unsafe` on a
 * foreign header, retained Silk-only shapes, and the native symbol. Type admission needs resolved
 * types and runs at completion.
 */
const collectForeign = (
  context: Context,
  declaration: AuthoredHir.Declaration,
  header: Extract<AuthoredHir.DeclarationHeader, { readonly _tag: 'FunctionHeader' }>,
  name: DeclaredName,
  direction: 'Foreign' | 'Export',
  parameters: ReadonlyArray<ParameterFact>,
): {
  readonly fact: NonNullable<DeclarationFact['foreign']>
  readonly diagnostics: ReadonlyArray<Diagnostic.Located>
} => {
  const diagnostics: Array<Diagnostic.Located> = []
  const contract = header.contract
  const declarationSpan = Location.at(name._tag === 'Present' ? name.anchor : header.anchor)
  const spellingOf = name._tag === 'Present' ? name.spelling : '#foreign'
  if (contract.variadic && (direction !== 'Foreign' || parameters.length === 0))
    diagnostics.push(
      Diagnostic.foreignDeclarationRestriction(
        'ellipsis requires an external C declaration with at least one fixed parameter',
        Location.at(contract.anchor),
      ),
    )
  const linkage = header.linkage
  if (linkage !== undefined) {
    const abi = literalText(context, linkage.abi)
    if (linkage.abi._tag === 'TextLiteral' && abi !== 'C')
      diagnostics.push(Diagnostic.unsupportedForeignAbi(abi ?? '', Location.at(linkage.abi.anchor)))
  }
  if (direction === 'Foreign' && !contract.unsafe)
    diagnostics.push(Diagnostic.foreignFunctionRequiresUnsafe(spellingOf, declarationSpan))
  const machine = MachineFunction.analyze(context, declaration)
  const foreignClause = header.properties.some(
    (clause) => DeclarationProperty.authoredOwner(context, clause) === 'Intrinsic.foreign',
  )
  for (const [detail, anchor] of foreignRestrictions(
    context,
    contract,
    declaration.body,
    direction,
  )) {
    // An exported machine or explicitly-contracted function carries its own safety promise.
    if (
      direction === 'Export' &&
      detail === 'unsafe' &&
      (machine.properties !== undefined || foreignClause)
    )
      continue
    diagnostics.push(Diagnostic.foreignDeclarationRestriction(detail, Location.at(anchor)))
  }
  const renamed = linkage?.symbol === undefined ? undefined : literalText(context, linkage.symbol)
  const symbol = renamed ?? spellingOf
  const symbolSpan =
    renamed === undefined || linkage?.symbol === undefined
      ? declarationSpan
      : Location.at(linkage.symbol.anchor)
  if (!ForeignSymbol.isValidSpelling(symbol))
    diagnostics.push(Diagnostic.invalidForeignSymbol(symbol, symbolSpan))
  else if (ForeignSymbol.isReserved(symbol))
    diagnostics.push(Diagnostic.reservedForeignSymbol(symbol, symbolSpan))
  const behavior = ForeignContract.analyze(
    context,
    header.properties.find(
      (clause) =>
        !['Intrinsic.native', 'Intrinsic.machine'].includes(
          DeclarationProperty.authoredOwner(context, clause),
        ),
    ),
    parameters.map((parameter) => ({
      name: parameter.name._tag === 'Present' ? parameter.name.spelling : '',
      type: undefined,
      at: Location.at(parameter.anchor),
    })),
    undefined,
  )
  if (
    direction === 'Export' &&
    ForeignContract.key(behavior.contract) !== ForeignContract.key(ForeignContract.conservative) &&
    !contract.unsafe
  )
    diagnostics.push(
      Diagnostic.foreignDeclarationRestriction(
        'stronger exported foreign contracts require unsafe export',
        Location.at(header.anchor),
      ),
    )
  diagnostics.push(...behavior.diagnostics)
  return {
    fact: {
      abi: 'C' as const,
      symbol,
      contract: behavior.contract,
      variadic: contract.variadic,
    },
    diagnostics: diagnostics,
  }
}

/** Collects the ABI and symbol spelling shared by imported and exported data declarations. */
const collectForeignStatic = (
  context: Context,
  header: Extract<AuthoredHir.DeclarationHeader, { readonly _tag: 'StaticHeader' }>,
  name: DeclaredName,
): {
  readonly fact: ForeignStaticFact['foreign']
  readonly diagnostics: ReadonlyArray<Diagnostic.Located>
} => {
  const diagnostics: Array<Diagnostic.Located> = []
  const declarationSpan = Location.at(name._tag === 'Present' ? name.anchor : header.anchor)
  const spellingOf = name._tag === 'Present' ? name.spelling : '#foreign-static'
  const linkage = header.linkage
  const abi = literalText(context, linkage.abi)
  if (linkage.abi._tag === 'TextLiteral' && abi !== 'C')
    diagnostics.push(Diagnostic.unsupportedForeignAbi(abi ?? '', Location.at(linkage.abi.anchor)))
  const renamed = linkage.symbol === undefined ? undefined : literalText(context, linkage.symbol)
  const symbol = renamed ?? spellingOf
  const symbolSpan =
    renamed === undefined || linkage.symbol === undefined
      ? declarationSpan
      : Location.at(linkage.symbol.anchor)
  if (!ForeignSymbol.isValidSpelling(symbol))
    diagnostics.push(Diagnostic.invalidForeignSymbol(symbol, symbolSpan))
  else if (ForeignSymbol.isReserved(symbol))
    diagnostics.push(Diagnostic.reservedForeignSymbol(symbol, symbolSpan))
  return {
    fact: { abi: 'C' as const, symbol },
    diagnostics: diagnostics,
  }
}

/** The declaration kinds that occupy an ordinal in the module's own declaration sequence. */
const isOwnDeclaration = (header: AuthoredHir.DeclarationHeader): boolean =>
  header._tag === 'FunctionHeader' ||
  header._tag === 'StructHeader' ||
  header._tag === 'TupleHeader' ||
  header._tag === 'EnumHeader' ||
  header._tag === 'UnionHeader' ||
  header._tag === 'ServiceHeader' ||
  header._tag === 'InterfaceHeader' ||
  header._tag === 'RoleHeader' ||
  header._tag === 'ConstantHeader' ||
  header._tag === 'PackageParameterHeader' ||
  header._tag === 'StaticHeader' ||
  header._tag === 'AliasHeader'

/** The members an impl declaration owns, flattened through any nested conditional group. */
const implMembers = (
  declaration: AuthoredHir.Declaration,
): ReadonlyArray<AuthoredHir.Declaration> =>
  declaration.body._tag === 'MembersBody' ? declaration.body.members : []

/** A function header's linkage direction, which distinguishes `extern` from `export`. */
const linkageDirection = (
  header: AuthoredHir.DeclarationHeader,
): 'Import' | 'Export' | undefined =>
  'linkage' in header && header.linkage !== undefined ? header.linkage.direction : undefined

const collectModule = (module: ModuleClosure.Module): ModuleHeaders => {
  const context = SemanticContext.make(module.authored)
  const lowered = module.authored
  const moduleName = context.module.owner.module
  const declarations = module.declarations
  const own = declarations.filter((declaration) => isOwnDeclaration(declaration.header))
  const first = new Map<string, { readonly id: CanonicalId; readonly anchor: AuthoredHir.Anchor }>()
  const diagnostics: Array<Diagnostic.Located> = []
  const implDeclarations = declarations.filter(
    (declaration) => declaration.header._tag === 'ImplHeader',
  )
  const implHeaderOf = (declaration: AuthoredHir.Declaration) =>
    declaration.header._tag === 'ImplHeader' ? declaration.header : undefined
  const conformances = implDeclarations
    .filter((declaration) => implHeaderOf(declaration)?.target !== undefined)
    .map((declaration, ordinal): ConformanceFact => {
      const header = implHeaderOf(declaration)
      if (header === undefined) throw new RangeError('Conformance head lost its impl header')
      const collected = collectTypeParameters(
        context,
        declaration,
        header.generics,
        `impl#${ordinal}`,
      )
      diagnostics.push(...collected.diagnostics)
      const selfType = Type.parameter({ module: moduleName, name: `impl#${ordinal}` }, -1, 'Self')
      const environment = new Map(collected.environment)
      environment.set('Self', selfType)
      const capability = analyzeDeclaredType(context, header.subject, environment).fact
      const provider =
        header.target === undefined
          ? unavailable(header.anchor)
          : analyzeDeclaredType(context, header.target, environment).fact
      const headConstraints = collectConstraints(context, header.constraints, environment)
      diagnostics.push(...headConstraints.diagnostics)
      // A binder's bound is re-analyzed here rather than reused from the parameter collection,
      // because a conditional requirement may name any binder the header declares — including the
      // one it bounds — and only the completed environment can resolve those occurrences.
      const requirements = collected.facts.flatMap(
        (parameter): ReadonlyArray<ConformanceRequirementFact> => {
          if (parameter.duplicateOf !== undefined) return []
          return parameter.bounds.flatMap((bound) => {
            const application = bound._tag === 'UnresolvedBound' ? bound.application : undefined
            if (application === undefined) return []
            return {
              _tag: 'ConformanceRequirement' as const,
              parameter: parameter.type,
              spelling: bound.spelling,
              capability: application,
              anchor: bound.path.anchor,
            }
          })
        },
      )
      const members = implMembers(declaration)
      const mappedOperations = members.flatMap((member) => {
        if (member.header._tag !== 'ImplAliasHeader') return []
        const path = typePathOf(context, member.header.target)
        return [
          {
            name: declaredName(context, member.header.name),
            target: path ?? { _tag: 'Unavailable' as const, anchor: member.header.anchor },
            form: 'Mapped' as const,
            anchor: member.header.anchor,
          },
        ]
      })
      const providerSegment =
        header.target === undefined ? undefined : firstSegment(context, header.target)
      const inlineOperations = members.flatMap(
        (member): ReadonlyArray<ConformanceFact['operations'][number]> => {
          if (member.header._tag !== 'FunctionHeader') return []
          if (isDropHook(context, member.header)) return []
          const name = declaredName(context, member.header.name)
          if (name._tag !== 'Present' || providerSegment === undefined)
            return [
              {
                name,
                target: {
                  _tag: 'Unavailable' as const,
                  anchor: member.header.anchor,
                },
                form: 'Inline' as const,
                anchor: member.header.anchor,
              },
            ]
          const targetName = `impl@${ordinal}.${name.spelling}`
          return [
            {
              name,
              target: {
                _tag: 'TypePath' as const,
                spelling: `${providerSegment.spelling}.${targetName}`,
                segments: [
                  {
                    spelling: providerSegment.spelling,
                    anchor: providerSegment.anchor,
                  },
                  { spelling: targetName, anchor: name.anchor },
                ],
                anchor: member.header.anchor,
              },
              form: 'Inline' as const,
              anchor: member.header.anchor,
            },
          ]
        },
      )
      const hookDeclaration = members.find(
        (member) => member.header._tag === 'FunctionHeader' && isDropHook(context, member.header),
      )
      const hook =
        hookDeclaration === undefined || hookDeclaration.header._tag !== 'FunctionHeader'
          ? undefined
          : (() => {
              const hookHeader = hookDeclaration.header
              const hookLifetimes = DeclarationLifetime.forHeader(
                context,
                { module: moduleName, name: `drop@impl#${ordinal}` },
                hookDeclaration,
                environment,
              )
              const parameter = hookHeader.contract.parameters.at(0)
              const failure = collectFailureRow(
                context,
                hookHeader.contract.failures,
                environment,
                hookLifetimes,
              )
              const requirementRow = collectRequirementRow(
                context,
                hookHeader.contract.requirements,
                environment,
                hookLifetimes,
              )
              diagnostics.push(...failure.diagnostics, ...requirementRow.diagnostics)
              return {
                _tag: 'DropHookDeclaration' as const,
                name: {
                  _tag: 'Present' as const,
                  spelling: 'drop',
                  anchor: hookHeader.name.anchor,
                },
                functionKind: hookHeader.contract.effect
                  ? ('Effect' as const)
                  : ('Ordinary' as const),
                typeParameterCount: hookHeader.contract.generics.length,
                parameterCount: hookHeader.contract.parameters.length,
                parameterName:
                  parameter === undefined
                    ? { _tag: 'Unavailable' as const, anchor: hookHeader.anchor }
                    : declaredName(context, parameter.name),
                parameterType:
                  parameter === undefined
                    ? unavailable(hookHeader.anchor)
                    : analyzeDeclaredType(
                        context,
                        parameter.type,
                        environment,
                        false,
                        hookLifetimes,
                      ).fact,
                returnType:
                  hookHeader.contract.result === undefined
                    ? unavailable(hookHeader.anchor)
                    : analyzeDeclaredType(
                        context,
                        hookHeader.contract.result,
                        environment,
                        false,
                        hookLifetimes,
                      ).fact,
                failureRow: failure.fact,
                requirementRow: requirementRow.fact,
                anchor: hookHeader.anchor,
              }
            })()
      return {
        _tag: 'ConformanceDeclaration',
        lifetimeElaboration: collected.lifetimeContext,
        module: moduleName,
        ordinal,
        self: selfType,
        typeParameters: collected.facts,
        requirements: requirements,
        constraints: headConstraints.facts,
        constraintContracts: [],
        capability,
        provider,
        visibility: 'Public',
        operations: [...mappedOperations, ...inlineOperations],
        ...(hook === undefined ? {} : { hook }),
        // Coherence and termination are program-wide questions, so both stay unanswered until
        // every module's headers have resolved.
        coherence: { _tag: 'Coherent' as const },
        termination: { _tag: 'UnavailableTermination' as const },
        validity: { _tag: 'UncheckedConformance' as const },
        anchor: header.anchor,
      }
    })
  let nestedDeclarationOrdinal = own.length
  const ownMembers = own.map((declaration, ordinal): MemberFact => {
    const header = declaration.header
    const id: DeclarationId = {
      _tag: 'DeclarationId',
      sourceId: moduleName,
      ordinal,
    }
    const name = headerName(context, header)
    let canonical: CanonicalState
    if (name._tag !== 'Present') canonical = { _tag: 'Unidentified' }
    else {
      const original = first.get(name.spelling)
      if (original === undefined) {
        const canonicalId: CanonicalId = {
          _tag: 'CanonicalDeclarationId',
          module: moduleName,
          name: name.spelling,
        }
        first.set(name.spelling, { id: canonicalId, anchor: name.anchor })
        canonical = { _tag: 'Canonical', id: canonicalId }
      } else {
        const diagnostic = Diagnostic.duplicateDeclarationName(
          name.spelling,
          Location.at(original.anchor),
          Location.at(name.anchor),
        )
        diagnostics.push(diagnostic)
        canonical = {
          _tag: 'Duplicate',
          original: original.id,
          cause: Diagnostic.identity(diagnostic),
        }
      }
    }
    const visibility: 'Private' | 'Public' =
      'public' in header && header.public ? 'Public' : 'Private'
    const generics = headerGenerics(header)
    const typeParameters = collectTypeParameters(
      context,
      declaration,
      generics,
      name._tag === 'Present' ? name.spelling : `#${ordinal}`,
    )
    diagnostics.push(...typeParameters.diagnostics)
    if (header._tag === 'AliasHeader') {
      // A parameterized alias is rejected as a whole, so its target is never analyzed: analyzing
      // it would only report the parameters it names as unknown types on top of the rejection.
      const parameterized = header.generics.length > 0
      const target = parameterized
        ? unavailableResolution(header.anchor)
        : analyzeDeclaredType(context, header.target)
      diagnostics.push(...target.diagnostics)
      return {
        _tag: 'AliasDeclaration',
        id,
        canonical,
        visibility,
        typeParameters: [],
        name,
        target: target.fact,
        ...(parameterized ? { parameterList: header.generics[0]?.anchor ?? header.anchor } : {}),
        anchor: header.anchor,
      }
    }
    if (header._tag === 'ConstantHeader' || header._tag === 'PackageParameterHeader') {
      const declaredType =
        header.type === undefined
          ? unavailableResolution(header.anchor)
          : analyzeDeclaredType(context, header.type)
      diagnostics.push(...declaredType.diagnostics)
      const body = declaration.body
      const initializer = declaredInitializer(body)
      const predicate = body._tag === 'PackageParameterBody' ? body.validation : undefined
      const initializerExpression = initializer ?? missingExpression(header.anchor)
      const base = {
        id,
        canonical,
        visibility,
        typeParameters: [],
        name,
        declaredType: declaredType.fact,
        initializerTemplate: staticExpressionTemplate(lowered, declaration, initializerExpression),
        literal:
          header._tag === 'PackageParameterHeader'
            ? { _tag: 'Unavailable' as const, anchor: initializerExpression.anchor }
            : constantLiteral(context, initializerExpression),
        initializer: initializerExpression,
        anchor: header.anchor,
      }
      return header._tag === 'PackageParameterHeader'
        ? {
            ...base,
            _tag: 'PackageParameterDeclaration',
            hasDefault: initializer !== undefined,
            ...(predicate === undefined
              ? {}
              : {
                  predicate,
                  predicateTemplate: staticExpressionTemplate(lowered, declaration, predicate),
                }),
          }
        : { ...base, _tag: 'ConstantDeclaration' }
    }
    if (header._tag === 'StaticHeader') {
      const declaredType = analyzeDeclaredType(context, header.type)
      const foreign = collectForeignStatic(context, header, name)
      diagnostics.push(...declaredType.diagnostics, ...foreign.diagnostics)
      const initializer =
        declaration.body._tag === 'InitializerBody' ? declaration.body.value : undefined
      return {
        _tag: 'ForeignStaticDeclaration',
        id,
        canonical,
        visibility: 'Private',
        typeParameters: [],
        name,
        direction: header.linkage.direction,
        foreign: foreign.fact,
        declaredType: declaredType.fact,
        ...(initializer === undefined
          ? {}
          : {
              initializerTemplate: staticExpressionTemplate(lowered, declaration, initializer),
              literal: constantLiteral(context, initializer),
              initializer,
            }),
        anchor: header.anchor,
      }
    }
    if (header._tag === 'RoleHeader')
      return {
        _tag: 'RoleDeclaration',
        id,
        canonical,
        visibility,
        typeParameters: [],
        name,
        anchor: header.anchor,
      }
    if (header._tag === 'EnumHeader')
      return collectEnum(context, declaration, header, id, canonical, visibility, name, diagnostics)
    if (header._tag === 'UnionHeader')
      return collectUnion(
        context,
        declaration,
        header,
        id,
        canonical,
        visibility,
        name,
        typeParameters,
        diagnostics,
      )
    if (header._tag === 'StructHeader') {
      const layout = collectStructLayout(context, header)
      const collected = collectFields(
        context,
        header.fields,
        { _tag: 'StructFieldOwnerId', declaration: id },
        typeParameters.environment,
        typeParameters.lifetimeContext,
      )
      diagnostics.push(...layout.diagnostics, ...collected.diagnostics)
      return {
        _tag: 'StructDeclaration',
        lifetimeElaboration: typeParameters.lifetimeContext,
        id,
        canonical,
        visibility,
        layout: layout.fact,
        typeParameters: typeParameters.facts,
        ...(header.genericsAnchor === undefined
          ? {}
          : { typeParametersAnchor: header.genericsAnchor }),
        name,
        ...(name._tag === 'Present'
          ? { identity: AggregateIdentity.source(moduleName, name.spelling, 'Named') }
          : {}),
        aggregateKind: 'Named',
        fields: collected.fields,
        dependency: { _tag: 'Available', types: [] },
        anchor: header.anchor,
      }
    }
    if (header._tag === 'TupleHeader') {
      const collected = collectPositionalFields(
        context,
        header.elements,
        { _tag: 'StructFieldOwnerId', declaration: id },
        typeParameters.environment,
        typeParameters.lifetimeContext,
      )
      diagnostics.push(...collected.diagnostics)
      return {
        _tag: 'StructDeclaration',
        lifetimeElaboration: typeParameters.lifetimeContext,
        id,
        canonical,
        visibility,
        layout: { _tag: 'Silk' },
        typeParameters: typeParameters.facts,
        name,
        ...(name._tag === 'Present'
          ? { identity: AggregateIdentity.source(moduleName, name.spelling, 'Positional') }
          : {}),
        aggregateKind: 'Positional',
        fields: collected.fields,
        dependency: { _tag: 'Available', types: [] },
        anchor: header.anchor,
      }
    }
    if (header._tag === 'ServiceHeader' || header._tag === 'InterfaceHeader') {
      const ownerName = name._tag === 'Present' ? name.spelling : `#${ordinal}`
      const selfType = Type.parameter({ module: moduleName, name: ownerName }, -1, 'Self')
      const contractEnvironment = new Map(typeParameters.environment)
      contractEnvironment.set('Self', selfType)
      const operationFirst = new Map<
        string,
        { readonly id: ServiceOperationId; readonly anchor: AuthoredHir.Anchor }
      >()
      const operationDeclarations = implMembers(declaration).filter(
        (member) => member.header._tag === 'OperationHeader',
      )
      const operations = operationDeclarations.map(
        (operation, operationOrdinal): ServiceOperationFact => {
          const operationHeader = operation.header
          if (operationHeader._tag !== 'OperationHeader')
            throw new RangeError('Service operation lost its operation header')
          const operationId: DeclarationId = {
            _tag: 'DeclarationId',
            sourceId: moduleName,
            ordinal: nestedDeclarationOrdinal,
          }
          nestedDeclarationOrdinal += 1
          const operationName = declaredName(context, operationHeader.name)
          let operationState: ServiceOperationState
          if (operationName._tag !== 'Present') {
            operationState = { _tag: 'Unidentified' }
          } else {
            const original = operationFirst.get(operationName.spelling)
            if (original === undefined) {
              const serviceOperationId: ServiceOperationId = {
                _tag: 'ServiceOperationId',
                service: id,
                name: operationName.spelling,
              }
              operationFirst.set(operationName.spelling, {
                id: serviceOperationId,
                anchor: operationName.anchor,
              })
              operationState = { _tag: 'Unique', id: serviceOperationId }
            } else {
              const diagnostic = Diagnostic.duplicateDeclarationName(
                operationName.spelling,
                Location.at(original.anchor),
                Location.at(operationName.anchor),
              )
              diagnostics.push(diagnostic)
              operationState = {
                _tag: 'Duplicate',
                original: original.id,
                cause: Diagnostic.identity(diagnostic),
              }
            }
          }
          const operationTypeParameters = collectTypeParameters(
            context,
            operation,
            operationHeader.contract.generics,
            `${ownerName}.$${operationOrdinal}`,
            typeParameters.facts.length,
            typeParameters.facts,
          )
          diagnostics.push(...operationTypeParameters.diagnostics)
          const environment = new Map<string, Type.Parameter>([
            ...contractEnvironment,
            ...operationTypeParameters.environment,
          ])
          const parameters = operationHeader.contract.parameters.map(
            (parameter, parameterOrdinal) =>
              analyzeParameter(
                context,
                parameter,
                operationId,
                parameterOrdinal,
                environment,
                operationTypeParameters.lifetimeContext,
              ),
          )
          const result = operationHeader.contract.result
          const returnType: {
            readonly fact: ReturnTypeFact
            readonly opaqueResult?: OpaqueResultFact
            readonly diagnostics: ReadonlyArray<Diagnostic.Located>
          } =
            result === undefined
              ? {
                  fact: {
                    _tag: 'Resolved' as const,
                    type: Type.unit,
                    spelling: '()',
                    anchor: operationHeader.contract.anchor,
                  },
                  diagnostics: noDiagnostics,
                }
              : collectReturnType(
                  context,
                  operation,
                  result,
                  `${ownerName}.$${operationOrdinal}`,
                  [...typeParameters.facts, ...operationTypeParameters.facts],
                  contractEnvironment,
                  operationTypeParameters.lifetimeContext,
                )
          const failureRow = collectFailureRow(
            context,
            operationHeader.contract.failures,
            environment,
            operationTypeParameters.lifetimeContext,
          )
          const requirementRow = collectRequirementRow(
            context,
            operationHeader.contract.requirements,
            environment,
            operationTypeParameters.lifetimeContext,
          )
          const constraints = collectConstraints(
            context,
            operationHeader.contract.constraints,
            environment,
          )
          const parameterFacts = parameters.map((parameter) => parameter.fact)
          const functionKind = operationHeader.contract.effect
            ? ('Effect' as const)
            : ('Ordinary' as const)
          const validNonParking = operationHeader.properties.filter((clause) => {
            const owner = DeclarationProperty.authoredOwner(context, clause)
            if (owner !== 'Intrinsic.nonParking') {
              diagnostics.push(
                Diagnostic.invalidServiceDeclaration(
                  `unsupported operation property ${owner || '<missing>'}`,
                  Location.at(clause.anchor),
                ),
              )
              return false
            }
            if (clause.properties.length > 0) {
              diagnostics.push(
                Diagnostic.invalidServiceDeclaration(
                  'Intrinsic.nonParking takes no arguments on an operation',
                  Location.at(clause.anchor),
                ),
              )
              return false
            }
            if (functionKind !== 'Effect') {
              diagnostics.push(
                Diagnostic.invalidServiceDeclaration(
                  'Intrinsic.nonParking applies only to effect operations',
                  Location.at(clause.anchor),
                ),
              )
              return false
            }
            return true
          })
          for (const duplicate of validNonParking.slice(1))
            diagnostics.push(
              Diagnostic.invalidServiceDeclaration(
                'duplicate Intrinsic.nonParking operation property',
                Location.at(duplicate.anchor),
              ),
            )
          const staticProperties: ReadonlyArray<Type.SealedStaticProperty> =
            validNonParking.length === 0 ? [] : ['Intrinsic.NonParking']
          const operatorName = operationHeader.operator
          const operatorSpelling =
            operatorName === undefined ? undefined : nameText(context, operatorName)
          const selectedOperator =
            operatorSpelling === undefined
              ? undefined
              : eligibleOperator(operatorSpelling, parameterFacts.length)
          diagnostics.push(
            ...parameters.flatMap((parameter) => parameter.diagnostics),
            ...duplicateParameterDiagnostics(context, parameterFacts),
            ...returnType.diagnostics,
            ...failureRow.diagnostics,
            ...requirementRow.diagnostics,
            ...constraints.diagnostics,
          )
          if (operatorName !== undefined) {
            let detail: string | undefined
            if (header._tag !== 'InterfaceHeader') {
              detail = 'only interface operations may declare an operator'
            } else if (
              operationTypeParameters.facts.some((parameter) => parameter.type.kind !== 'Lifetime')
            ) {
              detail = 'operator operations cannot declare operation-local value or row parameters'
            } else if (selectedOperator === undefined) {
              detail = `${operatorSpelling ?? 'the marker'} is not an eligible ${parameterFacts.length}-operand operator`
            } else {
              detail = undefined
            }
            if (detail !== undefined)
              diagnostics.push(
                Diagnostic.invalidOperatorContract(detail, Location.at(operatorName.anchor)),
              )
          }
          if (operation.body._tag === 'CallableBody' && operation.body.block !== undefined)
            diagnostics.push(
              Diagnostic.invalidServiceDeclaration(
                'service operations declare contracts and cannot contain bodies',
                Location.at(operation.body.block.anchor),
              ),
            )
          if (!operationHeader.contract.effect && failureRow.fact.anchor !== undefined)
            diagnostics.push(
              Diagnostic.failureChannelOnOrdinary(Location.at(failureRow.fact.anchor)),
            )
          return {
            _tag: 'ServiceOperation',
            id: operationId,
            state: operationState,
            functionKind,
            unsafe: operationHeader.contract.unsafe,
            staticProperties,
            typeParameters: operationTypeParameters.facts,
            lifetimeElaboration: {
              ...operationTypeParameters.lifetimeContext,
              parameters: new Map([
                ...operationTypeParameters.lifetimeContext.parameters,
                ...contractEnvironment,
              ]),
            },
            parameterCount: parameterFacts.length,
            parameters: parameterFacts,
            ...(operatorName !== undefined &&
            selectedOperator !== undefined &&
            header._tag === 'InterfaceHeader' &&
            operationTypeParameters.facts.every((parameter) => parameter.type.kind === 'Lifetime')
              ? {
                  operator: {
                    operator: selectedOperator,
                    anchor: operatorName.anchor,
                  },
                }
              : {}),
            name: operationName,
            returnType: returnType.fact,
            ...(returnType.opaqueResult === undefined
              ? {}
              : { opaqueResult: returnType.opaqueResult }),
            failureRow: failureRow.fact,
            requirementRow: requirementRow.fact,
            constraints: constraints.facts,
            constraintContracts: [],
            anchor: operationHeader.anchor,
          }
        },
      )
      const shared = {
        id,
        canonical,
        visibility,
        self: selfType,
        typeParameters: typeParameters.facts,
        name,
        operations: operations,
        anchor: header.anchor,
      }
      const contract =
        header._tag === 'InterfaceHeader'
          ? {
              _tag: 'InterfaceDeclaration' as const,
              dependencyEligible: false as const,
              ...shared,
            }
          : {
              _tag: 'ServiceDeclaration' as const,
              dependencyEligible: true as const,
              ...shared,
            }
      return {
        ...contract,
        operationContracts: interfaceOperationContracts(contract, operations),
      }
    }
    if (header._tag !== 'FunctionHeader')
      throw new RangeError(`Declaration collection reached an unexpected header ${header._tag}`)
    const contract = header.contract
    const parameters = contract.parameters.map((parameter, parameterOrdinal) =>
      analyzeParameter(
        context,
        parameter,
        id,
        parameterOrdinal,
        typeParameters.environment,
        typeParameters.lifetimeContext,
      ),
    )
    const returnType: {
      readonly fact: ReturnTypeFact
      readonly opaqueResult?: OpaqueResultFact
      readonly diagnostics: ReadonlyArray<Diagnostic.Located>
    } =
      contract.result === undefined
        ? {
            fact: {
              _tag: 'Resolved' as const,
              type: Type.unit,
              spelling: '()',
              anchor: contract.anchor,
            },
            diagnostics: noDiagnostics,
          }
        : collectReturnType(
            context,
            declaration,
            contract.result,
            name._tag === 'Present' ? name.spelling : `#${ordinal}`,
            typeParameters.facts,
            new Map(),
            typeParameters.lifetimeContext,
          )
    const functionKind = contract.effect ? 'Effect' : 'Ordinary'
    const failureRow = collectFailureRow(
      context,
      contract.failures,
      typeParameters.environment,
      typeParameters.lifetimeContext,
    )
    const requirementRow = collectRequirementRow(
      context,
      contract.requirements,
      typeParameters.environment,
      typeParameters.lifetimeContext,
    )
    const constraints = collectConstraints(
      context,
      contract.constraints,
      typeParameters.environment,
    )
    const staticFunction = contract.static
    const facts = parameters.map((parameter) =>
      staticFunction && parameter.fact.phase !== 'Static'
        ? { ...parameter.fact, phase: 'Static' as const }
        : parameter.fact,
    )
    diagnostics.push(
      ...parameters.flatMap((parameter) => parameter.diagnostics),
      ...duplicateParameterDiagnostics(context, facts),
      ...returnType.diagnostics,
      ...failureRow.diagnostics,
      ...requirementRow.diagnostics,
      ...constraints.diagnostics,
    )
    const direction = linkageDirection(header)
    if (contract.variadic && direction === undefined)
      diagnostics.push(
        Diagnostic.foreignDeclarationRestriction(
          'variadic definitions are not admitted',
          Location.at(contract.anchor),
        ),
      )
    const foreign =
      direction === 'Import'
        ? collectForeign(context, declaration, header, name, 'Foreign', facts)
        : undefined
    const foreignExport =
      direction === 'Export'
        ? collectForeign(context, declaration, header, name, 'Export', facts)
        : undefined
    const machine = MachineFunction.analyze(context, declaration)
    diagnostics.push(...machine.diagnostics)
    if (foreign !== undefined && machine.properties !== undefined)
      diagnostics.push(
        Diagnostic.foreignDeclarationRestriction(
          'machine property on a foreign import',
          Location.at(machine.properties.anchor),
        ),
      )
    const behavior = header.properties.filter(
      (clause) =>
        DeclarationProperty.authoredOwner(context, clause) !== 'Intrinsic.native' &&
        DeclarationProperty.authoredOwner(context, clause) !== 'Intrinsic.machine',
    )
    for (const property of behavior.slice(1))
      diagnostics.push(
        Diagnostic.foreignDeclarationRestriction(
          'duplicate foreign contract',
          Location.at(property.anchor),
        ),
      )
    for (const property of header.properties)
      if (
        foreign === undefined &&
        foreignExport === undefined &&
        DeclarationProperty.authoredOwner(context, property) !== 'Intrinsic.machine'
      )
        diagnostics.push(
          Diagnostic.foreignDeclarationRestriction(
            'foreign contract on a non-foreign function',
            Location.at(property.anchor),
          ),
        )
    const native = foreign ?? foreignExport
    if (native === undefined && functionKind === 'Ordinary' && failureRow.fact.anchor !== undefined)
      diagnostics.push(Diagnostic.failureChannelOnOrdinary(Location.at(failureRow.fact.anchor)))
    if (native !== undefined) diagnostics.push(...native.diagnostics)
    const retainedBody =
      foreign === undefined ? bodyTemplate(lowered, declaration, staticFunction) : undefined
    return {
      _tag: 'FunctionDeclaration',
      lifetimeElaboration: typeParameters.lifetimeContext,
      id,
      canonical,
      visibility,
      phase: foreign === undefined && staticFunction ? 'Static' : 'Runtime',
      functionKind: foreign === undefined ? functionKind : 'Ordinary',
      test: contract.test,
      ...(contract.testAnchor === undefined ? {} : { testAnchor: contract.testAnchor }),
      unsafe: contract.unsafe,
      ...(machine.properties === undefined ? {} : { machine: machine.properties }),
      ...(foreign === undefined ? {} : { foreign: foreign.fact }),
      // A rejected export publishes no symbol, so discovery never roots it.
      ...(foreignExport === undefined || foreignExport.diagnostics.length > 0
        ? {}
        : { foreignExport: foreignExport.fact }),
      typeParameters: typeParameters.facts,
      parameterCount: facts.length,
      parameters: facts,
      name,
      // A rejected foreign or exported header withholds its result so no callable contract is
      // published and call sites get the ordinary unavailable-contract behavior instead of
      // repeated errors.
      returnType:
        native !== undefined && native.diagnostics.length > 0
          ? unavailable(returnType.fact.anchor)
          : returnType.fact,
      ...(returnType.opaqueResult === undefined ? {} : { opaqueResult: returnType.opaqueResult }),
      failureRow: failureRow.fact,
      requirementRow: requirementRow.fact,
      constraints: constraints.facts,
      constraintContracts: [],
      ...(retainedBody === undefined ? {} : { bodyTemplate: retainedBody }),
      owner: declaration.owner,
      anchor: header.anchor,
    }
  })
  // Owner binders precede the member's own, so `Option.map<i32, i64>` reads T then U; a binder
  // the member refined carries the member's bounds under the head's identity.
  // An owner binder joins the member's generic sequence only when the member mentions it (or
  // names `Self`, which stands for the whole applied owner); a member that never mentions one
  // (`Fiber.cancel(canceller: CompletionCanceller)`) would otherwise carry a binder no call
  // could ever infer.
  const joinedTypeParameters = (
    member: AuthoredHir.Declaration,
    headBinders: ReadonlyArray<TypeParameterFact>,
    built: Pick<DeclarationFact, 'typeParameters'>,
    refinedBinders: ReadonlyMap<string, TypeParameterFact>,
  ): ReadonlyArray<TypeParameterFact> => {
    const mentioned = mentionedNames(context, member)
    const namesSelf = mentioned.has('Self')
    return [
      ...headBinders
        .filter(
          (parameter) =>
            parameter.duplicateOf === undefined &&
            (namesSelf ||
              (parameter.name._tag === 'Present' && mentioned.has(parameter.name.spelling))),
        )
        .map((parameter) => {
          const refined =
            parameter.name._tag === 'Present'
              ? refinedBinders.get(parameter.name.spelling)
              : undefined
          return refined === undefined
            ? parameter
            : {
                ...parameter,
                bounds: [...parameter.bounds, ...refined.bounds],
              }
        }),
      ...built.typeParameters,
    ]
  }
  // A function declared inside an impl block, conformance or inherent, elaborates and lowers as an
  // ordinary declaration carrying the impl's binders ahead of its own and `Self` bound to the
  // head's binder. The caller supplies identity, visibility, and the membership back-reference.
  const implMember = (
    member: AuthoredHir.Declaration,
    header: Extract<AuthoredHir.DeclarationHeader, { readonly _tag: 'FunctionHeader' }>,
    id: DeclarationId,
    ownerName: string,
    headBinders: ReadonlyArray<TypeParameterFact>,
    self: Type.Parameter,
  ): Omit<DeclarationFact, 'canonical' | 'visibility' | 'name' | 'id'> & {
    readonly refinedBinders: ReadonlyMap<string, TypeParameterFact>
  } => {
    // `Self` is in scope for the member's own binder bounds (`U: Like<Self>`) exactly as the
    // head binders are, so it rides along as a synthetic enclosing binder.
    const selfBinder: ReadonlyArray<TypeParameterFact> = [
      {
        _tag: 'TypeParameterDeclaration' as const,
        type: self,
        name: {
          _tag: 'Present' as const,
          spelling: 'Self',
          anchor: header.anchor,
        },
        anchor: header.anchor,
        bounds: [],
        staticProperties: [],
      },
    ]
    const collected = collectTypeParameters(
      context,
      member,
      header.contract.generics,
      ownerName,
      headBinders.length,
      [...headBinders, ...selfBinder],
    )
    // A member may redeclare an owner binder to refine its bounds for that member alone
    // (`fn get<K: HashKey + Copy, V: Copy>` inside `impl<K, V> HashMap<K, V>`): the binder keeps
    // the head's identity and gains the member's bounds, and no duplicate is reported.
    const refinedNames = new Set(
      collected.facts.flatMap((fact) =>
        fact.duplicateOf !== undefined &&
        fact.name._tag === 'Present' &&
        headBinders.some((binder) => binder.type === fact.duplicateOf)
          ? [fact.name.spelling]
          : [],
      ),
    )
    diagnostics.push(
      ...collected.diagnostics.filter(
        (diagnostic) =>
          !(
            diagnostic.reason._tag === 'DuplicateTypeParameter' &&
            refinedNames.has(diagnostic.reason.spelling)
          ),
      ),
    )
    const refinedBinders = new Map(
      collected.facts.flatMap((fact) =>
        fact.duplicateOf !== undefined &&
        fact.name._tag === 'Present' &&
        refinedNames.has(fact.name.spelling)
          ? [[fact.name.spelling, fact] as const]
          : [],
      ),
    )
    const ownFacts = collected.facts.filter(
      (fact) => !(fact.name._tag === 'Present' && refinedNames.has(fact.name.spelling)),
    )
    const environment = new Map(collected.environment)
    environment.set('Self', self)
    const contract = header.contract
    const parameters = contract.parameters.map((parameter, ordinal) =>
      analyzeParameter(context, parameter, id, ordinal, environment, collected.lifetimeContext),
    )
    const returnType =
      contract.result === undefined
        ? {
            fact: {
              _tag: 'Resolved' as const,
              type: Type.unit,
              spelling: '()',
              anchor: contract.anchor,
            },
            diagnostics: noDiagnostics,
          }
        : collectReturnType(
            context,
            member,
            contract.result,
            ownerName,
            collected.facts,
            environment,
            collected.lifetimeContext,
          )
    const failureRow = collectFailureRow(
      context,
      contract.failures,
      environment,
      collected.lifetimeContext,
    )
    const requirementRow = collectRequirementRow(
      context,
      contract.requirements,
      environment,
      collected.lifetimeContext,
    )
    const constraints = collectConstraints(context, contract.constraints, environment)
    const parameterFacts = parameters.map((parameter) =>
      contract.static && parameter.fact.phase !== 'Static'
        ? { ...parameter.fact, phase: 'Static' as const }
        : parameter.fact,
    )
    diagnostics.push(
      ...parameters.flatMap((parameter) => parameter.diagnostics),
      ...duplicateParameterDiagnostics(context, parameterFacts),
      ...returnType.diagnostics,
      ...failureRow.diagnostics,
      ...requirementRow.diagnostics,
      ...constraints.diagnostics,
    )
    const retainedBody = bodyTemplate(lowered, member, contract.static)
    return {
      _tag: 'FunctionDeclaration' as const,
      phase: contract.static ? ('Static' as const) : ('Runtime' as const),
      functionKind: contract.effect ? ('Effect' as const) : ('Ordinary' as const),
      test: contract.test,
      ...(contract.testAnchor === undefined ? {} : { testAnchor: contract.testAnchor }),
      unsafe: contract.unsafe,
      typeParameters: ownFacts,
      lifetimeElaboration: collected.lifetimeContext,
      refinedBinders,
      parameterCount: parameterFacts.length,
      parameters: parameterFacts,
      returnType: returnType.fact,
      ...('opaqueResult' in returnType && returnType.opaqueResult !== undefined
        ? { opaqueResult: returnType.opaqueResult }
        : {}),
      failureRow: failureRow.fact,
      requirementRow: requirementRow.fact,
      constraints: constraints.facts,
      constraintContracts: [],
      ...(retainedBody === undefined ? {} : { bodyTemplate: retainedBody }),
      owner: member.owner,
      anchor: header.anchor,
    }
  }
  // Inline conformance operations elaborate and lower as private ordinary declarations. Their
  // canonical names are implementation identities, not source-visible actor members.
  const conformanceDeclarations = implDeclarations.filter(
    (declaration) => implHeaderOf(declaration)?.target !== undefined,
  )
  const inlineMembers = conformances.flatMap(
    (conformance, conformanceIndex): ReadonlyArray<MemberFact> => {
      const head = conformanceDeclarations[conformanceIndex]
      if (head === undefined) return []
      const inlineDeclarations = implMembers(head).filter(
        (member) => member.header._tag === 'FunctionHeader' && !isDropHook(context, member.header),
      )
      return conformance.operations.flatMap(
        (operation, operationIndex): ReadonlyArray<MemberFact> => {
          if (operation.form !== 'Inline' || operation.target._tag !== 'TypePath') return []
          const targetSegment = operation.target.segments.at(1)
          if (targetSegment === undefined) return []
          const member = inlineDeclarations.find(
            (candidate) =>
              AuthoredIdentity.anchorKey(candidate.header.anchor) ===
              AuthoredIdentity.anchorKey(operation.anchor),
          )
          if (member === undefined || member.header._tag !== 'FunctionHeader') return []
          const id: DeclarationId = {
            _tag: 'DeclarationId',
            sourceId: moduleName,
            ordinal: nestedDeclarationOrdinal + conformanceIndex * 1024 + operationIndex,
          }
          const {
            bodyTemplate: _retained,
            refinedBinders,
            ...built
          } = implMember(
            member,
            member.header,
            id,
            targetSegment.spelling,
            conformance.typeParameters,
            conformance.self,
          )
          return [
            {
              ...built,
              // A generic conformance's inline body is generic in the header's binders exactly as a
              // mapped witness is; the proof that selects the witness supplies their arguments.
              typeParameters: joinedTypeParameters(
                member,
                conformance.typeParameters,
                built,
                refinedBinders,
              ),
              // The head's `where` clause is a premise of every inline body, like its binder bounds.
              constraints: [...conformance.constraints, ...built.constraints],
              id,
              canonical: {
                _tag: 'Canonical' as const,
                id: {
                  _tag: 'CanonicalDeclarationId' as const,
                  module: moduleName,
                  name: targetSegment.spelling,
                },
              },
              visibility: 'Private' as const,
              name: {
                _tag: 'Present' as const,
                spelling: targetSegment.spelling,
                anchor:
                  operation.name._tag === 'Present' ? operation.name.anchor : targetSegment.anchor,
              },
              conformanceImplementation: {
                ordinal: conformance.ordinal,
                operation:
                  operation.name._tag === 'Present'
                    ? operation.name.spelling
                    : targetSegment.spelling,
                self: conformance.self,
              },
            },
          ]
        },
      )
    },
  )
  // Inherent impls: `impl [<Binders>] Owner { fn ... }`. The head is validated structurally here
  // (whole-family arguments, unbounded binders); ownership and collisions need the resolved owner
  // and are decided at declaration completion.
  const inherentDeclarations = implDeclarations.filter(
    (declaration) => implHeaderOf(declaration)?.target === undefined,
  )
  const inherentImpls: Array<InherentImplFact> = []
  const inherentMembers: Array<DeclarationFact> = []
  inherentDeclarations.forEach((declaration, ordinal) => {
    const header = implHeaderOf(declaration)
    if (header === undefined) return
    const headName = `inherent#${ordinal}`
    const collected = collectTypeParameters(context, declaration, header.generics, headName)
    diagnostics.push(...collected.diagnostics)
    const selfType = Type.parameter({ module: moduleName, name: headName }, -1, 'Self')
    const environment = new Map(collected.environment)
    environment.set('Self', selfType)
    const ownerType = header.subject
    const owner = analyzeDeclaredType(context, ownerType, environment).fact
    const ownerPath = nominalPath(context, ownerType)
    const ownerSpelling = ownerPath?.spelling ?? ''
    const headAnchor = ownerPath?.segments.at(0)?.anchor ?? ownerType.anchor
    // Whole-family check: the applied arguments must be exactly this impl's binders, in order.
    const binders = collected.facts.filter((parameter) => parameter.duplicateOf === undefined)
    const argumentSpellings =
      ownerType._tag === 'AppliedType'
        ? ownerType.arguments.arguments.map((argument) => binderArgumentName(context, argument))
        : []
    // Completed owner arity includes omitted lifetimes and is checked during completion.
    const wholeFamily =
      argumentSpellings.length === binders.length &&
      binders.every(
        (binder, index) =>
          binder.name._tag === 'Present' && argumentSpellings[index] === binder.name.spelling,
      )
    const bounded =
      header.constraints.length > 0 ||
      binders.some((binder) => binder.bounds.length > 0 || binder.representationBound !== undefined)
    let headDiagnostic: Diagnostic.Located | undefined
    if (ownerPath === undefined || ownerPath.segments.length !== 1) {
      headDiagnostic = Diagnostic.invalidInherentHead(
        ownerSpelling || '?',
        'NotNominal',
        Location.at(headAnchor),
      )
    } else if (!wholeFamily) {
      headDiagnostic = Diagnostic.invalidInherentHead(
        ownerSpelling,
        'Specialized',
        Location.at(headAnchor),
      )
    } else if (bounded) {
      headDiagnostic = Diagnostic.invalidInherentHead(
        ownerSpelling,
        'Bounded',
        Location.at(headAnchor),
      )
    } else {
      headDiagnostic = undefined
    }
    if (headDiagnostic !== undefined) diagnostics.push(headDiagnostic)
    inherentImpls.push({
      _tag: 'InherentImplDeclaration' as const,
      lifetimeElaboration: collected.lifetimeContext,
      module: moduleName,
      ordinal,
      self: selfType,
      typeParameters: collected.facts,
      ownerSpelling,
      owner,
      validity:
        headDiagnostic === undefined
          ? { _tag: 'Valid' as const }
          : {
              _tag: 'Invalid' as const,
              cause: Diagnostic.identity(headDiagnostic),
            },
      anchor: header.anchor,
    })
    const members = implMembers(declaration)
    for (const mapped of members) {
      if (mapped.header._tag !== 'ImplAliasHeader') continue
      const name = declaredName(context, mapped.header.name)
      diagnostics.push(
        Diagnostic.invalidInherentMember(
          ownerSpelling,
          name._tag === 'Present' ? name.spelling : '?',
          'MappedOperation',
          Location.at(mapped.header.anchor),
        ),
      )
    }
    members
      .filter((member) => member.header._tag === 'FunctionHeader')
      .forEach((member, memberIndex) => {
        const memberHeader = member.header
        if (memberHeader._tag !== 'FunctionHeader') return
        const name = declaredName(context, memberHeader.name)
        if (isDropHook(context, memberHeader)) {
          diagnostics.push(
            Diagnostic.invalidInherentMember(
              ownerSpelling,
              'drop',
              'DropHook',
              Location.at(memberHeader.anchor),
            ),
          )
          return
        }
        const id: DeclarationId = {
          _tag: 'DeclarationId',
          sourceId: moduleName,
          ordinal: nestedDeclarationOrdinal + (conformances.length + ordinal) * 1024 + memberIndex,
        }
        const memberName = name._tag === 'Present' ? name.spelling : `member#${memberIndex}`
        // The member's own binders are minted under the member's identity, not the owner's, so two
        // members' `?R` binders never share one key and one member can call another with inference.
        const { refinedBinders, ...built } = implMember(
          member,
          memberHeader,
          id,
          `${ownerSpelling}.${memberName}`,
          collected.facts,
          selfType,
        )
        const shared = {
          ...built,
          typeParameters: joinedTypeParameters(member, collected.facts, built, refinedBinders),
        }
        const receiverParameter = shared.parameters.at(0)
        const receiver =
          receiverParameter !== undefined &&
          receiverParameter.name._tag === 'Present' &&
          receiverParameter.name.spelling === 'self' &&
          declaredTypeNamesOwner(receiverParameter.declaredType, selfType, ownerSpelling)
        const canonicalName = `${ownerSpelling}.${memberName}`
        inherentMembers.push({
          ...shared,
          id,
          canonical:
            headDiagnostic === undefined && name._tag === 'Present'
              ? {
                  _tag: 'Canonical' as const,
                  id: {
                    _tag: 'CanonicalDeclarationId' as const,
                    module: moduleName,
                    name: canonicalName,
                  },
                }
              : { _tag: 'Unidentified' as const },
          visibility: memberHeader.public ? ('Public' as const) : ('Private' as const),
          name,
          associatedMember: {
            ordinal,
            ownerSpelling,
            name: memberName,
            self: selfType,
            receiver,
          },
        })
      })
  })
  // A name declared twice for one owner has no winner: both facts become duplicates of the shared
  // identity, so neither is reachable and both sites are diagnosed with the other related.
  const inherentCounts = new Map<string, number>()
  for (const member of inherentMembers)
    if (member.canonical._tag === 'Canonical')
      inherentCounts.set(
        member.canonical.id.name,
        (inherentCounts.get(member.canonical.id.name) ?? 0) + 1,
      )
  const dedupedInherentMembers: ReadonlyArray<MemberFact> = inherentMembers.map((member) => {
    if (member.canonical._tag !== 'Canonical') return member
    if ((inherentCounts.get(member.canonical.id.name) ?? 0) < 2) return member
    const association = member.associatedMember
    const others = inherentMembers.filter(
      (candidate) =>
        candidate !== member &&
        candidate.canonical._tag === 'Canonical' &&
        member.canonical._tag === 'Canonical' &&
        candidate.canonical.id.name === member.canonical.id.name,
    )
    const other = others.at(0) ?? member
    const diagnostic = Diagnostic.duplicateInherentMember(
      association?.ownerSpelling ?? '?',
      association?.name ?? '?',
      Location.at(member.name._tag === 'Present' ? member.name.anchor : member.anchor),
      Location.at(other.name._tag === 'Present' ? other.name.anchor : other.anchor),
    )
    diagnostics.push(diagnostic)
    return {
      ...member,
      canonical: {
        _tag: 'Duplicate' as const,
        original: member.canonical.id,
        cause: Diagnostic.identity(diagnostic),
      },
    }
  })
  // Drop hook bodies elaborate as hidden generic functions: each accepted hook joins the member
  // list under a non-identifier canonical name, carrying the impl's type parameters, so ordinary
  // elaboration, ownership, and lowering machinery compile it without a hook-shaped special case.
  const hookMembers = conformances.flatMap((conformance, hookIndex): ReadonlyArray<MemberFact> => {
    const hook = conformance.hook
    const head = conformanceDeclarations[hookIndex]
    if (hook === undefined || head === undefined) return []
    const member = implMembers(head).find(
      (candidate) =>
        candidate.header._tag === 'FunctionHeader' && isDropHook(context, candidate.header),
    )
    if (member === undefined || member.header._tag !== 'FunctionHeader') return []
    const memberHeader = member.header
    const id: DeclarationId = {
      _tag: 'DeclarationId',
      sourceId: moduleName,
      ordinal: nestedDeclarationOrdinal + inlineMembers.length + hookIndex,
    }
    const environment = new Map<string, Type.Parameter>(
      conformance.typeParameters.flatMap((parameter) =>
        parameter.duplicateOf === undefined && parameter.name._tag === 'Present'
          ? [[parameter.name.spelling, parameter.type] as const]
          : [],
      ),
    )
    const lifetimeContext = DeclarationLifetime.forHeader(
      context,
      { module: moduleName, name: `drop@impl#${conformance.ordinal}` },
      member,
      environment,
    )
    diagnostics.push(...lifetimeContext.diagnostics)
    const parameters = memberHeader.contract.parameters.map((parameter, parameterOrdinal) =>
      analyzeParameter(context, parameter, id, parameterOrdinal, environment, lifetimeContext),
    )
    const returnType =
      memberHeader.contract.result === undefined
        ? unavailableResolution(memberHeader.anchor)
        : analyzeDeclaredType(
            context,
            memberHeader.contract.result,
            environment,
            false,
            lifetimeContext,
          )
    const facts = parameters.map((parameter) => parameter.fact)
    return [
      {
        _tag: 'FunctionDeclaration' as const,
        id,
        canonical: {
          _tag: 'Canonical' as const,
          id: {
            _tag: 'CanonicalDeclarationId' as const,
            module: moduleName,
            name: `drop@impl#${conformance.ordinal}`,
          },
        },
        visibility: 'Private' as const,
        phase: 'Runtime' as const,
        functionKind: 'Ordinary' as const,
        test: false,
        unsafe: false,
        typeParameters: conformance.typeParameters,
        parameterCount: facts.length,
        parameters: facts,
        name: hook.name,
        returnType: returnType.fact,
        failureRow: hook.failureRow,
        requirementRow: hook.requirementRow,
        constraints: [],
        constraintContracts: [],
        owner: member.owner,
        anchor: memberHeader.anchor,
      },
    ]
  })
  const nativeRequirements: Array<NativeRequirement.NativeRequirement> = []
  for (const declaration of declarations) {
    const header = declaration.header
    const moduleClause = header._tag === 'ModulePropertyHeader'
    for (const clause of headerProperties(header)) {
      if (
        !moduleClause &&
        DeclarationProperty.authoredOwner(context, clause) !== 'Intrinsic.native'
      )
        continue
      const direction = linkageDirection(header)
      if (!moduleClause && direction !== 'Import') continue
      const name = headerName(context, header)
      const member = ownMembers.find(
        (entry) =>
          AuthoredIdentity.anchorKey(entry.anchor) === AuthoredIdentity.anchorKey(header.anchor),
      )
      const canonical =
        member?.canonical._tag === 'Canonical' ? member.canonical.id.name : undefined
      const scope: NativeRequirement.Scope = moduleClause
        ? { kind: 'module', module: moduleName }
        : {
            kind: 'declaration',
            module: moduleName,
            declaration: canonical ?? (name._tag === 'Present' ? name.spelling : ''),
          }
      const analyzed = NativeRequirement.analyze(context, clause, scope)
      diagnostics.push(...analyzed.diagnostics)
      if (analyzed.requirement !== undefined) nativeRequirements.push(analyzed.requirement)
    }
  }
  const members: ReadonlyArray<MemberFact> = [
    ...ownMembers,
    ...inlineMembers,
    ...dedupedInherentMembers,
    ...hookMembers,
  ]
  return {
    _tag: 'ModuleHeaders',
    module: moduleName,
    nativeRequirements: nativeRequirements,
    publications: declarations.flatMap((declaration): ModuleHeaders['publications'] => {
      const header = declaration.header
      if (header._tag !== 'ImportHeader' || !header.public) return []
      const target = module.imports.find((imported) =>
        AuthoredIdentity.equals(imported.declaration.owner, declaration.owner),
      )?.canonicalTarget
      if (target === undefined || header.members === undefined) return []
      return header.members.flatMap((imported) => {
        const original = nameText(context, imported.name)
        if (original === undefined) return []
        const alias = imported.alias === undefined ? undefined : nameText(context, imported.alias)
        return [
          {
            module: target,
            original,
            spelling: alias ?? original,
            anchor: (imported.alias ?? imported.name).anchor,
          },
        ]
      })
    }),
    members: members,
    declarations: members.filter(
      (member): member is DeclarationFact => member._tag === 'FunctionDeclaration',
    ),
    structs: members.filter((member): member is StructFact => member._tag === 'StructDeclaration'),
    enums: members.filter((member): member is EnumFact => member._tag === 'EnumDeclaration'),
    unions: members.filter((member): member is UnionFact => member._tag === 'UnionDeclaration'),
    services: members.filter(
      (member): member is ServiceFact => member._tag === 'ServiceDeclaration',
    ),
    interfaces: members.filter(
      (member): member is InterfaceFact => member._tag === 'InterfaceDeclaration',
    ),
    constants: members.filter(
      (member): member is ConstantFact =>
        member._tag === 'ConstantDeclaration' || member._tag === 'PackageParameterDeclaration',
    ),
    conformances: conformances,
    inherentImpls: inherentImpls,
    diagnostics: diagnostics,
  }
}

/** The property clauses one header carries, across the header shapes that admit them. */
const headerProperties = (
  header: AuthoredHir.DeclarationHeader,
): ReadonlyArray<AuthoredHir.PropertyClause> => ('properties' in header ? header.properties : [])

/** The generic binders one header declares, across contract-carrying and nominal headers. */
const headerGenerics = (
  header: AuthoredHir.DeclarationHeader,
): ReadonlyArray<AuthoredHir.GenericParameter> => {
  if ('contract' in header) return header.contract.generics
  if ('generics' in header) return header.generics
  return []
}

/**
 * The eligible operator one authored marker spells, disambiguated by operand count.
 *
 * The authored marker keeps the written spelling rather than a token, so selection matches on
 * the operator table's own canonical spellings instead of a lexer token kind.
 */
const eligibleOperator = (spelling: string, arity: number): Operator.Eligible | undefined => {
  const unary: ReadonlyArray<Operator.Eligible> = ['Negate', 'Not', 'BitNot']
  const binary: ReadonlyArray<Operator.Eligible> = [
    'Multiply',
    'Divide',
    'Remainder',
    'Add',
    'Subtract',
    'LessThan',
    'LessOrEqual',
    'GreaterThan',
    'GreaterOrEqual',
    'Equals',
    'NotEquals',
    'BitAnd',
    'BitOr',
    'BitXor',
  ]
  let candidates: ReadonlyArray<Operator.Eligible>
  if (arity === 1) candidates = unary
  else if (arity === 2) candidates = binary
  else candidates = []
  return candidates.find((candidate) => Operator.spelling(candidate) === spelling)
}

/** A conformance's destructor hook, which the source spells `drop` rather than a name. */
const isDropHook = (
  context: Context,
  header: Extract<AuthoredHir.DeclarationHeader, { readonly _tag: 'FunctionHeader' }>,
): boolean => nameText(context, header.name) === 'drop'

/** A lifetime name's spelling, normalized to include its leading tick. */
const tickedLifetimeName = (context: Context, name: AuthoredHir.Name): string | undefined => {
  const spelling = nameText(context, name)
  if (spelling === undefined) return undefined
  return spelling.startsWith("'") ? spelling : `'${spelling}`
}

/** The nominal path a named or applied type names, ignoring its arguments. */
const nominalPath = (context: Context, type: AuthoredHir.Type): TypePathFact | undefined => {
  if (type._tag === 'NamedType') return typePathOf(context, type.path)
  if (type._tag === 'AppliedType' && type.target._tag === 'NamedType')
    return typePathOf(context, type.target.path)
  return undefined
}

/** The semantic access mode one authored callable mode names. */
const callableMode = (mode: AuthoredHir.CallableMode | undefined): Type.CallableMode => {
  if (mode === 'Once') return 'Take'
  if (mode === 'Mutable') return 'Exclusive'
  return 'Shared'
}

/** The written name an inherent head's argument spells, for the whole-family comparison. */
const binderArgumentName = (
  context: Context,
  argument: AuthoredHir.GenericArgument,
): string | undefined => {
  if (argument._tag === 'Lifetime') return tickedLifetimeName(context, argument.name)
  if (argument._tag === 'NamedType') return typePathOf(context, argument.path)?.spelling
  return undefined
}

/** The annotation a generic argument contributes to an anchor search. */
const argumentTypes = (argument: AuthoredHir.GenericArgument): ReadonlyArray<AuthoredHir.Type> => {
  if (argument._tag === 'Lifetime') return []
  if (argument._tag === 'RequirementSelector') return [argument.subject]
  return [argument]
}

/** The initializer a constant or package-parameter body supplies, if it declares one. */
const declaredInitializer = (
  body: AuthoredHir.DeclarationBody,
): AuthoredHir.Expression | undefined => {
  if (body._tag === 'InitializerBody') return body.value
  if (body._tag === 'PackageParameterBody') return body.default
  return undefined
}

/** An absent authored initializer, so a header without one still publishes a stable template. */
const missingExpression = (anchor: AuthoredHir.Anchor): AuthoredHir.Expression => ({
  _tag: 'MissingExpression',
  anchor,
  origin: { _tag: 'Authored' },
  causes: [
    { _tag: 'Cause' as const, anchor, code: 'MissingInitializer' },
  ] as AuthoredHir.RecoveryCauses,
})

/** Every name an impl member mentions, which decides the owner binders it inherits. */
const mentionedNames = (context: Context, member: AuthoredHir.Declaration): ReadonlySet<string> => {
  const found = new Set<string>()
  const addName = (name: AuthoredHir.Name): void => {
    const spelling = nameText(context, name)
    if (spelling !== undefined) found.add(spelling)
  }
  // A lifetime is mentioned under its ticked spelling only: a value or type named `text` says
  // nothing about `'text`.
  const addLifetime = (name: AuthoredHir.Name): void => {
    const spelling = nameText(context, name)
    if (spelling !== undefined) found.add(spelling.startsWith("'") ? spelling : `'${spelling}`)
  }
  const visitType = (type: AuthoredHir.Type | AuthoredHir.Lifetime): void => {
    if (type._tag === 'Lifetime') return addLifetime(type.name)
    switch (type._tag) {
      case 'NamedType':
        for (const segment of type.path.segments) addName(segment)
        return
      case 'AppliedType':
        visitType(type.target)
        for (const argument of type.arguments.arguments) visitArgument(argument)
        if (type.arguments.failures !== undefined) visitType(type.arguments.failures)
        if (type.arguments.requirements !== undefined) visitRow(type.arguments.requirements)
        for (const environment of type.arguments.environment ?? []) visitType(environment)
        return
      case 'FixedArrayType':
        return visitType(type.element)
      case 'SliceType':
        visitType(type.element)
        if (type.lifetime !== undefined) visitType(type.lifetime)
        return
      case 'ReferenceType':
        visitType(type.referent)
        if (type.lifetime !== undefined) visitType(type.lifetime)
        if (type.role !== undefined) addName(type.role)
        return
      case 'PointerType':
        return visitType(type.pointee)
      case 'CallableType':
        for (const binder of type.binders) visitGeneric(binder)
        if (type.environment !== undefined) visitType(type.environment)
        for (const parameter of type.parameters) visitType(parameter)
        return visitType(type.result)
      case 'ForeignFunctionType':
        for (const binder of type.binders) visitGeneric(binder)
        for (const parameter of type.parameters) visitType(parameter)
        return visitType(type.result)
      case 'ExactRepresentationType':
        return visitType(type.subject)
      case 'OpaqueResultType':
        for (const binder of type.binders) visitGeneric(binder)
        return visitType(type.result)
      case 'UnionType':
        for (const operand of type.members) visitRowOperand(operand)
        return
      case 'RowWithout':
        visitRowOperand(type.source)
        return visitRowOperand(type.removed)
      default:
        return
    }
  }
  const visitArgument = (argument: AuthoredHir.GenericArgument): void => {
    if (argument._tag === 'RequirementSelector') {
      visitType(argument.subject)
      for (const segment of argument.role.segments) addName(segment)
      return
    }
    visitType(argument)
  }
  const visitRowOperand = (operand: AuthoredHir.RowOperand): void => {
    if (operand._tag !== 'Requirement') return visitType(operand)
    visitType(operand.capability)
    if (operand.role !== undefined) for (const segment of operand.role.segments) addName(segment)
  }
  const visitRow = (row: AuthoredHir.RequirementRow): void => {
    for (const operand of row.members) visitRowOperand(operand)
  }
  const visitGeneric = (generic: AuthoredHir.GenericParameter): void => {
    if (generic._tag === 'LifetimeParameter') addLifetime(generic.name)
    else addName(generic.name)
    if (generic._tag === 'RowParameter') return
    for (const bound of generic.bounds) visitType(bound)
  }
  const header = member.header
  if ('contract' in header) {
    const contract = header.contract
    for (const generic of contract.generics) visitGeneric(generic)
    for (const parameter of contract.parameters) {
      addName(parameter.name)
      visitType(parameter.type)
    }
    if (contract.result !== undefined) visitType(contract.result)
    if (contract.failures !== undefined) visitType(contract.failures)
    if (contract.requirements !== undefined) visitRow(contract.requirements)
    for (const environment of contract.environment ?? []) visitType(environment)
    for (const constraint of contract.constraints) {
      if (constraint._tag === 'MembershipConstraint') {
        visitRowOperand(constraint.subject)
        visitRowOperand(constraint.source)
      } else {
        visitType(constraint.provider)
        visitRowOperand(constraint.selected)
        visitRowOperand(constraint.source)
      }
    }
  }
  // A member's body may name an owner binder only through its header, so the body is not walked:
  // an inherited binder must appear in the signature for any call to infer it.
  return found
}

/**
 * Whether a receiver parameter's declared type names the owner: `Self`, `&Self`, `&mut Self`, or
 * the owner's own spelling with any arguments, so `self: once Effect<A ! E ? R>` on a zero-data
 * `Effect` owner does not count while `self: &Counter` on `impl Counter` does.
 */
const declaredTypeNamesOwner = (
  declared: DeclaredTypeFact,
  self: Type.Parameter,
  ownerSpelling: string,
): boolean => {
  if (declared._tag === 'Reference')
    return declaredTypeNamesOwner(declared.target, self, ownerSpelling)
  if (declared._tag === 'Applied')
    return declaredTypeNamesOwner(declared.target, self, ownerSpelling)
  if (declared._tag === 'Resolved')
    return Type.isParameter(declared.type) && Type.key(declared.type) === Type.key(self)
  if (declared._tag === 'Unresolved') return declared.path.spelling === ownerSpelling
  return false
}

/** Collects identities and raw type paths for the complete closure before scope resolution. */
export const collect = (closure: ModuleClosure.Facts): DeclarationIndex.Index => {
  const modules = closure.modules.map((module) => collectModule(module))
  return DeclarationIndex.make(
    'Collected',
    modules,
    Diagnostic.collect(...modules.map((module) => module.diagnostics)),
  )
}

/**
 * Replays header elision after nominal declarations have published their lifetime arity.
 *
 * The elaboration record is plain data, so the authored declaration and its spans are supplied
 * here rather than retained on the fact.
 */
export const finalizeLifetimeHeader = (
  context: Context,
  member:
    | DeclarationFact
    | ServiceOperationFact
    | StructFact
    | UnionFact
    | InherentImplFact
    | ConformanceFact,
  nominalParameters: (path: TypePathFact) => ReadonlyArray<Type.Parameter> | undefined,
  implHead?: InherentImplFact | ConformanceFact,
  // An anonymous callable is its own owner and is not listed among the module's declarations.
  authored?: AuthoredHir.Declaration,
):
  | DeclarationFact
  | ServiceOperationFact
  | StructFact
  | UnionFact
  | InherentImplFact
  | ConformanceFact => {
  const prior = member.lifetimeElaboration
  if (prior === undefined) return member
  const declaration = authored ?? AuthoredWalk.declarationOf(context.module, member.anchor.owner)
  if (declaration === undefined) return member
  // Owner lifetimes stay lexical while the member elaborates its own input/result relationship.
  // Inherent members retain otherwise unmentioned owner binders only through Self. Conformance
  // witnesses retain the entire head contract because selection supplies all its binders.
  const ambient = implHead?.typeParameters.filter((parameter) => parameter.implicitLifetime) ?? []
  const environment = new Map(prior.parameters)
  for (const parameter of ambient) environment.set(parameter.type.name, parameter.type)
  const retainsOwner =
    ambient.length > 0 &&
    (implHead?._tag === 'ConformanceDeclaration' ||
      mentionedNames(context, declaration).has('Self'))
  const elaborated = DeclarationLifetime.forHeader(
    context,
    prior.owner,
    declaration,
    environment,
    (type) => {
      const analyzed = analyzeDeclaredType(context, type, environment, true, prior)
      // An applied type names its target's declaration, so `View<i32>` reports the binders of
      // `View`; its own written arguments decide only which of them stayed unwritten.
      const fact = analyzed.fact._tag === 'Applied' ? analyzed.fact.target : analyzed.fact
      if (fact._tag === 'Resolved' && Type.isNominal(fact.type))
        return (
          (member._tag === 'InherentImplDeclaration' && fact.path !== undefined
            ? nominalParameters(fact.path)
            : undefined) ?? Type.intrinsicNominalParameters(fact.type)
        )
      return fact._tag === 'Unresolved' ? nominalParameters(fact.path) : undefined
    },
  )
  const parameters = new Map(environment)
  const implicit: ReadonlyArray<TypeParameterFact> = elaborated.implicit.map((binder) => {
    parameters.set(binder.parameter.name, binder.parameter)
    return {
      _tag: 'TypeParameterDeclaration',
      type: binder.parameter,
      name: {
        _tag: 'Present',
        spelling: binder.parameter.name,
        anchor: binder.anchor,
      },
      anchor: binder.anchor,
      bounds: [],
      staticProperties: [],
      lifetimeBounds: [],
      implicitLifetime: true,
    }
  })
  const typeParameters = [
    ...member.typeParameters.filter(
      (parameter) =>
        !parameter.implicitLifetime ||
        // Re-elaborate this header's invocation binders, not implicit lifetimes inherited
        // by an anonymous function from its enclosing declaration's captured environment.
        (implHead === undefined &&
          (parameter.type.owner.module !== prior.owner.module ||
            parameter.type.owner.name !== prior.owner.name)),
    ),
    ...(retainsOwner ? ambient : []),
    ...implicit,
  ]
  // Only an annotation whose failure was a lifetime question is worth re-analyzing; the authored
  // node behind it is found through the anchor the first analysis recorded.
  const declared = (fact: DeclaredTypeFact): DeclaredTypeFact => {
    if (
      fact._tag === 'Unavailable' &&
      fact.cause?.code !== Diagnostic.ambiguousLifetimeElisionCode &&
      fact.cause?.code !== Diagnostic.unknownLifetimeCode
    )
      return fact
    const type = typeAt(declaration, fact.anchor)
    return type === undefined
      ? fact
      : analyzeDeclaredType(context, type, parameters, false, elaborated).fact
  }
  const fields = (values: ReadonlyArray<FieldFact>): ReadonlyArray<FieldFact> =>
    values.map((field) => ({ ...field, declaredType: declared(field.declaredType) }))
  if (member._tag === 'ConformanceDeclaration')
    return {
      ...member,
      typeParameters,
      lifetimeElaboration: elaborated,
      capability: declared(member.capability),
      provider: declared(member.provider),
      requirements: member.requirements.map((requirement) => ({
        ...requirement,
        capability: declared(requirement.capability),
      })),
    }
  if (member._tag === 'InherentImplDeclaration')
    return {
      ...member,
      typeParameters,
      lifetimeElaboration: elaborated,
      owner: declared(member.owner),
    }
  if (member._tag === 'StructDeclaration')
    return {
      ...member,
      typeParameters,
      lifetimeElaboration: elaborated,
      fields: fields(member.fields),
    }
  if (member._tag === 'UnionDeclaration')
    return {
      ...member,
      typeParameters,
      lifetimeElaboration: elaborated,
      variants: member.variants.map((variant) => ({ ...variant, fields: fields(variant.fields) })),
    }
  const contract = 'contract' in declaration.header ? declaration.header.contract : undefined
  const opaqueReturn =
    member.opaqueResult === undefined || contract?.result === undefined
      ? undefined
      : collectReturnType(
          context,
          declaration,
          contract.result,
          prior.owner.name,
          typeParameters,
          parameters,
          elaborated,
        )
  return {
    ...member,
    typeParameters,
    lifetimeElaboration: elaborated,
    parameters: member.parameters.map((parameter) => ({
      ...parameter,
      declaredType: declared(parameter.declaredType),
    })),
    returnType: opaqueReturn?.fact ?? declared(member.returnType),
    ...(opaqueReturn?.opaqueResult === undefined
      ? {}
      : { opaqueResult: opaqueReturn.opaqueResult }),
    failureRow: collectFailureRow(context, contract?.failures, parameters, elaborated).fact,
    requirementRow: collectRequirementRow(context, contract?.requirements, parameters, elaborated)
      .fact,
  }
}

/** The authored type annotation one anchor names below a declaration header. */
const typeAt = (
  declaration: AuthoredHir.Declaration,
  anchor: AuthoredHir.Anchor,
): AuthoredHir.Type | undefined => {
  const key = AuthoredIdentity.anchorKey(anchor)
  let found: AuthoredHir.Type | undefined
  const visit = (type: AuthoredHir.Type | AuthoredHir.Lifetime): void => {
    if (found !== undefined || type._tag === 'Lifetime') return
    if (AuthoredIdentity.anchorKey(type.anchor) === key) {
      found = type
      return
    }
    for (const child of typeChildren(type)) visit(child)
  }
  for (const type of headerTypes(declaration.header)) visit(type)
  return found
}

/** The annotations one header owns directly, as the roots of an annotation search. */
const headerTypes = (header: AuthoredHir.DeclarationHeader): ReadonlyArray<AuthoredHir.Type> => {
  const found: Array<AuthoredHir.Type> = []
  if ('contract' in header) {
    const contract = header.contract
    for (const generic of contract.generics)
      if (generic._tag !== 'RowParameter')
        for (const bound of generic.bounds) if (bound._tag !== 'Lifetime') found.push(bound)
    for (const parameter of contract.parameters) found.push(parameter.type)
    if (contract.result !== undefined) found.push(contract.result)
    if (contract.failures !== undefined) found.push(contract.failures)
    for (const member of contract.requirements?.members ?? [])
      found.push(member._tag === 'Requirement' ? member.capability : member)
    for (const constraint of contract.constraints)
      if (constraint._tag === 'ProviderConstraint') found.push(constraint.provider)
  }
  if (header._tag === 'ImplHeader') {
    found.push(header.subject)
    if (header.target !== undefined) found.push(header.target)
  }
  if (header._tag === 'StructHeader') for (const field of header.fields) found.push(field.type)
  if (header._tag === 'UnionHeader')
    for (const variant of header.variants)
      for (const field of variant.fields) found.push(field.type)
  if (header._tag === 'TupleHeader') found.push(...header.elements)
  if (header._tag === 'AliasHeader') found.push(header.target)
  if (header._tag === 'ConstantHeader' && header.type !== undefined) found.push(header.type)
  if (header._tag === 'PackageParameterHeader') found.push(header.type)
  if (header._tag === 'StaticHeader') found.push(header.type)
  if ('generics' in header)
    for (const generic of header.generics)
      if (generic._tag !== 'RowParameter')
        for (const bound of generic.bounds) if (bound._tag !== 'Lifetime') found.push(bound)
  return found
}

/** The annotations nested directly below one type, for an anchor search. */
const typeChildren = (type: AuthoredHir.Type): ReadonlyArray<AuthoredHir.Type> => {
  switch (type._tag) {
    case 'AppliedType':
      return [
        type.target,
        ...type.arguments.arguments.flatMap(argumentTypes),
        ...(type.arguments.failures === undefined ? [] : [type.arguments.failures]),
        ...(type.arguments.requirements?.members ?? []).map((member) =>
          member._tag === 'Requirement' ? member.capability : member,
        ),
      ]
    case 'FixedArrayType':
    case 'SliceType':
      return [type.element]
    case 'ReferenceType':
      return [type.referent]
    case 'PointerType':
      return [type.pointee]
    case 'CallableType':
    case 'ForeignFunctionType':
      return [...type.parameters, type.result]
    case 'ExactRepresentationType':
      return [type.subject]
    case 'OpaqueResultType':
      return [type.result]
    case 'UnionType':
      return type.members.map((member) =>
        member._tag === 'Requirement' ? member.capability : member,
      )
    case 'RowWithout':
      return [
        type.source._tag === 'Requirement' ? type.source.capability : type.source,
        type.removed._tag === 'Requirement' ? type.removed.capability : type.removed,
      ]
    case 'InvalidType':
      return type.retained
    default:
      return []
  }
}
