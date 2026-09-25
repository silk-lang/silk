import * as Effect from 'effect/Effect'
import * as Result from 'effect/Result'
import * as AddrSpace from '../AddrSpace.js'
import * as Alignment from '../Alignment.js'
import * as ByteString from '../ByteString.js'
import * as Constant from '../Constant.js'
import * as FunctionBodyDescription from '../internal/FunctionBodyDescription.js'
import type * as BuilderState from '../internal/BuilderState.js'
import * as FunctionBodyState from '../internal/FunctionBodyState.js'
import * as Handle from '../internal/Handle.js'
import { invalidInput, invalidState, type LlvmError } from '../LlvmError.js'
import * as MemoryAccess from '../MemoryAccess.js'
import * as Type from '../Type.js'
import type * as Value from '../Value.js'
import type { FunctionBody, Instruction } from './_internal.js'

/**
 * Element count, alignment, address space, and `inalloca` settings for {@link alloca}.
 *
 * @category instructions
 * @since 0.0.0
 */
export interface AllocaOptions {
  readonly count?: Value.Input
  readonly alignment?: Alignment.Alignment
  readonly addressSpace?: AddrSpace.AddrSpace
  readonly inAlloca?: boolean
  /** Fixed-size function-lifetime storage. Requires a constant count and excludes `inalloca`. */
  readonly placement?: 'current' | 'entry'
}

/**
 * Bounds promises and optional in-range index for get-element-pointer operations.
 *
 * @category instructions
 * @since 0.0.0
 */
export interface GetElementPtrOptions {
  readonly inbounds?: boolean
  readonly inrange?: number
}

/**
 * Memory-access settings plus mandatory failure ordering for {@link compareExchange}.
 *
 * @category instructions
 * @since 0.0.0
 */
export interface CompareExchangeOptions extends MemoryAccess.Input {
  readonly failureOrdering: Exclude<
    MemoryAccess.AtomicOrdering,
    'none' | 'unordered' | 'release' | 'acq_rel'
  >
  readonly weak?: boolean
}

/** @internal */
const defaultAccess: FunctionBodyDescription.MemoryInfo = accessOf(MemoryAccess.make({}))

function accessOf(access: MemoryAccess.MemoryAccess): FunctionBodyDescription.MemoryInfo {
  return {
    kind: access.kind,
    alignment: access.alignment,
    syncScope: access.syncScope,
    ordering: access.ordering,
  }
}

const accessInfo = (input: MemoryAccess.Input): FunctionBodyDescription.MemoryInfo =>
  input.kind === undefined &&
  input.alignment === undefined &&
  input.syncScope === undefined &&
  input.ordering === undefined
    ? defaultAccess
    : accessOf(MemoryAccess.make(input))

const failInput = (operation: string, message: string, input: unknown) =>
  Result.fail(invalidInput({ operation, message, input }))

/**
 * Appends stack allocation for a sized element type and optional integer count.
 *
 * With `placement: 'entry'`, inserts the allocation before the entry block's terminator
 * without moving the active insertion point. This keeps fixed-size call-boundary storage
 * outside loops. Its count must be constant; `inalloca` retains its current-block lifetime.
 *
 * Memory instructions are emitted on nearly every lowered operation, so each completes in one
 * plain body transition instead of nested generators (self-hosted compiler build profile).
 *
 * @category instructions
 * @since 0.0.0
 */
export const alloca = (
  self: FunctionBody,
  allocationType: Type.Type,
  name?: ByteString.ByteString | Uint8Array | string,
  options: AllocaOptions = {},
): Effect.Effect<Value.Value, LlvmError> =>
  FunctionBodyState.mutate(self, 'FunctionBody.alloca', (draft) =>
    allocaIn(draft, allocationType, name, options),
  )

