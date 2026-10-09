import * as Effect from 'effect/Effect'
import * as CLayout from './CLayout.js'
import * as DeclarationFacts from './DeclarationFacts.js'
import type * as DeclarationIndex from './DeclarationIndex.js'
import * as Diagnostic from './Diagnostic.js'
import * as FieldRealization from './FieldRealization.js'
import { alignUp } from './internal/Align.js'
import * as Packing from './internal/Packing.js'
import type {
  CallingScalar,
  Catalog,
  CatalogEntry,
  Entry,
  Plan,
  Representation,
  Selector,
  Violation,
} from './Layout.js'
import {
  callingShape,
  planCallingShapes,
  catalogEntry,
  entry,
  foreignFunctionEntry,
  neverEntry,
  pointerEntry,
  referenceEntry,
  scalarEntry,
  sliceEntry,
  stringEntry,
  unionEntry,
  wordRange,
} from './Layout.js'
import * as Scalar from './Scalar.js'
import * as Target from './Target.js'
import * as Type from './Type.js'
import * as ValueStorage from './ValueStorage.js'

const cleanupHooksEqual = (
  leftHook: Extract<Representation, { readonly _tag: 'Aggregate' }>['cleanupHook'],
  rightHook: Extract<Representation, { readonly _tag: 'Aggregate' }>['cleanupHook'],
): boolean =>
  leftHook === undefined
    ? rightHook === undefined
    : rightHook !== undefined &&
      leftHook.hook.module === rightHook.hook.module &&
      leftHook.hook.name === rightHook.hook.name &&
      leftHook.typeArguments.length === rightHook.typeArguments.length &&
      leftHook.typeArguments.every((argument, ordinal) => {
        const other = rightHook.typeArguments.at(ordinal)
        return other !== undefined && Type.equalsGenericArgument(argument, other)
      })

const representationEquals = (left: Representation, right: Representation): boolean => {
  if (left._tag !== right._tag) return false
  if (left._tag === 'SignedInteger')
    return right._tag === 'SignedInteger' && left.bits === right.bits
  if (left._tag === 'UnsignedInteger')
    return right._tag === 'UnsignedInteger' && left.bits === right.bits
  if (left._tag === 'ScalarEnum')
    return (
      right._tag === 'ScalarEnum' &&
      left.enum.module === right.enum.module &&
      left.enum.name === right.enum.name &&
      left.scalar === right.scalar &&
      left.bits === right.bits &&
      left.signedness === right.signedness &&
      left.members.length === right.members.length &&
      left.members.every((member, ordinal) => {
        const other = right.members.at(ordinal)
        return (
          other !== undefined &&
          member.member.enum.module === other.member.enum.module &&
          member.member.enum.name === other.member.enum.name &&
          member.member.name === other.member.name &&
          member.discriminant === other.discriminant
        )
      })
    )
  if (left._tag === 'Floating')
    return right._tag === 'Floating' && left.bits === right.bits && right.ieee
  if (left._tag === 'Boolean') {
    return (
      right._tag === 'Boolean' &&
      left.bits === right.bits &&
      left.falseValue === right.falseValue &&
      left.trueValue === right.trueValue
    )
  }
  if (left._tag === 'CallableEnvironment') {
    return (
      right._tag === 'CallableEnvironment' &&
      FieldRealization.equals(left.realization, right.realization) &&
      left.tailPadding === right.tailPadding &&
      left.fields.length === right.fields.length &&
      left.fields.every((field, ordinal) => {
        const other = right.fields.at(ordinal)
        return (
          other !== undefined &&
          field.ordinal === other.ordinal &&
          field.parameterOrdinal === other.parameterOrdinal &&
          field.access === other.access &&
          Type.equals(field.type, other.type) &&
          field.offset === other.offset &&
          field.size === other.size &&
          field.alignment === other.alignment &&
          field.padding === other.padding &&
          field.representation === other.representation
        )
      })
    )
  }
  if (left._tag === 'StoredEffectEnvironment') {
    return (
      right._tag === 'StoredEffectEnvironment' &&
      FieldRealization.equals(left.realization, right.realization) &&
      left.tailPadding === right.tailPadding &&
      left.fields.length === right.fields.length &&
      left.fields.every((field, ordinal) => {
        const other = right.fields.at(ordinal)
        return (
          other !== undefined &&
          field.capture === other.capture &&
          field.source === other.source &&
          field.ordinal === other.ordinal &&
          field.access === other.access &&
          Type.equals(field.type, other.type) &&
          field.offset === other.offset &&
          field.size === other.size &&
          field.alignment === other.alignment &&
          field.padding === other.padding &&
          field.representation === other.representation &&
          field.effectIdentity === other.effectIdentity &&
          ((field.callableIdentity === undefined && other.callableIdentity === undefined) ||
            (field.callableIdentity !== undefined &&
              other.callableIdentity !== undefined &&
              Type.equalsGenericArgument(field.callableIdentity, other.callableIdentity)))
        )
      })
    )
  }
  if (left._tag === 'Repeated') {
    return (
      right._tag === 'Repeated' &&
      Type.equals(left.element, right.element) &&
      left.length === right.length &&
      left.stride === right.stride
    )
  }
  if (left._tag === 'Slice') {
    return (
      right._tag === 'Slice' &&
      Type.equals(left.element, right.element) &&
      left.address.bits === right.address.bits &&
      left.address.offset === right.address.offset &&
      left.address.size === right.address.size &&
      left.address.alignment === right.address.alignment &&
      left.length.offset === right.length.offset &&
      left.addressPadding === right.addressPadding &&
      left.tailPadding === right.tailPadding &&
      left.stride === right.stride
    )
  }
  if (left._tag === 'String') {
    return (
      right._tag === 'String' &&
      left.storage.provenance === right.storage.provenance &&
      left.storage.bits === right.storage.bits &&
      left.storage.offset === right.storage.offset &&
      left.storage.size === right.storage.size &&
      left.storage.alignment === right.storage.alignment &&
      left.byteLength.type === right.byteLength.type &&
      left.byteLength.offset === right.byteLength.offset &&
      left.byteLength.size === right.byteLength.size &&
      left.storagePadding === right.storagePadding &&
      left.tailPadding === right.tailPadding
    )
  }
  if (left._tag === 'Reference') {
    return (
      right._tag === 'Reference' &&
      Type.equals(left.target, right.target) &&
      left.address.bits === right.address.bits &&
      left.address.offset === right.address.offset &&
      left.address.size === right.address.size &&
      left.address.alignment === right.address.alignment
    )
  }
  if (left._tag === 'Union') {
    return (
      right._tag === 'Union' &&
      left.payloadOffset === right.payloadOffset &&
      left.payloadSize === right.payloadSize &&
      left.payloadAlignment === right.payloadAlignment &&
      left.tagPadding === right.tagPadding &&
      left.tailPadding === right.tailPadding &&
      left.members.length === right.members.length &&
      left.members.every((member, ordinal) => {
        const other = right.members.at(ordinal)
        return (
          other !== undefined &&
          Type.equals(member.type, other.type) &&
          member.ordinal === other.ordinal &&
          member.size === other.size &&
          member.alignment === other.alignment
        )
      })
    )
  }
  if (left._tag === 'NominalUnion') {
    return (
      right._tag === 'NominalUnion' &&
      left.union.module === right.union.module &&
      left.union.name === right.union.name &&
      left.payloadOffset === right.payloadOffset &&
      left.payloadSize === right.payloadSize &&
      left.payloadAlignment === right.payloadAlignment &&
      left.tagPadding === right.tagPadding &&
      left.tailPadding === right.tailPadding &&
      cleanupHooksEqual(left.cleanupHook, right.cleanupHook) &&
      left.variants.length === right.variants.length &&
      left.variants.every((variant, ordinal) => {
        const other = right.variants.at(ordinal)
        return (
          other !== undefined &&
          variant.variant.union.module === other.variant.union.module &&
          variant.variant.union.name === other.variant.union.name &&
          variant.variant.name === other.variant.name &&
          variant.ordinal === other.ordinal &&
          variant.size === other.size &&
          variant.alignment === other.alignment &&
          variant.tailPadding === other.tailPadding &&
          variant.fields.length === other.fields.length &&
          variant.fields.every((field, fieldOrdinal) => {
            const otherField = other.fields.at(fieldOrdinal)
            return (
              otherField !== undefined &&
              DeclarationFacts.sameFieldId(field.id, otherField.id) &&
              field.name === otherField.name &&
              Type.equals(field.type, otherField.type) &&
              field.offset === otherField.offset &&
              field.size === otherField.size &&
              field.alignment === otherField.alignment &&
              field.padding === otherField.padding
            )
          })
        )
      })
    )
  }
  return (
    right._tag === 'Aggregate' &&
    cleanupHooksEqual(left.cleanupHook, right.cleanupHook) &&
    left.tailPadding === right.tailPadding &&
    left.fields.length === right.fields.length &&
    left.fields.every((field, index) => {
      const other = right.fields[index]
      return (
        other !== undefined &&
        field.id.ordinal === other.id.ordinal &&
        field.name === other.name &&
        Type.equals(field.type, other.type) &&
        field.offset === other.offset &&
        field.size === other.size &&
        field.alignment === other.alignment &&
        field.padding === other.padding
      )
    })
  )
}

