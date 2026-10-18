import type * as Target from './Target.js'
/** The closed lowercase integer vocabulary admitted by the bootstrap compiler. */
export type IntegerSpelling =
  | 'u8'
  | 'u16'
  | 'u32'
  | 'u64'
  | 'usize'
  | 'i8'
  | 'i16'
  | 'i32'
  | 'i64'
  | 'isize'

export type EnumRepresentationSpelling = 'u8' | 'u16' | 'u32' | 'u64' | 'i8' | 'i16' | 'i32' | 'i64'

export type FloatSpelling = 'f32' | 'f64'

/** The spelling of the scalar that holds one Unicode scalar value. */
export type CharacterSpelling = 'char'

/** Every compiler-known scalar spelling, including the canonical Boolean. */
export type Spelling = 'bool' | CharacterSpelling | IntegerSpelling | FloatSpelling

export type FixedBits = 8 | 16 | 32 | 64
export type ByteWidth = 1 | 2 | 4 | 8

/** Whether a scalar width is fixed by its identity or selected by the compilation target. */
export type Width =
  | { readonly _tag: 'FixedWidth'; readonly bits: FixedBits }
  | { readonly _tag: 'PointerWidth' }

/** The backend-neutral operation code used by scalar intrinsic contracts. */
export type OperationCode =
  | 'Add'
  | 'Subtract'
  | 'Multiply'
  | 'Divide'
  | 'Remainder'
  | 'Negate'
  | 'Equals'
  | 'NotEquals'
  | 'LessThan'
  | 'LessOrEqual'
  | 'GreaterThan'
  | 'GreaterOrEqual'
  | 'BitAnd'
  | 'BitOr'
  | 'BitXor'
  | 'BitNot'
  | 'ShiftLeft'
  | 'ShiftRight'
  | 'RotateLeft'
  | 'RotateRight'
  | 'WrappingAdd'
  | 'WrappingSubtract'
  | 'WrappingMultiply'
  | 'WrappingNegate'
  | 'SaturatingAdd'
  | 'SaturatingSubtract'
  | 'SaturatingMultiply'
  | 'SaturatingNegate'
  | 'CheckedAdd'
  | 'CheckedSubtract'
  | 'CheckedMultiply'
  | 'CheckedDivide'
  | 'CheckedRemainder'
  | 'IsNaN'
  | 'IsInfinite'
  | 'IsFinite'
  | 'IsNormal'
  | 'IsSubnormal'
  | 'IsSignNegative'
  | 'TotalOrder'
  | 'ToBits'
  | 'FromBits'
  | 'Sqrt'
  | 'Sin'
  | 'Cos'
  | ConversionOperationCode
  | CheckedConversionOperationCode
  | 'Not'

export type ConversionOperationCode =
  | 'ConvertToU8'
  | 'ConvertToU16'
  | 'ConvertToU32'
  | 'ConvertToU64'
  | 'ConvertToUsize'
  | 'ConvertToI8'
  | 'ConvertToI16'
  | 'ConvertToI32'
  | 'ConvertToI64'
  | 'ConvertToIsize'
  | 'ConvertToF32'
  | 'ConvertToF64'

export type CheckedConversionOperationCode =
  | 'CheckedConvertToU8'
  | 'CheckedConvertToU16'
  | 'CheckedConvertToU32'
  | 'CheckedConvertToU64'
  | 'CheckedConvertToUsize'
  | 'CheckedConvertToI8'
  | 'CheckedConvertToI16'
  | 'CheckedConvertToI32'
  | 'CheckedConvertToI64'
  | 'CheckedConvertToIsize'
  | 'CheckedConvertToChar'

/** One operation declared by a scalar actor. */
export interface Operation {
  readonly spelling: string
  readonly code: OperationCode
  readonly arity: 1 | 2
  readonly result: 'Self' | 'Boolean' | 'OptionSelf' | 'OptionTarget' | Spelling
  readonly parameters?: ReadonlyArray<Spelling>
}

/** One immutable integer entry in the authoritative scalar catalog. */
export interface IntegerScalar {
  readonly spelling: IntegerSpelling
  readonly category: 'Integer'
  readonly width: Width
  readonly signedness: 'Signed' | 'Unsigned'
  readonly operations: ReadonlyArray<Operation>
}

