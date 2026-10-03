import type * as AuthoredHir from './AuthoredHir.js'
import * as AuthoredIdentity from './AuthoredIdentity.js'
import type * as AuthoredLowering from './AuthoredLowering.js'
import * as BodyQuery from './BodyQuery.js'
import * as CompilerTrace from './CompilerTrace.js'
import * as DeclarationFacts from './DeclarationFacts.js'
import type * as DeclarationIndex from './DeclarationIndex.js'
import * as Elaboration from './Elaboration.js'
import * as Evaluation from './Evaluation.js'
import type * as ExpressionAnalysis from './ExpressionAnalysis.js'
import * as ModuleSurface from './ModuleSurface.js'
import * as NameResolution from './NameResolution.js'
import type * as Ownership from './Ownership.js'
import * as SemanticContext from './SemanticContext.js'
import * as SemanticQuery from './SemanticQuery.js'
import * as SourceSpan from './SourceSpan.js'
import * as StatementAnalysis from './StatementAnalysis.js'
import * as ToolchainIntegrity from './ToolchainIntegrity.js'

/** The sealed semantic reader for one immutable current closure and selection. */
export interface Session {
  readonly _tag: 'SemanticSession'
  readonly epoch: string
  readonly configuration: string
  readonly index: DeclarationIndex.Index
  readonly resolution: NameResolution.Resolution
  /**
   * Whether checked bodies publish their editor-only results (name occurrences, inferred-type
   * hints, lexical scopes, expression types). A build session leaves them out.
   */
  readonly tooling: boolean
  readonly queries: SemanticQuery.Session
}

interface RecordedEvaluation<A> {
  readonly entry: Evaluation.CacheEntry<A>
  readonly result: Evaluation.ApplicationResult<A>
  readonly reusable: boolean
}

/** A body input fingerprint derived once, when revision validation or persistence first reads it. */
type Fingerprint = () => string

const derivedOnce = (compute: () => string): Fingerprint => {
  let value: string | undefined
  return () => (value ??= compute())
}

interface Runtime {
  readonly bodies: Map<
    string,
    {
      readonly header: Fingerprint
      readonly implementation: Fingerprint
      readonly scope: Fingerprint
      readonly build?: () => Elaboration.CheckedUnit
    }
  >
  readonly ownership: Map<
    string,
    {
      readonly boundary: string
      readonly build?: () => Ownership.CheckedFunction
    }
  >
  readonly evaluations: Map<
    string,
    {
      readonly policy: string
      readonly execute?: () => RecordedEvaluation<unknown>
    }
  >
  readonly presentations: Map<string, unknown>
  conformanceCandidatesFingerprint?: string
  queries?: SemanticQuery.Session
}

const runtimes = new WeakMap<Session, Runtime>()
const schema = 1

const descriptor = (
  family: string,
  address: ReadonlyArray<string>,
  reuse: SemanticQuery.Descriptor['reuse'] = 'Revision',
): SemanticQuery.Descriptor => ({
  _tag: 'SemanticQueryDescriptor',
  family,
  schema,
  address: JSON.stringify(address),
  reuse,
})

/** Stable semantic-query address for one declaration's complete checked unit. */
export const checkBodyDescriptor = (
  declaration: DeclarationFacts.DeclarationFact,
): SemanticQuery.Descriptor => descriptor('CheckBody', [BodyQuery.identity(declaration)])

const input = (family: string, address: ReadonlyArray<string>): SemanticQuery.InputAddress => ({
  _tag: 'SemanticInputAddress',
  family,
  schema,
  address: JSON.stringify(address),
})

const partsOf = (address: string): ReadonlyArray<string> => {
  const value: unknown = JSON.parse(address)
  return Array.isArray(value) && value.every((part): part is string => typeof part === 'string')
    ? value
    : []
}

const runtimeOf = (self: Session): Runtime => {
  const runtime = runtimes.get(self)
  if (runtime === undefined) throw new RangeError('Unknown semantic session')
  return runtime
}

const stableJson = (value: unknown): string =>
  JSON.stringify(value, (_key, child: unknown) => {
    if (SourceSpan.isSourceSpan(child)) return undefined
    if (typeof child === 'bigint') return child.toString() + 'n'
    if (child instanceof Map)
      return [...child].sort(([left], [right]) => String(left).localeCompare(String(right)))
    if (child instanceof Set)
      return [...child].sort((left, right) => String(left).localeCompare(String(right)))
    return child
  })

