import * as Schema from 'effect/Schema'
import { createHash } from 'node:crypto'
import * as Clock from 'effect/Clock'
import * as FileSystem from 'effect/FileSystem'
import * as Option from 'effect/Option'
import * as Stream from 'effect/Stream'
import * as Result from 'effect/Result'
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process'
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import * as Effect from 'effect/Effect'
import * as PlatformSupply from './PlatformSupply.js'
import type * as CompilationProfile from './CompilationProfile.js'
import type * as Target from './Target.js'

export type Services = FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner

export interface PlatformSupplyResolver {
  readonly environment: Readonly<Record<string, string>>
}

/** Captures only the discovery channels this boundary admits. Other tool overrides are disabled. */
export const make = (
  environment: Readonly<Record<string, string | undefined>>,
): PlatformSupplyResolver => {
  const values: Record<string, string> = {}
  for (const name of ['PATH', 'SDKROOT', 'DEVELOPER_DIR']) {
    const value = environment[name]
    if (value !== undefined) values[name] = value
  }
  return { environment: values }
}

export const digest = (bytes: Uint8Array | string): string =>
  createHash('sha256').update(bytes).digest('hex')

const storageFailure = (path: string, origin: string, cause: unknown): PlatformSupply.SupplyError =>
  new PlatformSupply.SupplyError({
    operation: 'PlatformSupplyResolver.read',
    code: 'StorageFailed',
    subject: path,
    origin,
    message: `Cannot read supply input: ${path}`,
    correction: 'Provide an installed, readable input for this supply.',
    cause,
  })

/** Reads through the owning boundary; expected filesystem failures remain typed. */
export const read = Effect.fn('PlatformSupplyResolver.read')(function* (
  path: string,
  origin: string,
): Effect.fn.Return<Uint8Array, PlatformSupply.SupplyError, FileSystem.FileSystem> {
  const fs = yield* FileSystem.FileSystem
  return yield* fs
    .readFile(path)
    .pipe(Effect.mapError((cause) => storageFailure(path, origin, cause)))
})

/** Resolves absolute symlinks inside a foreign sysroot in that sysroot's namespace. */
export const physicalPath = Effect.fn('PlatformSupplyResolver.physicalPath')(function* (
  path: string,
  root = '/',
): Effect.fn.Return<string, PlatformSupply.SupplyError, FileSystem.FileSystem> {
  const fs = yield* FileSystem.FileSystem
  const absolute = resolve(path)
  if (root === '/')
    return yield* fs
      .realPath(absolute)
      .pipe(Effect.mapError((cause) => storageFailure(path, 'path resolution', cause)))
  const namespace = yield* fs
    .realPath(root)
    .pipe(Effect.mapError((cause) => storageFailure(root, 'sysroot namespace', cause)))
  let pending = absolute.split(sep),
    current = '/',
    links = 0
  while (pending.length > 0) {
    const part = pending.shift()
    if (part === undefined || part === '' || part === '.') continue
    if (part === '..') {
      if (current !== namespace) current = dirname(current)
      continue
    }
    const candidate = join(current, part)
    // FileSystem.stat follows symlinks. readLink distinguishes a real link from EINVAL
    // without following an absolute target into the host's namespace.
    const selected = yield* Effect.result(fs.readLink(candidate))
    if (Result.isSuccess(selected)) {
      if (++links > 64)
        return yield* PlatformSupply.failure(
          'UnsupportedInput',
          path,
          root,
          'Remove the cyclic sysroot symlink.',
        )
      const link = selected.success
      if (isAbsolute(link)) current = within(namespace, current) ? namespace : '/'
      pending = [...link.split(sep), ...pending]
    } else {
      const cause = selected.failure.cause
      if (!(cause instanceof Error && 'code' in cause && cause.code === 'EINVAL'))
        return yield* storageFailure(candidate, 'sysroot path resolution', selected.failure)
      current = candidate
    }
  }
  return current
})

/**
 * A settled file's content digest, keyed by the stat identity it was observed under. Supply
 * snapshots re-validate the same multi-hundred-megabyte tools several times per compile; any write
 * or replacement changes the identity and forces a re-read.
 */
interface Observation {
  readonly identity: string
  readonly digest: string
}