/** One fixed-width integer representation admitted by scalar enum declarations. */
export type EnumRepresentation = IntegerScalar & {
  readonly spelling: EnumRepresentationSpelling
}

/** The immutable Boolean entry in the authoritative scalar catalog. */
export interface BooleanScalar {
  readonly spelling: 'bool'
  readonly category: 'Boolean'
  readonly width: Extract<Width, { readonly _tag: 'FixedWidth' }>
  readonly signedness: undefined
  readonly operations: ReadonlyArray<Operation>
}

export interface FloatScalar {
  readonly spelling: FloatSpelling
  readonly category: 'Floating'
  readonly width: Extract<Width, { readonly _tag: 'FixedWidth' }>
  readonly signedness: undefined
  readonly operations: ReadonlyArray<Operation>
}

/**
 * The immutable Unicode scalar entry in the authoritative scalar catalog.
 *
 * `char` is its own category rather than an integer, because every `category === 'Integer'`
 * guard in the compiler admits arithmetic and the checked and unchecked integer conversions.
 * A Unicode scalar value admits neither: arithmetic can leave the valid range, and a
 * conversion in either direction must be written out in source.
 */
export interface CharacterScalar {
  readonly spelling: CharacterSpelling
  readonly category: 'Character'
  readonly width: Extract<Width, { readonly _tag: 'FixedWidth' }>
  readonly signedness: undefined
  readonly operations: ReadonlyArray<Operation>
}

/** One immutable source of truth for a compiler-known scalar. */
export type Scalar = IntegerScalar | FloatScalar | BooleanScalar | CharacterScalar

const fixedWidth = (bits: FixedBits): Extract<Width, { readonly _tag: 'FixedWidth' }> => ({
  _tag: 'FixedWidth',
  bits,
})

const pointerWidth: Extract<Width, { readonly _tag: 'PointerWidth' }> = {
  _tag: 'PointerWidth',
}

const operation = (
  spelling: string,
  code: OperationCode,
  arity: Operation['arity'],
  result: Operation['result'],
  parameters?: ReadonlyArray<Spelling>,
): Operation => ({
  spelling,
  code,
  arity,
  result,
  ...(parameters === undefined ? {} : { parameters }),
})

const equalityOperations = [
  operation('equals', 'Equals', 2, 'Boolean'),
  operation('notEquals', 'NotEquals', 2, 'Boolean'),
]

const integerSpellings: ReadonlyArray<IntegerSpelling> = [
  'u8',
  'u16',
  'u32',
  'u64',
  'usize',
  'i8',
  'i16',
  'i32',
  'i64',
  'isize',
]

const conversionName = (target: IntegerSpelling): string =>
  `to${target[0]?.toUpperCase() ?? ''}${target.slice(1)}`

const conversionCode = (target: IntegerSpelling): ConversionOperationCode => {
  switch (target) {
    case 'u8':
      return 'ConvertToU8'
    case 'u16':
      return 'ConvertToU16'
    case 'u32':
      return 'ConvertToU32'
    case 'u64':
      return 'ConvertToU64'
    case 'usize':
      return 'ConvertToUsize'
    case 'i8':
      return 'ConvertToI8'
    case 'i16':
      return 'ConvertToI16'
    case 'i32':
      return 'ConvertToI32'
    case 'i64':
      return 'ConvertToI64'
    case 'isize':
      return 'ConvertToIsize'
  }
}

const conversionOperations = integerSpellings.flatMap((target) => [
  operation(conversionName(target), conversionCode(target), 1, target),
  operation(
    `checked${conversionName(target)[0]?.toUpperCase() ?? ''}${conversionName(target).slice(1)}`,
    `Checked${conversionCode(target)}` as CheckedConversionOperationCode,
    1,
    'OptionTarget',
  ),
])

const integerToFloatOperations = [
  operation('toF32', 'ConvertToF32', 1, 'f32'),
  operation('toF64', 'ConvertToF64', 1, 'f64'),
]

const comparisonOperations = [
  ...equalityOperations,
  operation('lessThan', 'LessThan', 2, 'Boolean'),
  operation('lessOrEqual', 'LessOrEqual', 2, 'Boolean'),
  operation('greaterThan', 'GreaterThan', 2, 'Boolean'),
  operation('greaterOrEqual', 'GreaterOrEqual', 2, 'Boolean'),
]

