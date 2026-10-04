import * as Effect from 'effect/Effect'
import * as Frontend from './Frontend.js'
import type * as DeclarationIndex from './DeclarationIndex.js'
import type * as ModuleClosure from './ModuleClosure.js'
import type * as SourceResolver from './SourceResolver.js'
import * as Analysis from './Analysis.js'
import type * as CompilationProfile from './CompilationProfile.js'
import * as Canonical from './internal/Canonical.js'
import * as ModuleSummary from './ModuleSummary.js'
import type * as ProjectAnalysis from './ProjectAnalysis.js'
import * as SourceFile from './SourceFile.js'
import * as ToolchainIntegrity from './ToolchainIntegrity.js'

/** Importable selected source facts for one completed compilation profile. */
export interface SourceCatalog {
  readonly profile: CompilationProfile.CompilationProfile
  readonly identity: string
  readonly modules: ReadonlyMap<string, ModuleSummary.ModuleSummary>
}

const projectCatalog = (
  closure: ModuleClosure.ProjectClosure,
  profile: CompilationProfile.CompilationProfile,
  index: DeclarationIndex.Index,
  previous?: ReadonlyMap<string, ModuleSummary.ModuleSummary>,
): SourceCatalog => {
  const modules = new Map(
    closure.modules.map((module) => {
      const selected = ModuleSummary.selected(module, index)
      const prior = previous?.get(module.name)
      const reusable =
        prior !== undefined &&
        SourceFile.equals(prior.source, selected.source) &&
        JSON.stringify(prior.imports) === JSON.stringify(selected.imports) &&
        JSON.stringify(prior.publicDeclarations) === JSON.stringify(selected.publicDeclarations)
      return [module.name, reusable ? prior : selected] as const
    }),
  )
  const identity = ToolchainIntegrity.contentDigest(
    Canonical.record('SourceCatalog', [
      profile.identity,
      ...[...modules]
        .sort(([a], [b]) => Canonical.compare(a, b))
        .map(([name, summary]) =>
          Canonical.record(name, [
            ToolchainIntegrity.contentDigest(SourceFile.toUint8Array(summary.source)),
            ...summary.publicDeclarations.map((declaration) =>
              Canonical.record(declaration.spelling, [
                declaration.declarationKind,
                declaration.selectionSpan.sourceId,
                String(declaration.selectionSpan.start),
              ]),
            ),
          ]),
        ),
    ]),
  )
  return { profile, identity, modules }
}

/** Projects a compiler analysis without performing a second source-selection pass. */
export const fromProject = (
  project: ProjectAnalysis.ProjectAnalysis,
  previous?: ReadonlyMap<string, ModuleSummary.ModuleSummary>,
): SourceCatalog | undefined =>
  project.profile === undefined
    ? undefined
    : projectCatalog(
        project.closure,
        project.profile,
        Analysis.declarationIndex(project.primary),
        previous,
      )

export interface Selection {
  readonly closure: ModuleClosure.ProjectClosure
  readonly catalog?: SourceCatalog
}

/** Selects catalog headers through the same compiler bootstrap as ordinary compilation. */
export const analyze = Effect.fn('SourceCatalog.analyze')(function* (
  request: ModuleClosure.ProjectRequest,
  previous?: SourceCatalog,
): Effect.fn.Return<Selection, ModuleClosure.ModuleClosureError, SourceResolver.SourceResolver> {
  const selected = yield* Frontend.selectProject(request)
  return {
    closure: selected.closure,
    ...(selected.profile === undefined
      ? {}
      : {
          catalog: projectCatalog(
            selected.closure,
            selected.profile,
            selected.headers.index,
            previous?.modules,
          ),
        }),
  }
})
