import * as Canonical from './internal/Canonical.js'

/** Stable declaration identity shared by a lifetime binder and its semantic consumers. */
export interface Owner {
  readonly module: string
  readonly name: string
}

/** Validity independent of every finite caller region. It does not keep an owner alive. */
export interface Static {
  readonly _tag: 'StaticLifetime'
}

/** One universal declaration parameter; its name is presentation, not semantic identity. */
export interface Bound {
  readonly _tag: 'BoundLifetime'
  readonly owner: Owner
  readonly binder: ReadonlyArray<number>
  readonly ordinal: number
  readonly name: string
}

/** One inference variable scoped to a body and its already selected semantic context. */
export interface Local {
  readonly _tag: 'LocalLifetime'
  readonly owner: Owner
  readonly context: string
  readonly ordinal: number
}

/** A rigid invocation parameter which must not escape its comparison universe. */
export interface Placeholder {
  readonly _tag: 'PlaceholderLifetime'
  readonly parameter: Bound
  readonly universe: string
}

/** Static proof information; concrete loan identity and access belong to ownership analysis. */
export type Atom = Static | Bound | Local | Placeholder

/** Common validity of a finite set of independent regions; it extends none of its sources. */
export interface Intersection {
  readonly _tag: 'IntersectionLifetime'
  readonly members: ReadonlyArray<Atom>
}

export type Lifetime = Atom | Intersection

export const staticLifetime: Static = { _tag: 'StaticLifetime' }

export const bound = (
  owner: Owner,
  ordinal: number,
  name: string,
  binder: ReadonlyArray<number> = [],
): Bound => ({
  _tag: 'BoundLifetime',
  owner: { ...owner },
  binder: [...binder],
  ordinal,
  name: name.startsWith("'") ? name.slice(1) : name,
})

export const local = (owner: Owner, context: string, ordinal: number): Local => ({
  _tag: 'LocalLifetime',
  owner: { ...owner },
  context,
  ordinal,
})

export const placeholder = (parameter: Bound, universe: string): Placeholder => ({
  _tag: 'PlaceholderLifetime',
  parameter,
  universe,
})

/** Recognizes a region in an already typed discriminated semantic-argument union. */
export const isLifetime = (self: string | { readonly _tag: string }): self is Lifetime =>
  typeof self !== 'string' &&
  (self._tag === 'StaticLifetime' ||
    self._tag === 'BoundLifetime' ||
    self._tag === 'LocalLifetime' ||
    self._tag === 'PlaceholderLifetime' ||
    self._tag === 'IntersectionLifetime')

/** Enumerates constituent regions, including placeholders hidden by an intersection. */
export const atoms = (self: Lifetime): ReadonlyArray<Atom> =>
  self._tag === 'IntersectionLifetime' ? self.members : [self]

/** Forms an assumption-independent canonical intersection; static validity is its identity. */
export const intersection = (members: ReadonlyArray<Lifetime>): Lifetime => {
  const unique = new Map(
    members
      .flatMap(atoms)
      .filter((member) => member._tag !== 'StaticLifetime')
      .map((member) => [key(member), member]),
  )
  const ordered = [...unique]
    .sort(([left], [right]) => {
      if (left < right) return -1
      if (left > right) return 1
      return 0
    })
    .map(([, member]) => member)
  if (ordered.length === 0) return staticLifetime
  const sole = ordered.at(0)
  if (ordered.length === 1 && sole !== undefined) return sole
  return { _tag: 'IntersectionLifetime', members: ordered }
}

const ownerKey = (self: Owner): string => Canonical.record('Declaration', [self.module, self.name])

/**
 * Memoized in a non-enumerable property of the immutable lifetime object itself, invisible to
 * spreads, clones and structural comparison: most keyed lifetimes are fresh and keyed once, so a
 * weak map paid an ephemeron insertion per lifetime and grew a table every major GC traces.
 */
const cachedKey: unique symbol = Symbol('Lifetime.key')

/** Encodes proof identity without parameter spelling, source offsets or concrete referents. */
export const key = (self: Lifetime): string => {
  const cached: unknown = Reflect.get(self, cachedKey)
  if (typeof cached === 'string') return cached
  const identity = computeKey(self)
  if (Object.isExtensible(self)) Object.defineProperty(self, cachedKey, { value: identity })
  return identity
}

const computeKey = (self: Lifetime): string => {
  switch (self._tag) {
    case 'StaticLifetime':
      return 'static'
    case 'BoundLifetime':
      return Canonical.record('BoundLifetime', [
        ownerKey(self.owner),
        Canonical.array(self.binder.map(String)),
        String(self.ordinal),
      ])
    case 'LocalLifetime':
      return Canonical.record('LocalLifetime', [
        ownerKey(self.owner),
        self.context,
        String(self.ordinal),
      ])
    case 'PlaceholderLifetime':
      return Canonical.record('PlaceholderLifetime', [self.universe, key(self.parameter)])
    case 'IntersectionLifetime':
      return Canonical.record('IntersectionLifetime', self.members.map(key))
  }
}

