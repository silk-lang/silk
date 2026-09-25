import * as Effect from 'effect/Effect'
import * as Result from 'effect/Result'
import type * as Block from '../Block.js'
import type * as Attribute from '../Attribute.js'
import type * as Builder from '../Builder.js'
import * as ByteString from '../ByteString.js'
import * as Constant from '../Constant.js'
import * as FastMathActor from '../FastMath.js'
import * as FunctionActor from '../Function.js'
import type * as FunctionBodyDescription from '../internal/FunctionBodyDescription.js'
import type * as BuilderState from '../internal/BuilderState.js'
import * as FunctionBodyState from '../internal/FunctionBodyState.js'
import * as GlobalState from '../internal/GlobalState.js'
import * as Handle from '../internal/Handle.js'
import type * as OwnedHandle from '../internal/OwnedHandle.js'
import { invalidInput, invalidState, type LlvmError } from '../LlvmError.js'
import type * as Type from '../Type.js'
import type * as Value from '../Value.js'
import { type FastMathInput, type FunctionBody, fastMath } from './_internal.js'

/**
 * Tail-call marker accepted by call operations.
 *
 * @category instructions
 * @since 0.0.0
 */
export type TailKind = FunctionBodyDescription.TailKind

/**
 * Calling convention, attributes, tail marker, fast-math, and operand bundles for a call.
 *
 * @category instructions
 * @since 0.0.0
 */
export interface CallOptions {
  readonly callingConvention?: number
  readonly attributes?: Attribute.FunctionSet
  readonly tail?: TailKind
  readonly fastMath?: FastMathInput
  readonly operandBundles?: ReadonlyArray<{
    readonly tag: ByteString.ByteString | Uint8Array | string
    readonly operands: ReadonlyArray<Value.Input>
  }>
}

/** @internal */
/**
 * Validates and appends a call or invoke inside one body transition. Calls are among the most
 * frequent emitted instructions, so this is plain synchronous code rather than a generator.
 *
 * @internal
 */
