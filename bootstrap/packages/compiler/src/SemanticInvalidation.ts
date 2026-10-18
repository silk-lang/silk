import * as Canonical from './internal/Canonical.js'
import * as StronglyConnectedGraph from './internal/Graph.js'
import type * as ModuleClosure from './ModuleClosure.js'
import * as ModuleSurface from './ModuleSurface.js'
import type * as OpaqueRealization from './OpaqueRealization.js'

/** Versioned compiler-known inputs that participate in semantic meaning. */
export const environment = 'silk-bootstrap-frontend-v1' as const

/** The current semantic state needed to compare adjacent project revisions. */
export interface Project {
  readonly closure: ModuleClosure.ProjectClosure
  readonly surfaces: ReadonlyMap<string, ModuleSurface.ModuleSurface>
  readonly opaqueRealizations: OpaqueRealization.Catalog
  readonly environment: string
}

/** Syntax evidence supplied by revision-aware project analysis. */
export interface LocalRevision {
  readonly _tag: 'Fresh' | 'Reused' | 'Changed'
}

export type Reason =
  | 'Fresh'
  | 'LocalChange'
  | 'OpaqueBodyChange'
  | 'OpaqueTargetChange'
  | 'OpaqueLayoutChange'
  | 'DependencySurfaceChange'
  | 'CyclicPeerChange'
  | 'EnvironmentChange'
  | 'SurfaceChange'

export interface Reusable {
  readonly _tag: 'Reusable'
  readonly module: string
  readonly surfaceChanged: false
}

export interface Recomputed {
  readonly _tag: 'Recomputed'
  readonly module: string
  readonly reasons: ReadonlyArray<Reason>
  readonly surfaceChanged: boolean
}

export type Observation = Reusable | Recomputed

export interface ReasonCounts {
  readonly Fresh: number
  readonly LocalChange: number
  readonly OpaqueBodyChange: number
  readonly OpaqueTargetChange: number
  readonly OpaqueLayoutChange: number
  readonly DependencySurfaceChange: number
  readonly CyclicPeerChange: number
  readonly EnvironmentChange: number
  readonly SurfaceChange: number
}

type MutableReasonCounts = { -readonly [K in keyof ReasonCounts]: number }

export interface Totals {
  readonly modules: number
  readonly reusable: number
  readonly recomputed: number
  readonly reasons: ReasonCounts
}

/** One complete deterministic invalidation oracle for the current project. */
export interface SemanticInvalidation {
  readonly _tag: 'SemanticInvalidation'
  readonly observations: ReadonlyArray<Observation>
  readonly totals: Totals
}

export interface Input {
  readonly current: Project
  readonly revisions: ReadonlyMap<string, LocalRevision>
  readonly previous?: Project
}

const reasonOrder: ReadonlyArray<Reason> = [
  'Fresh',
  'EnvironmentChange',
  'LocalChange',
  'OpaqueBodyChange',
  'OpaqueTargetChange',
  'OpaqueLayoutChange',
  'DependencySurfaceChange',
  'CyclicPeerChange',
  'SurfaceChange',
]

const compareName = (left: string, right: string): number => {
  if (left < right) {
    return -1
  }
  if (left > right) {
    return 1
  }
  return 0
}

const importInput = (module: ModuleClosure.Module): string =>
  module.imports
    .map((fact) => {
      const target =
        fact.target._tag === 'Unavailable'
          ? 'Unavailable'
          : `${fact.target._tag}:${Canonical.frame(fact.target.module)}`
      return Canonical.frame(
        `${Canonical.frame(fact.sourceSpelling ?? '')}${Canonical.frame(fact.canonicalTarget ?? '')}${target}`,
      )
    })
    .join('')

const resolvedTargets = (module: ModuleClosure.Module): ReadonlyArray<string> =>
  [
    ...new Set(
      module.imports.flatMap((fact) =>
        fact.target._tag === 'Resolved' ? [fact.target.module] : [],
      ),
    ),
  ].sort(compareName)

interface Graph {
  readonly names: ReadonlyArray<string>
  readonly edges: ReadonlyMap<string, ReadonlyArray<string>>
}

const graph = (closure: ModuleClosure.ProjectClosure): Graph => {
  const names = closure.modules.map((module) => module.name).sort(compareName)
  const current = new Set(names)
  return {
    names,
    edges: new Map(
      closure.modules.map((module) => [
        module.name,
        resolvedTargets(module).filter((target) => current.has(target)),
      ]),
    ),
  }
}

