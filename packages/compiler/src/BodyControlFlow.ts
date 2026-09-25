import type * as AuthoredHir from './AuthoredHir.js'
import * as AuthoredIdentity from './AuthoredIdentity.js'
import * as Elaboration from './Elaboration.js'
import * as BodyBuilder from './BodyBuilder.js'
import * as Tir from './Tir.js'
import type * as SemanticContext from './SemanticContext.js'
import type * as SourceSpan from './SourceSpan.js'
import * as Type from './Type.js'

/** Evaluation boundaries for one retained authored position. */
export interface Boundary {
  readonly before: number
  readonly after: number
}

/**
 * Points reachable from one start: bit `point & 31` of word `point >>> 5`. Answers stay cached for
 * the life of the graph, and a bitset is a small fraction of a `Set<number>` of the same points.
 */
export type Reachable = Uint32Array

/** Whether a reachability answer contains one point. */
export const includes = (self: Reachable, point: number): boolean =>
  (((self[point >>> 5] ?? 0) >>> (point & 31)) & 1) === 1

/** Finite semantic control flow, independent of source offsets and backend lowering. */
export interface BodyControlFlow {
  readonly boundaries: ReadonlyMap<string, Boundary>
  /** The authored node behind each boundary key, and behind each write's installation point. */
  readonly anchors: ReadonlyMap<string, AuthoredHir.Anchor>
  readonly writeAnchors: ReadonlyMap<string, number>
  /** `boundaries` and `writeAnchors` by the span their nodes have in one revision. */
  readonly spans: ReadonlyMap<string, Boundary>
  readonly writes: ReadonlyMap<string, number>
  readonly edges: ReadonlyArray<ReadonlyArray<number>>
  /** Answered reachability by start point, then by barrier (-1 for none, or a sorted list). */
  readonly queries: Map<number, Map<number | string, Reachable>>
  readonly work: { queries: number; cacheHits: number; visitedEdges: number }
}

// Spans are immutable and ownership probes the same span objects repeatedly.
const spanKeys = new WeakMap<SourceSpan.SourceSpan, string>()
const spanKey = (span: SourceSpan.SourceSpan): string => {
  let key = spanKeys.get(span)
  if (key === undefined) {
    key = `${span.sourceId}:${span.start}:${span.end}`
    spanKeys.set(span, key)
  }
  return key
}
const loopKey = (loop: Tir.LoopId): string =>
  `${loop.function.sourceId}:${loop.function.ordinal}:${loop.ordinal}`