// Boundary spans are presentation data; semantic identity depends only on the row shape.
const boundaryFingerprint = (boundaries: ReadonlyArray<SourceSpan.SourceSpan>): string =>
  String(boundaries.length)

const declarationKey = (id: DeclarationFacts.CanonicalId): string => id.module + '.' + id.name

const bindingKey = (binding: NameResolution.Binding): string => {
  switch (binding._tag) {
    case 'IntrinsicActor':
      return 'intrinsic:' + binding.spelling
    case 'ModuleNamespace':
      return 'module:' + binding.module
    case 'LocalDeclaration':
    case 'ImportedMember':
      return 'declaration:' + declarationKey(binding.declaration)
    case 'Unavailable':
      return 'unavailable:' + binding.spelling
  }
}

const memberKey = (member: DeclarationFacts.MemberFact): string =>
  member.canonical._tag === 'Canonical'
    ? declarationKey(member.canonical.id)
    : member._tag + ':' + member.id.sourceId + ':' + member.id.ordinal

const memberProjection = (member: DeclarationFacts.MemberFact): string =>
  JSON.stringify([memberKey(member), ModuleSurface.memberSignature(member)])

const lookupProjection = (lookup: NameResolution.Lookup): string => {
  switch (lookup._tag) {
    case 'Resolved':
      return JSON.stringify([lookup._tag, lookup.spelling, memberProjection(lookup.declaration)])
    case 'EnumMember':
      return JSON.stringify([
        lookup._tag,
        lookup.spelling,
        memberProjection(lookup.enum),
        lookup.member.name._tag === 'Present' ? lookup.member.name.spelling : '',
      ])
    case 'Intrinsic':
      return JSON.stringify([lookup._tag, lookup.spelling, lookup.actor])
    case 'Namespace':
      return JSON.stringify([lookup._tag, lookup.spelling, lookup.module])
    case 'Missing':
      return JSON.stringify([lookup._tag, lookup.spelling])
    case 'Inaccessible':
      return JSON.stringify([lookup._tag, lookup.spelling, memberProjection(lookup.declaration)])
    case 'Conflict':
      return JSON.stringify([
        lookup._tag,
        lookup.spelling,
        lookup.conflict.bindings.map(bindingKey),
      ])
    case 'Unavailable':
      return JSON.stringify([
        lookup._tag,
        lookup.spelling,
        lookup.declaration === undefined ? '' : memberProjection(lookup.declaration),
      ])
  }
}

const associatedProjection = (lookup: NameResolution.AssociatedLookup): string => {
  switch (lookup._tag) {
    case 'Inherent':
    case 'Inaccessible':
      return JSON.stringify([lookup._tag, memberProjection(lookup.declaration)])
    case 'Duplicate':
    case 'Missing':
      return JSON.stringify([lookup._tag])
  }
}

const scopeOf = (
  resolution: NameResolution.Resolution,
  module: string,
): NameResolution.ModuleScope | undefined => NameResolution.scopeOf(resolution, module)

const namespaceFingerprint = (
  resolution: NameResolution.Resolution,
  module: string,
  spelling: string,
): string | undefined => {
  const scope = scopeOf(resolution, module)
  if (scope === undefined) return undefined
  return JSON.stringify([
    ...scope.bindings.filter((binding) => binding.spelling === spelling).map(bindingKey),
    ...scope.conflicts
      .filter((conflict) => conflict.spelling === spelling)
      .flatMap((conflict) => conflict.bindings.map(bindingKey)),
  ])
}

const importSelectionFingerprint = (
  resolution: NameResolution.Resolution,
  module: string,
  spelling: string,
): string | undefined => {
  const selected = scopeOf(resolution, module)?.bindings.find(
    (binding) => binding.spelling === spelling,
  )
  return selected === undefined ? undefined : bindingKey(selected)
}

const headerFingerprint = (
  index: DeclarationIndex.Index,
  module: string,
  name: string,
): string | undefined => {
  const member = DeclarationFacts.byCanonical(index, {
    _tag: 'CanonicalDeclarationId',
    module,
    name,
  })
  return member === undefined ? undefined : memberProjection(member)
}

