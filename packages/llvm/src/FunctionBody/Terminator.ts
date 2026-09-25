import * as Effect from 'effect/Effect'
import * as Result from 'effect/Result'
import * as AddrSpace from '../AddrSpace.js'
import type * as Block from '../Block.js'
import * as ByteString from '../ByteString.js'
import type * as Constant from '../Constant.js'
import * as FunctionBodyState from '../internal/FunctionBodyState.js'
import type * as Handle from '../internal/Handle.js'
import { invalidInput, invalidState, type LlvmError } from '../LlvmError.js'
import * as Type from '../Type.js'
import * as HandleActor from '../internal/Handle.js'
import type * as Value from '../Value.js'
import type { FunctionBody, Instruction } from './_internal.js'
import { setBranchWeights, setUnpredictable } from './Metadata.js'

/**
 * Two-phase identity for a switch terminator whose cases are still being assembled.
 *
 * @category instructions
 * @since 0.0.0
 */
export interface Switch extends Handle.Handle<'Switch'> {}

/**
 * Appends `indirectbr` to a non-empty, de-duplicated list of destination blocks.
 *
 * @category instructions
 * @since 0.0.0
 */
export const indirectBranch = Effect.fnUntraced(function* (
  self: FunctionBody,
  address: Value.Input,
  destinations: ReadonlyArray<Block.Block>,
): Effect.fn.Return<Instruction, LlvmError> {
  return yield* FunctionBodyState.mutateModule(
    self,
    'FunctionBody.indirectBranch',
    (draft, module) =>
      Result.gen(function* () {
        const resolved = yield* FunctionBodyState.resolveOperand(
          draft,
          module,
          address,
          'FunctionBody.indirectBranch',
        )
        if (
          !(yield* FunctionBodyState.isPointerType(
            module,
            resolved.type,
            'FunctionBody.indirectBranch',
          ))
        ) {
          return yield* Result.fail(
            invalidInput({
              operation: 'FunctionBody.indirectBranch',
              message: 'indirectbr requires a pointer address',
              input: address,
            }),
          )
        }
        if (destinations.length === 0) {
          return yield* Result.fail(
            invalidInput({
              operation: 'FunctionBody.indirectBranch',
              message: 'indirectbr requires at least one destination',
              input: destinations,
            }),
          )
        }
        const mutableBlocks: Array<number> = []
        for (const block of destinations) {
          mutableBlocks.push(
            yield* FunctionBodyState.resolveBlock(draft, block, 'FunctionBody.indirectBranch'),
          )
        }
        const blocks = mutableBlocks
        if (new Set(blocks).size !== blocks.length) {
          return yield* Result.fail(
            invalidInput({
              operation: 'FunctionBody.indirectBranch',
              message: 'indirectbr destinations must be unique',
              input: destinations,
            }),
          )
        }
        const predecessor = draft.cursor
        if (predecessor === undefined) {
          return yield* Result.fail(
            invalidInput({
              operation: 'FunctionBody.indirectBranch',
              message: 'Set an insertion block before adding indirectbr',
              input: address,
            }),
          )
        }
        const instruction = yield* FunctionBodyState.appendInstruction(draft, {
          _tag: 'IndirectBranch',
          address: resolved.operand,
          destinations: blocks,
          result: undefined,
          name: ByteString.empty,
        })
        for (const block of blocks)
          yield* FunctionBodyState.addPredecessor(draft, block, predecessor)
        return instruction
      }),
  )
})

/**
 * Terminates the insertion block with an unconditional branch and records its predecessor edge.
 *
 * @category instructions
 * @since 0.0.0
 */
export const branch = (
  self: FunctionBody,
  destination: Block.Block,
): Effect.Effect<Instruction, LlvmError> =>
  FunctionBodyState.mutate(self, 'FunctionBody.branch', (draft) => branchIn(draft, destination))

