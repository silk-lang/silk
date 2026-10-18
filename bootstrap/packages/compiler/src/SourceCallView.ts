import * as AuthoredIdentity from './AuthoredIdentity.js'
import * as BodyView from './BodyView.js'
import * as CallableContract from './CallableContract.js'
import * as ConformanceProof from './ConformanceProof.js'
import * as DeclarationFacts from './DeclarationFacts.js'
import * as ExecutableInputView from './ExecutableInputView.js'
import type { FunctionLowering } from './FunctionLowering.js'
import * as Instances from './Instances.js'
import * as Lifetime from './Lifetime.js'
import type * as Layout from './Layout.js'
import type { ProvidedRequirement } from './Lower.js'
import * as NominalVariance from './NominalVariance.js'
import * as StaticValue from './StaticValue.js'
import * as Tir from './Tir.js'
import * as Type from './Type.js'
import * as TypeCompatibility from './TypeCompatibility.js'
import * as EffectExecutionContract from './internal/EffectExecutionContract.js'
import * as TypeInference from './internal/TypeInference.js'

/** A service call's public view, checked against its original selected implementation. */
export interface SourceCallView {
  readonly caller: Instances.Instance
  readonly call: Instances.CallInstance
  readonly implementation: Instances.Instance
  readonly sourceService: DeclarationFacts.ServiceFact
  readonly sourceOperation: DeclarationFacts.ServiceOperationFact
  readonly conformance: DeclarationFacts.ConformanceFact
  readonly operationMapping: DeclarationFacts.ConformanceFact['operations'][number]
  readonly sourceParameters: ReadonlyArray<Type.Type>
  readonly implementationParameters: ReadonlyArray<Type.Type>
  readonly publicContract: Type.Effect
  readonly physicalContract: Type.Effect
  readonly invocationContract: Type.Effect
}

/** A selected exclusive/owned provider may lend a shared receiver for this operation. */
export const serves = (
  provider: ProvidedRequirement,
  access: Type.Requirement['access'],
): boolean => {
  const admits = (required: Type.Requirement['access']): boolean =>
    required === 'Shared' ||
    provider.access === 'Take' ||
    (required === 'Exclusive' && provider.access === 'Exclusive')
  return admits(provider.requirementAccess) && admits(access)
}

/** Completion may retain separate fact objects for the same original source declaration. */
const sameOperation = (
  self: DeclarationFacts.ServiceOperationFact,
  other: DeclarationFacts.ServiceOperationFact,
  service: DeclarationFacts.ServiceFact,
): boolean =>
  self.id.sourceId === other.id.sourceId &&
  self.id.ordinal === other.id.ordinal &&
  AuthoredIdentity.anchorKey(self.anchor) === AuthoredIdentity.anchorKey(other.anchor) &&
  self.state._tag === 'Unique' &&
  other.state._tag === 'Unique' &&
  self.state.id.name === other.state.id.name &&
  self.state.id.service.sourceId === other.state.id.service.sourceId &&
  self.state.id.service.ordinal === other.state.id.service.ordinal &&
  self.parameterCount === other.parameterCount &&
  self.parameters.length === other.parameters.length &&
  self.parameters.every((parameter, ordinal) => {
    const original = other.parameters.at(ordinal)
    return (
      original !== undefined &&
      parameter.phase === original.phase &&
      parameter.id.ordinal === original.id.ordinal &&
      parameter.id.function.sourceId === original.id.function.sourceId &&
      parameter.id.function.ordinal === original.id.function.ordinal
    )
  }) &&
  Tir.contractOf(self)._tag === 'Contract' &&
  CallableContract.key(DeclarationFacts.callableContract(self, service.typeParameters)) ===
    CallableContract.key(DeclarationFacts.callableContract(other, service.typeParameters))

