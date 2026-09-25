import * as Emitter from '@silklang/llvm/Emitter'
import * as LlvmBlock from '@silklang/llvm/Block'
import * as Value from '@silklang/llvm/Value'
import * as DeclarationFacts from './DeclarationFacts.js'
import * as Layout from './Layout.js'
import * as LayoutVerify from './LayoutVerify.js'
import * as Mir from './Mir.js'
import type { LinearOperation } from './MirLinearization.js'
import * as NativeArith from './NativeArith.js'
import * as NativeDebug from './NativeDebug.js'
import * as NativeLanePointer from './NativeLanePointer.js'
import * as NativeOwnedPlace from './NativeOwnedPlace.js'
import type { Context } from './NativeOperationContext.js'
import * as NativeStorage from './NativeStorage.js'
import * as NativeTermination from './NativeTermination.js'
import * as NativeType from './NativeType.js'
import * as NativePlace from './NativePlace.js'
import * as NativePlaceAddress from './NativePlaceAddress.js'
import * as SilkType from './Type.js'

type Operation = Extract<
  LinearOperation,
  {
    readonly _tag:
      | 'Move'
      | 'SetInitialized'
      | 'BeginLoan'
      | 'EndLoan'
      | 'SliceLength'
      | 'ConvertUnion'
      | 'Construct'
      | 'ConstructUnionVariant'
      | 'ConstructArray'
      | 'Project'
      | 'ReadPlace'
      | 'CheckPlace'
      | 'WritePlace'
  }
>

const candidateCondition = (
  context: Context,
  indices: NativeOwnedPlace.Candidate['indices'],
  tag: string,
) => {
  let condition: Value.Input | undefined
  for (const [ordinal, index] of indices.entries()) {
    const expected = Emitter.integerUnsigned(
      context.builder,
      context.usizeType ?? context.i32,
      BigInt(index.value),
    )
    const equal = Emitter.integerCompare(
      context.body,
      'eq',
      NativeStorage.readScalar(context.storage, index.local),
      expected,
      `${tag}_${ordinal}_index`,
    )
    condition =
      condition === undefined
        ? equal
        : Emitter.binary(context.body, 'and', condition, equal, `${tag}_${ordinal}_all`)
  }
  return condition
}

/** Ordinary owned indexing is a checked byte projection, independent of the array's lane width. */
const ownedAddress = (
  context: Context,
  root: Mir.LocalId,
  selectors: ReadonlyArray<Mir.PlaceSelector>,
  tag: string,
) => {
  const value = NativeStorage.readLocal(context.storage, root)
  if (value._tag !== 'NativePlace') throw new RangeError('Owned address lost its canonical storage')
  let type = Mir.semanticType(value.type)
  let base = NativePlace.base(value, context.storage, `${tag}_root`)
  let runtime = 0
  for (const selector of selectors) {
    const entry = Layout.entry(context.program.layout, type)
    if (selector._tag === 'FieldSelector' && entry?.representation._tag === 'Aggregate') {
      const field = entry.representation.fields.find((field) =>
        DeclarationFacts.sameFieldId(field.id, selector.field),
      )
      if (field === undefined) throw new RangeError('Owned address lost a field')
      base = NativeLanePointer.lanePointer(
        context.lanePointers,
        context.body,
        base,
        field.offset,
        `${tag}_field`,
      )
      type = field.type
      continue
    }
    if (selector._tag !== 'ElementSelector' || entry?.representation._tag !== 'Repeated')
      throw new RangeError('Owned address requires an ordinary field or element')
    let offset: Value.Input | number
    if (selector.index._tag === 'Proven')
      offset = selector.index.value * entry.representation.stride
    else {
      const index = NativeStorage.readScalar(context.storage, selector.index.local)
      const inBounds = Emitter.integerCompare(
        context.body,
        'ult',
        index,
        Emitter.integerUnsigned(
          context.builder,
          context.usizeType ?? context.i32,
          BigInt(entry.representation.length),
        ),
        `index${context.state.checkOrdinal}_${runtime}_in_bounds`,
      )
      NativeDebug.locate(
        context.debug,
        selector.provenance.span,
        Emitter.valueInstruction(context.body, inBounds),
      )
      const continuation = Emitter.block(
        context.body,
        `index${context.state.checkOrdinal}_${runtime}_ok`,
      )
      Emitter.conditionalBranch(
        context.body,
        inBounds,
        continuation,
        NativeTermination.trapBlock(
          context.termination,
          'index out of bounds',
          selector.provenance.span,
        ),
      )
      Emitter.setInsertionPoint(context.body, continuation)
      offset = Emitter.binary(
        context.body,
        'mul',
        index,
        Emitter.integerUnsigned(
          context.builder,
          context.usizeType ?? context.i32,
          BigInt(entry.representation.stride),
        ),
        `${tag}_stride${runtime}`,
      )
      runtime += 1
    }
    base = NativeLanePointer.lanePointer(
      context.lanePointers,
      context.body,
      base,
      offset,
      `${tag}_element`,
    )
    type = entry.representation.element
  }
  return base
}

