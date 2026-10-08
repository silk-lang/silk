import * as AuthoredIdentity from './AuthoredIdentity.js'
import * as CallableContract from './CallableContract.js'
import * as Constraint from './Constraint.js'
import * as Instances from './Instances.js'
import * as Lifetime from './Lifetime.js'
import type * as Mir from './Mir.js'
import * as Tir from './Tir.js'
import * as Type from './Type.js'
import * as TypeCompatibility from './TypeCompatibility.js'
import * as ValueType from './ValueType.js'

/** Replays one executable parameter view against the held original checked call graph. */
const expressions = (fn: Tir.TirFunction): ReadonlyArray<Tir.Expression> =>
  fn.statements.flatMap(Tir.statementExpressions).flatMap(Tir.expressionTree)

const sameDeclaration = (left: Lifetime.Owner, right: Lifetime.Owner): boolean =>
  left.module === right.module && left.name === right.name

const compareText = (left: string, right: string): number => {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

const boundKey = (bound: Lifetime.Outlives): string => Lifetime.assumptions([bound]).key

/** Cached semantic keys are not authority for a structured source blueprint. */
const typeKey = (type: Type.Type): string => {
  const schemas: Array<unknown> = []
  Type.visit(type, (nested) => {
    if (!Type.isCallable(nested) || nested.schema === undefined) return
    const schema = nested.schema
    schemas.push([
      CallableContract.key(schema.contract),
      schema.binders.map(Type.key),
      schema.constraints.map(Constraint.key),
      schema.evidence.map(Constraint.evidenceKey),
    ])
  })
  return JSON.stringify([Type.key(type), schemas])
}

/** Every field in a descriptor's certificate must match its independently held source selection. */
export const key = (view: Tir.ExecutableInputView): string =>
  JSON.stringify([
    view.caller.module,
    view.caller.name,
    AuthoredIdentity.anchorKey(view.call),
    Tir.artifactKey(view.operand.artifact),
    view.operand.node.ordinal,
    AuthoredIdentity.anchorKey(view.operandOrigin),
    typeKey(view.actual),
    view.target.module,
    view.target.name,
    view.parameter.ordinal,
    AuthoredIdentity.anchorKey(view.parameter.source),
    typeKey(view.parameter.declared),
    typeKey(view.expected),
    [...view.substitution]
      .map(([name, argument]) => [name, Type.genericArgumentKey(argument)])
      .sort((left, right) => compareText(left[0] ?? '', right[0] ?? '')),
    view.premises.owner.module,
    view.premises.owner.name,
    view.premises.bounds.map(boundKey).sort(compareText),
    view.premises.obligations.map(boundKey).sort(compareText),
    Type.typeOutlivesKey(view.premises.typeBounds),
    view.premises.invocationInputs.map((input) => [
      input.parameter,
      Type.key(input.type),
      Lifetime.key(input.lifetime),
    ]),
    [...view.premises.points].sort(([left], [right]) => compareText(left, right)),
    [...view.premises.anchors]
      .map(([name, anchor]) => [name, AuthoredIdentity.anchorKey(anchor)])
      .sort((left, right) => compareText(left[0] ?? '', right[0] ?? '')),
    view.premises.formations.map((formation) => [
      AuthoredIdentity.anchorKey(formation.origin),
      Lifetime.key(formation.environment),
      formation.lifetimeBounds.map(boundKey).sort(compareText),
      Type.typeOutlivesKey(formation.typeOutlives),
    ]),
  ])

/** Builds proof-only source records; no runtime layout or representation identity is changed. */
export const catalog = (
  instances: ReadonlyArray<Instances.Instance>,
  calls: ReadonlyArray<Instances.CallInstance>,
): ReadonlyArray<Mir.ExecutableInputViewSource> => {
  const indexed = new Map<string, Array<Instances.Instance>>()
  for (const instance of instances) {
    const identity = Instances.keyText(instance.key)
    indexed.set(identity, [...(indexed.get(identity) ?? []), instance])
  }
  const result: Array<Mir.ExecutableInputViewSource> = []
  const nodes = new Map<Instances.Instance, ReadonlyMap<number, Tir.Expression>>()
  for (const call of calls) {
    if (call.node === undefined || call.inputViews === undefined) continue
    const callers = indexed.get(Instances.keyText(call.owner)) ?? []
    const callees = indexed.get(Instances.keyText(call.target)) ?? []
    const caller = callers.at(0)
    const callee = callees.at(0)
    if (
      callers.length !== 1 ||
      callees.length !== 1 ||
      caller === undefined ||
      callee === undefined
    )
      continue
    let callerNodes = nodes.get(caller)
    if (callerNodes === undefined) {
      callerNodes = new Map(
        expressions(caller.function).flatMap((node) =>
          node.id === undefined ? [] : [[node.id.ordinal, node] as const],
        ),
      )
      nodes.set(caller, callerNodes)
    }
    const source = callerNodes.get(call.node.ordinal)
    if (source?._tag !== 'Call' && source?._tag !== 'EffectConstruct') continue
    for (const selected of call.inputViews) {
      const originals =
        source.inputViews?.filter(
          (view) => view.parameter.ordinal === selected.parameter.ordinal,
        ) ?? []
      const original = originals.at(0)
      if (originals.length === 1 && original !== undefined)
        result.push({ caller, callee, call, original, selected })
    }
  }
  return result
}

/** Rejects forged/stale operand, parameter, substitution or caller-domain evidence. */
const authenticateChecked = (
  sources: ReadonlyArray<Mir.ExecutableInputViewSource>,
  proof: Mir.ExecutableInputView,
): Mir.ExecutableInputViewSource | undefined => {
  const candidates = sources.filter(
    (source) =>
      Instances.keyText(source.call.owner) === Instances.keyText(proof.owner) &&
      source.call.node?.ordinal === proof.callNode.ordinal &&
      source.selected.parameter.ordinal === proof.view.parameter.ordinal,
  )
  const source = candidates.at(0)
  if (candidates.length !== 1 || source === undefined) return undefined
  const { caller, callee, original, selected, call } = source
  const callerId = caller.function.declaration.canonical
  const calleeId = callee.function.declaration.canonical
  if (
    callerId._tag !== 'Canonical' ||
    calleeId._tag !== 'Canonical' ||
    !sameDeclaration(callerId.id, original.caller) ||
    !sameDeclaration(calleeId.id, original.target) ||
    caller.ownership.verdict._tag !== 'Satisfied' ||
    caller.view.causes.length !== 0 ||
    caller.view.lifetimes === undefined ||
    caller.view.lifetimes.diagnostics.length !== 0 ||
    caller.view.lifetimes.solution._tag !== 'Solved' ||
    caller.view.lifetimes.solution.violations.length !== 0 ||
    caller.view.lifetimes.sourcePremises === undefined ||
    Tir.artifactKey(original.operand.artifact) !== Tir.artifactKey(caller.view.artifact) ||
    Instances.keyText(caller.key) !== Instances.keyText(call.owner) ||
    Instances.keyText(callee.key) !== Instances.keyText(call.target) ||
    key(selected) !== key(proof.view)
  )
    return undefined
  const nodes = expressions(caller.function)
  const node = nodes.find((candidate) => candidate.id?.ordinal === call.node?.ordinal)
  if (node?._tag !== 'Call' && node?._tag !== 'EffectConstruct') return undefined
  const held =
    node.inputViews?.filter((view) => view.parameter.ordinal === original.parameter.ordinal) ?? []
  if (
    held.length !== 1 ||
    held.at(0) === undefined ||
    key(held.at(0) ?? original) !== key(original) ||
    AuthoredIdentity.anchorKey(node.origin.anchor) !== AuthoredIdentity.anchorKey(original.call)
  )
    return undefined
  const operands = node.arguments.filter(
    (operand) => operand.id?.ordinal === original.operand.node.ordinal,
  )
  const operand = operands.at(0)
  const parameter = callee.function.declaration.parameters.at(original.parameter.ordinal)
  if (
    operands.length !== 1 ||
    operand === undefined ||
    operand._tag === 'Unavailable' ||
    parameter?.phase !== 'Runtime' ||
    parameter.declaredType._tag !== 'Resolved' ||
    AuthoredIdentity.anchorKey(operand.origin.anchor) !==
      AuthoredIdentity.anchorKey(original.operandOrigin) ||
    AuthoredIdentity.anchorKey(parameter.anchor) !==
      AuthoredIdentity.anchorKey(original.parameter.source) ||
    typeKey(parameter.declaredType.type) !== typeKey(original.parameter.declared)
  )
    return undefined
  const actual = Type.isRepresented(operand.type) ? operand.type.contract : operand.type
  if (typeKey(actual) !== typeKey(original.actual)) return undefined
  const selectedSource = Tir.substituteExecutableInputView(
    original,
    caller.substitution,
    caller.specialization.compatibility,
  )
  if (key(selectedSource) !== key(selected)) return undefined
  const constraints = new Set(caller.view.lifetimes.input.constraints.map(boundKey))
  if (original.premises.obligations.some((bound) => !constraints.has(boundKey(bound))))
    return undefined
  const premises = caller.view.lifetimes.sourcePremises
  if (
    premises === undefined ||
    !sameDeclaration(original.premises.owner, original.caller) ||
    original.premises.bounds.some(
      (bound) => !Lifetime.outlives(premises.assumptions, bound.longer, bound.shorter),
    )
  )
    return undefined
  const typeBounds = new Set(premises.typeBounds.map((bound) => Type.typeOutlivesKey([bound])))
  if (original.premises.typeBounds.some((bound) => !typeBounds.has(Type.typeOutlivesKey([bound]))))
    return undefined
  const invocationKey = (input: Type.InvocationInputBound): string =>
    JSON.stringify([input.parameter, typeKey(input.type), Lifetime.key(input.lifetime)])
  const incoming = new Set(premises.invocationInputs.map(invocationKey))
  if (
    original.premises.invocationInputs.length !== incoming.size ||
    original.premises.invocationInputs.some((input) => !incoming.has(invocationKey(input)))
  )
    return undefined
  const formationKey = (
    formation: Tir.ExecutableInputView['premises']['formations'][number],
  ): string =>
    JSON.stringify([
      AuthoredIdentity.anchorKey(formation.origin),
      Lifetime.key(formation.environment),
      formation.lifetimeBounds.map(boundKey).sort(compareText),
      Type.typeOutlivesKey(formation.typeOutlives),
    ])
  const formations = new Set((caller.view.lifetimes.formations ?? []).map(formationKey))
  if (original.premises.formations.some((formation) => !formations.has(formationKey(formation))))
    return undefined
  for (const [anchor, point] of original.premises.points) {
    const heldAnchor = caller.view.lifetimes.anchors.get(point)
    if (heldAnchor === undefined || AuthoredIdentity.anchorKey(heldAnchor) !== anchor)
      return undefined
  }
  const compatibility = TypeCompatibility.context({
    nominalVariance: caller.specialization.compatibility?.nominalVariance ?? new Map(),
    assumptions: Lifetime.assumptions(selected.premises.bounds),
    // Successful finite-body obligations are replayed only as local graph edges.
    // They never become universal premises for a newly opened rigid use binder.
    outlives: (longer, shorter) => {
      const atoms = [...Lifetime.atoms(longer), ...Lifetime.atoms(shorter)]
      return (
        !atoms.some((atom) => atom._tag === 'PlaceholderLifetime') &&
        atoms.some((atom) => atom._tag === 'LocalLifetime') &&
        Lifetime.outlives(Lifetime.assumptions(selected.premises.obligations), longer, shorter)
      )
    },
    typeBounds: selected.premises.typeBounds,
    invocationInputs: selected.premises.invocationInputs,
  })
  return TypeCompatibility.isCompatible(
    TypeCompatibility.check(selected.actual, selected.expected, compatibility),
  )
    ? source
    : undefined
}

/** Validates untrusted descriptor evidence without accepting malformed semantic adapters. */
export const authenticate = (
  sources: ReadonlyArray<Mir.ExecutableInputViewSource>,
  proof: Mir.ExecutableInputView,
): Mir.ExecutableInputViewSource | undefined => {
  try {
    return authenticateChecked(sources, proof)
  } catch (error) {
    if (error instanceof RangeError) return undefined
    throw error
  }
}

/** Uses the same held-source replay during lowering and independent MIR verification. */
const catalogs = new WeakMap<
  ReadonlyArray<Instances.Instance>,
  WeakMap<ReadonlyArray<Instances.CallInstance>, ReadonlyArray<Mir.ExecutableInputViewSource>>
>()

export const authority = (
  instances: ReadonlyArray<Instances.Instance>,
  calls: ReadonlyArray<Instances.CallInstance>,
  proof: Mir.ExecutableInputView,
): Mir.ExecutableInputViewSource | undefined => {
  let callsByInstances = catalogs.get(instances)
  if (callsByInstances === undefined) {
    callsByInstances = new WeakMap()
    catalogs.set(instances, callsByInstances)
  }
  let sources = callsByInstances.get(calls)
  if (sources === undefined) {
    sources = catalog(instances, calls)
    callsByInstances.set(calls, sources)
  }
  return authenticate(sources, proof)
}

/** Independently held original source graph and its physical layout. */
type Program = Pick<Mir.Module, 'layout' | 'executableInputViews'>

/** Authenticates a parameter view without changing its actual closure identity or channels. */
export const physical = (
  program: Program,
  local: Extract<Mir.Type, { readonly _tag: 'EffectValue' }>,
): Extract<Mir.Type, { readonly _tag: 'EffectValue' }> | undefined => {
  if (local.inputView === undefined) return undefined
  const source = authenticate(program.executableInputViews ?? [], local.inputView)
  if (
    source === undefined ||
    !Type.isEffect(source.selected.actual) ||
    !Type.isEffect(source.selected.expected)
  )
    return undefined
  const parameter = source.callee.function.declaration.parameters.at(
    source.selected.parameter.ordinal,
  )
  const selected =
    parameter?.declaredType._tag === 'Resolved'
      ? Type.substitute(parameter.declaredType.type, source.callee.substitution)
      : undefined
  const representation =
    selected !== undefined && Type.isRepresented(selected)
      ? selected.representation.argument
      : undefined
  const representedIdentity =
    representation !== undefined &&
    Type.isExactRepresentationArgument(representation) &&
    representation.identity._tag === 'EffectIdentityArgument'
      ? representation.identity
      : undefined
  const identity =
    representedIdentity ??
    Instances.parameterEffectIdentityArgument(
      source.callee.function,
      source.callee.key,
      source.selected.parameter.ordinal,
    )
  const physical =
    identity === undefined
      ? undefined
      : ValueType.effectValueByIdentity(
          program.layout,
          identity.identity,
          source.selected.actual,
          identity.owner,
        )
  const valid =
    physical !== undefined &&
    Tir.sameExecutableSite(physical.site, local.site) &&
    Instances.keyText(physical.environment.instance) ===
      Instances.keyText(local.environment.instance) &&
    Tir.sameExecutableSite(physical.environment.site, local.environment.site) &&
    Type.equals(physical.environment.effect, local.environment.effect) &&
    Type.equals(
      { ...source.selected.actual, access: local.environment.effect.access },
      local.environment.effect,
    ) &&
    Type.equals(
      { ...source.selected.expected, access: local.environment.effect.access },
      local.type,
    ) &&
    Type.runtimeKey(source.selected.actual) ===
      Type.runtimeKey({
        ...source.selected.expected,
        access: source.selected.actual.access,
      })
  return valid ? physical : undefined
}

/** A checked parameter view opens the original physical runner's channels at this call. */
export const outcome = (
  program: Program,
  local: Mir.Type | undefined,
  requested: Type.Effect,
): Type.Effect | undefined => {
  if (local?._tag !== 'EffectValue' || local.inputView === undefined) return requested
  if (!Type.equals(local.type, requested)) return undefined
  return physical(program, local)?.environment.effect
}
