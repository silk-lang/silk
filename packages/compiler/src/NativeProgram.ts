import * as Emitter from '@silklang/llvm/Emitter'
import * as ContinuationTransfer from './ContinuationTransfer.js'
import * as ByteString from '@silklang/llvm/ByteString'
import * as NativeForeignGuard from './NativeForeignGuard.js'
import * as NativeCAbi from './NativeCAbi.js'
import * as Bitcode from '@silklang/llvm/Bitcode'
import * as Builder from '@silklang/llvm/Builder'
import * as Constant from '@silklang/llvm/Constant'
import * as FunctionActor from '@silklang/llvm/Function'
import * as IrText from '@silklang/llvm/IrText'
import type * as LlvmError from '@silklang/llvm/LlvmError'
import * as LlvmMetadata from '@silklang/llvm/Metadata'
import * as LlvmType from '@silklang/llvm/Type'
import * as Variable from '@silklang/llvm/Variable'
import * as Verify from '@silklang/llvm/Verify'
import * as Effect from 'effect/Effect'
import type {
  CodegenRequest,
  ForeignExport,
  ForeignImport,
  ForeignStatic,
  RuntimeFeature,
  SymbolEntry,
} from './Backend.js'
import {
  BackendError,
  formatModuleViolations,
  lineTable,
  sanitize,
  suspensionPointKey,
} from './Backend.js'
import * as CAbi from './CAbi.js'
import * as CoroutineFrame from './CoroutineFrame.js'
import * as NativeExecutionStorage from './NativeExecutionStorage.js'
import * as Instances from './Instances.js'
import { alignUp } from './internal/Align.js'
import * as Layout from './Layout.js'
import * as Mir from './Mir.js'
import * as MirVerification from './MirVerification.js'
import * as NativeCall from './NativeCall.js'
import type * as NativeDebug from './NativeDebug.js'
import * as NativeDeclare from './NativeDeclare.js'
import * as NativeExecutionOperation from './NativeExecutionOperation.js'
import type * as NativeForeignOperation from './NativeForeignOperation.js'
import * as NativeFunction from './NativeFunction.js'
import type * as NativeLanePointer from './NativeLanePointer.js'
import type * as NativeLoweringContext from './NativeLoweringContext.js'
import * as NativeOperation from './NativeOperation.js'
import * as NativeSuspension from './NativeSuspension.js'
import * as NativeSymbol from './NativeSymbol.js'
import * as NativeTermination from './NativeTermination.js'
import * as NativeType from './NativeType.js'
import * as ValueStorage from './ValueStorage.js'
import type * as Scalar from './Scalar.js'

