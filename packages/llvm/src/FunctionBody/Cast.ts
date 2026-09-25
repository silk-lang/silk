import * as Effect from 'effect/Effect'
import * as Result from 'effect/Result'
import type * as ByteString from '../ByteString.js'
import type * as BuilderState from '../internal/BuilderState.js'
import type * as FunctionBodyDescription from '../internal/FunctionBodyDescription.js'
import * as FunctionBodyState from '../internal/FunctionBodyState.js'
import * as Handle from '../internal/Handle.js'
import { invalidInput, type LlvmError } from '../LlvmError.js'
import type * as Type from '../Type.js'
import type * as Value from '../Value.js'
import type { FunctionBody } from './_internal.js'

/**
 * Scalar and vector conversion operations accepted by {@link cast}.
 *
 * @category instructions
 * @since 0.0.0
 */
export type CastKind = FunctionBodyDescription.CastKind

/**
 * No-wrap promises supported by compatible cast operations.
 *
 * @category instructions
 * @since 0.0.0
 */
export interface CastOptions {
  readonly noSignedWrap?: boolean
  readonly noUnsignedWrap?: boolean
}

/** @internal */
interface ScalarClass {
  readonly integer: boolean
  readonly floating: boolean
  readonly pointer: boolean
  readonly width: number | undefined
}

const floatingWidth = (tag: string): number | undefined => {
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
    default:
      return undefined
  }
}

/** Classifies a scalar or vector element type once for every cast legality check. */
const classify = (
  module: BuilderState.MutableState,
  type: number,
): Result.Result<ScalarClass, LlvmError> => {
  const description = FunctionBodyState.typeAt(module, type, 'FunctionBody.cast')
  if (Result.isFailure(description)) return Result.fail(description.failure)
  const scalar =
    description.success._tag === 'Vector'
      ? FunctionBodyState.typeAt(module, description.success.child, 'FunctionBody.cast')
      : description
  if (Result.isFailure(scalar)) return Result.fail(scalar.failure)
  const value = scalar.success
  if (value._tag === 'Integer') {
    return Result.succeed({ integer: true, floating: false, pointer: false, width: value.bitWidth })
  }
  const width = value._tag === 'Simple' ? floatingWidth(value.tag) : undefined
  return Result.succeed({
    integer: false,
    floating: width !== undefined,
    pointer: value._tag === 'Pointer',
    width,
  })
}

export const cast = (
  self: FunctionBody,
  kind: CastKind,
  operand: Value.Input,
  destinationType: Type.Type,
  name?: ByteString.ByteString | Uint8Array | string,
  options: CastOptions = {},
): Effect.Effect<Value.Input, LlvmError> =>
  FunctionBodyState.mutate(self, 'FunctionBody.cast', (draft) =>
    castIn(draft, kind, operand, destinationType, name, options),
  )

/** @internal */
export const castIn = (
  draft: FunctionBodyState.Draft,
  kind: CastKind,
  operand: Value.Input,
  destinationType: Type.Type,
  name?: ByteString.ByteString | Uint8Array | string,
  options: CastOptions = {},
): Result.Result<Value.Input, LlvmError> => {
  const module = draft.module
  const operation = 'FunctionBody.cast'
  const source = FunctionBodyState.resolveOperand(draft, module, operand, operation)
  if (Result.isFailure(source)) return Result.fail(source.failure)
  const destination = Handle.resolve(
    draft.builder,
    draft.moduleOwner,
    destinationType,
    'Type',
    operation,
  )
  if (Result.isFailure(destination)) return Result.fail(destination.failure)
  if (source.success.type === destination.success) return Result.succeed(operand)
  const from = classify(module, source.success.type)
  if (Result.isFailure(from)) return Result.fail(from.failure)
  const to = classify(module, destination.success)
  if (Result.isFailure(to)) return Result.fail(to.failure)
  const sourceWidth = from.success.width ?? 0
  const destinationWidth = to.success.width ?? 0
  const valid =
    (kind === 'trunc' &&
      from.success.integer &&
      to.success.integer &&
      sourceWidth > destinationWidth) ||
    ((kind === 'zext' || kind === 'sext') &&
      from.success.integer &&
      to.success.integer &&
      sourceWidth < destinationWidth) ||
    ((kind === 'fptoui' || kind === 'fptosi') && from.success.floating && to.success.integer) ||
    ((kind === 'uitofp' || kind === 'sitofp') && from.success.integer && to.success.floating) ||
    (kind === 'fptrunc' &&
      from.success.floating &&
      to.success.floating &&
      sourceWidth > destinationWidth) ||
    (kind === 'fpext' &&
      from.success.floating &&
      to.success.floating &&
      sourceWidth < destinationWidth) ||
    (kind === 'ptrtoint' && from.success.pointer && to.success.integer) ||
    (kind === 'inttoptr' && from.success.integer && to.success.pointer) ||
    (kind === 'bitcast' &&
      (from.success.width === to.success.width || (from.success.pointer && to.success.pointer))) ||
    (kind === 'addrspacecast' && from.success.pointer && to.success.pointer)
  if (!valid) {
    return Result.fail(
      invalidInput({
        operation,
        message: `${kind} is invalid for the source and destination types`,
        input: { operand, destinationType },
      }),
    )
  }
  if ((options.noSignedWrap || options.noUnsignedWrap) && kind !== 'trunc') {
    return Result.fail(
      invalidInput({
        operation,
        message: 'No-wrap cast flags are only valid on trunc',
        input: kind,
      }),
    )
  }
  const sourceOperand = source.success.operand
  const appended = FunctionBodyState.appendResult(
    draft,
    destination.success,
    name,
    (result, finalName) => ({
      _tag: 'Cast',
      kind,
      operand: sourceOperand,
      destinationType: destination.success,
      noSignedWrap: options.noSignedWrap ?? false,
      noUnsignedWrap: options.noUnsignedWrap ?? false,
      result,
      name: finalName,
    }),
  )
  return appended
}
