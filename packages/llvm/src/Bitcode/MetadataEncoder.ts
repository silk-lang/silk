import * as ByteString from '../ByteString.js'
import * as Bitstream from '../internal/Bitstream.js'
import type * as BuilderState from '../internal/BuilderState.js'
import type * as FunctionBodyDescription from '../internal/FunctionBodyDescription.js'
import type * as MetadataDescription from '../internal/MetadataDescription.js'
import * as Metadata from '../Metadata.js'
import type { ConstantAdapter, GlobalOrder, MetadataAdapter } from './shared.js'

/** @internal */
export const buildMetadataAdapter = (state: BuilderState.Snapshot): MetadataAdapter => {
  const reachable = Metadata.reachable(state, 'Bitcode.encode')
  const strings = reachable.entries.filter((index) => state.metadata[index]?._tag === 'String')
  const nodes = reachable.entries.filter((index) => state.metadata[index]?._tag === 'Node')
  const entries = [...strings, ...nodes]
  const indices = new Map(entries.map((entry, index) => [entry, index]))
  const resolve = (metadata: number): number => {
    const seen = new Set<number>()
    let current = metadata
    while (true) {
      if (seen.has(current)) throw new Error('metadata forward-reference cycle')
      seen.add(current)
      const target = reachable.resolved.get(current)
      if (target === undefined) return current
      current = target
    }
  }
  const index = (metadata: number): number => {
    const value = indices.get(resolve(metadata))
    if (value === undefined) throw new Error(`metadata ${metadata} has no bitcode index`)
    return value
  }
  return {
    reachable,
    entries,
    indices,
    index,
    optional: (metadata) => (metadata === undefined ? 0 : index(metadata) + 1),
  }
}

const metadataKindCode: Readonly<Record<MetadataDescription.Attachment['kind'], number>> = {
  dbg: 0,
  prof: 2,
  unpredictable: 15,
}

/** @internal */
export const writeMetadataKinds = (
  module: Bitstream.BlockWriter,
  state: BuilderState.Snapshot,
  metadata: MetadataAdapter,
): void => {
  const hasAttachments =
    state.globalMetadata.some((attachments) => attachments.length > 0) ||
    state.functions.some((fn) => (fn.body?.metadataRoots.length ?? 0) > 0)
  if (metadata.entries.length === 0 && !hasAttachments) return
  const block = Bitstream.enterBlock(
    module.writer,
    { id: 22, abbreviations: [] },
    module.abbrevWidth,
  )
  for (const [name, id] of [
    ['dbg', 0],
    ['prof', 2],
    ['unpredictable', 15],
  ] as const) {
    Bitstream.writeUnabbreviatedRecord(block, 6, [id, ...ByteString.fromString(name).bytes])
  }
  Bitstream.endBlock(block)
}

/** @internal */
const signedMetadataInteger = (value: bigint): bigint =>
  value >= 0n ? value << 1n : (-value << 1n) | 1n