export const emit = Effect.fn('NativeProgram.emit')(function* (
  program: Mir.Module,
  request: CodegenRequest,
): Effect.fn.Return<
  {
    /** Source declarations retained in the emitted object. */
    readonly symbols: ReadonlyArray<SymbolEntry>
    readonly nativeRuntimeSymbols: ReadonlyArray<string>
    readonly runtimeFeatures: ReadonlyArray<RuntimeFeature>
    readonly foreignImports: ReadonlyArray<ForeignImport>
    readonly foreignExports: ReadonlyArray<ForeignExport>
    readonly foreignStatics: ReadonlyArray<ForeignStatic>
    /** Renders the textual IR on demand; most compiles never read it. */
    readonly renderIr: () => string
    readonly bitcode: Uint8Array
  },
  BackendError | LlvmError.LlvmError
> {
  yield* Effect.annotateCurrentSpan({
    'native.module': program.module,
    'native.support': request.support === true,
    'native.functions': program.functions.length,
  })
  const suspensionEnabled = program.functions.some((fn) => (fn.suspension?.regions.length ?? 0) > 0)
  // A retained execution can be destroyed without ever running its body. Its package still owns
  // the continuation chain and therefore needs frame cleanup even when no relay was emitted.
  const needsFrameCleanup = program.layout.executionPackages.plans.some(
    (plan) => plan.initialContinuationSegment,
  )
  const frameRuntimeEnabled = suspensionEnabled || needsFrameCleanup
  const runtimeFeatures = new Set<RuntimeFeature>()
  const builder = yield* Builder.make({
    sourceFilename: program.module,
    targetTriple: program.layout.target.id,
    strip: request.mode !== 'debug',
  })
  const types = yield* initializeTypes(builder, program, frameRuntimeEnabled)
  const { i8, i32, f32, f64, pointer, usizeType, integerTypes, lanePointers } = types
  const staticPointers = yield* emitStaticData(builder, program, i8)
  const typeContext: NativeType.LoweringContext = {
    program,
    i32,
    f32,
    f64,
    pointer,
    integerTypes,
  }
  const lanesFor = (type: Mir.Type): ReadonlyArray<Layout.CallingLane> =>
    NativeType.lanesFor(typeContext, type)
  const valueLanesFor = (type: Mir.Type): ReadonlyArray<Layout.CallingLane> =>
    NativeType.valueLanesFor(typeContext, type)
  const laneType = (lane: Layout.CallingLane): LlvmType.Type =>
    NativeType.laneType(typeContext, lane)
  const { transferHeaderSize, transferResultOffset, transferStorageSize } = yield* layoutTransfers(
    program,
    typeContext,
  )
  type OverflowSignature = {
    readonly returnType: LlvmType.Type
    readonly parameters: ReadonlyArray<LlvmType.Type>
  }
  const signedOverflowSignatures = new Map<number, OverflowSignature>()
  const unsignedOverflowSignatures = new Map<number, OverflowSignature>()
  const { needsAllocation, malloc, free, memcmp } = yield* declareRuntime(builder, program, types)

  const {
    cType,
    foreignGuard,
    foreignIndirects,
    foreignFunctions,
    declaredForeign,
    foreignStatics,
    staticDeclarations,
  } = yield* declareForeignSymbols(
    builder,
    program,
    request,
    types,
    needsAllocation,
    frameRuntimeEnabled,
  )

  const functionDeclarations = yield* NativeDeclare.functions({
    types: typeContext,
    lanePointers,
    builder,
    program,
    i32,
    pointer,
    lanesFor,
    laneType,
    support: request.support === true,
  })
  const declared = functionDeclarations.declared
  const executionStorage = NativeExecutionStorage.make(program, declared)
  if (frameRuntimeEnabled && executionStorage === undefined)
    throw new RangeError('Private frame lowering requires a selected execution-storage component')
  yield* retainRoots(builder, program, declared)

  const voidType = functionDeclarations.voidType
  const executionRelease = yield* Emitter.module(builder, (builder) =>
    NativeExecutionOperation.declareReleaseHelper(builder, program, pointer, voidType),
  )
  const foreignCallbacks = yield* declareExports(
    builder,
    program,
    request,
    declared,
    cType,
    foreignGuard,
  )
  const { childThunkType, resumeThunkType, originThunks, resumeThunks } =
    yield* declareSuspensionThunks(builder, program, declared, types, suspensionEnabled)
  const { debug, compileUnit, file, table, debugContext } = yield* initializeDebugInfo(
    builder,
    program,
    request,
  )
  const termination = NativeTermination.make(request)
  yield* NativeFunction.emitBodies({
    termination,
    runtimeFeatures,
    builder,
    program,
    request,
    i8,
    i32,
    f32,
    f64,
    pointer,
    ...(usizeType === undefined ? {} : { usizeType }),
    integerTypes,
    lanePointers,
    staticPointers,
    lanesFor,
    valueLanesFor,
    laneType,
    transferHeaderSize,
    transferResultOffset,
    transferStorageSize,
    ...(childThunkType === undefined ? {} : { childThunkType }),
    ...(resumeThunkType === undefined ? {} : { resumeThunkType }),
    signedOverflowSignatures,
    unsignedOverflowSignatures,
    ...(malloc === undefined ? {} : { malloc }),
    ...(free === undefined ? {} : { free }),
    ...(executionStorage === undefined ? {} : { executionStorage }),
    ...(executionRelease === undefined ? {} : { executionRelease: executionRelease.handle }),
    ...(memcmp === undefined ? {} : { memcmp }),
    foreignFunctions,
    foreignStatics,
    foreignCallbacks,
    foreignIndirects,
    declared,
    originThunks,
    resumeThunks,
    debug,
    compileUnit,
    file,
    table,
    debugContext,
  })

  if (executionRelease !== undefined)
    yield* Emitter.module(builder, (builder) =>
      NativeExecutionOperation.emitReleaseHelper({
        builder,
        program,
        i8,
        i32,
        pointer,
        ...(usizeType === undefined ? {} : { usizeType }),
        ...(free === undefined ? {} : { free }),
        ...(executionStorage === undefined ? {} : { executionStorage }),
        resumeThunks,
        declared,
        types: typeContext,
        lanePointers,
        helper: executionRelease,
      }),
    )

  yield* Emitter.module(builder, (builder) =>
    NativeSuspension.emitThunks({
      builder,
      program,
      i8,
      i32,
      pointer,
      ...(usizeType === undefined ? {} : { usizeType }),
      lanePointers,
      declared,
      originThunks,
      resumeThunks,
      types: typeContext,
      ...(executionStorage === undefined ? {} : { executionStorage }),
      transferHeaderSize,
      transferResultOffset,
      transferStorageSize,
      ...(childThunkType === undefined ? {} : { childThunkType }),
      ...(resumeThunkType === undefined ? {} : { resumeThunkType }),
    }),
  )
  if (needsFrameCleanup || originThunks.size > 0 || resumeThunks.size > 0)
    runtimeFeatures.add('NestedSuspensionRuntime')

  yield* verifyModule(builder, program)
  return yield* encodeArtifact({
    builder,
    program,
    declared,
    malloc,
    free,
    runtimeFeatures,
    declaredForeign,
    staticDeclarations,
  })
})

