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
  assert.equal(
    yield* fs.exists(join(directory, 'build/llvm', hostTarget, 'debug/native-build')),
    true,
  )
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
  const manifest = (inputs: string) =>
    `[package]\nname = "library"\nroot = "src/Main.silk"\n\n[build]\nnative-link-inputs = [${inputs}]\n`
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
  const formArguments = (form: string, output: string, ...selectors: ReadonlyArray<string>) => [
    'build',
    'src/Main.silk',
    '-o',
    output,
    '--emit',
    form,
    '--stdlib',
    standardLibrary,
    ...selectors,
  ]
  yield* fs.writeFileString(join(library, 'silk.toml'), manifest(''))
  const object = yield* invoke(silkc, formArguments('object', 'silk.o'), library, {
    ...process.env,
    SILKC_CLANG: clang,
  })
  assert.equal(object.status, 0, object.stderr)
  assert.equal(yield* fs.exists(join(library, 'silk.o.silkc.ll')), false)
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
  yield* fs.writeFileString(join(library, 'silk.toml'), manifest('{ object = "offset.o" }'))
  const merged = yield* invoke(silkc, formArguments('object', 'merged.o'), library, {
    ...process.env,
    SILKC_CLANG: clang,
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
    manifest('{ library = "m", mode = "dynamic" }'),
  )
  const unmergeable = yield* invoke(silkc, formArguments('object', 'unmergeable.o'), library, {
    ...process.env,
    SILKC_CLANG: sentinel,
  })
  assert.notEqual(unmergeable.status, 0, 'a library input was merged into an object')
  assert.equal(yield* fs.exists(join(library, 'unmergeable.o')), false)
  assert.equal(yield* fs.exists(marker), false)
  // An object for another target is compiled for that target without a linker.
  yield* fs.writeFileString(join(library, 'silk.toml'), manifest(''))
  const crossObject = yield* invoke(
    silkc,
    formArguments('object', 'cross.o', '--target', foreign),
    library,
    { ...process.env, SILKC_CLANG: clang },
  )
  assert.equal(crossObject.status, 0, crossObject.stderr)
  const crossHeader = (yield* inspect('cross.o')).header
  assert.match(crossHeader, foreign.startsWith('x86_64') ? /x86-64/ : /Mach-O arm64/)
  // A static library archives the compiled object beside the declared objects, and only those.
  const members = Effect.fnUntraced(function* (archive: string) {
    const listed = yield* invoke(join(tools, 'llvm-ar'), ['t', archive], library)
    assert.equal(listed.status, 0, listed.stderr)
    return listed.stdout.split('\n').filter((line) => line.length > 0)
  })
  // The default archiver is the llvm-ar beside the configured Clang.
  const { SILKC_AR: _configuredArchiver, ...inherited } = process.env
  const archiveEnvironment = { ...inherited, SILKC_CLANG: clang }
  yield* fs.writeFileString(join(library, 'silk.toml'), manifest('{ object = "offset.o" }'))
  const bundled = yield* invoke(
    silkc,
    formArguments('static-library', 'libsilk.a'),
    library,
    archiveEnvironment,
  )
  assert.equal(bundled.status, 0, bundled.stderr)
  assert.deepEqual(yield* members('libsilk.a'), ['libsilk.a.silkc.o', 'offset.o'])
  const bundledConsumer = yield* invoke(
    clang,
    ['consumer.c', 'libsilk.a', '-o', 'archive-consumer'],
    library,
  )
  assert.equal(bundledConsumer.status, 0, bundledConsumer.stderr)
  assert.equal((yield* invoke(join(library, 'archive-consumer'), [], library)).status, 0)
  // Rebuilding replaces the archive, so a member the build no longer declares disappears.
  yield* fs.writeFileString(join(library, 'silk.toml'), manifest(''))
  const rebuilt = yield* invoke(
    silkc,
    formArguments('static-library', 'libsilk.a'),
    library,
    archiveEnvironment,
  )
  assert.equal(rebuilt.status, 0, rebuilt.stderr)
  assert.deepEqual(yield* members('libsilk.a'), ['libsilk.a.silkc.o'])
  for (const intermediate of ['libsilk.a.silkc.o', 'libsilk.a.silkc.ll'])
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
  // An archive is not nested in another, and a missing archiver fails without an archive.
  yield* fs.writeFileString(
    join(library, 'silk.toml'),
    manifest('{ static-archive = "libsilk.a" }'),
  )
  const nested = yield* invoke(silkc, formArguments('static-library', 'nested.a'), library, {
    ...process.env,
    SILKC_CLANG: sentinel,
  })
  assert.notEqual(nested.status, 0, 'an archive input was nested in a static library')
  assert.equal(yield* fs.exists(join(library, 'nested.a')), false)
  assert.equal(yield* fs.exists(marker), false)
  yield* fs.writeFileString(join(library, 'silk.toml'), manifest(''))
  const unarchived = yield* invoke(
    silkc,
    formArguments('static-library', 'unarchived.a'),
    library,
    { ...process.env, SILKC_CLANG: clang, SILKC_AR: sentinel },
  )
  assert.notEqual(unarchived.status, 0, 'a failed archiver reported success')
  assert.equal(yield* fs.exists(join(library, 'unarchived.a')), false)
  assert.equal(yield* fs.exists(join(library, 'unarchived.a.silkc.o')), false)
  yield* fs.remove(marker)
  // A static library for another target needs no linker either.
  const crossArchive = yield* invoke(
    silkc,
    formArguments('static-library', 'libcross.a', '--target', foreign),
    library,
    archiveEnvironment,
  )
  assert.equal(crossArchive.status, 0, crossArchive.stderr)
  const crossArchiveHeader = (yield* inspect('libcross.a')).header
  assert.match(crossArchiveHeader, foreign.startsWith('x86_64') ? /x86-64/ : /Mach-O arm64/)
  yield* Console.log(
    'Native build CLI: exact LLVM output, Clang bypass, default linking/cleanup, selector validation, project run, object and static library artifacts passed',
  )
})
const require = createRequire(new URL('../../packages/cli/package.json', import.meta.url))
const {
  NodeServices,
}: typeof import('../../packages/cli/node_modules/@effect/platform-node/dist/index.js') =
  await import(pathToFileURL(require.resolve('@effect/platform-node')).href)
await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
