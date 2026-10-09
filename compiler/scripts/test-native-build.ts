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
  for (const selectors of [
    ['--emit', 'invalid'],
    ['--emit'],
    ['--emit', 'llvm-ir', '--emit', 'llvm-ir'],
    ['--emit', 'executable', '--emit', 'llvm-ir'],
  ]) {
    const rejected = yield* invoke(silkc, [...argumentsFor('rejected'), ...selectors], directory, {
      ...process.env,
      SILKC_CLANG: sentinel,
    })
    assert.notEqual(rejected.status, 0, `accepted invalid selector ${selectors.join(' ')}`)
    assert.equal(yield* fs.exists(join(directory, 'rejected')), false)
    assert.equal(yield* fs.exists(marker), false)
  }
  yield* Console.log(
    'Native build CLI: exact LLVM output, Clang bypass, default linking/cleanup and selector validation passed',
  )
})
const require = createRequire(new URL('../../packages/cli/package.json', import.meta.url))
const {
  NodeServices,
}: typeof import('../../packages/cli/node_modules/@effect/platform-node/dist/index.js') =
  await import(pathToFileURL(require.resolve('@effect/platform-node')).href)
await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
