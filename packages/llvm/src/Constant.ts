import * as Effect from 'effect/Effect'
import * as Result from 'effect/Result'
import type * as Builder from './Builder.js'
import * as ByteString from './ByteString.js'
import * as FunctionActor from './Function.js'
import type * as Global from './Global.js'
import * as BuilderState from './internal/BuilderState.js'
import * as CanonicalKey from './internal/CanonicalKey.js'
import type * as ConstantDescription from './internal/ConstantDescription.js'
import * as GlobalState from './internal/GlobalState.js'
import * as Handle from './internal/Handle.js'
import * as IntegerInput from './internal/IntegerInput.js'
import type * as OwnedHandle from './internal/OwnedHandle.js'
import * as Table from './internal/Table.js'
import type * as TypeDescription from './internal/TypeDescription.js'
import { invalidInput, type LlvmError } from './LlvmError.js'
import * as Type from './Type.js'

/**
 * Opaque builder-owned identity for a structurally interned LLVM constant or constant expression.
 *
 * @category constants
 * @since 0.0.0
 */
export interface Constant extends Handle.Handle<'Constant'> {}

/**
 * Exact LLVM floating-point storage formats accepted by {@link floatingRaw}.
 *
 * @category constants
 * @since 0.0.0
 */
export type FloatFormat = ConstantDescription.FloatFormat
/**
 * Cast operations supported by constant expressions.
 *
 * @category constants
 * @since 0.0.0
 */
export type CastKind = ConstantDescription.CastKind
/**
 * Integer binary operations supported by constant expressions.
 *
 * @category constants
 * @since 0.0.0
 */
export type BinaryKind = ConstantDescription.BinaryKind

/**
 * Semantic flags carried by an inline-assembly constant.
 *
 * @category constants
 * @since 0.0.0
 */
export interface AssemblyOptions {
  readonly sideEffect?: boolean
  readonly alignStack?: boolean
  readonly intelDialect?: boolean
  readonly canThrow?: boolean
}

/** @internal */
const descriptionKey = (description: ConstantDescription.Description): string => {
  const type = CanonicalKey.integer(description.type)
  switch (description._tag) {
    case 'Global':
      return CanonicalKey.tagged('global', [type, CanonicalKey.integer(description.global)])
    case 'Integer':
      return CanonicalKey.tagged('integer', [
        type,
        CanonicalKey.integer(description.bitPattern),
        description.signed ? '1' : '0',
      ])
    case 'Float':
      return CanonicalKey.tagged('float', [
        type,
        description.format,
        CanonicalKey.bytes(description.bits),
      ])
    case 'Special':
      return CanonicalKey.tagged('special', [type, description.kind])
    case 'Aggregate':
      return CanonicalKey.tagged('aggregate', [
        type,
        description.kind,
        CanonicalKey.sequence(description.elements.map(CanonicalKey.integer)),
      ])
    case 'String':
      return CanonicalKey.tagged('string', [type, CanonicalKey.bytes(description.bytes)])
    case 'Splat':
      return CanonicalKey.tagged('splat', [type, CanonicalKey.integer(description.value)])
    case 'BlockAddress':
      return CanonicalKey.tagged('blockaddress', [
        type,
        CanonicalKey.integer(description.function),
        CanonicalKey.integer(description.block),
      ])
    case 'FunctionReference':
      return CanonicalKey.tagged(description.kind, [
        type,
        CanonicalKey.integer(description.function),
      ])
    case 'Cast':
      return CanonicalKey.tagged('cast', [
        type,
        description.kind,
        CanonicalKey.integer(description.value),
      ])
    case 'Binary':
      return CanonicalKey.tagged('binary', [
        type,
        description.kind,
        CanonicalKey.integer(description.left),
        CanonicalKey.integer(description.right),
      ])
    case 'GetElementPtr':
      return CanonicalKey.tagged('getelementptr', [
        type,
        CanonicalKey.integer(description.sourceType),
        CanonicalKey.integer(description.base),
        CanonicalKey.sequence(description.indices.map(CanonicalKey.integer)),
        description.inbounds ? '1' : '0',
        description.inrange === undefined ? 'none' : CanonicalKey.integer(description.inrange),
      ])
    case 'Assembly':
      return CanonicalKey.tagged('assembly', [
        type,
        CanonicalKey.bytes(description.assembly),
        CanonicalKey.bytes(description.constraints),
        description.sideEffect ? '1' : '0',
        description.alignStack ? '1' : '0',
        description.intelDialect ? '1' : '0',
        description.canThrow ? '1' : '0',
      ])
  }
}

/**
 * Plain transition rather than a generator: native emission interns on nearly every instruction.
 *
 * @internal
 */
const intern = (
  builder: Builder.Builder,
  description: ConstantDescription.Description,
): Effect.Effect<Constant, LlvmError> =>
  BuilderState.transition(builder, 'Constant.intern', (context) => internIn(context, description))

/** Interns a validated description inside a running builder transition. @internal */
export const internIn = (
  context: BuilderState.Context,
  description: ConstantDescription.Description,
): Result.Result<Constant, LlvmError> =>
  Table.intern(
    context.state.constants,
    'Constant.intern',
    'Constant',
    descriptionKey(description),
    description,
    (index) => Handle.make('Constant', context.owner, index),
  )

/**
 * Native emission requests an integer constant on most instructions, overwhelmingly repeats of a
 * few values, so validated requests are cached per builder by type, signedness, and input value
 * in front of the canonical constant table. The transition is plain synchronous code rather than
 * nested generators for the same reason.
 *
 * @internal
 */
