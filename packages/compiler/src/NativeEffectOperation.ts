import * as Emitter from '@silklang/llvm/Emitter'
import * as NativePlace from './NativePlace.js'
import * as FunctionIndex from './internal/FunctionIndex.js'
import * as NativeResult from './NativeResult.js'
import * as NativePayload from './NativePayload.js'
import * as NativeArgument from './NativeArgument.js'
import * as ValueStorage from './ValueStorage.js'
import type * as Value from '@silklang/llvm/Value'
import * as CleanupPlan from './CleanupPlan.js'
import * as EffectExecutionContract from './internal/EffectExecutionContract.js'
import type * as Layout from './Layout.js'
import * as Mir from './Mir.js'
import type { LinearOperation } from './MirLinearization.js'
import * as NativeAggregate from './NativeAggregate.js'
import * as NativeArith from './NativeArith.js'
import * as NativeCall from './NativeCall.js'
import * as NativeDiagnosticOutcome from './NativeDiagnosticOutcome.js'
import * as NativeDiagnosticContext from './NativeDiagnosticContext.js'
import * as NativeDiagnosticText from './NativeDiagnosticText.js'
import * as NativeReturn from './NativeReturn.js'
import * as NativeOwnedPlace from './NativeOwnedPlace.js'
import type { Context } from './NativeOperationContext.js'
import * as NativeStorage from './NativeStorage.js'
import * as NativeLanePointer from './NativeLanePointer.js'
import * as NativeSuspension from './NativeSuspension.js'
import * as NativeTermination from './NativeTermination.js'
import * as NativeType from './NativeType.js'
import * as SilkType from './Type.js'

type Operation = Extract<
  LinearOperation,
  {
    readonly _tag:
      | 'Drop'
      | 'MakeEffect'
      | 'MakeCallable'
      | 'PackEffectComposite'
      | 'UnpackEffectComposite'
      | 'PackEffectOutcome'
      | 'PackEffectFailureUnion'
      | 'UnpackEffectSuccess'
      | 'RunEffect'
      | 'RunEffectComposite'
      | 'RunEffectValue'
      | 'RunStaticEffect'
      | 'CatchEffect'
      | 'DiagnosticUnhandled'
  }
>

/** Selects successful bytes without expanding the outcome's inactive alternatives. */
const successPayload = (context: Context, outcome: Mir.LocalId, result: Mir.Type, name: string) => {
  const source = context.storage.fn.localTypes.at(outcome.ordinal)
  if (source?._tag !== 'EffectOutcome') throw new RangeError('Effect success lost its outcome type')
  const stored = NativeStorage.readLocal(context.storage, outcome)
  if (
    stored._tag === 'NativePlace' &&
    ValueStorage.outcome(context.program.layout, source.type).members.find(
      (member) => member.tag === 0,
    )?.storage._tag === 'Value'
  )
    return NativePlace.project(
      stored,
      context.storage,
      result,
      ValueStorage.outcome(context.program.layout, source.type).payloadOffset,
      name,
    )
  const values = NativeStorage.materialize(context.storage, outcome)
  const sourceLanes = NativeType.lanesFor(context.types, source).slice(1)
  const payload: Array<Value.Input> = []
  for (const [ordinal, lane] of NativeType.lanesFor(context.types, result).entries()) {
    const value = values.at(ordinal + 1)
    const sourceLane = sourceLanes.at(ordinal)
    if (value === undefined || sourceLane === undefined)
      throw new RangeError('Effect success lost a payload lane')
    payload.push(
      NativeArith.coerceLane(context.arith.lane, value, sourceLane, lane, `${name}_${ordinal}`),
    )
  }
  return { _tag: 'Direct' as const, values: payload }
}

/** Materializes only the selected logical member at an outcome/capture boundary. */
const memberPayload = (context: Context, local: Mir.LocalId, tag: number, name: string) => {
  const type = context.storage.fn.localTypes.at(local.ordinal)
  if (type?._tag !== 'EffectOutcome' && type?._tag !== 'EffectComposite')
    throw new RangeError('Member conversion requires a planned outcome or composite')
  const member = ValueStorage.find(
    context.program.layout,
    type._tag === 'EffectOutcome' ? 'Outcome' : 'CompositeCarrier',
    type.type,
  )?.members.find((member) => member.tag === tag)
  if (member === undefined) throw new RangeError('Member conversion lost its storage binding')
  return NativePayload.materialize(
    NativePayload.project(
      NativePayload.local(context.storage, local),
      member.lanes.map((lane) => lane.slot),
      {
        source: NativeType.lanesFor(context.types, type),
        target: member.lanes.map((lane) => lane.lane),
      },
    ),
    context.cleanup,
    name,
  )
}

