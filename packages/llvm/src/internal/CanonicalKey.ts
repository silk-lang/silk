import type * as ByteString from '../ByteString.js'

export type CanonicalKey = string

// Native function declaration encoded each long symbol twice (collision check and insertion).
// Reuse keys for immutable byte arrays and avoid formatting every byte on each first visit.
const byteKeys = new WeakMap<ReadonlyArray<number>, CanonicalKey>()
const hexadecimalBytes = Array.from({ length: 256 }, (_, byte) =>
  byte.toString(16).padStart(2, '0'),
)

/** @internal */
export const bytes = (value: ByteString.ByteString): CanonicalKey => {
  const cached = byteKeys.get(value.bytes)
  if (cached !== undefined) return cached
  // One join builds a flat string; appending per byte built a rope of one ~32-byte node per byte,
  // and these keys stay cached for every live byte string of the module.
  const hexadecimal = Array.from(value.bytes, (byte) => hexadecimalBytes[byte] ?? '').join('')
  const key = `${value.bytes.length}:${hexadecimal}`
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
