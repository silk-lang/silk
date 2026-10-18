import type * as DeclarationIndex from './DeclarationIndex.js'
import type * as SourceSpan from './SourceSpan.js'

/** The concrete semantic request that initiated one resolver operation. */
export interface Initiator {
  readonly kind:
    | 'TypePath'
    | 'ItemPath'
    | 'ValueName'
    | 'AssociatedMember'
    | 'ConformanceGoal'
    | 'CallConstraint'
    | 'ToolingName'
    | 'ToolingPath'
  readonly key: string
  readonly span?: SourceSpan.SourceSpan
}

/** Operations are counted at their actual invocation or candidate loop. */
export interface Counts {
  readonly queries: number
  readonly candidatesVisited: number
  readonly candidatesAccepted: number
}

export interface Entry extends Counts {
  readonly initiator: Initiator
  readonly operation:
    | 'PathResolution'
    | 'NameLookup'
    | 'AssociatedLookup'
    | 'ConformanceDiscovery'
    | 'ProviderSelection'
}

export interface ResolutionWork {
  readonly entries: Map<string, Observation>
}

/** Mutable counters owned by one explicit initiating operation, with no ambient tracing scope. */
export interface Observation {
  readonly initiator: Initiator
  readonly operation: Entry['operation']
  queries: number
  candidatesVisited: number
  candidatesAccepted: number
}

const catalogs = new WeakMap<DeclarationIndex.Index['modules'], ResolutionWork>()

/** Starts an independent resolver work observation. */
export const make = (): ResolutionWork => ({ entries: new Map() })

/** Returns the work collector shared by semantic views of the same declaration modules. */
export const ofIndex = (index: DeclarationIndex.Index): ResolutionWork => {
  const previous = catalogs.get(index.modules)
  if (previous !== undefined) return previous
  const result = make()
  catalogs.set(index.modules, result)
  return result
}

/** Carries header-resolution work into the completed index before body checking starts. */
export const share = (index: DeclarationIndex.Index, previous: DeclarationIndex.Index): void => {
  const retained = ofIndex(previous)
  const current = catalogs.get(index.modules)
  if (current !== undefined && current !== retained)
    for (const [key, entry] of current.entries) {
      const existing = retained.entries.get(key)
      if (existing === undefined) retained.entries.set(key, entry)
      else {
        existing.queries += entry.queries
        existing.candidatesVisited += entry.candidatesVisited
        existing.candidatesAccepted += entry.candidatesAccepted
      }
    }
  catalogs.set(index.modules, retained)
}

/** Starts an actual query and returns its explicit candidate-loop observation. */
export const begin = (
  self: ResolutionWork,
  initiator: Initiator,
  operation: Entry['operation'],
): Observation => {
  const span = initiator.span
  const key = `${operation}:${initiator.kind}:${initiator.key}:${span?.sourceId ?? ''}:${span?.start ?? ''}:${span?.end ?? ''}`
  const previous = self.entries.get(key)
  if (previous !== undefined) {
    previous.queries += 1
    return previous
  }
  const result: Observation = {
    initiator,
    operation,
    queries: 1,
    candidatesVisited: 0,
    candidatesAccepted: 0,
  }
  self.entries.set(key, result)
  return result
}

/** Records one candidate the owning resolver actually inspected. */
export const visit = (self: Observation): void => {
  self.candidatesVisited += 1
}

/** Records one candidate that survived the owning resolver's filter. */
export const accept = (self: Observation): void => {
  self.candidatesAccepted += 1
}

/** Freezes current counters without executing any resolver or candidate discovery. */
export const snapshot = (self: ResolutionWork): ReadonlyArray<Entry> =>
  [...self.entries.entries()]
    .sort(([left], [right]) => {
      if (left < right) return -1
      if (left > right) return 1
      return 0
    })
    .map(([, entry]) => ({ ...entry }))
