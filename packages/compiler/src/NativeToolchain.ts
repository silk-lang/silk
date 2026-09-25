import * as HelperCapability from './HelperCapability.js'
import * as HelperSource from './HelperSource.js'
import * as ToolchainIntegrity from './ToolchainIntegrity.js'
import * as ObjectSymbols from './internal/ObjectSymbols.js'
import * as Config from 'effect/Config'
import * as Schema from 'effect/Schema'
import { NodeServices } from '@effect/platform-node'
import type * as ArtifactPlan from './ArtifactPlan.js'
import * as CompilationProfile from './CompilationProfile.js'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { arch, platform, tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import * as Data from 'effect/Data'
import * as FileSystem from 'effect/FileSystem'
import type * as PathService from 'effect/Path'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Context from 'effect/Context'
import * as Option from 'effect/Option'
import * as Result from 'effect/Result'
import * as ArtifactKind from './ArtifactKind.js'
import type * as Backend from './Backend.js'
import * as LlvmWasmRuntime from './LlvmWasmRuntime.js'
import * as NativeLinkInput from './NativeLinkInput.js'
import * as Project from './Project.js'
import * as Target from './Target.js'
import * as ToolchainPlan from './ToolchainPlan.js'
import * as PlatformSupply from './PlatformSupply.js'
import * as PlatformSupplyResolver from './PlatformSupplyResolver.js'
import * as NativeLinkResolver from './NativeLinkResolver.js'
import type * as NativeLinkPlan from './NativeLinkPlan.js'
import * as CTranslationUnitResolver from './CTranslationUnitResolver.js'
import type * as CTranslationUnit from './CTranslationUnit.js'
import * as Storage from './Storage.js'

export interface Toolchain {
  readonly _tag: 'Toolchain'
  readonly clang: string
  readonly llvmAr: string
  readonly platform?: PlatformSupply.Request
  readonly artifactSupply?: PlatformSupply.Pin
  readonly projectSupply?: PlatformSupply.Pin
  readonly supply?: PlatformSupply.PlatformSupply
  readonly runtimeObjectCache?: RuntimeObjectCache
}

/**
 * Byte storage for backend and final native artifacts. The driver resolves it from its environment
 * and falls back to {@link defaultArtifactStorage}; it is a tag of its own so artifact and semantic
 * records can live in different stores.
 */
export class ArtifactStorage extends Context.Service<ArtifactStorage, Storage.Service>()(
  '@silklang/compiler/NativeToolchain/ArtifactStorage',
) {}

export interface RuntimeObjectCache {
  readonly _tag: 'RuntimeObjectCache'
  readonly storage: Storage.Service
}

export interface RuntimeObjectCacheStats {
  readonly entries: number
  readonly hits: number
  readonly misses: number
}

interface RuntimeObjectCacheState {
  readonly entries: Set<string>
  hits: number
  misses: number
}

const runtimeObjectCacheStates = new WeakMap<RuntimeObjectCache, RuntimeObjectCacheState>()

const runtimeObjectCacheState = (self: RuntimeObjectCache): RuntimeObjectCacheState => {
  const state = runtimeObjectCacheStates.get(self)
  if (state === undefined) throw new RangeError('Unknown runtime object cache')
  return state
}

export const makeRuntimeObjectCache = (
  storage: Storage.Service = Storage.memoryService(),
): RuntimeObjectCache => {
  const cache = { _tag: 'RuntimeObjectCache' as const, storage }
  runtimeObjectCacheStates.set(cache, { entries: new Set(), hits: 0, misses: 0 })
  return cache
}

export const runtimeObjectCacheStats = (self: RuntimeObjectCache): RuntimeObjectCacheStats => {
  const state = runtimeObjectCacheState(self)
  return { entries: state.entries.size, hits: state.hits, misses: state.misses }
}

/** Returns the exact runtime source participating in one final artifact and its cache identity. */
export const artifactRuntimeSource = (
  kind: FinalArtifact['kind'],
  nativeRuntimeSymbols: ReadonlyArray<string>,
): string => {
  if (kind === 'WebAssemblyModule') return LlvmWasmRuntime.source
  if (nativeRuntimeSymbols.length > 0) return ToolchainPlan.runtimeSource()
  return ''
}

export type Stage =
  | 'supply'
  | 'host-target'
  | 'cache-key'
  | 'cache-read'
  | 'cache-write'
  | 'scope-acquire'
  | 'scope-cleanup'
  | 'scope-write'
  | 'object'
  | 'runtime'
  | 'link'
  | 'wasm-finalize'
  | 'artifact-commit'
  | 'artifact-cleanup'

export type ToolchainErrorReason =
  | { readonly _tag: 'HelperFailed'; readonly failure: HelperCapability.HelperError }
  | { readonly _tag: 'SupplyFailed'; readonly failure: PlatformSupply.SupplyError }
  | {
      readonly _tag: 'SpawnFailed'
      readonly planned: ToolchainPlan.PlannedCommand
      readonly status: number | null
      readonly output: string
      readonly cause?: unknown
    }
  | {
      readonly _tag: 'StorageFailed'
      readonly path: string
      readonly cause: unknown
    }
  | {
      readonly _tag: 'LinkFailed'
      readonly inputs?: ReadonlyArray<PlatformSupply.File>
      readonly planned: ToolchainPlan.PlannedCommand
      readonly status: number | null
      readonly output: string
      readonly cause?: unknown
    }
  | {
      readonly _tag: 'UnsupportedPlan'
      readonly plan: ToolchainPlan.UnsupportedNativePlan
    }
  | { readonly _tag: 'InvalidPackageName'; readonly name: string }

/** An expected failure at the Node toolchain boundary. */
export class ToolchainError extends Data.TaggedError('ToolchainError')<{
  readonly operation: string
  readonly stage: Stage
  readonly message: string
  readonly reason: ToolchainErrorReason
}> {}

const supplyError = (failure: PlatformSupply.SupplyError): ToolchainError =>
  new ToolchainError({
    operation: failure.operation,
    stage: 'supply',
    message: failure.message,
    reason: { _tag: 'SupplyFailed', failure },
  })

const helperError = (failure: HelperCapability.HelperError): ToolchainError =>
  new ToolchainError({
    operation: failure.operation,
    stage: 'object',
    message: `${failure.code}: ${failure.subject} (${failure.origins.join(' -> ')})`,
    reason: { _tag: 'HelperFailed', failure },
  })

/** Resolves a physical provider once for a native build; all subsequent consumers share it. */
export const resolveToolchain = Effect.fn('NativeToolchain.resolveToolchain')(function* (
  toolchain: Toolchain,
  profile: CompilationProfile.Facts,
): Effect.fn.Return<Toolchain, ToolchainError> {
  if (toolchain.supply !== undefined) {
    if (toolchain.supply.target.id !== profile.target.id || toolchain.supply.libc !== profile.libc)
      return yield* supplyError(
        PlatformSupply.failure(
          'TargetMismatch',
          profile.target.id,
          'resolved toolchain',
          'Resolve a supply for this profile.',
        ),
      )
    const deployment =
      profile.deployment ??
      (profile.target.operatingSystem === 'darwin' && profile.libc !== 'none'
        ? '11.0.0'
        : undefined)
    if (toolchain.supply.deployment !== deployment)
      return yield* supplyError(
        PlatformSupply.failure(
          'DeploymentMismatch',
          deployment ?? 'unspecified',
          'resolved toolchain',
          'Resolve a supply for this deployment profile.',
        ),
      )
    yield* PlatformSupplyResolver.validateFiles([
      toolchain.supply.compiler,
      toolchain.supply.linker,
      toolchain.supply.archiver,
      ...toolchain.supply.files,
    ]).pipe(Effect.mapError(supplyError), Effect.provide(NodeServices.layer))
    return toolchain
  }
  const host = hostSelection()
  const supply = yield* PlatformSupplyResolver.resolveSupply(
    PlatformSupplyResolver.make(process.env),
    {
      profile,
      host: host._tag === 'Resolved' ? host.target.id : undefined,
      clang: toolchain.clang,
      llvmAr: toolchain.llvmAr,
      ...(toolchain.platform === undefined ? {} : { request: toolchain.platform }),
      ...(toolchain.artifactSupply === undefined ? {} : { artifact: toolchain.artifactSupply }),
      ...(toolchain.projectSupply === undefined ? {} : { project: toolchain.projectSupply }),
    },
  ).pipe(Effect.mapError(supplyError), Effect.provide(NodeServices.layer))
  return {
    ...toolchain,
    clang: supply.compiler.command,
    llvmAr: supply.archiver.command,
    supply,
  }
})

const storageError = (
  operation: string,
  stage: Stage,
  path: string,
  cause: unknown,
): ToolchainError =>
  new ToolchainError({
    operation,
    stage,
    message: `${operation} failed for ${path}`,
    reason: { _tag: 'StorageFailed', path, cause },
  })

const processError = (
  operation: string,
  stage: 'object' | 'runtime' | 'wasm-finalize',
  planned: ToolchainPlan.PlannedCommand,
  status: number | null,
  output: string,
  cause?: unknown,
): ToolchainError =>
  new ToolchainError({
    operation,
    stage,
    message: `${operation} failed: ${output || `process exited with status ${String(status)}`}`,
    reason: {
      _tag: 'SpawnFailed',
      planned,
      status,
      output,
      ...(cause === undefined ? {} : { cause }),
    },
  })

const linkError = (
  planned: ToolchainPlan.PlannedCommand,
  status: number | null,
  output: string,
  cause?: unknown,
  inputs?: ReadonlyArray<PlatformSupply.File>,
): ToolchainError =>
  new ToolchainError({
    operation: 'Linker.link',
    stage: 'link',
    message: `Linker.link failed: ${output}`,
    reason: {
      _tag: 'LinkFailed',
      ...(inputs === undefined ? {} : { inputs }),
      planned,
      status,
      output,
      ...(cause === undefined ? {} : { cause }),
    },
  })

const unsupportedPlanError = (plan: ToolchainPlan.UnsupportedNativePlan): ToolchainError =>
  new ToolchainError({
    operation: 'Linker.link',
    stage: 'link',
    message: `Linker.link cannot preserve ${plan.reason} for ${plan.artifactKind} on ${plan.target.id}`,
    reason: { _tag: 'UnsupportedPlan', plan },
  })

const invalidPackageNameError = (name: string): ToolchainError =>
  new ToolchainError({
    operation: 'NativeToolchain.commitLibraryInterface',
    stage: 'artifact-commit',
    message: `NativeToolchain.commitLibraryInterface requires a portable package name, received ${name}`,
    reason: { _tag: 'InvalidPackageName', name },
  })

const artifactCacheMagic = Uint8Array.from([0x53, 0x49, 0x4c, 0x4b, 0x43, 0x30, 0x30, 0x31])
const artifactCacheDigestLength = 32
const artifactCacheHeaderLength = artifactCacheMagic.length + 4 + artifactCacheDigestLength
const artifactStorageNamespace = 'native-artifacts'
const maximumNativeCacheRecordBytes = Number.MAX_SAFE_INTEGER

const artifactCacheDigest = (key: string, bytes: Uint8Array): Uint8Array =>
  createHash('sha256').update(key).update('\0').update(bytes).digest()

const encodeArtifactCacheEntry = (key: string, bytes: Uint8Array): Uint8Array => {
  if (bytes.length > 0xffff_ffff) throw new RangeError('artifact cache entry exceeds 4 GiB')
  const encoded = new Uint8Array(artifactCacheHeaderLength + bytes.length)
  encoded.set(artifactCacheMagic)
  const lengthOffset = artifactCacheMagic.length
  encoded[lengthOffset] = bytes.length & 0xff
  encoded[lengthOffset + 1] = (bytes.length >>> 8) & 0xff
  encoded[lengthOffset + 2] = (bytes.length >>> 16) & 0xff
  encoded[lengthOffset + 3] = (bytes.length >>> 24) & 0xff
  encoded.set(artifactCacheDigest(key, bytes), lengthOffset + 4)
  encoded.set(bytes, artifactCacheHeaderLength)
  return encoded
}

const decodeArtifactCacheEntry = (key: string, encoded: Uint8Array): Uint8Array | undefined => {
  if (encoded.length < artifactCacheHeaderLength) return undefined
  if (!artifactCacheMagic.every((byte, index) => encoded[index] === byte)) return undefined
  const lengthOffset = artifactCacheMagic.length
  const payloadLength =
    (encoded[lengthOffset] ?? 0) +
    (encoded[lengthOffset + 1] ?? 0) * 0x100 +
    (encoded[lengthOffset + 2] ?? 0) * 0x1_0000 +
    (encoded[lengthOffset + 3] ?? 0) * 0x100_0000
  if (artifactCacheHeaderLength + payloadLength !== encoded.length) return undefined
  const payload = encoded.subarray(artifactCacheHeaderLength)
  const expectedDigest = encoded.subarray(
    lengthOffset + 4,
    lengthOffset + 4 + artifactCacheDigestLength,
  )
  const actualDigest = artifactCacheDigest(key, payload)
  if (!actualDigest.every((byte, index) => expectedDigest[index] === byte)) return undefined
  return Uint8Array.from(payload)
}

/** Reads and admits one native artifact envelope from opaque Storage. */
export const readArtifactCache = Effect.fnUntraced(function* (
  storage: Storage.Service,
  key: string,
): Effect.fn.Return<Uint8Array | undefined, ToolchainError> {
  const found = yield* Storage.read(
    artifactStorageNamespace,
    key,
    maximumNativeCacheRecordBytes,
  ).pipe(
    Effect.provideService(Storage.Storage, storage),
    Effect.mapError((cause) =>
      storageError('NativeToolchain.ArtifactCache.get', 'cache-read', key, cause),
    ),
  )
  if (Option.isNone(found)) return undefined
  return yield* Effect.try({
    try: () => decodeArtifactCacheEntry(key, found.value),
    catch: (cause) => storageError('NativeToolchain.ArtifactCache.get', 'cache-read', key, cause),
  })
})

/** Encodes and atomically publishes one native artifact envelope through Storage. */
export const writeArtifactCache = Effect.fnUntraced(function* (
  storage: Storage.Service,
  key: string,
  bytes: Uint8Array,
): Effect.fn.Return<void, ToolchainError> {
  const encoded = yield* Effect.try({
    try: () => encodeArtifactCacheEntry(key, bytes),
    catch: (cause) => storageError('NativeToolchain.ArtifactCache.set', 'cache-write', key, cause),
  })
  return yield* Storage.publish(
    artifactStorageNamespace,
    key,
    encoded,
    maximumNativeCacheRecordBytes,
  ).pipe(
    Effect.provideService(Storage.Storage, storage),
    Effect.mapError((cause) =>
      storageError('NativeToolchain.ArtifactCache.set', 'cache-write', key, cause),
    ),
  )
})

let atomicNonce = 0

export interface CleanupOperation {
  readonly remove: (
    path: string,
    options: { readonly force: true; readonly recursive?: boolean },
  ) => void
}

class CleanupAttemptError extends Data.TaggedError('CleanupAttemptError')<{
  readonly cause: unknown
}> {}

const nodeCleanup: CleanupOperation = {
  remove: (path: string, options: { readonly force: true; readonly recursive?: boolean }) =>
    rmSync(path, options),
}

/** Removes one scoped path, retrying once while retaining both arbitrary failure causes. */
const cleanupPath = Effect.fnUntraced(function* (
  path: string,
  options: { readonly force: true; readonly recursive?: boolean },
  cleanup: CleanupOperation,
  stage: 'scope-cleanup' | 'artifact-cleanup',
): Effect.fn.Return<void, ToolchainError> {
  const first = yield* Effect.result(
    Effect.try({
      try: () => cleanup.remove(path, options),
      catch: (cause) => new CleanupAttemptError({ cause }),
    }),
  )
  if (Result.isSuccess(first)) return
  const retry = yield* Effect.result(
    Effect.try({
      try: () => cleanup.remove(path, options),
      catch: (cause) => new CleanupAttemptError({ cause }),
    }),
  )
  if (Result.isSuccess(retry)) return
  const fallback = yield* Effect.result(
    Effect.try({
      try: () => nodeCleanup.remove(path, options),
      catch: (cause) => new CleanupAttemptError({ cause }),
    }),
  )
  return yield* storageError('NativeToolchain.cleanupPath', stage, path, {
    first: first.failure.cause,
    retry: retry.failure.cause,
    ...(Result.isFailure(fallback) ? { fallback: fallback.failure.cause } : {}),
  })
})

const releaseCleanup = <A, E>(
  exit: Exit.Exit<A, E>,
  cleanup: Effect.Effect<void, ToolchainError>,
): Effect.Effect<void, ToolchainError> =>
  Exit.isSuccess(exit)
    ? cleanup
    : cleanup.pipe(
        Effect.catch((error) =>
          Effect.logError(error).pipe(
            Effect.annotateLogs('cleanupOperation', error.operation),
            Effect.annotateLogs('cleanupStage', error.stage),
          ),
        ),
      )

/** Atomically writes bytes through a unique same-directory temporary sibling. */
export const atomicCommit = Effect.fn('NativeToolchain.atomicCommit')(function* (
  destination: string,
  bytes: Uint8Array,
  options: {
    readonly mode?: number
    readonly stage?: Stage
    readonly cleanup?: CleanupOperation
  } = {},
): Effect.fn.Return<string, ToolchainError> {
  const path = resolve(destination)
  const temporary = `${path}.silk-tmp-${process.pid}-${atomicNonce++}`
  const stage = options.stage ?? 'artifact-commit'
  return yield* Effect.acquireUseRelease(
    Effect.try({
      try: () => {
        mkdirSync(dirname(path), { recursive: true })
        return temporary
      },
      catch: (cause) => storageError('NativeToolchain.atomicCommit.prepare', stage, path, cause),
    }),
    (staged) =>
      Effect.try({
        try: () => {
          writeFileSync(
            staged,
            bytes,
            options.mode === undefined ? undefined : { mode: options.mode },
          )
          renameSync(staged, path)
          if (options.mode !== undefined) chmodSync(path, options.mode)
          return path
        },
        catch: (cause) => storageError('NativeToolchain.atomicCommit', stage, path, cause),
      }),
    (staged, exit) =>
      releaseCleanup(
        exit,
        cleanupPath(staged, { force: true }, options.cleanup ?? nodeCleanup, 'artifact-cleanup'),
      ),
  )
})

const cleanupCommittedOnFailure = <A, E>(
  path: string,
  exit: Exit.Exit<A, E>,
): Effect.Effect<void, ToolchainError> =>
  Exit.isFailure(exit)
    ? releaseCleanup(exit, cleanupPath(path, { force: true }, nodeCleanup, 'artifact-cleanup'))
    : Effect.void

const cleanupCommittedSetOnFailure = <A, E>(
  paths: ReadonlyArray<string>,
  exit: Exit.Exit<A, E>,
): Effect.Effect<void, ToolchainError> =>
  Exit.isFailure(exit)
    ? Effect.forEach(
        paths,
        (path) =>
          releaseCleanup(exit, cleanupPath(path, { force: true }, nodeCleanup, 'artifact-cleanup')),
        { discard: true },
      )
    : Effect.void

/** Commits a native library's header and ABI manifest, removing the whole set on failure. */
export const commitLibraryInterface = Effect.fn('NativeToolchain.commitLibraryInterface')(
  function* (
    artifactPath: string,
    destination: string,
    packageName: string,
    cHeader: Uint8Array,
    abiManifest: Uint8Array,
  ): Effect.fn.Return<LibraryInterfaceArtifacts, ToolchainError> {
    const directory = dirname(resolve(destination))
    const cHeaderDestination = join(directory, `${packageName}.h`)
    const abiManifestDestination = join(directory, `${packageName}.abi.json`)
    return yield* Effect.acquireUseRelease(
      Effect.succeed(resolve(artifactPath)),
      () =>
        Effect.gen(function* () {
          if (!Project.isPackageName(packageName))
            return yield* invalidPackageNameError(packageName)
          return yield* Effect.acquireUseRelease(
            Effect.succeed([cHeaderDestination, abiManifestDestination]),
            () =>
              Effect.gen(function* () {
                const cHeaderPath = yield* atomicCommit(cHeaderDestination, cHeader)
                const abiManifestPath = yield* atomicCommit(abiManifestDestination, abiManifest)
                return {
                  _tag: 'LibraryInterfaceArtifacts' as const,
                  cHeader: cHeaderPath,
                  abiManifest: abiManifestPath,
                }
              }),
            cleanupCommittedSetOnFailure,
          )
        }),
      cleanupCommittedOnFailure,
    )
  },
)

const processArtifactStorage = Storage.memoryService()

/** Selects the process-memory default or a rooted filesystem Storage provider. */
export const defaultArtifactStorage = Effect.fn('NativeToolchain.defaultArtifactStorage')(
  function* (
    directory = '',
  ): Effect.fn.Return<Storage.Service, never, FileSystem.FileSystem | PathService.Path> {
    return directory === '' ? processArtifactStorage : yield* Storage.fileSystemService(directory)
  },
)

const toolVersions = new Map<string, string>()

const toolVersionOf = Effect.fnUntraced(function* (
  command: string,
): Effect.fn.Return<string, ToolchainError> {
  const cached = toolVersions.get(command)
  if (cached !== undefined) return cached
  const planned: ToolchainPlan.PlannedCommand = {
    _tag: 'PlannedCommand',
    command,
    arguments: ['--version'],
    target: Target.wasm32UnknownUnknown,
  }
  const result = yield* Effect.try({
    try: () => spawnSync(command, ['--version'], { encoding: 'utf8' }),
    catch: (cause) =>
      processError('NativeToolchain.toolVersionOf', 'object', planned, null, '', cause),
  })
  if (result.error !== undefined || result.status !== 0) {
    return yield* processError(
      'NativeToolchain.toolVersionOf',
      'object',
      planned,
      result.status,
      `${result.stdout ?? ''}${result.stderr ?? ''}${result.error?.message ?? ''}`,
      result.error,
    )
  }
  const version = result.stdout.split('\n', 1)[0] ?? ''
  toolVersions.set(command, version)
  return version
})

/** The final-cache policy selected before either lookup or publication. */
export type FinalArtifactCacheAdmission =
  | { readonly _tag: 'ExistingWebAssemblyPolicy' }
  | { readonly _tag: 'CompleteNativePlan'; readonly identity: string }
  | {
      readonly _tag: 'Ineligible'
      readonly reason: 'IncompleteNativeInputAccounting'
    }

/** Requires complete physical accounting before native final-artifact reuse or publication. */
export const finalArtifactCacheAdmission = (
  kind: FinalArtifact['kind'],
  plan?: NativeLinkPlan.NativeLinkPlan,
): FinalArtifactCacheAdmission => {
  if (kind === 'WebAssemblyModule') return { _tag: 'ExistingWebAssemblyPolicy' }
  if (plan === undefined || plan.kind !== kind)
    return { _tag: 'Ineligible', reason: 'IncompleteNativeInputAccounting' }
  return { _tag: 'CompleteNativePlan', identity: plan.identity }
}

/** Computes the independently existing freestanding WebAssembly final-cache identity. */
export const wasmArtifactCacheKey = Effect.fn('NativeToolchain.wasmArtifactCacheKey')(function* (
  toolchain: Toolchain,
  profile: CompilationProfile.CompilationProfile,
  bitcode: Uint8Array | string,
  runtimeSource: string,
): Effect.fn.Return<string, ToolchainError> {
  const version = yield* toolVersionOf(toolchain.clang)
  const digest = createHash('sha256')
  digest.update(
    yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))([
      'wasm-artifact-v1',
      profile.identity,
      toolchain.clang,
      version,
      runtimeSource,
    ]).pipe(Effect.orDie),
  )
  digest.update(bitcode)
  return `${digest.digest('hex')}.wasm`
})