/** @internal */
export const allocaIn = (
  draft: FunctionBodyState.Draft,
  allocationType: Type.Type,
  name?: ByteString.ByteString | Uint8Array | string,
  options: AllocaOptions = {},
): Result.Result<Value.Value, LlvmError> => {
  const module = draft.module
  const operation = 'FunctionBody.alloca'
  // Intern the result pointer type and default count first, matching the table order of the
  // standalone type and constant requests this transition replaces.
  const addressSpace = options.addressSpace ?? AddrSpace.defaultAddrSpace
  const resultType = Type.internIndex(module, draft.moduleOwner, {
    _tag: 'Pointer',
    addressSpace,
  })
  let count: Value.Input
  if (options.count === undefined) {
    const i32 = Type.internIndex(module, draft.moduleOwner, { _tag: 'Integer', bitWidth: 32 })
    const one = Constant.integerIn(module, draft.moduleOwner, i32, 1n, false, i32)
    if (Result.isFailure(one)) return Result.fail(one.failure)
    count = one.success
  } else count = options.count
  const allocationTypeIndex = Handle.resolve(
    draft.builder,
    draft.moduleOwner,
    allocationType,
    'Type',
    operation,
  )
  if (Result.isFailure(allocationTypeIndex)) return Result.fail(allocationTypeIndex.failure)
  const allocation = FunctionBodyState.typeAt(module, allocationTypeIndex.success, operation)
  if (Result.isFailure(allocation)) return Result.fail(allocation.failure)
  if (
    allocation.success._tag === 'Simple' &&
    (allocation.success.tag === 'Void' || allocation.success.tag === 'Label')
  ) {
    return failInput(operation, 'alloca requires an allocatable value type', allocationType)
  }
  if (allocation.success._tag === 'Function') {
    return failInput(operation, 'alloca cannot allocate a function type', allocationType)
  }
  const countValue = FunctionBodyState.resolveOperand(draft, module, count, operation)
  if (Result.isFailure(countValue)) return Result.fail(countValue.failure)
  const countIsInteger = FunctionBodyState.isIntegerType(module, countValue.success.type, operation)
  if (Result.isFailure(countIsInteger)) return Result.fail(countIsInteger.failure)
  if (!countIsInteger.success) {
    return failInput(operation, 'alloca count must have integer type', count)
  }
  if (
    options.placement === 'entry' &&
    (countValue.success.operand._tag !== 'Constant' || options.inAlloca === true)
  ) {
    return failInput(
      operation,
      'Entry allocation requires a constant count and cannot use inalloca',
      options,
    )
  }
  const countOperand = countValue.success.operand
  const allocated = FunctionBodyState.appendResult(
    draft,
    resultType,
    name,
    (result, finalName) => ({
      _tag: 'Alloca',
      allocationType: allocationTypeIndex.success,
      count: countOperand,
      addressSpace: addressSpace.value,
      alignment: options.alignment ?? Alignment.defaultAlignment,
      inAlloca: options.inAlloca ?? false,
      result,
      name: finalName,
    }),
  )
  if (Result.isFailure(allocated)) return Result.fail(allocated.failure)
  if (options.placement === 'entry' && draft.cursor !== 0) {
    const current = draft.cursor === undefined ? undefined : draft.blocks.at(draft.cursor)
    const entry = draft.blocks.at(0)
    const index = current?.instructions.pop()
    if (entry === undefined || index === undefined)
      return Result.fail(
        invalidState({
          operation,
          message: 'Entry allocation lost its block',
          state: draft.cursor,
        }),
      )
    const last = entry.instructions.at(-1)
    const terminator = last === undefined ? undefined : draft.instructions.at(last)
    entry.instructions.splice(
      entry.instructions.length -
        (terminator !== undefined && FunctionBodyDescription.isTerminator(terminator) ? 1 : 0),
      0,
      index,
    )
  }
  return Result.succeed(allocated.success)
}

/**
 * Appends a typed load from a pointer or vector of pointers after ordering validation.
 *
 * @category instructions
 * @since 0.0.0
 */
export const load = (
  self: FunctionBody,
  valueType: Type.Type,
  pointer: Value.Input,
  name?: ByteString.ByteString | Uint8Array | string,
  options: MemoryAccess.Input = {},
): Effect.Effect<Value.Value, LlvmError> =>
  FunctionBodyState.mutate(self, 'FunctionBody.load', (draft) =>
    loadIn(draft, valueType, pointer, name, options),
  )

