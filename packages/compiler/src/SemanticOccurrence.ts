import * as Option from 'effect/Option'
import * as SourceFile from './SourceFile.js'
import type * as SyntaxFile from './SyntaxFile.js'
import type * as Token from './Token.js'
import type * as AuthoredHir from './AuthoredHir.js'
import * as AuthoredIdentity from './AuthoredIdentity.js'
import * as DeclarationFacts from './DeclarationFacts.js'
import type * as DeclarationIndex from './DeclarationIndex.js'
import type * as Diagnostic from './Diagnostic.js'
import * as Elaboration from './Elaboration.js'
import * as Tir from './Tir.js'
import * as BodyBuilder from './BodyBuilder.js'
import * as Intrinsic from './Intrinsic.js'
import type * as Match from './Match.js'
import * as NameResolution from './NameResolution.js'
import type * as SourceSpan from './SourceSpan.js'
import * as SemanticContext from './SemanticContext.js'
import * as Type from './Type.js'

/** The exact source location and name selection of one source-backed declaration. */
export interface DeclarationLocation {
  readonly module: string
  readonly span: SourceSpan.SourceSpan
  readonly selectionSpan: SourceSpan.SourceSpan
}

/** A declaration's location before publication: the nodes whose presentation gives its spans. */
export interface LocatedDeclaration {
  /** The canonical module, when it is not simply the module that presents `at`. */
  readonly module?: string
  readonly at: AuthoredIdentity.Anchor
  readonly selection: AuthoredIdentity.Anchor
}

/**
 * One occurrence as construction records it: an authored name token and what it names.
 *
 * It names no revision, so a body publishes its occurrences once and every revision that reuses
 * the body presents them again through its own presentation.
 */
export interface LocatedOccurrence {
  readonly at: AuthoredIdentity.Anchor
  readonly role: Role
  readonly resolution: Resolution
  readonly declaration?: LocatedDeclaration
}

/** Compiler-owned identity selected by one semantic token occurrence. */
export type Identity =
  | {
      readonly _tag: 'DeclarationIdentity'
      readonly id: DeclarationFacts.CanonicalId | DeclarationFacts.DeclarationId
    }
  | { readonly _tag: 'TypeParameterIdentity'; readonly id: Type.Parameter }
  | { readonly _tag: 'ParameterIdentity'; readonly id: DeclarationFacts.ParameterId }
  | { readonly _tag: 'BindingIdentity'; readonly id: Tir.BindingId }
  | { readonly _tag: 'PatternBindingIdentity'; readonly id: Match.BindingId }
  | { readonly _tag: 'FieldIdentity'; readonly id: DeclarationFacts.FieldId }
  | {
      readonly _tag: 'UnionVariantIdentity'
      readonly id: DeclarationFacts.CanonicalUnionVariantId
    }
  | { readonly _tag: 'EnumMemberIdentity'; readonly id: DeclarationFacts.CanonicalEnumMemberId }
  | {
      readonly _tag: 'EnumAssociatedOperationIdentity'
      readonly id: DeclarationFacts.EnumAssociatedOperationId
    }
  | {
      readonly _tag: 'ServiceOperationIdentity'
      readonly id: DeclarationFacts.ServiceOperationId
    }
  | { readonly _tag: 'ImportNamespaceIdentity'; readonly module: string; readonly spelling: string }
  | { readonly _tag: 'IntrinsicActorIdentity'; readonly id: Intrinsic.ActorId }
  | { readonly _tag: 'IntrinsicOperationIdentity'; readonly id: Intrinsic.OperationId }

export type Role =
  | 'Declaration'
  | 'Value'
  | 'Type'
  | 'Field'
  | 'Actor'
  | 'Operation'
  | 'Method'
  | 'Import'

export type Resolution =
  | { readonly _tag: 'Available'; readonly identity: Identity }
  | { readonly _tag: 'Missing'; readonly cause?: Diagnostic.CauseIdentity }
  | { readonly _tag: 'Inaccessible'; readonly cause?: Diagnostic.CauseIdentity }
  | { readonly _tag: 'Ambiguous'; readonly cause?: Diagnostic.CauseIdentity }
  | { readonly _tag: 'Conflicting'; readonly cause?: Diagnostic.CauseIdentity }
  | { readonly _tag: 'Unavailable'; readonly cause?: Diagnostic.CauseIdentity }

/** One immutable exact-token semantic query answer. */
export interface SemanticOccurrence {
  readonly _tag: 'SemanticOccurrence'
  readonly span: SourceSpan.SourceSpan
  readonly role: Role
  readonly resolution: Resolution
  /** The exact authored import name that supplied this unqualified occurrence, when applicable. */
  readonly importBinding?: SourceSpan.SourceSpan
  readonly declaration?: DeclarationLocation
  readonly ordinal: number
}

/** Start-sorted occurrences and their compact prefix maximum-end lookup index. */
export interface ModuleIndex {
  readonly occurrences: ReadonlyArray<SemanticOccurrence>
  readonly prefixMaximumEnd: ReadonlyArray<number>
  readonly declarationLocations: ReadonlyMap<string, DeclarationLocation>
}

/** Deterministic semantic occurrences grouped by canonical source module. */
export interface Index {
  readonly _tag: 'SemanticOccurrenceIndex'
  readonly modules: ReadonlyMap<string, ModuleIndex>
  readonly declarationLocations: ReadonlyMap<string, DeclarationLocation>
}

const identityOfDeclaration = (declaration: DeclarationFacts.MemberFact): Identity => ({
  _tag: 'DeclarationIdentity',
  id: declaration.canonical._tag === 'Canonical' ? declaration.canonical.id : declaration.id,
})

const location = (
  module: string | undefined,
  at: AuthoredIdentity.Anchor,
  selection: AuthoredIdentity.Anchor,
): LocatedDeclaration => ({ ...(module === undefined ? {} : { module }), at, selection })

/**
 * The alias a retained type path names, if any. An alias is erased from the resolved type, so
 * the path spelling is the only trace of it and is re-looked-up through the same module scope.
 */
const aliasAtPath = (
  path: DeclarationFacts.TypePathFact | undefined,
  scope: NameResolution.ModuleScope | undefined,
  index: DeclarationIndex.Index,
): DeclarationFacts.AliasFact | undefined => {
  if (path === undefined || scope === undefined) return undefined
  const result = NameResolution.lookupPath(scope, index, path, {
    kind: 'ToolingPath',
    key: `${path.spelling}@${AuthoredIdentity.anchorKey(path.anchor)}`,
  })
  return result._tag === 'Resolved' && result.declaration._tag === 'AliasDeclaration'
    ? result.declaration
    : undefined
}

const currentDeclaration = (
  index: DeclarationIndex.Index,
  declaration: DeclarationFacts.MemberFact,
): DeclarationFacts.MemberFact =>
  declaration.canonical._tag === 'Canonical'
    ? (DeclarationFacts.byCanonical(index, declaration.canonical.id) ?? declaration)
    : (index.modules
        .find((module) => module.module === declaration.id.sourceId)
        ?.members.find(
          (candidate) =>
            candidate.id.sourceId === declaration.id.sourceId &&
            candidate.id.ordinal === declaration.id.ordinal,
        ) ?? declaration)

const locationOfDeclaration = (
  index: DeclarationIndex.Index,
  declaration: DeclarationFacts.MemberFact,
): LocatedDeclaration | undefined => {
  const current = currentDeclaration(index, declaration)
  return current.name._tag === 'Present'
    ? location(current.name.anchor.owner.module, current.anchor, current.name.anchor)
    : undefined
}

const locationOfParameter = (
  parameter: DeclarationFacts.ParameterFact,
): LocatedDeclaration | undefined =>
  parameter.name._tag === 'Present'
    ? location(parameter.name.anchor.owner.module, parameter.anchor, parameter.name.anchor)
    : undefined

const locationOfServiceOperation = (
  operation: DeclarationFacts.ServiceOperationFact,
): LocatedDeclaration | undefined =>
  operation.name._tag === 'Present'
    ? location(operation.name.anchor.owner.module, operation.anchor, operation.name.anchor)
    : undefined

const locationOfTypeParameter = (
  parameter: DeclarationFacts.TypeParameterFact,
): LocatedDeclaration | undefined =>
  parameter.implicitLifetime !== true && parameter.name._tag === 'Present'
    ? location(parameter.name.anchor.owner.module, parameter.anchor, parameter.name.anchor)
    : undefined

const locationOfBinding = (
  binding: Elaboration.BindingDeclarationFact | Elaboration.PatternBindingFact,
): LocatedDeclaration | undefined =>
  binding.name._tag === 'Present'
    ? location(binding.name.anchor.owner.module, binding.anchor, binding.name.anchor)
    : undefined

const locationOfEnumMember = (
  member: DeclarationFacts.EnumMemberFact,
): LocatedDeclaration | undefined =>
  member.name._tag === 'Present'
    ? location(member.name.anchor.owner.module, member.anchor, member.name.anchor)
    : undefined