const integerOf = (
  builder: Builder.Builder,
  type: Type.Type,
  value: number | bigint,
  signed: boolean,
): Effect.Effect<Constant, LlvmError> =>
  BuilderState.transition(builder, 'Constant.integer', (context) =>
    integerOfIn(context, type, value, signed),
  )

/**
 * Normalizes, validates, and interns an integer constant inside a running builder transition.
 *
 * @internal
 */
export const integerOfIn = (
  context: BuilderState.Context,
  type: Type.Type,
  value: number | bigint,
  signed: boolean,
): Result.Result<Constant, LlvmError> => {
  const exact = IntegerInput.normalize(value, {
    operation: signed ? 'Constant.integerSigned' : 'Constant.integerUnsigned',
    message: 'LLVM integer constants require finite safe integers or bigints',
  })
  if (Result.isFailure(exact)) return Result.fail(exact.failure)
  const typeIndex = Handle.resolve(context.builder, context.owner, type, 'Type', 'Constant.integer')
  if (Result.isFailure(typeIndex)) return Result.fail(typeIndex.failure)
  return integerIn(context.state, context.owner, typeIndex.success, exact.success, signed, type)
}

/**
 * Validates and interns an integer constant inside a running builder transition.
 *
 * @internal
 */
export const integerIn = (
  state: BuilderState.MutableState,
  owner: OwnedHandle.Owner,
  typeIndex: number,
  value: bigint,
  signed: boolean,
  type: unknown,
): Result.Result<Constant, LlvmError> => {
  const cacheKey = typeIndex * 2 + (signed ? 1 : 0)
  const cached = state.integerConstants.get(cacheKey)?.get(value)
  if (cached !== undefined) return Result.succeed(cached)
  const typeValue = Table.descriptionAt(state.types, typeIndex, 'Constant.integer', 'Type')
  if (Result.isFailure(typeValue)) return Result.fail(typeValue.failure)
  const bitWidth = typeValue.success._tag === 'Integer' ? typeValue.success.bitWidth : undefined
  if (bitWidth === undefined) {
    return Result.fail(
      invalidInput({
        operation: 'Constant.integer',
        message: 'Integer constants require an integer type',
        input: type,
      }),
    )
  }
  const modulus = 1n << BigInt(bitWidth)
  const minimum = signed ? -(1n << BigInt(bitWidth - 1)) : 0n
  const maximum = signed ? (1n << BigInt(bitWidth - 1)) - 1n : modulus - 1n
  if (value < minimum || value > maximum) {
    return Result.fail(
      invalidInput({
        operation: 'Constant.integer',
        message: `Integer value does not fit i${bitWidth}`,
        input: value,
      }),
    )
  }
  const description: ConstantDescription.Description = {
    _tag: 'Integer',
    type: typeIndex,
    bitPattern: value < 0n ? modulus + value : value,
    signed,
  }
  const interned = Table.intern(
    state.constants,
    'Constant.intern',
    'Constant',
    descriptionKey(description),
    description,
    (index) => Handle.make('Constant', owner, index),
  )
  if (Result.isSuccess(interned)) {
    const values = state.integerConstants.get(cacheKey)
    if (values === undefined)
      state.integerConstants.set(cacheKey, new Map([[value, interned.success]]))
    else values.set(value, interned.success)
  }
  return interned
}

/**
 * Interns a non-negative arbitrary-width integer after checking it fits the declared integer type.
 *
 * **Gotchas**
 *
 * Use `bigint` for values outside JavaScript's safe integer range; no precision is discarded.
 *
 * **Example** (Interning a wide integer)
 *
 * ```ts
 * import * as Effect from 'effect/Effect'
 * import * as Builder from '@silklang/llvm/Builder'
 * import * as Constant from '@silklang/llvm/Constant'
 * import * as Type from '@silklang/llvm/Type'
 *
 * const bits = await Effect.runPromise(Effect.gen(function* () {
 *   const builder = yield* Builder.make()
 *   const i129 = yield* Type.integer(builder, 129)
 *   const value = yield* Constant.integerUnsigned(builder, i129, (1n << 128n) + 1n)
 *   return yield* Constant.integerBitPattern(builder, value)
 * }))
 * ```
 *
 * @category constants
 * @since 0.0.0
 */
export const integerUnsigned = (
  builder: Builder.Builder,
  type: Type.Type,
  value: number | bigint,
): Effect.Effect<Constant, LlvmError> => integerOf(builder, type, value, false)

/**
 * Interns the opaque pointer constant that refers to a module global.
 *
 * @category constants
 * @since 0.0.0
 */
export const fromGlobal = (
  builder: Builder.Builder,
  global: Global.Global,
): Effect.Effect<Constant, LlvmError> =>
  BuilderState.transition(builder, 'Constant.fromGlobal', (context) =>
    fromGlobalIn(context, global),
  )

/**
 * Interns a global's address constant inside a running builder transition.
 *
 * @internal
 */
export const fromGlobalIn = (
  context: BuilderState.Context,
  global: Global.Global,
): Result.Result<Constant, LlvmError> => {
  const { builder, state, owner } = context
  const resolved = GlobalState.resolve(builder, state, owner, global, 'Constant.fromGlobal')
  if (Result.isFailure(resolved)) return Result.fail(resolved.failure)
  const description: ConstantDescription.Description = {
    _tag: 'Global',
    type: Type.internIndex(state, owner, {
      _tag: 'Pointer',
      addressSpace: resolved.success.description.addressSpace,
    }),
    global: resolved.success.index,
  }
  return Table.intern(
    state.constants,
    'Constant.intern',
    'Constant',
    descriptionKey(description),
    description,
    (index) => Handle.make('Constant', owner, index),
  )
}

/**
 * Interns a signed arbitrary-width integer and stores its exact two's-complement bit pattern.
 *
 * @category constants
 * @since 0.0.0
 */