const associatedCandidatesFingerprint = (
  index: DeclarationIndex.Index,
  ownerModule: string,
  ownerName: string,
  memberName: string,
): string =>
  JSON.stringify(
    (
      index.modules
        .find((module) => module.module === ownerModule)
        ?.declarations.filter(
          (candidate) =>
            candidate.associatedMember?.name === memberName &&
            (candidate.associatedMember.owner?.name ?? candidate.associatedMember.ownerSpelling) ===
              ownerName,
        )
        .map(memberProjection) ?? []
    ).sort(),
  )

// Header and scope inputs derive from this session's immutable index and resolution, and a body's
// fingerprints from its registered inputs, so each derivation is deferred until a revision
// validation or persistence reads it.
const readInput = (
  index: DeclarationIndex.Index,
  resolution: NameResolution.Resolution,
  configuration: string,
  runtime: Runtime,
  address: SemanticQuery.InputAddress,
): SemanticQuery.InputFingerprint => {
  const parts = partsOf(address.address)
  switch (address.family) {
    case 'Configuration':
      return parts[0] === 'semantic-session' ? configuration : undefined
    case 'Namespace':
      return () => namespaceFingerprint(resolution, parts[0] ?? '', parts[1] ?? '')
    case 'ImportSelection':
      return () => importSelectionFingerprint(resolution, parts[0] ?? '', parts[1] ?? '')
    case 'Header':
    case 'Alias':
    case 'Bound':
      return () => headerFingerprint(index, parts[0] ?? '', parts[1] ?? '')
    case 'AssociatedCandidates':
      return () =>
        associatedCandidatesFingerprint(index, parts[0] ?? '', parts[1] ?? '', parts[2] ?? '')
    case 'ConformanceCandidates':
      return () =>
        (runtime.conformanceCandidatesFingerprint ??= ToolchainIntegrity.contentDigest(
          ModuleSurface.resolutionSignature(index),
        ))
    case 'BodyHeader':
      return runtime.bodies.get(parts[0] ?? '')?.header
    case 'BodyImplementation':
      return runtime.bodies.get(parts[0] ?? '')?.implementation
    case 'BodyScope':
      return runtime.bodies.get(parts[0] ?? '')?.scope
    case 'OwnershipBoundary':
      return runtime.ownership.get(parts[0] ?? '')?.boundary
    case 'EvaluationPolicy':
      return runtime.evaluations.get(parts[0] ?? '')?.policy
  }
}

const observeConfiguration = (observe: SemanticQuery.Observe): void =>
  observe(input('Configuration', ['semantic-session']))

const observeLookup = (
  scope: NameResolution.ModuleScope,
  spelling: string,
  result: NameResolution.Lookup,
  observe: SemanticQuery.Observe,
): void => {
  observeConfiguration(observe)
  observe(input('Namespace', [scope.module, spelling]))
  const binding = scope.bindings.find((candidate) => candidate.spelling === spelling)
  if (binding?._tag === 'ImportedMember' || binding?._tag === 'ModuleNamespace')
    observe(input('ImportSelection', [scope.module, spelling]))
  if (result._tag === 'Resolved' && result.declaration.canonical._tag === 'Canonical')
    observe(
      input('Header', [
        result.declaration.canonical.id.module,
        result.declaration.canonical.id.name,
      ]),
    )
}

const nameDescriptor = (module: string, spelling: string): SemanticQuery.Descriptor =>
  descriptor('ResolveName', [module, spelling])

const qualifiedDescriptor = (
  module: string,
  namespace: string,
  member: string,
): SemanticQuery.Descriptor => descriptor('ResolveQualifiedName', [module, namespace, member])

const associatedDescriptor = (
  ownerModule: string,
  ownerName: string,
  member: string,
  requestingModule: string,
): SemanticQuery.Descriptor =>
  descriptor('ResolveAssociatedName', [ownerModule, ownerName, member, requestingModule])

const typeDescriptor = (declaration: DeclarationFacts.CanonicalId): SemanticQuery.Descriptor =>
  descriptor('TypeOf', [declaration.module, declaration.name])

