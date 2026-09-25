import * as Location from './Location.js'
import type * as AuthoredHir from './AuthoredHir.js'
import * as DeclarationCollection from './DeclarationCollection.js'
import * as DeclarationCompletion from './DeclarationCompletion.js'
import * as DeclarationFacts from './DeclarationFacts.js'
import type * as DeclarationIndex from './DeclarationIndex.js'
import * as DeclarationResolution from './DeclarationResolution.js'
import * as Diagnostic from './Diagnostic.js'
import * as ImportPath from './ImportPath.js'
import * as Intrinsic from './Intrinsic.js'
import type * as ModuleClosure from './ModuleClosure.js'
import * as ResolutionSeams from './ResolutionSeams.js'
import * as ResolutionWork from './ResolutionWork.js'
import * as SemanticContext from './SemanticContext.js'
import * as Type from './Type.js'

export type IntrinsicActor = Intrinsic.Actor['spelling']

export type Binding =
  | {
      readonly _tag: 'LocalDeclaration'
      readonly spelling: string
      readonly declaration: DeclarationFacts.CanonicalId
    }
  | { readonly _tag: 'IntrinsicActor'; readonly spelling: IntrinsicActor }
  | {
      readonly _tag: 'ModuleNamespace'
      readonly spelling: string
      readonly module: string
      /** The authored import declaration that introduced this namespace. */
      readonly declaration: AuthoredHir.Declaration
      readonly anchor: AuthoredHir.Anchor
    }
  | {
      readonly _tag: 'ImportedMember'
      readonly spelling: string
      readonly sourceSpelling: string
      readonly module: string
      readonly declaration: DeclarationFacts.CanonicalId
      readonly member: AuthoredHir.ImportMember
      readonly sourceAnchor: AuthoredHir.Anchor
      readonly localAnchor: AuthoredHir.Anchor
    }
  | {
      readonly _tag: 'Unavailable'
      readonly spelling: string
      readonly anchor: AuthoredHir.Anchor
      readonly anchors: ReadonlyArray<AuthoredHir.Anchor>
      readonly cause?: Diagnostic.Identity<Location.Location>
      readonly declaration?: DeclarationFacts.CanonicalId
    }

export type ImportOutcome =
  | {
      readonly _tag: 'Available'
      readonly import: ModuleClosure.ImportFact
      readonly bindings: ReadonlyArray<Binding>
    }
  | {
      readonly _tag: 'Unavailable'
      readonly import: ModuleClosure.ImportFact
      /** Names a module-closure diagnostic, which is reported in source coordinates. */
      readonly cause?: Diagnostic.Identity
    }

export interface Conflict {
  readonly _tag: 'BindingConflict'
  readonly spelling: string
  readonly bindings: ReadonlyArray<Binding>
  readonly cause: Diagnostic.Identity<Location.Location>
}
export interface ModuleScope {
  readonly _tag: 'ModuleScope'
  readonly module: string
  /** This module's authored context: the spans and spellings its bindings resolve through. */
  readonly context: SemanticContext.SemanticContext
  readonly bindings: ReadonlyArray<Binding>
  readonly imports: ReadonlyArray<ImportOutcome>
  readonly conflicts: ReadonlyArray<Conflict>
  readonly diagnostics: ReadonlyArray<Diagnostic.Located>
}
export interface Resolution {
  readonly _tag: 'NameResolution'
  readonly modules: ReadonlyArray<ModuleScope>
  /** Every loaded module's context, so a fact from another module still resolves its span. */
  readonly contexts: SemanticContext.Registry
  readonly diagnostics: ReadonlyArray<Diagnostic.Located>
}
export type Lookup =
  | {
      readonly _tag: 'Resolved'
      readonly spelling: string
      readonly declaration: DeclarationFacts.MemberFact
    }
  | {
      readonly _tag: 'EnumMember'
      readonly spelling: string
      readonly enum: DeclarationFacts.EnumFact
      readonly member: DeclarationFacts.EnumMemberFact
    }
  | { readonly _tag: 'Intrinsic'; readonly spelling: string; readonly actor: IntrinsicActor }
  | { readonly _tag: 'Namespace'; readonly spelling: string; readonly module: string }
  | { readonly _tag: 'Missing'; readonly spelling: string }
  | {
      readonly _tag: 'Inaccessible'
      readonly spelling: string
      readonly declaration: DeclarationFacts.MemberFact
      readonly cause: Diagnostic.Identity<Location.Location>
    }
  | { readonly _tag: 'Conflict'; readonly spelling: string; readonly conflict: Conflict }
  | {
      readonly _tag: 'Unavailable'
      readonly spelling: string
      readonly cause?: Diagnostic.Identity<Location.Location>
      readonly declaration?: DeclarationFacts.MemberFact
    }

