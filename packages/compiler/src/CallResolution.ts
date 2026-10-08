import * as Location from './Location.js'
import * as CAbi from './CAbi.js'
import * as AuthoredIdentity from './AuthoredIdentity.js'
import type * as AuthoredHir from './AuthoredHir.js'
import * as AuthoredWalk from './AuthoredWalk.js'
import * as SemanticContext from './SemanticContext.js'
import * as Semantic from './Semantic.js'
import * as BodyLifetime from './BodyLifetime.js'
import * as Lifetime from './Lifetime.js'
import * as ForeignContract from './ForeignContract.js'
import * as CallableContract from './CallableContract.js'
import * as ConformanceGoal from './ConformanceGoal.js'
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
  ArgumentMappingFact,
  ArgumentsResult,
  CallableApplyExpressionDecision,
  CallableCaptureFact,
  CallableSectionExpressionDecision,
  CallContractFact,
  CallReferenceFact,
  DeclarationFact,
  ExpressionDecision,
  ExpressionResult,
  InferredProviderSelector,
  ReferencePathFact,
  SemanticType,
  TypeArgumentFact,
} from './Elaboration.js'
import {
  argumentFact,
  availableExpressionType,
  callCallee,
  constructionExpressionAnchor,
  constructionExpressionType,
  contextualIntegerCompatible,
  expressionNode,
  lookupDeclaration,
  referenceNames,
  referencePath,
  typesCompatible,
  unavailableExpressionType,
  unionConversionDiagnostic,
} from './Elaboration.js'
import type { ResolutionContext, Scope } from './ExpressionAnalysis.js'
import {
  analyzeExpression,
  effectBindingProvider,
  effectCaptureAccess,
  effectExpressionAccess,
  representationOfExpression,
  resolveValueName,
  sectionIntrinsicReference,
  strongestEffectAccess,
} from './ExpressionAnalysis.js'
import * as Tir from './Tir.js'
import * as BodyBuilder from './BodyBuilder.js'
import * as Intrinsic from './Intrinsic.js'
import * as TypeInference from './internal/TypeInference.js'
import * as NameResolution from './NameResolution.js'
import * as ProviderSelection from './ProviderSelection.js'
import * as ResolutionWork from './ResolutionWork.js'
import * as RequirementRow from './RequirementRow.js'
import * as RowAlgebra from './RowAlgebra.js'
import { unsafeCallDiagnostic } from './StatementAnalysis.js'
import * as Type from './Type.js'
import * as TypeCompatibility from './TypeCompatibility.js'

const unavailableNode = (
  context: SemanticContext.SemanticContext,
  anchor: AuthoredHir.Anchor,
  resolution: ResolutionContext | undefined,
): Tir.Expression => {
  const node = {
    _tag: 'Unavailable' as const,
    span: context.spanOf(anchor),
    origin: Tir.authored(anchor),
  }
  return resolution?.builder === undefined ? node : BodyBuilder.node(resolution.builder, node)
}

export const analyzeArgumentNodes = (
  context: SemanticContext.SemanticContext,
  site: AuthoredHir.Expression,
  nodes: ReadonlyArray<AuthoredHir.Expression>,
  declarations: ReadonlyArray<DeclarationFact>,
  declaration: DeclarationFact,
  scope: Scope,
  resolution: ResolutionContext,
  expectedTypes: ReadonlyArray<SemanticType | undefined> = [],
  consumer?: TypeInference.InvocationConsumer,
): ArgumentsResult => {
  const inferred = new Map<string, Type.GenericArgument>(consumer?.substitution)
  // A nested call establishes its own advisory domain; an enclosing argument context
  // must not authorize foreign holes in that call or in an unrelated hidden body.
  const { invocationConsumer: enclosingConsumer, ...argumentResolution } = resolution
  void enclosingConsumer
  const lifetimes = selectedCallLifetimes(
    site,
    [],
    resolution,
    consumer?.substitution,
    undefined,
    new Set(
      (consumer?.binders ?? []).flatMap((parameter) => {
        const argument = Type.parameterArgument(parameter)
        return Lifetime.isLifetime(argument) && !inferred.has(Lifetime.key(argument))
          ? [Lifetime.key(argument)]
          : []
      }),
    ),
  )
  // An operand recovery invented to fill an empty position is not an argument the author wrote.
  const written = nodes.filter(
    (element) =>
      element._tag !== 'MissingExpression' &&
      !(element._tag === 'IdentifierExpression' && element.name._tag !== 'Name'),
  )
  const analyzed = written.flatMap((element, ordinal): ReadonlyArray<ExpressionResult> => {
    const pattern = expectedTypes.at(ordinal)
    const expected = pattern === undefined ? undefined : Type.substitute(pattern, inferred)
    const result = analyzeExpression(
      context,
      element,
      declarations,
      declaration,
      scope,
      consumer === undefined
        ? argumentResolution
        : {
            ...argumentResolution,
            invocationConsumer: {
              binders: consumer.binders,
              substitution: new Map(inferred),
              caller: declaration.id,
            },
          },
      expected,
    )
    if (pattern !== undefined && result?.type !== undefined) {
      const attempt = new Map(inferred)
      if (TypeInference.infer(pattern, result.type, attempt, lifetimes.inference))
        commitSpecialization(inferred, attempt)
    }
    return result === undefined ? [] : [result]
  })
  const facts = analyzed.map((result, ordinal) =>
    argumentFact(declaration, context, site.anchor, result, ordinal),
  )

  return {
    facts: facts,
    diagnostics: analyzed.flatMap((result) => result.diagnostics),
  }
}

export function analyzeArguments(
  context: SemanticContext.SemanticContext,
  call: AuthoredHir.Expression,
  declarations: ReadonlyArray<DeclarationFact>,
  declaration: DeclarationFact,
  scope: Scope,
  resolution: ResolutionContext,
  callTypeArguments?: CallTypeArgumentsResult,
): ArgumentsResult {
  const argumentNodes = call._tag === 'CallExpression' ? call.arguments : []
  const identifiers = referenceNames(call)
  const first = identifiers.at(0)
  const second = identifiers.at(1)
  let target: SourceCallable | undefined
  let enclosingTypeParameters: ReadonlyArray<Type.Parameter> = []
  let builtinParameters: ReadonlyArray<SemanticType> = []
  let builtinTypeParameters: ReadonlyArray<Type.Parameter> = []
  let builtinLifetimes: ReadonlyArray<Lifetime.Bound> = []
  let boundParameters: ReadonlyArray<SemanticType> = []
  if (first !== undefined && second === undefined) {
    const name = SemanticContext.nameText(context, first) ?? ''
    const resolved = Semantic.resolveName(resolution.semantic, resolution.scope, name)
    const local = lookupDeclaration(declarations, name)
    if (resolved._tag === 'Resolved' && resolved.declaration._tag === 'FunctionDeclaration') {
      target = resolved.declaration
    } else if (local._tag === 'Resolved') {
      target = local.declaration
    }
  } else if (first !== undefined && second !== undefined) {
    const qualifierSpelling = SemanticContext.nameText(context, first) ?? ''
    const memberSpelling = SemanticContext.nameText(context, second) ?? ''
    const qualifier = Semantic.resolveName(resolution.semantic, resolution.scope, qualifierSpelling)
    const associated =
      qualifier._tag === 'Resolved'
        ? Semantic.resolveAssociatedName(
            resolution.semantic,
            qualifier.declaration,
            memberSpelling,
            resolution.scope.module,
          )
        : undefined
    if (associated?._tag === 'Inherent') {
      target = associated.declaration
    } else if (qualifier._tag === 'Intrinsic') {
      const builtin = builtinSignature(qualifierSpelling, memberSpelling)
      const intrinsic = Intrinsic.findOperation(qualifierSpelling, memberSpelling)
      const contract = intrinsic?.rule._tag === 'ContractRule' ? intrinsic.rule.contract : undefined
      builtinParameters =
        builtin?.parameters ?? contract?.parameters.map((parameter) => parameter.type) ?? []
      builtinTypeParameters = builtin?.typeParameters ?? contract?.binders ?? []
      const result =
        builtin === undefined ? contract?.result : Intrinsic.closedResultType(builtin.result)
      builtinLifetimes = freeLifetimeBinders([
        ...builtinParameters,
        ...(result === undefined ? [] : [result]),
      ])
    } else if (qualifier._tag === 'Namespace') {
      const member = DeclarationFacts.lookup(resolution.index, qualifier.module, memberSpelling)
      target =
        member._tag === 'Resolved' && member.declaration._tag === 'FunctionDeclaration'
          ? member.declaration
          : undefined
    } else if (
      qualifier._tag === 'Resolved' &&
      qualifier.declaration._tag === 'ServiceDeclaration'
    ) {
      target = serviceOperation(qualifier.declaration, memberSpelling)
      enclosingTypeParameters = qualifier.declaration.typeParameters.map(
        (parameter) => parameter.type,
      )
    } else if (
      qualifier._tag === 'Resolved' &&
      qualifier.declaration._tag === 'InterfaceDeclaration'
    ) {
      const memberToken = second
      const bound = boundOperationReference(
        declaration,
        qualifier.declaration,
        qualifierSpelling,
        memberSpelling,
        memberToken,
      )
      if (bound?._tag === 'BoundOperation')
        boundParameters = instantiateInterfaceReference(
          bound.reference,
          call,
          resolution,
        ).parameters
    }
  }
  if (first !== undefined && second === undefined) {
    const callee = resolveValueName(
      context,
      scope,
      SemanticContext.nameText(context, first) ?? '',
      first.anchor,
    )
    if (callee.type._tag === 'Available' && Type.isForeignFunction(callee.type.type)) {
      target = undefined
      const selected = selectedCallLifetimes(call, callee.type.type.lifetimeBinders, resolution)
      boundParameters = callee.type.type.parameters.map((parameter) =>
        Type.substitute(parameter, selected.substitution),
      )
    }
  }
  const declaredTypeParameters = [
    ...enclosingTypeParameters,
    ...(target?.typeParameters.map((parameter) => parameter.type) ?? []),
  ]
  const explicitTypes = callTypeArguments?.types
  const explicitBuiltinSubstitution =
    callTypeArguments?.explicit === true &&
    explicitTypes !== undefined &&
    explicitTypes.length <= builtinTypeParameters.length
      ? explicitArgumentSubstitution(builtinTypeParameters, callTypeArguments.facts)
      : undefined
  const builtinSubstitution = selectedCallLifetimes(
    call,
    builtinLifetimes,
    resolution,
    explicitBuiltinSubstitution,
  ).substitution
  // An explicit prefix is context for the value arguments just as a complete list is: the
  // parameters it binds become concrete expected types, and the ones it leaves open stay symbolic
  // exactly as they are when nothing was written.
  const explicitSubstitution =
    callTypeArguments?.explicit === true && explicitTypes !== undefined
      ? explicitArgumentSubstitution(declaredTypeParameters, callTypeArguments.facts)
      : undefined
  const targetInvocation =
    target === undefined
      ? undefined
      : DeclarationFacts.executableLifetimes(target).invocationUse?.lifetime
  const substitution =
    target === undefined
      ? explicitSubstitution
      : selectedCallLifetimes(
          call,
          DeclarationFacts.executableLifetimes(target).lifetimeBinders,
          resolution,
          explicitSubstitution,
          targetInvocation?._tag === 'BoundLifetime' ? targetInvocation : undefined,
          inputInferredCallLifetimes(
            DeclarationFacts.executableLifetimes(target).lifetimeBinders,
            target.parameters.flatMap((parameter) =>
              parameter.declaredType._tag === 'Resolved' ? [parameter.declaredType.type] : [],
            ),
            targetInvocation?._tag === 'BoundLifetime' ? targetInvocation : undefined,
            declaredTypeParameters,
          ),
        ).substitution
  let selectedParameters: ReadonlyArray<SemanticType | undefined>
  if (boundParameters.length > 0) selectedParameters = boundParameters
  else if (builtinParameters.length > 0) {
    const offset = isSectionArity(builtinParameters.length, argumentNodes.length)
      ? builtinParameters.length - argumentNodes.length
      : 0
    selectedParameters = builtinParameters
      .slice(offset)
      .map((parameter) => Type.substitute(parameter, builtinSubstitution ?? new Map()))
  } else {
    const offset =
      target !== undefined && isSectionArity(target.parameters.length, argumentNodes.length)
        ? target.parameters.length - argumentNodes.length
        : 0
    selectedParameters = (target?.parameters ?? [])
      .slice(offset)
      .map((parameter) =>
        parameter.declaredType._tag === 'Resolved' ? parameter.declaredType.type : undefined,
      )
  }
  const expectedTypes = selectedParameters
  return analyzeArgumentNodes(
    context,
    call,
    argumentNodes,
    declarations,
    declaration,
    scope,
    resolution,
    expectedTypes,
    target === undefined
      ? undefined
      : {
          binders: declaredTypeParameters,
          substitution: substitution ?? new Map(),
        },
  )
}

export interface CallContractResult {
  readonly mappings: ReadonlyArray<ArgumentMappingFact>
  readonly fact: CallContractFact
  readonly diagnostics: ReadonlyArray<Diagnostic.Located>
}

export interface CallTypeArgumentsResult {
  readonly explicit: boolean
  readonly facts: ReadonlyArray<TypeArgumentFact>
  readonly types?: ReadonlyArray<Type.GenericArgument>
  readonly diagnostics: ReadonlyArray<Diagnostic.Located>
}

const requirementArgumentOfType = (
  type: Type.Type,
  role: RequirementRow.Role,
): Type.RequirementRowArgument | undefined => {
  if (Type.isParameter(type) && type.kind === 'RequirementRow')
    return Type.requirementRowArgument([], [type])
  if (Type.isNever(type)) return Type.requirementRowArgument([])
  if (
    Type.isReference(type) &&
    (Type.isNominal(type.target) || (Type.isParameter(type.target) && type.target.kind === 'Value'))
  )
    return Type.requirementRowArgument([{ capability: type.target, role, access: type.access }])
  if (Type.isUnion(type)) {
    const members = type.members.map((member) => requirementArgumentOfType(member, role))
    if (members.every((member): member is Type.RequirementRowArgument => member !== undefined))
      return Type.requirementRowArgument(
        members.flatMap(Type.requirementMembers),
        members.flatMap(Type.requirementRowParameters),
      )
    return undefined
  }
  if (Type.isNominal(type) || (Type.isParameter(type) && type.kind === 'Value'))
    return Type.requirementRowArgument([{ capability: type, role, access: 'Shared' }])
  return undefined
}

const explicitSourceCallTypeParameters = (
  context: SemanticContext.SemanticContext,
  call: AuthoredHir.Expression,
  resolution: ResolutionContext,
): ReadonlyArray<Type.Parameter> => {
  const identifiers = referenceNames(call)
  const first = identifiers.at(0)
  const second = identifiers.at(1)
  let target: SourceCallable | undefined
  if (first !== undefined && second === undefined) {
    const resolved = Semantic.resolveName(
      resolution.semantic,
      resolution.scope,
      SemanticContext.nameText(context, first) ?? '',
    )
    if (resolved._tag === 'Resolved' && resolved.declaration._tag === 'FunctionDeclaration')
      target = resolved.declaration
  } else if (first !== undefined && second !== undefined) {
    const qualifier = Semantic.resolveName(
      resolution.semantic,
      resolution.scope,
      SemanticContext.nameText(context, first) ?? '',
    )
    const member = SemanticContext.nameText(context, second) ?? ''
    if (qualifier._tag === 'Namespace') {
      const selected = DeclarationFacts.lookup(resolution.index, qualifier.module, member)
      if (selected._tag === 'Resolved' && selected.declaration._tag === 'FunctionDeclaration')
        target = selected.declaration
    } else if (qualifier._tag === 'Resolved') {
      const associated = Semantic.resolveAssociatedName(
        resolution.semantic,
        qualifier.declaration,
        member,
        resolution.scope.module,
      )
      if (associated._tag === 'Inherent') target = associated.declaration
      else if (qualifier.declaration._tag === 'ServiceDeclaration') {
        target = serviceOperation(qualifier.declaration, member)
        if (target !== undefined)
          return DeclarationFacts.callableContract(target, qualifier.declaration.typeParameters)
            .binders
      }
    }
  }
  return target?.typeParameters.map((parameter) => parameter.type) ?? []
}

/**
 * The type arguments an applied qualifier supplies ahead of the call's own list: for an inherent
 * member `Option<i32>.map<i64>(...)` the owner's `<i32>` binds the owner binders, so the complete
 * explicit prefix reads as `Option.map<i32, i64>`.
 */
export const appliedOwnerTypeArgumentNodes = (
  call: AuthoredHir.Expression,
): ReadonlyArray<AuthoredHir.GenericArgument> => {
  const callee = callCallee(call)
  if (callee._tag !== 'MemberExpression') return []
  const owner = callee.selector.subject
  return owner._tag === 'AppliedType' ? owner.arguments.arguments : []
}

export const analyzeCallTypeArguments = (
  context: SemanticContext.SemanticContext,
  call: AuthoredHir.Expression,
  caller: DeclarationFact | undefined,
  resolution: ResolutionContext,
  leading: ReadonlyArray<AuthoredHir.GenericArgument> = [],
): CallTypeArgumentsResult => {
  const list = call._tag === 'CallExpression' ? call.generics : undefined
  if (list === undefined && leading.length === 0) {
    return {
      explicit: false,
      facts: [],
      diagnostics: [],
    }
  }
  const environment = new Map(
    (caller?.typeParameters ?? []).flatMap((parameter) =>
      parameter.name._tag === 'Present' ? [[parameter.name.spelling, parameter.type] as const] : [],
    ),
  )
  const nameResolution: NameResolution.Resolution = {
    _tag: 'NameResolution',
    modules: [resolution.scope],
    contexts: SemanticContext.registry([context]),
    diagnostics: [],
  }
  const nodes = [...leading, ...(list === undefined ? [] : list.arguments)]
  const targetParameters = explicitSourceCallTypeParameters(context, call, resolution)
  const lifetimeParameters = targetParameters.filter((parameter) => parameter.kind === 'Lifetime')
  const ordinaryParameters = targetParameters.filter((parameter) => parameter.kind !== 'Lifetime')
  let lifetimeOrdinal = 0
  let ordinaryOrdinal = 0
  const analyzed = nodes.map((node, ordinal) => {
    const targetParameter =
      node._tag === 'Lifetime'
        ? lifetimeParameters.at(lifetimeOrdinal++)
        : ordinaryParameters.at(ordinaryOrdinal++)
    const argumentNode = node._tag === 'RequirementSelector' ? node.subject : node
    const roleNode = node._tag === 'RequirementSelector' ? node.role : undefined
    const directToken =
      argumentNode._tag === 'NamedType' ? argumentNode.path.segments.at(0) : undefined
    const directSpelling =
      directToken === undefined ? undefined : SemanticContext.nameText(context, directToken)
    const directParameter =
      directSpelling === undefined ? undefined : environment.get(directSpelling)
    if (
      directToken !== undefined &&
      directParameter !== undefined &&
      directParameter.kind !== 'Value'
    )
      return {
        fact: {
          _tag: 'TypeArgument' as const,
          ordinal,
          anchor: node.anchor,
          declared: {
            _tag: 'Resolved' as const,
            type: directParameter,
            spelling: directParameter.name,
            anchor: directToken.anchor,
          },
          type: directParameter,
        },
        diagnostics: [],
      }
    const roleSegments =
      roleNode === undefined
        ? []
        : roleNode.segments.map((segment) => ({
            spelling: SemanticContext.nameText(context, segment) ?? '',
            anchor: segment.anchor,
          }))
    const rolePath =
      roleSegments.length > 0 && roleNode !== undefined
        ? {
            _tag: 'TypePath' as const,
            spelling: roleSegments.map((segment) => segment.spelling).join('.'),
            segments: roleSegments,
            anchor: roleNode.anchor,
          }
        : undefined
    const roleResolution =
      rolePath === undefined
        ? undefined
        : NameResolution.resolveItem(
            nameResolution,
            resolution.index,
            AuthoredWalk.moduleName(context),
            rolePath,
          )
    const roleDeclaration =
      roleResolution?._tag === 'Resolved' && roleResolution.declaration._tag === 'RoleDeclaration'
        ? roleResolution.declaration
        : undefined
    const requirementRole =
      roleDeclaration?.canonical._tag === 'Canonical'
        ? RequirementRow.declaredRole(
            roleDeclaration.canonical.id.module,
            roleDeclaration.canonical.id.name,
          )
        : undefined
    const roleDiagnostics =
      rolePath === undefined || requirementRole !== undefined
        ? ([] as ReadonlyArray<Diagnostic.Located>)
        : [
            Diagnostic.invalidRequirementType(
              `role ${rolePath.spelling}`,
              Location.at(rolePath.anchor),
            ),
          ]
    const body = resolution.bodyLifetimes
    const owningDeclaration = resolution.authoredDeclaration
    const lifetimeContext =
      body === undefined || owningDeclaration === undefined
        ? undefined
        : DeclarationLifetime.forBody(context, body, owningDeclaration, environment, {
            scope: resolution.scope,
            index: resolution.index,
            parametersOf: (path) => {
              const rawPath = DeclarationCollection.analyzeDeclaredType(
                context,
                path,
                environment,
                true,
              ).fact
              if (rawPath._tag !== 'Unresolved' || rawPath.path === undefined) return undefined
              const target = NameResolution.resolveType(
                nameResolution,
                resolution.index,
                AuthoredWalk.moduleName(context),
                rawPath.path,
              ).fact
              return target._tag === 'Resolved' && Type.isNominal(target.type)
                ? DeclarationResolution.memberByNominal(
                    resolution.index.modules,
                    target.type,
                  )?.typeParameters.map((parameter) => parameter.type)
                : undefined
            },
          })
    const raw = DeclarationCollection.analyzeDeclaredType(
      context,
      argumentNode,
      environment,
      true,
      lifetimeContext,
    )
    if (targetParameter?.kind === 'RequirementRow' && raw.fact._tag === 'Union') {
      const members = raw.fact.members.map((member) =>
        DeclarationResolution.resolveTypeFact(
          context.spanOf,
          resolution.index,
          AuthoredWalk.moduleName(context),
          member,
          (module, path) =>
            NameResolution.resolveType(nameResolution, resolution.index, module, path),
        ),
      )
      const arguments_ = members.map((member) =>
        member.fact._tag === 'Resolved'
          ? requirementArgumentOfType(
              member.fact.type,
              requirementRole ?? RequirementRow.defaultRole,
            )
          : undefined,
      )
      const argument = arguments_.every(
        (member): member is Type.RequirementRowArgument => member !== undefined,
      )
        ? Type.requirementRowArgument(
            arguments_.flatMap(Type.requirementMembers),
            arguments_.flatMap(Type.requirementRowParameters),
          )
        : undefined
      const diagnostics = Diagnostic.collect(
        raw.diagnostics,
        ...members.map((member) => member.diagnostics),
        roleDiagnostics,
      )
      return {
        fact: {
          _tag: 'TypeArgument' as const,
          ordinal,
          anchor: node.anchor,
          declared: {
            ...raw.fact,
            members: members.map((member) => member.fact),
          },
          ...(requirementRole === undefined ? {} : { requirementRole }),
          ...(argument === undefined ? {} : { type: argument }),
        },
        diagnostics,
      }
    }
    const resolved = DeclarationResolution.resolveTypeFact(
      context.spanOf,
      resolution.index,
      AuthoredWalk.moduleName(context),
      raw.fact,
      (module, path) => NameResolution.resolveType(nameResolution, resolution.index, module, path),
    )
    return {
      fact: {
        _tag: 'TypeArgument' as const,
        ordinal,
        anchor: node.anchor,
        declared: resolved.fact,
        ...(requirementRole === undefined ? {} : { requirementRole }),
        ...((resolved.fact._tag === 'Resolved' || resolved.fact._tag === 'Lifetime') &&
        roleDiagnostics.length === 0
          ? {
              type: resolved.fact._tag === 'Lifetime' ? resolved.fact.lifetime : resolved.fact.type,
            }
          : {}),
      },
      diagnostics: Diagnostic.collect(raw.diagnostics, resolved.diagnostics, roleDiagnostics),
    }
  })
  const facts = analyzed.map((entry) => entry.fact)
  const available = facts.map((fact) => fact.type)
  return {
    explicit: true,
    facts,
    ...(available.every((type) => type !== undefined)
      ? {
          types: available.filter((type) => type !== undefined),
        }
      : {}),
    diagnostics: Diagnostic.collect(...analyzed.map((entry) => entry.diagnostics)),
  }
}