const qualifiedProjection = (
  index: DeclarationIndex.Index,
  resolution: NameResolution.Resolution,
  module: string,
  namespace: string,
  member: string,
): string => {
  const scope = scopeOf(resolution, module)
  if (scope === undefined) return JSON.stringify(['MissingScope', module])
  const qualifier = NameResolution.lookup(scope, index, namespace)
  if (
    qualifier._tag === 'Intrinsic' ||
    qualifier._tag === 'Conflict' ||
    qualifier._tag === 'Missing'
  )
    return lookupProjection(qualifier)
  if (qualifier._tag === 'Resolved') {
    const associated = NameResolution.lookupAssociated(
      index,
      qualifier.declaration,
      member,
      scope.module,
    )
    if (associated._tag !== 'Missing') return associatedProjection(associated)
    if (qualifier.declaration._tag === 'EnumDeclaration') {
      const selected = DeclarationFacts.lookupEnumMember(qualifier.declaration.members, member)
      return selected._tag === 'Resolved'
        ? JSON.stringify([
            'EnumMember',
            memberProjection(qualifier.declaration),
            selected.member.name._tag === 'Present' ? selected.member.name.spelling : '',
          ])
        : JSON.stringify(['UnknownEnumMember', memberProjection(qualifier.declaration), member])
    }
  }
  if (qualifier._tag !== 'Namespace') return JSON.stringify(['Missing', namespace + '.' + member])
  const found = DeclarationFacts.byCanonical(index, {
    _tag: 'CanonicalDeclarationId',
    module: qualifier.module,
    name: member,
  })
  return found === undefined
    ? JSON.stringify(['MissingMember', qualifier.module, member])
    : JSON.stringify([
        found.visibility === 'Private' ? 'Inaccessible' : 'Resolved',
        memberProjection(found),
      ])
}

const makeProvider = (
  index: DeclarationIndex.Index,
  resolution: NameResolution.Resolution,
  configuration: string,
  runtime: Runtime,
): SemanticQuery.Provider => ({
  cacheable: (request, answer) =>
    request.family !== 'Evaluate' && request.family !== 'ConstructResidual'
      ? true
      : (answer as RecordedEvaluation<unknown>).reusable,
  available: (request) => {
    switch (request.family) {
      case 'CheckBody':
        return runtime.bodies.has(request.address)
      case 'Ownership':
        return runtime.ownership.has(request.address)
      case 'Evaluate':
      case 'ConstructResidual':
        return runtime.evaluations.has(request.address)
      default:
        return true
    }
  },
  execute: (request, observe) => {
    const parts = partsOf(request.address)
    switch (request.family) {
      case 'ResolveName': {
        const module = parts[0] ?? ''
        const spelling = parts[1] ?? ''
        const scope = scopeOf(resolution, module)
        if (scope === undefined) return JSON.stringify(['MissingScope', module])
        const result = NameResolution.lookup(scope, index, spelling)
        observeLookup(scope, spelling, result, observe)
        return lookupProjection(result)
      }
      case 'ResolveQualifiedName': {
        const module = parts[0] ?? ''
        const namespace = parts[1] ?? ''
        const member = parts[2] ?? ''
        const queries = runtime.queries
        if (queries === undefined)
          throw new RangeError('Semantic query provider is not initialized')
        SemanticQuery.query<string>(queries, nameDescriptor(module, namespace))
        observeConfiguration(observe)
        observe(input('Namespace', [module, namespace]))
        observe(input('ImportSelection', [module, namespace]))
        const scope = scopeOf(resolution, module)
        const qualifier =
          scope === undefined ? undefined : NameResolution.lookup(scope, index, namespace)
        if (
          qualifier?._tag === 'Resolved' &&
          qualifier.declaration.canonical._tag === 'Canonical'
        ) {
          observe(
            input('Header', [
              qualifier.declaration.canonical.id.module,
              qualifier.declaration.canonical.id.name,
            ]),
          )
          observe(
            input('AssociatedCandidates', [
              qualifier.declaration.canonical.id.module,
              qualifier.declaration.canonical.id.name,
              member,
            ]),
          )
        }
        if (qualifier?._tag === 'Namespace') observe(input('Header', [qualifier.module, member]))
        return qualifiedProjection(index, resolution, module, namespace, member)
      }
      case 'ResolveAssociatedName': {
        const ownerModule = parts[0] ?? ''
        const ownerName = parts[1] ?? ''
        const member = parts[2] ?? ''
        const requestingModule = parts[3] ?? ''
        observeConfiguration(observe)
        observe(input('Header', [ownerModule, ownerName]))
        observe(input('AssociatedCandidates', [ownerModule, ownerName, member]))
        const owner = DeclarationFacts.byCanonical(index, {
          _tag: 'CanonicalDeclarationId',
          module: ownerModule,
          name: ownerName,
        })
        return owner === undefined
          ? JSON.stringify(['MissingOwner'])
          : associatedProjection(
              NameResolution.lookupAssociated(index, owner, member, requestingModule),
            )
      }
      case 'TypeOf': {
        const module = parts[0] ?? ''
        const name = parts[1] ?? ''
        observeConfiguration(observe)
        observe(input('Header', [module, name]))
        const fact = DeclarationFacts.byCanonical(index, {
          _tag: 'CanonicalDeclarationId',
          module,
          name,
        })
        if (fact?._tag === 'AliasDeclaration') observe(input('Alias', [module, name]))
        observe(input('ConformanceCandidates', [module]))
        return fact === undefined
          ? JSON.stringify(['Unavailable', module, name])
          : memberProjection(fact)
      }
      case 'CheckBody': {
        const body = runtime.bodies.get(request.address)
        if (body?.build === undefined) throw new RangeError('Body provider is unavailable')
        observeConfiguration(observe)
        observe(input('BodyHeader', [request.address]))
        observe(input('BodyImplementation', [request.address]))
        observe(input('BodyScope', [request.address]))
        return body.build()
      }
      case 'Ownership': {
        const ownership = runtime.ownership.get(request.address)
        if (ownership?.build === undefined)
          throw new RangeError('Ownership provider is unavailable')
        const identity = parts[0] ?? ''
        const queries = runtime.queries
        if (queries === undefined)
          throw new RangeError('Semantic query provider is not initialized')
        SemanticQuery.query<Elaboration.CheckedUnit>(queries, descriptor('CheckBody', [identity]))
        observeConfiguration(observe)
        observe(input('ConformanceCandidates', [identity]))
        observe(input('OwnershipBoundary', [request.address]))
        return ownership.build()
      }
      case 'Evaluate':
      case 'ConstructResidual': {
        const evaluation = runtime.evaluations.get(request.address)
        if (evaluation?.execute === undefined)
          throw new RangeError('Evaluation provider is unavailable')
        observeConfiguration(observe)
        observe(input('EvaluationPolicy', [request.address]))
        return evaluation.execute()
      }
      default:
        throw new RangeError('Unknown semantic query family ' + request.family)
    }
  },
  fingerprint: (request, answer, observations) => {
    if (typeof answer === 'string') return answer
    if (request.family === 'CheckBody')
      return BodyQuery.fingerprint(index, answer as Elaboration.CheckedUnit)
    if (request.family === 'Ownership')
      return ToolchainIntegrity.contentDigest(stableJson([request, observations]))
    if (request.family === 'Evaluate' || request.family === 'ConstructResidual')
      return ToolchainIntegrity.contentDigest(
        stableJson((answer as RecordedEvaluation<unknown>).entry.state),
      )
    return request.family + ':' + request.address
  },
  read: (address) => readInput(index, resolution, configuration, runtime, address),
})

