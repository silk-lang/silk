import * as Data from 'effect/Data'
import * as Result from 'effect/Result'
import * as Target from './Target.js'

/** A portable host selector or one canonical compiler target id. */
export type TargetSelector = 'host' | Target.Id

export type TargetSelectorErrorReason = {
  readonly _tag: 'UnavailableTarget'
  readonly selector: string
  readonly error: Target.TargetError
}

/** A target selector could not be resolved against the compiler's canonical target set. */
export class TargetSelectorError extends Data.TaggedError('TargetSelectorError')<{
  readonly operation: 'TargetSelector.resolve'
  readonly message: string
  readonly reason: TargetSelectorErrorReason
}> {}

/** Whether a string is a supported portable or canonical selector. */
export const isTargetSelector = (value: string): value is TargetSelector =>
  value === 'host' || Target.all.some((target) => target.id === value)

/** Resolves one selector against an explicit host selection supplied by the application edge. */
export const resolve = (
  selector: string,
  host: Target.Selection,
): Result.Result<Target.Target, TargetSelectorError> => {
  const selected = selector === 'host' ? host : Target.select(selector)
  return selected._tag === 'Resolved'
    ? Result.succeed(selected.target)
    : Result.fail(
        new TargetSelectorError({
          operation: 'TargetSelector.resolve',
          message: selected.error.message,
          reason: { _tag: 'UnavailableTarget', selector, error: selected.error },
        }),
      )
}

/** Resolves and deduplicates selectors by canonical id while preserving first-seen order. */
export const resolveAll = (
  selectors: ReadonlyArray<string>,
  host: Target.Selection,
): Result.Result<ReadonlyArray<Target.Target>, TargetSelectorError> => {
  const targets: Array<Target.Target> = []
  const seen = new Set<Target.Id>()
  for (const selector of selectors) {
    const resolved = resolve(selector, host)
    if (Result.isFailure(resolved)) return Result.fail(resolved.failure)
    if (seen.has(resolved.success.id)) continue
    seen.add(resolved.success.id)
    targets.push(resolved.success)
  }
  return Result.succeed(targets)
}