const locationOfUnionVariant = (
  variant: DeclarationFacts.UnionVariantFact,
): LocatedDeclaration | undefined =>
  variant.name._tag === 'Present'
    ? location(variant.name.anchor.owner.module, variant.anchor, variant.name.anchor)
    : undefined

const locationOfField = (
  index: DeclarationIndex.Index,
  field: DeclarationFacts.FieldFact,
): LocatedDeclaration | undefined => {
  const declarationId = DeclarationFacts.fieldDeclaration(field.id)
  const module = DeclarationFacts.moduleHeaders(index, declarationId.sourceId)
  const owner = field.id.owner
  const current =
    (owner._tag === 'StructFieldOwnerId'
      ? module?.structs
          .find((struct) => struct.id.ordinal === declarationId.ordinal)
          ?.fields.find((candidate) => DeclarationFacts.sameFieldId(candidate.id, field.id))
      : module?.unions
          .find((union) => union.id.ordinal === declarationId.ordinal)
          ?.variants.find((variant) => variant.id.ordinal === owner.variant.ordinal)
          ?.fields.find((candidate) => DeclarationFacts.sameFieldId(candidate.id, field.id))) ??
    field
  return current.name._tag === 'Present'
    ? location(current.name.anchor.owner.module, current.anchor, current.name.anchor)
    : undefined
}

const available = (identity: Identity): Resolution => ({ _tag: 'Available', identity })

type Pending = LocatedOccurrence

const push = (
  pending: Array<Pending>,
  at: AuthoredIdentity.Anchor | undefined,
  role: Role,
  resolution: Resolution,
  declaration?: LocatedDeclaration,
): void => {
  if (at === undefined) return
  pending.push({
    at,
    role,
    resolution,
    ...(declaration === undefined ? {} : { declaration }),
  })
}

const publishDeclaration = (
  self: LocatedDeclaration,
  spans: SemanticContext.Registry,
): DeclarationLocation => {
  const span = spans.spanOf(self.at)
  return {
    module: self.module ?? span.sourceId,
    span,
    selectionSpan: spans.spanOf(self.selection),
  }
}

interface Published {
  readonly occurrence: Omit<SemanticOccurrence, 'ordinal'>
  readonly ordinal: number
}

/** Presents located occurrences in one revision; a node presented as nothing names no token. */
const publish = (
  pending: ReadonlyArray<Pending>,
  spans: SemanticContext.Registry,
): ReadonlyArray<Published> =>
  pending.flatMap((entry, ordinal): ReadonlyArray<Published> => {
    const span = spans.spanOf(entry.at)
    if (span.start === span.end) return []
    return [
      {
        occurrence: {
          _tag: 'SemanticOccurrence' as const,
          span,
          role: entry.role,
          resolution: entry.resolution,
          ...(entry.declaration === undefined
            ? {}
            : { declaration: publishDeclaration(entry.declaration, spans) }),
        },
        ordinal,
      },
    ]
  })

const isNominalDeclaration = (
  declaration: DeclarationFacts.MemberFact,
): declaration is
  | DeclarationFacts.StructFact
  | DeclarationFacts.EnumFact
  | DeclarationFacts.UnionFact
  | DeclarationFacts.ServiceFact
  | DeclarationFacts.InterfaceFact =>
  declaration._tag === 'StructDeclaration' ||
  declaration._tag === 'EnumDeclaration' ||
  declaration._tag === 'UnionDeclaration' ||
  declaration._tag === 'ServiceDeclaration' ||
  declaration._tag === 'InterfaceDeclaration'

const declarationByNominal = (
  index: DeclarationIndex.Index,
  nominal: Type.Nominal,
):
  | DeclarationFacts.StructFact
  | DeclarationFacts.EnumFact
  | DeclarationFacts.UnionFact
  | DeclarationFacts.ServiceFact
  | DeclarationFacts.InterfaceFact
  | undefined =>
  index.modules
    .find((module) => module.module === nominal.module)
    ?.members.find(
      (
        declaration,
      ): declaration is
        | DeclarationFacts.StructFact
        | DeclarationFacts.EnumFact
        | DeclarationFacts.UnionFact
        | DeclarationFacts.ServiceFact
        | DeclarationFacts.InterfaceFact =>
        isNominalDeclaration(declaration) &&
        declaration.canonical._tag === 'Canonical' &&
        declaration.canonical.id.name === nominal.name,
    )

const typeParameterFact = (
  index: DeclarationIndex.Index,
  type: Type.Parameter,
): DeclarationFacts.TypeParameterFact | undefined => {
  for (const module of index.modules)
    for (const member of module.members) {
      const parameter = member.typeParameters.find((candidate) => Type.equals(candidate.type, type))
      if (parameter !== undefined) return parameter
      if (
        (member._tag === 'FunctionDeclaration' &&
          member.opaqueResult !== undefined &&
          Type.equals(member.opaqueResult.binder.type, type)) ||
        ((member._tag === 'ServiceDeclaration' || member._tag === 'InterfaceDeclaration') &&
          member.operations.some(
            (operation) =>
              operation.opaqueResult !== undefined &&
              Type.equals(operation.opaqueResult.binder.type, type),
          ))
      ) {
        if (member._tag === 'FunctionDeclaration') return member.opaqueResult?.binder
        return member.operations.find(
          (operation) =>
            operation.opaqueResult !== undefined &&
            Type.equals(operation.opaqueResult.binder.type, type),
        )?.opaqueResult?.binder
      }
    }
  return undefined
}

const collectQualifier = (
  anchor: AuthoredHir.Anchor,
  spelling: string,
  scope: NameResolution.ModuleScope | undefined,
  index: DeclarationIndex.Index,
  pending: Array<Pending>,
): void => {
  if (scope === undefined) {
    push(pending, anchor, 'Actor', { _tag: 'Unavailable' })
    return
  }
  const lookup = NameResolution.lookup(scope, index, spelling, {
    kind: 'ToolingName',
    key: `${spelling}@${AuthoredIdentity.anchorKey(anchor)}`,
  })
  if (lookup._tag === 'Resolved') {
    push(
      pending,
      anchor,
      'Actor',
      available(identityOfDeclaration(lookup.declaration)),
      locationOfDeclaration(index, lookup.declaration),
    )
    return
  }
  if (lookup._tag === 'Intrinsic') {
    const actor = Intrinsic.findActor(lookup.actor)
    push(
      pending,
      anchor,
      'Actor',
      actor === undefined
        ? { _tag: 'Unavailable' }
        : available({ _tag: 'IntrinsicActorIdentity', id: actor.id }),
    )
    return
  }
  if (lookup._tag === 'Namespace') {
    const binding = scope.bindings.find(
      (candidate) => candidate._tag === 'ModuleNamespace' && candidate.spelling === lookup.spelling,
    )
    const declaration =
      binding?._tag === 'ModuleNamespace'
        ? location(undefined, binding.anchor, binding.anchor)
        : undefined
    push(
      pending,
      anchor,
      'Actor',
      available({
        _tag: 'ImportNamespaceIdentity',
        module: lookup.module,
        spelling: lookup.spelling,
      }),
      declaration,
    )
    return
  }
  if (lookup._tag === 'Conflict') {
    push(pending, anchor, 'Actor', { _tag: 'Conflicting', cause: lookup.conflict.cause })
    return
  }
  push(pending, anchor, 'Actor', { _tag: 'Unavailable' })
}