export const equals = (self: Lifetime, other: Lifetime): boolean => key(self) === key(other)

/** Renders a source-facing lifetime; unresolved locals never masquerade as static validity. */
export const display = (self: Lifetime): string => {
  switch (self._tag) {
    case 'StaticLifetime':
      return "'static"
    case 'BoundLifetime':
      return `'${self.name}`
    case 'LocalLifetime':
      return `'_local${self.ordinal}`
    case 'PlaceholderLifetime':
      return display(self.parameter)
    case 'IntersectionLifetime':
      return self.members.map(display).join(' & ')
  }
}

export const substitute = (self: Lifetime, substitution: ReadonlyMap<string, Lifetime>): Lifetime =>
  substitution.get(key(self)) ??
  (self._tag === 'IntersectionLifetime'
    ? intersection(self.members.map((member) => substitute(member, substitution)))
    : self)

/** The longer region must contain every use required by the shorter region. */
export interface Outlives {
  readonly longer: Lifetime
  readonly shorter: Lifetime
}

export interface Assumptions {
  readonly bounds: ReadonlyArray<Outlives>
  readonly key: string
}

const outlivesKey = (self: Outlives): string =>
  Canonical.record('Outlives', [key(self.longer), key(self.shorter)])

const canonicalBounds = new WeakMap<ReadonlyArray<Outlives>, Assumptions>()
const assumptionEntries = new WeakMap<Assumptions, ReadonlyArray<readonly [string, Outlives]>>()

const fromAssumptionEntries = (
  entries: ReadonlyArray<readonly [string, Outlives]>,
): Assumptions => {
  const result = {
    bounds: entries.map(([, entry]) => entry),
    key: Canonical.array(entries.map(([identity]) => identity)),
  }
  canonicalBounds.set(result.bounds, result)
  assumptionEntries.set(result, entries)
  return result
}

const emptyAssumptions = fromAssumptionEntries([])

/** Canonicalizes declared and implied assumptions before contextual comparison memoization. */
export const assumptions = (bounds: ReadonlyArray<Outlives>): Assumptions => {
  if (bounds.length === 0) return emptyAssumptions
  const cached = canonicalBounds.get(bounds)
  if (cached !== undefined) return cached
  const entries = new Map(bounds.map((entry) => [outlivesKey(entry), { ...entry }]))
  const ordered = [...entries].sort(([left], [right]) => {
    if (left < right) return -1
    if (left > right) return 1
    return 0
  })
  return fromAssumptionEntries(ordered)
}

const entriesOfAssumptions = (self: Assumptions): ReadonlyArray<readonly [string, Outlives]> =>
  assumptionEntries.get(self) ??
  self.bounds
    .map((entry): readonly [string, Outlives] => [outlivesKey(entry), entry])
    .sort(([left], [right]) => {
      if (left < right) return -1
      if (left > right) return 1
      return 0
    })

/** Merges canonical assumption sets, retaining the right-hand bound on duplicate identities. */
export const mergeAssumptions = (self: Assumptions, other: Assumptions): Assumptions => {
  if (self === other || other.bounds.length === 0) return self
  if (self.bounds.length === 0) return other
  // Body elaboration repeatedly extends the same large module-wide set with a few local bounds.
  // Merge its sorted entries without copying/freezing every bound or sorting the entire set again.
  const left = entriesOfAssumptions(self)
  const right = entriesOfAssumptions(other)
  const merged: Array<readonly [string, Outlives]> = []
  let i = 0
  let j = 0
  while (i < left.length || j < right.length) {
    const a = left.at(i)
    const b = right.at(j)
    if (a !== undefined && (b === undefined || a[0] < b[0])) {
      merged.push(a)
      i += 1
    } else if (b !== undefined) {
      merged.push(b)
      j += 1
      if (a?.[0] === b[0]) i += 1
    }
  }
  if (merged.length === right.length && merged.every((entry, index) => entry === right.at(index)))
    return other
  if (merged.length === left.length && merged.every((entry, index) => entry === left.at(index)))
    return self
  return fromAssumptionEntries(merged)
}

const outlivesProofs = new WeakMap<Assumptions, Map<string, Map<string, boolean>>>()