export interface PathArtifact {
  readonly translation?: CTranslationUnit.CTranslationUnit

  readonly _tag: 'PathArtifact'
  readonly scope: string
  readonly path: string
  readonly target: Target.Target
}

export interface BuildScope {
  readonly _tag: 'BuildScope'
  readonly name: string
  readonly root: string
}

export interface ObjectArtifact {
  readonly helpers?: HelperCapability.Report
  readonly inventory?: ObjectSymbols.Inventory
  readonly _tag: 'ObjectArtifact'
  readonly artifact: PathArtifact
  readonly planned: ToolchainPlan.PlannedCommand
}

export interface FinalArtifact {
  readonly helpers?: HelperCapability.Report
  readonly _tag: 'FinalArtifact'
  readonly kind: ArtifactKind.ArtifactKind
  readonly path: string
  readonly bytes: Uint8Array
  readonly target: Target.Target
  readonly planned?: ToolchainPlan.PlannedCommand
  readonly linkPlan?: NativeLinkPlan.NativeLinkPlan
}

/** Durable C-consumer companions committed beside one native library. */
export interface LibraryInterfaceArtifacts {
  readonly _tag: 'LibraryInterfaceArtifacts'
  /** The durable generated C-header path. */
  readonly cHeader: string
  /** The durable generated ABI-manifest path. */
  readonly abiManifest: string
}

