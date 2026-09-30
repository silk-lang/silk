import type * as ConfigurationOrigin from './ConfigurationOrigin.js'
import type * as ArtifactComposition from './ArtifactComposition.js'
import type * as CompilationProfile from './CompilationProfile.js'
import type * as PackageConfiguration from './PackageConfiguration.js'
import * as Effect from 'effect/Effect'
import * as Data from 'effect/Data'
import * as Option from 'effect/Option'
import * as Result from 'effect/Result'
import type * as AuthoredHir from './AuthoredHir.js'
import * as AuthoredIdentity from './AuthoredIdentity.js'
import type * as AuthoredLowering from './AuthoredLowering.js'
import * as Diagnostic from './Diagnostic.js'
import * as ImportPath from './ImportPath.js'
import * as Graph from './internal/Graph.js'
import * as Hir from './Hir.js'
import * as SemanticContext from './SemanticContext.js'
import * as SourceFile from './SourceFile.js'
import * as Source from './Source.js'
import * as SourceResolver from './SourceResolver.js'
import * as Stdlib from './Stdlib.js'
import type * as SyntaxFile from './SyntaxFile.js'
import type * as TestDiscovery from './TestDiscovery.js'

/** One compilation request: a canonical root identity plus optional target selection. */
export interface CompilationRequest {
  readonly root: string
  /** Independent, root-scoped test catalog input; absent for ordinary compilation. */
  readonly discovery?: TestDiscovery.Request
  readonly target?: string
  readonly configuration?: {
    readonly composition?: ArtifactComposition.Input
    readonly compositionOrigin?: ConfigurationOrigin.ConfigurationOrigin
    readonly package?: string
    readonly profile: CompilationProfile.Input
    readonly bindings?: ReadonlyArray<PackageConfiguration.Binding>
    readonly modules?: ReadonlyArray<Omit<PackageConfiguration.Module, 'bytes'>>
  }
}

/** One project frontend request with one or more independently queryable roots. */
export interface ProjectRequest {
  readonly application?: string
  readonly configuration?: CompilationRequest['configuration']
  readonly roots: ReadonlyArray<string>
  /** Composition roots retain recoverable absence/failure facts. */
  readonly additionalRoots?: ReadonlyArray<string>
  /** Prior loaded facts whose unchanged modules keep their syntax and authored artifacts. */
  readonly previous?: Facts
  /**
   * Completed condition decisions for this discovery pass, keyed by module name and then by the
   * owner key of the authored conditional declaration; absent decisions admit neither arm.
   */
  readonly selection?: ReadonlyMap<string, ReadonlyMap<string, boolean>>
}

/** The resolved, diagnosed, or unspelled target of one authored import declaration. */
export type ImportTarget =
  | {
      readonly _tag: 'Resolved'
      readonly module: string
      readonly anchor: AuthoredHir.Anchor
    }
  | {
      readonly _tag: 'Unknown'
      readonly module: string
      readonly anchor: AuthoredHir.Anchor
      readonly cause: Diagnostic.Identity
    }
  | {
      readonly _tag: 'Self'
      readonly module: string
      readonly anchor: AuthoredHir.Anchor
      readonly cause: Diagnostic.Identity
    }
  | {
      readonly _tag: 'Failed'
      readonly module: string
      readonly anchor: AuthoredHir.Anchor
      readonly error: SourceResolver.SourceResolverError
    }
  | {
      readonly _tag: 'Unavailable'
      readonly anchor: AuthoredHir.Anchor
    }

/** One authored import declaration of a loaded module with its exact concrete provenance. */
export interface ImportFact {
  readonly _tag: 'Import'
  /** The authored import declaration; its header carries the path, alias and member list. */
  readonly declaration: AuthoredHir.Declaration
  readonly header: Extract<AuthoredHir.DeclarationHeader, { readonly _tag: 'ImportHeader' }>
  readonly sourceSpelling?: string
  readonly canonicalTarget?: string
  readonly target: ImportTarget
}

/** One loaded module of the closure. */
export interface Module {
  readonly _tag: 'Module'
  readonly name: string
  /** Retained for the formatter, the syntax inspector and source-edit tooling only. */
  readonly syntax: SyntaxFile.SyntaxFile
  /** The source-free authored module and its current presentation, lowered once per parse. */
  readonly authored: AuthoredLowering.Lowered
  readonly imports: ReadonlyArray<ImportFact>
  /** Selected authored declarations in authored order, with selected conditional groups flattened. */
  readonly declarations: ReadonlyArray<AuthoredHir.Declaration>
}