/** @internal */
export const loadIn = (
  draft: FunctionBodyState.Draft,
  valueType: Type.Type,
  pointer: Value.Input,
  name?: ByteString.ByteString | Uint8Array | string,
  options: MemoryAccess.Input = {},
): Result.Result<Value.Value, LlvmError> => {
  const access = accessInfo(options)
  if (access.ordering === 'release' || access.ordering === 'acq_rel') {
    return failInput(
      'MemoryAccess.validateLoadOrdering',
      'Atomic loads cannot use release or acq_rel ordering',
      access.ordering,
    )
  }
  const module = draft.module
  const operation = 'FunctionBody.load'
  const pointerValue = FunctionBodyState.resolveOperand(draft, module, pointer, operation)
  if (Result.isFailure(pointerValue)) return Result.fail(pointerValue.failure)
  const isPointer = FunctionBodyState.isPointerType(module, pointerValue.success.type, operation)
  if (Result.isFailure(isPointer)) return Result.fail(isPointer.failure)
  if (!isPointer.success) return failInput(operation, 'load requires a pointer operand', pointer)
  const type = Handle.resolve(draft.builder, draft.moduleOwner, valueType, 'Type', operation)
  if (Result.isFailure(type)) return Result.fail(type.failure)
  const pointerOperand = pointerValue.success.operand
  return FunctionBodyState.appendResult(draft, type.success, name, (result, finalName) => ({
    _tag: 'Load',
    valueType: type.success,
    pointer: pointerOperand,
    access,
    result,
    name: finalName,
  }))
}

/**
 * Appends a store to a pointer after validating atomic ordering and alignment settings.
 *
 * @category instructions
 * @since 0.0.0
 */
export const store = (
  self: FunctionBody,
  value: Value.Input,
  pointer: Value.Input,
  options: MemoryAccess.Input = {},
): Effect.Effect<Instruction, LlvmError> =>
  FunctionBodyState.mutate(self, 'FunctionBody.store', (draft) =>
    storeIn(draft, value, pointer, options),
  )

/** @internal */
export const storeIn = (
  draft: FunctionBodyState.Draft,
  value: Value.Input,
  pointer: Value.Input,
  options: MemoryAccess.Input = {},
): Result.Result<Instruction, LlvmError> => {
  const access = accessInfo(options)
  if (access.ordering === 'acquire' || access.ordering === 'acq_rel') {
    return failInput(
      'MemoryAccess.validateStoreOrdering',
      'Atomic stores require monotonic, release, or seq_cst ordering',
      access.ordering,
    )
  }
  const module = draft.module
  const operation = 'FunctionBody.store'
  const stored = FunctionBodyState.resolveOperand(draft, module, value, operation)
  if (Result.isFailure(stored)) return Result.fail(stored.failure)
  const destination = FunctionBodyState.resolveOperand(draft, module, pointer, operation)
  if (Result.isFailure(destination)) return Result.fail(destination.failure)
  const isPointer = FunctionBodyState.isPointerType(module, destination.success.type, operation)
  if (Result.isFailure(isPointer)) return Result.fail(isPointer.failure)
  if (!isPointer.success) {
    return failInput(operation, 'store requires a pointer destination', pointer)
  }
  return FunctionBodyState.appendInstruction(draft, {
    _tag: 'Store',
    value: stored.success.operand,
    pointer: destination.success.operand,
    access,
    result: undefined,
    name: ByteString.empty,
  })
}

interface GepPlan {
  readonly sourceType: number
  readonly base: FunctionBodyDescription.Operand
  readonly indices: ReadonlyArray<FunctionBodyDescription.Operand>
  readonly pointerType: number
  readonly pointerScalarType: number
  readonly baseIsVector: boolean
  readonly vector: { readonly length: number; readonly scalable: boolean } | undefined
}

