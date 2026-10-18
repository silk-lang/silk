import * as Instances from './Instances.js'
import { alignUp } from './internal/Align.js'
import * as Layout from './Layout.js'
import * as ValueStorage from './ValueStorage.js'
import * as Mir from './Mir.js'
import * as MirVerification from './MirVerification.js'
import * as StaticValue from './StaticValue.js'
import * as SilkType from './Type.js'

const pointKey = (point: Mir.SuspensionPointId): string =>
  [
    point.owner.declaration.module,
    point.owner.declaration.name,
    ...point.owner.typeArguments.map(SilkType.genericArgumentKey),
    ...point.owner.staticArguments.map(StaticValue.key),
    ...point.owner.contractRow,
    point.sourceId,
    point.spanStart,
    point.spanEnd,
    point.ordinal,
  ].join('\u0000')

/** Canonical payload extent shared by planning, verification, and frame lowering. */
export const storageOf = (
  program: Mir.Module,
  slot: Mir.CoroutineFrameSlot,
): { readonly size: number; readonly alignment: number } | undefined => {
  // BorrowedDependency describes lifetime authority, not the descriptor's width.
  // A slice retains both address and length; only EnvironmentBorrow is one pointer.
  if (slot.type._tag === 'EnvironmentBorrow')
    return {
      size: program.layout.target.pointerSize,
      alignment: program.layout.target.pointerAlignment,
    }
  if (slot.type._tag === 'EffectOutcome')
    return ValueStorage.outcome(program.layout, slot.type.type)
  if (slot.type._tag === 'EffectComposite')
    return ValueStorage.find(program.layout, 'CompositeCarrier', slot.type.type)
  if (
    (slot.type._tag === 'EffectValue' || slot.type._tag === 'CallableValue') &&
    slot.type.storage !== undefined
  )
    return Layout.entry(program.layout, slot.type.storage.type)
  if (slot.type._tag === 'EffectValue')
    return {
      size: slot.type.environment.size,
      alignment: slot.type.environment.alignment,
    }
  if (slot.type._tag === 'CallableValue') {
    const view = slot.type.environment
    return {
      size: view?.size ?? 0,
      alignment: view?.alignment ?? 1,
    }
  }
  const entry = Layout.entry(program.layout, Mir.semanticType(slot.type))
  return entry === undefined ? undefined : { size: entry.size, alignment: entry.alignment }
}

const planState = (
  program: Mir.Module,
  state: Mir.CoroutineFrameState,
  headerSize: number,
  offsets: ReadonlyMap<number, number>,
): Mir.CoroutineFrameTargetStateLayout | undefined => {
  let cursor = headerSize
  let alignment: number = program.layout.target.pointerAlignment
  const payload: Array<Mir.CoroutineFramePayloadField> = []
  for (const slot of state.slots) {
    const storage = storageOf(program, slot)
    if (storage === undefined || storage.alignment < 1 || storage.size < 0) return undefined
    const offset = offsets.get(slot.local.ordinal)
    if (offset === undefined || offset < cursor) return undefined
    payload.push({
      _tag: 'CoroutineFramePayloadField',
      slot: slot.ordinal,
      local: slot.local,
      type: slot.type,
      access: slot.access,
      initialization: slot.initialization,
      offset,
      size: storage.size,
      alignment: storage.alignment,
      padding: offset - cursor,
    })
    cursor = offset + storage.size
    alignment = Math.max(alignment, storage.alignment)
  }
  const size = alignUp(cursor, alignment)
  return {
    _tag: 'CoroutineFrameTargetStateLayout',
    point: state.point,
    size,
    alignment,
    payload: payload,
    tailPadding: size - cursor,
  }
}

const planDescriptor = (
  program: Mir.Module,
  descriptor: Mir.CoroutineFrameDescriptor,
): Mir.CoroutineFrameTargetLayout | undefined => {
  const wordSize = program.layout.target.pointerSize
  const wordAlignment = program.layout.target.pointerAlignment
  const roles = Mir.coroutineFrameHeaderRoles(program)
  const header = roles.map((role, ordinal) => ({
    _tag: 'CoroutineFrameHeaderField' as const,
    role,
    offset: ordinal * wordSize,
    size: wordSize,
    alignment: wordAlignment,
  }))
  // A live borrow can retain a local's frame address across several states. Assign one home
  // per retained local for the whole invocation; independently packing each live set can move
  // that home when an earlier temporary dies. States still store and clean up only live slots.
  const offsets = new Map<number, number>()
  const slots = new Map(
    descriptor.states.flatMap((state) =>
      state.slots.map((slot) => [slot.local.ordinal, slot] as const),
    ),
  )
  let cursor = header.length * wordSize
  for (const [local, slot] of [...slots].sort(([left], [right]) => left - right)) {
    const storage = storageOf(program, slot)
    if (storage === undefined || storage.alignment < 1 || storage.size < 0) return undefined
    const offset = alignUp(cursor, storage.alignment)
    offsets.set(local, offset)
    cursor = offset + storage.size
  }
  const states = descriptor.states.flatMap((state) => {
    const planned = planState(program, state, header.length * wordSize, offsets)
    return planned === undefined ? [] : [planned]
  })
  if (states.length !== descriptor.states.length) return undefined
  states.sort((left, right) => pointKey(left.point).localeCompare(pointKey(right.point)))
  const alignment = Math.max(wordAlignment, ...states.map((state) => state.alignment))
  const payloadEnd = Math.max(header.length * wordSize, ...states.map((state) => state.size))
  const fn = program.functions.find((candidate) =>
    Mir.matchesInstanceKey(candidate, descriptor.function),
  )
  if (fn === undefined) return undefined
  const diagnosticScopes = Mir.diagnosticScopeLocals(fn).map((scope, ordinal) => ({
    scope,
    offset: alignUp(payloadEnd, wordAlignment) + ordinal * wordSize * Mir.diagnosticScopeWords,
  }))
  const outcomesStart =
    alignUp(payloadEnd, wordAlignment) +
    diagnosticScopes.length * wordSize * Mir.diagnosticScopeWords
  const diagnosticOutcomes = Mir.diagnosticOutcomeLocals(program, fn).map((outcome, ordinal) => ({
    outcome,
    offset: outcomesStart + ordinal * wordSize * Mir.diagnosticOutcomeWords,
  }))
  const size = alignUp(
    outcomesStart + diagnosticOutcomes.length * wordSize * Mir.diagnosticOutcomeWords,
    alignment,
  )
  return {
    _tag: 'CoroutineFrameTargetLayout',
    function: descriptor.function,
    size,
    alignment,
    header,
    states: states,
    diagnosticScopes: diagnosticScopes,
    diagnosticOutcomes: diagnosticOutcomes,
  }
}

