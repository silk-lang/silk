import * as Option from 'effect/Option'
import * as SourceOrigin from './SourceOrigin.js'
import type * as SourceSpan from './SourceSpan.js'

const SourceFileTypeId: unique symbol = Symbol.for('@silklang/compiler/SourceFile')

/** An immutable snapshot of caller-supplied source bytes and its logical identity. */
export interface SourceFile {
  readonly [SourceFileTypeId]: typeof SourceFileTypeId
  readonly id: string
  readonly bytes: Uint8Array
  readonly origin: SourceOrigin.SourceOrigin
}

/** Copies source bytes so later mutations of the caller's `Uint8Array` cannot change the file. */
export const make = (
  id: string,
  bytes: Uint8Array,
  origin: SourceOrigin.SourceOrigin = SourceOrigin.memory(),
): SourceFile => {
  const source: SourceFile = {
    [SourceFileTypeId]: SourceFileTypeId,
    id,
    bytes: new Uint8Array(bytes),
    origin,
  }
  return source
}

/** Returns the caller-provided logical source identity. */
export const identity = (self: SourceFile): string => self.id

/** Returns the source length in bytes. */
export const length = (self: SourceFile): number => self.bytes.length

/** Returns a defensive copy of the complete source byte sequence. */
export const toUint8Array = (self: SourceFile): Uint8Array => self.bytes.slice()

/**
 * Returns a defensive copy of the bytes covered by a valid span owned by this source identity.
 * Foreign or out-of-bounds spans return `None`.
 */
export const slice = (self: SourceFile, span: SourceSpan.SourceSpan): Option.Option<Uint8Array> =>
  span.sourceId === self.id && span.end <= self.bytes.length
    ? Option.some(self.bytes.slice(span.start, span.end))
    : Option.none()

/** Decodes a valid span's bytes as one-byte characters for identifier and keyword spellings. */
export const spelling = (self: SourceFile, span: SourceSpan.SourceSpan): Option.Option<string> =>
  span.sourceId === self.id && span.end <= self.bytes.length
    ? Option.some(latin1(self.bytes, span.start, span.end))
    : Option.none()

const latin1 = (bytes: Uint8Array, start: number, end: number): string => {
  let text = ''
  for (let index = start; index < end; index += 1) text += String.fromCharCode(bytes[index] ?? 0)
  return text
}

/** Tests identity and byte-for-byte equality between two immutable source snapshots. */
export const equals = (self: SourceFile, other: SourceFile): boolean =>
  self.id === other.id &&
  SourceOrigin.equals(self.origin, other.origin) &&
  self.bytes.length === other.bytes.length &&
  self.bytes.every((byte, index) => byte === other.bytes[index])