/** @internal */
export const writeMetadata = (
  module: Bitstream.BlockWriter,
  state: BuilderState.Snapshot,
  order: GlobalOrder,
  constants: ConstantAdapter,
  metadata: MetadataAdapter,
): void => {
  if (metadata.entries.length === 0 && state.namedMetadata.length === 0) return
  const block = Bitstream.enterBlock(
    module.writer,
    { id: 15, abbreviations: [] },
    module.abbrevWidth,
  )
  const optional = metadata.optional
  for (const entryIndex of metadata.entries) {
    const entry = state.metadata[entryIndex]
    if (entry === undefined) throw new Error('metadata entry is missing')
    if (entry._tag === 'String') {
      Bitstream.writeUnabbreviatedRecord(block, 1, entry.value.bytes)
      continue
    }
    if (entry._tag === 'Forward') throw new Error('unresolved metadata entry')
    const node = entry.value
    switch (node._tag) {
      case 'Tuple':
        Bitstream.writeUnabbreviatedRecord(
          block,
          node.distinct ? 5 : 3,
          node.elements.map(optional),
        )
        break
      case 'Constant': {
        const constant = state.constants[node.constant]
        if (constant === undefined) throw new Error('metadata constant is missing')
        Bitstream.writeUnabbreviatedRecord(block, 2, [
          constant.type,
          constants.valueIndex(node.constant),
        ])
        break
      }
      case 'Local':
        Bitstream.writeUnabbreviatedRecord(block, node.distinct ? 5 : 3, [])
        break
      case 'File':
        Bitstream.writeUnabbreviatedRecord(block, 16, [
          node.distinct ? 1 : 0,
          optional(node.filename),
          optional(node.directory),
          0,
          0,
        ])
        break
      case 'CompileUnit':
        Bitstream.writeUnabbreviatedRecord(block, 20, [
          1,
          12,
          optional(node.file),
          optional(node.producer),
          node.optimized ? 1 : 0,
          0,
          0,
          0,
          1,
          optional(node.enums),
          0,
          0,
          optional(node.globals),
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
        ])
        break
      case 'Subprogram':
        Bitstream.writeUnabbreviatedRecord(block, 21, [
          7,
          optional(node.file),
          optional(node.name),
          optional(node.linkageName),
          optional(node.file),
          node.line,
          optional(node.type),
          node.scopeLine,
          0,
          node.spFlags,
          0,
          node.diFlags,
          optional(node.compileUnit),
          0,
          0,
          0,
          0,
          0,
          0,
          0,
        ])
        break
      case 'LexicalBlock':
        Bitstream.writeUnabbreviatedRecord(block, 22, [
          node.distinct ? 1 : 0,
          optional(node.scope),
          optional(node.file),
          node.line,
          node.column,
        ])
        break
      case 'Location':
        Bitstream.writeUnabbreviatedRecord(block, 7, [
          node.distinct ? 1 : 0,
          node.line,
          node.column,
          optional(node.scope),
          optional(node.inlinedAt),
          0,
        ])
        break
      case 'BasicType': {
        const encoding: Readonly<Record<MetadataDescription.BasicEncoding, number>> = {
          boolean: 2,
          float: 4,
          signed: 5,
          unsigned: 7,
        }
        Bitstream.writeUnabbreviatedRecord(block, 15, [
          node.distinct ? 1 : 0,
          0x24,
          optional(node.name),
          node.sizeInBits,
          0,
          encoding[node.encoding],
          0,
        ])
        break
      }
      case 'StringType': {
        const encoding: Readonly<Record<MetadataDescription.StringEncoding, number>> = {
          utf: 0x10,
        }
        Bitstream.writeUnabbreviatedRecord(block, 41, [
          node.distinct ? 1 : 0,
          0x12,
          optional(node.name),
          optional(node.stringLength),
          optional(node.stringLengthExpression),
          optional(node.stringLocationExpression),
          node.sizeInBits,
          node.alignInBits,
          encoding[node.encoding],
        ])
        break
      }
      case 'CompositeType': {
        const tag: Readonly<Record<MetadataDescription.CompositeKind, number>> = {
          array: 0x01,
          enumeration: 0x04,
          structure: 0x13,
          union: 0x17,
          vector: 0x01,
        }
        Bitstream.writeUnabbreviatedRecord(block, 18, [
          (node.distinct ? 1 : 0) | 2,
          tag[node.kind],
          optional(node.name),
          optional(node.file),
          node.line,
          optional(node.scope),
          optional(node.underlyingType),
          node.sizeInBits,
          node.alignInBits,
          0,
          node.flags,
          optional(node.fields),
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
        ])
        break
      }
      case 'DerivedType': {
        const tag: Readonly<Record<MetadataDescription.DerivedKind, number>> = {
          member: 0x0d,
          pointer: 0x0f,
          typedef: 0x16,
        }
        Bitstream.writeUnabbreviatedRecord(block, 17, [
          node.distinct ? 1 : 0,
          tag[node.kind],
          optional(node.name),
          optional(node.file),
          node.line,
          optional(node.scope),
          optional(node.underlyingType),
          node.sizeInBits,
          node.alignInBits,
          node.offsetInBits,
          node.flags,
          0,
        ])
        break
      }
      case 'SubroutineType':
        Bitstream.writeUnabbreviatedRecord(block, 19, [
          (node.distinct ? 1 : 0) | 2,
          node.flags,
          optional(node.types),
          0,
        ])
        break
      case 'Enumerator':
        Bitstream.writeUnabbreviatedRecord(block, 14, [
          4 | (node.unsigned ? 2 : 0) | (node.distinct ? 1 : 0),
          node.bitWidth,
          optional(node.name),
          signedMetadataInteger(node.value),
        ])
        break
      case 'Subrange':
        Bitstream.writeUnabbreviatedRecord(block, 13, [
          (node.distinct ? 1 : 0) | 4,
          optional(node.count),
          optional(node.lowerBound),
          0,
          0,
        ])
        break
      case 'Expression':
        Bitstream.writeUnabbreviatedRecord(block, 29, [
          (node.distinct ? 1 : 0) | 6,
          ...node.elements,
        ])
        break
      case 'LocalVariable':
        Bitstream.writeUnabbreviatedRecord(block, 28, [
          (node.distinct ? 1 : 0) | 2,
          optional(node.scope),
          optional(node.name),
          optional(node.file),
          node.line,
          optional(node.type),
          node.argument,
          node.flags,
          0,
          0,
        ])
        break
      case 'GlobalVariable':
        Bitstream.writeUnabbreviatedRecord(block, 27, [
          (node.distinct ? 1 : 0) | 4,
          optional(node.scope),
          optional(node.name),
          optional(node.linkageName),
          optional(node.file),
          node.line,
          optional(node.type),
          node.local ? 1 : 0,
          1,
          0,
          0,
          0,
          0,
        ])
        break
      case 'GlobalVariableExpression':
        Bitstream.writeUnabbreviatedRecord(block, 37, [
          node.distinct ? 1 : 0,
          optional(node.variable),
          optional(node.expression),
        ])
        break
    }
  }
  for (const named of state.namedMetadata) {
    Bitstream.writeUnabbreviatedRecord(block, 4, named.name.bytes)
    Bitstream.writeUnabbreviatedRecord(block, 10, named.operands.map(metadata.index))
  }
  for (let globalIndex = 0; globalIndex < state.globalMetadata.length; globalIndex += 1) {
    const global = state.globals[globalIndex]
    if (global === undefined || global.deleted || global.replacement !== undefined) continue
    const fn = global.kind === 'Function' ? state.functions[global.actorIndex] : undefined
    if (fn?.body !== undefined) continue
    const value = order.valueIndex.get(globalIndex)
    if (value === undefined) continue
    for (const attachment of state.globalMetadata[globalIndex] ?? []) {
      Bitstream.writeUnabbreviatedRecord(block, 36, [
        value,
        metadataKindCode[attachment.kind],
        metadata.index(attachment.metadata),
      ])
    }
  }
  Bitstream.endBlock(block)
}

