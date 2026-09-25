import * as ConfigurationValue from './ConfigurationValue.js'
import * as ConfigurationOrigin from './ConfigurationOrigin.js'
import type * as PackageConfiguration from './PackageConfiguration.js'
import type * as ProfileBootstrap from './ProfileBootstrap.js'
import * as CompilationProfile from './CompilationProfile.js'
import * as Result from 'effect/Result'
import * as ConfigurationError from './ConfigurationError.js'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as BodyQuery from './BodyQuery.js'
import * as DeclarationCollection from './DeclarationCollection.js'
import * as DeclarationCompletion from './DeclarationCompletion.js'
import type * as DeclarationFacts from './DeclarationFacts.js'
import * as DeclarationIndex from './DeclarationIndex.js'
import * as Diagnostic from './Diagnostic.js'
import * as SemanticContext from './SemanticContext.js'
import * as Semantic from './Semantic.js'
import * as SemanticPersistence from './SemanticPersistence.js'
import type * as SemanticQuery from './SemanticQuery.js'
import * as Elaboration from './Elaboration.js'
import * as IncrementalReuse from './IncrementalReuse.js'
import * as ModuleClosure from './ModuleClosure.js'
import * as ModuleSelection from './ModuleSelection.js'
import * as Canonical from './internal/Canonical.js'
import * as Realization from './Realization.js'
import * as ModuleSemantics from './ModuleSemantics.js'
import * as ModuleSurface from './ModuleSurface.js'
import * as NameResolution from './NameResolution.js'
import * as ResolutionWork from './ResolutionWork.js'
import * as OpaqueRealization from './OpaqueRealization.js'
import * as Ownership from './Ownership.js'
import * as PhaseReport from './PhaseReport.js'
import * as SemanticInvalidation from './SemanticInvalidation.js'
import * as SourceResolver from './SourceResolver.js'
import * as ArtifactComposition from './ArtifactComposition.js'
import * as CompilerTrace from './CompilerTrace.js'
import * as TestDiscovery from './TestDiscovery.js'

/** Optional environment-specific observations attached to compiler phase reports. */
export interface Options {
  readonly heapBytes?: () => number
  /** Internal differential-test escape hatch; production paths normalize shared MIR. */
  readonly normalizeMir?: boolean
}

interface FrontendFacts {
  readonly profile?: CompilationProfile.CompilationProfile
  readonly selection?: ModuleSelection.ModuleSelection
  readonly index: DeclarationIndex.Index
  readonly resolution: NameResolution.Resolution
  readonly session: Semantic.Session
  readonly surfaces: ReadonlyMap<string, ModuleSurface.ModuleSurface>
  readonly semantics: ReadonlyMap<string, ModuleSemantics.ModuleSemantics>
  readonly results: ReadonlyMap<string, Elaboration.Result>
  readonly ownership: ReadonlyMap<string, Ownership.ModuleOwnership>
  readonly diagnostics: ReadonlyArray<Diagnostic.Diagnostic>
  readonly report: ReadonlyArray<PhaseReport.PhaseReport>
}

/** Immutable compiler frontend facts shared by Analysis and Driver. */
export interface Frontend extends FrontendFacts {
  readonly composition?: ArtifactComposition.Resolved
  readonly closure: ModuleClosure.Closure
  readonly initialProfile?: CompilationProfile.Initial
  readonly configurationError?: ConfigurationError.ConfigurationError
  readonly requestedTarget?: string
  readonly configuration?: ModuleClosure.CompilationRequest['configuration']
  readonly testCatalog?: TestDiscovery.Catalog
}

/** Immutable multi-root frontend facts computed once for one project revision. */
export interface ProjectFrontend extends FrontendFacts {
  readonly semanticEnvironment: string
  readonly semanticQueries: SemanticQuery.Snapshot
  readonly semanticQueryCounters: SemanticQuery.Counters
  readonly semanticPersistenceCounters?: SemanticPersistence.Counters
  readonly closure: ModuleClosure.ProjectClosure
  readonly semanticInvalidation: SemanticInvalidation.SemanticInvalidation
}

interface HeaderFacts {
  readonly index: DeclarationIndex.Index
  readonly resolution: NameResolution.Resolution
  readonly session: Semantic.Session
  readonly surfaces: ReadonlyMap<string, ModuleSurface.ModuleSurface>
}

/** Checked-unit persistence when the environment provides it. */
const semanticPersistence = Effect.map(
  Effect.serviceOption(SemanticPersistence.SemanticPersistence),
  Option.getOrUndefined,
)