const executablePlanEquals = (left: Entry['executable'], right: Entry['executable']): boolean =>
  left === undefined
    ? right === undefined
    : right !== undefined &&
      left._tag === right._tag &&
      left.fields.length === right.fields.length &&
      left.fields.every((field, ordinal) => {
        const other = right.fields.at(ordinal)
        return (
          other !== undefined &&
          field.capture === other.capture &&
          Type.equals(field.type, other.type) &&
          field.access === other.access &&
          field.representation === other.representation &&
          field.offset === other.offset &&
          field.size === other.size &&
          field.alignment === other.alignment &&
          field.padding === other.padding &&
          field.effectIdentity === other.effectIdentity &&
          (field.callableIdentity === undefined
            ? other.callableIdentity === undefined
            : other.callableIdentity !== undefined &&
              Type.equalsGenericArgument(field.callableIdentity, other.callableIdentity))
        )
      })

const invalid = (
  rule: Violation['rule'],
  type: DeclarationFacts.SemanticType,
  detail: string,
): Violation => ({ _tag: 'LayoutViolation', rule, type, detail })

const verifyEntry = (
  target: Target.Target,
  candidate: Entry,
  available: ReadonlyMap<string, Entry>,
): ReadonlyArray<Violation> => {
  if (Type.isBuiltin(candidate.type)) {
    const expected = scalarEntry(target, candidate.type)
    return candidate.size === expected.size &&
      candidate.alignment === expected.alignment &&
      representationEquals(candidate.representation, expected.representation)
      ? []
      : [
          invalid(
            'InvalidScalar',
            candidate.type,
            `${Type.encode(candidate.type)} does not match the canonical scalar layout`,
          ),
        ]
  }
  if (Type.isNominal(candidate.type) && candidate.representation._tag === 'ScalarEnum') {
    const representation = candidate.representation
    const scalar = Scalar.enumRepresentation(representation.scalar)
    const canonical = scalar === undefined ? undefined : Scalar.resolveLayout(scalar, target)
    const range =
      scalar === undefined ? undefined : Scalar.range(scalar, target.pointerSize === 4 ? 32 : 64)
    const metadataValid =
      Object.keys(representation).sort().join(',') === '_tag,bits,enum,members,scalar,signedness' &&
      representation.members.every(
        (member) => Object.keys(member).sort().join(',') === 'discriminant,member',
      )
    const membersValid =
      representation.members.length > 0 &&
      new Set(representation.members.map((member) => member.member.name)).size ===
        representation.members.length &&
      new Set(representation.members.map((member) => member.discriminant.toString())).size ===
        representation.members.length &&
      representation.members.every(
        (member) =>
          member.member.enum.module === representation.enum.module &&
          member.member.enum.name === representation.enum.name &&
          range !== undefined &&
          member.discriminant >= range.minimum &&
          member.discriminant <= range.maximum,
      )
    return candidate.type.module === representation.enum.module &&
      candidate.type.name === representation.enum.name &&
      candidate.type.arguments.length === 0 &&
      scalar?.category === 'Integer' &&
      scalar.width._tag === 'FixedWidth' &&
      representation.bits === scalar.width.bits &&
      representation.signedness === scalar.signedness &&
      canonical !== undefined &&
      candidate.copy &&
      candidate.size === canonical.size &&
      candidate.alignment === canonical.alignment &&
      candidate.executable === undefined &&
      metadataValid &&
      membersValid
      ? []
      : [
          invalid(
            'InvalidScalar',
            candidate.type,
            `${Type.encode(candidate.type)} does not match its canonical scalar-enum layout`,
          ),
        ]
  }
  if (Type.isFixedArray(candidate.type)) {
    const element = Type.isBuiltin(candidate.type.element)
      ? scalarEntry(target, candidate.type.element)
      : available.get(Type.runtimeKey(candidate.type.element))
    if (element === undefined || candidate.representation._tag !== 'Repeated') {
      return [
        invalid(
          'InvalidAggregate',
          candidate.type,
          `${Type.encode(candidate.type)} has no repeated-element representation`,
        ),
      ]
    }
    const stride = alignUp(element.size, element.alignment)
    const size = stride * candidate.type.length
    return candidate.representation.length === candidate.type.length &&
      Type.equals(candidate.representation.element, candidate.type.element) &&
      candidate.representation.stride === stride &&
      candidate.size === size &&
      candidate.alignment === element.alignment
      ? []
      : [
          invalid(
            'InvalidAggregate',
            candidate.type,
            `${Type.encode(candidate.type)} has non-canonical repeated layout facts`,
          ),
        ]
  }
  if (Type.isString(candidate.type)) {
    const expected = stringEntry(target, candidate.type)
    return candidate.size === expected.size &&
      candidate.alignment === expected.alignment &&
      representationEquals(candidate.representation, expected.representation)
      ? []
      : [
          invalid(
            'InvalidAggregate',
            candidate.type,
            'string does not match the canonical UTF-8 storage-provenance layout',
          ),
        ]
  }
  if (Type.isSlice(candidate.type)) {
    const element = Type.isBuiltin(candidate.type.element)
      ? scalarEntry(target, candidate.type.element)
      : available.get(Type.runtimeKey(candidate.type.element))
    if (element === undefined) {
      return [
        invalid(
          'InvalidAggregate',
          candidate.type,
          `${Type.encode(candidate.type)} has no element layout`,
        ),
      ]
    }
    const expected = sliceEntry(target, candidate.type, element)
    return candidate.size === expected.size &&
      candidate.alignment === expected.alignment &&
      representationEquals(candidate.representation, expected.representation)
      ? []
      : [
          invalid(
            'InvalidAggregate',
            candidate.type,
            `${Type.encode(candidate.type)} has non-canonical slice layout facts`,
          ),
        ]
  }
  if (Type.isReference(candidate.type)) {
    const expected = referenceEntry(target, candidate.type)
    return candidate.size === expected.size &&
      candidate.alignment === expected.alignment &&
      representationEquals(candidate.representation, expected.representation)
      ? []
      : [
          invalid(
            'InvalidScalar',
            candidate.type,
            `${Type.encode(candidate.type)} does not match the canonical reference layout`,
          ),
        ]
  }
  if (Type.isPointer(candidate.type)) {
    const expected = pointerEntry(target, candidate.type)
    return candidate.type.addressSpace === 0 &&
      (candidate.type.alignment === 'Natural' ||
        Type.isPointerAlignment(candidate.type.alignment)) &&
      candidate.size === expected.size &&
      candidate.alignment === expected.alignment &&
      candidate.copy === expected.copy &&
      representationEquals(candidate.representation, expected.representation)
      ? []
      : [
          invalid(
            'InvalidScalar',
            candidate.type,
            `${Type.encode(candidate.type)} does not match the canonical pointer layout`,
          ),
        ]
  }
  if (Type.isForeignFunction(candidate.type)) {
    const expected = foreignFunctionEntry(target, candidate.type)
    return candidate.size === expected.size &&
      candidate.alignment === expected.alignment &&
      candidate.copy === expected.copy &&
      representationEquals(candidate.representation, expected.representation)
      ? []
      : [
          invalid(
            'InvalidScalar',
            candidate.type,
            `${Type.encode(candidate.type)} does not match the canonical C function-pointer layout`,
          ),
        ]
  }
  if (Type.isUnion(candidate.type)) {
    const members = candidate.type.members.flatMap((member): ReadonlyArray<Entry> => {
      const memberLayout = available.get(Type.runtimeKey(member))
      return memberLayout === undefined ? [] : [memberLayout]
    })
    if (members.length !== candidate.type.members.length) {
      return [
        invalid(
          'InvalidAggregate',
          candidate.type,
          `${Type.encode(candidate.type)} has unavailable union members`,
        ),
      ]
    }
    const expected = unionEntry(candidate.type, members)
    return candidate.size === expected.size &&
      candidate.alignment === expected.alignment &&
      representationEquals(candidate.representation, expected.representation)
      ? []
      : [
          invalid(
            'InvalidAggregate',
            candidate.type,
            `${Type.encode(candidate.type)} has non-canonical union layout facts`,
          ),
        ]
  }
  if (Type.isNever(candidate.type)) {
    const canonical = neverEntry()
    return candidate.size === canonical.size &&
      candidate.alignment === canonical.alignment &&
      representationEquals(candidate.representation, canonical.representation)
      ? []
      : [
          invalid(
            'InvalidAggregate',
            candidate.type,
            'never must use its zero-sized uninhabited placeholder layout',
          ),
        ]
  }
  if (Type.isRepresented(candidate.type)) {
    const type = candidate.type
    const argument = type.representation.argument
    if (Type.isCompositeEffectRepresentationArgument(argument)) {
      const alternatives = argument.alternatives.map((alternative) =>
        available.get(
          Type.runtimeKey(
            Type.represented(type.contract, type.representation.requiredBound, alternative),
          ),
        ),
      )
      const payloadAlignment = alternatives.reduce(
        (maximum, alternative) => Math.max(maximum, alternative?.alignment ?? 1),
        1,
      )
      const payloadSize = alternatives.reduce(
        (maximum, alternative) => Math.max(maximum, alternative?.size ?? 0),
        0,
      )
      const alignment = Math.max(4, payloadAlignment)
      const size = alignUp(alignUp(4, payloadAlignment) + payloadSize, alignment)
      return alternatives.every((alternative) => alternative !== undefined) &&
        candidate.executable === undefined &&
        candidate.representation._tag === 'Aggregate' &&
        candidate.representation.fields.length === 0 &&
        candidate.representation.tailPadding === size &&
        candidate.copy === alternatives.every((alternative) => alternative?.copy === true) &&
        candidate.size === size &&
        candidate.alignment === alignment
        ? []
        : [
            invalid(
              'InvalidAggregate',
              candidate.type,
              `${Type.encode(candidate.type)} has non-canonical composite Effect storage facts`,
            ),
          ]
    }
    if (candidate.executable !== undefined) {
      return candidate.representation._tag === 'Aggregate' &&
        candidate.representation.fields.length === 0 &&
        candidate.representation.tailPadding === candidate.size &&
        candidate.size >= 0 &&
        candidate.alignment >= 1
        ? []
        : [
            invalid(
              'InvalidAggregate',
              candidate.type,
              `${Type.encode(candidate.type)} has non-canonical executable environment facts`,
            ),
          ]
    }
    if (candidate.representation._tag === 'StoredEffectEnvironment') {
      const violations: Array<Violation> = []
      const expected = candidate.representation.fields.map((field, ordinal) => {
        const borrowed = field.representation === 'Borrow'
        const executable =
          field.effectIdentity !== undefined || field.callableIdentity !== undefined
        let fieldLayout: Entry | undefined
        if (!borrowed && !executable) {
          fieldLayout = Type.isBuiltin(field.type)
            ? scalarEntry(target, field.type)
            : available.get(Type.runtimeKey(field.type))
        }
        let size = fieldLayout?.size ?? 0
        let alignment = fieldLayout?.alignment ?? 1
        if (borrowed) {
          size = target.pointerSize
          alignment = target.pointerAlignment
        } else if (executable) {
          size = field.size
          alignment = field.alignment
        }
        return {
          value: ordinal,
          size,
          alignment,
          available: borrowed || executable || fieldLayout !== undefined,
        }
      })
      const packed = Packing.pack(expected)
      for (const [ordinal, field] of candidate.representation.fields.entries()) {
        const slot = candidate.representation.realization.environment.at(ordinal)
        const facts = expected.at(ordinal)
        const placement = packed.fields.at(ordinal)
        if (
          slot === undefined ||
          slot.ordinal !== field.capture ||
          slot.source !== field.source ||
          slot.sourceOrdinal !== field.ordinal ||
          slot.access !== field.access ||
          !(
            Type.equals(slot.type, field.type) ||
            (field.effectIdentity !== undefined &&
              Type.isEffect(slot.type) &&
              Type.isEffect(field.type) &&
              Type.equals(
                Type.effectWithRows(
                  slot.type.success,
                  slot.type.failureRow,
                  slot.type,
                  field.type.access,
                  slot.type.requirementRow,
                ),
                field.type,
              ))
          ) ||
          slot.effectIdentity !== field.effectIdentity ||
          (slot.callableIdentity === undefined && field.callableIdentity !== undefined) ||
          (slot.callableIdentity !== undefined &&
            (field.callableIdentity === undefined ||
              !Type.equalsGenericArgument(slot.callableIdentity, field.callableIdentity))) ||
          facts === undefined ||
          placement === undefined ||
          !facts.available ||
          facts.alignment < 1 ||
          facts.size < 0 ||
          field.offset !== placement.offset ||
          field.size !== facts.size ||
          field.alignment !== facts.alignment ||
          field.padding !== placement.padding
        ) {
          violations.push(
            invalid(
              'InvalidAggregate',
              candidate.type,
              `Effect capture ${field.capture} has non-canonical physical facts`,
            ),
          )
        }
      }
      if (
        candidate.size !== packed.size ||
        candidate.alignment !== packed.alignment ||
        candidate.representation.tailPadding !== packed.tailPadding
      ) {
        violations.push(
          invalid(
            'InvalidAggregate',
            candidate.type,
            `${Type.encode(candidate.type)} has non-canonical stored Effect environment size or alignment`,
          ),
        )
      }
      return violations
    }
    if (candidate.representation._tag !== 'CallableEnvironment') {
      return [
        invalid(
          'InvalidAggregate',
          candidate.type,
          `${Type.encode(candidate.type)} has no concrete callable environment`,
        ),
      ]
    }
    const violations: Array<Violation> = []
    const expected = candidate.representation.fields.map((field, ordinal) => {
      const borrowed = field.representation === 'Borrow'
      const executable = field.callableIdentity !== undefined
      let fieldLayout: Entry | undefined
      if (!borrowed && !executable) {
        fieldLayout = Type.isBuiltin(field.type)
          ? scalarEntry(target, field.type)
          : available.get(Type.runtimeKey(field.type))
      }
      let size = fieldLayout?.size ?? 0
      let alignment = fieldLayout?.alignment ?? 1
      if (borrowed) {
        size = target.pointerSize
        alignment = target.pointerAlignment
      } else if (executable) {
        size = field.size
        alignment = field.alignment
      }
      return {
        value: ordinal,
        size,
        alignment,
        available: borrowed || executable || fieldLayout !== undefined,
      }
    })
    const packed = Packing.pack(expected)
    for (const [ordinal, field] of candidate.representation.fields.entries()) {
      const capture = candidate.representation.realization.captures.at(ordinal)
      const facts = expected.at(ordinal)
      const placement = packed.fields.at(ordinal)
      if (
        capture === undefined ||
        capture.ordinal !== field.ordinal ||
        capture.parameterOrdinal !== field.parameterOrdinal ||
        capture.access !== field.access ||
        !Type.equals(capture.type, field.type) ||
        facts === undefined ||
        placement === undefined ||
        !facts.available ||
        field.offset !== placement.offset ||
        field.size !== facts.size ||
        field.alignment !== facts.alignment ||
        field.padding !== placement.padding
      ) {
        violations.push(
          invalid(
            'InvalidAggregate',
            candidate.type,
            `callable capture ${field.ordinal} has non-canonical physical facts`,
          ),
        )
      }
    }
    if (
      candidate.size !== packed.size ||
      candidate.alignment !== packed.alignment ||
      candidate.representation.tailPadding !== packed.tailPadding
    ) {
      violations.push(
        invalid(
          'InvalidAggregate',
          candidate.type,
          `${Type.encode(candidate.type)} has non-canonical callable environment size or alignment`,
        ),
      )
    }
    return violations
  }
  if (
    (Type.isSharedCore(candidate.type) ||
      Type.isExecution(candidate.type) ||
      Type.isExecutionRef(candidate.type)) &&
    candidate.representation._tag === 'Reference'
  ) {
    const address = candidate.representation.address
    return candidate.copy === false &&
      candidate.size === target.pointerSize &&
      candidate.alignment === target.pointerAlignment &&
      Type.equals(candidate.representation.target, candidate.type) &&
      address.bits === (target.pointerSize === 4 ? 32 : 64) &&
      address.offset === 0 &&
      address.size === target.pointerSize &&
      address.alignment === target.pointerAlignment
      ? []
      : [
          invalid(
            'InvalidAggregate',
            candidate.type,
            `${Type.encode(candidate.type)} has a non-canonical sealed owning handle`,
          ),
        ]
  }
  if (candidate.representation._tag === 'NominalUnion') {
    const representation = candidate.representation
    const unionViolations: Array<Violation> = []
    if (!Type.isNominal(candidate.type)) {
      return [
        invalid(
          'InvalidAggregate',
          candidate.type,
          `${Type.encode(candidate.type)} uses nominal-union storage without a nominal type`,
        ),
      ]
    }
    const nominal = candidate.type
    if (
      representation.union.module !== nominal.module ||
      representation.union.name !== nominal.name ||
      representation.tag.bits !== 32 ||
      representation.tag.size !== 4
    ) {
      unionViolations.push(
        invalid(
          'InvalidAggregate',
          candidate.type,
          `${Type.encode(candidate.type)} has a foreign nominal-union identity or tag`,
        ),
      )
    }
    for (const [ordinal, variant] of representation.variants.entries()) {
      const expected = variant.fields.map((field) => {
        const fieldLayout = Type.isBuiltin(field.type)
          ? scalarEntry(target, field.type)
          : available.get(Type.runtimeKey(field.type))
        return {
          value: field,
          size: fieldLayout?.size ?? 0,
          alignment: fieldLayout?.alignment ?? 1,
          available: fieldLayout !== undefined,
        }
      })
      const packed = Packing.pack(expected)
      const fieldsValid = variant.fields.every((field, fieldOrdinal) => {
        const facts = expected.at(fieldOrdinal)
        const placement = packed.fields.at(fieldOrdinal)
        return (
          facts?.available === true &&
          placement !== undefined &&
          field.offset === placement.offset &&
          field.size === facts.size &&
          field.alignment === facts.alignment &&
          field.padding === placement.padding
        )
      })
      if (
        variant.ordinal !== ordinal ||
        variant.variant.union.module !== representation.union.module ||
        variant.variant.union.name !== representation.union.name ||
        !fieldsValid ||
        variant.size !== packed.size ||
        variant.alignment !== packed.alignment ||
        variant.tailPadding !== packed.tailPadding
      ) {
        unionViolations.push(
          invalid(
            'InvalidAggregate',
            candidate.type,
            `${Type.encode(candidate.type)} variant ${variant.variant.name} has non-canonical physical facts`,
          ),
        )
      }
    }
    const payloadAlignment = representation.variants.reduce(
      (maximum, variant) => Math.max(maximum, variant.alignment),
      1,
    )
    const payloadSize = representation.variants.reduce(
      (maximum, variant) => Math.max(maximum, variant.size),
      0,
    )
    const payloadOffset = alignUp(4, payloadAlignment)
    const alignment = Math.max(4, payloadAlignment)
    const size = alignUp(payloadOffset + payloadSize, alignment)
    if (
      representation.payloadAlignment !== payloadAlignment ||
      representation.payloadSize !== payloadSize ||
      representation.payloadOffset !== payloadOffset ||
      representation.tagPadding !== payloadOffset - 4 ||
      representation.tailPadding !== size - (payloadOffset + payloadSize) ||
      candidate.alignment !== alignment ||
      candidate.size !== size
    ) {
      unionViolations.push(
        invalid(
          'InvalidAggregate',
          candidate.type,
          `${Type.encode(candidate.type)} has non-canonical nominal-union size or alignment`,
        ),
      )
    }
    const cleanupHook = representation.cleanupHook
    if (
      cleanupHook !== undefined &&
      (cleanupHook.hook.module.length === 0 ||
        cleanupHook.hook.name.length === 0 ||
        cleanupHook.typeArguments.some(
          (argument) => !Type.isRuntimeConcreteGenericArgument(argument),
        ))
    ) {
      unionViolations.push(
        invalid(
          'InvalidAggregate',
          candidate.type,
          `${Type.encode(candidate.type)} has a non-canonical cleanup hook`,
        ),
      )
    }
    return unionViolations
  }
  if (candidate.representation._tag !== 'Aggregate') {
    return [
      invalid(
        'InvalidAggregate',
        candidate.type,
        `${Type.encode(candidate.type)} is nominal but not aggregate`,
      ),
    ]
  }
  const violations: Array<Violation> = []
  const cleanupHook = candidate.representation.cleanupHook
  if (
    cleanupHook !== undefined &&
    (cleanupHook.hook.module.length === 0 ||
      cleanupHook.hook.name.length === 0 ||
      cleanupHook.typeArguments.some(
        (argument) => !Type.isRuntimeConcreteGenericArgument(argument),
      ))
  ) {
    violations.push(
      invalid(
        'InvalidAggregate',
        candidate.type,
        `${Type.encode(candidate.type)} has a non-canonical cleanup hook`,
      ),
    )
  }
  const layouts = candidate.representation.fields.map((field) =>
    Type.isBuiltin(field.type)
      ? scalarEntry(target, field.type)
      : available.get(Type.runtimeKey(field.type)),
  )
  const packed = Packing.pack(
    layouts.map((fieldLayout, ordinal) => ({
      value: ordinal,
      size: fieldLayout?.size ?? 0,
      alignment: fieldLayout?.alignment ?? 1,
    })),
  )
  let previousOrdinal = -1
  for (const [ordinal, field] of candidate.representation.fields.entries()) {
    const fieldLayout = layouts.at(ordinal)
    if (field.id.ordinal <= previousOrdinal) {
      violations.push(
        invalid(
          'InvalidAggregate',
          candidate.type,
          `field ${field.name} is out of declaration order`,
        ),
      )
    }
    if (fieldLayout === undefined) {
      violations.push(
        invalid(
          'InvalidAggregate',
          candidate.type,
          `field ${field.name} has no available dependency layout`,
        ),
      )
      previousOrdinal = field.id.ordinal
      continue
    }
    const placement = packed.fields.at(ordinal)
    if (placement === undefined) continue
    if (
      field.offset !== placement.offset ||
      field.padding !== placement.padding ||
      field.size !== fieldLayout.size ||
      field.alignment !== fieldLayout.alignment
    ) {
      violations.push(
        invalid(
          'InvalidAggregate',
          candidate.type,
          `field ${field.name} has non-canonical physical facts`,
        ),
      )
    }
    previousOrdinal = field.id.ordinal
  }
  if (
    candidate.alignment !== packed.alignment ||
    candidate.size !== packed.size ||
    candidate.representation.tailPadding !== packed.tailPadding
  ) {
    violations.push(
      invalid(
        'InvalidAggregate',
        candidate.type,
        `${Type.encode(candidate.type)} has non-canonical size or alignment`,
      ),
    )
  }
  return violations
}

