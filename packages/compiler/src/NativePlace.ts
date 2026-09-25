import * as Emitter from '@silklang/llvm/Emitter'
import * as Block from '@silklang/llvm/Block'
import type * as Value from '@silklang/llvm/Value'
import * as Layout from './Layout.js'
import * as Mir from './Mir.js'
import * as NativeLanePointer from './NativeLanePointer.js'
import * as NativeType from './NativeType.js'
import * as NativeArith from './NativeArith.js'
import * as Type from './Type.js'
import * as ValueStorage from './ValueStorage.js'
import * as ValueType from './ValueType.js'

/** A typed storage location. Projection never stores a vector of cached payload values. */
export interface NativePlace {
  readonly _tag: 'NativePlace'
  readonly type: Mir.Type
  readonly view: string
  readonly base: Value.Input
  readonly size: number
  readonly alignment: number
  readonly representation: 'Value' | 'StoredComposite'
  readonly indirect: boolean
}

export interface Context {
  readonly body: Emitter.Body
  readonly types: NativeType.LoweringContext
  readonly lanePointers: NativeLanePointer.Context
}

/** Selects a compiler-owned storage view, including the exact identity of hidden captures. */
export const make = (
  layout: Layout.Plan,
  type: Mir.Type,
  base: Value.Input,
  representation: NativePlace['representation'] = 'Value',
): NativePlace => {
  const stored =
    representation === 'StoredComposite'
      ? ValueStorage.find(layout, 'CompositeCarrier', Mir.semanticType(type))?.stored
      : undefined
  const physical =
    representation === 'StoredComposite' ? stored : NativeType.addressLayout(layout, type)
  if (physical === undefined)
    throw new RangeError(`Missing planned place for ${Mir.typeText(type)}`)
  let view: string
  if (type._tag === 'EffectOutcome') view = ValueStorage.key('Outcome', type.type)
  else if (type._tag === 'EffectComposite') view = ValueStorage.key('CompositeCarrier', type.type)
  else if (type._tag === 'EffectValue' && type.storage === undefined)
    view = ValueStorage.captureKey(type.environment)
  else if (
    type._tag === 'CallableValue' &&
    type.storage === undefined &&
    type.environment !== undefined
  )
    view = ValueStorage.captureKey(type.environment)
  else view = `Value:${Type.runtimeKey(Mir.semanticType(type))}`
  if (stored !== undefined) view = stored.key
  return {
    _tag: 'NativePlace',
    type,
    view,
    base,
    size: physical.size,
    alignment: physical.alignment,
    representation,
    indirect: false,
  }
}

/** Borrows a semantic value already stored by the compiler's canonical memory layout. */
export const stored = (layout: Layout.Plan, type: Type.Type, base: Value.Input): NativePlace => {
  if (
    Type.isRepresented(type) &&
    Type.isExactRepresentationArgument(type.representation.argument)
  ) {
    const identity = type.representation.argument.identity
    let concrete: Mir.Type | undefined
    if (Type.isEffectIdentityArgument(identity))
      concrete = ValueType.effectValueByIdentity(
        layout,
        identity.identity,
        Type.isEffect(type.contract) ? type.contract : undefined,
        identity.owner,
      )
    else if (Type.isCallableIdentityArgument(identity) && Type.isCallable(type.contract))
      concrete = ValueType.callableValueByIdentity(layout, identity, type.contract)
    if (concrete === undefined) throw new RangeError('Stored executable lost its exact environment')
    return make(layout, concrete, base)
  }
  return make(
    layout,
    { _tag: 'EnvironmentBorrow', type, access: 'Shared' },
    base,
    ValueStorage.find(layout, 'CompositeCarrier', type)?.stored === undefined
      ? 'Value'
      : 'StoredComposite',
  )
}

