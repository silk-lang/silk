import type * as ByteString from '../ByteString.js'
import * as Bitstream from '../internal/Bitstream.js'
import type * as BuilderState from '../internal/BuilderState.js'
import * as CanonicalKey from '../internal/CanonicalKey.js'
import * as CoreSchema from '../internal/CoreBitcodeSchema.js'
import type * as FunctionBodyDescription from '../internal/FunctionBodyDescription.js'
import * as MemoryAccess from '../MemoryAccess.js'
import { metadataNodeAt, writeFunctionAttachments } from './MetadataEncoder.js'
import type { ConstantAdapter, GlobalOrder, MetadataAdapter } from './shared.js'
import * as PackedBody from '../internal/PackedBody.js'

/** @internal */
const fastMathCode = (flags: FunctionBodyDescription.FastMath): number =>
  (flags.noNaNs ? 1 << 1 : 0) |
  (flags.noInfinities ? 1 << 2 : 0) |
  (flags.noSignedZeros ? 1 << 3 : 0) |
  (flags.allowReciprocal ? 1 << 4 : 0) |
  (flags.allowContract ? 1 << 5 : 0) |
  (flags.approximateFunctions ? 1 << 6 : 0) |
  (flags.allowReassociation ? 1 << 7 : 0)

interface FunctionIndex {
  readonly valueIds: ReadonlyMap<number, number>
  readonly instructionOffsets: ReadonlyMap<number, number>
  readonly moduleValues: number
}

/** @internal */
const functionIndex = (
  body: FunctionBodyDescription.Snapshot,
  moduleValues: number,
): FunctionIndex => {
  const valueIds = new Map<number, number>()
  for (let index = 0; index < body.arguments.length; index += 1) {
    const value = body.arguments[index]
    if (value !== undefined) valueIds.set(value, moduleValues + index)
  }
  const instructionOffsets = new Map<number, number>()
  let nextValue = moduleValues + body.arguments.length
  for (const block of body.blocks) {
    for (const instructionIndex of block.instructions) {
      instructionOffsets.set(instructionIndex, nextValue)
      const result = body.instructions[instructionIndex]?.result
      if (result !== undefined) {
        valueIds.set(result, nextValue)
        nextValue += 1
      }
    }
  }
  return { valueIds, instructionOffsets, moduleValues }
}

/** @internal */
const resolvedBodyOperand = (
  body: FunctionBodyDescription.Snapshot,
  operand: FunctionBodyDescription.Operand,
  seen: ReadonlySet<number> = new Set(),
): FunctionBodyDescription.Operand => {
  if (operand._tag === 'Constant') return operand
  const value = body.values[operand.value]
  if (value?.source._tag !== 'Forward' || value.source.resolved === undefined) return operand
  if (seen.has(operand.value)) throw new Error('forward value cycle')
  const next = new Set(seen)
  next.add(operand.value)
  return resolvedBodyOperand(body, value.source.resolved, next)
}

/** @internal */
const absoluteOperand = (
  body: FunctionBodyDescription.Snapshot,
  index: FunctionIndex,
  constants: ConstantAdapter,
  operand: FunctionBodyDescription.Operand,
): number => {
  const resolved = resolvedBodyOperand(body, operand)
  if (resolved._tag === 'Constant') return constants.valueIndex(resolved.constant)
  const value = index.valueIds.get(resolved.value)
  if (value === undefined) throw new Error('local value index is missing')
  return value
}

/** @internal */
const relativeOperand = (
  body: FunctionBodyDescription.Snapshot,
  index: FunctionIndex,
  constants: ConstantAdapter,
  instructionIndex: number,
  operand: FunctionBodyDescription.Operand,
): number => {
  const offset = index.instructionOffsets.get(instructionIndex)
  if (offset === undefined) throw new Error('instruction offset is missing')
  const value = offset - absoluteOperand(body, index, constants, operand)
  // LLVM value IDs use unsigned 32-bit subtraction, including forward references.
  return value >>> 0
}

/** @internal */
const bodyOperandType = (
  state: BuilderState.Snapshot,
  body: FunctionBodyDescription.Snapshot,
  operand: FunctionBodyDescription.Operand,
): number => {
  const resolved = resolvedBodyOperand(body, operand)
  const type =
    resolved._tag === 'Constant'
      ? state.constants[resolved.constant]?.type
      : body.values[resolved.value]?.type
  if (type === undefined) throw new Error('body operand type is missing')
  return type
}

