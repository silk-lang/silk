import * as Effect from 'effect/Effect'
import * as Result from 'effect/Result'
import type * as ByteString from '../ByteString.js'
import * as Constant from '../Constant.js'
import type * as BuilderState from '../internal/BuilderState.js'
import * as FunctionBodyState from '../internal/FunctionBodyState.js'
import * as Handle from '../internal/Handle.js'
import { invalidInput, invalidState, type LlvmError } from '../LlvmError.js'
import * as Type from '../Type.js'
import type * as Value from '../Value.js'
import { type FunctionBody, sameOperands } from './_internal.js'

/** @internal */
const aggregatePath = (
  module: BuilderState.MutableState,
  root: number,
  indices: ReadonlyArray<number>,
  operation: string,
): Result.Result<number, LlvmError> => {
  if (indices.length === 0) {
    return Result.fail(
      invalidInput({ operation, message: 'Aggregate paths cannot be empty', input: indices }),
    )
  }
  let current = root
  for (const index of indices) {
    if (!Number.isSafeInteger(index) || index < 0) {
      return Result.fail(
        invalidInput({
          operation,
          message: 'Aggregate indices must be non-negative integers',
          input: index,
        }),
      )
    }
    const found = FunctionBodyState.typeAt(module, current, operation)
    if (Result.isFailure(found)) return Result.fail(found.failure)
    const description = found.success
    if (description._tag === 'Array' || description._tag === 'Vector') {
      const length = description._tag === 'Array' ? description.length : BigInt(description.length)
      if (BigInt(index) >= length) {
        return Result.fail(
          invalidInput({
            operation,
            message: 'Aggregate index is outside the aggregate',
            input: index,
          }),
        )
      }
      current = description.child
      continue
    }
    let fields: ReadonlyArray<number> | undefined
    if (description._tag === 'Structure') fields = description.fields
    else if (description._tag === 'NamedStructure') fields = description.body?.fields
    const field = fields?.[index]
    if (field === undefined) {
      return Result.fail(
        invalidInput({
          operation,
          message: 'Aggregate path does not select a field',
          input: indices,
        }),
      )
    }
    current = field
  }
  return Result.succeed(current)
}

/**
 * Extracts a value along a non-empty, statically indexed structure path.
 *
 * @category instructions
 * @since 0.0.0
 */
export const extractValue = (
  self: FunctionBody,
  aggregate: Value.Input,
  indices: ReadonlyArray<number>,
  name?: ByteString.ByteString | Uint8Array | string,
): Effect.Effect<Value.Value, LlvmError> =>
  FunctionBodyState.mutate(self, 'FunctionBody.extractValue', (draft) =>
    extractValueIn(draft, aggregate, indices, name),
  )

/** @internal */
export const extractValueIn = (
  draft: FunctionBodyState.Draft,
  aggregate: Value.Input,
  indices: ReadonlyArray<number>,
  name?: ByteString.ByteString | Uint8Array | string,
): Result.Result<Value.Value, LlvmError> => {
  const module = draft.module
  const operation = 'FunctionBody.extractValue'
  const resolved = FunctionBodyState.resolveOperand(draft, module, aggregate, operation)
  if (Result.isFailure(resolved)) return Result.fail(resolved.failure)
  const resultType = aggregatePath(module, resolved.success.type, indices, operation)
  if (Result.isFailure(resultType)) return Result.fail(resultType.failure)
  const aggregateOperand = resolved.success.operand
  const appended = FunctionBodyState.appendResult(
    draft,
    resultType.success,
    name,
    (result, finalName) => ({
      _tag: 'ExtractValue',
      aggregate: aggregateOperand,
      indices,
      result,
      name: finalName,
    }),
  )
  return appended
}

/**
 * Inserts a same-typed value along a validated aggregate path.
 *
 * @category instructions
 * @since 0.0.0
 */
