import * as Result from 'effect/Result'
import * as Layout from './Layout.js'
import * as Match from './Match.js'
import * as Mir from './Mir.js'
import * as MovePath from './MovePath.js'
import * as Type from './Type.js'

/** Residual initializedness plus definitely assigned conditional-cleanup flags. */
export interface State {
  readonly roots: ReadonlyMap<number, MovePath.State>
  readonly flags: ReadonlySet<number>
}

/** State operations consumed by the shared structured control-flow interpreter. */
export interface Semantics {
  readonly initial: ReadonlySet<State>
  readonly before: (operation: Mir.Operation, states: ReadonlySet<State>) => ReadonlySet<State>
  readonly after: (operation: Mir.Operation, states: ReadonlySet<State>) => ReadonlySet<State>
  readonly enterArm: (arm: Mir.MatchArm, states: ReadonlySet<State>) => ReadonlySet<State>
  readonly select: (
    operation: Mir.MatchOperation,
    member: Match.CoverageIdentity,
    states: ReadonlySet<State>,
  ) => ReadonlySet<State>
  readonly transfer: (operation: Mir.Operation, states: ReadonlySet<State>) => ReadonlySet<State>
  readonly terminal: (states: ReadonlySet<State>, outcome?: Mir.Outcome) => void
  readonly repeat: (states: ReadonlySet<State>) => ReadonlySet<State>
  readonly merge: (...states: ReadonlyArray<ReadonlySet<State>>) => ReadonlySet<State>
}

const pathOf = (selectors: ReadonlyArray<Mir.PlaceSelector>): MovePath.Path | undefined => {
  const path: Array<MovePath.Selector> = []
  for (const selector of selectors) {
    if (selector._tag === 'FieldSelector')
      path.push({ _tag: 'Field', ordinal: selector.field.ordinal })
    else if (selector._tag === 'VariantSelector')
      path.push({ _tag: 'Variant', ordinal: selector.ordinal })
    else if (selector._tag === 'ElementSelector' && selector.index._tag === 'Proven')
      path.push({ _tag: 'ConstantIndex', index: selector.index.value })
    else return undefined
  }
  return path
}

const subtree = (state: MovePath.State, path: MovePath.Path): MovePath.State => {
  let selected = state
  for (const selector of path)
    selected =
      selected.children.find((child) => MovePath.key([child.selector]) === MovePath.key([selector]))
        ?.state ?? MovePath.make(selected.initialization)
  return selected
}

/** A joined cleanup fact must include every possibility on each incoming concrete path. */
const covers = (expected: MovePath.State, actual: MovePath.State): boolean => {
  if (expected.initialization !== 'Maybe' && expected.initialization !== actual.initialization)
    return false
  if (actual.initialization === 'Missing') return true
  if (expected.activeVariant !== undefined && actual.activeVariant !== expected.activeVariant)
    return false
  const selectors = new Map(
    [...expected.children, ...actual.children].map((child) => [
      MovePath.key([child.selector]),
      child.selector,
    ]),
  )
  for (const selector of selectors.values()) {
    if (
      selector._tag === 'Variant' &&
      actual.activeVariant !== undefined &&
      selector.ordinal !== actual.activeVariant
    )
      continue
    if (!covers(subtree(expected, [selector]), subtree(actual, [selector]))) return false
  }
  return true
}

/**
 * Verifies partial reads, writes and cleanup flags. Source Ownership remains authoritative for
 * whole-root transfers, which intentionally need no redundant runtime ownership instruction.
 * The caller supplies the common structured CFG interpreter so exit and loop routing stay shared.
 */
