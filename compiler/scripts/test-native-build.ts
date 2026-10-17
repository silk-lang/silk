// One prebuilt native compiler exercises its private request/build routes together.
import { strict as assert } from 'node:assert'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as Config from 'effect/Config'
import * as Console from 'effect/Console'
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Schema from 'effect/Schema'

// The ambient search path; tests prepend their own tools to it.
const ambientPath = Config.String('PATH').pipe(Config.withDefault(''), Effect.orDie)
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

class VerificationError extends Data.TaggedError('NativeBuildVerificationError')<{
  readonly message: string
  readonly cause: unknown
}> {}
const invoke = Effect.fnUntraced(function* (
  command: string,
  args: ReadonlyArray<string>,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<SpawnSyncReturns<string>, VerificationError> {
  return yield* Effect.try({
    try: () => spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 30_000 }),
    catch: (cause) => new VerificationError({ message: 'Native CLI invocation failed', cause }),
  })
})
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`
const program = Effect.gen(function* () {
  const compiler = process.argv[2]
  const tool = process.argv[3]
  assert.ok(compiler && tool, 'usage: node test-native-build.ts <native-compiler> <clang>')
  const silk = resolve(compiler)
  const clang = resolve(tool)
  const fs = yield* FileSystem.FileSystem
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'silk-native-build-' })
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  // Reuse the existing small shared acceptance program without importing the bootstrap.
  const source = yield* fs.readFileString(
    join(repository, 'corpus/native/operator-precedence/main.silk'),
  )
  assert.ok(!source.includes('/*@splice'), 'expected the plain operator-precedence program')
  yield* fs.writeFileString(join(directory, 'main.silk'), source)
  yield* fs.writeFileString(
    join(directory, 'silk.toml'),
    '[package]\nname = "native-build"\nversion = "0.1.0"\nroot = "main.silk"\n',
  )
  const sentinel = join(directory, 'clang-sentinel')
  const marker = join(directory, 'clang-called')
  yield* fs.writeFileString(sentinel, `#!/bin/sh\nprintf called > ${quote(marker)}\nexit 99\n`)
  yield* fs.chmod(sentinel, 0o755)
  // The standard library supplies the catalog runtime that roots the build.
  const standardLibrary = join(repository, 'packages/compiler/stdlib')
  const argumentsFor = (output: string) => [
    'build',
    'main.silk',
    '-o',
    output,
    '--stdlib',
    standardLibrary,
  ]
  // `--version` and `--help` answer on standard output without reading any source.
  const versioned = yield* invoke(silk, ['--version'], directory)
  assert.equal(versioned.status, 0, versioned.stderr)
  assert.match(versioned.stdout, /^silk v\d+\.\d+\.\d+\n$/)
  const helped = yield* invoke(silk, ['--help'], directory)
  assert.equal(helped.status, 0, helped.stderr)
  assert.match(helped.stdout, /usage: silk build/)
  const ir = yield* invoke(silk, [...argumentsFor('module.ll'), '--emit', 'llvm-ir'], directory, {
    ...process.env,
    SILK_CLANG: sentinel,
  })
  assert.equal(ir.status, 0, ir.stderr)
  assert.equal(ir.error, undefined)
  assert.equal(yield* fs.exists(marker), false, 'IR output must not invoke Clang')
  assert.equal(yield* fs.exists(join(directory, 'module.ll.silk.ll')), false)
  const bytes = yield* fs.readFile(join(directory, 'module.ll'))
  assert.ok(bytes.length > 0)
  const verified = yield* invoke(
    clang,
    ['-x', 'ir', '-c', 'module.ll', '-o', 'verified.o'],
    directory,
  )
  assert.equal(verified.status, 0, verified.stderr)
  const captured = join(directory, 'completed-backend.ll')
  const linker = join(directory, 'clang-capture')
  yield* fs.writeFileString(
    linker,
    `#!/bin/sh\nfor input in "$@"; do\ncase "$input" in\n*.silk.ll) cp "$input" ${quote(captured)} ;;\nesac\ndone\nexec ${quote(clang)} "$@"\n`,
  )
  yield* fs.chmod(linker, 0o755)
  const linked = yield* invoke(silk, argumentsFor('program'), directory, {
    ...process.env,
    SILK_CLANG: linker,
  })
  assert.equal(linked.status, 0, linked.stderr)
  assert.deepEqual(
    yield* fs.readFile(captured),
    bytes,
    'IR selector must retain the exact completed bytes passed to executable linking',
  )
  assert.equal(yield* fs.exists(join(directory, 'program.silk.ll')), false)
  const ran = yield* invoke(join(directory, 'program'), [], directory)
  assert.equal(ran.status, 42, ran.stderr)
  const explicit = yield* invoke(
    silk,
    [...argumentsFor('explicit'), '--emit', 'final'],
    directory,
    { ...process.env, SILK_CLANG: clang },
  )
  assert.equal(explicit.status, 0, explicit.stderr)
  assert.equal(yield* fs.exists(join(directory, 'explicit.silk.ll')), false)
  // Without SILK_CLANG the compiler runs the first `clang` on PATH, also through a symbolic link
  // as PATH entries usually are, and with none there it refuses before linking.
  const ambient = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => name !== 'SILK_CLANG'),
  )
  const pathTools = join(directory, 'tools')
  yield* fs.makeDirectory(pathTools)
  yield* fs.symlink(sentinel, join(pathTools, 'clang'))
  const onPath = yield* invoke(silk, argumentsFor('on-path'), directory, {
    ...ambient,
    PATH: `${pathTools}:${yield* ambientPath}`,
  })
  assert.notEqual(onPath.status, 0, 'the sentinel clang fails the link')
  assert.equal(yield* fs.exists(marker), true, 'the clang on PATH must run')
  yield* fs.remove(marker)
  yield* fs.makeDirectory(join(directory, 'no-tools'))
  const clangless = yield* invoke(silk, argumentsFor('clangless'), directory, {
    ...ambient,
    PATH: join(directory, 'no-tools'),
  })
  assert.equal(clangless.status, 2, 'a missing clang is an operational failure')
  assert.equal(yield* fs.exists(join(directory, 'clangless')), false)
  // `--clang` wins over SILK_CLANG: a path resolves against the working directory and a bare name
  // is searched on PATH.
  const flagged = yield* invoke(
    silk,
    [...argumentsFor('flagged'), '--clang', './clang-sentinel'],
    directory,
    { ...process.env, SILK_CLANG: clang },
  )
  assert.notEqual(flagged.status, 0, 'the sentinel clang fails the link')
  assert.equal(yield* fs.exists(marker), true, 'the --clang path must run')
  yield* fs.remove(marker)
  const named = yield* invoke(silk, [...argumentsFor('named'), '--clang', 'clang'], directory, {
    ...process.env,
    SILK_CLANG: clang,
    PATH: `${pathTools}:${yield* ambientPath}`,
  })
  assert.notEqual(named.status, 0, 'the sentinel clang fails the link')
  assert.equal(yield* fs.exists(marker), true, 'a bare --clang name must run from PATH')
  yield* fs.remove(marker)
  const unnamed = yield* invoke(
    silk,
    [...argumentsFor('unnamed'), '--clang', 'no-such-clang'],
    directory,
    { ...process.env, SILK_CLANG: clang },
  )
  assert.equal(unnamed.status, 2, 'a --clang name missing from PATH is an operational failure')
  assert.equal(yield* fs.exists(join(directory, 'unnamed')), false)
  // Another target emits its IR without linking; only the host target links an executable.
  const foreign =
    process.platform === 'darwin' ? 'x86_64-unknown-linux-gnu' : 'aarch64-apple-darwin'
  const cross = yield* invoke(
    silk,
    [...argumentsFor('cross.ll'), '--emit', 'llvm-ir', '--target', foreign],
    directory,
    { ...process.env, SILK_CLANG: sentinel },
  )
  assert.equal(cross.status, 0, cross.stderr)
  assert.equal(yield* fs.exists(marker), false, 'cross-target IR output must not invoke Clang')
  const crossIr = yield* fs.readFile(join(directory, 'cross.ll'))
  assert.ok(crossIr.length > 0)
  assert.notDeepEqual(crossIr, bytes, 'IR must follow the requested target, not the host')
  for (const selectors of [
    ['--emit', 'invalid'],
    ['--emit'],
    ['--emit', 'llvm-ir', '--emit', 'llvm-ir'],
    ['--emit', 'final', '--emit', 'llvm-ir'],
    // The artifact form is the manifest's `[build].artifact`; `--emit` names only a stage.
    ['--emit', 'executable'],
    ['--target', foreign],
    ['--emit', 'llvm-ir', '--target', 'no-such-target'],
    ['--emit', 'llvm-ir', '--target', foreign, '--target', foreign],
  ]) {
    const rejected = yield* invoke(silk, [...argumentsFor('rejected'), ...selectors], directory, {
      ...process.env,
      SILK_CLANG: sentinel,
    })
    assert.notEqual(rejected.status, 0, `accepted invalid selector ${selectors.join(' ')}`)
    assert.equal(yield* fs.exists(join(directory, 'rejected')), false)
    assert.equal(yield* fs.exists(marker), false)
  }
  // `run` builds the nearest project's debug executable below its output directory, then
  // becomes that program: the program's arguments and exit status pass through unchanged.
  const project = yield* invoke(
    silk,
    ['run', '--stdlib', standardLibrary, 'first', '--', '--stdlib'],
    directory,
    { ...process.env, SILK_CLANG: clang },
  )
  assert.equal(project.status, 42, project.stderr)
  const [hostTarget] = yield* fs.readDirectory(join(directory, 'build/llvm'))
  assert.ok(hostTarget, 'run must place its executable below build/llvm/<target>')
  assert.equal(
    yield* fs.exists(join(directory, 'build/llvm', hostTarget, 'debug/native-build')),
    true,
  )
  // `clean` removes the whole output directory; a project already clean stays clean.
  const cleaned = yield* invoke(silk, ['clean'], directory)
  assert.equal(cleaned.status, 0, cleaned.stderr)
  assert.equal(yield* fs.exists(join(directory, 'build')), false)
  assert.equal(yield* fs.exists(join(directory, 'main.silk')), true)
  const recleaned = yield* invoke(silk, ['clean'], directory)
  assert.equal(recleaned.status, 0, recleaned.stderr)
  // `init` writes a project whose generated entry `run` builds and runs.
  const initialized = yield* invoke(silk, ['init', 'greeting'], directory)
  assert.equal(initialized.status, 0, initialized.stderr)
  const greeted = yield* invoke(
    silk,
    ['run', '--stdlib', standardLibrary],
    join(directory, 'greeting'),
    { ...process.env, SILK_CLANG: clang },
  )
  assert.equal(greeted.status, 0, greeted.stderr)
  assert.match(greeted.stdout, /Hello, world!/)
  // An installed compiler finds `<prefix>/lib/silk/stdlib` beside `<prefix>/bin` without
  // `--stdlib`, also through a symbolic link in another directory and as a bare name on PATH.
  const prefix = join(directory, 'prefix')
  yield* fs.makeDirectory(join(prefix, 'bin'), { recursive: true })
  yield* fs.makeDirectory(join(prefix, 'lib/silk'), { recursive: true })
  yield* fs.copyFile(silk, join(prefix, 'bin/silk'))
  yield* fs.chmod(join(prefix, 'bin/silk'), 0o755)
  yield* fs.copy(standardLibrary, join(prefix, 'lib/silk/stdlib'))
  const links = join(directory, 'links')
  yield* fs.makeDirectory(links)
  yield* fs.symlink(join(prefix, 'bin/silk'), join(links, 'silk'))
  const symlinked = yield* invoke(join(links, 'silk'), ['run'], join(directory, 'greeting'), {
    ...process.env,
    SILK_CLANG: clang,
  })
  assert.equal(symlinked.status, 0, symlinked.stderr)
  assert.match(symlinked.stdout, /Hello, world!/)
  const searched = yield* invoke('silk', ['run'], join(directory, 'greeting'), {
    ...process.env,
    PATH: `${links}:${yield* ambientPath}`,
    SILK_CLANG: clang,
  })
  assert.equal(searched.status, 0, searched.stderr)
  // Without an installation beside it, the compiler still needs `--stdlib`.
  yield* fs.makeDirectory(join(directory, 'bare/bin'), { recursive: true })
  yield* fs.copyFile(silk, join(directory, 'bare/bin/silk'))
  yield* fs.chmod(join(directory, 'bare/bin/silk'), 0o755)
  const uninstalled = yield* invoke(
    join(directory, 'bare/bin/silk'),
    ['run'],
    join(directory, 'greeting'),
    { ...process.env, SILK_CLANG: sentinel },
  )
  assert.notEqual(uninstalled.status, 0, 'a compiler without an installation needs --stdlib')
  assert.equal(yield* fs.exists(marker), false)
  // `check` analyzes every planned target without producing an artifact, a foreign one too, and
  // reports rejections of unreached declarations as `silk check` does.
  const checked = yield* invoke(
    silk,
    ['check', '--target', 'host', '--target', foreign, '--stdlib', standardLibrary],
    join(directory, 'greeting'),
    { ...process.env, SILK_CLANG: sentinel },
  )
  assert.equal(checked.status, 0, checked.stderr)
  assert.match(checked.stdout, new RegExp(`check ${hostTarget}: ok\n`))
  assert.match(
    checked.stdout,
    new RegExp(`check ${foreign}: ok\nCheck summary: 2 succeeded, 0 failed\n$`),
  )
  assert.equal(yield* fs.exists(marker), false, 'check must not invoke Clang')
  yield* fs.makeDirectory(join(directory, 'rejected/src'), { recursive: true })
  yield* fs.writeFileString(
    join(directory, 'rejected/silk.toml'),
    '[package]\nname = "rejected"\nversion = "0.1.0"\nroot = "src/main.silk"\n',
  )
  yield* fs.writeFileString(
    join(directory, 'rejected/src/main.silk'),
    'pub fn main() -> i32 {\n  return 0\n}\n\nfn unused() -> i32 {\n  let x: i32 = true\n  return x\n}\n',
  )
  const rejected = yield* invoke(
    silk,
    ['check', '--stdlib', standardLibrary],
    join(directory, 'rejected'),
  )
  assert.equal(rejected.status, 1, rejected.stderr)
  assert.match(rejected.stderr, new RegExp(`^\\[${hostTarget}\\]\n`))
  assert.match(rejected.stderr, /\/rejected\/src\/main\.silk:6:16: error\[SEM0037\]/)
  assert.match(rejected.stdout, new RegExp(`check ${hostTarget}: failed \\(exit 1\\)\n`))
  const json = yield* invoke(
    silk,
    ['check', '--json', '--stdlib', standardLibrary],
    join(directory, 'rejected'),
  )
  assert.equal(json.status, 1, json.stderr)
  const reported = json.stderr
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map(
      (line) =>
        JSON.parse(line) as {
          code: string
          path: string
          line: number
          column: number
          target: string
        },
    )
  assert.ok(
    reported.some(
      (entry) =>
        entry.code === 'SEM0037' &&
        entry.path.endsWith('/rejected/src/main.silk') &&
        entry.line === 6 &&
        entry.column === 16,
    ),
    json.stderr,
  )
  // `test` builds the project's runner below <output-dir>/test as an executable, whatever the
  // manifest's artifact, and runs the tests that --file and --filter select; a failing test makes
  // the status 1, and a selection outside the source root is refused before anything is built.
  yield* fs.makeDirectory(join(directory, 'tested/src/util'), { recursive: true })
  yield* fs.writeFileString(
    join(directory, 'tested/silk.toml'),
    '[package]\nname = "tested"\nversion = "0.1.0"\nroot = "src/main.silk"\n[build]\nartifact = "static-library"\n',
  )
  yield* fs.writeFileString(
    join(directory, 'tested/src/main.silk'),
    'import util.check\n\npub fn answer() -> i32 {\n  return check.half(84)\n}\n\ntest fn rootPasses() -> () {\n}\n',
  )
  yield* fs.writeFileString(
    join(directory, 'tested/src/util/check.silk'),
    'import silk.testing { AssertionError, Testing }\n\npub fn half(value: i32) -> i32 {\n  return value / 2\n}\n\ntest effect fn halvesEvenly() -> () ! AssertionError<\'static> {\n  run Testing.expect(half(84) == 42, "84 halves to 42")\n}\n\ntest effect fn failsOnPurpose() -> () ! AssertionError<\'static> {\n  run Testing.expect(half(3) == 2, "integer division truncates")\n}\n',
  )
  const selectedTests = yield* invoke(
    silk,
    [
      'test',
      '--no-cache',
      '--stdlib',
      standardLibrary,
      '--file',
      'src/util/check.silk',
      '--filter',
      'EVEN',
    ],
    join(directory, 'tested'),
    { ...process.env, SILK_CLANG: clang },
  )
  assert.equal(selectedTests.status, 0, selectedTests.stderr)
  assert.match(selectedTests.stdout, /util\/check::halvesEvenly\n/)
  assert.match(
    selectedTests.stdout,
    /1 passed, 0 failed \(0 cached, 1 executed, 1 selected, 3 discovered\)/,
  )
  assert.equal(
    yield* fs.exists(join(directory, 'tested/build/test/llvm', hostTarget, 'debug/tested')),
    true,
  )
  const failedTests = yield* invoke(
    silk,
    ['test', '--no-cache', '--stdlib', standardLibrary],
    join(directory, 'tested'),
    { ...process.env, SILK_CLANG: clang },
  )
  assert.equal(failedTests.status, 1, failedTests.stderr)
  assert.match(failedTests.stdout, /2 passed, 1 failed/)
  for (const selection of [['--root', 'main.silk'], ['--file', 'src/util/check.txt'], []]) {
    const refusedTests = yield* invoke(
      silk,
      [
        'test',
        '--stdlib',
        standardLibrary,
        ...(selection.length === 0 ? [] : ['--no-cache', ...selection]),
      ],
      join(directory, 'tested'),
      { ...process.env, SILK_CLANG: sentinel },
    )
    assert.equal(refusedTests.status, 2, `test accepted ${selection.join(' ') || 'a cached run'}`)
  }
  assert.equal(yield* fs.exists(marker), false)
  const repeated = yield* invoke(silk, ['init', 'greeting'], directory)
  assert.equal(repeated.status, 2, 'init must refuse an existing manifest')
  // A project `build` names its manifest instead of discovering one, and `--release` selects the
  // release profile directory; `run` refuses a foreign target before building anything.
  const manifest = join('greeting', 'silk.toml')
  const released = yield* invoke(
    silk,
    [
      'build',
      '--manifest-path',
      manifest,
      '--release',
      '--target',
      'host',
      '--stdlib',
      standardLibrary,
    ],
    directory,
    { ...process.env, SILK_CLANG: clang },
  )
  assert.equal(released.status, 0, released.stderr)
  assert.match(released.stdout, /Build summary: 1 succeeded, 0 failed/)
  // Each compilation names its source and artifact relative to the project, as `silk build` does.
  assert.match(
    released.stdout,
    new RegExp(
      `^Compiled src/main\\.silk -> build/llvm/${hostTarget}/release/greeting \\(llvm, ${hostTarget}, [1-9][0-9]* symbols\\)\n`,
    ),
  )
  assert.equal(
    yield* fs.exists(join(directory, 'greeting/build/llvm', hostTarget, 'release/greeting')),
    true,
  )
  const foreignRun = yield* invoke(
    silk,
    ['run', '--manifest-path', manifest, '--target', foreign, '--stdlib', standardLibrary],
    directory,
    { ...process.env, SILK_CLANG: sentinel },
  )
  assert.equal(foreignRun.status, 2, 'run must refuse a foreign target')
  assert.equal(yield* fs.exists(marker), false)
  // A named profile builds once in the directory its optimization names, and conflicts with
  // --release before anything is built.
  yield* fs.writeFileString(
    join(directory, manifest),
    (yield* fs.readFileString(join(directory, manifest))) +
      `\n[profiles.fast]\ntarget = "${hostTarget}"\noptimization = "speed"\ndebug = true\n`,
  )
  const profiled = yield* invoke(
    silk,
    ['build', '--manifest-path', manifest, '--profile', 'fast', '--stdlib', standardLibrary],
    directory,
    { ...process.env, SILK_CLANG: clang },
  )
  assert.equal(profiled.status, 0, profiled.stderr)
  assert.equal(
    yield* fs.exists(
      join(directory, 'greeting/build/llvm', hostTarget, 'release-with-debug/greeting'),
    ),
    true,
  )
  const conflicting = yield* invoke(
    silk,
    ['build', '--manifest-path', manifest, '--profile', 'fast', '--release'],
    directory,
    { ...process.env, SILK_CLANG: sentinel },
  )
  assert.equal(conflicting.status, 2, 'a named profile must conflict with --release')
  assert.equal(yield* fs.exists(marker), false)
  // `[build].bindings` reach the package parameters of every project build.
  yield* fs.makeDirectory(join(directory, 'bound/src'), { recursive: true })
  yield* fs.writeFileString(
    join(directory, 'bound/src/main.silk'),
    'pub param limit: i32 = 1\n\npub fn main() -> i32 {\n  return limit\n}\n',
  )
  yield* fs.writeFileString(
    join(directory, 'bound/silk.toml'),
    '[package]\nname = "bound"\nversion = "0.1.0"\nroot = "src/main.silk"\n\n[[build.bindings]]\npackage = "bound@0.1.0"\nmodule = "main"\nparameter = "limit"\nvalue = { kind = "integer", value = "7" }\norigin = { source = "silk.toml", provenance = "literal" }\n',
  )
  const bound = yield* invoke(
    silk,
    ['run', '--stdlib', standardLibrary],
    join(directory, 'bound'),
    {
      ...process.env,
      SILK_CLANG: clang,
    },
  )
  assert.equal(bound.status, 7, bound.stderr)
  // `[package].source-root` roots module resolution above the entry's own directory.
  yield* fs.makeDirectory(join(directory, 'rooted/src/app'), { recursive: true })
  yield* fs.makeDirectory(join(directory, 'rooted/src/lib'), { recursive: true })
  yield* fs.writeFileString(
    join(directory, 'rooted/src/lib/limit.silk'),
    'pub fn limit() -> i32 {\n  return 9\n}\n',
  )
  yield* fs.writeFileString(
    join(directory, 'rooted/src/app/main.silk'),
    'import lib.limit { limit }\n\npub fn main() -> i32 {\n  return limit()\n}\n',
  )
  yield* fs.writeFileString(
    join(directory, 'rooted/silk.toml'),
    '[package]\nname = "rooted"\nversion = "0.1.0"\nroot = "src/app/main.silk"\nsource-root = "src"\n',
  )
  const rooted = yield* invoke(
    silk,
    ['run', '--stdlib', standardLibrary],
    join(directory, 'rooted'),
    {
      ...process.env,
      SILK_CLANG: clang,
    },
  )
  assert.equal(rooted.status, 9, rooted.stderr)
  // A path dependency's modules are imported under its dependency name; its own imports stay in
  // its own package, so both packages can have a `util/digits` module.
  yield* fs.makeDirectory(join(directory, 'packaged/app/util'), { recursive: true })
  yield* fs.makeDirectory(join(directory, 'packaged/numbers/src/util'), { recursive: true })
  yield* fs.writeFileString(
    join(directory, 'packaged/numbers/src/util/digits.silk'),
    'pub fn base() -> i32 {\n  return 10\n}\n',
  )
  yield* fs.writeFileString(
    join(directory, 'packaged/numbers/src/scale.silk'),
    'import util.digits { base }\n\npub fn scale(value: i32) -> i32 {\n  return value * base()\n}\n',
  )
  yield* fs.writeFileString(
    join(directory, 'packaged/numbers/silk.toml'),
    '[package]\nname = "silk-numbers"\nversion = "0.2.0"\nsource-root = "src"\n',
  )
  yield* fs.writeFileString(
    join(directory, 'packaged/app/util/digits.silk'),
    'pub fn base() -> i32 {\n  return 4\n}\n',
  )
  yield* fs.writeFileString(
    join(directory, 'packaged/app/main.silk'),
    'import numbers.scale { scale }\nimport util.digits { base }\n\npub fn main() -> i32 {\n  return scale(base()) + 2\n}\n',
  )
  const packagedManifest = (dependency: string) =>
    `[package]\nname = "app"\nversion = "1.0.0"\nroot = "main.silk"\n\n[dependencies]\n${dependency}\n`
  yield* fs.writeFileString(
    join(directory, 'packaged/app/silk.toml'),
    packagedManifest('numbers = { path = "../numbers", package = "silk-numbers" }'),
  )
  const packaged = yield* invoke(
    silk,
    ['run', '--stdlib', standardLibrary],
    join(directory, 'packaged/app'),
    { ...process.env, SILK_CLANG: clang },
  )
  assert.equal(packaged.status, 42, packaged.stderr)
  // A dependency name that is also a top-level directory of the source root is refused.
  yield* fs.writeFileString(
    join(directory, 'packaged/app/silk.toml'),
    packagedManifest('util = { path = "../numbers" }'),
  )
  const shadowed = yield* invoke(
    silk,
    ['run', '--stdlib', standardLibrary],
    join(directory, 'packaged/app'),
    { ...process.env, SILK_CLANG: sentinel },
  )
  assert.notEqual(shadowed.status, 0, 'a shadowing dependency name was accepted')
  assert.match(shadowed.stderr, /silk: invalid dependency `util` of app@1\.0\.0: the name is also/)
  assert.equal(yield* fs.exists(marker), false)
  // A composition retention root keeps a private function from a module nothing imports.
  yield* fs.makeDirectory(join(directory, 'retained/support'), { recursive: true })
  yield* fs.writeFileString(
    join(directory, 'retained/main.silk'),
    'pub fn answer() -> i32 {\n  return 3\n}\n',
  )
  yield* fs.writeFileString(
    join(directory, 'retained/support/start.silk'),
    'import Intrinsic.application\n\nexport "C" fn enter() -> i32 as "main" {\n  return application.answer()\n}\n',
  )
  yield* fs.writeFileString(
    join(directory, 'retained/support/keep.silk'),
    'fn capability() -> i32 {\n  return 7177\n}\n',
  )
  yield* fs.writeFileString(
    join(directory, 'retained/silk.toml'),
    '[package]\nname = "retained"\nversion = "0.1.0"\nroot = "main.silk"\n\n[build]\ncomposition = { runtimes = [{ name = "start", module = "support/start" }], defaults = ["start"], retention = [{ module = "support/keep", declaration = "capability" }] }\n',
  )
  const retainedIr = yield* invoke(
    silk,
    ['build', 'main.silk', '-o', 'retained.ll', '--emit', 'llvm-ir', '--stdlib', standardLibrary],
    join(directory, 'retained'),
  )
  assert.equal(retainedIr.status, 0, retainedIr.stderr)
  const retainedText = yield* fs.readFileString(join(directory, 'retained/retained.ll'))
  assert.match(retainedText, /i32 7177/)
  assert.match(
    retainedText,
    /^@llvm\.used = appending global \[1 x ptr\] \[ptr @[^\]]+\], section "llvm\.metadata"$/m,
  )
  // A full JSON profile replaces the target selection and adds its own bindings after them.
  const overridden = yield* invoke(
    silk,
    [
      'run',
      '--profile-input',
      encodeJson({
        target: hostTarget,
        bindings: [
          {
            package: 'bound@0.1.0',
            module: 'main',
            parameter: 'limit',
            value: { kind: 'integer', value: '5' },
            origin: { source: 'cli', provenance: 'literal' },
          },
        ],
      }),
      '--stdlib',
      standardLibrary,
    ],
    join(directory, 'bound'),
    { ...process.env, SILK_CLANG: clang },
  )
  assert.equal(overridden.status, 5, overridden.stderr)
  // A `none` runtime request selects no hosted start: the application's own C `main` is the entry.
  yield* fs.makeDirectory(join(directory, 'bare'), { recursive: true })
  yield* fs.writeFileString(
    join(directory, 'bare/main.silk'),
    'export "C" fn start() -> i32 as "main" {\n  return 6\n}\n',
  )
  yield* fs.writeFileString(
    join(directory, 'bare/silk.toml'),
    '[package]\nname = "bare"\nversion = "0.1.0"\nroot = "main.silk"\n',
  )
  const bare = yield* invoke(
    silk,
    [
      'run',
      '--profile-input',
      encodeJson({ target: hostTarget, runtime: { kind: 'none' } }),
      '--stdlib',
      standardLibrary,
    ],
    join(directory, 'bare'),
    { ...process.env, SILK_CLANG: clang },
  )
  assert.equal(bare.status, 6, bare.stderr)
  // `format` reports unchanged and formatted files on standard output, and drift and damage on
  // standard error, as the TypeScript CLI does.
  const formatting = join(directory, 'formatting')
  yield* fs.makeDirectory(join(formatting, 'src'), { recursive: true })
  yield* fs.writeFileString(
    join(formatting, 'silk.toml'),
    '[package]\nname = "formatting"\nversion = "0.1.0"\nroot = "src/a.silk"\n',
  )
  yield* fs.writeFileString(join(formatting, 'src/a.silk'), 'pub fn a() -> i32 {\n  return 1\n}\n')
  yield* fs.writeFileString(join(formatting, 'src/b.silk'), 'pub fn b()->i32{return 2}\n')
  yield* fs.writeFileString(join(formatting, 'src/c.silk'), 'pub fn c( {\n')
  const formatChecked = yield* invoke(silk, ['format', '--check'], formatting)
  assert.equal(formatChecked.status, 1, formatChecked.stderr)
  assert.equal(formatChecked.stdout, `${join(formatting, 'src/a.silk')}: unchanged\n`)
  assert.match(
    formatChecked.stderr,
    new RegExp(`^${join(formatting, 'src/b.silk')}: needs formatting$`, 'm'),
  )
  assert.match(
    formatChecked.stderr,
    new RegExp(
      `^${join(formatting, 'src/c.silk')}: cannot format damaged source \\(PAR\\d{4}(, [A-Z]{3}\\d{4})*\\)$`,
      'm',
    ),
  )
  const rewritten = yield* invoke(silk, ['format'], formatting)
  assert.equal(rewritten.status, 1, rewritten.stderr)
  assert.match(rewritten.stdout, new RegExp(`^${join(formatting, 'src/b.silk')}: formatted$`, 'm'))
  const cleanedByPath = yield* invoke(silk, ['clean', '--manifest-path', manifest], directory)
  assert.equal(cleanedByPath.status, 0, cleanedByPath.stderr)
  assert.equal(yield* fs.exists(join(directory, 'greeting/build')), false)
  // An object form needs no `main` and no runtime: the application's C exports are its roots.
  const library = join(directory, 'library')
  yield* fs.makeDirectory(join(library, 'src'), { recursive: true })
  yield* fs.writeFileString(
    join(library, 'src/Main.silk'),
    'fn helper(value: i32) -> i32 { return value + unsafe offset() }\n' +
      'unsafe extern "C" fn offset() -> i32\n' +
      'pub fn unrelated() -> i32 { return 99 }\n' +
      'export "C" fn answer(value: i32) -> i32 as "silk_answer" { return helper(value) }\n',
  )
  yield* fs.writeFileString(join(library, 'offset.c'), 'int offset(void) { return 1; }\n')
  yield* fs.writeFileString(
    join(library, 'consumer.c'),
    'int silk_answer(int value);\nint main(void) { return silk_answer(41) == 42 ? 0 : 1; }\n',
  )
  const libraryManifest = (inputs: string, artifact = 'object') =>
    `[package]\nname = "library"\nversion = "0.1.0"\nroot = "src/Main.silk"\n\n[build]\nartifact = "${artifact}"\nnative-link-inputs = [${inputs}]\n`
  const tools = dirname(clang)
  const inspect = Effect.fnUntraced(function* (object: string) {
    const header = yield* invoke(join(tools, 'llvm-readobj'), ['--file-header', object], library)
    assert.equal(header.status, 0, header.stderr)
    const symbols = yield* invoke(join(tools, 'llvm-nm'), ['--defined-only', object], library)
    assert.equal(symbols.status, 0, symbols.stderr)
    return { header: header.stdout, symbols: symbols.stdout.split('\n') }
  })
  const exported = (symbols: ReadonlyArray<string>, name: string) =>
    symbols.some((line) => / T _?(\S+)$/.exec(line)?.[1] === name)
  const compiledHelper = yield* invoke(
    clang,
    ['-c', '-fPIC', 'offset.c', '-o', 'offset.o'],
    library,
  )
  assert.equal(compiledHelper.status, 0, compiledHelper.stderr)
  const libraryArguments = (output: string, ...selectors: ReadonlyArray<string>) => [
    'build',
    'src/Main.silk',
    '-o',
    output,
    '--stdlib',
    standardLibrary,
    ...selectors,
  ]
  yield* fs.writeFileString(join(library, 'silk.toml'), libraryManifest(''))
  const object = yield* invoke(silk, libraryArguments('silk.o'), library, {
    ...process.env,
    SILK_CLANG: clang,
  })
  assert.equal(object.status, 0, object.stderr)
  assert.equal(yield* fs.exists(join(library, 'silk.o.silk.ll')), false)
  const relocatable = yield* inspect('silk.o')
  assert.match(relocatable.header, /Type: Relocatable|MH_OBJECT/)
  assert.ok(exported(relocatable.symbols, 'silk_answer'), relocatable.symbols.join('\n'))
  assert.ok(!exported(relocatable.symbols, 'main'), 'an object form acquires no startup')
  assert.ok(
    !exported(relocatable.symbols, 'offset'),
    'an undeclared foreign definition stays external',
  )
  // The C caller and the Silk export agree on the C ABI once the foreign definition is supplied.
  const consumer = yield* invoke(
    clang,
    ['consumer.c', 'silk.o', 'offset.o', '-o', 'consumer'],
    library,
  )
  assert.equal(consumer.status, 0, consumer.stderr)
  assert.equal((yield* invoke(join(library, 'consumer'), [], library)).status, 0)
  // Declared objects are merged into the object by a relocatable link.
  yield* fs.writeFileString(join(library, 'silk.toml'), libraryManifest('{ object = "offset.o" }'))
  const merged = yield* invoke(silk, libraryArguments('merged.o'), library, {
    ...process.env,
    SILK_CLANG: clang,
  })
  assert.equal(merged.status, 0, merged.stderr)
  const mergedSymbols = yield* inspect('merged.o')
  assert.ok(
    exported(mergedSymbols.symbols, 'silk_answer') && exported(mergedSymbols.symbols, 'offset'),
  )
  const mergedConsumer = yield* invoke(
    clang,
    ['consumer.c', 'merged.o', '-o', 'merged-consumer'],
    library,
  )
  assert.equal(mergedConsumer.status, 0, mergedConsumer.stderr)
  assert.equal((yield* invoke(join(library, 'merged-consumer'), [], library)).status, 0)
  // A library input cannot be merged into a relocatable object.
  yield* fs.writeFileString(
    join(library, 'silk.toml'),
    libraryManifest('{ library = "m", mode = "dynamic" }'),
  )
  const unmergeable = yield* invoke(silk, libraryArguments('unmergeable.o'), library, {
    ...process.env,
    SILK_CLANG: sentinel,
  })
  assert.notEqual(unmergeable.status, 0, 'a library input was merged into an object')
  assert.equal(yield* fs.exists(join(library, 'unmergeable.o')), false)
  assert.equal(yield* fs.exists(marker), false)
  // An object for each supported native target is compiled for that target without a linker.
  yield* fs.writeFileString(join(library, 'silk.toml'), libraryManifest(''))
  for (const [target, machine] of [
    ['x86_64-unknown-linux-gnu', /Format: elf64-x86-64/],
    ['aarch64-unknown-linux-gnu', /Format: elf64-littleaarch64/],
    ['aarch64-apple-darwin', /Format: Mach-O arm64/],
  ] as const) {
    const crossObject = yield* invoke(
      silk,
      libraryArguments(`${target}.o`, '--target', target),
      library,
      { ...process.env, SILK_CLANG: clang },
    )
    assert.equal(crossObject.status, 0, crossObject.stderr)
    const crossed = yield* inspect(`${target}.o`)
    assert.match(crossed.header, machine)
    assert.ok(exported(crossed.symbols, 'silk_answer'), crossed.symbols.join('\n'))
    assert.ok(!exported(crossed.symbols, 'main'), `${target}: an object form acquires no startup`)
  }
  // A stage carries the manifest's form: the object form's IR has its export and no startup.
  const formIr = yield* invoke(silk, libraryArguments('form.ll', '--emit', 'llvm-ir'), library, {
    ...process.env,
    SILK_CLANG: sentinel,
  })
  assert.equal(formIr.status, 0, formIr.stderr)
  const formText = yield* fs.readFileString(join(library, 'form.ll'))
  assert.match(formText, /^define [^\n]*@"?silk_answer"?\(/m)
  assert.doesNotMatch(formText, /^define [^\n]*@"?main"?\(/m)
  // Intermediate stages compile for their target and merge no declared inputs.
  yield* fs.writeFileString(join(library, 'silk.toml'), libraryManifest('{ object = "offset.o" }'))
  const assembly = yield* invoke(
    silk,
    libraryArguments('form.s', '--emit', 'assembly', '--target', 'aarch64-unknown-linux-gnu'),
    library,
    { ...process.env, SILK_CLANG: clang },
  )
  assert.equal(assembly.status, 0, assembly.stderr)
  assert.match(yield* fs.readFileString(join(library, 'form.s')), /silk_answer:/)
  const bitcode = yield* invoke(
    silk,
    libraryArguments('form.bc', '--emit', 'llvm-bitcode'),
    library,
    { ...process.env, SILK_CLANG: clang },
  )
  assert.equal(bitcode.status, 0, bitcode.stderr)
  assert.equal(
    Buffer.from(yield* fs.readFile(join(library, 'form.bc')))
      .subarray(0, 2)
      .toString(),
    'BC',
  )
  const stagedObject = yield* invoke(
    silk,
    libraryArguments('staged.o', '--emit', 'object'),
    library,
    { ...process.env, SILK_CLANG: clang },
  )
  assert.equal(stagedObject.status, 0, stagedObject.stderr)
  assert.ok(!exported((yield* inspect('staged.o')).symbols, 'offset'), 'a stage merged an input')
  // A static library archives the compiled object beside the declared objects, and only those.
  const members = Effect.fnUntraced(function* (archive: string) {
    const listed = yield* invoke(join(tools, 'llvm-ar'), ['t', archive], library)
    assert.equal(listed.status, 0, listed.stderr)
    return listed.stdout.split('\n').filter((line) => line.length > 0)
  })
  // The default archiver is the llvm-ar beside the configured Clang.
  const { SILK_LLVM_AR: _configuredArchiver, ...inherited } = process.env
  const archiveEnvironment = { ...inherited, SILK_CLANG: clang }
  yield* fs.writeFileString(
    join(library, 'silk.toml'),
    libraryManifest('{ object = "offset.o" }', 'static-library'),
  )
  const bundled = yield* invoke(silk, libraryArguments('libsilk.a'), library, archiveEnvironment)
  assert.equal(bundled.status, 0, bundled.stderr)
  assert.deepEqual(yield* members('libsilk.a'), ['libsilk.a.silk.o', 'offset.o'])
  const bundledConsumer = yield* invoke(
    clang,
    ['consumer.c', 'libsilk.a', '-o', 'bundled-consumer'],
    library,
  )
  assert.equal(bundledConsumer.status, 0, bundledConsumer.stderr)
  assert.equal((yield* invoke(join(library, 'bundled-consumer'), [], library)).status, 0)
  // Rebuilding replaces the archive, so a member the build no longer declares disappears.
  yield* fs.writeFileString(join(library, 'silk.toml'), libraryManifest('', 'static-library'))
  const rebuilt = yield* invoke(silk, libraryArguments('libsilk.a'), library, archiveEnvironment)
  assert.equal(rebuilt.status, 0, rebuilt.stderr)
  assert.deepEqual(yield* members('libsilk.a'), ['libsilk.a.silk.o'])
  for (const intermediate of ['libsilk.a.silk.o', 'libsilk.a.silk.ll'])
    assert.equal(yield* fs.exists(join(library, intermediate)), false, intermediate)
  const archived = yield* inspect('libsilk.a')
  assert.ok(exported(archived.symbols, 'silk_answer') && !exported(archived.symbols, 'main'))
  const archiveConsumer = yield* invoke(
    clang,
    ['consumer.c', 'libsilk.a', 'offset.o', '-o', 'archive-consumer'],
    library,
  )
  assert.equal(archiveConsumer.status, 0, archiveConsumer.stderr)
  assert.equal((yield* invoke(join(library, 'archive-consumer'), [], library)).status, 0)
  // A static library for each supported native target needs no linker either.
  for (const [target, machine] of [
    ['x86_64-unknown-linux-gnu', /Format: elf64-x86-64/],
    ['aarch64-unknown-linux-gnu', /Format: elf64-littleaarch64/],
    ['aarch64-apple-darwin', /Format: Mach-O arm64/],
  ] as const) {
    const crossArchive = yield* invoke(
      silk,
      libraryArguments(`lib${target}.a`, '--target', target),
      library,
      archiveEnvironment,
    )
    assert.equal(crossArchive.status, 0, crossArchive.stderr)
    const crossed = yield* inspect(`lib${target}.a`)
    assert.match(crossed.header, machine)
    assert.ok(exported(crossed.symbols, 'silk_answer'), crossed.symbols.join('\n'))
  }
  // An archive is not nested in another, and a failing archiver leaves no archive or member.
  yield* fs.writeFileString(
    join(library, 'silk.toml'),
    libraryManifest('{ static-archive = "libsilk.a" }', 'static-library'),
  )
  const nested = yield* invoke(silk, libraryArguments('nested.a'), library, {
    ...process.env,
    SILK_CLANG: sentinel,
  })
  assert.notEqual(nested.status, 0, 'an archive input was nested in a static library')
  assert.equal(yield* fs.exists(join(library, 'nested.a')), false)
  assert.equal(yield* fs.exists(marker), false)
  yield* fs.writeFileString(join(library, 'silk.toml'), libraryManifest('', 'static-library'))
  const unarchived = yield* invoke(silk, libraryArguments('unarchived.a'), library, {
    ...process.env,
    SILK_CLANG: clang,
    SILK_LLVM_AR: sentinel,
  })
  assert.notEqual(unarchived.status, 0, 'a failed archiver reported success')
  assert.equal(yield* fs.exists(join(library, 'unarchived.a')), false)
  assert.equal(yield* fs.exists(join(library, 'unarchived.a.silk.o')), false)
  yield* fs.remove(marker)
  // The shared library form is not native yet and is refused before any tool runs.
  yield* fs.writeFileString(join(library, 'silk.toml'), libraryManifest('', 'shared-library'))
  const refused = yield* invoke(silk, libraryArguments('refused'), library, {
    ...process.env,
    SILK_CLANG: sentinel,
  })
  assert.equal(refused.status, 2, refused.stderr)
  assert.equal(yield* fs.exists(join(library, 'refused')), false)
  assert.equal(yield* fs.exists(marker), false)
  yield* Console.log(
    'Native build CLI: exact LLVM output, Clang bypass, --clang, default linking/cleanup, selector validation, project run, clean, init, manifest flags, named profiles, profile input, bindings, source root, path dependencies, retention, runtime requests, format reports, installed standard library, clang on PATH, version, help, check, project test, object and static library artifacts and emission stages passed',
  )
})
const require = createRequire(new URL('../../packages/cli/package.json', import.meta.url))
const {
  NodeServices,
}: typeof import('../../packages/cli/node_modules/@effect/platform-node/dist/index.js') =
  await import(pathToFileURL(require.resolve('@effect/platform-node')).href)
await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