const commonViolations = (
  target: Target.Target,
  entries: ReadonlyArray<CatalogEntry>,
): ReadonlyArray<Violation> => {
  const violations: Array<Violation> = []
  if (!Target.isCanonical(target)) {
    violations.push({
      _tag: 'LayoutViolation',
      rule: 'NonCanonicalTarget',
      detail: `target ${target.id} does not match its canonical profile`,
    })
  }
  const available = new Map(
    entries.flatMap((candidate) =>
      candidate._tag === 'LayoutEntry'
        ? [[Type.runtimeKey(candidate.type), candidate] as const]
        : [],
    ),
  )
  const seen = new Set<string>()
  let previous: DeclarationFacts.SemanticType | undefined
  for (const candidate of entries) {
    const key = Type.runtimeKey(candidate.type)
    if (seen.has(key)) {
      violations.push(
        invalid(
          'DuplicateType',
          candidate.type,
          `layout contains duplicate ${Type.encode(candidate.type)} entry`,
        ),
      )
    }
    if (previous !== undefined && Type.runtimeKey(previous) > Type.runtimeKey(candidate.type)) {
      violations.push(
        invalid(
          'NonCanonicalOrder',
          candidate.type,
          `${Type.encode(candidate.type)} follows ${Type.encode(previous)} out of canonical order`,
        ),
      )
    }
    if (candidate._tag === 'LayoutEntry') {
      violations.push(...verifyEntry(target, candidate, available))
    }
    seen.add(key)
    previous = candidate.type
  }
  return violations
}

