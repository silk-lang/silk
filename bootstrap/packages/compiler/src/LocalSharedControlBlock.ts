import type * as Layout from './Layout.js'
import type * as Target from './Target.js'
import * as Type from './Type.js'

/** One target-selected opaque control-block plan. Offsets remain compiler-private. */
export interface Plan {
  readonly _tag: 'LocalSharedControlBlockPlan'
  readonly target: Target.Id
  readonly element: Type.Type
  readonly size: number
  readonly alignment: number
  readonly strongOffset: number
  readonly strongMaximum: bigint
  readonly accessOffset: number
  readonly allocationOffset: number
  readonly valueOffset: number
  readonly provenance: string
}

/** A concrete element whose complete block is not representable by the selected target. */
export interface Unavailable {
  readonly _tag: 'LocalSharedControlBlockUnavailable'
  readonly target: Target.Id
  readonly element: Type.Type
  readonly reason: 'HeaderAddition' | 'AlignmentRounding' | 'PayloadPlacement'
}

export type Selection = Plan | Unavailable

/** Exact equality for the compiler-private target plan carried by verified MIR. */
export const equals = (left: Plan, right: Plan): boolean =>
  left.target === right.target &&
  Type.equals(left.element, right.element) &&
  left.size === right.size &&
  left.alignment === right.alignment &&
  left.strongOffset === right.strongOffset &&
  left.strongMaximum === right.strongMaximum &&
  left.accessOffset === right.accessOffset &&
  left.allocationOffset === right.allocationOffset &&
  left.valueOffset === right.valueOffset &&
  left.provenance === right.provenance

const maximum = (target: Target.Target): number =>
  target.pointerSize === 4 ? 0xffff_ffff : Number.MAX_SAFE_INTEGER

/** Largest strong count representable by the selected target's private word. */
export const strongMaximum = (target: Target.Target): bigint =>
  (1n << BigInt(target.pointerSize * 8)) - 1n

const checkedAdd = (left: number, right: number, limit: number): number | undefined => {
  const sum = left + right
  return Number.isSafeInteger(sum) && sum <= limit ? sum : undefined
}

const checkedAlign = (value: number, alignment: number, limit: number): number | undefined => {
  const padding = (alignment - (value % alignment)) % alignment
  return checkedAdd(value, padding, limit)
}

const unavailable = (
  target: Target.Target,
  element: Type.Type,
  reason: Unavailable['reason'],
): Unavailable => ({
  _tag: 'LocalSharedControlBlockUnavailable',
  target: target.id,
  element,
  reason,
})

/** Plans strong/access state, private Allocation reclaim lanes, padding, and one initialized T. */
export const planWithin = (
  target: Target.Target,
  element: Type.Type,
  elementLayout: Layout.Entry,
  limit: number,
): Selection => {
  const word = target.pointerSize
  const strongOffset = 0
  const accessOffset = checkedAdd(strongOffset, word, limit)
  if (accessOffset === undefined) return unavailable(target, element, 'HeaderAddition')
  const allocationOffset = checkedAdd(accessOffset, word, limit)
  if (allocationOffset === undefined) return unavailable(target, element, 'HeaderAddition')
  // Allocation is six target words: base, requested bytes/alignment, reclaim tag/context, active.
  const afterAllocation = checkedAdd(allocationOffset, word * 6, limit)
  if (afterAllocation === undefined) return unavailable(target, element, 'HeaderAddition')
  const alignment = Math.max(word, elementLayout.alignment)
  const valueOffset = checkedAlign(afterAllocation, elementLayout.alignment, limit)
  if (valueOffset === undefined) return unavailable(target, element, 'AlignmentRounding')
  const afterValue = checkedAdd(valueOffset, elementLayout.size, limit)
  if (afterValue === undefined) return unavailable(target, element, 'PayloadPlacement')
  const size = checkedAlign(afterValue, alignment, limit)
  if (size === undefined || size === 0) return unavailable(target, element, 'AlignmentRounding')
  return {
    _tag: 'LocalSharedControlBlockPlan',
    target: target.id,
    element,
    size,
    alignment,
    strongOffset,
    strongMaximum: strongMaximum(target),
    accessOffset,
    allocationOffset,
    valueOffset,
    provenance: `${target.id}:${Type.key(element)}:${size}:${alignment}`,
  }
}

/** Plans against the selected target's representable byte range. */
export const plan = (
  target: Target.Target,
  element: Type.Type,
  elementLayout: Layout.Entry,
): Selection => planWithin(target, element, elementLayout, maximum(target))