export interface SessionOptions {
  /** The selection the session reads under; records from another configuration never validate. */
  readonly configuration?: string
  /** Reusable records of one prior revision. */
  readonly previous?: SemanticQuery.Snapshot
  /** Whether checked bodies publish their editor-only results. */
  readonly tooling?: boolean
}

/** Builds one current session and optionally admits records from one prior snapshot. */
export const makeSession = (
  epoch: string,
  index: DeclarationIndex.Index,
  resolution: NameResolution.Resolution,
  options: SessionOptions = {},
): Session => {
  const configuration = options.configuration ?? 'default'
  const tooling = options.tooling === true
  const runtime: Runtime = {
    bodies: new Map(),
    ownership: new Map(),
    evaluations: new Map(),
    presentations: new Map(),
  }
  const queries = SemanticQuery.make(
    epoch + '\u0000' + configuration,
    // A checked unit's tooling results depend on the session purpose, so it is configuration.
    makeProvider(index, resolution, tooling ? configuration + ':tooling' : configuration, runtime),
    options.previous,
  )
  runtime.queries = queries
  const session = {
    _tag: 'SemanticSession' as const,
    epoch,
    configuration,
    index,
    resolution,
    tooling,
    queries,
  }
  runtimes.set(session, runtime)
  return session
}

const presented = <A>(self: Session, key: string, make: () => A): A => {
  const runtime = runtimeOf(self)
  const known = runtime.presentations.get(key)
  if (known !== undefined) return known as A
  const value = make()
  runtime.presentations.set(key, value)
  return value
}