/** Proves finite outlives relationships, including the introduction/elimination rules of meet. */
export const outlives = (self: Assumptions, longer: Lifetime, shorter: Lifetime): boolean => {
  if (longer._tag === 'StaticLifetime' || equals(longer, shorter)) return true
  const source = key(longer)
  const destination = key(shorter)
  const proofs = outlivesProofs.get(self) ?? new Map<string, Map<string, boolean>>()
  const successors = proofs.get(source) ?? new Map<string, boolean>()
  const cached = successors.get(destination)
  if (cached !== undefined) return cached
  const proven = proveOutlives(self, longer, shorter)
  successors.set(destination, proven)
  proofs.set(source, successors)
  outlivesProofs.set(self, proofs)
  return proven
}

interface OutlivesGraph {
  readonly predecessors: ReadonlyMap<string, ReadonlyArray<string>>
  readonly meetsByMember: ReadonlyMap<string, ReadonlyArray<string>>
  readonly meetSizes: ReadonlyMap<string, number>
}

const appendGraphEdge = (edges: Map<string, Array<string>>, from: string, to: string): void => {
  const entries = edges.get(from)
  if (entries === undefined) edges.set(from, [to])
  else entries.push(to)
}

const outlivesGraph = (
  bounds: ReadonlyArray<Outlives>,
  queries: ReadonlyArray<Lifetime> = [],
  existing?: OutlivesGraph,
): OutlivesGraph => {
  const predecessors = new Map<string, Array<string>>()
  const meetsByMember = new Map<string, Array<string>>()
  const meetSizes = new Map<string, number>()
  for (const region of [...queries, ...bounds.flatMap((bound) => [bound.longer, bound.shorter])]) {
    if (region._tag !== 'IntersectionLifetime') continue
    const identity = key(region)
    if (meetSizes.has(identity) || existing?.meetSizes.has(identity)) continue
    meetSizes.set(identity, region.members.length)
    for (const member of region.members) {
      const constituent = key(member)
      appendGraphEdge(predecessors, identity, constituent)
      appendGraphEdge(meetsByMember, constituent, identity)
    }
  }
  for (const bound of bounds) appendGraphEdge(predecessors, key(bound.shorter), key(bound.longer))
  return { predecessors, meetsByMember, meetSizes }
}

// Module elaboration asks thousands of questions against large immutable assumption sets.
// Reuse their reverse edges; query-only intersections stay in a separate graph so a proof
// never changes the assumptions seen by a later query.
const assumptionGraphs = new WeakMap<Assumptions, OutlivesGraph>()
const emptyOutlivesGraph = outlivesGraph([])

const proveOutlives = (self: Assumptions, longer: Lifetime, shorter: Lifetime): boolean => {
  let graph = assumptionGraphs.get(self)
  if (graph === undefined) {
    graph = self.bounds.length === 0 ? emptyOutlivesGraph : outlivesGraph(self.bounds)
    assumptionGraphs.set(self, graph)
  }
  const query =
    longer._tag === 'IntersectionLifetime' || shorter._tag === 'IntersectionLifetime'
      ? outlivesGraph([], [longer, shorter], graph)
      : emptyOutlivesGraph
  const source = key(longer)
  const proven = new Set([key(shorter), key(staticLifetime)])
  const pending = [...proven]
  const remaining = new Map<string, number>()
  // Work backwards from the requested shorter region. A bound propagates a proof to its
  // longer endpoint; a meet is proven only after all its constituents are proven. Static
  // validity is a seed for every query. Cycles cannot create a proof without a seed.
  for (let cursor = 0; cursor < pending.length; cursor += 1) {
    const current = pending.at(cursor)
    if (current === undefined) continue
    if (current === source) return true
    for (const selected of [graph, query]) {
      for (const predecessor of selected.predecessors.get(current) ?? []) {
        if (proven.has(predecessor)) continue
        proven.add(predecessor)
        pending.push(predecessor)
      }
      for (const meet of selected.meetsByMember.get(current) ?? []) {
        if (proven.has(meet)) continue
        const count = remaining.get(meet) ?? selected.meetSizes.get(meet)
        if (count === undefined) throw new RangeError('Lifetime meet lost its constituents')
        remaining.set(meet, count - 1)
        if (count !== 1) continue
        proven.add(meet)
        pending.push(meet)
      }
    }
  }
  return false
}

/**
 * A finite local region's forbidden points and the uses which demand its validity. A region is
 * available at every point of the domain outside `unavailable`: most regions stay available
 * almost everywhere, so the complement is the small set.
 */
export interface Region {
  readonly lifetime: Lifetime
  readonly unavailable: ReadonlySet<number>
  readonly required: ReadonlySet<number>
}

export interface Input {
  readonly pointCount: number
  readonly regions: ReadonlyArray<Region>
  readonly constraints: ReadonlyArray<Outlives>
  readonly activatedConstraints?: ReadonlyArray<Outlives & { readonly points: ReadonlySet<number> }>
}

