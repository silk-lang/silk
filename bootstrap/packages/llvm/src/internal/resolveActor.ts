import * as Result from 'effect/Result'
import type * as Builder from '../Builder.js'
import type { LlvmError } from '../LlvmError.js'
import * as Handle from './Handle.js'
import type * as OwnedHandle from './OwnedHandle.js'
import * as Table from './Table.js'

/**
 * Resolves a builder-owned handle to its stable index and table description —
 * the ownership check plus description lookup hand-copied across every actor.
 *
 * @internal
 */
export const resolve = <D, Tag extends string>(
  builder: Builder.Builder,
  owner: OwnedHandle.Owner,
  handle: Handle.Handle<Tag>,
  tag: Tag,
  table: Table.Table<D, Handle.Handle<Tag>>,
  operation: string,
): Result.Result<{ readonly index: number; readonly description: D }, LlvmError> =>
  Result.gen(function* () {
    const index = yield* Handle.resolve(builder, owner, handle, tag, operation)
    const description = yield* Table.descriptionAt(table, index, operation, tag)
    return { index, description }
  })