/**
 * Verifies the semantic-to-physical boundary unique to C-layout records.
 *
 * Ordinary aggregate verification proves canonical packing. This companion check proves that a
 * declaration carrying the foreign promise reached that packing only through the closed C object
 * subset, and that the entry still contains exactly the declaration-owned field identities.
 */
const cLayoutViolations = (
  catalog: Catalog,
  index: DeclarationIndex.Index,
): ReadonlyArray<Violation> => {
  const violations: Array<Violation> = []
  const resolve = CLayout.resolveFrom(index.modules)
  for (const declaration of index.modules.flatMap((module) => module.structs)) {
    if (declaration.layout._tag !== 'Foreign' || declaration.canonical._tag !== 'Canonical')
      continue
    const type = Type.nominal(declaration.canonical.id.module, declaration.canonical.id.name)
    const candidate = catalogEntry(catalog, type)
    if (candidate?._tag !== 'LayoutEntry' || candidate.representation._tag !== 'Aggregate') {
      violations.push(
        invalid(
          'InvalidCLayout',
          type,
          `${Type.encode(type)} has a C-layout promise without an aggregate catalog entry`,
        ),
      )
      continue
    }
    const representation = candidate.representation
    const admissions = CLayout.admitFields(declaration, resolve)
    const supported =
      declaration.typeParameters.length === 0 &&
      declaration.fields.length === representation.fields.length &&
      declaration.fields.every((field, ordinal) => {
        const placed = representation.fields.at(ordinal)
        const admission = admissions.at(ordinal)
        return (
          field.declaredType._tag === 'Resolved' &&
          admission?._tag === 'Admitted' &&
          placed !== undefined &&
          DeclarationFacts.sameFieldId(field.id, placed.id) &&
          Type.equals(field.declaredType.type, placed.type)
        )
      })
    if (!supported) {
      violations.push(
        invalid(
          'InvalidCLayout',
          type,
          `${Type.encode(type)} reaches layout outside the admitted C object subset`,
        ),
      )
    }
  }
  return violations
}