const collectResolvedType = (
  fact: Extract<DeclarationFacts.DeclaredTypeFact, { readonly _tag: 'Resolved' }>,
  index: DeclarationIndex.Index,
  scope: NameResolution.ModuleScope | undefined,
  pending: Array<Pending>,
): void => {
  if (fact.exactItem !== undefined) {
    const qualifier =
      fact.exactItem.path.segments.length > 1 ? fact.exactItem.path.segments.at(0) : undefined
    if (qualifier !== undefined)
      collectQualifier(qualifier.anchor, qualifier.spelling, scope, index, pending)
    const selected = fact.exactItem.path.segments.at(-1)
    const declaration = DeclarationFacts.byCanonical(index, fact.exactItem.declaration)
    push(
      pending,
      selected === undefined ? undefined : selected.anchor,
      'Value',
      declaration === undefined
        ? { _tag: 'Unavailable' }
        : available(identityOfDeclaration(declaration)),
      declaration === undefined ? undefined : locationOfDeclaration(index, declaration),
    )
  }
  if (fact.components !== undefined) {
    for (const component of fact.components) collectDeclaredType(component, index, scope, pending)
    // The lifetime argument supplements the named string type rather than replacing its token.
    if (!Type.isString(fact.type)) return
  }
  if (fact.unionSource !== undefined) {
    for (const member of fact.unionSource.members)
      collectDeclaredType(member, index, scope, pending)
    return
  }
  const anchors = fact.path?.segments.map((segment) => segment.anchor) ?? [fact.anchor]
  const token = anchors.at(-1) ?? fact.anchor
  const qualifier = anchors.length > 1 ? anchors.at(0) : undefined
  if (qualifier !== undefined) {
    collectQualifier(
      qualifier,
      fact.spelling.split('.').at(0) ?? fact.spelling,
      scope,
      index,
      pending,
    )
  }
  if (
    Type.isRepresented(fact.type) &&
    Type.isRepresentationParameterArgument(fact.type.representation.argument)
  ) {
    const parameter = fact.type.representation.argument.parameter
    const declaration = typeParameterFact(index, parameter)
    push(
      pending,
      token,
      'Type',
      available({ _tag: 'TypeParameterIdentity', id: parameter }),
      declaration === undefined ? undefined : locationOfTypeParameter(declaration),
    )
    return
  }
  if (Type.isParameter(fact.type)) {
    const declaration = typeParameterFact(index, fact.type)
    push(
      pending,
      token,
      'Type',
      available({ _tag: 'TypeParameterIdentity', id: fact.type }),
      declaration === undefined ? undefined : locationOfTypeParameter(declaration),
    )
    return
  }
  const alias = aliasAtPath(fact.path, scope, index)
  if (alias !== undefined) {
    push(
      pending,
      token,
      'Type',
      available(identityOfDeclaration(alias)),
      locationOfDeclaration(index, alias),
    )
    return
  }
  if (Type.isNominal(fact.type)) {
    const declaration = declarationByNominal(index, fact.type)
    if (declaration !== undefined) {
      push(
        pending,
        token,
        'Type',
        available(identityOfDeclaration(declaration)),
        locationOfDeclaration(index, declaration),
      )
      return
    }
    const actor = Intrinsic.findActor(fact.type.name)
    push(
      pending,
      token,
      'Type',
      actor === undefined
        ? { _tag: 'Unavailable' }
        : available({ _tag: 'IntrinsicActorIdentity', id: actor.id }),
    )
    return
  }
  if (Type.isString(fact.type) || (typeof fact.type === 'string' && fact.type !== 'never')) {
    const actor = Intrinsic.findActor(Type.isString(fact.type) ? 'string' : fact.type)
    push(
      pending,
      token,
      'Type',
      actor === undefined
        ? { _tag: 'Unavailable' }
        : available({ _tag: 'IntrinsicActorIdentity', id: actor.id }),
    )
  }
}

const collectDeclaredType = (
  fact: DeclarationFacts.DeclaredTypeFact,
  index: DeclarationIndex.Index,
  scope: NameResolution.ModuleScope | undefined,
  pending: Array<Pending>,
): void => {
  if (fact._tag === 'Resolved') {
    collectResolvedType(fact, index, scope, pending)
    return
  }
  if (fact._tag === 'Unresolved') {
    const qualifier = fact.path.segments.length > 1 ? fact.path.segments.at(0) : undefined
    if (qualifier !== undefined)
      collectQualifier(qualifier.anchor, qualifier.spelling, scope, index, pending)
    const selected = fact.path.segments.at(-1)
    let declarationLocation: LocatedDeclaration | undefined
    if (fact.candidate !== undefined) {
      const declaration = declarationByNominal(index, fact.candidate)
      if (declaration !== undefined) declarationLocation = locationOfDeclaration(index, declaration)
    }
    push(
      pending,
      selected === undefined ? undefined : selected.anchor,
      'Type',
      {
        _tag: fact.candidate === undefined ? 'Missing' : 'Inaccessible',
        ...(fact.cause === undefined ? {} : { cause: fact.cause }),
      },
      declarationLocation,
    )
    return
  }
  if (fact._tag === 'FixedArray' || fact._tag === 'Slice') {
    collectDeclaredType(fact.element, index, scope, pending)
    return
  }
  if (fact._tag === 'Reference') {
    collectDeclaredType(fact.target, index, scope, pending)
    return
  }
  if (fact._tag === 'Pointer') {
    collectDeclaredType(fact.pointee, index, scope, pending)
    return
  }
  if (fact._tag === 'Callable' || fact._tag === 'ForeignFunction') {
    for (const parameter of fact.parameters) collectDeclaredType(parameter, index, scope, pending)
    collectDeclaredType(fact.result, index, scope, pending)
    return
  }
  if (fact._tag === 'Applied') {
    collectDeclaredType(fact.target, index, scope, pending)
    for (const argument of fact.arguments) collectDeclaredType(argument, index, scope, pending)
    return
  }
  if (fact._tag === 'Effect') {
    collectDeclaredType(fact.success, index, scope, pending)
    for (const failure of fact.failures) collectDeclaredType(failure, index, scope, pending)
    for (const requirement of fact.requirements)
      collectDeclaredType(requirement.capability, index, scope, pending)
    return
  }
  if (fact._tag === 'ExactRepresentation') {
    const qualifier = fact.item.segments.length > 1 ? fact.item.segments.at(0) : undefined
    if (qualifier !== undefined)
      collectQualifier(qualifier.anchor, qualifier.spelling, scope, index, pending)
    const selected = fact.item.segments.at(-1)
    const declaration =
      fact.itemCandidate === undefined
        ? undefined
        : DeclarationFacts.byCanonical(index, fact.itemCandidate)
    push(
      pending,
      selected === undefined ? undefined : selected.anchor,
      'Value',
      {
        _tag: 'Unavailable',
        ...(fact.cause === undefined ? {} : { cause: fact.cause }),
      },
      declaration === undefined ? undefined : locationOfDeclaration(index, declaration),
    )
    for (const argument of fact.arguments) collectDeclaredType(argument, index, scope, pending)
    return
  }
  if (fact._tag === 'RepresentationParameter') {
    const declaration = typeParameterFact(index, fact.parameter)
    push(
      pending,
      fact.anchor,
      'Type',
      available({ _tag: 'TypeParameterIdentity', id: fact.parameter }),
      declaration === undefined ? undefined : locationOfTypeParameter(declaration),
    )
    return
  }
  if (fact._tag === 'Union')
    for (const member of fact.members) collectDeclaredType(member, index, scope, pending)
}

const collectRowExpression = (
  fact: DeclarationFacts.RowExpressionDecision,
  index: DeclarationIndex.Index,
  scope: NameResolution.ModuleScope | undefined,
  pending: Array<Pending>,
): void => {
  switch (fact._tag) {
    case 'EmptyRowExpression':
    case 'UnavailableRowExpression':
      return
    case 'RowParameterExpression': {
      const declaration = typeParameterFact(index, fact.parameter)
      push(
        pending,
        fact.anchor,
        'Type',
        available({ _tag: 'TypeParameterIdentity', id: fact.parameter }),
        declaration === undefined ? undefined : locationOfTypeParameter(declaration),
      )
      return
    }
    case 'FailureMemberExpression':
      collectDeclaredType(fact.member, index, scope, pending)
      return
    case 'RequirementMemberExpression':
      collectDeclaredType(fact.capability, index, scope, pending)
      return
    case 'UnionRowExpression':
      for (const operand of fact.operands) collectRowExpression(operand, index, scope, pending)
      return
    case 'WithoutRowExpression':
      collectRowExpression(fact.source, index, scope, pending)
      collectRowExpression(fact.selected, index, scope, pending)
      return
  }
}

const collectConstraint = (
  fact: DeclarationFacts.ConstraintFact,
  index: DeclarationIndex.Index,
  scope: NameResolution.ModuleScope | undefined,
  pending: Array<Pending>,
): void => {
  if (fact._tag === 'ProviderConstraint') collectDeclaredType(fact.provider, index, scope, pending)
  collectRowExpression(fact.selected, index, scope, pending)
  collectRowExpression(fact.source, index, scope, pending)
}

const parameterResolution = (
  reference: Elaboration.ParameterReferenceFact,
): { readonly resolution: Resolution; readonly declaration?: LocatedDeclaration } => {
  if (reference._tag === 'Resolved') {
    const declaration = locationOfParameter(reference.parameter)
    return {
      resolution: available({ _tag: 'ParameterIdentity', id: reference.parameter.id }),
      ...(declaration === undefined ? {} : { declaration }),
    }
  }
  if (reference._tag === 'ResolvedBinding') {
    const declaration = locationOfBinding(reference.binding)
    return {
      resolution: available({ _tag: 'BindingIdentity', id: reference.binding.id }),
      ...(declaration === undefined ? {} : { declaration }),
    }
  }
  if (reference._tag === 'ResolvedPattern') {
    const declaration = locationOfBinding(reference.binding)
    return {
      resolution: available({ _tag: 'PatternBindingIdentity', id: reference.binding.id }),
      ...(declaration === undefined ? {} : { declaration }),
    }
  }
  if (reference._tag === 'Missing')
    return {
      resolution: {
        _tag: 'Missing',
        ...(reference.cause === undefined ? {} : { cause: reference.cause }),
      },
    }
  return {
    resolution: {
      _tag: reference._tag === 'Ambiguous' ? 'Ambiguous' : 'Unavailable',
    },
  }
}