/** Resolves one name through the shared revision validator. */
export const resolveName = (
  self: Session,
  scope: NameResolution.ModuleScope,
  spelling: string,
): NameResolution.Lookup => {
  const request = nameDescriptor(scope.module, spelling)
  const result = SemanticQuery.query<string>(self.queries, request)
  if (result._tag === 'Cycle') return { _tag: 'Unavailable', spelling }
  return presented(self, SemanticQuery.keyOf(request), () =>
    NameResolution.lookup(scope, self.index, spelling),
  )
}

export const resolveNameFresh = (
  self: Session,
  scope: NameResolution.ModuleScope,
  spelling: string,
): NameResolution.Lookup => {
  const result = SemanticQuery.fresh<string>(self.queries, nameDescriptor(scope.module, spelling))
  return result._tag === 'Cycle'
    ? { _tag: 'Unavailable', spelling }
    : NameResolution.lookup(scope, self.index, spelling)
}

/** Resolves a qualified path while presenting caller diagnostics at the current anchor. */
export const resolveQualifiedName = (
  self: Session,
  scope: NameResolution.ModuleScope,
  namespace: string,
  member: string,
  anchor: AuthoredHir.Anchor,
): NameResolution.Lookup => {
  const request = qualifiedDescriptor(scope.module, namespace, member)
  const result = SemanticQuery.query<string>(self.queries, request)
  if (result._tag === 'Cycle') return { _tag: 'Unavailable', spelling: member }
  const presentationKey = SemanticQuery.keyOf(request) + ':' + AuthoredIdentity.anchorKey(anchor)
  return presented(self, presentationKey, () =>
    NameResolution.lookupQualified(scope, self.index, namespace, member, anchor),
  )
}

/** Resolves an inherent or contract-associated member through the shared validator. */
export const resolveAssociatedName = (
  self: Session,
  owner: DeclarationFacts.MemberFact,
  member: string,
  requestingModule: string,
): NameResolution.AssociatedLookup => {
  if (owner.canonical._tag !== 'Canonical')
    return NameResolution.lookupAssociated(self.index, owner, member, requestingModule)
  const request = associatedDescriptor(
    owner.canonical.id.module,
    owner.canonical.id.name,
    member,
    requestingModule,
  )
  const result = SemanticQuery.query<string>(self.queries, request)
  if (result._tag === 'Cycle') return { _tag: 'Missing' }
  return presented(self, SemanticQuery.keyOf(request), () =>
    NameResolution.lookupAssociated(self.index, owner, member, requestingModule),
  )
}

export type TypeOf =
  | { readonly _tag: 'Resolved'; readonly declaration: DeclarationFacts.MemberFact }
  | { readonly _tag: 'Unavailable'; readonly declaration: DeclarationFacts.CanonicalId }

export const typeOf = (self: Session, declaration: DeclarationFacts.CanonicalId): TypeOf => {
  const request = typeDescriptor(declaration)
  const result = SemanticQuery.query<string>(self.queries, request)
  if (result._tag === 'Cycle') return { _tag: 'Unavailable', declaration }
  return presented(self, SemanticQuery.keyOf(request), () => {
    const fact = DeclarationFacts.byCanonical(self.index, declaration)
    return fact === undefined
      ? { _tag: 'Unavailable' as const, declaration }
      : { _tag: 'Resolved' as const, declaration: fact }
  })
}

export const typeOfFresh = (self: Session, declaration: DeclarationFacts.CanonicalId): TypeOf => {
  const result = SemanticQuery.fresh<string>(self.queries, typeDescriptor(declaration))
  if (result._tag === 'Cycle') return { _tag: 'Unavailable', declaration }
  const fact = DeclarationFacts.byCanonical(self.index, declaration)
  return fact === undefined
    ? { _tag: 'Unavailable', declaration }
    : { _tag: 'Resolved', declaration: fact }
}

export const snapshot = (self: Session): SemanticQuery.Snapshot =>
  SemanticQuery.snapshot(self.queries)

export const queryCounters = (self: Session): SemanticQuery.Counters =>
  SemanticQuery.counters(self.queries)

