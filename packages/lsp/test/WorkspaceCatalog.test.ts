import * as Stdlib from '@silklang/compiler/Stdlib'
import * as SourceResolver from '@silklang/compiler/SourceResolver'
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { NodeServices } from '@effect/platform-node'
import { assert, it } from '@effect/vitest'
import * as WorkspaceInventory from '@silklang/compiler/WorkspaceInventory'
import * as Effect from 'effect/Effect'
import * as Deferred from 'effect/Deferred'
import * as Fiber from 'effect/Fiber'
import * as Exit from 'effect/Exit'
import * as Scope from 'effect/Scope'
import * as Option from 'effect/Option'
import * as Document from '../src/Document.js'
import * as WorkspaceCatalog from '../src/WorkspaceCatalog.js'

const encoder = new TextEncoder()

const fixture = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'silk-catalog-'))
  mkdirSync(join(root, 'nested'))
  writeFileSync(join(root, 'Main.silk'), 'pub fn main() -> i32 { return 1 }')
  writeFileSync(join(root, 'nested', 'Util.silk'), 'pub fn diskValue() -> i32 { return 2 }')
  symlinkSync(join(root, 'nested', 'Util.silk'), join(root, 'Alias.silk'))
  return root
}

it.effect(
  'catalogs canonical files and toolchain summaries, then revises only dirty workspace entries',
  () =>
    Effect.gen(function* () {
      const root = fixture()
      const util = Document.make({
        uri: pathToFileURL(join(root, 'nested', 'Util.silk')).href,
        version: 2,
        workspace: 'fixture',
        module: 'nested/Util',
        sourceRoot: root,
        bytes: encoder.encode('pub fn bufferedValue() -> i32 { return 3 }'),
      })
      const inventory = yield* WorkspaceCatalog.refresh({
        configuration: { configuration: { profile: { target: 'aarch64-apple-darwin' } } },
        sourceRoot: root,
        documents: [util],
        invalidation: { dirtyPaths: [], rediscover: true },
      })

      assert.deepEqual([...inventory.project.keys()], ['Main', 'nested/Util'])
      assert.isFalse(inventory.project.has(Stdlib.sealedModule.module))
      assert.isFalse(inventory.toolchain.has(Stdlib.sealedModule.module))
      assert.deepEqual(
        WorkspaceInventory.candidates(inventory, 'Add').map((candidate) => candidate.module),
        ['silk/ops'],
      )
      assert.deepEqual(
        WorkspaceInventory.candidates(inventory, 'main').map((candidate) => candidate.module),
        ['Main', 'silk/test_runner'],
      )
      assert.deepEqual(
        WorkspaceInventory.candidates(inventory, 'bufferedValue').map(
          (candidate) => candidate.module,
        ),
        ['nested/Util'],
      )
      assert.deepEqual(WorkspaceInventory.candidates(inventory, 'diskValue'), [])
      assert.isAtLeast(WorkspaceInventory.candidates(inventory, 'Bytes').length, 1)
      assert.strictEqual(inventory.project.get('nested/Util')?.source.origin._tag, 'Memory')
      assert.strictEqual(inventory.integrity._tag, 'Matched')
      assert.strictEqual(inventory.distribution.digest.length, 64)
      const initial = inventory
      const main = initial.project.get('Main')
      const utilSummary = initial.project.get('nested/Util')
      writeFileSync(join(root, 'Main.silk'), 'pub fn revised() -> i32 { return 4 }')
      const revised = yield* WorkspaceCatalog.refresh({
        configuration: { configuration: { profile: { target: 'aarch64-apple-darwin' } } },
        sourceRoot: root,
        documents: [util],
        previous: initial,
        invalidation: { dirtyPaths: [join(root, 'Main.silk')], rediscover: false },
      })
      assert.strictEqual(revised.distribution, initial.distribution)
      assert.isFalse(revised.project.get('Main') === main)
      assert.isTrue(revised.project.get('nested/Util') === utilSummary)
      assert.strictEqual(revised.observation.scanned, 2)
      assert.strictEqual(revised.observation.reused, 1)
      assert.strictEqual(revised.observation.revised, 1)
      assert.strictEqual(revised.observation.removed, 0)
      assert.strictEqual(
        revised.observation.indexedModules,
        revised.project.size + revised.toolchain.size,
      )
      assert.deepEqual(
        WorkspaceInventory.candidates(revised, 'revised').map((value) => value.module),
        ['Main'],
      )

      rmSync(join(root, 'nested', 'Util.silk'))
      const removed = yield* WorkspaceCatalog.refresh({
        configuration: { configuration: { profile: { target: 'aarch64-apple-darwin' } } },
        sourceRoot: root,
        documents: [],
        previous: revised,
        invalidation: { dirtyPaths: [join(root, 'nested', 'Util.silk')], rediscover: false },
      })
      assert.strictEqual(removed.project.has('nested/Util'), false)
      assert.strictEqual(removed.observation.removed, 1)

      renameSync(join(root, 'Main.silk'), join(root, 'Renamed.silk'))
      const renamed = yield* WorkspaceCatalog.refresh({
        configuration: { configuration: { profile: { target: 'aarch64-apple-darwin' } } },
        sourceRoot: root,
        documents: [],
        previous: removed,
        invalidation: {
          dirtyPaths: [join(root, 'Main.silk'), join(root, 'Renamed.silk')],
          rediscover: false,
        },
      })
      assert.deepEqual([...renamed.project.keys()], ['Renamed'])
    }).pipe(Effect.provide([SourceResolver.empty, NodeServices.layer])),
  180_000,
)

