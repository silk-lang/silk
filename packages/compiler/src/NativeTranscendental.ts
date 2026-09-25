import * as Emitter from '@silklang/llvm/Emitter'
import * as FunctionBody from '@silklang/llvm/FunctionBody'
import type * as LlvmType from '@silklang/llvm/Type'
import type * as Value from '@silklang/llvm/Value'
import * as FloatingPoint from './FloatingPoint.js'
import type * as Mir from './Mir.js'
import * as Scalar from './Scalar.js'
import * as Transcendental from './Transcendental.js'

export interface Context {
  readonly builder: Emitter.Module
  readonly i32: LlvmType.Type
  readonly i64?: LlvmType.Type
  readonly f32: LlvmType.Type
  readonly f64: LlvmType.Type
}

/** Emits the shared deterministic range-reduction and polynomial kernel for native sin/cos. */
export const emit = (
  self: Context,
  body: Emitter.Body,
  operation: Extract<Mir.Operation, { readonly _tag: 'FloatTranscendental' }>,
  subject: Value.Input,
) => {
  const source = Scalar.find(operation.sourceType._tag)
  if (source?.category !== 'Floating')
    throw new RangeError('LLVM transcendental lost its source type')
  const width = source.spelling === 'f32' ? 32 : 64
  const floatType = source.spelling === 'f32' ? self.f32 : self.f64
  const format = source.spelling === 'f32' ? 'float' : 'double'
  const plan = Transcendental.plan(width)
  const suffix = operation.destination.ordinal
  const constant = (bits: bigint) => {
    return Emitter.floatingRaw(
      self.builder,
      floatType,
      format,
      FloatingPoint.littleEndianBytes({ width, bits }),
    )
  }
  const binary = (
    kind: FunctionBody.FloatingBinaryKind,
    left: Value.Input,
    right: Value.Input,
    name: string,
  ) => {
    return Emitter.binary(body, kind, left, right, name)
  }
  const zero = constant(0n)
  const half = constant(plan.half)
  const negativeHalf = Emitter.unary(body, 'fneg', half, `trans_half_neg${suffix}`)
  const negative = Emitter.floatingCompare(body, 'olt', subject, zero, `trans_negative${suffix}`)
  const offset = Emitter.select(body, negative, negativeHalf, half, `trans_offset${suffix}`)
  const scaled = binary('fmul', subject, constant(plan.inverseHalfPi), `trans_scaled${suffix}`)
  const shifted = binary('fadd', scaled, offset, `trans_shifted${suffix}`)
  const i64 = self.i64 ?? self.i32
  const quadrantInteger = Emitter.cast(
    body,
    'fptosi',
    shifted,
    i64,
    `trans_quadrant_integer${suffix}`,
  )
  const quadrantFloat = Emitter.cast(
    body,
    'sitofp',
    quadrantInteger,
    floatType,
    `trans_quadrant_float${suffix}`,
  )
  let residual: Value.Input = subject
  for (const [index, part] of plan.halfPi.entries()) {
    const product = binary(
      'fmul',
      quadrantFloat,
      constant(part),
      `trans_reduce_product${suffix}_${index}`,
    )
    residual = binary('fsub', residual, product, `trans_reduce${suffix}_${index}`)
  }
  const squared = binary('fmul', residual, residual, `trans_squared${suffix}`)
  const polynomial = (coefficients: ReadonlyArray<bigint>, name: string) => {
    let result: Value.Input = constant(coefficients.at(-1) ?? 0n)
    for (let index = coefficients.length - 2; index >= 0; index -= 1) {
      result = binary(
        'fadd',
        constant(coefficients[index] ?? 0n),
        binary('fmul', squared, result, `${name}_mul${index}`),
        `${name}_add${index}`,
      )
    }
    return result
  }
  const sineTail = polynomial(plan.sine, `trans_sine_tail${suffix}`)
  const residualSquared = binary('fmul', residual, squared, `trans_residual_squared${suffix}`)
  const sine = binary(
    'fadd',
    residual,
    binary('fmul', residualSquared, sineTail, `trans_sine_product${suffix}`),
    `trans_sine${suffix}`,
  )
  const cosineTail = polynomial(plan.cosine, `trans_cosine_tail${suffix}`)
  const cosineBase = binary(
    'fsub',
    constant(plan.one),
    binary('fmul', half, squared, `trans_cosine_half${suffix}`),
    `trans_cosine_base${suffix}`,
  )
  const cosine = binary(
    'fadd',
    cosineBase,
    binary(
      'fmul',
      binary('fmul', squared, squared, `trans_fourth${suffix}`),
      cosineTail,
      `trans_cosine_product${suffix}`,
    ),
    `trans_cosine${suffix}`,
  )
  const quadrant = Emitter.binary(
    body,
    'and',
    quadrantInteger,
    Emitter.integerUnsigned(self.builder, i64, 3n),
    `trans_quadrant${suffix}`,
  )
  const isQuadrant = (value: bigint) => {
    return Emitter.integerCompare(
      body,
      'eq',
      quadrant,
      Emitter.integerUnsigned(self.builder, i64, value),
      `trans_quadrant_${value.toString()}_${suffix}`,
    )
  }
  const negativeSine = Emitter.unary(body, 'fneg', sine, `trans_sine_neg${suffix}`)
  const negativeCosine = Emitter.unary(body, 'fneg', cosine, `trans_cosine_neg${suffix}`)
  const q2 = Emitter.select(
    body,
    isQuadrant(2n),
    operation.operation === 'Sin' ? negativeSine : negativeCosine,
    operation.operation === 'Sin' ? negativeCosine : sine,
    `trans_q2${suffix}`,
  )
  const q1 = Emitter.select(
    body,
    isQuadrant(1n),
    operation.operation === 'Sin' ? cosine : negativeSine,
    q2,
    `trans_q1${suffix}`,
  )
  const finite = Emitter.select(
    body,
    isQuadrant(0n),
    operation.operation === 'Sin' ? sine : cosine,
    q1,
    `trans_finite${suffix}`,
  )
  const unordered = Emitter.floatingCompare(body, 'uno', subject, subject, `trans_nan${suffix}`)
  const positiveInfinite = Emitter.floatingCompare(
    body,
    'oeq',
    subject,
    constant(width === 32 ? 0x7f800000n : 0x7ff0000000000000n),
    `trans_positive_infinite${suffix}`,
  )
  const negativeInfinite = Emitter.floatingCompare(
    body,
    'oeq',
    subject,
    constant(width === 32 ? 0xff800000n : 0xfff0000000000000n),
    `trans_negative_infinite${suffix}`,
  )
  const infinite = Emitter.binary(
    body,
    'or',
    positiveInfinite,
    negativeInfinite,
    `trans_infinite${suffix}`,
  )
  const nonFinite = Emitter.binary(body, 'or', unordered, infinite, `trans_nonfinite${suffix}`)
  const isZero = Emitter.floatingCompare(body, 'oeq', subject, zero, `trans_zero${suffix}`)
  const finiteWithZero = Emitter.select(
    body,
    isZero,
    operation.operation === 'Sin' ? subject : constant(plan.one),
    finite,
    `trans_finite_zero${suffix}`,
  )
  return Emitter.select(
    body,
    nonFinite,
    constant(plan.canonicalNaN),
    finiteWithZero,
    `transcendental${suffix}`,
  )
}
