import * as ConformanceProof from './ConformanceProof.js'
import type * as DeclarationIndex from './DeclarationIndex.js'
import * as Tir from './Tir.js'
import * as Lifetime from './Lifetime.js'
import * as Instances from './Instances.js'
import * as RepresentationField from './RepresentationField.js'
import * as SuspensionMode from './SuspensionMode.js'
import * as StaticValue from './StaticValue.js'
import * as Type from './Type.js'

/**
 * The runtime half of nominal executable storage.
 *
 * `RepresentationField` owns the semantic half: stable field identities, the concrete or explicitly
 * unavailable representation argument, the substituted required bound, and admissibility. This
 * actor consumes one of those resolutions and enriches it with one tagged callable or Effect
 * realization. Effect realizations carry the canonical runner selected by instance discovery, its
 * concrete arguments, exact compile-time rows, run access, ordered environment, cleanup, and
 * suspendability without assigning the structural `Effect` contract a standalone target ABI.
 *
 * Callable and Effect consumers both read this record and discriminate the realization tag;
 * neither path recovers executable identity from initializer syntax.
 */

/** How a capture reaches the callable environment stored inside the enclosing aggregate. */
export type CaptureAccess = Type.CaptureAccess

/** The aggregate receiver access one invocation mode demands. */
export type ReceiverAccess = Type.CallableMode

/** The statically known declaration or builtin every realized field invocation calls. */
export type StaticTarget = Type.CallableIdentityArgument['target']

/** One ordered inline capture lane contributed to the enclosing nominal's ABI. */
export interface CaptureSlot {
  readonly _tag: 'CallableCaptureSlot'
  readonly ordinal: number
  readonly parameterOrdinal: number
  readonly access: CaptureAccess
  readonly type: Type.Type
  /** Owned lanes are the only lanes the enclosing aggregate must clean. */
  readonly owned: boolean
  /** Borrowed lanes keep one loan alive for as long as the aggregate stores the callable. */
  readonly borrowed: boolean
}

/** One borrow the enclosing aggregate keeps alive on behalf of a stored callable environment. */
export interface LoanDependency {
  readonly _tag: 'CallableCaptureLoan'
  readonly capture: number
  readonly access: 'Shared' | 'Exclusive'
  readonly type: Type.Type
}

/** How long the stored environment's lanes stay live inside the enclosing aggregate. */
export interface Liveness {
  readonly _tag: 'CallableFieldLiveness'
  /** A field carrying owned or borrowed lanes keeps its enclosing nominal move-only. */
  readonly moveOnly: boolean
  readonly ownedLanes: number
  readonly borrowedLanes: number
}

/** The exactly-once cleanup obligation the enclosing aggregate carries for one stored callable. */
export interface Cleanup {
  readonly _tag: 'CallableFieldCleanup'
  /** Ordered owned capture ordinals, cleaned exactly once when the aggregate's storage ends. */
  readonly lanes: ReadonlyArray<number>
  /** Take invocation consumes the whole aggregate, so cleanup runs there instead of at scope exit. */
  readonly consumedByInvocation: boolean
}

/** One resolved callable field enriched with everything construction through cleanup needs. */
export interface CallableRealization {
  readonly _tag: 'FieldRealization'
  readonly field: RepresentationField.Id
  readonly instance: Type.Nominal
  readonly contract: Type.Callable
  readonly target: StaticTarget
  readonly targetArguments: ReadonlyArray<Type.GenericArgument>
  /** Present when the target is reached through a capturing section rather than a named function. */
  readonly environment?: Type.CallableEnvironmentIdentity
  /** The specialized environment's own site, which names its lanes to layout, MIR, and cleanup. */
  readonly site?: Tir.CallableSiteId
  readonly captures: ReadonlyArray<CaptureSlot>
  readonly invocation: ReceiverAccess
  readonly loans: ReadonlyArray<LoanDependency>
  readonly liveness: Liveness
  readonly cleanup: Cleanup
}