export const emit = (context: Context, operation: Operation) => {
  const {
    arith,
    body,
    builder,
    call,
    declared,
    cleanup,
    entry,
    failure,
    i32,
    storage: nativeStorage,
    suspension,
    suspensionRegions,
    types,
  } = context
  const checkOrdinal = context.state.checkOrdinal
  switch (operation._tag) {
    case 'DiagnosticUnhandled': {
      const lane = NativeType.lanesFor(types, operation.type).at(0)
      if (lane === undefined) throw new RangeError('Terminal observation lost its usize result')
      const diagnostic = call.synchronous.diagnostic
      const result =
        diagnostic === undefined
          ? Emitter.integerUnsigned(builder, NativeType.laneType(types, lane), 0n)
          : NativeDiagnosticContext.unhandled(diagnostic)
      NativeStorage.writeLocal(nativeStorage, operation.destination.ordinal, [result])
      break
    }
    case 'Drop': {
      if (CleanupPlan.hasEffect(operation.cleanup)) {
        let values = NativePayload.local(nativeStorage, operation.local)
        if (operation.selectors !== undefined && operation.selectors.length > 0) {
          const root = entry.fn.localTypes.at(operation.local.ordinal)
          const place =
            root === undefined
              ? undefined
              : NativeOwnedPlace.make(
                  cleanup.program.layout,
                  Mir.semanticType(root),
                  operation.selectors,
                )
          if (place === undefined)
            throw new RangeError('Owned place cleanup lost its verified projection')
          values = NativePayload.project(values, place.slots, {
            source: place.source.lanes,
            target: place.target.lanes,
          })
        }
        NativeAggregate.dropThroughPlan(
          cleanup,
          operation.cleanup,
          values,
          `drop${operation.local.ordinal}`,
          operation.localShared?.block,
          operation.initialization,
        )
      }
      break
    }
    case 'MakeEffect':
    case 'MakeCallable': {
      const fields =
        operation._tag === 'MakeEffect'
          ? operation.type.environment.fields
          : (operation.type.environment?.fields ?? [])
      if (operation._tag === 'MakeCallable' && operation.base !== undefined) {
        NativeStorage.constructField(nativeStorage, operation.destination, operation.base, 0)
      }
      // Callable captures name their field ordinal; a staged section's start past the base fields.
      const fieldOrdinals =
        operation._tag === 'MakeCallable'
          ? operation.captures.map((capture) => capture.ordinal)
          : operation.captures.map((_, ordinal) => ordinal)
      for (const [offset, capture] of operation.captures.entries()) {
        const field = fields.at(fieldOrdinals.at(offset) ?? -1)
        if (field === undefined) throw new RangeError('Effect capture lost its environment field')
        if (field.representation !== 'Borrow') {
          NativeStorage.constructField(
            nativeStorage,
            operation.destination,
            capture.source,
            field.offset,
          )
          continue
        }
        NativeStorage.ensureAddressRoot(nativeStorage, capture.source)
        const base = NativeStorage.addressOf(nativeStorage, capture.source)
        const destination = nativeStorage.addressStorage.get(operation.destination.ordinal)
        if (destination === undefined) throw new RangeError('Borrowed capture lost its destination')
        Emitter.store(
          body,
          base,
          NativeLanePointer.lanePointer(
            context.lanePointers,
            body,
            destination,
            field.offset,
            `capture${operation.destination.ordinal}_${offset}`,
          ),
        )
      }
      break
    }
    case 'UnpackEffectComposite': {
      const source = memberPayload(
        context,
        operation.source,
        operation.alternative,
        `effect_choice${operation.destination.ordinal}`,
      )
      const sourceType = entry.fn.localTypes.at(operation.source.ordinal)
      const tag = NativeStorage.readLane(nativeStorage, operation.source, 0)
      if (sourceType?._tag !== 'EffectComposite' || tag === undefined)
        throw new RangeError('LLVM Effect choice projection lost its representation')
      const values: Array<Value.Input> = []
      for (const [ordinal] of NativeType.lanesFor(types, operation.type).entries()) {
        const input = source.at(ordinal)
        if (input === undefined)
          throw new RangeError('LLVM Effect choice projection lost a capture lane')
        values.push(input)
      }
      NativeStorage.writeLocal(nativeStorage, operation.destination.ordinal, values)
      NativeStorage.writeLocal(nativeStorage, operation.matched.ordinal, [
        Emitter.cast(
          body,
          'zext',
          Emitter.integerCompare(
            body,
            'eq',
            tag,
            Emitter.integerSigned(builder, i32, BigInt(operation.alternative)),
            `effect_choice${operation.destination.ordinal}_matched`,
          ),
          i32,
          `effect_choice${operation.destination.ordinal}_flag`,
        ),
      ])
      break
    }
    case 'PackEffectComposite': {
      const source = NativeStorage.materialize(nativeStorage, operation.source)
      const sourceType = entry.fn.localTypes.at(operation.source.ordinal)
      if (sourceType?._tag !== 'EffectValue')
        throw new RangeError('LLVM Effect composite lost its selected alternative')
      const sourceLanes = NativeType.lanesFor(types, sourceType)
      const targetLanes = NativeType.lanesFor(types, operation.type)
      const values: Array<Value.Input> = [
        Emitter.integerSigned(builder, i32, BigInt(operation.alternative)),
      ]
      for (const [ordinal, targetLane] of targetLanes.slice(1).entries()) {
        const input = source.at(ordinal)
        const sourceLane = sourceLanes.at(ordinal)
        values.push(
          input === undefined || sourceLane === undefined
            ? Emitter.nullValue(builder, NativeType.laneType(types, targetLane))
            : NativeArith.coerceLane(
                arith.lane,
                input,
                sourceLane,
                targetLane,
                `effect_composite${operation.destination.ordinal}_${ordinal}`,
              ),
        )
      }
      NativeStorage.writeLocal(nativeStorage, operation.destination.ordinal, values)
      break
    }
    case 'PackEffectOutcome': {
      const sourceType = entry.fn.localTypes.at(operation.source.ordinal)
      if (sourceType === undefined) throw new RangeError('LLVM effect outcome lost its source type')
      const diagnostic = call.synchronous.diagnostic
      const diagnosticSlot = diagnostic?.outcomes.get(operation.destination.ordinal)
      if (diagnostic !== undefined && diagnosticSlot !== undefined) {
        if (operation.tag === 0) NativeDiagnosticOutcome.release(diagnosticSlot, diagnostic)
        else
          NativeDiagnosticOutcome.produce(
            diagnosticSlot,
            diagnostic,
            NativeDiagnosticText.literal(
              diagnostic,
              NativeTermination.identityOf(operation.type.type, operation.tag),
              `${entry.symbol}.failure${operation.destination.ordinal}.identity`,
            ),
            NativeDiagnosticText.literal(
              diagnostic,
              NativeDiagnosticText.origin(
                context.termination.module,
                entry.fn,
                operation.provenance.span,
              ),
              `${entry.symbol}.failure${operation.destination.ordinal}.origin`,
            ),
          )
      }
      if (
        ValueStorage.outcome(context.program.layout, operation.type.type).members.find(
          (member) => member.tag === operation.tag,
        )?.storage._tag === 'Transport'
      ) {
        const source = NativeStorage.materialize(nativeStorage, operation.source)
        const sourceLanes = NativeType.valueLanesFor(types, sourceType)
        const values: Array<Value.Input> = [
          Emitter.integerSigned(builder, i32, BigInt(operation.tag)),
        ]
        for (const [ordinal, lane] of NativeType.lanesFor(types, operation.type)
          .slice(1)
          .entries()) {
          const value = source.at(ordinal)
          const sourceLane = sourceLanes.at(ordinal)
          values.push(
            value === undefined || sourceLane === undefined
              ? Emitter.nullValue(builder, NativeType.laneType(types, lane))
              : NativeArith.coerceLane(
                  arith.lane,
                  value,
                  sourceLane,
                  lane,
                  `outcome_transport${operation.destination.ordinal}_${ordinal}`,
                ),
          )
        }
        NativeStorage.writeLocal(nativeStorage, operation.destination.ordinal, values)
        break
      }
      const destination = NativeStorage.readLocal(nativeStorage, operation.destination)
      if (destination._tag !== 'NativePlace')
        throw new RangeError('Effect outcome lost canonical storage')
      NativePlace.storeLane(
        destination,
        nativeStorage,
        0,
        Emitter.integerSigned(builder, i32, BigInt(operation.tag)),
        `effect_outcome${operation.destination.ordinal}_tag`,
      )
      const payload = NativePlace.project(
        destination,
        nativeStorage,
        sourceType,
        ValueStorage.outcome(context.program.layout, operation.type.type).payloadOffset,
        `effect_outcome${operation.destination.ordinal}_payload`,
      )
      const source = NativeStorage.readLocal(nativeStorage, operation.source)
      if (source._tag === 'NativePlace') NativePlace.transfer(payload, nativeStorage, source)
      else
        NativePlace.storeLanes(
          payload,
          nativeStorage,
          source._tag === 'Empty' ? [] : source.values,
          `effect_outcome${operation.destination.ordinal}_store`,
        )
      break
    }
    case 'PackEffectFailureUnion': {
      const source = NativeStorage.materialize(nativeStorage, operation.source)
      const sourceTag = source.at(0)
      if (sourceTag === undefined) throw new RangeError('Effect failure union lost its tag lane')
      let mappedTag: Value.Input = Emitter.integerSigned(builder, i32, -1n)
      const diagnostic = call.synchronous.diagnostic
      const diagnosticSlot = diagnostic?.outcomes.get(operation.destination.ordinal)
      let diagnosticIdentity: readonly [Value.Input, Value.Input] | undefined
      if (diagnostic !== undefined && diagnosticSlot !== undefined)
        diagnosticIdentity = [
          Emitter.nullValue(builder, diagnostic.pointer),
          Emitter.integerUnsigned(builder, diagnostic.word, 0n),
        ]
      for (const [ordinal, mapping] of operation.mappings.entries()) {
        const matches = Emitter.integerCompare(
          body,
          'eq',
          sourceTag,
          Emitter.integerSigned(builder, i32, BigInt(mapping.source)),
          `effect_failure_union${operation.destination.ordinal}_${ordinal}`,
        )
        if (diagnostic !== undefined && diagnosticIdentity !== undefined) {
          const identity = NativeDiagnosticText.literal(
            diagnostic,
            NativeTermination.identityOf(operation.type.type, mapping.target),
            `${entry.symbol}.failure${operation.destination.ordinal}.${ordinal}.identity`,
          )
          diagnosticIdentity = [
            Emitter.select(
              body,
              matches,
              identity[0],
              diagnosticIdentity[0],
              `failure_identity${ordinal}`,
            ),
            Emitter.select(
              body,
              matches,
              identity[1],
              diagnosticIdentity[1],
              `failure_identity_length${ordinal}`,
            ),
          ]
        }
        mappedTag = Emitter.select(
          body,
          matches,
          Emitter.integerSigned(builder, i32, BigInt(mapping.target)),
          mappedTag,
          `effect_failure_union${operation.destination.ordinal}_${ordinal}_tag`,
        )
      }
      if (
        diagnostic !== undefined &&
        diagnosticSlot !== undefined &&
        diagnosticIdentity !== undefined
      )
        NativeDiagnosticOutcome.produce(
          diagnosticSlot,
          diagnostic,
          diagnosticIdentity,
          NativeDiagnosticText.literal(
            diagnostic,
            NativeDiagnosticText.origin(
              context.termination.module,
              entry.fn,
              operation.provenance.span,
            ),
            `${entry.symbol}.failure${operation.destination.ordinal}.origin`,
          ),
        )
      const values: Array<Value.Input> = [
        mappedTag,
        ...NativeAggregate.failurePayload(
          failure,
          source,
          operation.sourceType.type,
          sourceTag,
          operation.type.type,
          operation.mappings,
          `effect_failure_union${operation.destination.ordinal}_payload`,
        ),
      ]
      NativeStorage.writeLocal(nativeStorage, operation.destination.ordinal, values)
      break
    }
    case 'UnpackEffectSuccess': {
      const sourceType = entry.fn.localTypes.at(operation.source.ordinal)
      if (sourceType?._tag === 'EffectOutcome') {
        const destinationType = entry.fn.localTypes.at(operation.destination.ordinal)
        if (destinationType === undefined)
          throw new RangeError('Effect unpack lost its destination type')
        NativeStorage.writeValue(
          nativeStorage,
          operation.destination,
          successPayload(
            context,
            operation.source,
            destinationType,
            `effect_unpack${operation.destination.ordinal}`,
          ),
        )
      } else
        NativeStorage.writeLocal(
          nativeStorage,
          operation.destination.ordinal,
          memberPayload(
            context,
            operation.source,
            0,
            `effect_unpack${operation.destination.ordinal}`,
          ),
        )
      break
    }
    case 'RunEffect': {
      const target = FunctionIndex.nativeCandidates(declared, operation.target).find((candidate) =>
        Mir.matchesEffectInstance(
          candidate.fn,
          operation.target,
          operation.typeArguments,
          operation.staticArguments,
          operation.outcomeType.type,
        ),
      )
      if (target === undefined)
        throw new RangeError('Backend cannot resolve propagated effect target')
      const runArguments = NativeArgument.fromLocals(nativeStorage, operation.arguments)
      if (
        NativeSuspension.emitOrigin(
          suspension,
          operation,
          runArguments,
          `effect_run${operation.destination.ordinal}`,
        )
      )
        break
      const suspensionRegion = suspensionRegions.get(operation)
      const outcomeValues = NativeSuspension.joinOutcome(
        suspension,
        operation,
        NativeCall.callValues(
          call,
          target,
          runArguments,
          `effect_run${operation.destination.ordinal}`,
          suspensionRegion?._tag === 'RunSuspendableEffectRegion' ? suspensionRegion : undefined,
        ),
        `effect_run${operation.destination.ordinal}`,
      )
      NativeStorage.writeValue(nativeStorage, operation.outcome, outcomeValues)
      const tag = NativeStorage.readLane(nativeStorage, operation.outcome, 0)
      if (tag === undefined) throw new RangeError('Effect outcome lost its tag')
      const zero = Emitter.integerSigned(builder, i32, 0n)
      const succeeded = Emitter.integerCompare(
        body,
        'eq',
        tag,
        zero,
        `effect_run_success${operation.destination.ordinal}`,
      )
      const successBlock = Emitter.block(body, `effect_run${operation.destination.ordinal}_success`)
      const failureBlock = Emitter.block(body, `effect_run${operation.destination.ordinal}_failure`)
      const followingBlock = Emitter.block(
        body,
        `effect_run${operation.destination.ordinal}_following`,
      )
      Emitter.conditionalBranch(body, succeeded, successBlock, failureBlock)
      Emitter.setInsertionPoint(body, successBlock)
      NativeStorage.writeValue(
        nativeStorage,
        operation.destination,
        successPayload(
          context,
          operation.outcome,
          operation.type,
          `effect_success${operation.destination.ordinal}`,
        ),
      )
      NativeStorage.commitLocal(nativeStorage, operation.destination)
      Emitter.branch(body, followingBlock)
      Emitter.setInsertionPoint(body, failureBlock)
      NativeTermination.storePropagated(
        context.termination,
        operation.outcome,
        operation.provenance.span,
      )
      let mappedTag: Value.Input = Emitter.integerSigned(builder, i32, -1n)
      for (const [ordinal, mapping] of operation.tagMappings.entries()) {
        const source = Emitter.integerSigned(builder, i32, BigInt(mapping.source))
        const matches = Emitter.integerCompare(
          body,
          'eq',
          tag,
          source,
          `effect_tag${operation.destination.ordinal}_${ordinal}`,
        )
        mappedTag = Emitter.select(
          body,
          matches,
          Emitter.integerSigned(builder, i32, BigInt(mapping.target)),
          mappedTag,
          `effect_mapped_tag${operation.destination.ordinal}_${ordinal}`,
        )
      }
      // Owners still live at this site release before the failure leaves the function
      // through their complete cleanup plans, matching the Drop lowering.
      for (const release of operation.releases ?? []) {
        if (!CleanupPlan.hasEffect(release.cleanup)) continue
        NativeAggregate.dropThroughPlan(
          cleanup,
          release.cleanup,
          NativePayload.local(nativeStorage, release.local),
          `propagation_release${release.local.ordinal}`,
          undefined,
          release.initialization,
        )
      }
      NativeReturn.propagateFailure(
        suspension.returns,
        nativeStorage,
        operation.outcome,
        tag,
        mappedTag,
        operation.tagMappings,
        'propagated_effect',
      )
      Emitter.setInsertionPoint(body, followingBlock)
      // Both arms of this outcome dispatch reach here, so neither arm's cached
      // values are readable in the join. Reloading re-roots them at this block.
      NativeStorage.reloadRoots(
        nativeStorage,
        `effect_run${operation.destination.ordinal}_following`,
        operation.destination,
      )
      NativeStorage.reloadLocal(
        nativeStorage,
        operation.destination,
        `effect_run${operation.destination.ordinal}`,
      )
      break
    }
    case 'RunEffectComposite': {
      const choice = NativeStorage.readLane(nativeStorage, operation.effect, 0)
      const compositeType = entry.fn.localTypes.at(operation.effect.ordinal)
      if (choice === undefined || compositeType?._tag !== 'EffectComposite')
        throw new RangeError('LLVM Effect composite lost its tag or representation')
      const joinedOutcomeLanes = NativeType.lanesFor(types, operation.outcomeType)
      const following = Emitter.block(
        body,
        `effect_composite${operation.destination.ordinal}_following`,
      )
      for (const [alternativeOrdinal, alternative] of operation.alternatives.entries()) {
        const selected = Emitter.block(
          body,
          `effect_composite${operation.destination.ordinal}_alternative${alternativeOrdinal}`,
        )
        const otherwise = Emitter.block(
          body,
          `effect_composite${operation.destination.ordinal}_otherwise${alternativeOrdinal}`,
        )
        const selectedTag = Emitter.integerSigned(builder, i32, BigInt(alternativeOrdinal))
        Emitter.conditionalBranch(
          body,
          Emitter.integerCompare(
            body,
            'eq',
            choice,
            selectedTag,
            `effect_composite${operation.destination.ordinal}_is${alternativeOrdinal}`,
          ),
          selected,
          otherwise,
        )
        Emitter.setInsertionPoint(body, selected)
        const target = FunctionIndex.nativeCandidates(declared, alternative.runner).find(
          (candidate) =>
            Mir.matchesEffectInstance(
              candidate.fn,
              alternative.runner,
              alternative.runnerTypeArguments,
              alternative.runnerStaticArguments,
              alternative.type.type,
            ),
        )
        if (target === undefined)
          throw new RangeError(
            `Backend cannot resolve Effect composite runner ${alternative.runner.module}.${alternative.runner.name}`,
          )
        const effectArguments = [
          ...memberPayload(
            context,
            operation.effect,
            alternativeOrdinal,
            `effect_composite${operation.destination.ordinal}_${alternativeOrdinal}`,
          ),
        ]
        effectArguments.push(
          ...NativeStorage.materializeArguments(nativeStorage, alternative.arguments).flat(),
        )
        const received = NativeCall.callValues(
          call,
          target,
          NativeArgument.fromValues(effectArguments),
          `effect_composite${operation.destination.ordinal}_${alternativeOrdinal}`,
        )
        const called = NativeResult.materialize(
          nativeStorage,
          received,
          `composite${operation.destination.ordinal}_received`,
        )
        const sourceOutcomeType: Extract<Mir.Type, { readonly _tag: 'EffectOutcome' }> = {
          _tag: 'EffectOutcome',
          type: alternative.type.type,
        }
        const sourceOutcomeLanes = NativeType.lanesFor(types, sourceOutcomeType)
        const sourceTag = called.values.at(0)
        if (sourceTag === undefined)
          throw new RangeError('LLVM Effect composite runner lost its outcome tag')
        let mappedTag: Value.Input = sourceTag
        for (const [mappingOrdinal, mapping] of alternative.tagMappings.entries()) {
          const matches = Emitter.integerCompare(
            body,
            'eq',
            sourceTag,
            Emitter.integerSigned(builder, i32, BigInt(mapping.source)),
            `effect_composite${operation.destination.ordinal}_${alternativeOrdinal}_tag${mappingOrdinal}`,
          )
          mappedTag = Emitter.select(
            body,
            matches,
            Emitter.integerSigned(builder, i32, BigInt(mapping.target)),
            mappedTag,
            `effect_composite${operation.destination.ordinal}_${alternativeOrdinal}_mapped${mappingOrdinal}`,
          )
        }
        const joined: Array<Value.Input> = [mappedTag]
        for (const [ordinal, targetLane] of joinedOutcomeLanes.slice(1).entries()) {
          const input = called.values.at(ordinal + 1)
          const sourceLane = sourceOutcomeLanes.at(ordinal + 1)
          joined.push(
            input === undefined || sourceLane === undefined
              ? Emitter.nullValue(builder, NativeType.laneType(types, targetLane))
              : NativeArith.coerceLane(
                  arith.lane,
                  input,
                  sourceLane,
                  targetLane,
                  `effect_composite${operation.destination.ordinal}_${alternativeOrdinal}_outcome${ordinal}`,
                ),
          )
        }
        NativeStorage.writeValue(
          nativeStorage,
          operation.outcome,
          NativeDiagnosticOutcome.accept(call.synchronous.diagnostic, operation.outcome, {
            ...called,
            values: joined,
          }),
        )
        NativeStorage.commitLocal(nativeStorage, operation.outcome)
        Emitter.branch(body, following)
        Emitter.setInsertionPoint(body, otherwise)
      }
      Emitter.branch(
        body,
        NativeTermination.trapBlock(
          context.termination,
          'invalid effect outcome tag',
          operation.provenance.span,
        ),
      )
      Emitter.setInsertionPoint(body, following)
      NativeStorage.reloadRoots(
        nativeStorage,
        `effect_composite${operation.destination.ordinal}_following`,
        operation.outcome,
      )
      if (operation.propagationType === undefined) {
        NativeStorage.writeValue(
          nativeStorage,
          operation.destination,
          successPayload(
            context,
            operation.outcome,
            operation.type,
            `effect_success${operation.destination.ordinal}`,
          ),
        )
        break
      }
      const tag = NativeStorage.readLane(nativeStorage, operation.outcome, 0)
      if (tag === undefined) throw new RangeError('Effect composite outcome lost its tag')
      const succeeded = Emitter.integerCompare(
        body,
        'eq',
        tag,
        Emitter.integerSigned(builder, i32, 0n),
        `effect_composite_success${operation.destination.ordinal}`,
      )
      const successBlock = Emitter.block(
        body,
        `effect_composite${operation.destination.ordinal}_success`,
      )
      const failureBlock = Emitter.block(
        body,
        `effect_composite${operation.destination.ordinal}_failure`,
      )
      const completed = Emitter.block(
        body,
        `effect_composite${operation.destination.ordinal}_completed`,
      )
      Emitter.conditionalBranch(body, succeeded, successBlock, failureBlock)
      Emitter.setInsertionPoint(body, successBlock)
      NativeStorage.writeValue(
        nativeStorage,
        operation.destination,
        successPayload(
          context,
          operation.outcome,
          operation.type,
          `effect_success${operation.destination.ordinal}`,
        ),
      )
      NativeStorage.commitLocal(nativeStorage, operation.destination)
      Emitter.branch(body, completed)
      Emitter.setInsertionPoint(body, failureBlock)
      NativeTermination.storePropagated(
        context.termination,
        operation.outcome,
        operation.provenance.span,
      )
      let propagatedTag: Value.Input = Emitter.integerSigned(builder, i32, -1n)
      for (const [ordinal, mapping] of operation.tagMappings.entries()) {
        const matches = Emitter.integerCompare(
          body,
          'eq',
          tag,
          Emitter.integerSigned(builder, i32, BigInt(mapping.source)),
          `effect_composite_propagation_tag${operation.destination.ordinal}_${ordinal}`,
        )
        propagatedTag = Emitter.select(
          body,
          matches,
          Emitter.integerSigned(builder, i32, BigInt(mapping.target)),
          propagatedTag,
          `effect_composite_propagated_tag${operation.destination.ordinal}_${ordinal}`,
        )
      }
      for (const release of operation.releases ?? []) {
        if (!CleanupPlan.hasEffect(release.cleanup)) continue
        NativeAggregate.dropThroughPlan(
          cleanup,
          release.cleanup,
          NativePayload.local(nativeStorage, release.local),
          `effect_composite_release${release.local.ordinal}`,
          undefined,
          release.initialization,
        )
      }
      NativeReturn.propagateFailure(
        suspension.returns,
        nativeStorage,
        operation.outcome,
        tag,
        propagatedTag,
        operation.tagMappings,
        'propagated_effect_composite',
      )
      Emitter.setInsertionPoint(body, completed)
      NativeStorage.reloadRoots(
        nativeStorage,
        `effect_composite${operation.destination.ordinal}_completed`,
        operation.destination,
      )
      NativeStorage.reloadLocal(
        nativeStorage,
        operation.destination,
        `effect_composite${operation.destination.ordinal}`,
      )
      break
    }
    case 'RunEffectValue':
    case 'RunStaticEffect': {
      const logicalInputs =
        operation._tag === 'RunStaticEffect'
          ? [...operation.captures.map((capture) => capture.source), ...operation.arguments]
          : undefined
      const target = FunctionIndex.nativeCandidates(declared, operation.runner).find(
        (candidate) =>
          Mir.matchesEffectInstance(
            candidate.fn,
            operation.runner,
            operation.runnerTypeArguments,
            operation.runnerStaticArguments,
            operation.outcomeType.type,
            operation._tag === 'RunEffectValue' ? operation.providers : undefined,
          ) &&
          (operation._tag !== 'RunStaticEffect' ||
            (logicalInputs !== undefined &&
              candidate.fn.result._tag === 'EffectOutcome' &&
              EffectExecutionContract.matches(
                candidate.fn.result.type,
                operation.outcomeType.type,
                candidate.fn.effectRunner?.providers ?? [],
              ) &&
              candidate.fn.parameterCount === logicalInputs.length &&
              logicalInputs.every((input, ordinal) => {
                const actual = entry.fn.localTypes.at(input.ordinal)
                const expected = candidate.fn.localTypes.at(ordinal)
                return (
                  actual !== undefined &&
                  expected !== undefined &&
                  Mir.executionArgumentCompatible(actual, expected)
                )
              }))),
      )
      if (target === undefined)
        throw new RangeError(
          `Backend cannot resolve Effect value runner ${operation.runner.module}.${operation.runner.name}<${operation.runnerTypeArguments.map(SilkType.encodeGenericArgument).join(', ')}>`,
        )
      const effectArguments =
        operation._tag === 'RunEffectValue'
          ? NativeArgument.captures(
              nativeStorage,
              target.argumentParameters,
              operation.effect,
              operation.arguments,
            )
          : NativeArgument.fromLocals(nativeStorage, [
              ...operation.captures.map((capture) => capture.source),
              ...operation.arguments,
            ])
      if (operation._tag !== 'RunStaticEffect') {
        if (
          NativeSuspension.emitOrigin(
            suspension,
            operation,
            effectArguments,
            `effect_value_run${operation.destination.ordinal}`,
          )
        )
          break
      }
      const suspensionRegion =
        operation._tag === 'RunStaticEffect' ? undefined : suspensionRegions.get(operation)
      const called = NativeCall.callValues(
        call,
        target,
        effectArguments,
        `effect_value_run${operation.destination.ordinal}`,
        suspensionRegion?._tag === 'RunSuspendableEffectRegion' ? suspensionRegion : undefined,
      )
      const outcomeValues =
        operation._tag === 'RunStaticEffect'
          ? NativeDiagnosticOutcome.accept(call.synchronous.diagnostic, operation.outcome, called)
          : NativeSuspension.joinOutcome(
              suspension,
              operation,
              called,
              `effect_value_run${operation.destination.ordinal}`,
            )
      NativeStorage.writeValue(nativeStorage, operation.outcome, outcomeValues)
      if (operation.propagationType === undefined) {
        NativeStorage.writeValue(
          nativeStorage,
          operation.destination,
          successPayload(
            context,
            operation.outcome,
            operation.type,
            `effect_success${operation.destination.ordinal}`,
          ),
        )
        break
      }
      const tag = NativeStorage.readLane(nativeStorage, operation.outcome, 0)
      if (tag === undefined) throw new RangeError('Effect outcome lost its tag')
      const zero = Emitter.integerSigned(builder, i32, 0n)
      const succeeded = Emitter.integerCompare(
        body,
        'eq',
        tag,
        zero,
        `effect_value_success${operation.destination.ordinal}`,
      )
      const successBlock = Emitter.block(
        body,
        `effect_value${operation.destination.ordinal}_success`,
      )
      const failureBlock = Emitter.block(
        body,
        `effect_value${operation.destination.ordinal}_failure`,
      )
      const followingBlock = Emitter.block(
        body,
        `effect_value${operation.destination.ordinal}_following`,
      )
      Emitter.conditionalBranch(body, succeeded, successBlock, failureBlock)
      Emitter.setInsertionPoint(body, successBlock)
      NativeStorage.writeValue(
        nativeStorage,
        operation.destination,
        successPayload(
          context,
          operation.outcome,
          operation.type,
          `effect_success${operation.destination.ordinal}`,
        ),
      )
      NativeStorage.commitLocal(nativeStorage, operation.destination)
      Emitter.branch(body, followingBlock)
      Emitter.setInsertionPoint(body, failureBlock)
      NativeTermination.storePropagated(
        context.termination,
        operation.outcome,
        operation.provenance.span,
      )
      let mappedTag: Value.Input = Emitter.integerSigned(builder, i32, -1n)
      for (const [ordinal, mapping] of operation.tagMappings.entries()) {
        const source = Emitter.integerSigned(builder, i32, BigInt(mapping.source))
        const matches = Emitter.integerCompare(
          body,
          'eq',
          tag,
          source,
          `effect_value_tag${operation.destination.ordinal}_${ordinal}`,
        )
        mappedTag = Emitter.select(
          body,
          matches,
          Emitter.integerSigned(builder, i32, BigInt(mapping.target)),
          mappedTag,
          `effect_value_mapped_tag${operation.destination.ordinal}_${ordinal}`,
        )
      }
      // Owners still live at this site release before the failure leaves the function
      // through their complete cleanup plans, matching the Drop lowering.
      for (const release of operation.releases ?? []) {
        if (!CleanupPlan.hasEffect(release.cleanup)) continue
        NativeAggregate.dropThroughPlan(
          cleanup,
          release.cleanup,
          NativePayload.local(nativeStorage, release.local),
          `propagation_release${release.local.ordinal}`,
          undefined,
          release.initialization,
        )
      }
      NativeReturn.propagateFailure(
        suspension.returns,
        nativeStorage,
        operation.outcome,
        tag,
        mappedTag,
        operation.tagMappings,
        'propagated_effect_value',
      )
      Emitter.setInsertionPoint(body, followingBlock)
      // Both arms of this outcome dispatch reach here, so neither arm's cached
      // values are readable in the join. Reloading re-roots them at this block.
      NativeStorage.reloadRoots(
        nativeStorage,
        `effect_value${operation.destination.ordinal}_following`,
        operation.destination,
      )
      NativeStorage.reloadLocal(
        nativeStorage,
        operation.destination,
        `effect_value${operation.destination.ordinal}`,
      )
      break
    }
    case 'CatchEffect': {
      const target = FunctionIndex.nativeCandidates(declared, operation.runner).find((candidate) =>
        Mir.matchesEffectInstance(
          candidate.fn,
          operation.runner,
          operation.runnerTypeArguments,
          operation.runnerStaticArguments,
          operation.outcomeType.type,
        ),
      )
      if (target === undefined) throw new RangeError('Backend cannot resolve Effect result runner')
      const reifyArguments = NativeArgument.captures(
        nativeStorage,
        target.argumentParameters,
        operation.effect,
        operation.arguments,
      )
      if (
        NativeSuspension.emitOrigin(
          suspension,
          operation,
          reifyArguments,
          `effect_result_run${operation.destination.ordinal}`,
        )
      )
        break
      const suspensionRegion = suspensionRegions.get(operation)
      const outcomeValues = NativeSuspension.joinOutcome(
        suspension,
        operation,
        NativeCall.callValues(
          call,
          target,
          reifyArguments,
          `effect_result_run${operation.destination.ordinal}`,
          suspensionRegion?._tag === 'RunSuspendableEffectRegion' ? suspensionRegion : undefined,
        ),
        `effect_result_run${operation.destination.ordinal}`,
      )
      NativeStorage.writeValue(nativeStorage, operation.outcome, outcomeValues)
      const tag = NativeStorage.readLane(nativeStorage, operation.outcome, 0)
      if (tag === undefined) throw new RangeError('Effect result lost its outcome tag')
      const zero = Emitter.integerSigned(builder, i32, 0n)
      const succeeded = Emitter.integerCompare(
        body,
        'eq',
        tag,
        zero,
        `effect_result_success${operation.destination.ordinal}`,
      )
      NativeStorage.writeLocal(nativeStorage, operation.destination.ordinal, [
        Emitter.cast(
          body,
          'zext',
          succeeded,
          i32,
          `effect_result_success_flag${operation.destination.ordinal}`,
        ),
      ])
      const outcomeLanesValues = NativeStorage.materialize(nativeStorage, operation.outcome)
      const outcomeLanes = operation.outcomeShape.lanes
      const successLaneCount =
        operation.outcomeShape.tree._tag === 'OutcomeShape'
          ? operation.outcomeShape.tree.success.laneCount
          : 0
      const coerce = (
        values: ReadonlyArray<Value.Input>,
        sourceLanes: ReadonlyArray<Layout.CallingLane>,
        targetLanes: ReadonlyArray<Layout.CallingLane>,
        label: string,
      ) => {
        const coerced: Array<Value.Input> = []
        for (const [ordinal, targetLane] of targetLanes.entries()) {
          const input = values.at(ordinal)
          const sourceLane = sourceLanes.at(ordinal)
          coerced.push(
            input === undefined || sourceLane === undefined
              ? Emitter.nullValue(builder, NativeType.laneType(types, targetLane))
              : NativeArith.coerceLane(
                  arith.lane,
                  input,
                  sourceLane,
                  targetLane,
                  `${label}_${ordinal}`,
                ),
          )
        }
        return coerced
      }
      const successValues = coerce(
        outcomeLanesValues.slice(1, 1 + successLaneCount),
        outcomeLanes.slice(1, 1 + successLaneCount),
        operation.successShape.lanes,
        `effect_result${operation.destination.ordinal}_success`,
      )
      NativeStorage.writeLocal(nativeStorage, operation.successValue.ordinal, successValues)
      NativeStorage.storeMutable(nativeStorage, operation.successValue, successValues)
      const failureValues: Array<Value.Input> = []
      const failureLanes: Array<Layout.CallingLane> = []
      if (SilkType.isUnion(operation.failureValueType)) {
        failureValues.push(
          Emitter.binary(
            body,
            'sub',
            tag,
            Emitter.integerSigned(builder, i32, 1n),
            `effect_result${operation.destination.ordinal}_failure_tag`,
          ),
        )
        const failureTagLane = operation.failureValueShape.lanes.at(0)
        if (failureTagLane === undefined)
          throw new RangeError('Effect result lost its failure-union tag lane')
        failureLanes.push(failureTagLane)
      }
      failureValues.push(...outcomeLanesValues.slice(1))
      failureLanes.push(...outcomeLanes.slice(1))
      const coercedFailureValues = coerce(
        failureValues,
        failureLanes,
        operation.failureValueShape.lanes,
        `effect_result${operation.destination.ordinal}_failure`,
      )
      NativeStorage.writeLocal(nativeStorage, operation.failureValue.ordinal, coercedFailureValues)
      NativeStorage.storeMutable(nativeStorage, operation.failureValue, coercedFailureValues)
      break
    }
  }
  context.state.checkOrdinal = checkOrdinal
}