const callResolution = (
  reference: Elaboration.CallReferenceFact,
  index: DeclarationIndex.Index,
): { readonly resolution: Resolution; readonly declaration?: LocatedDeclaration } => {
  if (reference._tag === 'Resolved') {
    const declaration = locationOfDeclaration(index, reference.declaration)
    return {
      resolution: available(identityOfDeclaration(reference.declaration)),
      ...(declaration === undefined ? {} : { declaration }),
    }
  }
  if (reference._tag === 'ResolvedBuiltin') {
    const operation = Intrinsic.findOperation(
      reference.actor,
      reference.spelling.split('.').at(-1) ?? reference.spelling,
    )
    return {
      resolution:
        operation === undefined
          ? { _tag: 'Unavailable' }
          : available({ _tag: 'IntrinsicOperationIdentity', id: operation.id }),
    }
  }
  if (reference._tag === 'ResolvedInterfaceOperation') {
    // An interface operation is declared once and answered per specialization by a witness. The
    // declaration is what a reader navigates to, so that is what the occurrence names.
    const declaration = locationOfServiceOperation(reference.declaration)
    return {
      resolution:
        reference.declaration.state._tag === 'Unique'
          ? available({
              _tag: 'ServiceOperationIdentity',
              id: reference.declaration.state.id,
            })
          : { _tag: 'Unavailable' },
      ...(declaration === undefined ? {} : { declaration }),
    }
  }
  if (reference._tag === 'ResolvedServiceOperation') {
    const declaration = locationOfServiceOperation(reference.operation)
    return {
      resolution:
        reference.operation.state._tag === 'Unique'
          ? available({
              _tag: 'ServiceOperationIdentity',
              id: reference.operation.state.id,
            })
          : { _tag: 'Unavailable' },
      ...(declaration === undefined ? {} : { declaration }),
    }
  }
  if (reference._tag === 'Missing')
    return {
      resolution: {
        _tag: 'Missing',
        ...(reference.cause === undefined ? {} : { cause: reference.cause }),
      },
    }
  if (reference._tag === 'Ambiguous')
    return {
      resolution: {
        _tag: 'Ambiguous',
        ...(reference.cause === undefined ? {} : { cause: reference.cause }),
      },
    }
  return { resolution: { _tag: 'Unavailable' } }
}

const collectCallReference = (
  reference: Elaboration.CallReferenceFact,
  path: Elaboration.ReferencePathFact | undefined,
  index: DeclarationIndex.Index,
  scope: NameResolution.ModuleScope | undefined,
  pending: Array<Pending>,
  qualifierOwnedByTypeApplication = false,
): void => {
  let anchors: ReadonlyArray<AuthoredHir.Anchor>
  if (path?._tag === 'ReferencePath') {
    anchors = [
      ...(path.qualifierAnchor === undefined ? [] : [path.qualifierAnchor]),
      path.memberAnchor,
    ]
  } else if ('anchor' in reference) {
    anchors = [reference.anchor]
  } else {
    anchors = []
  }
  const qualifier = anchors.length > 1 ? anchors.at(0) : undefined
  if (qualifier !== undefined && !qualifierOwnedByTypeApplication) {
    const qualifierName = 'spelling' in reference ? reference.spelling.split('.').at(0) : undefined
    if (qualifierName !== undefined)
      collectQualifier(qualifier, qualifierName, scope, index, pending)
  }
  const selected = anchors.at(-1)
  const resolved = callResolution(reference, index)
  // A receiver-syntax call names its member without a qualifier token; the member keeps its
  // identity and gains the method role, so hover presents the receiver-bound contract.
  const receiverSyntax =
    path?._tag === 'ReferencePath' &&
    path.qualifierAnchor === undefined &&
    reference._tag === 'Resolved' &&
    reference.declaration._tag === 'FunctionDeclaration' &&
    reference.declaration.associatedMember?.receiver === true
  let role: Role
  if (
    reference._tag === 'ResolvedBuiltin' ||
    reference._tag === 'ResolvedServiceOperation' ||
    reference._tag === 'ResolvedInterfaceOperation'
  ) {
    role = 'Operation'
  } else if (receiverSyntax) {
    role = 'Method'
  } else {
    role = 'Value'
  }
  push(
    pending,
    selected === undefined ? undefined : selected,
    role,
    resolved.resolution,
    resolved.declaration,
  )
}

const collectIntrinsicReference = (
  reference: Elaboration.IntrinsicReferenceFact,
  index: DeclarationIndex.Index,
  pending: Array<Pending>,
): void => {
  if (reference._tag === 'UnavailableIntrinsicReference') return
  const actorResolution =
    reference.actor._tag === 'IntrinsicActor'
      ? available({ _tag: 'IntrinsicActorIdentity', id: reference.actor.id })
      : available(identityOfDeclaration(reference.actor))
  const actorDeclaration =
    reference.actor._tag === 'IntrinsicActor'
      ? undefined
      : locationOfDeclaration(index, reference.actor)
  push(pending, reference.actorAnchor, 'Actor', actorResolution, actorDeclaration)
  push(
    pending,
    reference.operationAnchor,
    'Operation',
    available({ _tag: 'IntrinsicOperationIdentity', id: reference.operation.id }),
  )
}

const collectPattern = (
  pattern: Elaboration.PatternFact,
  index: DeclarationIndex.Index,
  scope: NameResolution.ModuleScope | undefined,
  pending: Array<Pending>,
): void => {
  // A shorthand field pattern uses one token for both the selected field and the new local.
  // Prefer the declaration occurrence for exact-position queries while retaining the field
  // occurrence in range queries.
  for (const binding of pattern.bindings)
    if (binding.name._tag === 'Present')
      push(
        pending,
        binding.name.anchor,
        'Declaration',
        available({ _tag: 'PatternBindingIdentity', id: binding.id }),
        locationOfBinding(binding),
      )
  if (pattern._tag === 'EnumMemberPattern') {
    if (pattern.enum !== undefined)
      push(
        pending,
        pattern.qualifierAnchor === undefined ? undefined : pattern.qualifierAnchor,
        'Type',
        available(identityOfDeclaration(pattern.enum)),
        locationOfDeclaration(index, pattern.enum),
      )
    if (pattern.member?.canonical._tag === 'Canonical')
      push(
        pending,
        pattern.memberAnchor === undefined ? undefined : pattern.memberAnchor,
        'Value',
        available({ _tag: 'EnumMemberIdentity', id: pattern.member.canonical.id }),
      )
  } else if (pattern._tag === 'NominalPattern') {
    if (pattern.target._tag === 'Resolved')
      push(
        pending,
        pattern.target.anchor === undefined ? undefined : pattern.target.anchor,
        'Type',
        available(identityOfDeclaration(pattern.target.struct)),
        locationOfDeclaration(index, pattern.target.struct),
      )
    for (const field of pattern.fields) {
      if (field.state._tag === 'Resolved')
        push(
          pending,
          field.anchor,
          'Field',
          available({ _tag: 'FieldIdentity', id: field.state.field.id }),
          locationOfField(index, field.state.field),
        )
      if (field.nested !== undefined) collectPattern(field.nested, index, scope, pending)
    }
  } else if (pattern._tag === 'UnionVariantPattern') {
    if (pattern.target._tag === 'Resolved') {
      push(
        pending,
        pattern.anchor,
        'Type',
        available(identityOfDeclaration(pattern.target.union)),
        locationOfDeclaration(index, pattern.target.union),
      )
      if (pattern.target.variant.canonical._tag === 'Canonical')
        push(
          pending,
          pattern.target.anchor,
          'Value',
          available({
            _tag: 'UnionVariantIdentity',
            id: pattern.target.variant.canonical.id,
          }),
          locationOfUnionVariant(pattern.target.variant),
        )
    }
    for (const field of pattern.fields) {
      if (field.state._tag === 'Resolved')
        push(
          pending,
          field.anchor,
          'Field',
          available({ _tag: 'FieldIdentity', id: field.state.field.id }),
          locationOfField(index, field.state.field),
        )
      if (field.nested !== undefined) collectPattern(field.nested, index, scope, pending)
    }
  } else if (pattern._tag === 'TypePattern') {
    collectDeclaredType(pattern.declared, index, scope, pending)
  }
}