/** One ordered Effect environment slot, still independent of target size and alignment. */
export interface EffectEnvironmentSlot {
  readonly _tag: 'EffectEnvironmentSlot'
  readonly ordinal: number
  readonly source: 'Parameter' | 'Binding' | 'Pattern'
  readonly sourceOrdinal: number
  readonly access: CaptureAccess
  readonly type: Type.Type
  readonly effectIdentity?: string
  readonly callableIdentity?: Type.CallableIdentityArgument
  readonly providedRequirement?: NonNullable<
    Instances.EffectInstance['captures'][number]['providedRequirement']
  >
  readonly owned: boolean
  readonly borrowed: boolean
}

/** Exact compile-time rows carried by one concrete stored Effect. */
export interface EffectRows {
  readonly _tag: 'EffectFieldRows'
  readonly failures: ReadonlyArray<Type.Type>
  readonly requirements: ReadonlyArray<Type.Requirement>
}

/** The exactly-once obligation retained while a stored Effect has not run. */
export interface EffectCleanup {
  readonly _tag: 'EffectFieldCleanup'
  /** Owned environment ordinals released if the enclosing nominal is dropped before execution. */
  readonly unrunLanes: ReadonlyArray<number>
  /** A consuming run transfers those lanes to the runner instead of cleaning them at scope exit. */
  readonly consumedByRun: boolean
}

/**
 * One resolved Effect field. This is a specialization fact for an enclosing nominal, not a
 * structural Effect layout: no sizes, offsets, runtime row dictionaries, or indirect dispatch live
 * here.
 */
export interface EffectRealization {
  readonly _tag: 'EffectFieldRealization'
  readonly field: RepresentationField.Id
  readonly instance: Type.Nominal
  readonly contract: Type.Effect
  readonly requiredBound: Type.Effect
  readonly runnerIdentity: string
  readonly runner: Instances.EffectInstance['runner']
  readonly runnerInstance: Instances.InstanceKey
  readonly runnerArguments: ReadonlyArray<Type.GenericArgument>
  readonly site: Tir.EffectSiteId
  readonly rows: EffectRows
  readonly access: Type.Effect['access']
  readonly environment: ReadonlyArray<EffectEnvironmentSlot>
  readonly cleanup: EffectCleanup
  readonly suspendable: boolean
}

/** The one shared tagged realization consumed by represented-field lookups. */
export type Realization = CallableRealization | EffectRealization

/** Why one resolved representation field has no runtime realization. */
export type UnsupportedReason =
  | { readonly _tag: 'UnresolvedRepresentation' }
  | { readonly _tag: 'NonCallableBound' }
  | { readonly _tag: 'NonEffectBound' }
  | { readonly _tag: 'MissingEffectRunner'; readonly identity: string }
  | { readonly _tag: 'AmbiguousEffectRunner'; readonly identity: string }
  | { readonly _tag: 'OpenEffectContract'; readonly identity: string }
  | {
      readonly _tag: 'EffectContractMismatch'
      readonly identity: string
      readonly expected: Type.Effect
      readonly actual: Type.Effect
    }
  | { readonly _tag: 'MissingCallableEnvironment'; readonly environment: string }
  | { readonly _tag: 'AmbiguousCallableEnvironment'; readonly environment: string }
  | {
      readonly _tag: 'UnsupportedCaptureLayout'
      readonly capture: number
      readonly type: Type.Type
    }

/** The complete support proof one storage fence consults before admitting a stored executable. */
export type Support =
  | { readonly _tag: 'Supported'; readonly realization: Realization }
  | {
      readonly _tag: 'Unsupported'
      readonly field: RepresentationField.Id
      readonly instance: Type.Nominal
      readonly reason: UnsupportedReason
    }

/** One deterministic realization lookup entry keyed by complete instance and field identity. */
export interface Entry {
  readonly _tag: 'FieldRealizationEntry'
  readonly key: string
  readonly support: Support
}

/** Complete-instance lookup table for realized and explicitly unsupported executable fields. */
export interface Index {
  readonly _tag: 'FieldRealizationIndex'
  readonly entries: ReadonlyArray<Entry>
}

/** Physical realization identity; lifetime proof arguments remain in semantic field resolution. */
export const key = (instance: Type.Nominal, id: RepresentationField.Id): string =>
  `${Type.runtimeKey(instance)}:${RepresentationField.idKey(id)}`

const ownedAccess = (access: CaptureAccess): boolean => access === 'Take'