/** Prepares declaration facts and a semantic query session before executable bodies are checked. */
const analyzeHeaders = Effect.fn('Frontend.analyzeHeaders')(function* (
  closure: ModuleClosure.Facts,
  report: Array<PhaseReport.PhaseReport>,
  options: Options,
  previous?: SemanticQuery.Snapshot,
  /** Persisted-record variant: the selected profile's identity, or null to skip persistence. */
  variant: string | null = '',
): Effect.fn.Return<HeaderFacts> {
  // Collect identities and raw type paths across the full module closure before resolving them.
  // Each measured phase appends its timing, input/output counts, and diagnostic count to report.
  const collected = PhaseReport.measureInto(
    report,
    'declaration-collection',
    closure.modules.length,
    () => DeclarationCollection.collect(closure),
    (value) => value.modules.reduce((sum, module) => sum + module.members.length, 0),
    (value) => value.diagnostics.length,
    options,
  )
  // Yield between the synchronous phases so other fibers can run.
  yield* Effect.yieldNow
  const index = PhaseReport.measureInto(
    report,
    'declaration-index',
    collected.modules.length,
    () => {
      // Preliminary scopes let completion resolve types and aliases in declaration headers.
      const preliminary = NameResolution.resolve(closure, collected)
      const resolvers = NameResolution.makeResolvers(preliminary, collected)
      const completed = DeclarationCompletion.complete(collected, resolvers, preliminary.contexts)
      // Carry resolver work counters forward when replacing the collected index with the final one.
      ResolutionWork.share(completed, collected)
      return completed
    },
    (value) => value.modules.reduce((sum, module) => sum + module.members.length, 0),
    (value) => value.diagnostics.length,
    options,
  )
  yield* Effect.yieldNow
  // Rebuild scopes and bindings against completed declarations for subsequent semantic queries.
  const resolution = PhaseReport.measureInto(
    report,
    'name-resolution',
    index.modules.length,
    () => NameResolution.resolve(closure, index),
    (value) => value.modules.reduce((sum, module) => sum + module.bindings.length, 0),
    (value) => value.diagnostics.length,
    options,
  )
  yield* Effect.yieldNow
  // Capture module surfaces, including published members, for incremental invalidation.
  const surfaces = PhaseReport.measureInto(
    report,
    'module-surface',
    index.modules.length,
    () => ModuleSurface.fromIndex(index),
    (value) => value.size,
    () => 0,
    options,
  )
  // Identify the session's declaration universe by modules, canonical members, and publications.
  // Length prefixes keep adjacent entries unambiguous; individual query records track dependencies.
  const epoch = index.modules
    .flatMap((module) => [
      `module:${module.module}`,
      ...module.members.map((member) =>
        member.canonical._tag === 'Canonical'
          ? `member:${member.canonical.id.module}.${member.canonical.id.name}`
          : `member:${member.canonical._tag}`,
      ),
      ...module.publications.map(
        (publication) =>
          `publication:${publication.module}.${publication.original}->${publication.spelling}`,
      ),
    ])
    .map((part) => `${part.length}:${part}`)
    .join('')
  // Seed reuse from the in-memory snapshot, supplementing it with persisted records when available.
  // Records are keyed by the selected profile variant; null skips persistence during bootstrap.
  const persistence = variant === null ? undefined : yield* semanticPersistence
  const availablePrevious =
    persistence === undefined
      ? previous
      : yield* SemanticPersistence.load(
          persistence,
          variant ?? '',
          index,
          resolution,
          previous,
        ).pipe(Effect.orDie)
  // Install the completed headers and reusable records; body checking is performed by later queries.
  const session = Semantic.makeSession(epoch, index, resolution, 'default', availablePrevious)
  return { index, resolution, session, surfaces }
})

interface ElaboratedModules {
  readonly results: ReadonlyMap<string, Elaboration.Result>
  readonly computed: ReadonlyMap<string, Elaboration.Result>
}

const elaborateModules = Effect.fn('Frontend.elaborateModules')(function* (
  closure: ModuleClosure.Facts,
  headers: HeaderFacts,
  retained: ReadonlyMap<string, Elaboration.Result> = new Map(),
  precomputed: ReadonlyMap<string, Elaboration.Result> = new Map(),
  bodyQuery?: BodyQuery.BodyQuery,
): Effect.fn.Return<ElaboratedModules> {
  const results = new Map<string, Elaboration.Result>()
  const computed = new Map<string, Elaboration.Result>()
  for (const [ordinal, module] of closure.modules.entries()) {
    yield* Effect.gen(function* () {
      yield* Effect.annotateCurrentSpan({
        module: module.name,
      })
      yield* IncrementalReuse.checkpointModuleBatch(ordinal)
      const reused = retained.get(module.name) ?? precomputed.get(module.name)
      if (reused !== undefined) {
        results.set(module.name, reused)
        return
      }
      const trace = yield* CompilerTrace.capture()
      const moduleHeaders = headers.index.modules.find(
        (candidate) => candidate.module === module.name,
      )
      const scope = NameResolution.scopeOf(headers.resolution, module.name)
      if (moduleHeaders === undefined || scope === undefined)
        throw new RangeError(`Pipeline lost module facts for ${module.name}`)
      const result = Elaboration.elaborateModule({
        authored: module.authored,
        headers: moduleHeaders,
        scope,
        index: headers.index,
        session: headers.session,
        trace,
        ...(bodyQuery === undefined ? {} : { bodyQuery }),
      })
      const published = bodyQuery === undefined ? result : BodyQuery.publish(bodyQuery, result)
      results.set(module.name, published)
      computed.set(module.name, published)
    }).pipe(Effect.withSpan('Frontend.elaborateModules:module'))
  }
  return { results, computed }
})