/** @internal */
export const branchIn = (
  draft: FunctionBodyState.Draft,
  destination: Block.Block,
): Result.Result<Instruction, LlvmError> => {
  const block = FunctionBodyState.resolveBlock(draft, destination, 'FunctionBody.branch')
  if (Result.isFailure(block)) return Result.fail(block.failure)
  const predecessor = draft.cursor
  if (predecessor === undefined) {
    return Result.fail(
      invalidInput({
        operation: 'FunctionBody.branch',
        message: 'Set an insertion block before branching',
        input: destination,
      }),
    )
  }
  const instruction = FunctionBodyState.appendInstruction(draft, {
    _tag: 'Branch',
    destination: block.success,
    result: undefined,
    name: ByteString.empty,
  })
  if (Result.isFailure(instruction)) return instruction
  const added = FunctionBodyState.addPredecessor(draft, block.success, predecessor)
  return Result.isFailure(added) ? Result.fail(added.failure) : instruction
}

/**
 * Terminates the insertion block with an `i1` conditional branch and records both edges.
 *
 * @category instructions
 * @since 0.0.0
 */
export const conditionalBranch = (
  self: FunctionBody,
  condition: Value.Input,
  onTrue: Block.Block,
  onFalse: Block.Block,
  weights: 'none' | 'unpredictable' | 'true-likely' | 'false-likely' = 'none',
): Effect.Effect<Instruction, LlvmError> => {
  const appended = FunctionBodyState.mutate(self, 'FunctionBody.conditionalBranch', (draft) =>
    conditionalBranchIn(draft, condition, onTrue, onFalse, weights),
  )
  if (weights === 'none') return appended
  return Effect.flatMap(appended, (instruction) =>
    Effect.as(
      weights === 'unpredictable'
        ? setUnpredictable(self, instruction)
        : setBranchWeights(self, instruction, weights === 'true-likely' ? [2000, 1] : [1, 2000]),
      instruction,
    ),
  )
}

/** Appends the conditional branch; branch-weight metadata is attached separately. @internal */
export const conditionalBranchIn = (
  draft: FunctionBodyState.Draft,
  condition: Value.Input,
  onTrue: Block.Block,
  onFalse: Block.Block,
  weights: 'none' | 'unpredictable' | 'true-likely' | 'false-likely' = 'none',
): Result.Result<Instruction, LlvmError> => {
  const module = draft.module
  const operation = 'FunctionBody.conditionalBranch'
  const resolved = FunctionBodyState.resolveOperand(draft, module, condition, operation)
  if (Result.isFailure(resolved)) return Result.fail(resolved.failure)
  const type = FunctionBodyState.typeAt(module, resolved.success.type, operation)
  if (Result.isFailure(type)) return Result.fail(type.failure)
  if (type.success._tag !== 'Integer' || type.success.bitWidth !== 1) {
    return Result.fail(
      invalidInput({
        operation,
        message: 'Conditional branches require an i1 condition',
        input: condition,
      }),
    )
  }
  const trueBlock = FunctionBodyState.resolveBlock(draft, onTrue, operation)
  if (Result.isFailure(trueBlock)) return Result.fail(trueBlock.failure)
  const falseBlock = FunctionBodyState.resolveBlock(draft, onFalse, operation)
  if (Result.isFailure(falseBlock)) return Result.fail(falseBlock.failure)
  const predecessor = draft.cursor
  if (predecessor === undefined) {
    return Result.fail(
      invalidInput({
        operation,
        message: 'Set an insertion block before branching',
        input: condition,
      }),
    )
  }
  const instruction = FunctionBodyState.appendInstruction(draft, {
    _tag: 'ConditionalBranch',
    condition: resolved.success.operand,
    onTrue: trueBlock.success,
    onFalse: falseBlock.success,
    weights,
    result: undefined,
    name: ByteString.empty,
  })
  if (Result.isFailure(instruction)) return instruction
  const addedTrue = FunctionBodyState.addPredecessor(draft, trueBlock.success, predecessor)
  if (Result.isFailure(addedTrue)) return Result.fail(addedTrue.failure)
  const addedFalse = FunctionBodyState.addPredecessor(draft, falseBlock.success, predecessor)
  return Result.isFailure(addedFalse) ? Result.fail(addedFalse.failure) : instruction
}

