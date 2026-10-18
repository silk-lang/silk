import type * as DeclarationFacts from './DeclarationFacts.js'
import type * as Tir from './Tir.js'
import * as Ownership from './Ownership.js'

/** Why the caller requested ownership for this selected body. */
export type Reason = 'UnchangedBody' | 'SelectedStaticBody' | 'ChangedOwnershipInputs'

/** Actual query branches and executed checker work; retained proof work is never added. */
export interface Counters {
  readonly _tag: 'ResidualOwnershipCounters'
  readonly requests: number
  readonly sourceReused: number
  readonly checked: number
  readonly cacheReused: number
  readonly executedWork: Ownership.Work
}

/** One query's compact source attribution and actual branch. */
export interface Observation {
  readonly declaration: DeclarationFacts.DeclarationFact['id']
  readonly reason: Reason
  readonly branch: 'SourceReused' | 'Checked' | 'CacheReused'
  readonly work?: Ownership.Work
}

type MutableWork = { -readonly [Key in keyof Ownership.Work]: Ownership.Work[Key] }

interface Entry {
  readonly input: Ownership.CheckInput
  readonly checked: Ownership.CheckedFunction
}

interface State {
  requests: number
  sourceReused: number
  checked: number
  cacheReused: number
  readonly executedWork: MutableWork
  readonly entries: WeakMap<Tir.TirFunction, Array<Entry>>
  readonly observations: Array<Observation>
}

const stateSymbol: unique symbol = Symbol('ResidualOwnership.state')

/** One discovery's cache, keyed by the actual ownership checker inputs. */
export interface Coordinator {
  readonly _tag: 'ResidualOwnershipCoordinator'
  readonly [stateSymbol]: State
}

export const make = (): Coordinator => ({
  _tag: 'ResidualOwnershipCoordinator',
  [stateSymbol]: {
    requests: 0,
    sourceReused: 0,
    checked: 0,
    cacheReused: 0,
    executedWork: {
      pathChecks: 0,
      shapeComputations: 0,
      shapeCacheHits: 0,
      shapeProjectionSteps: 0,
      initializationJoins: 0,
      loanAccessChecks: 0,
      cleanupPlanQueries: 0,
    },
    entries: new WeakMap(),
    observations: [],
  },
})

/** Reuses an exact source proof or cached result, including failed checks, before executing. */
export const check = (
  self: Coordinator,
  input: Ownership.CheckInput,
  reason: Reason,
): Ownership.CheckedFunction => {
  const state = self[stateSymbol]
  state.requests += 1
  const entries = state.entries.get(input.function) ?? []
  const cached = entries.find((entry) => Ownership.matchesInput(entry.input, input))
  const source = cached === undefined ? Ownership.sourceProof(input) : undefined
  let branch: Observation['branch'] = 'Checked'
  if (cached !== undefined) branch = 'CacheReused'
  else if (source !== undefined) branch = 'SourceReused'
  const checked = cached?.checked ?? source ?? Ownership.check(input)
  if (branch === 'CacheReused') state.cacheReused += 1
  else {
    entries.push({ input, checked })
    state.entries.set(input.function, entries)
    if (branch === 'SourceReused') state.sourceReused += 1
    else {
      state.checked += 1
      const work = checked.ownership.work
      if (work !== undefined) {
        state.executedWork.pathChecks += work.pathChecks
        state.executedWork.shapeComputations += work.shapeComputations
        state.executedWork.shapeCacheHits += work.shapeCacheHits
        state.executedWork.shapeProjectionSteps += work.shapeProjectionSteps
        state.executedWork.initializationJoins += work.initializationJoins
        state.executedWork.loanAccessChecks += work.loanAccessChecks
        state.executedWork.cleanupPlanQueries += work.cleanupPlanQueries
      }
    }
  }
  state.observations.push({
    declaration: input.function.declaration.id,
    reason,
    branch,
    ...(branch === 'Checked' && checked.ownership.work !== undefined
      ? { work: checked.ownership.work }
      : {}),
  })
  return checked
}

/** Snapshots actual execution and reuse counters. */
export const counters = (self: Coordinator): Counters => {
  const state = self[stateSymbol]
  return {
    _tag: 'ResidualOwnershipCounters',
    requests: state.requests,
    sourceReused: state.sourceReused,
    checked: state.checked,
    cacheReused: state.cacheReused,
    executedWork: { ...state.executedWork },
  }
}

/** Snapshots query attribution without retaining declarations or syntax in reports. */
export const observations = (self: Coordinator): ReadonlyArray<Observation> => [
  ...self[stateSymbol].observations,
]
