import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as AuthoredIdentity from './AuthoredIdentity.js'
import * as SourceSpan from './SourceSpan.js'

/** Current byte coordinates, deliberately absent from authored semantic artifacts. */
export interface Span {
  readonly start: number
  readonly end: number
}

/** Revision-specific display data for an owner-local authored anchor. */
export interface Entry {
  readonly anchor: AuthoredIdentity.Anchor
  readonly span: Span
  readonly spelling?: string
  readonly trivia?: string
  readonly documentation?: string
}

/** Rendering information for a local recovery cause; ordinal IDs are not semantic content. */
export interface Diagnostic {
  readonly anchor: AuthoredIdentity.Anchor
  readonly span: Span
  readonly code: string
  readonly message: string
}

export interface Presentation {
  readonly _tag: 'AuthoredPresentation'
  readonly sourceId: string
  readonly revision: string
  readonly entries: readonly Entry[]
  readonly diagnostics: readonly Diagnostic[]
}

export class AuthoredPresentationError extends Data.TaggedError('AuthoredPresentationError')<{
  readonly reason: { readonly _tag: 'InvalidSpan'; readonly span: Span }
}> {}

/** Current entries by anchor, built once per revision for consumers that map anchors to spans. */
export interface Index {
  readonly presentation: Presentation
  readonly entry: (anchor: AuthoredIdentity.Anchor) => Entry | undefined
  /** The entry's span as a source span of this revision's source, when the anchor is presented. */
  readonly span: (anchor: AuthoredIdentity.Anchor) => SourceSpan.SourceSpan | undefined
}

const indexes = new WeakMap<Presentation, Index>()

export const index = (self: Presentation): Index => {
  const cached = indexes.get(self)
  if (cached !== undefined) return cached
  const byAnchor = new Map<string, Entry>()
  for (const entry of self.entries) {
    const key = AuthoredIdentity.anchorKey(entry.anchor)
    if (!byAnchor.has(key)) byAnchor.set(key, entry)
  }
  const entry = (anchor: AuthoredIdentity.Anchor) =>
    byAnchor.get(AuthoredIdentity.anchorKey(anchor))
  const built: Index = {
    presentation: self,
    entry,
    span: (anchor) => {
      const found = entry(anchor)
      return found === undefined
        ? undefined
        : SourceSpan.fromOffsets(self.sourceId, found.span.start, found.span.end)
    },
  }
  indexes.set(self, built)
  return built
}

const validSpan = (value: Span): boolean =>
  Number.isSafeInteger(value.start) &&
  Number.isSafeInteger(value.end) &&
  value.start >= 0 &&
  value.end >= value.start

/**
 * Publishes display data for one revision. Entries and spans are copied; anchors are checked and
 * shared, since owners and local paths are immutable authored identity, not revision data.
 */
export const make = Effect.fn('AuthoredPresentation.make')(function* (
  sourceId: string,
  revision: string,
  entries: readonly Entry[],
  diagnostics: readonly Diagnostic[],
): Effect.fn.Return<
  Presentation,
  AuthoredPresentationError | AuthoredIdentity.AuthoredIdentityError
> {
  const checkAnchor = (
    anchor: AuthoredIdentity.Anchor,
  ): AuthoredIdentity.AuthoredIdentityError | undefined => {
    const owner = anchor.owner.path.findIndex(
      (part) => !Number.isSafeInteger(part.occurrence) || part.occurrence < 0,
    )
    if (owner >= 0)
      return new AuthoredIdentity.AuthoredIdentityError({
        operation: 'AuthoredIdentity.anchor',
        reason: {
          _tag: 'InvalidOwnerOccurrence',
          index: owner,
          occurrence: anchor.owner.path[owner]?.occurrence ?? Number.NaN,
        },
      })
    const local = anchor.path.findIndex(
      (part) => !Number.isSafeInteger(part.occurrence) || part.occurrence < 0,
    )
    if (local >= 0)
      return new AuthoredIdentity.AuthoredIdentityError({
        operation: 'AuthoredIdentity.anchor',
        reason: {
          _tag: 'InvalidLocalOccurrence',
          index: local,
          occurrence: anchor.path[local]?.occurrence ?? Number.NaN,
        },
      })
    return undefined
  }
  const copiedEntries: Entry[] = []
  for (const entry of entries) {
    const failure = checkAnchor(entry.anchor)
    if (failure !== undefined) return yield* failure
    if (!validSpan(entry.span))
      return yield* new AuthoredPresentationError({
        reason: { _tag: 'InvalidSpan', span: entry.span },
      })
    copiedEntries.push({
      anchor: entry.anchor,
      span: { start: entry.span.start, end: entry.span.end },
      ...(entry.spelling === undefined ? {} : { spelling: entry.spelling }),
      ...(entry.trivia === undefined ? {} : { trivia: entry.trivia }),
      ...(entry.documentation === undefined ? {} : { documentation: entry.documentation }),
    })
  }
  const copiedDiagnostics: Diagnostic[] = []
  for (const diagnostic of diagnostics) {
    const failure = checkAnchor(diagnostic.anchor)
    if (failure !== undefined) return yield* failure
    if (!validSpan(diagnostic.span))
      return yield* new AuthoredPresentationError({
        reason: { _tag: 'InvalidSpan', span: diagnostic.span },
      })
    copiedDiagnostics.push({
      anchor: diagnostic.anchor,
      span: { start: diagnostic.span.start, end: diagnostic.span.end },
      code: diagnostic.code,
      message: diagnostic.message,
    })
  }
  return {
    _tag: 'AuthoredPresentation',
    sourceId,
    revision,
    entries: copiedEntries,
    diagnostics: copiedDiagnostics,
  }
})
