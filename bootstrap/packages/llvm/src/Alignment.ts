import * as Effect from 'effect/Effect'
import * as Result from 'effect/Result'
import * as IntegerInput from './internal/IntegerInput.js'
import { invalidInput, type LlvmError } from './LlvmError.js'

/**
 * A power-of-two LLVM alignment measured in bytes, or the target default.
 *
 * @category alignment
 * @since 0.0.0
 */
export interface Alignment {
  readonly _tag: 'Alignment'
  readonly byteUnits: bigint | undefined
}

/**
 * Selects the target's implicit alignment instead of forcing a byte boundary.
 *
 * @category alignment
 * @since 0.0.0
 */
export const defaultAlignment: Alignment = {
  _tag: 'Alignment',
  byteUnits: undefined,
}

/** @internal */
const isPowerOfTwo = (value: bigint): boolean => value > 0n && (value & (value - 1n)) === 0n

/**
 * Constructs an explicit power-of-two alignment measured in bytes.
 *
 * **Details**
 *
 * Use `bigint` when the byte count is not safely representable as a JavaScript number.
 *
 * **Gotchas**
 *
 * Zero and values that are not powers of two fail with {@link LlvmError}.
 *
 * **Example** (Creating an explicit alignment)
 *
 * ```ts
 * import * as Effect from 'effect/Effect'
 * import * as Alignment from '@silklang/llvm/Alignment'
 *
 * const alignment = await Effect.runPromise(Alignment.fromByteUnits(16))
 * // Alignment.render(alignment) === '16'
 * ```
 *
 * @category alignment
 * @since 0.0.0
 */
export const fromByteUnits = (byteUnits: number | bigint): Effect.Effect<Alignment, LlvmError> =>
  Effect.fromResult(fromByteUnitsResult(byteUnits))

/** @internal */
export const fromByteUnitsResult = (
  byteUnits: number | bigint,
): Result.Result<Alignment, LlvmError> => {
  const value = IntegerInput.normalize(byteUnits, {
    operation: 'Alignment.fromByteUnits',
    message: 'LLVM alignment must be a positive power of two',
    minimum: 1n,
  })
  if (Result.isFailure(value)) return Result.fail(value.failure)
  if (!isPowerOfTwo(value.success)) {
    return Result.fail(
      invalidInput({
        operation: 'Alignment.fromByteUnits',
        message: 'LLVM alignment must be a positive power of two',
        input: byteUnits,
      }),
    )
  }
  return Result.succeed({ _tag: 'Alignment', byteUnits: value.success })
}

/**
 * Converts a positive, byte-sized bit alignment into an {@link Alignment}.
 *
 * @category alignment
 * @since 0.0.0
 */
export const fromBitUnits = Effect.fnUntraced(function* (
  bitUnits: number,
): Effect.fn.Return<Alignment, LlvmError> {
  if (!Number.isSafeInteger(bitUnits) || bitUnits < 8 || bitUnits % 8 !== 0) {
    return yield* invalidInput({
      operation: 'Alignment.fromBitUnits',
      message: 'LLVM bit alignment must be a positive whole number of bytes',
      input: bitUnits,
    })
  }
  return yield* fromByteUnits(BigInt(bitUnits / 8))
})

/**
 * Returns the explicit byte count, or `undefined` for {@link defaultAlignment}.
 *
 * @category alignment
 * @since 0.0.0
 */
export const toByteUnits = (self: Alignment): bigint | undefined => self.byteUnits

/**
 * Orders default alignment before explicit alignments, then compares explicit byte counts.
 *
 * @category alignment
 * @since 0.0.0
 */
export const compare = (self: Alignment, other: Alignment): number => {
  if (self.byteUnits === other.byteUnits) return 0
  if (self.byteUnits === undefined) return -1
  if (other.byteUnits === undefined) return 1
  return self.byteUnits < other.byteUnits ? -1 : 1
}

/**
 * Renders the byte count expected after LLVM's `align` keyword, or an empty string for default.
 *
 * @category alignment
 * @since 0.0.0
 */
export const render = (self: Alignment): string =>
  self.byteUnits === undefined ? '' : self.byteUnits.toString()