const analyzeSemantics = Effect.fn('Frontend.analyzeSemantics')(function* (
  closure: ModuleClosure.Facts,
  headers: HeaderFacts,
  report: Array<PhaseReport.PhaseReport>,
  options: Options,
  reuse?: {
    readonly previous: IncrementalReuse.ProjectReuseBasis
    readonly invalidation: SemanticInvalidation.SemanticInvalidation
  },
  precomputed?: {
    readonly results: ReadonlyMap<string, Elaboration.Result>
    readonly opaqueRealizations?: OpaqueRealization.Catalog
    readonly bodyQueries?: BodyQuery.BodyQuery
  },
): Effect.fn.Return<Omit<FrontendFacts, 'resolution' | 'session' | 'surfaces' | 'report'>> {
  const candidates =
    reuse === undefined
      ? new Map<string, ModuleSemantics.ModuleSemantics>()
      : yield* IncrementalReuse.retainedSemantics(closure, reuse.previous, reuse.invalidation)
  const retained =
    precomputed?.bodyQueries === undefined
      ? candidates
      : new Map(
          [...candidates].filter(
            ([name, semantics]) => precomputed.results.get(name) === semantics.elaboration,
          ),
        )
  const retainedElaborations = IncrementalReuse.retainedElaborations(retained)
  const results = yield* PhaseReport.measureEffectInto(
    report,
    'elaboration',
    closure.modules.length - retained.size,
    elaborateModules(closure, headers, retainedElaborations, precomputed?.results).pipe(
      Effect.map((elaborated) => elaborated.results),
    ),
    (value) =>
      [...value.values()].reduce((sum, module) => sum + Elaboration.sourceBodyCount(module), 0),
    (value) => [...value.values()].reduce((sum, module) => sum + module.diagnostics.length, 0),
    {
      ...options,
      counters: () => ({
        _tag: 'ModuleReuseCounters' as const,
        reused: retained.size,
        recomputed: closure.modules.length - retained.size,
      }),
    },
  )
  const generatedAggregates = new Map<string, DeclarationFacts.StructFact>()
  for (const result of results.values())
    for (const aggregate of result.generatedAggregates) {
      if (aggregate.canonical._tag !== 'Canonical') continue
      generatedAggregates.set(
        `${aggregate.canonical.id.module}:${aggregate.canonical.id.name}`,
        aggregate,
      )
    }
  const index = DeclarationIndex.make(
    headers.index.stage,
    headers.index.modules,
    headers.index.diagnostics,
    generatedAggregates,
  )
  const retainedOwnership = new Set<string>()
  const ownership = yield* PhaseReport.measureEffectInto(
    report,
    'ownership',
    results.size,
    Effect.gen(function* () {
      const ownership = new Map<string, Ownership.ModuleOwnership>()
      const localSharedAccessBoundaries = Ownership.localSharedAccessBoundaryPlan(results)
      let ordinal = 0
      for (const [name, result] of results) {
        yield* IncrementalReuse.checkpointModuleBatch(ordinal)
        const checked = Ownership.checkModule(
          result,
          index,
          localSharedAccessBoundaries,
          precomputed?.bodyQueries,
          precomputed?.bodyQueries === undefined ? undefined : headers.session,
        )
        const previous = retained.get(name)?.ownership
        const unchanged =
          previous !== undefined &&
          previous.functions.length === checked.functions.length &&
          previous.functions.every((fn, ordinal) => fn === checked.functions[ordinal]) &&
          previous.diagnostics.length === checked.diagnostics.length &&
          previous.diagnostics.every(
            (diagnostic, ordinal) => diagnostic === checked.diagnostics[ordinal],
          )
        if (unchanged) retainedOwnership.add(name)
        ownership.set(name, unchanged ? previous : checked)
        ordinal += 1
      }
      return ownership
    }),
    (value) => [...value.values()].reduce((sum, module) => sum + module.functions.length, 0),
    (value) => [...value.values()].reduce((sum, module) => sum + module.diagnostics.length, 0),
    {
      ...options,
      counters: () => ({
        _tag: 'ModuleReuseCounters' as const,
        reused: retainedOwnership.size,
        recomputed: results.size - retainedOwnership.size,
      }),
    },
  )
  const opaqueRealizations =
    precomputed?.opaqueRealizations ??
    PhaseReport.measureInto(
      report,
      'opaque-realization',
      results.size,
      () => OpaqueRealization.analyze(results),
      (value) => value.definitions.size,
      (value) => value.diagnostics.length,
      options,
    )
  const semantics = new Map<string, ModuleSemantics.ModuleSemantics>()
  let semanticOrdinal = 0
  for (const [module, elaboration] of results) {
    yield* IncrementalReuse.checkpointModuleBatch(semanticOrdinal)
    const reused = retained.get(module)
    if (reused !== undefined && reused.ownership === ownership.get(module))
      semantics.set(module, reused)
    else {
      const moduleOwnership = ownership.get(module)
      if (moduleOwnership === undefined)
        throw new RangeError(`Pipeline lost ownership facts for ${module}`)
      semantics.set(module, ModuleSemantics.make(module, elaboration, moduleOwnership))
    }
    semanticOrdinal += 1
  }
  // The one place semantic locations become spans: everything before this is revision-free.
  const registry = SemanticContext.fromModules(closure.modules)
  const diagnostics = Diagnostic.merge(
    ...closure.modules.map((module) => module.syntax.lexicalDiagnostics),
    ...closure.modules.map((module) => module.syntax.parserDiagnostics),
    closure.diagnostics,
    Diagnostic.publishAll(headers.resolution.diagnostics, registry),
    ...[...results.values()].map((result) => Diagnostic.publishAll(result.diagnostics, registry)),
    opaqueRealizations.diagnostics,
    ...[...ownership.values()].map((facts) => facts.diagnostics),
  )
  return OpaqueRealization.withCatalog(
    {
      index,
      semantics,
      results,
      ownership,
      diagnostics,
    },
    opaqueRealizations,
  )
})

