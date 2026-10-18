import * as Option from 'effect/Option'
import type * as NameResolution from './NameResolution.js'
import type * as SemanticOccurrence from './SemanticOccurrence.js'
import * as SourceAction from './SourceAction.js'
import * as SourceSpan from './SourceSpan.js'
import type * as SyntaxFile from './SyntaxFile.js'
import * as SyntaxTree from './SyntaxTree.js'

export interface UnusedBinding {
  readonly _tag: 'UnusedImportBinding'
  readonly spelling: string
  readonly span: SourceSpan.SourceSpan
  readonly declarationSpan: SourceSpan.SourceSpan
  readonly change?: SourceAction.ChangePlan
}

type ImportBinding = Extract<
  NameResolution.Binding,
  { readonly _tag: 'ModuleNamespace' | 'ImportedMember' }
>

const hasComment = (syntax: SyntaxFile.SyntaxFile, start: number, end: number): boolean =>
  syntax.tokens.some(
    (token) =>
      token.span.start >= start &&
      token.span.end <= end &&
      (token.kind === 'LineComment' ||
        token.kind === 'DocComment' ||
        token.kind === 'ModuleDocComment'),
  )

const lineSpan = (
  syntax: SyntaxFile.SyntaxFile,
  declaration: SyntaxTree.Node,
): SourceSpan.SourceSpan | undefined => {
  const source = syntax.source
  const keyword = SyntaxTree.directToken(declaration, 'ImportKeyword')
  if (keyword === undefined) return undefined
  let indentationStart = keyword.span.start
  while (
    indentationStart > 0 &&
    (source.bytes[indentationStart - 1] === 0x20 || source.bytes[indentationStart - 1] === 0x09)
  )
    indentationStart -= 1
  const preceding = indentationStart === 0 ? undefined : source.bytes[indentationStart - 1]
  const ownsLine = preceding === undefined || preceding === 0x0a || preceding === 0x0d
  const start = ownsLine ? indentationStart : keyword.span.start
  let end = declaration.span.end
  while (end < source.bytes.length && (source.bytes[end] === 0x20 || source.bytes[end] === 0x09))
    end += 1
  let physicalEnd = end
  while (
    physicalEnd < source.bytes.length &&
    source.bytes[physicalEnd] !== 0x0a &&
    source.bytes[physicalEnd] !== 0x0d
  )
    physicalEnd += 1
  if (hasComment(syntax, keyword.span.start, physicalEnd)) return undefined
  if (ownsLine && source.bytes[end] === 0x0d) end += 1
  if (ownsLine && source.bytes[end] === 0x0a) end += 1
  return Option.getOrUndefined(SourceSpan.make(source, start, end))
}

const clauseSpan = (
  syntax: SyntaxFile.SyntaxFile,
  start: number,
  end: number,
): SourceSpan.SourceSpan | undefined => {
  let ownedStart = start
  while (
    ownedStart > 0 &&
    (syntax.source.bytes[ownedStart - 1] === 0x20 || syntax.source.bytes[ownedStart - 1] === 0x09)
  )
    ownedStart -= 1
  if (hasComment(syntax, ownedStart, end)) return undefined
  return Option.getOrUndefined(SourceSpan.make(syntax.source, ownedStart, end))
}