export const hostTarget = Effect.fn('NativeToolchain.hostTarget')(function* (): Effect.fn.Return<
  Target.Target,
  Target.TargetError
> {
  return yield* Target.fromHost(platform(), arch())
})

/** Selects the current Node process host without pulling Node detection into the pure target actor. */
export const hostSelection = (): Target.Selection => Target.select(undefined, platform(), arch())

export const withBuildScope = Effect.fn('NativeToolchain.withBuildScope')(function* <A, E, R>(
  name: string,
  run: (scope: BuildScope) => Effect.Effect<A, E, R>,
  options: { readonly saveTemps?: boolean; readonly cleanup?: CleanupOperation } = {},
): Effect.fn.Return<A, E | ToolchainError, R> {
  return yield* Effect.acquireUseRelease(
    Effect.try({
      try: () => {
        const root = mkdtempSync(join(tmpdir(), `silk-${name.replace(/[^A-Za-z0-9_-]/g, '_')}-`))
        return { _tag: 'BuildScope' as const, name, root }
      },
      catch: (cause) =>
        storageError('NativeToolchain.withBuildScope', 'scope-acquire', tmpdir(), cause),
    }),
    run,
    (scope, exit) =>
      options.saveTemps === true
        ? Effect.void
        : releaseCleanup(
            exit,
            cleanupPath(
              scope.root,
              { recursive: true, force: true },
              options.cleanup ?? nodeCleanup,
              'scope-cleanup',
            ),
          ),
  )
})

