import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'

export interface TextRef {
  readonly _tag: 'TextRef'
  readonly index: number
}

export interface BytesRef {
  readonly _tag: 'BytesRef'
  readonly index: number
}

/** Exact Unicode text and its UTF-8 length, including embedded NUL. */
export interface Text {
  readonly _tag: 'PoolText'
  readonly value: string
  readonly byteLength: number
}

/** Exact bytes with an immutable owned payload; no terminator is added or removed. */
export interface Bytes {
  readonly _tag: 'PoolBytes'
  readonly value: readonly number[]
  readonly byteLength: number
}

export interface Pool {
  readonly _tag: 'AuthoredPool'
  readonly texts: readonly Text[]
  readonly bytes: readonly Bytes[]
}

export class AuthoredPoolError extends Data.TaggedError('AuthoredPoolError')<{
  readonly operation: 'AuthoredPool.make' | 'AuthoredPool.text' | 'AuthoredPool.bytes'
  readonly reason:
    | { readonly _tag: 'InvalidText'; readonly index: number }
    | {
        readonly _tag: 'InvalidByte'
        readonly index: number
        readonly offset: number
        readonly value: number
      }
    | { readonly _tag: 'InvalidReference'; readonly kind: 'text' | 'bytes'; readonly index: number }
}> {}

/**
 * Publish owned immutable payloads in supplied order. References are pool-local indices;
 * canonical content encoding resolves their values instead of encoding those indices.
 */
export const make = Effect.fn('AuthoredPool.make')(function* (
  texts: readonly string[],
  bytes: readonly (readonly number[])[],
): Effect.fn.Return<Pool, AuthoredPoolError> {
  const textEntries: Text[] = []
  const byteEntries: Bytes[] = []
  for (const [index, value] of texts.entries()) {
    // In Unicode mode a valid surrogate pair is one scalar, so only unpaired
    // surrogates match. Reject them before UTF-8 encoding can replace them.
    if (/[\uD800-\uDFFF]/u.test(value)) {
      return yield* new AuthoredPoolError({
        operation: 'AuthoredPool.make',
        reason: { _tag: 'InvalidText', index },
      })
    }
    textEntries.push({
      _tag: 'PoolText',
      value,
      byteLength: new TextEncoder().encode(value).length,
    })
  }
  for (const [index, value] of bytes.entries()) {
    for (const [offset, byte] of value.entries()) {
      if (!Number.isInteger(byte) || byte < 0 || byte > 255) {
        return yield* new AuthoredPoolError({
          operation: 'AuthoredPool.make',
          reason: { _tag: 'InvalidByte', index, offset, value: byte },
        })
      }
    }
    byteEntries.push({
      _tag: 'PoolBytes',
      value: [...value],
      byteLength: value.length,
    })
  }
  return {
    _tag: 'AuthoredPool',
    texts: textEntries,
    bytes: byteEntries,
  }
})

/** Resolve a text reference, preserving its explicit UTF-8 length. */
export const text = Effect.fn('AuthoredPool.text')(function* (
  self: Pool,
  reference: TextRef,
): Effect.fn.Return<Text, AuthoredPoolError> {
  const entry = self.texts[reference.index]
  if (!Number.isSafeInteger(reference.index) || reference.index < 0 || entry === undefined) {
    return yield* new AuthoredPoolError({
      operation: 'AuthoredPool.text',
      reason: { _tag: 'InvalidReference', kind: 'text', index: reference.index },
    })
  }
  return entry
})

/** Resolve a byte reference without decoding, truncating or copying its published payload. */
export const bytes = Effect.fn('AuthoredPool.bytes')(function* (
  self: Pool,
  reference: BytesRef,
): Effect.fn.Return<Bytes, AuthoredPoolError> {
  const entry = self.bytes[reference.index]
  if (!Number.isSafeInteger(reference.index) || reference.index < 0 || entry === undefined) {
    return yield* new AuthoredPoolError({
      operation: 'AuthoredPool.bytes',
      reason: { _tag: 'InvalidReference', kind: 'bytes', index: reference.index },
    })
  }
  return entry
})
