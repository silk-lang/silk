import * as Lifetime from './Lifetime.js'
import * as DeclarationFacts from './DeclarationFacts.js'
import { genericArgumentOfTypeArgument } from './CallResolution.js'
import type * as AuthoredHir from './AuthoredHir.js'
import type * as ConformanceGoal from './ConformanceGoal.js'
import * as Constraint from './Constraint.js'
import * as Diagnostic from './Diagnostic.js'
import type * as Location from './Location.js'
import type {
  ArgumentFact,
  AssignmentRootFact,
  CallReferenceFact,
  DeclarationId,
  ExpressionDecision,
  ExpressionTypeFact,
  ParameterReferenceFact,
  PatternSelectionFact,
  SemanticType,
} from './Elaboration.js'
import {
  assignmentRootAccess,
  constructionExpressionAnchor,
  constructionExpressionType,
  contextualIntegerCompatible,
  retainedResultArguments,
  retainsLifetimes,
} from './Elaboration.js'
import { representationOfExpression } from './ExpressionAnalysis.js'
import * as Tir from './Tir.js'
import * as Intrinsic from './Intrinsic.js'
import * as TypeInference from './internal/TypeInference.js'
import * as SemanticContext from './SemanticContext.js'
import * as Match from './Match.js'
import * as Scalar from './Scalar.js'
import type * as StaticText from './StaticText.js'
import type * as StaticValue from './StaticValue.js'
import * as Type from './Type.js'
import * as TypeCompatibility from './TypeCompatibility.js'
import * as BodyArena from './internal/BodyArena.js'

export * from './internal/BodyArena.js'

/** One statement's ephemeral semantic decision, consumed immediately into its typed TIR node. */
export type StatementDraft =
  | {
      readonly _tag: 'UnsafeStatement'
      readonly statements: ReadonlyArray<Tir.Statement>
      readonly region: Tir.RegionId
      readonly anchor: AuthoredHir.Anchor
    }
  | {
      readonly _tag: 'BindStatement'
      readonly binding: import('./Elaboration.js').BindingDeclarationFact
      readonly region: Tir.RegionId
    }
  | {
      readonly _tag: 'PatternBindStatement'
      readonly selection: PatternSelectionFact
      readonly region: Tir.RegionId
      readonly anchor: AuthoredHir.Anchor
    }
  | {
      readonly _tag: 'ExpressionStatement'
      readonly expression: Tir.Expression
      readonly region: Tir.RegionId
      readonly anchor: AuthoredHir.Anchor
    }
  | {
      readonly _tag: 'IfStatement'
      readonly condition: Tir.Expression
      readonly taken: ReadonlyArray<Tir.Statement>
      readonly otherwise: ReadonlyArray<Tir.Statement>
      readonly region: Tir.RegionId
      readonly anchor: AuthoredHir.Anchor
    }
  | {
      readonly _tag: 'IfLetStatement'
      readonly selection: PatternSelectionFact
      readonly taken: ReadonlyArray<Tir.Statement>
      readonly otherwise: ReadonlyArray<Tir.Statement>
      readonly region: Tir.RegionId
      readonly anchor: AuthoredHir.Anchor
    }
  | {
      readonly _tag: 'WriteStatement'
      readonly destination: Tir.Expression
      readonly root?: AssignmentRootFact
      readonly value: Tir.Expression
      readonly compatible: boolean
      readonly lifetimeProof: ReadonlyArray<Lifetime.Outlives>
      readonly region: Tir.RegionId
      readonly anchor: AuthoredHir.Anchor
    }
  | {
      readonly _tag: 'WhileStatement'
      readonly loop: Tir.LoopId
      readonly parent?: Tir.LoopId
      readonly condition: Tir.Expression
      readonly body: ReadonlyArray<Tir.Statement>
      readonly region: Tir.RegionId
      readonly anchor: AuthoredHir.Anchor
    }
  | {
      readonly _tag: 'BreakStatement'
      readonly target?: Tir.LoopId
      readonly region: Tir.RegionId
      readonly anchor: AuthoredHir.Anchor
    }
  | {
      readonly _tag: 'ContinueStatement'
      readonly target?: Tir.LoopId
      readonly region: Tir.RegionId
      readonly anchor: AuthoredHir.Anchor
    }
  | {
      readonly _tag: 'ReturnStatement'
      readonly expression: Tir.Expression
      readonly implicit?: true
      readonly region: Tir.RegionId
      readonly anchor: AuthoredHir.Anchor
    }
  | {
      readonly _tag: 'FailStatement'
      readonly expression: Tir.Expression
      readonly failure?: Type.Type
      readonly transfer: 'Copy' | 'Move'
      readonly region: Tir.RegionId
      readonly anchor: AuthoredHir.Anchor
    }
  | {
      readonly _tag: 'DropStatement'
      readonly expression: Tir.Expression
      readonly region: Tir.RegionId
      readonly anchor: AuthoredHir.Anchor
    }

const publishedCause = (
  builder: BodyArena.BodyBuilder | undefined,
  cause: Diagnostic.Identity<Location.Location>,
): { readonly cause: Tir.CauseRef } => {
  if (builder === undefined) throw new RangeError('TIR cause requires its body builder')
  return { cause: BodyArena.cause(builder, cause) }
}

const publishedEvidence = (
  builder: BodyArena.BodyBuilder | undefined,
  constraints: ReadonlyArray<Constraint.ConstraintEvidence>,
  conformances: ReadonlyArray<ConformanceGoal.Proof> = [],
): Tir.EvidenceRef => {
  if (builder === undefined) throw new RangeError('TIR evidence requires its body builder')
  return BodyArena.selectedEvidence(builder, { constraints, conformances })
}

const localOf = (options: LowerStatementOptions, semantic: unknown): Tir.LocalId => {
  if (options.builder === undefined) throw new RangeError('TIR local requires its body builder')
  return BodyArena.localId(options.builder, semantic)
}

export const tirReference = (
  reference: ParameterReferenceFact,
  type: ExpressionTypeFact,
  anchor: AuthoredHir.Anchor,
  context: SemanticContext.SemanticContext,
  builder?: BodyArena.BodyBuilder,
): Tir.Expression => {
  const span = context.spanOf(anchor)
  const origin = Tir.authored(anchor)
  if (reference._tag === 'Resolved' && type._tag === 'Available') {
    if (builder === undefined) throw new RangeError('TIR local requires its body builder')
    return {
      _tag: 'ParameterReference',
      parameter: BodyArena.semanticLocal(builder, reference.parameter, {
        kind: 'Parameter',
        ...(reference.parameter.name._tag === 'Present'
          ? { name: reference.parameter.name.spelling }
          : {}),
        type: type.type,
        mutability: reference.parameter.bindingMutability,
      }),
      type: type.type,
      span,
      origin,
    }
  }
  if (reference._tag === 'ResolvedBinding' && type._tag === 'Available') {
    if (builder === undefined) throw new RangeError('TIR local requires its body builder')
    return {
      _tag: 'BindingReference',
      binding: BodyArena.semanticLocal(builder, reference.binding, {
        kind: 'Binding',
        ...(reference.binding.name._tag === 'Present'
          ? { name: reference.binding.name.spelling }
          : {}),
        type: type.type,
        mutability: reference.binding.mutability,
      }),
      type: type.type,
      span,
      origin,
    }
  }
  if (reference._tag === 'ResolvedPattern' && type._tag === 'Available') {
    if (builder === undefined) throw new RangeError('TIR local requires its body builder')
    return {
      _tag: 'PatternBindingReference',
      binding: BodyArena.semanticLocal(builder, reference.binding, {
        kind: 'Pattern',
        ...(reference.binding.name._tag === 'Present'
          ? { name: reference.binding.name.spelling }
          : {}),
        type: type.type,
        mutability: reference.binding.access === 'Place' ? 'Mutable' : 'Immutable',
      }),
      type: type.type,
      span,
      origin,
    }
  }
  return {
    _tag: 'Unavailable',
    span,
    origin,
    ...(reference._tag === 'Missing' && reference.cause !== undefined
      ? publishedCause(builder, reference.cause)
      : {}),
  }
}

/** The literal nodes of a value the evaluator produced for the authored position `anchor`. */
const staticValueExpression = (
  value: StaticValue.Value,
  type: SemanticType,
  anchor: AuthoredHir.Anchor,
  context: SemanticContext.SemanticContext,
  builder?: BodyArena.BodyBuilder,
): Tir.Expression => {
  const span = context.spanOf(anchor)
  const origin = Tir.synthetic(anchor, 'static-result')
  const nested = (value: StaticValue.Value, type: SemanticType): Tir.Expression => {
    const expression = staticValueExpression(value, type, anchor, context, builder)
    return expression._tag === 'Unavailable' || builder === undefined
      ? expression
      : BodyArena.node(builder, expression)
  }
  switch (value._tag) {
    case 'UnitValue':
      return { _tag: 'UnitLiteral', type: Type.unit, span, origin }
    case 'BooleanValue':
      return {
        _tag: 'BooleanLiteral',
        value: value.value,
        type: 'bool',
        span,
        origin,
      }
    case 'CharacterValue':
      return {
        _tag: 'CharacterLiteral',
        value: value.value,
        type: 'char',
        span,
        origin,
      }
    case 'IntegerValue':
      return {
        _tag: 'IntegerLiteral',
        value: value.value,
        type: value.type,
        span,
        origin,
      }
    case 'FloatValue':
      return {
        _tag: 'FloatingLiteral',
        bits: value.bits,
        spelling: `${value.type}(bits=0x${value.bits.toString(16)})`,
        type: value.type,
        span,
        origin,
      }
    case 'TextValue': {
      const data: StaticText.Data = {
        _tag: 'StaticData',
        id: `text:${value.bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('')}`,
        kind: 'Text',
        bytes: value.bytes,
        utf8: true,
      }
      return {
        _tag: 'StaticStringLiteral',
        data,
        ...(value.origin === undefined ? {} : { textOrigin: value.origin }),
        type: Type.string(Lifetime.staticLifetime),
        span,
        origin,
      }
    }
    case 'EnumValue':
      return Type.isNominal(type)
        ? {
            _tag: 'EnumMember',
            enum: value.type,
            member: {
              _tag: 'CanonicalEnumMemberId',
              enum: value.type,
              name: value.member,
            },
            discriminant: value.discriminant,
            type,
            span,
            origin,
          }
        : { _tag: 'Unavailable', span, origin }
    case 'AggregateValue': {
      if (value.identity._tag === 'ArrayAggregateIdentity' && Type.isFixedArray(type)) {
        const elements = value.fields.map((field) => nested(field.value, type.element))
        return elements.some((element) => element._tag === 'Unavailable')
          ? { _tag: 'Unavailable', span, origin }
          : { _tag: 'ArrayConstruct', elements, type, span, origin }
      }
      if (
        value.identity._tag !== 'NominalAggregateIdentity' ||
        !Type.isNominal(type) ||
        value.runtimeFields === undefined ||
        value.runtimeFields.length !== value.fields.length
      )
        return { _tag: 'Unavailable', span, origin }
      const fields = value.fields.flatMap((field) => {
        const runtime = value.runtimeFields?.find(
          (candidate) => candidate.id.ordinal === field.ordinal,
        )
        if (runtime === undefined) return []
        const expression = nested(field.value, runtime.type)
        return expression._tag === 'Unavailable' ? [] : [{ field: runtime.id, value: expression }]
      })
      if (fields.length !== value.fields.length) return { _tag: 'Unavailable', span, origin }
      const evaluationOrder = fields.map((field) => field.field)
      const variant = value.identity.variant
      return variant === undefined
        ? {
            _tag: 'Construct',
            nominal: type,
            evaluationOrder,
            fields: fields,
            type,
            span,
            origin,
          }
        : {
            _tag: 'ConstructUnionVariant',
            nominal: type,
            variant: {
              _tag: 'CanonicalUnionVariantId',
              union: value.identity.declaration,
              name: variant.name,
            },
            variantOrdinal: variant.ordinal,
            evaluationOrder,
            fields: fields,
            type,
            span,
            origin,
          }
    }
    case 'TypeDescriptorValue':
    case 'FieldDescriptorValue':
    case 'FieldCollectionValue':
    case 'StaticSequenceValue':
    case 'TestDescriptorValue':
    case 'TestCollectionValue':
      return { _tag: 'Unavailable', span, origin }
  }
}

export const tirPatternSelection = (
  selection: PatternSelectionFact,
  options: LowerStatementOptions,
): Tir.PatternSelection => {
  if (options.builder === undefined) throw new RangeError('TIR locals require their body builder')
  const builder = options.builder
  let member: Match.CoverageIdentity | undefined
  if (selection.pattern._tag === 'EnumMemberPattern') {
    member = selection.pattern.coverage
  } else if (selection.pattern._tag === 'UnionVariantPattern') {
    member = selection.pattern.coverage
  } else if (
    (selection.pattern._tag === 'NominalPattern' || selection.pattern._tag === 'TypePattern') &&
    selection.pattern.member !== undefined
  ) {
    member = Match.structuralMember(selection.pattern.member)
  }
  const subject = tirExpression(selection.subject, options)
  const lowered = {
    id: selection.id,
    tests: selection.tests,
    arm: selection.arm,
    access: selection.access,
    source: tirExpression(selection.source, options),
    subject:
      selection.access === 'Move' && (subject._tag === 'Project' || subject._tag === 'IndexPlace')
        ? { ...subject, access: 'ConsumeRequested' as const }
        : subject,
    members: selection.members,
    ...(member === undefined ? {} : { member }),
    universal: selection.pattern._tag === 'UniversalPattern',
    bindings: selection.bindings.flatMap((binding): ReadonlyArray<Tir.PatternBinding> =>
      binding.type._tag === 'Available'
        ? [
            {
              id: BodyArena.semanticLocal(builder, binding, {
                kind: 'Pattern',
                ...(binding.name._tag === 'Present' ? { name: binding.name.spelling } : {}),
                type: binding.type.type,
                mutability: binding.access === 'Place' ? 'Mutable' : 'Immutable',
              }),
              ...(binding.name._tag === 'Present' ? { name: binding.name.spelling } : {}),
              ...(binding.field === undefined ? {} : { field: binding.field.id }),
              path: binding.path,
              type: binding.type.type,
              access: binding.access,
              span: options.context.spanOf(binding.anchor),
              origin: Tir.authored(binding.anchor),
            },
          ]
        : [],
    ),
    cleanup: selection.pattern.omitted,
    irrefutable: selection.irrefutable,
    loanEnd: selection.loanEnd,
    loanEndAt: selection.loanEndAt,
    span: options.context.spanOf(selection.anchor),
    origin: Tir.authored(selection.anchor),
  }
  builder.semanticPatternSelections.set(lowered, selection)
  return lowered
}