const observations = new Map<string, Observation>()

/**
 * A file modified this recently may still change within its timestamp granularity without
 * changing its identity, so its digest is never reused.
 */
const settledMillis = 2_000

/**
 * Effect's live clock, the host wall clock that stamps mtime. Settledness is never judged against
 * the provided fiber Clock: a virtual one (`TestClock` starts at epoch 0) would disable the memo or
 * memoize a file still within its timestamp granularity.
 */
const hostClock = Clock.Clock.defaultValue()

const statIdentity = (info: FileSystem.File.Info): string | undefined => {
  const mtime = Option.getOrUndefined(info.mtime)
  const ino = Option.getOrUndefined(info.ino)
  return mtime === undefined || ino === undefined
    ? undefined
    : `${info.dev}:${ino}:${info.size}:${mtime.getTime()}`
}

/** Digests a canonical file, reusing a settled observation while its stat identity is unchanged. */
const contentDigest = Effect.fnUntraced(function* (
  path: string,
  origin: string,
): Effect.fn.Return<string, PlatformSupply.SupplyError, FileSystem.FileSystem> {
  const fs = yield* FileSystem.FileSystem
  const info = yield* fs
    .stat(path)
    .pipe(Effect.mapError((cause) => storageFailure(path, origin, cause)))
  const identity = statIdentity(info)
  const observed = observations.get(path)
  if (identity !== undefined && observed?.identity === identity) return observed.digest
  const value = digest(yield* read(path, origin))
  const modified = Option.getOrUndefined(info.mtime)?.getTime()
  if (
    identity !== undefined &&
    modified !== undefined &&
    modified <= (yield* hostClock.currentTimeMillis) - settledMillis
  )
    observations.set(path, { identity, digest: value })
  else observations.delete(path)
  return value
})

export const file = Effect.fn('PlatformSupplyResolver.file')(function* (
  path: string,
  role: PlatformSupply.Role,
  origin: string,
  root = '/',
): Effect.fn.Return<PlatformSupply.File, PlatformSupply.SupplyError, FileSystem.FileSystem> {
  const canonical = yield* physicalPath(path, root)
  return {
    path: canonical,
    selectedPath: resolve(path),
    root,
    role,
    origin,
    digest: yield* contentDigest(canonical, origin),
  }
})

/** Rejects mutation instead of obtaining a different supply implicitly. */
export const validateFiles = Effect.fn('PlatformSupplyResolver.validateFiles')(function* (
  files: ReadonlyArray<PlatformSupply.File>,
): Effect.fn.Return<void, PlatformSupply.SupplyError, FileSystem.FileSystem> {
  for (const input of files) {
    const path = yield* physicalPath(input.selectedPath, input.root)
    if (path !== input.path || (yield* contentDigest(path, input.origin)) !== input.digest)
      return yield* PlatformSupply.failure(
        'ChangedInput',
        input.path,
        input.origin,
        'Resolve a new supply snapshot after changing selected inputs.',
      )
  }
})

export const exists = Effect.fn('PlatformSupplyResolver.exists')(function* (
  path: string,
): Effect.fn.Return<boolean, PlatformSupply.SupplyError, FileSystem.FileSystem> {
  const fs = yield* FileSystem.FileSystem
  return yield* fs
    .exists(path)
    .pipe(Effect.mapError((cause) => storageFailure(path, 'path lookup', cause)))
})

/** Resolves one command without shell expansion, recording its actual selected executable later. */
export const executable = Effect.fn('PlatformSupplyResolver.executable')(function* (
  self: PlatformSupplyResolver,
  command: string,
): Effect.fn.Return<string, PlatformSupply.SupplyError, FileSystem.FileSystem> {
  let candidates: ReadonlyArray<string>
  if (isAbsolute(command) || command.includes('/')) candidates = [resolve(command)]
  else
    candidates = (self.environment['PATH'] ?? '')
      .split(delimiter)
      .filter(Boolean)
      .map((root) => join(root, command))
  for (const candidate of candidates) {
    if (!(yield* exists(candidate))) continue
    const fs = yield* FileSystem.FileSystem
    const info = yield* fs
      .stat(candidate)
      .pipe(Effect.mapError((cause) => storageFailure(candidate, 'tool selection', cause)))
    if ((info.mode & 0o111) === 0 && info.type !== 'SymbolicLink')
      return yield* PlatformSupply.failure(
        'MissingCapability',
        candidate,
        'tool selection',
        'Select an executable tool.',
      )
    return resolve(candidate)
  }
  return yield* PlatformSupply.failure(
    'MissingCapability',
    command,
    'tool selection',
    'Set an absolute path to an installed executable tool.',
  )
})