const fieldIdEquals = (left: DeclarationFacts.FieldId, right: DeclarationFacts.FieldId): boolean =>
  DeclarationFacts.sameFieldId(left, right)

/** Compares two compiler-planned physical selectors. */
export const selectorEquals = (left: Selector, right: Selector): boolean => {
  switch (left._tag) {
    case 'ElementSelector':
      return right._tag === 'ElementSelector' && left.index === right.index
    case 'CallableCaptureSelector':
      return right._tag === 'CallableCaptureSelector' && left.ordinal === right.ordinal
    case 'EffectCaptureSelector':
      return right._tag === 'EffectCaptureSelector' && left.ordinal === right.ordinal
    case 'UnionTagSelector':
      return right._tag === 'UnionTagSelector'
    case 'UnionPayloadSelector':
      return right._tag === 'UnionPayloadSelector' && left.slot === right.slot
    case 'NominalUnionTagSelector':
      return right._tag === 'NominalUnionTagSelector'
    case 'NominalUnionPayloadSelector':
      return right._tag === 'NominalUnionPayloadSelector' && left.slot === right.slot
    case 'SliceAddressSelector':
      return right._tag === 'SliceAddressSelector'
    case 'SliceLengthSelector':
      return right._tag === 'SliceLengthSelector'
    case 'StringStorageSelector':
      return right._tag === 'StringStorageSelector'
    case 'StringByteLengthSelector':
      return right._tag === 'StringByteLengthSelector'
    case 'ReferenceAddressSelector':
      return right._tag === 'ReferenceAddressSelector'
    case 'FieldId':
      return right._tag === 'FieldId' && fieldIdEquals(left, right)
  }
}