/** True when neither the callee nor any argument of a call is a lexical-recovery placeholder. */
export const hasAvailableCallSyntax = (call: AuthoredHir.Expression): boolean =>
  call._tag === 'CallExpression' &&
  AuthoredWalk.isAvailable(call.callee) &&
  call.arguments.every(AuthoredWalk.isAvailable)

export const isSectionArity = (expectedCount: number, actualCount: number): boolean =>
  actualCount > 0 && actualCount < expectedCount

/** The parameter ordinals a trailing section of `count` parameters captures for its arguments. */
export const trailingCaptures = (count: number, argumentCount: number): ReadonlyArray<number> =>
  Array.from({ length: argumentCount }, (_, ordinal) => count - argumentCount + ordinal)

const parameterAt = <P>(
  parameters: ReadonlyArray<P>,
  captured: ReadonlyArray<number>,
  ordinal: number,
): P | undefined => {
  const parameter = captured.at(ordinal)
  return parameter === undefined ? undefined : parameters.at(parameter)
}

const remainingOf = <P>(
  parameters: ReadonlyArray<P>,
  captured: ReadonlyArray<number>,
): ReadonlyArray<P> => parameters.filter((_, ordinal) => !captured.includes(ordinal))

export type SourceCallable = DeclarationFact | DeclarationFacts.ServiceOperationFact

export const sourceCallable = (reference: CallReferenceFact): SourceCallable | undefined => {
  if (reference._tag === 'Resolved') {
    return reference.declaration
  }
  if (reference._tag === 'ResolvedServiceOperation') {
    return reference.operation
  }
  return undefined
}

export const resolvedCallableContract = (
  reference: CallReferenceFact,
): CallableContract.CallableContract | undefined => {
  if (reference._tag === 'ResolvedIntrinsicContract') return reference.contract
  const callable = sourceCallable(reference)
  if (callable === undefined) {
    return undefined
  }
  return DeclarationFacts.callableContract(
    callable,
    reference._tag === 'ResolvedServiceOperation' ? reference.service.typeParameters : [],
  )
}

/** Authenticates a future selected input against the primitive's original marked contract. */
export const recoveryInvocationRecipe = (
  contract: CallableContract.CallableContract,
  substitution: Type.Substitution,
  selected: Type.Type,
  origin: AuthoredHir.Anchor,
  body: BodyLifetime.BodyLifetime | undefined,
): Tir.RecoveryInvocationRecipe | undefined => {
  const parameter = contract.parameters.at(1)
  const required =
    parameter === undefined ? undefined : Type.substitute(parameter.type, substitution)
  const binder =
    required !== undefined && Type.isCallable(required)
      ? required.invocationUse?.lifetime
      : undefined
  if (binder?._tag !== 'BoundLifetime' || body === undefined) return undefined
  const lifetime = BodyLifetime.invocationRegion(body, origin, binder)
  if (lifetime === undefined) return undefined
  return {
    owner: body.owner,
    lifetime,
    origin,
    parameter: 0,
    selected,
    binder,
  }
}

export const callArityDiagnostic = (
  reference: Extract<
    CallReferenceFact,
    {
      readonly _tag:
        | 'Resolved'
        | 'ResolvedBuiltin'
        | 'ResolvedIntrinsicContract'
        | 'ResolvedServiceOperation'
        | 'ResolvedInterfaceOperation'
    }
  >,
  expectedCount: number,
  actualCount: number,
  span: Location.Location,
): Diagnostic.Located => {
  if (
    expectedCount === 1 &&
    actualCount === 0 &&
    !(reference._tag === 'Resolved' && reference.declaration.foreign?.variadic === true)
  )
    return Diagnostic.redundantUnaryEmptyCall(reference.spelling, span)
  let target: Parameters<typeof Diagnostic.wrongCallArity>[0]
  if (reference._tag === 'ResolvedBuiltin') {
    target = {
      _tag: 'BuiltinTarget',
      actor: reference.actor,
      operation: reference.operation,
    }
  } else if (reference._tag === 'ResolvedIntrinsicContract') {
    target = {
      _tag: 'BuiltinTarget',
      actor: 'Intrinsic',
      operation: reference.intrinsic.spelling,
    }
  } else if (reference._tag === 'ResolvedInterfaceOperation') {
    target = {
      _tag: 'BuiltinTarget',
      actor: reference.capability.name,
      operation: reference.operation,
    }
  } else if (reference._tag === 'Resolved') target = reference.declaration.id
  else target = reference.operation.id
  return Diagnostic.wrongCallArity(target, expectedCount, actualCount, span)
}

/** One value argument paired with the parameter type it must determine. */
export interface SpecializationSite {
  /** Position of the argument in the call, so a caller can keep one mistake to one report. */
  readonly ordinal: number
  readonly pattern: SemanticType
  readonly actual: SemanticType
  readonly expression: Tir.Expression
}

/** One written type argument the value arguments contradict, reported at what was written. */
export interface SpecializationConflict {
  readonly diagnostic: Diagnostic.Located
  /** The argument that implied the other type, absent when no value argument is involved. */
  readonly ordinal?: number
}

export interface SeededSpecialization {
  readonly substitution: Type.Substitution
  readonly typeArguments: ReadonlyArray<Type.GenericArgument>
  readonly conflicts: ReadonlyArray<SpecializationConflict>
  /**
   * A parameter no explicit argument wrote and no value argument determines. It waits for the
   * ordinary argument checks, because an argument the call got wrong is the better first report.
   */
  readonly unresolved?: Diagnostic.Located
}

/** Converts one written source type argument to the generic kind its declaration binder owns. */
export const genericArgumentOfTypeArgument = (
  parameter: Type.Parameter,
  fact: TypeArgumentFact,
): Type.GenericArgument | undefined => {
  const writtenType = fact.type
  if (writtenType === undefined) return undefined
  if (parameter.kind === 'Lifetime')
    return Lifetime.isLifetime(writtenType) ? writtenType : undefined
  if (Lifetime.isLifetime(writtenType)) return undefined
  if (Type.isRequirementRowArgument(writtenType))
    return parameter.kind === 'RequirementRow' ? writtenType : undefined
  if (parameter.kind === 'Value') return Type.isTypeArgument(writtenType) ? writtenType : undefined
  if (parameter.kind === 'CallableRepresentation' || parameter.kind === 'EffectRepresentation') {
    if (
      Type.isParameter(writtenType) &&
      writtenType.kind === parameter.kind &&
      writtenType.representationBound !== undefined
    )
      return Type.representationParameterArgument(writtenType)
    if (
      Type.isRepresented(writtenType) &&
      Type.representationArgumentKind(writtenType.representation.argument) === parameter.kind
    )
      return writtenType.representation.argument
    return undefined
  }
  return requirementArgumentOfType(writtenType, fact.requirementRole ?? RequirementRow.defaultRole)
}

/** Normalizes written row and representation arguments before they contextualize value arguments. */
const explicitArgumentSubstitution = (
  parameters: ReadonlyArray<Type.Parameter>,
  facts: ReadonlyArray<TypeArgumentFact>,
): Type.Substitution | undefined => {
  const lifetimes = parameters.filter((parameter) => parameter.kind === 'Lifetime')
  const ordinary = parameters.filter((parameter) => parameter.kind !== 'Lifetime')
  let lifetimeOrdinal = 0
  let ordinaryOrdinal = 0
  const arguments_: Array<Type.GenericArgument> = []
  for (const fact of facts) {
    const parameter =
      fact.type !== undefined && Lifetime.isLifetime(fact.type)
        ? lifetimes.at(lifetimeOrdinal++)
        : ordinary.at(ordinaryOrdinal++)
    const argument =
      parameter === undefined ? undefined : genericArgumentOfTypeArgument(parameter, fact)
    if (argument === undefined) return undefined
    arguments_.push(argument)
  }
  return TypeInference.prefixSubstitution(parameters, arguments_)
}

interface SelectedCallLifetimes {
  readonly substitution: Type.Substitution
  readonly inference?: TypeInference.LifetimeInference
  readonly compatibility?: TypeCompatibility.Context | undefined
}

/** Opens an inherent member's header lifetimes before contextual argument checking. */
export const instantiateSourceParameters = (
  declaration: SourceCallable,
  call: AuthoredHir.Expression,
  resolution: ResolutionContext,
): ReadonlyArray<SemanticType | undefined> => {
  const declared = DeclarationFacts.executableLifetimes(declaration)
  const selected = selectedCallLifetimes(
    call,
    declared.lifetimeBinders,
    resolution,
    new Map(),
    declared.invocationUse?.lifetime._tag === 'BoundLifetime'
      ? declared.invocationUse.lifetime
      : undefined,
  )
  return declaration.parameters.map((parameter) =>
    parameter.declaredType._tag === 'Resolved'
      ? Type.substitute(parameter.declaredType.type, selected.substitution)
      : undefined,
  )
}

/** Original data slots in a required invocation input remain open for caller input inference. */
const inputInferredCallLifetimes = (
  binders: ReadonlyArray<Lifetime.Bound>,
  parameters: ReadonlyArray<Type.Type>,
  invocation: Lifetime.Bound | undefined,
  generic: ReadonlyArray<Type.Parameter>,
): ReadonlySet<string> => {
  const selectable = new Set(
    generic.flatMap((parameter) => {
      const argument = Type.parameterArgument(parameter)
      return Lifetime.isLifetime(argument) ? [Lifetime.key(argument)] : []
    }),
  )
  const inputs = new Set<string>()
  for (const parameter of parameters)
    Type.visit(parameter, (type) => {
      if (
        !Type.isCallable(type) ||
        type.invocationUse === undefined ||
        Type.invocationUseState(type) !== 'Closed' ||
        !Type.invocationUseValid(type.invocationUse, type.parameters.length, type.lifetimeBinders, {
          state: Type.invocationUseState(type),
        })
      )
        return
      for (const input of type.parameters)
        for (const lifetime of Type.freeLifetimes(input)) inputs.add(Lifetime.key(lifetime))
    })
  return new Set(
    binders
      .filter(
        (binder) =>
          (invocation === undefined || !Lifetime.equals(binder, invocation)) &&
          inputs.has(Lifetime.key(binder)) &&
          selectable.has(Lifetime.key(binder)),
      )
      .map(Lifetime.key),
  )
}

/** Instantiates only the already selected contract's binders, at one declaration-local call site. */
const selectedCallLifetimes = (
  call: AuthoredHir.Expression,
  binders: ReadonlyArray<Lifetime.Bound>,
  resolution: ResolutionContext | undefined,
  initial: Type.Substitution = new Map(),
  invocation?: Lifetime.Bound,
  deferred: ReadonlySet<string> = new Set(),
): SelectedCallLifetimes => {
  const substitution = new Map(initial)
  const body = resolution?.bodyLifetimes
  if (body !== undefined) {
    for (const binder of binders) {
      if (substitution.has(Lifetime.key(binder)) || deferred.has(Lifetime.key(binder))) continue
      const region =
        invocation !== undefined && Lifetime.equals(binder, invocation)
          ? BodyLifetime.invocationRegion(body, call.anchor, binder)
          : BodyLifetime.region(body, call.anchor, 'Call', binder.ordinal)
      if (region !== undefined) substitution.set(Lifetime.key(binder), region)
    }
  }
  // A deferred original slot may depend on the just-opened use binder. Resolve its stored
  // expression under this exact opening before passing the original target its arguments.
  const opening = new Map([...substitution].filter(([identity]) => !initial.has(identity)))
  for (const [identity, argument] of initial)
    substitution.set(identity, Type.substituteGenericArgument(argument, opening))
  const compatibility = resolution?.lifetimeCompatibility
  return {
    substitution,
    compatibility,
    ...(compatibility === undefined
      ? {}
      : {
          inference: {
            compatibility,
            inferable: new Set([...deferred].filter((identity) => !initial.has(identity))),
            typeOutlives: (type, lifetime) =>
              TypeCompatibility.typeOutlives(compatibility, { type, lifetime }),
            accepts: (source: Lifetime.Lifetime, target: Lifetime.Lifetime, invariant: boolean) =>
              typesCompatible(Type.string(source), Type.string(target), compatibility) &&
              (!invariant ||
                typesCompatible(Type.string(target), Type.string(source), compatibility)),
          },
        }),
  }
}

/** Discharges written call preconditions, retaining local obligations for the body's solver. */
const selectedLifetimeBoundDiagnostics = (
  bounds: ReadonlyArray<Lifetime.Outlives>,
  substitution: Type.Substitution,
  compatibility: TypeCompatibility.Context | undefined,
  span: Location.Location,
  typeBounds: ReadonlyArray<Type.TypeOutlives> = [],
): ReadonlyArray<Diagnostic.Located> => [
  ...bounds.flatMap((bound) => {
    const longer = Type.substituteLifetime(bound.longer, substitution)
    const shorter = Type.substituteLifetime(bound.shorter, substitution)
    return typesCompatible(Type.string(longer), Type.string(shorter), compatibility)
      ? []
      : [
          Diagnostic.unsatisfiedLifetimeBound(
            Lifetime.display(longer),
            Lifetime.display(shorter),
            span,
          ),
        ]
  }),
  ...typeBounds.flatMap((bound) => {
    const type = Type.substitute(bound.type, substitution)
    const lifetime = Type.substituteLifetime(bound.lifetime, substitution)
    return TypeCompatibility.typeOutlives(compatibility ?? TypeCompatibility.context(), {
      type,
      lifetime,
    })
      ? []
      : [Diagnostic.unsatisfiedTypeOutlives(Type.display(type), Lifetime.display(lifetime), span)]
  }),
]

/** Captures the original accepted call edge, rather than treating its expected type as authority. */
const executableInputViews = (
  reference: CallReferenceFact,
  caller: DeclarationFact | undefined,
  call: AuthoredHir.Expression,
  arguments_: ReadonlyArray<ArgumentFact>,
  substitution: Type.Substitution,
  resolution: ResolutionContext | undefined,
): ReadonlyArray<Tir.ExecutableInputView> => {
  const body = resolution?.bodyLifetimes
  const builder = resolution?.builder
  const compatibility = resolution?.lifetimeCompatibility
  if (
    reference._tag !== 'Resolved' ||
    reference.declaration.canonical._tag !== 'Canonical' ||
    caller?.canonical._tag !== 'Canonical' ||
    body === undefined ||
    builder === undefined ||
    compatibility === undefined
  )
    return []
  const target = reference.declaration
  const targetId = reference.declaration.canonical.id
  const callerId = caller.canonical.id
  return arguments_.flatMap((argument, ordinal) => {
    const parameter = target.parameters.at(ordinal)
    if (
      parameter === undefined ||
      parameter.phase !== 'Runtime' ||
      parameter.declaredType._tag !== 'Resolved' ||
      argument.type._tag !== 'Available'
    )
      return []
    if (argument.expression._tag === 'Unavailable') return []
    const supplied = argument.expression.type
    const actual = Type.isRepresented(supplied) ? supplied.contract : supplied
    const required = Type.substitute(parameter.declaredType.type, substitution)
    const expected = Type.isRepresented(required) ? required.contract : required
    if (
      (!Type.isCallable(actual) || !Type.isCallable(expected)) &&
      (!Type.isEffect(actual) || !Type.isEffect(expected))
    )
      return []
    return [
      {
        caller: callerId,
        call: call.anchor,
        operand: Tir.nodeReference(builder.artifact, argument.expression),
        operandOrigin: argument.anchor,
        actual,
        ...(argument.invocationSource === undefined
          ? {}
          : { invocationSource: argument.invocationSource }),
        target: targetId,
        parameter: { ordinal, source: parameter.anchor, declared: parameter.declaredType.type },
        expected,
        substitution: new Map(substitution),
        premises: {
          owner: body.owner,
          bounds: compatibility.assumptions.bounds.map((bound) => ({ ...bound })),
          obligations: [...body.constraints.values()].map((bound) => ({ ...bound })),
          typeBounds: compatibility.typeBounds.map((bound) => ({ ...bound })),
          invocationInputs: compatibility.invocationInputs.map((input) => ({ ...input })),
          points: new Map(body.points),
          anchors: new Map(body.anchors),
          formations: [...body.formations.values()].map((formation) => ({
            ...formation,
            lifetimeBounds: formation.lifetimeBounds.map((bound) => ({ ...bound })),
            typeOutlives: formation.typeOutlives.map((bound) => ({ ...bound })),
          })),
        },
      },
    ]
  })
}

/** Retains the checked operand's exact executable representation for generic selection. */
const specializationActual = (
  context: SemanticContext.SemanticContext,
  pattern: SemanticType,
  actual: SemanticType,
  expression: Tir.Expression,
  builder?: BodyBuilder.BodyBuilder,
): SemanticType | undefined => {
  if (
    !Type.isRepresented(pattern) ||
    Type.isRepresented(actual) ||
    (!Type.isCallable(actual) && !Type.isEffect(actual))
  )
    return actual
  const representation = representationOfExpression(context, expression, builder)
  return representation === undefined
    ? undefined
    : Type.represented(actual, pattern.representation.requiredBound, representation)
}

/**
 * Specializes a call from an explicit prefix of its type arguments plus its value arguments. The
 * prefix seeds the substitution and the parameters past it are inferred exactly as they are when
 * nothing was written, so a call annotates only the parameters inference cannot reach.
 *
 * A prefix that names every parameter binds everything and leaves inference nothing to do, which
 * is the same substitution a complete explicit list has always produced.
 *
 * `deferred` names the parameters allowed to stay open because something other than these
 * arguments determines them, which is how a callable section keeps its captured parameter generic.
 */
export const seededSpecialization = (
  context: SemanticContext.SemanticContext,
  target: string,
  declared: ReadonlyArray<Type.Parameter>,
  explicit: ReadonlyArray<TypeArgumentFact>,
  sites: ReadonlyArray<SpecializationSite>,
  span: Location.Location,
  deferred: ReadonlySet<string> = new Set(),
  enclosingSubstitution: Type.Substitution = new Map(),
  lifetimes?: SelectedCallLifetimes,
  builder?: BodyBuilder.BodyBuilder,
): SeededSpecialization => {
  const written = new Map<string, TypeArgumentFact>()
  const selectedParameters = new Map<TypeArgumentFact, Type.Parameter>()
  const seeded = new Map<string, Type.GenericArgument>(lifetimes?.substitution)
  const conflicts: Array<SpecializationConflict> = []
  let lifetimeOrdinal = 0
  let ordinaryOrdinal = 0
  const lifetimeParameters = declared.filter((parameter) => parameter.kind === 'Lifetime')
  const ordinaryParameters = declared.filter((parameter) => parameter.kind !== 'Lifetime')
  for (const fact of explicit) {
    const parameter =
      fact.type !== undefined && Lifetime.isLifetime(fact.type)
        ? lifetimeParameters.at(lifetimeOrdinal++)
        : ordinaryParameters.at(ordinaryOrdinal++)
    const writtenType = fact.type
    if (writtenType === undefined) continue
    if (parameter === undefined) {
      const lifetime = Lifetime.isLifetime(writtenType)
      conflicts.push({
        diagnostic: Diagnostic.typeArgumentArity(
          target,
          lifetime ? lifetimeParameters.length : ordinaryParameters.length,
          explicit.filter(
            (candidate) =>
              candidate.type !== undefined && Lifetime.isLifetime(candidate.type) === lifetime,
          ).length,
          span,
        ),
      })
      continue
    }
    const rawArgument = genericArgumentOfTypeArgument(parameter, fact)
    const argument =
      rawArgument === undefined
        ? undefined
        : Type.substituteGenericArgument(rawArgument, enclosingSubstitution)
    if (argument === undefined) {
      let suppliedKind: Type.ParameterKind = 'Value'
      if (Lifetime.isLifetime(writtenType)) suppliedKind = 'Lifetime'
      else if (Type.isRequirementRowArgument(writtenType) || Type.isNominal(writtenType))
        suppliedKind = 'RequirementRow'
      conflicts.push({
        diagnostic: Diagnostic.genericParameterKindMismatch(
          parameter.name,
          parameter.kind,
          suppliedKind,
          Location.at(fact.anchor),
        ),
      })
      continue
    }
    seeded.set(Type.key(parameter), argument)
    written.set(Type.key(parameter), fact)
    selectedParameters.set(fact, parameter)
  }
  const inferred = new Map(seeded)
  let rowFailure: Type.InferenceFailure | undefined
  for (const site of sites) {
    const attempt = new Map(inferred)
    // Written and previously learned selections stay fixed while remaining holes learn
    // from this argument. Their concrete reference regions use ordinary compatibility.
    const pattern = Type.substitute(site.pattern, inferred)
    const actual = specializationActual(context, pattern, site.actual, site.expression, builder)
    if (
      actual !== undefined &&
      TypeInference.infer(pattern, actual, attempt, lifetimes?.inference)
    ) {
      commitSpecialization(inferred, attempt)
      continue
    }
    // Inference under the prefix failed. When the argument still satisfies what the prefix says
    // this parameter is, the written type simply wins — that is how a widened literal keeps
    // working under `take<u8>(1)`.
    const expected = Type.substitute(site.pattern, inferred)
    if (
      typesCompatible(site.actual, expected, lifetimes?.compatibility) ||
      contextualIntegerCompatible(site.expression, expected, builder)
    )
      continue
    rowFailure ??= TypeInference.inferenceFailure(
      site.pattern,
      site.actual,
      inferred,
      lifetimes?.inference,
    )
    const implied = new Map<string, Type.GenericArgument>()
    // Only what this argument alone implies can contradict the prefix; an argument that does not
    // unify at all is an ordinary argument mismatch and belongs to the argument pass.
    if (!TypeInference.infer(site.pattern, site.actual, implied)) continue
    for (const [identity, fact] of written) {
      const suppliedArgument = implied.get(identity)
      const explicitArgument = seeded.get(identity)
      if (suppliedArgument === undefined || explicitArgument === undefined) continue
      if (Type.genericArgumentKey(suppliedArgument) === Type.genericArgumentKey(explicitArgument))
        continue
      conflicts.push({
        ordinal: site.ordinal,
        diagnostic: Diagnostic.typeArgumentConflict(
          target,
          selectedParameters.get(fact)?.name ?? fact.ordinal.toString(),
          Type.encodeGenericArgument(explicitArgument),
          Type.encodeGenericArgument(suppliedArgument),
          Location.at(fact.anchor),
        ),
      })
    }
  }
  const open = declared.find(
    (parameter) => !inferred.has(Type.key(parameter)) && !deferred.has(Type.key(parameter)),
  )
  const typeArguments = declared.flatMap((parameter) => {
    const argument = inferred.get(Type.key(parameter))
    return argument === undefined ? [] : [argument]
  })
  return {
    substitution: inferred,
    typeArguments,
    conflicts: conflicts,
    ...(open === undefined || conflicts.length > 0
      ? {}
      : {
          unresolved:
            rowFailure === undefined
              ? Diagnostic.uninferredTypeParameter(target, open.name, span)
              : Diagnostic.inferenceFailure(rowFailure, span),
        }),
  }
}

export const commitSpecialization = (
  target: Map<string, Type.GenericArgument>,
  source: ReadonlyMap<string, Type.GenericArgument>,
): void => {
  target.clear()
  for (const [identity, argument] of source) target.set(identity, argument)
}