export const integerSigned = (
  builder: Builder.Builder,
  type: Type.Type,
  value: number | bigint,
): Effect.Effect<Constant, LlvmError> => integerOf(builder, type, value, true)

const formatTypeTag: Record<FloatFormat, TypeDescription.SimpleTag> = {
  half: 'Half',
  bfloat: 'BFloat',
  float: 'Float',
  double: 'Double',
  x86_fp80: 'X86Fp80',
  fp128: 'Fp128',
  ppc_fp128: 'PpcFp128',
}

const formatBytes: Record<FloatFormat, number> = {
  half: 2,
  bfloat: 2,
  float: 4,
  double: 8,
  x86_fp80: 10,
  fp128: 16,
  ppc_fp128: 16,
}

/**
 * Interns byte-exact floating-point bits without JavaScript number conversion.
 *
 * **When to use**
 *
 * Use when you need NaN payloads, infinities with specific encodings, or formats JavaScript cannot
 * represent.
 *
 * **Gotchas**
 *
 * The format, type, and exact byte length must agree.
 *
 * **Example** (Preserving a NaN payload)
 *
 * ```ts
 * import * as Effect from 'effect/Effect'
 * import * as Builder from '@silklang/llvm/Builder'
 * import * as Constant from '@silklang/llvm/Constant'
 * import * as Type from '@silklang/llvm/Type'
 *
 * const nan = await Effect.runPromise(Effect.gen(function* () {
 *   const builder = yield* Builder.make()
 *   const type = yield* Type.double(builder)
 *   return yield* Constant.floatingRaw(
 *     builder,
 *     type,
 *     'double',
 *     Uint8Array.of(1, 0, 0, 0, 0, 0, 0xF8, 0x7F),
 *   )
 * }))
 * ```
 *
 * @category constants
 * @since 0.0.0
 */
export const floatingRaw = (
  builder: Builder.Builder,
  type: Type.Type,
  format: FloatFormat,
  bits: ByteString.ByteString | Uint8Array,
): Effect.Effect<Constant, LlvmError> =>
  BuilderState.transition(builder, 'Constant.floatingRaw', (context) =>
    floatingRawIn(context, type, format, bits),
  )

/** @internal */
export const floatingRawIn = (
  context: BuilderState.Context,
  type: Type.Type,
  format: FloatFormat,
  bits: ByteString.ByteString | Uint8Array,
): Result.Result<Constant, LlvmError> => {
  const value = bits instanceof Uint8Array ? ByteString.fromUint8Array(bits) : bits
  const typeIndex = Handle.resolve(
    context.builder,
    context.owner,
    type,
    'Type',
    'Constant.floatingRaw',
  )
  if (Result.isFailure(typeIndex)) return Result.fail(typeIndex.failure)
  const typeValue = Table.descriptionAt(
    context.state.types,
    typeIndex.success,
    'Constant.floatingRaw',
    'Type',
  )
  if (Result.isFailure(typeValue)) return Result.fail(typeValue.failure)
  if (typeValue.success._tag !== 'Simple' || typeValue.success.tag !== formatTypeTag[format]) {
    return Result.fail(
      invalidInput({
        operation: 'Constant.floatingRaw',
        message: `Raw ${format} bits require the matching LLVM floating type`,
        input: type,
      }),
    )
  }
  if (value.bytes.length !== formatBytes[format]) {
    return Result.fail(
      invalidInput({
        operation: 'Constant.floatingRaw',
        message: `${format} requires exactly ${formatBytes[format]} bytes`,
        input: bits,
      }),
    )
  }
  return internIn(context, { _tag: 'Float', type: typeIndex.success, format, bits: value })
}

/**
 * Convenience constructor for a raw 16-bit IEEE `half` payload.
 *
 * @category constants
 * @since 0.0.0
 */
export const halfBits = Effect.fnUntraced(function* (
  builder: Builder.Builder,
  type: Type.Type,
  bits: number,
) {
  return yield* floatingRaw(builder, type, 'half', Uint8Array.of(bits & 0xff, (bits >>> 8) & 0xff))
})

/**
 * Convenience constructor for a raw 16-bit `bfloat` payload.
 *
 * @category constants
 * @since 0.0.0
 */
export const bfloatBits = Effect.fnUntraced(function* (
  builder: Builder.Builder,
  type: Type.Type,
  bits: number,
) {
  return yield* floatingRaw(
    builder,
    type,
    'bfloat',
    Uint8Array.of(bits & 0xff, (bits >>> 8) & 0xff),
  )
})

/** @internal */
/** @internal */
export const numberBytes = (value: number, byteLength: 4 | 8): Uint8Array => {
  const result = new Uint8Array(byteLength)
  const view = new DataView(result.buffer)
  if (byteLength === 4) view.setFloat32(0, value, true)
  else view.setFloat64(0, value, true)
  return result
}

/**
 * Converts a JavaScript number to IEEE little-endian float bits and interns the constant.
 *
 * @category constants
 * @since 0.0.0
 */
export const floatFromNumber = Effect.fnUntraced(function* (
  builder: Builder.Builder,
  type: Type.Type,
  value: number,
) {
  return yield* floatingRaw(builder, type, 'float', numberBytes(value, 4))
})

/**
 * Converts a JavaScript number to IEEE little-endian double bits and interns the constant.
 *
 * @category constants
 * @since 0.0.0
 */
export const doubleFromNumber = Effect.fnUntraced(function* (
  builder: Builder.Builder,
  type: Type.Type,
  value: number,
) {
  return yield* floatingRaw(builder, type, 'double', numberBytes(value, 8))
})

