import { lstatSync } from 'node:fs'
import { createRequire } from 'node:module'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import type { PlatformError } from 'effect/PlatformError'
import * as Schema from 'effect/Schema'
import * as NativeProcess from './NativeProcess.ts'
import * as NativeSeed from './NativeSeed.mjs'
import * as SourceSnapshot from './SourceSnapshot.mjs'

export class NativeBuildError extends Data.TaggedError('NativeBuildError')<{
  readonly message: string
  readonly reason: 'RejectedInput' | 'ExternalFailure'
  readonly cause?: unknown
}> {}
type SnapshotReceipt = Schema.Schema.Type<typeof SourceSnapshot.InputSnapshotSchema>
interface Generation {
  generation: 'N0' | 'N1'
  path: string
  sha256: string | null
}
export interface BuildReceipt {
  schemaVersion: 1
  status: 'passed' | 'failed'
  failure: { stage: string; message: string } | null
  target: string
  profile: { optimization: string; debug: boolean }
  seed: Generation
  linker: {
    requestedPath: string
    path: string
    sha256: string
    version: string
    expected: { sha256: string; version: string }
    matchesSeed: boolean
    seedReceiptSha256: string
    seedProfile: Schema.Schema.Type<typeof NativeSeed.SeedSchema>['profile']
    linkProfile: { target: string; optimization: string; debug: boolean }
    environmentPolicy: 'standard-host-with-verified-clang'
  } | null
  output: Generation
  inputs: {
    directory: string
    sourceCommit: string
    normalizedDigest: string
    archiveSha256: string
    compiler: { sha256: string; files: SnapshotReceipt['files'] }
    stdlib: { sha256: string; files: SnapshotReceipt['files'] }
  } | null
  smoke: {
    name: 'trivial-features'
    corpusSource: string
    corpusSha256: string
    sourceSha256: string
    expectedExitCode: 42
    expectedStdout: ''
    outputSha256?: string
  } | null
  stages: (NativeProcess.Measurement & { readonly name: string })[]
}
export interface BuildOptions {
  readonly seed: string
  readonly seedReceipt: string
  readonly clang: string
  readonly environment?: Readonly<Record<string, string | undefined>> | undefined
  readonly snapshot: string
  readonly outputDirectory: string
  readonly corpusSource?: string | undefined
  readonly optimization?: string | undefined
  readonly debug?: boolean | undefined
  readonly timeCommand?: string | undefined
  readonly timeoutMs?: number | undefined
}
// Forward standard process necessities only; compiler/tool overrides come from verified inputs.
// Never serialize this environment: measurement exposes only the verified SILKC_CLANG binding.
const allowedEnvironment = ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE']
const nativeEnvironment = (
  current: Readonly<Record<string, string | undefined>>,
  clang: string,
): Readonly<Record<string, string>> => {
  const env: Record<string, string> = { SILKC_CLANG: clang }
  for (const name of allowedEnvironment) {
    const value = current[name]
    if (value !== undefined) env[name] = value
  }
  return env
}
const encodeReceipt = Effect.fnUntraced(function* (receipt: BuildReceipt) {
  return yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(receipt).pipe(
    Effect.mapError(
      (cause) =>
        new NativeBuildError({
          message: cause.message,
          reason: 'ExternalFailure',
          cause,
        }),
    ),
  )
})

const reject = (message: string) =>
  Effect.fail(new NativeBuildError({ message, reason: 'RejectedInput' }))
