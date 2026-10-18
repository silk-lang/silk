import * as Crypto from 'effect/Crypto'
import * as Effect from 'effect/Effect'
import * as Encoding from 'effect/Encoding'
import * as Option from 'effect/Option'
import * as PlatformError from 'effect/PlatformError'
import * as Storage from '@silklang/compiler/Storage'

export const namespace = 'test-results-v1'
export const maximumBytes = 4096

const header = 'silk-test-result-v1\n'
const outcome = 'outcome:Passed\n'
const identityPattern = /^[0-9a-f]{64}$/

export type MissReason =
  | { readonly _tag: 'Missing' }
  | { readonly _tag: 'InvalidRecord' }
  | { readonly _tag: 'StorageFailure'; readonly error: Storage.StorageError }
  | { readonly _tag: 'CryptoFailure'; readonly error: PlatformError.PlatformError }

export type Lookup =
  | { readonly _tag: 'Hit'; readonly identity: string }
  | { readonly _tag: 'Miss'; readonly reason: MissReason }

export type Publication =
  | { readonly _tag: 'Published'; readonly identity: string }
  | {
      readonly _tag: 'Skipped'
      readonly identity: string
      readonly reason:
        | { readonly _tag: 'InvalidIdentity' }
        | { readonly _tag: 'StorageFailure'; readonly error: Storage.StorageError }
        | { readonly _tag: 'CryptoFailure'; readonly error: PlatformError.PlatformError }
    }

const ascii = (value: string): Uint8Array => {
  const bytes = new Uint8Array(value.length)
  for (let index = 0; index < value.length; index += 1) bytes[index] = value.charCodeAt(index)
  return bytes
}

const asciiText = (bytes: Uint8Array): Option.Option<string> => {
  let value = ''
  for (const byte of bytes) {
    if (byte > 0x7f) return Option.none()
    value += String.fromCharCode(byte)
  }
  return Option.some(value)
}

const digest = Effect.fnUntraced(function* (bytes: Uint8Array) {
  const crypto = yield* Crypto.Crypto
  return Encoding.encodeHex(yield* crypto.digest('SHA-256', bytes))
})

const payload = (identity: string): string => `${header}identity:${identity}\n${outcome}`

/** Encodes one canonical completed-pass record for an exact execution identity. */
export const encodePass = Effect.fn('TestResult.encodePass')(function* (
  identity: string,
): Effect.fn.Return<Option.Option<Uint8Array>, PlatformError.PlatformError, Crypto.Crypto> {
  if (!identityPattern.test(identity)) return Option.none()
  const framed = ascii(payload(identity))
  const integrity = yield* digest(framed)
  return Option.some(ascii(`${payload(identity)}integrity:${integrity}\n`))
})

/** Strictly admits one bounded record for the exact storage-key identity. */
export const decodePass = Effect.fn('TestResult.decodePass')(function* (
  identity: string,
  bytes: Uint8Array,
): Effect.fn.Return<boolean, PlatformError.PlatformError, Crypto.Crypto> {
  if (!identityPattern.test(identity) || bytes.length > maximumBytes) return false
  const decoded = asciiText(bytes)
  if (Option.isNone(decoded)) return false
  const expectedPrefix = payload(identity)
  const match =
    /^silk-test-result-v1\nidentity:([0-9a-f]{64})\noutcome:Passed\nintegrity:([0-9a-f]{64})\n$/.exec(
      decoded.value,
    )
  if (match === null || match[1] !== identity) return false
  return match[2] === (yield* digest(ascii(expectedPrefix)))
})

/** Reads an optional pass record; expected cache failures and invalid data are observable misses. */
export const lookup = Effect.fn('TestResult.lookup')(function* (
  identity: string,
): Effect.fn.Return<Lookup, never, Crypto.Crypto | Storage.Storage> {
  if (!identityPattern.test(identity)) return { _tag: 'Miss', reason: { _tag: 'InvalidRecord' } }
  const read = yield* Effect.result(Storage.read(namespace, identity, maximumBytes))
  if (read._tag === 'Failure')
    return { _tag: 'Miss', reason: { _tag: 'StorageFailure', error: read.failure } }
  if (Option.isNone(read.success)) return { _tag: 'Miss', reason: { _tag: 'Missing' } }
  const admitted = yield* Effect.result(decodePass(identity, read.success.value))
  if (admitted._tag === 'Failure')
    return { _tag: 'Miss', reason: { _tag: 'CryptoFailure', error: admitted.failure } }
  return admitted.success
    ? { _tag: 'Hit', identity }
    : { _tag: 'Miss', reason: { _tag: 'InvalidRecord' } }
})

/** Atomically publishes only the completed-pass record represented by this operation. */
export const publishPass = Effect.fn('TestResult.publishPass')(function* (
  identity: string,
): Effect.fn.Return<Publication, never, Crypto.Crypto | Storage.Storage> {
  const encoded = yield* Effect.result(encodePass(identity))
  if (encoded._tag === 'Failure')
    return {
      _tag: 'Skipped',
      identity,
      reason: { _tag: 'CryptoFailure', error: encoded.failure },
    }
  if (Option.isNone(encoded.success))
    return { _tag: 'Skipped', identity, reason: { _tag: 'InvalidIdentity' } }
  const published = yield* Effect.result(
    Storage.publish(namespace, identity, encoded.success.value, maximumBytes),
  )
  return published._tag === 'Success'
    ? { _tag: 'Published', identity }
    : {
        _tag: 'Skipped',
        identity,
        reason: { _tag: 'StorageFailure', error: published.failure },
      }
})

/** Provides project-local atomic result storage beneath the build output directory. */
export const fileSystem = (outputDirectory: string) =>
  Storage.fileSystem(`${outputDirectory}/.silk-cache`)
