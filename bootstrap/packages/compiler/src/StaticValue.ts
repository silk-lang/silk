import * as AuthoredIdentity from './AuthoredIdentity.js'
import type * as DeclarationFacts from './DeclarationFacts.js'
import type * as Provenance from './Provenance.js'
import * as FloatingPoint from './FloatingPoint.js'
import * as Canonical from './internal/Canonical.js'
import * as Scalar from './Scalar.js'
import * as Type from './Type.js'

/** One finite, immutable value admitted to compiler-owned static evaluation. */
export type Value =
  | UnitValue
  | BooleanValue
  | CharacterValue
  | IntegerValue
  | FloatValue
  | EnumValue
  | TextValue
  | AggregateValue
  | TypeDescriptorValue
  | FieldDescriptorValue
  | FieldCollectionValue
  | StaticSequenceValue
  | TestDescriptorValue
  | TestCollectionValue

export interface UnitValue {
  readonly _tag: 'UnitValue'
}

export interface BooleanValue {
  readonly _tag: 'BooleanValue'
  readonly value: boolean
}

export interface CharacterValue {
  readonly _tag: 'CharacterValue'
  readonly value: number
}

export interface IntegerValue {
  readonly _tag: 'IntegerValue'
  readonly type: Scalar.IntegerSpelling
  readonly value: bigint
}

export interface FloatValue {
  readonly _tag: 'FloatValue'
  readonly type: Scalar.FloatSpelling
  readonly bits: bigint
}

export interface EnumValue {
  readonly _tag: 'EnumValue'
  readonly type: DeclarationFacts.CanonicalId
  readonly member: string
  readonly representation: Scalar.EnumRepresentationSpelling
  readonly discriminant: bigint
}

export interface TextValue {
  readonly _tag: 'TextValue'
  readonly bytes: ReadonlyArray<number>
  /** Caller-authored provenance metadata; deliberately excluded from canonical value identity. */
  readonly origin?: TextOrigin
}

/**
 * Where the bytes of a static text were written: non-identity metadata, in value coordinates. It is
 * a list of segments, so text built by slicing, joining and calling still names every literal it
 * was copied from.
 */
export type TextOrigin = Provenance.Provenance

/** The declaration-independent identity needed to distinguish canonical aggregate values. */
export type AggregateIdentity = NominalAggregateIdentity | ArrayAggregateIdentity

export interface NominalAggregateIdentity {
  readonly _tag: 'NominalAggregateIdentity'
  readonly declaration: DeclarationFacts.CanonicalId
  /** Canonical generic-argument encodings in declared order. */
  readonly typeArguments: ReadonlyArray<string>
  readonly variant?: {
    readonly ordinal: number
    readonly name: string
  }
}

export interface ArrayAggregateIdentity {
  readonly _tag: 'ArrayAggregateIdentity'
  /** Canonical semantic type encoding for the repeated element. */
  readonly element: string
  readonly length: number
}

export interface AggregateField {
  readonly ordinal: number
  readonly value: Value
}

export interface AggregateValue {
  readonly _tag: 'AggregateValue'
  readonly identity: AggregateIdentity
  readonly fields: ReadonlyArray<AggregateField>
  /** Snapshot-local field identities used only when embedding the canonical value into TIR. */
  readonly runtimeFields?: ReadonlyArray<{
    readonly id: DeclarationFacts.FieldId
    readonly type: Type.Type
  }>
}

/** The source-level aggregate categories retained by static reflection. */
export type AggregateKind = 'Named' | 'Positional' | 'AnonymousNamed' | 'AnonymousPositional'

/** One canonical aggregate type descriptor with no runtime representation. */
export interface TypeDescriptorValue {
  readonly _tag: 'TypeDescriptorValue'
  readonly owner: Type.Nominal
  readonly kind: AggregateKind
}

/** The source-visible identity of one reflected aggregate field. */
export type ReflectedMember =
  | { readonly _tag: 'LabeledField'; readonly label: string }
  | { readonly _tag: 'PositionalField'; readonly ordinal: number }

/** Revision-independent provenance of one reflected declaration field. */
export interface DescriptorProvenance {
  readonly anchor: AuthoredIdentity.Anchor
}

