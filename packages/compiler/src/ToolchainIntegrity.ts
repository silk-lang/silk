import type * as Instances from './Instances.js'
import * as Intrinsic from './Intrinsic.js'
import * as Stdlib from './Stdlib.js'
import type * as Target from './Target.js'
import { compilerDigest } from './ToolchainIntegrity.generated.js'

/** The stable schema of a matched bootstrap toolchain identity graph. */
export const schema = 'silk-toolchain-v1' as const

export type ComponentKind =
  | 'Compiler'
  | 'Catalog'
  | 'Source'
  | 'IntrinsicInventory'
  | 'RuntimeSupport'

/** One content-addressed component and the identities it was generated against. */
export interface Component {
  readonly kind: ComponentKind
  readonly id: string
  readonly digest: string
  readonly dependencies: ReadonlyArray<string>
}

/** The immutable matched-set metadata shipped by one compiler distribution. */
export interface Graph {
  readonly _tag: 'ToolchainIdentityGraph'
  readonly schema: typeof schema
  readonly digest: string
  readonly components: ReadonlyArray<Component>
}

export interface IntegrityFailure {
  readonly _tag: 'ToolchainIntegrityFailure'
  readonly boundary: 'Frontend' | 'Target'
  readonly reason:
    | { readonly _tag: 'MalformedGraph'; readonly detail: string }
    | { readonly _tag: 'MissingComponent'; readonly kind: ComponentKind; readonly id: string }
    | { readonly _tag: 'UnexpectedComponent'; readonly kind: ComponentKind; readonly id: string }
    | {
        readonly _tag: 'DependencyMismatch'
        readonly kind: ComponentKind
        readonly id: string
        readonly expected: ReadonlyArray<string>
        readonly observed: ReadonlyArray<string>
      }
    | {
        readonly _tag: 'DigestMismatch'
        readonly kind: ComponentKind
        readonly id: string
        readonly expected: string
        readonly observed: string
      }
}

export type Validation =
  | { readonly _tag: 'Matched'; readonly graph: Graph }
  | { readonly _tag: 'Invalid'; readonly failures: ReadonlyArray<IntegrityFailure> }

export type TargetValidation =
  | {
      readonly _tag: 'Matched'
      readonly runtimeSupport: ReadonlyArray<Component>
    }
  | {
      readonly _tag: 'UnsupportedTarget'
      readonly target: Target.Id
      readonly operations: ReadonlyArray<string>
    }
  | { readonly _tag: 'Invalid'; readonly failures: ReadonlyArray<IntegrityFailure> }

const sha256Constants = Int32Array.from([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

/** Computes the path- and timestamp-independent SHA-256 identity of exact bytes. */
const contentDigestCache = new WeakMap<Uint8Array, string>()

export const contentDigest = (value: Uint8Array | string): string => {
  if (typeof value !== 'string') {
    let cached = contentDigestCache.get(value)
    if (cached === undefined) {
      cached = computeContentDigest(value)
      contentDigestCache.set(value, cached)
    }
    return cached
  }
  return computeContentDigest(value)
}

const sha256Words = new Int32Array(64)
const sha256State = new Int32Array(8)

// Typed module state and a closure-free block function: persisted semantic records hash
// hundreds of megabytes per compile.
const sha256Compress = (bytes: Uint8Array, offset: number): void => {
  const words = sha256Words
  const constants = sha256Constants
  const state = sha256State
  for (let index = 0; index < 16; index += 1) {
    const at = offset + index * 4
    words[index] =
      (bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!
  }
  for (let index = 16; index < 64; index += 1) {
    const p15 = words[index - 15]!
    const p2 = words[index - 2]!
    const sigma0 = ((p15 >>> 7) | (p15 << 25)) ^ ((p15 >>> 18) | (p15 << 14)) ^ (p15 >>> 3)
    const sigma1 = ((p2 >>> 17) | (p2 << 15)) ^ ((p2 >>> 19) | (p2 << 13)) ^ (p2 >>> 10)
    words[index] = (words[index - 16]! + sigma0 + words[index - 7]! + sigma1) | 0
  }
  let a = state[0]!
  let b = state[1]!
  let c = state[2]!
  let d = state[3]!
  let e = state[4]!
  let f = state[5]!
  let g = state[6]!
  let h = state[7]!
  for (let index = 0; index < 64; index += 1) {
    const upper1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))
    const temporary1 = (h + upper1 + ((e & f) ^ (~e & g)) + constants[index]! + words[index]!) | 0
    const upper0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))
    const temporary2 = (upper0 + ((a & b) ^ (a & c) ^ (b & c))) | 0
    h = g
    g = f
    f = e
    e = (d + temporary1) | 0
    d = c
    c = b
    b = a
    a = (temporary1 + temporary2) | 0
  }
  state[0] = state[0]! + a
  state[1] = state[1]! + b
  state[2] = state[2]! + c
  state[3] = state[3]! + d
  state[4] = state[4]! + e
  state[5] = state[5]! + f
  state[6] = state[6]! + g
  state[7] = state[7]! + h
}

