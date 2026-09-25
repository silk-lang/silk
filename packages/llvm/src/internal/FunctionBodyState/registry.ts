import * as Effect from 'effect/Effect'
import * as Result from 'effect/Result'
import type * as BlockActor from '../../Block.js'
import type * as Builder from '../../Builder.js'
import * as ByteString from '../../ByteString.js'
import type * as FunctionBodyActor from '../../FunctionBody.js'
import { invalidInput, invalidState, type LlvmError } from '../../LlvmError.js'
import * as Type from '../../Type.js'
import type * as ValueActor from '../../Value.js'
import * as BuilderState from '../BuilderState.js'
import * as FunctionBodyDescription from '../FunctionBodyDescription.js'
import * as Handle from '../Handle.js'
import type * as OwnedHandle from '../OwnedHandle.js'
import type * as TypeDescription from '../TypeDescription.js'
import { instructionHandleAt, validateInstructions } from './InstructionEncoder.js'
import {
  assertActive,
  type Draft,
  drafts,
  fail,
  localIndex,
  localName,
  type OperandInput,
} from './primitives.js'

/** Creates an active draft for one function body transaction. @internal */
export const makeDraft = (
  context: BuilderState.Context,
  functionIndex: number,
  functionType: number,
  signature: Extract<TypeDescription.Description, { readonly _tag: 'Function' }>,
  creatorFiber: number,
): Draft => {
  const owner: OwnedHandle.Owner = { token: Symbol('llvm-function-body-owner') }
  const draft: Draft = {
    builder: context.builder,
    moduleOwner: context.owner,
    module: context.state,
    context,
    owner,
    functionIndex,
    functionType,
    returnType: signature.returnType,
    creatorFiber,
    status: 'active',
    cursor: undefined,
    arguments: [],
    blocks: [],
    blockHandles: [],
    instructions: [],
    openPhis: new Map(),
    instructionHandles: [],
    switchBlocks: new Map(),
    localOperands: [],
    values: [],
    valueHandles: [],
    metadata: [],
    debugLocations: [],
  }
  for (let index = 0; index < signature.parameters.length; index += 1) {
    const type = signature.parameters[index]
    if (type === undefined) continue
    const valueIndex = draft.values.length
    const handle = Handle.make('Value', owner, valueIndex)
    draft.values.push({
      type,
      name: ByteString.empty,
      source: { _tag: 'Argument', index },
    })
    draft.valueHandles.push(handle)
    draft.arguments.push(valueIndex)
  }
  return draft
}

/** Creates a draft reachable through an effectful body handle. @internal */
export const create = (
  context: BuilderState.Context,
  functionIndex: number,
  functionType: number,
  signature: Extract<TypeDescription.Description, { readonly _tag: 'Function' }>,
  creatorFiber: number,
): FunctionBodyActor.FunctionBody => {
  const draft = makeDraft(context, functionIndex, functionType, signature, creatorFiber)
  const self = Handle.make('FunctionBody', draft.owner, 0)
  drafts.set(self, draft)
  return self
}

/**
 * The three accessors below run once per emitted instruction, so each is a single runtime
 * primitive: `Effect.withFiber` reads the current fiber synchronously (`fiber.id` is the same
 * number `Effect.fiberId` yields) and the draft lookup, active/ownership assertion, and
 * transition all complete inside that one step instead of bouncing through the fiber run loop
 * for every stage. JUL-154 construction profiles also attribute allocation cost to operand
 * resolution and commit validation below; their direct Result transitions are bounded to this
 * instruction loop.
 *
 * @internal
 */
export const builder = (
  self: FunctionBodyActor.FunctionBody,
): Effect.Effect<Builder.Builder, LlvmError> =>
  Effect.withFiber((fiber) => {
    const draft = drafts.get(self)
    if (draft === undefined) return unknownDraft(self, 'FunctionBody.builder')
    const active = assertActive(draft, fiber.id, 'FunctionBody.builder')
    return Result.isFailure(active) ? Effect.fail(active.failure) : Effect.succeed(draft.builder)
  })