/** One owner-and-value-typed field descriptor with no address or callable behavior. */
export interface FieldDescriptorValue {
  readonly _tag: 'FieldDescriptorValue'
  readonly owner: TypeDescriptorValue
  readonly declarationOrdinal: number
  readonly member: ReflectedMember
  /** Canonical concrete substituted field type used by per-field static elaboration. */
  readonly valueType: Type.Type
  /** The declaration whose lexical visibility authorized this descriptor. */
  readonly authorization: DeclarationFacts.CanonicalId
  readonly provenance: DescriptorProvenance
}

/** One declaration-ordered heterogeneous collection of reflected fields. */
export interface FieldCollectionValue {
  readonly _tag: 'FieldCollectionValue'
  readonly owner: TypeDescriptorValue
  readonly fields: ReadonlyArray<FieldDescriptorValue>
}

/** One immutable homogeneous sequence admitted only to static evaluation. */
export interface StaticSequenceValue {
  readonly _tag: 'StaticSequenceValue'
  /** Canonical concrete semantic type shared by every element. */
  readonly elementType: Type.Type
  readonly elements: ReadonlyArray<Value>
}

/** Compiler-issued phase-only reference to one exact test declaration and callable type. */
export interface TestDescriptorValue {
  readonly _tag: 'TestDescriptorValue'
  readonly declaration: DeclarationFacts.CanonicalId
  readonly callable: Type.Callable
  readonly authorization: string
}

/** Canonical-order heterogeneous collection consumed only by `static for`. */
export interface TestCollectionValue {
  readonly _tag: 'TestCollectionValue'
  readonly tests: ReadonlyArray<TestDescriptorValue>
}

export type RejectionReason =
  | 'UnsupportedValue'
  | 'InvalidCharacter'
  | 'InvalidInteger'
  | 'InvalidFloat'
  | 'InvalidEnum'
  | 'InvalidText'
  | 'InvalidAggregate'
  | 'InvalidTypeDescriptor'
  | 'InvalidFieldDescriptor'
  | 'InvalidFieldCollection'
  | 'InvalidStaticSequence'
  | 'InvalidTestDescriptor'
  | 'InvalidTestCollection'
  | 'CyclicValue'

/** A closed admission result; rejected candidates never become static values. */
export type Admission =
  | { readonly _tag: 'Admitted'; readonly value: Value }
  | {
      readonly _tag: 'Rejected'
      readonly reason: RejectionReason
      readonly path: ReadonlyArray<number>
      readonly detail: string
    }

export interface AdmissionOptions {
  /** Concrete target width used only to validate `usize` and `isize` values. */
  readonly pointerBits: 32 | 64
}

const unitValue: UnitValue = { _tag: 'UnitValue' }

/** The canonical static unit value. */
export const unit = (): UnitValue => unitValue

/** Constructs one canonical static Boolean. */
export const boolean = (value: boolean): BooleanValue => ({ _tag: 'BooleanValue', value })

const rejected = (
  reason: RejectionReason,
  detail: string,
  path: ReadonlyArray<number> = [],
): Admission => ({ _tag: 'Rejected', reason, path: [...path], detail })

const admitted = (value: Value): Admission => ({ _tag: 'Admitted', value })

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const canonicalId = (value: unknown): DeclarationFacts.CanonicalId | undefined => {
  if (
    !isRecord(value) ||
    value._tag !== 'CanonicalDeclarationId' ||
    typeof value.module !== 'string' ||
    typeof value.name !== 'string'
  )
    return undefined
  return {
    _tag: 'CanonicalDeclarationId',
    module: value.module,
    name: value.name,
  }
}

const declarationId = (value: unknown): DeclarationFacts.DeclarationId | undefined => {
  if (
    !isRecord(value) ||
    value._tag !== 'DeclarationId' ||
    typeof value.sourceId !== 'string' ||
    typeof value.ordinal !== 'number' ||
    !Number.isSafeInteger(value.ordinal) ||
    value.ordinal < 0
  )
    return undefined
  return { _tag: 'DeclarationId', sourceId: value.sourceId, ordinal: value.ordinal }
}