const computeContentDigest = (value: Uint8Array | string): string => {
  const source = typeof value === 'string' ? new TextEncoder().encode(value) : value
  sha256State.set([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ])
  const whole = source.length - (source.length % 64)
  for (let offset = 0; offset < whole; offset += 64) sha256Compress(source, offset)
  const remaining = source.length - whole
  const tail = new Uint8Array(remaining + 9 > 64 ? 128 : 64)
  tail.set(source.subarray(whole))
  tail[remaining] = 0x80
  const view = new DataView(tail.buffer)
  view.setUint32(tail.length - 8, Math.floor(source.length / 0x20000000))
  view.setUint32(tail.length - 4, (source.length << 3) >>> 0)
  for (let offset = 0; offset < tail.length; offset += 64) sha256Compress(tail, offset)
  return Array.from(sha256State, (word) => (word >>> 0).toString(16).padStart(8, '0')).join('')
}

const field = (value: string): string => `${new TextEncoder().encode(value).length}:${value}`

const encodeComponent = (self: Component): string =>
  [self.kind, self.id, self.digest, ...self.dependencies].map(field).join('')

const compareComponent = (left: Component, right: Component): number =>
  left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id)

const graphDigest = (components: ReadonlyArray<Component>): string =>
  contentDigest([schema, ...components.map(encodeComponent)].map(field).join(''))

/** Builds a normalized graph, primarily for distribution generation and embedding tests. */
export const make = (components: Iterable<Component>): Graph => {
  const normalized = [...components]
    .map((component) => ({
      ...component,
      dependencies: [...component.dependencies].sort(),
    }))
    .sort(compareComponent)
  return {
    _tag: 'ToolchainIdentityGraph',
    schema,
    digest: graphDigest(normalized),
    components: normalized,
  }
}

const catalogDigest = (): string =>
  contentDigest(
    Stdlib.manifest
      .map((entry) =>
        [
          entry.module,
          entry.digest,
          ...entry.staticInventory,
          ...entry.runtimeInventory,
          entry.namespace ?? '',
          ...(entry.aliases ?? []),
        ]
          .map(field)
          .join(''),
      )
      .join('') +
      field(JSON.stringify(Stdlib.compositions)) +
      field(Stdlib.sealedModule.module) +
      field(Stdlib.sealedModule.digest),
  )

const inventoryDigest = (): string => contentDigest(JSON.stringify(Intrinsic.inventory()))

const sourceId = (module: string): string => `source/${module}`
const runtimeId = (target: Target.Id, operation: string): string => `runtime/${target}/${operation}`