/** @internal */
export const mutate = <A>(
  self: FunctionBodyActor.FunctionBody,
  operation: string,
  transition: (draft: Draft) => Result.Result<A, LlvmError>,
): Effect.Effect<A, LlvmError> =>
  Effect.withFiber((fiber) => {
    const draft = drafts.get(self)
    if (draft === undefined) return unknownDraft(self, operation)
    const active = assertActive(draft, fiber.id, operation)
    return Result.isFailure(active)
      ? Effect.fail(active.failure)
      : Effect.fromResult(transition(draft))
  })

/** @internal */
export const mutateModule = <A>(
  self: FunctionBodyActor.FunctionBody,
  operation: string,
  transition: (draft: Draft, module: BuilderState.MutableState) => Result.Result<A, LlvmError>,
): Effect.Effect<A, LlvmError> =>
  Effect.withFiber((fiber) => {
    const draft = drafts.get(self)
    if (draft === undefined) return unknownDraft(self, operation)
    const active = assertActive(draft, fiber.id, operation)
    return Result.isFailure(active)
      ? Effect.fail(active.failure)
      : Effect.fromResult(transition(draft, draft.module))
  })

const unknownDraft = (
  self: FunctionBodyActor.FunctionBody,
  operation: string,
): Effect.Effect<never, LlvmError> =>
  Effect.fail(invalidInput({ operation, message: 'Unknown function-body draft', input: self }))

/** @internal */
export const close = (
  self: FunctionBodyActor.FunctionBody,
  status: 'committed' | 'failed',
): void => {
  const draft = drafts.get(self)
  if (draft !== undefined) draft.status = status
}

/** @internal */
export const resolveBlock = (
  draft: Draft,
  block: BlockActor.Block,
  operation: string,
): Result.Result<number, LlvmError> => localIndex(draft, block, 'Block', operation, 'block')

/** @internal */
export const resolveInstruction = (
  draft: Draft,
  instruction: FunctionBodyActor.Instruction,
  operation: string,
): Result.Result<number, LlvmError> =>
  localIndex(draft, instruction, 'Instruction', operation, 'instruction')

/** @internal */
export const resolvePhi = (
  draft: Draft,
  phi: FunctionBodyActor.Phi,
  operation: string,
): Result.Result<number, LlvmError> => localIndex(draft, phi, 'Phi', operation, 'phi')

/** @internal */
export const resolveSwitch = (
  draft: Draft,
  value: FunctionBodyActor.Switch,
  operation: string,
): Result.Result<{ readonly index: number; readonly block: number }, LlvmError> => {
  const index = localIndex(draft, value, 'Switch', operation, 'switch')
  if (Result.isFailure(index)) return Result.fail(index.failure)
  const block = draft.switchBlocks.get(index.success)
  if (block === undefined) return fail(operation, 'Switch block is missing', value)
  return Result.succeed({ index: index.success, block })
}

/** @internal */
const resolveLocalValue = (
  draft: Draft,
  value: ValueActor.Value,
  operation: string,
): Result.Result<
  { readonly operand: FunctionBodyDescription.Operand; readonly type: number },
  LlvmError
> => {
  const index = localIndex(draft, value, 'Value', operation, 'value')
  if (Result.isFailure(index)) return Result.fail(index.failure)
  const description = draft.values[index.success]
  if (description === undefined) return fail(operation, 'Local value table entry is missing', value)
  let operand = draft.localOperands[index.success]
  if (operand === undefined) {
    operand = { _tag: 'Local', value: index.success }
    draft.localOperands[index.success] = operand
  }
  return Result.succeed({ operand, type: description.type })
}

/** @internal */
export const resolveOperand = (
  draft: Draft,
  module: BuilderState.MutableState,
  value: OperandInput,
  operation: string,
): Result.Result<
  { readonly operand: FunctionBodyDescription.Operand; readonly type: number },
  LlvmError
> => {
  if (value._tag === 'Value') return resolveLocalValue(draft, value, operation)
  const index = Handle.resolve(draft.builder, draft.moduleOwner, value, 'Constant', operation)
  if (Result.isFailure(index)) return Result.fail(index.failure)
  const constant = module.constants.descriptions[index.success]
  if (constant === undefined) return fail(operation, 'Constant table entry is missing', value)
  let operand = module.constantOperands[index.success]
  if (operand === undefined) {
    operand = { _tag: 'Constant', constant: index.success }
    module.constantOperands[index.success] = operand
  }
  return Result.succeed({ operand, type: constant.type })
}

