import * as Emitter from '@silklang/llvm/Emitter'
import * as NativeExecutionStorage from './NativeExecutionStorage.js'
import * as FunctionIndex from './internal/FunctionIndex.js'
import * as NativeArgument from './NativeArgument.js'
import type * as FunctionActor from '@silklang/llvm/Function'
import type * as LlvmType from '@silklang/llvm/Type'
import type * as Value from '@silklang/llvm/Value'
import * as CleanupPlan from './CleanupPlan.js'
import * as DeclarationFacts from './DeclarationFacts.js'
import * as Layout from './Layout.js'
import * as LocalSharedControlBlock from './LocalSharedControlBlock.js'
import * as LocalSharedPayloadCleanup from './LocalSharedPayloadCleanup.js'
import * as Match from './Match.js'
import * as Mir from './Mir.js'
import * as MovePath from './MovePath.js'
import * as NativeArith from './NativeArith.js'
import * as NativeCall from './NativeCall.js'
import * as NativeResult from './NativeResult.js'
import * as NativeExecutionOperation from './NativeExecutionOperation.js'
import * as NativeLanePointer from './NativeLanePointer.js'
import type * as NativeLoweringContext from './NativeLoweringContext.js'
import * as NativeStorage from './NativeStorage.js'
import * as NativePayload from './NativePayload.js'
import * as NativePlace from './NativePlace.js'
import * as Tir from './Tir.js'
import * as ValueStorage from './ValueStorage.js'
import * as ValueType from './ValueType.js'
import * as NativeType from './NativeType.js'
import * as SilkType from './Type.js'

/** Resolves one field's byte offset from an aggregate layout. */
export const fieldOffset = (layout: Layout.Plan, type: SilkType.Type, name: string): number => {
  const planned = Layout.entry(layout, type)
  if (planned?.representation._tag !== 'Aggregate')
    throw new RangeError(`LLVM raw storage lost aggregate ${SilkType.encode(type)}`)
  const field = planned.representation.fields.find((candidate) => candidate.name === name)
  if (field === undefined) throw new RangeError(`LLVM raw storage lost field ${name}`)
  return field.offset
}

export interface FailureContext {
  readonly builder: Emitter.Module
  readonly body: Emitter.Body
  readonly program: Mir.Module
  readonly i32: LlvmType.Type
  readonly types: NativeType.LoweringContext
  readonly arith: NativeArith.LaneContext
}

/** Repacks one semantic failure payload into the target Effect outcome layout. */
export const failurePayload = (
  context: FailureContext,
  source: ReadonlyArray<Value.Input>,
  sourceType: DeclarationFacts.SemanticType,
  sourceTag: Value.Input | undefined,
  targetType: SilkType.Effect,
  mappings: ReadonlyArray<{ readonly source: number; readonly target: number }>,
  label: string,
): ReadonlyArray<Value.Input> => {
  const targetShape = Layout.callingShape(context.program.layout, targetType)
  if (targetShape?.tree._tag !== 'OutcomeShape')
    throw new RangeError('LLVM failure propagation lost its target calling shape')
  if (targetShape.lanes.length === 1) return []
  // A repacking plan depends on the member mapping, not the destination lane. Parser
  // outcomes have wide success payloads, so rebuilding this plan inside the lane loop
  // repeatedly traversed the same layouts during cold native compilation.
  const prepared = [...mappings].reverse().map((mapping) => {
    const repacking = Layout.failurePayloadRepacking(
      context.program.layout,
      sourceType,
      mapping.source,
      targetType,
      mapping.target,
    )
    if (repacking === undefined)
      throw new RangeError('LLVM failure propagation has an invalid member mapping')
    return { mapping, lanes: new Map(repacking.lanes.map((lane) => [lane.targetOrdinal, lane])) }
  })
  const payload: Array<Value.Input> = []
  for (const [targetOrdinal, targetLane] of targetShape.lanes.slice(1).entries()) {
    let selected: Value.Input = Emitter.nullValue(
      context.builder,
      NativeType.laneType(context.types, targetLane),
    )
    // No mapped failure carries this lane. Every arm and the default would be zero,
    // regardless of the source tag. Keep the zero without emitting compares/selects.
    // This also covers zero-field errors carried alongside a wide success value.
    if (prepared.every(({ lanes }) => !lanes.has(targetOrdinal))) {
      payload.push(selected)
      continue
    }
    for (const [mappingOrdinal, { mapping, lanes }] of prepared.entries()) {
      const lane = lanes.get(targetOrdinal)
      const sourceValue = lane === undefined ? undefined : source.at(lane.sourceOrdinal)
      let candidate: Value.Input = Emitter.nullValue(
        context.builder,
        NativeType.laneType(context.types, targetLane),
      )
      if (lane !== undefined && sourceValue !== undefined) {
        const member = NativeArith.coerceLane(
          context.arith,
          sourceValue,
          lane.source,
          lane.member,
          `${label}_${targetOrdinal}_${mappingOrdinal}_member`,
        )
        candidate = NativeArith.coerceLane(
          context.arith,
          member,
          lane.member,
          lane.target,
          `${label}_${targetOrdinal}_${mappingOrdinal}_carrier`,
        )
      }
      if (sourceTag === undefined) {
        selected = candidate
        continue
      }
      const matches = Emitter.integerCompare(
        context.body,
        'eq',
        sourceTag,
        Emitter.integerSigned(context.builder, context.i32, BigInt(mapping.source)),
        `${label}_${targetOrdinal}_${mappingOrdinal}_matches`,
      )
      selected = Emitter.select(
        context.body,
        matches,
        candidate,
        selected,
        `${label}_${targetOrdinal}_${mappingOrdinal}_select`,
      )
    }
    payload.push(selected)
  }
  return payload
}

