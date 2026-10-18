import * as Handle from './Handle.js'
import type * as MetadataDescription from './MetadataDescription.js'
import type * as MetadataHandle from './MetadataHandle.js'
import type * as OwnedHandle from './OwnedHandle.js'
import * as Table from './Table.js'

/**
 * Metadata state: one interning table (string-keyed entries) plus a separate node
 * key map and the named-metadata roots, each with its own name key.
 *
 * @internal
 */
export interface MetadataTable {
  readonly entries: Table.Table<MetadataDescription.Entry, MetadataHandle.Metadata>
  readonly nodeKeys: Map<string, number>
  readonly named: Array<MetadataDescription.Named>
  readonly namedKeys: Map<string, number>
}

/** @internal */
export const make = (): MetadataTable => ({
  entries: Table.make(),
  nodeKeys: new Map(),
  named: [],
  namedKeys: new Map(),
})

/** @internal */
export const allocate = (
  table: MetadataTable,
  owner: OwnedHandle.Owner,
  entry: MetadataDescription.Entry,
): MetadataHandle.Metadata => {
  const index = table.entries.descriptions.length
  const handle = Handle.make('Metadata', owner, index)
  table.entries.descriptions.push(entry)
  table.entries.handles.push(handle)
  return handle
}

/** @internal */
export const freeze = (
  table: MetadataTable,
): {
  readonly descriptions: ReadonlyArray<MetadataDescription.Entry>
  readonly named: ReadonlyArray<MetadataDescription.Named>
} => ({
  descriptions: Table.freeze(table.entries).descriptions,
  named: [...table.named],
})