interface KnownProviderBoundInference {
  readonly substitution: Type.Substitution
  readonly symbolicConformances: ReadonlyArray<ConformanceProof.SymbolicConformanceSelection>
  readonly diagnostic?: Diagnostic.Located
}

const sameNominalDeclaration = (left: Type.Nominal, right: Type.Nominal): boolean =>
  left.module === right.module && left.name === right.name && left.sealed === right.sealed

const openParameterKeys = (type: Type.Type): ReadonlyArray<string> => [
  ...Type.parameters(type).map(Type.key),
  ...Type.freeLifetimes(type)
    .filter((lifetime) => lifetime._tag === 'BoundLifetime')
    .map(Lifetime.key),
]

// The provider fixes only its own binders. A source conformance may also bind parameters through
// its capability head; instantiate those from already-known bound arguments before using the
// candidate to infer the call's remaining arguments. Never leak a conformance-owned binder into
// the caller or use the expected result to choose a provider.
const instantiateKnownProviderContract = (
  candidate: Type.Nominal,
  pattern: Type.Nominal,
  provider: Type.Type,
  callBinders: ReadonlySet<string>,
): Type.Nominal | undefined => {
  const providerParameters = new Set(openParameterKeys(provider))
  const binders = new Set(
    openParameterKeys(candidate).filter((key) => !providerParameters.has(key)),
  )
  if (binders.size === 0) return candidate
  const inferred = new Map<string, Type.GenericArgument>()
  for (const [ordinal, argument] of pattern.arguments.entries()) {
    const supplied = candidate.arguments.at(ordinal)
    if (supplied === undefined) return undefined
    const wanted = Type.nominal(pattern.module, pattern.name, [argument])
    if (openParameterKeys(wanted).some((key) => callBinders.has(key))) continue
    if (
      !TypeInference.inferOpenGenericArguments(
        Type.nominal(candidate.module, candidate.name, [supplied]),
        wanted,
        inferred,
        binders,
      ).matches
    )
      return undefined
  }
  const instantiated = Type.substitute(candidate, inferred)
  return Type.isNominal(instantiated) &&
    !openParameterKeys(instantiated).some((key) => binders.has(key))
    ? instantiated
    : undefined
}

/**
 * Fills call binders from direct interface bounds after operands have fixed their provider.
 *
 * A provider may contain parameters owned by the enclosing declaration, but none owned by the call
 * being specialized. Candidate discovery stays keyed to that provider and the bound's canonical
 * interface identity, so this cannot become backwards provider inference.
 */
const inferKnownProviderBounds = (
  context: SemanticContext.SemanticContext,
  target: string,
  parameters: ReadonlyArray<DeclarationFacts.TypeParameterFact>,
  initial: Type.Substitution,
  resolution: ResolutionContext,
  caller: DeclarationFact | undefined,
  span: Location.Location,
): KnownProviderBoundInference => {
  const substitution = new Map(initial)
  const symbolicConformances: Array<ConformanceProof.SymbolicConformanceSelection> = []
  const callBinders = new Set(parameters.map((parameter) => Type.key(parameter.type)))
  let progressed = true
  while (progressed) {
    progressed = false
    for (const parameter of parameters) {
      const providerArgument = substitution.get(Type.key(parameter.type))
      if (providerArgument === undefined || !Type.isTypeArgument(providerArgument)) continue
      const provider = providerArgument
      if (
        !Type.isNominal(provider) ||
        Type.parameters(provider).some((nested) => callBinders.has(Type.key(nested)))
      )
        continue
      for (const bound of parameter.bounds) {
        if (bound._tag !== 'ResolvedBound' || !bound.application.providerMatches) continue
        const pattern = Type.substitute(bound.application.capability, substitution)
        if (!Type.isNominal(pattern)) continue
        const conditional = ConformanceProof.conditionalContractCandidates(
          resolution.index,
          resolution.scope.module,
          provider,
        ).filter((candidate) => sameNominalDeclaration(candidate.capability, pattern))
        const candidates = ConformanceProof.knownProviderContracts(
          resolution.index,
          resolution.scope.module,
          provider,
          caller,
        ).flatMap((candidate) => {
          if (!sameNominalDeclaration(candidate, pattern)) return []
          const instantiated = instantiateKnownProviderContract(
            candidate,
            pattern,
            provider,
            callBinders,
          )
          return instantiated === undefined ? [] : [instantiated]
        })
        const matching = candidates.flatMap((candidate) => {
          const trial = new Map(substitution)
          return TypeInference.inferOpenGenericArguments(pattern, candidate, trial, callBinders)
            .matches
            ? [{ candidate, trial }]
            : []
        })
        const selected = matching.length === 1 ? matching.at(0) : undefined
        if (selected !== undefined) {
          const before = substitution.size
          commitSpecialization(substitution, selected.trial)
          if (substitution.size > before) progressed = true
          const symbolic = conditional.filter(
            (candidate) =>
              Type.equals(candidate.capability, selected.candidate) &&
              caller !== undefined &&
              ConformanceProof.assumedConditionalConformance(
                resolution.index,
                provider,
                candidate.capability,
                caller,
              ),
          )
          const selectedSymbolic = symbolic.length === 1 ? symbolic.at(0) : undefined
          if (
            selectedSymbolic !== undefined &&
            !symbolicConformances.some(
              (retained) =>
                retained.selection.module === selectedSymbolic.selection.module &&
                retained.selection.ordinal === selectedSymbolic.selection.ordinal,
            )
          )
            symbolicConformances.push(selectedSymbolic)
          continue
        }
        const conditionalMatches = conditional.flatMap((candidate) => {
          const trial = new Map(substitution)
          return TypeInference.inferOpenGenericArguments(
            pattern,
            candidate.capability,
            trial,
            callBinders,
          ).matches
            ? [{ candidate, trial }]
            : []
        })
        const rejected = conditionalMatches.length === 1 ? conditionalMatches.at(0) : undefined
        const missing =
          caller === undefined
            ? undefined
            : rejected?.candidate.requirements.find(
                (requirement) =>
                  !boundAssumedBy(caller, requirement.provider, requirement.capability),
              )
        if (caller !== undefined && rejected !== undefined && missing !== undefined) {
          const mismatched = Type.isParameter(missing.provider)
            ? caller.typeParameters
                .find((parameter) => Type.equals(parameter.type, missing.provider))
                ?.bounds.flatMap((candidate) =>
                  candidate._tag === 'ResolvedBound' &&
                  sameNominalDeclaration(candidate.application.capability, missing.capability) &&
                  !Type.equals(candidate.application.capability, missing.capability)
                    ? [candidate.application.capability]
                    : [],
                )
                .at(0)
            : undefined
          const outer = `${Type.encode(rejected.candidate.capability)} for ${Type.encode(provider)}`
          const required = `${Type.encode(missing.capability)} for ${Type.encode(missing.provider)}`
          const detail =
            mismatched === undefined
              ? 'the exact enclosing bound is not declared'
              : `declared ${Type.encode(mismatched)} does not exactly match required ${Type.encode(missing.capability)}`
          return {
            substitution,
            symbolicConformances: symbolicConformances,
            diagnostic: Diagnostic.unprovenConformance(
              outer,
              detail,
              [`required by ${outer}`, `  ${required}: ${detail}`],
              span,
            ),
          }
        }
        if (candidates.length !== 1 || matching.length !== 0) continue
        const candidate = candidates.at(0)
        if (candidate === undefined) continue
        const implied = new Map<string, Type.GenericArgument>()
        if (
          !TypeInference.inferOpenGenericArguments(
            bound.application.capability,
            candidate,
            implied,
            callBinders,
          ).matches
        )
          continue
        const conflict = parameters.find((candidateParameter) => {
          const identity = Type.key(candidateParameter.type)
          const existing = substitution.get(identity)
          const inferred = implied.get(identity)
          return (
            existing !== undefined &&
            inferred !== undefined &&
            Type.genericArgumentKey(existing) !== Type.genericArgumentKey(inferred)
          )
        })
        if (conflict === undefined) continue
        const identity = Type.key(conflict.type)
        const existing = substitution.get(identity)
        const inferred = implied.get(identity)
        if (existing === undefined || inferred === undefined) continue
        return {
          substitution,
          symbolicConformances: symbolicConformances,
          diagnostic: Diagnostic.typeArgumentConflict(
            target,
            conflict.type.name,
            Type.encodeGenericArgument(existing),
            Type.encodeGenericArgument(inferred),
            span,
            Location.at(bound.path.anchor),
          ),
        }
      }
    }
  }
  return {
    substitution,
    symbolicConformances: symbolicConformances,
  }
}

export const contractSpecializationSites = (
  arguments_: ReadonlyArray<ArgumentFact>,
  contract: CallableContract.CallableContract,
  enclosingSubstitution: Type.Substitution = new Map(),
): ReadonlyArray<SpecializationSite> =>
  arguments_.flatMap((argument, ordinal): ReadonlyArray<SpecializationSite> => {
    const parameter = contract.parameters.at(ordinal)
    return argument.type._tag === 'Available' && parameter !== undefined
      ? [
          {
            ordinal,
            pattern: parameter.type,
            actual: Type.substitute(argument.type.type, enclosingSubstitution),
            expression: argument.expression,
          },
        ]
      : []
  })

export interface ConstraintSolveResult {
  readonly substitution: Type.Substitution
  readonly evidence: ReadonlyArray<Constraint.ConstraintEvidence>
  readonly inferredProviderSelectors: ReadonlyArray<InferredProviderSelector>
  readonly diagnostics: ReadonlyArray<Diagnostic.Located>
}

export const constraintOrigins = (
  context: SemanticContext.SemanticContext,
  callable: SourceCallable | undefined,
): ReadonlyArray<Location.Location> =>
  callable?.constraints.map((constraint) => Location.at(constraint.anchor)) ?? []

/** Solves provider relations only after arguments have independently established their operands. */
export const solveCallableConstraints = (
  constraints: ReadonlyArray<Constraint.Constraint>,
  origins: ReadonlyArray<Location.Location>,
  initial: Type.Substitution,
  caller: DeclarationFact | undefined,
  resolution: ResolutionContext,
  span: Location.Location,
): ConstraintSolveResult => {
  const substitution = new Map(initial)
  const evidence: Array<Constraint.ConstraintEvidence> = []
  const inferredProviderSelectors: Array<InferredProviderSelector> = []
  const diagnostics: Array<Diagnostic.Located> = []
  const givens = caller?.constraintContracts ?? []
  const checked = constraints.flatMap((constraint, ordinal) =>
    constraint._tag === 'ProviderSelectionConstraint' ? [] : [{ constraint, ordinal }],
  )
  const providers = constraints.flatMap((constraint, ordinal) =>
    constraint._tag === 'ProviderSelectionConstraint' ? [{ constraint, ordinal }] : [],
  )
  const grouped = new Map<string, ReadonlyArray<(typeof providers)[number]>>()
  for (const provider of providers) {
    const selected = provider.constraint.selected.expression
    const groupKey =
      selected._tag === 'RowParameter'
        ? Type.key(selected.parameter)
        : Constraint.key(provider.constraint)
    grouped.set(groupKey, [...(grouped.get(groupKey) ?? []), provider])
  }
  for (const [selectedKey, group] of grouped) {
    const wanted = group.map(({ constraint }) => Constraint.substitute(constraint, substitution))
    const assumed = wanted.every((constraint) =>
      givens.some((given) => Constraint.key(given) === Constraint.key(constraint)),
    )
    if (assumed) {
      for (const constraint of wanted) evidence.push(Constraint.assumed(constraint, substitution))
      continue
    }
    const selectedArgument = substitution.get(selectedKey)
    const firstWanted = wanted.at(0)
    const explicitSelection =
      firstWanted?._tag === 'ProviderSelectionConstraint' &&
      RowAlgebra.concretize(Type.requirementRowPolicy(), firstWanted.selected)._tag === 'Concrete'
        ? firstWanted.selected
        : undefined
    const selected =
      selectedArgument !== undefined && Type.isRequirementRowArgument(selectedArgument)
        ? selectedArgument.row
        : explicitSelection
    const relations = wanted.flatMap((constraint, ordinal) =>
      constraint._tag === 'ProviderSelectionConstraint'
        ? [
            {
              wanted: constraint,
              origins: [origins.at(group.at(ordinal)?.ordinal ?? 0) ?? span],
            } as ProviderSelection.Relation<Location.Location>,
          ]
        : [],
    )
    const solved = ProviderSelection.solve({
      relations,
      ...(selected === undefined ? {} : { selected }),
      responsible: span,
      originKey: Location.key,
      oracle: {
        observation: {
          work: ResolutionWork.ofIndex(resolution.index),
          initiator: { kind: 'CallConstraint', key: `${selectedKey}@${Location.key(span)}` },
        },
        match: (provider: Type.Type, capability: Type.Nominal) =>
          ConformanceProof.providerMatch(resolution.index, provider, capability, caller),
      } as ProviderSelection.ConformanceOracle,
    })
    if (solved._tag === 'Rejected') {
      diagnostics.push(
        ...solved.diagnostics.map((rejected) =>
          Diagnostic.providerSelection(rejected, Location.key),
        ),
      )
      continue
    }
    if (selectedArgument === undefined) {
      const parameter = group.at(0)?.constraint.selected.expression
      if (parameter?._tag === 'RowParameter') {
        inferredProviderSelectors.push({ parameter: parameter.parameter, selected: solved.member })
        substitution.set(
          Type.key(parameter.parameter),
          Type.requirementRowArgument([solved.member]),
        )
      }
    }
    for (const selectedEvidence of solved.evidence) {
      const solvedWanted = wanted.find(
        (candidate) => Constraint.key(candidate) === selectedEvidence.wantedKey,
      )
      const specialized =
        solvedWanted === undefined ? undefined : Constraint.substitute(solvedWanted, substitution)
      if (specialized?._tag === 'ProviderSelectionConstraint')
        evidence.push(
          Constraint.requirementSelectionEvidence(
            specialized,
            solved.member,
            selectedEvidence.providerMatch,
          ),
        )
    }
  }
  // Checked constraints run after provider selection so rows bound by inferred
  // provider selectors are visible to structural proofs.
  for (const entry of checked) {
    const wanted = Constraint.substitute(entry.constraint, substitution)
    if (Constraint.isImplied(wanted, givens)) {
      evidence.push(Constraint.assumed(wanted, substitution))
      continue
    }
    if (wanted._tag === 'ProviderSelectionConstraint')
      throw new RangeError('substitution changed a checked constraint into a provider selection')
    const proof = Constraint.proveStructural(wanted)
    if (proof !== undefined) {
      evidence.push(proof)
      continue
    }
    diagnostics.push(
      wanted._tag === 'RequirementSubsetConstraint'
        ? Diagnostic.invalidEffectProvision(
            'selected requirement row is not an exact subset of the source row',
            span,
          )
        : Diagnostic.invalidEffectHandler(
            wanted._tag === 'NominalMemberConstraint'
              ? 'selected failure is absent or remains underconstrained'
              : 'selected failure type is not an exact subset of the source failure type',
            span,
          ),
    )
  }
  return {
    substitution,
    evidence: evidence,
    inferredProviderSelectors: inferredProviderSelectors,
    diagnostics: diagnostics,
  }
}