/**
 * Starts a switch terminator whose cases must be added and then finalized with {@link sealSwitch}.
 *
 * **Details**
 *
 * The switch remains intentionally incomplete so callers can assemble cases incrementally.
 *
 * **Gotchas**
 *
 * The body transaction cannot commit while any switch is unsealed.
 *
 * @category instructions
 * @since 0.0.0
 */
export const switchTerminator = (
  self: FunctionBody,
  value: Value.Input,
  defaultBlock: Block.Block,
  weights: ReadonlyArray<number> = [],
): Effect.Effect<Switch, LlvmError> =>
  FunctionBodyState.mutate(self, 'FunctionBody.switchTerminator', (draft) =>
    switchTerminatorIn(draft, value, defaultBlock, weights),
  )

/** @internal */
export const switchTerminatorIn = (
  draft: FunctionBodyState.Draft,
  value: Value.Input,
  defaultBlock: Block.Block,
  weights: ReadonlyArray<number> = [],
): Result.Result<Switch, LlvmError> => {
  const module = draft.module
  return Result.gen(function* () {
    const resolved = yield* FunctionBodyState.resolveOperand(
      draft,
      module,
      value,
      'FunctionBody.switchTerminator',
    )
    if (
      !(yield* FunctionBodyState.isIntegerType(
        module,
        resolved.type,
        'FunctionBody.switchTerminator',
      ))
    ) {
      return yield* Result.fail(
        invalidInput({
          operation: 'FunctionBody.switchTerminator',
          message: 'switch requires an integer value',
          input: value,
        }),
      )
    }
    const destination = yield* FunctionBodyState.resolveBlock(
      draft,
      defaultBlock,
      'FunctionBody.switchTerminator',
    )
    const predecessor = draft.cursor
    if (predecessor === undefined) {
      return yield* Result.fail(
        invalidInput({
          operation: 'FunctionBody.switchTerminator',
          message: 'Set an insertion block before adding a switch',
          input: value,
        }),
      )
    }
    const instruction = yield* FunctionBodyState.appendInstruction(draft, {
      _tag: 'Switch',
      value: resolved.operand,
      defaultBlock: destination,
      cases: [],
      weights: [...weights],
      sealed: false,
      result: undefined,
      name: ByteString.empty,
    })
    yield* FunctionBodyState.addPredecessor(draft, destination, predecessor)
    return yield* FunctionBodyState.makeSwitchHandle(draft, instruction, predecessor)
  })
}

/**
 * Adds one unique, same-typed integer constant case to an open switch.
 *
 * @category instructions
 * @since 0.0.0
 */
export const addSwitchCase = (
  self: FunctionBody,
  switchHandle: Switch,
  value: Constant.Constant,
  destination: Block.Block,
): Effect.Effect<void, LlvmError> =>
  FunctionBodyState.mutate(self, 'FunctionBody.addSwitchCase', (draft) =>
    addSwitchCaseIn(draft, switchHandle, value, destination),
  )

