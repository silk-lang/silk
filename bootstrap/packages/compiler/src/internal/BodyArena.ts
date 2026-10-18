import * as AuthoredIdentity from '../AuthoredIdentity.js'
import type * as Diagnostic from '../Diagnostic.js'
import type * as Location from '../Location.js'
import type * as SourceSpan from '../SourceSpan.js'
import * as Tir from '../Tir.js'

/** Private, single-use construction state for one checked artifact. */
export interface BodyBuilder {
  readonly artifact: Tir.ArtifactId
  readonly nodes: Array<Tir.PublishedNode | undefined>
  readonly locals: Array<Tir.Local>
  readonly evidence: Array<Tir.SelectedEvidence>
  readonly causes: Array<Diagnostic.Identity<Location.Location>>
  readonly localIds: Map<string, Tir.LocalId>
  readonly semanticLocals: Map<number, unknown>
  readonly expressions: WeakMap<object, Tir.Expression>
  readonly semanticExpressions: WeakMap<Tir.Expression, object>
  readonly semanticPatternSelections: WeakMap<Tir.PatternSelection, object>
  readonly reservedExpressions: Map<string, Tir.NodeId>
}

export const make = (artifact: Tir.ArtifactId): BodyBuilder => ({
  artifact,
  nodes: [],
  locals: [],
  evidence: [],
  causes: [],
  localIds: new Map(),
  semanticLocals: new Map(),
  expressions: new WeakMap(),
  semanticExpressions: new WeakMap(),
  semanticPatternSelections: new WeakMap(),
  reservedExpressions: new Map(),
})

const semanticLocalKey = (input: unknown): string | undefined => {
  if (typeof input !== 'object' || input === null) return undefined
  const id = input as Readonly<Record<string, unknown>>
  const nested = id['id']
  if (nested !== undefined) {
    const key = semanticLocalKey(nested)
    if (key !== undefined) return key
  }
  const tag = id['_tag']
  const ordinal = id['ordinal']
  if (typeof ordinal !== 'number') return undefined
  if (tag === 'ParameterId' || tag === 'TirBinding') {
    const owner = id['function'] as Readonly<Record<string, unknown>> | undefined
    return owner === undefined
      ? undefined
      : `${String(tag)}:${String(owner['sourceId'])}:${String(owner['ordinal'])}:${ordinal}`
  }
  if (tag === 'PatternBindingId') {
    const arm = id['arm'] as Readonly<Record<string, unknown>> | undefined
    const match = arm?.['match'] as Readonly<Record<string, unknown>> | undefined
    const node = match?.['node'] as Tir.NodeRef | undefined
    return node === undefined || arm === undefined
      ? undefined
      : `PatternBindingId:${Tir.nodeRefKey(node)}:${String(arm['ordinal'])}:${ordinal}`
  }
  return undefined
}

/** Reserves the next dense artifact-local identity before a node constructs its children. */
export const reserve = (self: BodyBuilder): Tir.NodeId => {
  const id = { _tag: 'TirNode' as const, ordinal: self.nodes.length }
  self.nodes.push(undefined)
  return id
}

/** Publishes a node under an identity this builder reserved for it. */
export const publish = <
  A extends { readonly origin: Tir.Origin; readonly span: SourceSpan.SourceSpan },
>(
  self: BodyBuilder,
  id: Tir.NodeId,
  value: A,
): Readonly<A & Tir.Node> => {
  const result = {
    ...value,
    id,
  }
  if (self.nodes[id.ordinal] !== undefined)
    throw new RangeError(`TIR node n${id.ordinal} was published more than once`)
  self.nodes[id.ordinal] = result
  return result
}

/** Completes a published node when its enclosing construct supplies parent-owned context. */
export const revise = <A extends { readonly id?: Tir.NodeId }>(
  self: BodyBuilder,
  node: A,
  value: Partial<Omit<A, 'id'>>,
): A => {
  if (node.id === undefined || !Object.is(self.nodes[node.id.ordinal], node))
    throw new RangeError(
      node.id === undefined
        ? 'TIR node was not published by a body builder'
        : `TIR node n${node.id.ordinal} does not belong to this body builder`,
    )
  Object.assign(node, value)
  return node
}

/** Publishes one leaf node and assigns the next dense artifact-local identity. */
export const node = <
  A extends { readonly origin: Tir.Origin; readonly span: SourceSpan.SourceSpan },
>(
  self: BodyBuilder,
  value: A,
): Readonly<A & Tir.Node> => publish(self, reserve(self), value)

