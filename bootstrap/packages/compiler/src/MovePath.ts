import * as Result from 'effect/Result'

/** A source-independent selector within one canonical ownership root. */
export type Selector =
  | { readonly _tag: 'Field'; readonly ordinal: number }
  | { readonly _tag: 'ConstantIndex'; readonly index: number }
  | { readonly _tag: 'Variant'; readonly ordinal: number }

/** An owned projection; dereferences and runtime-selected indices are deliberately absent. */
export type Path = ReadonlyArray<Selector>

/** Initialization of a complete subtree, inherited by its unmentioned children. */
export type Initialization = 'Initialized' | 'Missing' | 'Maybe'

/** Immediate shape only: fixed arrays never allocate a node per element. */
export type Shape =
  | { readonly _tag: 'Leaf' }
  | {
      readonly _tag: 'Fields'
      readonly fields: ReadonlyArray<number>
      readonly dropBoundary: boolean
    }
  | { readonly _tag: 'Array'; readonly length: number }
  | {
      readonly _tag: 'Variants'
      readonly variants: ReadonlyArray<number>
      readonly dropBoundary: boolean
    }

/** Resolves an immediate shape on demand, without expanding recursive nominal definitions. */
export type ShapeOf = (path: Path) => Shape | undefined

/**
 * One persistent sparse tree. The owning function maps canonical root identities to these trees.
 * An initialized parent with missing children is distinct from a consumed parent: only the
 * former admits restoration of individual children.
 */
export interface State {
  readonly initialization: Initialization
  readonly children: ReadonlyArray<{ readonly selector: Selector; readonly state: State }>
  readonly activeVariant?: number
  readonly discriminant?: Initialization
}

/** Structural partial initialization is neither complete nor empty and need not be conditional. */
export interface Inspection {
  readonly state: State
  readonly complete: boolean
  readonly empty: boolean
  readonly conditional: boolean
  readonly discriminant?: Initialization
}

/** Finite transition failures; source provenance and diagnostics belong to the caller. */
export interface TransitionFailure {
  readonly _tag:
    | 'InvalidPath'
    | 'MissingAncestor'
    | 'UnrefinedVariant'
    | 'DropBoundary'
    | 'NotInitialized'
    | 'Terminated'
  readonly path: Path
}

/** Starts one complete, missing, or conditionally present ownership root. */
export const make = (initialization: Initialization = 'Initialized'): State => ({
  initialization,
  children: [],
})

const selectorKey = (self: Selector): string => {
  switch (self._tag) {
    case 'Field':
      return `f${self.ordinal}`
    case 'ConstantIndex':
      return `i${self.index}`
    case 'Variant':
      return `v${self.ordinal}`
  }
}

const compareSelectors = (left: Selector, right: Selector): number => {
  const a = selectorKey(left)
  const b = selectorKey(right)
  if (a === b) return 0
  return a < b ? -1 : 1
}

/** Encodes only semantic selector positions, never source offsets or diagnostic spellings. */
export const key = (self: Path): string => self.map(selectorKey).join('/')

/** Tests whether either path contains the other; different known elements are disjoint. */
export const overlaps = (self: Path, other: Path): boolean =>
  self.slice(0, Math.min(self.length, other.length)).every((selector, ordinal) => {
    const candidate = other.at(ordinal)
    return candidate !== undefined && selectorKey(selector) === selectorKey(candidate)
  })

/** Tests canonical semantic state equality for finite control-flow fixed points. */
export const equivalent = (self: State, other: State): boolean =>
  self.initialization === other.initialization &&
  self.activeVariant === other.activeVariant &&
  self.discriminant === other.discriminant &&
  self.children.length === other.children.length &&
  self.children.every((child, ordinal) => {
    const candidate = other.children.at(ordinal)
    return (
      candidate !== undefined &&
      selectorKey(child.selector) === selectorKey(candidate.selector) &&
      equivalent(child.state, candidate.state)
    )
  })

const childOf = (self: State, selector: Selector): State =>
  self.children.find((child) => selectorKey(child.selector) === selectorKey(selector))?.state ??
  make(self.initialization)

const failure = (tag: TransitionFailure['_tag'], path: Path): TransitionFailure => ({
  _tag: tag,
  path: [...path],
})

const validSelector = (shape: Shape, selector: Selector): boolean => {
  if (selector._tag === 'Field')
    return shape._tag === 'Fields' && shape.fields.includes(selector.ordinal)
  if (selector._tag === 'Variant')
    return shape._tag === 'Variants' && shape.variants.includes(selector.ordinal)
  return (
    shape._tag === 'Array' &&
    Number.isSafeInteger(selector.index) &&
    selector.index >= 0 &&
    selector.index < shape.length
  )
}