export interface LowerStatementOptions {
  /** The artifact-local publisher used by direct construction. */
  readonly builder?: BodyArena.BodyBuilder
  /** Spans of the authored module being lowered; TIR retains spans for diagnostics only. */
  readonly context: SemanticContext.SemanticContext
  /**
   * Keeps static structure for the evaluator: static calls, compile errors, static intrinsics and
   * references to static locals stay nodes instead of becoming the values they selected.
   *
   * The map remembers the node of every lowered expression. The evaluator keeps provenance per
   * node, so a subexpression must lower to the same node each time its parent is evaluated.
   */
  readonly static?: WeakMap<object, Tir.Expression>
  readonly lifetimeAssumptions?: Lifetime.Assumptions
  readonly lifetimeCompatibility?: TypeCompatibility.Context
  readonly resultType?: SemanticType
  /** The declaration-owned opaque family constructed at this function's return boundary. */
  readonly opaqueResultFamily?: Type.OpaqueFamilyKey
  /** A composite Effect representation every return site packs into (EFF-013). */
  readonly resultRepresentation?: SemanticType
  readonly functionId?: DeclarationId
  readonly eraseIntrinsicSections?: boolean
}

const lifetimeAssumptionsOf = (options: LowerStatementOptions): Lifetime.Assumptions =>
  options.lifetimeAssumptions ??
  options.lifetimeCompatibility?.assumptions ??
  Lifetime.assumptions([])

const provesOutlives = (
  options: LowerStatementOptions,
  longer: Lifetime.Lifetime,
  shorter: Lifetime.Lifetime,
): boolean =>
  Lifetime.outlives(lifetimeAssumptionsOf(options), longer, shorter) ||
  options.lifetimeCompatibility?.outlives?.(longer, shorter) === true

const retainedArguments = (
  fact: ExpressionDecision,
  options: LowerStatementOptions,
): ReadonlyArray<ArgumentFact> => {
  const proven = retainedResultArguments(fact, lifetimeAssumptionsOf(options), (longer, shorter) =>
    provesOutlives(options, longer, shorter),
  )
  if (
    fact._tag !== 'Call' ||
    fact.reference._tag !== 'Resolved' ||
    fact.contract._tag !== 'Compatible' ||
    fact.type._tag !== 'Available'
  )
    return proven
  // Direct TIR construction precedes the body's solved lifetime graph. The substituted callable
  // contract still identifies arguments whose storage is carried by the result, even when the
  // actual-to-parameter outlives edge has only just been installed.
  const retained = new Map(proven.map((argument) => [argument.id.ordinal, argument]))
  for (const [ordinal, argument] of fact.arguments.entries()) {
    const parameter = fact.reference.declaration.parameters.at(ordinal)
    if (parameter?.declaredType._tag !== 'Resolved') continue
    const source = Type.substitute(parameter.declaredType.type, fact.contract.substitution)
    const result = fact.type.type
    const carries =
      Type.isReference(source) || Type.isSlice(source)
        ? Type.storageLifetimes(result).some(
            (output) =>
              output._tag !== 'StaticLifetime' && provesOutlives(options, source.lifetime, output),
          )
        : retainsLifetimes(source, result, lifetimeAssumptionsOf(options), (longer, shorter) =>
            provesOutlives(options, longer, shorter),
          )
    if (carries) retained.set(argument.id.ordinal, argument)
  }
  return [...retained.values()]
}

const retainedDirectBorrowOrdinals = (
  fact: ExpressionDecision,
  retained: ReadonlySet<number>,
): ReadonlySet<number> => {
  if (fact._tag !== 'Call' || fact.reference._tag !== 'Resolved') return retained
  const declaration = fact.reference.declaration
  const returnType = declaration.returnType
  if (declaration.functionKind !== 'Ordinary' || returnType._tag !== 'Resolved') return retained
  const result = returnType.type
  const assumptions = Lifetime.assumptions(
    DeclarationFacts.executableLifetimes(declaration).lifetimeBounds ?? [],
  )
  return new Set(
    [...retained].filter((ordinal) => {
      const parameter = declaration.parameters.at(ordinal)?.declaredType
      if (parameter?._tag !== 'Resolved') return true
      const source = parameter.type
      if (Type.isReference(source) || Type.isSlice(source))
        return Type.storageLifetimes(result).some(
          (output) =>
            output._tag !== 'StaticLifetime' &&
            Lifetime.outlives(assumptions, source.lifetime, output),
        )
      return retainsLifetimes(source, result, assumptions)
    }),
  )
}

const publishExpression = (
  options: LowerStatementOptions,
  expression: Tir.Expression,
): Tir.Expression =>
  expression.id !== undefined || options.builder === undefined
    ? expression
    : BodyArena.node(options.builder, expression)

const publishExpectedExpression = (
  options: LowerStatementOptions,
  expression: Tir.Expression,
  fact: ConstructionExpression,
): Tir.Expression => {
  const published = publishExpression(options, expression)
  if (options.builder === undefined) return published
  const semantic = 'origin' in fact ? BodyArena.semanticOfExpression(options.builder, fact) : fact
  if (typeof semantic === 'object' && semantic !== null)
    options.builder.semanticExpressions.set(published, semantic)
  return published
}

export const publishStatements = (
  facts: ReadonlyArray<StatementDraft>,
  options: LowerStatementOptions,
): ReadonlyArray<Tir.Statement> => {
  const lowered = facts
    .filter(
      (statement) =>
        (options.static !== undefined ||
          statement._tag !== 'BindStatement' ||
          statement.binding.phase === 'Runtime') &&
        (!options.eraseIntrinsicSections ||
          !(
            (statement._tag === 'BindStatement' &&
              statement.binding.exactCallable?._tag === 'CallableSection' &&
              statement.binding.exactCallable.reference._tag === 'ResolvedIntrinsicContract') ||
            (statement._tag === 'DropStatement' &&
              statement.expression._tag === 'CallableSection' &&
              statement.expression.target._tag === 'BuiltinCallableTarget' &&
              statement.expression.target.actor === 'Intrinsic')
          )),
    )
    .map((statement): Tir.Statement => {
      if (statement._tag === 'UnsafeStatement')
        return {
          _tag: 'Unsafe',
          statements: statement.statements,
          region: statement.region,
          span: options.context.spanOf(statement.anchor),
          origin: Tir.authored(statement.anchor),
        }
      if (statement._tag === 'BindStatement') {
        const binding = statement.binding
        const initializer = (): Tir.Expression => {
          // A declared union is the binding's type: the initializer injects at the boundary.
          if (binding.declaredType?._tag === 'Resolved' && Type.isUnion(binding.declaredType.type))
            return tirExpectedExpression(
              binding.initializer,
              binding.declaredType.type,
              'Binding',
              binding.anchor,
              options,
            )
          return tirExpression(binding.initializer, options)
        }
        return {
          _tag: 'Bind',
          binding:
            options.builder === undefined
              ? (() => {
                  throw new RangeError('TIR local requires its body builder')
                })()
              : BodyArena.localId(options.builder, binding.id),
          name: binding.name._tag === 'Present' ? binding.name.spelling : undefined,
          mutability: binding.mutability,
          initializer: initializer(),
          region: statement.region,
          span: options.context.spanOf(binding.anchor),
          origin: Tir.authored(binding.anchor),
        }
      }
      if (statement._tag === 'PatternBindStatement')
        return {
          _tag: 'PatternBind',
          selection: tirPatternSelection(statement.selection, options),
          region: statement.region,
          span: options.context.spanOf(statement.anchor),
          origin: Tir.authored(statement.anchor),
        }
      if (statement._tag === 'ExpressionStatement')
        return {
          _tag: 'Evaluate',
          expression: tirExpression(statement.expression, options),
          region: statement.region,
          span: options.context.spanOf(statement.anchor),
          origin: Tir.authored(statement.anchor),
        }
      if (statement._tag === 'IfStatement')
        return {
          _tag: 'If',
          condition: tirExpression(statement.condition, options),
          taken: statement.taken,
          otherwise: statement.otherwise,
          region: statement.region,
          span: options.context.spanOf(statement.anchor),
          origin: Tir.authored(statement.anchor),
        }
      if (statement._tag === 'IfLetStatement')
        return {
          _tag: 'IfLet',
          selection: tirPatternSelection(statement.selection, options),
          taken: statement.taken,
          otherwise: statement.otherwise,
          region: statement.region,
          span: options.context.spanOf(statement.anchor),
          origin: Tir.authored(statement.anchor),
        }
      if (statement._tag === 'WriteStatement') {
        const place =
          statement.root === undefined
            ? undefined
            : tirAssignmentWritePlace(statement.destination, statement.root, options)
        if (place === undefined || !statement.compatible)
          return {
            _tag: 'UnavailableStatement',
            write: {
              destination: tirExpression(statement.destination, options),
              value: tirExpression(statement.value, options),
            },
            region: statement.region,
            span: options.context.spanOf(statement.anchor),
            origin: Tir.authored(statement.anchor),
          }
        let valueOptions = options
        if (statement.lifetimeProof.length > 0) {
          const lifetimeAssumptions = Lifetime.assumptions([
            ...(options.lifetimeCompatibility?.assumptions.bounds ??
              options.lifetimeAssumptions?.bounds ??
              []),
            ...statement.lifetimeProof,
          ])
          // These are accepted conversion proofs for this RHS, not region edges active in
          // surrounding statements. The lifetime solver retains their installation points.
          valueOptions = {
            ...options,
            lifetimeAssumptions,
            lifetimeCompatibility: TypeCompatibility.context({
              ...options.lifetimeCompatibility,
              assumptions: lifetimeAssumptions,
            }),
          }
        }
        return {
          _tag: 'Write',
          destination: tirExpression(statement.destination, options),
          place,
          value: tirExpectedExpression(
            statement.value,
            place.type,
            'Assignment',
            place.origin.anchor,
            valueOptions,
          ),
          region: statement.region,
          span: options.context.spanOf(statement.anchor),
          origin: Tir.authored(statement.anchor),
        }
      }
      if (statement._tag === 'WhileStatement')
        return {
          _tag: 'While',
          loop: statement.loop,
          ...(statement.parent === undefined ? {} : { parent: statement.parent }),
          condition: tirExpression(statement.condition, options),
          body: statement.body,
          region: statement.region,
          span: options.context.spanOf(statement.anchor),
          origin: Tir.authored(statement.anchor),
        }
      if (statement._tag === 'BreakStatement' || statement._tag === 'ContinueStatement')
        return statement.target === undefined
          ? {
              _tag: 'UnavailableStatement',
              region: statement.region,
              span: options.context.spanOf(statement.anchor),
              origin: Tir.authored(statement.anchor),
            }
          : {
              _tag: statement._tag === 'BreakStatement' ? 'Break' : 'Continue',
              target: statement.target,
              region: statement.region,
              span: options.context.spanOf(statement.anchor),
              origin: Tir.authored(statement.anchor),
            }
      if (statement._tag === 'ReturnStatement')
        return {
          _tag: 'Return',
          expression: tirExpression(statement.expression, options),
          ...(statement.implicit === true ? { implicit: true as const } : {}),
          region: statement.region,
          span: statement.expression.span,
          origin: statement.expression.origin,
        }
      if (statement._tag === 'DropStatement')
        return {
          _tag: 'Drop',
          expression: tirExpression(statement.expression, options),
          region: statement.region,
          span: options.context.spanOf(statement.anchor),
          origin: Tir.authored(statement.anchor),
        }
      if (statement.failure === undefined)
        return {
          _tag: 'UnavailableStatement',
          region: statement.region,
          span: options.context.spanOf(statement.anchor),
          origin: Tir.authored(statement.anchor),
        }
      const expressionType = constructionExpressionType(statement.expression)
      return {
        _tag: 'Fail',
        expression:
          statement.transfer === 'Move'
            ? publishExpression(options, {
                _tag: 'Move',
                subject: tirExpression(statement.expression, options),
                type: expressionType._tag === 'Available' ? expressionType.type : statement.failure,
                span: statement.expression.span,
                origin: statement.expression.origin,
              })
            : tirExpression(statement.expression, options),
        failure: statement.failure,
        transfer: statement.transfer,
        region: statement.region,
        span: options.context.spanOf(statement.anchor),
        origin: Tir.authored(statement.anchor),
      }
    })
  return lowered.map((statement) =>
    options.builder === undefined ? statement : BodyArena.node(options.builder, statement),
  )
}

