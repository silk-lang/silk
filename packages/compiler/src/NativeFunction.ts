import * as Emitter from '@silklang/llvm/Emitter'
import * as NativeDiagnosticOutcome from './NativeDiagnosticOutcome.js'
import * as NativeExecutionStorage from './NativeExecutionStorage.js'
import * as NativeAssemblyOperation from './NativeAssemblyOperation.js'
import * as LlvmBlock from '@silklang/llvm/Block'
import type * as Builder from '@silklang/llvm/Builder'
import * as Constant from '@silklang/llvm/Constant'
import * as DISPFlags from '@silklang/llvm/DISPFlags'
import * as FunctionActor from '@silklang/llvm/Function'
import * as LlvmMetadata from '@silklang/llvm/Metadata'
import type * as LlvmType from '@silklang/llvm/Type'
import * as Value from '@silklang/llvm/Value'
import * as Effect from 'effect/Effect'
import type * as Backend from './Backend.js'
import { type lineTable, positionOf, suspensionPointKey } from './Backend.js'
import * as Instances from './Instances.js'
import * as Layout from './Layout.js'
import * as NativeFrame from './NativeFrame.js'
import * as Mir from './Mir.js'
import { destinationOf, type LinearBlock, opensRuntimeContinuation } from './MirLinearization.js'
import * as MirVerification from './MirVerification.js'
import type * as NativeAggregate from './NativeAggregate.js'
import type * as NativeArith from './NativeArith.js'
import type * as NativeCall from './NativeCall.js'
import * as NativeControl from './NativeControl.js'
import * as NativeDebug from './NativeDebug.js'
import type * as NativeForeignOperation from './NativeForeignOperation.js'
import type * as NativeHostFailure from './NativeHostFailure.js'
import * as NativeLanePointer from './NativeLanePointer.js'
import type * as NativeLoweringContext from './NativeLoweringContext.js'
import * as NativeOperation from './NativeOperation.js'
import type * as NativeOperationContext from './NativeOperationContext.js'
import * as NativeStorage from './NativeStorage.js'
import * as NativePlace from './NativePlace.js'
import * as NativeReturn from './NativeReturn.js'
import type * as NativeSuspension from './NativeSuspension.js'
import * as NativeTermination from './NativeTermination.js'
import * as NativeType from './NativeType.js'
import * as NativeValue from './NativeValue.js'
import * as ValueStorage from './ValueStorage.js'
import * as NativeDiagnosticContext from './NativeDiagnosticContext.js'
import * as NativeDiagnosticScope from './NativeDiagnosticScope.js'
import * as NativeOutcomeStorage from './NativeOutcomeStorage.js'

export interface MutableRoots {
  readonly mutable: ReadonlySet<number>
  readonly address: ReadonlySet<number>
}

/** Finds locals that need stable stack storage across mutation, calls, and suspension control. */
export const discoverRoots = (
  fn: Mir.MirFunction,
  blocks: ReadonlyArray<LinearBlock>,
): MutableRoots => {
  const assignments = new Map<number, number>()
  for (const operation of blocks.flatMap((block) => block.operations)) {
    const destination = destinationOf(operation)
    if (destination !== undefined)
      assignments.set(destination.ordinal, (assignments.get(destination.ordinal) ?? 0) + 1)
  }
  const continuationLocals = blocks.flatMap((block) => {
    if (
      block.terminator._tag === 'Return' ||
      block.terminator._tag === 'Trap' ||
      block.terminator._tag === 'PropagateEffectFailure'
    )
      return []
    let afterRuntimeContinuation = false
    const ordinals: Array<number> = []
    for (const operation of block.operations) {
      if (opensRuntimeContinuation(operation)) afterRuntimeContinuation = true
      if (!afterRuntimeContinuation) continue
      const destination = destinationOf(operation)
      if (destination !== undefined) ordinals.push(destination.ordinal)
    }
    return ordinals
  })
  const runtimeContinuationDestinations = blocks.flatMap((block) =>
    block.operations.flatMap((operation) => {
      if (!opensRuntimeContinuation(operation) || operation._tag === 'Binary') return []
      if (operation._tag === 'CatchEffect')
        return [
          operation.destination.ordinal,
          operation.successValue.ordinal,
          operation.failureValue.ordinal,
        ]
      const destination = destinationOf(operation)
      return destination === undefined ? [] : [destination.ordinal]
    }),
  )
  const borrowedCaptureRoots = new Set(
    blocks.flatMap((block) =>
      block.operations.flatMap((operation) =>
        operation._tag === 'MakeEffect' || operation._tag === 'MakeCallable'
          ? operation.captures.flatMap((capture, ordinal) =>
              (
                operation._tag === 'MakeEffect'
                  ? operation.type.environment.fields.at(ordinal)?.representation === 'Borrow'
                  : capture.access === 'Shared' || capture.access === 'Exclusive'
              )
                ? [capture.source.ordinal]
                : [],
            )
          : [],
      ),
    ),
  )
  const mutable = new Set([
    ...blocks.flatMap((block) =>
      block.operations.flatMap((operation) =>
        operation._tag === 'SetInitialized' ? [operation.flag.ordinal] : [],
      ),
    ),
    ...blocks.flatMap((block) =>
      block.operations.flatMap((operation) =>
        operation._tag === 'WritePlace' &&
        (fn.localTypes.at(operation.root.ordinal)?._tag !== 'Slice' ||
          operation.selectors.length === 0)
          ? [operation.root.ordinal]
          : [],
      ),
    ),
    ...blocks.flatMap((block) =>
      block.operations.flatMap((operation) =>
        operation._tag === 'BindMatch' ? [operation.destination.ordinal] : [],
      ),
    ),
    ...[...assignments].flatMap(([ordinal, count]) => (count > 1 ? [ordinal] : [])),
    ...continuationLocals,
    ...runtimeContinuationDestinations,
    ...blocks.flatMap((block) =>
      block.operations.flatMap((operation) =>
        operation._tag === 'RunEffectComposite'
          ? [operation.outcome.ordinal, operation.destination.ordinal]
          : [],
      ),
    ),
    ...(fn.suspension?.regions ?? []).flatMap((region) =>
      region._tag === 'RunSuspendableEffectRegion' && region.relay.state !== undefined
        ? [
            region.operation.destination.ordinal,
            ...(region.operation._tag === 'ExecutionPark'
              ? []
              : [region.operation.outcome.ordinal]),
            ...region.relay.state.slots.map((slot) => slot.local.ordinal),
          ]
        : [],
    ),
    ...borrowedCaptureRoots,
  ])
  const address = new Set([
    ...blocks.flatMap((block) =>
      block.operations.flatMap((operation) =>
        operation._tag === 'BindMatch' &&
        operation.type._tag === 'EnvironmentBorrow' &&
        fn.localTypes.at(operation.scrutinee.ordinal)?._tag !== 'Reference'
          ? [operation.scrutinee.ordinal]
          : [],
      ),
    ),
    ...blocks.flatMap((block) =>
      block.operations.flatMap((operation) =>
        operation._tag === 'EnterDiagnosticScope'
          ? [operation.state.ordinal, operation.observer.ordinal]
          : [],
      ),
    ),
    ...blocks.flatMap((block) =>
      block.operations.flatMap((operation) =>
        operation._tag === 'BeginLoan' &&
        (Mir.borrowsDescriptor(operation) ||
          (operation.sourceType._tag !== 'Slice' &&
            fn.localTypes.at(operation.root.ordinal)?._tag !== 'Reference'))
          ? [operation.root.ordinal]
          : [],
      ),
    ),
    ...borrowedCaptureRoots,
  ])
  for (const root of address) mutable.add(root)
  return { mutable, address }
}

