import * as Option from 'effect/Option'
import * as SourceFile from './SourceFile.js'
import type * as SourceSpan from './SourceSpan.js'

/** A protocol-neutral source-action kind. */
export type Kind = 'QuickFix' | 'RefactorRewrite'

/** Stable discovery metadata that can be serialized by a frontend. */
export interface Descriptor {
  readonly _tag: 'SourceActionDescriptor'
  readonly key: string
  readonly title: string
  readonly kind: Kind
  readonly target: SourceSpan.SourceSpan
  readonly diagnosticKey?: string
}

/** The exact immutable source one group of edits was planned against. */
export interface SourcePrecondition {
  readonly _tag: 'SourcePrecondition'
  readonly module: string
  readonly source: SourceFile.SourceFile
}

/** One surgical replacement in source byte coordinates. */
export interface Edit {
  readonly _tag: 'SourceActionEdit'
  readonly span: SourceSpan.SourceSpan
  readonly replacement: string
}

/** Validated non-overlapping edits grouped by canonical source module. */
export interface ChangePlan {
  readonly _tag: 'SourceActionChangePlan'
  readonly preconditions: ReadonlyMap<string, SourcePrecondition>
  readonly changes: ReadonlyMap<string, ReadonlyArray<Edit>>
}

export const descriptor = (options: Omit<Descriptor, '_tag'>): Descriptor => ({
  _tag: 'SourceActionDescriptor',
  ...options,
})

export const precondition = (source: SourceFile.SourceFile): SourcePrecondition => ({
  _tag: 'SourcePrecondition',
  module: source.id,
  source,
})

export const edit = (span: SourceSpan.SourceSpan, replacement: string): Edit => ({
  _tag: 'SourceActionEdit',
  span,
  replacement,
})

const validEdits = (
  module: string,
  source: SourceFile.SourceFile,
  edits: ReadonlyArray<Edit>,
): boolean => {
  const ordered = [...edits].sort((left, right) => left.span.start - right.span.start)
  let previousEnd = 0
  for (const [ordinal, item] of ordered.entries()) {
    if (
      item.span.sourceId !== module ||
      item.span.end > source.bytes.length ||
      (ordinal > 0 && item.span.start < previousEnd)
    )
      return false
    previousEnd = item.span.end
  }
  return true
}

/** Constructs an atomic change plan only when ownership and non-overlap invariants hold. */
export const changePlan = (options: {
  readonly preconditions: Iterable<SourcePrecondition>
  readonly changes: Iterable<readonly [string, ReadonlyArray<Edit>]>
}): Option.Option<ChangePlan> => {
  const preconditions = new Map<string, SourcePrecondition>(
    Array.from(options.preconditions, (item) => [item.module, item] as const),
  )
  const changes = new Map<string, ReadonlyArray<Edit>>()
  for (const [module, edits] of options.changes) {
    const source = preconditions.get(module)?.source
    if (source === undefined || !validEdits(module, source, edits)) return Option.none()
    changes.set(
      module,
      [...edits].sort((left, right) => left.span.start - right.span.start),
    )
  }
  if (changes.size === 0) return Option.none()
  return Option.some({ _tag: 'SourceActionChangePlan', preconditions, changes })
}

/** Tests whether every precondition still matches a current immutable source snapshot. */
export const isCurrent = (
  self: ChangePlan,
  sources: ReadonlyMap<string, SourceFile.SourceFile>,
): boolean =>
  [...self.preconditions].every(([module, required]) => {
    const current = sources.get(module)
    return current !== undefined && SourceFile.equals(required.source, current)
  })
