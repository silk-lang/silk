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
import * as SourceSnapshot from './SourceSnapshot.mjs'

export class NativeBuildError extends Data.TaggedError('NativeBuildError')<{
  readonly message: string
  readonly reason: 'RejectedInput' | 'ExternalFailure'
  readonly cause?: unknown
}> {}
type SnapshotReceipt = Schema.Schema.Type<typeof SourceSnapshot.InputSnapshotSchema>
interface Generation {
  generation: string
  path: string
  sha256: string | null
}
export interface BuildReceipt {
  schemaVersion: 1
  status: 'passed' | 'failed'
  failure: { stage: string; message: string } | null
  target: string
  profile: { optimization: string; debug: boolean }
  producer: Generation
  linker: {
    requestedPath: string
    path: string
    sha256: string
    version: string
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
  /** Both generations emit the compiler's LLVM IR; a self-hosting chain requires equal bytes. */
  fixpoint: { producerIrSha256: string | null; outputIrSha256: string | null } | null
  stages: (NativeProcess.Measurement & { readonly name: string })[]
}
export interface BuildOptions {
  /** The compiler that builds the next generation; it must match `producerSha256` exactly. */
  readonly producer: string
  readonly producerSha256: string
  readonly producerGeneration: string
  readonly generation: string
  readonly clang: string
  readonly environment?: Readonly<Record<string, string | undefined>> | undefined
  readonly snapshot: string
  readonly outputDirectory: string
  readonly corpusSource?: string | undefined
  readonly optimization?: string | undefined
  readonly debug?: boolean | undefined
  readonly fixpoint?: boolean | undefined
  readonly timeCommand?: string | undefined
  readonly timeoutMs?: number | undefined
}
// Forward standard process necessities only; compiler/tool overrides come from verified inputs.
// Never serialize this environment: measurement exposes only the verified SILKC_CLANG binding.
const allowedEnvironment = [
  'PATH',
  'SDKROOT',
  'HOME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
]
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
    return yield* reject(`producer compiler must have no write permission bits: ${path}`)
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

/**
 * One producer build of the next generation in a fresh directory. Only the new generation may
 * produce the smoke executable. With `fixpoint`, the producer and the new generation each emit the
 * compiler's LLVM IR and the bytes must be identical; the producer's emission runs beside the
 * build.
 */
export const buildAndSmoke = Effect.fn('NativeBuild.buildAndSmoke')(function* ({
  producer,
  producerSha256,
  producerGeneration,
  generation,
  clang,
  environment = process.env,
  snapshot,
  outputDirectory,
  corpusSource = fileURLToPath(
    new URL('../../packages/compiler/test/support/corpus.ts', import.meta.url),
  ),
  optimization = 'speed',
  debug = false,
  fixpoint = false,
  timeCommand = '/usr/bin/time',
  timeoutMs,
}: BuildOptions): Effect.fn.Return<
  BuildReceipt,
  NativeBuildError | PlatformError,
  FileSystem.FileSystem
> {
  const fs = yield* FileSystem.FileSystem
  producer = resolve(producer)
  clang = resolve(clang)
  environment = nativeEnvironment(environment, clang)
  snapshot = resolve(snapshot)
  outputDirectory = resolve(outputDirectory)
  corpusSource = resolve(corpusSource)
  if (
    within(snapshot, outputDirectory) ||
    within(outputDirectory, snapshot) ||
    within(outputDirectory, producer)
  )
    return yield* reject('output directory must be separate from the immutable inputs')
  if (!['none', 'speed'].includes(optimization) || typeof debug !== 'boolean')
    return yield* reject('invalid native build profile')
  if (!/^[a-f0-9]{64}$/.test(producerSha256))
    return yield* reject('producer SHA-256 must be 64 lowercase hex digits')
  if (!/^[A-Za-z0-9-]+$/.test(generation) || generation === producerGeneration)
    return yield* reject('generation names must be distinct path-safe labels')
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
    producer: { generation: producerGeneration, path: producer, sha256: null },
    linker: null,
    inputs: null,
    output: { generation, path: join(outputDirectory, generation), sha256: null },
    smoke: null,
    fixpoint: fixpoint ? { producerIrSha256: null, outputIrSha256: null } : null,
    stages: [],
  }
  // Concurrent stages record the first one that failed, not the last one started.
  let failedStage: string | null = null
  const staged =
    (name: string) =>
    <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
      self.pipe(
        Effect.tapError(() =>
          Effect.sync(() => {
            failedStage ??= name
          }),
        ),
      )
  const work = Effect.gen(function* () {
    const manifest = yield* Effect.gen(function* () {
      receipt.producer.sha256 = yield* executableHash(producer, true)
      if (receipt.producer.sha256 !== producerSha256)
        return yield* reject(`${producerGeneration} SHA-256 differs from its verified identity`)
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
      return manifest
    }).pipe(staged('inputs'))
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
    const tool = yield* inspectClang().pipe(staged('linker-preflight'))
    receipt.linker = {
      requestedPath: clang,
      ...tool,
      environmentPolicy: 'standard-host-with-verified-clang',
    }
    const env = nativeEnvironment(environment, tool.path)
    const program = yield* smokeProgram(corpusSource).pipe(staged('inputs'))
    const smoke = {
      name: 'trivial-features',
      corpusSource,
      corpusSha256: program.corpusSha256,
      sourceSha256: program.sha256,
      expectedExitCode: 42,
      expectedStdout: '',
    } as const
    receipt.smoke = { ...smoke }
    const checkInputs = Effect.fnUntraced(function* () {
      if ((yield* executableHash(producer, true)) !== producerSha256)
        return yield* reject(`${producerGeneration} changed during native build/smoke`)
      yield* SourceSnapshot.verifySnapshot({ directory: snapshot, receipt: manifest })
      const current = yield* inspectClang()
      if (
        current.path !== tool.path ||
        current.sha256 !== tool.sha256 ||
        current.version !== tool.version
      )
        return yield* reject('verified clang changed during native build/smoke')
    })
    const invoke = (name: string, command: ReadonlyArray<string>, cwd: string) =>
      Effect.gen(function* () {
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
    const compilerRoot = join(snapshot, 'compiler/src/main.silk')
    const argumentsFor = (
      source: string,
      output: string,
      emit: 'executable' | 'llvm-ir',
    ): ReadonlyArray<string> => [
      'build',
      source,
      '-o',
      output,
      '--emit',
      emit,
      '--stdlib',
      stdlib,
      '--optimization',
      optimization,
      '--debug',
      String(debug),
    ]
    const emitIr = (name: string, compiler: string) =>
      Effect.gen(function* () {
        const ir = join(outputDirectory, `${name}.ll`)
        const emitted = yield* invoke(
          name,
          [compiler, ...argumentsFor(compilerRoot, ir, 'llvm-ir')],
          join(snapshot, 'compiler'),
        )
        if (!NativeProcess.succeeded(emitted)) return yield* reject(`${name} emission failed`)
        return yield* fileHash(ir)
      }).pipe(staged(name))
    const build = Effect.gen(function* () {
      const built = yield* invoke(
        'native-build',
        [producer, ...argumentsFor(compilerRoot, receipt.output.path, 'executable')],
        join(snapshot, 'compiler'),
      )
      if (!NativeProcess.succeeded(built))
        return yield* reject(`${producerGeneration} native build failed`)
      receipt.output.sha256 = yield* executableHash(receipt.output.path, false)
      const producerStat = yield* executableInfo(producer)
      const outputStat = yield* executableInfo(receipt.output.path)
      if (producerStat.dev === outputStat.dev && producerStat.ino === outputStat.ino)
        return yield* reject(`${generation} must be newly produced, not a hard link`)
      yield* fs.chmod(receipt.output.path, outputStat.mode & ~0o222)
    }).pipe(staged('native-build'))
    const producerIr = `${producerGeneration}-ir`
    if (receipt.fixpoint) {
      const [, producerIrSha256] = yield* Effect.all([build, emitIr(producerIr, producer)], {
        concurrency: 2,
      })
      receipt.fixpoint.producerIrSha256 = producerIrSha256
    } else yield* build
    const output = receipt.output.path
    const outputSha256 = receipt.output.sha256 ?? (yield* reject(`${generation} has no identity`))
    const smokeDirectory = join(outputDirectory, 'smoke')
    const smokeSource = join(smokeDirectory, 'main.silk')
    const smokeBinary = join(smokeDirectory, 'program')
    const smokeOutput = yield* Effect.gen(function* () {
      yield* fs.makeDirectory(smokeDirectory)
      yield* fs.writeFileString(smokeSource, program.source, { flag: 'wx' })
      yield* fs.writeFileString(
        join(smokeDirectory, 'silk.toml'),
        '[package]\nname = "trivial-features"\nroot = "main.silk"\n',
        { flag: 'wx' },
      )
      const smokeBuilt = yield* invoke(
        'smoke-build',
        [output, ...argumentsFor(smokeSource, smokeBinary, 'executable')],
        smokeDirectory,
      )
      if (!NativeProcess.succeeded(smokeBuilt))
        return yield* reject(`${generation} smoke compilation failed`)
      return yield* executableHash(smokeBinary, false)
    }).pipe(staged('smoke-build'))
    receipt.smoke = { ...smoke, outputSha256: smokeOutput }
    yield* Effect.gen(function* () {
      const ran = yield* invoke('smoke-run', [smokeBinary], smokeDirectory)
      if (ran.error !== null || ran.signal !== null || ran.exitCode !== 42 || ran.stdout !== '')
        return yield* reject('trivial-features exit/stdout mismatch')
      if ((yield* executableHash(output, true)) !== outputSha256)
        return yield* reject(`${generation} changed during smoke`)
      if (
        (yield* fileHash(smokeSource)) !== smoke.sourceSha256 ||
        (yield* fileHash(smokeBinary)) !== smokeOutput
      )
        return yield* reject('smoke input/output changed during execution')
    }).pipe(staged('smoke-run'))
    if (receipt.fixpoint) {
      const outputIrSha256 = yield* emitIr(`${generation}-ir`, output)
      receipt.fixpoint.outputIrSha256 = outputIrSha256
      if (outputIrSha256 !== receipt.fixpoint.producerIrSha256)
        return yield* reject(
          `${producerGeneration} and ${generation} emitted different compiler LLVM IR`,
        ).pipe(staged('fixpoint'))
      if ((yield* executableHash(output, true)) !== outputSha256)
        return yield* reject(`${generation} changed during IR emission`).pipe(staged('fixpoint'))
    }
    receipt.status = 'passed'
  })
  yield* work.pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        receipt.failure = { stage: failedStage ?? 'inputs', message: error.message }
      }),
    ),
  )
  yield* fs.writeFileString(receiptPath, `${yield* encodeReceipt(receipt)}\n`, { flag: 'wx' })
  return receipt
})

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const usage =
    'usage: node compiler/scripts/NativeBuild.ts --producer /immutable/compiler --producer-sha256 <hex> --producer-generation seed --generation N1 [--fixpoint] --clang /verified/clang --snapshot /snapshot --output /fresh/run'
  const cli = Effect.gen(function* () {
    const { values } = yield* Effect.try({
      try: () =>
        parseArgs({
          options: {
            producer: { type: 'string' },
            'producer-sha256': { type: 'string' },
            'producer-generation': { type: 'string' },
            generation: { type: 'string' },
            fixpoint: { type: 'boolean', default: false },
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
      !values.producer ||
      !values['producer-sha256'] ||
      !values['producer-generation'] ||
      !values.generation ||
      !values.clang ||
      !values.snapshot ||
      !values.output
    )
      return yield* reject(usage)
    const receipt = yield* buildAndSmoke({
      producer: values.producer,
      producerSha256: values['producer-sha256'],
      producerGeneration: values['producer-generation'],
      generation: values.generation,
      fixpoint: values.fixpoint,
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