/** Completes return-boundary conversions once whole-body representation and lifetime facts exist. */
export const finalizeReturns = (
  statements: ReadonlyArray<Tir.Statement>,
  options: LowerStatementOptions,
): void => {
  if (options.builder === undefined)
    throw new RangeError('TIR return finalization requires its body builder')
  const builder = options.builder
  const visitExpression = (expression: Tir.Expression): void => {
    if (expression._tag === 'EffectBlock') return
    if (expression._tag === 'Match') {
      visitExpression(expression.scrutinee)
      for (const arm of expression.arms) {
        if (arm.guard !== undefined) visitExpression(arm.guard)
        if (arm.body._tag === 'Expression') visitExpression(arm.body.expression)
        else visitStatements(arm.body.statements)
      }
      return
    }
    for (const child of Tir.expressionChildren(expression)) visitExpression(child)
  }
  const visitStatements = (nested: ReadonlyArray<Tir.Statement>): void => {
    for (const statement of nested) {
      if (statement._tag === 'Return') {
        const converted = effectJoinConvert(
          options.resultType === undefined
            ? statement.expression
            : tirExpectedExpression(
                statement.expression,
                options.resultType,
                'Return',
                statement.origin.anchor,
                options,
              ),
          options.resultRepresentation,
          statement.origin.anchor,
          options,
        )
        BodyArena.revise(builder, statement, { expression: converted })
      }
      for (const expression of directStatementExpressions(statement))
        if ('origin' in expression) visitExpression(expression)
      if (statement._tag === 'Unsafe') visitStatements(statement.statements)
      else if (statement._tag === 'If' || statement._tag === 'IfLet') {
        visitStatements(statement.taken)
        visitStatements(statement.otherwise)
      } else if (statement._tag === 'While') visitStatements(statement.body)
    }
  }
  visitStatements(statements)
}

export const tirCallableTarget = (reference: CallReferenceFact): Tir.CallableTarget | undefined => {
  if (reference._tag === 'ResolvedBuiltin')
    return {
      _tag: 'BuiltinCallableTarget',
      actor: reference.actor,
      operation: reference.operation,
      intrinsic: reference.intrinsic,
    }
  if (reference._tag === 'Resolved' && reference.declaration.canonical._tag === 'Canonical')
    return {
      _tag: 'DeclarationCallableTarget',
      declaration: reference.declaration.canonical.id,
    }
  return undefined
}

export const argumentBorrowId = (
  argument: ArgumentFact,
  ordinal: number,
  call?: Tir.NodeRef,
): Tir.BorrowId | undefined => {
  const expression = argument.expression
  if (expression._tag !== 'ValueBorrow' && expression._tag !== 'SliceBorrow') return undefined
  if (call === undefined) throw new RangeError('argument borrow requires its call node reference')
  return {
    _tag: 'BorrowId',
    call,
    ordinal,
  }
}

export const loanEndsOf = (
  arguments_: ReadonlyArray<ArgumentFact>,
  call: Tir.NodeRef | undefined,
  retained: (ordinal: number) => boolean = () => true,
): ReadonlyArray<Tir.BorrowId> =>
  arguments_.flatMap((argument, ordinal) => {
    const borrow = argumentBorrowId(argument, ordinal, call)
    return borrow === undefined || !retained(ordinal) ? [] : [borrow]
  })

const isRepresentationIdenticalGenericForwarding = (
  declared: SemanticType,
  actual: SemanticType,
): boolean => {
  if (!Type.someSubterm(declared, Type.isParameter) || !Type.someSubterm(actual, Type.isParameter))
    return false
  const inferred = new Map<string, Type.GenericArgument>()
  const inference = TypeInference.inferOpenGenericArguments(declared, actual, inferred)
  return (
    inference.matches &&
    inference.conflicts.length === 0 &&
    Type.equals(Type.substitute(declared, inferred), actual)
  )
}

/** The nodes only a body that keeps static structure holds. */
const staticStructure = (
  fact: ExpressionDecision,
  options: LowerStatementOptions,
): Tir.Expression | undefined => {
  const span = options.context.spanOf(fact.anchor)
  const origin = Tir.authored(fact.anchor)
  const unavailable = (): Tir.Expression => ({ _tag: 'Unavailable', span, origin })
  if (fact._tag === 'CompileError')
    return {
      _tag: 'CompileError',
      message: tirExpression(fact.message, options),
      type: fact.type._tag === 'Available' ? fact.type.type : 'never',
      span,
      origin,
    }
  if (fact._tag === 'StaticText' && fact.data?.kind === 'Text' && fact.literal !== undefined)
    // Provenance names the literal itself, which can be narrower than the expression wrapping it.
    return {
      _tag: 'StaticStringLiteral',
      data: fact.data,
      type: Type.string(Lifetime.staticLifetime),
      span: options.context.spanOf(fact.literal),
      origin: Tir.authored(fact.literal),
    }
  if (fact._tag === 'Constant' && fact.value === undefined)
    return fact.declaration.canonical._tag === 'Canonical' && fact.type._tag === 'Available'
      ? {
          _tag: 'ConstantReference',
          declaration: fact.declaration.canonical.id,
          type: fact.type.type,
          span,
          origin,
        }
      : unavailable()
  if (fact._tag !== 'Call') return undefined
  if (
    options.builder?.artifact.request._tag === 'Specialize' &&
    fact.staticValue !== undefined &&
    fact.staticValue._tag !== 'TextValue' &&
    fact.type._tag === 'Available'
  ) {
    const value = staticValueExpression(
      fact.staticValue,
      fact.type.type,
      fact.anchor,
      options.context,
      options.builder,
    )
    if (value._tag !== 'Unavailable') return value
  }
  const typeArguments = fact.contract._tag === 'Compatible' ? fact.contract.typeArguments : []
  const arguments_ = fact.arguments.map((argument) => tirExpression(argument.expression, options))
  if (
    fact.reference._tag === 'ResolvedIntrinsicContract' &&
    fact.reference.intrinsic.id.actor === 'Intrinsic'
  )
    return {
      _tag: 'StaticIntrinsic',
      operation: fact.reference.intrinsic.id.name,
      typeArguments,
      arguments: arguments_,
      type: fact.type._tag === 'Available' ? fact.type.type : 'never',
      span,
      origin,
    }
  if (
    fact.reference._tag === 'Resolved' &&
    fact.reference.declaration.phase === 'Static' &&
    fact.reference.declaration.canonical._tag === 'Canonical'
  )
    return {
      _tag: 'StaticCall',
      target: fact.reference.declaration.canonical.id,
      typeArguments,
      evidence:
        fact.contract._tag === 'Compatible'
          ? fact.contract.evidence.map(Constraint.evidenceKey)
          : [],
      arguments: arguments_,
      ...(fact.staticFailure === undefined ? {} : { failure: fact.staticFailure }),
      ...(fact.staticTextSpan === undefined ? {} : { text: fact.staticTextSpan }),
      ...(fact.staticTextOrigin === undefined ? {} : { textOrigin: fact.staticTextOrigin }),
      type: fact.type._tag === 'Available' ? fact.type.type : 'never',
      span,
      origin,
    }
  return undefined
}

export type ConstructionExpression = ExpressionDecision | Tir.Expression

export const tirExpression = (
  fact: ConstructionExpression,
  options: LowerStatementOptions,
  borrow?: Tir.BorrowId,
): Tir.Expression => {
  if ('origin' in fact) {
    if (
      borrow !== undefined &&
      options.builder !== undefined &&
      (fact._tag === 'ValueBorrow' || fact._tag === 'SliceBorrow')
    )
      return BodyArena.revise(options.builder, fact, { borrow })
    return fact
  }
  const published =
    options.static === undefined && borrow === undefined
      ? options.builder?.expressions.get(fact)
      : undefined
  if (published !== undefined) return published
  const known = options.static?.get(fact)
  if (known !== undefined) return known
  const reserved =
    options.builder === undefined
      ? undefined
      : BodyArena.expressionNode(options.builder, fact.anchor)
  const self =
    options.builder === undefined || reserved === undefined
      ? undefined
      : BodyArena.reservedReference(options.builder, reserved)
  const lowered =
    (options.static === undefined && fact._tag !== 'CompileError'
      ? undefined
      : staticStructure(fact, options)) ?? residualExpression(fact, options, borrow, self)
  const representation = representationOfExpression(options.context, fact, options.builder)
  const retained = representation === undefined ? lowered : { ...lowered, representation }
  const node =
    options.builder === undefined || reserved === undefined || retained.id !== undefined
      ? retained
      : BodyArena.publish(options.builder, reserved, retained)
  options.static?.set(fact, node)
  if (options.builder !== undefined) {
    if (options.static === undefined) options.builder.expressions.set(fact, node)
    options.builder.semanticExpressions.set(node, fact)
  }
  return node
}

/** Recovers an ephemeral construction decision while its private body builder is alive. */
export const semanticOfExpression = (
  self: BodyArena.BodyBuilder,
  expression: Tir.Expression,
): ExpressionDecision | undefined =>
  BodyArena.semanticOfExpression(self, expression) as ExpressionDecision | undefined

/** Recovers an ephemeral pattern decision while its private body builder is alive. */
export const semanticOfPatternSelection = (
  self: BodyArena.BodyBuilder,
  selection: Tir.PatternSelection,
): PatternSelectionFact | undefined =>
  self.semanticPatternSelections.get(selection) as PatternSelectionFact | undefined

/**
 * The target arguments a constrained section's hidden identity names before its application.
 *
 * The section's callable schema lists the binders it leaves open for the complete application;
 * each becomes its section-scoped binder wherever it occurs, including inside a selected argument
 * such as `B := Option<A>`. A binder the schema selects keeps its selection, even when that
 * selection is the enclosing function's own parameter of the same name (a function sectioning
 * itself), which owner substitution later closes. The selection is composed to a fixpoint first so a binder
 * reached only through another selected binder is still found. Lifetimes stay as they are:
 * runtime identity erases them and applications instantiate them per invocation.
 */
const sectionIdentityArguments = (
  parameters: ReadonlyArray<Type.Parameter>,
  selection: Type.Substitution,
  schema: Type.CallableSchema | undefined,
  enclosing: boolean,
): ReadonlyArray<Type.GenericArgument> => {
  const unapplied = new Map<string, Type.GenericArgument>()
  for (const binder of schema?.binders ?? []) {
    if (binder.kind === 'Lifetime' || schema?.substitution.has(Type.key(binder)) === true) continue
    unapplied.set(Type.key(binder), Type.parameterArgument(Type.sectionBinder(binder)))
  }
  const selected = new Map(
    [...selection].filter(
      ([parameter]) =>
        !unapplied.has(parameter) &&
        parameters.some((candidate) => Type.key(candidate) === parameter),
    ),
  )
  // In a function sectioning itself, selection values name the enclosing function's parameters,
  // which share their keys with the target's binders; they are kept verbatim for owner substitution.
  if (enclosing)
    return parameters.map(
      (parameter) =>
        selected.get(Type.key(parameter)) ??
        unapplied.get(Type.key(parameter)) ??
        Type.parameterArgument(parameter),
    )
  for (let pass = 0; pass < parameters.length; pass += 1) {
    let changed = false
    for (const [parameter, argument] of selected) {
      const composed = Type.substituteGenericArgument(argument, selected)
      if (Type.genericArgumentKey(composed) === Type.genericArgumentKey(argument)) continue
      selected.set(parameter, composed)
      changed = true
    }
    if (!changed) break
  }
  return parameters.map((parameter) => {
    const argument = selected.get(Type.key(parameter))
    if (argument !== undefined) return Type.substituteGenericArgument(argument, unapplied)
    return unapplied.get(Type.key(parameter)) ?? Type.parameterArgument(parameter)
  })
}