/** Allocates one aligned byte extent; unlike scalarization this does not allocate per-field slots. */
export const allocate = (
  context: Context,
  type: Mir.Type,
  tag: string,
  placement: 'current' | 'entry' = 'current',
) => {
  const layout = NativeType.addressLayout(context.types.program.layout, type)
  if (layout === undefined) throw new RangeError('Cannot allocate an unavailable value layout')
  const base = Emitter.alloca(context.body, context.lanePointers.byteType, tag, {
    count: Emitter.integerUnsigned(
      context.body,
      context.lanePointers.offsetType,
      BigInt(layout.size),
    ),
    alignment: Emitter.alignment(context.body, layout.alignment),
    placement,
  })
  return make(context.types.program.layout, type, base)
}

/** Resolves one lane on demand from the current base; frame rebinding cannot leave stale addresses. */
export const lanePointer = (self: NativePlace, context: Context, ordinal: number, tag: string) => {
  const lane = NativeType.valueLanesFor(context.types, self.type).at(ordinal)
  const offset =
    lane === undefined
      ? undefined
      : NativeType.addressLaneOffset(context.types.program.layout, self.type, lane, ordinal)
  if (lane === undefined || offset === undefined)
    throw new RangeError(`Place lost lane ${ordinal} for ${Mir.typeText(self.type)}`)
  const physical = ValueStorage.scalarLayout(context.types.program.layout.target, lane)
  if (offset < 0 || offset + physical.size > self.size)
    throw new RangeError(
      `Place lane ${ordinal} at ${offset}+${physical.size} exceeds ${self.size} bytes for ${Mir.typeText(self.type)}`,
    )
  return NativeLanePointer.lanePointer(
    context.lanePointers,
    context.body,
    base(self, context, `${tag}_base`),
    offset,
    tag,
  )
}

/** A borrowed environment's pointer slot survives joins; its referent is resolved at each use. */
export const base = (self: NativePlace, context: Context, tag: string) => {
  return self.indirect
    ? Emitter.load(context.body, context.types.pointer, self.base, tag)
    : self.base
}

/** Reads exactly one selected slot. The result must not survive a possible alias write. */
export const loadLane = (self: NativePlace, context: Context, ordinal: number, tag: string) => {
  const lane = NativeType.valueLanesFor(context.types, self.type).at(ordinal)
  if (lane === undefined) throw new RangeError('Place read lost its lane type')
  const location =
    self.representation === 'StoredComposite'
      ? ValueStorage.location(context.types.program.layout, Mir.semanticType(self.type), lane)
      : NativeType.addressLocation(context.types.program.layout, self.type, lane, ordinal)
  if (location === undefined)
    throw new RangeError(`Place lost read location for ${Mir.typeText(self.type)}`)
  const value = readLocations(self, context, [{ lane, location }], tag).at(0)
  if (value === undefined) throw new RangeError('Selected storage read lost its value')
  return value
}

/** Writes one slot without loading or reconstructing any of its siblings. */
export const storeLane = (
  self: NativePlace,
  context: Context,
  ordinal: number,
  value: Value.Input,
  tag: string,
) => {
  const lane = NativeType.valueLanesFor(context.types, self.type).at(ordinal)
  if (lane === undefined) throw new RangeError('Place write lost its calling lane')
  const location =
    self.representation === 'StoredComposite'
      ? ValueStorage.location(context.types.program.layout, Mir.semanticType(self.type), lane)
      : NativeType.addressLocation(context.types.program.layout, self.type, lane, ordinal)
  if (location === undefined)
    throw new RangeError(`Place lost write location for ${Mir.typeText(self.type)}`)
  writeLocations(self, context, [{ lane, location, value }], tag)
}

const arithmetic = (context: Context): NativeArith.LaneContext => ({
  body: context.body,
  pointerBits: context.types.program.layout.target.pointerSize === 4 ? 32 : 64,
  i32: context.types.i32,
  integerTypes: context.types.integerTypes,
  types: context.types,
})

const storedPointer = (self: NativePlace, context: Context, offset: number, tag: string) => {
  if (offset === 0) return base(self, context, `${tag}_base`)
  return NativeLanePointer.lanePointer(
    context.lanePointers,
    context.body,
    base(self, context, `${tag}_base`),
    offset,
    tag,
  )
}

interface ReadRequest {
  readonly lane: Layout.CallingLane
  readonly location?: ValueStorage.Location
}