const realizedAccess = (
  instances: ReadonlyArray<Instances.Instance>,
  calls: ReadonlyArray<Instances.CallInstance>,
  layout: Layout.Plan,
  index: FunctionLowering['index'],
  implementation: Instances.Instance,
  environment: Extract<Layout.EffectEnvironment, { readonly _tag: 'EffectEnvironment' }>,
): Type.Effect['access'] | undefined => {
  if (
    !('root' in environment.site) ||
    Tir.artifactKey(environment.site.artifact) !== Tir.artifactKey(implementation.view.artifact)
  )
    return undefined
  const roots = implementation.function.statements
    .flatMap(Tir.statementExpressions)
    .flatMap(Tir.expressionTree)
    .filter(
      (expression): expression is Extract<Tir.Expression, { readonly _tag: 'EffectBlock' }> =>
        expression._tag === 'EffectBlock' &&
        Tir.sameExecutableSite(expression.site, environment.site),
    )
  const root = roots.at(0)
  if (
    roots.length !== 1 ||
    root === undefined ||
    root.captures.length !== environment.fields.length
  )
    return undefined
  const ordinals = new Set<number>()
  const context = compatibility(index, implementation)
  if (context === undefined) return undefined
  for (const [ordinal, capture] of root.captures.entries()) {
    const field = environment.fields.at(ordinal)
    const runtimeOrdinal =
      capture.parameter === undefined
        ? undefined
        : Instances.runtimeParameterOrdinal(implementation.function, capture.parameter.ordinal)
    const parameter =
      runtimeOrdinal === undefined
        ? undefined
        : implementation.specialization.parameters.at(runtimeOrdinal)
    const capturedEffect =
      field === undefined ||
      parameter === undefined ||
      (Type.equals(field.type, parameter) && field.access === capture.access)
        ? undefined
        : ExecutableInputView.capturedEffect(
            instances,
            calls,
            layout,
            implementation,
            field,
            context,
          )
    if (
      field === undefined ||
      capture.parameter === undefined ||
      capture.binding !== undefined ||
      capture.pattern !== undefined ||
      field.source !== 'Parameter' ||
      field.ordinal !== capture.parameter.ordinal ||
      ordinals.has(field.ordinal) ||
      parameter === undefined ||
      (!Type.equals(field.type, parameter) && capturedEffect === undefined)
    )
      return undefined
    ordinals.add(field.ordinal)
    if (field.access !== (capturedEffect?.type.access ?? capture.access)) return undefined
  }
  if (environment.fields.some((field) => field.access === 'Take')) return 'Take'
  if (environment.fields.some((field) => field.access === 'Exclusive')) return 'Exclusive'
  return 'Shared'
}

/** Replays finite source edges locally; they are never antecedents for a rigid invocation binder. */
const compatibility = (
  index: FunctionLowering['index'],
  caller: Instances.Instance,
): TypeCompatibility.Context | undefined => {
  const held = caller.view.lifetimes
  const premises = held?.sourcePremises
  if (
    held === undefined ||
    premises === undefined ||
    held.diagnostics.length !== 0 ||
    held.solution._tag !== 'Solved' ||
    held.solution.violations.length !== 0
  )
    return undefined
  const bound = (self: Lifetime.Outlives): Lifetime.Outlives => ({
    longer: Type.substituteLifetime(self.longer, caller.substitution),
    shorter: Type.substituteLifetime(self.shorter, caller.substitution),
  })
  const finite = Lifetime.assumptions(held.input.constraints.map(bound))
  return TypeCompatibility.context({
    nominalVariance: new Map([
      ...NominalVariance.derive(index).summaries,
      ...(caller.specialization.compatibility?.nominalVariance ?? new Map()),
    ]),
    assumptions: Lifetime.assumptions(premises.assumptions.bounds.map(bound)),
    typeBounds: premises.typeBounds.map((self) => ({
      type: Type.substitute(self.type, caller.substitution),
      lifetime: Type.substituteLifetime(self.lifetime, caller.substitution),
    })),
    invocationInputs: premises.invocationInputs.map((self) => ({
      ...self,
      type: Type.substitute(self.type, caller.substitution),
      lifetime: Type.substituteLifetime(self.lifetime, caller.substitution),
    })),
    outlives: (longer, shorter) => {
      const atoms = [...Lifetime.atoms(longer), ...Lifetime.atoms(shorter)]
      return (
        !atoms.some((atom) => atom._tag === 'PlaceholderLifetime') &&
        atoms.some((atom) => atom._tag === 'LocalLifetime') &&
        Lifetime.outlives(finite, longer, shorter)
      )
    },
  })
}

