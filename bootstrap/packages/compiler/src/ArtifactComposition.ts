import * as Stdlib from './Stdlib.js'
import * as Effect from 'effect/Effect'
import * as CompilationProfile from './CompilationProfile.js'
import * as ConfigurationError from './ConfigurationError.js'
import * as ConfigurationOrigin from './ConfigurationOrigin.js'
import * as NativeRequirement from './NativeRequirement.js'
import * as RuntimeComponent from './RuntimeComponent.js'
import * as SourceResolver from './SourceResolver.js'
import * as Canonical from './internal/Canonical.js'

/** One explicit, unambiguous runtime declaration retained without changing source visibility. */
export interface RootSelector {
  readonly module: string
  readonly declaration: string
}

/** A named source composition whose ordinary source calls the application. */
export interface Runtime {
  readonly name: string
  readonly module: string
}

/** Build/package inputs from which one profile selects its source composition. */
export interface Input {
  readonly components?: ReadonlyArray<RuntimeComponent.Input>
  readonly runtimes: ReadonlyArray<Runtime>
  readonly defaults: ReadonlyArray<string>
  readonly retention: ReadonlyArray<RootSelector>
  readonly requirements: ReadonlyArray<NativeRequirement.Input>
  readonly entry?: CompilationProfile.Selection
}

export interface Root extends RootSelector {
  readonly origin: ConfigurationOrigin.ConfigurationOrigin
}

/** Validated build catalog with current diagnostic origins and normalized native constraints. */
export interface ArtifactComposition {
  readonly components: ReadonlyArray<RuntimeComponent.RuntimeComponent>
  readonly runtimes: ReadonlyArray<
    Runtime & { readonly origin: ConfigurationOrigin.ConfigurationOrigin }
  >
  readonly defaults: ReadonlyArray<string>
  readonly retention: ReadonlyArray<Root>
  readonly requirements: ReadonlyArray<NativeRequirement.NativeRequirement>
  readonly entry: CompilationProfile.Selection
  readonly origin: ConfigurationOrigin.ConfigurationOrigin
}

/** Exactly one selected source runtime or none, plus independent retention roots. */
export interface Resolved {
  readonly components: ReadonlyArray<RuntimeComponent.RuntimeComponent>
  readonly application: string
  readonly request: CompilationProfile.Selection
  readonly runtime:
    | (Runtime & { readonly origin: ConfigurationOrigin.ConfigurationOrigin })
    | undefined
  readonly retention: ReadonlyArray<Root>
  readonly requirements: ReadonlyArray<NativeRequirement.NativeRequirement>
  readonly loader: {
    readonly request: CompilationProfile.Selection
    readonly composition: CompilationProfile.Selection
    readonly resolved: CompilationProfile.Selection
  }
  readonly modules: ReadonlyArray<string>
  readonly identity: string
}

const record = (input: unknown): input is Record<string, unknown> =>
  typeof input === 'object' && input !== null && !Array.isArray(input)
const name = (input: unknown): input is string =>
  typeof input === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(input)
const exact = (input: Record<string, unknown>, fields: ReadonlyArray<string>): boolean =>
  Object.keys(input).every((key) => fields.includes(key))

/** Supplies executable source runtimes; libraries and runtime-none profiles acquire no startup. */
export const defaults = (
  profile: Pick<CompilationProfile.Facts, 'artifact' | 'target' | 'libc' | 'runtime'>,
): Input => {
  const executable = profile.artifact === 'executable'
  const selected = executable
    ? Stdlib.compositions.runtimes.find(
        (candidate) =>
          candidate.targets.some((target) => target === profile.target.id) &&
          candidate.libc === profile.libc,
      )
    : undefined
  const runtime =
    selected === undefined ? undefined : { name: selected.name, module: selected.module }
  return {
    runtimes: runtime === undefined ? [] : [runtime],
    defaults: runtime === undefined ? [] : [runtime.name],
    retention: [],
    requirements: [],
    components:
      runtime !== undefined && profile.runtime.kind !== 'none'
        ? Stdlib.compositions.components
        : [],
  }
}

