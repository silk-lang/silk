import * as Option from 'effect/Option'
import * as ConformanceProof from './ConformanceProof.js'
import * as DeclarationFacts from './DeclarationFacts.js'
import type * as DeclarationIndex from './DeclarationIndex.js'
import * as Elaboration from './Elaboration.js'
import * as Intrinsic from './Intrinsic.js'
import * as NameResolution from './NameResolution.js'
import * as SemanticDisplay from './SemanticDisplay.js'
import * as Semantic from './Semantic.js'
import * as Scalar from './Scalar.js'
import type * as SemanticOccurrence from './SemanticOccurrence.js'
import * as SemanticContext from './SemanticContext.js'
import * as SourceFile from './SourceFile.js'
import type * as SourceSpan from './SourceSpan.js'
import * as SourceSpanFactory from './SourceSpan.js'
import * as Type from './Type.js'

export type Context =
  | { readonly _tag: 'ExpressionContext' }
  | { readonly _tag: 'DeclaredTypeContext' }
  | { readonly _tag: 'TypeArgumentContext' }
  | { readonly _tag: 'ActorMemberContext'; readonly actor: string }
  | {
      readonly _tag: 'ValueMemberContext'
      readonly state: 'Available' | 'Missing' | 'Ambiguous' | 'Unavailable'
    }
  | { readonly _tag: 'UnavailableContext' }

export type Kind =
  | 'Binding'
  | 'Parameter'
  | 'Function'
  | 'Method'
  | 'AssociatedFunction'
  | 'Constant'
  | 'Constructor'
  | 'Type'
  | 'Field'
  | 'Actor'
  | 'Operation'
  | 'Keyword'

export type CandidateIdentity =
  | { readonly _tag: 'SemanticCandidate'; readonly identity: SemanticOccurrence.Identity }
  | { readonly _tag: 'SyntaxCandidate'; readonly spelling: string }

export interface Candidate {
  readonly _tag: 'CompletionCandidate'
  readonly identity: CandidateIdentity
  readonly kind: Kind
  readonly label: string
  readonly insertText: string
  readonly detail?: SemanticDisplay.Presentation
  readonly sortGroup: number
}

/** One deterministic completion answer with an exact byte replacement span. */
export interface Result {
  readonly _tag: 'CompletionResult'
  readonly context: Context
  readonly replacement: SourceSpan.SourceSpan
  readonly candidates: ReadonlyArray<Candidate>
}

const decoder = new TextDecoder()

const isIdentifierByte = (byte: number | undefined): boolean =>
  byte !== undefined &&
  ((byte >= 0x41 && byte <= 0x5a) ||
    (byte >= 0x61 && byte <= 0x7a) ||
    (byte >= 0x30 && byte <= 0x39) ||
    byte === 0x5f)

const replacementSpan = (
  source: SourceFile.SourceFile,
  offset: number,
): { readonly span: SourceSpan.SourceSpan; readonly start: number } => {
  const bytes = SourceFile.toUint8Array(source)
  const end = Math.max(0, Math.min(offset, bytes.length))
  let start = end
  while (start > 0 && isIdentifierByte(bytes.at(start - 1))) start -= 1
  return {
    span: Option.getOrThrowWith(
      SourceSpanFactory.make(source, start, end),
      () => new RangeError('Completion replacement escaped its source snapshot'),
    ),
    start,
  }
}

const declarationIdentity = (
  declaration: DeclarationFacts.MemberFact,
): SemanticOccurrence.Identity => ({
  _tag: 'DeclarationIdentity',
  id: declaration.canonical._tag === 'Canonical' ? declaration.canonical.id : declaration.id,
})

const declarationKind = (
  declaration: DeclarationFacts.MemberFact,
  aggregateKind: 'Type' | 'Constructor',
): Kind => {
  switch (declaration._tag) {
    case 'FunctionDeclaration':
      return 'Function'
    case 'PackageParameterDeclaration':
    case 'ConstantDeclaration':
    case 'ForeignStaticDeclaration':
      return 'Constant'
    case 'ServiceDeclaration':
    case 'InterfaceDeclaration':
    case 'RoleDeclaration':
    case 'EnumDeclaration':
    case 'UnionDeclaration':
    case 'AliasDeclaration':
      return 'Type'
    case 'StructDeclaration':
      return aggregateKind
  }
}

