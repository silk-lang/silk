import type * as ByteString from '../ByteString.js'

export type CanonicalKey = string

// Native function declaration encoded each long symbol twice (collision check and insertion).
// Reuse keys for immutable byte arrays and avoid formatting every byte on each first visit.
const byteKeys = new WeakMap<ByteString.ReadonlyBytes, CanonicalKey>()

// The WHATWG `latin1` decoder (windows-1252) maps each of the 256 byte values to a distinct single
// UTF-16 code unit, so a decoded key is injective over byte sequences. Native decoding measured
// over 10x faster than spreading bytes into `String.fromCharCode` for long native symbols, which
// dominated global declaration and literal emission in the self-hosted compiler.
const byteDecoder = new TextDecoder('latin1')

/** @internal */
export const bytes = (value: ByteString.ByteString): CanonicalKey => {
  const cached = byteKeys.get(value.bytes)
  if (cached !== undefined) return cached
  // Byte strings own a Uint8Array; the read-only interface only hides its mutators.
  const view = value.bytes instanceof Uint8Array ? value.bytes : Uint8Array.from(value.bytes)
  const key = `${value.bytes.length}:${byteDecoder.decode(view)}`
  byteKeys.set(value.bytes, key)
  return key
}

/** @internal */
export const integer = (value: number | bigint): CanonicalKey =>
  typeof value === 'bigint' ? `i${value.toString()}` : `n${value.toString()}`

/** @internal */
export const sequence = (values: Iterable<CanonicalKey>): CanonicalKey => {
  let result = ''
  for (const value of values) result += `${value.length}:${value}`
  return result
}

/** @internal */
export const tagged = (tag: string, values: Iterable<CanonicalKey>): CanonicalKey =>
  `${tag.length}:${tag}${sequence(values)}`