/** One authored name resolved to its spelling and authored position, or absent when unspelled. */
const spelled = (
  context: SemanticContext.SemanticContext,
  name: AuthoredHir.Name | undefined,
): { readonly spelling: string; readonly anchor: AuthoredHir.Anchor } | undefined => {
  if (name === undefined) return undefined
  const spelling = SemanticContext.nameText(context, name)
  return spelling === undefined ? undefined : { spelling, anchor: name.anchor }
}

type CanonicalMember = DeclarationFacts.MemberFact & {
  readonly canonical: Extract<DeclarationFacts.CanonicalState, { readonly _tag: 'Canonical' }>
}
const isCanonicalMember = (
  declaration: DeclarationFacts.MemberFact,
): declaration is CanonicalMember => declaration.canonical._tag === 'Canonical'
const canonicalDeclaration = (
  index: DeclarationIndex.Index,
  module: string,
  spelling: string,
): CanonicalMember | undefined => {
  const result = DeclarationFacts.publishedMember(index, module, spelling)
  return result._tag === 'Resolved' && isCanonicalMember(result.declaration)
    ? result.declaration
    : undefined
}

const bindingTarget = (binding: Exclude<Binding, { readonly _tag: 'Unavailable' }>): string => {
  switch (binding._tag) {
    case 'IntrinsicActor':
      return `intrinsic:${binding.spelling}`
    case 'ModuleNamespace':
      return `module:${binding.module}`
    case 'LocalDeclaration':
    case 'ImportedMember':
      return `declaration:${binding.declaration.module}.${binding.declaration.name}`
  }
}

export const resolve = (
  closure: ModuleClosure.Facts,
  index: DeclarationIndex.Index,
): Resolution => {
  const scopes: Array<ModuleScope> = []
  for (const module of closure.modules) {
    const diagnostics: Array<Diagnostic.Located> = []
    const candidates: Array<Binding> = Intrinsic.all().map((intrinsic) => ({
      _tag: 'IntrinsicActor',
      spelling: intrinsic.spelling,
    }))
    const headers = index.modules.find((value) => value.module === module.name)
    for (const declaration of headers?.members ?? [])
      if (declaration.canonical._tag === 'Canonical')
        candidates.push({
          _tag: 'LocalDeclaration',
          spelling: declaration.canonical.id.name,
          declaration: declaration.canonical.id,
        })
    const imports: Array<ImportOutcome> = []
    const context = SemanticContext.make(module.authored)
    for (const imported of module.imports) {
      if (imported.target._tag !== 'Resolved') {
        imports.push({
          _tag: 'Unavailable',
          import: imported,
          ...('cause' in imported.target ? { cause: imported.target.cause } : {}),
        })
        continue
      }
      const target = imported.target.module
      const header = imported.header
      const created: Array<Binding> = []
      const explicitAlias = spelled(context, header.alias)
      if (header.alias !== undefined && explicitAlias === undefined) {
        imports.push({ _tag: 'Unavailable', import: imported })
        continue
      }
      if (header.members === undefined || explicitAlias !== undefined) {
        const implicit = spelled(context, header.path.segments.at(-1))
        const local =
          explicitAlias ??
          (implicit === undefined || ImportPath.isReservedSpelling(implicit.spelling)
            ? undefined
            : implicit)
        if (local !== undefined)
          created.push({
            _tag: 'ModuleNamespace',
            spelling: local.spelling,
            module: target,
            declaration: imported.declaration,
            anchor: local.anchor,
          })
      }
      for (const member of header.members ?? []) {
        const origin = spelled(context, member.name)
        if (origin === undefined) continue
        const sourceName = origin.spelling
        const alias = spelled(context, member.alias)
        const span = Location.at(origin.anchor)
        const declaration = canonicalDeclaration(index, target, sourceName)
        const anchors = [origin.anchor, ...(alias === undefined ? [] : [alias.anchor])]
        if (declaration === undefined) {
          const associated = associatedMemberNamed(index, target, sourceName)
          const diagnostic =
            associated?.associatedMember === undefined
              ? Diagnostic.unknownImportedMember(target, sourceName, span)
              : Diagnostic.importedInherentMember(
                  target,
                  sourceName,
                  associated.associatedMember.ownerSpelling,
                  span,
                )
          diagnostics.push(diagnostic)
          created.push({
            _tag: 'Unavailable',
            spelling: alias?.spelling ?? sourceName,
            anchor: member.anchor,
            anchors,
            cause: Diagnostic.identity(diagnostic),
          })
          continue
        }
        if (declaration.visibility === 'Private') {
          const diagnostic = Diagnostic.inaccessibleImportedMember(target, sourceName, span)
          diagnostics.push(diagnostic)
          created.push({
            _tag: 'Unavailable',
            spelling: alias?.spelling ?? sourceName,
            anchor: member.anchor,
            anchors,
            cause: Diagnostic.identity(diagnostic),
            declaration: declaration.canonical.id,
          })
          continue
        }
        created.push({
          _tag: 'ImportedMember',
          spelling: alias?.spelling ?? sourceName,
          sourceSpelling: sourceName,
          module: target,
          declaration: declaration.canonical.id,
          member,
          sourceAnchor: origin.anchor,
          localAnchor: alias?.anchor ?? origin.anchor,
        })
      }
      candidates.push(...created)
      imports.push({ _tag: 'Available', import: imported, bindings: created })
    }
    const grouped = new Map<string, Array<Binding>>()
    for (const binding of candidates) {
      if (binding._tag === 'Unavailable') continue
      const group = grouped.get(binding.spelling)
      if (group === undefined) grouped.set(binding.spelling, [binding])
      else if (
        !group.some(
          (candidate) =>
            candidate._tag !== 'Unavailable' && bindingTarget(candidate) === bindingTarget(binding),
        )
      )
        group.push(binding)
    }
    const conflicts: Array<Conflict> = []
    for (const [spelling, bindings] of grouped)
      if (bindings.length > 1) {
        const last = bindings.at(-1)
        let span = Location.at({
          _tag: 'AuthoredAnchor',
          owner: module.authored.module.owner,
          path: [],
        })
        if (last?._tag === 'LocalDeclaration') {
          const declaration = DeclarationFacts.byCanonical(index, last.declaration)
          if (declaration?.name._tag === 'Present') span = Location.at(declaration.name.anchor)
        } else if (last?._tag === 'ModuleNamespace') {
          span = Location.at(last.anchor)
        } else if (last?._tag === 'ImportedMember') {
          span = Location.at(last.member.anchor)
        } else if (last?._tag === 'Unavailable') {
          span = Location.at(last.anchor)
        }
        const diagnostic = Diagnostic.bindingConflict(spelling, span)
        diagnostics.push(diagnostic)
        conflicts.push({
          _tag: 'BindingConflict',
          spelling,
          bindings: bindings,
          cause: Diagnostic.identity(diagnostic),
        })
      }
    scopes.push({
      _tag: 'ModuleScope',
      module: module.name,
      context,
      bindings: candidates,
      imports: imports,
      conflicts: conflicts,
      diagnostics: Diagnostic.collect(diagnostics),
    })
  }
  return {
    _tag: 'NameResolution',
    modules: scopes,
    contexts: SemanticContext.registry(scopes.map((scope) => scope.context)),
    diagnostics: Diagnostic.collect(...scopes.map((scope) => scope.diagnostics)),
  }
}

