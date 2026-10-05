import { pathToFileURL } from 'node:url'
import { NodeServices } from '@effect/platform-node'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Option from 'effect/Option'
import * as Result from 'effect/Result'
import * as FileSourceResolver from '../src/FileSourceResolver.js'
import * as Source from '../src/Source.js'
import * as SourceResolver from '../src/SourceResolver.js'

it.effect('maps canonical modules exactly below the source root', () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    const root = yield* fileSystem.makeTempDirectoryScoped()
    yield* fileSystem.makeDirectory(`${root}/compiler`)
    yield* fileSystem.writeFileString(`${root}/compiler/Syntax.silk`, 'source')
    const resolver = FileSourceResolver.layer(FileSourceResolver.make(root))

    const found = yield* Source.load('compiler/Syntax').pipe(Effect.provide(resolver))
    assert.strictEqual(Option.isSome(found), true)
    if (Option.isSome(found)) {
      assert.strictEqual(new TextDecoder().decode(found.value.bytes), 'source')
      assert.deepEqual(found.value.origin, {
        _tag: 'ProjectFile',
        path: `${root}/compiler/Syntax.silk`,
      })
    }
    const absent = yield* Source.load('missing/Module').pipe(Effect.provide(resolver))
    assert.strictEqual(Option.isNone(absent), true)
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
)

it.effect('distinguishes not found from an operational read failure', () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    const root = yield* fileSystem.makeTempDirectoryScoped()
    yield* fileSystem.makeDirectory(`${root}/unreadable.silk`)
    const resolver = FileSourceResolver.layer(FileSourceResolver.make(root))
    const result = yield* Effect.result(Source.load('unreadable').pipe(Effect.provide(resolver)))
    assert.strictEqual(Result.isFailure(result), true)
    if (Result.isFailure(result)) assert.strictEqual(result.failure.reason._tag, 'WrappedFailure')
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
)

it.effect('resolves canonical toolchain sources and reports a missing packaged file', () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    const root = yield* fileSystem.makeTempDirectoryScoped()
    const projectResolver = FileSourceResolver.layer(FileSourceResolver.make(root))
    const found = yield* SourceResolver.resolveStandardLibrary('silk/vector').pipe(
      Effect.provide(projectResolver),
    )
    assert.isTrue(Option.isSome(found))
    if (Option.isSome(found)) {
      assert.strictEqual(found.value.origin._tag, 'ToolchainFile')
      assert.include(new TextDecoder().decode(found.value.bytes), 'struct Vector<T>')
    }

    const missingRoot = pathToFileURL(`${root}/missing-toolchain/`).href
    const missingResolver = FileSourceResolver.layer(
      FileSourceResolver.make(root, { kind: 'files', root: missingRoot }),
    )
    const missing = yield* Effect.result(
      SourceResolver.resolveStandardLibrary('silk/vector').pipe(Effect.provide(missingResolver)),
    )
    assert.isTrue(Result.isFailure(missing))
    if (Result.isFailure(missing)) {
      assert.strictEqual(missing.failure.reason._tag, 'MissingToolchainSource')
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
)
