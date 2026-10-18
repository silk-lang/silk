import type * as CompilerDocBlock from '@silklang/compiler/DocBlock'
import type * as SourceFile from '@silklang/compiler/SourceFile'
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as Result from 'effect/Result'
import type { BlockContent, Code, ListItem as MarkdownListItem, Root, RootContent } from 'mdast'
import * as CommonMark from './internal/CommonMark.js'

export type Container = 'BlockQuote' | 'OrderedList' | 'UnorderedList' | 'ListItem'

/** One fenced CommonMark code block with provenance in its owning Silk source. */
export interface CodeFence {
  readonly _tag: 'CodeFence'
  readonly ordinal: number
  readonly rawInfoString: string
  readonly language?: string
  readonly metadata?: string
  readonly delimiter: '\x60' | '~'
  readonly delimiterLength: number
  readonly hasAuthoredCloser: boolean
  readonly body: string
  readonly containers: ReadonlyArray<Container>
  readonly opening: CommonMark.SourceRange
  readonly source: CommonMark.SourceRange
}

export interface Replacement {
  readonly fence: CodeFence
  readonly body: string
}

export class CodeFenceError extends Data.TaggedError('CodeFenceError')<{
  readonly operation: 'CodeFence.all' | 'CodeFence.rewrite'
  readonly sourceId: string
  readonly message: string
  readonly reason:
    | { readonly _tag: 'WrappedParserFailure'; readonly cause: unknown }
    | { readonly _tag: 'InvalidSource'; readonly details: string }
    | { readonly _tag: 'InvalidRewriteState'; readonly details: string }
}> {}

interface Details {
  readonly block: CompilerDocBlock.DocBlock
  readonly openingLine: number
  readonly closingLine?: number
  readonly continuationPrefix: string
}

const details = new WeakMap<CodeFence, Details>()
const encoder = new TextEncoder()

const fromCommonMark = (
  operation: CodeFenceError['operation'],
  sourceId: string,
  error: CommonMark.CommonMarkError,
): CodeFenceError =>
  new CodeFenceError({
    operation,
    sourceId,
    message: error.message,
    reason:
      error.reason._tag === 'WrappedParserFailure'
        ? { _tag: 'WrappedParserFailure', cause: error.reason.cause }
        : { _tag: 'InvalidSource', details: error.reason.details },
  })

const invalid = (
  operation: CodeFenceError['operation'],
  sourceId: string,
  message: string,
  value: string,
): CodeFenceError =>
  new CodeFenceError({
    operation,
    sourceId,
    message,
    reason: { _tag: 'InvalidRewriteState', details: value },
  })

const continuationPrefix = (openingPrefix: string): string =>
  openingPrefix.replace(
    /(^|[\t >])([-+*]|\d{1,9}[.)])(?=[\t ])/g,
    (_match, before: string, marker: string) => `${before}${' '.repeat(marker.length)}`,
  )