const callTransition = (
  draft: FunctionBodyState.Draft,
  module: BuilderState.MutableState,
  functionTypeIndex: number,
  functionType: unknown,
  callee: Value.Input,
  args: ReadonlyArray<Value.Input>,
  name: ByteString.ByteString | Uint8Array | string | undefined,
  options: CallOptions,
  destinations?: { readonly normal: Block.Block; readonly unwind: Block.Block },
): Result.Result<Value.Value | undefined, LlvmError> => {
  const operation = 'FunctionBody.call'
  const signatureResult = FunctionBodyState.typeAt(module, functionTypeIndex, operation)
  if (Result.isFailure(signatureResult)) return Result.fail(signatureResult.failure)
  const signature = signatureResult.success
  if (signature._tag !== 'Function') {
    return Result.fail(
      invalidInput({ operation, message: 'Calls require a function type', input: functionType }),
    )
  }
  const calleeValue = FunctionBodyState.resolveOperand(draft, module, callee, operation)
  if (Result.isFailure(calleeValue)) return Result.fail(calleeValue.failure)
  const calleeOperand = calleeValue.success.operand
  const calleeConstant =
    calleeOperand._tag === 'Constant'
      ? module.constants.descriptions[calleeOperand.constant]
      : undefined
  const inlineAssembly =
    calleeConstant?._tag === 'Assembly' && calleeValue.success.type === functionTypeIndex
  if (!inlineAssembly) {
    const isPointer = FunctionBodyState.isPointerType(module, calleeValue.success.type, operation)
    if (Result.isFailure(isPointer)) return Result.fail(isPointer.failure)
    if (!isPointer.success) {
      return Result.fail(
        invalidInput({ operation, message: 'Call callee must have pointer type', input: callee }),
      )
    }
  }
  if (
    (!signature.variadic && args.length !== signature.parameters.length) ||
    args.length < signature.parameters.length
  ) {
    return Result.fail(
      invalidInput({
        operation,
        message: `Call${name === undefined ? '' : ` ${ByteString.escapeForIr(ByteString.coerce(name))}`} argument count does not match the function signature (${args.length} supplied, ${signature.parameters.length} ${signature.variadic ? 'minimum' : 'expected'})`,
        input: args,
      }),
    )
  }
  const argumentsResolved: Array<FunctionBodyDescription.Operand> = []
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === undefined) continue
    const resolved = FunctionBodyState.resolveOperand(draft, module, argument, operation)
    if (Result.isFailure(resolved)) return Result.fail(resolved.failure)
    const expected = signature.parameters[index]
    if (expected !== undefined && expected !== resolved.success.type) {
      const actualDescription = module.types.descriptions[resolved.success.type]
      const expectedDescription = module.types.descriptions[expected]
      return Result.fail(
        invalidInput({
          operation,
          message: `Call${name === undefined ? '' : ` ${ByteString.escapeForIr(ByteString.coerce(name))}`} argument ${index} type does not match its parameter (${actualDescription?._tag ?? resolved.success.type} !== ${expectedDescription?._tag ?? expected})`,
          input: {
            index,
            argument,
            actualType: resolved.success.type,
            expectedType: expected,
          },
        }),
      )
    }
    argumentsResolved.push(resolved.success.operand)
  }
  const callingConvention = options.callingConvention ?? 0
  if (
    !Number.isSafeInteger(callingConvention) ||
    callingConvention < 0 ||
    callingConvention > 1023
  ) {
    return Result.fail(
      invalidInput({
        operation,
        message: 'Calling convention must be an unsigned 10-bit integer',
        input: callingConvention,
      }),
    )
  }
  let attributes: number | undefined
  if (options.attributes !== undefined) {
    const resolved = Handle.resolve(
      draft.builder,
      draft.moduleOwner,
      options.attributes,
      'FunctionAttributeSet',
      operation,
    )
    if (Result.isFailure(resolved)) return Result.fail(resolved.failure)
    attributes = resolved.success
  }
  const bundles: Array<FunctionBodyDescription.OperandBundle> = []
  for (const bundle of options.operandBundles ?? []) {
    const operands: Array<FunctionBodyDescription.Operand> = []
    for (const operand of bundle.operands) {
      const resolved = FunctionBodyState.resolveOperand(draft, module, operand, operation)
      if (Result.isFailure(resolved)) return Result.fail(resolved.failure)
      operands.push(resolved.success.operand)
    }
    bundles.push({ tag: ByteString.coerce(bundle.tag), operands })
  }
  const returnType = FunctionBodyState.typeAt(module, signature.returnType, operation)
  if (Result.isFailure(returnType)) return Result.fail(returnType.failure)
  const callFastMath = fastMath(options.fastMath)
  if (FastMathActor.toBitcode(callFastMath) !== 0) {
    const floating = FunctionBodyState.isFloatingType(module, signature.returnType, operation)
    if (Result.isFailure(floating)) return Result.fail(floating.failure)
    if (!floating.success) {
      return Result.fail(
        invalidInput({
          operation,
          message: 'Fast-math call requires a floating-point return type',
          input: functionType,
        }),
      )
    }
  }
  if (options.tail === 'musttail' && functionTypeIndex !== draft.functionType) {
    return Result.fail(
      invalidInput({
        operation,
        message: 'musttail requires the caller and callee to have the same function type',
        input: functionType,
      }),
    )
  }
  let normal: number | undefined
  let unwind: number | undefined
  if (destinations !== undefined) {
    const resolvedNormal = FunctionBodyState.resolveBlock(
      draft,
      destinations.normal,
      'FunctionBody.invoke',
    )
    if (Result.isFailure(resolvedNormal)) return Result.fail(resolvedNormal.failure)
    const resolvedUnwind = FunctionBodyState.resolveBlock(
      draft,
      destinations.unwind,
      'FunctionBody.invoke',
    )
    if (Result.isFailure(resolvedUnwind)) return Result.fail(resolvedUnwind.failure)
    normal = resolvedNormal.success
    unwind = resolvedUnwind.success
    if (
      options.tail !== undefined ||
      inlineAssembly ||
      FastMathActor.toBitcode(callFastMath) !== 0
    ) {
      return Result.fail(
        invalidInput({
          operation: 'FunctionBody.invoke',
          message: 'Invoke does not admit tail markers, inline assembly, or fast-math flags',
          input: options,
        }),
      )
    }
  }
  const makeInstruction = (
    result: number | undefined,
    finalName: ByteString.ByteString,
  ): FunctionBodyDescription.Instruction =>
    normal === undefined || unwind === undefined
      ? {
          _tag: 'Call',
          functionType: functionTypeIndex,
          callee: calleeOperand,
          arguments: argumentsResolved,
          callingConvention,
          attributes,
          fastMath: callFastMath,
          operandBundles: bundles,
          result,
          name: finalName,
          tail: options.tail ?? 'none',
        }
      : {
          _tag: 'Invoke',
          functionType: functionTypeIndex,
          callee: calleeOperand,
          arguments: argumentsResolved,
          callingConvention,
          attributes,
          fastMath: callFastMath,
          operandBundles: bundles,
          result,
          name: finalName,
          normal,
          unwind,
        }
  const predecessor = draft.cursor
  let value: Value.Value | undefined
  if (returnType.success._tag === 'Simple' && returnType.success.tag === 'Void') {
    const appended = FunctionBodyState.appendInstruction(
      draft,
      makeInstruction(undefined, ByteString.empty),
    )
    if (Result.isFailure(appended)) return Result.fail(appended.failure)
  } else {
    const appended = FunctionBodyState.appendResult(
      draft,
      signature.returnType,
      name,
      makeInstruction,
    )
    if (Result.isFailure(appended)) return Result.fail(appended.failure)
    value = appended.success
  }
  if (normal !== undefined && unwind !== undefined && predecessor !== undefined) {
    const addedNormal = FunctionBodyState.addPredecessor(draft, normal, predecessor)
    if (Result.isFailure(addedNormal)) return Result.fail(addedNormal.failure)
    const addedUnwind = FunctionBodyState.addPredecessor(draft, unwind, predecessor)
    if (Result.isFailure(addedUnwind)) return Result.fail(addedUnwind.failure)
  }
  return Result.succeed(value)
}