export const insertValue = (
  self: FunctionBody,
  aggregate: Value.Input,
  element: Value.Input,
  indices: ReadonlyArray<number>,
  name?: ByteString.ByteString | Uint8Array | string,
): Effect.Effect<Value.Value, LlvmError> =>
  FunctionBodyState.mutate(self, 'FunctionBody.insertValue', (draft) =>
    insertValueIn(draft, aggregate, element, indices, name),
  )

/** @internal */
export const insertValueIn = (
  draft: FunctionBodyState.Draft,
  aggregate: Value.Input,
  element: Value.Input,
  indices: ReadonlyArray<number>,
  name?: ByteString.ByteString | Uint8Array | string,
): Result.Result<Value.Value, LlvmError> => {
  const module = draft.module
  const operation = 'FunctionBody.insertValue'
  const aggregateValue = FunctionBodyState.resolveOperand(draft, module, aggregate, operation)
  if (Result.isFailure(aggregateValue)) return Result.fail(aggregateValue.failure)
  const elementValue = FunctionBodyState.resolveOperand(draft, module, element, operation)
  if (Result.isFailure(elementValue)) return Result.fail(elementValue.failure)
  const selected = aggregatePath(module, aggregateValue.success.type, indices, operation)
  if (Result.isFailure(selected)) return Result.fail(selected.failure)
  if (elementValue.success.type !== selected.success) {
    return Result.fail(
      invalidInput({
        operation,
        message: 'Inserted value does not match the aggregate path type',
        input: { aggregate, element, indices },
      }),
    )
  }
  const aggregateOperand = aggregateValue.success.operand
  const elementOperand = elementValue.success.operand
  const appended = FunctionBodyState.appendResult(
    draft,
    aggregateValue.success.type,
    name,
    (result, finalName) => ({
      _tag: 'InsertValue',
      aggregate: aggregateOperand,
      element: elementOperand,
      indices,
      result,
      name: finalName,
    }),
  )
  return appended
}

/**
 * Builds an aggregate from a poison seed and a complete, exact sequence of element values.
 *
 * @category instructions
 * @since 0.0.0
 */
export const buildAggregate = (
  self: FunctionBody,
  type: Type.Type,
  elements: ReadonlyArray<Value.Input>,
  name?: ByteString.ByteString | Uint8Array | string,
): Effect.Effect<Value.Input, LlvmError> =>
  FunctionBodyState.mutate(self, 'FunctionBody.buildAggregate', (draft) =>
    buildAggregateIn(draft, type, elements, name),
  )

/** @internal */
export const buildAggregateIn = (
  draft: FunctionBodyState.Draft,
  type: Type.Type,
  elements: ReadonlyArray<Value.Input>,
  name?: ByteString.ByteString | Uint8Array | string,
): Result.Result<Value.Input, LlvmError> => {
  const shape = Type.aggregateShapeIn(draft.context, type)
  if (Result.isFailure(shape)) return Result.fail(shape.failure)
  const expectedLength =
    shape.success.length === undefined ? shape.success.fields.length : Number(shape.success.length)
  if (elements.length !== expectedLength) {
    return Result.fail(
      invalidInput({
        operation: 'FunctionBody.buildAggregate',
        message: 'Aggregate element count does not match its type',
        input: elements,
      }),
    )
  }
  const poison = Constant.specialIn(draft.context, type, 'poison')
  if (Result.isFailure(poison)) return Result.fail(poison.failure)
  let aggregate: Value.Input = poison.success
  for (let index = 0; index < elements.length; index += 1) {
    const element = elements[index]
    if (element === undefined) continue
    const inserted = insertValueIn(
      draft,
      aggregate,
      element,
      [index],
      index === elements.length - 1 ? name : undefined,
    )
    if (Result.isFailure(inserted)) return Result.fail(inserted.failure)
    aggregate = inserted.success
  }
  return Result.succeed(aggregate)
}

/**
 * Extracts one vector lane using a scalar integer index.
 *
 * @category instructions
 * @since 0.0.0
 */
