import * as Data from 'effect/Data'

/** Describes caller input rejected by an LLVM operation. */
export interface InvalidInput {
  readonly _tag: 'InvalidInput'
  readonly input: unknown
}

/** Describes an invalid builder state, handle, ownership relation, or transaction state. */
export interface InvalidState {
  readonly _tag: 'InvalidState'
  readonly state: unknown
}

/** Describes an underlying JavaScript failure caught at an LLVM boundary. */
export interface WrappedFailure {
  readonly _tag: 'WrappedFailure'
  readonly cause: unknown
}

/** Semantic reason for an expected LLVM operation failure. */
export type Reason = InvalidInput | InvalidState | WrappedFailure

export interface Options {
  readonly operation: string
  readonly message: string
  readonly reason: Reason
}

interface TaggedFields extends Options {
  readonly cause?: unknown
}

/**
 * The typed failure channel shared by every effectful LLVM operation.
 *
 * **Details**
 *
 * `operation` identifies the actor function that rejected the request and `message` provides stable
 * human context. `reason` distinguishes invalid input, invalid state or ownership, and a wrapped
 * implementation failure. Only a wrapped failure populates JavaScript's `cause` property.
 *
 * **Example** (Recovering from validation failure)
 *
 * ```ts
 * import * as Effect from 'effect/Effect'
 * import * as AddrSpace from '@silklang/llvm/AddrSpace'
 *
 * const description = await Effect.runPromise(
 *   AddrSpace.make(-1).pipe(
 *     Effect.map((space) => `address space ${space.value}`),
 *     Effect.catchTag('LlvmError', (error) =>
 *       Effect.succeed(`${error.operation}: ${error.message}`),
 *     ),
 *   ),
 * )
 * // description starts with 'AddrSpace.make:'
 * ```
 *
 * @category errors
 * @since 0.0.0
 */
export class LlvmError extends Data.TaggedError('LlvmError')<TaggedFields> {
  constructor(options: Options) {
    super(
      options.reason._tag === 'WrappedFailure'
        ? { ...options, cause: options.reason.cause }
        : options,
    )
  }
}

/** Constructs an LLVM failure for rejected caller input. */
export const invalidInput = (options: {
  readonly operation: string
  readonly message: string
  readonly input: unknown
}): LlvmError =>
  new LlvmError({
    operation: options.operation,
    message: options.message,
    reason: { _tag: 'InvalidInput', input: options.input },
  })

/** Constructs an LLVM failure for invalid builder state or ownership. */
export const invalidState = (options: {
  readonly operation: string
  readonly message: string
  readonly state: unknown
}): LlvmError =>
  new LlvmError({
    operation: options.operation,
    message: options.message,
    reason: { _tag: 'InvalidState', state: options.state },
  })

/** Wraps an underlying JavaScript failure with LLVM operation context. */
export const wrappedFailure = (options: {
  readonly operation: string
  readonly message: string
  readonly cause: unknown
}): LlvmError =>
  new LlvmError({
    operation: options.operation,
    message: options.message,
    reason: { _tag: 'WrappedFailure', cause: options.cause },
  })
