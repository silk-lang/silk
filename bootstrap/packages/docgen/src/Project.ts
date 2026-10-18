import * as Analysis from '@silklang/compiler/Analysis'
import * as DeclarationFacts from '@silklang/compiler/DeclarationFacts'
import * as SemanticDisplay from '@silklang/compiler/SemanticDisplay'
import * as Type from '@silklang/compiler/Type'
import type * as ProjectAnalysis from '@silklang/compiler/ProjectAnalysis'
import type * as SourceFile from '@silklang/compiler/SourceFile'
import type * as AuthoredHir from '@silklang/compiler/AuthoredHir'
import type * as SemanticContext from '@silklang/compiler/SemanticContext'
import * as Document from './Document.js'

export type ItemKind =
  | 'Function'
  | 'Struct'
  | 'Enum'
  | 'EnumMember'
  | 'Union'
  | 'UnionVariant'
  | 'Service'
  | 'Interface'
  | 'Constant'
  | 'Role'
  | 'Alias'
  | 'Parameter'
  | 'TypeParameter'
  | 'Field'
  | 'Implementation'
  | 'Operation'
  | 'Method'
  | 'AssociatedFunction'

export interface Signature {
  readonly text: string
}

export interface Item {
  readonly id: string
  readonly kind: ItemKind
  readonly name: string
  readonly visibility: 'Public' | 'Private' | 'Inherited'
  readonly signature: Signature
  readonly source: Document.SourceRange
  readonly documentation?: Document.Document
  readonly children: ReadonlyArray<Item>
}

export interface Module {
  readonly name: string
  readonly sourceId: string
  readonly documentation?: Document.Document
  readonly items: ReadonlyArray<Item>
}

/** The experimental, formatter-neutral project documentation model. */
export interface Project {
  readonly schema: 'silk-documentation'
  readonly experimental: true
  readonly profile?: { readonly identity: string; readonly target: string }
  readonly modules: ReadonlyArray<Module>
}

export interface Options {
  readonly includePrivate?: boolean
}

const nameOf = (name: DeclarationFacts.DeclaredName, fallback: string): string =>
  name._tag === 'Present' ? name.spelling : fallback

const declarationId = (module: string, member: DeclarationFacts.MemberFact): string =>
  member.canonical._tag === 'Canonical'
    ? `${member.canonical.id.module}::${member.canonical.id.name}`
    : `${module}::#${member.id.ordinal}`

const linkTargetKind = (member: DeclarationFacts.MemberFact): Document.LinkTarget['kind'] => {
  switch (member._tag) {
    case 'FunctionDeclaration':
      return 'Function'
    case 'StructDeclaration':
      return 'Struct'
    case 'EnumDeclaration':
      return 'Enum'
    case 'UnionDeclaration':
      return 'Union'
    case 'ServiceDeclaration':
      return 'Service'
    case 'InterfaceDeclaration':
      return 'Interface'
    case 'RoleDeclaration':
      return 'Role'
    case 'AliasDeclaration':
      return 'Alias'
    default:
      return 'Constant'
  }
}

const isAssociated = (
  member: DeclarationFacts.MemberFact,
): member is DeclarationFacts.DeclarationFact & {
  readonly associatedMember: DeclarationFacts.AssociatedMemberFact
} => member._tag === 'FunctionDeclaration' && member.associatedMember !== undefined

const sameId = (left: DeclarationFacts.CanonicalId, right: DeclarationFacts.CanonicalId): boolean =>
  left.module === right.module && left.name === right.name

/** The owner whose associated members a doc block attached to this declaration links first. */
const ownerOf = (member: DeclarationFacts.MemberFact): DeclarationFacts.CanonicalId | undefined => {
  if (isAssociated(member)) return member.associatedMember.owner
  return member.canonical._tag === 'Canonical' ? member.canonical.id : undefined
}

const itemKind = (member: DeclarationFacts.MemberFact): ItemKind => {
  switch (member._tag) {
    case 'FunctionDeclaration':
      if (member.associatedMember === undefined) return 'Function'
      return member.associatedMember.receiver ? 'Method' : 'AssociatedFunction'
    case 'StructDeclaration':
      return 'Struct'
    case 'EnumDeclaration':
      return 'Enum'
    case 'UnionDeclaration':
      return 'Union'
    case 'ServiceDeclaration':
      return 'Service'
    case 'InterfaceDeclaration':
      return 'Interface'
    case 'RoleDeclaration':
      return 'Role'
    case 'AliasDeclaration':
      return 'Alias'
    default:
      return 'Constant'
  }
}

