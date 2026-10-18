import type * as Alias from '../Alias.js'
import type * as FunctionActor from '../Function.js'
import type * as Global from '../Global.js'
import type * as Variable from '../Variable.js'
import type * as GlobalDescription from './GlobalDescription.js'
import type * as MetadataDescription from './MetadataDescription.js'
import * as Table from './Table.js'

/**
 * Global-object state: one name-interning table for every global, three kind
 * sub-tables (variable/alias/function) parallel to globals via actorIndex, the
 * anonymous-name counter, and per-global metadata attachments.
 *
 * @internal
 */
export interface GlobalTable {
  readonly entries: Table.Table<GlobalDescription.GlobalDescription, Global.Global>
  nextAnonymous: number
  readonly variables: Table.Table<GlobalDescription.VariableDescription, Variable.Variable>
  readonly aliases: Table.Table<GlobalDescription.AliasDescription, Alias.Alias>
  readonly functions: Table.Table<GlobalDescription.FunctionDescription, FunctionActor.Function>
  readonly attachments: Array<ReadonlyArray<MetadataDescription.Attachment>>
}

/** @internal */
export const make = (): GlobalTable => ({
  entries: Table.make(),
  nextAnonymous: 0,
  variables: Table.make(),
  aliases: Table.make(),
  functions: Table.make(),
  attachments: [],
})

/** @internal */
export const freeze = (
  table: GlobalTable,
): {
  readonly globals: ReadonlyArray<GlobalDescription.GlobalDescription>
  readonly globalHandles: ReadonlyArray<Global.Global>
  readonly variables: ReadonlyArray<GlobalDescription.VariableDescription>
  readonly variableHandles: ReadonlyArray<Variable.Variable>
  readonly aliases: ReadonlyArray<GlobalDescription.AliasDescription>
  readonly aliasHandles: ReadonlyArray<Alias.Alias>
  readonly functions: ReadonlyArray<GlobalDescription.FunctionDescription>
  readonly functionHandles: ReadonlyArray<FunctionActor.Function>
  readonly attachments: ReadonlyArray<ReadonlyArray<MetadataDescription.Attachment>>
} => ({
  globals: Table.freeze(table.entries).descriptions,
  globalHandles: Table.freeze(table.entries).handles,
  variables: Table.freeze(table.variables).descriptions,
  variableHandles: Table.freeze(table.variables).handles,
  aliases: Table.freeze(table.aliases).descriptions,
  aliasHandles: Table.freeze(table.aliases).handles,
  functions: Table.freeze(table.functions).descriptions,
  functionHandles: Table.freeze(table.functions).handles,
  attachments: table.attachments.map((a) => [...a]),
})