const fieldId = (value: unknown): DeclarationFacts.FieldId | undefined => {
  if (
    !isRecord(value) ||
    value._tag !== 'FieldId' ||
    typeof value.ordinal !== 'number' ||
    !Number.isSafeInteger(value.ordinal) ||
    value.ordinal < 0 ||
    !isRecord(value.owner)
  )
    return undefined
  const owner = (() => {
    if (value.owner._tag === 'StructFieldOwnerId') {
      const declaration = declarationId(value.owner.declaration)
      return declaration === undefined
        ? undefined
        : { _tag: 'StructFieldOwnerId' as const, declaration }
    }
    if (value.owner._tag !== 'UnionVariantFieldOwnerId' || !isRecord(value.owner.variant))
      return undefined
    const union = declarationId(value.owner.variant.union)
    const ordinal = value.owner.variant.ordinal
    return union === undefined ||
      typeof ordinal !== 'number' ||
      !Number.isSafeInteger(ordinal) ||
      ordinal < 0
      ? undefined
      : {
          _tag: 'UnionVariantFieldOwnerId' as const,
          variant: { _tag: 'UnionVariantId' as const, union, ordinal },
        }
  })()
  return owner === undefined ? undefined : { _tag: 'FieldId', owner, ordinal: value.ordinal }
}

const isEnumRepresentation = (value: unknown): value is Scalar.EnumRepresentationSpelling =>
  value === 'u8' ||
  value === 'u16' ||
  value === 'u32' ||
  value === 'u64' ||
  value === 'i8' ||
  value === 'i16' ||
  value === 'i32' ||
  value === 'i64'

const integerValue = (
  type: Scalar.IntegerSpelling,
  value: bigint,
  pointerBits: 32 | 64,
): Admission => {
  const scalar = Scalar.find(type)
  if (scalar?.category !== 'Integer')
    return rejected('InvalidInteger', `unknown integer scalar ${type}`)
  const range = Scalar.range(scalar, pointerBits)
  return value < range.minimum || value > range.maximum
    ? rejected('InvalidInteger', `${value.toString()} is outside ${type}`)
    : admitted({ _tag: 'IntegerValue', type, value })
}

const floatValue = (type: Scalar.FloatSpelling, bits: bigint): Admission => {
  const width = type === 'f32' ? 32 : 64
  if (bits < 0n || bits >= 1n << BigInt(width))
    return rejected('InvalidFloat', `bits are outside ${type}`)
  const value: FloatingPoint.Bits = { width, bits }
  return admitted({
    _tag: 'FloatValue',
    type,
    bits: FloatingPoint.isNotANumber(value) ? FloatingPoint.canonicalNaN(width) : bits,
  })
}

const offset = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

const textRange = (value: unknown): Provenance.Range | undefined =>
  isRecord(value) && offset(value.start) && offset(value.end) && value.start <= value.end
    ? { start: value.start, end: value.end }
    : undefined

const textSource = (value: unknown): Provenance.Source | undefined => {
  if (!isRecord(value)) return undefined
  const range = textRange(value.range)
  if (range === undefined) return undefined
  if (value._tag === 'Parameter')
    return offset(value.ordinal)
      ? {
          _tag: 'Parameter',
          ...(typeof value.scope === 'string' ? { scope: value.scope } : {}),
          ordinal: value.ordinal,
          range,
        }
      : undefined
  return value._tag === 'Literal' && isRecord(value.at) && value.at._tag === 'AuthoredAnchor'
    ? {
        _tag: 'Literal',
        at: value.at as unknown as AuthoredIdentity.Anchor,
        range,
      }
    : undefined
}

/** Admits provenance only whole: one malformed segment discards it, and the text stays valid. */
const textOrigin = (value: unknown): TextOrigin | undefined => {
  if (!Array.isArray(value)) return undefined
  const segments: Array<Provenance.Segment> = []
  for (const segment of value) {
    const range = isRecord(segment) ? textRange(segment.value) : undefined
    const from = isRecord(segment) ? textSource(segment.from) : undefined
    if (range === undefined || from === undefined) return undefined
    segments.push({ value: range, from })
  }
  return segments
}

const textValue = (bytes: unknown, origin?: unknown): Admission => {
  if (
    !Array.isArray(bytes) ||
    bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 0xff)
  )
    return rejected('InvalidText', 'static text must contain only bytes')
  const canonicalBytes = [...bytes]
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(canonicalBytes))
  } catch {
    return rejected('InvalidText', 'static text must be valid UTF-8')
  }
  const canonicalOrigin = textOrigin(origin)
  return admitted({
    _tag: 'TextValue',
    bytes: canonicalBytes,
    ...(canonicalOrigin === undefined ? {} : { origin: canonicalOrigin }),
  })
}

