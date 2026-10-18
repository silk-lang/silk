/** Width-tagged canonical IEEE binary32/binary64 bits. */
export interface Bits {
  readonly width: 32 | 64
  readonly bits: bigint
}

const specification = (width: 32 | 64) =>
  width === 32
    ? {
        precision: 24,
        exponentBits: 8,
        bias: 127,
        minimumExponent: -126,
        maximumExponent: 127,
      }
    : {
        precision: 53,
        exponentBits: 11,
        bias: 1023,
        minimumExponent: -1022,
        maximumExponent: 1023,
      }

const bitLength = (value: bigint): number => value.toString(2).length

const atLeastPowerOfTwo = (numerator: bigint, denominator: bigint, exponent: number): boolean =>
  exponent >= 0
    ? numerator >= denominator << BigInt(exponent)
    : numerator << BigInt(-exponent) >= denominator

const floorLog2 = (numerator: bigint, denominator: bigint): number => {
  let exponent = bitLength(numerator) - bitLength(denominator)
  if (!atLeastPowerOfTwo(numerator, denominator, exponent)) exponent -= 1
  return exponent
}

const roundRatio = (numerator: bigint, denominator: bigint, shift: number): bigint => {
  const scaledNumerator = shift >= 0 ? numerator << BigInt(shift) : numerator
  const scaledDenominator = shift >= 0 ? denominator : denominator << BigInt(-shift)
  const quotient = scaledNumerator / scaledDenominator
  const remainder = scaledNumerator % scaledDenominator
  const comparison = remainder * 2n - scaledDenominator
  return comparison > 0n || (comparison === 0n && (quotient & 1n) === 1n) ? quotient + 1n : quotient
}

const powerOfTen = (exponent: number): bigint => 10n ** BigInt(exponent)

/** Correctly rounds one lossless decimal spelling directly to IEEE bits using ties-to-even. */
export const fromDecimal = (spelling: string, width: 32 | 64): Bits | undefined => {
  const match = /^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(spelling)
  if (match === null) return undefined
  const negative = match[1] === '-'
  const whole = match[2] ?? ''
  const fraction = match[3] ?? ''
  const exponent = Number(match[4] ?? '0') - fraction.length
  const coefficient = BigInt(`${whole}${fraction}`)
  const spec = specification(width)
  const sign = negative ? 1n << BigInt(width - 1) : 0n
  if (coefficient === 0n) return { width, bits: sign }

  // Bounds prevent hostile exponent spellings from allocating enormous intermediate BigInts.
  const decimalMagnitude = whole.length + Number(match[4] ?? '0')
  if (!Number.isSafeInteger(exponent) || decimalMagnitude > (width === 32 ? 50 : 400)) {
    const infinityExponent = (1n << BigInt(spec.exponentBits)) - 1n
    return { width, bits: sign | (infinityExponent << BigInt(spec.precision - 1)) }
  }
  if (decimalMagnitude < (width === 32 ? -60 : -500)) return { width, bits: sign }

  const numerator = exponent >= 0 ? coefficient * powerOfTen(exponent) : coefficient
  const denominator = exponent >= 0 ? 1n : powerOfTen(-exponent)
  let binaryExponent = floorLog2(numerator, denominator)
  let exponentField: bigint
  let fractionField: bigint
  if (binaryExponent >= spec.minimumExponent) {
    let significand = roundRatio(numerator, denominator, spec.precision - 1 - binaryExponent)
    if (significand === 1n << BigInt(spec.precision)) {
      significand >>= 1n
      binaryExponent += 1
    }
    if (binaryExponent > spec.maximumExponent) {
      exponentField = (1n << BigInt(spec.exponentBits)) - 1n
      fractionField = 0n
    } else {
      exponentField = BigInt(binaryExponent + spec.bias)
      fractionField = significand - (1n << BigInt(spec.precision - 1))
    }
  } else {
    const significand = roundRatio(
      numerator,
      denominator,
      spec.precision - 1 - spec.minimumExponent,
    )
    if (significand >= 1n << BigInt(spec.precision - 1)) {
      exponentField = 1n
      fractionField = 0n
    } else {
      exponentField = 0n
      fractionField = significand
    }
  }
  return {
    width,
    bits: sign | (exponentField << BigInt(spec.precision - 1)) | fractionField,
  }
}

const buffer = new ArrayBuffer(8)
const view = new DataView(buffer)

/** Decodes canonical IEEE bits to the host number used only for primitive arithmetic. */
export const toNumber = (value: Bits): number => {
  if (value.width === 32) {
    view.setUint32(0, Number(BigInt.asUintN(32, value.bits)), true)
    return view.getFloat32(0, true)
  }
  view.setBigUint64(0, BigInt.asUintN(64, value.bits), true)
  return view.getFloat64(0, true)
}

/** The single canonical quiet NaN bit pattern for the given width. */
export const canonicalNaN = (width: 32 | 64): bigint =>
  width === 32 ? 0x7fc00000n : 0x7ff8000000000000n

/** Encodes a host arithmetic result, canonicalizing NaNs as required by Silk evaluation. */
export const fromNumber = (value: number, width: 32 | 64): Bits => {
  if (Number.isNaN(value)) return { width, bits: canonicalNaN(width) }
  if (width === 32) {
    view.setFloat32(0, Math.fround(value), true)
    return { width, bits: BigInt(view.getUint32(0, true)) }
  }
  view.setFloat64(0, value, true)
  return { width, bits: view.getBigUint64(0, true) }
}

/**
 * Correctly rounds an exact integer to IEEE bits in a single rounding step.
 *
 * Converting through the host `Number` first would round twice for 64-bit integers targeting
 * `f32` (i64 -> f64 -> f32), which native `sitofp` and wasm `f32.convert_i64_s` do not do.
 */
