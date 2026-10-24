// Real WASI command execution, component validation, and compiler-driver integration.
import { strict as assert } from 'node:assert'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NodeServices } from '@effect/platform-node'
import * as Console from 'effect/Console'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as NativeProcess from './NativeProcess.ts'

const program = Effect.gen(function* () {
  const [compilerArg, clangArg, toolDirectoryArg] = process.argv.slice(2)
  assert.ok(
    compilerArg && clangArg && toolDirectoryArg,
    'usage: test-wasi.ts <compiler> <clang> <wasi-tools-directory>',
  )
  const compiler = resolve(compilerArg)
  const clang = resolve(clangArg)
  const tools = resolve(toolDirectoryArg)
  const wasmtime = join(tools, 'wasmtime')
  const wasmTools = join(tools, 'wasm-tools')
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  const fs = yield* FileSystem.FileSystem
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'silk-wasi-' })
  const guest = join(directory, 'guest')
  yield* fs.makeDirectory(guest)
  yield* fs.writeFileString(join(directory, 'outside'), 'must stay outside the guest')
  yield* fs.symlink(join(directory, 'outside'), join(guest, 'escape'))
  const source = yield* fs.readFileString(join(repo, 'compiler/fixtures/wasi/main.silk'))
  yield* fs.writeFileString(
    join(directory, 'silk.toml'),
    '[package]\nname = "wasi-test"\nversion = "0.1.0"\nroot = "main.silk"\n',
  )
  const env = {
    ...process.env,
    SILK_CLANG: clang,
    SILK_WASMTIME: wasmtime,
    SILK_WASM_TOOLS: wasmTools,
    SILK_WASI_ADAPTER: join(tools, 'wasi_snapshot_preview1.command.wasm'),
  }
  const invoke = Effect.fnUntraced(function* (
    command: string,
    args: ReadonlyArray<string>,
    extra: NativeProcess.ProcessOptions = {},
  ) {
    return yield* NativeProcess.execute(command, args, {
      cwd: directory,
      env,
      timeoutMs: 120_000,
      ...extra,
    })
  })
  const build = Effect.fnUntraced(function* (
    target: string,
    output: string,
    extra: ReadonlyArray<string> = [],
    environment = env,
  ) {
    return yield* invoke(
      compiler,
      [
        'build',
        'main.silk',
        '-o',
        output,
        '--target',
        target,
        '--stdlib',
        join(repo, 'stdlib'),
        ...extra,
      ],
      { env: environment },
    )
  })
  for (const target of ['wasm32-wasip1', 'wasm32-wasip2']) {
    yield* fs.writeFileString(join(directory, 'main.silk'), source)
    const output = join(directory, `${target}.wasm`)
    const built = yield* build(target, output)
    assert.equal(built.status, 0, built.stderr.toString())
    const valid = yield* invoke(wasmTools, ['validate', output])
    assert.equal(valid.status, 0, valid.stderr.toString())
    if (target === 'wasm32-wasip2') {
      const wit = yield* invoke(wasmTools, ['component', 'wit', output])
      assert.equal(wit.status, 0, wit.stderr.toString())
      assert.match(wit.stdout.toString(), /export wasi:cli\/run/)
    }
    const ran = yield* invoke(
      wasmtime,
      ['run', '--dir', `${guest}::/`, '--env', 'SILK_WASI_TEST=value', output, 'argument'],
      { input: Buffer.from('input') },
    )
    assert.equal(ran.status, 0, ran.stderr.toString())
    assert.equal(ran.stdout.toString(), 'gather:ab\nwasi services passed\n')
    assert.equal(ran.stderr.toString(), 'wasi stderr\n')
    assert.equal(
      yield* fs.exists(join(guest, 'files')),
      false,
      'owned files and temporary directories are cleaned up',
    )
    // Missing capabilities produce an application failure rather than reaching host files.
    const denied = yield* invoke(
      wasmtime,
      ['run', '--env', 'SILK_WASI_TEST=value', output, 'argument'],
      { input: Buffer.from('input') },
    )
    assert.equal(denied.status, 1, denied.stderr.toString())
    const tested = yield* invoke(compiler, [
      'test',
      '--target',
      target,
      '--stdlib',
      join(repo, 'stdlib'),
      '--no-cache',
    ])
    assert.equal(tested.status, 0, tested.stderr.toString())
    assert.match(tested.stdout.toString(), /2 passed, 0 failed/)
    yield* fs.writeFileString(
      join(directory, 'main.silk'),
      'pub fn main() -> () {}\ntest fn traps() -> () { let bad = 1 / 0 }\ntest fn continues() -> () {}\n',
    )
    const trapped = yield* invoke(compiler, [
      'test',
      '--target',
      target,
      '--stdlib',
      join(repo, 'stdlib'),
      '--no-cache',
    ])
    assert.equal(trapped.status, 1, trapped.stderr.toString())
    assert.match(trapped.stdout.toString(), /1 passed, 1 failed/)
    // Empty host snapshots and nonzero command status work for each entry adapter.
    yield* fs.writeFileString(join(directory, 'main.silk'), 'pub fn main() -> i32 { return 42 }\n')
    const statusBuild = yield* build(target, output)
    assert.equal(statusBuild.status, 0, statusBuild.stderr.toString())
    const status = yield* invoke(wasmtime, ['run', output])
    assert.equal(status.status, target === 'wasm32-wasip1' ? 42 : 1, status.stderr.toString())
    yield* fs.writeFileString(join(directory, 'main.silk'), 'pub fn main() -> () {}\n')
    const run = yield* invoke(compiler, [
      'run',
      '--target',
      target,
      '--stdlib',
      join(repo, 'stdlib'),
    ])
    assert.equal(run.status, 0, run.stderr.toString())
    // Core IR and relocatable objects do not require component tooling.
    const absentTools = {
      ...env,
      SILK_WASM_TOOLS: join(directory, 'missing-tools'),
      SILK_WASI_ADAPTER: join(directory, 'missing-adapter'),
    }
    for (const stage of ['llvm-ir', 'object']) {
      const emitted = yield* build(
        target,
        join(directory, `output.${stage}`),
        ['--emit', stage],
        absentTools,
      )
      assert.equal(emitted.status, 0, emitted.stderr.toString())
    }
    if (target === 'wasm32-wasip2') {
      yield* fs.writeFileString(output, 'previous output')
      const failed = yield* build(target, output, [], {
        ...env,
        SILK_WASI_ADAPTER: join(directory, 'missing-adapter'),
      })
      assert.notEqual(failed.status, 0)
      assert.equal(
        yield* fs.readFileString(output),
        'previous output',
        'failed component construction does not publish a core module',
      )
    }
  }
  yield* Console.log(
    'WASI Preview 1 and Preview 2: services, capability confinement, command entries, components, run, test, emission stages, and atomic publication passed',
  )
})
await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
