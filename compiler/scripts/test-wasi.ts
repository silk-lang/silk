// Real WASI command execution, component validation, and compiler-driver integration.
import { strict as assert } from 'node:assert'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NodeServices } from '@effect/platform-node'
import * as Console from 'effect/Console'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as NativeProcess from './NativeProcess.ts'
import * as WasiComponents from './test-wasi-components.ts'

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
  const toolLinks = join(directory, 'tools')
  yield* fs.makeDirectory(toolLinks)
  for (const name of ['wasmtime', 'wasm-tools', 'wasi_snapshot_preview1.command.wasm']) {
    yield* fs.symlink(join(tools, name), join(toolLinks, name))
  }
  yield* fs.writeFileString(join(directory, 'outside'), 'must stay outside the guest')
  yield* fs.symlink(join(directory, 'outside'), join(guest, 'escape'))
  const source = yield* fs.readFileString(join(repo, 'compiler/fixtures/wasi/main.silk'))
  yield* fs.writeFileString(
    join(directory, 'silk.toml'),
    '[package]\nname = "wasi-test"\nversion = "0.1.0"\nsource = "."\n',
  )
  const env = {
    ...process.env,
    SILK_CLANG: clang,
    SILK_WASMTIME: join(toolLinks, 'wasmtime'),
    SILK_WASM_TOOLS: join(toolLinks, 'wasm-tools'),
    SILK_WASI_ADAPTER: join(toolLinks, 'wasi_snapshot_preview1.command.wasm'),
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
      // The bundled world lists the draft `wasi:logging`, which only a component that logs
      // through it imports.
      assert.doesNotMatch(wit.stdout.toString(), /wasi:logging/)
      yield* fs.writeFileString(
        join(directory, 'logging.silk'),
        [
          'import silk.core.effect { Effect }',
          'import silk.io.logger { LogError, Logger }',
          'import silk.io.logger_wasi { WasiLogger }',
          'pub effect fn main() -> i32 ! LogError {',
          '  let mut logger = WasiLogger.make("startup")',
          '  run Effect.logInfo("started", &()) |> Effect.provideMut<Logger>(&mut logger)',
          '  return 0',
          '}',
          '',
        ].join('\n'),
      )
      const loggingOutput = join(directory, 'logging.wasm')
      const logging = yield* invoke(
        compiler,
        ['build', 'logging.silk', '-o', loggingOutput, '--target', target, '--stdlib', join(repo, 'stdlib')],
      )
      assert.equal(logging.status, 0, logging.stderr.toString())
      const loggingWit = yield* invoke(wasmTools, ['component', 'wit', loggingOutput])
      assert.equal(loggingWit.status, 0, loggingWit.stderr.toString())
      assert.match(loggingWit.stdout.toString(), /import wasi:logging\/logging@0\.1\.0-draft;/)
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
      'pub fn main() -> () {}\ntest fn timesOut() -> () { while true {} }\ntest fn traps() -> () { Intrinsic.trap("WASI test trap") }\ntest fn zAfterTrap() -> () {}\n',
    )
    const trapped = yield* invoke(compiler, [
      'test',
      '--target',
      target,
      '--stdlib',
      join(repo, 'stdlib'),
      '--no-cache',
      '--timeout',
      '1',
    ])
    assert.equal(trapped.status, 1, trapped.stderr.toString())
    assert.match(trapped.stdout.toString(), /1 passed, 2 failed/)
    assert.match(trapped.stdout.toString(), /fatal trap: WASI test trap\n {6}at main\.traps \(main:3:/)
    // A trap names its callers with their lines from Wasmtime's trace, under the test or after the
    // report, and the module's name section reads as the source does (#2599).
    yield* fs.writeFileString(
      join(directory, 'main.silk'),
      [
        'import silk.testing.testing {AssertionError, Testing}',
        'fn pick(values: &[i32], at: usize) -> i32 { return values[at] }',
        'fn outer(at: usize) -> i32 { let values: [i32; 2] = [1, 2] return pick(&values, at) }',
        'test effect fn trapsDeep() -> () ! AssertionError<\'static> { let value = outer(5) run Testing.expect(value == 1, "never") }',
        'pub fn main() -> i32 { return outer(5) }',
        '',
      ].join('\n'),
    )
    const deep = yield* invoke(compiler, ['test', '--target', target, '--stdlib', join(repo, 'stdlib'), '--no-cache'])
    assert.equal(deep.status, 1, deep.stderr.toString())
    assert.match(
      deep.stdout.toString(),
      /fatal trap: index out of bounds\n {6}at main\.pick \(main:2:52\)\n {6}at main\.outer \(main\.silk:3:67\)\n {6}at main\.trapsDeep \(main\.silk:4:\d+\)\n {4}FAIL/,
    )
    const deepRun = yield* invoke(compiler, ['run', '--target', target, '--stdlib', join(repo, 'stdlib'), '--quiet'])
    assert.notEqual(deepRun.status, 0)
    assert.match(deepRun.stderr.toString(), /fatal trap: index out of bounds\n {2}at main\.pick \(main:2:52\)\n/)
    assert.match(deepRun.stderr.toString(), /- main\.outer\n\s+at .*main\.silk:3:67/)
    // `--coredump` has Wasmtime write a core dump of the trapped module, which is a wasm module.
    if (target === 'wasm32-wasip1') {
      const core = join(directory, 'trap.core')
      const dumped = yield* invoke(compiler, ['run', '--target', target, '--stdlib', join(repo, 'stdlib'), '--quiet', '--coredump', core])
      assert.notEqual(dumped.status, 0)
      const coreBytes = yield* fs.readFile(core)
      assert.deepEqual([...coreBytes.subarray(0, 4)], [0, 0x61, 0x73, 0x6d])
    }
    // `debug` starts the program under Wasmtime's debugger stub, listening on `--port`.
    const recorder = join(directory, 'fake-wasmtime')
    yield* fs.writeFileString(recorder, '#!/bin/sh\nprintf "%s\\n" "$@"\n')
    yield* fs.chmod(recorder, 0o755)
    const debugged = yield* invoke(
      compiler,
      ['debug', '--target', target, '--stdlib', join(repo, 'stdlib'), '--quiet', '--port', '4711', 'first'],
      { env: { ...env, SILK_WASMTIME: recorder } },
    )
    assert.equal(debugged.status, 0, debugged.stderr.toString())
    assert.match(debugged.stdout.toString(), /^run\n--dir\n\.::\/\n-g\n4711\n\S+\nfirst\n$/)
    // An unhandled error reports its name, origin, call path and value, as on native targets.
    yield* fs.writeFileString(
      join(directory, 'main.silk'),
      [
        'import silk.io.writer {Writer, WriterError}',
        'import silk.text.format {Debug, Format, Formatter}',
        'pub struct ConfigError { pub code: i32 }',
        'impl Debug for ConfigError {',
        '  effect fn debug(self: &Self, formatter: &mut Formatter) -> () ! WriterError ? &mut Writer {',
        '    return run Format.debugFields(self, "ConfigError", &mut formatter)',
        '  }',
        '}',
        'effect fn load(code: i32) -> i32 ! ConfigError { if code > 0 { fail ConfigError { code: code } } return code }',
        'effect fn configure(code: i32) -> i32 ! ConfigError { return run load(code) }',
        'pub effect fn main() -> () ! ConfigError { let code = run configure(7) }',
        '',
      ].join('\n'),
    )
    const unhandled = yield* invoke(compiler, ['run', '--target', target, '--stdlib', join(repo, 'stdlib'), '--quiet'])
    assert.equal(unhandled.status, 1, unhandled.stderr.toString())
    assert.match(
      unhandled.stderr.toString(),
      /unhandled error: main\.ConfigError\n {2}at main\.load \(main:9:\d+\)\n {2}at main\.configure \(main:10:\d+\)\n {2}at main\.main \(main:11:\d+\)\nunhandled value: ConfigError \{ code: 7 \}\n/,
    )
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
    const examples = join(directory, `examples-${target}`)
    const nested = join(examples, 'nested')
    yield* fs.makeDirectory(nested, { recursive: true })
    yield* fs.writeFileString(
      join(examples, 'silk.toml'),
      `[package]\nname = "wasi-examples"\nsource = "."\n[build]\nprofile = "wasi"\n[profiles.wasi]\ntarget = "${target}"\n`,
    )
    yield* fs.writeFileString(join(examples, 'marker'), 'package directory')
    const example = [
      'import silk.mem.allocator { Allocator, OutOfMemoryError }',
      'import silk.core.effect { Effect }',
      'import silk.system.filesystem { FileSystem, FileError, Path }',
      'import silk.system.filesystem_native { OsFileSystem }',
      'pub effect fn main() -> i32 ! FileError | OutOfMemoryError {',
      '  let mut allocator = Allocator.systemAllocatorProvider()',
      '  let mut fs = run OsFileSystem.make("/") |> Effect.provideMut<Allocator>(&mut allocator)',
      '  let path = run Path.make("/marker") |> Effect.provideMut<Allocator>(&mut allocator)',
      '  let present = run FileSystem.exists(&path) |> Effect.provideMut<FileSystem>(&mut fs)',
      '  if present { return 0 }',
      '  return 1',
      '}',
    ]
    yield* fs.writeFileString(
      join(examples, 'main.silk'),
      [
        '/// ```silk',
        ...example.map((line) => `/// ${line}`),
        '/// ```',
        'pub fn main() -> () {}',
        '',
      ].join('\n'),
    )
    const documented = yield* invoke(compiler, ['doctest', '--stdlib-root', join(repo, 'stdlib')], {
      cwd: nested,
    })
    assert.equal(documented.status, 0, documented.stderr.toString() + documented.stdout.toString())
    assert.match(documented.stdout.toString(), /1 collected, 1 passed, 0 skipped, 0 failed/)
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
  yield* WasiComponents.verify(compiler, clang, tools, repo, directory)
  yield* Console.log(
    'WASI Preview 1 and Preview 2: services, capability confinement, command entries, components, sockets, DNS, HTTP client/server, WIT composition, run, test, doctest, emission stages, and atomic publication passed',
  )
})
await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