// These stages are traced deliberately: they attribute whole-program native emission costs.
type ProgramTypes = Effect.Success<ReturnType<typeof initializeTypes>>
type CType = (type: CAbi.CAbiType) => LlvmType.Type | undefined

const initializeTypes = Effect.fn('NativeProgram.initializeTypes')(function* (
  builder: Builder.Builder,
  program: Mir.Module,
  frameRuntimeEnabled: boolean,
) {
  // Internal control/ABI values use i32 even when the selected source has no i32 declarations.
  const i32 = yield* LlvmType.integer(builder, 32)
  const usesScalar = (spelling: Scalar.Spelling): boolean =>
    program.layout.callingShapes.some((shape) => shape.lanes.some((lane) => lane.type === spelling))
  // LLVM assigns type-table identities in creation order, so preserve byte-for-byte output for
  // programs that do not use floating-point values by creating these types only when required.
  const f32 = usesScalar('f32') ? yield* LlvmType.float(builder) : i32
  const f64 = usesScalar('f64') ? yield* LlvmType.double(builder) : i32
  const usizeLayout = Layout.entry(program.layout, 'usize')
  let usizeType: LlvmType.Type | undefined
  if (usizeLayout?.representation._tag === 'UnsignedInteger') {
    usizeType = yield* LlvmType.integer(builder, usizeLayout.representation.bits)
  } else if (frameRuntimeEnabled) {
    usizeType = yield* LlvmType.integer(builder, program.layout.target.pointerSize * 8)
  } else {
    usizeType = undefined
  }
  const integerTypes = new Map<number, LlvmType.Type>([[32, i32]])
  if (usizeLayout?.representation._tag === 'UnsignedInteger' && usizeType !== undefined) {
    integerTypes.set(usizeLayout.representation.bits, usizeType)
  }
  for (const bits of [8, 16, 64] as const) {
    if (!integerTypes.has(bits)) integerTypes.set(bits, yield* LlvmType.integer(builder, bits))
  }
  const i8 = yield* LlvmType.integer(builder, 8)
  const pointer = yield* LlvmType.pointer(builder)
  const lanePointers: NativeLanePointer.Context = {
    byteType: i8,
    offsetType: i32,
  }
  return { i8, i32, f32, f64, pointer, usizeType, integerTypes, lanePointers }
})

const emitStaticData = Effect.fn('NativeProgram.emitStaticData')(function* (
  builder: Builder.Builder,
  program: Mir.Module,
  i8: LlvmType.Type,
) {
  const staticPointers = new Map<string, Constant.Constant>()
  for (const [ordinal, data] of (program.staticData ?? []).entries()) {
    const storageType = yield* LlvmType.array(builder, i8, data.bytes.length)
    const initializer = yield* Constant.string(builder, Uint8Array.from(data.bytes))
    const variable = yield* Variable.make(builder, `silk.static.${ordinal}`, storageType, {
      initializer,
      constant: true,
      linkage: 'internal',
      unnamedAddress: 'unnamed_addr',
    })
    staticPointers.set(
      data.id,
      yield* Constant.fromGlobal(builder, yield* Variable.global(builder, variable)),
    )
  }
  return staticPointers
})