const resolve = (
  self: State,
  path: Path,
  shapeOf: ShapeOf,
  consuming: boolean,
): Result.Result<State, TransitionFailure> => {
  let current = self
  let prefix: Path = []
  for (const selector of path) {
    const shape = shapeOf(prefix)
    if (shape === undefined || !validSelector(shape, selector))
      return Result.fail(failure('InvalidPath', [...prefix, selector]))
    if (current.initialization !== 'Initialized')
      return Result.fail(failure('MissingAncestor', prefix))
    if (consuming && 'dropBoundary' in shape && shape.dropBoundary)
      return Result.fail(failure('DropBoundary', prefix))
    if (
      selector._tag === 'Variant' &&
      (current.activeVariant !== selector.ordinal ||
        (current.discriminant ?? current.initialization) !== 'Initialized')
    )
      return Result.fail(failure('UnrefinedVariant', prefix))
    current = childOf(current, selector)
    prefix = [...prefix, selector]
  }
  return shapeOf(path) === undefined
    ? Result.fail(failure('InvalidPath', path))
    : Result.succeed(current)
}

const summarize = (self: State, path: Path, shapeOf: ShapeOf): Inspection => {
  const shape = shapeOf(path)
  const children = self.children.filter(
    (child) =>
      shape !== undefined &&
      validSelector(shape, child.selector) &&
      (shape._tag !== 'Variants' ||
        self.activeVariant === undefined ||
        (child.selector._tag === 'Variant' && child.selector.ordinal === self.activeVariant)),
  )
  const nested = children.map((child) => summarize(child.state, [...path, child.selector], shapeOf))
  let cardinality = 0
  if (shape?._tag === 'Fields') cardinality = shape.fields.length
  else if (shape?._tag === 'Array') cardinality = shape.length
  else if (shape?._tag === 'Variants')
    cardinality = self.activeVariant === undefined ? shape.variants.length : 1
  const inherited = cardinality === 0 || children.length < cardinality
  const discriminant =
    shape?._tag === 'Variants' ? (self.discriminant ?? self.initialization) : undefined
  return {
    state: self,
    complete:
      self.initialization === 'Initialized' &&
      nested.every((child) => child.complete) &&
      (discriminant === undefined || discriminant === 'Initialized'),
    empty:
      (!inherited || self.initialization === 'Missing') && nested.every((child) => child.empty),
    conditional:
      self.initialization === 'Maybe' ||
      discriminant === 'Maybe' ||
      nested.some((child) => child.conditional),
    ...(discriminant === undefined ? {} : { discriminant }),
  }
}

/** Inspects a selected subtree without requiring its payload to be complete. */
export const inspect = (
  self: State,
  path: Path,
  shapeOf: ShapeOf,
): Result.Result<Inspection, TransitionFailure> =>
  Result.map(resolve(self, path, shapeOf, false), (state) => summarize(state, path, shapeOf))

const update = (self: State, path: Path, replacement: State): State => {
  const [selector, ...rest] = path
  if (selector === undefined) return replacement
  const next = update(childOf(self, selector), rest, replacement)
  const children = self.children.filter(
    (child) => selectorKey(child.selector) !== selectorKey(selector),
  )
  if (!equivalent(next, make(self.initialization))) children.push({ selector, state: next })
  children.sort((left, right) => compareSelectors(left.selector, right.selector))
  return {
    ...self,
    children: children.map((child) => child),
  }
}

/** Consumes a complete owned subtree, including explicitly moved Copy values. */
export const consume = (
  self: State,
  path: Path,
  shapeOf: ShapeOf,
): Result.Result<State, TransitionFailure> =>
  Result.flatMap(resolve(self, path, shapeOf, true), (selected) =>
    summarize(selected, path, shapeOf).complete
      ? Result.succeed(update(self, path, make('Missing')))
      : Result.fail(failure('NotInitialized', path)),
  )

/** Installs a complete value; projecting through a consumed ancestor is forbidden. */
export const restore = (
  self: State,
  path: Path,
  shapeOf: ShapeOf,
): Result.Result<State, TransitionFailure> =>
  Result.map(resolve(self, path, shapeOf, false), () => update(self, path, make()))

const withoutRefinement = (self: State): State => ({
  initialization: self.initialization,
  children: self.children.map((child) => ({
    selector: child.selector,
    state: withoutRefinement(child.state),
  })),
  ...(self.discriminant === undefined ? {} : { discriminant: self.discriminant }),
})

const stateAt = (self: State, path: Path): State => {
  let current = self
  for (const selector of path) current = childOf(current, selector)
  return current
}

/**
 * Forgets every discriminant proof within a selected subtree whose value may have been replaced
 * without being tracked here, such as through an exclusive borrow or an unknown index. A
 * `match place` binding refined from that subtree then no longer names a place of it (MATCH-001).
 */
export const unrefine = (self: State, path: Path): State =>
  update(self, path, withoutRefinement(stateAt(self, path)))