const rangeOf = (
  spans: SemanticContext.Registry,
  anchor: AuthoredHir.Anchor,
): Document.SourceRange => {
  const span = spans.spanOf(anchor)
  return Object.freeze({ sourceId: span.sourceId, start: span.start, end: span.end })
}

const parsedDocumentation = (
  snapshot: Analysis.FrontendSnapshot,
  source: SourceFile.SourceFile,
  anchor: AuthoredHir.Anchor,
): Document.Document | undefined => {
  const raw = Analysis.documentationOfAnchor(snapshot, anchor)
  return raw === undefined ? undefined : Document.parse(source, raw)
}

/**
 * A `[`member`]` link inside the owner's module reaches an inherent member, which the unqualified
 * root lookup cannot see. The doc block's own owner wins; otherwise the member must be unique
 * across the module's owners.
 */
const associatedTarget = (
  snapshot: Analysis.FrontendSnapshot,
  module: string,
  spelling: string,
  owner: DeclarationFacts.CanonicalId | undefined,
): Document.LinkTarget | undefined => {
  const modules = Analysis.declarationIndex(snapshot).modules
  const headers = modules.find((candidate) => candidate.module === module)
  // `[`member`]` names a member of the enclosing owner or of any owner in the module;
  // `[`Owner.member`]` names one owner's member explicitly, in this module or any other.
  const dot = spelling.indexOf('.')
  const ownerSpelling = dot === -1 ? undefined : spelling.slice(0, dot)
  const memberName = dot === -1 ? spelling : spelling.slice(dot + 1)
  const searched =
    ownerSpelling === undefined
      ? (headers?.members ?? [])
      : modules.flatMap((candidate) => candidate.members)
  const candidates = searched.filter(
    (member) =>
      isAssociated(member) &&
      member.associatedMember.name === memberName &&
      (ownerSpelling === undefined || member.associatedMember.ownerSpelling === ownerSpelling) &&
      member.canonical._tag === 'Canonical',
  )
  const preferred =
    owner === undefined
      ? undefined
      : candidates.find(
          (member) =>
            isAssociated(member) &&
            member.associatedMember.owner !== undefined &&
            sameId(member.associatedMember.owner, owner),
        )
  const member = preferred ?? (candidates.length === 1 ? candidates.at(0) : undefined)
  if (member === undefined || member.canonical._tag !== 'Canonical') return undefined
  return Object.freeze({
    id: declarationId(module, member),
    module: member.canonical.id.module,
    name: member.canonical.id.name,
    kind: 'Function',
  })
}

const targetOf = (
  snapshot: Analysis.FrontendSnapshot,
  module: string,
  spelling: string,
  owner: DeclarationFacts.CanonicalId | undefined,
): Document.LinkTarget | undefined => {
  const associated = associatedTarget(snapshot, module, spelling, owner)
  if (associated !== undefined) return associated
  const lookup = Analysis.lookupName(snapshot, module, spelling)
  if (lookup._tag === 'Resolved') {
    const targetModule =
      lookup.declaration.canonical._tag === 'Canonical'
        ? lookup.declaration.canonical.id.module
        : lookup.declaration.id.sourceId
    const targetName = nameOf(lookup.declaration.name, spelling)
    return Object.freeze({
      id: declarationId(targetModule, lookup.declaration),
      module: targetModule,
      name: targetName,
      kind: linkTargetKind(lookup.declaration),
    })
  }

  const index = Analysis.declarationIndex(snapshot)
  const parentIsVisible = (parent: DeclarationFacts.MemberFact): boolean => {
    if (parent.name._tag !== 'Present') return false
    const visible = Analysis.lookupName(snapshot, module, parent.name.spelling)
    return visible._tag === 'Resolved' && visible.declaration === parent
  }
  const enumMembers = index.modules.flatMap((headers) =>
    headers.enums.flatMap((enum_) =>
      parentIsVisible(enum_)
        ? enum_.members.flatMap((member) =>
            member.name._tag === 'Present' && member.name.spelling === spelling
              ? [Object.freeze({ enum_, member })]
              : [],
          )
        : [],
    ),
  )
  const unionVariants = index.modules.flatMap((headers) =>
    headers.unions.flatMap((union) =>
      parentIsVisible(union)
        ? union.variants.flatMap((variant) =>
            variant.name._tag === 'Present' && variant.name.spelling === spelling
              ? [Object.freeze({ union, variant })]
              : [],
          )
        : [],
    ),
  )
  if (enumMembers.length + unionVariants.length !== 1) return undefined
  const enumMember = enumMembers.at(0)
  if (enumMember !== undefined) {
    const targetModule =
      enumMember.enum_.canonical._tag === 'Canonical'
        ? enumMember.enum_.canonical.id.module
        : enumMember.enum_.id.sourceId
    return Object.freeze({
      id: `${declarationId(targetModule, enumMember.enum_)}::member:${enumMember.member.id.ordinal}`,
      module: targetModule,
      name: spelling,
      kind: 'EnumMember',
    })
  }
  const unionVariant = unionVariants.at(0)
  if (unionVariant === undefined) return undefined
  const targetModule =
    unionVariant.union.canonical._tag === 'Canonical'
      ? unionVariant.union.canonical.id.module
      : unionVariant.union.id.sourceId
  return Object.freeze({
    id: `${declarationId(targetModule, unionVariant.union)}::variant:${unionVariant.variant.id.ordinal}`,
    module: targetModule,
    name: spelling,
    kind: 'UnionVariant',
  })
}