export interface BodyInput {
  readonly query?: BodyQuery.BodyQuery
  readonly authored: AuthoredLowering.Lowered
  readonly headers: DeclarationFacts.ModuleHeaders
  readonly scope: NameResolution.ModuleScope
  readonly index: DeclarationIndex.Index
  readonly session: Session
  readonly declaration: DeclarationFacts.DeclarationFact
  readonly trace?: CompilerTrace.CompilerTrace
}

/** Checks or reuses one declaration body and returns its complete checked unit. */
export const checkBody = (bodyInput: BodyInput): Elaboration.CheckedUnit => {
  const trace = bodyInput.trace ?? CompilerTrace.none
  const context = SemanticContext.make(bodyInput.authored)
  const build = (): BodyQuery.Built => {
    const hiddenFunctions: Array<ExpressionAnalysis.FunctionAnalysis> = []
    const analysis = StatementAnalysis.analyzeFunctionBody(
      context,
      bodyInput.declaration,
      bodyInput.headers.declarations,
      {
        semantic: bodyInput.session,
        scope: bodyInput.scope,
        index: bodyInput.index,
        hiddenFunctions,
      },
    )
    const own = Elaboration.checkedBody(
      context,
      bodyInput.index,
      analysis.fact,
      undefined,
      undefined,
      analysis.builder,
    )
    return {
      unit: {
        bodies: [
          own,
          ...hiddenFunctions.map((hidden) =>
            Elaboration.checkedBody(
              context,
              bodyInput.index,
              hidden.fact,
              own.artifact,
              undefined,
              hidden.builder,
            ),
          ),
        ],
        diagnostics: analysis.diagnostics,
      },
    }
  }
  const request = checkBodyDescriptor(bodyInput.declaration)
  const runtime = runtimeOf(bodyInput.session)
  const provider = {
    header: derivedOnce(() => BodyQuery.headerFingerprint(bodyInput.index, bodyInput.declaration)),
    implementation: derivedOnce(() =>
      BodyQuery.implementationFingerprint(bodyInput.authored, bodyInput.declaration),
    ),
    scope: derivedOnce(() =>
      BodyQuery.scopeFingerprint(
        bodyInput.index,
        bodyInput.authored,
        bodyInput.declaration,
        bodyInput.scope,
      ),
    ),
    build: () =>
      bodyInput.query === undefined
        ? trace('Semantic.checkBody.execute', () => build().unit)
        : BodyQuery.check(
            bodyInput.query,
            context,
            bodyInput.authored,
            bodyInput.scope,
            bodyInput.declaration,
            build,
            trace,
          ),
  }
  runtime.bodies.set(request.address, provider)
  try {
    return trace(
      'Semantic.checkBody',
      () => {
        const result = SemanticQuery.query<Elaboration.CheckedUnit>(
          bodyInput.session.queries,
          request,
        )
        if (result._tag === 'Cycle')
          throw new RangeError('Recursive body query: ' + result.cycle.path.join(' -> '))
        return result.reused && bodyInput.query !== undefined
          ? BodyQuery.reuse(
              bodyInput.query,
              context,
              bodyInput.authored,
              bodyInput.declaration,
              result.completed.answer,
              trace,
            )
          : result.completed.answer
      },
      {
        module: bodyInput.declaration.owner.module,
        declaration: bodyInput.declaration.id.ordinal,
      },
    )
  } finally {
    if (runtime.bodies.get(request.address) === provider)
      runtime.bodies.set(request.address, {
        header: provider.header,
        implementation: provider.implementation,
        scope: provider.scope,
      })
  }
}

export const checkBodyFresh = (bodyInput: BodyInput): Elaboration.CheckedUnit => {
  const isolated = makeSession(
    bodyInput.session.epoch + ':fresh',
    bodyInput.session.index,
    bodyInput.session.resolution,
    { configuration: bodyInput.session.configuration, tooling: bodyInput.session.tooling },
  )
  const { query: _query, ...fresh } = bodyInput
  return checkBody({ ...fresh, session: isolated })
}

