import * as Effect from 'effect/Effect'
import * as ConfigurationError from './ConfigurationError.js'
import * as ConfigurationOrigin from './ConfigurationOrigin.js'
import * as ConfigurationValue from './ConfigurationValue.js'
import * as Canonical from './internal/Canonical.js'
import * as Target from './Target.js'

export type Libc = 'none' | 'system' | 'gnu'
export type Artifact = 'executable' | 'loadable-module' | 'static-archive' | 'object'
export type Link = 'static' | 'dynamic'
export type CodeModel = 'small' | 'large'
export type Relocation = 'static' | 'pic'
export type Optimization = 'none' | 'speed'
export type Safety = 'checked' | 'unchecked'
export type Threading = 'single' | 'multi'
export type Sanitizer = 'address' | 'thread' | 'undefined'
export type Unwind = 'none' | 'native'

/** A logical selection; names are identities, never paths to physical supplies. */
export type Selection =
  | { readonly kind: 'default' | 'none' }
  | { readonly kind: 'named'; readonly name: string }

export interface Cpu {
  readonly model: string
  readonly features: ReadonlyArray<string>
}

/** User-supplied logical facts. Unspecified fields have deterministic target-specific defaults. */
export interface Input {
  readonly target: string
  readonly cpu?: { readonly model?: string; readonly features?: ReadonlyArray<string> }
  readonly deployment?: string
  readonly libc?: Libc
  readonly artifact?: Artifact
  readonly entry?: Selection
  readonly link?: Link
  readonly codeModel?: CodeModel
  readonly relocation?: Relocation
  readonly optimization?: Optimization
  readonly debug?: boolean
  readonly safety?: Safety
  readonly threading?: Threading
  readonly sanitizers?: ReadonlyArray<Sanitizer>
  readonly unwind?: Unwind
  readonly runtime?: Selection
}

/** Fully normalized logical facts shared by bootstrap and completed profiles. */
export interface Facts {
  readonly target: Target.Target
  readonly cpu: Cpu
  readonly deployment: string | undefined
  readonly libc: Libc
  readonly artifact: Artifact
  readonly entry: Selection
  readonly link: Link
  readonly codeModel: CodeModel
  readonly relocation: Relocation
  readonly optimization: Optimization
  readonly debug: boolean
  readonly safety: Safety
  readonly threading: Threading
  readonly sanitizers: ReadonlyArray<Sanitizer>
  readonly unwind: Unwind
  readonly runtime: Selection
}

const initialMarker: unique symbol = Symbol('CompilationProfile.initial')
const publishedMarker: unique symbol = Symbol('CompilationProfile.published')

/** Immutable bootstrap facts; this is deliberately not a completed compilation profile. */
export interface Initial extends Facts {
  readonly _tag: 'InitialCompilationProfile'
  readonly [initialMarker]: true
  readonly identity: string
}

/** Stable logical identity independent of import aliases and physical package locations. */
export interface ParameterIdentity {
  readonly package: string
  readonly module: string
  readonly parameter: string
}

/** A schema-checked final value; its current-request origin does not enter semantic identity. */
export interface Parameter extends ParameterIdentity {
  readonly type: string
  readonly value: ConfigurationValue.ConfigurationValue
  readonly origin: ConfigurationOrigin.ConfigurationOrigin
}

/** One published immutable profile consumed by ordinary specialization and artifact planning. */
export interface CompilationProfile extends Facts {
  readonly _tag: 'CompilationProfile'
  readonly [publishedMarker]: true
  readonly identity: string
  readonly parameters: ReadonlyArray<Parameter>
}

const keys = [
  'target',
  'cpu',
  'deployment',
  'libc',
  'artifact',
  'entry',
  'link',
  'codeModel',
  'relocation',
  'optimization',
  'debug',
  'safety',
  'threading',
  'sanitizers',
  'unwind',
  'runtime',
]

const isRecord = (input: unknown): input is Record<string, unknown> =>
  typeof input === 'object' && input !== null && !Array.isArray(input)

const get = (input: Record<string, unknown>, key: string): unknown =>
  Object.hasOwn(input, key) ? input[key] : undefined

