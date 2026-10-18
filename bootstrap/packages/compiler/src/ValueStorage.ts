import * as Effect from 'effect/Effect'
import { alignUp } from './internal/Align.js'
import * as Layout from './Layout.js'
import * as LayoutVerify from './LayoutVerify.js'
import * as Instances from './Instances.js'
import * as Scalar from './Scalar.js'
import type * as Target from './Target.js'
import * as Type from './Type.js'
import * as DeclarationFacts from './DeclarationFacts.js'

/** A calling lane's stored representation may depend on an active overlay alternative. */
export type Location =
  | { readonly _tag: 'Slot'; readonly lane: Layout.CallingLane; readonly offset: number }
  | {
      readonly _tag: 'Choice'
      readonly tagOffset: number
      readonly alternatives: ReadonlyArray<{ readonly tag: number; readonly location: Location }>
    }

/**
 * Resolves ABI selectors through canonical storage, retaining overlay choices rather than
 * mistaking a unified carrier's ordinal for an offset in the largest member's bytes.
 * Union storage retains the active alternative's native field layout; calling carriers
 * convert through its selected locations rather than changing those bytes.
 */
export const location = (
  self: Layout.Plan,
  type: Type.Type,
  lane: Layout.CallingLane,
  base = 0,
): Location | undefined => {
  const [head, ...tail] = lane.path
  const entry = Layout.entry(self, type)
  const representation = entry?.representation
  const nested = (type: Type.Type, offset: number) =>
    location(self, type, { ...lane, path: tail }, base + offset)
  if (head?._tag === 'FieldId' && representation?._tag === 'Aggregate') {
    const field = representation.fields.find((field) =>
      DeclarationFacts.sameFieldId(field.id, head),
    )
    return field === undefined ? undefined : nested(field.type, field.offset)
  }
  if (head?._tag === 'ElementSelector' && representation?._tag === 'Repeated')
    return nested(representation.element, head.index * representation.stride)
  if (head?._tag === 'EffectCaptureSelector' || head?._tag === 'CallableCaptureSelector') {
    if (entry?.executable !== undefined) {
      const field = entry.executable.fields.find((field) => field.capture === head.ordinal)
      if (field !== undefined) {
        if (field.representation === 'Borrow')
          return { _tag: 'Slot', lane, offset: base + field.offset }
        return nested(field.type, field.offset)
      }
    }
    if (representation?._tag === 'StoredEffectEnvironment') {
      const field = representation.fields.find((field) => field.capture === head.ordinal)
      if (field !== undefined) return nested(field.type, field.offset)
    }
    if (representation?._tag === 'CallableEnvironment') {
      const field = representation.fields.find((field) => field.ordinal === head.ordinal)
      if (field !== undefined) return nested(field.type, field.offset)
    }
  }
  const composite = find(self, 'CompositeCarrier', type)?.stored
  if (head?._tag === 'NominalUnionPayloadSelector' && representation?._tag === 'NominalUnion') {
    const alternatives: Array<{ readonly tag: number; readonly location: Location }> = []
    for (const variant of representation.variants) {
      let slot = head.slot
      for (const field of variant.fields) {
        const lanes = Layout.callingShape(self, field.type)?.lanes
        if (lanes === undefined) return undefined
        const source = lanes.at(slot)
        if (source !== undefined) {
          const selected = location(
            self,
            field.type,
            source,
            base + representation.payloadOffset + field.offset,
          )
          if (selected === undefined) return undefined
          alternatives.push({ tag: variant.ordinal, location: selected })
          break
        }
        slot -= lanes.length
      }
    }
    return { _tag: 'Choice', tagOffset: base, alternatives }
  }
  if (head?._tag === 'UnionTagSelector' && composite !== undefined)
    return { _tag: 'Slot', lane, offset: base }
  if (
    head?._tag === 'UnionPayloadSelector' &&
    (representation?._tag === 'Union' || composite !== undefined)
  ) {
    const alternatives: Array<{ readonly tag: number; readonly location: Location }> = []
    const members =
      representation?._tag === 'Union'
        ? representation.members.map((member) => ({ tag: member.ordinal, type: member.type }))
        : (composite?.alternatives ?? [])
    const payloadOffset =
      representation?._tag === 'Union' ? representation.payloadOffset : composite?.payloadOffset
    if (payloadOffset === undefined) return undefined
    for (const member of members) {
      const source = Layout.callingShape(self, member.type)?.lanes.at(head.slot)
      if (source === undefined) continue
      const selected = location(self, member.type, source, base + payloadOffset)
      if (selected === undefined) return undefined
      alternatives.push({ tag: member.tag, location: selected })
    }
    return { _tag: 'Choice', tagOffset: base, alternatives }
  }
  const offset = LayoutVerify.laneOffset(self, type, lane.path)
  return offset === undefined ? undefined : { _tag: 'Slot', lane, offset: base + offset }
}