/** Returns an unambiguous reference to a node already published by this builder. */
export const reference = (self: BodyBuilder, value: Tir.PublishedNode): Tir.NodeRef => ({
  artifact: self.artifact,
  node: value.id,
})

/** Returns an unambiguous reference to a node identity reserved by this builder. */
export const reservedReference = (self: BodyBuilder, node: Tir.NodeId): Tir.NodeRef => ({
  artifact: self.artifact,
  node,
})

/** Reserves the node owned by an authored expression before its semantic decision is complete. */
export const expressionReference = (
  self: BodyBuilder,
  anchor: AuthoredIdentity.Anchor,
): Tir.NodeRef => {
  const key = AuthoredIdentity.anchorKey(anchor)
  const known = self.reservedExpressions.get(key)
  if (known !== undefined) return reservedReference(self, known)
  const node = reserve(self)
  self.reservedExpressions.set(key, node)
  return reservedReference(self, node)
}

/** Claims a node reserved by expressionReference, or reserves an ordinary expression node. */
export const expressionNode = (self: BodyBuilder, anchor: AuthoredIdentity.Anchor): Tir.NodeId => {
  const key = AuthoredIdentity.anchorKey(anchor)
  const known = self.reservedExpressions.get(key)
  if (known === undefined) return reserve(self)
  self.reservedExpressions.delete(key)
  return known
}

/** Adds one local to the body's unified dense namespace. */
export const local = (self: BodyBuilder, value: Omit<Tir.Local, 'id'>): Tir.Local => {
  const result = {
    ...value,
    id: { _tag: 'TirLocal' as const, ordinal: self.locals.length },
  }
  self.locals.push(result)
  return result
}

/** Registers or retrieves one semantic local in the body's unified namespace. */
export const semanticLocal = (
  self: BodyBuilder,
  semantic: unknown,
  value: Omit<Tir.Local, 'id'>,
): Tir.LocalId => {
  const key = semanticLocalKey(semantic)
  if (key === undefined) throw new RangeError('TIR local has no semantic construction identity')
  const known = self.localIds.get(key)
  if (known !== undefined) {
    self.semanticLocals.set(known.ordinal, semantic)
    return known
  }
  const registered = local(self, value)
  self.localIds.set(key, registered.id)
  self.semanticLocals.set(registered.id.ordinal, semantic)
  return registered.id
}

/** Recovers a construction-only semantic local while the builder is alive. */
export const semanticOfLocal = (self: BodyBuilder, local: Tir.LocalId): unknown =>
  self.semanticLocals.get(local.ordinal)

/** Recovers the construction-only semantic decision that published one typed node. */
export const semanticOfExpression = (self: BodyBuilder, expression: Tir.Expression): unknown =>
  self.semanticExpressions.get(expression)

/** Resolves a semantic construction identity after its local has been registered. */
export const localId = (self: BodyBuilder, semantic: unknown): Tir.LocalId => {
  const key = semanticLocalKey(semantic)
  const known = key === undefined ? undefined : self.localIds.get(key)
  if (known === undefined)
    throw new RangeError(`TIR referenced an unregistered local: ${key ?? 'unknown identity'}`)
  return known
}

/** Stores selected conformance evidence once and returns its dense table reference. */
export const selectedEvidence = (
  self: BodyBuilder,
  value: Tir.SelectedEvidence,
): Tir.EvidenceRef => {
  const ref = { _tag: 'TirEvidence' as const, ordinal: self.evidence.length }
  self.evidence.push({
    constraints: Array.from(value.constraints),
    conformances: Array.from(value.conformances),
  })
  return ref
}

/** Stores one revision-free unavailable cause and returns its dense table reference. */
export const cause = (
  self: BodyBuilder,
  value: Diagnostic.Identity<Location.Location>,
): Tir.CauseRef => {
  const ref = { _tag: 'TirCause' as const, ordinal: self.causes.length }
  self.causes.push(value)
  return ref
}

/** Closes one directly constructed body without walking or renumbering its executable tree. */
export const finish = (self: BodyBuilder, fn: Tir.TirFunction): Tir.TirFunction => {
  const nodes = self.nodes.map((value, ordinal) => {
    if (value === undefined)
      throw new RangeError(`TIR node n${ordinal} was reserved but not published`)
    if (value.id.ordinal !== ordinal)
      throw new RangeError(`TIR node n${ordinal} was published under n${value.id.ordinal}`)
    return value
  })
  return {
    ...fn,
    artifact: self.artifact,
    nodes: nodes,
    locals: Array.from(self.locals),
  }
}