/** Resolves one compiler-planned scalar lane to its byte offset within a logical value. */
export const laneOffset = (
  self: Plan,
  root: DeclarationFacts.SemanticType,
  path: ReadonlyArray<Selector>,
): number | undefined => {
  let current: DeclarationFacts.SemanticType = root
  let offset = 0
  for (const [ordinal, selector] of path.entries()) {
    const candidate = entry(self, current)
    if (candidate === undefined) return undefined
    if (selector._tag === 'FieldId') {
      if (candidate.representation._tag !== 'Aggregate') return undefined
      const field = candidate.representation.fields.find((item) => fieldIdEquals(item.id, selector))
      if (field === undefined) return undefined
      offset += field.offset
      current = field.type
      continue
    }
    if (selector._tag === 'ElementSelector') {
      if (candidate.representation._tag !== 'Repeated') return undefined
      if (selector.index < 0 || selector.index >= candidate.representation.length) return undefined
      offset += selector.index * candidate.representation.stride
      current = candidate.representation.element
      continue
    }
    if (selector._tag === 'CallableCaptureSelector') {
      if (candidate.executable?._tag === 'Callable') {
        const field = candidate.executable.fields.find(
          (capture) => capture.capture === selector.ordinal,
        )
        if (field === undefined) return undefined
        offset += field.offset
        current = field.type
        continue
      }
      if (candidate.representation._tag !== 'CallableEnvironment') return undefined
      const field = candidate.representation.fields.find(
        (capture) => capture.ordinal === selector.ordinal,
      )
      if (field === undefined) return undefined
      offset += field.offset
      current = field.type
      continue
    }
    if (selector._tag === 'EffectCaptureSelector') {
      if (candidate.executable?._tag === 'Effect') {
        const field = candidate.executable.fields.find(
          (capture) => capture.capture === selector.ordinal,
        )
        if (field === undefined) return undefined
        offset += field.offset
        current = field.type
        continue
      }
      if (candidate.representation._tag !== 'StoredEffectEnvironment') return undefined
      const field = candidate.representation.fields.find(
        (capture) => capture.capture === selector.ordinal,
      )
      if (field === undefined) return undefined
      offset += field.offset
      current = field.type
      continue
    }
    if (selector._tag === 'UnionTagSelector') {
      return ordinal === path.length - 1 && candidate.representation._tag === 'Union'
        ? offset
        : undefined
    }
    if (selector._tag === 'UnionPayloadSelector') {
      if (ordinal !== path.length - 1 || candidate.representation._tag !== 'Union') {
        return undefined
      }
      const shape = callingShape(self, current)
      if (shape?.tree._tag !== 'SumShape') return undefined
      let payloadOffset = 0
      for (let slot = 0; slot <= selector.slot; slot += 1) {
        const type = shape.tree.payloadTypes.at(slot)
        if (type === undefined) return undefined
        const scalar = scalarEntry(self.target, type)
        payloadOffset = alignUp(payloadOffset, scalar.alignment)
        if (slot === selector.slot) {
          return offset + candidate.representation.payloadOffset + payloadOffset
        }
        payloadOffset += scalar.size
      }
      return undefined
    }
    if (selector._tag === 'NominalUnionTagSelector') {
      return ordinal === path.length - 1 && candidate.representation._tag === 'NominalUnion'
        ? offset
        : undefined
    }
    // A nominal carrier lane has no single stored offset across active variants.
    if (selector._tag === 'NominalUnionPayloadSelector') return undefined
    if (selector._tag === 'SliceAddressSelector') {
      return ordinal === path.length - 1 && candidate.representation._tag === 'Slice'
        ? offset + candidate.representation.address.offset
        : undefined
    }
    if (selector._tag === 'StringStorageSelector') {
      return ordinal === path.length - 1 && candidate.representation._tag === 'String'
        ? offset + candidate.representation.storage.offset
        : undefined
    }
    if (selector._tag === 'StringByteLengthSelector') {
      return ordinal === path.length - 1 && candidate.representation._tag === 'String'
        ? offset + candidate.representation.byteLength.offset
        : undefined
    }
    if (selector._tag === 'ReferenceAddressSelector') {
      return ordinal === path.length - 1 && candidate.representation._tag === 'Reference'
        ? offset + candidate.representation.address.offset
        : undefined
    }
    return ordinal === path.length - 1 && candidate.representation._tag === 'Slice'
      ? offset + candidate.representation.length.offset
      : undefined
  }
  return offset
}

