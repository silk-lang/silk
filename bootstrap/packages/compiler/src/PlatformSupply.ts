import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import type * as CompilationProfile from './CompilationProfile.js'
import type * as Target from './Target.js'

/** A separately selected installation whose compatibility is explicitly asserted by the caller. */
export interface Installation {
  readonly root: string
  readonly target: Target.Id
  readonly origin: string
}

/** Physical configuration; none of these paths are logical compilation-profile facts. */
export interface Explicit {
  readonly kind: 'explicit'
  readonly target: Target.Id
  readonly root: string
  readonly linker: string
  readonly origin: string
  readonly support?: ReadonlyArray<Installation>
}

export interface Managed {
  readonly kind: 'managed'
  readonly name: string
}

export type Pin = Explicit | Managed
export type Request = Pin | { readonly kind: 'native' } | { readonly kind: 'automatic' }

export interface Selection {
  readonly request: Exclude<Request, { readonly kind: 'automatic' }>
  readonly origin: 'request' | 'artifact' | 'project' | 'host'
}

export type Code =
  | 'UnsupportedProvider'
  | 'HostMismatch'
  | 'TargetMismatch'
  | 'InvalidConfiguration'
  | 'MissingCapability'
  | 'DeploymentMismatch'
  | 'MixedInstallation'
  | 'UnsupportedInput'
  | 'ChangedInput'
  | 'QueryFailed'
  | 'StorageFailed'

/** Expected physical configuration or boundary failure, retaining the selected input's origin. */
export class SupplyError extends Data.TaggedError('SupplyError')<{
  readonly operation: string
  readonly code: Code
  readonly subject: string
  readonly origin: string
  readonly message: string
  readonly correction: string
  readonly query?: Query
  readonly cause?: unknown
}> {}

export const failure = (
  code: Code,
  subject: string,
  origin: string,
  correction: string,
): SupplyError =>
  new SupplyError({
    operation: 'PlatformSupply.resolve',
    code,
    subject,
    origin,
    message: `${code}: ${subject} (${origin})`,
    correction,
  })

/** Selects once; an explicit provider failure cannot reach a second provider. */
export const select = Effect.fn('PlatformSupply.select')(function* (
  target: Target.Target,
  host: Target.Id | undefined,
  request: Request = { kind: 'automatic' },
  artifact?: Pin,
  project?: Pin,
): Effect.fn.Return<Selection, SupplyError> {
  let selected: Selection
  if (request.kind !== 'automatic') selected = { request, origin: 'request' }
  else if (artifact !== undefined) selected = { request: artifact, origin: 'artifact' }
  else if (project !== undefined) selected = { request: project, origin: 'project' }
  else selected = { request: { kind: 'native' }, origin: 'host' }
  if (selected.request.kind === 'managed')
    return yield* failure(
      'UnsupportedProvider',
      selected.request.name,
      selected.origin,
      'Select an explicit installed supply; managed installation is not supported.',
    )
  if (selected.request.kind === 'native' && host !== target.id)
    return yield* failure(
      'HostMismatch',
      target.id,
      selected.origin,
      'Provide an explicit supply for the requested target.',
    )
  if (selected.request.kind === 'explicit' && selected.request.target !== target.id)
    return yield* failure(
      'TargetMismatch',
      selected.request.target,
      selected.request.origin,
      `Provide an explicit supply for ${target.id}.`,
    )
  return {
    ...selected,
    request: {
      ...selected.request,
      ...(selected.request.kind === 'explicit' && selected.request.support !== undefined
        ? {
            support: selected.request.support.map((item) => ({ ...item })),
          }
        : {}),
    },
  }
})

export interface Query {
  readonly command: string
  readonly arguments: ReadonlyArray<string>
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
}

export type Role =
  | 'compiler'
  | 'linker'
  | 'archiver'
  | 'metadata'
  | 'object'
  | 'archive'
  | 'library'
  | 'script'
  | 'stub'
  | 'framework'
  | 'interpreter'
  | 'header'
  | 'support'
  | 'crt'