const collectExpression = (
  expression: Elaboration.ExpressionDecision | Tir.Expression,
  index: DeclarationIndex.Index,
  scope: NameResolution.ModuleScope | undefined,
  pending: Array<Pending>,
  builder?: BodyBuilder.BodyBuilder,
): void => {
  if ('origin' in expression) {
    const semantic =
      builder === undefined ? undefined : BodyBuilder.semanticOfExpression(builder, expression)
    if (semantic !== undefined) {
      collectExpression(semantic, index, scope, pending, builder)
      return
    }
    for (const child of Tir.expressionChildren(expression))
      collectExpression(child, index, scope, pending, builder)
    return
  }
  switch (expression._tag) {
    case 'EnumMember':
      push(
        pending,
        expression.qualifierAnchor,
        'Type',
        available(identityOfDeclaration(expression.enum)),
        locationOfDeclaration(index, expression.enum),
      )
      push(
        pending,
        expression.memberAnchor,
        'Value',
        expression.member?.canonical._tag === 'Canonical'
          ? available({
              _tag: 'EnumMemberIdentity',
              id: expression.member.canonical.id,
            })
          : {
              _tag: 'Unavailable',
              ...(expression.cause === undefined ? {} : { cause: expression.cause }),
            },
      )
      return
    case 'EnumValue':
      push(
        pending,
        expression.qualifierAnchor,
        'Type',
        available({
          _tag: 'DeclarationIdentity',
          id: expression.operation.enum,
        }),
      )
      push(
        pending,
        expression.operationAnchor,
        'Operation',
        available({
          _tag: 'EnumAssociatedOperationIdentity',
          id: expression.operation.id,
        }),
      )
      collectExpression(expression.argument, index, scope, pending, builder)
      return
    case 'Constant':
      push(
        pending,
        expression.anchor,
        'Value',
        available(identityOfDeclaration(expression.declaration)),
        locationOfDeclaration(index, expression.declaration),
      )
      return
    case 'Identifier': {
      const resolved = parameterResolution(expression.reference)
      push(pending, expression.reference.anchor, 'Value', resolved.resolution, resolved.declaration)
      return
    }
    case 'Call':
      collectCallReference(
        expression.reference,
        expression.path,
        index,
        scope,
        pending,
        expression.interfaceApplication !== undefined,
      )
      if (expression.interfaceApplication !== undefined)
        collectDeclaredType(expression.interfaceApplication, index, scope, pending)
      for (const typeArgument of expression.typeArguments)
        collectDeclaredType(typeArgument.declared, index, scope, pending)
      for (const argument of expression.arguments)
        collectExpression(argument.expression, index, scope, pending, builder)
      return
    case 'Operator':
      collectCallReference(expression.reference, undefined, index, scope, pending)
      for (const argument of expression.arguments)
        collectExpression(argument.expression, index, scope, pending, builder)
      return
    case 'ShortCircuit':
      for (const argument of expression.arguments)
        collectExpression(argument.expression, index, scope, pending, builder)
      return
    case 'FunctionItem':
      collectCallReference(expression.reference, expression.path, index, scope, pending)
      return
    case 'CallableSection':
      if (expression.anonymous === undefined) {
        collectCallReference(expression.reference, expression.path, index, scope, pending)
      } else if (expression.reference._tag === 'Resolved') {
        const declaration = expression.reference.declaration
        for (const parameter of declaration.parameters.slice(
          0,
          expression.remainingParameters.length,
        )) {
          if (parameter.name._tag === 'Present')
            push(
              pending,
              parameter.name.anchor,
              'Declaration',
              available({ _tag: 'ParameterIdentity', id: parameter.id }),
              locationOfParameter(parameter),
            )
          collectDeclaredType(parameter.declaredType, index, scope, pending)
        }
        collectDeclaredType(declaration.returnType, index, scope, pending)
        collectRowExpression(declaration.failureRow.expression, index, scope, pending)
        collectRowExpression(declaration.requirementRow.expression, index, scope, pending)
      }
      for (const capture of expression.anonymous?.captures ?? []) {
        let identity: Identity
        if (Elaboration.isBindingDeclarationFact(capture.reference))
          identity = { _tag: 'BindingIdentity', id: capture.reference.id }
        else if (Elaboration.isPatternBindingFact(capture.reference))
          identity = { _tag: 'PatternBindingIdentity', id: capture.reference.id }
        else identity = { _tag: 'ParameterIdentity', id: capture.reference.id }
        push(
          pending,
          capture.anchor,
          'Value',
          available(identity),
          Elaboration.isParameterFact(capture.reference)
            ? locationOfParameter(capture.reference)
            : locationOfBinding(capture.reference),
        )
      }
      for (const capture of expression.captures)
        collectExpression(capture.expression, index, scope, pending, builder)
      return
    case 'ForeignApply':
    case 'CallableApply':
      collectExpression(expression.callee, index, scope, pending, builder)
      for (const argument of expression.arguments)
        collectExpression(argument.expression, index, scope, pending, builder)
      return
    case 'FieldProjection': {
      collectExpression(expression.subject, index, scope, pending, builder)
      // The occurrence is the written field name, not the projection around it.
      const token = expression.fieldAnchor
      if (expression.state._tag === 'Resolved')
        push(
          pending,
          token === undefined ? undefined : token,
          'Field',
          available({ _tag: 'FieldIdentity', id: expression.state.field.id }),
          locationOfField(index, expression.state.field),
        )
      else
        push(pending, token === undefined ? undefined : token, 'Field', {
          _tag: 'Unavailable',
          ...(expression.state._tag === 'Unavailable' && expression.state.cause !== undefined
            ? { cause: expression.state.cause }
            : {}),
        })
      return
    }
    case 'StructLiteral': {
      const token = expression.target._tag === 'Resolved' ? expression.target.anchor : undefined
      if (expression.target._tag === 'Resolved')
        push(
          pending,
          token === undefined ? undefined : token,
          'Type',
          available(identityOfDeclaration(expression.target.struct)),
          locationOfDeclaration(index, expression.target.struct),
        )
      for (const initializer of expression.initializers) {
        const fieldToken = initializer.nameAnchor ?? initializer.anchor
        if (initializer.state._tag === 'Resolved' || initializer.state._tag === 'Inaccessible')
          push(
            pending,
            fieldToken === undefined ? undefined : fieldToken,
            'Field',
            available({ _tag: 'FieldIdentity', id: initializer.state.field.id }),
            locationOfField(index, initializer.state.field),
          )
        collectExpression(initializer.expression, index, scope, pending, builder)
      }
      return
    }
    case 'UnionVariant': {
      const token = expression.target._tag === 'Resolved' ? expression.target.anchor : undefined
      if (expression.target._tag === 'Resolved')
        push(
          pending,
          token === undefined ? undefined : token,
          'Value',
          expression.target.variant.canonical._tag === 'Canonical'
            ? available({
                _tag: 'UnionVariantIdentity',
                id: expression.target.variant.canonical.id,
              })
            : { _tag: 'Unavailable' },
          locationOfUnionVariant(expression.target.variant),
        )
      for (const initializer of expression.initializers) {
        const fieldToken = initializer.nameAnchor ?? initializer.anchor
        if (initializer.state._tag === 'Resolved' || initializer.state._tag === 'Inaccessible')
          push(
            pending,
            fieldToken === undefined ? undefined : fieldToken,
            'Field',
            available({ _tag: 'FieldIdentity', id: initializer.state.field.id }),
            locationOfField(index, initializer.state.field),
          )
        collectExpression(initializer.expression, index, scope, pending, builder)
      }
      return
    }
    case 'Move':
    case 'Borrow':
    case 'Run':
      collectExpression(expression.subject, index, scope, pending, builder)
      return
    case 'PlaceReplace':
      collectIntrinsicReference(expression.reference, index, pending)
      collectExpression(expression.destination, index, scope, pending, builder)
      collectExpression(expression.value, index, scope, pending, builder)
      return
    case 'IndexProjection':
      collectExpression(expression.subject, index, scope, pending, builder)
      collectExpression(expression.index, index, scope, pending, builder)
      return
    case 'ArrayLiteral':
      for (const element of expression.elements)
        collectExpression(element.expression, index, scope, pending, builder)
      return
    case 'Match':
      collectExpression(expression.scrutinee, index, scope, pending, builder)
      for (const arm of expression.arms) {
        collectPattern(arm.pattern, index, scope, pending)
        if (arm.guard !== undefined) collectExpression(arm.guard, index, scope, pending, builder)
        if (arm.body._tag === 'Expression')
          collectExpression(arm.body.expression, index, scope, pending, builder)
        else
          for (const statement of arm.body.statements)
            collectStatement(statement, index, scope, pending, builder)
      }
      return
    case 'EffectBlock':
      for (const statement of expression.statements)
        collectStatement(statement, index, scope, pending, builder)
      return
    case 'EffectCatch':
      collectIntrinsicReference(expression.reference, index, pending)
      collectExpression(expression.protected, index, scope, pending, builder)
      collectExpression(expression.handler, index, scope, pending, builder)
      return
    case 'EffectBindRequirement':
      collectIntrinsicReference(expression.reference, index, pending)
      collectExpression(expression.protected, index, scope, pending, builder)
      return
    case 'Integer':
    case 'Boolean':
      return
  }
}

/** Resolves the authored names carried by one short-lived expression decision. */
export const ofExpressionDecision = (
  expression: Elaboration.ExpressionDecision,
  index: DeclarationIndex.Index,
  scope: NameResolution.ModuleScope | undefined,
): ReadonlyArray<LocatedOccurrence> => {
  const pending: Array<Pending> = []
  collectExpression(expression, index, scope, pending)
  return pending
}