const analyzeFrontend = Effect.fn('Frontend.analyzeFrontend')(function* (
  closure: ModuleClosure.Facts,
  report: Array<PhaseReport.PhaseReport>,
  options: Options,
  variant = '',
): Effect.fn.Return<FrontendFacts> {
  const headers = yield* analyzeHeaders(closure, report, options, undefined, variant)
  const semantics = yield* analyzeSemantics(closure, headers, report, options)
  const frontend = OpaqueRealization.withCatalog(
    { ...headers, ...semantics, report: [...report] },
    OpaqueRealization.catalogOf(semantics),
  )
  const persistence = yield* semanticPersistence
  if (persistence !== undefined)
    yield* SemanticPersistence.publish(
      persistence,
      variant,
      Semantic.snapshot(headers.session),
      headers.index,
    ).pipe(Effect.orDie)
  return frontend
})

/** Supplies lazy static helpers with headers and source, without checking executable bodies. */
const bootstrapFacts = Effect.fn('Frontend.bootstrapFacts')(function* (
  closure: ModuleClosure.Facts,
  report: Array<PhaseReport.PhaseReport>,
  options: Options,
): Effect.fn.Return<FrontendFacts> {
  // Before selection there is no profile to key records by, and bootstrap checks no declared
  // bodies. Without conditions these headers are the final ones, and records have no variant.
  const headers = yield* analyzeHeaders(
    closure,
    report,
    options,
    undefined,
    ModuleSelection.required(closure) ? null : '',
  )
  const results = new Map<string, Elaboration.Result>()
  for (const module of closure.modules) {
    const moduleHeaders = headers.index.modules.find(
      (candidate) => candidate.module === module.name,
    )
    const scope = NameResolution.scopeOf(headers.resolution, module.name)
    if (moduleHeaders === undefined || scope === undefined)
      throw new RangeError('Bootstrap lost module headers')
    results.set(
      module.name,
      Elaboration.elaborateModule({
        authored: module.authored,
        headers: { ...moduleHeaders, declarations: [], constants: [] },
        scope,
        index: headers.index,
        session: headers.session,
      }),
    )
  }
  return OpaqueRealization.withCatalog(
    {
      ...headers,
      results,
      semantics: new Map<string, ModuleSemantics.ModuleSemantics>(),
      ownership: new Map<string, Ownership.ModuleOwnership>(),
      diagnostics: Diagnostic.merge(
        closure.diagnostics,
        ...closure.modules.map((module) => module.syntax.lexicalDiagnostics),
        ...closure.modules.map((module) => module.syntax.parserDiagnostics),
      ),
      report: [...report],
    },
    OpaqueRealization.analyze(results),
  )
})

type ProfileSnapshot =
  | Result.Result<CompilationProfile.Initial, ConfigurationError.ConfigurationError>
  | undefined
type BindingSnapshot = Result.Result<
  ReadonlyArray<PackageConfiguration.Binding>,
  ConfigurationError.ConfigurationError
>
type CompositionSnapshot =
  | Result.Result<ArtifactComposition.Resolved, ConfigurationError.ConfigurationError>
  | undefined

const normalizeProfile = Effect.fn('Frontend.normalizeProfile')(function* (
  request: ModuleClosure.CompilationRequest,
) {
  const input =
    request.configuration?.profile ??
    (request.target === undefined ? undefined : { target: request.target })
  return input === undefined ? undefined : yield* Effect.result(CompilationProfile.normalize(input))
})

const decodeBindings = Effect.fn('Frontend.decodeBindings')(function* (
  configuration: ModuleClosure.CompilationRequest['configuration'],
) {
  const bindings: Array<PackageConfiguration.Binding> = []
  for (const binding of configuration?.bindings ?? []) {
    const origin = ConfigurationOrigin.snapshot(binding.origin)
    const value = yield* ConfigurationValue.decode(binding.value, origin)
    bindings.push({ ...binding, origin, value })
  }
  return bindings
})

const snapshotConfiguration = Effect.fn('Frontend.snapshotConfiguration')(
  (
    configuration: ModuleClosure.CompilationRequest['configuration'],
    initial: ProfileSnapshot,
    bindings: BindingSnapshot,
  ) =>
    Effect.sync(() => {
      if (configuration === undefined) return undefined
      const profile =
        initial !== undefined && Result.isSuccess(initial)
          ? CompilationProfile.input(initial.success)
          : configuration.profile
      return {
        ...configuration,
        profile,
        bindings: Result.isSuccess(bindings) ? bindings.success : [],
        ...(configuration.modules === undefined
          ? {}
          : {
              modules: configuration.modules.map((module) => ({ ...module })),
            }),
      }
    }),
)