export const extractElement = Effect.fnUntraced(function* (
  self: FunctionBody,
  vector: Value.Input,
  index: Value.Input,
  name?: ByteString.ByteString | Uint8Array | string,
): Effect.fn.Return<Value.Value, LlvmError> {
  return yield* FunctionBodyState.mutateModule(
    self,
    'FunctionBody.extractElement',
    (draft, module) =>
      Result.gen(function* () {
        const source = yield* FunctionBodyState.resolveOperand(
          draft,
          module,
          vector,
          'FunctionBody.extractElement',
        )
        const sourceType = yield* FunctionBodyState.typeAt(
          module,
          source.type,
          'FunctionBody.extractElement',
        )
        const selected = yield* FunctionBodyState.resolveOperand(
          draft,
          module,
          index,
          'FunctionBody.extractElement',
        )
        const selectedType = yield* FunctionBodyState.typeAt(
          module,
          selected.type,
          'FunctionBody.extractElement',
        )
        if (sourceType._tag !== 'Vector' || selectedType._tag !== 'Integer') {
          return yield* Result.fail(
            invalidInput({
              operation: 'FunctionBody.extractElement',
              message: 'extractelement requires a vector and scalar integer index',
              input: { vector, index },
            }),
          )
        }
        return yield* FunctionBodyState.appendResult(
          draft,
          sourceType.child,
          name,
          (result, finalName) => ({
            _tag: 'ExtractElement',
            vector: source.operand,
            index: selected.operand,
            result,
            name: finalName,
          }),
        )
      }),
  )
})

/**
 * Inserts a matching scalar into one vector lane selected by an integer index.
 *
 * @category instructions
 * @since 0.0.0
 */
export const insertElement = Effect.fnUntraced(function* (
  self: FunctionBody,
  vector: Value.Input,
  element: Value.Input,
  index: Value.Input,
  name?: ByteString.ByteString | Uint8Array | string,
): Effect.fn.Return<Value.Value, LlvmError> {
  return yield* FunctionBodyState.mutateModule(
    self,
    'FunctionBody.insertElement',
    (draft, module) =>
      Result.gen(function* () {
        const source = yield* FunctionBodyState.resolveOperand(
          draft,
          module,
          vector,
          'FunctionBody.insertElement',
        )
        const sourceType = yield* FunctionBodyState.typeAt(
          module,
          source.type,
          'FunctionBody.insertElement',
        )
        const inserted = yield* FunctionBodyState.resolveOperand(
          draft,
          module,
          element,
          'FunctionBody.insertElement',
        )
        const selected = yield* FunctionBodyState.resolveOperand(
          draft,
          module,
          index,
          'FunctionBody.insertElement',
        )
        const selectedType = yield* FunctionBodyState.typeAt(
          module,
          selected.type,
          'FunctionBody.insertElement',
        )
        if (
          sourceType._tag !== 'Vector' ||
          inserted.type !== sourceType.child ||
          selectedType._tag !== 'Integer'
        ) {
          return yield* Result.fail(
            invalidInput({
              operation: 'FunctionBody.insertElement',
              message: 'insertelement operands do not match the vector shape',
              input: { vector, element, index },
            }),
          )
        }
        return yield* FunctionBodyState.appendResult(
          draft,
          source.type,
          name,
          (result, finalName) => ({
            _tag: 'InsertElement',
            vector: source.operand,
            element: inserted.operand,
            index: selected.operand,
            result,
            name: finalName,
          }),
        )
      }),
  )
})

/**
 * Shuffles two same-shaped vectors with a fixed integer mask of compatible length.
 *
 * @category instructions
 * @since 0.0.0
 */