const arithmeticOperations = [
  operation('add', 'Add', 2, 'Self'),
  operation('subtract', 'Subtract', 2, 'Self'),
  operation('multiply', 'Multiply', 2, 'Self'),
  operation('divide', 'Divide', 2, 'Self'),
  operation('remainder', 'Remainder', 2, 'Self'),
  operation('bitAnd', 'BitAnd', 2, 'Self'),
  operation('bitOr', 'BitOr', 2, 'Self'),
  operation('bitXor', 'BitXor', 2, 'Self'),
  operation('bitNot', 'BitNot', 1, 'Self'),
  operation('shiftLeft', 'ShiftLeft', 2, 'Self'),
  operation('shiftRight', 'ShiftRight', 2, 'Self'),
  operation('rotateLeft', 'RotateLeft', 2, 'Self'),
  operation('rotateRight', 'RotateRight', 2, 'Self'),
  operation('wrappingAdd', 'WrappingAdd', 2, 'Self'),
  operation('wrappingSubtract', 'WrappingSubtract', 2, 'Self'),
  operation('wrappingMultiply', 'WrappingMultiply', 2, 'Self'),
  operation('saturatingAdd', 'SaturatingAdd', 2, 'Self'),
  operation('saturatingSubtract', 'SaturatingSubtract', 2, 'Self'),
  operation('saturatingMultiply', 'SaturatingMultiply', 2, 'Self'),
  operation('checkedAdd', 'CheckedAdd', 2, 'OptionSelf'),
  operation('checkedSubtract', 'CheckedSubtract', 2, 'OptionSelf'),
  operation('checkedMultiply', 'CheckedMultiply', 2, 'OptionSelf'),
  operation('checkedDivide', 'CheckedDivide', 2, 'OptionSelf'),
  operation('checkedRemainder', 'CheckedRemainder', 2, 'OptionSelf'),
  ...comparisonOperations,
]

const integer = <const S extends IntegerSpelling>(
  spelling: S,
  signedness: IntegerScalar['signedness'],
  width: Width,
): IntegerScalar & { readonly spelling: S } => ({
  spelling,
  category: 'Integer',
  width,
  signedness,
  operations:
    signedness === 'Signed'
      ? [
          operation('negate', 'Negate', 1, 'Self'),
          operation('wrappingNegate', 'WrappingNegate', 1, 'Self'),
          operation('saturatingNegate', 'SaturatingNegate', 1, 'Self'),
          ...conversionOperations,
          ...integerToFloatOperations,
          ...arithmeticOperations,
        ]
      : [...conversionOperations, ...integerToFloatOperations, ...arithmeticOperations],
})

const u8 = integer('u8', 'Unsigned', fixedWidth(8))
const u16 = integer('u16', 'Unsigned', fixedWidth(16))
const u32 = integer('u32', 'Unsigned', fixedWidth(32))
const u64 = integer('u64', 'Unsigned', fixedWidth(64))

/** The target-sized unsigned integer used by addresses and allocation contracts. */
export const pointerInteger = integer('usize', 'Unsigned', pointerWidth)

const i8 = integer('i8', 'Signed', fixedWidth(8))
const i16 = integer('i16', 'Signed', fixedWidth(16))

/** The default integer selected for an unconstrained integer expression. */
export const defaultInteger = integer('i32', 'Signed', fixedWidth(32))

const i64 = integer('i64', 'Signed', fixedWidth(64))
const isize = integer('isize', 'Signed', pointerWidth)

const enumRepresentationCatalog: ReadonlyArray<EnumRepresentation> = [
  u8,
  u16,
  u32,
  u64,
  i8,
  i16,
  defaultInteger,
  i64,
]

const enumRepresentationsBySpelling: ReadonlyMap<string, EnumRepresentation> = new Map(
  enumRepresentationCatalog.map((scalar): readonly [string, EnumRepresentation] => [
    scalar.spelling,
    scalar,
  ]),
)

/** Returns the exact fixed-width integer representation selected by an enum spelling. */
export const enumRepresentation = (spelling: string): EnumRepresentation | undefined =>
  enumRepresentationsBySpelling.get(spelling)

