import { assert, it } from '@effect/vitest'
import * as NativeToolchain from '@silklang/compiler/NativeToolchain'
import * as Console from 'effect/Console'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Result from 'effect/Result'
import { Command } from 'effect/unstable/cli'
import * as Cli from '../src/Cli.js'
import * as Program from '../src/Program.js'
import * as CompilerHost from './CompilerHost.js'
import * as Timeouts from './timeouts.js'

it('exposes the project-first command surface without a compile alias', () => {
  const names = Cli.command.subcommands.flatMap((group) =>
    group.commands.map((command) => command.name),
  )

  assert.deepStrictEqual(names, [
    'init',
    'build',
    'check',
    'clean',
    'doc',
    'doctest',
    'docs-site',
    'format',
    'run',
    'test',
    'build-exe',
  ])
  assert.strictEqual(names.includes('compile'), false)
})

it.effect(
  'initializes a project that loads, checks, builds, and runs with defaults',
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const root = yield* fileSystem.makeTempDirectoryScoped()
      const execute = (arguments_: ReadonlyArray<string>) =>
        Effect.result(Command.runWith(Cli.command, { version: 'test' })(arguments_))

      const projectRoot = `${root}/hello`
      const initialized = yield* execute(['init', projectRoot])
      assert.strictEqual(Result.isSuccess(initialized), true)
      assert.strictEqual(
        yield* fileSystem.readFileString(`${projectRoot}/src/main.silk`),
        'import silk.effect { Effect }\nimport silk.logger { LogError }\nimport silk.os_logger { StdoutLogger }\n\npub effect fn main() -> () ! LogError {\n  let mut logger = StdoutLogger.make()\n\n  run Effect.log("Hello, world!", &())\n    |> Effect.provideMut(&mut logger)\n}\n',
      )
      const loaded = yield* execute(['check', '--manifest-path', `${projectRoot}/silk.toml`])
      assert.strictEqual(Result.isSuccess(loaded), true)
      const built = yield* execute(['build', '--manifest-path', `${projectRoot}/silk.toml`])
      assert.strictEqual(Result.isSuccess(built), true)
      // `run` would compile the project a second time; its argument and exit-status mapping is
      // covered below, so the built executable runs directly.
      const host = yield* NativeToolchain.hostTarget()
      assert.strictEqual(yield* Program.run(`${projectRoot}/build/llvm/${host.id}/debug/hello`), 0)
    }).pipe(Effect.scoped, Effect.provide(CompilerHost.layer)),
  // Check and build each drive a compiler pipeline; CI exceeds one build budget.
  2 * Timeouts.nativeBuild,
)

it.effect(
  'parses run arguments after -- and preserves the program exit status',
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const root = yield* fileSystem.makeTempDirectoryScoped()
      yield* fileSystem.writeFileString(
        `${root}/silk.toml`,
        '[package]\nname = "cli-integration"\nversion = "0.1.0"\nroot = "Main.silk"\n',
      )
      yield* fileSystem.writeFileString(`${root}/Main.silk`, 'pub fn main() -> i32 { return 42 }')

      const executed = yield* Effect.result(
        Command.runWith(Cli.command, { version: 'test' })([
          'run',
          '--manifest-path',
          `${root}/silk.toml`,
          '--',
          '--literal-flag',
          'value',
        ]),
      )

      assert.strictEqual(Result.isFailure(executed), true)
      if (Result.isFailure(executed)) {
        assert.strictEqual(executed.failure._tag, 'CommandExit')
        if (executed.failure._tag === 'CommandExit') assert.strictEqual(executed.failure.status, 42)
      }
    }).pipe(Effect.scoped, Effect.provide(CompilerHost.layer)),
  Timeouts.nativeBuild,
)