const removal = (
  syntax: SyntaxFile.SyntaxFile,
  declaration: SyntaxTree.Node,
  binding: ImportBinding,
  memberSpan: SourceSpan.SourceSpan | undefined,
  siblings: ReadonlyArray<NameResolution.Binding>,
): SourceAction.ChangePlan | undefined => {
  const list = SyntaxTree.directNode(declaration, 'ImportMemberList')
  const members = SyntaxTree.directNodes(list ?? declaration, 'ImportMember')
  let span: SourceSpan.SourceSpan | undefined
  if (binding._tag === 'ModuleNamespace' && list !== undefined) {
    const alias = SyntaxTree.directNode(declaration, 'ImportAlias')
    const keyword = alias === undefined ? undefined : SyntaxTree.directToken(alias, 'AsKeyword')
    const local = alias === undefined ? undefined : SyntaxTree.directToken(alias, 'Identifier')
    if (keyword !== undefined && local !== undefined)
      span = clauseSpan(syntax, keyword.span.start, local.span.end)
  } else if (binding._tag === 'ModuleNamespace' || members.length === 1) {
    if (
      binding._tag === 'ImportedMember' &&
      siblings.some(({ _tag }) => _tag === 'ModuleNamespace')
    ) {
      const left = list === undefined ? undefined : SyntaxTree.directToken(list, 'LeftBrace')
      const right = list === undefined ? undefined : SyntaxTree.directToken(list, 'RightBrace')
      if (left !== undefined && right !== undefined)
        span = clauseSpan(syntax, left.span.start, right.span.end)
    } else span = lineSpan(syntax, declaration)
  } else {
    // The authored member presents inside exactly one syntax member; its span locates the node.
    const ordinal =
      memberSpan === undefined
        ? -1
        : members.findIndex(
            (member) => member.span.start <= memberSpan.start && member.span.end >= memberSpan.end,
          )
    const own = members[ordinal]
    if (ordinal < 0 || own === undefined) return undefined
    const next = members.at(ordinal + 1)
    const previous = ordinal === 0 ? undefined : members.at(ordinal - 1)
    const start = next === undefined ? previous?.span.end : own.span.start
    const end = next?.span.start ?? own.span.end
    if (start === undefined) return undefined
    const left = SyntaxTree.directToken(list ?? declaration, 'LeftBrace')
    const right = SyntaxTree.directToken(list ?? declaration, 'RightBrace')
    const guardStart = previous?.span.end ?? left?.span.end ?? own.span.start
    const guardEnd = next?.span.start ?? right?.span.start ?? own.span.end
    if (hasComment(syntax, guardStart, guardEnd)) return undefined
    span = Option.getOrUndefined(SourceSpan.make(syntax.source, start, end))
  }
  if (span === undefined || hasComment(syntax, span.start, span.end)) return undefined
  return Option.getOrUndefined(
    SourceAction.changePlan({
      preconditions: [SourceAction.precondition(syntax.source)],
      changes: [[syntax.source.id, [SourceAction.edit(span, '')]]],
    }),
  )
}

/** Classifies valid authored import bindings independently of their canonical declaration. */
export const unused = (
  syntax: SyntaxFile.SyntaxFile,
  scope: NameResolution.ModuleScope | undefined,
  occurrences: SemanticOccurrence.ModuleIndex | undefined,
): ReadonlyArray<UnusedBinding> => {
  if (scope === undefined || occurrences === undefined) return []
  const conflicted = new Set(scope.conflicts.flatMap((conflict) => conflict.bindings))
  const effective = new Set<NameResolution.Binding>()
  const seen = new Set<string>()
  for (const binding of scope.bindings)
    if (!seen.has(binding.spelling)) {
      seen.add(binding.spelling)
      effective.add(binding)
    }
  const context = scope.context
  // Editing an import rewrites source, so each authored declaration is matched back to the one
  // syntax declaration that presents it. Spans are the only bridge a semantic fact offers.
  const declarations = SyntaxTree.directNodes(syntax.root, 'ImportDeclaration')
  const result: Array<UnusedBinding> = []
  for (const imported of scope.imports) {
    if (imported._tag !== 'Available') continue
    const headerSpan = context.spanOf(imported.import.header.anchor)
    const declaration = declarations.find(
      (candidate) =>
        candidate.span.start <= headerSpan.start && candidate.span.end >= headerSpan.end,
    )
    if (declaration === undefined || !SyntaxTree.isAvailableSyntax(declaration)) continue
    for (const binding of imported.bindings) {
      if (binding._tag === 'ImportedMember' && imported.import.header.public) continue
      if (conflicted.has(binding) || !effective.has(binding)) continue
      if (binding._tag !== 'ModuleNamespace' && binding._tag !== 'ImportedMember') continue
      const authored = context.spanOf(
        binding._tag === 'ModuleNamespace' ? binding.anchor : binding.localAnchor,
      )
      const used = occurrences.occurrences.some(
        (occurrence) =>
          occurrence.importBinding !== undefined &&
          occurrence.importBinding.sourceId === authored.sourceId &&
          occurrence.importBinding.start === authored.start &&
          occurrence.importBinding.end === authored.end,
      )
      if (used) continue
      const change = removal(
        syntax,
        declaration,
        binding,
        binding._tag === 'ImportedMember' ? context.spanOf(binding.member.anchor) : undefined,
        imported.bindings,
      )
      result.push({
        _tag: 'UnusedImportBinding',
        spelling: binding.spelling,
        span: authored,
        declarationSpan: declaration.span,
        ...(change === undefined ? {} : { change }),
      })
    }
  }
  return result.sort((left, right) => left.span.start - right.span.start)
}
