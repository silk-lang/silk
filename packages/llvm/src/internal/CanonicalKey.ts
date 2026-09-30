import type * as ByteString from '../ByteString.js'

export type CanonicalKey = string

// Native function declaration encoded each long symbol twice (collision check and insertion).
// Reuse keys for immutable byte arrays and avoid formatting every byte on each first visit.
const byteKeys = new WeakMap<ByteString.ReadonlyBytes, CanonicalKey>()

/** @internal */
export const bytes = (value: ByteString.ByteString): CanonicalKey => {
  const cached = byteKeys.get(value.bytes)
  if (cached !== undefined) return cached
  // SemanticCases declares 27.5M characters of symbols. Packing each byte into one code unit
  // avoids hex expansion and measured ~19x faster than per-byte mapping for those first visits.
  // Bounded argument lists handle arbitrary name lengths; joining keeps the retained key flat.
  const chunks: Array<string> = []
  for (let index = 0; index < value.bytes.length; index += 8192) {
    chunks.push(String.fromCharCode(...value.bytes.subarray(index, index + 8192)))
  }
  const key = `${value.bytes.length}:${chunks.join('')}`
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
