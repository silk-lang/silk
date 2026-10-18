import * as ByteString from '../ByteString.js'

/**
 * A local value or block name, kept as the caller spelled it.
 *
 * Local names never reach bitcode: only textual IR, verifier messages, and the name getters read
 * them. Keeping a string name unencoded lets the builder accept one per emitted value without a
 * UTF-8 encoding and byte allocation each; readers encode on demand with {@link toByteString}.
 * Byte-exact names stay byte strings.
 *
 * @internal
 */
export type LocalName = string | ByteString.ByteString

/** The absent name; renderers substitute a positional fallback. @internal */
export const empty: LocalName = ''

/** Accepts any public name spelling, copying typed arrays like every other byte boundary. @internal */
export const make = (input: ByteString.ByteString | Uint8Array | string | undefined): LocalName => {
  if (input === undefined) return empty
  return input instanceof Uint8Array ? ByteString.fromUint8Array(input) : input
}

/** @internal */
export const isEmpty = (self: LocalName): boolean =>
  typeof self === 'string' ? self.length === 0 : ByteString.isEmpty(self)

/** Encodes the name's exact bytes, UTF-8 for a string spelling. @internal */
export const toByteString = (self: LocalName): ByteString.ByteString =>
  typeof self === 'string' ? ByteString.fromString(self) : self
