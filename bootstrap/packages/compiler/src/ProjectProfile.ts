import * as Canonical from './internal/Canonical.js'
import * as Effect from 'effect/Effect'
import * as CompilationProfile from './CompilationProfile.js'
import * as ConfigurationError from './ConfigurationError.js'
import * as ConfigurationOrigin from './ConfigurationOrigin.js'
import * as ConfigurationValue from './ConfigurationValue.js'
import type * as PackageConfiguration from './PackageConfiguration.js'

/** One named, validated logical profile and its high-tier parameter bindings. */
export interface Profile {
  readonly input: CompilationProfile.Input
  readonly bindings: ReadonlyArray<PackageConfiguration.Binding>
}

/** Project-owned selection data; physical manifest/output paths are diagnostic provenance only. */
export interface Catalog {
  readonly default?: string
  readonly profiles: ReadonlyMap<string, Profile>
  readonly bindings: ReadonlyArray<PackageConfiguration.Binding>
  readonly origin: ConfigurationOrigin.ConfigurationOrigin
}

export interface Selection {
  readonly name?: string
  readonly target?: string
  readonly override?: Profile
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const invalid = (origin: ConfigurationOrigin.ConfigurationOrigin, subject: string) =>
  ConfigurationError.make('ProjectProfile', 'InvalidInput', subject, [origin])

/** Decodes explicit transport bindings, checking provenance before reading their values. */
export const decodeBindings = Effect.fn('ProjectProfile.decodeBindings')(function* (
  input: unknown,
  tier: PackageConfiguration.Binding['tier'],
  origin: ConfigurationOrigin.ConfigurationOrigin,
): Effect.fn.Return<
  ReadonlyArray<PackageConfiguration.Binding>,
  ConfigurationError.ConfigurationError
> {
  if (input === undefined) return []
  if (!Array.isArray(input)) return yield* invalid(origin, 'bindings')
  const bindings: Array<PackageConfiguration.Binding> = []
  for (const item of input) {
    if (!record(item)) return yield* invalid(origin, 'binding')
    const metadata = item.origin
    if (
      !record(metadata) ||
      typeof metadata.source !== 'string' ||
      typeof metadata.provenance !== 'string'
    )
      return yield* invalid(origin, 'binding origin')
    const provenance = [
      'literal',
      'translated-public',
      'secret',
      'physical-supply',
      'runtime',
    ] as const
    const kind = provenance.find((candidate) => candidate === metadata.provenance)
    if (
      kind === undefined ||
      (metadata.translator !== undefined && typeof metadata.translator !== 'string')
    )
      return yield* invalid(origin, 'binding provenance')
    const bindingOrigin: ConfigurationOrigin.ConfigurationOrigin = ConfigurationOrigin.snapshot({
      source: metadata.source,
      provenance: kind,
      ...(typeof metadata.translator === 'string' ? { translator: metadata.translator } : {}),
    })
    if (!ConfigurationOrigin.isPublic(bindingOrigin))
      return yield* ConfigurationError.make(
        'ProjectProfile.decodeBindings',
        'ForbiddenProvenance',
        'binding',
        [bindingOrigin],
      )
    if (
      Object.keys(item).some(
        (key) => !['package', 'module', 'parameter', 'value', 'origin'].includes(key),
      ) ||
      typeof item.package !== 'string' ||
      typeof item.module !== 'string' ||
      typeof item.parameter !== 'string'
    )
      return yield* invalid(origin, 'binding identity')
    const value = yield* ConfigurationValue.decode(item.value, bindingOrigin)
    bindings.push({
      package: item.package,
      module: item.module,
      parameter: item.parameter,
      value,
      origin: bindingOrigin,
      tier,
    })
  }
  return bindings
})

/** Decodes a complete logical override, including its profile-tier bindings. */
export const decode = Effect.fn('ProjectProfile.decode')(function* (
  input: unknown,
  origin: ConfigurationOrigin.ConfigurationOrigin,
): Effect.fn.Return<Profile, ConfigurationError.ConfigurationError> {
  if (!record(input)) return yield* invalid(origin, 'profile')
  const bindings = yield* decodeBindings(input.bindings, 'profile', origin)
  const logical = Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'bindings'))
  const initial = yield* CompilationProfile.decode(logical, origin)
  return { input: CompilationProfile.input(initial), bindings }
})

