import * as AuthoredIdentity from './AuthoredIdentity.js'
import * as LiteralForm from './LiteralForm.js'
import * as Provenance from './Provenance.js'
import type * as SemanticContext from './SemanticContext.js'
import * as SourceSpan from './SourceSpan.js'
import * as StaticText from './StaticText.js'

/**
 * Where a semantic product points, without naming a revision.
 *
 * A checked body and an evaluation outcome hold locations, never spans. A span exists only after
 * `resolve` asks the current presentation, which is why a reused body reports at the position its
 * source has now.
 */
export type Location =
  /** A node, or with `edge` the last byte of it: a block's closing brace has no node of its own. */
  | { readonly _tag: 'At'; readonly anchor: AuthoredIdentity.Anchor; readonly edge?: 'End' }
  /**
   * A range of a static value, as the ordered sources that cover it. `fallback` is the node that
   * reported it, used when no part can be resolved to a written literal.
   */
  | {
      readonly _tag: 'In'
      readonly parts: ReadonlyArray<Provenance.Source>
      readonly fallback: AuthoredIdentity.Anchor
    }

export const at = (anchor: AuthoredIdentity.Anchor): Location => ({ _tag: 'At', anchor })

/** The last byte of a node. */
export const endOf = (anchor: AuthoredIdentity.Anchor): Location => ({
  _tag: 'At',
  anchor,
  edge: 'End',
})

export const within = (
  parts: ReadonlyArray<Provenance.Source>,
  fallback: AuthoredIdentity.Anchor,
): Location => ({ _tag: 'In', parts: [...parts], fallback })

/** A stable text key: equal locations have equal keys in every revision. */
export const key = (self: Location): string =>
  self._tag === 'At'
    ? `${AuthoredIdentity.anchorKey(self.anchor)}${self.edge === undefined ? '' : '$'}`
    : `${AuthoredIdentity.anchorKey(self.fallback)}[${self.parts
        .map((part) =>
          part._tag === 'Literal'
            ? `${AuthoredIdentity.anchorKey(part.at)}:${part.range.start}-${part.range.end}`
            : `#${part.ordinal}:${part.range.start}-${part.range.end}`,
        )
        .join(',')}]`

/** The node a location names, or reports at when its value range cannot be resolved. */
export const anchorOf = (self: Location): AuthoredIdentity.Anchor =>
  self._tag === 'At' ? self.anchor : self.fallback

/** The module whose authored structure the location names. */
export const moduleOf = (self: Location): string => anchorOf(self).owner.module

export const equals = (self: Location, other: Location): boolean => key(self) === key(other)

/** Rewrites a shared location in one caller's terms; literal parts are kept as they are. */
export const substitute = (
  self: Location,
  arguments_: ReadonlyArray<Provenance.Provenance | undefined>,
): Location =>
  self._tag === 'At'
    ? self
    : within(
        self.parts.flatMap((part) => Provenance.substituteSource(part, arguments_)),
        self.fallback,
      )

/** Whether resolving this location still needs a call site. */
export const isShared = (self: Location): boolean =>
  self._tag === 'In' && Provenance.isShared(self.parts)

/** A resolved location: the span a diagnostic reports at, and the rest of a split value range. */
export interface Resolved {
  readonly span: SourceSpan.SourceSpan
  readonly related: ReadonlyArray<SourceSpan.SourceSpan>
}

const encoder = new TextEncoder()

/**
 * The source bytes behind a decoded range of one literal.
 *
 * The literal's presented spelling is decoded again to learn, for each decoded byte, which spelling
 * bytes produced it. That map is a function of the spelling alone, so it is derived here rather than
 * stored in any semantic product.
 */
const literalSpan = (
  registry: SemanticContext.Registry,
  source: Extract<Provenance.Source, { readonly _tag: 'Literal' }>,
): SourceSpan.SourceSpan | undefined => {
  const whole = registry.spanOf(source.at)
  const spelling = registry.of(source.at)?.spellingOf(source.at)
  if (spelling === undefined) return whole
  const bytes = Array.from(encoder.encode(spelling))
  const form = LiteralForm.recognize(bytes)
  const decoded = form === undefined ? undefined : StaticText.decode(bytes, form)
  const map = decoded?._tag === 'Decoded' ? decoded.data.sourceRanges : undefined
  if (map === undefined) return whole
  // An empty range names the boundary before its first byte, or the end of the content.
  const first = map.at(source.range.start)
  const last = map.at(Math.max(source.range.start, source.range.end - 1))
  if (first === undefined || last === undefined) return whole
  const start = whole.start + first.start
  const end = source.range.end > source.range.start ? whole.start + last.end : start
  return SourceSpan.fromOffsets(whole.sourceId, start, end) ?? whole
}

/**
 * Resolves a location through the current presentations.
 *
 * Each literal part resolves through the presentation of its own module, which may be the callee's.
 * A part that still names a parameter cannot be resolved here: the caller must `substitute` first.
 * When nothing resolves, the location falls back to the node that reported it.
 */
export const resolve = (self: Location, registry: SemanticContext.Registry): Resolved => {
  if (self._tag === 'At') {
    const whole = registry.spanOf(self.anchor)
    const span =
      self.edge === undefined || whole.end <= whole.start
        ? whole
        : (SourceSpan.fromOffsets(whole.sourceId, whole.end - 1, whole.end) ?? whole)
    return { span, related: [] }
  }
  const spans = self.parts.flatMap((part) => {
    const span = part._tag === 'Literal' ? literalSpan(registry, part) : undefined
    return span === undefined ? [] : [span]
  })
  const [span, ...related] = spans
  return {
    span: span ?? registry.spanOf(self.fallback),
    related: related,
  }
}