/** Field paths to reclaim contexts, or undefined when guarded structural cleanup is required. */
export const reclaimContextPaths = (
  plan: CleanupPlan.CleanupPlan,
  prefix: ReadonlyArray<DeclarationFacts.FieldId> = [],
): ReadonlyArray<ReadonlyArray<DeclarationFacts.FieldId>> | undefined => {
  if (!CleanupPlan.reclaims(plan)) return CleanupPlan.hasHook(plan) ? undefined : []
  switch (plan._tag) {
    case 'NoCleanup':
    case 'ParameterCleanup':
      return []
    case 'AllocationCleanup':
    case 'RawBufferCleanup':
      return [prefix]
    case 'StructCleanup': {
      const collected: Array<ReadonlyArray<DeclarationFacts.FieldId>> = []
      for (const field of plan.fields) {
        const nested = reclaimContextPaths(field.cleanup, [...prefix, field.field])
        if (nested === undefined) return undefined
        collected.push(...nested)
      }
      return collected
    }
    default:
      return undefined
  }
}

const captureType = (
  layout: Layout.Plan,
  field: Layout.CallableEnvironmentField | Layout.EffectEnvironmentField,
): Mir.Type | undefined => {
  const contract = SilkType.isRepresented(field.type) ? field.type.contract : field.type
  if (field.callableIdentity !== undefined && SilkType.isCallable(contract)) {
    const type = ValueType.callableValueByIdentity(layout, field.callableIdentity, contract)
    if (type === undefined)
      throw new RangeError('Capture cleanup lost its exact callable environment')
    return type
  }
  if ('effectIdentity' in field && field.effectIdentity !== undefined) {
    const environment = Layout.effectEnvironmentByFieldIdentity(
      layout,
      field.resolvedEffectIdentity ?? field.effectIdentity,
    )
    if (environment === undefined)
      throw new RangeError('Capture cleanup lost its exact Effect environment')
    return { _tag: 'EffectValue', type: environment.effect, site: environment.site, environment }
  }
  return undefined
}

/**
 * The concrete place type a structural projection must borrow for one nested cleanup obligation.
 *
 * An `EffectCleanup` or `CallableCleanup` carries the semantic contract (`once Effect<'static; i32>`)
 * as its `type`, and no layout entry is ever planned for that contract: storage is planned for the
 * specialized environment the cleanup names through its `site` or environment identity. Projecting
 * such a field by its contract alone therefore looks for a place that cannot exist. Resolving the
 * environment here keeps every structural projection — struct fields, array elements, union members
 * — borrowing the same exact type the direct executable cleanup paths already borrow.
 */