/** Terminates an entire selected place, permitting exact cleanup of a partial remainder. */
export const terminate = (
  self: State,
  path: Path,
  shapeOf: ShapeOf,
): Result.Result<State, TransitionFailure> =>
  Result.flatMap(resolve(self, path, shapeOf, true), (selected) =>
    selected.initialization === 'Missing'
      ? Result.fail(failure('Terminated', path))
      : Result.succeed(update(self, path, make('Missing'))),
  )

/** Establishes one arm's discriminant proof without consuming or borrowing its payload. */
export const refine = (
  self: State,
  path: Path,
  variant: number,
  shapeOf: ShapeOf,
): Result.Result<State, TransitionFailure> =>
  Result.flatMap(resolve(self, path, shapeOf, false), (selected) => {
    const shape = shapeOf(path)
    if (shape?._tag !== 'Variants' || !shape.variants.includes(variant))
      return Result.fail(failure('InvalidPath', path))
    if ((selected.discriminant ?? selected.initialization) !== 'Initialized')
      return Result.fail(failure('NotInitialized', path))
    if (selected.activeVariant !== undefined && selected.activeVariant !== variant)
      return Result.fail(failure('UnrefinedVariant', path))
    return Result.succeed(update(self, path, { ...selected, activeVariant: variant }))
  })

const joinInitialization = (states: ReadonlyArray<Initialization>): Initialization => {
  const first = states.at(0) ?? 'Missing'
  return states.every((state) => state === first) ? first : 'Maybe'
}

const joinAt = (states: ReadonlyArray<State>, path: Path, shapeOf: ShapeOf): State => {
  const first = states.at(0)
  if (first !== undefined && states.every((state) => state === first)) return first
  const initialization = joinInitialization(states.map((state) => state.initialization))
  const shape = shapeOf(path)
  const selectors = new Map<string, Selector>()
  const indexed = states.map((state) => ({
    state,
    children: new Map(state.children.map((child) => [selectorKey(child.selector), child.state])),
  }))
  for (const state of states)
    for (const child of state.children) selectors.set(selectorKey(child.selector), child.selector)
  // Refinement makes alternatives mutually exclusive. Each finite variant joins only its
  // feasible predecessors; fixed-array indices still come solely from sparse overrides.
  if (shape?._tag === 'Variants' && states.some((state) => state.activeVariant !== undefined))
    for (const ordinal of shape.variants) {
      const selector: Selector = { _tag: 'Variant', ordinal }
      selectors.set(selectorKey(selector), selector)
    }
  const firstVariant = states.at(0)?.activeVariant
  const activeVariant =
    firstVariant !== undefined && states.every((state) => state.activeVariant === firstVariant)
      ? firstVariant
      : undefined
  const children = [...selectors.values()].flatMap((selector) => {
    const feasible = indexed.filter(
      ({ state }) =>
        selector._tag !== 'Variant' ||
        state.activeVariant === undefined ||
        state.activeVariant === selector.ordinal,
    )
    if (feasible.length === 0) return []
    const state = joinAt(
      feasible.map(
        (candidate) =>
          candidate.children.get(selectorKey(selector)) ?? make(candidate.state.initialization),
      ),
      [...path, selector],
      shapeOf,
    )
    return equivalent(state, make(initialization)) ? [] : [{ selector, state }]
  })
  children.sort((left, right) => compareSelectors(left.selector, right.selector))
  const discriminant =
    shape?._tag === 'Variants'
      ? joinInitialization(states.map((state) => state.discriminant ?? state.initialization))
      : undefined
  return {
    initialization,
    children: children.map((child) => child),
    ...(activeVariant === undefined ? {} : { activeVariant }),
    ...(discriminant === undefined || discriminant === initialization ? {} : { discriminant }),
  }
}

/** Joins continuing predecessors in a finite per-path lattice, without enumerating array slots. */
export const join = (states: ReadonlyArray<State>, shapeOf: ShapeOf): State =>
  states.length === 0 ? make('Missing') : joinAt(states, [], shapeOf)

/** Encodes exact inherited state and sparse overrides for inspection artifacts. */
export const encodeState = (state: State): string => {
  const variant = state.activeVariant === undefined ? '' : ` variant=${state.activeVariant}`
  const discriminant =
    state.discriminant === undefined ? '' : ` discriminant=${state.discriminant.toLowerCase()}`
  const children = state.children
    .map((child) => `${key([child.selector])}:${encodeState(child.state)}`)
    .join(',')
  return `${state.initialization.toLowerCase()}${variant}${discriminant}${children.length === 0 ? '' : `{${children}}`}`
}

/** Lists the sparse state paths that require conditional initialization flags. */
export const conditionalPaths = (state: State, path: Path = []): ReadonlyArray<Path> => [
  ...(state.initialization === 'Maybe' || state.discriminant === 'Maybe' ? [path] : []),
  ...state.children.flatMap((child) => conditionalPaths(child.state, [...path, child.selector])),
]