const aggregateIdentity = (value: unknown): AggregateIdentity | undefined => {
  if (!isRecord(value)) return undefined
  if (value._tag === 'ArrayAggregateIdentity') {
    if (
      typeof value.element !== 'string' ||
      typeof value.length !== 'number' ||
      !Number.isSafeInteger(value.length) ||
      value.length < 0
    )
      return undefined
    return {
      _tag: 'ArrayAggregateIdentity',
      element: value.element,
      length: value.length,
    }
  }
  if (value._tag !== 'NominalAggregateIdentity') return undefined
  const declaration = canonicalId(value.declaration)
  if (
    declaration === undefined ||
    !Array.isArray(value.typeArguments) ||
    value.typeArguments.some((argument) => typeof argument !== 'string')
  )
    return undefined
  let variant: NominalAggregateIdentity['variant']
  if (value.variant !== undefined) {
    if (
      !isRecord(value.variant) ||
      typeof value.variant.ordinal !== 'number' ||
      !Number.isSafeInteger(value.variant.ordinal) ||
      value.variant.ordinal < 0 ||
      typeof value.variant.name !== 'string'
    )
      return undefined
    variant = { ordinal: value.variant.ordinal, name: value.variant.name }
  }
  return {
    _tag: 'NominalAggregateIdentity',
    declaration,
    typeArguments: [...value.typeArguments],
    ...(variant === undefined ? {} : { variant }),
  }
}

const isAggregateKind = (value: unknown): value is AggregateKind =>
  value === 'Named' ||
  value === 'Positional' ||
  value === 'AnonymousNamed' ||
  value === 'AnonymousPositional'

const typeDescriptorValue = (value: unknown): TypeDescriptorValue | undefined => {
  if (!isRecord(value) || value._tag !== 'TypeDescriptorValue' || !isAggregateKind(value.kind))
    return undefined
  const owner = Type.fromUnknown(value.owner)
  if (owner === undefined || !Type.isNominal(owner)) return undefined
  return { _tag: 'TypeDescriptorValue', owner, kind: value.kind }
}

const reflectedMember = (value: unknown): ReflectedMember | undefined => {
  if (!isRecord(value)) return undefined
  if (value._tag === 'LabeledField') {
    return typeof value.label === 'string' && value.label.length > 0
      ? { _tag: 'LabeledField', label: value.label }
      : undefined
  }
  if (value._tag !== 'PositionalField') return undefined
  return typeof value.ordinal === 'number' &&
    Number.isSafeInteger(value.ordinal) &&
    value.ordinal >= 0
    ? { _tag: 'PositionalField', ordinal: value.ordinal }
    : undefined
}

const descriptorProvenance = (value: unknown): DescriptorProvenance | undefined => {
  if (!isRecord(value) || !isRecord(value.anchor) || value.anchor._tag !== 'AuthoredAnchor')
    return undefined
  return { anchor: value.anchor as unknown as AuthoredIdentity.Anchor }
}

const fieldDescriptorValue = (value: unknown): FieldDescriptorValue | undefined => {
  if (!isRecord(value) || value._tag !== 'FieldDescriptorValue') return undefined
  const owner = typeDescriptorValue(value.owner)
  const member = reflectedMember(value.member)
  const valueType = Type.fromUnknown(value.valueType)
  const authorization = canonicalId(value.authorization)
  const provenance = descriptorProvenance(value.provenance)
  if (
    owner === undefined ||
    typeof value.declarationOrdinal !== 'number' ||
    !Number.isSafeInteger(value.declarationOrdinal) ||
    value.declarationOrdinal < 0 ||
    member === undefined ||
    valueType === undefined ||
    authorization === undefined ||
    provenance === undefined
  )
    return undefined
  return {
    _tag: 'FieldDescriptorValue',
    owner,
    declarationOrdinal: value.declarationOrdinal,
    member,
    valueType,
    authorization,
    provenance,
  }
}

const testDescriptorValue = (value: unknown): TestDescriptorValue | undefined => {
  if (!isRecord(value) || value._tag !== 'TestDescriptorValue') return undefined
  const declaration = canonicalId(value.declaration)
  const callable = Type.fromUnknown(value.callable)
  if (
    declaration === undefined ||
    callable === undefined ||
    !Type.isCallable(callable) ||
    typeof value.authorization !== 'string' ||
    value.authorization.length === 0
  )
    return undefined
  return {
    _tag: 'TestDescriptorValue',
    declaration,
    callable,
    authorization: value.authorization,
  }
}

const sameTypeDescriptor = (left: TypeDescriptorValue, right: TypeDescriptorValue): boolean =>
  left.kind === right.kind && Type.equals(left.owner, right.owner)

