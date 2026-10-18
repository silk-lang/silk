import * as Effect from 'effect/Effect'
import * as Result from 'effect/Result'
import * as Constant from '../Constant.js'
import * as FunctionBodyState from '../internal/FunctionBodyState.js'
import { invalidInput, invalidState, type LlvmError } from '../LlvmError.js'
import * as Metadata from '../Metadata.js'
import * as Type from '../Type.js'
import type { FunctionBody, Instruction } from './_internal.js'

/**
 * Replaces one supported metadata attachment on a non-terminator or terminator instruction.
 *
 * @category instructions
 * @since 0.0.0
 */
export const attachMetadata = Effect.fnUntraced(function* (
  self: FunctionBody,
  instruction: Instruction,
  kind: 'dbg' | 'prof' | 'unpredictable',
  metadata: Metadata.Optional,
): Effect.fn.Return<void, LlvmError> {
  yield* FunctionBodyState.mutateModule(self, 'FunctionBody.attachMetadata', (draft, module) =>
    Result.gen(function* () {
      if (module.strip || metadata === undefined) return
      const instructionIndex = yield* FunctionBodyState.resolveInstruction(
        draft,
        instruction,
        'FunctionBody.attachMetadata',
      )
      const metadataIndex = yield* Metadata.resolveIndex(
        draft.builder,
        module,
        draft.moduleOwner,
        metadata,
        'FunctionBody.attachMetadata',
      )
      if (metadataIndex === undefined) return
      const attachments = draft.metadata[instructionIndex]
      if (attachments === undefined) {
        return yield* Result.fail(
          invalidState({
            operation: 'FunctionBody.attachMetadata',
            message: 'Instruction metadata table entry is missing',
            state: instruction,
          }),
        )
      }
      const next = attachments.filter((attachment) => attachment.kind !== kind)
      next.push({ kind, metadata: metadataIndex })
      draft.metadata[instructionIndex] = next
    }),
  )
})

/**
 * Sets or clears an instruction debug location, doing nothing when metadata stripping is enabled.
 *
 * @category instructions
 * @since 0.0.0
 */
export const setDebugLocation = (
  self: FunctionBody,
  instruction: Instruction,
  location: Metadata.Optional,
): Effect.Effect<void, LlvmError> =>
  FunctionBodyState.mutate(self, 'FunctionBody.setDebugLocation', (draft) =>
    setDebugLocationIn(draft, instruction, location),
  )

/** @internal */
export const setDebugLocationIn = (
  draft: FunctionBodyState.Draft,
  instruction: Instruction,
  location: Metadata.Optional,
): Result.Result<void, LlvmError> => {
  const module = draft.module
  return Result.gen(function* () {
    if (module.strip) return
    const instructionIndex = yield* FunctionBodyState.resolveInstruction(
      draft,
      instruction,
      'FunctionBody.setDebugLocation',
    )
    const metadataIndex = yield* Metadata.resolveIndex(
      draft.builder,
      module,
      draft.moduleOwner,
      location,
      'FunctionBody.setDebugLocation',
    )
    if (metadataIndex !== undefined) {
      const entry = module.metadata.entries.descriptions[metadataIndex]
      if (
        entry?._tag !== 'Forward' &&
        (entry?._tag !== 'Node' || entry.value._tag !== 'Location')
      ) {
        return yield* Result.fail(
          invalidInput({
            operation: 'FunctionBody.setDebugLocation',
            message:
              'Instruction debug location must be a DILocation or a compatible forward reference',
            input: location,
          }),
        )
      }
    }
    draft.debugLocations[instructionIndex] = metadataIndex
  })
}

/**
 * Attaches non-negative 32-bit branch weights to a conditional branch or switch.
 *
 * @category instructions
 * @since 0.0.0
 */
export const setBranchWeights = Effect.fnUntraced(function* (
  self: FunctionBody,
  instruction: Instruction,
  weights: ReadonlyArray<number>,
): Effect.fn.Return<void, LlvmError> {
  if (
    weights.length < 2 ||
    weights.some((weight) => !Number.isSafeInteger(weight) || weight < 0 || weight > 0xffff_ffff)
  ) {
    return yield* invalidInput({
      operation: 'FunctionBody.setBranchWeights',
      message: 'Branch weights require at least two unsigned 32-bit integers',
      input: weights,
    })
  }
  const builder = yield* FunctionBodyState.builder(self)
  const i32 = yield* Type.integer(builder, 32)
  const label = yield* Metadata.string(builder, 'branch_weights')
  const values: Array<Metadata.Metadata> = [label]
  for (const weight of weights) {
    const value = yield* Constant.integerUnsigned(builder, i32, weight)
    values.push(yield* Metadata.constant(builder, value))
  }
  const node = yield* Metadata.tuple(builder, values)
  yield* attachMetadata(self, instruction, 'prof', node)
})

/**
 * Marks a conditional branch or switch with LLVM's `unpredictable` metadata.
 *
 * @category instructions
 * @since 0.0.0
 */
export const setUnpredictable = Effect.fnUntraced(function* (
  self: FunctionBody,
  instruction: Instruction,
): Effect.fn.Return<void, LlvmError> {
  const builder = yield* FunctionBodyState.builder(self)
  yield* attachMetadata(self, instruction, 'unpredictable', yield* Metadata.emptyTuple(builder))
})
