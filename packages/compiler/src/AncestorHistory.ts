/** One canonical set of complete ancestor assignments in a discovery-local catalog. */
export interface History {
  readonly id: number
  readonly variable?: string
  readonly branches: ReadonlyMap<string | undefined, History>
}

/** Interned decision nodes; an omitted declaration always means an absent ancestor. */
export interface AncestorHistory {
  readonly empty: History
  readonly initial: History
  readonly nodes: Map<string, History>
  readonly unions: Map<string, History>
  /** `set` results by history, variable, and value; interned nodes make every result final. */
  readonly assignments: Map<string, History>
  /** `partition` results by history and variable. */
  readonly partitions: Map<string, ReadonlyMap<string | undefined, History>>
  /** `project` results by retained set identity, then history; retained sets are never mutated. */
  readonly projections: WeakMap<ReadonlySet<string>, Map<number, History>>
  /** Variable and value texts as small integers, so node keys are cheap and injective. */
  readonly atoms: Map<string, number>
}

export const make = (): AncestorHistory => ({
  empty: { id: 0, branches: new Map() },
  initial: { id: 1, branches: new Map() },
  nodes: new Map(),
  unions: new Map(),
  assignments: new Map(),
  partitions: new Map(),
  projections: new WeakMap(),
  atoms: new Map(),
})

const atom = (self: AncestorHistory, text: string | undefined): number => {
  if (text === undefined) return 0
  let id = self.atoms.get(text)
  if (id === undefined) {
    id = self.atoms.size + 1
    self.atoms.set(text, id)
  }
  return id
}

// Branch values are ordered absent first, then by string; a map built by `node` is already ordered.
const compareValues = (a: string | undefined, b: string | undefined): number => {
  if (a === b) return 0
  if (a === undefined) return -1
  if (b === undefined) return 1
  return a < b ? -1 : 1
}

const intern = (
  self: AncestorHistory,
  variable: string,
  key: string,
  branches: ReadonlyMap<string | undefined, History>,
): History => {
  const result: History = { id: self.nodes.size + 2, variable, branches }
  self.nodes.set(key, result)
  return result
}

/** One branch, the common shape in `set` and `partition`, built without an intermediate map. */
const single = (
  self: AncestorHistory,
  variable: string,
  value: string | undefined,
  child: History,
): History => {
  if (child === self.empty) return self.empty
  if (value === undefined) return child
  const key = `${atom(self, variable)}:${atom(self, value)}=${child.id}`
  return self.nodes.get(key) ?? intern(self, variable, key, new Map([[value, child]]))
}

const node = (
  self: AncestorHistory,
  variable: string,
  branches: ReadonlyMap<string | undefined, History>,
  ordered: boolean,
): History => {
  const entries: Array<[string | undefined, History]> = []
  for (const entry of branches) if (entry[1] !== self.empty) entries.push(entry)
  if (entries.length === 0) return self.empty
  if (entries.length === 1) return single(self, variable, entries[0]![0], entries[0]![1])
  if (!ordered) entries.sort((a, b) => compareValues(a[0], b[0]))
  let key = `${atom(self, variable)}`
  for (const [value, child] of entries) key += `:${atom(self, value)}=${child.id}`
  const prior = self.nodes.get(key)
  if (prior !== undefined) return prior
  const retained = ordered && entries.length === branches.size ? branches : new Map(entries)
  return intern(self, variable, key, retained)
}

/** Unites exact assignments without mixing values from different histories. */
export const union = (self: AncestorHistory, left: History, right: History): History => {
  if (left === right || right === self.empty) return left
  if (left === self.empty) return right
  const key = left.id < right.id ? `${left.id}:${right.id}` : `${right.id}:${left.id}`
  const cached = self.unions.get(key)
  if (cached !== undefined) return cached
  let variable = left.variable
  if (variable === undefined || (right.variable !== undefined && right.variable < variable))
    variable = right.variable
  if (variable === undefined) return self.initial
  const branches = new Map<string | undefined, History>()
  if (left.variable === variable)
    for (const [value, child] of left.branches) branches.set(value, child)
  else branches.set(undefined, left)
  if (right.variable === variable)
    for (const [value, child] of right.branches) {
      const existing = branches.get(value)
      branches.set(value, existing === undefined ? child : union(self, existing, child))
    }
  else branches.set(undefined, union(self, branches.get(undefined) ?? self.empty, right))
  const result = node(self, variable, branches, false)
  self.unions.set(key, result)
  return result
}