/** @internal */
const special = (
  builder: Builder.Builder,
  type: Type.Type,
  kind: SpecialKind,
): Effect.Effect<Constant, LlvmError> =>
  BuilderState.transition(builder, `Constant.${kind}`, (context) => specialIn(context, type, kind))

type SpecialKind = Extract<ConstantDescription.Description, { readonly _tag: 'Special' }>['kind']

/** @internal */
export const specialIn = (
  context: BuilderState.Context,
  type: Type.Type,
  kind: SpecialKind,
): Result.Result<Constant, LlvmError> => {
  const typeIndex = Handle.resolve(context.builder, context.owner, type, 'Type', `Constant.${kind}`)
  if (Result.isFailure(typeIndex)) return Result.fail(typeIndex.failure)
  return internIn(context, { _tag: 'Special', type: typeIndex.success, kind })
}

/**
 * Returns the canonical `null` constant for a type.
 *
 * @category constants
 * @since 0.0.0
 */
export const nullValue = Effect.fnUntraced(function* (builder: Builder.Builder, type: Type.Type) {
  return yield* special(builder, type, 'null')
})

/**
 * Returns the canonical LLVM `none` token for a type.
 *
 * @category constants
 * @since 0.0.0
 */
export const none = Effect.fnUntraced(function* (builder: Builder.Builder, type: Type.Type) {
  return yield* special(builder, type, 'none')
})

/**
 * Returns the canonical `zeroinitializer` for a type.
 *
 * @category constants
 * @since 0.0.0
 */
export const zero = Effect.fnUntraced(function* (builder: Builder.Builder, type: Type.Type) {
  return yield* special(builder, type, 'zeroinitializer')
})

/**
 * Returns the canonical deprecated-but-supported `undef` value for a type.
 *
 * @category constants
 * @since 0.0.0
 */
export const undef = Effect.fnUntraced(function* (builder: Builder.Builder, type: Type.Type) {
  return yield* special(builder, type, 'undef')
})

/**
 * Returns the canonical `poison` value for a type.
 *
 * @category constants
 * @since 0.0.0
 */
export const poison = Effect.fnUntraced(function* (builder: Builder.Builder, type: Type.Type) {
  return yield* special(builder, type, 'poison')
})

/**
 * Interns byte-exact contents as an `[N x i8]` string constant, optionally appending one NUL byte.
 *
 * @category constants
 * @since 0.0.0
 */
export const string = (
  builder: Builder.Builder,
  value: ByteString.ByteString | Uint8Array | string,
  options: { readonly nullTerminated?: boolean } = {},
): Effect.Effect<Constant, LlvmError> =>
  BuilderState.transition(builder, 'Constant.string', (context) =>
    stringIn(context, value, options),
  )

/** @internal */
export const stringIn = (
  context: BuilderState.Context,
  value: ByteString.ByteString | Uint8Array | string,
  options: { readonly nullTerminated?: boolean } = {},
): Result.Result<Constant, LlvmError> => {
  const input = ByteString.coerce(value)
  const contents = options.nullTerminated
    ? ByteString.concat([input, ByteString.fromUint8Array(Uint8Array.of(0))])
    : input
  const i8 = Type.internIn(context, { _tag: 'Integer', bitWidth: 8 })
  if (Result.isFailure(i8)) return Result.fail(i8.failure)
  const type = Type.arrayIn(context, i8.success, contents.bytes.length)
  if (Result.isFailure(type)) return Result.fail(type.failure)
  if (ByteString.isEmpty(contents)) return specialIn(context, type.success, 'zeroinitializer')
  const typeIndex = Handle.resolve(
    context.builder,
    context.owner,
    type.success,
    'Type',
    'Constant.string',
  )
  if (Result.isFailure(typeIndex)) return Result.fail(typeIndex.failure)
  return internIn(context, { _tag: 'String', type: typeIndex.success, bytes: contents })
}

/**
 * Interns an array, vector, or complete structure after exact element-count and type validation.
 *
 * @category constants
 * @since 0.0.0
 */
export const aggregate = (
  builder: Builder.Builder,
  type: Type.Type,
  elements: ReadonlyArray<Constant>,
): Effect.Effect<Constant, LlvmError> =>
  BuilderState.transition(builder, 'Constant.aggregate', (context) =>
    aggregateIn(context, type, elements),
  )

/** @internal */
export const aggregateIn = (
  context: BuilderState.Context,
  type: Type.Type,
  elements: ReadonlyArray<Constant>,
): Result.Result<Constant, LlvmError> =>
  Result.flatMap(
    Result.gen(function* () {
      const typeIndex = yield* Handle.resolve(
        context.builder,
        context.owner,
        type,
        'Type',
        'Constant.aggregate',
      )
      const typeValue = yield* Table.descriptionAt(
        context.state.types,
        typeIndex,
        'Constant.aggregate',
        'Type',
      )
      const mutableElementIndices: Array<number> = []
      for (const element of elements) {
        mutableElementIndices.push(
          yield* Handle.resolve(
            context.builder,
            context.owner,
            element,
            'Constant',
            'Constant.aggregate',
          ),
        )
      }
      const elementIndices = mutableElementIndices
      let expected: ReadonlyArray<number>
      let kind: Extract<ConstantDescription.Description, { readonly _tag: 'Aggregate' }>['kind']
      if (typeValue._tag === 'Array' || typeValue._tag === 'Vector') {
        const length = typeValue._tag === 'Array' ? typeValue.length : BigInt(typeValue.length)
        if (length !== BigInt(elementIndices.length)) {
          return yield* Result.fail(
            invalidInput({
              operation: 'Constant.aggregate',
              message: 'Aggregate element count does not match its type',
              input: { type, elements },
            }),
          )
        }
        expected = elementIndices.map(() => typeValue.child)
        kind = typeValue._tag === 'Array' ? 'array' : 'vector'
      } else {
        let body: { readonly fields: ReadonlyArray<number>; readonly packed: boolean } | undefined
        if (typeValue._tag === 'Structure') body = typeValue
        else if (typeValue._tag === 'NamedStructure') body = typeValue.body
        if (body === undefined || body.fields.length !== elementIndices.length) {
          return yield* Result.fail(
            invalidInput({
              operation: 'Constant.aggregate',
              message: 'Aggregate elements require a complete matching aggregate type',
              input: { type, elements },
            }),
          )
        }
        expected = body.fields
        kind = body.packed ? 'packed-structure' : 'structure'
      }
      for (let index = 0; index < elementIndices.length; index += 1) {
        const element = yield* Table.descriptionAt(
          context.state.constants,
          elementIndices[index] ?? -1,
          'Constant.aggregate',
          'Constant',
        )
        if (element.type !== expected[index]) {
          return yield* Result.fail(
            invalidInput({
              operation: 'Constant.aggregate',
              message: 'Aggregate element type does not match its position',
              input: { index, type, elements },
            }),
          )
        }
      }
      return {
        _tag: 'Aggregate' as const,
        type: typeIndex,
        kind,
        elements: elementIndices,
      }
    }),
    (description) => internIn(context, description),
  )