/** Plans one maximum target layout for each frame-producing specialized invocation. */
export const plan = (program: Mir.Module): Mir.CoroutineFramePlan | undefined => {
  const entries = program.functions.flatMap((fn) => {
    const descriptor = fn.suspension?.frame
    if (descriptor === undefined) return []
    const entry = planDescriptor(program, descriptor)
    return entry === undefined ? [] : [entry]
  })
  if (entries.length === 0) return undefined
  entries.sort((left, right) =>
    Instances.keyText(left.function).localeCompare(Instances.keyText(right.function)),
  )
  return {
    _tag: 'CoroutineFramePlan',
    target: program.layout.target,
    entries: entries,
  }
}

/** Finds one mutually-exclusive state layout inside its invocation's maximum frame. */
export const stateLayout = (
  program: Mir.Module,
  point: Mir.SuspensionPointId,
): Mir.CoroutineFrameTargetStateLayout | undefined =>
  // The full instance key — contractRow included — selects the entry; specializations can differ
  // only in contractRow.
  program.coroutineFrames?.entries
    .find((entry) => Instances.keyText(entry.function) === Instances.keyText(point.owner))
    ?.states.find((state) => pointKey(state.point) === pointKey(point))

export type CleanupPayloadField = Mir.CoroutineFramePayloadField & {
  readonly access: Extract<Mir.CoroutineFrameAccess, { readonly _tag: 'AffineTransfer' }>
}

const isCleanupPayloadField = (
  field: Mir.CoroutineFramePayloadField,
): field is CleanupPayloadField => field.access._tag === 'AffineTransfer'

/** Orders physical payload cleanup by the canonical ownership failure path. */
export const cleanupReleases = (
  fn: Mir.MirFunction,
  layout: Mir.CoroutineFrameTargetStateLayout,
): ReadonlyArray<CleanupPayloadField> => {
  const state = fn.suspension?.frame?.states.find(
    (candidate) => pointKey(candidate.point) === pointKey(layout.point),
  )
  if (state === undefined) throw new RangeError('coroutine cleanup lost its ownership state')
  const fields = layout.payload.filter(isCleanupPayloadField)
  const byLocal = new Map(fields.map((field) => [field.local.ordinal, field]))
  const ordered = state.failure.releases.flatMap((release) => {
    const field = byLocal.get(release.local.ordinal)
    return field === undefined ? [] : [field]
  })
  const dependencyOrder = MirVerification.invocationReleaseOrder(
    state.invocationUses ?? [],
    state.failure.releases,
  )
  if (
    new Set(ordered.map((field) => field.local.ordinal)).size !== fields.length ||
    dependencyOrder === undefined ||
    dependencyOrder.some(
      (release, ordinal) =>
        release.local.ordinal !== state.failure.releases.at(ordinal)?.local.ordinal,
    ) ||
    ordered.length !== fields.length
  )
    throw new RangeError('coroutine cleanup diverged from its canonical release plan')
  return ordered
}

/** Attaches physical target plans without changing target-neutral frame descriptors. */
export const apply = (program: Mir.Module): Mir.Module => {
  const coroutineFrames = plan(program)
  return coroutineFrames === undefined ? program : { ...program, coroutineFrames }
}

/** Stable compact evidence used by tests and later backend artifact checks. */
export const summary = (self: Mir.CoroutineFramePlan): string =>
  self.entries
    .map(
      (entry) =>
        `${Instances.keyText(entry.function)} size=${entry.size} align=${entry.alignment} storage=private-execution-stack header=${entry.header
          .map((field) => `${field.role}@${field.offset}:${field.size}/${field.alignment}`)
          .join(',')} states=${entry.states
          .map(
            (state) =>
              `${pointKey(state.point)}[${state.payload
                .map(
                  (field) =>
                    `${field.slot}:l${field.local.ordinal}@${field.offset}:${field.size}/${field.alignment}+${field.padding}`,
                )
                .join(',')}]`,
          )
          .join(';')}`,
    )
    .join('\n')
