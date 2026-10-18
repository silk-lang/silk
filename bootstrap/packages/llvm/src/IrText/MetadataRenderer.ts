import * as DIFlags from '../DIFlags.js'
import * as DISPFlags from '../DISPFlags.js'
import type * as BuilderState from '../internal/BuilderState.js'
import type * as MetadataDescription from '../internal/MetadataDescription.js'
import type * as Metadata from '../Metadata.js'
import { renderTypedConstant } from './ConstantRenderer.js'
import { quoted } from './shared.js'

export interface MetadataRender {
  readonly reachable: Metadata.Reachable
  readonly numbers: ReadonlyMap<number, number>
}

/** @internal */
export const resolvedMetadataIndex = (context: MetadataRender, index: number): number => {
  const seen = new Set<number>()
  let current = index
  while (true) {
    if (seen.has(current)) throw new Error('metadata forward-reference cycle')
    seen.add(current)
    const target = context.reachable.resolved.get(current)
    if (target === undefined) return current
    current = target
  }
}

/** @internal */
export const metadataEntry = (
  state: BuilderState.Snapshot,
  context: MetadataRender,
  index: number,
): { readonly index: number; readonly entry: MetadataDescription.Entry } => {
  const resolved = resolvedMetadataIndex(context, index)
  const entry = state.metadata[resolved]
  if (entry === undefined) throw new Error(`missing metadata ${resolved}`)
  return { index: resolved, entry }
}

/** @internal */
export const metadataString = (
  state: BuilderState.Snapshot,
  context: MetadataRender,
  index: number | undefined,
): string | undefined => {
  if (index === undefined) return undefined
  const resolved = metadataEntry(state, context, index).entry
  if (resolved._tag !== 'String') throw new Error('expected metadata string')
  return quoted(resolved.value)
}

/** @internal */
export const renderMetadataReference = (
  state: BuilderState.Snapshot,
  context: MetadataRender,
  index: number | undefined,
): string | undefined => {
  if (index === undefined) return undefined
  const resolved = metadataEntry(state, context, index)
  if (resolved.entry._tag === 'String') return `!${quoted(resolved.entry.value)}`
  if (resolved.entry._tag === 'Forward') throw new Error('unresolved metadata forward reference')
  if (resolved.entry.value._tag === 'Constant') {
    return renderTypedConstant(state, resolved.entry.value.constant)
  }
  if (resolved.entry.value._tag === 'Expression') {
    return `!DIExpression(${resolved.entry.value.elements.join(', ')})`
  }
  const number = context.numbers.get(resolved.index)
  if (number === undefined) throw new Error(`metadata ${resolved.index} has no text number`)
  return `!${number}`
}

/** @internal */
export const metadataFields = (
  values: ReadonlyArray<readonly [string, string | number | bigint | boolean | undefined]>,
): string =>
  values
    .flatMap(([name, value]) => (value === undefined ? [] : [`${name}: ${String(value)}`]))
    .join(', ')

