// Compile the shared C/Silk aggregate fixture separately and execute the freestanding wasm lane.
import { strict as assert } from 'node:assert'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NodeServices } from '@effect/platform-node'
import * as Console from 'effect/Console'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as NativeProcess from './NativeProcess.ts'

const program = Effect.gen(function* () {
  const [compilerArg, clangArg] = process.argv.slice(2)
  assert.ok(compilerArg && clangArg, 'usage: test-c-aggregates.ts <compiler> <clang>')
  const compiler = resolve(compilerArg)
  const clang = resolve(clangArg)
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  const fs = yield* FileSystem.FileSystem
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'silk-c-aggregates-' })
  const fixture = join(repo, 'corpus/native/foreign-struct-values')
  yield* fs.copyFile(join(fixture, 'main.silk'), join(directory, 'main.silk'))
  yield* fs.copyFile(join(fixture, 'c/struct_values.c'), join(directory, 'struct_values.c'))
  yield* fs.writeFileString(
    join(directory, 'silk.toml'),
    '[package]\nname = "c-aggregate-conformance"\nversion = "0.1.0"\nsource = "."\n' +
      '[native]\nlink = [{ object = "struct_values.o" }]\n',
  )
  const invoke = Effect.fnUntraced(function* (command: string, args: ReadonlyArray<string>) {
    const result = yield* NativeProcess.execute(command, args, {
      cwd: directory,
      env: { ...process.env, SILK_CLANG: clang },
      timeoutMs: 120_000,
    })
    assert.equal(result.status, 0, result.stderr)
  })
  for (const profile of [
    { name: 'debug', c: '-O0', optimization: 'none', debug: 'true' },
    { name: 'optimized', c: '-O2', optimization: 'speed', debug: 'false' },
  ]) {
    yield* invoke(clang, [
      '--target=wasm32-unknown-unknown',
      '-ffreestanding',
      profile.c,
      '-c',
      'struct_values.c',
      '-o',
      'struct_values.o',
    ])
    yield* invoke(compiler, [
      'build',
      'main.silk',
      '-o',
      'program.wasm',
      '--target',
      'wasm32-unknown-unknown',
      '--stdlib',
      join(repo, 'stdlib'),
      '--optimization',
      profile.optimization,
      '--debug',
      profile.debug,
    ])
    const bytes = yield* fs.readFile(join(directory, 'program.wasm'))
    yield* Effect.try(() => {
      const module = new WebAssembly.Module(bytes)
      assert.deepEqual(WebAssembly.Module.imports(module), [])
      const instance = new WebAssembly.Instance(module, {})
      const entry = instance.exports.silk_test_struct_values
      assert.equal(typeof entry, 'function')
      if (typeof entry !== 'function') throw new Error('missing aggregate conformance entry')
      assert.equal(entry(), 0, `${profile.name}: C/Silk aggregate values, callbacks and exports`)
    })
    yield* Console.log(`C aggregate conformance: wasm32 ${profile.name} passed`)
  }
})
await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
