import * as Emitter from '@silklang/llvm/Emitter'
import * as NativePayload from './NativePayload.js'
import * as NativePlace from './NativePlace.js'
import * as LlvmBlock from '@silklang/llvm/Block'
import type * as Value from '@silklang/llvm/Value'
import * as Layout from './Layout.js'
import * as LayoutVerify from './LayoutVerify.js'
import type { LinearOperation } from './MirLinearization.js'
import * as NativeAggregate from './NativeAggregate.js'
import * as NativeHostFailure from './NativeHostFailure.js'
import * as NativeLanePointer from './NativeLanePointer.js'
import type { Context } from './NativeOperationContext.js'
import * as NativeStorage from './NativeStorage.js'
import * as NativeTermination from './NativeTermination.js'
import * as NativeType from './NativeType.js'
import * as SilkType from './Type.js'

type Operation = Extract<
  LinearOperation,
  {
    readonly _tag:
      | 'Allocate'
      | 'RawBufferFrom'
      | 'SharedFromAllocation'
      | 'SharedClone'
      | 'RawBufferCount'
      | 'RawBufferSlot'
      | 'RawBufferRead'
      | 'SliceView'
      | 'RawBufferView'
      | 'RawBufferCopy'
      | 'RawBufferFill'
      | 'SlotWrite'
      | 'ValidateLayout'
      | 'RepeatLayout'
      | 'SlotTake'
      | 'SlotCopy'
      | 'SlotDrop'
  }
>