/** Strictly decodes the build catalog; absent fields are empty sets, not hidden runtime defaults. */
export const decode = Effect.fn('ArtifactComposition.decode')(function* (
  input: unknown,
  origin: ConfigurationOrigin.ConfigurationOrigin = ConfigurationOrigin.literal(
    'artifact composition',
  ),
): Effect.fn.Return<ArtifactComposition, ConfigurationError.ConfigurationError> {
  const invalid = (subject: string, origins = [origin]) =>
    ConfigurationError.make('ArtifactComposition.decode', 'InvalidInput', subject, origins)
  if (!ConfigurationOrigin.isPublic(origin))
    return yield* ConfigurationError.make(
      'ArtifactComposition.decode',
      'ForbiddenProvenance',
      'artifact composition',
      [origin],
    )
  if (
    !record(input) ||
    !exact(input, ['runtimes', 'defaults', 'retention', 'requirements', 'entry', 'components'])
  )
    return yield* invalid('artifact composition fields')
  const componentInputs = input.components ?? []
  const runtimeInputs = input.runtimes ?? []
  const defaultInputs = input.defaults ?? []
  const retentionInputs = input.retention ?? []
  const requirementInputs = input.requirements ?? []
  if (
    !Array.isArray(componentInputs) ||
    !Array.isArray(runtimeInputs) ||
    !Array.isArray(defaultInputs) ||
    !Array.isArray(retentionInputs) ||
    !Array.isArray(requirementInputs)
  )
    return yield* invalid('artifact composition lists')
  const components: Array<RuntimeComponent.RuntimeComponent> = []
  for (const [ordinal, value] of componentInputs.entries()) {
    const component = yield* RuntimeComponent.decode(value, {
      ...origin,
      source: `${origin.source}.components[${ordinal}]`,
    })
    const previous = components.find((candidate) => candidate.capability === component.capability)
    if (previous !== undefined)
      return yield* ConfigurationError.make(
        'ArtifactComposition.decode',
        'ConflictingBindings',
        component.capability,
        [previous.origin, component.origin],
      )
    components.push(component)
  }
  const runtimes: Array<Runtime & { readonly origin: ConfigurationOrigin.ConfigurationOrigin }> = []
  for (const [ordinal, candidate] of runtimeInputs.entries()) {
    const at = ConfigurationOrigin.snapshot({
      ...origin,
      source: `${origin.source}.runtimes[${ordinal}]`,
    })
    if (
      !record(candidate) ||
      !exact(candidate, ['name', 'module']) ||
      typeof candidate.name !== 'string' ||
      !NativeRequirement.isIdentity(candidate.name) ||
      typeof candidate.module !== 'string' ||
      !SourceResolver.isCanonicalModule(candidate.module)
    )
      return yield* invalid('runtime descriptor', [at])
    runtimes.push({
      name: candidate.name,
      module: candidate.module,
      origin: at,
    })
  }
  const duplicateNames = new Set(
    runtimes
      .filter(
        (runtime, ordinal) =>
          runtimes.findIndex((candidate) => candidate.name === runtime.name) !== ordinal,
      )
      .map((runtime) => runtime.name),
  )
  if (duplicateNames.size > 0)
    return yield* ConfigurationError.make(
      'ArtifactComposition.decode',
      'ConflictingBindings',
      'runtime descriptors',
      runtimes
        .filter((runtime) => duplicateNames.has(runtime.name))
        .map((runtime) => runtime.origin),
    )
  const defaults: Array<string> = []
  for (const value of defaultInputs) {
    if (typeof value !== 'string' || !NativeRequirement.isIdentity(value))
      return yield* invalid('default runtime identity')
    defaults.push(value)
  }
  const retention: Array<Root> = []
  for (const [ordinal, candidate] of retentionInputs.entries()) {
    const at = ConfigurationOrigin.snapshot({
      ...origin,
      source: `${origin.source}.retention[${ordinal}]`,
    })
    if (
      !record(candidate) ||
      !exact(candidate, ['module', 'declaration']) ||
      typeof candidate.module !== 'string' ||
      !SourceResolver.isCanonicalModule(candidate.module) ||
      !name(candidate.declaration)
    )
      return yield* invalid('retention selector', [at])
    retention.push({ module: candidate.module, declaration: candidate.declaration, origin: at })
  }
  const requirements: Array<NativeRequirement.NativeRequirement> = []
  for (const [ordinal, candidate] of requirementInputs.entries())
    requirements.push(
      yield* NativeRequirement.decode(
        candidate,
        { kind: 'artifact' },
        {
          ...origin,
          source: `${origin.source}.requirements[${ordinal}]`,
        },
      ),
    )
  let entry: CompilationProfile.Selection = { kind: 'default' }
  if (input.entry !== undefined) {
    if (!record(input.entry)) return yield* invalid('composition loader entry')
    if (
      (input.entry.kind === 'default' || input.entry.kind === 'none') &&
      exact(input.entry, ['kind'])
    )
      entry = { kind: input.entry.kind }
    else if (
      input.entry.kind === 'named' &&
      exact(input.entry, ['kind', 'name']) &&
      typeof input.entry.name === 'string' &&
      NativeRequirement.isIdentity(input.entry.name)
    )
      entry = { kind: 'named', name: input.entry.name }
    else return yield* invalid('composition loader entry')
  }
  return {
    components: components.sort((a, b) => Canonical.compare(a.capability, b.capability)),
    runtimes: runtimes.sort((a, b) => Canonical.compare(a.name, b.name)),
    defaults: [...new Set(defaults)].sort(Canonical.compare),
    retention: retention.sort((a, b) => Canonical.compare(rootKey(a), rootKey(b))),
    requirements: requirements,
    entry,
    origin: ConfigurationOrigin.snapshot(origin),
  }
})

