import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as Runtime from 'effect/Runtime'

/** A command whose user-facing output is complete and only needs to set the process exit status. */
export class CommandExit extends Data.TaggedError('CommandExit')<{
  readonly status: number
}> {
  readonly [Runtime.errorReported] = false
  get [Runtime.errorExitCode](): number {
    return this.status
  }
}

/** Completes successfully for zero or fails silently with the requested nonzero exit status. */
export const complete = Effect.fn('CommandExit.complete')(function* (
  status: number,
): Effect.fn.Return<void, CommandExit> {
  if (status !== 0) return yield* new CommandExit({ status })
})