const residualExpression = (
  fact: ExpressionDecision,
  options: LowerStatementOptions,
  borrow?: Tir.BorrowId,
  self?: Tir.NodeRef,
): Tir.Expression => {
  if (fact._tag === 'CompileError')
    return {
      _tag: 'Unavailable',
      span: options.context.spanOf(fact.anchor),
      origin: Tir.authored(fact.anchor),
    }
  if (fact._tag === 'ShortCircuit') {
    const left = fact.arguments.at(0)
    const right = fact.arguments.at(1)
    if (left === undefined || right === undefined || fact.type._tag !== 'Available') {
      return {
        _tag: 'Unavailable',
        span: options.context.spanOf(fact.anchor),
        origin: Tir.authored(fact.anchor),
      }
    }
    const loweredLeft = tirExpression(left.expression, options)
    const loweredRight = tirExpression(right.expression, options)
    return loweredLeft._tag === 'Unavailable' || loweredRight._tag === 'Unavailable'
      ? {
          _tag: 'Unavailable',
          span: options.context.spanOf(fact.anchor),
          origin: Tir.authored(fact.anchor),
        }
      : {
          _tag: 'ShortCircuit',
          operator: fact.operator,
          left: loweredLeft,
          right: loweredRight,
          type: fact.type.type,
          span: options.context.spanOf(fact.anchor),
          origin: Tir.authored(fact.anchor),
        }
  }
  if (fact._tag === 'Integer') {
    return fact.integer._tag === 'Available' && fact.type._tag === 'Available'
      ? {
          _tag: 'IntegerLiteral',
          value: fact.integer.value,
          type: fact.type.type,
          span: options.context.spanOf(fact.anchor),
          origin: Tir.authored(fact.anchor),
        }
      : {
          _tag: 'Unavailable',
          span: options.context.spanOf(fact.anchor),
          origin: Tir.authored(fact.anchor),
        }
  }
  if (fact._tag === 'Duration') {
    return fact.value !== undefined && fact.type._tag === 'Available'
      ? {
          _tag: 'IntegerLiteral',
          value: fact.value,
          type: 'u64',
          span: options.context.spanOf(fact.anchor),
          origin: Tir.authored(fact.anchor),
        }
      : {
          _tag: 'Unavailable',
          span: options.context.spanOf(fact.anchor),
          origin: Tir.authored(fact.anchor),
        }
  }
  if (fact._tag === 'Floating') {
    return fact.floating._tag === 'Available' && fact.type._tag === 'Available'
      ? {
          _tag: 'FloatingLiteral',
          bits: fact.floating.bits,
          spelling: fact.floating.spelling,
          type: fact.floating.type,
          span: options.context.spanOf(fact.anchor),
          origin: Tir.authored(fact.anchor),
        }
      : {
          _tag: 'Unavailable',
          span: options.context.spanOf(fact.anchor),
          origin: Tir.authored(fact.anchor),
        }
  }
  if (fact._tag === 'StaticText') {
    if (fact.data === undefined) {
      return {
        _tag: 'Unavailable',
        span: options.context.spanOf(fact.anchor),
        origin: Tir.authored(fact.anchor),
      }
    }
    if (fact.data.kind === 'Text') {
      return {
        _tag: 'StaticStringLiteral',
        data: fact.data,
        type: Type.string(Lifetime.staticLifetime),
        span: options.context.spanOf(fact.anchor),
        origin: Tir.authored(fact.anchor),
      }
    }
    return {
      _tag: 'StaticByteViewLiteral',
      data: fact.data,
      type: Type.slice('Shared', 'u8', Lifetime.staticLifetime),
      span: options.context.spanOf(fact.anchor),
      origin: Tir.authored(fact.anchor),
    }
  }
  if (fact._tag === 'Unit') {
    return {
      _tag: 'UnitLiteral',
      type: Type.unit,
      span: options.context.spanOf(fact.anchor),
      origin: Tir.authored(fact.anchor),
    }
  }
  if (fact._tag === 'Boolean') {
    return fact.type._tag === 'Available'
      ? {
          _tag: 'BooleanLiteral',
          value: fact.value,
          type: fact.type.type,
          span: options.context.spanOf(fact.anchor),
          origin: Tir.authored(fact.anchor),
        }
      : {
          _tag: 'Unavailable',
          span: options.context.spanOf(fact.anchor),
          origin: Tir.authored(fact.anchor),
        }
  }
  if (fact._tag === 'Character') {
    return fact.type._tag === 'Available' && fact.value !== undefined
      ? {
          _tag: 'CharacterLiteral',
          value: fact.value,
          type: fact.type.type,
          span: options.context.spanOf(fact.anchor),
          origin: Tir.authored(fact.anchor),
        }
      : {
          _tag: 'Unavailable',
          span: options.context.spanOf(fact.anchor),
          origin: Tir.authored(fact.anchor),
        }
  }
  if (fact._tag === 'Constant') {
    const constant =
      fact.declaration.canonical._tag === 'Canonical'
        ? { constant: fact.declaration.canonical.id }
        : {}
    if (fact.value?._tag === 'Character')
      return {
        _tag: 'CharacterLiteral',
        value: fact.value.value,
        type: 'char',
        ...constant,
        span: options.context.spanOf(fact.anchor),
        origin: Tir.authored(fact.anchor),
      }
    if (fact.value?._tag === 'Boolean')
      return {
        _tag: 'BooleanLiteral',
        value: fact.value.value,
        type: 'bool',
        ...constant,
        span: options.context.spanOf(fact.anchor),
        origin: Tir.authored(fact.anchor),
      }
    if (fact.value?._tag === 'Integer')
      return {
        _tag: 'IntegerLiteral',
        value: fact.value.value,
        type: fact.value.type,
        ...constant,
        span: options.context.spanOf(fact.anchor),
        origin: Tir.authored(fact.anchor),
      }
    if (fact.value?._tag === 'Floating')
      return {
        _tag: 'FloatingLiteral',
        bits: fact.value.bits,
        spelling: fact.value.spelling,
        type: fact.value.type,
        ...constant,
        span: options.context.spanOf(fact.anchor),
        origin: Tir.authored(fact.anchor),
      }
    if (fact.value?._tag === 'String')
      return {
        _tag: 'StaticStringLiteral',
        data: fact.value.data,
        type: Type.string(Lifetime.staticLifetime),
        ...constant,
        span: options.context.spanOf(fact.anchor),
        origin: Tir.authored(fact.anchor),
      }
    if (fact.declaration.canonical._tag === 'Canonical' && fact.type._tag === 'Available')
      return {
        _tag: 'ConstantReference',
        declaration: fact.declaration.canonical.id,
        type: fact.type.type,
        span: options.context.spanOf(fact.anchor),
        origin: Tir.authored(fact.anchor),
      }
    return {
      _tag: 'Unavailable',
      span: options.context.spanOf(fact.anchor),
      origin: Tir.authored(fact.anchor),
    }
  }
  if (fact._tag === 'ForeignStatic') {
    return fact.type._tag === 'Available' && fact.declaration.canonical._tag === 'Canonical'
      ? {
          _tag: 'ForeignStaticLoad',
          declaration: fact.declaration.canonical.id,
          direction: fact.declaration.direction,
          symbol: fact.declaration.foreign.symbol,
          type: fact.type.type,
          span: options.context.spanOf(fact.anchor),
          origin: Tir.authored(fact.anchor),
        }
      : {
          _tag: 'Unavailable',
          span: options.context.spanOf(fact.anchor),
          origin: Tir.authored(fact.anchor),
        }
  }
  if (fact._tag === 'EnumMember') {
    if (
      fact.enum.canonical._tag !== 'Canonical' ||
      fact.member?.canonical._tag !== 'Canonical' ||
      fact.member.discriminant._tag !== 'Available' ||
      fact.type._tag !== 'Available' ||
      !Type.isNominal(fact.type.type)
    )
      return {
        _tag: 'Unavailable',
        span: options.context.spanOf(fact.anchor),
        origin: Tir.authored(fact.anchor),
        ...(fact.cause === undefined ? {} : publishedCause(options.builder, fact.cause)),
      }
    return {
      _tag: 'EnumMember',
      enum: fact.enum.canonical.id,
      member: fact.member.canonical.id,
      discriminant: fact.member.discriminant.value,
      type: fact.type.type,
      span: options.context.spanOf(fact.anchor),
      origin: Tir.authored(fact.anchor),
    }
  }
  if (fact._tag === 'EnumValue') {
    const value = tirExpression(fact.argument, options)
    return fact.type._tag !== 'Available' || value._tag === 'Unavailable'
      ? {
          _tag: 'Unavailable',
          span: options.context.spanOf(fact.anchor),
          origin: Tir.authored(fact.anchor),
        }
      : {
          _tag: 'EnumValue',
          enum: fact.operation.enum,
          value,
          intrinsic: fact.operation.intrinsic,
          type: fact.operation.result.spelling,
          span: options.context.spanOf(fact.anchor),
          origin: Tir.authored(fact.anchor),
        }
  }
  if (fact._tag === 'Identifier') {
    const specializedNonTextValue =
      options.builder?.artifact.request._tag === 'Specialize' &&
      fact.staticValue !== undefined &&
      fact.staticValue._tag !== 'TextValue'
    const materializeStaticReference =
      options.static === undefined ||
      specializedNonTextValue ||
      (fact.reference._tag === 'ResolvedBinding' && fact.reference.binding.staticIteration === true)
    if (
      materializeStaticReference &&
      fact.staticValue !== undefined &&
      fact.type._tag === 'Available'
    ) {
      const value = staticValueExpression(
        fact.staticValue,
        fact.type.type,
        fact.anchor,
        options.context,
        options.builder,
      )
      if (value._tag !== 'Unavailable') return value
    }
    if (
      materializeStaticReference &&
      fact.reference._tag === 'ResolvedBinding' &&
      fact.reference.binding.staticValue !== undefined &&
      fact.type._tag === 'Available'
    ) {
      const value = staticValueExpression(
        fact.reference.binding.staticValue,
        fact.type.type,
        fact.anchor,
        options.context,
        options.builder,
      )
      if (value._tag !== 'Unavailable') return value
    }
    return tirReference(
      fact.reference,
      fact.originalType === undefined ? fact.type : { _tag: 'Available', type: fact.originalType },
      fact.anchor,
      options.context,
      options.builder,
    )
  }
  if (fact._tag === 'Move') {
    const subject = tirExpression(fact.subject, options)
    if (subject._tag === 'Unavailable' || fact.type._tag !== 'Available')
      return {
        _tag: 'Unavailable',
        span: options.context.spanOf(fact.anchor),
        origin: Tir.authored(fact.anchor),
      }
    return {
      _tag: 'Move',
      subject:
        subject._tag === 'Project' || subject._tag === 'IndexPlace'
          ? { ...subject, access: 'ConsumeRequested' as const }
          : subject,
      type: fact.originalType ?? fact.type.type,
      span: options.context.spanOf(fact.anchor),
      origin: Tir.authored(fact.anchor),
    }
  }
  if (fact._tag === 'PlaceReplace') {
    const place =
      fact.root === undefined
        ? undefined
        : tirAssignmentWritePlace(fact.destination, fact.root, options)
    if (place === undefined || !fact.compatible || fact.type._tag !== 'Available') {
      return {
        _tag: 'Unavailable',
        span: options.context.spanOf(fact.anchor),
        origin: Tir.authored(fact.anchor),
      }
    }
    return {
      _tag: 'Replace',
      place,
      value: tirExpectedExpression(
        fact.value,
        place.type,
        'Assignment',
        place.origin.anchor,
        options,
      ),
      type: fact.type.type,
      span: options.context.spanOf(fact.anchor),
      origin: Tir.authored(fact.anchor),
    }
  }
  if (fact._tag === 'EffectBlock') {
    if (fact.type._tag !== 'Available' || !Type.isEffect(fact.type.type))
      return {
        _tag: 'Unavailable',
        span: options.context.spanOf(fact.anchor),
        origin: Tir.authored(fact.anchor),
      }
    return {
      _tag: 'EffectBlock',
      site: fact.site,
      statements: fact.statements,
      captures: fact.captures.map((capture) => ({
        ...(capture.reference._tag === 'BindingFact'
          ? { binding: localOf(options, capture.reference.id) }
          : {}),
        ...(capture.reference._tag === 'PatternBinding'
          ? { pattern: localOf(options, capture.reference.id) }
          : {}),
        ...(capture.reference._tag === 'ParameterDeclaration'
          ? { parameter: localOf(options, capture.reference.id) }
          : {}),
        access: capture.access,
        span: capture.span,
        at: capture.anchor,
        ...(capture.expression === undefined
          ? {}
          : { use: constructionExpressionAnchor(capture.expression) }),
      })),
      type: fact.type.type,
      span: options.context.spanOf(fact.anchor),
      origin: Tir.authored(fact.anchor),
    }
  }
  if (fact._tag === 'Run') {
    const subject = tirExpression(fact.subject, options)
    if (subject._tag === 'Unavailable' || fact.type._tag !== 'Available')
      return {
        _tag: 'Unavailable',
        span: options.context.spanOf(fact.anchor),
        origin: Tir.authored(fact.anchor),
      }
    return {
      _tag: 'Run',
      subject,
      type: fact.type.type,
      span: options.context.spanOf(fact.anchor),
      origin: Tir.authored(fact.anchor),
    }
  }
  if (fact._tag === 'EffectCatch') {
    const protected_ = tirExpression(fact.protected, options)
    const handler = tirExpression(fact.handler, options)
    if (
      protected_._tag === 'Unavailable' ||
      handler._tag === 'Unavailable' ||
      fact.reference._tag !== 'ResolvedIntrinsicReference' ||
      fact.selected === undefined ||
      fact.type._tag !== 'Available' ||
      !Type.isEffect(fact.type.type)
    )
      return {
        _tag: 'Unavailable',
        span: options.context.spanOf(fact.anchor),
        origin: Tir.authored(fact.anchor),
      }
    return {
      _tag: 'EffectCatch',
      ...(fact.recoveryInvocation === undefined
        ? {}
        : { recoveryInvocation: fact.recoveryInvocation }),
      intrinsic: fact.reference.operation.id,
      protected: protected_,
      handler,
      selected: fact.selected,
      protectedRow: fact.protectedRow,
      handlerRow: fact.handlerRow,
      residualRow: fact.residualRow,
      evidence: publishedEvidence(options.builder, fact.evidence),
      type: fact.type.type,
      span: options.context.spanOf(fact.anchor),
      origin: Tir.authored(fact.anchor),
    }
  }
  if (fact._tag === 'EffectBindRequirement') {
    const protected_ = tirExpression(fact.protected, options)
    if (
      protected_._tag === 'Unavailable' ||
      fact.provider === undefined ||
      fact.type._tag !== 'Available' ||
      !Type.isEffect(fact.type.type)
    )
      return {
        _tag: 'Unavailable',
        span: options.context.spanOf(fact.anchor),
        origin: Tir.authored(fact.anchor),
      }
    return {
      _tag: 'EffectBindRequirement',
      protected: protected_,
      provider: {
        ...(fact.provider.reference._tag === 'BindingFact'
          ? { binding: localOf(options, fact.provider.reference.id) }
          : { parameter: localOf(options, fact.provider.reference.id) }),
        selected: fact.provider.selected,
        evidence: publishedEvidence(options.builder, fact.provider.evidence),
        ...(fact.provider.capability === undefined ? {} : { capability: fact.provider.capability }),
        providerType: fact.provider.providerType,
        ...(fact.provider.witness === undefined ? {} : { witness: fact.provider.witness }),
        ...(fact.provider.role === undefined ? {} : { role: fact.provider.role }),
        selectionAccess: fact.provider.selectionAccess,
        captureAccess: fact.provider.captureAccess,
        span: fact.provider.span,
        at: fact.provider.at,
      },
      type: fact.type.type,
      span: options.context.spanOf(fact.anchor),
      origin: Tir.authored(fact.anchor),
    }
  }
  if (fact._tag === 'Match') {
    const loweredScrutinee = tirExpression(fact.scrutinee, options)
    const scrutinee =
      fact.access === 'Move' &&
      (loweredScrutinee._tag === 'Project' || loweredScrutinee._tag === 'IndexPlace')
        ? { ...loweredScrutinee, access: 'ConsumeRequested' as const }
        : loweredScrutinee
    // Preserve the match row for rejected bodies so tooling can still inspect coverage, arms, and
    // healthy children. `never` is the non-executable recovery type when the join itself failed.
    const target: SemanticType = fact.type._tag === 'Available' ? fact.type.type : 'never'
    return {
      _tag: 'Match',
      match: fact.id,
      access: fact.access,
      scrutinee,
      members: fact.members,
      arms: fact.arms.map((arm) => {
        let member: Match.CoverageIdentity | undefined
        if (arm.pattern._tag === 'EnumMemberPattern') {
          member = arm.pattern.coverage
        } else if (arm.pattern._tag === 'UnionVariantPattern') {
          member = arm.pattern.coverage
        } else if (
          (arm.pattern._tag === 'NominalPattern' || arm.pattern._tag === 'TypePattern') &&
          arm.pattern.member !== undefined
        ) {
          member = Match.structuralMember(arm.pattern.member)
        }
        return {
          id: arm.id,
          tests: arm.tests,
          ...(member === undefined ? {} : { member }),
          ...(arm.pattern._tag === 'IntegerPattern' && arm.pattern.value !== undefined
            ? { integer: arm.pattern.value }
            : {}),
          universal: arm.pattern._tag === 'UniversalPattern',
          bindings: arm.bindings.flatMap((binding) =>
            binding.type._tag === 'Available'
              ? [
                  {
                    id:
                      options.builder === undefined
                        ? (() => {
                            throw new RangeError('TIR local requires its body builder')
                          })()
                        : BodyArena.semanticLocal(options.builder, binding, {
                            kind: 'Pattern',
                            ...(binding.name._tag === 'Present'
                              ? { name: binding.name.spelling }
                              : {}),
                            type: binding.type.type,
                            mutability: binding.access === 'Place' ? 'Mutable' : 'Immutable',
                          }),
                    ...(binding.name._tag === 'Present' ? { name: binding.name.spelling } : {}),
                    ...(binding.field === undefined ? {} : { field: binding.field.id }),
                    path: binding.path,
                    type: binding.type.type,
                    access: binding.access,
                    span: options.context.spanOf(binding.anchor),
                    origin: Tir.authored(binding.anchor),
                  },
                ]
              : [],
          ),
          cleanup: arm.pattern.omitted,
          ...(arm.guard === undefined ? {} : { guard: tirExpression(arm.guard, options) }),
          body:
            arm.body._tag === 'Expression'
              ? {
                  _tag: 'Expression' as const,
                  expression: Type.isUnion(target)
                    ? tirExpectedExpression(
                        arm.body.expression,
                        target,
                        'MatchArm',
                        arm.anchor,
                        options,
                      )
                    : tirExpression(arm.body.expression, options),
                  type:
                    arm.body.type._tag === 'Available' && !Type.isUnion(target)
                      ? arm.body.type.type
                      : target,
                  span: options.context.spanOf(arm.body.anchor),
                  origin: Tir.authored(arm.body.anchor),
                }
              : {
                  _tag: 'Block' as const,
                  statements: arm.body.statements,
                  completion: arm.body.completion,
                  type: arm.body.type._tag === 'Available' ? arm.body.type.type : target,
                  span: options.context.spanOf(arm.body.anchor),
                  origin: Tir.authored(arm.body.anchor),
                },
          before: arm.before,
          after: arm.after,
          reachable: arm.reachable,
          span: options.context.spanOf(arm.anchor),
          at: arm.anchor,
          origin: Tir.authored(arm.anchor),
        }
      }),
      type: target,
      span: options.context.spanOf(fact.anchor),
      origin: Tir.authored(fact.anchor),
    }
  }
  if (fact._tag === 'StructLiteral') {
    if (
      fact.target._tag !== 'Resolved' ||
      fact.type._tag !== 'Available' ||
      fact.fields.length !== fact.target.struct.fields.length
    ) {
      return {
        _tag: 'Unavailable',
        span: options.context.spanOf(fact.anchor),
        origin: Tir.authored(fact.anchor),
        ...(fact.target._tag === 'Unavailable' && fact.target.cause !== undefined
          ? publishedCause(options.builder, fact.target.cause)
          : {}),
      }
    }
    const substitution =
      TypeInference.substitution(
        fact.target.struct.typeParameters.map((parameter) => parameter.type),
        fact.target.type.arguments,
      ) ?? new Map()
    return {
      _tag: 'Construct',
      nominal: fact.target.type,
      evaluationOrder: fact.initializers.flatMap((initializer) =>
        initializer.state._tag === 'Resolved' ? [initializer.state.field.id] : [],
      ),
      fields: fact.fields.map(({ field, initializer }) => {
        const value =
          field.declaredType._tag === 'Resolved'
            ? tirExpectedExpression(
                initializer.expression,
                Type.substitute(field.declaredType.type, substitution),
                'StructField',
                field.anchor,
                options,
              )
            : tirExpression(initializer.expression, options)
        return { field: field.id, value }
      }),
      type: fact.type.type,
      span: options.context.spanOf(fact.anchor),
      origin: Tir.authored(fact.anchor),
    }
  }
  if (fact._tag === 'UnionVariant') {
    if (
      fact.target._tag !== 'Resolved' ||
      fact.target.variant.canonical._tag !== 'Canonical' ||
      fact.type._tag !== 'Available' ||
      fact.fields.length !== fact.target.variant.fields.length
    ) {
      return {
        _tag: 'Unavailable',
        span: options.context.spanOf(fact.anchor),
        origin: Tir.authored(fact.anchor),
        ...(fact.target._tag === 'Unavailable' && fact.target.cause !== undefined
          ? publishedCause(options.builder, fact.target.cause)
          : {}),
      }
    }
    const substitution =
      TypeInference.substitution(
        fact.target.union.typeParameters.map((parameter) => parameter.type),
        fact.target.type.arguments,
      ) ?? new Map()
    return {
      _tag: 'ConstructUnionVariant',
      nominal: fact.target.type,
      variant: fact.target.variant.canonical.id,
      variantOrdinal: fact.target.variant.id.ordinal,
      evaluationOrder: fact.initializers.flatMap((initializer) =>
        initializer.state._tag === 'Resolved' ? [initializer.state.field.id] : [],
      ),
      fields: fact.fields.map(({ field, initializer }) => {
        const value =
          field.declaredType._tag === 'Resolved'
            ? tirExpectedExpression(
                initializer.expression,
                Type.substitute(field.declaredType.type, substitution),
                'StructField',
                field.anchor,
                options,
              )
            : tirExpression(initializer.expression, options)
        return { field: field.id, value }
      }),
      type: fact.type.type,
      span: options.context.spanOf(fact.anchor),
      origin: Tir.authored(fact.anchor),
    }
  }
  if (fact._tag === 'ArrayLiteral') {
    if (fact.state._tag !== 'Complete' || fact.type._tag !== 'Available') {
      return {
        _tag: 'Unavailable',
        span: options.context.spanOf(fact.anchor),
        origin: Tir.authored(fact.anchor),
      }
    }
    return {
      _tag: 'ArrayConstruct',
      elements: fact.elements.map((element) =>
        element.expected === undefined
          ? tirExpression(element.expression, options)
          : tirExpectedExpression(
              element.expression,
              element.expected,
              'ArrayElement',
              element.anchor,
              options,
            ),
      ),
      type: fact.state.type,
      span: options.context.spanOf(fact.anchor),
      origin: Tir.authored(fact.anchor),
    }
  }
  if (fact._tag === 'FieldProjection') {
    if (
      (options.static === undefined ||
        (options.builder?.artifact.request._tag === 'Specialize' &&
          fact.nominal !== undefined &&
          Type.equals(fact.nominal, Type.testInfo))) &&
      fact.staticValue !== undefined &&
      fact.type._tag === 'Available'
    ) {
      const value = staticValueExpression(
        fact.staticValue,
        fact.type.type,
        fact.anchor,
        options.context,
        options.builder,
      )
      if (value._tag !== 'Unavailable') return value
    }
    if (fact.state._tag === 'SliceLength' && fact.type._tag === 'Available') {
      const slice = tirExpression(fact.subject, options)
      return slice._tag === 'Unavailable'
        ? slice
        : {
            _tag: 'SliceLength',
            slice,
            type: 'usize',
            span: options.context.spanOf(fact.anchor),
            origin: Tir.authored(fact.anchor),
          }
    }
    if (
      fact.nominal === undefined ||
      fact.state._tag !== 'Resolved' ||
      fact.type._tag !== 'Available'
    ) {
      return {
        _tag: 'Unavailable',
        span: options.context.spanOf(fact.anchor),
        origin: Tir.authored(fact.anchor),
        ...(fact.state._tag === 'Unavailable' && fact.state.cause !== undefined
          ? publishedCause(options.builder, fact.state.cause)
          : {}),
      }
    }
    return {
      _tag: 'Project',
      subject: tirExpression(fact.subject, options),
      nominal: fact.nominal,
      field: fact.state.field.id,
      access: 'CopyRead',
      ...(fact.borrowAccess === undefined ? {} : { borrowAccess: fact.borrowAccess }),
      type: fact.type.type,
      span: options.context.spanOf(fact.anchor),
      origin: Tir.authored(fact.anchor),
    }
  }
  if (fact._tag === 'IndexProjection') {
    if (
      fact.slice !== undefined &&
      fact.type._tag === 'Available' &&
      fact.bounds._tag === 'RuntimeSlice'
    ) {
      const slice = tirExpression(fact.subject, options)
      const index = tirExpression(fact.index, options)
      if (slice._tag === 'Unavailable' || index._tag === 'Unavailable')
        return {
          _tag: 'Unavailable',
          span: options.context.spanOf(fact.anchor),
          origin: Tir.authored(fact.anchor),
        }
      return {
        _tag: 'SliceIndexPlace',
        slice,
        index,
        access: fact.slice.access,
        sourceType: fact.slice,
        type: fact.type.type,
        span: options.context.spanOf(fact.anchor),
        origin: Tir.authored(fact.anchor),
      }
    }
    if (
      fact.array === undefined ||
      fact.type._tag !== 'Available' ||
      (fact.bounds._tag !== 'Proven' && fact.bounds._tag !== 'Runtime')
    ) {
      return {
        _tag: 'Unavailable',
        span: options.context.spanOf(fact.anchor),
        origin: Tir.authored(fact.anchor),
        ...(fact.bounds._tag === 'Invalid'
          ? publishedCause(options.builder, fact.bounds.cause)
          : {}),
      }
    }
    const subject = tirExpression(fact.subject, options)
    const index = tirExpression(fact.index, options)
    if (subject._tag === 'Unavailable' || index._tag === 'Unavailable')
      return {
        _tag: 'Unavailable',
        span: options.context.spanOf(fact.anchor),
        origin: Tir.authored(fact.anchor),
      }
    return {
      _tag: 'IndexPlace',
      subject,
      index,
      array: fact.array,
      access: fact.access,
      bounds: fact.bounds,
      type: fact.type.type,
      span: options.context.spanOf(fact.anchor),
      origin: Tir.authored(fact.anchor),
    }
  }
  if (fact._tag === 'ReferentProjection') {
    if (
      fact.state._tag !== 'Resolved' ||
      fact.reference === undefined ||
      fact.borrowAccess === undefined ||
      fact.type._tag !== 'Available'
    ) {
      return {
        _tag: 'Unavailable',
        span: options.context.spanOf(fact.anchor),
        origin: Tir.authored(fact.anchor),
        ...(fact.state._tag === 'Unavailable' && fact.state.cause !== undefined
          ? publishedCause(options.builder, fact.state.cause)
          : {}),
      }
    }
    return {
      _tag: 'ReferentPlace',
      subject: tirExpression(fact.subject, options),
      reference: fact.reference,
      access: 'CopyRead',
      borrowAccess: fact.borrowAccess,
      type: fact.type.type,
      span: options.context.spanOf(fact.anchor),
      origin: Tir.authored(fact.anchor),
    }
  }
  if (fact._tag === 'Borrow') {
    borrow ??=
      self === undefined
        ? undefined
        : {
            _tag: 'BorrowId',
            call: self,
            ordinal: 0,
          }
    if (
      borrow === undefined ||
      fact.formation._tag === 'Unavailable' ||
      fact.type._tag !== 'Available' ||
      (!Type.isSlice(fact.type.type) && !Type.isReference(fact.type.type))
    ) {
      return {
        _tag: 'Unavailable',
        span: options.context.spanOf(fact.anchor),
        origin: Tir.authored(fact.anchor),
        ...(fact.formation._tag === 'Unavailable' && fact.formation.cause !== undefined
          ? publishedCause(options.builder, fact.formation.cause)
          : {}),
      }
    }
    let root: Tir.SliceRoot
    switch (fact.formation.root._tag) {
      case 'BindingRoot':
        root = {
          _tag: 'BindingSliceRoot',
          binding: localOf(options, fact.formation.root.binding.id),
        }
        break
      case 'ParameterRoot':
        root = {
          _tag: 'ParameterSliceRoot',
          parameter: localOf(options, fact.formation.root.parameter.id),
        }
        break
      case 'PatternRoot':
        root = {
          _tag: 'PatternSliceRoot',
          binding: localOf(options, fact.formation.root.binding.id),
        }
        break
      case 'TemporaryRoot':
        root = {
          _tag: 'TemporarySliceRoot',
          owner: fact.formation.root.owner,
          value: tirExpression(fact.formation.root.value, options),
        }
        break
    }
    const selectors: Array<Tir.BorrowSelector> = []
    for (const selector of fact.formation.root.path) {
      if (selector._tag === 'Field') {
        selectors.push({
          _tag: 'Field',
          field: selector.field,
          span: selector.span,
          ...(selector.at === undefined ? {} : { at: selector.at }),
          ...(selector.at === undefined ? {} : { at: selector.at }),
        })
        continue
      }
      if (selector._tag === 'SliceIndex') {
        const index = tirExpression(selector.index, options)
        if (index._tag === 'Unavailable') {
          return {
            _tag: 'Unavailable',
            span: options.context.spanOf(fact.anchor),
            origin: Tir.authored(fact.anchor),
          }
        }
        selectors.push({
          _tag: 'SliceIndex',
          index,
          slice: selector.slice,
          span: selector.span,
          ...(selector.at === undefined ? {} : { at: selector.at }),
          ...(selector.at === undefined ? {} : { at: selector.at }),
        })
        continue
      }
      const index = tirExpression(selector.index, options)
      if (index._tag === 'Unavailable') {
        return {
          _tag: 'Unavailable',
          span: options.context.spanOf(fact.anchor),
          origin: Tir.authored(fact.anchor),
        }
      }
      selectors.push({
        _tag: 'Index',
        index,
        array: selector.array,
        bounds: selector.bounds,
        span: selector.span,
        ...(selector.at === undefined ? {} : { at: selector.at }),
      })
    }
    if (
      (fact.formation._tag === 'ValueBorrow' || fact.formation._tag === 'ValueReborrow') &&
      Type.isReference(fact.type.type)
    ) {
      return {
        _tag: 'ValueBorrow',
        place: tirExpression(fact.subject, options),
        borrow,
        root,
        selectors: selectors,
        source:
          fact.formation._tag === 'ValueBorrow' ? fact.formation.source : fact.formation.parent,
        access: fact.access,
        reborrow: fact.formation._tag === 'ValueReborrow',
        suspendsParent: fact.formation._tag === 'ValueReborrow' && fact.formation.suspendsParent,
        type: fact.type.type,
        span: options.context.spanOf(fact.anchor),
        origin: Tir.authored(fact.anchor),
      }
    }
    if (fact.formation._tag === 'ValueBorrow' || fact.formation._tag === 'ValueReborrow')
      return {
        _tag: 'Unavailable',
        span: options.context.spanOf(fact.anchor),
        origin: Tir.authored(fact.anchor),
      }
    if (!Type.isSlice(fact.type.type))
      return {
        _tag: 'Unavailable',
        span: options.context.spanOf(fact.anchor),
        origin: Tir.authored(fact.anchor),
      }
    return {
      _tag: 'SliceBorrow',
      place: tirExpression(fact.subject, options),
      borrow,
      root,
      selectors: selectors,
      source:
        fact.formation._tag === 'FixedArrayBorrow' ? fact.formation.array : fact.formation.parent,
      access: fact.access,
      reborrow: fact.formation._tag === 'SliceReborrow',
      suspendsParent: fact.formation._tag === 'SliceReborrow' && fact.formation.suspendsParent,
      type: fact.type.type,
      span: options.context.spanOf(fact.anchor),
      origin: Tir.authored(fact.anchor),
    }
  }
  if (fact._tag === 'FunctionItem') {
    const target = tirCallableTarget(fact.reference)
    if (target === undefined || fact.type._tag !== 'Available')
      return {
        _tag: 'Unavailable',
        span: options.context.spanOf(fact.anchor),
        origin: Tir.authored(fact.anchor),
      }
    if (fact.foreignAddress !== undefined && Type.isForeignFunction(fact.type.type))
      return {
        _tag: 'ForeignFunctionAddress',
        target,
        symbol: fact.foreignAddress.symbol,
        type: fact.type.type,
        span: options.context.spanOf(fact.anchor),
        origin: Tir.authored(fact.anchor),
      }
    if (!Type.isCallable(fact.type.type))
      return {
        _tag: 'Unavailable',
        span: options.context.spanOf(fact.anchor),
        origin: Tir.authored(fact.anchor),
      }
    return {
      _tag: 'FunctionItem',
      target,
      typeArguments: fact.typeArguments,
      type: fact.type.type,
      span: options.context.spanOf(fact.anchor),
      origin: Tir.authored(fact.anchor),
    }
  }
  if (fact._tag === 'CallableSection') {
    const target = tirCallableTarget(fact.reference)
    if (target === undefined || fact.type._tag !== 'Available' || !Type.isCallable(fact.type.type))
      return {
        _tag: 'Unavailable',
        span: options.context.spanOf(fact.anchor),
        origin: Tir.authored(fact.anchor),
      }
    const typeArguments =
      fact.reference._tag === 'Resolved'
        ? sectionIdentityArguments(
            fact.reference.declaration.typeParameters.map((parameter) => parameter.type),
            fact.substitution,
            Type.isCallable(fact.type.type) ? fact.type.type.schema : undefined,
            options.functionId !== undefined &&
              fact.reference.declaration.id.sourceId === options.functionId.sourceId &&
              fact.reference.declaration.id.ordinal === options.functionId.ordinal,
          )
        : fact.typeArguments
    return {
      _tag: 'CallableSection',
      ...(fact.invocationParameters === undefined
        ? {}
        : { invocationParameters: fact.invocationParameters }),
      site: fact.site,
      target,
      remainingParameters: fact.remainingParameters,
      captures: fact.captures.map((capture) => ({
        ordinal: capture.ordinal,
        parameterOrdinal: capture.parameterOrdinal,
        value: tirExpression(capture.expression, options, {
          _tag: 'BorrowId',
          call:
            self ??
            (() => {
              throw new RangeError('callable section requires its node reference')
            })(),
          ordinal: capture.ordinal,
        }),
        access: capture.access,
      })),
      typeArguments: typeArguments,
      substitution: fact.substitution,
      retainedDependencies: fact.retainedDependencies,
      mode: fact.mode,
      type: fact.type.type,
      span: options.context.spanOf(fact.anchor),
      origin: Tir.authored(fact.anchor),
    }
  }
  if (fact._tag === 'ForeignApply') {
    if (fact.type._tag !== 'Available')
      return {
        _tag: 'Unavailable',
        span: options.context.spanOf(fact.anchor),
        origin: Tir.authored(fact.anchor),
      }
    return {
      _tag: 'ForeignApply',
      evaluation: fact.evaluation,
      callee: tirExpression(fact.callee, options),
      arguments: fact.arguments.map((argument, ordinal) =>
        tirExpression(argument.expression, options, argumentBorrowId(argument, ordinal, self)),
      ),
      contract: fact.contract,
      loanEnds: loanEndsOf(fact.arguments, self, () => true),
      type: fact.type.type,
      span: options.context.spanOf(fact.anchor),
      origin: Tir.authored(fact.anchor),
    }
  }
  if (fact._tag === 'CallableApply') {
    if (fact.type._tag !== 'Available')
      return {
        _tag: 'Unavailable',
        call: {
          callee: tirExpression(fact.callee, options),
          arguments: fact.arguments.map((argument, ordinal) =>
            tirExpression(argument.expression, options, argumentBorrowId(argument, ordinal, self)),
          ),
          access: fact.mode,
          evaluation:
            fact.provenance._tag === 'PipelineCallableApplication'
              ? 'LeftThenCallable'
              : 'CalleeThenArguments',
        },
        span: options.context.spanOf(fact.anchor),
        origin: Tir.authored(fact.anchor),
      }
    const resultType = fact.type.type
    const retainedOrdinals = new Set(
      retainedArguments(fact, options).map((argument) => argument.id.ordinal),
    )
    const retainedSection = fact.callee._tag === 'CallableSection' ? fact.callee : undefined
    const retainedCaptures =
      retainedSection?.captures.filter((capture) => {
        const type = constructionExpressionType(capture.value)
        return (
          type._tag === 'Available' &&
          retainsLifetimes(
            type.type,
            resultType,
            lifetimeAssumptionsOf(options),
            (longer, shorter) => provesOutlives(options, longer, shorter),
          )
        )
      }) ?? []
    const retainedCaptureLoans: ReadonlyArray<Tir.BorrowId> =
      retainedSection === undefined
        ? []
        : retainedCaptures.map((capture) => ({
            _tag: 'BorrowId',
            call:
              self ??
              (() => {
                throw new RangeError('retained callable capture requires its node reference')
              })(),
            ordinal: capture.ordinal,
          }))
    return {
      _tag: 'CallableApply',
      ...(fact.invocationUse === undefined ? {} : { invocationUse: fact.invocationUse }),
      callee: tirExpression(fact.callee, options),
      arguments: fact.arguments.map((argument, ordinal) =>
        tirExpression(argument.expression, options, argumentBorrowId(argument, ordinal, self)),
      ),
      // A staged application retains every argument loan inside the new environment.
      loanEnds: loanEndsOf(
        fact.arguments,
        self,
        (ordinal) => fact.staged === undefined && !retainedOrdinals.has(ordinal),
      ),
      heldLoans: [
        ...loanEndsOf(
          fact.arguments,
          self,
          (ordinal) => fact.staged !== undefined || retainedOrdinals.has(ordinal),
        ),
        ...retainedCaptureLoans,
      ],
      ...(fact.staged === undefined
        ? {}
        : {
            staged: {
              site: fact.staged.site,
              captures: fact.staged.captures.map((capture) => {
                const type = constructionExpressionType(capture.expression)
                if (type._tag !== 'Available')
                  throw new RangeError('Checked staged capture lost its source type')
                return {
                  ordinal: capture.ordinal,
                  parameterOrdinal: capture.parameterOrdinal,
                  argument: constructionExpressionAnchor(capture.expression),
                  type: type.type,
                  access: capture.access,
                }
              }),
            },
          }),
      access: fact.mode,
      substitution: fact.substitution,
      evaluation:
        fact.provenance._tag === 'PipelineCallableApplication'
          ? 'LeftThenCallable'
          : 'CalleeThenArguments',
      realization: fact.callee._tag === 'CallableSection' ? 'DirectErasedSection' : 'Environment',
      type: fact.type.type,
      span: options.context.spanOf(fact.anchor),
      origin: Tir.authored(fact.anchor),
    }
  }
  if (
    fact.reference._tag === 'ResolvedInterfaceOperation' &&
    fact.contract._tag === 'Compatible' &&
    fact.type._tag === 'Available'
  ) {
    const borrowIds = loanEndsOf(fact.arguments, self)
    return {
      _tag: 'InterfaceOperationCall',
      ...(fact._tag === 'Operator' ? { operator: true as const } : {}),
      capability: fact.reference.capability,
      provider: fact.reference.provider,
      operation: fact.reference.operation,
      contract: fact.reference.interfaceContract,
      ...(fact.witnessEffectSite === undefined
        ? {}
        : { witnessEffectSite: fact.witnessEffectSite }),
      arguments: fact.arguments.map((argument, ordinal) =>
        tirExpression(argument.expression, options, argumentBorrowId(argument, ordinal, self)),
      ),
      loanEnds: borrowIds,
      type: fact.type.type,
      span: options.context.spanOf(fact.anchor),
      origin: Tir.authored(fact.anchor),
    }
  }
  if (
    fact._tag === 'Operator' &&
    fact.reference._tag === 'ResolvedEnumEquality' &&
    fact.type._tag === 'Available'
  ) {
    const leftFact = fact.arguments.at(0)
    const rightFact = fact.arguments.at(1)
    const left = leftFact === undefined ? undefined : tirExpression(leftFact.expression, options)
    const right = rightFact === undefined ? undefined : tirExpression(rightFact.expression, options)
    return left === undefined ||
      right === undefined ||
      left._tag === 'Unavailable' ||
      right._tag === 'Unavailable'
      ? {
          _tag: 'Unavailable',
          span: options.context.spanOf(fact.anchor),
          origin: Tir.authored(fact.anchor),
        }
      : {
          _tag: 'EnumEquality',
          enum: fact.reference.enum,
          left,
          right,
          negated: fact.reference.operator === 'NotEquals',
          type: Scalar.boolean.spelling,
          span: options.context.spanOf(fact.anchor),
          origin: Tir.authored(fact.anchor),
        }
  }
  if (
    fact.reference._tag === 'ResolvedBuiltin' &&
    fact.contract._tag === 'Compatible' &&
    fact.type._tag === 'Available'
  ) {
    const retainedOrdinals = new Set(
      retainedArguments(fact, options).map((argument) => argument.id.ordinal),
    )
    const directLoanEnds = loanEndsOf(
      fact.arguments,
      self,
      (ordinal) => !retainedOrdinals.has(ordinal),
    )
    const nestedSlotLoanEnds =
      fact.reference.operation === 'SlotWrite' ||
      fact.reference.operation === 'SlotTake' ||
      fact.reference.operation === 'SlotCopy' ||
      fact.reference.operation === 'SlotDrop'
        ? fact.arguments.flatMap((argument): ReadonlyArray<Tir.BorrowId> => {
            const nested = argument.expression
            if (nested._tag !== 'BuiltinCall' || nested.operation !== 'RawBufferSlot') return []
            return nested.loanEnds
          })
        : []
    const arguments_ = fact.arguments.map((argument, ordinal) => {
      const borrowId = argumentBorrowId(argument, ordinal, self)
      return tirExpression(argument.expression, options, borrowId)
    })
    const heldLoans = loanEndsOf(fact.arguments, self, (ordinal) => retainedOrdinals.has(ordinal))
    if (fact.reference.operation === 'StringFromUtf8Unchecked') {
      const source = arguments_.at(0)
      return source === undefined || source._tag === 'Unavailable' || !Type.isSlice(source.type)
        ? {
            _tag: 'Unavailable',
            span: options.context.spanOf(fact.anchor),
            origin: Tir.authored(fact.anchor),
          }
        : {
            _tag: 'RuntimeStringView',
            source,
            heldLoans,
            type: Type.string(source.type.lifetime),
            span: options.context.spanOf(fact.anchor),
            origin: Tir.authored(fact.anchor),
          }
    }
    if (fact.reference.operation === 'StringEqualsExact') {
      const left = arguments_.at(0)
      const right = arguments_.at(1)
      return left === undefined ||
        right === undefined ||
        left._tag === 'Unavailable' ||
        right._tag === 'Unavailable'
        ? {
            _tag: 'Unavailable',
            span: options.context.spanOf(fact.anchor),
            origin: Tir.authored(fact.anchor),
          }
        : {
            _tag: 'StringEquality',
            left,
            right,
            negated: fact._tag === 'Operator' && fact.operator === 'NotEquals',
            intrinsic: fact.reference.intrinsic,
            type: Scalar.boolean.spelling,
            span: options.context.spanOf(fact.anchor),
            origin: Tir.authored(fact.anchor),
          }
    }
    return {
      _tag: 'BuiltinCall',
      ...(fact.reference.assembly === undefined ? {} : { assembly: fact.reference.assembly }),
      operation: fact.reference.operation,
      intrinsic: fact.reference.intrinsic,
      ...(fact._tag === 'Operator' && fact.interfaceOperation !== undefined
        ? { interfaceOperation: fact.interfaceOperation }
        : {}),
      ...(fact._tag === 'Operator' && fact.witnessEffectSite !== undefined
        ? { witnessEffectSite: fact.witnessEffectSite }
        : {}),
      typeArguments:
        fact._tag === 'Call'
          ? (() => {
              const operation = Intrinsic.findOperationById(fact.reference.intrinsic)
              const parameters =
                operation !== undefined && Intrinsic.isBuiltinOperation(operation)
                  ? (operation.rule.typeParameters ?? [])
                  : ([] as ReadonlyArray<Type.Parameter>)
              return fact.typeArguments.flatMap((argument, ordinal) => {
                const parameter = parameters.at(ordinal)
                const converted =
                  parameter === undefined
                    ? argument.type
                    : genericArgumentOfTypeArgument(parameter, argument)
                return converted === undefined ? [] : [converted]
              })
            })()
          : [],
      arguments: arguments_,
      loanEnds: [...directLoanEnds, ...nestedSlotLoanEnds],
      heldLoans,
      type: fact.type.type,
      span: options.context.spanOf(fact.anchor),
      origin: Tir.authored(fact.anchor),
    }
  }
  if (
    fact.reference._tag === 'ResolvedServiceOperation' &&
    fact.reference.service.canonical._tag === 'Canonical' &&
    fact.reference.operation.name._tag === 'Present' &&
    fact.contract._tag === 'Compatible' &&
    fact.type._tag === 'Available' &&
    Type.isEffect(fact.type.type)
  ) {
    const serviceArguments = fact.contract.typeArguments.slice(
      0,
      fact.reference.service.typeParameters.length,
    )
    const service = Type.nominal(
      fact.reference.service.canonical.id.module,
      fact.reference.service.canonical.id.name,
      serviceArguments,
    )
    const requirement = Type.requirementMembers(fact.type.type).find((candidate) =>
      Type.equals(candidate.capability, service),
    )
    if (requirement === undefined)
      return {
        _tag: 'Unavailable',
        span: options.context.spanOf(fact.anchor),
        origin: Tir.authored(fact.anchor),
      }
    const substitution = fact.contract.substitution
    const target = fact.reference.operation
    const staticArgumentOrigins = (fact._tag === 'Call' ? (fact.staticArguments ?? []) : []).map(
      (argument) => argument.textOrigin,
    )
    return {
      _tag: 'ServiceEffectConstruct',
      service,
      operation: fact.reference.operation.name.spelling,
      role: requirement.role,
      access: requirement.access,
      typeArguments: fact.contract.typeArguments,
      staticArguments: (fact._tag === 'Call' ? (fact.staticArguments ?? []) : []).map(
        (argument) => argument.value,
      ),
      ...(staticArgumentOrigins.some((origin) => origin !== undefined)
        ? { staticArgumentOrigins }
        : {}),
      arguments: fact.arguments.flatMap((argument, ordinal) => {
        const parameter = target.parameters.at(ordinal)
        if (parameter?.phase === 'Static') return []
        const borrowId = argumentBorrowId(argument, ordinal, self)
        const argumentType = constructionExpressionType(argument.expression)
        const genericForwarding =
          parameter?.declaredType._tag === 'Resolved' &&
          argumentType._tag === 'Available' &&
          isRepresentationIdenticalGenericForwarding(parameter.declaredType.type, argumentType.type)
        return [
          parameter?.declaredType._tag === 'Resolved' && !genericForwarding
            ? tirExpectedExpression(
                argument.expression,
                Type.substitute(parameter.declaredType.type, substitution),
                'Argument',
                parameter.anchor,
                options,
                borrowId,
              )
            : tirExpression(argument.expression, options, borrowId),
        ]
      }),
      loanEnds: loanEndsOf(
        fact.arguments,
        self,
        (ordinal) => target.parameters.at(ordinal)?.phase !== 'Static',
      ),
      type: fact.type.type,
      span: options.context.spanOf(fact.anchor),
      origin: Tir.authored(fact.anchor),
    }
  }
  if (
    fact.reference._tag === 'Resolved' &&
    fact.reference.declaration.canonical._tag === 'Canonical' &&
    fact.contract._tag === 'Compatible' &&
    fact.type._tag === 'Available'
  ) {
    if (options.static === undefined && fact._tag === 'Call' && fact.staticValue !== undefined) {
      const value = staticValueExpression(
        fact.staticValue,
        fact.type.type,
        fact.anchor,
        options.context,
        options.builder,
      )
      if (value._tag !== 'Unavailable') return value
      const retainedStatic = staticStructure(fact, options)
      if (retainedStatic !== undefined) return retainedStatic
    }
    const target = fact.reference.declaration
    const substitution = fact.contract.substitution
    const retainedOrdinals = new Set(
      retainedArguments(fact, options).map((argument) => argument.id.ordinal),
    )
    const retainedBorrowOrdinals = retainedDirectBorrowOrdinals(fact, retainedOrdinals)
    const staticArgumentOrigins = (fact._tag === 'Call' ? (fact.staticArguments ?? []) : []).map(
      (argument) => argument.textOrigin,
    )
    const inputViews = fact.contract.inputViews
    const call = {
      ...(fact.contract.inputViews === undefined ? {} : { inputViews: fact.contract.inputViews }),
      ...(fact.contract.invocationUse === undefined
        ? {}
        : { invocationUse: fact.contract.invocationUse }),
      target: fact.reference.declaration.canonical.id,
      typeArguments: fact.contract.typeArguments,
      evidence: publishedEvidence(
        options.builder,
        fact.contract.evidence,
        fact._tag === 'Call' ? fact.selectedConformances : undefined,
      ),
      symbolicConformances: fact.contract.symbolicConformances ?? [],
      staticArguments: (fact._tag === 'Call' ? (fact.staticArguments ?? []) : []).map(
        (argument) => argument.value,
      ),
      ...(staticArgumentOrigins.some((origin) => origin !== undefined)
        ? { staticArgumentOrigins }
        : {}),
      arguments: fact.arguments.flatMap((argument, ordinal) => {
        const parameter = target.parameters.at(ordinal)
        if (parameter?.phase === 'Static') return []
        const borrowId = argumentBorrowId(argument, ordinal, self)
        const argumentType = constructionExpressionType(argument.expression)
        const invocationView = inputViews?.find(
          (view) =>
            view.parameter.ordinal === ordinal &&
            view.invocationSource !== undefined &&
            view.invocationSource === argument.invocationSource &&
            argumentType._tag === 'Available' &&
            Type.equals(view.actual, argumentType.type) &&
            parameter?.declaredType._tag === 'Resolved' &&
            Type.equals(view.expected, Type.substitute(parameter.declaredType.type, substitution)),
        )
        if (invocationView !== undefined)
          return [tirExpression(argument.expression, options, borrowId)]
        const genericForwarding =
          parameter?.declaredType._tag === 'Resolved' &&
          argumentType._tag === 'Available' &&
          isRepresentationIdenticalGenericForwarding(parameter.declaredType.type, argumentType.type)
        return [
          parameter?.declaredType._tag === 'Resolved' && !genericForwarding
            ? tirExpectedExpression(
                argument.expression,
                Type.substitute(parameter.declaredType.type, substitution),
                'Argument',
                parameter.anchor,
                options,
                borrowId,
              )
            : tirExpression(argument.expression, options, borrowId),
        ]
      }),
      loanEnds: loanEndsOf(
        fact.arguments,
        self,
        (ordinal) =>
          target.parameters.at(ordinal)?.phase !== 'Static' && !retainedBorrowOrdinals.has(ordinal),
      ),
      heldLoans: loanEndsOf(
        fact.arguments,
        self,
        (ordinal) =>
          target.parameters.at(ordinal)?.phase !== 'Static' && retainedBorrowOrdinals.has(ordinal),
      ),
      type: fact.type.type,
      span: options.context.spanOf(fact.anchor),
      origin: Tir.authored(fact.anchor),
    }
    return Type.isEffect(fact.type.type) &&
      fact.reference._tag === 'Resolved' &&
      fact.reference.declaration.functionKind === 'Effect'
      ? { ...call, _tag: 'EffectConstruct' as const, type: fact.type.type }
      : { ...call, _tag: 'Call' as const }
  }
  let cause: Diagnostic.Identity<Location.Location> | undefined
  if (fact.reference._tag === 'Missing' || fact.reference._tag === 'Ambiguous') {
    cause = fact.reference.cause
  } else if (fact.contract._tag === 'Unavailable') {
    cause = fact.contract.cause
  }
  return {
    _tag: 'Unavailable',
    ...(fact._tag === 'Call'
      ? {
          call: {
            ...(fact.reference._tag === 'Resolved' &&
            fact.reference.declaration.canonical._tag === 'Canonical'
              ? { target: fact.reference.declaration.canonical.id }
              : {}),
            arguments: fact.arguments.map((argument) =>
              tirExpression(argument.expression, options),
            ),
            ...(fact.reference._tag === 'Resolved'
              ? {
                  expectedCount: fact.reference.declaration.parameters.filter(
                    (parameter) => parameter.phase === 'Runtime',
                  ).length,
                }
              : {}),
          },
        }
      : {}),
    span: options.context.spanOf(fact.anchor),
    origin: Tir.authored(fact.anchor),
    ...(cause === undefined ? {} : publishedCause(options.builder, cause)),
  }
}