const collectStatement = (
  statement: Tir.Statement,
  index: DeclarationIndex.Index,
  scope: NameResolution.ModuleScope | undefined,
  pending: Array<Pending>,
  builder?: BodyBuilder.BodyBuilder,
): void => {
  switch (statement._tag) {
    case 'Unsafe':
      for (const nested of statement.statements)
        collectStatement(nested, index, scope, pending, builder)
      return
    case 'Bind': {
      const binding =
        builder === undefined ? undefined : BodyBuilder.semanticOfLocal(builder, statement.binding)
      if (Elaboration.isBindingDeclarationFact(binding) && binding.name._tag === 'Present')
        push(
          pending,
          binding.name.anchor,
          'Declaration',
          available({ _tag: 'BindingIdentity', id: binding.id }),
          locationOfBinding(binding),
        )
      if (Elaboration.isBindingDeclarationFact(binding) && binding.declaredType !== undefined)
        collectDeclaredType(binding.declaredType, index, scope, pending)
      collectExpression(statement.initializer, index, scope, pending, builder)
      return
    }
    case 'PatternBind': {
      const semantic =
        builder === undefined
          ? undefined
          : BodyBuilder.semanticOfPatternSelection(builder, statement.selection)
      if (semantic !== undefined) collectPattern(semantic.pattern, index, scope, pending)
      collectExpression(
        statement.selection.source ?? statement.selection.subject,
        index,
        scope,
        pending,
        builder,
      )
      return
    }
    case 'Evaluate':
      collectExpression(statement.expression, index, scope, pending, builder)
      return
    case 'Return':
    case 'Fail':
    case 'Drop':
      collectExpression(statement.expression, index, scope, pending, builder)
      return
    case 'If':
      collectExpression(statement.condition, index, scope, pending, builder)
      for (const nested of statement.taken) collectStatement(nested, index, scope, pending, builder)
      for (const nested of statement.otherwise)
        collectStatement(nested, index, scope, pending, builder)
      return
    case 'IfLet': {
      const semantic =
        builder === undefined
          ? undefined
          : BodyBuilder.semanticOfPatternSelection(builder, statement.selection)
      if (semantic !== undefined) collectPattern(semantic.pattern, index, scope, pending)
      collectExpression(
        statement.selection.source ?? statement.selection.subject,
        index,
        scope,
        pending,
        builder,
      )
      for (const nested of statement.taken) collectStatement(nested, index, scope, pending, builder)
      for (const nested of statement.otherwise)
        collectStatement(nested, index, scope, pending, builder)
      return
    }
    case 'Write':
      if (statement.destination !== undefined)
        collectExpression(statement.destination, index, scope, pending, builder)
      collectExpression(statement.value, index, scope, pending, builder)
      return
    case 'While':
      collectExpression(statement.condition, index, scope, pending, builder)
      for (const nested of statement.body) collectStatement(nested, index, scope, pending, builder)
      return
    case 'Break':
    case 'Continue':
    case 'UnavailableStatement':
      return
  }
}

const collectMember = (
  member: DeclarationFacts.MemberFact,
  index: DeclarationIndex.Index,
  spans: SemanticContext.Registry,
  scope: NameResolution.ModuleScope | undefined,
  pending: Array<Pending>,
): void => {
  const declaration = locationOfDeclaration(index, member)
  if (member.name._tag === 'Present')
    push(
      pending,
      member.name.anchor,
      'Declaration',
      available(identityOfDeclaration(member)),
      declaration,
    )
  for (const typeParameter of member.typeParameters) {
    // Elision anchors a semantic binder to an annotation; it does not declare a source name there.
    if (typeParameter.implicitLifetime === true) continue
    // An inherent member carries its impl head's binders ahead of its own; the head declares
    // those once (see `collectInherentImpl`), so only binders spelled inside the member count.
    if (spans.spanOf(typeParameter.anchor).start < spans.spanOf(member.anchor).start) continue
    const parameterLocation = locationOfTypeParameter(typeParameter)
    if (typeParameter.name._tag === 'Present')
      push(
        pending,
        typeParameter.name.anchor,
        'Declaration',
        available({ _tag: 'TypeParameterIdentity', id: typeParameter.type }),
        parameterLocation,
      )
  }
  if (member._tag === 'FunctionDeclaration') {
    const opaqueBinder = member.opaqueResult?.binder
    if (opaqueBinder?.name._tag === 'Present')
      push(
        pending,
        opaqueBinder.name.anchor,
        'Declaration',
        available({ _tag: 'TypeParameterIdentity', id: opaqueBinder.type }),
        locationOfTypeParameter(opaqueBinder),
      )
    for (const parameter of member.parameters) {
      if (parameter.name._tag === 'Present')
        push(
          pending,
          parameter.name.anchor,
          'Declaration',
          available({ _tag: 'ParameterIdentity', id: parameter.id }),
          locationOfParameter(parameter),
        )
      collectDeclaredType(parameter.declaredType, index, scope, pending)
    }
    collectDeclaredType(member.returnType, index, scope, pending)
    collectRowExpression(member.failureRow.expression, index, scope, pending)
    collectRowExpression(member.requirementRow.expression, index, scope, pending)
    for (const constraint of member.constraints)
      collectConstraint(constraint, index, scope, pending)
    return
  }
  if (
    member._tag === 'ConstantDeclaration' ||
    member._tag === 'PackageParameterDeclaration' ||
    member._tag === 'ForeignStaticDeclaration'
  ) {
    collectDeclaredType(member.declaredType, index, scope, pending)
    return
  }
  if (member._tag === 'AliasDeclaration') {
    collectDeclaredType(member.target, index, scope, pending)
    return
  }
  if (member._tag === 'ServiceDeclaration' || member._tag === 'InterfaceDeclaration') {
    for (const operation of member.operations) {
      const opaqueBinder = operation.opaqueResult?.binder
      if (opaqueBinder?.name._tag === 'Present')
        push(
          pending,
          opaqueBinder.name.anchor,
          'Declaration',
          available({ _tag: 'TypeParameterIdentity', id: opaqueBinder.type }),
          locationOfTypeParameter(opaqueBinder),
        )
      for (const typeParameter of operation.typeParameters) {
        const parameterLocation = locationOfTypeParameter(typeParameter)
        if (typeParameter.name._tag === 'Present')
          push(
            pending,
            typeParameter.name.anchor,
            'Declaration',
            available({ _tag: 'TypeParameterIdentity', id: typeParameter.type }),
            parameterLocation,
          )
      }
      const operationLocation = locationOfServiceOperation(operation)
      if (operation.name._tag === 'Present' && operation.state._tag === 'Unique')
        push(
          pending,
          operation.name.anchor,
          'Declaration',
          available({ _tag: 'ServiceOperationIdentity', id: operation.state.id }),
          operationLocation,
        )
      for (const parameter of operation.parameters) {
        if (parameter.name._tag === 'Present')
          push(
            pending,
            parameter.name.anchor,
            'Declaration',
            available({ _tag: 'ParameterIdentity', id: parameter.id }),
            locationOfParameter(parameter),
          )
        collectDeclaredType(parameter.declaredType, index, scope, pending)
      }
      collectDeclaredType(operation.returnType, index, scope, pending)
      collectRowExpression(operation.failureRow.expression, index, scope, pending)
      collectRowExpression(operation.requirementRow.expression, index, scope, pending)
      for (const constraint of operation.constraints)
        collectConstraint(constraint, index, scope, pending)
    }
    return
  }
  if (member._tag === 'EnumDeclaration') {
    for (const enumMember of member.members)
      if (enumMember.name._tag === 'Present' && enumMember.canonical._tag === 'Canonical')
        push(
          pending,
          enumMember.name.anchor,
          'Declaration',
          available({ _tag: 'EnumMemberIdentity', id: enumMember.canonical.id }),
          locationOfEnumMember(enumMember),
        )
    return
  }
  if (member._tag === 'RoleDeclaration') return
  if (member._tag === 'UnionDeclaration') {
    for (const variant of member.variants) {
      if (variant.name._tag === 'Present' && variant.canonical._tag === 'Canonical')
        push(
          pending,
          variant.name.anchor,
          'Declaration',
          available({ _tag: 'UnionVariantIdentity', id: variant.canonical.id }),
          locationOfUnionVariant(variant),
        )
      for (const field of variant.fields) {
        if (field.name._tag === 'Present')
          push(
            pending,
            field.name.anchor,
            'Declaration',
            available({ _tag: 'FieldIdentity', id: field.id }),
            locationOfField(index, field),
          )
        collectDeclaredType(field.declaredType, index, scope, pending)
      }
    }
    return
  }
  const fields = member.fields
  for (const field of fields) {
    if (field.name._tag === 'Present')
      push(
        pending,
        field.name.anchor,
        'Declaration',
        available({ _tag: 'FieldIdentity', id: field.id }),
        locationOfField(index, field),
      )
    collectDeclaredType(field.declaredType, index, scope, pending)
  }
}

