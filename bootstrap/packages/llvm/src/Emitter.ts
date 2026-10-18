import * as Effect from 'effect/Effect'
import * as Result from 'effect/Result'
import * as AddrSpace from './AddrSpace.js'
import * as Alignment from './Alignment.js'
import * as Attribute from './Attribute.js'
import type * as Block from './Block.js'
import type * as Builder from './Builder.js'
import * as Constant from './Constant.js'
import * as FunctionActor from './Function.js'
import * as Aggregate from './FunctionBody/Aggregate.js'
import * as Binary from './FunctionBody/Binary.js'
import * as Call from './FunctionBody/Call.js'
import * as Cast from './FunctionBody/Cast.js'
import * as Introspection from './FunctionBody/Introspection.js'
import * as Memory from './FunctionBody/Memory.js'
import * as BodyMetadata from './FunctionBody/Metadata.js'
import * as Phi from './FunctionBody/Phi.js'
import * as Terminator from './FunctionBody/Terminator.js'
import * as Unary from './FunctionBody/Unary.js'
import * as BuilderState from './internal/BuilderState.js'
import * as FunctionBodyState from './internal/FunctionBodyState.js'
import * as Intrinsic from './Intrinsic.js'
import { invalidInput, invalidState, type LlvmError } from './LlvmError.js'
import * as Metadata from './Metadata.js'
import * as Type from './Type.js'
import * as Variable from './Variable.js'

/**
 * Synchronous emission sessions over one builder.
 *
 * **Details**
 *
 * Native code generation issues one builder operation per emitted instruction, operand constant,
 * and block. Running each as its own Effect made the fiber run loop, generator frames, and their
 * allocations the largest cost of the self-hosted compiler's LLVM emission. A session runs a whole
 * emission as plain synchronous code: each operation validates and mutates exactly like its
 * effectful counterpart, sharing one transition implementation, and aborts the session on the
 * first `LlvmError`. {@link module} is the single typed boundary that turns an abort into the
 * effect's failure; defects stay defects.
 *
 * **Gotchas**
 *
 * A session is valid only while its callback runs. Operations on a closed session, or on a body
 * after its build finished, abort with an invalid-state error.
 *
 * @category emitter
 * @since 0.0.0
 */
export interface Module {
  readonly [ModuleTypeId]: typeof ModuleTypeId
}

/**
 * A synchronous session that is also building one function body.
 *
 * @category emitter
 * @since 0.0.0
 */
export interface Body extends Module {
  readonly [BodyTypeId]: typeof BodyTypeId
}

const ModuleTypeId: unique symbol = Symbol.for('@silklang/llvm/Emitter/Module')
const BodyTypeId: unique symbol = Symbol.for('@silklang/llvm/Emitter/Body')

class ModuleSession implements Module {
  readonly [ModuleTypeId]: typeof ModuleTypeId = ModuleTypeId
  open = true
  constructor(readonly context: BuilderState.Context) {}
}

class BodySession extends ModuleSession implements Body {
  readonly [BodyTypeId]: typeof BodyTypeId = BodyTypeId
  constructor(
    context: BuilderState.Context,
    readonly draft: FunctionBodyState.Draft,
  ) {
    super(context)
  }
}

/** The private, non-yieldable abort token; only {@link module} catches it. */
class Abort {
  constructor(readonly error: LlvmError) {}
}

const unwrap = <A>(result: Result.Result<A, LlvmError>): A => {
  if (Result.isFailure(result)) throw new Abort(result.failure)
  return result.success
}

const closed = (self: unknown): Abort =>
  new Abort(
    invalidState({ operation: 'Emitter', message: 'The emitter session is closed', state: self }),
  )

const contextOf = (self: Module): BuilderState.Context => {
  if (self instanceof ModuleSession && self.open) return self.context
  throw closed(self)
}

const draftOf = (self: Body): FunctionBodyState.Draft => {
  if (self instanceof BodySession && self.open) return self.draft
  throw closed(self)
}

const moduleOp =
  <Args extends ReadonlyArray<unknown>, A>(
    transition: (context: BuilderState.Context, ...args: Args) => Result.Result<A, LlvmError>,
  ) =>
  (self: Module, ...args: Args): A =>
    unwrap(transition(contextOf(self), ...args))