/** @internal */
const gepPlan = (
  draft: FunctionBodyState.Draft,
  module: BuilderState.MutableState,
  sourceType: Type.Type,
  base: Value.Input,
  indices: ReadonlyArray<Value.Input>,
  options: GetElementPtrOptions,
): Result.Result<GepPlan, LlvmError> => {
  const operation = 'FunctionBody.getElementPtr'
  if (indices.length === 0) {
    return failInput(operation, 'getelementptr requires at least one index', indices)
  }
  if (
    options.inrange !== undefined &&
    (!Number.isSafeInteger(options.inrange) ||
      options.inrange < 0 ||
      options.inrange >= indices.length)
  ) {
    return failInput(operation, 'inrange must identify an existing GEP index', options.inrange)
  }
  const source = Handle.resolve(draft.builder, draft.moduleOwner, sourceType, 'Type', operation)
  if (Result.isFailure(source)) return Result.fail(source.failure)
  const pointer = FunctionBodyState.resolveOperand(draft, module, base, operation)
  if (Result.isFailure(pointer)) return Result.fail(pointer.failure)
  const pointerDescription = FunctionBodyState.typeAt(module, pointer.success.type, operation)
  if (Result.isFailure(pointerDescription)) return Result.fail(pointerDescription.failure)
  const pointerVector =
    pointerDescription.success._tag === 'Vector' ? pointerDescription.success : undefined
  const pointerScalar =
    pointerVector === undefined
      ? pointerDescription
      : FunctionBodyState.typeAt(module, pointerVector.child, operation)
  if (Result.isFailure(pointerScalar)) return Result.fail(pointerScalar.failure)
  if (pointerScalar.success._tag !== 'Pointer') {
    return failInput(operation, 'getelementptr base must be a pointer or vector of pointers', base)
  }
  let current = source.success
  let vector =
    pointerVector === undefined
      ? undefined
      : { length: pointerVector.length, scalable: pointerVector.scalable }
  const resolved: Array<FunctionBodyDescription.Operand> = []
  for (let position = 0; position < indices.length; position += 1) {
    const input = indices[position]
    if (input === undefined) continue
    const index = FunctionBodyState.resolveOperand(draft, module, input, operation)
    if (Result.isFailure(index)) return Result.fail(index.failure)
    const indexType = FunctionBodyState.typeAt(module, index.success.type, operation)
    if (Result.isFailure(indexType)) return Result.fail(indexType.failure)
    const indexVector = indexType.success._tag === 'Vector' ? indexType.success : undefined
    const indexScalar =
      indexVector === undefined
        ? indexType
        : FunctionBodyState.typeAt(module, indexVector.child, operation)
    if (Result.isFailure(indexScalar)) return Result.fail(indexScalar.failure)
    if (indexScalar.success._tag !== 'Integer') {
      return failInput(operation, 'getelementptr indices must be integer scalars or vectors', input)
    }
    if (indexVector !== undefined) {
      if (
        vector !== undefined &&
        (vector.length !== indexVector.length || vector.scalable !== indexVector.scalable)
      ) {
        return failInput(operation, 'Vector GEP operands must have one vector shape', input)
      }
      vector = { length: indexVector.length, scalable: indexVector.scalable }
    }
    const operand = index.success.operand
    if (position === 0) {
      resolved.push(operand)
      continue
    }
    const aggregate = FunctionBodyState.typeAt(module, current, operation)
    if (Result.isFailure(aggregate)) return Result.fail(aggregate.failure)
    if (aggregate.success._tag === 'Array' || aggregate.success._tag === 'Vector') {
      current = aggregate.success.child
      resolved.push(operand)
      continue
    }
    let body: { readonly fields: ReadonlyArray<number>; readonly packed: boolean } | undefined
    if (aggregate.success._tag === 'Structure') body = aggregate.success
    else if (aggregate.success._tag === 'NamedStructure') body = aggregate.success.body
    if (body === undefined || operand._tag !== 'Constant') {
      return failInput(operation, 'Structure GEP indices must be exact integer constants', input)
    }
    const constant = module.constants.descriptions[operand.constant]
    const field =
      constant?._tag === 'Integer' && constant.bitPattern <= BigInt(Number.MAX_SAFE_INTEGER)
        ? body.fields[Number(constant.bitPattern)]
        : undefined
    if (field === undefined) {
      return failInput(operation, 'Structure GEP index is outside the selected aggregate', input)
    }
    current = field
    resolved.push(operand)
  }
  return Result.succeed({
    sourceType: source.success,
    base: pointer.success.operand,
    indices: resolved,
    pointerType: pointer.success.type,
    pointerScalarType: pointerVector === undefined ? pointer.success.type : pointerVector.child,
    baseIsVector: pointerVector !== undefined,
    vector,
  })
}