const callingScalarEquals = (left: CallingScalar, right: CallingScalar): boolean =>
  typeof left === 'string'
    ? left === right
    : typeof right !== 'string' &&
      Type.equals(left.element, right.element) &&
      left.bits === right.bits
const verifyCallingShapes = Effect.fn('LayoutVerify.verifyCallingShapes')(function* (
  self: Plan,
): Effect.fn.Return<ReadonlyArray<Violation>> {
  const expected = yield* planCallingShapes(
    self.target,
    self.entries,
    self.entries.map((entry) => entry.type),
    self.effectEnvironments,
    self.callableEnvironments,
  )
  const violations: Array<Violation> = []
  for (const entry of self.entries) {
    const actual = callingShape(self, entry.type)
    const canonical = expected.find((candidate) => Type.equals(candidate.type, entry.type))
    const matches =
      actual !== undefined &&
      canonical !== undefined &&
      actual.laneCount === canonical.laneCount &&
      actual.lanes.length === canonical.lanes.length &&
      actual.lanes.every((lane, laneIndex) => {
        const other = canonical.lanes.at(laneIndex)
        return (
          other !== undefined &&
          callingScalarEquals(lane.type, other.type) &&
          lane.path.length === other.path.length &&
          lane.path.every((selector, selectorIndex) => {
            const otherSelector = other.path.at(selectorIndex)
            return otherSelector !== undefined && selectorEquals(selector, otherSelector)
          })
        )
      })
    if (!matches) {
      violations.push(
        invalid(
          'InvalidCallingShape',
          entry.type,
          `${Type.encode(entry.type)} does not match its canonical scalar-lane shape`,
        ),
      )
    }
  }
  if (self.callingShapes.length < self.entries.length) {
    violations.push({
      _tag: 'LayoutViolation',
      rule: 'InvalidCallingShape',
      detail: 'calling-shape collection does not match the reachable layout entries',
    })
  }
  return violations
})
const verifyLiteralVerdicts = Effect.fn('LayoutVerify.verifyLiteralVerdicts')(function* (
  self: Plan,
): Effect.fn.Return<ReadonlyArray<Violation>> {
  yield* Effect.annotateCurrentSpan({ 'entries.count': self.literalVerdicts.length })
  const bits: 32 | 64 = self.target.pointerSize === 4 ? 32 : 64
  const violations: Array<Violation> = []
  const unavailable = self.literalVerdicts.filter(
    (verdict) => verdict._tag === 'UnavailableWordLiteral',
  )
  for (const verdict of self.literalVerdicts) {
    const range = wordRange(verdict.type, bits)
    const expectedTag =
      verdict.value >= range.minimum && verdict.value <= range.maximum
        ? 'AvailableWordLiteral'
        : 'UnavailableWordLiteral'
    if (verdict.bits !== bits || verdict._tag !== expectedTag) {
      violations.push({
        _tag: 'LayoutViolation',
        rule: 'InvalidLiteralVerdict',
        type: verdict.type,
        detail: `${verdict.value.toString()} has a non-canonical ${verdict.bits}-bit verdict`,
      })
    }
  }
  if (
    self.diagnostics.length !== unavailable.length ||
    unavailable.some((verdict) =>
      self.diagnostics.every(
        (diagnostic) =>
          diagnostic.code !== Diagnostic.wordLiteralOutOfRangeCode ||
          diagnostic.span.sourceId !== verdict.span.sourceId ||
          diagnostic.span.start !== verdict.span.start ||
          diagnostic.span.end !== verdict.span.end ||
          diagnostic.reason._tag !== 'WordLiteralOutOfRange' ||
          diagnostic.reason.type !== verdict.type ||
          diagnostic.reason.spelling !== verdict.value.toString() ||
          diagnostic.reason.target !== self.target.id ||
          diagnostic.reason.bits !== bits,
      ),
    )
  ) {
    violations.push({
      _tag: 'LayoutViolation',
      rule: 'InvalidLiteralVerdict',
      type: 'usize',
      detail: 'target literal diagnostics do not match unavailable verdicts',
    })
  }
  return violations
})
const verifyStaticData = Effect.fn('LayoutVerify.verifyStaticData')(function* (
  self: Plan,
): Effect.fn.Return<ReadonlyArray<Violation>> {
  yield* Effect.annotateCurrentSpan({ 'entries.count': self.staticData?.length ?? 0 })
  const expectedBits = self.target.pointerSize === 4 ? 32 : 64
  const valid = (self.staticData ?? []).every((placement, ordinal, all) => {
    const previous = ordinal === 0 ? undefined : all.at(ordinal - 1)
    return (
      (previous === undefined || previous.data.id < placement.data.id) &&
      placement.alignment === 1 &&
      placement.addressBits === expectedBits &&
      placement.lengthBits === expectedBits &&
      placement.data.bytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
    )
  })
  return valid
    ? []
    : [
        {
          _tag: 'LayoutViolation' as const,
          rule: 'InvalidCallingShape' as const,
          detail: 'static data placements are not canonical immutable target data',
        },
      ]
})