const readRuntimeObjectCache = Effect.fnUntraced(function* (
  cache: RuntimeObjectCache,
  key: string,
): Effect.fn.Return<Uint8Array | undefined, ToolchainError> {
  const storageKey = `runtime-${createHash('sha256').update(key).digest('hex')}.o`
  const found = yield* Storage.read(
    'runtime-objects',
    storageKey,
    maximumNativeCacheRecordBytes,
  ).pipe(
    Effect.provideService(Storage.Storage, cache.storage),
    Effect.mapError((cause) =>
      storageError('NativeToolchain.RuntimeObjectCache.get', 'cache-read', key, cause),
    ),
  )
  const state = runtimeObjectCacheState(cache)
  if (Option.isNone(found)) {
    state.misses += 1
    return undefined
  }
  state.hits += 1
  state.entries.add(storageKey)
  return found.value
})

const writeRuntimeObjectCache = Effect.fnUntraced(function* (
  cache: RuntimeObjectCache,
  key: string,
  bytes: Uint8Array,
): Effect.fn.Return<void, ToolchainError> {
  const storageKey = `runtime-${createHash('sha256').update(key).digest('hex')}.o`
  yield* Storage.publish('runtime-objects', storageKey, bytes, maximumNativeCacheRecordBytes).pipe(
    Effect.provideService(Storage.Storage, cache.storage),
    Effect.mapError((cause) =>
      storageError('NativeToolchain.RuntimeObjectCache.set', 'cache-write', key, cause),
    ),
  )
  runtimeObjectCacheState(cache).entries.add(storageKey)
})

export const writeArtifact = Effect.fn('NativeToolchain.writeArtifact')(function* (
  scope: BuildScope,
  target: Target.Target,
  fileName: string,
  bytes: Uint8Array | string,
): Effect.fn.Return<PathArtifact, ToolchainError> {
  const path = join(scope.root, fileName)
  yield* Effect.try({
    try: () => writeFileSync(path, bytes),
    catch: (cause) => storageError('NativeToolchain.writeArtifact', 'scope-write', path, cause),
  })
  return { _tag: 'PathArtifact', scope: scope.name, path, target }
})

const runPlanned = Effect.fnUntraced(function* (
  operation: string,
  stage: 'object' | 'runtime' | 'wasm-finalize',
  planned: ToolchainPlan.PlannedCommand,
): Effect.fn.Return<void, ToolchainError> {
  // Asynchronous so the driver can run analysis-only work while the tool runs.
  const result = yield* Effect.callback<{
    readonly status: number | null
    readonly stdout: string
    readonly stderr: string
    readonly error?: Error
  }>((resume) => {
    const stdout: Array<Buffer> = []
    const stderr: Array<Buffer> = []
    let error: Error | undefined
    const child = spawn(
      planned.command,
      [...planned.arguments],
      planned.environment === undefined ? {} : { env: { ...planned.environment } },
    )
    let settled = false
    const settle = (status: number | null) => {
      if (settled) return
      settled = true
      resume(
        Effect.succeed({
          status,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
          ...(error === undefined ? {} : { error }),
        }),
      )
    }
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    // A process that never starts reports `error` and may never close its streams.
    child.on('error', (cause) => {
      error = cause
      if (child.pid === undefined) settle(null)
    })
    child.on('close', settle)
    return Effect.sync(() => {
      child.kill()
    })
  })
  const output = `${result.stdout}${result.stderr}${result.error?.message ?? ''}`
  if (result.error !== undefined || result.status !== 0) {
    return yield* processError(operation, stage, planned, result.status, output, result.error)
  }
})