/** The place proves an extent, not stronger alignment than the address actually carries. */
const access = (self: NativePlace, context: Context, offset: number, lane: Layout.CallingLane) => {
  const physical = ValueStorage.scalarLayout(context.types.program.layout.target, lane)
  if (!Number.isSafeInteger(offset) || offset < 0 || offset + physical.size > self.size)
    throw new RangeError('Selected lane exceeds its planned place extent')
  let alignment = Math.min(self.alignment, physical.alignment)
  while (offset % alignment !== 0) alignment /= 2
  return { alignment: Emitter.alignment(context.body, alignment) }
}
interface WriteRequest extends ReadRequest {
  readonly value: Value.Input
}

/** Groups lanes by their enclosing stored union, so a boundary dispatches once per alternative. */
const choices = (requests: ReadonlyArray<ReadRequest>) => {
  const groups = new Map<
    number,
    Array<{
      readonly ordinal: number
      readonly location: Extract<ValueStorage.Location, { readonly _tag: 'Choice' }>
    }>
  >()
  for (const [ordinal, request] of requests.entries()) {
    if (request.location?._tag !== 'Choice') continue
    const group = groups.get(request.location.tagOffset) ?? []
    group.push({ ordinal, location: request.location })
    groups.set(request.location.tagOffset, group)
  }
  return groups
}

const readLocations = (
  self: NativePlace,
  context: Context,
  requests: ReadonlyArray<ReadRequest>,
  tag: string,
): ReadonlyArray<Value.Input> => {
  const values: Array<Value.Input | undefined> = Array.from(
    { length: requests.length },
    () => undefined,
  )
  for (const [ordinal, request] of requests.entries()) {
    if (request.location === undefined)
      values[ordinal] = Emitter.nullValue(
        context.body,
        NativeType.laneType(context.types, request.lane),
      )
    else if (request.location._tag === 'Slot') {
      const value = Emitter.load(
        context.body,
        NativeType.laneType(context.types, request.location.lane),
        storedPointer(self, context, request.location.offset, `${tag}_${ordinal}_ptr`),
        `${tag}_${ordinal}`,
        access(self, context, request.location.offset, request.location.lane),
      )
      values[ordinal] = NativeArith.coerceLane(
        arithmetic(context),
        value,
        request.location.lane,
        request.lane,
        `${tag}_${ordinal}_carrier`,
      )
    }
  }
  for (const [offset, group] of choices(requests)) {
    const tags = [
      ...new Set(
        group.flatMap((item) => item.location.alternatives.map((alternative) => alternative.tag)),
      ),
    ]
    const discriminant = Emitter.load(
      context.body,
      context.types.i32,
      storedPointer(self, context, offset, `${tag}_${offset}_tag_ptr`),
      `${tag}_${offset}_tag`,
      access(self, context, offset, { _tag: 'CallingLane', type: 'i32', path: [] }),
    )
    const done = Emitter.block(context.body, `${tag}_${offset}_done`)
    const incoming: Array<{
      readonly block: Block.Block
      readonly values: ReadonlyArray<Value.Input>
    }> = []
    const fallback = Emitter.block(context.body, `${tag}_${offset}_zero`)
    const dispatch = Emitter.switchTerminator(context.body, discriminant, fallback)
    for (const alternative of tags) {
      const selected = Emitter.block(context.body, `${tag}_${offset}_${alternative}_selected`)
      Emitter.addSwitchCase(
        context.body,
        dispatch,
        Emitter.integerSigned(context.body, context.types.i32, BigInt(alternative)),
        selected,
      )
      Emitter.setInsertionPoint(context.body, selected)
      const selectedRequests = group.map((item) => {
        const request = requests.at(item.ordinal)
        if (request === undefined) throw new RangeError('Union conversion lost a lane')
        const location = item.location.alternatives.find(
          (candidate) => candidate.tag === alternative,
        )?.location
        return { lane: request.lane, ...(location === undefined ? {} : { location }) }
      })
      const selectedValues = readLocations(
        self,
        context,
        selectedRequests,
        `${tag}_${offset}_${alternative}`,
      )
      let exit = selected
      if (selectedRequests.some((request) => request.location?._tag === 'Choice')) {
        exit = Emitter.block(context.body, `${tag}_${offset}_${alternative}_exit`)
        Emitter.branch(context.body, exit)
        Emitter.setInsertionPoint(context.body, exit)
      }
      Emitter.branch(context.body, done)
      incoming.push({ block: exit, values: selectedValues })
    }
    Emitter.sealSwitch(context.body, dispatch)
    Emitter.setInsertionPoint(context.body, fallback)
    const zero: Array<Value.Input> = []
    for (const item of group) {
      const request = requests.at(item.ordinal)
      if (request === undefined) throw new RangeError('Union conversion lost a result lane')
      zero.push(Emitter.nullValue(context.body, NativeType.laneType(context.types, request.lane)))
    }
    incoming.push({ block: fallback, values: zero })
    Emitter.branch(context.body, done)
    Emitter.setInsertionPoint(context.body, done)
    for (const [index, item] of group.entries()) {
      const request = requests.at(item.ordinal)
      if (request === undefined) throw new RangeError('Union conversion lost its join type')
      const phi = Emitter.phi(
        context.body,
        NativeType.laneType(context.types, request.lane),
        `${tag}_${item.ordinal}_result`,
      )
      for (const entry of incoming) {
        const value = entry.values.at(index)
        if (value === undefined) throw new RangeError('Union conversion lost a predecessor')
        Emitter.addPhiIncoming(context.body, phi, value, entry.block)
      }
      Emitter.sealPhi(context.body, phi)
      values[item.ordinal] = Emitter.phiValue(context.body, phi)
    }
  }
  return values.map((value) => {
    if (value === undefined) throw new RangeError('Incomplete storage conversion')
    return value
  })
}

