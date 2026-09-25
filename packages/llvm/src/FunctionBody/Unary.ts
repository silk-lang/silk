import * as Effect from 'effect/Effect'
import * as Result from 'effect/Result'
import type * as ByteString from '../ByteString.js'
import * as FunctionBodyState from '../internal/FunctionBodyState.js'
import { invalidInput, type LlvmError } from '../LlvmError.js'
import type * as Value from '../Value.js'
import { type FastMathInput, type FunctionBody, fastMath } from './_internal.js'

/**
 * Appends floating-point negation after scalar/vector type validation.
 *
 * @category instructions
 * @since 0.0.0
 */
export const unary = (
  self: FunctionBody,
  kind: 'fneg',
  operand: Value.Input,
  name?: ByteString.ByteString | Uint8Array | string,
  options: { readonly fastMath?: FastMathInput } = {},
): Effect.Effect<Value.Value, LlvmError> =>
  FunctionBodyState.mutate(self, 'FunctionBody.unary', (draft) =>
    unaryIn(draft, kind, operand, name, options),
  )

/** @internal */
export const unaryIn = (
  draft: FunctionBodyState.Draft,
  kind: 'fneg',
  operand: Value.Input,
  name?: ByteString.ByteString | Uint8Array | string,
  options: { readonly fastMath?: FastMathInput } = {},
): Result.Result<Value.Value, LlvmError> => {
  const module = draft.module
  return Result.gen(function* () {
    const resolved = yield* FunctionBodyState.resolveOperand(
      draft,
      module,
      operand,
      'FunctionBody.unary',
    )
    if (!(yield* FunctionBodyState.isFloatingType(module, resolved.type, 'FunctionBody.unary'))) {
      return yield* Result.fail(
        invalidInput({
          operation: 'FunctionBody.unary',
          message: 'fneg requires a floating-point scalar or vector',
          input: operand,
        }),
      )
    }
    return yield* FunctionBodyState.appendResult(
      draft,
      resolved.type,
      name,
      (result, finalName) => ({
        _tag: 'Unary',
        kind,
        operand: resolved.operand,
        fastMath: fastMath(options.fastMath),
        result,
        name: finalName,
      }),
    )
  })
}

/**
 * Replaces an undefined or poison operand with an arbitrary stable value of the same type.
 *
 * This is useful at observation boundaries that must safely materialize every lane of a value
 * whose inactive representation lanes are intentionally unspecified.
 *
 * @category instructions
 * @since 0.0.0
 */
export const freeze = (
  self: FunctionBody,
  operand: Value.Input,
  name?: ByteString.ByteString | Uint8Array | string,
): Effect.Effect<Value.Value, LlvmError> =>
  FunctionBodyState.mutate(self, 'FunctionBody.freeze', (draft) => freezeIn(draft, operand, name))

/** @internal */
export const freezeIn = (
  draft: FunctionBodyState.Draft,
  operand: Value.Input,
  name?: ByteString.ByteString | Uint8Array | string,
): Result.Result<Value.Value, LlvmError> => {
  const module = draft.module
  return Result.gen(function* () {
    const resolved = yield* FunctionBodyState.resolveOperand(
      draft,
      module,
      operand,
      'FunctionBody.freeze',
    )
    return yield* FunctionBodyState.appendResult(
      draft,
      resolved.type,
      name,
      (result, finalName) => ({
        _tag: 'Freeze',
        operand: resolved.operand,
        result,
        name: finalName,
      }),
    )
  })
}