/** Derives ownership through the same revision validator as its checked-unit dependency. */
export const ownership = (
  self: Session,
  bodyQuery: BodyQuery.BodyQuery | undefined,
  ownershipInput: Ownership.CheckInput,
  compute: () => Ownership.CheckedFunction,
): Ownership.CheckedFunction => {
  const identity =
    bodyQuery === undefined
      ? BodyQuery.identity(ownershipInput.function.declaration)
      : BodyQuery.ownershipRootIdentity(bodyQuery, ownershipInput)
  const request = descriptor('Ownership', [
    identity,
    BodyQuery.identity(ownershipInput.function.declaration),
  ])
  const runtime = runtimeOf(self)
  const provider = {
    boundary: `${boundaryFingerprint(ownershipInput.boundaries)}:${boundaryFingerprint(
      ownershipInput.resultBoundaries,
    )}`,
    build: compute,
  }
  runtime.ownership.set(request.address, provider)
  try {
    const result = SemanticQuery.query<Ownership.CheckedFunction>(self.queries, request)
    if (result._tag === 'Cycle')
      throw new RangeError('Recursive ownership query: ' + result.cycle.path.join(' -> '))
    if (bodyQuery === undefined) return result.completed.answer
    const presented = BodyQuery.acceptOwnership(
      bodyQuery,
      ownershipInput,
      result.completed.answer,
      result.reused,
    )
    if (presented !== undefined) return presented
    const rebuilt = compute()
    return BodyQuery.acceptOwnership(bodyQuery, ownershipInput, rebuilt, false) ?? rebuilt
  } finally {
    if (runtime.ownership.get(request.address) === provider)
      runtime.ownership.set(request.address, { boundary: provider.boundary })
  }
}

const evaluateQuery = <A>(
  family: 'Evaluate' | 'ConstructResidual',
  self: Session,
  evaluation: Evaluation.Evaluation<A>,
  application: Evaluation.Application,
  parentTrace: Evaluation.Trace,
  callback: Evaluation.EvaluationCallback<A>,
): Evaluation.ApplicationResult<A> => {
  const key = Evaluation.applicationKey(evaluation.environment, application)
  const request = descriptor(family, [key, Evaluation.policyKey(evaluation)])
  const runtime = runtimeOf(self)
  const provider = {
    policy: Evaluation.policyKey(evaluation),
    execute: () => {
      const evaluated =
        parentTrace.length === 0
          ? Evaluation.evaluate(evaluation, application, callback)
          : Evaluation.evaluateFrom(evaluation, application, parentTrace, callback)
      const entry = Evaluation.cacheEntry(evaluation, evaluated.key)
      if (entry !== undefined) return { entry, result: evaluated, reusable: true }
      if (evaluated._tag === 'Complete')
        throw new RangeError('Completed evaluation did not publish its cache entry')
      return {
        entry: {
          key: evaluated.key,
          state: { _tag: 'Failed' as const, failure: evaluated.failure },
        },
        result: evaluated,
        reusable: false,
      }
    },
  }
  runtime.evaluations.set(request.address, provider)
  try {
    const result = SemanticQuery.query<RecordedEvaluation<A>>(self.queries, request)
    if (result._tag === 'Cycle') {
      const direct =
        parentTrace.length === 0
          ? Evaluation.evaluate(evaluation, application, callback)
          : Evaluation.evaluateFrom(evaluation, application, parentTrace, callback)
      return direct
    }
    return result.reused
      ? Evaluation.admit(evaluation, application, result.completed.answer.entry, parentTrace)
      : result.completed.answer.result
  } finally {
    if (runtime.evaluations.get(request.address) === provider)
      runtime.evaluations.set(request.address, { policy: provider.policy })
  }
}

/** Evaluates one static application through the shared revision validator. */
export const evaluate = <A>(
  self: Session,
  evaluation: Evaluation.Evaluation<A>,
  application: Evaluation.Application,
  callback: Evaluation.EvaluationCallback<A>,
): Evaluation.ApplicationResult<A> =>
  evaluateQuery('Evaluate', self, evaluation, application, [], callback)

export const evaluateFrom = <A>(
  self: Session,
  evaluation: Evaluation.Evaluation<A>,
  application: Evaluation.Application,
  parentTrace: Evaluation.Trace,
  callback: Evaluation.EvaluationCallback<A>,
): Evaluation.ApplicationResult<A> => {
  return evaluateQuery('Evaluate', self, evaluation, application, parentTrace, callback)
}

/** Constructs one residual application independently from pure static evaluation. */
export const constructResidual = <A>(
  self: Session,
  evaluation: Evaluation.Evaluation<A>,
  application: Evaluation.Application,
  callback: Evaluation.EvaluationCallback<A>,
): Evaluation.ApplicationResult<A> =>
  evaluateQuery('ConstructResidual', self, evaluation, application, [], callback)