const writeLocations = (
  self: NativePlace,
  context: Context,
  requests: ReadonlyArray<WriteRequest>,
  tag: string,
): void => {
  for (const [ordinal, request] of requests.entries()) {
    if (request.location?._tag !== 'Slot') continue
    const value = NativeArith.coerceLane(
      arithmetic(context),
      request.value,
      request.lane,
      request.location.lane,
      `${tag}_${ordinal}_stored`,
    )
    Emitter.store(
      context.body,
      value,
      storedPointer(self, context, request.location.offset, `${tag}_${ordinal}`),
      access(self, context, request.location.offset, request.location.lane),
    )
  }
  for (const [offset, group] of choices(requests)) {
    const tags = [
      ...new Set(
        group.flatMap((item) => item.location.alternatives.map((alternative) => alternative.tag)),
      ),
    ]
    const discriminant = Emitter.load(
      context.body,
      context.types.i32,
      storedPointer(self, context, offset, `${tag}_${offset}_tag_ptr`),
      `${tag}_${offset}_tag`,
      access(self, context, offset, { _tag: 'CallingLane', type: 'i32', path: [] }),
    )
    const done = Emitter.block(context.body, `${tag}_${offset}_done`)
    const dispatch = Emitter.switchTerminator(context.body, discriminant, done)
    for (const alternative of tags) {
      const selected = Emitter.block(context.body, `${tag}_${offset}_${alternative}_selected`)
      Emitter.addSwitchCase(
        context.body,
        dispatch,
        Emitter.integerSigned(context.body, context.types.i32, BigInt(alternative)),
        selected,
      )
      Emitter.setInsertionPoint(context.body, selected)
      writeLocations(
        self,
        context,
        group.flatMap((item) => {
          const request = requests.at(item.ordinal)
          const location = item.location.alternatives.find(
            (candidate) => candidate.tag === alternative,
          )?.location
          if (request === undefined) throw new RangeError('Union conversion lost a source lane')
          return location === undefined ? [] : [{ ...request, location }]
        }),
        `${tag}_${offset}_${alternative}`,
      )
      Emitter.branch(context.body, done)
    }
    Emitter.sealSwitch(context.body, dispatch)
    Emitter.setInsertionPoint(context.body, done)
  }
}

