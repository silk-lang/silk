import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Result from 'effect/Result'
import * as NativeProcess from './NativeProcess.ts'
import { buildSeed, restoreSeed, verifyBootstrapStdlib } from './NativeSeed.mjs'
import { createSnapshot, verifySnapshot } from './SourceSnapshot.mjs'

const require = createRequire(new URL('../../packages/compiler/package.json', import.meta.url))
/** @type {{ NodeServices: {layer: import('effect/Layer').Layer<import('effect/FileSystem').FileSystem>} }} */
/** @type {{ NodeServices: {layer: import('effect/Layer').Layer<import('effect/FileSystem').FileSystem>} }} */
const { NodeServices } = await import(pathToFileURL(require.resolve('@effect/platform-node')).href)
const main = 'import nested.Dependency\nimport silk.i32\nfn main() -> i32 { return 42 }\n'
const fixture = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem
  const temporary = yield* fs.makeTempDirectoryScoped({ prefix: 'silk-authored-seed-' })
  const repository = join(temporary, 'repository')
  yield* fs.makeDirectory(repository)
  const put = Effect.fnUntraced(
    /** @param {string} path @param {string} text */
    function* (path, text) {
      yield* fs.makeDirectory(join(repository, path, '..'), { recursive: true })
      yield* fs.writeFileString(join(repository, path), text)
    },
  )
  yield* put('compiler/silk.toml', '[package]\nname = "silk-compiler"\nroot = "src/main.silk"\n')
  yield* put('compiler/src/main.silk', main)
  yield* put('compiler/src/nested/Dependency.silk', 'pub fn value() -> i32 { return 1 }\n')
  yield* put('packages/compiler/stdlib/silk/i32.silk', 'pub let ZERO = 0\n')
  const git = Effect.fnUntraced(
    /** @param {...string} args */
    function* (...args) {
      const result = yield* NativeProcess.execute('git', args, { cwd: repository })
      assert.strictEqual(result.status, 0)
      return result.stdout.toString().trim()
    },
  )
  yield* git('init', '-q')
  yield* git('add', '.')
  yield* git(
    '-c',
    'user.name=Snapshot Test',
    '-c',
    'user.email=snapshot@example.invalid',
    'commit',
    '-qm',
    'authored inputs',
  )
  const revision = yield* git('rev-parse', 'HEAD')
  const snapshot = join(temporary, 'snapshot')
  const receipt = yield* createSnapshot({ repository, directory: snapshot })
  const bootstrap = join(temporary, 'bootstrap.mjs')
  yield* fs.writeFileString(
    bootstrap,
    `import {mkdirSync,writeFileSync,chmodSync} from 'node:fs'; import {dirname} from 'node:path'; import assert from 'node:assert/strict'; assert.deepEqual(process.argv.slice(2),['build','--manifest-path','compiler/silk.toml','--optimization','release-with-debug']); const p='compiler/build/llvm/x86_64-unknown-linux-gnu/release-with-debug/silk-compiler'; mkdirSync(dirname(p),{recursive:true}); writeFileSync(p,'#!/bin/sh\\nexit 42\\n'); chmodSync(p,0o755);`,
  )
  const clang = join(temporary, 'clang')
  yield* fs.writeFileString(clang, '#!/bin/sh\necho "LLVM toolchain fixture"\n')
  yield* fs.chmod(clang, 0o755)
  const artifact = join(temporary, 'artifact')
  return {
    fs,
    temporary,
    repository,
    snapshot,
    revision,
    receipt,
    bootstrap,
    artifact,
    git,
    put,
    options: {
      repository,
      snapshot,
      artifact,
      bootstrap,
      bootstrapCommit: revision,
      bootstrapRun: '123',
      clang,
      llvmAr: clang,
    },
  }
})
const failure = Effect.fnUntraced(
  /** @param {import('effect/Effect').Effect<unknown,{message:string},import('effect/FileSystem').FileSystem>} effect @param {RegExp} expected */
  function* (effect, expected) {
    const result = yield* Effect.result(effect)
    assert.isTrue(Result.isFailure(result))
    if (Result.isFailure(result)) assert.match(result.failure.message, expected)
  },
)

it.effect(
  'exports committed closure rather than modified checkout; rejects changed and extra source',
  () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      yield* f.put('compiler/src/main.silk', '// formatter changed checkout\n')
      const second = join(f.temporary, 'second')
      const receipt = yield* createSnapshot({ repository: f.repository, directory: second })
      assert.strictEqual(receipt.normalizedDigest, f.receipt.normalizedDigest)
      assert.strictEqual(receipt.archiveSha256, f.receipt.archiveSha256)
      assert.isTrue(
        receipt.files.some(({ path }) => path === 'compiler/src/nested/Dependency.silk'),
      )
      assert.isTrue(receipt.files.some(({ path }) => path === 'compiler/silk.toml'))
      yield* f.fs.writeFileString(join(second, 'compiler/src/extra.silk'), 'unrecorded input')
      yield* failure(verifySnapshot({ directory: second }), /Unrecorded snapshot input/)
      yield* f.fs.remove(join(second, 'compiler/src/extra.silk'))
      yield* f.fs.writeFileString(
        join(second, 'packages/compiler/stdlib/silk/i32.silk'),
        'changed stdlib',
      )
      yield* failure(verifySnapshot({ directory: second }), /Snapshot bytes or mode changed/)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
)