const resolveComposition = Effect.fn('Frontend.resolveComposition')(function* (
  root: string,
  configuration: ModuleClosure.CompilationRequest['configuration'],
  initial: CompilationProfile.Initial,
) {
  const catalog = yield* ArtifactComposition.decode(
    configuration?.composition ?? ArtifactComposition.defaults(initial),
    configuration?.compositionOrigin,
  )
  return yield* ArtifactComposition.resolve(catalog, root, initial)
})

interface AdditionalRoots {
  readonly modules: ReadonlyArray<string>
  readonly error: ConfigurationError.ConfigurationError | undefined
}

const compositionRootError = (
  composition: CompositionSnapshot,
  missing: ReadonlyArray<string>,
): ConfigurationError.ConfigurationError | undefined =>
  missing.length === 0 || composition === undefined || Result.isFailure(composition)
    ? undefined
    : ConfigurationError.make(
        'ArtifactComposition.roots',
        'MissingParameter',
        'artifact source roots',
        [
          composition.success.runtime?.origin ??
            ConfigurationOrigin.literal('artifact composition'),
          ...composition.success.retention
            .filter((root) => missing.includes(root.module))
            .map((root) => root.origin),
        ],
        missing,
      )

const loadClosure = Effect.fnUntraced(function* (
  request: ModuleClosure.CompilationRequest,
  additionalRoots: ReadonlyArray<string>,
  report: Array<PhaseReport.PhaseReport>,
  options: Options,
  previous: ModuleClosure.Facts | undefined,
) {
  return yield* PhaseReport.measureEffectInto(
    report,
    'closure',
    1,
    ModuleClosure.load(request, additionalRoots, previous),
    (value) => value.modules.length,
    (value) => value.diagnostics.length,
    options,
  )
})

/** Preserve configuration-error precedence and the semantic facts' opaque realization catalog. */
const assembleSnapshot = Effect.fn('Frontend.assembleSnapshot')(
  (
    request: ModuleClosure.CompilationRequest,
    closure: ModuleClosure.Closure,
    facts: FrontendFacts,
    initial: ProfileSnapshot,
    composition: CompositionSnapshot,
    roots: AdditionalRoots,
    configuration: ModuleClosure.CompilationRequest['configuration'],
    bindings: BindingSnapshot,
  ) =>
    Effect.sync((): Frontend => {
      let initialFacts: Pick<Frontend, 'initialProfile' | 'configurationError'> = {}
      if (initial !== undefined)
        initialFacts = Result.isSuccess(initial)
          ? { initialProfile: initial.success }
          : { configurationError: initial.failure }
      let compositionFacts: Pick<Frontend, 'composition' | 'configurationError'> = {}
      if (composition !== undefined)
        compositionFacts = Result.isSuccess(composition)
          ? { composition: composition.success }
          : { configurationError: composition.failure }
      return OpaqueRealization.withCatalog(
        {
          closure,
          ...facts,
          ...initialFacts,
          ...compositionFacts,
          ...(roots.error === undefined ? {} : { configurationError: roots.error }),
          ...(configuration === undefined ? {} : { configuration }),
          ...(Result.isFailure(bindings) ? { configurationError: bindings.failure } : {}),
          ...(request.target === undefined ? {} : { requestedTarget: request.target }),
        },
        OpaqueRealization.catalogOf(facts),
      )
    }),
)

const diagnoseIncompleteProfile = Effect.fn('Frontend.diagnoseIncompleteProfile')(
  (self: Frontend, closure: ModuleClosure.Closure, target: string | undefined) =>
    Effect.sync((): Frontend => {
      const span = closure.modules.find((module) => module.name === closure.rootModule)?.syntax.root
        .span
      return span === undefined
        ? self
        : OpaqueRealization.withCatalog(
            {
              ...self,
              diagnostics: Diagnostic.merge(self.diagnostics, [
                Diagnostic.staticPhaseViolation(
                  'ModuleSelection.profile',
                  target ?? '<unavailable>',
                  [],
                  span,
                ),
              ]),
            },
            OpaqueRealization.catalogOf(self),
          )
    }),
)

const selectModules = Effect.fn('Frontend.selectModules')(function* (
  request: ModuleClosure.CompilationRequest,
  closure: ModuleClosure.Closure,
  roots: AdditionalRoots,
  completion: ProfileBootstrap.Completion,
  bootstrap: ModuleSelection.Headers,
) {
  const selected = yield* ModuleSelection.select(
    {
      roots: [request.root, ...(request.discovery === undefined ? [] : [request.discovery.root])],
      additionalRoots: roots.modules,
      application: request.root,
    },
    {
      ...closure,
      _tag: 'ProjectModuleClosure',
      rootModules: [
        request.root,
        ...(request.discovery === undefined ? [] : [request.discovery.root]),
        ...roots.modules.filter((module) => closure.sources.has(module)),
      ],
    },
    completion,
    bootstrap,
  )
  const selectedClosure = ModuleClosure.view(selected.closure, closure.rootModule)
  if (selectedClosure === undefined) throw new RangeError('Module selection lost its root')
  yield* ModuleClosure.validateDiscoverySources(request, selectedClosure)
  return { closure: selectedClosure, selection: selected.selection }
})

