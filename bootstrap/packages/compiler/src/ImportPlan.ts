import * as Option from 'effect/Option'
import * as ImportPath from './ImportPath.js'
import * as SourceAction from './SourceAction.js'
import * as SourceFile from './SourceFile.js'
import * as SourceSpan from './SourceSpan.js'
import type * as SyntaxFile from './SyntaxFile.js'
import * as SyntaxTree from './SyntaxTree.js'

export interface Request {
  readonly syntax: SyntaxFile.SyntaxFile
  readonly module: string
  readonly spelling: string
  /** Local binding used when the imported spelling collides with an existing name. */
  readonly localSpelling?: string
}

export interface NamespaceRequest {
  readonly syntax: SyntaxFile.SyntaxFile
  readonly module: string
  readonly spelling: string
  /** Local namespace used when the preferred spelling collides with an existing name. */
  readonly localSpelling?: string
}

export interface NamespacePlan {
  readonly _tag: 'NamespaceImportPlan'
  readonly localSpelling: string
  readonly change?: SourceAction.ChangePlan
}

const renderedMember = (spelling: string, localSpelling: string): string =>
  spelling === localSpelling ? spelling : `${spelling} as ${localSpelling}`

const text = (source: SourceFile.SourceFile, element: SyntaxTree.Element): string | undefined =>
  Option.getOrUndefined(SourceFile.spelling(source, element.span))

const pathOf = (
  source: SourceFile.SourceFile,
  declaration: SyntaxTree.Node,
): string | undefined => {
  const path = SyntaxTree.directNode(declaration, 'ImportPath')
  if (path === undefined || !SyntaxTree.isAvailableSyntax(path)) return undefined
  return ImportPath.canonicalTarget(source, path)
}

const importedSpellings = (
  source: SourceFile.SourceFile,
  list: SyntaxTree.Node,
): ReadonlyArray<string> =>
  SyntaxTree.directNodes(list, 'ImportMember').flatMap((member): ReadonlyArray<string> => {
    if (!SyntaxTree.isAvailableSyntax(member)) return []
    const names = SyntaxTree.tokens(member).filter((token) => token.kind === 'Identifier')
    return names.flatMap((name) => {
      const value = text(source, name)
      return value === undefined ? [] : [value]
    })
  })

const newlineOf = (source: SourceFile.SourceFile): string => {
  for (let index = 0; index < source.bytes.length; index += 1)
    if (source.bytes[index] === 0x0a) return source.bytes[index - 1] === 0x0d ? '\r\n' : '\n'
  return '\n'
}

const indentationAt = (source: SourceFile.SourceFile, offset: number): string => {
  let start = offset
  while (start > 0 && source.bytes[start - 1] !== 0x0a && source.bytes[start - 1] !== 0x0d)
    start -= 1
  let end = start
  while (source.bytes[end] === 0x20 || source.bytes[end] === 0x09) end += 1
  return Array.from(source.bytes.slice(start, end), (byte) => String.fromCharCode(byte)).join('')
}

const containsNewline = (source: SourceFile.SourceFile, start: number, end: number): boolean =>
  source.bytes.slice(start, end).some((byte) => byte === 0x0a || byte === 0x0d)

const insertion = (
  source: SourceFile.SourceFile,
  offset: number,
  replacement: string,
): SourceAction.Edit | undefined => {
  const span = Option.getOrUndefined(SourceSpan.make(source, offset, offset))
  return span === undefined ? undefined : SourceAction.edit(span, replacement)
}