/** @internal */
export const typeAt = (
  module: BuilderState.MutableState,
  index: number,
  operation: string,
): Result.Result<TypeDescription.Description, LlvmError> => {
  const description = module.types.descriptions[index]
  return description === undefined
    ? fail(operation, 'Type table entry is missing', index)
    : Result.succeed(description)
}

/** @internal */
const scalarType = (
  module: BuilderState.MutableState,
  index: number,
  operation: string,
): Result.Result<TypeDescription.Description, LlvmError> => {
  const description = typeAt(module, index, operation)
  if (Result.isFailure(description) || description.success._tag !== 'Vector') return description
  return typeAt(module, description.success.child, operation)
}

const floatingTags: ReadonlySet<string> = new Set([
  'Half',
  'BFloat',
  'Float',
  'Double',
  'X86Fp80',
  'Fp128',
  'PpcFp128',
])

/** @internal */
export const isIntegerType = (
  module: BuilderState.MutableState,
  index: number,
  operation: string,
): Result.Result<boolean, LlvmError> => {
  const description = scalarType(module, index, operation)
  if (Result.isFailure(description)) return Result.fail(description.failure)
  return Result.succeed(description.success._tag === 'Integer')
}

/** @internal */
export const isFloatingType = (
  module: BuilderState.MutableState,
  index: number,
  operation: string,
): Result.Result<boolean, LlvmError> => {
  const description = scalarType(module, index, operation)
  if (Result.isFailure(description)) return Result.fail(description.failure)
  return Result.succeed(
    description.success._tag === 'Simple' && floatingTags.has(description.success.tag),
  )
}

/** @internal */
export const isPointerType = (
  module: BuilderState.MutableState,
  index: number,
  operation: string,
): Result.Result<boolean, LlvmError> => {
  const description = scalarType(module, index, operation)
  if (Result.isFailure(description)) return Result.fail(description.failure)
  return Result.succeed(description.success._tag === 'Pointer')
}

/** @internal */
export const comparisonType = (
  draft: Draft,
  module: BuilderState.MutableState,
  operandType: number,
): Result.Result<number, LlvmError> => {
  const i1 = Type.internIndex(module, draft.moduleOwner, { _tag: 'Integer', bitWidth: 1 })
  const description = typeAt(module, operandType, 'FunctionBody.compare')
  if (Result.isFailure(description)) return Result.fail(description.failure)
  return Result.succeed(
    description.success._tag === 'Vector'
      ? Type.internIndex(module, draft.moduleOwner, {
          _tag: 'Vector',
          child: i1,
          length: description.success.length,
          scalable: description.success.scalable,
        })
      : i1,
  )
}

/** @internal */
const valueHandle = (
  draft: Draft,
  index: number,
  operation: string,
): Result.Result<ValueActor.Value, LlvmError> => {
  const handle = draft.valueHandles[index]
  return handle === undefined
    ? fail(operation, 'Value table handle is missing', index)
    : Result.succeed(handle)
}

/** @internal */
export const makeBlock = (
  draft: Draft,
  name: ByteString.ByteString | Uint8Array | string | undefined,
): BlockActor.Block => {
  const index = draft.blocks.length
  const handle = Handle.make('Block', draft.owner, index)
  draft.blocks.push({
    name: localName(draft, name),
    instructions: [],
    predecessors: new Set(),
  })
  draft.blockHandles.push(handle)
  if (draft.cursor === undefined) draft.cursor = index
  return handle
}

/** @internal */
export const addPredecessor = (
  draft: Draft,
  block: number,
  predecessor: number,
): Result.Result<void, LlvmError> => {
  const target = draft.blocks[block]
  if (target === undefined) {
    return Result.fail(
      invalidState({
        operation: 'FunctionBody.addPredecessor',
        message: 'Destination block is missing',
        state: block,
      }),
    )
  }
  target.predecessors.add(predecessor)
  return Result.succeed(undefined)
}

/** @internal */
export const setCursor = (
  draft: Draft,
  block: BlockActor.Block,
): Result.Result<void, LlvmError> => {
  const index = resolveBlock(draft, block, 'Block.setInsertionPoint')
  if (Result.isFailure(index)) return Result.fail(index.failure)
  draft.cursor = index.success
  return Result.void
}

