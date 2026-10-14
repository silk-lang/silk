// One prebuilt native compiler exercises its private request/build routes together.
import { strict as assert } from 'node:assert'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as Console from 'effect/Console'
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'

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
  const silkc = resolve(compiler)
  const clang = resolve(tool)
  const fs = yield* FileSystem.FileSystem
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'silk-native-build-' })
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  const corpus = yield* fs.readFileString(
    join(repository, 'packages/compiler/test/support/corpus.ts'),
  )
  // Reuse the existing small shared acceptance fixture without importing the bootstrap.
  const source = corpus.match(/name: 'operator-precedence',\s+source: '([^']+)'/)?.[1]
  assert.ok(source && !source.includes('\\'), 'expected the plain operator-precedence fixture')
  yield* fs.writeFileString(join(directory, 'main.silk'), source)
  yield* fs.writeFileString(
    join(directory, 'silk.toml'),
    '[package]\nname = "native-build"\nroot = "main.silk"\n',
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
  const ir = yield* invoke(silkc, [...argumentsFor('module.ll'), '--emit', 'llvm-ir'], directory, {
    ...process.env,
    SILKC_CLANG: sentinel,
  })
  assert.equal(ir.status, 0, ir.stderr)
  assert.equal(ir.error, undefined)
  assert.equal(yield* fs.exists(marker), false, 'IR output must not invoke Clang')
  assert.equal(yield* fs.exists(join(directory, 'module.ll.silkc.ll')), false)
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
    `#!/bin/sh\nfor input in "$@"; do\ncase "$input" in\n*.silkc.ll) cp "$input" ${quote(captured)} ;;\nesac\ndone\nexec ${quote(clang)} "$@"\n`,
  )
  yield* fs.chmod(linker, 0o755)
  const linked = yield* invoke(silkc, argumentsFor('program'), directory, {
    ...process.env,
    SILKC_CLANG: linker,
  })
  assert.equal(linked.status, 0, linked.stderr)
  assert.deepEqual(
    yield* fs.readFile(captured),
    bytes,
    'IR selector must retain the exact completed bytes passed to executable linking',
  )
  assert.equal(yield* fs.exists(join(directory, 'program.silkc.ll')), false)
  const ran = yield* invoke(join(directory, 'program'), [], directory)
  assert.equal(ran.status, 42, ran.stderr)
  const explicit = yield* invoke(
    silkc,
    [...argumentsFor('explicit'), '--emit', 'executable'],
    directory,
    { ...process.env, SILKC_CLANG: clang },
  )
  assert.equal(explicit.status, 0, explicit.stderr)
  assert.equal(yield* fs.exists(join(directory, 'explicit.silkc.ll')), false)
  // Another target emits its IR without linking; only the host target links an executable.
  const foreign =
    process.platform === 'darwin' ? 'x86_64-unknown-linux-gnu' : 'aarch64-apple-darwin'
  const cross = yield* invoke(
    silkc,
    [...argumentsFor('cross.ll'), '--emit', 'llvm-ir', '--target', foreign],
    directory,
    { ...process.env, SILKC_CLANG: sentinel },
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
    ['--emit', 'executable', '--emit', 'llvm-ir'],
    ['--target', foreign],
    ['--emit', 'llvm-ir', '--target', 'no-such-target'],
    ['--emit', 'llvm-ir', '--target', foreign, '--target', foreign],
  ]) {
    const rejected = yield* invoke(silkc, [...argumentsFor('rejected'), ...selectors], directory, {
      ...process.env,
      SILKC_CLANG: sentinel,
    })
    assert.notEqual(rejected.status, 0, `accepted invalid selector ${selectors.join(' ')}`)
    assert.equal(yield* fs.exists(join(directory, 'rejected')), false)
    assert.equal(yield* fs.exists(marker), false)
  }
  // `run` builds the nearest project's debug executable below its output directory, then
  // becomes that program: the program's arguments and exit status pass through unchanged.
  const project = yield* invoke(
    silkc,
    ['run', '--stdlib', standardLibrary, 'first', '--', '--stdlib'],
    directory,
    { ...process.env, SILKC_CLANG: clang },
  )
  assert.equal(project.status, 42, project.stderr)
  const [hostTarget] = yield* fs.readDirectory(join(directory, 'build/llvm'))
  assert.ok(hostTarget, 'run must place its executable below build/llvm/<target>')
  assert.equal(yield* fs.exists(join(directory, 'build/llvm', hostTarget, 'debug/native-build')), true)
  // `clean` removes the whole output directory; a project already clean stays clean.
  const cleaned = yield* invoke(silkc, ['clean'], directory)
  assert.equal(cleaned.status, 0, cleaned.stderr)
  assert.equal(yield* fs.exists(join(directory, 'build')), false)
  assert.equal(yield* fs.exists(join(directory, 'main.silk')), true)
  const recleaned = yield* invoke(silkc, ['clean'], directory)
  assert.equal(recleaned.status, 0, recleaned.stderr)
  // `init` writes a project whose generated entry `run` builds and runs.
  const initialized = yield* invoke(silkc, ['init', 'greeting'], directory)
  assert.equal(initialized.status, 0, initialized.stderr)
  const greeted = yield* invoke(
    silkc,
    ['run', '--stdlib', standardLibrary],
    join(directory, 'greeting'),
    { ...process.env, SILKC_CLANG: clang },
  )
  assert.equal(greeted.status, 0, greeted.stderr)
  assert.match(greeted.stdout, /Hello, world!/)
  const repeated = yield* invoke(silkc, ['init', 'greeting'], directory)
  assert.equal(repeated.status, 2, 'init must refuse an existing manifest')
  yield* Console.log(
    'Native build CLI: exact LLVM output, Clang bypass, default linking/cleanup, selector validation, project run, clean and init passed',
  )
})
const require = createRequire(new URL('../../packages/cli/package.json', import.meta.url))
const {
  NodeServices,
}: typeof import('../../packages/cli/node_modules/@effect/platform-node/dist/index.js') =
  await import(pathToFileURL(require.resolve('@effect/platform-node')).href)
await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
