import * as Effect from 'effect/Effect'
import * as Result from 'effect/Result'
import * as AddrSpace from './AddrSpace.js'
import type * as Alignment from './Alignment.js'
import type * as Builder from './Builder.js'
import * as ByteString from './ByteString.js'
import * as DataLayout from './DataLayout.js'
import * as BuilderState from './internal/BuilderState.js'
import * as CanonicalKey from './internal/CanonicalKey.js'
import * as Handle from './internal/Handle.js'
import * as IntegerInput from './internal/IntegerInput.js'
import type * as OwnedHandle from './internal/OwnedHandle.js'
import * as ResolveActor from './internal/resolveActor.js'
import * as Table from './internal/Table.js'
import type * as TypeDescription from './internal/TypeDescription.js'
import { invalidInput, type LlvmError, wrappedFailure } from './LlvmError.js'

/**
 * Opaque builder-owned identity for a structurally interned LLVM type.
 *
 * @category types
 * @since 0.0.0
 */
export interface Type extends Handle.Handle<'Type'> {}

/**
 * Runtime classification returned by {@link tag}.
 *
 * @category types
 * @since 0.0.0
 */
export type Tag = TypeDescription.Description['_tag'] | TypeDescription.SimpleTag

/**
 * Materialized return, parameter, and variadic fields of a function type.
 *
 * @category types
 * @since 0.0.0
 */
export interface FunctionSignature {
  readonly returnType: Type
  readonly parameters: ReadonlyArray<Type>
  readonly variadic: boolean
}

/**
 * Uniform structural view of arrays, vectors, literal structures, and complete named structures.
 *
 * @category types
 * @since 0.0.0
 */
export interface AggregateShape {
  readonly fields: ReadonlyArray<Type>
  readonly packed: boolean
  readonly scalable: boolean
  readonly length: bigint | undefined
}