/** Executes an already selected command with a controlled environment and retains its whole result. */
export const query = Effect.fn('PlatformSupplyResolver.query')(function* (
  environment: Readonly<Record<string, string>>,
  command: string,
  arguments_: ReadonlyArray<string>,
  origin: string,
): Effect.fn.Return<
  PlatformSupply.Query,
  PlatformSupply.SupplyError,
  ChildProcessSpawner.ChildProcessSpawner
> {
  const result = yield* Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const child = yield* spawner.spawn(
        ChildProcess.make(command, arguments_, {
          env: { ...environment },
          extendEnv: false,
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'pipe',
        }),
      )
      const [status, stdout, stderr] = yield* Effect.all(
        [
          child.exitCode,
          Stream.mkString(Stream.decodeText(child.stdout)),
          Stream.mkString(Stream.decodeText(child.stderr)),
        ],
        { concurrency: 'unbounded' },
      )
      return { status, stdout, stderr }
    }),
  ).pipe(
    Effect.mapError(
      (cause) =>
        new PlatformSupply.SupplyError({
          operation: 'PlatformSupplyResolver.query',
          code: 'QueryFailed',
          subject: command,
          origin,
          message: `Cannot execute ${command}`,
          correction: 'Select a runnable compatible tool.',
          cause,
        }),
    ),
  )
  const value = { command, arguments: [...arguments_], ...result }
  if (result.status !== 0)
    return yield* new PlatformSupply.SupplyError({
      operation: 'PlatformSupplyResolver.query',
      code: 'QueryFailed',
      subject: command,
      origin,
      message: `Supply query failed: ${command}`,
      correction: 'Inspect the recorded tool output and correct the selected supply.',
      query: value,
    })
  return value
})

const tool = Effect.fnUntraced(function* (
  self: PlatformSupplyResolver,
  command: string,
  role: 'compiler' | 'linker' | 'archiver',
  environment: Readonly<Record<string, string>>,
  queries: Array<PlatformSupply.Query>,
  darwin = false,
): Effect.fn.Return<PlatformSupply.Tool, PlatformSupply.SupplyError, Services> {
  const path = yield* executable(self, command)
  const identity = yield* file(path, role, 'selected tool')
  // Apple ld advertises its full build identification through -v, unlike GNU/LLVM --version.
  const version = yield* query(
    environment,
    path,
    role === 'linker' && darwin && path.endsWith('/ld') ? ['-v'] : ['--version'],
    'tool version',
  )
  queries.push(version)
  return { ...identity, command: path, version: version.stdout + version.stderr }
})

