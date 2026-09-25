import * as Result from 'effect/Result'
import type * as BlockActor from '../../Block.js'
import type * as Builder from '../../Builder.js'
import type * as BuilderState from '../BuilderState.js'
import * as ByteString from '../../ByteString.js'
import type * as Constant from '../../Constant.js'
import type * as FunctionBodyActor from '../../FunctionBody.js'
import { invalidInput, type LlvmError } from '../../LlvmError.js'
import type * as ValueActor from '../../Value.js'
import type * as FunctionBodyDescription from '../FunctionBodyDescription.js'
import * as Handle from '../Handle.js'
import type * as MetadataDescription from '../MetadataDescription.js'
import type * as OwnedHandle from '../OwnedHandle.js'

export type OperandInput = ValueActor.Value | Constant.Constant

export interface MutableBlock {
  name: ByteString.ByteString
  instructions: Array<number>
  predecessors: Set<number>
}

export interface MutableValue {
  type: number
  name: ByteString.ByteString
  source:
    | { readonly _tag: 'Argument'; readonly index: number }
    | { readonly _tag: 'Instruction'; readonly instruction: number }
    | { _tag: 'Forward'; resolved: FunctionBodyDescription.Operand | undefined }
}

export interface Draft {
  readonly builder: Builder.Builder
  readonly moduleOwner: OwnedHandle.Owner
  readonly owner: OwnedHandle.Owner
  readonly functionIndex: number
  readonly functionType: number
  readonly returnType: number
  readonly creatorFiber: number
  status: 'active' | 'committed' | 'failed'
  cursor: number | undefined
  readonly arguments: Array<number>
  readonly blocks: Array<MutableBlock>
  readonly blockHandles: Array<BlockActor.Block>
  readonly instructions: Array<FunctionBodyDescription.Instruction>
  readonly openPhis: Map<
    number,
    {
      readonly incoming: Array<
        Extract<FunctionBodyDescription.Instruction, { readonly _tag: 'Phi' }>['incoming'][number]
      >
      readonly blocks: Set<number>
    }
  >
  /** Instruction handles, minted on first request for result-producing instructions. */
  readonly instructionHandles: Array<FunctionBodyActor.Instruction | undefined>
  /** Containing block of each switch terminator, keyed by instruction index. */
  readonly switchBlocks: Map<number, number>
  /** One shared operand per local value; instruction descriptions retain operands. */
  readonly localOperands: Array<FunctionBodyDescription.Operand | undefined>
  /** The owning builder's module state; a body only exists inside that builder. */
  readonly module: BuilderState.MutableState
  readonly context: BuilderState.Context
  readonly values: Array<MutableValue>
  readonly valueHandles: Array<ValueActor.Value>
  readonly metadata: Array<ReadonlyArray<MetadataDescription.Attachment>>
  readonly debugLocations: Array<number | undefined>
}

/** Shared empty attachment list; attaching metadata replaces an instruction's list. */
export const noAttachments: ReadonlyArray<MetadataDescription.Attachment> = []

export const drafts = new WeakMap<FunctionBodyActor.FunctionBody, Draft>()

/**
 * Encodes a local value or block name, sharing one encoding per distinct string: emitted names
 * repeat across functions, and every body retains its names until bitcode encoding.
 *
 * @internal
 */
export const localName = (
  draft: Draft,
  name: ByteString.ByteString | Uint8Array | string | undefined,
): ByteString.ByteString => {
  if (typeof name !== 'string') return ByteString.coerceOrEmpty(name)
  let encoded = draft.module.localNames.get(name)
  if (encoded === undefined) {
    encoded = ByteString.fromString(name)
    draft.module.localNames.set(name, encoded)
  }
  return encoded
}

/** @internal */
export const fail = (
  operation: string,
  message: string,
  cause: unknown,
): Result.Result<never, LlvmError> =>
  Result.fail(invalidInput({ operation, message, input: cause }))

/** @internal */
export const assertActive = (
  draft: Draft,
  fiber: number,
  operation: string,
): Result.Result<void, LlvmError> => {
  if (draft.status !== 'active') {
    return fail(operation, 'The function-body draft is no longer active', draft.status)
  }
  if (draft.creatorFiber !== fiber) {
    return fail(operation, 'The function-body draft cannot be used from another fiber', {
      expected: draft.creatorFiber,
      actual: fiber,
    })
  }
  return Result.void
}

/**
 * Resolves a body-local handle (block, instruction, value, phi, or switch) to its draft index.
 *
 * @internal
 */
export const localIndex = <Tag extends string>(
  draft: Draft,
  handle: Handle.Handle<Tag>,
  tag: Tag,
  operation: string,
  kind: string,
): Result.Result<number, LlvmError> => {
  const owner = Handle.ownerOf(handle)
  const index = Handle.indexOf(handle)
  if (owner === undefined || index === undefined || handle._tag !== tag) {
    return fail(operation, `Unknown ${kind} handle`, handle)
  }
  if (owner !== draft.owner) {
    return fail(operation, `The ${kind} handle belongs to a different function body`, handle)
  }
  return Result.succeed(index)
}