export const emit = (context: Context, operation: Operation) => {
  const {
    body,
    builder,
    cleanup,
    entry,
    free,
    hostFailure,
    i32,
    lanePointers,
    malloc,
    pointer,
    program,
    storage: nativeStorage,
    types,
    unsignedOverflowSignatures,
    usizeType,
  } = context
  let trapBlock: LlvmBlock.Block | undefined
  const checkOrdinal = context.state.checkOrdinal
  switch (operation._tag) {
    case 'Allocate': {
      const [bytes, alignment] = NativeStorage.materialize(nativeStorage, operation.layout)
      if (
        bytes === undefined ||
        alignment === undefined ||
        usizeType === undefined ||
        malloc === undefined
      ) {
        throw new RangeError('LLVM allocation lost its platform boundary')
      }
      const one = Emitter.integerUnsigned(builder, usizeType, 1n)
      const zero = Emitter.integerUnsigned(builder, usizeType, 0n)
      const padding = Emitter.binary(
        body,
        'sub',
        alignment,
        one,
        `allocation${operation.destination.ordinal}_padding`,
      )
      const usizeBits = program.layout.target.pointerSize * 8
      let unsignedOverflowSignature = unsignedOverflowSignatures.get(usizeBits)
      if (unsignedOverflowSignature === undefined) {
        const i1 = Emitter.integerType(builder, 1)
        unsignedOverflowSignature = {
          returnType: Emitter.structureType(builder, [usizeType, i1]),
          parameters: [usizeType, usizeType],
        }
        unsignedOverflowSignatures.set(usizeBits, unsignedOverflowSignature)
      }
      const requestPair = Emitter.intrinsicCall(
        body,
        'uadd.with.overflow',
        [usizeType],
        [bytes, padding],
        `allocation${operation.destination.ordinal}_request_pair`,
        { signature: unsignedOverflowSignature },
      )
      if (requestPair === undefined) {
        throw new RangeError('LLVM allocation size calculation produced no value')
      }
      const requested = Emitter.extractValue(
        body,
        requestPair,
        [0],
        `allocation${operation.destination.ordinal}_requested`,
      )
      const overflowed = Emitter.extractValue(
        body,
        requestPair,
        [1],
        `allocation${operation.destination.ordinal}_overflowed`,
      )
      const empty = Emitter.integerCompare(
        body,
        'eq',
        requested,
        zero,
        `allocation${operation.destination.ordinal}_empty`,
      )
      const physicalSize = Emitter.select(
        body,
        empty,
        one,
        requested,
        `allocation${operation.destination.ordinal}_physical_size`,
      )
      const raw = Emitter.callDirect(
        body,
        malloc,
        [physicalSize],
        `allocation${operation.destination.ordinal}_raw`,
      )
      if (raw === undefined) throw new RangeError('LLVM malloc returned no value')
      const rawAddress = Emitter.cast(
        body,
        'ptrtoint',
        raw,
        usizeType,
        `allocation${operation.destination.ordinal}_context`,
      )
      const missing = Emitter.integerCompare(
        body,
        'eq',
        rawAddress,
        zero,
        `allocation${operation.destination.ordinal}_missing`,
      )
      const rejected = Emitter.binary(
        body,
        'or',
        overflowed,
        missing,
        `allocation${operation.destination.ordinal}_rejected`,
      )
      const failed = Emitter.block(body, `allocation${operation.destination.ordinal}_failure`)
      const acquired = Emitter.block(body, `allocation${operation.destination.ordinal}_success`)
      Emitter.conditionalBranch(body, rejected, failed, acquired)
      Emitter.setInsertionPoint(body, failed)
      if (free === undefined) throw new RangeError('LLVM allocation lost release shim')
      Emitter.callDirect(body, free, [raw])
      NativeHostFailure.emit(hostFailure, operation)
      Emitter.setInsertionPoint(body, acquired)
      const advanced = Emitter.binary(
        body,
        'add',
        rawAddress,
        padding,
        `allocation${operation.destination.ordinal}_advanced`,
      )
      const mask = Emitter.binary(
        body,
        'sub',
        zero,
        alignment,
        `allocation${operation.destination.ordinal}_mask`,
      )
      const base = Emitter.binary(
        body,
        'and',
        advanced,
        mask,
        `allocation${operation.destination.ordinal}_base`,
      )
      NativeStorage.writeLocal(nativeStorage, operation.destination.ordinal, [
        base,
        bytes,
        alignment,
        one,
        rawAddress,
        one,
      ])
      break
    }
    case 'RawBufferFrom': {
      const allocation = NativeStorage.materialize(nativeStorage, operation.allocation)
      const count = NativeStorage.materialize(nativeStorage, operation.count).at(0)
      const bytes = allocation.at(1)
      const alignment = allocation.at(2)
      if (
        count === undefined ||
        bytes === undefined ||
        alignment === undefined ||
        usizeType === undefined
      ) {
        throw new RangeError('LLVM RawBuffer construction lost its lanes')
      }
      const expected = Emitter.binary(
        body,
        'mul',
        count,
        Emitter.integerUnsigned(builder, usizeType, BigInt(operation.stride)),
        `raw_buffer${operation.destination.ordinal}_bytes`,
      )
      const bytesMismatch = Emitter.integerCompare(
        body,
        'ne',
        expected,
        bytes,
        `raw_buffer${operation.destination.ordinal}_bytes_mismatch`,
      )
      const alignmentMismatch = Emitter.integerCompare(
        body,
        'ne',
        alignment,
        Emitter.integerUnsigned(builder, usizeType, BigInt(operation.elementAlignment)),
        `raw_buffer${operation.destination.ordinal}_alignment_mismatch`,
      )
      const invalid = Emitter.binary(
        body,
        'or',
        bytesMismatch,
        alignmentMismatch,
        `raw_buffer${operation.destination.ordinal}_invalid`,
      )
      trapBlock = NativeTermination.trapBlock(
        context.termination,
        'invalid raw buffer layout',
        operation.provenance.span,
      )
      const accepted = Emitter.block(body, `raw_buffer${operation.destination.ordinal}_accepted`)
      Emitter.conditionalBranch(body, invalid, trapBlock, accepted)
      Emitter.setInsertionPoint(body, accepted)
      NativeStorage.writeLocal(nativeStorage, operation.destination.ordinal, [...allocation, count])
      break
    }
    case 'SharedFromAllocation': {
      const allocation = NativeStorage.materialize(nativeStorage, operation.allocation)
      const baseAddress = allocation.at(0)
      const bytes = allocation.at(1)
      const alignment = allocation.at(2)
      if (
        baseAddress === undefined ||
        bytes === undefined ||
        alignment === undefined ||
        usizeType === undefined
      )
        throw new RangeError('LLVM local-shared initialization lost its allocation lanes')
      const bytesMismatch = Emitter.integerCompare(
        body,
        'ne',
        bytes,
        Emitter.integerUnsigned(builder, usizeType, BigInt(operation.block.size)),
        `shared${operation.destination.ordinal}_bytes_mismatch`,
      )
      const alignmentMismatch = Emitter.integerCompare(
        body,
        'ne',
        alignment,
        Emitter.integerUnsigned(builder, usizeType, BigInt(operation.block.alignment)),
        `shared${operation.destination.ordinal}_alignment_mismatch`,
      )
      const invalid = Emitter.binary(
        body,
        'or',
        bytesMismatch,
        alignmentMismatch,
        `shared${operation.destination.ordinal}_invalid`,
      )
      trapBlock = NativeTermination.trapBlock(
        context.termination,
        'invalid shared allocation layout',
        operation.provenance.span,
      )
      const accepted = Emitter.block(body, `shared${operation.destination.ordinal}_accepted`)
      Emitter.conditionalBranch(body, invalid, trapBlock, accepted)
      Emitter.setInsertionPoint(body, accepted)
      const base = Emitter.cast(
        body,
        'inttoptr',
        baseAddress,
        pointer,
        `shared${operation.destination.ordinal}_base`,
      )
      const storeWord = (offset: number, value: Value.Input) => {
        Emitter.store(
          body,
          value,
          NativeLanePointer.lanePointer(
            lanePointers,
            body,
            base,
            offset,
            `shared${operation.destination.ordinal}_${offset}_ptr`,
          ),
        )
      }
      storeWord(operation.block.strongOffset, Emitter.integerUnsigned(builder, usizeType, 1n))
      storeWord(operation.block.accessOffset, Emitter.integerUnsigned(builder, usizeType, 0n))
      const allocationLanes = Layout.callingShape(program.layout, SilkType.allocation)?.lanes
      if (allocationLanes === undefined)
        throw new RangeError('LLVM local-shared initialization lost its calling shapes')
      for (const [ordinal, lane] of allocationLanes.entries()) {
        const value = allocation.at(ordinal)
        const offset = LayoutVerify.laneOffset(program.layout, SilkType.allocation, lane.path)
        if (value === undefined || offset === undefined)
          throw new RangeError('LLVM local-shared initialization lost reclaim provenance')
        storeWord(operation.block.allocationOffset + offset, value)
      }
      NativeStorage.sendPlace(
        nativeStorage,
        NativePlace.stored(
          program.layout,
          operation.element,
          NativeLanePointer.lanePointer(
            lanePointers,
            body,
            base,
            operation.block.valueOffset,
            `shared${operation.destination.ordinal}_payload`,
          ),
        ),
        operation.value,
      )
      NativeStorage.writeLocal(nativeStorage, operation.destination.ordinal, [baseAddress])
      break
    }
    case 'SharedClone': {
      const self = NativeStorage.materialize(nativeStorage, operation.self).at(0)
      if (self === undefined || usizeType === undefined)
        throw new RangeError('LLVM local-shared clone lost its borrowed handle')
      const baseAddress = Emitter.load(
        body,
        usizeType,
        self,
        `shared${operation.destination.ordinal}_base_address`,
      )
      const base = Emitter.cast(
        body,
        'inttoptr',
        baseAddress,
        pointer,
        `shared${operation.destination.ordinal}_base`,
      )
      const countPointer = NativeLanePointer.lanePointer(
        lanePointers,
        body,
        base,
        operation.block.strongOffset,
        `shared${operation.destination.ordinal}_strong_ptr`,
      )
      const count = Emitter.load(
        body,
        usizeType,
        countPointer,
        `shared${operation.destination.ordinal}_strong`,
      )
      const overflow = Emitter.integerCompare(
        body,
        'eq',
        count,
        Emitter.integerUnsigned(builder, usizeType, operation.block.strongMaximum),
        `shared${operation.destination.ordinal}_overflow`,
      )
      trapBlock = NativeTermination.trapBlock(
        context.termination,
        'shared count overflow',
        operation.provenance.span,
      )
      const accepted = Emitter.block(body, `shared${operation.destination.ordinal}_clone_accepted`)
      Emitter.conditionalBranch(body, overflow, trapBlock, accepted)
      Emitter.setInsertionPoint(body, accepted)
      const incremented = Emitter.binary(
        body,
        'add',
        count,
        Emitter.integerUnsigned(builder, usizeType, 1n),
        `shared${operation.destination.ordinal}_incremented`,
      )
      Emitter.store(body, incremented, countPointer)
      NativeStorage.writeLocal(nativeStorage, operation.destination.ordinal, [baseAddress])
      break
    }
    case 'RawBufferCount': {
      const address = NativeStorage.materialize(nativeStorage, operation.buffer).at(0)
      const referenceType = entry.fn.localTypes.at(operation.buffer.ordinal)
      if (
        address === undefined ||
        referenceType?._tag !== 'Reference' ||
        !SilkType.isRawBuffer(referenceType.type.target) ||
        usizeType === undefined
      ) {
        throw new RangeError('LLVM RawBuffer.count lost its referenced buffer')
      }
      const value = Emitter.load(
        body,
        usizeType,
        NativeLanePointer.lanePointer(
          lanePointers,
          body,
          address,
          NativeAggregate.fieldOffset(program.layout, referenceType.type.target, 'count'),
          `raw_buffer_count${operation.destination.ordinal}_ptr`,
        ),
        `raw_buffer_count${operation.destination.ordinal}`,
      )
      NativeStorage.writeLocal(nativeStorage, operation.destination.ordinal, [value])
      break
    }
    case 'RawBufferSlot': {
      const address = NativeStorage.materialize(nativeStorage, operation.buffer).at(0)
      const index = NativeStorage.materialize(nativeStorage, operation.index).at(0)
      const element = Layout.entry(program.layout, operation.element)
      if (
        address === undefined ||
        index === undefined ||
        element === undefined ||
        usizeType === undefined
      ) {
        throw new RangeError('LLVM RawBuffer.slot lost its storage provenance')
      }
      const bufferType = SilkType.rawBuffer(operation.element)
      const count = Emitter.load(
        body,
        usizeType,
        NativeLanePointer.lanePointer(
          lanePointers,
          body,
          address,
          NativeAggregate.fieldOffset(program.layout, bufferType, 'count'),
          `raw_slot${operation.destination.ordinal}_count_ptr`,
        ),
        `raw_slot${operation.destination.ordinal}_count`,
      )
      const outOfBounds = Emitter.integerCompare(
        body,
        'uge',
        index,
        count,
        `raw_slot${operation.destination.ordinal}_bounds`,
      )
      trapBlock = NativeTermination.trapBlock(
        context.termination,
        'index out of bounds',
        operation.provenance.span,
      )
      const accepted = Emitter.block(body, `raw_slot${operation.destination.ordinal}_accepted`)
      Emitter.conditionalBranch(body, outOfBounds, trapBlock, accepted)
      Emitter.setInsertionPoint(body, accepted)
      const allocationOffset = NativeAggregate.fieldOffset(
        program.layout,
        bufferType,
        '$allocation',
      )
      const baseAddress = Emitter.load(
        body,
        usizeType,
        NativeLanePointer.lanePointer(
          lanePointers,
          body,
          address,
          allocationOffset +
            NativeAggregate.fieldOffset(program.layout, SilkType.allocation, '$base'),
          `raw_slot${operation.destination.ordinal}_base_ptr`,
        ),
        `raw_slot${operation.destination.ordinal}_base`,
      )
      const stride = Math.ceil(element.size / element.alignment) * element.alignment
      const offset = Emitter.binary(
        body,
        'mul',
        index,
        Emitter.integerUnsigned(builder, usizeType, BigInt(stride)),
        `raw_slot${operation.destination.ordinal}_offset`,
      )
      const selected = Emitter.binary(
        body,
        'add',
        baseAddress,
        offset,
        `raw_slot${operation.destination.ordinal}_address`,
      )
      NativeStorage.writeLocal(nativeStorage, operation.destination.ordinal, [selected])
      break
    }
    case 'RawBufferRead': {
      const address = NativeStorage.materialize(nativeStorage, operation.buffer).at(0)
      const index = NativeStorage.materialize(nativeStorage, operation.index).at(0)
      const element = Layout.entry(program.layout, operation.element)
      if (
        address === undefined ||
        index === undefined ||
        element === undefined ||
        usizeType === undefined
      ) {
        throw new RangeError('LLVM RawBuffer.read lost its storage provenance')
      }
      const bufferType = SilkType.rawBuffer(operation.element)
      const count = Emitter.load(
        body,
        usizeType,
        NativeLanePointer.lanePointer(
          lanePointers,
          body,
          address,
          NativeAggregate.fieldOffset(program.layout, bufferType, 'count'),
          `raw_read${operation.destination.ordinal}_count_ptr`,
        ),
        `raw_read${operation.destination.ordinal}_count`,
      )
      const outOfBounds = Emitter.integerCompare(
        body,
        'uge',
        index,
        count,
        `raw_read${operation.destination.ordinal}_bounds`,
      )
      trapBlock = NativeTermination.trapBlock(
        context.termination,
        'index out of bounds',
        operation.provenance.span,
      )
      const accepted = Emitter.block(body, `raw_read${operation.destination.ordinal}_accepted`)
      Emitter.conditionalBranch(body, outOfBounds, trapBlock, accepted)
      Emitter.setInsertionPoint(body, accepted)
      const allocationOffset = NativeAggregate.fieldOffset(
        program.layout,
        bufferType,
        '$allocation',
      )
      const baseAddress = Emitter.load(
        body,
        usizeType,
        NativeLanePointer.lanePointer(
          lanePointers,
          body,
          address,
          allocationOffset +
            NativeAggregate.fieldOffset(program.layout, SilkType.allocation, '$base'),
          `raw_read${operation.destination.ordinal}_base_ptr`,
        ),
        `raw_read${operation.destination.ordinal}_base`,
      )
      const stride = Math.ceil(element.size / element.alignment) * element.alignment
      const offset = Emitter.binary(
        body,
        'mul',
        index,
        Emitter.integerUnsigned(builder, usizeType, BigInt(stride)),
        `raw_read${operation.destination.ordinal}_offset`,
      )
      const selected = Emitter.binary(
        body,
        'add',
        baseAddress,
        offset,
        `raw_read${operation.destination.ordinal}_address`,
      )
      const base = Emitter.cast(
        body,
        'inttoptr',
        selected,
        pointer,
        `raw_read${operation.destination.ordinal}_element_ptr`,
      )
      NativeStorage.receivePlace(
        nativeStorage,
        operation.destination,
        NativePlace.stored(program.layout, operation.element, base),
      )
      break
    }
    case 'SliceView': {
      const lanes = NativeStorage.materialize(nativeStorage, operation.slice)
      const source = lanes.at(0)
      const count = lanes.at(1)
      const offset = NativeStorage.materialize(nativeStorage, operation.offset).at(0)
      const length = NativeStorage.materialize(nativeStorage, operation.length).at(0)
      if (
        source === undefined ||
        count === undefined ||
        offset === undefined ||
        length === undefined ||
        usizeType === undefined
      ) {
        throw new RangeError('LLVM Slice.view lost its view lanes or bounds')
      }
      const offsetOutOfBounds = Emitter.integerCompare(
        body,
        'ugt',
        offset,
        count,
        `slice_view${operation.destination.ordinal}_offset_bounds`,
      )
      const remaining = Emitter.binary(
        body,
        'sub',
        count,
        offset,
        `slice_view${operation.destination.ordinal}_remaining`,
      )
      const lengthOutOfBounds = Emitter.integerCompare(
        body,
        'ugt',
        length,
        remaining,
        `slice_view${operation.destination.ordinal}_length_bounds`,
      )
      const invalid = Emitter.binary(
        body,
        'or',
        offsetOutOfBounds,
        lengthOutOfBounds,
        `slice_view${operation.destination.ordinal}_invalid`,
      )
      trapBlock = NativeTermination.trapBlock(
        context.termination,
        'slice range out of bounds',
        operation.provenance.span,
      )
      const accepted = Emitter.block(body, `slice_view${operation.destination.ordinal}_accepted`)
      Emitter.conditionalBranch(body, invalid, trapBlock, accepted)
      Emitter.setInsertionPoint(body, accepted)
      const baseAddress = Emitter.cast(
        body,
        'ptrtoint',
        source,
        usizeType,
        `slice_view${operation.destination.ordinal}_base`,
      )
      const byteOffset = Emitter.binary(
        body,
        'mul',
        offset,
        Emitter.integerUnsigned(builder, usizeType, BigInt(operation.stride)),
        `slice_view${operation.destination.ordinal}_byte_offset`,
      )
      const selected = Emitter.binary(
        body,
        'add',
        baseAddress,
        byteOffset,
        `slice_view${operation.destination.ordinal}_address`,
      )
      const base = Emitter.cast(
        body,
        'inttoptr',
        selected,
        pointer,
        `slice_view${operation.destination.ordinal}_ptr`,
      )
      NativeStorage.writeLocal(nativeStorage, operation.destination.ordinal, [base, length])
      break
    }
    case 'RawBufferView': {
      const address = NativeStorage.materialize(nativeStorage, operation.buffer).at(0)
      const offset = NativeStorage.materialize(nativeStorage, operation.offset).at(0)
      const length = NativeStorage.materialize(nativeStorage, operation.length).at(0)
      if (
        address === undefined ||
        offset === undefined ||
        length === undefined ||
        usizeType === undefined
      ) {
        throw new RangeError('LLVM RawBuffer.view lost its storage provenance')
      }
      const bufferType = SilkType.rawBuffer(operation.element)
      const count = Emitter.load(
        body,
        usizeType,
        NativeLanePointer.lanePointer(
          lanePointers,
          body,
          address,
          NativeAggregate.fieldOffset(program.layout, bufferType, 'count'),
          `raw_view${operation.destination.ordinal}_count_ptr`,
        ),
        `raw_view${operation.destination.ordinal}_count`,
      )
      const offsetOutOfBounds = Emitter.integerCompare(
        body,
        'ugt',
        offset,
        count,
        `raw_view${operation.destination.ordinal}_offset_bounds`,
      )
      const remaining = Emitter.binary(
        body,
        'sub',
        count,
        offset,
        `raw_view${operation.destination.ordinal}_remaining`,
      )
      const lengthOutOfBounds = Emitter.integerCompare(
        body,
        'ugt',
        length,
        remaining,
        `raw_view${operation.destination.ordinal}_length_bounds`,
      )
      const invalid = Emitter.binary(
        body,
        'or',
        offsetOutOfBounds,
        lengthOutOfBounds,
        `raw_view${operation.destination.ordinal}_invalid`,
      )
      trapBlock = NativeTermination.trapBlock(
        context.termination,
        'raw buffer range out of bounds',
        operation.provenance.span,
      )
      const accepted = Emitter.block(body, `raw_view${operation.destination.ordinal}_accepted`)
      Emitter.conditionalBranch(body, invalid, trapBlock, accepted)
      Emitter.setInsertionPoint(body, accepted)
      const allocationOffset = NativeAggregate.fieldOffset(
        program.layout,
        bufferType,
        '$allocation',
      )
      const baseAddress = Emitter.load(
        body,
        usizeType,
        NativeLanePointer.lanePointer(
          lanePointers,
          body,
          address,
          allocationOffset +
            NativeAggregate.fieldOffset(program.layout, SilkType.allocation, '$base'),
          `raw_view${operation.destination.ordinal}_base_ptr`,
        ),
        `raw_view${operation.destination.ordinal}_base`,
      )
      const byteOffset = Emitter.binary(
        body,
        'mul',
        offset,
        Emitter.integerUnsigned(builder, usizeType, BigInt(operation.stride)),
        `raw_view${operation.destination.ordinal}_byte_offset`,
      )
      const selected = Emitter.binary(
        body,
        'add',
        baseAddress,
        byteOffset,
        `raw_view${operation.destination.ordinal}_address`,
      )
      const base = Emitter.cast(
        body,
        'inttoptr',
        selected,
        pointer,
        `raw_view${operation.destination.ordinal}_ptr`,
      )
      NativeStorage.writeLocal(nativeStorage, operation.destination.ordinal, [base, length])
      break
    }
    case 'RawBufferCopy': {
      const address = NativeStorage.materialize(nativeStorage, operation.buffer).at(0)
      const offset = NativeStorage.materialize(nativeStorage, operation.offset).at(0)
      const sourceLanes = NativeStorage.materialize(nativeStorage, operation.source)
      const sourceAddress = sourceLanes.at(0)
      const sourceLength = sourceLanes.at(1)
      const length = NativeStorage.materialize(nativeStorage, operation.length).at(0)
      const element = Layout.entry(program.layout, operation.element)
      if (
        address === undefined ||
        offset === undefined ||
        sourceAddress === undefined ||
        sourceLength === undefined ||
        length === undefined ||
        element === undefined ||
        usizeType === undefined
      ) {
        throw new RangeError('LLVM RawBuffer.copy lost its storage provenance')
      }
      const bufferType = SilkType.rawBuffer(operation.element)
      const count = Emitter.load(
        body,
        usizeType,
        NativeLanePointer.lanePointer(
          lanePointers,
          body,
          address,
          NativeAggregate.fieldOffset(program.layout, bufferType, 'count'),
          `raw_copy${operation.destination.ordinal}_count_ptr`,
        ),
        `raw_copy${operation.destination.ordinal}_count`,
      )
      const offsetOutOfBounds = Emitter.integerCompare(
        body,
        'ugt',
        offset,
        count,
        `raw_copy${operation.destination.ordinal}_offset_bounds`,
      )
      const remaining = Emitter.binary(
        body,
        'sub',
        count,
        offset,
        `raw_copy${operation.destination.ordinal}_remaining`,
      )
      const lengthOutOfBounds = Emitter.integerCompare(
        body,
        'ugt',
        length,
        remaining,
        `raw_copy${operation.destination.ordinal}_length_bounds`,
      )
      const sourceOutOfBounds = Emitter.integerCompare(
        body,
        'ugt',
        length,
        sourceLength,
        `raw_copy${operation.destination.ordinal}_source_bounds`,
      )
      const invalidRange = Emitter.binary(
        body,
        'or',
        offsetOutOfBounds,
        lengthOutOfBounds,
        `raw_copy${operation.destination.ordinal}_range`,
      )
      const invalid = Emitter.binary(
        body,
        'or',
        invalidRange,
        sourceOutOfBounds,
        `raw_copy${operation.destination.ordinal}_invalid`,
      )
      trapBlock = NativeTermination.trapBlock(
        context.termination,
        'raw buffer range out of bounds',
        operation.provenance.span,
      )
      const accepted = Emitter.block(body, `raw_copy${operation.destination.ordinal}_accepted`)
      Emitter.conditionalBranch(body, invalid, trapBlock, accepted)
      Emitter.setInsertionPoint(body, accepted)
      const allocationOffset = NativeAggregate.fieldOffset(
        program.layout,
        bufferType,
        '$allocation',
      )
      const baseAddress = Emitter.load(
        body,
        usizeType,
        NativeLanePointer.lanePointer(
          lanePointers,
          body,
          address,
          allocationOffset +
            NativeAggregate.fieldOffset(program.layout, SilkType.allocation, '$base'),
          `raw_copy${operation.destination.ordinal}_base_ptr`,
        ),
        `raw_copy${operation.destination.ordinal}_base`,
      )
      const stride = Emitter.integerUnsigned(builder, usizeType, BigInt(operation.stride))
      const byteOffset = Emitter.binary(
        body,
        'mul',
        offset,
        stride,
        `raw_copy${operation.destination.ordinal}_byte_offset`,
      )
      const selected = Emitter.binary(
        body,
        'add',
        baseAddress,
        byteOffset,
        `raw_copy${operation.destination.ordinal}_address`,
      )
      const target = Emitter.cast(
        body,
        'inttoptr',
        selected,
        pointer,
        `raw_copy${operation.destination.ordinal}_ptr`,
      )
      const byteLength = Emitter.binary(
        body,
        'mul',
        length,
        stride,
        `raw_copy${operation.destination.ordinal}_bytes`,
      )
      // memmove, not memcpy: an overlapping source and destination is a defined move.
      Emitter.memmove(body, target, sourceAddress, byteLength, {
        destinationAlignment: Emitter.alignment(body, element.alignment),
        sourceAlignment: Emitter.alignment(body, element.alignment),
      })
      NativeStorage.writeLocal(nativeStorage, operation.destination.ordinal, [])
      break
    }
    case 'RawBufferFill': {
      const address = NativeStorage.materialize(nativeStorage, operation.buffer).at(0)
      const offset = NativeStorage.materialize(nativeStorage, operation.offset).at(0)
      const length = NativeStorage.materialize(nativeStorage, operation.length).at(0)
      const value = NativeStorage.materialize(nativeStorage, operation.value).at(0)
      if (
        address === undefined ||
        offset === undefined ||
        length === undefined ||
        value === undefined ||
        usizeType === undefined
      ) {
        throw new RangeError('LLVM RawBuffer.fill lost its storage provenance')
      }
      const bufferType = SilkType.rawBuffer('u8')
      const count = Emitter.load(
        body,
        usizeType,
        NativeLanePointer.lanePointer(
          lanePointers,
          body,
          address,
          NativeAggregate.fieldOffset(program.layout, bufferType, 'count'),
          `raw_fill${operation.destination.ordinal}_count_ptr`,
        ),
        `raw_fill${operation.destination.ordinal}_count`,
      )
      const offsetOutOfBounds = Emitter.integerCompare(
        body,
        'ugt',
        offset,
        count,
        `raw_fill${operation.destination.ordinal}_offset_bounds`,
      )
      const remaining = Emitter.binary(
        body,
        'sub',
        count,
        offset,
        `raw_fill${operation.destination.ordinal}_remaining`,
      )
      const lengthOutOfBounds = Emitter.integerCompare(
        body,
        'ugt',
        length,
        remaining,
        `raw_fill${operation.destination.ordinal}_length_bounds`,
      )
      const invalid = Emitter.binary(
        body,
        'or',
        offsetOutOfBounds,
        lengthOutOfBounds,
        `raw_fill${operation.destination.ordinal}_invalid`,
      )
      trapBlock = NativeTermination.trapBlock(
        context.termination,
        'raw buffer range out of bounds',
        operation.provenance.span,
      )
      const accepted = Emitter.block(body, `raw_fill${operation.destination.ordinal}_accepted`)
      Emitter.conditionalBranch(body, invalid, trapBlock, accepted)
      Emitter.setInsertionPoint(body, accepted)
      const allocationOffset = NativeAggregate.fieldOffset(
        program.layout,
        bufferType,
        '$allocation',
      )
      const baseAddress = Emitter.load(
        body,
        usizeType,
        NativeLanePointer.lanePointer(
          lanePointers,
          body,
          address,
          allocationOffset +
            NativeAggregate.fieldOffset(program.layout, SilkType.allocation, '$base'),
          `raw_fill${operation.destination.ordinal}_base_ptr`,
        ),
        `raw_fill${operation.destination.ordinal}_base`,
      )
      const selected = Emitter.binary(
        body,
        'add',
        baseAddress,
        offset,
        `raw_fill${operation.destination.ordinal}_address`,
      )
      const target = Emitter.cast(
        body,
        'inttoptr',
        selected,
        pointer,
        `raw_fill${operation.destination.ordinal}_ptr`,
      )
      Emitter.memset(body, target, value, length)
      NativeStorage.writeLocal(nativeStorage, operation.destination.ordinal, [])
      break
    }
    case 'SlotWrite': {
      const address = NativeStorage.materialize(nativeStorage, operation.slot).at(0)
      if (address === undefined || usizeType === undefined) {
        throw new RangeError('LLVM Slot.write lost its address')
      }
      const base = Emitter.cast(
        body,
        'inttoptr',
        address,
        pointer,
        `slot_write${operation.destination.ordinal}_base`,
      )
      NativeStorage.sendPlace(
        nativeStorage,
        NativePlace.stored(program.layout, operation.element, base),
        operation.value,
      )
      NativeStorage.writeLocal(nativeStorage, operation.destination.ordinal, [])
      break
    }
    case 'ValidateLayout': {
      const bytes = NativeStorage.materialize(nativeStorage, operation.bytes).at(0)
      const alignment = NativeStorage.materialize(nativeStorage, operation.alignment).at(0)
      if (bytes === undefined || alignment === undefined || usizeType === undefined) {
        throw new RangeError('LLVM layout validation lost its operands')
      }
      const name = `validate${operation.destination.ordinal}`
      const zero = Emitter.integerUnsigned(builder, usizeType, 0n)
      const one = Emitter.integerUnsigned(builder, usizeType, 1n)
      const nonZero = Emitter.integerCompare(body, 'ne', alignment, zero, `${name}_nonzero`)
      const decremented = Emitter.binary(body, 'sub', alignment, one, `${name}_decrement`)
      const masked = Emitter.binary(body, 'and', alignment, decremented, `${name}_mask`)
      const powerOfTwo = Emitter.integerCompare(body, 'eq', masked, zero, `${name}_pow2`)
      const valid = Emitter.binary(body, 'and', nonZero, powerOfTwo, `${name}_valid`)
      const members = operation.type.type.members
      const layoutOrdinal = members.findIndex((member) => SilkType.equals(member, SilkType.layout))
      const invalidOrdinal = members.findIndex((member) =>
        SilkType.equals(member, SilkType.invalidAlignment),
      )
      if (layoutOrdinal < 0 || invalidOrdinal < 0) {
        throw new RangeError('LLVM layout validation lost its union members')
      }
      const tag = Emitter.select(
        body,
        valid,
        Emitter.integerSigned(builder, i32, BigInt(layoutOrdinal)),
        Emitter.integerSigned(builder, i32, BigInt(invalidOrdinal)),
        `${name}_tag`,
      )
      // Layout packs {bytes, alignment}; InvalidAlignment packs {alignment} at slot 0.
      const first = Emitter.select(body, valid, bytes, alignment, `${name}_slot0`)
      const second = Emitter.select(body, valid, alignment, zero, `${name}_slot1`)
      const lanes = NativeType.lanesFor(types, operation.type)
      const values: Array<Value.Input> = [tag, first, second]
      while (values.length < lanes.length) {
        const lane = lanes.at(values.length)
        if (lane === undefined) break
        values.push(Emitter.nullValue(builder, NativeType.laneType(types, lane)))
      }
      NativeStorage.writeLocal(nativeStorage, operation.destination.ordinal, values)
      break
    }
    case 'RepeatLayout': {
      const layoutValues = NativeStorage.materialize(nativeStorage, operation.layout)
      const bytes = layoutValues.at(0)
      const alignment = layoutValues.at(1)
      const count = NativeStorage.materialize(nativeStorage, operation.count).at(0)
      if (
        bytes === undefined ||
        alignment === undefined ||
        count === undefined ||
        usizeType === undefined
      ) {
        throw new RangeError('LLVM repeated layout lost its operands')
      }
      const name = `repeat${operation.destination.ordinal}`
      const zero = Emitter.integerUnsigned(builder, usizeType, 0n)
      const one = Emitter.integerUnsigned(builder, usizeType, 1n)
      const maximum = Emitter.integerUnsigned(
        builder,
        usizeType,
        program.layout.target.pointerSize === 4 ? 4294967295n : 18446744073709551615n,
      )
      const alignmentZero = Emitter.integerCompare(
        body,
        'eq',
        alignment,
        zero,
        `${name}_alignment_zero`,
      )
      const safeAlignment = Emitter.select(
        body,
        alignmentZero,
        one,
        alignment,
        `${name}_safe_alignment`,
      )
      const summed = Emitter.binary(
        body,
        'add',
        bytes,
        Emitter.binary(body, 'sub', safeAlignment, one, `${name}_pad`),
        `${name}_summed`,
      )
      const quotient = Emitter.binary(body, 'udiv', summed, safeAlignment, `${name}_quotient`)
      const rounded = Emitter.binary(body, 'mul', quotient, safeAlignment, `${name}_rounded`)
      const stride = Emitter.select(body, alignmentZero, zero, rounded, `${name}_stride`)
      const countZero = Emitter.integerCompare(body, 'eq', count, zero, `${name}_count_zero`)
      const safeCount = Emitter.select(body, countZero, one, count, `${name}_safe_count`)
      const budget = Emitter.binary(body, 'udiv', maximum, safeCount, `${name}_budget`)
      const exceeds = Emitter.integerCompare(body, 'ugt', stride, budget, `${name}_exceeds`)
      const countPositive = Emitter.integerCompare(
        body,
        'ne',
        count,
        zero,
        `${name}_count_positive`,
      )
      // Rounding up can wrap the integer itself; classify that as overflow directly.
      const headroom = Emitter.binary(
        body,
        'sub',
        maximum,
        Emitter.binary(body, 'sub', safeAlignment, one, `${name}_pad2`),
        `${name}_headroom`,
      )
      const huge = Emitter.integerCompare(body, 'ugt', bytes, headroom, `${name}_huge`)
      const exceedsOrHuge = Emitter.binary(body, 'or', exceeds, huge, `${name}_exceeds_or_huge`)
      const overflow = Emitter.binary(body, 'and', countPositive, exceedsOrHuge, `${name}_overflow`)
      const total = Emitter.binary(body, 'mul', stride, count, `${name}_total`)
      const members = operation.type.type.members
      const layoutOrdinal = members.findIndex((member) => SilkType.equals(member, SilkType.layout))
      const overflowOrdinal = members.findIndex((member) =>
        SilkType.equals(member, SilkType.layoutOverflow),
      )
      if (layoutOrdinal < 0 || overflowOrdinal < 0) {
        throw new RangeError('LLVM repeated layout lost its union members')
      }
      const tag = Emitter.select(
        body,
        overflow,
        Emitter.integerSigned(builder, i32, BigInt(overflowOrdinal)),
        Emitter.integerSigned(builder, i32, BigInt(layoutOrdinal)),
        `${name}_tag`,
      )
      const totalOut = Emitter.select(body, overflow, zero, total, `${name}_bytes`)
      const lanes = NativeType.lanesFor(types, operation.type)
      const values: Array<Value.Input> = [tag, totalOut, alignment]
      while (values.length < lanes.length) {
        const lane = lanes.at(values.length)
        if (lane === undefined) break
        values.push(Emitter.nullValue(builder, NativeType.laneType(types, lane)))
      }
      NativeStorage.writeLocal(nativeStorage, operation.destination.ordinal, values)
      break
    }
    case 'SlotTake':
    case 'SlotCopy': {
      const address = NativeStorage.materialize(nativeStorage, operation.slot).at(0)
      if (address === undefined || usizeType === undefined) {
        throw new RangeError('LLVM Slot.take lost its address')
      }
      const base = Emitter.cast(
        body,
        'inttoptr',
        address,
        pointer,
        `slot_take${operation.destination.ordinal}_base`,
      )
      NativeStorage.receivePlace(
        nativeStorage,
        operation.destination,
        NativePlace.stored(program.layout, operation.element, base),
      )
      break
    }
    case 'SlotDrop': {
      const address = NativeStorage.materialize(nativeStorage, operation.slot).at(0)
      if (address === undefined || usizeType === undefined) {
        throw new RangeError('LLVM Slot.drop lost its address')
      }
      const base = Emitter.cast(
        body,
        'inttoptr',
        address,
        pointer,
        `slot_drop${operation.destination.ordinal}_base`,
      )
      NativeAggregate.dropThroughPlan(
        cleanup,
        operation.cleanup,
        NativePayload.place(types, NativePlace.stored(program.layout, operation.element, base)),
        `slot_drop${operation.destination.ordinal}`,
      )
      NativeStorage.writeLocal(nativeStorage, operation.destination.ordinal, [])
      break
    }
  }
  context.state.checkOrdinal = checkOrdinal
}
