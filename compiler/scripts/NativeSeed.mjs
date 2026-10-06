// The seed's embedded stdlib must match the authored snapshot byte for byte.
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Schema from 'effect/Schema'
import * as Console from 'effect/Console'
import * as Config from 'effect/Config'
import * as NativeProcess from './NativeProcess.ts'
import {
  InputSnapshotSchema,
  committedFiles,
  fileDigest,
  hash,
  restoreSnapshot,
  verifySnapshot,
} from './SourceSnapshot.mjs'

export class NativeSeedError extends Data.TaggedError('NativeSeedError') {}
const invalid = (message) => Effect.fail(new NativeSeedError({ message }))
const ToolSchema = Schema.Struct({ sha256: Schema.String, version: Schema.String })
export const SeedSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  stage: Schema.String,
  sourceCommit: Schema.String,
  binary: Schema.Struct({ path: Schema.String, sha256: Schema.String, mode: Schema.String }),
  inputSnapshot: Schema.Struct({
    archiveSha256: Schema.String,
    normalizedDigest: Schema.String,
    compilerDigest: Schema.String,
    stdlibDigest: Schema.String,
  }),
  bootstrap: Schema.Struct({
    commit: Schema.String,
    runId: Schema.String,
    sha256: Schema.String,
    stdlib: Schema.Struct({ authority: Schema.String, normalizedDigest: Schema.String }),
  }),
  toolchain: Schema.Struct({ clang: ToolSchema, llvmAr: ToolSchema }),
  profile: Schema.Struct({
    target: Schema.String,
    name: Schema.String,
    optimization: Schema.String,
    debug: Schema.Boolean,
  }),
  command: Schema.Array(Schema.String),
})
const json = Schema.decodeEffect(Schema.fromJsonString(SeedSchema))
export const verifyBootstrapStdlib = Effect.fn('NativeSeed.verifyBootstrapStdlib')(
  /** @param {{repository:string,bootstrapCommit:string,snapshotReceipt:import('./SourceSnapshot.mjs').SnapshotReceipt}} options */
  function* ({ repository, bootstrapCommit, snapshotReceipt }) {
    if (!/^[a-f0-9]{40}$/.test(bootstrapCommit))
      return yield* invalid('Bootstrap requires an exact verified main SHA')
    const files = (yield* committedFiles(repository, bootstrapCommit, [
      'packages/compiler/stdlib',
    ])).map(({ object: _object, ...file }) => file)
    if (fileDigest(files) !== snapshotReceipt.stdlibDigest)
      return yield* invalid(
        'Verified bootstrap embedded stdlib differs from authored snapshot; sync main before publishing N0',
      )
    return { authority: 'embedded-verified-main', normalizedDigest: fileDigest(files) }
  },
)

export const buildSeed = Effect.fn('NativeSeed.buildSeed')(
  /** @param {{repository?:string,snapshot:string,artifact:string,bootstrap:string,bootstrapCommit:string,bootstrapRun:string,clang:string,llvmAr:string}} options */
  function* ({
    repository = '.',
    snapshot,
    artifact,
    bootstrap,
    bootstrapCommit,
    bootstrapRun,
    clang,
    llvmAr,
  }) {
    const fs = yield* FileSystem.FileSystem
    const inputs = yield* verifySnapshot({ directory: snapshot })
    if (!/^\d+$/.test(bootstrapRun) || !bootstrap || !clang || !llvmAr)
      return yield* invalid('Missing verified bootstrap or toolchain inputs')
    const stdlib = yield* verifyBootstrapStdlib({
      repository,
      bootstrapCommit,
      snapshotReceipt: inputs,
    })
    const tool = Effect.fnUntraced(
      /** @param {string} path */
      function* (path) {
        const info = yield* fs.stat(path)
        if (info.type !== 'File' || (info.mode & 0o111) === 0)
          return yield* invalid(`Tool is not executable: ${path}`)
        const result = yield* NativeProcess.execute(path, ['--version'])
        if (result.status !== 0 || result.signal !== null)
          return yield* invalid(`Cannot read toolchain version: ${path}`)
        return { sha256: hash(yield* fs.readFile(path)), version: result.stdout.toString().trim() }
      },
    )
    const toolchain = { clang: yield* tool(clang), llvmAr: yield* tool(llvmAr) }
    const bootstrapSha256 = hash(yield* fs.readFile(bootstrap))
    const binary = join(
      snapshot,
      'compiler/build/llvm/x86_64-unknown-linux-gnu/release-with-debug/silk-compiler',
    )
    if (yield* fs.exists(join(snapshot, 'compiler/build')))
      return yield* invalid('Native seed build requires a fresh snapshot without build outputs')
    if (yield* fs.exists(artifact))
      return yield* invalid('Native seed artifact destination must be fresh')
    const args = [
      resolve(bootstrap),
      'build',
      '--manifest-path',
      'compiler/silk.toml',
      '--optimization',
      'release-with-debug',
    ]
    const result = yield* NativeProcess.execute(process.execPath, args, {
      cwd: snapshot,
      stdio: 'inherit',
      env: { ...process.env, SILK_TEST_CLANG: resolve(clang), SILK_TEST_LLVM_AR: resolve(llvmAr) },
    })
    if (result.status !== 0 || result.signal !== null)
      return yield* invalid(`Native seed build failed: ${result.status}`)
    yield* verifySnapshot({ directory: snapshot })
    const info = yield* fs.stat(binary)
    if (info.type !== 'File' || info.size === 0n || (info.mode & 0o111) === 0)
      return yield* invalid('Bootstrap did not produce executable N0')
    yield* fs.makeDirectory(artifact, { recursive: true })
    yield* fs.copyFile(binary, join(artifact, 'N0'))
    yield* fs.chmod(join(artifact, 'N0'), 0o555)
    for (const file of ['authored-inputs.tar', 'input-snapshot.json'])
      yield* fs.copyFile(join(snapshot, file), join(artifact, file))
    const receipt = {
      schemaVersion: 1,
      stage: 'N0',
      sourceCommit: inputs.sourceCommit,
      binary: { path: 'N0', sha256: hash(yield* fs.readFile(binary)), mode: '0555' },
      inputSnapshot: {
        archiveSha256: inputs.archiveSha256,
        normalizedDigest: inputs.normalizedDigest,
        compilerDigest: inputs.compilerDigest,
        stdlibDigest: inputs.stdlibDigest,
      },
      bootstrap: { commit: bootstrapCommit, runId: bootstrapRun, sha256: bootstrapSha256, stdlib },
      toolchain,
      profile: {
        target: 'x86_64-unknown-linux-gnu',
        name: 'release-with-debug',
        optimization: 'speed',
        debug: true,
      },
      command: [process.execPath, ...args],
    }
    yield* fs.writeFileString(
      join(artifact, 'seed-receipt.json'),
      (yield* Schema.encodeEffect(Schema.fromJsonString(SeedSchema))(receipt)) + '\n',
    )
    return receipt
  },
)