/** Wraps one return site so it packs its Effect into the function's composite representation. */
const effectJoinConvert = (
  source: Tir.Expression,
  target: SemanticType | undefined,
  expected: AuthoredHir.Anchor,
  options: LowerStatementOptions,
): Tir.Expression => {
  if (
    target === undefined ||
    source._tag === 'Unavailable' ||
    Type.isNever(source.type) ||
    !Type.isRepresented(target)
  )
    return source
  return publishExpression(options, {
    _tag: 'UnionConvert',
    source,
    sourceType: source.type,
    target,
    conversion: 'EffectJoin',
    mappings: [],
    access: 'Owned',
    context: 'Return',
    expectedAt: options.context.spanOf(expected),
    expected,
    type: target,
    span: source.span,
    origin: source.origin,
  })
}

export const tirExpectedExpression = (
  fact: ConstructionExpression,
  target: SemanticType,
  context: Extract<Tir.Expression, { readonly _tag: 'UnionConvert' }>['context'],
  expected: AuthoredHir.Anchor,
  options: LowerStatementOptions,
  borrow?: Tir.BorrowId,
): Tir.Expression => {
  if (
    !('origin' in fact) &&
    fact._tag === 'Integer' &&
    fact.integer._tag === 'Available' &&
    contextualIntegerCompatible(fact, target, options.builder) &&
    typeof target === 'string' &&
    Scalar.isIntegerSpelling(target)
  )
    return publishExpectedExpression(
      options,
      {
        _tag: 'IntegerLiteral',
        value: fact.integer.value,
        type: target,
        span: options.context.spanOf(fact.anchor),
        origin: Tir.authored(fact.anchor),
      },
      fact,
    )
  const loweredSource = tirExpression(fact, options, borrow)
  if (loweredSource._tag === 'Unavailable') return loweredSource
  const unionTarget = Type.isUnion(target) ? target : undefined
  const representation = representationOfExpression(options.context, fact, options.builder)
  const sourceContract = Type.isRepresented(loweredSource.type)
    ? loweredSource.type.contract
    : loweredSource.type
  const representedSource =
    representation !== undefined &&
    (Type.isCallable(sourceContract) || Type.isEffect(sourceContract)) &&
    unionTarget?.members.some(
      (member) =>
        Type.equals(member, sourceContract) ||
        (Type.isRepresented(member) && Type.equals(member.contract, sourceContract)),
    )
      ? Type.represented(sourceContract, sourceContract, representation)
      : undefined
  const source = loweredSource
  if (
    context === 'Return' &&
    options.opaqueResultFamily !== undefined &&
    Type.isRepresented(target) &&
    Type.isOpaqueRepresentationArgument(target.representation.argument) &&
    Type.equalsOpaqueFamily(target.representation.argument.family, options.opaqueResultFamily) &&
    representation !== undefined &&
    TypeCompatibility.isCompatible(
      TypeCompatibility.check(sourceContract, target.contract, options.lifetimeCompatibility),
    )
  )
    return source
  if (Type.isRepresented(target) && Type.haveSameRepresentationShape(source.type, target))
    return source
  const compatibility = TypeCompatibility.check(
    representedSource ?? source.type,
    target,
    options.lifetimeCompatibility,
  )
  if (compatibility._tag === 'Exact') return source
  if (
    compatibility._tag === 'Lifetime' ||
    compatibility._tag === 'CallableMode' ||
    compatibility._tag === 'EffectAccess' ||
    compatibility._tag === 'PointerWeakening'
  )
    return source
  if (compatibility._tag === 'Bottom') return source
  if (compatibility._tag === 'Incompatible') {
    return publishExpectedExpression(
      options,
      {
        _tag: 'Unavailable',
        span: loweredSource.span,
        origin: loweredSource.origin,
      },
      fact,
    )
  }
  return publishExpectedExpression(
    options,
    {
      _tag: 'UnionConvert',
      source,
      sourceType: compatibility.source,
      target: compatibility.target,
      conversion: compatibility._tag,
      mappings: compatibility.mappings,
      access: 'Owned',
      context,
      expectedAt: options.context.spanOf(expected),
      expected,
      type: compatibility.target,
      span: loweredSource.span,
      origin: loweredSource.origin,
    },
    fact,
  )
}