const requests = (self: NativePlace, context: Context): ReadonlyArray<ReadRequest> =>
  NativeType.valueLanesFor(context.types, self.type).map((lane, ordinal) => {
    const location =
      self.representation === 'StoredComposite'
        ? ValueStorage.location(context.types.program.layout, Mir.semanticType(self.type), lane)
        : NativeType.addressLocation(context.types.program.layout, self.type, lane, ordinal)
    if (location === undefined) throw new RangeError('Boundary conversion lost its storage plan')
    return { lane, location }
  })

/** One explicit storage-to-ABI conversion; no result is retained in the local map. */
export const loadSelected = (
  self: NativePlace,
  context: Context,
  ordinals: ReadonlyArray<number>,
  tag: string,
) => {
  const lanes = NativeType.valueLanesFor(context.types, self.type)
  return readLocations(
    self,
    context,
    ordinals.map((ordinal) => {
      const lane = lanes.at(ordinal)
      if (lane === undefined) throw new RangeError('Selected boundary lane is unavailable')
      const location =
        self.representation === 'StoredComposite'
          ? ValueStorage.location(context.types.program.layout, Mir.semanticType(self.type), lane)
          : NativeType.addressLocation(context.types.program.layout, self.type, lane, ordinal)
      if (location === undefined) throw new RangeError('Selected boundary location is unavailable')
      return { lane, location }
    }),
    tag,
  )
}

/** One explicit storage-to-ABI conversion; no result is retained in the local map. */
export const loadLanes = (self: NativePlace, context: Context, tag: string) => {
  return readLocations(self, context, requests(self, context), tag)
}

/** Initializes a boundary destination with one dispatch per stored union, not per lane. */
export const storeLanes = (
  self: NativePlace,
  context: Context,
  values: ReadonlyArray<Value.Input>,
  tag: string,
) => {
  const planned = requests(self, context)
  if (planned.length !== values.length)
    throw new RangeError(
      `Boundary ${tag} for ${Mir.typeText(self.type)} expected ${planned.length} lanes, received ${values.length}`,
    )
  writeLocations(
    self,
    context,
    planned.map((request, ordinal) => {
      const value = values.at(ordinal)
      if (value === undefined) throw new RangeError('Boundary conversion lost its source')
      return { ...request, value }
    }),
    tag,
  )
}

/** Projects a canonical field or element, retaining its own concrete view. */
export const project = (
  self: NativePlace,
  context: Context,
  type: Mir.Type,
  offset: number,
  tag: string,
  representation: NativePlace['representation'] = 'Value',
) => {
  const layout = context.types.program.layout
  const physical =
    representation === 'StoredComposite' && type._tag === 'EffectComposite'
      ? ValueStorage.find(layout, 'CompositeCarrier', type.type)?.stored
      : NativeType.addressLayout(layout, type)
  if (
    physical === undefined ||
    offset < 0 ||
    offset + physical.size > self.size ||
    offset % physical.alignment !== 0
  )
    throw new RangeError('Projection does not fit its selected parent layout')
  return make(
    context.types.program.layout,
    type,
    NativeLanePointer.lanePointer(
      context.lanePointers,
      context.body,
      base(self, context, `${tag}_base`),
      offset,
      tag,
    ),
    representation,
  )
}

/** Converts only a planner-admitted stored/carrier pair; equivalent views use a byte copy. */
export const transfer = (destination: NativePlace, context: Context, source: NativePlace) => {
  if (destination.representation === source.representation)
    return copy(destination, context, source)
  if (
    !Type.equals(Mir.semanticType(source.type), Mir.semanticType(destination.type)) ||
    ValueStorage.find(
      context.types.program.layout,
      'CompositeCarrier',
      Mir.semanticType(source.type),
    ) === undefined
  )
    throw new RangeError('Place transfer has no planned representation binding')
  storeLanes(destination, context, loadLanes(source, context, 'transfer_load'), 'transfer_store')
}