/** A physical value view is not an erased type's capture environment or its transport. */
export type Role = 'Outcome' | 'CompositeCarrier'

/** One typed physical slot. Logical member lanes may require conversion to this carrier. */
export interface Slot {
  readonly lane: Layout.CallingLane
  readonly offset: number
  readonly size: number
  readonly alignment: number
}

/** A selected member's logical lane maps to one physical slot, not a raw field pointer. */
export interface Member {
  readonly tag: number
  readonly type: Type.Type
  readonly lanes: ReadonlyArray<{
    readonly lane: Layout.CallingLane
    readonly slot: number
  }>
}

/** Compiler-owned storage facts. No backend value, pointer, or LLVM type belongs here. */
export interface View {
  readonly _tag: 'ValueStorage'
  readonly key: string
  readonly role: Role
  readonly type: Type.Type
  readonly size: number
  readonly alignment: number
  readonly slots: ReadonlyArray<Slot>
  readonly members: ReadonlyArray<Member>
  /** Existing inline alternative layout, distinct from this view's calling carrier. */
  readonly stored?: {
    readonly key: string
    readonly size: number
    readonly alignment: number
    readonly payloadOffset: number
    readonly alternatives: ReadonlyArray<{
      readonly tag: number
      readonly type: Type.Type
      readonly size: number
      readonly alignment: number
      readonly slots: ReadonlyArray<Slot>
    }>
  }
}

export interface Unavailable {
  readonly _tag: 'UnavailableValueStorage'
  readonly key: string
  readonly role: Role
  readonly type: Type.Type
  readonly reason: 'Overflow' | 'MissingMember' | 'InvalidMapping'
}

export type Selection = View | Unavailable

/** Role qualification keeps outcome storage distinct from an Effect's captured environment. */
export const key = (role: Role, type: Type.Type): string => `${role}:${Type.runtimeKey(type)}`

/** Exact capture identities cannot collide with an outcome's erased flow contract. */
export const captureKey = (
  environment:
    | Extract<Layout.EffectEnvironment, { readonly _tag: 'EffectEnvironment' }>
    | Extract<Layout.CallableEnvironment, { readonly _tag: 'CallableEnvironment' }>,
): string =>
  environment._tag === 'EffectEnvironment'
    ? `EffectCapture:${Instances.effectIdentity(environment.instance, environment.site)}`
    : `CallableCapture:${Type.runtimeCallableEnvironmentIdentityKey(Instances.callableEnvironmentIdentity(environment.callable))}`

/** The target ABI owns scalar size and alignment, including address-width selection. */
export const scalarLayout = (target: Target.Target, lane: Layout.CallingLane) => {
  if (typeof lane.type !== 'string')
    return { size: target.pointerSize, alignment: target.pointerAlignment }
  const scalar = Scalar.find(lane.type)
  if (scalar === undefined) throw new RangeError('Storage lane has no semantic scalar')
  return Scalar.resolveLayout(scalar, target)
}

export interface Transport {
  readonly entries: ReadonlyArray<Slot>
  readonly start: number
  readonly end: number
  readonly alignment: number
}

/** Slot correspondence across a memory boundary; copying padding needs a separate initialization proof. */
export interface Binding {
  readonly storageKey: string
  readonly transport: Transport
  readonly slots: ReadonlyArray<{
    readonly storageOffset: number
    readonly transportOffset: number
    readonly lane: Layout.CallingLane
  }>
  readonly identicalOffsets: boolean
}

/** Keeps the transport's actual header padding separate from the local carrier's layout. */
export const bind = (self: View, target: Target.Target, start: number): Binding => {
  const packed = transport(
    target,
    self.slots.map((slot) => slot.lane),
    start,
  )
  const slots = self.slots.map((slot, ordinal) => {
    const selected = packed.entries.at(ordinal)
    if (selected === undefined) throw new RangeError('Value transport lost a planned slot')
    return {
      storageOffset: slot.offset,
      transportOffset: selected.offset,
      lane: slot.lane,
    }
  })
  return {
    storageKey: self.key,
    transport: packed,
    slots: slots,
    identicalOffsets: slots.every((slot) => slot.storageOffset === slot.transportOffset - start),
  }
}