export const tirWritePlace = (
  fact: ConstructionExpression,
  root: AssignmentRootFact,
  options: LowerStatementOptions,
): Tir.WritePlace | undefined => {
  const selectors: Array<Tir.WriteSelector> = []
  const walk = (current: ConstructionExpression): boolean => {
    if ('origin' in current) {
      if (
        current._tag === 'BindingReference' ||
        current._tag === 'ParameterReference' ||
        current._tag === 'PatternBindingReference'
      ) {
        const selected = current._tag === 'ParameterReference' ? current.parameter : current.binding
        return selected.ordinal === localOf(options, root.id).ordinal
      }
      if (current._tag === 'Project') {
        if (!walk(current.subject)) return false
        selectors.push({
          _tag: 'Field',
          field: current.field,
          type: current.type,
          span: current.span,
          at: current.origin.anchor,
          origin: current.origin,
        })
        return true
      }
      if (current._tag === 'IndexPlace') {
        if (!walk(current.subject)) return false
        selectors.push({
          _tag: 'Index',
          index: current.index,
          array: current.array,
          bounds: current.bounds,
          type: current.type,
          span: current.span,
          at: current.origin.anchor,
          origin: current.origin,
        })
        return true
      }
      return false
    }
    if (current._tag === 'Identifier') {
      if (root._tag === 'PatternBinding')
        return (
          current.reference._tag === 'ResolvedPattern' && current.reference.binding.id === root.id
        )
      return root._tag === 'ParameterDeclaration'
        ? current.reference._tag === 'Resolved' &&
            current.reference.parameter.id.ordinal === root.id.ordinal
        : current.reference._tag === 'ResolvedBinding' &&
            current.reference.binding.id.ordinal === root.id.ordinal
    }
    if (current._tag === 'FieldProjection') {
      if (
        !walk(current.subject) ||
        current.state._tag !== 'Resolved' ||
        current.type._tag !== 'Available'
      ) {
        return false
      }
      selectors.push({
        _tag: 'Field',
        field: current.state.field.id,
        type: current.type.type,
        span: options.context.spanOf(current.anchor),
        at: current.anchor,
        origin: Tir.authored(current.anchor),
      })
      return true
    }
    if (current._tag === 'IndexProjection') {
      if (
        !walk(current.subject) ||
        current.array === undefined ||
        current.type._tag !== 'Available' ||
        (current.bounds._tag !== 'Proven' && current.bounds._tag !== 'Runtime')
      ) {
        return false
      }
      const index = tirExpression(current.index, options)
      if (index._tag === 'Unavailable') return false
      selectors.push({
        _tag: 'Index',
        index,
        array: current.array,
        bounds: current.bounds,
        type: current.type.type,
        span: options.context.spanOf(current.anchor),
        at: current.anchor,
        origin: Tir.authored(current.anchor),
      })
      return true
    }
    return false
  }
  const factType = constructionExpressionType(fact)
  if (!walk(fact) || factType._tag !== 'Available') return undefined
  let ownedRoot: Tir.OwnedWriteRoot
  if (root._tag === 'ParameterDeclaration')
    ownedRoot = { _tag: 'ParameterWriteRoot', parameter: localOf(options, root.id) }
  else if (root._tag === 'PatternBinding')
    ownedRoot = { _tag: 'PatternWriteRoot', binding: localOf(options, root.id) }
  else ownedRoot = { _tag: 'BindingWriteRoot', binding: localOf(options, root.id) }
  return {
    _tag: 'WritePlace',
    root: ownedRoot,
    selectors: selectors,
    type: factType.type,
    span: 'origin' in fact ? fact.span : options.context.spanOf(fact.anchor),
    origin: 'origin' in fact ? fact.origin : Tir.authored(fact.anchor),
  }
}

