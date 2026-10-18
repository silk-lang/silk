import * as Option from 'effect/Option'
import * as DeclarationFacts from './DeclarationFacts.js'
import type * as DeclarationIndex from './DeclarationIndex.js'
import type * as ModuleClosure from './ModuleClosure.js'
import * as ImportPath from './ImportPath.js'
import * as SemanticContext from './SemanticContext.js'
import * as SourceFile from './SourceFile.js'
import type * as SourceSpan from './SourceSpan.js'
import type * as SyntaxFile from './SyntaxFile.js'
import * as SyntaxTree from './SyntaxTree.js'

/** The import-relevant semantic namespace occupied by one public declaration header. */
export type Namespace = 'Value' | 'Type' | 'ValueAndType'

/** A top-level declaration kind that can be named by a selected-member import. */
export type DeclarationKind =
  | 'Function'
  | 'Constant'
  | 'Struct'
  | 'Union'
  | 'Service'
  | 'Interface'
  | 'Alias'
  | 'Enum'
  | 'Role'

/** One compact public declaration header retained for exact-name candidate lookup. */
export interface PublicDeclaration {
  readonly _tag: 'ModuleSummaryPublicDeclaration'
  readonly spelling: string
  readonly declarationKind: DeclarationKind
  readonly namespace: Namespace
  readonly ordinal: number
  readonly selectionSpan: SourceSpan.SourceSpan
}

/** Header-only import/export facts for one immutable module source. */
export interface ModuleSummary {
  readonly _tag: 'ModuleSummary'
  readonly module: string
  readonly source: SourceFile.SourceFile
  readonly imports: ReadonlyArray<string>
  readonly publicDeclarations: ReadonlyArray<PublicDeclaration>
}

/** The import-relevant kind of one collected member fact. */
const memberKind = (
  member: DeclarationFacts.MemberFact,
): { readonly declarationKind: DeclarationKind; readonly namespace: Namespace } | undefined => {
  switch (member._tag) {
    case 'FunctionDeclaration':
      return { declarationKind: 'Function', namespace: 'Value' }
    case 'ConstantDeclaration':
    case 'PackageParameterDeclaration':
    case 'ForeignStaticDeclaration':
      return { declarationKind: 'Constant', namespace: 'Value' }
    case 'StructDeclaration':
      return { declarationKind: 'Struct', namespace: 'ValueAndType' }
    case 'UnionDeclaration':
      return { declarationKind: 'Union', namespace: 'ValueAndType' }
    case 'EnumDeclaration':
      return { declarationKind: 'Enum', namespace: 'ValueAndType' }
    case 'RoleDeclaration':
      return { declarationKind: 'Role', namespace: 'ValueAndType' }
    case 'ServiceDeclaration':
      return { declarationKind: 'Service', namespace: 'Type' }
    case 'InterfaceDeclaration':
      return { declarationKind: 'Interface', namespace: 'Type' }
    case 'AliasDeclaration':
      return { declarationKind: 'Alias', namespace: 'Type' }
    default:
      return undefined
  }
}

const declarationKind = (
  kind: SyntaxTree.NodeKind,
): { readonly declarationKind: DeclarationKind; readonly namespace: Namespace } | undefined => {
  switch (kind) {
    case 'FunctionDeclaration':
    case 'ForeignFunctionDeclaration':
      return { declarationKind: 'Function', namespace: 'Value' }
    case 'PackageParameterDeclaration':
    case 'ConstantDeclaration':
      return { declarationKind: 'Constant', namespace: 'Value' }
    case 'StructDeclaration':
      return { declarationKind: 'Struct', namespace: 'ValueAndType' }
    case 'UnionDeclaration':
      return { declarationKind: 'Union', namespace: 'ValueAndType' }
    case 'EnumDeclaration':
      return { declarationKind: 'Enum', namespace: 'ValueAndType' }
    case 'RoleDeclaration':
      return { declarationKind: 'Role', namespace: 'ValueAndType' }
    case 'ServiceDeclaration':
      return { declarationKind: 'Service', namespace: 'Type' }
    case 'InterfaceDeclaration':
      return { declarationKind: 'Interface', namespace: 'Type' }
    case 'TypeAliasDeclaration':
      return { declarationKind: 'Alias', namespace: 'Type' }
    default:
      return undefined
  }
}

const spelling = (source: SourceFile.SourceFile, element: SyntaxTree.Element): string | undefined =>
  Option.getOrUndefined(SourceFile.spelling(source, element.span))

const importModule = (
  source: SourceFile.SourceFile,
  declaration: SyntaxTree.Node,
): string | undefined => {
  const path = SyntaxTree.directNode(declaration, 'ImportPath')
  if (path === undefined || !SyntaxTree.isAvailableSyntax(path)) return undefined
  return ImportPath.canonicalTarget(source, path)
}