/**
 * Plans the existing lane transport at its actual start offset. Unlike a value extent,
 * transport ends at the final slot, without tail rounding. Adding a rounded local size
 * to `start` is incorrect when the header and payload have different alignments.
 */
export const transportWithin = (
  target: Target.Target,
  lanes: ReadonlyArray<Layout.CallingLane>,
  start: number,
  maximum: number,
): Transport | undefined => {
  if (!Number.isSafeInteger(start) || start < 0 || start > maximum) return undefined
  let cursor = start
  let alignment = 1
  const entries: Array<Slot> = []
  for (const lane of lanes) {
    const physical = scalarLayout(target, lane)
    cursor = alignUp(cursor, physical.alignment)
    const entry = { lane, offset: cursor, ...physical }
    cursor += physical.size
    if (!Number.isSafeInteger(cursor) || cursor > maximum) return undefined
    alignment = Math.max(alignment, physical.alignment)
    entries.push(entry)
  }
  return { entries: entries, start, end: cursor, alignment }
}

/** Selects checked target transport; an overflowing compiler-private record is a plan defect. */
export const transport = (
  target: Target.Target,
  lanes: ReadonlyArray<Layout.CallingLane>,
  start = 0,
): Transport => {
  const planned = transportWithin(
    target,
    lanes,
    start,
    target.pointerSize === 4 ? 0xffff_ffff : Number.MAX_SAFE_INTEGER,
  )
  if (planned === undefined)
    throw new RangeError('Compiler-private value transport exceeds target address space')
  return planned
}

/** Plans a tagged carrier from its existing ABI, retaining each logical member mapping. */
export const carrier = (
  target: Target.Target,
  role: Role,
  shape: Layout.CallingShape,
  members: ReadonlyArray<Member>,
  maximum = target.pointerSize === 4 ? 0xffff_ffff : Number.MAX_SAFE_INTEGER,
): Selection => {
  const packed = transportWithin(target, shape.lanes, 0, maximum)
  const identity = { key: key(role, shape.type), role, type: shape.type }
  if (packed === undefined)
    return { _tag: 'UnavailableValueStorage', ...identity, reason: 'Overflow' }
  const size = alignUp(packed.end, packed.alignment)
  if (!Number.isSafeInteger(size) || size > maximum)
    return { _tag: 'UnavailableValueStorage', ...identity, reason: 'Overflow' }
  const tags = new Set<number>()
  for (const member of members) {
    if (!Number.isSafeInteger(member.tag) || member.tag < 0 || tags.has(member.tag))
      return {
        _tag: 'UnavailableValueStorage',
        ...identity,
        reason: 'InvalidMapping',
      }
    tags.add(member.tag)
    const used = new Set<number>()
    for (const mapping of member.lanes) {
      const slot = packed.entries.at(mapping.slot)
      if (
        !Number.isSafeInteger(mapping.slot) ||
        mapping.slot < 1 ||
        slot === undefined ||
        used.has(mapping.slot) ||
        scalarLayout(target, mapping.lane).size > slot.size
      )
        return {
          _tag: 'UnavailableValueStorage',
          ...identity,
          reason: 'InvalidMapping',
        }
      used.add(mapping.slot)
    }
  }
  return {
    _tag: 'ValueStorage',
    ...identity,
    size,
    alignment: packed.alignment,
    slots: packed.entries,
    members: [...members],
  }
}

