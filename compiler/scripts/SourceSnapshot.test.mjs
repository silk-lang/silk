import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'
import * as NativeProcess from './NativeProcess.ts'
import { historicalSeeds } from '../../.github/scripts/native-seed-history.mjs'
import * as NativeSeedRetention from '../../.github/scripts/native-seed-retention.mjs'
import { candidate, readPin, selectSeed, targets, verifySeed } from './NativeSeed.mjs'
import { createSnapshot, hash, verifySnapshot } from './SourceSnapshot.mjs'

const require = createRequire(new URL('../../packages/compiler/package.json', import.meta.url))
/** @type {{ NodeServices: {layer: import('effect/Layer').Layer<import('effect/FileSystem').FileSystem>} }} */
/** @type {{ NodeServices: {layer: import('effect/Layer').Layer<import('effect/FileSystem').FileSystem>} }} */
const { NodeServices } = await import(pathToFileURL(require.resolve('@effect/platform-node')).href)
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))
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
  return { fs, temporary, repository, snapshot, revision, receipt, git, put }
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

it.effect('installs only downloaded bytes that match a Release pin', () =>
  Effect.gen(function* () {
    const f = yield* fixture()
    const seed = '#!/bin/sh\nexit 42\n'
    const target = 'x86_64-unknown-linux-gnu'
    const pin = yield* candidate({
      target,
      sha256: hash(seed),
      sourceCommit: f.revision,
      runId: '38110973077',
    })
    assert.strictEqual(pin.seeds[target].tag, `native-seed-${f.revision}`)
    const pinPath = join(f.temporary, 'native-seed.json')
    yield* f.fs.writeFileString(pinPath, yield* encodeJson(pin))
    const download = join(f.temporary, 'download')
    yield* f.fs.writeFileString(download, seed)
    const installed = join(f.temporary, 'seed')
    assert.deepEqual(
      yield* verifySeed({ pin: pinPath, target, download, destination: installed }),
      pin,
    )
    assert.strictEqual((yield* f.fs.stat(installed)).mode & 0o777, 0o555)
    assert.strictEqual((yield* NativeProcess.execute(installed, [])).status, 42)
    yield* failure(
      verifySeed({ pin: pinPath, target, download, destination: installed }),
      /destination must be fresh/,
    )
    yield* f.fs.writeFileString(download, '#!/bin/sh\nexit 0\n')
    const replaced = join(f.temporary, 'replaced')
    yield* failure(
      verifySeed({ pin: pinPath, target, download, destination: replaced }),
      /differs from pinned/,
    )
    assert.isFalse(yield* f.fs.exists(replaced))
    yield* f.fs.writeFileString(
      pinPath,
      yield* encodeJson({
        ...pin,
        seeds: { [target]: { ...pin.seeds[target], tag: `native-seed-${'0'.repeat(40)}` } },
      }),
    )
    yield* failure(readPin(pinPath), /tag must name its source commit/)
    yield* f.fs.writeFileString(
      pinPath,
      yield* encodeJson({ schemaVersion: 1, seed: { _tag: 'Bootstrap', reason: 're-seed' } }),
    )
    yield* failure(readPin(pinPath), /./)
    yield* f.fs.writeFileString(
      pinPath,
      yield* encodeJson({ schemaVersion: 1, seed: pin.seeds[target] }),
    )
    yield* failure(readPin(pinPath), /./)
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
)

it.effect(
  'selects independently pinned targets and rejects mismatched coordinates or missing pins',
  () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      const seeds = {}
      for (const target of targets) {
        const pin = yield* candidate({
          target,
          sha256: hash(target),
          sourceCommit: f.revision,
          runId: '1',
        })
        Object.assign(seeds, pin.seeds)
      }
      const pinPath = join(f.temporary, 'pins.json')
      yield* f.fs.writeFileString(pinPath, yield* encodeJson({ schemaVersion: 2, seeds }))
      const pin = yield* readPin(pinPath)
      for (const target of targets) {
        const selected = yield* selectSeed(pin, target)
        assert.strictEqual(selected.asset, `silk-compiler-${target}`)
        assert.strictEqual(selected.sha256, hash(target))
        const download = join(f.temporary, `download-${target}`)
        yield* f.fs.writeFileString(download, target)
        yield* verifySeed({
          pin: pinPath,
          target,
          download,
          destination: join(f.temporary, `installed-${target}`),
        })
      }
      const target = targets[0]
      const arm = targets[1]
      const swapped = join(f.temporary, 'swapped-seed')
      yield* failure(
        verifySeed({
          pin: pinPath,
          target: arm,
          download: join(f.temporary, `download-${target}`),
          destination: swapped,
        }),
        /differs from pinned/,
      )
      assert.isFalse(yield* f.fs.exists(swapped))
      yield* failure(
        selectSeed({ schemaVersion: 2, seeds: { [target]: seeds[target] } }, arm),
        /No native seed is pinned/,
      )
      for (const seeds of [
        {},
        { [arm]: pin.seeds[target] },
        { [target]: { ...pin.seeds[target], asset: `silk-compiler-${arm}` } },
      ]) {
        yield* f.fs.writeFileString(pinPath, yield* encodeJson({ schemaVersion: 2, seeds }))
        yield* failure(readPin(pinPath), /at least one|key must match|asset must name/)
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
)

it("retains the union of each target's newest assets, current pins, and immutable pin history", () => {
  const x86 = 'x86_64-unknown-linux-gnu'
  const arm = 'aarch64-unknown-linux-gnu'
  const mac = 'aarch64-apple-darwin'
  const releases = [
    ...Array.from({ length: 21 }, (_, index) => ({
      tag: `linux-${index}`,
      assets: [`silk-compiler-${x86}`],
    })),
    { tag: 'old-arm-and-mac', assets: [`silk-compiler-${arm}`, `silk-compiler-${mac}`] },
    { tag: 'old-pinned', assets: [`silk-compiler-${x86}`] },
    { tag: 'old-current', assets: [`silk-compiler-${mac}`] },
  ]
  const history = new Map([
    [x86, new Set(['old-pinned'])],
    [arm, new Set()],
    [mac, new Set()],
  ])
  const kept = NativeSeedRetention.reasons(releases, history, [[mac, { tag: 'old-current' }]])
  assert.isTrue(kept.has('linux-19'))
  assert.isFalse(kept.has('linux-20'))
  assert.deepEqual(kept.get('old-arm-and-mac'), [`${arm}: 20 newest`, `${mac}: 20 newest`])
  assert.include(kept.get('old-pinned'), `${x86}: pinned in selfhost history`)
  assert.include(kept.get('old-current'), `${mac}: current pin`)
  const release = { _tag: 'Release', target: x86, tag: 'historical-release' }
  assert.deepEqual(historicalSeeds({ schemaVersion: 1, seed: release }), [release])
  assert.deepEqual(historicalSeeds({ schemaVersion: 2, seeds: { [x86]: release } }), [release])
  assert.deepEqual(historicalSeeds({ schemaVersion: 1, seed: { _tag: 'Bootstrap' } }), [])
})