/** Overwrites one declaration in every assignment, retaining all other correlations. */
export const set = (
  self: AncestorHistory,
  history: History,
  variable: string,
  value: string,
): History => {
  const key = `${history.id}:${atom(self, variable)}=${atom(self, value)}`
  const cached = self.assignments.get(key)
  if (cached !== undefined) return cached
  const memo = new Map<number, History>()
  const visit = (current: History): History => {
    if (current === self.empty) return current
    const prior = memo.get(current.id)
    if (prior !== undefined) return prior
    let result: History
    if (current.variable === undefined || current.variable > variable)
      result = single(self, variable, value, current)
    else if (current.variable === variable) {
      let suffix = self.empty
      for (const child of current.branches.values()) suffix = union(self, suffix, child)
      result = single(self, variable, value, suffix)
    } else {
      const branches = new Map<string | undefined, History>()
      for (const [branch, child] of current.branches) branches.set(branch, visit(child))
      result = node(self, current.variable, branches, true)
    }
    memo.set(current.id, result)
    return result
  }
  const result = visit(history)
  self.assignments.set(key, result)
  return result
}

/** Partitions by one ancestor while preserving the complete correlated assignments. */
export const partition = (
  self: AncestorHistory,
  history: History,
  variable: string,
): ReadonlyMap<string | undefined, History> => {
  const key = `${history.id}:${atom(self, variable)}`
  const cached = self.partitions.get(key)
  if (cached !== undefined) return cached
  const memo = new Map<number, ReadonlyMap<string | undefined, History>>()
  const visit = (current: History): ReadonlyMap<string | undefined, History> => {
    if (current === self.empty) return new Map()
    const prior = memo.get(current.id)
    if (prior !== undefined) return prior
    const result = new Map<string | undefined, History>()
    if (current.variable === undefined || current.variable > variable)
      result.set(undefined, current)
    else if (current.variable === variable) {
      for (const [value, child] of current.branches)
        result.set(value, single(self, variable, value, child))
    } else {
      // Branches are visited in order, so each group's branch map is built already ordered.
      const groups = new Map<string | undefined, Map<string | undefined, History>>()
      for (const [branch, child] of current.branches) {
        for (const [value, suffix] of visit(child)) {
          let branches = groups.get(value)
          if (branches === undefined) {
            branches = new Map()
            groups.set(value, branches)
          }
          branches.set(branch, suffix)
        }
      }
      for (const [value, branches] of groups)
        result.set(value, node(self, current.variable, branches, true))
    }
    memo.set(current.id, result)
    return result
  }
  const result = visit(history)
  self.partitions.set(key, result)
  return result
}

/**
 * Forgets every declaration outside `keep`, uniting the assignments that differed only there.
 * Results are retained per `keep` identity, so a caller must never mutate a set it projected onto.
 */
export const project = (
  self: AncestorHistory,
  history: History,
  keep: ReadonlySet<string>,
): History => {
  // Every visited node's projection onto the same set is final, so the visit memo persists.
  const memo = self.projections.get(keep) ?? new Map<number, History>()
  if (memo.size === 0) self.projections.set(keep, memo)
  const visit = (current: History): History => {
    if (current.variable === undefined) return current
    const prior = memo.get(current.id)
    if (prior !== undefined) return prior
    let result: History
    if (keep.has(current.variable)) {
      const branches = new Map<string | undefined, History>()
      for (const [branch, child] of current.branches) branches.set(branch, visit(child))
      result = node(self, current.variable, branches, true)
    } else {
      result = self.empty
      for (const child of current.branches.values()) result = union(self, result, visit(child))
    }
    memo.set(current.id, result)
    return result
  }
  return visit(history)
}
