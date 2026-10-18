import * as FloatingPoint from './FloatingPoint.js'

export type Operation = 'Sin' | 'Cos'

export interface Plan {
  readonly width: 32 | 64
  readonly canonicalNaN: bigint
  readonly one: bigint
  readonly half: bigint
  readonly four: bigint
  readonly inverseHalfPi: bigint
  readonly halfPi: ReadonlyArray<bigint>
  readonly sine: ReadonlyArray<bigint>
  readonly cosine: ReadonlyArray<bigint>
}

const f32: Plan = {
  width: 32,
  canonicalNaN: FloatingPoint.canonicalNaN(32),
  one: 0x3f800000n,
  half: 0x3f000000n,
  four: 0x40800000n,
  inverseHalfPi: 0x3f22f983n,
  halfPi: [
    0x3fc80000n,
    0x3c000000n,
    0x39f80000n,
    0x37300000n,
    0x34a80000n,
    0x30880000n,
    0x2c300000n,
    0x29880000n,
    0x27000000n,
    0x24880000n,
  ],
  sine: [0xbe2aaaabn, 0x3c088889n, 0xb9500d01n, 0x3638ef1bn, 0xb2d72f34n, 0x2f2ec9d3n],
  cosine: [0x3d2aaaabn, 0xbab60b61n, 0x37d00d01n, 0xb493f27cn, 0x310f74f6n, 0xad47d74en],
}

const f64: Plan = {
  width: 64,
  canonicalNaN: FloatingPoint.canonicalNaN(64),
  one: 0x3ff0000000000000n,
  half: 0x3fe0000000000000n,
  four: 0x4010000000000000n,
  inverseHalfPi: 0x3fe45f306dc9c883n,
  halfPi: [
    0x3ff9200000000000n,
    0x3f3fb40000000000n,
    0x3e74440000000000n,
    0x3d868c0000000000n,
    0x3c91a60000000000n,
    0x3ba3180000000000n,
    0x3ae8a20000000000n,
    0x3a1c060000000000n,
    0x394c1c0000000000n,
    0x387a240000000000n,
  ],
  sine: [
    0xbfc5555555555549n,
    0x3f8111111110f8a6n,
    0xbf2a01a019c161d5n,
    0x3ec71de357b1fe7dn,
    0xbe5ae5e68a2b9cebn,
    0x3de5d93a5acfd57cn,
  ],
  cosine: [
    0x3fa555555555554cn,
    0xbf56c16c16c15177n,
    0x3efa01a019cb1590n,
    0xbe927e4f809c52adn,
    0x3e21ee9ebdb4b1c4n,
    0xbda8fae9be8838d4n,
  ],
}

export const plan = (width: 32 | 64): Plan => (width === 32 ? f32 : f64)

const number = (bits: bigint, width: 32 | 64): number => FloatingPoint.toNumber({ width, bits })

const round = (value: number, width: 32 | 64): number =>
  FloatingPoint.toNumber(FloatingPoint.fromNumber(value, width))

const add = (left: number, right: number, width: 32 | 64): number => round(left + right, width)
const subtract = (left: number, right: number, width: 32 | 64): number => round(left - right, width)
const multiply = (left: number, right: number, width: 32 | 64): number => round(left * right, width)

const truncate = (value: number, width: 32 | 64): number => round(value - (value % 1), width)

const horner = (coefficients: ReadonlyArray<bigint>, squared: number, width: 32 | 64): number => {
  let result = number(coefficients.at(-1) ?? 0n, width)
  for (let index = coefficients.length - 2; index >= 0; index -= 1) {
    result = add(number(coefficients[index] ?? 0n, width), multiply(squared, result, width), width)
  }
  return result
}

const reducedKernels = (residual: number, self: Plan): readonly [number, number] => {
  const squared = multiply(residual, residual, self.width)
  const sineTail = horner(self.sine, squared, self.width)
  const sine = add(
    residual,
    multiply(multiply(residual, squared, self.width), sineTail, self.width),
    self.width,
  )
  const cosineTail = horner(self.cosine, squared, self.width)
  const halfSquared = multiply(number(self.half, self.width), squared, self.width)
  const cosine = add(
    subtract(number(self.one, self.width), halfSquared, self.width),
    multiply(multiply(squared, squared, self.width), cosineTail, self.width),
    self.width,
  )
  return [sine, cosine]
}

/** Executes the compiler-owned fixed-order sine/cosine plan from explicit IEEE bits. */
export const evaluate = (operation: Operation, input: FloatingPoint.Bits): FloatingPoint.Bits => {
  const self = plan(input.width)
  if (FloatingPoint.isNotANumber(input) || FloatingPoint.isInfinite(input))
    return { width: input.width, bits: self.canonicalNaN }
  if ((input.bits & ((1n << BigInt(input.width - 1)) - 1n)) === 0n) {
    return operation === 'Sin'
      ? { width: input.width, bits: BigInt.asUintN(input.width, input.bits) }
      : { width: input.width, bits: self.one }
  }

  const value = number(input.bits, input.width)
  const scaled = multiply(value, number(self.inverseHalfPi, input.width), input.width)
  const shifted = add(
    scaled,
    value < 0 ? -number(self.half, input.width) : number(self.half, input.width),
    input.width,
  )
  const quadrantFloat = truncate(shifted, input.width)
  let residual = value
  for (const part of self.halfPi) {
    residual = subtract(
      residual,
      multiply(quadrantFloat, number(part, input.width), input.width),
      input.width,
    )
  }
  const [sine, cosine] = reducedKernels(residual, self)
  const quadrant = ((quadrantFloat % 4) + 4) % 4
  let result: number
  if (operation === 'Sin') {
    switch (quadrant) {
      case 0:
        result = sine
        break
      case 1:
        result = cosine
        break
      case 2:
        result = -sine
        break
      default:
        result = -cosine
    }
  } else {
    switch (quadrant) {
      case 0:
        result = cosine
        break
      case 1:
        result = -sine
        break
      case 2:
        result = -cosine
        break
      default:
        result = sine
    }
  }
  return FloatingPoint.fromNumber(round(result, input.width), input.width)
}