const attachTestCatalog = Effect.fn('Frontend.attachTestCatalog')(function* (
  frontend: Frontend,
  request: ModuleClosure.CompilationRequest,
): Effect.fn.Return<Frontend> {
  if (request.discovery === undefined) return frontend
  const testCatalog = yield* TestDiscovery.make(
    request.discovery,
    frontend.closure,
    frontend.index,
    frontend.results,
  ).pipe(Effect.orDie)
  return OpaqueRealization.withCatalog(
    { ...frontend, testCatalog },
    OpaqueRealization.catalogOf(frontend),
  )
})

const finalizeSelection = Effect.fn('Frontend.finalizeSelection')(
  (
    self: Frontend,
    facts: FrontendFacts,
    closure: ModuleClosure.Closure,
    selection: ModuleSelection.ModuleSelection,
  ) =>
    Effect.sync((): Frontend =>
      OpaqueRealization.withCatalog(
        { ...self, ...facts, closure, selection, profile: selection.profile },
        OpaqueRealization.catalogOf(facts),
      ),
    ),
)

/** Constructs the complete recoverable compiler frontend for one compilation request. */
export const frontend = Effect.fn('Frontend.frontend')(function* (
  request: ModuleClosure.CompilationRequest,
  options: Options = {},
  componentModules: ReadonlyArray<string> = [],
  previous?: ModuleClosure.Facts,
): Effect.fn.Return<Frontend, ModuleClosure.ModuleClosureError, SourceResolver.SourceResolver> {
  yield* ModuleClosure.validateRoots([request.root])
  yield* Effect.annotateCurrentSpan('frontend.root', request.root)
  const initial = yield* normalizeProfile(request)
  const bindings = yield* Effect.result(decodeBindings(request.configuration))
  const configuration = yield* snapshotConfiguration(request.configuration, initial, bindings)
  const composition =
    initial !== undefined && Result.isSuccess(initial)
      ? yield* Effect.result(resolveComposition(request.root, configuration, initial.success))
      : undefined
  const modules =
    composition !== undefined && Result.isSuccess(composition)
      ? [...new Set([...composition.success.modules, ...componentModules])].filter(
          (module) => module !== request.root,
        )
      : []
  const report: Array<PhaseReport.PhaseReport> = []
  const closure = yield* loadClosure(request, modules, report, options, previous)
  const roots: AdditionalRoots = {
    modules,
    error: compositionRootError(composition, closure.missingRoots),
  }
  yield* Effect.yieldNow
  const requiresSelection = ModuleSelection.required(closure)
  yield* Effect.annotateCurrentSpan('frontend.requiresSelection', requiresSelection)
  const facts = yield* requiresSelection
    ? bootstrapFacts(closure, report, options)
    : analyzeFrontend(closure, report, options)
  const unselected = yield* assembleSnapshot(
    request,
    closure,
    facts,
    initial,
    composition,
    roots,
    configuration,
    bindings,
  )
  if (!requiresSelection) return yield* attachTestCatalog(unselected, request)

  const configured = yield* Realization.configure(unselected, request.target)
  if (configured.completion === undefined)
    return yield* diagnoseIncompleteProfile(configured.frontend, closure, request.target)
  const selected = yield* selectModules(request, closure, roots, configured.completion, facts)
  const selectedFacts = yield* analyzeFrontend(
    selected.closure,
    report,
    options,
    selected.selection.profile.identity,
  )
  return yield* attachTestCatalog(
    yield* finalizeSelection(unselected, selectedFacts, selected.closure, selected.selection),
    request,
  )
}, SourceResolver.withSnapshot)

/** Selected module closure and headers shared by compilation and source catalogs. */
export interface SelectedProject {
  readonly closure: ModuleClosure.ProjectClosure
  readonly profile?: CompilationProfile.CompilationProfile
  readonly selection?: ModuleSelection.ModuleSelection
  readonly headers: HeaderFacts
}

const resolveProjectComposition = Effect.fn('Frontend.resolveProjectComposition')(function* (
  application: string,
  configuration: NonNullable<ModuleClosure.ProjectRequest['configuration']>,
) {
  const profile = yield* CompilationProfile.decode(configuration.profile)
  return yield* resolveComposition(application, configuration, profile)
})

const expandProjectRoots = Effect.fnUntraced(function* (
  request: ModuleClosure.ProjectRequest,
): Effect.fn.Return<ModuleClosure.ProjectRequest> {
  const application = request.application ?? request.roots[0]
  const additionalRoots = new Set(request.additionalRoots ?? [])
  if (request.configuration !== undefined && application !== undefined) {
    const selected = yield* Effect.result(
      resolveProjectComposition(application, request.configuration),
    )
    if (Result.isSuccess(selected))
      for (const module of selected.success.modules) additionalRoots.add(module)
  }
  return {
    ...request,
    roots: [
      ...new Set([
        ...request.roots,
        ...(request.application === undefined ? [] : [request.application]),
      ]),
    ],
    additionalRoots: [...additionalRoots],
    ...(application === undefined ? {} : { application }),
  }
})