/**
 * Copies physical bytes between equivalent views, conservatively allowing overlap. This
 * does not transfer MIR initialization/drop obligations, and never interprets padding or
 * inactive payload bytes as scalar values. Ownership lowering remains their authority.
 */
export const copy = (destination: NativePlace, context: Context, source: NativePlace) => {
  if (destination.size !== source.size)
    throw new RangeError('Place copy requires equal planned extents')
  if (destination.view !== source.view) {
    // Exact captures and stored nominal fields have distinct identities. Prove their
    // physical correspondence instead of assuming that ABI lane order implies layout.
    const target = NativeType.valueLanesFor(context.types, destination.type)
    const sourceLanes = NativeType.valueLanesFor(context.types, source.type)
    if (
      target.length !== sourceLanes.length ||
      target.some((lane, ordinal) => {
        const other = sourceLanes.at(ordinal)
        return (
          other === undefined ||
          NativeType.laneType(context.types, lane) !== NativeType.laneType(context.types, other) ||
          NativeType.addressLaneOffset(
            context.types.program.layout,
            destination.type,
            lane,
            ordinal,
          ) !==
            NativeType.addressLaneOffset(context.types.program.layout, source.type, other, ordinal)
        )
      })
    )
      throw new RangeError('Place transfer requires an explicit representation conversion')
  }
  if (
    destination.size === 0 ||
    (destination.base === source.base && destination.indirect === source.indirect)
  )
    return
  Emitter.memmove(
    context.body,
    base(destination, context, 'copy_destination'),
    base(source, context, 'copy_source'),
    Emitter.integerUnsigned(
      context.body,
      context.lanePointers.offsetType,
      BigInt(destination.size),
    ),
    {
      destinationAlignment: Emitter.alignment(context.body, destination.alignment),
      sourceAlignment: Emitter.alignment(context.body, source.alignment),
    },
  )
}

/** Copies canonical failure bytes between outcome envelopes with different success layouts. */
export const copyFailure = (
  destination: NativePlace,
  context: Context,
  source: NativePlace,
  mappings: ReadonlyArray<{ readonly source: number; readonly target: number }>,
) => {
  if (destination.type._tag !== 'EffectOutcome' || source.type._tag !== 'EffectOutcome')
    throw new RangeError('Failure copy requires two outcome places')
  const layout = context.types.program.layout
  const from = ValueStorage.outcome(layout, source.type.type)
  const to = ValueStorage.outcome(layout, destination.type.type)
  let size = 0
  for (const mapping of mappings) {
    const sourceMember = from.members.find((member) => member.tag === mapping.source)
    const targetMember = to.members.find((member) => member.tag === mapping.target)
    if (
      mapping.source <= 0 ||
      mapping.target <= 0 ||
      sourceMember?.storage._tag !== 'Value' ||
      targetMember?.storage._tag !== 'Value' ||
      Type.runtimeKey(sourceMember.type) !== Type.runtimeKey(targetMember.type)
    )
      throw new RangeError('Failure copy requires matching canonical error members')
    const member = Layout.entry(layout, sourceMember.type)
    if (member === undefined) throw new RangeError('Failure copy lost its member layout')
    size = Math.max(size, member.size)
  }
  if (from.payloadOffset + size > source.size || to.payloadOffset + size > destination.size)
    throw new RangeError('Failure copy exceeds its outcome envelope')
  if (size === 0) return
  // The active error has identical storage in both envelopes. Copy the largest mapped
  // error extent, including padding/inactive bytes, without interpreting those bytes as
  // scalar lanes. Nested-union expansion produced thousands of instructions per HTTP run.
  Emitter.memmove(
    context.body,
    storedPointer(destination, context, to.payloadOffset, 'failure_destination'),
    storedPointer(source, context, from.payloadOffset, 'failure_source'),
    Emitter.integerUnsigned(context.body, context.lanePointers.offsetType, BigInt(size)),
    {
      destinationAlignment: Emitter.alignment(
        context.body,
        Math.min(destination.alignment, to.alignment),
      ),
      sourceAlignment: Emitter.alignment(context.body, Math.min(source.alignment, from.alignment)),
    },
  )
}
