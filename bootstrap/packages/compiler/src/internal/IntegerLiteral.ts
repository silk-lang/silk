import * as ByteClass from './ByteClass.js'
import * as DigitSeparator from './DigitSeparator.js'

/** The numeric base an integer literal's digits are read in. */
export type Radix = 2 | 8 | 10 | 16

/** Byte storage accepted from source files, tests, and generated tooling. */
export type ByteSequence = ReadonlyArray<number> | Uint8Array

/** Source storage accepted for one complete integer-literal slice. */
export type Digits = ByteSequence | string

/** The base selected by an integer literal's optional prefix, with its exact prefix width. */
export interface Base {
  readonly radix: Radix
  readonly width: 0 | 2
}

const codeAt = (digits: Digits, index: number): number =>
  typeof digits === 'string' ? digits.charCodeAt(index) : (digits[index] ?? Number.NaN)

const make = (radix: Radix, width: 0 | 2): Base => ({ radix, width })

/** The implicit base of a literal written without a prefix. */
export const decimal: Base = make(10, 0)

/** The base introduced by `0b` or `0B`. */
export const binary: Base = make(2, 2)

/** The base introduced by `0o` or `0O`. */
export const octal: Base = make(8, 2)

/** The base introduced by `0x` or `0X`. */
export const hexadecimal: Base = make(16, 2)

/**
 * Recognizes the base prefix introducing an integer literal at `index`.
 *
 * A literal without a recognized prefix keeps the decimal base, so `0` alone and `0.5` retain
 * their existing readings.
 */
export const recognize = (digits: Digits, index = 0): Base => {
  if (codeAt(digits, index) !== 0x30) return decimal
  switch (codeAt(digits, index + 1)) {
    case 0x62:
    case 0x42:
      return binary
    case 0x6f:
    case 0x4f:
      return octal
    case 0x78:
    case 0x58:
      return hexadecimal
    default:
      return decimal
  }
}

/** Reports whether one byte is a digit of the given base. */
export const isDigit = (self: Base, byte: number | undefined): boolean => {
  if (byte === undefined) return false
  switch (self.radix) {
    case 2:
      return byte === 0x30 || byte === 0x31
    case 8:
      return byte >= 0x30 && byte <= 0x37
    case 10:
      return byte >= 0x30 && byte <= 0x39
    case 16:
      return (
        (byte >= 0x30 && byte <= 0x39) ||
        (byte >= 0x41 && byte <= 0x46) ||
        (byte >= 0x61 && byte <= 0x66)
      )
  }
}

/**
 * Reads the exact unsigned magnitude of one complete integer-literal slice.
 *
 * The slice carries its own base, so a conversion never assumes decimal for a prefixed literal.
 * Digit separators group the digits without carrying value, so they are skipped.
 */
export const magnitude = (digits: Digits): bigint => {
  const base = recognize(digits, 0)
  const radix = BigInt(base.radix)
  let value = 0n
  for (let index = base.width; index < digits.length; index += 1) {
    const code = codeAt(digits, index)
    if (DigitSeparator.isSeparator(code)) continue
    value = value * radix + BigInt(ByteClass.hexValue(code))
  }
  return value
}
