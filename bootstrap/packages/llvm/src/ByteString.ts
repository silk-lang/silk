/**
 * A read-only view of owned byte storage, without mutators or access to its backing buffer.
 *
 * Slices are independent mutable copies; subarrays remain read-only views.
 *
 * @category byte strings
 * @since 0.0.0
 */
export interface ReadonlyBytes extends Iterable<number> {
  readonly [index: number]: number
  readonly length: number
  at(index: number): number | undefined
  indexOf(value: number, fromIndex?: number): number
  slice(start?: number, end?: number): Uint8Array
  subarray(begin?: number, end?: number): ReadonlyBytes
}

/**
 * An immutable sequence of bytes used at LLVM's byte-oriented boundaries.
 *
 * @category byte strings
 * @since 0.0.0
 */
export interface ByteString {
  readonly _tag: 'ByteString'
  /** Owned by the byte string; never mutated after construction. */
  readonly bytes: ReadonlyBytes
}

/** @internal */
const own = (bytes: Uint8Array): ByteString => ({ _tag: 'ByteString', bytes })

/**
 * Copies a typed array into an immutable byte string, isolating it from later mutations.
 *
 * @category byte strings
 * @since 0.0.0
 */
export const fromUint8Array = (bytes: Uint8Array): ByteString => own(bytes.slice())

const utf8 = new TextEncoder()

/**
 * Encodes a JavaScript string as immutable UTF-8 bytes.
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
export const fromString = (value: string): ByteString => own(utf8.encode(value))

/**
 * The canonical empty byte sequence.
 *
 * @category byte strings
 * @since 0.0.0
 */
export const empty: ByteString = own(new Uint8Array(0))

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
export const toUint8Array = (self: ByteString): Uint8Array => self.bytes.slice()

/**
 * Compares two byte strings byte-for-byte.
 *
 * @category byte strings
 * @since 0.0.0
 */
export const equals = (self: ByteString, other: ByteString): boolean => {
  if (self.bytes.length !== other.bytes.length) return false
  for (let index = 0; index < self.bytes.length; index += 1) {
    if (self.bytes[index] !== other.bytes[index]) return false
  }
  return true
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
  const list = Array.from(parts)
  let length = 0
  for (const part of list) length += part.bytes.length
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const part of list) {
    bytes.set(part.bytes, offset)
    offset += part.bytes.length
  }
  return own(bytes)
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
  let start = 0
  while (start < self.bytes.length) {
    let end = self.bytes.indexOf(0x0a, start)
    if (end < 0) end = self.bytes.length
    if (end > start) lines.push(own(self.bytes.slice(start, end)))
    start = end + 1
  }
  return lines
}