const layoutTransfers = Effect.fn('NativeProgram.layoutTransfers')(
  (program: Mir.Module, typeContext: NativeType.LoweringContext) =>
    Effect.sync(() => {
      const lanesFor = (type: Mir.Type) => NativeType.lanesFor(typeContext, type)
      // The fourth private word identifies the independently driven Execution owner.
      const transferHeaderSize =
        program.layout.target.pointerSize * ContinuationTransfer.headerWords
      const originArgumentLanes = program.functions.flatMap((fn) =>
        (fn.suspension?.regions ?? []).flatMap((region) =>
          region._tag === 'SuspendEffectRegion'
            ? [
                NativeSuspension.logicalLanes(
                  fn,
                  NativeCall.operationInputs(region.operation),
                  typeContext,
                ),
              ]
            : [],
        ),
      )
      const transferArgumentSize = originArgumentLanes.reduce(
        (maximum, lanes) =>
          Math.max(maximum, ValueStorage.transport(program.layout.target, lanes).end),
        0,
      )
      const transferResultOffset = alignUp(
        transferHeaderSize + transferArgumentSize,
        program.layout.target.pointerAlignment,
      )
      const transferResultSize = program.functions.reduce(
        (maximum, fn) =>
          Math.max(maximum, ValueStorage.transport(program.layout.target, lanesFor(fn.result)).end),
        0,
      )
      const transferStorageSize = alignUp(
        transferResultOffset + transferResultSize,
        program.layout.target.pointerAlignment,
      )
      return { transferHeaderSize, transferResultOffset, transferStorageSize }
    }),
)

const declareRuntime = Effect.fn('NativeProgram.declareRuntime')(function* (
  builder: Builder.Builder,
  program: Mir.Module,
  types: ProgramTypes,
) {
  const { i32, pointer, usizeType } = types
  const needsAllocation = program.functions.some((fn) =>
    MirVerification.operations(fn).some(NativeOperation.needsAllocation),
  )
  const malloc =
    needsAllocation && usizeType !== undefined
      ? yield* FunctionActor.declare(
          builder,
          NativeSymbol.foreign(program.layout.target, 'malloc'),
          yield* LlvmType.functionType(builder, pointer, [usizeType]),
        )
      : undefined
  const free = needsAllocation
    ? yield* FunctionActor.declare(
        builder,
        NativeSymbol.foreign(program.layout.target, 'free'),
        yield* LlvmType.functionType(builder, yield* LlvmType.voidType(builder), [pointer]),
      )
    : undefined
  const needsStringEquality = program.functions.some((fn) =>
    MirVerification.operations(fn).some((operation) => operation._tag === 'StringEqualsExact'),
  )
  const memcmp =
    needsStringEquality && usizeType !== undefined
      ? yield* FunctionActor.declare(
          builder,
          NativeSymbol.foreign(program.layout.target, 'memcmp'),
          yield* LlvmType.functionType(builder, i32, [pointer, pointer, usizeType]),
        )
      : undefined
  return { needsAllocation, malloc, free, memcmp }
})

const declareForeignIndirects = Effect.fn('NativeProgram.declareForeignIndirects')(function* (
  builder: Builder.Builder,
  indirectCalls: ReadonlyArray<Extract<Mir.Operation, { readonly _tag: 'ForeignIndirectCall' }>>,
  cType: CType,
  foreignGuard: NativeForeignGuard.NativeForeignGuard | undefined,
) {
  const foreignIndirects = new Map<string, NativeForeignOperation.Declaration>()
  for (const operation of indirectCalls) {
    const key = CAbi.signatureKey(operation.signature)
    if (foreignIndirects.has(key)) continue
    if (foreignGuard === undefined) throw new RangeError('LLVM foreign guard was not initialized')
    const parameters = operation.signature.parameters.map(cType)
    if (parameters.some((type) => type === undefined))
      throw new RangeError('Native indirect signature has a void parameter')
    const admitted = parameters.flatMap((type) => (type === undefined ? [] : [type]))
    const result = cType(operation.signature.result) ?? (yield* LlvmType.voidType(builder))
    const calleeType = yield* LlvmType.functionType(builder, result, admitted)
    const attributes = yield* Emitter.module(builder, (builder) =>
      NativeCAbi.attributes(builder, operation.signature),
    )
    const handle = yield* Emitter.module(builder, (builder) =>
      NativeForeignGuard.indirect(
        foreignGuard,
        builder,
        calleeType,
        result,
        admitted,
        attributes,
        foreignIndirects.size,
      ),
    )
    foreignIndirects.set(key, { handle, signature: operation.signature })
  }
  return foreignIndirects
})

