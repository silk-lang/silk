import type * as SyntaxFile from './SyntaxFile.js'
import type * as DeclarationIndex from './DeclarationIndex.js'
import * as Elaboration from './Elaboration.js'
import type * as ModuleSemantics from './ModuleSemantics.js'
import type * as NameResolution from './NameResolution.js'
import * as SemanticDisplay from './SemanticDisplay.js'
import * as SemanticOccurrence from './SemanticOccurrence.js'
import type * as SourceSpan from './SourceSpan.js'
import * as SemanticContext from './SemanticContext.js'
import type * as Type from './Type.js'
import * as Tir from './Tir.js'

/** One available anonymous expression type cached for position fallback. */
export interface AnonymousExpression {
  readonly span: SourceSpan.SourceSpan
  readonly type: Type.Type
  readonly presentation?: SemanticDisplay.Presentation
}

/** One module's immutable editor indexes and their exact semantic input. */
export interface ModuleTooling {
  readonly _tag: 'ModuleTooling'
  readonly module: string
  readonly semantics: ModuleSemantics.ModuleSemantics
  readonly semanticOccurrences: SemanticOccurrence.ModuleIndex
  readonly anonymousExpressions: ReadonlyArray<AnonymousExpression>
}

/** Returns every expression nested under one statement in deterministic source order. */
export const statementExpressions = (statement: Tir.Statement): ReadonlyArray<Tir.Expression> =>
  Tir.statementExpressions(statement).flatMap(Tir.expressionTree)

/** Builds one module's anonymous-expression entries. */
export const anonymousExpressionIndex = (
  semantics: ModuleSemantics.ModuleSemantics,
): ReadonlyArray<AnonymousExpression> => {
  const context = SemanticContext.make(semantics.elaboration.authored)
  const found = new Map<string, AnonymousExpression>()
  for (const body of semantics.elaboration.bodies) {
    if (body.hidden) continue
    for (const row of body.results.tooling?.expressionTypes ?? []) {
      const span = context.spanOf(row.at)
      found.set(`${span.start}:${span.end}`, {
        span,
        type: row.type,
        ...(row.presentation === undefined ? {} : { presentation: row.presentation }),
      })
    }
  }
  return [...found.values()].sort(
    (left, right) =>
      left.span.start - right.span.start ||
      left.span.end - left.span.start - (right.span.end - right.span.start),
  )
}

/** Builds one module's semantic-occurrence index. */
export const semanticOccurrenceIndex = (
  semantics: ModuleSemantics.ModuleSemantics,
  index: DeclarationIndex.Index,
  spans: SemanticContext.Registry,
  resolution: NameResolution.Resolution,
  conditions: ReadonlyArray<Elaboration.ExpressionDecision> = [],
  syntax?: SyntaxFile.SyntaxFile,
): SemanticOccurrence.ModuleIndex =>
  SemanticOccurrence.makeModule(
    semantics.module,
    semantics.elaboration,
    index,
    spans,
    resolution,
    conditions,
    syntax,
  )

/** Closes already-built module indexes into one reusable tooling artifact. */
export const fromIndexes = (
  semantics: ModuleSemantics.ModuleSemantics,
  semanticOccurrences: SemanticOccurrence.ModuleIndex,
  anonymousExpressions: ReadonlyArray<AnonymousExpression>,
): ModuleTooling => ({
  _tag: 'ModuleTooling',
  module: semantics.module,
  semantics,
  semanticOccurrences,
  anonymousExpressions,
})