/** Creates the missing outcome and represented-composite carrier views during target planning. */
export const plan = (self: Layout.Plan): ReadonlyArray<Selection> => {
  const shapes = new Map(self.callingShapes.map((shape) => [Type.runtimeKey(shape.type), shape]))
  const views: Array<Selection> = []
  for (const shape of self.callingShapes) {
    const tree = shape.tree
    if (tree._tag !== 'OutcomeShape' && tree._tag !== 'EffectCompositeShape') continue
    const role: Role = tree._tag === 'OutcomeShape' ? 'Outcome' : 'CompositeCarrier'
    let types: ReadonlyArray<{ readonly tag: number; readonly type: Type.Type }>
    if (tree._tag === 'OutcomeShape')
      types = [
        { tag: 0, type: tree.type.success },
        ...tree.failures.map((failure) => ({ tag: failure.tag, type: failure.type })),
      ]
    else if (Type.isCompositeEffectRepresentationArgument(tree.type.representation.argument))
      types = tree.type.representation.argument.alternatives.map((alternative, tag) => ({
        tag,
        type: Type.represented(
          tree.type.contract,
          tree.type.representation.requiredBound,
          alternative,
        ),
      }))
    else types = []
    const members: Array<Member> = []
    let missing = false
    for (const member of types) {
      const memberShape = shapes.get(Type.runtimeKey(member.type))
      if (memberShape === undefined) {
        missing = true
        break
      }
      members.push({
        ...member,
        lanes: memberShape.lanes.map((lane, ordinal) => ({ lane, slot: ordinal + 1 })),
      })
    }
    const selected = missing
      ? {
          _tag: 'UnavailableValueStorage' as const,
          key: key(role, shape.type),
          role,
          type: shape.type,
          reason: 'MissingMember' as const,
        }
      : carrier(self.target, role, shape, members)
    if (selected._tag !== 'ValueStorage' || role !== 'CompositeCarrier') {
      views.push(selected)
      continue
    }
    const stored = Layout.entry(self, shape.type)
    const alternatives: Array<NonNullable<View['stored']>['alternatives'][number]> = []
    for (const member of members) {
      const entry = Layout.entry(self, member.type)
      if (entry === undefined) {
        missing = true
        break
      }
      const slots: Array<Slot> = []
      for (const mapping of member.lanes) {
        const offset = LayoutVerify.laneOffset(self, member.type, mapping.lane.path)
        const physical = scalarLayout(self.target, mapping.lane)
        if (
          offset === undefined ||
          offset < 0 ||
          offset + physical.size > entry.size ||
          offset % physical.alignment !== 0
        ) {
          missing = true
          break
        }
        slots.push({ lane: mapping.lane, offset, ...physical })
      }
      alternatives.push({
        tag: member.tag,
        type: member.type,
        size: entry.size,
        alignment: entry.alignment,
        slots: slots,
      })
    }
    const payloadAlignment = alternatives.reduce(
      (maximum, alternative) => Math.max(maximum, alternative.alignment),
      1,
    )
    const payloadOffset = alignUp(4, payloadAlignment)
    if (
      stored === undefined ||
      missing ||
      alternatives.some((alternative) => payloadOffset + alternative.size > stored.size)
    ) {
      views.push({
        _tag: 'UnavailableValueStorage',
        key: selected.key,
        role,
        type: selected.type,
        reason: 'MissingMember',
      })
      continue
    }
    views.push({
      ...selected,
      stored: {
        key: `CompositeStored:${Type.runtimeKey(shape.type)}`,
        size: stored.size,
        alignment: stored.alignment,
        payloadOffset,
        alternatives: alternatives,
      },
    })
  }
  return views.sort((left, right) => {
    if (left.key < right.key) return -1
    if (left.key > right.key) return 1
    return 0
  })
}

/** Selects a role-qualified view; an unavailable view must never reach address construction. */
export const find = (
  self: Pick<Layout.Plan, 'valueStorage'>,
  role: Role,
  type: Type.Type,
): View | undefined => {
  const identity = key(role, type)
  let lower = 0
  let upper = self.valueStorage.length
  while (lower < upper) {
    const middle = lower + Math.floor((upper - lower) / 2)
    const view = self.valueStorage.at(middle)
    if (view === undefined) return undefined
    if (view.key === identity) return view._tag === 'ValueStorage' ? view : undefined
    if (view.key < identity) lower = middle + 1
    else upper = middle
  }
  return undefined
}

/** Stable encoding includes both physical placements and logical-to-carrier conversions. */
const laneEncoding = (lane: Layout.CallingLane) => [
  typeof lane.type === 'string'
    ? lane.type
    : ['Address', Type.runtimeKey(lane.type.element), lane.type.bits],
  lane.path,
]

export const encode = (self: Selection): string =>
  JSON.stringify(
    self._tag === 'UnavailableValueStorage'
      ? [self._tag, self.key, self.reason]
      : [
          self._tag,
          self.key,
          self.size,
          self.alignment,
          self.slots.map((slot) => [
            laneEncoding(slot.lane),
            slot.offset,
            slot.size,
            slot.alignment,
          ]),
          self.members.map((member) => [
            member.tag,
            Type.runtimeKey(member.type),
            member.lanes.map((mapping) => [laneEncoding(mapping.lane), mapping.slot]),
          ]),
          self.stored === undefined
            ? null
            : [
                self.stored.key,
                self.stored.size,
                self.stored.alignment,
                self.stored.payloadOffset,
                self.stored.alternatives.map((alternative) => [
                  alternative.tag,
                  Type.runtimeKey(alternative.type),
                  alternative.size,
                  alternative.alignment,
                  alternative.slots.map((slot) => [
                    laneEncoding(slot.lane),
                    slot.offset,
                    slot.size,
                    slot.alignment,
                  ]),
                ]),
              ],
        ],
  )

