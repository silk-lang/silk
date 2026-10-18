import * as ByteString from '../ByteString.js'
import { code as attributeKindCode } from '../internal/AttributeKind.js'
import * as Bitstream from '../internal/Bitstream.js'
import type * as BuilderState from '../internal/BuilderState.js'
import * as DeclarationSchema from '../internal/DeclarationBitcodeSchema.js'

/** @internal */
const attributeName = (bytes: ByteString.ByteString): string => {
  let ascii = ''
  for (const byte of bytes.bytes) ascii += String.fromCharCode(byte)
  return ascii
}

/** @internal */
const stringAttribute = (
  name: ByteString.ByteString,
  value: ByteString.ByteString | undefined,
): ReadonlyArray<Bitstream.Scalar> => [
  value === undefined ? 3 : 4,
  ...name.bytes,
  0,
  ...(value?.bytes ?? []),
  ...(value === undefined ? [] : [0]),
]

/** @internal */
const encodeAttribute = (
  description: BuilderState.Snapshot['attributes'][number],
): ReadonlyArray<Bitstream.Scalar> => {
  const name = attributeName(description.name)
  const code = attributeKindCode[name]
  if (description._tag === 'String') return stringAttribute(description.name, description.value)
  if (description._tag === 'IntegerList') {
    return stringAttribute(
      description.name,
      ByteString.fromString(description.values.map(String).join(',')),
    )
  }
  if (code === undefined) return stringAttribute(description.name, undefined)
  if (description._tag === 'Flag') return [0, code]
  if (description._tag === 'Integer') return [1, code, description.value]
  return [6, code, description.type]
}

interface AttributeGroups {
  readonly groupIdsByFunctionSet: ReadonlyArray<ReadonlyArray<number>>
}

/** @internal */
export const writeAttributes = (
  module: Bitstream.BlockWriter,
  state: BuilderState.Snapshot,
): AttributeGroups => {
  const groups: Array<{ readonly set: number; readonly position: number }> = []
  const groupIndex = new Map<string, number>()
  const groupIdsByFunctionSet = state.functionAttributeSets.map((functionSet) => {
    const positioned = [
      { set: functionSet.functionAttributes, position: 0xffff_ffff },
      { set: functionSet.returnAttributes, position: 0 },
      ...functionSet.parameterAttributes.map((set, index) => ({ set, position: index + 1 })),
    ]
    const ids: Array<number> = []
    for (const entry of positioned) {
      const values = state.attributeSets[entry.set]
      if (values === undefined || values.length === 0) continue
      const key = `${entry.set}:${entry.position}`
      let id = groupIndex.get(key)
      if (id === undefined) {
        id = groups.length
        groupIndex.set(key, id)
        groups.push(entry)
      }
      ids.push(id)
    }
    return ids
  })

  if (groups.length > 0) {
    const block = Bitstream.enterBlock(
      module.writer,
      DeclarationSchema.paramattrGroup,
      module.abbrevWidth,
    )
    for (let id = 0; id < groups.length; id += 1) {
      const group = groups[id]
      if (group === undefined) continue
      const attributes = state.attributeSets[group.set] ?? []
      const values: Array<Bitstream.Scalar> = [id, group.position]
      for (const attributeIndex of attributes) {
        const description = state.attributes[attributeIndex]
        if (description === undefined) throw new Error('missing attribute')
        values.push(...encodeAttribute(description))
      }
      Bitstream.writeUnabbreviatedRecord(block, 3, values)
    }
    Bitstream.endBlock(block)
  }

  if (state.functionAttributeSets.length > 0) {
    const block = Bitstream.enterBlock(
      module.writer,
      DeclarationSchema.paramattr,
      module.abbrevWidth,
    )
    for (const ids of groupIdsByFunctionSet) {
      Bitstream.writeRecord(block, DeclarationSchema.paramattrEntry, [ids])
    }
    Bitstream.endBlock(block)
  }
  return { groupIdsByFunctionSet }
}