/** @internal */
export const argument = (
  draft: Draft,
  index: number,
): Result.Result<ValueActor.Value, LlvmError> => {
  if (!Number.isSafeInteger(index) || index < 0) {
    return fail('Value.argument', 'Argument index must be a non-negative integer', index)
  }
  const value = draft.arguments[index]
  if (value === undefined) {
    return fail('Value.argument', 'Argument index is outside the function signature', index)
  }
  return valueHandle(draft, value, 'Value.argument')
}

/** @internal */
export const forward = (
  draft: Draft,
  type: number,
  name: ByteString.ByteString | Uint8Array | string | undefined,
): ValueActor.Value => {
  const index = draft.values.length
  const handle = Handle.make('Value', draft.owner, index)
  draft.values.push({
    type,
    name: localName(draft, name),
    source: { _tag: 'Forward', resolved: undefined },
  })
  draft.valueHandles.push(handle)
  return handle
}

/** @internal */
export const resolveForward = (
  draft: Draft,
  module: BuilderState.MutableState,
  forwardValue: ValueActor.Value,
  resolved: OperandInput,
): Result.Result<void, LlvmError> =>
  Result.gen(function* () {
    const index = yield* localIndex(draft, forwardValue, 'Value', 'Value.resolveForward', 'value')
    const value = draft.values[index]
    if (value === undefined || value.source._tag !== 'Forward') {
      return yield* Result.fail(
        invalidInput({
          operation: 'Value.resolveForward',
          message: 'Only a reserved forward value can be resolved',
          input: forwardValue,
        }),
      )
    }
    const source = value.source
    if (source.resolved !== undefined) {
      return yield* fail(
        'Value.resolveForward',
        'Forward value has already been resolved',
        forwardValue,
      )
    }
    const target = yield* resolveOperand(draft, module, resolved, 'Value.resolveForward')
    if (target.type !== value.type) {
      return yield* fail(
        'Value.resolveForward',
        'Forward value resolution has the wrong type',
        resolved,
      )
    }
    source.resolved = target.operand
  })

/** @internal */
export const valueType = (
  draft: Draft,
  value: ValueActor.Value,
): Result.Result<number, LlvmError> =>
  Result.gen(function* () {
    const index = yield* localIndex(draft, value, 'Value', 'Value.typeOf', 'value')
    const description = draft.values[index]
    if (description === undefined) {
      return yield* fail('Value.typeOf', 'Value table entry is missing', value)
    }
    return description.type
  })

/** @internal */
export const setValueName = (
  draft: Draft,
  value: ValueActor.Value,
  name: ByteString.ByteString | Uint8Array | string,
): Result.Result<void, LlvmError> =>
  Result.gen(function* () {
    const index = yield* localIndex(draft, value, 'Value', 'Value.setName', 'value')
    const description = draft.values[index]
    if (description === undefined) {
      return yield* Result.fail(
        invalidState({
          operation: 'Value.setName',
          message: 'Value table entry is missing',
          state: value,
        }),
      )
    }
    description.name = localName(draft, name)
    if (description.source._tag === 'Instruction') {
      const instruction = draft.instructions[description.source.instruction]
      if (instruction !== undefined) {
        draft.instructions[description.source.instruction] = {
          ...instruction,
          name: description.name,
        }
      }
    }
  })

/** @internal */
export const valueName = (
  draft: Draft,
  value: ValueActor.Value,
): Result.Result<ByteString.ByteString, LlvmError> =>
  Result.gen(function* () {
    const index = yield* localIndex(draft, value, 'Value', 'Value.name', 'value')
    const description = draft.values[index]
    if (description === undefined) {
      return yield* fail('Value.name', 'Value table entry is missing', value)
    }
    return description.name
  })

/** @internal */
export const valueInstruction = (
  draft: Draft,
  value: ValueActor.Value,
): Result.Result<FunctionBodyActor.Instruction | undefined, LlvmError> =>
  Result.gen(function* () {
    const index = yield* localIndex(draft, value, 'Value', 'Value.instruction', 'value')
    const source = draft.values[index]?.source
    return source?._tag === 'Instruction'
      ? yield* instructionHandleAt(draft, source.instruction, 'Value.instruction')
      : undefined
  })