/** Returns every allowed enum representation in deterministic unsigned-then-signed width order. */
export const enumRepresentations = (): ReadonlyArray<EnumRepresentation> =>
  enumRepresentationCatalog

/** The exact representation selected when an enum omits its representation clause. */
export const defaultEnumRepresentation: EnumRepresentation = u8

const floatOperations = (self: FloatSpelling, bitsType: 'u32' | 'u64') => [
  operation('negate', 'Negate', 1, 'Self'),
  operation('add', 'Add', 2, 'Self'),
  operation('subtract', 'Subtract', 2, 'Self'),
  operation('multiply', 'Multiply', 2, 'Self'),
  operation('divide', 'Divide', 2, 'Self'),
  operation('remainder', 'Remainder', 2, 'Self'),
  ...comparisonOperations,
  operation('isNaN', 'IsNaN', 1, 'Boolean'),
  operation('isInfinite', 'IsInfinite', 1, 'Boolean'),
  operation('isFinite', 'IsFinite', 1, 'Boolean'),
  operation('isNormal', 'IsNormal', 1, 'Boolean'),
  operation('isSubnormal', 'IsSubnormal', 1, 'Boolean'),
  operation('isSignNegative', 'IsSignNegative', 1, 'Boolean'),
  operation('totalOrder', 'TotalOrder', 2, 'Boolean'),
  operation('toBits', 'ToBits', 1, bitsType),
  operation('fromBits', 'FromBits', 1, self, [bitsType]),
  operation('sqrt', 'Sqrt', 1, 'Self'),
  operation('sin', 'Sin', 1, 'Self'),
  operation('cos', 'Cos', 1, 'Self'),
  operation('toF32', 'ConvertToF32', 1, 'f32'),
  operation('toF64', 'ConvertToF64', 1, 'f64'),
  ...integerSpellings.map((target) =>
    operation(conversionName(target), conversionCode(target), 1, target),
  ),
]

const floating = <const S extends FloatSpelling>(
  spelling: S,
  bits: 32 | 64,
  bitsType: 'u32' | 'u64',
): FloatScalar & { readonly spelling: S } => ({
  spelling,
  category: 'Floating',
  width: fixedWidth(bits),
  signedness: undefined,

  operations: floatOperations(spelling, bitsType),
})

export const f32 = floating('f32', 32, 'u32')
/** The default float selected for an unconstrained floating expression. */
export const defaultFloat = floating('f64', 64, 'u64')

/** The canonical Boolean scalar. */
export const boolean: BooleanScalar = {
  spelling: 'bool',
  category: 'Boolean',
  width: fixedWidth(32),
  signedness: undefined,

  operations: [...equalityOperations, operation('not', 'Not', 1, 'Self')],
}

/**
 * The canonical Unicode scalar value.
 *
 * The value occupies exactly 32 bits so that it never moves a field or changes an ABI relative
 * to the `u32` a decoder produces today, and it orders by Unicode scalar value, which for the
 * range `0` to `0x10ffff` is exactly the unsigned 32-bit order.
 *
 * The catalog states equality, ordering, and the two explicit `u32` conversions. Arithmetic is
 * absent by design:
 * `char` names a value inside a fixed range that excludes the surrogates `0xd800` to `0xdfff`,
 * and every arithmetic operation can leave that range.
 */
export const character: CharacterScalar = {
  spelling: 'char',
  category: 'Character',
  width: fixedWidth(32),
  signedness: undefined,

  operations: [
    operation('fromU32', 'CheckedConvertToChar', 1, 'OptionTarget', ['u32']),
    operation('toU32', 'ConvertToU32', 1, 'u32'),
    ...comparisonOperations,
  ],
}

const catalog: ReadonlyArray<Scalar> = [
  boolean,
  u8,
  u16,
  u32,
  u64,
  pointerInteger,
  i8,
  i16,
  defaultInteger,
  i64,
  isize,
  f32,
  defaultFloat,
  character,
]

const scalarsBySpelling: ReadonlyMap<string, Scalar> = new Map(
  catalog.map((scalar): readonly [string, Scalar] => [scalar.spelling, scalar]),
)

/** Returns every scalar in stable source-presentation order. */
export const all = (): ReadonlyArray<Scalar> => catalog