const borrowedAccess = (access: CaptureAccess): boolean =>
  access === 'Shared' || access === 'Exclusive'

const captureSlot = (capture: Instances.CallableInstance['captures'][number]): CaptureSlot => ({
  _tag: 'CallableCaptureSlot' as const,
  ordinal: capture.ordinal,
  parameterOrdinal: capture.parameterOrdinal,
  access: capture.access,
  type: capture.type,
  owned: ownedAccess(capture.access),
  borrowed: borrowedAccess(capture.access),
})

const compareCaptures = (left: CaptureSlot, right: CaptureSlot): number =>
  left.ordinal - right.ordinal || left.parameterOrdinal - right.parameterOrdinal

const loansOf = (captures: ReadonlyArray<CaptureSlot>): ReadonlyArray<LoanDependency> =>
  captures.flatMap((capture): ReadonlyArray<LoanDependency> =>
    capture.access === 'Shared' || capture.access === 'Exclusive'
      ? [
          {
            _tag: 'CallableCaptureLoan' as const,
            capture: capture.ordinal,
            access: capture.access,
            type: capture.type,
          },
        ]
      : [],
  )

const livenessOf = (
  index: DeclarationIndex.Index,
  captures: ReadonlyArray<CaptureSlot>,
): Liveness => {
  const ownedLanes = captures.filter((capture) => capture.owned).length
  const borrowedLanes = captures.filter((capture) => capture.borrowed).length
  return {
    _tag: 'CallableFieldLiveness' as const,
    moveOnly: captures.some(
      (capture) =>
        capture.access === 'Exclusive' ||
        (capture.access === 'Take' && !ConformanceProof.copyType(index, capture.type)),
    ),
    ownedLanes,
    borrowedLanes,
  }
}

const cleanupOf = (
  index: DeclarationIndex.Index,
  captures: ReadonlyArray<CaptureSlot>,
  invocation: ReceiverAccess,
): Cleanup => ({
  _tag: 'CallableFieldCleanup' as const,
  lanes: captures.flatMap((capture) =>
    capture.owned && !ConformanceProof.copyType(index, capture.type) ? [capture.ordinal] : [],
  ),
  consumedByInvocation: invocation === 'Take',
})

const effectEnvironmentSlot = (
  capture: Instances.EffectInstance['captures'][number],
): EffectEnvironmentSlot => ({
  _tag: 'EffectEnvironmentSlot' as const,
  ordinal: capture.ordinal,
  source: capture.source,
  sourceOrdinal: capture.sourceOrdinal,
  access: capture.access,
  type: capture.type,
  ...(capture.effectIdentity === undefined ? {} : { effectIdentity: capture.effectIdentity }),
  ...(capture.callableIdentity === undefined ? {} : { callableIdentity: capture.callableIdentity }),
  ...(capture.providedRequirement === undefined
    ? {}
    : { providedRequirement: capture.providedRequirement }),
  owned: ownedAccess(capture.access),
  borrowed: borrowedAccess(capture.access),
})

const compareEffectEnvironmentSlots = (
  left: EffectEnvironmentSlot,
  right: EffectEnvironmentSlot,
): number => left.ordinal - right.ordinal || left.sourceOrdinal - right.sourceOrdinal

/**
 * Returns the canonical target-independent environment seam for any discovered Effect instance.
 * Stored-field realization and recursive layout both consume this function, so nested Effects do
 * not grow a second capture model or rediscover captures from source syntax.
 */
export const effectEnvironmentOf = (
  effect: Instances.EffectInstance,
): ReadonlyArray<EffectEnvironmentSlot> =>
  effect.captures.map(effectEnvironmentSlot).sort(compareEffectEnvironmentSlots)

const effectRows = (contract: Type.Effect): EffectRows => ({
  _tag: 'EffectFieldRows',
  failures: [...Type.failureMembers(contract)],
  requirements: [...Type.requirementMembers(contract)],
})

const effectCleanup = (
  environment: ReadonlyArray<EffectEnvironmentSlot>,
  access: Type.Effect['access'],
): EffectCleanup => ({
  _tag: 'EffectFieldCleanup',
  unrunLanes: environment.flatMap((slot) => (slot.owned ? [slot.ordinal] : [])),
  consumedByRun: access === 'Take',
})

