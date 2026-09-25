import * as Result from 'effect/Result'
import * as FastMathActor from '../FastMath.js'
import type * as BuilderState from '../internal/BuilderState.js'
import type * as FunctionBodyDescription from '../internal/FunctionBodyDescription.js'
import * as FunctionBodyState from '../internal/FunctionBodyState.js'
import type * as Handle from '../internal/Handle.js'
import { invalidInput, type LlvmError } from '../LlvmError.js'
import type * as Value from '../Value.js'

/**
 * Ephemeral body transaction passed only to {@link FunctionActor.buildBody}.
 *
 * @category instructions
 * @since 0.0.0
 */
export interface FunctionBody extends Handle.Handle<'FunctionBody'> {}

/**
 * Opaque identity for an instruction in the current body transaction.
 *
 * @category instructions
 * @since 0.0.0
 */
export interface Instruction extends Handle.Handle<'Instruction'> {}

/**
 * Immutable fast-math flags accepted by floating instructions.
 *
 * @category instructions
 * @since 0.0.0
 */
export type FastMath = FastMathActor.FastMath

/**
 * Boolean shorthand or partial fast-math settings.
 *
 * @category instructions
 * @since 0.0.0
 */
export type FastMathInput = FastMathActor.Input

export const fastMath = FastMathActor.make

/** @internal */
export const sameOperands = (
  draft: FunctionBodyState.Draft,
  module: BuilderState.MutableState,
  left: Value.Input,
  right: Value.Input,
  operation: string,
): Result.Result<
  {
    readonly leftValue: { readonly operand: FunctionBodyDescription.Operand; readonly type: number }
    readonly rightValue: {
      readonly operand: FunctionBodyDescription.Operand
      readonly type: number
    }
  },
  LlvmError
> => {
  const leftValue = FunctionBodyState.resolveOperand(draft, module, left, operation)
  if (Result.isFailure(leftValue)) return Result.fail(leftValue.failure)
  const rightValue = FunctionBodyState.resolveOperand(draft, module, right, operation)
  if (Result.isFailure(rightValue)) return Result.fail(rightValue.failure)
  if (leftValue.success.type !== rightValue.success.type) {
    return Result.fail(
      invalidInput({
        operation,
        message: 'Instruction operands must have one LLVM type',
        input: { left, right },
      }),
    )
  }
  return Result.succeed({ leftValue: leftValue.success, rightValue: rightValue.success })
}