/** @internal */
export const addSwitchCaseIn = (
  draft: FunctionBodyState.Draft,
  switchHandle: Switch,
  value: Constant.Constant,
  destination: Block.Block,
): Result.Result<void, LlvmError> => {
  const module = draft.module
  return Result.gen(function* () {
    const { index, block: predecessor } = yield* FunctionBodyState.resolveSwitch(
      draft,
      switchHandle,
      'FunctionBody.addSwitchCase',
    )
    const instruction = draft.instructions[index]
    if (instruction?._tag !== 'Switch' || instruction.sealed) {
      return yield* Result.fail(
        invalidState({
          operation: 'FunctionBody.addSwitchCase',
          message: 'Switch is missing or already finalized',
          state: switchHandle,
        }),
      )
    }
    const switchValue =
      instruction.value._tag === 'Constant'
        ? module.constants.descriptions[instruction.value.constant]
        : draft.values[instruction.value.value]
    const resolved = yield* FunctionBodyState.resolveOperand(
      draft,
      module,
      value,
      'FunctionBody.addSwitchCase',
    )
    if (switchValue === undefined || switchValue.type !== resolved.type) {
      return yield* Result.fail(
        invalidInput({
          operation: 'FunctionBody.addSwitchCase',
          message: 'Switch case value must match the switch condition type',
          input: value,
        }),
      )
    }
    const constantIndex =
      resolved.operand._tag === 'Constant' ? resolved.operand.constant : undefined
    if (constantIndex === undefined) {
      return yield* Result.fail(
        invalidInput({
          operation: 'FunctionBody.addSwitchCase',
          message: 'Switch cases must be module constants',
          input: value,
        }),
      )
    }
    if (instruction.cases.some((entry) => entry.value === constantIndex)) {
      return yield* Result.fail(
        invalidInput({
          operation: 'FunctionBody.addSwitchCase',
          message: 'Switch case values must be unique',
          input: value,
        }),
      )
    }
    const block = yield* FunctionBodyState.resolveBlock(
      draft,
      destination,
      'FunctionBody.addSwitchCase',
    )
    draft.instructions[index] = {
      ...instruction,
      cases: [...instruction.cases, { value: constantIndex, block }],
    }
    yield* FunctionBodyState.addPredecessor(draft, block, predecessor)
  })
}

/**
 * Finalizes a switch exactly once and records predecessor edges for every destination.
 *
 * @category instructions
 * @since 0.0.0
 */
export const sealSwitch = (
  self: FunctionBody,
  switchHandle: Switch,
): Effect.Effect<Instruction, LlvmError> =>
  FunctionBodyState.mutate(self, 'FunctionBody.sealSwitch', (draft) =>
    sealSwitchIn(draft, switchHandle),
  )

/** @internal */
export const sealSwitchIn = (
  draft: FunctionBodyState.Draft,
  switchHandle: Switch,
): Result.Result<Instruction, LlvmError> => {
  return Result.gen(function* () {
    const { index } = yield* FunctionBodyState.resolveSwitch(
      draft,
      switchHandle,
      'FunctionBody.sealSwitch',
    )
    const instruction = draft.instructions[index]
    if (instruction?._tag !== 'Switch' || instruction.sealed) {
      return yield* Result.fail(
        invalidState({
          operation: 'FunctionBody.sealSwitch',
          message: 'Switch is missing or already finalized',
          state: switchHandle,
        }),
      )
    }
    if (
      instruction.weights.length > 0 &&
      instruction.weights.length !== instruction.cases.length + 1
    ) {
      return yield* Result.fail(
        invalidInput({
          operation: 'FunctionBody.sealSwitch',
          message: 'Switch weights must include the default and every case',
          input: instruction.weights,
        }),
      )
    }
    draft.instructions[index] = { ...instruction, sealed: true }
    return yield* FunctionBodyState.instructionHandleAt(draft, index, 'FunctionBody.sealSwitch')
  })
}

/**
 * Terminates the insertion block by returning a value matching the function return type.
 *
 * @category instructions
 * @since 0.0.0
 */
export const returnValue = (
  self: FunctionBody,
  value: Value.Input,
): Effect.Effect<Instruction, LlvmError> =>
  FunctionBodyState.mutate(self, 'FunctionBody.returnValue', (draft) => returnValueIn(draft, value))

/** @internal */
export const returnValueIn = (
  draft: FunctionBodyState.Draft,
  value: Value.Input,
): Result.Result<Instruction, LlvmError> => {
  const module = draft.module
  const resolved = FunctionBodyState.resolveOperand(
    draft,
    module,
    value,
    'FunctionBody.returnValue',
  )
  if (Result.isFailure(resolved)) return Result.fail(resolved.failure)
  if (resolved.success.type !== draft.returnType) {
    return Result.fail(
      invalidInput({
        operation: 'FunctionBody.returnValue',
        message: 'Return value does not match the function return type',
        input: value,
      }),
    )
  }
  return FunctionBodyState.appendInstruction(draft, {
    _tag: 'Return',
    value: resolved.success.operand,
    result: undefined,
    name: ByteString.empty,
  })
}