const choice = Effect.fnUntraced(function* <const Values extends ReadonlyArray<string>>(
  input: Record<string, unknown>,
  key: string,
  values: Values,
  fallback: Values[number],
  origin: ConfigurationOrigin.ConfigurationOrigin,
): Effect.fn.Return<Values[number], ConfigurationError.ConfigurationError> {
  const value = get(input, key)
  if (value === undefined) return fallback
  const found = values.find((candidate) => candidate === value)
  if (found !== undefined) return found
  return yield* ConfigurationError.make('CompilationProfile.normalize', 'InvalidInput', key, [
    origin,
  ])
})

const selection = Effect.fnUntraced(function* (
  input: unknown,
  subject: string,
  origin: ConfigurationOrigin.ConfigurationOrigin,
): Effect.fn.Return<Selection, ConfigurationError.ConfigurationError> {
  if (input === undefined) return { kind: 'default' }
  if (isRecord(input)) {
    const kind = get(input, 'kind')
    const name = get(input, 'name')
    if ((kind === 'none' || kind === 'default') && Object.keys(input).length === 1) return { kind }
    if (
      kind === 'named' &&
      typeof name === 'string' &&
      /^[A-Za-z0-9_][A-Za-z0-9_@.+:/-]*$/.test(name) &&
      !name.startsWith('/') &&
      !name.includes('..') &&
      Object.keys(input).length === 2
    )
      return { kind, name }
  }
  return yield* ConfigurationError.make('CompilationProfile.normalize', 'InvalidInput', subject, [
    origin,
  ])
})

const stringSet = Effect.fnUntraced(function* (
  input: unknown,
  subject: string,
  origin: ConfigurationOrigin.ConfigurationOrigin,
): Effect.fn.Return<ReadonlyArray<string>, ConfigurationError.ConfigurationError> {
  if (input === undefined) return []
  if (!Array.isArray(input))
    return yield* ConfigurationError.make('CompilationProfile.normalize', 'InvalidInput', subject, [
      origin,
    ])
  const values: Array<string> = []
  for (const value of input) {
    if (typeof value !== 'string')
      return yield* ConfigurationError.make(
        'CompilationProfile.normalize',
        'InvalidInput',
        subject,
        [origin],
      )
    values.push(value)
  }
  return [...new Set(values)].sort()
})

/** Canonical encoding of the fully normalized logical domains, excluding provenance. */
const encodeFacts = (self: Facts): string =>
  Canonical.record('CompilationFacts.v1', [
    Target.encode(self.target),
    Canonical.record('cpu', [self.cpu.model, Canonical.array(self.cpu.features)]),
    Canonical.record('deployment', self.deployment === undefined ? [] : [self.deployment]),
    self.libc,
    self.artifact,
    encodeSelection(self.entry),
    self.link,
    self.codeModel,
    self.relocation,
    self.optimization,
    String(self.debug),
    self.safety,
    self.threading,
    Canonical.array(self.sanitizers),
    self.unwind,
    encodeSelection(self.runtime),
  ])

/** Encodes default, named and absent requests without ambiguous sentinel names. */
export const encodeSelection = (self: Selection): string =>
  Canonical.record(self.kind, self.kind === 'named' ? [self.name] : [])