const declareForeignFunctions = Effect.fn('NativeProgram.declareForeignFunctions')(function* (
  builder: Builder.Builder,
  program: Mir.Module,
  foreignCallShapes: ReadonlyArray<Extract<Mir.Operation, { readonly _tag: 'ForeignCall' }>>,
  cType: CType,
  foreignGuard: NativeForeignGuard.NativeForeignGuard | undefined,
) {
  const foreignFunctions = new Map<string, NativeForeignOperation.Declaration>()
  const declaredForeign = new Map<string, CAbi.CAbiSignature>()
  for (const call of program.foreignCalls) {
    if (declaredForeign.has(call.symbol)) continue
    declaredForeign.set(call.symbol, call.signature)
    const parameters = call.signature.parameters.map(cType)
    if (parameters.some((type) => type === undefined))
      throw new RangeError(`LLVM foreign function ${call.symbol} has a void parameter`)
    const attributes = yield* Emitter.module(builder, (builder) =>
      NativeCAbi.attributes(builder, call.signature),
    )
    const handle = yield* FunctionActor.declare(
      builder,
      NativeSymbol.foreign(program.layout.target, call.symbol),
      yield* LlvmType.functionType(
        builder,
        cType(call.signature.result) ?? (yield* LlvmType.voidType(builder)),
        parameters.flatMap((type) => (type === undefined ? [] : [type])),
        { variadic: call.signature.variadic },
      ),
      attributes === undefined ? {} : { attributes },
    ).pipe(
      Effect.mapError(
        (cause) =>
          new BackendError({
            operation: 'Backend.emit',
            backend: 'LLVM',
            message: `foreign function ${call.symbol} conflicts with the native runtime's own declaration of that symbol: ${cause.message}`,
            reason: { _tag: 'ForeignSymbolConflict', symbol: call.symbol },
          }),
      ),
    )
    if (foreignGuard === undefined) throw new RangeError('LLVM foreign guard was not initialized')
    for (const operation of foreignCallShapes) {
      if (operation.symbol !== call.symbol) continue
      const key = CAbi.callKey(call.symbol, operation.variadicArguments)
      if (foreignFunctions.has(key)) continue
      const arguments_ = [
        ...parameters,
        ...operation.variadicArguments.map((argument) => cType(argument.promoted)),
      ]
      if (arguments_.some((type) => type === undefined))
        throw new RangeError('Invalid variadic guard parameter')
      const guardResult = cType(call.signature.result) ?? (yield* LlvmType.voidType(builder))
      const guarded = yield* Emitter.module(builder, (builder) =>
        NativeForeignGuard.wrap(
          foreignGuard,
          builder,
          handle,
          foreignFunctions.size,
          arguments_.flatMap((type) => (type === undefined ? [] : [type])),
          guardResult,
        ),
      )
      foreignFunctions.set(key, { handle: guarded, signature: call.signature })
    }
  }
  return { foreignFunctions, declaredForeign }
})

const declareForeignStatics = Effect.fn('NativeProgram.declareForeignStatics')(function* (
  builder: Builder.Builder,
  program: Mir.Module,
  cType: CType,
) {
  const foreignStatics = new Map<string, NativeForeignOperation.StaticDeclaration>()
  // Planning has rejected incompatible claims; matching imports share one C global.
  const staticDeclarations = [
    ...new Map(program.foreignStatics.map((record) => [record.symbol, record])).values(),
  ]
  for (const record of staticDeclarations) {
    const classified = CAbi.classify(record.type, program.layout.target, 'Parameter')
    const valueType = cType(classified)
    if (valueType === undefined)
      throw new RangeError(`LLVM foreign static ${record.symbol} has a void type`)
    let initializer: Constant.Constant | undefined
    if (record.direction === 'Export' && record.literal?._tag === 'IntegerLiteral') {
      initializer =
        classified._tag === 'Integer' && classified.signed
          ? yield* Constant.integerSigned(builder, valueType, record.literal.value)
          : yield* Constant.integerUnsigned(builder, valueType, record.literal.value)
    } else if (record.direction === 'Export' && record.literal?._tag === 'FloatingLiteral') {
      initializer =
        classified._tag === 'Float' && classified.bits === 32
          ? yield* Constant.floatFromNumber(builder, valueType, Number(record.literal.spelling))
          : yield* Constant.doubleFromNumber(builder, valueType, Number(record.literal.spelling))
    }
    const variable = yield* Variable.make(
      builder,
      NativeSymbol.foreign(program.layout.target, record.symbol),
      valueType,
      {
        ...(initializer === undefined ? {} : { initializer }),
        constant: record.direction === 'Export',
        linkage: 'external',
        externallyInitialized: record.direction === 'Import',
      },
    ).pipe(
      Effect.mapError(
        (cause) =>
          new BackendError({
            operation: 'Backend.emit',
            backend: 'LLVM',
            message: `foreign static ${record.symbol} conflicts with another native symbol: ${cause.message}`,
            reason: { _tag: 'ForeignSymbolConflict', symbol: record.symbol },
          }),
      ),
    )
    foreignStatics.set(record.symbol, {
      address: yield* Constant.fromGlobal(builder, yield* Variable.global(builder, variable)),
      valueType,
    })
  }
  return { foreignStatics, staticDeclarations }
})