/**
 * Appends scalar or vector `getelementptr` with fully typed dynamic indices.
 *
 * **Gotchas**
 *
 * Aggregate paths, integer index types, vector shapes, and `inrange` bounds are validated
 * before the instruction is appended. Use {@link structuredGetElementPtr} for numeric field paths.
 *
 * @category instructions
 * @since 0.0.0
 */
export const getElementPtr = (
  self: FunctionBody,
  sourceType: Type.Type,
  base: Value.Input,
  indices: ReadonlyArray<Value.Input>,
  name?: ByteString.ByteString | Uint8Array | string,
  options: GetElementPtrOptions = {},
): Effect.Effect<Value.Value, LlvmError> =>
  FunctionBodyState.mutate(self, 'FunctionBody.getElementPtr', (draft) =>
    getElementPtrIn(draft, sourceType, base, indices, name, options),
  )

/** @internal */
export const getElementPtrIn = (
  draft: FunctionBodyState.Draft,
  sourceType: Type.Type,
  base: Value.Input,
  indices: ReadonlyArray<Value.Input>,
  name?: ByteString.ByteString | Uint8Array | string,
  options: GetElementPtrOptions = {},
): Result.Result<Value.Value, LlvmError> => {
  const module = draft.module
  const plan = gepPlan(draft, module, sourceType, base, indices, options)
  if (Result.isFailure(plan)) return Result.fail(plan.failure)
  const { vector } = plan.success
  const resultType =
    vector !== undefined && !plan.success.baseIsVector
      ? Type.internIndex(module, draft.moduleOwner, {
          _tag: 'Vector',
          child: plan.success.pointerScalarType,
          length: vector.length,
          scalable: vector.scalable,
        })
      : plan.success.pointerType
  const appended = FunctionBodyState.appendResult(draft, resultType, name, (result, finalName) => ({
    _tag: 'GetElementPtr',
    sourceType: plan.success.sourceType,
    base: plan.success.base,
    indices: plan.success.indices,
    inbounds: options.inbounds ?? false,
    inrange: options.inrange,
    result,
    name: finalName,
  }))
  return appended
}

/**
 * Converts numeric aggregate indices to constants and delegates to {@link getElementPtr}.
 *
 * @category instructions
 * @since 0.0.0
 */
export const structuredGetElementPtr = (
  self: FunctionBody,
  sourceType: Type.Type,
  base: Value.Input,
  fields: ReadonlyArray<number>,
  name?: ByteString.ByteString | Uint8Array | string,
  options: GetElementPtrOptions = {},
): Effect.Effect<Value.Value, LlvmError> =>
  FunctionBodyState.mutate(self, 'FunctionBody.structuredGetElementPtr', (draft) =>
    structuredGetElementPtrIn(draft, sourceType, base, fields, name, options),
  )

/** @internal */
export const structuredGetElementPtrIn = (
  draft: FunctionBodyState.Draft,
  sourceType: Type.Type,
  base: Value.Input,
  fields: ReadonlyArray<number>,
  name?: ByteString.ByteString | Uint8Array | string,
  options: GetElementPtrOptions = {},
): Result.Result<Value.Value, LlvmError> => {
  const i32 = Type.internIndex(draft.module, draft.moduleOwner, { _tag: 'Integer', bitWidth: 32 })
  const indices: Array<Constant.Constant> = []
  for (const field of [0, ...fields]) {
    if (!Number.isSafeInteger(field) || field < 0) {
      return failInput(
        'FunctionBody.structuredGetElementPtr',
        'Structured GEP fields must be non-negative integers',
        field,
      )
    }
    const index = Constant.integerIn(
      draft.module,
      draft.moduleOwner,
      i32,
      BigInt(field),
      false,
      i32,
    )
    if (Result.isFailure(index)) return Result.fail(index.failure)
    indices.push(index.success)
  }
  return getElementPtrIn(draft, sourceType, base, indices, name, options)
}