/** A selected reference field stores an address; reborrowing follows it instead of its slot. */
const referenceAddress = (
  context: Context,
  operation: Extract<Operation, { readonly _tag: 'BeginLoan' }>,
  projected: Value.Input,
) => {
  if (
    operation.reborrow &&
    operation.sourceType._tag === 'Reference' &&
    operation.selectors.length > 0 &&
    !Mir.borrowsDescriptor(operation)
  )
    return Emitter.load(
      context.body,
      context.pointer,
      projected,
      `borrow${operation.destination.ordinal}_reference`,
    )
  return projected
}

export const emit = (context: Context, operation: Operation) => {
  const {
    arith,
    body,
    builder,
    debug,
    entry,
    i32,
    lanePointers,
    pointer,
    program,
    storage: nativeStorage,
    types,
    usizeType,
  } = context
  let trapBlock: LlvmBlock.Block | undefined
  let checkOrdinal = context.state.checkOrdinal
  switch (operation._tag) {
    case 'SetInitialized': {
      const type = entry.fn.localTypes.at(operation.flag.ordinal)
      const lane = type === undefined ? undefined : NativeType.lanesFor(types, type).at(0)
      if (type?._tag !== 'bool' || lane === undefined)
        throw new RangeError('Ownership initialization flag must have a boolean lane')
      const value = Emitter.integerUnsigned(
        builder,
        NativeType.laneType(types, lane),
        operation.initialized ? 1n : 0n,
      )
      const values = [value]
      NativeStorage.writeLocal(nativeStorage, operation.flag.ordinal, values)
      NativeStorage.storeMutable(nativeStorage, operation.flag, values)
      break
    }
    case 'Move': {
      const sourceType = entry.fn.localTypes.at(operation.source.ordinal)
      if (sourceType?._tag === 'Bottom') {
        const destinationType = entry.fn.localTypes.at(operation.destination.ordinal)
        if (destinationType === undefined)
          throw new RangeError('Bottom move lost its destination type')
        const placeholders: Array<Value.Input> = []
        for (const lane of NativeType.lanesFor(types, destinationType)) {
          placeholders.push(Emitter.nullValue(builder, NativeType.laneType(types, lane)))
        }
        NativeStorage.writeLocal(nativeStorage, operation.destination.ordinal, placeholders)
        break
      }
      NativeStorage.copyLocal(nativeStorage, operation.destination, operation.source)
      break
    }
    case 'BeginLoan': {
      const descriptor = Mir.borrowsDescriptor(operation)
      if (!descriptor && operation.sourceType._tag === 'Slice') {
        NativeStorage.writeLocal(
          nativeStorage,
          operation.destination.ordinal,
          NativeStorage.materialize(nativeStorage, operation.root),
        )
        break
      }
      const { address: projected } = NativePlaceAddress.resolve(
        context,
        operation.root,
        operation.selectors,
        `borrow${operation.destination.ordinal}`,
        descriptor,
      )
      if (operation.type._tag === 'Reference') {
        NativeStorage.writeLocal(nativeStorage, operation.destination.ordinal, [
          referenceAddress(context, operation, projected),
        ])
        break
      }
      if (operation.sourceType._tag !== 'FixedArray') {
        throw new RangeError('LLVM slice formation requires an array root')
      }
      NativeStorage.writeLocal(nativeStorage, operation.destination.ordinal, [
        projected,
        Emitter.integerUnsigned(
          builder,
          usizeType ?? i32,
          BigInt(operation.sourceType.type.length),
        ),
      ])
      break
    }
    case 'EndLoan':
      break
    case 'SliceLength': {
      const length = NativeStorage.materialize(nativeStorage, operation.slice).at(1)
      if (length === undefined) throw new RangeError('LLVM slice lost its length lane')
      NativeStorage.writeLocal(nativeStorage, operation.destination.ordinal, [length])
      break
    }
    case 'ConvertUnion': {
      if (operation.conversion === 'Inject') {
        const layout = Layout.entry(program.layout, operation.targetType.type)
        const mapping = operation.mappings.at(0)
        const destination = NativeStorage.readLocal(nativeStorage, operation.destination)
        if (
          layout?.representation._tag !== 'Union' ||
          mapping === undefined ||
          destination._tag !== 'NativePlace'
        )
          throw new RangeError('Union injection lost its planned member place')
        NativeStorage.writeLane(
          nativeStorage,
          operation.destination,
          0,
          Emitter.integerSigned(builder, i32, BigInt(mapping.targetOrdinal)),
        )
        const member = NativePlace.project(
          destination,
          nativeStorage,
          operation.sourceType,
          layout.representation.payloadOffset,
          `union${operation.destination.ordinal}_member`,
          operation.sourceType._tag === 'EffectComposite' ? 'StoredComposite' : 'Value',
        )
        NativeStorage.sendPlace(nativeStorage, member, operation.source)
        break
      }
      const source = NativeStorage.materialize(nativeStorage, operation.source)
      const targetWidth = operation.targetShape.laneCount
      const zero = Emitter.integerSigned(builder, i32, 0n)
      const sourceLanes = operation.sourceShape.lanes
      const targetLanes = operation.targetShape.lanes
      const sourceTag = source.at(0)
      if (sourceTag === undefined) {
        throw new RangeError('LLVM union widening has no source tag')
      }
      let tag: Value.Input = zero
      for (const [ordinal, mapping] of operation.mappings.entries()) {
        const sourceOrdinal = Emitter.integerSigned(builder, i32, BigInt(mapping.sourceOrdinal))
        const matches = Emitter.integerCompare(
          body,
          'eq',
          sourceTag,
          sourceOrdinal,
          `union${operation.destination.ordinal}_${ordinal}_matches`,
        )
        const targetOrdinal = Emitter.integerSigned(builder, i32, BigInt(mapping.targetOrdinal))
        tag = Emitter.select(
          body,
          matches,
          targetOrdinal,
          tag,
          `union${operation.destination.ordinal}_${ordinal}_tag`,
        )
      }
      const payload: Array<Value.Input> = []
      for (let ordinal = 0; ordinal < Math.max(0, targetWidth - 1); ordinal += 1) {
        const targetLane = targetLanes.at(ordinal + 1)
        if (targetLane === undefined) {
          throw new RangeError('LLVM union widening lost a target payload lane')
        }
        const input = source.at(ordinal + 1)
        const sourceLane = sourceLanes.at(ordinal + 1)
        payload.push(
          input === undefined || sourceLane === undefined
            ? Emitter.nullValue(builder, NativeType.laneType(types, targetLane))
            : NativeArith.coerceLane(
                arith.lane,
                input,
                sourceLane,
                targetLane,
                `union${operation.destination.ordinal}_${ordinal}_widen`,
              ),
        )
      }
      NativeStorage.writeLocal(nativeStorage, operation.destination.ordinal, [tag, ...payload])
      break
    }
    case 'Construct': {
      const planned = Layout.entry(program.layout, Mir.semanticType(operation.type))
      if (planned?.representation._tag !== 'Aggregate')
        throw new RangeError('Construction lost its aggregate layout')
      for (const input of operation.fields) {
        const field = planned.representation.fields.find((field) =>
          DeclarationFacts.sameFieldId(field.id, input.field),
        )
        if (field === undefined) throw new RangeError('Construction lost its field layout')
        NativeStorage.constructField(
          nativeStorage,
          operation.destination,
          input.value,
          field.offset,
          input.stored,
        )
      }
      break
    }
    case 'ConstructUnionVariant': {
      const planned = Layout.entry(program.layout, Mir.semanticType(operation.type))
      if (planned?.representation._tag !== 'NominalUnion')
        throw new RangeError('Construction lost its nominal union layout')
      const variant = planned.representation.variants.find(
        (candidate) => candidate.ordinal === operation.variantOrdinal,
      )
      if (variant === undefined) throw new RangeError('Construction lost its selected variant')
      const tag = Emitter.integerSigned(builder, i32, BigInt(operation.variantOrdinal))
      NativeStorage.writeLane(nativeStorage, operation.destination, 0, tag)
      // The constructor already selects the variant. Initialize only its fields instead of
      // round-tripping through ABI carriers and switching over all possible variants again.
      for (const input of operation.fields) {
        const field = variant.fields.find((field) =>
          DeclarationFacts.sameFieldId(field.id, input.field),
        )
        if (field === undefined) throw new RangeError('Construction lost its variant field layout')
        NativeStorage.constructField(
          nativeStorage,
          operation.destination,
          input.value,
          planned.representation.payloadOffset + field.offset,
          input.stored,
        )
      }
      break
    }
    case 'ConstructArray': {
      const planned = Layout.entry(program.layout, Mir.semanticType(operation.type))
      if (planned?.representation._tag !== 'Repeated')
        throw new RangeError('Construction lost its array layout')
      for (const [ordinal, value] of operation.elements.entries())
        NativeStorage.constructField(
          nativeStorage,
          operation.destination,
          value,
          ordinal * planned.representation.stride,
        )
      break
    }
    case 'Project': {
      const sourceType = entry.fn.localTypes.at(operation.source.ordinal)
      if (sourceType === undefined) {
        throw new RangeError('Backend projection lost its source type')
      }
      const planned = Layout.entry(program.layout, Mir.semanticType(sourceType))
      if (planned?.representation._tag !== 'Aggregate')
        throw new RangeError('Projection lost its aggregate layout')
      const field = planned.representation.fields.find((field) =>
        DeclarationFacts.sameFieldId(field.id, operation.field),
      )
      if (field === undefined) throw new RangeError('Projection lost its field layout')
      NativeStorage.projectLocal(
        nativeStorage,
        operation.destination,
        operation.source,
        field.offset,
      )
      break
    }
    case 'ReadPlace': {
      const sourceType = entry.fn.localTypes.at(operation.root.ordinal)
      if (sourceType === undefined) {
        throw new RangeError('Backend place read lost its root type')
      }
      const sourceSemantic = Mir.semanticType(sourceType)
      if (sourceType._tag === 'Slice' && operation.selectors.length === 0) {
        NativeStorage.copyLocal(nativeStorage, operation.destination, operation.root)
        break
      }
      if (
        !SilkType.isReference(sourceSemantic) &&
        !SilkType.isSlice(sourceSemantic) &&
        NativeStorage.readLocal(nativeStorage, operation.root)._tag === 'NativePlace' &&
        operation.selectors.some(
          (selector) => selector._tag === 'ElementSelector' && selector.index._tag === 'Runtime',
        ) &&
        operation.selectors.every(
          (selector) => selector._tag === 'FieldSelector' || selector._tag === 'ElementSelector',
        )
      ) {
        const base = ownedAddress(
          context,
          operation.root,
          operation.selectors,
          `owned_read${operation.destination.ordinal}`,
        )
        NativeStorage.receivePlace(
          nativeStorage,
          operation.destination,
          NativePlace.make(program.layout, operation.type, base),
        )
        checkOrdinal += 1
        break
      }
      if (
        !SilkType.isReference(sourceSemantic) &&
        !SilkType.isSlice(sourceSemantic) &&
        operation.selectors.every(
          (selector) =>
            selector._tag === 'FieldSelector' ||
            selector._tag === 'VariantSelector' ||
            (selector._tag === 'ElementSelector' && selector.index._tag === 'Proven'),
        )
      ) {
        if (!operation.selectors.some((selector) => selector._tag === 'VariantSelector')) {
          if (operation.selectors.length === 0) {
            NativeStorage.copyLocal(nativeStorage, operation.destination, operation.root)
            break
          }
          const path: Array<Layout.Selector> = []
          for (const selector of operation.selectors) {
            if (selector._tag === 'FieldSelector') path.push(selector.field)
            else if (selector._tag === 'ElementSelector' && selector.index._tag === 'Proven')
              path.push({ _tag: 'ElementSelector', index: selector.index.value })
          }
          const offset = LayoutVerify.laneOffset(program.layout, sourceSemantic, path)
          if (offset === undefined)
            throw new RangeError('Owned projection lost its canonical offset')
          NativeStorage.projectLocal(nativeStorage, operation.destination, operation.root, offset)
          break
        }
        const place = NativeOwnedPlace.make(program.layout, sourceSemantic, operation.selectors)
        if (place === undefined) throw new RangeError('Owned read lost its verified projection')
        const selected = NativeOwnedPlace.read(
          place,
          arith.lane,
          (ordinal) => NativeStorage.readLane(nativeStorage, operation.root, ordinal),
          `owned_read${operation.destination.ordinal}`,
        )
        NativeStorage.writeLocal(nativeStorage, operation.destination.ordinal, selected)
        break
      }
      if (SilkType.isReference(sourceSemantic)) {
        // Resolve the selected value to one checked address, then load each calling lane.
        const address = NativeStorage.materialize(nativeStorage, operation.root).at(0)
        if (address === undefined) throw new RangeError('LLVM reference read lost its address')
        const base = Emitter.cast(
          body,
          'inttoptr',
          address,
          pointer,
          `reference_read${operation.destination.ordinal}_base`,
        )
        let selected: SilkType.Type = sourceSemantic.target
        let staticOffset = 0
        let dynamicOffset: Value.Input | undefined
        let runtimeOrdinal = 0
        for (const selector of operation.selectors) {
          const selectedLayout = Layout.entry(program.layout, selected)
          if (selector._tag === 'FieldSelector') {
            if (selectedLayout?.representation._tag !== 'Aggregate')
              throw new RangeError('LLVM reference read field lost its aggregate layout')
            const field = selectedLayout.representation.fields.find((candidate) =>
              DeclarationFacts.sameFieldId(candidate.id, selector.field),
            )
            if (field === undefined)
              throw new RangeError('LLVM reference read lost its field layout')
            staticOffset += field.offset
            selected = field.type
            continue
          }
          if (
            selector._tag !== 'ElementSelector' ||
            selectedLayout?.representation._tag !== 'Repeated'
          )
            throw new RangeError('LLVM reference read element lost its repeated layout')
          if (selector.index._tag === 'Proven') {
            staticOffset += selector.index.value * selectedLayout.representation.stride
          } else {
            const index = NativeStorage.readScalar(nativeStorage, selector.index.local)
            const length = Emitter.integerUnsigned(
              builder,
              usizeType ?? i32,
              BigInt(selector.length),
            )
            trapBlock = NativeTermination.trapBlock(
              context.termination,
              'index out of bounds',
              selector.provenance.span,
            )
            const inBounds = Emitter.integerCompare(
              body,
              'ult',
              index,
              length,
              `reference_read${checkOrdinal}_${runtimeOrdinal}_in_bounds`,
            )
            NativeDebug.locate(
              debug,
              selector.provenance.span,
              Emitter.valueInstruction(body, inBounds),
            )
            const continuation = Emitter.block(
              body,
              `reference_read${checkOrdinal}_${runtimeOrdinal}_ok`,
            )
            Emitter.conditionalBranch(body, inBounds, continuation, trapBlock)
            Emitter.setInsertionPoint(body, continuation)
            const scaled = Emitter.binary(
              body,
              'mul',
              index,
              Emitter.integerUnsigned(
                builder,
                usizeType ?? i32,
                BigInt(selectedLayout.representation.stride),
              ),
              `reference_read${operation.destination.ordinal}_${runtimeOrdinal}_scaled`,
            )
            dynamicOffset =
              dynamicOffset === undefined
                ? scaled
                : Emitter.binary(
                    body,
                    'add',
                    dynamicOffset,
                    scaled,
                    `reference_read${operation.destination.ordinal}_${runtimeOrdinal}_offset`,
                  )
            runtimeOrdinal += 1
          }
          selected = selectedLayout.representation.element
        }
        if (staticOffset !== 0) {
          const constant = Emitter.integerUnsigned(builder, usizeType ?? i32, BigInt(staticOffset))
          dynamicOffset =
            dynamicOffset === undefined
              ? constant
              : Emitter.binary(
                  body,
                  'add',
                  dynamicOffset,
                  constant,
                  `reference_read${operation.destination.ordinal}_static_offset`,
                )
        }
        const projected =
          dynamicOffset === undefined
            ? base
            : NativeLanePointer.lanePointer(
                lanePointers,
                body,
                base,
                dynamicOffset,
                `reference_read${operation.destination.ordinal}_projected`,
              )
        NativeStorage.receivePlace(
          nativeStorage,
          operation.destination,
          NativePlace.make(
            program.layout,
            operation.type,
            projected,
            operation.type._tag === 'EffectComposite' ? 'StoredComposite' : 'Value',
          ),
        )
        if (runtimeOrdinal > 0) checkOrdinal += 1
        break
      }
      if (SilkType.isSlice(sourceSemantic)) {
        const [selector, ...suffixSelectors] = operation.selectors
        if (selector?._tag !== 'SliceElementSelector') {
          throw new RangeError('LLVM slice read lost its runtime element selector')
        }
        const [base, length] = NativeStorage.materialize(nativeStorage, operation.root)
        if (base === undefined || length === undefined) {
          throw new RangeError('LLVM slice read lost its address or length lane')
        }
        trapBlock = NativeTermination.trapBlock(
          context.termination,
          'index out of bounds',
          selector.provenance.span,
        )
        const index = NativeStorage.readScalar(nativeStorage, selector.index)
        const inBounds = Emitter.integerCompare(
          body,
          'ult',
          index,
          length,
          `slice${checkOrdinal}_in_bounds`,
        )
        NativeDebug.locate(
          debug,
          selector.provenance.span,
          Emitter.valueInstruction(body, inBounds),
        )
        const continueBlock = Emitter.block(body, `slice${checkOrdinal}_ok`)
        Emitter.conditionalBranch(body, inBounds, continueBlock, trapBlock)
        Emitter.setInsertionPoint(body, continueBlock)
        const sliceLayout = Layout.entry(program.layout, sourceSemantic)
        if (sliceLayout?.representation._tag !== 'Slice') {
          throw new RangeError('LLVM slice read lost its compiler layout')
        }
        const stride = Emitter.integerUnsigned(
          builder,
          usizeType ?? i32,
          BigInt(sliceLayout.representation.stride),
        )
        const elementOffset = Emitter.binary(
          body,
          'mul',
          index,
          stride,
          `slice${checkOrdinal}_element_offset`,
        )
        const staticSelectors: Array<Layout.Selector> = []
        for (const candidate of suffixSelectors) {
          if (candidate._tag === 'FieldSelector') {
            staticSelectors.push(candidate.field)
          } else if (candidate._tag === 'ElementSelector' && candidate.index._tag === 'Proven') {
            staticSelectors.push({
              _tag: 'ElementSelector',
              index: candidate.index.value,
            })
          } else {
            throw new RangeError('LLVM nested runtime slice place is not canonical')
          }
        }
        const staticOffset = LayoutVerify.laneOffset(
          program.layout,
          sourceSemantic.element,
          staticSelectors,
        )
        if (staticOffset === undefined)
          throw new RangeError('Slice projection lost its stored offset')
        const element = NativeLanePointer.lanePointer(
          lanePointers,
          body,
          base,
          elementOffset,
          `slice${checkOrdinal}_element`,
        )
        const selected = NativeLanePointer.lanePointer(
          lanePointers,
          body,
          element,
          staticOffset,
          `slice${checkOrdinal}_selected`,
        )
        NativeStorage.receivePlace(
          nativeStorage,
          operation.destination,
          NativePlace.make(
            program.layout,
            operation.type,
            selected,
            operation.type._tag === 'EffectComposite' ? 'StoredComposite' : 'Value',
          ),
        )
        checkOrdinal += 1
        break
      }
      const runtimeSelectors = operation.selectors.flatMap((selector, ordinal) =>
        selector._tag === 'ElementSelector' && selector.index._tag === 'Runtime'
          ? [
              {
                local: selector.index.local,
                length: selector.length,
                span: selector.provenance.span,
                ordinal,
              },
            ]
          : [],
      )
      for (const [runtimeOrdinal, selector] of runtimeSelectors.entries()) {
        trapBlock = NativeTermination.trapBlock(
          context.termination,
          'index out of bounds',
          selector.span,
        )
        const limit = Emitter.integerUnsigned(builder, usizeType ?? i32, BigInt(selector.length))
        const inBounds = Emitter.integerCompare(
          body,
          'ult',
          NativeStorage.readScalar(nativeStorage, selector.local),
          limit,
          `index${checkOrdinal}_${runtimeOrdinal}_in_bounds`,
        )
        const instruction = Emitter.valueInstruction(body, inBounds)
        NativeDebug.locate(debug, selector.span, instruction)
        const continueBlock = Emitter.block(body, `index${checkOrdinal}_${runtimeOrdinal}_ok`)
        Emitter.conditionalBranch(body, inBounds, continueBlock, trapBlock)
        Emitter.setInsertionPoint(body, continueBlock)
      }

      const candidates = NativeOwnedPlace.candidates(
        program.layout,
        sourceSemantic,
        operation.selectors,
      )
      let selectedValues: ReadonlyArray<Value.Input> | undefined
      for (const [ordinal, candidate] of candidates.entries()) {
        const values = NativeOwnedPlace.read(
          candidate.place,
          arith.lane,
          (slot) => NativeStorage.readLane(nativeStorage, operation.root, slot),
          `read${checkOrdinal}_${ordinal}`,
        )
        const condition = candidateCondition(
          context,
          candidate.indices,
          `read${checkOrdinal}_${ordinal}`,
        )
        if (selectedValues === undefined || condition === undefined) selectedValues = values
        else {
          const selected: Array<Value.Input> = []
          for (const [lane, value] of values.entries()) {
            const previous = selectedValues.at(lane)
            if (previous === undefined)
              throw new RangeError('Owned read candidates disagree on lane count')
            selected.push(
              Emitter.select(
                body,
                condition,
                value,
                previous,
                `read${checkOrdinal}_${ordinal}_${lane}`,
              ),
            )
          }
          selectedValues = selected
        }
      }
      if (selectedValues === undefined) {
        // Zero-length arrays have already branched to the bounds trap. Keep the unreachable
        // continuation well typed without reading any source lane.
        const empty: Array<Value.Input> = []
        for (const lane of NativeType.lanesFor(types, operation.type))
          empty.push(Emitter.nullValue(builder, NativeType.laneType(types, lane)))
        selectedValues = empty
      }
      checkOrdinal += 1
      NativeStorage.writeLocal(nativeStorage, operation.destination.ordinal, selectedValues)
      break
    }
    case 'CheckPlace': {
      const rootType = entry.fn.localTypes.at(operation.root.ordinal)
      // Rebinding the descriptor selects no element and therefore has no bounds check.
      if (rootType?._tag === 'Slice' && operation.selectors.length === 0) break
      if (rootType?._tag === 'Slice') {
        const selector = operation.selectors.at(0)
        const length = NativeStorage.materialize(nativeStorage, operation.root).at(1)
        if (selector?._tag !== 'SliceElementSelector' || length === undefined) {
          throw new RangeError('LLVM slice write check lost its canonical lanes')
        }
        trapBlock = NativeTermination.trapBlock(
          context.termination,
          'index out of bounds',
          selector.provenance.span,
        )
        const inBounds = Emitter.integerCompare(
          body,
          'ult',
          NativeStorage.readScalar(nativeStorage, selector.index),
          length,
          `write_slice${checkOrdinal}_in_bounds`,
        )
        NativeDebug.locate(
          debug,
          selector.provenance.span,
          Emitter.valueInstruction(body, inBounds),
        )
        const continueBlock = Emitter.block(body, `write_slice${checkOrdinal}_ok`)
        Emitter.conditionalBranch(body, inBounds, continueBlock, trapBlock)
        Emitter.setInsertionPoint(body, continueBlock)
        checkOrdinal += 1
        break
      }
      const runtimeSelectors = operation.selectors.flatMap((selector, ordinal) =>
        selector._tag === 'ElementSelector' && selector.index._tag === 'Runtime'
          ? [
              {
                local: selector.index.local,
                length: selector.length,
                span: selector.provenance.span,
                ordinal,
              },
            ]
          : [],
      )
      for (const [runtimeOrdinal, selector] of runtimeSelectors.entries()) {
        trapBlock = NativeTermination.trapBlock(
          context.termination,
          'index out of bounds',
          selector.span,
        )
        const limit = Emitter.integerUnsigned(builder, usizeType ?? i32, BigInt(selector.length))
        const inBounds = Emitter.integerCompare(
          body,
          'ult',
          NativeStorage.readScalar(nativeStorage, selector.local),
          limit,
          `write_index${checkOrdinal}_${runtimeOrdinal}_in_bounds`,
        )
        const instruction = Emitter.valueInstruction(body, inBounds)
        NativeDebug.locate(debug, selector.span, instruction)
        const continueBlock = Emitter.block(body, `write_index${checkOrdinal}_${runtimeOrdinal}_ok`)
        Emitter.conditionalBranch(body, inBounds, continueBlock, trapBlock)
        Emitter.setInsertionPoint(body, continueBlock)
      }
      checkOrdinal += 1
      break
    }
    case 'WritePlace': {
      if (operation.rootType._tag === 'Slice' && operation.selectors.length === 0) {
        NativeStorage.copyLocal(nativeStorage, operation.root, operation.source)
        NativeStorage.commitLocal(nativeStorage, operation.root)
        break
      }
      if (
        operation.rootType._tag !== 'Reference' &&
        operation.rootType._tag !== 'Slice' &&
        NativeStorage.readLocal(nativeStorage, operation.root)._tag === 'NativePlace' &&
        operation.selectors.every(
          (selector) => selector._tag === 'FieldSelector' || selector._tag === 'ElementSelector',
        )
      ) {
        const base = ownedAddress(
          context,
          operation.root,
          operation.selectors,
          `owned_write${operation.source.ordinal}`,
        )
        NativeStorage.sendPlace(
          nativeStorage,
          NativePlace.make(
            program.layout,
            operation.type,
            base,
            operation.type._tag === 'EffectComposite' ? 'StoredComposite' : 'Value',
          ),
          operation.source,
        )
        checkOrdinal += 1
        break
      }
      if (operation.rootType._tag === 'Reference') {
        if (operation.rootType.type.access !== 'Exclusive')
          throw new RangeError('LLVM reference write requires exclusive access')
        // Resolve the selected value address once, then store each calling lane.
        const address = NativeStorage.materialize(nativeStorage, operation.root).at(0)
        if (address === undefined) throw new RangeError('LLVM reference write lost its address')
        const base = Emitter.cast(
          body,
          'inttoptr',
          address,
          pointer,
          `reference_write${operation.source.ordinal}_base`,
        )
        let selected: SilkType.Type = operation.rootType.type.target
        let staticOffset = 0
        let dynamicOffset: Value.Input | undefined
        let runtimeOrdinal = 0
        for (const selector of operation.selectors) {
          const selectedLayout = Layout.entry(program.layout, selected)
          if (selector._tag === 'FieldSelector') {
            if (selectedLayout?.representation._tag !== 'Aggregate')
              throw new RangeError('LLVM reference write field lost its aggregate layout')
            const field = selectedLayout.representation.fields.find((candidate) =>
              DeclarationFacts.sameFieldId(candidate.id, selector.field),
            )
            if (field === undefined)
              throw new RangeError('LLVM reference write lost its field layout')
            staticOffset += field.offset
            selected = field.type
            continue
          }
          if (
            selector._tag !== 'ElementSelector' ||
            selectedLayout?.representation._tag !== 'Repeated'
          )
            throw new RangeError('LLVM reference write element lost its repeated layout')
          if (selector.index._tag === 'Proven') {
            staticOffset += selector.index.value * selectedLayout.representation.stride
          } else {
            const scaled = Emitter.binary(
              body,
              'mul',
              NativeStorage.readScalar(nativeStorage, selector.index.local),
              Emitter.integerUnsigned(
                builder,
                usizeType ?? i32,
                BigInt(selectedLayout.representation.stride),
              ),
              `reference_write${operation.source.ordinal}_${runtimeOrdinal}_scaled`,
            )
            dynamicOffset =
              dynamicOffset === undefined
                ? scaled
                : Emitter.binary(
                    body,
                    'add',
                    dynamicOffset,
                    scaled,
                    `reference_write${operation.source.ordinal}_${runtimeOrdinal}_offset`,
                  )
            runtimeOrdinal += 1
          }
          selected = selectedLayout.representation.element
        }
        if (staticOffset !== 0) {
          const constant = Emitter.integerUnsigned(builder, usizeType ?? i32, BigInt(staticOffset))
          dynamicOffset =
            dynamicOffset === undefined
              ? constant
              : Emitter.binary(
                  body,
                  'add',
                  dynamicOffset,
                  constant,
                  `reference_write${operation.source.ordinal}_static_offset`,
                )
        }
        const projected =
          dynamicOffset === undefined
            ? base
            : NativeLanePointer.lanePointer(
                lanePointers,
                body,
                base,
                dynamicOffset,
                `reference_write${operation.source.ordinal}_projected`,
              )
        NativeStorage.sendPlace(
          nativeStorage,
          NativePlace.make(
            program.layout,
            operation.type,
            projected,
            operation.type._tag === 'EffectComposite' ? 'StoredComposite' : 'Value',
          ),
          operation.source,
        )
        NativeStorage.reloadAddressRoots(nativeStorage)
        break
      }
      if (operation.rootType._tag === 'Slice') {
        const [selector, ...suffixSelectors] = operation.selectors
        const [base] = NativeStorage.materialize(nativeStorage, operation.root)
        if (selector?._tag !== 'SliceElementSelector' || base === undefined) {
          throw new RangeError('LLVM slice write lost its canonical address lane')
        }
        const sliceLayout = Layout.entry(program.layout, operation.rootType.type)
        if (sliceLayout?.representation._tag !== 'Slice') {
          throw new RangeError('LLVM slice write lost its compiler layout')
        }
        const stride = Emitter.integerUnsigned(
          builder,
          usizeType ?? i32,
          BigInt(sliceLayout.representation.stride),
        )
        const elementOffset = Emitter.binary(
          body,
          'mul',
          NativeStorage.readScalar(nativeStorage, selector.index),
          stride,
          `write_slice${checkOrdinal}_element_offset`,
        )
        const staticSelectors: Array<Layout.Selector> = []
        for (const candidate of suffixSelectors) {
          if (candidate._tag === 'FieldSelector') {
            staticSelectors.push(candidate.field)
          } else if (candidate._tag === 'ElementSelector' && candidate.index._tag === 'Proven') {
            staticSelectors.push({
              _tag: 'ElementSelector',
              index: candidate.index.value,
            })
          } else {
            throw new RangeError('LLVM nested runtime slice write is not canonical')
          }
        }
        const staticOffset = LayoutVerify.laneOffset(
          program.layout,
          operation.rootType.type.element,
          staticSelectors,
        )
        if (staticOffset === undefined)
          throw new RangeError('Slice projection lost its stored offset')
        const element = NativeLanePointer.lanePointer(
          lanePointers,
          body,
          base,
          elementOffset,
          `write_slice${checkOrdinal}_element`,
        )
        const selected = NativeLanePointer.lanePointer(
          lanePointers,
          body,
          element,
          staticOffset,
          `write_slice${checkOrdinal}_selected`,
        )
        NativeStorage.sendPlace(
          nativeStorage,
          NativePlace.make(
            program.layout,
            operation.type,
            selected,
            operation.type._tag === 'EffectComposite' ? 'StoredComposite' : 'Value',
          ),
          operation.source,
        )
        checkOrdinal += 1
        NativeStorage.reloadAddressRoots(nativeStorage)
        break
      }
      const candidates = NativeOwnedPlace.candidates(
        program.layout,
        Mir.semanticType(operation.rootType),
        operation.selectors,
      )
      for (const [ordinal, candidate] of candidates.entries()) {
        const condition = candidateCondition(
          context,
          candidate.indices,
          `write${checkOrdinal}_${ordinal}`,
        )
        let done: LlvmBlock.Block | undefined
        if (condition !== undefined) {
          const selected = Emitter.block(body, `write${checkOrdinal}_${ordinal}_selected`)
          done = Emitter.block(body, `write${checkOrdinal}_${ordinal}_done`)
          Emitter.conditionalBranch(body, condition, selected, done)
          Emitter.setInsertionPoint(body, selected)
        }
        NativeOwnedPlace.write(
          candidate.place,
          arith.lane,
          (slot) => NativeStorage.readLane(nativeStorage, operation.source, slot),
          (slot, value) => NativeStorage.writeLane(nativeStorage, operation.root, slot, value),
          `write${checkOrdinal}_${ordinal}`,
        )
        if (done !== undefined) {
          Emitter.branch(body, done)
          Emitter.setInsertionPoint(body, done)
        }
      }
      checkOrdinal += 1
      break
    }
  }
  context.state.checkOrdinal = checkOrdinal
}
