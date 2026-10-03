import type * as CompilationProfile from './CompilationProfile.js'
import type * as ConfigurationError from './ConfigurationError.js'
import * as Diagnostic from './Diagnostic.js'
import * as Effect from 'effect/Effect'
import type * as Analysis from './Analysis.js'
import * as Frontend from './Frontend.js'
import * as FrontendTooling from './FrontendTooling.js'
import * as ModuleClosure from './ModuleClosure.js'
import type * as ModuleSemantics from './ModuleSemantics.js'
import type * as ModuleSurface from './ModuleSurface.js'
import type * as ModuleTooling from './ModuleTooling.js'
import * as OpaqueRealization from './OpaqueRealization.js'
import type * as PhaseReport from './PhaseReport.js'
import * as Semantic from './Semantic.js'
import type * as SemanticQuery from './SemanticQuery.js'
import * as SemanticInvalidation from './SemanticInvalidation.js'
import type * as SourceResolver from './SourceResolver.js'
import type * as SyntaxFile from './SyntaxFile.js'

/** One current module's syntax relationship to the optional previous project revision. */
export type SyntaxRevision =
  | {
      readonly _tag: 'Fresh'
      readonly module: string
      readonly current: SyntaxFile.SyntaxFile
    }
  | {
      readonly _tag: 'Reused'
      readonly module: string
      readonly previous: SyntaxFile.SyntaxFile
      readonly current: SyntaxFile.SyntaxFile
    }
  | {
      readonly _tag: 'Changed'
      readonly module: string
      readonly previous: SyntaxFile.SyntaxFile
      readonly current: SyntaxFile.SyntaxFile
    }

/** One frontend-query-compatible root view that cannot be passed to runtime realization. */
export interface View extends Analysis.FrontendSnapshot {
  readonly _tag: 'ProjectAnalysisView'
  readonly realization: 'ProjectView'
}

/** One immutable multi-root compiler frontend and its structurally shared root views. */
export interface Options {
  readonly application?: string
  readonly configuration?: ModuleClosure.CompilationRequest['configuration']
  readonly configurationError?: ConfigurationError.ConfigurationError
}

export interface ProjectAnalysis {
  readonly profile?: CompilationProfile.CompilationProfile
  readonly _tag: 'ProjectAnalysis'
  readonly roots: ReadonlyArray<string>
  readonly closure: ModuleClosure.ProjectClosure
  readonly views: ReadonlyMap<string, View>
  readonly syntaxRevisions: ReadonlyMap<string, SyntaxRevision>
  readonly surfaces: ReadonlyMap<string, ModuleSurface.ModuleSurface>
  readonly semantics: ReadonlyMap<string, ModuleSemantics.ModuleSemantics>
  readonly toolingModules: ReadonlyMap<string, ModuleTooling.ModuleTooling>
  readonly semanticEnvironment: string
  readonly semanticQueries: SemanticQuery.Snapshot
  readonly semanticQueryCounters: SemanticQuery.Counters
  readonly semanticSession: Semantic.Session
  readonly semanticInvalidation: SemanticInvalidation.SemanticInvalidation
  readonly report: ReadonlyArray<PhaseReport.PhaseReport>
}

const opaqueRealizationsOf = (self: ProjectAnalysis): OpaqueRealization.Catalog =>
  OpaqueRealization.catalogOption(self) ??
  OpaqueRealization.analyze(
    new Map([...self.semantics].map(([module, semantics]) => [module, semantics.elaboration])),
  )

