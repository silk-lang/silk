import type * as ModuleSummary from './ModuleSummary.js'
import * as ToolchainIntegrity from './ToolchainIntegrity.js'

/** The origin tier used to rank one importable candidate. */
export type Tier = 'Project' | 'Toolchain'

/** One public declaration qualified by its immutable summary and inventory tier. */
export interface Candidate {
  readonly _tag: 'WorkspaceInventoryCandidate'
  readonly tier: Tier
  readonly module: string
  readonly summary: ModuleSummary.ModuleSummary
  readonly declaration: ModuleSummary.PublicDeclaration
}

/** Deterministic observations produced while revising one inventory. */
export interface Observation {
  readonly _tag: 'WorkspaceInventoryObservation'
  readonly scanned: number
  readonly reused: number
  readonly revised: number
  readonly removed: number
  readonly indexedModules: number
  readonly indexedDeclarations: number
  readonly discoveryElapsedMs: number
  readonly summaryElapsedMs: number
}

/** Immutable project/toolchain module partitions and an exact-name candidate index. */
export interface WorkspaceInventory {
  readonly _tag: 'WorkspaceInventory'
  readonly profile?: string
  readonly identity?: string
  readonly project: ReadonlyMap<string, ModuleSummary.ModuleSummary>
  readonly toolchain: ReadonlyMap<string, ModuleSummary.ModuleSummary>
  readonly byName: ReadonlyMap<string, ReadonlyArray<Candidate>>
  /** Matched distribution metadata available to language-tooling inspectors. */
  readonly distribution: ToolchainIntegrity.Graph
  readonly integrity: ToolchainIntegrity.Validation
  readonly observation: Observation
}

export interface Input {
  readonly profile?: string
  readonly identity?: string
  readonly project?: Iterable<readonly [string, ModuleSummary.ModuleSummary]>
  readonly toolchain?: Iterable<readonly [string, ModuleSummary.ModuleSummary]>
  readonly observation?: Partial<
    Omit<Observation, '_tag' | 'indexedModules' | 'indexedDeclarations'>
  >
  readonly distribution?: ToolchainIntegrity.Graph
}

const compareCandidate = (left: Candidate, right: Candidate): number => {
  let tierOrder = 0
  if (left.tier !== right.tier) tierOrder = left.tier === 'Project' ? -1 : 1
  return (
    tierOrder ||
    left.module.localeCompare(right.module) ||
    left.declaration.ordinal - right.declaration.ordinal
  )
}

const sortedModules = (
  entries: Iterable<readonly [string, ModuleSummary.ModuleSummary]>,
): ReadonlyMap<string, ModuleSummary.ModuleSummary> =>
  new Map([...entries].sort(([left], [right]) => left.localeCompare(right)))

const build = (
  project: ReadonlyMap<string, ModuleSummary.ModuleSummary>,
  toolchain: ReadonlyMap<string, ModuleSummary.ModuleSummary>,
  input: Input['observation'] = {},
  distribution: ToolchainIntegrity.Graph = ToolchainIntegrity.installed(),
  selection: Pick<Input, 'profile' | 'identity'> = {},
): WorkspaceInventory => {
  const byName = new Map<string, Array<Candidate>>()
  const add = (tier: Tier, summaries: ReadonlyMap<string, ModuleSummary.ModuleSummary>): void => {
    for (const [module, summary] of summaries)
      for (const declaration of summary.publicDeclarations) {
        const candidate: Candidate = {
          _tag: 'WorkspaceInventoryCandidate',
          tier,
          module,
          summary,
          declaration,
        }
        const bucket = byName.get(declaration.spelling)
        if (bucket === undefined) byName.set(declaration.spelling, [candidate])
        else bucket.push(candidate)
      }
  }
  add('Project', project)
  add('Toolchain', toolchain)
  const exact = new Map(
    [...byName]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, entries]) => [name, entries.sort(compareCandidate)] as const),
  )
  const indexedDeclarations = [...exact.values()].reduce(
    (total, entries) => total + entries.length,
    0,
  )
  const observation: Observation = {
    _tag: 'WorkspaceInventoryObservation',
    scanned: input.scanned ?? 0,
    reused: input.reused ?? 0,
    revised: input.revised ?? 0,
    removed: input.removed ?? 0,
    indexedModules: project.size + toolchain.size,
    indexedDeclarations,
    discoveryElapsedMs: input.discoveryElapsedMs ?? 0,
    summaryElapsedMs: input.summaryElapsedMs ?? 0,
  }
  return {
    _tag: 'WorkspaceInventory',
    ...selection,
    project,
    toolchain,
    byName: exact,
    distribution,
    integrity: ToolchainIntegrity.validateFrontend(distribution),
    observation,
  }
}

/** Builds a deterministic inventory from already summarized module partitions. */
export const make = (input: Input = {}): WorkspaceInventory =>
  build(
    sortedModules(input.project ?? []),
    sortedModules(input.toolchain ?? []),
    input.observation,
    input.distribution,
    {
      ...(input.profile === undefined ? {} : { profile: input.profile }),
      ...(input.identity === undefined ? {} : { identity: input.identity }),
    },
  )

export interface Revision {
  readonly project?: Iterable<readonly [string, ModuleSummary.ModuleSummary]>
  readonly toolchain?: Iterable<readonly [string, ModuleSummary.ModuleSummary]>
  readonly removeProject?: Iterable<string>
  readonly removeToolchain?: Iterable<string>
  readonly observation?: Input['observation']
}

const reviseTier = (
  previous: ReadonlyMap<string, ModuleSummary.ModuleSummary>,
  replacements: Iterable<readonly [string, ModuleSummary.ModuleSummary]> | undefined,
  removals: Iterable<string> | undefined,
): ReadonlyMap<string, ModuleSummary.ModuleSummary> => {
  if (replacements === undefined && removals === undefined) return previous
  const next = new Map(previous)
  if (removals !== undefined) for (const module of removals) next.delete(module)
  if (replacements !== undefined)
    for (const [module, summary] of replacements) {
      const prior = previous.get(module)
      next.set(module, prior === summary ? prior : summary)
    }
  const sorted = sortedModules(next)
  if (
    sorted.size === previous.size &&
    [...sorted].every(([module, summary]) => previous.get(module) === summary)
  )
    return previous
  return sorted
}

/** Replaces or removes only named module partitions while preserving unchanged summary identity. */
export const revise = (self: WorkspaceInventory, revision: Revision): WorkspaceInventory => {
  const project = reviseTier(self.project, revision.project, revision.removeProject)
  const toolchain = reviseTier(self.toolchain, revision.toolchain, revision.removeToolchain)
  if (
    project === self.project &&
    toolchain === self.toolchain &&
    revision.observation === undefined
  )
    return self
  return build(project, toolchain, revision.observation, self.distribution, {
    ...(self.profile === undefined ? {} : { profile: self.profile }),
    ...(self.identity === undefined || project !== self.project || toolchain !== self.toolchain
      ? {}
      : { identity: self.identity }),
  })
}

/** Returns candidates for one exact, case-sensitive spelling in deterministic order. */
export const candidates = (self: WorkspaceInventory, spelling: string): ReadonlyArray<Candidate> =>
  self.byName.get(spelling) ?? []

/** Returns a summary for one canonical module identity from either tier. */
export const summary = (
  self: WorkspaceInventory,
  module: string,
): ModuleSummary.ModuleSummary | undefined => self.project.get(module) ?? self.toolchain.get(module)
