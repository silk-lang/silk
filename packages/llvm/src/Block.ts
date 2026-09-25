import * as Effect from 'effect/Effect'
import * as Result from 'effect/Result'
import type * as ByteString from './ByteString.js'
import type * as FunctionBody from './FunctionBody.js'
import * as FunctionBodyState from './internal/FunctionBodyState.js'
import type * as Handle from './internal/Handle.js'
import { invalidState, type LlvmError } from './LlvmError.js'

/**
 * Opaque identity for a basic block inside one open function-body transaction.
 *
 * @category blocks
 * @since 0.0.0
 */
export interface Block extends Handle.Handle<'Block'> {}

/**
 * Creates a basic block in declaration order inside an open function-body transaction.
 *
 * **Details**
 *
 * The first block becomes the insertion point automatically. Later blocks are created without
 * moving that point; call {@link setInsertionPoint} before appending their instructions. Every
 * created block must have a terminator before the enclosing `Function.buildBody` can commit.
 *
 * JavaScript labels are encoded as UTF-8; byte strings preserve an exact block label.
 *
 * **Gotchas**
 *
 * A closed body or a body used from a different fiber fails with {@link LlvmError}.
 *
 * **Example** (Building multiple blocks)
 *
 * Create two blocks and terminate both before committing the function.
 *
 * ```ts
 * import * as Effect from 'effect/Effect'
 * import * as Block from '@silklang/llvm/Block'
 * import * as Builder from '@silklang/llvm/Builder'
 * import * as FunctionActor from '@silklang/llvm/Function'
 * import * as FunctionBody from '@silklang/llvm/FunctionBody'
 * import * as Type from '@silklang/llvm/Type'
 *
 * await Effect.runPromise(Effect.gen(function* () {
 *   const builder = yield* Builder.make()
 *   const voidType = yield* Type.voidType(builder)
 *   const signature = yield* Type.functionType(builder, voidType, [])
 *   const fn = yield* FunctionActor.declare(builder, 'two_blocks', signature)
 *   yield* FunctionActor.buildBody(builder, fn, Effect.fnUntraced(function* (body) {
 *     yield* Block.make(body, 'entry')
 *     const exit = yield* Block.make(body, 'exit')
 *     yield* FunctionBody.branch(body, exit)
 *     yield* Block.setInsertionPoint(body, exit)
 *     yield* FunctionBody.returnVoid(body)
 *   }))
 * }))
 * ```
 *
 * @category blocks
 * @since 0.0.0
 */
export const make = (
  body: FunctionBody.FunctionBody,
  name?: ByteString.ByteString | Uint8Array | string,
): Effect.Effect<Block, LlvmError> =>
  FunctionBodyState.mutate(body, 'Block.make', (draft) =>
    Result.succeed(FunctionBodyState.makeBlock(draft, name)),
  )

/**
 * Directs subsequent instructions to this non-terminated block.
 *
 * @category blocks
 * @since 0.0.0
 */
export const setInsertionPoint = (
  body: FunctionBody.FunctionBody,
  self: Block,
): Effect.Effect<void, LlvmError> =>
  FunctionBodyState.mutate(body, 'Block.setInsertionPoint', (draft) =>
    FunctionBodyState.setCursor(draft, self),
  )

/**
 * Returns the block's zero-based function-local index.
 *
 * @category blocks
 * @since 0.0.0
 */
export const index = Effect.fnUntraced(function* (
  body: FunctionBody.FunctionBody,
  self: Block,
): Effect.fn.Return<number, LlvmError> {
  return yield* FunctionBodyState.mutate(body, 'Block.index', (draft) =>
    FunctionBodyState.resolveBlock(draft, self, 'Block.index'),
  )
})

/**
 * Reads the block's byte-exact optional label.
 *
 * @category blocks
 * @since 0.0.0
 */
export const name = Effect.fnUntraced(function* (
  body: FunctionBody.FunctionBody,
  self: Block,
): Effect.fn.Return<ByteString.ByteString, LlvmError> {
  return yield* FunctionBodyState.mutate(body, 'Block.name', (draft) =>
    Result.gen(function* () {
      const block = draft.blocks[yield* FunctionBodyState.resolveBlock(draft, self, 'Block.name')]
      if (block === undefined) {
        return yield* Result.fail(
          invalidState({
            operation: 'Block.name',
            message: 'Block table entry is missing',
            state: self,
          }),
        )
      }
      return block.name
    }),
  )
})

/**
 * Returns predecessor blocks discovered from committed terminators in stable index order.
 *
 * @category blocks
 * @since 0.0.0
 */
export const predecessors = Effect.fnUntraced(function* (
  body: FunctionBody.FunctionBody,
  self: Block,
): Effect.fn.Return<ReadonlyArray<Block>, LlvmError> {
  return yield* FunctionBodyState.mutate(body, 'Block.predecessors', (draft) =>
    Result.gen(function* () {
      const block =
        draft.blocks[yield* FunctionBodyState.resolveBlock(draft, self, 'Block.predecessors')]
      if (block === undefined) {
        return yield* Result.fail(
          invalidState({
            operation: 'Block.predecessors',
            message: 'Block table entry is missing',
            state: self,
          }),
        )
      }
      return [...block.predecessors].flatMap((index) => {
        const handle = draft.blockHandles[index]
        return handle === undefined ? [] : [handle]
      })
    }),
  )
})