export const analyzeCallContract = (
  context: SemanticContext.SemanticContext,
  call: AuthoredHir.Expression,
  reference: CallReferenceFact,
  argumentsList: ReadonlyArray<ArgumentFact>,
  syntaxAvailable = hasAvailableCallSyntax(call),
  callTypeArguments?: CallTypeArgumentsResult,
  resolution?: ResolutionContext,
  caller?: DeclarationFact,
): CallContractResult => {
  if (!syntaxAvailable) {
    return {
      mappings: [],
      fact: {
        _tag: 'Unavailable',
        reason: { _tag: 'UnavailableCallSyntax', anchor: call.anchor },
      },
      diagnostics: [],
    }
  }
  // A static interface operation's contract is a fixed parameter and result list over its provider,
  // exactly like a compiler-known operation's, so both are checked the same way.
  if (reference._tag === 'ResolvedBuiltin' || reference._tag === 'ResolvedInterfaceOperation') {
    const unavailableArgument = argumentsList.find((argument) => argument.type._tag !== 'Available')
    if (unavailableArgument !== undefined) {
      return {
        mappings: [],
        fact: {
          _tag: 'Unavailable',
          reason: {
            _tag: 'UnavailableBuiltinArgument',
            argument: unavailableArgument,
          },
        },
        diagnostics: [],
      }
    }
    for (const [ordinal, argument] of argumentsList.entries()) {
      const expected = reference.parameters.at(ordinal)
      if (
        expected !== undefined &&
        argument.type._tag === 'Available' &&
        !typesCompatible(argument.type.type, expected, resolution?.lifetimeCompatibility)
      ) {
        let mismatch: Diagnostic.Located
        if (Type.isForeignFunction(expected) && !Type.isForeignFunction(argument.type.type))
          mismatch = Diagnostic.invalidForeignCallback(
            Type.encode(argument.type.type),
            'capturing and anonymous Silk callables do not have an exported C address',
            Location.at(argument.anchor),
          )
        else if (Type.isCallable(expected) && Type.isCallable(argument.type.type))
          mismatch = Diagnostic.incompatibleCallableSignature(
            Type.encode(expected),
            Type.encode(argument.type.type),
            Location.at(argument.anchor),
          )
        else
          mismatch =
            unionConversionDiagnostic(
              argument.type.type,
              expected,
              Location.at(argument.anchor),
              resolution?.lifetimeCompatibility,
            ) ??
            Diagnostic.argumentTypeMismatch(
              Type.encode(expected),
              Type.encode(argument.type.type),
              Location.at(argument.anchor),
            )
        return {
          mappings: [],
          fact: {
            _tag: 'Unavailable',
            reason: { _tag: 'ArgumentTypeMismatch', argument, expected },
            cause: Diagnostic.identity(mismatch),
          },
          diagnostics: [mismatch],
        }
      }
    }
    const expectedCount = reference.parameters.length
    const actualCount = argumentsList.length
    if (expectedCount !== actualCount) {
      return {
        mappings: [],
        fact: { _tag: 'ArityMismatch', expectedCount, actualCount },
        diagnostics: [
          callArityDiagnostic(reference, expectedCount, actualCount, Location.at(call.anchor)),
        ],
      }
    }
    // The applied operation states its retained-storage obligations over this call's capability
    // arguments and selected invocation lifetimes, so they are discharged like a function's.
    const obligations =
      reference._tag === 'ResolvedInterfaceOperation'
        ? selectedLifetimeBoundDiagnostics(
            reference.interfaceContract.lifetimes.lifetimeBounds ?? [],
            new Map(),
            resolution?.lifetimeCompatibility,
            Location.at(call.anchor),
            reference.interfaceContract.lifetimes.typeOutlives ?? [],
          )
        : []
    const obligationFailure = obligations.at(0)
    if (obligationFailure !== undefined)
      return {
        mappings: [],
        fact: {
          _tag: 'Unavailable',
          reason: { _tag: 'UnavailableCallSyntax', anchor: call.anchor },
          cause: Diagnostic.identity(obligationFailure),
        },
        diagnostics: obligations,
      }
    return {
      mappings: [],
      fact: {
        _tag: 'Compatible',
        expectedCount,
        actualCount,
        typeArguments: [],
        substitution: new Map(),
        evidence: [],
        inferredProviderSelectors: [],
      },
      diagnostics: [],
    }
  }

  if (
    reference._tag !== 'Resolved' &&
    reference._tag !== 'ResolvedServiceOperation' &&
    reference._tag !== 'ResolvedIntrinsicContract'
  ) {
    const cause =
      reference._tag === 'Missing' || reference._tag === 'Ambiguous' ? reference.cause : undefined
    return {
      mappings: [],
      fact: {
        _tag: 'Unavailable',
        reason: { _tag: 'UnavailableCallTarget', reference },
        ...(cause === undefined ? {} : { cause }),
      },
      diagnostics: [],
    }
  }

  const callable = sourceCallable(reference)
  const contract = resolvedCallableContract(reference)
  if (contract === undefined) throw new RangeError('resolved call lost its callable contract')
  const parameters = callable?.parameters ?? []
  const mappings = argumentsList.flatMap(
    (argument, ordinal): ReadonlyArray<ArgumentMappingFact> => {
      const parameter = parameters.at(ordinal)
      return parameter === undefined ? [] : [{ _tag: 'ArgumentMapping', argument, parameter }]
    },
  )
  const unavailableArgument = argumentsList.find((argument) => argument.type._tag !== 'Available')
  const unavailableMapping = mappings.find(
    (mapping) => mapping.parameter.declaredType._tag !== 'Resolved',
  )
  if (unavailableArgument !== undefined) {
    return {
      mappings,
      fact: {
        _tag: 'Unavailable',
        reason: {
          _tag: 'UnavailableBuiltinArgument' as const,
          argument: unavailableArgument,
        },
      },
      diagnostics: [],
    }
  }
  if (unavailableMapping !== undefined)
    return {
      mappings,
      fact: {
        _tag: 'Unavailable',
        reason: {
          _tag: 'UnavailableMappedType' as const,
          mapping: unavailableMapping,
        },
      },
      diagnostics: [],
    }
  const sites = contractSpecializationSites(
    argumentsList,
    contract,
    resolution?.staticContext?.typeSubstitution,
  )
  const implicitDecay = sites.find(
    (site) => Type.isFixedArray(site.actual) && Type.isSlice(site.pattern),
  )
  if (implicitDecay !== undefined && Type.isSlice(implicitDecay.pattern)) {
    const expected = implicitDecay.pattern
    const argument = argumentsList.at(implicitDecay.ordinal)
    if (argument === undefined) throw new RangeError('specialization site lost its argument')
    const diagnostic = Diagnostic.implicitSliceDecay(
      Type.encode(expected),
      Location.at(argument.anchor),
    )
    return {
      mappings,
      fact: {
        _tag: 'Unavailable',
        reason: {
          _tag: 'ArgumentTypeMismatch',
          argument,
          expected,
        },
        cause: Diagnostic.identity(diagnostic),
      },
      diagnostics: [diagnostic],
    }
  }
  const callLifetimes = selectedCallLifetimes(
    call,
    contract.lifetimeBinders,
    resolution,
    new Map(),
    contract.invocationUse?.lifetime._tag === 'BoundLifetime'
      ? contract.invocationUse.lifetime
      : undefined,
    inputInferredCallLifetimes(
      contract.lifetimeBinders,
      contract.parameters.map((parameter) => parameter.type),
      contract.invocationUse?.lifetime._tag === 'BoundLifetime'
        ? contract.invocationUse.lifetime
        : undefined,
      contract.binders,
    ),
  )
  const declaredTypeParameters = contract.binders
  const constraintDeferred = new Set(
    contract.constraints.flatMap((constraint) =>
      constraint._tag === 'ProviderSelectionConstraint' &&
      constraint.selected.expression._tag === 'RowParameter'
        ? [Type.key(constraint.selected.expression.parameter)]
        : [],
    ),
  )
  let substitution: Type.Substitution
  let typeArguments: ReadonlyArray<Type.GenericArgument>
  let unresolvedSpecialization: Diagnostic.Located | undefined
  if (callTypeArguments?.explicit === true) {
    // More type arguments than the callable declares is the arity error that remains: fewer is a
    // prefix, and the parameters it leaves open are inferred from the value arguments below.
    if (callTypeArguments.facts.length > declaredTypeParameters.length) {
      const diagnostic = Diagnostic.typeArgumentArity(
        reference.spelling,
        declaredTypeParameters.length,
        callTypeArguments.facts.length,
        Location.at(call.anchor),
      )
      return {
        mappings,
        fact: {
          _tag: 'Unavailable',
          reason: { _tag: 'UnavailableCallSyntax', anchor: call.anchor },
          cause: Diagnostic.identity(diagnostic),
        },
        diagnostics: [diagnostic],
      }
    }
    if (callTypeArguments.types === undefined) {
      const unavailable = callTypeArguments.facts.find((fact) => fact.type === undefined)
      const cause =
        unavailable !== undefined && 'cause' in unavailable.declared
          ? unavailable.declared.cause
          : undefined
      return {
        mappings,
        fact: {
          _tag: 'Unavailable',
          reason: { _tag: 'UnavailableCallSyntax', anchor: call.anchor },
          ...(cause === undefined ? {} : { cause }),
        },
        diagnostics: [],
      }
    }
    const seeded = seededSpecialization(
      context,
      reference.spelling,
      declaredTypeParameters,
      callTypeArguments.facts,
      sites,
      Location.at(call.anchor),
      constraintDeferred,
      resolution?.staticContext?.typeSubstitution,
      callLifetimes,
      resolution?.builder,
    )
    const conflict = seeded.conflicts.at(0)
    if (conflict !== undefined) {
      return {
        mappings,
        fact: {
          _tag: 'Unavailable',
          reason: { _tag: 'UnavailableCallSyntax', anchor: call.anchor },
          cause: Diagnostic.identity(conflict.diagnostic),
        },
        diagnostics: [conflict.diagnostic],
      }
    }
    typeArguments = seeded.typeArguments
    substitution = seeded.substitution
    unresolvedSpecialization = seeded.unresolved
  } else if (declaredTypeParameters.length === 0) {
    typeArguments = []
    substitution = callLifetimes.substitution
  } else {
    const inferred = new Map<string, Type.GenericArgument>(callLifetimes.substitution)
    let compatible = true
    let rowFailure: Type.InferenceFailure | undefined
    let representationFailure: Diagnostic.Located | undefined
    let pending = [...sites]
    while (pending.length > 0) {
      const deferred: Array<SpecializationSite> = []
      let progressed = false
      for (const site of pending) {
        const pattern = site.pattern
        const supplied = site.actual
        const argument = argumentsList.at(site.ordinal)
        if (argument === undefined) {
          compatible = false
          break
        }
        const representedSupplied = specializationActual(
          context,
          pattern,
          supplied,
          argument.expression,
          resolution?.builder,
        )
        if (representedSupplied === undefined) {
          compatible = false
          const representationParameter =
            Type.isRepresented(pattern) &&
            Type.isRepresentationParameterArgument(pattern.representation.argument)
              ? pattern.representation.argument.parameter
              : undefined
          if (representationParameter?.staticProperties.includes('Intrinsic.NonParking') === true)
            representationFailure = Diagnostic.unsatisfiedExecutableProperty(
              'Intrinsic.NonParking',
              ['Unavailable:exact execution target'],
              Location.at(call.anchor),
            )
          else
            rowFailure = TypeInference.inferenceFailure(
              pattern,
              supplied,
              inferred,
              callLifetimes.inference,
            )
          break
        }
        const attempt = new Map(inferred)
        if (TypeInference.infer(pattern, representedSupplied, attempt, callLifetimes.inference)) {
          commitSpecialization(inferred, attempt)
          progressed = true
        } else {
          deferred.push(site)
        }
      }
      if (!compatible) break
      if (deferred.length === 0) break
      if (!progressed) {
        const failed = deferred.at(0)
        rowFailure =
          failed === undefined
            ? undefined
            : TypeInference.inferenceFailure(
                failed.pattern,
                failed.actual,
                inferred,
                callLifetimes.inference,
              )
        compatible = false
        break
      }
      pending = deferred
    }
    typeArguments = declaredTypeParameters.flatMap((parameter) => {
      const inferredType = inferred.get(Type.key(parameter))
      return inferredType === undefined ? [] : [inferredType]
    })
    if (!compatible) {
      const diagnostic =
        representationFailure ??
        (rowFailure === undefined
          ? Diagnostic.typeArgumentInference(reference.spelling, Location.at(call.anchor))
          : Diagnostic.inferenceFailure(rowFailure, Location.at(call.anchor)))
      return {
        mappings,
        fact: {
          _tag: 'Unavailable',
          reason: { _tag: 'UnavailableCallSyntax', anchor: call.anchor },
          cause: Diagnostic.identity(diagnostic),
        },
        diagnostics: [diagnostic],
      }
    }
    substitution = inferred
  }
  const mayInferFromKnownProvider =
    reference._tag === 'Resolved' &&
    reference.declaration.typeParameters.some((parameter) =>
      parameter.bounds.some(
        (bound) =>
          bound._tag === 'ResolvedBound' &&
          bound.application.providerMatches &&
          Type.parameters(bound.application.capability).some((nested) =>
            reference.declaration.typeParameters.some(
              (candidate) => Type.key(candidate.type) === Type.key(nested),
            ),
          ),
      ),
    )
  let symbolicConformances: ReadonlyArray<ConformanceProof.SymbolicConformanceSelection> = []
  if (reference._tag === 'Resolved' && resolution !== undefined && mayInferFromKnownProvider) {
    const inferredFromBounds = inferKnownProviderBounds(
      context,
      reference.spelling,
      reference.declaration.typeParameters,
      substitution,
      resolution,
      caller,
      Location.at(call.anchor),
    )
    substitution = inferredFromBounds.substitution
    symbolicConformances = inferredFromBounds.symbolicConformances
    const diagnostic = inferredFromBounds.diagnostic
    if (diagnostic !== undefined)
      return {
        mappings,
        fact: {
          _tag: 'Unavailable',
          reason: { _tag: 'UnavailableCallSyntax', anchor: call.anchor },
          cause: Diagnostic.identity(diagnostic),
        },
        diagnostics: [diagnostic],
      }
    typeArguments = declaredTypeParameters.flatMap((parameter) => {
      const argument = substitution.get(Type.key(parameter))
      return argument === undefined ? [] : [argument]
    })
    if (
      declaredTypeParameters.every(
        (parameter) => substitution.get(Type.key(parameter)) !== undefined,
      )
    )
      unresolvedSpecialization = undefined
  }
  if (callTypeArguments?.explicit !== true && !mayInferFromKnownProvider) {
    const missingAfterKnownProviderInference = declaredTypeParameters.find(
      (parameter) =>
        !substitution.has(Type.key(parameter)) && !constraintDeferred.has(Type.key(parameter)),
    )
    if (missingAfterKnownProviderInference !== undefined) {
      const diagnostic = Diagnostic.typeArgumentInference(
        reference.spelling,
        Location.at(call.anchor),
      )
      return {
        mappings,
        fact: {
          _tag: 'Unavailable',
          reason: { _tag: 'UnavailableCallSyntax', anchor: call.anchor },
          cause: Diagnostic.identity(diagnostic),
        },
        diagnostics: [diagnostic],
      }
    }
  }
  let evidence: ReadonlyArray<Constraint.ConstraintEvidence> = []
  let inferredProviderSelectors: ReadonlyArray<InferredProviderSelector> = []
  if (resolution !== undefined && contract.constraints.length > 0) {
    const solved = solveCallableConstraints(
      contract.constraints,
      constraintOrigins(context, callable),
      substitution,
      caller,
      resolution,
      Location.at(call.anchor),
    )
    substitution = solved.substitution
    evidence = solved.evidence
    inferredProviderSelectors = solved.inferredProviderSelectors
    const firstConstraintDiagnostic = solved.diagnostics.at(0)
    if (firstConstraintDiagnostic !== undefined)
      return {
        mappings,
        fact: {
          _tag: 'Unavailable',
          reason: { _tag: 'UnavailableCallSyntax', anchor: call.anchor },
          cause: Diagnostic.identity(firstConstraintDiagnostic),
        },
        diagnostics: solved.diagnostics,
      }
    typeArguments = declaredTypeParameters.flatMap((parameter) => {
      const argument = substitution.get(Type.key(parameter))
      return argument === undefined ? [] : [argument]
    })
  }
  const remainingOpen = declaredTypeParameters.find(
    (parameter) => substitution.get(Type.key(parameter)) === undefined,
  )
  if (remainingOpen !== undefined)
    unresolvedSpecialization ??= Diagnostic.uninferredTypeParameter(
      reference.spelling,
      remainingOpen.name,
      Location.at(call.anchor),
    )
  for (const site of sites) {
    const argument = argumentsList.at(site.ordinal)
    if (argument === undefined) continue
    const expected = Type.substitute(site.pattern, substitution)
    const expectedValue = Type.isRepresented(expected) ? expected.contract : expected
    const suppliedValue = Type.isRepresented(site.actual) ? site.actual.contract : site.actual
    if (
      !typesCompatible(suppliedValue, expectedValue, resolution?.lifetimeCompatibility) &&
      !contextualIntegerCompatible(argument.expression, expectedValue, resolution?.builder)
    ) {
      let mismatch: Diagnostic.Located
      if (Type.isForeignFunction(expectedValue) && !Type.isForeignFunction(suppliedValue)) {
        mismatch = Diagnostic.invalidForeignCallback(
          Type.encode(suppliedValue),
          'capturing and anonymous Silk callables do not have an exported C address',
          Location.at(argument.anchor),
        )
      } else if (Type.isCallable(expectedValue) && Type.isCallable(suppliedValue)) {
        mismatch = Diagnostic.incompatibleCallableSignature(
          Type.encode(expectedValue),
          Type.encode(suppliedValue),
          Location.at(argument.anchor),
        )
      } else if (Type.isSlice(expectedValue) && Type.isFixedArray(suppliedValue)) {
        mismatch = Diagnostic.implicitSliceDecay(
          Type.encode(expectedValue),
          Location.at(argument.anchor),
        )
      } else {
        mismatch =
          unionConversionDiagnostic(
            suppliedValue,
            expectedValue,
            Location.at(argument.anchor),
            resolution?.lifetimeCompatibility,
          ) ??
          Diagnostic.argumentTypeMismatch(
            Type.encode(expectedValue),
            Type.encode(suppliedValue),
            Location.at(argument.anchor),
          )
      }
      return {
        mappings,
        fact: {
          _tag: 'Unavailable',
          reason: {
            _tag: 'ArgumentTypeMismatch',
            argument,
            expected,
          },
          cause: Diagnostic.identity(mismatch),
        },
        diagnostics: [mismatch],
      }
    }
  }

  const expectedCount = contract.parameters.length
  const actualCount = argumentsList.length
  const variadic = reference._tag === 'Resolved' && reference.declaration.foreign?.variadic === true
  if (variadic) {
    const invalid = argumentsList
      .slice(expectedCount)
      .find(
        (argument) =>
          argument.type._tag === 'Available' && !CAbi.admitsVariadic(argument.type.type),
      )
    if (invalid !== undefined && invalid.type._tag === 'Available') {
      const diagnostic = Diagnostic.foreignTypeNotAdmitted(
        Type.encode(invalid.type.type),
        'C variadic tail',
        Location.at(invalid.anchor),
      )
      return {
        mappings,
        fact: {
          _tag: 'Unavailable',
          reason: { _tag: 'UnavailableCallSyntax', anchor: call.anchor },
          cause: Diagnostic.identity(diagnostic),
        },
        diagnostics: [diagnostic],
      }
    }
  }
  if (variadic ? actualCount < expectedCount : expectedCount !== actualCount) {
    return {
      mappings,
      fact: { _tag: 'ArityMismatch', expectedCount, actualCount },
      diagnostics: [
        callArityDiagnostic(reference, expectedCount, actualCount, Location.at(call.anchor)),
      ],
    }
  }
  // Every argument the call did supply is sound, so what remains open is genuinely undetermined
  // rather than a consequence of an argument the author already needs to fix.
  if (unresolvedSpecialization !== undefined) {
    return {
      mappings,
      fact: {
        _tag: 'Unavailable',
        reason: { _tag: 'UnavailableCallSyntax', anchor: call.anchor },
        cause: Diagnostic.identity(unresolvedSpecialization),
      },
      diagnostics: [unresolvedSpecialization],
    }
  }

  const lifetimeDiagnostics = selectedLifetimeBoundDiagnostics(
    contract.lifetimeBounds,
    substitution,
    resolution?.lifetimeCompatibility,
    Location.at(call.anchor),
    contract.typeOutlives,
  )
  const lifetimeFailure = lifetimeDiagnostics.at(0)
  if (lifetimeFailure !== undefined)
    return {
      mappings,
      fact: {
        _tag: 'Unavailable',
        reason: { _tag: 'UnavailableCallSyntax', anchor: call.anchor },
        cause: Diagnostic.identity(lifetimeFailure),
      },
      diagnostics: lifetimeDiagnostics,
    }
  return {
    mappings,
    fact: {
      _tag: 'Compatible',
      inputViews: executableInputViews(
        reference,
        caller,
        call,
        argumentsList,
        substitution,
        resolution,
      ),
      expectedCount,
      actualCount,
      typeArguments,
      substitution,
      evidence,
      inferredProviderSelectors,
      symbolicConformances,
    },
    diagnostics: [],
  }
}

/** Retains the ordinary operation selection so later semantic passes never rediscover witnesses. */
export const interfaceEvidence = (
  reference: CallReferenceFact,
  index: DeclarationIndex.Index,
): ReadonlyArray<ConformanceGoal.Proof> => {
  if (
    reference._tag !== 'ResolvedInterfaceOperation' ||
    !Type.isRuntimeConcrete(reference.provider)
  )
    return []
  const proof = ConformanceProof.prove(index, reference.provider, reference.capability)
  return proof._tag === 'Proved' ? [proof] : []
}

export const interfaceConstraints = (
  context: SemanticContext.SemanticContext,
  reference: CallReferenceFact,
  substitution: Type.Substitution | undefined,
  index: DeclarationIndex.Index,
  caller: DeclarationFact,
  span: Location.Location,
): {
  readonly diagnostics: ReadonlyArray<Diagnostic.Located>
  readonly proofs: ReadonlyArray<ConformanceGoal.Proof>
} => {
  const proofs: Array<ConformanceGoal.Proof> = []
  if (reference._tag !== 'Resolved' || substitution === undefined) {
    proofs.push(...interfaceEvidence(reference, index))
    return { diagnostics: [], proofs }
  }
  const diagnostics = reference.declaration.typeParameters.flatMap((parameter) => {
    const provider = substitution.get(Type.key(parameter.type))
    if (provider === undefined || !Type.isTypeArgument(provider)) return []
    return parameter.bounds.flatMap((bound): ReadonlyArray<Diagnostic.Located> => {
      // An unresolved bound was reported at its declaration.
      if (bound._tag !== 'ResolvedBound') return []
      const substitutedCapability = Type.substitute(bound.application.capability, substitution)
      if (!Type.isNominal(substitutedCapability))
        return [
          Diagnostic.invalidConformance(
            `unknown interface constraint ${bound.spelling}`,
            Location.at(parameter.anchor),
          ),
        ]
      const capability = substitutedCapability
      const assumedByCaller =
        boundAssumedBy(caller, provider, capability) ||
        ConformanceProof.assumedConditionalConformance(index, provider, capability, caller) ||
        (Type.equals(capability, Type.copyCapability) &&
          ConformanceProof.copyType(index, provider, copyAssumptionsOf(caller)))
      if (assumedByCaller) return []
      if (!bound.application.providerMatches)
        return [
          Diagnostic.invalidConformance(
            `${bound.spelling} cannot bind Self to ${Type.encode(provider)}`,
            Location.at(parameter.anchor),
          ),
        ]
      // Selection excludes rejected declarations, but a partial declaration still carries the most
      // useful source error: name the exact operation it failed to map before reporting the broader
      // missing-witness result.
      const unmapped = ConformanceProof.unmappedInterfaceOperations(index, provider, capability)
      if (unmapped.length > 0)
        return unmapped.map((operation) =>
          Diagnostic.invalidConformance(
            `${Type.encode(provider)} does not implement ${bound.spelling}.${operation}`,
            span,
          ),
        )
      if (!ConformanceProof.conforms(index, provider, capability)) {
        // A conditional header that covers this provider but whose own requirements failed has a
        // more useful answer than "does not implement": the chain says which requirement is
        // missing and which wrapper asked for it.
        const proof = ConformanceProof.prove(index, provider, capability)
        if (
          proof._tag === 'Unproved' &&
          ConformanceGoal.key(proof.goal) !==
            ConformanceGoal.key(ConformanceGoal.make(capability, provider))
        )
          return [
            Diagnostic.unprovenConformance(
              ConformanceGoal.encode(ConformanceGoal.make(capability, provider)),
              ConformanceGoal.describe(proof.failure),
              ConformanceGoal.traceLines(proof),
              span,
            ),
          ]
        return [
          Diagnostic.invalidConformance(
            `${Type.encode(provider)} does not implement ${bound.spelling}`,
            span,
          ),
        ]
      }
      const proof = ConformanceProof.prove(index, provider, capability)
      if (proof._tag === 'Proved') proofs.push(proof)
      return []
    })
  })
  return { diagnostics, proofs }
}

/**
 * Reports whether one caller's own explicit bounds already promise `capability` for a
 * parameter-typed provider, so the promise is evidence rather than something to prove again.
 */
export const boundAssumedBy = (
  caller: DeclarationFact,
  provider: Type.Type,
  capability: Type.Nominal,
): boolean =>
  Type.isParameter(provider) &&
  caller.typeParameters.some(
    (parameter) =>
      Type.equals(parameter.type, provider) &&
      parameter.bounds.some(
        (bound) =>
          bound._tag === 'ResolvedBound' && Type.equals(bound.application.capability, capability),
      ),
  )

export const copyAssumptionsOf = (declaration: DeclarationFact): ReadonlySet<string> =>
  new Set(
    declaration.typeParameters.flatMap((parameter) =>
      parameter.bounds.some(
        (candidate) =>
          candidate._tag === 'ResolvedBound' &&
          Type.equals(candidate.application.capability, Type.copyCapability),
      )
        ? [Type.key(parameter.type)]
        : [],
    ),
  )

export interface BuiltinSignature {
  readonly id: Intrinsic.OperationId
  readonly operation: Tir.BuiltinOperation
  readonly typeParameters?: ReadonlyArray<Type.Parameter>
  readonly parameters: ReadonlyArray<SemanticType>
  readonly result: Intrinsic.ResultPolicy
  readonly unsafe?: boolean
}

export const builtinSignature = (
  actor: string,
  operation: string,
  parameterKind: 'Call' | 'Primitive' = 'Call',
): BuiltinSignature | undefined => {
  const catalog = Intrinsic.findOperation(actor, operation)
  if (catalog === undefined || !Intrinsic.isBuiltinOperation(catalog)) return undefined
  return {
    id: catalog.id,
    operation: catalog.rule.operation,
    typeParameters: catalog.rule.typeParameters,
    parameters: parameterKind === 'Call' ? catalog.callParameters : catalog.rule.parameters,
    result: catalog.rule.result,
    unsafe: catalog.unsafe,
  }
}

/** Allocates validity variables only after intrinsic selection; intrinsic templates never escape into caller bodies. */
const freeLifetimeBinders = (types: ReadonlyArray<Type.Type>): ReadonlyArray<Lifetime.Bound> => [
  ...new Map(
    types
      .flatMap(Type.freeLifetimes)
      .flatMap((lifetime) =>
        lifetime._tag === 'BoundLifetime' ? [[Lifetime.key(lifetime), lifetime] as const] : [],
      ),
  ).values(),
]

/** Opens an intrinsic's free template lifetimes in the selected caller's finite region domain. */
export const instantiateBuiltinSignature = (
  signature: BuiltinSignature,
  call: AuthoredHir.Expression,
  resolution: ResolutionContext,
): BuiltinSignature => {
  const result = Intrinsic.closedResultType(signature.result)
  const binders = freeLifetimeBinders([
    ...signature.parameters,
    ...(result === undefined ? [] : [result]),
  ])
  const selected = selectedCallLifetimes(call, binders, resolution)
  return {
    ...signature,
    parameters: signature.parameters.map((parameter) =>
      Type.substitute(parameter, selected.substitution),
    ),
    result: Intrinsic.substituteResult(signature.result, selected.substitution),
  }
}

export const callableResultType = (declaration: SourceCallable): SemanticType | undefined => {
  if (declaration.returnType._tag !== 'Resolved') return undefined
  if (declaration.functionKind === 'Ordinary') return declaration.returnType.type
  return Type.effectWithRows(
    declaration.returnType.type,
    declaration.failureRow.row,
    DeclarationFacts.effectLifetimes(declaration),
    'Shared',
    declaration.requirementRow.row,
  )
}

export const callableTypeOfReference = (
  context: SemanticContext.SemanticContext,
  reference: CallReferenceFact,
): Type.Callable | undefined => {
  if (reference._tag === 'ResolvedBuiltin')
    return Type.callable(
      reference.parameters,
      reference.result,
      {
        environment: Lifetime.staticLifetime,
        lifetimeBinders: [
          ...new Map(
            reference.parameters
              .flatMap(Type.freeLifetimes)
              .filter((lifetime) => lifetime._tag === 'BoundLifetime')
              .map((lifetime) => [Lifetime.key(lifetime), lifetime]),
          ).values(),
        ],
      },
      'Shared',
      undefined,
      reference.unsafe,
    )
  const callable = sourceCallable(reference)
  if (callable === undefined) return undefined
  // Hidden lexical capture lanes need genuine section formation operands. A bare
  // function item cannot fabricate their environment by projecting the raw body.
  if (callable.parameters.some((parameter) => parameter.captureAccess !== undefined))
    return undefined
  const parameters = callable.parameters.flatMap((parameter) =>
    parameter.declaredType._tag === 'Resolved' ? [parameter.declaredType.type] : [],
  )
  const result = callableResultType(callable)
  if (parameters.length !== callable.parameters.length || result === undefined) return undefined
  const contract = resolvedCallableContract(reference)
  return Type.callable(
    parameters,
    result,
    { ...DeclarationFacts.executableLifetimes(callable), environment: Lifetime.staticLifetime },
    'Shared',
    contract === undefined || (contract.constraints.length === 0 && contract.binders.length === 0)
      ? undefined
      : {
          ...(reference._tag === 'Resolved' && reference.declaration.canonical._tag === 'Canonical'
            ? { source: reference.declaration.canonical.id }
            : {}),
          contract,
          binders: contract.binders,
          constraints: contract.constraints,
          evidence: [],
          substitution: new Map(),
          contractKey: CallableContract.key(contract),
          constraintKeys: contract.constraints.map(Constraint.key),
          evidenceKeys: [],
          origins: constraintOrigins(context, callable),
        },
    callable.unsafe,
  )
}

export const serviceOperation = (
  service: DeclarationFacts.ContractFact,
  spelling_: string,
): DeclarationFacts.ServiceOperationFact | undefined =>
  service.operations.find(
    (operation) =>
      operation.state._tag === 'Unique' &&
      operation.name._tag === 'Present' &&
      operation.name.spelling === spelling_,
  )

/**
 * The contract one interface operation declares over a bounded parameter.
 *
 * The interface writes its contract over its own type parameter; a bound applies that interface to
 * one parameter of the bounded declaration, so the operation's contract over that parameter is the
 * declared one with the interface's parameter substituted. It is the same contract the conformance
 * check already holds every witness to, which is what lets the body be checked once, over the
 * canonical parameter, before any concrete argument exists.
 */
export const interfaceOperationContract = (
  operation: DeclarationFacts.InterfaceOperationApplicationFact,
):
  | {
      readonly declaration: DeclarationFacts.ServiceOperationFact
      readonly contract: DeclarationFacts.InterfaceOperationApplicationFact
      readonly parameters: ReadonlyArray<SemanticType>
      readonly result: SemanticType
    }
  | undefined => {
  if (
    operation.declaration.typeParameters.some((parameter) => parameter.type.kind !== 'Lifetime') ||
    operation.success._tag !== 'Resolved'
  )
    return undefined
  const parameters = operation.operands.flatMap((operand) =>
    operand.type._tag === 'Resolved' ? [operand.type.type] : [],
  )
  if (parameters.length !== operation.operands.length) return undefined
  const result =
    operation.functionKind === 'Ordinary'
      ? operation.success.type
      : Type.effectWithRows(
          operation.success.type,
          operation.failureRow.row,
          { ...operation.lifetimes, lifetimeBinders: [] },
          'Shared',
          operation.requirementRow.row,
        )
  return {
    declaration: operation.declaration,
    contract: operation,
    parameters: parameters,
    result,
  }
}