const bodyOp =
  <Args extends ReadonlyArray<unknown>, A>(
    transition: (draft: FunctionBodyState.Draft, ...args: Args) => Result.Result<A, LlvmError>,
  ) =>
  (self: Body, ...args: Args): A =>
    unwrap(transition(draftOf(self), ...args))

/**
 * Runs a synchronous emission session over a builder, failing with the first `LlvmError`.
 *
 * @category emitter
 * @since 0.0.0
 */
export const module = <A>(
  builder: Builder.Builder,
  emit: (session: Module) => A,
): Effect.Effect<A, LlvmError> =>
  Effect.suspend(() => {
    const context = BuilderState.context(builder, 'Emitter.module')
    if (Result.isFailure(context)) return Effect.fail(context.failure)
    const session = new ModuleSession(context.success)
    // The session is plain synchronous code, so this is its one abort-translation point.
    try {
      return Effect.succeed(emit(session))
    } catch (cause) {
      if (cause instanceof Abort) return Effect.fail(cause.error)
      throw cause
    } finally {
      session.open = false
    }
  })

/**
 * Builds, validates, and commits one function body synchronously inside a session.
 *
 * **Details**
 *
 * This is the synchronous counterpart of `Function.buildBody` and shares its reservation,
 * validation, and commit transitions. On any abort or defect the draft is discarded, the
 * reservation is released, and the function remains a declaration.
 *
 * @category emitter
 * @since 0.0.0
 */
export const buildBody = <A>(
  self: Module,
  target: FunctionActor.Function,
  emit: (body: Body) => A,
): A => {
  const context = contextOf(self)
  const build = unwrap(FunctionActor.beginBody(context, target))
  // Synchronous acquire/release: the reservation is released on every exit, including aborts.
  try {
    const draft = FunctionBodyState.makeDraft(
      context,
      build.functionIndex,
      build.type,
      build.signature,
      -1,
    )
    const body = new BodySession(context, draft)
    try {
      const value = emit(body)
      const snapshot = unwrap(FunctionBodyState.validateDraft(draft, target))
      unwrap(FunctionActor.commitBody(context, build, target, snapshot))
      draft.status = 'committed'
      return value
    } catch (cause) {
      draft.status = 'failed'
      throw cause
    } finally {
      body.open = false
    }
  } finally {
    FunctionActor.releaseBody(context, build)
  }
}

// Types

/** @category types @since 0.0.0 */
export const integerType = moduleOp((context, bitWidth: number) =>
  !Number.isSafeInteger(bitWidth) || bitWidth < 1 || bitWidth > 0xff_ffff
    ? Result.fail(
        invalidInput({
          operation: 'Type.integer',
          message: 'LLVM integer width must be from 1 through 16777215 bits',
          input: bitWidth,
        }),
      )
    : Type.internIn(context, { _tag: 'Integer', bitWidth }),
)

/** @category types @since 0.0.0 */
export const pointerType = moduleOp(
  (context, addressSpace: AddrSpace.AddrSpace = AddrSpace.defaultAddrSpace) =>
    Type.internIn(context, { _tag: 'Pointer', addressSpace }),
)

/** @category types @since 0.0.0 */
export const voidType = moduleOp((context) =>
  Type.internIn(context, { _tag: 'Simple', tag: 'Void' }),
)

/** @category types @since 0.0.0 */
export const floatType = moduleOp((context) =>
  Type.internIn(context, { _tag: 'Simple', tag: 'Float' }),
)

/** @category types @since 0.0.0 */
export const doubleType = moduleOp((context) =>
  Type.internIn(context, { _tag: 'Simple', tag: 'Double' }),
)

/** @category types @since 0.0.0 */
export const functionType = moduleOp(Type.functionTypeIn)

/** @category types @since 0.0.0 */
export const structureType = moduleOp(Type.structureIn)

/** @category types @since 0.0.0 */
export const arrayType = moduleOp(Type.arrayIn)

// Constants

/** @category constants @since 0.0.0 */
export const integerUnsigned = moduleOp((context, type: Type.Type, value: number | bigint) =>
  Constant.integerOfIn(context, type, value, false),
)

/** @category constants @since 0.0.0 */
export const integerSigned = moduleOp((context, type: Type.Type, value: number | bigint) =>
  Constant.integerOfIn(context, type, value, true),
)