/**
 * Appends an atomic fence with acquire-or-stronger validated ordering.
 *
 * @category instructions
 * @since 0.0.0
 */
export const fence = Effect.fnUntraced(function* (
  self: FunctionBody,
  ordering: Exclude<MemoryAccess.AtomicOrdering, 'none' | 'unordered' | 'monotonic'>,
  syncScope: MemoryAccess.SyncScope = 'system',
): Effect.fn.Return<Instruction, LlvmError> {
  yield* MemoryAccess.validateFenceOrdering(ordering)
  return yield* FunctionBodyState.mutate(self, 'FunctionBody.fence', (draft) =>
    FunctionBodyState.appendInstruction(draft, {
      _tag: 'Fence',
      syncScope,
      ordering,
      result: undefined,
      name: ByteString.empty,
    }),
  )
})

/**
 * Appends `cmpxchg` and returns LLVM's `{ value, i1 }` result structure.
 *
 * **Gotchas**
 *
 * The failure ordering may not contain release semantics and may not be stronger than the
 * success ordering. Pointer, expected, and replacement types must agree.
 *
 * @category instructions
 * @since 0.0.0
 */
export const compareExchange = Effect.fnUntraced(function* (
  self: FunctionBody,
  pointer: Value.Input,
  comparison: Value.Input,
  replacement: Value.Input,
  name?: ByteString.ByteString | Uint8Array | string,
  options: CompareExchangeOptions = { failureOrdering: 'monotonic' },
): Effect.fn.Return<Value.Value, LlvmError> {
  const access = accessInfo({ ...options, ordering: options.ordering ?? 'monotonic' })
  yield* MemoryAccess.validateCompareExchange(access.ordering, options.failureOrdering)
  const builder = yield* FunctionBodyState.builder(self)
  const comparisonType = yield* FunctionBodyState.mutateModule(
    self,
    'FunctionBody.compareExchange',
    (draft, module) =>
      Result.gen(function* () {
        const value = yield* FunctionBodyState.resolveOperand(
          draft,
          module,
          comparison,
          'FunctionBody.compareExchange',
        )
        const handle = module.types.handles[value.type]
        if (handle === undefined) {
          return yield* Result.fail(
            invalidState({
              operation: 'FunctionBody.compareExchange',
              message: 'Comparison type handle is missing',
              state: comparison,
            }),
          )
        }
        return handle
      }),
  )
  const resultType = yield* Type.structure(builder, [
    comparisonType,
    yield* Type.integer(builder, 1),
  ])
  return yield* FunctionBodyState.mutateModule(
    self,
    'FunctionBody.compareExchange',
    (draft, module) =>
      Result.gen(function* () {
        const address = yield* FunctionBodyState.resolveOperand(
          draft,
          module,
          pointer,
          'FunctionBody.compareExchange',
        )
        const expected = yield* FunctionBodyState.resolveOperand(
          draft,
          module,
          comparison,
          'FunctionBody.compareExchange',
        )
        const desired = yield* FunctionBodyState.resolveOperand(
          draft,
          module,
          replacement,
          'FunctionBody.compareExchange',
        )
        if (
          !(yield* FunctionBodyState.isPointerType(
            module,
            address.type,
            'FunctionBody.compareExchange',
          )) ||
          expected.type !== desired.type
        ) {
          return yield* Result.fail(
            invalidInput({
              operation: 'FunctionBody.compareExchange',
              message: 'cmpxchg requires a pointer and matching comparison/replacement values',
              input: { pointer, comparison, replacement },
            }),
          )
        }
        const type = yield* Handle.resolve(
          draft.builder,
          draft.moduleOwner,
          resultType,
          'Type',
          'FunctionBody.compareExchange',
        )
        return yield* FunctionBodyState.appendResult(draft, type, name, (result, finalName) => ({
          _tag: 'CompareExchange',
          pointer: address.operand,
          comparison: expected.operand,
          replacement: desired.operand,
          access,
          failureOrdering: options.failureOrdering,
          weak: options.weak ?? false,
          result,
          name: finalName,
        }))
      }),
  )
})

