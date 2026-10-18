import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as Canonical from './internal/Canonical.js'

export type Architecture = 'aarch64' | 'x86_64' | 'wasm32'
export type OperatingSystem = 'darwin' | 'linux' | 'freestanding'
export type Abi = 'apple' | 'gnu' | 'wasm'
export type ObjectFormat = 'macho' | 'elf' | 'wasm'

/** Storage facts for an admitted primitive, in bytes. */
export interface Primitive {
  readonly size: 1 | 2 | 4 | 8
  readonly alignment: 1 | 2 | 4 | 8
}

export type PrimitiveName =
  | 'bool'
  | 'cBool'
  | 'i8'
  | 'i16'
  | 'i32'
  | 'i64'
  | 'f32'
  | 'f64'
  | 'cLong'

/** The closed set of target identities supported by the bootstrap compiler. */
export type Id =
  | 'aarch64-apple-darwin'
  | 'x86_64-unknown-linux-gnu'
  | 'aarch64-unknown-linux-gnu'
  | 'wasm32-unknown-unknown'

/** Backend-neutral target facts owned by the compiler. */
export interface Target {
  readonly _tag: 'Target'
  readonly revision: 1
  readonly id: Id
  readonly kind: 'Native' | 'WebAssembly'
  readonly architecture: Architecture
  readonly operatingSystem: OperatingSystem
  readonly abi: Abi
  readonly objectFormat: ObjectFormat
  readonly pointerSize: 4 | 8
  readonly pointerAlignment: 4 | 8
  readonly endianness: 'little'
  readonly primitives: Readonly<Record<PrimitiveName, Primitive>>
  readonly stackAlignment: 16
  readonly dataAddressSpace: 0
  readonly toolchainClass: 'darwin' | 'gnu' | 'wasm'
  readonly defaultCpu: string
  readonly supportedCpus: ReadonlyArray<string>
  readonly supportedFeatures: ReadonlyArray<string>
}

/** Expected failure while resolving a target request. */
export class TargetError extends Data.TaggedError('TargetError')<{
  readonly operation:
    | 'Target.resolve'
    | 'Target.host'
    | 'Target.requireNative'
    | 'Target.validateArtifact'
    | 'Target.validateInventory'
    | 'Target.validateDescription'
  readonly requested: string
  readonly message: string
  readonly unavailableOperations?: ReadonlyArray<string>
}> {}

/** Queryable result of selecting a compilation target. */
export type Selection =
  | { readonly _tag: 'Resolved'; readonly target: Target }
  | { readonly _tag: 'Unavailable'; readonly error: TargetError }

const primitive = (size: Primitive['size']): Primitive => ({ size, alignment: size })

const make = (
  id: Id,
  architecture: Architecture,
  operatingSystem: OperatingSystem,
  abi: Abi,
  objectFormat: ObjectFormat,
  pointerSize: 4 | 8,
  defaultCpu: string,
  supportedFeatures: ReadonlyArray<string>,
): Target => ({
  _tag: 'Target',
  revision: 1,
  id,
  kind: objectFormat === 'wasm' ? 'WebAssembly' : 'Native',
  architecture,
  operatingSystem,
  abi,
  objectFormat,
  pointerSize,
  pointerAlignment: pointerSize,
  endianness: 'little',
  primitives: {
    bool: primitive(4),
    cBool: primitive(1),
    i8: primitive(1),
    i16: primitive(2),
    i32: primitive(4),
    i64: primitive(8),
    f32: primitive(4),
    f64: primitive(8),
    cLong: primitive(pointerSize),
  },
  stackAlignment: 16,
  dataAddressSpace: 0,
  toolchainClass: abi === 'apple' ? 'darwin' : abi,
  defaultCpu,
  supportedCpus: [defaultCpu],
  supportedFeatures: [...supportedFeatures].sort(),
})

const armFeatures = ['crc', 'crypto', 'fp-armv8', 'lse', 'neon']
export const aarch64AppleDarwin = make(
  'aarch64-apple-darwin',
  'aarch64',
  'darwin',
  'apple',
  'macho',
  8,
  'generic',
  armFeatures,
)
export const x8664UnknownLinuxGnu = make(
  'x86_64-unknown-linux-gnu',
  'x86_64',
  'linux',
  'gnu',
  'elf',
  8,
  'x86-64',
  ['aes', 'avx', 'avx2', 'sse2', 'sse4.2'],
)
export const aarch64UnknownLinuxGnu = make(
  'aarch64-unknown-linux-gnu',
  'aarch64',
  'linux',
  'gnu',
  'elf',
  8,
  'generic',
  armFeatures,
)
export const wasm32UnknownUnknown = make(
  'wasm32-unknown-unknown',
  'wasm32',
  'freestanding',
  'wasm',
  'wasm',
  4,
  'generic',
  ['atomics', 'bulk-memory', 'mutable-globals', 'sign-ext', 'simd128'],
)

/** Every canonical target in deterministic identity order. */
export const all: ReadonlyArray<Target> = [
  aarch64AppleDarwin,
  aarch64UnknownLinuxGnu,
  wasm32UnknownUnknown,
  x8664UnknownLinuxGnu,
]

/** The three targets required to host the stage-2 bootstrap compiler. */
export const native: ReadonlyArray<Target> = all.filter(isNative)

/** Whether a target can host the native bootstrap compiler. */
export function isNative(self: Target): boolean {
  return self.kind === 'Native'
}