/** Immutable facts shared by single-root and multi-root module closures. */
export interface Facts {
  readonly modules: ReadonlyArray<Module>
  readonly cycles: ReadonlyArray<ReadonlyArray<string>>
  readonly diagnostics: ReadonlyArray<Diagnostic.Diagnostic>
  readonly sources: ReadonlyMap<string, SourceFile.SourceFile>
  readonly resolutionFailures: ReadonlyArray<SourceResolver.SourceResolverError>
  readonly missingRoots: ReadonlyArray<string>
}

/** The deterministic closure admitted by one declaration-selection discovery pass. */
export interface Closure extends Facts {
  readonly _tag: 'ModuleClosure'
  readonly rootModule: string
}

/** The deterministic union closure admitted by one project discovery pass. */
export interface ProjectClosure extends Facts {
  readonly _tag: 'ProjectModuleClosure'
  readonly rootModules: ReadonlyArray<string>
}

/** A requested root cannot establish a complete analysis snapshot. */
export class ModuleClosureError extends Data.TaggedError('ModuleClosureError')<{
  readonly operation: 'ModuleClosure.loadProject'
  readonly message: string
  readonly reason:
    | { readonly _tag: 'EmptyRoots' }
    | { readonly _tag: 'InvalidRoot'; readonly module: string }
    | { readonly _tag: 'MissingRoot'; readonly module: string }
    | { readonly _tag: 'MissingDiscoverySource'; readonly module: string }
    | {
        readonly _tag: 'RootResolutionFailed'
        readonly module: string
        readonly error: SourceResolver.SourceResolverError
      }
}> {}

