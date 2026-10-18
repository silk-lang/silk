import * as Effect from 'effect/Effect'
import * as Result from 'effect/Result'
import type * as ByteString from './ByteString.js'
import type * as Constant from './Constant.js'
import type * as FunctionBody from './FunctionBody.js'
import * as FunctionBodyState from './internal/FunctionBodyState.js'
import * as Handle from './internal/Handle.js'
import { invalidState, type LlvmError } from './LlvmError.js'
import type * as Type from './Type.js'

/**
 * Opaque identity for an SSA value scoped to one function-body transaction.
 *
 * @category values
 * @since 0.0.0
 */
export interface Value extends Handle.Handle<'Value'> {}

/**
 * Any operand accepted by instruction builders: a local SSA value or module constant.
 *
 * @category values
 * @since 0.0.0
 */
export type Input = Value | Constant.Constant

/**
 * Returns a function parameter by zero-based signature index.
 *
 * @category values
 * @since 0.0.0
 */
export const argument = (
  body: FunctionBody.FunctionBody,
  index: number,
): Effect.Effect<Value, LlvmError> =>
  FunctionBodyState.mutate(body, 'Value.argument', (draft) =>
    FunctionBodyState.argument(draft, index),
  )

/**
 * Allocates a typed forward value for loop-carried or otherwise not-yet-built SSA references.
 *
 * **Gotchas**
 *
 * Every reachable forward must be resolved exactly once before the function commits.
 *
 * The type must belong to the body transaction's builder. Foreign types and invalid body scope fail
 * with {@link LlvmError}; JavaScript names are encoded as UTF-8.
 *
 * **Example** (Resolving a loop-carried value)
 *
 * Reference a loop's next value from a phi before the producing instruction exists.
 *
 * ```ts
 * import * as Effect from 'effect/Effect'
 * import * as Block from '@silklang/llvm/Block'
 * import * as Builder from '@silklang/llvm/Builder'
 * import * as Constant from '@silklang/llvm/Constant'
 * import * as FunctionActor from '@silklang/llvm/Function'
 * import * as FunctionBody from '@silklang/llvm/FunctionBody'
 * import * as Type from '@silklang/llvm/Type'
 * import * as Value from '@silklang/llvm/Value'
 *
 * await Effect.runPromise(Effect.gen(function* () {
 *   const builder = yield* Builder.make()
 *   const i1 = yield* Type.integer(builder, 1)
 *   const i32 = yield* Type.integer(builder, 32)
 *   const signature = yield* Type.functionType(builder, i32, [i32])
 *   const loopFunction = yield* FunctionActor.declare(builder, 'loop_once', signature)
 *   const stop = yield* Constant.integerUnsigned(builder, i1, 0)
 *   const one = yield* Constant.integerUnsigned(builder, i32, 1)
 *   yield* FunctionActor.buildBody(
 *     builder,
 *     loopFunction,
 *     Effect.fnUntraced(function* (body) {
 *       const entry = yield* Block.make(body, 'entry')
 *       const loop = yield* Block.make(body, 'loop')
 *       const exit = yield* Block.make(body, 'exit')
 *       const initial = yield* Value.argument(body, 0)
 *       yield* FunctionBody.branch(body, loop)
 *
 *       yield* Block.setInsertionPoint(body, loop)
 *       const nextForward = yield* Value.forward(body, i32, 'next_forward')
 *       const phi = yield* FunctionBody.phi(body, i32, 'current')
 *       yield* FunctionBody.addPhiIncoming(body, phi, initial, entry)
 *       yield* FunctionBody.addPhiIncoming(body, phi, nextForward, loop)
 *       const next = yield* FunctionBody.binary(
 *         body,
 *         'add',
 *         yield* FunctionBody.phiValue(body, phi),
 *         one,
 *         'next',
 *       )
 *       yield* Value.resolveForward(body, nextForward, next)
 *       yield* FunctionBody.conditionalBranch(body, stop, loop, exit)
 *       yield* FunctionBody.sealPhi(body, phi)
 *
 *       yield* Block.setInsertionPoint(body, exit)
 *       yield* FunctionBody.returnValue(body, next)
 *     }),
 *   )
 * }))
 * ```
 *
 * @category values
 * @since 0.0.0
 */
export const forward = Effect.fnUntraced(function* (
  body: FunctionBody.FunctionBody,
  type: Type.Type,
  name?: ByteString.ByteString | Uint8Array | string,
): Effect.fn.Return<Value, LlvmError> {
  return yield* FunctionBodyState.mutateModule(body, 'Value.forward', (draft) =>
    Result.gen(function* () {
      return FunctionBodyState.forward(
        draft,
        yield* Handle.resolve(draft.builder, draft.moduleOwner, type, 'Type', 'Value.forward'),
        name,
      )
    }),
  )
})

/**
 * Resolves a forward value to a same-typed local value or constant exactly once.
 *
 * @category values
 * @since 0.0.0
 */
export const resolveForward = Effect.fnUntraced(function* (
  body: FunctionBody.FunctionBody,
  self: Value,
  resolved: Input,
): Effect.fn.Return<void, LlvmError> {
  yield* FunctionBodyState.mutateModule(body, 'Value.resolveForward', (draft, module) =>
    FunctionBodyState.resolveForward(draft, module, self, resolved),
  )
})

/**
 * Reads the module type of a local SSA value.
 *
 * @category values
 * @since 0.0.0
 */
export const typeOf = Effect.fnUntraced(function* (
  body: FunctionBody.FunctionBody,
  self: Value,
): Effect.fn.Return<Type.Type, LlvmError> {
  return yield* FunctionBodyState.mutateModule(body, 'Value.typeOf', (draft, module) =>
    Result.gen(function* () {
      const type = module.types.handles[yield* FunctionBodyState.valueType(draft, self)]
      if (type === undefined) {
        return yield* Result.fail(
          invalidState({
            operation: 'Value.typeOf',
            message: 'Value type handle is missing',
            state: self,
          }),
        )
      }
      return type
    }),
  )
})

/**
 * Reads a value's optional byte-exact local name.
 *
 * @category values
 * @since 0.0.0
 */
export const name = Effect.fnUntraced(function* (
  body: FunctionBody.FunctionBody,
  self: Value,
): Effect.fn.Return<ByteString.ByteString, LlvmError> {
  return yield* FunctionBodyState.mutate(body, 'Value.name', (draft) =>
    FunctionBodyState.valueName(draft, self),
  )
})

/**
 * Changes a value's local name after validating function ownership and uniqueness rules.
 *
 * @category values
 * @since 0.0.0
 */
export const setName = Effect.fnUntraced(function* (
  body: FunctionBody.FunctionBody,
  self: Value,
  name: ByteString.ByteString | Uint8Array | string,
): Effect.fn.Return<void, LlvmError> {
  yield* FunctionBodyState.mutate(body, 'Value.setName', (draft) =>
    FunctionBodyState.setValueName(draft, self, name),
  )
})

/**
 * Returns the producing instruction, or `undefined` for arguments and forward-only values.
 *
 * @category values
 * @since 0.0.0
 */
export const instruction = (
  body: FunctionBody.FunctionBody,
  self: Value,
): Effect.Effect<FunctionBody.Instruction | undefined, LlvmError> =>
  FunctionBodyState.mutate(body, 'Value.instruction', (draft) =>
    FunctionBodyState.valueInstruction(draft, self),
  )