export const scopeOf = (self: Resolution, module: string): ModuleScope | undefined =>
  self.modules.find((scope) => scope.module === module)
export const lookup = (
  scope: ModuleScope,
  index: DeclarationIndex.Index,
  spelling: string,
  initiator: ResolutionWork.Initiator = { kind: 'ValueName', key: `${scope.module}/${spelling}` },
): Lookup => {
  const work = ResolutionWork.begin(ResolutionWork.ofIndex(index), initiator, 'NameLookup')
  const conflict = scope.conflicts.find((value) => value.spelling === spelling)
  if (conflict !== undefined) return { _tag: 'Conflict', spelling, conflict }
  const binding = scope.bindings.find((value) => {
    ResolutionWork.visit(work)
    return value.spelling === spelling
  })
  if (binding !== undefined) ResolutionWork.accept(work)
  if (binding === undefined) return { _tag: 'Missing', spelling }
  if (binding._tag === 'IntrinsicActor')
    return { _tag: 'Intrinsic', spelling, actor: binding.spelling }
  if (binding._tag === 'Unavailable') {
    const declaration =
      binding.declaration === undefined
        ? undefined
        : DeclarationFacts.byCanonical(index, binding.declaration)
    return {
      _tag: 'Unavailable',
      spelling,
      ...(binding.cause === undefined ? {} : { cause: binding.cause }),
      ...(declaration === undefined ? {} : { declaration }),
    }
  }
  if (binding._tag === 'ModuleNamespace')
    return { _tag: 'Namespace', spelling, module: binding.module }
  const declaration = DeclarationFacts.byCanonical(index, binding.declaration)
  return declaration === undefined
    ? { _tag: 'Unavailable', spelling }
    : { _tag: 'Resolved', spelling, declaration }
}