const analyze = Effect.fnUntraced(function* (
  roots: ReadonlyArray<string>,
  previous: ProjectAnalysis | undefined,
  options: Options,
): Effect.fn.Return<
  ProjectAnalysis,
  ModuleClosure.ModuleClosureError,
  SourceResolver.SourceResolver
> {
  const unconfigured = yield* Frontend.frontendProject(
    {
      roots,
      ...(options.application === undefined ? {} : { application: options.application }),
      ...(options.configuration === undefined ? {} : { configuration: options.configuration }),
      ...(previous === undefined ? {} : { previous: previous.closure }),
    },
    { tooling: true },
    previous === undefined
      ? undefined
      : {
          closure: previous.closure,
          surfaces: previous.surfaces,
          semantics: previous.semantics,
          opaqueRealizations: opaqueRealizationsOf(previous),
          environment: previous.semanticEnvironment,
          semanticQueries: Semantic.snapshot(previous.semanticSession),
        },
  )
  const root = unconfigured.closure.rootModules[0]
  const closure = root === undefined ? undefined : ModuleClosure.view(unconfigured.closure, root)
  const span = closure?.modules.find((module) => module.name === root)?.syntax.root.span
  const diagnostics = unconfigured.diagnostics
  const frontend = {
    ...unconfigured,
    diagnostics:
      options.configurationError === undefined || span === undefined
        ? diagnostics
        : Diagnostic.merge(diagnostics, [
            Diagnostic.invalidConfiguration(options.configurationError, span),
          ]),
  }
  yield* Effect.yieldNow
  const tooling = yield* FrontendTooling.make(frontend, previous?.toolingModules)
  const previousModules = new Map(
    previous?.closure.modules.map((module) => [module.name, module.syntax]),
  )
  const syntaxRevisions = new Map<string, SyntaxRevision>()
  for (const [ordinal, module] of frontend.closure.modules.entries()) {
    if (ordinal > 0 && ordinal % 8 === 0) yield* Effect.yieldNow
    const previousSyntax = previousModules.get(module.name)
    if (previousSyntax === undefined) {
      syntaxRevisions.set(module.name, {
        _tag: 'Fresh',
        module: module.name,
        current: module.syntax,
      })
      continue
    }
    if (previousSyntax === module.syntax) {
      syntaxRevisions.set(module.name, {
        _tag: 'Reused',
        module: module.name,
        previous: previousSyntax,
        current: module.syntax,
      })
      continue
    }
    syntaxRevisions.set(module.name, {
      _tag: 'Changed',
      module: module.name,
      previous: previousSyntax,
      current: module.syntax,
    })
  }
  const report = tooling.report
  const views = new Map<string, View>()
  for (const [ordinal, rootModule] of frontend.closure.rootModules.entries()) {
    if (ordinal > 0 && ordinal % 8 === 0) yield* Effect.yieldNow
    const closure = ModuleClosure.view(frontend.closure, rootModule)
    if (closure === undefined)
      throw new RangeError(`Project analysis lost requested root ${rootModule}`)
    views.set(
      rootModule,
      OpaqueRealization.withCatalog(
        {
          _tag: 'ProjectAnalysisView',
          realization: 'ProjectView',
          ...frontend,
          ...(options.configuration === undefined ? {} : { configuration: options.configuration }),
          ...tooling,
          closure,
          semanticInvalidation: frontend.semanticInvalidation,
          report,
        },
        OpaqueRealization.catalogOf(unconfigured),
      ),
    )
  }
  return OpaqueRealization.withCatalog(
    {
      _tag: 'ProjectAnalysis',
      ...(frontend.profile === undefined ? {} : { profile: frontend.profile }),
      roots: frontend.closure.rootModules,
      closure: frontend.closure,
      views,
      syntaxRevisions,
      surfaces: frontend.surfaces,
      semantics: frontend.semantics,
      toolingModules: tooling.toolingModules,
      semanticEnvironment: frontend.semanticEnvironment,
      semanticQueries: frontend.semanticQueries,
      semanticQueryCounters: frontend.semanticQueryCounters,
      semanticSession: frontend.session,
      semanticInvalidation: frontend.semanticInvalidation,
      report,
    },
    OpaqueRealization.catalogOf(unconfigured),
  )
})

/** Constructs one history-independent frontend analysis for the union closure of all roots. */
export const make = Effect.fn('ProjectAnalysis.make')(function* (
  roots: ReadonlyArray<string>,
  options: Options = {},
): Effect.fn.Return<
  ProjectAnalysis,
  ModuleClosure.ModuleClosureError,
  SourceResolver.SourceResolver
> {
  return yield* analyze(roots, undefined, options)
})

/** Constructs a new coherent project while reusing safe syntax from one completed prior project. */
export const revise = Effect.fn('ProjectAnalysis.revise')(function* (
  previous: ProjectAnalysis,
  roots: ReadonlyArray<string>,
  options: Options = {},
): Effect.fn.Return<
  ProjectAnalysis,
  ModuleClosure.ModuleClosureError,
  SourceResolver.SourceResolver
> {
  return yield* analyze(roots, previous, options)
})

/** Returns the requested root view, or `undefined` when it was not part of the project request. */
export const view = (self: ProjectAnalysis, rootModule: string): View | undefined =>
  self.views.get(rootModule)

/** Returns the one phase sequence that produced every root view. */
export const phases = (self: ProjectAnalysis): ReadonlyArray<PhaseReport.PhaseReport> => self.report
