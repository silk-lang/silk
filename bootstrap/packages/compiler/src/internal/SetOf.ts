/** One immutable set of primitives for the compiler's ownership layer. */

/** True when the two sets contain exactly the same elements. */
export const equal = <T>(left: ReadonlySet<T>, right: ReadonlySet<T>): boolean =>
  left.size === right.size && [...left].every((element) => right.has(element))

/** The union of any number of sets as a fresh mutable set. */
export const union = <T>(...sets: ReadonlyArray<ReadonlySet<T>>): Set<T> =>
  new Set(sets.flatMap((set) => [...set]))

/** The intersection of two sets as a new frozen set. */
export const intersection = <T>(left: ReadonlySet<T>, right: ReadonlySet<T>): ReadonlySet<T> =>
  new Set([...left].filter((element) => right.has(element)))
