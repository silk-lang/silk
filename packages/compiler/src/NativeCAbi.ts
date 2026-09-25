import * as Emitter from '@silklang/llvm/Emitter'
import * as Attribute from '@silklang/llvm/Attribute'
import type * as CAbi from './CAbi.js'

/** Emits the target-classified C integer extensions on declarations, thunks, and their direct calls. */
export const attributes = (
  builder: Emitter.Module,
  signature: CAbi.CAbiSignature,
): Attribute.FunctionSet | undefined => {
  const { contract } = signature
  const functionAttributes: Array<Attribute.Attribute> = []
  if (contract.memory !== 'readwrite' || contract.locality !== 'external') {
    const access = { none: 0, read: 1, write: 2, readwrite: 3 }[contract.memory]
    const effects = contract.locality === 'arguments' ? access : access * 21
    functionAttributes.push(Emitter.integerAttribute(builder, 'memory', effects))
  }
  if (contract.noReturn) functionAttributes.push(Emitter.flagAttribute(builder, 'noreturn'))
  let hasSlotAttributes = false
  const group = (type: CAbi.CAbiType, ordinal: number) => {
    const entries: Array<Attribute.Attribute> = []
    if (type._tag === 'Integer' && type.extension !== 'None')
      entries.push(
        Emitter.flagAttribute(builder, type.extension === 'Sign' ? 'signext' : 'zeroext'),
      )
    if (ordinal >= 0) {
      if (contract.noCapture.includes(ordinal) || contract.borrow.includes(ordinal))
        entries.push(Emitter.integerAttribute(builder, 'captures', 0))
      if (contract.borrow.includes(ordinal)) {
        entries.push(Emitter.flagAttribute(builder, 'nofree'))
        if (type._tag === 'Pointer' && !type.type.mutable)
          entries.push(Emitter.flagAttribute(builder, 'readonly'))
      }
      if (contract.returned === ordinal) entries.push(Emitter.flagAttribute(builder, 'returned'))
    }
    if (entries.length > 0) hasSlotAttributes = true
    return Emitter.attributeSet(builder, entries)
  }
  const returnAttributes = group(signature.result, -1)
  const parameterAttributes = Array.from(signature.parameters, group)
  if (functionAttributes.length === 0 && !hasSlotAttributes) return undefined
  return Emitter.functionAttributes(builder, {
    functionAttributes: Emitter.attributeSet(builder, functionAttributes),
    returnAttributes,
    parameterAttributes,
  })
}