/** @internal */
export const instructionResult = (
  draft: Draft,
  instruction: FunctionBodyActor.Instruction,
): Result.Result<ValueActor.Value | undefined, LlvmError> =>
  Result.gen(function* () {
    const index = yield* resolveInstruction(draft, instruction, 'FunctionBody.instructionResult')
    const result = draft.instructions[index]?.result
    return result === undefined
      ? undefined
      : yield* valueHandle(draft, result, 'FunctionBody.instructionResult')
  })

/** @internal */
export const makePhiHandle = (
  draft: Draft,
  index: number,
): Result.Result<FunctionBodyActor.Phi, LlvmError> => {
  draft.openPhis.set(index, { incoming: [], blocks: new Set() })
  return Result.succeed(Handle.make('Phi', draft.owner, index))
}

/** @internal */
export const makeSwitchHandle = (
  draft: Draft,
  instruction: FunctionBodyActor.Instruction,
  block: number,
): Result.Result<FunctionBodyActor.Switch, LlvmError> =>
  Result.gen(function* () {
    const index = yield* resolveInstruction(draft, instruction, 'FunctionBody.switchTerminator')
    const handle = Handle.make('Switch', draft.owner, index)
    draft.switchBlocks.set(index, block)
    return handle
  })

/** @internal */
export const validate = Effect.fn('FunctionBody.validate')(function* (
  self: FunctionBodyActor.FunctionBody,
): Effect.fn.Return<FunctionBodyDescription.Snapshot, LlvmError> {
  return yield* mutate(self, 'FunctionBody.validate', (draft) => validateDraft(draft, self))
})

/** Validates a finished draft and hands its tables to the committed snapshot. @internal */
export const validateDraft = (
  draft: Draft,
  self: unknown,
): Result.Result<FunctionBodyDescription.Snapshot, LlvmError> => {
  if (draft.blocks.length === 0) {
    return fail('FunctionBody.validate', 'A function body requires at least one block', self)
  }
  for (let blockIndex = 0; blockIndex < draft.blocks.length; blockIndex += 1) {
    const block = draft.blocks[blockIndex]
    if (block === undefined || block.instructions.length === 0) {
      return fail('FunctionBody.validate', 'Every block must contain a terminator', blockIndex)
    }
    const terminatorIndex = block.instructions.at(-1)
    const terminator =
      terminatorIndex === undefined ? undefined : draft.instructions[terminatorIndex]
    if (terminator === undefined || !FunctionBodyDescription.isTerminator(terminator)) {
      return fail(
        'FunctionBody.validate',
        'Every block must end in exactly one terminator',
        blockIndex,
      )
    }
    for (const instructionIndex of block.instructions) {
      const instruction = draft.instructions[instructionIndex]
      if (instruction === undefined) {
        return fail(
          'FunctionBody.validate',
          'Block references a missing instruction',
          instructionIndex,
        )
      }
      if (instruction._tag === 'Switch' && !instruction.sealed) {
        return fail(
          'FunctionBody.validate',
          'Switch construction was not finalized',
          instructionIndex,
        )
      }
      if (instruction._tag === 'Phi') {
        if (!instruction.sealed) {
          return fail(
            'FunctionBody.validate',
            'Phi construction was not finalized',
            instructionIndex,
          )
        }
        const incoming = new Set(instruction.incoming.map((entry) => entry.block))
        if (
          incoming.size !== block.predecessors.size ||
          [...block.predecessors].some((predecessor) => !incoming.has(predecessor))
        ) {
          return fail(
            'FunctionBody.validate',
            'Phi incoming blocks must cover every predecessor once',
            {
              block: blockIndex,
              predecessors: [...block.predecessors],
              incoming: [...incoming],
            },
          )
        }
      }
    }
  }
  const validated = validateInstructions(draft)
  if (Result.isFailure(validated)) return Result.fail(validated.failure)
  // The body commits right after validation and the draft is closed, so the snapshot takes
  // ownership of the draft's tables instead of copying them.
  return Result.succeed({
    arguments: draft.arguments,
    blocks: draft.blocks.map((block) => ({
      name: block.name,
      instructions: block.instructions,
      predecessors: [...block.predecessors].sort((left, right) => left - right),
    })),
    instructions: draft.instructions,
    values: draft.values,
    metadata: draft.metadata,
    debugLocations: draft.debugLocations,
  })
}

/** @internal */
export const snapshotDraft = (self: FunctionBodyActor.FunctionBody): Draft | undefined =>
  drafts.get(self)