/**
 * Interns a vector splat whose scalar value exactly matches the vector child type.
 *
 * @category constants
 * @since 0.0.0
 */
export const splat = Effect.fnUntraced(function* (
  builder: Builder.Builder,
  type: Type.Type,
  value: Constant,
): Effect.fn.Return<Constant, LlvmError> {
  const description = yield* BuilderState.mutate(builder, 'Constant.splat', (state, owner) =>
    Result.gen(function* () {
      const typeIndex = yield* Handle.resolve(builder, owner, type, 'Type', 'Constant.splat')
      const valueIndex = yield* Handle.resolve(builder, owner, value, 'Constant', 'Constant.splat')
      const typeValue = yield* Table.descriptionAt(state.types, typeIndex, 'Constant.splat', 'Type')
      const constantValue = yield* Table.descriptionAt(
        state.constants,
        valueIndex,
        'Constant.splat',
        'Constant',
      )
      if (typeValue._tag !== 'Vector' || constantValue.type !== typeValue.child) {
        return yield* Result.fail(
          invalidInput({
            operation: 'Constant.splat',
            message: 'A splat value must match the vector child type',
            input: { type, value },
          }),
        )
      }
      return { _tag: 'Splat' as const, type: typeIndex, value: valueIndex }
    }),
  )
  return yield* intern(builder, description)
})

/** @internal */
const functionConstant = Effect.fnUntraced(function* (
  builder: Builder.Builder,
  fn: FunctionActor.Function,
): Effect.fn.Return<Constant, LlvmError> {
  return yield* fromGlobal(builder, yield* FunctionActor.global(builder, fn))
})

/**
 * Interns a `blockaddress` constant for a non-negative block index in a function.
 *
 * @category constants
 * @since 0.0.0
 */
export const blockAddress = Effect.fnUntraced(function* (
  builder: Builder.Builder,
  fn: FunctionActor.Function,
  block: number,
): Effect.fn.Return<Constant, LlvmError> {
  if (!Number.isSafeInteger(block) || block < 0) {
    return yield* invalidInput({
      operation: 'Constant.blockAddress',
      message: 'A block address requires a non-negative block index',
      input: block,
    })
  }
  const reference = yield* functionConstant(builder, fn)
  const description = yield* BuilderState.mutate(builder, 'Constant.blockAddress', (state, owner) =>
    Result.gen(function* () {
      const functionIndex = yield* Handle.resolve(
        builder,
        owner,
        fn,
        'Function',
        'Constant.blockAddress',
      )
      const body = state.globals.functions.descriptions[functionIndex]?.body
      if (body !== undefined && block >= body.blocks.length) {
        return yield* Result.fail(
          invalidInput({
            operation: 'Constant.blockAddress',
            message: 'Block index is outside the function body',
            input: block,
          }),
        )
      }
      const referenceIndex = yield* Handle.resolve(
        builder,
        owner,
        reference,
        'Constant',
        'Constant.blockAddress',
      )
      const type = (yield* Table.descriptionAt(
        state.constants,
        referenceIndex,
        'Constant.blockAddress',
        'Constant',
      )).type
      return {
        _tag: 'BlockAddress' as const,
        type,
        function: referenceIndex,
        block,
      }
    }),
  )
  return yield* intern(builder, description)
})

/** @internal */
const functionReference = Effect.fnUntraced(function* (
  builder: Builder.Builder,
  fn: FunctionActor.Function,
  kind: 'dso_local_equivalent' | 'no_cfi',
): Effect.fn.Return<Constant, LlvmError> {
  const reference = yield* functionConstant(builder, fn)
  const description = yield* BuilderState.mutate(builder, `Constant.${kind}`, (state, owner) =>
    Result.gen(function* () {
      const referenceIndex = yield* Handle.resolve(
        builder,
        owner,
        reference,
        'Constant',
        `Constant.${kind}`,
      )
      return {
        _tag: 'FunctionReference' as const,
        kind,
        function: referenceIndex,
        type: (yield* Table.descriptionAt(
          state.constants,
          referenceIndex,
          `Constant.${kind}`,
          'Constant',
        )).type,
      }
    }),
  )
  return yield* intern(builder, description)
})

/**
 * Interns LLVM's `dso_local_equivalent` function reference constant.
 *
 * @category constants
 * @since 0.0.0
 */