/** Verifies canonical target, ordering, uniqueness, representation, and ABI facts. */
export const verify = Effect.fn('LayoutVerify.verify')(function* (
  self: Plan,
): Effect.fn.Return<ReadonlyArray<Violation>> {
  const entries = yield* verifyEntries(self)
  const shapes = yield* verifyCallingShapes(self)
  const storage = yield* ValueStorage.verify(self)
  const literals = yield* verifyLiteralVerdicts(self)
  const staticData = yield* verifyStaticData(self)
  return [...entries, ...shapes, ...storage, ...literals, ...staticData]
})
const verifyEntries = Effect.fn('LayoutVerify.verifyEntries')((self: Plan) =>
  Effect.sync(() => commonViolations(self.target, self.entries)),
)

/** Verifies all available entries and deterministic ordering within a nominal catalog. */
export const verifyCatalog = (
  self: Catalog,
  index: DeclarationIndex.Index,
): ReadonlyArray<Violation> => [
  ...commonViolations(self.target, self.entries),
  ...cLayoutViolations(self, index),
]

/** Verifies that every planned nominal layout is exactly the catalog decision. */
export const verifyAgainstCatalog = (self: Plan, catalog: Catalog): ReadonlyArray<Violation> =>
  self.entries.flatMap((candidate) => {
    if (
      Type.isBuiltin(candidate.type) ||
      Type.isFixedArray(candidate.type) ||
      Type.isReference(candidate.type)
    )
      return []
    const expected = catalogEntry(catalog, candidate.type)
    // Concrete generic specializations and executable representations are completed only in
    // the runtime plan. The pre-reachability catalog is an oracle only for entries it already
    // resolved.
    if (expected?._tag !== 'LayoutEntry') return []
    return candidate.copy === expected.copy &&
      candidate.size === expected.size &&
      candidate.alignment === expected.alignment &&
      representationEquals(candidate.representation, expected.representation) &&
      executablePlanEquals(candidate.executable, expected.executable)
      ? []
      : [
          invalid(
            'CatalogMismatch',
            candidate.type,
            `${Type.encode(candidate.type)} differs from its catalog entry`,
          ),
        ]
  })