/** Returns every integer in stable source-presentation order. */
export const integers = (): ReadonlyArray<IntegerScalar> =>
  catalog.filter((candidate): candidate is IntegerScalar => candidate.category === 'Integer')

export const floats = (): ReadonlyArray<FloatScalar> =>
  catalog.filter((candidate): candidate is FloatScalar => candidate.category === 'Floating')

/** Finds a scalar by its accepted source spelling. */
export const find = (spelling: string): Scalar | undefined => scalarsBySpelling.get(spelling)

/** Tests whether an unknown value is an accepted scalar spelling. */
export const isSpelling = (value: unknown): value is Spelling =>
  typeof value === 'string' && find(value) !== undefined

/** Tests whether an unknown value is an accepted integer spelling. */
export const isIntegerSpelling = (value: unknown): value is IntegerSpelling =>
  typeof value === 'string' && find(value)?.category === 'Integer'

export const isFloatSpelling = (value: unknown): value is FloatSpelling =>
  typeof value === 'string' && find(value)?.category === 'Floating'

/** Tests whether an unknown value is the accepted Unicode scalar spelling. */
export const isCharacterSpelling = (value: unknown): value is CharacterSpelling =>
  typeof value === 'string' && find(value)?.category === 'Character'

/** Resolves the destination of one explicit integer conversion operation. */
export const conversionTarget = (operation: string): IntegerScalar | undefined => {
  let prefix: string | undefined
  if (operation.startsWith('CheckedConvertTo')) {
    prefix = 'CheckedConvertTo'
  } else if (operation.startsWith('ConvertTo')) {
    prefix = 'ConvertTo'
  } else {
    prefix = undefined
  }
  if (prefix === undefined) return undefined
  const suffix = operation.slice(prefix.length)
  const spelling = `${suffix[0]?.toLowerCase() ?? ''}${suffix.slice(1)}`
  const target = find(spelling)
  return target?.category === 'Integer' ? target : undefined
}

export const floatConversionTarget = (operation: string): FloatScalar | undefined => {
  let spelling: Spelling | undefined
  if (operation === 'ConvertToF32') {
    spelling = 'f32'
  } else if (operation === 'ConvertToF64') {
    spelling = 'f64'
  } else {
    spelling = undefined
  }
  const target = spelling === undefined ? undefined : find(spelling)
  return target?.category === 'Floating' ? target : undefined
}

/** Tests whether an integer operation returns the canonical recoverable Option outcome. */
export const isCheckedOperation = (operation: string): boolean => operation.startsWith('Checked')

/** Tests whether one mathematical integer names a valid Unicode scalar value. */
export const isUnicodeScalarValue = (value: bigint): boolean =>
  value >= 0n && value <= 0x10ffffn && (value < 0xd800n || value > 0xdfffn)

/** Resolves the scalar's logical width for one target pointer width. */
export const bits = (self: Scalar, pointerBits: 32 | 64): FixedBits =>
  self.width._tag === 'PointerWidth' ? pointerBits : self.width.bits

/** Resolves physical storage exclusively from one audited target description. */
export const resolveLayout = (self: Scalar, target: Target.Target): Target.Primitive => {
  if (self.category === 'Boolean') return target.primitives.bool
  if (self.category === 'Character') return target.primitives.i32
  if (self.width._tag === 'PointerWidth')
    return { size: target.pointerSize, alignment: target.pointerAlignment }
  if (self.category === 'Floating')
    return self.width.bits === 32 ? target.primitives.f32 : target.primitives.f64
  switch (self.width.bits) {
    case 8:
      return target.primitives.i8
    case 16:
      return target.primitives.i16
    case 32:
      return target.primitives.i32
    case 64:
      return target.primitives.i64
  }
}

/** Returns the inclusive exact range of one integer for a selected target. */
export const range = (
  self: IntegerScalar,
  pointerBits: 32 | 64,
): { readonly minimum: bigint; readonly maximum: bigint } => {
  const width = BigInt(bits(self, pointerBits))
  return self.signedness === 'Signed'
    ? { minimum: -(1n << (width - 1n)), maximum: (1n << (width - 1n)) - 1n }
    : { minimum: 0n, maximum: (1n << width) - 1n }
}