const admissionAt = (
  input: unknown,
  options: AdmissionOptions,
  path: ReadonlyArray<number>,
  active: WeakSet<object>,
): Admission => {
  if (!isRecord(input)) return rejected('UnsupportedValue', 'value is not static data', path)
  if (active.has(input)) return rejected('CyclicValue', 'static values must be finite', path)
  active.add(input)
  const result = (() => {
    switch (input._tag) {
      case 'UnitValue':
        return admitted(unitValue)
      case 'BooleanValue':
        return typeof input.value === 'boolean'
          ? admitted(boolean(input.value))
          : rejected('UnsupportedValue', 'Boolean value is unavailable', path)
      case 'CharacterValue':
        return typeof input.value === 'number' &&
          Number.isSafeInteger(input.value) &&
          Scalar.isUnicodeScalarValue(BigInt(input.value))
          ? admitted({ _tag: 'CharacterValue', value: input.value })
          : rejected('InvalidCharacter', 'character is not a Unicode scalar', path)
      case 'IntegerValue':
        return Scalar.isIntegerSpelling(input.type) && typeof input.value === 'bigint'
          ? integerValue(input.type, input.value, options.pointerBits)
          : rejected('InvalidInteger', 'integer type or value is unavailable', path)
      case 'FloatValue':
        return Scalar.isFloatSpelling(input.type) && typeof input.bits === 'bigint'
          ? floatValue(input.type, input.bits)
          : rejected('InvalidFloat', 'float type or bits are unavailable', path)
      case 'EnumValue': {
        const type = canonicalId(input.type)
        const representation = input.representation
        const scalar = Scalar.find(isEnumRepresentation(representation) ? representation : '')
        if (
          type === undefined ||
          typeof input.member !== 'string' ||
          !isEnumRepresentation(representation) ||
          scalar?.category !== 'Integer' ||
          scalar.width._tag !== 'FixedWidth' ||
          typeof input.discriminant !== 'bigint'
        )
          return rejected('InvalidEnum', 'enum identity or discriminant is unavailable', path)
        const range = Scalar.range(scalar, 64)
        if (input.discriminant < range.minimum || input.discriminant > range.maximum)
          return rejected('InvalidEnum', 'enum discriminant exceeds its representation', path)
        return admitted({
          _tag: 'EnumValue',
          type,
          member: input.member,
          representation,
          discriminant: input.discriminant,
        })
      }
      case 'TextValue':
        return textValue(input.bytes, input.origin)
      case 'AggregateValue': {
        const identity = aggregateIdentity(input.identity)
        if (identity === undefined || !Array.isArray(input.fields))
          return rejected('InvalidAggregate', 'aggregate identity or fields are unavailable', path)
        const fields: Array<AggregateField> = []
        const ordinals = new Set<number>()
        for (const field of input.fields) {
          if (
            !isRecord(field) ||
            typeof field.ordinal !== 'number' ||
            !Number.isSafeInteger(field.ordinal) ||
            field.ordinal < 0 ||
            ordinals.has(field.ordinal)
          )
            return rejected('InvalidAggregate', 'aggregate field ordinals must be unique', path)
          ordinals.add(field.ordinal)
          const nested = admissionAt(field.value, options, [...path, field.ordinal], active)
          if (nested._tag === 'Rejected') return nested
          fields.push({ ordinal: field.ordinal, value: nested.value })
        }
        fields.sort((left, right) => left.ordinal - right.ordinal)
        if (
          identity._tag === 'ArrayAggregateIdentity' &&
          (fields.length !== identity.length ||
            fields.some((field, ordinal) => field.ordinal !== ordinal))
        )
          return rejected(
            'InvalidAggregate',
            'array fields must exactly match the declared length',
            path,
          )
        const runtimeFields = (() => {
          if (input.runtimeFields === undefined) return undefined
          if (!Array.isArray(input.runtimeFields) || input.runtimeFields.length !== fields.length)
            return false
          const admittedFields: Array<NonNullable<AggregateValue['runtimeFields']>[number]> = []
          const ordinals = new Set<number>()
          for (const inputField of input.runtimeFields) {
            if (!isRecord(inputField)) return false
            const id = fieldId(inputField.id)
            const type = Type.fromUnknown(inputField.type)
            if (
              id === undefined ||
              type === undefined ||
              ordinals.has(id.ordinal) ||
              !fields.some((field) => field.ordinal === id.ordinal)
            )
              return false
            ordinals.add(id.ordinal)
            admittedFields.push({ id, type })
          }
          return admittedFields
        })()
        if (runtimeFields === false)
          return rejected(
            'InvalidAggregate',
            'aggregate runtime field metadata does not match admitted fields',
            path,
          )
        return admitted({
          _tag: 'AggregateValue',
          identity,
          fields: fields,
          ...(runtimeFields === undefined ? {} : { runtimeFields }),
        })
      }
      case 'TypeDescriptorValue': {
        const descriptor = typeDescriptorValue(input)
        return descriptor === undefined
          ? rejected('InvalidTypeDescriptor', 'aggregate descriptor is unavailable', path)
          : admitted(descriptor)
      }
      case 'FieldDescriptorValue': {
        const descriptor = fieldDescriptorValue(input)
        return descriptor === undefined
          ? rejected('InvalidFieldDescriptor', 'field descriptor is unavailable', path)
          : admitted(descriptor)
      }
      case 'FieldCollectionValue': {
        const owner = typeDescriptorValue(input.owner)
        if (owner === undefined || !Array.isArray(input.fields))
          return rejected(
            'InvalidFieldCollection',
            'field collection owner or fields are unavailable',
            path,
          )
        const fields: Array<FieldDescriptorValue> = []
        const ordinals = new Set<number>()
        for (let index = 0; index < input.fields.length; index += 1) {
          const field = input.fields.at(index)
          const descriptor = fieldDescriptorValue(field)
          if (
            descriptor === undefined ||
            !sameTypeDescriptor(owner, descriptor.owner) ||
            ordinals.has(descriptor.declarationOrdinal)
          )
            return rejected(
              'InvalidFieldCollection',
              'fields must have the collection owner and unique declaration ordinals',
              [...path, index],
            )
          ordinals.add(descriptor.declarationOrdinal)
          fields.push(descriptor)
        }
        fields.sort((left, right) => left.declarationOrdinal - right.declarationOrdinal)
        return admitted({
          _tag: 'FieldCollectionValue',
          owner,
          fields: fields,
        })
      }
      case 'StaticSequenceValue': {
        const elementType = Type.fromUnknown(input.elementType)
        if (elementType === undefined || !Array.isArray(input.elements))
          return rejected(
            'InvalidStaticSequence',
            'static sequence element type or elements are unavailable',
            path,
          )
        const elements: Array<Value> = []
        for (let index = 0; index < input.elements.length; index += 1) {
          const nested = admissionAt(input.elements.at(index), options, [...path, index], active)
          if (nested._tag === 'Rejected') return nested
          elements.push(nested.value)
        }
        return admitted({
          _tag: 'StaticSequenceValue',
          elementType,
          elements: elements,
        })
      }
      case 'TestDescriptorValue': {
        const descriptor = testDescriptorValue(input)
        return descriptor === undefined
          ? rejected('InvalidTestDescriptor', 'test descriptor is unavailable', path)
          : admitted(descriptor)
      }
      case 'TestCollectionValue': {
        if (!Array.isArray(input.tests))
          return rejected('InvalidTestCollection', 'test collection is unavailable', path)
        const tests: Array<TestDescriptorValue> = []
        const declarations = new Set<string>()
        for (let index = 0; index < input.tests.length; index += 1) {
          const descriptor = testDescriptorValue(input.tests.at(index))
          const key =
            descriptor === undefined
              ? undefined
              : `${descriptor.declaration.module}:${descriptor.declaration.name}`
          if (descriptor === undefined || key === undefined || declarations.has(key))
            return rejected(
              'InvalidTestCollection',
              'tests must be compiler-issued unique descriptors',
              [...path, index],
            )
          declarations.add(key)
          tests.push(descriptor)
        }
        return admitted({ _tag: 'TestCollectionValue', tests: tests })
      }
      default:
        return rejected(
          'UnsupportedValue',
          `static evaluation does not admit ${String(input._tag)}`,
          path,
        )
    }
  })()
  active.delete(input)
  return result
}