/** @category constants @since 0.0.0 */
export const nullValue = moduleOp((context, type: Type.Type) =>
  Constant.specialIn(context, type, 'null'),
)

/** @category constants @since 0.0.0 */
export const fromGlobal = moduleOp(Constant.fromGlobalIn)

/** @category constants @since 0.0.0 */
export const constantString = moduleOp(Constant.stringIn)

/** @category constants @since 0.0.0 */
export const floatingRaw = moduleOp(Constant.floatingRawIn)

/** @category constants @since 0.0.0 */
export const floatFromNumber = moduleOp((context, type: Type.Type, value: number) =>
  Constant.floatingRawIn(context, type, 'float', Constant.numberBytes(value, 4)),
)

/** @category constants @since 0.0.0 */
export const doubleFromNumber = moduleOp((context, type: Type.Type, value: number) =>
  Constant.floatingRawIn(context, type, 'double', Constant.numberBytes(value, 8)),
)

/** @category constants @since 0.0.0 */
export const constantAggregate = moduleOp(Constant.aggregateIn)

/**
 * Validates a power-of-two byte alignment inside a session. It reads no builder state, but like
 * every emitter operation an invalid value aborts the enclosing session.
 *
 * @category constants
 * @since 0.0.0
 */
export const alignment = (self: Module, byteUnits: number | bigint): Alignment.Alignment => {
  contextOf(self)
  return unwrap(Alignment.fromByteUnitsResult(byteUnits))
}

// Attributes

/** @category attributes @since 0.0.0 */
export const flagAttribute = moduleOp(Attribute.flagIn)

/** @category attributes @since 0.0.0 */
export const integerAttribute = moduleOp(Attribute.integerIn)

/** @category attributes @since 0.0.0 */
export const attributeSet = moduleOp(Attribute.setIn)

/** @category attributes @since 0.0.0 */
export const attributeEntries = moduleOp(Attribute.entriesIn)

/** @category attributes @since 0.0.0 */
export const functionAttributes = moduleOp(Attribute.functionSetIn)

/** @category attributes @since 0.0.0 */
export const functionAttributeEntries = moduleOp(Attribute.functionSetEntriesIn)

// Globals

/** @category globals @since 0.0.0 */
export const declareFunction = moduleOp(FunctionActor.declareIn)

/** @category globals @since 0.0.0 */
export const functionGlobal = moduleOp(FunctionActor.globalIn)

/** @category globals @since 0.0.0 */
export const functionProperties = moduleOp(FunctionActor.propertiesIn)

/** @category globals @since 0.0.0 */
export const variable = moduleOp(Variable.makeIn)

/** @category globals @since 0.0.0 */
export const variableGlobal = moduleOp(Variable.globalIn)

// Metadata

/** @category metadata @since 0.0.0 */
export const location = moduleOp(Metadata.locationIn)

// Blocks and values

/** @category blocks @since 0.0.0 */
export const block = bodyOp(
  (
    draft,
    name?: Parameters<typeof FunctionBodyState.makeBlock>[1],
  ): Result.Result<Block.Block, LlvmError> =>
    Result.succeed(FunctionBodyState.makeBlock(draft, name)),
)

/** @category blocks @since 0.0.0 */
export const setInsertionPoint = bodyOp(FunctionBodyState.setCursor)

/** @category values @since 0.0.0 */
export const argument = bodyOp(FunctionBodyState.argument)

/** @category values @since 0.0.0 */
export const valueInstruction = bodyOp(FunctionBodyState.valueInstruction)

/** @category values @since 0.0.0 */
export const inputType = bodyOp(Introspection.inputTypeIn)

// Instructions

/** @category instructions @since 0.0.0 */
export const binary = bodyOp(Binary.binaryIn)

/** @category instructions @since 0.0.0 */
export const integerCompare = bodyOp(Binary.integerCompareIn)

/** @category instructions @since 0.0.0 */
export const floatingCompare = bodyOp(Binary.floatingCompareIn)

/** @category instructions @since 0.0.0 */
export const select = bodyOp(Binary.selectIn)

/** @category instructions @since 0.0.0 */
export const cast = bodyOp(Cast.castIn)

/** @category instructions @since 0.0.0 */
export const unary = bodyOp(Unary.unaryIn)

