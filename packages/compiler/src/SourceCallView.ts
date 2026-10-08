import * as BodyView from './BodyView.js'
import * as ConformanceProof from './ConformanceProof.js'
import * as ExecutableInputView from './ExecutableInputView.js'
import type { FunctionLowering } from './FunctionLowering.js'
import * as Instances from './Instances.js'
import * as Lifetime from './Lifetime.js'
import type * as Layout from './Layout.js'
import type { ProvidedRequirement } from './Lower.js'
import * as NominalVariance from './NominalVariance.js'
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
  readonly publicContract: Type.Effect
  readonly physicalContract: Type.Effect
  readonly invocationContract: Type.Effect
}

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
    const parameter =
      capture.parameter === undefined
        ? undefined
        : implementation.specialization.parameters.at(capture.parameter.ordinal)
    if (
      field === undefined ||
      capture.parameter === undefined ||
      capture.binding !== undefined ||
      capture.pattern !== undefined ||
      field.source !== 'Parameter' ||
      field.ordinal !== capture.parameter.ordinal ||
      ordinals.has(field.ordinal) ||
      parameter === undefined ||
      (!Type.equals(field.type, parameter) &&
        ExecutableInputView.capturedEffect(
          instances,
          calls,
          layout,
          implementation,
          field,
          context,
        ) === undefined)
    )
      return undefined
    ordinals.add(field.ordinal)
    const access =
      capture.access === 'Take' && ConformanceProof.copyType(index, parameter)
        ? 'Copy'
        : capture.access
    if (field.access !== access) return undefined
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
    provider.witness._tag !== 'SourceConformanceWitness' ||
    provider.role !== subject.role ||
    provider.requirementAccess !== subject.access
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
      : TypeInference.substitution(
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
    implementation.ownership.verdict._tag !== 'Satisfied' ||
    BodyView.hasUnavailable(implementation.view) ||
    !Type.isEffect(implementation.specialization.result) ||
    environments.length !== 1 ||
    access === undefined ||
    access !== physicalContract.access ||
    !Type.equals(physicalContract, { ...implementation.specialization.result, access }) ||
    invocation === undefined ||
    originalContract?._tag !== 'Contract' ||
    invocationContract === undefined ||
    !Type.isEffect(invocationContract) ||
    context === undefined ||
    !Type.isEffect(publicContract)
  )
    return undefined
  const parameters = originalContract.parameters.map((parameter) =>
    Type.substitute(parameter, invocation),
  )
  const receiver = parameters.at(0)
  if (
    parameters.length !== subject.arguments.length + 1 ||
    receiver === undefined ||
    !Type.isReference(receiver) ||
    !Type.equals(receiver.target, provider.providerType) ||
    (subject.access === 'Exclusive' && receiver.access !== 'Exclusive')
  )
    return undefined
  for (const [ordinal, operand] of subject.arguments.entries()) {
    const expected = parameters.at(ordinal + 1)
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
      [provider],
    )
  )
    return undefined
  return { caller, call, implementation, publicContract, physicalContract, invocationContract }
}