const unionGraph = (current: Graph, previous: Graph | undefined): Graph => {
  const currentNames = new Set(current.names)
  return {
    names: current.names,
    edges: new Map(
      current.names.map((name) => [
        name,
        [
          ...new Set([
            ...(current.edges.get(name) ?? []),
            ...(previous?.edges.get(name) ?? []).filter((target) => currentNames.has(target)),
          ]),
        ].sort(compareName),
      ]),
    ),
  }
}

interface Components {
  readonly values: ReadonlyArray<ReadonlyArray<string>>
  readonly ofModule: ReadonlyMap<string, number>
}

const components = (input: Graph): Components => {
  const values = [
    ...StronglyConnectedGraph.stronglyConnected(input.names, (name) => input.edges.get(name) ?? []),
  ]
    .map((members) => [...members].sort(compareName))
    .sort((left, right) => compareName(left.at(0) ?? '', right.at(0) ?? ''))
  return {
    values,
    ofModule: new Map(
      values.flatMap((members, component) => members.map((name) => [name, component] as const)),
    ),
  }
}

const modulesByName = (
  closure: ModuleClosure.ProjectClosure,
): ReadonlyMap<string, ModuleClosure.Module> =>
  new Map(closure.modules.map((module) => [module.name, module]))

const surfaceChanged = (
  module: string,
  current: Project,
  previous: Project | undefined,
): boolean => {
  const currentSurface = current.surfaces.get(module)
  const previousSurface = previous?.surfaces.get(module)
  return (
    currentSurface === undefined ||
    previousSurface === undefined ||
    !ModuleSurface.equals(currentSurface, previousSurface)
  )
}

const emptyReasonCounts = (): MutableReasonCounts => ({
  Fresh: 0,
  LocalChange: 0,
  OpaqueBodyChange: 0,
  OpaqueTargetChange: 0,
  OpaqueLayoutChange: 0,
  DependencySurfaceChange: 0,
  CyclicPeerChange: 0,
  EnvironmentChange: 0,
  SurfaceChange: 0,
})

interface OpaqueChanges {
  readonly body: boolean
  readonly target: boolean
  readonly layout: boolean
}

const opaqueChanges = (
  module: string,
  current: Project,
  previous: Project | undefined,
): OpaqueChanges => {
  const currentDefinitions = new Map(
    [...current.opaqueRealizations.definitions].filter(
      ([, definition]) => definition.family.producer.module === module,
    ),
  )
  const previousDefinitions = new Map(
    [...(previous?.opaqueRealizations.definitions ?? [])].filter(
      ([, definition]) => definition.family.producer.module === module,
    ),
  )
  const keys = new Set([...currentDefinitions.keys(), ...previousDefinitions.keys()])
  let body = false
  let target = false
  let layout = false
  for (const key of keys) {
    const currentDefinition = currentDefinitions.get(key)
    const previousDefinition = previousDefinitions.get(key)
    body ||= currentDefinition?.bodyFingerprint !== previousDefinition?.bodyFingerprint
    target ||= currentDefinition?.targetFingerprint !== previousDefinition?.targetFingerprint
    layout ||= currentDefinition?.layoutFingerprint !== previousDefinition?.layoutFingerprint
  }
  return { body, target, layout }
}

/**
 * Plan the semantic work a reusable frontend would need while the current frontend is still built
 * globally. Surface propagation is SCC-safe and stops as soon as exported meaning stabilizes.
 */