export const dsoLocalEquivalent = Effect.fnUntraced(function* (
  builder: Builder.Builder,
  fn: FunctionActor.Function,
): Effect.fn.Return<Constant, LlvmError> {
  return yield* functionReference(builder, fn, 'dso_local_equivalent')
})

/**
 * Interns LLVM's `no_cfi` function reference constant.
 *
 * @category constants
 * @since 0.0.0
 */
export const noCfi = Effect.fnUntraced(function* (
  builder: Builder.Builder,
  fn: FunctionActor.Function,
): Effect.fn.Return<Constant, LlvmError> {
  return yield* functionReference(builder, fn, 'no_cfi')
})

/** @internal */
const castScalar = (
  state: BuilderState.MutableState,
  index: number,
): Result.Result<TypeDescription.Description, LlvmError> =>
  Result.gen(function* () {
    const description = yield* Table.descriptionAt(state.types, index, 'Constant.cast', 'Type')
    return description._tag === 'Vector'
      ? yield* Table.descriptionAt(state.types, description.child, 'Constant.cast', 'Type')
      : description
  })

/** @internal */
const castWidth = (description: TypeDescription.Description): number | undefined => {
  if (description._tag === 'Integer') return description.bitWidth
  if (description._tag !== 'Simple') return undefined
  switch (description.tag) {
    case 'Half':
    case 'BFloat':
      return 16
    case 'Float':
      return 32
    case 'Double':
      return 64
    case 'X86Fp80':
      return 80
    case 'Fp128':
    case 'PpcFp128':
      return 128
    default:
      return undefined
  }
}

/**
 * Interns a type-checked integer, pointer, address-space, or equal-width bitcast expression.
 *
 * @category constants
 * @since 0.0.0
 */
export const cast = Effect.fnUntraced(function* (
  builder: Builder.Builder,
  kind: CastKind,
  value: Constant,
  type: Type.Type,
): Effect.fn.Return<Constant, LlvmError> {
  const description = yield* BuilderState.mutate(builder, 'Constant.cast', (state, owner) =>
    Result.gen(function* () {
      const valueIndex = yield* Handle.resolve(builder, owner, value, 'Constant', 'Constant.cast')
      const destinationIndex = yield* Handle.resolve(builder, owner, type, 'Type', 'Constant.cast')
      const sourceIndex = (yield* Table.descriptionAt(
        state.constants,
        valueIndex,
        'Constant.cast',
        'Constant',
      )).type
      const sourceType = yield* Table.descriptionAt(
        state.types,
        sourceIndex,
        'Constant.cast',
        'Type',
      )
      const destinationType = yield* Table.descriptionAt(
        state.types,
        destinationIndex,
        'Constant.cast',
        'Type',
      )
      const sourceScalar = yield* castScalar(state, sourceIndex)
      const destinationScalar = yield* castScalar(state, destinationIndex)
      const sameVectorShape =
        sourceType._tag === 'Vector' || destinationType._tag === 'Vector'
          ? sourceType._tag === 'Vector' &&
            destinationType._tag === 'Vector' &&
            sourceType.length === destinationType.length &&
            sourceType.scalable === destinationType.scalable
          : true
      const valid =
        sameVectorShape &&
        ((kind === 'trunc' &&
          sourceScalar._tag === 'Integer' &&
          destinationScalar._tag === 'Integer' &&
          sourceScalar.bitWidth > destinationScalar.bitWidth) ||
          (kind === 'ptrtoint' &&
            sourceScalar._tag === 'Pointer' &&
            destinationScalar._tag === 'Integer') ||
          (kind === 'inttoptr' &&
            sourceScalar._tag === 'Integer' &&
            destinationScalar._tag === 'Pointer') ||
          (kind === 'bitcast' &&
            ((sourceScalar._tag === 'Pointer' && destinationScalar._tag === 'Pointer') ||
              castWidth(sourceScalar) === castWidth(destinationScalar))) ||
          (kind === 'addrspacecast' &&
            sourceScalar._tag === 'Pointer' &&
            destinationScalar._tag === 'Pointer'))
      if (!valid) {
        return yield* Result.fail(
          invalidInput({
            operation: 'Constant.cast',
            message: `${kind} is invalid for the constant source and destination types`,
            input: { value, type },
          }),
        )
      }
      return {
        _tag: 'Cast' as const,
        kind,
        value: valueIndex,
        type: destinationIndex,
      }
    }),
  )
  return yield* intern(builder, description)
})

/**
 * Interns an integer binary constant expression whose operands have exactly one type.
 *
 * @category constants
 * @since 0.0.0
 */
export const binary = Effect.fnUntraced(function* (
  builder: Builder.Builder,
  kind: BinaryKind,
  left: Constant,
  right: Constant,
): Effect.fn.Return<Constant, LlvmError> {
  const description = yield* BuilderState.mutate(builder, 'Constant.binary', (state, owner) =>
    Result.gen(function* () {
      const leftIndex = yield* Handle.resolve(builder, owner, left, 'Constant', 'Constant.binary')
      const rightIndex = yield* Handle.resolve(builder, owner, right, 'Constant', 'Constant.binary')
      const leftValue = yield* Table.descriptionAt(
        state.constants,
        leftIndex,
        'Constant.binary',
        'Constant',
      )
      const rightValue = yield* Table.descriptionAt(
        state.constants,
        rightIndex,
        'Constant.binary',
        'Constant',
      )
      if (leftValue.type !== rightValue.type) {
        return yield* Result.fail(
          invalidInput({
            operation: 'Constant.binary',
            message: 'Binary constant operands must have one type',
            input: { left, right },
          }),
        )
      }
      if ((yield* castScalar(state, leftValue.type))._tag !== 'Integer') {
        return yield* Result.fail(
          invalidInput({
            operation: 'Constant.binary',
            message: 'Pinned constant binary expressions require integer operands',
            input: { left, right },
          }),
        )
      }
      return {
        _tag: 'Binary' as const,
        kind,
        type: leftValue.type,
        left: leftIndex,
        right: rightIndex,
      }
    }),
  )
  return yield* intern(builder, description)
})