/**
 * Terminates the insertion block with `ret void` after checking the signature.
 *
 * @category instructions
 * @since 0.0.0
 */
export const returnVoid = (self: FunctionBody): Effect.Effect<Instruction, LlvmError> =>
  FunctionBodyState.mutate(self, 'FunctionBody.returnVoid', (draft) => returnVoidIn(draft))

/** @internal */
export const returnVoidIn = (
  draft: FunctionBodyState.Draft,
): Result.Result<Instruction, LlvmError> => {
  const module = draft.module
  const returnType = FunctionBodyState.typeAt(module, draft.returnType, 'FunctionBody.returnVoid')
  if (Result.isFailure(returnType)) return Result.fail(returnType.failure)
  if (returnType.success._tag !== 'Simple' || returnType.success.tag !== 'Void') {
    return Result.fail(
      invalidInput({
        operation: 'FunctionBody.returnVoid',
        message: 'returnVoid requires a void function return type',
        input: draft.returnType,
      }),
    )
  }
  return FunctionBodyState.appendInstruction(draft, {
    _tag: 'ReturnVoid',
    result: undefined,
    name: ByteString.empty,
  })
}

/**
 * Terminates the insertion block with LLVM's `unreachable` instruction.
 *
 * @category instructions
 * @since 0.0.0
 */
export const unreachable = (self: FunctionBody): Effect.Effect<Instruction, LlvmError> =>
  FunctionBodyState.mutate(self, 'FunctionBody.unreachable', (draft) => unreachableIn(draft))

/** @internal */
export const unreachableIn = (
  draft: FunctionBodyState.Draft,
): Result.Result<Instruction, LlvmError> =>
  FunctionBodyState.appendInstruction(draft, {
    _tag: 'Unreachable',
    result: undefined,
    name: ByteString.empty,
  })

/**
 * Begins a cleanup-only Itanium exception handler with the canonical `{ ptr, i32 }` result.
 *
 * The enclosing function needs a personality and this must be its block's first non-PHI
 * instruction. Cleanup handlers must terminate or resume unwinding; this operation does not
 * implement language-level catches.
 *
 * @category instructions
 * @since 0.0.0
 */
export const cleanupLandingPad = (
  self: FunctionBody,
  name?: ByteString.ByteString | Uint8Array | string,
): Effect.Effect<Value.Value, LlvmError> =>
  FunctionBodyState.mutate(self, 'FunctionBody.cleanupLandingPad', (draft) =>
    cleanupLandingPadIn(draft, name),
  )

/** @internal */
export const cleanupLandingPadIn = (
  draft: FunctionBodyState.Draft,
  name?: ByteString.ByteString | Uint8Array | string,
): Result.Result<Value.Value, LlvmError> => {
  const pointer = Type.internIn(draft.context, {
    _tag: 'Pointer',
    addressSpace: AddrSpace.defaultAddrSpace,
  })
  if (Result.isFailure(pointer)) return Result.fail(pointer.failure)
  const i32 = Type.internIn(draft.context, { _tag: 'Integer', bitWidth: 32 })
  if (Result.isFailure(i32)) return Result.fail(i32.failure)
  const type = Type.structureIn(draft.context, [pointer.success, i32.success])
  if (Result.isFailure(type)) return Result.fail(type.failure)
  const typeIndex = HandleActor.resolve(
    draft.builder,
    draft.moduleOwner,
    type.success,
    'Type',
    'FunctionBody.cleanupLandingPad',
  )
  if (Result.isFailure(typeIndex)) return Result.fail(typeIndex.failure)
  return FunctionBodyState.appendResult(draft, typeIndex.success, name, (result, finalName) => ({
    _tag: 'LandingPad',
    result,
    name: finalName,
    type: typeIndex.success,
  }))
}