/**
 * Reference intervals within a linear block, including lowering-only cleanup inputs.
 * Inputs are active from block entry; a root first mentioned only as a destination starts
 * at that definition instead. A destination also appearing as an operand is an input.
 * All roots stay active through their last reference, including destination writes:
 * an operation's internal joins may read back its result. This is conservative local
 * interval tracking, not SSA liveness or dead-store elimination. Later blocks reload
 * their own inputs from canonical storage. Keeping the whole block's set at every join left
 * 320,044 unused root loads in the self-hosted CLI after storage sharing was introduced.
 * Bucketing by operation makes activation/retirement linear in references, not
 * roots × operations. Suspension payload roots are pinned separately by the emitter.
 */
const blockLocalReferences = (block: LinearBlock) => {
  const locals = new Map<number, number>()
  const firstDefinitions = new Map<number, number>()
  let position = 0
  let destination: number | undefined
  const add = (values: ReadonlyArray<Mir.LocalId>): void => {
    for (const value of values) {
      const root = value.ordinal
      if (!locals.has(root) && root === destination) firstDefinitions.set(root, position)
      // A second occurrence in the defining operation is an input, including an
      // in-place assignment or a lowering-only cleanup/selector dependency.
      else if (firstDefinitions.get(root) === position) firstDefinitions.delete(root)
      locals.set(root, position)
    }
  }
  const selectors = (values: ReadonlyArray<Mir.PlaceSelector>): void => {
    for (const selector of values) {
      if (selector._tag === 'ElementSelector' && selector.index._tag === 'Runtime')
        add([selector.index.local])
      if (selector._tag === 'SliceElementSelector') add([selector.index])
    }
  }
  const releases = (values: ReadonlyArray<Mir.CoroutineFrameRelease>): void => {
    for (const release of values) {
      add([release.local])
      add(release.initialization?.flags.map((flag) => flag.local) ?? [])
    }
  }
  for (const [ordinal, operation] of block.operations.entries()) {
    position = ordinal
    destination = destinationOf(operation)?.ordinal
    if (operation._tag === 'BindMatch') {
      add([operation.scrutinee, operation.destination])
      selectors(operation.selectors ?? [])
    } else if (operation._tag === 'CheckedScalarOutcome') {
      add([operation.valid, operation.value, ...operation.operands])
    } else if (operation._tag === 'EnterDiagnosticScope') {
      add([operation.state, operation.observer])
    } else if (operation._tag === 'LeaveDiagnosticScope') {
      // The scope ID selects a preallocated descriptor; it is not a cached SSA value.
      continue
    } else if (operation._tag === 'ReleaseDiagnosticOutcome') {
      add([operation.outcome])
    } else {
      add(MirVerification.operationLocals(operation))
    }
    if ('releases' in operation) releases(operation.releases ?? [])
  }
  position = block.operations.length
  destination = undefined
  const terminator = block.terminator
  switch (terminator._tag) {
    case 'Return':
      add([terminator.value])
      break
    case 'Branch':
      add([terminator.condition])
      break
    case 'MatchBranch':
    case 'EnumMatchBranch':
      add([terminator.scrutinee])
      selectors(terminator.selectors ?? [])
      break
    case 'PropagateEffectFailure':
      add([terminator.source])
      releases(terminator.releases ?? [])
      break
    case 'Jump':
    case 'Trap':
      break
  }
  const initial = new Set<number>()
  const starting = new Map<number, Array<number>>()
  const ending = new Map<number, Array<number>>()
  const bucket = (target: Map<number, Array<number>>, at: number, root: number): void => {
    const found = target.get(at)
    if (found === undefined) target.set(at, [root])
    else found.push(root)
  }
  for (const [root, last] of locals) {
    const definition = firstDefinitions.get(root)
    if (definition === undefined) initial.add(root)
    else bucket(starting, definition, root)
    bucket(ending, last, root)
  }
  return { initial, starting, ending }
}