const requirePath = Effect.fnUntraced(function* (
  operation: string,
  stage: Stage,
  path: string,
): Effect.fn.Return<void, ToolchainError> {
  const exists = yield* Effect.try({
    try: () => existsSync(path),
    catch: (cause) => storageError(operation, stage, path, cause),
  })
  if (!exists)
    return yield* storageError(operation, stage, path, new Error('expected output is missing'))
})

/** @internal ObjectEmission owns the public materialization operation. */
export const materializeObject = Effect.fnUntraced(function* (
  toolchain: Toolchain,
  scope: BuildScope,
  artifact: Backend.LlvmBitcodeArtifact,
  profile: CompilationProfile.CompilationProfile,
  baseName = 'program',
): Effect.fn.Return<ObjectArtifact, ToolchainError> {
  if (
    profile.target.kind === 'Native' &&
    profile.libc === 'none' &&
    artifact.nativeRuntimeSymbols.length > 0
  )
    return yield* helperError(
      new HelperCapability.HelperError({
        operation: 'ObjectEmission.materialize',
        code: 'MissingProvider',
        subject: 'No-libc artifact requires explicitly supplied language runtime capabilities',
        origins: artifact.nativeRuntimeSymbols,
      }),
    )
  if (
    artifact.support &&
    (profile.artifact !== 'object' ||
      profile.entry.kind !== 'none' ||
      profile.runtime.kind !== 'none' ||
      profile.libc !== 'none' ||
      profile.sanitizers.length !== 0 ||
      profile.unwind !== 'none')
  )
    return yield* helperError(
      new HelperCapability.HelperError({
        operation: 'ObjectEmission.materialize',
        code: 'InvalidSupportProfile',
        subject: 'Support artifact requires the restricted object profile',
        origins: [baseName],
      }),
    )
  const target = profile.target
  const bitcodePath = join(scope.root, `${baseName}.bc`)
  const objectPath = join(scope.root, `${baseName}.o`)
  const base = ToolchainPlan.objectCommand(toolchain.clang, profile, bitcodePath, objectPath)
  const planned = {
    ...base,
    arguments: [
      '--no-default-config',
      ...base.arguments,
      ...(artifact.support
        ? ['-mllvm', '-disable-loop-idiom-memcpy', '-mllvm', '-disable-loop-idiom-memset']
        : []),
    ],
    environment: toolchain.supply?.environment ?? {
      PATH: yield* Config.String('PATH').pipe(Config.withDefault(''), Effect.orDie),
      LC_ALL: 'C',
      LANG: 'C',
    },
  }
  if (artifact.target.id !== target.id) {
    return yield* processError(
      'ObjectEmission.materialize',
      'object',
      planned,
      null,
      `bitcode target ${artifact.target.id} does not match requested target ${target.id}`,
    )
  }
  yield* writeArtifact(scope, target, `${baseName}.bc`, artifact.bitcode)
  yield* runPlanned('ObjectEmission.materialize', 'object', planned)
  yield* requirePath('ObjectEmission.materialize', 'object', objectPath)
  const bytes = yield* Effect.try({
    try: () => readFileSync(objectPath),
    catch: (cause) => storageError('ObjectEmission.materialize', 'object', objectPath, cause),
  })
  const inventory = ObjectSymbols.inspect(bytes, target)
  if (Result.isFailure(inventory))
    return yield* helperError(
      new HelperCapability.HelperError({
        operation: 'ObjectEmission.materialize',
        code: 'InvalidObject',
        subject: inventory.failure.detail,
        origins: [objectPath, target.id],
      }),
    )
  const helpers = yield* HelperCapability.reconcile(
    inventory.success,
    artifact,
    profile,
    objectPath,
    ToolchainIntegrity.contentDigest(bytes),
  ).pipe(Effect.mapError(helperError))

  return {
    _tag: 'ObjectArtifact',
    helpers,
    inventory: inventory.success,
    artifact: {
      _tag: 'PathArtifact',
      scope: scope.name,
      path: objectPath,
      target,
    },
    planned,
  }
})

/** Realizes the selected source helpers as one object and audits its emitted dependency closure. */
export const compileHelpers = Effect.fn('NativeToolchain.compileHelpers')(function* (
  toolchain: Toolchain,
  scope: BuildScope,
  profile: CompilationProfile.Facts,
  report: HelperCapability.Report,
): Effect.fn.Return<ReadonlyArray<ObjectArtifact>, ToolchainError> {
  const providers = [
    ...new Map(report.requirements.map((entry) => [entry.provider.id, entry.provider])).values(),
  ]
  const selected = yield* HelperCapability.closure(
    report.requirements.map((entry) => entry.contract.symbol),
    providers,
    profile.target,
  ).pipe(Effect.mapError(helperError))
  const sources = selected.filter((provider) => provider.kind === 'source')
  if (sources.length === 0) return []
  const source = yield* HelperSource.compile(sources, profile).pipe(Effect.mapError(helperError))
  const object = yield* materializeObject(
    toolchain,
    scope,
    source.artifact,
    source.profile,
    'helpers',
  )
  if (object.inventory === undefined)
    return yield* helperError(
      new HelperCapability.HelperError({
        operation: 'NativeToolchain.compileHelpers',
        code: 'InvalidObject',
        subject: 'Missing provider inventory',
        origins: sources.map((provider) => provider.id),
      }),
    )
  yield* HelperCapability.verifyProviders(sources, object.inventory, profile.target).pipe(
    Effect.mapError(helperError),
  )
  return [object]
})

/**
 * Compiles one C translation unit to `<scope>/<name>.o` through the pinned Clang `-c -x c`
 * command, reusing native runtime objects by compiler content and frozen C translation identity.
 */