/** Resolves untrusted logical input without reading host, environment or physical supplies. */
export const decode = Effect.fn('CompilationProfile.decode')(function* (
  input: unknown,
  origin: ConfigurationOrigin.ConfigurationOrigin = ConfigurationOrigin.literal('profile'),
): Effect.fn.Return<Initial, ConfigurationError.ConfigurationError> {
  const invalid = (subject: string) =>
    ConfigurationError.make('CompilationProfile.normalize', 'InvalidInput', subject, [origin])
  const unsupported = (subject: string) =>
    ConfigurationError.make('CompilationProfile.normalize', 'UnsupportedCombination', subject, [
      origin,
    ])
  if (!ConfigurationOrigin.isPublic(origin))
    return yield* ConfigurationError.make(
      'CompilationProfile.normalize',
      'ForbiddenProvenance',
      'profile',
      [origin],
    )
  if (!isRecord(input) || Object.keys(input).some((key) => !keys.includes(key)))
    return yield* invalid('profile fields')
  const targetId = get(input, 'target')
  if (typeof targetId !== 'string') return yield* invalid('target')
  const selected = Target.select(targetId)
  if (selected._tag === 'Unavailable') return yield* unsupported('target')
  const target = selected.target
  const cpuInput = get(input, 'cpu')
  if (
    cpuInput !== undefined &&
    (!isRecord(cpuInput) ||
      Object.keys(cpuInput).some((key) => key !== 'model' && key !== 'features'))
  )
    return yield* invalid('cpu')
  const cpuRecord = isRecord(cpuInput) ? cpuInput : {}
  const model = get(cpuRecord, 'model') ?? target.defaultCpu
  if (typeof model !== 'string' || !target.supportedCpus.includes(model))
    return yield* unsupported('cpu.model')
  const requestedFeatures = yield* stringSet(get(cpuRecord, 'features'), 'cpu.features', origin)
  if (requestedFeatures.some((feature) => !target.supportedFeatures.includes(feature)))
    return yield* unsupported('cpu.features')
  const features = new Set(requestedFeatures)
  if (target.architecture === 'aarch64') {
    features.add('fp-armv8')
    features.add('neon')
  }
  if (target.architecture === 'x86_64') features.add('sse2')
  if (features.has('avx2')) features.add('avx')
  const cpu: Cpu = { model, features: [...features].sort() }
  const deploymentInput = get(input, 'deployment')
  if (
    deploymentInput !== undefined &&
    (typeof deploymentInput !== 'string' ||
      !/^(0|[1-9][0-9]*)(\.(0|[1-9][0-9]*)){0,2}$/.test(deploymentInput))
  )
    return yield* invalid('deployment')
  const deployment =
    typeof deploymentInput === 'string'
      ? [...deploymentInput.split('.'), '0', '0'].slice(0, 3).join('.')
      : undefined
  let defaultLibc: Libc = 'none'
  if (target.abi === 'apple') defaultLibc = 'system'
  if (target.abi === 'gnu') defaultLibc = 'gnu'
  const libc = yield* choice(input, 'libc', ['none', 'system', 'gnu'], defaultLibc, origin)
  const artifact = yield* choice(
    input,
    'artifact',
    ['executable', 'loadable-module', 'static-archive', 'object'],
    'executable',
    origin,
  )
  const entry = yield* selection(get(input, 'entry'), 'entry', origin)
  const link = yield* choice(
    input,
    'link',
    ['static', 'dynamic'],
    target.kind === 'WebAssembly' ? 'static' : 'dynamic',
    origin,
  )
  const codeModel = yield* choice(input, 'codeModel', ['small', 'large'], 'small', origin)
  const relocation = yield* choice(
    input,
    'relocation',
    ['static', 'pic'],
    target.kind === 'WebAssembly' ? 'static' : 'pic',
    origin,
  )
  const optimization = yield* choice(input, 'optimization', ['none', 'speed'], 'none', origin)
  const debugInput = get(input, 'debug')
  if (debugInput !== undefined && typeof debugInput !== 'boolean') return yield* invalid('debug')
  const debug = debugInput ?? true
  const safety = yield* choice(input, 'safety', ['checked', 'unchecked'], 'checked', origin)
  const threading = yield* choice(input, 'threading', ['single', 'multi'], 'single', origin)
  const sanitizerNames = yield* stringSet(get(input, 'sanitizers'), 'sanitizers', origin)
  const sanitizers: Array<Sanitizer> = []
  for (const name of sanitizerNames) {
    if (name !== 'address' && name !== 'thread' && name !== 'undefined')
      return yield* invalid('sanitizers')
    sanitizers.push(name)
  }
  const unwind = yield* choice(input, 'unwind', ['none', 'native'], 'none', origin)
  const runtime = yield* selection(get(input, 'runtime'), 'runtime', origin)
  if (
    (target.operatingSystem === 'darwin' &&
      (libc === 'gnu' ||
        (libc === 'none' && artifact !== 'object' && artifact !== 'static-archive'))) ||
    (target.operatingSystem === 'linux' && libc === 'system') ||
    (target.kind === 'WebAssembly' && libc !== 'none')
  )
    return yield* unsupported('libc')
  if (
    target.kind === 'WebAssembly' &&
    (deployment !== undefined ||
      link !== 'static' ||
      codeModel !== 'small' ||
      relocation !== 'static' ||
      sanitizers.length > 0 ||
      unwind !== 'none')
  )
    return yield* unsupported('WebAssembly build facts')
  if (sanitizers.includes('address') && sanitizers.includes('thread'))
    return yield* unsupported('sanitizers')
  if (sanitizers.includes('thread') && threading !== 'multi') return yield* unsupported('threading')
  if (target.operatingSystem === 'darwin' && link === 'static' && artifact === 'executable')
    return yield* unsupported('Darwin static executable')
  const facts: Facts = {
    target,
    cpu,
    deployment,
    libc,
    artifact,
    entry,
    link,
    codeModel,
    relocation,
    optimization,
    debug,
    safety,
    threading,
    sanitizers: sanitizers,
    unwind,
    runtime,
  }
  return {
    ...facts,
    _tag: 'InitialCompilationProfile',
    [initialMarker]: true,
    identity: Canonical.record('InitialProfile.v1', [encodeFacts(facts)]),
  } as Initial
})