/** Canonical declaration selector encoding, excluding current configuration location. */
export const rootKey = (self: RootSelector): string =>
  Canonical.record('root', [self.module, self.declaration])

/** Selects one profile's roots from a validated catalog without resolving source or physical files. */
export const resolve = Effect.fn('ArtifactComposition.resolve')(function* (
  self: ArtifactComposition,
  application: string,
  profile: CompilationProfile.Facts,
): Effect.fn.Return<Resolved, ConfigurationError.ConfigurationError> {
  if (!SourceResolver.isCanonicalModule(application))
    return yield* ConfigurationError.make(
      'ArtifactComposition.resolve',
      'InvalidInput',
      'application root',
      [self.origin],
    )
  const request = profile.runtime
  let candidates: ReadonlyArray<string> = []
  if (request.kind === 'default') candidates = self.defaults
  else if (request.kind === 'named') candidates = [request.name]
  const selected = self.runtimes.filter((runtime) => candidates.includes(runtime.name))
  if (selected.length !== candidates.length)
    return yield* ConfigurationError.make(
      'ArtifactComposition.resolve',
      'MissingParameter',
      'runtime composition',
      [self.origin],
      candidates.filter((candidate) => !selected.some((runtime) => runtime.name === candidate)),
    )
  if (selected.length > 1)
    return yield* ConfigurationError.make(
      'ArtifactComposition.resolve',
      'ConflictingBindings',
      'runtime composition',
      selected.map((runtime) => runtime.origin),
    )
  const runtime = selected[0]
  const retained = new Map(self.retention.map((root) => [rootKey(root), root]))
  const retention = [...retained.values()]
  if (
    profile.entry.kind !== 'default' &&
    self.entry.kind !== 'default' &&
    CompilationProfile.encodeSelection(profile.entry) !==
      CompilationProfile.encodeSelection(self.entry)
  )
    return yield* ConfigurationError.make(
      'ArtifactComposition.resolve',
      'ConflictingBindings',
      'loader entry',
      [ConfigurationOrigin.literal('profile.entry'), self.origin],
    )
  const loader = {
    request: profile.entry,
    composition: self.entry,
    resolved: profile.entry.kind === 'default' ? self.entry : profile.entry,
  }
  const modules = [
    ...new Set([
      application,
      ...(runtime === undefined ? [] : [runtime.module]),
      ...retention.map((root) => root.module),
    ]),
  ].sort(Canonical.compare)
  const identity = Canonical.record('ArtifactComposition.v2', [
    Canonical.array(self.components.map(RuntimeComponent.encode)),
    application,
    CompilationProfile.encodeSelection(request),
    Canonical.array(request.kind === 'default' ? self.defaults : []),
    Canonical.record('runtime', runtime === undefined ? [] : [runtime.name, runtime.module]),
    Canonical.array(retention.map(rootKey)),
    Canonical.array(self.requirements.map(NativeRequirement.encode).sort(Canonical.compare)),
    CompilationProfile.encodeSelection(loader.request),
    CompilationProfile.encodeSelection(loader.composition),
    CompilationProfile.encodeSelection(loader.resolved),
  ])
  return {
    application,
    components: self.components,
    request,
    runtime,
    retention,
    requirements: self.requirements,
    loader,
    modules,
    identity,
  }
})

/** Projects a validated catalog into portable build fields without diagnostic metadata. */
export const input = (self: ArtifactComposition): Input => ({
  components: self.components.map(RuntimeComponent.input),
  runtimes: self.runtimes.map(({ origin: _origin, ...runtime }) => runtime),
  defaults: self.defaults,
  retention: self.retention.map(({ origin: _origin, ...root }) => root),
  requirements: self.requirements.map(
    ({ origin: _origin, scope: _scope, ...requirement }) => requirement,
  ),
  entry: self.entry,
})