/**
 * Interns a validated scalar or vector `getelementptr` constant expression.
 *
 * **Gotchas**
 *
 * Structure indices must be integer constants selecting an existing field. Vector inputs
 * must share one shape, `inrange` must name an index, and the result pointer shape is checked.
 *
 * @category constants
 * @since 0.0.0
 */
export const getElementPtr = Effect.fnUntraced(function* (
  builder: Builder.Builder,
  sourceType: Type.Type,
  resultType: Type.Type,
  base: Constant,
  indices: ReadonlyArray<Constant>,
  options: { readonly inbounds?: boolean; readonly inrange?: number } = {},
): Effect.fn.Return<Constant, LlvmError> {
  const description = yield* BuilderState.mutate(
    builder,
    'Constant.getElementPtr',
    (state, owner) =>
      Result.gen(function* () {
        const sourceTypeIndex = yield* Handle.resolve(
          builder,
          owner,
          sourceType,
          'Type',
          'Constant.getElementPtr',
        )
        const resultTypeIndex = yield* Handle.resolve(
          builder,
          owner,
          resultType,
          'Type',
          'Constant.getElementPtr',
        )
        const baseIndex = yield* Handle.resolve(
          builder,
          owner,
          base,
          'Constant',
          'Constant.getElementPtr',
        )
        const baseValue = yield* Table.descriptionAt(
          state.constants,
          baseIndex,
          'Constant.getElementPtr',
          'Constant',
        )
        const baseType = yield* Table.descriptionAt(
          state.types,
          baseValue.type,
          'Constant.getElementPtr',
          'Type',
        )
        const basePointer =
          baseType._tag === 'Vector'
            ? yield* Table.descriptionAt(
                state.types,
                baseType.child,
                'Constant.getElementPtr',
                'Type',
              )
            : baseType
        if (basePointer._tag !== 'Pointer') {
          return yield* Result.fail(
            invalidInput({
              operation: 'Constant.getElementPtr',
              message: 'Constant GEP base must be a pointer or vector of pointers',
              input: base,
            }),
          )
        }
        if (
          options.inrange !== undefined &&
          (!Number.isSafeInteger(options.inrange) ||
            options.inrange < 0 ||
            options.inrange >= indices.length)
        ) {
          return yield* Result.fail(
            invalidInput({
              operation: 'Constant.getElementPtr',
              message: 'inrange must identify an existing GEP index',
              input: options.inrange,
            }),
          )
        }
        const mutableIndexValues: Array<number> = []
        for (const index of indices) {
          mutableIndexValues.push(
            yield* Handle.resolve(builder, owner, index, 'Constant', 'Constant.getElementPtr'),
          )
        }
        const indexValues = mutableIndexValues
        let current = sourceTypeIndex
        let vector =
          baseType._tag === 'Vector'
            ? { length: baseType.length, scalable: baseType.scalable }
            : undefined
        for (let position = 0; position < indexValues.length; position += 1) {
          const index = indexValues[position]
          const indexValue = yield* Table.descriptionAt(
            state.constants,
            index ?? -1,
            'Constant.getElementPtr',
            'Constant',
          )
          const indexType = yield* Table.descriptionAt(
            state.types,
            indexValue.type,
            'Constant.getElementPtr',
            'Type',
          )
          const scalar =
            indexType._tag === 'Vector'
              ? yield* Table.descriptionAt(
                  state.types,
                  indexType.child,
                  'Constant.getElementPtr',
                  'Type',
                )
              : indexType
          if (scalar._tag !== 'Integer') {
            return yield* Result.fail(
              invalidInput({
                operation: 'Constant.getElementPtr',
                message: 'getelementptr indices must be integer scalars or vectors',
                input: indices,
              }),
            )
          }
          if (indexType._tag === 'Vector') {
            const shape = { length: indexType.length, scalable: indexType.scalable }
            if (
              vector !== undefined &&
              (vector.length !== shape.length || vector.scalable !== shape.scalable)
            ) {
              return yield* Result.fail(
                invalidInput({
                  operation: 'Constant.getElementPtr',
                  message: 'Vector GEP operands must have one vector shape',
                  input: indices,
                }),
              )
            }
            vector = shape
          }
          if (position === 0) continue
          const aggregate = yield* Table.descriptionAt(
            state.types,
            current,
            'Constant.getElementPtr',
            'Type',
          )
          if (aggregate._tag === 'Array' || aggregate._tag === 'Vector') {
            current = aggregate.child
            continue
          }
          let body: { readonly fields: ReadonlyArray<number>; readonly packed: boolean } | undefined
          if (aggregate._tag === 'Structure') body = aggregate
          else if (aggregate._tag === 'NamedStructure') body = aggregate.body
          const field =
            body !== undefined &&
            indexValue._tag === 'Integer' &&
            indexValue.bitPattern <= BigInt(Number.MAX_SAFE_INTEGER)
              ? body.fields[Number(indexValue.bitPattern)]
              : undefined
          if (field === undefined) {
            return yield* Result.fail(
              invalidInput({
                operation: 'Constant.getElementPtr',
                message: 'Constant GEP path cannot select the requested aggregate child',
                input: indices,
              }),
            )
          }
          current = field
        }
        const result = yield* Table.descriptionAt(
          state.types,
          resultTypeIndex,
          'Constant.getElementPtr',
          'Type',
        )
        const expectedPointerIndex = baseType._tag === 'Vector' ? baseType.child : baseValue.type
        const validResult =
          vector === undefined
            ? resultTypeIndex === expectedPointerIndex
            : result._tag === 'Vector' &&
              result.child === expectedPointerIndex &&
              result.length === vector.length &&
              result.scalable === vector.scalable
        if (!validResult) {
          return yield* Result.fail(
            invalidInput({
              operation: 'Constant.getElementPtr',
              message: 'Constant GEP result type does not match its pointer/vector shape',
              input: resultType,
            }),
          )
        }
        return {
          _tag: 'GetElementPtr' as const,
          sourceType: sourceTypeIndex,
          type: resultTypeIndex,
          base: baseIndex,
          indices: indexValues,
          inbounds: options.inbounds ?? false,
          inrange: options.inrange,
        }
      }),
  )
  return yield* intern(builder, description)
})