export const make = (input: Input): SemanticInvalidation => {
  const currentGraph = graph(input.current.closure)
  const previousGraph = input.previous === undefined ? undefined : graph(input.previous.closure)
  const revisionGraph = unionGraph(currentGraph, previousGraph)
  const revisionComponents = components(revisionGraph)
  const currentModules = modulesByName(input.current.closure)
  const previousModules =
    input.previous === undefined
      ? new Map<string, ModuleClosure.Module>()
      : modulesByName(input.previous.closure)
  const reasons = new Map<string, Set<Reason>>()
  const queue = new Set<number>()
  const processed = new Set<number>()

  const addReason = (module: string, reason: Reason): void => {
    const existing = reasons.get(module)
    if (existing === undefined) reasons.set(module, new Set([reason]))
    else existing.add(reason)
  }

  const enqueueComponent = (component: number): void => {
    if (!processed.has(component)) queue.add(component)
    const members = revisionComponents.values.at(component) ?? []
    if (input.previous === undefined || members.length <= 1) return
    for (const member of members) {
      if (!reasons.has(member)) addReason(member, 'CyclicPeerChange')
    }
  }

  for (const module of currentGraph.names) {
    const revision = input.revisions.get(module)
    const currentModule = currentModules.get(module)
    const previousModule = previousModules.get(module)
    if (
      input.previous === undefined ||
      revision?._tag === 'Fresh' ||
      previousModule === undefined
    ) {
      addReason(module, 'Fresh')
    }
    if (
      input.previous !== undefined &&
      revision?._tag !== 'Fresh' &&
      previousModule !== undefined
    ) {
      if (input.current.environment !== input.previous.environment)
        addReason(module, 'EnvironmentChange')
      if (revision?._tag !== 'Reused') addReason(module, 'LocalChange')
      if (currentModule === undefined || importInput(currentModule) !== importInput(previousModule))
        addReason(module, 'DependencySurfaceChange')
    }
    if (reasons.has(module)) {
      const component = revisionComponents.ofModule.get(module)
      if (component !== undefined) enqueueComponent(component)
    }
  }

  for (const module of currentGraph.names) {
    if (reasons.has(module) || !surfaceChanged(module, input.current, input.previous)) continue
    addReason(module, 'SurfaceChange')
    const component = revisionComponents.ofModule.get(module)
    if (component !== undefined) enqueueComponent(component)
  }

  const currentDependents = new Map<string, Array<string>>()
  for (const [dependent, dependencies] of currentGraph.edges) {
    for (const dependency of dependencies) {
      const found = currentDependents.get(dependency)
      if (found === undefined) currentDependents.set(dependency, [dependent])
      else found.push(dependent)
    }
  }
  for (const dependents of currentDependents.values()) dependents.sort(compareName)

  if (input.previous !== undefined) {
    for (const module of currentGraph.names) {
      if (surfaceChanged(module, input.current, input.previous)) continue
      const changed = opaqueChanges(module, input.current, input.previous)
      if (changed.body) addReason(module, 'OpaqueBodyChange')
      if (changed.target) addReason(module, 'OpaqueTargetChange')
      if (changed.layout) addReason(module, 'OpaqueLayoutChange')
      if (!changed.target && !changed.layout) continue
      for (const dependent of currentDependents.get(module) ?? []) {
        if (changed.target) addReason(dependent, 'OpaqueTargetChange')
        if (changed.layout) addReason(dependent, 'OpaqueLayoutChange')
        const component = revisionComponents.ofModule.get(dependent)
        if (component !== undefined) enqueueComponent(component)
      }
    }
  }

  while (queue.size > 0) {
    const component = [...queue].sort((left, right) => left - right).at(0)
    if (component === undefined) break
    queue.delete(component)
    processed.add(component)
    const members = revisionComponents.values.at(component) ?? []
    if (!members.some((module) => surfaceChanged(module, input.current, input.previous))) continue

    for (const dependency of members) {
      for (const dependent of currentDependents.get(dependency) ?? []) {
        const dependentComponent = revisionComponents.ofModule.get(dependent)
        if (dependentComponent === undefined || dependentComponent === component) continue
        addReason(dependent, 'DependencySurfaceChange')
        enqueueComponent(dependentComponent)
      }
    }
  }

  const observations = currentGraph.names.map((module): Observation => {
    const found = reasons.get(module)
    const changed = surfaceChanged(module, input.current, input.previous)
    if (found === undefined) return { _tag: 'Reusable', module, surfaceChanged: false }
    return {
      _tag: 'Recomputed',
      module,
      reasons: reasonOrder.filter((reason) => found.has(reason)),
      surfaceChanged: changed,
    }
  })
  const reasonCounts = emptyReasonCounts()
  let recomputed = 0
  for (const observation of observations) {
    if (observation._tag === 'Reusable') continue
    recomputed += 1
    for (const reason of observation.reasons) reasonCounts[reason] += 1
  }
  const frozenReasons = { ...reasonCounts }
  return {
    _tag: 'SemanticInvalidation',
    observations,
    totals: {
      modules: observations.length,
      reusable: observations.length - recomputed,
      recomputed,
      reasons: frozenReasons,
    },
  }
}

/** Look up one current module's observation. */
export const observation = (self: SemanticInvalidation, module: string): Observation | undefined =>
  self.observations.find((candidate) => candidate.module === module)