export const analyze = (
  fn: Mir.MirFunction,
  layout: Layout.Plan,
  localsOf: (operation: Mir.Operation) => ReadonlyArray<Mir.LocalId>,
  run: (semantics: Semantics) => boolean,
): Analysis => {
  const violations = new Map<string, Mir.Violation>()
  const snapshots = new Map<Mir.Operation, ReadonlySet<State>>()
  const report = (provenance: Mir.Provenance, detail: string): void => {
    const key = `${provenance.span.start}:${provenance.span.end}:${detail}`
    violations.set(key, {
      _tag: 'Violation',
      rule: 'InvalidInitializationState',
      function: fn.id,
      provenance,
      detail,
    })
  }
  const shapes = new Map<number, MovePath.ShapeOf>()
  const shapeOf = (root: Mir.LocalId): MovePath.ShapeOf => {
    const cached = shapes.get(root.ordinal)
    if (cached !== undefined) return cached
    const rootType = fn.localTypes.at(root.ordinal)
    const shape: MovePath.ShapeOf = (path) => {
      let type = rootType === undefined ? undefined : Mir.semanticType(rootType)
      let fields: ReadonlyArray<Layout.Field> | undefined
      for (const selector of path) {
        if (type === undefined) return undefined
        const representation = Layout.entry(layout, type)?.representation
        if (selector._tag === 'ConstantIndex') {
          if (!Type.isFixedArray(type)) return undefined
          type = type.element
          fields = undefined
        } else if (selector._tag === 'Variant' && Type.isUnion(type)) {
          type = type.members.at(selector.ordinal)
        } else if (selector._tag === 'Variant' && representation?._tag === 'NominalUnion') {
          fields = representation.variants.find(
            (variant) => variant.ordinal === selector.ordinal,
          )?.fields
          if (fields === undefined) return undefined
        } else if (selector._tag === 'Field') {
          const available =
            fields ?? (representation?._tag === 'Aggregate' ? representation.fields : [])
          type = available.find((field) => field.id.ordinal === selector.ordinal)?.type
          fields = undefined
        } else return undefined
      }
      if (fields !== undefined)
        return {
          _tag: 'Fields',
          fields: fields.map((field) => field.id.ordinal),
          dropBoundary: false,
        }
      if (type === undefined) return undefined
      if (Type.isFixedArray(type)) return { _tag: 'Array', length: type.length }
      if (Type.isUnion(type))
        return {
          _tag: 'Variants',
          variants: type.members.map((_, ordinal) => ordinal),
          dropBoundary: false,
        }
      const representation = Layout.entry(layout, type)?.representation
      if (representation?._tag === 'Aggregate')
        return {
          _tag: 'Fields',
          fields: representation.fields.map((field) => field.id.ordinal),
          dropBoundary: representation.cleanupHook !== undefined,
        }
      if (representation?._tag === 'NominalUnion')
        return {
          _tag: 'Variants',
          variants: representation.variants.map((variant) => variant.ordinal),
          dropBoundary: representation.cleanupHook !== undefined,
        }
      return { _tag: 'Leaf' }
    }
    shapes.set(root.ordinal, shape)
    return shape
  }
  const interned = new Map<string, State>()
  const intern = (
    roots: ReadonlyMap<number, MovePath.State>,
    flags: ReadonlySet<number>,
  ): State => {
    const key =
      [...roots]
        .sort(([a], [b]) => a - b)
        .map(([id, state]) => `${id}:${MovePath.encodeState(state)}`)
        .join('|') + ` flags:${[...flags].sort((a, b) => a - b).join(',')}`
    const cached = interned.get(key)
    if (cached !== undefined) return cached
    const state = { roots, flags }
    interned.set(key, state)
    return state
  }
  const current = (state: State, root: Mir.LocalId): MovePath.State =>
    state.roots.get(root.ordinal) ?? MovePath.make()
  const merge = (...groups: ReadonlyArray<ReadonlySet<State>>): ReadonlySet<State> => {
    const states = groups.flatMap((group) => [...group])
    const first = states.at(0)
    if (first === undefined) return new Set()
    const roots = new Map<number, MovePath.State>()
    const ids = new Set(states.flatMap((state) => [...state.roots.keys()]))
    for (const ordinal of ids)
      roots.set(
        ordinal,
        MovePath.join(
          states.map((state) => state.roots.get(ordinal) ?? MovePath.make()),
          shapeOf({ _tag: 'Local', ordinal }),
        ),
      )
    const flags = new Set(
      [...first.flags].filter((flag) => states.every((state) => state.flags.has(flag))),
    )
    return new Set([intern(roots, flags)])
  }
  const read = (
    state: State,
    root: Mir.LocalId,
    path: MovePath.Path,
    provenance: Mir.Provenance,
  ): void => {
    const result = MovePath.inspect(current(state, root), path, shapeOf(root))
    if (Result.isFailure(result) || !result.success.complete)
      report(provenance, `read of incomplete local ${root.ordinal}/${MovePath.key(path)}`)
  }
  const map = (states: ReadonlySet<State>, f: (state: State) => State): ReadonlySet<State> =>
    new Set([...states].map(f))
  const transfer = (operation: Mir.Operation, incoming: ReadonlySet<State>): ReadonlySet<State> =>
    map(incoming, (state) => {
      const roots = new Map(state.roots)
      const flags = new Set(state.flags)
      if (operation._tag === 'SetInitialized') {
        if (fn.localTypes.at(operation.flag.ordinal)?._tag !== 'bool')
          report(operation.provenance, 'initialization flag is not a declared bool local')
        flags.add(operation.flag.ordinal)
        return intern(roots, flags)
      }
      const destination = 'destination' in operation ? operation.destination : undefined
      if (operation._tag === 'ReadPlace') {
        const path = pathOf(operation.selectors)
        const sourceType = fn.localTypes.at(operation.root.ordinal)
        if (sourceType?._tag === 'Reference' || sourceType?._tag === 'Slice')
          read(state, operation.root, [], operation.provenance)
        else if (path === undefined) read(state, operation.root, [], operation.provenance)
        else {
          read(state, operation.root, path, operation.provenance)
          if (operation.ownershipPath !== undefined) {
            if (!operation.consume || MovePath.key(operation.ownershipPath) !== MovePath.key(path))
              report(operation.provenance, 'owned transfer path disagrees with its place selectors')
            const moved = MovePath.consume(
              current(state, operation.root),
              path,
              shapeOf(operation.root),
            )
            if (Result.isFailure(moved))
              report(
                operation.provenance,
                'owned place transfer crosses an unavailable subtree or Drop boundary',
              )
            else roots.set(operation.root.ordinal, moved.success)
          }
        }
      } else if (operation._tag === 'Project') {
        const sourceType = fn.localTypes.at(operation.source.ordinal)
        read(
          state,
          operation.source,
          sourceType?._tag === 'Reference'
            ? []
            : [{ _tag: 'Field', ordinal: operation.field.ordinal }],
          operation.provenance,
        )
      } else if (operation._tag === 'WritePlace') {
        read(state, operation.source, [], operation.provenance)
        const path = pathOf(operation.selectors)
        const rootType = fn.localTypes.at(operation.root.ordinal)
        if (path !== undefined && rootType?._tag !== 'Reference' && rootType?._tag !== 'Slice') {
          const restored = MovePath.restore(
            current(state, operation.root),
            path,
            shapeOf(operation.root),
          )
          if (Result.isFailure(restored))
            report(operation.provenance, 'write descends through an unavailable owned ancestor')
          else roots.set(operation.root.ordinal, restored.success)
        }
      } else if (operation._tag === 'Drop') {
        const path = pathOf(operation.selectors ?? [])
        if (path !== undefined) {
          const selected = subtree(current(state, operation.local), path)
          const expected = operation.initialization?.state ?? MovePath.make()
          if (!covers(expected, selected))
            report(
              operation.provenance,
              'cleanup initializedness does not cover the incoming owned state',
            )
          const required = new Set(MovePath.conditionalPaths(expected).map(MovePath.key))
          const provided = operation.initialization?.flags ?? []
          const identities = new Set(provided.map((flag) => MovePath.key(flag.path)))
          if (
            provided.length !== identities.size ||
            required.size !== identities.size ||
            [...required].some((key) => !identities.has(key))
          )
            report(
              operation.provenance,
              'conditional cleanup requires exactly one flag per maybe-initialized path',
            )
          for (const flag of provided)
            if (
              !state.flags.has(flag.local.ordinal) ||
              fn.localTypes.at(flag.local.ordinal)?._tag !== 'bool'
            )
              report(operation.provenance, 'cleanup flag is not defined on every incoming path')
          const terminated = MovePath.terminate(
            current(state, operation.local),
            path,
            shapeOf(operation.local),
          )
          if (Result.isSuccess(terminated)) roots.set(operation.local.ordinal, terminated.success)
        }
      } else if (operation._tag === 'CheckPlace') {
        // Address validation precedes assignment and may select a missing leaf for restoration.
      } else if (operation._tag === 'BeginLoan') {
        const rootType = fn.localTypes.at(operation.root.ordinal)
        read(
          state,
          operation.root,
          rootType?._tag === 'Reference' || rootType?._tag === 'Slice'
            ? []
            : (pathOf(operation.selectors) ?? []),
          operation.provenance,
        )
      } else {
        for (const local of localsOf(operation))
          if (local.ordinal !== destination?.ordinal) read(state, local, [], operation.provenance)
      }
      return intern(roots, flags)
    })
  const semantics: Semantics = {
    initial: new Set([intern(new Map(), new Set())]),
    merge,
    repeat: (states) => states,
    after: (operation, states) => {
      const destination = 'destination' in operation ? operation.destination : undefined
      if (destination === undefined) return states
      // Structured results are assigned only after a continuing child completes. In particular,
      // loop backedges must not carry the previous iteration's cleanup into this fresh value.
      return map(states, (state) => {
        const roots = new Map(state.roots)
        roots.delete(destination.ordinal)
        return intern(roots, state.flags)
      })
    },
    enterArm: (arm, states) => {
      // Candidate payloads are materialized before their guard, including cleanup-only fields.
      // Other candidates' bindings retain their own state until those candidates are entered.
      return map(states, (state) => {
        const roots = new Map(state.roots)
        for (const binding of [...arm.bindings, ...arm.cleanupBindings])
          roots.delete(binding.destination.ordinal)
        return intern(roots, state.flags)
      })
    },
    terminal: (states, outcome) => {
      if (outcome?._tag === 'Return')
        for (const state of states) read(state, outcome.value, [], outcome.provenance)
    },
    before: (operation, states) => {
      if (operation._tag === 'Match') {
        // A retained if-let result joins its matched and unmatched paths before the generated
        // conditional. Bindings belong to this invocation, never a previous loop iteration.
        states = map(states, (state) => {
          const roots = new Map(state.roots)
          for (const arm of operation.arms)
            for (const binding of [...arm.bindings, ...arm.cleanupBindings])
              roots.delete(binding.destination.ordinal)
          return intern(roots, state.flags)
        })
      }
      snapshots.set(operation, merge(snapshots.get(operation) ?? new Set(), states))
      if (operation._tag === 'Match')
        for (const state of states) {
          const sourceType = fn.localTypes.at(operation.scrutinee.ordinal)
          const path =
            sourceType?._tag === 'Reference' ||
            sourceType?._tag === 'Slice' ||
            sourceType?._tag === 'EnvironmentBorrow'
              ? []
              : (pathOf(operation.selectors ?? []) ?? [])
          if (operation.access !== 'Place')
            read(state, operation.scrutinee, path, operation.provenance)
          else {
            const inspected = MovePath.inspect(
              current(state, operation.scrutinee),
              path,
              shapeOf(operation.scrutinee),
            )
            if (
              Result.isFailure(inspected) ||
              (inspected.success.discriminant ?? inspected.success.state.initialization) !==
                'Initialized'
            )
              report(
                operation.provenance,
                'discriminant-only match reads an unavailable discriminant',
              )
          }
        }
      return states
    },
    select: (operation, member, states) => {
      if (operation.access !== 'Place') return states
      return map(states, (state) => {
        let selected = current(state, operation.scrutinee)
        const path = [...(pathOf(operation.selectors ?? []) ?? [])]
        const type = Mir.semanticType(operation.scrutineeType)
        if (Type.isUnion(type)) {
          const ordinal = type.members.findIndex((type) =>
            Type.equals(type, Match.sourceType(member)),
          )
          const refined = MovePath.refine(selected, path, ordinal, shapeOf(operation.scrutinee))
          if (Result.isSuccess(refined)) selected = refined.success
          path.push({ _tag: 'Variant', ordinal })
        }
        if (member._tag === 'NominalUnionVariant') {
          const representation = Layout.entry(layout, member.type)?.representation
          const ordinal =
            representation?._tag === 'NominalUnion'
              ? representation.variants.find(
                  (variant) => variant.variant.name === member.variant.name,
                )?.ordinal
              : undefined
          if (ordinal !== undefined) {
            const refined = MovePath.refine(selected, path, ordinal, shapeOf(operation.scrutinee))
            if (Result.isSuccess(refined)) selected = refined.success
          }
        }
        const roots = new Map(state.roots)
        roots.set(operation.scrutinee.ordinal, selected)
        return intern(roots, state.flags)
      })
    },
    transfer,
  }
  run(semantics)
  const before = new Map<Mir.Operation, ReadonlyMap<number, MovePath.State>>()
  const flagsBefore = new Map<Mir.Operation, ReadonlySet<number>>()
  const partialBefore = new Map<Mir.Operation, ReadonlySet<number>>()
  for (const [operation, states] of snapshots) {
    const joined = [...merge(states)].at(0)
    if (joined === undefined) continue
    before.set(operation, joined.roots)
    flagsBefore.set(operation, joined.flags)
    const partial = new Set<number>()
    for (const [ordinal, state] of joined.roots) {
      const inspected = MovePath.inspect(state, [], shapeOf({ _tag: 'Local', ordinal }))
      if (Result.isFailure(inspected) || !inspected.success.complete) partial.add(ordinal)
    }
    partialBefore.set(operation, partial)
  }
  return {
    violations: [...violations.values()],
    before,
    flagsBefore,
    partialBefore,
  }
}

/** One shared immutable dataflow result for verification and suspension planning. */
export interface Analysis {
  readonly violations: ReadonlyArray<Mir.Violation>
  readonly before: ReadonlyMap<Mir.Operation, ReadonlyMap<number, MovePath.State>>
  readonly flagsBefore: ReadonlyMap<Mir.Operation, ReadonlySet<number>>
  readonly partialBefore: ReadonlyMap<Mir.Operation, ReadonlySet<number>>
}
