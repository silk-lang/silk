import * as Effect from 'effect/Effect'
import { writeAttributes } from './Bitcode/AttributeEncoder.js'
import { buildConstantAdapter, writeConstants } from './Bitcode/ConstantEncoder.js'
import { writeFunctionBodies, writeOperandBundleTags } from './Bitcode/FunctionEncoder.js'
import {
  buildMetadataAdapter,
  writeMetadata,
  writeMetadataKinds,
} from './Bitcode/MetadataEncoder.js'
import { bitWidth, type ConstantAdapter, type GlobalOrder } from './Bitcode/shared.js'
import { writeTypes } from './Bitcode/TypeEncoder.js'
import type * as Builder from './Builder.js'
import * as ByteString from './ByteString.js'
import * as BitcodeSchema from './internal/BitcodeSchema.js'
import * as Bitstream from './internal/Bitstream.js'
import * as BuilderState from './internal/BuilderState.js'
import * as CanonicalKey from './internal/CanonicalKey.js'
import * as DeclarationSchema from './internal/DeclarationBitcodeSchema.js'
import type * as GlobalDescription from './internal/GlobalDescription.js'
import { type LlvmError, wrappedFailure } from './LlvmError.js'

/**
 * Identification record embedded in generated LLVM bitcode.
 *
 * @category encoding
 * @since 0.0.0
 */
export interface Producer {
  readonly name: string
  readonly major: number
  readonly minor: number
  readonly patch: number
}

/**
 * Optional controls for direct bitcode encoding.
 *
 * @category encoding
 * @since 0.0.0
 */
export interface Options {
  readonly producer?: Producer
}

const defaultProducer: Producer = {
  name: 'silk-effect',
  major: 0,
  minor: 0,
  patch: 0,
}

/** @internal */
const writeIdentification = (writer: Bitstream.Writer, producer: Producer): void => {
  const identification = Bitstream.enterBlock(writer, BitcodeSchema.Identification)
  const producerName = ByteString.fromString(
    `${producer.name} ${producer.major}.${producer.minor}.${producer.patch}`,
  )
  Bitstream.writeRecord(identification, BitcodeSchema.IdentificationVersion, [producerName.bytes])
  Bitstream.writeRecord(identification, BitcodeSchema.IdentificationEpoch, [0])
  Bitstream.endBlock(identification)
}

/** @internal */
const writeFoundationString = (
  block: Bitstream.BlockWriter,
  code: number,
  value: ByteString.ByteString,
): void => {
  if (ByteString.isEmpty(value)) return
  Bitstream.writeRecord(block, BitcodeSchema.ModuleString, [code, value.bytes])
}

/** @internal */
const encodeFoundation = (state: BuilderState.Snapshot, producer: Producer): Uint8Array => {
  const writer = Bitstream.make()
  Bitstream.writeBits(writer, BitcodeSchema.Magic, 32)
  writeIdentification(writer, producer)
  const module = Bitstream.enterBlock(writer, BitcodeSchema.Module)
  Bitstream.writeRecord(module, BitcodeSchema.ModuleVersion, [])
  writeFoundationString(module, BitcodeSchema.ModuleCode.Triple, state.targetTriple)
  writeFoundationString(module, BitcodeSchema.ModuleCode.DataLayout, state.dataLayout)
  writeFoundationString(module, BitcodeSchema.ModuleCode.SourceFilename, state.sourceFilename)
  for (const assembly of state.moduleAssembly) {
    writeFoundationString(module, BitcodeSchema.ModuleCode.Assembly, assembly)
  }
  Bitstream.endBlock(module)
  const stringTable = Bitstream.enterBlock(writer, BitcodeSchema.Strtab)
  Bitstream.writeRecord(stringTable, BitcodeSchema.StrtabBlob, [[]])
  Bitstream.endBlock(stringTable)
  return Bitstream.toUint8Array(writer)
}

/** @internal */
const buildGlobalOrder = (state: BuilderState.Snapshot): GlobalOrder => {
  const entries: Array<GlobalOrder['entries'][number]> = []
  const active: Record<
    GlobalDescription.GlobalDescription['kind'],
    Map<number, GlobalOrder['entries'][number]>
  > = { Variable: new Map(), Function: new Map(), Alias: new Map() }
  // Per-actor global searches made declaration-only encoding quadratic. Index the active
  // entries once, retaining global indices for references. Category conversion keeps a
  // global's position but appends its new actor, so emission still follows actor-table order.
  state.globals.forEach((global, globalIndex) => {
    if (global.deleted || global.replacement !== undefined) return
    const actors = active[global.kind]
    if (!actors.has(global.actorIndex)) actors.set(global.actorIndex, { global, globalIndex })
  })
  const add = (entry: GlobalOrder['entries'][number] | undefined): void => {
    if (entry !== undefined) entries.push(entry)
  }
  state.variables.forEach((_value, index) => {
    add(active.Variable.get(index))
  })
  state.functions.forEach((_value, index) => {
    add(active.Function.get(index))
  })
  state.aliases.forEach((_value, index) => {
    add(active.Alias.get(index))
  })
  const valueIndex = new Map<number, number>()
  const strtab = new Map<number, { readonly offset: number; readonly size: number }>()
  // Mangled names average about a kilobyte, so the string table is tens of megabytes on large
  // modules. Size it once as bytes; growing a number array of bytes retained eight times that.
  let length = 0
  for (const entry of entries) length += entry.global.name.bytes.length
  const bytes = new Uint8Array(length)
  let offset = 0
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    if (entry === undefined) continue
    valueIndex.set(entry.globalIndex, index)
    const size = entry.global.name.bytes.length
    strtab.set(entry.globalIndex, { offset, size })
    bytes.set(entry.global.name.bytes, offset)
    offset += size
  }
  return { entries: entries, valueIndex, strtab, bytes }
}

