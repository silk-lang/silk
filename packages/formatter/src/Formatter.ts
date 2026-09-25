import * as DocBlock from '@silklang/compiler/DocBlock'
import * as FormattedDocument from '@silklang/compiler/FormattedDocument'
import * as Lexer from '@silklang/compiler/Lexer'
import * as Parser from '@silklang/compiler/Parser'
import * as SourceFile from '@silklang/compiler/SourceFile'
import type * as SyntaxFile from '@silklang/compiler/SyntaxFile'
import * as SyntaxFormatter from '@silklang/compiler/SyntaxFormatter'
import * as CodeFence from '@silklang/docgen/CodeFence'
import * as Effect from 'effect/Effect'
import * as FormatterError from './FormatterError.js'

interface NestedContext {
  readonly topFence: FormatterError.SourceRange
  readonly nestedPath: ReadonlyArray<FormatterError.SourceRange>
}

interface BlockInventory {
  readonly block: DocBlock.DocBlock
  readonly fences: ReadonlyArray<CodeFence.CodeFence>
}

interface PlannedBody {
  readonly blockOrdinal: number
  readonly fenceOrdinal: number
  readonly body: string
}

interface Edit {
  readonly start: number
  readonly end: number
  readonly bytes: Uint8Array
}

const decoder = new TextDecoder()

const documentationFailure = (
  sourceId: string,
  error: CodeFence.CodeFenceError,
): FormatterError.FormatterError =>
  new FormatterError.FormatterError({
    operation: 'Formatter.format',
    sourceId,
    message: `Cannot interpret documentation while formatting ${sourceId}`,
    reason: {
      _tag: 'DocumentationInfrastructure',
      details: error.message,
      error,
    },
  })

const reconstructionFailure = (sourceId: string, details: string): FormatterError.FormatterError =>
  new FormatterError.FormatterError({
    operation: 'Formatter.format',
    sourceId,
    message: `Cannot reconstruct documentation while formatting ${sourceId}`,
    reason: { _tag: 'DocumentationInfrastructure', details },
  })

const syntaxFailure = (
  error: SyntaxFormatter.SyntaxFormatterError,
  context: NestedContext | undefined,
): FormatterError.FormatterError =>
  new FormatterError.FormatterError({
    operation: 'Formatter.format',
    sourceId: context?.topFence.sourceId ?? error.sourceId,
    message:
      context === undefined
        ? `Cannot format damaged Silk source ${error.sourceId}`
        : `Cannot format damaged Silk embedded in ${context.topFence.sourceId}`,
    reason:
      context === undefined
        ? { _tag: 'OuterSyntax', diagnostics: error.diagnostics }
        : {
            _tag: 'EmbeddedSyntax',
            fence: context.topFence,
            nestedPath: context.nestedPath,
            diagnostics: error.diagnostics,
          },
  })

const fenceContext = (
  context: NestedContext | undefined,
  fence: FormatterError.SourceRange,
): NestedContext =>
  context === undefined
    ? Object.freeze({ topFence: fence, nestedPath: Object.freeze([]) })
    : Object.freeze({
        topFence: context.topFence,
        nestedPath: Object.freeze([...context.nestedPath, fence]),
      })

const malformedFence = (
  sourceId: string,
  context: NestedContext | undefined,
  fence: FormatterError.SourceRange,
): FormatterError.FormatterError => {
  const location = fenceContext(context, fence)
  return new FormatterError.FormatterError({
    operation: 'Formatter.format',
    sourceId: location.topFence.sourceId,
    message: `Active Silk documentation fence has no authored closer in ${sourceId}`,
    reason: {
      _tag: 'MalformedActiveFence',
      fence: location.topFence,
      nestedPath: location.nestedPath,
    },
  })
}

const inventory = Effect.fnUntraced(function* (
  syntax: SyntaxFile.SyntaxFile,
): Effect.fn.Return<ReadonlyArray<BlockInventory>, FormatterError.FormatterError> {
  const result: Array<BlockInventory> = []
  for (const block of DocBlock.all(syntax)) {
    const fences = yield* CodeFence.all(syntax.source, block).pipe(
      Effect.mapError((error) => documentationFailure(syntax.source.id, error)),
    )
    result.push(Object.freeze({ block, fences }))
  }
  return Object.freeze(result)
})

const parse = (source: SourceFile.SourceFile): SyntaxFile.SyntaxFile =>
  Parser.parse(Lexer.lex(source))

const embeddedSource = (
  parent: SourceFile.SourceFile,
  blockOrdinal: number,
  fenceOrdinal: number,
  body: string,
): SourceFile.SourceFile =>
  SourceFile.make(
    `${parent.id}#documentation/${blockOrdinal}/${fenceOrdinal}`,
    new TextEncoder().encode(body),
    parent.origin,
  )

