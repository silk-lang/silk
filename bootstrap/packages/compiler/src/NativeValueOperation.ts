import * as Emitter from '@silklang/llvm/Emitter'
import type * as Value from '@silklang/llvm/Value'
import * as FloatingPoint from './FloatingPoint.js'
import * as Layout from './Layout.js'
import * as Mir from './Mir.js'
import type { LinearOperation } from './MirLinearization.js'
import * as NativeArith from './NativeArith.js'
import * as NativePlaceAddress from './NativePlaceAddress.js'
import type { Context } from './NativeOperationContext.js'
import * as NativeStorage from './NativeStorage.js'
import * as NativeType from './NativeType.js'
import * as Scalar from './Scalar.js'
import * as NativePlace from './NativePlace.js'
import * as Type from './Type.js'

type Operation = Extract<
  LinearOperation,
  {
    readonly _tag:
      | 'BindMatch'
      | 'Literal'
      | 'EnumConstant'
      | 'EnumValue'
      | 'EnumEquality'
      | 'StaticView'
      | 'StaticString'
      | 'StringFromUtf8Unchecked'
      | 'StringUtf8Bytes'
      | 'StringByteLength'
      | 'StringEqualsExact'
  }
>

export const emit = (context: Context, operation: Operation) => {
  const {
    arith,
    body,
    builder,
    i32,
    memcmp,
    staticPointers,
    storage: nativeStorage,
    types,
    usizeType,
  } = context
  const checkOrdinal = context.state.checkOrdinal
  switch (operation._tag) {
    case 'BindMatch': {
      const rootType = nativeStorage.fn.localTypes.at(operation.scrutinee.ordinal)
      const direct =
        (operation.selectors?.length ?? 0) === 0 &&
        rootType !== undefined &&
        !Type.isReference(Mir.semanticType(rootType)) &&
        NativeStorage.readLocal(nativeStorage, operation.scrutinee)._tag !== 'NativePlace'
      if (operation.type._tag === 'EnvironmentBorrow' || !direct) {
        const selectors: Array<Mir.PlaceSelector> = [...(operation.selectors ?? [])]
        const matched = operation.shape.type
        if (
          Type.runtimeKey(Mir.semanticType(operation.type)) !== Type.runtimeKey(matched) ||
          operation.path.length > 0
        ) {
          const resolved = Layout.coveragePath(
            context.program.layout,
            matched,
            operation.member,
            operation.path,
          )
          if (resolved === undefined)
            throw new RangeError('Match binding lost its canonical field path')
          selectors.push(
            ...resolved.selectors.map((selector): Mir.PlaceSelector =>
              selector._tag === 'Variant'
                ? {
                    _tag: 'VariantSelector',
                    ordinal: selector.ordinal,
                    provenance: operation.provenance,
                  }
                : {
                    _tag: 'FieldSelector',
                    field: selector.field,
                    provenance: operation.provenance,
                  },
            ),
          )
        }
        const { address, type } = NativePlaceAddress.resolve(
          context,
          operation.scrutinee,
          selectors,
          `match${operation.destination.ordinal}`,
        )
        if (operation.type._tag === 'EnvironmentBorrow') {
          const slot = nativeStorage.addressStorage.get(operation.destination.ordinal)
          if (slot === undefined) throw new RangeError('Borrowed match lost its entry slot')
          Emitter.store(body, address, slot)
        } else {
          // The successful match proves the variant. Project its canonical field directly;
          // converting the whole union would redispatch every variant for every binding.
          NativeStorage.receivePlace(
            nativeStorage,
            operation.destination,
            NativePlace.stored(context.program.layout, type, address),
          )
        }
        break
      }
      const physical = Layout.coverageBindingSlots(
        operation.shape,
        operation.member,
        operation.path,
        Mir.semanticType(operation.type),
      )
      if (physical === undefined) {
        throw new RangeError('LLVM match lost a pattern payload path')
      }
      const sourceLanes = operation.shape.lanes
      const targetLanes = NativeType.lanesFor(types, operation.type)
      const selected: Array<Value.Input> = []
      for (const [targetOrdinal, ordinal] of physical.entries()) {
        const value = NativeStorage.readLane(nativeStorage, operation.scrutinee, ordinal)
        const sourceLane = sourceLanes.at(ordinal)
        const targetLane = targetLanes.at(targetOrdinal)
        if (value === undefined || sourceLane === undefined || targetLane === undefined) {
          continue
        }
        selected.push(
          NativeArith.coerceLane(
            arith.lane,
            value,
            sourceLane,
            targetLane,
            `match${operation.destination.ordinal}_${targetOrdinal}_lane`,
          ),
        )
      }
      if (selected.length !== targetLanes.length) {
        throw new RangeError(
          `LLVM match binding %${operation.destination.ordinal} disagrees with its payload lanes (${physical.length} selected, ${targetLanes.length} required)`,
        )
      }
      NativeStorage.writeLocal(nativeStorage, operation.destination.ordinal, selected)
      break
    }
    case 'EnumConstant': {
      const lane = NativeType.lanesFor(types, operation.type).at(0)
      if (lane === undefined) throw new RangeError('LLVM enum constant lost its lane')
      const physicalType = NativeType.laneType(types, lane)
      NativeStorage.writeLocal(nativeStorage, operation.destination.ordinal, [
        operation.representation.signedness === 'Signed'
          ? Emitter.integerSigned(builder, physicalType, operation.discriminant)
          : Emitter.integerUnsigned(builder, physicalType, operation.discriminant),
      ])
      break
    }
    case 'EnumValue': {
      NativeStorage.writeLocal(
        nativeStorage,
        operation.destination.ordinal,
        NativeStorage.materialize(nativeStorage, operation.source),
      )
      break
    }
    case 'EnumEquality': {
      const left = NativeStorage.materialize(nativeStorage, operation.left).at(0)
      const right = NativeStorage.materialize(nativeStorage, operation.right).at(0)
      if (left === undefined || right === undefined)
        throw new RangeError('LLVM enum equality lost an operand lane')
      const compared = Emitter.integerCompare(
        body,
        operation.negated ? 'ne' : 'eq',
        left,
        right,
        `enum${operation.destination.ordinal}_${operation.negated ? 'not_equal' : 'equal'}`,
      )
      NativeStorage.writeLocal(nativeStorage, operation.destination.ordinal, [
        Emitter.cast(body, 'zext', compared, i32, `enum${operation.destination.ordinal}_result`),
      ])
      break
    }
    case 'Literal': {
      const lane = NativeType.lanesFor(types, operation.type).at(0)
      if (lane === undefined) throw new RangeError('LLVM literal lost its lane')
      const physicalType = NativeType.laneType(types, lane)
      const semantic = Mir.semanticType(operation.type)
      const floating = typeof semantic === 'string' ? Scalar.find(semantic) : undefined
      if (floating?.category === 'Floating') {
        NativeStorage.writeLocal(nativeStorage, operation.destination.ordinal, [
          Emitter.floatingRaw(
            builder,
            physicalType,
            floating.spelling === 'f32' ? 'float' : 'double',
            FloatingPoint.littleEndianBytes({
              width: floating.spelling === 'f32' ? 32 : 64,
              bits: BigInt(operation.value),
            }),
          ),
        ])
        break
      }
      const unsigned =
        typeof semantic === 'string' && Scalar.find(semantic)?.signedness === 'Unsigned'
      NativeStorage.writeLocal(nativeStorage, operation.destination.ordinal, [
        unsigned
          ? Emitter.integerUnsigned(builder, physicalType, BigInt(operation.value))
          : Emitter.integerSigned(builder, physicalType, BigInt(operation.value)),
      ])
      break
    }
    case 'StaticView': {
      const address = staticPointers.get(operation.data)
      if (address === undefined || usizeType === undefined) {
        throw new RangeError('LLVM static view lost its data placement or usize type')
      }
      NativeStorage.writeLocal(nativeStorage, operation.destination.ordinal, [
        address,
        Emitter.integerUnsigned(builder, usizeType, operation.length),
      ])
      break
    }
    case 'StaticString': {
      const address = staticPointers.get(operation.data)
      if (address === undefined || usizeType === undefined) {
        throw new RangeError('LLVM static string lost its data placement or usize type')
      }
      NativeStorage.writeLocal(nativeStorage, operation.destination.ordinal, [
        address,
        Emitter.integerUnsigned(builder, usizeType, operation.byteLength),
      ])
      break
    }
    case 'StringFromUtf8Unchecked': {
      NativeStorage.writeLocal(
        nativeStorage,
        operation.destination.ordinal,
        NativeStorage.materialize(nativeStorage, operation.bytes),
      )
      break
    }
    case 'StringUtf8Bytes': {
      NativeStorage.writeLocal(
        nativeStorage,
        operation.destination.ordinal,
        NativeStorage.materialize(nativeStorage, operation.string),
      )
      break
    }
    case 'StringByteLength': {
      const length = NativeStorage.materialize(nativeStorage, operation.string).at(1)
      if (length === undefined) {
        throw new RangeError('LLVM string lost its byte-length lane')
      }
      NativeStorage.writeLocal(nativeStorage, operation.destination.ordinal, [length])
      break
    }
    case 'StringEqualsExact': {
      const [leftAddress, leftLength] = NativeStorage.materialize(nativeStorage, operation.left)
      const [rightAddress, rightLength] = NativeStorage.materialize(nativeStorage, operation.right)
      if (
        leftAddress === undefined ||
        leftLength === undefined ||
        rightAddress === undefined ||
        rightLength === undefined ||
        memcmp === undefined ||
        usizeType === undefined
      ) {
        throw new RangeError('LLVM string equality lost its lanes or runtime helper')
      }
      const lengthsEqual = Emitter.integerCompare(
        body,
        'eq',
        leftLength,
        rightLength,
        `string${operation.destination.ordinal}_lengths_equal`,
      )
      const zeroLength = Emitter.integerUnsigned(builder, usizeType, 0n)
      const comparedLength = Emitter.select(
        body,
        lengthsEqual,
        leftLength,
        zeroLength,
        `string${operation.destination.ordinal}_compared_length`,
      )
      const compared = Emitter.callDirect(
        body,
        memcmp,
        [leftAddress, rightAddress, comparedLength],
        `string${operation.destination.ordinal}_memcmp`,
      )
      if (compared === undefined) {
        throw new RangeError('LLVM string equality produced no comparison result')
      }
      const zero = Emitter.integerSigned(builder, i32, 0n)
      const bytesEqual = Emitter.integerCompare(
        body,
        'eq',
        compared,
        zero,
        `string${operation.destination.ordinal}_bytes_equal`,
      )
      const exact = Emitter.binary(
        body,
        'and',
        lengthsEqual,
        bytesEqual,
        `string${operation.destination.ordinal}_exact`,
      )
      const selected = operation.negated
        ? Emitter.integerCompare(
            body,
            'eq',
            exact,
            Emitter.integerUnsigned(builder, Emitter.integerType(builder, 1), 0n),
            `string${operation.destination.ordinal}_negated`,
          )
        : exact
      NativeStorage.writeLocal(nativeStorage, operation.destination.ordinal, [
        Emitter.cast(body, 'zext', selected, i32, `string${operation.destination.ordinal}_result`),
      ])
      break
    }
  }
  context.state.checkOrdinal = checkOrdinal
}
