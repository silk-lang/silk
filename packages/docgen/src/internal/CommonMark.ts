import type * as CompilerDocBlock from '@silklang/compiler/DocBlock'
import type * as SourceFile from '@silklang/compiler/SourceFile'
import * as Data from 'effect/Data'
import * as Result from 'effect/Result'
import type { Root, RootContent } from 'mdast'
import { fromMarkdown } from 'mdast-util-from-markdown'

export interface SourceRange {
  readonly sourceId: string
  readonly start: number
  readonly end: number
}

export interface Line {
  readonly normalizedStart: number
  readonly normalizedEnd: number
  readonly contentStart: number
  readonly comment: CompilerDocBlock.DocBlock['comments'][number]
}

export interface Normalized {
  readonly markdown: string
  readonly offsets: ReadonlyArray<number>
  readonly lines: ReadonlyArray<Line>
}

export class CommonMarkError extends Data.TaggedError('CommonMarkError')<{
  readonly operation: 'CommonMark.normalize' | 'CommonMark.parse'
  readonly message: string
  readonly reason:
    | { readonly _tag: 'InvalidSource'; readonly details: string }
    | { readonly _tag: 'WrappedParserFailure'; readonly cause: unknown }
}> {}

const decoder = new TextDecoder()
const encoder = new TextEncoder()

const contentStart = (source: SourceFile.SourceFile, start: number, end: number): number =>
  start + 3 < end && source.bytes[start + 3] === 0x20 ? start + 4 : start + 3

export const normalize = (
  source: SourceFile.SourceFile,
  block: CompilerDocBlock.DocBlock,
): Result.Result<Normalized, CommonMarkError> => {
  if (block.span.sourceId !== source.id)
    return Result.fail(
      new CommonMarkError({
        operation: 'CommonMark.normalize',
        message: 'Documentation block belongs to another source',
        reason: {
          _tag: 'InvalidSource',
          details: `${block.span.sourceId} does not match ${source.id}`,
        },
      }),
    )

  let markdown = ''
  const offsets: Array<number> = []
  const lines: Array<Line> = []
  for (const [index, comment] of block.comments.entries()) {
    if (
      comment.span.sourceId !== source.id ||
      comment.span.start < 0 ||
      comment.span.end > source.bytes.length ||
      comment.span.end - comment.span.start < 3
    )
      return Result.fail(
        new CommonMarkError({
          operation: 'CommonMark.normalize',
          message: 'Documentation comment range is outside its source',
          reason: {
            _tag: 'InvalidSource',
            details: `${comment.span.start}..${comment.span.end} is invalid for ${source.id}`,
          },
        }),
      )

    const start = contentStart(source, comment.span.start, comment.span.end)
    if (index > 0) {
      offsets[markdown.length] = block.comments[index - 1]?.span.end ?? start
      markdown += '\n'
      offsets[markdown.length] = start
    }
    const normalizedStart = markdown.length
    const value = decoder.decode(source.bytes.slice(start, comment.span.end))
    let byteOffset = start
    for (const character of value) {
      for (let unit = 0; unit < character.length; unit += 1)
        offsets[markdown.length + unit] = byteOffset
      markdown += character
      byteOffset += encoder.encode(character).length
      offsets[markdown.length] = byteOffset
    }
    lines.push(
      Object.freeze({
        normalizedStart,
        normalizedEnd: markdown.length,
        contentStart: start,
        comment,
      }),
    )
  }
  offsets[markdown.length] ??= block.span.end
  return Result.succeed(
    Object.freeze({
      markdown,
      offsets: Object.freeze(offsets),
      lines: Object.freeze(lines),
    }),
  )
}

export const parse = (normalized: Normalized): Result.Result<Root, CommonMarkError> =>
  Result.try({
    try: () => fromMarkdown(normalized.markdown),
    catch: (cause) =>
      new CommonMarkError({
        operation: 'CommonMark.parse',
        message: 'CommonMark parser failed',
        reason: { _tag: 'WrappedParserFailure', cause },
      }),
  })

export const sourceRange = (
  block: CompilerDocBlock.DocBlock,
  normalized: Normalized,
  position: RootContent['position'],
): SourceRange => {
  const startOffset = position?.start.offset
  const endOffset = position?.end.offset
  return Object.freeze({
    sourceId: block.span.sourceId,
    start:
      startOffset === undefined
        ? block.span.start
        : (normalized.offsets[startOffset] ?? block.span.start),
    end:
      endOffset === undefined ? block.span.end : (normalized.offsets[endOffset] ?? block.span.end),
  })
}
