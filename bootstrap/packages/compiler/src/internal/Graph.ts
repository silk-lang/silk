/**
 * One parameterized Tarjan strongly-connected-component (SCC) implementation.
 *
 * Every caller passes its own key set and neighbor projection so the fixed-point algorithm
 * stays in one place while the notion of "neighbor" is caller-specific. Sorting and cycle
 * filtering stay per-caller; this module only returns the raw components in deterministic
 * discovery order.
 */

/** Returns components in deterministic reverse-topological order (dependents first). */
export const stronglyConnected = (
  keys: Iterable<string>,
  dependencies: (key: string) => Iterable<string>,
): ReadonlyArray<ReadonlyArray<string>> => {
  const orderedKeys = [...new Set(keys)].sort()
  const known = new Set(orderedKeys)
  const adjacency = new Map(
    orderedKeys.map((key) => [
      key,
      [...new Set(dependencies(key))].filter((dependency) => known.has(dependency)).sort(),
    ]),
  )
  let nextIndex = 0
  const indices = new Map<string, number>()
  const lows = new Map<string, number>()
  const stack: Array<string> = []
  const stacked = new Set<string>()
  const components: Array<ReadonlyArray<string>> = []
  const visit = (key: string): void => {
    indices.set(key, nextIndex)
    lows.set(key, nextIndex)
    nextIndex += 1
    stack.push(key)
    stacked.add(key)
    for (const dependency of adjacency.get(key) ?? []) {
      if (!indices.has(dependency)) {
        visit(dependency)
        lows.set(key, Math.min(lows.get(key) ?? 0, lows.get(dependency) ?? 0))
      } else if (stacked.has(dependency)) {
        lows.set(key, Math.min(lows.get(key) ?? 0, indices.get(dependency) ?? 0))
      }
    }
    if (lows.get(key) !== indices.get(key)) return
    const component: Array<string> = []
    for (;;) {
      const member = stack.pop()
      if (member === undefined) break
      stacked.delete(member)
      component.push(member)
      if (member === key) break
    }
    component.sort()
    components.push(component)
  }
  for (const key of orderedKeys) if (!indices.has(key)) visit(key)
  return components
}
