import * as Location from './Location.js'
import type * as AuthoredHir from './AuthoredHir.js'
import * as AuthoredIdentity from './AuthoredIdentity.js'
import * as AuthoredWalk from './AuthoredWalk.js'
import * as SemanticContext from './SemanticContext.js'
import * as Semantic from './Semantic.js'
import * as NativeAssembly from './NativeAssembly.js'
import * as AggregateIdentity from './AggregateIdentity.js'
import * as BodyLifetime from './BodyLifetime.js'
import * as BodyBuilder from './BodyBuilder.js'
import * as Lifetime from './Lifetime.js'
import * as TypeCompatibility from './TypeCompatibility.js'
import * as CallableContract from './CallableContract.js'
import * as ConformanceProof from './ConformanceProof.js'
import * as Constraint from './Constraint.js'
import * as DeclarationCollection from './DeclarationCollection.js'
import * as DeclarationFacts from './DeclarationFacts.js'
import * as DeclarationLifetime from './DeclarationLifetime.js'
import type * as DeclarationIndex from './DeclarationIndex.js'
import * as DeclarationResolution from './DeclarationResolution.js'
import * as Diagnostic from './Diagnostic.js'
import type {
  ArgumentFact,
  ArgumentsResult,
  ReferencePathFact,
  ArrayElementFact,
  ArrayLiteralState,
  AnonymousCaptureFact,
  BindingDeclarationFact,
  BorrowRootFact,
  BoundsFact,
  BuiltinArgumentMappingFact,
  CallableApplyExpressionDecision,
  CallableSectionExpressionDecision,
  CallReferenceFact,
  ConstantExpressionDecision,
  DeclarationFact,
  DeclarationId,
  DeclaredName,
  DurationExpressionDecision,
  EffectCaptureFact,
  EffectRequirementBindingFact,
  ExpressionDecision,
  ExpressionResult,
  ExpressionTypeFact,
  FieldProjectionExpressionDecision,
  FloatingExpressionDecision,
  FunctionConstruction,
  IdentifierExpressionDecision,
  IdentifierResult,
  IntegerResult,
  IntegerExpressionDecision,
  InterfaceOperationFact,
  IntrinsicReferenceFact,
  MatchArmFact,
  MatchArmBodyFact,
  MatchExpressionDecision,
  MoveExpressionDecision,
  ParameterFact,
  ParameterReferenceFact,
  PatternBindingFact,
  PatternFact,
  PatternFieldFact,
  PatternFieldState,
  ProjectionState,
  ReferentProjectionState,
  SemanticType,
  StaticIterationFact,
  StructInitializerFact,
  StructInitializerState,
  StructTargetFact,
  StructTypeArgumentFact,
  UnionVariantTargetFact,
} from './Elaboration.js'
import {
  argumentFact,
  assignmentRoot,
  assignmentRootAccess,
  availableBoolExpressionType,
  availableExpressionType,
  callCallee,
  contextualIntegerCompatible,
  constructionExpressionAnchor,
  constructionExpressionType,
  expressionNode,
  lookupDeclaration,
  lookupParameter,
  referenceNames,
  referencePath,
  representationJoinDiagnostic,
  typesCompatible,
  unavailableExpressionType,
  unionConversionDiagnostic,
  visitStatements,
} from './Elaboration.js'
import * as FloatingPoint from './FloatingPoint.js'
import * as Tir from './Tir.js'
import * as Intrinsic from './Intrinsic.js'
import * as DurationLiteral from './internal/DurationLiteral.js'
import * as TypeInference from './internal/TypeInference.js'
import * as Match from './Match.js'
import * as NameResolution from './NameResolution.js'
import * as Operator from './Operator.js'
import * as RowAlgebra from './RowAlgebra.js'
import * as Scalar from './Scalar.js'
import * as SourceSpan from './SourceSpan.js'
import {
  analyzeFunctionBody,
  analyzeStatements,
  reachableCallableWrites,
  returnFlowOf,
  expressionNever,
  unsafeCallDiagnostic,
} from './StatementAnalysis.js'
import * as Evaluation from './Evaluation.js'
import * as LiteralForm from './LiteralForm.js'
import * as StaticText from './StaticText.js'
import * as StaticValue from './StaticValue.js'
import * as Type from './Type.js'

/**
 * Integer analysis reads the authored exact value and radix; the literal is never re-lexed.
 * Only the contextual range check remains, against the widest admitted target width.
 */
export const analyzeInteger = (
  context: SemanticContext.SemanticContext,
  node: AuthoredHir.Expression,
  expected?: SemanticType,
): IntegerResult => {
  if (node._tag !== 'IntegerLiteral')
    return {
      fact: { _tag: 'Unavailable', anchor: node.anchor },
      diagnostics: [],
    }
  const selected =
    typeof expected === 'string' && Scalar.isIntegerSpelling(expected)
      ? Scalar.find(expected)
      : Scalar.defaultInteger
  if (selected === undefined || selected.category !== 'Integer')
    throw new RangeError('The scalar catalog lost its default integer')
  const value = node.value
  // Target-width integers are retained against the widest admitted target here. The concrete
  // target validates its selected 32- or 64-bit range before MIR is committed.
  const range = Scalar.range(selected, 64)
  if (value >= range.minimum && value <= range.maximum)
    return {
      fact: {
        _tag: 'Available',
        type: selected.spelling,
        value,
        anchor: node.anchor,
      },
      diagnostics: [],
    }
  const literalSpan = Location.at(node.anchor)
  const spelling = integerSpelling(node)
  return {
    fact: {
      _tag: 'OutOfRange',
      type: selected.spelling,
      spelling,
      anchor: node.anchor,
    },
    diagnostics: [
      selected.spelling === 'usize' && value < 0n
        ? Diagnostic.usizeNegative(spelling, literalSpan)
        : Diagnostic.integerOutOfRange(spelling, selected.spelling, range, literalSpan),
    ],
  }
}

const radixPrefix: Readonly<Record<2 | 8 | 10 | 16, string>> = {
  2: '0b',
  8: '0o',
  10: '',
  16: '0x',
}

/** The canonical spelling of an authored integer, reported in range diagnostics. */
export const integerSpelling = (node: AuthoredHir.IntegerLiteral): string => {
  const negative = node.value < 0n
  const magnitude = negative ? -node.value : node.value
  return `${negative ? '-' : ''}${radixPrefix[node.radix]}${magnitude.toString(node.radix)}`
}

/** Floating analysis encodes the authored exact decimal parts; the literal is never re-lexed. */
export const analyzeFloating = (
  context: SemanticContext.SemanticContext,
  node: AuthoredHir.Expression,
  expected?: SemanticType,
): {
  readonly fact: FloatingExpressionDecision
  readonly diagnostics: ReadonlyArray<Diagnostic.Located>
} => {
  const unavailable = (
    diagnostics: ReadonlyArray<Diagnostic.Located>,
  ): { readonly fact: FloatingExpressionDecision; readonly diagnostics: typeof diagnostics } => ({
    fact: { _tag: 'Unavailable', anchor: node.anchor },
    diagnostics,
  })
  if (node._tag !== 'FloatingLiteral') return unavailable([])
  const spelling = floatingSpelling(node)
  const selected = Scalar.isFloatSpelling(expected) ? expected : Scalar.defaultFloat.spelling
  const encoded = FloatingPoint.fromDecimal(spelling, selected === 'f32' ? 32 : 64)
  // A spelling the lexer accepted but no float can represent must never pass silently.
  if (encoded === undefined)
    return unavailable([Diagnostic.invalidFloatLiteral(spelling, Location.at(node.anchor))])
  return {
    fact: {
      _tag: 'Available',
      type: selected,
      bits: encoded.bits,
      spelling,
      anchor: node.anchor,
    },
    diagnostics: [],
  }
}

/** The exact decimal an authored float denotes, as `coefficient * 10 ** exponent`. */
export const floatingSpelling = (
  node: Extract<AuthoredHir.Literal, { readonly _tag: 'FloatingLiteral' }>,
): string =>
  `${node.sign === 'Negative' ? '-' : ''}${node.coefficient.toString(10)}e${node.exponent.toString(10)}`

/** Duration analysis scales the authored components; the literal is never re-lexed. */
export const analyzeDuration = (
  context: SemanticContext.SemanticContext,
  node: AuthoredHir.Expression,
): {
  readonly fact: DurationExpressionDecision
  readonly diagnostics: ReadonlyArray<Diagnostic.Located>
} => {
  if (node._tag !== 'DurationLiteral')
    return {
      fact: {
        _tag: 'Duration',
        type: unavailableExpressionType,
        anchor: node.anchor,
      },
      diagnostics: [],
    }
  const spelling = node.components
    .map((component) => `${component.magnitude.toString(10)}${component.unit}`)
    .join('')
  const nanoseconds = node.components.reduce(
    (total, component) =>
      total + component.magnitude * DurationLiteral.unitNanoseconds[component.unit],
    0n,
  )
  if (nanoseconds > 18_446_744_073_709_551_615n)
    return {
      fact: {
        _tag: 'Duration',
        spelling,
        type: unavailableExpressionType,
        anchor: node.anchor,
      },
      diagnostics: [Diagnostic.durationOutOfRange(spelling, Location.at(node.anchor))],
    }
  return {
    fact: {
      _tag: 'Duration',
      value: nanoseconds,
      spelling,
      type: availableExpressionType('u64'),
      anchor: node.anchor,
    },
    diagnostics: [],
  }
}

const hexOf = (bytes: ReadonlyArray<number>): string =>
  bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('')

/** The static data an authored text or bytes literal denotes, from its exact pooled payload. */
const staticDataOf = (
  context: SemanticContext.SemanticContext,
  node: Extract<AuthoredHir.Literal, { readonly _tag: 'TextLiteral' | 'BytesLiteral' }>,
): StaticText.Data => {
  const kind = node._tag === 'TextLiteral' ? 'Text' : 'Bytes'
  // Provenance slices a literal by the source bytes behind each decoded byte. Only the written
  // spelling carries those, so decode it again and keep the result when it denotes this payload.
  const spelling = context.spellingOf(node.anchor)
  const raw = spelling === undefined ? undefined : Array.from(new TextEncoder().encode(spelling))
  const form = raw === undefined ? undefined : LiteralForm.recognize(raw)
  const decoded = raw === undefined || form === undefined ? undefined : StaticText.decode(raw, form)
  const bytes =
    node._tag === 'TextLiteral'
      ? Array.from(new TextEncoder().encode(context.textOf(node.value)))
      : Array.from(context.bytesOf(node.value))
  if (
    decoded?._tag === 'Decoded' &&
    decoded.data.kind === kind &&
    hexOf(decoded.data.bytes) === hexOf(bytes)
  )
    return decoded.data
  return {
    _tag: 'StaticData',
    id: `${kind === 'Text' ? 'text' : 'bytes'}:${hexOf(bytes)}`,
    kind,
    bytes: bytes,
    utf8: kind === 'Text',
  }
}

export const analyzeConstant = (
  context: SemanticContext.SemanticContext,
  declaration: DeclarationFacts.ConstantFact,
  anchor: AuthoredHir.Anchor,
  reportDiagnostic: boolean,
): ExpressionResult => {
  const declared = declaration.declaredType
  const literal = declaration.literal
  let value: ConstantExpressionDecision['value']
  let type: SemanticType | undefined
  let detail: string | undefined

  if (declaration._tag === 'PackageParameterDeclaration' && declared._tag === 'Resolved') {
    // The package bootstrap validates the serializable domain and supplies the final value.
    type = declared.type
  } else if (
    declared._tag !== 'Resolved' ||
    !(
      Type.isString(declared.type) ||
      (typeof declared.type === 'string' &&
        (declared.type === 'bool' ||
          declared.type === 'char' ||
          Scalar.isIntegerSpelling(declared.type) ||
          Scalar.isFloatSpelling(declared.type)))
    )
  ) {
    detail = 'the declared type must be one primitive scalar or string'
  } else if (literal._tag === 'Malformed') {
    detail = literal.detail
  } else if (literal._tag === 'Unavailable') {
    type = declared.type
  } else if (Type.isString(declared.type) && literal._tag === 'StringLiteral') {
    if (literal.data.kind !== 'Text') detail = 'a byte-string literal does not produce a string'
    else {
      type = Type.string(Lifetime.staticLifetime)
      value = { _tag: 'String', data: literal.data }
    }
  } else if (declared.type === 'bool' && literal._tag === 'BooleanLiteral') {
    type = 'bool'
    value = { _tag: 'Boolean', value: literal.value }
  } else if (declared.type === 'char' && literal._tag === 'CharacterLiteral') {
    type = 'char'
    value = { _tag: 'Character', value: literal.value }
  } else if (
    Scalar.isIntegerSpelling(declared.type) &&
    (literal._tag === 'IntegerLiteral' || literal._tag === 'CharacterLiteral')
  ) {
    const scalar = Scalar.find(declared.type)
    if (scalar === undefined || scalar.category !== 'Integer') {
      detail = `unknown integer type ${declared.type}`
    } else {
      const range = Scalar.range(scalar, 64)
      const magnitude = BigInt(literal.value)
      if (magnitude < range.minimum || magnitude > range.maximum) {
        detail = `${magnitude} does not fit ${declared.type}`
      } else {
        type = declared.type
        value = { _tag: 'Integer', value: magnitude, type }
      }
    }
  } else if (declared.type === 'u64' && literal._tag === 'DurationLiteral') {
    if (literal.value > 18_446_744_073_709_551_615n) {
      detail = `${literal.spelling} does not fit u64`
    } else {
      type = 'u64'
      value = { _tag: 'Integer', value: literal.value, type }
    }
  } else if (Scalar.isFloatSpelling(declared.type) && literal._tag === 'FloatingLiteral') {
    const selected = declared.type
    const encoded = FloatingPoint.fromDecimal(literal.spelling, selected === 'f32' ? 32 : 64)
    if (encoded === undefined) detail = `${literal.spelling} is not a valid ${selected} literal`
    else {
      type = selected
      value = {
        _tag: 'Floating',
        bits: encoded.bits,
        spelling: literal.spelling,
        type: selected,
      }
    }
  } else {
    detail = `the literal kind does not match ${declared._tag === 'Resolved' ? Type.display(declared.type) : 'the declared type'}`
  }

  let diagnostic: Diagnostic.Located | undefined
  if (detail !== undefined) {
    diagnostic =
      literal._tag === 'DurationLiteral' && literal.value > 18_446_744_073_709_551_615n
        ? Diagnostic.durationOutOfRange(literal.spelling, Location.at(literal.anchor))
        : Diagnostic.invalidConstant(detail, Location.at(declaration.initializer.anchor))
  }
  const expressionType =
    type === undefined ? unavailableExpressionType : availableExpressionType(type)
  return {
    fact: {
      _tag: 'Constant',
      declaration,
      ...(value === undefined ? {} : { value }),
      type: expressionType,
      anchor,
    },
    diagnostics: reportDiagnostic && diagnostic !== undefined ? [diagnostic] : [],
    type,
  }
}

/** The value names visible at one body position: parameters plus completed bindings. */
export interface Scope {
  readonly parameters: ReadonlyArray<ParameterFact>
  readonly bindings: ReadonlyArray<BindingDeclarationFact>
  readonly patternBindings: ReadonlyArray<PatternBindingFact>
}

export interface ValueResolution {
  readonly reference: ParameterReferenceFact
  readonly type: ExpressionTypeFact
  readonly diagnostics: ReadonlyArray<Diagnostic.Located>
}

/** The anchor key a lexical reference names, matching the binder anchors collected in scope. */
const lexicalKey = (reference: AuthoredHir.LexicalReference): string =>
  AuthoredIdentity.anchorKey({
    _tag: 'AuthoredAnchor',
    owner: reference.owner,
    path: reference.path,
  })

/**
 * Resolve one value reference.
 *
 * An authored identifier already points at its binder, so the common path is an anchor lookup
 * into the binders this walk collected. Only a reference the lowering could not bind falls back
 * to the spelling search, which still reports the same shadowing and ambiguity outcomes.
 */
export const resolveValueName = (
  context: SemanticContext.SemanticContext,
  scope: Scope,
  tokenSpelling: string,
  anchor: AuthoredHir.Anchor,
  binding_?: AuthoredHir.LexicalReference,
): ValueResolution => {
  if (binding_ !== undefined) {
    const key = lexicalKey(binding_)
    const bound = scope.bindings.findLast(
      (candidate) => AuthoredIdentity.anchorKey(candidate.anchor) === key,
    )
    if (bound !== undefined)
      return {
        reference: {
          _tag: 'ResolvedBinding' as const,
          spelling: tokenSpelling,
          anchor,
          binding: bound,
        },
        type: bound.inferredType,
        diagnostics: [],
      }
    const boundPattern = scope.patternBindings.findLast(
      (candidate) => AuthoredIdentity.anchorKey(candidate.anchor) === key,
    )
    if (boundPattern !== undefined)
      return {
        reference: {
          _tag: 'ResolvedPattern' as const,
          spelling: tokenSpelling,
          anchor,
          binding: boundPattern,
        },
        type: boundPattern.type,
        diagnostics: [],
      }
    const boundParameter = scope.parameters.findLast(
      (candidate) => AuthoredIdentity.anchorKey(candidate.anchor) === key,
    )
    // Lowering binds a duplicated parameter name to one of its binders, so the anchor alone cannot
    // see the ambiguity the declaration owns. The spelling decides it, exactly as the fallback does.
    if (
      boundParameter !== undefined &&
      lookupParameter(scope.parameters, tokenSpelling)._tag !== 'Ambiguous'
    )
      return {
        reference: {
          _tag: 'Resolved' as const,
          spelling: tokenSpelling,
          anchor,
          parameter: boundParameter,
        },
        type:
          boundParameter.declaredType._tag === 'Resolved'
            ? availableExpressionType(boundParameter.declaredType.type)
            : unavailableExpressionType,
        diagnostics: [],
      }
  }
  const binding = scope.bindings.findLast(
    (candidate) => candidate.name._tag === 'Present' && candidate.name.spelling === tokenSpelling,
  )
  if (binding !== undefined) {
    return {
      reference: {
        _tag: 'ResolvedBinding' as const,
        spelling: tokenSpelling,
        anchor,
        binding,
      },
      type: binding.inferredType,
      diagnostics: [],
    }
  }
  const patternBinding = scope.patternBindings.findLast(
    (candidate) => candidate.name._tag === 'Present' && candidate.name.spelling === tokenSpelling,
  )
  if (patternBinding !== undefined) {
    return {
      reference: {
        _tag: 'ResolvedPattern' as const,
        spelling: tokenSpelling,
        anchor,
        binding: patternBinding,
      },
      type: patternBinding.type,
      diagnostics: [],
    }
  }
  const lookup = lookupParameter(scope.parameters, tokenSpelling)
  if (lookup._tag === 'Resolved') {
    return {
      reference: {
        _tag: 'Resolved' as const,
        spelling: tokenSpelling,
        anchor,
        parameter: lookup.parameter,
      },
      type:
        lookup.parameter.declaredType._tag === 'Resolved'
          ? availableExpressionType(lookup.parameter.declaredType.type)
          : unavailableExpressionType,
      diagnostics: [],
    }
  }
  if (lookup._tag === 'Ambiguous') {
    return {
      reference: {
        _tag: 'Ambiguous' as const,
        spelling: tokenSpelling,
        anchor,
        parameters: lookup.parameters,
      },
      type: unavailableExpressionType,
      diagnostics: [],
    }
  }
  const missingDiagnostic = Diagnostic.unknownValueReference(tokenSpelling, Location.at(anchor))
  return {
    reference: {
      _tag: 'Missing' as const,
      spelling: tokenSpelling,
      anchor,
      cause: Diagnostic.identity(missingDiagnostic),
    },
    type: unavailableExpressionType,
    diagnostics: [missingDiagnostic],
  }
}

export const analyzeIdentifier = (
  context: SemanticContext.SemanticContext,
  node: AuthoredHir.Expression,
  scope: Scope,
): IdentifierResult => {
  const spellingText =
    node._tag === 'IdentifierExpression' ? SemanticContext.nameText(context, node.name) : undefined
  // A damaged identifier stays parser-owned: its spelling is not a reference to resolve.
  if (node._tag !== 'IdentifierExpression' || spellingText === undefined || node.causes.length > 0)
    return {
      fact: {
        _tag: 'Identifier',
        reference: { _tag: 'Unavailable', anchor: node.anchor },
        type: unavailableExpressionType,
        anchor: node.anchor,
      },
      diagnostics: [],
      type: undefined,
      anchor: node.anchor,
    }

  const resolution = resolveValueName(context, scope, spellingText, node.anchor, node.binding)
  return {
    fact: {
      _tag: 'Identifier',
      reference: resolution.reference,
      type: resolution.type,
      anchor: node.anchor,
    },
    diagnostics: resolution.diagnostics,
    type: resolution.type._tag === 'Available' ? resolution.type.type : undefined,
    anchor: node.anchor,
  }
}

export const enumFactByType = (
  index: DeclarationIndex.Index,
  type: SemanticType,
): DeclarationFacts.EnumFact | undefined =>
  Type.isNominal(type)
    ? index.modules
        .find((module) => module.module === type.module)
        ?.enums.find(
          (declaration) =>
            declaration.canonical._tag === 'Canonical' &&
            declaration.canonical.id.name === type.name,
        )
    : undefined

export const unionFactByType = (
  index: DeclarationIndex.Index,
  type: SemanticType,
): DeclarationFacts.UnionFact | undefined => {
  if (!Type.isNominal(type)) return undefined
  const declaration = DeclarationFacts.byCanonical(index, {
    _tag: 'CanonicalDeclarationId',
    module: type.module,
    name: type.name,
  })
  return declaration?._tag === 'UnionDeclaration' ? declaration : undefined
}

const nominalUnionCoverage = (
  index: DeclarationIndex.Index,
  type: Type.Nominal,
  root: Type.Type,
): ReadonlyArray<Match.CoverageIdentity> => {
  const union = unionFactByType(index, type)
  return (
    union?.variants.flatMap((variant) =>
      variant.canonical._tag === 'Canonical'
        ? [Match.nominalUnionVariant(root, type, variant.canonical.id, variant.id.ordinal)]
        : [],
    ) ?? []
  )
}

export const coverageMembersOf = (
  index: DeclarationIndex.Index,
  type: Type.Type,
): ReadonlyArray<Match.CoverageIdentity> => {
  if (Type.isUnion(type))
    return type.members.flatMap((member) =>
      Type.isNominal(member) && unionFactByType(index, member) !== undefined
        ? nominalUnionCoverage(index, member, member)
        : [Match.structuralMember(member)],
    )
  if (Type.isNominal(type) && unionFactByType(index, type) !== undefined)
    return nominalUnionCoverage(index, type, type)
  return Match.membersOf(type)
}

export const analyzeEnumMember = (
  context: SemanticContext.SemanticContext,
  node: AuthoredHir.Expression,
  resolution: ResolutionContext,
  expected?: SemanticType,
): ExpressionResult | undefined => {
  const identifiers = nameSegments(node)
  const qualifierToken = identifiers.at(0)
  const memberToken = identifiers.at(1)
  if (qualifierToken === undefined || memberToken === undefined || identifiers.length !== 2)
    return undefined
  const qualifier = SemanticContext.nameText(context, qualifierToken) ?? ''
  const enumLookup = Semantic.resolveName(resolution.semantic, resolution.scope, qualifier)
  if (enumLookup._tag !== 'Resolved' || enumLookup.declaration._tag !== 'EnumDeclaration')
    return undefined
  const enum_ = enumLookup.declaration
  const memberName = SemanticContext.nameText(context, memberToken) ?? ''
  const memberLookup = DeclarationFacts.lookupEnumMember(enum_.members, memberName)
  const member = memberLookup._tag === 'Resolved' ? memberLookup.member : undefined
  // An enum owns inherent members beside its members; `Status.describe` is a function item, not a
  // misspelled member, when an impl declares it.
  if (
    member === undefined &&
    Semantic.resolveAssociatedName(resolution.semantic, enum_, memberName, resolution.scope.module)
      ._tag !== 'Missing'
  )
    return undefined
  const nominal =
    enum_.canonical._tag === 'Canonical'
      ? Type.nominal(enum_.canonical.id.module, enum_.canonical.id.name)
      : undefined
  const expectedEnum =
    expected === undefined ? undefined : enumFactByType(resolution.index, expected)
  const memberPathSpan = Location.at(node.anchor)
  let wrongEnum: Diagnostic.Located | undefined
  if (
    nominal !== undefined &&
    expected !== undefined &&
    expectedEnum?.canonical._tag === 'Canonical' &&
    !Type.equals(nominal, expected)
  ) {
    wrongEnum = Diagnostic.wrongEnumMember(
      Type.display(expected),
      Type.display(nominal),
      memberPathSpan,
    )
  } else if (
    nominal !== undefined &&
    typeof expected === 'string' &&
    Scalar.isIntegerSpelling(expected)
  ) {
    wrongEnum = Diagnostic.enumIntegerMismatch(
      Type.display(nominal),
      expected,
      'EnumToInteger',
      memberPathSpan,
    )
  } else {
    wrongEnum = undefined
  }
  const unknown =
    member === undefined
      ? Diagnostic.unknownEnumMember(qualifier, memberName, Location.at(memberToken.anchor))
      : undefined
  const invalidMember =
    member !== undefined &&
    (member.canonical._tag !== 'Canonical' || member.discriminant._tag !== 'Available')
  const diagnostic = unknown ?? wrongEnum
  const type =
    nominal !== undefined && member !== undefined && !invalidMember && diagnostic === undefined
      ? availableExpressionType(nominal)
      : unavailableExpressionType
  return {
    fact: {
      _tag: 'EnumMember',
      enum: enum_,
      ...(member === undefined ? {} : { member }),
      ...(diagnostic === undefined ? {} : { cause: Diagnostic.identity(diagnostic) }),
      qualifierAnchor: qualifierToken.anchor,
      memberAnchor: memberToken.anchor,
      type,
      anchor: node.anchor,
    },
    diagnostics: diagnostic === undefined ? [] : [diagnostic],
    type: type._tag === 'Available' ? type.type : undefined,
  }
}

const analyzeEnumValueCall = (
  context: SemanticContext.SemanticContext,
  node: AuthoredHir.Expression,
  argumentsResult: ArgumentsResult,
  declaration: DeclarationFact,
  resolution: ResolutionContext,
): ExpressionResult | undefined => {
  const identifiers = referenceNames(node)
  const qualifierToken = identifiers.at(0)
  const operationToken = identifiers.at(1)
  if (qualifierToken === undefined || operationToken === undefined || identifiers.length !== 2)
    return undefined
  const qualifier = SemanticContext.nameText(context, qualifierToken) ?? ''
  const operationName = SemanticContext.nameText(context, operationToken) ?? ''
  const qualifierLookup = Semantic.resolveName(resolution.semantic, resolution.scope, qualifier)
  if (qualifierLookup._tag !== 'Resolved' || qualifierLookup.declaration._tag !== 'EnumDeclaration')
    return undefined
  const operation = qualifierLookup.declaration.associatedOperations.find(
    (candidate) => candidate.name === operationName,
  )
  if (operation === undefined) return undefined
  const argument = argumentsResult.facts.at(0)
  const actual = argument?.type._tag === 'Available' ? argument.type.type : undefined
  let mismatch: Diagnostic.Located | undefined
  if (actual === undefined || Type.equals(actual, operation.parameter)) {
    mismatch = undefined
  } else if (enumFactByType(resolution.index, actual) !== undefined) {
    mismatch = Diagnostic.wrongEnumMember(
      Type.display(operation.parameter),
      Type.display(actual),
      Location.at(argument?.anchor ?? node.anchor),
    )
  } else if (typeof actual === 'string' && Scalar.isIntegerSpelling(actual)) {
    mismatch = Diagnostic.enumIntegerMismatch(
      Type.display(operation.parameter),
      actual,
      'IntegerToEnum',
      Location.at(argument?.anchor ?? node.anchor),
    )
  } else {
    mismatch = Diagnostic.argumentTypeMismatch(
      Type.display(operation.parameter),
      Type.display(actual),
      Location.at(argument?.anchor ?? node.anchor),
    )
  }
  const arity =
    argumentsResult.facts.length === 1
      ? undefined
      : Diagnostic.wrongCallArity(
          {
            _tag: 'BuiltinTarget',
            actor: qualifier,
            operation: 'value',
          },
          1,
          argumentsResult.facts.length,
          Location.at(node.anchor),
        )
  const valid = argument !== undefined && mismatch === undefined && arity === undefined
  const type = valid
    ? availableExpressionType(operation.result.spelling)
    : unavailableExpressionType
  return {
    fact: {
      _tag: 'EnumValue',
      operation,
      argument:
        argument?.expression ??
        expressionNode(unavailableExpressionResult(context, node.anchor, declaration, resolution)),
      qualifierAnchor: qualifierToken.anchor,
      operationAnchor: operationToken.anchor,
      type,
      anchor: node.anchor,
    },
    diagnostics: [
      ...argumentsResult.diagnostics,
      ...(mismatch === undefined ? [] : [mismatch]),
      ...(arity === undefined ? [] : [arity]),
    ],
    type: type._tag === 'Available' ? type.type : undefined,
  }
}

/**
 * The name segments one authored expression or type spells, at most a qualifier and a member.
 *
 * Grouped expressions do not exist in authored HIR and a path carries its segments directly, so
 * this replaces every scan for identifier tokens below a node.
 */
export const nameSegments = (
  node: AuthoredHir.Expression | AuthoredHir.Type | AuthoredHir.Pattern,
): ReadonlyArray<AuthoredHir.Name> => {
  switch (node._tag) {
    case 'IdentifierExpression':
      return [node.name]
    case 'NamedType':
      return node.path.segments
    case 'AppliedType':
      return nameSegments(node.target)
    case 'EnumPattern':
      return node.path.segments
    case 'NominalPattern':
      return nameSegments(node.type)
    case 'StructExpression':
      return nameSegments(node.type)
    // A call and a type application spell their target through a nested node, so a constructor
    // call names its aggregate the same way a written literal does.
    case 'CallExpression':
      return nameSegments(node.callee)
    case 'MemberExpression':
      return [...nameSegments(node.selector.subject), node.selector.member]
    case 'VariantPattern':
      return [...nameSegments(node.selector.subject), node.selector.member]
    case 'FieldExpression':
      return [...nameSegments(node.subject), node.field]
    default:
      return []
  }
}

export const analyzeConstantReference = (
  context: SemanticContext.SemanticContext,
  node: AuthoredHir.Expression,
  resolution: ResolutionContext,
): ExpressionResult | undefined => {
  const identifiers = nameSegments(node)
  const first = identifiers.at(0)
  const second = identifiers.at(1)
  if (first === undefined || identifiers.length > 2) return undefined
  const lookup =
    second === undefined
      ? Semantic.resolveName(
          resolution.semantic,
          resolution.scope,
          SemanticContext.nameText(context, first) ?? '',
        )
      : Semantic.resolveQualifiedName(
          resolution.semantic,
          resolution.scope,
          SemanticContext.nameText(context, first) ?? '',
          SemanticContext.nameText(context, second) ?? '',
          second.anchor,
        )
  if (
    lookup._tag !== 'Resolved' ||
    (lookup.declaration._tag !== 'ConstantDeclaration' &&
      lookup.declaration._tag !== 'PackageParameterDeclaration')
  )
    return undefined
  const result = analyzeConstant(context, lookup.declaration, node.anchor, false)
  if (
    lookup.declaration.literal._tag !== 'Unavailable' ||
    resolution.staticContext?.constant === undefined
  )
    return result
  const selected = resolution.staticContext.constant(
    lookup.declaration,
    Location.at(node.anchor),
    resolution.staticContext.trace,
  )
  if (selected._tag === 'Failed') return result
  const value: ConstantExpressionDecision['value'] = (() => {
    const candidate = selected.value
    if (candidate._tag === 'BooleanValue')
      return { _tag: 'Boolean' as const, value: candidate.value }
    if (candidate._tag === 'CharacterValue')
      return { _tag: 'Character' as const, value: candidate.value }
    if (candidate._tag === 'IntegerValue')
      return {
        _tag: 'Integer' as const,
        value: candidate.value,
        type: candidate.type,
      }
    if (candidate._tag === 'FloatValue')
      return {
        _tag: 'Floating' as const,
        bits: candidate.bits,
        spelling: StaticValue.encode(candidate),
        type: candidate.type,
      }
    if (candidate._tag === 'TextValue') {
      const bytes = [...candidate.bytes]
      return {
        _tag: 'String' as const,
        data: {
          _tag: 'StaticData' as const,
          id: `text:${bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('')}`,
          kind: 'Text' as const,
          bytes,
          utf8: true,
        },
      }
    }
    return undefined
  })()
  return value === undefined || result.fact._tag !== 'Constant'
    ? result
    : {
        ...result,
        fact: { ...result.fact, value },
      }
}

export const analyzeForeignStaticReference = (
  context: SemanticContext.SemanticContext,
  node: AuthoredHir.Expression,
  resolution: ResolutionContext,
): ExpressionResult | undefined => {
  const identifiers = nameSegments(node)
  const first = identifiers.at(0)
  const second = identifiers.at(1)
  if (first === undefined || identifiers.length > 2) return undefined
  const lookup =
    second === undefined
      ? Semantic.resolveName(
          resolution.semantic,
          resolution.scope,
          SemanticContext.nameText(context, first) ?? '',
        )
      : Semantic.resolveQualifiedName(
          resolution.semantic,
          resolution.scope,
          SemanticContext.nameText(context, first) ?? '',
          SemanticContext.nameText(context, second) ?? '',
          second.anchor,
        )
  if (lookup._tag !== 'Resolved' || lookup.declaration._tag !== 'ForeignStaticDeclaration')
    return undefined
  const type =
    lookup.declaration.declaredType._tag === 'Resolved'
      ? availableExpressionType(lookup.declaration.declaredType.type)
      : unavailableExpressionType
  const unsafeDiagnostic = unsafeCallDiagnostic(
    lookup.declaration.direction === 'Import',
    lookup.declaration.foreign.symbol,
    node,
    context.spanOf(node.anchor),
    resolution,
  )
  return {
    fact: {
      _tag: 'ForeignStatic',
      declaration: lookup.declaration,
      type,
      anchor: node.anchor,
    },
    diagnostics: unsafeDiagnostic === undefined ? [] : [unsafeDiagnostic],
    type: type._tag === 'Available' ? type.type : undefined,
  }
}

export interface MoveResult {
  readonly fact: MoveExpressionDecision
  readonly diagnostics: ReadonlyArray<Diagnostic.Located>
  readonly type: SemanticType | undefined
}

export const analyzeMove = (
  context: SemanticContext.SemanticContext,
  node: Extract<AuthoredHir.Expression, { readonly _tag: 'MoveExpression' }>,
  declarations: ReadonlyArray<DeclarationFact>,
  declaration: DeclarationFact,
  scope: Scope,
  resolution: ResolutionContext,
): MoveResult => {
  const subjectNode = AuthoredWalk.expressionChildren(node).at(0)
  const subject =
    subjectNode === undefined
      ? undefined
      : analyzeExpression(context, subjectNode, declarations, declaration, scope, resolution)
  if (subject === undefined) throw new RangeError('Move expression requires a subject expression')
  const invalidMove =
    subject.fact._tag === 'Constant'
      ? Diagnostic.invalidConstant(
          'constants are immediate values and cannot be moved',
          Location.at(node.anchor),
        )
      : undefined
  const callableMetadata = (() => {
    const fact = subject.fact
    if (fact._tag === 'FunctionItem' || fact._tag === 'CallableSection')
      return { exactCallable: fact, concreteCallableIdentity: true as const }
    if (fact._tag === 'Move' && fact.exactCallable !== undefined)
      return {
        exactCallable: fact.exactCallable,
        ...(fact.concreteCallableIdentity === true
          ? { concreteCallableIdentity: true as const }
          : {}),
      }
    if (fact._tag === 'Identifier' && fact.reference._tag === 'ResolvedBinding')
      return {
        ...(fact.reference.binding.exactCallable === undefined
          ? {}
          : { exactCallable: fact.reference.binding.exactCallable }),
        ...(fact.reference.binding.concreteCallableIdentity === true
          ? { concreteCallableIdentity: true as const }
          : {}),
      }
    return {}
  })()
  return {
    fact: {
      _tag: 'Move',
      subject: expressionNode(subject),
      ...callableMetadata,
      type: subject.fact.type,
      anchor: node.anchor,
    },
    diagnostics:
      invalidMove === undefined ? subject.diagnostics : [...subject.diagnostics, invalidMove],
    type: invalidMove === undefined ? subject.type : undefined,
  }
}

const borrowsConstant = (subject: ExpressionDecision): boolean => subject._tag === 'Constant'

export const borrowRoot = (
  context: SemanticContext.SemanticContext,
  subject: ExpressionDecision,
): BorrowRootFact | undefined => {
  if (
    subject._tag === 'ReferentProjection' ||
    subject._tag === 'FieldProjection' ||
    subject._tag === 'IndexProjection'
  )
    return subject.borrowRoot
  if (subject._tag !== 'Identifier') return undefined
  if (subject.reference._tag === 'ResolvedBinding') {
    return {
      _tag: 'BindingRoot',
      binding: subject.reference.binding,
      path: [],
    }
  }
  if (subject.reference._tag === 'Resolved') {
    return {
      _tag: 'ParameterRoot',
      parameter: subject.reference.parameter,
      path: [],
    }
  }
  if (subject.reference._tag === 'ResolvedPattern') {
    return {
      _tag: 'PatternRoot',
      binding: subject.reference.binding,
      path: [],
    }
  }
  return undefined
}

export const exclusiveBorrowRoot = (root: BorrowRootFact): boolean =>
  root._tag === 'TemporaryRoot' ||
  (root._tag === 'BindingRoot' && root.binding.mutability === 'Mutable') ||
  (root._tag === 'PatternRoot' && root.binding.access === 'Exclusive') ||
  (root._tag === 'ParameterRoot' &&
    ((root.parameter.bindingMutability === 'Mutable' &&
      root.parameter.declaredType._tag === 'Resolved' &&
      !Type.isReference(root.parameter.declaredType.type) &&
      !Type.isSlice(root.parameter.declaredType.type)) ||
      (root.path.length > 0 &&
        root.parameter.declaredType._tag === 'Resolved' &&
        Type.isReference(root.parameter.declaredType.type) &&
        root.parameter.declaredType.type.access === 'Exclusive')))

const combinedBorrowAccess = (
  inherited: Type.BorrowAccess | undefined,
  current: Type.BorrowAccess | undefined,
): Type.BorrowAccess | undefined => {
  if (inherited === 'Shared' || current === 'Shared') return 'Shared'
  if (inherited === 'Exclusive' || current === 'Exclusive') return 'Exclusive'
  return undefined
}

export const unavailableBorrow = (
  node: AuthoredHir.Expression,
  access: Type.BorrowAccess,
  subject: Tir.Expression,
  diagnostics: ReadonlyArray<Diagnostic.Located>,
  cause?: Diagnostic.Located,
): ExpressionResult => ({
  fact: {
    _tag: 'Borrow',
    access,
    subject,
    formation: {
      _tag: 'Unavailable',
      ...(cause === undefined ? {} : { cause: Diagnostic.identity(cause) }),
    },
    type: unavailableExpressionType,
    anchor: node.anchor,
  },
  diagnostics: [...diagnostics, ...(cause === undefined ? [] : [cause])],
  type: undefined,
})

export const analyzeBorrow = (
  context: SemanticContext.SemanticContext,
  node: Extract<AuthoredHir.Expression, { readonly _tag: 'BorrowExpression' }>,
  declarations: ReadonlyArray<DeclarationFact>,
  declaration: DeclarationFact,
  scope: Scope,
  resolution: ResolutionContext,
  expected: SemanticType | undefined,
): ExpressionResult => {
  const access: Type.BorrowAccess =
    node._tag === 'BorrowExpression' && node.access === 'Mutable' ? 'Exclusive' : 'Shared'
  const subjectNode = node._tag === 'BorrowExpression' ? node.operand : undefined
  const subjectResult =
    subjectNode === undefined
      ? undefined
      : analyzeExpression(context, subjectNode, declarations, declaration, scope, resolution)
  return borrowSubject(
    context,
    node,
    subjectNode,
    subjectResult,
    access,
    expected,
    declaration,
    resolution,
  )
}

/**
 * Forms one borrow of an already analyzed subject: the written `&`/`&mut` form after its
 * position check, and a receiver synthesized for a method call whose parameter zero is a reference.
 */
export const borrowSubject = (
  context: SemanticContext.SemanticContext,
  node: AuthoredHir.Expression,
  subjectNode: AuthoredHir.Expression | undefined,
  subjectResult: ExpressionResult | undefined,
  access: Type.BorrowAccess,
  expected: SemanticType | undefined,
  declaration: DeclarationFact,
  resolution: ResolutionContext,
): ExpressionResult => {
  const subjectFact = subjectResult?.fact ?? unavailableExpression(node.anchor)
  const subject =
    subjectResult === undefined
      ? BodyBuilder.tirExpression(subjectFact, {
          context,
          ...(resolution.builder === undefined ? {} : { builder: resolution.builder }),
          ...(declaration.phase === 'Static' && resolution.builder !== undefined
            ? { static: resolution.builder.expressions }
            : {}),
        })
      : expressionNode(subjectResult)
  const diagnostics = subjectResult?.diagnostics ?? []
  if (borrowsConstant(subjectFact))
    return unavailableBorrow(
      node,
      access,
      subject,
      diagnostics,
      Diagnostic.invalidConstant(
        'constants are immediate values and cannot be borrowed',
        Location.at(node.anchor),
      ),
    )
  const lifetime =
    resolution.bodyLifetimes === undefined
      ? undefined
      : BodyLifetime.region(resolution.bodyLifetimes, node.anchor, 'Borrow')
  const sourceType = subjectResult?.type
  const root =
    borrowRoot(context, subjectFact) ??
    (sourceType === undefined
      ? undefined
      : {
          _tag: 'TemporaryRoot' as const,
          owner: {
            _tag: 'TemporaryOwnerId' as const,
            node: Tir.nodeReference(
              (() => {
                if (resolution.builder === undefined)
                  throw new RangeError('temporary borrow requires its TIR body builder')
                return resolution.builder.artifact
              })(),
              subject,
            ),
          },
          value: subject,
          path: [],
        })
  if (root === undefined || sourceType === undefined || lifetime === undefined) {
    return unavailableBorrow(
      node,
      access,
      subject,
      diagnostics,
      Diagnostic.invalidBorrowOperand(
        (subjectNode === undefined ? undefined : Location.at(subjectNode.anchor)) ??
          Location.at(node.anchor),
      ),
    )
  }
  const projectedReference =
    subjectFact._tag === 'ReferentProjection' && subjectFact.state._tag === 'Resolved'
      ? subjectFact.state.reference
      : undefined
  const parentReference = Type.isReference(sourceType) ? sourceType : projectedReference
  if (resolution.bodyLifetimes !== undefined) {
    if (parentReference !== undefined)
      BodyLifetime.constrain(resolution.bodyLifetimes, parentReference.lifetime, lifetime)
    if (Type.isSlice(sourceType))
      BodyLifetime.constrain(resolution.bodyLifetimes, sourceType.lifetime, lifetime)
  }
  if (
    parentReference !== undefined &&
    (projectedReference !== undefined || (expected !== undefined && Type.isReference(expected)))
  ) {
    const target = parentReference.target
    if (
      (expected !== undefined &&
        (!Type.isReference(expected) ||
          !TypeInference.infer(expected.target, target, new Map()) ||
          expected.access !== access)) ||
      (parentReference.access === 'Shared' && access === 'Exclusive')
    ) {
      return unavailableBorrow(
        node,
        access,
        subject,
        diagnostics,
        Diagnostic.invalidBorrowOperand(
          (subjectNode === undefined ? undefined : Location.at(subjectNode.anchor)) ??
            Location.at(node.anchor),
        ),
      )
    }
    const type = Type.reference(access, target, lifetime)
    return {
      fact: {
        _tag: 'Borrow',
        access,
        subject,
        formation: {
          _tag: 'ValueReborrow',
          root,
          parent: parentReference,
          suspendsParent: parentReference.access === 'Exclusive',
        },
        type: availableExpressionType(type),
        anchor: node.anchor,
      },
      diagnostics,
      type,
    }
  }
  if (
    (expected === undefined || (!Type.isSlice(expected) && !Type.isReference(expected))) &&
    !Type.isFixedArray(sourceType) &&
    !Type.isSlice(sourceType)
  ) {
    if (access === 'Exclusive' && !exclusiveBorrowRoot(root)) {
      const name =
        subjectFact._tag === 'Identifier' && 'spelling' in subjectFact.reference
          ? subjectFact.reference.spelling
          : '?'
      return unavailableBorrow(
        node,
        access,
        subject,
        diagnostics,
        Diagnostic.exclusiveBorrowRequiresMutable(
          name,
          (subjectNode === undefined ? undefined : Location.at(subjectNode.anchor)) ??
            Location.at(node.anchor),
        ),
      )
    }
    const type = Type.reference(access, sourceType, lifetime)
    return {
      fact: {
        _tag: 'Borrow',
        access,
        subject,
        formation: { _tag: 'ValueBorrow', root, source: sourceType },
        type: availableExpressionType(type),
        anchor: node.anchor,
      },
      diagnostics,
      type,
    }
  }
  if (expected !== undefined && Type.isReference(expected)) {
    if (!TypeInference.infer(expected.target, sourceType, new Map())) {
      return unavailableBorrow(
        node,
        access,
        subject,
        diagnostics,
        Diagnostic.invalidBorrowOperand(
          (subjectNode === undefined ? undefined : Location.at(subjectNode.anchor)) ??
            Location.at(node.anchor),
        ),
      )
    }
    if (access === 'Exclusive' && !exclusiveBorrowRoot(root)) {
      const name =
        subjectFact._tag === 'Identifier' && 'spelling' in subjectFact.reference
          ? subjectFact.reference.spelling
          : '?'
      return unavailableBorrow(
        node,
        access,
        subject,
        diagnostics,
        Diagnostic.exclusiveBorrowRequiresMutable(
          name,
          (subjectNode === undefined ? undefined : Location.at(subjectNode.anchor)) ??
            Location.at(node.anchor),
        ),
      )
    }
    if (access !== expected.access) {
      return unavailableBorrow(
        node,
        access,
        subject,
        diagnostics,
        Diagnostic.invalidBorrowOperand(
          (subjectNode === undefined ? undefined : Location.at(subjectNode.anchor)) ??
            Location.at(node.anchor),
        ),
      )
    }
    const type = Type.reference(access, sourceType, lifetime)
    return {
      fact: {
        _tag: 'Borrow',
        access,
        subject,
        formation: { _tag: 'ValueBorrow', root, source: sourceType },
        type: availableExpressionType(type),
        anchor: node.anchor,
      },
      diagnostics,
      type,
    }
  }
  if (Type.isFixedArray(sourceType)) {
    if (access === 'Exclusive' && !exclusiveBorrowRoot(root)) {
      const name =
        subjectFact._tag === 'Identifier' && 'spelling' in subjectFact.reference
          ? subjectFact.reference.spelling
          : '?'
      return unavailableBorrow(
        node,
        access,
        subject,
        diagnostics,
        Diagnostic.exclusiveBorrowRequiresMutable(
          name,
          (subjectNode === undefined ? undefined : Location.at(subjectNode.anchor)) ??
            Location.at(node.anchor),
        ),
      )
    }
    const type = Type.slice(access, sourceType.element, lifetime)
    return {
      fact: {
        _tag: 'Borrow',
        access,
        subject,
        formation: { _tag: 'FixedArrayBorrow', root, array: sourceType },
        type: availableExpressionType(type),
        anchor: node.anchor,
      },
      diagnostics,
      type,
    }
  }
  if (Type.isSlice(sourceType)) {
    if (sourceType.access === 'Shared' && access === 'Exclusive') {
      return unavailableBorrow(
        node,
        access,
        subject,
        diagnostics,
        Diagnostic.invalidSliceReborrow(sourceType.access, access, Location.at(node.anchor)),
      )
    }
    const type = Type.slice(access, sourceType.element, lifetime)
    return {
      fact: {
        _tag: 'Borrow',
        access,
        subject,
        formation: {
          _tag: 'SliceReborrow',
          root,
          parent: sourceType,
          suspendsParent: sourceType.access === 'Exclusive',
        },
        type: availableExpressionType(type),
        anchor: node.anchor,
      },
      diagnostics,
      type,
    }
  }
  return unavailableBorrow(
    node,
    access,
    subject,
    diagnostics,
    Diagnostic.invalidBorrowOperand(
      (subjectNode === undefined ? undefined : Location.at(subjectNode.anchor)) ??
        Location.at(node.anchor),
    ),
  )
}

export interface StructTargetResult {
  readonly fact: StructTargetFact
  readonly diagnostics: ReadonlyArray<Diagnostic.Located>
}

export interface UnionVariantTargetResult {
  readonly fact: UnionVariantTargetFact
  readonly diagnostics: ReadonlyArray<Diagnostic.Located>
}

/** The declaration-scoped lifetime context of the body under analysis, when it has one. */
const bodyLifetimeContext = (
  context: SemanticContext.SemanticContext,
  resolution: ResolutionContext,
  parameters: ReadonlyMap<string, Type.Parameter>,
): DeclarationLifetime.Context | undefined =>
  resolution.bodyLifetimes === undefined || resolution.authoredDeclaration === undefined
    ? undefined
    : DeclarationLifetime.forBody(
        context,
        resolution.bodyLifetimes,
        resolution.authoredDeclaration,
        parameters,
      )

export const intrinsicStruct = (
  type: Type.Nominal,
  syntax: AuthoredHir.Expression | AuthoredHir.Type,
  anchor: AuthoredHir.Anchor,
): DeclarationFacts.StructFact => {
  const ordinal = Type.intrinsicNominalOrdinal(type)
  const id: DeclarationFacts.DeclarationId = {
    _tag: 'DeclarationId',
    sourceId: type.module,
    ordinal,
  }
  let fieldTypes: ReadonlyArray<readonly [string, Type.Type]>
  if (Type.equals(type, Type.layout)) {
    fieldTypes = [['bytes', 'usize'] as const, ['alignment', 'usize'] as const]
  } else if (Type.equals(type, Type.invalidAlignment)) {
    fieldTypes = [['alignment', 'usize'] as const]
  } else if (Type.equals(type, Type.testInfo)) {
    fieldTypes = [
      ['identity', Type.string(Lifetime.staticLifetime)] as const,
      ['name', Type.string(Lifetime.staticLifetime)] as const,
      ['module', Type.string(Lifetime.staticLifetime)] as const,
      ['path', Type.string(Lifetime.staticLifetime)] as const,
      ['line', 'usize'] as const,
      ['column', 'usize'] as const,
      ['fingerprint', Type.string(Lifetime.staticLifetime)] as const,
    ]
  } else {
    fieldTypes = []
  }
  return {
    _tag: 'StructDeclaration',
    id,
    canonical: {
      _tag: 'Canonical',
      id: {
        _tag: 'CanonicalDeclarationId',
        module: type.module,
        name: type.name,
      },
    },
    visibility:
      Type.equals(type, Type.layout) ||
      Type.equals(type, Type.invalidAlignment) ||
      Type.equals(type, Type.testInfo)
        ? 'Public'
        : 'Private',
    layout: { _tag: 'Silk' },
    typeParameters: [],
    name: { _tag: 'Present', spelling: type.name, anchor },
    aggregateKind: 'Named',
    fields: fieldTypes.map(([name, fieldType], fieldOrdinal) => ({
      _tag: 'AggregateField' as const,
      id: {
        _tag: 'FieldId' as const,
        owner: { _tag: 'StructFieldOwnerId' as const, declaration: id },
        ordinal: fieldOrdinal,
      },
      member: AggregateIdentity.labeled(name),
      state: {
        _tag: 'Unique' as const,
        id: {
          _tag: 'FieldId' as const,
          owner: { _tag: 'StructFieldOwnerId' as const, declaration: id },
          ordinal: fieldOrdinal,
        },
      },
      visibility: 'Public' as const,
      name: { _tag: 'Present' as const, spelling: name, anchor },
      declaredType: {
        _tag: 'Resolved' as const,
        type: fieldType,
        spelling: Type.encode(fieldType),
        anchor: syntax.anchor,
      },
      anchor: syntax.anchor,
    })),
    dependency: { _tag: 'Available', types: [] },
    anchor: syntax.anchor,
  }
}

export const resolveStructTarget = (
  context: SemanticContext.SemanticContext,
  syntax: AuthoredHir.Type,
  resolution: ResolutionContext,
  caller?: DeclarationFact,
  inferConstructionArguments = false,
): StructTargetResult => {
  const environment = new Map(
    (caller?.typeParameters ?? []).flatMap((parameter) =>
      parameter.name._tag === 'Present' ? [[parameter.name.spelling, parameter.type] as const] : [],
    ),
  )
  const analyzed = DeclarationCollection.analyzeDeclaredType(
    context,
    syntax,
    environment,
    false,
    bodyLifetimeContext(context, resolution, environment),
  )
  const nameResolution: NameResolution.Resolution = {
    _tag: 'NameResolution',
    modules: [resolution.scope],
    contexts: SemanticContext.registry([context]),
    diagnostics: [],
  }
  if (inferConstructionArguments) {
    const applied = analyzed.fact._tag === 'Applied' ? analyzed.fact : undefined
    const targetFact = applied?.target ?? analyzed.fact
    const path = targetFact._tag === 'Unresolved' ? targetFact.path : undefined
    let base: Type.Nominal | undefined
    if (path === undefined) {
      if (targetFact._tag === 'Resolved' && Type.isNominal(targetFact.type)) base = targetFact.type
    } else {
      const candidate = NameResolution.resolveType(
        nameResolution,
        resolution.index,
        AuthoredWalk.moduleName(context),
        path,
      ).fact
      if (candidate._tag === 'Resolved' && Type.isNominal(candidate.type)) base = candidate.type
    }
    const candidate =
      base === undefined
        ? undefined
        : DeclarationFacts.byCanonical(resolution.index, {
            _tag: 'CanonicalDeclarationId',
            module: base.module,
            name: base.name,
          })
    // A base that already carries arguments came through an alias; its arguments are final, so
    // the ordinary resolution below keeps them instead of re-inferring from the literal.
    if (
      base !== undefined &&
      base.arguments.length === 0 &&
      candidate?._tag === 'StructDeclaration'
    ) {
      const supplied = applied?.arguments ?? []
      const sourceParameters = candidate.typeParameters.filter(
        (parameter) =>
          parameter.type.kind !== 'CallableRepresentation' &&
          parameter.type.kind !== 'EffectRepresentation',
      )
      if (supplied.length <= sourceParameters.length) {
        const valueParameters = sourceParameters.filter(
          (parameter) => parameter.type.kind !== 'Lifetime',
        )
        let suppliedOrdinal = 0
        const resolvedArguments = supplied.map((argument) =>
          DeclarationResolution.resolveGenericArgumentFact(
            context.spanOf,
            resolution.index,
            AuthoredWalk.moduleName(context),
            argument,
            argument._tag === 'Lifetime' ? undefined : valueParameters.at(suppliedOrdinal++)?.type,
            (module, argumentPath) =>
              NameResolution.resolveType(nameResolution, resolution.index, module, argumentPath),
          ),
        )
        const suppliedLifetimes = resolvedArguments.filter(
          (argument) => argument.fact._tag === 'Lifetime',
        )
        const suppliedValues = resolvedArguments.filter(
          (argument) => argument.fact._tag !== 'Lifetime',
        )
        let lifetimeOrdinal = 0
        let valueOrdinal = 0
        const arguments_ = candidate.typeParameters.flatMap(
          (parameter): ReadonlyArray<Type.GenericArgument> => {
            if (
              parameter.type.kind === 'CallableRepresentation' ||
              parameter.type.kind === 'EffectRepresentation'
            )
              return [Type.representationParameterArgument(parameter.type)]
            if (parameter.type.kind === 'Lifetime') {
              const resolved = suppliedLifetimes.at(lifetimeOrdinal)
              lifetimeOrdinal += 1
              return resolved?.fact._tag === 'Lifetime'
                ? [resolved.fact.lifetime]
                : [Type.parameterArgument(parameter.type)]
            }
            const resolved = suppliedValues.at(valueOrdinal)
            valueOrdinal += 1
            if (resolved === undefined) return [Type.parameterArgument(parameter.type)]
            if (parameter.type.kind === 'RequirementRow')
              return resolved.argument !== undefined &&
                Type.isRequirementRowArgument(resolved.argument)
                ? [resolved.argument]
                : []
            if (resolved?.fact._tag !== 'Resolved') return []
            if (parameter.type.kind === 'Value')
              return Type.isTypeArgument(resolved.fact.type) ? [resolved.fact.type] : []
            return []
          },
        )
        if (
          arguments_.length === candidate.typeParameters.length &&
          suppliedLifetimes.length <= lifetimeOrdinal &&
          suppliedValues.length <= valueOrdinal
        ) {
          const parameters = candidate.typeParameters.map((parameter) => parameter.type)
          if (TypeInference.prefixSubstitution(parameters, arguments_) !== undefined) {
            const token = nameSegments(syntax).at(-1)?.anchor
            if (token !== undefined)
              return {
                fact: {
                  _tag: 'Resolved',
                  struct: candidate,
                  type: Type.specializeNominal(base, arguments_),
                  anchor: token,
                },
                diagnostics: Diagnostic.collect(
                  analyzed.diagnostics,
                  ...resolvedArguments.map((argument) => argument.diagnostics),
                ),
              }
          }
        }
      }
    }
  }
  const resolved = DeclarationResolution.resolveTypeFact(
    context.spanOf,
    resolution.index,
    AuthoredWalk.moduleName(context),
    analyzed.fact,
    (module, path) => NameResolution.resolveType(nameResolution, resolution.index, module, path),
  )
  if (resolved.fact._tag === 'Resolved' && Type.isNominal(resolved.fact.type)) {
    if (Type.isIntrinsicNominal(resolved.fact.type) && !Type.isSharedCore(resolved.fact.type)) {
      const token = nameSegments(syntax).at(-1)?.anchor
      if (token !== undefined)
        return {
          fact: {
            _tag: 'Resolved',
            struct: intrinsicStruct(resolved.fact.type, syntax, token),
            type: resolved.fact.type,
            anchor: token,
          },
          diagnostics: Diagnostic.collect(analyzed.diagnostics, resolved.diagnostics),
        }
    }
    const declaration = DeclarationFacts.byCanonical(resolution.index, {
      _tag: 'CanonicalDeclarationId',
      module: resolved.fact.type.module,
      name: resolved.fact.type.name,
    })
    if (declaration?._tag === 'StructDeclaration') {
      const token = nameSegments(syntax).at(-1)?.anchor
      if (token === undefined)
        return {
          fact: { _tag: 'Unavailable' },
          diagnostics: Diagnostic.collect(analyzed.diagnostics, resolved.diagnostics),
        }
      return {
        fact: {
          _tag: 'Resolved',
          struct: declaration,
          type: resolved.fact.type,
          anchor: token,
        },
        diagnostics: Diagnostic.collect(analyzed.diagnostics, resolved.diagnostics),
      }
    }
  }
  const token = nameSegments(syntax).at(-1)?.anchor
  const diagnostic = Diagnostic.expectedType(
    resolved.fact._tag === 'Resolved' ? Type.display(resolved.fact.type) : 'unavailable struct',
    token === undefined ? Location.at(syntax.anchor) : Location.at(token),
  )
  return {
    fact: { _tag: 'Unavailable', cause: Diagnostic.identity(diagnostic) },
    diagnostics: Diagnostic.collect(analyzed.diagnostics, resolved.diagnostics, [diagnostic]),
  }
}

const unavailableUnionVariantTarget = (
  diagnostic: Diagnostic.Located,
  diagnostics: ReadonlyArray<Diagnostic.Located> = [],
): UnionVariantTargetResult => ({
  fact: { _tag: 'Unavailable', cause: Diagnostic.identity(diagnostic) },
  diagnostics: Diagnostic.collect(diagnostics, [diagnostic]),
})

const selectedUnionVariant = (
  context: SemanticContext.SemanticContext,
  union: DeclarationFacts.UnionFact,
  type: Type.Nominal,
  variantName: string,
  token: AuthoredHir.Name,
  diagnostics: ReadonlyArray<Diagnostic.Located>,
): UnionVariantTargetResult => {
  const variant = DeclarationFacts.lookupUnionVariant(union.variants, variantName)
  if (variant._tag !== 'Resolved')
    return unavailableUnionVariantTarget(
      Diagnostic.unknownUnionVariant(Type.display(type), variantName, Location.at(token.anchor)),
      diagnostics,
    )
  if (union.validity._tag !== 'Valid')
    return unavailableUnionVariantTarget(
      Diagnostic.invalidNominalUnionConstruction(Type.display(type), Location.at(token.anchor)),
      diagnostics,
    )
  return {
    fact: {
      _tag: 'Resolved',
      union,
      variant: variant.variant,
      type,
      anchor: token.anchor,
    },
    diagnostics: diagnostics,
  }
}

export const resolveUnionVariantTarget = (
  context: SemanticContext.SemanticContext,
  selector: AuthoredHir.MemberSelector,
  resolution: ResolutionContext,
  caller?: DeclarationFact,
): UnionVariantTargetResult => {
  const parentSyntax = selector.subject
  const variantToken = selector.member
  if (parentSyntax === undefined || variantToken === undefined) {
    const diagnostic = Diagnostic.expectedNominalUnion(
      'unavailable selector',
      Location.at(selector.anchor),
    )
    return unavailableUnionVariantTarget(diagnostic)
  }
  const environment = new Map(
    (caller?.typeParameters ?? []).flatMap((parameter) =>
      parameter.name._tag === 'Present' ? [[parameter.name.spelling, parameter.type] as const] : [],
    ),
  )
  const analyzed = DeclarationCollection.analyzeDeclaredType(
    context,
    parentSyntax,
    environment,
    false,
    bodyLifetimeContext(context, resolution, environment),
  )
  const nameResolution: NameResolution.Resolution = {
    _tag: 'NameResolution',
    modules: [resolution.scope],
    contexts: SemanticContext.registry([context]),
    diagnostics: [],
  }
  const applied = analyzed.fact._tag === 'Applied' ? analyzed.fact : undefined
  const targetFact = applied?.target ?? analyzed.fact
  const path = targetFact._tag === 'Unresolved' ? targetFact.path : undefined
  let base: Type.Nominal | undefined
  if (path === undefined) {
    if (targetFact._tag === 'Resolved' && Type.isNominal(targetFact.type)) base = targetFact.type
  } else {
    const candidate = NameResolution.resolveType(
      nameResolution,
      resolution.index,
      AuthoredWalk.moduleName(context),
      path,
    ).fact
    if (candidate._tag === 'Resolved' && Type.isNominal(candidate.type)) base = candidate.type
  }
  const declaration =
    base === undefined
      ? undefined
      : DeclarationFacts.byCanonical(resolution.index, {
          _tag: 'CanonicalDeclarationId',
          module: base.module,
          name: base.name,
        })
  if (base === undefined || declaration?._tag !== 'UnionDeclaration') {
    const diagnostic = Diagnostic.expectedNominalUnion(
      base === undefined ? 'unavailable type' : Type.display(base),
      Location.at(parentSyntax.anchor),
    )
    return unavailableUnionVariantTarget(diagnostic, analyzed.diagnostics)
  }
  const fullyResolved = DeclarationResolution.resolveTypeFact(
    context.spanOf,
    resolution.index,
    AuthoredWalk.moduleName(context),
    analyzed.fact,
    (module, argumentPath) =>
      NameResolution.resolveType(nameResolution, resolution.index, module, argumentPath),
  )
  if (
    fullyResolved.fact._tag === 'Resolved' &&
    Type.isNominal(fullyResolved.fact.type) &&
    fullyResolved.fact.type.module === base.module &&
    fullyResolved.fact.type.name === base.name
  )
    return selectedUnionVariant(
      context,
      declaration,
      fullyResolved.fact.type,
      SemanticContext.nameText(context, variantToken) ?? '',
      variantToken,
      Diagnostic.collect(analyzed.diagnostics, fullyResolved.diagnostics),
    )
  const supplied = applied?.arguments ?? []
  const sourceParameters = declaration.typeParameters.filter(
    (parameter) =>
      parameter.type.kind !== 'CallableRepresentation' &&
      parameter.type.kind !== 'EffectRepresentation',
  )
  if (supplied.length > sourceParameters.length) {
    const diagnostic = Diagnostic.expectedNominalUnion(
      Type.display(base),
      Location.at(parentSyntax.anchor),
    )
    return unavailableUnionVariantTarget(diagnostic, analyzed.diagnostics)
  }
  const resolvedArguments = supplied.map((argument) =>
    DeclarationResolution.resolveTypeFact(
      context.spanOf,
      resolution.index,
      AuthoredWalk.moduleName(context),
      argument,
      (module, argumentPath) =>
        NameResolution.resolveType(nameResolution, resolution.index, module, argumentPath),
    ),
  )
  let suppliedOrdinal = 0
  const arguments_ = declaration.typeParameters.flatMap(
    (parameter): ReadonlyArray<Type.GenericArgument> => {
      if (
        parameter.type.kind === 'CallableRepresentation' ||
        parameter.type.kind === 'EffectRepresentation'
      )
        return [Type.representationParameterArgument(parameter.type)]
      const resolved = resolvedArguments.at(suppliedOrdinal)
      suppliedOrdinal += 1
      if (resolved === undefined) return [Type.parameterArgument(parameter.type)]
      if (resolved.fact._tag !== 'Resolved') return []
      if (parameter.type.kind === 'Value')
        return Type.isTypeArgument(resolved.fact.type) ? [resolved.fact.type] : []
      if (
        parameter.type.kind === 'RequirementRow' &&
        Type.isParameter(resolved.fact.type) &&
        resolved.fact.type.kind === 'RequirementRow'
      )
        return [Type.requirementRowArgument([], [resolved.fact.type])]
      return []
    },
  )
  if (
    arguments_.length !== declaration.typeParameters.length ||
    TypeInference.prefixSubstitution(
      declaration.typeParameters.map((parameter) => parameter.type),
      arguments_,
    ) === undefined
  ) {
    const diagnostic = Diagnostic.expectedNominalUnion(
      Type.display(base),
      Location.at(parentSyntax.anchor),
    )
    return unavailableUnionVariantTarget(
      diagnostic,
      Diagnostic.collect(
        analyzed.diagnostics,
        ...resolvedArguments.map((argument) => argument.diagnostics),
      ),
    )
  }
  return selectedUnionVariant(
    context,
    declaration,
    Type.specializeNominal(base, arguments_),
    SemanticContext.nameText(context, variantToken) ?? '',
    variantToken,
    Diagnostic.collect(
      analyzed.diagnostics,
      ...resolvedArguments.map((argument) => argument.diagnostics),
    ),
  )
}

const resolveBareUnionVariantTarget = (
  context: SemanticContext.SemanticContext,
  node: AuthoredHir.Expression | AuthoredHir.Pattern,
  resolution: ResolutionContext,
): UnionVariantTargetResult | undefined => {
  const identifiers = nameSegments(node)
  const parentToken = identifiers.at(0)
  const variantToken = identifiers.at(1)
  if (identifiers.length !== 2 || parentToken === undefined || variantToken === undefined)
    return undefined
  const lookup = Semantic.resolveName(
    resolution.semantic,
    resolution.scope,
    SemanticContext.nameText(context, parentToken) ?? '',
  )
  if (lookup._tag !== 'Resolved' || lookup.declaration._tag !== 'UnionDeclaration') return undefined
  const union = lookup.declaration
  // `Option.some` names an inherent member, not a misspelled variant.
  const variantName = SemanticContext.nameText(context, variantToken) ?? ''
  if (
    !union.variants.some(
      (variant) => variant.name._tag === 'Present' && variant.name.spelling === variantName,
    ) &&
    Semantic.resolveAssociatedName(resolution.semantic, union, variantName, resolution.scope.module)
      ._tag !== 'Missing'
  )
    return undefined
  const type =
    union.canonical._tag === 'Canonical'
      ? Type.nominal(
          union.canonical.id.module,
          union.canonical.id.name,
          union.typeParameters.map((parameter) => Type.parameterArgument(parameter.type)),
        )
      : undefined
  if (type === undefined) {
    const diagnostic = Diagnostic.invalidNominalUnionConstruction(
      SemanticContext.nameText(context, parentToken) ?? '',
      Location.at(parentToken.anchor),
    )
    return unavailableUnionVariantTarget(diagnostic)
  }
  return selectedUnionVariant(
    context,
    union,
    type,
    SemanticContext.nameText(context, variantToken) ?? '',
    variantToken,
    [],
  )
}

export interface PatternCounters {
  readonly placeMutability?: 'Mutable' | 'Immutable'
  pattern: number
  binding: number
  invalid: boolean
}

export interface PatternResult {
  readonly fact: PatternFact
  readonly diagnostics: ReadonlyArray<Diagnostic.Located>
}

export interface PatternTypeResult {
  readonly type?: Type.Type
  readonly declared: DeclarationFacts.DeclaredTypeFact
  readonly diagnostics: ReadonlyArray<Diagnostic.Located>
}

export const resolvePatternType = (
  context: SemanticContext.SemanticContext,
  syntax: AuthoredHir.Type | undefined,
  resolution: ResolutionContext,
  declaration: DeclarationFact,
  anchor: AuthoredHir.Anchor,
): PatternTypeResult => {
  // An unannotated binder names no type of its own: its type comes from the scrutinee.
  if (syntax === undefined)
    return {
      declared: { _tag: 'Unavailable' as const, anchor },
      diagnostics: [],
    }
  const environment = new Map(
    declaration.typeParameters.flatMap((parameter) =>
      parameter.name._tag === 'Present' ? [[parameter.name.spelling, parameter.type] as const] : [],
    ),
  )
  const analyzed = DeclarationCollection.analyzeDeclaredType(
    context,
    syntax,
    environment,
    false,
    bodyLifetimeContext(context, resolution, environment),
  )
  const nameResolution: NameResolution.Resolution = {
    _tag: 'NameResolution',
    modules: [resolution.scope],
    contexts: SemanticContext.registry([context]),
    diagnostics: [],
  }
  const resolved = DeclarationResolution.resolveTypeFact(
    context.spanOf,
    resolution.index,
    AuthoredWalk.moduleName(context),
    analyzed.fact,
    (module, path) => NameResolution.resolveType(nameResolution, resolution.index, module, path),
  )
  return {
    ...(resolved.fact._tag === 'Resolved' ? { type: resolved.fact.type } : {}),
    declared: resolved.fact,
    diagnostics: Diagnostic.collect(analyzed.diagnostics, resolved.diagnostics),
  }
}

export const patternDeclaredName = (
  context: SemanticContext.SemanticContext,
  anchor: AuthoredHir.Anchor,
  token: AuthoredHir.Name | undefined,
): DeclaredName =>
  token === undefined
    ? { _tag: 'Unavailable', anchor }
    : {
        _tag: 'Present',
        spelling: SemanticContext.nameText(context, token) ?? '',
        anchor: token.anchor,
      }

const selectedPatternMember = (
  written: SemanticType | undefined,
  expected: SemanticType | undefined,
  resolution: ResolutionContext,
  inferNominalArguments = false,
): SemanticType | undefined => {
  if (written === undefined || expected === undefined) return written
  const members = Type.isUnion(expected) ? expected.members : [expected]
  // A bare variant names its declaration, leaving its arguments to the scrutinee.
  // Its declaration binders are inference positions, not lifetime requirements.
  if (inferNominalArguments && Type.isNominal(written))
    return (
      members.find(
        (member) =>
          Type.isNominal(member) &&
          member.module === written.module &&
          member.name === written.name &&
          member.arguments.length === written.arguments.length,
      ) ?? written
    )
  return (
    members.find(
      (member) =>
        Type.runtimeKey(member) === Type.runtimeKey(written) &&
        typesCompatible(member, written, resolution.lifetimeCompatibility),
    ) ?? written
  )
}

/** The field members a destructuring pattern lists, including the rest marker. */
const patternMembers = (
  node: AuthoredHir.Pattern,
): ReadonlyArray<AuthoredHir.PatternField | AuthoredHir.RestPattern> => {
  if (node._tag === 'NominalPattern') return node.fields
  if (node._tag === 'VariantPattern') return node.fields ?? []
  return []
}

/** The named fields one destructuring pattern declares, ignoring the rest marker. */
const patternFieldsOf = (node: AuthoredHir.Pattern): ReadonlyArray<AuthoredHir.PatternField> =>
  patternMembers(node).filter(
    (field): field is AuthoredHir.PatternField => field._tag === 'PatternField',
  )

/** True when a destructuring pattern carries the `..` rest marker. */
const patternHasRest = (node: AuthoredHir.Pattern): boolean =>
  patternMembers(node).some((field) => field._tag === 'RestPattern')

export const analyzePattern = (
  context: SemanticContext.SemanticContext,
  node: AuthoredHir.Pattern,
  arm: Match.ArmId,
  access: Match.Access,
  scope: Scope,
  resolution: ResolutionContext,
  declaration: DeclarationFact,
  counters: PatternCounters,
  expected?: SemanticType,
  prefix: ReadonlyArray<DeclarationFacts.FieldId> = [],
  localNames = new Map<string, Location.Location>(),
): PatternResult => {
  const id: Match.PatternId = {
    _tag: 'PatternId',
    arm,
    ordinal: counters.pattern,
  }
  counters.pattern += 1
  if (node._tag === 'InvalidPattern') {
    return {
      fact: {
        _tag: 'UnavailablePattern',
        id,
        bindings: [],
        omitted: [],
        complete: false,
        anchor: node.anchor,
      },
      diagnostics: [],
    }
  }
  if (node._tag === 'UniversalPattern') {
    return {
      fact: {
        _tag: 'UniversalPattern',
        id,
        bindings: [],
        omitted: access === 'Move' ? [[]] : [],
        anchor: node.anchor,
      },
      diagnostics: [],
    }
  }

  if (node._tag === 'IntegerPattern') {
    const integer = analyzeInteger(context, node.value)
    const expectedEnum =
      expected === undefined ? undefined : enumFactByType(resolution.index, expected)
    const value = integer.fact._tag === 'Available' ? integer.fact.value : undefined

    const patternSpan = Location.at(node.anchor)
    const diagnostic =
      expectedEnum?.canonical._tag === 'Canonical' && value !== undefined
        ? Diagnostic.integerPatternAgainstEnum(
            Type.encode(
              Type.nominal(expectedEnum.canonical.id.module, expectedEnum.canonical.id.name),
            ),
            value,
            patternSpan,
          )
        : undefined
    return {
      fact: {
        _tag: 'IntegerPattern',
        id,
        ...(value === undefined ? {} : { value }),
        span: context.spanOf(node.anchor),
        bindings: [],
        omitted: [],
        complete: false,
        anchor: node.anchor,
      },
      diagnostics: [...integer.diagnostics, ...(diagnostic === undefined ? [] : [diagnostic])],
    }
  }

  const bareUnionPatternTarget =
    node._tag === 'EnumPattern' || node._tag === 'NominalPattern'
      ? resolveBareUnionVariantTarget(context, node, resolution)
      : undefined

  if (node._tag === 'EnumPattern' && bareUnionPatternTarget === undefined) {
    const identifiers = nameSegments(node)
    const qualifierToken = identifiers.at(0)
    const memberToken = identifiers.at(1)
    const qualifier =
      qualifierToken === undefined
        ? undefined
        : (SemanticContext.nameText(context, qualifierToken) ?? '')
    const enumLookup =
      qualifier === undefined
        ? undefined
        : Semantic.resolveName(resolution.semantic, resolution.scope, qualifier)
    const enum_ =
      enumLookup?._tag === 'Resolved' && enumLookup.declaration._tag === 'EnumDeclaration'
        ? enumLookup.declaration
        : undefined
    const pathSpan =
      qualifierToken === undefined || memberToken === undefined
        ? context.spanOf(node.anchor)
        : (SourceSpan.fromOffsets(
            AuthoredWalk.moduleName(context),
            context.spanOf(qualifierToken.anchor).start,
            context.spanOf(memberToken.anchor).end,
          ) ?? context.spanOf(node.anchor))
    const memberName =
      memberToken === undefined ? undefined : (SemanticContext.nameText(context, memberToken) ?? '')
    const memberLookup =
      enum_ === undefined || memberName === undefined
        ? undefined
        : DeclarationFacts.lookupEnumMember(enum_.members, memberName)
    const member = memberLookup?._tag === 'Resolved' ? memberLookup.member : undefined
    const coverage =
      enum_?.canonical._tag === 'Canonical' && member?.canonical._tag === 'Canonical'
        ? Match.enumMember(enum_.canonical.id, member.canonical.id)
        : undefined
    const expectedEnum =
      expected === undefined ? undefined : enumFactByType(resolution.index, expected)
    const unknown =
      enum_ !== undefined && member === undefined && memberName !== undefined
        ? Diagnostic.unknownEnumMember(
            qualifier ?? '<unavailable>',
            memberName,
            (memberToken === undefined ? undefined : Location.at(memberToken.anchor)) ??
              Location.at(node.anchor),
          )
        : undefined
    const foreign =
      coverage?._tag === 'EnumMember' &&
      expectedEnum?.canonical._tag === 'Canonical' &&
      (coverage.enum.module !== expectedEnum.canonical.id.module ||
        coverage.enum.name !== expectedEnum.canonical.id.name)
        ? Diagnostic.foreignEnumPattern(
            Type.encode(
              Type.nominal(expectedEnum.canonical.id.module, expectedEnum.canonical.id.name),
            ),
            Type.encode(coverage.type),
            Location.at(node.anchor),
          )
        : undefined
    return {
      fact: {
        _tag: 'EnumMemberPattern',
        id,
        ...(enum_ === undefined ? {} : { enum: enum_ }),
        ...(member === undefined ? {} : { member }),
        ...(coverage === undefined ? {} : { coverage }),
        ...(qualifierToken === undefined ? {} : { qualifierAnchor: qualifierToken.anchor }),
        ...(memberToken === undefined ? {} : { memberAnchor: memberToken.anchor }),
        span: pathSpan,
        bindings: [],
        omitted: [],
        complete: coverage !== undefined && unknown === undefined && foreign === undefined,
        anchor: node.anchor,
      },
      diagnostics: [
        ...(unknown === undefined ? [] : [unknown]),
        ...(foreign === undefined ? [] : [foreign]),
      ],
    }
  }

  if (node._tag === 'BindingPattern') {
    // `Member name` binds the entire member payload: no field destructuring, nothing omitted.
    const bindingTarget = resolvePatternType(
      context,
      node.type,
      resolution,
      declaration,
      node.anchor,
    )
    const bindingDiagnostics: Array<Diagnostic.Located> = [...bindingTarget.diagnostics]
    const member = selectedPatternMember(bindingTarget.type, expected, resolution)
    const declaredName: DeclaredName = bindingName(context, node.name)
    if (declaredName._tag === 'Present') {
      const original =
        scopeSpanFor(context, scope, declaredName.spelling) ?? localNames.get(declaredName.spelling)
      if (original === undefined)
        localNames.set(declaredName.spelling, Location.at(declaredName.anchor))
      else {
        counters.invalid = true
        bindingDiagnostics.push(
          Diagnostic.patternBindingConflict(
            declaredName.spelling,
            original,
            Location.at(declaredName.anchor),
          ),
        )
      }
    }
    const wholeBinding: PatternBindingFact = {
      _tag: 'PatternBinding',
      id: { _tag: 'PatternBindingId' as const, arm, ordinal: counters.binding },
      name: declaredName,
      path: prefix,
      type: member === undefined ? unavailableExpressionType : availableExpressionType(member),
      access,
      ...(counters.placeMutability === undefined
        ? {}
        : { placeMutability: counters.placeMutability }),
      anchor: node.anchor,
    }
    counters.binding += 1
    return {
      fact: {
        _tag: 'TypePattern',
        id,
        ...(member === undefined ? {} : { member }),
        declared: bindingTarget.declared,
        bindings: [wholeBinding],
        omitted: [],
        complete: member !== undefined && !counters.invalid,
        anchor: node.anchor,
      },
      diagnostics: bindingDiagnostics,
    }
  }

  const variantSelector = node._tag === 'VariantPattern' ? node.selector : undefined
  const unionTarget =
    variantSelector === undefined
      ? bareUnionPatternTarget
      : resolveUnionVariantTarget(context, variantSelector, resolution, declaration)
  // A struct target is only resolved when no union variant matched, and every pattern that reaches
  // here without one is a `NominalPattern`: the enum and bare-union routes returned above.
  const structTarget =
    unionTarget === undefined && node._tag === 'NominalPattern'
      ? resolveStructTarget(context, node.type, resolution, declaration)
      : undefined
  const target = unionTarget ?? structTarget
  if (target === undefined) throw new RangeError('Pattern target resolution is unavailable')
  const diagnostics: Array<Diagnostic.Located> = [...target.diagnostics]
  const struct =
    target.fact._tag === 'Resolved' && 'struct' in target.fact ? target.fact.struct : undefined
  const union =
    target.fact._tag === 'Resolved' && 'union' in target.fact ? target.fact.union : undefined
  const variant =
    target.fact._tag === 'Resolved' && 'variant' in target.fact ? target.fact.variant : undefined
  const aggregate = struct ?? union
  const aggregateFields = struct?.fields ?? variant?.fields ?? []
  const selectedType = selectedPatternMember(
    target.fact._tag === 'Resolved' ? target.fact.type : undefined,
    expected,
    resolution,
    bareUnionPatternTarget !== undefined,
  )
  const nominal =
    selectedType !== undefined && Type.isNominal(selectedType) ? selectedType : undefined
  const structSubstitution =
    aggregate === undefined || nominal === undefined
      ? new Map<string, SemanticType>()
      : (TypeInference.substitution(
          aggregate.typeParameters.map((parameter) => parameter.type),
          nominal.arguments,
        ) ?? new Map())
  const unresolvedParameters =
    aggregate === undefined || nominal === undefined
      ? []
      : aggregate.typeParameters.filter((parameter, ordinal) => {
          const argument = nominal.arguments.at(ordinal)
          return argument === undefined || isOwnStructArgument(parameter.type, argument)
        })
  for (const parameter of unresolvedParameters) {
    diagnostics.push(
      Diagnostic.uninferredTypeParameter(
        nominal === undefined ? 'unknown aggregate' : Type.display(nominal),
        parameter.type.name,
        Location.at(parameter.anchor),
      ),
    )
  }
  const label = nominal === undefined ? 'unknown aggregate' : Type.display(nominal)
  const outsideDefiningModule =
    nominal !== undefined && nominal.module !== AuthoredWalk.moduleName(context)
  const seen = new Map<string, PatternFieldFact>()
  const bindings: Array<PatternBindingFact> = []
  const fields = patternFieldsOf(node).map((fieldNode): PatternFieldFact => {
    const name = SemanticContext.nameText(context, fieldNode.name)
    const nameAnchor = fieldNode.name.anchor
    const lookup =
      aggregate === undefined || name === undefined
        ? undefined
        : DeclarationFacts.lookupField(aggregateFields, name)
    let state: PatternFieldState = { _tag: 'Unavailable' }
    let resolvedField: DeclarationFacts.FieldFact | undefined
    if (
      lookup?._tag === 'Resolved' &&
      lookup.field.visibility === 'Private' &&
      outsideDefiningModule
    ) {
      const diagnostic = Diagnostic.inaccessibleProjectedField(
        label,
        name ?? '',
        Location.at(nameAnchor),
      )
      diagnostics.push(diagnostic)
      counters.invalid = true
      state = { _tag: 'Unavailable', cause: Diagnostic.identity(diagnostic) }
    } else if (lookup?._tag === 'Resolved') {
      const original = seen.get(name ?? '')
      if (original === undefined) {
        resolvedField = lookup.field
        state = { _tag: 'Resolved', field: lookup.field }
      } else {
        const diagnostic = Diagnostic.duplicatePatternField(
          name ?? '',
          Location.at(original.anchor),
          Location.at(nameAnchor),
        )
        diagnostics.push(diagnostic)
        state = {
          _tag: 'Duplicate',
          field: lookup.field,
          cause: Diagnostic.identity(diagnostic),
        }
      }
    } else if (name !== undefined) {
      const diagnostic = Diagnostic.unknownStructField(label, name, Location.at(nameAnchor))
      diagnostics.push(diagnostic)
      state = { _tag: 'Unknown', cause: Diagnostic.identity(diagnostic) }
    }

    // Lowering always synthesizes a `BindingPattern` for a field that writes no nested pattern,
    // so a shorthand `{ x }` and a rebinding `{ x: y }` both bind the field directly here; only a
    // written nested pattern destructures further.
    const nestedNode =
      fieldNode.pattern._tag === 'BindingPattern' && fieldNode.pattern.type === undefined
        ? undefined
        : fieldNode.pattern
    let nested: PatternFact | undefined
    let binding: PatternBindingFact | undefined
    if (nestedNode !== undefined) {
      const nestedResult = analyzePattern(
        context,
        nestedNode,
        arm,
        access,
        scope,
        resolution,
        declaration,
        counters,
        undefined,
        resolvedField === undefined ? prefix : [...prefix, resolvedField.id],
        localNames,
      )
      diagnostics.push(...nestedResult.diagnostics)
      nested = nestedResult.fact
      const expected =
        resolvedField?.declaredType._tag === 'Resolved'
          ? Type.substitute(resolvedField.declaredType.type, structSubstitution)
          : undefined
      if (
        expected !== undefined &&
        (nested._tag === 'NominalPattern' ||
          nested._tag === 'UnionVariantPattern' ||
          nested._tag === 'TypePattern') &&
        nested.member !== undefined &&
        !Type.equals(expected, nested.member)
      ) {
        counters.invalid = true
        diagnostics.push(
          Diagnostic.matchMemberNotInScrutinee(
            Type.display(nested.member),
            Type.display(expected),
            Location.at(nestedNode.anchor),
          ),
        )
      }
    } else if (resolvedField !== undefined) {
      // A shorthand field binds under its own name; a nested binding pattern names the binder.
      const bindingToken =
        fieldNode.pattern._tag === 'BindingPattern' ? fieldNode.pattern.name : fieldNode.name
      const declaredName = patternDeclaredName(context, fieldNode.anchor, bindingToken)
      const bindingType =
        resolvedField.declaredType._tag === 'Resolved'
          ? availableExpressionType(
              Type.substitute(resolvedField.declaredType.type, structSubstitution),
            )
          : unavailableExpressionType
      binding = {
        _tag: 'PatternBinding',
        id: {
          _tag: 'PatternBindingId',
          arm,
          ordinal: counters.binding,
        },
        name: declaredName,
        field: resolvedField,
        path: [...prefix, resolvedField.id],
        type: bindingType,
        access,
        ...(counters.placeMutability === undefined
          ? {}
          : { placeMutability: counters.placeMutability }),
        anchor: fieldNode.anchor,
      }
      counters.binding += 1
      bindings.push(binding)
      if (declaredName._tag === 'Present') {
        const original =
          scopeSpanFor(context, scope, declaredName.spelling) ??
          localNames.get(declaredName.spelling)
        if (original === undefined)
          localNames.set(declaredName.spelling, Location.at(declaredName.anchor))
        else {
          counters.invalid = true
          diagnostics.push(
            Diagnostic.patternBindingConflict(
              declaredName.spelling,
              original,
              Location.at(declaredName.anchor),
            ),
          )
        }
      }
    }
    if (nested?.bindings !== undefined) bindings.push(...nested.bindings)
    const fact: PatternFieldFact = {
      _tag: 'PatternField',
      name,
      state,
      ...(binding === undefined ? {} : { binding }),
      ...(nested === undefined ? {} : { nested }),
      anchor: fieldNode.anchor,
    }
    if (name !== undefined && !seen.has(name)) seen.set(name, fact)
    return fact
  })

  const rest = patternHasRest(node)
  const omitted: Array<ReadonlyArray<DeclarationFacts.FieldId>> = fields.flatMap(
    (field) => field.nested?.omitted ?? [],
  )
  if (aggregate !== undefined && !rest) {
    let omittedInaccessible = false
    for (const field of aggregateFields) {
      if (field.name._tag !== 'Present' || seen.has(field.name.spelling)) continue
      if (field.visibility === 'Private' && outsideDefiningModule) {
        omittedInaccessible = true
        continue
      }
      diagnostics.push(
        Diagnostic.missingPatternField(label, field.name.spelling, Location.at(node.anchor)),
      )
    }
    if (omittedInaccessible)
      diagnostics.push(Diagnostic.inaccessiblePatternFields(label, Location.at(node.anchor)))
  } else if (aggregate !== undefined && rest) {
    for (const field of aggregateFields) {
      if (field.name._tag === 'Present' && seen.has(field.name.spelling)) continue
      omitted.push([...prefix, field.id])
    }
  }
  const complete =
    target.fact._tag === 'Resolved' &&
    unresolvedParameters.length === 0 &&
    !counters.invalid &&
    AuthoredWalk.isAvailable(node) &&
    fields.every(
      (field) =>
        field.state._tag === 'Resolved' &&
        (field.nested === undefined ||
          ((field.nested._tag === 'NominalPattern' ||
            field.nested._tag === 'UnionVariantPattern' ||
            field.nested._tag === 'TypePattern') &&
            field.nested.complete)),
    ) &&
    (rest ||
      aggregateFields.every(
        (field) => field.name._tag !== 'Present' || seen.has(field.name.spelling),
      ) === true)
  if (unionTarget !== undefined) {
    const coverage =
      nominal !== undefined && variant?.canonical._tag === 'Canonical'
        ? Match.nominalUnionVariant(nominal, nominal, variant.canonical.id, variant.id.ordinal)
        : undefined
    return {
      fact: {
        _tag: 'UnionVariantPattern',
        id,
        target:
          unionTarget.fact._tag === 'Resolved' && nominal !== undefined
            ? { ...unionTarget.fact, type: nominal }
            : unionTarget.fact,
        ...(nominal === undefined ? {} : { member: nominal }),
        ...(coverage === undefined ? {} : { coverage }),
        fields: fields,
        bindings: bindings,
        omitted: omitted,
        rest,
        complete,
        anchor: node.anchor,
      },
      diagnostics: diagnostics,
    }
  }
  return {
    fact: {
      _tag: 'NominalPattern',
      id,
      target:
        structTarget?.fact._tag === 'Resolved' && nominal !== undefined
          ? { ...structTarget.fact, type: nominal }
          : (structTarget?.fact ?? { _tag: 'Unavailable' }),
      ...(nominal === undefined ? {} : { member: nominal }),
      fields: fields,
      bindings: bindings,
      omitted: omitted,
      rest,
      complete,
      anchor: node.anchor,
    },
    diagnostics: diagnostics,
  }
}

export const unavailableExpression = (anchor: AuthoredHir.Anchor): ExpressionDecision => ({
  _tag: 'Identifier',
  reference: { _tag: 'Unavailable', anchor },
  type: unavailableExpressionType,
  anchor,
})

/** Publishes the unavailable recovery expression used when an authored operand is absent. */
const unavailableExpressionResult = (
  context: SemanticContext.SemanticContext,
  anchor: AuthoredHir.Anchor,
  declaration: DeclarationFact,
  resolution: ResolutionContext,
): ExpressionResult => {
  const fact = unavailableExpression(anchor)
  if (resolution.builder === undefined) return { fact, diagnostics: [], type: undefined }
  return {
    fact,
    node: BodyBuilder.tirExpression(fact, {
      context,
      builder: resolution.builder,
      ...(declaration.phase === 'Static' ? { static: resolution.builder.expressions } : {}),
      ...(resolution.lifetimeCompatibility === undefined
        ? {}
        : { lifetimeCompatibility: resolution.lifetimeCompatibility }),
      ...(declaration.opaqueResult === undefined
        ? {}
        : { opaqueResultFamily: declaration.opaqueResult.family }),
      functionId: declaration.id,
    }),
    diagnostics: [],
    type: undefined,
  }
}

/** The authored access is already decoded; only the semantic spelling of each case differs. */
export const matchAccess = (
  node: Extract<AuthoredHir.Expression, { readonly _tag: 'MatchExpression' }>,
): Match.Access => {
  switch (node.access) {
    case 'Move':
      return 'Move'
    case 'Place':
      return 'Place'
    case 'Shared':
      return 'Shared'
    case 'Mutable':
      return 'Exclusive'
    default:
      return 'Copy'
  }
}

export const patternTests = (
  context: SemanticContext.SemanticContext,
  index: DeclarationIndex.Index,
  pattern: PatternFact,
  prefix: ReadonlyArray<DeclarationFacts.FieldId> = [],
): ReadonlyArray<Match.PatternTest> => {
  if (pattern._tag !== 'NominalPattern' && pattern._tag !== 'UnionVariantPattern') return []
  return pattern.fields.flatMap((field) => {
    if (field.state._tag !== 'Resolved' || field.nested === undefined) return []
    const nested = field.nested
    const path = [...prefix, field.state.field.id]
    const test: ReadonlyArray<Match.PatternTest> =
      nested._tag === 'UnionVariantPattern' &&
      nested.coverage !== undefined &&
      nested.member !== undefined
        ? [
            {
              path,
              member: nested.coverage,
              domain: coverageMembersOf(index, nested.member),
              span: context.spanOf(nested.anchor),
              at: nested.anchor,
            },
          ]
        : []
    return [...test, ...patternTests(context, index, nested, path)]
  })
}

export const patternCoverage = (pattern: PatternFact): Match.CoverageIdentity | undefined => {
  if (pattern._tag === 'EnumMemberPattern') return pattern.coverage
  if (pattern._tag === 'UnionVariantPattern') return pattern.coverage
  return (pattern._tag === 'NominalPattern' || pattern._tag === 'TypePattern') &&
    pattern.member !== undefined
    ? Match.structuralMember(pattern.member)
    : undefined
}

export const analyzeMatch = (
  context: SemanticContext.SemanticContext,
  node: Extract<AuthoredHir.Expression, { readonly _tag: 'MatchExpression' }>,
  declarations: ReadonlyArray<DeclarationFact>,
  declaration: DeclarationFact,
  scope: Scope,
  resolution: ResolutionContext,
  expected?: SemanticType,
): ExpressionResult => {
  if (resolution.builder === undefined)
    throw new RangeError('match analysis requires its TIR body builder')
  const id: Match.MatchId = {
    _tag: 'MatchId',
    node: BodyBuilder.expressionReference(resolution.builder, node.anchor),
  }
  const access = matchAccess(node)
  const scrutineeNode = node.subject
  const analyzedScrutinee = analyzeExpression(
    context,
    scrutineeNode,
    declarations,
    declaration,
    scope,
    resolution,
  )
  // A scrutinee the expression layer declines leaves the match unavailable, not absent.
  const scrutinee: ExpressionResult = analyzedScrutinee ?? {
    fact: unavailableExpression(scrutineeNode.anchor),
    diagnostics: [],
    type: undefined,
  }
  const diagnostics: Array<Diagnostic.Located> = [...scrutinee.diagnostics]
  const enumScrutinee =
    scrutinee.type === undefined ? undefined : enumFactByType(resolution.index, scrutinee.type)
  let members: readonly Match.CoverageIdentity[] | undefined
  if (scrutinee.type === undefined) {
    members = undefined
  } else if (enumScrutinee === undefined) {
    members = coverageMembersOf(resolution.index, scrutinee.type)
  } else {
    members = Match.enumMembersOf(enumScrutinee)
  }

  const placeRoot = access === 'Place' ? assignmentRoot(scrutinee.fact) : undefined
  const placeMutability =
    placeRoot !== undefined &&
    scrutinee !== undefined &&
    assignmentRootAccess(placeRoot, scrutinee.fact) === 'MutableOwned'
      ? 'Mutable'
      : 'Immutable'
  const preliminary = node.arms.map((armNode, ordinal) => {
    const armId: Match.ArmId = { _tag: 'MatchArmId', match: id, ordinal }
    const pattern = analyzePattern(
      context,
      armNode.pattern,
      armId,
      access,
      scope,
      resolution,
      declaration,
      {
        pattern: 0,
        binding: 0,
        invalid: false,
        ...(access === 'Place' ? { placeMutability } : {}),
      },
      scrutinee.type,
    )
    diagnostics.push(...pattern.diagnostics)
    return {
      armNode,
      armId,
      pattern: pattern.fact,
      tests: patternTests(context, resolution.index, pattern.fact),
    }
  })
  const coverage = Match.cover(
    members ?? [],
    preliminary.map(({ armNode, pattern, tests }) => {
      const member = patternCoverage(pattern)
      return {
        ...(member === undefined ? {} : { member }),
        universal: pattern._tag === 'UniversalPattern',
        tests,
        guarded: armNode.guard !== undefined,
      }
    }),
  )
  // Presentation spans already begin at the first significant byte: no trivia to skip.
  const semanticPatternSpan = (pattern: PatternFact): Location.Location =>
    Location.at(pattern.anchor)
  // An arm begins at its pattern, so the arm's own node already spans pattern to body.
  const semanticArmSpan = (
    _pattern: PatternFact,
    armNode: AuthoredHir.MatchArm,
  ): Location.Location => Location.at(armNode.anchor)
  const firstCoveringArm = new Map<string, Location.Location>()
  let wildcardArm: Location.Location | undefined
  const callableWrites = resolution.writtenCallableBindings
  const candidateWrites = new Set(callableWrites)
  const continuationWrites = new Set<number>()
  let pendingMembers = [...(members ?? [])]
  const executedArms = new Set<number>()
  const restoreWrites = (writes: ReadonlySet<number>): void => {
    if (callableWrites === undefined) return
    callableWrites.clear()
    for (const ordinal of writes) callableWrites.add(ordinal)
  }
  const arms = preliminary.map(({ armNode, armId, pattern }, ordinal): MatchArmFact => {
    restoreWrites(candidateWrites)
    const transition = coverage.transitions.at(ordinal)
    if (transition === undefined) throw new RangeError('Match coverage lost an arm')
    const member = patternCoverage(pattern)
    const guarded = armNode.guard !== undefined
    const memberInDomain =
      member !== undefined && members?.some((candidate) => Match.selects(member, candidate))
    if (
      enumScrutinee === undefined &&
      member !== undefined &&
      members !== undefined &&
      !memberInDomain
    ) {
      diagnostics.push(
        Diagnostic.matchMemberNotInScrutinee(
          Type.display(member.type),
          scrutinee.type === undefined ? 'unknown' : Type.display(scrutinee.type),
          Location.at(pattern.anchor),
        ),
      )
    } else if (
      enumScrutinee !== undefined &&
      pattern._tag !== 'UnavailablePattern' &&
      !transition.reachable &&
      (members?.length ?? 0) > 0
    ) {
      if (wildcardArm !== undefined) {
        diagnostics.push(
          Diagnostic.enumMatchArmAfterWildcard(wildcardArm, semanticArmSpan(pattern, armNode)),
        )
      } else if (member !== undefined && memberInDomain) {
        const original = firstCoveringArm.get(Match.encodeIdentity(member))
        if (original !== undefined)
          diagnostics.push(
            Diagnostic.duplicateEnumMatchArm(
              Match.encodeIdentity(member),
              original,
              semanticPatternSpan(pattern),
            ),
          )
      }
    } else if (
      enumScrutinee === undefined &&
      pattern._tag !== 'UnavailablePattern' &&
      !transition.reachable &&
      (members?.length ?? 0) > 0
    ) {
      let identity = 'unknown'
      if (pattern._tag === 'UniversalPattern') identity = '_'
      else if (member !== undefined) identity = Match.encodeIdentity(member)
      diagnostics.push(Diagnostic.unreachableMatchArm(identity, Location.at(armNode.anchor)))
    }
    if (!guarded) {
      if (pattern._tag === 'UniversalPattern' && wildcardArm === undefined)
        wildcardArm = semanticArmSpan(pattern, armNode)
      else if (member !== undefined && memberInDomain && transition.reachable)
        firstCoveringArm.set(Match.encodeIdentity(member), semanticPatternSpan(pattern))
    }
    const guardNode = armNode.guard
    const resultNode = armNode.result._tag === 'Block' ? undefined : armNode.result
    const blockNode = armNode.result._tag === 'Block' ? armNode.result : undefined
    if (resolution.builder !== undefined)
      for (const binding of pattern.bindings)
        if (binding.type._tag === 'Available')
          BodyBuilder.semanticLocal(resolution.builder, binding, {
            kind: 'Pattern',
            ...(binding.name._tag === 'Present' ? { name: binding.name.spelling } : {}),
            type: binding.type.type,
            mutability: binding.access === 'Place' ? 'Mutable' : 'Immutable',
          })
    const armScope: Scope = {
      parameters: scope.parameters,
      bindings: scope.bindings,
      patternBindings: [...scope.patternBindings, ...pattern.bindings],
    }
    const guard =
      guardNode === undefined
        ? undefined
        : analyzeExpression(context, guardNode, declarations, declaration, armScope, resolution)
    if (guard !== undefined) {
      diagnostics.push(...guard.diagnostics)
      if (guard.type !== undefined && guard.type !== 'bool' && !Type.isNever(guard.type)) {
        diagnostics.push(
          Diagnostic.matchGuardNotBool(
            Type.display(guard.type),
            (guardNode === undefined ? undefined : Location.at(guardNode.anchor)) ??
              Location.at(armNode.anchor),
          ),
        )
      }
    }
    const guardCompletes = guard === undefined || !expressionNever(guard.fact)
    const selectedMembers = pendingMembers.filter(
      (candidate) =>
        pattern._tag === 'UniversalPattern' ||
        (member !== undefined && Match.selects(member, candidate)),
    )
    const executes = transition.reachable && selectedMembers.length > 0
    if (executes) executedArms.add(ordinal)
    pendingMembers = pendingMembers.filter((candidate) =>
      transition.after.some((remaining) => Match.identityEquals(candidate, remaining)),
    )
    if (!guardCompletes && patternTests(context, resolution.index, pattern).length === 0)
      pendingMembers = pendingMembers.filter((candidate) => !selectedMembers.includes(candidate))
    if (executes && guardCompletes)
      for (const ordinal of callableWrites ?? []) candidateWrites.add(ordinal)
    let body: MatchArmBodyFact
    if (blockNode !== undefined && resolution.execution !== undefined) {
      const execution = resolution.execution
      const blockDiagnostics: Array<Diagnostic.Located> = []
      const statements = analyzeStatements(
        { ...execution.context, resolution, diagnostics: blockDiagnostics },
        blockNode,
        armScope,
        execution.loopStack,
        pattern.bindings,
      )
      diagnostics.push(...blockDiagnostics)
      const completion = {
        fallsThrough: returnFlowOf(statements, false).fallsThrough,
      }
      body = {
        _tag: 'Block',
        statements,
        completion,
        type: availableExpressionType(completion.fallsThrough ? Type.unit : 'never'),
        anchor: blockNode.anchor,
      }
    } else if (blockNode !== undefined) {
      body = {
        _tag: 'Block',
        statements: [],
        completion: { fallsThrough: true },
        type: unavailableExpressionType,
        anchor: blockNode.anchor,
      }
    } else {
      const result =
        resultNode === undefined
          ? undefined
          : analyzeExpression(
              context,
              resultNode,
              declarations,
              declaration,
              armScope,
              resolution,
              expected,
            )
      if (result !== undefined) diagnostics.push(...result.diagnostics)
      const expression = result?.fact ?? unavailableExpression((resultNode ?? armNode).anchor)
      const published =
        result === undefined
          ? BodyBuilder.tirExpression(expression, {
              context,
              ...(resolution.builder === undefined ? {} : { builder: resolution.builder }),
            })
          : expressionNode(result)
      body = {
        _tag: 'Expression',
        expression: published,
        type: expression.type,
        anchor: expression.anchor,
      }
    }
    if (
      executes &&
      guardCompletes &&
      (body._tag === 'Expression'
        ? body.expression._tag === 'Unavailable' || !Type.isNever(body.expression.type)
        : body.completion.fallsThrough)
    )
      for (const ordinal of callableWrites ?? []) continuationWrites.add(ordinal)
    return {
      _tag: 'MatchArm',
      id: armId,
      pattern,
      bindings: pattern.bindings,
      tests: patternTests(context, resolution.index, pattern),
      ...(guard === undefined ? {} : { guard: expressionNode(guard) }),
      body,
      before: transition.before,
      after: transition.after,
      reachable: transition.reachable,
      anchor: armNode.anchor,
    }
  })
  restoreWrites(continuationWrites)
  const contributes = (arm: MatchArmFact): boolean =>
    executedArms.has(arm.id.ordinal) &&
    (arm.guard === undefined || arm.guard._tag === 'Unavailable' || !Type.isNever(arm.guard.type))
  if (
    members !== undefined &&
    !coverage.exhaustive &&
    !preliminary.some(({ pattern }) => pattern._tag === 'UnavailablePattern')
  ) {
    diagnostics.push(
      enumScrutinee?.canonical._tag === 'Canonical'
        ? Diagnostic.incompleteEnumMatch(
            Type.encode(
              Type.nominal(enumScrutinee.canonical.id.module, enumScrutinee.canonical.id.name),
            ),
            coverage.missing.map(Match.encodeIdentity),
            Location.at(node.anchor),
          )
        : Diagnostic.incompleteMatch(
            coverage.missing.map(Match.encodeIdentity),
            Location.at(node.anchor),
          ),
    )
  }
  const reachableTypes = arms.flatMap((arm) => {
    if (
      executedArms.has(arm.id.ordinal) &&
      arm.guard !== undefined &&
      arm.guard._tag !== 'Unavailable' &&
      Type.isNever(arm.guard.type)
    )
      return ['never' as const]
    return contributes(arm) && arm.body.type._tag === 'Available' ? [arm.body.type.type] : []
  })
  const unavailableReachableResult = arms.some(
    (arm) => contributes(arm) && arm.body.type._tag !== 'Available',
  )
  const anonymousTypes = reachableTypes.filter((type) => {
    if (!Type.isNominal(type)) return false
    const aggregate = aggregateByNominal(resolution, type)
    return (
      aggregate?.aggregateKind === 'AnonymousNamed' ||
      aggregate?.aggregateKind === 'AnonymousPositional'
    )
  })
  const anonymousDisagreement = new Set(anonymousTypes.map(Type.key)).size > 1
  const unitDisagreement =
    arms.some(
      (arm) => contributes(arm) && arm.body._tag === 'Block' && arm.body.completion.fallsThrough,
    ) && reachableTypes.some((type) => !Type.isNever(type) && !Type.equals(type, Type.unit))
  let joined: Match.Join
  if (anonymousDisagreement || unitDisagreement)
    joined = { _tag: 'Incompatible', types: reachableTypes }
  else if (
    expected !== undefined &&
    reachableTypes.every(
      (type) =>
        Type.isNever(type) ||
        (Type.runtimeKey(type) === Type.runtimeKey(expected) &&
          typesCompatible(type, expected, resolution.lifetimeCompatibility)),
    )
  )
    joined = { _tag: 'Joined', type: expected }
  else
    joined = Match.join(
      reachableTypes,
      BodyLifetime.environment(resolution?.bodyLifetimes, node.anchor, reachableTypes),
    )
  if (joined._tag === 'Incompatible') {
    let divergentRepresentations:
      | {
          readonly divergence: Type.RepresentationDivergence
          readonly spans: readonly [Location.Location, Location.Location]
        }
      | undefined
    const reachableResults = arms.flatMap((arm) =>
      contributes(arm) && arm.body.type._tag === 'Available'
        ? [{ type: arm.body.type.type, span: Location.at(arm.body.anchor) }]
        : [],
    )
    for (const [leftOrdinal, left] of reachableResults.entries()) {
      for (const right of reachableResults.slice(leftOrdinal + 1)) {
        const divergence = Type.firstRepresentationDivergence(left.type, right.type)
        if (divergence !== undefined) {
          divergentRepresentations = {
            divergence,
            spans: [left.span, right.span] as const,
          }
          break
        }
      }
      if (divergentRepresentations !== undefined) break
    }
    let diagnostic: Diagnostic.Located
    if (anonymousDisagreement) {
      diagnostic = Diagnostic.anonymousAggregateJoinMismatch(
        joined.types.map(Type.display),
        Location.at(node.anchor),
      )
    } else if (divergentRepresentations === undefined) {
      diagnostic = Diagnostic.incompatibleMatchResults(
        joined.types.map(Type.encode),
        Location.at(node.anchor),
      )
    } else {
      diagnostic = Diagnostic.divergentRepresentationJoin(
        Type.encodeGenericArgument(divergentRepresentations.divergence.left),
        Type.encodeGenericArgument(divergentRepresentations.divergence.right),
        divergentRepresentations.spans,
        Location.at(node.anchor),
      )
    }
    diagnostics.push(diagnostic)
  }
  const hasInvalidGuard = arms.some(
    (arm) =>
      arm.guard !== undefined &&
      arm.guard._tag !== 'Unavailable' &&
      arm.guard.type !== 'bool' &&
      !Type.isNever(arm.guard.type),
  )
  let joinedEffect: Type.Effect | undefined
  if (joined._tag === 'Joined') {
    if (Type.isRepresented(joined.type)) {
      if (Type.isEffect(joined.type.contract)) {
        joinedEffect = joined.type.contract
      } else {
        joinedEffect = undefined
      }
    } else if (Type.isEffect(joined.type)) {
      joinedEffect = joined.type
    } else {
      joinedEffect = undefined
    }
  } else {
    joinedEffect = undefined
  }
  let effectAlternatives: readonly Type.ExactRepresentationArgument[]
  if (joinedEffect === undefined) {
    effectAlternatives = []
  } else {
    effectAlternatives = arms.flatMap((arm) => {
      if (!contributes(arm)) return []
      const representation =
        arm.body._tag === 'Expression'
          ? representationOfExpression(context, arm.body.expression)
          : undefined
      return representation !== undefined &&
        Type.isExactRepresentationArgument(representation) &&
        Type.isEffectIdentityArgument(representation.identity) &&
        Type.isEffect(representation.contract)
        ? [representation]
        : []
    })
  }
  const reachableEffectArms =
    joinedEffect === undefined
      ? 0
      : arms.filter(
          (arm) =>
            contributes(arm) &&
            // Mirrors Match.join: diverging (never-typed) arms do not contribute to the join,
            // so they are not required to carry an exact static Effect representation.
            !(arm.body.type._tag === 'Available' && Type.isNever(arm.body.type.type)),
        ).length
  const unavailableEffectComposite =
    joinedEffect !== undefined && effectAlternatives.length !== reachableEffectArms
  if (unavailableEffectComposite)
    diagnostics.push(
      Diagnostic.nonFiniteEffectJoin(
        'every reachable alternative must retain one exact static Effect representation',
        Location.at(node.anchor),
      ),
    )
  const callableSites = arms.flatMap((arm) =>
    contributes(arm) &&
    arm.body._tag === 'Expression' &&
    arm.body.expression._tag === 'CallableSection'
      ? [Tir.executableSiteKey(arm.body.expression.site)]
      : [],
  )
  // Every reachable arm must construct the same exact callable: a structural callable type names
  // a contract, not a universal representation the arms could be erased into.
  const callableIdentities =
    joined._tag === 'Joined' && Type.isCallable(joined.type)
      ? arms.flatMap((arm) => {
          const representation =
            contributes(arm) && arm.body._tag === 'Expression'
              ? representationOfExpression(context, arm.body.expression)
              : undefined
          return representation !== undefined &&
            Type.isExactRepresentationArgument(representation) &&
            Type.isCallableIdentityArgument(representation.identity)
            ? [Type.genericArgumentKey(representation.identity)]
            : []
        })
      : []
  const erasesCallableIdentity =
    new Set(callableSites).size > 1 || new Set(callableIdentities).size > 1
  if (erasesCallableIdentity)
    diagnostics.push(Diagnostic.callableIdentityErasure(Location.at(node.anchor)))
  let type: ExpressionTypeFact
  if (
    members !== undefined &&
    coverage.exhaustive &&
    arms.every(
      (arm) =>
        arm.reachable &&
        (arm.pattern._tag === 'UniversalPattern' ||
          (arm.pattern._tag === 'EnumMemberPattern' && arm.pattern.complete) ||
          ((arm.pattern._tag === 'NominalPattern' ||
            arm.pattern._tag === 'UnionVariantPattern' ||
            arm.pattern._tag === 'TypePattern') &&
            arm.pattern.complete)),
    ) &&
    !unavailableReachableResult &&
    !hasInvalidGuard &&
    !unavailableEffectComposite &&
    !erasesCallableIdentity &&
    joined._tag === 'Joined'
  ) {
    type = availableExpressionType(
      joinedEffect === undefined
        ? joined.type
        : Type.represented(
            joinedEffect,
            joinedEffect,
            effectAlternatives.length === 1
              ? (effectAlternatives.at(0) ??
                  Type.compositeEffectRepresentationArgument(joinedEffect, effectAlternatives))
              : Type.compositeEffectRepresentationArgument(joinedEffect, effectAlternatives),
          ),
    )
  } else {
    type = unavailableExpressionType
  }
  const fact: MatchExpressionDecision = {
    _tag: 'Match',
    id,
    access,
    scrutinee: expressionNode(scrutinee),
    members: [...(members ?? [])],
    arms: arms,
    exhaustive: coverage.exhaustive,
    type,
    anchor: node.anchor,
  }
  return {
    fact,
    diagnostics: diagnostics,
    type: type._tag === 'Available' ? type.type : undefined,
  }
}

export const callableRepresentationTarget = (
  reference: CallReferenceFact,
): Type.CallableIdentityArgument['target'] | undefined => {
  if (reference._tag === 'Resolved') {
    const canonical = reference.declaration.canonical
    return canonical._tag === 'Canonical'
      ? {
          _tag: 'Declaration',
          module: canonical.id.module,
          name: canonical.id.name,
        }
      : undefined
  }
  return reference._tag === 'ResolvedBuiltin'
    ? {
        _tag: 'Builtin',
        actor: reference.actor,
        operation: reference.operation,
        intrinsic: {
          actor: reference.intrinsic.actor,
          name: reference.intrinsic.name,
        },
      }
    : undefined
}

export const exactCallableRepresentation = (
  reference: CallReferenceFact,
  contract: Type.Callable,
  typeArguments: ReadonlyArray<Type.GenericArgument> = [],
  environment?: Type.CallableEnvironmentIdentity,
): Type.ExactRepresentationArgument | undefined => {
  const target = callableRepresentationTarget(reference)
  if (target === undefined) return undefined
  const identity =
    target._tag === 'Declaration'
      ? `declaration:${target.module}:${target.name}`
      : `builtin:${target.actor}:${target.operation}`
  return Type.exactRepresentationArgument(
    Type.callableIdentityArgument(identity, target, typeArguments, environment),
    contract,
  )
}

export const exactEffectDeclarationRepresentation = (
  declaration: DeclarationFact,
  contract: Type.Effect,
  typeArguments: ReadonlyArray<Type.GenericArgument>,
  staticArguments: ReadonlyArray<StaticValue.Value> = [],
): Type.ExactRepresentationArgument | undefined => {
  if (declaration.functionKind !== 'Effect' || declaration.canonical._tag !== 'Canonical')
    return undefined
  const owner = {
    declaration: {
      module: declaration.canonical.id.module,
      name: declaration.canonical.id.name,
    },
    typeArguments,
    staticArgumentKeys: staticArguments.map(StaticValue.key),
  }
  const site = Tir.effectRootSite(
    { owner: declaration.owner, request: { _tag: 'Check' } },
    declaration.id.ordinal,
    declaration.canonical.id,
  )
  return Type.exactRepresentationArgument(
    Type.effectIdentityArgument(Tir.effectRepresentationIdentity(site), owner),
    contract,
  )
}

export const exactEffectIdentityOfExpression = (
  context: SemanticContext.SemanticContext,
  expression: ExpressionDecision | Tir.Expression,
  builder?: BodyBuilder.BodyBuilder,
): Type.EffectIdentityArgument | undefined => {
  const representation = representationOfExpression(context, expression, builder)
  return representation?._tag === 'ExactRepresentationArgument' &&
    Type.isEffectIdentityArgument(representation.identity)
    ? representation.identity
    : undefined
}

export const hiddenEffectArguments = (
  context: SemanticContext.SemanticContext,
  declaration: DeclarationFact,
  substitution: Type.Substitution,
  argumentAt: (ordinal: number) => ExpressionDecision | Tir.Expression | undefined,
  builder?: BodyBuilder.BodyBuilder,
): ReadonlyArray<Type.EffectIdentityArgument> =>
  declaration.parameters.flatMap((parameter, ordinal) => {
    const declared = parameter.declaredType
    if (declared._tag !== 'Resolved') return []
    const specialized = Type.substitute(declared.type, substitution)
    const contract = Type.isRepresented(specialized) ? specialized.contract : specialized
    if (!Type.isEffect(contract)) return []
    const argument = argumentAt(ordinal)
    const identity =
      argument === undefined
        ? undefined
        : exactEffectIdentityOfExpression(context, argument, builder)
    return identity === undefined ? [] : [identity]
  })

export const exactEffectApplicationContract = (
  _declaration: DeclarationFact,
  _substitution: Type.Substitution,
  contract: Type.Effect,
): Type.Effect => contract

export const effectCallableApplicationRepresentation = (
  context: SemanticContext.SemanticContext,
  expression: CallableApplyExpressionDecision,
  contract: Type.Effect,
  builder?: BodyBuilder.BodyBuilder,
): Type.ExactRepresentationArgument | undefined => {
  const callee = expression.callee
  if (callee._tag !== 'CallableSection' || callee.target._tag !== 'DeclarationCallableTarget')
    return undefined
  const substitution = new Map(callee.substitution)
  for (const [parameter, argument] of expression.substitution) substitution.set(parameter, argument)
  const applicationArgument = (ordinal: number): Tir.Expression | undefined => {
    const captured = callee.captures.find((capture) => capture.parameterOrdinal === ordinal)
    if (captured !== undefined) return captured.value
    const argumentOrdinal = callee.remainingParameters.indexOf(ordinal)
    return argumentOrdinal < 0 ? undefined : expression.arguments.at(argumentOrdinal)?.expression
  }
  const hidden = [
    ...callee.captures.map((capture) => capture.parameterOrdinal),
    ...callee.remainingParameters,
  ]
    .map(applicationArgument)
    .flatMap((argument) => {
      const identity =
        argument === undefined
          ? undefined
          : exactEffectIdentityOfExpression(context, argument, builder)
      return identity === undefined ? [] : [identity]
    })
  const target = callee.target.declaration
  const owner = {
    declaration: { module: target.module, name: target.name },
    typeArguments: [
      ...callee.typeArguments.map((argument) =>
        Type.substituteGenericArgument(argument, substitution),
      ),
      ...hidden,
    ],
    staticArgumentKeys: [] as ReadonlyArray<string>,
  }
  const site = Tir.effectRootSite(callee.site.node.artifact, callee.site.functionOrdinal, target)
  return Type.exactRepresentationArgument(
    Type.effectIdentityArgument(Tir.effectRepresentationIdentity(site), owner),
    contract,
  )
}

/**
 * Recovers a compile-time representation from semantic expression structure. This is deliberately
 * frontend-owned: later phases consume the retained argument and never reconstruct it from syntax.
 */
export function representationOfExpression(
  context: SemanticContext.SemanticContext,
  expression: ExpressionDecision | Tir.Expression,
  builder?: BodyBuilder.BodyBuilder,
): Type.RepresentationArgument | undefined {
  if ('origin' in expression) {
    if (expression.representation !== undefined) return expression.representation
    if (expression._tag !== 'Unavailable' && Type.isRepresented(expression.type))
      return expression.type.representation.argument
    if (expression._tag === 'Move')
      return representationOfExpression(context, expression.subject, builder)
    if (builder !== undefined && expression._tag === 'BindingReference') {
      const semantic = BodyBuilder.semanticOfLocal(builder, expression.binding)
      if (isProviderReferenceFact(semantic) && semantic._tag === 'BindingFact')
        return representationOfExpression(context, semantic.initializer, builder)
    }
    if (
      (expression._tag === 'FunctionItem' || expression._tag === 'CallableSection') &&
      Type.isCallable(expression.type) &&
      (expression._tag !== 'CallableSection' || expression.captures.length === 0)
    ) {
      const target: Type.CallableIdentityArgument['target'] =
        expression.target._tag === 'DeclarationCallableTarget'
          ? {
              _tag: 'Declaration',
              module: expression.target.declaration.module,
              name: expression.target.declaration.name,
            }
          : {
              _tag: 'Builtin',
              actor: expression.target.actor,
              operation: expression.target.operation,
              intrinsic: {
                actor: expression.target.intrinsic.actor,
                name: expression.target.intrinsic.name,
              },
            }
      const identity =
        target._tag === 'Declaration'
          ? `declaration:${target.module}:${target.name}`
          : `builtin:${target.actor}:${target.operation}`
      return Type.exactRepresentationArgument(
        Type.callableIdentityArgument(identity, target, expression.typeArguments),
        expression.type,
      )
    }
    return undefined
  }
  if (expression.type._tag === 'Available' && Type.isRepresented(expression.type.type))
    return expression.type.type.representation.argument
  if (expression._tag === 'FunctionItem' && expression.type._tag === 'Available') {
    const contract = expression.type.type
    return Type.isCallable(contract)
      ? exactCallableRepresentation(expression.reference, contract)
      : undefined
  }
  if (expression._tag === 'CallableSection' && expression.type._tag === 'Available') {
    const contract = expression.type.type
    if (!Type.isCallable(contract)) return undefined
    if (expression.captures.length === 0)
      return exactCallableRepresentation(expression.reference, contract, expression.typeArguments)
    if (expression.environmentOwner === undefined) return undefined
    const environment = Tir.callableEnvironmentIdentity(
      expression.site,
      expression.environmentOwner,
    )
    return exactCallableRepresentation(
      expression.reference,
      contract,
      expression.typeArguments,
      environment,
    )
  }
  if (expression._tag === 'EffectBlock' && expression.type._tag === 'Available') {
    const contract = expression.type.type
    if (!Type.isEffect(contract)) return undefined
    const site = expression.site
    return Type.exactRepresentationArgument(
      Type.effectIdentityArgument(
        Tir.effectRepresentationIdentity(site),
        expression.representationOwner,
      ),
      contract,
    )
  }
  if (
    expression._tag === 'Call' &&
    expression.reference._tag === 'Resolved' &&
    expression.contract._tag === 'Compatible' &&
    expression.type._tag === 'Available' &&
    Type.isEffect(expression.type.type)
  ) {
    return exactEffectDeclarationRepresentation(
      expression.reference.declaration,
      expression.type.type,
      [
        ...expression.contract.typeArguments,
        ...hiddenEffectArguments(
          context,
          expression.reference.declaration,
          expression.contract.substitution,
          (ordinal) => expression.arguments.at(ordinal)?.expression,
          builder,
        ),
      ],
      (expression.staticArguments ?? []).map((argument) => argument.value),
    )
  }
  if (
    expression._tag === 'CallableApply' &&
    expression.type._tag === 'Available' &&
    Type.isEffect(expression.type.type)
  ) {
    return effectCallableApplicationRepresentation(
      context,
      expression,
      expression.type.type,
      builder,
    )
  }
  if (expression._tag === 'Identifier' && expression.reference._tag === 'ResolvedBinding')
    return representationOfExpression(context, expression.reference.binding.initializer, builder)
  if (expression._tag === 'Move')
    return representationOfExpression(context, expression.subject, builder)
  return undefined
}

export interface InferredStructArgument {
  readonly argument: Type.GenericArgument
  readonly span: Location.Location
}

export const isOwnStructArgument = (
  parameter: Type.Parameter,
  argument: Type.GenericArgument,
): boolean => Type.equalsGenericArgument(Type.parameterArgument(parameter), argument)

/** Written field initializers of a struct or variant literal; other shapes write none. */
const writtenFieldsOf = (
  node: AuthoredHir.Expression,
): ReadonlyArray<AuthoredHir.FieldInitializer> => {
  if (node._tag === 'StructExpression') return node.fields
  if (node._tag === 'MemberExpression') return node.fields ?? []
  return []
}

export const analyzeAggregateLiteral = (
  context: SemanticContext.SemanticContext,
  node: AuthoredHir.Expression,
  declarations: ReadonlyArray<DeclarationFact>,
  declaration: DeclarationFact,
  scope: Scope,
  resolution: ResolutionContext,
  contextualTarget?: StructTargetResult,
): ExpressionResult => {
  const selector = node._tag === 'MemberExpression' ? node.selector : undefined
  const unionTarget =
    selector === undefined
      ? resolveBareUnionVariantTarget(context, node, resolution)
      : resolveUnionVariantTarget(context, selector, resolution, declaration)
  // The written type of the aggregate, needed only when neither a contextual nor a union target
  // already resolved it: a member selector names it, a struct literal carries it outright.
  let writtenType: AuthoredHir.Type | undefined
  if (selector !== undefined) writtenType = selector.subject
  else if (node._tag === 'StructExpression') writtenType = node.type
  else writtenType = undefined
  const target =
    contextualTarget ??
    unionTarget ??
    (writtenType === undefined
      ? {
          fact: { _tag: 'Unavailable' } as StructTargetFact,
          diagnostics: [],
        }
      : resolveStructTarget(context, writtenType, resolution, declaration, true))
  const diagnostics: Array<Diagnostic.Located> = [...target.diagnostics]
  let aggregate: DeclarationFacts.StructFact | DeclarationFacts.UnionFact | undefined
  let aggregateFields: ReadonlyArray<DeclarationFacts.FieldFact> = []
  if (target.fact._tag === 'Resolved') {
    if ('union' in target.fact) {
      aggregate = target.fact.union
      aggregateFields = target.fact.variant.fields
    } else {
      aggregate = target.fact.struct
      aggregateFields = target.fact.struct.fields
    }
  }
  const nominal = target.fact._tag === 'Resolved' ? target.fact.type : undefined
  const nominalLabel = nominal === undefined ? 'unknown aggregate' : Type.display(nominal)
  const forbiddenPositionalFields =
    aggregate?._tag === 'StructDeclaration' &&
    aggregate.aggregateKind === 'Positional' &&
    node._tag === 'StructExpression'
  if (forbiddenPositionalFields)
    diagnostics.push(Diagnostic.positionalFieldConstruction(nominalLabel, Location.at(node.anchor)))
  const inferredArguments = new Map<string, InferredStructArgument>()
  const argumentOrigins = new Map<string, ReadonlyArray<Location.Location>>()
  const explicitArguments = new Set<string>()
  if (aggregate !== undefined && nominal !== undefined) {
    for (const [ordinal, parameter] of aggregate.typeParameters.entries()) {
      const argument = nominal.arguments.at(ordinal)
      if (
        argument === undefined ||
        isOwnStructArgument(parameter.type, argument) ||
        (contextualTarget !== undefined &&
          Type.isTypeArgument(argument) &&
          Type.isParameter(argument))
      )
        continue
      const parameterKey = Type.key(parameter.type)
      inferredArguments.set(parameterKey, {
        argument,
        span: Location.at(writtenType?.anchor ?? node.anchor),
      })
      argumentOrigins.set(parameterKey, [Location.at(writtenType?.anchor ?? node.anchor)])
      explicitArguments.add(parameterKey)
    }
  }
  const structSubstitution = new Map<string, Type.GenericArgument>()
  for (const [parameterKey, inferred] of inferredArguments)
    structSubstitution.set(parameterKey, inferred.argument)
  const compatibility = resolution?.lifetimeCompatibility
  const representationInference: TypeInference.LifetimeInference | undefined =
    compatibility === undefined
      ? undefined
      : {
          compatibility,
          inferable: new Set(
            aggregate?.typeParameters.flatMap((parameter) =>
              parameter.type.kind === 'Lifetime' ? [Type.key(parameter.type)] : [],
            ) ?? [],
          ),
          typeOutlives: (type, lifetime) =>
            TypeCompatibility.typeOutlives(compatibility, { type, lifetime }),
          accepts: (context, target, invariant) =>
            typesCompatible(Type.string(context), Type.string(target), compatibility) &&
            (!invariant ||
              typesCompatible(Type.string(target), Type.string(context), compatibility)),
        }
  const definingModule = nominal?.module
  const authorized =
    definingModule !== undefined &&
    aggregate !== undefined &&
    (aggregate.visibility === 'Public' || definingModule === AuthoredWalk.moduleName(context)) &&
    aggregateFields.every(
      (field) =>
        field.visibility === 'Public' || definingModule === AuthoredWalk.moduleName(context),
    )
  const accessDiagnostic =
    nominal !== undefined && !authorized
      ? Diagnostic.inaccessibleStructConstruction(Type.display(nominal), Location.at(node.anchor))
      : undefined
  if (accessDiagnostic !== undefined) diagnostics.push(accessDiagnostic)

  const seen = new Map<string, StructInitializerFact>()
  // A variant literal (`R<A, F>.Success { value: ... }`) carries its initializers on the member
  // expression, not on a struct expression, so both node shapes supply the written fields.
  const writtenFields = writtenFieldsOf(node)
  const initializers = writtenFields.map((initializer): StructInitializerFact => {
    const nameToken = initializer.name
    const name =
      nameToken === undefined ? undefined : (SemanticContext.nameText(context, nameToken) ?? '')
    const fieldLookup =
      aggregate === undefined || name === undefined
        ? undefined
        : DeclarationFacts.lookupField(aggregateFields, name)
    const contextualFieldType =
      fieldLookup?._tag === 'Resolved' && fieldLookup.field.declaredType._tag === 'Resolved'
        ? Type.substitute(fieldLookup.field.declaredType.type, structSubstitution)
        : undefined
    const contextualExpected =
      contextualFieldType !== undefined && Type.isRepresented(contextualFieldType)
        ? contextualFieldType.contract
        : contextualFieldType
    const syntaxExpression = initializer.value
    if (syntaxExpression === undefined) {
      throw new RangeError('Struct initializer requires an expression node')
    }
    const expression = analyzeExpression(
      context,
      syntaxExpression,
      declarations,
      declaration,
      scope,
      resolution,
      contextualExpected,
    )
    if (expression === undefined) {
      throw new RangeError(`Cannot analyze struct initializer ${syntaxExpression._tag}`)
    }
    diagnostics.push(...expression.diagnostics)
    let state: StructInitializerState = { _tag: 'Unavailable' }
    if (name !== undefined && nameToken !== undefined && aggregate !== undefined) {
      const previous = seen.get(name)
      if (forbiddenPositionalFields) {
        state = { _tag: 'Unavailable' }
      } else if (fieldLookup?._tag !== 'Resolved') {
        const diagnostic = Diagnostic.unknownStructField(
          nominalLabel,
          name,
          Location.at(nameToken.anchor),
        )
        diagnostics.push(diagnostic)
        state = { _tag: 'Unknown', cause: Diagnostic.identity(diagnostic) }
      } else if (previous !== undefined) {
        const diagnostic = Diagnostic.duplicateStructInitializer(
          name,
          Location.at(previous.anchor),
          Location.at(nameToken.anchor),
        )
        diagnostics.push(diagnostic)
        state = {
          _tag: 'Duplicate',
          field: fieldLookup.field,
          cause: Diagnostic.identity(diagnostic),
        }
      } else if (
        fieldLookup.field.visibility === 'Private' &&
        nominal !== undefined &&
        nominal.module !== AuthoredWalk.moduleName(context) &&
        accessDiagnostic !== undefined
      ) {
        state = {
          _tag: 'Inaccessible',
          field: fieldLookup.field,
          cause: Diagnostic.identity(accessDiagnostic),
        }
      } else if (
        fieldLookup.field.declaredType._tag === 'Resolved' &&
        expression.type !== undefined
      ) {
        const expectedType = fieldLookup.field.declaredType.type
        const expectedValue = Type.isRepresented(expectedType)
          ? expectedType.contract
          : expectedType
        const actualValue = Type.isRepresented(expression.type)
          ? expression.type.contract
          : expression.type
        let representationDiagnostic: Diagnostic.Located | undefined
        if (Type.isRepresented(expectedType)) {
          const currentSubstitution = new Map(structSubstitution)
          for (const [parameterKey, inferred] of inferredArguments)
            currentSubstitution.set(parameterKey, inferred.argument)
          const candidateSubstitution = new Map(currentSubstitution)
          if (
            TypeInference.infer(
              expectedType.contract,
              actualValue,
              candidateSubstitution,
              representationInference,
            )
          ) {
            const siteSubstitution = new Map<string, Type.GenericArgument>()
            TypeInference.infer(
              expectedType.contract,
              actualValue,
              siteSubstitution,
              representationInference,
            )
            for (const parameter of aggregate.typeParameters) {
              if (
                parameter.type.kind === 'CallableRepresentation' ||
                parameter.type.kind === 'EffectRepresentation'
              )
                continue
              const parameterKey = Type.key(parameter.type)
              const inferred = siteSubstitution.get(parameterKey)
              if (inferred === undefined || isOwnStructArgument(parameter.type, inferred)) continue
              if (inferredArguments.get(parameterKey) === undefined)
                inferredArguments.set(parameterKey, {
                  argument: inferred,
                  span: Location.at(syntaxExpression.anchor),
                })
              argumentOrigins.set(parameterKey, [
                ...(argumentOrigins.get(parameterKey) ?? []),
                Location.at(syntaxExpression.anchor),
              ])
            }
          }
          const representationSubstitution = new Map(structSubstitution)
          for (const [parameterKey, inferred] of inferredArguments)
            representationSubstitution.set(parameterKey, inferred.argument)
          const specialized = Type.substitute(expectedType, representationSubstitution)
          if (!Type.isRepresented(specialized))
            throw new RangeError('represented struct field lost its representation contract')
          const specializedExpectedType = specialized
          const actualRepresentation = representationOfExpression(context, expression.fact)
          const requiredArgument = expectedType.representation.argument
          if (actualRepresentation === undefined) {
            representationDiagnostic = Diagnostic.structFieldTypeMismatch(
              name,
              Type.display(specializedExpectedType),
              Type.display(expression.type),
              Location.at(syntaxExpression.anchor),
            )
          } else if (requiredArgument._tag === 'RepresentationParameterArgument') {
            const parameter = requiredArgument.parameter
            const parameterKey = Type.key(parameter)
            const previousRepresentation = inferredArguments.get(parameterKey)
            if (
              previousRepresentation !== undefined &&
              !Type.equalsGenericArgument(previousRepresentation.argument, actualRepresentation)
            ) {
              representationDiagnostic = Diagnostic.conflictingInitializerRepresentation(
                parameter.name,
                Type.encodeGenericArgument(previousRepresentation.argument),
                Type.encodeGenericArgument(actualRepresentation),
                previousRepresentation.span,
                Location.at(syntaxExpression.anchor),
              )
            } else {
              const represented = Type.represented(
                Type.isCallable(actualValue) || Type.isEffect(actualValue)
                  ? actualValue
                  : specializedExpectedType.contract,
                specializedExpectedType.representation.requiredBound,
                actualRepresentation,
              )
              if (represented.representation.admissibility._tag === 'Unavailable') {
                const requiredParameter = aggregate.typeParameters.find(
                  (candidate) => Type.key(candidate.type) === Type.key(parameter),
                )
                const actualParameter =
                  actualRepresentation._tag === 'RepresentationParameterArgument'
                    ? declaration.typeParameters.find(
                        (candidate) =>
                          Type.key(candidate.type) === Type.key(actualRepresentation.parameter),
                      )
                    : undefined
                representationDiagnostic = Diagnostic.incompatibleRepresentationBound(
                  parameter.name,
                  Type.display(specializedExpectedType.representation.requiredBound),
                  Type.display(represented.contract),
                  Location.at(syntaxExpression.anchor),
                  {
                    ...(requiredParameter === undefined
                      ? {}
                      : { requiredDeclarationSpan: Location.at(requiredParameter.anchor) }),
                    ...(actualParameter === undefined
                      ? {}
                      : { actualDeclarationSpan: Location.at(actualParameter.anchor) }),
                  },
                )
                if (previousRepresentation === undefined)
                  inferredArguments.set(parameterKey, {
                    argument: actualRepresentation,
                    span: Location.at(syntaxExpression.anchor),
                  })
              } else if (previousRepresentation === undefined) {
                inferredArguments.set(parameterKey, {
                  argument: actualRepresentation,
                  span: Location.at(syntaxExpression.anchor),
                })
              }
              if (
                previousRepresentation === undefined ||
                Type.equalsGenericArgument(previousRepresentation.argument, actualRepresentation)
              )
                argumentOrigins.set(parameterKey, [
                  ...(argumentOrigins.get(parameterKey) ?? []),
                  Location.at(syntaxExpression.anchor),
                ])
            }
          } else if (!Type.equalsGenericArgument(requiredArgument, actualRepresentation)) {
            representationDiagnostic = Diagnostic.structFieldTypeMismatch(
              name,
              Type.encodeGenericArgument(requiredArgument),
              Type.encodeGenericArgument(actualRepresentation),
              Location.at(syntaxExpression.anchor),
            )
          }
        } else {
          const currentSubstitution = new Map(structSubstitution)
          for (const [parameterKey, inferred] of inferredArguments)
            currentSubstitution.set(parameterKey, inferred.argument)
          const candidateSubstitution = new Map(currentSubstitution)
          if (
            !TypeInference.infer(expectedType, expression.type, candidateSubstitution) &&
            !typesCompatible(
              actualValue,
              Type.substitute(expectedType, currentSubstitution),
              resolution?.lifetimeCompatibility,
            )
          ) {
            const impliedSubstitution = new Map<string, Type.GenericArgument>()
            if (TypeInference.infer(expectedType, expression.type, impliedSubstitution)) {
              for (const parameter of aggregate.typeParameters) {
                if (parameter.type.kind !== 'Value') continue
                const parameterKey = Type.key(parameter.type)
                const previous = inferredArguments.get(parameterKey)
                const implied = impliedSubstitution.get(parameterKey)
                if (
                  previous === undefined ||
                  implied === undefined ||
                  Type.equalsGenericArgument(previous.argument, implied)
                )
                  continue
                representationDiagnostic = Diagnostic.typeArgumentConflict(
                  nominalLabel,
                  parameter.type.name,
                  Type.encodeGenericArgument(previous.argument),
                  Type.encodeGenericArgument(implied),
                  Location.at(syntaxExpression.anchor),
                  previous.span,
                )
                break
              }
            }
            const specializedExpected = Type.substitute(expectedType, currentSubstitution)
            const divergence = Type.firstRepresentationDivergence(
              specializedExpected,
              expression.type,
            )
            if (representationDiagnostic === undefined && divergence !== undefined) {
              const parameter = aggregate.typeParameters.find((candidate) => {
                const inferred = inferredArguments.get(Type.key(candidate.type))
                return (
                  inferred !== undefined &&
                  Type.equalsGenericArgument(inferred.argument, divergence.left)
                )
              })
              const original =
                parameter === undefined
                  ? undefined
                  : inferredArguments.get(Type.key(parameter.type))
              if (parameter !== undefined && original !== undefined)
                representationDiagnostic = Diagnostic.conflictingInitializerRepresentation(
                  parameter.type.name,
                  Type.encodeGenericArgument(divergence.left),
                  Type.encodeGenericArgument(divergence.right),
                  original.span,
                  Location.at(syntaxExpression.anchor),
                )
            }
          } else {
            const siteSubstitution = new Map<string, Type.GenericArgument>()
            TypeInference.infer(expectedType, expression.type, siteSubstitution)
            for (const parameter of aggregate.typeParameters) {
              const parameterKey = Type.key(parameter.type)
              const inferred = siteSubstitution.get(parameterKey)
              if (
                inferredArguments.get(parameterKey) === undefined &&
                inferred !== undefined &&
                !isOwnStructArgument(parameter.type, inferred)
              ) {
                inferredArguments.set(parameterKey, {
                  argument: inferred,
                  span: Location.at(syntaxExpression.anchor),
                })
                argumentOrigins.set(parameterKey, [Location.at(syntaxExpression.anchor)])
              } else if (
                inferred !== undefined &&
                !isOwnStructArgument(parameter.type, inferred) &&
                Type.equalsGenericArgument(
                  inferredArguments.get(parameterKey)?.argument ?? inferred,
                  inferred,
                )
              ) {
                argumentOrigins.set(parameterKey, [
                  ...(argumentOrigins.get(parameterKey) ?? []),
                  Location.at(syntaxExpression.anchor),
                ])
              }
            }
          }
        }
        const compatibilitySubstitution = new Map(structSubstitution)
        for (const [parameterKey, inferred] of inferredArguments)
          compatibilitySubstitution.set(parameterKey, inferred.argument)
        const compatibleExpected = Type.substitute(expectedValue, compatibilitySubstitution)
        const compatibleValue = typesCompatible(
          actualValue,
          compatibleExpected,
          resolution?.lifetimeCompatibility,
        )
        if (representationDiagnostic !== undefined || !compatibleValue) {
          const diagnostic =
            representationDiagnostic ??
            unionConversionDiagnostic(
              actualValue,
              compatibleExpected,
              Location.at(syntaxExpression.anchor),
              resolution?.lifetimeCompatibility,
            ) ??
            Diagnostic.structFieldTypeMismatch(
              name,
              Type.display(compatibleExpected),
              Type.display(actualValue),
              Location.at(syntaxExpression.anchor),
            )
          diagnostics.push(diagnostic)
          state = {
            _tag: 'TypeMismatch',
            field: fieldLookup.field,
            cause: Diagnostic.identity(diagnostic),
          }
        } else {
          state = { _tag: 'Resolved', field: fieldLookup.field }
        }
      }
    }
    const fact: StructInitializerFact = {
      _tag: 'StructInitializer',
      name,
      ...(nameToken === undefined ? {} : { nameAnchor: nameToken.anchor }),
      expression: expressionNode(expression),
      state,
      anchor: initializer.anchor,
    }
    if (name !== undefined && !seen.has(name)) seen.set(name, fact)
    return fact
  })

  const completedArguments =
    aggregate === undefined || nominal === undefined
      ? undefined
      : nominal.arguments.map((argument, ordinal): Type.GenericArgument => {
          const parameter = aggregate.typeParameters.at(ordinal)?.type
          if (parameter === undefined) return argument
          return inferredArguments.get(Type.key(parameter))?.argument ?? argument
        })
  let unresolvedParameters: DeclarationFacts.TypeParameterFact[]
  if (aggregate === undefined || completedArguments === undefined) {
    unresolvedParameters = []
  } else {
    unresolvedParameters = aggregate.typeParameters.flatMap((parameter, ordinal) => {
      const argument = completedArguments.at(ordinal)
      return argument !== undefined && isOwnStructArgument(parameter.type, argument)
        ? [parameter]
        : []
    })
  }
  for (const parameter of unresolvedParameters) {
    diagnostics.push(
      Diagnostic.uninferredTypeParameter(
        nominalLabel,
        parameter.type.name,
        Location.at(parameter.anchor),
      ),
    )
  }
  const completedNominal =
    nominal === undefined ||
    completedArguments === undefined ||
    unresolvedParameters.length > 0 ||
    (aggregate !== undefined &&
      TypeInference.substitution(
        aggregate.typeParameters.map((parameter) => parameter.type),
        completedArguments,
      ) === undefined)
      ? undefined
      : Type.nominal(nominal.module, nominal.name, completedArguments)
  const typeArguments: ReadonlyArray<StructTypeArgumentFact> =
    aggregate?.typeParameters.map((parameter, ordinal) => {
      const parameterKey = Type.key(parameter.type)
      const argument = completedArguments?.at(ordinal)
      const origins = argumentOrigins.get(parameterKey) ?? []
      const unavailable = argument === undefined || isOwnStructArgument(parameter.type, argument)
      let source: StructTypeArgumentFact['source']
      if (unavailable) source = 'Unavailable'
      else if (explicitArguments.has(parameterKey)) source = 'Explicit'
      else source = 'Inferred'
      return {
        parameter: parameter.type,
        ...(unavailable ? {} : { argument }),
        source,
        origins,
      }
    }) ?? []
  if (aggregate !== undefined && completedNominal !== undefined) {
    for (const field of aggregateFields) {
      if (field.name._tag !== 'Present' || seen.has(field.name.spelling)) continue
      if (
        field.visibility === 'Private' &&
        completedNominal.module !== AuthoredWalk.moduleName(context)
      )
        continue
      diagnostics.push(
        Diagnostic.missingStructInitializer(
          Type.display(completedNominal),
          field.name.spelling,
          Location.at(node.anchor),
        ),
      )
    }
  }

  let fields: { field: DeclarationFacts.FieldFact; initializer: StructInitializerFact }[]
  if (aggregate === undefined) {
    fields = []
  } else {
    fields = aggregateFields.flatMap((field) => {
      if (field.name._tag !== 'Present') return []
      const fieldName = field.name.spelling
      const initializer = initializers.find(
        (candidate) => candidate.name === fieldName && candidate.state._tag === 'Resolved',
      )
      return initializer === undefined ? [] : [{ field, initializer }]
    })
  }
  const complete =
    aggregate !== undefined &&
    completedNominal !== undefined &&
    authorized &&
    !forbiddenPositionalFields &&
    AuthoredWalk.isAvailable(node) &&
    fields.length === aggregateFields.length &&
    initializers.length === aggregateFields.length &&
    initializers.every((initializer) => initializer.state._tag === 'Resolved')
  const type =
    complete && completedNominal !== undefined
      ? availableExpressionType(completedNominal)
      : unavailableExpressionType
  let fact: ExpressionDecision
  if (unionTarget === undefined) {
    let structTarget: StructTargetFact
    if (target.fact._tag === 'Resolved' && 'struct' in target.fact) {
      structTarget =
        completedNominal === undefined ? target.fact : { ...target.fact, type: completedNominal }
    } else {
      structTarget = {
        _tag: 'Unavailable',
        ...(target.fact._tag === 'Unavailable' && target.fact.cause !== undefined
          ? { cause: target.fact.cause }
          : {}),
      }
    }
    fact = {
      _tag: 'StructLiteral',
      target: structTarget,
      authorized,
      typeArguments,
      initializers: initializers,
      fields: fields,
      type,
      anchor: node.anchor,
    }
  } else {
    const variantTarget: UnionVariantTargetFact =
      completedNominal !== undefined && unionTarget.fact._tag === 'Resolved'
        ? { ...unionTarget.fact, type: completedNominal }
        : unionTarget.fact
    fact = {
      _tag: 'UnionVariant',
      target: variantTarget,
      authorized,
      typeArguments,
      initializers: initializers,
      fields: fields,
      type,
      anchor: node.anchor,
    }
  }
  return {
    fact,
    diagnostics: diagnostics,
    type: complete ? completedNominal : undefined,
  }
}

export const analyzeArrayLiteral = (
  context: SemanticContext.SemanticContext,
  node: Extract<AuthoredHir.Expression, { readonly _tag: 'ArrayExpression' }>,
  declarations: ReadonlyArray<DeclarationFact>,
  declaration: DeclarationFact,
  scope: Scope,
  resolution: ResolutionContext,
  expected?: SemanticType,
): ExpressionResult => {
  const expectedArray = expected !== undefined && Type.isFixedArray(expected) ? expected : undefined
  const elementNodes = node._tag === 'ArrayExpression' ? node.elements : []
  const diagnostics: Array<Diagnostic.Located> = []
  let elementType = expectedArray?.element
  let elementOrigin = expectedArray === undefined ? undefined : Location.at(node.anchor)
  const elements = elementNodes.map((elementNode, ordinal): ArrayElementFact => {
    const element = analyzeExpression(
      context,
      elementNode,
      declarations,
      declaration,
      scope,
      resolution,
      elementType,
    )
    if (element === undefined)
      throw new RangeError(`Cannot analyze array element ${elementNode._tag}`)
    diagnostics.push(...element.diagnostics)
    if (elementType === undefined && element.type !== undefined) {
      elementType = element.type
      elementOrigin = Location.at(elementNode.anchor)
    }
    let compatibility: ArrayElementFact['compatibility']
    if (element.type === undefined || elementType === undefined) {
      compatibility = { _tag: 'Unavailable' }
    } else if (!typesCompatible(element.type, elementType, resolution?.lifetimeCompatibility)) {
      const diagnostic =
        representationJoinDiagnostic(
          elementType,
          element.type,
          elementOrigin ?? Location.at(node.anchor),
          Location.at(elementNode.anchor),
          Location.at(elementNode.anchor),
        ) ??
        unionConversionDiagnostic(
          element.type,
          elementType,
          Location.at(elementNode.anchor),
          resolution?.lifetimeCompatibility,
        ) ??
        Diagnostic.arrayElementTypeMismatch(
          Type.display(elementType),
          Type.display(element.type),
          ordinal,
          Location.at(elementNode.anchor),
        )
      diagnostics.push(diagnostic)
      compatibility = {
        _tag: 'TypeMismatch',
        expected: elementType,
        actual: element.type,
      }
    } else {
      compatibility = { _tag: 'Compatible' }
    }
    return {
      _tag: 'ArrayElement',
      ordinal,
      expression: expressionNode(element),
      ...(elementType === undefined ? {} : { expected: elementType }),
      compatibility,
      anchor: elementNode.anchor,
    }
  })

  const actualLength = elements.length
  let state: ArrayLiteralState
  if (elementType === undefined && actualLength === 0) {
    const diagnostic = Diagnostic.emptyArrayNeedsContext(Location.at(node.anchor))
    diagnostics.push(diagnostic)
    state = { _tag: 'MissingContext' }
  } else if (expectedArray !== undefined && expectedArray.length !== actualLength) {
    const diagnostic = Diagnostic.arrayLengthMismatch(
      expectedArray.length,
      actualLength,
      Location.at(node.anchor),
    )
    diagnostics.push(diagnostic)
    state = {
      _tag: 'LengthMismatch',
      expected: expectedArray.length,
      actual: actualLength,
    }
  } else if (elements.some((element) => element.compatibility._tag === 'TypeMismatch')) {
    state = { _tag: 'IncompatibleElements' }
  } else if (
    elementType === undefined ||
    elements.some((element) => element.compatibility._tag === 'Unavailable') ||
    !AuthoredWalk.isAvailable(node)
  ) {
    state = { _tag: 'Unavailable' }
  } else {
    state = {
      _tag: 'Complete',
      type: expectedArray ?? Type.fixedArray(elementType, actualLength),
    }
  }
  const type =
    state._tag === 'Complete' ? availableExpressionType(state.type) : unavailableExpressionType
  return {
    fact: {
      _tag: 'ArrayLiteral',
      elements: elements,
      ...(expectedArray === undefined ? {} : { expected: expectedArray }),
      ...(elementType === undefined ? {} : { elementType }),
      length: actualLength,
      state,
      type,
      anchor: node.anchor,
    },
    diagnostics: diagnostics,
    type: type._tag === 'Available' ? type.type : undefined,
  }
}

export const analyzeIndexProjection = (
  context: SemanticContext.SemanticContext,
  node: Extract<AuthoredHir.Expression, { readonly _tag: 'IndexExpression' }>,
  declarations: ReadonlyArray<DeclarationFact>,
  declaration: DeclarationFact,
  scope: Scope,
  resolution: ResolutionContext,
): ExpressionResult => {
  const expressions = AuthoredWalk.expressionChildren(node)
  const subjectNode = expressions.at(0)
  const indexNode = expressions.at(1)
  if (subjectNode === undefined || indexNode === undefined) {
    throw new RangeError('Index projection requires subject and index expressions')
  }
  const subject = analyzeExpression(
    context,
    subjectNode,
    declarations,
    declaration,
    scope,
    resolution,
  )
  const index = analyzeExpression(
    context,
    indexNode,
    declarations,
    declaration,
    scope,
    resolution,
    'usize',
  )
  if (subject === undefined || index === undefined) {
    throw new RangeError('Cannot analyze index projection operands')
  }
  const diagnostics: Array<Diagnostic.Located> = [...subject.diagnostics, ...index.diagnostics]
  const array =
    subject.type !== undefined && Type.isFixedArray(subject.type) ? subject.type : undefined
  const slice = subject.type !== undefined && Type.isSlice(subject.type) ? subject.type : undefined
  if (subject.type !== undefined && array === undefined && slice === undefined) {
    diagnostics.push(
      Diagnostic.indexOnNonArray(Type.display(subject.type), Location.at(subjectNode.anchor)),
    )
  }
  if (index.type !== undefined && index.type !== 'usize') {
    diagnostics.push(
      Diagnostic.indexNotUsize(Type.display(index.type), Location.at(indexNode.anchor)),
    )
  }
  let bounds: BoundsFact = { _tag: 'Unavailable' }
  if (array !== undefined && index.type === 'usize') {
    let literal: number | undefined
    if (index.fact._tag === 'Integer' && index.fact.integer._tag === 'Available') {
      if (index.fact.integer.value <= BigInt(Number.MAX_SAFE_INTEGER)) {
        literal = Number(index.fact.integer.value)
      } else {
        literal = Number.POSITIVE_INFINITY
      }
    } else {
      literal = undefined
    }
    if (literal === undefined) bounds = { _tag: 'Runtime', length: array.length }
    else if (literal < 0 || literal >= array.length) {
      const diagnostic = Diagnostic.indexOutOfBounds(
        literal,
        array.length,
        Location.at(indexNode.anchor),
      )
      diagnostics.push(diagnostic)
      bounds = {
        _tag: 'Invalid',
        index: literal,
        length: array.length,
        cause: Diagnostic.identity(diagnostic),
      }
    } else bounds = { _tag: 'Proven', index: literal, length: array.length }
  } else if (slice !== undefined && index.type === 'usize') {
    bounds = { _tag: 'RuntimeSlice' }
  }
  const available =
    (array !== undefined || slice !== undefined) &&
    index.type === 'usize' &&
    bounds._tag !== 'Invalid' &&
    bounds._tag !== 'Unavailable' &&
    AuthoredWalk.isAvailable(node)
  const element = array?.element ?? slice?.element
  const type =
    available && element !== undefined
      ? availableExpressionType(element)
      : unavailableExpressionType
  const root = assignmentRoot(subject.fact)
  const inheritedAccess =
    subject.fact._tag === 'FieldProjection' ||
    subject.fact._tag === 'ReferentProjection' ||
    subject.fact._tag === 'IndexProjection'
      ? subject.fact.placeBorrowAccess
      : undefined
  const placeBorrowAccess = combinedBorrowAccess(inheritedAccess, slice?.access)
  const baseBorrowRoot = borrowRoot(context, subject.fact)
  const projectedBorrowRoot = (() => {
    if (baseBorrowRoot === undefined) return undefined
    if (array !== undefined && (bounds._tag === 'Proven' || bounds._tag === 'Runtime'))
      return {
        ...baseBorrowRoot,
        path: [
          ...baseBorrowRoot.path,
          {
            _tag: 'Index' as const,
            index: expressionNode(index),
            array,
            bounds,
            span: context.spanOf(node.anchor),
            at: node.anchor,
          },
        ],
      }
    if (slice !== undefined && bounds._tag === 'RuntimeSlice')
      return {
        ...baseBorrowRoot,
        path: [
          ...baseBorrowRoot.path,
          {
            _tag: 'SliceIndex' as const,
            index: expressionNode(index),
            slice,
            span: context.spanOf(node.anchor),
            at: node.anchor,
          },
        ],
      }
    return undefined
  })()
  return {
    fact: {
      _tag: 'IndexProjection',
      subject: expressionNode(subject),
      index: expressionNode(index),
      ...(root === undefined ? {} : { root }),
      ...(projectedBorrowRoot === undefined ? {} : { borrowRoot: projectedBorrowRoot }),
      ...(placeBorrowAccess === undefined ? {} : { placeBorrowAccess }),
      ...(array === undefined ? {} : { array, elementType: array.element }),
      ...(slice === undefined
        ? {}
        : { slice, elementType: slice.element, borrowAccess: slice.access }),
      access: 'CopyRead',
      bounds,
      type,
      anchor: node.anchor,
    },
    diagnostics: diagnostics,
    type: type._tag === 'Available' ? type.type : undefined,
  }
}

export const analyzeProjection = (
  context: SemanticContext.SemanticContext,
  node: AuthoredHir.Expression,
  declarations: ReadonlyArray<DeclarationFact>,
  declaration: DeclarationFact,
  scope: Scope,
  resolution: ResolutionContext,
): ExpressionResult => {
  const subjectNode = AuthoredWalk.expressionChildren(node).at(0)
  if (subjectNode === undefined) throw new RangeError('Projection requires a subject expression')
  const subject = analyzeExpression(
    context,
    subjectNode,
    declarations,
    declaration,
    scope,
    resolution,
  )
  if (subject === undefined) throw new RangeError(`Cannot analyze projection ${subjectNode._tag}`)
  const diagnostics: Array<Diagnostic.Located> = [...subject.diagnostics]
  const ordinalToken = node._tag === 'OrdinalExpression' ? node.ordinal : undefined
  const ordinal = ordinalToken?._tag === 'IntegerLiteral' ? Number(ordinalToken.value) : undefined
  const labeledToken = node._tag === 'FieldExpression' ? node.field : undefined
  const fieldAnchor = (ordinalToken ?? labeledToken)?.anchor
  let fieldName: string | undefined
  if (ordinal !== undefined) fieldName = `${ordinal}`
  else if (labeledToken !== undefined)
    fieldName = SemanticContext.nameText(context, labeledToken) ?? ''
  // A reference projects the fields of its target: the read happens through the borrow, so
  // the projected value is typed by the target while consumption stays a partial-move error.
  const reference =
    subject.type !== undefined &&
    Type.isReference(subject.type) &&
    Type.isNominal(subject.type.target)
      ? subject.type
      : undefined
  let nominal: Type.Nominal | undefined
  if (subject.type !== undefined && Type.isNominal(subject.type)) {
    nominal = subject.type
  } else if (reference !== undefined && Type.isNominal(reference.target)) {
    nominal = reference.target
  } else {
    nominal = undefined
  }
  const slice = subject.type !== undefined && Type.isSlice(subject.type) ? subject.type : undefined
  const borrowAccess =
    subject.fact._tag === 'IndexProjection' || subject.fact._tag === 'FieldProjection'
      ? subject.fact.borrowAccess
      : undefined
  let state: ProjectionState = { _tag: 'Unavailable' }
  let type: SemanticType | undefined
  if (slice !== undefined && fieldName === 'length') {
    state = { _tag: 'SliceLength' }
    type = 'usize'
  } else if (slice !== undefined && fieldName !== undefined && fieldAnchor !== undefined) {
    const diagnostic = Diagnostic.unknownProjectedField(
      Type.display(slice),
      fieldName,
      Location.at(fieldAnchor),
    )
    diagnostics.push(diagnostic)
    state = { _tag: 'Unavailable', cause: Diagnostic.identity(diagnostic) }
  } else if (subject.type !== undefined && nominal === undefined && fieldAnchor !== undefined) {
    const diagnostic = Diagnostic.projectionOnNonStruct(
      Type.display(subject.type),
      Location.at(fieldAnchor),
    )
    diagnostics.push(diagnostic)
    state = { _tag: 'Unavailable', cause: Diagnostic.identity(diagnostic) }
  } else if (nominal !== undefined && fieldName !== undefined && fieldAnchor !== undefined) {
    const struct = aggregateByNominal(resolution, nominal)
    const lookup =
      struct === undefined
        ? undefined
        : DeclarationFacts.lookupAggregateMember(
            struct.fields,
            ordinal === undefined
              ? AggregateIdentity.labeled(fieldName)
              : AggregateIdentity.ordinal(ordinal),
          )
    if (lookup?._tag !== 'Resolved') {
      // A receiver method named through a value binds that value as parameter zero, unless a
      // borrowed receiver is a temporary the section would outlive.
      const candidate = resolveMethodCandidate(
        context,
        nominal,
        fieldName,
        fieldAnchor,
        declaration,
        resolution,
      )
      const temporaryReceiver =
        candidate._tag === 'Inherent' && borrowsTemporary(context, candidate.declaration, subject)
      if (candidate._tag === 'Inherent' && !temporaryReceiver)
        return finishBoundMethod(
          context,
          node,
          subjectNode,
          subject,
          candidate,
          fieldName,
          fieldAnchor,
          declaration,
          resolution,
        )
      let diagnostic: Diagnostic.Located
      if (temporaryReceiver) {
        diagnostic = Diagnostic.invalidBorrowOperand(Location.at(subjectNode.anchor))
      } else if (candidate._tag === 'NoReceiver') {
        diagnostic = Diagnostic.associatedFunctionOnValue(
          candidate.ownerSpelling,
          fieldName,
          Location.at(fieldAnchor),
        )
      } else if (candidate._tag === 'Unavailable' && candidate.diagnostic !== undefined) {
        diagnostic = candidate.diagnostic
      } else if (candidate._tag === 'Conformance' || candidate._tag === 'AmbiguousConformance') {
        // A supplied operation is a real member that this spelling cannot bind: a first-class value
        // would have to carry its witness, which the qualified call does not need either.
        diagnostic = Diagnostic.suppliedOperationValue(
          Type.display(nominal),
          fieldName,
          Location.at(fieldAnchor),
        )
      } else {
        diagnostic = Diagnostic.unknownProjectedField(
          Type.display(nominal),
          fieldName,
          Location.at(fieldAnchor),
        )
      }
      diagnostics.push(diagnostic)
      state = { _tag: 'Unavailable', cause: Diagnostic.identity(diagnostic) }
    } else if (
      lookup.field.visibility === 'Private' &&
      nominal.module !== AuthoredWalk.moduleName(context)
    ) {
      const diagnostic = Diagnostic.inaccessibleProjectedField(
        Type.display(nominal),
        fieldName,
        Location.at(fieldAnchor),
      )
      diagnostics.push(diagnostic)
      state = { _tag: 'Unavailable', cause: Diagnostic.identity(diagnostic) }
    } else if (lookup.field.declaredType._tag === 'Resolved') {
      state = { _tag: 'Resolved', field: lookup.field }
      const substitution =
        struct === undefined
          ? new Map<string, SemanticType>()
          : (TypeInference.substitution(
              struct.typeParameters.map((parameter) => parameter.type),
              nominal.arguments,
            ) ?? new Map())
      type = Type.substitute(lookup.field.declaredType.type, substitution)
    }
  }
  const typeFact = type === undefined ? unavailableExpressionType : availableExpressionType(type)
  const projectionAccess = borrowAccess ?? reference?.access
  const root = assignmentRoot(subject.fact)
  const inheritedAccess =
    subject.fact._tag === 'FieldProjection' ||
    subject.fact._tag === 'ReferentProjection' ||
    subject.fact._tag === 'IndexProjection'
      ? subject.fact.placeBorrowAccess
      : undefined
  const placeBorrowAccess = combinedBorrowAccess(inheritedAccess, undefined)
  const baseBorrowRoot = borrowRoot(context, subject.fact)
  const projectedBorrowRoot =
    state._tag === 'Resolved' && baseBorrowRoot !== undefined
      ? {
          ...baseBorrowRoot,
          path: [
            ...baseBorrowRoot.path,
            {
              _tag: 'Field' as const,
              field: state.field.id,
              span: context.spanOf(node.anchor),
              at: node.anchor,
            },
          ],
        }
      : undefined
  const projection: FieldProjectionExpressionDecision = {
    _tag: 'FieldProjection',
    subject: expressionNode(subject),
    ...(root === undefined ? {} : { root }),
    ...(projectedBorrowRoot === undefined ? {} : { borrowRoot: projectedBorrowRoot }),
    ...(placeBorrowAccess === undefined ? {} : { placeBorrowAccess }),
    ...(nominal === undefined ? {} : { nominal }),
    ...(projectionAccess === undefined ? {} : { borrowAccess: projectionAccess }),
    fieldName,
    ...(fieldAnchor === undefined ? {} : { fieldAnchor }),
    state,
    type: typeFact,
    anchor: node.anchor,
  }
  const evaluated =
    resolution.staticContext === undefined
      ? undefined
      : evaluateStatic(projection, resolution.staticContext, resolution)
  const fact: FieldProjectionExpressionDecision =
    evaluated?._tag === 'Complete' ? { ...projection, staticValue: evaluated.value } : projection
  return {
    fact,
    diagnostics: diagnostics,
    type,
  }
}

export const analyzeReferentProjection = (
  context: SemanticContext.SemanticContext,
  node: Extract<AuthoredHir.Expression, { readonly _tag: 'ReferentExpression' }>,
  declarations: ReadonlyArray<DeclarationFact>,
  declaration: DeclarationFact,
  scope: Scope,
  resolution: ResolutionContext,
): ExpressionResult => {
  const subjectNode = AuthoredWalk.expressionChildren(node).at(0)
  if (subjectNode === undefined)
    throw new RangeError('Referent projection requires a subject expression')
  const subject = analyzeExpression(
    context,
    subjectNode,
    declarations,
    declaration,
    scope,
    resolution,
  )
  if (subject === undefined)
    throw new RangeError(`Cannot analyze referent projection ${subjectNode._tag}`)
  const diagnostics: Array<Diagnostic.Located> = [...subject.diagnostics]
  const reference =
    subject.type !== undefined && Type.isReference(subject.type) ? subject.type : undefined
  let state: ReferentProjectionState
  if (reference === undefined && subject.type !== undefined) {
    const diagnostic = Diagnostic.invalidReferentProjection(
      Type.encode(subject.type),
      Location.at(node.anchor),
    )
    diagnostics.push(diagnostic)
    state = { _tag: 'Unavailable', cause: Diagnostic.identity(diagnostic) }
  } else if (reference === undefined) {
    state = { _tag: 'Unavailable' }
  } else {
    state = { _tag: 'Resolved', reference }
  }
  const type =
    reference === undefined ? unavailableExpressionType : availableExpressionType(reference.target)
  const root = assignmentRoot(subject.fact)
  const inheritedAccess =
    subject.fact._tag === 'FieldProjection' ||
    subject.fact._tag === 'ReferentProjection' ||
    subject.fact._tag === 'IndexProjection'
      ? subject.fact.placeBorrowAccess
      : undefined
  const placeBorrowAccess = combinedBorrowAccess(inheritedAccess, reference?.access)
  const projectedBorrowRoot =
    state._tag === 'Resolved' ? borrowRoot(context, subject.fact) : undefined
  return {
    fact: {
      _tag: 'ReferentProjection',
      subject: expressionNode(subject),
      ...(root === undefined ? {} : { root }),
      ...(projectedBorrowRoot === undefined ? {} : { borrowRoot: projectedBorrowRoot }),
      ...(placeBorrowAccess === undefined ? {} : { placeBorrowAccess }),
      ...(reference === undefined ? {} : { reference, borrowAccess: reference.access }),
      state,
      type,
      anchor: node.anchor,
    },
    diagnostics: diagnostics,
    type: type._tag === 'Available' ? type.type : undefined,
  }
}

import type { CallTypeArgumentsResult } from './CallResolution.js'
import {
  analyzeArgumentNodes,
  analyzeArguments,
  analyzeCallContract,
  analyzeCallTypeArguments,
  appliedOwnerTypeArgumentNodes,
  analyzeFunctionItem,
  boundOperationReference,
  builtinSignature,
  instantiateBuiltinSignature,
  callArityDiagnostic,
  captureAccess,
  copyAssumptionsOf,
  executableSite,
  executableSpecializationOwner,
  finishCallableApplication,
  finishCallableSection,
  genericArgumentOfTypeArgument,
  hasAvailableCallSyntax,
  interfaceConstraints,
  interfaceEvidence,
  interfaceOperationContract,
  instantiateInterfaceReference,
  instantiateSourceParameters,
  isSectionArity,
  ownedProviderCaptureAccess,
  serviceOperation,
  sourceCallable,
} from './CallResolution.js'
export function analyzePlaceReplace(
  context: SemanticContext.SemanticContext,
  call: AuthoredHir.Expression,
  declarations: ReadonlyArray<DeclarationFact>,
  declaration: DeclarationFact,
  scope: Scope,
  resolution: ResolutionContext,
): ExpressionResult {
  const nodes = call._tag === 'CallExpression' ? call.arguments : []
  const destinationNode = nodes.at(0)
  const valueNode = nodes.at(1)
  const diagnostics: Array<Diagnostic.Located> = []
  if (destinationNode === undefined || valueNode === undefined || nodes.length !== 2) {
    const unavailable = expressionNode(
      unavailableExpressionResult(context, call.anchor, declaration, resolution),
    )
    return {
      fact: {
        _tag: 'PlaceReplace' as const,
        reference: intrinsicReference(context, call),
        destination: unavailable,
        value: unavailable,
        compatible: false,
        type: unavailableExpressionType,
        anchor: call.anchor,
      },
      diagnostics: [
        Diagnostic.wrongCallArity(
          { _tag: 'BuiltinTarget', actor: 'Place', operation: 'replace' },
          2,
          nodes.length,
          Location.at(call.anchor),
        ),
      ],
      type: undefined,
    }
  }
  const destination = analyzeExpression(
    context,
    destinationNode,
    declarations,
    declaration,
    scope,
    resolution,
  )
  if (destination === undefined) {
    throw new RangeError(`Semantic analysis cannot analyze ${destinationNode._tag}`)
  }
  diagnostics.push(...destination.diagnostics)
  const value = analyzeExpression(
    context,
    valueNode,
    declarations,
    declaration,
    scope,
    resolution,
    destination.type,
  )
  if (value === undefined) {
    throw new RangeError(`Semantic analysis cannot analyze ${valueNode._tag}`)
  }
  diagnostics.push(...value.diagnostics)
  const root = assignmentRoot(destination.fact)
  if (destination.fact._tag === 'ForeignStatic') {
    diagnostics.push(
      Diagnostic.immutableAssignment(
        destination.fact.declaration.name._tag === 'Present'
          ? destination.fact.declaration.name.spelling
          : '?',
        Location.at(destinationNode.anchor),
      ),
    )
  } else if (root === undefined) {
    if (AuthoredWalk.isAvailable(destinationNode) && destination.diagnostics.length === 0) {
      diagnostics.push(Diagnostic.invalidAssignmentPlace(Location.at(destinationNode.anchor)))
    }
  } else if (assignmentRootAccess(root, destination.fact) === 'ImmutableOwned') {
    diagnostics.push(
      Diagnostic.immutableAssignment(
        root.name._tag === 'Present' ? root.name.spelling : '?',
        Location.at(destinationNode.anchor),
      ),
    )
  } else if (
    assignmentRootAccess(root, destination.fact) === 'SharedBorrowed' ||
    (assignmentRootAccess(root, destination.fact) === 'ExclusiveBorrowed' &&
      destination.fact._tag !== 'IndexProjection' &&
      destination.fact._tag !== 'ReferentProjection' &&
      destination.fact._tag !== 'FieldProjection')
  ) {
    diagnostics.push(Diagnostic.invalidAssignmentPlace(Location.at(destinationNode.anchor)))
  }
  const compatible =
    destination.type !== undefined &&
    value.type !== undefined &&
    typesCompatible(value.type, destination.type, resolution?.lifetimeCompatibility)
  if (destination.type !== undefined && value.type !== undefined && !compatible) {
    const expectedOrigin =
      root?._tag === 'BindingFact'
        ? Location.at(constructionExpressionAnchor(root.initializer))
        : Location.at(destinationNode.anchor)
    diagnostics.push(
      representationJoinDiagnostic(
        destination.type,
        value.type,
        expectedOrigin,
        Location.at(valueNode.anchor),
        Location.at(valueNode.anchor),
      ) ??
        unionConversionDiagnostic(
          value.type,
          destination.type,
          Location.at(valueNode.anchor),
          resolution?.lifetimeCompatibility,
        ) ??
        Diagnostic.assignmentTypeMismatch(
          Type.display(destination.type),
          Type.display(value.type),
          Location.at(valueNode.anchor),
        ),
    )
  }
  if (
    root?._tag === 'BindingFact' &&
    root.inferredType._tag === 'Available' &&
    Type.isCallable(root.inferredType.type)
  ) {
    resolution.writtenCallableBindings?.add(root.id.ordinal)
  }
  return {
    fact: {
      _tag: 'PlaceReplace' as const,
      reference: intrinsicReference(context, call),
      destination: expressionNode(destination),
      ...(root === undefined ? {} : { root }),
      value: expressionNode(value),
      compatible,
      type:
        destination.type === undefined
          ? unavailableExpressionType
          : { _tag: 'Available' as const, type: destination.type },
      anchor: call.anchor,
    },
    diagnostics: diagnostics,
    type: destination.type,
  }
}

const isProviderReferenceFact = (value: unknown): value is BindingDeclarationFact | ParameterFact =>
  typeof value === 'object' &&
  value !== null &&
  '_tag' in value &&
  (value._tag === 'BindingFact' || value._tag === 'ParameterDeclaration')

const isCaptureReferenceFact = (value: unknown): value is EffectCaptureFact['reference'] =>
  isProviderReferenceFact(value) ||
  (typeof value === 'object' &&
    value !== null &&
    '_tag' in value &&
    value._tag === 'PatternBinding')

export const directProviderReference = (
  expression: ExpressionDecision | Tir.Expression,
  builder?: BodyBuilder.BodyBuilder,
): BindingDeclarationFact | ParameterFact | undefined => {
  if ('origin' in expression) {
    if (expression._tag === 'Move') return directProviderReference(expression.subject, builder)
    if (expression._tag === 'ValueBorrow' || expression._tag === 'SliceBorrow')
      return expression.place === undefined
        ? undefined
        : directProviderReference(expression.place, builder)
    if (expression._tag !== 'BindingReference' && expression._tag !== 'ParameterReference')
      return undefined
    const semantic =
      builder === undefined
        ? undefined
        : BodyBuilder.semanticOfLocal(
            builder,
            expression._tag === 'BindingReference' ? expression.binding : expression.parameter,
          )
    return isProviderReferenceFact(semantic) ? semantic : undefined
  }
  if (expression._tag === 'Identifier') {
    if (expression.reference._tag === 'ResolvedBinding') return expression.reference.binding
    if (expression.reference._tag === 'Resolved') return expression.reference.parameter
    return undefined
  }
  if (expression._tag === 'Borrow' || expression._tag === 'Move')
    return directProviderReference(expression.subject, builder)
  return undefined
}

export const selectedRequirementShape = (
  row: Type.RequirementsRow,
): { readonly capability: Type.Nominal | Type.Parameter; readonly role: string } | undefined => {
  const concrete = RowAlgebra.concretize(Type.requirementRowPolicy(), row)
  if (concrete._tag === 'Concrete') {
    const selected = concrete.row.members.at(0)
    return concrete.row.members.length === 1 && selected !== undefined
      ? { capability: selected.capability, role: selected.role }
      : undefined
  }
  return row.expression._tag === 'Singleton'
    ? {
        capability: row.expression.member.capability,
        role: row.expression.member.role,
      }
    : undefined
}

export const intrinsicContractReference = (
  operation: Intrinsic.Operation,
  operationToken: AuthoredHir.Name,
): Extract<CallReferenceFact, { readonly _tag: 'ResolvedIntrinsicContract' }> => {
  if (
    operation.rule._tag !== 'ContractRule' &&
    operation.rule._tag !== 'StaticOnlyRule' &&
    operation.rule._tag !== 'MixedFieldProjectionRule' &&
    operation.rule._tag !== 'MixedTestFunctionRule'
  )
    throw new RangeError('intrinsic contract reference requires a contract operation')
  const declared = operation.rule.contract
  const lifetimeBinders = [
    ...new Map(
      [
        ...declared.lifetimeBinders,
        ...[...declared.parameters.map((parameter) => parameter.type), declared.result]
          .flatMap(Type.freeLifetimes)
          .filter((lifetime): lifetime is Lifetime.Bound => lifetime._tag === 'BoundLifetime'),
      ].map((lifetime) => [Lifetime.key(lifetime), lifetime]),
    ).values(),
  ]
  const contract = CallableContract.make({
    ...declared,
    environment: Lifetime.staticLifetime,
    lifetimeBinders,
    unsafe: operation.unsafe,
  })
  return {
    _tag: 'ResolvedIntrinsicContract',
    spelling: `Intrinsic.${operation.spelling}`,
    anchor: operationToken.anchor,
    intrinsic: operation,
    contract,
  }
}

export const effectBindingProvider = (
  operation: Intrinsic.Operation,
  substitution: Type.Substitution,
  evidence: ReadonlyArray<Constraint.ConstraintEvidence>,
  provider: ExpressionDecision | Tir.Expression,
  span: SourceSpan.SourceSpan,
  at: AuthoredHir.Anchor,
  index?: DeclarationIndex.Index,
  builder?: BodyBuilder.BodyBuilder,
): EffectRequirementBindingFact | undefined => {
  if (
    operation.rule._tag !== 'ContractRule' ||
    operation.rule.post !== 'BindRequirement' ||
    operation.rule.providerMode === undefined
  )
    return undefined
  const wanted = operation.rule.contract.constraints
    .map((constraint) => Constraint.substitute(constraint, substitution))
    .find(
      (constraint): constraint is Constraint.ProviderSelection =>
        constraint._tag === 'ProviderSelectionConstraint',
    )
  if (wanted === undefined) return undefined
  const providerReference = directProviderReference(provider, builder)
  if (
    providerReference === undefined ||
    !(Type.isNominal(wanted.provider) || Type.isParameter(wanted.provider))
  )
    return undefined
  const wantedKey = Constraint.key(wanted)
  const proof = evidence.find(
    (candidate) =>
      (candidate._tag === 'Assumed' || candidate._tag === 'RequirementSelection') &&
      candidate.wantedKey === wantedKey,
  )
  if (proof === undefined) return undefined
  const selected = selectedRequirementShape(wanted.selected)
  const movedType =
    provider._tag === 'Move' ? constructionExpressionType(provider.subject) : undefined
  return {
    _tag: 'EffectRequirementBinding',
    reference: providerReference,
    selected: wanted.selected,
    evidence,
    ...(selected === undefined ? {} : { capability: selected.capability }),
    providerType: wanted.provider,
    ...(selected === undefined ? {} : { role: selected.role }),
    selectionAccess: operation.rule.providerMode,
    captureAccess:
      provider._tag === 'Move' &&
      movedType?._tag === 'Available' &&
      index !== undefined &&
      ConformanceProof.copyType(index, movedType.type)
        ? 'Copy'
        : captureAccess(provider, index),
    span,
    at,
  }
}

export const sectionIntrinsicReference = (
  section: CallableSectionExpressionDecision,
): IntrinsicReferenceFact => {
  if (section.reference._tag !== 'ResolvedIntrinsicContract')
    return { _tag: 'UnavailableIntrinsicReference', anchor: section.anchor }
  const actor = Intrinsic.findActor('Intrinsic')
  const actorAnchor =
    section.path._tag === 'ReferencePath' ? section.path.qualifierAnchor : undefined
  if (actor === undefined || actorAnchor === undefined)
    return { _tag: 'UnavailableIntrinsicReference', anchor: section.anchor }
  return {
    _tag: 'ResolvedIntrinsicReference',
    actor,
    operation: section.reference.intrinsic,
    actorAnchor,
    operationAnchor: section.reference.anchor,
  }
}

const isDeferredStaticExpression = (
  expression: ExpressionDecision | Tir.Expression,
  builder?: BodyBuilder.BodyBuilder,
): boolean => {
  if ('origin' in expression) {
    if (expression._tag === 'Move') return isDeferredStaticExpression(expression.subject, builder)
    if (expression._tag === 'BindingReference' || expression._tag === 'ParameterReference') {
      const semantic =
        builder === undefined
          ? undefined
          : BodyBuilder.semanticOfLocal(
              builder,
              expression._tag === 'BindingReference' ? expression.binding : expression.parameter,
            )
      return isProviderReferenceFact(semantic) && semantic.phase === 'Static'
    }
    return (
      expression._tag === 'ConstantReference' ||
      expression._tag === 'StaticCall' ||
      expression._tag === 'StaticIntrinsic'
    )
  }
  if (expression._tag === 'Move') return isDeferredStaticExpression(expression.subject, builder)
  if (expression._tag === 'Constant') return true
  if (expression._tag === 'Identifier') {
    if (expression.reference._tag === 'Resolved')
      return expression.reference.parameter.phase === 'Static'
    if (expression.reference._tag === 'ResolvedBinding')
      return expression.reference.binding.phase === 'Static'
    return false
  }
  if (expression._tag !== 'Call') return false
  if (expression.staticValue !== undefined) return true
  if (expression.reference._tag === 'Resolved')
    return expression.reference.declaration.phase === 'Static'
  return (
    expression.reference._tag === 'ResolvedIntrinsicContract' &&
    expression.reference.intrinsic.phase === 'StaticOnly'
  )
}

const reflectedFieldName = (descriptor: StaticValue.FieldDescriptorValue): string =>
  descriptor.member._tag === 'LabeledField'
    ? descriptor.member.label
    : `${descriptor.member.ordinal}`

const sameReflectedMember = (
  descriptor: StaticValue.FieldDescriptorValue,
  field: DeclarationFacts.FieldFact,
): boolean =>
  descriptor.member._tag === 'LabeledField'
    ? field.member._tag === 'LabeledAggregateMember' &&
      field.member.label === descriptor.member.label
    : field.member._tag === 'OrdinalAggregateMember' &&
      field.member.ordinal === descriptor.member.ordinal

const appendFieldBorrowRoot = (
  root: BorrowRootFact,
  field: DeclarationFacts.FieldFact,
  span: SourceSpan.SourceSpan,
): BorrowRootFact => ({
  ...root,
  path: [...root.path, { _tag: 'Field' as const, field: field.id, span }],
})

const mixedFieldProjection = (
  context: SemanticContext.SemanticContext,
  call: AuthoredHir.Expression,
  operation: Intrinsic.Operation,
  reference: Extract<CallReferenceFact, { readonly _tag: 'ResolvedIntrinsicContract' }>,
  argumentsResult: ArgumentsResult,
  typeArguments: CallTypeArgumentsResult,
  analyzed: ReturnType<typeof analyzeCallContract>,
  resolution: ResolutionContext,
  caller: DeclarationFact,
): ExpressionResult => {
  if (operation.rule._tag !== 'MixedFieldProjectionRule')
    throw new RangeError('mixed field projection requires its sealed intrinsic rule')
  const commonDiagnostics = [
    ...argumentsResult.diagnostics,
    ...typeArguments.diagnostics,
    ...analyzed.diagnostics,
  ]
  const substitution =
    analyzed.fact._tag === 'Compatible'
      ? analyzed.fact.substitution
      : new Map<string, Type.GenericArgument>()
  const result = Type.substitute(operation.rule.contract.result, substitution)
  const ownerArgument = argumentsResult.facts.at(operation.rule.runtimeOwnerParameter)
  const descriptorArgument = argumentsResult.facts.at(operation.rule.staticDescriptorParameter)
  const ownerType = ownerArgument?.type._tag === 'Available' ? ownerArgument.type.type : undefined
  const ownerParameter = operation.rule.contract.parameters.at(operation.rule.runtimeOwnerParameter)
  const requiredOwnerType =
    ownerParameter === undefined ? undefined : Type.substitute(ownerParameter.type, substitution)
  const sharedOwnerAvailable =
    ownerType !== undefined && Type.isReference(ownerType) && ownerType.access === 'Shared'
  const baseAvailable =
    analyzed.fact._tag === 'Compatible' &&
    ownerArgument !== undefined &&
    descriptorArgument !== undefined &&
    sharedOwnerAvailable &&
    Type.isReference(result) &&
    result.access === 'Shared'
  const callFact = (type: ExpressionTypeFact): ExpressionDecision => ({
    _tag: 'Call',
    reference,
    path: referencePath(context, call),
    typeArguments: typeArguments.facts,
    arguments: argumentsResult.facts,
    mappings: analyzed.mappings,
    contract: analyzed.fact,
    type,
    anchor: call.anchor,
  })
  if (caller.phase === 'Static') {
    const diagnostic = Diagnostic.staticPhaseViolation(
      'Intrinsic.borrowField',
      resolution.staticContext?.environment.target ?? 'unselected-target',
      [],
      Location.at(call.anchor),
    )
    return {
      fact: callFact(unavailableExpressionType),
      diagnostics: [...commonDiagnostics, diagnostic],
      type: undefined,
    }
  }
  if (
    analyzed.fact._tag === 'Compatible' &&
    ownerArgument !== undefined &&
    descriptorArgument !== undefined &&
    !sharedOwnerAvailable
  ) {
    const diagnostic = Diagnostic.argumentTypeMismatch(
      requiredOwnerType === undefined ? '&Owner' : Type.display(requiredOwnerType),
      ownerType === undefined ? '<unavailable>' : Type.display(ownerType),
      Location.at(ownerArgument.anchor),
    )
    return {
      fact: callFact(unavailableExpressionType),
      diagnostics: [...commonDiagnostics, diagnostic],
      type: undefined,
    }
  }
  if (!baseAvailable || ownerArgument === undefined || descriptorArgument === undefined) {
    return {
      fact: callFact(unavailableExpressionType),
      diagnostics: commonDiagnostics,
      type: undefined,
    }
  }
  if (resolution.staticContext === undefined) {
    const deferred = isDeferredStaticExpression(descriptorArgument.expression, resolution.builder)
    const diagnostic = deferred
      ? undefined
      : Diagnostic.staticPhaseViolation(
          'Intrinsic.borrowField descriptor',
          'unselected-target',
          [],
          Location.at(descriptorArgument.anchor),
        )
    const type =
      diagnostic === undefined ? availableExpressionType(result) : unavailableExpressionType
    return {
      fact: callFact(type),
      diagnostics: [...commonDiagnostics, ...(diagnostic === undefined ? [] : [diagnostic])],
      type: type._tag === 'Available' ? type.type : undefined,
    }
  }
  const evaluated = evaluateStatic(
    descriptorArgument.expression,
    resolution.staticContext,
    resolution,
  )
  if (evaluated._tag === 'Failed' || evaluated.value._tag !== 'FieldDescriptorValue') {
    const diagnostic =
      evaluated._tag === 'Failed'
        ? Evaluation.diagnostic(evaluated.failure, resolution.staticContext.environment.target)
        : Diagnostic.staticPhaseViolation(
            'Intrinsic.borrowField descriptor',
            resolution.staticContext.environment.target,
            [],
            Location.at(descriptorArgument.anchor),
          )
    return {
      fact: callFact(unavailableExpressionType),
      diagnostics: [...commonDiagnostics, diagnostic],
      type: undefined,
    }
  }
  const descriptor = evaluated.value
  const ownerBinder = operation.rule.contract.binders.at(0)
  const valueBinder = operation.rule.contract.binders.at(1)
  const expectedOwner =
    ownerBinder === undefined ? undefined : substitution.get(Type.key(ownerBinder))
  const expectedValue =
    valueBinder === undefined ? undefined : substitution.get(Type.key(valueBinder))
  if (
    expectedOwner === undefined ||
    !Type.isTypeArgument(expectedOwner) ||
    expectedValue === undefined ||
    !Type.isTypeArgument(expectedValue) ||
    !Type.equals(expectedOwner, descriptor.owner.owner) ||
    !Type.equals(expectedValue, descriptor.valueType)
  ) {
    const diagnostic = Diagnostic.argumentTypeMismatch(
      expectedOwner !== undefined &&
        Type.isTypeArgument(expectedOwner) &&
        expectedValue !== undefined &&
        Type.isTypeArgument(expectedValue)
        ? Type.display(Type.fieldDescriptor(expectedOwner, expectedValue))
        : 'Field<Owner, Value>',
      Type.display(StaticValue.fieldDescriptorType(descriptor)),
      Location.at(descriptorArgument.anchor),
    )
    return {
      fact: callFact(unavailableExpressionType),
      diagnostics: [...commonDiagnostics, diagnostic],
      type: undefined,
    }
  }
  const owner = descriptor.owner.owner
  const aggregate = Type.isNominal(owner) ? aggregateByNominal(resolution, owner) : undefined
  const field = aggregate?.fields.find(
    (candidate) => candidate.id.ordinal === descriptor.declarationOrdinal,
  )
  const name = reflectedFieldName(descriptor)
  if (
    aggregate === undefined ||
    field === undefined ||
    aggregate.aggregateKind !== descriptor.owner.kind ||
    !sameReflectedMember(descriptor, field) ||
    field.declaredType._tag !== 'Resolved'
  ) {
    const diagnostic = Diagnostic.unknownProjectedField(
      Type.display(owner),
      name,
      Location.at(descriptorArgument.anchor),
    )
    return {
      fact: callFact(unavailableExpressionType),
      diagnostics: [...commonDiagnostics, diagnostic],
      type: undefined,
    }
  }
  const aggregateSubstitution =
    TypeInference.substitution(
      aggregate.typeParameters.map((parameter) => parameter.type),
      owner.arguments,
    ) ?? new Map<string, Type.GenericArgument>()
  const declaredValue = Type.substitute(field.declaredType.type, aggregateSubstitution)
  const authorization = DeclarationFacts.byCanonical(resolution.index, descriptor.authorization)
  const aggregateIdentity =
    aggregate.canonical._tag === 'Canonical' ? aggregate.canonical.id : undefined
  const authorized =
    authorization?.canonical._tag === 'Canonical' &&
    aggregateIdentity !== undefined &&
    (field.visibility !== 'Private' || descriptor.authorization.module === aggregateIdentity.module)
  if (!authorized) {
    const diagnostic = Diagnostic.inaccessibleProjectedField(
      Type.display(owner),
      name,
      Location.at(descriptorArgument.anchor),
    )
    return {
      fact: callFact(unavailableExpressionType),
      diagnostics: [...commonDiagnostics, diagnostic],
      type: undefined,
    }
  }
  if (!Type.equals(declaredValue, descriptor.valueType)) {
    const diagnostic = Diagnostic.argumentTypeMismatch(
      Type.display(Type.fieldDescriptor(owner, declaredValue)),
      Type.display(StaticValue.fieldDescriptorType(descriptor)),
      Location.at(descriptorArgument.anchor),
    )
    return {
      fact: callFact(unavailableExpressionType),
      diagnostics: [...commonDiagnostics, diagnostic],
      type: undefined,
    }
  }
  const projection: FieldProjectionExpressionDecision = {
    _tag: 'FieldProjection',
    subject: ownerArgument.expression,
    ...(ownerArgument.borrowRoot === undefined
      ? {}
      : {
          borrowRoot: appendFieldBorrowRoot(
            ownerArgument.borrowRoot,
            field,
            context.spanOf(call.anchor),
          ),
        }),
    nominal: owner,
    borrowAccess: 'Shared',
    fieldName: name,
    state: { _tag: 'Resolved', field },
    type: availableExpressionType(descriptor.valueType),
    anchor: call.anchor,
  }
  const root = projection.borrowRoot
  if (root === undefined) {
    const diagnostic = Diagnostic.invalidBorrowOperand(Location.at(ownerArgument.anchor))
    return {
      fact: callFact(unavailableExpressionType),
      diagnostics: [...commonDiagnostics, diagnostic],
      type: undefined,
    }
  }
  const lifetime =
    resolution.bodyLifetimes === undefined
      ? undefined
      : BodyLifetime.region(resolution.bodyLifetimes, call.anchor, 'Borrow')
  if (lifetime === undefined)
    return {
      fact: callFact(unavailableExpressionType),
      diagnostics: commonDiagnostics,
      type: undefined,
    }
  if (
    ownerArgument.type._tag === 'Available' &&
    Type.isReference(ownerArgument.type.type) &&
    resolution.bodyLifetimes !== undefined
  )
    BodyLifetime.constrain(resolution.bodyLifetimes, ownerArgument.type.type.lifetime, lifetime)
  const type = Type.reference('Shared', descriptor.valueType, lifetime)
  const projectionNode = BodyBuilder.tirExpression(projection, {
    context,
    ...(resolution.builder === undefined ? {} : { builder: resolution.builder }),
    ...(resolution.lifetimeCompatibility === undefined
      ? {}
      : { lifetimeCompatibility: resolution.lifetimeCompatibility }),
    functionId: caller.id,
  })
  return {
    fact: {
      _tag: 'Borrow',
      access: 'Shared',
      subject: projectionNode,
      formation: {
        _tag: 'ValueBorrow',
        root,
        source: descriptor.valueType,
      },
      type: availableExpressionType(type),
      anchor: call.anchor,
    },
    diagnostics: commonDiagnostics,
    type,
  }
}

const mixedTestFunction = (
  context: SemanticContext.SemanticContext,
  call: AuthoredHir.Expression,
  operation: Intrinsic.Operation,
  reference: Extract<CallReferenceFact, { readonly _tag: 'ResolvedIntrinsicContract' }>,
  argumentsResult: ArgumentsResult,
  typeArguments: CallTypeArgumentsResult,
  analyzed: ReturnType<typeof analyzeCallContract>,
  resolution: ResolutionContext,
): ExpressionResult => {
  if (operation.rule._tag !== 'MixedTestFunctionRule')
    throw new RangeError('test callable projection requires its sealed intrinsic rule')
  const commonDiagnostics = [
    ...argumentsResult.diagnostics,
    ...typeArguments.diagnostics,
    ...analyzed.diagnostics,
  ]
  const descriptorArgument = argumentsResult.facts.at(operation.rule.staticDescriptorParameter)
  const unavailableFact = (): ExpressionDecision => ({
    _tag: 'Call',
    reference,
    path: referencePath(context, call),
    typeArguments: typeArguments.facts,
    arguments: argumentsResult.facts,
    mappings: analyzed.mappings,
    contract: analyzed.fact,
    type: unavailableExpressionType,
    anchor: call.anchor,
  })
  if (descriptorArgument === undefined || analyzed.fact._tag !== 'Compatible')
    return {
      fact: unavailableFact(),
      diagnostics: commonDiagnostics,
      type: undefined,
    }
  if (resolution.staticContext === undefined) {
    const deferred = isDeferredStaticExpression(descriptorArgument.expression, resolution.builder)
    const diagnostic = deferred
      ? undefined
      : Diagnostic.staticPhaseViolation(
          'Intrinsic.testFunction descriptor',
          'unselected-target',
          [],
          Location.at(descriptorArgument.anchor),
        )
    return {
      fact: unavailableFact(),
      diagnostics: [...commonDiagnostics, ...(diagnostic === undefined ? [] : [diagnostic])],
      type: undefined,
    }
  }
  const evaluated = evaluateStatic(
    descriptorArgument.expression,
    resolution.staticContext,
    resolution,
  )
  const descriptor =
    evaluated._tag === 'Complete' && evaluated.value._tag === 'TestDescriptorValue'
      ? evaluated.value
      : undefined
  const target =
    descriptor === undefined
      ? undefined
      : DeclarationFacts.byCanonical(resolution.index, descriptor.declaration)
  const catalog = resolution.staticContext.testCatalog
  const issued =
    descriptor !== undefined &&
    catalog?.identity === descriptor.authorization &&
    catalog.entries.some(
      (entry) => entry.declaration === target && Type.equals(entry.callable, descriptor.callable),
    )
  if (
    descriptor === undefined ||
    target?._tag !== 'FunctionDeclaration' ||
    !target.test ||
    !issued
  ) {
    const diagnostic =
      evaluated._tag === 'Failed'
        ? Evaluation.diagnostic(evaluated.failure, resolution.staticContext.environment.target)
        : Diagnostic.staticPhaseViolation(
            'Intrinsic.testFunction descriptor',
            resolution.staticContext.environment.target,
            [],
            Location.at(descriptorArgument.anchor),
          )
    return {
      fact: unavailableFact(),
      diagnostics: [...commonDiagnostics, diagnostic],
      type: undefined,
    }
  }
  const fact: ExpressionDecision = {
    _tag: 'FunctionItem',
    reference: {
      _tag: 'Resolved',
      spelling: `${descriptor.declaration.module}.${descriptor.declaration.name}`,
      anchor: call.anchor,
      declaration: target,
    },
    path: referencePath(context, call),
    typeArguments: [],
    type: availableExpressionType(descriptor.callable),
    anchor: call.anchor,
  }
  return {
    fact,
    diagnostics: commonDiagnostics,
    type: descriptor.callable,
  }
}

export const finishIntrinsicContractCall = (
  context: SemanticContext.SemanticContext,
  call: AuthoredHir.Expression,
  operation: Intrinsic.Operation,
  operationToken: AuthoredHir.Name,
  argumentsResult: ArgumentsResult,
  typeArguments: CallTypeArgumentsResult,
  resolution: ResolutionContext,
  caller: DeclarationFact,
): ExpressionResult => {
  if (
    operation.rule._tag !== 'ContractRule' &&
    operation.rule._tag !== 'StaticOnlyRule' &&
    operation.rule._tag !== 'MixedFieldProjectionRule' &&
    operation.rule._tag !== 'MixedTestFunctionRule'
  )
    throw new RangeError('intrinsic contract finisher received a non-contract operation')
  const reference = intrinsicContractReference(operation, operationToken)
  const analyzed = analyzeCallContract(
    context,
    call,
    reference,
    argumentsResult.facts,
    hasAvailableCallSyntax(call),
    typeArguments,
    resolution,
    caller,
  )
  const unsafeDiagnostic = unsafeCallDiagnostic(
    operation.unsafe,
    reference.spelling,
    call,
    context.spanOf(call.anchor),
    resolution,
  )
  const substitution =
    analyzed.fact._tag === 'Compatible'
      ? analyzed.fact.substitution
      : new Map<string, Type.GenericArgument>()
  if (operation.rule._tag === 'MixedFieldProjectionRule')
    return mixedFieldProjection(
      context,
      call,
      operation,
      reference,
      argumentsResult,
      typeArguments,
      analyzed,
      resolution,
      caller,
    )
  if (operation.rule._tag === 'MixedTestFunctionRule')
    return mixedTestFunction(
      context,
      call,
      operation,
      reference,
      argumentsResult,
      typeArguments,
      analyzed,
      resolution,
    )
  if (operation.rule._tag === 'StaticOnlyRule') {
    if (operation.spelling === 'testInfo')
      resolution.generatedAggregates?.set(
        aggregateKey(Type.testInfo),
        intrinsicStruct(Type.testInfo, call, call.anchor),
      )
    // The phase-only catalog value may seed a deferred `static for` before target selection. The
    // statement analyzer preserves that loop without lowering the value; its expanded analysis
    // evaluates this call again with the sealed discovery catalog.
    const phaseDiagnostic =
      caller.phase === 'Static' ||
      resolution.staticContext !== undefined ||
      (operation.spelling === 'tests' && Type.isStaticPhaseOnly(operation.rule.contract.result))
        ? undefined
        : Diagnostic.staticPhaseViolation(
            `Intrinsic.${operation.spelling}`,
            'unselected-target',
            [],
            Location.at(call.anchor),
          )
    const result = Type.substitute(operation.rule.contract.result, substitution)
    const type =
      analyzed.fact._tag === 'Compatible' && phaseDiagnostic === undefined
        ? availableExpressionType(result)
        : unavailableExpressionType
    const fact: Extract<ExpressionDecision, { readonly _tag: 'Call' }> = {
      _tag: 'Call',
      reference,
      path: referencePath(context, call),
      typeArguments: typeArguments.facts,
      arguments: argumentsResult.facts,
      mappings: analyzed.mappings,
      contract: analyzed.fact,
      type,
      anchor: call.anchor,
    }
    const staticResult =
      (operation.spelling === 'tests' || operation.spelling === 'testInfo') &&
      resolution.staticContext !== undefined &&
      resolution.deferStaticCalls !== true &&
      type._tag === 'Available'
        ? evaluateStatic(fact, resolution.staticContext, resolution)
        : undefined
    const staticDiagnostics =
      staticResult?._tag === 'Failed' && resolution.staticContext !== undefined
        ? [Evaluation.diagnostic(staticResult.failure, resolution.staticContext.environment.target)]
        : []
    let resolvedFact: ExpressionDecision = fact
    if (staticResult?._tag === 'Complete')
      resolvedFact = { ...fact, staticValue: staticResult.value }
    else if (staticResult?._tag === 'Failed')
      resolvedFact = { ...fact, staticFailure: staticResult.failure }
    return {
      fact: resolvedFact,
      diagnostics: [
        ...argumentsResult.diagnostics,
        ...typeArguments.diagnostics,
        ...analyzed.diagnostics,
        ...(phaseDiagnostic === undefined ? [] : [phaseDiagnostic]),
        ...staticDiagnostics,
      ],
      type: type._tag === 'Available' ? type.type : undefined,
    }
  }
  const substitutedResult = Type.substitute(operation.rule.contract.result, substitution)
  const type =
    analyzed.fact._tag === 'Compatible' &&
    unsafeDiagnostic === undefined &&
    Type.isEffect(substitutedResult)
      ? availableExpressionType(
          Type.effectWithRows(
            substitutedResult.success,
            substitutedResult.failureRow,
            substitutedResult,
            intrinsicEffectCaptureAccess(
              operation,
              argumentsResult.facts,
              resolution.index,
              copyAssumptionsOf(caller),
            ),
            substitutedResult.requirementRow,
          ),
        )
      : unavailableExpressionType
  const protected_ = argumentsResult.facts.at(0)
  const unavailable = expressionNode(
    unavailableExpressionResult(context, call.anchor, caller, resolution),
  )
  const evidence = analyzed.fact._tag === 'Compatible' ? analyzed.fact.evidence : []
  if (operation.rule.post === 'CatchFailure') {
    const handler = argumentsResult.facts.at(1)
    const wanted = operation.rule.contract.constraints
      .map((constraint) => Constraint.substitute(constraint, substitution))
      .find(
        (constraint): constraint is Constraint.FailureSubset =>
          constraint._tag === 'FailureSubsetConstraint',
      )
    const wantedKey = wanted === undefined ? undefined : Constraint.key(wanted)
    const proved =
      wantedKey !== undefined &&
      evidence.some(
        (candidate) =>
          (candidate._tag === 'Assumed' && candidate.wantedKey === wantedKey) ||
          (candidate._tag === 'FailureSubset' &&
            wanted !== undefined &&
            RowAlgebra.equals(Type.failureRowPolicy(), candidate.selected, wanted.selected) &&
            RowAlgebra.equals(Type.failureRowPolicy(), candidate.source, wanted.source)),
      )
    const handlerType = handler?.type._tag === 'Available' ? handler.type.type : undefined
    const handlerEffect =
      handlerType !== undefined && Type.isCallable(handlerType) && Type.isEffect(handlerType.result)
        ? handlerType.result
        : undefined
    const catchAvailable =
      type._tag === 'Available' &&
      protected_ !== undefined &&
      handler !== undefined &&
      wanted !== undefined &&
      proved
    return {
      fact: {
        _tag: 'EffectCatch',
        reference: intrinsicReference(context, call),
        protected: protected_?.expression ?? unavailable,
        handler: handler?.expression ?? unavailable,
        ...(wanted === undefined ? {} : { selected: Type.failureType(wanted.selected) }),
        protectedRow: wanted?.source ?? RowAlgebra.concrete(Type.failureRowPolicy(), []),
        handlerRow: handlerEffect?.failureRow ?? RowAlgebra.concrete(Type.failureRowPolicy(), []),
        residualRow:
          wanted === undefined
            ? RowAlgebra.concrete(Type.failureRowPolicy(), [])
            : RowAlgebra.without(Type.failureRowPolicy(), wanted.source, wanted.selected),
        evidence,
        type: catchAvailable ? type : unavailableExpressionType,
        anchor: call.anchor,
      },
      diagnostics: [
        ...argumentsResult.diagnostics,
        ...typeArguments.diagnostics,
        ...analyzed.diagnostics,
        ...(unsafeDiagnostic === undefined ? [] : [unsafeDiagnostic]),
      ],
      type: catchAvailable && type._tag === 'Available' ? type.type : undefined,
    }
  }
  const provider = argumentsResult.facts.at(1)
  const binding =
    provider === undefined
      ? undefined
      : effectBindingProvider(
          operation,
          substitution,
          evidence,
          provider.expression,
          context.spanOf(provider.anchor),
          provider.anchor,
          resolution.index,
          resolution.builder,
        )
  const bindingAvailable =
    type._tag === 'Available' && protected_ !== undefined && binding !== undefined
  return {
    fact: {
      _tag: 'EffectBindRequirement',
      reference: intrinsicReference(context, call),
      protected: protected_?.expression ?? unavailable,
      ...(bindingAvailable
        ? {
            provider: binding,
          }
        : {}),
      type,
      anchor: call.anchor,
    },
    diagnostics: [
      ...argumentsResult.diagnostics,
      ...typeArguments.diagnostics,
      ...analyzed.diagnostics,
      ...(unsafeDiagnostic === undefined ? [] : [unsafeDiagnostic]),
    ],
    type: type._tag === 'Available' ? type.type : undefined,
  }
}

export function analyzeBuiltinCall(
  context: SemanticContext.SemanticContext,
  call: AuthoredHir.Expression,
  argumentsResult: ArgumentsResult,
  typeArguments: CallTypeArgumentsResult,
  resolution: ResolutionContext,
  caller: DeclarationFact,
): ExpressionResult {
  const identifiers = referenceNames(call)
  const actorToken = identifiers.at(0)
  const operationToken = identifiers.at(1)

  if (actorToken === undefined || operationToken === undefined) {
    return {
      fact: {
        _tag: 'Call',
        reference: {
          _tag: 'Unavailable',
          anchor: call.anchor,
        },
        path: referencePath(context, call),
        typeArguments: typeArguments.facts,
        arguments: argumentsResult.facts,
        mappings: [],
        contract: {
          _tag: 'Unavailable',
          reason: { _tag: 'UnavailableCallSyntax', anchor: call.anchor },
        },
        type: unavailableExpressionType,
        anchor: call.anchor,
      },
      diagnostics: [...argumentsResult.diagnostics, ...typeArguments.diagnostics],
      type: undefined,
    }
  }

  const actorSpelling = SemanticContext.nameText(context, actorToken) ?? ''
  const operationSpelling = SemanticContext.nameText(context, operationToken) ?? ''
  const actor = Intrinsic.findActor(actorSpelling)
  const operation = Intrinsic.findOperation(actorSpelling, operationSpelling)
  if (
    (operation?.rule._tag === 'ContractRule' ||
      operation?.rule._tag === 'StaticOnlyRule' ||
      operation?.rule._tag === 'MixedFieldProjectionRule' ||
      operation?.rule._tag === 'MixedTestFunctionRule') &&
    isSectionArity(operation.rule.contract.parameters.length, argumentsResult.facts.length)
  )
    return finishCallableSection(
      context,
      call,
      intrinsicContractReference(operation, operationToken),
      argumentsResult,
      typeArguments,
      resolution,
      caller,
    )
  if (
    operation?.rule._tag === 'ContractRule' ||
    operation?.rule._tag === 'StaticOnlyRule' ||
    operation?.rule._tag === 'MixedFieldProjectionRule' ||
    operation?.rule._tag === 'MixedTestFunctionRule'
  )
    return finishIntrinsicContractCall(
      context,
      call,
      operation,
      operationToken,
      argumentsResult,
      typeArguments,
      resolution,
      caller,
    )
  const template = builtinSignature(actorSpelling, operationSpelling)
  const signature =
    template === undefined ? undefined : instantiateBuiltinSignature(template, call, resolution)
  const declaredTypeParameters = signature?.typeParameters ?? []
  const specializationDiagnostic =
    typeArguments.explicit &&
    (typeArguments.types === undefined ||
      typeArguments.types.length !== declaredTypeParameters.length)
      ? Diagnostic.typeArgumentArity(
          `${actorSpelling}.${operationSpelling}`,
          declaredTypeParameters.length,
          typeArguments.types?.length ?? 0,
          Location.at(call.anchor),
        )
      : undefined
  const substitution = new Map<string, Type.GenericArgument>()
  if (
    typeArguments.explicit &&
    typeArguments.types !== undefined &&
    typeArguments.types.length === declaredTypeParameters.length
  ) {
    for (const [ordinal, parameter] of declaredTypeParameters.entries()) {
      const fact = typeArguments.facts.at(ordinal)
      const argument =
        fact === undefined ? undefined : genericArgumentOfTypeArgument(parameter, fact)
      if (argument !== undefined) substitution.set(Type.key(parameter), argument)
    }
  } else if (!typeArguments.explicit && signature !== undefined) {
    for (const [ordinal, parameter] of signature.parameters.entries()) {
      const argument = argumentsResult.facts.at(ordinal)
      if (argument?.type._tag === 'Available')
        TypeInference.infer(parameter, argument.type.type, substitution, {
          accepts: (context, target, invariant) =>
            typesCompatible(
              Type.string(context),
              Type.string(target),
              resolution.lifetimeCompatibility,
            ) &&
            (!invariant ||
              typesCompatible(
                Type.string(target),
                Type.string(context),
                resolution.lifetimeCompatibility,
              )),
        })
    }
  }
  if (signature?.operation === 'NativeAssembly') {
    const parameter = signature.parameters[6]
    const input = argumentsResult.facts[6]?.type
    if (parameter !== undefined && Type.isParameter(parameter) && input?._tag === 'Available')
      substitution.set(Type.key(parameter), input.type)
  }
  const missingInference = declaredTypeParameters.find(
    (parameter) => substitution.get(Type.key(parameter)) === undefined,
  )
  const inferenceDiagnostic =
    specializationDiagnostic === undefined && missingInference !== undefined
      ? Diagnostic.typeArgumentArity(
          `${actorSpelling}.${operationSpelling}`,
          declaredTypeParameters.length,
          0,
          Location.at(call.anchor),
        )
      : undefined
  const instantiatedParameters =
    signature === undefined
      ? []
      : signature.parameters.map((parameter) => Type.substitute(parameter, substitution))
  const instantiatedResult =
    signature === undefined ? undefined : Type.substitute(signature.result, substitution)
  const pointerSourceType = instantiatedParameters.at(0)
  let qualifierDiagnostic: Diagnostic.Located | undefined
  if (
    (signature?.operation === 'PointerIsNull' || signature?.operation === 'PointerAddress') &&
    !(pointerSourceType !== undefined && Type.isPointer(pointerSourceType))
  ) {
    qualifierDiagnostic = Diagnostic.invalidPointerQualifier(
      signature.operation === 'PointerAddress' ? 'address observation' : 'null test',
      'operand must be a data pointer',
      Location.at(call.anchor),
    )
  } else if (
    (signature?.operation === 'PointerRequalify' ||
      signature?.operation === 'PointerReinterpret') &&
    !(
      pointerSourceType !== undefined &&
      Type.isPointer(pointerSourceType) &&
      instantiatedResult !== undefined &&
      Type.isPointer(instantiatedResult) &&
      pointerSourceType.addressSpace === instantiatedResult.addressSpace &&
      (signature.operation === 'PointerReinterpret'
        ? pointerSourceType.mutable === instantiatedResult.mutable &&
          pointerSourceType.nullable === instantiatedResult.nullable &&
          pointerSourceType.extent === instantiatedResult.extent
        : Type.equals(pointerSourceType.pointee, instantiatedResult.pointee))
    )
  ) {
    qualifierDiagnostic = Diagnostic.invalidPointerQualifier(
      'conversion',
      signature.operation === 'PointerReinterpret'
        ? 'reinterpretation preserves pointer mutability, nullability, extent and address space'
        : 'context and result must be pointers to the same invariant pointee in the same address space',
      Location.at(call.anchor),
    )
  }
  const unsafeDiagnostic =
    signature === undefined
      ? undefined
      : unsafeCallDiagnostic(
          signature.unsafe === true,
          `${actorSpelling}.${operationSpelling}`,
          call,
          context.spanOf(call.anchor),
          resolution,
        )
  let missingDiagnostic: Diagnostic.Located | undefined
  if (actor === undefined) {
    missingDiagnostic = Diagnostic.unknownActor(actorSpelling, Location.at(actorToken.anchor))
  } else if (signature === undefined) {
    missingDiagnostic = Diagnostic.unknownActorOperation(
      actorSpelling,
      operationSpelling,
      Location.at(operationToken.anchor),
    )
  } else {
    missingDiagnostic = undefined
  }
  let reference: CallReferenceFact
  if (signature !== undefined) {
    reference = {
      _tag: 'ResolvedBuiltin',
      spelling: `${actorSpelling}.${operationSpelling}`,
      anchor: operationToken.anchor,
      actor: actorSpelling,
      operation: signature.operation,
      intrinsic: signature.id,
      parameters: instantiatedParameters,
      result: instantiatedResult ?? signature.result,
      unsafe: signature.unsafe === true,
    }
  } else {
    reference = {
      _tag: 'Missing',
      spelling: `${actorSpelling}.${operationSpelling}`,
      anchor: (actor === undefined ? actorToken : operationToken).anchor,
      ...(missingDiagnostic === undefined ? {} : { cause: Diagnostic.identity(missingDiagnostic) }),
    }
  }
  if (
    reference._tag === 'ResolvedBuiltin' &&
    declaredTypeParameters.length === 0 &&
    isSectionArity(reference.parameters.length, argumentsResult.facts.length)
  ) {
    return finishCallableSection(
      context,
      call,
      reference,
      argumentsResult,
      typeArguments,
      resolution,
      caller,
    )
  }
  const callContract = analyzeCallContract(
    context,
    call,
    reference,
    argumentsResult.facts,
    hasAvailableCallSyntax(call),
    undefined,
    resolution,
    caller,
  )
  const assembly =
    signature?.operation === 'NativeAssembly' && instantiatedResult !== undefined
      ? NativeAssembly.analyze(context, argumentsResult.facts, instantiatedResult, call.anchor)
      : undefined
  if (reference._tag === 'ResolvedBuiltin' && assembly?.assembly !== undefined)
    reference = { ...reference, assembly: assembly.assembly }
  const assemblyDiagnostics = [...(assembly?.diagnostics ?? [])]
  if (signature?.operation === 'NativeAssembly' && caller.phase === 'Static')
    assemblyDiagnostics.push(
      Diagnostic.staticPhaseViolation('Intrinsic.assembly', 'static', [], Location.at(call.anchor)),
    )
  const expressionType =
    hasAvailableCallSyntax(call) &&
    reference._tag === 'ResolvedBuiltin' &&
    specializationDiagnostic === undefined &&
    inferenceDiagnostic === undefined &&
    unsafeDiagnostic === undefined &&
    qualifierDiagnostic === undefined &&
    assemblyDiagnostics.length === 0
      ? availableExpressionType(reference.result)
      : unavailableExpressionType

  return {
    fact: {
      _tag: 'Call',
      reference,
      path: referencePath(context, call),
      typeArguments: typeArguments.facts,
      arguments: argumentsResult.facts,
      mappings: callContract.mappings,
      contract: callContract.fact,
      type: expressionType,
      anchor: call.anchor,
    },
    diagnostics: [
      ...(missingDiagnostic === undefined ? [] : [missingDiagnostic]),
      ...(specializationDiagnostic === undefined ? [] : [specializationDiagnostic]),
      ...(inferenceDiagnostic === undefined ? [] : [inferenceDiagnostic]),
      ...(unsafeDiagnostic === undefined ? [] : [unsafeDiagnostic]),
      ...(qualifierDiagnostic === undefined ? [] : [qualifierDiagnostic]),
      ...assemblyDiagnostics,
      ...argumentsResult.diagnostics,
      ...typeArguments.diagnostics,
      ...callContract.diagnostics,
    ],
    type: expressionType._tag === 'Available' ? expressionType.type : undefined,
  }
}

export const builtinArgumentMappings = (
  reference: CallReferenceFact,
  argumentsList: ReadonlyArray<ArgumentFact>,
): ReadonlyArray<BuiltinArgumentMappingFact> => {
  if (reference._tag !== 'ResolvedBuiltin') {
    return []
  }
  return reference.parameters.flatMap(
    (expected, ordinal): ReadonlyArray<BuiltinArgumentMappingFact> => {
      const argument = argumentsList.at(ordinal)
      return argument === undefined
        ? []
        : [{ _tag: 'BuiltinArgumentMapping', argument, ordinal, expected }]
    },
  )
}

interface AggregateElementAnalysis {
  readonly expression: Tir.Expression
  readonly type?: SemanticType
  readonly anchor: AuthoredHir.Anchor
  readonly label?: string
}

const generatedAggregate = (
  context: SemanticContext.SemanticContext,
  syntax: AuthoredHir.Expression,
  kind: 'AnonymousNamed' | 'AnonymousPositional',
  elements: ReadonlyArray<AggregateElementAnalysis & { readonly type: SemanticType }>,
  resolution: ResolutionContext,
): { readonly struct: DeclarationFacts.StructFact; readonly type: Type.Nominal } => {
  if (resolution.builder === undefined)
    throw new RangeError('anonymous aggregate analysis requires its TIR body builder')
  const node = BodyBuilder.expressionReference(resolution.builder, syntax.anchor)
  const identity = AggregateIdentity.anonymous(AuthoredWalk.moduleName(context), node, kind)
  const type = AggregateIdentity.nominal(identity)
  const id: DeclarationFacts.DeclarationId = {
    _tag: 'DeclarationId',
    sourceId: AuthoredWalk.moduleName(context),
    ordinal: -1 - node.node.ordinal * 2 - (kind === 'AnonymousPositional' ? 1 : 0),
  }
  const fields = elements.map((element, ordinal): DeclarationFacts.FieldFact => {
    const fieldId: DeclarationFacts.FieldId = {
      _tag: 'FieldId',
      owner: { _tag: 'StructFieldOwnerId', declaration: id },
      ordinal,
    }
    const labeled = kind === 'AnonymousNamed'
    const label = element.label
    return {
      _tag: 'AggregateField',
      id: fieldId,
      member:
        labeled && label !== undefined
          ? AggregateIdentity.labeled(label)
          : AggregateIdentity.ordinal(ordinal),
      state: { _tag: 'Unique', id: fieldId },
      visibility: 'Public',
      name:
        labeled && label !== undefined
          ? { _tag: 'Present', spelling: label, anchor: element.anchor }
          : { _tag: 'Unavailable', anchor: element.anchor },
      declaredType: {
        _tag: 'Resolved',
        type: element.type,
        spelling: Type.encode(element.type),
        anchor: element.anchor,
      },
      anchor: element.anchor,
    }
  })
  const dependencies = new Map<string, Type.Nominal>()
  for (const element of elements)
    for (const dependency of Type.nominals(element.type))
      dependencies.set(Type.key(dependency), dependency)
  const struct: DeclarationFacts.StructFact = {
    _tag: 'StructDeclaration',
    id,
    canonical: {
      _tag: 'Canonical',
      id: {
        _tag: 'CanonicalDeclarationId',
        module: identity.module,
        name: AggregateIdentity.internalName(identity),
      },
    },
    visibility: 'Private',
    layout: { _tag: 'Silk' },
    typeParameters: [],
    name: { _tag: 'Unavailable', anchor: syntax.anchor },
    identity,
    aggregateKind: kind,
    fields: fields,
    dependency: {
      _tag: 'Available',
      types: [...dependencies.values()].sort(Type.compare),
    },
    anchor: syntax.anchor,
  }
  resolution.generatedAggregates?.set(aggregateKey(type), struct)
  return { struct, type }
}

const analyzeAggregateElements = (
  context: SemanticContext.SemanticContext,
  syntax: AuthoredHir.Expression,
  elementSyntax: ReadonlyArray<{
    readonly expression: AuthoredHir.Expression
    readonly label?: string
    readonly anchor?: AuthoredHir.Anchor
    readonly initializerSyntax?: AuthoredHir.Expression
  }>,
  struct: DeclarationFacts.StructFact,
  nominal: Type.Nominal,
  declarations: ReadonlyArray<DeclarationFact>,
  declaration: DeclarationFact,
  scope: Scope,
  resolution: ResolutionContext,
  preanalyzed: ReadonlyArray<ExpressionResult> = [],
): ExpressionResult => {
  const diagnostics: Array<Diagnostic.Located> = []
  const substitution =
    TypeInference.substitution(
      struct.typeParameters.map((parameter) => parameter.type),
      nominal.arguments,
    ) ?? new Map()
  const positional =
    struct.aggregateKind === 'Positional' || struct.aggregateKind === 'AnonymousPositional'
  if (positional && elementSyntax.length !== struct.fields.length)
    diagnostics.push(
      Diagnostic.tupleArityMismatch(
        Type.display(nominal),
        struct.fields.length,
        elementSyntax.length,
        Location.at(syntax.anchor),
      ),
    )
  const seen = new Map<string, Location.Location>()
  const initializers: Array<StructInitializerFact> = []
  const mapped: Array<{ field: DeclarationFacts.FieldFact; initializer: StructInitializerFact }> =
    []
  for (const [ordinal, element] of elementSyntax.entries()) {
    let field: DeclarationFacts.FieldFact | undefined
    if (positional) field = struct.fields.at(ordinal)
    else if (element.label !== undefined) {
      const lookup = DeclarationFacts.lookupField(struct.fields, element.label)
      if (lookup._tag === 'Resolved') field = lookup.field
    }
    const expected =
      field?.declaredType._tag === 'Resolved'
        ? Type.substitute(field.declaredType.type, substitution)
        : undefined
    const analyzed =
      preanalyzed.at(ordinal) ??
      analyzeExpression(
        context,
        element.expression,
        declarations,
        declaration,
        scope,
        resolution,
        expected,
      )
    if (analyzed === undefined)
      throw new RangeError(`Cannot analyze aggregate member ${element.expression._tag}`)
    diagnostics.push(...analyzed.diagnostics)
    let state: StructInitializerState = { _tag: 'Unavailable' }
    if (!positional && element.label !== undefined) {
      const previous = seen.get(element.label)
      if (previous !== undefined && field !== undefined) {
        const diagnostic = Diagnostic.duplicateStructInitializer(
          element.label,
          previous,
          Location.at(element.anchor ?? element.expression.anchor),
        )
        diagnostics.push(diagnostic)
        state = {
          _tag: 'Duplicate',
          field,
          cause: Diagnostic.identity(diagnostic),
        }
      } else if (field === undefined) {
        const diagnostic = Diagnostic.unknownStructField(
          Type.display(nominal),
          element.label,
          Location.at(element.anchor ?? element.expression.anchor),
        )
        diagnostics.push(diagnostic)
        state = { _tag: 'Unknown', cause: Diagnostic.identity(diagnostic) }
      }
      seen.set(element.label, Location.at(element.anchor ?? element.expression.anchor))
    }
    if (field !== undefined && state._tag === 'Unavailable') {
      if (field.visibility === 'Private' && nominal.module !== AuthoredWalk.moduleName(context)) {
        const diagnostic = Diagnostic.inaccessibleProjectedField(
          Type.display(nominal),
          element.label ?? `${ordinal}`,
          Location.at(element.anchor ?? element.expression.anchor),
        )
        diagnostics.push(diagnostic)
        state = {
          _tag: 'Inaccessible',
          field,
          cause: Diagnostic.identity(diagnostic),
        }
      } else if (
        expected !== undefined &&
        analyzed.type !== undefined &&
        !typesCompatible(analyzed.type, expected, resolution?.lifetimeCompatibility) &&
        !contextualIntegerCompatible(analyzed.fact, expected, resolution.builder)
      ) {
        const diagnostic = Diagnostic.structFieldTypeMismatch(
          element.label ?? `${ordinal}`,
          Type.display(expected),
          Type.display(analyzed.type),
          Location.at(element.expression.anchor),
        )
        diagnostics.push(diagnostic)
        state = {
          _tag: 'TypeMismatch',
          field,
          cause: Diagnostic.identity(diagnostic),
        }
      } else if (analyzed.type !== undefined) {
        state = { _tag: 'Resolved', field }
      }
    }
    const initializer: StructInitializerFact = {
      _tag: 'StructInitializer',
      name: positional ? undefined : element.label,
      ...(element.anchor === undefined ? {} : { nameAnchor: element.anchor }),
      expression: expressionNode(analyzed),
      state,
      anchor: (element.initializerSyntax ?? element.expression).anchor,
    }
    initializers.push(initializer)
    if (state._tag === 'Resolved') mapped.push({ field: state.field, initializer })
  }
  if (!positional) {
    for (const field of struct.fields) {
      if (field.name._tag !== 'Present' || seen.has(field.name.spelling)) continue
      diagnostics.push(
        Diagnostic.missingStructInitializer(
          nominal.name,
          field.name.spelling,
          Location.at(syntax.anchor),
        ),
      )
    }
  }
  const authorized =
    (struct.visibility === 'Public' || nominal.module === AuthoredWalk.moduleName(context)) &&
    struct.fields.every(
      (field) =>
        field.visibility === 'Public' || nominal.module === AuthoredWalk.moduleName(context),
    )
  const complete =
    AuthoredWalk.isAvailable(syntax) &&
    authorized &&
    initializers.length === struct.fields.length &&
    mapped.length === struct.fields.length &&
    initializers.every((initializer) => initializer.state._tag === 'Resolved')
  const type = complete ? availableExpressionType(nominal) : unavailableExpressionType
  const token = nameSegments(syntax).at(-1)?.anchor
  return {
    fact: {
      _tag: 'StructLiteral',
      target: {
        _tag: 'Resolved',
        struct,
        type: nominal,
        ...(token === undefined || struct.aggregateKind.startsWith('Anonymous')
          ? {}
          : { anchor: token }),
      },
      authorized,
      typeArguments: [],
      initializers: initializers,
      fields: struct.fields.flatMap((field) => {
        const pair = mapped.find((candidate) =>
          DeclarationFacts.sameFieldId(candidate.field.id, field.id),
        )
        return pair === undefined ? [] : [pair]
      }),
      type,
      anchor: syntax.anchor,
    },
    diagnostics: diagnostics,
    type: complete ? nominal : undefined,
  }
}

const positionalElements = (
  node: AuthoredHir.Expression,
): ReadonlyArray<AuthoredHir.Expression> => {
  if (node._tag === 'TupleExpression') return node.elements
  if (node._tag === 'ArrayExpression') return node.elements
  return node._tag === 'CallExpression' ? node.arguments : []
}

const contextualRecordElements = (
  context: SemanticContext.SemanticContext,
  node: AuthoredHir.Expression,
): ReadonlyArray<{
  readonly expression: AuthoredHir.Expression
  readonly label?: string
  readonly anchor?: AuthoredHir.Anchor
  readonly initializerSyntax?: AuthoredHir.Expression
}> =>
  (node._tag === 'RecordExpression' ? node.fields : []).flatMap((initializer) => {
    const label = SemanticContext.nameText(context, initializer.name)
    return [
      {
        expression: initializer.value,
        ...(label === undefined ? {} : { label, anchor: initializer.name.anchor }),
        initializerSyntax: initializer.value,
      },
    ]
  })

const expectedAggregate = (
  expected: SemanticType | undefined,
  resolution: ResolutionContext,
): { readonly struct: DeclarationFacts.StructFact; readonly type: Type.Nominal } | undefined => {
  if (expected === undefined || !Type.isNominal(expected)) return undefined
  const struct = aggregateByNominal(resolution, expected)
  return struct === undefined || struct.aggregateKind.startsWith('Anonymous')
    ? undefined
    : { struct, type: expected }
}

const analyzeTupleLiteral = (
  context: SemanticContext.SemanticContext,
  node: AuthoredHir.Expression,
  declarations: ReadonlyArray<DeclarationFact>,
  declaration: DeclarationFact,
  scope: Scope,
  resolution: ResolutionContext,
  expected?: SemanticType,
): ExpressionResult => {
  const elements = positionalElements(node)
  const contextual = expectedAggregate(expected, resolution)
  if (contextual !== undefined && contextual.struct.aggregateKind === 'Positional') {
    const substitution = new Map<string, Type.GenericArgument>()
    for (const [ordinal, parameter] of contextual.struct.typeParameters.entries()) {
      const argument = contextual.type.arguments.at(ordinal)
      if (argument !== undefined && !(Type.isTypeArgument(argument) && Type.isParameter(argument)))
        substitution.set(Type.key(parameter.type), argument)
    }
    const preanalyzed = elements.map((element, ordinal): ExpressionResult => {
      const field = contextual.struct.fields.at(ordinal)
      const specialized =
        field?.declaredType._tag === 'Resolved'
          ? Type.substitute(field.declaredType.type, substitution)
          : undefined
      const result = analyzeExpression(
        context,
        element,
        declarations,
        declaration,
        scope,
        resolution,
        specialized !== undefined && Type.isConcrete(specialized) ? specialized : undefined,
      )
      if (result === undefined)
        throw new RangeError(`Cannot analyze contextual tuple element ${element._tag}`)
      if (field?.declaredType._tag === 'Resolved' && result.type !== undefined) {
        const candidate = new Map(substitution)
        if (TypeInference.infer(field.declaredType.type, result.type, candidate)) {
          for (const [key, argument] of candidate) substitution.set(key, argument)
        }
      }
      return result
    })
    const arguments_ = contextual.struct.typeParameters.map(
      (parameter, ordinal) =>
        substitution.get(Type.key(parameter.type)) ??
        contextual.type.arguments.at(ordinal) ??
        Type.parameterArgument(parameter.type),
    )
    const inferredType = Type.nominal(contextual.type.module, contextual.type.name, arguments_)
    return analyzeAggregateElements(
      context,
      node,
      elements.map((expression) => ({ expression })),
      contextual.struct,
      inferredType,
      declarations,
      declaration,
      scope,
      resolution,
      preanalyzed,
    )
  }
  if (contextual !== undefined) {
    const diagnostic = Diagnostic.contextualAggregateKindMismatch(
      'tuple',
      Type.display(contextual.type),
      Location.at(node.anchor),
    )
    return {
      fact: unavailableExpression(node.anchor),
      diagnostics: [diagnostic],
      type: undefined,
    }
  }
  const analyzed = elements.map((expression): ExpressionResult => {
    const result = analyzeExpression(
      context,
      expression,
      declarations,
      declaration,
      scope,
      resolution,
    )
    if (result === undefined)
      throw new RangeError(`Cannot analyze tuple element ${expression._tag}`)
    return result
  })
  const diagnostics = analyzed.flatMap((element) => element.diagnostics)
  if (analyzed.some((element) => element.type === undefined))
    return {
      fact: unavailableExpression(node.anchor),
      diagnostics: diagnostics,
      type: undefined,
    }
  const generated = generatedAggregate(
    context,
    node,
    'AnonymousPositional',
    analyzed.map((element, ordinal) => ({
      expression: expressionNode(element),
      type: element.type ?? Type.unit,
      anchor: (elements.at(ordinal) ?? node).anchor,
    })),
    resolution,
  )
  return analyzeAggregateElements(
    context,
    node,
    elements.map((expression) => ({ expression })),
    generated.struct,
    generated.type,
    declarations,
    declaration,
    scope,
    resolution,
    analyzed,
  )
}

const analyzeContextualRecordLiteral = (
  context: SemanticContext.SemanticContext,
  node: AuthoredHir.Expression,
  declarations: ReadonlyArray<DeclarationFact>,
  declaration: DeclarationFact,
  scope: Scope,
  resolution: ResolutionContext,
  expected?: SemanticType,
): ExpressionResult => {
  const elements = contextualRecordElements(context, node)
  const contextual = expectedAggregate(expected, resolution)
  if (contextual !== undefined && contextual.struct.aggregateKind === 'Named')
    return analyzeAggregateLiteral(context, node, declarations, declaration, scope, resolution, {
      fact: {
        _tag: 'Resolved',
        struct: contextual.struct,
        type: contextual.type,
      },
      diagnostics: [],
    })
  if (contextual !== undefined) {
    const diagnostic = Diagnostic.contextualAggregateKindMismatch(
      'record',
      Type.display(contextual.type),
      Location.at(node.anchor),
    )
    return {
      fact: unavailableExpression(node.anchor),
      diagnostics: [diagnostic],
      type: undefined,
    }
  }
  const analyzed = elements.map((element): ExpressionResult => {
    const result = analyzeExpression(
      context,
      element.expression,
      declarations,
      declaration,
      scope,
      resolution,
    )
    if (result === undefined)
      throw new RangeError(`Cannot analyze record member ${element.expression._tag}`)
    return result
  })
  if (analyzed.some((element) => element.type === undefined))
    return {
      fact: unavailableExpression(node.anchor),
      diagnostics: analyzed.flatMap((element) => element.diagnostics),
      type: undefined,
    }
  const labels = new Map<string, Location.Location>()
  const duplicateDiagnostics: Array<Diagnostic.Located> = []
  for (const element of elements) {
    if (element.label === undefined) continue
    const span = Location.at(element.anchor ?? element.expression.anchor)
    const previous = labels.get(element.label)
    if (previous !== undefined)
      duplicateDiagnostics.push(
        Diagnostic.duplicateStructInitializer(element.label, previous, span),
      )
    else labels.set(element.label, span)
  }
  if (duplicateDiagnostics.length > 0)
    return {
      fact: unavailableExpression(node.anchor),
      diagnostics: Diagnostic.collect(
        analyzed.flatMap((element) => element.diagnostics),
        duplicateDiagnostics,
      ),
      type: undefined,
    }
  const generated = generatedAggregate(
    context,
    node,
    'AnonymousNamed',
    analyzed.map((element, ordinal) => {
      const syntaxElement = elements.at(ordinal)
      return {
        expression: expressionNode(element),
        type: element.type ?? Type.unit,
        anchor: (syntaxElement?.expression ?? node).anchor,
        ...(syntaxElement?.label === undefined ? {} : { label: syntaxElement.label }),
        ...(syntaxElement?.anchor === undefined ? {} : { anchor: syntaxElement.anchor }),
      }
    }),
    resolution,
  )
  return analyzeAggregateElements(
    context,
    node,
    elements,
    generated.struct,
    generated.type,
    declarations,
    declaration,
    scope,
    resolution,
    analyzed,
  )
}

const tupleConstructor = (
  context: SemanticContext.SemanticContext,
  node: AuthoredHir.Expression,
  declarations: ReadonlyArray<DeclarationFact>,
  declaration: DeclarationFact,
  scope: Scope,
  resolution: ResolutionContext,
): ExpressionResult | undefined => {
  const tokens = referenceNames(node)
  const first = tokens.at(0)
  const second = tokens.at(1)
  let candidate: DeclarationFacts.MemberFact | undefined
  if (first !== undefined && second === undefined) {
    if (scopeSpanFor(context, scope, SemanticContext.nameText(context, first) ?? '') !== undefined)
      return undefined
    const lookup = Semantic.resolveName(
      resolution.semantic,
      resolution.scope,
      SemanticContext.nameText(context, first) ?? '',
    )
    if (lookup._tag === 'Resolved') candidate = lookup.declaration
  } else if (first !== undefined && second !== undefined) {
    if (scopeSpanFor(context, scope, SemanticContext.nameText(context, first) ?? '') !== undefined)
      return undefined
    const qualifier = Semantic.resolveName(
      resolution.semantic,
      resolution.scope,
      SemanticContext.nameText(context, first) ?? '',
    )
    if (qualifier._tag === 'Namespace') {
      const lookup = DeclarationFacts.member(
        resolution.index,
        qualifier.module,
        SemanticContext.nameText(context, second) ?? '',
      )
      if (lookup._tag === 'Resolved') candidate = lookup.declaration
    }
  }
  if (candidate?._tag !== 'StructDeclaration' || candidate.aggregateKind !== 'Positional')
    return undefined
  if (candidate.canonical._tag !== 'Canonical') return undefined

  const elements = positionalElements(node)
  const typeArguments = analyzeCallTypeArguments(context, node, declaration, resolution)
  const parameters = candidate.typeParameters.map((parameter) => parameter.type)
  const substitution = new Map<string, Type.GenericArgument>()
  if (typeArguments.explicit && typeArguments.types !== undefined) {
    for (const [ordinal, supplied] of typeArguments.types.entries()) {
      const parameter = parameters.at(ordinal)
      if (parameter === undefined || parameter.kind !== 'Value' || !Type.isTypeArgument(supplied))
        continue
      substitution.set(Type.key(parameter), supplied)
    }
  }
  const preanalyzed = elements.map((element, ordinal): ExpressionResult => {
    const field = candidate.fields.at(ordinal)
    const expected =
      field?.declaredType._tag === 'Resolved'
        ? Type.substitute(field.declaredType.type, substitution)
        : undefined
    const result = analyzeExpression(
      context,
      element,
      declarations,
      declaration,
      scope,
      resolution,
      expected,
    )
    if (result === undefined)
      throw new RangeError(`Cannot analyze tuple constructor argument ${element._tag}`)
    if (field?.declaredType._tag === 'Resolved' && result.type !== undefined)
      TypeInference.infer(field.declaredType.type, result.type, substitution)
    return result
  })
  const diagnostics: Array<Diagnostic.Located> = [...typeArguments.diagnostics]
  const arguments_: Array<Type.GenericArgument> = []
  for (const parameter of candidate.typeParameters) {
    const argument = substitution.get(Type.key(parameter.type))
    if (argument === undefined) {
      diagnostics.push(
        Diagnostic.uninferredTypeParameter(
          candidate.canonical.id.name,
          parameter.type.name,
          Location.at(parameter.anchor),
        ),
      )
      arguments_.push(Type.parameterArgument(parameter.type))
    } else arguments_.push(argument)
  }
  const nominal = Type.nominal(
    candidate.canonical.id.module,
    candidate.canonical.id.name,
    arguments_,
  )
  const analyzed = analyzeAggregateElements(
    context,
    node,
    elements.map((expression) => ({ expression })),
    candidate,
    nominal,
    declarations,
    declaration,
    scope,
    resolution,
    preanalyzed,
  )
  return {
    fact: analyzed.fact,
    diagnostics: Diagnostic.collect(diagnostics, analyzed.diagnostics),
    type: analyzed.type,
  }
}

export const analyzeShortCircuitExpression = (
  context: SemanticContext.SemanticContext,
  node: AuthoredHir.Expression,
  operator: Operator.ShortCircuit,
  operandNodes: ReadonlyArray<AuthoredHir.Expression>,
  declarations: ReadonlyArray<DeclarationFact>,
  declaration: DeclarationFact,
  scope: Scope,
  resolution: ResolutionContext,
): ExpressionResult => {
  const boolean: SemanticType = Scalar.boolean.spelling
  const argumentsResult = analyzeArgumentNodes(
    context,
    node,
    operandNodes,
    declarations,
    declaration,
    scope,
    resolution,
    operandNodes.map(() => boolean),
  )
  const operandDiagnostics = argumentsResult.facts.flatMap((argument) =>
    argument.type._tag === 'Available' && !Type.equals(argument.type.type, boolean)
      ? [
          Diagnostic.argumentTypeMismatch(
            Type.display(boolean),
            Type.display(argument.type.type),
            Location.at(argument.anchor),
          ),
        ]
      : [],
  )
  const rejected =
    operandDiagnostics.length > 0 ||
    argumentsResult.facts.length !== 2 ||
    argumentsResult.facts.some((argument) => argument.type._tag !== 'Available')
  const type = rejected ? unavailableExpressionType : availableExpressionType(boolean)
  return {
    fact: {
      _tag: 'ShortCircuit',
      operator,
      arguments: argumentsResult.facts,
      type,
      anchor: node.anchor,
    },
    diagnostics: [...argumentsResult.diagnostics, ...operandDiagnostics],
    type: type._tag === 'Available' ? type.type : undefined,
  }
}

export interface OperatorContractSelection extends InterfaceOperationFact {
  readonly declaration: DeclarationFacts.ServiceOperationFact
  readonly parameters: ReadonlyArray<SemanticType>
  readonly result: SemanticType
  readonly label: string
}

export const operatorContractSelection = (
  capability: Type.Nominal,
  provider: Type.Type,
  operation: DeclarationFacts.InterfaceOperationApplicationFact,
): OperatorContractSelection | undefined => {
  const contract = interfaceOperationContract(operation)
  const name = operation.declaration.name
  if (contract === undefined || name._tag !== 'Present') return undefined
  return {
    capability,
    provider,
    operation: name.spelling,
    contract: operation,
    declaration: contract.declaration,
    parameters: contract.parameters,
    result: contract.result,
    label: `${Type.encode(capability)}.${name.spelling}`,
  }
}

export const boundOperatorSelections = (
  declaration: DeclarationFact,
  operator: Operator.Eligible,
): ReadonlyArray<OperatorContractSelection> =>
  declaration.typeParameters.flatMap((parameter) =>
    parameter.bounds.flatMap((bound) => {
      if (bound._tag !== 'ResolvedBound') {
        return []
      }
      return bound.application.operations.flatMap((operation) => {
        if (operation.declaration.operator?.operator !== operator) return []
        const selected = operatorContractSelection(
          bound.application.capability,
          parameter.type,
          operation,
        )
        return selected === undefined ? [] : [selected]
      })
    }),
  )

export const concreteOperatorSelections = (
  index: DeclarationIndex.Index,
  module: string,
  operator: Operator.Eligible,
): ReadonlyArray<OperatorContractSelection> => {
  const interfaces = index.modules.flatMap((headers) => headers.interfaces)
  const selections = index.modules.flatMap((headers) =>
    headers.conformances.flatMap((conformance) => {
      if (
        conformance.validity._tag !== 'ValidConformance' ||
        conformance.coherence._tag !== 'Coherent' ||
        conformance.termination._tag !== 'Terminating' ||
        conformance.capability._tag !== 'Resolved' ||
        conformance.provider._tag !== 'Resolved' ||
        !Type.isNominal(conformance.capability.type)
      )
        return []
      const capability = conformance.capability.type
      const provider = conformance.provider.type
      const interface_ = interfaces.find(
        (candidate) =>
          candidate.canonical._tag === 'Canonical' &&
          candidate.canonical.id.module === capability.module &&
          candidate.canonical.id.name === capability.name &&
          (candidate.visibility === 'Public' || candidate.canonical.id.module === module),
      )
      if (interface_ === undefined) return []
      const proof = ConformanceProof.prove(index, provider, capability)
      if (
        proof._tag !== 'Proved' ||
        proof.selection._tag !== 'SourceSelection' ||
        proof.selection.module !== conformance.module ||
        proof.selection.ordinal !== conformance.ordinal
      )
        return []
      const application = DeclarationFacts.interfaceApplication(interface_, capability, provider)
      if (application?.available !== true) return []
      return application.operations.flatMap((operation) => {
        if (operation.declaration.operator?.operator !== operator) return []
        const selected = operatorContractSelection(capability, provider, operation)
        return selected === undefined ? [] : [selected]
      })
    }),
  )
  const unique = new Map<string, OperatorContractSelection>()
  for (const selection of selections)
    unique.set(
      `${Type.key(selection.capability)}\u0000${Type.key(selection.provider)}\u0000${selection.operation}`,
      selection,
    )
  return [...unique.values()]
}

export const operatorSelectionMatches = (
  selection: OperatorContractSelection,
  arguments_: ReadonlyArray<ArgumentFact>,
  node: AuthoredHir.Expression,
  resolution: ResolutionContext,
): boolean => {
  // Candidate probing must not retain constraints from operations that are not selected.
  const lifetimes = TypeCompatibility.context({
    ...(resolution.lifetimeCompatibility === undefined
      ? {}
      : {
          assumptions: resolution.lifetimeCompatibility.assumptions,
          nominalVariance: resolution.lifetimeCompatibility.nominalVariance,
        }),
    outlives: (longer, shorter) =>
      longer._tag === 'LocalLifetime' || shorter._tag === 'LocalLifetime',
  })
  const reference = selectedOperatorReference(selection, node, resolution)
  return (
    reference.parameters.length === arguments_.length &&
    arguments_.every((argument, ordinal) => {
      const expected = reference.parameters.at(ordinal)
      return (
        expected !== undefined &&
        argument.type._tag === 'Available' &&
        (typesCompatible(argument.type.type, expected, lifetimes) ||
          contextualIntegerCompatible(argument.expression, expected, resolution.builder))
      )
    })
  )
}

const selectedOperatorReference = (
  selection: OperatorContractSelection,
  node: AuthoredHir.Expression,
  resolution: ResolutionContext,
): Extract<CallReferenceFact, { readonly _tag: 'ResolvedInterfaceOperation' }> =>
  instantiateInterfaceReference(
    {
      _tag: 'ResolvedInterfaceOperation',
      spelling: selection.label,
      anchor: node.anchor,
      capability: selection.capability,
      provider: selection.provider,
      operation: selection.operation,
      declaration: selection.declaration,
      interfaceContract: selection.contract,
      parameters: selection.parameters,
      result: selection.result,
    },
    node,
    resolution,
  )

export const finishInterfaceOperator = (
  context: SemanticContext.SemanticContext,
  node: AuthoredHir.Expression,
  operator: Operator.Eligible,
  operandNodes: ReadonlyArray<AuthoredHir.Expression>,
  declarations: ReadonlyArray<DeclarationFact>,
  declaration: DeclarationFact,
  scope: Scope,
  resolution: ResolutionContext,
  selection: OperatorContractSelection,
): ExpressionResult => {
  const reference = selectedOperatorReference(selection, node, resolution)
  const argumentsResult = analyzeArgumentNodes(
    context,
    node,
    operandNodes,
    declarations,
    declaration,
    scope,
    resolution,
    reference.parameters,
  )
  const arguments_ = argumentsResult.facts.map((argument) => argument)
  const contract = analyzeCallContract(
    context,
    node,
    reference,
    arguments_,
    true,
    undefined,
    resolution,
  )
  const type =
    contract.fact._tag === 'Compatible'
      ? availableExpressionType(reference.result)
      : unavailableExpressionType
  return {
    fact: {
      _tag: 'Operator',
      operator,
      reference,
      arguments: arguments_,
      mappings: reference.parameters.flatMap((expected, ordinal) => {
        const argument = arguments_.at(ordinal)
        return argument === undefined
          ? []
          : [
              {
                _tag: 'BuiltinArgumentMapping' as const,
                argument,
                ordinal,
                expected,
              },
            ]
      }),
      contract: contract.fact,
      selectedConformances: interfaceEvidence(reference, resolution.index),
      interfaceOperation: selection,
      ...(selection.contract.functionKind === 'Effect'
        ? {
            witnessEffectSite: executableSite('EffectSiteId', resolution, node),
          }
        : {}),
      type,
      anchor: node.anchor,
    },
    diagnostics: [...argumentsResult.diagnostics, ...contract.diagnostics],
    type: type._tag === 'Available' ? type.type : undefined,
  }
}

export const analyzeOperatorExpression = (
  context: SemanticContext.SemanticContext,
  node: AuthoredHir.Expression,
  declarations: ReadonlyArray<DeclarationFact>,
  declaration: DeclarationFact,
  scope: Scope,
  resolution: ResolutionContext,
  expected?: SemanticType,
): ExpressionResult => {
  // Operator diagnostics and the operator reference name the written token, not the operands.
  const operatorPosition =
    node._tag === 'PrefixExpression' || node._tag === 'InfixExpression'
      ? node.operatorAnchor
      : node.anchor
  // The authored operator is already decoded; only `BitwiseNot` is spelled differently here.
  let operator: Operator.Prefix | Operator.Infix | undefined
  let operandNodes: ReadonlyArray<AuthoredHir.Expression>
  if (node._tag === 'PrefixExpression') {
    operator = node.operator === 'BitwiseNot' ? 'BitNot' : node.operator
    operandNodes = [node.operand]
  } else if (node._tag === 'InfixExpression') {
    operator = node.operator
    operandNodes = [node.left, node.right]
  } else {
    operator = undefined
    operandNodes = []
  }
  if (operator !== undefined && Operator.isShortCircuit(operator)) {
    return analyzeShortCircuitExpression(
      context,
      node,
      operator,
      operandNodes,
      declarations,
      declaration,
      scope,
      resolution,
    )
  }
  const initialExpected =
    typeof expected === 'string' &&
    Scalar.isSpelling(expected) &&
    node._tag === 'InfixExpression' &&
    operator !== undefined &&
    !Operator.isPredicate(operator)
      ? operandNodes.map(() => expected)
      : []
  let argumentsResult = analyzeArgumentNodes(
    context,
    node,
    operandNodes,
    declarations,
    declaration,
    scope,
    resolution,
    initialExpected,
  )
  if (operator === undefined || node === undefined) {
    const reference: CallReferenceFact = {
      _tag: 'Unavailable',
      anchor: node.anchor,
    }
    return {
      fact: {
        _tag: 'Operator',
        operator: node._tag === 'PrefixExpression' ? 'Negate' : 'Add',
        reference,
        arguments: argumentsResult.facts,
        mappings: [],
        contract: {
          _tag: 'Unavailable',
          reason: { _tag: 'UnavailableCallSyntax', anchor: node.anchor },
        },
        type: unavailableExpressionType,
        anchor: node.anchor,
      },
      diagnostics: argumentsResult.diagnostics,
      type: undefined,
    }
  }

  // A bare numeric or character literal's scalar type is only a default, so it must
  // not drive the operand retry when another operand carries a declared scalar type: `5 + x`
  // must type like `x + 5`. When every operand is a literal, the first (defaulted) one drives.
  const drivingOrdinal = operandNodes.findIndex((operand, ordinal) => {
    if (
      operand._tag === 'IntegerLiteral' ||
      operand._tag === 'FloatingLiteral' ||
      operand._tag === 'CharacterLiteral'
    )
      return false
    const type = argumentsResult.facts.at(ordinal)?.type
    return (
      type?._tag === 'Available' && typeof type.type === 'string' && Scalar.isSpelling(type.type)
    )
  })
  const firstType = argumentsResult.facts.at(drivingOrdinal === -1 ? 0 : drivingOrdinal)?.type
  if (
    firstType?._tag === 'Available' &&
    typeof firstType.type === 'string' &&
    Scalar.isSpelling(firstType.type) &&
    (initialExpected.length === 0 || firstType.type !== expected) &&
    operandNodes.length > 1
  ) {
    argumentsResult = analyzeArgumentNodes(
      context,
      node,
      operandNodes,
      declarations,
      declaration,
      scope,
      resolution,
      operandNodes.map(() => firstType.type),
    )
  }
  const selectedFirstType = argumentsResult.facts.at(0)?.type
  const selectedSecondType = argumentsResult.facts.at(1)?.type
  const firstEnum =
    selectedFirstType?._tag === 'Available'
      ? enumFactByType(resolution.index, selectedFirstType.type)
      : undefined
  const secondEnum =
    selectedSecondType?._tag === 'Available'
      ? enumFactByType(resolution.index, selectedSecondType.type)
      : undefined
  if (firstEnum !== undefined || secondEnum !== undefined) {
    const isEquality = operator === 'Equals' || operator === 'NotEquals'
    const isOrdering =
      operator === 'LessThan' ||
      operator === 'LessOrEqual' ||
      operator === 'GreaterThan' ||
      operator === 'GreaterOrEqual'
    const firstTypeText =
      selectedFirstType?._tag === 'Available' ? Type.encode(selectedFirstType.type) : '?'
    const secondTypeText =
      selectedSecondType?._tag === 'Available' ? Type.encode(selectedSecondType.type) : '?'
    const sameEnum =
      firstEnum?.canonical._tag === 'Canonical' &&
      secondEnum?.canonical._tag === 'Canonical' &&
      firstEnum.canonical.id.module === secondEnum.canonical.id.module &&
      firstEnum.canonical.id.name === secondEnum.canonical.id.name
    if (
      isEquality &&
      sameEnum &&
      firstEnum !== undefined &&
      firstEnum.canonical._tag === 'Canonical'
    ) {
      const equalityOperator = operator === 'Equals' ? 'Equals' : 'NotEquals'
      const reference: CallReferenceFact = {
        _tag: 'ResolvedEnumEquality',
        spelling: Operator.spelling(operator),
        anchor: operatorPosition,
        enum: firstEnum.canonical.id,
        operator: equalityOperator,
      }
      return {
        fact: {
          _tag: 'Operator',
          operator,
          reference,
          arguments: argumentsResult.facts,
          mappings: [],
          contract: {
            _tag: 'Compatible',
            expectedCount: 2,
            actualCount: argumentsResult.facts.length,
            typeArguments: [],
            substitution: new Map(),
            evidence: [],
            inferredProviderSelectors: [],
          },
          type: availableBoolExpressionType,
          anchor: node.anchor,
        },
        diagnostics: argumentsResult.diagnostics,
        type: 'bool',
      }
    }
    let diagnostic: Diagnostic.Located | undefined
    if (isOrdering) {
      diagnostic = Diagnostic.enumOrdering(
        firstEnum === undefined ? secondTypeText : firstTypeText,
        Operator.spelling(operator),
        Location.at(operatorPosition),
      )
    } else if (isEquality && firstEnum !== undefined && secondEnum !== undefined) {
      diagnostic = Diagnostic.crossEnumEquality(
        firstTypeText,
        secondTypeText,
        Location.at(operatorPosition),
      )
    } else if (isEquality) {
      diagnostic = Diagnostic.enumIntegerMismatch(
        firstEnum === undefined ? secondTypeText : firstTypeText,
        firstEnum === undefined ? firstTypeText : secondTypeText,
        firstEnum === undefined ? 'IntegerToEnum' : 'EnumToInteger',
        Location.at(operatorPosition),
      )
    } else {
      diagnostic = undefined
    }
    if (diagnostic !== undefined) {
      const reference: CallReferenceFact = {
        _tag: 'Missing',
        spelling: Operator.spelling(operator),
        anchor: operatorPosition,
        cause: Diagnostic.identity(diagnostic),
      }
      return {
        fact: {
          _tag: 'Operator',
          operator,
          reference,
          arguments: argumentsResult.facts,
          mappings: [],
          contract: {
            _tag: 'Unavailable',
            reason: { _tag: 'UnavailableCallSyntax', anchor: node.anchor },
            cause: Diagnostic.identity(diagnostic),
          },
          type: unavailableExpressionType,
          anchor: node.anchor,
        },
        diagnostics: [...argumentsResult.diagnostics, diagnostic],
        type: undefined,
      }
    }
  }
  const builtinOperand =
    selectedFirstType?._tag === 'Available' &&
    (Type.isString(selectedFirstType.type) || Scalar.isSpelling(selectedFirstType.type))
  if (!builtinOperand) {
    const candidates = [
      ...boundOperatorSelections(declaration, operator),
      ...concreteOperatorSelections(resolution.index, AuthoredWalk.moduleName(context), operator),
    ].filter((candidate) =>
      operatorSelectionMatches(candidate, argumentsResult.facts, node, resolution),
    )
    if (candidates.length === 1) {
      const candidate = candidates.at(0)
      if (candidate !== undefined)
        return finishInterfaceOperator(
          context,
          node,
          operator,
          operandNodes,
          declarations,
          declaration,
          scope,
          resolution,
          candidate,
        )
    }
    const operatorSpelling = Operator.spelling(operator)
    const operandTypes = argumentsResult.facts.flatMap((argument) =>
      argument.type._tag === 'Available' ? [Type.display(argument.type.type)] : [],
    )
    const diagnostic =
      candidates.length > 1
        ? Diagnostic.ambiguousOperator(
            operatorSpelling,
            candidates.map((candidate) => candidate.label),
            Location.at(operatorPosition),
          )
        : Diagnostic.operatorNotApplicable(
            operatorSpelling,
            operandTypes,
            Location.at(operatorPosition),
          )
    const reference: CallReferenceFact = {
      _tag: 'Missing',
      spelling: operatorSpelling,
      anchor: operatorPosition,
      cause: Diagnostic.identity(diagnostic),
    }
    return {
      fact: {
        _tag: 'Operator',
        operator,
        reference,
        arguments: argumentsResult.facts,
        mappings: [],
        contract: {
          _tag: 'Unavailable',
          reason: { _tag: 'UnavailableCallSyntax', anchor: node.anchor },
          cause: Diagnostic.identity(diagnostic),
        },
        type: unavailableExpressionType,
        anchor: node.anchor,
      },
      diagnostics: [...argumentsResult.diagnostics, diagnostic],
      type: undefined,
    }
  }
  let selectedActor: Operator.Actor
  if (selectedFirstType?._tag === 'Available' && Type.isString(selectedFirstType.type)) {
    selectedActor = 'string'
  } else if (selectedFirstType?._tag === 'Available' && Scalar.isSpelling(selectedFirstType.type)) {
    selectedActor = selectedFirstType.type
  } else {
    selectedActor = Scalar.defaultInteger.spelling
  }
  const target = Operator.target(operator, selectedActor)
  const template = builtinSignature(target.actor, target.operation, 'Primitive')
  if (template === undefined) throw new RangeError('Compiler operator table is inconsistent')
  const signature = instantiateBuiltinSignature(template, node, resolution)
  const operatorParameters = signature.parameters
  const operatorResult = signature.result
  const reference: CallReferenceFact = {
    _tag: 'ResolvedBuiltin',
    spelling: `${target.actor}.${target.operation}`,
    anchor: operatorPosition,
    actor: target.actor,
    operation: signature.operation,
    intrinsic: signature.id,
    parameters: operatorParameters,
    result: operatorResult,
    unsafe: signature.unsafe === true,
  }
  const contract = analyzeCallContract(
    context,
    node,
    reference,
    argumentsResult.facts,
    AuthoredWalk.isAvailable(node),
    undefined,
    resolution,
  )
  const expressionType =
    contract.fact._tag === 'Compatible'
      ? availableExpressionType(operatorResult)
      : unavailableExpressionType
  return {
    fact: {
      _tag: 'Operator',
      operator,
      reference,
      arguments: argumentsResult.facts,
      mappings: builtinArgumentMappings(reference, argumentsResult.facts),
      contract: contract.fact,
      type: expressionType,
      anchor: node.anchor,
    },
    diagnostics: [...argumentsResult.diagnostics, ...contract.diagnostics],
    type: expressionType._tag === 'Available' ? expressionType.type : undefined,
  }
}

type AppliedInterfaceOperationTarget =
  | {
      readonly _tag: 'Resolved'
      readonly interface: DeclarationFacts.InterfaceFact
      readonly capability: Type.Nominal
      readonly application: DeclarationFacts.DeclaredTypeFact
      readonly reference: Extract<
        CallReferenceFact,
        { readonly _tag: 'ResolvedInterfaceOperation' }
      >
      readonly diagnostics: ReadonlyArray<Diagnostic.Located>
    }
  | {
      readonly _tag: 'Invalid'
      readonly diagnostics: ReadonlyArray<Diagnostic.Located>
    }

const appliedMemberExpression = (
  node: AuthoredHir.Expression,
): Extract<AuthoredHir.Expression, { readonly _tag: 'MemberExpression' }> | undefined => {
  const callee = node._tag === 'CallExpression' ? callCallee(node) : node
  return callee._tag === 'MemberExpression' ? callee : undefined
}

const appliedMemberParts = (
  node: AuthoredHir.Expression,
):
  | {
      readonly owner: AuthoredHir.Type
      readonly member: AuthoredHir.Name
    }
  | undefined => {
  const expression = appliedMemberExpression(node)
  return expression === undefined
    ? undefined
    : {
        owner: expression.selector.subject,
        member: expression.selector.member,
      }
}

/** One inherent receiver method of a nominal owner, when the owner declares it. */
type MethodCandidate =
  | {
      readonly _tag: 'Inherent'
      readonly declaration: DeclarationFact
      readonly ownerSpelling: string
    }
  | {
      readonly _tag: 'NoReceiver'
      readonly declaration: DeclarationFact
      readonly ownerSpelling: string
    }
  | {
      readonly _tag: 'Unavailable'
      readonly reference: Extract<CallReferenceFact, { readonly _tag: 'Missing' }>
      readonly diagnostic?: Diagnostic.Located
    }
  | {
      readonly _tag: 'Bound'
      readonly reference: Extract<
        CallReferenceFact,
        { readonly _tag: 'ResolvedInterfaceOperation' }
      >
    }
  | {
      readonly _tag: 'AmbiguousBound'
      readonly parameter: string
      readonly interfaces: ReadonlyArray<string>
    }
  | {
      readonly _tag: 'Conformance'
      readonly reference: Extract<
        CallReferenceFact,
        { readonly _tag: 'ResolvedInterfaceOperation' }
      >
    }
  | {
      readonly _tag: 'AmbiguousConformance'
      readonly receiver: string
      readonly interfaces: ReadonlyArray<string>
    }
  | { readonly _tag: 'Missing' }

/**
 * The receiver operations of one name that a concrete receiver's proved conformances supply.
 *
 * `implementedContracts` is the shared authority: it admits an application only when the ordinary
 * proof selects that exact context conformance and the interface itself is visible to the calling
 * module, so an interface the caller cannot name never contributes a member. Selecting the operation
 * through the applied interface is the same pair the qualified spelling uses once it knows `Self`;
 * because the provider is already concrete here, no `Self` inference is needed. An operation
 * declaring its own binders has no contract, and one with no operand of the provider's type is not
 * a receiver operation; neither supplies a candidate through any spelling.
 */
const conformanceOperationCandidates = (
  receiverType: Type.Nominal,
  member: string,
  resolution: ResolutionContext,
): ReadonlyArray<{
  readonly capability: Type.Nominal
  readonly operation: DeclarationFacts.InterfaceOperationApplicationFact
}> =>
  ConformanceProof.implementedContracts(
    resolution.index,
    resolution.scope.module,
    receiverType,
  ).flatMap((capability) => {
    const contract = ConformanceProof.contractByCapability(resolution.index, capability)
    if (contract === undefined || contract.dependencyEligible) return []
    const application = DeclarationFacts.interfaceApplication(contract, capability, receiverType)
    const operation = application?.operations.find(
      (candidate) =>
        candidate.declaration.name._tag === 'Present' &&
        candidate.declaration.name.spelling === member &&
        candidate.receiverAccess !== 'Unavailable',
    )
    return application?.available === true && operation !== undefined
      ? [{ capability, operation }]
      : []
  })

/**
 * Resolves a bare qualified call `Contract.operation(...)` whose caller has no bound for the
 * contract: the receiver operand's own type selects the conformance. A parameter-typed receiver
 * has no bound to select through and is reported as such; a nominal receiver selects its unique
 * proved conformance of the contract, and two applications are reported as ambiguous. A call with
 * no receiver operand, or none the contract can read, resolves nothing here.
 */
const concreteContractOperationReference = (
  context: SemanticContext.SemanticContext,
  contract: DeclarationFacts.ContractFact,
  member: string,
  memberToken: AuthoredHir.Name,
  argumentsResult: ArgumentsResult,
  resolution: ResolutionContext,
):
  | {
      readonly _tag: 'Resolved'
      readonly reference: Extract<
        CallReferenceFact,
        { readonly _tag: 'ResolvedInterfaceOperation' }
      >
    }
  | { readonly _tag: 'Rejected'; readonly diagnostic: Diagnostic.Located }
  | undefined => {
  if (contract.canonical._tag !== 'Canonical') return undefined
  const operationContract = contract.operationContracts.find(
    (candidate) =>
      candidate.declaration.name._tag === 'Present' &&
      candidate.declaration.name.spelling === member,
  )
  // An ambient service operation takes its provider from the Effect environment, never from an
  // argument, so the synthesized receiver operand selects nothing here.
  if (
    operationContract === undefined ||
    operationContract.operands.some((operand) => operand.parameter.id.ordinal < 0)
  )
    return undefined
  const receiverOrdinal = operationContract.operands.findIndex((operand) => {
    if (operand.type._tag !== 'Resolved') return false
    const type = operand.type.type
    return Type.equals(Type.isReference(type) ? type.target : type, contract.self)
  })
  const receiver = receiverOrdinal < 0 ? undefined : argumentsResult.facts.at(receiverOrdinal)
  if (receiver === undefined || receiver.type._tag !== 'Available') return undefined
  const receiverType = Type.isReference(receiver.type.type)
    ? receiver.type.type.target
    : receiver.type.type
  const contractName = contract.canonical.id.name
  if (Type.isParameter(receiverType))
    return {
      _tag: 'Rejected',
      diagnostic: Diagnostic.invalidConformance(
        `${Type.encode(receiverType)} does not implement ${contractName}`,
        Location.at(memberToken.anchor),
      ),
    }
  if (!Type.isNominal(receiverType)) return undefined
  const canonical = contract.canonical.id
  const supplied = ConformanceProof.implementedContracts(
    resolution.index,
    resolution.scope.module,
    receiverType,
  ).flatMap((capability) => {
    if (capability.module !== canonical.module || capability.name !== canonical.name) return []
    const application = DeclarationFacts.interfaceApplication(contract, capability, receiverType)
    const operation = application?.operations.find(
      (candidate) =>
        candidate.declaration.name._tag === 'Present' &&
        candidate.declaration.name.spelling === member,
    )
    return application?.available === true && operation !== undefined
      ? [{ capability, operation }]
      : []
  })
  if (supplied.length === 0)
    return {
      _tag: 'Rejected',
      diagnostic: Diagnostic.invalidConformance(
        `${Type.encode(receiverType)} does not implement ${contractName}`,
        Location.at(memberToken.anchor),
      ),
    }
  if (supplied.length > 1)
    return {
      _tag: 'Rejected',
      diagnostic: Diagnostic.ambiguousSuppliedOperation(
        Type.encode(receiverType),
        member,
        supplied.map(({ capability }) => Type.encode(capability)),
        Location.at(memberToken.anchor),
      ),
    }
  const selected = supplied.at(0)
  const selectedContract =
    selected === undefined ? undefined : interfaceOperationContract(selected.operation)
  if (selected === undefined || selectedContract === undefined) return undefined
  return {
    _tag: 'Resolved',
    reference: {
      _tag: 'ResolvedInterfaceOperation' as const,
      spelling: `${Type.encode(selected.capability)}.${member}`,
      anchor: memberToken.anchor,
      capability: selected.capability,
      provider: receiverType,
      operation: member,
      declaration: selectedContract.declaration,
      interfaceContract: selectedContract.contract,
      parameters: selectedContract.parameters,
      result: selectedContract.result,
    },
  }
}

/**
 * Resolves the member a value-side spelling `receiver.member(...)` names, mirroring the type-side
 * `lookupAssociated`: an inherent member of a nominal receiver, the unique receiver operation among
 * a type parameter's declared bounds, or — only where the receiver's own type has no such member at
 * all — the unique receiver operation its visible proved conformances supply.
 */
export const resolveMethodCandidate = (
  context: SemanticContext.SemanticContext,
  subjectType: SemanticType,
  member: string,
  memberAnchor: AuthoredHir.Anchor,
  caller: DeclarationFact,
  resolution: ResolutionContext,
): MethodCandidate => {
  if (Type.isNominal(subjectType)) {
    const owner = DeclarationFacts.byCanonical(resolution.index, {
      _tag: 'CanonicalDeclarationId',
      module: subjectType.module,
      name: subjectType.name,
    })
    if (owner === undefined) return { _tag: 'Missing' }
    const associated = Semantic.resolveAssociatedName(
      resolution.semantic,
      owner,
      member,
      resolution.scope.module,
    )
    if (associated._tag === 'Inherent') {
      const fact =
        associated.declaration._tag === 'FunctionDeclaration'
          ? associated.declaration.associatedMember
          : undefined
      if (fact === undefined) return { _tag: 'Missing' }
      return fact.receiver
        ? {
            _tag: 'Inherent',
            declaration: associated.declaration,
            ownerSpelling: fact.ownerSpelling,
          }
        : {
            _tag: 'NoReceiver',
            declaration: associated.declaration,
            ownerSpelling: fact.ownerSpelling,
          }
    }
    if (associated._tag === 'Inaccessible') {
      const diagnostic = Diagnostic.inaccessibleImportedMember(
        associated.declaration.canonical._tag === 'Canonical'
          ? associated.declaration.canonical.id.module
          : subjectType.name,
        member,
        Location.at(memberAnchor),
      )
      return {
        _tag: 'Unavailable',
        reference: {
          _tag: 'Missing',
          spelling: `${subjectType.name}.${member}`,
          anchor: memberAnchor,
          cause: Diagnostic.identity(diagnostic),
        },
        diagnostic,
      }
    }
    if (associated._tag === 'Duplicate')
      return {
        _tag: 'Unavailable',
        reference: {
          _tag: 'Missing',
          spelling: `${subjectType.name}.${member}`,
          anchor: memberAnchor,
          cause: associated.cause,
        },
      }
    // Only a name the receiver's own type does not claim at all falls through to its conformances.
    // An inaccessible or duplicate inherent member has already answered above, so a conformance
    // never rescues a name an inherent declaration claimed and failed.
    const supplied = conformanceOperationCandidates(subjectType, member, resolution)
    if (supplied.length === 0) return { _tag: 'Missing' }
    if (supplied.length > 1)
      return {
        _tag: 'AmbiguousConformance',
        receiver: Type.encode(subjectType),
        interfaces: supplied.map(({ capability }) => Type.encode(capability)),
      }
    const selectedConformance = supplied.at(0)
    if (selectedConformance === undefined) return { _tag: 'Missing' }
    const suppliedContract = interfaceOperationContract(selectedConformance.operation)
    if (suppliedContract === undefined) return { _tag: 'Missing' }
    return {
      _tag: 'Conformance',
      reference: {
        _tag: 'ResolvedInterfaceOperation' as const,
        spelling: `${Type.encode(selectedConformance.capability)}.${member}`,
        anchor: memberAnchor,
        capability: selectedConformance.capability,
        provider: subjectType,
        operation: member,
        declaration: suppliedContract.declaration,
        interfaceContract: suppliedContract.contract,
        parameters: suppliedContract.parameters,
        result: suppliedContract.result,
      },
    }
  }
  if (!Type.isParameter(subjectType)) return { _tag: 'Missing' }
  const parameter = caller.typeParameters.find((candidate) =>
    Type.equals(candidate.type, subjectType),
  )
  if (parameter === undefined) return { _tag: 'Missing' }
  const candidates = parameter.bounds.flatMap((bound) =>
    bound._tag === 'ResolvedBound'
      ? bound.application.operations.flatMap((operation) =>
          operation.declaration.name._tag === 'Present' &&
          operation.declaration.name.spelling === member &&
          operation.receiverAccess !== 'Unavailable'
            ? [{ bound, operation }]
            : [],
        )
      : [],
  )
  const parameterName =
    parameter.name._tag === 'Present' ? parameter.name.spelling : Type.encode(parameter.type)
  if (candidates.length === 0) return { _tag: 'Missing' }
  if (candidates.length > 1)
    return {
      _tag: 'AmbiguousBound',
      parameter: parameterName,
      interfaces: candidates.map(({ bound }) => bound.spelling),
    }
  const selected = candidates.at(0)
  if (selected === undefined) return { _tag: 'Missing' }
  const contract = interfaceOperationContract(selected.operation)
  if (contract === undefined) return { _tag: 'Missing' }
  return {
    _tag: 'Bound',
    reference: {
      _tag: 'ResolvedInterfaceOperation' as const,
      spelling: `${parameterName}.${member}`,
      anchor: memberAnchor,
      capability: selected.bound.application.capability,
      provider: parameter.type,
      operation: member,
      declaration: contract.declaration,
      interfaceContract: contract.contract,
      parameters: contract.parameters,
      result: contract.result,
    },
  }
}

/**
 * Prepends the owner binders a receiver's static type fixes to an explicit type-argument list, so
 * `value.map<i64>(f)` binds `i64` to the member's own `U` while `T` comes from `value: Option<i32>`.
 * Owner binders the receiver leaves open are not prepended, and the list then binds as written.
 */
const withReceiverOwnerArguments = (
  declaration: DeclarationFact,
  receiverType: SemanticType | undefined,
  explicit: CallTypeArgumentsResult,
  memberToken: AuthoredHir.Name,
  node: AuthoredHir.Expression,
): CallTypeArgumentsResult => {
  const parameterZero = declaration.parameters.at(0)
  if (receiverType === undefined || parameterZero?.declaredType._tag !== 'Resolved') return explicit
  const pattern = parameterZero.declaredType.type
  const declared = Type.isReference(pattern) ? pattern.target : pattern
  const actual = Type.isReference(receiverType) ? receiverType.target : receiverType
  const inferred = new Map<string, Type.GenericArgument>()
  if (!TypeInference.infer(declared, actual, inferred)) return explicit
  const leading: Array<SemanticType> = []
  for (const parameter of declaration.typeParameters) {
    const bound = inferred.get(Type.key(parameter.type))
    if (bound === undefined || !Type.isTypeArgument(bound)) break
    leading.push(bound)
  }
  if (leading.length === 0) return explicit
  const facts = [
    ...leading.map((type, ordinal) => ({
      _tag: 'TypeArgument' as const,
      ordinal,
      anchor: node.anchor,
      declared: {
        _tag: 'Resolved' as const,
        type,
        spelling: Type.display(type),
        anchor: node.anchor,
      },
      type,
    })),
    ...explicit.facts.map((fact, ordinal) => ({ ...fact, ordinal: leading.length + ordinal })),
  ]
  const types = facts.map((fact) => fact.type)
  return {
    explicit: true,
    facts: facts,
    ...(types.every((type) => type !== undefined)
      ? { types: types.filter((type): type is SemanticType => type !== undefined) }
      : {}),
    diagnostics: explicit.diagnostics,
  }
}

/**
 * Adapts the receiver to parameter zero: a reference parameter borrows a place (or passes a
 * reference through), and a by-value parameter consumes a place or takes an rvalue as it is. The
 * declaration decides the ownership, so nothing is written in front of the receiver.
 */
const synthesizeReceiver = (
  context: SemanticContext.SemanticContext,
  subjectNode: AuthoredHir.Expression,
  subjectResult: ExpressionResult,
  parameterType: SemanticType | undefined,
  declaration: DeclarationFact,
  resolution: ResolutionContext,
): ExpressionResult => {
  const subjectType = subjectResult.type
  const publishReceiver = (result: ExpressionResult): ExpressionResult => {
    if (result.node !== undefined || resolution.builder === undefined) return result
    const node = BodyBuilder.tirExpression(result.fact, {
      context,
      builder: resolution.builder,
      ...(declaration.phase === 'Static' ? { static: resolution.builder.expressions } : {}),
      ...(resolution.lifetimeCompatibility === undefined
        ? {}
        : { lifetimeCompatibility: resolution.lifetimeCompatibility }),
      ...(declaration.opaqueResult === undefined
        ? {}
        : { opaqueResultFamily: declaration.opaqueResult.family }),
      functionId: declaration.id,
    })
    return { ...result, node }
  }
  if (parameterType !== undefined && Type.isReference(parameterType)) {
    // A reference receiver of the declared access passes through; any other reference reborrows
    // through the ordinary rules, so `&mut` reaches a `&Self` method and `&` never reaches `&mut`.
    if (
      subjectType !== undefined &&
      Type.isReference(subjectType) &&
      subjectType.access === parameterType.access
    )
      return publishReceiver(subjectResult)
    return publishReceiver(
      borrowSubject(
        context,
        subjectNode,
        subjectNode,
        subjectResult,
        parameterType.access,
        parameterType,
        declaration,
        resolution,
      ),
    )
  }
  if (borrowRoot(context, subjectResult.fact) === undefined) return publishReceiver(subjectResult)
  const callableMetadata = (() => {
    const fact = subjectResult.fact
    if (fact._tag === 'FunctionItem' || fact._tag === 'CallableSection')
      return { exactCallable: fact, concreteCallableIdentity: true as const }
    if (fact._tag === 'Move' && fact.exactCallable !== undefined)
      return {
        exactCallable: fact.exactCallable,
        ...(fact.concreteCallableIdentity === true
          ? { concreteCallableIdentity: true as const }
          : {}),
      }
    return {}
  })()
  return publishReceiver({
    fact: {
      _tag: 'Move',
      subject: expressionNode(subjectResult),
      ...callableMetadata,
      type: subjectResult.fact.type,
      anchor: subjectNode.anchor,
    },
    diagnostics: subjectResult.diagnostics,
    type: subjectResult.type,
  })
}

const declaredParameterType = (parameter: ParameterFact | undefined): SemanticType | undefined =>
  parameter?.declaredType._tag === 'Resolved' ? parameter.declaredType.type : undefined

/**
 * Whether binding `member` to `subject` would loan a temporary: a section outlives the statement
 * that built it, so a borrowed receiver must be a place or an existing reference.
 */
const borrowsTemporary = (
  context: SemanticContext.SemanticContext,
  member: DeclarationFact,
  subject: ExpressionResult,
): boolean => {
  const parameterType = declaredParameterType(member.parameters.at(0))
  return (
    parameterType !== undefined &&
    Type.isReference(parameterType) &&
    borrowRoot(context, subject.fact) === undefined &&
    (subject.type === undefined || !Type.isReference(subject.type))
  )
}

/**
 * Binds `subject.member` as the section of an inherent receiver method: the receiver is captured
 * as parameter zero under the declared mode and the remaining parameters stay open, so the value
 * lowers and executes exactly as a trailing section of `Owner.member` does.
 */
const finishBoundMethod = (
  context: SemanticContext.SemanticContext,
  node: AuthoredHir.Expression,
  subjectNode: AuthoredHir.Expression,
  subject: ExpressionResult,
  candidate: Extract<MethodCandidate, { readonly _tag: 'Inherent' }>,
  member: string,
  memberAnchor: AuthoredHir.Anchor,
  declaration: DeclarationFact,
  resolution: ResolutionContext,
): ExpressionResult => {
  const receiver = synthesizeReceiver(
    context,
    subjectNode,
    subject,
    declaredParameterType(candidate.declaration.parameters.at(0)),
    declaration,
    resolution,
  )
  return finishCallableSection(
    context,
    node,
    {
      _tag: 'Resolved',
      spelling: `${candidate.ownerSpelling}.${member}`,
      anchor: memberAnchor,
      declaration: candidate.declaration,
    },
    {
      facts: [argumentFact(declaration, context, node.anchor, receiver, 0)],
      diagnostics: receiver.diagnostics,
    },
    analyzeCallTypeArguments(context, node, declaration, resolution),
    resolution,
    declaration,
    [0],
    { _tag: 'ReferencePath', memberSpelling: member, memberAnchor },
  )
}

/**
 * Analyzes `receiver.member(args)` as the statically selected member the explicit forms name,
 * or returns nothing so the ordinary callee path runs: a type qualifier, a callable field, or an
 * unknown member all keep their existing analysis.
 */
const analyzeMethodCall = (
  context: SemanticContext.SemanticContext,
  node: AuthoredHir.Expression,
  declarations: ReadonlyArray<DeclarationFact>,
  declaration: DeclarationFact,
  scope: Scope,
  resolution: ResolutionContext,
): ExpressionResult | undefined => {
  const calleeNode = callCallee(node)
  if (calleeNode._tag !== 'FieldExpression') return undefined
  const subjectNode = calleeNode._tag === 'FieldExpression' ? calleeNode.subject : undefined
  const memberToken = calleeNode._tag === 'FieldExpression' ? calleeNode.field : undefined
  if (subjectNode === undefined || memberToken === undefined) return undefined
  if (subjectNode._tag === 'IdentifierExpression') {
    // Only a value of the enclosing scope is a receiver; a declaration or namespace qualifier
    // keeps the type-side path, and a local that shadows a type name is a value.
    const value = analyzeIdentifier(context, subjectNode, scope)
    if (
      value.fact._tag !== 'Identifier' ||
      (value.fact.reference._tag !== 'Resolved' &&
        value.fact.reference._tag !== 'ResolvedBinding' &&
        value.fact.reference._tag !== 'ResolvedPattern')
    )
      return undefined
  }
  const member = SemanticContext.nameText(context, memberToken) ?? ''
  // The receiver is argument zero, so a written borrow is as valid here as in an argument list.
  const subjectResult = analyzeExpression(
    context,
    subjectNode,
    declarations,
    declaration,
    scope,
    resolution,
    undefined,
  )
  if (subjectResult === undefined) return undefined
  const argumentNodes = node._tag === 'CallExpression' ? node.arguments : []
  const callTypeArguments = analyzeCallTypeArguments(context, node, declaration, resolution)
  const path: ReferencePathFact = {
    _tag: 'ReferencePath',
    memberSpelling: SemanticContext.nameText(context, memberToken) ?? '',
    memberAnchor: memberToken.anchor,
  }
  const withSubjectDiagnostics = (finished: ExpressionResult): ExpressionResult => ({
    ...finished,
    diagnostics: [...subjectResult.diagnostics, ...finished.diagnostics],
  })
  const rejected = (
    reference: Extract<CallReferenceFact, { readonly _tag: 'Missing' }>,
    diagnostic: Diagnostic.Located | undefined,
  ): ExpressionResult => {
    const written = analyzeArgumentNodes(
      context,
      node,
      argumentNodes,
      declarations,
      declaration,
      scope,
      resolution,
    )
    return withSubjectDiagnostics(
      finishDeclarationCall(
        context,
        node,
        reference,
        {
          facts: [
            argumentFact(declaration, context, node.anchor, subjectResult, 0),
            ...written.facts.map((argument, ordinal) =>
              argumentFact(declaration, context, node.anchor, argument, ordinal + 1),
            ),
          ],
          diagnostics: written.diagnostics,
        },
        callTypeArguments,
        diagnostic,
        declaration,
        resolution,
        path,
      ),
    )
  }
  const subjectType = subjectResult.type
  if (subjectType === undefined) {
    // The receiver already failed: report it once and give the call no target.
    const cause = subjectResult.diagnostics.at(0)
    if (cause === undefined) return undefined
    return rejected(
      {
        _tag: 'Missing',
        spelling: member,
        anchor: memberToken.anchor,
        cause: Diagnostic.identity(cause),
      },
      undefined,
    )
  }
  const target = Type.isReference(subjectType) ? subjectType.target : subjectType
  // A callable field wins over every member, and an unknown name stays the field diagnostic: both
  // are the ordinary application of the projected callee, never a type-side lookup of the value.
  const applyField = (): ExpressionResult => {
    const written = analyzeArgumentNodes(
      context,
      node,
      argumentNodes,
      declarations,
      declaration,
      scope,
      resolution,
    )
    const projected = analyzeExpression(
      context,
      calleeNode,
      declarations,
      declaration,
      scope,
      resolution,
    )
    if (projected === undefined) throw new RangeError('method callee projection was not analyzed')
    return finishCallableApplication(
      context,
      node,
      projected,
      written,
      callTypeArguments,
      undefined,
      resolution,
      declaration,
    )
  }
  if (Type.isNominal(target)) {
    const aggregate = aggregateByNominal(resolution, target)
    const field =
      aggregate === undefined
        ? undefined
        : DeclarationFacts.lookupAggregateMember(
            aggregate.fields,
            AggregateIdentity.labeled(member),
          )
    if (field?._tag === 'Resolved') return applyField()
  }
  const candidate = resolveMethodCandidate(
    context,
    target,
    member,
    memberToken.anchor,
    declaration,
    resolution,
  )
  if (candidate._tag === 'Missing') return applyField()
  if (candidate._tag === 'Unavailable') return rejected(candidate.reference, candidate.diagnostic)
  if (candidate._tag === 'NoReceiver') {
    const diagnostic = Diagnostic.associatedFunctionOnValue(
      candidate.ownerSpelling,
      member,
      Location.at(memberToken.anchor),
    )
    return rejected(
      {
        _tag: 'Missing',
        spelling: `${candidate.ownerSpelling}.${member}`,
        anchor: memberToken.anchor,
        cause: Diagnostic.identity(diagnostic),
      },
      diagnostic,
    )
  }
  if (candidate._tag === 'AmbiguousBound') {
    const diagnostic = Diagnostic.ambiguousReceiverOperation(
      candidate.parameter,
      member,
      candidate.interfaces,
      Location.at(memberToken.anchor),
    )
    return rejected(
      {
        _tag: 'Missing',
        spelling: `${candidate.parameter}.${member}`,
        anchor: memberToken.anchor,
        cause: Diagnostic.identity(diagnostic),
      },
      diagnostic,
    )
  }
  // Two supplying applications are reported before the arguments are analyzed against either, so
  // no written argument can select the operation the call names.
  if (candidate._tag === 'AmbiguousConformance') {
    const diagnostic = Diagnostic.ambiguousSuppliedOperation(
      candidate.receiver,
      member,
      candidate.interfaces,
      Location.at(memberToken.anchor),
    )
    return rejected(
      {
        _tag: 'Missing',
        spelling: `${candidate.receiver}.${member}`,
        anchor: memberToken.anchor,
        cause: Diagnostic.identity(diagnostic),
      },
      diagnostic,
    )
  }
  const parameterTypes: ReadonlyArray<SemanticType | undefined> =
    candidate._tag === 'Inherent'
      ? instantiateSourceParameters(candidate.declaration, node, resolution)
      : instantiateInterfaceReference(candidate.reference, node, resolution).parameters
  const receiver = synthesizeReceiver(
    context,
    subjectNode,
    subjectResult,
    parameterTypes.at(0),
    declaration,
    resolution,
  )
  // An explicit list binds the member's own binders: the receiver already fixes the owner's, so
  // they are prepended from the receiver's type exactly as an applied qualifier would supply them.
  const typeArguments =
    candidate._tag === 'Inherent' && callTypeArguments.explicit
      ? withReceiverOwnerArguments(
          candidate.declaration,
          subjectResult.type,
          callTypeArguments,
          memberToken,
          node,
        )
      : callTypeArguments
  const written = analyzeArgumentNodes(
    context,
    node,
    argumentNodes,
    declarations,
    declaration,
    scope,
    resolution,
    parameterTypes.slice(1),
  )
  const argumentsResult: ArgumentsResult = {
    facts: [
      argumentFact(declaration, context, node.anchor, receiver, 0),
      ...written.facts.map((argument, ordinal) =>
        argumentFact(declaration, context, node.anchor, argument, ordinal + 1),
      ),
    ],
    diagnostics: [...receiver.diagnostics, ...written.diagnostics],
  }
  if (candidate._tag === 'Bound' || candidate._tag === 'Conformance')
    return finishInterfaceOperationCall(
      context,
      node,
      candidate.reference,
      argumentsResult,
      typeArguments,
      resolution,
      node,
      undefined,
      path,
    )
  return finishDeclarationCall(
    context,
    node,
    {
      _tag: 'Resolved',
      spelling: `${candidate.ownerSpelling}.${member}`,
      anchor: memberToken.anchor,
      declaration: candidate.declaration,
    },
    argumentsResult,
    typeArguments,
    undefined,
    declaration,
    resolution,
    path,
  )
}

/** Whether a call's applied qualifier names an inherent member of a nominal owner. */
const appliedInherentMember = (
  context: SemanticContext.SemanticContext,
  node: AuthoredHir.Expression,
  resolution: ResolutionContext,
): boolean => {
  const parts = appliedMemberParts(node)
  if (parts === undefined) return false
  const tokens = nameSegments(parts.owner)
  const token = tokens.at(0)
  if (token === undefined || tokens.length !== 1) return false
  const owner = Semantic.resolveName(
    resolution.semantic,
    resolution.scope,
    SemanticContext.nameText(context, token) ?? '',
  )
  return (
    owner._tag === 'Resolved' &&
    Semantic.resolveAssociatedName(
      resolution.semantic,
      owner.declaration,
      SemanticContext.nameText(context, parts.member) ?? '',
      resolution.scope.module,
    )._tag !== 'Missing'
  )
}

const appliedInterfaceOwnerDeclaration = (
  context: SemanticContext.SemanticContext,
  owner: AuthoredHir.Type,
  resolution: ResolutionContext,
): DeclarationFacts.ContractFact | undefined => {
  const token = nameSegments(owner).at(-1)
  if (token === undefined) return undefined
  const lookup = Semantic.resolveName(
    resolution.semantic,
    resolution.scope,
    SemanticContext.nameText(context, token) ?? '',
  )
  return lookup._tag === 'Resolved' &&
    (lookup.declaration._tag === 'InterfaceDeclaration' ||
      lookup.declaration._tag === 'ServiceDeclaration')
    ? lookup.declaration
    : undefined
}

const isInterfaceFact = (
  declaration: DeclarationFacts.ContractFact,
): declaration is DeclarationFacts.InterfaceFact =>
  declaration._tag === 'InterfaceDeclaration' && declaration.dependencyEligible === false

const resolveAppliedInterfaceOperationTarget = (
  context: SemanticContext.SemanticContext,
  node: AuthoredHir.Expression,
  caller: DeclarationFact,
  resolution: ResolutionContext,
): AppliedInterfaceOperationTarget | undefined => {
  const parts = appliedMemberParts(node)
  if (parts === undefined) return undefined
  const ownerResult = resolvePatternType(
    context,
    parts.owner,
    resolution,
    caller,
    parts.owner.anchor,
  )
  const ownerType = ownerResult.type
  const resolvedDeclaration =
    ownerType !== undefined && Type.isNominal(ownerType)
      ? DeclarationFacts.byCanonical(resolution.index, {
          _tag: 'CanonicalDeclarationId',
          module: ownerType.module,
          name: ownerType.name,
        })
      : undefined
  const ownerDeclaration =
    resolvedDeclaration?._tag === 'InterfaceDeclaration' ||
    resolvedDeclaration?._tag === 'ServiceDeclaration'
      ? resolvedDeclaration
      : appliedInterfaceOwnerDeclaration(context, parts.owner, resolution)
  if (ownerDeclaration === undefined) return undefined
  const member = SemanticContext.nameText(context, parts.member) ?? ''
  if (ownerDeclaration._tag === 'ServiceDeclaration') {
    return {
      _tag: 'Invalid',
      diagnostics: Diagnostic.collect(ownerResult.diagnostics, [
        Diagnostic.unknownActorOperation(
          Type.encode(ownerType ?? ownerDeclaration.self),
          member,
          Location.at(parts.member.anchor),
        ),
      ]),
    }
  }
  if (!isInterfaceFact(ownerDeclaration)) return undefined
  if (ownerType === undefined || !Type.isNominal(ownerType)) {
    return {
      _tag: 'Invalid',
      diagnostics:
        ownerResult.diagnostics.length > 0
          ? ownerResult.diagnostics
          : [
              Diagnostic.typeArgumentInference(
                ownerDeclaration.canonical._tag === 'Canonical'
                  ? ownerDeclaration.canonical.id.name
                  : 'interface',
                Location.at(parts.owner.anchor),
              ),
            ],
    }
  }
  const application = DeclarationFacts.interfaceApplication(
    ownerDeclaration,
    ownerType,
    ownerDeclaration.self,
  )
  const operation = application?.operations.find(
    (candidate) =>
      candidate.declaration.name._tag === 'Present' &&
      candidate.declaration.name.spelling === member,
  )
  const contract = operation === undefined ? undefined : interfaceOperationContract(operation)
  if (application === undefined || operation === undefined || contract === undefined) {
    return {
      _tag: 'Invalid',
      diagnostics: Diagnostic.collect(ownerResult.diagnostics, [
        Diagnostic.unknownActorOperation(
          Type.encode(ownerType),
          member,
          Location.at(parts.member.anchor),
        ),
      ]),
    }
  }
  return {
    _tag: 'Resolved',
    interface: ownerDeclaration,
    capability: ownerType,
    application: ownerResult.declared,
    reference: {
      _tag: 'ResolvedInterfaceOperation' as const,
      spelling: `${Type.encode(ownerType)}.${member}`,
      anchor: parts.member.anchor,
      capability: ownerType,
      provider: ownerDeclaration.self,
      operation: member,
      declaration: contract.declaration,
      interfaceContract: contract.contract,
      parameters: contract.parameters,
      result: contract.result,
    },
    diagnostics: ownerResult.diagnostics,
  }
}

const fallbackAppliedInterfaceProviders = (
  caller: DeclarationFact,
  capability: Type.Nominal,
  operation: string,
): ReadonlyArray<Type.Type> => {
  const unique = new Map<string, Type.Type>()
  for (const parameter of caller.typeParameters) {
    for (const bound of parameter.bounds) {
      if (
        bound._tag !== 'ResolvedBound' ||
        !Type.equals(bound.application.capability, capability) ||
        !bound.application.operations.some(
          (candidate) =>
            candidate.declaration.name._tag === 'Present' &&
            candidate.declaration.name.spelling === operation,
        )
      )
        continue
      unique.set(Type.key(parameter.type), parameter.type)
    }
  }
  return [...unique.values()]
}

const hasAppliedInterfaceBound = (
  caller: DeclarationFact,
  provider: Type.Type,
  capability: Type.Nominal,
): boolean =>
  caller.typeParameters.some(
    (parameter) =>
      Type.equals(parameter.type, provider) &&
      parameter.bounds.some(
        (bound) =>
          bound._tag === 'ResolvedBound' && Type.equals(bound.application.capability, capability),
      ),
  )

const resolveAppliedInterfaceProvider = (
  context: SemanticContext.SemanticContext,
  node: AuthoredHir.Expression,
  target: Extract<AppliedInterfaceOperationTarget, { readonly _tag: 'Resolved' }>,
  argumentsResult: ArgumentsResult,
  caller: DeclarationFact,
  resolution: ResolutionContext,
):
  | {
      readonly reference: Extract<
        CallReferenceFact,
        { readonly _tag: 'ResolvedInterfaceOperation' }
      >
    }
  | { readonly diagnostics: ReadonlyArray<Diagnostic.Located> } => {
  if (target.reference.parameters.length !== argumentsResult.facts.length) {
    return {
      diagnostics: [
        callArityDiagnostic(
          target.reference,
          target.reference.parameters.length,
          argumentsResult.facts.length,
          Location.at(node.anchor),
        ),
      ],
    }
  }
  const substitution = new Map<string, Type.GenericArgument>()
  const inferenceDiagnostics: Array<Diagnostic.Located> = []
  const providerKey = Type.key(target.interface.self)
  const providerBinders = new Set([providerKey])
  let providerOrigin: Location.Location | undefined
  for (const [ordinal, argument] of argumentsResult.facts.entries()) {
    const expected = target.reference.parameters.at(ordinal)
    if (expected === undefined || argument.type._tag !== 'Available') continue
    // Only operands containing Self select the provider. The completed call checks every operand
    // after opening its invocation lifetimes; comparing unrelated operands here treats those
    // quantified lifetimes as fixed and can reject a valid shorter call borrow.
    if (!Type.parameters(expected).some((parameter) => Type.key(parameter) === providerKey))
      continue
    const previousProvider = substitution.get(providerKey)
    const inference = TypeInference.inferOpenGenericArguments(
      expected,
      argument.type.type,
      substitution,
      providerBinders,
    )
    if (!inference.matches) {
      const providerConflict = inference.conflicts.find((conflict) =>
        Type.equals(conflict.parameter, target.interface.self),
      )
      inferenceDiagnostics.push(
        providerConflict === undefined
          ? Diagnostic.argumentTypeMismatch(
              Type.encode(expected),
              Type.encode(argument.type.type),
              Location.at(argument.anchor),
            )
          : Diagnostic.typeArgumentConflict(
              target.reference.spelling,
              'Self',
              Type.encodeGenericArgument(providerConflict.previous),
              Type.encodeGenericArgument(providerConflict.conflicting),
              Location.at(argument.anchor),
              providerOrigin,
            ),
      )
    } else if (previousProvider === undefined && substitution.has(providerKey)) {
      providerOrigin = Location.at(argument.anchor)
    }
  }
  if (inferenceDiagnostics.length > 0) return { diagnostics: inferenceDiagnostics }
  const inferredProvider = substitution.get(Type.key(target.interface.self))
  let provider: Type.Type | undefined =
    inferredProvider !== undefined && Type.isTypeArgument(inferredProvider)
      ? inferredProvider
      : undefined
  if (provider === undefined) {
    const fallback = fallbackAppliedInterfaceProviders(
      caller,
      target.capability,
      target.reference.operation,
    )
    if (fallback.length > 1) {
      return {
        diagnostics: [
          Diagnostic.ambiguousBoundOperation(
            target.reference.spelling,
            fallback.map(Type.encode),
            Location.at(target.reference.anchor),
          ),
        ],
      }
    }
    provider = fallback.at(0)
  }
  if (provider === undefined) {
    return {
      diagnostics: [
        Diagnostic.uninferredTypeParameter(
          target.reference.spelling,
          'Self',
          Location.at(target.reference.anchor),
        ),
      ],
    }
  }
  const proof = ConformanceProof.prove(resolution.index, provider, target.capability)
  if (!hasAppliedInterfaceBound(caller, provider, target.capability) && proof._tag !== 'Proved') {
    return {
      diagnostics: [
        Diagnostic.unprovenConformance(
          `${Type.encode(provider)}: ${Type.encode(target.capability)}`,
          'no coherent conformance satisfies the applied interface operation',
          [],
          Location.at(target.reference.anchor),
        ),
      ],
    }
  }
  const application = DeclarationFacts.interfaceApplication(
    target.interface,
    target.capability,
    provider,
  )
  const operation = application?.operations.find(
    (candidate) =>
      candidate.declaration.name._tag === 'Present' &&
      candidate.declaration.name.spelling === target.reference.operation,
  )
  const contract = operation === undefined ? undefined : interfaceOperationContract(operation)
  if (application?.available !== true || operation === undefined || contract === undefined) {
    return {
      diagnostics: [
        Diagnostic.unprovenConformance(
          `${Type.encode(provider)}: ${Type.encode(target.capability)}`,
          'the selected interface application has no complete operation contract',
          [],
          Location.at(target.reference.anchor),
        ),
      ],
    }
  }
  return {
    reference: {
      ...target.reference,
      provider,
      declaration: contract.declaration,
      interfaceContract: contract.contract,
      parameters: contract.parameters,
      result: contract.result,
    },
  }
}

const finishAppliedInterfaceOperation = (
  context: SemanticContext.SemanticContext,
  node: AuthoredHir.Expression,
  target: AppliedInterfaceOperationTarget,
  argumentsResult: ArgumentsResult,
  callTypeArguments: CallTypeArgumentsResult,
  caller: DeclarationFact,
  resolution: ResolutionContext,
): ExpressionResult => {
  if (target._tag === 'Invalid')
    return {
      fact: unavailableExpression(node.anchor),
      diagnostics: Diagnostic.collect(target.diagnostics, argumentsResult.diagnostics),
      type: undefined,
    }
  const provider = resolveAppliedInterfaceProvider(
    context,
    node,
    target,
    argumentsResult,
    caller,
    resolution,
  )
  if ('diagnostics' in provider)
    return {
      fact: unavailableExpression(node.anchor),
      diagnostics: Diagnostic.collect(
        target.diagnostics,
        argumentsResult.diagnostics,
        callTypeArguments.diagnostics,
        provider.diagnostics,
      ),
      type: undefined,
    }
  const completed = finishInterfaceOperationCall(
    context,
    node,
    provider.reference,
    argumentsResult,
    callTypeArguments,
    resolution,
    node,
    target.application,
  )
  return {
    ...completed,
    diagnostics: Diagnostic.collect(target.diagnostics, completed.diagnostics),
  }
}

export const analyzePipelineExpression = (
  context: SemanticContext.SemanticContext,
  node: Extract<AuthoredHir.Expression, { readonly _tag: 'PipelineExpression' }>,
  declarations: ReadonlyArray<DeclarationFact>,
  declaration: DeclarationFact,
  scope: Scope,
  resolution: ResolutionContext,
): ExpressionResult => {
  const inputNode = node.input
  const target = node.target
  const appliedTarget =
    target === undefined
      ? undefined
      : resolveAppliedInterfaceOperationTarget(context, target, declaration, resolution)
  if (appliedTarget !== undefined) {
    const input =
      inputNode === undefined
        ? undefined
        : analyzeExpression(
            context,
            inputNode,
            declarations,
            declaration,
            scope,
            resolution,
            appliedTarget._tag === 'Resolved'
              ? instantiateInterfaceReference(
                  appliedTarget.reference,
                  node,
                  resolution,
                ).parameters.at(0)
              : undefined,
          )
    const inputResult =
      input ??
      unavailableExpressionResult(context, (inputNode ?? node).anchor, declaration, resolution)
    return finishAppliedInterfaceOperation(
      context,
      node,
      appliedTarget,
      {
        facts: [argumentFact(declaration, context, node.anchor, inputResult, 0)],
        diagnostics: input?.diagnostics ?? [],
      },
      { explicit: false, facts: [], diagnostics: [] },
      declaration,
      resolution,
    )
  }
  const callable =
    target === undefined
      ? undefined
      : analyzeExpression(context, target, declarations, declaration, scope, resolution)
  const expectedInput =
    callable?.type !== undefined && Type.isCallable(callable.type)
      ? callable.type.parameters.at(0)
      : undefined
  const input =
    inputNode === undefined
      ? undefined
      : analyzeExpression(
          context,
          inputNode,
          declarations,
          declaration,
          scope,
          resolution,
          expectedInput,
        )
  const inputResult =
    input ??
    unavailableExpressionResult(context, (inputNode ?? node).anchor, declaration, resolution)
  const callableResult =
    callable ??
    unavailableExpressionResult(context, (target ?? node).anchor, declaration, resolution)
  return finishCallableApplication(
    context,
    node,
    callableResult,
    {
      facts: [argumentFact(declaration, context, node.anchor, inputResult, 0)],
      diagnostics: input?.diagnostics ?? [],
    },
    {
      explicit: false,
      facts: [],
      diagnostics: [],
    },
    {
      _tag: 'PipelineCallableApplication',
      left: expressionNode(inputResult),
      callable: expressionNode(callableResult),
      evaluation: 'LeftThenCallable',
    },
    resolution,
    declaration,
  )
}

export const effectExpressionAccess = (
  expression: ExpressionDecision | Tir.Expression,
  index: DeclarationIndex.Index | undefined,
  assumptions: ReadonlySet<string> = new Set(),
): Type.Effect['access'] => {
  if (expression._tag === 'Move') {
    const subjectType = constructionExpressionType(expression.subject)
    if (subjectType._tag === 'Available' && Type.isEffect(subjectType.type))
      return subjectType.type.access
    if (subjectType._tag === 'Available' && Type.isCallable(subjectType.type))
      return subjectType.type.mode
    if (
      subjectType._tag === 'Available' &&
      index !== undefined &&
      ConformanceProof.copyType(index, subjectType.type, assumptions)
    )
      return 'Shared'
    return 'Take'
  }
  if (expression._tag === 'Borrow')
    return expression.access === 'Exclusive' ? 'Exclusive' : 'Shared'
  if (expression._tag === 'ValueBorrow' || expression._tag === 'SliceBorrow')
    return expression.access === 'Exclusive' ? 'Exclusive' : 'Shared'
  if (expression._tag === 'CallableSection') return expression.mode
  const type = constructionExpressionType(expression)
  if (type._tag === 'Available' && Type.isEffect(type.type)) return type.type.access
  if (type._tag === 'Available' && Type.isCallable(type.type)) return type.type.mode
  // An owned affine value (a fresh temporary or a call result) enters the environment by
  // ownership whether or not the context spelled `move`, so running consumes it.
  if (
    type._tag === 'Available' &&
    index !== undefined &&
    !Type.isReference(type.type) &&
    !Type.isSlice(type.type) &&
    !ConformanceProof.copyType(index, type.type, assumptions)
  )
    return 'Take'
  return 'Shared'
}

export const effectCaptureAccess = (
  arguments_: ReadonlyArray<ArgumentFact>,
  index: DeclarationIndex.Index | undefined,
  assumptions: ReadonlySet<string> = new Set(),
): Type.Effect['access'] => {
  const accesses = arguments_.map((argument) =>
    effectExpressionAccess(argument.expression, index, assumptions),
  )
  return strongestEffectAccess(...accesses)
}

export const intrinsicEffectCaptureAccess = (
  operation: Intrinsic.Operation,
  arguments_: ReadonlyArray<ArgumentFact>,
  index: DeclarationIndex.Index,
  assumptions: ReadonlySet<string> = new Set(),
): Type.Effect['access'] => {
  if (
    operation.rule._tag !== 'ContractRule' ||
    operation.rule.post !== 'BindRequirement' ||
    operation.rule.providerMode !== 'Take'
  )
    return effectCaptureAccess(arguments_, index, assumptions)
  const accesses = arguments_.map((argument, ordinal) =>
    ordinal === 1
      ? ownedProviderCaptureAccess(argument.expression, index, assumptions)
      : effectExpressionAccess(argument.expression, index, assumptions),
  )
  return strongestEffectAccess(...accesses.flatMap((access) => (access === 'Copy' ? [] : [access])))
}

export const strongestEffectAccess = (
  ...accesses: ReadonlyArray<Type.Effect['access']>
): Type.Effect['access'] => {
  if (accesses.includes('Take')) {
    return 'Take'
  }
  if (accesses.includes('Exclusive')) {
    return 'Exclusive'
  }
  return 'Shared'
}

export const intrinsicOperationTarget = (
  context: SemanticContext.SemanticContext,
  node: AuthoredHir.Expression,
): Intrinsic.Operation | undefined => {
  const identifiers = referenceNames(node)
  const qualifier = identifiers.at(0)
  const member = identifiers.at(1)
  return qualifier === undefined || member === undefined
    ? undefined
    : Intrinsic.findOperation(
        SemanticContext.nameText(context, qualifier) ?? '',
        SemanticContext.nameText(context, member) ?? '',
      )
}

export const intrinsicReference = (
  context: SemanticContext.SemanticContext,
  node: AuthoredHir.Expression,
): IntrinsicReferenceFact => {
  const identifiers = referenceNames(node)
  const actorToken = identifiers.at(0)
  const operationToken = identifiers.at(1)
  const actor =
    actorToken === undefined
      ? undefined
      : Intrinsic.findActor(SemanticContext.nameText(context, actorToken) ?? '')
  const operation =
    actor === undefined || operationToken === undefined
      ? undefined
      : Intrinsic.findOperation(
          actor.spelling,
          SemanticContext.nameText(context, operationToken) ?? '',
        )
  return actorToken === undefined ||
    operationToken === undefined ||
    actor === undefined ||
    operation === undefined
    ? { _tag: 'UnavailableIntrinsicReference', anchor: node.anchor }
    : {
        _tag: 'ResolvedIntrinsicReference',
        actor,
        operation,
        actorAnchor: actorToken.anchor,
        operationAnchor: operationToken.anchor,
      }
}

/** Finalizes ordinary lexical captures for one context Effect body. */
export const effectCaptureFacts = (
  context: SemanticContext.SemanticContext,
  statements: ReadonlyArray<Tir.Statement>,
  firstLocalBinding: number,
  index?: DeclarationIndex.Index,
  assumptions: ReadonlySet<string> = new Set(),
  options: {
    readonly localFunction?: DeclarationId
    readonly order?: 'Reference' | 'FirstUse'
    readonly builder?: BodyBuilder.BodyBuilder
  } = {},
): ReadonlyArray<EffectCaptureFact> => {
  const captures = new Map<string, EffectCaptureFact>()
  const patternKey = (id: Match.BindingId): string =>
    `${Tir.nodeRefKey(id.arm.match.node)}:${id.arm.ordinal}:${id.ordinal}`
  const localPatterns = new Set<string>()
  const recordLocalPattern = (local: Tir.LocalId): void => {
    if (options.builder === undefined) return
    const semantic = BodyBuilder.semanticOfLocal(options.builder, local)
    if (isCaptureReferenceFact(semantic) && semantic._tag === 'PatternBinding')
      localPatterns.add(patternKey(semantic.id))
  }
  visitStatements(statements, {
    descendEffectBlocks: false,
    expression: (fact) => {
      if (fact._tag === 'Match')
        for (const arm of fact.arms)
          for (const binding of arm.bindings) localPatterns.add(patternKey(binding.id))
    },
    node: (node) => {
      if (node._tag !== 'Match' || options.builder === undefined) return
      for (const arm of node.arms) {
        for (const binding of arm.bindings) {
          const semantic = BodyBuilder.semanticOfLocal(options.builder, binding.id)
          if (isCaptureReferenceFact(semantic) && semantic._tag === 'PatternBinding')
            localPatterns.add(patternKey(semantic.id))
        }
      }
    },
    statement: (statement) => {
      if (
        (statement._tag === 'PatternBind' || statement._tag === 'IfLet') &&
        options.builder !== undefined
      )
        for (const binding of statement.selection.bindings) {
          const semantic = BodyBuilder.semanticOfLocal(options.builder, binding.id)
          if (isCaptureReferenceFact(semantic) && semantic._tag === 'PatternBinding')
            localPatterns.add(patternKey(semantic.id))
        }
    },
  })
  const rank = (access: EffectCaptureFact['access']): number => {
    if (access === 'Take') {
      return 3
    }
    if (access === 'Exclusive') {
      return 2
    }
    if (access === 'Shared') {
      return 1
    }
    return 0
  }
  const recordReference = (
    reference: EffectCaptureFact['reference'] | undefined,
    requested: EffectCaptureFact['access'],
    anchor: AuthoredHir.Anchor,
    copy: boolean,
    expression?: Tir.Expression,
  ): void => {
    if (reference === undefined) return
    if (reference._tag === 'PatternBinding') {
      if (localPatterns.has(patternKey(reference.id))) return
    } else if (reference.phase === 'Static') return
    if (
      reference._tag === 'BindingFact' &&
      reference.id.ordinal >= firstLocalBinding &&
      (options.localFunction === undefined ||
        (reference.id.function.sourceId === options.localFunction.sourceId &&
          reference.id.function.ordinal === options.localFunction.ordinal))
    )
      return
    if (
      reference._tag === 'ParameterDeclaration' &&
      options.localFunction !== undefined &&
      reference.id.function.sourceId === options.localFunction.sourceId &&
      reference.id.function.ordinal === options.localFunction.ordinal
    )
      return
    const key =
      reference._tag === 'PatternBinding'
        ? `Pattern:${patternKey(reference.id)}`
        : `${reference._tag}:${reference.id.function.sourceId}:${reference.id.function.ordinal}:${reference.id.ordinal}`
    const access = requested !== 'Exclusive' && copy ? 'Copy' : requested
    const prior = captures.get(key)
    if (prior === undefined)
      captures.set(key, {
        _tag: 'EffectCapture',
        reference,
        access,
        span: context.spanOf(anchor),
        anchor,
        ...(expression === undefined ? {} : { expression }),
      })
    else if (rank(access) > rank(prior.access))
      captures.set(key, {
        ...prior,
        access,
        ...(options.order === 'FirstUse' ? {} : { span: context.spanOf(anchor), anchor }),
      })
  }
  const record = (
    fact: IdentifierExpressionDecision,
    requested: EffectCaptureFact['access'],
  ): void => {
    let reference: EffectCaptureFact['reference'] | undefined
    if (fact.reference._tag === 'ResolvedBinding') {
      reference = fact.reference.binding
    } else if (fact.reference._tag === 'Resolved') {
      reference = fact.reference.parameter
    } else if (fact.reference._tag === 'ResolvedPattern') {
      reference = fact.reference.binding
    } else {
      reference = undefined
    }
    // A shared callable or Effect value duplicates freely (CALLABLE-002 / EFFECT-OWN-002), so a
    // body reading one captures a copy rather than a loan on the outer binding.
    const copy =
      fact.type._tag === 'Available' &&
      !Type.containsViewBorrow(fact.type.type) &&
      ((Type.isCallable(fact.type.type) && fact.type.type.mode === 'Shared') ||
        (Type.isEffect(fact.type.type) && fact.type.type.access === 'Shared') ||
        (index === undefined
          ? typeof fact.type.type === 'string'
          : ConformanceProof.copyType(index, fact.type.type, assumptions)))
    recordReference(reference, requested, fact.anchor, copy, options.builder?.expressions.get(fact))
  }
  const consumingAccess = (
    fact: ExpressionDecision | Tir.Expression,
  ): EffectCaptureFact['access'] => {
    const expressionType = constructionExpressionType(fact)
    if (expressionType._tag !== 'Available') return 'Shared'
    const type = expressionType.type
    if (Type.containsViewBorrow(type)) return 'Shared'
    const copy =
      index === undefined
        ? typeof type === 'string'
        : ConformanceProof.copyType(index, type, assumptions)
    return copy ? 'Shared' : 'Take'
  }
  const expression = (
    fact: ExpressionDecision | Tir.Expression,
    requested: EffectCaptureFact['access'] = 'Shared',
  ): void => {
    if ('origin' in fact) {
      const anchor = fact.origin.anchor
      if (
        fact._tag === 'BindingReference' ||
        fact._tag === 'ParameterReference' ||
        fact._tag === 'PatternBindingReference'
      ) {
        const local = fact._tag === 'ParameterReference' ? fact.parameter : fact.binding
        const semantic =
          options.builder === undefined
            ? undefined
            : BodyBuilder.semanticOfLocal(options.builder, local)
        const reference = isCaptureReferenceFact(semantic) ? semantic : undefined
        const type = constructionExpressionType(fact)
        const copy =
          type._tag === 'Available' &&
          !Type.containsViewBorrow(type.type) &&
          ((Type.isCallable(type.type) && type.type.mode === 'Shared') ||
            (Type.isEffect(type.type) && type.type.access === 'Shared') ||
            (index === undefined
              ? typeof type.type === 'string'
              : ConformanceProof.copyType(index, type.type, assumptions)))
        recordReference(reference, requested, anchor, copy, fact)
        return
      }
      if (fact._tag === 'Move') {
        expression(fact.subject, 'Take')
        return
      }
      if (fact._tag === 'Replace') {
        const local =
          fact.place.root._tag === 'ParameterWriteRoot' ||
          fact.place.root._tag === 'ParameterSliceRoot'
            ? fact.place.root.parameter
            : fact.place.root.binding
        const semantic =
          options.builder === undefined
            ? undefined
            : BodyBuilder.semanticOfLocal(options.builder, local)
        recordReference(
          isCaptureReferenceFact(semantic) ? semantic : undefined,
          'Exclusive',
          fact.place.origin.anchor,
          false,
        )
        for (const selector of fact.place.selectors)
          if (selector._tag === 'Index' || selector._tag === 'SliceIndex')
            expression(selector.index)
        expression(fact.value)
        return
      }
      if (fact._tag === 'ValueBorrow' || fact._tag === 'SliceBorrow') {
        let local: Tir.LocalId | undefined
        if (fact.root._tag === 'BindingSliceRoot') local = fact.root.binding
        else if (fact.root._tag === 'ParameterSliceRoot') local = fact.root.parameter
        else if (fact.root._tag === 'PatternSliceRoot') local = fact.root.binding
        const semantic =
          local === undefined || options.builder === undefined
            ? undefined
            : BodyBuilder.semanticOfLocal(options.builder, local)
        const reference = isCaptureReferenceFact(semantic) ? semantic : undefined
        recordReference(
          reference,
          fact.access === 'Exclusive' ? 'Exclusive' : 'Shared',
          anchor,
          false,
        )
      }
      if (fact._tag === 'EffectBlock') {
        for (const capture of fact.captures) {
          const local = capture.binding ?? capture.parameter ?? capture.pattern
          const semantic =
            local === undefined || options.builder === undefined
              ? undefined
              : BodyBuilder.semanticOfLocal(options.builder, local)
          const reference = isCaptureReferenceFact(semantic) ? semantic : undefined
          recordReference(reference, capture.access, capture.use ?? capture.at ?? anchor, false)
        }
        return
      }
      if (fact._tag === 'Match') {
        expression(fact.scrutinee, requested)
        for (const arm of fact.arms) {
          for (const binding of arm.bindings) recordLocalPattern(binding.id)
          if (arm.guard !== undefined) expression(arm.guard)
          if (arm.body._tag === 'Expression') expression(arm.body.expression)
          else visit(arm.body.statements)
        }
        return
      }
      if (fact._tag === 'CallableApply' && fact.staged === undefined) {
        // Invoking an outer callable acquires the environment access its mode requires
        // (ANON-OWN-001): a `once fn` call transfers ownership, a `mut fn` call borrows exclusively.
        for (const child of Tir.expressionChildren(fact))
          expression(child, child === fact.callee ? fact.access : 'Shared')
        return
      }
      for (const child of Tir.expressionChildren(fact)) expression(child)
      return
    }
    switch (fact._tag) {
      case 'Identifier':
        record(fact, requested)
        return
      case 'Move':
        expression(fact.subject, 'Take')
        return
      case 'Borrow':
        expression(fact.subject, fact.access === 'Exclusive' ? 'Exclusive' : 'Shared')
        return
      case 'FieldProjection':
        if (fact.staticValue === undefined) expression(fact.subject, requested)
        return
      case 'IndexProjection':
        expression(fact.subject, requested)
        expression(fact.index)
        return
      case 'StructLiteral':
      case 'UnionVariant':
        for (const item of fact.initializers) expression(item.expression)
        return
      case 'ArrayLiteral':
        for (const item of fact.elements) expression(item.expression)
        return
      case 'Match':
        expression(fact.scrutinee, requested)
        for (const arm of fact.arms) {
          for (const binding of arm.bindings) localPatterns.add(patternKey(binding.id))
          if (arm.guard !== undefined) expression(arm.guard)
          if (arm.body._tag === 'Expression') expression(arm.body.expression)
          else visit(arm.body.statements)
        }
        return
      case 'Operator':
      case 'ShortCircuit':
      case 'Call':
        for (const argument of fact.arguments) expression(argument.expression)
        return
      case 'FunctionItem':
        return
      case 'CallableSection':
        for (const capture of fact.captures) expression(capture.expression)
        return
      case 'ForeignApply':
      case 'CallableApply':
        expression(fact.callee)
        for (const argument of fact.arguments) expression(argument.expression)
        return
      case 'PlaceReplace':
        expression(fact.destination, 'Exclusive')
        expression(fact.value)
        return
      case 'Run':
        expression(fact.subject)
        return
      case 'EffectCatch':
        expression(fact.protected)
        expression(fact.handler)
        return
      case 'EffectBindRequirement':
        expression(fact.protected)
        recordReference(
          fact.provider?.reference,
          fact.provider?.captureAccess ?? 'Shared',
          fact.anchor,
          false,
        )
        return
      case 'EffectBlock':
        // Constructing a nested deferred Effect still reads the environment needed to create
        // that Effect value. Bubble those dependencies into the enclosing Effect runner so a
        // parameter used only by the nested body remains available when the child is formed.
        for (const capture of fact.captures)
          recordReference(
            capture.reference,
            capture.access,
            capture.anchor,
            false,
            capture.expression,
          )
        return
      case 'EnumValue':
        expression(fact.argument)
        return
      case 'CompileError':
        expression(fact.message)
        return
      case 'ReferentProjection':
        expression(fact.subject)
        return
      case 'Integer':
      case 'Duration':
      case 'Floating':
      case 'Boolean':
      case 'Character':
      case 'Constant':
      case 'ForeignStatic':
      case 'StaticText':
      case 'Unit':
      case 'EnumMember':
        return
      default:
        // Exhaustive so a new expression fact kind cannot silently skip capture registration.
        fact satisfies never
        return
    }
  }
  const visit = (items: ReadonlyArray<Tir.Statement>): void => {
    for (const statement of items) {
      switch (statement._tag) {
        case 'Unsafe':
          visit(statement.statements)
          break
        case 'Bind':
          expression(statement.initializer)
          break
        case 'PatternBind':
          for (const binding of statement.selection.bindings) recordLocalPattern(binding.id)
          expression(statement.selection.subject)
          break
        case 'Evaluate':
          expression(statement.expression)
          break
        case 'If':
          expression(statement.condition)
          visit(statement.taken)
          visit(statement.otherwise)
          break
        case 'IfLet':
          for (const binding of statement.selection.bindings) recordLocalPattern(binding.id)
          expression(statement.selection.subject)
          visit(statement.taken)
          visit(statement.otherwise)
          break
        case 'Write':
          if (statement.destination !== undefined) expression(statement.destination, 'Exclusive')
          expression(statement.value)
          break
        case 'While':
          expression(statement.condition)
          visit(statement.body)
          break
        case 'Return':
        case 'Fail':
        case 'Drop':
          // An owned affine operand leaves with the outcome or is cleaned here, so its capture is
          // consumed; a Copy value or a borrowed view is only read through its capture.
          expression(statement.expression, consumingAccess(statement.expression))
          break
        case 'Break':
        case 'Continue':
        case 'UnavailableStatement':
          break
      }
    }
  }
  visit(statements)
  const values = [...captures.values()]
  return options.order === 'FirstUse'
    ? values
    : values.sort(
        (left, right) =>
          left.reference.id.ordinal - right.reference.id.ordinal ||
          left.span.start - right.span.start,
      )
}

const anonymousCaptureMode = (captures: ReadonlyArray<AnonymousCaptureFact>): Type.CallableMode => {
  if (captures.some((capture) => capture.access === 'Take')) return 'Take'
  if (captures.some((capture) => capture.access === 'Exclusive')) return 'Exclusive'
  return 'Shared'
}

const anonymousCapturedType = (
  capture: Pick<AnonymousCaptureFact, 'reference'>,
): Type.Type | undefined => {
  if (capture.reference._tag === 'BindingFact')
    return capture.reference.inferredType._tag === 'Available'
      ? capture.reference.inferredType.type
      : undefined
  if (capture.reference._tag === 'PatternBinding')
    return capture.reference.type._tag === 'Available' ? capture.reference.type.type : undefined
  return capture.reference.declaredType._tag === 'Resolved'
    ? capture.reference.declaredType.type
    : undefined
}

const anonymousOuterScope = (authored: ReadonlyArray<ParameterFact>, outer: Scope): Scope => {
  const shadowed = new Set(
    authored.flatMap((parameter) =>
      parameter.name._tag === 'Present' ? [parameter.name.spelling] : [],
    ),
  )
  const visible = <A extends { readonly name: DeclaredName }>(values: ReadonlyArray<A>) =>
    values.filter((value) => value.name._tag !== 'Present' || !shadowed.has(value.name.spelling))
  return {
    parameters: [...visible(outer.parameters), ...authored],
    bindings: visible(outer.bindings),
    patternBindings: visible(outer.patternBindings),
  }
}

const analyzeAnonymousCallable = (
  context: SemanticContext.SemanticContext,
  node: Extract<AuthoredHir.Expression, { readonly _tag: 'CallableExpression' }>,
  declarations: ReadonlyArray<DeclarationFact>,
  declaration: DeclarationFact,
  scope: Scope,
  resolution: ResolutionContext,
): ExpressionResult => {
  if ((resolution.anonymousDepth ?? 0) > 0) {
    const diagnostic = Diagnostic.nestedAnonymousCallable(Location.at(node.anchor))
    return {
      fact: {
        _tag: 'CallableSection',
        site: executableSite('CallableSiteId', resolution, node),
        reference: {
          _tag: 'Unavailable',
          anchor: node.anchor,
        },
        path: referencePath(context, node),
        remainingParameters: [],
        captures: [],
        retainedDependencies: [],
        typeArguments: [],
        substitution: new Map(),
        mode: 'Shared',
        type: unavailableExpressionType,
        anchor: node.anchor,
        anonymous: {
          functionKind:
            node._tag === 'CallableExpression' && node.contract.effect ? 'Effect' : 'Ordinary',
          captures: [],
        },
      },
      diagnostics: [diagnostic],
      type: undefined,
    }
  }
  const owner = resolution.executableOwner
  const function_ = resolution.executableFunction
  const site = executableSite('CallableSiteId', resolution, node)
  if (owner === undefined || function_ === undefined) {
    return {
      fact: {
        _tag: 'CallableSection',
        site,
        reference: {
          _tag: 'Unavailable',
          anchor: node.anchor,
        },
        path: referencePath(context, node),
        remainingParameters: [],
        captures: [],
        retainedDependencies: [],
        typeArguments: [],
        substitution: new Map(),
        mode: 'Shared',
        type: unavailableExpressionType,
        anchor: node.anchor,
        anonymous: {
          functionKind:
            node._tag === 'CallableExpression' && node.contract.effect ? 'Effect' : 'Ordinary',
          captures: [],
        },
      },
      diagnostics: [],
      type: undefined,
    }
  }
  const authoredOrdinal = resolution.executableSiteOrdinals?.get(
    AuthoredIdentity.anchorKey(node.anchor),
  )
  if (authoredOrdinal === undefined)
    throw new RangeError('anonymous callable analysis lost its authored traversal ordinal')
  const hiddenId: DeclarationId = {
    _tag: 'DeclarationId',
    sourceId: AuthoredWalk.moduleName(context),
    ordinal: Tir.hiddenDeclarationOrdinal(declaration.id.ordinal, authoredOrdinal),
  }
  const canonical = Tir.anonymousCallableId(owner, authoredOrdinal)
  const initial = DeclarationCollection.collectAnonymousCallableDeclaration(
    context,
    node,
    hiddenId,
    canonical,
    declaration.typeParameters,
  )
  const nameResolution: NameResolution.Resolution = {
    _tag: 'NameResolution',
    modules: [resolution.scope],
    contexts: SemanticContext.registry([context]),
    diagnostics: [],
  }
  const resolvers = NameResolution.makeResolvers(nameResolution, resolution.index)
  const finalized = DeclarationCollection.finalizeLifetimeHeader(
    context,
    initial.fact,
    (path) => {
      const resolved = resolvers.type(AuthoredWalk.moduleName(context), path)
      if (
        resolved.fact._tag !== 'Resolved' ||
        !Type.isNominal(resolved.fact.type) ||
        resolved.fact.type.arguments.length > 0
      )
        return undefined
      return (
        DeclarationResolution.memberByNominal(
          resolution.index.modules,
          resolved.fact.type,
        )?.typeParameters.map((parameter) => parameter.type) ??
        Type.intrinsicNominalParameters(resolved.fact.type)
      )
    },
    undefined,
    node._tag === 'CallableExpression'
      ? DeclarationCollection.anonymousDeclaration(node)
      : undefined,
  )
  const collected = {
    ...initial,
    fact: finalized._tag === 'FunctionDeclaration' ? finalized : initial.fact,
  }
  const resolveType = (fact: DeclarationFacts.DeclaredTypeFact) =>
    DeclarationResolution.resolveTypeFact(
      context.spanOf,
      resolution.index,
      AuthoredWalk.moduleName(context),
      fact,
      resolvers.type,
    )
  const typeDiagnostics: Array<Diagnostic.Located> = []
  const authoredParameters = collected.fact.parameters.map((parameter) => {
    const resolved = resolveType(parameter.declaredType)
    typeDiagnostics.push(...resolved.diagnostics)
    return { ...parameter, declaredType: resolved.fact }
  })
  const returnType = resolveType(collected.fact.returnType)
  typeDiagnostics.push(...returnType.diagnostics)
  const failureRow = DeclarationResolution.resolveFailureRow(
    context.spanOf,
    AuthoredWalk.moduleName(context),
    collected.fact.failureRow,
    resolvers,
    resolution.index.modules,
  )
  const requirementRow = DeclarationResolution.resolveRequirementRow(
    context.spanOf,
    AuthoredWalk.moduleName(context),
    collected.fact.requirementRow,
    resolvers,
    resolution.index.modules,
  )
  typeDiagnostics.push(...failureRow.diagnostics, ...requirementRow.diagnostics)
  const preliminaryDeclaration: DeclarationFact = {
    ...collected.fact,
    parameters: authoredParameters,
    parameterCount: authoredParameters.length,
    returnType: returnType.fact,
    failureRow: failureRow.fact,
    requirementRow: requirementRow.fact,
    // Anonymous callables are analyzed inside the enclosing generic declaration, so its
    // compile-time constraint evidence remains lexically available to their hidden bodies.
    constraints: declaration.constraints,
    constraintContracts: declaration.constraintContracts,
  }
  const { hiddenFunctions: _hiddenFunctions, ...preliminaryResolution } = resolution
  const anonymousBuilder = (owner: AuthoredIdentity.Identity): BodyBuilder.BodyBuilder =>
    BodyBuilder.make({
      owner,
      request: { _tag: 'Check' },
      ...(resolution.builder === undefined ? {} : { parent: resolution.builder.artifact }),
    })
  const preliminary = analyzeFunctionBody(
    context,
    preliminaryDeclaration,
    declarations,
    {
      ...preliminaryResolution,
      builder: anonymousBuilder(preliminaryDeclaration.owner),
      anonymousDepth: 1,
    },
    undefined,
    anonymousOuterScope(authoredParameters, scope),
  )
  const firstLocalBinding = 0
  const ordinaryCaptures = effectCaptureFacts(
    context,
    preliminary.fact.statements,
    firstLocalBinding,
    resolution.index,
    copyAssumptionsOf(declaration),
    {
      localFunction: hiddenId,
      order: 'FirstUse',
      builder: preliminary.builder,
    },
  )
  const captures = ordinaryCaptures
    .map((capture): AnonymousCaptureFact => ({
      _tag: 'AnonymousCapture',
      reference: capture.reference,
      access: capture.access,
      span: capture.span,
      anchor: capture.anchor,
    }))
    .filter(
      (capture) =>
        anonymousCapturedType(capture) !== undefined && capture.reference.name._tag === 'Present',
    )
    .sort((left, right) => left.span.start - right.span.start)
  const captureParameters = captures.map((capture, ordinal): ParameterFact => {
    const type = anonymousCapturedType(capture)
    if (type === undefined) throw new RangeError('Anonymous capture lost its resolved type')
    const name: DeclaredName = capture.reference.name
    return {
      _tag: 'ParameterDeclaration',
      id: {
        _tag: 'ParameterId',
        function: hiddenId,
        ordinal: authoredParameters.length + ordinal,
      },
      name,
      phase: 'Runtime',
      bindingMutability: capture.access === 'Exclusive' ? 'Mutable' : 'Immutable',
      captureAccess: capture.access,
      declaredType: {
        _tag: 'Resolved',
        type,
        spelling: Type.encode(type),
        anchor: capture.reference.anchor,
      },
      anchor: capture.reference.anchor,
    }
  })
  const lifetimes = BodyLifetime.environment(
    resolution.bodyLifetimes,
    node.anchor,
    captures.flatMap((capture) => {
      const type = anonymousCapturedType(capture)
      return type === undefined ? [] : [type]
    }),
    captures
      .filter((capture) => capture.access === 'Shared' || capture.access === 'Exclusive')
      .map((capture) => capture.anchor),
  )
  const hiddenDeclaration: DeclarationFact = {
    ...preliminaryDeclaration,
    parameters: [...authoredParameters, ...captureParameters],
    parameterCount: authoredParameters.length + captureParameters.length,
    ...(preliminaryDeclaration.lifetimeElaboration === undefined || lifetimes === undefined
      ? {}
      : {
          lifetimeElaboration: {
            ...preliminaryDeclaration.lifetimeElaboration,
            // All retained inputs are known after capture discovery. Their common validity is a
            // meet, while executableLifetimes continues to carry generic content obligations.
            explicitEnvironment:
              preliminaryDeclaration.lifetimeElaboration.explicitEnvironment ??
              Lifetime.intersection([
                lifetimes.environment,
                ...authoredParameters.flatMap((parameter) =>
                  parameter.declaredType._tag === 'Resolved'
                    ? Type.storageLifetimes(parameter.declaredType.type)
                    : [],
                ),
              ]),
          },
        }),
  }
  const hidden = analyzeFunctionBody(
    context,
    hiddenDeclaration,
    declarations,
    {
      ...preliminaryResolution,
      builder: anonymousBuilder(hiddenDeclaration.owner),
      anonymousDepth: 1,
    },
    undefined,
    anonymousOuterScope(hiddenDeclaration.parameters, scope),
  )
  resolution.hiddenFunctions?.push(hidden)
  const mode = anonymousCaptureMode(captures)
  let result: Type.Type | undefined =
    hiddenDeclaration.returnType._tag === 'Resolved' ? hiddenDeclaration.returnType.type : undefined
  if (result !== undefined && hiddenDeclaration.functionKind === 'Effect') {
    const effectCaptures = effectCaptureFacts(
      context,
      hidden.fact.statements,
      0,
      resolution.index,
      copyAssumptionsOf(hiddenDeclaration),
      { builder: hidden.builder },
    )
    result = Type.effectWithRows(
      result,
      hiddenDeclaration.failureRow.row,
      { ...DeclarationFacts.executableLifetimes(hiddenDeclaration), lifetimeBinders: [] },
      strongestEffectAccess(
        ...effectCaptures.flatMap((capture) => (capture.access === 'Copy' ? [] : [capture.access])),
      ),
      hiddenDeclaration.requirementRow.row,
    )
  }
  const parameterTypes = authoredParameters.flatMap((parameter) =>
    parameter.declaredType._tag === 'Resolved' ? [parameter.declaredType.type] : [],
  )
  const complete = result !== undefined && parameterTypes.length === authoredParameters.length
  const callable =
    complete && result !== undefined && lifetimes !== undefined
      ? Type.callable(
          parameterTypes,
          result,
          {
            ...lifetimes,
            // Authored anonymous parameters quantify their own elided lifetimes. Captured outer
            // lifetimes remain free and continue to constrain the stored environment.
            lifetimeBinders: (collected.fact.lifetimeElaboration?.implicit ?? []).map((binder) =>
              Lifetime.bound(
                binder.parameter.owner,
                binder.parameter.ordinal,
                binder.parameter.name,
              ),
            ),
          },
          mode,
        )
      : undefined
  const token = node._tag === 'CallableExpression' ? node : undefined
  const reference: CallReferenceFact =
    token === undefined
      ? { _tag: 'Unavailable', anchor: node.anchor }
      : {
          _tag: 'Resolved',
          spelling: canonical.name,
          anchor: token.anchor,
          declaration: hiddenDeclaration,
        }
  const environmentOwner = executableSpecializationOwner(resolution)
  const enclosingBuilder = resolution.builder
  if (enclosingBuilder === undefined)
    throw new RangeError('anonymous callable capture requires its enclosing TIR builder')
  const enclosingCapture = (capture: AnonymousCaptureFact): Tir.Expression => {
    const type = anonymousCapturedType(capture)
    if (type === undefined) throw new RangeError('anonymous callable capture lost its type')
    const spelling =
      capture.reference.name._tag === 'Present' ? capture.reference.name.spelling : '?'
    let reference: ParameterReferenceFact
    if (capture.reference._tag === 'BindingFact')
      reference = {
        _tag: 'ResolvedBinding' as const,
        spelling,
        anchor: capture.anchor,
        binding: capture.reference,
      }
    else if (capture.reference._tag === 'PatternBinding')
      reference = {
        _tag: 'ResolvedPattern' as const,
        spelling,
        anchor: capture.anchor,
        binding: capture.reference,
      }
    else
      reference = {
        _tag: 'Resolved' as const,
        spelling,
        anchor: capture.anchor,
        parameter: capture.reference,
      }
    return BodyBuilder.node(
      enclosingBuilder,
      BodyBuilder.tirReference(
        reference,
        availableExpressionType(type),
        capture.anchor,
        context,
        enclosingBuilder,
      ),
    )
  }
  return {
    fact: {
      _tag: 'CallableSection',
      site,
      reference,
      // An anonymous callable names nothing in source: its canonical name stands in for the path.
      path:
        token === undefined
          ? referencePath(context, node)
          : {
              _tag: 'ReferencePath',
              memberSpelling: canonical.name,
              memberAnchor: token.anchor,
            },
      remainingParameters: authoredParameters.map((_, ordinal) => ordinal),
      captures: captures.map((capture, ordinal) => {
        const captured = enclosingCapture(capture)
        const capturedType = constructionExpressionType(captured)
        const expression =
          capture.access === 'Take' && capturedType._tag === 'Available'
            ? BodyBuilder.node(enclosingBuilder, {
                _tag: 'Move' as const,
                subject: captured,
                type: capturedType.type,
                span: captured.span,
                origin: Tir.synthetic(captured.origin.anchor, 'capture-move'),
              })
            : captured
        return {
          _tag: 'CallableCapture',
          ordinal,
          parameterOrdinal: authoredParameters.length + ordinal,
          expression,
          access: capture.access,
        }
      }),
      retainedDependencies: [],
      typeArguments: declaration.typeParameters.map((parameter) =>
        Type.parameterArgument(parameter.type),
      ),
      ...(environmentOwner === undefined ? {} : { environmentOwner }),
      // Reify inherited parameters in their argument namespace so the owner instance can
      // specialize captured lifetimes and representation binders like any other call site.
      substitution: new Map(
        declaration.typeParameters.map((parameter) => [
          Type.key(parameter.type),
          Type.parameterArgument(parameter.type),
        ]),
      ),
      mode,
      type: callable === undefined ? unavailableExpressionType : availableExpressionType(callable),
      anchor: node.anchor,
      anonymous: {
        functionKind: hiddenDeclaration.functionKind,
        captures: captures,
      },
    },
    diagnostics: [...collected.diagnostics, ...typeDiagnostics, ...hidden.diagnostics],
    type: callable,
  }
}

/** Ordinary arm statements must execute only with the enclosing static statement flow. */
/** A deferred body owns its own control; only an arm with a block introduces ordinary control. */
export const containsOrdinaryArm = (node: AuthoredHir.Expression): boolean => {
  if (node._tag === 'CallableExpression' || node._tag === 'EffectExpression') return false
  if (node._tag === 'MatchExpression')
    return (
      node.arms.some((arm) => arm.result._tag === 'Block') ||
      containsOrdinaryArm(node.subject) ||
      node.arms.some(
        (arm) =>
          (arm.guard !== undefined && containsOrdinaryArm(arm.guard)) ||
          (arm.result._tag !== 'Block' && containsOrdinaryArm(arm.result)),
      )
    )
  return AuthoredWalk.expressionChildren(node).some(containsOrdinaryArm)
}

function analyzeExpressionDecision(
  context: SemanticContext.SemanticContext,
  node: AuthoredHir.Expression,
  declarations: ReadonlyArray<DeclarationFact>,
  declaration: DeclarationFact,
  scope: Scope,
  resolution: ResolutionContext,
  expected?: SemanticType,
): ExpressionResult | undefined {
  // A recovery node carries no meaning to check. The parser already reported why it is damaged, so
  // analysis yields the unavailable fact rather than leaving callers with nothing to record.
  if (!AuthoredWalk.isAvailable(node)) {
    // The one damage the parser does not report: a literal that lexes but does not decode.
    const key = AuthoredIdentity.anchorKey(node.anchor)
    const undecodable = context.presentation.diagnostics.filter(
      (entry) =>
        entry.code === Diagnostic.invalidStaticLiteralCode &&
        AuthoredIdentity.anchorKey(entry.anchor) === key,
    )
    return {
      fact: unavailableExpression(node.anchor),
      diagnostics: undecodable.map((entry) =>
        Diagnostic.invalidStaticLiteral(entry.message, Location.at(node.anchor)),
      ),
      type: undefined,
    }
  }
  if (
    declaration.phase === 'Static' &&
    resolution.staticContext !== undefined &&
    resolution.deferStaticCalls !== true &&
    containsOrdinaryArm(node)
  )
    resolution = { ...resolution, deferStaticCalls: true }
  if (node._tag === 'CallableExpression')
    return analyzeAnonymousCallable(context, node, declarations, declaration, scope, resolution)
  if (node._tag === 'UnsafeExpression') {
    const call = node.operand
    if (call._tag !== 'CallExpression') return undefined
    const analyzed = analyzeExpression(
      context,
      call,
      declarations,
      declaration,
      scope,
      {
        ...resolution,
        unsafeCallSpans: [...(resolution.unsafeCallSpans ?? []), context.spanOf(call.anchor)],
      },
      expected,
    )
    if (analyzed === undefined) return undefined
    const invokesUnsafe = (() => {
      const fact = analyzed.fact
      // The resolved contract is the one the call was checked against: a bound-typed callee
      // (`F: unsafe fn(i32) -> i32`) keeps its bound's qualifier even when a specialization later
      // selects a safe implementation.
      if (fact._tag === 'ForeignApply') return true
      if (fact._tag === 'CallableApply') return fact.contract?.unsafe === true
      if (fact._tag !== 'Call') return false
      switch (fact.reference._tag) {
        case 'Resolved':
          return fact.reference.declaration.unsafe
        case 'ResolvedBuiltin':
          return fact.reference.unsafe
        case 'ResolvedIntrinsicContract':
          return fact.reference.intrinsic.unsafe
        case 'ResolvedServiceOperation':
          return fact.reference.operation.unsafe
        case 'ResolvedInterfaceOperation':
          return fact.reference.interfaceContract.unsafe
        default:
          return false
      }
    })()
    const diagnostic = invokesUnsafe
      ? undefined
      : Diagnostic.misplacedUnsafeAcknowledgement(Location.at(node.anchor))
    return {
      fact: analyzed.fact,
      diagnostics: [...analyzed.diagnostics, ...(diagnostic === undefined ? [] : [diagnostic])],
      type: diagnostic === undefined ? analyzed.type : undefined,
    }
  }
  if (node._tag === 'EffectExpression') {
    const representationOwner = executableSpecializationOwner(resolution)
    // An authored effect always owns a block, so there is no absent-body recovery fact.
    const block = node.body
    const firstLocalBinding = resolution.nextBindingOrdinal?.value ?? 0
    const inheritedCallableWrites = new Set(resolution.writtenCallableBindings)
    const effectCallableWrites = new Set(inheritedCallableWrites)
    const nested: BodyContext = {
      context,
      declaration,
      declarations,
      bindings: [],
      diagnostics: [],
      regions: [],
      loops: [],
      staticIterations: [],
      resolution: {
        ...resolution,
        writtenCallableBindings: effectCallableWrites,
      },
      nextBindingOrdinal: resolution.nextBindingOrdinal ?? { value: 0 },
      regionBase: 1_000_000 + context.spanOf(node.anchor).start * 100,
      effectBlock: true,
    }
    const statements = analyzeStatements(nested, block, scope)
    const returned = returnFlowOf(statements, false).returns.map(
      (statement) => statement.expression,
    )
    // Direct failures and executed computations belong to this boundary; nested Effects own theirs.
    const failures: Array<Type.Type> = []
    const executed: Array<Type.Effect> = []
    const recordExecuted = (expression: ExpressionDecision | Tir.Expression): void => {
      if (expression._tag !== 'Run') return
      const subjectType = constructionExpressionType(expression.subject)
      if (subjectType._tag !== 'Available') return
      const contract = Type.isRepresented(subjectType.type)
        ? subjectType.type.contract
        : subjectType.type
      if (Type.isEffect(contract)) executed.push(contract)
    }
    visitStatements(statements, {
      descendEffectBlocks: false,
      statement: (statement) => {
        if (statement._tag === 'Fail') failures.push(statement.failure)
      },
      expression: recordExecuted,
      node: recordExecuted,
    })
    // Every return site contributes to the success type through the one canonical join rule;
    // disagreeing sites are diagnosed instead of silently adopting the last return's type.
    const returnedTypes = returned.flatMap((expression) => {
      const type = constructionExpressionType(expression)
      return type._tag === 'Available' ? [type.type] : []
    })
    let success: Type.Type | undefined
    // A block whose every path ends in `fail` never produces a value: its success type is `never`
    // (EFF-007), and the recorded failures still form its failure channel.
    if (returned.length === 0 && !returnFlowOf(statements).fallsThrough) success = 'never'
    else if (returned.length > 0 && returnedTypes.length === returned.length) {
      const joined = Match.join(
        returnedTypes,
        BodyLifetime.environment(resolution?.bodyLifetimes, node.anchor, returnedTypes),
      )
      if (joined._tag === 'Joined') success = joined.type
      else {
        const first = returnedTypes.at(0)
        const offender =
          first === undefined
            ? undefined
            : returned.find((expression) => {
                const type = constructionExpressionType(expression)
                return type._tag === 'Available' && !Type.equals(type.type, first)
              })
        nested.diagnostics.push(
          Diagnostic.effectBlockReturnMismatch(
            joined.types.map(Type.encode),
            Location.at(
              offender === undefined ? node.anchor : constructionExpressionAnchor(offender),
            ),
          ),
        )
      }
    }
    const captures = effectCaptureFacts(
      context,
      statements,
      firstLocalBinding,
      resolution.index,
      copyAssumptionsOf(declaration),
      resolution.builder === undefined ? {} : { builder: resolution.builder },
    )
    const builder = resolution.builder
    if (builder === undefined) throw new RangeError('effect analysis requires its TIR builder')
    const reachableWrites = reachableCallableWrites(statements, builder)
    for (const capture of captures) {
      if (
        capture.reference._tag === 'BindingFact' &&
        !inheritedCallableWrites.has(capture.reference.id.ordinal) &&
        reachableWrites.has(capture.reference.id.ordinal) &&
        capture.reference.inferredType._tag === 'Available' &&
        Type.isCallable(capture.reference.inferredType.type)
      ) {
        nested.diagnostics.push(
          Diagnostic.deferredCallableMutation(
            capture.reference.name._tag === 'Present' ? capture.reference.name.spelling : '?',
            Location.at(capture.anchor),
          ),
        )
      }
    }
    const access = strongestEffectAccess(
      ...captures.flatMap((capture) => (capture.access === 'Copy' ? [] : [capture.access])),
    )
    const lifetimes = BodyLifetime.environment(
      resolution.bodyLifetimes,
      node.anchor,
      captures.flatMap((capture) => {
        const type = anonymousCapturedType(capture)
        return type === undefined ? [] : [type]
      }),
      captures
        .filter((capture) => capture.access === 'Shared' || capture.access === 'Exclusive')
        .map((capture) => capture.expression?.origin.anchor ?? capture.reference.anchor),
    )
    let inferred =
      success !== undefined && lifetimes !== undefined
        ? Type.effect(success, failures, lifetimes, access)
        : undefined
    if (inferred !== undefined) {
      for (const computation of executed) {
        inferred = Type.effectWithRows(
          inferred.success,
          RowAlgebra.union(Type.failureRowPolicy(), inferred.failureRow, computation.failureRow),
          inferred,
          inferred.access,
          RowAlgebra.union(
            Type.requirementRowPolicy(),
            inferred.requirementRow,
            computation.requirementRow,
          ),
        )
      }
    }
    const type =
      inferred === undefined ? unavailableExpressionType : availableExpressionType(inferred)
    return {
      fact: {
        _tag: 'EffectBlock',
        site: executableSite('EffectSiteId', resolution, node),
        ...(representationOwner === undefined ? {} : { representationOwner }),
        statements,
        captures,
        bindings: nested.bindings,
        regions: nested.regions,
        type,
        anchor: node.anchor,
      },
      diagnostics: nested.diagnostics,
      type: type._tag === 'Available' ? type.type : undefined,
    }
  }
  if (node._tag === 'BooleanLiteral') {
    const token = node._tag === 'BooleanLiteral' ? node : undefined
    const type = token === undefined ? unavailableExpressionType : availableBoolExpressionType
    return {
      fact: {
        _tag: 'Boolean',
        value: node._tag === 'BooleanLiteral' && node.value,
        type,
        anchor: node.anchor,
      },
      diagnostics: [],
      type: type._tag === 'Available' ? type.type : undefined,
    }
  }

  if (node._tag === 'IntegerLiteral') {
    const expectedEnum =
      expected === undefined ? undefined : enumFactByType(resolution.index, expected)
    const integer = analyzeInteger(context, node, expectedEnum === undefined ? expected : undefined)
    const mismatch =
      expectedEnum?.canonical._tag === 'Canonical' && integer.fact._tag === 'Available'
        ? Diagnostic.enumIntegerMismatch(
            Type.encode(
              Type.nominal(expectedEnum.canonical.id.module, expectedEnum.canonical.id.name),
            ),
            Type.encode(integer.fact.type),
            'IntegerToEnum',
            Location.at(integer.fact.anchor),
          )
        : undefined
    return {
      fact: {
        _tag: 'Integer',
        integer: integer.fact,
        type:
          integer.fact._tag === 'Available' && mismatch === undefined
            ? availableExpressionType(integer.fact.type)
            : unavailableExpressionType,
        anchor: node.anchor,
      },
      diagnostics: [...integer.diagnostics, ...(mismatch === undefined ? [] : [mismatch])],
      type:
        integer.fact._tag === 'Available' && mismatch === undefined ? integer.fact.type : undefined,
    }
  }

  if (node._tag === 'DurationLiteral') {
    const duration = analyzeDuration(context, node)
    return {
      fact: duration.fact,
      diagnostics: duration.diagnostics,
      type: duration.fact.type._tag === 'Available' ? duration.fact.type.type : undefined,
    }
  }

  if (node._tag === 'FloatingLiteral') {
    const floating = analyzeFloating(context, node, expected)
    const fact = floating.fact
    const type =
      fact._tag === 'Available' ? availableExpressionType(fact.type) : unavailableExpressionType
    return {
      fact: { _tag: 'Floating', floating: fact, type, anchor: node.anchor },
      diagnostics: floating.diagnostics,
      type: fact._tag === 'Available' ? fact.type : undefined,
    }
  }

  if (node._tag === 'TextLiteral' || node._tag === 'BytesLiteral') {
    // The authored literal already carries its exact decoded payload: nothing is re-lexed here.
    const data = staticDataOf(context, node)
    const diagnostic = undefined
    let type: ExpressionTypeFact
    if (data === undefined) {
      type = unavailableExpressionType
    } else {
      type = availableExpressionType(
        data.kind === 'Text'
          ? Type.string(Lifetime.staticLifetime)
          : Type.slice('Shared', 'u8', Lifetime.staticLifetime),
      )
    }
    return {
      fact: {
        _tag: 'StaticText',
        ...(data === undefined ? {} : { data }),
        literal: node.anchor,
        anchor: node.anchor,
        type,
      },
      diagnostics: diagnostic === undefined ? [] : [diagnostic],
      type: type._tag === 'Available' ? type.type : undefined,
    }
  }

  if (node._tag === 'CharacterLiteral') {
    // The authored literal already carries its exact Unicode scalar value.
    const diagnostic = undefined
    const scalar = node.scalar
    const selected = typeof expected === 'string' ? Scalar.find(expected) : undefined
    if (selected?.category === 'Integer') {
      const value = BigInt(scalar)
      const range = Scalar.range(selected, 64)
      const fits = value >= range.minimum && value <= range.maximum
      const integer: IntegerExpressionDecision = fits
        ? {
            _tag: 'Available',
            type: selected.spelling,
            value,
            anchor: node.anchor,
          }
        : {
            _tag: 'OutOfRange',
            type: selected.spelling,
            spelling: value.toString(),
            anchor: node.anchor,
          }
      return {
        fact: {
          _tag: 'Integer',
          integer,
          type: fits ? availableExpressionType(selected.spelling) : unavailableExpressionType,
          anchor: node.anchor,
        },
        diagnostics: fits
          ? []
          : [
              Diagnostic.integerOutOfRange(
                value.toString(),
                selected.spelling,
                range,
                Location.at(node.anchor),
              ),
            ],
        type: fits ? selected.spelling : undefined,
      }
    }
    const type = scalar === undefined ? unavailableExpressionType : availableExpressionType('char')
    return {
      fact: {
        _tag: 'Character',
        ...(scalar === undefined ? {} : { value: scalar }),
        type,
        anchor: node.anchor,
      },
      diagnostics: diagnostic === undefined ? [] : [diagnostic],
      type: type._tag === 'Available' ? type.type : undefined,
    }
  }

  if (node._tag === 'UnitLiteral') {
    return {
      fact: {
        _tag: 'Unit',
        type: availableExpressionType(Type.unit),
        anchor: node.anchor,
      },
      diagnostics: [],
      type: Type.unit,
    }
  }

  if (node._tag === 'CompileErrorExpression') {
    const messageNode = node._tag === 'CompileErrorExpression' ? node.message : undefined
    if (messageNode === undefined) return undefined
    const message = analyzeExpression(
      context,
      messageNode,
      declarations,
      declaration,
      scope,
      resolution,
      Type.string(Lifetime.staticLifetime),
    )
    if (message === undefined) return undefined
    return {
      fact: {
        _tag: 'CompileError',
        message: expressionNode(message),
        type: availableExpressionType('never'),
        anchor: node.anchor,
      },
      diagnostics: message.diagnostics,
      type: 'never',
    }
  }

  if (node._tag === 'IdentifierExpression') {
    const value = analyzeIdentifier(context, node, scope)
    if (
      value.fact._tag === 'Identifier' &&
      (value.fact.reference._tag === 'Resolved' ||
        value.fact.reference._tag === 'ResolvedBinding' ||
        value.fact.reference._tag === 'ResolvedPattern')
    ) {
      const local =
        value.fact.reference._tag === 'Resolved'
          ? value.fact.reference.parameter
          : value.fact.reference.binding
      const staticValue = resolution.staticContext?.values.get(Evaluation.localValueKey(local))
      return staticValue === undefined
        ? value
        : {
            ...value,
            fact: { ...value.fact, staticValue },
          }
    }
    return (
      analyzeConstantReference(context, node, resolution) ??
      analyzeForeignStaticReference(context, node, resolution) ??
      analyzeFunctionItem(context, node, declarations, resolution, declaration, expected) ??
      value
    )
  }

  if (node._tag === 'RunExpression') {
    const subjectNode = AuthoredWalk.expressionChildren(node).at(0)
    const subject =
      subjectNode === undefined
        ? undefined
        : analyzeExpression(context, subjectNode, declarations, declaration, scope, resolution)
    if (subject === undefined) throw new RangeError('Run expression requires one effect subject')
    let effect: Type.Effect | undefined
    if (subject.type !== undefined && Type.isEffect(subject.type)) {
      effect = subject.type
    } else if (
      subject.type !== undefined &&
      Type.isRepresented(subject.type) &&
      Type.isEffect(subject.type.contract)
    ) {
      effect = subject.type.contract
    } else {
      effect = undefined
    }
    const type =
      effect !== undefined ? availableExpressionType(effect.success) : unavailableExpressionType
    const allowed = declaration.functionKind === 'Effect' ? declaration.failureRow.failures : []
    const unhandled =
      (effect === undefined ? [] : Type.failureMembers(effect)).filter(
        (failure) =>
          !allowed.some((candidate) =>
            typesCompatible(failure, candidate, resolution?.lifetimeCompatibility),
          ),
      ) ?? []
    const symbolicFailuresUnhandled =
      effect !== undefined &&
      RowAlgebra.concretize(Type.failureRowPolicy(), effect.failureRow)._tag === 'Residual' &&
      !RowAlgebra.isKnownSubset(
        Type.failureRowPolicy(),
        effect.failureRow,
        declaration.functionKind === 'Effect'
          ? declaration.failureRow.row
          : RowAlgebra.concrete(Type.failureRowPolicy(), []),
      )
    const allowedRequirements =
      declaration.functionKind === 'Effect'
        ? RowAlgebra.positiveConcreteMembers(
            Type.requirementRowPolicy(),
            declaration.requirementRow.row,
          )
        : ([] as Type.Requirement[])
    const unsatisfiedRequirements =
      (effect === undefined ? [] : Type.positiveRequirementMembers(effect)).filter(
        (requirement) =>
          !allowedRequirements.some(
            (allowed) =>
              Type.equals(allowed.capability, requirement.capability) &&
              allowed.role === requirement.role &&
              (allowed.access === 'Exclusive' || allowed.access === requirement.access),
          ),
      ) ?? []
    const symbolicRequirementsUnsatisfied =
      effect !== undefined &&
      RowAlgebra.concretize(Type.requirementRowPolicy(), effect.requirementRow)._tag ===
        'Residual' &&
      !RowAlgebra.isKnownSubset(
        Type.requirementRowPolicy(),
        effect.requirementRow,
        declaration.functionKind === 'Effect'
          ? declaration.requirementRow.row
          : RowAlgebra.concrete(Type.requirementRowPolicy(), []),
      )
    const diagnostics = [...subject.diagnostics]
    if (effect === undefined && subject.type !== undefined)
      diagnostics.push(
        Diagnostic.runNonEffect(Type.display(subject.type), Location.at(node.anchor)),
      )
    if (unhandled.length > 0 || symbolicFailuresUnhandled)
      diagnostics.push(
        Diagnostic.unhandledEffectFailures(
          unhandled.length > 0
            ? unhandled.map(Type.encode)
            : [
                RowAlgebra.encode(
                  Type.failureRowPolicy(),
                  effect?.failureRow ?? RowAlgebra.concrete(Type.failureRowPolicy(), []),
                  Type.encode,
                  Type.encode,
                  (member) => member.parameter.name,
                ),
              ],
          Location.at(node.anchor),
        ),
      )
    if (unsatisfiedRequirements.length > 0 || symbolicRequirementsUnsatisfied)
      diagnostics.push(
        Diagnostic.unhandledEffectRequirements(
          unsatisfiedRequirements.length > 0
            ? unsatisfiedRequirements.map(
                (requirement) =>
                  `${requirement.access === 'Exclusive' ? '&mut ' : '&'}${Type.encode(requirement.capability)}${requirement.role === 'DefaultRole' ? '' : `@${requirement.role}`}`,
              )
            : [
                RowAlgebra.encode(
                  Type.requirementRowPolicy(),
                  effect?.requirementRow ?? RowAlgebra.concrete(Type.requirementRowPolicy(), []),
                  (requirement) =>
                    `${requirement.access === 'Exclusive' ? '&mut ' : '&'}${Type.encode(requirement.capability)}${requirement.role === 'DefaultRole' ? '' : `@${requirement.role}`}`,
                  Type.encode,
                  (member) =>
                    `${member.access === 'Exclusive' ? '&mut ' : '&'}${member.capability.name}${member.role === 'DefaultRole' ? '' : `@${member.role}`}`,
                ),
              ],
          Location.at(node.anchor),
        ),
      )
    return {
      fact: {
        _tag: 'Run',
        subject: expressionNode(subject),
        type,
        anchor: node.anchor,
      },
      diagnostics: diagnostics,
      type: type._tag === 'Available' ? type.type : undefined,
    }
  }

  if (node._tag === 'MoveExpression') {
    const move = analyzeMove(context, node, declarations, declaration, scope, resolution)
    return {
      fact: move.fact,
      diagnostics: move.diagnostics,
      type: move.type,
    }
  }

  if (node._tag === 'BorrowExpression') {
    return analyzeBorrow(context, node, declarations, declaration, scope, resolution, expected)
  }

  if (node._tag === 'MatchExpression') {
    return analyzeMatch(context, node, declarations, declaration, scope, resolution, expected)
  }

  if (node._tag === 'MemberExpression') {
    const applied = resolveAppliedInterfaceOperationTarget(context, node, declaration, resolution)
    if (applied !== undefined) {
      const diagnostic =
        applied._tag === 'Resolved'
          ? Diagnostic.uninferredTypeParameter(
              applied.reference.spelling,
              'Self',
              Location.at(applied.reference.anchor),
            )
          : undefined
      return {
        fact: unavailableExpression(node.anchor),
        diagnostics: Diagnostic.collect(
          applied.diagnostics,
          diagnostic === undefined ? [] : [diagnostic],
        ),
        type: undefined,
      }
    }
    return analyzeAggregateLiteral(context, node, declarations, declaration, scope, resolution)
  }

  if (node._tag === 'StructExpression') {
    return analyzeAggregateLiteral(context, node, declarations, declaration, scope, resolution)
  }

  if (node._tag === 'TupleExpression') {
    return analyzeTupleLiteral(
      context,
      node,
      declarations,
      declaration,
      scope,
      resolution,
      expected,
    )
  }

  if (node._tag === 'RecordExpression') {
    return analyzeContextualRecordLiteral(
      context,
      node,
      declarations,
      declaration,
      scope,
      resolution,
      expected,
    )
  }

  if (node._tag === 'ArrayExpression') {
    return analyzeArrayLiteral(
      context,
      node,
      declarations,
      declaration,
      scope,
      resolution,
      expected,
    )
  }

  if (node._tag === 'OrdinalExpression') {
    return analyzeProjection(context, node, declarations, declaration, scope, resolution)
  }

  if (node._tag === 'FieldExpression') {
    if (resolveBareUnionVariantTarget(context, node, resolution) !== undefined)
      return analyzeAggregateLiteral(context, node, declarations, declaration, scope, resolution)
    return (
      analyzeEnumMember(context, node, resolution, expected) ??
      analyzeConstantReference(context, node, resolution) ??
      analyzeForeignStaticReference(context, node, resolution) ??
      analyzeFunctionItem(context, node, declarations, resolution, declaration, expected) ??
      analyzeProjection(context, node, declarations, declaration, scope, resolution)
    )
  }

  if (node._tag === 'ReferentExpression') {
    return analyzeReferentProjection(context, node, declarations, declaration, scope, resolution)
  }

  if (node._tag === 'IndexExpression') {
    return analyzeIndexProjection(context, node, declarations, declaration, scope, resolution)
  }

  if (node._tag === 'PrefixExpression' || node._tag === 'InfixExpression') {
    return analyzeOperatorExpression(
      context,
      node,
      declarations,
      declaration,
      scope,
      resolution,
      expected,
    )
  }

  if (node._tag === 'PipelineExpression' || node._tag === 'CallExpression') {
    if (node._tag === 'PipelineExpression')
      return analyzePipelineExpression(context, node, declarations, declaration, scope, resolution)
    const constructed = tupleConstructor(
      context,
      node,
      declarations,
      declaration,
      scope,
      resolution,
    )
    if (constructed !== undefined) return constructed
  }

  if (node._tag !== 'CallExpression') return undefined

  // `receiver.member(...)` is the value-side spelling of one statically selected member; it is
  // recognized before any argument pass so the receiver and the arguments are analyzed once.
  const methodCall = analyzeMethodCall(context, node, declarations, declaration, scope, resolution)
  if (methodCall !== undefined) return methodCall

  // `Owner<Args>.member(...)` on an inherent member is the bare form with the owner arguments
  // prepended to the explicit generic prefix; it never reaches the interface-operation path.
  const appliedInherent = appliedInherentMember(context, node, resolution)
  const callTypeArguments = analyzeCallTypeArguments(
    context,
    node,
    declaration,
    resolution,
    appliedInherent ? appliedOwnerTypeArgumentNodes(node) : [],
  )
  const appliedTarget = appliedInherent
    ? undefined
    : resolveAppliedInterfaceOperationTarget(context, node, declaration, resolution)
  if (appliedTarget !== undefined) {
    const argumentNodes = node._tag === 'CallExpression' ? node.arguments : []
    const argumentsResult = analyzeArgumentNodes(
      context,
      node,
      argumentNodes,
      declarations,
      declaration,
      scope,
      resolution,
      appliedTarget._tag === 'Resolved'
        ? instantiateInterfaceReference(appliedTarget.reference, node, resolution).parameters
        : [],
    )
    return finishAppliedInterfaceOperation(
      context,
      node,
      appliedTarget,
      argumentsResult,
      callTypeArguments,
      declaration,
      resolution,
    )
  }
  const argumentsResult = analyzeArguments(
    context,
    node,
    declarations,
    declaration,
    scope,
    resolution,
    callTypeArguments,
  )

  const enumValue = analyzeEnumValueCall(context, node, argumentsResult, declaration, resolution)
  if (enumValue !== undefined) return enumValue

  const calleeNode = callCallee(node)
  const calleeResult = analyzeExpression(
    context,
    calleeNode,
    declarations,
    declaration,
    scope,
    resolution,
  )
  const resolvedValueCallee =
    calleeResult?.fact._tag === 'Identifier' &&
    (calleeResult.fact.reference._tag === 'Resolved' ||
      calleeResult.fact.reference._tag === 'ResolvedBinding' ||
      calleeResult.fact.reference._tag === 'ResolvedPattern')
  if (
    calleeResult !== undefined &&
    calleeResult.fact._tag !== 'FunctionItem' &&
    ((calleeResult.type !== undefined &&
      (Type.isCallable(calleeResult.type) ||
        (Type.isRepresented(calleeResult.type) && Type.isCallable(calleeResult.type.contract)))) ||
      (calleeResult.type !== undefined && calleeNode._tag !== 'IdentifierExpression') ||
      resolvedValueCallee ||
      calleeResult.fact._tag === 'Constant')
  ) {
    return finishCallableApplication(
      context,
      node,
      calleeResult,
      argumentsResult,
      callTypeArguments,
      undefined,
      resolution,
      declaration,
    )
  }

  const identifiers = referenceNames(node)
  if (identifiers.length === 2) {
    const qualifierToken = identifiers.at(0)
    const memberToken = identifiers.at(1)
    if (qualifierToken === undefined || memberToken === undefined)
      return analyzeBuiltinCall(
        context,
        node,
        argumentsResult,
        callTypeArguments,
        resolution,
        declaration,
      )
    const qualifier = SemanticContext.nameText(context, qualifierToken) ?? ''
    const member = SemanticContext.nameText(context, memberToken) ?? ''
    if (intrinsicOperationTarget(context, node)?.rule._tag === 'PlaceRule') {
      return analyzePlaceReplace(context, node, declarations, declaration, scope, resolution)
    }
    const qualifierLookup = Semantic.resolveName(resolution.semantic, resolution.scope, qualifier)
    if (qualifierLookup._tag === 'Intrinsic') {
      return analyzeBuiltinCall(
        context,
        node,
        argumentsResult,
        callTypeArguments,
        resolution,
        declaration,
      )
    }
    // A declared inherent member of the qualifier wins over every other projection of that
    // spelling: contract operations, the legacy module projection, and enum members are consulted
    // only when the owner declares no such member.
    if (qualifierLookup._tag === 'Resolved') {
      const associated = Semantic.resolveAssociatedName(
        resolution.semantic,
        qualifierLookup.declaration,
        member,
        resolution.scope.module,
      )
      if (associated._tag !== 'Missing') {
        let diagnostic: Diagnostic.Located | undefined
        let reference: CallReferenceFact
        if (associated._tag === 'Inherent') {
          diagnostic = undefined
          reference = {
            _tag: 'Resolved',
            spelling: `${qualifier}.${member}`,
            anchor: memberToken.anchor,
            declaration: associated.declaration,
          }
        } else if (associated._tag === 'Inaccessible') {
          diagnostic = Diagnostic.inaccessibleImportedMember(
            associated.declaration.canonical._tag === 'Canonical'
              ? associated.declaration.canonical.id.module
              : qualifier,
            member,
            Location.at(memberToken.anchor),
          )
          reference = {
            _tag: 'Missing',
            spelling: `${qualifier}.${member}`,
            anchor: memberToken.anchor,
            cause: Diagnostic.identity(diagnostic),
          }
        } else {
          diagnostic = undefined
          reference = {
            _tag: 'Missing',
            spelling: `${qualifier}.${member}`,
            anchor: memberToken.anchor,
            cause: associated.cause,
          }
        }
        return finishDeclarationCall(
          context,
          node,
          reference,
          argumentsResult,
          callTypeArguments,
          diagnostic,
          declaration,
          resolution,
        )
      }
    }
    // A bound on the caller wins for interfaces and services alike (SERV-003): only an operation
    // no bound supplies reaches the ambient service path.
    if (
      qualifierLookup._tag === 'Resolved' &&
      (qualifierLookup.declaration._tag === 'InterfaceDeclaration' ||
        qualifierLookup.declaration._tag === 'ServiceDeclaration')
    ) {
      const bound = boundOperationReference(
        declaration,
        qualifierLookup.declaration,
        qualifier,
        member,
        memberToken,
      )
      if (bound?._tag === 'AmbiguousBound') {
        const ambiguous = Diagnostic.ambiguousBoundOperation(
          `${qualifier}.${member}`,
          bound.parameters,
          Location.at(memberToken.anchor),
        )
        return finishDeclarationCall(
          context,
          node,
          {
            _tag: 'Missing',
            spelling: `${qualifier}.${member}`,
            anchor: memberToken.anchor,
            cause: Diagnostic.identity(ambiguous),
          },
          argumentsResult,
          callTypeArguments,
          ambiguous,
          declaration,
          resolution,
        )
      }
      if (bound !== undefined)
        return finishInterfaceOperationCall(
          context,
          node,
          bound.reference,
          argumentsResult,
          callTypeArguments,
          resolution,
        )
      const concrete = concreteContractOperationReference(
        context,
        qualifierLookup.declaration,
        member,
        memberToken,
        argumentsResult,
        resolution,
      )
      if (concrete?._tag === 'Resolved')
        return finishInterfaceOperationCall(
          context,
          node,
          concrete.reference,
          argumentsResult,
          callTypeArguments,
          resolution,
        )
      if (concrete?._tag === 'Rejected')
        return finishDeclarationCall(
          context,
          node,
          {
            _tag: 'Missing',
            spelling: `${qualifier}.${member}`,
            anchor: memberToken.anchor,
            cause: Diagnostic.identity(concrete.diagnostic),
          },
          argumentsResult,
          callTypeArguments,
          concrete.diagnostic,
          declaration,
          resolution,
        )
    }
    if (
      qualifierLookup._tag === 'Resolved' &&
      qualifierLookup.declaration._tag === 'ServiceDeclaration'
    ) {
      const operation = serviceOperation(qualifierLookup.declaration, member)
      const diagnostic =
        operation === undefined
          ? Diagnostic.unknownActorOperation(qualifier, member, Location.at(memberToken.anchor))
          : undefined
      let reference: CallReferenceFact
      if (operation === undefined) {
        reference = {
          _tag: 'Missing',
          spelling: `${qualifier}.${member}`,
          anchor: memberToken.anchor,
          ...(diagnostic === undefined ? {} : { cause: Diagnostic.identity(diagnostic) }),
        }
      } else {
        reference = {
          _tag: 'ResolvedServiceOperation',
          spelling: `${qualifier}.${member}`,
          anchor: memberToken.anchor,
          service: qualifierLookup.declaration,
          operation,
        }
      }
      return finishDeclarationCall(
        context,
        node,
        reference,
        argumentsResult,
        callTypeArguments,
        diagnostic,
        declaration,
        resolution,
      )
    }
    if (
      qualifierLookup._tag === 'Resolved' &&
      NameResolution.isNominalOwner(qualifierLookup.declaration)
    ) {
      // The owner declares no such associated item: contract operations and inherent members are
      // the only members a nominal qualifier exposes, never its module's root declarations.
      const diagnostic = Diagnostic.unknownActorOperation(
        qualifier,
        member,
        Location.at(memberToken.anchor),
      )
      return finishDeclarationCall(
        context,
        node,
        {
          _tag: 'Missing',
          spelling: `${qualifier}.${member}`,
          anchor: memberToken.anchor,
          cause: Diagnostic.identity(diagnostic),
        },
        argumentsResult,
        callTypeArguments,
        diagnostic,
        declaration,
        resolution,
      )
    }
    if (qualifierLookup._tag === 'Namespace') {
      const memberLookup = DeclarationFacts.lookup(resolution.index, qualifierLookup.module, member)
      const candidate = memberLookup._tag === 'Resolved' ? memberLookup.declaration : undefined
      let diagnostic: Diagnostic.Located | undefined
      if (candidate === undefined) {
        diagnostic = Diagnostic.unknownImportedMember(
          qualifierLookup.module,
          member,
          Location.at(memberToken.anchor),
        )
      } else if (candidate.visibility === 'Private') {
        diagnostic = Diagnostic.inaccessibleImportedMember(
          qualifierLookup.module,
          member,
          Location.at(memberToken.anchor),
        )
      } else {
        diagnostic = undefined
      }
      let reference: CallReferenceFact
      if (candidate !== undefined && candidate.visibility === 'Public') {
        reference = {
          _tag: 'Resolved',
          spelling: `${qualifier}.${member}`,
          anchor: memberToken.anchor,
          declaration: candidate,
        }
      } else {
        reference = {
          _tag: 'Missing',
          spelling: `${qualifier}.${member}`,
          anchor: memberToken.anchor,
          ...(diagnostic === undefined ? {} : { cause: Diagnostic.identity(diagnostic) }),
        }
      }
      return finishDeclarationCall(
        context,
        node,
        reference,
        argumentsResult,
        callTypeArguments,
        diagnostic,
        declaration,
        resolution,
      )
    }
    const diagnostic =
      qualifierLookup._tag === 'Missing' || qualifierLookup._tag === 'Resolved'
        ? Diagnostic.unknownActor(qualifier, Location.at(qualifierToken.anchor))
        : undefined
    let inheritedCause: Diagnostic.Identity<Location.Location> | undefined
    if (qualifierLookup._tag === 'Unavailable') {
      inheritedCause = qualifierLookup.cause
    } else if (qualifierLookup._tag === 'Conflict') {
      inheritedCause = qualifierLookup.conflict.cause
    } else {
      inheritedCause = undefined
    }
    const cause = diagnostic !== undefined ? Diagnostic.identity(diagnostic) : inheritedCause
    const reference: CallReferenceFact = {
      _tag: 'Missing',
      spelling: `${qualifier}.${member}`,
      anchor: qualifierToken.anchor,
      ...(cause === undefined ? {} : { cause }),
    }
    return finishDeclarationCall(
      context,
      node,
      reference,
      argumentsResult,
      callTypeArguments,
      diagnostic,
      declaration,
      resolution,
    )
  }

  const token = identifiers.at(0)
  if (token === undefined) {
    return {
      fact: {
        _tag: 'Call',
        reference: {
          _tag: 'Unavailable',
          anchor: callCallee(node).anchor,
        },
        path: referencePath(context, node),
        typeArguments: callTypeArguments.facts,
        arguments: argumentsResult.facts,
        mappings: [],
        contract: {
          _tag: 'Unavailable',
          reason: {
            _tag: 'UnavailableCallSyntax',
            anchor: node.anchor,
          },
        },
        type: unavailableExpressionType,
        anchor: node.anchor,
      },
      diagnostics: argumentsResult.diagnostics,
      type: undefined,
    }
  }

  const tokenSpelling = SemanticContext.nameText(context, token) ?? ''
  const resolvedLookup = Semantic.resolveName(resolution.semantic, resolution.scope, tokenSpelling)
  const localLookup = lookupDeclaration(declarations, tokenSpelling)
  let lookup: DeclarationFacts.DeclarationLookup
  if (resolvedLookup._tag === 'Conflict') {
    lookup = {
      _tag: 'Ambiguous',
      spelling: tokenSpelling,
      declarations: resolvedLookup.conflict.bindings.flatMap((binding) => {
        if (binding._tag !== 'LocalDeclaration' && binding._tag !== 'ImportedMember') return []
        const declaration = DeclarationFacts.byCanonical(resolution.index, binding.declaration)
        return declaration?._tag === 'FunctionDeclaration' ? [declaration] : []
      }),
    }
  } else if (localLookup._tag === 'Ambiguous') {
    lookup = localLookup
  } else if (
    resolvedLookup._tag === 'Resolved' &&
    resolvedLookup.declaration._tag === 'FunctionDeclaration'
  ) {
    lookup = {
      _tag: 'Resolved',
      spelling: tokenSpelling,
      declaration: resolvedLookup.declaration,
    }
  } else if (resolvedLookup._tag === 'Missing') {
    lookup = localLookup
  } else {
    lookup = { _tag: 'Missing', spelling: tokenSpelling }
  }
  const missingDiagnostic =
    lookup._tag === 'Missing' && resolvedLookup._tag !== 'Unavailable'
      ? Diagnostic.unknownFunction(tokenSpelling, Location.at(token.anchor))
      : undefined
  let reference: CallReferenceFact
  if (lookup._tag === 'Resolved') {
    reference = {
      _tag: 'Resolved',
      spelling: tokenSpelling,
      anchor: token.anchor,
      declaration: lookup.declaration,
    }
  } else if (lookup._tag === 'Ambiguous') {
    reference = {
      _tag: 'Ambiguous',
      spelling: tokenSpelling,
      anchor: token.anchor,
      declarations: lookup.declarations,
      ...(resolvedLookup._tag === 'Conflict' ? { cause: resolvedLookup.conflict.cause } : {}),
    }
  } else {
    let cause: Diagnostic.Identity<Location.Location> | undefined
    if (missingDiagnostic !== undefined) cause = Diagnostic.identity(missingDiagnostic)
    else if (resolvedLookup._tag === 'Unavailable') cause = resolvedLookup.cause
    reference = {
      _tag: 'Missing',
      spelling: tokenSpelling,
      anchor: token.anchor,
      ...(cause === undefined ? {} : { cause }),
    }
  }
  return finishDeclarationCall(
    context,
    node,
    reference,
    argumentsResult,
    callTypeArguments,
    missingDiagnostic,
    declaration,
    resolution,
  )
}

/** Checks one authored expression and immediately publishes its typed node to the body builder. */
export function analyzeExpression(
  context: SemanticContext.SemanticContext,
  node: AuthoredHir.Expression,
  declarations: ReadonlyArray<DeclarationFact>,
  declaration: DeclarationFact,
  scope: Scope,
  resolution: ResolutionContext,
  expected?: SemanticType,
): ExpressionResult | undefined {
  const result = analyzeExpressionDecision(
    context,
    node,
    declarations,
    declaration,
    scope,
    resolution,
    expected,
  )
  if (result === undefined) return result
  resolution.publishExpressionDecision?.(result.fact)
  if (resolution.builder === undefined) return result
  const lowered = BodyBuilder.tirExpression(result.fact, {
    context,
    builder: resolution.builder,
    ...(declaration.phase === 'Static' || resolution.staticContext !== undefined
      ? { static: resolution.builder.expressions }
      : {}),
    ...(resolution.lifetimeCompatibility === undefined
      ? {}
      : { lifetimeCompatibility: resolution.lifetimeCompatibility }),
    ...(declaration.opaqueResult === undefined
      ? {}
      : { opaqueResultFamily: declaration.opaqueResult.family }),
    functionId: declaration.id,
  })
  return { ...result, node: lowered }
}

export const finishDeclarationCall = (
  context: SemanticContext.SemanticContext,
  node: AuthoredHir.Expression,
  reference: CallReferenceFact,
  argumentsResult: ArgumentsResult,
  callTypeArguments: CallTypeArgumentsResult,
  diagnostic: Diagnostic.Located | undefined,
  caller: DeclarationFact,
  resolution: ResolutionContext,
  path: ReferencePathFact = referencePath(context, node),
): ExpressionResult => {
  if (
    reference._tag === 'Resolved' &&
    reference.declaration.foreign?.variadic !== true &&
    isSectionArity(reference.declaration.parameters.length, argumentsResult.facts.length)
  ) {
    const section = finishCallableSection(
      context,
      node,
      reference,
      argumentsResult,
      callTypeArguments,
      resolution,
      caller,
    )
    return diagnostic === undefined
      ? section
      : {
          ...section,
          diagnostics: [diagnostic, ...section.diagnostics],
        }
  }
  const callContract = analyzeCallContract(
    context,
    node,
    reference,
    argumentsResult.facts,
    hasAvailableCallSyntax(node),
    callTypeArguments,
    resolution,
    caller,
  )
  const constraints = interfaceConstraints(
    context,
    reference,
    callContract.fact._tag === 'Compatible' ? callContract.fact.substitution : undefined,
    resolution.index,
    caller,
    Location.at(node.anchor),
  )
  const callable = sourceCallable(reference)
  const unsafeDiagnostic = unsafeCallDiagnostic(
    callable?.unsafe === true,
    'spelling' in reference ? reference.spelling : 'callable',
    node,
    context.spanOf(node.anchor),
    resolution,
  )
  const phaseDiagnostics =
    callable === undefined
      ? ([] as ReadonlyArray<Diagnostic.Located>)
      : callable.parameters.flatMap((parameter) => {
          if (parameter.phase !== 'Runtime') return []
          const argument = argumentsResult.facts.at(parameter.id.ordinal)
          return argument?.type._tag === 'Available' &&
            Type.containsStaticPhaseOnly(argument.type.type)
            ? [
                Diagnostic.staticPhaseViolation(
                  'runtime call argument with a phase-only type',
                  resolution.staticContext?.environment.target ?? 'unselected-target',
                  [],
                  Location.at(argument.anchor),
                ),
              ]
            : []
        })
  const staticArguments = (() => {
    if (
      callable === undefined ||
      resolution.staticContext === undefined ||
      resolution.deferStaticCalls === true
    )
      return {
        values: [] as ReadonlyArray<{
          readonly parameter: ParameterFact
          readonly value: StaticValue.Value
        }>,
        diagnostics: [] as ReadonlyArray<Diagnostic.Located>,
      }
    const values: Array<{ readonly parameter: ParameterFact; readonly value: StaticValue.Value }> =
      []
    const diagnostics: Array<Diagnostic.Located> = []
    for (const parameter of callable.parameters) {
      if (parameter.phase !== 'Static') continue
      const argument = argumentsResult.facts.at(parameter.id.ordinal)
      if (argument === undefined) continue
      const evaluated = evaluateStatic(argument.expression, resolution.staticContext, resolution)
      if (evaluated._tag === 'Complete') {
        const evaluatedNode = resolution.staticContext.nodes.expression(argument.expression)
        const textOrigin =
          Evaluation.staticTextOrigin(evaluatedNode, resolution.staticContext) ??
          (evaluated.value._tag === 'TextValue' ? evaluated.value.origin : undefined)
        values.push({
          parameter,
          value: evaluated.value,
          ...(textOrigin === undefined ? {} : { textOrigin }),
        })
      } else {
        diagnostics.push(
          Evaluation.diagnostic(evaluated.failure, resolution.staticContext.environment.target),
        )
      }
    }
    return { values: values, diagnostics: diagnostics }
  })()
  const expressionType =
    hasAvailableCallSyntax(node) &&
    callable !== undefined &&
    callable.returnType._tag === 'Resolved' &&
    callContract.fact._tag === 'Compatible' &&
    constraints.diagnostics.length === 0 &&
    unsafeDiagnostic === undefined
      ? availableExpressionType(
          (() => {
            const substitution =
              callContract.fact._tag === 'Compatible'
                ? callContract.fact.substitution
                : new Map<string, Type.GenericArgument>()
            const success = Type.substitute(callable.returnType.type, substitution)
            // An ordinary function's declared result is its contract; the Effect it returns
            // carries the run access the declaration spelled, not one derived from the call.
            if (callable.functionKind !== 'Effect') return success
            return Type.effectWithRows(
              success,
              Type.substituteFailureRow(callable.failureRow.row, substitution),
              {
                ...DeclarationFacts.executableLifetimes(callable),
                lifetimeBinders: [],
                environment: Type.substituteLifetime(
                  DeclarationFacts.executableLifetimes(callable).environment,
                  substitution,
                ),
                lifetimeBounds: (
                  DeclarationFacts.executableLifetimes(callable).lifetimeBounds ?? []
                ).map((bound) => ({
                  longer: Type.substituteLifetime(bound.longer, substitution),
                  shorter: Type.substituteLifetime(bound.shorter, substitution),
                })),
                typeOutlives: (
                  DeclarationFacts.executableLifetimes(callable).typeOutlives ?? []
                ).map((bound) => ({
                  type: Type.substitute(bound.type, substitution),
                  lifetime: Type.substituteLifetime(bound.lifetime, substitution),
                })),
              },
              effectCaptureAccess(
                argumentsResult.facts,
                resolution.index,
                copyAssumptionsOf(caller),
              ),
              Type.substituteRequirementsRow(callable.requirementRow.row, substitution),
            )
          })(),
        )
      : unavailableExpressionType
  const fact: Extract<ExpressionDecision, { readonly _tag: 'Call' }> = {
    _tag: 'Call',
    reference,
    path,
    typeArguments: callTypeArguments.facts,
    arguments: argumentsResult.facts,
    staticArguments: staticArguments.values,
    mappings: callContract.mappings,
    contract: callContract.fact,
    selectedConformances: constraints.proofs,
    type: expressionType,
    anchor: node.anchor,
  }
  const staticContext = resolution.staticContext
  const staticResult =
    reference._tag === 'Resolved' &&
    reference.declaration.phase === 'Static' &&
    staticContext !== undefined &&
    resolution.deferStaticCalls !== true &&
    expressionType._tag === 'Available'
      ? evaluateStatic(fact, staticContext, resolution)
      : undefined
  const staticDiagnostics =
    staticResult?._tag === 'Failed' && staticContext !== undefined
      ? [Evaluation.diagnostic(staticResult.failure, staticContext.environment.target)]
      : []
  let resolvedFact = fact
  if (staticResult?._tag === 'Complete') {
    const evaluatedNode = staticContext?.nodes.expression(fact)
    const staticTextSpan =
      evaluatedNode === undefined ? undefined : staticContext?.expressionSpans.get(evaluatedNode)
    const staticTextOrigin =
      evaluatedNode === undefined ? undefined : staticContext?.expressionOrigins.get(evaluatedNode)
    resolvedFact = {
      ...fact,
      staticValue: staticResult.value,
      ...(staticTextSpan === undefined ? {} : { staticTextSpan }),
      ...(staticTextOrigin === undefined ? {} : { staticTextOrigin }),
    }
  } else if (staticResult?._tag === 'Failed')
    resolvedFact = { ...fact, staticFailure: staticResult.failure }
  return {
    fact: resolvedFact,
    diagnostics: [
      ...(diagnostic === undefined ? [] : [diagnostic]),
      ...argumentsResult.diagnostics,
      ...callTypeArguments.diagnostics,
      ...callContract.diagnostics,
      ...constraints.diagnostics,
      ...phaseDiagnostics,
      ...staticArguments.diagnostics,
      ...staticDiagnostics,
      ...(unsafeDiagnostic === undefined ? [] : [unsafeDiagnostic]),
    ],
    type: expressionType._tag === 'Available' ? expressionType.type : undefined,
  }
}

/** Finishes one statically selected interface operation call. */
export const finishInterfaceOperationCall = (
  context: SemanticContext.SemanticContext,
  node: AuthoredHir.Expression,
  selectedReference: Extract<CallReferenceFact, { readonly _tag: 'ResolvedInterfaceOperation' }>,
  argumentsResult: ArgumentsResult,
  callTypeArguments: CallTypeArgumentsResult,
  resolution: ResolutionContext,
  effectSiteNode: AuthoredHir.Expression = node,
  interfaceApplication?: DeclarationFacts.DeclaredTypeFact,
  path: ReferencePathFact = referencePath(context, node),
): ExpressionResult => {
  const reference = instantiateInterfaceReference(selectedReference, node, resolution)
  const syntaxAvailable =
    node._tag === 'PipelineExpression'
      ? AuthoredWalk.isAvailable(node)
      : hasAvailableCallSyntax(node)
  const typeArgumentDiagnostic =
    callTypeArguments.explicit && callTypeArguments.facts.length > 0
      ? Diagnostic.typeArgumentArity(
          reference.spelling,
          0,
          callTypeArguments.facts.length,
          Location.at(node.anchor),
        )
      : undefined
  const callContract = analyzeCallContract(
    context,
    node,
    reference,
    argumentsResult.facts,
    syntaxAvailable,
    undefined,
    resolution,
  )
  const unsafeDiagnostic = unsafeCallDiagnostic(
    reference.interfaceContract.unsafe,
    reference.spelling,
    node,
    context.spanOf(node.anchor),
    resolution,
  )
  const expressionType =
    syntaxAvailable &&
    typeArgumentDiagnostic === undefined &&
    callContract.fact._tag === 'Compatible' &&
    unsafeDiagnostic === undefined
      ? availableExpressionType(reference.result)
      : unavailableExpressionType
  return {
    fact: {
      _tag: 'Call',
      reference,
      path,
      ...(interfaceApplication === undefined ? {} : { interfaceApplication }),
      typeArguments: callTypeArguments.facts,
      arguments: argumentsResult.facts,
      mappings: callContract.mappings,
      contract: callContract.fact,
      selectedConformances: interfaceEvidence(reference, resolution.index),
      ...(expressionType._tag === 'Available' &&
      reference.interfaceContract.functionKind === 'Effect'
        ? {
            witnessEffectSite: executableSite('EffectSiteId', resolution, effectSiteNode),
          }
        : {}),
      type: expressionType,
      anchor: node.anchor,
    },
    diagnostics: [
      ...(typeArgumentDiagnostic === undefined ? [] : [typeArgumentDiagnostic]),
      ...argumentsResult.diagnostics,
      ...callTypeArguments.diagnostics,
      ...callContract.diagnostics,
      ...(unsafeDiagnostic === undefined ? [] : [unsafeDiagnostic]),
    ],
    type: expressionType._tag === 'Available' ? expressionType.type : undefined,
  }
}

/** The expression one statement owns, for consumers that need it without a kind dispatch. */
export const statementExpressionNode = (
  statement: AuthoredHir.Statement,
): AuthoredHir.Expression => {
  const expression = AuthoredWalk.statementExpressions(statement).at(0)
  if (expression === undefined)
    throw new RangeError('Semantic analysis expected a statement expression')
  return expression
}

export interface FunctionAnalysis {
  readonly fact: FunctionConstruction
  readonly diagnostics: ReadonlyArray<Diagnostic.Located>
  readonly builder: BodyBuilder.BodyBuilder
}

/** The declared name an authored `Name` supplies; recovery names are explicitly unavailable. */
export const bindingName = (
  context: SemanticContext.SemanticContext,
  name: AuthoredHir.Name,
): DeclarationFacts.DeclaredName =>
  name._tag === 'Name'
    ? {
        _tag: 'Present' as const,
        spelling: context.textOf(name.text),
        anchor: name.anchor,
      }
    : { _tag: 'Unavailable' as const, anchor: name.anchor }

export const scopeSpanFor = (
  context: SemanticContext.SemanticContext,
  scope: Scope,
  spellingText: string,
): Location.Location | undefined => {
  const binding = scope.bindings.findLast(
    (candidate) => candidate.name._tag === 'Present' && candidate.name.spelling === spellingText,
  )
  if (binding?.name._tag === 'Present') return Location.at(binding.name.anchor)
  const patternBinding = scope.patternBindings.findLast(
    (candidate) => candidate.name._tag === 'Present' && candidate.name.spelling === spellingText,
  )
  if (patternBinding?.name._tag === 'Present') return Location.at(patternBinding.name.anchor)
  const parameter = scope.parameters.find(
    (candidate) => candidate.name._tag === 'Present' && candidate.name.spelling === spellingText,
  )
  return parameter?.name._tag === 'Present' ? Location.at(parameter.name.anchor) : undefined
}

/**
 * Evaluates what construction has analyzed so far.
 *
 * Aggregates this body generated are not in the declaration index yet, so they are answered from
 * the body's own resolution before the index is asked.
 */
export const evaluateStatic = (
  fact: ExpressionDecision | Tir.Expression,
  staticContext: StaticAnalysisContext,
  resolution: Pick<ResolutionContext, 'generatedAggregates'> | undefined,
): Evaluation.Outcome<StaticValue.Value> =>
  Evaluation.evaluateNode(staticContext.nodes.expression(fact), {
    ...staticContext,
    lookup: (id) =>
      resolution?.generatedAggregates?.get(`${id.module}:${id.name}`) ?? staticContext.lookup(id),
  })

export interface StaticAnalysisContext {
  readonly environment: Evaluation.TargetEnvironment
  readonly typeSubstitution?: Type.Substitution
  readonly values: Map<string, StaticValue.Value>
  readonly valueSpans: Map<string, Location.Location>
  readonly valueOrigins: Map<string, Evaluation.TextOrigin>
  readonly expressionSpans: Map<Tir.Expression, Location.Location>
  readonly expressionOrigins: Map<Tir.Expression, Evaluation.TextOrigin>
  readonly observeResolved?: NonNullable<Evaluation.NodeContext['observeResolved']>
  readonly returnedTextSpan?: { value: Location.Location | undefined }
  readonly trace: Evaluation.Trace
  /** The nodes of what this body has analyzed so far, which is what the evaluator interprets. */
  readonly nodes: import('./BodyBuilder.js').StaticLowering
  readonly lookup: Evaluation.NodeContext['lookup']
  readonly call: Evaluation.NodeContext['call']
  readonly reflect: Evaluation.NodeContext['reflect']
  readonly testCatalog?: import('./TestDiscovery.js').Catalog
  readonly constant?: NonNullable<Evaluation.NodeContext['constant']>
  /** Charges one fully analyzed iteration before any of its residual facts are published. */
  readonly chargeStaticIteration?: (
    trace: Evaluation.Trace,
    residualNodes: number,
  ) => Evaluation.StaticFailure | undefined
  /** Residual nodes already charged incrementally by successful static iterations. */
  readonly chargedStaticIterationNodes?: { value: number }
}

export interface BodyContext {
  readonly context: SemanticContext.SemanticContext
  readonly declaration: DeclarationFact
  readonly declarations: ReadonlyArray<DeclarationFact>
  readonly bindings: Array<BindingDeclarationFact>
  readonly diagnostics: Array<Diagnostic.Located>
  readonly regions: Array<Tir.RegionId>
  readonly loops: Array<Tir.LoopId>
  readonly staticIterations: Array<StaticIterationFact>
  readonly resolution: ResolutionContext
  readonly nextBindingOrdinal: { value: number }
  readonly regionBase?: number
  readonly effectBlock?: true
  readonly staticContext?: StaticAnalysisContext
  readonly returnType?: Type.Type
}

export interface ResolutionContext {
  /** The private publisher for the body currently being checked. */
  readonly builder?: BodyBuilder.BodyBuilder
  readonly bodyLifetimes?: BodyLifetime.BodyLifetime
  readonly lifetimeCompatibility?: TypeCompatibility.Context
  /** The current eager execution boundary and its lexical loop destinations. */
  readonly execution?: {
    readonly context: BodyContext
    readonly loopStack: ReadonlyArray<Tir.LoopId>
  }
  readonly scope: NameResolution.ModuleScope
  readonly index: DeclarationIndex.Index
  readonly semantic: Semantic.Session
  /** Occurrence-generated aggregates are semantic facts, deliberately outside lexical lookup. */
  readonly generatedAggregates?: Map<string, DeclarationFacts.StructFact>
  readonly unsafeSpans?: ReadonlyArray<SourceSpan.SourceSpan>
  /** Exact direct-call spans acknowledged by the expression form `unsafe call(...)`. */
  readonly unsafeCallSpans?: ReadonlyArray<SourceSpan.SourceSpan>
  readonly nextBindingOrdinal?: { value: number }
  /** The authored declaration whose body is being analyzed, for declaration-scoped lifetimes. */
  readonly authoredDeclaration?: AuthoredHir.Declaration
  readonly executableFunction?: DeclarationId
  readonly executableOwner?: DeclarationFacts.CanonicalId
  /** Stable authored executable-site ordinals keyed independently of TIR node allocation. */
  readonly executableSiteOrdinals?: ReadonlyMap<string, number>
  /** Mutable callable bindings whose authored initializer is no longer their exact runtime value. */
  readonly writtenCallableBindings?: Set<number>
  /** Publishes tooling rows before the short-lived semantic decision is discarded. */
  readonly publishExpressionDecision?: (decision: ExpressionDecision) => void
  readonly staticContext?: StaticAnalysisContext
  /** Static calls under ordinary control in a static function execute only after branch selection. */
  readonly deferStaticCalls?: true
  /** Hidden anonymous bodies discovered while analyzing the current context declaration. */
  readonly hiddenFunctions?: Array<FunctionAnalysis>
  /** Anonymous bodies are parsed recursively but only the outermost body is admitted in slice one. */
  readonly anonymousDepth?: number
}

const aggregateKey = (nominal: Type.Nominal): string => `${nominal.module}:${nominal.name}`

export const aggregateByNominal = (
  resolution: ResolutionContext,
  nominal: Type.Nominal,
): DeclarationFacts.StructFact | undefined => {
  const generated = resolution.generatedAggregates?.get(aggregateKey(nominal))
  if (generated !== undefined) return generated
  const member = DeclarationFacts.byCanonical(resolution.index, {
    _tag: 'CanonicalDeclarationId',
    module: nominal.module,
    name: nominal.name,
  })
  return member?._tag === 'StructDeclaration' ? member : undefined
}

export const unsafeCallAuthorized = (
  resolution: ResolutionContext | undefined,
  call: AuthoredHir.Expression,
  callSpan: SourceSpan.SourceSpan,
): boolean =>
  resolution !== undefined &&
  ((resolution.unsafeSpans ?? []).some(
    (span) =>
      span.sourceId === callSpan.sourceId &&
      span.start <= callSpan.start &&
      span.end >= callSpan.end,
  ) ||
    (resolution.unsafeCallSpans ?? []).some(
      (span) =>
        span.sourceId === callSpan.sourceId &&
        span.start === callSpan.start &&
        span.end === callSpan.end,
    ))
