import * as Effect from 'effect/Effect'
import * as Result from 'effect/Result'
import type * as Block from '../Block.js'
import type * as ByteString from '../ByteString.js'
import * as FastMathActor from '../FastMath.js'
import * as FunctionBodyState from '../internal/FunctionBodyState.js'
import * as Handle from '../internal/Handle.js'
import { invalidInput, invalidState, type LlvmError } from '../LlvmError.js'
import type * as Type from '../Type.js'
import type * as Value from '../Value.js'
import { type FastMathInput, type FunctionBody, fastMath } from './_internal.js'

/**
 * Two-phase identity for a phi instruction whose incoming edges are still being assembled.
 *
 * @category instructions
 * @since 0.0.0
 */
export interface Phi extends Handle.Handle<'Phi'> {}

/**
 * Starts a phi instruction whose incoming edges must be completed with {@link addPhiIncoming}.
 *
 * **Details**
 *
 * Use {@link phiValue} when later instructions need the result before the phi is sealed.
 * The final incoming block set must cover every predecessor exactly once.
 *
 * @category instructions
 * @since 0.0.0
 */
export const phi = (
  self: FunctionBody,
  type: Type.Type,
  name?: ByteString.ByteString | Uint8Array | string,
  options: { readonly fastMath?: FastMathInput } = {},
): Effect.Effect<Phi, LlvmError> =>
  FunctionBodyState.mutate(self, 'FunctionBody.phi', (draft) => phiIn(draft, type, name, options))

/** @internal */
export const phiIn = (
  draft: FunctionBodyState.Draft,
  type: Type.Type,
  name?: ByteString.ByteString | Uint8Array | string,
  options: { readonly fastMath?: FastMathInput } = {},
): Result.Result<Phi, LlvmError> => {
  const module = draft.module
  const operation = 'FunctionBody.phi'
  const typeIndex = Handle.resolve(draft.builder, draft.moduleOwner, type, 'Type', operation)
  if (Result.isFailure(typeIndex)) return Result.fail(typeIndex.failure)
  const math = fastMath(options.fastMath)
  if (FastMathActor.toBitcode(math) !== 0) {
    const floating = FunctionBodyState.isFloatingType(module, typeIndex.success, operation)
    if (Result.isFailure(floating)) return Result.fail(floating.failure)
    if (!floating.success) {
      return Result.fail(
        invalidInput({
          operation,
          message: 'Fast-math phi requires a floating-point type',
          input: type,
        }),
      )
    }
  }
  const appended = FunctionBodyState.appendResult(
    draft,
    typeIndex.success,
    name,
    (result, finalName) => ({
      _tag: 'Phi',
      type: typeIndex.success,
      incoming: [],
      fastMath: math,
      sealed: false,
      result,
      name: finalName,
    }),
  )
  if (Result.isFailure(appended)) return Result.fail(appended.failure)
  // appendResult just pushed the phi as the draft's last instruction.
  return FunctionBodyState.makePhiHandle(draft, draft.instructions.length - 1)
}

/**
 * Returns the SSA result of an open or sealed phi instruction.
 *
 * @category instructions
 * @since 0.0.0
 */
export const phiValue = (
  self: FunctionBody,
  phiHandle: Phi,
): Effect.Effect<Value.Value, LlvmError> =>
  FunctionBodyState.mutate(self, 'FunctionBody.phiValue', (draft) => phiValueIn(draft, phiHandle))

/** @internal */
export const phiValueIn = (
  draft: FunctionBodyState.Draft,
  phiHandle: Phi,
): Result.Result<Value.Value, LlvmError> => {
  return Result.gen(function* () {
    const instruction =
      draft.instructions[
        yield* FunctionBodyState.resolvePhi(draft, phiHandle, 'FunctionBody.phiValue')
      ]
    if (instruction?._tag !== 'Phi') {
      return yield* Result.fail(
        invalidState({
          operation: 'FunctionBody.phiValue',
          message: 'Phi instruction is missing',
          state: phiHandle,
        }),
      )
    }
    const value = draft.valueHandles[instruction.result]
    if (value === undefined) {
      return yield* Result.fail(
        invalidState({
          operation: 'FunctionBody.phiValue',
          message: 'Phi result value is missing',
          state: phiHandle,
        }),
      )
    }
    return value
  })
}