/** @internal */
export const metadataNodeAt = (
  state: BuilderState.Snapshot,
  metadata: MetadataAdapter,
  index: number,
): MetadataDescription.Node => {
  const resolved = metadata.reachable.resolved.get(index) ?? index
  const entry = state.metadata[resolved]
  if (entry?._tag !== 'Node') throw new Error('debug location is not a metadata node')
  return entry.value
}

/** @internal */
export const writeFunctionAttachments = (
  functionBlock: Bitstream.BlockWriter,
  state: BuilderState.Snapshot,
  globalIndex: number,
  body: FunctionBodyDescription.Snapshot,
  metadata: MetadataAdapter,
): void => {
  const globalAttachments = state.globalMetadata[globalIndex] ?? []
  const hasInstructionAttachments = body.metadata.some((attachments) => attachments.length > 0)
  if (globalAttachments.length === 0 && !hasInstructionAttachments) return
  const block = Bitstream.enterBlock(
    functionBlock.writer,
    { id: 16, abbreviations: [] },
    functionBlock.abbrevWidth,
    false,
  )
  for (const attachment of globalAttachments) {
    Bitstream.writeUnabbreviatedRecord(block, 11, [
      metadataKindCode[attachment.kind],
      metadata.index(attachment.metadata),
    ])
  }
  for (let instructionIndex = 0; instructionIndex < body.metadata.length; instructionIndex += 1) {
    for (const attachment of body.metadata[instructionIndex] ?? []) {
      Bitstream.writeUnabbreviatedRecord(block, 11, [
        instructionIndex,
        metadataKindCode[attachment.kind],
        metadata.index(attachment.metadata),
      ])
    }
  }
  Bitstream.endBlock(block)
}