/**
 * Rebuilds arbitrary candidate data as one canonical value, rejecting resources and identity.
 *
 * Runtime `Copy`, ownership, and cleanup are deliberately not consulted: admission describes only
 * the static evaluator's closed value domain.
 */
export const admit = (input: unknown, options: AdmissionOptions): Admission =>
  admissionAt(input, options, [], new WeakSet())

/** Constructs the canonical empty sequence for one concrete semantic element type. */
export const emptySequence = (elementType: Type.Type): StaticSequenceValue => ({
  _tag: 'StaticSequenceValue',
  elementType,
  elements: [],
})

/** Appends one admitted element without changing the original sequence. */
export const appendSequence = (
  self: StaticSequenceValue,
  elementType: Type.Type,
  element: Value,
): StaticSequenceValue | undefined =>
  !Type.equals(elementType, self.elementType)
    ? undefined
    : {
        _tag: 'StaticSequenceValue',
        elementType: self.elementType,
        elements: [...self.elements, element],
      }

/** Concatenates equal-element-type sequences without changing either input. */
export const concatenateSequences = (
  left: StaticSequenceValue,
  right: StaticSequenceValue,
): StaticSequenceValue | undefined =>
  !Type.equals(left.elementType, right.elementType)
    ? undefined
    : {
        _tag: 'StaticSequenceValue',
        elementType: left.elementType,
        elements: [...left.elements, ...right.elements],
      }

