import * as Effect from 'effect/Effect'
import type * as NativeLinkPlan from './NativeLinkPlan.js'
import * as NativeToolchain from './NativeToolchain.js'
import type * as Storage from './Storage.js'

export type CachePolicy =
  | { readonly _tag: 'Disabled' }
  | {
      readonly _tag: 'ReadWrite'
      readonly store: Storage.Service
      readonly key: string
    }

export interface Request {
  /** The caller owns cleanup; every plan input must remain alive for this scope. */
  readonly scope: NativeToolchain.BuildScope
  readonly plan: NativeLinkPlan.NativeLinkPlan
  readonly artifactKind: NativeLinkPlan.NativeLinkPlan['kind']
  readonly destination: string
  readonly cache: CachePolicy
}

export interface Metadata {
  readonly _tag: 'LinkMetadata'
  readonly scope: string
  readonly planIdentity: string
  readonly cacheKey?: string
  readonly reused: boolean
}

export interface Result {
  readonly _tag: 'LinkedArtifact'
  readonly artifact: NativeToolchain.FinalArtifact
  readonly metadata: Metadata
}

/** Validates and executes one complete physical link plan, including optional final-artifact reuse. */
export const link = Effect.fn('Linker.link')(function* (
  request: Request,
): Effect.fn.Return<Result, NativeToolchain.ToolchainError> {
  yield* NativeToolchain.validateLinkPlan(request.plan)
  const cached =
    request.cache._tag === 'ReadWrite'
      ? yield* NativeToolchain.readArtifactCache(request.cache.store, request.cache.key)
      : undefined
  const reusable =
    cached !== undefined &&
    NativeToolchain.isCachedArtifact(cached, request.artifactKind, request.plan.supply.target)
  const artifact = reusable
    ? yield* NativeToolchain.commitCachedArtifact(
        cached,
        request.artifactKind,
        request.plan.supply.target,
        request.destination,
      )
    : yield* NativeToolchain.finalizeLink(request.plan, request.artifactKind, request.destination)
  if (!reusable && request.cache._tag === 'ReadWrite')
    yield* NativeToolchain.writeArtifactCache(request.cache.store, request.cache.key, [
      artifact.bytes,
    ])
  return {
    _tag: 'LinkedArtifact',
    artifact,
    metadata: {
      _tag: 'LinkMetadata',
      scope: request.scope.name,
      planIdentity: request.plan.identity,
      ...(request.cache._tag === 'ReadWrite' ? { cacheKey: request.cache.key } : {}),
      reused: reusable,
    },
  }
})