/**
 * Adds one same-typed value from a unique predecessor block to an open phi.
 *
 * @category instructions
 * @since 0.0.0
 */
export const addPhiIncoming = (
  self: FunctionBody,
  phiHandle: Phi,
  value: Value.Input,
  block: Block.Block,
): Effect.Effect<void, LlvmError> =>
  FunctionBodyState.mutate(self, 'FunctionBody.addPhiIncoming', (draft) =>
    addPhiIncomingIn(draft, phiHandle, value, block),
  )

/** @internal */
export const addPhiIncomingIn = (
  draft: FunctionBodyState.Draft,
  phiHandle: Phi,
  value: Value.Input,
  block: Block.Block,
): Result.Result<void, LlvmError> => {
  const module = draft.module
  const operation = 'FunctionBody.addPhiIncoming'
  const index = FunctionBodyState.resolvePhi(draft, phiHandle, operation)
  if (Result.isFailure(index)) return Result.fail(index.failure)
  const instruction = draft.instructions[index.success]
  const pending = draft.openPhis.get(index.success)
  if (instruction?._tag !== 'Phi' || instruction.sealed || pending === undefined) {
    return Result.fail(
      invalidState({ operation, message: 'Phi is missing or already sealed', state: phiHandle }),
    )
  }
  const resolved = FunctionBodyState.resolveOperand(draft, module, value, operation)
  if (Result.isFailure(resolved)) return Result.fail(resolved.failure)
  if (resolved.success.type !== instruction.type) {
    return Result.fail(
      invalidInput({ operation, message: 'Phi incoming value has the wrong type', input: value }),
    )
  }
  const blockIndex = FunctionBodyState.resolveBlock(draft, block, operation)
  if (Result.isFailure(blockIndex)) return Result.fail(blockIndex.failure)
  if (pending.blocks.has(blockIndex.success)) {
    return Result.fail(
      invalidState({
        operation,
        message: 'Phi already has an incoming value for this block',
        state: block,
      }),
    )
  }
  // Copying and freezing the growing list made 2,048 inputs take 378ms in the
  // construction probe. Keep draft-owned inputs mutable until the phi is sealed.
  pending.incoming.push({ value: resolved.success.operand, block: blockIndex.success })
  pending.blocks.add(blockIndex.success)
  return Result.void
}

/**
 * Validates predecessor coverage, finalizes a phi exactly once, and returns its SSA value.
 *
 * @category instructions
 * @since 0.0.0
 */
export const sealPhi = (
  self: FunctionBody,
  phiHandle: Phi,
): Effect.Effect<Value.Value, LlvmError> =>
  FunctionBodyState.mutate(self, 'FunctionBody.sealPhi', (draft) => sealPhiIn(draft, phiHandle))

/** @internal */
export const sealPhiIn = (
  draft: FunctionBodyState.Draft,
  phiHandle: Phi,
): Result.Result<Value.Value, LlvmError> => {
  const operation = 'FunctionBody.sealPhi'
  const index = FunctionBodyState.resolvePhi(draft, phiHandle, operation)
  if (Result.isFailure(index)) return Result.fail(index.failure)
  const instruction = draft.instructions[index.success]
  const pending = draft.openPhis.get(index.success)
  if (instruction?._tag !== 'Phi' || instruction.sealed || pending === undefined) {
    return Result.fail(
      invalidState({ operation, message: 'Phi is missing or already sealed', state: phiHandle }),
    )
  }
  draft.instructions[index.success] = { ...instruction, incoming: pending.incoming, sealed: true }
  draft.openPhis.delete(index.success)
  const value = draft.valueHandles[instruction.result]
  if (value === undefined) {
    return Result.fail(
      invalidState({ operation, message: 'Phi result value is missing', state: phiHandle }),
    )
  }
  return Result.succeed(value)
}