const declareForeignSymbols = Effect.fn('NativeProgram.declareForeignSymbols')(function* (
  builder: Builder.Builder,
  program: Mir.Module,
  request: CodegenRequest,
  types: ProgramTypes,
  needsAllocation: boolean,
  frameRuntimeEnabled: boolean,
) {
  const { f32, f64, integerTypes, pointer } = types
  // Foreign symbols are declared once each under the default (C) calling convention with the
  // LLVM types the classified C signature selects; agreeing redeclarations share one entry.
  const cType = (type: CAbi.CAbiType): LlvmType.Type | undefined => {
    switch (type._tag) {
      case 'Void':
        return undefined
      case 'Float':
        return type.bits === 32 ? f32 : f64
      case 'Integer':
        return integerTypes.get(type.bits)
      case 'Pointer':
      case 'FunctionPointer':
        return pointer
    }
  }
  const indirectCalls = program.functions.flatMap((fn) =>
    MirVerification.operations(fn).filter((operation) => operation._tag === 'ForeignIndirectCall'),
  )
  const foreignCallShapes = program.functions
    .flatMap((fn) => MirVerification.operations(fn))
    .filter((operation) => operation._tag === 'ForeignCall')
  if (
    request.support &&
    (needsAllocation ||
      frameRuntimeEnabled ||
      program.foreignCalls.length !== 0 ||
      program.foreignStatics.length !== 0 ||
      indirectCalls.length !== 0 ||
      program.functions.some((fn) => fn.machine !== undefined))
  )
    return yield* new BackendError({
      operation: 'Backend.emit',
      backend: 'LLVM',
      message:
        'Support objects require source-only, runtime-free bodies without an entry or foreign calls',
      reason: { _tag: 'UnsupportedMir', detail: 'Invalid support compilation' },
    })
  const foreignGuard =
    request.support ||
    (program.foreignCalls.length === 0 &&
      program.foreignExports.length === 0 &&
      indirectCalls.length === 0)
      ? undefined
      : yield* Emitter.module(builder, (builder) => NativeForeignGuard.make(builder))
  const foreignIndirects = yield* declareForeignIndirects(
    builder,
    indirectCalls,
    cType,
    foreignGuard,
  )
  const { foreignFunctions, declaredForeign } = yield* declareForeignFunctions(
    builder,
    program,
    foreignCallShapes,
    cType,
    foreignGuard,
  )
  const { foreignStatics, staticDeclarations } = yield* declareForeignStatics(
    builder,
    program,
    cType,
  )
  return {
    cType,
    foreignGuard,
    foreignIndirects,
    foreignFunctions,
    declaredForeign,
    foreignStatics,
    staticDeclarations,
  }
})

const retainRoots = Effect.fn('NativeProgram.retainRoots')(function* (
  builder: Builder.Builder,
  program: Mir.Module,
  declared: ReadonlyArray<NativeLoweringContext.DeclaredFunction>,
) {
  const retained: Array<Constant.Constant> = []
  for (const root of program.retainedRoots ?? []) {
    const declaration = declared.find((candidate) => Mir.matchesInstanceKey(candidate.fn, root))
    if (declaration === undefined)
      return yield* new BackendError({
        operation: 'Backend.emit',
        backend: 'LLVM',
        message: 'Retained root has no emitted definition',
        reason: {
          _tag: 'UnsupportedMir',
          detail: `Missing retained root ${root.declaration.module}.${root.declaration.name}`,
        },
      })
    retained.push(
      yield* Constant.fromGlobal(
        builder,
        yield* FunctionActor.global(builder, declaration.driver ?? declaration.handle),
      ),
    )
  }
  if (retained.length > 0) {
    const array = yield* LlvmType.array(builder, yield* LlvmType.pointer(builder), retained.length)
    yield* Variable.make(builder, 'llvm.used', array, {
      initializer: yield* Constant.aggregate(builder, array, retained),
      linkage: 'appending',
      section: ByteString.fromString('llvm.metadata'),
    })
  }
})

