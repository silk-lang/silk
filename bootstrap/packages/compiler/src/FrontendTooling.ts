import type * as ModuleClosure from './ModuleClosure.js'
import * as Effect from 'effect/Effect'
import type * as DeclarationIndex from './DeclarationIndex.js'
import type * as ModuleSemantics from './ModuleSemantics.js'
import * as ModuleTooling from './ModuleTooling.js'
import type * as ModuleSelection from './ModuleSelection.js'
import type * as NameResolution from './NameResolution.js'
import * as PhaseReport from './PhaseReport.js'
import * as SemanticOccurrence from './SemanticOccurrence.js'

/** Tooling indexes, reusable module artifacts, and observations for one completed frontend. */
export interface FrontendTooling {
  readonly toolingModules: ReadonlyMap<string, ModuleTooling.ModuleTooling>
  readonly semanticOccurrences: SemanticOccurrence.Index
  readonly anonymousExpressions: ReadonlyMap<
    string,
    ReadonlyArray<ModuleTooling.AnonymousExpression>
  >
  readonly report: ReadonlyArray<PhaseReport.PhaseReport>
}

/** Builds compiler-owned editor indexes, reusing modules backed by exact shared semantics. */
export const make = Effect.fn('FrontendTooling.make')(function* (
  frontend: {
    readonly selection?: ModuleSelection.ModuleSelection
    /** Loaded modules with their syntax, which import attribution reads spellings from. */
    readonly closure?: ModuleClosure.Facts
    readonly semantics: ReadonlyMap<string, ModuleSemantics.ModuleSemantics>
    readonly index: DeclarationIndex.Index
    readonly resolution: NameResolution.Resolution
    readonly report: ReadonlyArray<PhaseReport.PhaseReport>
  },
  previous?: ReadonlyMap<string, ModuleTooling.ModuleTooling>,
): Effect.fn.Return<FrontendTooling> {
  const toolingModules = new Map<string, ModuleTooling.ModuleTooling>()
  let occurrenceElapsedMs = 0
  let expressionElapsedMs = 0
  let reused = 0
  let ordinal = 0
  for (const [module, semantics] of frontend.semantics) {
    if (ordinal > 0 && ordinal % 8 === 0) yield* Effect.yieldNow
    const prior = previous?.get(module)
    if (prior?.module === module && prior.semantics === semantics) {
      toolingModules.set(module, prior)
      reused += 1
      ordinal += 1
      continue
    }
    const measuredOccurrences = yield* PhaseReport.measureEffect(
      'semantic-occurrences',
      1,
      Effect.sync(() =>
        ModuleTooling.semanticOccurrenceIndex(
          semantics,
          frontend.index,
          frontend.resolution.contexts,
          frontend.resolution,
          frontend.selection?.conditions.get(module),
          frontend.closure?.modules.find((candidate) => candidate.name === module)?.syntax,
        ),
      ),
      () => 1,
    )
    occurrenceElapsedMs += measuredOccurrences.report.elapsedMs
    const measuredExpressions = yield* PhaseReport.measureEffect(
      'anonymous-expressions',
      1,
      Effect.sync(() => ModuleTooling.anonymousExpressionIndex(semantics)),
      () => 1,
    )
    expressionElapsedMs += measuredExpressions.report.elapsedMs
    toolingModules.set(
      module,
      ModuleTooling.fromIndexes(semantics, measuredOccurrences.value, measuredExpressions.value),
    )
    ordinal += 1
  }

  const occurrenceModules = new Map(
    [...toolingModules].map(([module, tooling]) => [module, tooling.semanticOccurrences]),
  )
  const semanticOccurrences = SemanticOccurrence.compose(occurrenceModules)
  const anonymousExpressions = new Map(
    [...toolingModules].map(([module, tooling]) => [module, tooling.anonymousExpressions]),
  )
  const recomputed = toolingModules.size - reused
  const counters: PhaseReport.ModuleReuseCounters = {
    _tag: 'ModuleReuseCounters',
    reused,
    recomputed,
  }
  const report = [
    ...frontend.report,
    PhaseReport.make({
      phase: 'semantic-occurrences',
      elapsedMs: occurrenceElapsedMs,
      inputs: toolingModules.size,
      outputs: [...occurrenceModules.values()].reduce(
        (sum, module) => sum + module.occurrences.length,
        0,
      ),
      diagnostics: 0,
      counters,
    }),
    PhaseReport.make({
      phase: 'anonymous-expressions',
      elapsedMs: expressionElapsedMs,
      inputs: toolingModules.size,
      outputs: [...anonymousExpressions.values()].reduce((sum, entries) => sum + entries.length, 0),
      diagnostics: 0,
      counters,
    }),
  ]
  return {
    toolingModules,
    semanticOccurrences,
    anonymousExpressions,
    report: report,
  }
})