/** @internal */
const signedRelativeOperand = (
  body: FunctionBodyDescription.Snapshot,
  index: FunctionIndex,
  constants: ConstantAdapter,
  instructionIndex: number,
  operand: FunctionBodyDescription.Operand,
): number => {
  const offset = index.instructionOffsets.get(instructionIndex)
  if (offset === undefined) throw new Error('instruction offset is missing')
  const difference = offset - absoluteOperand(body, index, constants, operand)
  const absolute = Math.abs(difference)
  return difference > 0 ? absolute * 2 : absolute * 2 + 1
}

/** @internal */
const writeFunctionInstruction = (
  block: Bitstream.BlockWriter,
  state: BuilderState.Snapshot,
  body: FunctionBodyDescription.Snapshot,
  index: FunctionIndex,
  constants: ConstantAdapter,
  operandBundleTags: ReadonlyMap<string, number>,
  instructionIndex: number,
  instruction: FunctionBodyDescription.Instruction,
): void => {
  const relative = (operand: FunctionBodyDescription.Operand): number =>
    relativeOperand(body, index, constants, instructionIndex, operand)
  // LLVM 22 BitcodeWriter::pushValueAndType emits the type only for a forward
  // operand. Fixed call arguments and same-typed second operands already have it.
  // https://github.com/llvm/llvm-project/blob/llvmorg-22.1.8/llvm/lib/Bitcode/Writer/BitcodeWriter.cpp
  const valueAndType = (operand: FunctionBodyDescription.Operand): ReadonlyArray<number> => {
    const offset = index.instructionOffsets.get(instructionIndex)
    if (offset === undefined) throw new Error('instruction offset is missing')
    return [
      relative(operand),
      ...(absoluteOperand(body, index, constants, operand) >= offset
        ? [bodyOperandType(state, body, operand)]
        : []),
    ]
  }
  const callArguments = (
    call: Extract<FunctionBodyDescription.Instruction, { readonly _tag: 'Call' | 'Invoke' }>,
  ): ReadonlyArray<number> => {
    const signature = state.types[call.functionType]
    if (signature?._tag !== 'Function') throw new Error('call function type is missing')
    return call.arguments.flatMap((argument, ordinal) =>
      ordinal < signature.parameters.length ? [relative(argument)] : valueAndType(argument),
    )
  }
  switch (instruction._tag) {
    case 'Unary': {
      const math = fastMathCode(instruction.fastMath)
      Bitstream.writeUnabbreviatedRecord(block, CoreSchema.code.unary, [
        ...valueAndType(instruction.operand),
        0,
        ...(math === 0 ? [] : [math]),
      ])
      break
    }
    case 'Binary': {
      const math = fastMathCode(instruction.fastMath)
      const integerFlags =
        (instruction.integerFlags.noUnsignedWrap ? 1 : 0) |
        (instruction.integerFlags.noSignedWrap ? 2 : 0) |
        (instruction.integerFlags.exact ? 1 : 0)
      const flags = instruction.kind.startsWith('f') ? math : integerFlags
      Bitstream.writeUnabbreviatedRecord(block, CoreSchema.code.binary, [
        ...valueAndType(instruction.left),
        relative(instruction.right),
        CoreSchema.binaryOpcode[instruction.kind],
        ...(flags === 0 ? [] : [flags]),
      ])
      break
    }
    case 'Compare': {
      const math = fastMathCode(instruction.fastMath)
      const predicate =
        instruction.kind === 'integer'
          ? CoreSchema.integerPredicate[instruction.predicate]
          : CoreSchema.floatingPredicate[instruction.predicate]
      Bitstream.writeUnabbreviatedRecord(block, CoreSchema.code.compare, [
        ...valueAndType(instruction.left),
        relative(instruction.right),
        predicate,
        ...(math === 0 ? [] : [math]),
      ])
      break
    }
    case 'Select': {
      const math = fastMathCode(instruction.fastMath)
      Bitstream.writeUnabbreviatedRecord(block, CoreSchema.code.select, [
        ...valueAndType(instruction.onTrue),
        relative(instruction.onFalse),
        ...valueAndType(instruction.condition),
        ...(math === 0 ? [] : [math]),
      ])
      break
    }
    case 'Cast': {
      const flags = (instruction.noUnsignedWrap ? 1 : 0) | (instruction.noSignedWrap ? 2 : 0)
      Bitstream.writeUnabbreviatedRecord(block, CoreSchema.code.cast, [
        ...valueAndType(instruction.operand),
        instruction.destinationType,
        CoreSchema.castOpcode[instruction.kind],
        ...(flags === 0 ? [] : [flags]),
      ])
      break
    }
    case 'Freeze':
      Bitstream.writeUnabbreviatedRecord(block, CoreSchema.code.freeze, [
        ...valueAndType(instruction.operand),
      ])
      break
    case 'ExtractValue':
      Bitstream.writeUnabbreviatedRecord(block, CoreSchema.code.extractValue, [
        ...valueAndType(instruction.aggregate),
        ...instruction.indices,
      ])
      break
    case 'InsertValue':
      Bitstream.writeUnabbreviatedRecord(block, CoreSchema.code.insertValue, [
        ...valueAndType(instruction.aggregate),
        ...valueAndType(instruction.element),
        ...instruction.indices,
      ])
      break
    case 'Alloca': {
      const alignment = MemoryAccess.encodeAlignment(instruction.alignment)
      const flags =
        (alignment & 0x1f) |
        (instruction.inAlloca ? 1 << 5 : 0) |
        (1 << 6) |
        ((alignment >>> 5) << 8)
      Bitstream.writeUnabbreviatedRecord(block, CoreSchema.code.alloca, [
        instruction.allocationType,
        bodyOperandType(state, body, instruction.count),
        absoluteOperand(body, index, constants, instruction.count),
        flags,
        ...(instruction.addressSpace === 0 ? [] : [instruction.addressSpace]),
      ])
      break
    }
    case 'Load': {
      const values = [
        ...valueAndType(instruction.pointer),
        instruction.valueType,
        MemoryAccess.encodeAlignment(instruction.access.alignment),
        instruction.access.kind === 'volatile' ? 1 : 0,
      ]
      if (instruction.access.ordering !== 'none') {
        values.push(
          MemoryAccess.orderingCode[instruction.access.ordering],
          instruction.access.syncScope === 'singlethread' ? 0 : 1,
        )
      }
      Bitstream.writeUnabbreviatedRecord(
        block,
        instruction.access.ordering === 'none' ? CoreSchema.code.load : CoreSchema.code.loadAtomic,
        values,
      )
      break
    }
    case 'Store': {
      const values = [
        ...valueAndType(instruction.pointer),
        ...valueAndType(instruction.value),
        MemoryAccess.encodeAlignment(instruction.access.alignment),
        instruction.access.kind === 'volatile' ? 1 : 0,
      ]
      if (instruction.access.ordering !== 'none') {
        values.push(
          MemoryAccess.orderingCode[instruction.access.ordering],
          instruction.access.syncScope === 'singlethread' ? 0 : 1,
        )
      }
      Bitstream.writeUnabbreviatedRecord(
        block,
        instruction.access.ordering === 'none'
          ? CoreSchema.code.store
          : CoreSchema.code.storeAtomic,
        values,
      )
      break
    }
    case 'GetElementPtr':
      Bitstream.writeUnabbreviatedRecord(block, CoreSchema.code.getElementPtr, [
        instruction.inbounds ? 1 : 0,
        instruction.sourceType,
        ...valueAndType(instruction.base),
        ...instruction.indices.flatMap(valueAndType),
      ])
      break
    case 'ExtractElement':
      Bitstream.writeUnabbreviatedRecord(block, CoreSchema.code.extractElement, [
        ...valueAndType(instruction.vector),
        ...valueAndType(instruction.index),
      ])
      break
    case 'InsertElement':
      Bitstream.writeUnabbreviatedRecord(block, CoreSchema.code.insertElement, [
        ...valueAndType(instruction.vector),
        relative(instruction.element),
        ...valueAndType(instruction.index),
      ])
      break
    case 'ShuffleVector':
      Bitstream.writeUnabbreviatedRecord(block, CoreSchema.code.shuffleVector, [
        ...valueAndType(instruction.left),
        relative(instruction.right),
        relative(instruction.mask),
      ])
      break
    case 'Fence':
      Bitstream.writeUnabbreviatedRecord(block, CoreSchema.code.fence, [
        MemoryAccess.orderingCode[instruction.ordering],
        instruction.syncScope === 'singlethread' ? 0 : 1,
      ])
      break
    case 'CompareExchange':
      Bitstream.writeUnabbreviatedRecord(block, CoreSchema.code.compareExchange, [
        ...valueAndType(instruction.pointer),
        ...valueAndType(instruction.comparison),
        relative(instruction.replacement),
        instruction.access.kind === 'volatile' ? 1 : 0,
        MemoryAccess.orderingCode[instruction.access.ordering],
        instruction.access.syncScope === 'singlethread' ? 0 : 1,
        MemoryAccess.orderingCode[instruction.failureOrdering],
        instruction.weak ? 1 : 0,
        MemoryAccess.encodeAlignment(instruction.access.alignment),
      ])
      break
    case 'AtomicRmw':
      Bitstream.writeUnabbreviatedRecord(block, CoreSchema.code.atomicRmw, [
        ...valueAndType(instruction.pointer),
        ...valueAndType(instruction.value),
        MemoryAccess.operationCode[instruction.operation],
        instruction.access.kind === 'volatile' ? 1 : 0,
        MemoryAccess.orderingCode[instruction.access.ordering],
        instruction.access.syncScope === 'singlethread' ? 0 : 1,
        MemoryAccess.encodeAlignment(instruction.access.alignment),
      ])
      break
    case 'VaArg':
      Bitstream.writeUnabbreviatedRecord(block, CoreSchema.code.vaArg, [
        bodyOperandType(state, body, instruction.list),
        relative(instruction.list),
        instruction.valueType,
      ])
      break
    case 'IndirectBranch':
      Bitstream.writeUnabbreviatedRecord(block, CoreSchema.code.indirectBranch, [
        bodyOperandType(state, body, instruction.address),
        relative(instruction.address),
        ...instruction.destinations,
      ])
      break
    case 'Branch':
      Bitstream.writeUnabbreviatedRecord(block, CoreSchema.code.branch, [instruction.destination])
      break
    case 'ConditionalBranch':
      Bitstream.writeUnabbreviatedRecord(block, CoreSchema.code.branch, [
        instruction.onTrue,
        instruction.onFalse,
        relative(instruction.condition),
      ])
      break
    case 'Switch': {
      const resolved = resolvedBodyOperand(body, instruction.value)
      const type = resolved._tag === 'Constant' ? undefined : body.values[resolved.value]?.type
      const conditionType =
        type ??
        (resolved._tag === 'Constant'
          ? state.constants[resolved.constant]?.type
          : body.values[resolved.value]?.type)
      if (conditionType === undefined) throw new Error('switch condition type is missing')
      Bitstream.writeUnabbreviatedRecord(block, CoreSchema.code.switch, [
        conditionType ?? 0,
        relative(instruction.value),
        instruction.defaultBlock,
        ...instruction.cases.flatMap((entry) => [constants.valueIndex(entry.value), entry.block]),
      ])
      break
    }
    case 'Return':
      Bitstream.writeUnabbreviatedRecord(block, CoreSchema.code.return, [
        ...valueAndType(instruction.value),
      ])
      break
    case 'ReturnVoid':
      Bitstream.writeUnabbreviatedRecord(block, CoreSchema.code.return, [])
      break
    case 'Unreachable':
      Bitstream.writeUnabbreviatedRecord(block, CoreSchema.code.unreachable, [])
      break
    case 'Phi': {
      const values: Array<Bitstream.Scalar> = [instruction.type]
      for (const incoming of instruction.incoming) {
        values.push(
          signedRelativeOperand(body, index, constants, instructionIndex, incoming.value),
          incoming.block,
        )
      }
      const math = fastMathCode(instruction.fastMath)
      if (math !== 0) values.push(math)
      Bitstream.writeUnabbreviatedRecord(block, CoreSchema.code.phi, values)
      break
    }
    case 'LandingPad':
      Bitstream.writeUnabbreviatedRecord(block, 47, [instruction.type, 1, 0])
      break
    case 'Invoke': {
      for (const bundle of instruction.operandBundles) {
        const tag = operandBundleTags.get(CanonicalKey.bytes(bundle.tag))
        if (tag === undefined) throw new Error('operand bundle tag is missing')
        Bitstream.writeUnabbreviatedRecord(block, 55, [
          tag,
          ...bundle.operands.flatMap(valueAndType),
        ])
      }
      Bitstream.writeUnabbreviatedRecord(block, 13, [
        instruction.attributes === undefined ? 0 : instruction.attributes + 1,
        instruction.callingConvention | (1 << 13),
        instruction.normal,
        instruction.unwind,
        instruction.functionType,
        ...valueAndType(instruction.callee),
        ...callArguments(instruction),
      ])
      break
    }
    case 'Call': {
      for (const bundle of instruction.operandBundles) {
        const tag = operandBundleTags.get(CanonicalKey.bytes(bundle.tag))
        if (tag === undefined) throw new Error('operand bundle tag is missing')
        Bitstream.writeUnabbreviatedRecord(block, 55, [
          tag,
          ...bundle.operands.flatMap(valueAndType),
        ])
      }
      const math = fastMathCode(instruction.fastMath)
      const callType =
        (instruction.tail === 'tail' ? 1 : 0) |
        (instruction.callingConvention << 1) |
        (instruction.tail === 'musttail' ? 1 << 14 : 0) |
        (1 << 15) |
        (instruction.tail === 'notail' ? 1 << 16 : 0) |
        (math === 0 ? 0 : 1 << 17)
      Bitstream.writeUnabbreviatedRecord(block, CoreSchema.code.call, [
        instruction.attributes === undefined ? 0 : instruction.attributes + 1,
        callType,
        ...(math === 0 ? [] : [math]),
        instruction.functionType,
        ...valueAndType(instruction.callee),
        ...callArguments(instruction),
      ])
      break
    }
  }
}

