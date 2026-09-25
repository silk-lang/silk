/**
 * An immutable sequence of bytes used at LLVM's byte-oriented boundaries.
 *
 * @category byte strings
 * @since 0.0.0
 */
export interface ByteString {
  readonly _tag: 'ByteString'
  readonly bytes: ReadonlyArray<number>
}

/** @internal */
const fromNumbers = (bytes: Iterable<number>): ByteString => ({
  _tag: 'ByteString',
  bytes: Array.from(bytes),
})

/**
 * Copies a typed array into an immutable byte string, isolating it from later mutations.
 *
 * @category byte strings
 * @since 0.0.0
 */
export const fromUint8Array = (bytes: Uint8Array): ByteString => fromNumbers(bytes)

/**
 * Encodes a JavaScript string as immutable UTF-8 bytes without a platform dependency.
 *
 * **When to use**
 *
 * Use when the input is genuinely Unicode text. LLVM identifiers and assembly fragments are
 * byte-oriented; use {@link fromUint8Array} to preserve arbitrary bytes.
 * Unpaired UTF-16 surrogate code units are replaced with U+FFFD, matching `TextEncoder`; valid
 * scalar values are encoded without normalization or case folding.
 *
 * **Example** (Encoding UTF-8 text)
 *
 * ```ts
 * import * as ByteString from '@silklang/llvm/ByteString'
 *
 * const value = ByteString.fromString('λ')
 * // ByteString.toUint8Array(value) equals Uint8Array.of(0xCE, 0xBB)
 * ```
 *
 * @category byte strings
 * @since 0.0.0
 */
export const fromString = (value: string): ByteString => {
  // Every emitted value and block name is encoded here; index by UTF-16 unit instead of the
  // allocating string iterator and hand the array over without a second copy.
  const bytes: Array<number> = []
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    if (unit <= 0x7f) {
      bytes.push(unit)
      continue
    }
    const codePoint = value.codePointAt(index) ?? unit
    if (codePoint > 0xffff) index += 1
    const scalarValue = codePoint >= 0xd800 && codePoint <= 0xdfff ? 0xfffd : codePoint
    if (scalarValue <= 0x7ff) {
      bytes.push(0xc0 | (scalarValue >> 6), 0x80 | (scalarValue & 0x3f))
    } else if (scalarValue <= 0xffff) {
      bytes.push(
        0xe0 | (scalarValue >> 12),
        0x80 | ((scalarValue >> 6) & 0x3f),
        0x80 | (scalarValue & 0x3f),
      )
    } else {
      bytes.push(
        0xf0 | (scalarValue >> 18),
        0x80 | ((scalarValue >> 12) & 0x3f),
        0x80 | ((scalarValue >> 6) & 0x3f),
        0x80 | (scalarValue & 0x3f),
      )
    }
  }
  return { _tag: 'ByteString', bytes }
}

/**
 * The canonical empty byte sequence.
 *
 * @category byte strings
 * @since 0.0.0
 */
export const empty: ByteString = fromNumbers([])

/**
 * Coerces a UTF-8 string, typed array, or existing byte string into an immutable byte string.
 *
 * **When to use**
 *
 * Use at public byte-oriented boundaries that accept any of the three spellings. UTF-8 strings are
 * encoded, typed arrays are copied, and existing {@link ByteString} values pass through unchanged.
 *
 * @category byte strings
 * @since 0.0.0
 */
export const coerce = (value: ByteString | Uint8Array | string): ByteString => {
  if (typeof value === 'string') return fromString(value)
  if (value instanceof Uint8Array) return fromUint8Array(value)
  return value
}

/**
 * Coerces an optional value into a byte string, mapping `undefined` to {@link empty}.
 *
 * @category byte strings
 * @since 0.0.0
 */
export const coerceOrEmpty = (value: ByteString | Uint8Array | string | undefined): ByteString =>
  value === undefined ? empty : coerce(value)

/**
 * Returns a defensive copy suitable for passing across a mutable boundary.
 *
 * @category byte strings
 * @since 0.0.0
 */
export const toUint8Array = (self: ByteString): Uint8Array => Uint8Array.from(self.bytes)

/**
 * Compares two byte strings byte-for-byte.
 *
 * @category byte strings
 * @since 0.0.0
 */
export const equals = (self: ByteString, other: ByteString): boolean => {
  if (self.bytes.length !== other.bytes.length) return false
  return self.bytes.every((byte, index) => byte === other.bytes[index])
}

/** @internal */
const hexadecimal = (byte: number): string => byte.toString(16).toUpperCase().padStart(2, '0')

/**
 * Escapes bytes using LLVM IR's quoted-string spelling.
 *
 * @category byte strings
 * @since 0.0.0
 */
export const escapeForIr = (self: ByteString): string => {
  let output = ''
  for (const byte of self.bytes) {
    if (byte >= 0x20 && byte <= 0x7e && byte !== 0x22 && byte !== 0x5c) {
      output += String.fromCharCode(byte)
    } else {
      output += `\\${hexadecimal(byte)}`
    }
  }
  return output
}

/**
 * Tests whether a byte string contains no bytes.
 *
 * @category byte strings
 * @since 0.0.0
 */
export const isEmpty = (self: ByteString): boolean => self.bytes.length === 0

/**
 * Concatenates byte strings in iteration order into a new immutable value.
 *
 * @category byte strings
 * @since 0.0.0
 */
export const concat = (parts: Iterable<ByteString>): ByteString => {
  const bytes: Array<number> = []
  for (const part of parts) bytes.push(...part.bytes)
  return fromNumbers(bytes)
}

/**
 * Splits on line-feed bytes and drops empty lines.
 *
 * **Gotchas**
 *
 * Carriage returns are ordinary bytes and remain in the corresponding line. Leading, trailing,
 * and repeated `\n` bytes do not produce empty entries.
 *
 * @category byte strings
 * @since 0.0.0
 */
export const splitLines = (self: ByteString): ReadonlyArray<ByteString> => {
  const lines: Array<ByteString> = []
  let line: Array<number> = []
  for (const byte of self.bytes) {
    if (byte === 0x0a) {
      if (line.length > 0) lines.push(fromNumbers(line))
      line = []
    } else {
      line.push(byte)
    }
  }
  if (line.length > 0) lines.push(fromNumbers(line))
  return lines
}
