import * as Location from './Location.js'
import * as ForeignContract from './ForeignContract.js'
import * as CAbi from './CAbi.js'
import * as CLayout from './CLayout.js'
import * as ConformanceHead from './ConformanceHead.js'
import * as Constraint from './Constraint.js'
import { copyAssumptions, copyProof } from './ConformanceProof.js'
import type {
  ConformanceFact,
  ConstantFact,
  DeclarationFact,
  DeclaredTypeFact,
  DeclaredName,
  EnumFact,
  InherentImplFact,
  InterfaceFact,
  MemberFact,
  ModuleHeaders,
  ParameterFact,
  ReturnTypeFact,
  ServiceFact,
  StructFact,
  TypeParameterFact,
  TypePathFact,
  UnionFact,
} from './DeclarationFacts.js'
import {
  closeConformanceSelf,
  omittedEnvironmentDiagnostics,
  providerOperation,
  interfaceApplication,
  interfaceOperationContracts,
} from './DeclarationFacts.js'
import * as DeclarationCollection from './DeclarationCollection.js'
import * as DeclarationIndex from './DeclarationIndex.js'
import * as NameResolution from './NameResolution.js'
import {
  attachExposure,
  canonicalKey,
  closeOpaqueReturnType,
  declaredRequirements,
  inferInterfaceWitnessTarget,
  inlineNeighbors,
  inlineParametersOf,
  interfaceWitnessCompatibility,
  memberByNominal,
  refreshInterfaceApplications,
  resolveBounds,
  resolveConstraintFacts,
  resolveDeclaredType,
  resolveFailureRow,
  resolveOpaqueResult,
  resolveRequirementRow,
  sealedWitnessCompatibility,
  semanticConstraints,
  stronglyConnected,
  unpromisedWitnessBound,
  unpromisedWitnessConstraint,
  witnessBinding,
} from './DeclarationResolution.js'
import * as Diagnostic from './Diagnostic.js'
import * as TypeOutlives from './TypeOutlives.js'
import * as Lifetime from './Lifetime.js'
import * as InterfaceWitnessCompatibility from './InterfaceWitnessCompatibility.js'
import * as Intrinsic from './Intrinsic.js'
import * as TypeInference from './internal/TypeInference.js'
import * as ResolutionSeams from './ResolutionSeams.js'
import type * as SemanticContext from './SemanticContext.js'
import type * as AuthoredHir from './AuthoredHir.js'
import * as Scalar from './Scalar.js'
import * as SourceSpan from './SourceSpan.js'

/** Resolves one authored position to a current-revision span, for diagnostics only. */
type SpanOf = (anchor: AuthoredHir.Anchor) => SourceSpan.SourceSpan
import * as Type from './Type.js'

/** Makes resolved executable-representation bounds visible while closing their declaration. */
const withResolvedRepresentationParameters = (
  resolvers: ResolutionSeams.ResolutionSeams,
  collected: ReadonlyArray<TypeParameterFact>,
  resolved: ReadonlyArray<TypeParameterFact>,
): ResolutionSeams.ResolutionSeams =>
  collected.reduce((current, parameter, ordinal) => {
    const closed = resolved.at(ordinal)
    return closed === undefined || closed.type.representationBound === undefined
      ? current
      : ResolutionSeams.withRepresentationBinding(current, parameter.type, closed.type)
  }, resolvers)

/** The declaration an inherent impl owner names: any nominal declaration kind, including enums. */
const nominalOwnerDeclaration = (
  modules: ReadonlyArray<ModuleHeaders>,
  nominal: Type.Nominal,
): MemberFact | undefined =>
  modules
    .find((module) => module.module === nominal.module)
    ?.members.find(
      (member) =>
        member.canonical._tag === 'Canonical' &&
        member.canonical.id.name === nominal.name &&
        (member._tag === 'StructDeclaration' ||
          member._tag === 'UnionDeclaration' ||
          member._tag === 'EnumDeclaration' ||
          member._tag === 'ServiceDeclaration' ||
          member._tag === 'InterfaceDeclaration'),
    )

/** Source modules allowed to own an interface or service implementation. */
const sourceConformanceOwners = (
  capability: Type.Nominal,
  provider: Type.Type,
  contract: InterfaceFact | ServiceFact,
): ReadonlyArray<string> => {
  if (Type.isNominal(provider)) {
    if (contract._tag === 'InterfaceDeclaration' && provider.module !== capability.module)
      return [provider.module, capability.module]
    return [provider.module]
  }
  if (Type.isBuiltin(provider) || Type.isString(provider)) return [capability.module]
  return []
}

/** Structural providers whose only coherent source owner is the declaring contract module. */
const isContractOwnedInlineProvider = (provider: Type.Type): boolean =>
  Type.isBuiltin(provider) || Type.isString(provider)

const foreignAdmission = (
  spanOf: SpanOf,
  parameters: ReadonlyArray<ParameterFact>,
  result: ReturnTypeFact,
  contract: ForeignContract.ForeignContract = ForeignContract.conservative,
): ReadonlyArray<Diagnostic.Located> =>
  [...parameters.map((parameter) => parameter.declaredType), result].flatMap(
    (declared, ordinal) => {
      if (declared._tag !== 'Resolved') return []
      if (
        ordinal < parameters.length &&
        contract.borrow.includes(ordinal) &&
        Type.isReference(declared.type)
      )
        return []
      const admission = CAbi.admit(
        declared.type,
        ordinal < parameters.length ? 'Parameter' : 'Result',
      )
      return admission._tag === 'Admitted'
        ? []
        : [Diagnostic.foreignTypeNotAdmitted(declared.spelling, 'C', Location.at(declared.anchor))]
    },
  )

/** C function pointers are ABI contracts even when their enclosing declaration is ordinary Silk. */
const foreignFunctionPointerAdmission = (
  spanOf: SpanOf,
  declared: DeclaredTypeFact,
): ReadonlyArray<Diagnostic.Located> => {
  if (declared._tag !== 'Resolved') return []
  return Type.foreignFunctions(declared.type).flatMap((type) => [
    ...(CAbi.admit(type, 'Parameter')._tag === 'Admitted'
      ? []
      : [Diagnostic.foreignTypeNotAdmitted(Type.encode(type), 'C', Location.at(declared.anchor))]),
    ...ForeignContract.validate(
      type.contract,
      type.parameters.map((parameter, ordinal) => ({
        name: String(ordinal),
        type: parameter,
        at: Location.at(declared.anchor),
      })),
      type.result,
      Location.at(declared.anchor),
    ),
  ])
}