/** @internal */
export const writeFunctionBodies = (
  module: Bitstream.BlockWriter,
  state: BuilderState.Snapshot,
  order: GlobalOrder,
  constants: ConstantAdapter,
  operandBundleTags: ReadonlyMap<string, number>,
  metadata: MetadataAdapter,
): void => {
  const moduleValues = order.entries.length + constants.local.length
  for (const { global, globalIndex } of order.entries) {
    if (global.kind !== 'Function') continue
    const packed = state.functions[global.actorIndex]?.body
    if (packed === undefined) continue
    const body = PackedBody.unpack(packed)
    const index = functionIndex(body, moduleValues)
    const block = Bitstream.enterBlock(
      module.writer,
      CoreSchema.functionBlock,
      module.abbrevWidth,
      false,
    )
    Bitstream.writeUnabbreviatedRecord(block, CoreSchema.code.declareBlocks, [body.blocks.length])
    let activeDebugLocation: number | undefined
    for (const bodyBlock of body.blocks) {
      for (const instructionIndex of bodyBlock.instructions) {
        const instruction = body.instructions[instructionIndex]
        if (instruction === undefined) throw new Error('function block instruction is missing')
        writeFunctionInstruction(
          block,
          state,
          body,
          index,
          constants,
          operandBundleTags,
          instructionIndex,
          instruction,
        )
        const debugLocation = body.debugLocations[instructionIndex]
        if (debugLocation === undefined) {
          activeDebugLocation = undefined
        } else if (activeDebugLocation === debugLocation) {
          Bitstream.writeUnabbreviatedRecord(block, 33, [])
        } else {
          const location = metadataNodeAt(state, metadata, debugLocation)
          if (location._tag !== 'Location')
            throw new Error('debug location has the wrong node kind')
          Bitstream.writeUnabbreviatedRecord(block, 35, [
            location.line,
            location.column,
            metadata.optional(location.scope),
            metadata.optional(location.inlinedAt),
            0,
          ])
          activeDebugLocation = debugLocation
        }
      }
    }
    writeFunctionAttachments(block, state, globalIndex, body, metadata)
    Bitstream.endBlock(block)
  }
}