it.effect('defers catalog selection and retries an interrupted attempt without caching it', () =>
  Effect.gen(function* () {
    let attempts = 0
    const expected = WorkspaceInventory.make({ project: [], toolchain: [] })
    const catalog = yield* WorkspaceCatalog.defer(
      Effect.suspend(() => {
        attempts += 1
        return attempts === 1 ? Effect.interrupt : Effect.succeed(expected)
      }),
    )
    assert.strictEqual(attempts, 0)
    assert.isTrue(Option.isNone(yield* catalog.completed))
    yield* Effect.exit(catalog.get)
    assert.isTrue(Option.isNone(yield* catalog.completed))
    assert.strictEqual(yield* catalog.get, expected)
    assert.strictEqual(yield* catalog.get, expected)
    assert.strictEqual(attempts, 2)
    assert.deepEqual(yield* catalog.completed, Option.some(expected))
  }),
)

it.effect(
  'retains demanded selection across query cancellation and stops it with its generation',
  () =>
    Effect.gen(function* () {
      const owner = yield* Scope.Scope
      const generation = yield* Scope.fork(owner)
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let attempts = 0
      const expected = WorkspaceInventory.make()
      const pending = yield* WorkspaceCatalog.defer(
        Effect.gen(function* () {
          attempts += 1
          yield* Deferred.succeed(started, undefined)
          yield* Deferred.await(release)
          return expected
        }),
      )
      const catalog = yield* WorkspaceCatalog.retain(pending, generation)
      assert.strictEqual(attempts, 0)
      const first = yield* Effect.forkChild(catalog.get)
      yield* Deferred.await(started)
      yield* Fiber.interrupt(first)
      assert.isTrue(Option.isNone(yield* catalog.completed))
      yield* Deferred.succeed(release, undefined)
      assert.strictEqual(yield* catalog.get, expected)
      assert.strictEqual(yield* catalog.get, expected)
      assert.strictEqual(attempts, 1)
      yield* Scope.close(generation, Exit.succeed(undefined))

      const nextGeneration = yield* Scope.fork(owner)
      const nextStarted = yield* Deferred.make<void>()
      const stopped = yield* Deferred.make<void>()
      const nextPending = yield* WorkspaceCatalog.defer(
        Deferred.succeed(nextStarted, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(Deferred.succeed(stopped, undefined)),
        ),
      )
      const next = yield* WorkspaceCatalog.retain(nextPending, nextGeneration)
      const waiting = yield* Effect.forkChild(next.get)
      yield* Deferred.await(nextStarted)
      yield* Scope.close(nextGeneration, Exit.succeed(undefined))
      yield* Deferred.await(stopped)
      assert.isTrue(Exit.isFailure(yield* Fiber.await(waiting)))
      assert.isTrue(Option.isNone(yield* next.completed))
    }).pipe(Effect.scoped),
)