export interface Work {
  readonly regions: number
  readonly constraints: number
  readonly requiredPoints: number
  readonly propagatedPoints: number
  readonly edgeVisits: number
}

export type Solution =
  | {
      readonly _tag: 'Solved'
      readonly required: ReadonlyMap<string, ReadonlySet<number>>
      readonly violations: ReadonlyArray<{
        readonly lifetime: Lifetime
        readonly point: number
      }>
      readonly work: Work
    }
  | {
      readonly _tag: 'InvalidDomain'
      readonly dimension: 'PointCount' | 'Point' | 'DuplicateRegion' | 'MissingRegion'
      readonly lifetime?: Lifetime
    }

/**
 * Computes the least required regions in an explicit finite body domain.
 *
 * Constraints only propagate existing program points. Missing inputs are rejected rather than
 * treated as unconstrained validity; the solver has no declaration or implementation resolver.
 */
export const solve = (input: Input): Solution => {
  if (!Number.isSafeInteger(input.pointCount) || input.pointCount < 0)
    return { _tag: 'InvalidDomain', dimension: 'PointCount' }
  const regions = new Map<string, Region>()
  const required = new Map<string, Set<number>>()
  const edges = new Map<
    string,
    Map<string, { readonly longer: string; readonly points?: ReadonlySet<number> }>
  >()
  const pending: Array<readonly [string, number]> = []
  for (const region of input.regions) {
    const identity = key(region.lifetime)
    if (regions.has(identity))
      return {
        _tag: 'InvalidDomain',
        dimension: 'DuplicateRegion',
        lifetime: region.lifetime,
      }
    for (const points of [region.unavailable, region.required])
      for (const point of points)
        if (!Number.isSafeInteger(point) || point < 0 || point >= input.pointCount)
          return {
            _tag: 'InvalidDomain',
            dimension: 'Point',
            lifetime: region.lifetime,
          }
    regions.set(identity, region)
    required.set(identity, new Set(region.required))
    for (const point of [...region.required].sort((left, right) => left - right))
      pending.push([identity, point])
  }
  const constraints: ReadonlyArray<Outlives & { readonly points?: ReadonlySet<number> }> = [
    ...input.constraints,
    ...input.regions.flatMap((region) =>
      region.lifetime._tag === 'IntersectionLifetime'
        ? region.lifetime.members.map((longer) => ({ longer, shorter: region.lifetime }))
        : [],
    ),
    ...(input.activatedConstraints ?? []),
  ]
  for (const constraint of constraints) {
    const longer = key(constraint.longer)
    const shorter = key(constraint.shorter)
    let absent: Lifetime | undefined
    if (!regions.has(longer)) absent = constraint.longer
    else if (!regions.has(shorter)) absent = constraint.shorter
    if (absent !== undefined)
      return {
        _tag: 'InvalidDomain',
        dimension: 'MissingRegion',
        lifetime: absent,
      }
    const points = constraint.points
    if (points !== undefined)
      for (const point of points)
        if (!Number.isSafeInteger(point) || point < 0 || point >= input.pointCount)
          return {
            _tag: 'InvalidDomain',
            dimension: 'Point',
            lifetime: constraint.longer,
          }
    const parents = edges.get(shorter) ?? new Map()
    parents.set(
      `${longer}:${points === undefined ? '*' : [...points].sort((a, b) => a - b).join(',')}`,
      { longer, ...(points === undefined ? {} : { points }) },
    )
    edges.set(shorter, parents)
  }
  const requiredPoints = pending.length
  let edgeVisits = 0
  for (let cursor = 0; cursor < pending.length; cursor += 1) {
    const fact = pending.at(cursor)
    if (fact === undefined) continue
    const [shorter, point] = fact
    for (const edge of edges.get(shorter)?.values() ?? []) {
      edgeVisits += 1
      if (edge.points !== undefined && !edge.points.has(point)) continue
      const points = required.get(edge.longer)
      if (points === undefined || points.has(point)) continue
      points.add(point)
      pending.push([edge.longer, point])
    }
  }
  const violations: Array<{ readonly lifetime: Lifetime; readonly point: number }> = []
  for (const [identity, region] of regions) {
    if (region.lifetime._tag === 'StaticLifetime') continue
    for (const point of [...(required.get(identity) ?? [])].sort((left, right) => left - right)) {
      if (region.unavailable.has(point)) violations.push({ lifetime: region.lifetime, point })
    }
  }
  return {
    _tag: 'Solved',
    required,
    violations: violations,
    work: {
      regions: regions.size,
      constraints: [...edges.values()].reduce((count, values) => count + values.size, 0),
      requiredPoints,
      propagatedPoints: pending.length - requiredPoints,
      edgeVisits,
    },
  }
}
