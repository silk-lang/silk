import * as Result from 'effect/Result'
import { invalidInput, type LlvmError } from '../LlvmError.js'

export interface Options {
  readonly operation: string
  readonly message: string
  readonly minimum?: bigint
  readonly maximum?: bigint
}

/** @internal */
export const normalize = (
  input: number | bigint,
  options: Options,
): Result.Result<bigint, LlvmError> => {
  if (typeof input === 'number' && !Number.isSafeInteger(input)) {
    return Result.fail(
      invalidInput({ operation: options.operation, message: options.message, input }),
    )
  }
  const value = typeof input === 'bigint' ? input : BigInt(input)
  if (
    (options.minimum !== undefined && value < options.minimum) ||
    (options.maximum !== undefined && value > options.maximum)
  ) {
    return Result.fail(
      invalidInput({ operation: options.operation, message: options.message, input }),
    )
  }
  return Result.succeed(value)
}

/** @internal */
export const normalizeAll = (
  inputs: ReadonlyArray<number | bigint>,
  options: Options,
): Result.Result<ReadonlyArray<bigint>, LlvmError> => {
  const values: Array<bigint> = []
  for (const input of inputs) {
    const result = normalize(input, options)
    if (Result.isFailure(result)) return Result.fail(result.failure)
    values.push(result.success)
  }
  return Result.succeed(values)
}