const extendMemberList = (
  source: SourceFile.SourceFile,
  list: SyntaxTree.Node,
  spelling: string,
  localSpelling: string,
): SourceAction.Edit | undefined => {
  if (!SyntaxTree.isAvailableSyntax(list)) return undefined
  const imported = importedSpellings(source, list)
  if (imported.includes(spelling) || imported.includes(localSpelling)) return undefined
  const rendered = renderedMember(spelling, localSpelling)
  const members = SyntaxTree.directNodes(list, 'ImportMember')
  const last = members.at(-1)
  const right = SyntaxTree.directToken(list, 'RightBrace')
  if (last === undefined || right === undefined || !SyntaxTree.isAvailableSyntax(last))
    return undefined
  const tokensAfterLast = SyntaxTree.tokens(list).filter(
    (token) => token.span.start >= last.span.end && token.span.end <= right.span.start,
  )
  const trailingComma = tokensAfterLast.some((token) => token.kind === 'Comma')
  const multiline = containsNewline(source, list.span.start, list.span.end)
  if (!multiline)
    return trailingComma
      ? insertion(source, right.span.start, `${rendered}, `)
      : insertion(source, last.span.end, `, ${rendered}`)
  const newline = newlineOf(source)
  const firstMember = members.at(0)
  const firstName =
    firstMember === undefined ? undefined : SyntaxTree.directToken(firstMember, 'Identifier')
  const indent = indentationAt(source, firstName?.span.start ?? last.span.start)
  return trailingComma
    ? insertion(source, right.span.start, `${indent}${rendered},${newline}`)
    : insertion(source, last.span.end, `,${newline}${indent}${rendered}`)
}

const extendNamespaceImport = (
  source: SourceFile.SourceFile,
  declaration: SyntaxTree.Node,
  spelling: string,
  localSpelling: string,
): SourceAction.Edit | undefined =>
  SyntaxTree.isAvailableSyntax(declaration)
    ? insertion(source, declaration.span.end, ` { ${renderedMember(spelling, localSpelling)} }`)
    : undefined

const newImport = (
  syntax: SyntaxFile.SyntaxFile,
  module: string,
  spelling: string,
  localSpelling: string,
): SourceAction.Edit | undefined => {
  const imports = SyntaxTree.directNodes(syntax.root, 'ImportDeclaration')
  const newline = newlineOf(syntax.source)
  const last = imports.at(-1)
  let leadingModuleDocumentationEnd = 0
  let sawModuleDocumentation = false
  for (const token of syntax.tokens) {
    if (token.kind === 'ModuleDocComment') {
      sawModuleDocumentation = true
      leadingModuleDocumentationEnd = token.span.end
      continue
    }
    if (sawModuleDocumentation && token.kind === 'Whitespace') {
      leadingModuleDocumentationEnd = token.span.end
      continue
    }
    break
  }
  const offset =
    last?.span.end ??
    (sawModuleDocumentation
      ? leadingModuleDocumentationEnd
      : (syntax.root.children.at(0)?.span.start ?? 0))
  const sourceModule = module.split('/').join('.')
  const member = renderedMember(spelling, localSpelling)
  const replacement =
    last === undefined
      ? `import ${sourceModule} { ${member} }${newline}`
      : `${newline}import ${sourceModule} { ${member} }`
  return insertion(syntax.source, offset, replacement)
}

const importInsertionPoint = (
  syntax: SyntaxFile.SyntaxFile,
): { readonly offset: number; readonly prefix: string; readonly suffix: string } => {
  const imports = SyntaxTree.directNodes(syntax.root, 'ImportDeclaration')
  const newline = newlineOf(syntax.source)
  const last = imports.at(-1)
  let leadingModuleDocumentationEnd = 0
  let sawModuleDocumentation = false
  for (const token of syntax.tokens) {
    if (token.kind === 'ModuleDocComment') {
      sawModuleDocumentation = true
      leadingModuleDocumentationEnd = token.span.end
      continue
    }
    if (sawModuleDocumentation && token.kind === 'Whitespace') {
      leadingModuleDocumentationEnd = token.span.end
      continue
    }
    break
  }
  return {
    offset:
      last?.span.end ??
      (sawModuleDocumentation
        ? leadingModuleDocumentationEnd
        : (syntax.root.children.at(0)?.span.start ?? 0)),
    prefix: last === undefined ? '' : newline,
    suffix: last === undefined ? newline : '',
  }
}

const newNamespaceImport = (
  syntax: SyntaxFile.SyntaxFile,
  module: string,
  localSpelling: string,
): SourceAction.Edit | undefined => {
  const point = importInsertionPoint(syntax)
  const sourceModule = module.split('/').join('.')
  return insertion(
    syntax.source,
    point.offset,
    `${point.prefix}import ${sourceModule} as ${localSpelling}${point.suffix}`,
  )
}

