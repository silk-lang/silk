import * as ContinuationTransfer from './ContinuationTransfer.js'
import type * as CleanupPlan from './CleanupPlan.js'
import * as SuspensionMode from './SuspensionMode.js'
import type * as Target from './Target.js'
import * as Type from './Type.js'

/**
 * Words of the package control block: two source-owned control words, the counted allocation
 * authority, and the compiler-private notification flag.
 */
export const controlWords = 4

/** Source-owned control words addressable through `Intrinsic.executionLoad` and `executionStore`. */
export const sourceControlWords = 2

/** Word index of the counted authority (the Execution handle plus each live ExecutionRef). */
export const authorityWord = 2

/** Word index of the compiler-private notification flag. */
export const notificationWord = 3

/** Byte offset of the control block; fixed because only the owner record precedes it. */
export const controlOffset = (pointerSize: number): number => pointerSize * 2

/** Byte offset of the allocation authority; fixed because only fixed components precede it. */
export const allocationOffset = (pointerSize: number): number => pointerSize * (2 + controlWords)

/** One exact component retained by the compiler-private combined execution package. */
export interface Component {
  readonly role:
    | 'OwnerRecord'
    | 'Control'
    | 'AllocationAuthority'
    | 'BodyEnvironment'
    | 'InvokeMetadata'
    | 'BodyDropMetadata'
    | 'EndpointState'
    | 'EndpointCallback'
    | 'EndpointDropMetadata'
    | 'InitialContinuationSegment'
  readonly size: number
  readonly alignment: number
}

/** Exact target-independent specialization identity used by Layout, MIR, and initialization. */
export interface Specialization {
  readonly result: Type.Type
  readonly body: Type.Type
  readonly endpoint: Type.Type
  readonly callback: Type.Type
  readonly suspension: SuspensionMode.Summary
}

/** One target-private physical plan. Component offsets deliberately remain unpublished. */
export interface Plan {
  readonly _tag: 'ExecutionPackagePlan'
  readonly target: Target.Id
  readonly specialization: Specialization
  readonly size: number
  readonly alignment: number
  readonly components: ReadonlyArray<Component>
  readonly initialContinuationSegment: boolean
  readonly provenance: string
  /** Exact hidden drop programs retained only after whole-program layout realization. */
  readonly cleanup?: CleanupMetadata
}

export interface Unavailable {
  readonly _tag: 'ExecutionPackageUnavailable'
  readonly target: Target.Id
  readonly specialization: Specialization
  readonly reason: 'InvalidComponent' | 'AlignmentOverflow' | 'SizeOverflow'
}

export type Selection = Plan | Unavailable

/** The canonical package plans reached by one realized source program. */
export interface Module {
  readonly _tag: 'ExecutionPackageModule'
  readonly plans: ReadonlyArray<Plan>
  readonly unavailable: ReadonlyArray<Unavailable>
}

/** Inputs whose physical layout is already known by target layout planning. */
export interface ComponentLayouts {
  readonly body: { readonly size: number; readonly alignment: number }
  readonly endpoint: { readonly size: number; readonly alignment: number }
  readonly callback: { readonly size: number; readonly alignment: number }
}

const maximum = (target: Target.Target): number =>
  target.pointerSize === 4 ? 0xffff_ffff : Number.MAX_SAFE_INTEGER

const checkedAdd = (left: number, right: number, limit: number): number | undefined => {
  const sum = left + right
  return Number.isSafeInteger(sum) && sum >= 0 && sum <= limit ? sum : undefined
}

const checkedAlign = (value: number, alignment: number, limit: number): number | undefined => {
  if (!Number.isSafeInteger(alignment) || alignment <= 0 || (alignment & (alignment - 1)) !== 0)
    return undefined
  const remainder = value % alignment
  const padding = remainder === 0 ? 0 : alignment - remainder
  return checkedAdd(value, padding, limit)
}

const unavailable = (
  target: Target.Target,
  specialization: Specialization,
  reason: Unavailable['reason'],
): Unavailable => ({
  _tag: 'ExecutionPackageUnavailable',
  target: target.id,
  specialization,
  reason,
})

const component = (role: Component['role'], size: number, alignment: number): Component => ({
  role,
  size,
  alignment,
})

/** Canonical exact specialization key; physical offsets never participate in source identity. */
export const specializationKey = (self: Specialization): string =>
  [
    Type.key(self.result),
    Type.key(self.body),
    Type.key(self.endpoint),
    Type.key(self.callback),
    SuspensionMode.encode(self.suspension),
  ].join('\u0000')