/** Builds structured branch exits and loop backedges once for one authored body. */
export const make = (
  context: SemanticContext.SemanticContext,
  statements: ReadonlyArray<Tir.Statement>,
  root: AuthoredHir.Anchor,
): BodyControlFlow => {
  const edges: Array<Array<number>> = []
  const boundaries = new Map<string, Boundary>()
  const anchors = new Map<string, AuthoredHir.Anchor>()
  const writeAnchors = new Map<string, number>()
  const spans = new Map<string, Boundary>()
  const writes = new Map<string, number>()
  const point = (): number => {
    edges.push([])
    return edges.length - 1
  }
  const edge = (from: number, to: number): void => {
    edges.at(from)?.push(to)
  }
  const boundary = (anchor: AuthoredHir.Anchor): Boundary => {
    const key = AuthoredIdentity.anchorKey(anchor)
    const found = boundaries.get(key)
    if (found !== undefined) return found
    const value = { before: point(), after: point() }
    boundaries.set(key, value)
    anchors.set(key, anchor)
    spans.set(spanKey(context.spanOf(anchor)), value)
    return value
  }
  type Loops = ReadonlyMap<string, { readonly exit: number; readonly repeat: number }>
  type ConstructionExpression = Elaboration.ExpressionDecision | Tir.Expression
  type ConstructionStatement = Tir.Statement
  const expression = (value: ConstructionExpression, next: number, loops: Loops): number => {
    const own = boundary(Elaboration.constructionExpressionAnchor(value))
    const expressionType = Elaboration.constructionExpressionType(value)
    if (expressionType._tag !== 'Available' || !Type.isNever(expressionType.type))
      edge(own.after, next)
    if (value._tag === 'Match') {
      const dispatch = point()
      let fallback = own.after
      for (const arm of [...value.arms].reverse()) {
        if (!arm.reachable) continue
        const armBody =
          arm.body._tag === 'Expression'
            ? expression(arm.body.expression, own.after, loops)
            : sequence(arm.body.statements, own.after, loops)
        let selected = armBody
        if (arm.guard !== undefined) {
          const choice = point()
          edge(choice, armBody)
          edge(choice, fallback)
          selected = expression(arm.guard, choice, loops)
        }
        const entered = boundary(
          'anchor' in arm
            ? arm.anchor
            : (arm.at ?? Elaboration.constructionExpressionAnchor(value)),
        )
        edge(entered.before, selected)
        edge(dispatch, entered.before)
        fallback = entered.before
      }
      edge(own.before, expression(value.scrutinee, dispatch, loops))
    } else if (value._tag === 'ShortCircuit') {
      const first = 'origin' in value ? value.left : value.arguments.at(0)?.expression
      const second = 'origin' in value ? value.right : value.arguments.at(1)?.expression
      const choice = point()
      edge(choice, own.after)
      if (second !== undefined) edge(choice, expression(second, own.after, loops))
      edge(own.before, first === undefined ? choice : expression(first, choice, loops))
    } else if (value._tag === 'EffectBlock') {
      // Deferred bodies have their own entry; creation does not execute their statements.
      sequence(value.statements, point(), new Map())
      let start = own.after
      if (!('origin' in value))
        for (const capture of [...value.captures].reverse())
          if (capture.expression !== undefined) start = expression(capture.expression, start, loops)
      edge(own.before, start)
    } else {
      let start = own.after
      for (const child of [...Elaboration.expressionChildren(value)].reverse())
        start = expression(child, start, loops)
      edge(own.before, start)
    }
    return own.before
  }
  const sequence = (
    values: ReadonlyArray<ConstructionStatement>,
    next: number,
    loops: Loops,
  ): number => {
    let start = next
    for (const statement of [...values].reverse()) {
      const anchor = statement.origin.anchor
      const own = boundary(anchor)
      const previous = start
      start = own.before
      if (statement._tag === 'Return' || statement._tag === 'Fail') {
        edge(own.before, expression(statement.expression, own.after, loops))
      } else if (statement._tag === 'Break' || statement._tag === 'Continue') {
        const target =
          statement.target === undefined ? undefined : loops.get(loopKey(statement.target))
        edge(own.before, own.after)
        if (target !== undefined)
          edge(own.after, statement._tag === 'Break' ? target.exit : target.repeat)
      } else if (statement._tag === 'While') {
        const choice = point()
        const condition = expression(statement.condition, choice, loops)
        const nested = new Map(loops).set(loopKey(statement.loop), {
          exit: own.after,
          repeat: condition,
        })
        const body = sequence(statement.body, condition, nested)
        const boolean =
          statement.condition._tag === 'BooleanLiteral' ? statement.condition.value : undefined
        if (boolean !== false) edge(choice, body)
        if (boolean !== true) edge(choice, own.after)
        edge(own.before, condition)
        edge(own.after, previous)
      } else if (statement._tag === 'If' || statement._tag === 'IfLet') {
        const choice = point()
        const test =
          statement._tag === 'If'
            ? statement.condition
            : (statement.selection.source ?? statement.selection.subject)
        const taken = sequence(statement.taken, own.after, loops)
        const otherwise = sequence(statement.otherwise, own.after, loops)
        const boolean = test._tag === 'BooleanLiteral' ? test.value : undefined
        if (boolean !== false) edge(choice, taken)
        if (boolean !== true) edge(choice, otherwise)
        edge(own.before, expression(test, choice, loops))
        edge(own.after, previous)
      } else if (statement._tag === 'Unsafe') {
        edge(own.before, sequence(statement.statements, own.after, loops))
        edge(own.after, previous)
      } else {
        let evaluated = own.after
        const values: ReadonlyArray<ConstructionExpression> =
          BodyBuilder.directStatementExpressions(statement)
        for (const value of [...values].reverse()) evaluated = expression(value, evaluated, loops)
        if (statement._tag === 'Write') {
          const destination = statement.destination?.origin.anchor ?? statement.place.origin.anchor
          anchors.set(AuthoredIdentity.anchorKey(destination), destination)
          writeAnchors.set(AuthoredIdentity.anchorKey(destination), own.after)
          writes.set(spanKey(context.spanOf(destination)), own.after)
        }
        edge(own.before, evaluated)
        edge(own.after, previous)
      }
    }
    return start
  }
  const body = boundary(root)
  edge(body.before, sequence(statements, body.after, new Map()))
  return {
    boundaries,
    anchors,
    writeAnchors,
    spans,
    writes,
    // Exact-size copies: each successor list was grown by push (17 slots for one edge), and the
    // graph lives with its function's lifetime flow.
    edges: edges.map((successors) => successors.slice()),
    queries: new Map(),
    work: { queries: 0, cacheHits: 0, visitedEdges: 0 },
  }
}