export const complete = (
  self: DeclarationIndex.Index,
  resolvers: ResolutionSeams.ResolutionSeams,
  registry: SemanticContext.Registry,
): DeclarationIndex.Index => {
  const spanOf = registry.spanOf
  const diagnostics: Array<Diagnostic.Located> = [...self.diagnostics]
  // Alias declarations own their one-shot resolution diagnostics. Header arity probes also
  // traverse property bounds and may ignore non-nominal results, so they must not force these first.
  for (const module of self.modules)
    for (const member of module.members)
      if (member._tag === 'AliasDeclaration')
        diagnostics.push(...(resolvers.alias?.(member).diagnostics ?? []))
  const finalized = new Map<MemberFact, MemberFact>()
  const finalizedHeads = new Map<InherentImplFact, InherentImplFact>()
  const finalizedConformances = new Map<ConformanceFact, ConformanceFact>()
  const active = new Set<MemberFact>()
  const nominalParameters = (
    module: string | undefined,
    path: TypePathFact,
  ): ReadonlyArray<Type.Parameter> | undefined => {
    if (module === undefined) return undefined
    const resolved = resolvers.type(module, path)
    if (
      resolved.fact._tag !== 'Resolved' ||
      !Type.isNominal(resolved.fact.type) ||
      resolved.fact.type.arguments.length > 0
    )
      return undefined
    const reached = memberByNominal(self.modules, resolved.fact.type)
    if (reached === undefined) return Type.intrinsicNominalParameters(resolved.fact.type)
    const closed = finalize(reached)
    return 'typeParameters' in closed
      ? closed.typeParameters.map((parameter) => parameter.type)
      : undefined
  }
  const finalizeHead = (head: InherentImplFact): InherentImplFact => {
    const cached = finalizedHeads.get(head)
    if (cached !== undefined) return cached
    // An impl names its local declaration even when a builtin storage type has the same name.
    // Apply that identity before elision so builtin lifetimes cannot enter the local head.
    const localOwner = self.modules
      .find((module) => module.module === head.module)
      ?.members.find(
        (member) =>
          member.name._tag === 'Present' &&
          member.name.spelling === head.ownerSpelling &&
          NameResolution.isNominalOwner(member),
      )
    const headContext = registry.of(head.anchor)
    if (headContext === undefined) return head
    const candidate = DeclarationCollection.finalizeLifetimeHeader(headContext, head, (path) => {
      const owner =
        path.spelling === head.ownerSpelling && localOwner !== undefined
          ? finalize(localOwner)
          : undefined
      return owner !== undefined && 'typeParameters' in owner
        ? owner.typeParameters.map((parameter) => parameter.type)
        : nominalParameters(head.module, path)
    })
    const closed = candidate._tag === 'InherentImplDeclaration' ? candidate : head
    finalizedHeads.set(head, closed)
    return closed
  }
  const finalizeConformance = (head: ConformanceFact): ConformanceFact => {
    const cached = finalizedConformances.get(head)
    if (cached !== undefined) return cached
    const headContext = registry.of(head.anchor)
    if (headContext === undefined) return head
    const candidate = DeclarationCollection.finalizeLifetimeHeader(headContext, head, (path) =>
      nominalParameters(head.module, path),
    )
    const closed = candidate._tag === 'ConformanceDeclaration' ? candidate : head
    finalizedConformances.set(head, closed)
    return closed
  }
  const finalize = (member: MemberFact): MemberFact => {
    const cached = finalized.get(member)
    if (cached !== undefined) return cached
    if (active.has(member)) return member
    active.add(member)
    const module =
      'lifetimeElaboration' in member ? member.lifetimeElaboration?.owner.module : undefined
    const association = member._tag === 'FunctionDeclaration' ? member.associatedMember : undefined
    const head =
      association === undefined
        ? undefined
        : self.modules
            .find((candidate) => candidate.module === module)
            ?.inherentImpls.find((candidate) => candidate.ordinal === association.ordinal)
    const conformance =
      member._tag === 'FunctionDeclaration' && member.conformanceImplementation !== undefined
        ? self.modules
            .find((candidate) => candidate.module === module)
            ?.conformances.find(
              (candidate) => candidate.ordinal === member.conformanceImplementation?.ordinal,
            )
        : undefined
    const completedHead = head === undefined ? undefined : finalizeHead(head)
    const memberContext = registry.of(member.anchor)
    const candidate =
      (member._tag === 'FunctionDeclaration' ||
        member._tag === 'StructDeclaration' ||
        member._tag === 'UnionDeclaration') &&
      memberContext !== undefined
        ? DeclarationCollection.finalizeLifetimeHeader(
            memberContext,
            member,
            (path) => nominalParameters(module, path),
            conformance !== undefined ? finalizeConformance(conformance) : completedHead,
          )
        : member
    const closed =
      candidate._tag === 'ServiceOperation' ||
      candidate._tag === 'InherentImplDeclaration' ||
      candidate._tag === 'ConformanceDeclaration'
        ? member
        : candidate
    active.delete(member)
    finalized.set(member, closed)
    return closed
  }
  const headers = self.modules.map((module): ModuleHeaders => {
    const members = module.members.map(finalize)
    return {
      ...module,
      inherentImpls: module.inherentImpls.map(finalizeHead),
      conformances: module.conformances.map(finalizeConformance),
      members: members,
      declarations: members.filter(
        (member): member is DeclarationFact => member._tag === 'FunctionDeclaration',
      ),
      structs: members.filter(
        (member): member is StructFact => member._tag === 'StructDeclaration',
      ),
      unions: members.filter((member): member is UnionFact => member._tag === 'UnionDeclaration'),
    }
  })
  let modules = headers.map((module): ModuleHeaders => {
    const nominalParameters = (path: TypePathFact): ReadonlyArray<Type.Parameter> | undefined => {
      const resolved = resolvers.type(module.module, path)
      if (
        resolved.fact._tag !== 'Resolved' ||
        !Type.isNominal(resolved.fact.type) ||
        resolved.fact.type.arguments.length > 0
      )
        return undefined
      return (
        memberByNominal(headers, resolved.fact.type)?.typeParameters.map(
          (parameter) => parameter.type,
        ) ?? Type.intrinsicNominalParameters(resolved.fact.type)
      )
    }
    const members = module.members.map((member): MemberFact => {
      if ('lifetimeElaboration' in member && member.lifetimeElaboration !== undefined)
        diagnostics.push(
          ...member.lifetimeElaboration.diagnostics.filter(
            (candidate) =>
              !diagnostics.some(
                (prior) =>
                  prior.code === candidate.code && Location.equals(prior.span, candidate.span),
              ),
          ),
        )
      if (member._tag === 'AliasDeclaration') {
        // Alias diagnostics were retained before header replay; this reads the memoized target.
        const resolved = resolvers.alias?.(member)
        if (resolved === undefined) return member
        diagnostics.push(...resolved.diagnostics)
        diagnostics.push(...foreignFunctionPointerAdmission(spanOf, resolved.fact))
        return { ...member, target: resolved.fact }
      }
      if (
        member._tag === 'ConstantDeclaration' ||
        member._tag === 'PackageParameterDeclaration' ||
        member._tag === 'ForeignStaticDeclaration'
      ) {
        const resolved = resolveDeclaredType(
          spanOf,
          module.module,
          member.declaredType,
          resolvers,
          headers,
        )
        diagnostics.push(...resolved.diagnostics)
        if (
          member._tag === 'ConstantDeclaration' ||
          member._tag === 'PackageParameterDeclaration'
        ) {
          diagnostics.push(...foreignFunctionPointerAdmission(spanOf, resolved.fact))
          return { ...member, declaredType: resolved.fact }
        }
        const admission =
          resolved.fact._tag === 'Resolved'
            ? CAbi.admit(resolved.fact.type, 'Parameter')
            : undefined
        if (admission?._tag === 'NotAdmitted')
          diagnostics.push(
            Diagnostic.foreignTypeNotAdmitted(
              Type.encode(admission.type),
              'C',
              Location.at(resolved.fact.anchor),
            ),
          )
        let invalidInitializer = false
        if (member.direction === 'Export') {
          const type = resolved.fact._tag === 'Resolved' ? resolved.fact.type : undefined
          const literal = member.literal
          const scalar = typeof type === 'string' ? Scalar.find(type) : undefined
          const integerRange = scalar?.category === 'Integer' ? Scalar.range(scalar, 64) : undefined
          const integerInitializer =
            literal?._tag === 'IntegerLiteral' &&
            integerRange !== undefined &&
            literal.value >= integerRange.minimum &&
            literal.value <= integerRange.maximum
          const floatingValue =
            literal?._tag === 'FloatingLiteral' ? Number(literal.spelling) : undefined
          const floatingInitializer =
            scalar?.category === 'Floating' &&
            floatingValue !== undefined &&
            Number.isFinite(floatingValue) &&
            (scalar.spelling !== 'f32' || Number.isFinite(Math.fround(floatingValue)))
          const scalarInitializer = integerInitializer || floatingInitializer
          if (!scalarInitializer) {
            invalidInitializer = true
            diagnostics.push(
              Diagnostic.invalidConstant(
                'an exported C static requires one matching integer or floating-point scalar literal',
                Location.at(member.initializer?.anchor ?? member.anchor),
              ),
            )
          }
        }
        return {
          ...member,
          declaredType:
            admission?._tag === 'NotAdmitted' || invalidInitializer
              ? { _tag: 'Unavailable' as const, anchor: resolved.fact.anchor }
              : resolved.fact,
        }
      }
      if (member._tag === 'FunctionDeclaration') {
        const resolvedTypeParameters = resolveBounds(
          spanOf,
          module.module,
          member.typeParameters,
          resolvers,
          headers,
          diagnostics,
        )
        const opaqueResult = resolveOpaqueResult(
          spanOf,
          module.module,
          member.opaqueResult,
          resolvers,
          headers,
          diagnostics,
        )
        const typeParameterResolvers = withResolvedRepresentationParameters(
          resolvers,
          member.typeParameters,
          resolvedTypeParameters,
        )
        const memberResolvers: ResolutionSeams.ResolutionSeams =
          member.opaqueResult === undefined || opaqueResult === undefined
            ? typeParameterResolvers
            : ResolutionSeams.withRepresentationBinding(
                typeParameterResolvers,
                member.opaqueResult.binder.type,
                opaqueResult.binder.type,
              )
        const parameters = member.parameters.map((parameter) => {
          const resolved = resolveDeclaredType(
            spanOf,
            module.module,
            parameter.declaredType,
            memberResolvers,
            headers,
          )
          diagnostics.push(...resolved.diagnostics)
          return { ...parameter, declaredType: resolved.fact }
        })
        const resolvedResult = resolveDeclaredType(
          spanOf,
          module.module,
          member.returnType,
          memberResolvers,
          headers,
        )
        diagnostics.push(...resolvedResult.diagnostics)
        const result = closeOpaqueReturnType(
          resolvedResult.fact,
          opaqueResult,
          resolvedTypeParameters,
        )
        const failureRow = resolveFailureRow(
          spanOf,
          module.module,
          member.failureRow,
          memberResolvers,
          headers,
        )
        diagnostics.push(...failureRow.diagnostics)
        const requirementRow = resolveRequirementRow(
          spanOf,
          module.module,
          member.requirementRow,
          memberResolvers,
          headers,
        )
        diagnostics.push(...requirementRow.diagnostics)
        const constraints = resolveConstraintFacts(
          spanOf,
          module.module,
          member.constraints,
          memberResolvers,
          headers,
        )
        diagnostics.push(...constraints.diagnostics)
        const admission =
          member.foreign === undefined && member.foreignExport === undefined
            ? []
            : foreignAdmission(
                spanOf,
                parameters,
                result.fact,
                (member.foreign ?? member.foreignExport)?.contract,
              )
        const pointerAdmission = [
          ...parameters.flatMap((parameter) =>
            foreignFunctionPointerAdmission(spanOf, parameter.declaredType),
          ),
          ...foreignFunctionPointerAdmission(spanOf, result.fact),
        ]
        const behaviorDiagnostics =
          member.foreign === undefined && member.foreignExport === undefined
            ? []
            : ForeignContract.validate(
                (member.foreign ?? member.foreignExport)?.contract ?? ForeignContract.conservative,
                parameters.map((parameter) => ({
                  name: parameter.name._tag === 'Present' ? parameter.name.spelling : '',
                  type:
                    parameter.declaredType._tag === 'Resolved'
                      ? parameter.declaredType.type
                      : undefined,
                  at: Location.at(parameter.anchor),
                })),
                result.fact._tag === 'Resolved' ? result.fact.type : undefined,
                Location.at(result.fact.anchor),
              )
        if (member.test) {
          const marker = Location.at(member.testAnchor ?? member.anchor)
          let invalid: string | undefined
          if (member.associatedMember !== undefined)
            invalid = 'tests must be declared at module scope'
          else if (member.phase === 'Static') invalid = 'tests must be runtime functions'
          else if (member.unsafe) invalid = 'tests must be safe functions'
          else if (member.foreign !== undefined || member.foreignExport !== undefined)
            invalid = 'tests cannot have native linkage'
          else if (resolvedTypeParameters.length > 0)
            invalid = 'tests cannot declare generic or lifetime binders'
          else if (parameters.length > 0) invalid = 'tests cannot declare parameters'
          else if (result.fact._tag !== 'Resolved' || !Type.equals(result.fact.type, Type.unit))
            invalid = 'tests must produce unit success'
          if (invalid !== undefined)
            diagnostics.push(Diagnostic.invalidTestDeclaration(invalid, marker))
        }
        diagnostics.push(...admission, ...behaviorDiagnostics, ...pointerAdmission)
        const { foreignExport, ...retained } = member
        return {
          ...retained,
          // An export outside the C subset publishes no symbol, so discovery never roots it.
          ...(admission.length === 0 && foreignExport !== undefined ? { foreignExport } : {}),
          typeParameters: resolvedTypeParameters,
          parameters: parameters,
          // A foreign or exported header outside the C subset withholds its result so no callable
          // is published.
          returnType:
            admission.length === 0 && behaviorDiagnostics.length === 0
              ? result.fact
              : { _tag: 'Unavailable' as const, anchor: result.fact.anchor },
          ...(result.opaqueResult === undefined ? {} : { opaqueResult: result.opaqueResult }),
          failureRow: failureRow.fact,
          requirementRow: requirementRow.fact,
          constraints: constraints.facts,
          constraintContracts: semanticConstraints(spanOf, constraints.facts),
        }
      }
      if (member._tag === 'ServiceDeclaration' || member._tag === 'InterfaceDeclaration') {
        const resolvedMemberTypeParameters = resolveBounds(
          spanOf,
          module.module,
          member.typeParameters,
          resolvers,
          headers,
          diagnostics,
        )
        const memberResolvers = withResolvedRepresentationParameters(
          resolvers,
          member.typeParameters,
          resolvedMemberTypeParameters,
        )
        const operations = member.operations.map((collectedOperation) => {
          const operationContext = registry.of(collectedOperation.anchor)
          const finalizedOperation =
            operationContext === undefined
              ? collectedOperation
              : DeclarationCollection.finalizeLifetimeHeader(
                  operationContext,
                  collectedOperation,
                  nominalParameters,
                )
          const operation =
            finalizedOperation._tag === 'ServiceOperation' ? finalizedOperation : collectedOperation
          diagnostics.push(
            ...(operation.lifetimeElaboration?.diagnostics ?? []).filter(
              (candidate) =>
                !diagnostics.some(
                  (prior) =>
                    prior.code === candidate.code && Location.equals(prior.span, candidate.span),
                ),
            ),
          )
          if (operation.opaqueResult !== undefined) {
            const owner = member.name._tag === 'Present' ? member.name.spelling : '<anonymous>'
            const name = operation.name._tag === 'Present' ? operation.name.spelling : '<anonymous>'
            diagnostics.push(
              Diagnostic.bodylessOpaqueResult(
                `${owner}.${name}`,
                member._tag === 'ServiceDeclaration' ? 'ServiceOperation' : 'InterfaceOperation',
                Location.at(operation.opaqueResult.anchor),
              ),
            )
          }
          const resolvedOperationTypeParameters = resolveBounds(
            spanOf,
            module.module,
            operation.typeParameters,
            memberResolvers,
            headers,
            diagnostics,
          )
          const opaqueResult = resolveOpaqueResult(
            spanOf,
            module.module,
            operation.opaqueResult,
            memberResolvers,
            headers,
            diagnostics,
          )
          const operationTypeParameterResolvers = withResolvedRepresentationParameters(
            memberResolvers,
            operation.typeParameters,
            resolvedOperationTypeParameters,
          )
          const operationResolvers: ResolutionSeams.ResolutionSeams =
            operation.opaqueResult === undefined || opaqueResult === undefined
              ? operationTypeParameterResolvers
              : ResolutionSeams.withRepresentationBinding(
                  operationTypeParameterResolvers,
                  operation.opaqueResult.binder.type,
                  opaqueResult.binder.type,
                )
          const parameters = operation.parameters.map((parameter) => {
            const resolved = resolveDeclaredType(
              spanOf,
              module.module,
              parameter.declaredType,
              operationResolvers,
              headers,
            )
            diagnostics.push(...resolved.diagnostics)
            return { ...parameter, declaredType: resolved.fact }
          })
          const resolvedResult = resolveDeclaredType(
            spanOf,
            module.module,
            operation.returnType,
            operationResolvers,
            headers,
          )
          const result = closeOpaqueReturnType(resolvedResult.fact, opaqueResult, [
            ...resolvedMemberTypeParameters,
            ...resolvedOperationTypeParameters,
          ])
          const failureRow = resolveFailureRow(
            spanOf,
            module.module,
            operation.failureRow,
            operationResolvers,
            headers,
          )
          const requirementRow = resolveRequirementRow(
            spanOf,
            module.module,
            operation.requirementRow,
            operationResolvers,
            headers,
          )
          const constraints = resolveConstraintFacts(
            spanOf,
            module.module,
            operation.constraints,
            operationResolvers,
            headers,
          )
          diagnostics.push(
            ...resolvedResult.diagnostics,
            ...failureRow.diagnostics,
            ...requirementRow.diagnostics,
            ...constraints.diagnostics,
            ...parameters.flatMap((parameter) =>
              foreignFunctionPointerAdmission(spanOf, parameter.declaredType),
            ),
            ...foreignFunctionPointerAdmission(spanOf, result.fact),
            ...omittedEnvironmentDiagnostics({ ...operation, parameters }),
          )
          return {
            ...operation,
            typeParameters: resolvedOperationTypeParameters,
            parameters: parameters,
            returnType: result.fact,
            ...(result.opaqueResult === undefined ? {} : { opaqueResult: result.opaqueResult }),
            failureRow: failureRow.fact,
            requirementRow: requirementRow.fact,
            constraints: constraints.facts,
            constraintContracts: semanticConstraints(spanOf, constraints.facts),
          }
        })
        const completed = {
          ...member,
          typeParameters: resolvedMemberTypeParameters,
          operations: operations,
        }
        return {
          ...completed,
          operationContracts: interfaceOperationContracts(completed, operations),
        }
      }
      if (member._tag === 'RoleDeclaration' || member._tag === 'EnumDeclaration') return member
      const resolveFields = (fields: StructFact['fields']): StructFact['fields'] =>
        fields.map((field) => {
          const resolved = resolveDeclaredType(
            spanOf,
            module.module,
            field.declaredType,
            resolvers,
            headers,
          )
          diagnostics.push(...resolved.diagnostics)
          diagnostics.push(...foreignFunctionPointerAdmission(spanOf, resolved.fact))
          return { ...field, declaredType: resolved.fact }
        })
      if (member._tag === 'UnionDeclaration') {
        const variants = member.variants.map((variant) => ({
          ...variant,
          fields: resolveFields(variant.fields),
        }))
        const unavailableCauses = variants.flatMap((variant) =>
          variant.fields.flatMap((field) =>
            field.declaredType._tag === 'Unresolved' && field.declaredType.cause !== undefined
              ? [field.declaredType.cause]
              : [],
          ),
        )
        return {
          ...member,
          typeParameters: resolveBounds(
            spanOf,
            module.module,
            member.typeParameters,
            resolvers,
            headers,
            diagnostics,
          ),
          variants,
          validity:
            member.validity._tag === 'Valid' && unavailableCauses.length === 0
              ? member.validity
              : {
                  _tag: 'Invalid' as const,
                  causes: [
                    ...(member.validity._tag === 'Invalid' ? member.validity.causes : []),
                    ...unavailableCauses,
                  ],
                },
        }
      }
      return {
        ...member,
        typeParameters: resolveBounds(
          spanOf,
          module.module,
          member.typeParameters,
          resolvers,
          headers,
          diagnostics,
        ),
        fields: resolveFields(member.fields),
      }
    })
    const conformances = module.conformances.map((conformance) => {
      const capability = resolveDeclaredType(
        spanOf,
        module.module,
        conformance.capability,
        resolvers,
        headers,
      )
      const provider = resolveDeclaredType(
        spanOf,
        module.module,
        conformance.provider,
        resolvers,
        headers,
      )
      diagnostics.push(...capability.diagnostics, ...provider.diagnostics)
      const hook =
        conformance.hook === undefined
          ? undefined
          : (() => {
              const parameterType = resolveDeclaredType(
                spanOf,
                module.module,
                conformance.hook.parameterType,
                resolvers,
                headers,
              )
              const returnType = resolveDeclaredType(
                spanOf,
                module.module,
                conformance.hook.returnType,
                resolvers,
                headers,
              )
              const failureRow = resolveFailureRow(
                spanOf,
                module.module,
                conformance.hook.failureRow,
                resolvers,
                headers,
              )
              const requirementRow = resolveRequirementRow(
                spanOf,
                module.module,
                conformance.hook.requirementRow,
                resolvers,
                headers,
              )
              diagnostics.push(
                ...parameterType.diagnostics,
                ...returnType.diagnostics,
                ...failureRow.diagnostics,
                ...requirementRow.diagnostics,
              )
              return {
                ...conformance.hook,
                parameterType: parameterType.fact,
                returnType: returnType.fact,
                failureRow: failureRow.fact,
                requirementRow: requirementRow.fact,
              }
            })()
      const requirements = conformance.requirements.map((requirement) => {
        const resolved = resolveDeclaredType(
          spanOf,
          module.module,
          requirement.capability,
          resolvers,
          headers,
        )
        diagnostics.push(...resolved.diagnostics)
        return { ...requirement, capability: resolved.fact }
      })
      const headConstraints = resolveConstraintFacts(
        spanOf,
        module.module,
        conformance.constraints,
        resolvers,
        headers,
      )
      diagnostics.push(...headConstraints.diagnostics)
      return {
        ...conformance,
        requirements: requirements,
        constraints: headConstraints.facts,
        constraintContracts: semanticConstraints(spanOf, headConstraints.facts),
        capability: capability.fact,
        provider: provider.fact,
        ...(hook === undefined ? {} : { hook }),
      }
    })
    const conformanceProviders = new Map(
      conformances.flatMap((conformance) =>
        conformance.provider._tag === 'Resolved'
          ? [[conformance.ordinal, conformance.provider.type] as const]
          : [],
      ),
    )
    // An inherent head resolves its owner exactly as a conformance resolves its provider. The
    // checks that need scope run here: the owner must be a nominal of this module named directly
    // (not through an alias), or the head publishes no members.
    const inherentImpls = module.inherentImpls.map((head): InherentImplFact => {
      const owner = resolveDeclaredType(spanOf, module.module, head.owner, resolvers, headers)
      // A head already rejected at collection keeps only that diagnostic; its owner is resolved
      // for closing `Self` in its members, not for a second report.
      if (head.validity._tag === 'Invalid') return { ...head, owner: owner.fact }
      // The owner is a declaration of this module named by its own spelling. A local declaration
      // wins over the type resolver's answer because a zero-data owner struct may share its
      // spelling with a builtin storage type (`Slot`, `RawBuffer`), and the impl names the
      // declaration. Only when no local declaration matches does the resolver's answer tell a
      // foreign owner from an alias or a non-nominal.
      const localOwner = module.members.find(
        (member) =>
          member.canonical._tag === 'Canonical' &&
          member.canonical.id.name === head.ownerSpelling &&
          NameResolution.isNominalOwner(member),
      )
      const binders = head.typeParameters.filter((parameter) => parameter.duplicateOf === undefined)
      if (
        localOwner !== undefined &&
        'typeParameters' in localOwner &&
        (localOwner.typeParameters.length !== binders.length ||
          localOwner.typeParameters.some(
            (parameter) =>
              localOwner.typeParameters.filter(
                (candidate) => candidate.type.kind === parameter.type.kind,
              ).length !==
              binders.filter((candidate) => candidate.type.kind === parameter.type.kind).length,
          ))
      ) {
        const diagnostic = Diagnostic.invalidInherentHead(
          head.ownerSpelling,
          'Specialized',
          Location.at(head.owner.anchor),
        )
        diagnostics.push(diagnostic)
        return {
          ...head,
          owner: owner.fact,
          validity: {
            _tag: 'Invalid' as const,
            cause: Diagnostic.identity(diagnostic),
          },
        }
      }
      if (
        localOwner !== undefined &&
        localOwner.canonical._tag === 'Canonical' &&
        owner.fact._tag === 'Resolved'
      ) {
        // Keep resolved nominal arguments in the declaration's canonical order, including inferred
        // lifetimes. Only a builtin shadow requires rebuilding the local declaration's nominal.
        if (Type.isNominal(owner.fact.type)) diagnostics.push(...owner.diagnostics)
        const ownerType =
          Type.isNominal(owner.fact.type) &&
          owner.fact.type.module === module.module &&
          owner.fact.type.name === localOwner.canonical.id.name
            ? owner.fact.type
            : Type.nominal(
                module.module,
                localOwner.canonical.id.name,
                binders.map((parameter) => Type.parameterArgument(parameter.type)),
              )
        return { ...head, owner: { ...owner.fact, type: ownerType } }
      }
      const ownerType = owner.fact._tag === 'Resolved' ? owner.fact.type : undefined
      const nominal = ownerType !== undefined && Type.isNominal(ownerType) ? ownerType : undefined
      const ownerDeclaration =
        nominal === undefined ? undefined : nominalOwnerDeclaration(headers, nominal)
      const localAlias = module.members.some(
        (member) =>
          member._tag === 'AliasDeclaration' &&
          member.name._tag === 'Present' &&
          member.name.spelling === head.ownerSpelling,
      )
      let problem: 'ForeignOwner' | 'AliasOwner' | 'NotNominal' | undefined
      if (nominal === undefined || ownerDeclaration === undefined) {
        problem = owner.fact._tag === 'Resolved' ? 'NotNominal' : undefined
      } else if (localAlias || nominal.name !== head.ownerSpelling) {
        problem = 'AliasOwner'
      } else if (nominal.module !== module.module) {
        problem = 'ForeignOwner'
      } else {
        problem = undefined
      }
      if (problem === undefined) return { ...head, owner: owner.fact }
      const diagnostic = Diagnostic.invalidInherentHead(
        head.ownerSpelling,
        problem,
        head.owner._tag === 'Unavailable'
          ? Location.at(head.anchor)
          : Location.at(head.owner.anchor),
      )
      diagnostics.push(diagnostic)
      return {
        ...head,
        owner: owner.fact,
        validity: {
          _tag: 'Invalid' as const,
          cause: Diagnostic.identity(diagnostic),
        },
      }
    })
    // Every head whose owner resolved closes `Self` on its members, even a rejected one, so a
    // rejected member's body reports only the head's diagnostic and not a cascade about `Self`.
    const resolvedOwners = new Map(
      inherentImpls.flatMap((head) =>
        head.owner._tag === 'Resolved' && Type.isNominal(head.owner.type)
          ? [[head.ordinal, head.owner.type] as const]
          : [],
      ),
    )
    const inherentOwners = new Map(
      inherentImpls.flatMap((head) =>
        head.validity._tag === 'Valid' &&
        head.owner._tag === 'Resolved' &&
        Type.isNominal(head.owner.type)
          ? [[head.ordinal, head.owner.type] as const]
          : [],
      ),
    )
    interface OwnerItem {
      readonly kind: string
      readonly span: Location.Location
    }
    const ownerItemNames = (owner: Type.Nominal): ReadonlyMap<string, OwnerItem> => {
      const declaration = nominalOwnerDeclaration(headers, owner)
      const names = new Map<string, OwnerItem>()
      const add = (name: DeclaredName, kind: string): void => {
        if (name._tag === 'Present')
          names.set(name.spelling, { kind, span: Location.at(name.anchor) })
      }
      if (declaration?._tag === 'StructDeclaration')
        for (const field of declaration.fields) add(field.name, 'field')
      if (declaration?._tag === 'UnionDeclaration')
        for (const variant of declaration.variants) add(variant.name, 'variant')
      if (declaration?._tag === 'EnumDeclaration') {
        for (const member of declaration.members) add(member.name, 'member')
        names.set('value', {
          kind: 'generated operation',
          span: Location.at(declaration.anchor),
        })
      }
      if (
        declaration?._tag === 'ServiceDeclaration' ||
        declaration?._tag === 'InterfaceDeclaration'
      )
        for (const operation of declaration.operations) add(operation.name, 'operation')
      return names
    }
    const closedMembers = members.map((member): MemberFact => {
      if (member._tag !== 'FunctionDeclaration') return member
      if (member.conformanceImplementation !== undefined) {
        const provider = conformanceProviders.get(member.conformanceImplementation.ordinal)
        return provider === undefined
          ? member
          : closeConformanceSelf(member, member.conformanceImplementation.self, provider)
      }
      const association = member.associatedMember
      if (association === undefined) return member
      const owner = inherentOwners.get(association.ordinal)
      const unpublished = (): MemberFact => {
        const resolvedOwner = resolvedOwners.get(association.ordinal)
        const closed =
          resolvedOwner === undefined
            ? member
            : closeConformanceSelf(member, association.self, resolvedOwner)
        return member.canonical._tag === 'Canonical'
          ? {
              ...closed,
              canonical: { _tag: 'Unidentified' as const },
            }
          : closed
      }
      if (owner === undefined) return unpublished()
      const collision = ownerItemNames(owner).get(association.name)
      if (collision !== undefined && member.canonical._tag === 'Canonical') {
        diagnostics.push(
          Diagnostic.invalidInherentMember(
            association.ownerSpelling,
            association.name,
            'Collision',
            member.name._tag === 'Present'
              ? Location.at(member.name.anchor)
              : Location.at(member.anchor),
            collision.kind,
            collision.span,
          ),
        )
        return unpublished()
      }
      const closed = closeConformanceSelf(member, association.self, owner)
      // A member bound may name `Self` too (`U: Like<Self>`); close it to the owner and rebuild
      // the application so proof search sees the concrete capability.
      const selfSubstitution: Type.Substitution = new Map<string, Type.GenericArgument>([
        [Type.key(association.self), owner],
      ])
      const typeParameters = closed.typeParameters.map((parameter) =>
        parameter.bounds.length === 0
          ? parameter
          : {
              ...parameter,
              bounds: parameter.bounds.map((bound) => {
                if (bound._tag !== 'ResolvedBound') return bound
                const capability = Type.substitute(bound.application.capability, selfSubstitution)
                if (
                  !Type.isNominal(capability) ||
                  Type.equals(capability, bound.application.capability)
                )
                  return bound
                const declaration = memberByNominal(headers, capability)
                const application =
                  declaration?._tag === 'InterfaceDeclaration' ||
                  declaration?._tag === 'ServiceDeclaration'
                    ? interfaceApplication(declaration, capability, parameter.type)
                    : undefined
                return application === undefined ? bound : { ...bound, application }
              }),
            },
      )
      return {
        ...closed,
        typeParameters: typeParameters,
        associatedMember: {
          ...association,
          owner: {
            _tag: 'CanonicalDeclarationId' as const,
            module: owner.module,
            name: owner.name,
          },
        },
      }
    })
    // A conformance or inherent `Self` is closed only here, so environments are judged after it.
    for (const member of closedMembers)
      if (member._tag === 'FunctionDeclaration')
        diagnostics.push(...omittedEnvironmentDiagnostics(member))
    return {
      ...module,
      inherentImpls: inherentImpls,
      members: closedMembers,
      declarations: closedMembers.filter(
        (member): member is DeclarationFact => member._tag === 'FunctionDeclaration',
      ),
      structs: closedMembers.filter(
        (member): member is StructFact => member._tag === 'StructDeclaration',
      ),
      enums: closedMembers.filter(
        (member): member is EnumFact => member._tag === 'EnumDeclaration',
      ),
      unions: closedMembers.filter(
        (member): member is UnionFact => member._tag === 'UnionDeclaration',
      ),
      services: closedMembers.filter(
        (member): member is ServiceFact => member._tag === 'ServiceDeclaration',
      ),
      interfaces: closedMembers.filter(
        (member): member is InterfaceFact => member._tag === 'InterfaceDeclaration',
      ),
      constants: closedMembers.filter(
        (member): member is ConstantFact =>
          member._tag === 'ConstantDeclaration' || member._tag === 'PackageParameterDeclaration',
      ),
      conformances: conformances,
    }
  })

  // C-layout validation needs the whole resolved declaration graph: a field may embed a record
  // declared later or imported from another module. Invalid contracts keep the nominal available
  // to ordinary Silk tooling, but they do not retain the foreign-layout promise.
  const resolveCLayoutStruct = CLayout.resolveFrom(modules)
  modules = modules.map((module): ModuleHeaders => {
    const members = module.members.map((member): MemberFact => {
      if (member._tag !== 'StructDeclaration' || member.layout._tag !== 'Foreign') return member
      const record = member.name._tag === 'Present' ? member.name.spelling : '<anonymous>'
      let invalid = false
      if (member.typeParameters.length !== 0) {
        invalid = true
        diagnostics.push(
          Diagnostic.genericCLayoutRecord(
            record,
            Location.at(
              member.typeParametersAnchor ?? member.typeParameters[0]?.anchor ?? member.anchor,
            ),
          ),
        )
      }
      const admissions =
        member.typeParameters.length === 0 ? CLayout.admitFields(member, resolveCLayoutStruct) : []
      for (const [ordinal, field] of member.fields.entries()) {
        if (field.declaredType._tag !== 'Resolved') {
          invalid = true
          continue
        }
        const admission = admissions.at(ordinal)
        if (admission?._tag !== 'NotAdmitted') continue
        invalid = true
        diagnostics.push(
          Diagnostic.unsupportedCLayoutField(
            record,
            field.name._tag === 'Present' ? field.name.spelling : `${field.id.ordinal}`,
            field.declaredType.spelling,
            Location.at(field.declaredType.anchor),
          ),
        )
      }
      return invalid
        ? {
            ...member,
            layout: {
              _tag: 'InvalidForeign' as const,
              abi: member.layout.abi,
              abiSpan: member.layout.abiSpan,
            },
          }
        : member
    })
    return {
      ...module,
      members: members,
      structs: members.filter(
        (member): member is StructFact => member._tag === 'StructDeclaration',
      ),
    }
  })

  // Bounds may precede the interface they name, and the first completion pass intentionally reads
  // the old immutable module graph. Refresh only their applications now that every interface owns
  // resolved operation contracts; no witness selection or executable behavior is decided here.
  modules = modules.map((module): ModuleHeaders => {
    const members = module.members.map((member): MemberFact => {
      if (member._tag === 'EnumDeclaration') return member
      const typeParameters = refreshInterfaceApplications(member.typeParameters, modules)
      if (member._tag !== 'ServiceDeclaration' && member._tag !== 'InterfaceDeclaration')
        return { ...member, typeParameters }
      const operations = member.operations.map((operation) => ({
        ...operation,
        typeParameters: refreshInterfaceApplications(operation.typeParameters, modules),
      }))
      return {
        ...member,
        typeParameters,
        operations,
        operationContracts: interfaceOperationContracts(member, operations),
      }
    })
    const conformances = module.conformances.map((conformance) => {
      const capability =
        conformance.capability._tag === 'Resolved' && Type.isNominal(conformance.capability.type)
          ? conformance.capability.type
          : undefined
      const provider =
        conformance.provider._tag === 'Resolved' ? conformance.provider.type : undefined
      const declaration =
        capability === undefined ? undefined : memberByNominal(modules, capability)
      const application =
        capability !== undefined &&
        provider !== undefined &&
        (declaration?._tag === 'InterfaceDeclaration' || declaration?._tag === 'ServiceDeclaration')
          ? interfaceApplication(declaration, capability, provider)
          : undefined
      return {
        ...conformance,
        typeParameters: refreshInterfaceApplications(conformance.typeParameters, modules),
        operations: conformance.operations.map((operation) => {
          const contract = application?.operations.find(
            (candidate) =>
              operation.name._tag === 'Present' &&
              candidate.declaration.name._tag === 'Present' &&
              candidate.declaration.name.spelling === operation.name.spelling,
          )
          return {
            ...operation,
            ...(contract === undefined ? {} : { contract }),
          }
        }),
      }
    })
    return {
      ...module,
      members: members,
      declarations: members.filter(
        (member): member is DeclarationFact => member._tag === 'FunctionDeclaration',
      ),
      structs: members.filter(
        (member): member is StructFact => member._tag === 'StructDeclaration',
      ),
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
      conformances,
    }
  })

  // Coherence and termination are program-wide questions, so both are answered once every module's
  // headers have resolved and before any conformance body is validated. Overlap is decided on head
  // shapes alone: no bound is consulted, because whether a bound is satisfiable depends on the whole
  // program and would let one specialization silently change which witness it selects.
  const acceptedHeads: Array<{
    readonly module: string
    readonly ordinal: number
    readonly head: ConformanceHead.ConformanceHead
    readonly span: Location.Location
  }> = []
  modules = modules.map((module) => ({
    ...module,
    conformances: module.conformances.map((conformance): ConformanceFact => {
      if (
        conformance.capability._tag !== 'Resolved' ||
        !Type.isNominal(conformance.capability.type) ||
        conformance.provider._tag !== 'Resolved'
      )
        return conformance
      const requirements = declaredRequirements(modules, conformance)
      const head = ConformanceHead.make(
        conformance.capability.type,
        conformance.provider.type,
        requirements,
      )
      // A damaged requirement is retained on the conformance fact for diagnostics, but cannot
      // be shortened into a zero-obligation head. Header validation below reports the source
      // error; leaving termination unavailable keeps the fact out of coherence and proof search.
      if (requirements.length !== conformance.requirements.length) return { ...conformance, head }
      const contract = memberByNominal(modules, conformance.capability.type)
      if (
        (contract?._tag === 'InterfaceDeclaration' || contract?._tag === 'ServiceDeclaration') &&
        Type.isNominal(conformance.provider.type) &&
        !sourceConformanceOwners(
          conformance.capability.type,
          conformance.provider.type,
          contract,
        ).includes(module.module)
      )
        return { ...conformance, head }
      const failures = ConformanceHead.terminationFailures(head)
      if (failures.length > 0)
        diagnostics.push(
          Diagnostic.nonTerminatingConformance(
            ConformanceHead.encode(head),
            failures.map(ConformanceHead.describeTermination),
            Location.at(conformance.anchor),
          ),
        )
      // This is the one authority on whether two conformances may cover one provider. Two
      // unbounded headers with one identical shape are the case a reader recognizes as a
      // duplicate and are named that way; two headers a bound is the only difference between
      // are reported as the overlap they are, because calling them duplicates would suggest the
      // bounds were compared. Comparing the alpha-normalized heads is what makes the two tests
      // agree — keying the duplicate check on unnormalized capabilities, as an earlier version
      // did, let exactly the bound-distinguished pair match neither and survive.
      const headKey = ConformanceHead.key(head)
      const overlapping = acceptedHeads.find((candidate) =>
        ConformanceHead.mayOverlap(candidate.head, head),
      )
      if (overlapping === undefined)
        acceptedHeads.push({
          module: module.module,
          ordinal: conformance.ordinal,
          head,
          span: Location.at(conformance.anchor),
        })
      else if (
        ConformanceHead.key(overlapping.head) === headKey &&
        head.requirements.length === 0 &&
        overlapping.head.requirements.length === 0
      )
        diagnostics.push({
          ...Diagnostic.invalidConformance(
            `duplicate ${conformance.capability.type.name} implementation for ${Type.encode(conformance.provider.type)}`,
            Location.at(conformance.anchor),
          ),
          relatedSpans: [{ label: 'first implementation', span: overlapping.span }],
        })
      else
        diagnostics.push(
          Diagnostic.overlappingConformance(
            ConformanceHead.encode(head),
            ConformanceHead.encode(overlapping.head),
            Location.at(conformance.anchor),
            overlapping.span,
          ),
        )
      return {
        ...conformance,
        head,
        coherence:
          overlapping === undefined
            ? { _tag: 'Coherent' as const }
            : {
                _tag: 'Overlapping' as const,
                module: overlapping.module,
                ordinal: overlapping.ordinal,
              },
        termination:
          failures.length === 0
            ? { _tag: 'Terminating' as const }
            : { _tag: 'NonTerminating' as const, failures },
      }
    }),
  }))

  const invalidConformances = new Set<ConformanceFact>()
  const inferredWitnessArguments = new Map<
    ConformanceFact['operations'][number],
    ReadonlyArray<Type.GenericArgument>
  >()
  for (const module of modules) {
    for (const conformance of module.conformances) {
      const markInvalid = (): void => {
        invalidConformances.add(conformance)
      }
      const rejectConformance = <A extends Diagnostic.Located>(diagnostic: A): A => {
        markInvalid()
        return diagnostic
      }
      const invalidDiagnostic = (detail: string, span: Location.Location): Diagnostic.Located =>
        rejectConformance(Diagnostic.invalidConformance(detail, span))
      if (
        conformance.capability._tag !== 'Resolved' ||
        !Type.isNominal(conformance.capability.type) ||
        conformance.provider._tag !== 'Resolved'
      ) {
        diagnostics.push(
          invalidDiagnostic(
            'the capability must resolve to a nominal type and the provider must resolve to a type',
            Location.at(conformance.anchor),
          ),
        )
        continue
      }
      const capability = conformance.capability.type
      const provider = conformance.provider.type
      const sourceMember = memberByNominal(modules, capability)
      const sourceContract =
        sourceMember?._tag === 'InterfaceDeclaration' || sourceMember?._tag === 'ServiceDeclaration'
          ? sourceMember
          : undefined
      const conformanceOwners =
        sourceContract === undefined
          ? []
          : sourceConformanceOwners(capability, provider, sourceContract)
      if (sourceContract !== undefined && conformanceOwners.length === 0) {
        diagnostics.push(
          invalidDiagnostic(
            'interface and service providers must be nominal types, scalar types, or string',
            Location.at(conformance.anchor),
          ),
        )
        continue
      }
      if (sourceContract !== undefined && !conformanceOwners.includes(conformance.module)) {
        let ownership: string
        if (!Type.isNominal(provider))
          ownership = "the contract's module for scalar and string providers"
        else if (sourceContract._tag === 'InterfaceDeclaration')
          ownership = "the interface's or provider's module"
        else ownership = "the provider's module"
        diagnostics.push(
          invalidDiagnostic(
            `implementation for ${Type.encode(provider)} must be declared in ${conformanceOwners.join(' or ')}, ${ownership}`,
            Location.at(conformance.anchor),
          ),
        )
        continue
      }
      if (sourceContract !== undefined && !Type.isTypeArgument(provider)) {
        diagnostics.push(
          invalidDiagnostic(
            'interface and service providers must be concrete value types',
            Location.at(conformance.anchor),
          ),
        )
        continue
      }
      const declaredParameters = conformance.typeParameters
        .filter((parameter) => parameter.duplicateOf === undefined)
        .map((parameter) => parameter.type)
      // Source interface and service arguments may mention the header's binders, because one
      // parametric provider may implement one equally parametric source capability. Compiler-sealed
      // capabilities remain concrete.
      if (
        !Type.isConcrete(capability) &&
        (sourceContract === undefined || declaredParameters.length === 0)
      ) {
        diagnostics.push(
          invalidDiagnostic(
            'the capability must be concrete; impl type parameters may only bind the provider',
            Location.at(conformance.anchor),
          ),
        )
        continue
      }
      // This predicate is the exact complement of what `declaredRequirements` admits. They have to
      // agree: a requirement the reader accepts but the reader of obligations drops would be a
      // bound nothing ever proves.
      const unstatedRequirement = conformance.requirements.find((requirement) => {
        if (requirement.capability._tag !== 'Resolved') return true
        const applied = requirement.capability.type
        if (!Type.isNominal(applied)) return true
        const declaration = memberByNominal(modules, applied)
        return (
          !Type.equals(applied, Type.copyCapability) &&
          declaration?._tag !== 'InterfaceDeclaration' &&
          declaration?._tag !== 'ServiceDeclaration'
        )
      })
      if (unstatedRequirement !== undefined) {
        diagnostics.push(
          invalidDiagnostic(
            `requirement ${unstatedRequirement.spelling} must be an interface or service contract`,
            Location.at(unstatedRequirement.anchor),
          ),
        )
        continue
      }
      if (conformance.termination._tag === 'NonTerminating') continue
      if (conformance.coherence._tag === 'Overlapping') continue
      // A source interface application is part of the witness head, so it can determine a binder
      // even when one reusable provider stores no value of that type. Sealed capabilities still
      // bind parameters through the provider alone. Coherence and proof inference use both heads.
      const usedParameterKeys = new Set([
        ...Type.parameters(provider).map(Type.key),
        ...Type.freeLifetimes(provider).map(Lifetime.key),
        ...(sourceContract === undefined
          ? []
          : [
              ...Type.parameters(capability).map(Type.key),
              ...Type.freeLifetimes(capability).map(Lifetime.key),
            ]),
      ])
      const unused = conformance.typeParameters
        .filter((parameter) => parameter.duplicateOf === undefined)
        .filter((parameter) => !usedParameterKeys.has(Type.key(parameter.type)))
      if (unused.length > 0) {
        diagnostics.push(
          invalidDiagnostic(
            `impl type parameter ${unused.map((parameter) => parameter.type.name).join(', ')} is not used by the ${sourceContract === undefined ? 'provider type' : 'conformance head'}`,
            Location.at(conformance.anchor),
          ),
        )
        continue
      }
      if (sourceContract !== undefined) {
        if (conformance.hook !== undefined) {
          diagnostics.push(
            invalidDiagnostic(
              `${capability.name} implementations use operation mappings, not a hook body`,
              Location.at(conformance.hook.anchor),
            ),
          )
          continue
        }
        const mapped = new Map<string, ConformanceFact['operations'][number]>()
        let invalid = false
        for (const mapping of conformance.operations) {
          if (mapping.name._tag !== 'Present') {
            markInvalid()
            invalid = true
            continue
          }
          if (mapped.has(mapping.name.spelling)) {
            diagnostics.push(
              invalidDiagnostic(
                `duplicate ${capability.name}.${mapping.name.spelling} operation mapping`,
                Location.at(mapping.anchor),
              ),
            )
            invalid = true
          } else mapped.set(mapping.name.spelling, mapping)
        }
        const operationNames = new Set(
          sourceContract.operations.flatMap((operation) =>
            operation.name._tag === 'Present' ? [operation.name.spelling] : [],
          ),
        )
        const missing = [...operationNames].filter((name) => !mapped.has(name))
        const extra = [...mapped.keys()].filter((name) => !operationNames.has(name))
        if (missing.length > 0 || extra.length > 0) {
          diagnostics.push(
            invalidDiagnostic(
              [
                ...(missing.length === 0 ? [] : [`missing ${missing.join(', ')}`]),
                ...(extra.length === 0 ? [] : [`unknown ${extra.join(', ')}`]),
              ].join('; '),
              Location.at(conformance.anchor),
            ),
          )
          invalid = true
        }
        const substitution = TypeInference.substitution(
          sourceContract.typeParameters.map((parameter) => parameter.type),
          capability.arguments,
        )
        if (substitution === undefined) {
          diagnostics.push(
            invalidDiagnostic(
              `${capability.name} implementation has the wrong interface type-argument arity`,
              Location.at(conformance.anchor),
            ),
          )
          continue
        }
        if (invalid) continue
        const interfaceProviderModule = Type.isNominal(provider)
          ? modules.find((candidate) => candidate.module === provider.module)
          : undefined
        const conformanceModule = modules.find(
          (candidate) => candidate.module === conformance.module,
        )
        for (const contract of sourceContract.operations) {
          if (contract.name._tag !== 'Present') continue
          const mapping = mapped.get(contract.name.spelling)
          if (mapping === undefined) continue
          const target = mapping.target
          const contractName = contract.name.spelling
          const rejectIncompatibleMapping = (detail?: string): void => {
            diagnostics.push(
              invalidDiagnostic(
                `${target._tag === 'TypePath' ? target.spelling : '_'} is incompatible with ${capability.name}.${contractName}${detail === undefined ? '' : `: ${detail}`}`,
                Location.at(mapping.anchor),
              ),
            )
          }
          // Every witness uses the applied contract's literal operands. Source functions and
          // sealed intrinsics are checked by the same ownership rules.
          const mappedProviderTarget =
            mapping.form === 'Mapped' &&
            Type.isNominal(provider) &&
            target._tag === 'TypePath' &&
            target.segments.length === 2 &&
            target.segments.at(0)?.spelling === provider.name &&
            target.segments.at(0)?.spelling !== 'Intrinsic'
          const inlineTarget = mapping.form === 'Inline' && target._tag === 'TypePath'
          if (inlineTarget || mappedProviderTarget) {
            const targetName = target.segments.at(1)?.spelling
            let implementation: DeclarationFact | undefined
            if (mapping.form === 'Inline') {
              implementation = conformanceModule?.declarations.find(
                (declaration) =>
                  declaration.conformanceImplementation?.ordinal === conformance.ordinal &&
                  declaration.conformanceImplementation.operation === contractName,
              )
            } else if (interfaceProviderModule !== undefined && targetName !== undefined) {
              implementation = providerOperation(
                interfaceProviderModule,
                target.segments.at(0)?.spelling ?? '',
                targetName,
              )
            }
            if (implementation === undefined) {
              diagnostics.push(
                invalidDiagnostic(
                  mapping.form === 'Inline'
                    ? `inline operation ${capability.name}.${contractName} does not exist`
                    : `mapped operation ${Type.isNominal(provider) ? provider.name : Type.encode(provider)}.${targetName ?? '_'} does not exist`,
                  Location.at(mapping.anchor),
                ),
              )
              continue
            }
            const inference = inferInterfaceWitnessTarget(implementation, mapping.contract)
            if (inference === undefined || inference._tag === 'Failed') {
              if (inference?._tag === 'Failed') {
                const problem = inference.problem
                if (problem._tag === 'IncompatibleConstraint') {
                  rejectIncompatibleMapping()
                  continue
                }
                let detail: string
                if (problem._tag === 'UnresolvedBinder') {
                  detail = `cannot infer witness target binder ${problem.binder.name}`
                } else if (problem._tag === 'ConflictingBinder') {
                  detail = `witness target binder ${problem.binder.name} is ${Type.encodeGenericArgument(problem.previous)} from ${problem.previousConstraint} but ${Type.encodeGenericArgument(problem.conflicting)} from ${problem.conflictingConstraint}`
                } else {
                  detail = `witness target binder ${problem.binder.name} cannot accept ${Type.encodeGenericArgument(problem.argument)}`
                }
                diagnostics.push(
                  invalidDiagnostic(`${target.spelling}: ${detail}`, Location.at(mapping.anchor)),
                )
              } else rejectIncompatibleMapping()
              continue
            }
            const binding = witnessBinding(implementation, declaredParameters)
            // A witness may only ask for what the header already promises. Its own bounds are the
            // obligations its body will discharge, so a bound the header never requires would be
            // proved nowhere and would surface as a call with no lowering rather than a diagnostic.
            const unpromisedBound = unpromisedWitnessBound(
              binding,
              inference.arguments,
              conformance,
            )
            if (unpromisedBound !== undefined) {
              diagnostics.push(
                invalidDiagnostic(
                  `${target.spelling} requires ${unpromisedBound.bound.spelling} for ${unpromisedBound.binder.type.name}, which ${capability.name} for ${Type.encode(provider)} does not require`,
                  Location.at(mapping.anchor),
                ),
              )
              continue
            }
            // Its `where` constraints follow the same rule: each must be a premise of the header or
            // of the implemented operation, read over the header's own binders.
            const operationSubstitution = TypeInference.substitution(
              [
                sourceContract.self,
                ...sourceContract.typeParameters.map((parameter) => parameter.type),
              ],
              [provider, ...capability.arguments],
            )
            const unpromisedConstraint =
              operationSubstitution === undefined || mapping.contract === undefined
                ? undefined
                : unpromisedWitnessConstraint(implementation, inference.substitution, [
                    ...conformance.constraintContracts,
                    ...mapping.contract.declaration.constraintContracts.map((constraint) =>
                      Constraint.substitute(constraint, operationSubstitution),
                    ),
                  ])
            if (unpromisedConstraint !== undefined) {
              diagnostics.push(
                invalidDiagnostic(
                  `${target.spelling} requires a where constraint on ${unpromisedConstraint._tag === 'ProviderSelectionConstraint' ? Type.encode(unpromisedConstraint.provider) : 'its rows'}, which ${capability.name} for ${Type.encode(provider)} does not require`,
                  Location.at(mapping.anchor),
                ),
              )
              continue
            }
            const compatibility = interfaceWitnessCompatibility(
              mapping.contract,
              implementation,
              inference.substitution,
              conformance.typeParameters,
            )
            if (compatibility === undefined || compatibility._tag === 'Incompatible')
              rejectIncompatibleMapping(
                compatibility === undefined
                  ? undefined
                  : InterfaceWitnessCompatibility.describe(compatibility),
              )
            else inferredWitnessArguments.set(mapping, inference.arguments)
            continue
          }
          if (mapping.form === 'Inline') {
            rejectIncompatibleMapping('inline witness target is unavailable')
            continue
          }
          if (
            isContractOwnedInlineProvider(provider) &&
            mapping.form === 'Mapped' &&
            (target._tag !== 'TypePath' || target.segments.at(0)?.spelling !== 'Intrinsic')
          ) {
            rejectIncompatibleMapping('scalar and string source witnesses must be declared inline')
            continue
          }
          const operation =
            target._tag === 'TypePath' &&
            target.segments.length === 2 &&
            target.segments.at(0)?.spelling === 'Intrinsic'
              ? Intrinsic.findOperation('Intrinsic', target.segments.at(1)?.spelling ?? '')
              : undefined
          const builtin =
            operation !== undefined && Intrinsic.isBuiltinOperation(operation)
              ? operation
              : undefined
          const parameters = builtin?.callParameters
          const result =
            builtin === undefined ? undefined : Intrinsic.closedResultType(builtin.rule.result)
          const compatibility =
            parameters === undefined || result === undefined
              ? undefined
              : sealedWitnessCompatibility(mapping.contract, parameters, result)
          if (
            operation === undefined ||
            operation.unsafe ||
            compatibility === undefined ||
            compatibility._tag === 'Incompatible'
          )
            rejectIncompatibleMapping(
              compatibility === undefined
                ? undefined
                : InterfaceWitnessCompatibility.describe(compatibility),
            )
        }
        continue
      }

      if (Type.equals(capability, Type.copyCapability) && !Type.isNominal(provider)) {
        diagnostics.push(
          invalidDiagnostic(
            `Copy cannot be implemented for structural provider ${Type.encode(provider)}; shared references are compiler-proven Copy and every other structural type follows its sealed rule`,
            Location.at(conformance.anchor),
          ),
        )
        continue
      }

      if (!Type.isNominal(provider)) continue

      const providerEnum = modules
        .flatMap((candidate) => candidate.enums)
        .find(
          (candidate) =>
            candidate.canonical._tag === 'Canonical' &&
            candidate.canonical.id.module === provider.module &&
            candidate.canonical.id.name === provider.name,
        )
      if (
        providerEnum !== undefined &&
        (Type.equals(capability, Type.copyCapability) ||
          Type.equals(capability, Type.dropCapability))
      ) {
        diagnostics.push(
          invalidDiagnostic(
            `scalar enum ${Type.encode(provider)} has sealed compiler-proved Copy semantics and cannot implement ${capability.name}`,
            Location.at(conformance.anchor),
          ),
        )
        continue
      }

      if (Type.equals(capability, Type.copyCapability)) {
        if (
          Type.isIntrinsicNominal(provider) ||
          provider.module !== conformance.module ||
          conformance.operations.length !== 0 ||
          conformance.hook !== undefined
        ) {
          diagnostics.push(
            invalidDiagnostic(
              'Copy requires one empty impl on a struct declared in the same module',
              Location.at(conformance.anchor),
            ),
          )
        }
        continue
      }

      if (Type.equals(capability, Type.dropCapability)) {
        const hook = conformance.hook
        if (conformance.operations.length !== 0 || hook === undefined) {
          diagnostics.push(
            rejectConformance(
              Diagnostic.invalidDropHook(
                'Drop requires one inline fn drop hook and no operation mappings',
                Location.at(conformance.anchor),
              ),
            ),
          )
          continue
        }
        const parameter = hook.parameterType
        const validSelf =
          parameter._tag === 'Resolved' &&
          Type.isReference(parameter.type) &&
          parameter.type.access === 'Exclusive' &&
          Type.equals(parameter.type.target, provider)
        if (
          hook.name._tag !== 'Present' ||
          hook.name.spelling !== 'drop' ||
          hook.functionKind !== 'Ordinary' ||
          hook.typeParameterCount !== 0 ||
          hook.parameterCount !== 1 ||
          hook.parameterName._tag !== 'Present' ||
          hook.parameterName.spelling !== 'self' ||
          !validSelf ||
          hook.returnType._tag !== 'Resolved' ||
          !Type.equals(hook.returnType.type, Type.unit) ||
          hook.failureRow.failures.length !== 0 ||
          hook.requirementRow.requirements.length !== 0
        ) {
          diagnostics.push(
            rejectConformance(
              Diagnostic.invalidDropHook(
                'the hook must be fn drop(self: &mut Provider) -> () with no generics, failures, or requirements',
                Location.at(hook.anchor),
              ),
            ),
          )
        }
        continue
      }

      diagnostics.push(
        invalidDiagnostic(
          `unsupported compiler-sealed capability ${Type.encode(capability)}`,
          Location.at(conformance.anchor),
        ),
      )
    }
  }

  modules = modules.map((module) => ({
    ...module,
    conformances: module.conformances.map((conformance) => ({
      ...conformance,
      operations: conformance.operations.map((operation) => {
        const targetArguments = inferredWitnessArguments.get(operation)
        return targetArguments === undefined ? operation : { ...operation, targetArguments }
      }),
      validity:
        invalidConformances.has(conformance) ||
        conformance.coherence._tag !== 'Coherent' ||
        conformance.termination._tag !== 'Terminating'
          ? { _tag: 'InvalidConformance' as const }
          : { _tag: 'ValidConformance' as const },
    })),
  }))

  // Copy syntax is validated above; now validate the property over the complete provisional field
  // graph before any downstream phase can observe the conformances as evidence.
  const provisionalCopyIndex = DeclarationIndex.make('Complete', modules, [])
  const invalidCopyKeys = new Set<string>()
  for (const module of modules) {
    for (const conformance of module.conformances) {
      if (
        conformance.validity._tag !== 'ValidConformance' ||
        conformance.capability._tag !== 'Resolved' ||
        !Type.equals(conformance.capability.type, Type.copyCapability) ||
        conformance.provider._tag !== 'Resolved'
      )
        continue
      const proof = copyProof(
        provisionalCopyIndex,
        conformance.provider.type,
        copyAssumptions(conformance),
      )
      if (
        proof._tag === 'Copy' ||
        (proof._tag === 'UnavailableCopy' &&
          proof.reason.includes('executable Copy depends on its concrete realized captures'))
      )
        continue
      invalidCopyKeys.add(`${module.module}\u0000${conformance.ordinal}`)
      diagnostics.push(
        Diagnostic.invalidConformance(
          `Copy cannot be implemented for ${Type.encode(conformance.provider.type)}: ${proof.reason}`,
          Location.at(conformance.anchor),
        ),
      )
    }
  }
  if (invalidCopyKeys.size > 0)
    modules = modules.map((module) => ({
      ...module,
      conformances: module.conformances.map((conformance) =>
        invalidCopyKeys.has(`${module.module}\u0000${conformance.ordinal}`)
          ? {
              ...conformance,
              validity: { _tag: 'InvalidConformance' as const },
            }
          : conformance,
      ),
    }))

  // A declared borrowed type is admitted through its elaborated lifetime contract. Concrete
  // referent validity is checked in body analysis, including fields and returned aggregates.
  for (const module of modules) {
    for (const member of module.members) {
      if (member._tag === 'ServiceDeclaration' || member._tag === 'InterfaceDeclaration') {
        for (const operation of member.operations)
          for (const parameter of operation.parameters) {
            if (parameter.bindingMutability === 'Mutable')
              diagnostics.push(
                Diagnostic.invalidMutableParameter('Contract', Location.at(parameter.anchor)),
              )
          }
      }
    }
  }

  modules = modules.map((module): ModuleHeaders => {
    const members = module.members.map((member): MemberFact => {
      if (member.visibility !== 'Public') return member
      // The alias resolver attached exposure when it erased the target.
      if (member._tag === 'AliasDeclaration') return member
      if (member._tag === 'ConstantDeclaration' || member._tag === 'PackageParameterDeclaration') {
        return {
          ...member,
          declaredType: attachExposure(spanOf, member.declaredType, modules, diagnostics),
        }
      }
      if (member._tag === 'FunctionDeclaration') {
        const parameters = member.parameters.map((parameter) => ({
          ...parameter,
          declaredType: attachExposure(spanOf, parameter.declaredType, modules, diagnostics),
        }))
        return {
          ...member,
          parameters: parameters,
          returnType: attachExposure(spanOf, member.returnType, modules, diagnostics),
          failureRow: {
            ...member.failureRow,
            members: member.failureRow.members.map((failure) =>
              attachExposure(spanOf, failure, modules, diagnostics),
            ),
          },
        }
      }
      if (member._tag === 'ServiceDeclaration' || member._tag === 'InterfaceDeclaration') {
        const operations = member.operations.map((operation) => ({
          ...operation,
          parameters: operation.parameters.map((parameter) => ({
            ...parameter,
            declaredType: attachExposure(spanOf, parameter.declaredType, modules, diagnostics),
          })),
          returnType: attachExposure(spanOf, operation.returnType, modules, diagnostics),
          failureRow: {
            ...operation.failureRow,
            members: operation.failureRow.members.map((failure) =>
              attachExposure(spanOf, failure, modules, diagnostics),
            ),
          },
        }))
        const exposed = { ...member, operations: operations }
        return {
          ...exposed,
          operationContracts: interfaceOperationContracts(exposed, operations),
        }
      }
      if (member._tag === 'RoleDeclaration' || member._tag === 'EnumDeclaration') return member
      const exposeFields = (fields: StructFact['fields']): StructFact['fields'] =>
        fields.map((field) =>
          field.visibility === 'Public'
            ? {
                ...field,
                declaredType: attachExposure(spanOf, field.declaredType, modules, diagnostics),
              }
            : field,
        )
      return member._tag === 'UnionDeclaration'
        ? {
            ...member,
            variants: member.variants.map((variant) => ({
              ...variant,
              fields: exposeFields(variant.fields),
            })),
          }
        : { ...member, fields: exposeFields(member.fields) }
    })
    return {
      ...module,
      members: members,
      declarations: members.filter(
        (member): member is DeclarationFact => member._tag === 'FunctionDeclaration',
      ),
      structs: members.filter(
        (member): member is StructFact => member._tag === 'StructDeclaration',
      ),
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
    }
  })

  const aggregates = modules.flatMap((module) => [...module.structs, ...module.unions])
  // One graph, two readers: the component walk and the self-edge test below must agree about what
  // "inline" means, or a struct that reaches itself through an indirection is a component of one
  // in the first and a cycle in the second.
  const inlineParameters = inlineParametersOf(aggregates)
  const cycleCause = new Map<string, Diagnostic.Identity<Location.Location>>()
  for (const component of stronglyConnected(aggregates, inlineParameters)) {
    const first = component.at(0)
    if (first === undefined) continue
    const keys = component.flatMap((struct) =>
      struct.canonical._tag === 'Canonical' ? [canonicalKey(struct.canonical.id)] : [],
    )
    const selfEdge =
      keys.length === 1 &&
      (first._tag === 'StructDeclaration'
        ? first.fields
        : first.variants.flatMap((variant) => variant.fields)
      ).some((field) =>
        inlineNeighbors(field, inlineParameters).some((neighbor) => neighbor === keys[0]),
      )
    if (keys.length < 2 && !selfEdge) continue
    const diagnostic = Diagnostic.inlineRecursiveAggregate(
      keys,
      first.name._tag === 'Present' ? Location.at(first.name.anchor) : Location.at(first.anchor),
    )
    diagnostics.push(diagnostic)
    const cause = Diagnostic.identity(diagnostic)
    for (const key of keys) cycleCause.set(key, cause)
  }

  modules = modules.map((module): ModuleHeaders => {
    const members = module.members.map((member): MemberFact => {
      if (member._tag !== 'StructDeclaration' && member._tag !== 'UnionDeclaration') return member
      const fields =
        member._tag === 'StructDeclaration'
          ? member.fields
          : member.variants.flatMap((variant) => variant.fields)
      const dependencyMap = new Map<string, Type.Nominal>()
      for (const field of fields) {
        if (field.declaredType._tag === 'Resolved') {
          for (const type of Type.nominals(field.declaredType.type)) {
            dependencyMap.set(Type.key(type), type)
          }
        }
      }
      const dependencies = [...dependencyMap.values()].sort(Type.compare)
      const fieldCause = fields.find(
        (field) =>
          (field.declaredType._tag === 'Unresolved' && field.declaredType.cause !== undefined) ||
          (field.declaredType._tag === 'Resolved' &&
            field.declaredType.exposureCause !== undefined),
      )
      const key =
        member.canonical._tag === 'Canonical' ? canonicalKey(member.canonical.id) : undefined
      let fieldDependencyCause: Diagnostic.Identity<Location.Location> | undefined
      if (fieldCause?.declaredType._tag === 'Unresolved') {
        fieldDependencyCause = fieldCause.declaredType.cause
      } else if (fieldCause?.declaredType._tag === 'Resolved') {
        fieldDependencyCause = fieldCause.declaredType.exposureCause
      }
      const cause = (key === undefined ? undefined : cycleCause.get(key)) ?? fieldDependencyCause
      const dependency =
        cause === undefined
          ? { _tag: 'Available' as const, types: dependencies }
          : { _tag: 'Unavailable' as const, types: dependencies, cause }
      if (member._tag === 'UnionDeclaration' && cause !== undefined)
        return {
          ...member,
          dependency,
          validity: {
            _tag: 'Invalid' as const,
            causes: [...(member.validity._tag === 'Invalid' ? member.validity.causes : []), cause],
          },
        }
      return {
        ...member,
        dependency,
      }
    })
    const moduleDiagnostics = diagnostics.filter(
      (diagnostic) => Location.moduleOf(diagnostic.span) === module.module,
    )
    return {
      ...module,
      members: members,
      declarations: members.filter(
        (member): member is DeclarationFact => member._tag === 'FunctionDeclaration',
      ),
      structs: members.filter(
        (member): member is StructFact => member._tag === 'StructDeclaration',
      ),
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
      diagnostics: Diagnostic.collect(moduleDiagnostics),
    }
  })

  const lifetimeScope = TypeOutlives.context(modules)
  modules = modules.map((module) => {
    const moduleContext = registry.contexts.get(module.module)
    const lifetimeDiagnostics =
      moduleContext === undefined ? [] : TypeOutlives.moduleDiagnostics(module, lifetimeScope)
    diagnostics.push(...lifetimeDiagnostics)
    return {
      ...module,
      diagnostics: Diagnostic.collect(module.diagnostics, lifetimeDiagnostics),
    }
  })

  return DeclarationIndex.make('Complete', modules, Diagnostic.collect(diagnostics))
}