/** The head `impl<Binders> Owner<Binders>` declares the binders once and references the owner. */
const collectInherentImpl = (
  head: DeclarationFacts.InherentImplFact,
  index: DeclarationIndex.Index,
  scope: NameResolution.ModuleScope | undefined,
  pending: Array<Pending>,
): void => {
  for (const typeParameter of head.typeParameters)
    if (typeParameter.name._tag === 'Present')
      push(
        pending,
        typeParameter.name.anchor,
        'Declaration',
        available({ _tag: 'TypeParameterIdentity', id: typeParameter.type }),
        locationOfTypeParameter(typeParameter),
      )
  collectDeclaredType(head.owner, index, scope, pending)
}

const unavailableLookupResolution = (
  lookup: Exclude<NameResolution.Lookup, { readonly _tag: 'Resolved' }>,
): Resolution => {
  switch (lookup._tag) {
    case 'Missing':
      return { _tag: 'Missing' }
    case 'Inaccessible':
      return { _tag: 'Inaccessible', cause: lookup.cause }
    case 'Conflict':
      return { _tag: 'Conflicting', cause: lookup.conflict.cause }
    case 'Unavailable':
      return {
        _tag: 'Unavailable',
        ...(lookup.cause === undefined ? {} : { cause: lookup.cause }),
      }
    default:
      return { _tag: 'Unavailable' }
  }
}

const collectTypePath = (
  path: DeclarationFacts.TypePathFact,
  index: DeclarationIndex.Index,
  scope: NameResolution.ModuleScope | undefined,
  pending: Array<Pending>,
): void => {
  const qualifier = path.segments.length > 1 ? path.segments.at(0) : undefined
  if (qualifier !== undefined)
    collectQualifier(qualifier.anchor, qualifier.spelling, scope, index, pending)
  const selected = path.segments.at(-1)
  if (selected === undefined || scope === undefined) return
  const lookup = NameResolution.lookupPath(scope, index, path, {
    kind: 'ToolingPath',
    key: `${path.spelling}@${AuthoredIdentity.anchorKey(path.anchor)}`,
  })
  if (lookup._tag === 'Resolved') {
    push(
      pending,
      selected.anchor,
      'Value',
      available(identityOfDeclaration(lookup.declaration)),
      locationOfDeclaration(index, lookup.declaration),
    )
    return
  }
  push(
    pending,
    selected.anchor,
    'Value',
    unavailableLookupResolution(lookup),
    'declaration' in lookup && lookup.declaration !== undefined
      ? locationOfDeclaration(index, lookup.declaration)
      : undefined,
  )
}

const collectConformance = (
  conformance: DeclarationFacts.ConformanceFact,
  index: DeclarationIndex.Index,
  scope: NameResolution.ModuleScope | undefined,
  pending: Array<Pending>,
): void => {
  for (const typeParameter of conformance.typeParameters)
    if (typeParameter.name._tag === 'Present')
      push(
        pending,
        typeParameter.name.anchor,
        'Declaration',
        available({ _tag: 'TypeParameterIdentity', id: typeParameter.type }),
        locationOfTypeParameter(typeParameter),
      )
  for (const requirement of conformance.requirements)
    collectDeclaredType(requirement.capability, index, scope, pending)
  collectDeclaredType(conformance.capability, index, scope, pending)
  collectDeclaredType(conformance.provider, index, scope, pending)
  for (const operation of conformance.operations)
    if (operation.target._tag === 'TypePath')
      collectTypePath(operation.target, index, scope, pending)
  if (conformance.hook !== undefined) {
    collectDeclaredType(conformance.hook.parameterType, index, scope, pending)
    collectDeclaredType(conformance.hook.returnType, index, scope, pending)
    collectRowExpression(conformance.hook.failureRow.expression, index, scope, pending)
    collectRowExpression(conformance.hook.requirementRow.expression, index, scope, pending)
  }
}

const collectImports = (
  scope: NameResolution.ModuleScope | undefined,
  index: DeclarationIndex.Index,
  pending: Array<Pending>,
): void => {
  for (const imported of scope?.imports ?? []) {
    if (imported._tag !== 'Available') continue
    for (const binding of imported.bindings) {
      if (binding._tag === 'LocalDeclaration' || binding._tag === 'IntrinsicActor') continue
      if (binding._tag === 'ModuleNamespace') {
        const selection = binding.anchor
        const declaration = location(undefined, binding.anchor, selection)
        push(
          pending,
          selection,
          'Import',
          available({
            _tag: 'ImportNamespaceIdentity',
            module: binding.module,
            spelling: binding.spelling,
          }),
          declaration,
        )
        continue
      }
      if (binding._tag === 'ImportedMember') {
        const declarationFact = DeclarationFacts.byCanonical(index, binding.declaration)
        const identity =
          declarationFact === undefined ? undefined : identityOfDeclaration(declarationFact)
        const sourceSpan = binding.sourceAnchor
        const localSpan = binding.localAnchor
        const selected =
          AuthoredIdentity.anchorKey(sourceSpan) === AuthoredIdentity.anchorKey(localSpan)
            ? [sourceSpan]
            : [sourceSpan, localSpan]
        for (const span of selected)
          push(
            pending,
            span,
            'Import',
            identity === undefined ? { _tag: 'Unavailable' } : available(identity),
            declarationFact === undefined
              ? undefined
              : locationOfDeclaration(index, declarationFact),
          )
        continue
      }
      if (binding._tag === 'Unavailable')
        for (const anchor of binding.anchors)
          push(pending, anchor, 'Import', {
            _tag: 'Unavailable',
            ...(binding.cause === undefined ? {} : { cause: binding.cause }),
          })
    }
  }
}

/** Starts of identifiers written after a `.`: members reached through a qualifier. */
/**
 * The occurrences inside one body, for construction to publish with it.
 *
 * Header occurrences are collected per revision from the declaration index; these are the part a
 * reused body keeps.
 */
export const ofStatements = (
  statements: ReadonlyArray<Tir.Statement>,
  index: DeclarationIndex.Index,
  scope: NameResolution.ModuleScope | undefined,
  builder?: BodyBuilder.BodyBuilder,
): ReadonlyArray<LocatedOccurrence> => {
  const pending: Array<Pending> = []
  for (const statement of statements) collectStatement(statement, index, scope, pending, builder)
  return pending
}

const qualifiedOccurrenceStarts = (tokens: ReadonlyArray<Token.Token>): ReadonlySet<number> => {
  const starts = new Set<number>()
  let previous: Token.Token | undefined
  for (const token of tokens) {
    if (token.kind === 'Whitespace' || token.kind.endsWith('Comment')) continue
    if (token.kind === 'Identifier' && previous?.kind === 'Dot') starts.add(token.span.start)
    previous = token
  }
  return starts
}

/**
 * The authored import name that supplied one unqualified occurrence.
 *
 * Which import a use spends is a fact about what was written: two aliases of one declaration are
 * told apart only by the spelling at the use, and `geo.area` spends `geo`, not a direct `area`
 * selector beside it. Both come from the module's syntax, which this tooling index is built with.
 */
const importBindingFor = (
  occurrence: Omit<SemanticOccurrence, 'ordinal'>,
  spans: SemanticContext.Registry,
  bindings: ReadonlyMap<string, NameResolution.Binding>,
  syntax: SyntaxFile.SyntaxFile,
  qualifiedStarts: ReadonlySet<number>,
): SourceSpan.SourceSpan | undefined => {
  if (occurrence.role === 'Import' || occurrence.resolution._tag !== 'Available') return undefined
  const spelling = Option.getOrUndefined(SourceFile.spelling(syntax.source, occurrence.span))
  const binding = spelling === undefined ? undefined : bindings.get(spelling)
  const identity = occurrence.resolution.identity
  if (binding?._tag === 'ModuleNamespace')
    return identity._tag === 'ImportNamespaceIdentity' &&
      identity.module === binding.module &&
      identity.spelling === binding.spelling
      ? spans.spanOf(binding.anchor)
      : undefined
  if (binding?._tag !== 'ImportedMember' || qualifiedStarts.has(occurrence.span.start))
    return undefined
  return identity._tag === 'DeclarationIdentity' &&
    identityKey(identity) === identityKey({ _tag: 'DeclarationIdentity', id: binding.declaration })
    ? spans.spanOf(binding.localAnchor)
    : undefined
}