const unavailable = (
  operation: TargetError['operation'],
  requested: string,
  subject: 'target' | 'host',
): Selection => ({
  _tag: 'Unavailable',
  error: new TargetError({
    operation,
    requested,
    message: `Unsupported bootstrap ${subject} ${requested}`,
  }),
})

/** Selects an explicit target or the supplied host as immutable queryable data. */
export const select = (
  requested: string | undefined,
  hostPlatform?: string,
  hostArch?: string,
): Selection => {
  if (requested !== undefined) {
    const found = all.find((candidate) => candidate.id === requested)
    return found === undefined
      ? unavailable('Target.resolve', requested, 'target')
      : { _tag: 'Resolved', target: found }
  }
  if (hostPlatform === undefined || hostArch === undefined) {
    return unavailable('Target.host', 'unspecified-host', 'host')
  }
  let hostId: string
  if (hostPlatform === 'darwin' && hostArch === 'arm64') hostId = aarch64AppleDarwin.id
  else if (hostPlatform === 'linux' && hostArch === 'x64') hostId = x8664UnknownLinuxGnu.id
  else if (hostPlatform === 'linux' && hostArch === 'arm64') hostId = aarch64UnknownLinuxGnu.id
  else hostId = `${hostArch}-${hostPlatform}`
  const found = native.find((candidate) => candidate.id === hostId)
  return found === undefined
    ? unavailable('Target.host', hostId, 'host')
    : { _tag: 'Resolved', target: found }
}

/** Looks up a canonical target without introducing a fallback. */
export const resolve = Effect.fn('Target.resolve')(function* (
  requested: string,
): Effect.fn.Return<Target, TargetError> {
  const selected = select(requested)
  if (selected._tag === 'Resolved') return selected.target
  return yield* selected.error
})

/** Resolves host facts supplied by the application edge. */
export const fromHost = Effect.fn('Target.fromHost')(function* (
  hostPlatform: string,
  hostArch: string,
): Effect.fn.Return<Target, TargetError> {
  const selected = select(undefined, hostPlatform, hostArch)
  if (selected._tag === 'Resolved') return selected.target
  return yield* selected.error
})

/** Requires a compiler target that can proceed through native object emission and linking. */
export const requireNative = Effect.fn('Target.requireNative')(function* (
  self: Target,
): Effect.fn.Return<Target, TargetError> {
  if (isNative(self)) return self
  return yield* new TargetError({
    operation: 'Target.requireNative',
    requested: self.id,
    message: `Native compilation does not support target ${self.id}`,
  })
})

/** Reports a valid program whose reachable inventory has no implementation on one target. */
export const unavailableInventory = (
  self: Target,
  operations: ReadonlyArray<string>,
): TargetError =>
  new TargetError({
    operation: 'Target.validateInventory',
    requested: self.id,
    message: `Target ${self.id} does not support ${operations.join(', ')}`,
    unavailableOperations: [...operations],
  })

/** Reports an artifact kind that cannot be produced for the selected target family. */
export const unavailableArtifact = (self: Target, artifactKind: string): TargetError =>
  new TargetError({
    operation: 'Target.validateArtifact',
    requested: self.id,
    message: `Target ${self.id} cannot produce ${artifactKind}`,
  })

/** Whether a target value exactly matches its compiler-owned canonical profile. */
export const isCanonical = (self: Target): boolean =>
  all.some((candidate) => matchesDescription(self, candidate))

const isRecord = (input: unknown): input is Record<string, unknown> =>
  typeof input === 'object' && input !== null && !Array.isArray(input)

const matchesDescription = (input: unknown, expected: unknown): boolean => {
  if (input === expected) return true
  if (Array.isArray(expected))
    return (
      Array.isArray(input) &&
      input.length === expected.length &&
      expected.every((value, index) => matchesDescription(input[index], value))
    )
  if (!isRecord(expected)) return false
  return (
    isRecord(input) &&
    Object.keys(input).length === Object.keys(expected).length &&
    Object.keys(expected).every(
      (key) => Object.hasOwn(input, key) && matchesDescription(input[key], expected[key]),
    )
  )
}

/** Rejects missing or inconsistent externally supplied machine facts before any fact is used. */
export const validateDescription = Effect.fn('Target.validateDescription')(function* (
  input: unknown,
): Effect.fn.Return<Target, TargetError> {
  const found = all.find((candidate) => matchesDescription(input, candidate))
  if (found !== undefined) return found
  return yield* new TargetError({
    operation: 'Target.validateDescription',
    requested: 'target description',
    message: 'Target description is incomplete or inconsistent with the audited revision',
  })
})

/** Deterministic textual encoding of compiler-owned target facts. */
export const encode = (self: Target): string =>
  Canonical.record('TargetDescription', [
    String(self.revision),
    self.id,
    self.kind,
    self.architecture,
    self.operatingSystem,
    self.abi,
    self.objectFormat,
    String(self.pointerSize),
    String(self.pointerAlignment),
    self.endianness,
    String(self.stackAlignment),
    String(self.dataAddressSpace),
    self.toolchainClass,
    self.defaultCpu,
    Canonical.array(self.supportedCpus),
    Canonical.array(self.supportedFeatures),
    Canonical.array(
      Object.entries(self.primitives)
        .sort(([a], [b]) => Canonical.compare(a, b))
        .map(([name, fact]) => Canonical.record(name, [String(fact.size), String(fact.alignment)])),
    ),
  ])