/** One selected file. Its path is provenance; embedded names are accounted for separately. */
export interface File {
  readonly selectedPath: string
  readonly root: string
  readonly path: string
  readonly digest: string
  readonly role: Role
  readonly origin: string
}

export interface Tool extends File {
  readonly command: string
  readonly version: string
}

/** Immutable provider evidence shared by native consumers, outside compiler semantics. */
export interface PlatformSupply {
  readonly _tag: 'PlatformSupply'
  readonly target: Target.Target
  readonly libc: CompilationProfile.Libc
  readonly deployment: string | undefined
  readonly selection: Selection
  readonly root: string
  readonly version: string | undefined
  readonly installations: ReadonlyArray<Installation>
  readonly compiler: Tool
  readonly linker: Tool
  readonly archiver: Tool
  readonly environment: Readonly<Record<string, string>>
  readonly consultedEnvironment: Readonly<Record<string, string>>
  readonly queries: ReadonlyArray<Query>
  readonly files: ReadonlyArray<File>
  readonly libraryRoots: ReadonlyArray<string>
  readonly frameworkRoots: ReadonlyArray<string>
  readonly compilationArguments: ReadonlyArray<string>
}

/** Compares normalized numeric deployment versions without locale-dependent ordering. */
export const compareVersions = (left: string, right: string): number => {
  const a = left.split('.').map(Number)
  const b = right.split('.').map(Number)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

const isRecord = (input: unknown): input is Record<string, unknown> =>
  typeof input === 'object' && input !== null && !Array.isArray(input)

/** Decodes the physical request surface independently of logical profile decoding. */
export const decode = Effect.fn('PlatformSupply.decode')(function* (
  input: unknown,
  origin: string,
): Effect.fn.Return<Request, SupplyError> {
  const invalid = () =>
    failure(
      'InvalidConfiguration',
      'platform-supply',
      origin,
      'Use kind automatic/native, managed with name, or explicit with target/root/linker/origin and optional support installations.',
    )
  if (!isRecord(input)) return yield* invalid()
  const value: Record<string, unknown> = input
  const exact = (keys: ReadonlyArray<string>) =>
    Object.keys(value).every((key) => keys.includes(key))
  if ((value['kind'] === 'automatic' || value['kind'] === 'native') && exact(['kind']))
    return { kind: value['kind'] }
  if (value['kind'] === 'managed' && typeof value['name'] === 'string' && exact(['kind', 'name']))
    return { kind: 'managed', name: value['name'] }
  const targets: ReadonlyArray<Target.Id> = [
    'aarch64-apple-darwin',
    'x86_64-unknown-linux-gnu',
    'aarch64-unknown-linux-gnu',
  ]
  const target = targets.find((candidate) => candidate === value['target'])
  if (
    value['kind'] !== 'explicit' ||
    target === undefined ||
    typeof value['root'] !== 'string' ||
    typeof value['linker'] !== 'string' ||
    !exact(['kind', 'target', 'root', 'linker', 'origin', 'support'])
  )
    return yield* invalid()
  const support: Array<Installation> = []
  const rawSupport = value['support'] ?? []
  if (!Array.isArray(rawSupport)) return yield* invalid()
  for (const item of rawSupport) {
    if (!isRecord(item)) return yield* invalid()
    const fields: Record<string, unknown> = item
    const supportTarget = targets.find((candidate) => candidate === fields['target'])
    if (
      typeof fields['root'] !== 'string' ||
      typeof fields['origin'] !== 'string' ||
      supportTarget === undefined ||
      !Object.keys(fields).every((key) => ['root', 'target', 'origin'].includes(key))
    )
      return yield* invalid()
    support.push({ root: fields['root'], target: supportTarget, origin: fields['origin'] })
  }
  if (value['origin'] !== undefined && typeof value['origin'] !== 'string') return yield* invalid()
  return {
    kind: 'explicit',
    target,
    root: value['root'],
    linker: value['linker'],
    origin: typeof value['origin'] === 'string' ? value['origin'] : origin,
    support: support,
  }
})