/** Opens only the selected interface operation's invocation lifetime binders at this call. */
export const instantiateInterfaceReference = (
  reference: Extract<CallReferenceFact, { readonly _tag: 'ResolvedInterfaceOperation' }>,
  call: AuthoredHir.Expression,
  resolution: ResolutionContext,
): typeof reference => {
  const declared = DeclarationFacts.executableLifetimes(reference.declaration)
  const selected = selectedCallLifetimes(
    call,
    declared.lifetimeBinders,
    resolution,
    new Map(),
    declared.invocationUse?.lifetime._tag === 'BoundLifetime'
      ? declared.invocationUse.lifetime
      : undefined,
  )
  return {
    ...reference,
    parameters: reference.parameters.map((parameter) =>
      Type.substitute(parameter, selected.substitution),
    ),
    result: Type.substitute(reference.result, selected.substitution),
    interfaceContract: DeclarationFacts.instantiateInterfaceOperation(
      reference.interfaceContract,
      selected.substitution,
    ),
  }
}

/**
 * Resolves one `Bound.operation(...)` receiver against the bounds of the declaration being
 * elaborated.
 *
 * A bound's operation is spelled through the bound's own name, so inside a body bounded by an
 * interface that name selects the bound's operation rather than a same-named public function of the
 * module declaring the interface. The preference is deliberately narrow: only a name the bound's
 * recorded contract actually declares is taken, so every other member of that module keeps
 * resolving exactly where it resolved before, and a body with no such bound is untouched.
 *
 * One declaration may bound two of its parameters by one interface. The receiver then names no
 * single parameter, and the call is reported rather than resolved to either.
 */
export const boundOperationReference = (
  declaration: DeclarationFact,
  interface_: DeclarationFacts.ContractFact,
  qualifier: string,
  member: string,
  memberToken: AuthoredHir.Name,
):
  | {
      readonly _tag: 'BoundOperation'
      readonly reference: Extract<
        CallReferenceFact,
        { readonly _tag: 'ResolvedInterfaceOperation' }
      >
    }
  | { readonly _tag: 'AmbiguousBound'; readonly parameters: ReadonlyArray<string> }
  | undefined => {
  if (interface_.canonical._tag !== 'Canonical') return undefined
  const capability = interface_.canonical.id
  const bounded = declaration.typeParameters.flatMap((parameter) =>
    parameter.bounds.flatMap((bound) =>
      bound._tag === 'ResolvedBound' &&
      bound.application.declaration.module === capability.module &&
      bound.application.declaration.name === capability.name &&
      bound.application.operations.some(
        (operation) =>
          operation.declaration.name._tag === 'Present' &&
          operation.declaration.name.spelling === member,
      )
        ? [{ parameter, bound }]
        : [],
    ),
  )
  if (bounded.length === 0) return undefined
  if (bounded.length > 1)
    return {
      _tag: 'AmbiguousBound',
      parameters: bounded.map(({ parameter }) =>
        parameter.name._tag === 'Present' ? parameter.name.spelling : Type.encode(parameter.type),
      ),
    }
  const selected = bounded.at(0)
  if (selected === undefined) return undefined
  const { parameter, bound } = selected
  const operation = bound.application.operations.find(
    (candidate) =>
      candidate.declaration.name._tag === 'Present' &&
      candidate.declaration.name.spelling === member,
  )
  if (operation === undefined) return undefined
  const contract = interfaceOperationContract(operation)
  if (contract === undefined) return undefined
  return {
    _tag: 'BoundOperation',
    reference: {
      _tag: 'ResolvedInterfaceOperation' as const,
      spelling: `${qualifier}.${member}`,
      anchor: memberToken.anchor,
      capability: bound.application.capability,
      provider: parameter.type,
      operation: member,
      declaration: contract.declaration,
      interfaceContract: contract.contract,
      parameters: contract.parameters,
      result: contract.result,
    },
  }
}

/** A generated call result is unavailable as a stable source-callable function item. */
export const builtinFunctionReference = (
  signature: BuiltinSignature,
  actor: string,
  operation: string,
  anchor: AuthoredHir.Anchor,
): CallReferenceFact => {
  const result = Intrinsic.closedResultType(signature.result)
  if (result === undefined) return { _tag: 'Unavailable', anchor }
  return {
    _tag: 'ResolvedBuiltin',
    spelling: `${actor}.${operation}`,
    anchor,
    actor,
    operation: signature.operation,
    intrinsic: signature.id,
    parameters: signature.parameters,
    result,
    unsafe: signature.unsafe === true,
  }
}

export const resolvedFunctionReference = (
  context: SemanticContext.SemanticContext,
  node: AuthoredHir.Expression,
  declarations: ReadonlyArray<DeclarationFact>,
  resolution: ResolutionContext,
): CallReferenceFact | undefined => {
  const identifiers = referenceNames(node)
  const first = identifiers.at(0)
  const second = identifiers.at(1)
  if (first === undefined) return undefined
  if (second === undefined) {
    const name = SemanticContext.nameText(context, first) ?? ''
    const resolved = Semantic.resolveName(resolution.semantic, resolution.scope, name)
    const local = lookupDeclaration(declarations, name)
    let declaration: DeclarationFacts.DeclarationFact | undefined
    if (resolved._tag === 'Resolved' && resolved.declaration._tag === 'FunctionDeclaration') {
      declaration = resolved.declaration
    } else if (local._tag === 'Resolved') {
      declaration = local.declaration
    } else {
      declaration = undefined
    }
    return declaration === undefined
      ? undefined
      : {
          _tag: 'Resolved',
          spelling: name,
          anchor: first.anchor,
          declaration,
        }
  }
  const qualifier = SemanticContext.nameText(context, first) ?? ''
  const member = SemanticContext.nameText(context, second) ?? ''
  const qualifierLookup = Semantic.resolveName(resolution.semantic, resolution.scope, qualifier)
  if (qualifierLookup._tag === 'Intrinsic') {
    const signature = builtinSignature(qualifier, member)
    if (signature === undefined) {
      return undefined
    }
    return builtinFunctionReference(signature, qualifier, member, second.anchor)
  }
  if (qualifierLookup._tag === 'Resolved') {
    const associated = Semantic.resolveAssociatedName(
      resolution.semantic,
      qualifierLookup.declaration,
      member,
      resolution.scope.module,
    )
    return associated._tag === 'Inherent'
      ? {
          _tag: 'Resolved',
          spelling: `${qualifier}.${member}`,
          anchor: second.anchor,
          declaration: associated.declaration,
        }
      : undefined
  }
  if (qualifierLookup._tag !== 'Namespace') return undefined
  const memberLookup = DeclarationFacts.lookup(resolution.index, qualifierLookup.module, member)
  if (
    memberLookup._tag !== 'Resolved' ||
    memberLookup.declaration._tag !== 'FunctionDeclaration' ||
    memberLookup.declaration.visibility !== 'Public'
  )
    return undefined
  return {
    _tag: 'Resolved',
    spelling: `${qualifier}.${member}`,
    anchor: second.anchor,
    declaration: memberLookup.declaration,
  }
}

export const analyzeFunctionItem = (
  context: SemanticContext.SemanticContext,
  node: AuthoredHir.Expression,
  declarations: ReadonlyArray<DeclarationFact>,
  resolution: ResolutionContext,
  caller: DeclarationFact,
  expected?: SemanticType,
): ExpressionResult | undefined => {
  const reference = resolvedFunctionReference(context, node, declarations, resolution)
  if (reference === undefined) {
    const identifiers = referenceNames(node)
    const qualifierToken = identifiers.at(0)
    const memberToken = identifiers.at(1)
    if (qualifierToken === undefined || memberToken === undefined) return undefined
    const qualifier = SemanticContext.nameText(context, qualifierToken) ?? ''
    const member = SemanticContext.nameText(context, memberToken) ?? ''
    const qualifierLookup = Semantic.resolveName(resolution.semantic, resolution.scope, qualifier)
    if (qualifierLookup._tag !== 'Namespace') return undefined
    const memberLookup = DeclarationFacts.lookup(resolution.index, qualifierLookup.module, member)
    let diagnostic: Diagnostic.Located | undefined
    if (memberLookup._tag !== 'Resolved') {
      diagnostic = Diagnostic.unknownImportedMember(
        qualifierLookup.module,
        member,
        Location.at(memberToken.anchor),
      )
    } else if (memberLookup.declaration.visibility !== 'Public') {
      diagnostic = Diagnostic.inaccessibleImportedMember(
        qualifierLookup.module,
        member,
        Location.at(memberToken.anchor),
      )
    } else {
      diagnostic = undefined
    }
    if (diagnostic === undefined) return undefined
    const missing: CallReferenceFact = {
      _tag: 'Missing',
      spelling: `${qualifier}.${member}`,
      anchor: memberToken.anchor,
      cause: Diagnostic.identity(diagnostic),
    }
    return {
      fact: {
        _tag: 'FunctionItem',
        reference: missing,
        path: referencePath(context, node),
        typeArguments: [],
        type: unavailableExpressionType,
        anchor: node.anchor,
      },
      diagnostics: [diagnostic],
      type: undefined,
    }
  }
  const unresolvedCallable = callableTypeOfReference(context, reference)
  if (expected !== undefined && Type.isForeignFunction(expected)) {
    const declaration = reference._tag === 'Resolved' ? reference.declaration : undefined
    let detail: string | undefined
    if (declaration === undefined) {
      detail = 'only a named exported Silk function has a stable native address'
    } else if (declaration.foreignExport === undefined) {
      detail = 'the function must be declared with export "C"'
    } else if (declaration.machine !== undefined) {
      detail = 'naked machine functions cannot establish the guarded C callback entry'
    } else if (declaration.typeParameters.some((parameter) => parameter.type.kind !== 'Lifetime')) {
      detail = 'generic functions do not have one monomorphic C address'
    } else if (declaration.functionKind !== 'Ordinary') {
      detail = 'effect functions cannot cross the synchronous C callback boundary'
    } else if (
      ForeignContract.key(declaration.foreignExport.contract) !==
      ForeignContract.key(expected.contract)
    ) {
      detail = 'the exported behavioral contract must exactly match the native pointer type'
    } else if (
      unresolvedCallable === undefined ||
      declaration === undefined ||
      !typesCompatible(
        Type.foreignFunction(
          unresolvedCallable.parameters,
          unresolvedCallable.result,
          declaration.foreignExport.contract,
          DeclarationFacts.executableLifetimes(declaration),
        ),
        expected,
        resolution.lifetimeCompatibility,
      )
    ) {
      detail = `the exported signature must exactly match ${Type.encode(expected)}`
    }
    if (detail !== undefined) {
      const name = reference._tag === 'Unavailable' ? '<expression>' : reference.spelling
      const diagnostic = Diagnostic.invalidForeignCallback(name, detail, Location.at(node.anchor))
      return {
        fact: {
          _tag: 'FunctionItem',
          reference,
          path: referencePath(context, node),
          typeArguments: [],
          type: unavailableExpressionType,
          anchor: node.anchor,
        },
        diagnostics: [diagnostic],
        type: undefined,
      }
    }
    const symbol = declaration?.foreignExport?.symbol
    if (symbol === undefined) throw new RangeError('validated C callback lost its exported symbol')
    return {
      fact: {
        _tag: 'FunctionItem',
        reference,
        path: referencePath(context, node),
        typeArguments: [],
        foreignAddress: { symbol },
        type: availableExpressionType(expected),
        anchor: node.anchor,
      },
      diagnostics: [],
      type: expected,
    }
  }
  const contract = resolvedCallableContract(reference)
  const expectedValue =
    expected !== undefined && Type.isRepresented(expected) ? expected.contract : expected
  const expectedCallable =
    expectedValue !== undefined && Type.isCallable(expectedValue) ? expectedValue : undefined
  const opened =
    expectedCallable?.lifetimeBinders.length === 0
      ? (unresolvedCallable?.lifetimeBinders ?? [])
      : []
  const callLifetimes = selectedCallLifetimes(
    node,
    opened,
    resolution,
    new Map(),
    unresolvedCallable?.invocationUse?.lifetime._tag === 'BoundLifetime'
      ? unresolvedCallable.invocationUse.lifetime
      : undefined,
  )
  const invocationAdapter =
    unresolvedCallable !== undefined &&
    expectedCallable?.invocationUse !== undefined &&
    contract !== undefined
      ? TypeInference.adaptInvocationCallable(
          unresolvedCallable,
          expectedCallable,
          contract.binders,
          callLifetimes.substitution,
          resolution.lifetimeCompatibility,
          resolution.invocationConsumer?.caller.sourceId === caller.id.sourceId &&
            resolution.invocationConsumer.caller.ordinal === caller.id.ordinal
            ? resolution.invocationConsumer
            : undefined,
        )
      : undefined
  // Here the inference pattern is the offered generic item, while the contextual type is the
  // required use. Argument inference has the opposite orientation; retain that distinction for
  // lifetime obligations while still inferring the item's own type parameters.
  const itemInference: TypeInference.LifetimeInference | undefined =
    callLifetimes.inference === undefined
      ? undefined
      : {
          ...callLifetimes.inference,
          accepts: (source, target, invariant) =>
            callLifetimes.inference?.accepts(target, source, invariant) ?? false,
        }
  const contextual = new Map<string, Type.GenericArgument>(
    invocationAdapter?.substitution ?? callLifetimes.substitution,
  )
  const pattern =
    unresolvedCallable === undefined || expectedCallable === undefined
      ? undefined
      : Type.callable(
          unresolvedCallable.parameters,
          unresolvedCallable.result,
          {
            ...unresolvedCallable,
            environment: expectedCallable.environment,
            lifetimeBinders:
              expectedCallable.lifetimeBinders.length === 0
                ? []
                : unresolvedCallable.lifetimeBinders,
          },
          expectedCallable.mode,
          unresolvedCallable.schema,
          unresolvedCallable.unsafe,
        )
  const substitutedPattern =
    pattern === undefined ? undefined : Type.substitute(pattern, contextual)
  const contextualPattern =
    substitutedPattern !== undefined && Type.isCallable(substitutedPattern)
      ? substitutedPattern
      : undefined
  let specialized =
    invocationAdapter !== undefined ||
    (contextualPattern !== undefined &&
      expectedCallable !== undefined &&
      TypeInference.infer(contextualPattern, expectedCallable, contextual, itemInference))
  if (!specialized && contextualPattern !== undefined && expectedCallable !== undefined) {
    const partial = new Map<string, Type.GenericArgument>(callLifetimes.substitution)
    const attempt = (): boolean => {
      const parametersCompatible =
        contextualPattern.lifetimeBinders.length > 0
          ? TypeInference.infer(
              Type.callable(
                contextualPattern.parameters,
                Type.unit,
                contextualPattern,
                contextualPattern.mode,
              ),
              Type.callable(
                expectedCallable.parameters,
                Type.unit,
                expectedCallable,
                expectedCallable.mode,
              ),
              partial,
              itemInference,
            )
          : contextualPattern.parameters.length === expectedCallable.parameters.length &&
            contextualPattern.parameters.every((parameter, ordinal) => {
              const expectedParameter = expectedCallable.parameters.at(ordinal)
              return (
                expectedParameter !== undefined &&
                TypeInference.infer(parameter, expectedParameter, partial, itemInference)
              )
            })
      const patternResult = contextualPattern.result
      const expectedResult = expectedCallable.result
      // The inputs may determine the named callback before the enclosing combinator has
      // inferred its result parameter. Leave that parameter to enclosing argument inference;
      // every binder of the offered callback must still be determined here.
      const resultCompatible =
        Type.isEffect(patternResult) && Type.isEffect(expectedResult)
          ? Type.isParameter(expectedResult.success) ||
            TypeInference.infer(
              patternResult.success,
              expectedResult.success,
              partial,
              itemInference,
            )
          : Type.isParameter(expectedResult) ||
            TypeInference.infer(patternResult, expectedResult, partial, itemInference)
      const allBindersDetermined = (contract?.binders ?? []).every(
        (parameter) =>
          partial.has(Type.key(parameter)) ||
          contextualPattern.lifetimeBinders.some(
            (binder) => Lifetime.key(binder) === Type.key(parameter),
          ),
      )
      return parametersCompatible && resultCompatible && allBindersDetermined
    }
    const accepted =
      callLifetimes.compatibility === undefined
        ? attempt()
        : TypeCompatibility.commitWhen(callLifetimes.compatibility, attempt, (result) => result)
    if (accepted) {
      contextual.clear()
      for (const [key, argument] of partial) contextual.set(key, argument)
      specialized = true
    }
  }
  let callable = invocationAdapter?.callable ?? unresolvedCallable
  if (callable !== undefined && specialized && invocationAdapter === undefined) {
    const instantiated = Type.callable(
      callable.parameters,
      callable.result,
      {
        ...callable,
        lifetimeBinders: callable.lifetimeBinders.filter(
          (binder) =>
            expectedCallable?.lifetimeBinders.length !== 0 || !contextual.has(Lifetime.key(binder)),
        ),
      },
      callable.mode,
      callable.schema,
      callable.unsafe,
    )
    const contextualCallable = Type.substitute(instantiated, contextual)
    callable = Type.isCallable(contextualCallable) ? contextualCallable : undefined
  }
  const typeArguments = specialized
    ? (contract?.binders ?? []).flatMap((parameter) => {
        const argument =
          contextual.get(Type.key(parameter)) ??
          callable?.lifetimeBinders.find((binder) => Lifetime.key(binder) === Type.key(parameter))
        return argument === undefined ? [] : [argument]
      })
    : []
  // A fully selected function item needs no runtime constraint dictionary. Discharge its
  // declaration obligations before erasing the schema; open items keep their existing checks.
  const closedConstraints =
    specialized &&
    typeArguments.length === contract?.binders.length &&
    typeArguments.every(Type.isRuntimeConcreteGenericArgument) &&
    callable?.schema !== undefined &&
    invocationAdapter === undefined &&
    callable.schema.constraints.length > 0
      ? solveCallableConstraints(
          callable.schema.constraints,
          callable.schema.origins,
          contextual,
          caller,
          resolution,
          Location.at(node.anchor),
        )
      : undefined
  if (
    callable !== undefined &&
    closedConstraints !== undefined &&
    closedConstraints.diagnostics.length === 0 &&
    closedConstraints.evidence.every((evidence) => evidence._tag !== 'Assumed')
  ) {
    callable = Type.callable(
      callable.parameters,
      callable.result,
      callable,
      callable.mode,
      undefined,
      callable.unsafe,
    )
  }
  // A foreign function is callable only; the call path discards this item and resolves the
  // declaration directly, so the diagnostic survives exactly at first-class uses.
  // A static function has no runtime function item either (STATIC-001).
  const firstClass =
    foreignFirstClassDiagnostic(context, reference, node) ??
    staticFirstClassDiagnostic(context, reference, node, resolution)
  const constraints = interfaceConstraints(
    context,
    reference,
    contextual,
    resolution.index,
    caller,
    Location.at(node.anchor),
  )
  // Specialization can turn invocation predicates into free formation facts. Prove them before
  // publishing the value: structural callable comparison may thereafter assume those facts.
  const formation =
    callable === undefined ? undefined : Type.executableFormationRequirements(callable)
  const lifetimeDiagnostics =
    formation === undefined
      ? []
      : selectedLifetimeBoundDiagnostics(
          formation.lifetimeBounds,
          new Map(),
          resolution.lifetimeCompatibility,
          Location.at(node.anchor),
          formation.typeOutlives,
        )
  const available =
    firstClass === undefined &&
    lifetimeDiagnostics.length === 0 &&
    (closedConstraints?.diagnostics.length ?? 0) === 0
  const type =
    callable === undefined || !available
      ? unavailableExpressionType
      : availableExpressionType(callable)
  return {
    fact: {
      _tag: 'FunctionItem',
      selectedConformances: constraints.proofs,
      reference,
      path: referencePath(context, node),
      typeArguments,
      type,
      anchor: node.anchor,
    },
    diagnostics: [
      ...constraints.diagnostics,
      ...(closedConstraints?.diagnostics ?? []),
      ...lifetimeDiagnostics,
      ...(firstClass === undefined ? [] : [firstClass]),
    ],
    type: available ? callable : undefined,
  }
}

const staticFirstClassDiagnostic = (
  context: SemanticContext.SemanticContext,
  reference: CallReferenceFact,
  node: AuthoredHir.Expression,
  resolution: ResolutionContext,
): Diagnostic.Located | undefined =>
  reference._tag === 'Resolved' && reference.declaration.phase === 'Static'
    ? Diagnostic.staticPhaseViolation(
        `static function ${reference.spelling} as a runtime callable`,
        resolution.staticContext?.environment.target ?? 'unselected-target',
        [],
        Location.at(node.anchor),
      )
    : undefined

const foreignFirstClassDiagnostic = (
  context: SemanticContext.SemanticContext,
  reference: CallReferenceFact,
  node: AuthoredHir.Expression,
): Diagnostic.Located | undefined =>
  reference._tag === 'Resolved' && reference.declaration.foreign !== undefined
    ? Diagnostic.foreignFunctionNotFirstClass(reference.spelling, Location.at(node.anchor))
    : undefined

export interface SectionContractResult {
  readonly substitution: Type.Substitution
  readonly typeArguments: ReadonlyArray<Type.GenericArgument>
  readonly diagnostics: ReadonlyArray<Diagnostic.Located>
  readonly valid: boolean
}

/** A section binds its written arguments to the captured parameter ordinals, in order. */
export const sectionSpecializationSites = (
  contract: CallableContract.CallableContract,
  arguments_: ReadonlyArray<ArgumentFact>,
  captured: ReadonlyArray<number>,
): ReadonlyArray<SpecializationSite> =>
  arguments_.flatMap((argument, ordinal): ReadonlyArray<SpecializationSite> => {
    const parameter = parameterAt(contract.parameters, captured, ordinal)
    return argument.type._tag === 'Available' && parameter !== undefined
      ? [
          {
            ordinal,
            pattern: parameter.type,
            actual: argument.type.type,
            expression: argument.expression,
          },
        ]
      : []
  })

