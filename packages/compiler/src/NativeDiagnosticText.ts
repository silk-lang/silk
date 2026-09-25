import * as Emitter from '@silklang/llvm/Emitter'
import { type LineTable, lineTable, positionOf } from './Backend.js'
import type * as Mir from './Mir.js'
import type * as NativeDiagnosticContext from './NativeDiagnosticContext.js'
import type * as SourceSpan from './SourceSpan.js'

/** Formats artifact-lifetime origin text independently of any runtime report policy. */
export const origin = (
  context: {
    readonly tables: Map<string, LineTable>
    readonly sources: ReadonlyMap<string, Uint8Array> | undefined
  },
  fn: Pick<Mir.MirFunction, 'id' | 'effectRunner'>,
  span: SourceSpan.SourceSpan,
): string => {
  const id = fn.effectRunner?.base.declaration ?? fn.id
  const name = `${id.module}.${id.name.replace(/(?:\$effect\$-?\d+)+$/, '')}`
  const bytes = context.sources?.get(span.sourceId)
  if (bytes === undefined) return `${name} (${span.sourceId})`
  let table = context.tables.get(span.sourceId)
  if (table === undefined) {
    table = lineTable(bytes)
    context.tables.set(span.sourceId, table)
  }
  const position = positionOf(table, span.start)
  return `${name} (${span.sourceId}:${position.line}:${position.column})`
}

/** Emits a static UTF-8 pointer/length pair whose lifetime exceeds every observer reference. */
export const literal = (
  context: Pick<
    NativeDiagnosticContext.NativeDiagnosticContext,
    'builder' | 'byte' | 'word' | 'literals'
  >,
  value: string,
  name: string,
) => {
  const existing = context.literals.get(value)
  if (existing !== undefined) return existing
  const bytes = new TextEncoder().encode(value)
  const type = Emitter.arrayType(context.builder, context.byte, bytes.length)
  const variable = Emitter.variable(context.builder, `${name}.${context.literals.size}`, type, {
    initializer: Emitter.constantString(context.builder, bytes),
    constant: true,
    linkage: 'internal',
    unnamedAddress: 'unnamed_addr',
  })
  const result = [
    Emitter.fromGlobal(context.builder, Emitter.variableGlobal(context.builder, variable)),
    Emitter.integerUnsigned(context.builder, context.word, BigInt(bytes.length)),
  ] as const
  context.literals.set(value, result)
  return result
}