/**
 * Appends a type-compatible atomic read-modify-write with at least monotonic ordering.
 *
 * @category instructions
 * @since 0.0.0
 */
export const atomicRmw = Effect.fnUntraced(function* (
  self: FunctionBody,
  operation: MemoryAccess.AtomicOperation,
  pointer: Value.Input,
  value: Value.Input,
  name?: ByteString.ByteString | Uint8Array | string,
  options: MemoryAccess.Input = { ordering: 'monotonic' },
): Effect.fn.Return<Value.Value, LlvmError> {
  const access = accessInfo({ ...options, ordering: options.ordering ?? 'monotonic' })
  yield* MemoryAccess.validateRmwOrdering(access.ordering)
  return yield* FunctionBodyState.mutateModule(self, 'FunctionBody.atomicRmw', (draft, module) =>
    Result.gen(function* () {
      const address = yield* FunctionBodyState.resolveOperand(
        draft,
        module,
        pointer,
        'FunctionBody.atomicRmw',
      )
      const operand = yield* FunctionBodyState.resolveOperand(
        draft,
        module,
        value,
        'FunctionBody.atomicRmw',
      )
      if (
        !(yield* FunctionBodyState.isPointerType(module, address.type, 'FunctionBody.atomicRmw'))
      ) {
        return yield* Result.fail(
          invalidInput({
            operation: 'FunctionBody.atomicRmw',
            message: 'atomicrmw requires a pointer operand',
            input: pointer,
          }),
        )
      }
      const floating =
        operation === 'fadd' || operation === 'fsub' || operation === 'fmax' || operation === 'fmin'
      if (
        floating
          ? !(yield* FunctionBodyState.isFloatingType(
              module,
              operand.type,
              'FunctionBody.atomicRmw',
            ))
          : !(yield* FunctionBodyState.isIntegerType(
              module,
              operand.type,
              'FunctionBody.atomicRmw',
            )) && operation !== 'xchg'
      ) {
        return yield* Result.fail(
          invalidInput({
            operation: 'FunctionBody.atomicRmw',
            message: 'atomicrmw operation is incompatible with the value type',
            input: { operation, value },
          }),
        )
      }
      return yield* FunctionBodyState.appendResult(
        draft,
        operand.type,
        name,
        (result, finalName) => ({
          _tag: 'AtomicRmw',
          operation,
          pointer: address.operand,
          value: operand.operand,
          access,
          result,
          name: finalName,
        }),
      )
    }),
  )
})

/**
 * Appends `va_arg` from a pointer-like list value and explicit result type.
 *
 * @category instructions
 * @since 0.0.0
 */
export const vaArg = Effect.fnUntraced(function* (
  self: FunctionBody,
  list: Value.Input,
  valueType: Type.Type,
  name?: ByteString.ByteString | Uint8Array | string,
): Effect.fn.Return<Value.Value, LlvmError> {
  return yield* FunctionBodyState.mutateModule(self, 'FunctionBody.vaArg', (draft, module) =>
    Result.gen(function* () {
      const source = yield* FunctionBodyState.resolveOperand(
        draft,
        module,
        list,
        'FunctionBody.vaArg',
      )
      if (!(yield* FunctionBodyState.isPointerType(module, source.type, 'FunctionBody.vaArg'))) {
        return yield* Result.fail(
          invalidInput({
            operation: 'FunctionBody.vaArg',
            message: 'va_arg requires a pointer list operand',
            input: list,
          }),
        )
      }
      const type = yield* Handle.resolve(
        draft.builder,
        draft.moduleOwner,
        valueType,
        'Type',
        'FunctionBody.vaArg',
      )
      return yield* FunctionBodyState.appendResult(draft, type, name, (result, finalName) => ({
        _tag: 'VaArg',
        list: source.operand,
        valueType: type,
        result,
        name: finalName,
      }))
    }),
  )
})
