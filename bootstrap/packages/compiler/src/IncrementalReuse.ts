import * as Effect from 'effect/Effect'
import type * as Elaboration from './Elaboration.js'
import type * as ModuleClosure from './ModuleClosure.js'
import type * as ModuleSemantics from './ModuleSemantics.js'
import type * as ModuleSurface from './ModuleSurface.js'
import type * as OpaqueRealization from './OpaqueRealization.js'
import * as SemanticInvalidation from './SemanticInvalidation.js'
import type * as SemanticQuery from './SemanticQuery.js'

/** Prior immutable project facts permitted to seed module semantic structural sharing. */
export interface ProjectReuseBasis {
  readonly closure: ModuleClosure.ProjectClosure
  readonly surfaces: ReadonlyMap<string, ModuleSurface.ModuleSurface>
  readonly semantics: ReadonlyMap<string, ModuleSemantics.ModuleSemantics>
  readonly opaqueRealizations: OpaqueRealization.Catalog
  readonly environment: string
  readonly semanticQueries: SemanticQuery.Snapshot
}

const moduleBatchSize = 8

/** Yields between bounded batches of incremental frontend work. */
export const checkpointModuleBatch = Effect.fn('IncrementalReuse.checkpointModuleBatch')(function* (
  ordinal: number,
) {
  if (ordinal > 0 && ordinal % moduleBatchSize === 0) yield* Effect.yieldNow
})

/** Retains elaborations whose authored module is structurally shared with the previous revision. */
export const authoredRetained = (
  closure: ModuleClosure.Facts,
  previous?: ProjectReuseBasis,
): ReadonlyMap<string, Elaboration.Result> =>
  new Map(
    closure.modules.flatMap((module) => {
      const artifact = previous?.semantics.get(module.name)
      return artifact?.elaboration.authored === module.authored
        ? ([[module.name, artifact.elaboration]] as const)
        : []
    }),
  )

/** Classifies current authored module identities for semantic invalidation. */
export const revisions = (
  closure: ModuleClosure.Facts,
  previous?: ProjectReuseBasis,
): ReadonlyMap<string, SemanticInvalidation.LocalRevision> => {
  const previousAuthored = new Map(
    previous?.closure.modules.map((module) => [module.name, module.authored]),
  )
  return new Map(
    closure.modules.map((module): readonly [string, SemanticInvalidation.LocalRevision] => {
      const prior = previousAuthored.get(module.name)
      if (prior === undefined) return [module.name, { _tag: 'Fresh' }]
      if (prior === module.authored) return [module.name, { _tag: 'Reused' }]
      return [module.name, { _tag: 'Changed' }]
    }),
  )
}

/** Computes semantic invalidation from the current closure and optional prior revision. */
export const invalidate = (options: {
  readonly environment?: string
  readonly closure: ModuleClosure.ProjectClosure
  readonly surfaces: ReadonlyMap<string, ModuleSurface.ModuleSurface>
  readonly opaqueRealizations: OpaqueRealization.Catalog
  readonly previous?: ProjectReuseBasis
}): SemanticInvalidation.SemanticInvalidation =>
  SemanticInvalidation.make({
    current: {
      closure: options.closure,
      surfaces: options.surfaces,
      opaqueRealizations: options.opaqueRealizations,
      environment: options.environment ?? SemanticInvalidation.environment,
    },
    revisions: revisions(options.closure, options.previous),
    ...(options.previous === undefined
      ? {}
      : {
          previous: {
            closure: options.previous.closure,
            surfaces: options.previous.surfaces,
            opaqueRealizations: options.previous.opaqueRealizations,
            environment: options.previous.environment,
          },
        }),
  })

/** Selects prior semantic artifacts approved by invalidation and authored identity. */
export const retainedSemantics = Effect.fnUntraced(function* (
  closure: ModuleClosure.Facts,
  previous: ProjectReuseBasis,
  invalidation: SemanticInvalidation.SemanticInvalidation,
): Effect.fn.Return<ReadonlyMap<string, ModuleSemantics.ModuleSemantics>> {
  const reusable = new Set(
    invalidation.observations.flatMap((observation) =>
      observation._tag === 'Reusable' ? [observation.module] : [],
    ),
  )
  const retained = new Map<string, ModuleSemantics.ModuleSemantics>()
  for (const [ordinal, module] of closure.modules.entries()) {
    yield* checkpointModuleBatch(ordinal)
    if (!reusable.has(module.name)) continue
    const artifact = previous.semantics.get(module.name)
    if (
      artifact !== undefined &&
      artifact.module === module.name &&
      artifact.elaboration.authored === module.authored
    )
      retained.set(module.name, artifact)
  }
  return retained
})

/** Projects structurally retained semantics to their elaboration artifacts. */
export const retainedElaborations = (
  retained: ReadonlyMap<string, ModuleSemantics.ModuleSemantics>,
): ReadonlyMap<string, Elaboration.Result> =>
  new Map([...retained].map(([module, semantics]) => [module, semantics.elaboration]))