/**
 * The same control flow under another revision's presentation.
 *
 * Boundaries belong to authored nodes. Only the span index over them belongs to a revision, so it
 * is rebuilt and nothing else changes.
 */
export const present = (
  self: BodyControlFlow,
  context: SemanticContext.SemanticContext,
): BodyControlFlow => {
  const spans = new Map<string, Boundary>()
  const writes = new Map<string, number>()
  for (const [key, value] of self.boundaries) {
    const anchor = self.anchors.get(key)
    if (anchor !== undefined) spans.set(spanKey(context.spanOf(anchor)), value)
  }
  for (const [key, value] of self.writeAnchors) {
    const anchor = self.anchors.get(key)
    if (anchor !== undefined) writes.set(spanKey(context.spanOf(anchor)), value)
  }
  return {
    ...self,
    spans,
    writes,
    queries: new Map([...self.queries].map(([from, answers]) => [from, new Map(answers)])),
    work: { queries: 0, cacheHits: 0, visitedEdges: 0 },
  }
}

/** The graph without what one revision derived from it: positions and answered queries. */
export const content = (self: BodyControlFlow): BodyControlFlow => ({
  ...self,
  spans: new Map(),
  writes: new Map(),
  queries: new Map(),
  work: { queries: 0, cacheHits: 0, visitedEdges: 0 },
})

/** Finds an exact semantic boundary; unexecuted annotation syntax has none. */
export const at = (self: BodyControlFlow, span: SourceSpan.SourceSpan): Boundary | undefined =>
  self.spans.get(spanKey(span))

/** Resolves the installation point of a writable place after its RHS has evaluated. */
export const writeAt = (self: BodyControlFlow, span: SourceSpan.SourceSpan): number | undefined =>
  self.writes.get(spanKey(span))

/**
 * Every point reachable from one start without passing a barrier, computed lazily and reused for
 * every later query from the same start and barriers.
 */
export const reachable = (
  self: BodyControlFlow,
  from: number,
  barrier?: number | ReadonlyArray<number>,
): Reachable => {
  self.work.queries += 1
  // Ownership asks the same few (start, barrier) pairs many thousand times: key the cache by
  // numbers, allocating a key only for a list of barriers.
  let key: number | string = -1
  if (typeof barrier === 'number') key = barrier
  else if (barrier !== undefined)
    key = [...new Set(barrier)].sort((left, right) => left - right).join(',')
  let answers = self.queries.get(from)
  if (answers === undefined) {
    answers = new Map()
    self.queries.set(from, answers)
  }
  const cached = answers.get(key)
  if (cached !== undefined) {
    self.work.cacheHits += 1
    return cached
  }
  const barriers = new Set(typeof barrier === 'number' ? [barrier] : (barrier ?? []))
  const pending = [from]
  const visited: Reachable = new Uint32Array((self.edges.length + 31) >>> 5)
  while (pending.length > 0) {
    const current = pending.pop()
    if (current === undefined || barriers.has(current) || includes(visited, current)) continue
    visited[current >>> 5] = (visited[current >>> 5] ?? 0) | (1 << (current & 31))
    for (const next of self.edges.at(current) ?? []) {
      self.work.visitedEdges += 1
      pending.push(next)
    }
  }
  answers.set(key, visited)
  return visited
}

/** Lazily reuses reachability from requested starts; barriers stop re-creation of a loan. */
export const reaches = (
  self: BodyControlFlow,
  from: number,
  to: number,
  barrier?: number | ReadonlyArray<number>,
): boolean => includes(reachable(self, from, barrier), to)
