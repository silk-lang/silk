import * as Result from 'effect/Result'
import type * as Builder from '../Builder.js'
import { invalidState, type LlvmError } from '../LlvmError.js'
import type * as OwnedHandle from './OwnedHandle.js'

const HandleTypeId: unique symbol = Symbol.for('@silklang/llvm/internal/Handle')

export interface Handle<Tag extends string> {
  readonly _tag: Tag
  readonly [HandleTypeId]: typeof HandleTypeId
}

/**
 * Handles carry their owner and table index in private fields instead of a global `WeakMap`
 * registry: every emitted instruction mints value and instruction handles, and the self-hosted
 * compiler build profile showed the registry's ephemeron bookkeeping as a large share of
 * backend garbage-collection time. Private fields stay invisible to callers and to structural
 * equality, and only this module can read them.
 */
class HandleValue<Tag extends string> implements Handle<Tag> {
  readonly [HandleTypeId]: typeof HandleTypeId = HandleTypeId
  readonly #owner: OwnedHandle.Owner
  readonly #index: number

  constructor(
    readonly _tag: Tag,
    owner: OwnedHandle.Owner,
    index: number,
  ) {
    this.#owner = owner
    this.#index = index
  }

  static owner(handle: object): OwnedHandle.Owner | undefined {
    return #owner in handle ? handle.#owner : undefined
  }

  static index(handle: object): number | undefined {
    return #index in handle ? handle.#index : undefined
  }
}

/** @internal */
export const make = <Tag extends string>(
  tag: Tag,
  owner: OwnedHandle.Owner,
  index: number,
): Handle<Tag> => new HandleValue(tag, owner, index)

/** @internal */
export const ownerOf = (handle: object): OwnedHandle.Owner | undefined => HandleValue.owner(handle)

/** @internal */
export const indexOf = (handle: object): number | undefined => HandleValue.index(handle)

/** @internal */
export const resolve = <Tag extends string>(
  builder: Builder.Builder,
  owner: OwnedHandle.Owner,
  handle: Handle<Tag>,
  tag: Tag,
  operation: string,
): Result.Result<number, LlvmError> => {
  const handleOwner = HandleValue.owner(handle)
  const index = HandleValue.index(handle)
  if (handleOwner === undefined || index === undefined || handle._tag !== tag) {
    return Result.fail(invalidState({ operation, message: `Unknown ${tag} handle`, state: handle }))
  }
  if (handleOwner.token !== owner.token) {
    return Result.fail(
      invalidState({
        operation,
        message: `The ${tag} handle belongs to a different LLVM builder`,
        state: { builder, handle },
      }),
    )
  }
  return Result.succeed(index)
}
