import type * as DeclarationFacts from './DeclarationFacts.js'
import type * as Diagnostic from './Diagnostic.js'

/** The immutable declaration index assembled from one loaded module closure. */
export interface Index {
  readonly _tag: 'DeclarationIndex'
  readonly stage: 'Collected' | 'Complete'
  readonly modules: ReadonlyArray<DeclarationFacts.ModuleHeaders>
  /** Occurrence-generated nominal aggregates, excluded from every lexical module collection. */
  readonly generatedAggregates: ReadonlyMap<string, DeclarationFacts.StructFact>
  readonly diagnostics: ReadonlyArray<Diagnostic.Located>
}

/** Constructs one immutable declaration index at a coordinator-owned phase boundary. */
export const make = (
  stage: Index['stage'],
  modules: ReadonlyArray<DeclarationFacts.ModuleHeaders>,
  diagnostics: ReadonlyArray<Diagnostic.Located>,
  generatedAggregates: ReadonlyMap<string, DeclarationFacts.StructFact> = new Map(),
): Index => ({
  _tag: 'DeclarationIndex',
  stage,
  modules: modules,
  generatedAggregates,
  diagnostics: diagnostics,
})