/** @internal */
export const writeOperandBundleTags = (
  module: Bitstream.BlockWriter,
  state: BuilderState.Snapshot,
  order: GlobalOrder,
): ReadonlyMap<string, number> => {
  const tags = new Map<string, { readonly index: number; readonly value: ByteString.ByteString }>()
  for (const { global } of order.entries) {
    if (global.kind !== 'Function') continue
    const packed = state.functions[global.actorIndex]?.body
    if (packed === undefined || !packed.hasOperandBundles) continue
    for (const instruction of PackedBody.unpack(packed).instructions) {
      if (instruction._tag !== 'Call' && instruction._tag !== 'Invoke') continue
      for (const bundle of instruction.operandBundles) {
        const key = CanonicalKey.bytes(bundle.tag)
        if (!tags.has(key)) tags.set(key, { index: tags.size, value: bundle.tag })
      }
    }
  }
  if (tags.size > 0) {
    const block = Bitstream.enterBlock(
      module.writer,
      { id: 21, abbreviations: [] },
      module.abbrevWidth,
      false,
    )
    for (const { value } of tags.values()) {
      Bitstream.writeUnabbreviatedRecord(block, 1, value.bytes)
    }
    Bitstream.endBlock(block)
  }
  return new Map([...tags].map(([key, entry]) => [key, entry.index]))
}
