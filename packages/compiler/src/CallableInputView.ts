import type * as CallableContract from './CallableContract.js'
import * as BodyView from './BodyView.js'
import * as DeclarationFacts from './DeclarationFacts.js'
import * as Instances from './Instances.js'
import * as Layout from './Layout.js'
import * as Mir from './Mir.js'
import * as Tir from './Tir.js'
import * as Type from './Type.js'

/** Original checked bodies behind a non-generic section's physical input partition. */
export interface Source {
  readonly owner: Instances.Instance
  readonly target: Instances.Instance
  readonly environment: Extract<
    Layout.CallableEnvironment,
    { readonly _tag: 'CallableEnvironment' }
  >
}

export interface CallableInputView extends Source {
  readonly section: Extract<Tir.Expression, { readonly _tag: 'CallableSection' }>
  readonly contract: CallableContract.CallableContract
  readonly inputs: ReadonlyArray<number>
  readonly visible: ReadonlyArray<number>
  readonly captures: ReadonlyArray<
    Extract<Tir.Expression, { readonly _tag: 'CallableSection' }>['captures'][number]
  >
}

const argumentsEqual = (
  left: ReadonlyArray<Type.GenericArgument>,
  right: ReadonlyArray<Type.GenericArgument>,
): boolean =>
  left.length === right.length &&
  left.every((argument, ordinal) => {
    const selected = right.at(ordinal)
    return selected !== undefined && Type.equalsGenericArgument(argument, selected)
  })

/** Holds source instances rather than accepting a serialized input-count assertion. */
export const catalog = (
  instances: ReadonlyArray<Instances.Instance>,
  layout: Layout.Plan,
): ReadonlyArray<Source> =>
  layout.callableEnvironments.flatMap((environment) => {
    if (
      environment._tag !== 'CallableEnvironment' ||
      environment.callable.type.schema !== undefined ||
      environment.callable.target._tag !== 'DeclarationCallableTarget'
    )
      return []
    const declaration = environment.callable.target.declaration
    const arguments_ = Layout.callableTargetArguments(environment)
    const owners = instances.filter(
      (instance) =>
        Instances.keyText(instance.key) === Instances.keyText(environment.callable.owner),
    )
    const targets = instances.filter(
      (instance) =>
        instance.key.declaration.module === declaration.module &&
        instance.key.declaration.name === declaration.name &&
        argumentsEqual(instance.key.typeArguments, arguments_) &&
        instance.key.staticArguments.length === 0,
    )
    const owner = owners.at(0)
    const target = targets.at(0)
    return owners.length === 1 &&
      targets.length === 1 &&
      owner !== undefined &&
      target !== undefined
      ? [{ owner, target, environment }]
      : []
  })