/** The outcome of looking one associated member up on a nominal owner declaration. */
export type AssociatedLookup =
  | { readonly _tag: 'Inherent'; readonly declaration: DeclarationFacts.DeclarationFact }
  | {
      readonly _tag: 'Inaccessible'
      readonly declaration: DeclarationFacts.DeclarationFact
    }
  | { readonly _tag: 'Duplicate'; readonly cause: Diagnostic.Identity<Location.Location> }
  | { readonly _tag: 'Missing' }

const associatedCache = new WeakMap<
  ReadonlyArray<DeclarationFacts.MemberFact>,
  Map<string, ReadonlyArray<DeclarationFacts.DeclarationFact>>
>()

const associatedMembersOf = (
  index: DeclarationIndex.Index,
  owner: DeclarationFacts.CanonicalId,
): ReadonlyArray<DeclarationFacts.DeclarationFact> => {
  const members = DeclarationFacts.moduleHeaders(index, owner.module)?.members
  if (members === undefined) return []
  let byOwner = associatedCache.get(members)
  if (byOwner === undefined) {
    byOwner = new Map()
    for (const member of members) {
      if (member._tag !== 'FunctionDeclaration' || member.associatedMember === undefined) continue
      const key = member.associatedMember.owner?.name ?? member.associatedMember.ownerSpelling
      const bucket = byOwner.get(key)
      byOwner.set(key, bucket === undefined ? [member] : [...bucket, member])
    }
    associatedCache.set(members, byOwner)
  }
  return byOwner.get(owner.name) ?? []
}

/**
 * Erases a transparent alias qualifier to the nominal declaration it names, so `Maybe.some`
 * reaches `Option`'s members. Any other declaration is returned unchanged.
 */
export const erasedOwner = (
  index: DeclarationIndex.Index,
  declaration: DeclarationFacts.MemberFact,
): DeclarationFacts.MemberFact => {
  if (declaration._tag !== 'AliasDeclaration') return declaration
  const target = declaration.target
  if (target._tag !== 'Resolved' || !Type.isNominal(target.type)) return declaration
  return (
    DeclarationFacts.byCanonical(index, {
      _tag: 'CanonicalDeclarationId',
      module: target.type.module,
      name: target.type.name,
    }) ?? declaration
  )
}

/** Whether a declaration can own inherent members. */
export const isNominalOwner = (declaration: DeclarationFacts.MemberFact): boolean =>
  declaration._tag === 'StructDeclaration' ||
  declaration._tag === 'UnionDeclaration' ||
  declaration._tag === 'EnumDeclaration' ||
  declaration._tag === 'ServiceDeclaration' ||
  declaration._tag === 'InterfaceDeclaration'

/**
 * Resolves `Owner.member` through the owner's declared inherent members. Membership is decided by
 * the impl declarations of the owner's module, never by the module's basename. A private member
 * is reachable only from the owner's own module.
 */
export const lookupAssociated = (
  index: DeclarationIndex.Index,
  owner: DeclarationFacts.MemberFact,
  member: string,
  requestingModule: string,
  initiator?: ResolutionWork.Initiator,
): AssociatedLookup => {
  const declaration = erasedOwner(index, owner)
  if (!isNominalOwner(declaration) || declaration.canonical._tag !== 'Canonical')
    return { _tag: 'Missing' }
  const work = ResolutionWork.begin(
    ResolutionWork.ofIndex(index),
    initiator ?? {
      kind: 'AssociatedMember',
      key: `${requestingModule}/${declaration.canonical.id.module}.${declaration.canonical.id.name}.${member}`,
    },
    'AssociatedLookup',
  )
  const candidates = associatedMembersOf(index, declaration.canonical.id).filter((candidate) => {
    ResolutionWork.visit(work)
    const matches = candidate.associatedMember?.name === member
    if (matches) ResolutionWork.accept(work)
    return matches
  })
  const canonical = candidates.filter((candidate) => candidate.canonical._tag === 'Canonical')
  const selected = canonical.at(0)
  if (selected === undefined) {
    const duplicate = candidates.find((candidate) => candidate.canonical._tag === 'Duplicate')
    return duplicate !== undefined && duplicate.canonical._tag === 'Duplicate'
      ? { _tag: 'Duplicate', cause: duplicate.canonical.cause }
      : { _tag: 'Missing' }
  }
  if (selected.visibility === 'Private' && declaration.canonical.id.module !== requestingModule)
    return { _tag: 'Inaccessible', declaration: selected }
  return { _tag: 'Inherent', declaration: selected }
}

