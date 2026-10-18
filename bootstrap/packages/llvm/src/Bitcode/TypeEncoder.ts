import * as Bitstream from '../internal/Bitstream.js'
import type * as BuilderState from '../internal/BuilderState.js'
import * as DeclarationSchema from '../internal/DeclarationBitcodeSchema.js'

const simpleTypeCode: Readonly<Record<string, number>> = {
  Void: 2,
  Float: 3,
  Double: 4,
  Label: 5,
  Half: 10,
  X86Fp80: 13,
  Fp128: 14,
  PpcFp128: 15,
  Metadata: 16,
  Token: 22,
  BFloat: 23,
  X86Amx: 24,
}

/** @internal */
export const writeTypes = (
  module: Bitstream.BlockWriter,
  state: BuilderState.Snapshot,
  width: number,
): void => {
  if (state.types.length === 0) return
  const schema = DeclarationSchema.type(width)
  const block = Bitstream.enterBlock(module.writer, schema.block, module.abbrevWidth)
  Bitstream.writeRecord(block, schema.numEntry, [state.types.length])
  for (const description of state.types) {
    switch (description._tag) {
      case 'Simple': {
        const code = simpleTypeCode[description.tag]
        if (code === undefined) throw new Error(`unsupported simple type ${description.tag}`)
        Bitstream.writeRecord(block, schema.simple, [code])
        break
      }
      case 'Integer':
        Bitstream.writeRecord(block, schema.integer, [description.bitWidth])
        break
      case 'Pointer':
        Bitstream.writeRecord(block, schema.pointer, [description.addressSpace.value])
        break
      case 'Function':
        Bitstream.writeRecord(block, schema.functionType, [
          description.variadic ? 1 : 0,
          description.returnType,
          description.parameters,
        ])
        break
      case 'Vector':
        Bitstream.writeRecord(block, schema.vector, [description.length, description.child])
        break
      case 'Array':
        Bitstream.writeRecord(block, schema.array, [description.length, description.child])
        break
      case 'Structure':
        Bitstream.writeRecord(block, schema.structAnon, [
          description.packed ? 1 : 0,
          description.fields,
        ])
        break
      case 'NamedStructure':
        Bitstream.writeRecord(block, schema.structName, [description.name.bytes])
        if (description.body === undefined) {
          Bitstream.writeRecord(block, schema.opaque, [])
        } else {
          Bitstream.writeRecord(block, schema.structNamed, [
            description.body.packed ? 1 : 0,
            description.body.fields,
          ])
        }
        break
      case 'TargetExtension':
        Bitstream.writeRecord(block, schema.structName, [description.name.bytes])
        Bitstream.writeRecord(block, schema.target, [
          description.types.length,
          description.types,
          description.integers,
        ])
        break
    }
  }
  Bitstream.endBlock(block)
}