/** Structural executable values need their own hidden identity and cannot be an inline lane yet. */
const hasUnsupportedCaptureLayout = (type: Type.Type): boolean =>
  Type.isCallable(type) ||
  Type.isEffect(type) ||
  Type.isRepresented(type) ||
  (Type.isFixedArray(type) && hasUnsupportedCaptureLayout(type.element))

const unsupported = (
  field: RepresentationField.Id,
  instance: Type.Nominal,
  reason: UnsupportedReason,
): Support => ({ _tag: 'Unsupported', field, instance, reason })

/** The capture environment a retained representation argument names, or why it is unreachable. */
type EnvironmentCaptures =
  | {
      readonly _tag: 'ResolvedEnvironment'
      readonly slots: ReadonlyArray<CaptureSlot>
      readonly site?: Tir.CallableSiteId
    }
  | { readonly _tag: 'UnresolvedEnvironment'; readonly reason: UnsupportedReason }

const sameArguments = (
  left: ReadonlyArray<Type.GenericArgument>,
  right: ReadonlyArray<Type.GenericArgument>,
): boolean => {
  const physicalLeft = left.filter((argument) => !Lifetime.isLifetime(argument))
  const physicalRight = right.filter((argument) => !Lifetime.isLifetime(argument))
  return (
    physicalLeft.length === physicalRight.length &&
    physicalLeft.every((argument, ordinal) => {
      const candidate = physicalRight.at(ordinal)
      if (candidate === undefined) return false
      if (Type.runtimeGenericArgumentKey(argument) === Type.runtimeGenericArgumentKey(candidate))
        return true
      if (!Type.isEffectIdentityArgument(argument) || !Type.isEffectIdentityArgument(candidate))
        return false
      const retained = argument.owner === undefined ? candidate : argument
      const discovered = argument.owner === undefined ? argument : candidate
      const owner = retained.owner
      if (owner === undefined || !retained.identity.startsWith('effect:')) return false
      const ownerPrefix = `${owner.declaration.module}\u0000${owner.declaration.name}\u0000${Type.runtimeArgumentKeys(
        owner.typeArguments,
      ).join(
        '\u0000',
      )}${owner.staticArgumentKeys.length === 0 ? '' : `\u0001${owner.staticArgumentKeys.join('\u0000')}`}\u0002`
      return (
        discovered.identity.startsWith(ownerPrefix) &&
        discovered.identity.endsWith(`\u0004${retained.identity.slice('effect:'.length)}`)
      )
    })
  )
}

// Environment lookups call this per candidate. The candidate's identity, and with it its runtime
// key, is memoized per callable: rebuilding it per call put `Canonical.record` among the hottest
// self-time frames of a large selfhost compile. The cheap target identity is checked first.
export const matchesIdentity = (
  identity: Type.CallableIdentityArgument,
  candidate: Instances.CallableInstance,
): boolean =>
  identity.environment !== undefined &&
  Tir.matchesCallableTargetIdentity(candidate.target, identity.target) &&
  Type.runtimeCallableEnvironmentIdentityKey(identity.environment) ===
    Type.runtimeCallableEnvironmentIdentityKey(Instances.callableEnvironmentIdentity(candidate)) &&
  sameArguments(identity.typeArguments, candidate.typeArguments)

/** One capture shape signature, used only to detect indistinguishable environments. */
const captureShape = (callable: Instances.CallableInstance): string =>
  callable.captures
    .map(
      (capture) =>
        `${capture.ordinal}:${capture.parameterOrdinal}:${capture.access}:${Type.runtimeKey(capture.type)}`,
    )
    .join(' ')

/**
 * Selects the specialized capture environment a section's retained identity names. A named function
 * carries no environment identity and therefore contributes no capture lanes at all.
 */
