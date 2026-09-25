import * as Result from 'effect/Result'
import * as ByteString from '../../ByteString.js'
import type * as FunctionBodyActor from '../../FunctionBody.js'
import type { LlvmError } from '../../LlvmError.js'
import type * as ValueActor from '../../Value.js'
import * as FunctionBodyDescription from '../FunctionBodyDescription.js'
import * as Handle from '../Handle.js'
import { type Draft, fail, localName, type MutableBlock, noAttachments } from './primitives.js'

/**
 * Construction's measured per-instruction append/validation loop. Direct Result transitions
 * avoid generator/iterator allocation; forward walks allocate a visited set only for forwards.
 * Public operations and the body transaction remain effectful (JUL-154).
 *
 * @internal
 */
const currentBlock = (
  draft: Draft,
  operation: string,
): Result.Result<{ readonly index: number; readonly block: MutableBlock }, LlvmError> => {
  const index = draft.cursor
  const block = index === undefined ? undefined : draft.blocks[index]
  if (index === undefined || block === undefined) {
    return fail(operation, 'Set an insertion block before adding an instruction', draft.cursor)
  }
  const last = block.instructions.at(-1)
  const instruction = last === undefined ? undefined : draft.instructions[last]
  if (instruction !== undefined && FunctionBodyDescription.isTerminator(instruction)) {
    return fail(operation, 'Cannot add an instruction after a terminator', index)
  }
  return Result.succeed({ index, block })
}

/** @internal */
export const appendInstruction = (
  draft: Draft,
  instruction: FunctionBodyDescription.Instruction,
): Result.Result<FunctionBodyActor.Instruction, LlvmError> => {
  const cursor = currentBlock(draft, 'FunctionBody.appendInstruction')
  if (Result.isFailure(cursor)) return Result.fail(cursor.failure)
  const index = draft.instructions.length
  const handle = Handle.make('Instruction', draft.owner, index)
  draft.instructions.push(instruction)
  draft.metadata.push(noAttachments)
  draft.debugLocations.push(undefined)
  draft.instructionHandles.push(handle)
  cursor.success.block.instructions.push(index)
  return Result.succeed(handle)
}

/**
 * Appends a result-producing instruction and returns its value. Most results are only used as
 * values, so the instruction handle is minted lazily by `instructionHandleAt`.
 *
 * @internal
 */
export const appendResult = (
  draft: Draft,
  type: number,
  name: ByteString.ByteString | Uint8Array | string | undefined,
  makeInstruction: (
    result: number,
    name: ByteString.ByteString,
  ) => FunctionBodyDescription.Instruction,
): Result.Result<ValueActor.Value, LlvmError> => {
  const cursor = currentBlock(draft, 'FunctionBody.appendResult')
  if (Result.isFailure(cursor)) return Result.fail(cursor.failure)
  const result = draft.values.length
  const instructionIndex = draft.instructions.length
  const finalName = localName(draft, name)
  const value = Handle.make('Value', draft.owner, result)
  draft.values.push({
    type,
    name: finalName,
    source: { _tag: 'Instruction', instruction: instructionIndex },
  })
  draft.valueHandles.push(value)
  draft.instructions.push(makeInstruction(result, finalName))
  draft.metadata.push(noAttachments)
  draft.debugLocations.push(undefined)
  draft.instructionHandles.push(undefined)
  cursor.success.block.instructions.push(instructionIndex)
  return Result.succeed(value)
}

/** @internal */
export const instructionHandleAt = (
  draft: Draft,
  index: number,
  operation: string,
): Result.Result<FunctionBodyActor.Instruction, LlvmError> => {
  if (!Number.isSafeInteger(index) || index < 0 || index >= draft.instructions.length) {
    return fail(operation, 'Instruction table handle is missing', index)
  }
  let handle = draft.instructionHandles[index]
  if (handle === undefined) {
    handle = Handle.make('Instruction', draft.owner, index)
    draft.instructionHandles[index] = handle
  }
  return Result.succeed(handle)
}

