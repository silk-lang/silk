/**
 * The one row every inspector is built from.
 *
 * Each phase used to render its own card markup, so comparing two phases meant reading two
 * different visual languages and scrolling six times as far. A shared row makes the phases
 * genuinely comparable: the same construct occupies the same shape everywhere, and the only
 * thing that differs between panes is the content of the columns.
 *
 * Rows are pure data — no callbacks, no host objects — so a projected view survives structured
 * serialization unchanged. Activation is the consumer's job: a row is activatable exactly when it
 * carries a span, and what activation *does* (move a cursor atom, reveal a range in an editor)
 * belongs to whichever surface renders the row.
 */

import type * as SourceSpan from './SourceSpan.js'

/**
 * A half-open byte range in one module's source.
 *
 * The module is part of the span, not context around it: closure, index, and resolution rows
 * point into modules other than the view's root, and a cursor that compared bare offsets would
 * tint a same-offset construct in an unrelated file.
 */
export interface Span {
  readonly module: string
  readonly start: number
  readonly end: number
}

/** Projects a compiler source span into the row currency, keeping its owning module. */
export const spanOf = (span: SourceSpan.SourceSpan): Span => ({
  module: span.sourceId,
  start: span.start,
  end: span.end,
})

export type RowTone = 'error' | 'warning' | 'symbol' | 'ok'
export type DotKind = 'token' | 'node' | 'missing' | 'error' | 'warning' | 'ok' | 'symbol'

export interface RowModel {
  readonly key: string
  /** Optional line/token index, rendered in the tabular lead column. */
  readonly lead?: string | number | undefined
  readonly depth?: number | undefined
  /** `undefined` renders no caret; a branch row supplies `▾`/`▸`. */
  readonly caret?: string | undefined
  readonly dot?: DotKind | undefined
  readonly label: string
  readonly detail?: string | undefined
  readonly span?: Span | undefined
  /** Group heads render at 700 weight — the row grammar's only typographic emphasis. */
  readonly head?: boolean | undefined
  readonly tone?: RowTone | undefined
}

/**
 * Where the span cursor sits relative to a row.
 *
 * `contains` is deliberately not `equals`: clicking `identity` in the token stream should tint
 * the enclosing `CallExpression` in the tree and the function that lowered it in MIR, because
 * those are the same construct seen through later phases. Modules must match first — the same
 * byte range in another file is a different construct.
 */
export type CursorState = 'exact' | 'contains' | undefined

export const cursorStateFor = (span: Span | undefined, cursor: Span | undefined): CursorState => {
  if (span === undefined || cursor === undefined) return undefined
  if (span.module !== cursor.module) return undefined
  if (span.start === cursor.start && span.end === cursor.end) return 'exact'
  return span.start <= cursor.start && span.end >= cursor.end ? 'contains' : undefined
}

export const spanLabel = (span: Span | undefined): string =>
  span === undefined ? '' : `${span.start}–${span.end}`