const environmentCaptures = (
  identity: Type.CallableIdentityArgument,
  callables: ReadonlyArray<Instances.CallableInstance>,
): EnvironmentCaptures => {
  const environment = identity.environment
  if (environment === undefined) return { _tag: 'ResolvedEnvironment', slots: [] }
  const candidates = callables.filter((callable) => matchesIdentity(identity, callable))
  const selected = candidates.at(0)
  if (selected === undefined)
    return {
      _tag: 'UnresolvedEnvironment',
      reason: {
        _tag: 'MissingCallableEnvironment',
        environment: Type.callableEnvironmentKey(environment),
      },
    }
  if (new Set(candidates.map(captureShape)).size > 1)
    return {
      _tag: 'UnresolvedEnvironment',
      reason: {
        _tag: 'AmbiguousCallableEnvironment',
        environment: Type.callableEnvironmentKey(environment),
      },
    }
  return {
    _tag: 'ResolvedEnvironment',
    slots: selected.captures.map(captureSlot).sort(compareCaptures),
    site: selected.site,
  }
}

type ResolvedField = Extract<
  RepresentationField.Resolution,
  { readonly _tag: 'ResolvedRepresentationField' }
>

const realizeCallableField = (
  index: DeclarationIndex.Index,
  resolution: ResolvedField,
  identity: Type.CallableIdentityArgument,
  callables: ReadonlyArray<Instances.CallableInstance>,
): Support => {
  let contract: Type.Callable | undefined
  if (Type.isCallable(resolution.requiredBound)) {
    contract = resolution.requiredBound
  } else if (Type.isCallable(resolution.argument.contract)) {
    contract = resolution.argument.contract
  } else {
    contract = undefined
  }
  if (contract === undefined)
    return unsupported(resolution.id, resolution.instance, { _tag: 'NonCallableBound' })
  const environment = identity.environment
  const captures = environmentCaptures(identity, callables)
  if (captures._tag === 'UnresolvedEnvironment')
    return unsupported(resolution.id, resolution.instance, captures.reason)
  const slots = captures.slots
  const unsupportedCapture = slots.find(
    (capture) => !capture.borrowed && hasUnsupportedCaptureLayout(capture.type),
  )
  if (unsupportedCapture !== undefined)
    return unsupported(resolution.id, resolution.instance, {
      _tag: 'UnsupportedCaptureLayout',
      capture: unsupportedCapture.ordinal,
      type: unsupportedCapture.type,
    })
  const invocation = contract.mode
  return {
    _tag: 'Supported',
    realization: {
      _tag: 'FieldRealization' as const,
      field: resolution.id,
      instance: resolution.instance,
      contract,
      target: identity.target,
      targetArguments: [...identity.typeArguments],
      ...(environment === undefined ? {} : { environment }),
      ...(captures.site === undefined ? {} : { site: captures.site }),
      captures: slots,
      invocation,
      loans: loansOf(slots),
      liveness: livenessOf(index, slots),
      cleanup: cleanupOf(index, slots, invocation),
    },
  }
}

/** One construction shape signature, used only to reject inconsistent duplicate runner facts. */
const effectShape = (effect: Instances.EffectInstance): string =>
  [
    effect.identity,
    `${effect.runner.module}.${effect.runner.name}`,
    Type.runtimeArgumentKeys(effect.typeArguments).join(','),
    Type.runtimeKey(effect.type),
    SuspensionMode.has(effect.suspension, 'NestedTransfer') ? 'suspendable' : 'synchronous',
    ...effect.captures.map(
      (capture) =>
        `${capture.ordinal}:${capture.source}:${capture.sourceOrdinal}:${capture.access}:${Type.runtimeKey(capture.type)}:${capture.effectIdentity ?? ''}:${capture.callableIdentity === undefined ? '' : Type.runtimeGenericArgumentKey(capture.callableIdentity)}`,
    ),
  ].join(' ')

/** Matches one retained source origin to exactly one enclosing concrete specialization. */
const matchesEffectIdentity = (
  identity: Type.EffectIdentityArgument,
  candidate: Instances.EffectInstance,
): boolean => {
  if (candidate.identity === identity.identity) return true
  if (candidate.representationIdentity !== identity.identity) return false
  const owner = identity.owner
  if (owner === undefined) return true
  return (
    candidate.owner.declaration.module === owner.declaration.module &&
    candidate.owner.declaration.name === owner.declaration.name &&
    sameArguments(owner.typeArguments, candidate.owner.typeArguments) &&
    candidate.owner.staticArguments.length === owner.staticArgumentKeys.length &&
    candidate.owner.staticArguments.every(
      (argument, ordinal) => StaticValue.key(argument) === owner.staticArgumentKeys.at(ordinal),
    )
  )
}