it.effect(
  'runs tests from an import-only root with combined runtime filters',
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const root = yield* fileSystem.makeTempDirectoryScoped()
      yield* fileSystem.writeFileString(
        `${root}/silk.toml`,
        '[package]\nname = "test-integration"\nversion = "0.1.0"\nroot = "Main.silk"\n',
      )
      yield* fileSystem.writeFileString(`${root}/Main.silk`, 'pub fn main() -> i32 { return 9 }')
      yield* fileSystem.writeFileString(`${root}/Tests.silk`, 'import Cases')
      yield* fileSystem.writeFileString(
        `${root}/Cases.silk`,
        `import silk.effect { Effect }
service Clock { effect fn value() -> i32 ? &Clock }
struct Fixed { value: i32 }
effect fn fixedValue(self: &Fixed) -> i32 { return self.value }
impl Clock for Fixed { value: Fixed.fixedValue }
effect fn read() -> i32 ? &Clock { return run Clock.value() }
effect fn readWithFixedClock() -> () {
  let fixed = Fixed { value: 42 }
  let value = run read() |> Effect.provide<Clock>(&fixed)
  drop value
  return ()
}
test fn succeeds() {}
test effect fn fails() ! bool { fail false }
test effect fn locallyProvided() -> () ! bool {
  run readWithFixedClock()
  fail false
}`,
      )

      const executed = yield* Effect.result(
        Command.runWith(Cli.command, { version: 'test' })([
          'test',
          '--manifest-path',
          `${root}/silk.toml`,
          '--root',
          'Tests.silk',
          '--file',
          'Cases.silk',
          '--filter',
          'PROVIDED',
        ]),
      )

      assert.strictEqual(Result.isFailure(executed), true)
      if (Result.isFailure(executed)) {
        assert.strictEqual(executed.failure._tag, 'CommandExit')
        if (executed.failure._tag === 'CommandExit') assert.strictEqual(executed.failure.status, 1)
      }
    }).pipe(Effect.scoped, Effect.provide(CompilerHost.layer)),
  Timeouts.nativeBuild,
)

// Edit invalidation, failure non-caching and filters are owned by Workflow.test.ts,
// TestResult.test.ts, the compiler's TestDiscovery.test.ts and the filter test above. Each `silk
// test` run here compiles natively, so this keeps only the runs that prove the end-to-end cache
// contract: a cold run executes, a warm run reuses, and `--no-cache` executes without the cache.
it.effect(
  'reuses an unchanged passing test and bypasses the result cache with --no-cache',
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const root = yield* fileSystem.makeTempDirectoryScoped()
      const nativeRoot = yield* fileSystem.realPath(root)
      yield* fileSystem.writeFileString(
        `${root}/silk.toml`,
        '[package]\nname = "test-result-cache"\nversion = "0.1.0"\nroot = "Main.silk"\n',
      )
      yield* fileSystem.writeFileString(`${root}/Main.silk`, 'pub fn main() -> i32 { return 0 }')
      yield* fileSystem.writeFileString(
        `${root}/Tests.silk`,
        `import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.filesystem { FileError, FileSystem, Path }
import silk.os_filesystem { OsFileSystem }

test effect fn removesMarker() -> () ! FileError | OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let mut fs = run OsFileSystem.make(b"${nativeRoot}") |> Effect.provideMut(&mut allocator)
  let marker = run Path.make("/marker") |> Effect.provideMut(&mut allocator)
  run FileSystem.removeFile(&marker) |> Effect.provideMut(&mut fs)
}`,
      )

      const run = (arguments_: ReadonlyArray<string>) =>
        Effect.result(
          Command.runWith(Cli.command, { version: 'test' })([
            'test',
            '--manifest-path',
            `${root}/silk.toml`,
            '--root',
            'Tests.silk',
            ...arguments_,
          ]),
        )
      const seed = fileSystem.writeFileString(`${root}/marker`, 'marker')
      const executed = Effect.map(fileSystem.exists(`${root}/marker`), (exists) => !exists)
      const resultRecords = Effect.fnUntraced(function* () {
        const directory = `${root}/build/.silk-cache/test-results-v1`
        const names = (yield* fileSystem.readDirectory(directory)).toSorted()
        return yield* Effect.forEach(names, (name) =>
          fileSystem
            .readFile(`${directory}/${name}`)
            .pipe(Effect.map((bytes) => [name, Array.from(bytes)] as const)),
        )
      })

      yield* seed
      const cold = yield* run([])
      assert.isTrue(
        Result.isSuccess(cold),
        Result.isFailure(cold) ? String(cold.failure) : undefined,
      )
      assert.isTrue(yield* executed)
      const records = yield* resultRecords()
      assert.lengthOf(records, 1)

      yield* seed
      assert.isTrue(Result.isSuccess(yield* run([])))
      assert.isFalse(yield* executed)

      assert.isTrue(Result.isSuccess(yield* run(['--no-cache'])))
      assert.isTrue(yield* executed)
      assert.deepStrictEqual(yield* resultRecords(), records)
    }).pipe(Effect.scoped, Effect.provide(CompilerHost.layer)),
  // Three successive runner processes each compile the project natively.
  3 * Timeouts.nativeBuild,
)