const concreteCleanupType = (
  layout: Layout.Plan,
  plan: CleanupPlan.CleanupPlan,
): Mir.Type | undefined => {
  if (plan._tag === 'EffectCleanup') {
    const environment = layout.effectEnvironments.find(
      (
        candidate,
      ): candidate is Extract<Layout.EffectEnvironment, { readonly _tag: 'EffectEnvironment' }> =>
        candidate._tag === 'EffectEnvironment' && Tir.sameExecutableSite(candidate.site, plan.site),
    )
    if (environment === undefined)
      throw new RangeError('Stored Effect cleanup lost its exact environment')
    return { _tag: 'EffectValue', type: environment.effect, site: environment.site, environment }
  }
  if (plan._tag === 'CallableCleanup') {
    if (plan.environment._tag !== 'CallableEnvironmentIdentity') return undefined
    const environment = Layout.callableEnvironmentByIdentity(layout, plan.environment.identity)
    if (environment === undefined)
      throw new RangeError('Stored callable cleanup lost its exact environment')
    return {
      _tag: 'CallableValue',
      type: { ...environment.callable.type, mode: environment.callable.mode },
      target: environment.callable.target,
      typeArguments: environment.callable.typeArguments,
      site: environment.callable.site,
      environment,
    }
  }
  return undefined
}

const storedFieldOffset = (
  layout: Layout.Plan,
  type: SilkType.Type,
  id: DeclarationFacts.FieldId,
): number => {
  const representation = Layout.entry(layout, type)?.representation
  const field =
    representation?._tag === 'Aggregate'
      ? representation.fields.find((field) => DeclarationFacts.sameFieldId(field.id, id))
      : undefined
  if (field === undefined) throw new RangeError('Struct cleanup lost its stored field')
  return field.offset
}
const nominalFieldOffset = (
  layout: Layout.Plan,
  type: SilkType.Type,
  ordinal: number,
  id: DeclarationFacts.FieldId,
): number => {
  const representation = Layout.entry(layout, type)?.representation
  const variant =
    representation?._tag === 'NominalUnion'
      ? representation.variants.find((variant) => variant.ordinal === ordinal)
      : undefined
  const field = variant?.fields.find((field) => DeclarationFacts.sameFieldId(field.id, id))
  if (representation?._tag !== 'NominalUnion' || field === undefined)
    throw new RangeError('Nominal cleanup lost its stored field')
  return representation.payloadOffset + field.offset
}
const arrayElementOffset = (layout: Layout.Plan, type: SilkType.Type, index: number): number => {
  const representation = Layout.entry(layout, type)?.representation
  if (representation?._tag !== 'Repeated')
    throw new RangeError('Array cleanup lost its stored stride')
  return index * representation.stride
}
const unionPayloadOffset = (layout: Layout.Plan, type: SilkType.Type): number => {
  const representation = Layout.entry(layout, type)?.representation
  if (representation?._tag !== 'Union')
    throw new RangeError('Union cleanup lost its stored payload')
  return representation.payloadOffset
}

export interface Context {
  readonly builder: Emitter.Module
  readonly body: Emitter.Body
  readonly program: Mir.Module
  readonly i8: LlvmType.Type
  readonly i32: LlvmType.Type
  readonly pointer: LlvmType.Type
  readonly usizeType?: LlvmType.Type
  readonly free?: FunctionActor.Function
  readonly executionStorage?: NativeExecutionStorage.NativeExecutionStorage
  readonly resumeThunks: ReadonlyMap<
    string,
    {
      readonly handle: FunctionActor.Function
      readonly layout: Mir.CoroutineFrameTargetStateLayout
      readonly region: Mir.RunSuspendableEffectRegion
    }
  >
  readonly declared: ReadonlyArray<NativeLoweringContext.DeclaredFunction>
  readonly types: NativeType.LoweringContext
  readonly lanePointers: NativeLanePointer.Context
  readonly call: NativeCall.Context
  readonly arith: NativeArith.LaneContext
  readonly storage: NativeStorage.Context
  /** A cancelled frame's flags use its owner's local ordinals, independent of the caller. */
  readonly initializationValues?: ReadonlyMap<number, Value.Input>
  /** The module's out-of-line Execution release; see `NativeExecutionOperation.emitReleaseHelper`. */
  readonly executionRelease?: FunctionActor.Function
}

/**
 * Releases one owned value through its complete cleanup plan. Hooks receive its original
 * canonical storage; only ABI boundary values require initial materialization. Inner cleanup
 * observes hook mutations, fields release in declaration order, and each ticket releases once.
 */
interface Initialization {
  readonly state: MovePath.State
  readonly flags: NonNullable<Mir.DropOperation['initialization']>['flags']
  readonly path?: MovePath.Path
}