const declarationDetail = (
  declaration: DeclarationFacts.MemberFact,
): SemanticDisplay.Presentation => {
  switch (declaration._tag) {
    case 'FunctionDeclaration':
      return SemanticDisplay.functionDeclaration(declaration)
    case 'PackageParameterDeclaration':
    case 'ConstantDeclaration':
      return SemanticDisplay.constantDeclaration(declaration)
    case 'ForeignStaticDeclaration':
      return SemanticDisplay.foreignStaticDeclaration(declaration)
    case 'ServiceDeclaration':
    case 'InterfaceDeclaration':
      return SemanticDisplay.serviceDeclaration(declaration)
    case 'RoleDeclaration':
      return SemanticDisplay.roleDeclaration(declaration)
    case 'EnumDeclaration':
      return SemanticDisplay.enumDeclaration(declaration)
    case 'StructDeclaration':
      return SemanticDisplay.structDeclaration(declaration)
    case 'UnionDeclaration':
      return SemanticDisplay.unionDeclaration(declaration)
    case 'AliasDeclaration':
      return SemanticDisplay.aliasDeclaration(declaration)
  }
}

const compareText = (left: string, right: string): number => {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

const semantic = (identity: SemanticOccurrence.Identity): CandidateIdentity => ({
  _tag: 'SemanticCandidate',
  identity,
})

const syntax = (spelling: string): CandidateIdentity => ({ _tag: 'SyntaxCandidate', spelling })

const candidate = (options: {
  readonly identity: CandidateIdentity
  readonly kind: Kind
  readonly label: string
  readonly detail?: SemanticDisplay.Presentation
  readonly sortGroup: number
}): Candidate => ({
  _tag: 'CompletionCandidate',
  identity: options.identity,
  kind: options.kind,
  label: options.label,
  insertText: options.label,
  ...(options.detail === undefined ? {} : { detail: options.detail }),
  sortGroup: options.sortGroup,
})

const enclosingFunction = (
  context: SemanticContext.SemanticContext,
  result: Elaboration.Result,
  offset: number,
): Elaboration.CheckedBody | undefined => {
  const width = (fn: Elaboration.CheckedBody): number => {
    const span = context.spanOf(fn.declaration.anchor)
    return span.end - span.start
  }
  return result.bodies
    .filter((fn) => {
      const span = context.spanOf(fn.declaration.anchor)
      return span.start <= offset && offset <= span.end
    })
    .sort((left, right) => width(left) - width(right))
    .at(0)
}

const sameDeclaration = (
  left: Elaboration.DeclarationId,
  right: Elaboration.DeclarationId,
): boolean => left.sourceId === right.sourceId && left.ordinal === right.ordinal

const scopeChain = (
  context: SemanticContext.SemanticContext,
  result: Elaboration.Result,
  fn: Elaboration.CheckedBody | undefined,
  offset: number,
): ReadonlyArray<Elaboration.LexicalScopeFact> => {
  if (fn === undefined) return []
  const candidates = result.lexicalScopes
    .filter((scope) => sameDeclaration(scope.id.function, fn.declaration.id))
    .map((scope) => ({
      scope,
      start: context.spanOf(scope.first).start,
      end: context.spanOf(scope.last).end,
    }))
    .filter(({ start, end }) => start <= offset && offset <= end)
    .sort(
      (left, right) =>
        left.end - left.start - (right.end - right.start) ||
        right.scope.id.ordinal - left.scope.id.ordinal,
    )
    .map(({ scope }) => scope)
  const byOrdinal = new Map(
    result.lexicalScopes
      .filter((scope) => sameDeclaration(scope.id.function, fn.declaration.id))
      .map((scope) => [scope.id.ordinal, scope] as const),
  )
  const chain: Array<Elaboration.LexicalScopeFact> = []
  let current = candidates.at(0)
  while (current !== undefined) {
    chain.push(current)
    current = current.parent === undefined ? undefined : byOrdinal.get(current.parent.ordinal)
  }
  return chain
}

const visibleBindings = (
  context: SemanticContext.SemanticContext,
  result: Elaboration.Result,
  fn: Elaboration.CheckedBody | undefined,
  offset: number,
): ReadonlyArray<Elaboration.ScopeBinding> => {
  const selected = new Map<string, Elaboration.ScopeBinding>()
  for (const scope of scopeChain(context, result, fn, offset))
    for (const binding of scope.bindings.toReversed())
      if (
        binding.name._tag === 'Present' &&
        context.spanOf(binding.name.anchor).start < offset &&
        !selected.has(binding.name.spelling)
      )
        selected.set(binding.name.spelling, binding)
  return [...selected.values()].sort(
    (left, right) => context.spanOf(left.anchor).start - context.spanOf(right.anchor).start,
  )
}

const visiblePatternBindings = (
  context: SemanticContext.SemanticContext,
  result: Elaboration.Result,
  fn: Elaboration.CheckedBody | undefined,
  offset: number,
): ReadonlyArray<Elaboration.PatternBindingFact> => {
  const selected = new Map<string, Elaboration.PatternBindingFact>()
  for (const scope of scopeChain(context, result, fn, offset))
    for (const binding of scope.patternBindings.toReversed())
      if (
        binding.name._tag === 'Present' &&
        context.spanOf(binding.name.anchor).start <= offset &&
        !selected.has(binding.name.spelling)
      )
        selected.set(binding.name.spelling, binding)
  return [...selected.values()]
}

const actorCandidates = (actor: Intrinsic.Actor): ReadonlyArray<Candidate> =>
  actor.operations.map((operation) =>
    candidate({
      identity: semantic({ _tag: 'IntrinsicOperationIdentity', id: operation.id }),
      kind: 'Operation',
      label: operation.spelling,
      detail: SemanticDisplay.intrinsicOperation(operation),
      sortGroup: 0,
    }),
  )

const enumCandidates = (enum_: DeclarationFacts.EnumFact): ReadonlyArray<Candidate> => [
  ...enum_.members.flatMap((member): ReadonlyArray<Candidate> =>
    member.name._tag !== 'Present' || member.canonical._tag !== 'Canonical'
      ? []
      : [
          candidate({
            identity: semantic({ _tag: 'EnumMemberIdentity', id: member.canonical.id }),
            kind: 'Constant',
            label: member.name.spelling,
            detail: SemanticDisplay.enumMember(enum_, member),
            sortGroup: 0,
          }),
        ],
  ),
  ...enum_.associatedOperations.map((operation) =>
    candidate({
      identity: semantic({ _tag: 'EnumAssociatedOperationIdentity', id: operation.id }),
      kind: 'Operation',
      label: operation.name,
      detail: SemanticDisplay.enumAssociatedOperation(operation),
      sortGroup: 1,
    }),
  ),
]

const unionCandidates = (union: DeclarationFacts.UnionFact): ReadonlyArray<Candidate> =>
  union.variants.flatMap((variant): ReadonlyArray<Candidate> =>
    variant.name._tag !== 'Present' || variant.canonical._tag !== 'Canonical'
      ? []
      : [
          candidate({
            identity: semantic({ _tag: 'UnionVariantIdentity', id: variant.canonical.id }),
            kind: 'Constructor',
            label: variant.name.spelling,
            detail: SemanticDisplay.unionVariant(union, variant),
            sortGroup: 0,
          }),
        ],
  )

const serviceCandidates = (service: DeclarationFacts.ServiceFact): ReadonlyArray<Candidate> =>
  service.operations.flatMap((operation): ReadonlyArray<Candidate> =>
    operation.name._tag !== 'Present' || operation.state._tag !== 'Unique'
      ? []
      : [
          candidate({
            identity: semantic({ _tag: 'ServiceOperationIdentity', id: operation.state.id }),
            kind: 'Operation',
            label: operation.name.spelling,
            detail: SemanticDisplay.serviceOperation(operation),
            sortGroup: 0,
          }),
        ],
  )

/**
 * The owner's accessible inherent members, labeled `Method` when parameter zero is the receiver
 * and `AssociatedFunction` otherwise. Visibility and duplicate rules are the resolver's.
 */
const inherentCandidates = (
  session: Semantic.Session,
  index: DeclarationIndex.Index,
  owner: DeclarationFacts.MemberFact,
  module: string,
): ReadonlyArray<Candidate> => {
  if (owner.canonical._tag !== 'Canonical') return []
  const ownerId = owner.canonical.id
  const names = new Set<string>()
  for (const member of index.modules.find((headers) => headers.module === ownerId.module)
    ?.members ?? []) {
    const associated = member._tag === 'FunctionDeclaration' ? member.associatedMember : undefined
    if (associated === undefined) continue
    if ((associated.owner?.name ?? associated.ownerSpelling) === ownerId.name)
      names.add(associated.name)
  }
  return [...names].flatMap((name): ReadonlyArray<Candidate> => {
    const lookup = Semantic.resolveAssociatedName(session, owner, name, module)
    if (lookup._tag !== 'Inherent' || lookup.declaration._tag !== 'FunctionDeclaration') return []
    return [
      candidate({
        identity: semantic(declarationIdentity(lookup.declaration)),
        kind: lookup.declaration.associatedMember?.receiver ? 'Method' : 'AssociatedFunction',
        label: name,
        detail: SemanticDisplay.functionDeclaration(lookup.declaration),
        sortGroup: 1,
      }),
    ]
  })
}

const namespaceCandidates = (
  index: DeclarationIndex.Index,
  module: string,
  sortGroup = 0,
): ReadonlyArray<Candidate> => {
  const headers = index.modules.find((headers) => headers.module === module)
  const entries = [
    ...(headers?.members ?? []).map((declaration) => ({
      declaration,
      label: declaration.name._tag === 'Present' ? declaration.name.spelling : '',
    })),
    ...(headers?.publications ?? []).flatMap((publication) => {
      const resolved = DeclarationFacts.publishedMember(index, module, publication.spelling)
      return resolved._tag === 'Resolved'
        ? [{ declaration: resolved.declaration, label: publication.spelling }]
        : []
    }),
  ]
  return entries.flatMap(({ declaration, label }) => {
    if (
      declaration.visibility !== 'Public' ||
      declaration.name._tag !== 'Present' ||
      (declaration._tag === 'FunctionDeclaration' && declaration.associatedMember !== undefined)
    ) {
      return []
    }
    return [
      candidate({
        identity: semantic(declarationIdentity(declaration)),
        kind: declarationKind(declaration, 'Type'),
        label,
        detail: declarationDetail(declaration),
        sortGroup,
      }),
    ]
  })
}

interface ValueLookup {
  readonly found: boolean
  readonly type?: Type.Type
}

const valueLookup = (
  context: SemanticContext.SemanticContext,
  spelling: string,
  result: Elaboration.Result,
  fn: Elaboration.CheckedBody | undefined,
  offset: number,
): ValueLookup => {
  const binding = visibleBindings(context, result, fn, offset).find(
    (candidate) => candidate.name._tag === 'Present' && candidate.name.spelling === spelling,
  )
  if (binding !== undefined)
    return {
      found: true,
      ...(binding.inferredType._tag === 'Available' ? { type: binding.inferredType.type } : {}),
    }
  const patternBinding = visiblePatternBindings(context, result, fn, offset).find(
    (candidate) => candidate.name._tag === 'Present' && candidate.name.spelling === spelling,
  )
  if (patternBinding !== undefined)
    return {
      found: true,
      ...(patternBinding.type._tag === 'Available' ? { type: patternBinding.type.type } : {}),
    }
  const parameter = fn?.declaration.parameters.find(
    (candidate) => candidate.name._tag === 'Present' && candidate.name.spelling === spelling,
  )
  if (parameter !== undefined)
    return {
      found: true,
      ...(parameter.declaredType._tag === 'Resolved' ? { type: parameter.declaredType.type } : {}),
    }
  return { found: false }
}

const nominalSubject = (type: Type.Type | undefined): Type.Nominal | undefined => {
  if (type === undefined) return undefined
  if (Type.isNominal(type)) return type
  if (Type.isReference(type)) return nominalSubject(type.target)
  return undefined
}

const parameterSubjectOf = (type: Type.Type | undefined): Type.Parameter | undefined => {
  if (type === undefined) return undefined
  if (Type.isParameter(type)) return type
  if (Type.isReference(type)) return parameterSubjectOf(type.target)
  return undefined
}

/**
 * The receiver methods a value of one nominal type can call, presented receiver-bound: parameter
 * zero is the value itself. Associated functions are not value members and are left out.
 */
const receiverMethodCandidates = (
  session: Semantic.Session,
  index: DeclarationIndex.Index,
  type: Type.Nominal | undefined,
  module: string,
  scope: NameResolution.ModuleScope | undefined,
): ReadonlyArray<Candidate> => {
  // The subject's own arguments fix the owner binders each method presents.
  if (type === undefined) return []
  const owner = DeclarationFacts.byCanonical(index, {
    _tag: 'CanonicalDeclarationId',
    module: type.module,
    name: type.name,
  })
  if (owner === undefined) return []
  return inherentCandidates(session, index, owner, module).flatMap((member) => {
    if (member.kind !== 'Method' || member.identity._tag !== 'SemanticCandidate') return []
    const identity = member.identity.identity
    const declaration =
      identity._tag === 'DeclarationIdentity' && identity.id._tag === 'CanonicalDeclarationId'
        ? DeclarationFacts.byCanonical(index, identity.id)
        : undefined
    return declaration?._tag === 'FunctionDeclaration'
      ? [
          candidate({
            identity: member.identity,
            kind: 'Method',
            label: member.label,
            detail: SemanticDisplay.receiverMethod(
              declaration,
              SemanticDisplay.receiverSubstitution(declaration, type),
              module,
              scope,
            ),
            sortGroup: 1,
          }),
        ]
      : []
  })
}

/**
 * The receiver operations a concrete value obtains from the conformances it provably has.
 *
 * This mirrors what the resolver admits at the same position: `implementedContracts` applies the
 * same proof, coherence, and interface-visibility filter, an inherent member of that name already
 * claimed the call, and a name two applications supply would be reported rather than resolved, so
 * neither is offered as a callable member.
 */
const suppliedOperationCandidates = (
  index: DeclarationIndex.Index,
  type: Type.Nominal | undefined,
  module: string,
  inherent: ReadonlyArray<Candidate>,
): ReadonlyArray<Candidate> => {
  if (type === undefined) return []
  const claimed = new Set(inherent.map((member) => member.label))
  const supplied = ConformanceProof.implementedContracts(index, module, type).flatMap(
    (capability) => {
      const contract = ConformanceProof.contractByCapability(index, capability)
      if (contract === undefined || contract.dependencyEligible) return []
      const application = DeclarationFacts.interfaceApplication(contract, capability, type)
      if (application?.available !== true) return []
      return application.operations.flatMap((operation) =>
        operation.receiverAccess === 'Unavailable' ||
        operation.declaration.name._tag !== 'Present' ||
        operation.declaration.state._tag !== 'Unique' ||
        claimed.has(operation.declaration.name.spelling)
          ? []
          : [{ label: operation.declaration.name.spelling, operation }],
      )
    },
  )
  return supplied.flatMap(({ label, operation }) =>
    supplied.filter((other) => other.label === label).length > 1 ||
    operation.declaration.state._tag !== 'Unique'
      ? []
      : [
          candidate({
            identity: semantic({
              _tag: 'ServiceOperationIdentity',
              id: operation.declaration.state.id,
            }),
            kind: 'Method',
            label,
            detail: SemanticDisplay.receiverOperation(operation),
            sortGroup: 1,
          }),
        ],
  )
}

/** The receiver operations a generic value obtains from its parameter's declared bounds. */
const boundOperationCandidates = (
  fn: Elaboration.CheckedBody | undefined,
  type: Type.Parameter | undefined,
): ReadonlyArray<Candidate> => {
  if (fn === undefined || type === undefined) return []
  const parameter = fn.declaration.typeParameters.find((candidate) =>
    Type.equals(candidate.type, type),
  )
  if (parameter === undefined) return []
  return parameter.bounds.flatMap((bound) =>
    bound._tag !== 'ResolvedBound'
      ? []
      : bound.application.operations.flatMap((operation) =>
          operation.receiverAccess === 'Unavailable' ||
          operation.declaration.name._tag !== 'Present' ||
          operation.declaration.state._tag !== 'Unique'
            ? []
            : [
                candidate({
                  identity: semantic({
                    _tag: 'ServiceOperationIdentity',
                    id: operation.declaration.state.id,
                  }),
                  kind: 'Method',
                  label: operation.declaration.name.spelling,
                  detail: SemanticDisplay.receiverOperation(operation),
                  sortGroup: 1,
                }),
              ],
        ),
  )
}

const fieldCandidates = (
  index: DeclarationIndex.Index,
  type: Type.Nominal | undefined,
  module: string,
): ReadonlyArray<Candidate> => {
  if (type === undefined) return []
  const resolved = DeclarationFacts.byCanonical(index, {
    _tag: 'CanonicalDeclarationId',
    module: type.module,
    name: type.name,
  })
  const declaration = resolved?._tag === 'StructDeclaration' ? resolved : undefined
  return (declaration?.fields ?? []).flatMap((field) =>
    field.name._tag !== 'Present' || (field.visibility === 'Private' && type.module !== module)
      ? []
      : [
          candidate({
            identity: semantic({ _tag: 'FieldIdentity', id: field.id }),
            kind: 'Field',
            label: field.name.spelling,
            detail: SemanticDisplay.field(field),
            sortGroup: 0,
          }),
        ],
  )
}

const typeCandidates = (
  module: string,
  index: DeclarationIndex.Index,
  scope: NameResolution.ModuleScope | undefined,
  fn: Elaboration.CheckedBody | undefined,
): ReadonlyArray<Candidate> => {
  const candidates: Array<Candidate> = [
    candidate({
      identity: syntax('Effect'),
      kind: 'Type',
      label: 'Effect',
      detail: {
        _tag: 'IntrinsicActorPresentation',
        name: 'Effect',
        text: 'builtin type Effect<A ! E ? R>',
      },
      sortGroup: 1,
    }),
  ]
  for (const scalar of Scalar.all())
    candidates.push(
      candidate({
        identity: syntax(scalar.spelling),
        kind: 'Type',
        label: scalar.spelling,
        detail: {
          _tag: 'IntrinsicActorPresentation',
          name: scalar.spelling,
          text: `builtin type ${scalar.spelling}`,
        },
        sortGroup: 1,
      }),
    )
  for (const actor of Intrinsic.all())
    if (actor.kind === 'Type')
      candidates.push(
        candidate({
          identity: semantic({ _tag: 'IntrinsicActorIdentity', id: actor.id }),
          kind: 'Type',
          label: actor.spelling,
          detail: SemanticDisplay.intrinsicActor(actor),
          sortGroup: 1,
        }),
      )
  for (const declaration of [
    ...(index.modules.find((headers) => headers.module === module)?.structs ?? []),
    ...(index.modules.find((headers) => headers.module === module)?.unions ?? []),
    ...(index.modules.find((headers) => headers.module === module)?.enums ?? []),
    ...(index.modules.find((headers) => headers.module === module)?.services ?? []),
    ...(index.modules.find((headers) => headers.module === module)?.interfaces ?? []),
    ...(index.modules
      .find((headers) => headers.module === module)
      ?.members.filter(
        (member): member is DeclarationFacts.AliasFact => member._tag === 'AliasDeclaration',
      ) ?? []),
  ])
    if (declaration.name._tag === 'Present')
      candidates.push(
        candidate({
          identity: semantic(declarationIdentity(declaration)),
          kind: 'Type',
          label: declaration.name.spelling,
          detail: declarationDetail(declaration),
          sortGroup: 0,
        }),
      )
  for (const parameter of fn?.declaration.typeParameters ?? [])
    if (parameter.name._tag === 'Present')
      candidates.push(
        candidate({
          identity: semantic({ _tag: 'TypeParameterIdentity', id: parameter.type }),
          kind: 'Type',
          label: parameter.name.spelling,
          detail: SemanticDisplay.typeParameter(parameter),
          sortGroup: 0,
        }),
      )
  for (const binding of scope?.bindings ?? []) {
    if (binding._tag !== 'ImportedMember') continue
    const declaration = DeclarationFacts.byCanonical(index, binding.declaration)
    if (
      declaration?._tag !== 'StructDeclaration' &&
      declaration?._tag !== 'UnionDeclaration' &&
      declaration?._tag !== 'EnumDeclaration' &&
      declaration?._tag !== 'ServiceDeclaration' &&
      declaration?._tag !== 'InterfaceDeclaration' &&
      declaration?._tag !== 'AliasDeclaration'
    )
      continue
    candidates.push(
      candidate({
        identity: semantic(declarationIdentity(declaration)),
        kind: 'Type',
        label: binding.spelling,
        detail: declarationDetail(declaration),
        sortGroup: 2,
      }),
    )
  }
  return candidates
}

const expressionCandidates = (
  context: SemanticContext.SemanticContext,
  module: string,
  index: DeclarationIndex.Index,
  scope: NameResolution.ModuleScope | undefined,
  result: Elaboration.Result,
  fn: Elaboration.CheckedBody | undefined,
  offset: number,
): ReadonlyArray<Candidate> => {
  const candidates: Array<Candidate> = []
  for (const binding of visibleBindings(context, result, fn, offset))
    if (binding.name._tag === 'Present')
      candidates.push(
        candidate(
          (() => {
            const detail = SemanticDisplay.binding(binding, module, scope)
            return {
              identity: semantic({ _tag: 'BindingIdentity', id: binding.id }),
              kind: 'Binding',
              label: binding.name.spelling,
              ...(detail === undefined ? {} : { detail }),
              sortGroup: 0,
            }
          })(),
        ),
      )
  for (const binding of visiblePatternBindings(context, result, fn, offset))
    if (binding.name._tag === 'Present') {
      const detail = SemanticDisplay.patternBinding(binding, module, scope)
      candidates.push(
        candidate({
          identity: semantic({ _tag: 'PatternBindingIdentity', id: binding.id }),
          kind: 'Binding',
          label: binding.name.spelling,
          ...(detail === undefined ? {} : { detail }),
          sortGroup: 0,
        }),
      )
    }
  for (const parameter of fn?.declaration.parameters ?? [])
    if (parameter.name._tag === 'Present')
      candidates.push(
        candidate({
          identity: semantic({ _tag: 'ParameterIdentity', id: parameter.id }),
          kind: 'Parameter',
          label: parameter.name.spelling,
          detail: SemanticDisplay.parameter(parameter),
          sortGroup: 1,
        }),
      )
  for (const declaration of index.modules.find((headers) => headers.module === module)?.members ??
    [])
    if (declaration.name._tag === 'Present')
      candidates.push(
        candidate({
          identity: semantic(declarationIdentity(declaration)),
          kind: declarationKind(declaration, 'Constructor'),
          label: declaration.name.spelling,
          detail: declarationDetail(declaration),
          sortGroup: 2,
        }),
      )
  for (const binding of scope?.bindings ?? []) {
    if (binding._tag === 'ImportedMember') {
      const declaration = DeclarationFacts.byCanonical(index, binding.declaration)
      if (declaration === undefined) continue
      candidates.push(
        candidate({
          identity: semantic(declarationIdentity(declaration)),
          kind: declarationKind(declaration, 'Constructor'),
          label: binding.spelling,
          detail: declarationDetail(declaration),
          sortGroup: 3,
        }),
      )
    } else if (binding._tag === 'ModuleNamespace')
      candidates.push(
        candidate({
          identity: semantic({
            _tag: 'ImportNamespaceIdentity',
            module: binding.module,
            spelling: binding.spelling,
          }),
          kind: 'Actor',
          label: binding.spelling,
          detail: SemanticDisplay.importBinding(binding.spelling, binding.module),
          sortGroup: 3,
        }),
      )
  }
  for (const actor of Intrinsic.all())
    candidates.push(
      candidate({
        identity: semantic({ _tag: 'IntrinsicActorIdentity', id: actor.id }),
        kind: actor.kind === 'Type' ? 'Constructor' : 'Actor',
        label: actor.spelling,
        detail: SemanticDisplay.intrinsicActor(actor),
        sortGroup: 4,
      }),
    )
  for (const keyword of ['true', 'false', 'effect', 'fn', 'move', 'run', 'match'])
    candidates.push(
      candidate({ identity: syntax(keyword), kind: 'Keyword', label: keyword, sortGroup: 5 }),
    )
  return candidates
}

const candidateKey = (self: Candidate): string =>
  self.identity._tag === 'SyntaxCandidate'
    ? `syntax:${self.identity.spelling}`
    : (() => {
        const identity = self.identity.identity
        if (identity._tag === 'DeclarationIdentity')
          return identity.id._tag === 'CanonicalDeclarationId'
            ? `declaration:${identity.id.module}.${identity.id.name}`
            : `declaration:${identity.id.sourceId}:${identity.id.ordinal}`
        if (identity._tag === 'IntrinsicActorIdentity') return `actor:${identity.id.name}`
        if (identity._tag === 'IntrinsicOperationIdentity')
          return `operation:${identity.id.actor}.${identity.id.name}`
        return `${identity._tag}:${self.label}`
      })()

const stable = (inputs: ReadonlyArray<Candidate>): ReadonlyArray<Candidate> => {
  const unique = new Map<string, Candidate>()
  for (const input of inputs)
    if (!unique.has(candidateKey(input))) unique.set(candidateKey(input), input)
  return [...unique.values()].sort(
    (left, right) =>
      left.sortGroup - right.sortGroup ||
      compareText(left.kind, right.kind) ||
      compareText(left.label, right.label),
  )
}

/** Computes recovery-aware semantic completion from one exact source snapshot and byte offset. */
export const complete = (options: {
  readonly source: SourceFile.SourceFile
  readonly module: string
  readonly offset: number
  readonly index: DeclarationIndex.Index
  readonly resolution: NameResolution.Resolution
  readonly session: Semantic.Session
  readonly result: Elaboration.Result
}): Result => {
  const context = SemanticContext.make(options.result.authored)
  const replacement = replacementSpan(options.source, options.offset)
  const bytes = SourceFile.toUint8Array(options.source)
  const before = decoder.decode(bytes.subarray(0, replacement.start))
  const scope = NameResolution.scopeOf(options.resolution, options.module)
  const fn = enclosingFunction(context, options.result, options.offset)
  const memberMatch = before.match(/([A-Za-z_][A-Za-z0-9_]*)\.\s*$/)
  if (memberMatch !== null) {
    const qualifier = memberMatch[1]
    const value =
      qualifier === undefined
        ? { found: false }
        : valueLookup(context, qualifier, options.result, fn, options.offset)
    if (value.found) {
      const subject = nominalSubject(value.type)
      const parameterSubject = parameterSubjectOf(value.type)
      const inherent = receiverMethodCandidates(
        options.session,
        options.index,
        subject,
        options.module,
        scope,
      )
      return {
        _tag: 'CompletionResult',
        context: {
          _tag: 'ValueMemberContext',
          state:
            subject === undefined && parameterSubject === undefined ? 'Unavailable' : 'Available',
        },
        replacement: replacement.span,
        candidates: stable([
          ...fieldCandidates(options.index, subject, options.module),
          ...inherent,
          ...suppliedOperationCandidates(options.index, subject, options.module, inherent),
          ...boundOperationCandidates(fn, parameterSubject),
        ]),
      }
    }
    const lookup =
      qualifier === undefined || scope === undefined
        ? undefined
        : Semantic.resolveName(options.session, scope, qualifier)
    if (lookup?._tag === 'Intrinsic') {
      const intrinsic = Intrinsic.findActor(lookup.actor)
      if (intrinsic !== undefined)
        return {
          _tag: 'CompletionResult',
          context: { _tag: 'ActorMemberContext', actor: intrinsic.spelling },
          replacement: replacement.span,
          candidates: stable([...actorCandidates(intrinsic)]),
        }
    }
    if (lookup?._tag === 'Namespace')
      return {
        _tag: 'CompletionResult',
        context: { _tag: 'ActorMemberContext', actor: lookup.module },
        replacement: replacement.span,
        candidates: stable(namespaceCandidates(options.index, lookup.module)),
      }
    // Declared inherent members are the only associated candidates of a nominal qualifier.
    const inherent =
      lookup?._tag === 'Resolved'
        ? inherentCandidates(
            options.session,
            options.index,
            NameResolution.erasedOwner(options.index, lookup.declaration),
            options.module,
          )
        : []
    // A transparent alias qualifier offers the aliased owner's members and nothing of its own.
    if (
      lookup?._tag === 'Resolved' &&
      lookup.declaration._tag === 'AliasDeclaration' &&
      inherent.length > 0
    )
      return {
        _tag: 'CompletionResult',
        context: { _tag: 'ActorMemberContext', actor: lookup.spelling },
        replacement: replacement.span,
        candidates: stable(inherent),
      }
    if (lookup?._tag === 'Resolved' && lookup.declaration._tag === 'EnumDeclaration')
      return {
        _tag: 'CompletionResult',
        context: {
          _tag: 'ActorMemberContext',
          actor:
            lookup.declaration.name._tag === 'Present'
              ? lookup.declaration.name.spelling
              : (qualifier ?? 'enum'),
        },
        replacement: replacement.span,
        candidates: stable([...enumCandidates(lookup.declaration), ...inherent]),
      }
    if (lookup?._tag === 'Resolved' && lookup.declaration._tag === 'UnionDeclaration') {
      return {
        _tag: 'CompletionResult',
        context: {
          _tag: 'ActorMemberContext',
          actor:
            lookup.declaration.name._tag === 'Present'
              ? lookup.declaration.name.spelling
              : (qualifier ?? 'union'),
        },
        replacement: replacement.span,
        candidates: stable([...unionCandidates(lookup.declaration), ...inherent]),
      }
    }
    if (
      lookup?._tag === 'Resolved' &&
      (lookup.declaration._tag === 'StructDeclaration' ||
        lookup.declaration._tag === 'InterfaceDeclaration') &&
      lookup.declaration.canonical._tag === 'Canonical'
    ) {
      return {
        _tag: 'CompletionResult',
        context: {
          _tag: 'ActorMemberContext',
          actor: lookup.declaration.canonical.id.name,
        },
        replacement: replacement.span,
        candidates: stable(inherent),
      }
    }
    if (lookup?._tag === 'Resolved' && lookup.declaration._tag === 'ServiceDeclaration') {
      return {
        _tag: 'CompletionResult',
        context: {
          _tag: 'ActorMemberContext',
          actor:
            lookup.declaration.name._tag === 'Present'
              ? lookup.declaration.name.spelling
              : (qualifier ?? 'service'),
        },
        replacement: replacement.span,
        candidates: stable([...serviceCandidates(lookup.declaration), ...inherent]),
      }
    }
    let state: 'Ambiguous' | 'Missing' | 'Unavailable'
    if (lookup?._tag === 'Conflict') state = 'Ambiguous'
    else if (lookup?._tag === 'Missing' || lookup === undefined) state = 'Missing'
    else state = 'Unavailable'
    return {
      _tag: 'CompletionResult',
      context: {
        _tag: 'ValueMemberContext',
        state,
      },
      replacement: replacement.span,
      candidates: [],
    }
  }
  const tail = before.slice(Math.max(0, before.lastIndexOf('\n')))
  const typeArgument = /<[^>]*$/.test(tail)
  const declaredType = /(?::|->)\s*[A-Za-z0-9_.]*$/.test(tail)
  if (typeArgument || declaredType)
    return {
      _tag: 'CompletionResult',
      context: {
        _tag: typeArgument ? 'TypeArgumentContext' : 'DeclaredTypeContext',
      },
      replacement: replacement.span,
      candidates: stable(typeCandidates(options.module, options.index, scope, fn)),
    }
  return {
    _tag: 'CompletionResult',
    context: { _tag: 'ExpressionContext' },
    replacement: replacement.span,
    candidates: stable([
      ...expressionCandidates(
        context,
        options.module,
        options.index,
        scope,
        options.result,
        fn,
        options.offset,
      ),
      ...(/\beffect\s*$/.test(before)
        ? [candidate({ identity: syntax('{'), kind: 'Keyword', label: '{', sortGroup: 5 })]
        : []),
    ]),
  }
}