/** Normalizes typed application-edge input with the same checks used for external transport. */
export const normalize = Effect.fn('CompilationProfile.normalize')(function* (
  input: Input,
  origin?: ConfigurationOrigin.ConfigurationOrigin,
): Effect.fn.Return<Initial, ConfigurationError.ConfigurationError> {
  return yield* decode(input, origin)
})

/** Stable tuple encoding of package/parameter identity. */
export const parameterKey = (self: ParameterIdentity): string =>
  Canonical.record('Parameter', [self.package, self.module, self.parameter])

/**
 * Publishes schema-checked parameters after all default and predicate evaluations have succeeded.
 * The source bootstrap owns schema validation; publication defensively copies admitted values.
 */
export const publish = Effect.fn('CompilationProfile.publish')(function* (
  initial: Initial,
  parameters: ReadonlyArray<Parameter>,
): Effect.fn.Return<CompilationProfile, ConfigurationError.ConfigurationError> {
  const ordered = [...parameters].sort((left, right) =>
    Canonical.compare(parameterKey(left), parameterKey(right)),
  )
  const retained: Array<Parameter> = []
  const seen = new Set<string>()
  for (const parameter of ordered) {
    const key = parameterKey(parameter)
    if (seen.has(key))
      return yield* ConfigurationError.make(
        'CompilationProfile.publish',
        'ConflictingBindings',
        key,
        [parameter.origin],
      )
    seen.add(key)
    const value = yield* ConfigurationValue.decode(parameter.value, parameter.origin)
    retained.push({
      ...parameter,
      value,
      origin: ConfigurationOrigin.snapshot(parameter.origin),
    })
  }
  const values = retained
  return {
    ...initial,
    _tag: 'CompilationProfile',
    [publishedMarker]: true,
    parameters: values,
    identity: Canonical.record('CompilationProfile.v1', [
      encodeFacts(initial),
      Canonical.array(
        values.map((parameter) =>
          Canonical.record(parameterKey(parameter), [
            parameter.type,
            ConfigurationValue.encode(parameter.value),
          ]),
        ),
      ),
    ]),
  } as CompilationProfile
})

/** Returns the canonical versioned encoding used as the profile's semantic identity. */
export const encode = (self: CompilationProfile | Initial): string => self.identity

/** Projects normalized facts back into the portable logical request shape. */
export const input = (self: CompilationProfile | Initial): Input => ({
  target: self.target.id,
  cpu: self.cpu,
  ...(self.deployment === undefined ? {} : { deployment: self.deployment }),
  libc: self.libc,
  artifact: self.artifact,
  entry: self.entry,
  link: self.link,
  codeModel: self.codeModel,
  relocation: self.relocation,
  optimization: self.optimization,
  debug: self.debug,
  safety: self.safety,
  threading: self.threading,
  sanitizers: self.sanitizers,
  unwind: self.unwind,
  runtime: self.runtime,
})

/** Looks up a final value by stable identity without exposing mutable profile storage. */
export const parameter = (
  self: CompilationProfile,
  identity: ParameterIdentity,
): Parameter | undefined =>
  self.parameters.find((candidate) => parameterKey(candidate) === parameterKey(identity))
