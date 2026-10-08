import type * as Diagnostic from './Diagnostic.js'
import type * as Elaboration from './Elaboration.js'
import type * as Location from './Location.js'
import type * as LifetimeFlow from './LifetimeFlow.js'
import * as Match from './Match.js'
import * as StatementAnalysis from './StatementAnalysis.js'
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

/** Diagnostic payload rows can outlive their references; availability follows reachable runtime nodes. */
export const hasUnavailable = (self: BodyView): boolean => {
  const expression = (value: Tir.Expression): boolean => {
    if (value._tag === 'Unavailable') return true
    if (value._tag === 'EffectBlock') return statements(value.statements)
    if (value._tag === 'Match') {
      if (expression(value.scrutinee)) return true
      if (!StatementAnalysis.expressionReturnFlow(value.scrutinee).fallsThrough) return false
      let remaining = [...value.members]
      for (const arm of value.arms) {
        const selected = remaining.filter(
          (candidate) =>
            arm.universal || (arm.member !== undefined && Match.selects(arm.member, candidate)),
        )
        if (!arm.reachable || selected.length === 0) continue
        if (arm.guard !== undefined && expression(arm.guard)) return true
        const guardCompletes =
          arm.guard === undefined || StatementAnalysis.expressionReturnFlow(arm.guard).fallsThrough
        remaining = remaining.filter((candidate) =>
          arm.after.some((member) => Match.identityEquals(candidate, member)),
        )
        if (!guardCompletes && (arm.tests?.length ?? 0) === 0)
          remaining = remaining.filter((candidate) => !selected.includes(candidate))
        if (!guardCompletes) continue
        if (
          arm.body._tag === 'Expression'
            ? expression(arm.body.expression)
            : statements(arm.body.statements)
        )
          return true
      }
      return false
    }
    const children =
      value._tag === 'BuiltinCall' && value.operation === 'NativeAssembly'
        ? value.arguments.slice(6)
        : Tir.expressionChildren(value)
    for (const child of children) {
      if (expression(child)) return true
      if (!StatementAnalysis.expressionReturnFlow(child).fallsThrough) break
    }
    return false
  }
  const statements = (items: ReadonlyArray<Tir.Statement>): boolean => {
    for (const statement of StatementAnalysis.executableStatements(items)) {
      if (statement._tag === 'UnavailableStatement') return true
      if (statement._tag === 'Unsafe') {
        if (statements(statement.statements)) return true
      } else if (statement._tag === 'If' || statement._tag === 'IfLet') {
        const subject = statement._tag === 'If' ? statement.condition : statement.selection.subject
        if (expression(subject)) return true
        if (
          StatementAnalysis.expressionReturnFlow(subject).fallsThrough &&
          (statements(statement.taken) || statements(statement.otherwise))
        )
          return true
      } else if (statement._tag === 'While') {
        if (expression(statement.condition)) return true
        if (
          StatementAnalysis.expressionReturnFlow(statement.condition).fallsThrough &&
          statements(statement.body)
        )
          return true
      } else {
        for (const child of Tir.statementExpressions(statement)) {
          if (expression(child)) return true
          if (!StatementAnalysis.expressionReturnFlow(child).fallsThrough) break
        }
      }
    }
    return false
  }
  return statements(self.function.statements)
}