const diagnoseProjectProfile = Effect.fn('Frontend.diagnoseProjectProfile')(
  (closure: ModuleClosure.ProjectClosure, frontend: Frontend, first: string | undefined) =>
    Effect.sync(() => {
      const span = closure.modules.find((module) => module.name === first)?.syntax.root.span
      return {
        ...closure,
        diagnostics: Diagnostic.merge(
          closure.diagnostics,
          frontend.diagnostics.filter(
            (diagnostic) => diagnostic.code === Diagnostic.invalidConfigurationCode,
          ),
          span === undefined || !ModuleSelection.required(closure)
            ? []
            : [
                Diagnostic.staticPhaseViolation(
                  'ModuleSelection.profile',
                  '<unavailable>',
                  [],
                  span,
                ),
              ],
        ),
      }
    }),
)

const configureProjectSelection = Effect.fn('Frontend.configureProjectSelection')(function* (
  request: ModuleClosure.ProjectRequest,
  closure: ModuleClosure.ProjectClosure,
  report: Array<PhaseReport.PhaseReport>,
  options: Options,
) {
  const application = request.application
  let selection: ModuleSelection.ModuleSelection | undefined
  let profile: CompilationProfile.CompilationProfile | undefined
  let bootstrapHeaders: HeaderFacts | undefined
  if (request.configuration !== undefined || ModuleSelection.required(closure)) {
    const first =
      application !== undefined && closure.sources.has(application)
        ? application
        : closure.rootModules[0]
    const view = first === undefined ? undefined : ModuleClosure.view(closure, first)
    if (view === undefined) throw new RangeError('Project selection lost its root')
    const base = yield* bootstrapFacts(closure, report, options)
    if (!ModuleSelection.required(closure)) bootstrapHeaders = base
    const configured = yield* Realization.configure(
      OpaqueRealization.withCatalog(
        {
          ...base,
          closure: view,
          ...(request.configuration === undefined ? {} : { configuration: request.configuration }),
        },
        OpaqueRealization.catalogOf(base),
      ),
      undefined,
    )
    profile = configured.completion?.profile
    if (configured.completion !== undefined && ModuleSelection.required(closure)) {
      const selected = yield* ModuleSelection.select(request, closure, configured.completion, base)
      closure = selected.closure
      selection = selected.selection
    } else if (configured.completion === undefined) {
      closure = yield* diagnoseProjectProfile(closure, configured.frontend, first)
    }
  }
  return { closure, profile, selection, bootstrapHeaders }
})

const diagnoseMissingProjectRoots = Effect.fn('Frontend.diagnoseMissingProjectRoots')(
  (
    request: ModuleClosure.ProjectRequest,
    closure: ModuleClosure.ProjectClosure,
    missing: ReadonlyArray<string>,
  ) =>
    Effect.sync(() => {
      const span =
        request.roots[0] === undefined
          ? undefined
          : closure.modules.find((module) => module.name === request.roots[0])?.syntax.root.span
      if (missing.length > 0 && span !== undefined)
        closure = {
          ...closure,
          diagnostics: Diagnostic.merge(closure.diagnostics, [
            Diagnostic.invalidConfiguration(
              ConfigurationError.make(
                'Frontend.selectProject',
                'MissingParameter',
                'artifact source roots',
                [
                  request.configuration?.compositionOrigin ??
                    ConfigurationOrigin.literal('application'),
                ],
                missing,
              ),
              span,
            ),
          ]),
        }

      return closure
    }),
)

/** Runs canonical profile/bootstrap/selection without elaborating unrelated executable bodies. */
export const selectProject = Effect.fn('Frontend.selectProject')(function* (
  request: ModuleClosure.ProjectRequest,
  report: Array<PhaseReport.PhaseReport> = [],
  options: Options = {},
  previous?: SemanticQuery.Snapshot,
): Effect.fn.Return<
  SelectedProject,
  ModuleClosure.ModuleClosureError,
  SourceResolver.SourceResolver
> {
  yield* Effect.annotateCurrentSpan('frontend.roots', request.roots)
  yield* ModuleClosure.validateRoots(request.roots, [
    ...(request.additionalRoots ?? []),
    ...(request.application === undefined ? [] : [request.application]),
  ])
  const expanded = yield* expandProjectRoots(request)
  const loaded = yield* PhaseReport.measureEffectInto(
    report,
    'closure',
    request.roots.length,
    ModuleClosure.loadProject(expanded),
    (value) => value.modules.length,
    (value) => value.diagnostics.length,
    options,
  )
  yield* Effect.yieldNow
  const selected = yield* configureProjectSelection(expanded, loaded, report, options)
  const variant = selected.selection?.profile.identity ?? ''
  const headers =
    selected.bootstrapHeaders ??
    (yield* analyzeHeaders(selected.closure, report, options, previous, variant))
  const closure = yield* diagnoseMissingProjectRoots(
    expanded,
    selected.closure,
    selected.closure.missingRoots,
  )
  return {
    closure,
    headers,
    ...(selected.profile === undefined ? {} : { profile: selected.profile }),
    ...(selected.selection === undefined ? {} : { selection: selected.selection }),
  }
}, SourceResolver.withSnapshot)

