import type * as AuthoredIdentity from './AuthoredIdentity.js'

/**
 * Where the bytes of a static text or bytes value were written.
 *
 * Every offset here is a byte offset into a *decoded* value. Offsets into source spelling never
 * appear: `"\x41"` is one value byte and four spelling bytes, and only a presentation knows that.
 */

/** A half-open byte range of a decoded value. */
export interface Range {
  readonly start: number
  readonly end: number
}

/**
 * What a run of value bytes was copied from.
 *
 * A literal is named by its authored anchor, which is the same for every caller. A parameter is
 * relative to the enclosing function's parameters, which is the only caller-specific form anything
 * shared between call sites may hold.
 */
export type Source =
  | { readonly _tag: 'Literal'; readonly at: AuthoredIdentity.Anchor; readonly range: Range }
  | {
      readonly _tag: 'Parameter'
      /** The static application whose parameters `ordinal` counts, when applications nest. */
      readonly scope?: string
      readonly ordinal: number
      readonly range: Range
    }

/** One run of a value together with the source it was copied from. */
export interface Segment {
  readonly value: Range
  readonly from: Source
}

/** Ordered by value position. Bytes that were computed rather than copied have no segment. */
export type Provenance = ReadonlyArray<Segment>

const range = (start: number, end: number): Range => ({ start, end })

const withRange = (source: Source, next: Range): Source =>
  source._tag === 'Literal'
    ? { _tag: 'Literal', at: source.at, range: next }
    : { ...source, range: next }

/** The provenance of a whole literal of `length` decoded bytes. */
export const literal = (at: AuthoredIdentity.Anchor, length: number): Provenance => [
  {
    value: range(0, length),
    from: { _tag: 'Literal' as const, at, range: range(0, length) },
  },
]

/** The provenance of a whole parameter value of `length` decoded bytes. */
export const parameter = (ordinal: number, length: number, scope?: string): Provenance => [
  {
    value: range(0, length),
    from: {
      _tag: 'Parameter' as const,
      ...(scope === undefined ? {} : { scope }),
      ordinal,
      range: range(0, length),
    },
  },
]

/** Restricts provenance to `[start, end)` of its value and rebases it to start at zero. */
export const slice = (self: Provenance, start: number, end: number): Provenance =>
  self.flatMap((segment): ReadonlyArray<Segment> => {
    const from = Math.max(segment.value.start, start)
    const to = Math.min(segment.value.end, end)
    if (from >= to) return []
    const offset = segment.from.range.start - segment.value.start
    return [
      {
        value: range(from - start, to - start),
        from: withRange(segment.from, range(from + offset, to + offset)),
      },
    ]
  })

/** Appends `right` after a left value of `leftLength` bytes. */
export const concat = (left: Provenance, leftLength: number, right: Provenance): Provenance => [
  ...left,
  ...right.map((segment) => ({
    value: range(segment.value.start + leftLength, segment.value.end + leftLength),
    from: segment.from,
  })),
]

/** The ordered sources covering `[start, end)` of a value: what a diagnostic about it names. */
export const sourcesOf = (self: Provenance, start: number, end: number): ReadonlyArray<Source> =>
  slice(self, start, end).map((segment) => segment.from)

/**
 * Rewrites one source in a caller's terms.
 *
 * A parameter source becomes the argument's own sources over the same range; a literal source is
 * the same for every caller and is kept. A parameter whose argument has no provenance (it was
 * computed) yields nothing, which publication answers by falling back to the call itself.
 */
export const substituteSource = (
  source: Source,
  arguments_: ReadonlyArray<Provenance | undefined>,
): ReadonlyArray<Source> => {
  if (source._tag === 'Literal') return [source]
  const argument = arguments_.at(source.ordinal)
  return argument === undefined ? [] : sourcesOf(argument, source.range.start, source.range.end)
}

/** Rewrites a callee's provenance in the caller's terms at one call. */
export const substitute = (
  self: Provenance,
  arguments_: ReadonlyArray<Provenance | undefined>,
  scope?: string,
): Provenance =>
  self.flatMap((segment): ReadonlyArray<Segment> => {
    if (segment.from._tag === 'Literal') return [segment]
    // A parameter of an enclosing application is that application's to resolve.
    if (scope !== undefined && segment.from.scope !== undefined && segment.from.scope !== scope)
      return [segment]
    const argument = arguments_.at(segment.from.ordinal)
    if (argument === undefined) return []
    const restricted = slice(argument, segment.from.range.start, segment.from.range.end)
    return restricted.map((inner) => ({
      value: range(inner.value.start + segment.value.start, inner.value.end + segment.value.start),
      from: inner.from,
    }))
  })

/** Whether any part still depends on a caller. */
export const isShared = (sources: ReadonlyArray<Source>): boolean =>
  sources.some((source) => source._tag === 'Parameter')