const installedComponents = (): ReadonlyArray<Component> => {
  const compiler: Component = {
    kind: 'Compiler',
    id: '@silklang/compiler',
    digest: compilerDigest,
    dependencies: [],
  }
  const catalog: Component = {
    kind: 'Catalog',
    id: 'silk/stdlib/catalog',
    digest: catalogDigest(),
    dependencies: [compiler.id],
  }
  const intrinsic: Component = {
    kind: 'IntrinsicInventory',
    id: 'silk/intrinsic/inventory',
    digest: inventoryDigest(),
    dependencies: [compiler.id],
  }
  const sources = Stdlib.manifest.map<Component>((entry) => ({
    kind: 'Source',
    id: sourceId(entry.module),
    digest: entry.digest,
    dependencies: [catalog.id],
  }))
  const runtime = Intrinsic.inventory().flatMap<Component>((entry) =>
    entry.phase === 'StaticOnly' || entry.targets.length === 0
      ? []
      : entry.targets.map((target) => ({
          kind: 'RuntimeSupport',
          id: runtimeId(target, entry.operation),
          digest: contentDigest(
            JSON.stringify({
              compiler: compilerDigest,
              target,
              operation: entry.operation,
              tir: entry.tir,
              mir: entry.mir,
            }),
          ),
          dependencies: [compiler.id, intrinsic.id],
        })),
  )
  return [compiler, catalog, intrinsic, ...sources, ...runtime]
}

const installedGraph = make(installedComponents())

/** Returns the identity graph embedded in this compiler build. */
export const installed = (): Graph => installedGraph

const failure = (
  boundary: IntegrityFailure['boundary'],
  reason: IntegrityFailure['reason'],
): IntegrityFailure => ({ _tag: 'ToolchainIntegrityFailure', boundary, reason })

const componentKey = (component: Pick<Component, 'kind' | 'id'>): string =>
  `${component.kind}:${component.id}`

const validateShape = (
  candidate: Graph,
  boundary: IntegrityFailure['boundary'],
): IntegrityFailure[] => {
  const failures: IntegrityFailure[] = []
  if (candidate._tag !== 'ToolchainIdentityGraph' || candidate.schema !== schema)
    failures.push(failure(boundary, { _tag: 'MalformedGraph', detail: 'unsupported graph schema' }))
  const keys = candidate.components.map(componentKey)
  if (new Set(keys).size !== keys.length)
    failures.push(
      failure(boundary, { _tag: 'MalformedGraph', detail: 'duplicate component identity' }),
    )
  const normalized = [...candidate.components].sort(compareComponent)
  if (normalized.some((component, index) => componentKey(component) !== keys[index]))
    failures.push(
      failure(boundary, { _tag: 'MalformedGraph', detail: 'components are not normalized' }),
    )
  const identities = new Set(candidate.components.map((component) => component.id))
  for (const component of candidate.components) {
    const dependencies = [...component.dependencies].sort()
    if (dependencies.some((dependency, index) => dependency !== component.dependencies[index]))
      failures.push(
        failure(boundary, {
          _tag: 'MalformedGraph',
          detail: `${component.id} dependencies are not normalized`,
        }),
      )
    for (const dependency of component.dependencies)
      if (!identities.has(dependency))
        failures.push(
          failure(boundary, {
            _tag: 'MalformedGraph',
            detail: `${component.id} references missing dependency ${dependency}`,
          }),
        )
  }
  const observedDigest = graphDigest(candidate.components)
  if (observedDigest !== candidate.digest)
    failures.push(
      failure(boundary, {
        _tag: 'DigestMismatch',
        kind: 'Compiler',
        id: 'toolchain-identity-graph',
        expected: observedDigest,
        observed: candidate.digest,
      }),
    )
  return failures
}

const compareSelection = (
  candidate: Graph,
  kinds: ReadonlySet<ComponentKind>,
  boundary: IntegrityFailure['boundary'],
): IntegrityFailure[] => {
  const expected = new Map(
    installedGraph.components
      .filter((component) => kinds.has(component.kind))
      .map((component) => [componentKey(component), component] as const),
  )
  const observed = new Map(
    candidate.components
      .filter((component) => kinds.has(component.kind))
      .map((component) => [componentKey(component), component] as const),
  )
  const failures: IntegrityFailure[] = []
  for (const [key, component] of expected) {
    const found = observed.get(key)
    if (found === undefined) {
      failures.push(
        failure(boundary, { _tag: 'MissingComponent', kind: component.kind, id: component.id }),
      )
    } else if (found.digest !== component.digest) {
      failures.push(
        failure(boundary, {
          _tag: 'DigestMismatch',
          kind: component.kind,
          id: component.id,
          expected: component.digest,
          observed: found.digest,
        }),
      )
    } else if (JSON.stringify(found.dependencies) !== JSON.stringify(component.dependencies))
      failures.push(
        failure(boundary, {
          _tag: 'DependencyMismatch',
          kind: component.kind,
          id: component.id,
          expected: component.dependencies,
          observed: found.dependencies,
        }),
      )
  }
  for (const [key, component] of observed)
    if (!expected.has(key))
      failures.push(
        failure(boundary, { _tag: 'UnexpectedComponent', kind: component.kind, id: component.id }),
      )
  return failures
}

