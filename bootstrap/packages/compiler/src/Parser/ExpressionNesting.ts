/** Maximum number of active parent-to-child expression edges. */
export const limit = 256

/** The outer expression has no parent expression and therefore starts at depth zero. */
export const root = 0

/** Derives one child depth without mutating the parent used by sibling expressions. */
export const child = (parent: number): number => parent + 1

/** True only after the public expression-nesting limit has been crossed. */
export const exceedsLimit = (depth: number): boolean => depth > limit