const compareText = (left: string, right: string): number => {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

/** Validates the entire request before any source is accessed. */
export const validateRoots = Effect.fn('ModuleClosure.validateRoots')(function* (
  roots: ReadonlyArray<string>,
  additionalRoots: ReadonlyArray<string> = [],
): Effect.fn.Return<ReadonlyArray<string>, ModuleClosureError> {
  if (roots.length === 0)
    return yield* new ModuleClosureError({
      operation: 'ModuleClosure.loadProject',
      message: 'Project analysis requires at least one root module',
      reason: { _tag: 'EmptyRoots' },
    })
  for (const module of [...new Set([...roots, ...additionalRoots])].sort())
    if (!SourceResolver.isCanonicalModule(module))
      return yield* new ModuleClosureError({
        operation: 'ModuleClosure.loadProject',
        message: `Root module identity ${module} is not canonical`,
        reason: { _tag: 'InvalidRoot', module },
      })
  return [...new Set(roots)].sort()
})

interface ParsedModule {
  readonly name: string
  readonly syntax: SyntaxFile.SyntaxFile
  readonly authored: AuthoredLowering.Lowered
  readonly declarations: ReadonlyArray<AuthoredHir.Declaration>
  readonly imports: ReadonlyArray<{
    readonly declaration: AuthoredHir.Declaration
    readonly header: ImportFact['header']
    readonly sourceSpelling?: string
    readonly canonicalTarget?: string
  }>
}

interface ModuleAnalysis {
  readonly module: Module
  readonly diagnostics: ReadonlyArray<Diagnostic.Diagnostic>
}

// Independent compiler requests repeatedly lower the same shipped source closure. Keep only the
// latest source revision of each manifest module: syntax and authored artifacts are immutable,
// while profile selection and import resolution must be rebuilt for every request.
const standardLibraryLowerings = new Map<string, Hir.Lowered>()

const parseModule = Effect.fnUntraced(function* (
  name: string,
  source: SourceResolver.ResolvedSource,
  previous?: Module,
  selection: ReadonlyMap<string, boolean> = new Map(),
  application?: string,
): Effect.fn.Return<ParsedModule> {
  const currentSource = SourceFile.make(name, source.bytes, source.origin)
  const cacheable = Stdlib.find(name) !== undefined
  const cached = cacheable ? standardLibraryLowerings.get(name) : undefined
  let reused: Module | Hir.Lowered | undefined
  if (previous !== undefined && SourceFile.equals(previous.syntax.source, currentSource)) {
    reused = previous
  } else if (cached !== undefined && SourceFile.equals(cached.syntax.source, currentSource)) {
    reused = cached
  }
  const lowered = reused === undefined ? yield* Effect.orDie(Hir.lower(currentSource)) : undefined
  if (cacheable && lowered !== undefined) standardLibraryLowerings.set(name, lowered)
  const syntax = reused?.syntax ?? lowered?.syntax
  const authored = reused?.authored ?? lowered?.authored
  if (syntax === undefined || authored === undefined)
    throw new RangeError(`HIR lowering lost products for ${name}`)
  const context = SemanticContext.make(authored)
  const declarations = selectedDeclarations(authored.module, selection)
  const imports = declarations.flatMap((declaration): ParsedModule['imports'] => {
    const header = declaration.header
    if (header._tag !== 'ImportHeader') return []
    const sourceSpelling = ImportPath.authoredSpelling(context, header.path)
    const canonicalTarget =
      sourceSpelling === 'Intrinsic.application' && application !== undefined
        ? application
        : ImportPath.authoredTarget(context, header.path)
    if (sourceSpelling === undefined || canonicalTarget === undefined)
      return [{ declaration, header }]
    return [{ declaration, header, sourceSpelling, canonicalTarget }]
  })
  return { name, syntax, authored, declarations, imports: imports }
})

/**
 * The authored declarations one completed selection admits, with the groups of decided conditions
 * flattened in authored order. Selection keys are the owner keys of conditional declarations; an
 * undecided condition admits neither arm.
 */
export const selectedDeclarations = (
  module: AuthoredHir.Module,
  selection: ReadonlyMap<string, boolean>,
): ReadonlyArray<AuthoredHir.Declaration> => {
  const found: Array<AuthoredHir.Declaration> = []
  const visit = (declaration: AuthoredHir.Declaration): void => {
    const header = declaration.header
    if (header._tag === 'GroupHeader') {
      if (declaration.body._tag === 'MembersBody') declaration.body.members.forEach(visit)
      return
    }
    if (header._tag !== 'ConditionalHeader') return void found.push(declaration)
    const decision = selection.get(AuthoredIdentity.key(declaration.owner))
    if (decision === undefined || declaration.body._tag !== 'ConditionalBody') return
    const arm = decision ? declaration.body.thenBranch : declaration.body.elseBranch
    if (arm !== undefined) visit(arm)
  }
  module.declarations.forEach(visit)
  return found
}

type Resolution =
  | { readonly _tag: 'Found'; readonly source: SourceResolver.ResolvedSource }
  | { readonly _tag: 'Absent' }
  | { readonly _tag: 'Failed'; readonly error: SourceResolver.SourceResolverError }

const analyzeModule = Effect.fnUntraced(function* (
  parsed: ParsedModule,
  resolve: (module: string) => Effect.Effect<Resolution, never, SourceResolver.SourceResolver>,
): Effect.fn.Return<ModuleAnalysis, never, SourceResolver.SourceResolver> {
  const diagnostics: Array<Diagnostic.Diagnostic> = []
  const imports: Array<ImportFact> = []
  const context = SemanticContext.make(parsed.authored)
  for (const imported of parsed.imports) {
    const { declaration, header } = imported
    const anchor = header.path.anchor
    if (imported.canonicalTarget === undefined) {
      imports.push({
        _tag: 'Import',
        declaration,
        header,
        target: { _tag: 'Unavailable', anchor },
      })
      continue
    }
    const module = imported.canonicalTarget
    const sourceSpelling = imported.sourceSpelling
    if (sourceSpelling === undefined)
      throw new RangeError('Available import path lost its source spelling')
    const span = context.spanOf(anchor)
    if (module === parsed.name) {
      const diagnostic = Diagnostic.selfImport(module, span)
      diagnostics.push(diagnostic)
      imports.push({
        _tag: 'Import',
        declaration,
        header,
        sourceSpelling,
        canonicalTarget: module,
        target: {
          _tag: 'Self',
          module,
          anchor,
          cause: Diagnostic.identity(diagnostic),
        },
      })
      continue
    }
    const resolution = yield* resolve(module)
    if (resolution._tag === 'Absent') {
      const diagnostic = Diagnostic.unknownModule(module, span)
      diagnostics.push(diagnostic)
      imports.push({
        _tag: 'Import',
        declaration,
        header,
        sourceSpelling,
        canonicalTarget: module,
        target: {
          _tag: 'Unknown',
          module,
          anchor,
          cause: Diagnostic.identity(diagnostic),
        },
      })
      continue
    }
    imports.push({
      _tag: 'Import',
      declaration,
      header,
      sourceSpelling,
      canonicalTarget: module,
      target:
        resolution._tag === 'Found'
          ? { _tag: 'Resolved' as const, module, anchor }
          : {
              _tag: 'Failed' as const,
              module,
              anchor,
              error: resolution.error,
            },
    })
  }

  return {
    module: {
      _tag: 'Module',
      name: parsed.name,
      syntax: parsed.syntax,
      authored: parsed.authored,
      declarations: parsed.declarations,
      imports: imports,
    },
    diagnostics: diagnostics,
  }
})

const resolvedTargets = (module: Module): ReadonlyArray<string> =>
  [
    ...new Set(
      module.imports.flatMap((fact) =>
        fact.target._tag === 'Resolved' ? [fact.target.module] : [],
      ),
    ),
  ].sort()

/** Computes strongly connected components of size > 1 over resolved imports, deterministically. */
const cycleFacts = (modules: ReadonlyArray<Module>): ReadonlyArray<ReadonlyArray<string>> => {
  const names = modules.map((module) => module.name)
  const edges = new Map(modules.map((module) => [module.name, resolvedTargets(module)]))
  return Graph.stronglyConnected(names, (name) => edges.get(name) ?? [])
    .filter((component) => component.length > 1)
    .sort((left, right) => (left.at(0) ?? '').localeCompare(right.at(0) ?? ''))
}

/**
 * Discovers imports admitted by the supplied declaration decisions. Undecided groups admit neither
 * arm; Frontend coordinates profile completion and subsequent selection passes. Roots and the final
 * module order are canonically sorted, so neither supply order nor traversal order affects the
 * result.
 */
export const loadProject = Effect.fn('ModuleClosure.loadProject')(function* (
  request: ProjectRequest,
): Effect.fn.Return<ProjectClosure, ModuleClosureError, SourceResolver.SourceResolver> {
  yield* Effect.annotateCurrentSpan({
    'request.application': request.application,
    'request.roots': request.roots,
    'request.previous': request.previous?.modules.map((module) => module.name),
  })
  const roots = yield* validateRoots(request.roots, request.additionalRoots)
  const previousModules = new Map(request.previous?.modules.map((module) => [module.name, module]))
  const loaded = new Map<string, Module>()
  const diagnostics: Array<ReadonlyArray<Diagnostic.Diagnostic>> = []
  const resolutions = new Map<string, Resolution>()
  const rootModules: Array<string> = [...roots]
  const missingRoots: Array<string> = []

  const resolve = Effect.fn('ModuleClosure.resolve')(function* (
    module: string,
  ): Effect.fn.Return<Resolution, never, SourceResolver.SourceResolver> {
    const cached = resolutions.get(module)
    if (cached !== undefined) return cached
    // Standard-library identities resolve from the compiler-shipped sources exclusively; a
    // user resolver is never consulted inside the reserved namespace.
    const attempted = yield* Effect.result(
      Stdlib.isReserved(module)
        ? SourceResolver.resolveStandardLibrary(module)
        : Source.load(module),
    )
    const resolution: Resolution = Result.isFailure(attempted)
      ? { _tag: 'Failed', error: attempted.failure }
      : Option.match(attempted.success, {
          onNone: () => ({ _tag: 'Absent' as const }),
          onSome: (source) => ({ _tag: 'Found' as const, source }),
        })
    resolutions.set(module, resolution)
    return resolution
  })

  for (const module of roots) {
    const outcome = yield* resolve(module)
    if (outcome._tag === 'Absent')
      return yield* new ModuleClosureError({
        operation: 'ModuleClosure.loadProject',
        message: `Root module ${module} is missing`,
        reason: { _tag: 'MissingRoot', module },
      })
    if (outcome._tag === 'Failed')
      return yield* new ModuleClosureError({
        operation: 'ModuleClosure.loadProject',
        message: `Cannot resolve root module ${module}: ${outcome.error.message}`,
        reason: { _tag: 'RootResolutionFailed', module, error: outcome.error },
      })
  }
  for (const module of [...new Set(request.additionalRoots ?? [])].sort()) {
    if (roots.includes(module)) continue
    const outcome = yield* resolve(module)
    if (outcome._tag === 'Found') rootModules.push(module)
    else if (outcome._tag === 'Absent') missingRoots.push(module)
  }
  rootModules.sort()
  const pending: Array<string> = [...rootModules]

  while (pending.length > 0) {
    pending.sort()
    const name = pending.shift()
    if (name === undefined || loaded.has(name)) continue
    const resolution = resolutions.get(name) ?? (yield* resolve(name))
    if (resolution?._tag !== 'Found') continue
    const analysis = yield* analyzeModule(
      yield* parseModule(
        name,
        resolution.source,
        previousModules.get(name),
        request.selection?.get(name),
        request.application,
      ),
      resolve,
    )
    loaded.set(name, analysis.module)
    diagnostics.push(analysis.diagnostics)
    for (const target of resolvedTargets(analysis.module)) {
      if (!loaded.has(target) && !pending.includes(target)) pending.push(target)
    }
  }

  const modules = [...loaded.values()].sort((left, right) => {
    return compareText(left.name, right.name)
  })

  return {
    _tag: 'ProjectModuleClosure',
    rootModules: rootModules,
    missingRoots: missingRoots,
    modules,
    cycles: cycleFacts(modules),
    diagnostics: Diagnostic.merge(...diagnostics),
    sources: new Map(modules.map((module) => [module.name, module.syntax.source])),
    resolutionFailures: [...resolutions.entries()]
      .sort(([left], [right]) => {
        return compareText(left, right)
      })
      .flatMap(([, resolution]) => (resolution._tag === 'Failed' ? [resolution.error] : [])),
  }
})

/** Selects one root from a project closure without copying project-owned module facts. */
export const view = (self: ProjectClosure, rootModule: string): Closure | undefined =>
  self.rootModules.includes(rootModule)
    ? {
        _tag: 'ModuleClosure',
        rootModule,
        modules: self.modules,
        cycles: self.cycles,
        diagnostics: self.diagnostics,
        sources: self.sources,
        resolutionFailures: self.resolutionFailures,
        missingRoots: self.missingRoots,
      }
    : undefined

/** Requires explicit ownership and logical paths for every in-memory source reached from discovery. */
export const validateDiscoverySources = Effect.fn('ModuleClosure.validateDiscoverySources')(
  function* (
    request: CompilationRequest,
    closure: Closure,
  ): Effect.fn.Return<void, ModuleClosureError> {
    if (request.discovery === undefined) return
    const modules = new Map(closure.modules.map((module) => [module.name, module]))
    const reached = new Set<string>()
    const pending = [request.discovery.root]
    while (pending.length > 0) {
      pending.sort(compareText)
      const name = pending.shift()
      if (name === undefined || reached.has(name)) continue
      const module = modules.get(name)
      if (module === undefined) continue
      reached.add(name)
      if (
        !Stdlib.isReserved(name) &&
        module.syntax.source.origin._tag === 'Memory' &&
        request.discovery.sources?.has(name) !== true
      )
        return yield* new ModuleClosureError({
          operation: 'ModuleClosure.loadProject',
          message: `In-memory discovery source ${name} requires ownership and a logical path`,
          reason: { _tag: 'MissingDiscoverySource', module: name },
        })
      for (const imported of module.imports)
        if (imported.target._tag === 'Resolved') pending.push(imported.target.module)
    }
  },
)

/** Discovers the unconditional bootstrap closure of one compilation request. Use Analysis.make for profile-selected frontend facts. */
export const load = Effect.fn('ModuleClosure.load')(function* (
  request: CompilationRequest,
  additionalRoots: ReadonlyArray<string> = [],
  previous?: Facts,
): Effect.fn.Return<Closure, ModuleClosureError, SourceResolver.SourceResolver> {
  const requiredRoots = [
    request.root,
    ...(request.discovery === undefined ? [] : [request.discovery.root]),
  ]
  const project = yield* loadProject({
    roots: requiredRoots,
    additionalRoots,
    application: request.root,
    ...(previous === undefined ? {} : { previous }),
  })
  const closure = view(project, request.root)
  if (closure === undefined) throw new RangeError(`Project closure lost root ${request.root}`)
  yield* validateDiscoverySources(request, closure)
  return closure
})