const realizeEffectField = (
  resolution: ResolvedField,
  identity: Type.EffectIdentityArgument,
  effects: ReadonlyArray<Instances.EffectInstance>,
): Support => {
  const contract = Type.isEffect(resolution.argument.contract)
    ? resolution.argument.contract
    : undefined
  const requiredBound = Type.isEffect(resolution.requiredBound)
    ? resolution.requiredBound
    : undefined
  if (contract === undefined || requiredBound === undefined)
    return unsupported(resolution.id, resolution.instance, { _tag: 'NonEffectBound' })
  if (!Type.isRuntimeConcrete(contract))
    return unsupported(resolution.id, resolution.instance, {
      _tag: 'OpenEffectContract',
      identity: identity.identity,
    })
  const candidates = effects.filter((effect) => matchesEffectIdentity(identity, effect))
  const selected = candidates.at(0)
  if (selected === undefined)
    return unsupported(resolution.id, resolution.instance, {
      _tag: 'MissingEffectRunner',
      identity: identity.identity,
    })
  if (new Set(candidates.map(effectShape)).size > 1)
    return unsupported(resolution.id, resolution.instance, {
      _tag: 'AmbiguousEffectRunner',
      identity: identity.identity,
    })
  if (Type.representationAdmissibility(selected.type, contract)._tag !== 'Admitted')
    return unsupported(resolution.id, resolution.instance, {
      _tag: 'EffectContractMismatch',
      identity: identity.identity,
      expected: contract,
      actual: selected.type,
    })
  const environment = effectEnvironmentOf(selected)
  return {
    _tag: 'Supported',
    realization: {
      _tag: 'EffectFieldRealization' as const,
      field: resolution.id,
      instance: resolution.instance,
      contract,
      requiredBound,
      runnerIdentity: selected.identity,
      runner: selected.runner,
      runnerInstance: selected.owner,
      runnerArguments: [...selected.typeArguments],
      site: selected.site,
      rows: effectRows(contract),
      access: contract.access,
      environment,
      cleanup: effectCleanup(environment, contract.access),
      suspendable: SuspensionMode.has(selected.suspension, 'NestedTransfer'),
    },
  }
}

/**
 * Enriches one resolved representation field from the discovery's specialized executable facts.
 * This function never inspects initializer syntax and never invents a second field identity.
 */
export const realizeField = (
  index: DeclarationIndex.Index,
  resolution: RepresentationField.Resolution,
  callables: ReadonlyArray<Instances.CallableInstance>,
  effects: ReadonlyArray<Instances.EffectInstance>,
): Support => {
  if (resolution._tag !== 'ResolvedRepresentationField')
    return unsupported(resolution.id, resolution.instance, { _tag: 'UnresolvedRepresentation' })
  const identity = resolution.argument.identity
  return Type.isCallableIdentityArgument(identity)
    ? realizeCallableField(index, resolution, identity, callables)
    : realizeEffectField(resolution, identity, effects)
}

/** Realizes every executable field of one resolved field index in deterministic key order. */
export const realize = (
  index: DeclarationIndex.Index,
  fields: RepresentationField.Index,
  callables: ReadonlyArray<Instances.CallableInstance>,
  effects: ReadonlyArray<Instances.EffectInstance>,
): Index => {
  const entries = new Map<string, Entry>()
  for (const resolution of fields.resolutions) {
    const entryKey = key(resolution.instance, resolution.id)
    if (entries.has(entryKey)) continue
    entries.set(entryKey, {
      _tag: 'FieldRealizationEntry' as const,
      key: entryKey,
      support: realizeField(index, resolution, callables, effects),
    })
  }
  return {
    _tag: 'FieldRealizationIndex',
    entries: [...entries.values()].sort((left, right) => {
      if (left.key < right.key) {
        return -1
      }
      if (left.key > right.key) {
        return 1
      }
      return 0
    }),
  }
}