export const assignmentRootType = (root: AssignmentRootFact): SemanticType | undefined => {
  if (root._tag === 'PatternBinding')
    return root.type._tag === 'Available' ? root.type.type : undefined
  if (root._tag === 'ParameterDeclaration') {
    return root.declaredType._tag === 'Resolved' ? root.declaredType.type : undefined
  }
  return root.inferredType._tag === 'Available' ? root.inferredType.type : undefined
}

export const tirBorrowedWritePlace = (
  fact: ConstructionExpression,
  root: AssignmentRootFact,
  options: LowerStatementOptions,
): Tir.BorrowedWritePlace | undefined => {
  if (root._tag === 'PatternBinding') return undefined
  const rootType = assignmentRootType(root)
  if (rootType === undefined) return undefined
  const selectors: Array<Tir.BorrowedWriteSelector> = []
  let borrowed = false
  const walk = (current: ConstructionExpression): boolean => {
    if ('origin' in current) {
      if (current._tag === 'BindingReference' || current._tag === 'ParameterReference') {
        const selected = current._tag === 'ParameterReference' ? current.parameter : current.binding
        return selected.ordinal === localOf(options, root.id).ordinal
      }
      if (current._tag === 'ReferentPlace') {
        borrowed = current.borrowAccess === 'Exclusive'
        return borrowed && walk(current.subject)
      }
      if (current._tag === 'Project') {
        if (!walk(current.subject)) return false
        if (current.borrowAccess === 'Exclusive') borrowed = true
        selectors.push({
          _tag: 'Field',
          field: current.field,
          type: current.type,
          span: current.span,
          at: current.origin.anchor,
          origin: current.origin,
        })
        return true
      }
      if (current._tag === 'IndexPlace') {
        if (!walk(current.subject)) return false
        selectors.push({
          _tag: 'Index',
          index: current.index,
          array: current.array,
          bounds: current.bounds,
          type: current.type,
          span: current.span,
          at: current.origin.anchor,
          origin: current.origin,
        })
        return true
      }
      if (current._tag === 'SliceIndexPlace') {
        if (!walk(current.slice) || current.access !== 'Exclusive') return false
        borrowed = true
        selectors.push({
          _tag: 'SliceIndex',
          index: current.index,
          slice: current.sourceType,
          type: current.type,
          span: current.span,
          at: current.origin.anchor,
          origin: current.origin,
        })
        return true
      }
      return false
    }
    if (current._tag === 'Identifier') {
      return root._tag === 'ParameterDeclaration'
        ? current.reference._tag === 'Resolved' &&
            current.reference.parameter.id.ordinal === root.id.ordinal
        : current.reference._tag === 'ResolvedBinding' &&
            current.reference.binding.id.ordinal === root.id.ordinal
    }
    if (current._tag === 'FieldProjection') {
      if (
        !walk(current.subject) ||
        current.state._tag !== 'Resolved' ||
        current.type._tag !== 'Available'
      ) {
        return false
      }
      selectors.push({
        _tag: 'Field',
        field: current.state.field.id,
        type: current.type.type,
        span: options.context.spanOf(current.anchor),
        at: current.anchor,
        origin: Tir.authored(current.anchor),
      })
      return true
    }
    if (current._tag === 'ReferentProjection') {
      return (
        walk(current.subject) &&
        current.state._tag === 'Resolved' &&
        current.borrowAccess === 'Exclusive' &&
        current.type._tag === 'Available'
      )
    }
    if (current._tag === 'IndexProjection') {
      if (!walk(current.subject) || current.type._tag !== 'Available') return false
      const index = tirExpression(current.index, options)
      if (index._tag === 'Unavailable') return false
      if (
        current.slice !== undefined &&
        current.slice.access === 'Exclusive' &&
        current.bounds._tag === 'RuntimeSlice'
      ) {
        selectors.push({
          _tag: 'SliceIndex',
          index,
          slice: current.slice,
          type: current.type.type,
          span: options.context.spanOf(current.anchor),
          at: current.anchor,
          origin: Tir.authored(current.anchor),
        })
        return true
      }
      if (
        current.array === undefined ||
        (current.bounds._tag !== 'Proven' && current.bounds._tag !== 'Runtime')
      ) {
        return false
      }
      selectors.push({
        _tag: 'Index',
        index,
        array: current.array,
        bounds: current.bounds,
        type: current.type.type,
        span: options.context.spanOf(current.anchor),
        at: current.anchor,
        origin: Tir.authored(current.anchor),
      })
      return true
    }
    return false
  }
  const factType = constructionExpressionType(fact)
  if (!walk(fact) || !borrowed || factType._tag !== 'Available') return undefined
  return {
    _tag: 'BorrowedWritePlace',
    root:
      root._tag === 'ParameterDeclaration'
        ? {
            _tag: 'ParameterSliceRoot' as const,
            parameter: localOf(options, root.id),
          }
        : {
            _tag: 'BindingSliceRoot' as const,
            binding: localOf(options, root.id),
          },
    rootType,
    selectors: selectors,
    type: factType.type,
    span: 'origin' in fact ? fact.span : options.context.spanOf(fact.anchor),
    origin: 'origin' in fact ? fact.origin : Tir.authored(fact.anchor),
  }
}