/** Rejects missing, reordered, overflowing, or noncanonical views before backend emission. */
export const verify = Effect.fn('ValueStorage.verify')(function* (
  self: Layout.Plan,
): Effect.fn.Return<ReadonlyArray<Layout.Violation>> {
  const invalid: ReadonlyArray<Layout.Violation> = [
    {
      _tag: 'LayoutViolation',
      rule: 'InvalidValueStorage',
      detail: 'value storage does not match canonical target calling/member facts',
    },
  ]
  if (plan(self).some((view) => view._tag === 'UnavailableValueStorage')) return invalid
  const expected = plan({
    ...self,
    callingShapes: yield* Layout.planCallingShapes(
      self.target,
      self.entries,
      self.callingShapes.map((shape) => shape.type),
      self.effectEnvironments,
      self.callableEnvironments,
    ),
  })
  if (
    self.valueStorage.length === expected.length &&
    self.valueStorage.every((view, ordinal) => {
      const canonical = expected.at(ordinal)
      return (
        view._tag === 'ValueStorage' &&
        canonical !== undefined &&
        encode(view) === encode(canonical)
      )
    })
  )
    return []
  return invalid
})

/** Stored outcomes retain the active member's ordinary bytes; carrier lanes belong to transport. */
export interface Outcome {
  readonly size: number
  readonly alignment: number
  readonly payloadOffset: number
  readonly members: ReadonlyArray<
    Member & {
      readonly storage:
        | { readonly _tag: 'Value' }
        | { readonly _tag: 'Transport'; readonly slots: ReadonlyArray<Slot> }
    }
  >
}
const layouts = new WeakMap<Layout.Plan, Map<string, Outcome>>()

export const outcome = (plan: Layout.Plan, type: Type.Effect): Outcome => {
  let cache = layouts.get(plan)
  if (cache === undefined) {
    cache = new Map()
    layouts.set(plan, cache)
  }
  const key = Type.runtimeKey(type)
  const cached = cache.get(key)
  if (cached !== undefined) return cached
  const view = find(plan, 'Outcome', type)
  if (view === undefined) throw new RangeError('Native outcome lost its member plan')
  let alignment = 4
  let payloadSize = 0
  const members: Array<Outcome['members'][number]> = []
  for (const member of view.members) {
    const entry = Layout.entry(plan, member.type)
    if (entry !== undefined) {
      alignment = Math.max(alignment, entry.alignment)
      payloadSize = Math.max(payloadSize, entry.size)
      members.push({ ...member, storage: { _tag: 'Value' } })
      continue
    }
    // An erased executable has an ABI shape but no exact native environment. Its member
    // crosses an explicit lane transport; ordinary values retain their canonical bytes.
    if (member.lanes.length > 0 && !Type.isEffect(member.type) && !Type.isCallable(member.type))
      throw new RangeError(`Native outcome lost its member layout: ${Type.encode(member.type)}`)
    const packed = transport(
      plan.target,
      member.lanes.map(({ lane }) => lane),
    )
    alignment = Math.max(alignment, packed.alignment)
    payloadSize = Math.max(payloadSize, packed.end)
    members.push({ ...member, storage: { _tag: 'Transport', slots: packed.entries } })
  }
  const payloadOffset = alignUp(4, alignment)
  const selected = {
    size: alignUp(payloadOffset + payloadSize, alignment),
    alignment,
    payloadOffset,
    members,
  }
  cache.set(key, selected)
  return selected
}

/** Converts one explicit transport lane through the active native outcome member. */
export const outcomeLocation = (
  plan: Layout.Plan,
  type: Type.Effect,
  lane: Layout.CallingLane,
  ordinal: number,
): Location => {
  if (ordinal === 0) return { _tag: 'Slot', lane, offset: 0 }
  const view = outcome(plan, type)
  return {
    _tag: 'Choice',
    tagOffset: 0,
    alternatives: view.members.flatMap((member) => {
      const mapping = member.lanes.find((mapping) => mapping.slot === ordinal)
      if (mapping === undefined) return []
      let selected: Location | undefined
      if (member.storage._tag === 'Value')
        selected = location(plan, member.type, mapping.lane, view.payloadOffset)
      else {
        const slot = member.storage.slots.at(member.lanes.indexOf(mapping))
        if (slot === undefined) throw new RangeError('Outcome member lost its transport slot')
        selected = { _tag: 'Slot', lane: mapping.lane, offset: view.payloadOffset + slot.offset }
      }
      if (selected === undefined) throw new RangeError('Native outcome lost a member lane')
      return [{ tag: member.tag, location: selected }]
    }),
  }
}