it.effect(
  'rejects a discovered broken test before applying its nonmatching runtime filter',
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const root = yield* fileSystem.makeTempDirectoryScoped()
      yield* fileSystem.writeFileString(
        `${root}/silk.toml`,
        '[package]\nname = "test-filter-boundary"\nversion = "0.1.0"\nroot = "Main.silk"\n',
      )
      yield* fileSystem.writeFileString(
        `${root}/Main.silk`,
        `service Clock { fn now() -> i32 }
test fn selected() {}
test effect fn broken() -> () ? &Clock { return () }`,
      )

      const executed = yield* Effect.result(
        Command.runWith(Cli.command, { version: 'test' })([
          'test',
          '--manifest-path',
          `${root}/silk.toml`,
          '--filter',
          'selected',
        ]),
      )

      assert.strictEqual(Result.isFailure(executed), true)
      if (Result.isFailure(executed)) {
        assert.strictEqual(executed.failure._tag, 'CommandExit')
        if (executed.failure._tag === 'CommandExit') assert.strictEqual(executed.failure.status, 1)
      }
    }).pipe(Effect.scoped, Effect.provide(CompilerHost.layer)),
  Timeouts.nativeBuild,
)

it('lists clean with its purpose in root help', () => {
  const clean = Cli.command.subcommands
    .flatMap((group) => group.commands)
    .find((command) => command.name === 'clean')

  assert.notStrictEqual(clean, undefined)
  assert.strictEqual(clean?.description, 'Remove the build artifacts of the nearest Silk project.')
})

it('lists test with its discovery purpose in root help', () => {
  const test = Cli.command.subcommands
    .flatMap((group) => group.commands)
    .find((command) => command.name === 'test')

  assert.notStrictEqual(test, undefined)
  assert.strictEqual(
    test?.description,
    'Build and run tests reachable from one project source root.',
  )
})

it.effect('documents the result-cache bypass in test help', () =>
  Effect.gen(function* () {
    const output: Array<string> = []
    const reportingConsole: Console.Console = Object.assign(Object.create(console), {
      log: (...args: ReadonlyArray<unknown>) => output.push(args.join(' ')),
      error: (...args: ReadonlyArray<unknown>) => output.push(args.join(' ')),
    })
    const executed = yield* Effect.result(
      Command.runWith(Cli.command, { version: 'test' })(['test', '--help']).pipe(
        Effect.provideService(Console.Console, reportingConsole),
      ),
    )
    assert.isTrue(Result.isSuccess(executed))
    assert.include(output.join('\n'), '--no-cache')
    assert.include(
      output.join('\n'),
      'Execute selected tests without reading or writing persistent results.',
    )
    assert.notInclude(output.join('\n'), '--watch')
  }).pipe(Effect.provide(CompilerHost.layer)),
)

it.effect('rejects the removed compile subcommand', () =>
  Effect.gen(function* () {
    const executed = yield* Effect.result(
      Command.runWith(Cli.command, { version: 'test' })(['compile']),
    )
    assert.strictEqual(Result.isFailure(executed), true)
    if (Result.isFailure(executed)) assert.notStrictEqual(executed.failure._tag, 'CommandExit')
  }).pipe(Effect.provide(CompilerHost.layer)),
)
