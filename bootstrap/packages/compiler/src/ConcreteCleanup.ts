import * as EffectExecutionContract from './internal/EffectExecutionContract.js'
import * as CleanupPlan from './CleanupPlan.js'
import type * as DeclarationIndex from './DeclarationIndex.js'
import * as Instances from './Instances.js'
import * as Layout from './Layout.js'
import * as Mir from './Mir.js'
import type * as OpaqueRealization from './OpaqueRealization.js'
import * as Ownership from './Ownership.js'
import * as Type from './Type.js'
import {
  callableValueByIdentity,
  effectValueByIdentity,
  representedValueType,
  storedCallableValueType,
  storedEffectValueType,
} from './ValueType.js'

/** Representation context shared by ordinary and suspension cleanup planning. */
export interface ConcreteCleanup {
  readonly index: DeclarationIndex.Index
  readonly layout: Layout.Plan
  readonly opaqueRealizations: OpaqueRealization.Catalog
  readonly semantic: (type: Type.Type) => Type.Type
}

export const forType = (
  fn: ConcreteCleanup,
  type: Type.Type,
  seen = new Set<string>(),
): CleanupPlan.CleanupPlan => {
  const specialized = fn.semantic(type)
  const resolveRepresented = (candidate: Type.Type): CleanupPlan.CleanupPlan | undefined => {
    const concrete = fn.semantic(candidate)
    if (!Type.isRepresented(concrete)) return undefined
    const value =
      storedCallableValueType(fn.layout, concrete) ??
      storedEffectValueType(fn.layout, concrete) ??
      representedValueType(fn.layout, fn.opaqueRealizations, concrete, new Map())
    if (value?._tag === 'CallableValue') {
      if (value.storage?._tag === 'StoredCallableField') {
        return CleanupPlan.realizedCallableCleanup(fn.index, value.storage.realization)
      }
      return forCallable(fn, value)
    }
    if (value?._tag === 'EffectValue') {
      return forEffect(fn, value, new Set())
    }
    if (value?._tag === 'EffectComposite') {
      return {
        _tag: 'EffectCompositeCleanup' as const,
        type: value.type,
        alternatives: value.alternatives.map((alternative) =>
          forEffect(fn, alternative, new Set()),
        ),
      }
    }
    return undefined
  }
  const realized = resolveRepresented(specialized)
  if (realized !== undefined) return realized
  return CleanupPlan.specializeCleanup(
    CleanupPlan.cleanupPlan(fn.index, specialized, seen),
    new Map(),
    (nested) => resolveRepresented(nested) ?? CleanupPlan.cleanupPlan(fn.index, nested, seen),
  )
}

export function forEffect(
  fn: ConcreteCleanup,
  effectValue: Extract<Mir.Type, { readonly _tag: 'EffectValue' }>,
  seen: ReadonlySet<string>,
): CleanupPlan.CleanupPlan {
  const identity =
    effectValue.storage?.realization.runnerIdentity ??
    Instances.effectIdentity(effectValue.environment.instance, effectValue.site)
  if (seen.has(identity)) return { _tag: 'NoCleanup', type: effectValue.type }
  const next = new Set(seen).add(identity)
  let laneOffset = 0
  const slots = effectValue.environment.fields.flatMap((field, ordinal) => {
    const nested =
      field.effectIdentity === undefined
        ? undefined
        : effectValueByIdentity(
            fn.layout,
            field.effectIdentity,
            EffectExecutionContract.fromType(field.type),
          )
    const callable =
      field.callableIdentity === undefined || !Type.isCallable(field.type)
        ? undefined
        : callableValueByIdentity(fn.layout, field.callableIdentity, field.type)
    // Offsets must mirror the runner ABI exactly, so the count comes from the same Layout
    // helper that materializes the environment lanes for backends.
    const laneCount = Layout.effectFieldLanes(fn.layout, field).length
    const currentOffset = laneOffset
    laneOffset += laneCount
    const realizationOrdinal =
      effectValue.storage?.realization.environment.at(ordinal)?.ordinal ?? ordinal
    const storedOwned =
      effectValue.storage?.realization.cleanup.unrunLanes.includes(realizationOrdinal) ?? false
    if (effectValue.storage === undefined ? field.representation === 'Borrow' : !storedOwned)
      return []
    let fieldCleanup: CleanupPlan.CleanupPlan
    if (callable === undefined) {
      if (nested === undefined) {
        fieldCleanup = forType(fn, field.type)
      } else {
        fieldCleanup = forEffect(fn, nested, next)
      }
    } else {
      fieldCleanup = forCallable(fn, callable)
    }
    return fieldCleanup._tag === 'NoCleanup' && effectValue.storage === undefined
      ? []
      : [
          {
            ordinal: realizationOrdinal,
            laneOffset: currentOffset,
            laneCount,
            cleanup: fieldCleanup,
          },
        ]
  })
  const releaseSlots = Ownership.inReleaseOrder(slots)
  return releaseSlots.length === 0
    ? { _tag: 'NoCleanup', type: effectValue.type }
    : {
        _tag: 'EffectCleanup',
        type: effectValue.type,
        site: effectValue.site,
        slots: releaseSlots,
      }
}

export const forCallable = (
  fn: ConcreteCleanup,
  localType: Extract<Mir.Type, { readonly _tag: 'CallableValue' }>,
): CleanupPlan.CleanupPlan => {
  const environment = localType.environment
  if (environment === undefined || localType.site === undefined)
    return { _tag: 'NoCleanup', type: localType.type }
  return {
    _tag: 'CallableCleanup',
    type: localType.type,
    environment: {
      _tag: 'CallableEnvironmentIdentity',
      identity: Instances.callableEnvironmentIdentity(environment.callable),
    },
    slots: Ownership.inReleaseOrder(environment.fields).flatMap((field) =>
      field.access === 'Take' && !Mir.isCopy(fn.layout, field.type)
        ? [{ ordinal: field.ordinal, cleanup: forType(fn, field.type) }]
        : [],
    ),
  }
}

/** Preserves captured ownership in an exact MIR value, including unrun Effects. */
export const forLocal = (self: ConcreteCleanup, type: Mir.Type): CleanupPlan.CleanupPlan => {
  if (type._tag === 'EffectValue') return forEffect(self, type, new Set())
  if (type._tag === 'EffectComposite')
    return {
      _tag: 'EffectCompositeCleanup',
      type: type.type,
      alternatives: type.alternatives.map((value) => forEffect(self, value, new Set())),
    }
  if (type._tag === 'CallableValue')
    return type.storage === undefined
      ? forCallable(self, type)
      : CleanupPlan.realizedCallableCleanup(self.index, type.storage.realization)
  return forType(self, Mir.semanticType(type))
}