/** Rebuilds original coordinates from the authored producer and the exact planned closure. */
export const authenticate = (
  program: Pick<Mir.Module, 'layout' | 'callableInputSources'>,
  actual: Extract<Mir.Type, { readonly _tag: 'CallableValue' }>,
): CallableInputView | undefined => {
  const environment = actual.environment
  const sources =
    program.callableInputSources?.filter((source) => source.environment === environment) ?? []
  const source = sources.at(0)
  if (
    sources.length !== 1 ||
    source === undefined ||
    environment === undefined ||
    actual.type.schema !== undefined ||
    actual.storage !== undefined ||
    actual.site === undefined ||
    !program.layout.callableEnvironments.includes(environment) ||
    !Tir.sameExecutableSite(actual.site, environment.callable.site) ||
    actual.target._tag !== 'DeclarationCallableTarget' ||
    environment.callable.target._tag !== 'DeclarationCallableTarget' ||
    actual.target.declaration.module !== environment.callable.target.declaration.module ||
    actual.target.declaration.name !== environment.callable.target.declaration.name ||
    !argumentsEqual(actual.typeArguments ?? [], Layout.callableTargetArguments(environment)) ||
    !Type.equals(actual.type, { ...environment.callable.type, mode: environment.callable.mode })
  )
    return undefined
  const { owner, target } = source
  for (const instance of [owner, target]) {
    const lifetimes = instance.view.lifetimes
    if (
      instance.function !== instance.view.function ||
      instance.ownership.verdict._tag !== 'Satisfied' ||
      BodyView.hasUnavailable(instance.view) ||
      lifetimes === undefined ||
      lifetimes.diagnostics.length !== 0 ||
      lifetimes.solution._tag !== 'Solved' ||
      lifetimes.solution.violations.length !== 0
    )
      return undefined
  }
  const targetId = target.function.declaration.canonical
  if (
    Instances.keyText(owner.key) !== Instances.keyText(environment.callable.owner) ||
    targetId._tag !== 'Canonical' ||
    targetId.id.module !== actual.target.declaration.module ||
    targetId.id.name !== actual.target.declaration.name ||
    !argumentsEqual(target.key.typeArguments, Layout.callableTargetArguments(environment)) ||
    target.key.staticArguments.length !== 0 ||
    target.function.declaration.typeParameters.length !== 0 ||
    Tir.artifactKey(environment.callable.site.node.artifact) !==
      Tir.artifactKey(owner.view.artifact)
  )
    return undefined
  const sections = owner.function.statements
    .flatMap(Tir.statementExpressions)
    .flatMap(Tir.expressionTree)
    .filter(
      (node): node is Extract<Tir.Expression, { readonly _tag: 'CallableSection' }> =>
        node._tag === 'CallableSection' &&
        Tir.sameExecutableSite(node.site, environment.callable.site),
    )
  const section = sections.at(0)
  const contract = DeclarationFacts.callableContract(target.function.declaration)
  const inputs = Type.callableInputOrdinals(contract)
  const parameters = target.function.declaration.parameters
  if (
    sections.length !== 1 ||
    section === undefined ||
    section.origin._tag !== 'Authored' ||
    section.target._tag !== 'DeclarationCallableTarget' ||
    section.target.declaration.module !== targetId.id.module ||
    section.target.declaration.name !== targetId.id.name ||
    inputs === undefined ||
    parameters.length !== contract.parameters.length ||
    parameters.some(
      (parameter, ordinal) => parameter.phase !== 'Runtime' || parameter.id.ordinal !== ordinal,
    ) ||
    section.remainingParameters.length !== actual.type.parameters.length ||
    section.captures.length !== environment.fields.length ||
    section.captures.length !== environment.callable.captures.length
  )
    return undefined
  const partition = [
    ...section.remainingParameters,
    ...section.captures.map((capture) => capture.parameterOrdinal),
  ]
  if (
    partition.length !== parameters.length ||
    new Set(partition).size !== partition.length ||
    partition.some((ordinal) => parameters.at(ordinal) === undefined) ||
    section.remainingParameters.some((ordinal, position) => {
      const selected = target.specialization.parameters.at(ordinal)
      const visible = actual.type.parameters.at(position)
      return (
        !inputs.includes(ordinal) ||
        selected === undefined ||
        visible === undefined ||
        !Type.equals(selected, visible)
      )
    })
  )
    return undefined
  for (const capture of section.captures) {
    const field = environment.fields.at(capture.ordinal)
    const held = environment.callable.captures.at(capture.ordinal)
    const declared = target.specialization.parameters.at(capture.parameterOrdinal)
    if (
      capture.value._tag === 'Unavailable' ||
      field === undefined ||
      held === undefined ||
      declared === undefined ||
      field.ordinal !== capture.ordinal ||
      held.ordinal !== capture.ordinal ||
      field.parameterOrdinal !== capture.parameterOrdinal ||
      held.parameterOrdinal !== capture.parameterOrdinal ||
      field.access !== capture.access ||
      held.access !== capture.access ||
      !Type.equals(field.type, held.type) ||
      !Type.equals(field.type, declared) ||
      !Type.equals(
        field.type,
        Type.substitute(capture.value.type, owner.substitution, owner.specialization.compatibility),
      )
    )
      return undefined
  }
  return {
    ...source,
    section,
    contract,
    inputs,
    visible: section.remainingParameters,
    captures: section.captures.filter((capture) => inputs.includes(capture.parameterOrdinal)),
  }
}