const resolveDocumentation = (
  snapshot: Analysis.FrontendSnapshot,
  module: string,
  documentation: Document.Document | undefined,
  owner: DeclarationFacts.CanonicalId | undefined,
): Document.Document | undefined =>
  documentation === undefined
    ? undefined
    : Document.resolve(documentation, (spelling) => targetOf(snapshot, module, spelling, owner))

const typeParameterItem = (
  snapshot: Analysis.FrontendSnapshot,
  module: string,
  source: SourceFile.SourceFile,
  spans: SemanticContext.Registry,
  ownerId: string,
  parameter: DeclarationFacts.TypeParameterFact,
  ordinal: number,
  owner: DeclarationFacts.CanonicalId | undefined,
): Item => {
  const presentation = SemanticDisplay.typeParameter(parameter)
  const documentation = resolveDocumentation(
    snapshot,
    module,
    parsedDocumentation(snapshot, source, parameter.anchor),
    owner,
  )
  return Object.freeze({
    id: `${ownerId}::type-parameter:${ordinal}`,
    kind: 'TypeParameter',
    name: nameOf(parameter.name, parameter.type.name),
    visibility: 'Inherited',
    signature: Object.freeze({ text: presentation.text }),
    source: rangeOf(spans, parameter.anchor),
    ...(documentation === undefined ? {} : { documentation }),
    children: Object.freeze([]),
  })
}

const parameterItem = (
  snapshot: Analysis.FrontendSnapshot,
  module: string,
  source: SourceFile.SourceFile,
  spans: SemanticContext.Registry,
  ownerId: string,
  parameter: DeclarationFacts.ParameterFact,
  owner: DeclarationFacts.CanonicalId | undefined,
): Item => {
  const presentation = SemanticDisplay.parameter(parameter)
  const documentation = resolveDocumentation(
    snapshot,
    module,
    parsedDocumentation(snapshot, source, parameter.anchor),
    owner,
  )
  return Object.freeze({
    id: `${ownerId}::parameter:${parameter.id.ordinal}`,
    kind: 'Parameter',
    name: nameOf(parameter.name, '_'),
    visibility: 'Inherited',
    signature: Object.freeze({ text: presentation.text }),
    source: rangeOf(spans, parameter.anchor),
    ...(documentation === undefined ? {} : { documentation }),
    children: Object.freeze([]),
  })
}

const fieldItem = (
  snapshot: Analysis.FrontendSnapshot,
  module: string,
  source: SourceFile.SourceFile,
  spans: SemanticContext.Registry,
  ownerId: string,
  field: DeclarationFacts.FieldFact,
  owner: DeclarationFacts.CanonicalId | undefined,
): Item => {
  const presentation = SemanticDisplay.field(field)
  const documentation = resolveDocumentation(
    snapshot,
    module,
    parsedDocumentation(snapshot, source, field.anchor),
    owner,
  )
  return Object.freeze({
    id: `${ownerId}::field:${field.id.ordinal}`,
    kind: 'Field',
    name: nameOf(field.name, '_'),
    visibility: field.visibility,
    signature: Object.freeze({ text: presentation.text }),
    source: rangeOf(spans, field.anchor),
    ...(documentation === undefined ? {} : { documentation }),
    children: Object.freeze([]),
  })
}