const childInitialization = (
  self: Initialization | undefined,
  selector: MovePath.Selector,
): Initialization | undefined => {
  if (self === undefined) return undefined
  const key = MovePath.key([selector])
  const child = self.state.children.find((candidate) => MovePath.key([candidate.selector]) === key)
  return {
    state: child?.state ?? MovePath.make(self.state.initialization),
    flags: self.flags,
    path: [...(self.path ?? []), selector],
  }
}

export const dropThroughPlan = (
  context: Context,
  plan: CleanupPlan.CleanupPlan,
  values: NativePayload.NativePayload,
  tag: string,
  localSharedBlock?: LocalSharedControlBlock.Plan,
  initialization?: Initialization,
): void => {
  const {
    builder,
    body,
    program,
    i8,
    i32,
    pointer,
    usizeType,
    free,
    declared,
    lanePointers,
    call,
    storage,
    types,
  } = context
  if (initialization?.state.initialization === 'Missing') return
  if (initialization?.state.initialization === 'Maybe') {
    const path = initialization.path ?? []
    const flag = initialization.flags
      .filter(
        (candidate) =>
          candidate.path.length <= path.length && MovePath.overlaps(candidate.path, path),
      )
      .sort((left, right) => right.path.length - left.path.length)
      .at(0)
    if (flag === undefined) throw new RangeError('Conditional cleanup lost its initialization flag')
    const initialized =
      context.initializationValues === undefined
        ? NativeStorage.readScalar(storage, flag.local)
        : context.initializationValues.get(flag.local.ordinal)
    if (initialized === undefined)
      throw new RangeError('Conditional frame cleanup lost its retained initialization flag')
    const condition = Emitter.integerCompare(
      body,
      'ne',
      initialized,
      Emitter.integerSigned(builder, i32, 0n),
      `${tag}_is_initialized`,
    )
    const selected = Emitter.block(body, `${tag}_initialized`)
    const following = Emitter.block(body, `${tag}_initialization_next`)
    Emitter.conditionalBranch(body, condition, selected, following)
    Emitter.setInsertionPoint(body, selected)
    dropThroughPlan(context, plan, values, tag, localSharedBlock, {
      ...initialization,
      state: { ...initialization.state, initialization: 'Initialized' },
    })
    Emitter.branch(body, following)
    Emitter.setInsertionPoint(body, following)
    NativeStorage.reloadRoots(storage, `${tag}_initialization_next`)
    return
  }
  const semanticLanesOf = (type: SilkType.Type): ReadonlyArray<Layout.CallingLane> => {
    const shape = Layout.callingShape(program.layout, type)
    if (shape === undefined)
      throw new RangeError(`LLVM cleanup lost calling shape for ${SilkType.encode(type)}`)
    return shape.lanes
  }
  switch (plan._tag) {
    case 'NoCleanup':
    case 'ParameterCleanup':
      return
    case 'ExecutionCleanup': {
      const base = NativePayload.at(values, context, 0, `${tag}_base`)
      if (base === undefined || context.executionRelease === undefined)
        throw new RangeError('LLVM Execution cleanup lost its release helper')
      // A synchronous call, not a bare `callDirect`: the helper may run user drop hooks, so the
      // caller's address-taken roots reload exactly as they did for the former inline expansion.
      NativeResult.sourceValues(
        NativeResult.materialize(
          context.storage,
          NativeCall.callSynchronous(
            call.synchronous,
            {
              handle: context.executionRelease,
              resultLaneCount: 0,
              suspendable: false,
              ...(Mir.hasDiagnosticObservation(program) ? { diagnosticParameter: 1 } : {}),
            },
            NativeArgument.fromValues([base]),
            `${tag}_release`,
          ),
          `${tag}_source_result`,
        ),
      )
      return
    }
    case 'WakeCleanup':
      return NativeExecutionOperation.dropWake(
        context,
        NativePayload.materialize(values, context, tag),
        tag,
      )
    case 'CallableCleanup': {
      if (plan.environment._tag !== 'CallableEnvironmentIdentity')
        throw new RangeError('LLVM callable cleanup lost its specialized environment')
      const environment = Layout.callableEnvironmentByIdentity(
        program.layout,
        plan.environment.identity,
      )
      for (const slot of plan.slots) {
        const field = environment?.fields.find((field) => field.ordinal === slot.ordinal)
        const range = Layout.callableCaptureRange(
          program.layout,
          plan.environment.identity,
          slot.ordinal,
        )
        if (range === undefined || field === undefined)
          throw new RangeError('LLVM callable cleanup lost an owned capture lane')
        dropThroughPlan(
          context,
          slot.cleanup,
          NativePayload.projectStored(
            values,
            context,
            field.type,
            range.byteOffset,
            Array.from({ length: range.laneCount }, (_, ordinal) => range.laneOffset + ordinal),
            `${tag}_callable${slot.ordinal}_place`,
            undefined,
            captureType(program.layout, field),
          ),
          `${tag}_callable${slot.ordinal}`,
        )
      }
      return
    }
    case 'NominalUnionCleanup': {
      if (
        plan.variants.every(
          (variant) => !variant.fields.some((field) => CleanupPlan.hasEffect(field.cleanup)),
        )
      )
        return
      const shape = Layout.callingShape(program.layout, plan.type)
      const tagValue = NativePayload.at(values, context, 0, `${tag}_tag`)
      if (shape?.tree._tag !== 'NominalUnionShape' || tagValue === undefined)
        throw new RangeError('LLVM nominal union cleanup lost its shape')
      for (const variant of plan.variants) {
        if (!variant.fields.some((field) => CleanupPlan.hasEffect(field.cleanup))) continue
        const matches = Emitter.integerCompare(
          body,
          'eq',
          tagValue,
          Emitter.integerSigned(builder, i32, BigInt(variant.ordinal)),
          `${tag}_v${variant.ordinal}_is`,
        )
        const selectedBlock = Emitter.block(body, `${tag}_v${variant.ordinal}_drop`)
        const followingBlock = Emitter.block(body, `${tag}_v${variant.ordinal}_next`)
        Emitter.conditionalBranch(body, matches, selectedBlock, followingBlock)
        Emitter.setInsertionPoint(body, selectedBlock)
        const identity = Match.nominalUnionVariant(
          plan.type,
          plan.type,
          variant.variant,
          variant.ordinal,
        )
        for (const [fieldOrdinal, field] of variant.fields.entries()) {
          if (!CleanupPlan.hasEffect(field.cleanup)) continue
          const physical = Layout.coverageFieldSlots(shape, identity, [field.field])
          const targetLanes = semanticLanesOf(field.cleanup.type)
          if (physical === undefined || physical.length !== targetLanes.length)
            throw new RangeError('LLVM nominal union cleanup lost a field payload lane')
          dropThroughPlan(
            context,
            field.cleanup,
            NativePayload.projectStored(
              values,
              context,
              field.cleanup.type,
              nominalFieldOffset(program.layout, plan.type, variant.ordinal, field.field),
              physical,
              `${tag}_v${variant.ordinal}_f${fieldOrdinal}_place`,
              { source: shape.lanes, target: targetLanes },
            ),
            `${tag}_v${variant.ordinal}_f${fieldOrdinal}`,
            undefined,
            childInitialization(
              childInitialization(initialization, { _tag: 'Variant', ordinal: variant.ordinal }),
              { _tag: 'Field', ordinal: field.field.ordinal },
            ),
          )
        }
        Emitter.branch(body, followingBlock)
        Emitter.setInsertionPoint(body, followingBlock)
        NativeStorage.reloadRoots(storage, `${tag}_v${variant.ordinal}_next`)
      }
      return
    }
    case 'EffectCleanup':
      for (const slot of plan.slots) {
        if (!CleanupPlan.hasEffect(slot.cleanup)) continue
        const source = NativePayload.storage(values, context)
        const field =
          source?.type._tag === 'EffectValue'
            ? source.type.environment.fields.find((field) => field.ordinal === slot.ordinal)
            : undefined
        const selected =
          field === undefined
            ? NativePayload.slice(values, slot.laneOffset, slot.laneOffset + slot.laneCount)
            : NativePayload.projectStored(
                values,
                context,
                field.type,
                field.offset,
                Array.from({ length: slot.laneCount }, (_, ordinal) => slot.laneOffset + ordinal),
                `${tag}_effect${slot.ordinal}_place`,
                undefined,
                captureType(program.layout, field),
              )
        if (selected.length !== slot.laneCount)
          throw new RangeError(
            `LLVM Effect cleanup ${tag} lost slot ${slot.ordinal} lanes ${slot.laneOffset}+${slot.laneCount} from ${values.length} value(s)`,
          )
        dropThroughPlan(context, slot.cleanup, selected, `${tag}_effect${slot.ordinal}`)
      }
      return
    case 'EffectCompositeCleanup': {
      const view = ValueStorage.find(program.layout, 'CompositeCarrier', plan.type)
      const shape = Layout.callingShape(program.layout, plan.type)
      if (view === undefined || shape === undefined)
        throw new RangeError('Composite cleanup lost its value-storage plan')
      const choice = NativePayload.at(values, context, 0, `${tag}_choice`)
      if (choice === undefined) throw new RangeError('LLVM Effect composite cleanup lost its tag')
      const following = Emitter.block(body, `${tag}_effect_composite_following`)
      for (const [ordinal, alternative] of plan.alternatives.entries()) {
        const selected = Emitter.block(body, `${tag}_effect_composite_${ordinal}`)
        const otherwise = Emitter.block(body, `${tag}_effect_composite_${ordinal}_otherwise`)
        Emitter.conditionalBranch(
          body,
          Emitter.integerCompare(
            body,
            'eq',
            choice,
            Emitter.integerSigned(builder, i32, BigInt(ordinal)),
            `${tag}_effect_composite_is_${ordinal}`,
          ),
          selected,
          otherwise,
        )
        Emitter.setInsertionPoint(body, selected)
        const member = view.members.find((member) => member.tag === ordinal)
        if (member === undefined)
          throw new RangeError('Composite cleanup lost its selected alternative')
        dropThroughPlan(
          context,
          alternative,
          NativePayload.project(
            values,
            member.lanes.map((mapping) => mapping.slot),
            { source: shape.lanes, target: member.lanes.map((mapping) => mapping.lane) },
          ),
          `${tag}_${ordinal}`,
        )
        Emitter.branch(body, following)
        Emitter.setInsertionPoint(body, otherwise)
      }
      Emitter.branch(body, following)
      Emitter.setInsertionPoint(body, following)
      NativeStorage.reloadRoots(storage, `${tag}_effect_composite_following`)
      return
    }
    case 'LocalSharedCoreCleanup': {
      const baseAddress = NativePayload.at(values, context, 0, `${tag}_base`)
      const elementLayout = Layout.entry(program.layout, plan.element)
      const block =
        localSharedBlock ??
        (elementLayout === undefined
          ? undefined
          : LocalSharedControlBlock.plan(program.layout.target, plan.element, elementLayout))
      if (
        baseAddress === undefined ||
        block?._tag !== 'LocalSharedControlBlockPlan' ||
        usizeType === undefined
      )
        throw new RangeError('LLVM local-shared cleanup lost its control-block plan')
      const wordType = usizeType
      const base = Emitter.cast(body, 'inttoptr', baseAddress, pointer, `${tag}_base`)
      const countPointer = NativeLanePointer.lanePointer(
        lanePointers,
        body,
        base,
        block.strongOffset,
        `${tag}_strong_ptr`,
      )
      const count = Emitter.load(body, wordType, countPointer, `${tag}_strong`)
      const nonLast = Emitter.integerCompare(
        body,
        'ugt',
        count,
        Emitter.integerUnsigned(builder, wordType, 1n),
        `${tag}_non_last`,
      )
      const decrement = Emitter.block(body, `${tag}_decrement`)
      const last = Emitter.block(body, `${tag}_last`)
      const following = Emitter.block(body, `${tag}_following`)
      Emitter.conditionalBranch(body, nonLast, decrement, last)
      Emitter.setInsertionPoint(body, decrement)
      Emitter.store(
        body,
        Emitter.binary(
          body,
          'sub',
          count,
          Emitter.integerUnsigned(builder, wordType, 1n),
          `${tag}_decremented`,
        ),
        countPointer,
      )
      Emitter.branch(body, following)
      Emitter.setInsertionPoint(body, last)
      const loadLanes = (type: SilkType.Type, byteOffset: number, laneTag: string) => {
        return NativePlace.loadLanes(
          NativePlace.stored(
            program.layout,
            type,
            NativeLanePointer.lanePointer(lanePointers, body, base, byteOffset, laneTag),
          ),
          context.storage,
          laneTag,
        )
      }
      const helper = FunctionIndex.nativeCandidates(
        declared,
        LocalSharedPayloadCleanup.declaration,
      ).find((candidate) =>
        Mir.matchesInstance(candidate.fn, LocalSharedPayloadCleanup.declaration, [plan.element]),
      )
      if (helper === undefined)
        throw new RangeError('LLVM local-shared cleanup lost its payload helper')
      NativeCall.callValues(
        call,
        helper,
        NativeArgument.fromValues(loadLanes(plan.element, block.valueOffset, `${tag}_value`)),
        `${tag}_value_cleanup`,
      )
      dropThroughPlan(
        context,
        plan.allocation,
        NativePayload.place(
          types,
          NativePlace.stored(
            program.layout,
            SilkType.allocation,
            NativeLanePointer.lanePointer(
              lanePointers,
              body,
              base,
              block.allocationOffset,
              `${tag}_allocation`,
            ),
          ),
        ),
        `${tag}_allocation`,
      )
      Emitter.branch(body, following)
      Emitter.setInsertionPoint(body, following)
      NativeStorage.reloadRoots(storage, `${tag}_following`)
      return
    }
    case 'AllocationCleanup':
    case 'RawBufferCleanup': {
      const reclaim = NativePayload.at(values, context, 4, `${tag}_reclaim`)
      if (free === undefined)
        throw new RangeError('LLVM allocation cleanup lost its reclaim context')
      Emitter.callDirect(body, free, [
        Emitter.cast(body, 'inttoptr', reclaim, pointer, `${tag}_context`),
      ])
      return
    }
    case 'HookCleanup': {
      const target = FunctionIndex.nativeCandidates(declared, plan.hook).find((candidate) =>
        Mir.matchesInstance(candidate.fn, plan.hook, plan.typeArguments),
      )
      if (target === undefined)
        throw new RangeError('LLVM cleanup cannot resolve its Drop hook instance')
      const layoutEntry = Layout.entry(program.layout, plan.type)
      if (layoutEntry === undefined)
        throw new RangeError(`LLVM hook cleanup lost the layout for ${SilkType.encode(plan.type)}`)
      let receiver = NativePayload.storage(values, context)
      if (receiver === undefined) {
        // A transport-only payload has no owning address until it enters this cleanup.
        const base = Emitter.alloca(body, i8, `${tag}_hook_storage`, {
          count: Emitter.integerUnsigned(builder, i32, BigInt(layoutEntry.size)),
          alignment: Emitter.alignment(body, layoutEntry.alignment),
        })
        receiver = NativePlace.stored(program.layout, plan.type, base)
        NativePlace.storeLanes(
          receiver,
          context.storage,
          NativePayload.materialize(values, context, `${tag}_source`),
          `${tag}_store`,
        )
      }
      const base = NativePlace.base(receiver, context.storage, `${tag}_receiver`)
      NativeResult.sourceValues(
        NativeResult.materialize(
          context.storage,
          NativeCall.callValues(call, target, NativeArgument.fromValues([base]), `${tag}_hook`),
          `${tag}_source_result`,
        ),
      )
      dropThroughPlan(
        context,
        plan.inner,
        NativePayload.place(
          types,
          NativePlace.make(program.layout, { _tag: 'Nominal', type: plan.type }, base),
        ),
        `${tag}_inner`,
      )
      return
    }
    case 'StructCleanup': {
      const lanes = semanticLanesOf(plan.type)
      for (const [fieldOrdinal, field] of plan.fields.entries()) {
        if (!CleanupPlan.hasEffect(field.cleanup)) continue
        const fieldSlots = lanes.flatMap((lane, index) => {
          const first = lane.path.at(0)
          return first !== undefined &&
            first._tag === 'FieldId' &&
            DeclarationFacts.sameFieldId(first, field.field)
            ? [index]
            : []
        })
        dropThroughPlan(
          context,
          field.cleanup,
          NativePayload.projectStored(
            values,
            context,
            field.cleanup.type,
            storedFieldOffset(program.layout, plan.type, field.field),
            fieldSlots,
            `${tag}_f${fieldOrdinal}_place`,
            undefined,
            concreteCleanupType(program.layout, field.cleanup),
          ),
          `${tag}_f${fieldOrdinal}`,
          undefined,
          childInitialization(initialization, { _tag: 'Field', ordinal: field.field.ordinal }),
        )
      }
      return
    }
    case 'ArrayCleanup': {
      if (!CleanupPlan.hasEffect(plan.element)) return
      const lanes = semanticLanesOf(plan.type)
      for (let index = 0; index < plan.length; index += 1) {
        const elementSlots = lanes.flatMap((lane, ordinal) => {
          const first = lane.path.at(0)
          return first !== undefined && first._tag === 'ElementSelector' && first.index === index
            ? [ordinal]
            : []
        })
        dropThroughPlan(
          context,
          plan.element,
          NativePayload.projectStored(
            values,
            context,
            plan.element.type,
            arrayElementOffset(program.layout, plan.type, index),
            elementSlots,
            `${tag}_e${index}_place`,
          ),
          `${tag}_e${index}`,
          undefined,
          childInitialization(initialization, { _tag: 'ConstantIndex', index }),
        )
      }
      return
    }
    case 'UnionCleanup': {
      if (plan.cases.every((entry) => !CleanupPlan.hasEffect(entry.cleanup))) return
      // Hook-bearing or structurally unsupported cases branch on the live tag and lower
      // the complete plan. Plain reclaim paths select a null context for inactive cases,
      // which libc free ignores.
      const shape = Layout.callingShape(program.layout, plan.type)
      const tagValue = NativePayload.at(values, context, 0, `${tag}_tag`)
      if (shape === undefined || tagValue === undefined) {
        throw new RangeError('LLVM union cleanup lost its shape')
      }
      for (const caseEntry of plan.cases) {
        const paths =
          initialization === undefined ? reclaimContextPaths(caseEntry.cleanup) : undefined
        if (paths === undefined) {
          const matches = Emitter.integerCompare(
            body,
            'eq',
            tagValue,
            Emitter.integerSigned(builder, i32, BigInt(caseEntry.ordinal)),
            `${tag}_u${caseEntry.ordinal}_is`,
          )
          const selectedBlock = Emitter.block(body, `${tag}_u${caseEntry.ordinal}_drop`)
          const followingBlock = Emitter.block(body, `${tag}_u${caseEntry.ordinal}_next`)
          Emitter.conditionalBranch(body, matches, selectedBlock, followingBlock)
          Emitter.setInsertionPoint(body, selectedBlock)
          const physical = Layout.memberFieldSlots(shape, caseEntry.member, [])
          const targetLanes = semanticLanesOf(caseEntry.member)
          if (physical === undefined || physical.length !== targetLanes.length) {
            throw new RangeError('LLVM union cleanup lost a member payload lane')
          }
          dropThroughPlan(
            context,
            caseEntry.cleanup,
            NativePayload.projectStored(
              values,
              context,
              caseEntry.member,
              unionPayloadOffset(program.layout, plan.type),
              physical,
              `${tag}_u${caseEntry.ordinal}_place`,
              { source: shape.lanes, target: targetLanes },
            ),
            `${tag}_u${caseEntry.ordinal}`,
            undefined,
            childInitialization(initialization, { _tag: 'Variant', ordinal: caseEntry.ordinal }),
          )
          Emitter.branch(body, followingBlock)
          Emitter.setInsertionPoint(body, followingBlock)
          // Only bounded direct locals need fresh SSA values at the join. Aggregate
          // reads resolve the current place after a hook's possible alias writes.
          NativeStorage.reloadRoots(storage, `${tag}_u${caseEntry.ordinal}_next`)
          continue
        }
        if (paths.length === 0) continue
        if (free === undefined || usizeType === undefined) {
          throw new RangeError('LLVM union reclaim cleanup lost its release helper')
        }
        const zero = Emitter.integerUnsigned(builder, usizeType, 0n)
        for (const [pathOrdinal, path] of paths.entries()) {
          const slots = Layout.memberFieldSlots(shape, caseEntry.member, path)
          const contextSlot = slots?.at(4)
          const reclaim =
            contextSlot === undefined
              ? undefined
              : NativePayload.at(values, context, contextSlot, `${tag}_reclaim${pathOrdinal}`)
          if (reclaim === undefined) {
            throw new RangeError('LLVM union cleanup lost a reclaim lane')
          }
          const matches = Emitter.integerCompare(
            body,
            'eq',
            tagValue,
            Emitter.integerSigned(builder, i32, BigInt(caseEntry.ordinal)),
            `${tag}_u${caseEntry.ordinal}_${pathOrdinal}_is`,
          )
          const guarded = Emitter.select(
            body,
            matches,
            reclaim,
            zero,
            `${tag}_u${caseEntry.ordinal}_${pathOrdinal}_context`,
          )
          Emitter.callDirect(body, free, [
            Emitter.cast(
              body,
              'inttoptr',
              guarded,
              pointer,
              `${tag}_u${caseEntry.ordinal}_${pathOrdinal}_pointer`,
            ),
          ])
        }
      }
      return
    }
  }
}