const fenceOf = (
  node: Code,
  ordinal: number,
  containers: ReadonlyArray<Container>,
  block: CompilerDocBlock.DocBlock,
  normalized: CommonMark.Normalized,
): Result.Result<CodeFence | undefined, CodeFenceError> => {
  const position = node.position
  const startOffset = position?.start.offset
  const startLineNumber = position?.start.line
  const endLineNumber = position?.end.line
  if (startOffset === undefined || startLineNumber === undefined || endLineNumber === undefined)
    return Result.fail(
      invalid(
        'CodeFence.all',
        block.span.sourceId,
        'Code fence has no source position',
        node.value,
      ),
    )

  const openingLine = normalized.lines.at(startLineNumber - 1)
  const endingLine = normalized.lines.at(endLineNumber - 1)
  if (openingLine === undefined || endingLine === undefined)
    return Result.fail(
      invalid(
        'CodeFence.all',
        block.span.sourceId,
        'Code fence position is outside its documentation block',
        `${startLineNumber}..${endLineNumber}`,
      ),
    )

  const openingColumn = startOffset - openingLine.normalizedStart
  const opening = normalized.markdown.slice(startOffset, openingLine.normalizedEnd)
  const match = /^(`{3,}|~{3,})(.*)$/.exec(opening)
  const rawDelimiter = match?.[1]
  if (rawDelimiter === undefined) return Result.succeed(undefined)
  const delimiter: CodeFence['delimiter'] = rawDelimiter[0] === '`' ? '`' : '~'
  const ending = normalized.markdown.slice(endingLine.normalizedStart, endingLine.normalizedEnd)
  const closingPattern = delimiter === '`' ? /`{3,}/g : /~{3,}/g
  let hasAuthoredCloser = false
  for (const candidate of ending.matchAll(closingPattern)) {
    const marker = candidate[0]
    if (
      marker.length >= rawDelimiter.length &&
      candidate.index <= openingColumn + 3 &&
      /^[\t ]*$/.test(ending.slice(candidate.index + marker.length))
    )
      hasAuthoredCloser = true
  }

  const value: CodeFence = Object.freeze({
    _tag: 'CodeFence' as const,
    ordinal,
    rawInfoString: match?.[2] ?? '',
    ...(node.lang === null || node.lang === undefined ? {} : { language: node.lang }),
    ...(node.meta === null || node.meta === undefined ? {} : { metadata: node.meta }),
    delimiter,
    delimiterLength: rawDelimiter.length,
    hasAuthoredCloser,
    body: node.value,
    containers: Object.freeze(Array.from(containers)),
    opening: Object.freeze({
      sourceId: block.span.sourceId,
      start: normalized.offsets[startOffset] ?? block.span.start,
      end: openingLine.comment.span.end,
    }),
    source: CommonMark.sourceRange(block, normalized, position),
  })
  details.set(
    value,
    Object.freeze({
      block,
      openingLine: startLineNumber - 1,
      ...(hasAuthoredCloser ? { closingLine: endLineNumber - 1 } : {}),
      continuationPrefix: continuationPrefix(
        normalized.markdown.slice(openingLine.normalizedStart, startOffset),
      ),
    }),
  )
  return Result.succeed(value)
}

const collect = (
  root: Root,
  block: CompilerDocBlock.DocBlock,
  normalized: CommonMark.Normalized,
): Result.Result<ReadonlyArray<CodeFence>, CodeFenceError> => {
  const fences: Array<CodeFence> = []
  let failure: CodeFenceError | undefined
  const visit = (
    node: RootContent | BlockContent | MarkdownListItem,
    containers: ReadonlyArray<Container>,
  ): void => {
    if (failure !== undefined) return
    switch (node.type) {
      case 'code': {
        const made = fenceOf(node, fences.length, containers, block, normalized)
        if (Result.isFailure(made)) failure = made.failure
        else if (made.success !== undefined) fences.push(made.success)
        return
      }
      case 'blockquote':
        for (const child of node.children) visit(child, [...containers, 'BlockQuote'])
        return
      case 'list': {
        const container: Container = node.ordered === true ? 'OrderedList' : 'UnorderedList'
        for (const child of node.children) visit(child, [...containers, container])
        return
      }
      case 'listItem':
        for (const child of node.children) visit(child, [...containers, 'ListItem'])
        return
      default:
        return
    }
  }
  for (const child of root.children) visit(child, Object.freeze([]))
  return failure === undefined ? Result.succeed(Object.freeze(fences)) : Result.fail(failure)
}

/** Parses every fenced CommonMark code block in one compiler-owned documentation block. */
export const all = Effect.fn('CodeFence.all')(function* (
  source: SourceFile.SourceFile,
  block: CompilerDocBlock.DocBlock,
): Effect.fn.Return<ReadonlyArray<CodeFence>, CodeFenceError> {
  const normalized = yield* Effect.fromResult(CommonMark.normalize(source, block)).pipe(
    Effect.mapError((error) => fromCommonMark('CodeFence.all', source.id, error)),
  )
  const root = yield* Effect.fromResult(CommonMark.parse(normalized)).pipe(
    Effect.mapError((error) => fromCommonMark('CodeFence.all', source.id, error)),
  )
  return yield* Effect.fromResult(collect(root, block, normalized))
})

/** Tests whether a fence's case-sensitive CommonMark language word selects Silk formatting. */
export const isActive = (self: CodeFence): boolean => self.language === 'silk'

/** Tests the fence structure that must survive outer syntax-layout normalization. */
export const hasSameStructure = (self: CodeFence, other: CodeFence): boolean =>
  self.language === other.language &&
  self.metadata === other.metadata &&
  self.delimiter === other.delimiter &&
  self.delimiterLength === other.delimiterLength &&
  self.hasAuthoredCloser === other.hasAuthoredCloser &&
  self.containers.length === other.containers.length &&
  self.containers.every((container, index) => container === other.containers[index])

const lineIndent = (source: SourceFile.SourceFile, commentStart: number): Uint8Array => {
  let start = commentStart
  while (start > 0) {
    const byte = source.bytes[start - 1]
    if (byte === 0x0a || byte === 0x0d) break
    start -= 1
  }
  return source.bytes.slice(start, commentStart)
}

const lineBreak = (source: SourceFile.SourceFile, lineEnd: number): Uint8Array => {
  const first = source.bytes[lineEnd]
  const second = source.bytes[lineEnd + 1]
  if (first === 0x0d && second === 0x0a) return Uint8Array.of(0x0d, 0x0a)
  if (first === 0x0d) return Uint8Array.of(0x0d)
  return Uint8Array.of(0x0a)
}

const join = (parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const size = parts.reduce((total, part) => total + part.length, 0)
  const output = new Uint8Array(size)
  let offset = 0
  for (const part of parts) {
    output.set(part, offset)
    offset += part.length
  }
  return output
}

const replacementBytes = (
  source: SourceFile.SourceFile,
  opening: CompilerDocBlock.DocBlock['comments'][number],
  value: Details,
  body: string,
): Uint8Array => {
  const newline = lineBreak(source, opening.span.end)
  const indentation = lineIndent(source, opening.span.start)
  const marker = source.bytes.slice(opening.span.start, opening.span.start + 3)
  const spacing =
    source.bytes[opening.span.start + 3] === 0x20 ? Uint8Array.of(0x20) : new Uint8Array()
  const prefix = encoder.encode(value.continuationPrefix)
  const lines = body === '' ? [] : body.split('\n')
  const parts: Array<Uint8Array> = []
  for (const line of lines) {
    const emptyUncontained = line === '' && prefix.length === 0
    parts.push(
      newline,
      indentation,
      marker,
      ...(emptyUncontained ? [] : [spacing, prefix, encoder.encode(line)]),
    )
  }
  parts.push(newline, indentation)
  return join(parts)
}

/**
 * Rewrites selected bodies and returns the complete raw documentation-block bytes. Unselected
 * prose and fence lines are copied exactly from the supplied source snapshot.
 */
export const rewrite = Effect.fn('CodeFence.rewrite')(function* (
  source: SourceFile.SourceFile,
  block: CompilerDocBlock.DocBlock,
  replacements: ReadonlyArray<Replacement>,
): Effect.fn.Return<Uint8Array, CodeFenceError> {
  if (block.span.sourceId !== source.id)
    return yield* new CodeFenceError({
      operation: 'CodeFence.rewrite',
      sourceId: source.id,
      message: 'Documentation block belongs to another source',
      reason: { _tag: 'InvalidSource', details: block.span.sourceId },
    })

  const edits: Array<{ readonly start: number; readonly end: number; readonly bytes: Uint8Array }> =
    []
  const seen = new Set<number>()
  for (const replacement of replacements) {
    const value = details.get(replacement.fence)
    if (
      value === undefined ||
      value.block.span.sourceId !== block.span.sourceId ||
      value.block.span.start !== block.span.start ||
      value.block.span.end !== block.span.end
    )
      return yield* invalid(
        'CodeFence.rewrite',
        source.id,
        'Replacement fence does not belong to the supplied documentation block',
        `${replacement.fence.source.start}..${replacement.fence.source.end}`,
      )
    if (seen.has(replacement.fence.ordinal))
      return yield* invalid(
        'CodeFence.rewrite',
        source.id,
        'A code fence has more than one replacement',
        `${replacement.fence.ordinal}`,
      )
    seen.add(replacement.fence.ordinal)
    const closingLine = value.closingLine
    const opening = block.comments.at(value.openingLine)
    const closing = closingLine === undefined ? undefined : block.comments.at(closingLine)
    if (opening === undefined || closing === undefined)
      return yield* invalid(
        'CodeFence.rewrite',
        source.id,
        'Only fences with authored closing lines can be rewritten',
        `${replacement.fence.ordinal}`,
      )
    edits.push({
      start: opening.span.end,
      end: closing.span.start,
      bytes: replacementBytes(source, opening, value, replacement.body),
    })
  }

  edits.sort((left, right) => right.start - left.start)
  let output: Uint8Array = source.bytes.slice(block.span.start, block.span.end)
  for (const edit of edits) {
    const start = edit.start - block.span.start
    const end = edit.end - block.span.start
    if (start < 0 || end < start || end > output.length)
      return yield* invalid(
        'CodeFence.rewrite',
        source.id,
        'Replacement range is outside the documentation block',
        `${edit.start}..${edit.end}`,
      )
    output = join([output.slice(0, start), edit.bytes, output.slice(end)])
  }
  return output
})
