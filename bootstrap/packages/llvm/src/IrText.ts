import * as Effect from 'effect/Effect'
import type * as Builder from './Builder.js'
import * as ByteString from './ByteString.js'
import { renderAlias, renderFunction, renderVariable } from './IrText/FunctionRenderer.js'
import {
  type MetadataRender,
  metadataEntry,
  renderMetadataNode,
  renderMetadataReference,
} from './IrText/MetadataRenderer.js'
import { identifier, quoted, rawBytes } from './IrText/shared.js'
import { renderType } from './IrText/TypeRenderer.js'
import * as BuilderState from './internal/BuilderState.js'
import { type LlvmError, wrappedFailure } from './LlvmError.js'
import * as Metadata from './Metadata.js'

/** @internal */
const renderSnapshot = (state: BuilderState.Snapshot): string => {
  const lines: Array<string> = []
  const reachable = Metadata.reachable(state, 'IrText.render')
  const numberEntries = reachable.entries.filter((index) => {
    const entry = state.metadata[index]
    return (
      entry?._tag === 'Node' && entry.value._tag !== 'Constant' && entry.value._tag !== 'Expression'
    )
  })
  const context: MetadataRender = {
    reachable,
    numbers: new Map(numberEntries.map((index, number) => [index, number])),
  }

  if (!ByteString.isEmpty(state.moduleName)) {
    lines.push(`; ModuleID = '${ByteString.escapeForIr(state.moduleName)}'`)
  }
  if (!ByteString.isEmpty(state.sourceFilename)) {
    lines.push(`source_filename = ${quoted(state.sourceFilename)}`)
  }
  if (!ByteString.isEmpty(state.dataLayout)) {
    lines.push(`target datalayout = ${quoted(state.dataLayout)}`)
  }
  if (!ByteString.isEmpty(state.targetTriple)) {
    lines.push(`target triple = ${quoted(state.targetTriple)}`)
  }

  const assembly = state.moduleAssembly.flatMap(ByteString.splitLines)
  if (lines.length > 0 && assembly.length > 0) lines.push('')
  for (const fragment of assembly) lines.push(`module asm ${quoted(fragment)}`)

  const namedTypes = state.types.flatMap((description) => {
    if (description._tag !== 'NamedStructure') return []
    const body = description.body
    if (body === undefined) return [`${identifier('%', description.name)} = type opaque`]
    const fields = body.fields.map((field) => renderType(state, field)).join(', ')
    return [
      `${identifier('%', description.name)} = type ${body.packed ? `<{ ${fields} }>` : `{ ${fields} }`}`,
    ]
  })
  if (namedTypes.length > 0) {
    if (lines.length > 0) lines.push('')
    lines.push(...namedTypes)
  }

  const globals = state.globals.flatMap((global, globalIndex) => {
    if (global.deleted || global.replacement !== undefined) return []
    if (global.kind === 'Variable') return [renderVariable(state, global, context, globalIndex)]
    if (global.kind === 'Alias') return [renderAlias(state, global)]
    return [renderFunction(state, global, context, globalIndex)]
  })
  if (globals.length > 0) {
    if (lines.length > 0) lines.push('')
    lines.push(...globals)
  }

  const namedMetadata = state.namedMetadata.map(
    (named) =>
      `!${rawBytes(named.name)} = !{${named.operands
        .map((operand) => renderMetadataReference(state, context, operand))
        .join(', ')}}`,
  )
  const definitions = numberEntries.map((index) => {
    const resolved = metadataEntry(state, context, index)
    if (resolved.entry._tag !== 'Node') throw new Error('numbered metadata is not a node')
    const number = context.numbers.get(resolved.index)
    if (number === undefined) throw new Error('numbered metadata entry has no number')
    return `!${number} = ${resolved.entry.value.distinct ? 'distinct ' : ''}${renderMetadataNode(state, context, resolved.entry.value)}`
  })
  if (namedMetadata.length > 0 || definitions.length > 0) {
    if (lines.length > 0) lines.push('')
    lines.push(...namedMetadata, ...definitions)
  }

  return lines.length === 0 ? '' : `${lines.join('\n')}\n`
}

/**
 * Renders the current builder snapshot as deterministic textual LLVM IR.
 *
 * **Details**
 *
 * Names, escaping, declarations, instructions, attributes, and metadata use the same semantic
 * state as `Bitcode.encode`; rendering does not mutate or consume the builder.
 *
 * **Gotchas**
 *
 * Unresolved or invalid module state fails with {@link LlvmError}.
 *
 * **Example** (Rendering LLVM IR)
 *
 * Render module headers and declarations as LLVM assembly.
 *
 * ```ts
 * import * as Effect from 'effect/Effect'
 * import * as Builder from '@silklang/llvm/Builder'
 * import * as IrText from '@silklang/llvm/IrText'
 *
 * const text = await Effect.runPromise(Effect.gen(function* () {
 *   const builder = yield* Builder.make({ sourceFilename: 'example.ll' })
 *   return yield* IrText.render(builder)
 * }))
 * // text === 'source_filename = "example.ll"\n'
 * ```
 *
 * @category serialization
 * @since 0.0.0
 */
export const render = Effect.fnUntraced(function* (
  self: Builder.Builder,
): Effect.fn.Return<string, LlvmError> {
  const state = yield* BuilderState.snapshot(self, 'IrText.render')
  return yield* Effect.try({
    try: () => renderSnapshot(state),
    catch: (cause) =>
      wrappedFailure({
        operation: 'IrText.render',
        message:
          cause instanceof Error
            ? `LLVM IR rendering failed: ${cause.message}`
            : 'LLVM IR rendering failed',
        cause: cause,
      }),
  })
})
