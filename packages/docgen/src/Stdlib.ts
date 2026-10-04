import type * as ModuleClosure from '@silklang/compiler/ModuleClosure'
import * as ProjectAnalysis from '@silklang/compiler/ProjectAnalysis'
import * as SourceResolver from '@silklang/compiler/SourceResolver'
import * as CompilerStdlib from '@silklang/compiler/Stdlib'
import * as Arr from 'effect/Array'
import * as Effect from 'effect/Effect'
import * as DocumentationProject from './Project.js'
import type * as Sources from './Sources.js'

/**
 * Documentation for the compiler-shipped standard library, and the source lookup that goes with it.
 *
 * Every manifest entry is a project root, so the compiler can analyze their union once while still
 * covering modules that are not reachable from one distinguished root. Coverage follows the
 * manifest, so a module added to the library is doctested without anything here being edited.
 */

/** Answers with the compiler-shipped bytes of a standard-library module. */
export const sources: Sources.Lookup = (sourceId) => CompilerStdlib.sources.get(sourceId)

/**
 * Builds documentation for every standard-library module, private declarations included.
 *
 * Private declarations are documented here because a doctest cares about whether an example
 * compiles, not about whether its declaration is part of the published surface.
 */
export const documentation = Effect.fn('Stdlib.documentation')(function* (
  target: string,
): Effect.fn.Return<DocumentationProject.Project, ModuleClosure.ModuleClosureError> {
  const roots = Arr.map(CompilerStdlib.manifest, (entry) => entry.module)
  const analysis = yield* ProjectAnalysis.make(roots, {
    configuration: { profile: { target } },
  }).pipe(Effect.provide(SourceResolver.empty))
  return DocumentationProject.fromProjectAnalysis(analysis, { includePrivate: true })
})
