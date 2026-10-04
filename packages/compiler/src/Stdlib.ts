import * as Arr from 'effect/Array'
import { modules, runtimeDefaults, runtimeComponents } from './Stdlib.generated.js'

/** Installed build defaults generated from distribution composition data. */
export const compositions = {
  runtimes: runtimeDefaults,
  components: runtimeComponents,
}

/** The reserved namespace prefix. User resolvers are never consulted for these identities. */
export const namespacePrefix = 'silk/'

/** Tests whether a module identity claims the reserved standard-library namespace. */
export const isReserved = (module: string): boolean =>
  module === 'silk' || module.startsWith(namespacePrefix)

/** One generated view of a canonical, compiler-shipped Silk source file. */
export interface Module {
  readonly module: string
  readonly path: string
  readonly sourceIdentity: string
  readonly digest: string
  readonly documentation: string
  readonly staticInventory: ReadonlyArray<string>
  readonly runtimeInventory: ReadonlyArray<string>
  readonly namespace?: string
  readonly aliases?: ReadonlyArray<string>
  readonly sourceUrl: URL
  readonly bytes: Uint8Array
}

const encoder = new TextEncoder()

const staticInventory = (entry: object): ReadonlyArray<string> =>
  'staticInventory' in entry && Array.isArray(entry.staticInventory) ? entry.staticInventory : []

/** The deterministic standard-library manifest, ordered by canonical module identity. */
export const manifest: Arr.NonEmptyReadonlyArray<Module> = Arr.map(modules, (entry) => ({
  module: entry.module,
  path: entry.path,
  sourceIdentity: entry.sourceIdentity,
  digest: entry.digest,
  documentation: entry.documentation,
  staticInventory: staticInventory(entry),
  runtimeInventory: entry.runtimeInventory,
  ...('namespace' in entry ? { namespace: entry.namespace } : {}),
  ...('aliases' in entry ? { aliases: entry.aliases } : {}),
  sourceUrl: new URL(`../stdlib/${entry.path}`, import.meta.url),
  bytes: encoder.encode(entry.source),
}))

const byModule = new Map(manifest.map((entry) => [entry.module, entry] as const))

const byNamespace = new Map(
  manifest.flatMap((entry) =>
    [entry.namespace, ...(entry.aliases ?? [])].flatMap((namespace) =>
      namespace === undefined ? [] : [[namespace, entry] as const],
    ),
  ),
)

/** Returns the generated manifest entry for one standard-library module identity. */
export const find = (module: string): Module | undefined => byModule.get(module)

/** Resolves one canonical source-backed namespace for catalog discovery and tooling. */
export const findNamespace = (namespace: string): Module | undefined => byNamespace.get(namespace)

/** Every standard-library module's exact source bytes by canonical identity. */
export const sources: ReadonlyMap<string, Uint8Array> = new Map(
  manifest.map((entry) => [entry.module, Uint8Array.from(entry.bytes)] as const),
)
