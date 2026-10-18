import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as AuthoredEncoding from './AuthoredEncoding.js'
import type * as AuthoredHir from './AuthoredHir.js'

/** A failure to acquire an owned artifact snapshot from platform structured cloning. */
export class AuthoredModuleError extends Data.TaggedError('AuthoredModuleError')<{
  readonly cause: unknown
}> {}

/**
 * Whether an authored owner is free of local lowering damage. This is a necessary condition for
 * successful semantic reuse, never sufficient: dependencies, profile and semantic context still matter.
 */
export const isUndamaged = (self: AuthoredHir.Declaration): boolean => {
  const pending: unknown[] = [self]
  const visited = new Set<object>()
  while (pending.length > 0) {
    const value = pending.pop()
    if (value === null || typeof value !== 'object' || visited.has(value)) continue
    visited.add(value)
    if ('causes' in value && Array.isArray(value.causes) && value.causes.length > 0) return false
    for (const child of Object.values(value)) pending.push(child)
  }
  return true
}

/**
 * Publish a source-independent snapshot. Validation excludes open object shapes, accessors,
 * cycles and out-of-pool references before cloning; the input remains the caller's mutable draft.
 */
export const make = Effect.fn('AuthoredModule.make')(function* (
  draft: AuthoredHir.Module,
): Effect.fn.Return<
  AuthoredHir.Module,
  AuthoredEncoding.AuthoredEncodingError | AuthoredModuleError
> {
  yield* AuthoredEncoding.validate(draft)
  const snapshot = yield* Effect.try({
    try: () => structuredClone(draft),
    catch: (cause) => new AuthoredModuleError({ cause }),
  })
  return snapshot
})

/**
 * Publish a draft the producer relinquishes: validated in place, without the clone that
 * `make` performs for callers who keep editing their draft. Lowering seals every module it builds,
 * so its presentation anchors stay shared with the published nodes.
 */
export const seal = Effect.fn('AuthoredModule.seal')(function* (
  draft: AuthoredHir.Module,
): Effect.fn.Return<AuthoredHir.Module, AuthoredEncoding.AuthoredEncodingError> {
  yield* AuthoredEncoding.validate(draft)
  return draft
})
