// The native seed chain's pin, its verified seed, and the bootstrap N0 used only to re-seed.
// A bootstrap's embedded stdlib must match the authored snapshot byte for byte.
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
import { committedFiles, fileDigest, hash, verifySnapshot } from './SourceSnapshot.mjs'

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

export const seedAsset = 'silk-compiler-x86_64-unknown-linux-gnu'
const Hex = (length) => Schema.String.check(Schema.isPattern(new RegExp(`^[a-f0-9]{${length}}$`)))
/** `compiler/native-seed.json`: the only authority for the compiler that builds N1. */
export const PinSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  seed: Schema.Union([
    Schema.TaggedStruct('Release', {
      target: Schema.Literal('x86_64-unknown-linux-gnu'),
      tag: Schema.String.check(Schema.isPattern(/^native-seed-[a-f0-9]{40}$/)),
      asset: Schema.Literal(seedAsset),
      sha256: Hex(64),
      sourceCommit: Hex(40),
      runId: Schema.String.check(Schema.isPattern(/^\d+$/)),
    }),
    Schema.TaggedStruct('Bootstrap', { reason: Schema.NonEmptyString }),
  ]),
})
const encodePin = Schema.encodeEffect(Schema.fromJsonString(PinSchema))

export const readPin = Effect.fn('NativeSeed.readPin')(
  /** @param {string} path */
  function* (path) {
    const fs = yield* FileSystem.FileSystem
    const pin = yield* Schema.decodeEffect(Schema.fromJsonString(PinSchema))(
      yield* fs.readFileString(path),
    )
    if (pin.seed._tag === 'Release' && pin.seed.tag !== `native-seed-${pin.seed.sourceCommit}`)
      return yield* invalid('Native seed tag must name its source commit')
    return pin
  },
)

/** Checks downloaded bytes against the pin before they become an executable. */
export const verifySeed = Effect.fn('NativeSeed.verifySeed')(
  /** @param {{pin:string,download:string,destination:string}} options */
  function* ({ pin: pinPath, download, destination }) {
    const fs = yield* FileSystem.FileSystem
    const pin = yield* readPin(pinPath)
    if (pin.seed._tag !== 'Release') return yield* invalid('Only a Release pin names a download')
    const bytes = yield* fs.readFile(download)
    if (hash(bytes) !== pin.seed.sha256)
      return yield* invalid(
        `Downloaded seed SHA-256 ${hash(bytes)} differs from pinned ${pin.seed.sha256}`,
      )
    if (yield* fs.exists(destination)) return yield* invalid('Seed destination must be fresh')
    yield* fs.writeFile(destination, bytes, { flag: 'wx', mode: 0o555 })
    yield* fs.chmod(destination, 0o555)
    if (hash(yield* fs.readFile(destination)) !== pin.seed.sha256)
      return yield* invalid('Seed changed while it was installed')
    return pin
  },
)

/** The ready-to-commit pin for a published fixpoint compiler; publication never commits it. */
export const candidate = Effect.fn('NativeSeed.candidate')(
  /** @param {{sha256:string,sourceCommit:string,runId:string}} options */
  function* ({ sha256, sourceCommit, runId }) {
    const pin = {
      schemaVersion: 1,
      seed: {
        _tag: 'Release',
        target: 'x86_64-unknown-linux-gnu',
        tag: `native-seed-${sourceCommit}`,
        asset: seedAsset,
        sha256,
        sourceCommit,
        runId,
      },
    }
    return yield* Schema.decodeUnknownEffect(PinSchema)(pin)
  },
)

const BuildReceiptSchema = Schema.Struct({
  status: Schema.Literal('passed'),
  output: Schema.Struct({ generation: Schema.String, sha256: Hex(64) }),
  inputs: Schema.Struct({ sourceCommit: Hex(40) }),
  fixpoint: Schema.Struct({ producerIrSha256: Hex(64), outputIrSha256: Hex(64) }),
})

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, first, second, third] = process.argv.slice(2)
  const require = createRequire(new URL('../../packages/cli/package.json', import.meta.url))
  /** @type {{ NodeServices: {layer: import('effect/Layer').Layer<import('effect/FileSystem').FileSystem>} }} */
  const { NodeServices } = await import(
    pathToFileURL(require.resolve('@effect/platform-node')).href
  )
  const printPin = (pin) => Effect.flatMap(encodePin(pin), Console.log)
  let program
  if (command === 'build' && first && second && !third)
    program = Effect.gen(function* () {
      const receipt = yield* buildSeed({
        snapshot: resolve(first),
        artifact: resolve(second),
        bootstrap: yield* Config.String('SILK_BOOTSTRAP'),
        bootstrapCommit: yield* Config.String('BOOTSTRAP_SHA'),
        bootstrapRun: yield* Config.String('BOOTSTRAP_RUN'),
        clang: yield* Config.String('SILK_TEST_CLANG'),
        llvmAr: yield* Config.String('SILK_TEST_LLVM_AR'),
      })
      yield* Console.log(yield* Schema.encodeEffect(Schema.fromJsonString(SeedSchema))(receipt))
    })
  // GitHub step outputs: the seed kind, and the release coordinates of a Release pin.
  else if (command === 'outputs' && first && !second)
    program = Effect.gen(function* () {
      const { seed } = yield* readPin(resolve(first))
      yield* Console.log(`kind=${seed._tag}`)
      if (seed._tag === 'Release')
        yield* Console.log(`tag=${seed.tag}\nasset=${seed.asset}\nsha256=${seed.sha256}`)
    })
  else if (command === 'verify' && first && second && third)
    program = Effect.flatMap(
      verifySeed({
        pin: resolve(first),
        download: resolve(second),
        destination: resolve(third),
      }),
      printPin,
    )
  else if (command === 'candidate' && first && second && !third)
    program = Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const receipt = yield* Schema.decodeEffect(Schema.fromJsonString(BuildReceiptSchema))(
        yield* fs.readFileString(resolve(first)),
      )
      if (receipt.fixpoint.producerIrSha256 !== receipt.fixpoint.outputIrSha256)
        return yield* invalid('A seed candidate requires an IR fixpoint')
      yield* printPin(
        yield* candidate({
          sha256: receipt.output.sha256,
          sourceCommit: receipt.inputs.sourceCommit,
          runId: second,
        }),
      )
    })
  else
    program = invalid(
      'usage: node NativeSeed.mjs build <snapshot> <artifact> | outputs <pin> | verify <pin> <download> <destination> | candidate <fixpoint-build-receipt> <run-id>',
    )
  await Effect.runPromise(program.pipe(Effect.provide(NodeServices.layer)))
}