export interface ResumeThunk {
  readonly handle: FunctionActor.Function
  readonly region: Mir.RunSuspendableEffectRegion
  readonly owner: NativeLoweringContext.DeclaredFunction
  readonly frame: Mir.CoroutineFrameTargetLayout
  readonly layout: Mir.CoroutineFrameTargetStateLayout
}

export interface EmissionContext {
  readonly runtimeFeatures: Set<Backend.RuntimeFeature>
  readonly builder: Builder.Builder
  readonly program: Mir.Module
  readonly request: Backend.CodegenRequest
  readonly i8: LlvmType.Type
  readonly i32: LlvmType.Type
  readonly f32: LlvmType.Type
  readonly f64: LlvmType.Type
  readonly pointer: LlvmType.Type
  readonly usizeType?: LlvmType.Type
  readonly integerTypes: Map<number, LlvmType.Type>
  readonly lanePointers: NativeLanePointer.Context
  readonly staticPointers: ReadonlyMap<string, Constant.Constant>
  readonly lanesFor: (type: Mir.Type) => ReadonlyArray<Layout.CallingLane>
  readonly valueLanesFor: (type: Mir.Type) => ReadonlyArray<Layout.CallingLane>
  readonly laneType: (lane: Layout.CallingLane) => LlvmType.Type
  readonly transferHeaderSize: number
  readonly transferResultOffset: number
  readonly transferStorageSize: number
  readonly childThunkType?: LlvmType.Type
  readonly resumeThunkType?: LlvmType.Type
  readonly signedOverflowSignatures: Map<
    number,
    { readonly returnType: LlvmType.Type; readonly parameters: ReadonlyArray<LlvmType.Type> }
  >
  readonly unsignedOverflowSignatures: Map<
    number,
    { readonly returnType: LlvmType.Type; readonly parameters: ReadonlyArray<LlvmType.Type> }
  >
  readonly malloc?: FunctionActor.Function
  readonly free?: FunctionActor.Function
  readonly executionStorage?: NativeExecutionStorage.NativeExecutionStorage
  readonly executionRelease?: FunctionActor.Function
  readonly memcmp?: FunctionActor.Function
  readonly foreignIndirects: ReadonlyMap<string, NativeForeignOperation.Declaration>
  readonly foreignFunctions: ReadonlyMap<string, NativeForeignOperation.Declaration>
  readonly foreignStatics: ReadonlyMap<string, NativeForeignOperation.StaticDeclaration>
  readonly foreignCallbacks: ReadonlyMap<string, Constant.Constant>
  readonly declared: ReadonlyArray<NativeLoweringContext.DeclaredFunction>
  readonly originThunks: ReadonlyMap<
    string,
    {
      readonly handle: FunctionActor.Function
      readonly region: Mir.SuspendEffectRegion
      readonly owner: NativeLoweringContext.DeclaredFunction
    }
  >
  readonly resumeThunks: ReadonlyMap<string, ResumeThunk>
  readonly debug: boolean
  readonly compileUnit: LlvmMetadata.Optional
  readonly file: LlvmMetadata.Optional
  readonly table: ReturnType<typeof lineTable>
  readonly debugContext: NativeDebug.LoweringContext
  readonly termination: NativeTermination.ModuleContext
}