/**
 * Mirrors `Function.properties`, `Function.global`, and `Constant.fromGlobal` inside the call's
 * own transition.
 *
 * @internal
 */
const directCallee = (
  builder: Builder.Builder,
  module: BuilderState.MutableState,
  owner: OwnedHandle.Owner,
  target: FunctionActor.Function,
): Result.Result<
  {
    readonly typeIndex: number
    readonly type: Type.Type
    readonly callingConvention: number
    readonly attributes: Attribute.FunctionSet | undefined
    readonly callee: Constant.Constant
  },
  LlvmError
> => {
  const index = Handle.resolve(builder, owner, target, 'Function', 'Function.properties')
  if (Result.isFailure(index)) return Result.fail(index.failure)
  const description = module.globals.functions.descriptions[index.success]
  if (description === undefined) {
    return Result.fail(
      invalidState({
        operation: 'Function.properties',
        message: 'Function table entry is missing',
        state: index.success,
      }),
    )
  }
  const type = module.types.handles[description.type]
  const attributes =
    description.attributes === undefined
      ? undefined
      : module.functionAttributeSets.handles[description.attributes]
  if (type === undefined || (description.attributes !== undefined && attributes === undefined)) {
    return Result.fail(
      invalidState({
        operation: 'Function.properties',
        message: 'Function references a missing table entry',
        state: target,
      }),
    )
  }
  const global = GlobalState.handleAt(module, description.global, 'Function.global')
  if (Result.isFailure(global)) return Result.fail(global.failure)
  const callee = Constant.fromGlobalIn({ builder, state: module, owner }, global.success)
  if (Result.isFailure(callee)) return Result.fail(callee.failure)
  return Result.succeed({
    typeIndex: description.type,
    type,
    callingConvention: description.callingConvention,
    attributes,
    callee: callee.success,
  })
}

/** @internal */
const callInternal = (
  self: FunctionBody,
  functionType: Type.Type,
  callee: Value.Input,
  args: ReadonlyArray<Value.Input>,
  name: ByteString.ByteString | Uint8Array | string | undefined,
  options: CallOptions,
  destinations?: { readonly normal: Block.Block; readonly unwind: Block.Block },
): Effect.Effect<Value.Value | undefined, LlvmError> =>
  FunctionBodyState.mutate(self, 'FunctionBody.call', (draft) =>
    callIn(draft, functionType, callee, args, name, options, destinations),
  )

/** Calls a typed callee (or invokes it with unwind destinations) inside a body transition. @internal */
export const callIn = (
  draft: FunctionBodyState.Draft,
  functionType: Type.Type,
  callee: Value.Input,
  args: ReadonlyArray<Value.Input>,
  name: ByteString.ByteString | Uint8Array | string | undefined,
  options: CallOptions,
  destinations?: { readonly normal: Block.Block; readonly unwind: Block.Block },
): Result.Result<Value.Value | undefined, LlvmError> => {
  const functionTypeIndex = Handle.resolve(
    draft.builder,
    draft.moduleOwner,
    functionType,
    'Type',
    'FunctionBody.call',
  )
  if (Result.isFailure(functionTypeIndex)) return Result.fail(functionTypeIndex.failure)
  return callTransition(
    draft,
    draft.module,
    functionTypeIndex.success,
    functionType,
    callee,
    args,
    name,
    options,
    destinations,
  )
}