const serviceOperationItem = (
  snapshot: Analysis.FrontendSnapshot,
  module: string,
  source: SourceFile.SourceFile,
  spans: SemanticContext.Registry,
  ownerId: string,
  operation: DeclarationFacts.ServiceOperationFact,
  owner: DeclarationFacts.CanonicalId | undefined,
): Item => {
  const presentation = SemanticDisplay.serviceOperation(operation)
  const documentation = resolveDocumentation(
    snapshot,
    module,
    parsedDocumentation(snapshot, source, operation.anchor),
    owner,
  )
  const id = `${ownerId}::operation:${nameOf(operation.name, '_')}`
  const typeParameters = operation.typeParameters.map((parameter, ordinal) =>
    typeParameterItem(snapshot, module, source, spans, id, parameter, ordinal, owner),
  )
  const parameters = operation.parameters.map((parameter) =>
    parameterItem(snapshot, module, source, spans, id, parameter, owner),
  )
  return Object.freeze({
    id,
    kind: 'Operation',
    name: nameOf(operation.name, '_'),
    visibility: 'Inherited',
    signature: Object.freeze({ text: presentation.text }),
    source: rangeOf(spans, operation.anchor),
    ...(documentation === undefined ? {} : { documentation }),
    children: Object.freeze([...typeParameters, ...parameters]),
  })
}

const enumMemberItem = (
  snapshot: Analysis.FrontendSnapshot,
  module: string,
  source: SourceFile.SourceFile,
  spans: SemanticContext.Registry,
  parent: string,
  member: DeclarationFacts.EnumMemberFact,
  owner: DeclarationFacts.CanonicalId | undefined,
): Item => {
  const name = nameOf(member.name, '_')
  const discriminant =
    member.discriminant._tag === 'Available' ? ` = ${member.discriminant.value}` : ''
  const documentation = resolveDocumentation(
    snapshot,
    module,
    parsedDocumentation(snapshot, source, member.anchor),
    owner,
  )
  return Object.freeze({
    id: `${parent}::member:${member.id.ordinal}`,
    kind: 'EnumMember',
    name,
    visibility: 'Inherited',
    signature: Object.freeze({ text: `${name}${discriminant}` }),
    source: rangeOf(spans, member.anchor),
    ...(documentation === undefined ? {} : { documentation }),
    children: Object.freeze([]),
  })
}

const unionVariantItem = (
  snapshot: Analysis.FrontendSnapshot,
  module: string,
  source: SourceFile.SourceFile,
  spans: SemanticContext.Registry,
  parent: string,
  union: DeclarationFacts.UnionFact,
  variant: DeclarationFacts.UnionVariantFact,
  options: Options,
  owner: DeclarationFacts.CanonicalId | undefined,
): Item => {
  const name = nameOf(variant.name, '_')
  const documentation = resolveDocumentation(
    snapshot,
    module,
    parsedDocumentation(snapshot, source, variant.anchor),
    owner,
  )
  const id = `${parent}::variant:${variant.id.ordinal}`
  return Object.freeze({
    id,
    kind: 'UnionVariant',
    name,
    visibility: 'Inherited',
    signature: Object.freeze({ text: SemanticDisplay.unionVariant(union, variant).text }),
    source: rangeOf(spans, variant.anchor),
    ...(documentation === undefined ? {} : { documentation }),
    children: Object.freeze(
      variant.fields
        .filter((field) => options.includePrivate === true || field.visibility === 'Public')
        .map((field) => fieldItem(snapshot, module, source, spans, id, field, owner)),
    ),
  })
}

const memberPresentation = (member: DeclarationFacts.MemberFact) => {
  switch (member._tag) {
    case 'FunctionDeclaration':
      return SemanticDisplay.functionDeclaration(member)
    case 'StructDeclaration':
      return SemanticDisplay.structDeclaration(member)
    case 'EnumDeclaration':
      return SemanticDisplay.enumDeclaration(member)
    case 'UnionDeclaration':
      return SemanticDisplay.unionDeclaration(member)
    case 'ServiceDeclaration':
    case 'InterfaceDeclaration':
      return SemanticDisplay.serviceDeclaration(member)
    case 'RoleDeclaration':
      return SemanticDisplay.roleDeclaration(member)
    case 'PackageParameterDeclaration':
    case 'ConstantDeclaration':
      return SemanticDisplay.constantDeclaration(member)
    case 'ForeignStaticDeclaration':
      return SemanticDisplay.foreignStaticDeclaration(member)
    case 'AliasDeclaration':
      return SemanticDisplay.aliasDeclaration(member)
  }
}