/** @internal */
const keyForDescription = (description: TypeDescription.Description): string => {
  switch (description._tag) {
    case 'Simple':
      return CanonicalKey.tagged('simple', [description.tag])
    case 'Integer':
      return CanonicalKey.tagged('integer', [CanonicalKey.integer(description.bitWidth)])
    case 'Pointer':
      return CanonicalKey.tagged('pointer', [CanonicalKey.integer(description.addressSpace.value)])
    case 'Function':
      return CanonicalKey.tagged('function', [
        CanonicalKey.integer(description.returnType),
        CanonicalKey.sequence(description.parameters.map(CanonicalKey.integer)),
        description.variadic ? '1' : '0',
      ])
    case 'Vector':
      return CanonicalKey.tagged('vector', [
        CanonicalKey.integer(description.child),
        CanonicalKey.integer(description.length),
        description.scalable ? '1' : '0',
      ])
    case 'Array':
      return CanonicalKey.tagged('array', [
        CanonicalKey.integer(description.child),
        CanonicalKey.integer(description.length),
      ])
    case 'Structure':
      return CanonicalKey.tagged('structure', [
        description.packed ? '1' : '0',
        CanonicalKey.sequence(description.fields.map(CanonicalKey.integer)),
      ])
    case 'NamedStructure':
      return CanonicalKey.tagged('named-structure', [CanonicalKey.bytes(description.name)])
    case 'TargetExtension':
      return CanonicalKey.tagged('target-extension', [
        CanonicalKey.bytes(description.name),
        CanonicalKey.sequence(description.types.map(CanonicalKey.integer)),
        CanonicalKey.sequence(description.integers.map(CanonicalKey.integer)),
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
  description: TypeDescription.Description,
): Effect.Effect<Type, LlvmError> =>
  BuilderState.mutate(builder, 'Type.intern', (state, owner) =>
    Table.intern(
      state.types,
      'Type.intern',
      'Type',
      keyForDescription(description),
      description,
      (index) => Handle.make('Type', owner, index),
    ),
  )

/**
 * Interns an already-validated description inside a running builder transition.
 *
 * @internal
 */
export const internIndex = (
  state: BuilderState.MutableState,
  owner: OwnedHandle.Owner,
  description: TypeDescription.Description,
): number =>
  Table.internIndex(state.types, keyForDescription(description), description, (index) =>
    Handle.make('Type', owner, index),
  )

/**
 * Interns a validated description inside a running builder transition and returns its handle.
 *
 * @internal
 */
export const internIn = (
  context: BuilderState.Context,
  description: TypeDescription.Description,
): Result.Result<Type, LlvmError> =>
  Table.intern(
    context.state.types,
    'Type.intern',
    'Type',
    keyForDescription(description),
    description,
    (index) => Handle.make('Type', context.owner, index),
  )

/** @internal */
const simple = (builder: Builder.Builder, tag: TypeDescription.SimpleTag) =>
  intern(builder, { _tag: 'Simple', tag })

/**
 * Returns the builder's canonical LLVM `void` type.
 *
 * @category types
 * @since 0.0.0
 */
export const voidType = Effect.fnUntraced(function* (builder: Builder.Builder) {
  return yield* simple(builder, 'Void')
})

/**
 * Returns the canonical IEEE 16-bit `half` type.
 *
 * @category types
 * @since 0.0.0
 */
export const half = Effect.fnUntraced(function* (builder: Builder.Builder) {
  return yield* simple(builder, 'Half')
})

/**
 * Returns the canonical 16-bit `bfloat` type.
 *
 * @category types
 * @since 0.0.0
 */
export const bfloat = Effect.fnUntraced(function* (builder: Builder.Builder) {
  return yield* simple(builder, 'BFloat')
})

/**
 * Returns the canonical IEEE 32-bit `float` type.
 *
 * @category types
 * @since 0.0.0
 */
export const float = Effect.fnUntraced(function* (builder: Builder.Builder) {
  return yield* simple(builder, 'Float')
})

/**
 * Returns the canonical IEEE 64-bit `double` type.
 *
 * @category types
 * @since 0.0.0
 */
export const double = Effect.fnUntraced(function* (builder: Builder.Builder) {
  return yield* simple(builder, 'Double')
})

/**
 * Returns the canonical x87 80-bit floating-point type.
 *
 * @category types
 * @since 0.0.0
 */
export const x86Fp80 = Effect.fnUntraced(function* (builder: Builder.Builder) {
  return yield* simple(builder, 'X86Fp80')
})

/**
 * Returns the canonical IEEE quad-precision `fp128` type.
 *
 * @category types
 * @since 0.0.0
 */
export const fp128 = Effect.fnUntraced(function* (builder: Builder.Builder) {
  return yield* simple(builder, 'Fp128')
})

/**
 * Returns the canonical PowerPC double-double `ppc_fp128` type.
 *
 * @category types
 * @since 0.0.0
 */
export const ppcFp128 = Effect.fnUntraced(function* (builder: Builder.Builder) {
  return yield* simple(builder, 'PpcFp128')
})

/**
 * Returns the canonical basic-block `label` type.
 *
 * @category types
 * @since 0.0.0
 */
export const label = Effect.fnUntraced(function* (builder: Builder.Builder) {
  return yield* simple(builder, 'Label')
})

/**
 * Returns the canonical first-class `metadata` type.
 *
 * @category types
 * @since 0.0.0
 */
export const metadata = Effect.fnUntraced(function* (builder: Builder.Builder) {
  return yield* simple(builder, 'Metadata')
})

/**
 * Returns the canonical x86 AMX tile type.
 *
 * @category types
 * @since 0.0.0
 */
export const x86Amx = Effect.fnUntraced(function* (builder: Builder.Builder) {
  return yield* simple(builder, 'X86Amx')
})

/**
 * Returns the canonical LLVM `token` type.
 *
 * @category types
 * @since 0.0.0
 */
export const token = Effect.fnUntraced(function* (builder: Builder.Builder) {
  return yield* simple(builder, 'Token')
})

/**
 * Returns the canonical arbitrary-width integer type for this builder.
 *
 * **Details**
 *
 * The width may range from `1` through LLVM's 24-bit maximum, `16_777_215`.
 *
 * **Gotchas**
 *
 * Values outside that range, including non-integers, fail with {@link LlvmError}.
 *
 * **Example** (Creating a wide integer type)
 *
 * ```ts
 * import * as Effect from 'effect/Effect'
 * import * as Builder from '@silklang/llvm/Builder'
 * import * as Type from '@silklang/llvm/Type'
 *
 * const width = await Effect.runPromise(Effect.gen(function* () {
 *   const builder = yield* Builder.make()
 *   const i129 = yield* Type.integer(builder, 129)
 *   return yield* Type.integerBitWidth(builder, i129)
 * }))
 * // width === 129
 * ```
 *
 * @category types
 * @since 0.0.0
 */
export const integer = (
  builder: Builder.Builder,
  bitWidth: number,
): Effect.Effect<Type, LlvmError> =>
  !Number.isSafeInteger(bitWidth) || bitWidth < 1 || bitWidth > 0xff_ffff
    ? Effect.fail(
        invalidInput({
          operation: 'Type.integer',
          message: 'LLVM integer width must be from 1 through 16777215 bits',
          input: bitWidth,
        }),
      )
    : intern(builder, { _tag: 'Integer', bitWidth })

/**
 * Returns the canonical opaque pointer type for an address space.
 *
 * @category types
 * @since 0.0.0
 */
export const pointer = (
  builder: Builder.Builder,
  addressSpace: AddrSpace.AddrSpace = AddrSpace.defaultAddrSpace,
): Effect.Effect<Type, LlvmError> => intern(builder, { _tag: 'Pointer', addressSpace })

/** @internal */
const indices = (
  builder: Builder.Builder,
  owner: BuilderState.Snapshot['owner'],
  types: ReadonlyArray<Type>,
  operation: string,
): Result.Result<ReadonlyArray<number>, LlvmError> =>
  Result.gen(function* () {
    const values: Array<number> = []
    for (const type of types) {
      values.push(yield* Handle.resolve(builder, owner, type, 'Type', operation))
    }
    return values
  })

/**
 * Interns an LLVM function signature from a return type, positional parameters, and variadic flag.
 *
 * @category types
 * @since 0.0.0
 */
export const functionType = (
  builder: Builder.Builder,
  returnType: Type,
  parameters: ReadonlyArray<Type>,
  options: { readonly variadic?: boolean } = {},
): Effect.Effect<Type, LlvmError> =>
  BuilderState.transition(builder, 'Type.functionType', (context) =>
    functionTypeIn(context, returnType, parameters, options),
  )

/** @internal */
export const functionTypeIn = (
  context: BuilderState.Context,
  returnType: Type,
  parameters: ReadonlyArray<Type>,
  options: { readonly variadic?: boolean } = {},
): Result.Result<Type, LlvmError> => {
  const returnIndex = Handle.resolve(
    context.builder,
    context.owner,
    returnType,
    'Type',
    'Type.functionType',
  )
  if (Result.isFailure(returnIndex)) return Result.fail(returnIndex.failure)
  const parameterIndices = indices(context.builder, context.owner, parameters, 'Type.functionType')
  if (Result.isFailure(parameterIndices)) return Result.fail(parameterIndices.failure)
  return internIn(context, {
    _tag: 'Function',
    returnType: returnIndex.success,
    parameters: parameterIndices.success,
    variadic: options.variadic ?? false,
  })
}

/** @internal */
const vectorOf = Effect.fnUntraced(function* (
  builder: Builder.Builder,
  child: Type,
  length: number,
  scalable: boolean,
): Effect.fn.Return<Type, LlvmError> {
  if (!Number.isSafeInteger(length) || length < 1 || length > 0xffff_ffff) {
    return yield* invalidInput({
      operation: 'Type.vector',
      message: 'LLVM vector length must be a positive 32-bit integer',
      input: length,
    })
  }
  const childIndex = yield* BuilderState.mutate(builder, 'Type.vector', (_state, owner) =>
    Handle.resolve(builder, owner, child, 'Type', 'Type.vector'),
  )
  return yield* intern(builder, { _tag: 'Vector', child: childIndex, length, scalable })
})

/**
 * Interns a fixed vector with a positive unsigned 32-bit element count.
 *
 * @category types
 * @since 0.0.0
 */
export const vector = Effect.fnUntraced(function* (
  builder: Builder.Builder,
  child: Type,
  length: number,
) {
  return yield* vectorOf(builder, child, length, false)
})

/**
 * Interns a scalable vector whose runtime length is a positive multiple of `minimumLength`.
 *
 * @category types
 * @since 0.0.0
 */
export const scalableVector = Effect.fnUntraced(function* (
  builder: Builder.Builder,
  child: Type,
  minimumLength: number,
) {
  return yield* vectorOf(builder, child, minimumLength, true)
})

/**
 * Interns an array with an unsigned 64-bit length; unlike vectors, zero-length arrays are valid.
 *
 * @category types
 * @since 0.0.0
 */
export const array = (
  builder: Builder.Builder,
  child: Type,
  length: number | bigint,
): Effect.Effect<Type, LlvmError> =>
  BuilderState.transition(builder, 'Type.array', (context) => arrayIn(context, child, length))

/** @internal */
export const arrayIn = (
  context: BuilderState.Context,
  child: Type,
  length: number | bigint,
): Result.Result<Type, LlvmError> => {
  const exactLength = IntegerInput.normalize(length, {
    operation: 'Type.array',
    message: 'LLVM array length must be an unsigned 64-bit integer',
    minimum: 0n,
    maximum: 0xffff_ffff_ffff_ffffn,
  })
  if (Result.isFailure(exactLength)) return Result.fail(exactLength.failure)
  const childIndex = Handle.resolve(context.builder, context.owner, child, 'Type', 'Type.array')
  if (Result.isFailure(childIndex)) return Result.fail(childIndex.failure)
  return internIn(context, {
    _tag: 'Array',
    child: childIndex.success,
    length: exactLength.success,
  })
}

/**
 * Interns an anonymous literal structure, optionally using packed field layout.
 *
 * @category types
 * @since 0.0.0
 */
export const structure = (
  builder: Builder.Builder,
  fields: ReadonlyArray<Type>,
  options: { readonly packed?: boolean } = {},
): Effect.Effect<Type, LlvmError> =>
  BuilderState.transition(builder, 'Type.structure', (context) =>
    structureIn(context, fields, options),
  )

/** @internal */
export const structureIn = (
  context: BuilderState.Context,
  fields: ReadonlyArray<Type>,
  options: { readonly packed?: boolean } = {},
): Result.Result<Type, LlvmError> => {
  const fieldIndices = indices(context.builder, context.owner, fields, 'Type.structure')
  if (Result.isFailure(fieldIndices)) return Result.fail(fieldIndices.failure)
  return internIn(context, {
    _tag: 'Structure',
    fields: fieldIndices.success,
    packed: options.packed ?? false,
  })
}

/**
 * Declares or retrieves a named structure with a stable identity and initially opaque body.
 *
 * **When to use**
 *
 * Use when a recursive type needs a stable identity before its fields can be declared. Complete the
 * type exactly once with {@link setNamedBody}.
 *
 * @category types
 * @since 0.0.0
 */
export const namedStructure = Effect.fnUntraced(function* (
  builder: Builder.Builder,
  name: ByteString.ByteString | Uint8Array | string,
): Effect.fn.Return<Type, LlvmError> {
  const value = ByteString.coerce(name)
  if (ByteString.isEmpty(value)) {
    return yield* invalidInput({
      operation: 'Type.namedStructure',
      message: 'A named LLVM structure requires a non-empty name',
      input: name,
    })
  }
  return yield* BuilderState.mutate(builder, 'Type.namedStructure', (state, owner) =>
    Result.gen(function* () {
      const key = CanonicalKey.bytes(value)
      const found = state.namedTypes.get(key)
      if (found !== undefined) {
        return yield* Table.handleAt(state.types, found, 'Type.namedStructure', 'Type')
      }
      const index = state.types.descriptions.length
      const handle = Handle.make('Type', owner, index)
      const description: TypeDescription.Description = {
        _tag: 'NamedStructure',
        name: value,
        body: undefined,
      }
      state.types.descriptions.push(description)
      state.types.handles.push(handle)
      state.types.keys.set(keyForDescription(description), index)
      state.namedTypes.set(key, index)
      return handle
    }),
  )
})

/**
 * Completes a named structure exactly once, allowing its fields to refer back to its identity.
 *
 * @category types
 * @since 0.0.0
 */
export const setNamedBody = Effect.fnUntraced(function* (
  builder: Builder.Builder,
  self: Type,
  fields: ReadonlyArray<Type>,
  options: { readonly packed?: boolean } = {},
): Effect.fn.Return<void, LlvmError> {
  yield* BuilderState.mutate(builder, 'Type.setNamedBody', (state, owner) =>
    Result.gen(function* () {
      const index = yield* Handle.resolve(builder, owner, self, 'Type', 'Type.setNamedBody')
      const description = state.types.descriptions[index]
      if (description?._tag !== 'NamedStructure') {
        return yield* Result.fail(
          invalidInput({
            operation: 'Type.setNamedBody',
            message: 'Only a named structure can receive a body',
            input: self,
          }),
        )
      }
      if (description.body !== undefined) {
        return yield* Result.fail(
          invalidInput({
            operation: 'Type.setNamedBody',
            message: 'A named structure body can only be assigned once',
            input: self,
          }),
        )
      }
      state.types.descriptions[index] = {
        ...description,
        body: {
          fields: yield* indices(builder, owner, fields, 'Type.setNamedBody'),
          packed: options.packed ?? false,
        },
      }
    }),
  )
})

/**
 * Interns a non-empty named target-extension type with type and integer parameters.
 *
 * @category types
 * @since 0.0.0
 */
export const targetExtension = Effect.fnUntraced(function* (
  builder: Builder.Builder,
  name: ByteString.ByteString | Uint8Array | string,
  types: ReadonlyArray<Type> = [],
  integerParameters: ReadonlyArray<number | bigint> = [],
): Effect.fn.Return<Type, LlvmError> {
  const value = ByteString.coerce(name)
  if (ByteString.isEmpty(value)) {
    return yield* invalidInput({
      operation: 'Type.targetExtension',
      message: 'A target extension type requires a non-empty name',
      input: name,
    })
  }
  const integers = yield* Effect.fromResult(
    IntegerInput.normalizeAll(integerParameters, {
      operation: 'Type.targetExtension',
      message: 'Target extension integer parameters must be finite safe integers or bigints',
    }),
  )
  const description = yield* BuilderState.mutate(builder, 'Type.targetExtension', (_state, owner) =>
    Result.gen(function* () {
      return {
        _tag: 'TargetExtension' as const,
        name: value,
        types: yield* indices(builder, owner, types, 'Type.targetExtension'),
        integers,
      }
    }),
  )
  return yield* intern(builder, description)
})

/** @internal */
const inspect = <A>(
  builder: Builder.Builder,
  self: Type,
  operation: string,
  f: (
    description: TypeDescription.Description,
    state: BuilderState.MutableState,
    index: number,
  ) => Result.Result<A, LlvmError>,
) =>
  BuilderState.mutate(builder, operation, (state, owner) =>
    Result.gen(function* () {
      const { index, description } = yield* ResolveActor.resolve(
        builder,
        owner,
        self,
        'Type',
        state.types,
        operation,
      )
      return yield* f(description, state, index)
    }),
  )

/**
 * Returns a stable runtime tag for a builder-owned type.
 *
 * @category types
 * @since 0.0.0
 */
export const tag = Effect.fnUntraced(function* (builder: Builder.Builder, self: Type) {
  return yield* inspect(builder, self, 'Type.tag', (description) =>
    Result.succeed(description._tag === 'Simple' ? description.tag : description._tag),
  )
})

/**
 * Reads an integer type's bit width, failing with {@link LlvmError} for other type families.
 *
 * @category types
 * @since 0.0.0
 */
export const integerBitWidth = Effect.fnUntraced(function* (
  builder: Builder.Builder,
  self: Type,
): Effect.fn.Return<number, LlvmError> {
  return yield* inspect(builder, self, 'Type.integerBitWidth', (description) =>
    Result.gen(function* () {
      if (description._tag !== 'Integer') {
        return yield* Result.fail(
          invalidInput({
            operation: 'Type.integerBitWidth',
            message: 'Expected an integer type',
            input: self,
          }),
        )
      }
      return description.bitWidth
    }),
  )
})

/**
 * Reads the repeated child type of an array or vector.
 *
 * @category types
 * @since 0.0.0
 */
export const childType = Effect.fnUntraced(function* (
  builder: Builder.Builder,
  self: Type,
): Effect.fn.Return<Type, LlvmError> {
  return yield* inspect(builder, self, 'Type.childType', (description, state) =>
    Result.gen(function* () {
      if (description._tag !== 'Array' && description._tag !== 'Vector') {
        return yield* Result.fail(
          invalidInput({
            operation: 'Type.childType',
            message: 'Expected an array or vector type',
            input: self,
          }),
        )
      }
      return yield* Table.handleAt(state.types, description.child, 'Type.childType', 'Type')
    }),
  )
})

/**
 * Expands a function type into builder-owned return and parameter handles.
 *
 * @category types
 * @since 0.0.0
 */
export const functionSignature = Effect.fnUntraced(function* (
  builder: Builder.Builder,
  self: Type,
): Effect.fn.Return<FunctionSignature, LlvmError> {
  return yield* inspect(builder, self, 'Type.functionSignature', (description, state) =>
    Result.gen(function* () {
      if (description._tag !== 'Function') {
        return yield* Result.fail(
          invalidInput({
            operation: 'Type.functionSignature',
            message: 'Expected a function type',
            input: self,
          }),
        )
      }
      const parameters: Array<Type> = []
      for (const index of description.parameters) {
        parameters.push(yield* Table.handleAt(state.types, index, 'Type.functionSignature', 'Type'))
      }
      return {
        returnType: yield* Table.handleAt(
          state.types,
          description.returnType,
          'Type.functionSignature',
          'Type',
        ),
        parameters: parameters,
        variadic: description.variadic,
      }
    }),
  )
})

/**
 * Expands a complete aggregate into a uniform shape.
 *
 * **Details**
 *
 * Arrays and vectors expose one repeated field plus `length`; structures expose each field
 * and leave `length` undefined.
 *
 * **Gotchas**
 *
 * Opaque named structures fail until completed.
 *
 * @category types
 * @since 0.0.0
 */
export const aggregateShape = (
  builder: Builder.Builder,
  self: Type,
): Effect.Effect<AggregateShape, LlvmError> =>
  BuilderState.transition(builder, 'Type.aggregateShape', (context) =>
    aggregateShapeIn(context, self),
  )

/** @internal */
export const aggregateShapeIn = (
  context: BuilderState.Context,
  self: Type,
): Result.Result<AggregateShape, LlvmError> => {
  const state = context.state
  return Result.flatMap(
    ResolveActor.resolve(
      context.builder,
      context.owner,
      self,
      'Type',
      state.types,
      'Type.aggregateShape',
    ),
    ({ description }) =>
      Result.gen(function* () {
        if (description._tag === 'Array' || description._tag === 'Vector') {
          return {
            fields: [
              yield* Table.handleAt(state.types, description.child, 'Type.aggregateShape', 'Type'),
            ],
            packed: false,
            scalable: description._tag === 'Vector' && description.scalable,
            length: description._tag === 'Array' ? description.length : BigInt(description.length),
          }
        }
        let body: { readonly fields: ReadonlyArray<number>; readonly packed: boolean } | undefined
        if (description._tag === 'Structure') body = description
        else if (description._tag === 'NamedStructure') body = description.body
        if (body === undefined) {
          return yield* Result.fail(
            invalidInput({
              operation: 'Type.aggregateShape',
              message: 'Expected a complete aggregate type',
              input: self,
            }),
          )
        }
        const fields: Array<Type> = []
        for (const index of body.fields) {
          fields.push(yield* Table.handleAt(state.types, index, 'Type.aggregateShape', 'Type'))
        }
        return {
          fields: fields,
          packed: body.packed,
          scalable: false,
          length: undefined,
        }
      }),
  )
}

/** @internal */
const simpleBitWidth = (tag: TypeDescription.SimpleTag): number | undefined => {
  switch (tag) {
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
    case 'X86Amx':
      return 8192
    case 'Void':
    case 'Label':
    case 'Metadata':
    case 'Token':
      return undefined
  }
}

/** @internal */
const powerOfTwoCeiling = (value: bigint): bigint => {
  let power = 1n
  while (power < value) power *= 2n
  return power
}

/** @internal */
const layoutOf = (
  index: number,
  state: BuilderState.MutableState,
  visiting: Set<number>,
): {
  readonly bitSize: bigint
  readonly size: bigint
  readonly alignment: Alignment.Alignment
} => {
  if (visiting.has(index)) throw new Error('recursive type has no finite inline size')
  visiting.add(index)
  const description = state.types.descriptions[index]
  if (description === undefined) throw new Error('missing type table entry')
  try {
    if (description._tag === 'Integer') {
      const spec = DataLayout.effectiveIntegerSpec(state.layout, description.bitWidth)
      const storeSize = BigInt(Math.ceil(description.bitWidth / 8))
      const alignment = spec.abiAlignment.byteUnits
      if (alignment === undefined) throw new Error('effective integer alignment is unspecified')
      const remainder = storeSize % alignment
      return {
        bitSize: BigInt(description.bitWidth),
        size: remainder === 0n ? storeSize : storeSize + alignment - remainder,
        alignment: spec.abiAlignment,
      }
    }
    if (description._tag === 'Simple') {
      const bits = simpleBitWidth(description.tag)
      if (bits === undefined) throw new Error(`${description.tag} has no allocatable size`)
      const size = BigInt(Math.ceil(bits / 8))
      const spec = DataLayout.floatSpec(state.layout, bits)
      return {
        bitSize: BigInt(bits),
        size,
        alignment: spec?.abiAlignment ?? { _tag: 'Alignment', byteUnits: size },
      }
    }
    if (description._tag === 'Pointer') {
      const spec = DataLayout.pointerSpec(state.layout, description.addressSpace)
      if (spec === undefined) throw new Error('data layout has no pointer specification')
      return {
        bitSize: BigInt(spec.bitWidth),
        size: BigInt(Math.ceil(spec.bitWidth / 8)),
        alignment: spec.abiAlignment,
      }
    }
    if (description._tag === 'Array') {
      const child = layoutOf(description.child, state, visiting)
      const size = child.size * description.length
      return { bitSize: size * 8n, size, alignment: child.alignment }
    }
    if (description._tag === 'Vector') {
      if (description.scalable) throw new Error('scalable vector has no fixed allocation size')
      const child = layoutOf(description.child, state, visiting)
      const bitSize = child.bitSize * BigInt(description.length)
      const storeSize = (bitSize + 7n) / 8n
      const bitWidth = bitSize <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(bitSize) : undefined
      const vectorSpec =
        bitWidth === undefined ? undefined : DataLayout.vectorSpec(state.layout, bitWidth)
      const vectorAlignment: Alignment.Alignment = vectorSpec?.abiAlignment ?? {
        _tag: 'Alignment',
        byteUnits: powerOfTwoCeiling(storeSize),
      }
      const alignment = vectorAlignment.byteUnits ?? 1n
      const remainder = storeSize % alignment
      return {
        bitSize,
        size: remainder === 0n ? storeSize : storeSize + alignment - remainder,
        alignment: vectorAlignment,
      }
    }
    let body: { readonly fields: ReadonlyArray<number>; readonly packed: boolean } | undefined
    if (description._tag === 'Structure') body = description
    else if (description._tag === 'NamedStructure') body = description.body
    if (body !== undefined) {
      let offset = 0n
      let maximumAlignment = body.packed
        ? 1n
        : (state.layout.aggregate.abiAlignment.byteUnits ?? 1n)
      for (const field of body.fields) {
        const fieldLayout = layoutOf(field, state, visiting)
        const fieldAlignment = body.packed ? 1n : (fieldLayout.alignment.byteUnits ?? 1n)
        maximumAlignment = fieldAlignment > maximumAlignment ? fieldAlignment : maximumAlignment
        const remainder = offset % fieldAlignment
        if (remainder !== 0n) offset += fieldAlignment - remainder
        offset += fieldLayout.size
      }
      const remainder = offset % maximumAlignment
      if (remainder !== 0n) offset += maximumAlignment - remainder
      return {
        bitSize: offset * 8n,
        size: offset,
        alignment: { _tag: 'Alignment', byteUnits: maximumAlignment },
      }
    }
    throw new Error(`${description._tag} has no allocatable size`)
  } finally {
    visiting.delete(index)
  }
}

/**
 * Computes fixed allocation size in bytes from the builder's parsed data layout.
 *
 * **Gotchas**
 *
 * Recursive inline types, scalable vectors, unsized types, target extensions, and pointers without
 * a layout specification fail with {@link LlvmError}.
 *
 * @category types
 * @since 0.0.0
 */
export const sizeOf = Effect.fnUntraced(function* (
  builder: Builder.Builder,
  self: Type,
): Effect.fn.Return<bigint, LlvmError> {
  return yield* inspect(builder, self, 'Type.sizeOf', (_description, state, index) =>
    Result.try({
      try: () => layoutOf(index, state, new Set()).size,
      catch: (cause) =>
        wrappedFailure({
          operation: 'Type.sizeOf',
          message: 'Type has no fixed size',
          cause: cause,
        }),
    }),
  )
})

/**
 * Computes ABI alignment from the builder's parsed data layout, with the same sized-type constraints as {@link sizeOf}.
 *
 * @category types
 * @since 0.0.0
 */
export const alignmentOf = Effect.fnUntraced(function* (
  builder: Builder.Builder,
  self: Type,
): Effect.fn.Return<Alignment.Alignment, LlvmError> {
  return yield* inspect(builder, self, 'Type.alignmentOf', (_description, state, index) =>
    Result.try({
      try: () => layoutOf(index, state, new Set()).alignment,
      catch: (cause) =>
        wrappedFailure({
          operation: 'Type.alignmentOf',
          message: 'Type has no alignment',
          cause: cause,
        }),
    }),
  )
})