/** Returns the finite number of elements in one static sequence. */
export const sequenceLength = (self: StaticSequenceValue): number => self.elements.length

/** Reads one element without exposing mutation, storage, or an out-of-bounds sentinel value. */
export const sequenceElement = (self: StaticSequenceValue, index: number): Value | undefined =>
  Number.isSafeInteger(index) && index >= 0 ? self.elements.at(index) : undefined

/** Returns the exact phase-only nominal type bound by one reflected-field iteration. */
export const fieldDescriptorType = (self: FieldDescriptorValue): Type.Nominal =>
  Type.fieldDescriptor(self.owner.owner, self.valueType)

/** Returns the exact phase-only nominal type bound by one test-catalog iteration. */
export const testDescriptorType = (self: TestDescriptorValue): Type.Nominal =>
  Type.testDescriptor(self.callable)

const identityEncoding = (identity: AggregateIdentity): string =>
  identity._tag === 'ArrayAggregateIdentity'
    ? Canonical.record('ArrayAggregateIdentity', [identity.element, String(identity.length)])
    : Canonical.record('NominalAggregateIdentity', [
        identity.declaration.module,
        identity.declaration.name,
        Canonical.array(identity.typeArguments),
        identity.variant === undefined
          ? Canonical.record('NoVariant')
          : Canonical.record('Variant', [String(identity.variant.ordinal), identity.variant.name]),
      ])

const typeDescriptorEncoding = (self: TypeDescriptorValue): string =>
  Canonical.record('TypeDescriptorValue', [self.kind, Type.key(self.owner)])

const reflectedMemberEncoding = (self: ReflectedMember): string =>
  self._tag === 'LabeledField'
    ? Canonical.record('LabeledField', [self.label])
    : Canonical.record('PositionalField', [String(self.ordinal)])

const fieldDescriptorEncoding = (self: FieldDescriptorValue): string =>
  Canonical.record('FieldDescriptorValue', [
    typeDescriptorEncoding(self.owner),
    String(self.declarationOrdinal),
    reflectedMemberEncoding(self.member),
    Type.key(self.valueType),
    self.authorization.module,
    self.authorization.name,
    AuthoredIdentity.anchorKey(self.provenance.anchor),
  ])