export const analyzeSectionContract = (
  context: SemanticContext.SemanticContext,
  call: AuthoredHir.Expression,
  reference: Extract<
    CallReferenceFact,
    { readonly _tag: 'Resolved' | 'ResolvedBuiltin' | 'ResolvedIntrinsicContract' }
  >,
  arguments_: ReadonlyArray<ArgumentFact>,
  callTypeArguments: CallTypeArgumentsResult,
  captured: ReadonlyArray<number>,
  resolution?: ResolutionContext,
): SectionContractResult => {
  if (reference._tag === 'ResolvedBuiltin') {
    const diagnostics = arguments_.flatMap((argument, ordinal) => {
      if (argument.type._tag !== 'Available') return []
      const expected = parameterAt(reference.parameters, captured, ordinal)
      if (
        expected === undefined ||
        typesCompatible(argument.type.type, expected, resolution?.lifetimeCompatibility)
      )
        return []
      return [
        Diagnostic.argumentTypeMismatch(
          Type.encode(expected),
          Type.encode(argument.type.type),
          Location.at(argument.anchor),
        ),
      ]
    })
    if (callTypeArguments.explicit)
      diagnostics.push(
        Diagnostic.typeArgumentArity(
          reference.spelling,
          0,
          callTypeArguments.facts.length,
          Location.at(call.anchor),
        ),
      )
    return {
      substitution: new Map(),
      typeArguments: [],
      diagnostics: diagnostics,
      valid:
        diagnostics.length === 0 &&
        arguments_.every((argument) => argument.type._tag === 'Available'),
    }
  }

  const callable = resolvedCallableContract(reference)
  if (callable === undefined) throw new RangeError('section lost its callable contract')
  const capturedLifetimes = new Set(
    captured.flatMap((ordinal) => {
      const parameter = callable.parameters.at(ordinal)
      return parameter === undefined ? [] : Type.storageLifetimes(parameter.type).map(Lifetime.key)
    }),
  )
  const capturedBinders = callable.lifetimeBinders.filter(
    (binder) =>
      capturedLifetimes.has(Lifetime.key(binder)) &&
      (callable.invocationUse === undefined ||
        !Lifetime.equals(binder, callable.invocationUse.lifetime)),
  )
  const remainingBinders = callable.lifetimeBinders.filter(
    (binder) =>
      !capturedLifetimes.has(Lifetime.key(binder)) ||
      (callable.invocationUse !== undefined &&
        Lifetime.equals(binder, callable.invocationUse.lifetime)),
  )
  const remainingLifetimeKeys = new Set(remainingBinders.map(Lifetime.key))
  const callLifetimes = selectedCallLifetimes(call, capturedBinders, resolution)
  const declaredParameters = callable.binders
  const diagnostics: Array<Diagnostic.Located> = []
  const contradicted = new Set<number>()
  let substitution = new Map<string, Type.GenericArgument>(callLifetimes.substitution)
  if (callTypeArguments.explicit) {
    if (
      callTypeArguments.types === undefined ||
      callTypeArguments.facts.length > declaredParameters.length
    ) {
      diagnostics.push(
        Diagnostic.typeArgumentArity(
          reference.spelling,
          declaredParameters.length,
          callTypeArguments.facts.length,
          Location.at(call.anchor),
        ),
      )
    } else {
      // Written and inferred type arguments specialize the captured parameters while every
      // remaining parameter stays available to later application.
      const remaining = remainingOf(callable.parameters, captured)
      const constraintDeferred = callable.constraints.flatMap((constraint) =>
        constraint._tag === 'ProviderSelectionConstraint' &&
        constraint.selected.expression._tag === 'RowParameter'
          ? [Type.key(constraint.selected.expression.parameter)]
          : [],
      )
      const seeded = seededSpecialization(
        context,
        reference.spelling,
        declaredParameters,
        callTypeArguments.facts,
        sectionSpecializationSites(callable, arguments_, captured),
        Location.at(call.anchor),
        new Set([
          ...remainingLifetimeKeys,
          ...remaining.flatMap((parameter) => Type.parameters(parameter.type).map(Type.key)),
          ...constraintDeferred,
        ]),
        resolution?.staticContext?.typeSubstitution,
        callLifetimes,
        resolution?.builder,
      )
      substitution = new Map(seeded.substitution)
      for (const conflict of seeded.conflicts) {
        diagnostics.push(conflict.diagnostic)
        if (conflict.ordinal !== undefined) contradicted.add(conflict.ordinal)
      }
      if (seeded.unresolved !== undefined) diagnostics.push(seeded.unresolved)
    }
  } else {
    for (const [ordinal, argument] of arguments_.entries()) {
      const parameter = parameterAt(callable.parameters, captured, ordinal)
      if (
        argument.type._tag === 'Available' &&
        parameter !== undefined &&
        !TypeInference.infer(
          parameter.type,
          argument.type.type,
          substitution,
          callLifetimes.inference,
        )
      ) {
        const rowFailure = TypeInference.inferenceFailure(
          parameter.type,
          argument.type.type,
          substitution,
          callLifetimes.inference,
        )
        diagnostics.push(
          rowFailure === undefined
            ? Diagnostic.typeArgumentInference(reference.spelling, Location.at(call.anchor))
            : Diagnostic.inferenceFailure(rowFailure, Location.at(call.anchor)),
        )
        break
      }
    }
    const remaining = remainingOf(callable.parameters, captured)
    const deferred = new Set([
      ...remainingLifetimeKeys,
      ...remaining.flatMap((parameter) => Type.parameters(parameter.type).map(Type.key)),
      ...callable.constraints.flatMap((constraint) =>
        constraint._tag === 'ProviderSelectionConstraint' &&
        constraint.selected.expression._tag === 'RowParameter'
          ? [Type.key(constraint.selected.expression.parameter)]
          : [],
      ),
    ])
    if (
      declaredParameters.some(
        (parameter) => !substitution.has(Type.key(parameter)) && !deferred.has(Type.key(parameter)),
      )
    ) {
      diagnostics.push(
        Diagnostic.typeArgumentInference(reference.spelling, Location.at(call.anchor)),
      )
    }
  }
  for (const [ordinal, argument] of arguments_.entries()) {
    const parameter = parameterAt(callable.parameters, captured, ordinal)
    if (argument.type._tag !== 'Available' || parameter === undefined) continue
    // An argument already named as contradicting a written type argument is one mistake, and it
    // was reported where the author wrote the type.
    if (contradicted.has(ordinal)) continue
    const expected = Type.substitute(parameter.type, substitution)
    if (
      !Type.isConcrete(expected) ||
      typesCompatible(argument.type.type, expected, resolution?.lifetimeCompatibility)
    )
      continue
    diagnostics.push(
      Diagnostic.argumentTypeMismatch(
        Type.encode(expected),
        Type.encode(argument.type.type),
        Location.at(argument.anchor),
      ),
    )
  }
  diagnostics.push(
    ...selectedLifetimeBoundDiagnostics(
      callable.lifetimeBounds.filter(
        (bound) =>
          !remainingLifetimeKeys.has(Lifetime.key(bound.longer)) &&
          !remainingLifetimeKeys.has(Lifetime.key(bound.shorter)),
      ),
      substitution,
      resolution?.lifetimeCompatibility,
      Location.at(call.anchor),
      callable.typeOutlives.filter(
        (bound) => !remainingLifetimeKeys.has(Lifetime.key(bound.lifetime)),
      ),
    ),
  )
  const typeArguments = declaredParameters.flatMap((parameter) => {
    const inferred = substitution.get(Type.key(parameter))
    return inferred === undefined ? [] : [inferred]
  })
  return {
    substitution,
    typeArguments,
    diagnostics: diagnostics,
    valid:
      diagnostics.length === 0 &&
      arguments_.every((argument) => argument.type._tag === 'Available'),
  }
}

export const captureAccess = (
  expression: ExpressionDecision | Tir.Expression,
  index: DeclarationIndex.Index | undefined,
  assumptions: ReadonlySet<string> = new Set(),
): CallableCaptureFact['access'] => {
  if (expression._tag === 'Move') {
    const subjectType = constructionExpressionType(expression.subject)
    return subjectType._tag === 'Available' &&
      index !== undefined &&
      ConformanceProof.copyType(index, subjectType.type, assumptions)
      ? 'Copy'
      : 'Take'
  }
  if (expression._tag === 'Borrow')
    return expression.access === 'Exclusive' ? 'Exclusive' : 'Shared'
  if (expression._tag === 'ValueBorrow' || expression._tag === 'SliceBorrow')
    return expression.access === 'Exclusive' ? 'Exclusive' : 'Shared'
  const expressionType = constructionExpressionType(expression)
  if (expressionType._tag === 'Available' && Type.isCallable(expressionType.type))
    return expressionType.type.mode === 'Shared' ? 'Copy' : expressionType.type.mode
  if (expressionType._tag === 'Available' && Type.isEffect(expressionType.type))
    return expressionType.type.access === 'Shared' ? 'Copy' : expressionType.type.access
  // An owned affine value (a fresh temporary or a call result) is captured by ownership whether
  // or not the source spelled `move`; the environment then cleans it exactly once.
  if (
    expressionType._tag === 'Available' &&
    index !== undefined &&
    !Type.isReference(expressionType.type) &&
    !Type.isSlice(expressionType.type) &&
    !ConformanceProof.copyType(index, expressionType.type, assumptions)
  )
    return 'Take'
  return 'Copy'
}

export const ownedProviderCaptureAccess = (
  expression: ExpressionDecision | Tir.Expression,
  index: DeclarationIndex.Index,
  assumptions: ReadonlySet<string> = new Set(),
): CallableCaptureFact['access'] => {
  const subjectType =
    expression._tag === 'Move' ? constructionExpressionType(expression.subject) : undefined
  return expression._tag === 'Move' &&
    subjectType?._tag === 'Available' &&
    ConformanceProof.copyType(index, subjectType.type, assumptions)
    ? 'Copy'
    : captureAccess(expression, index, assumptions)
}

type ExactCallableFact = Extract<
  ExpressionDecision,
  { readonly _tag: 'FunctionItem' | 'CallableSection' }
>

export const exactCallableOf = (
  expression: ExpressionDecision,
  writtenBindings: ReadonlySet<number> = new Set(),
): ExactCallableFact | undefined => {
  if (expression._tag === 'Move') {
    return expression.exactCallable
  }
  if (expression._tag === 'FunctionItem' || expression._tag === 'CallableSection') return expression
  if (expression._tag === 'Identifier' && expression.reference._tag === 'ResolvedBinding') {
    if (writtenBindings.has(expression.reference.binding.id.ordinal)) return undefined
    return expression.reference.binding.exactCallable
  }
  return undefined
}

type StoredInvocationInput = {
  readonly parameter: number
  readonly capture: number
  readonly expression: Tir.Expression
  readonly leaf: Tir.CallableSiteId
  readonly capturePath?: NonNullable<Tir.InvocationUseObligation['inputs'][number]['capturePath']>
}

interface StoredInvocationRecipe {
  readonly parameters: ReadonlyArray<number>
  readonly captures: ReadonlyArray<StoredInvocationInput>
}

/** Reads original input coordinates only from the actual immutable staged value graph. */
const storedInvocationRecipe = (
  expression: Tir.Expression,
  bindingOf: (ordinal: number) => import('./Elaboration.js').BindingDeclarationFact | undefined,
  writtenBindings: ReadonlySet<number>,
  seen: ReadonlySet<Tir.Expression> = new Set(),
  allowUnmarked = false,
): StoredInvocationRecipe | undefined => {
  if (seen.has(expression) || expression._tag === 'Unavailable') return undefined
  const next = new Set(seen).add(expression)
  if (expression._tag === 'Move')
    return storedInvocationRecipe(
      expression.subject,
      bindingOf,
      writtenBindings,
      next,
      allowUnmarked,
    )
  if (expression._tag === 'BindingReference') {
    const binding = bindingOf(expression.binding.ordinal)
    return binding === undefined ||
      binding.mutability !== 'Immutable' ||
      writtenBindings.has(binding.id.ordinal)
      ? undefined
      : storedInvocationRecipe(binding.initializer, bindingOf, writtenBindings, next, allowUnmarked)
  }
  let type: Type.Callable | undefined
  if (Type.isCallable(expression.type)) type = expression.type
  else if (Type.isRepresented(expression.type) && Type.isCallable(expression.type.contract))
    type = expression.type.contract
  if (
    type === undefined ||
    (!allowUnmarked && type.invocationUse === undefined) ||
    Type.invocationInputBounds(type) === undefined
  )
    return undefined
  if (expression._tag === 'CallableSection') {
    const original =
      expression.invocationParameters ??
      (allowUnmarked && type.schema !== undefined
        ? Type.callableInputOrdinals(type.schema.contract)
        : undefined)
    if (
      original === undefined ||
      new Set(original).size !== original.length ||
      !original.every((parameter) => Number.isSafeInteger(parameter) && parameter >= 0)
    )
      return undefined
    const captures = expression.captures.filter((capture) =>
      original.includes(capture.parameterOrdinal),
    )
    const covered = [
      ...expression.remainingParameters,
      ...captures.map((capture) => capture.parameterOrdinal),
    ]
    if (
      covered.length !== original.length ||
      new Set(covered).size !== original.length ||
      !covered.every((parameter) => original.includes(parameter))
    )
      return undefined
    return {
      parameters: expression.remainingParameters,
      captures: captures.map((capture) => ({
        parameter: capture.parameterOrdinal,
        capture: capture.ordinal,
        expression: capture.value,
        leaf: expression.site,
      })),
    }
  }
  if (expression._tag === 'CallableApply' && expression.staged !== undefined) {
    const base = storedInvocationRecipe(
      expression.callee,
      bindingOf,
      writtenBindings,
      next,
      allowUnmarked,
    )
    const stage = expression.staged
    const count = expression.arguments.length
    if (
      base === undefined ||
      count === 0 ||
      count >= base.parameters.length ||
      stage.captures.length !== count ||
      type.parameters.length !== base.parameters.length - count
    )
      return undefined
    const captures: Array<StoredInvocationInput> = base.captures.map((capture) => ({
      ...capture,
      capturePath: [
        { _tag: 'Base', site: stage.site },
        ...(capture.capturePath ?? [
          { _tag: 'Capture', site: capture.leaf, ordinal: capture.capture },
        ]),
      ],
    }))
    for (const [ordinal, capture] of stage.captures.entries()) {
      const argument = expression.arguments.at(ordinal)
      const parameter = base.parameters.at(base.parameters.length - count + ordinal)
      if (
        argument === undefined ||
        argument._tag === 'Unavailable' ||
        parameter === undefined ||
        capture.ordinal !== ordinal ||
        capture.parameterOrdinal !== parameter ||
        AuthoredIdentity.anchorKey(capture.argument) !==
          AuthoredIdentity.anchorKey(argument.origin.anchor) ||
        !Type.equals(capture.type, argument.type)
      )
        return undefined
      captures.push({
        parameter,
        capture: capture.ordinal,
        expression: argument,
        leaf: stage.site,
        capturePath: [{ _tag: 'Capture', site: stage.site, ordinal: capture.ordinal }],
      })
    }
    if (new Set(captures.map((capture) => capture.parameter)).size !== captures.length)
      return undefined
    return { parameters: base.parameters.slice(0, base.parameters.length - count), captures }
  }
  if (expression._tag !== 'ParameterReference' && expression._tag !== 'FunctionItem')
    return undefined
  const adapter = type.schema?.invocationAdapter
  if (
    type.invocationUse !== undefined &&
    type.schema !== undefined &&
    !Type.invocationAdapterValid(type.invocationUse, type.parameters.length, type.schema)
  )
    return undefined
  return {
    parameters: adapter?.parameters ?? type.parameters.map((_, ordinal) => ordinal),
    captures: [],
  }
}

export const concreteCallableIdentity = (
  expression: ExpressionDecision,
  writtenBindings: ReadonlySet<number> = new Set(),
): boolean => {
  if (exactCallableOf(expression, writtenBindings) !== undefined) return true
  if (expression._tag === 'Move') {
    return expression.concreteCallableIdentity === true
  }
  if (expression._tag === 'Identifier' && expression.reference._tag === 'ResolvedBinding') {
    if (writtenBindings.has(expression.reference.binding.id.ordinal)) return false
    return expression.reference.binding.concreteCallableIdentity === true
  }
  return expression._tag === 'Call' && expression.reference._tag === 'Resolved'
}

export const callableMode = (captures: ReadonlyArray<CallableCaptureFact>): Type.CallableMode =>
  strongestEffectAccess(
    ...captures.flatMap((capture) => (capture.access === 'Copy' ? [] : [capture.access])),
  )

const availableConstructionTypes = (
  expressions: ReadonlyArray<ExpressionDecision | Tir.Expression>,
): ReadonlyArray<Type.Type> =>
  expressions.flatMap((expression) => {
    const type = constructionExpressionType(expression)
    return type._tag === 'Available' ? [type.type] : []
  })

export const sectionCallableType = (
  context: SemanticContext.SemanticContext,
  reference: Extract<
    CallReferenceFact,
    { readonly _tag: 'Resolved' | 'ResolvedBuiltin' | 'ResolvedIntrinsicContract' }
  >,
  substitution: Type.Substitution,
  mode: Type.CallableMode,
  captured: ReadonlyArray<number>,
  lifetimes: Type.ExecutableLifetimes | undefined,
): Type.Callable | undefined => {
  if (lifetimes === undefined) return undefined
  if (reference._tag === 'ResolvedBuiltin')
    return Type.callable(
      remainingOf(reference.parameters, captured).map((parameter) =>
        Type.substitute(parameter, substitution),
      ),
      Type.substitute(reference.result, substitution),
      lifetimes,
      mode,
      undefined,
      reference.unsafe,
    )
  const contract = resolvedCallableContract(reference)
  const result = contract?.result
  if (contract === undefined || result === undefined) return undefined
  const remaining = remainingOf(contract.parameters, captured)
  return Type.callable(
    remaining.map((parameter) => Type.substitute(parameter.type, substitution)),
    Type.substitute(result, substitution),
    {
      ...lifetimes,
      ...(contract.invocationUse === undefined
        ? {}
        : {
            invocationUse: {
              lifetime: contract.invocationUse.lifetime,
              parameters: remaining.map((_, ordinal) => ordinal),
            },
          }),
      lifetimeBinders: contract.lifetimeBinders.filter(
        (binder) => !substitution.has(Lifetime.key(binder)),
      ),
      lifetimeBounds: [
        ...(lifetimes.lifetimeBounds ?? []),
        ...contract.lifetimeBounds.map((bound) => ({
          longer: Type.substituteLifetime(bound.longer, substitution),
          shorter: Type.substituteLifetime(bound.shorter, substitution),
        })),
      ],
      typeOutlives: [
        ...(lifetimes.typeOutlives ?? []),
        ...contract.typeOutlives.map((bound) => ({
          type: Type.substitute(bound.type, substitution),
          lifetime: Type.substituteLifetime(bound.lifetime, substitution),
        })),
      ],
    },
    mode,
    contract.constraints.length === 0 && contract.binders.length === 0
      ? undefined
      : {
          ...(reference._tag === 'Resolved' && reference.declaration.canonical._tag === 'Canonical'
            ? { source: reference.declaration.canonical.id }
            : {}),
          contract,
          binders: contract.binders,
          constraints: contract.constraints,
          evidence: [],
          substitution,
          contractKey: CallableContract.key(contract),
          constraintKeys: contract.constraints.map(Constraint.key),
          evidenceKeys: [],
          origins: constraintOrigins(context, sourceCallable(reference)),
        },
    contract.unsafe,
  )
}

export const callableSectionOf = (
  expression: ExpressionDecision,
  writtenBindings: ReadonlySet<number> = new Set(),
): CallableSectionExpressionDecision | undefined => {
  const exact = exactCallableOf(expression, writtenBindings)
  return exact?._tag === 'CallableSection' ? exact : undefined
}

export function executableSite(
  tag: 'CallableSiteId',
  resolution: ResolutionContext,
  node: AuthoredHir.Expression,
): Tir.CallableSiteId
export function executableSite(
  tag: 'EffectSiteId',
  resolution: ResolutionContext,
  node: AuthoredHir.Expression,
): Tir.EffectSiteId
export function executableSite(
  tag: 'CallableSiteId' | 'EffectSiteId',
  resolution: ResolutionContext,
  node: AuthoredHir.Expression,
): Tir.CallableSiteId | Tir.EffectSiteId {
  if (resolution.builder === undefined)
    throw new RangeError('executable-site analysis requires its TIR body builder')
  const reference = BodyBuilder.expressionReference(resolution.builder, node.anchor)
  const anchorKey = AuthoredIdentity.anchorKey(node.anchor)
  const ordinal = resolution.executableSiteOrdinals?.get(anchorKey) ?? reference.node.ordinal
  const site = {
    _tag: tag,
    node: reference,
    functionOrdinal: resolution.executableFunction?.ordinal ?? 0,
    ...(resolution.executableOwner === undefined ? {} : { owner: resolution.executableOwner }),
  }
  return tag === 'CallableSiteId'
    ? {
        ...site,
        _tag: 'CallableSiteId',
        ordinal,
      }
    : { ...site, _tag: 'EffectSiteId', ordinal }
}

/**
 * Assigns executable-site ordinals in authored traversal order, keyed by anchor.
 *
 * The order is the one `$callable$N` and `Tir.anonymousCallableSite` count in, so it must stay a
 * preorder walk of the authored body. Grouped expressions are absent, so a pipeline's target is
 * reached directly.
 */
export const executableSites = (root: AuthoredHir.Block): ReadonlyMap<string, number> => {
  const sites = new Map<string, number>()
  const isAppliedInterfacePipeline = (node: AuthoredHir.Expression): boolean =>
    node._tag === 'PipelineExpression' && node.target._tag === 'MemberExpression'
  const record = (node: AuthoredHir.Expression): void => {
    const key = AuthoredIdentity.anchorKey(node.anchor)
    if (!sites.has(key)) sites.set(key, sites.size)
  }
  const visit = (node: AuthoredHir.Expression): void => {
    if (
      node._tag === 'CallExpression' ||
      node._tag === 'EffectExpression' ||
      node._tag === 'CallableExpression' ||
      isAppliedInterfacePipeline(node)
    )
      record(node)
    for (const child of AuthoredWalk.expressionChildren(node)) visit(child)
  }
  const roots = AuthoredWalk.statements(root).flatMap((statement) =>
    AuthoredWalk.statementExpressions(statement),
  )
  for (const expression of roots) visit(expression)
  // A bound method value is a section at a projection. Those sites follow every call site so the
  // ordinals of existing sites never move.
  const visitProjections = (node: AuthoredHir.Expression): void => {
    if (node._tag === 'FieldExpression') record(node)
    for (const child of AuthoredWalk.expressionChildren(node)) visitProjections(child)
  }
  for (const expression of roots) visitProjections(expression)
  return sites
}

export const executableSpecializationOwner = (
  resolution: ResolutionContext,
): Type.ExecutableSpecializationOwner | undefined => {
  const owner = resolution.executableOwner
  if (owner === undefined) return undefined
  const declaration = DeclarationFacts.byCanonical(resolution.index, owner)
  return declaration === undefined
    ? undefined
    : {
        declaration: { module: owner.module, name: owner.name },
        typeArguments: declaration.typeParameters.map((parameter) =>
          Type.parameterArgument(parameter.type),
        ),
        staticArgumentKeys: [],
      }
}