/** The inherent member a selective import wrongly names, when one exists under any owner. */
export const associatedMemberNamed = (
  index: DeclarationIndex.Index,
  module: string,
  member: string,
): DeclarationFacts.DeclarationFact | undefined =>
  index.modules
    .find((headers) => headers.module === module)
    ?.declarations.find(
      (declaration) =>
        declaration.associatedMember?.name === member && declaration.canonical._tag === 'Canonical',
    )

export const lookupQualified = (
  scope: ModuleScope,
  index: DeclarationIndex.Index,
  namespace: string,
  member: string,
  anchor: AuthoredHir.Anchor,
  initiator?: ResolutionWork.Initiator,
): Lookup => {
  const span = Location.at(anchor)
  const qualifier = lookup(scope, index, namespace, initiator)
  if (
    qualifier._tag === 'Intrinsic' ||
    qualifier._tag === 'Conflict' ||
    qualifier._tag === 'Missing'
  )
    return qualifier
  if (qualifier._tag === 'Resolved') {
    const associated = lookupAssociated(
      index,
      qualifier.declaration,
      member,
      scope.module,
      initiator,
    )
    if (associated._tag === 'Inherent')
      return {
        _tag: 'Resolved',
        spelling: member,
        declaration: associated.declaration,
      }
    if (associated._tag === 'Inaccessible') {
      const diagnostic = Diagnostic.inaccessibleImportedMember(
        associated.declaration.canonical._tag === 'Canonical'
          ? associated.declaration.canonical.id.module
          : namespace,
        member,
        span,
      )
      return {
        _tag: 'Inaccessible',
        spelling: member,
        declaration: associated.declaration,
        cause: Diagnostic.identity(diagnostic),
      }
    }
    if (associated._tag === 'Duplicate')
      return { _tag: 'Unavailable', spelling: member, cause: associated.cause }
  }
  if (qualifier._tag === 'Resolved' && qualifier.declaration._tag === 'EnumDeclaration') {
    const selected = DeclarationFacts.lookupEnumMember(qualifier.declaration.members, member)
    if (selected._tag === 'Resolved')
      return {
        _tag: 'EnumMember',
        spelling: member,
        enum: qualifier.declaration,
        member: selected.member,
      }
    const diagnostic = Diagnostic.unknownEnumMember(namespace, member, span)
    return {
      _tag: 'Unavailable',
      spelling: member,
      cause: Diagnostic.identity(diagnostic),
      declaration: qualifier.declaration,
    }
  }
  if (qualifier._tag !== 'Namespace') return { _tag: 'Missing', spelling: `${namespace}.${member}` }
  const module = qualifier.module
  const declaration = canonicalDeclaration(index, module, member)
  if (declaration === undefined) {
    const diagnostic = Diagnostic.unknownImportedMember(module, member, span)
    return {
      _tag: 'Unavailable',
      spelling: member,
      cause: Diagnostic.identity(diagnostic),
    }
  }
  if (declaration.visibility === 'Private') {
    const diagnostic = Diagnostic.inaccessibleImportedMember(module, member, span)
    return {
      _tag: 'Inaccessible',
      spelling: member,
      declaration,
      cause: Diagnostic.identity(diagnostic),
    }
  }
  return { _tag: 'Resolved', spelling: member, declaration }
}

const unresolved = (
  path: DeclarationFacts.TypePathFact,
  diagnostic: Diagnostic.Located,
  candidate?: Type.Nominal,
): DeclarationFacts.TypeResolution => {
  const first = path.segments.at(0)
  if (first === undefined) {
    return {
      fact: { _tag: 'Unavailable', anchor: path.anchor },
      diagnostics: [diagnostic],
    }
  }
  return {
    fact: {
      _tag: 'Unresolved',
      spelling: path.spelling,
      anchor: path.anchor,
      path,
      cause: Diagnostic.identity(diagnostic),
      ...(candidate === undefined ? {} : { candidate }),
    },
    diagnostics: [diagnostic],
  }
}

const unavailable = (
  path: DeclarationFacts.TypePathFact,
  cause?: Diagnostic.Identity<Location.Location>,
  candidate?: Type.Nominal,
): DeclarationFacts.TypeResolution => {
  const first = path.segments.at(0)
  if (first === undefined) {
    return {
      fact: { _tag: 'Unavailable', anchor: path.anchor },
      diagnostics: [],
    }
  }
  return {
    fact: {
      _tag: 'Unresolved',
      spelling: path.spelling,
      anchor: path.anchor,
      path,
      ...(cause === undefined ? {} : { cause }),
      ...(candidate === undefined ? {} : { candidate }),
    },
    diagnostics: [],
  }
}

