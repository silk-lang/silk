import type * as GlobalDescription from '../internal/GlobalDescription.js'
import type * as Metadata from '../Metadata.js'

/** @internal */
export const bitWidth = (count: number): number =>
  Math.max(1, Math.ceil(Math.log2(Math.max(2, count))))

export interface GlobalOrder {
  readonly entries: ReadonlyArray<{
    readonly global: GlobalDescription.GlobalDescription
    readonly globalIndex: number
  }>
  readonly valueIndex: ReadonlyMap<number, number>
  readonly strtab: ReadonlyMap<number, { readonly offset: number; readonly size: number }>
  readonly bytes: Uint8Array
}

export interface ConstantAdapter {
  readonly local: ReadonlyArray<number>
  readonly localIndex: ReadonlyMap<number, number>
  readonly valueIndex: (constant: number) => number
}

export interface MetadataAdapter {
  readonly reachable: Metadata.Reachable
  readonly entries: ReadonlyArray<number>
  readonly indices: ReadonlyMap<number, number>
  readonly index: (metadata: number) => number
  readonly optional: (metadata: number | undefined) => number
}
