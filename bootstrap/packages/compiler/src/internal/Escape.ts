/** One canonical escape vocabulary for the Silk compiler. */

type ByteSequence = ReadonlyArray<number> | Uint8Array

const isContinuation = (byte: number | undefined): boolean =>
  byte !== undefined && (byte & 0xc0) === 0x80

/** Decodes a fixed-width single-byte escape shared by every escaped literal form. */
export const simpleByte = (escaped: number | undefined, delimiter: number): number | undefined => {
  if (escaped === 0x6e) return 0x0a
  if (escaped === 0x72) return 0x0d
  if (escaped === 0x74) return 0x09
  if (escaped === 0x30) return 0
  if (escaped === 0x22 || escaped === 0x5c) return escaped
  return escaped === 0x27 && delimiter === 0x27 ? escaped : undefined
}

export type Decoded =
  | {
      readonly _tag: 'Decoded'
      readonly bytes: ReadonlyArray<number>
      readonly next: number
    }
  | { readonly _tag: 'Invalid'; readonly detail: string }

const utf8 = (scalar: number): ReadonlyArray<number> =>
  Array.from(new TextEncoder().encode(String.fromCodePoint(scalar)))

/** Decodes one escape whose leading backslash is immediately before `escapedAt`. */
export const decodeAt = (
  token: ByteSequence,
  escapedAt: number,
  end: number,
  delimiter: number,
  byteString: boolean,
): Decoded => {
  const escaped = token[escapedAt]
  if (escaped === 0x0a || escaped === 0x0d)
    return {
      _tag: 'Invalid',
      detail: 'backslash cannot continue a physical line',
    }
  const simple = simpleByte(escaped, delimiter)
  if (simple !== undefined) return { _tag: 'Decoded', bytes: [simple], next: escapedAt + 1 }
  if (escaped === 0x78) {
    const high = ByteClass.digitValue(token[escapedAt + 1])
    const low = ByteClass.digitValue(token[escapedAt + 2])
    return high === undefined || low === undefined
      ? {
          _tag: 'Invalid',
          detail: '`\\x` escape requires exactly two hexadecimal digits',
        }
      : {
          _tag: 'Decoded',
          bytes: [high * 16 + low],
          next: escapedAt + 3,
        }
  }
  if (escaped !== 0x75) return { _tag: 'Invalid', detail: 'unknown escape sequence' }
  if (token[escapedAt + 1] !== 0x7b)
    return { _tag: 'Invalid', detail: '`\\u` escape requires `{...}`' }
  let index = escapedAt + 2
  let scalar = 0
  let digits = 0
  while (index < end && token[index] !== 0x7d) {
    const digit = ByteClass.digitValue(token[index])
    if (digit === undefined || digits === 6)
      return { _tag: 'Invalid', detail: 'invalid Unicode scalar escape' }
    scalar = scalar * 16 + digit
    digits += 1
    index += 1
  }
  if (
    digits === 0 ||
    token[index] !== 0x7d ||
    scalar > 0x10ffff ||
    (scalar >= 0xd800 && scalar <= 0xdfff)
  )
    return { _tag: 'Invalid', detail: 'invalid Unicode scalar escape' }
  if (byteString && scalar > 0xff)
    return {
      _tag: 'Invalid',
      detail: 'byte-string escape is outside the u8 range',
    }
  return {
    _tag: 'Decoded',
    bytes: byteString ? [scalar] : utf8(scalar),
    next: index + 1,
  }
}

/**
 * Counts the Unicode scalars one escaped body denotes, without decoding any of them.
 *
 * The count is a scalar count and never a byte count. One escape sequence denotes one scalar
 * however it is spelled. Only the extent of an escape matters here, never its meaning, so the
 * decoder in StaticText stays the single authority on what an escape produces.
 */
export const scalarCount = (bytes: ByteSequence, contentStart: number, end: number): number => {
  let index = contentStart
  let scalars = 0
  while (index < end) {
    scalars += 1
    if (bytes[index] !== 0x5c) {
      index += 1
      while (index < end && isContinuation(bytes[index])) index += 1
      continue
    }
    const escaped = bytes[index + 1]
    if (escaped === 0x75 && bytes[index + 2] === 0x7b) {
      index += 3
      while (index < end && bytes[index] !== 0x7d) index += 1
      index += 1
      continue
    }
    index += escaped === 0x78 ? 4 : 2
  }
  return scalars
}

import * as ByteClass from './ByteClass.js'