export const tirAssignmentWritePlace = (
  fact: ConstructionExpression,
  root: AssignmentRootFact,
  options: LowerStatementOptions,
): Tir.WritePlace | undefined => {
  if ('origin' in fact)
    return tirBorrowedWritePlace(fact, root, options) ?? tirWritePlace(fact, root, options)
  const access = assignmentRootAccess(root, fact)
  if (access === 'ExclusiveBorrowed') return tirBorrowedWritePlace(fact, root, options)
  if (access === 'MutableOwned') return tirWritePlace(fact, root, options)
  return undefined
}

export const directStatementExpressions = (
  statement: StatementDraft | Tir.Statement,
): ReadonlyArray<ConstructionExpression> => {
  switch (statement._tag) {
    case 'UnavailableStatement':
      return statement.write === undefined
        ? []
        : [statement.write.destination, statement.write.value]
    case 'Bind':
      return [statement.initializer]
    case 'PatternBind':
      return [statement.selection.subject]
    case 'Evaluate':
      return [statement.expression]
    case 'Return':
    case 'Fail':
    case 'Drop':
      return [statement.expression]
    case 'If':
    case 'While':
      return [statement.condition]
    case 'IfLet':
      return [statement.selection.subject]
    case 'Write':
      return statement.destination === undefined
        ? [statement.value]
        : [statement.destination, statement.value]
    case 'Unsafe':
    case 'Break':
    case 'Continue':
      return []
    case 'BindStatement':
      return [statement.binding.initializer]
    case 'PatternBindStatement':
      return [statement.selection.source]
    case 'ExpressionStatement':
      return [statement.expression]
    case 'ReturnStatement':
    case 'FailStatement':
    case 'DropStatement':
      return [statement.expression]
    case 'IfStatement':
    case 'WhileStatement':
      return [statement.condition]
    case 'IfLetStatement':
      return [statement.selection.source]
    case 'WriteStatement':
      return [statement.destination, statement.value]
    case 'UnsafeStatement':
    case 'BreakStatement':
    case 'ContinueStatement':
      return []
  }
}

export const directExpressionChildren = (
  expression: ConstructionExpression,
): ReadonlyArray<ConstructionExpression> => {
  if ('origin' in expression) return Tir.expressionChildren(expression)
  switch (expression._tag) {
    case 'CompileError':
      return [expression.message]
    case 'EnumValue':
      return [expression.argument]
    case 'Move':
    case 'Borrow':
    case 'FieldProjection':
    case 'ReferentProjection':
    case 'Run':
      return [expression.subject]
    case 'PlaceReplace':
      return [expression.destination, expression.value]
    case 'IndexProjection':
      return [expression.subject, expression.index]
    case 'ArrayLiteral':
      return expression.elements.map((element) => element.expression)
    case 'StructLiteral':
    case 'UnionVariant':
      return expression.initializers.map((initializer) => initializer.expression)
    case 'EffectBindRequirement':
      return [expression.protected]
    case 'EffectCatch':
      return [expression.protected, expression.handler]
    case 'CallableSection':
      return expression.captures.map((capture) => capture.expression)
    case 'ForeignApply':
    case 'CallableApply':
      return [expression.callee, ...expression.arguments.map((argument) => argument.expression)]
    case 'Operator':
    case 'ShortCircuit':
    case 'Call':
      return expression.arguments.map((argument) => argument.expression)
    case 'EffectBlock':
    case 'Match':
    case 'Integer':
    case 'Duration':
    case 'Floating':
    case 'StaticText':
    case 'Character':
    case 'Unit':
    case 'Boolean':
    case 'Constant':
    case 'ForeignStatic':
    case 'EnumMember':
    case 'Identifier':
    case 'FunctionItem':
      return []
  }
}

/** Callbacks for one deterministic traversal of elaborated statement and expression facts. */

/**
 * Lowers what construction has analyzed so far into nodes the evaluator can interpret.
 *
 * One lowering is shared by everything evaluated for one body: the evaluator keeps text provenance
 * per node, and a subexpression must be the same node whenever its parent is evaluated again.
 */
export interface StaticLowering {
  readonly expression: (fact: ConstructionExpression) => Tir.Expression
  readonly statements: (facts: ReadonlyArray<Tir.Statement>) => ReadonlyArray<Tir.Statement>
}

export const staticLowering = (
  context: SemanticContext.SemanticContext,
  builder?: BodyArena.BodyBuilder,
): StaticLowering => {
  const options: LowerStatementOptions = {
    context,
    static: builder?.expressions ?? new WeakMap(),
    ...(builder === undefined ? {} : { builder }),
  }
  return {
    expression: (fact: ConstructionExpression) => tirExpression(fact, options),
    statements: (facts: ReadonlyArray<Tir.Statement>) => facts,
  }
}