/** @internal */
const validateOperand = (
  draft: Draft,
  operand: FunctionBodyDescription.Operand,
): Result.Result<void, LlvmError> => {
  let current = operand
  let seen: Set<number> | undefined
  while (current._tag === 'Local') {
    const value = draft.values[current.value]
    if (value === undefined)
      return fail('FunctionBody.validate', 'Local operand is missing', current)
    if (value.source._tag !== 'Forward') break
    if (seen?.has(current.value))
      return fail('FunctionBody.validate', 'Forward value cycle detected', current)
    if (value.source.resolved === undefined)
      return fail('FunctionBody.validate', 'Forward value was never resolved', current)
    seen ??= new Set()
    seen.add(current.value)
    current = value.source.resolved
  }
  return Result.void
}

/** @internal */
const validateInstructionOperands = (
  draft: Draft,
  instruction: FunctionBodyDescription.Instruction,
  operands: Array<FunctionBodyDescription.Operand>,
): Result.Result<void, LlvmError> => {
  operands.length = 0
  switch (instruction._tag) {
    case 'Unary':
    case 'Cast':
    case 'Freeze':
      operands.push(instruction.operand)
      break
    case 'Binary':
    case 'Compare':
      operands.push(instruction.left, instruction.right)
      break
    case 'Select':
      operands.push(instruction.condition, instruction.onTrue, instruction.onFalse)
      break
    case 'ExtractValue':
      operands.push(instruction.aggregate)
      break
    case 'InsertValue':
      operands.push(instruction.aggregate, instruction.element)
      break
    case 'Alloca':
      operands.push(instruction.count)
      break
    case 'Load':
      operands.push(instruction.pointer)
      break
    case 'Store':
      operands.push(instruction.value, instruction.pointer)
      break
    case 'GetElementPtr':
      operands.push(instruction.base, ...instruction.indices)
      break
    case 'ExtractElement':
      operands.push(instruction.vector, instruction.index)
      break
    case 'InsertElement':
      operands.push(instruction.vector, instruction.element, instruction.index)
      break
    case 'ShuffleVector':
      operands.push(instruction.left, instruction.right, instruction.mask)
      break
    case 'CompareExchange':
      operands.push(instruction.pointer, instruction.comparison, instruction.replacement)
      break
    case 'AtomicRmw':
      operands.push(instruction.pointer, instruction.value)
      break
    case 'VaArg':
      operands.push(instruction.list)
      break
    case 'IndirectBranch':
      operands.push(instruction.address)
      break
    case 'ConditionalBranch':
      operands.push(instruction.condition)
      break
    case 'Switch':
      operands.push(instruction.value)
      break
    case 'Return':
      operands.push(instruction.value)
      break
    case 'Phi':
      for (const entry of instruction.incoming) operands.push(entry.value)
      break
    case 'Invoke':
    case 'Call':
      operands.push(instruction.callee, ...instruction.arguments)
      for (const bundle of instruction.operandBundles) operands.push(...bundle.operands)
      break
    case 'LandingPad':
    case 'Branch':
    case 'Fence':
    case 'ReturnVoid':
    case 'Unreachable':
      break
  }
  for (const operand of operands) {
    const resolved = validateOperand(draft, operand)
    if (Result.isFailure(resolved)) return Result.fail(resolved.failure)
  }
  return Result.void
}

/** @internal */
export const validateInstructions = (draft: Draft): Result.Result<void, LlvmError> => {
  // One scratch list for every instruction: commit validation visits each emitted instruction.
  const operands: Array<FunctionBodyDescription.Operand> = []
  for (const instruction of draft.instructions) {
    const validated = validateInstructionOperands(draft, instruction, operands)
    if (Result.isFailure(validated)) return Result.fail(validated.failure)
  }
  for (let valueIndex = 0; valueIndex < draft.values.length; valueIndex += 1) {
    const value = draft.values[valueIndex]
    if (value?.source._tag === 'Forward') {
      const resolved = validateOperand(draft, { _tag: 'Local', value: valueIndex })
      if (Result.isFailure(resolved)) return Result.fail(resolved.failure)
    }
  }
  return Result.void
}