const declareExports = Effect.fn('NativeProgram.declareExports')(function* (
  builder: Builder.Builder,
  program: Mir.Module,
  request: CodegenRequest,
  declared: ReadonlyArray<NativeLoweringContext.DeclaredFunction>,
  cType: CType,
  foreignGuard: NativeForeignGuard.NativeForeignGuard | undefined,
) {
  const exportThunks = yield* NativeDeclare.exportThunks({
    builder,
    program,
    declared,
    cType,
    foreignGuard,
    support: request.support === true,
  })
  const foreignCallbacks = new Map<string, Constant.Constant>()
  for (const [symbol, thunk] of exportThunks)
    foreignCallbacks.set(
      symbol,
      yield* Constant.fromGlobal(builder, yield* FunctionActor.global(builder, thunk)),
    )
  return foreignCallbacks
})

const declareSuspensionThunks = Effect.fn('NativeProgram.declareSuspensionThunks')(function* (
  builder: Builder.Builder,
  program: Mir.Module,
  declared: ReadonlyArray<NativeLoweringContext.DeclaredFunction>,
  types: ProgramTypes,
  suspensionEnabled: boolean,
) {
  const { i32, pointer } = types
  const childThunkType = suspensionEnabled
    ? yield* LlvmType.functionType(builder, i32, [pointer])
    : undefined
  const resumeThunkType = suspensionEnabled
    ? yield* LlvmType.functionType(builder, i32, [pointer, pointer])
    : undefined
  const originThunks = new Map<
    string,
    {
      readonly handle: FunctionActor.Function
      readonly region: Mir.SuspendEffectRegion
      readonly owner: (typeof declared)[number]
    }
  >()
  const resumeThunks = new Map<
    string,
    {
      readonly handle: FunctionActor.Function
      readonly region: Mir.RunSuspendableEffectRegion
      readonly owner: (typeof declared)[number]
      readonly frame: Mir.CoroutineFrameTargetLayout
      readonly layout: Mir.CoroutineFrameTargetStateLayout
    }
  >()
  for (const owner of declared) {
    for (const region of owner.fn.suspension?.regions ?? []) {
      const key = suspensionPointKey(region.point)
      const suffix = `${sanitize(Instances.keyText(region.point.owner))}_${sanitize(region.point.sourceId)}_${region.point.spanStart}_${region.point.ordinal}`
      if (region._tag === 'SuspendEffectRegion') {
        if (childThunkType === undefined) throw new RangeError('LLVM origin lost thunk type')
        originThunks.set(key, {
          owner,
          region,
          handle: yield* FunctionActor.declare(
            builder,
            `silk_suspend_child_${suffix}`,
            childThunkType,
            { visibility: 'hidden' },
          ),
        })
        continue
      }
      const descriptor = region.relay.state
      if (descriptor === undefined) continue
      const frame = program.coroutineFrames?.entries.find(
        (candidate) =>
          Instances.keyText(candidate.function) === Instances.keyText(owner.fn.instance),
      )
      const layout = CoroutineFrame.stateLayout(program, region.point)
      if (frame === undefined || layout === undefined || resumeThunkType === undefined)
        throw new RangeError('LLVM coroutine frame lost its physical layout or thunk type')
      resumeThunks.set(key, {
        owner,
        region,
        frame,
        layout,
        handle: yield* FunctionActor.declare(
          builder,
          `silk_suspend_resume_${suffix}`,
          resumeThunkType,
          { visibility: 'hidden' },
        ),
      })
    }
  }
  return { childThunkType, resumeThunkType, originThunks, resumeThunks }
})

