import * as ByteString from '../ByteString.js'
import type * as BuilderState from '../internal/BuilderState.js'
import type * as ConstantDescription from '../internal/ConstantDescription.js'
import type * as GlobalDescription from '../internal/GlobalDescription.js'
import { blockIdentifier } from './FunctionRenderer.js'
import { identifier, quoted } from './shared.js'
import { renderType, typeAt } from './TypeRenderer.js'
import * as PackedBody from '../internal/PackedBody.js'

/** @internal */
export const constantAt = (
  state: BuilderState.Snapshot,
  index: number,
): ConstantDescription.Description => {
  const description = state.constants[index]
  if (description === undefined) throw new Error(`missing constant ${index}`)
  return description
}

/** @internal */
export const globalAt = (
  state: BuilderState.Snapshot,
  index: number,
): GlobalDescription.GlobalDescription => {
  const description = state.globals[index]
  if (description === undefined) throw new Error(`missing global ${index}`)
  return description
}

/** @internal */
export const reverseHex = (value: ByteString.ByteString): string =>
  [...value.bytes]
    .reverse()
    .map((byte) => byte.toString(16).toUpperCase().padStart(2, '0'))
    .join('')

/** @internal */
export const floatHex = (
  description: Extract<ConstantDescription.Description, { _tag: 'Float' }>,
): string => {
  let prefix = ''
  switch (description.format) {
    case 'half':
      prefix = 'H'
      break
    case 'bfloat':
      prefix = 'R'
      break
    case 'x86_fp80':
      prefix = 'K'
      break
    case 'fp128':
      prefix = 'L'
      break
    case 'ppc_fp128':
      prefix = 'M'
      break
  }
  if (description.format === 'float') {
    const source = ByteString.toUint8Array(description.bits)
    const sourceView = new DataView(source.buffer)
    const result = new Uint8Array(8)
    new DataView(result.buffer).setFloat64(0, sourceView.getFloat32(0, true), true)
    return `0x${reverseHex(ByteString.fromUint8Array(result))}`
  }
  return `0x${prefix}${reverseHex(description.bits)}`
}

/** @internal */
export const renderTypedConstant = (state: BuilderState.Snapshot, index: number): string => {
  const description = constantAt(state, index)
  return `${renderType(state, description.type)} ${renderConstant(state, index)}`
}

/**
 * Spells the canonical zero of a type.
 *
 * `Constant.nullValue`, `Constant.none`, and `Constant.zero` all encode to the same bitcode record,
 * so the textual spelling has to come from the type rather than from the constructor that was used:
 * `null` is only accepted for pointers, `none` only for tokens, and integers and floats reject
 * `zeroinitializer`.
 *
 * @internal
 */
export const zeroSpelling = (state: BuilderState.Snapshot, type: number): string => {
  const description = typeAt(state, type)
  if (description._tag === 'Pointer') return 'null'
  if (description._tag === 'Integer') return '0'
  if (description._tag === 'Simple') {
    switch (description.tag) {
      case 'Half':
      case 'BFloat':
      case 'Float':
      case 'Double':
        return '0.0'
      // The extended formats reject decimal literals outright and are only spelled in hexadecimal.
      case 'X86Fp80':
        return `0xK${'0'.repeat(20)}`
      case 'Fp128':
        return `0xL${'0'.repeat(32)}`
      case 'PpcFp128':
        return `0xM${'0'.repeat(32)}`
      case 'Token':
        return 'none'
      default:
        return 'zeroinitializer'
    }
  }
  return 'zeroinitializer'
}

/** @internal */
export const renderConstant = (state: BuilderState.Snapshot, index: number): string => {
  const description = constantAt(state, index)
  switch (description._tag) {
    case 'Global':
      return identifier('@', globalAt(state, description.global).name)
    case 'Integer': {
      if (!description.signed) return description.bitPattern.toString()
      const type = typeAt(state, description.type)
      if (type._tag !== 'Integer') return description.bitPattern.toString()
      const sign = 1n << BigInt(type.bitWidth - 1)
      return (description.bitPattern & sign) === 0n
        ? description.bitPattern.toString()
        : (description.bitPattern - (1n << BigInt(type.bitWidth))).toString()
    }
    case 'Float':
      return floatHex(description)
    case 'Special':
      return description.kind === 'undef' || description.kind === 'poison'
        ? description.kind
        : zeroSpelling(state, description.type)
    case 'String':
      return `c${quoted(description.bytes)}`
    case 'Aggregate': {
      const values = description.elements
        .map((element) => renderTypedConstant(state, element))
        .join(', ')
      if (description.kind === 'array') return `[${values}]`
      if (description.kind === 'vector') return `<${values}>`
      return description.kind === 'packed-structure' ? `<{ ${values} }>` : `{ ${values} }`
    }
    case 'Splat': {
      const type = typeAt(state, description.type)
      const length = type._tag === 'Vector' ? type.length : 0
      if (type._tag === 'Vector' && type.scalable) {
        return `splat (${renderTypedConstant(state, description.value)})`
      }
      return `<${Array.from({ length }, () => renderTypedConstant(state, description.value)).join(', ')}>`
    }
    case 'BlockAddress': {
      const reference = state.constants[description.function]
      const global = reference?._tag === 'Global' ? state.globals[reference.global] : undefined
      const fn = global?.kind === 'Function' ? state.functions[global.actorIndex] : undefined
      const body = fn?.body === undefined ? undefined : PackedBody.unpack(fn.body)
      if (
        global === undefined ||
        body === undefined ||
        body.blocks[description.block] === undefined
      ) {
        throw new Error('blockaddress references a missing function block')
      }
      return `blockaddress(${identifier('@', global.name)}, ${blockIdentifier(body, description.block)})`
    }
    case 'FunctionReference':
      return `${description.kind} ${renderConstant(state, description.function)}`
    case 'Cast':
      return `${description.kind} (${renderTypedConstant(state, description.value)} to ${renderType(state, description.type)})`
    case 'Binary':
      return `${description.kind} (${renderTypedConstant(state, description.left)}, ${renderTypedConstant(state, description.right)})`
    case 'GetElementPtr': {
      const inbounds = description.inbounds ? ' inbounds' : ''
      const indices = description.indices
        .map((constant, position) => {
          const rendered = renderTypedConstant(state, constant)
          return description.inrange === position ? `inrange(${rendered})` : rendered
        })
        .join(', ')
      return `getelementptr${inbounds} (${renderType(state, description.sourceType)}, ${renderTypedConstant(state, description.base)}${indices === '' ? '' : `, ${indices}`})`
    }
    case 'Assembly': {
      const flags = [
        description.sideEffect ? 'sideeffect' : '',
        description.alignStack ? 'alignstack' : '',
        description.intelDialect ? 'inteldialect' : '',
        description.canThrow ? 'unwind' : '',
      ].filter((flag) => flag !== '')
      return `asm${flags.length === 0 ? '' : ` ${flags.join(' ')}`} ${quoted(description.assembly)}, ${quoted(description.constraints)}`
    }
  }
}
