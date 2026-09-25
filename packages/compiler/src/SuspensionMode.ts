/** Static suspension capabilities retained for one exact executable specialization. */
export type Mode = 'NestedTransfer' | 'ExternalPark'

/** Why one mode is reachable, from the inspected executable to the sealed origin. */
export interface Cause {
  readonly mode: Mode
  readonly path: ReadonlyArray<string>
}

/**
 * The normalized target-neutral suspension summary.
 *
 * Direct execution is represented by an empty `modes` array. `Open` summaries retain every mode
 * permitted by an unresolved static contract; `Unavailable` summaries keep the causal node rather
 * than silently becoming direct.
 */
export interface Summary {
  readonly _tag: 'SuspensionModeSummary'
  readonly availability: 'Complete' | 'Open' | 'Unavailable'
  readonly modes: ReadonlyArray<Mode>
  readonly causes: ReadonlyArray<Cause>
}

/** One reachability graph whose roots are classified by suspension policy. */
export interface Graph {
  readonly roots: ReadonlyMap<Mode, ReadonlySet<string>>
  readonly dependencies: ReadonlyMap<string, ReadonlySet<string>>
  readonly permitted: ReadonlyMap<string, ReadonlySet<Mode>>
  readonly unavailable: ReadonlySet<string>
}

export const order: ReadonlyArray<Mode> = ['NestedTransfer', 'ExternalPark']

const compareText = (left: string, right: string): number => {
  if (left < right) {
    return -1
  }
  if (left > right) {
    return 1
  }
  return 0
}

const normalizeModes = (modes: Iterable<Mode>): ReadonlyArray<Mode> => {
  const retained = new Set(modes)
  return order.filter((mode) => retained.has(mode))
}

const comparePath = (left: ReadonlyArray<string>, right: ReadonlyArray<string>): number => {
  if (left.length !== right.length) return left.length - right.length
  return compareText(left.join('\0'), right.join('\0'))
}

/**
 * The first causal path from every node to `roots`: shortest, then lexicographic by node.
 *
 * A breadth-first distance to the nearest root, computed once over reversed edges, fixes each
 * node's successor on that path: the least-named dependency one step closer to a root. The path
 * of a node is therefore its successor's path with the node prepended, so the whole map costs one
 * graph traversal rather than one traversal per node.
 */
const pathsTo = (
  graph: Graph,
  roots: ReadonlySet<string>,
): ReadonlyMap<string, ReadonlyArray<string>> => {
  const reverse = new Map<string, Array<string>>()
  for (const [source, targets] of graph.dependencies)
    for (const target of targets) {
      const sources = reverse.get(target)
      if (sources === undefined) reverse.set(target, [source])
      else sources.push(source)
    }
  const distance = new Map<string, number>()
  const ordered: Array<string> = []
  for (const root of roots) {
    distance.set(root, 0)
    ordered.push(root)
  }
  for (let cursor = 0; cursor < ordered.length; cursor += 1) {
    const node = ordered[cursor]
    if (node === undefined) continue
    const next = (distance.get(node) ?? 0) + 1
    for (const source of reverse.get(node) ?? []) {
      if (distance.has(source)) continue
      distance.set(source, next)
      ordered.push(source)
    }
  }
  const paths = new Map<string, ReadonlyArray<string>>()
  for (const node of ordered) {
    const steps = distance.get(node) ?? 0
    if (steps === 0) {
      paths.set(node, [node])
      continue
    }
    let successor: string | undefined
    for (const target of graph.dependencies.get(node) ?? [])
      if (
        distance.get(target) === steps - 1 &&
        (successor === undefined || compareText(target, successor) < 0)
      )
        successor = target
    const rest = successor === undefined ? undefined : paths.get(successor)
    if (rest !== undefined) paths.set(node, [node, ...rest])
  }
  return paths
}

/** Computes one deterministic summary for every graph node. */
export const summarize = (graph: Graph): ReadonlyMap<string, Summary> => {
  const nodes = new Set<string>([
    ...graph.dependencies.keys(),
    ...[...graph.dependencies.values()].flatMap((targets) => [...targets]),
    ...[...graph.roots.values()].flatMap((roots) => [...roots]),
    ...graph.permitted.keys(),
    ...graph.unavailable,
  ])
  const summaries = new Map<string, Summary>()
  const paths = order.map(
    (mode) => [mode, pathsTo(graph, graph.roots.get(mode) ?? new Set<string>())] as const,
  )
  for (const node of [...nodes].sort(compareText)) {
    const causes: Array<Cause> = []
    for (const [mode, byNode] of paths) {
      const path = byNode.get(node)
      if (path !== undefined) causes.push({ mode, path })
    }
    const permitted = graph.permitted.get(node) ?? new Set<Mode>()
    const modes = normalizeModes([...causes.map((cause) => cause.mode), ...permitted])
    let availability: Summary['availability'] = 'Complete'
    if (graph.unavailable.has(node)) availability = 'Unavailable'
    else if (permitted.size > 0) availability = 'Open'
    summaries.set(node, {
      _tag: 'SuspensionModeSummary',
      availability,
      modes,
      causes: causes,
    })
  }
  return summaries
}

export const direct: Summary = {
  _tag: 'SuspensionModeSummary',
  availability: 'Complete',
  modes: [],
  causes: [],
}

/** Conservatively summarizes one unresolved executable contract from its sealed obligations. */
export const openExecutable = (
  staticProperties: ReadonlyArray<'Intrinsic.Detached' | 'Intrinsic.NonParking'>,
): Summary => ({
  _tag: 'SuspensionModeSummary',
  availability: 'Open',
  modes: staticProperties.includes('Intrinsic.NonParking')
    ? ['NestedTransfer']
    : (['NestedTransfer', 'ExternalPark'] as ReadonlyArray<Mode>),
  causes: [],
})

export const has = (self: Summary, mode: Mode): boolean => self.modes.includes(mode)

/** Joins summaries while retaining deterministic modes and causal paths. */
export const join = (inputs: ReadonlyArray<Summary>): Summary => {
  let availability: Summary['availability']
  if (inputs.some((input) => input.availability === 'Unavailable')) {
    availability = 'Unavailable'
  } else if (inputs.some((input) => input.availability === 'Open')) {
    availability = 'Open'
  } else {
    availability = 'Complete'
  }
  const causes = [
    ...new Map(
      inputs
        .flatMap((input) => input.causes)
        .map((cause) => [`${cause.mode}\0${cause.path.join('\0')}`, cause] as const),
    ).values(),
  ].sort(
    (left, right) =>
      order.indexOf(left.mode) - order.indexOf(right.mode) || comparePath(left.path, right.path),
  )
  return {
    _tag: 'SuspensionModeSummary',
    availability,
    modes: normalizeModes(inputs.flatMap((input) => input.modes)),
    causes: causes,
  }
}

/** Canonical inspection encoding; graph node identities retain the complete causal path. */
export const encode = (self: Summary): string =>
  `${self.availability}[${self.modes.join(',') || 'Direct'}]${
    self.causes.length === 0
      ? ''
      : `{${self.causes.map((cause) => `${cause.mode}:${cause.path.join(' -> ')}`).join(';')}}`
  }`