const resolvedType = (
  path: DeclarationFacts.TypePathFact,
  type: DeclarationFacts.SemanticType,
): DeclarationFacts.TypeResolution =>
  path.segments.at(0) === undefined
    ? {
        fact: { _tag: 'Unavailable', anchor: path.anchor },
        diagnostics: [],
      }
    : {
        fact: {
          _tag: 'Resolved',
          type,
          spelling: path.spelling,
          anchor: path.anchor,
          path,
        },
        diagnostics: [],
      }

const nominalOf = (declaration: DeclarationFacts.MemberFact): Type.Nominal | undefined =>
  (declaration._tag === 'StructDeclaration' ||
    declaration._tag === 'EnumDeclaration' ||
    declaration._tag === 'UnionDeclaration' ||
    declaration._tag === 'ServiceDeclaration' ||
    declaration._tag === 'InterfaceDeclaration') &&
  declaration.canonical._tag === 'Canonical'
    ? Type.nominal(declaration.canonical.id.module, declaration.canonical.id.name)
    : undefined

/** The span a type-path diagnostic points at: its last segment, else the whole path. */
const typeUseSpan = (
  contexts: SemanticContext.Registry,
  path: DeclarationFacts.TypePathFact,
): Location.Location => Location.at(path.segments.at(-1)?.anchor ?? path.anchor)

/** Resolves one retained declaration type path through an immutable module scope. */
/**
 * Erases one alias hit at a type path. During header completion the memoizing resolver from
 * `makeResolvers` supplies the target; afterwards the completed alias fact already carries it.
 */
const resolveAliasUse = (
  path: DeclarationFacts.TypePathFact,
  declaration: DeclarationFacts.AliasFact,
  alias: ResolutionSeams.AliasResolver | undefined,
): DeclarationFacts.TypeResolution => {
  const target =
    alias === undefined ? { fact: declaration.target, diagnostics: [] } : alias(declaration)
  const base =
    target.fact._tag === 'Resolved'
      ? resolvedType(path, target.fact.type)
      : unavailable(path, 'cause' in target.fact ? target.fact.cause : undefined)
  return { fact: base.fact, diagnostics: target.diagnostics }
}

/** Looks one retained one- or two-segment type path up through a module scope. */
export const lookupPath = (
  scope: ModuleScope,
  index: DeclarationIndex.Index,
  path: DeclarationFacts.TypePathFact,
  initiator?: ResolutionWork.Initiator,
): Lookup => {
  const first = path.segments.at(0)
  const second = path.segments.at(1)
  if (first === undefined) return { _tag: 'Missing', spelling: path.spelling }
  return second === undefined
    ? lookup(scope, index, first.spelling, initiator)
    : lookupQualified(scope, index, first.spelling, second.spelling, second.anchor, initiator)
}

export const resolveType = (
  resolution: Resolution,
  index: DeclarationIndex.Index,
  module: string,
  path: DeclarationFacts.TypePathFact,
  alias?: ResolutionSeams.AliasResolver,
): DeclarationFacts.TypeResolution => {
  const initiator: ResolutionWork.Initiator = {
    kind: 'TypePath',
    key: `${module}/${path.spelling}`,
    span: resolution.contexts.spanOf(path.anchor),
  }
  ResolutionWork.begin(ResolutionWork.ofIndex(index), initiator, 'PathResolution')
  const scope = scopeOf(resolution, module)
  const first = path.segments.at(0)
  const second = path.segments.at(1)
  if (scope === undefined || first === undefined) {
    return {
      fact: { _tag: 'Unavailable', anchor: path.anchor },
      diagnostics: [],
    }
  }
  const result = lookupPath(scope, index, path, initiator)
  if (result._tag === 'Intrinsic') {
    if (
      result.actor === 'Intrinsic' &&
      (second?.spelling === 'SharedCore' ||
        second?.spelling === 'Execution' ||
        second?.spelling === 'Wake' ||
        second?.spelling === 'StorageFailure' ||
        second?.spelling === 'Type' ||
        second?.spelling === 'Fields' ||
        second?.spelling === 'Field' ||
        second?.spelling === 'StaticSequence' ||
        second?.spelling === 'Test' ||
        second?.spelling === 'Tests' ||
        second?.spelling === 'TestInfo') &&
      path.segments.length === 2
    ) {
      const intrinsicType = Type.intrinsicNominals.get(`Intrinsic.${second.spelling}`)
      if (intrinsicType !== undefined) return resolvedType(path, intrinsicType)
    }
    if (Type.isBuiltin(result.actor)) return resolvedType(path, result.actor)
    return unresolved(
      path,
      Diagnostic.expectedType(path.spelling, typeUseSpan(resolution.contexts, path)),
    )
  }
  if (result._tag === 'Resolved') {
    if (result.declaration._tag === 'AliasDeclaration')
      return resolveAliasUse(path, result.declaration, alias)
    const nominal = nominalOf(result.declaration)
    if (nominal !== undefined) return resolvedType(path, nominal)
    return unresolved(
      path,
      Diagnostic.expectedType(path.spelling, typeUseSpan(resolution.contexts, path)),
    )
  }
  if (result._tag === 'EnumMember')
    return unresolved(
      path,
      Diagnostic.expectedType(path.spelling, typeUseSpan(resolution.contexts, path)),
    )
  if (result._tag === 'Inaccessible') {
    const nominal = nominalOf(result.declaration)
    const diagnostic = Diagnostic.inaccessibleImportedMember(
      result.declaration.canonical._tag === 'Canonical'
        ? result.declaration.canonical.id.module
        : module,
      result.spelling,
      typeUseSpan(resolution.contexts, path),
    )
    return unresolved(path, diagnostic, nominal)
  }
  if (result._tag === 'Conflict') return unavailable(path, result.conflict.cause)
  if (result._tag === 'Unavailable')
    return unavailable(
      path,
      result.cause,
      result.declaration === undefined ? undefined : nominalOf(result.declaration),
    )
  if (result._tag === 'Namespace') {
    return unresolved(
      path,
      Diagnostic.expectedType(path.spelling, typeUseSpan(resolution.contexts, path)),
    )
  }
  return unresolved(
    path,
    Diagnostic.unknownType(path.spelling, typeUseSpan(resolution.contexts, path)),
  )
}