/**
 * Calls a typed callee operand with exact arity, argument types, attributes, and operand bundles.
 *
 * @category instructions
 * @since 0.0.0
 */
export const call = (
  self: FunctionBody,
  functionType: Type.Type,
  callee: Value.Input,
  args: ReadonlyArray<Value.Input>,
  name?: ByteString.ByteString | Uint8Array | string,
  options: CallOptions = {},
): Effect.Effect<Value.Value | undefined, LlvmError> =>
  callInternal(self, functionType, callee, args, name, options)

/**
 * Interns inline assembly as a constant and appends a type-checked call to it.
 *
 * @category instructions
 * @since 0.0.0
 */
export const callAssembly = (
  self: FunctionBody,
  functionType: Type.Type,
  assembly: ByteString.ByteString | Uint8Array | string,
  constraints: ByteString.ByteString | Uint8Array | string,
  args: ReadonlyArray<Value.Input>,
  name?: ByteString.ByteString | Uint8Array | string,
  assemblyOptions: Constant.AssemblyOptions = {},
  callOptions: CallOptions = {},
): Effect.Effect<Value.Value | undefined, LlvmError> =>
  FunctionBodyState.mutate(self, 'FunctionBody.callAssembly', (draft) =>
    callAssemblyIn(
      draft,
      functionType,
      assembly,
      constraints,
      args,
      name,
      assemblyOptions,
      callOptions,
    ),
  )

/** @internal */
export const callAssemblyIn = (
  draft: FunctionBodyState.Draft,
  functionType: Type.Type,
  assembly: ByteString.ByteString | Uint8Array | string,
  constraints: ByteString.ByteString | Uint8Array | string,
  args: ReadonlyArray<Value.Input>,
  name?: ByteString.ByteString | Uint8Array | string,
  assemblyOptions: Constant.AssemblyOptions = {},
  callOptions: CallOptions = {},
): Result.Result<Value.Value | undefined, LlvmError> =>
  Result.flatMap(
    Constant.assemblyIn(draft.context, functionType, assembly, constraints, assemblyOptions),
    (callee) => callIn(draft, functionType, callee, args, name, callOptions),
  )

/**
 * Calls a declared function while inheriting its signature, convention, and default attributes.
 *
 * @category instructions
 * @since 0.0.0
 */
export const callDirect = (
  self: FunctionBody,
  targetFunction: FunctionActor.Function,
  args: ReadonlyArray<Value.Input>,
  name?: ByteString.ByteString | Uint8Array | string,
  options: CallOptions = {},
): Effect.Effect<Value.Value | undefined, LlvmError> =>
  FunctionBodyState.mutate(self, 'FunctionBody.call', (draft) =>
    callDirectIn(draft, targetFunction, args, name, options),
  )

/** @internal */
export const callDirectIn = (
  draft: FunctionBodyState.Draft,
  targetFunction: FunctionActor.Function,
  args: ReadonlyArray<Value.Input>,
  name?: ByteString.ByteString | Uint8Array | string,
  options: CallOptions = {},
): Result.Result<Value.Value | undefined, LlvmError> => {
  const module = draft.module
  // Resolves the target's properties and global address constant in the same transition as
  // the call: direct calls are emitted constantly and each separate request cost a builder
  // round trip (self-hosted compiler build profile).
  const target = directCallee(draft.builder, module, draft.moduleOwner, targetFunction)
  if (Result.isFailure(target)) return Result.fail(target.failure)
  const attributes = options.attributes ?? target.success.attributes
  return callTransition(
    draft,
    module,
    target.success.typeIndex,
    target.success.type,
    target.success.callee,
    args,
    name,
    {
      ...options,
      callingConvention: options.callingConvention ?? target.success.callingConvention,
      ...(attributes === undefined ? {} : { attributes }),
    },
  )
}

/**
 * Calls a fixed-signature callee and terminates the block with normal and unwind successors.
 *
 * The unwind successor must start with a cleanup landing pad and the function must have a
 * personality. The result is available only along the normal edge.
 *
 * @category instructions
 * @since 0.0.0
 */
export const invoke = (
  self: FunctionBody,
  functionType: Type.Type,
  callee: Value.Input,
  args: ReadonlyArray<Value.Input>,
  normal: Block.Block,
  unwind: Block.Block,
  name?: ByteString.ByteString | Uint8Array | string,
  options: Omit<CallOptions, 'tail' | 'fastMath'> = {},
): Effect.Effect<Value.Value | undefined, LlvmError> =>
  callInternal(self, functionType, callee, args, name, options, { normal, unwind })