const initializeDebugInfo = Effect.fn('NativeProgram.initializeDebugInfo')(function* (
  builder: Builder.Builder,
  program: Mir.Module,
  request: CodegenRequest,
) {
  const debug = request.mode === 'debug'
  let compileUnit: LlvmMetadata.Optional
  let file: LlvmMetadata.Optional
  const table = lineTable(request.sources?.get(program.module))
  if (debug) {
    const fileName = yield* LlvmMetadata.string(builder, program.module)
    file = yield* LlvmMetadata.file(builder, fileName)
    const producer = yield* LlvmMetadata.string(builder, 'silk-effect bootstrap')
    compileUnit = yield* LlvmMetadata.compileUnit(builder, file, producer, {})
    if (compileUnit !== undefined) {
      yield* LlvmMetadata.named(builder, 'llvm.dbg.cu', [compileUnit])
    }
  }

  const debugTypes = new Map<string, LlvmMetadata.Optional>()
  const debugContext: NativeDebug.LoweringContext = {
    builder,
    program,
    enabled: debug,
    file,
    types: debugTypes,
  }
  return { debug, compileUnit, file, table, debugContext }
})

const verifyModule = Effect.fn('NativeProgram.verifyModule')(function* (
  builder: Builder.Builder,
  program: Mir.Module,
) {
  // The module is verified before it is encoded: what reaches Clang has already been checked
  // for the SSA invariants Clang itself will not check on `-x ir` input.
  const violations = yield* Verify.verify(builder)
  if (violations.length > 0) {
    return yield* new BackendError({
      operation: 'Backend.emit',
      backend: 'LLVM',
      message: `LLVM emitted an invalid module for ${program.module} (${violations.length} violation(s)):\n${formatModuleViolations(violations)}`,
      reason: { _tag: 'InvalidModule', violations },
    })
  }
})

const encodeArtifact = Effect.fn('NativeProgram.encodeArtifact')(function* ({
  builder,
  program,
  declared,
  malloc,
  free,
  runtimeFeatures,
  declaredForeign,
  staticDeclarations,
}: {
  readonly builder: Builder.Builder
  readonly program: Mir.Module
  readonly declared: ReadonlyArray<NativeLoweringContext.DeclaredFunction>
  readonly malloc: FunctionActor.Function | undefined
  readonly free: FunctionActor.Function | undefined
  readonly runtimeFeatures: ReadonlySet<RuntimeFeature>
  readonly declaredForeign: ReadonlyMap<string, CAbi.CAbiSignature>
  readonly staticDeclarations: Array<Mir.Module['foreignStatics'][number]>
}) {
  const context = yield* Effect.context<never>()

  return {
    symbols: declared.map((entry) => ({
      declaration: entry.fn.id,
      instance: entry.fn.instance,
      symbol: entry.publicSymbol,
    })),
    nativeRuntimeSymbols: [
      // LLVM may fold allocation followed by zero initialization into calloc.
      ...(malloc === undefined ? [] : ['malloc', 'calloc']),
      ...(free === undefined ? [] : ['free']),
    ],
    runtimeFeatures: [...runtimeFeatures].sort(),
    foreignImports: [...declaredForeign]
      .sort(([left], [right]) => left.localeCompare(right, 'en'))
      .map(([symbol, foreign]) => ({
        symbol,
        variadic: foreign.variadic,
        parameters: foreign.parameters.map(CAbi.typeText),
        result: CAbi.typeText(foreign.result),
        contract: foreign.contract,
      })),
    foreignExports: [...program.foreignExports]
      .sort((left, right) => left.symbol.localeCompare(right.symbol, 'en'))
      .map((record) => ({
        symbol: record.symbol,
        variadic: record.signature.variadic,
        parameters: record.signature.parameters.map(CAbi.typeText),
        result: CAbi.typeText(record.signature.result),
        contract: record.signature.contract,
      })),
    foreignStatics: staticDeclarations
      .sort(
        (left, right) =>
          left.symbol.localeCompare(right.symbol, 'en') ||
          left.direction.localeCompare(right.direction, 'en'),
      )
      .map((record) => ({
        symbol: record.symbol,
        type: CAbi.typeText(CAbi.classify(record.type, program.layout.target, 'Parameter')),
        direction: record.direction,
      })),
    renderIr: () => Effect.runSyncWith(context)(IrText.render(builder)),
    bitcode: yield* encodeBitcode(builder),
  }
})

const encodeBitcode = Effect.fn('NativeProgram.encodeBitcode')(function* (
  builder: Builder.Builder,
) {
  return yield* Bitcode.encode(builder)
})