/** @category instructions @since 0.0.0 */
export const freeze = bodyOp(Unary.freezeIn)

/** @category instructions @since 0.0.0 */
export const alloca = bodyOp(Memory.allocaIn)

/** @category instructions @since 0.0.0 */
export const load = bodyOp(Memory.loadIn)

/** @category instructions @since 0.0.0 */
export const store = bodyOp(Memory.storeIn)

/** @category instructions @since 0.0.0 */
export const getElementPtr = bodyOp(Memory.getElementPtrIn)

/** @category instructions @since 0.0.0 */
export const structuredGetElementPtr = bodyOp(Memory.structuredGetElementPtrIn)

/** @category instructions @since 0.0.0 */
export const extractValue = bodyOp(Aggregate.extractValueIn)

/** @category instructions @since 0.0.0 */
export const insertValue = bodyOp(Aggregate.insertValueIn)

/** @category instructions @since 0.0.0 */
export const buildAggregate = bodyOp(Aggregate.buildAggregateIn)

/** @category instructions @since 0.0.0 */
export const call = bodyOp(
  (
    draft,
    functionType: Type.Type,
    callee: Parameters<typeof Call.callIn>[2],
    args: Parameters<typeof Call.callIn>[3],
    name?: Parameters<typeof Call.callIn>[4],
    options: Call.CallOptions = {},
  ) => Call.callIn(draft, functionType, callee, args, name, options),
)

/** @category instructions @since 0.0.0 */
export const callDirect = bodyOp(Call.callDirectIn)

/** @category instructions @since 0.0.0 */
export const callAssembly = bodyOp(Call.callAssemblyIn)

/** @category instructions @since 0.0.0 */
export const invoke = bodyOp(
  (
    draft,
    functionType: Type.Type,
    callee: Parameters<typeof Call.callIn>[2],
    args: Parameters<typeof Call.callIn>[3],
    normal: Block.Block,
    unwind: Block.Block,
    name?: Parameters<typeof Call.callIn>[4],
    options: Omit<Call.CallOptions, 'tail' | 'fastMath'> = {},
  ) => Call.callIn(draft, functionType, callee, args, name, options, { normal, unwind }),
)

/** @category instructions @since 0.0.0 */
export const branch = bodyOp(Terminator.branchIn)

/** @category instructions @since 0.0.0 */
export const conditionalBranch = bodyOp(Terminator.conditionalBranchIn)

/** @category instructions @since 0.0.0 */
export const switchTerminator = bodyOp(Terminator.switchTerminatorIn)

/** @category instructions @since 0.0.0 */
export const addSwitchCase = bodyOp(Terminator.addSwitchCaseIn)

/** @category instructions @since 0.0.0 */
export const sealSwitch = bodyOp(Terminator.sealSwitchIn)

/** @category instructions @since 0.0.0 */
export const returnValue = bodyOp(Terminator.returnValueIn)

/** @category instructions @since 0.0.0 */
export const returnVoid = bodyOp(Terminator.returnVoidIn)

/** @category instructions @since 0.0.0 */
export const unreachable = bodyOp(Terminator.unreachableIn)

/** @category instructions @since 0.0.0 */
export const cleanupLandingPad = bodyOp(Terminator.cleanupLandingPadIn)

/** @category instructions @since 0.0.0 */
export const phi = bodyOp(Phi.phiIn)

/** @category instructions @since 0.0.0 */
export const phiValue = bodyOp(Phi.phiValueIn)

/** @category instructions @since 0.0.0 */
export const addPhiIncoming = bodyOp(Phi.addPhiIncomingIn)

/** @category instructions @since 0.0.0 */
export const sealPhi = bodyOp(Phi.sealPhiIn)

/** @category instructions @since 0.0.0 */
export const setDebugLocation = bodyOp(BodyMetadata.setDebugLocationIn)

// Intrinsics

/** @category intrinsics @since 0.0.0 */
export const intrinsicCall = bodyOp(Intrinsic.callIn)

/** @category intrinsics @since 0.0.0 */
export const memcpy = bodyOp(Intrinsic.memcpyIn)

/** @category intrinsics @since 0.0.0 */
export const memmove = bodyOp(Intrinsic.memmoveIn)

/** @category intrinsics @since 0.0.0 */
export const memset = bodyOp(Intrinsic.memsetIn)