/** Looks one realization up by complete nominal instance and stable field identity. */
export const lookup = (
  self: Index,
  instance: Type.Nominal,
  id: RepresentationField.Id,
): Support | undefined => {
  const expected = key(instance, id)
  return self.entries.find((entry) => entry.key === expected)?.support
}

/** Returns the realization when the field is supported, and nothing when it stays fenced. */
export const realizationOf = (
  self: Index,
  instance: Type.Nominal,
  id: RepresentationField.Id,
): Realization | undefined => {
  const support = lookup(self, instance, id)
  return support?._tag === 'Supported' ? support.realization : undefined
}

/** Narrows the shared realization union to the callable variant. */
export const isCallableRealization = (self: Realization): self is CallableRealization =>
  self._tag === 'FieldRealization'

/** Narrows the shared realization union to the Effect variant. */
export const isEffectRealization = (self: Realization): self is EffectRealization =>
  self._tag === 'EffectFieldRealization'

/** True when every realized field of one complete instance has a runtime realization. */
export const supportsInstance = (self: Index, instance: Type.Nominal): boolean => {
  const identity = Type.runtimeKey(instance)
  const entries = self.entries.filter(
    (entry) =>
      Type.runtimeKey(
        entry.support._tag === 'Supported'
          ? entry.support.realization.instance
          : entry.support.instance,
      ) === identity,
  )
  return entries.length > 0 && entries.every((entry) => entry.support._tag === 'Supported')
}

/** True when a discovered callable is the complete specialization this realization names. */
export const matchesCallable = (
  self: CallableRealization,
  candidate: Instances.CallableInstance,
): boolean =>
  self.site !== undefined &&
  Tir.sameExecutableSite(self.site, candidate.site) &&
  Tir.matchesCallableTargetIdentity(candidate.target, self.target) &&
  sameArguments(self.targetArguments, candidate.typeArguments) &&
  self.environment !== undefined &&
  Type.runtimeCallableEnvironmentIdentityKey(self.environment) ===
    Type.runtimeCallableEnvironmentIdentityKey(Instances.callableEnvironmentIdentity(candidate))

/** Structural equality for callable runtime facts owned by this actor. */
const equalsCallable = (left: CallableRealization, right: CallableRealization): boolean =>
  key(left.instance, left.field) === key(right.instance, right.field) &&
  Type.runtimeKey(left.contract) === Type.runtimeKey(right.contract) &&
  Tir.sameCallableTarget(
    Tir.callableTargetFromIdentity(left.target),
    Tir.callableTargetFromIdentity(right.target),
  ) &&
  sameArguments(left.targetArguments, right.targetArguments) &&
  ((left.environment === undefined && right.environment === undefined) ||
    (left.environment !== undefined &&
      right.environment !== undefined &&
      Type.runtimeCallableEnvironmentIdentityKey(left.environment) ===
        Type.runtimeCallableEnvironmentIdentityKey(right.environment))) &&
  ((left.site === undefined && right.site === undefined) ||
    (left.site !== undefined &&
      right.site !== undefined &&
      Tir.sameExecutableSite(left.site, right.site))) &&
  left.captures.length === right.captures.length &&
  left.captures.every((capture, ordinal) => {
    const candidate = right.captures.at(ordinal)
    return (
      candidate !== undefined &&
      capture.ordinal === candidate.ordinal &&
      capture.parameterOrdinal === candidate.parameterOrdinal &&
      capture.access === candidate.access &&
      Type.runtimeKey(capture.type) === Type.runtimeKey(candidate.type) &&
      capture.owned === candidate.owned &&
      capture.borrowed === candidate.borrowed
    )
  }) &&
  left.invocation === right.invocation &&
  left.cleanup.consumedByInvocation === right.cleanup.consumedByInvocation &&
  left.cleanup.lanes.length === right.cleanup.lanes.length &&
  left.cleanup.lanes.every((lane, ordinal) => lane === right.cleanup.lanes.at(ordinal))

