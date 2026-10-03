import type * as ByteString from '../ByteString.js'
import * as Bitstream from '../internal/Bitstream.js'
import type * as BuilderState from '../internal/BuilderState.js'
import * as DeclarationSchema from '../internal/DeclarationBitcodeSchema.js'
import type { ConstantAdapter, GlobalOrder } from './shared.js'

/** @internal */
export const buildConstantAdapter = (
  state: BuilderState.Snapshot,
  order: GlobalOrder,
): ConstantAdapter => {
  const local: Array<number> = []
  const localIndex = new Map<number, number>()
  state.constants.forEach((constant, index) => {
    if (constant._tag === 'Global') return
    localIndex.set(index, local.length)
    local.push(index)
  })
  const valueIndex = (constantIndex: number): number => {
    const constant = state.constants[constantIndex]
    if (constant === undefined) throw new Error('missing constant')
    if (constant._tag === 'Global') {
      const index = order.valueIndex.get(constant.global)
      if (index === undefined) throw new Error('global constant is not active')
      return index
    }
    const index = localIndex.get(constantIndex)
    if (index === undefined) throw new Error('local constant index is missing')
    return order.entries.length + index
  }
  return { local: local, localIndex, valueIndex }
}

/** @internal */
const littleEndianInteger = (bytes: ByteString.ByteString): bigint => {
  let result = 0n
  for (let index = 0; index < bytes.bytes.length; index += 1) {
    result |= BigInt(bytes.bytes[index] ?? 0) << BigInt(index * 8)
  }
  return result
}

/** @internal */
const integerRecordValues = (
  bitPattern: bigint,
  bitWidth: number,
  signed: boolean,
): { readonly narrow: bigint | undefined; readonly wide: ReadonlyArray<bigint> } => {
  const modulus = 1n << BigInt(bitWidth)
  const sign = 1n << BigInt(bitWidth - 1)
  const value = signed && (bitPattern & sign) !== 0n ? bitPattern - modulus : bitPattern
  if (bitWidth <= 64 && value >= -(1n << 63n) && value <= (1n << 62n) - 1n) {
    return {
      narrow: value >= 0n ? value << 1n : (-value << 1n) | 1n,
      wide: [],
    }
  }
  const limbs: Array<bigint> = []
  const count = Math.ceil(bitWidth / 64)
  for (let index = 0; index < count; index += 1) {
    const limb = (bitPattern >> BigInt(index * 64)) & 0xffff_ffff_ffff_ffffn
    const signedLimb = (limb & (1n << 63n)) === 0n ? limb : limb - (1n << 64n)
    limbs.push(signedLimb >= 0n ? signedLimb << 1n : (-signedLimb << 1n) | 1n)
  }
  return { narrow: undefined, wide: limbs }
}

const castOpcode: Readonly<Record<string, number>> = {
  trunc: 0,
  ptrtoint: 9,
  inttoptr: 10,
  bitcast: 11,
  addrspacecast: 12,
}

const binaryOpcode: Readonly<Record<string, number>> = {
  add: 0,
  'add nsw': 0,
  'add nuw': 0,
  sub: 1,
  'sub nsw': 1,
  'sub nuw': 1,
  shl: 7,
  xor: 12,
}