export const finishCallableSection = (
  context: SemanticContext.SemanticContext,
  node: AuthoredHir.Expression,
  reference: Extract<
    CallReferenceFact,
    { readonly _tag: 'Resolved' | 'ResolvedBuiltin' | 'ResolvedIntrinsicContract' }
  >,
  argumentsResult: ArgumentsResult,
  callTypeArguments: CallTypeArgumentsResult,
  resolution: ResolutionContext,
  caller: DeclarationFact,
  captured?: ReadonlyArray<number>,
  path: ReferencePathFact = referencePath(context, node),
): ExpressionResult => {
  const parameterCount =
    reference._tag === 'ResolvedBuiltin'
      ? reference.parameters.length
      : (resolvedCallableContract(reference)?.parameters.length ?? 0)
  const capturedParameters =
    captured ?? trailingCaptures(parameterCount, argumentsResult.facts.length)
  const contract = analyzeSectionContract(
    context,
    node,
    reference,
    argumentsResult.facts,
    callTypeArguments,
    capturedParameters,
    resolution,
  )
  const constraints = interfaceConstraints(
    context,
    reference,
    contract.substitution,
    resolution.index,
    caller,
    Location.at(node.anchor),
  )
  const captures = capturedParameters.map((parameterOrdinal, ordinal) => {
    const argument = argumentsResult.facts.at(ordinal)
    if (argument === undefined) throw new RangeError('section capture lost its argument')
    return {
      _tag: 'CallableCapture' as const,
      ordinal,
      parameterOrdinal,
      expression: argument.expression,
      access:
        ordinal === 0 &&
        reference._tag === 'ResolvedIntrinsicContract' &&
        reference.intrinsic.rule._tag === 'ContractRule' &&
        reference.intrinsic.rule.post === 'BindRequirement' &&
        reference.intrinsic.rule.providerMode === 'Take'
          ? ownedProviderCaptureAccess(
              argument.expression,
              resolution.index,
              copyAssumptionsOf(caller),
            )
          : captureAccess(argument.expression, resolution.index, copyAssumptionsOf(caller)),
    }
  })
  const mode = callableMode(captures)
  const callable = sectionCallableType(
    context,
    reference,
    contract.substitution,
    mode,
    capturedParameters,
    BodyLifetime.environment(
      resolution.bodyLifetimes,
      node.anchor,
      availableConstructionTypes(captures.map((capture) => capture.expression)),
      captures
        .filter((capture) => capture.access === 'Shared' || capture.access === 'Exclusive')
        .map((capture) => constructionExpressionAnchor(capture.expression)),
    ),
  )
  const foreign = foreignFirstClassDiagnostic(context, reference, node)
  const type =
    contract.valid && callable !== undefined && foreign === undefined
      ? availableExpressionType(callable)
      : unavailableExpressionType
  const environmentOwner = executableSpecializationOwner(resolution)
  const originalInvocationParameters =
    callable?.invocationUse === undefined
      ? undefined
      : resolvedCallableContract(reference)?.parameters.map((_, ordinal) => ordinal)
  return {
    fact: {
      _tag: 'CallableSection',
      selectedConformances: constraints.proofs,
      site: executableSite('CallableSiteId', resolution, node),
      ...(originalInvocationParameters === undefined
        ? {}
        : {
            invocationParameters: originalInvocationParameters,
          }),
      reference,
      path,
      remainingParameters: remainingOf(
        Array.from({ length: parameterCount }, (_, ordinal) => ordinal),
        capturedParameters,
      ),
      captures,
      retainedDependencies: captures.flatMap((capture) =>
        capture.access === 'Shared' || capture.access === 'Exclusive'
          ? [capture.parameterOrdinal]
          : [],
      ),
      typeArguments: contract.typeArguments,
      ...(environmentOwner === undefined ? {} : { environmentOwner }),
      substitution: contract.substitution,
      mode,
      type,
      anchor: node.anchor,
    },
    diagnostics: [
      ...argumentsResult.diagnostics,
      ...callTypeArguments.diagnostics,
      ...contract.diagnostics,
      ...constraints.diagnostics,
      ...(foreign === undefined ? [] : [foreign]),
    ],
    type: type._tag === 'Available' ? type.type : undefined,
  }
}

/** Admits an immutable stored value while preserving its evaluated producer and source type. */
const contextualStoredInvocation = (
  context: SemanticContext.SemanticContext,
  result: ExpressionResult,
  promised: Type.Callable,
  caller: DeclarationFact,
  resolution: ResolutionContext,
): ExpressionResult => {
  const fact = result.fact
  const builder = resolution.builder
  if (
    (fact._tag !== 'Identifier' && fact._tag !== 'Move') ||
    fact.type._tag !== 'Available' ||
    result.diagnostics.length !== 0 ||
    result.type === undefined ||
    builder === undefined ||
    !Type.isCallable(result.type) ||
    !Type.equals(result.type, fact.type.type) ||
    result.type.invocationUse !== undefined ||
    promised.invocationUse === undefined
  )
    return result
  const source = result.type
  const schema = source.schema
  const target = schema?.source
  const declaration =
    target === undefined
      ? undefined
      : DeclarationFacts.byCanonical(resolution.index, {
          _tag: 'CanonicalDeclarationId',
          ...target,
        })
  if (
    schema === undefined ||
    target === undefined ||
    declaration?._tag !== 'FunctionDeclaration' ||
    declaration.name._tag !== 'Present'
  )
    return result
  const targetName = declaration.name
  const contract = DeclarationFacts.callableContract(declaration)
  const originalInputs = Type.callableInputOrdinals(contract)
  if (
    originalInputs === undefined ||
    CallableContract.key(contract) !== schema.contractKey ||
    CallableContract.key(schema.contract) !== CallableContract.key(contract) ||
    schema.binders.length !== contract.binders.length ||
    !schema.binders.every((binder, ordinal) => {
      const original = contract.binders.at(ordinal)
      return original !== undefined && Type.key(original) === Type.key(binder)
    })
  )
    return result
  const written = resolution.writtenCallableBindings ?? new Set<number>()
  const knownBindings = resolution.execution?.context.bindings ?? []
  const bindingOf = (ordinal: number) => {
    const semantic = BodyBuilder.semanticOfLocal(builder, { _tag: 'TirLocal', ordinal })
    if (
      fact._tag === 'Identifier' &&
      fact.reference._tag === 'ResolvedBinding' &&
      fact.reference.binding === semantic
    )
      return fact.reference.binding
    return knownBindings.find((binding) => binding === semantic)
  }
  const operand =
    fact._tag === 'Move'
      ? fact.subject
      : (() => {
          if (fact.reference._tag !== 'ResolvedBinding') return undefined
          return fact.reference.binding.initializer
        })()
  if (operand === undefined) return result
  const recipe = storedInvocationRecipe(operand, bindingOf, written, new Set(), true)
  if (
    recipe === undefined ||
    recipe.parameters.length !== source.parameters.length ||
    [...recipe.parameters, ...recipe.captures.map((capture) => capture.parameter)].length !==
      originalInputs.length ||
    new Set([...recipe.parameters, ...recipe.captures.map((capture) => capture.parameter)]).size !==
      originalInputs.length ||
    [...recipe.parameters, ...recipe.captures.map((capture) => capture.parameter)].some(
      (ordinal) => !originalInputs.includes(ordinal),
    ) ||
    !recipe.parameters.every((original, ordinal) => {
      const input = contract.parameters.at(original)
      const actual = source.parameters.at(ordinal)
      return (
        input !== undefined &&
        actual !== undefined &&
        Type.equals(Type.substitute(input.type, schema.substitution), actual)
      )
    })
  )
    return result
  const producers: Array<Tir.StoredInvocationSource['producers'][number]> = []
  const seen = new Set<Tir.Expression>()
  const walk = (expression: Tir.Expression): boolean => {
    if (seen.has(expression) || expression._tag === 'Unavailable') return false
    seen.add(expression)
    if (expression._tag === 'Move') return walk(expression.subject)
    const producer = (
      kind: Tir.StoredInvocationSource['producers'][number]['kind'],
      binding?: Tir.LocalId,
    ) => {
      if (expression.origin._tag !== 'Authored') return false
      producers.push({
        node: Tir.nodeReference(builder.artifact, expression),
        origin: expression.origin.anchor,
        kind,
        ...(binding === undefined ? {} : { binding }),
      })
      return true
    }
    if (expression._tag === 'BindingReference') {
      const binding = bindingOf(expression.binding.ordinal)
      return (
        binding !== undefined &&
        binding.mutability === 'Immutable' &&
        !written.has(binding.id.ordinal) &&
        producer('Binding', expression.binding) &&
        walk(binding.initializer)
      )
    }
    if (expression._tag === 'CallableApply' && expression.staged !== undefined)
      return producer('Stage') && walk(expression.callee)
    if (expression._tag !== 'CallableSection' && expression._tag !== 'FunctionItem') return false
    const leaf = expression.type.schema
    return (
      leaf?.source?.module === target.module &&
      leaf.source.name === target.name &&
      CallableContract.key(leaf.contract) === CallableContract.key(contract) &&
      expression.target._tag === 'DeclarationCallableTarget' &&
      expression.target.declaration.module === target.module &&
      expression.target.declaration.name === target.name &&
      producer(expression._tag === 'CallableSection' ? 'Section' : 'FunctionItem')
    )
  }
  if (fact._tag === 'Identifier') {
    if (
      fact.reference._tag !== 'ResolvedBinding' ||
      fact.reference.binding.mutability !== 'Immutable' ||
      written.has(fact.reference.binding.id.ordinal)
    )
      return result
    producers.push({
      node: BodyBuilder.expressionReference(builder, fact.anchor),
      origin: fact.anchor,
      kind: 'Binding',
      binding: BodyBuilder.localId(builder, fact.reference.binding.id),
    })
  }
  if (!walk(operand)) return result
  let compatibility = resolution.lifetimeCompatibility ?? TypeCompatibility.context()
  if (source.environment._tag !== 'StaticLifetime') {
    const formation = resolution.bodyLifetimes?.formations.get(Lifetime.key(source.environment))
    if (
      formation === undefined ||
      !producers.some(
        (producer) =>
          AuthoredIdentity.anchorKey(producer.origin) ===
          AuthoredIdentity.anchorKey(formation.origin),
      ) ||
      !Lifetime.equals(formation.environment, source.environment) ||
      formation.lifetimeBounds.some(
        (bound) => !Lifetime.equals(bound.shorter, source.environment),
      ) ||
      formation.typeOutlives.some((bound) => !Lifetime.equals(bound.lifetime, source.environment))
    )
      return result
    compatibility = {
      ...compatibility,
      typeBounds: [...compatibility.typeBounds, ...formation.typeOutlives],
      assumptions: Lifetime.mergeAssumptions(
        compatibility.assumptions,
        Lifetime.assumptions(formation.lifetimeBounds),
      ),
    }
  }
  const consumer = resolution.invocationConsumer
  const selected = TypeCompatibility.commitWhen(
    compatibility,
    () => {
      const adapted = TypeInference.adaptInvocationCallable(
        source,
        promised,
        schema.binders,
        schema.substitution,
        compatibility,
        consumer?.caller.sourceId === caller.id.sourceId &&
          consumer.caller.ordinal === caller.id.ordinal
          ? consumer
          : undefined,
        recipe.parameters,
      )
      if (
        adapted === undefined ||
        adapted.callable.schema === undefined ||
        !Type.invocationAdapterValid(
          adapted.callable.invocationUse,
          source.parameters.length,
          adapted.callable.schema,
        )
      )
        return undefined
      const constraints = interfaceConstraints(
        context,
        { _tag: 'Resolved', spelling: targetName.spelling, anchor: targetName.anchor, declaration },
        adapted.callable.schema.substitution,
        resolution.index,
        caller,
        Location.at(fact.anchor),
      )
      if (constraints.diagnostics.length !== 0) return undefined
      const invocationSource: Tir.StoredInvocationSource = {
        target: { _tag: 'CanonicalDeclarationId', ...target },
        producers,
        originalInputs,
        parameters: recipe.parameters,
        captures: recipe.captures.map((capture) => ({
          parameter: capture.parameter,
          capture: capture.capture,
          expression: Tir.nodeReference(builder.artifact, capture.expression),
          leaf: capture.leaf,
          ...(capture.capturePath === undefined ? {} : { capturePath: capture.capturePath }),
        })),
        originalSubstitution: new Map(schema.substitution),
        selected: adapted.callable,
      }
      return {
        ...result,
        fact: {
          ...fact,
          originalType: source,
          invocationSource,
          type: availableExpressionType(adapted.callable),
        },
        type: adapted.callable,
      }
    },
    (selected) => selected !== undefined,
  )
  return selected ?? result
}

/** Admits one already formed named section under the actual contextual use contract. */
export const contextualInvocationSection = (
  context: SemanticContext.SemanticContext,
  result: ExpressionResult,
  expected: SemanticType | undefined,
  caller: DeclarationFact,
  resolution: ResolutionContext,
): ExpressionResult => {
  const fact = result.fact
  const promised =
    expected !== undefined && Type.isRepresented(expected) ? expected.contract : expected
  if (
    promised !== undefined &&
    Type.isCallable(promised) &&
    promised.invocationUse !== undefined &&
    (fact._tag === 'Identifier' || fact._tag === 'Move')
  )
    return contextualStoredInvocation(context, result, promised, caller, resolution)
  if (
    fact._tag !== 'CallableSection' ||
    fact.type._tag !== 'Available' ||
    result.type === undefined ||
    !Type.isCallable(fact.type.type) ||
    !Type.equals(fact.type.type, result.type) ||
    fact.type.type.invocationUse !== undefined ||
    promised === undefined ||
    !Type.isCallable(promised) ||
    promised.invocationUse === undefined ||
    result.diagnostics.length !== 0 ||
    fact.reference._tag !== 'Resolved' ||
    fact.reference.declaration.canonical._tag !== 'Canonical'
  )
    return result
  const source = fact.type.type
  const schema = source.schema
  const contract = resolvedCallableContract(fact.reference)
  const canonical = fact.reference.declaration.canonical.id
  const provenance = schema?.source
  const originalInputs = contract === undefined ? undefined : Type.callableInputOrdinals(contract)
  if (
    schema === undefined ||
    contract === undefined ||
    originalInputs === undefined ||
    provenance === undefined ||
    provenance.module !== canonical.module ||
    provenance.name !== canonical.name ||
    schema.contractKey !== CallableContract.key(contract) ||
    CallableContract.key(schema.contract) !== CallableContract.key(contract) ||
    schema.binders.length !== contract.binders.length ||
    !schema.binders.every((binder, ordinal) => {
      const original = contract.binders.at(ordinal)
      return original !== undefined && Type.key(binder) === Type.key(original)
    }) ||
    schema.substitution.size !== fact.substitution.size ||
    ![...fact.substitution].every(([identity, argument]) => {
      const retained = schema.substitution.get(identity)
      return retained !== undefined && Type.equalsGenericArgument(argument, retained)
    }) ||
    source.parameters.length !== fact.remainingParameters.length ||
    fact.mode !== source.mode ||
    fact.captures.some(
      (capture, ordinal) =>
        capture.ordinal !== ordinal ||
        !originalInputs.includes(capture.parameterOrdinal) ||
        constructionExpressionType(capture.expression)._tag !== 'Available',
    )
  )
    return result
  const partition = [
    ...fact.remainingParameters,
    ...fact.captures.map((capture) => capture.parameterOrdinal),
  ]
  if (
    partition.length !== originalInputs.length ||
    new Set(partition).size !== partition.length ||
    partition.some((ordinal) => !originalInputs.includes(ordinal)) ||
    !fact.remainingParameters.every((original, ordinal) => {
      const parameter = contract.parameters.at(original)
      const visible = source.parameters.at(ordinal)
      return (
        parameter !== undefined &&
        visible !== undefined &&
        Type.equals(Type.substitute(parameter.type, fact.substitution), visible)
      )
    })
  )
    return result
  const base = resolution.lifetimeCompatibility ?? TypeCompatibility.context()
  let compatibility = base
  if (source.environment._tag !== 'StaticLifetime') {
    const body = resolution.bodyLifetimes
    const formation = body?.formations.get(Lifetime.key(source.environment))
    if (
      body === undefined ||
      formation === undefined ||
      AuthoredIdentity.anchorKey(formation.origin) !== AuthoredIdentity.anchorKey(fact.anchor) ||
      !Lifetime.equals(formation.environment, source.environment) ||
      formation.lifetimeBounds.some(
        (bound) => !Lifetime.equals(bound.shorter, source.environment),
      ) ||
      formation.typeOutlives.some((bound) => !Lifetime.equals(bound.lifetime, source.environment))
    )
      return result
    // Only this actual capture construction supplies Γ; original target bounds stay goals.
    // Its registered obligations still pass the body's lifetime/ownership gates before MIR.
    compatibility = {
      ...base,
      typeBounds: [...base.typeBounds, ...formation.typeOutlives],
      assumptions: Lifetime.mergeAssumptions(
        base.assumptions,
        Lifetime.assumptions(formation.lifetimeBounds),
      ),
    }
  }
  const consumer = resolution.invocationConsumer
  const selected = TypeCompatibility.commitWhen(
    compatibility,
    () => {
      const adapted = TypeInference.adaptInvocationCallable(
        source,
        promised,
        schema.binders,
        fact.substitution,
        compatibility,
        consumer?.caller.sourceId === caller.id.sourceId &&
          consumer.caller.ordinal === caller.id.ordinal
          ? consumer
          : undefined,
        fact.remainingParameters,
      )
      if (adapted === undefined || adapted.callable.schema === undefined) return undefined
      const substitution = adapted.callable.schema.substitution
      const typeArguments: Array<Type.GenericArgument> = []
      for (const binder of contract.binders) {
        const argument = substitution.get(Type.key(binder))
        if (argument === undefined) return undefined
        typeArguments.push(argument)
      }
      if (
        !Type.invocationAdapterValid(
          adapted.callable.invocationUse,
          source.parameters.length,
          adapted.callable.schema,
        )
      )
        return undefined
      const constraints = interfaceConstraints(
        context,
        fact.reference,
        substitution,
        resolution.index,
        caller,
        Location.at(fact.anchor),
      )
      if (constraints.diagnostics.length > 0)
        return {
          accepted: false,
          result: { ...result, diagnostics: [...result.diagnostics, ...constraints.diagnostics] },
        }
      const type = availableExpressionType(adapted.callable)
      return {
        accepted: true,
        result: {
          ...result,
          fact: {
            ...fact,
            selectedConformances: constraints.proofs,
            type,
            substitution,
            typeArguments,
            invocationParameters: Array.from(originalInputs),
          },
          type: adapted.callable,
        },
      }
    },
    (selected) => selected?.accepted === true,
  )
  return selected?.result ?? result
}