/** @internal */
export const renderMetadataNode = (
  state: BuilderState.Snapshot,
  context: MetadataRender,
  node: MetadataDescription.Node,
): string => {
  const ref = (index: number | undefined): string | undefined =>
    renderMetadataReference(state, context, index)
  const string = (index: number | undefined): string | undefined =>
    metadataString(state, context, index)
  switch (node._tag) {
    case 'Tuple':
      return `!{${node.elements.map((element) => ref(element) ?? 'null').join(', ')}}`
    case 'Constant':
      return `!{${renderTypedConstant(state, node.constant)}}`
    case 'Local':
      return `!{!${quoted(node.label)}}`
    case 'File':
      // Both fields are required by the textual parser; bitcode stores an absent operand as a
      // null string, which reads back as the empty string.
      return `!DIFile(${metadataFields([
        ['filename', string(node.filename) ?? '""'],
        ['directory', string(node.directory) ?? '""'],
      ])})`
    case 'CompileUnit':
      return `!DICompileUnit(${metadataFields([
        ['language', 'DW_LANG_C99'],
        ['file', ref(node.file)],
        ['producer', string(node.producer)],
        ['isOptimized', node.optimized],
        ['runtimeVersion', 0],
        ['emissionKind', 'FullDebug'],
        ['enums', ref(node.enums)],
        ['globals', ref(node.globals)],
        // Bitcode writes this operand as false, while the textual default is true.
        ['splitDebugInlining', false],
      ])})`
    case 'Subprogram':
      return `!DISubprogram(${metadataFields([
        ['scope', ref(node.file)],
        ['name', string(node.name)],
        ['linkageName', string(node.linkageName)],
        ['file', ref(node.file)],
        ['line', node.line],
        ['type', ref(node.type)],
        ['scopeLine', node.scopeLine],
        ['flags', DIFlags.render({ bits: node.diFlags })],
        ['spFlags', DISPFlags.render({ bits: node.spFlags })],
        ['unit', ref(node.compileUnit)],
      ])})`
    case 'LexicalBlock':
      return `!DILexicalBlock(${metadataFields([
        ['scope', ref(node.scope)],
        ['file', ref(node.file)],
        ['line', node.line],
        ['column', node.column],
      ])})`
    case 'Location':
      return `!DILocation(${metadataFields([
        ['line', node.line],
        ['column', node.column],
        ['scope', ref(node.scope)],
        ['inlinedAt', ref(node.inlinedAt)],
      ])})`
    case 'BasicType': {
      const encoding: Readonly<Record<MetadataDescription.BasicEncoding, string>> = {
        boolean: 'DW_ATE_boolean',
        unsigned: 'DW_ATE_unsigned',
        signed: 'DW_ATE_signed',
        float: 'DW_ATE_float',
      }
      return `!DIBasicType(${metadataFields([
        ['name', string(node.name)],
        ['size', node.sizeInBits],
        ['encoding', encoding[node.encoding]],
      ])})`
    }
    case 'StringType': {
      const encoding: Readonly<Record<MetadataDescription.StringEncoding, string>> = {
        utf: 'DW_ATE_UTF',
      }
      return `!DIStringType(${metadataFields([
        ['name', string(node.name)],
        ['stringLength', ref(node.stringLength)],
        ['stringLengthExpression', ref(node.stringLengthExpression)],
        ['stringLocationExpression', ref(node.stringLocationExpression)],
        ['size', node.sizeInBits],
        ['align', node.alignInBits],
        ['encoding', encoding[node.encoding]],
      ])})`
    }
    case 'CompositeType': {
      const tag: Readonly<Record<MetadataDescription.CompositeKind, string>> = {
        structure: 'DW_TAG_structure_type',
        union: 'DW_TAG_union_type',
        enumeration: 'DW_TAG_enumeration_type',
        array: 'DW_TAG_array_type',
        vector: 'DW_TAG_array_type',
      }
      return `!DICompositeType(${metadataFields([
        ['tag', tag[node.kind]],
        ['name', string(node.name)],
        ['scope', ref(node.scope)],
        ['file', ref(node.file)],
        ['line', node.line],
        ['baseType', ref(node.underlyingType)],
        ['size', node.sizeInBits],
        ['align', node.alignInBits],
        ['flags', DIFlags.render({ bits: node.flags })],
        ['elements', ref(node.fields)],
      ])})`
    }
    case 'DerivedType': {
      const tag: Readonly<Record<MetadataDescription.DerivedKind, string>> = {
        pointer: 'DW_TAG_pointer_type',
        member: 'DW_TAG_member',
        typedef: 'DW_TAG_typedef',
      }
      return `!DIDerivedType(${metadataFields([
        ['tag', tag[node.kind]],
        ['name', string(node.name)],
        ['scope', ref(node.scope)],
        ['file', ref(node.file)],
        ['line', node.line],
        ['baseType', ref(node.underlyingType)],
        ['size', node.sizeInBits],
        ['align', node.alignInBits],
        ['offset', node.offsetInBits],
        ['flags', DIFlags.render({ bits: node.flags })],
      ])})`
    }
    case 'SubroutineType':
      return `!DISubroutineType(${metadataFields([
        ['types', ref(node.types)],
        ['flags', DIFlags.render({ bits: node.flags })],
      ])})`
    case 'Enumerator':
      return `!DIEnumerator(${metadataFields([
        ['name', string(node.name)],
        ['value', node.value],
        ['isUnsigned', node.unsigned ? true : undefined],
      ])})`
    case 'Subrange':
      return `!DISubrange(${metadataFields([
        ['count', ref(node.count)],
        ['lowerBound', ref(node.lowerBound)],
      ])})`
    case 'Expression':
      return `!DIExpression(${node.elements.join(', ')})`
    case 'LocalVariable':
      return `!DILocalVariable(${metadataFields([
        ['name', string(node.name)],
        ['arg', node.argument === 0 ? undefined : node.argument],
        ['scope', ref(node.scope)],
        ['file', ref(node.file)],
        ['line', node.line],
        ['type', ref(node.type)],
        ['flags', DIFlags.render({ bits: node.flags })],
      ])})`
    case 'GlobalVariable':
      return `!DIGlobalVariable(${metadataFields([
        ['name', string(node.name)],
        ['linkageName', string(node.linkageName)],
        ['scope', ref(node.scope)],
        ['file', ref(node.file)],
        ['line', node.line],
        ['type', ref(node.type)],
        ['isLocal', node.local],
        ['isDefinition', true],
      ])})`
    case 'GlobalVariableExpression':
      return `!DIGlobalVariableExpression(${metadataFields([
        ['var', ref(node.variable)],
        ['expr', ref(node.expression)],
      ])})`
  }
}

/** @internal */
export const renderMetadataAttachments = (
  state: BuilderState.Snapshot,
  context: MetadataRender,
  attachments: ReadonlyArray<MetadataDescription.Attachment>,
): string =>
  attachments
    .map((attachment) =>
      attachment.kind === 'unpredictable'
        ? '!unpredictable !{}'
        : `!${attachment.kind} ${renderMetadataReference(state, context, attachment.metadata)}`,
    )
    .join(', ')