const namespaceBinding = (
  source: SourceFile.SourceFile,
  declaration: SyntaxTree.Node,
): string | undefined => {
  const alias = SyntaxTree.directNode(declaration, 'ImportAlias')
  if (alias !== undefined) {
    const token = SyntaxTree.directToken(alias, 'Identifier')
    return token === undefined ? undefined : text(source, token)
  }
  if (SyntaxTree.directNode(declaration, 'ImportMemberList') !== undefined) return undefined
  const path = SyntaxTree.directNode(declaration, 'ImportPath')
  const finalSegment = path === undefined ? undefined : ImportPath.segments(path).at(-1)
  return finalSegment?.kind === 'Identifier' ? text(source, finalSegment) : undefined
}

/** Plans one selected-member import without rewriting unrelated syntax or trivia. */
export const make = (request: Request): Option.Option<SourceAction.ChangePlan> => {
  const localSpelling = request.localSpelling ?? request.spelling
  const imports = SyntaxTree.directNodes(request.syntax.root, 'ImportDeclaration')
  const matching = imports.filter(
    (declaration) => pathOf(request.syntax.source, declaration) === request.module,
  )
  if (matching.length > 1) return Option.none()
  const declaration = matching.at(0)
  let edit: SourceAction.Edit | undefined
  if (declaration === undefined)
    edit = newImport(request.syntax, request.module, request.spelling, localSpelling)
  else {
    const list = SyntaxTree.directNode(declaration, 'ImportMemberList')
    edit =
      list === undefined
        ? extendNamespaceImport(request.syntax.source, declaration, request.spelling, localSpelling)
        : extendMemberList(request.syntax.source, list, request.spelling, localSpelling)
  }
  if (edit === undefined) return Option.none()
  return SourceAction.changePlan({
    preconditions: [SourceAction.precondition(request.syntax.source)],
    changes: [[request.syntax.source.id, [edit]]],
  })
}

/** Plans or reuses one explicit module-namespace import. */
export const namespace = (request: NamespaceRequest): Option.Option<NamespacePlan> => {
  const localSpelling = request.localSpelling ?? request.spelling
  const imports = SyntaxTree.directNodes(request.syntax.root, 'ImportDeclaration')
  const matching = imports.filter(
    (declaration) => pathOf(request.syntax.source, declaration) === request.module,
  )
  if (matching.length > 1) return Option.none()
  const declaration = matching.at(0)
  if (declaration !== undefined) {
    if (!SyntaxTree.isAvailableSyntax(declaration)) return Option.none()
    const existing = namespaceBinding(request.syntax.source, declaration)
    if (existing !== undefined)
      return Option.some({ _tag: 'NamespaceImportPlan', localSpelling: existing })
    const path = SyntaxTree.directNode(declaration, 'ImportPath')
    const list = SyntaxTree.directNode(declaration, 'ImportMemberList')
    if (path === undefined || list === undefined) return Option.none()
    const edit = insertion(request.syntax.source, path.span.end, ` as ${localSpelling}`)
    if (edit === undefined) return Option.none()
    const change = Option.getOrUndefined(
      SourceAction.changePlan({
        preconditions: [SourceAction.precondition(request.syntax.source)],
        changes: [[request.syntax.source.id, [edit]]],
      }),
    )
    if (change === undefined) return Option.none()
    return Option.some({
      _tag: 'NamespaceImportPlan',
      localSpelling,
      change,
    })
  }
  const edit = newNamespaceImport(request.syntax, request.module, localSpelling)
  if (edit === undefined) return Option.none()
  const change = Option.getOrUndefined(
    SourceAction.changePlan({
      preconditions: [SourceAction.precondition(request.syntax.source)],
      changes: [[request.syntax.source.id, [edit]]],
    }),
  )
  if (change === undefined) return Option.none()
  return Option.some({
    _tag: 'NamespaceImportPlan',
    localSpelling,
    change,
  })
}