export const compileCObject = Effect.fn('NativeToolchain.compileCObject')(function* (
  toolchain: Toolchain,
  scope: BuildScope,
  target: Target.Target,
  name: string,
  sourceText: string,
): Effect.fn.Return<ObjectArtifact, ToolchainError> {
  let selected = toolchain
  if (target.kind === 'Native' && selected.supply === undefined) {
    const profile = yield* CompilationProfile.normalize({ target: target.id }).pipe(
      Effect.mapError((error) =>
        supplyError(
          PlatformSupply.failure('InvalidConfiguration', target.id, 'C compilation', error.message),
        ),
      ),
    )
    selected = yield* resolveToolchain(toolchain, profile)
  }
  if (selected.supply !== undefined && selected.supply.target.id !== target.id)
    return yield* supplyError(
      PlatformSupply.failure(
        'TargetMismatch',
        target.id,
        'C compilation',
        'Resolve a supply for the C target.',
      ),
    )
  const objectPath = join(scope.root, `${name}.o`)
  const source = yield* writeArtifact(scope, target, `${name}.c`, sourceText)
  let planned = ToolchainPlan.cObjectCommand(selected.clang, target, source.path, objectPath)
  let cacheKey: string
  let translation: CTranslationUnit.CTranslationUnit | undefined
  if (selected.supply !== undefined) {
    translation = yield* CTranslationUnitResolver.resolve(
      selected.supply,
      source.path,
      join(scope.root, `${name}.d`),
      scope.root,
    ).pipe(Effect.mapError(supplyError), Effect.provide(NodeServices.layer))
    const frozen = yield* writeArtifact(scope, target, `${name}.i`, translation.source)
    cacheKey = translation.identity
    planned = {
      ...planned,
      arguments: [
        ...selected.supply.compilationArguments,
        '-c',
        '-x',
        'cpp-output',
        frozen.path,
        '-O2',
        '-fPIC',
        '-fvisibility=hidden',
        '-o',
        objectPath,
      ],
      environment: selected.supply.environment,
    }
  } else {
    // Freestanding Wasm C uses no platform headers; its source remains under the Wasm cache policy.
    cacheKey = `${selected.clang}\u0000${target.id}\u0000${sourceText}`
  }
  const cached =
    toolchain.runtimeObjectCache === undefined
      ? undefined
      : yield* readRuntimeObjectCache(toolchain.runtimeObjectCache, cacheKey)
  if (cached !== undefined) {
    yield* writeArtifact(scope, target, `${name}.o`, cached)
  } else {
    yield* runPlanned('NativeToolchain.compileCObject', 'runtime', planned)
    yield* requirePath('NativeToolchain.compileCObject', 'runtime', objectPath)
    const bytes = yield* Effect.try({
      try: () => readFileSync(objectPath),
      catch: (cause) =>
        storageError('NativeToolchain.compileCObject', 'runtime', objectPath, cause),
    })
    if (toolchain.runtimeObjectCache !== undefined)
      yield* writeRuntimeObjectCache(toolchain.runtimeObjectCache, cacheKey, bytes)
  }
  return {
    _tag: 'ObjectArtifact',
    artifact: {
      _tag: 'PathArtifact',
      ...(translation === undefined ? {} : { translation }),
      scope: scope.name,
      path: objectPath,
      target,
    },
    planned,
  }
})

export const compileRuntime = Effect.fn('NativeToolchain.compileRuntime')(function* (
  toolchain: Toolchain,
  scope: BuildScope,
  target: Target.Target,
): Effect.fn.Return<ObjectArtifact, ToolchainError> {
  return yield* compileCObject(
    toolchain,
    scope,
    target,
    'silk_runtime',
    ToolchainPlan.runtimeSource(),
  )
})

/**
 * Plans the link and rejects an input that targets another triple or is missing on disk, so a
 * bad object is reported as linker input data wherever the check runs.
 */
export const requireLinkInputs = Effect.fnUntraced(function* (
  toolchain: Toolchain,
  artifactKind: ToolchainPlan.NativeArtifactKind,
  target: Target.Target,
  generatedObjects: ReadonlyArray<PathArtifact>,
  nativeLinkInputs: ReadonlyArray<NativeLinkInput.NativeLinkInput>,
  outputPath: string,
  entry: CompilationProfile.Selection = { kind: 'default' },
): Effect.fn.Return<ToolchainPlan.PlannedCommand, ToolchainError> {
  const plan = ToolchainPlan.nativeCommand(
    toolchain,
    artifactKind,
    target,
    generatedObjects.map((object) => object.path),
    nativeLinkInputs,
    outputPath,
    entry,
  )
  if (plan._tag === 'UnsupportedNativePlan') return yield* unsupportedPlanError(plan)
  for (const object of generatedObjects) {
    if (object.target.id !== target.id) {
      return yield* linkError(
        plan,
        null,
        `linker input ${object.path} targets ${object.target.id}; expected ${target.id}`,
      )
    }
    const exists = yield* Effect.try({
      try: () => existsSync(object.path),
      catch: (cause) => linkError(plan, null, `cannot inspect linker input ${object.path}`, cause),
    })
    if (!exists) return yield* linkError(plan, null, `missing linker input: ${object.path}`)
  }
  for (const input of nativeLinkInputs) {
    const path = NativeLinkInput.path(input)
    if (path === undefined) continue
    const exists = yield* Effect.try({
      try: () => existsSync(path),
      catch: (cause) => linkError(plan, null, `cannot inspect linker input ${path}`, cause),
    })
    if (!exists) return yield* linkError(plan, null, `missing linker input: ${path}`)
  }
  return plan
})

/** Resolves a complete final plan without executing final linking. */
export const planNativeLink = Effect.fn('NativeToolchain.planNativeLink')(function* (
  toolchain: Toolchain,
  scope: BuildScope,
  kind: ToolchainPlan.NativeArtifactKind,
  profile: CompilationProfile.Facts,
  generatedObjects: ReadonlyArray<PathArtifact>,
  nativeLinkInputs: ReadonlyArray<NativeLinkInput.NativeLinkInput>,
  destination: string,
  entry: NativeLinkPlan.NativeLinkPlan['entry'],
  helpers: ReadonlyArray<HelperCapability.Report> = [],
): Effect.fn.Return<NativeLinkPlan.NativeLinkPlan, ToolchainError> {
  let outputName = 'linked-program'
  if (kind === 'NativeStaticLibrary') outputName = 'archive.a'
  else if (kind === 'NativeSharedLibrary') outputName = basename(destination)
  const output = join(scope.root, outputName)
  yield* requireLinkInputs(
    toolchain,
    kind,
    profile.target,
    generatedObjects,
    nativeLinkInputs,
    output,
    entry.resolved,
  )
  const selected = yield* resolveToolchain(toolchain, profile)
  const supply = selected.supply
  if (supply === undefined)
    return yield* supplyError(
      PlatformSupply.failure(
        'MissingCapability',
        profile.target.id,
        'link planning',
        'Resolve a native supply.',
      ),
    )
  return yield* NativeLinkResolver.resolvePlan(supply, {
    kind,
    profile,
    objects: generatedObjects.map((object) => object.path),
    inputs: nativeLinkInputs,
    helpers,
    translations: generatedObjects.flatMap((object) =>
      object.translation === undefined ? [] : [object.translation],
    ),
    output,
    scope: scope.root,
    entry,
  }).pipe(Effect.mapError(supplyError), Effect.provide(NodeServices.layer))
})

/** Verifies a published plan's selected contents before a cache hit or final link consumes it. */
export const validateLinkPlan = Effect.fn('NativeToolchain.validateLinkPlan')(function* (
  plan: NativeLinkPlan.NativeLinkPlan,
): Effect.fn.Return<void, ToolchainError> {
  yield* PlatformSupplyResolver.validateFiles([
    plan.supply.compiler,
    plan.supply.linker,
    plan.supply.archiver,
    ...plan.supply.files,
    ...plan.inputs,
  ]).pipe(Effect.mapError(supplyError), Effect.provide(NodeServices.layer))
})

