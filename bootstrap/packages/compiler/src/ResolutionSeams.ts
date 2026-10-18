import type * as DeclarationFacts from './DeclarationFacts.js'
import * as Type from './Type.js'

/**
 * Resolves one alias declaration to its erased target exactly once. Repeated calls return the
 * memoized fact without repeating its diagnostics.
 */
export type AliasResolver = (
  declaration: DeclarationFacts.AliasFact,
) => DeclarationFacts.TypeResolution

/** Type and exact-item resolution boundaries supplied while completing declaration headers. */
export interface ResolutionSeams {
  readonly type: DeclarationFacts.TypeResolver
  readonly item: DeclarationFacts.ItemResolver
  readonly alias?: AliasResolver
  readonly representationBindings?: ReadonlyMap<string, Type.Parameter>
}

/** Constructs one pair of declaration-resolution boundaries. */
export const make = (
  type: DeclarationFacts.TypeResolver,
  item: DeclarationFacts.ItemResolver,
  alias?: AliasResolver,
): ResolutionSeams => ({ type, item, ...(alias === undefined ? {} : { alias }) })

/** Adds one resolved opaque binder without reconstructing the underlying resolution boundaries. */
export const withRepresentationBinding = (
  self: ResolutionSeams,
  unresolved: Type.Parameter,
  resolved: Type.Parameter,
): ResolutionSeams => {
  const representationBindings = new Map(self.representationBindings)
  representationBindings.set(Type.key(unresolved), resolved)
  return { ...self, representationBindings }
}