const within = (parent: string, path: string): boolean => {
  const child = relative(parent, path)
  return child === '' || (!child.startsWith('..') && !isAbsolute(child))
}
// FileSystem.stat follows symlinks; this boundary deliberately inspects the executable itself.
const executableInfo = Effect.fnUntraced(function* (path: string) {
  return yield* Effect.try({
    try: () => lstatSync(path),
    catch: (cause) =>
      new NativeBuildError({
        message: cause instanceof Error ? cause.message : String(cause),
        reason: 'ExternalFailure',
        cause,
      }),
  })
})
const fileHash = Effect.fnUntraced(function* (path: string) {
  const fs = yield* FileSystem.FileSystem
  return SourceSnapshot.hash(yield* fs.readFile(path))
})
const executableHash = Effect.fnUntraced(function* (path: string, immutable: boolean) {
  const stat = yield* executableInfo(path)
  if (!stat.isFile() || (stat.mode & 0o111) === 0)
    return yield* reject(`expected a regular executable, without symlinks: ${path}`)
  if (immutable && (stat.mode & 0o222) !== 0)
    return yield* reject(`native seed must have no write permission bits: ${path}`)
  return yield* fileHash(path)
})

/** Freeze the existing corpus fixture without importing the TypeScript bootstrap. */
export const smokeProgram = Effect.fn('NativeBuild.smokeProgram')(function* (corpusSource: string) {
  const fs = yield* FileSystem.FileSystem
  const bytes = yield* fs.readFile(corpusSource)
  const matches = [
    ...Buffer.from(bytes)
      .toString('utf8')
      .matchAll(/^const trivialFeatures = `([^`]*)`\n/gm),
  ]
  const source = matches[0]?.[1]
  if (matches.length !== 1 || source === undefined || /\\|\$\{/.test(source))
    return yield* reject('expected one plain, unescaped trivialFeatures corpus template')
  return { source, corpusSha256: SourceSnapshot.hash(bytes), sha256: SourceSnapshot.hash(source) }
})

const hostTarget = Effect.fnUntraced(function* () {
  if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch))
    return yield* reject(
      'native build receipts require Linux and GNU time (RSS is measured in KiB)',
    )
  return process.arch === 'arm64' ? 'aarch64-unknown-linux-gnu' : 'x86_64-unknown-linux-gnu'
})

/** One N0 build in a fresh directory, then only N1 may produce the smoke executable. */
export const buildAndSmoke = Effect.fn('NativeBuild.buildAndSmoke')(function* ({
  seed,
  seedReceipt,
  clang,
  environment = process.env,
  snapshot,
  outputDirectory,
  corpusSource = fileURLToPath(
    new URL('../../packages/compiler/test/support/corpus.ts', import.meta.url),
  ),
  optimization = 'speed',
  debug = false,
  timeCommand = '/usr/bin/time',
  timeoutMs,
}: BuildOptions): Effect.fn.Return<
  BuildReceipt,
  NativeBuildError | PlatformError,
  FileSystem.FileSystem
> {
  const fs = yield* FileSystem.FileSystem
  seed = resolve(seed)
  seedReceipt = resolve(seedReceipt)
  clang = resolve(clang)
  environment = nativeEnvironment(environment, clang)
  snapshot = resolve(snapshot)
  outputDirectory = resolve(outputDirectory)
  corpusSource = resolve(corpusSource)
  if (
    within(snapshot, outputDirectory) ||
    within(outputDirectory, snapshot) ||
    within(outputDirectory, seed)
  )
    return yield* reject('output directory must be separate from the immutable inputs')
  if (!['none', 'speed'].includes(optimization) || typeof debug !== 'boolean')
    return yield* reject('invalid native build profile')
  yield* NativeProcess.validateTimeout(timeoutMs).pipe(
    Effect.mapError(
      (error) => new NativeBuildError({ message: error.message, reason: 'RejectedInput' }),
    ),
  )
  const target = yield* hostTarget()
  // Exclusive directory creation never removes, overwrites or reuses an earlier generation.
  yield* fs.makeDirectory(outputDirectory)
  const receiptPath = join(outputDirectory, 'build-receipt.json')
  const receipt: BuildReceipt = {
    schemaVersion: 1,
    status: 'failed',
    failure: null,
    target,
    profile: { optimization, debug },
    seed: { generation: 'N0', path: seed, sha256: null },
    linker: null,
    inputs: null,
    output: { generation: 'N1', path: join(outputDirectory, 'N1'), sha256: null },
    smoke: null,
    stages: [],
  }
  let currentStage = 'inputs'
  const work = Effect.gen(function* () {
    receipt.seed.sha256 = yield* executableHash(seed, true)
    const manifest = yield* SourceSnapshot.verifySnapshot({ directory: snapshot })
    const compilerFiles = manifest.files.filter((file) => file.path.startsWith('compiler/'))
    const stdlibFiles = manifest.files.filter((file) =>
      file.path.startsWith('packages/compiler/stdlib/'),
    )
    if (compilerFiles.length === 0 || stdlibFiles.length === 0)
      return yield* reject('snapshot must account for compiler and standard-library inputs')
    receipt.inputs = {
      directory: snapshot,
      sourceCommit: manifest.sourceCommit,
      normalizedDigest: manifest.normalizedDigest,
      archiveSha256: manifest.archiveSha256,
      compiler: { sha256: manifest.compilerDigest, files: compilerFiles },
      stdlib: { sha256: manifest.stdlibDigest, files: stdlibFiles },
    }
    currentStage = 'linker-preflight'
    const seedReceiptBytes = yield* fs.readFile(seedReceipt)
    const seedReceiptSha256 = SourceSnapshot.hash(seedReceiptBytes)
    const producer = yield* Schema.decodeEffect(Schema.fromJsonString(NativeSeed.SeedSchema))(
      Buffer.from(seedReceiptBytes).toString('utf8'),
    ).pipe(
      Effect.mapError(
        (error) =>
          new NativeBuildError({
            message: error.message,
            reason: 'RejectedInput',
          }),
      ),
    )
    if (
      producer.stage !== 'N0' ||
      producer.binary.path !== 'N0' ||
      producer.binary.mode !== '0555' ||
      producer.binary.sha256 !== receipt.seed.sha256 ||
      producer.sourceCommit !== manifest.sourceCommit ||
      producer.inputSnapshot.archiveSha256 !== manifest.archiveSha256 ||
      producer.inputSnapshot.normalizedDigest !== manifest.normalizedDigest ||
      producer.inputSnapshot.compilerDigest !== manifest.compilerDigest ||
      producer.inputSnapshot.stdlibDigest !== manifest.stdlibDigest ||
      producer.bootstrap.stdlib.authority !== 'embedded-verified-main' ||
      producer.bootstrap.stdlib.normalizedDigest !== manifest.stdlibDigest ||
      producer.profile.target !== target ||
      producer.profile.name !== 'release-with-debug' ||
      producer.profile.optimization !== 'speed' ||
      producer.profile.debug !== true ||
      !/^[a-f0-9]{64}$/.test(producer.toolchain.clang.sha256) ||
      producer.toolchain.clang.version.trim() === ''
    )
      return yield* reject('native seed receipt does not bind these N0/source/tool inputs')
    const inspectClang = Effect.fnUntraced(function* () {
      const path = yield* fs.realPath(clang)
      const info = yield* fs.stat(path)
      if (info.type !== 'File' || (info.mode & 0o111) === 0)
        return yield* reject('verified clang target must be a regular executable')
      const sha256 = yield* fileHash(path)
      const result = yield* NativeProcess.execute(path, ['--version'], {
        env: nativeEnvironment(environment, path),
        timeoutMs,
      }).pipe(
        Effect.mapError(
          (error) =>
            new NativeBuildError({
              message: error.message,
              reason: 'ExternalFailure',
              cause: error,
            }),
        ),
      )
      if (result.status !== 0 || result.signal !== null || result.deadline?.expired)
        return yield* reject('cannot read verified clang version')
      const version = result.stdout.toString('utf8').trim()
      if ((yield* fileHash(path)) !== sha256 || (yield* fs.realPath(clang)) !== path)
        return yield* reject('clang changed while reading its identity')
      return { path, sha256, version }
    })
    const tool = yield* inspectClang()
    receipt.linker = {
      requestedPath: clang,
      ...tool,
      expected: producer.toolchain.clang,
      matchesSeed:
        tool.sha256 === producer.toolchain.clang.sha256 &&
        tool.version === producer.toolchain.clang.version,
      seedReceiptSha256,
      seedProfile: producer.profile,
      linkProfile: { target, optimization, debug },
      environmentPolicy: 'standard-host-with-verified-clang',
    }
    if (!receipt.linker.matchesSeed)
      return yield* reject('clang SHA256/version differs from N0 seed toolchain')
    const env = nativeEnvironment(environment, tool.path)
    const program = yield* smokeProgram(corpusSource)
    receipt.smoke = {
      name: 'trivial-features',
      corpusSource,
      corpusSha256: program.corpusSha256,
      sourceSha256: program.sha256,
      expectedExitCode: 42,
      expectedStdout: '',
    }
    const checkInputs = Effect.fnUntraced(function* () {
      if ((yield* executableHash(seed, true)) !== receipt.seed.sha256)
        return yield* reject('N0 changed during native build/smoke')
      yield* SourceSnapshot.verifySnapshot({ directory: snapshot, receipt: manifest })
      if ((yield* fileHash(seedReceipt)) !== seedReceiptSha256)
        return yield* reject('N0 seed receipt changed during native build/smoke')
      const current = yield* inspectClang()
      if (
        current.path !== tool.path ||
        current.sha256 !== tool.sha256 ||
        current.version !== tool.version
      )
        return yield* reject('verified clang changed during native build/smoke')
    })
    const invoke = Effect.fnUntraced(function* (
      name: string,
      command: ReadonlyArray<string>,
      cwd: string,
    ) {
      currentStage = name
      yield* checkInputs()
      const evidence = yield* NativeProcess.run({
        command,
        cwd,
        resourceFile: join(outputDirectory, `${name}-rss.txt`),
        timeCommand,
        env,
        timeoutMs,
      })
      const result = evidence.measurement
      // Keep actual stage facts even if writing its completed evidence or postflight fails.
      receipt.stages.push({ name, ...result })
      yield* fs.writeFile(join(outputDirectory, `${name}-stdout.bin`), evidence.raw.stdout, {
        flag: 'wx',
      })
      yield* fs.writeFile(join(outputDirectory, `${name}-stderr.bin`), evidence.raw.stderr, {
        flag: 'wx',
      })
      const sidecar = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
        deadline: evidence.deadline,
        resources: {
          path: evidence.resources.path,
          present: evidence.resources.bytes !== null,
          error: evidence.resources.error,
        },
      }).pipe(
        Effect.mapError(
          (cause) =>
            new NativeBuildError({ message: cause.message, reason: 'ExternalFailure', cause }),
        ),
      )
      yield* fs.writeFileString(
        join(outputDirectory, `${name}-process-evidence.json`),
        `${sidecar}\n`,
        { flag: 'wx' },
      )
      yield* checkInputs()
      return result
    })
    const stdlib = join(snapshot, 'packages/compiler/stdlib')
    const argumentsFor = (source: string, output: string): ReadonlyArray<string> => [
      'build',
      source,
      '-o',
      output,
      '--stdlib',
      stdlib,
      '--optimization',
      optimization,
      '--debug',
      String(debug),
    ]
    const built = yield* invoke(
      'native-build',
      [seed, ...argumentsFor(join(snapshot, 'compiler/src/main.silk'), receipt.output.path)],
      join(snapshot, 'compiler'),
    )
    if (!NativeProcess.succeeded(built)) return yield* reject('N0 native build failed')
    receipt.output.sha256 = yield* executableHash(receipt.output.path, false)
    const seedStat = yield* executableInfo(seed)
    const outputStat = yield* executableInfo(receipt.output.path)
    if (seedStat.dev === outputStat.dev && seedStat.ino === outputStat.ino)
      return yield* reject('N1 must be newly produced, not a hard link to N0')
    yield* fs.chmod(receipt.output.path, outputStat.mode & ~0o222)
    const smokeDirectory = join(outputDirectory, 'smoke')
    yield* fs.makeDirectory(smokeDirectory)
    const smokeSource = join(smokeDirectory, 'main.silk')
    const smokeBinary = join(smokeDirectory, 'program')
    yield* fs.writeFileString(smokeSource, program.source, { flag: 'wx' })
    yield* fs.writeFileString(
      join(smokeDirectory, 'silk.toml'),
      '[package]\nname = "trivial-features"\nroot = "main.silk"\n',
      { flag: 'wx' },
    )
    const smokeBuilt = yield* invoke(
      'smoke-build',
      [receipt.output.path, ...argumentsFor(smokeSource, smokeBinary)],
      smokeDirectory,
    )
    if (!NativeProcess.succeeded(smokeBuilt)) return yield* reject('N1 smoke compilation failed')
    receipt.smoke.outputSha256 = yield* executableHash(smokeBinary, false)
    const ran = yield* invoke('smoke-run', [smokeBinary], smokeDirectory)
    if (ran.error !== null || ran.signal !== null || ran.exitCode !== 42 || ran.stdout !== '')
      return yield* reject('trivial-features exit/stdout mismatch')
    if ((yield* executableHash(receipt.output.path, true)) !== receipt.output.sha256)
      return yield* reject('N1 changed during smoke')
    if (
      (yield* fileHash(smokeSource)) !== receipt.smoke.sourceSha256 ||
      (yield* fileHash(smokeBinary)) !== receipt.smoke.outputSha256
    )
      return yield* reject('smoke input/output changed during execution')
    receipt.status = 'passed'
  })
  yield* work.pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        receipt.failure = { stage: currentStage, message: error.message }
      }),
    ),
  )
  yield* fs.writeFileString(receiptPath, `${yield* encodeReceipt(receipt)}\n`, { flag: 'wx' })
  return receipt
})

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const cli = Effect.gen(function* () {
    const { values } = yield* Effect.try({
      try: () =>
        parseArgs({
          options: {
            seed: { type: 'string' },
            'seed-receipt': { type: 'string' },
            clang: { type: 'string' },
            snapshot: { type: 'string' },
            output: { type: 'string' },
            'corpus-source': { type: 'string' },
            optimization: { type: 'string', default: 'speed' },
            debug: { type: 'boolean', default: false },
            'time-command': { type: 'string', default: '/usr/bin/time' },
            'timeout-ms': { type: 'string' },
          },
        }),
      catch: (cause) =>
        new NativeBuildError({
          message: cause instanceof Error ? cause.message : String(cause),
          reason: 'ExternalFailure',
          cause,
        }),
    })
    if (
      !values.seed ||
      !values['seed-receipt'] ||
      !values.clang ||
      !values.snapshot ||
      !values.output
    )
      return yield* reject(
        'usage: node compiler/scripts/NativeBuild.ts --seed /immutable/N0 --seed-receipt /immutable/seed-receipt.json --clang /verified/clang --snapshot /snapshot --output /fresh/run',
      )
    const receipt = yield* buildAndSmoke({
      seed: values.seed,
      seedReceipt: values['seed-receipt'],
      clang: values.clang,
      snapshot: values.snapshot,
      outputDirectory: values.output,
      corpusSource: values['corpus-source'],
      optimization: values.optimization,
      debug: values.debug,
      timeCommand: values['time-command'],
      timeoutMs: values['timeout-ms'] === undefined ? undefined : Number(values['timeout-ms']),
    })
    const encoded = yield* encodeReceipt(receipt)
    yield* Effect.sync(() => {
      process.stdout.write(`${encoded}\n`)
      process.exitCode = receipt.status === 'passed' ? 0 : 1
    })
  })
  const require = createRequire(new URL('../../packages/cli/package.json', import.meta.url))
  const {
    NodeServices,
  }: typeof import('../../packages/cli/node_modules/@effect/platform-node/dist/index.js') =
    await import(pathToFileURL(require.resolve('@effect/platform-node')).href)
  await Effect.runPromise(
    cli.pipe(
      Effect.provide(NodeServices.layer),
      Effect.catch((error) =>
        Effect.sync(() => {
          process.stderr.write(`${error.message}\n`)
          process.exitCode = 1
        }),
      ),
    ),
  )
}