export const shuffleVector = Effect.fnUntraced(function* (
  self: FunctionBody,
  left: Value.Input,
  right: Value.Input,
  mask: Value.Input,
  name?: ByteString.ByteString | Uint8Array | string,
): Effect.fn.Return<Value.Value, LlvmError> {
  const builder = yield* FunctionBodyState.builder(self)
  const plan = yield* FunctionBodyState.mutateModule(
    self,
    'FunctionBody.shuffleVector',
    (draft, module) =>
      Result.gen(function* () {
        const values = yield* sameOperands(draft, module, left, right, 'FunctionBody.shuffleVector')
        const vector = yield* FunctionBodyState.typeAt(
          module,
          values.leftValue.type,
          'FunctionBody.shuffleVector',
        )
        const selected = yield* FunctionBodyState.resolveOperand(
          draft,
          module,
          mask,
          'FunctionBody.shuffleVector',
        )
        const maskType = yield* FunctionBodyState.typeAt(
          module,
          selected.type,
          'FunctionBody.shuffleVector',
        )
        if (
          vector._tag !== 'Vector' ||
          maskType._tag !== 'Vector' ||
          !(yield* FunctionBodyState.isIntegerType(
            module,
            selected.type,
            'FunctionBody.shuffleVector',
          )) ||
          vector.scalable !== maskType.scalable
        ) {
          return yield* Result.fail(
            invalidInput({
              operation: 'FunctionBody.shuffleVector',
              message: 'shufflevector requires compatible vectors and an integer vector mask',
              input: { left, right, mask },
            }),
          )
        }
        const child = module.types.handles[vector.child]
        if (child === undefined) {
          return yield* Result.fail(
            invalidState({
              operation: 'FunctionBody.shuffleVector',
              message: 'Vector child type handle is missing',
              state: vector,
            }),
          )
        }
        return {
          left: values.leftValue.operand,
          right: values.rightValue.operand,
          mask: selected.operand,
          child,
          length: maskType.length,
          scalable: maskType.scalable,
        }
      }),
  )
  const resultType = plan.scalable
    ? yield* Type.scalableVector(builder, plan.child, plan.length)
    : yield* Type.vector(builder, plan.child, plan.length)
  return yield* FunctionBodyState.mutateModule(self, 'FunctionBody.shuffleVector', (draft) =>
    Result.gen(function* () {
      const resultTypeIndex = yield* Handle.resolve(
        draft.builder,
        draft.moduleOwner,
        resultType,
        'Type',
        'FunctionBody.shuffleVector',
      )
      return yield* FunctionBodyState.appendResult(
        draft,
        resultTypeIndex,
        name,
        (result, finalName) => ({
          _tag: 'ShuffleVector',
          left: plan.left,
          right: plan.right,
          mask: plan.mask,
          result,
          name: finalName,
        }),
      )
    }),
  )
})

/**
 * Broadcasts a matching scalar across every lane of a fixed or scalable vector.
 *
 * @category instructions
 * @since 0.0.0
 */
export const splatVector = Effect.fnUntraced(function* (
  self: FunctionBody,
  vectorType: Type.Type,
  element: Value.Input,
  name?: ByteString.ByteString | Uint8Array | string,
): Effect.fn.Return<Value.Value, LlvmError> {
  const builder = yield* FunctionBodyState.builder(self)
  const shape = yield* Type.aggregateShape(builder, vectorType)
  if (shape.length === undefined || shape.fields.length !== 1) {
    return yield* invalidInput({
      operation: 'FunctionBody.splatVector',
      message: 'splatVector requires a vector result type',
      input: vectorType,
    })
  }
  const child = shape.fields[0]
  if (child === undefined) {
    return yield* invalidState({
      operation: 'FunctionBody.splatVector',
      message: 'Vector child is missing',
      state: vectorType,
    })
  }
  const scalarVector = shape.scalable
    ? yield* Type.scalableVector(builder, child, 1)
    : yield* Type.vector(builder, child, 1)
  const i32 = yield* Type.integer(builder, 32)
  const maskType = shape.scalable
    ? yield* Type.scalableVector(builder, i32, Number(shape.length))
    : yield* Type.vector(builder, i32, Number(shape.length))
  const zero = yield* Constant.integerUnsigned(builder, i32, 0)
  const scalarPoison = yield* Constant.poison(builder, scalarVector)
  const mask = yield* Constant.splat(builder, maskType, zero)
  const inserted = yield* insertElement(self, scalarPoison, element, zero)
  return yield* shuffleVector(self, inserted, scalarPoison, mask, name)
})