/** Emits every declared native function body from explicit program lowering state. */
export const emitBodies = Effect.fn('NativeFunction.emitBodies')(function* (
  context: EmissionContext,
) {
  const {
    runtimeFeatures,
    builder,
    program,
    request,
    i8,
    i32,
    f32,
    f64,
    pointer,
    usizeType,
    integerTypes,
    lanePointers,
    staticPointers,
    lanesFor,
    valueLanesFor,
    laneType,
    transferHeaderSize,
    transferResultOffset,
    transferStorageSize,
    childThunkType,
    resumeThunkType,
    signedOverflowSignatures,
    unsignedOverflowSignatures,
    malloc,
    free,
    executionStorage,
    executionRelease,
    memcmp,
    foreignIndirects,
    foreignFunctions,
    foreignStatics,
    foreignCallbacks,
    declared,
    originThunks,
    resumeThunks,
    debug,
    compileUnit,
    file,
    table,
    debugContext,
    termination,
  } = context
  // The per-function prologue used to rescan every resume thunk and coroutine frame, which grew
  // quadratically with the number of emitted functions; group both collections once.
  const resumesByOwner = new Map<NativeLoweringContext.DeclaredFunction, Array<ResumeThunk>>()
  for (const resume of resumeThunks.values()) {
    const owned = resumesByOwner.get(resume.owner)
    if (owned === undefined) resumesByOwner.set(resume.owner, [resume])
    else owned.push(resume)
  }
  const coroutineFrames = new Map<string, Mir.CoroutineFrameTargetLayout>()
  for (const frame of program.coroutineFrames?.entries ?? []) {
    const key = Instances.keyText(frame.function)
    if (!coroutineFrames.has(key)) coroutineFrames.set(key, frame)
  }
  for (const entry of declared) {
    yield* Effect.gen(function* () {
      yield* Effect.annotateCurrentSpan({
        'entry.symbol': entry.symbol,
      })
      let subprogram: LlvmMetadata.Optional
      if (debug && file !== undefined && compileUnit !== undefined) {
        const startLine = positionOf(table, NativeDebug.functionStart(entry.fn)).line
        const symbolName = yield* LlvmMetadata.string(builder, entry.symbol)
        const signatureTypes = yield* LlvmMetadata.tuple(builder, [
          yield* NativeDebug.typeOf(debugContext, entry.fn.result),
          ...(yield* Effect.forEach(entry.fn.localTypes.slice(0, entry.fn.parameterCount), (type) =>
            NativeDebug.typeOf(debugContext, type),
          )),
        ])
        const signature = yield* LlvmMetadata.subroutineType(builder, signatureTypes)
        subprogram = yield* LlvmMetadata.subprogram(builder, file, symbolName, {
          line: startLine,
          scopeLine: startLine,
          type: signature,
          spFlags: DISPFlags.make({ definition: true }),
          compileUnit,
        })
        if (subprogram !== undefined) {
          yield* FunctionActor.setSubprogram(builder, entry.handle, subprogram)
        }
      }
      const scope = subprogram

      // Each body is emitted as synchronous Emitter code: one Effect per LLVM operation made the
      // fiber run loop and generator allocation the largest emission cost (self-hosted build).
      yield* Emitter.module(builder, (builder) =>
        Emitter.buildBody(builder, entry.handle, (body) => {
          if (entry.fn.machine !== undefined)
            return NativeAssemblyOperation.emitNaked(builder, body, entry.fn, program.layout.target)
          const suspensionRegions = new Map(
            (entry.fn.suspension?.regions ?? []).map(
              (region) => [region.operation, region] as const,
            ),
          )
          const resumeControls = (resumesByOwner.get(entry) ?? [])
            .sort((left, right) =>
              suspensionPointKey(left.region.point).localeCompare(
                suspensionPointKey(right.region.point),
              ),
            )
            .map((resume, ordinal) => ({ ...resume, ordinal: ordinal + 1 }))
          const coroutineFrame = coroutineFrames.get(Instances.keyText(entry.fn.instance))
          Emitter.block(body, 'entry')
          const dispatchBlock = entry.suspendable
            ? Emitter.block(body, 'suspend_dispatch')
            : undefined
          const frameReuseBlock =
            entry.suspendable && coroutineFrame !== undefined
              ? Emitter.block(body, 'suspend_invocation_frame_reuse')
              : undefined
          const frameAllocateBlock =
            entry.suspendable && coroutineFrame !== undefined
              ? Emitter.block(body, 'suspend_invocation_frame_push')
              : undefined
          const frameAcquiredBlock =
            entry.suspendable && coroutineFrame !== undefined
              ? Emitter.block(body, 'suspend_invocation_frame_acquired')
              : undefined
          const frameTrapBlock =
            entry.suspendable && coroutineFrame !== undefined
              ? Emitter.block(body, 'suspend_invocation_frame_trap')
              : undefined
          const framePushedBlock =
            entry.suspendable && coroutineFrame !== undefined
              ? Emitter.block(body, 'suspend_invocation_frame_pushed')
              : undefined
          const blocks = new Map<number, LlvmBlock.Block>()
          for (const block of entry.linear) {
            blocks.set(
              block.id.ordinal,
              Emitter.block(
                body,
                `bb${block.id.ordinal}${block.kind === 'Cleanup' ? '_cleanup' : ''}`,
              ),
            )
          }
          const resumeBlocks = new Map(
            Array.from(
              resumeControls,
              (resume) =>
                [
                  suspensionPointKey(resume.region.point),
                  Emitter.block(body, `suspend_resume_${resume.ordinal}`),
                ] as const,
            ),
          )
          const invocationFrameStorage =
            entry.suspendable && coroutineFrame !== undefined
              ? Emitter.alloca(body, pointer, 'suspend_invocation_frame_slot')
              : undefined
          const operationState: NativeOperation.State = { trapBlocks: [], checkOrdinal: 0 }
          const diagnostic =
            entry.diagnosticParameter === undefined
              ? undefined
              : NativeDiagnosticContext.make(
                  builder,
                  body,
                  pointer,
                  i8,
                  integerTypes.get(program.layout.target.pointerSize * 8) ?? i32,
                  Emitter.argument(body, entry.diagnosticParameter),
                  Emitter.argument(body, entry.diagnosticParameter + 1),
                )
          // A transfer-only runner can use the suspension ABI without retaining a
          // resumable frame. Its outcome slots belong to this native invocation;
          // child results escape through the separate transfer result record.
          if (diagnostic !== undefined && invocationFrameStorage === undefined) {
            for (const outcome of Mir.diagnosticOutcomeLocals(program, entry.fn)) {
              const slot = {
                storage: Emitter.alloca(
                  body,
                  diagnostic.causeType,
                  `diagnostic_outcome${outcome.ordinal}`,
                ),
              }
              NativeDiagnosticOutcome.initialize(slot, diagnostic)
              diagnostic.outcomes.set(outcome.ordinal, slot)
            }
          }
          const terminationContext: NativeTermination.FunctionContext = {
            module: termination,
            body,
            fn: entry.fn,
            state: operationState,
            ...(diagnostic === undefined ? {} : { diagnostic }),
          }
          const locals = new Map<number, NativeValue.NativeValue>()
          const roots = discoverRoots(entry.fn, entry.linear)
          const mutableRoots = roots.mutable
          const addressRoots = roots.address
          const mutableStorage = new Map<number, ReadonlyArray<Value.Input>>()
          for (const root of [...mutableRoots].sort((left, right) => left - right)) {
            if (addressRoots.has(root)) continue
            const logicalType = entry.fn.localTypes.at(root)
            if (logicalType === undefined)
              throw new RangeError(`Backend lost mutable root %${root}`)
            if (NativeValue.classify(program.layout, logicalType) !== 'Direct') continue
            const storage: Array<Value.Input> = []
            for (const [lane, callingLane] of valueLanesFor(logicalType).entries()) {
              storage.push(Emitter.alloca(body, laneType(callingLane), `mut${root}_${lane}`))
            }
            mutableStorage.set(root, storage)
          }
          const loweringContext: NativeLoweringContext.LoweringContext = {
            builder,
            body,
            program,
            request,
            layout: program.layout,
            types: { i8, i32, f32, f64, pointer, integers: integerTypes },
            lanesFor,
            valueLanesFor,
            laneType,
            packedLanes: (lanes: ReadonlyArray<Layout.CallingLane>, start?: number) =>
              ValueStorage.transport(program.layout.target, lanes, start),
            declared,
            entry,
            mutableStorage,
          }
          const nativeTypes: NativeType.LoweringContext = {
            program,
            i32,
            f32,
            f64,
            pointer,
            integerTypes,
          }
          const addressStorage = new Map<number, Value.Input>()
          const transientOutcomes = NativeOutcomeStorage.transientLocals(entry.fn, entry.linear)
          const placeRoots = entry.fn.localTypes.flatMap((type, ordinal) =>
            (NativeValue.classify(program.layout, type) === 'Place' ||
              type._tag === 'EnvironmentBorrow') &&
            !transientOutcomes.has(ordinal)
              ? [ordinal]
              : [],
          )
          for (const root of [...new Set([...addressRoots, ...placeRoots])].sort(
            (left, right) => left - right,
          )) {
            const logicalType = entry.fn.localTypes.at(root)
            if (logicalType?._tag === 'EnvironmentBorrow') {
              addressStorage.set(root, Emitter.alloca(body, pointer, `borrow${root}_slot`))
              continue
            }
            if (
              logicalType !== undefined &&
              NativeValue.classify(program.layout, logicalType) === 'Place'
            ) {
              const place = NativePlace.allocate(
                { body, types: nativeTypes, lanePointers },
                logicalType,
                `addr${root}`,
              )
              addressStorage.set(root, place.base)
              continue
            }
            const layout =
              logicalType === undefined
                ? undefined
                : NativeType.addressLayout(program.layout, logicalType)
            if (logicalType === undefined || layout === undefined) {
              throw new RangeError(`Backend lost address-taken value %${root}`)
            }
            const count = Emitter.integerUnsigned(builder, i32, BigInt(layout.size))
            addressStorage.set(
              root,
              Emitter.alloca(body, i8, `addr${root}`, {
                count,
                alignment: Emitter.alignment(body, layout.alignment),
              }),
            )
          }
          const stableAddressFields = new Map<number, Mir.CoroutineFramePayloadField>()
          if (coroutineFrame !== undefined) {
            for (const state of coroutineFrame.states) {
              for (const field of state.payload) {
                if (!addressRoots.has(field.local.ordinal)) continue
                const existing = stableAddressFields.get(field.local.ordinal)
                if (existing !== undefined && existing.offset !== field.offset) {
                  throw new RangeError(
                    `LLVM coroutine frame moved borrowed root %${field.local.ordinal} between states`,
                  )
                }
                stableAddressFields.set(field.local.ordinal, field)
              }
            }
          }

          const storageContext: NativeStorage.Context = {
            builder: loweringContext.builder,
            body: loweringContext.body,
            byteType: i8,
            offsetType: i32,
            fn: loweringContext.entry.fn,
            layout: loweringContext.layout,
            mutableRoots,
            blockRoots: new Set<number>(),
            mutableStorage: loweringContext.mutableStorage,
            addressRoots,
            addressStorage,
            transientOutcomes,
            locals,
            types: nativeTypes,
            lanePointers,
            sequences: { materialize: 0, reload: 0 },
          }
          for (const root of [...addressRoots].sort((left, right) => left - right)) {
            const logicalType = entry.fn.localTypes.at(root)
            if (logicalType === undefined)
              throw new RangeError(`Backend lost address root %${root}`)
            if (NativeValue.classify(program.layout, logicalType) !== 'Direct') continue
            mutableStorage.set(root, NativeStorage.addressLanes(storageContext, root))
            NativeStorage.storeAddressValues(
              storageContext,
              root,
              Array.from(valueLanesFor(logicalType), (lane) =>
                Emitter.nullValue(builder, laneType(lane)),
              ),
              `addr${root}_zero`,
            )
          }
          const diagnosticScopes =
            diagnostic === undefined
              ? new Map<number, NativeDiagnosticScope.NativeDiagnosticScope>()
              : NativeDiagnosticScope.prepare({
                  builder,
                  body,
                  entry,
                  declared,
                  diagnostic,
                  program,
                  types: nativeTypes,
                  lanePointers,
                })
          if (entry.suspendable && diagnosticScopes.size > 0 && coroutineFrame === undefined)
            throw new RangeError('Suspended diagnostic scope lost its persistent frame')
          let physicalParameter = 0
          for (let ordinal = 0; ordinal < entry.fn.parameterCount; ordinal += 1) {
            const logicalType = entry.fn.localTypes.at(ordinal)
            if (logicalType === undefined) {
              throw new RangeError(`Backend lost parameter type %${ordinal}`)
            }
            if (entry.argumentParameters.at(ordinal)?.indirect) {
              const incoming = Emitter.argument(body, physicalParameter++)
              const destination = NativeStorage.readLocal(storageContext, {
                _tag: 'Local',
                ordinal,
              })
              if (destination._tag !== 'NativePlace')
                throw new RangeError('Canonical parameter lost its local storage')
              NativePlace.copy(
                destination,
                storageContext,
                NativePlace.make(program.layout, logicalType, incoming),
              )
              continue
            }
            const values: Array<Value.Input> = []
            for (let lane = 0, count = lanesFor(logicalType).length; lane < count; lane += 1) {
              values.push(Emitter.argument(body, physicalParameter))
              physicalParameter += 1
            }
            if (logicalType._tag === 'EnvironmentBorrow') {
              const base = values.at(0)
              if (base === undefined)
                throw new RangeError(`Backend lost environment borrow %${ordinal}`)
              const slot = addressStorage.get(ordinal)
              if (slot === undefined) throw new RangeError('Environment borrow lost its entry slot')
              Emitter.store(body, base, slot)
              addressStorage.set(ordinal, slot)
              continue
            }
            NativeStorage.writeLocal(storageContext, ordinal, values)
            const storage = mutableStorage.get(ordinal)
            if (storage !== undefined) {
              for (const [lane, pointer] of storage.entries()) {
                const stored = values.at(lane)
                if (stored !== undefined) Emitter.store(body, stored, pointer)
              }
            }
            if (
              addressRoots.has(ordinal) &&
              NativeValue.classify(program.layout, logicalType) === 'Direct'
            ) {
              NativeStorage.storeAddressValues(
                storageContext,
                ordinal,
                values,
                `addr${ordinal}_param`,
              )
            }
          }
          if (entry.diagnosticParameter !== undefined) physicalParameter += 2
          if (entry.resultStorage !== undefined) physicalParameter += 1
          const transferPointer = entry.suspendable
            ? Emitter.argument(body, physicalParameter)
            : undefined
          const resumeFrame = entry.suspendable
            ? Emitter.argument(body, physicalParameter + 1)
            : undefined
          const resumePath = entry.suspendable
            ? Emitter.argument(body, physicalParameter + 2)
            : undefined
          const initialBlock = blocks.get(entry.fn.entry.ordinal)
          if (initialBlock === undefined) throw new RangeError('Native function has no entry block')
          const completion = NativeReturn.makeCompletion(
            storageContext,
            entry,
            diagnostic !== undefined && diagnostic.outcomes.size > 0,
          )
          Emitter.branch(body, dispatchBlock ?? initialBlock)
          if (entry.suspendable) {
            const entryBlock = blocks.get(entry.fn.entry.ordinal)
            if (
              dispatchBlock === undefined ||
              resumeFrame === undefined ||
              resumePath === undefined ||
              entryBlock === undefined
            )
              throw new RangeError('LLVM suspension dispatch lost its entry state')
            Emitter.setInsertionPoint(body, dispatchBlock)
            if (coroutineFrame !== undefined) {
              if (
                invocationFrameStorage === undefined ||
                executionStorage === undefined ||
                transferPointer === undefined ||
                usizeType === undefined ||
                frameReuseBlock === undefined ||
                frameAllocateBlock === undefined ||
                frameAcquiredBlock === undefined ||
                frameTrapBlock === undefined ||
                framePushedBlock === undefined
              )
                throw new RangeError('LLVM coroutine-frame stack lost private storage support')
              const resumeAddress = Emitter.cast(
                body,
                'ptrtoint',
                resumeFrame,
                usizeType,
                'suspend_resume_frame_address',
              )
              Emitter.conditionalBranch(
                body,
                Emitter.integerCompare(
                  body,
                  'ne',
                  resumeAddress,
                  Emitter.integerUnsigned(builder, usizeType, 0n),
                  'suspend_has_reusable_frame',
                ),
                frameReuseBlock,
                frameAllocateBlock,
              )
              Emitter.setInsertionPoint(body, frameReuseBlock)
              Emitter.store(body, resumeFrame, invocationFrameStorage)
              Emitter.branch(body, frameAcquiredBlock)
              Emitter.setInsertionPoint(body, frameAllocateBlock)
              const state = NativeExecutionStorage.ensure(
                { builder, body, pointer, usizeType, storage: executionStorage },
                NativeLanePointer.lanePointer(
                  lanePointers,
                  body,
                  transferPointer,
                  NativeExecutionStorage.stateOffset(program.layout.target.pointerSize),
                  'suspend_storage_slot',
                ),
                'suspend_storage',
              )
              const allocatedFrame = NativeExecutionStorage.invoke(
                { builder, body, pointer, storage: executionStorage },
                'acquire',
                [
                  state,
                  Emitter.integerUnsigned(
                    builder,
                    usizeType,
                    BigInt(Math.max(coroutineFrame.size, 1)),
                  ),
                  Emitter.integerUnsigned(
                    builder,
                    usizeType,
                    BigInt(Math.max(coroutineFrame.alignment, 1)),
                  ),
                ],
                'suspend_invocation_frame',
              )
              if (allocatedFrame === undefined)
                throw new RangeError('LLVM private frame allocation returned no pointer')
              const exhausted = Emitter.integerCompare(
                body,
                'eq',
                Emitter.cast(
                  body,
                  'ptrtoint',
                  allocatedFrame,
                  usizeType,
                  'suspend_invocation_frame_address',
                ),
                Emitter.integerUnsigned(builder, usizeType, 0n),
                'suspend_invocation_frame_exhausted',
              )
              Emitter.store(body, allocatedFrame, invocationFrameStorage)
              Emitter.conditionalBranch(body, exhausted, frameTrapBlock, framePushedBlock)
              Emitter.setInsertionPoint(body, frameTrapBlock)
              Emitter.intrinsicCall(body, 'trap', [], [])
              Emitter.unreachable(body)
              Emitter.setInsertionPoint(body, framePushedBlock)
              const pushedFrame = Emitter.load(
                body,
                pointer,
                invocationFrameStorage,
                'suspend_pushed_frame',
              )
              if (diagnostic !== undefined) {
                for (const field of coroutineFrame.diagnosticOutcomes) {
                  NativeDiagnosticOutcome.initialize(
                    {
                      storage: NativeLanePointer.lanePointer(
                        lanePointers,
                        body,
                        pushedFrame,
                        field.offset,
                        `suspend_initialize_outcome${field.outcome.ordinal}`,
                      ),
                    },
                    diagnostic,
                  )
                }
              }
              for (const [root, field] of stableAddressFields) {
                if (root >= entry.fn.parameterCount) continue
                NativeFrame.retain(
                  storageContext,
                  pushedFrame,
                  field,
                  `suspend_parameter_root${root}`,
                )
              }
              Emitter.branch(body, frameAcquiredBlock)
              Emitter.setInsertionPoint(body, frameAcquiredBlock)
              const invocationFrame = Emitter.load(
                body,
                pointer,
                invocationFrameStorage,
                'suspend_selected_invocation_frame',
              )
              if (diagnostic !== undefined) {
                for (const field of coroutineFrame.diagnosticOutcomes) {
                  diagnostic.outcomes.set(field.outcome.ordinal, {
                    storage: NativeLanePointer.lanePointer(
                      lanePointers,
                      body,
                      invocationFrame,
                      field.offset,
                      `suspend_diagnostic_outcome${field.outcome.ordinal}`,
                    ),
                  })
                }
              }
              for (const field of coroutineFrame.diagnosticScopes) {
                const scope = diagnosticScopes.get(field.scope.ordinal)
                if (scope === undefined)
                  throw new RangeError('Persistent diagnostic descriptor lost its scope')
                diagnosticScopes.set(field.scope.ordinal, {
                  ...scope,
                  record: NativeLanePointer.lanePointer(
                    lanePointers,
                    body,
                    invocationFrame,
                    field.offset,
                    `suspend_diagnostic_scope${field.scope.ordinal}`,
                  ),
                })
              }
              for (const [root, field] of stableAddressFields) {
                addressStorage.set(
                  root,
                  Emitter.getElementPtr(
                    body,
                    i8,
                    invocationFrame,
                    [Emitter.integerUnsigned(builder, i32, BigInt(field.offset))],
                    `suspend_stable_root${root}`,
                  ),
                )
                const rootType = entry.fn.localTypes.at(root)
                if (
                  rootType !== undefined &&
                  NativeValue.classify(program.layout, rootType) === 'Direct'
                )
                  mutableStorage.set(root, NativeStorage.addressLanes(storageContext, root))
              }
            }
            const dispatch = Emitter.switchTerminator(body, resumePath, entryBlock)
            for (const resume of resumeControls) {
              const target = resumeBlocks.get(suspensionPointKey(resume.region.point))
              if (target === undefined) throw new RangeError('LLVM suspension lost resume block')
              Emitter.addSwitchCase(
                body,
                dispatch,
                Emitter.integerUnsigned(builder, i32, BigInt(resume.ordinal)),
                target,
              )
            }
            Emitter.sealSwitch(body, dispatch)
          }
          const debugLocation: NativeDebug.LocationContext = {
            builder,
            body,
            enabled: debug,
            scope,
            table,
          }
          const laneContext: NativeArith.LaneContext = {
            body: loweringContext.body,
            pointerBits: loweringContext.layout.target.pointerSize === 4 ? 32 : 64,
            i32: loweringContext.types.i32,
            integerTypes: loweringContext.types.integers,
            types: nativeTypes,
          }
          const failureContext: NativeAggregate.FailureContext = {
            builder,
            body,
            program,
            i32,
            types: nativeTypes,
            arith: laneContext,
          }

          const suspensionReturnContext: NativeSuspension.ReturnContext = {
            ...(completion === undefined ? {} : { completion }),
            builder,
            body,
            i32,
            pointer,
            entry,
            lanePointers,
            ...(transferPointer === undefined ? {} : { transferPointer }),
            ...(invocationFrameStorage === undefined ? {} : { invocationFrameStorage }),
            ...(executionStorage === undefined ? {} : { executionStorage }),
            types: nativeTypes,
            ...(diagnostic === undefined ? {} : { diagnostic }),
          }
          const hostFailureContext: NativeHostFailure.Context = {
            builder,
            body,
            entry,
            types: nativeTypes,
            suspension: suspensionReturnContext,
            termination: terminationContext,
          }
          const synchronousCallContext: NativeCall.SynchronousContext = {
            body,
            storage: storageContext,
            ...(diagnostic === undefined ? {} : { diagnostic }),
          }
          const arithContext: NativeArith.OperationContext = {
            builder,
            body,
            program,
            i32,
            integerTypes,
            signedOverflowSignatures,
            unsignedOverflowSignatures,
            lane: laneContext,
            types: nativeTypes,
            debug: debugLocation,
            termination: terminationContext,
          }
          const suspensionContext: NativeSuspension.OperationContext = {
            ...(diagnostic === undefined ? {} : { diagnostic }),
            builder,
            body,
            program,
            i8,
            i32,
            pointer,
            entry,
            lanePointers,
            types: nativeTypes,
            transferHeaderSize,
            transferResultOffset,
            ...(transferPointer === undefined ? {} : { transferPointer }),
            ...(resumeFrame === undefined ? {} : { resumeFrame }),
            originThunks,
            resumeThunks,
            suspensionRegions,
            resumeBlocks,
            storage: storageContext,
            returns: suspensionReturnContext,
          }
          const callContext: NativeCall.Context = {
            builder,
            body,
            program,
            i8,
            i32,
            pointer,
            entry,
            ...(transferPointer === undefined ? {} : { transferPointer }),
            ...(invocationFrameStorage === undefined ? {} : { invocationFrameStorage }),
            resumeThunks,
            lanePointers,
            types: nativeTypes,
            storage: storageContext,
            synchronous: synchronousCallContext,
            returns: suspensionReturnContext,
          }

          const cleanupContext: NativeAggregate.Context = {
            builder,
            body,
            program,
            i8,
            i32,
            pointer,
            ...(usizeType === undefined ? {} : { usizeType }),
            ...(free === undefined ? {} : { free }),
            ...(executionStorage === undefined ? {} : { executionStorage }),
            ...(executionRelease === undefined ? {} : { executionRelease }),
            declared,
            resumeThunks,
            types: nativeTypes,
            lanePointers,
            call: callContext,
            arith: laneContext,
            storage: storageContext,
          }

          const actorContext: NativeOperationContext.Context = {
            diagnosticScopes,
            runtimeFeatures,
            builder,
            body,
            program,
            entry,
            declared,
            staticPointers,
            i32,
            f32,
            f64,
            pointer,
            transferStorageSize,
            ...(childThunkType === undefined ? {} : { childThunkType }),
            ...(resumeThunkType === undefined ? {} : { resumeThunkType }),
            ...(usizeType === undefined ? {} : { usizeType }),
            integerTypes,
            signedOverflowSignatures,
            unsignedOverflowSignatures,
            ...(malloc === undefined ? {} : { malloc }),
            ...(free === undefined ? {} : { free }),
            ...(memcmp === undefined ? {} : { memcmp }),
            foreignIndirects,
            foreignFunctions,
            foreignStatics,
            foreignCallbacks,
            lanePointers,
            suspensionRegions,
            types: nativeTypes,
            storage: storageContext,
            debug: debugLocation,
            hostFailure: hostFailureContext,
            cleanup: cleanupContext,
            failure: failureContext,
            arith: arithContext,
            call: callContext,
            suspension: suspensionContext,
            termination: terminationContext,
            state: operationState,
          }
          const operationContext: NativeOperation.LoweringContext = {
            value: actorContext,
            memory: actorContext,
            place: actorContext,
            scalar: actorContext,
            effect: actorContext,
            execution: actorContext,
            call: actorContext,
          }
          // Frame payloads are implicit operands of suspension lowering. They must survive
          // reference retirement even when absent from the remaining explicit operations.
          const frameRoots = new Set<number>()
          for (const resume of resumeControls) {
            for (const field of resume.layout.payload) {
              if (mutableRoots.has(field.local.ordinal)) frameRoots.add(field.local.ordinal)
            }
          }
          for (const [blockOrdinal, block] of entry.linear.entries()) {
            const blockHandle = blocks.get(block.id.ordinal)
            if (blockHandle === undefined) continue
            const references = blockLocalReferences(block)
            storageContext.blockRoots.clear()
            for (const root of references.initial) {
              if (mutableRoots.has(root)) storageContext.blockRoots.add(root)
            }
            for (const root of frameRoots) storageContext.blockRoots.add(root)
            Emitter.setInsertionPoint(body, blockHandle)
            if (diagnostic !== undefined) {
              const recovered = block.recoveryOutcomes?.at(-1)
              const slot =
                recovered === undefined ? undefined : diagnostic.outcomes.get(recovered.ordinal)
              if (recovered !== undefined && slot === undefined)
                throw new RangeError('Selected recovery lost its diagnostic outcome storage')
              let cause =
                block.recoveryBoundary === undefined
                  ? diagnostic.incomingCause
                  : Emitter.nullValue(builder, diagnostic.causeType)
              if (slot !== undefined) cause = NativeDiagnosticOutcome.borrow(slot, diagnostic)
              Emitter.store(body, cause, diagnostic.cause)
            }
            if (blockOrdinal > 0) NativeStorage.reloadRoots(storageContext, `b${block.id.ordinal}`)
            for (const [operationOrdinal, operation] of block.operations.entries()) {
              for (const root of references.starting.get(operationOrdinal) ?? []) {
                if (mutableRoots.has(root)) storageContext.blockRoots.add(root)
              }
              NativeOperation.emit(operationContext, operation)
              const destination = destinationOf(operation)
              if (destination !== undefined && mutableRoots.has(destination.ordinal)) {
                NativeStorage.commitLocal(storageContext, destination)
              }
              if (diagnostic?.sourceState.dirty === true) {
                NativeStorage.reloadAddressRoots(storageContext)
                diagnostic.sourceState.dirty = false
              }
              for (const root of references.ending.get(operationOrdinal) ?? []) {
                if (!frameRoots.has(root)) storageContext.blockRoots.delete(root)
              }
            }
            const terminalAssembly = block.operations.at(-1)
            if (terminalAssembly?._tag === 'NativeAssembly' && terminalAssembly.assembly.noReturn) {
              Emitter.unreachable(body)
              continue
            }
            NativeControl.emit(
              {
                builder,
                body,
                i32,
                types: nativeTypes,
                blocks,
                storage: storageContext,
                entry,
                cleanup: cleanupContext,
                failure: failureContext,
                suspension: suspensionReturnContext,
                debug: debugLocation,
                termination: terminationContext,
              },
              block.terminator,
              blockOrdinal,
              block.id,
            )
          }

          NativeTermination.emitTrapBlocks(terminationContext)
          NativeReturn.emitCompletion(suspensionReturnContext)
        }),
      )
    }).pipe(Effect.withSpan('NativeFunction.emitBodies_entry'))
  }
})
