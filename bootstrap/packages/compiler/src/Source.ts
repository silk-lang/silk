import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as SourceResolver from './SourceResolver.js'

/** Loads one validated canonical module through the active source provider. */
export const load = Effect.fn('Source.load')(function* (
  module: string,
): Effect.fn.Return<
  Option.Option<SourceResolver.ResolvedSource>,
  SourceResolver.SourceResolverError,
  SourceResolver.SourceResolver
> {
  yield* Effect.annotateCurrentSpan('module', module)
  if (!SourceResolver.isCanonicalModule(module)) {
    return yield* new SourceResolver.SourceResolverError({
      operation: 'Source.load',
      module,
      message: `Source module identity ${module} is not canonical`,
      reason: { _tag: 'InvalidModuleIdentity' },
    })
  }
  const resolver = yield* SourceResolver.SourceResolver
  return Option.map(yield* resolver.resolve(module), (source) =>
    SourceResolver.resolved(source.bytes, source.origin),
  )
})