/** Constructs one complete compiler frontend for the union closure of project roots. */
export const frontendProject = Effect.fn('Frontend.frontendProject')(function* (
  request: ModuleClosure.ProjectRequest,
  options: Options = {},
  previous?: IncrementalReuse.ProjectReuseBasis,
): Effect.fn.Return<
  ProjectFrontend,
  ModuleClosure.ModuleClosureError,
  SourceResolver.SourceResolver
> {
  const report: Array<PhaseReport.PhaseReport> = []
  const { closure, profile, selection, headers } = yield* selectProject(
    request,
    report,
    options,
    previous?.semanticQueries,
  )
  const semanticEnvironment = Canonical.record('SelectedFrontend', [
    SemanticInvalidation.environment,
    profile?.identity ?? '',
    selection?.dependencies ?? '',
  ])
  const compatiblePrevious = previous?.environment === semanticEnvironment ? previous : undefined
  const bodyQueries = BodyQuery.make(
    headers.index,
    headers.resolution,
    [...(compatiblePrevious?.semantics.values() ?? [])].map((module) => module.elaboration),
    closure.modules.map((module) => module.authored),
  )
  const currentElaboration = yield* PhaseReport.measureEffectInto(
    report,
    'Semantic.checkBody',
    headers.index.modules.reduce((sum, module) => sum + module.declarations.length, 0),
    elaborateModules(closure, headers, new Map(), new Map(), bodyQueries),
    (value) =>
      [...value.results.values()].reduce(
        (sum, result) => sum + Elaboration.sourceBodyCount(result),
        0,
      ),
    (value) =>
      [...value.results.values()].reduce((sum, result) => sum + result.diagnostics.length, 0),
    { ...options, counters: () => BodyQuery.counters(bodyQueries) },
  )
  const currentResults = currentElaboration.results
  const currentOpaqueRealizations = OpaqueRealization.analyze(currentResults)
  yield* Effect.yieldNow
  const invalidation = PhaseReport.measure(
    'semantic-invalidation',
    closure.modules.length,
    () =>
      IncrementalReuse.invalidate({
        closure,
        environment: semanticEnvironment,
        surfaces: headers.surfaces,
        opaqueRealizations: currentOpaqueRealizations,
        ...(previous === undefined ? {} : { previous }),
      }),
    (value) => value.totals.recomputed,
    () => 0,
    {
      ...options,
      counters: (value) => {
        const totals = value.totals
        return {
          _tag: 'SemanticInvalidationCounters' as const,
          reusable: totals.reusable,
          recomputed: totals.recomputed,
          fresh: totals.reasons.Fresh,
          localChange: totals.reasons.LocalChange,
          opaqueBodyChange: totals.reasons.OpaqueBodyChange,
          opaqueTargetChange: totals.reasons.OpaqueTargetChange,
          opaqueLayoutChange: totals.reasons.OpaqueLayoutChange,
          dependencySurfaceChange: totals.reasons.DependencySurfaceChange,
          cyclicPeerChange: totals.reasons.CyclicPeerChange,
          environmentChange: totals.reasons.EnvironmentChange,
          surfaceChange: totals.reasons.SurfaceChange,
        }
      },
    },
  )
  report.push(invalidation.report)
  yield* Effect.yieldNow
  const semantics = yield* analyzeSemantics(
    closure,
    headers,
    report,
    options,
    previous === undefined ? undefined : { previous, invalidation: invalidation.value },
    {
      results: currentElaboration.computed,
      bodyQueries,
      ...(previous === undefined ? { opaqueRealizations: currentOpaqueRealizations } : {}),
    },
  )
  const queryReport = report.findIndex((phase) => phase.phase === 'Semantic.checkBody')
  const measuredQuery = report[queryReport]
  if (measuredQuery !== undefined)
    report[queryReport] = PhaseReport.make({
      ...measuredQuery,
      counters: BodyQuery.counters(bodyQueries),
    })
  const semanticQueries = Semantic.snapshot(headers.session)
  const persistence = yield* semanticPersistence
  if (persistence !== undefined)
    yield* SemanticPersistence.publish(
      persistence,
      selection?.profile.identity ?? '',
      semanticQueries,
      headers.index,
    ).pipe(Effect.orDie)
  return OpaqueRealization.withCatalog(
    {
      closure,
      ...headers,
      ...semantics,
      semanticInvalidation: invalidation.value,
      semanticEnvironment,
      semanticQueries,
      semanticQueryCounters: Semantic.queryCounters(headers.session),
      ...(persistence === undefined
        ? {}
        : { semanticPersistenceCounters: SemanticPersistence.counters(persistence) }),
      ...(selection === undefined ? {} : { selection }),
      ...(profile === undefined ? {} : { profile }),
      report: [...report],
    },
    OpaqueRealization.catalogOf(semantics),
  )
})