export const finishCallableApplication = (
  context: SemanticContext.SemanticContext,
  node: AuthoredHir.Expression,
  callee: ExpressionResult,
  argumentsResult: ArgumentsResult,
  callTypeArguments: CallTypeArgumentsResult,
  provenance?: CallableApplyExpressionDecision['provenance'],
  resolution?: ResolutionContext,
  caller?: DeclarationFact,
): ExpressionResult => {
  if (callee.type !== undefined && Type.isForeignFunction(callee.type)) {
    const contract = callee.type
    const selected = selectedCallLifetimes(node, contract.lifetimeBinders, resolution)
    const inferred = new Map(selected.substitution)
    const diagnostics = [
      ...callee.diagnostics,
      ...argumentsResult.diagnostics,
      ...callTypeArguments.diagnostics,
    ]
    const unsafe = unsafeCallDiagnostic(
      true,
      Type.encode(contract),
      node,
      context.spanOf(node.anchor),
      resolution,
    )
    if (unsafe !== undefined) diagnostics.push(unsafe)
    if (callTypeArguments.explicit)
      diagnostics.push(
        Diagnostic.typeArgumentArity(
          'native function pointer',
          0,
          callTypeArguments.facts.length,
          Location.at(node.anchor),
        ),
      )
    if (contract.parameters.length !== argumentsResult.facts.length)
      diagnostics.push(
        Diagnostic.wrongCallArity(
          { _tag: 'BuiltinTarget', actor: 'Foreign', operation: 'Apply' },
          contract.parameters.length,
          argumentsResult.facts.length,
          Location.at(node.anchor),
        ),
      )
    for (const [ordinal, argument] of argumentsResult.facts.entries()) {
      const expected = contract.parameters.at(ordinal)
      if (
        expected !== undefined &&
        argument.type._tag === 'Available' &&
        (!TypeInference.infer(expected, argument.type.type, inferred, selected.inference) ||
          !typesCompatible(
            argument.type.type,
            Type.substitute(expected, inferred),
            selected.compatibility,
          ))
      )
        diagnostics.push(
          Diagnostic.argumentTypeMismatch(
            Type.encode(expected),
            Type.encode(argument.type.type),
            Location.at(argument.anchor),
          ),
        )
    }
    diagnostics.push(
      ...selectedLifetimeBoundDiagnostics(
        contract.lifetimeBounds ?? [],
        inferred,
        selected.compatibility,
        Location.at(node.anchor),
        contract.typeOutlives ?? [],
      ),
    )
    const valid =
      diagnostics.length === 0 &&
      argumentsResult.facts.every((argument) => argument.type._tag === 'Available')
    return {
      fact: {
        _tag: 'ForeignApply',
        evaluation:
          provenance?._tag === 'PipelineCallableApplication'
            ? 'LeftThenCallable'
            : 'CalleeThenArguments',
        callee: expressionNode(callee),
        arguments: argumentsResult.facts,
        contract,
        type: valid ? availableExpressionType(contract.result) : unavailableExpressionType,
        anchor: node.anchor,
      },
      diagnostics,
      type: valid ? contract.result : undefined,
    }
  }
  let callable: Type.Callable | undefined
  if (callee.type !== undefined && Type.isCallable(callee.type)) {
    callable = callee.type
  } else if (
    callee.type !== undefined &&
    Type.isRepresented(callee.type) &&
    Type.isCallable(callee.type.contract)
  ) {
    callable = callee.type.contract
  } else {
    callable = undefined
  }
  const diagnostics: Array<Diagnostic.Located> = [
    ...callee.diagnostics,
    ...argumentsResult.diagnostics,
    ...callTypeArguments.diagnostics,
  ]
  const writtenBindings = resolution?.writtenCallableBindings ?? new Set<number>()
  const exactCallable = exactCallableOf(callee.fact, writtenBindings)
  const section = exactCallable?._tag === 'CallableSection' ? exactCallable : undefined
  const directSection = callee.fact._tag === 'CallableSection' ? callee.fact : undefined
  const recipeBindings = new Map(
    (resolution?.execution?.context.bindings ?? []).map(
      (binding) => [binding.id.ordinal, binding] as const,
    ),
  )
  if (callee.fact._tag === 'Identifier' && callee.fact.reference._tag === 'ResolvedBinding')
    recipeBindings.set(callee.fact.reference.binding.id.ordinal, callee.fact.reference.binding)
  const storedRecipe =
    callable?.invocationUse === undefined
      ? undefined
      : storedInvocationRecipe(
          expressionNode(callee),
          (ordinal) => {
            const builder = resolution?.builder
            if (builder === undefined) return undefined
            const semantic = BodyBuilder.semanticOfLocal(builder, { _tag: 'TirLocal', ordinal })
            // Semantic binding ordinals and unified TIR local ordinals are distinct namespaces.
            return [...recipeBindings.values()].find((binding) => binding === semantic)
          },
          writtenBindings,
        )
  const stagedSection =
    directSection !== undefined &&
    callable !== undefined &&
    argumentsResult.facts.length > 0 &&
    argumentsResult.facts.length < callable.parameters.length &&
    resolution !== undefined &&
    caller !== undefined
      ? directSection
      : undefined
  // A proper trailing suffix supplied to a callable value stages a further section over that
  // value (CALLABLE-002); the value's own environment is spliced ahead of these captures.
  const stagedValue =
    directSection === undefined &&
    callable !== undefined &&
    argumentsResult.facts.length > 0 &&
    argumentsResult.facts.length < callable.parameters.length &&
    resolution !== undefined &&
    caller !== undefined
      ? {
          site: executableSite('CallableSiteId', resolution, node),
          captures: argumentsResult.facts.flatMap((argument, ordinal) => {
            const position = callable.parameters.length - argumentsResult.facts.length + ordinal
            const parameterOrdinal =
              callable.invocationUse === undefined
                ? (callable.schema?.invocationAdapter?.parameters.at(position) ??
                  section?.remainingParameters.at(position) ??
                  position)
                : storedRecipe?.parameters.at(position)
            return parameterOrdinal === undefined
              ? []
              : [
                  {
                    _tag: 'CallableCapture' as const,
                    ordinal,
                    parameterOrdinal,
                    expression: argument.expression,
                    access: captureAccess(
                      argument.expression,
                      resolution.index,
                      copyAssumptionsOf(caller),
                    ),
                  },
                ]
          }),
        }
      : undefined
  const formationCaptures =
    stagedSection !== undefined && resolution !== undefined && caller !== undefined
      ? [
          ...stagedSection.captures,
          ...argumentsResult.facts.map((argument) => ({
            expression: argument.expression,
            access: captureAccess(argument.expression, resolution.index, copyAssumptionsOf(caller)),
          })),
        ]
      : stagedValue?.captures
  // This one actual formation environment is used only for stored-parameter checking and
  // published as the section's environment. The future invocation binder stays unselected.
  const stagedFormation =
    formationCaptures === undefined || callable === undefined
      ? undefined
      : BodyLifetime.environment(
          resolution?.bodyLifetimes,
          node.anchor,
          [
            callable,
            ...availableConstructionTypes(formationCaptures.map((capture) => capture.expression)),
            ...(storedRecipe?.captures.flatMap((capture) =>
              capture.expression._tag === 'Unavailable' ? [] : [capture.expression.type],
            ) ?? []),
          ],
          formationCaptures
            .filter((capture) => capture.access === 'Shared' || capture.access === 'Exclusive')
            .map((capture) => constructionExpressionAnchor(capture.expression)),
        )
  const schema = callable?.schema
  const staged = stagedSection !== undefined || stagedValue !== undefined
  const capturedLifetimeKeys = new Set(
    staged
      ? (callable?.parameters.slice(-argumentsResult.facts.length) ?? []).flatMap((parameter) =>
          Type.storageLifetimes(parameter).map(Lifetime.key),
        )
      : [],
  )
  const callLifetimes = selectedCallLifetimes(
    node,
    (callable?.lifetimeBinders ?? []).filter(
      (binder) =>
        !staged ||
        (capturedLifetimeKeys.has(Lifetime.key(binder)) &&
          (callable?.invocationUse === undefined ||
            !Lifetime.equals(binder, callable.invocationUse.lifetime))),
    ),
    resolution,
    schema?.substitution ?? section?.substitution,
    callable?.invocationUse?.lifetime._tag === 'BoundLifetime'
      ? callable.invocationUse.lifetime
      : undefined,
  )
  const inferred = new Map<string, Type.GenericArgument>(callLifetimes.substitution)
  let evidence: ReadonlyArray<Constraint.ConstraintEvidence> = []
  let inferredProviderSelectors: ReadonlyArray<InferredProviderSelector> = []
  let valid =
    callable !== undefined &&
    (node._tag === 'PipelineExpression'
      ? AuthoredWalk.isAvailable(node)
      : hasAvailableCallSyntax(node))
  if (callable?.invocationUse !== undefined && storedRecipe === undefined) {
    diagnostics.push(
      Diagnostic.invalidLifetimeBinder(
        'Invocation-use callable has no authenticated stored input recipe',
        Location.at(node.anchor),
      ),
    )
    valid = false
  }
  if (callable === undefined && callee.type !== undefined) {
    diagnostics.push(
      Diagnostic.nonCallableApplication(Type.encode(callee.type), Location.at(callee.fact.anchor)),
    )
  }

  if (
    callable?.mode === 'Exclusive' &&
    callee.fact._tag === 'Identifier' &&
    callee.fact.reference._tag === 'ResolvedBinding' &&
    callee.fact.reference.binding.mutability !== 'Mutable'
  ) {
    diagnostics.push(
      Diagnostic.invalidCallableInvocationAccess('Exclusive', Location.at(callee.fact.anchor)),
    )
    valid = false
  }
  if (
    schema !== undefined &&
    schema.source === undefined &&
    !concreteCallableIdentity(callee.fact, writtenBindings)
  ) {
    diagnostics.push(
      Diagnostic.nonConcreteSpecialization('constrained callable', Location.at(node.anchor)),
    )
    valid = false
  }
  if (callTypeArguments.explicit) {
    diagnostics.push(
      Diagnostic.typeArgumentArity(
        'callable value',
        0,
        callTypeArguments.facts.length,
        Location.at(node.anchor),
      ),
    )
    valid = false
  }
  if (
    callable !== undefined &&
    callable.parameters.length !== argumentsResult.facts.length &&
    stagedSection === undefined &&
    stagedValue === undefined
  ) {
    diagnostics.push(
      Diagnostic.wrongCallArity(
        { _tag: 'BuiltinTarget', actor: 'Callable', operation: 'Apply' },
        callable.parameters.length,
        argumentsResult.facts.length,
        Location.at(node.anchor),
      ),
    )
    valid = false
  }
  const completeUnsafeInvocation =
    callable !== undefined &&
    callable.unsafe === true &&
    stagedSection === undefined &&
    callable.parameters.length === argumentsResult.facts.length
  if (completeUnsafeInvocation && callable !== undefined) {
    const diagnostic = unsafeCallDiagnostic(
      true,
      Type.encode(callable),
      node,
      context.spanOf(node.anchor),
      resolution,
    )
    if (diagnostic !== undefined) {
      diagnostics.push(diagnostic)
      valid = false
    }
  }
  if (callable !== undefined) {
    const parameterOffset =
      stagedSection === undefined && stagedValue === undefined
        ? 0
        : callable.parameters.length - argumentsResult.facts.length
    for (const [ordinal, argument] of argumentsResult.facts.entries()) {
      const original = callable.parameters.at(parameterOffset + ordinal)
      let expected = original
      if (callable.invocationUse !== undefined && formationCaptures !== undefined) {
        if (stagedFormation === undefined) expected = undefined
        else
          expected = TypeInference.stagedInvocationParameter(
            callable,
            parameterOffset + ordinal,
            stagedFormation,
          )
      }
      if (expected === undefined || argument.type._tag !== 'Available') {
        if (callable.invocationUse !== undefined && formationCaptures !== undefined)
          diagnostics.push(
            Diagnostic.invalidLifetimeBinder(
              'Staged invocation input has no valid formation environment',
              Location.at(argument.anchor),
            ),
          )
        valid = false
        continue
      }
      if (!TypeInference.infer(expected, argument.type.type, inferred, callLifetimes.inference)) {
        const rowFailure = TypeInference.inferenceFailure(
          expected,
          argument.type.type,
          inferred,
          callLifetimes.inference,
        )
        if (Type.isForeignFunction(expected) && !Type.isForeignFunction(argument.type.type)) {
          diagnostics.push(
            Diagnostic.invalidForeignCallback(
              Type.encode(argument.type.type),
              'capturing and anonymous Silk callables do not have an exported C address',
              Location.at(argument.anchor),
            ),
          )
        } else if (rowFailure !== undefined) {
          diagnostics.push(Diagnostic.inferenceFailure(rowFailure, Location.at(argument.anchor)))
        } else if (Type.isCallable(expected) && Type.isCallable(argument.type.type)) {
          diagnostics.push(
            Diagnostic.incompatibleCallableSignature(
              Type.encode(expected),
              Type.encode(argument.type.type),
              Location.at(argument.anchor),
            ),
          )
        } else {
          diagnostics.push(
            Diagnostic.argumentTypeMismatch(
              Type.encode(expected),
              Type.encode(argument.type.type),
              Location.at(argument.anchor),
            ),
          )
        }
        valid = false
        continue
      }
      const specialized = Type.substitute(expected, inferred)
      if (
        Type.isConcrete(specialized) &&
        !typesCompatible(argument.type.type, specialized, callLifetimes.compatibility)
      ) {
        let mismatch: Diagnostic.Located
        if (Type.isForeignFunction(specialized) && !Type.isForeignFunction(argument.type.type))
          mismatch = Diagnostic.invalidForeignCallback(
            Type.encode(argument.type.type),
            'capturing and anonymous Silk callables do not have an exported C address',
            Location.at(argument.anchor),
          )
        else if (Type.isCallable(specialized) && Type.isCallable(argument.type.type))
          mismatch = Diagnostic.incompatibleCallableSignature(
            Type.encode(specialized),
            Type.encode(argument.type.type),
            Location.at(argument.anchor),
          )
        else
          mismatch = Diagnostic.argumentTypeMismatch(
            Type.encode(specialized),
            Type.encode(argument.type.type),
            Location.at(argument.anchor),
          )
        diagnostics.push(mismatch)
        valid = false
      }
    }
  }
  if (callable !== undefined) {
    const deferred = new Set(
      staged
        ? callable.lifetimeBinders
            .filter((binder) => !inferred.has(Lifetime.key(binder)))
            .map(Lifetime.key)
        : [],
    )
    const awaitsUse = (region: Lifetime.Lifetime): boolean =>
      Lifetime.atoms(Type.substituteLifetime(region, inferred)).some((atom) =>
        deferred.has(Lifetime.key(atom)),
      )
    const lifetimeDiagnostics = selectedLifetimeBoundDiagnostics(
      callable.lifetimeBounds.filter(
        (bound) => !awaitsUse(bound.longer) && !awaitsUse(bound.shorter),
      ),
      inferred,
      callLifetimes.compatibility,
      Location.at(node.anchor),
      callable.typeOutlives.filter((bound) => !awaitsUse(bound.lifetime)),
    )
    diagnostics.push(...lifetimeDiagnostics)
    if (lifetimeDiagnostics.length !== 0) valid = false
  }
  const stagedCaptures =
    stagedSection === undefined || resolution === undefined || caller === undefined
      ? undefined
      : [
          ...stagedSection.captures,
          ...argumentsResult.facts.map((argument, ordinal) => {
            const remainingOffset =
              stagedSection.remainingParameters.length - argumentsResult.facts.length
            const parameterOrdinal = stagedSection.remainingParameters.at(remainingOffset + ordinal)
            if (parameterOrdinal === undefined)
              throw new RangeError('staged callable section lost a remaining parameter')
            return {
              _tag: 'CallableCapture' as const,
              ordinal: stagedSection.captures.length + ordinal,
              parameterOrdinal,
              expression: argument.expression,
              access: captureAccess(
                argument.expression,
                resolution.index,
                copyAssumptionsOf(caller),
              ),
            }
          }),
        ]
  if (
    valid &&
    (schema !== undefined || section !== undefined) &&
    resolution !== undefined &&
    (schema?.constraints.length ??
      (section === undefined
        ? 0
        : resolvedCallableContract(section.reference)?.constraints.length) ??
      0) > 0
  ) {
    const sectionContract =
      schema === undefined && section !== undefined
        ? resolvedCallableContract(section.reference)
        : undefined
    const constraints = schema?.constraints ?? sectionContract?.constraints
    if (constraints === undefined) throw new RangeError('section lost its callable contract')
    const solved = solveCallableConstraints(
      constraints,
      schema?.origins ??
        (section === undefined
          ? []
          : constraintOrigins(context, sourceCallable(section.reference))),
      inferred,
      caller,
      resolution,
      Location.at(node.anchor),
    )
    inferred.clear()
    for (const [identity, argument] of solved.substitution) inferred.set(identity, argument)
    evidence = [...(schema?.evidence ?? []), ...solved.evidence]
    inferredProviderSelectors = solved.inferredProviderSelectors
    diagnostics.push(...solved.diagnostics)
    if (solved.diagnostics.length > 0) valid = false
  }
  const schemaDeclaration =
    schema?.source === undefined || resolution === undefined
      ? undefined
      : DeclarationFacts.byCanonical(resolution.index, {
          _tag: 'CanonicalDeclarationId',
          ...schema.source,
        })
  let sourceTarget: Extract<CallReferenceFact, { readonly _tag: 'Resolved' }> | undefined
  if (exactCallable?.reference._tag === 'Resolved') sourceTarget = exactCallable.reference
  else if (
    schemaDeclaration?._tag === 'FunctionDeclaration' &&
    schemaDeclaration.name._tag === 'Present'
  )
    sourceTarget = {
      _tag: 'Resolved',
      spelling: schemaDeclaration.name.spelling,
      anchor: schemaDeclaration.name.anchor,
      declaration: schemaDeclaration,
    }
  const selectedConformances =
    sourceTarget === undefined || resolution === undefined || caller === undefined
      ? { diagnostics: [], proofs: [] }
      : interfaceConstraints(
          context,
          sourceTarget,
          inferred,
          resolution.index,
          caller,
          Location.at(node.anchor),
        )
  diagnostics.push(...selectedConformances.diagnostics)
  if (selectedConformances.diagnostics.length > 0) valid = false
  let invocationUse: Tir.InvocationUseObligation | undefined
  if (
    valid &&
    callable?.invocationUse !== undefined &&
    stagedSection === undefined &&
    stagedValue === undefined
  ) {
    const usage = callable.invocationUse
    const body = resolution?.bodyLifetimes
    const lifetime = inferred.get(Lifetime.key(usage.lifetime))
    const binderOrdinal = callable.lifetimeBinders.findIndex((binder) =>
      Lifetime.equals(binder, usage.lifetime),
    )
    const genuineRegion =
      body === undefined || binderOrdinal < 0 || usage.lifetime._tag !== 'BoundLifetime'
        ? undefined
        : BodyLifetime.invocationRegion(body, node.anchor, usage.lifetime)
    const originalParameters = storedRecipe?.parameters
    const capturedInputs = (storedRecipe?.captures ?? []).flatMap((capture) => {
      const actual = capture.expression
      return actual._tag === 'Unavailable'
        ? []
        : [
            {
              parameter: capture.parameter,
              capture: capture.capture,
              ...(capture.capturePath === undefined ? {} : { capturePath: capture.capturePath }),
              argument: actual.origin.anchor,
              type: actual.type,
            },
          ]
    })
    const visibleInputs = argumentsResult.facts.flatMap((argument, ordinal) => {
      const actual = constructionExpressionType(argument.expression)
      const parameter = originalParameters?.at(ordinal)
      return actual._tag !== 'Available' || parameter === undefined
        ? []
        : [
            {
              parameter,
              argument: constructionExpressionAnchor(argument.expression),
              type: actual.type,
            },
          ]
    })
    const inputs = [...capturedInputs, ...visibleInputs]
    if (
      Type.invocationInputBounds(callable) === undefined ||
      usage.lifetime._tag !== 'BoundLifetime' ||
      body === undefined ||
      lifetime === undefined ||
      !Lifetime.isLifetime(lifetime) ||
      lifetime._tag !== 'LocalLifetime' ||
      genuineRegion === undefined ||
      !Lifetime.equals(lifetime, genuineRegion) ||
      visibleInputs.length !== callable.parameters.length ||
      capturedInputs.length !== (storedRecipe?.captures.length ?? 0) ||
      new Set(inputs.map((input) => input.parameter)).size !== inputs.length
    ) {
      diagnostics.push(
        Diagnostic.typeArgumentInference('invocation-use region', Location.at(node.anchor)),
      )
      valid = false
    } else {
      invocationUse = {
        owner: body.owner,
        origin: node.anchor,
        binder: usage.lifetime,
        lifetime,
        inputs,
      }
    }
  }
  const stagedContract = (
    mode: Type.CallableMode,
    selectedSchema: Type.CallableSchema | undefined,
  ): Type.Callable | undefined => {
    if (callable === undefined || stagedFormation === undefined) return undefined
    const remaining = callable.parameters.length - argumentsResult.facts.length
    const adapter = callable.schema?.invocationAdapter
    const schema =
      selectedSchema === undefined
        ? undefined
        : {
            ...selectedSchema,
            substitution: new Map([...selectedSchema.substitution, ...inferred]),
            ...(adapter === undefined
              ? {}
              : {
                  invocationAdapter: {
                    ...adapter,
                    parameters: adapter.parameters.slice(0, remaining),
                  },
                }),
          }
    return Type.callable(
      callable.parameters
        .slice(0, remaining)
        .map((parameter) => Type.substitute(parameter, inferred)),
      Type.substitute(callable.result, inferred),
      {
        ...stagedFormation,
        lifetimeBinders: callable.lifetimeBinders.filter(
          (binder) => !inferred.has(Lifetime.key(binder)),
        ),
        lifetimeBounds: [
          ...(stagedFormation.lifetimeBounds ?? []),
          ...callable.lifetimeBounds.map((bound) => ({
            longer: Type.substituteLifetime(bound.longer, inferred),
            shorter: Type.substituteLifetime(bound.shorter, inferred),
          })),
        ],
        typeOutlives: [
          ...(stagedFormation.typeOutlives ?? []),
          ...callable.typeOutlives.map((bound) => ({
            type: Type.substitute(bound.type, inferred),
            lifetime: Type.substituteLifetime(bound.lifetime, inferred),
          })),
        ],
        ...(callable.invocationUse === undefined
          ? {}
          : {
              invocationUse: {
                lifetime: callable.invocationUse.lifetime,
                parameters: Array.from({ length: remaining }, (_, ordinal) => ordinal),
              },
            }),
      },
      mode,
      schema,
      callable.unsafe,
    )
  }
  const type = (() => {
    if (!valid || callable === undefined) return unavailableExpressionType
    if (stagedSection !== undefined && stagedCaptures !== undefined) {
      const reference = stagedSection.reference
      if (
        reference._tag !== 'Resolved' &&
        reference._tag !== 'ResolvedBuiltin' &&
        reference._tag !== 'ResolvedIntrinsicContract'
      )
        return unavailableExpressionType
      const sectionType = sectionCallableType(
        context,
        reference,
        inferred,
        callableMode(stagedCaptures),
        stagedCaptures.map((capture) => capture.parameterOrdinal),
        stagedFormation,
      )
      let retained: typeof sectionType
      if (sectionType !== undefined) {
        if (callable.invocationUse === undefined) retained = sectionType
        else
          retained = stagedContract(
            strongestEffectAccess(callable.mode, callableMode(stagedCaptures)),
            sectionType.schema,
          )
      }
      return retained === undefined ? unavailableExpressionType : availableExpressionType(retained)
    }
    const result = Type.substitute(callable.result, inferred)
    if (stagedValue !== undefined) {
      const retained = stagedContract(
        strongestEffectAccess(callable.mode, callableMode(stagedValue.captures)),
        callable.schema,
      )
      return retained === undefined ? unavailableExpressionType : availableExpressionType(retained)
    }
    return availableExpressionType(
      Type.isEffect(result)
        ? Type.effectWithRows(
            result.success,
            result.failureRow,
            result,
            strongestEffectAccess(
              result.access,
              callable.mode,
              effectExpressionAccess(
                callee.fact,
                resolution?.index,
                caller === undefined ? new Set() : copyAssumptionsOf(caller),
              ),
              effectCaptureAccess(
                argumentsResult.facts,
                resolution?.index,
                caller === undefined ? new Set() : copyAssumptionsOf(caller),
              ),
            ),
            result.requirementRow,
          )
        : result,
    )
  })()
  if (stagedSection !== undefined && stagedCaptures !== undefined && resolution !== undefined) {
    const remainingCount = stagedSection.remainingParameters.length - argumentsResult.facts.length
    const environmentOwner = executableSpecializationOwner(resolution)
    return {
      fact: {
        _tag: 'CallableSection',
        selectedConformances: selectedConformances.proofs,
        site: executableSite('CallableSiteId', resolution, node),
        reference: stagedSection.reference,
        ...(stagedSection.invocationParameters === undefined
          ? {}
          : {
              invocationParameters: stagedSection.invocationParameters,
            }),
        path: stagedSection.path,
        remainingParameters: stagedSection.remainingParameters.slice(0, remainingCount),
        captures: stagedCaptures,
        retainedDependencies: stagedCaptures.flatMap((capture) =>
          capture.access === 'Shared' || capture.access === 'Exclusive'
            ? [capture.parameterOrdinal]
            : [],
        ),
        typeArguments: stagedSection.typeArguments,
        ...(environmentOwner === undefined ? {} : { environmentOwner }),
        substitution: inferred,
        mode: callableMode(stagedCaptures),
        type,
        anchor: node.anchor,
      },
      diagnostics: diagnostics,
      type: type._tag === 'Available' ? type.type : undefined,
    }
  }
  if (section?.reference._tag === 'ResolvedIntrinsicContract' && stagedValue === undefined) {
    const protected_ = argumentsResult.facts.at(0)
    if (
      section.reference.intrinsic.rule._tag === 'ContractRule' &&
      section.reference.intrinsic.rule.post === 'CatchFailure'
    ) {
      const handlerCapture = section.captures.find((capture) => capture.parameterOrdinal === 1)
      const handler = handlerCapture?.expression
      const wanted = section.reference.contract.constraints
        .map((constraint) => Constraint.substitute(constraint, inferred))
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
      const handlerTypeFact =
        handler === undefined ? undefined : constructionExpressionType(handler)
      const handlerType = handlerTypeFact?._tag === 'Available' ? handlerTypeFact.type : undefined
      const handlerEffect =
        handlerType !== undefined &&
        Type.isCallable(handlerType) &&
        Type.isEffect(handlerType.result)
          ? handlerType.result
          : undefined
      const recoveryInvocation =
        wanted === undefined
          ? undefined
          : recoveryInvocationRecipe(
              section.reference.contract,
              inferred,
              Type.failureType(wanted.selected),
              node.anchor,
              resolution?.bodyLifetimes,
            )
      const catchAvailable =
        type._tag === 'Available' &&
        protected_ !== undefined &&
        handler !== undefined &&
        wanted !== undefined &&
        recoveryInvocation !== undefined &&
        proved
      return {
        fact: {
          _tag: 'EffectCatch',
          ...(recoveryInvocation === undefined ? {} : { recoveryInvocation }),
          reference: sectionIntrinsicReference(section),
          protected: protected_?.expression ?? unavailableNode(context, node.anchor, resolution),
          handler: handler ?? unavailableNode(context, node.anchor, resolution),
          ...(wanted === undefined ? {} : { selected: Type.failureType(wanted.selected) }),
          protectedRow: wanted?.source ?? RowAlgebra.concrete(Type.failureRowPolicy(), []),
          handlerRow: handlerEffect?.failureRow ?? RowAlgebra.concrete(Type.failureRowPolicy(), []),
          residualRow:
            wanted === undefined
              ? RowAlgebra.concrete(Type.failureRowPolicy(), [])
              : RowAlgebra.without(Type.failureRowPolicy(), wanted.source, wanted.selected),
          evidence,
          type: catchAvailable ? type : unavailableExpressionType,
          anchor: node.anchor,
        },
        diagnostics: diagnostics,
        type: catchAvailable && type._tag === 'Available' ? type.type : undefined,
      }
    }
    const providerCapture = section.captures.find((capture) => capture.parameterOrdinal === 1)
    const provider =
      providerCapture === undefined
        ? undefined
        : effectBindingProvider(
            section.reference.intrinsic,
            inferred,
            evidence,
            providerCapture.expression,
            context.spanOf(constructionExpressionAnchor(providerCapture.expression)),
            constructionExpressionAnchor(providerCapture.expression),
            resolution?.index,
            resolution?.builder,
          )
    return {
      fact: {
        _tag: 'EffectBindRequirement',
        reference: sectionIntrinsicReference(section),
        protected: protected_?.expression ?? unavailableNode(context, node.anchor, resolution),
        ...(type._tag === 'Available' && provider !== undefined ? { provider } : {}),
        type,
        anchor: node.anchor,
      },
      diagnostics: diagnostics,
      type: type._tag === 'Available' ? type.type : undefined,
    }
  }
  // Staging copies a shared environment and consumes any other, exactly as capturing the
  // callable value itself would.
  let mode: Type.CallableMode = callable?.mode ?? 'Shared'
  if (stagedValue !== undefined && mode !== 'Shared') mode = 'Take'
  return {
    fact: {
      _tag: 'CallableApply',
      ...(sourceTarget === undefined ? {} : { sourceTarget }),
      selectedConformances: selectedConformances.proofs,
      callee: expressionNode(callee),
      arguments: argumentsResult.facts,
      mode,
      ...(callable === undefined ? {} : { contract: callable }),
      ...(invocationUse === undefined || type._tag !== 'Available' ? {} : { invocationUse }),
      substitution: inferred,
      inferredProviderSelectors,
      ...(stagedValue === undefined ? {} : { staged: stagedValue }),
      provenance: provenance ?? { _tag: 'DirectCallableApplication' as const },
      type,
      anchor: node.anchor,
    },
    diagnostics: diagnostics,
    type: type._tag === 'Available' ? type.type : undefined,
  }
}

/**
 * `Place.replace(place, value)`: the first argument resolves as a writable place under the same
 * rules as assignment, the second as a value of the place's type, and the whole expression
 * yields the place's previous value. The place stays initialized, so affine owners can leave a
 * struct field behind a reference without a partial move.
 */
export const unavailableIdentifierFact = (node: AuthoredHir.Expression): ExpressionDecision => ({
  _tag: 'Identifier',
  reference: { _tag: 'Unavailable' as const, anchor: node.anchor },
  type: unavailableExpressionType,
  anchor: node.anchor,
})
