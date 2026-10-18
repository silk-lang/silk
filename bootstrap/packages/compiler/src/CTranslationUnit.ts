import type * as PlatformSupply from './PlatformSupply.js'

/** Frozen preprocessed input and the exact header subset consumed to produce it. */
export interface CTranslationUnit {
  readonly _tag: 'CTranslationUnit'
  readonly source: string
  readonly headers: ReadonlyArray<PlatformSupply.File>
  readonly identity: string
  readonly query: PlatformSupply.Query
}
