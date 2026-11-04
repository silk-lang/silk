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
  // A C variadic tail goes in a block on the linear-memory stack whose address follows the fixed
  // arguments. LLVM lays it out against Clang's C callee; the direct backend lays out the same
  // block, which a host import reads.
  const variadic = join(repo, 'corpus/native/foreign-variadic-scalars')
  yield* fs.copyFile(join(variadic, 'main.silk'), join(directory, 'variadic.silk'))
  yield* fs.copyFile(join(variadic, 'c/silk_test_variadic_scalars.c'), join(directory, 'variadic.c'))
  // The manifest links `struct_values.o`, so the variadic C object takes that name.
  yield* invoke(clang, ['--target=wasm32-unknown-unknown', '-ffreestanding', '-O2', '-c', 'variadic.c', '-o', 'struct_values.o'])
  yield* invoke(compiler, ['build', 'variadic.silk', '-o', 'variadic.wasm', '--target', 'wasm32-unknown-unknown', '--stdlib', join(repo, 'stdlib')])
  const variadicBytes = yield* fs.readFile(join(directory, 'variadic.wasm'))
  yield* Effect.try(() => {
    const instance = new WebAssembly.Instance(new WebAssembly.Module(variadicBytes), {})
    const entry = instance.exports.main
    if (typeof entry !== 'function') throw new Error('missing variadic entry')
    assert.equal(entry(), 42, 'C variadic scalars on wasm32')
  })
  yield* fs.writeFileString(
    join(directory, 'host.silk'),
    'unsafe extern "C" fn sum(count: i32, ...) -> i64 as "env#sum"\n' +
      'pub fn main() -> i32 {\n' +
      '  let small: i8 = -3\n  let big: i64 = 5000000000\n  let half: f32 = 2.5\n' +
      '  if unsafe sum(4, small, big, half, 9) != 5000000008 { return 1 }\n' +
      '  return 42\n}\n',
  )
  for (const backend of ['llvm', 'direct']) {
    yield* invoke(compiler, ['build', 'host.silk', '-o', `host-${backend}.wasm`, '--target', 'wasm32-unknown-unknown', '--backend', backend, '--stdlib', join(repo, 'stdlib')])
    const hostBytes = yield* fs.readFile(join(directory, `host-${backend}.wasm`))
    yield* Effect.try(() => {
      let memory: WebAssembly.Memory | undefined
      const sum = (count: number, block: number) => {
        assert.equal(count, 4)
        const view = new DataView(memory!.buffer)
        // Each argument at its own alignment: the promoted `i8`, `i64`, promoted `f32` and `i32`.
        return BigInt(view.getInt32(block, true)) + view.getBigInt64(block + 8, true) +
          BigInt(Math.floor(view.getFloat64(block + 16, true))) + BigInt(view.getInt32(block + 24, true))
      }
      const instance = new WebAssembly.Instance(new WebAssembly.Module(hostBytes), { env: { sum } })
      memory = instance.exports.memory as WebAssembly.Memory
      const entry = instance.exports.main
      if (typeof entry !== 'function') throw new Error('missing host variadic entry')
      assert.equal(entry(), 42, `${backend}: the variadic block a host import reads`)
    })
  }
  yield* Console.log('C variadic calls: wasm32 llvm and direct passed')
})
await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