/** Encodes one static value without host identity or ambiguous concatenation. */
export const encode = (self: Value): string => {
  switch (self._tag) {
    case 'UnitValue':
      return Canonical.record('UnitValue')
    case 'BooleanValue':
      return Canonical.record('BooleanValue', [self.value ? 'true' : 'false'])
    case 'CharacterValue':
      return Canonical.record('CharacterValue', [String(self.value)])
    case 'IntegerValue':
      return Canonical.record('IntegerValue', [self.type, self.value.toString()])
    case 'FloatValue':
      return Canonical.record('FloatValue', [self.type, self.bits.toString(16)])
    case 'EnumValue':
      return Canonical.record('EnumValue', [
        self.type.module,
        self.type.name,
        self.member,
        self.representation,
        self.discriminant.toString(),
      ])
    case 'TextValue':
      return Canonical.record('TextValue', [
        self.bytes.map((byte) => byte.toString(16).padStart(2, '0')).join(''),
      ])
    case 'AggregateValue':
      return Canonical.record('AggregateValue', [
        identityEncoding(self.identity),
        Canonical.array(
          self.fields.map((field) =>
            Canonical.record('Field', [String(field.ordinal), encode(field.value)]),
          ),
        ),
      ])
    case 'TypeDescriptorValue':
      return typeDescriptorEncoding(self)
    case 'FieldDescriptorValue':
      return fieldDescriptorEncoding(self)
    case 'FieldCollectionValue':
      return Canonical.record('FieldCollectionValue', [
        typeDescriptorEncoding(self.owner),
        Canonical.array(self.fields.map(fieldDescriptorEncoding)),
      ])
    case 'StaticSequenceValue':
      return Canonical.record('StaticSequenceValue', [
        Type.key(self.elementType),
        Canonical.array(self.elements.map(encode)),
      ])
    case 'TestDescriptorValue':
      return Canonical.record('TestDescriptorValue', [
        self.declaration.module,
        self.declaration.name,
        Type.key(self.callable),
        self.authorization,
      ])
    case 'TestCollectionValue':
      return Canonical.record('TestCollectionValue', [self.tests.map(encode).join('')])
  }
}

/** Returns the stable specialization-key component for one static value. */
export const key = encode

/** Tests static value equality without observing compiler object identity. */
export const equals = (left: Value, right: Value): boolean => key(left) === key(right)

const floatPresentation = (self: FloatValue): string => {
  const width = self.type === 'f32' ? 8 : 16
  return `${self.type}(bits=0x${self.bits.toString(16).padStart(width, '0')})`
}

const identityPresentation = (identity: AggregateIdentity): string => {
  if (identity._tag === 'ArrayAggregateIdentity')
    return `Array<${identity.element}, ${identity.length}>`
  const arguments_ =
    identity.typeArguments.length === 0 ? '' : `<${identity.typeArguments.join(', ')}>`
  const variant = identity.variant === undefined ? '' : `.${identity.variant.name}`
  return `${identity.declaration.module}.${identity.declaration.name}${arguments_}${variant}`
}

const typeDescriptorPresentation = (self: TypeDescriptorValue): string =>
  `type<${Type.encode(self.owner)}>(${self.kind})`

const reflectedMemberPresentation = (self: ReflectedMember): string =>
  self._tag === 'LabeledField' ? self.label : `#${self.ordinal}`

const fieldDescriptorPresentation = (self: FieldDescriptorValue): string =>
  `field<${Type.encode(self.owner.owner)}, ${Type.encode(self.valueType)}>(${reflectedMemberPresentation(self.member)}@${self.declarationOrdinal})`

/** Presents one value for deterministic semantic facts and static traces. */
export const presentation = (self: Value): string => {
  switch (self._tag) {
    case 'UnitValue':
      return '()'
    case 'BooleanValue':
      return self.value ? 'true' : 'false'
    case 'CharacterValue':
      return `char(U+${self.value.toString(16).toUpperCase().padStart(4, '0')})`
    case 'IntegerValue':
      return `${self.value.toString()}${self.type}`
    case 'FloatValue':
      return floatPresentation(self)
    case 'EnumValue':
      return `${self.type.module}.${self.type.name}.${self.member}`
    case 'TextValue':
      return JSON.stringify(new TextDecoder().decode(Uint8Array.from(self.bytes)))
    case 'AggregateValue':
      return `${identityPresentation(self.identity)} { ${self.fields
        .map((field) => `#${field.ordinal}: ${presentation(field.value)}`)
        .join(', ')} }`
    case 'TypeDescriptorValue':
      return typeDescriptorPresentation(self)
    case 'FieldDescriptorValue':
      return fieldDescriptorPresentation(self)
    case 'FieldCollectionValue':
      return `fields<${Type.encode(self.owner.owner)}>[${self.fields
        .map(fieldDescriptorPresentation)
        .join(', ')}]`
    case 'StaticSequenceValue':
      return `sequence<${Type.encode(self.elementType)}>[${self.elements.map(presentation).join(', ')}]`
    case 'TestDescriptorValue':
      return `test<${Type.encode(self.callable)}>(${self.declaration.module}.${self.declaration.name})`
    case 'TestCollectionValue':
      return `tests[${self.tests.map(presentation).join(', ')}]`
  }
}

const textEncoder = new TextEncoder()

/** Counts retained canonical bytes for deterministic static-evaluation budgeting. */
export const retainedSize = (self: Value): number => textEncoder.encode(encode(self)).byteLength