const ownedChildren = (
  snapshot: Analysis.FrontendSnapshot,
  module: string,
  source: SourceFile.SourceFile,
  spans: SemanticContext.Registry,
  id: string,
  member: DeclarationFacts.MemberFact,
  options: Options,
  owner: DeclarationFacts.CanonicalId | undefined,
): ReadonlyArray<Item> => {
  switch (member._tag) {
    case 'FunctionDeclaration':
      return member.parameters.map((parameter) =>
        parameterItem(snapshot, module, source, spans, id, parameter, owner),
      )
    case 'StructDeclaration':
      return member.fields
        .filter((field) => options.includePrivate === true || field.visibility === 'Public')
        .map((field) => fieldItem(snapshot, module, source, spans, id, field, owner))
    case 'EnumDeclaration':
      return member.members.map((enumMember) =>
        enumMemberItem(snapshot, module, source, spans, id, enumMember, owner),
      )
    case 'UnionDeclaration':
      return member.variants.map((variant) =>
        unionVariantItem(snapshot, module, source, spans, id, member, variant, options, owner),
      )
    case 'ServiceDeclaration':
    case 'InterfaceDeclaration':
      return member.operations.map((operation) =>
        serviceOperationItem(snapshot, module, source, spans, id, operation, owner),
      )
    default:
      return []
  }
}

const memberItem = (
  snapshot: Analysis.FrontendSnapshot,
  module: string,
  source: SourceFile.SourceFile,
  spans: SemanticContext.Registry,
  member: DeclarationFacts.MemberFact,
  options: Options,
  associated: ReadonlyArray<DeclarationFacts.MemberFact>,
): Item => {
  const id = declarationId(module, member)
  const owner = ownerOf(member)
  const presentation = memberPresentation(member)
  const documentation = resolveDocumentation(
    snapshot,
    module,
    parsedDocumentation(snapshot, source, member.anchor),
    owner,
  )
  const typeParameters = member.typeParameters.map((parameter, ordinal) =>
    typeParameterItem(snapshot, module, source, spans, id, parameter, ordinal, owner),
  )
  const children = ownedChildren(snapshot, module, source, spans, id, member, options, owner)
  const members = associated.map((candidate) =>
    memberItem(snapshot, module, source, spans, candidate, options, []),
  )
  return Object.freeze({
    id,
    kind: itemKind(member),
    name: isAssociated(member)
      ? `${member.associatedMember.ownerSpelling}.${member.associatedMember.name}`
      : nameOf(member.name, '_'),
    visibility: member.visibility,
    signature: Object.freeze({ text: presentation.text }),
    source: rangeOf(spans, member.anchor),
    ...(documentation === undefined ? {} : { documentation }),
    children: Object.freeze([...typeParameters, ...children, ...members]),
  })
}

const declaredType = (fact: DeclarationFacts.DeclaredTypeFact): string =>
  fact._tag === 'Unavailable' ? '_' : fact.spelling

const conformanceItem = (
  snapshot: Analysis.FrontendSnapshot,
  module: string,
  source: SourceFile.SourceFile,
  spans: SemanticContext.Registry,
  conformance: DeclarationFacts.ConformanceFact,
): Item => {
  const id = `${module}::implementation:${conformance.ordinal}`
  const index = Analysis.declarationIndex(snapshot)
  const privateHead = [conformance.capability, conformance.provider].some(
    (head) =>
      head._tag === 'Resolved' &&
      Type.someSubterm(head.type, (type) => {
        if (!Type.isNominal(type)) return false
        const member = DeclarationFacts.member(index, type.module, type.name)
        return member._tag === 'Resolved' && member.declaration.visibility === 'Private'
      }),
  )
  const documentation = resolveDocumentation(
    snapshot,
    module,
    parsedDocumentation(snapshot, source, conformance.anchor),
    undefined,
  )
  const children = conformance.operations.map((operation, ordinal): Item => {
    const operationName = nameOf(operation.name, `operation-${ordinal}`)
    const operationDocumentation = resolveDocumentation(
      snapshot,
      module,
      parsedDocumentation(snapshot, source, operation.anchor),
      undefined,
    )
    return Object.freeze({
      id: `${id}::operation:${ordinal}`,
      kind: 'Operation',
      name: operationName,
      visibility: 'Inherited',
      signature: Object.freeze({
        text: `${operationName} = ${operation.target._tag === 'TypePath' ? operation.target.spelling : '_'}`,
      }),
      source: rangeOf(spans, operation.anchor),
      ...(operationDocumentation === undefined ? {} : { documentation: operationDocumentation }),
      children: Object.freeze([]),
    })
  })
  return Object.freeze({
    id,
    kind: 'Implementation',
    name: `${declaredType(conformance.capability)} for ${declaredType(conformance.provider)}`,
    visibility: privateHead ? 'Private' : 'Inherited',
    signature: Object.freeze({
      text: `impl ${declaredType(conformance.capability)} for ${declaredType(conformance.provider)}`,
    }),
    source: rangeOf(spans, conformance.anchor),
    ...(documentation === undefined ? {} : { documentation }),
    children: Object.freeze(children),
  })
}

