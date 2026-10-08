import type * as Diagnostic from './Diagnostic.js'
import type * as Elaboration from './Elaboration.js'
import type * as Location from './Location.js'
import type * as LifetimeFlow from './LifetimeFlow.js'
import * as Tir from './Tir.js'

/** The read-only semantic input shared by evaluation and every post-construction consumer. */
export interface BodyView {
  readonly artifact: Tir.ArtifactId
  readonly function: Tir.TirFunction
  readonly evidence: ReadonlyArray<Tir.SelectedEvidence>
  readonly causes: ReadonlyArray<Diagnostic.Identity<Location.Location>>
  /** Held source region proof, independent of per-call copied view metadata. */
  readonly lifetimes?: LifetimeFlow.LifetimeFlow
}

export const make = (
  body: Pick<Elaboration.CheckedBody, 'artifact' | 'function' | 'results'>,
): BodyView => ({
  artifact: body.artifact,
  function: body.function,
  evidence: body.results.evidence,
  causes: body.results.causes,
  ...(body.results.lifetimes === undefined ? {} : { lifetimes: body.results.lifetimes }),
})

export const node = (
  self: BodyView,
  ref: Tir.NodeId | Tir.NodeRef,
): Tir.PublishedNode | undefined =>
  'artifact' in ref && Tir.artifactKey(ref.artifact) !== Tir.artifactKey(self.artifact)
    ? undefined
    : Tir.nodeOf(self.function, 'artifact' in ref ? ref.node : ref)

export const local = (self: BodyView, ref: Tir.LocalId): Tir.Local | undefined =>
  Tir.localOf(self.function, ref)

export const selectedEvidence = (
  self: BodyView,
  ref: Tir.EvidenceRef,
): Tir.SelectedEvidence | undefined => self.evidence.at(ref.ordinal)

export const cause = (
  self: BodyView,
  ref: Tir.CauseRef,
): Diagnostic.Identity<Location.Location> | undefined => self.causes.at(ref.ordinal)

/** Diagnostic payload rows can outlive their references; availability follows held runtime nodes. */
export const hasUnavailable = (self: BodyView): boolean => {
  const seen = new Set<Tir.Statement>()
  const visit = (statements: ReadonlyArray<Tir.Statement>): boolean => {
    for (const statement of statements) {
      if (seen.has(statement)) continue
      seen.add(statement)
      if (statement._tag === 'UnavailableStatement') return true
      if (statement._tag === 'Unsafe' && visit(statement.statements)) return true
      if (statement._tag === 'While' && visit(statement.body)) return true
      if (
        (statement._tag === 'If' || statement._tag === 'IfLet') &&
        (visit(statement.taken) || visit(statement.otherwise))
      )
        return true
      for (const expression of Tir.statementExpressions(statement).flatMap(
        Tir.runtimeExpressionTree,
      )) {
        if (expression._tag === 'Unavailable') return true
        if (expression._tag === 'EffectBlock' && visit(expression.statements)) return true
        if (expression._tag === 'Match')
          for (const arm of expression.arms)
            if (arm.body._tag === 'Block' && visit(arm.body.statements)) return true
      }
    }
    return false
  }
  return visit(self.function.statements)
}