/** Plans one combined caller-funded package against an explicit representable-size limit. */
export const planWithin = (
  target: Target.Target,
  specialization: Specialization,
  layouts: ComponentLayouts,
  limit: number,
): Selection => {
  const values = [layouts.body, layouts.endpoint, layouts.callback]
  if (
    values.some(
      (value) =>
        !Number.isSafeInteger(value.size) ||
        value.size < 0 ||
        !Number.isSafeInteger(value.alignment) ||
        value.alignment <= 0 ||
        (value.alignment & (value.alignment - 1)) !== 0,
    )
  )
    return unavailable(target, specialization, 'InvalidComponent')

  const word = target.pointerSize
  const initialContinuationSegment = specialization.suspension.modes.length > 0
  const endpointIsZeroSized = layouts.endpoint.size === 0 && layouts.callback.size === 0
  const components: ReadonlyArray<Component> = [
    component('OwnerRecord', word * 2, word),
    // Control precedes every specialization-sized component, so its offset is package-independent.
    component('Control', word * controlWords, word),
    // Allocation is a self-contained six-word reclaim ticket in the current bootstrap ABI.
    component('AllocationAuthority', word * 6, word),
    component('BodyEnvironment', layouts.body.size, layouts.body.alignment),
    component('InvokeMetadata', word, word),
    component('BodyDropMetadata', word, word),
    ...(!endpointIsZeroSized
      ? [
          component('EndpointState', layouts.endpoint.size, layouts.endpoint.alignment),
          component('EndpointCallback', layouts.callback.size, layouts.callback.alignment),
          component('EndpointDropMetadata', word * 2, word),
        ]
      : []),
    ...(initialContinuationSegment
      ? [component('InitialContinuationSegment', word * ContinuationTransfer.headerWords, word)]
      : []),
  ]

  let cursor = 0
  let alignment = 1
  for (const field of components) {
    const offset = checkedAlign(cursor, field.alignment, limit)
    if (offset === undefined) return unavailable(target, specialization, 'AlignmentOverflow')
    const following = checkedAdd(offset, field.size, limit)
    if (following === undefined) return unavailable(target, specialization, 'SizeOverflow')
    cursor = following
    alignment = Math.max(alignment, field.alignment)
  }
  const size = checkedAlign(cursor, alignment, limit)
  if (size === undefined || size === 0)
    return unavailable(target, specialization, 'AlignmentOverflow')
  const provenance = [
    target.id,
    specializationKey(specialization),
    size,
    alignment,
    initialContinuationSegment ? 'segment' : 'no-segment',
  ].join(':')
  return {
    _tag: 'ExecutionPackagePlan',
    target: target.id,
    specialization,
    size,
    alignment,
    components,
    initialContinuationSegment,
    provenance,
  }
}

/** Plans one package against the selected target's representable address range. */
export const plan = (
  target: Target.Target,
  specialization: Specialization,
  layouts: ComponentLayouts,
): Selection => planWithin(target, specialization, layouts, maximum(target))

export const equals = (left: Plan, right: Plan): boolean =>
  left.target === right.target &&
  specializationKey(left.specialization) === specializationKey(right.specialization) &&
  left.size === right.size &&
  left.alignment === right.alignment &&
  left.initialContinuationSegment === right.initialContinuationSegment &&
  left.provenance === right.provenance

/** The caller-visible Allocation facts validated before the consuming initializer publishes. */
export interface AllocationProvenance {
  readonly target: Target.Id
  readonly size: number
  readonly alignment: number
  readonly package: string
}

export type InitializationVerdict =
  | { readonly _tag: 'Accepted'; readonly state: 'Unstarted' }
  | {
      readonly _tag: 'Rejected'
      readonly reason: 'Target' | 'Size' | 'Alignment' | 'PackageProvenance'
    }

/** Validates every exact package dimension before the all-or-nothing consuming transition. */
export const validateInitialization = (
  plan_: Plan,
  allocation: AllocationProvenance,
): InitializationVerdict => {
  if (allocation.target !== plan_.target) return { _tag: 'Rejected', reason: 'Target' }
  if (allocation.size !== plan_.size) return { _tag: 'Rejected', reason: 'Size' }
  if (allocation.alignment !== plan_.alignment) return { _tag: 'Rejected', reason: 'Alignment' }
  if (allocation.package !== plan_.provenance)
    return { _tag: 'Rejected', reason: 'PackageProvenance' }
  return { _tag: 'Accepted', state: 'Unstarted' }
}

/** Exact hidden cleanup metadata retained at the purpose-bound erasure seam. */
export interface CleanupMetadata {
  readonly body: CleanupPlan.CleanupPlan
  readonly endpoint: CleanupPlan.CleanupPlan
  readonly callback: CleanupPlan.CleanupPlan
}

/** Canonical inspection form shared by Layout and target-neutral MIR artifacts. */
export const encode = (self: Plan): string =>
  `execution-package ${self.provenance} target=${self.target} size=${self.size} alignment=${self.alignment} body=${Type.encode(self.specialization.body)} endpoint=${Type.encode(self.specialization.endpoint)} callback=${Type.encode(self.specialization.callback)} suspension=${SuspensionMode.encode(self.specialization.suspension)} segment=${self.initialContinuationSegment ? 'initial' : 'none'}`

export const empty = (): Module => ({
  _tag: 'ExecutionPackageModule',
  plans: [],
  unavailable: [],
})