export const within = (root: string, path: string): boolean => {
  const suffix = relative(root, path)
  return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`))
}

const record = (input: unknown): input is Record<string, unknown> =>
  typeof input === 'object' && input !== null && !Array.isArray(input)

export interface Options {
  readonly profile: CompilationProfile.Facts
  readonly host: Target.Id | undefined
  readonly clang: string
  readonly llvmAr: string
  readonly request?: PlatformSupply.Request
  readonly artifact?: PlatformSupply.Pin
  readonly project?: PlatformSupply.Pin
}

/** Resolves installed provider capabilities once; final inputs are resolved by NativeLinkResolver. */
export const resolveSupply = Effect.fn('PlatformSupplyResolver.resolveSupply')(function* (
  self: PlatformSupplyResolver,
  options: Options,
): Effect.fn.Return<PlatformSupply.PlatformSupply, PlatformSupply.SupplyError, Services> {
  const fs = yield* FileSystem.FileSystem
  const { profile } = options
  const selection = yield* PlatformSupply.select(
    profile.target,
    options.host,
    options.request,
    options.artifact,
    options.project,
  )
  const selected = selection.request
  if (selected.kind === 'managed')
    return yield* PlatformSupply.failure(
      'UnsupportedProvider',
      selected.name,
      selection.origin,
      'Select an installed supply.',
    )
  if (profile.target.kind !== 'Native')
    return yield* PlatformSupply.failure(
      'TargetMismatch',
      profile.target.id,
      selection.origin,
      'Use the WebAssembly toolchain.',
    )
  const explicit = selected.kind === 'explicit' ? selected : undefined
  const consulted: Record<string, string> = {}
  if (self.environment['PATH'] !== undefined) consulted['PATH'] = self.environment['PATH']
  const environment = {
    PATH: self.environment['PATH'] ?? '',
    LC_ALL: 'C',
    LANG: 'C',
  }
  const queries: Array<PlatformSupply.Query> = []
  const files: Array<PlatformSupply.File> = []
  const compiler = yield* tool(self, options.clang, 'compiler', environment, queries)
  const archiver = yield* tool(self, options.llvmAr, 'archiver', environment, queries)
  const base = ['--no-default-config', `--target=${profile.target.id}`]
  let root = explicit?.root ?? ''
  let version: string | undefined
  let deployment = profile.deployment
  const libraryRoots: Array<string> = []
  const frameworkRoots: Array<string> = []
  if (profile.target.operatingSystem === 'darwin' && profile.libc !== 'none') {
    if (explicit === undefined) {
      const sdkRoot = self.environment['SDKROOT']
      if (sdkRoot !== undefined) {
        root = sdkRoot
        consulted['SDKROOT'] = sdkRoot
      } else {
        const developer = self.environment['DEVELOPER_DIR']
        if (developer !== undefined) consulted['DEVELOPER_DIR'] = developer
        const xcrun = yield* executable(self, 'xcrun')
        files.push(yield* file(xcrun, 'support', 'SDK discovery tool'))
        const found = yield* query(
          { ...environment, ...(developer === undefined ? {} : { DEVELOPER_DIR: developer }) },
          xcrun,
          ['--sdk', 'macosx', '--show-sdk-path'],
          'native SDK discovery',
        )
        queries.push(found)
        root = found.stdout.trim()
      }
    }
    if (!isAbsolute(root) || root === '/')
      return yield* PlatformSupply.failure(
        'InvalidConfiguration',
        root,
        'SDKROOT',
        'Select an absolute macOS SDK directory.',
      )
    const metadata = yield* file(
      join(root, 'SDKSettings.json'),
      'metadata',
      explicit?.origin ?? 'SDK discovery',
    )
    files.push(metadata)
    const metadataBytes = yield* read(metadata.path, metadata.origin)
    const settings = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(
      new TextDecoder().decode(metadataBytes),
    ).pipe(
      Effect.mapError(() =>
        PlatformSupply.failure(
          'InvalidConfiguration',
          metadata.path,
          metadata.origin,
          'Select an SDK with valid SDKSettings.json.',
        ),
      ),
    )
    const targets = record(settings) ? settings['SupportedTargets'] : undefined
    const macos = record(targets) ? targets['macosx'] : undefined
    const archs = record(macos) ? macos['Archs'] : undefined
    version =
      record(settings) && typeof settings['Version'] === 'string' ? settings['Version'] : undefined
    if (
      !Array.isArray(archs) ||
      !archs.includes('arm64') ||
      version === undefined ||
      !/^\d+(?:\.\d+){0,2}$/.test(version)
    )
      return yield* PlatformSupply.failure(
        'TargetMismatch',
        metadata.path,
        metadata.origin,
        'Select an ARM64 macOS SDK.',
      )
    deployment ??= '11.0.0'
    const maximum = record(macos) ? macos['MaximumDeploymentTarget'] : undefined
    const minimum = record(macos) ? macos['MinimumDeploymentTarget'] : undefined
    if (
      PlatformSupply.compareVersions(deployment, '11.0.0') < 0 ||
      (typeof minimum === 'string' && PlatformSupply.compareVersions(deployment, minimum) < 0) ||
      PlatformSupply.compareVersions(deployment, typeof maximum === 'string' ? maximum : version) >
        0
    )
      return yield* PlatformSupply.failure(
        'DeploymentMismatch',
        deployment,
        metadata.path,
        'Choose an SDK admitting the requested ARM64 deployment; the compiler will not raise it.',
      )
    base.push('-isysroot', root, `-mmacosx-version-min=${deployment}`)
    libraryRoots.push(join(root, 'usr/lib'))
    frameworkRoots.push(join(root, 'System/Library/Frameworks'))
    const system = yield* file(
      join(root, 'usr/lib/libSystem.tbd'),
      'stub',
      'SDK libSystem contract',
    )
    const systemText = new TextDecoder().decode(yield* read(system.path, system.origin))
    if (!systemText.includes('arm64-macos') || !systemText.includes('/usr/lib/libSystem.B.dylib'))
      return yield* PlatformSupply.failure(
        'TargetMismatch',
        system.path,
        system.origin,
        'Supply the ARM64 macOS libSystem contract.',
      )
    files.push(system)
  } else if (profile.target.operatingSystem === 'linux') {
    if (explicit !== undefined) {
      if (!isAbsolute(root))
        return yield* PlatformSupply.failure(
          'InvalidConfiguration',
          root,
          explicit.origin,
          'Select an absolute sysroot directory.',
        )
      base.push(`--sysroot=${root}`)
      const gcc = explicit.support?.find(
        (installation) => installation.target === profile.target.id,
      )
      if (gcc !== undefined) base.push(`--gcc-install-dir=${gcc.root}`)
    } else {
      root = '/' // Native absolute paths are queried below; no distribution directories are assumed.
    }
    const search = yield* query(
      environment,
      compiler.command,
      [...base, '-print-search-dirs'],
      'GNU library roots',
    )
    queries.push(search)
    const libraries = /^libraries: =(.+)$/m.exec(search.stdout)?.[1]
    if (libraries !== undefined)
      libraryRoots.push(
        ...libraries
          .split(delimiter)
          .filter(Boolean)
          .map((path) => resolve(path)),
      )
  }
  if (root === '') root = '/'
  const canonicalRoot = yield* fs
    .realPath(root)
    .pipe(Effect.mapError((cause) => storageFailure(root, selection.origin, cause)))
  const installations: Array<PlatformSupply.Installation> = [
    {
      root: canonicalRoot,
      target: profile.target.id,
      origin: explicit?.origin ?? 'native platform',
    },
  ]
  for (const installation of explicit?.support ?? []) {
    if (installation.target !== profile.target.id)
      return yield* PlatformSupply.failure(
        'TargetMismatch',
        installation.root,
        installation.origin,
        `Declare support for ${profile.target.id}.`,
      )
    installations.push({
      ...installation,
      root: yield* fs
        .realPath(installation.root)
        .pipe(
          Effect.mapError((cause) => storageFailure(installation.root, installation.origin, cause)),
        ),
    })
  }
  // Compiler-owned builtin support is selected by the frozen compiler, independently of libc.
  const resource = yield* query(
    environment,
    compiler.command,
    [...base, '-print-resource-dir'],
    'compiler resource directory',
  )
  queries.push(resource)
  installations.push({
    root: resolve(resource.stdout.trim()),
    target: profile.target.id,
    origin: 'selected compiler support',
  })
  let linkerPath = explicit?.linker
  if (linkerPath === undefined) {
    const found = yield* query(
      environment,
      compiler.command,
      [...base, '-print-prog-name=ld'],
      'linker discovery',
    )
    queries.push(found)
    linkerPath = found.stdout.trim()
  }
  const linker = yield* tool(
    self,
    linkerPath,
    'linker',
    environment,
    queries,
    profile.target.operatingSystem === 'darwin',
  )
  return {
    _tag: 'PlatformSupply',
    target: profile.target,
    libc: profile.libc,
    deployment,
    selection,
    root: canonicalRoot,
    version,
    installations: installations.map((item) => item),
    compiler,
    linker,
    archiver,
    environment,
    consultedEnvironment: consulted,
    queries: queries,
    files: files,
    libraryRoots: libraryRoots,
    frameworkRoots: frameworkRoots,
    compilationArguments: base.map((argument) => {
      if (argument === root) return canonicalRoot
      if (argument === `--sysroot=${root}`) return `--sysroot=${canonicalRoot}`
      return argument
    }),
  }
})