const withoutFinalNewline = (document: FormattedDocument.FormattedDocument): string => {
  const value = decoder.decode(FormattedDocument.toUint8Array(document))
  return value.endsWith('\n') ? value.slice(0, -1) : value
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

const applyEdits = (original: Uint8Array, edits: ReadonlyArray<Edit>): Uint8Array => {
  let output: Uint8Array = Uint8Array.from(original)
  for (const edit of [...edits].sort((left, right) => right.start - left.start))
    output = join([output.slice(0, edit.start), edit.bytes, output.slice(edit.end)])
  return output
}

const changed = (source: Uint8Array, formatted: Uint8Array): boolean =>
  source.length !== formatted.length || source.some((byte, index) => byte !== formatted[index])

const formatInternal: (
  syntax: SyntaxFile.SyntaxFile,
  context: NestedContext | undefined,
) => Effect.Effect<FormattedDocument.FormattedDocument, FormatterError.FormatterError> =
  Effect.fnUntraced(function* (syntax, context) {
    const outer = yield* SyntaxFormatter.format(syntax).pipe(
      Effect.mapError((error) => syntaxFailure(error, context)),
    )
    const originalInventory = yield* inventory(syntax)
    const planned: Array<PlannedBody> = []

    for (const [blockOrdinal, owner] of originalInventory.entries()) {
      for (const fence of owner.fences) {
        if (!CodeFence.isActive(fence)) continue
        if (!fence.hasAuthoredCloser)
          return yield* malformedFence(syntax.source.id, context, fence.opening)
        const nested = fenceContext(context, fence.source)
        const bodySyntax = parse(
          embeddedSource(syntax.source, blockOrdinal, fence.ordinal, fence.body),
        )
        const formatted = yield* formatInternal(bodySyntax, nested)
        planned.push(
          Object.freeze({
            blockOrdinal,
            fenceOrdinal: fence.ordinal,
            body: withoutFinalNewline(formatted),
          }),
        )
      }
    }

    if (planned.length === 0) return outer

    const canonicalSource = SourceFile.make(
      syntax.source.id,
      FormattedDocument.toUint8Array(outer),
      syntax.source.origin,
    )
    const canonicalSyntax = parse(canonicalSource)
    const canonicalInventory = yield* inventory(canonicalSyntax)
    if (canonicalInventory.length !== originalInventory.length)
      return yield* reconstructionFailure(
        syntax.source.id,
        `Documentation block count changed from ${originalInventory.length} to ${canonicalInventory.length}`,
      )

    const replacements = new Map<number, Array<CodeFence.Replacement>>()
    for (const plan of planned) {
      const originalFence = originalInventory.at(plan.blockOrdinal)?.fences.at(plan.fenceOrdinal)
      const destinationFence = canonicalInventory
        .at(plan.blockOrdinal)
        ?.fences.at(plan.fenceOrdinal)
      if (
        originalFence === undefined ||
        destinationFence === undefined ||
        !CodeFence.hasSameStructure(originalFence, destinationFence)
      )
        return yield* reconstructionFailure(
          syntax.source.id,
          `Documentation fence ${plan.blockOrdinal}/${plan.fenceOrdinal} changed invariant structure`,
        )
      const blockReplacements = replacements.get(plan.blockOrdinal) ?? []
      blockReplacements.push(Object.freeze({ fence: destinationFence, body: plan.body }))
      replacements.set(plan.blockOrdinal, blockReplacements)
    }

    const edits: Array<Edit> = []
    for (const [blockOrdinal, blockReplacements] of replacements) {
      const owner = canonicalInventory.at(blockOrdinal)
      if (owner === undefined)
        return yield* reconstructionFailure(
          syntax.source.id,
          `Documentation block ${blockOrdinal} disappeared before reconstruction`,
        )
      const bytes = yield* CodeFence.rewrite(
        canonicalSource,
        owner.block,
        Object.freeze(blockReplacements),
      ).pipe(Effect.mapError((error) => documentationFailure(syntax.source.id, error)))
      edits.push(Object.freeze({ start: owner.block.span.start, end: owner.block.span.end, bytes }))
    }

    const finalBytes = applyEdits(canonicalSource.bytes, edits)
    const finalSyntax = parse(SourceFile.make(syntax.source.id, finalBytes, syntax.source.origin))
    yield* SyntaxFormatter.validate(finalSyntax).pipe(
      Effect.mapError((error) =>
        reconstructionFailure(
          syntax.source.id,
          `Documentation reconstruction damaged outer syntax: ${error.message} (${error.diagnostics
            .map(
              (diagnostic) =>
                `${diagnostic.code}@${diagnostic.span.start}..${diagnostic.span.end} near ${JSON.stringify(
                  decoder.decode(
                    finalBytes.slice(
                      Math.max(0, diagnostic.span.start - 40),
                      Math.min(finalBytes.length, diagnostic.span.end + 40),
                    ),
                  ),
                )}`,
            )
            .join(', ')})`,
        ),
      ),
    )
    return FormattedDocument.make(finalBytes, changed(syntax.source.bytes, finalBytes))
  })

/** Formats one complete Silk source artifact, including active source-owned documentation fences. */
export const format = Effect.fn('Formatter.format')(function* (
  syntax: SyntaxFile.SyntaxFile,
): Effect.fn.Return<FormattedDocument.FormattedDocument, FormatterError.FormatterError> {
  return yield* formatInternal(syntax, undefined)
})
