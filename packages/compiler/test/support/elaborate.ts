import * as Effect from 'effect/Effect'
import * as Diagnostic from '../../src/Diagnostic.js'
import * as SemanticContext from '../../src/SemanticContext.js'
import * as Semantic from '../../src/Semantic.js'
import * as AuthoredIdentity from '../../src/AuthoredIdentity.js'
import * as AuthoredLowering from '../../src/AuthoredLowering.js'
import * as Elaboration from '../../src/Elaboration.js'
import type * as DeclarationIndex from '../../src/DeclarationIndex.js'
import * as ModuleClosure from '../../src/ModuleClosure.js'
import * as NameResolution from '../../src/NameResolution.js'
import * as Ownership from '../../src/Ownership.js'
import type * as SyntaxFile from '../../src/SyntaxFile.js'
import { records, type InspectedBody } from './records.js'

const indices = new WeakMap<Elaboration.Result, DeclarationIndex.Index>()

export const indexOf = (elaborated: Elaborated): DeclarationIndex.Index => {
  const index = indices.get(elaborated.located)
  if (index === undefined) throw new RangeError('Elaboration fixture lost its declaration index')
  return index
}

/** `fixture://semantic-accepted.silk` becomes `fixture/semantic-accepted.silk`. */
export const canonicalName = (sourceId: string): string => sourceId.replace(/:\/*/g, '/')

/**
 * An elaboration as a test reads it: diagnostics carry this fixture's spans.
 *
 * `located` is the revision-free result itself, for a test that hands it to a later stage.
 */
export type Elaborated = Omit<Elaboration.Result, 'diagnostics'> & {
  /** The checked TIR bodies these tests examine. */
  readonly functions: ReadonlyArray<InspectedBody>
  readonly hiddenFunctions: ReadonlyArray<InspectedBody>
  readonly diagnostics: ReadonlyArray<Diagnostic.Diagnostic>
  readonly located: Elaboration.Result
}

export const elaborate = (syntax: SyntaxFile.SyntaxFile): Elaborated => {
  // Fixture ids such as `fixture://x.silk` are not canonical module names, so the closure module,
  // its authored owner and every declaration identity share one canonical name derived from the id.
  const name = canonicalName(syntax.source.id)
  const authored = Effect.runSync(
    AuthoredLowering.lower(syntax, AuthoredIdentity.module('memory', name)),
  )
  const module = Object.freeze({
    _tag: 'Module' as const,
    name,
    syntax,
    authored,
    declarations: ModuleClosure.selectedDeclarations(authored.module, new Map()),
    imports: Object.freeze([]),
  })
  const closure: ModuleClosure.Closure = Object.freeze({
    _tag: 'ModuleClosure',
    rootModule: name,
    modules: Object.freeze([module]),
    cycles: Object.freeze([]),
    diagnostics: Object.freeze([]),
    sources: new Map([[name, syntax.source]]),
    missingRoots: Object.freeze([]),
    resolutionFailures: Object.freeze([]),
  })
  const analyzed = NameResolution.analyze(closure)
  const index = analyzed.index
  const headers = index.modules.at(0)
  const scope = NameResolution.scopeOf(analyzed.resolution, name)
  if (headers === undefined || scope === undefined)
    throw new RangeError('Single-module elaboration fixture lost its module')
  // Fixtures assert editor results beside compiled ones, so they check bodies for tooling.
  const session = Semantic.makeSession(name, index, analyzed.resolution, { tooling: true })
  const result = Elaboration.elaborateModule({ authored, headers, scope, index, session })
  const inspected = records(result)
  indices.set(result, index)
  return Object.freeze({
    ...result,
    ...inspected,
    // Published the way the frontend publishes: spans first, then the one deterministic order.
    diagnostics: Diagnostic.merge(
      Diagnostic.publishAll(
        result.diagnostics,
        SemanticContext.registryOf(SemanticContext.make(authored)),
      ),
    ),
    located: result,
  })
}

export const ownership = (elaborated: Elaborated): Ownership.ModuleOwnership => {
  const result = elaborated.located
  const index = indices.get(result)
  if (index === undefined)
    throw new RangeError('Ownership fixture requires its original elaboration result')
  return Ownership.checkModule(
    result,
    index,
    Ownership.localSharedAccessBoundaryPlan(
      new Map([[result.authored.presentation.sourceId, result]]),
    ),
  )
}