/**
 * Interns byte-preserving inline assembly and its constraints for a function type.
 *
 * @category constants
 * @since 0.0.0
 */
export const assembly = (
  builder: Builder.Builder,
  type: Type.Type,
  assembly: ByteString.ByteString | Uint8Array | string,
  constraints: ByteString.ByteString | Uint8Array | string,
  options: AssemblyOptions = {},
): Effect.Effect<Constant, LlvmError> =>
  BuilderState.transition(builder, 'Constant.assembly', (context) =>
    assemblyIn(context, type, assembly, constraints, options),
  )

/** @internal */
export const assemblyIn = (
  context: BuilderState.Context,
  type: Type.Type,
  assembly: ByteString.ByteString | Uint8Array | string,
  constraints: ByteString.ByteString | Uint8Array | string,
  options: AssemblyOptions = {},
): Result.Result<Constant, LlvmError> =>
  Result.flatMap(
    Handle.resolve(context.builder, context.owner, type, 'Type', 'Constant.assembly'),
    (typeIndex) =>
      internIn(context, {
        _tag: 'Assembly',
        type: typeIndex,
        assembly: ByteString.coerce(assembly),
        constraints: ByteString.coerce(constraints),
        sideEffect: options.sideEffect ?? false,
        alignStack: options.alignStack ?? false,
        intelDialect: options.intelDialect ?? false,
        canThrow: options.canThrow ?? false,
      }),
  )

/**
 * Returns the builder-owned LLVM type of a constant.
 *
 * @category constants
 * @since 0.0.0
 */
export const typeOf = Effect.fnUntraced(function* (
  builder: Builder.Builder,
  self: Constant,
): Effect.fn.Return<Type.Type, LlvmError> {
  return yield* BuilderState.mutate(builder, 'Constant.typeOf', (state, owner) =>
    Result.gen(function* () {
      const index = yield* Handle.resolve(builder, owner, self, 'Constant', 'Constant.typeOf')
      const description = yield* Table.descriptionAt(
        state.constants,
        index,
        'Constant.typeOf',
        'Constant',
      )
      return yield* Table.handleAt(state.types, description.type, 'Constant.typeOf', 'Type')
    }),
  )
})

/**
 * Returns the constant's stable runtime representation tag.
 *
 * @category constants
 * @since 0.0.0
 */
export const tag = Effect.fnUntraced(function* (
  builder: Builder.Builder,
  self: Constant,
): Effect.fn.Return<ConstantDescription.Description['_tag'], LlvmError> {
  return yield* BuilderState.mutate(builder, 'Constant.tag', (state, owner) =>
    Result.gen(function* () {
      const index = yield* Handle.resolve(builder, owner, self, 'Constant', 'Constant.tag')
      return (yield* Table.descriptionAt(state.constants, index, 'Constant.tag', 'Constant'))._tag
    }),
  )
})

/**
 * Reads an integer constant's normalized unsigned bit pattern as `bigint`.
 *
 * @category constants
 * @since 0.0.0
 */
export const integerBitPattern = Effect.fnUntraced(function* (
  builder: Builder.Builder,
  self: Constant,
): Effect.fn.Return<bigint, LlvmError> {
  return yield* BuilderState.mutate(builder, 'Constant.integerBitPattern', (state, owner) =>
    Result.gen(function* () {
      const index = yield* Handle.resolve(
        builder,
        owner,
        self,
        'Constant',
        'Constant.integerBitPattern',
      )
      const description = yield* Table.descriptionAt(
        state.constants,
        index,
        'Constant.integerBitPattern',
        'Constant',
      )
      if (description._tag !== 'Integer') {
        return yield* Result.fail(
          invalidInput({
            operation: 'Constant.integerBitPattern',
            message: 'Expected an integer constant',
            input: self,
          }),
        )
      }
      return description.bitPattern
    }),
  )
})

/**
 * Reads a floating constant's byte-exact immutable payload.
 *
 * @category constants
 * @since 0.0.0
 */
export const floatingBits = Effect.fnUntraced(function* (
  builder: Builder.Builder,
  self: Constant,
): Effect.fn.Return<ByteString.ByteString, LlvmError> {
  return yield* BuilderState.mutate(builder, 'Constant.floatingBits', (state, owner) =>
    Result.gen(function* () {
      const index = yield* Handle.resolve(builder, owner, self, 'Constant', 'Constant.floatingBits')
      const description = yield* Table.descriptionAt(
        state.constants,
        index,
        'Constant.floatingBits',
        'Constant',
      )
      if (description._tag !== 'Float') {
        return yield* Result.fail(
          invalidInput({
            operation: 'Constant.floatingBits',
            message: 'Expected a floating-point constant',
            input: self,
          }),
        )
      }
      return description.bits
    }),
  )
})