/** Keeps the selected provider environment while proving the exact public result/row view. */
export const service = (
  fn: Pick<FunctionLowering, 'owner' | 'index' | 'calls' | 'instances' | 'semantic' | 'layout'>,
  subject: Extract<Tir.Expression, { readonly _tag: 'ServiceEffectConstruct' }>,
  call: Instances.CallInstance,
  provider: ProvidedRequirement,
  physicalContract: Type.Effect,
): SourceCallView | undefined => {
  const caller = fn.owner
  if (
    subject.id === undefined ||
    BodyView.node(caller.view, subject.id) !== subject ||
    caller.function !== caller.view.function ||
    caller.ownership.verdict._tag !== 'Satisfied' ||
    BodyView.hasUnavailable(caller.view) ||
    Instances.keyText(call.owner) !== Instances.keyText(caller.key) ||
    call.node?.ordinal !== subject.id.ordinal ||
    !fn.calls.includes(call) ||
    call.target.staticArguments.length !== subject.staticArguments.length ||
    !call.target.staticArguments.every((argument, ordinal) => {
      const original = subject.staticArguments.at(ordinal)
      return original !== undefined && StaticValue.equals(argument, original)
    }) ||
    provider.witness._tag !== 'SourceConformanceWitness' ||
    provider.role !== subject.role ||
    !serves(provider, subject.access)
  )
    return undefined
  const capability = fn.semantic(subject.service)
  if (!Type.isNominal(capability)) return undefined
  const witness = ConformanceProof.witness(fn.index, provider.providerType, capability)
  const target =
    witness?._tag === 'SourceConformanceWitness'
      ? ConformanceProof.witnessOperation(witness, subject.operation)
      : undefined
  const offeredTarget = ConformanceProof.witnessOperation(provider.witness, subject.operation)
  if (
    witness?._tag !== 'SourceConformanceWitness' ||
    witness.module !== provider.witness.module ||
    witness.ordinal !== provider.witness.ordinal ||
    witness.typeArguments.length !== provider.witness.typeArguments.length ||
    !witness.typeArguments.every((argument, ordinal) => {
      const original =
        provider.witness._tag === 'SourceConformanceWitness'
          ? provider.witness.typeArguments.at(ordinal)
          : undefined
      return original !== undefined && Type.equalsGenericArgument(argument, original)
    }) ||
    !Type.equals(provider.capability, capability) ||
    !Type.equals(provider.witness.capability, capability) ||
    !Type.equals(provider.witness.provider, provider.providerType) ||
    target === undefined ||
    offeredTarget?.module !== target.module ||
    offeredTarget.name !== target.name ||
    call.target.declaration.module !== target.module ||
    call.target.declaration.name !== target.name ||
    !Instances.callMatchesProviders(call, [provider])
  )
    return undefined
  const services = fn.index.modules
    .find((module) => module.module === subject.service.module)
    ?.services.filter(
      (candidate) =>
        candidate.canonical._tag === 'Canonical' &&
        candidate.canonical.id.name === subject.service.name,
    )
  const sourceService = services?.at(0)
  const operations = sourceService?.operations.filter(
    (candidate) =>
      candidate.name._tag === 'Present' && candidate.name.spelling === subject.operation,
  )
  const sourceOperation = operations?.at(0)
  const conformances = fn.index.modules
    .find((module) => module.module === witness.module)
    ?.conformances.filter((candidate) => candidate.ordinal === witness.ordinal)
  const conformance = conformances?.at(0)
  const mappings = conformance?.operations.filter(
    (candidate) =>
      candidate.name._tag === 'Present' && candidate.name.spelling === subject.operation,
  )
  const operationMapping = mappings?.at(0)
  const sourceSubstitution =
    sourceService === undefined || sourceOperation === undefined
      ? undefined
      : TypeInference.orderedSubstitution(
          [...sourceService.typeParameters, ...sourceOperation.typeParameters].map(
            (parameter) => parameter.type,
          ),
          subject.typeArguments.map((argument) =>
            Type.substituteGenericArgument(argument, caller.substitution),
          ),
        )
  const sourceContract = sourceOperation === undefined ? undefined : Tir.contractOf(sourceOperation)
  if (
    services?.length !== 1 ||
    sourceService === undefined ||
    operations?.length !== 1 ||
    sourceOperation === undefined ||
    sourceOperation.state._tag !== 'Unique' ||
    sourceOperation.state.id.service.sourceId !== sourceService.id.sourceId ||
    sourceOperation.state.id.service.ordinal !== sourceService.id.ordinal ||
    conformances?.length !== 1 ||
    conformance === undefined ||
    conformance.validity._tag !== 'ValidConformance' ||
    mappings?.length !== 1 ||
    operationMapping === undefined ||
    operationMapping.target._tag !== 'TypePath' ||
    operationMapping.contract === undefined ||
    !sameOperation(operationMapping.contract.declaration, sourceOperation, sourceService) ||
    !sameOperation(operationMapping.contract.source.declaration, sourceOperation, sourceService) ||
    operationMapping.targetArguments === undefined ||
    sourceSubstitution === undefined ||
    sourceContract?._tag !== 'Contract'
  )
    return undefined
  const selected = fn.instances.filter(
    (instance) => Instances.keyText(instance.key) === Instances.keyText(call.target),
  )
  const implementation = selected.at(0)
  const environments = fn.layout.effectEnvironments.filter(
    (
      environment,
    ): environment is Extract<Layout.EffectEnvironment, { readonly _tag: 'EffectEnvironment' }> =>
      environment._tag === 'EffectEnvironment' &&
      Instances.keyText(environment.instance) === Instances.keyText(call.target) &&
      Instances.effectIdentity(environment.instance, environment.site) === call.resultEffect &&
      Type.equals(environment.effect, physicalContract),
  )
  const environment = environments.at(0)
  const access =
    implementation === undefined || environment === undefined
      ? undefined
      : realizedAccess(fn.instances, fn.calls, fn.layout, fn.index, implementation, environment)
  const context = compatibility(fn.index, caller)
  const publicContract = fn.semantic(subject.type)
  const invocation =
    implementation === undefined
      ? undefined
      : TypeInference.orderedSubstitution(
          implementation.function.declaration.typeParameters.map((parameter) => parameter.type),
          call.target.typeArguments.filter(
            (argument) => !Type.isHiddenExecutableArgument(argument),
          ),
        )
  const originalContract = implementation?.function.contract
  const invocationContract =
    invocation === undefined || originalContract?._tag !== 'Contract'
      ? undefined
      : Type.substitute(originalContract.result, invocation)
  if (
    selected.length !== 1 ||
    implementation === undefined ||
    implementation.function !== implementation.view.function ||
    implementation.ownership.verdict._tag !== 'Satisfied' ||
    BodyView.hasUnavailable(implementation.view) ||
    !Type.isEffect(implementation.specialization.result) ||
    environments.length !== 1 ||
    access === undefined ||
    access !== physicalContract.access ||
    !Type.equals(physicalContract, { ...implementation.specialization.result, access }) ||
    invocation === undefined ||
    originalContract?._tag !== 'Contract' ||
    operationMapping.targetArguments.length !==
      implementation.function.declaration.typeParameters.length ||
    invocationContract === undefined ||
    !Type.isEffect(invocationContract) ||
    context === undefined ||
    !Type.isEffect(publicContract) ||
    !Type.requirementMembers(publicContract).some(
      (requirement) =>
        requirement.role === subject.role &&
        requirement.access === subject.access &&
        Type.equals(requirement.capability, capability),
    )
  )
    return undefined
  const implementationParameters = originalContract.parameters.map((parameter) =>
    Type.substitute(parameter, invocation),
  )
  const sourceParameters = sourceContract.parameters.map((parameter) =>
    Type.substitute(parameter, sourceSubstitution),
  )
  const receiver = implementationParameters.at(0)
  if (
    implementationParameters.length !== subject.arguments.length + 1 ||
    sourceParameters.length !== subject.arguments.length ||
    receiver === undefined ||
    !Type.isReference(receiver) ||
    !Type.equals(receiver.target, provider.providerType) ||
    (subject.access === 'Exclusive' && receiver.access !== 'Exclusive')
  )
    return undefined
  for (const [ordinal, operand] of subject.arguments.entries()) {
    const expected = sourceParameters.at(ordinal)
    if (
      operand._tag === 'Unavailable' ||
      operand.id === undefined ||
      BodyView.node(caller.view, operand.id) !== operand ||
      expected === undefined ||
      !TypeCompatibility.isCompatible(
        TypeCompatibility.check(fn.semantic(operand.type), expected, context),
      )
    )
      return undefined
  }
  if (
    !TypeCompatibility.isCompatible(
      TypeCompatibility.check(invocationContract.success, publicContract.success, context),
    ) ||
    !TypeCompatibility.isCompatible(
      TypeCompatibility.check(
        Type.failureType(invocationContract),
        Type.failureType(publicContract),
        context,
      ),
    ) ||
    !EffectExecutionContract.matches(
      {
        ...publicContract,
        success: invocationContract.success,
        failureRow: invocationContract.failureRow,
      },
      invocationContract,
      // This original operation's exact row is served by the witnessed receiver loan.
      // The enclosing caller may retain a stronger requirement for its other operations.
      [{ ...provider, requirementAccess: subject.access }],
    )
  )
    return undefined
  return {
    caller,
    call,
    implementation,
    sourceService,
    sourceOperation,
    conformance,
    operationMapping,
    sourceParameters,
    implementationParameters,
    publicContract,
    physicalContract,
    invocationContract,
  }
}