const moduleModel = (
  snapshot: Analysis.FrontendSnapshot,
  headers: DeclarationFacts.ModuleHeaders,
  options: Options,
): Module | undefined => {
  const source = snapshot.closure.sources.get(headers.module)
  if (source === undefined) return undefined
  const spans = snapshot.resolution.contexts
  // A profile with no selected declarations has no module API examples to execute.
  const raw =
    snapshot.profile !== undefined &&
    headers.members.length === 0 &&
    headers.publications.length === 0 &&
    headers.conformances.length === 0
      ? undefined
      : Analysis.moduleDocumentation(snapshot, headers.module)
  const documentation = resolveDocumentation(
    snapshot,
    headers.module,
    raw === undefined ? undefined : Document.parse(source, raw),
    undefined,
  )
  const visible = (member: DeclarationFacts.MemberFact): boolean =>
    options.includePrivate === true || member.visibility === 'Public'
  const associatedOf = (
    owner: DeclarationFacts.MemberFact,
  ): ReadonlyArray<DeclarationFacts.MemberFact> => {
    if (owner.canonical._tag !== 'Canonical') return []
    const id = owner.canonical.id
    return headers.members.filter(
      (member) =>
        isAssociated(member) &&
        member.associatedMember.owner !== undefined &&
        sameId(member.associatedMember.owner, id) &&
        visible(member),
    )
  }
  const members = headers.members
    .filter((member) => !isAssociated(member) && visible(member))
    .map((member) =>
      memberItem(snapshot, headers.module, source, spans, member, options, associatedOf(member)),
    )
  const publications: Array<Item> = []
  const published = new Set(members.map((member) => member.name))
  for (const publication of headers.publications) {
    if (published.has(publication.spelling)) continue
    const found = DeclarationFacts.publishedMember(
      Analysis.declarationIndex(snapshot),
      headers.module,
      publication.spelling,
    )
    if (found._tag !== 'Resolved' || found.declaration.visibility !== 'Public') continue
    published.add(publication.spelling)
    const alias =
      publication.original === publication.spelling
        ? publication.original
        : `${publication.original} as ${publication.spelling}`
    publications.push(
      Object.freeze({
        id: `${headers.module}::${publication.spelling}`,
        kind: 'Alias',
        name: publication.spelling,
        visibility: 'Public',
        signature: { text: `pub import ${publication.module.replaceAll('/', '.')} { ${alias} }` },
        source: rangeOf(spans, publication.anchor),
        children: Object.freeze([]),
      }),
    )
  }
  const conformances = headers.conformances
    .map((conformance) => conformanceItem(snapshot, headers.module, source, spans, conformance))
    .filter((item) => options.includePrivate === true || item.visibility !== 'Private')
  return Object.freeze({
    name: headers.module,
    sourceId: source.id,
    ...(documentation === undefined ? {} : { documentation }),
    items: Object.freeze([...members, ...publications, ...conformances]),
  })
}

/** Builds documentation lazily from one already-created compiler analysis snapshot. */
export const make = (snapshot: Analysis.FrontendSnapshot, options: Options = {}): Project =>
  Object.freeze({
    schema: 'silk-documentation',
    experimental: true,
    ...(snapshot.profile === undefined
      ? {}
      : {
          profile: {
            identity: snapshot.profile.identity,
            target: snapshot.profile.target.id,
          },
        }),
    modules: Object.freeze(
      Analysis.declarationIndex(snapshot).modules.flatMap((headers) => {
        const module = moduleModel(snapshot, headers, options)
        return module === undefined ? [] : [module]
      }),
    ),
  })

/** Builds documentation from one multi-root compiler project without repeating shared analysis. */
export const fromProjectAnalysis = (
  self: ProjectAnalysis.ProjectAnalysis,
  options: Options = {},
): Project => make(self.primary, options)