/** Validates the compiler/catalog/source/intrinsic set before user source resolution begins. */
export const validateFrontend = (candidate: Graph): Validation => {
  const failures = [
    ...validateShape(candidate, 'Frontend'),
    ...compareSelection(
      candidate,
      new Set<ComponentKind>(['Compiler', 'Catalog', 'Source', 'IntrinsicInventory']),
      'Frontend',
    ),
  ]
  return failures.length === 0
    ? { _tag: 'Matched', graph: candidate }
    : { _tag: 'Invalid', failures: failures }
}

/** Validates runtime implementations reached by one prepared program. */
export const validateTarget = (
  candidate: Graph,
  target: Target.Target,
  calls: ReadonlyArray<Instances.IntrinsicCall>,
): TargetValidation => {
  const unsupported = [
    ...new Set(
      calls.flatMap((call) => {
        const operation = Intrinsic.findOperationById(call.operation)
        return operation === undefined ||
          (operation.phase !== 'StaticOnly' && operation.targets.includes(target.id))
          ? []
          : [Intrinsic.operationText(call.operation)]
      }),
    ),
  ].sort()
  if (unsupported.length > 0)
    return {
      _tag: 'UnsupportedTarget',
      target: target.id,
      operations: [...new Set(unsupported)].sort(),
    }

  const selectedIds = new Set(
    calls.map((call) => runtimeId(target.id, Intrinsic.operationText(call.operation))),
  )
  const expected = new Map(
    installedGraph.components
      .filter((component) => component.kind === 'RuntimeSupport' && selectedIds.has(component.id))
      .map((component) => [componentKey(component), component] as const),
  )
  const observed = new Map(
    candidate.components
      .filter((component) => component.kind === 'RuntimeSupport' && selectedIds.has(component.id))
      .map((component) => [componentKey(component), component] as const),
  )
  const failures: IntegrityFailure[] = [...validateShape(candidate, 'Target')]
  for (const [key, component] of expected) {
    const found = observed.get(key)
    if (found === undefined)
      failures.push(
        failure('Target', { _tag: 'MissingComponent', kind: component.kind, id: component.id }),
      )
    else if (found.digest !== component.digest)
      failures.push(
        failure('Target', {
          _tag: 'DigestMismatch',
          kind: component.kind,
          id: component.id,
          expected: component.digest,
          observed: found.digest,
        }),
      )
    else if (JSON.stringify(found.dependencies) !== JSON.stringify(component.dependencies))
      failures.push(
        failure('Target', {
          _tag: 'DependencyMismatch',
          kind: component.kind,
          id: component.id,
          expected: component.dependencies,
          observed: found.dependencies,
        }),
      )
  }
  if (failures.length > 0) return { _tag: 'Invalid', failures: failures }
  return {
    _tag: 'Matched',
    runtimeSupport: [...expected.values()].filter((entry) => entry.kind === 'RuntimeSupport'),
  }
}

/** Stable human-readable detail for CLI and embedding diagnostics. */
export const formatFailure = (self: IntegrityFailure): string => {
  switch (self.reason._tag) {
    case 'MalformedGraph':
      return `malformed identity graph: ${self.reason.detail}`
    case 'MissingComponent':
      return `missing ${self.reason.kind} ${self.reason.id}`
    case 'UnexpectedComponent':
      return `unexpected ${self.reason.kind} ${self.reason.id}`
    case 'DependencyMismatch':
      return `${self.reason.kind} ${self.reason.id} dependency mismatch: expected ${self.reason.expected.join(', ')}, observed ${self.reason.observed.join(', ')}`
    case 'DigestMismatch':
      return `${self.reason.kind} ${self.reason.id} digest mismatch: expected ${self.reason.expected}, observed ${self.reason.observed}`
  }
}