/** @internal */
export const writeConstants = (
  module: Bitstream.BlockWriter,
  state: BuilderState.Snapshot,
  width: number,
  adapter: ConstantAdapter,
): void => {
  if (adapter.local.length === 0) return
  const schema = DeclarationSchema.constants(width)
  const block = Bitstream.enterBlock(module.writer, schema.block, module.abbrevWidth)
  let currentType = -1
  for (const constantIndex of adapter.local) {
    const constant = state.constants[constantIndex]
    if (constant === undefined) throw new Error('missing constant')
    if (constant.type !== currentType) {
      Bitstream.writeRecord(block, schema.setType, [constant.type])
      currentType = constant.type
    }
    switch (constant._tag) {
      case 'Integer': {
        const type = state.types[constant.type]
        if (type?._tag !== 'Integer') throw new Error('integer constant has non-integer type')
        const encoded = integerRecordValues(constant.bitPattern, type.bitWidth, constant.signed)
        if (encoded.narrow === undefined) {
          Bitstream.writeUnabbreviatedRecord(block, 5, encoded.wide)
        } else {
          Bitstream.writeRecord(block, schema.integer, [encoded.narrow])
        }
        break
      }
      case 'Float': {
        const value = littleEndianInteger(constant.bits)
        if (constant.format === 'half' || constant.format === 'bfloat') {
          Bitstream.writeRecord(block, schema.half, [value])
        } else if (constant.format === 'float') {
          Bitstream.writeRecord(block, schema.float, [value])
        } else if (constant.format === 'double') {
          Bitstream.writeRecord(block, schema.double, [value])
        } else if (constant.format === 'x86_fp80') {
          Bitstream.writeRecord(block, schema.fp80, [value >> 16n, value & 0xffffn])
        } else {
          Bitstream.writeRecord(block, schema.fp128, [value & 0xffff_ffff_ffff_ffffn, value >> 64n])
        }
        break
      }
      case 'Special': {
        let record: Bitstream.Abbreviation = schema.nullValue
        if (constant.kind === 'undef') record = schema.undef
        else if (constant.kind === 'poison') record = schema.poison
        Bitstream.writeRecord(block, record, [])
        break
      }
      case 'Aggregate':
        Bitstream.writeRecord(block, schema.aggregate, [constant.elements.map(adapter.valueIndex)])
        break
      case 'Splat': {
        const type = state.types[constant.type]
        const length = type?._tag === 'Vector' ? type.length : 0
        Bitstream.writeRecord(block, schema.aggregate, [
          Array.from({ length }, () => adapter.valueIndex(constant.value)),
        ])
        break
      }
      case 'BlockAddress': {
        const reference = state.constants[constant.function]
        const global = reference?._tag === 'Global' ? state.globals[reference.global] : undefined
        const fn = global?.kind === 'Function' ? state.functions[global.actorIndex] : undefined
        if (fn === undefined) throw new Error('blockaddress function is missing')
        Bitstream.writeUnabbreviatedRecord(block, 21, [
          fn.type,
          adapter.valueIndex(constant.function),
          constant.block,
        ])
        break
      }
      case 'FunctionReference': {
        const reference = state.constants[constant.function]
        const global = reference?._tag === 'Global' ? state.globals[reference.global] : undefined
        const fn = global?.kind === 'Function' ? state.functions[global.actorIndex] : undefined
        if (fn === undefined) throw new Error('function reference is missing')
        Bitstream.writeUnabbreviatedRecord(
          block,
          constant.kind === 'dso_local_equivalent' ? 27 : 29,
          [fn.type, adapter.valueIndex(constant.function)],
        )
        break
      }
      case 'String': {
        // A C-string record stores the bytes before its implicit terminator, and LLVM rejects an
        // empty one, so a lone NUL byte is written as an ordinary one-element string record.
        const trailingNull = constant.bytes.bytes.length > 1 && constant.bytes.bytes.at(-1) === 0
        Bitstream.writeRecord(block, trailingNull ? schema.cString : schema.string, [
          trailingNull ? constant.bytes.bytes.slice(0, -1) : constant.bytes.bytes,
        ])
        break
      }
      case 'Cast':
        Bitstream.writeRecord(block, schema.cast, [
          castOpcode[constant.kind] ?? 0,
          constant.type,
          adapter.valueIndex(constant.value),
        ])
        break
      case 'Binary':
        Bitstream.writeRecord(block, schema.binary, [
          binaryOpcode[constant.kind] ?? 0,
          adapter.valueIndex(constant.left),
          adapter.valueIndex(constant.right),
        ])
        break
      case 'GetElementPtr': {
        const base = state.constants[constant.base]
        if (base === undefined) throw new Error('missing getelementptr base')
        const values: Array<Bitstream.Scalar> = [
          constant.sourceType,
          base.type,
          adapter.valueIndex(constant.base),
        ]
        for (const index of constant.indices) {
          const value = state.constants[index]
          if (value === undefined) throw new Error('missing getelementptr index')
          values.push(value.type, adapter.valueIndex(index))
        }
        Bitstream.writeUnabbreviatedRecord(block, constant.inbounds ? 20 : 12, values)
        break
      }
      case 'Assembly': {
        const flags =
          (constant.sideEffect ? 1 : 0) |
          (constant.alignStack ? 2 : 0) |
          (constant.intelDialect ? 4 : 0) |
          (constant.canThrow ? 8 : 0)
        Bitstream.writeUnabbreviatedRecord(block, 30, [
          constant.type,
          flags,
          constant.assembly.bytes.length,
          ...constant.assembly.bytes,
          constant.constraints.bytes.length,
          ...constant.constraints.bytes,
        ])
        break
      }
      case 'Global':
        break
    }
  }
  Bitstream.endBlock(block)
}