it.effect(
  'binds seed receipts and restores committed relative paths plus immutable executable mode',
  () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      const seed = yield* buildSeed(f.options)
      assert.strictEqual(seed.sourceCommit, f.revision)
      assert.strictEqual(seed.inputSnapshot.normalizedDigest, f.receipt.normalizedDigest)
      assert.strictEqual(seed.bootstrap.commit, f.revision)
      assert.strictEqual(seed.bootstrap.runId, '123')
      assert.strictEqual(seed.bootstrap.stdlib.authority, 'embedded-verified-main')
      assert.strictEqual(seed.bootstrap.stdlib.normalizedDigest, f.receipt.stdlibDigest)
      assert.deepEqual(seed.profile, {
        target: 'x86_64-unknown-linux-gnu',
        name: 'release-with-debug',
        optimization: 'speed',
        debug: true,
      })
      assert.match(seed.bootstrap.sha256, /^[a-f0-9]{64}$/)
      assert.match(seed.toolchain.clang.sha256, /^[a-f0-9]{64}$/)
      yield* f.fs.chmod(join(f.artifact, 'N0'), 0o644)
      const restored = join(f.temporary, 'restored')
      assert.deepEqual(yield* restoreSeed({ artifact: f.artifact, directory: restored }), seed)
      assert.strictEqual(yield* f.fs.readFileString(join(restored, 'compiler/src/main.silk')), main)
      assert.strictEqual(
        yield* f.fs.readFileString(join(restored, 'compiler/silk.toml')),
        yield* f.fs.readFileString(join(f.snapshot, 'compiler/silk.toml')),
      )
      assert.strictEqual((yield* f.fs.stat(join(restored, 'N0'))).mode & 0o777, 0o555)
      assert.strictEqual((yield* NativeProcess.execute(join(restored, 'N0'), [])).status, 42)
      assert.strictEqual(
        (yield* verifySnapshot({ directory: restored })).normalizedDigest,
        f.receipt.normalizedDigest,
      )
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
)

it.effect(
  'rejects embedded stdlib drift, failed bootstrap, and stale output without publishing a seed',
  () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      yield* f.put('packages/compiler/stdlib/silk/i32.silk', 'pub let ZERO = 1\n')
      yield* f.git('add', '.')
      yield* f.git(
        '-c',
        'user.name=Snapshot Test',
        '-c',
        'user.email=snapshot@example.invalid',
        'commit',
        '-qm',
        'changed stdlib',
      )
      yield* failure(
        verifyBootstrapStdlib({
          repository: f.repository,
          bootstrapCommit: yield* f.git('rev-parse', 'HEAD'),
          snapshotReceipt: f.receipt,
        }),
        /embedded stdlib differs/,
      )
      yield* f.fs.writeFileString(f.bootstrap, 'process.exit(7)\n')
      yield* failure(buildSeed(f.options), /Native seed build failed: 7/)
      assert.isFalse(yield* f.fs.exists(f.artifact))
      yield* f.fs.makeDirectory(join(f.snapshot, 'compiler/build'), { recursive: true })
      yield* f.fs.writeFileString(f.bootstrap, 'process.exit(0)\n')
      yield* failure(buildSeed(f.options), /fresh snapshot without build outputs/)
      assert.isFalse(yield* f.fs.exists(f.artifact))
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
)

it.effect(
  'rejects source mutation during build, corrupted archives/binaries, and receipt rebinding',
  () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      const bootstrap = yield* f.fs.readFileString(f.bootstrap)
      yield* f.fs.writeFileString(
        f.bootstrap,
        `${bootstrap}\nwriteFileSync('compiler/src/main.silk', 'mutated during build')\n`,
      )
      yield* failure(buildSeed(f.options), /Snapshot bytes or mode changed/)
      assert.isFalse(yield* f.fs.exists(f.artifact))
      yield* f.fs.writeFileString(join(f.snapshot, 'compiler/src/main.silk'), main)
      yield* f.fs.remove(join(f.snapshot, 'compiler/build'), { recursive: true })
      yield* f.fs.writeFileString(f.bootstrap, bootstrap)
      yield* buildSeed(f.options)
      const archive = yield* f.fs.readFile(join(f.artifact, 'authored-inputs.tar'))
      yield* f.fs.writeFileString(join(f.artifact, 'authored-inputs.tar'), 'corrupted archive')
      yield* failure(
        restoreSeed({ artifact: f.artifact, directory: join(f.temporary, 'bad-archive') }),
        /archive digest mismatch/,
      )
      yield* f.fs.writeFile(join(f.artifact, 'authored-inputs.tar'), archive)
      yield* f.fs.chmod(join(f.artifact, 'N0'), 0o755)
      const binary = yield* f.fs.readFile(join(f.artifact, 'N0'))
      yield* f.fs.writeFileString(join(f.artifact, 'N0'), 'corrupted executable')
      yield* failure(
        restoreSeed({ artifact: f.artifact, directory: join(f.temporary, 'bad-binary') }),
        /receipt mismatch/,
      )
      yield* f.fs.writeFile(join(f.artifact, 'N0'), binary)
      const text = yield* f.fs.readFileString(join(f.artifact, 'seed-receipt.json'))
      yield* f.fs.writeFileString(
        join(f.artifact, 'seed-receipt.json'),
        text.replace(f.receipt.normalizedDigest, '0'.repeat(64)),
      )
      yield* failure(
        restoreSeed({ artifact: f.artifact, directory: join(f.temporary, 'bad-receipt') }),
        /receipt mismatch/,
      )
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
)