export const restoreSeed = Effect.fn('NativeSeed.restoreSeed')(
  /** @param {{artifact:string,directory:string}} options */
  function* ({ artifact, directory }) {
    const fs = yield* FileSystem.FileSystem
    const seed = yield* json(yield* fs.readFileString(join(artifact, 'seed-receipt.json')))
    const inputs = yield* Schema.decodeEffect(Schema.fromJsonString(InputSnapshotSchema))(
      yield* fs.readFileString(join(artifact, 'input-snapshot.json')),
    )
    if (
      seed.schemaVersion !== 1 ||
      seed.stage !== 'N0' ||
      seed.sourceCommit !== inputs.sourceCommit ||
      seed.binary?.path !== 'N0' ||
      seed.binary.mode !== '0555' ||
      hash(yield* fs.readFile(join(artifact, 'N0'))) !== seed.binary.sha256 ||
      seed.inputSnapshot?.archiveSha256 !== inputs.archiveSha256 ||
      seed.inputSnapshot.normalizedDigest !== inputs.normalizedDigest ||
      seed.inputSnapshot.compilerDigest !== inputs.compilerDigest ||
      seed.inputSnapshot.stdlibDigest !== inputs.stdlibDigest ||
      seed.bootstrap?.stdlib?.authority !== 'embedded-verified-main' ||
      seed.bootstrap.stdlib.normalizedDigest !== inputs.stdlibDigest
    )
      return yield* invalid('Native seed receipt mismatch')
    yield* restoreSnapshot({ artifact, directory })
    yield* fs.copyFile(join(artifact, 'N0'), join(directory, 'N0'))
    yield* fs.chmod(join(directory, 'N0'), 0o555)
    const info = yield* fs.stat(join(directory, 'N0'))
    if (
      (info.mode & 0o777) !== 0o555 ||
      hash(yield* fs.readFile(join(directory, 'N0'))) !== seed.binary.sha256
    )
      return yield* invalid('N0 executable restoration failed')
    yield* fs.copyFile(join(artifact, 'seed-receipt.json'), join(directory, 'seed-receipt.json'))
    return seed
  },
)

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, first, second] = process.argv.slice(2)
  const require = createRequire(new URL('../../packages/cli/package.json', import.meta.url))
  /** @type {{ NodeServices: {layer: import('effect/Layer').Layer<import('effect/FileSystem').FileSystem>} }} */
  const { NodeServices } = await import(
    pathToFileURL(require.resolve('@effect/platform-node')).href
  )
  let program
  if (command === 'build' && first && second)
    program = Effect.gen(function* () {
      return yield* buildSeed({
        snapshot: resolve(first),
        artifact: resolve(second),
        bootstrap: yield* Config.String('SILK_BOOTSTRAP'),
        bootstrapCommit: yield* Config.String('BOOTSTRAP_SHA'),
        bootstrapRun: yield* Config.String('BOOTSTRAP_RUN'),
        clang: yield* Config.String('SILK_TEST_CLANG'),
        llvmAr: yield* Config.String('SILK_TEST_LLVM_AR'),
      })
    })
  else if (command === 'restore' && first && second)
    program = restoreSeed({ artifact: resolve(first), directory: resolve(second) })
  else
    program = invalid(
      'usage: node NativeSeed.mjs <build|restore> <snapshot|artifact> <artifact|destination>',
    )
  await Effect.runPromise(
    program.pipe(
      Effect.flatMap((receipt) => Schema.encodeEffect(Schema.fromJsonString(SeedSchema))(receipt)),
      Effect.flatMap(Console.log),
      Effect.provide(NodeServices.layer),
    ),
  )
}