interface PendingPublicDeclaration {
  readonly spelling: string
  readonly declarationKind: DeclarationKind
  readonly namespace: Namespace
  readonly ordinal: number
  readonly selectionSpan: SourceSpan.SourceSpan
}

const publicHeader = (
  source: SourceFile.SourceFile,
  declaration: SyntaxTree.Node,
  ordinal: number,
): PendingPublicDeclaration | undefined => {
  const kind = declarationKind(declaration.kind)
  const name = SyntaxTree.directToken(declaration, 'Identifier')
  if (
    kind === undefined ||
    SyntaxTree.directToken(declaration, 'PubKeyword') === undefined ||
    name === undefined
  ) {
    return undefined
  }
  const nameSpelling = spelling(source, name)
  if (nameSpelling === undefined) return undefined
  return {
    spelling: nameSpelling,
    declarationKind: kind.declarationKind,
    namespace: kind.namespace,
    ordinal,
    selectionSpan: name.span,
  }
}

const headerSpelling = (
  source: SourceFile.SourceFile,
  declaration: SyntaxTree.Node,
): string | undefined => {
  if (declarationKind(declaration.kind) === undefined) return undefined
  const name = SyntaxTree.directToken(declaration, 'Identifier')
  return name === undefined ? undefined : spelling(source, name)
}

/** Extracts importable header facts without resolving types or elaborating declaration bodies. */
export const make = (syntax: SyntaxFile.SyntaxFile): ModuleSummary => {
  const imports: Array<string> = []
  const pending: Array<PendingPublicDeclaration> = []
  const counts = new Map<string, number>()
  let declarationOrdinal = 0
  for (const element of syntax.root.children) {
    if (!SyntaxTree.isNode(element)) continue
    if (element.kind === 'ImportDeclaration') {
      const imported = importModule(syntax.source, element)
      if (imported !== undefined) imports.push(imported)
      continue
    }
    const declared = headerSpelling(syntax.source, element)
    if (declared !== undefined) counts.set(declared, (counts.get(declared) ?? 0) + 1)
    const exported = publicHeader(syntax.source, element, declarationOrdinal)
    if (declarationKind(element.kind) !== undefined) declarationOrdinal += 1
    if (exported !== undefined) pending.push(exported)
  }
  const publicDeclarations = pending
    .filter((exported) => counts.get(exported.spelling) === 1)
    .map((exported): PublicDeclaration => ({ _tag: 'ModuleSummaryPublicDeclaration', ...exported }))
  return {
    _tag: 'ModuleSummary',
    module: syntax.source.id,
    source: syntax.source,
    imports: imports,
    publicDeclarations: publicDeclarations,
  }
}

/** Tests whether a summary describes the exact same immutable source bytes and provenance. */
export const matchesSource = (self: ModuleSummary, source: SourceFile.SourceFile): boolean =>
  SourceFile.equals(self.source, source)

/** Projects importable declarations from a completed selected index, including public aliases. */
export const selected = (
  module: ModuleClosure.ProjectClosure['modules'][number],
  index: DeclarationIndex.Index,
  context: SemanticContext.SemanticContext = SemanticContext.make(module.authored),
): ModuleSummary => {
  const headers = index.modules.find((candidate) => candidate.module === module.name)
  const names = new Set([
    ...(headers?.members.flatMap((member) =>
      member.name._tag === 'Present' ? [member.name.spelling] : [],
    ) ?? []),
    ...(headers?.publications.map((publication) => publication.spelling) ?? []),
  ])
  const publicDeclarations: Array<PublicDeclaration> = []
  for (const name of names) {
    const found = DeclarationFacts.publishedMember(index, module.name, name)
    if (found._tag !== 'Resolved') continue
    const member = found.declaration
    if (member.visibility !== 'Public' || member.name._tag !== 'Present') continue
    if (member._tag === 'FunctionDeclaration' && member.associatedMember !== undefined) continue
    const kind = memberKind(member)
    if (kind === undefined) continue
    publicDeclarations.push({
      _tag: 'ModuleSummaryPublicDeclaration',
      spelling: name,
      ...kind,
      ordinal: member.id.ordinal,
      selectionSpan: context.spanOf(member.name.anchor),
    })
  }
  return {
    _tag: 'ModuleSummary',
    module: module.name,
    source: module.syntax.source,
    imports: module.imports.flatMap((imported) =>
      imported.canonicalTarget === undefined ? [] : [imported.canonicalTarget],
    ),
    publicDeclarations: publicDeclarations,
  }
}