/** Resolves one retained item path through the same import scope and visibility gate as values. */
export const resolveItem = (
  resolution: Resolution,
  index: DeclarationIndex.Index,
  module: string,
  path: DeclarationFacts.TypePathFact,
): DeclarationFacts.ItemResolution => {
  const initiator: ResolutionWork.Initiator = {
    kind: 'ItemPath',
    key: `${module}/${path.spelling}`,
    span: resolution.contexts.spanOf(path.anchor),
  }
  ResolutionWork.begin(ResolutionWork.ofIndex(index), initiator, 'PathResolution')
  const scope = scopeOf(resolution, module)
  const first = path.segments.at(0)
  const second = path.segments.at(1)
  if (scope === undefined || first === undefined || path.segments.length > 2)
    return { _tag: 'Missing' }
  if (second === undefined) {
    const local = DeclarationFacts.lookupDeclaration(
      DeclarationFacts.moduleHeaders(index, module)?.declarations ?? [],
      first.spelling,
    )
    if (local._tag === 'Ambiguous') return { _tag: 'Ambiguous', count: local.declarations.length }
  }
  const result = lookupPath(scope, index, path, initiator)
  if (result._tag === 'Resolved') return { _tag: 'Resolved', declaration: result.declaration }
  if (result._tag === 'EnumMember') return { _tag: 'Missing' }
  if (result._tag === 'Inaccessible')
    return {
      _tag: 'Inaccessible',
      declaration: result.declaration,
      cause: result.cause,
    }
  if (result._tag === 'Conflict')
    return {
      _tag: 'Ambiguous',
      count: result.conflict.bindings.length,
      cause: result.conflict.cause,
    }
  if (result._tag === 'Unavailable')
    return {
      _tag: 'Unavailable',
      ...(result.declaration === undefined ? {} : { declaration: result.declaration }),
      ...(result.cause === undefined ? {} : { cause: result.cause }),
    }
  return { _tag: 'Missing' }
}

/** An alias with a canonical identity always has a present name; this narrows both at once. */
type NamedAlias = DeclarationFacts.AliasFact & {
  readonly name: Extract<DeclarationFacts.DeclaredName, { readonly _tag: 'Present' }>
  readonly canonical: Extract<DeclarationFacts.CanonicalState, { readonly _tag: 'Canonical' }>
}

const namedAlias = (declaration: DeclarationFacts.AliasFact): NamedAlias | undefined =>
  declaration.name._tag === 'Present' && declaration.canonical._tag === 'Canonical'
    ? (declaration as NamedAlias)
    : undefined

/**
 * Builds the header-completion resolution boundaries over preliminary scopes.
 *
 * Alias targets resolve lazily on first demand, memoized per alias fact, with an in-progress
 * stack so a target that reaches its own declaration is reported once per alias on the cycle. A
 * public alias whose erased target exposes a private nominal is unavailable for every use. Each
 * memoized outcome carries empty diagnostics: the first resolution reported them.
 */