/** @internal Linker owns validation, cache policy, and the public link operation. */
export const finalizeLink = Effect.fnUntraced(function* (
  plan: NativeLinkPlan.NativeLinkPlan,
  artifactKind: ToolchainPlan.NativeArtifactKind,
  destination: string,
): Effect.fn.Return<FinalArtifact, ToolchainError> {
  if (plan.kind !== artifactKind)
    return yield* supplyError(
      PlatformSupply.failure(
        'InvalidConfiguration',
        artifactKind,
        'native link plan',
        'Use the artifact kind for which this link plan was resolved.',
      ),
    )
  yield* validateLinkPlan(plan)
  for (const script of plan.scripts)
    yield* Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      yield* fs
        .writeFileString(script.path, script.source)
        .pipe(Effect.mapError((cause) => storageError('Linker.link', 'link', script.path, cause)))
    }).pipe(Effect.provide(NodeServices.layer))
  const planned = { ...plan.command, environment: plan.supply.environment }
  const result = yield* PlatformSupplyResolver.query(
    planned.environment,
    planned.command,
    planned.arguments,
    'final linking',
  ).pipe(
    Effect.mapError((failure) =>
      linkError(
        planned,
        failure.query?.status ?? null,
        `${failure.query?.stdout ?? ''}${failure.query?.stderr ?? failure.message}`,
        failure.cause,
        plan.inputs,
      ),
    ),
    Effect.provide(NodeServices.layer),
  )
  yield* requirePath('Linker.link', 'link', plan.output)
  const bytes = yield* Effect.try({
    try: () => readFileSync(plan.output),
    catch: (cause) => storageError('Linker.link', 'link', plan.output, cause),
  })
  if (!isCachedArtifact(bytes, artifactKind, plan.supply.target))
    return yield* linkError(
      planned,
      result.status,
      'Linked output does not match its requested artifact kind and target.',
    )
  const path = yield* atomicCommit(destination, bytes, {
    ...(artifactKind === 'NativeExecutable' ? { mode: 0o755 } : {}),
    stage: 'artifact-commit',
  })
  return {
    _tag: 'FinalArtifact',
    kind: artifactKind,
    path,
    bytes,
    target: plan.supply.target,
    planned,
    linkPlan: plan,
  }
})

const hasWasmHeader = (bytes: Uint8Array): boolean =>
  bytes.length >= 8 &&
  bytes[0] === 0 &&
  bytes[1] === 97 &&
  bytes[2] === 115 &&
  bytes[3] === 109 &&
  bytes[4] === 1 &&
  bytes[5] === 0 &&
  bytes[6] === 0 &&
  bytes[7] === 0

const hasBytesAt = (bytes: Uint8Array, offset: number, expected: ReadonlyArray<number>): boolean =>
  expected.every((byte, index) => bytes[offset + index] === byte)

const uint16LittleEndian = (bytes: Uint8Array, offset: number): number | undefined => {
  const low = bytes[offset]
  const high = bytes[offset + 1]
  return low === undefined || high === undefined ? undefined : low | (high << 8)
}

const uint32LittleEndian = (bytes: Uint8Array, offset: number): number | undefined => {
  const low = uint16LittleEndian(bytes, offset)
  const high = uint16LittleEndian(bytes, offset + 2)
  return low === undefined || high === undefined ? undefined : low + high * 0x1_0000
}

const uint64LittleEndian = (bytes: Uint8Array, offset: number): number | undefined => {
  const low = uint32LittleEndian(bytes, offset)
  const high = uint32LittleEndian(bytes, offset + 4)
  if (low === undefined || high === undefined) return undefined
  const value = low + high * 0x1_0000_0000
  return Number.isSafeInteger(value) ? value : undefined
}

const isNativeObjectForTarget = (
  bytes: Uint8Array,
  offset: number,
  target: Target.Target,
): boolean => {
  if (target.id === 'aarch64-apple-darwin') {
    return (
      hasBytesAt(bytes, offset, [0xcf, 0xfa, 0xed, 0xfe]) &&
      uint32LittleEndian(bytes, offset + 4) === 0x0100_000c
    )
  }
  let elfMachine: number | undefined
  if (target.id === 'x86_64-unknown-linux-gnu') elfMachine = 62
  else if (target.id === 'aarch64-unknown-linux-gnu') elfMachine = 183
  return (
    elfMachine !== undefined &&
    hasBytesAt(bytes, offset, [0x7f, 0x45, 0x4c, 0x46]) &&
    bytes[offset + 4] === 2 &&
    bytes[offset + 5] === 1 &&
    uint16LittleEndian(bytes, offset + 18) === elfMachine
  )
}

const isNativeImageForKind = (
  bytes: Uint8Array,
  kind: 'NativeExecutable' | 'NativeSharedLibrary',
  target: Target.Target,
): boolean => {
  if (!isNativeObjectForTarget(bytes, 0, target)) return false
  if (target.id === 'aarch64-apple-darwin') {
    if (bytes.length < 32) return false
    const fileType = uint32LittleEndian(bytes, 12)
    return kind === 'NativeExecutable' ? fileType === 2 : fileType === 6
  }
  if (bytes.length < 64) return false
  const fileType = uint16LittleEndian(bytes, 16)
  if (fileType === 2) return kind === 'NativeExecutable'
  if (fileType !== 3) return false
  const programOffset = uint64LittleEndian(bytes, 32)
  const programEntrySize = uint16LittleEndian(bytes, 54)
  const programCount = uint16LittleEndian(bytes, 56)
  if (programOffset === undefined || programEntrySize === undefined || programCount === undefined)
    return false
  if (programEntrySize < 4 || programOffset + programEntrySize * programCount > bytes.length)
    return false
  let hasInterpreter = false
  for (let index = 0; index < programCount; index += 1) {
    if (uint32LittleEndian(bytes, programOffset + programEntrySize * index) === 3)
      hasInterpreter = true
  }
  return kind === 'NativeExecutable' ? hasInterpreter : !hasInterpreter
}

const asciiDecoder = new TextDecoder('ascii')

const asciiField = (bytes: Uint8Array, offset: number, length: number): string =>
  asciiDecoder.decode(bytes.subarray(offset, offset + length)).trim()

const isStaticArchiveForTarget = (bytes: Uint8Array, target: Target.Target): boolean => {
  if (!hasBytesAt(bytes, 0, [0x21, 0x3c, 0x61, 0x72, 0x63, 0x68, 0x3e, 0x0a])) return false
  let offset = 8
  let hasTargetObject = false
  while (offset + 60 <= bytes.length) {
    if (!hasBytesAt(bytes, offset + 58, [0x60, 0x0a])) return false
    const sizeText = asciiField(bytes, offset + 48, 10)
    if (!/^\d+$/.test(sizeText)) return false
    const size = Number(sizeText)
    const dataOffset = offset + 60
    if (!Number.isSafeInteger(size) || dataOffset + size > bytes.length) return false
    if (size % 2 === 1 && bytes[dataOffset + size] !== 0x0a) return false
    const name = asciiField(bytes, offset, 16)
    const extendedName = /^#1\/(\d+)$/.exec(name)
    const nameLength = extendedName === null ? 0 : Number(extendedName[1])
    if (!Number.isSafeInteger(nameLength) || nameLength > size) return false
    const objectOffset = dataOffset + nameLength
    let memberName = name
    if (extendedName !== null)
      memberName = asciiField(bytes, dataOffset, nameLength).replace(/\0+$/, '')
    const isIndex =
      memberName === '/' ||
      memberName === '//' ||
      memberName === '/SYM64/' ||
      memberName.startsWith('__.SYMDEF')
    if (!isIndex) {
      if (!isNativeObjectForTarget(bytes, objectOffset, target)) return false
      hasTargetObject = true
    }
    offset = dataOffset + size + (size % 2)
  }
  return offset === bytes.length && hasTargetObject
}

/** Whether finalized bytes match the requested artifact container, kind, and target. */
export const isCachedArtifact = (
  bytes: Uint8Array,
  kind: FinalArtifact['kind'],
  target: Target.Target,
): boolean => {
  if (kind === 'WebAssemblyModule')
    return target.id === 'wasm32-unknown-unknown' && hasWasmHeader(bytes)
  if (kind === 'NativeStaticLibrary') return isStaticArchiveForTarget(bytes, target)
  if (kind === 'NativeObject') {
    if (!isNativeObjectForTarget(bytes, 0, target)) return false
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    return target.operatingSystem === 'darwin'
      ? view.getUint32(12, true) === 1
      : view.getUint16(16, true) === 1
  }
  return isNativeImageForKind(bytes, kind, target)
}