/** @internal */
const alignmentCode = (alignment: GlobalDescription.Common['alignment']): number => {
  if (alignment.byteUnits === undefined) return 0
  let value = alignment.byteUnits
  let exponent = 0
  while (value > 1n) {
    value >>= 1n
    exponent += 1
  }
  return exponent + 1
}

const linkageCode: Readonly<Record<GlobalDescription.Linkage, number>> = {
  external: 0,
  weak: 1,
  appending: 2,
  internal: 3,
  linkonce: 4,
  extern_weak: 7,
  common: 8,
  private: 9,
  weak_odr: 10,
  linkonce_odr: 11,
  available_externally: 12,
}

const visibilityCode: Readonly<Record<GlobalDescription.Visibility, number>> = {
  default: 0,
  hidden: 1,
  protected: 2,
}

const dllCode: Readonly<Record<GlobalDescription.DllStorage, number>> = {
  default: 0,
  dllimport: 1,
  dllexport: 2,
}

const unnamedCode: Readonly<Record<GlobalDescription.UnnamedAddress, number>> = {
  none: 0,
  unnamed_addr: 1,
  local_unnamed_addr: 2,
}

const threadLocalCode: Readonly<Record<GlobalDescription.ThreadLocalModel, number>> = {
  none: 0,
  generaldynamic: 1,
  localdynamic: 2,
  initialexec: 3,
  localexec: 4,
}

/** @internal */
const sectionIndices = (
  module: Bitstream.BlockWriter,
  schema: DeclarationSchema.ModuleSchema,
  order: GlobalOrder,
): ReadonlyMap<string, number> => {
  const indices = new Map<string, number>()
  for (const { global } of order.entries) {
    if (ByteString.isEmpty(global.section)) continue
    const key = CanonicalKey.bytes(global.section)
    if (indices.has(key)) continue
    indices.set(key, indices.size + 1)
    Bitstream.writeRecord(module, schema.string, [5, global.section.bytes])
  }
  return indices
}

/** @internal */
const writeGlobals = (
  module: Bitstream.BlockWriter,
  schema: DeclarationSchema.ModuleSchema,
  state: BuilderState.Snapshot,
  order: GlobalOrder,
  sections: ReadonlyMap<string, number>,
  constants: ConstantAdapter,
): void => {
  for (const entry of order.entries) {
    const { global, globalIndex } = entry
    const name = order.strtab.get(globalIndex)
    if (name === undefined) throw new Error('missing strtab name')
    const section = ByteString.isEmpty(global.section)
      ? 0
      : (sections.get(CanonicalKey.bytes(global.section)) ?? 0)
    if (global.kind === 'Variable') {
      const variable = state.variables[global.actorIndex]
      if (variable === undefined) throw new Error('missing variable')
      Bitstream.writeRecord(module, schema.variable, [
        name.offset,
        name.size,
        variable.valueType,
        (global.addressSpace.value << 2) | 2 | (variable.constant ? 1 : 0),
        variable.initializer === undefined ? 0 : constants.valueIndex(variable.initializer) + 1,
        linkageCode[global.linkage],
        alignmentCode(global.alignment),
        section,
        visibilityCode[global.visibility],
        threadLocalCode[variable.threadLocal],
        unnamedCode[global.unnamedAddress],
        variable.externallyInitialized ? 1 : 0,
        dllCode[global.dllStorage],
        global.preemption === 'dso_local' ? 1 : 0,
      ])
    } else if (global.kind === 'Function') {
      const fn = state.functions[global.actorIndex]
      if (fn === undefined) throw new Error('missing function')
      Bitstream.writeRecord(module, schema.functionDeclaration, [
        name.offset,
        name.size,
        fn.type,
        fn.callingConvention,
        fn.body === undefined ? 1 : 0,
        linkageCode[global.linkage],
        fn.attributes === undefined ? 0 : fn.attributes + 1,
        alignmentCode(global.alignment),
        section,
        visibilityCode[global.visibility],
        unnamedCode[global.unnamedAddress],
        dllCode[global.dllStorage],
        fn.personality === undefined ? 0 : constants.valueIndex(fn.personality) + 1,
        global.preemption === 'dso_local' ? 1 : 0,
        global.addressSpace.value,
      ])
    } else {
      const alias = state.aliases[global.actorIndex]
      if (alias === undefined) throw new Error('missing alias')
      Bitstream.writeRecord(module, schema.alias, [
        name.offset,
        name.size,
        alias.valueType,
        global.addressSpace.value,
        constants.valueIndex(alias.aliasee),
        linkageCode[global.linkage],
        visibilityCode[global.visibility],
        dllCode[global.dllStorage],
        0,
        unnamedCode[global.unnamedAddress],
        global.preemption === 'dso_local' ? 1 : 0,
      ])
    }
  }
}