/** Builds one module's immutable exact-token occurrence index from recovered compiler facts. */
export const makeModule = (
  module: string,
  result: Elaboration.Result,
  index: DeclarationIndex.Index,
  spans: SemanticContext.Registry,
  resolution: NameResolution.Resolution,
  conditions: ReadonlyArray<Elaboration.ExpressionDecision> = [],
  syntax?: SyntaxFile.SyntaxFile,
): ModuleIndex => {
  const pending: Array<Pending> = []
  const scope = NameResolution.scopeOf(resolution, module)
  const headers = DeclarationFacts.moduleHeaders(index, module)
  for (const member of headers?.members ?? []) collectMember(member, index, spans, scope, pending)
  for (const head of headers?.inherentImpls ?? []) collectInherentImpl(head, index, scope, pending)
  for (const conformance of headers?.conformances ?? [])
    collectConformance(conformance, index, scope, pending)
  for (const body of result.bodies) pending.push(...body.results.occurrences)
  for (const condition of conditions) collectExpression(condition, index, scope, pending)
  collectImports(scope, index, pending)
  // The first binding of a spelling is the effective one; later ones are conflicts.
  const bindings = new Map<string, NameResolution.Binding>()
  for (const binding of scope?.bindings ?? [])
    if (!bindings.has(binding.spelling)) bindings.set(binding.spelling, binding)
  const qualifiedStarts =
    syntax === undefined ? new Set<number>() : qualifiedOccurrenceStarts(syntax.tokens)
  const attributed = publish(pending, spans).map((entry): Published => {
    const importBinding =
      syntax === undefined
        ? undefined
        : importBindingFor(entry.occurrence, spans, bindings, syntax, qualifiedStarts)
    return importBinding === undefined
      ? entry
      : {
          ...entry,
          occurrence: { ...entry.occurrence, importBinding },
        }
  })
  attributed.sort(
    (left, right) =>
      left.occurrence.span.start - right.occurrence.span.start ||
      left.occurrence.span.end -
        left.occurrence.span.start -
        (right.occurrence.span.end - right.occurrence.span.start) ||
      left.ordinal - right.ordinal,
  )
  const occurrences = attributed.map((entry) => ({ ...entry.occurrence, ordinal: entry.ordinal }))
  let maximumEnd = 0
  const prefixMaximumEnd = occurrences.map((occurrence) => {
    maximumEnd = Math.max(maximumEnd, occurrence.span.end)
    return maximumEnd
  })
  const declarationLocations = new Map<string, DeclarationLocation>()
  for (const occurrence of occurrences) {
    if (occurrence.resolution._tag !== 'Available') continue
    const declaration = occurrence.declaration
    if (
      declaration === undefined ||
      declaration.module !== module ||
      occurrence.span.start !== declaration.selectionSpan.start ||
      occurrence.span.end !== declaration.selectionSpan.end
    )
      continue
    declarationLocations.set(identityKey(occurrence.resolution.identity), declaration)
  }
  return { occurrences, prefixMaximumEnd, declarationLocations }
}

/** Shallowly composes current module indexes and their current declaration locations. */
export const compose = (modules: ReadonlyMap<string, ModuleIndex>): Index => {
  const declarationLocations = new Map<string, DeclarationLocation>()
  for (const moduleIndex of modules.values())
    for (const [identity, declaration] of moduleIndex.declarationLocations)
      declarationLocations.set(identity, declaration)
  return { _tag: 'SemanticOccurrenceIndex', modules, declarationLocations }
}

/** Builds the immutable exact-token occurrence index from recovered compiler facts. */
export const make = (
  results: ReadonlyMap<string, Elaboration.Result>,
  index: DeclarationIndex.Index,
  resolution: NameResolution.Resolution,
): Index => {
  const spans = SemanticContext.fromModules([...results.values()])
  return compose(
    new Map(
      [...results].map(([module, result]) => [
        module,
        makeModule(module, result, index, spans, resolution),
      ]),
    ),
  )
}

const withCurrentDeclaration = (
  self: Index,
  occurrence: SemanticOccurrence,
): SemanticOccurrence => {
  // Unavailable occurrences can still retain an exact rejected candidate (for example an open
  // `typeof` item). That location was built from the current declaration index and is the useful
  // navigation answer even though no available semantic identity can be rebased through the map.
  if (occurrence.resolution._tag !== 'Available') return occurrence
  const current = self.declarationLocations.get(identityKey(occurrence.resolution.identity))
  if (current === occurrence.declaration) return occurrence
  const { declaration: _previous, ...withoutDeclaration } = occurrence
  return {
    ...withoutDeclaration,
    ...(current === undefined ? {} : { declaration: current }),
  }
}

const lastStartAtOrBefore = (
  occurrences: ReadonlyArray<SemanticOccurrence>,
  offset: number,
): number => {
  let low = 0
  let high = occurrences.length - 1
  let answer = -1
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const candidate = occurrences.at(middle)
    if (candidate !== undefined && candidate.span.start <= offset) {
      answer = middle
      low = middle + 1
    } else high = middle - 1
  }
  return answer
}

/** Returns the smallest deterministic half-open occurrence containing one byte offset. */
export const at = (self: Index, module: string, offset: number): SemanticOccurrence | undefined => {
  const moduleIndex = self.modules.get(module)
  if (moduleIndex === undefined) return undefined
  let cursor = lastStartAtOrBefore(moduleIndex.occurrences, offset)
  let selected: SemanticOccurrence | undefined
  const rank = (occurrence: SemanticOccurrence): readonly [number, number, number] => {
    let identityRank = 2
    if (occurrence.resolution._tag === 'Available') {
      const identity = occurrence.resolution.identity
      if (identity._tag === 'BindingIdentity' || identity._tag === 'PatternBindingIdentity')
        identityRank = 0
      else if (identity._tag === 'ParameterIdentity') identityRank = 1
    }
    return [
      occurrence.resolution._tag === 'Available' ? 0 : 1,
      occurrence.role === 'Declaration' ? 0 : 1,
      identityRank,
    ]
  }
  const preferred = (left: SemanticOccurrence, right: SemanticOccurrence): boolean => {
    const leftRank = rank(left)
    const rightRank = rank(right)
    for (let index = 0; index < leftRank.length; index += 1) {
      const leftPart = leftRank.at(index) ?? 0
      const rightPart = rightRank.at(index) ?? 0
      if (leftPart !== rightPart) return leftPart < rightPart
    }
    return left.ordinal < right.ordinal
  }
  while (cursor >= 0 && (moduleIndex.prefixMaximumEnd.at(cursor) ?? 0) > offset) {
    const candidate = moduleIndex.occurrences.at(cursor)
    if (
      candidate !== undefined &&
      candidate.span.start <= offset &&
      offset < candidate.span.end &&
      (selected === undefined ||
        candidate.span.end - candidate.span.start < selected.span.end - selected.span.start ||
        (candidate.span.end - candidate.span.start === selected.span.end - selected.span.start &&
          preferred(candidate, selected)))
    )
      selected = candidate
    cursor -= 1
  }
  return selected === undefined ? undefined : withCurrentDeclaration(self, selected)
}

/** Returns occurrences whose exact token spans overlap one half-open byte range. */
export const inRange = (
  self: Index,
  module: string,
  range: SourceSpan.SourceSpan,
): ReadonlyArray<SemanticOccurrence> =>
  (self.modules.get(module)?.occurrences ?? [])
    .filter((occurrence) => occurrence.span.start < range.end && range.start < occurrence.span.end)
    .map((occurrence) => withCurrentDeclaration(self, occurrence))

/** Returns a stable structural key for identity deduplication and lookup. */
export const identityKey = (identity: Identity): string => {
  switch (identity._tag) {
    case 'DeclarationIdentity':
      return identity.id._tag === 'CanonicalDeclarationId'
        ? `declaration:${identity.id.module}.${identity.id.name}`
        : `declaration:${identity.id.sourceId}:${identity.id.ordinal}`
    case 'TypeParameterIdentity':
      return `type-parameter:${Type.key(identity.id)}`
    case 'ParameterIdentity':
      return `parameter:${identity.id.function.sourceId}:${identity.id.function.ordinal}:${identity.id.ordinal}`
    case 'BindingIdentity':
      return `binding:${identity.id.function.sourceId}:${identity.id.function.ordinal}:${identity.id.ordinal}`
    case 'PatternBindingIdentity':
      return `pattern:${JSON.stringify(identity.id)}`
    case 'FieldIdentity':
      return `field:${DeclarationFacts.fieldIdKey(identity.id)}`
    case 'UnionVariantIdentity':
      return `union-variant:${identity.id.union.module}.${identity.id.union.name}.${identity.id.name}`
    case 'EnumMemberIdentity':
      return `enum-member:${identity.id.enum.module}.${identity.id.enum.name}.${identity.id.name}`
    case 'EnumAssociatedOperationIdentity':
      return `enum-operation:${identity.id.enum.module}.${identity.id.enum.name}.${identity.id.name}`
    case 'ServiceOperationIdentity':
      return `service-operation:${identity.id.service.sourceId}:${identity.id.service.ordinal}:${identity.id.name}`
    case 'ImportNamespaceIdentity':
      return `namespace:${identity.module}:${identity.spelling}`
    case 'IntrinsicActorIdentity':
      return `intrinsic-actor:${identity.id.name}`
    case 'IntrinsicOperationIdentity':
      return `intrinsic-operation:${identity.id.actor}.${identity.id.name}`
  }
}