export const fromBigInt = (value: bigint, width: 32 | 64): Bits =>
  // A bigint's decimal spelling always parses, so the fallback is unreachable.
  fromDecimal(value.toString(), width) ?? fromNumber(Number(value), width)

export const isNotANumber = (value: Bits): boolean => {
  const spec = specification(value.width)
  const exponent =
    (value.bits >> BigInt(spec.precision - 1)) & ((1n << BigInt(spec.exponentBits)) - 1n)
  const fraction = value.bits & ((1n << BigInt(spec.precision - 1)) - 1n)
  return exponent === (1n << BigInt(spec.exponentBits)) - 1n && fraction !== 0n
}

export const isInfinite = (value: Bits): boolean =>
  !isNotANumber(value) && !Number.isFinite(toNumber(value))
export const isFiniteNumber = (value: Bits): boolean => Number.isFinite(toNumber(value))

export const isNormal = (value: Bits): boolean => {
  const spec = specification(value.width)
  const exponent =
    (value.bits >> BigInt(spec.precision - 1)) & ((1n << BigInt(spec.exponentBits)) - 1n)
  return exponent !== 0n && exponent !== (1n << BigInt(spec.exponentBits)) - 1n
}

export const isSubnormal = (value: Bits): boolean => {
  const spec = specification(value.width)
  const exponent =
    (value.bits >> BigInt(spec.precision - 1)) & ((1n << BigInt(spec.exponentBits)) - 1n)
  const fraction = value.bits & ((1n << BigInt(spec.precision - 1)) - 1n)
  return exponent === 0n && fraction !== 0n
}

export const isSignNegative = (value: Bits): boolean =>
  (value.bits & (1n << BigInt(value.width - 1))) !== 0n

/** Floor of the exact square root, by Newton descent from an upper bound. */
const integerSquareRoot = (value: bigint): bigint => {
  if (value < 2n) return value
  let guess = 1n << BigInt(Math.ceil(bitLength(value) / 2))
  for (;;) {
    const next = (guess + value / guess) >> 1n
    if (next >= guess) return guess
    guess = next
  }
}

/**
 * The correctly rounded IEEE-754 square root, computed on exact integers.
 *
 * IEEE-754 requires `sqrt` be correctly rounded, so this reproduces the bits that a conforming
 * hardware instruction produces. It never consults the host `Math.sqrt`, whose ECMAScript
 * definition is only implementation-approximated.
 *
 * A tie is unreachable here. Rounding the significand to `precision` bits compares the exact root
 * of an integer `N` against `r + 1/2`, and `sqrt(N) = r + 1/2` would force `N = r^2 + r + 1/4`,
 * which no integer satisfies. Nearest-even therefore collapses to the strict test `N > r^2 + r`.
 */
export const squareRoot = (value: Bits): Bits => {
  const spec = specification(value.width)
  const canonicalNaNValue = canonicalNaN(value.width)
  const exponentField =
    (value.bits >> BigInt(spec.precision - 1)) & ((1n << BigInt(spec.exponentBits)) - 1n)
  const fractionField = value.bits & ((1n << BigInt(spec.precision - 1)) - 1n)
  const negative = isSignNegative(value)
  if (exponentField === (1n << BigInt(spec.exponentBits)) - 1n)
    return fractionField !== 0n || negative
      ? { width: value.width, bits: canonicalNaNValue }
      : value
  // IEEE-754 keeps the sign of a zero root, so -0 squares back to -0.
  if (exponentField === 0n && fractionField === 0n) return value
  if (negative) return { width: value.width, bits: canonicalNaNValue }

  const significand =
    exponentField === 0n ? fractionField : fractionField | (1n << BigInt(spec.precision - 1))
  const exponent =
    (exponentField === 0n ? 1 : Number(exponentField)) - spec.bias - (spec.precision - 1)
  const magnitude = bitLength(significand) - 1 + exponent
  // Floor division survives a negative magnitude, where the truncating `/` would not.
  const rootExponent = Math.floor(magnitude / 2)
  // A subnormal input still roots into the normal range, so the result never needs gradual encoding.
  const shift = exponent + 2 * (spec.precision - 1 - rootExponent)
  const scaled = significand << BigInt(shift)
  const floorRoot = integerSquareRoot(scaled)
  const rounded = scaled > floorRoot * floorRoot + floorRoot ? floorRoot + 1n : floorRoot
  const carried = rounded === 1n << BigInt(spec.precision)
  const finalRoot = carried ? 1n << BigInt(spec.precision - 1) : rounded
  const finalExponent = BigInt((carried ? rootExponent + 1 : rootExponent) + spec.bias)
  return {
    width: value.width,
    bits:
      (finalExponent << BigInt(spec.precision - 1)) |
      (finalRoot & ((1n << BigInt(spec.precision - 1)) - 1n)),
  }
}

/** IEEE totalOrder key: negatives reverse their payload ordering, positives set the sign key. */
export const totalOrderKey = (value: Bits): bigint => {
  const mask = (1n << BigInt(value.width)) - 1n
  const sign = 1n << BigInt(value.width - 1)
  return (value.bits & sign) !== 0n ? ~value.bits & mask : value.bits | sign
}

/** Little-endian byte-exact payload used by LLVM constant construction. */
export const littleEndianBytes = (value: Bits): Uint8Array => {
  const bytes = new Uint8Array(value.width / 8)
  let remaining = BigInt.asUintN(value.width, value.bits)
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number(remaining & 0xffn)
    remaining >>= 8n
  }
  return bytes
}