/** Reads named profiles and the project-tier bindings from a parsed manifest. */
export const catalog = Effect.fn('ProjectProfile.catalog')(function* (
  profilesInput: unknown,
  defaultInput: unknown,
  bindingsInput: unknown,
  origin: ConfigurationOrigin.ConfigurationOrigin,
): Effect.fn.Return<Catalog, ConfigurationError.ConfigurationError> {
  if (profilesInput !== undefined && !record(profilesInput))
    return yield* invalid(origin, 'profiles')
  if (defaultInput !== undefined && typeof defaultInput !== 'string')
    return yield* invalid(origin, 'build.profile')
  const profiles = new Map<string, Profile>()
  for (const [name, value] of Object.entries(profilesInput ?? {}).toSorted(([a], [b]) =>
    Canonical.compare(a, b),
  )) {
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(name)) return yield* invalid(origin, 'profile name')
    profiles.set(name, yield* decode(value, origin))
  }
  if (defaultInput !== undefined && !profiles.has(defaultInput))
    return yield* invalid(origin, 'unknown build.profile')
  const bindings = yield* decodeBindings(bindingsInput, 'project', origin)
  return {
    profiles,
    bindings,
    origin: ConfigurationOrigin.snapshot(origin),
    ...(defaultInput === undefined ? {} : { default: defaultInput }),
  }
})

/** Resolves exclusive request modes, then a named project default, then explicit edge fallback. */
export const select = Effect.fn('ProjectProfile.select')(function* (
  catalog: Catalog,
  request: Selection,
  fallbackTarget?: string,
): Effect.fn.Return<Profile, ConfigurationError.ConfigurationError> {
  const modes =
    Number(request.name !== undefined) +
    Number(request.target !== undefined) +
    Number(request.override !== undefined)
  if (modes > 1)
    return yield* ConfigurationError.make(
      'ProjectProfile.select',
      'ConflictingBindings',
      'profile selection modes',
      [catalog.origin],
    )
  const name = request.name ?? (modes === 0 ? catalog.default : undefined)
  if (name !== undefined) {
    const profile = catalog.profiles.get(name)
    if (profile === undefined) return yield* invalid(catalog.origin, `unknown profile ${name}`)
    return {
      input: profile.input,
      bindings: [...catalog.bindings, ...profile.bindings],
    }
  }
  if (request.override !== undefined) {
    const initial = yield* CompilationProfile.normalize(request.override.input, catalog.origin)
    return {
      input: CompilationProfile.input(initial),
      bindings: [...catalog.bindings, ...request.override.bindings],
    }
  }
  const target = request.target ?? fallbackTarget
  if (target === undefined)
    return yield* invalid(catalog.origin, 'missing target or profile selection')
  const initial = yield* CompilationProfile.normalize({ target }, catalog.origin)
  return { input: CompilationProfile.input(initial), bindings: catalog.bindings }
})

/** Decodes the language-server initialization profile/name/target selection object. */
export const selection = Effect.fn('ProjectProfile.selection')(function* (
  input: unknown,
  origin: ConfigurationOrigin.ConfigurationOrigin,
): Effect.fn.Return<Selection, ConfigurationError.ConfigurationError> {
  if (input === undefined) return {}
  if (
    !record(input) ||
    Object.keys(input).some((key) => !['profile', 'profileInput', 'target'].includes(key)) ||
    (input.profile !== undefined && typeof input.profile !== 'string') ||
    (input.target !== undefined && typeof input.target !== 'string')
  )
    return yield* invalid(origin, 'profile selection settings')
  const override =
    input.profileInput === undefined ? undefined : yield* decode(input.profileInput, origin)
  return {
    ...(input.profile === undefined ? {} : { name: input.profile }),
    ...(input.target === undefined ? {} : { target: input.target }),
    ...(override === undefined ? {} : { override }),
  }
})