export const finalizeWasm = Effect.fn('NativeToolchain.finalizeWasm')(function* (
  toolchain: Toolchain,
  scope: BuildScope,
  artifact: Backend.LlvmBitcodeArtifact,
  profile: CompilationProfile.CompilationProfile,
  destination: string,
): Effect.fn.Return<FinalArtifact, ToolchainError> {
  const target = profile.target
  const object = yield* materializeObject(toolchain, scope, artifact, profile)
  const runtime = yield* compileCObject(
    toolchain,
    scope,
    target,
    'silk_wasm_runtime',
    LlvmWasmRuntime.source,
  )
  const bootstrapBytes = yield* Effect.try({
    try: () => readFileSync(runtime.artifact.path),
    catch: (cause) =>
      storageError('NativeToolchain.finalizeWasm', 'runtime', runtime.artifact.path, cause),
  })
  const bootstrap = ObjectSymbols.inspect(bootstrapBytes, target)
  if (Result.isFailure(bootstrap))
    return yield* helperError(
      new HelperCapability.HelperError({
        operation: 'NativeToolchain.finalizeWasm',
        code: 'InvalidObject',
        subject: bootstrap.failure.detail,
        origins: [runtime.artifact.path],
      }),
    )
  yield* HelperCapability.verifyProviders(
    [
      {
        id: 'llvm-wasm-memory.v1',
        kind: 'bootstrap',
        root: 'llvm-wasm-memory.v1',
        targets: [target.id],
        provides: ['memcpy', 'memmove', 'memset', 'memcmp'],
        requires: [
          '__heap_base',
          '__stack_pointer',
          '__memory_base',
          '__table_base',
          '__indirect_function_table',
        ],
        identity: ToolchainIntegrity.contentDigest(LlvmWasmRuntime.source),
      },
    ],
    bootstrap.success,
    target,
  ).pipe(Effect.mapError(helperError))
  const outputPath = join(scope.root, 'program.wasm')
  const planned = ToolchainPlan.wasmCommand(
    toolchain.clang,
    profile,
    object.artifact.path,
    runtime.artifact.path,
    outputPath,
  )
  if (artifact.target.id !== target.id) {
    return yield* processError(
      'NativeToolchain.finalizeWasm',
      'wasm-finalize',
      planned,
      null,
      `bitcode target ${artifact.target.id} does not match requested target ${target.id}`,
    )
  }
  yield* runPlanned('NativeToolchain.finalizeWasm', 'wasm-finalize', planned)
  yield* requirePath('NativeToolchain.finalizeWasm', 'wasm-finalize', outputPath)
  const bytes = yield* Effect.try({
    try: () => readFileSync(outputPath),
    catch: (cause) =>
      storageError('NativeToolchain.finalizeWasm', 'wasm-finalize', outputPath, cause),
  })
  if (!hasWasmHeader(bytes)) {
    return yield* processError(
      'NativeToolchain.finalizeWasm',
      'wasm-finalize',
      planned,
      0,
      'invalid WebAssembly output',
    )
  }
  const path = yield* atomicCommit(destination, bytes)
  return {
    _tag: 'FinalArtifact',
    kind: 'WebAssemblyModule',
    ...(object.helpers === undefined ? {} : { helpers: object.helpers }),
    path,
    bytes,
    target,
    planned,
  }
})

export const commitCachedArtifact = Effect.fn('NativeToolchain.commitCachedArtifact')(function* (
  bytes: Uint8Array,
  kind: FinalArtifact['kind'],
  target: Target.Target,
  destination: string,
): Effect.fn.Return<FinalArtifact, ToolchainError> {
  if (!isCachedArtifact(bytes, kind, target)) {
    return yield* storageError(
      'NativeToolchain.commitCachedArtifact',
      'artifact-commit',
      destination,
      new TypeError(`cached bytes are not a ${kind} artifact for ${target.id}`),
    )
  }
  const copy = Uint8Array.from(bytes)
  const path = yield* atomicCommit(destination, copy, {
    ...(kind === 'NativeExecutable' ? { mode: 0o755 } : {}),
    stage: 'artifact-commit',
  })
  return { _tag: 'FinalArtifact', kind, path, bytes: copy, target }
})

/** Commits an emitted representation independently of its semantic artifact form. */
export const commitRepresentation = Effect.fn('NativeToolchain.commitRepresentation')(function* (
  bytes: Uint8Array,
  destination: string,
): Effect.fn.Return<string, ToolchainError> {
  return yield* atomicCommit(destination, Uint8Array.from(bytes), { stage: 'artifact-commit' })
})

/** Reads and commits a scoped native output without leaking temporary paths. */
export const commitPathRepresentation = Effect.fn('NativeToolchain.commitPathRepresentation')(
  function* (
    artifact: PathArtifact,
    destination: string,
  ): Effect.fn.Return<string, ToolchainError> {
    const bytes = yield* Effect.try({
      try: () => readFileSync(artifact.path),
      catch: (cause) =>
        storageError(
          'NativeToolchain.commitPathRepresentation',
          'artifact-commit',
          artifact.path,
          cause,
        ),
    })
    return yield* commitRepresentation(bytes, destination)
  },
)

/** Emits a requested intermediate representation without constructing runtime or link inputs. */
export const emitRepresentation = Effect.fn('NativeToolchain.emitRepresentation')(function* (
  toolchain: Toolchain,
  scope: BuildScope,
  artifact: Backend.LlvmBitcodeArtifact,
  profile: CompilationProfile.CompilationProfile,
  stage: Exclude<ArtifactPlan.Stage, 'final'>,
  destination: string,
): Effect.fn.Return<string, ToolchainError> {
  if (stage === 'llvm-bitcode') return yield* commitRepresentation(artifact.bitcode, destination)
  if (stage === 'llvm-ir')
    return yield* commitRepresentation(new TextEncoder().encode(artifact.ir), destination)
  if (stage === 'object') {
    const object = yield* materializeObject(toolchain, scope, artifact, profile)
    return yield* commitPathRepresentation(object.artifact, destination)
  }
  const bitcode = yield* writeArtifact(scope, profile.target, 'program.bc', artifact.bitcode)
  const assemblyPath = join(scope.root, 'program.s')
  const object = ToolchainPlan.objectCommand(toolchain.clang, profile, bitcode.path, assemblyPath)
  const planned = {
    ...object,
    arguments: object.arguments.map((argument) => (argument === '-c' ? '-S' : argument)),
  }
  yield* runPlanned('NativeToolchain.emitRepresentation', 'object', planned)
  yield* requirePath('NativeToolchain.emitRepresentation', 'object', assemblyPath)
  return yield* commitPathRepresentation(
    { _tag: 'PathArtifact', scope: scope.name, path: assemblyPath, target: profile.target },
    destination,
  )
})

/** Publishes the physical plan beside an artifact for build/CLI inspection. */
export const commitLinkPlan = Effect.fn('NativeToolchain.commitLinkPlan')(function* (
  plan: NativeLinkPlan.NativeLinkPlan,
  destination: string,
): Effect.fn.Return<string, ToolchainError> {
  return yield* atomicCommit(
    destination,
    new TextEncoder().encode(
      (yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(plan).pipe(Effect.orDie)) +
        '\n',
    ),
  )
})