/** @internal */
const writeDeclarationString = (
  block: Bitstream.BlockWriter,
  abbreviation: Bitstream.Abbreviation,
  code: number,
  value: ByteString.ByteString,
): void => {
  if (!ByteString.isEmpty(value)) Bitstream.writeRecord(block, abbreviation, [code, value.bytes])
}

/** @internal */
const encodeDeclarations = (state: BuilderState.Snapshot, producer: Producer): Uint8Array => {
  const writer = Bitstream.make()
  Bitstream.writeBits(writer, BitcodeSchema.Magic, 32)
  writeIdentification(writer, producer)
  const width = bitWidth(state.types.length)
  const moduleSchema = DeclarationSchema.module(width)
  const module = Bitstream.enterBlock(writer, moduleSchema.block)
  Bitstream.writeRecord(module, moduleSchema.version, [])
  writeDeclarationString(module, moduleSchema.string, 2, state.targetTriple)
  writeDeclarationString(module, moduleSchema.string, 3, state.dataLayout)
  writeDeclarationString(module, moduleSchema.string, 16, state.sourceFilename)
  for (const assembly of state.moduleAssembly) {
    writeDeclarationString(module, moduleSchema.string, 4, assembly)
  }
  writeTypes(module, state, width)
  writeAttributes(module, state)
  const order = buildGlobalOrder(state)
  const sections = sectionIndices(module, moduleSchema, order)
  const constants = buildConstantAdapter(state, order)
  writeGlobals(module, moduleSchema, state, order, sections, constants)
  writeConstants(module, state, width, constants)
  const metadata = buildMetadataAdapter(state)
  writeMetadataKinds(module, state, metadata)
  writeMetadata(module, state, order, constants, metadata)
  const operandBundleTags = writeOperandBundleTags(module, state, order)
  writeFunctionBodies(module, state, order, constants, operandBundleTags, metadata)
  Bitstream.endBlock(module)
  const stringTable = Bitstream.enterBlock(writer, BitcodeSchema.Strtab)
  Bitstream.writeRecord(stringTable, BitcodeSchema.StrtabBlob, [order.bytes])
  Bitstream.endBlock(stringTable)
  return Bitstream.toUint8Array(writer)
}

/** @internal */
const encodeSnapshot = (state: BuilderState.Snapshot, options: Options): Uint8Array => {
  const producer = options.producer ?? defaultProducer
  const hasDeclarations =
    state.types.length > 0 ||
    state.attributes.length > 0 ||
    state.constants.length > 0 ||
    state.globals.length > 0 ||
    state.metadata.length > 0 ||
    state.namedMetadata.length > 0
  return hasDeclarations ? encodeDeclarations(state, producer) : encodeFoundation(state, producer)
}

/**
 * Encodes the current module directly as deterministic LLVM bitcode bytes.
 *
 * **Details**
 *
 * Encoding snapshots the builder, resolves reachable metadata, and performs all byte packing in
 * memory. It never invokes Zig, LLVM tools, native libraries, or the filesystem.
 *
 * The builder is not consumed, and the result is a fresh `Uint8Array`. Options can replace the
 * producer identity written to the bitcode identification block.
 *
 * **Gotchas**
 *
 * Unresolved or invalid module state fails with {@link LlvmError}.
 *
 * **Example** (Encoding a module)
 *
 * ```ts
 * import * as Effect from 'effect/Effect'
 * import * as Bitcode from '@silklang/llvm/Bitcode'
 * import * as Builder from '@silklang/llvm/Builder'
 *
 * const bytes = await Effect.runPromise(
 *   Effect.gen(function* () {
 *     const builder = yield* Builder.make()
 *     return yield* Bitcode.encode(builder)
 *   }),
 * )
 * // bytes.slice(0, 4) equals Uint8Array.of(0x42, 0x43, 0xC0, 0xDE)
 * ```
 *
 * @category encoding
 * @since 0.0.0
 */
export const encode = Effect.fnUntraced(function* (
  self: Builder.Builder,
  options: Options = {},
): Effect.fn.Return<Uint8Array, LlvmError> {
  const state = yield* BuilderState.snapshot(self, 'Bitcode.encode')
  return yield* Effect.try({
    try: () => encodeSnapshot(state, options),
    catch: (cause) =>
      wrappedFailure({
        operation: 'Bitcode.encode',
        message:
          cause instanceof Error
            ? `LLVM bitcode encoding failed: ${cause.message}`
            : 'LLVM bitcode encoding failed',
        cause: cause,
      }),
  })
})