const equalsEffectEnvironment = (
  left: ReadonlyArray<EffectEnvironmentSlot>,
  right: ReadonlyArray<EffectEnvironmentSlot>,
): boolean =>
  left.length === right.length &&
  left.every((slot, ordinal) => {
    const candidate = right.at(ordinal)
    return (
      candidate !== undefined &&
      slot.ordinal === candidate.ordinal &&
      slot.source === candidate.source &&
      slot.sourceOrdinal === candidate.sourceOrdinal &&
      slot.access === candidate.access &&
      Type.runtimeKey(slot.type) === Type.runtimeKey(candidate.type) &&
      slot.effectIdentity === candidate.effectIdentity &&
      ((slot.callableIdentity === undefined && candidate.callableIdentity === undefined) ||
        (slot.callableIdentity !== undefined &&
          candidate.callableIdentity !== undefined &&
          Type.runtimeGenericArgumentKey(slot.callableIdentity) ===
            Type.runtimeGenericArgumentKey(candidate.callableIdentity))) &&
      ((slot.providedRequirement === undefined && candidate.providedRequirement === undefined) ||
        (slot.providedRequirement !== undefined &&
          candidate.providedRequirement !== undefined &&
          Type.equals(
            slot.providedRequirement.capability,
            candidate.providedRequirement.capability,
          ) &&
          slot.providedRequirement.role === candidate.providedRequirement.role &&
          slot.providedRequirement.requirementAccess ===
            candidate.providedRequirement.requirementAccess &&
          slot.providedRequirement.providerAccess ===
            candidate.providedRequirement.providerAccess)) &&
      slot.owned === candidate.owned &&
      slot.borrowed === candidate.borrowed
    )
  })

const equalsEffect = (left: EffectRealization, right: EffectRealization): boolean =>
  key(left.instance, left.field) === key(right.instance, right.field) &&
  Type.runtimeKey(left.contract) === Type.runtimeKey(right.contract) &&
  Type.runtimeKey(left.requiredBound) === Type.runtimeKey(right.requiredBound) &&
  left.runnerIdentity === right.runnerIdentity &&
  left.runner.module === right.runner.module &&
  left.runner.name === right.runner.name &&
  sameArguments(left.runnerArguments, right.runnerArguments) &&
  Tir.sameExecutableSite(left.site, right.site) &&
  equalsEffectEnvironment(left.environment, right.environment) &&
  left.access === right.access &&
  left.cleanup.consumedByRun === right.cleanup.consumedByRun &&
  left.cleanup.unrunLanes.length === right.cleanup.unrunLanes.length &&
  left.cleanup.unrunLanes.every((lane, ordinal) => lane === right.cleanup.unrunLanes.at(ordinal)) &&
  left.suspendable === right.suspendable

/** Structural equality for the shared tagged realization fact owned by this actor. */
export const equals = (left: Realization, right: Realization): boolean => {
  if (left._tag === 'FieldRealization' && right._tag === 'FieldRealization') {
    return equalsCallable(left, right)
  }
  if (left._tag === 'EffectFieldRealization' && right._tag === 'EffectFieldRealization') {
    return equalsEffect(left, right)
  }
  return false
}

/** Every invocation mode one receiver access admits, weakest receiver first. */
export const admittedModes = (receiver: ReceiverAccess): ReadonlyArray<Type.CallableMode> => {
  if (receiver === 'Shared') {
    return ['Shared'] as const
  }
  if (receiver === 'Exclusive') {
    return ['Shared', 'Exclusive'] as const
  }
  return ['Shared', 'Exclusive', 'Take'] as const
}

/**
 * True when one aggregate receiver access may invoke one callable mode.
 *
 * Ownership decides this before specialization, from the field's semantic contract alone, and every
 * later phase decides it from the realization. Both reach the same rule through this one function so
 * the pre-layout rejection and the runtime invocation can never disagree.
 */
export const admitsMode = (receiver: ReceiverAccess, mode: Type.CallableMode): boolean =>
  admittedModes(receiver).includes(mode)

/** The weaker of two receiver accesses; a borrow anywhere in a place weakens the whole place. */
export const weakerAccess = (left: ReceiverAccess, right: ReceiverAccess): ReceiverAccess =>
  admittedModes(left).length <= admittedModes(right).length ? left : right

/** True when one aggregate receiver access may invoke a realization's callable mode. */
export const admitsInvocation = (self: CallableRealization, receiver: ReceiverAccess): boolean =>
  admitsMode(receiver, self.invocation)