export const makeResolvers = (
  resolution: Resolution,
  index: DeclarationIndex.Index,
): ResolutionSeams.ResolutionSeams => {
  const memo = new Map<DeclarationFacts.AliasFact, DeclarationFacts.TypeResolution>()
  const active: Array<NamedAlias> = []
  const cycleCauses = new Map<DeclarationFacts.AliasFact, Diagnostic.Identity<Location.Location>>()
  // The alias's own name is the path of record for an unavailable outcome, so every later use
  // reads the cause off the completed fact exactly as it would off an unresolved spelling.
  const unavailableAlias = (
    declaration: NamedAlias,
    cause: Diagnostic.Identity<Location.Location> | undefined,
  ): DeclarationFacts.TypeResolution => ({
    fact: {
      _tag: 'Unresolved',
      spelling: declaration.name.spelling,
      anchor: declaration.name.anchor,
      path: {
        _tag: 'TypePath',
        spelling: declaration.name.spelling,
        segments: [
          {
            spelling: declaration.name.spelling,
            anchor: declaration.name.anchor,
          },
        ],
        anchor: declaration.name.anchor,
      },
      ...(cause === undefined ? {} : { cause }),
    },
    diagnostics: [],
  })
  const withDiagnostics = (
    result: DeclarationFacts.TypeResolution,
    diagnostics: ReadonlyArray<Diagnostic.Located>,
  ): DeclarationFacts.TypeResolution => ({ fact: result.fact, diagnostics })
  const resolveAlias: ResolutionSeams.AliasResolver = (declaration) => {
    const named = namedAlias(declaration)
    if (named === undefined)
      return {
        fact: { _tag: 'Unavailable', anchor: declaration.anchor },
        diagnostics: [],
      }
    const cached = memo.get(named)
    if (cached !== undefined) return cached
    const activeIndex = active.indexOf(named)
    if (activeIndex >= 0) {
      const cycle = active.slice(activeIndex)
      const names = cycle.map((member) => member.name.spelling)
      const diagnostics = cycle.flatMap((member): ReadonlyArray<Diagnostic.Located> => {
        if (cycleCauses.has(member)) return []
        const diagnostic = Diagnostic.cyclicTypeAlias(
          member.name.spelling,
          names,
          cycle.filter((other) => other !== member).map((other) => Location.at(other.name.anchor)),
          Location.at(member.name.anchor),
        )
        cycleCauses.set(member, Diagnostic.identity(diagnostic))
        return [diagnostic]
      })
      return withDiagnostics(unavailableAlias(named, cycleCauses.get(named)), diagnostics)
    }
    if (named.parameterList !== undefined) {
      const diagnostic = Diagnostic.typeAliasParameters(
        named.name.spelling,
        Location.at(named.parameterList),
      )
      const result = unavailableAlias(named, Diagnostic.identity(diagnostic))
      memo.set(named, result)
      return withDiagnostics(result, [diagnostic])
    }
    active.push(named)
    const resolved = DeclarationResolution.resolveDeclaredType(
      resolution.contexts.spanOf,
      named.canonical.id.module,
      named.target,
      resolvers,
      index.modules,
    )
    active.pop()
    const diagnostics: Array<Diagnostic.Located> = [...resolved.diagnostics]
    const cycleCause = cycleCauses.get(named)
    let result: DeclarationFacts.TypeResolution
    if (cycleCause !== undefined) result = unavailableAlias(named, cycleCause)
    else if (resolved.fact._tag !== 'Resolved') result = withDiagnostics(resolved, [])
    else {
      const exposed =
        named.visibility === 'Public'
          ? DeclarationResolution.attachExposure(
              resolution.contexts.spanOf,
              resolved.fact,
              index.modules,
              diagnostics,
            )
          : resolved.fact
      result =
        exposed._tag === 'Resolved' && exposed.exposureCause !== undefined
          ? unavailableAlias(named, exposed.exposureCause)
          : { fact: exposed, diagnostics: [] }
    }
    memo.set(named, result)
    return withDiagnostics(result, diagnostics)
  }
  const resolvers: ResolutionSeams.ResolutionSeams = ResolutionSeams.make(
    (module: string, path: DeclarationFacts.TypePathFact) =>
      resolveType(resolution, index, module, path, resolveAlias),
    (module: string, path: DeclarationFacts.TypePathFact) =>
      resolveItem(resolution, index, module, path),
    resolveAlias,
  )
  return resolvers
}

/** Runs identity collection, scope construction, and declared-type completion in phase order. */
export const analyze = (
  closure: ModuleClosure.Facts,
): { readonly index: DeclarationIndex.Index; readonly resolution: Resolution } => {
  const collected = DeclarationCollection.collect(closure)
  const preliminary = resolve(closure, collected)
  const resolvers = makeResolvers(preliminary, collected)
  const index = DeclarationCompletion.complete(collected, resolvers, preliminary.contexts)
  ResolutionWork.share(index, collected)
  return { index, resolution: resolve(closure, index) }
}
