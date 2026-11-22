// One prebuilt native compiler exercises its private request/build routes together.
import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as Config from 'effect/Config'
import * as Console from 'effect/Console'
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Schema from 'effect/Schema'

import { isVersion } from './SemVer.mjs'
// The ambient search path; tests prepend their own tools to it.
const ambientPath = Config.String('PATH').pipe(Config.withDefault(''), Effect.orDie)
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))
const decodeRelease = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      package: Schema.String,
      version: Schema.String,
      tag: Schema.String,
      prerelease: Schema.Boolean,
      notes: Schema.String,
    }),
  ),
)

class VerificationError extends Data.TaggedError('NativeBuildVerificationError')<{
  readonly message: string
  readonly cause: unknown
}> {}
// A build hands its cache write to a copy of the compiler that outlives it, holding a `flock` on
// the file's `.lock` until it is done (compiler/src/driver/DetachedWriter.silk). Waiting for the
// copies below the build directories of `cwd` and of the packages beside it keeps the next step
// from reading or removing a cache the copy is still writing.
const settleCaches = (cwd: string) => {
  const directories = (path: string) =>
    existsSync(path) ? readdirSync(path, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => join(path, entry.name)) : []
  const caches = [cwd, ...directories(cwd)].map((root) => join(root, 'build', 'cache'))
  // Each compiler keeps its files in a directory below its package's (`SemanticCache.directory`).
  const locks = caches.flatMap(directories).flatMap(directories).flatMap((cache) => readdirSync(cache).filter((name) => name.endsWith('.lock')).map((name) => join(cache, name)))
  if (locks.length === 0) return
  const waited = spawnSync('python3', ['-c', 'import fcntl, sys\nfor path in sys.argv[1:]:\n    fcntl.flock(open(path), fcntl.LOCK_SH)', ...locks], { encoding: 'utf8' })
  assert.equal(waited.status, 0, waited.stderr)
}
// The directory of the compiler that used `packageCache`, a package's cache directory, last: the
// first one its `compilers` file names.
const compilerCache = (packageCache: string) =>
  join(packageCache, readFileSync(join(packageCache, 'compilers'), 'utf8').split('\n')[0])
const invoke = Effect.fnUntraced(function* (
  command: string,
  args: ReadonlyArray<string>,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  timeout = 30_000,
  input?: string,
): Effect.fn.Return<SpawnSyncReturns<string>, VerificationError> {
  return yield* Effect.try({
    try: () => {
      const ran = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout, input })
      settleCaches(cwd)
      return ran
    },
    catch: (cause) => new VerificationError({ message: 'Native CLI invocation failed', cause }),
  })
})
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`
const program = Effect.gen(function* () {
  const compiler = process.argv[2]
  const tool = process.argv[3]
  assert.ok(compiler && tool, 'usage: node test-native-build.ts <native-compiler> <clang>')
  const silk = resolve(compiler)
  // `silk pack` refuses a 0.0.0 pin, and a released compiler builds only packages written for its
  // own release, so the fixtures this test packs pin the running compiler's release.
  const reportedVersion = spawnSync(silk, ['--version'], { encoding: 'utf8' }).stdout.trim().replace(/^silk v/, '').replace(/\+.*$/, '')
  const releasePin = reportedVersion === '0.0.0' ? '0.1.0' : reportedVersion
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
    '[package]\nname = "native-build"\nversion = "0.1.0"\nsource = "."\nsilk-version = "0.0.0"\n',
  )
  const sentinel = join(directory, 'clang-sentinel')
  const marker = join(directory, 'clang-called')
  yield* fs.writeFileString(sentinel, `#!/bin/sh\nprintf called > ${quote(marker)}\nexit 99\n`)
  yield* fs.chmod(sentinel, 0o755)
  // The standard library supplies the catalog runtime that roots the build.
  const standardLibrary = join(repository, 'stdlib')
  // An unused erased contract can trigger discovery, but cannot change an ordinary union's
  // object. Supplying the pre-feature compiler also checks the same source against main.
  const ordinaryUnion = join(directory, 'ordinary-union')
  yield* fs.makeDirectory(ordinaryUnion)
  const unionSource = yield* fs.readFileString(join(repository, 'corpus/native/union-interface-dispatch/main.silk'))
  yield* fs.writeFileString(join(ordinaryUnion, 'main.silk'), unionSource)
  const unionObject = Effect.fnUntraced(function* (producer: string, output: string) {
    const built = yield* invoke(producer, ['build', 'main.silk', '--stdlib', standardLibrary, '--clang', clang,
      '--emit', 'object', '--debug', 'false', '-o', output], ordinaryUnion, process.env, 120_000)
    assert.equal(built.status, 0, built.stderr)
    return yield* fs.readFile(join(ordinaryUnion, output))
  })
  const ordinaryBytes = yield* unionObject(silk, 'ordinary.o')
  if (process.env.SILK_TEST_BASELINE) {
    assert.deepEqual(ordinaryBytes, yield* unionObject(resolve(process.env.SILK_TEST_BASELINE), 'baseline.o'))
  }
  yield* fs.writeFileString(join(ordinaryUnion, 'main.silk'), unionSource +
    '\ninterface Unused { fn read(self: &Self) -> i32 }\nfn unused(p: &any Unused) -> i32 { return p.read() }\n')
  assert.deepEqual(yield* unionObject(silk, 'unused.o'), ordinaryBytes)
  // Exercise the public definition -> request -> compiler boundary for non-default settings.
  const compilationPath = (root: string, name: string) => join(root, 'build/definitions', name, 'artifact')
  const compileSettings = Effect.fnUntraced(function* (
    root: string,
    name: string,
    settings: string,
    env: NodeJS.ProcessEnv = { ...process.env, SILK_CLANG: clang },
    artifact = 'executable',
    artifactOutput?: string,
  ) {
    if (!/^\[settings\]$/m.test(settings)) settings = `[settings]\nmodules = []\n${settings}`
    else if (!/^modules\s*=/m.test(settings)) settings = settings.replace('[settings]', '[settings]\nmodules = []')
    if (!/^\[settings.profile\]$/m.test(settings)) settings += '\n[settings.profile]\n'
    if (!/^\[settings.native\]$/m.test(settings)) settings += '\n[settings.native]\nsources = []\nlink = []\n'
    else {
      if (!/^sources\s*=/m.test(settings)) settings = settings.replace('[settings.native]', '[settings.native]\nsources = []')
      if (!/^link\s*=/m.test(settings)) settings = settings.replace('[settings.native]', '[settings.native]\nlink = []')
    }
    const output = join(root, 'build/definitions', name)
    yield* fs.makeDirectory(output, { recursive: true })
    const definition = join(output, 'definition.toml')
    const request = join(output, 'request.toml')
    yield* fs.writeFileString(definition,
      `manifest = ${encodeJson(join(root, 'silk.toml'))}\nname = ${encodeJson(name)}\nartifact = ${encodeJson(artifact)}\nstdlib = ${encodeJson(standardLibrary)}\n${settings}\n`)
    const resolved = yield* invoke(silk, ['resolve', '--definition', definition, '--output', request,
      ...(artifactOutput === undefined ? [] : ['--artifact', artifactOutput])], root, env, 120_000)
    if (resolved.status !== 0) return resolved
    return yield* invoke(silk, ['compile', '--request', request], root, env, 120_000)
  })
  const writePlan = (root: string, body: string) => fs.writeFileString(join(root, 'build.silk'),
    'import silk.build.plan { Framework, Library, Plan }\nimport silk.build.step { sourcePath }\nimport silk.core.target { Target, OperatingSystem }\n' +
    `static fn make() -> Plan {\n  let mut plan = Plan.empty()\n${body}\n  return plan\n}\npub const PLAN: Plan = make()\n`)
  // Explicit requests must ignore even malformed manifests and build scripts, while resolving
  // package aliases, supplied parameters, generated modules, and native translation units.
  const requestRoot = join(directory, 'request-fixture')
  yield* fs.makeDirectory(requestRoot, { recursive: true })
  yield* fs.copy(join(repository, 'compiler/fixtures/compilation-request'), requestRoot, { overwrite: true })
  yield* fs.rename(join(requestRoot, 'silk.toml.invalid'), join(requestRoot, 'silk.toml'))
  yield* fs.rename(join(requestRoot, 'build.silk.invalid'), join(requestRoot, 'build.silk'))
  const requestText = (yield* fs.readFileString(join(requestRoot, 'request.toml')))
    .replaceAll('/REQUEST_ROOT', requestRoot).replaceAll('/STDLIB_ROOT', standardLibrary)
  const requestFile = join(requestRoot, 'request.toml')
  yield* fs.writeFileString(requestFile, requestText)
  const requestEnv = { ...process.env, SILK_CLANG: clang }
  const requested = yield* invoke(silk, ['compile', '--request', requestFile], requestRoot, requestEnv, 120_000)
  assert.equal(requested.status, 0, requested.stderr)
  const requestOutput = join(requestRoot, 'program')
  const requestBytes = yield* fs.readFile(requestOutput)
  const requestRan = yield* invoke(requestOutput, [], requestRoot)
  assert.equal(requestRan.status, 0, requestRan.stderr)
  const pipedRequest = yield* invoke(silk, ['compile', '--request', '-'], requestRoot, requestEnv, 120_000, requestText)
  assert.equal(pipedRequest.status, 0, pipedRequest.stderr)
  assert.deepEqual(yield* fs.readFile(requestOutput), requestBytes, 'request file and stdin must emit identical artifacts')
  const wrongVersion = yield* invoke(silk, ['compile', '--request', '-'], requestRoot, requestEnv, 30_000, requestText.replace('version = 1', 'version = 2'))
  assert.equal(wrongVersion.status, 2, wrongVersion.stderr)
  // A generic instantiated by the root belongs to its defining package's backend unit.
  const mixedLog = join(directory, 'mixed-clang.jsonl')
  const mixedClang = join(directory, 'mixed-clang')
  yield* fs.writeFileString(mixedClang, `#!/usr/bin/env python3
import json, os, sys
with open(${encodeJson(mixedLog)}, 'a') as log:
    log.write(json.dumps(sys.argv[1:]) + '\\n')
os.execv(${encodeJson(clang)}, [${encodeJson(clang)}] + sys.argv[1:])
`)
  yield* fs.chmod(mixedClang, 0o755)
  const mixedText = requestText.replace('name = "request-dependency"', 'optimization = "speed"\ndebug = true\nname = "request-dependency"')
  const mixed = yield* invoke(silk, ['compile', '--request', '-'], requestRoot,
    { ...requestEnv, SILK_CLANG: mixedClang }, 120_000, mixedText)
  assert.equal(mixed.status, 0, mixed.stderr)
  assert.equal((yield* invoke(requestOutput, [], requestRoot)).status, 0)
  const generic = (yield* fs.readFileString(`${requestOutput}.symbols`)).split('\n')
    .find((line) => line.endsWith('request-dependency@0.1.0:value.silk::identity'))?.split('\t')[0]
  assert.ok(generic, 'the root must instantiate the dependency generic')
  const calls = yield* Schema.decodeUnknownEffect(Schema.Array(Schema.Array(Schema.String)))(
    yield* decodeJson(`[${(yield* fs.readFileString(mixedLog)).trim().split('\n').join(',')}]`))
  let genericUnits = 0
  for (const call of calls) {
    if (!call.includes('-c') || !call.includes('ir')) continue
    const partial = call[call.indexOf('-o') + 1]
    const object = partial.slice(0, partial.indexOf('.o.') + 2)
    const symbols = yield* invoke(join(dirname(clang), 'llvm-nm'), ['--defined-only', object], requestRoot)
    assert.equal(symbols.status, 0, symbols.stderr)
    if (!symbols.stdout.split('\n').some((line) => line.endsWith(` ${generic}`))) continue
    genericUnits++
    assert.ok(call.includes('-O2') && call.includes('-g'), 'dependency generics use the defining package optimization and debug settings')
    assert.ok(!call.includes('-O0'), 'program defaults must not override package flags')
    const dwarf = yield* invoke(join(dirname(clang), 'llvm-dwarfdump'), ['--debug-info', object], requestRoot)
    assert.equal(dwarf.status, 0, dwarf.stderr)
    assert.match(dwarf.stdout, /DW_TAG_compile_unit/, 'the dependency object must contain usable debug information')
  }
  assert.equal(genericUnits, 1)
  // Intermediate artifacts retain defining-package settings too. Validate the emitted IR,
  // then feed the other formats back through LLVM to verify they remain consumable.
  for (const [emit, suffix] of [['llvm-ir', 'll'], ['llvm-bitcode', 'bc'], ['assembly', 's'], ['object', 'o']]) {
    const output = join(requestRoot, `mixed.${suffix}`)
    const intermediateText = mixedText.replace('emit = "final"', `emit = "${emit}"`)
      .replace(`output = ${encodeJson(requestOutput)}`, `output = ${encodeJson(output)}`)
    const intermediate = yield* invoke(silk, ['compile', '--request', '-'], requestRoot, requestEnv, 120_000, intermediateText)
    assert.equal(intermediate.status, 0, intermediate.stderr)
    if (emit === 'llvm-ir') {
      const ir = yield* fs.readFileString(output)
      const definition = ir.split('\n').find((line) => line.startsWith('define ') && line.includes(`@${generic}(`))
      assert.ok(definition?.includes('!dbg'), 'the dependency generic keeps its package debug information in merged IR')
    }
    const object = emit === 'object' ? output : join(requestRoot, `mixed-${suffix}.o`)
    if (emit !== 'object') {
      const converted = yield* invoke(clang, ['-c', output, '-o', object], requestRoot)
      assert.equal(converted.status, 0, converted.stderr)
    }
    const symbols = yield* invoke(join(dirname(clang), 'llvm-nm'), ['--defined-only', object], requestRoot)
    assert.equal(symbols.status, 0, symbols.stderr)
    assert.ok(symbols.stdout.split('\n').some((line) => line.endsWith(` ${generic}`)), 'the defining-package unit survives intermediate emission')
  }
  const graphRoot = join(directory, 'graph-fixture')
  yield* fs.makeDirectory(graphRoot, { recursive: true })
  const graphSources = join(directory, 'graph-sources')
  yield* fs.copy(join(repository, 'compiler/fixtures/build-graph'), graphSources)
  const graphProgram = join(directory, 'graph-test')
  const graphBuilt = yield* invoke(silk, ['build', join(graphSources, 'main.silk'),
    '-o', graphProgram, '--stdlib', standardLibrary, '--clang', clang], directory, process.env, 120_000)
  assert.equal(graphBuilt.status, 0, graphBuilt.stderr)
  // The runner hands its standard steps to the compiler, as a task program's does.
  const graphRan = yield* invoke(graphProgram, [], graphRoot, { ...process.env, SILK_COMPILER: silk })
  assert.equal(graphRan.status, 0, graphRan.stderr)
  const staticGraphProgram = join(directory, 'static-graph-test')
  const staticGraphBuilt = yield* invoke(silk, ['build', join(repository, 'compiler/fixtures/build-graph/static.silk'),
    '-o', staticGraphProgram, '--stdlib', standardLibrary, '--clang', clang], directory, process.env, 120_000)
  assert.equal(staticGraphBuilt.status, 0, staticGraphBuilt.stderr)
  const staticGraphRan = yield* invoke(staticGraphProgram, [], graphRoot)
  assert.equal(staticGraphRan.status, 0, staticGraphRan.stderr)
  const optionsProgram = join(directory, 'build-options-test')
  const optionsBuilt = yield* invoke(silk, ['build', join(repository, 'compiler/fixtures/build-graph/options.silk'),
    '-o', optionsProgram, '--stdlib', standardLibrary, '--clang', clang], directory, process.env, 120_000)
  assert.equal(optionsBuilt.status, 0, optionsBuilt.stderr)
  const optionsRan = yield* invoke(optionsProgram, [], graphRoot)
  assert.equal(optionsRan.status, 0, optionsRan.stderr)
  const graphTask = join(directory, 'graph-task-test')
  const graphTaskBuilt = yield* invoke(silk, ['build', join(graphSources, 'task.silk'),
    '-o', graphTask, '--stdlib', standardLibrary, '--clang', clang], directory, process.env, 120_000)
  assert.equal(graphTaskBuilt.status, 0, graphTaskBuilt.stderr)
  const graphTaskRan = yield* invoke(graphTask, ['fail'], graphRoot)
  assert.equal(graphTaskRan.status, 1, graphTaskRan.stderr)
  assert.equal(graphTaskRan.stderr, 'error: declared build input is missing\n')
  // Resolution reads the package definition; only compile --request bypasses manifests and plans.
  yield* fs.remove(join(requestRoot, 'build.silk'))
  yield* fs.writeFileString(join(requestRoot, 'silk.toml'),
    '[package]\nname = "request-fixture"\nversion = "0.1.0"\nsource = "."\nsilk-version = "0.0.0"\n[dependencies]\ndep = { path = "dependency" }\n')
  yield* fs.writeFileString(join(requestRoot, 'dependency/silk.toml'),
    '[package]\nname = "request-dependency"\nversion = "0.1.0"\nsource = "."\nkind = "library"\nexports = ["value"]\ninclude = ["asset.bin"]\nsilk-version = "0.0.0"\n')
  const definitionText = (yield* fs.readFileString(join(requestRoot, 'definition.toml')))
    .replaceAll('/REQUEST_ROOT', requestRoot).replaceAll('/STDLIB_ROOT', standardLibrary)
  yield* fs.writeFileString(join(requestRoot, 'definition.toml'), definitionText)
  const generatedRoot = join(directory, 'generated-entry.silk')
  yield* fs.copyFile(join(requestRoot, 'main.silk'), generatedRoot)
  const definitionFile = join(requestRoot, 'definition.toml')
  const resolvedFile = join(requestRoot, 'resolved.toml')
  const manifestBeforeExclusion = yield* fs.readFileString(join(requestRoot, 'silk.toml'))
  yield* fs.writeFileString(join(requestRoot, 'silk.toml'),
    manifestBeforeExclusion + 'unused = { path = "missing-dependency" }\n')
  const excludedDefinition = definitionText.replace('[settings]\n', `[settings]\nroot = ${JSON.stringify(generatedRoot)}\n`)
    + '\n[packages.unused]\nexcluded = true\nparameters = []\n'
  yield* fs.writeFileString(definitionFile, excludedDefinition)
  const resolved = yield* invoke(silk, ['resolve', '--definition', definitionFile, '--output', resolvedFile], requestRoot, requestEnv, 120_000)
  assert.equal(resolved.status, 0, resolved.stderr)
  const resolvedText = yield* fs.readFileString(resolvedFile)
  assert.ok(resolvedText.includes(generatedRoot), 'the request must retain the physical generated root')
  assert.match(resolvedText, /^root-module = "main\.silk"$/m)
  assert.ok(!resolvedText.includes('missing-dependency'), 'excluded packages must not enter the request')
  const generatedCompiled = yield* invoke(silk, ['compile', '--request', resolvedFile], requestRoot, requestEnv, 120_000)
  assert.equal(generatedCompiled.status, 0, generatedCompiled.stderr)
  const generatedRan = yield* invoke(join(requestRoot, 'artifact'), [], requestRoot)
  assert.equal(generatedRan.status, 0, generatedRan.stderr)
  yield* fs.writeFileString(definitionFile, definitionText)
  yield* fs.writeFileString(join(requestRoot, 'silk.toml'), manifestBeforeExclusion)
  // A package override names a package of the graph by its package name, not only by an alias.
  yield* fs.writeFileString(definitionFile,
    definitionText + '\n[packages.request-dependency]\noptimization = "speed"\nexcluded = false\nparameters = []\n')
  const namedResolved = yield* invoke(silk, ['resolve', '--definition', definitionFile, '--output', resolvedFile], requestRoot, requestEnv, 120_000)
  assert.equal(namedResolved.status, 0, namedResolved.stderr)
  assert.match(yield* fs.readFileString(resolvedFile), /\{name = "request-dependency", [^\n]*optimization = "speed"/)
  yield* fs.writeFileString(definitionFile,
    definitionText + '\n[packages.no-such-package]\noptimization = "speed"\nexcluded = false\nparameters = []\n')
  const unknownResolved = yield* invoke(silk, ['resolve', '--definition', definitionFile, '--output', resolvedFile], requestRoot, requestEnv, 120_000)
  assert.notEqual(unknownResolved.status, 0)
  assert.match(unknownResolved.stderr, /no package in this compilation is named or aliased no-such-package/)
  yield* fs.writeFileString(definitionFile, definitionText)
  const graphCompiler = join(directory, 'graph-compilation-test')
  const graphCompilerBuilt = yield* invoke(silk, ['build', join(graphSources, 'compile.silk'),
    '-o', graphCompiler, '--stdlib', standardLibrary, '--clang', clang], directory, process.env, 300_000)
  assert.equal(graphCompilerBuilt.status, 0, graphCompilerBuilt.stderr || String(graphCompilerBuilt.error))
  yield* fs.writeFileString(join(directory, 'silk.toml'),
    '[package]\nname = "native-build"\nversion = "0.1.0"\nsource = "."\nsilk-version = "0.0.0"\n[workspace]\nmembers = ["request-fixture"]\noutput-dir = "request-fixture/custom-output"\n')
  yield* fs.writeFile(join(requestRoot, 'dependency/asset.bin'), new Uint8Array([5, 0, 255, 34, 10]))
  const packagePath = (dependency: string, path: string) => invoke(silk,
    ['package-path', '--manifest', join(requestRoot, 'silk.toml'), '--dependency', dependency, '--path', path], requestRoot, requestEnv)
  const includedAsset = yield* packagePath('dep', 'asset.bin')
  assert.equal(includedAsset.status, 0, includedAsset.stderr)
  assert.equal(includedAsset.stdout.trim(), JSON.stringify(join(requestRoot, 'dependency/asset.bin')))
  for (const [dependency, path] of [['dep', 'value.silk'], ['dep', '../main.silk'], ['missing', 'asset.bin']]) {
    const refused = yield* packagePath(dependency, path)
    assert.notEqual(refused.status, 0, `${dependency}/${path} must not expose an undeclared path`)
  }
  yield* fs.remove(join(requestRoot, 'dependency/asset.bin'))
  yield* fs.symlink(join(requestRoot, 'main.silk'), join(requestRoot, 'dependency/asset.bin'))
  const escapedAsset = yield* packagePath('dep', 'asset.bin')
  assert.notEqual(escapedAsset.status, 0, 'an included symbolic link cannot leave its dependency')
  yield* fs.remove(join(requestRoot, 'dependency/asset.bin'))
  yield* fs.writeFile(join(requestRoot, 'dependency/asset.bin'), new Uint8Array([5, 0, 255, 34, 10]))
  const beforeEmbedding = yield* fs.readFileString(join(requestRoot, 'main.silk'))
  yield* fs.writeFileString(join(requestRoot, 'main.silk'), 'import payload { data }\n' + beforeEmbedding.replace(
    'pub fn main() -> i32 {', 'pub fn main() -> i32 {\n  if data.length != 5 || data[0] != 5 || data[1] != 0 || data[2] != 255 || data[3] != 34 || data[4] != 10 { return 8 }'))
  const graphCompiled = yield* invoke(graphCompiler, [], requestRoot, { ...requestEnv, SILK_TEST_COMPILER: silk, SILK_COMPILER: silk }, 120_000)
  assert.equal(graphCompiled.status, 0, graphCompiled.stderr)
  assert.ok(yield* fs.exists(join(requestRoot, 'custom-output/x86_64-unknown-linux-gnu/dev/request-fixture')))
  // The compilation builds outside its step with the package cache, so the next one after an edit
  // reuses the checks of what it did not change.
  assert.ok(yield* fs.exists(join(requestRoot, 'custom-output/steps/compilations/x86_64-unknown-linux-gnu/dev/request-fixture')))
  const graphCache = compilerCache(join(requestRoot, 'custom-output/cache/request-fixture'))
  assert.ok((yield* fs.readDirectory(graphCache)).some((name) => name.startsWith('semantic-')), 'the graph compilation keeps a semantic cache')
  const embedded = yield* fs.readFileString(join(requestRoot, 'main.silk'))
  yield* fs.writeFileString(join(requestRoot, 'main.silk'), embedded.replace('{ return 8 }', '{ return 9 }'))
  // The fixture checks that planning leaves no published program, so the first one goes first.
  yield* fs.remove(join(requestRoot, 'custom-output/x86_64-unknown-linux-gnu/dev/request-fixture'))
  const graphRecompiled = yield* invoke(graphCompiler, [], requestRoot, { ...requestEnv, SILK_TEST_COMPILER: silk, SILK_COMPILER: silk }, 120_000)
  assert.equal(graphRecompiled.status, 0, graphRecompiled.stderr)
  assert.match(graphRecompiled.stderr, /checks? reused/, 'an edited graph compilation reuses its cache')
  yield* fs.writeFileString(join(requestRoot, 'main.silk'), embedded)
  yield* fs.writeFileString(join(directory, 'silk.toml'),
    '[package]\nname = "native-build"\nversion = "0.1.0"\nsource = "."\nsilk-version = "0.0.0"\n')
  const runnerDirectory = join(directory, 'artifact-runners')
  yield* fs.makeDirectory(runnerDirectory)
  const explicitRunner = join(runnerDirectory, 'explicit')
  const wasiRunner = join(runnerDirectory, 'wasmtime')
  const launchArguments = `test "$2" = ${quote(requestOutput)} && test "$3" = 'argument with spaces' && test "$#" = 3`
  yield* fs.writeFileString(explicitRunner, `#!/bin/sh\ntest "$1" = 'runner option' && ${launchArguments}\n`)
  yield* fs.writeFileString(wasiRunner, `#!/bin/sh\ntest "$1" = run && ${launchArguments}\n`)
  yield* fs.chmod(explicitRunner, 0o755)
  yield* fs.chmod(wasiRunner, 0o755)
  const launchRequest = join(requestRoot, 'launch.toml')
  yield* fs.writeFileString(launchRequest, `${requestText}\n[runner]\nprogram = ${JSON.stringify(explicitRunner)}\narguments = ["runner option"]\n`)
  const explicitLaunch = yield* invoke(graphCompiler, [], requestRoot,
    { ...requestEnv, SILK_TEST_LAUNCH_REQUEST: launchRequest }, 30_000)
  assert.equal(explicitLaunch.status, 0, explicitLaunch.stderr)
  yield* fs.writeFileString(launchRequest, requestText.replace('target = "x86_64-unknown-linux-gnu"', 'target = "wasm32-wasip1"'))
  const wasiLaunch = yield* invoke(graphCompiler, [], requestRoot,
    { ...requestEnv, SILK_TEST_LAUNCH_REQUEST: launchRequest, PATH: `${runnerDirectory}:${process.env.PATH}` }, 30_000)
  assert.equal(wasiLaunch.status, 0, wasiLaunch.stderr)
  // Reserved command aliases dispatch to the typed task without interpreting its arguments.
  const aliased = join(directory, 'aliased')
  yield* fs.makeDirectory(join(aliased, 'src'), { recursive: true })
  yield* fs.writeFileString(join(aliased, 'silk.toml'), '[package]\nname="aliased"\nsilk-version = "0.0.0"\n[dependencies]\ncatalog = {path="catalog"}\n')
  yield* fs.makeDirectory(join(aliased, 'catalog'), { recursive: true })
  yield* fs.writeFileString(join(aliased, 'catalog/silk.toml'), '[package]\nname="task-catalog"\nsource="."\nexports=["description"]\nsilk-version = "0.0.0"\n')
  yield* fs.writeFileString(join(aliased, 'catalog/description.silk'), 'pub const DESCRIPTION: string = "Alias fixture"\n')
  yield* fs.writeFileString(join(aliased, 'src/main.silk'), 'pub fn main() -> i32 { return 42 }\ntest fn smoke() -> () {}\n')
  const aliasSource = (names: ReadonlyArray<string>) => [
    'import catalog.description { DESCRIPTION }',
    'import silk.cli.command { Command, CommandLine, Opt }',
    'import silk.cli.task { Task, TaskSet, TaskError }',
    'import silk.mem.allocator { Allocator, OutOfMemoryError }',
    'import silk.text.string { String }',
    'import silk.system.host_input { HostInput }',
    `union Tasks { ${names.map((name) => `${name} { pub code: i32 }`).join(', ')} }`,
    'impl CommandLine for Tasks {',
    '  static fn command() -> Command<Tasks> {',
    '    return Command<Tasks>.make("tasks", DESCRIPTION) |> Command.option("code", Opt.about("Exit code") |> Opt.required())',
    '  }',
    '}',
    'impl TaskSet for Tasks {',
    '  effect fn perform(self: Self) -> () ! TaskError | OutOfMemoryError ? &mut Allocator {',
    '    match move self {',
    ...names.map((name) => `      Tasks.${name} {code} => { fail TaskError {message: run String.copy("task selected"), status: code} }`),
    '    }',
    '  }',
    '}',
    'pub effect fn main() -> i32 ? &mut HostInput { return run Task.main<Tasks>() }',
    '',
  ].join('\n')
  const reservedCommands = ['Build', 'Run', 'Test', 'Plan']
  yield* fs.writeFileString(join(aliased, 'src/tasks.silk'), aliasSource(reservedCommands))
  for (const command of reservedCommands.map((name) => name.toLowerCase())) {
    const dispatched = yield* invoke(silk, [command, '--stdlib', standardLibrary, '--code', '17'], aliased, requestEnv, 120_000)
    assert.equal(dispatched.status, 17, dispatched.stderr)
    assert.equal(dispatched.stderr.split('task selected').length - 1, 1, 'a reserved command performs its task once')
  }
  const explicitTask = yield* invoke(silk, ['task', '--stdlib', standardLibrary, 'build', '--code', '23'], aliased, requestEnv, 120_000)
  assert.equal(explicitTask.status, 23, explicitTask.stderr)
  // A task's unknown option is followed by that task's usage and options.
  const unknownTaskOption = yield* invoke(silk, ['task', '--stdlib', standardLibrary, 'build', '--release'], aliased, requestEnv, 120_000)
  assert.equal(unknownTaskOption.status, 2, unknownTaskOption.stderr)
  assert.match(unknownTaskOption.stderr, /^error: unknown option --release\n\nUsage: silk task build \[options\]\n/m)
  assert.match(unknownTaskOption.stderr, /^ +--code <value> +Exit code/m)
  // The compiler's own options stay with the compiler; the task sees only its own.
  const compilerOptions = ['-q', '--timings', '--ignore-warnings', '--progress', 'plain', '--backend', 'llvm']
  const compilerOptioned = yield* invoke(silk, ['build', ...compilerOptions, '--stdlib', standardLibrary, '--code', '19'], aliased, requestEnv, 120_000)
  assert.equal(compilerOptioned.status, 19, compilerOptioned.stderr)
  yield* fs.writeFileString(join(aliased, 'src/tasks.silk'), aliasSource(['Build']))
  const builtinRun = yield* invoke(silk, ['run', '--stdlib', standardLibrary], aliased, requestEnv, 120_000)
  assert.equal(builtinRun.status, 42, builtinRun.stderr)
  // A package whose root module is its tasks program has no other program for the built-in `run`
  // and `build` to make: its tasks answer them, before anything but the tasks program is built.
  const tasksOnly = join(directory, 'tasks-only')
  yield* fs.makeDirectory(join(tasksOnly, 'src'), { recursive: true })
  yield* fs.writeFileString(join(tasksOnly, 'silk.toml'), '[package]\nname="tasks-only"\nmain="tasks.silk"\nsilk-version = "0.0.0"\n[dependencies]\ncatalog = {path="../aliased/catalog"}\n')
  yield* fs.writeFileString(join(tasksOnly, 'src/tasks.silk'), aliasSource(['Build']))
  const tasksOnlyRun = yield* invoke(silk, ['run', '--stdlib', standardLibrary], tasksOnly, requestEnv, 120_000)
  assert.equal(tasksOnlyRun.status, 2, tasksOnlyRun.stderr)
  assert.match(tasksOnlyRun.stderr, /^error: unknown command run\b/m)
  assert.equal(tasksOnlyRun.stderr.match(/^ *Compiling /gm)?.length, 1, 'only the tasks program is compiled')
  const tasksOnlyBuild = yield* invoke(silk, ['build', '--stdlib', standardLibrary, '--code', '29'], tasksOnly, requestEnv, 120_000)
  assert.equal(tasksOnlyBuild.status, 29, tasksOnlyBuild.stderr)
  yield* fs.writeFileString(join(tasksOnly, 'src/tasks.silk'), aliasSource(['Run']))
  const tasksOnlyBuiltBuild = yield* invoke(silk, ['build', '--stdlib', standardLibrary], tasksOnly, requestEnv, 120_000)
  assert.equal(tasksOnlyBuiltBuild.status, 2, tasksOnlyBuiltBuild.stderr)
  assert.match(tasksOnlyBuiltBuild.stderr, /^error: unknown command build\b/m)
  const tasksOnlyTargets = (yield* fs.readDirectory(join(tasksOnly, 'build'))).filter((entry) => /^(x86_64|aarch64)-/.test(entry))
  assert.deepEqual(tasksOnlyTargets, [], 'no package artifact is built')
  // Without its root module, the built-in names the missing file and points to the tasks.
  yield* fs.rename(join(aliased, 'src/main.silk'), join(aliased, 'main.silk.away'))
  const rootless = yield* invoke(silk, ['run', '--stdlib', standardLibrary], aliased, requestEnv, 120_000)
  yield* fs.rename(join(aliased, 'main.silk.away'), join(aliased, 'src/main.silk'))
  assert.equal(rootless.status, 1, rootless.stderr)
  assert.match(rootless.stderr, /^silk: package `aliased` has no root module: src\/main\.silk does not exist$/m)
  assert.match(rootless.stderr, /`silk task` lists its tasks/)
  const builtinPlan = yield* invoke(silk, ['task', '--stdlib', standardLibrary, 'plan'], aliased, requestEnv, 120_000)
  assert.equal(builtinPlan.status, 0, builtinPlan.stderr)
  const aliasRequests = yield* fs.readDirectory(join(aliased, 'build/requests'))
  assert.ok(aliasRequests.some((name) => name.startsWith('aliased.') && name.endsWith('.dev.toml')))
  yield* fs.copyFile(join(graphSources, 'plan_task.silk'), join(aliased, 'src/tasks.silk'))
  const customPlan = yield* invoke(silk, ['plan', '--stdlib', standardLibrary], aliased, requestEnv, 300_000)
  assert.equal(customPlan.status, 0, customPlan.stderr)
  const customSet = JSON.parse(yield* fs.readFileString(join(aliased, 'build/requests/plan.json')))
  assert.ok(customSet.files.length > 0, 'a child task publishes its pending requests through the parent')
  // The fixture's `when` lambdas set speed and turn debug information off.
  const customRequest = yield* fs.readFileString(join(aliased, 'build/requests', customSet.files[0]))
  assert.match(customRequest, /\boptimization = "speed"/)
  assert.match(customRequest, /\bdebug = false/)
  assert.equal(yield* fs.exists(join(aliased, 'build/requests/.pending-plan.json')), false)
  // `silk check` checks the compilation a plan published for its target: here the plan selects a
  // runtime the manifest lists but does not default to, which only the published request names.
  const runtimes = join(directory, 'planned-runtime')
  yield* fs.makeDirectory(join(runtimes, 'src'), { recursive: true })
  yield* fs.writeFileString(join(runtimes, 'silk.toml'), [
    '[package]', 'name = "planned"', 'version = "0.1.0"', 'silk-version = "0.0.0"', '',
    '[unstable.composition]',
    'runtimes = [{ name = "hosted", module = "silk/platform/native/start" }, { name = "standalone", module = "silk/platform/wasm/start" }]',
    'defaults = ["hosted"]',
    'components = [{ capability = "execution-storage", bindings = [',
    ...['create', 'acquire', 'release', 'destroy'].map((operation) =>
      `  { operation = "${operation}", module = "silk/concurrency/execution_storage", declaration = "silk_execution_storage_${operation}" },`),
    '] }]', '',
  ].join('\n'))
  yield* fs.writeFileString(join(runtimes, 'src/main.silk'), 'pub fn main() -> i32 {\n  return 7\n}\n')
  yield* fs.copyFile(join(graphSources, 'runtime_task.silk'), join(runtimes, 'src/tasks.silk'))
  const wasmTarget = ['--target', 'wasm32-unknown-unknown', '--stdlib', standardLibrary]
  const unplanned = yield* invoke(silk, ['check', '--no-server', ...wasmTarget], runtimes, requestEnv, 300_000)
  assert.equal(unplanned.status, 1, unplanned.stderr)
  assert.match(unplanned.stderr, /runtime module silk\/platform\/native\/start does not support the target wasm32-unknown-unknown/)
  const wasmPlan = yield* invoke(silk, ['plan', ...wasmTarget], runtimes, requestEnv, 300_000)
  assert.equal(wasmPlan.status, 0, wasmPlan.stderr)
  const plannedCheck = yield* invoke(silk, ['check', '--no-server', ...wasmTarget], runtimes, requestEnv, 300_000)
  assert.equal(plannedCheck.status, 0, plannedCheck.stderr)
  assert.match(plannedCheck.stderr, /^Checking planned \(wasm32-unknown-unknown\)/m)
  // The host check has no published request and keeps the manifest's default runtime.
  const hosted = yield* invoke(silk, ['check', '--no-server', '--stdlib', standardLibrary], runtimes, requestEnv, 300_000)
  assert.equal(hosted.status, 0, hosted.stderr)
  // A graph of a custom step, a compilation that embeds its output and a custom step that reads
  // the artifact: the task program runs the custom steps and the compiler runs the compilation.
  yield* fs.copyFile(join(graphSources, 'mixed_task.silk'), join(aliased, 'src/tasks.silk'))
  for (const round of ['first', 'unchanged']) {
    const mixed = yield* invoke(silk, ['build', '--stdlib', standardLibrary], aliased, requestEnv, 300_000)
    assert.equal(mixed.status, 0, `${round}: ${mixed.stderr}`)
    assert.match(mixed.stderr, /^Finished build\/[^/\n]+\/dev\/aliased(\.exe)? in /m, `${round}: the build reports its artifact`)
    if (round === 'first') assert.match(mixed.stderr, /^Compiling aliased \(/m, 'the compilation reports its progress')
  }
  const mixedSteps = yield* fs.readDirectory(join(aliased, 'build/steps'))
  const mixedSizes: Array<string> = []
  for (const name of mixedSteps) {
    // A step directory is named by its key; lock files and records sit beside them.
    if (/^[0-9a-f]{64}$/.test(name) && (yield* fs.exists(join(aliased, 'build/steps', name, 'size.txt')))) mixedSizes.push(name)
  }
  assert.equal(mixedSizes.length, 1, 'the custom step that reads the artifact ran once')
  // `silk check` checks the tasks program too.
  yield* fs.writeFileString(join(aliased, 'src/tasks.silk'), 'pub fn main() -> i32 {\n  return "seven"\n}\n')
  const checkedTasks = yield* invoke(silk, ['check', '--stdlib', standardLibrary], aliased, requestEnv, 120_000)
  assert.equal(checkedTasks.status, 1, checkedTasks.stderr)
  assert.match(checkedTasks.stderr, /src\/tasks\.silk:2:/)
  // A tasks program takes its package's own native plan only once it reaches a module of the
  // package besides tasks.silk, the way a dependency's plan applies once reached: this package's C
  // calls a function nothing links, so its tasks program links only while it leaves that C out.
  const held = join(directory, 'held-native')
  yield* fs.makeDirectory(join(held, 'src'), { recursive: true })
  yield* fs.makeDirectory(join(held, 'native'), { recursive: true })
  yield* fs.writeFileString(join(held, 'silk.toml'), '[package]\nname="held-native"\nsilk-version = "0.0.0"\n')
  yield* fs.writeFileString(join(held, 'build.silk'), [
    'import silk.build.plan { Plan }',
    'import silk.build.step { sourcePath }',
    'static fn plan() -> Plan {',
    '  return Plan.empty() |> Plan.compileNative("c", sourcePath("native/needs.c"), &[], &[])',
    '}',
    'pub const PLAN: Plan = plan()',
    '',
  ].join('\n'))
  yield* fs.writeFileString(join(held, 'native/needs.c'),
    'extern int held_missing_symbol(void);\nint held_uses_missing(void) { return held_missing_symbol(); }\n')
  yield* fs.writeFileString(join(held, 'src/main.silk'), 'pub fn main() -> i32 { return 0 }\n')
  yield* fs.writeFileString(join(held, 'src/helper.silk'), 'pub fn code() -> i32 { return 31 }\n')
  const heldTasks = (imported: boolean) => [
    ...(imported ? ['import helper'] : []),
    'import silk.cli.command { Command, CommandLine }',
    'import silk.cli.task { Task, TaskSet, TaskError }',
    'import silk.mem.allocator { Allocator, OutOfMemoryError }',
    'import silk.text.string { String }',
    'import silk.system.host_input { HostInput }',
    'union Tasks { Code }',
    'impl CommandLine for Tasks {',
    '  static fn command() -> Command<Tasks> {',
    '    return Command<Tasks>.make("tasks", "Held native fixture") |> Command.variant("Code", "Fail with a code")',
    '  }',
    '}',
    'impl TaskSet for Tasks {',
    '  effect fn perform(self: Self) -> () ! TaskError | OutOfMemoryError ? &mut Allocator {',
    `    fail TaskError {message: run String.copy("task selected"), status: ${imported ? 'helper.code()' : '29'}}`,
    '  }',
    '}',
    'pub effect fn main() -> i32 ? &mut HostInput { return run Task.main<Tasks>() }',
    '',
  ].join('\n')
  yield* fs.writeFileString(join(held, 'src/tasks.silk'), heldTasks(false))
  const unreached = yield* invoke(silk, ['task', '--stdlib', standardLibrary, 'code'], held, requestEnv, 120_000)
  assert.equal(unreached.status, 29, unreached.stderr)
  yield* fs.writeFileString(join(held, 'src/tasks.silk'), heldTasks(true))
  const reached = yield* invoke(silk, ['task', '--stdlib', standardLibrary, 'code'], held, requestEnv, 120_000)
  assert.notEqual(reached.status, 0, 'a tasks program that reaches the package links its C')
  assert.match(reached.stderr, /held_missing_symbol/)
  // A C-only dependency that nothing imports links only when the dependent's plan names it with
  // Plan.linkDependency; declaring it is not enough, and naming an undeclared one refuses the plan.
  const heldC = join(held, 'held-c')
  yield* fs.makeDirectory(join(heldC, 'src'), { recursive: true })
  yield* fs.writeFileString(join(heldC, 'silk.toml'), '[package]\nname="held-c"\nkind="library"\nexports=["lib"]\nsilk-version = "0.0.0"\n')
  yield* fs.writeFileString(join(heldC, 'src/lib.silk'), '//! Only C.\n')
  yield* fs.writeFileString(join(heldC, 'build.silk'), [
    'import silk.build.plan { Plan }',
    'import silk.build.step { sourcePath }',
    'static fn plan() -> Plan {',
    '  return Plan.empty() |> Plan.compileNative("c", sourcePath("defines.c"), &[], &[])',
    '}',
    'pub const PLAN: Plan = plan()',
    '',
  ].join('\n'))
  yield* fs.writeFileString(join(heldC, 'defines.c'), 'int held_missing_symbol(void) { return 7; }\n')
  yield* fs.writeFileString(join(held, 'silk.toml'), '[package]\nname="held-native"\nsilk-version = "0.0.0"\n[dependencies]\nheld_c = {path="held-c"}\n')
  yield* fs.writeFileString(join(held, 'src/tasks.silk'), heldTasks(false))
  const heldPlan = (linked: string | undefined) => [
    'import silk.build.plan { Plan }',
    'import silk.build.step { sourcePath }',
    'static fn plan() -> Plan {',
    `  return Plan.empty() |> Plan.compileNative("c", sourcePath("native/needs.c"), &[], &[])${linked === undefined ? '' : ` |> Plan.linkDependency("${linked}")`}`,
    '}',
    'pub const PLAN: Plan = plan()',
    '',
  ].join('\n')
  const declaredOnly = yield* invoke(silk, ['run', '--stdlib', standardLibrary], held, requestEnv, 120_000)
  assert.notEqual(declaredOnly.status, 0, 'a declared dependency nothing imports does not link')
  assert.match(declaredOnly.stderr, /held_missing_symbol/)
  yield* fs.writeFileString(join(held, 'build.silk'), heldPlan('held_c'))
  const heldLinkedRun = yield* invoke(silk, ['run', '--stdlib', standardLibrary], held, requestEnv, 120_000)
  assert.equal(heldLinkedRun.status, 0, heldLinkedRun.stderr)
  const stillHeld = yield* invoke(silk, ['task', '--stdlib', standardLibrary, 'code'], held, requestEnv, 120_000)
  assert.equal(stillHeld.status, 29, stillHeld.stderr)
  // Each package's tasks program has a directory of its own, so one package's task can run
  // another's in the same workspace even where a running executable cannot be replaced.
  assert.ok(existsSync(join(held, 'build/steps/tasks/held-native')), 'the tasks program is under its package name')
  // The tasks program never evaluates the plan it does not reach, so an archive the package uses
  // but its tasks manifest lacks, or one only a task prepares, does not stop the task.
  yield* fs.writeFileString(join(held, 'build.silk'), [
    'import silk.build.plan { Plan }',
    'static fn plan() -> Plan {',
    '  return Plan.empty() |> Plan.compileNative("c", Plan.archivePath("undeclared", "x.c"), &[], &[])',
    '}',
    'pub const PLAN: Plan = plan()',
    '',
  ].join('\n'))
  const unevaluated = yield* invoke(silk, ['task', '--stdlib', standardLibrary, 'code'], held, requestEnv, 120_000)
  assert.equal(unevaluated.status, 29, unevaluated.stderr)
  // A check compiles no native code, so it never fetches an archive that native code reads; a
  // build still does, and says which archive it could not fetch.
  yield* fs.writeFileString(join(held, 'silk.toml'), [
    '[package]',
    'name="held-native"',
    'silk-version = "0.0.0"',
    '[dependencies]',
    'held_c = {path="held-c"}',
    '[native.archive.prepared]',
    'url = "file:///nonexistent-prepared-by-a-task"',
    'sha256 = "0000000000000000000000000000000000000000000000000000000000000000"',
    '',
  ].join('\n'))
  yield* fs.writeFileString(join(held, 'build.silk'), [
    'import silk.build.plan { Plan }',
    'static fn plan() -> Plan {',
    '  return Plan.empty() |> Plan.compileNative("c", Plan.archivePath("prepared", "x.c"), &[], &[])',
    '}',
    'pub const PLAN: Plan = plan()',
    '',
  ].join('\n'))
  const checkedUnfetched = yield* invoke(silk, ['check', '--stdlib', standardLibrary], held, requestEnv, 120_000)
  assert.equal(checkedUnfetched.status, 0, checkedUnfetched.stderr)
  const builtUnfetched = yield* invoke(silk, ['build', '--stdlib', standardLibrary], held, requestEnv, 120_000)
  assert.notEqual(builtUnfetched.status, 0)
  assert.match(builtUnfetched.stderr, /cannot fetch archive prepared/)
  yield* fs.writeFileString(join(held, 'silk.toml'), '[package]\nname="held-native"\nsilk-version = "0.0.0"\n[dependencies]\nheld_c = {path="held-c"}\n')
  yield* fs.writeFileString(join(held, 'build.silk'), heldPlan('absent'))
  const undeclared = yield* invoke(silk, ['run', '--stdlib', standardLibrary], held, requestEnv, 120_000)
  assert.notEqual(undeclared.status, 0)
  assert.match(undeclared.stderr, /Plan\.linkDependency names `absent`, which the package's manifest does not declare/)
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
  const emittedVersion = versioned.stdout.match(/^silk v(.+)\n$/)?.[1]
  assert.ok(emittedVersion !== undefined && isVersion(emittedVersion), versioned.stdout)
  const helped = yield* invoke(silk, ['--help'], directory)
  assert.equal(helped.status, 0, helped.stderr)
  // The overview leads with the project commands, one line each.
  assert.match(helped.stdout, /^usage: silk <command> \[options\]\n\nProject commands:\n {2}init /)
  assert.doesNotMatch(helped.stdout, /\n {2}changes /)
  assert.match(helped.stdout, /\n {2}doc-reference /)
  // `silk help` prints the same overview, and `silk help <command>` that command's synopsis.
  const helpCommand = yield* invoke(silk, ['help'], directory)
  assert.equal(helpCommand.status, 0, helpCommand.stderr)
  assert.equal(helpCommand.stdout, helped.stdout)
  const helpFormat = yield* invoke(silk, ['help', 'format'], directory)
  assert.equal(helpFormat.status, 0, helpFormat.stderr)
  assert.match(helpFormat.stdout, /^Usage: silk format \[options\] <paths>\n\nFormat Silk source and TOML files\n\nOptions:\n {6}--check /)
  const helpDocReference = yield* invoke(silk, ['help', 'doc-reference'], directory)
  assert.equal(helpDocReference.status, 0, helpDocReference.stderr)
  assert.match(helpDocReference.stdout, /^Usage: silk doc-reference \[options\]\n\nWrite the standard library reference pages\n/)
  assert.match(helpDocReference.stdout, /\n  -o, --output <value> /)
  // The options of the project form of `build` come before the single-file form.
  const helpBuild = yield* invoke(silk, ['help', 'build'], directory)
  assert.equal(helpBuild.status, 0, helpBuild.stderr)
  assert.match(helpBuild.stdout, /^Usage: silk build \[options\]\n\nBuild the package or the workspace members\n\nOptions:\n {6}--manifest-path <value> /)
  assert.match(helpBuild.stdout, /\n {2}-p, --package <value> /)
  assert.match(helpBuild.stdout, /\n\nUsage: silk build \[options\] <source>\n\nBuild one source file\n/)
  assert.match(helpBuild.stdout, /\n  -o, --output <value> +Where to write the artifact \(required\)\n/)
  const helpUnknown = yield* invoke(silk, ['help', 'frobnicate'], directory)
  assert.equal(helpUnknown.status, 2, helpUnknown.stderr)
  assert.match(helpUnknown.stderr, /^silk: unknown command `frobnicate`\nusage: silk <command>/)
  // `silk <command> --help` prints the same help as `silk help <command>`.
  const commandHelp = yield* invoke(silk, ['format', '--check', '--help'], directory)
  assert.equal(commandHelp.status, 0, commandHelp.stderr)
  assert.equal(commandHelp.stdout, helpFormat.stdout)
  // `run` lists the progress options it accepts, and answers `--help` after other options.
  const runHelp = yield* invoke(silk, ['run', '--release', '--help'], directory)
  assert.equal(runHelp.status, 0, runHelp.stderr)
  assert.match(runHelp.stdout, /^Usage: silk run \[options\] <arguments>\n/)
  assert.match(runHelp.stdout, /\n {6}--progress <value> +How to report progress on standard error \[choices: auto, live, plain, never\]\n/)
  assert.match(runHelp.stdout, /\n {6}--coredump <value> /)
  const debugHelp = yield* invoke(silk, ['debug', '--help'], directory)
  assert.equal(debugHelp.status, 0, debugHelp.stderr)
  assert.match(debugHelp.stdout, /\n {6}--port <value> .*\[default: 1234\]\n/)
  // Toolchains belong to the silk tool, not the compiler: `silk toolchain` and `+<version>` are unknown here.
  const toolchain = yield* invoke(silk, ['toolchain'], directory)
  assert.equal(toolchain.status, 2, toolchain.stderr)
  assert.match(toolchain.stderr, /^silk: unknown command `toolchain`\n/)
  // A command line that does not parse is a usage error, status 2, like format's and doc's.
  const unparsed = yield* invoke(silk, ['check', '--bogus'], directory)
  assert.equal(unparsed.status, 2, unparsed.stderr)
  assert.equal(unparsed.stderr, 'silk check: unknown option `--bogus`\nRun `silk help check` for its options.\n')
  // A misspelled option is named with the closest one the command takes.
  const relase = yield* invoke(silk, ['check', '--relase'], directory)
  assert.equal(relase.status, 2, relase.stderr)
  assert.match(relase.stderr, /^silk check: unknown option `--relase`; did you mean `--release`\?\n/)
  const combined = yield* invoke(silk, ['init', '--lib', '--workspace'], directory)
  assert.equal(combined.status, 2, combined.stderr)
  assert.match(combined.stderr, /^silk init: `--lib` and `--workspace` cannot be combined/)
  // A lone word is a mistyped command, even one that names a source file.
  for (const word of ['frobnicate', 'main.silk']) {
    const unknown = yield* invoke(silk, [word], directory)
    assert.equal(unknown.status, 2, unknown.stderr)
    assert.ok(unknown.stderr.startsWith(`silk: unknown command \`${word}\`\n`), unknown.stderr)
  }
  // `silk dump` prints one stage of the compiler on standard output, without Clang.
  const dumpEnv = { ...process.env, SILK_CLANG: sentinel }
  const tokens = yield* invoke(silk, ['dump', 'tokens', 'main.silk'], directory, dumpEnv)
  assert.equal(tokens.status, 0, tokens.stderr)
  const tokenLines = tokens.stdout.trimEnd().split('\n')
  assert.deepEqual(tokenLines.slice(0, 3), ['#0 PubKeyword 0..3 "pub"', '#1 Whitespace 3..4 " "', '#2 FnKeyword 4..6 "fn"'])
  assert.match(tokenLines[tokenLines.length - 1], /^#\d+ EndOfFile (\d+)\.\.\1 ""$/)
  const syntax = yield* invoke(silk, ['dump', 'syntax', 'main.silk'], directory, dumpEnv)
  assert.equal(syntax.status, 0, syntax.stderr)
  // Each element is indented one level under its node, and a token shows its text: `5 * 8` is
  // nested inside `2 + ...`.
  assert.match(syntax.stdout, /^SourceFile 0\.\.41\n {2}FunctionDeclaration 0\.\.41\n {4}PubKeyword 0\.\.3 "pub"\n/)
  assert.match(syntax.stdout, /\n {10}Plus 32\.\.33 "\+"\n {10}InfixExpression 34\.\.39\n(?: {12,}.*\n)* {12}Star 36\.\.37 "\*"\n/)
  assert.match(syntax.stdout, /\ndiagnostics 0\n$/)
  const hir = yield* invoke(silk, ['dump', 'hir', 'main.silk'], directory, dumpEnv)
  assert.equal(hir.status, 0, hir.stderr)
  assert.match(hir.stdout, /^documentation none\ndeclarations \[#\d+\]\n/)
  const mir = yield* invoke(silk, ['dump', 'mir', 'main.silk', '--stdlib', standardLibrary], directory, dumpEnv)
  assert.equal(mir.status, 0, mir.stderr)
  // Only the package's own functions are listed; the constant expression is still a multiply and
  // an add, since MIR is listed before LLVM optimizes it.
  assert.deepEqual([...mir.stdout.matchAll(/^fn (.*)$/gm)].map((header) => header[1]), ['main.main() -> i32'])
  assert.match(mir.stdout, /\n {2}let _0: i32 {2}\/\/ return\n/)
  assert.match(mir.stdout, /\nbb0:\n(?: {2}.*\n)* {2}_\d+ = 5_i32 \* 8_i32\n/)
  assert.match(mir.stdout, /\n {2}return\n\n$/)
  const single = yield* fs.makeTempDirectoryScoped({ prefix: 'silk-erased-mir-' })
  yield* fs.copyFile(join(repository, 'corpus/native/erased-dispatch-single/main.silk'), join(single, 'main.silk'))
  const dispatched = yield* invoke(silk, ['dump', 'mir', 'main.silk', '--stdlib', standardLibrary], single, dumpEnv)
  assert.equal(dispatched.status, 0, dispatched.stderr)
  const dispatcher = dispatched.stdout.split(/^fn /m).find((body) => body.startsWith('main.Read.read<any '))
  assert.ok(dispatcher, dispatched.stdout)
  assert.match(dispatcher, /call main\.Read for Letter\.read\(move _1\.1\)/)
  assert.doesNotMatch(dispatcher, /switch|discriminant/)
  const everything = yield* invoke(silk, ['dump', 'mir', 'main.silk', '--all', '--stdlib', standardLibrary, '--target', 'wasm32-wasip1'], directory, dumpEnv)
  assert.equal(everything.status, 0, everything.stderr)
  assert.match(everything.stdout, /^fn silk\/platform\/wasi\//m)
  assert.ok(!existsSync(marker), 'silk dump ran Clang')
  const badStage = yield* invoke(silk, ['dump', 'llvm', 'main.silk'], directory)
  assert.equal(badStage.status, 2, badStage.stderr)
  assert.equal(badStage.stderr, 'silk dump: `<stage>` takes tokens, syntax, hir or mir\nRun `silk help dump` for its options.\n')
  const optioned = yield* invoke(silk, ['dump', 'syntax', 'main.silk', '--all'], directory)
  assert.equal(optioned.status, 2, optioned.stderr)
  assert.match(optioned.stderr, /^silk dump: the tokens, syntax and hir stages take no options\n/)
  const absent = yield* invoke(silk, ['dump', 'syntax', 'missing.silk'], directory)
  assert.equal(absent.status, 2, absent.stderr)
  assert.equal(absent.stderr, 'silk dump: no such source file `missing.silk`\n')
  // Release notes belong to the silk tool (`silk change`), not the compiler.
  const changes = yield* invoke(silk, ['changes'], directory)
  assert.equal(changes.status, 2, changes.stderr)
  assert.match(changes.stderr, /^silk: unknown command `changes`\n/)
  // Build the silk tool with the compiler under test and exercise its linked changes library through
  // the native entry point. No compiler, Git, or other tool is available on this subprocess PATH.
  const silkTool = join(directory, 'silktool')
  const toolDefinition = join(directory, 'tool-definition.toml')
  const toolRequest = join(directory, 'tool-request.toml')
  yield* fs.writeFileString(toolDefinition,
    `manifest = ${encodeJson(join(repository, 'tool/silk.toml'))}\nstdlib = ${encodeJson(standardLibrary)}\n[settings]\nmodules = []\n[settings.profile]\n[settings.native]\nsources = []\nlink = []\n`)
  const toolResolved = yield* invoke(silk, ['resolve', '--definition', toolDefinition, '--output', toolRequest], directory,
    { ...process.env, SILK_CLANG: clang }, 600_000)
  assert.equal(toolResolved.status, 0, toolResolved.stderr)
  const toolBuild = yield* invoke(silk, ['compile', '--request', toolRequest], directory,
    { ...process.env, SILK_CLANG: clang }, 600_000)
  assert.equal(toolBuild.status, 0, toolBuild.stderr)
  yield* fs.copyFile(join(directory, 'artifact'), silkTool)
  const releaseWorkspace = join(directory, 'release-workspace')
  const releaseMember = join(releaseWorkspace, 'compiler')
  const releaseNested = join(releaseMember, 'src/nested')
  const changesEnvironment = { ...process.env, PATH: '' }
  const workspaceManifest = '[workspace]\nmembers = ["compiler", "changes"]\n'
  yield* fs.makeDirectory(releaseNested, { recursive: true })
  yield* fs.makeDirectory(join(releaseWorkspace, 'changes'), { recursive: true })
  yield* fs.writeFileString(join(releaseWorkspace, 'silk.toml'), workspaceManifest)
  yield* fs.writeFileString(
    join(releaseMember, 'silk.toml'),
    '[package]\nname = "native-release"\nversion = "1.0.0"\nsilk-version = "0.0.0"\n[release]\nversion-file = "src/ReleaseVersion.silk"\n',
  )
  yield* fs.writeFileString(
    join(releaseWorkspace, 'changes/silk.toml'),
    '[package]\nname = "release-consumer"\nversion = "0.1.0"\nsilk-version = "0.0.0"\n\n[dependencies]\nreleased = { path = "../compiler" }\n',
  )
  for (const args of [
    ['change'],
    ['change', '--help'],
    ['change', '--dir', 'compiler', '--help'],
  ]) {
    const help = yield* invoke(silkTool, args, releaseWorkspace, changesEnvironment)
    assert.equal(help.status, 0, help.stderr)
    assert.match(help.stdout, /^Usage: silk change \[options\] <command>\n/)
    assert.match(help.stdout, /\n  patch +Record a patch change\n/)
    assert.equal(help.stderr, '')
  }
  const missingDirectory = yield* invoke(silkTool,
    ['change', '--dir'],
    releaseWorkspace,
    changesEnvironment,
  )
  assert.equal(missingDirectory.status, 2)
  assert.match(missingDirectory.stderr, /^error: --dir needs a value\n/)
  assert.doesNotMatch(missingDirectory.stderr, /\.lock/, 'an argument error writes nothing to recover')
  for (const args of [
    ['patch', 'Must not create a workspace release'],
    ['status'],
    ['version'],
    ['recover'],
  ]) {
    const refused = yield* invoke(silkTool, ['change', ...args], releaseWorkspace, changesEnvironment)
    assert.equal(refused.status, 1)
    assert.match(refused.stderr, /silk change: .*virtual workspace/)
    assert.equal(refused.stdout, '')
  }
  assert.equal(yield* fs.exists(join(releaseWorkspace, '.changes')), false)
  assert.equal(yield* fs.readFileString(join(releaseWorkspace, 'silk.toml')), workspaceManifest)
  const summary = 'Use native release commands'
  const migration =
    'Replace "silk changes" with "silk change".\nKeep release records in version control.'
  // Notes nest a migration under its change, so its later lines are indented.
  const renderedMigration = migration.replaceAll('\n', '\n    ')
  const addedChange = yield* invoke(silkTool,
    ['change', 'minor', summary, '--migration', migration],
    releaseNested,
    changesEnvironment,
  )
  assert.equal(addedChange.status, 0, addedChange.stderr)
  const pendingChanges = yield* fs.readDirectory(join(releaseMember, '.changes'))
  assert.equal(pendingChanges.length, 1)
  const [pendingChange] = pendingChanges
  assert.ok(pendingChange)
  assert.match(pendingChange, /^[0-9a-f]{32}\.md$/)
  const preview = yield* invoke(silkTool,
    ['change', '--dir', 'compiler', 'status', '--tag', 'beta'],
    releaseWorkspace,
    changesEnvironment,
  )
  assert.equal(preview.status, 0, preview.stderr)
  assert.match(preview.stdout, /native-release: 1\.0\.0 -> 1\.1\.0-beta\.1/)
  assert.match(yield* fs.readFileString(join(releaseMember, 'silk.toml')), /version = "1.0.0"/)
  const prereleased = yield* invoke(silkTool,
    ['change', '--dir', 'compiler', 'version', '--tag', 'beta'],
    releaseWorkspace,
    changesEnvironment,
  )
  assert.equal(prereleased.status, 0, prereleased.stderr)
  const archive = join(releaseMember, '.changes/releases/1.1.0-beta.1.toml')
  const releaseArchive = yield* fs.readFileString(archive)
  assert.equal(yield* fs.exists(join(releaseMember, '.changes', pendingChange)), false)
  assert.match(yield* fs.readFileString(join(releaseMember, 'CHANGELOG.md')), /## 1\.1\.0-beta\.1/)
  // The release TOML, not hand-edited Markdown, supplies carried promotion notes.
  const correctedSummary = 'Use corrected native release commands'
  assert.ok(releaseArchive.includes(summary))
  yield* fs.writeFileString(archive, releaseArchive.replace(summary, correctedSummary))
  yield* fs.writeFileString(join(releaseMember, 'CHANGELOG.md'), 'Manual notes must disappear.\n')
  // Publication reads corrected TOML, not the hand-edited derived Markdown.
  const betaPublication = yield* invoke(silkTool,
    ['change', 'release', '--json'],
    releaseNested,
    changesEnvironment,
  )
  assert.equal(betaPublication.status, 0, betaPublication.stderr)
  const beta = yield* decodeRelease(betaPublication.stdout)
  assert.equal(beta.package, 'native-release')
  assert.equal(beta.version, '1.1.0-beta.1')
  assert.equal(beta.tag, 'v1.1.0-beta.1')
  assert.equal(beta.prerelease, true)
  assert.ok(beta.notes.includes(correctedSummary))
  assert.ok(beta.notes.includes(renderedMigration))
  assert.ok(!beta.notes.includes('Manual notes'))
  const promoted = yield* invoke(silkTool, ['change', 'version'], releaseNested, changesEnvironment)
  assert.equal(promoted.status, 0, promoted.stderr)
  assert.match(yield* fs.readFileString(join(releaseMember, 'silk.toml')), /version = "1.1.0"/)
  const changelog = yield* fs.readFileString(join(releaseMember, 'CHANGELOG.md'))
  assert.match(changelog, /## 1\.1\.0\n/)
  assert.ok(changelog.includes(correctedSummary))
  assert.ok(changelog.includes(renderedMigration))
  assert.ok(!changelog.includes('Manual notes'))
  const stableArchive = yield* fs.readFileString(
    join(releaseMember, '.changes/releases/1.1.0.toml'),
  )
  assert.match(stableArchive, /\nfrom = "1\.1\.0-beta\.1"\nversion = "1\.1\.0"\n/)
  assert.ok(stableArchive.includes(correctedSummary))
  const stablePublication = yield* invoke(silkTool,
    ['change', 'release', '--json'],
    releaseNested,
    changesEnvironment,
  )
  assert.equal(stablePublication.status, 0, stablePublication.stderr)
  const stable = yield* decodeRelease(stablePublication.stdout)
  assert.equal(stable.version, '1.1.0')
  assert.equal(stable.tag, 'v1.1.0')
  assert.equal(stable.prerelease, false)
  assert.ok(stable.notes.includes(correctedSummary))
  assert.ok(stable.notes.includes(renderedMigration))
  const expectedHistory = {
    package: 'native-release',
    from: '1.0.0',
    to: '1.1.0',
    releases: [
      {
        format: 1,
        package: 'native-release',
        from: '1.1.0-beta.1',
        version: '1.1.0',
        base: '1.0.0',
        changes: [
          {
            id: pendingChange,
            bump: 'minor',
            summary: correctedSummary,
            migration,
            updated: false,
          },
        ],
      },
    ],
  }
  for (const args of [
    ['change', '--dir', 'compiler', 'since', '1.0.0', '--json'],
    [
      'change',
      '--dir',
      'changes',
      'since',
      'released',
      '--from',
      '1.0.0',
      '--source',
      '../compiler',
      '--json',
    ],
  ]) {
    const history = yield* invoke(silkTool, args, releaseWorkspace, changesEnvironment)
    assert.equal(history.status, 0, history.stderr)
    assert.equal(history.stderr, '')
    assert.deepEqual(yield* decodeJson(history.stdout), expectedHistory)
  }
  // A writer interrupted before its ready marker leaves a lock but no applied changes.
  const releaseLock = join(releaseMember, '.changes/.lock')
  yield* fs.makeDirectory(releaseLock)
  const locked = yield* invoke(silkTool, ['change', 'status'], releaseNested, changesEnvironment)
  assert.equal(locked.status, 1)
  assert.match(locked.stderr, /silk change .*recover/)
  const recovered = yield* invoke(silkTool,
    ['change', '--dir', 'compiler', 'recover'],
    releaseWorkspace,
    changesEnvironment,
  )
  assert.equal(recovered.status, 0, recovered.stderr)
  assert.equal(yield* fs.exists(releaseLock), false)
  assert.equal(
    yield* fs.readFileString(join(releaseMember, '.changes/releases/1.1.0.toml')),
    stableArchive,
  )
  assert.equal(yield* fs.exists(join(releaseWorkspace, 'changes/.changes')), false)
  const ir = yield* invoke(silk, [...argumentsFor('module.ll'), '--emit', 'llvm-ir'], directory, {
    ...process.env,
    SILK_CLANG: sentinel,
  })
  assert.equal(ir.status, 0, ir.stderr)
  assert.equal(ir.error, undefined)
  assert.equal(yield* fs.exists(marker), false, 'IR output must not invoke Clang')
  assert.equal(yield* fs.exists(join(directory, 'module.ll.silk.bc')), false)
  const bytes = yield* fs.readFile(join(directory, 'module.ll'))
  assert.ok(bytes.length > 0)
  const verified = yield* invoke(
    clang,
    ['-x', 'ir', '-c', 'module.ll', '-o', 'verified.o'],
    directory,
  )
  assert.equal(verified.status, 0, verified.stderr)
  // A debug build's IR carries the line tables its objects get, which Clang reads as written.
  const debugIr = yield* invoke(silk, [...argumentsFor('debug.ll'), '--debug', 'true', '--optimization', 'none', '--emit', 'llvm-ir'],
    directory, { ...process.env, SILK_CLANG: sentinel })
  assert.equal(debugIr.status, 0, debugIr.stderr)
  const debugText = yield* fs.readFileString(join(directory, 'debug.ll'))
  assert.match(debugText, /^define [^\n]* !dbg !\d+ \{$/m)
  assert.match(debugText, /= distinct !DISubprogram\(name: "main\.main", scope: !\d+, file: !\d+, line: \d+,/)
  assert.match(debugText, /, !dbg !\d+\n/)
  assert.match(debugText, /= !DIFile\(filename: "[^"]*main\.silk"/)
  const debugObject = yield* invoke(clang, ['-x', 'ir', '-c', 'debug.ll', '-o', 'debug.o'], directory)
  assert.equal(debugObject.status, 0, debugObject.stderr)
  const debugRows = yield* invoke(join(dirname(clang), 'llvm-dwarfdump'), ['--debug-line', 'debug.o'], directory)
  assert.equal(debugRows.status, 0, debugRows.stderr)
  assert.match(debugRows.stdout, /^0x[0-9a-f]+\s+[1-9]\d*\s+\d+\s/m)
  // A debug build declares each parameter and binding at the slot that holds it, with its type, so
  // a debugger reads them by name. A binding a return writes in place is declared at the result.
  yield* fs.writeFileString(
    join(directory, 'variables.silk'),
    'fn pick(values: &[i32], index: usize) -> i32 {\n  let total = values[index] + 1\n  return total\n}\n\n' +
      'pub fn main() -> i32 {\n  let values = [1, 2, 3]\n  let chosen = pick(&values, 1)\n  return chosen - 3\n}\n',
  )
  const variablesIr = yield* invoke(silk, ['build', 'variables.silk', '-o', 'variables.ll', '--stdlib', standardLibrary,
    '--debug', 'true', '--optimization', 'none', '--emit', 'llvm-ir'], directory, { ...process.env, SILK_CLANG: sentinel })
  assert.equal(variablesIr.status, 0, variablesIr.stderr)
  assert.match(yield* fs.readFileString(join(directory, 'variables.ll')), /#dbg_declare\(ptr %[\w.]+, !\d+, !DIExpression\(\), !\d+\)/)
  // The slots and parameter spills before a function's first statement carry no location, so a
  // debugger's prologue ends after them and a breakpoint on the function reads its parameters.
  const variablesBitcode = yield* invoke(silk, ['build', 'variables.silk', '-o', 'variables.bc', '--stdlib', standardLibrary,
    '--debug', 'true', '--optimization', 'none', '--emit', 'llvm-bitcode'], directory, { ...process.env, SILK_CLANG: clang })
  assert.equal(variablesBitcode.status, 0, variablesBitcode.stderr)
  const fromBitcode = yield* invoke(join(dirname(clang), 'llvm-dis'), ['variables.bc', '-o', 'variables-bitcode.ll'], directory)
  assert.equal(fromBitcode.status, 0, fromBitcode.stderr)
  for (const listing of ['variables.ll', 'variables-bitcode.ll']) {
    const text = yield* fs.readFileString(join(directory, listing))
    const subprogram = text.match(/^(!\d+) = distinct !DISubprogram\(name: "variables\.pick"/m)?.[1]
    assert.ok(subprogram, listing)
    // Its body up to the first located instruction holds the slots and a spill of each parameter.
    const body = text.slice(text.indexOf(`!dbg ${subprogram} {\n`))
    const opening = body.slice(0, body.indexOf(', !dbg '))
    assert.match(opening, /^\s*%[\w.]+ = alloca /m, listing)
    assert.ok((opening.match(/^\s*store /gm)?.length ?? 0) >= 3, listing)
  }
  const fromText = yield* invoke(clang, ['-x', 'ir', '-c', 'variables.ll', '-o', 'variables-text.o'], directory)
  assert.equal(fromText.status, 0, fromText.stderr)
  const variablesObject = yield* invoke(silk, ['build', 'variables.silk', '-o', 'variables.o', '--stdlib', standardLibrary,
    '--debug', 'true', '--optimization', 'none', '--emit', 'object'], directory, { ...process.env, SILK_CLANG: clang })
  assert.equal(variablesObject.status, 0, variablesObject.stderr)
  const literal = (text: string) => text.replace(/[[\]&;().]/g, '\\$&')
  // One debug-info entry with `tag`, `name` and `type`, without crossing into the next entry.
  const declared = (tag: string, name: string, type: string) =>
    new RegExp(`${tag}\\n(?:[ \\t]+DW_AT_\\w+[^\\n]*\\n)*?[ \\t]+DW_AT_name\\t\\("${name}"\\)\\n` +
      `(?:[ \\t]+DW_AT_\\w+[^\\n]*\\n)*?[ \\t]+DW_AT_type\\t\\([^"\\n]*"${literal(type)}"\\)`)
  for (const object of ['variables-text.o', 'variables.o']) {
    const variablesInfo = yield* invoke(join(dirname(clang), 'llvm-dwarfdump'), ['--debug-info', object], directory)
    assert.equal(variablesInfo.status, 0, variablesInfo.stderr)
    assert.doesNotMatch(variablesInfo.stderr, /invalid|error/i, object)
    assert.match(variablesInfo.stdout, declared('DW_TAG_formal_parameter', 'values', '&[i32]'), object)
    assert.match(variablesInfo.stdout, declared('DW_TAG_formal_parameter', 'index', 'usize'), object)
    assert.match(variablesInfo.stdout, declared('DW_TAG_variable', 'total', 'i32'), object)
    assert.match(variablesInfo.stdout, declared('DW_TAG_variable', 'values', '[i32; 3]'), object)
    assert.match(variablesInfo.stdout, /DW_TAG_member\n[ \t]+DW_AT_name\t\("length"\)/, object)
    assert.match(variablesInfo.stdout, /DW_TAG_member\n[ \t]+DW_AT_name\t\("\[2\]"\)/, object)
  }
  const captured = join(directory, 'completed-backend.bc')
  const linker = join(directory, 'clang-capture')
  yield* fs.writeFileString(
    linker,
    `#!/bin/sh\nfor input in "$@"; do\ncase "$input" in\n*.silk.bc) cp "$input" ${quote(captured)} ;;\nesac\ndone\nexec ${quote(clang)} "$@"\n`,
  )
  yield* fs.chmod(linker, 0o755)
  const linked = yield* invoke(silk, argumentsFor('program'), directory, {
    ...process.env,
    SILK_CLANG: linker,
  })
  assert.equal(linked.status, 0, linked.stderr)
  // Borrow-check receipts are for the harnesses that set SILK_RECEIPTS, not a successful build.
  assert.doesNotMatch(linked.stderr, /SILK_GAP/)
  const receipted = yield* invoke(silk, argumentsFor('receipted'), directory, {
    ...process.env,
    SILK_CLANG: clang,
    SILK_RECEIPTS: '1',
  })
  assert.equal(receipted.status, 0, receipted.stderr)
  assert.match(receipted.stderr, /^SILK_GAP borrow-check: \d+ bodies not borrow-checked/m)
  // The single-source `Compiled` line names the paths from the working directory, never with `../`
  // steps relative to the source's directory, and an output outside it absolutely.
  assert.match(linked.stdout, /^Compiled main\.silk -> program \(llvm, /)
  const outsidePath = join(dirname(directory), `${basename(directory)}-outside.ll`)
  const outside = yield* invoke(
    silk,
    [...argumentsFor(outsidePath), '--emit', 'llvm-ir'],
    directory,
  )
  assert.equal(outside.status, 0, outside.stderr)
  assert.ok(outside.stdout.startsWith(`Compiled main.silk -> ${outsidePath} (llvm, `), outside.stdout)
  yield* fs.remove(outsidePath)
  // A single-source rejection prints the human diagnostic; only SILK_RECEIPTS selects the
  // SILK_BUILD_ERROR record the corpus harness parses.
  yield* fs.writeFileString(join(directory, 'bad.silk'), 'pub fn main() -> i32 { return "x" }\n')
  const badArguments = ['build', 'bad.silk', '-o', 'bad', '--stdlib', standardLibrary]
  const human = yield* invoke(silk, badArguments, directory, { ...process.env, SILK_CLANG: clang })
  assert.notEqual(human.status, 0)
  assert.doesNotMatch(human.stderr, /SILK_BUILD_ERROR/)
  assert.match(human.stderr, /SEM\d{4}/)
  assert.match(human.stderr, /bad\.silk:1:/)
  const machine = yield* invoke(silk, badArguments, directory, {
    ...process.env,
    SILK_CLANG: clang,
    SILK_RECEIPTS: '1',
  })
  assert.match(machine.stderr, /^SILK_BUILD_ERROR=\{"code":"SEM\d{4}"/m)
  // A shuffle index out of range is refused with the range, not the vector shape rule (SEM0239).
  yield* fs.writeFileString(
    join(directory, 'shuffle.silk'),
    'pub fn main() -> i32 {\n  let u = Intrinsic.simdSplat<simd<u32, 4>>(1)\n' +
      '  let h = Intrinsic.simdShuffle<simd<u32, 4>, simd<u32, 4>>(u, u, [0, 1, 2, 8])\n  return 0\n}\n',
  )
  const shuffled = yield* invoke(
    silk,
    ['build', 'shuffle.silk', '-o', 'shuffle', '--stdlib', standardLibrary],
    directory,
    { ...process.env, SILK_CLANG: clang },
  )
  assert.notEqual(shuffled.status, 0)
  assert.match(
    shuffled.stderr,
    /shuffle\.silk:3:67: error\[SEM0239\] Intrinsic\.simdShuffle needs 4 static lane indices, one per result lane, each below 8/,
  )
  // The linked bitcode and the printed IR are one module: LLVM reads both back to the same text,
  // apart from the module's own file name and the local value names the linked bitcode leaves out.
  const disassembled = Effect.fnUntraced(function* (input: string, output: string) {
    const read = yield* invoke(join(dirname(clang), 'opt'), ['-S', '-passes=strip', input, '-o', output], directory)
    assert.equal(read.status, 0, read.stderr)
    return (yield* fs.readFileString(join(directory, output)))
      .split('\n')
      .filter((line) => !line.startsWith('; ModuleID') && !line.startsWith('source_filename'))
      .join('\n')
  })
  const assembled = yield* invoke(join(dirname(clang), 'llvm-as'), ['module.ll', '-o', 'module.bc'], directory)
  assert.equal(assembled.status, 0, assembled.stderr)
  assert.equal(
    yield* disassembled(captured, 'completed-backend.ll'),
    yield* disassembled('module.bc', 'module-read.ll'),
    'IR output must print the exact module passed to executable linking',
  )
  assert.equal(yield* fs.exists(join(directory, 'program.silk.bc')), false)
  const ran = yield* invoke(join(directory, 'program'), [], directory)
  assert.equal(ran.status, 42, ran.stderr)
  const explicit = yield* invoke(
    silk,
    [...argumentsFor('explicit'), '--emit', 'final'],
    directory,
    { ...process.env, SILK_CLANG: clang },
  )
  assert.equal(explicit.status, 0, explicit.stderr)
  assert.equal(yield* fs.exists(join(directory, 'explicit.silk.bc')), false)
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
  // A SILK_CLANG that cannot start is named with where it came from.
  const unstarted = yield* invoke(silk, argumentsFor('unstarted'), directory, {
    ...process.env,
    SILK_CLANG: join(directory, 'no-such-clang'),
  })
  assert.equal(unstarted.status, 2, unstarted.stderr)
  assert.match(
    unstarted.stderr,
    /silk: cannot run the C compiler .*no-such-clang \(from SILK_CLANG\)/,
  )
  // A --stdlib that holds no standard library is named, not reported as ARTIFACT-001.
  const noLibrary = yield* invoke(
    silk,
    ['build', 'main.silk', '-o', 'no-library', '--stdlib', join(directory, 'no-library')],
    directory,
    { ...process.env, SILK_CLANG: clang },
  )
  assert.equal(noLibrary.status, 1, noLibrary.stderr)
  assert.match(noLibrary.stderr, /--stdlib .*no-library is not a standard library directory/)
  assert.equal(yield* fs.exists(join(directory, 'unnamed')), false)
  // Another native target emits its IR without linking; only the host links a native executable.
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
  // ARM64 inline assembly shares the machine contract across Linux and Darwin. Exercise
  // source admission, flags normalization and the actual instruction, not just a successful build.
  const hintSource = [
    'unsafe fn hint() -> () {',
    '  unsafe Intrinsic.assembly<()>("yield", "", "", "write", true, false, ())',
    '}',
    'unsafe fn add(left: u64, right: u64) -> u64 {',
    '  return unsafe Intrinsic.assembly<u64>("adds $0, $1, $2", "={x0},0,{x17}", "flags", "none", false, false, (left, right))',
    '}',
    'pub fn main() -> i32 {',
    '  unsafe hint()',
    '  let total = unsafe add(40, 2)',
    '  if total == 42 { return 42 }',
    '  return 1',
    '}',
    '',
  ].join('\n')
  yield* fs.writeFileString(join(directory, 'hint.silk'), hintSource)
  for (const target of ['aarch64-apple-darwin', 'aarch64-unknown-linux-gnu']) {
    const hintArguments = (output: string) => [
      'build', 'hint.silk', '-o', output, '--stdlib', standardLibrary, '--target', target,
    ]
    const hintIr = yield* invoke(
      silk,
      [...hintArguments('hint.ll'), '--emit', 'llvm-ir'],
      directory,
      { ...process.env, SILK_CLANG: sentinel },
    )
    assert.equal(hintIr.status, 0, hintIr.stderr)
    const hintText = yield* fs.readFileString(join(directory, 'hint.ll'))
    assert.match(hintText, /call void asm sideeffect "yield", "~\{memory\}"\(\) memory\(write,/)
    assert.match(hintText, /call i64 asm "adds \$0, \$1, \$2", "=\{x0\},0,\{x17\},~\{cc\}"/)
    const hintAssembly = yield* invoke(
      silk,
      [...hintArguments('hint.s'), '--emit', 'assembly'],
      directory,
      { ...process.env, SILK_CLANG: clang },
    )
    assert.equal(hintAssembly.status, 0, hintAssembly.stderr)
    const machineText = yield* fs.readFileString(join(directory, 'hint.s'))
    assert.match(machineText, /^\s*yield\s*$/m)
    assert.match(machineText, /^\s*adds\s+x0,\s*x0,\s*x17\s*$/m)
    const nativeHost = process.arch === 'arm64' &&
      ((process.platform === 'darwin' && target === 'aarch64-apple-darwin') ||
        (process.platform === 'linux' && target === 'aarch64-unknown-linux-gnu'))
    if (nativeHost) {
      const hintBuild = yield* invoke(
        silk,
        hintArguments('hint'),
        directory,
        { ...process.env, SILK_CLANG: clang },
      )
      assert.equal(hintBuild.status, 0, hintBuild.stderr)
      const hinted = yield* invoke(join(directory, 'hint'), [], directory)
      assert.equal(hinted.status, 42, hinted.stderr)
    }
  }
  // Reserved/ABI registers are invalid as inputs, outputs and clobbers. Unsupported targets,
  // lane shapes, operand references, overlaps and contradictory effects still fail before Clang.
  const rejectedAssembly = [
    ['reserved output', 'u64', 'mov $0, #0', '={x18}', '', 'none', true, '()'],
    ['reserved input', '()', 'yield', '{x18}', '', 'none', true, '.(word)'],
    ...['x18', 'x19', 'x29', 'x30', 'sp', 'rax'].map((register) =>
      [`clobber ${register}`, '()', 'yield', '', register, 'none', true, '()'] as const),
    ['overlapping clobber', 'u64', 'mov $0, #0', '={x0}', 'x0', 'none', true, '()'],
    ['invalid operand lane', '()', 'yield', '{x0}', '', 'none', true, '.(narrow)'],
    ['missing operand', '()', 'yield', '{x0}', '', 'none', true, '()'],
    ['unknown operand reference', '()', 'mov $0, #0', '', '', 'none', true, '()'],
    ['unobservable write', '()', 'yield', '', '', 'write', false, '()'],
  ] as const
  for (const [name, result, template, constraints, clobbers, memory, sideEffects, inputs] of rejectedAssembly) {
    yield* fs.writeFileString(
      join(directory, 'invalid-assembly.silk'),
      `pub fn main() -> i32 {\n  let word: u64 = 1\n  let narrow: u32 = 1\n  unsafe Intrinsic.assembly<${result}>("${template}", "${constraints}", "${clobbers}", "${memory}", ${sideEffects}, false, ${inputs})\n  return 0\n}\n`,
    )
    const rejected = yield* invoke(
      silk,
      ['build', 'invalid-assembly.silk', '-o', 'invalid-assembly.ll', '--stdlib', standardLibrary,
        '--target', 'aarch64-apple-darwin', '--emit', 'llvm-ir'],
      directory,
      { ...process.env, SILK_CLANG: sentinel },
    )
    assert.notEqual(rejected.status, 0, `accepted ${name}`)
    assert.match(rejected.stderr, /SEM0214/, `${name}: ${rejected.stderr}`)
  }
  const wasmHint = yield* invoke(
    silk,
    ['build', 'hint.silk', '-o', 'wasm-hint.ll', '--stdlib', standardLibrary, '--target', 'wasm32-unknown-unknown',
      '--emit', 'llvm-ir'],
    directory,
    { ...process.env, SILK_CLANG: sentinel },
  )
  assert.notEqual(wasmHint.status, 0, 'Wasm must not admit native CPU hints')
  assert.match(wasmHint.stderr, /SEM0214/)
  // wasm32 links freestanding on any host, with no C runtime and no host imports.
  const wasm = yield* invoke(
    silk,
    [...argumentsFor('program.wasm'), '--target', 'wasm32-unknown-unknown'],
    directory,
    { ...process.env, SILK_CLANG: clang },
  )
  assert.equal(wasm.status, 0, wasm.stderr)
  const wasmModule = new WebAssembly.Module(yield* fs.readFile(join(directory, 'program.wasm')))
  assert.deepEqual(WebAssembly.Module.imports(wasmModule), [])
  assert.deepEqual(
    WebAssembly.Module.exports(wasmModule)
      .map((entry) => entry.name)
      .sort(),
    ['main', 'memory', 'silk_report', 'silk_report_length'],
    'a module exports only its named C exports, its memory and its report buffer',
  )
  const wasmMain = new WebAssembly.Instance(wasmModule, {}).exports.main as () => number
  assert.equal(wasmMain(), 42)
  // A trap and an unhandled error write their Silk report into the module, and the std lib's
  // runner turns it into an Error whose stack names the module's frames (#2599).
  const runner = (yield* Effect.promise(
    () => import(pathToFileURL(join(standardLibrary, 'host/wasm-runner.mjs')).href),
  )) as {
    runWasm: (
      bytes: Uint8Array,
      options?: { onReport?: (report: string) => void; onLog?: (level: string, text: string) => void },
    ) => Promise<number>
    SilkError: new (...values: Array<unknown>) => Error & { report: string }
  }
  // `pick` lives in a second file, so the line table names two sources.
  yield* fs.writeFileString(
    join(directory, 'picking.silk'),
    'pub fn pick(values: &[i32], at: usize) -> i32 { return values[at] }\n',
  )
  yield* fs.writeFileString(
    join(directory, 'trap.silk'),
    [
      'import picking',
      'fn outer(at: usize) -> i32 { let values: [i32; 2] = [1, 2] return picking.pick(&values, at) }',
      'pub fn main() -> i32 { return outer(5) }',
      '',
    ].join('\n'),
  )
  yield* fs.writeFileString(
    join(directory, 'failure.silk'),
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
      'pub effect fn main() -> () ! ConfigError { drop run load(7) }',
      '',
    ].join('\n'),
  )
  for (const name of ['trap', 'failure']) {
    const built = yield* invoke(
      silk,
      ['build', `${name}.silk`, '-o', `${name}.wasm`, '--stdlib', standardLibrary, '--target', 'wasm32-unknown-unknown',
        '--optimization', 'none', '--debug', 'true'],
      directory,
      { ...process.env, SILK_CLANG: clang },
    )
    assert.equal(built.status, 0, built.stderr)
  }
  // A debug browser module ships without its DWARF: the module with it is `<output>.debug.wasm`,
  // and a source map derived from its lines is `<output>.map`, each named by a custom section.
  const shipped = new WebAssembly.Module(yield* fs.readFile(join(directory, 'trap.wasm')))
  const sectionText = (name: string) =>
    WebAssembly.Module.customSections(shipped, name).map((section) => {
      const bytes = new Uint8Array(section)
      return new TextDecoder().decode(bytes.subarray(1, 1 + bytes[0]))
    })
  assert.deepEqual(WebAssembly.Module.customSections(shipped, '.debug_info'), [])
  assert.deepEqual(sectionText('external_debug_info'), ['trap.wasm.debug.wasm'])
  assert.deepEqual(sectionText('sourceMappingURL'), ['trap.wasm.map'])
  const withDwarf = new WebAssembly.Module(yield* fs.readFile(join(directory, 'trap.wasm.debug.wasm')))
  assert.equal(WebAssembly.Module.customSections(withDwarf, '.debug_line').length, 1)
  const sourceMap = JSON.parse(yield* fs.readFileString(join(directory, 'trap.wasm.map'))) as {
    version: number
    sources: Array<string>
    sourcesContent: Array<string | null>
    mappings: string
  }
  assert.equal(sourceMap.version, 3)
  const trapSource = sourceMap.sources.findIndex((path) => path.endsWith('/trap.silk'))
  assert.ok(trapSource >= 0, sourceMap.sources.join(', '))
  assert.equal(sourceMap.sourcesContent[trapSource], yield* fs.readFileString(join(directory, 'trap.silk')))
  // Each sequence starts in file 1, so a function there names it without `set_file`.
  const pickingSource = sourceMap.sources.findIndex((path) => path.endsWith('/picking.silk'))
  assert.ok(pickingSource >= 0, sourceMap.sources.join(', '))
  assert.match(sourceMap.mappings, /^[A-Za-z0-9+/]+(,[A-Za-z0-9+/]+)*$/)
  const trapBytes = yield* fs.readFile(join(directory, 'trap.wasm'))
  const trapped = yield* Effect.promise(() =>
    runner.runWasm(trapBytes).then(
      () => undefined,
      (error: unknown) => error,
    )
  )
  assert.ok(trapped instanceof runner.SilkError, String(trapped))
  assert.equal(trapped.message, 'fatal trap: index out of bounds')
  assert.match(trapped.report, /^fatal trap: index out of bounds\n {2}at picking\.pick \(picking:1:\d+\)\n/)
  assert.match(trapped.stack ?? '', /trap\.outer/, 'the engine stack names the callers from the name section')
  const reports: Array<string> = []
  const failureBytes = yield* fs.readFile(join(directory, 'failure.wasm'))
  const failedStatus = yield* Effect.promise(() =>
    runner.runWasm(failureBytes, { onReport: (report) => reports.push(report) })
  )
  assert.equal(failedStatus, 1)
  assert.match(
    reports.join(''),
    /^unhandled error: failure\.ConfigError\n {2}at failure\.load \(failure:9:\d+\)\n {2}at failure\.main \(failure:10:\d+\)\nunhandled value: ConfigError \{ code: 7 \}\n$/,
  )
  // `ConsoleLogger` hands each message to the host's console through the one import a module
  // that logs this way has; a message longer than its buffer arrives in parts the runner joins.
  yield* fs.writeFileString(
    join(directory, 'logging.silk'),
    [
      'import silk.core.effect { Effect }',
      'import silk.io.logger { Logger }',
      'import silk.concurrency.sync { Arc }',
      'import silk.mem.allocator { Allocator, OutOfMemoryError }',
      'import silk.io.logger_console { ConsoleLogger }',
      'pub effect fn main() -> () ! OutOfMemoryError {',
      '  let mut allocator = Allocator.systemAllocatorProvider()',
      '  let logger = run Arc<ConsoleLogger>.make(ConsoleLogger.make()) |> Effect.provideMut<Allocator>(&mut allocator)',
      `  let values = .{ name: "silk", long: "${'x'.repeat(600)}" }`,
      '  run Effect.logInfo("{name} started", &values) |> Effect.provideAmbient<Logger>(&logger)',
      '  run Effect.logError("long {long}!", &values) |> Effect.provideAmbient<Logger>(&logger)',
      '  return ()',
      '}',
      '',
    ].join('\n'),
  )
  const logBuilt = yield* invoke(
    silk,
    ['build', 'logging.silk', '-o', 'logging.wasm', '--stdlib', standardLibrary, '--target', 'wasm32-unknown-unknown'],
    directory,
    { ...process.env, SILK_CLANG: clang },
  )
  assert.equal(logBuilt.status, 0, logBuilt.stderr)
  const logBytes = yield* fs.readFile(join(directory, 'logging.wasm'))
  assert.deepEqual(WebAssembly.Module.imports(new WebAssembly.Module(logBytes)), [
    { module: 'silk', name: 'console', kind: 'function' },
  ])
  const consoleLines: Array<[string, string]> = []
  const loggedStatus = yield* Effect.promise(() =>
    runner.runWasm(logBytes, { onLog: (level, text) => consoleLines.push([level, text]) })
  )
  assert.equal(loggedStatus, 0)
  assert.deepEqual(consoleLines, [['info', 'silk started'], ['error', `long ${'x'.repeat(600)}!`]])
  // Clang's generic wasm CPU enables bulk memory only from Clang 19, and the runtime needs it: the
  // compiler asks for it, so a Clang whose default leaves it off still builds the module.
  const withoutBulkMemory = join(directory, 'clang-without-bulk-memory')
  yield* fs.writeFileString(
    withoutBulkMemory,
    `#!/bin/sh\nexec ${quote(clang)} -mno-bulk-memory "$@"\n`,
  )
  yield* fs.chmod(withoutBulkMemory, 0o755)
  const olderClang = yield* invoke(
    silk,
    [...argumentsFor('older.wasm'), '--target', 'wasm32-unknown-unknown'],
    directory,
    { ...process.env, SILK_CLANG: withoutBulkMemory },
  )
  assert.equal(olderClang.status, 0, olderClang.stderr)
  const olderModule = new WebAssembly.Module(yield* fs.readFile(join(directory, 'older.wasm')))
  const olderMain = new WebAssembly.Instance(olderModule, {}).exports.main as () => number
  assert.equal(olderMain(), 42)
  // An adopted allocation's drop calls its reclaim function. wasm32 numbers functions by table
  // index from 1, and an exported reclaim whose address is the module's first takes index 1, the
  // value that once marked system storage: both drops must reach the reclaim, not `free`.
  const adopted = join(directory, 'adopted')
  yield* fs.makeDirectory(adopted, { recursive: true })
  yield* fs.writeFileString(
    join(adopted, 'silk.toml'),
    '[package]\nname = "adopted"\nversion = "0.0.0"\nsilk-version = "0.0.0"\nsource = "."\n',
  )
  yield* fs.writeFileString(
    join(adopted, 'main.silk'),
    [
      'import silk.mem.layout { Layout }',
      'import silk.mem.pointer { Pointer }',
      '',
      '// Counts every reclaim through the context address, a `usize` the program owns.',
      'export "C" fn countReclaim(context: ?*mut u8) -> () {',
      '  let present = unsafe Intrinsic.pointerRequalify<?*mut u8, *mut u8>(context)',
      '  let counter = unsafe Intrinsic.pointerReinterpret<*mut u8, *mut usize>(present)',
      '  unsafe { Pointer.write<usize>(counter, Pointer.read<usize>(counter) + 1) }',
      '  return ()',
      '}',
      '',
      '// Adopts two allocations over its own storage and drops them; both drops must reach `countReclaim`.',
      'fn adoptTwice() -> usize {',
      '  let mut first: u32 = 0',
      '  let mut second: u32 = 0',
      '  let mut count: usize = 0',
      '  let counter = unsafe Intrinsic.pointerReinterpret<*mut usize, *mut u8>(Pointer.fromMutRef(&mut count))',
      '  let reclaim: extern "C" fn(?*mut u8) -> () = countReclaim',
      '  let at = unsafe Intrinsic.pointerReinterpret<*mut u32, *mut u8>(Pointer.fromMutRef(&mut first))',
      '  let next = unsafe Intrinsic.pointerReinterpret<*mut u32, *mut u8>(Pointer.fromMutRef(&mut second))',
      '  let one = unsafe Intrinsic.allocationAdopt(at, Layout { bytes: 4, alignment: 4 }, reclaim, counter)',
      '  let two = unsafe Intrinsic.allocationAdopt(next, Layout { bytes: 4, alignment: 4 }, reclaim, counter)',
      '  drop one',
      '  drop two',
      '  return count',
      '}',
      '',
      '// Exported so the reclaim address is the first function address the module takes.',
      'export "C" fn exercise() -> usize { return adoptTwice() }',
      '',
      'pub fn main() -> i32 {',
      '  return 42',
      '}',
      '',
    ].join('\n'),
  )
  const adoptedBuild = yield* invoke(
    silk,
    [
      'build',
      'main.silk',
      '-o',
      'adopted.wasm',
      '--target',
      'wasm32-unknown-unknown',
      '--stdlib',
      standardLibrary,
    ],
    adopted,
    { ...process.env, SILK_CLANG: clang },
  )
  assert.equal(adoptedBuild.status, 0, adoptedBuild.stderr)
  const adoptedModule = new WebAssembly.Instance(
    new WebAssembly.Module(yield* fs.readFile(join(adopted, 'adopted.wasm'))),
    {},
  )
  const exercise = adoptedModule.exports.exercise as () => number
  assert.equal(exercise(), 2, 'both adopted drops reach their reclaim function on wasm32')
  for (const selectors of [
    ['--emit', 'invalid'],
    ['--emit'],
    ['--emit', 'llvm-ir', '--emit', 'llvm-ir'],
    ['--emit', 'final', '--emit', 'llvm-ir'],
    // The artifact form is the manifest's `[package].kind`; `--emit` names only a stage.
    ['--emit', 'executable'],
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
  const hostTarget = (yield* fs.readDirectory(join(directory, 'build'))).find((entry) => /^(x86_64|aarch64)-/.test(entry))
  assert.ok(hostTarget, 'run must place its executable below build/<target>')
  assert.equal(
    yield* fs.exists(join(directory, 'build', hostTarget, 'dev/native-build')),
    true,
  )
  // `debug` builds the same executable and becomes LLDB on it, with the program's arguments after
  // its path; `--coredump` belongs to WASI programs and is refused for a native one.
  const lldb = join(directory, 'fake-lldb')
  yield* fs.writeFileString(lldb, '#!/bin/sh\nprintf "%s\\n" "$@"\n')
  yield* fs.chmod(lldb, 0o755)
  const debugged = yield* invoke(
    silk,
    ['debug', '--stdlib', standardLibrary, 'first', '--', '--stdlib'],
    directory,
    { ...process.env, SILK_CLANG: clang, SILK_LLDB: lldb },
  )
  assert.equal(debugged.status, 0, debugged.stderr)
  // Before the program, LLDB gets a summary that shows a `string` by its length.
  const stringSummary = /^-o\nscript def silk_string\(value, internal\): [^\n]+\n-o\ntype summary add -x '\^string\(<\.\+>\)\?\$' -F silk_string\n/
  const debuggedProgram = /--\n\S*\/build\/[^/]+\/dev\/native-build\nfirst\n--stdlib\n$/
  assert.match(debugged.stdout, new RegExp(stringSummary.source + debuggedProgram.source))
  // An empty `SILK_LLDB` is unset: `debug` uses `lldb` on PATH.
  const lldbDirectory = join(directory, 'lldb-path')
  yield* fs.makeDirectory(lldbDirectory)
  yield* fs.copyFile(lldb, join(lldbDirectory, 'lldb'))
  yield* fs.chmod(join(lldbDirectory, 'lldb'), 0o755)
  const defaulted = yield* invoke(
    silk,
    ['debug', '--stdlib', standardLibrary],
    directory,
    { ...process.env, SILK_CLANG: clang, SILK_LLDB: '', PATH: `${lldbDirectory}:${process.env.PATH ?? ''}` },
  )
  assert.equal(defaulted.status, 0, defaulted.stderr)
  assert.match(defaulted.stdout, new RegExp(stringSummary.source + /--\n\S*\/dev\/native-build\n$/.source))
  const nativeCore = yield* invoke(
    silk,
    ['run', '--stdlib', standardLibrary, '--coredump', 'core.dump'],
    directory,
    { ...process.env, SILK_CLANG: clang },
  )
  assert.equal(nativeCore.status, 2, nativeCore.stderr)
  assert.match(nativeCore.stderr, /`--coredump` needs a WASI target/)
  // `clean` removes the whole output directory; a project already clean stays clean.
  const cleaned = yield* invoke(silk, ['clean'], directory)
  assert.equal(cleaned.status, 0, cleaned.stderr)
  assert.equal(yield* fs.exists(join(directory, 'build')), false)
  assert.equal(yield* fs.exists(join(directory, 'main.silk')), true)
  assert.match(cleaned.stdout, /^Removed \S+build\n$/)
  const recleaned = yield* invoke(silk, ['clean'], directory)
  assert.equal(recleaned.status, 0, recleaned.stderr)
  assert.match(recleaned.stdout, /^Nothing to clean: \S+build does not exist\n$/)
  // `init -t minimal` writes, offline, a project whose generated entry `run` builds and runs.
  const initialized = yield* invoke(silk, ['init', 'greeting', '-t', 'minimal'], directory)
  assert.equal(initialized.status, 0, initialized.stderr)
  // It names the project relative to the working directory, then what to run next: `cd` into the
  // project, then `silk run` with what it does. Output that is not a terminal has no escape codes.
  assert.equal(initialized.stdout, '  Created greeting from the minimal template\n\n  Next steps:\n    cd greeting\n    silk dev   run it, and run it again when you change it\n')
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
  // A package manager can install the library itself as a symbolic link, and `--stdlib` can name one.
  const linkedPrefix = join(directory, 'linked-prefix')
  yield* fs.makeDirectory(join(linkedPrefix, 'bin'), { recursive: true })
  yield* fs.makeDirectory(join(linkedPrefix, 'lib/silk'), { recursive: true })
  yield* fs.copyFile(silk, join(linkedPrefix, 'bin/silk'))
  yield* fs.chmod(join(linkedPrefix, 'bin/silk'), 0o755)
  yield* fs.symlink(join(prefix, 'lib/silk/stdlib'), join(linkedPrefix, 'lib/silk/stdlib'))
  const linkedLibrary = yield* invoke(join(linkedPrefix, 'bin/silk'), ['run'], join(directory, 'greeting'), {
    ...process.env,
    SILK_CLANG: clang,
  })
  assert.equal(linkedLibrary.status, 0, linkedLibrary.stderr)
  const linkedArgument = yield* invoke(
    silk,
    ['check', '--stdlib', join(linkedPrefix, 'lib/silk/stdlib')],
    join(directory, 'greeting'),
  )
  assert.equal(linkedArgument.status, 0, linkedArgument.stderr)
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
  // Each target reports its progress on standard error, as plain lines when that is not a terminal;
  // standard output stays empty.
  assert.equal(checked.stdout, '')
  assert.match(checked.stderr, new RegExp(`^Checking greeting \\(${hostTarget}\\)\n`))
  assert.match(checked.stderr, new RegExp(`^Checking greeting \\(${foreign}\\)\n`, 'm'))
  // The two targets, and first the package's tasks program, which `silk init` writes.
  assert.equal(checked.stderr.match(/^Finished greeting in /gm)?.length, 3, checked.stderr)
  assert.doesNotMatch(checked.stderr, /\x1b/)
  assert.equal(yield* fs.exists(marker), false, 'check must not invoke Clang')
  yield* fs.makeDirectory(join(directory, 'rejected/src'), { recursive: true })
  yield* fs.writeFileString(
    join(directory, 'rejected/silk.toml'),
    '[package]\nname = "rejected"\nversion = "0.1.0"\nsilk-version = "0.0.0"\n',
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
  // The progress report heads standard error, so the target heading starts a later line.
  assert.match(rejected.stderr, new RegExp(`^\\[${hostTarget}\\]\n`, 'm'))
  // A human diagnostic names its file from the package directory.
  assert.match(rejected.stderr, /^src\/main\.silk:6:16: error\[SEM0037\]/m)
  assert.match(rejected.stderr, /^Failed rejected in /m)
  assert.equal(rejected.stdout, '')
  // `build` heads its diagnostics with the target as `check` and `run` do, also for an import of
  // a module that does not exist.
  yield* fs.makeDirectory(join(directory, 'unknown/src'), { recursive: true })
  yield* fs.writeFileString(
    join(directory, 'unknown/silk.toml'),
    '[package]\nname = "unknown"\nversion = "0.1.0"\nsilk-version = "0.0.0"\n',
  )
  yield* fs.writeFileString(
    join(directory, 'unknown/src/main.silk'),
    'import nowhere.thing\n\npub fn main() -> i32 {\n  return 0\n}\n',
  )
  const unknownModule = yield* invoke(
    silk,
    ['build', '--stdlib', standardLibrary],
    join(directory, 'unknown'),
  )
  assert.equal(unknownModule.status, 1, unknownModule.stderr)
  assert.match(
    unknownModule.stderr,
    new RegExp(`^\\[${hostTarget}\\]\nsrc/main\\.silk:1:8: error\\[MOD0001\\]`, 'm'),
  )
  assert.match(unknownModule.stderr, /^Failed unknown in /m)
  // Module paths match file names exactly, also where the filesystem ignores case; an import that
  // differs from a file only in letter case names the file's spelling.
  yield* fs.makeDirectory(join(directory, 'casing/src/util'), { recursive: true })
  yield* fs.writeFileString(
    join(directory, 'casing/silk.toml'),
    '[package]\nname = "casing"\nversion = "0.1.0"\nsilk-version = "0.0.0"\n',
  )
  yield* fs.writeFileString(join(directory, 'casing/src/util/Math.silk'), 'pub fn twice(value: i32) -> i32 {\n  return value * 2\n}\n')
  yield* fs.writeFileString(
    join(directory, 'casing/src/main.silk'),
    'import util.math { twice }\n\npub fn main() -> i32 {\n  return twice(0)\n}\n',
  )
  const casing = yield* invoke(silk, ['check', '--stdlib', standardLibrary], join(directory, 'casing'))
  assert.equal(casing.status, 1, casing.stderr)
  assert.match(
    casing.stderr,
    /^src\/main\.silk:1:8: error\[MOD0001\] Unknown module util\.math\n  note: did you mean `util\.Math`\? Module paths match file names exactly, including letter case$/m,
  )
  // Unused bindings are warnings, and a warning fails `check` and `build` unless `--ignore-warnings`
  // allows it. Each command runs at least twice, so a warm run reports the warnings of a module it
  // does not parse again, and a build that reuses an allowed build's artifact fails for its
  // warnings again. An interface import that only method syntax uses is not reported.
  yield* fs.makeDirectory(join(directory, 'unused/src'), { recursive: true })
  yield* fs.writeFileString(
    join(directory, 'unused/silk.toml'),
    '[package]\nname = "unused"\nversion = "0.1.0"\nsilk-version = "0.0.0"\n',
  )
  yield* fs.writeFileString(
    join(directory, 'unused/src/main.silk'),
    'import helper { value }\nimport shape { Area, Square }\n\npub fn main() -> i32 {\n  let idle = 1\n  let _kept = 2\n  let square = Square {side: 0}\n  return value() + square.area()\n}\n',
  )
  yield* fs.writeFileString(
    join(directory, 'unused/src/helper.silk'),
    'import silk.num.usize\n\npub fn value() -> i32 {\n  let spare = 1\n  return 0\n}\n',
  )
  yield* fs.writeFileString(
    join(directory, 'unused/src/shape.silk'),
    'pub interface Area {\n  fn area(self: &Self) -> i32\n}\n\npub struct Square {\n  pub side: i32,\n}\n\nimpl Area for Square {\n  fn area(self: &Self) -> i32 {\n    return self.side * self.side\n  }\n}\n',
  )
  const unusedRuns: ReadonlyArray<readonly [string, boolean]> = [
    ['check', false], ['check', false], ['check', true],
    ['build', true], ['build', false], ['build', false], ['build', true],
  ]
  for (const [command, ignored] of unusedRuns) {
    const unused = yield* invoke(silk, [
      command, '--stdlib', standardLibrary,
      ...(command === 'build' ? ['--clang', clang] : []),
      ...(ignored ? ['--ignore-warnings'] : []),
    ], join(directory, 'unused'))
    assert.equal(unused.status, ignored ? 0 : 1, unused.stderr)
    assert.match(unused.stderr, /^src\/main\.silk:5:7: warning\[SEM0255\] `idle` is never used/m)
    assert.match(unused.stderr, /^src\/helper\.silk:4:7: warning\[SEM0255\] `spare` is never used/m)
    assert.match(unused.stderr, /^src\/helper\.silk:1:17: warning\[MOD0007\] Import `usize` is never used/m)
    assert.doesNotMatch(unused.stderr, /_kept|`Area`/)
    if (ignored) assert.doesNotMatch(unused.stderr, /--ignore-warnings/)
    else assert.match(unused.stderr, /^silk: warnings fail this command; fix them, or pass --ignore-warnings to allow them$/m)
  }
  // A path dependency is the author's own code, so its warnings are reported and fail the
  // dependent's check and build too (#3149).
  yield* fs.makeDirectory(join(directory, 'unuseddep/src'), { recursive: true })
  yield* fs.makeDirectory(join(directory, 'unusedapp/src'), { recursive: true })
  yield* fs.writeFileString(
    join(directory, 'unuseddep/silk.toml'),
    '[package]\nname = "unuseddep"\nversion = "0.1.0"\nkind = "library"\nexports = ["lib"]\nsilk-version = "0.0.0"\n',
  )
  yield* fs.writeFileString(join(directory, 'unuseddep/src/lib.silk'), 'import silk.num.u64\n\npub fn value() -> i32 {\n  return 0\n}\n')
  yield* fs.writeFileString(
    join(directory, 'unusedapp/silk.toml'),
    '[package]\nname = "unusedapp"\nversion = "0.1.0"\nsilk-version = "0.0.0"\n\n[dependencies]\nunuseddep = { path = "../unuseddep" }\n',
  )
  yield* fs.writeFileString(join(directory, 'unusedapp/src/main.silk'), 'import unuseddep.lib\n\npub fn main() -> i32 {\n  return lib.value()\n}\n')
  for (const command of ['check', 'build']) {
    const dependent = yield* invoke(silk, [
      command, '--stdlib', standardLibrary, ...(command === 'build' ? ['--clang', clang] : []),
    ], join(directory, 'unusedapp'))
    assert.equal(dependent.status, 1, dependent.stderr)
    assert.match(dependent.stderr, /unuseddep\/src\/lib\.silk:1:17: warning\[MOD0007\] Import `u64` is never used/m)
  }
  // A package that cannot be loaded ends its load row as failed and still names itself on its
  // final line.
  yield* fs.makeDirectory(join(directory, 'unexported/src'), { recursive: true })
  yield* fs.writeFileString(
    join(directory, 'unexported/silk.toml'),
    '[package]\nname = "unexported"\nversion = "0.1.0"\nexports = ["nope"]\nsilk-version = "0.0.0"\n',
  )
  yield* fs.writeFileString(
    join(directory, 'unexported/src/main.silk'),
    'pub fn main() -> i32 {\n  return 0\n}\n',
  )
  const unexported = yield* invoke(
    silk,
    ['check', '--stdlib', standardLibrary],
    join(directory, 'unexported'),
  )
  assert.equal(unexported.status, 2, unexported.stderr)
  assert.match(
    unexported.stderr,
    /^Checking unexported \([^\n]*\)\n  load      failed: 1 error +[0-9.ms ]+s\nInvalid Silk project manifest [^\n]*unexported\/silk\.toml:4: [^\n]+\nFailed unexported in /,
  )
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
  // The synchronous runtime starts only an i32 Effect requiring HostInput: check reports another
  // `main` at the entry (SEM0225), as build does, rather than inside the runtime source.
  yield* fs.makeDirectory(join(directory, 'synchronous/src'), { recursive: true })
  yield* fs.writeFileString(
    join(directory, 'synchronous/silk.toml'),
    '[package]\nname = "synchronous"\nversion = "0.1.0"\nsilk-version = "0.0.0"\n\n[unstable]\ncomposition = { runtimes = [{ name = "synchronous", module = "silk/platform/native/start_sync" }], defaults = ["synchronous"] }\n',
  )
  yield* fs.writeFileString(
    join(directory, 'synchronous/src/main.silk'),
    'pub fn main() -> i32 {\n  return 7\n}\n',
  )
  for (const command of ['check', 'build']) {
    const refused = yield* invoke(
      silk,
      [command, '--stdlib', standardLibrary],
      join(directory, 'synchronous'),
    )
    assert.equal(refused.status, 1, refused.stderr)
    assert.match(
      refused.stderr,
      /^src\/main\.silk:1:8: error\[SEM0225\] Entry point `main` has a result or requirement the selected runtime `silk\/platform\/native\/start_sync` cannot start/m,
    )
    assert.doesNotMatch(refused.stderr, /platform\/native\/start_sync\.silk:/)
  }
  // A `main` that returns a borrow such as `string` gets the entry point error once, not the
  // `'static` hint that only leads to it.
  yield* fs.makeDirectory(join(directory, 'textmain/src'), { recursive: true })
  yield* fs.writeFileString(
    join(directory, 'textmain/silk.toml'),
    '[package]\nname = "textmain"\nversion = "0.1.0"\nsilk-version = "0.0.0"\n',
  )
  yield* fs.writeFileString(join(directory, 'textmain/src/main.silk'), 'pub fn main() -> string {\n  return "x"\n}\n')
  for (const command of ['check', 'build']) {
    const refused = yield* invoke(silk, [command, '--stdlib', standardLibrary], join(directory, 'textmain'))
    assert.equal(refused.status, 1, refused.stderr)
    assert.equal(refused.stderr.match(/error\[SEM0225\] Entry point `main` has a result the selected runtime cannot start/g)?.length, 1, refused.stderr)
    assert.doesNotMatch(refused.stderr, /SEM0210/)
  }
  // Errors new users meet in the book's later chapters name their subject and the fix, and a
  // `var` binding adds no unknown-value error at each later use.
  const fiberRoot = (body: string) =>
    'import silk.core.effect { Effect }\nimport silk.concurrency.fiber { Fiber }\nimport silk.io.writer { Writer, WriterError }\nimport silk.system.monotonic_clock { MonotonicClock }\nimport silk.mem.allocator { OutOfMemoryError }\nimport silk.concurrency.scheduler { Scheduler, TaskIdExhaustedError }\nimport silk.text.string { String }\n\n' +
    `effect fn root<'text>(title: string<'text>) -> () ! OutOfMemoryError | TaskIdExhaustedError ? &mut Scheduler | &mut MonotonicClock {\n  ${body}\n  drop fiber\n}\n\npub fn main() -> i32 {\n  return 0\n}\n`
  // A method call that borrows its receiver names the receiver, not the method.
  const boardRoot = (body: string) =>
    'struct Board {\n  pub items: [i32; 2],\n  pub count: usize,\n}\n\nimpl Board {\n  fn add(self: &mut Self, value: i32) -> usize {\n    self.items[0] = value\n    return self.count\n  }\n\n  fn first(self: &Self) -> &i32 {\n    return &self.items[0]\n  }\n}\n\n' +
    `pub fn main() -> i32 {\n  ${body}\n  return 0\n}\n`
  const testRoot = (body: string) =>
    `import silk.testing.testing { AssertionError, Testing }\n\n${body}\npub fn main() -> i32 {\n  return 0\n}\n`
  const subjects: Array<{ name: string; files: Record<string, string>; pattern: RegExp; errors?: number }> = [
    {
      name: 'fiberwriter',
      files: {
        'main.silk': fiberRoot('let fiber = run Fiber<(), WriterError>.forkChild(shout())') +
          'effect fn shout() -> () ! WriterError ? &mut Writer { run Writer.writeString("reminder!\\n") }\n',
      },
      pattern: /error\[SEM0076\] The Effect passed here also requires &mut Writer, but the expected Effect may only require &mut Scheduler \| &mut MonotonicClock/,
    },
    {
      name: 'fiberborrow',
      files: {
        'main.silk': fiberRoot('let fiber = run Fiber<usize, never>.forkChild(measure(title))') +
          'effect fn measure(title: string) -> usize ? &mut Scheduler | &mut MonotonicClock { return String.byteLength(title) }\n',
      },
      pattern: /error\[SEM0212\] This value must live for `'static`, but it borrows something/,
    },
    {
      name: 'localborrow',
      files: {
        'main.silk': "fn first<'a>(value: u8) -> &'a [u8] {\n  return &[value]\n}\n\npub fn main() -> i32 {\n  let _one = first(1)\n  return 0\n}\n",
      },
      pattern: /error\[SEM0212\] This borrows a value that lives only inside this function, but the borrow must stay valid after the function returns/,
    },
    {
      name: 'arrayprovider',
      files: {
        'main.silk': 'interface Shown {}\nimpl Shown for [u8; 4] {}\n\npub fn main() -> i32 {\n  return 0\n}\n',
      },
      pattern: /error\[SEM0083\] Invalid conformance: `\[u8; 4\]` cannot be the type an impl is for; that type is a declared struct, tuple, enum or union, a scalar, `string`, or a slice such as `&\[T\]`; declare a tuple or struct that holds the array/,
    },
    {
      name: 'privatefn',
      files: {
        'geo/shapes.silk': 'fn secret() -> i32 { return 0 }\n',
        'main.silk': 'import geo.shapes { secret }\n\npub fn main() -> i32 {\n  return secret()\n}\n',
      },
      pattern: /error\[SEM0015\] `secret` is private to geo\.shapes; mark it `pub`/,
    },
    {
      name: 'twobindings',
      files: {
        'geo/shapes.silk': 'pub fn shapes() -> i32 { return 0 }\n',
        'main.silk': 'import geo.shapes\nimport geo.shapes { shapes }\n\npub fn main() -> i32 {\n  return shapes()\n}\n',
      },
      pattern: /error\[SEM0016\] Multiple bindings claim shapes; rename one with `as`/,
    },
    {
      name: 'privatefield',
      files: {
        'geo/shapes.silk': 'pub struct P { x: i32, }\n\npub fn make() -> P { return P { x: 1 } }\n',
        'main.silk': 'import geo.shapes { make }\n\npub fn main() -> i32 {\n  let p = make()\n  return p.x\n}\n',
      },
      pattern: /error\[SEM0028\] Field `x` of geo\.shapes\.P is private; mark it `pub x`/,
    },
    {
      name: 'copybound',
      files: { 'main.silk': 'fn dup<C: Copy>(c: C) -> C {\n  return c\n}\n\npub fn main() -> i32 {\n  return dup(0)\n}\n' },
      pattern: /error\[SEM0001\] Unknown type Copy; is `import silk\.core\.ownership \{ Copy \}` missing\?/,
    },
    {
      name: 'moduletypo',
      files: {
        'geo/shapes.silk': 'pub fn f() -> i32 { return 0 }\n',
        'main.silk': 'import geo.shape { f }\n\npub fn main() -> i32 {\n  return f()\n}\n',
      },
      pattern: /error\[MOD0001\] Unknown module geo\.shape\n  note: did you mean `geo\.shapes`\?\n/,
    },
    {
      name: 'varbinding',
      files: { 'main.silk': 'pub fn main() -> i32 {\n  var x = 0\n  x = x + 1\n  return x\n}\n' },
      pattern: /error\[PAR0010\] `var` is not a Silk keyword; declare a binding you reassign with `let mut`/,
    },
    {
      name: 'receivermut',
      files: { 'main.silk': boardRoot('let board = Board { items: [0, 0], count: 0 }\n  drop board.add(1)') },
      pattern: /error\[SEM0057\] `board` is not mutable; declare it with `mut`, as in `let mut board`/,
    },
    {
      name: 'receiverloan',
      files: {
        'main.silk': boardRoot('let mut board = Board { items: [0, 0], count: 0 }\n  let first = &board.items[0]\n  drop board.add(1)\n  let read = first.*'),
      },
      pattern: /error\[OWN0010\] A mutable borrow of `board` conflicts with an earlier shared borrow of it/,
    },
    {
      name: 'receiverreferent',
      files: {
        'main.silk': boardRoot('let board = Board { items: [0, 0], count: 0 }\n  let first = board.first()\n  drop board\n  let read = first.*'),
      },
      pattern: /error\[OWN0019\] `first` is used after `board`, which it borrows, ended or was replaced/,
      errors: 2,
    },
    // A module that moved into a directory is suggested by name, and modules are spelled dotted.
    {
      name: 'movedmodule',
      files: {
        'geo/helper.silk': 'pub fn twice(value: i32) -> i32 { return value * 2 }\n',
        'main.silk': 'import helper { twice }\n\npub fn main() -> i32 {\n  return twice(1)\n}\n',
      },
      pattern: /error\[MOD0001\] Unknown module helper\n  note: did you mean `geo\.helper`\?\n/,
    },
    {
      name: 'missingmember',
      files: {
        'geo/helper.silk': 'pub fn double(value: i32) -> i32 { return value * 2 }\n',
        'main.silk': 'import geo.helper { twice }\n\npub fn main() -> i32 {\n  return twice(1)\n}\n',
      },
      pattern: /error\[SEM0014\] Module geo\.helper has no member twice/,
    },
    // A struct without a C layout is refused at the extern declaration, told how to declare one.
    {
      name: 'cplainstruct',
      files: {
        'main.silk': 'struct Point { x: f64, y: f64 }\n\nunsafe extern "C" fn lonely(p: Point) -> i32\n\npub fn main() -> i32 {\n  return 0\n}\n',
      },
      pattern: /main\.silk:3:32: error\[SEM0187\] main\.Point has no C layout; declare it `extern "C" struct` to pass it to C by value/,
    },
    {
      name: 'cstringlane',
      files: { 'main.silk': 'unsafe extern "C" fn puts(text: string) -> i32\n\npub fn main() -> i32 {\n  return 0\n}\n' },
      pattern: /error\[SEM0187\] string is not admitted by the C ABI/,
    },
    {
      name: 'cfieldtype',
      files: { 'main.silk': 'extern "C" struct Flag { ok: bool }\n\npub fn main() -> i32 {\n  return 0\n}\n' },
      pattern: /error\[SEM0206\] Field ok of C-layout record main\.Flag has unsupported type bool/,
    },
    // SEM0010 names every receiver: a tuple, a type declared inside `static if`, and a dotted
    // standard-library path.
    {
      name: 'tuplemethod',
      files: { 'main.silk': 'pub fn main() -> i32 {\n  let t = (1, 2)\n  drop t.frob()\n  return 0\n}\n' },
      pattern: /error\[SEM0010\] \(i32, i32\) has no method `frob`/,
    },
    {
      name: 'loggermethod',
      files: {
        'main.silk': 'import silk.io.logger_native { StdoutLogger }\n\npub fn main() -> i32 {\n  let l = StdoutLogger.make()\n  drop l.info("x")\n  return 0\n}\n',
      },
      pattern: /error\[SEM0010\] silk\.io\.logger_native\.StdoutLogger has no method `info`/,
    },
    {
      name: 'optionmethod',
      files: {
        'main.silk': 'import silk.core.option { Option }\n\npub fn main() -> i32 {\n  let o = Option<i32>.some(1)\n  drop o.frob()\n  return 0\n}\n',
      },
      pattern: /error\[SEM0010\] silk\.core\.option\.Option<i32> has no method `frob`/,
    },
    // `==` on two values whose type implements Equal is told to compare shared borrows.
    {
      name: 'borrowedequal',
      files: {
        'main.silk': 'import silk.core.equal { Equal }\n\nstruct Id { value: i32, }\n\nfn same(left: &Id, right: &Id) -> bool { return left.value == right.value }\n\nimpl Equal for Id { equals: same }\n\npub fn main() -> i32 {\n  let a = Id { value: 1 }\n  let b = Id { value: 1 }\n  if a == b { return 1 }\n  return 0\n}\n',
      },
      pattern: /error\[SEM0135\] Operator == does not accept \(main\.Id, main\.Id\); compare shared borrows, as in `&a == &b`/,
    },
    {
      name: 'plainequal',
      files: {
        'main.silk': 'struct Plain { value: i32, }\n\npub fn main() -> i32 {\n  let a = Plain { value: 1 }\n  let b = Plain { value: 1 }\n  if a == b { return 1 }\n  return 0\n}\n',
      },
      pattern: /error\[SEM0135\] Operator == does not accept \(main\.Plain, main\.Plain\)\n/,
    },
    // A name a module only imports is told where it is declared, not to be marked `pub`.
    {
      name: 'reimportstd',
      files: { 'main.silk': 'import silk.num.i64 { ParseError }\n\npub fn main() -> i32 {\n  return 0\n}\n' },
      pattern: /error\[SEM0015\] `ParseError` is not declared in silk\.num\.i64, which only imports it; import it from silk\.text\.format/,
    },
    {
      name: 'reimportlocal',
      files: {
        'base.silk': 'pub struct Err { pub code: i32, }\n',
        'mid.silk': 'import base { Err }\n\npub fn code(value: &Err) -> i32 { return value.code }\n',
        'main.silk': 'import mid { Err }\n\npub fn main() -> i32 {\n  return 0\n}\n',
      },
      pattern: /error\[SEM0015\] `Err` is not declared in mid, which only imports it; import it from base/,
    },
    {
      name: 'privatemember',
      files: {
        'mid.silk': 'fn hidden() -> i32 { return 1 }\n\npub fn shown() -> i32 { return hidden() }\n',
        'main.silk': 'import mid { hidden }\n\npub fn main() -> i32 {\n  return 0\n}\n',
      },
      pattern: /error\[SEM0015\] `hidden` is private to mid; mark it `pub` there to use it here/,
    },
    // A template value with Debug but not Display is pointed at `{value:?}`.
    {
      name: 'displaydebug',
      files: {
        'main.silk': 'import silk.core.effect { Effect }\nimport silk.core.option { Option }\n\npub effect fn main() -> () {\n  let o = Option<i32>.some(3)\n  run Effect.log("v {o}", &.{ o: move o })\n}\n',
      },
      pattern: /no implementation of `silk\.text\.format\.Display` exists for `silk\.core\.option\.Option<i32>`; it implements `silk\.text\.format\.Debug`, so a template prints it with `\{value:\?\}`/,
    },
    {
      name: 'displaynodebug',
      files: {
        'main.silk': 'import silk.core.effect { Effect }\n\nstruct Plain { value: i32, }\n\npub effect fn main() -> () {\n  let p = Plain { value: 1 }\n  run Effect.log("v {p}", &.{ p: move p })\n}\n',
      },
      pattern: /no implementation of `silk\.text\.format\.Display` exists for `main\.Plain`\n/,
    },
    // Operands read through a reference print with their lifetime elided.
    {
      name: 'fieldoperator',
      files: { 'main.silk': "struct W<'t> { text: string<'t>, }\n\nfn f(l: &W<'_>, r: &W<'_>) -> bool { return l.text < r.text }\n\npub fn main() -> i32 {\n  return 0\n}\n" },
      pattern: /error\[SEM0135\] Operator < does not accept \(string, string\)/,
    },
    // The arm blocks of a match used as a statement yield nothing.
    {
      name: 'blockarmvalue',
      files: { 'main.silk': 'pub fn main() -> i32 {\n  let n = 1\n  match n {\n    1 => {\n      0\n    }\n    _ => ()\n  }\n  return 0\n}\n' },
      pattern: /main\.silk:5:7: error\[SEM0087\] This match is a statement, so the last value of its arm block is ignored; use the match as a value, as in `let x = match \.\.\.`, or `drop` this value/,
    },
    // An `if` used as a value needs a final `else`.
    {
      name: 'ifwithoutelse',
      files: { 'main.silk': 'pub fn main() -> i32 {\n  let n = 1\n  let v = if n > 0 { 1 }\n  return v\n}\n' },
      pattern: /main\.silk:3:11: error\[PAR0009\] An `if` used as a value needs a final `else` branch, so that every path produces a value; add `else \{ \.\.\. \}`, or write the `if` as a statement/,
    },
    // `if` branches that cannot join are named as branches, not match arms.
    {
      name: 'ifbranchjoin',
      files: { 'main.silk': 'pub fn main() -> i32 {\n  let n = 1\n  let t = if n > 0 { let a = 3 } else { 4 }\n  return 0\n}\n' },
      pattern: /main\.silk:3:11: error\[SEM0049\] The branches of this `if` have no common result type; a branch whose block ends in a statement, such as `let`, produces `\(\)`/,
    },
    // A value left at the end of a statement `if` branch says the `if` is a statement.
    {
      name: 'ifstatementvalue',
      files: { 'main.silk': 'pub fn main() -> i32 {\n  let n = 1\n  if n > 0 { 3 } else { 4 }\n  return 0\n}\n' },
      pattern: /main\.silk:3:14: error\[SEM0087\] This `if` is a statement, so the last value of its branch block is ignored; with a final `else`, use the `if` as a value, as in `let x = if \.\.\.`, or `drop` this value/,
    },
    {
      name: 'blockarmearly',
      files: { 'main.silk': 'pub fn main() -> i32 {\n  let n = 1\n  match n {\n    1 => {\n      0\n      return 1\n    }\n    _ => ()\n  }\n  return 0\n}\n' },
      pattern: /error\[SEM0087\] Expression statement produces i32, but only \(\) or never may be ignored/,
    },
    // A private field the declaring module reads through a public function points at that function.
    {
      name: 'fieldaccessor',
      files: {
        'main.silk': 'import reading { Reading }\n\nfn f(now: &Reading) -> i64 { return now.seconds }\n\npub fn main() -> i32 {\n  return 0\n}\n',
        'reading.silk': 'pub struct Reading { seconds: i64, }\n\npub struct Clock {}\n\nimpl Clock {\n  pub fn seconds(self: &Reading) -> i64 { return self.seconds }\n}\n',
      },
      pattern: /error\[SEM0028\] Field `seconds` of reading\.Reading is private; read it with `Clock\.seconds\(&value\)` instead/,
    },
    // A provision that matches nothing names the provider, the service and what the Effect requires.
    {
      name: 'providerselector',
      files: { 'main.silk': 'import silk.core.effect { Effect }\n\nservice Doorbell {\n  effect fn ring() -> () ? &mut Doorbell\n}\n\nstruct Counting { rung: i32, }\n\nimpl Doorbell for Counting {\n  effect fn ring(self: &mut Self) -> () {\n    self.rung = self.rung + 1\n  }\n}\n\neffect fn visit() -> () ? &mut Doorbell {\n  run Doorbell.ring()\n}\n\nimport silk.system.system_clock { SystemClock }\n\npub effect fn main() -> i32 {\n  let mut bell = Counting { rung: 0 }\n  run visit() |> Effect.provideMut<SystemClock>(&mut bell)\n  return bell.rung\n}\n' },
      pattern: /error\[SEM0123\] The Effect does not require silk\.system\.system_clock\.SystemClock; it requires &mut main\.Doorbell/,
    },
    {
      name: 'providerunimplemented',
      files: { 'main.silk': 'import silk.core.effect { Effect }\n\nservice Doorbell {\n  effect fn ring() -> () ? &mut Doorbell\n}\n\nstruct Counting { rung: i32, }\n\nimpl Doorbell for Counting {\n  effect fn ring(self: &mut Self) -> () {\n    self.rung = self.rung + 1\n  }\n}\n\neffect fn visit() -> () ? &mut Doorbell {\n  run Doorbell.ring()\n}\n\npub effect fn main() -> i32 {\n  let mut plain = 3\n  run visit() |> Effect.provideMut<Doorbell>(&mut plain)\n  return plain\n}\n' },
      pattern: /error\[SEM0123\] i32 does not implement main\.Doorbell, so it cannot provide it/,
    },
    {
      name: 'providernone',
      files: { 'main.silk': 'import silk.core.effect { Effect }\n\nservice Doorbell {\n  effect fn ring() -> () ? &mut Doorbell\n}\n\nstruct Counting { rung: i32, }\n\nimpl Doorbell for Counting {\n  effect fn ring(self: &mut Self) -> () {\n    self.rung = self.rung + 1\n  }\n}\n\neffect fn visit() -> () ? &mut Doorbell {\n  run Doorbell.ring()\n}\n\npub effect fn main() -> i32 {\n  let mut plain = 3\n  run visit() |> Effect.provideMut(&mut plain)\n  return plain\n}\n' },
      pattern: /error\[SEM0123\] i32 implements none of the services the Effect requires: &mut main\.Doorbell/,
    },
    // A test cannot declare a requirement row, so SEM0071 there only offers a provider.
    {
      name: 'testrequirement',
      files: { 'main.silk': 'import silk.core.effect { Effect }\n\nservice Doorbell {\n  effect fn ring() -> () ? &mut Doorbell\n}\n\nstruct Counting { rung: i32, }\n\nimpl Doorbell for Counting {\n  effect fn ring(self: &mut Self) -> () {\n    self.rung = self.rung + 1\n  }\n}\n\neffect fn visit() -> () ? &mut Doorbell {\n  run Doorbell.ring()\n}\n\npub fn main() -> i32 {\n  return 0\n}\n\ntest effect fn rings() -> () {\n  run visit()\n}\n' },
      pattern: /error\[SEM0071\] This `run` needs `&mut Doorbell`, which a test cannot declare; provide it with `\|> Effect\.provideMut\(&mut value\)`/,
    },
    // A conformance member returning another type names both types.
    {
      name: 'witnessresult',
      files: { 'main.silk': 'import silk.system.system_clock { SystemClock }\n\nstruct Fixed {}\n\nimpl SystemClock for Fixed {\n  effect fn now(self: &mut Self) -> i64 { return 0 }\n  effect fn getResolution(self: &mut Self) -> u64 { return 1 }\n}\n\npub fn main() -> i32 {\n  return 0\n}\n' },
      pattern: /error\[SEM0083\] Invalid conformance: member `now` does not match the operation of `SystemClock`: it returns `i64`, but the operation returns `silk\.time\.instant\.Instant`/,
    },
    // A plain `test fn` that runs or declares a failure is told to become a `test effect fn`.
    {
      name: 'testrun',
      files: { 'main.silk': testRoot('test fn adds() {\n  run Testing.expect(1 + 1 == 2, "sum")\n}\n') },
      pattern: /error\[SEM0066\] This `run` can fail with `AssertionError<'static>`, but only an effect function can declare failures; write `test effect fn`/,
    },
    {
      name: 'testchannel',
      files: { 'main.silk': testRoot("test fn adds() ! AssertionError<'static> {\n  run Testing.expect(1 + 1 == 2, \"sum\")\n}\n") },
      pattern: /error\[SEM0062\] Only an effect function can declare failures; write `test effect fn` instead of `test fn`/,
    },
    {
      name: 'testshape',
      files: { 'main.silk': testRoot('test fn takes(value: i32) {}\n') },
      pattern: /error\[SEM0218\] Invalid test declaration: a test takes no parameters/,
    },
  ]
  for (const entry of subjects) {
    yield* fs.makeDirectory(join(directory, entry.name, 'src/geo'), { recursive: true })
    yield* fs.writeFileString(
      join(directory, entry.name, 'silk.toml'),
      `[package]\nname = "${entry.name}"\nversion = "0.1.0"\nsilk-version = "0.0.0"\n`,
    )
    for (const [path, text] of Object.entries(entry.files)) {
      yield* fs.writeFileString(join(directory, entry.name, 'src', path), text)
    }
    const refused = yield* invoke(silk, ['check', '--stdlib', standardLibrary], join(directory, entry.name))
    assert.equal(refused.status, 1, refused.stderr)
    assert.match(refused.stderr, entry.pattern)
    assert.equal(refused.stderr.match(/error\[/g)?.length, entry.errors ?? 1, refused.stderr)
  }
  // A workspace member's diagnostics name their files from the workspace root, also when the
  // member is built from its own directory; `--json` keeps the absolute path.
  yield* fs.makeDirectory(join(directory, 'relative/broken/src'), { recursive: true })
  yield* fs.writeFileString(join(directory, 'relative/silk.toml'), '[workspace]\nmembers = ["broken"]\n')
  yield* fs.writeFileString(
    join(directory, 'relative/broken/silk.toml'),
    '[package]\nname = "broken"\nversion = "0.1.0"\nsilk-version = "0.0.0"\n',
  )
  yield* fs.writeFileString(
    join(directory, 'relative/broken/src/main.silk'),
    'pub fn main() -> i32 {\n  let x: i32 = true\n  return x\n}\n',
  )
  for (const working of ['relative', 'relative/broken']) {
    const relative = yield* invoke(silk, ['check', '--stdlib', standardLibrary], join(directory, working))
    assert.equal(relative.status, 1, relative.stderr)
    assert.match(relative.stderr, /^broken\/src\/main\.silk:2:16: error\[SEM0037\]/m)
  }
  const absolute = yield* invoke(
    silk,
    ['check', '--json', '--stdlib', standardLibrary],
    join(directory, 'relative'),
  )
  assert.equal(absolute.status, 1, absolute.stderr)
  assert.match(absolute.stderr, /"path":"\/[^"]*\/relative\/broken\/src\/main\.silk"/)
  // A runtime the package writes itself keeps its own errors: they are not blamed on a valid `main`.
  yield* fs.makeDirectory(join(directory, 'ownruntime/src/support'), { recursive: true })
  yield* fs.writeFileString(
    join(directory, 'ownruntime/silk.toml'),
    '[package]\nname = "ownruntime"\nversion = "0.1.0"\nsilk-version = "0.0.0"\n\n[unstable]\ncomposition = { runtimes = [{ name = "start", module = "support/start" }], defaults = ["start"] }\n',
  )
  yield* fs.writeFileString(
    join(directory, 'ownruntime/src/main.silk'),
    'pub fn main() -> i32 {\n  return 3\n}\n',
  )
  yield* fs.writeFileString(
    join(directory, 'ownruntime/src/support/start.silk'),
    'import Intrinsic.application\n\nfn none<T>() -> i32 { return 0 }\n\nexport "C" fn enter() -> i32 as "main" {\n  let x = none()\n  return application.main() + x\n}\n',
  )
  for (const command of ['check', 'build']) {
    const refused = yield* invoke(
      silk,
      [command, '--stdlib', standardLibrary],
      join(directory, 'ownruntime'),
    )
    assert.equal(refused.status, 1, refused.stderr)
    assert.match(refused.stderr, /SEM0052/)
    assert.doesNotMatch(refused.stderr, /SEM0225/)
  }
  // A library's static `compileError`, selected by a call from a `main` that requires a provider,
  // is reported by check as by build, at the user's call with the library's site as a note.
  yield* fs.makeDirectory(join(directory, 'staticspec/app/src'), { recursive: true })
  yield* fs.makeDirectory(join(directory, 'staticspec/spec'), { recursive: true })
  yield* fs.writeFileString(join(directory, 'staticspec/silk.toml'), '[workspace]\nmembers = ["app", "spec"]\n')
  yield* fs.writeFileString(
    join(directory, 'staticspec/spec/silk.toml'),
    '[package]\nname = "spec"\nversion = "0.1.0"\nsource = "."\nexports = ["sized"]\nsilk-version = "0.0.0"\n',
  )
  yield* fs.writeFileString(
    join(directory, 'staticspec/spec/sized.silk'),
    'pub fn sized(static n: i64) -> i64 {\n  static if n > 3 { compileError("size too big") }\n  return n\n}\n',
  )
  yield* fs.writeFileString(
    join(directory, 'staticspec/app/silk.toml'),
    '[package]\nname = "app"\nversion = "0.1.0"\nsilk-version = "0.0.0"\n\n[dependencies]\nspec = { path = "../spec" }\n',
  )
  yield* fs.writeFileString(
    join(directory, 'staticspec/app/src/main.silk'),
    'import silk.system.host_input { HostInput }\nimport spec.sized { sized }\n\npub effect fn main() -> i32\n  ? &mut HostInput {\n  if sized(5) != 5 { return 1 }\n  return 0\n}\n',
  )
  for (const command of ['check', 'build']) {
    const refused = yield* invoke(
      silk,
      [command, '--stdlib', standardLibrary],
      join(directory, 'staticspec/app'),
    )
    assert.equal(refused.status, 1, refused.stderr)
    assert.match(
      refused.stderr,
      /^app\/src\/main\.silk:6:6: error\[SEM0177\] size too big\n {2}note: spec\/sized\.silk:2:21: related location$/m,
    )
  }
  // Another package's module is named as the importer spells it, and its private field gets no
  // advice to edit that package.
  yield* fs.makeDirectory(join(directory, 'privatedep/app/src'), { recursive: true })
  yield* fs.makeDirectory(join(directory, 'privatedep/core'), { recursive: true })
  yield* fs.writeFileString(join(directory, 'privatedep/silk.toml'), '[workspace]\nmembers = ["app", "core"]\n')
  yield* fs.writeFileString(
    join(directory, 'privatedep/core/silk.toml'),
    '[package]\nname = "core"\nversion = "0.1.0"\nsource = "."\nexports = ["Store"]\nsilk-version = "0.0.0"\n',
  )
  yield* fs.writeFileString(
    join(directory, 'privatedep/core/Store.silk'),
    'pub struct Box { value: i32, }\n\npub fn make() -> Box { return Box { value: 1 } }\n\nfn hidden() -> i32 { return 1 }\n\npub fn shown() -> i32 { return hidden() }\n',
  )
  yield* fs.writeFileString(
    join(directory, 'privatedep/app/silk.toml'),
    '[package]\nname = "app"\nversion = "0.1.0"\nsilk-version = "0.0.0"\n\n[dependencies]\ntaskcore = { path = "../core", package = "core" }\n',
  )
  yield* fs.writeFileString(
    join(directory, 'privatedep/app/src/main.silk'),
    'import taskcore.Store\nimport taskcore.Store { hidden }\n\npub fn main() -> i32 {\n  return Store.make().value\n}\n',
  )
  const privateDependency = yield* invoke(silk, ['check', '--stdlib', standardLibrary], join(directory, 'privatedep/app'))
  assert.equal(privateDependency.status, 1, privateDependency.stderr)
  assert.match(privateDependency.stderr, /error\[SEM0015\] `hidden` is private to taskcore\.Store; mark it `pub` there to use it here/)
  assert.match(privateDependency.stderr, /error\[SEM0028\] Field `value` of [A-Za-z.]*Box is private to the module that declares it\n/)
  // FFI-010: a loaded dependency module's C exports are roots. No Silk code names the function or
  // the static; the application's C unit links against both by symbol.
  yield* fs.makeDirectory(join(directory, 'depexport/core'), { recursive: true })
  yield* fs.makeDirectory(join(directory, 'depexport/app/native'), { recursive: true })
  yield* fs.writeFileString(
    join(directory, 'depexport/core/silk.toml'),
    '[package]\nname = "core"\nversion = "0.1.0"\nkind = "library"\nsource = "."\nexports = ["probes"]\nsilk-version = "0.0.0"\n',
  )
  yield* fs.writeFileString(
    join(directory, 'depexport/core/probes.silk'),
    'pub export "C" fn silk_test_dependency_probe(value: i32) -> i32 { return value + 1 }\n\nexport "C" static silk_test_dependency_version: i32 = 40\n\npub fn touch() -> i32 {\n  return 0\n}\n',
  )
  yield* fs.writeFileString(
    join(directory, 'depexport/app/silk.toml'),
    '[package]\nname = "app"\nversion = "0.1.0"\nsource = "."\nsilk-version = "0.0.0"\n\n[dependencies]\ncore = { path = "../core" }\n',
  )
  yield* fs.writeFileString(
    join(directory, 'depexport/app/native/caller.c'),
    '#include <stdint.h>\nextern const int32_t silk_test_dependency_version;\nint32_t silk_test_dependency_probe(int32_t);\nint32_t silk_test_call_dependency(void) { return silk_test_dependency_probe(1) + silk_test_dependency_version; }\n',
  )
  yield* fs.writeFileString(
    join(directory, 'depexport/app/main.silk'),
    'import core.probes\n\nunsafe extern "C" fn silk_test_call_dependency() -> i32\n\npub fn main() -> i32 {\n  return probes.touch() + unsafe silk_test_call_dependency()\n}\n',
  )
  const dependencyExportApp = join(directory, 'depexport/app')
  yield* writePlan(dependencyExportApp, '  plan = Plan.compileC(plan, sourcePath("native/caller.c"))')
  const dependencyExportBuilt = yield* invoke(silk, ['build', '--stdlib', standardLibrary], dependencyExportApp, { ...process.env, SILK_CLANG: clang })
  assert.equal(dependencyExportBuilt.status, 0, dependencyExportBuilt.stderr)
  const dependencyExportRan = yield* invoke(join(dependencyExportApp, `build/${hostTarget}/dev/app`), [], dependencyExportApp)
  assert.equal(dependencyExportRan.status, 42, dependencyExportRan.stderr)
  // A library's types are named with their package, an impl outside the modules IMPL-004 allows
  // names the rule, and a refusal of the library's own generic body is reported once, at its site.
  yield* fs.makeDirectory(join(directory, 'libmsg/geo/src'), { recursive: true })
  yield* fs.makeDirectory(join(directory, 'libmsg/app/src'), { recursive: true })
  yield* fs.writeFileString(join(directory, 'libmsg/silk.toml'), '[workspace]\nmembers = ["geo", "app"]\n')
  yield* fs.writeFileString(
    join(directory, 'libmsg/geo/silk.toml'),
    '[package]\nname = "geo"\nversion = "0.1.0"\nkind = "library"\nexports = ["lib"]\nsilk-version = "0.0.0"\n',
  )
  yield* fs.writeFileString(
    join(directory, 'libmsg/geo/src/lib.silk'),
    'pub interface Shape {\n  fn area(shape: &Self) -> i64\n}\n\npub struct Square {\n  side: i64,\n}\n\npub struct Best<T> {\n  value: T,\n  score: i64,\n}\n\npub fn keep<T>(value: T) -> Best<T> {\n  let best = Best<T> { value: move value, score: 1 }\n  return best\n}\n',
  )
  yield* fs.writeFileString(
    join(directory, 'libmsg/app/silk.toml'),
    '[package]\nname = "app"\nversion = "0.1.0"\nsilk-version = "0.0.0"\n\n[dependencies]\ngeo = { path = "../geo" }\n',
  )
  yield* fs.writeFileString(
    join(directory, 'libmsg/app/src/main.silk'),
    'import geo.lib { Shape, Square, keep }\n\nimpl Shape for i64 {\n  fn area(shape: &Self) -> i64 {\n    return 0\n  }\n}\n\nstruct Circle { radius: i64, }\nstruct Tri { base: i64, }\n\npub fn main() -> i32 {\n  let kept = keep(5)\n  let square = Square { side: 2 }\n  let shapes = [Circle { radius: 1 }, Tri { base: 2 }]\n  return 0\n}\n',
  )
  const libraryCheck = yield* invoke(silk, ['check', '--stdlib', standardLibrary], join(directory, 'libmsg/app'))
  assert.equal(libraryCheck.status, 1, libraryCheck.stderr)
  assert.match(
    libraryCheck.stderr,
    /error\[SEM0083\] Invalid conformance: `geo\.lib\.Shape` is declared in `geo\.lib` and `i64` is a builtin type, so this impl must be in `geo\.lib`\n/,
  )
  assert.match(libraryCheck.stderr, /error\[SEM0021\] Cannot construct geo\.lib\.Square here/)
  assert.match(libraryCheck.stderr, /error\[SEM0030\] This element is main\.Tri, but the array holds main\.Circle\n/)
  assert.equal(libraryCheck.stderr.match(/error\[OWN0003\]/g)?.length, 1, libraryCheck.stderr)
  assert.match(libraryCheck.stderr, /geo\/src\/lib\.silk:16:10: error\[OWN0003\] Moving best requires an explicit move/)
  // An unhandled failure of another package is reported with that package's name.
  yield* fs.writeFileString(
    join(directory, 'libmsg/geo/src/lib.silk'),
    'import silk.text.format { Debug, Format, Formatter }\nimport silk.io.writer { Writer, WriterError }\n\npub struct BadSide {}\n\nimpl Debug for BadSide {\n  effect fn debug(self: &Self, formatter: &mut Formatter) -> () ! WriterError ? &mut Writer {\n    return run Format.debugFields(self, "BadSide", &mut formatter)\n  }\n}\n\npub effect fn side(length: i64) -> i64 ! BadSide {\n  if length < 0 { fail BadSide {} }\n  return length\n}\n',
  )
  yield* fs.writeFileString(
    join(directory, 'libmsg/app/src/main.silk'),
    'import geo.lib { BadSide, side }\n\npub effect fn main() -> i32 ! BadSide {\n  let _length = run side(-1)\n  return 0\n}\n',
  )
  const escaped = yield* invoke(
    silk,
    ['run', '--stdlib', standardLibrary],
    join(directory, 'libmsg/app'),
    { ...process.env, SILK_CLANG: clang },
  )
  assert.equal(escaped.status, 1, escaped.stderr)
  assert.match(escaped.stderr, /^unhandled error: geo\.lib\.BadSide\n {2}at geo\.lib\.side \(/m)
  // A member without its root module but with a `lib.silk` is pointed at the library kind.
  yield* fs.writeFileString(join(directory, 'libmsg/geo/silk.toml'), '[package]\nname = "geo"\nversion = "0.1.0"\nsilk-version = "0.0.0"\n')
  const kindless = yield* invoke(silk, ['check', '--stdlib', standardLibrary], join(directory, 'libmsg'))
  assert.match(
    kindless.stderr,
    /^Skipping geo: its root module \(\[package\]\.main\) is missing\n {2}help: its source root has lib\.silk; a library sets `kind = "library"` and `exports = \["lib"\]` under \[package\]$/m,
  )
  // A member's first check adopts its dependency's semantic cache, and what changed in the
  // dependency since that cache was written is checked again: the stale result is not reused.
  yield* fs.makeDirectory(join(directory, 'adopt/core/src'), { recursive: true })
  yield* fs.makeDirectory(join(directory, 'adopt/app/src'), { recursive: true })
  yield* fs.writeFileString(join(directory, 'adopt/silk.toml'), '[workspace]\nmembers = ["core", "app"]\n')
  yield* fs.writeFileString(
    join(directory, 'adopt/core/silk.toml'),
    '[package]\nname = "adoptcore"\nversion = "0.1.0"\nkind = "library"\nexports = ["lib"]\nsilk-version = "0.0.0"\n',
  )
  yield* fs.writeFileString(join(directory, 'adopt/core/src/lib.silk'), 'pub fn size() -> i64 {\n  return 2\n}\n')
  yield* fs.writeFileString(
    join(directory, 'adopt/app/silk.toml'),
    '[package]\nname = "adoptapp"\nversion = "0.1.0"\nsilk-version = "0.0.0"\n\n[dependencies]\nadoptcore = { path = "../core" }\n',
  )
  yield* fs.writeFileString(
    join(directory, 'adopt/app/src/main.silk'),
    'import adoptcore.lib { size }\n\npub fn main() -> i32 {\n  let n: i64 = size()\n  return 0\n}\n',
  )
  const coreChecked = yield* invoke(silk, ['check', '--stdlib', standardLibrary], join(directory, 'adopt/core'))
  assert.equal(coreChecked.status, 0, coreChecked.stderr)
  assert.ok(yield* fs.exists(join(directory, 'adopt/build/cache/adoptcore')), 'the library check leaves its cache in the workspace output')
  yield* fs.writeFileString(join(directory, 'adopt/core/src/lib.silk'), 'pub fn size() -> bool {\n  return true\n}\n')
  const adoptedCheck = yield* invoke(silk, ['check', '--stdlib', standardLibrary], join(directory, 'adopt/app'))
  assert.equal(adoptedCheck.status, 1, adoptedCheck.stderr)
  assert.match(adoptedCheck.stderr, /app\/src\/main\.silk:4:\d+: error\[/)
  // A `mut fn` binding is lent to each call it is passed to, so it stays usable afterwards, and one
  // call cannot be lent it twice. Callable diagnostics name the binding and the fix.
  // Match and pattern mistakes are one diagnostic each, naming the fix or the types involved.
  const patternCases: Array<[string, string, RegExp]> = [
    ["armreturn", "enum Kind { Fruit, Tool, }\n\nstruct Refused { reason: i32, }\n\nunion Event {\n  Retag {index: usize, kind: Kind},\n  Restock {index: usize, amount: i32},\n  Close,\n}\n\nfn handle(event: Event) -> i32 {\n  return match move event {\n    Event.Retag { index, kind: Kind.Fruit } => 1\n    Event.Retag { index, kind } => 2\n    Event.Restock { index, amount } => amount\n    Event.Close => 0\n  }\n}\n\nfn price(kind: Kind) -> i32 {\n  return match kind {\n    Kind.Fruit => 1\n    Kind.Tool => 2\n  }\n}\n\nfn score(outcome: i32 | Refused | bool) -> i32 {\n  return match move outcome {\n    i32 stock => stock\n    Refused { reason } => reason\n    bool closed => 3\n  }\n}\n\nfn count(n: i32) -> i32 {\n  return match n {\n    0 => return 1\n    i32 other => other\n  }\n}\n\npub fn main() -> i32 {\n  return handle(Event.Close) + price(Kind.Fruit) + score(true) + count(0) - 5\n}\n", /error\[PAR0010\] `return` is a statement, so it cannot be a match arm's value; write the arm as a block, as in `=> \{ return 1 \}`\n/],
    ["fieldliteral", "enum Kind { Fruit, Tool, }\n\nstruct Refused { reason: i32, }\n\nunion Event {\n  Retag {index: usize, kind: Kind},\n  Restock {index: usize, amount: i32},\n  Close,\n}\n\nfn handle(event: Event) -> i32 {\n  return match move event {\n    Event.Retag { index, kind: 3 } => 1\n    Event.Retag { index, kind } => 2\n    Event.Restock { index, amount } => amount\n    Event.Close => 0\n  }\n}\n\nfn price(kind: Kind) -> i32 {\n  return match kind {\n    Kind.Fruit => 1\n    Kind.Tool => 2\n  }\n}\n\nfn score(outcome: i32 | Refused | bool) -> i32 {\n  return match move outcome {\n    i32 stock => stock\n    Refused { reason } => reason\n    bool closed => 3\n  }\n}\n\nfn count(n: i32) -> i32 {\n  return match n {\n    0 => {\n      return 1\n    }\n    i32 other => other\n  }\n}\n\npub fn main() -> i32 {\n  return handle(Event.Close) + price(Kind.Fruit) + score(true) + count(0) - 5\n}\n", /error\[PAR0010\] A field pattern cannot match a literal; bind the field and compare it in a guard/],
    ["armcomma", "enum Kind { Fruit, Tool, }\n\nstruct Refused { reason: i32, }\n\nunion Event {\n  Retag {index: usize, kind: Kind},\n  Restock {index: usize, amount: i32},\n  Close,\n}\n\nfn handle(event: Event) -> i32 {\n  return match move event {\n    Event.Retag { index, kind: Kind.Fruit } => 1\n    Event.Retag { index, kind } => 2\n    Event.Restock { index, amount } => amount\n    Event.Close => 0\n  }\n}\n\nfn price(kind: Kind) -> i32 {\n  return match kind {\n    Kind.Fruit => 1,\n    Kind.Tool => 2\n  }\n}\n\nfn score(outcome: i32 | Refused | bool) -> i32 {\n  return match move outcome {\n    i32 stock => stock\n    Refused { reason } => reason\n    bool closed => 3\n  }\n}\n\nfn count(n: i32) -> i32 {\n  return match n {\n    0 => {\n      return 1\n    }\n    i32 other => other\n  }\n}\n\npub fn main() -> i32 {\n  return handle(Event.Close) + price(Kind.Fruit) + score(true) + count(0) - 5\n}\n", /error\[PAR0010\] Match arms are not separated by commas; remove the `,`\n/],
    ["barepattern", "enum Kind { Fruit, Tool, }\n\nstruct Refused { reason: i32, }\n\nunion Event {\n  Retag {index: usize, kind: Kind},\n  Restock {index: usize, amount: i32},\n  Close,\n}\n\nfn handle(event: Event) -> i32 {\n  return match move event {\n    Event.Retag { index, kind: Kind.Fruit } => 1\n    Event.Retag { index, kind } => 2\n    Event.Restock { index, amount } => amount\n    Event.Close => 0\n  }\n}\n\nfn price(kind: Kind) -> i32 {\n  return match kind {\n    Kind.Fruit => 1\n    Kind.Tool => 2\n  }\n}\n\nfn score(outcome: i32 | Refused | bool) -> i32 {\n  return match move outcome {\n    i32 stock => stock\n    Refused { reason } => reason\n    bool closed => 3\n  }\n}\n\nfn count(n: i32) -> i32 {\n  return match n {\n    0 => {\n      return 1\n    }\n    other => other\n  }\n}\n\npub fn main() -> i32 {\n  return handle(Event.Close) + price(Kind.Fruit) + score(true) + count(0) - 5\n}\n", /error\[PAR0010\] A pattern that takes the whole value names its type, as in `i32 value`, or is `_`\n/],
    ["missingfield", "enum Kind { Fruit, Tool, }\n\nstruct Refused { reason: i32, }\n\nunion Event {\n  Retag {index: usize, kind: Kind},\n  Restock {index: usize, amount: i32},\n  Close,\n}\n\nfn handle(event: Event) -> i32 {\n  return match move event {\n    Event.Retag { index, kind: Kind.Fruit } => 1\n    Event.Retag { index, kind } => 2\n    Event.Restock { index } => 4\n    Event.Close => 0\n  }\n}\n\nfn price(kind: Kind) -> i32 {\n  return match kind {\n    Kind.Fruit => 1\n    Kind.Tool => 2\n  }\n}\n\nfn score(outcome: i32 | Refused | bool) -> i32 {\n  return match move outcome {\n    i32 stock => stock\n    Refused { reason } => reason\n    bool closed => 3\n  }\n}\n\nfn count(n: i32) -> i32 {\n  return match n {\n    0 => {\n      return 1\n    }\n    i32 other => other\n  }\n}\n\npub fn main() -> i32 {\n  return handle(Event.Close) + price(Kind.Fruit) + score(true) + count(0) - 5\n}\n", /error\[SEM0046\] This pattern leaves out field `amount`; name it, or end the fields with `\.\.` to skip the rest\n/],
    ["notmember", "enum Kind { Fruit, Tool, }\n\nstruct Refused { reason: i32, }\n\nunion Event {\n  Retag {index: usize, kind: Kind},\n  Restock {index: usize, amount: i32},\n  Close,\n}\n\nfn handle(event: Event) -> i32 {\n  return match move event {\n    Event.Retag { index, kind: Kind.Fruit } => 1\n    Event.Retag { index, kind } => 2\n    Event.Restock { index, amount } => amount\n    Event.Close => 0\n  }\n}\n\nfn price(kind: Kind) -> i32 {\n  return match kind {\n    Kind.Fruit => 1\n    Kind.Tool => 2\n  }\n}\n\nfn score(outcome: i32 | Refused | bool) -> i32 {\n  return match move outcome {\n    i64 stock => 5\n    Refused { reason } => reason\n    bool closed => 3\n  }\n}\n\nfn count(n: i32) -> i32 {\n  return match n {\n    0 => {\n      return 1\n    }\n    i32 other => other\n  }\n}\n\npub fn main() -> i32 {\n  return handle(Event.Close) + price(Kind.Fruit) + score(true) + count(0) - 5\n}\n", /error\[SEM0042\] i64 is not a member of the matched union, whose members are i32, main\.Refused, bool\n/],
    ["narrowing", "enum Kind { Fruit, Tool, }\n\nstruct Refused { reason: i32, }\n\nunion Event {\n  Retag {index: usize, kind: Kind},\n  Restock {index: usize, amount: i32},\n  Close,\n}\n\nfn handle(event: Event) -> i32 {\n  return match move event {\n    Event.Retag { index, kind: Kind.Fruit } => 1\n    Event.Retag { index, kind } => 2\n    Event.Restock { index, amount } => amount\n    Event.Close => 0\n  }\n}\n\nfn price(kind: Kind) -> i32 {\n  return match kind {\n    Kind.Fruit => 1\n    Kind.Tool => 2\n  }\n}\n\nfn narrow(o: i32 | Refused | bool) -> i32 | bool {\n  return o\n}\n\nfn score(outcome: i32 | Refused | bool) -> i32 {\n  return match move outcome {\n    i32 stock => stock\n    Refused { reason } => reason\n    bool closed => 3\n  }\n}\n\nfn count(n: i32) -> i32 {\n  return match n {\n    0 => {\n      return 1\n    }\n    i32 other => other\n  }\n}\n\npub fn main() -> i32 {\n  return handle(Event.Close) + price(Kind.Fruit) + score(true) + count(0) - 5\n}\n", /error\[SEM0040\] The value can be main\.Refused, which the target type does not hold; match on it to handle that case first\n/],
    ["unitbraces", "enum Kind { Fruit, Tool, }\n\nstruct Refused { reason: i32, }\n\nunion Event {\n  Retag {index: usize, kind: Kind},\n  Restock {index: usize, amount: i32},\n  Close,\n}\n\nfn handle(event: Event) -> i32 {\n  return match move event {\n    Event.Retag { index, kind: Kind.Fruit } => 1\n    Event.Retag { index, kind } => 2\n    Event.Restock { index, amount } => amount\n    Event.Close {} => 0\n  }\n}\n\nfn price(kind: Kind) -> i32 {\n  return match kind {\n    Kind.Fruit => 1\n    Kind.Tool => 2\n  }\n}\n\nfn score(outcome: i32 | Refused | bool) -> i32 {\n  return match move outcome {\n    i32 stock => stock\n    Refused { reason } => reason\n    bool closed => 3\n  }\n}\n\nfn count(n: i32) -> i32 {\n  return match n {\n    0 => {\n      return 1\n    }\n    i32 other => other\n  }\n}\n\npub fn main() -> i32 {\n  return handle(Event.Close) + price(Kind.Fruit) + score(true) + count(0) - 5\n}\n", /error\[SEM0224\] Event\.Close has no fields, so its pattern takes no braces; write `Event\.Close`\n/],
    ["unrun", "effect fn tick() -> i32 {\n  return 1\n}\n\npub fn main() -> i32 {\n  tick()\n  return 0\n}\n", /error\[SEM0087\] Expression statement produces an Effect of `i32` that is never run \(write `run` before it to run it, or `drop` it to discard it\), but only \(\) or never may be ignored\n/],
  ]
  const lendCases: Array<[string, string, RegExp]> = [
    ["lendtwice", "fn both(mut f: mut fn(i32) -> i32, mut g: mut fn(i32) -> i32) -> i32 {\n  return f(1) + g(2)\n}\n\npub fn main() -> i32 {\n  let mut total = 0\n  let mut acc = |x: i32| -> i32 {\n    total = total + x\n    return total\n  }\n  return both(acc, acc)\n}\n", /src\/main\.silk:11:20: error\[OWN0010\] A mutable borrow of `acc` conflicts with an earlier mutable borrow of it that is still in use/],
    ["closureescape", "struct Base { value: i32, }\n\nimpl Base {\n  fn peek(self: &Self) -> i32 { return self.value }\n}\n\nfn make() -> fn<'static>(i32) -> i32 {\n  let base = Base { value: 2 }\n  return |x: i32| -> i32 { return x + base.peek() }\n}\n\npub fn main() -> i32 {\n  return make()(1)\n}\n", /error\[OWN0018\] The returned callable borrows `base`, a local of this function; move it into the callable instead, which makes the result a `once fn<'static>`\n/],
    ["callableresult", "fn adder(n: i32) -> fn(i32) -> i32 {\n  return |x: i32| -> i32 { return x + n }\n}\n\npub fn main() -> i32 {\n  return adder(1)(2)\n}\n", /error\[SEM0210\] The result is a callable whose captures could borrow, but the function has no borrowed input they could come from; for a callable that captures only owned data, write `fn<'static>\(\.\.\.\)`, as in `fn<'static>\(i32\) -> i32`\n/],
    ["boundmove", "struct Counter { count: i32, }\n\nimpl Counter {\n  fn peek(self: &Self) -> i32 { return self.count }\n  fn finish(self: Self) -> i32 { return self.count }\n}\n\npub fn main() -> i32 {\n  let counter = Counter { count: 1 }\n  let finish = counter.finish\n  return counter.peek()\n}\n", /error\[OWN0001\] counter was moved and cannot be used again\n/],
    ["callableassign", "struct Counter { count: i32, }\n\nimpl Counter {\n  fn peek(self: &Self) -> i32 { return self.count }\n  fn total(self: &Self) -> i32 { return self.count }\n}\n\npub fn main() -> i32 {\n  let counter = Counter { count: 1 }\n  let mut get = counter.total\n  get = counter.peek\n  return get()\n}\n", /error\[SEM0037\] Every function and closure has its own type, so a binding that holds one cannot be assigned a different one\n/],
    ["plainmismatch", "pub fn main() -> i32 {\n  let count: i32 = \"three\"\n  return count\n}\n", /error\[SEM0037\] Assignment expected i32 but received string<'static>\n/],
    ["ignored", "fn bump(n: i32) -> i32 { return n + 1 }\n\npub fn main() -> i32 {\n  bump(2)\n  return 0\n}\n", /error\[SEM0087\] Expression statement produces i32, but only \(\) or never may be ignored; write `drop` before it to discard the value\n/],
  ]
  const staticCases: Array<[string, string, RegExp]> = [
    ["staticoverflow", "static fn grow(n: u8) -> u8 { return n + 100 }\nconst BIG: u8 = grow(200)\npub fn main() -> i32 { return 0 }\n", /error\[SEM0176\] Static evaluation of `n \+ 100` overflows its integer type\n/],
    ["staticzero", "static fn fib(n: u64) -> u64 { if n < 2 { return n } return fib(n - 1) + fib(n - 2) }\nconst Q: u64 = fib(20) / (fib(0))\npub fn main() -> i32 { return 0 }\n", /error\[SEM0176\] Static evaluation of `fib\(20\) \/ \(fib\(0\)\)` divides by zero\n/],
    ["staticbyte", "import silk.core.static_text { StaticText }\nstatic fn at(text: string<'static>) -> u8 { return StaticText.byteAt(text, 50) }\nconst L: u8 = at(\"loud!!\")\npub fn main() -> i32 { return 0 }\n", /error\[SEM0176\] Static evaluation stops: index 50 is past the end of the 6-byte text\n/],
    ["staticplain", "unsafe fn plain() -> i32 { return 3 }\nstatic fn s() -> i32 { return unsafe plain() }\nconst P: i32 = s()\npub fn main() -> i32 { return 0 }\n", /error\[SEM0176\] `plain` is an ordinary fn, so static evaluation cannot call it; mark it `static fn` to call it here\n/],
    ["phasebinding", "import silk.core.reflect { Reflect }\npub struct Stats { pub hits: i32, }\npub fn main() -> i32 { let f = Reflect.fields<Stats>() return 0 }\n", /error\[SEM0176\] Phase-only values exist only during static evaluation, so a runtime binding of a phase-only value is not allowed\n/],
    ["constcycle", "const A: i32 = B\nconst B: i32 = A\npub fn main() -> i32 { return A }\n", /error\[SEM0223\] `A` and `B` depend on each other in a cycle, so none of them can be resolved\n/],
  ]
  const interopCases: Array<[string, string, RegExp]> = [
    ["safeexport", "export \"C\" fn twice(v: i32) -> i32 {\n  return v * 2\n}\n\npub fn main() -> i32 {\n  return twice(0)\n}\n", /error\[SEM0082\] `twice\(\.\.\.\)` is unsafe; write `unsafe twice\(\.\.\.\)`, or put it in an `unsafe \{ \}` block\n/],
    ["staticread", "export \"C\" static calls: i32 = 4\n\npub fn main() -> i32 {\n  return calls\n}\n", /error\[SEM0082\] Reading `calls` is unsafe; put it in an `unsafe \{ \}` block\n/],
    ["nocallbacks", "unsafe extern \"C\" fn qsort(base: [*]mut u8, count: usize, size: usize, compare: extern \"C\" fn([*]const u8, [*]const u8) -> i32) -> ()\n\nexport \"C\" fn cmp(a: [*]const u8, b: [*]const u8) -> i32 { return 0 }\n\npub fn main() -> i32 {\n  return 0\n}\n", /error\[SEM0187\] A C function-pointer parameter must be named in the declaration's directives; add `@callbacks\("compare"\)` before the declaration\n/],
    ["plaincallback", "import silk.mem.pointer { Pointer }\n@callbacks(\"compare\")\nunsafe extern \"C\" fn qsort(base: ?[*]mut u8, count: usize, size: usize, compare: extern \"C\" fn([*]const u8, [*]const u8) -> i32) -> ()\n\nfn cmp(a: [*]const u8, b: [*]const u8) -> i32 { return 0 }\n\npub fn main() -> i32 {\n  let mut items: [u8; 4] = [3, 1, 2, 0]\n  unsafe qsort(Pointer.fromMutSlice(&mut items), 4, 1, cmp)\n  return 0\n}\n", /error\[SEM0012\] This parameter takes a C function pointer, and a Silk fn has no C address; pass an `export "C" fn` here\n/],
    ["boolstatic", "export \"C\" static calls: bool = false\n\npub fn main() -> i32 {\n  return 0\n}\n", /error\[SEM0187\] A C static holds one C integer, float, or pointer, so it cannot have type bool\n/],
    ["assignstatic", "export \"C\" static calls: i32 = 0\n\npub fn main() -> i32 {\n  unsafe { calls = 1 }\n  return 0\n}\n", /error\[SEM0036\] `calls` is a C static, which Silk code can read but not assign\n/],
  ]
  // Template errors say what the placeholder needs, at the call, with no note into the standard library.
  const templateUse = (call: string) => `import silk.io.writer_native { StderrWriter }\n\npub fn main() -> i32 {\n  ${call}\n  return 0\n}\n`
  const templateCases: Array<[string, string, RegExp]> = [
    ["lonebrace", templateUse('StderrWriter.print("} {name}\\n", &.{ name: "Ada" })'), /error\[SEM0177\] a lone `\}` in a template must be written `\}\}`, which writes one `\}`\n/],
    ["widthtext", templateUse('StderrWriter.print("{name:>w$}\\n", &.{ name: "Ada", w: "x" })'), /error\[SEM0121\] A width or precision read from a field, as in `\{name:w\$\}`, needs an integer, and this field is `string<'static>`\n/],
    ["radixtext", templateUse('StderrWriter.print("{:x}\\n", &.("Ada"))'), /error\[SEM0121\] A `\{:x\}`, `\{:X\}`, `\{:o\}`, or `\{:b\}` placeholder needs an integer, and this value is `string<'static>`\n/],
    ["exponentint", templateUse('StderrWriter.print("{:e}\\n", &.(5))'), /error\[SEM0121\] A `\{:e\}` or `\{:E\}` placeholder needs a float, and this value is `i32`\n/],
    ["unborrowed", templateUse('StderrWriter.print("{}\\n", 5)'), /error\[SEM0012\] This parameter takes a borrow, and this argument is i32; write `&` before it\n/],
    ["surrogate", "pub fn main() -> i32 {\n  let s = \"\\u{D800}\"\n  return 0\n}\n", /error\[SEM0085\] Invalid static literal: `\\u\{D800\}` is a UTF-16 surrogate, which is not a Unicode scalar value\n/],
    ["abovescalar", "pub fn main() -> i32 {\n  let c = '\\u{110000}'\n  return 0\n}\n", /error\[SEM0085\] Invalid static literal: `\\u\{110000\}` is above `\\u\{10FFFF\}`, the largest Unicode scalar value\n/],
    ["notbyte", "pub fn main() -> i32 {\n  let b = b\"\\u{100}\"\n  return 0\n}\n", /error\[SEM0085\] Invalid static literal: `\\u\{100\}` is not a byte; a byte string holds values up to `\\u\{FF\}`, also written `\\xFF`\n/],
    ["badescape", "pub fn main() -> i32 {\n  let s = \"a\\qb\"\n  return 0\n}\n", /error\[SEM0085\] Invalid static literal: `\\q` is not an escape; /],
    ["textlength", "pub fn main() -> i32 {\n  let t = \"abc\"\n  let n = t.length\n  return 0\n}\n", /error\[SEM0026\] A string has no fields; call the `silk\.text\.string` functions on it, as in `String\.byteLength\(text\)` for its length in bytes\n/],
    ["textindex", "pub fn main() -> i32 {\n  let t = \"abc\"\n  let n = t[0]\n  return 0\n}\n", /error\[SEM0032\] A string cannot be indexed, because a character can take more than one byte; read a byte with `String\.utf8Bytes\(text\)\[i\]`, or step through characters with `String\.nextScalar`\n/],
    ["textmethod", "pub fn main() -> i32 {\n  let t = \"abc\"\n  let n = t.startsWith(\"a\")\n  return 0\n}\n", /error\[SEM0010\] A string has no methods; call `String\.startsWith\(text, \.\.\.\)` instead, with `import silk\.text\.string \{ String \}`\n/],
    ["textplus", "pub fn main() -> i32 {\n  let t = \"abc\"\n  let n = t + \"!\"\n  return 0\n}\n", /error\[SEM0135\] Operator \+ does not join strings; build an owned `String` with `String\.copy` and `String\.append`, or write the text with a `Format\.format` template\n/],
    ["reflectimport", "struct P { x: i32 }\n\npub fn main() -> i32 {\n  let mut n = 0\n  static for f in Reflect.fields<P>() { n = n + 1 }\n  return n\n}\n", /error\[SEM0009\] Unknown name Reflect; is `import silk\.core\.reflect \{ Reflect \}` missing\?\n/],
    ["prefixstar", "fn bump(n: &mut i32) -> () {\n  *n = *n + 1\n}\n\npub fn main() -> i32 {\n  let mut x = 1\n  bump(&mut x)\n  return x\n}\n", /error\[PAR0010\] Silk has no prefix `\*`; a dereference follows the value, as in `n\.\* = n\.\* \+ 1`\n/],
    ["floatkey", "import silk.collections.hash { Hash }\nimport silk.collections.hash_map { HashMap }\n\npub fn main() -> i32 {\n  let counts = HashMap<f64, i32>.make(Hash.seed(1))\n  if HashMap<f64, i32>.contains(&counts, 1.5) { return 1 }\n  return 0\n}\n", /error\[SEM0121\] `f64: silk\.collections\.hash\.HashKey` cannot be proved: no implementation of `silk\.collections\.hash\.HashKey` exists for `f64`\n/],
    ["unordered", "import silk.mem.allocator { Allocator, OutOfMemoryError }\nimport silk.core.effect { Effect }\nimport silk.collections.list { List }\n\nstruct P { x: i32, }\n\npub effect fn main() -> () ! OutOfMemoryError {\n  let mut allocator = Allocator.systemAllocatorProvider()\n  let mut l = List<P>.make()\n  run List<P>.sort(&mut l) |> Effect.provideMut<Allocator>(&mut allocator)\n}\n", /error\[SEM0121\] `main\.P: silk\.core\.order\.Order` cannot be proved: no implementation of `silk\.core\.order\.Order` exists for `main\.P`\n/],
    ["resultimport", "import silk.core.effect { Effect }\n\neffect fn parse() -> i32 ! () { return 1 }\n\npub effect fn main() -> i32 {\n  let parsed = run Effect.result(parse())\n  return match move parsed {\n    Result.Success { value } => value\n    _ => 2\n  }\n}\n", /error\[SEM0009\] Unknown name Result; is `import silk\.core\.result \{ Result \}` missing\?\n/],
    ["enumgone", "enum(u16) Status { Ok = 200, Created = 201, }\nenum Light { Red, Green, }\n\npub fn main() -> i32 {\n  let gone = Status.Gone\n  return 0\n}\n", /error\[SEM0153\] Enum Status has no member Gone\n/],
    ["enumrange", "enum(u8) Big { A = 256, }\n\npub fn main() -> i32 { return 0 }\n", /error\[SEM0150\] Discriminant 256 of Big\.A does not fit in u8 \(0 to 255\)\n/],
    ["enumsuccessor", "enum(u8) Edge { A = 255, B, }\n\npub fn main() -> i32 { return 0 }\n", /error\[SEM0151\] Edge\.B follows A = 255, so its implicit discriminant does not fit in u8 \(0 to 255\); give it an explicit discriminant\n/],
    ["enumrepeat", "enum(u8) Dup { A = 1, B = 1, }\n\npub fn main() -> i32 { return 0 }\n", /error\[SEM0149\] Enum Dup gives B the discriminant 1, which A already has\n/],
    ["enumother", "enum(u16) Status { Ok = 200, Created = 201, }\nenum Light { Red, Green, }\n\nfn wants(s: Status) -> i32 { return 0 }\n\npub fn main() -> i32 { return wants(Light.Red) }\n", /error\[SEM0154\] Expected main\.Status but received a member of main\.Light; enums do not convert into each other\n/],
    ["enumequalsint", "enum(u16) Status { Ok = 200, Created = 201, }\nenum Light { Red, Green, }\n\npub fn main() -> i32 {\n  if Status.Ok == 200 { return 1 }\n  return 0\n}\n", /error\[SEM0155\] Status is not an integer, so == only compares it with another Status; compare `Status\.value\(\.\.\.\)` with an integer instead\n/],
    ["enumtoint", "enum(u16) Status { Ok = 200, Created = 201, }\nenum Light { Red, Green, }\n\npub fn main() -> i32 {\n  let n: u16 = Status.Ok\n  return 0\n}\n", /error\[SEM0155\] Expected u16 but received Status; an enum is not an integer, so read its backing value with `Status\.value\(\.\.\.\)`\n/],
    ["enumorder", "enum(u16) Status { Ok = 200, Created = 201, }\nenum Light { Red, Green, }\n\npub fn main() -> i32 {\n  if Status.Ok < Status.Created { return 1 }\n  return 0\n}\n", /error\[SEM0157\] Enum Status has no order, so < does not apply; compare backing values with `Status\.value\(\.\.\.\)` instead\n/],
    ["enumvaluemethod", "enum(u16) Status { Ok = 200, Created = 201, }\nenum Light { Red, Green, }\n\npub fn main() -> i32 {\n  let n = Status.Ok.value()\n  return 0\n}\n", /error\[SEM0010\] Enum members have no `value` method; read the backing value with `Status\.value\(member\)`\n/],
    ["enumintpattern", "enum(u16) Status { Ok = 200, Created = 201, }\nenum Light { Red, Green, }\n\nfn code(s: Status) -> i32 {\n  return match s {\n    200 => 1\n    _ => 0\n  }\n}\n\npub fn main() -> i32 { return code(Status.Ok) }\n", /error\[SEM0162\] Integer pattern 200 cannot match enum Status; match its members, or match on `Status\.value\(\.\.\.\)` instead\n/],
    ["bareblock", "import silk.core.ownership { Drop }\n\nstruct Tracer { id: i32, log: i32, }\n\nimpl Drop for Tracer {\n  fn drop(self: &mut Tracer) -> () {\n    return ()\n  }\n}\n\nfn tracer(id: i32) -> Tracer { return Tracer { id: id, log: 0 } }\n\nfn consume(t: Tracer) -> () { return () }\n\npub fn main() -> i32 {\n  {\n    let c = tracer(3)\n  }\n  return 0\n}\n", /error\[PAR0010\] Silk has no bare blocks; move these statements into a helper function, whose locals end when it returns\n/],
    ["replaceborrow", "import silk.core.ownership { Drop }\n\nstruct Tracer { id: i32, log: i32, }\n\nimpl Drop for Tracer {\n  fn drop(self: &mut Tracer) -> () {\n    return ()\n  }\n}\n\nfn tracer(id: i32) -> Tracer { return Tracer { id: id, log: 0 } }\n\nfn consume(t: Tracer) -> () { return () }\n\npub fn main() -> i32 {\n  let mut slot = tracer(1)\n  let old = Intrinsic.replace(&mut slot, tracer(2))\n  return 0\n}\n", /error\[SEM0036\] `Intrinsic\.replace` takes the place to replace, not a borrow of it; drop the `&mut`, as in `Intrinsic\.replace\(slot, value\)`\n/],
    ["droppartial", "import silk.core.ownership { Drop }\n\nstruct Tracer { id: i32, log: i32, }\n\nimpl Drop for Tracer {\n  fn drop(self: &mut Tracer) -> () {\n    return ()\n  }\n}\n\nfn tracer(id: i32) -> Tracer { return Tracer { id: id, log: 0 } }\n\nfn consume(t: Tracer) -> () { return () }\n\npub fn main() -> i32 {\n  let t = tracer(1)\n  let l = move t.log\n  return 0\n}\n", /error\[OWN0002\] main\.Tracer has a Drop hook, so no part of it can be moved out; move or borrow the whole value, or read a Copy part\n/],
    ["loopmove", "import silk.core.ownership { Drop }\n\nstruct Tracer { id: i32, log: i32, }\n\nimpl Drop for Tracer {\n  fn drop(self: &mut Tracer) -> () {\n    return ()\n  }\n}\n\nfn tracer(id: i32) -> Tracer { return Tracer { id: id, log: 0 } }\n\nfn consume(t: Tracer) -> () { return () }\n\npub fn main() -> i32 {\n  let outer = tracer(1)\n  let mut i = 0\n  while i < 2 {\n    consume(move outer)\n    i = i + 1\n  }\n  return 0\n}\n", /error\[OWN0005\] `outer` is moved inside this loop, so the next iteration would use it after the move; create it inside the loop, or leave the loop right after moving it\n/],
    ["droptwice", "import silk.core.ownership { Drop }\n\nstruct Tracer { id: i32, log: i32, }\n\nimpl Drop for Tracer {\n  fn drop(self: &mut Tracer) -> () {\n    return ()\n  }\n}\n\nfn tracer(id: i32) -> Tracer { return Tracer { id: id, log: 0 } }\n\nfn consume(t: Tracer) -> () { return () }\n\npub fn main() -> i32 {\n  let first = tracer(1)\n  drop first\n  drop first\n  return 0\n}\n", /error\[OWN0001\] first was moved and cannot be used again\n/],
    ["dropcopy", "import silk.core.ownership { Copy, Drop }\n\nstruct Tracer { id: i32, log: i32, }\n\nimpl Copy for Tracer {}\n\nimpl Drop for Tracer {\n  fn drop(self: &mut Tracer) -> () {\n    return ()\n  }\n}\n\nfn tracer(id: i32) -> Tracer { return Tracer { id: id, log: 0 } }\n\nfn consume(t: Tracer) -> () { return () }\n\npub fn main() -> i32 { return 0 }\n", /error\[SEM0083\] Invalid conformance: main\.Tracer has a Drop hook, so it cannot be Copy: every copy would run the hook again\n/],
    ["dropmethod", "import silk.core.ownership { Drop }\n\nstruct Tracer { id: i32, log: i32, }\n\nimpl Drop for Tracer {\n  fn drop(self: &mut Tracer) -> () {\n    return ()\n  }\n}\n\nfn tracer(id: i32) -> Tracer { return Tracer { id: id, log: 0 } }\n\nfn consume(t: Tracer) -> () { return () }\n\npub fn main() -> i32 {\n  let mut c = tracer(1)\n  c.drop()\n  return 0\n}\n", /error\[SEM0010\] `drop` is not a method; write `drop c` to end the value early, which runs its Drop hook, if it has one\n/],
    ["slicelen", "import silk.num.usize\n\npub fn main() -> i32 {\n  let bytes: &[u8] = b\"abc\"\n  return usize.toI32(bytes.len)\n}\n", /error\[SEM0027\] &'static \[u8\] has no field `len`; its element count is `\.length`\n/],
    ["tupleordinal", "tuple Range(i32, i32)\n\npub fn main() -> i32 {\n  let r = Range(3, 10)\n  return r.2\n}\n", /error\[SEM0027\] main\.Range has no element `\.2`; it has 2 elements, `\.0` and `\.1`\n/],
    ["tuplearity", "tuple Range(i32, i32)\n\npub fn main() -> i32 {\n  let r = Range(3)\n  return 0\n}\n", /error\[SEM0172\] main\.Range expects 2 tuple elements but received 1\n/],
    ["shiftoperator", "pub fn main() -> i32 {\n  let x = (-8 >> 1)\n  return x\n}\n", /error\[PAR0010\] Silk has no `<<` or `>>`; shift with the functions of the value's type, as in `i32\.shiftLeft\(value, count\)` or `i32\.shiftRight\(value, count\)`\n/],
    ["ascast", "import silk.num.u8\n\npub fn main() -> i32 {\n  let x = (u8.MAX as i32)\n  return x\n}\n", /error\[PAR0002\] Silk has no `as` cast; convert with a function of the source type/],
    ["tuplefields", "tuple Range(i32, i32)\n\npub fn main() -> i32 {\n  let r = Range { 0: 3, 1: 10 }\n  return 0\n}\n", /error\[PAR0010\] A tuple's elements have no field names; build it by position, as in `Pair\(first, second\)`\n/],
    ["ternary", "pub fn main() -> i32 {\n  let c = true\n  let x = c ? 1 : 2\n  return x\n}\n", /error\[PAR0010\] Silk has no `c \? a : b`; write an `if` with a final `else` as the value, as in `if c \{ a \} else \{ b \}`\n/],
    ["matchthroughborrow", "union Status {\n  Open,\n  Done { day: u32 },\n}\n\nfn mark(status: &Status) -> i32 {\n  return match status.* {\n    Status.Open => 0\n    Status.Done { .. } => 1\n  }\n}\n\npub fn main() -> i32 {\n  let s = Status.Open\n  return mark(&s)\n}\n", /error\[OWN0003\] `match status\.\*` would move `status\.\*` out of a borrow, which cannot give it away; write `match &status\.\*` to look at it\n/],
    ["fieldless", templateUse('StderrWriter.print("{}\\n", &5)'), /error\[SEM0177\] a template with placeholders takes its values as fields, such as `&\.\{name: value\}`, `&\(a, b\)`, or `&\.\(a\)` for one value; these arguments have no fields\n/],
  ]
  for (const [name, source, expected] of [...lendCases, ...patternCases, ...staticCases, ...interopCases, ...templateCases]) {
    yield* fs.makeDirectory(join(directory, `${name}/src`), { recursive: true })
    yield* fs.writeFileString(join(directory, `${name}/silk.toml`), `[package]\nname = "${name}"\nversion = "0.1.0"\nsilk-version = "0.0.0"\n`)
    yield* fs.writeFileString(join(directory, `${name}/src/main.silk`), source)
    const checked = yield* invoke(silk, ['check', '--stdlib', standardLibrary], join(directory, name))
    assert.equal(checked.status, 1, checked.stderr)
    assert.match(checked.stderr, expected)
    assert.equal(checked.stderr.match(/error\[/g)?.length, 1, checked.stderr)
    assert.doesNotMatch(checked.stderr, /stdlib\/silk\/text\/format\.silk/, checked.stderr)
  }
  // Parking checks run at build time: each names what parks and the rule it breaks.
  const parkingCases: Array<[string, string, RegExp]> = [
    ["parkfinalizer", "import silk.core.effect { Effect }\nimport silk.concurrency.fiber { Fiber }\neffect fn finish() -> () {\n  run Fiber<(), ()>.yieldNow()\n  return ()\n}\neffect fn body() -> i32 { return 3 }\npub fn main() -> i32 {\n  return run Effect.ensuringNonParking(body(), finish())\n}\n", /error\[SEM0139\] `finish` must not park, because this call needs an `Intrinsic\.NonParking` value, but running it can park; move work that can suspend, such as `Effect\.sleep`, out of it\n/],
    ["heldaccess", "import silk.mem.allocator { Allocator, OutOfMemoryError }\nimport silk.core.effect { Effect }\nimport silk.concurrency.fiber { Fiber }\nimport silk.mem.shared { Shared }\nstruct Counter { value: i32 }\neffect fn noisy() -> () {\n  run Fiber<(), ()>.yieldNow()\n  return ()\n}\nfn bump(c: &mut Counter) -> i32 {\n  run noisy()\n  c.value = c.value + 1\n  return c.value\n}\neffect fn work() -> i32 ! OutOfMemoryError {\n  let mut allocator = Allocator.systemAllocatorProvider()\n  let shared = run (Shared<Counter>.make(Counter { value: 0 })\n    |> Effect.provideMut<Allocator>(&mut allocator))\n  return Shared<Counter>.withMut<i32>(&shared, bump)\n}\neffect fn recover(error: OutOfMemoryError) -> i32 { return -1 }\npub fn main() -> i32 {\n  return run Effect.catchAll(work(), recover)\n}\n", /error\[OWN0016\] `noisy\(\)` runs an Effect while a local-shared access such as `Shared\.withMut` holds its exclusive borrow; take what you need out of the value, return it, and run the Effect after the access returns\n/],
  ]
  for (const [name, source, expected] of parkingCases) {
    yield* fs.makeDirectory(join(directory, `${name}/src`), { recursive: true })
    yield* fs.writeFileString(join(directory, `${name}/silk.toml`), `[package]\nname = "${name}"\nversion = "0.1.0"\nsilk-version = "0.0.0"\n`)
    yield* fs.writeFileString(join(directory, `${name}/src/main.silk`), source)
    const built = yield* invoke(silk, ['build', '--stdlib', standardLibrary], join(directory, name), { ...process.env, SILK_CLANG: clang })
    assert.equal(built.status, 1, built.stderr)
    assert.match(built.stderr, expected)
  }
  // Silk code may call an `export "C"` function directly, through its C symbol.
  yield* fs.makeDirectory(join(directory, 'callexport/src'), { recursive: true })
  yield* fs.writeFileString(join(directory, 'callexport/silk.toml'), '[package]\nname = "callexport"\nversion = "0.1.0"\nsilk-version = "0.0.0"\n')
  yield* fs.writeFileString(join(directory, 'callexport/src/main.silk'), "export \"C\" fn twice(v: i32) -> i32 {\n  return v * 2\n}\n\npub fn main() -> i32 {\n  return unsafe twice(21)\n}\n")
  const exportCall = yield* invoke(silk, ['run', '--stdlib', standardLibrary], join(directory, 'callexport'), { ...process.env, SILK_CLANG: clang })
  assert.equal(exportCall.status, 42, exportCall.stderr)
  // A shift count out of range is the caller's mistake, so the trap names the caller's line.
  yield* fs.makeDirectory(join(directory, 'shiftcount/src'), { recursive: true })
  yield* fs.writeFileString(join(directory, 'shiftcount/silk.toml'), '[package]\nname = "shiftcount"\nversion = "0.1.0"\nsilk-version = "0.0.0"\n')
  yield* fs.writeFileString(join(directory, 'shiftcount/src/main.silk'), 'import silk.num.u32\n\nfn count(n: u32) -> u32 { return n + 31 }\n\npub fn main() -> i32 {\n  let shifted = u32.shiftLeft(1, count(1))\n  return u32.toI32(shifted)\n}\n')
  const shiftCount = yield* invoke(silk, ['run', '--stdlib', standardLibrary], join(directory, 'shiftcount'), { ...process.env, SILK_CLANG: clang })
  assert.notEqual(shiftCount.status, 0, shiftCount.stderr)
  assert.match(shiftCount.stderr, /^fatal trap: invalid shift count\n {2}at main\.main \(main:6:17\)$/m)
  // A function that only moves in its file is not lowered again, and its trap names the line it
  // moved to.
  const shiftCountSource = yield* fs.readFileString(join(directory, 'shiftcount/src/main.silk'))
  yield* fs.writeFileString(join(directory, 'shiftcount/src/main.silk'), shiftCountSource.replace('\npub fn main', '// moved\n\n\npub fn main'))
  const movedBuild = yield* invoke(silk, ['build', '--stdlib', standardLibrary, '--timings'], join(directory, 'shiftcount'), { ...process.env, SILK_CLANG: clang })
  assert.equal(movedBuild.status, 0, movedBuild.stderr)
  assert.match(movedBuild.stdout + movedBuild.stderr, /codegen\s+0 functions\s/)
  const movedCount = yield* invoke(silk, ['run', '--stdlib', standardLibrary], join(directory, 'shiftcount'), { ...process.env, SILK_CLANG: clang })
  assert.match(movedCount.stderr, /^fatal trap: invalid shift count\n {2}at main\.main \(main:8:17\)$/m)
  // A trap after a fiber resumes names the suspended callers of the resumed frame, which only its
  // frame chain holds: the fiber's driver, not `work`, called `pick`'s step.
  yield* fs.makeDirectory(join(directory, 'resumedtrap/src'), { recursive: true })
  yield* fs.writeFileString(join(directory, 'resumedtrap/silk.toml'), '[package]\nname = "resumedtrap"\nversion = "0.1.0"\nsilk-version = "0.0.0"\n')
  yield* fs.writeFileString(join(directory, 'resumedtrap/src/main.silk'), 'import silk.mem.allocator { OutOfMemoryError }\nimport silk.core.effect { Effect }\nimport silk.concurrency.fiber { Cancelled, Fiber }\nimport silk.concurrency.local_scheduler { LocalScheduler, StalledError }\nimport silk.system.monotonic_clock { MonotonicClock }\nimport silk.system.monotonic_clock_native { OsMonotonicClock }\nimport silk.concurrency.scheduler { Scheduler, TaskIdExhaustedError }\nfn at(values: &[i32], index: usize) -> i32 { return values[index] }\neffect fn pick(values: &[i32], index: usize) -> i32 {\n  run Fiber.yieldNow()\n  return at(values, index)\n}\neffect fn work(index: usize) -> i32 {\n  let values = [1, 2, 3]\n  return run pick(&values, index)\n}\neffect fn root() -> i32 ! OutOfMemoryError | TaskIdExhaustedError | Cancelled ? &mut Scheduler | &mut MonotonicClock {\n  let child = run Fiber<i32, never>.forkChild(work(5))\n  return run child.join()\n}\npub effect fn main() -> i32 ! OutOfMemoryError | TaskIdExhaustedError | Cancelled | StalledError {\n  let mut clock = OsMonotonicClock.make()\n  let mut scheduler = LocalScheduler.make()\n  return run scheduler.execute<i32, OutOfMemoryError | TaskIdExhaustedError | Cancelled>(root())\n    |> Effect.provideMut<MonotonicClock>(&mut clock)\n}\n')
  const resumedTrap = yield* invoke(silk, ['run', '--stdlib', standardLibrary], join(directory, 'resumedtrap'), { ...process.env, SILK_CLANG: clang })
  assert.notEqual(resumedTrap.status, 0, resumedTrap.stderr)
  assert.match(resumedTrap.stderr, /^fatal trap: index out of bounds\n {2}at main\.at \(main:8:53\)\n {2}at main\.pick\n {2}at main\.work\n {2}at main\.main\n/m)
  // A width or precision field can be any integer, so a bare literal needs no `usize` annotation.
  yield* fs.makeDirectory(join(directory, 'widthint/src'), { recursive: true })
  yield* fs.writeFileString(join(directory, 'widthint/silk.toml'), '[package]\nname = "widthint"\nversion = "0.1.0"\nsilk-version = "0.0.0"\n')
  yield* fs.writeFileString(join(directory, 'widthint/src/main.silk'), 'import silk.io.writer_native { StderrWriter }\n\npub fn main() -> i32 {\n  StderrWriter.print("[{name:>w$}] [{v:.p$}]\\n", &.{ name: "Ada", w: 5, v: 7, p: 3 })\n  return 0\n}\n')
  const widthInt = yield* invoke(silk, ['run', '--stdlib', standardLibrary], join(directory, 'widthint'), { ...process.env, SILK_CLANG: clang })
  assert.equal(widthInt.status, 0, widthInt.stderr)
  assert.match(widthInt.stderr, /^\[  Ada\] \[007\]$/m)
  // A line that starts with `-1 =>` is the next arm, not a subtraction from the arm before it.
  yield* fs.makeDirectory(join(directory, 'negarm/src'), { recursive: true })
  yield* fs.writeFileString(join(directory, 'negarm/silk.toml'), '[package]\nname = "negarm"\nversion = "0.1.0"\nsilk-version = "0.0.0"\n')
  yield* fs.writeFileString(join(directory, 'negarm/src/main.silk'), "fn pick(n: i32) -> i32 {\n  return match n {\n    7 => 1\n    -1 => 2\n    i32 other => other\n  }\n}\n\npub fn main() -> i32 {\n  return pick(-1) + pick(7) + pick(5)\n}\n")
  const negative = yield* invoke(silk, ['run', '--stdlib', standardLibrary], join(directory, 'negarm'), { ...process.env, SILK_CLANG: clang })
  assert.equal(negative.status, 8, negative.stderr)
  yield* fs.makeDirectory(join(directory, 'lendok/src'), { recursive: true })
  yield* fs.writeFileString(join(directory, 'lendok/silk.toml'), '[package]\nname = "lendok"\nversion = "0.1.0"\nsilk-version = "0.0.0"\n')
  yield* fs.writeFileString(join(directory, 'lendok/src/main.silk'), "fn callMut(mut f: mut fn(i32) -> i32) -> i32 {\n  return f(1)\n}\n\npub fn main() -> i32 {\n  let mut total = 0\n  let mut acc = |x: i32| -> i32 {\n    total = total + x\n    return total\n  }\n  let a = callMut(acc)\n  let b = callMut(acc)\n  let c = acc(100)\n  return a + b + c\n}\n")
  const lent = yield* invoke(silk, ['run', '--stdlib', standardLibrary], join(directory, 'lendok'), { ...process.env, SILK_CLANG: clang })
  assert.equal(lent.status, 105, lent.stderr)
  // A syntax error the parser recovered from fails the check phase of a build, before codegen.
  yield* fs.makeDirectory(join(directory, 'unclosed/src'), { recursive: true })
  yield* fs.writeFileString(
    join(directory, 'unclosed/silk.toml'),
    '[package]\nname = "unclosed"\nversion = "0.1.0"\nsilk-version = "0.0.0"\n',
  )
  yield* fs.writeFileString(join(directory, 'unclosed/src/main.silk'), 'pub fn main() -> i32 {\n  return 0\n')
  const unclosed = yield* invoke(
    silk,
    ['build', '--stdlib', standardLibrary, '--progress', 'plain'],
    join(directory, 'unclosed'),
    { ...process.env, SILK_CLANG: clang },
  )
  assert.equal(unclosed.status, 1, unclosed.stderr)
  // The cache has its own row, before the check, even when it holds nothing yet.
  assert.match(unclosed.stderr, /^ {2}load {6}[^\n]*\n {2}cache {5}nothing to reuse {2,}[0-9.ms ]+s\n {2}check {5}failed: 1 module, 1 error/m)
  assert.match(unclosed.stderr, /^src\/main\.silk:3:1: error\[PAR0001\] Expected `\}`$/m)
  assert.doesNotMatch(unclosed.stderr, /codegen/)
  // A file with a syntax error keeps no import summary, so the next load parses it and reports it again.
  const reopened = yield* invoke(
    silk,
    ['build', '--stdlib', standardLibrary, '--progress', 'plain'],
    join(directory, 'unclosed'),
    { ...process.env, SILK_CLANG: clang },
  )
  assert.equal(reopened.status, 1, reopened.stderr)
  assert.match(reopened.stderr, /^src\/main\.silk:3:1: error\[PAR0001\] Expected `\}`$/m)
  // Whether a build closes the member sets of erased types is a fact of the sources it loads, not
  // of the answers it reuses. After a check that failed in another module, the next build reuses
  // the checks of the standard library modules that write `any SchemaReader` without parsing
  // them, and still lowers their dispatchers instead of stopping at a provisional gap.
  {
    const project = join(directory, 'erasedreuse')
    yield* fs.makeDirectory(join(project, 'src'), { recursive: true })
    yield* fs.writeFileString(join(project, 'silk.toml'), '[package]\nname = "erasedreuse"\nversion = "0.1.0"\nsilk-version = "0.0.0"\n')
    yield* fs.writeFileString(
      join(project, 'src/main.silk'),
      [
        'import helper { half }',
        'import silk.core.effect { Effect }',
        'import silk.mem.allocator { Allocator, OutOfMemoryError }',
        'import silk.schema.issue { SchemaError }',
        'import silk.schema.json { SchemaJson }',
        'import silk.schema.schema { Schema }',
        '',
        'struct Row {',
        '  pub value: u64,',
        '}',
        '',
        'impl Schema for Row {}',
        '',
        'pub effect fn main() -> i32 ! SchemaError | OutOfMemoryError {',
        '  let mut allocator = Allocator.systemAllocatorProvider()',
        '  let row = run SchemaJson.decode<Row>(b"{\\"value\\":6}") |> Effect.provideMut<Allocator>(&mut allocator)',
        '  if half(row.value) == 3 {',
        '    return 0',
        '  }',
        '  return 1',
        '}',
        '',
      ].join('\n'),
    )
    const helper = (divisor: string) => `pub fn half(value: u64) -> u64 {\n  return value / ${divisor}\n}\n`
    yield* fs.writeFileString(join(project, 'src/helper.silk'), helper('"2"'))
    const refused = yield* invoke(silk, ['build', '--stdlib', standardLibrary], project, { ...process.env, SILK_CLANG: clang })
    settleCaches(project)
    assert.equal(refused.status, 1, refused.stderr)
    assert.match(refused.stderr, /^src\/helper\.silk:2:16: error\[SEM0135\]/m)
    yield* fs.writeFileString(join(project, 'src/helper.silk'), helper('2'))
    const built = yield* invoke(silk, ['run', '--stdlib', standardLibrary], project, { ...process.env, SILK_CLANG: clang })
    settleCaches(project)
    assert.equal(built.status, 0, built.stderr)
    assert.doesNotMatch(built.stderr, /unsupported\[/)
  }
  // A check does not wait for a build's cache write once the file holds a check's escape walks:
  // it reads the file as it stands. While the file holds only a build, the check waits for the
  // write, since the file it leaves is the one the check's own write must carry.
  for (const checkedFirst of [true, false]) {
    const name = checkedFirst ? 'unwaited' : 'waited'
    const project = join(directory, name)
    yield* fs.makeDirectory(join(project, 'src'), { recursive: true })
    yield* fs.writeFileString(join(project, 'silk.toml'), `[package]\nname = "${name}"\nversion = "0.1.0"\nsilk-version = "0.0.0"\n`)
    yield* fs.writeFileString(join(project, 'src/main.silk'), 'fn half(value: i32) -> i32 {\n  return value / 2\n}\n\npub fn main() -> i32 {\n  return half(0)\n}\n')
    const first = checkedFirst ? ['check', '--no-server'] : ['build']
    const prepared = yield* invoke(silk, [...first, '--stdlib', standardLibrary], project, { ...process.env, SILK_CLANG: clang })
    assert.equal(prepared.status, 0, prepared.stderr)
    const cache = compilerCache(join(project, 'build/cache', name))
    const lock = (yield* fs.readDirectory(cache)).find((entry) => /^semantic-[0-9a-f]{32}\.lock$/.test(entry))
    assert.ok(lock, `${name}: the cache names no lock file`)
    // Stands in for a build's writer: it holds the write lock, and not the one a check's write holds too.
    const holdSeconds = checkedFirst ? 60 : 2
    const holder = spawn('python3', ['-c', 'import fcntl, sys, time\nheld = open(sys.argv[1])\nfcntl.flock(held, fcntl.LOCK_EX)\nprint("held", flush=True)\ntime.sleep(float(sys.argv[2]))', join(cache, lock), String(holdSeconds)], {
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    yield* Effect.promise(() => new Promise<void>((resolved) => holder.stdout.once('data', () => resolved())))
    const heldAt = Date.now()
    const checked = spawnSync(silk, ['check', '--no-server', '--stdlib', standardLibrary, '--progress', 'plain'], { cwd: project, encoding: 'utf8', timeout: 50_000 })
    const waited = Date.now() - heldAt
    holder.kill()
    settleCaches(project)
    assert.equal(checked.status, 0, checked.stderr)
    if (checkedFirst) {
      assert.ok(waited < holdSeconds * 1000, `${name}: the check waited ${waited} ms for the build's write`)
      assert.match(checked.stderr, /^ {2}cache {5}[1-9][0-9,]* checks? reused {2,}[0-9.ms ]+s$/m)
    } else {
      assert.ok(waited >= holdSeconds * 1000, `${name}: the check read a file without a check's walks ${waited} ms into the build's write`)
    }
  }
  // `test` builds the project's runner below <output-dir>/test as an executable, whatever the
  // manifest's artifact, and runs the tests that --file and --filter select; a failing test makes
  // the status 1, and a selection outside the source root is refused before anything is built.
  yield* fs.makeDirectory(join(directory, 'tested/src/util'), { recursive: true })
  yield* fs.writeFileString(
    join(directory, 'tested/silk.toml'),
    '[package]\nname = "tested"\nversion = "0.1.0"\nmain = "main.silk"\nkind = "library"\nsilk-version = "0.0.0"\n',
  )
  yield* fs.writeFileString(
    join(directory, 'tested/src/main.silk'),
    'import util.check\n\npub fn answer() -> i32 {\n  return check.half(84)\n}\n\ntest fn rootPasses() -> () {\n}\n',
  )
  yield* fs.writeFileString(
    join(directory, 'tested/src/util/check.silk'),
    'import silk.testing.testing { AssertionError, Testing }\n\npub fn half(value: i32) -> i32 {\n  return value / 2\n}\n\ntest effect fn halvesEvenly() -> () ! AssertionError<\'static> {\n  run Testing.expect(half(84) == 42, "84 halves to 42")\n}\n\ntest effect fn failsOnPurpose() -> () ! AssertionError<\'static> {\n  run Testing.expect(half(3) == 2, "integer division truncates")\n}\n\ntest fn dividesByZero() -> () {\n  let zero: i32 = 0\n  let _quotient = half(2) / zero\n}\n',
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
  // The runner's build reports its phases as a program's does, and keeps a semantic cache of its
  // own beside the package's so the next runner build checks and emits only what an edit reaches.
  assert.match(selectedTests.stderr, /^Compiling tested tests \(/m)
  assert.match(selectedTests.stderr, /^ {2}codegen +[\d,]+ functions? /m)
  assert.equal(yield* fs.exists(join(directory, 'tested/build/cache/tested@tests')), true)
  assert.match(
    selectedTests.stdout,
    /1 passed, 0 failed \(0 cached, 1 executed, 1 selected, 4 discovered\)/,
  )
  assert.equal(
    yield* fs.exists(join(directory, 'tested/build', hostTarget, 'dev/tested-tests')),
    true,
  )
  const runnerRecord = join(directory, 'tested/build', hostTarget, 'dev/tested-tests.inputs')
  const firstRecord = yield* fs.readFile(runnerRecord)
  // No passing test is recorded yet (the first run used --no-cache), so a plain `silk test` runs
  // every selected test.
  const failedTests = yield* invoke(
    silk,
    ['test', '--stdlib', standardLibrary],
    join(directory, 'tested'),
    { ...process.env, SILK_CLANG: clang },
  )
  assert.equal(failedTests.status, 1, failedTests.stderr)
  // The first build's record already describes the unchanged project, so this run reused its
  // runner and left the record as it was.
  assert.deepEqual(yield* fs.readFile(runnerRecord), firstRecord, 'the second test run reuses the runner')
  // A test that traps fails with its report under its name, and the tests after it still run.
  assert.match(
    failedTests.stdout,
    /util\/check::dividesByZero\n {4}fatal trap: division by zero\n(.*\n)* {4}FAIL {2}stopped the test process\n(.*\n)*  util\/check::halvesEvenly\n {4}PASS/,
  )
  // A failed expectation names where it failed.
  assert.match(
    failedTests.stdout,
    /util\/check::failsOnPurpose\n {4}assertion failed: integer division truncates\n {6}at [^\n]*failsOnPurpose \([^\n]*:12:3\)\n {4}FAIL/,
  )
  assert.match(failedTests.stdout, /2 passed, 2 failed \(0 cached, 4 executed, 4 selected, 4 discovered\)/)
  // A test that passed is recorded, and the unchanged runner skips it while its code and inputs
  // stay the same.
  const passArguments = ['test', '--stdlib', standardLibrary, '--file', 'src/util/check.silk', '--filter', 'EVEN']
  const passedTests = yield* invoke(silk, passArguments, join(directory, 'tested'), { ...process.env, SILK_CLANG: clang })
  assert.equal(passedTests.status, 0, passedTests.stderr)
  const replayedTests = yield* invoke(silk, passArguments, join(directory, 'tested'), { ...process.env, SILK_CLANG: clang })
  assert.equal(replayedTests.status, 0, replayedTests.stderr)
  assert.match(replayedTests.stdout, /util\/check::halvesEvenly\n {4}CACHED\n/)
  assert.match(replayedTests.stdout, /1 passed, 0 failed \(1 cached, 0 executed, 1 selected, 4 discovered\)/)
  // `--no-cache` runs them again.
  const forcedTests = yield* invoke(
    silk,
    ['test', '--no-cache', ...passArguments.slice(1)],
    join(directory, 'tested'),
    { ...process.env, SILK_CLANG: clang },
  )
  assert.equal(forcedTests.status, 0, forcedTests.stderr)
  assert.match(forcedTests.stdout, /1 passed, 0 failed \(0 cached, 1 executed, 1 selected, 4 discovered\)/)
  // An edit in a separate test admits a second member. A test that calls the dispatcher
  // must run again even though it still passes the same concrete value.
  const dispatchTests = join(directory, 'dispatch-tests')
  yield* fs.makeDirectory(join(dispatchTests, 'src'), { recursive: true })
  yield* fs.writeFileString(join(dispatchTests, 'silk.toml'), '[package]\nname = "dispatch-tests"\nversion = "0.1.0"\nmain = "main.silk"\nkind = "library"\nsilk-version = "0.0.0"\n')
  yield* fs.writeFileString(join(dispatchTests, 'src/main.silk'), `import members
test fn readsFirst() -> () { drop members.first() }
test fn independent() -> () {}
test fn changesMemberSet() -> () { drop members.second() }
`)
  const dispatchMembersSource = `interface Read { fn read(self: &Self) -> i32 }
struct First {}
struct Second {}
impl Read for First { fn read(self: &Self) -> i32 { return 1 } }
impl Read for Second { fn read(self: &Self) -> i32 { return 2 } }
@inlineNever
fn read(value: &any Read) -> i32 { return value.read() }
pub fn first() -> i32 { let member = First {} return read(&member) }
`
  for (const second of ['return 2', 'let member = Second {} return read(&member)']) {
    yield* fs.writeFileString(join(dispatchTests, 'src/members.silk'), dispatchMembersSource + `pub fn second() -> i32 { ${second} }\n`)
    const tests = yield* invoke(silk, ['test', '--stdlib', standardLibrary], dispatchTests, { ...process.env, SILK_CLANG: clang })
    assert.equal(tests.status, 0, tests.stderr)
    assert.match(tests.stdout, /main::readsFirst\n {4}PASS/)
    if (second === 'return 2') assert.match(tests.stdout, /0 cached, 3 executed/)
    else {
      assert.match(tests.stdout, /main::independent\n {4}CACHED/)
      assert.match(tests.stdout, /1 cached, 2 executed/)
    }
  }
  // Replay the same edits through a long-lived checker and a new store at each step. Both a
  // missing witness and an operation with a by-value receiver disappear again after repair.
  const dispatchEdits = [
    ['body', 'let member = Second {}', 'let member: i32 = 2'],
    ['body', 'let member: i32 = 2', 'let member = Second {}'],
    ['header-new-type', 'interface Read { fn read(self: &Self)', 'interface Read { fn read(self: Self)'],
    ['header-new-type', 'interface Read { fn read(self: Self)', 'interface Read { fn read(self: &Self)'],
  ].map(([kind, before, after]) =>
    `[[edit]]\nkind = "${kind}"\nmodule = "members.silk"\nfind = "${before}"\nreplace = "${after}"\n`)
  yield* fs.writeFileString(join(dispatchTests, 'edits.toml'), dispatchEdits.join('\n'))
  const checkedMembership = yield* invoke(silk, ['check', '--stdlib', standardLibrary, '--replay', 'edits.toml', '--differential'], dispatchTests)
  assert.equal(checkedMembership.status, 0, checkedMembership.stderr)
  const verdicts = [...(checkedMembership.stdout + checkedMembership.stderr).matchAll(/silk-replay-differential step=\d+ rejections=(\d+) differences=(\d+)/g)]
  assert.deepEqual(verdicts.map(([, rejected, differences]) => [Number(rejected), Number(differences)]),
    [[0, 0], [1, 0], [0, 0], [1, 0], [0, 0]])
  // A selection that matches no test verified nothing, so it fails, and running it again fails the
  // same way.
  for (let attempt = 0; attempt < 2; attempt++) {
    const unmatchedTests = yield* invoke(
      silk,
      ['test', '--stdlib', standardLibrary, '--filter', 'zzz'],
      join(directory, 'tested'),
      { ...process.env, SILK_CLANG: clang },
    )
    assert.equal(unmatchedTests.status, 1, unmatchedTests.stderr)
    assert.match(unmatchedTests.stderr, /no tests matched/)
  }
  // A test past its --timeout and a test that overflows the stack each fail with a report naming
  // why, and the remaining tests still run.
  yield* fs.makeDirectory(join(directory, 'stuck/src'), { recursive: true })
  yield* fs.writeFileString(
    join(directory, 'stuck/silk.toml'),
    '[package]\nname = "stuck"\nversion = "0.1.0"\nsilk-version = "0.0.0"\n',
  )
  yield* fs.writeFileString(
    join(directory, 'stuck/src/main.silk'),
    'fn deep(n: i64) -> i64 {\n  if n == 0 { return 0 }\n  return deep(n - 1) + 1\n}\n\npub fn main() -> i32 {\n  return 0\n}\n\ntest fn overflows() {\n  let _depth = deep(100000000)\n}\n\ntest fn spins() {\n  let mut i: i64 = 0\n  while i >= 0 {\n    i = i - 1 + 1\n  }\n}\n\ntest fn zFinishes() {\n}\n',
  )
  const stuckTests = yield* invoke(
    silk,
    ['test', '--stdlib', standardLibrary, '--timeout', '1'],
    join(directory, 'stuck'),
    { ...process.env, SILK_CLANG: clang },
  )
  assert.equal(stuckTests.status, 1, stuckTests.stderr)
  assert.match(stuckTests.stderr, /^fatal trap: stack overflow$/m)
  assert.match(stuckTests.stderr, /the test did not finish within 1 s/)
  assert.match(stuckTests.stdout, /main::zFinishes\n {4}PASS/)
  assert.match(stuckTests.stdout, /1 passed, 2 failed/)
  // `silk doctest` in a package checks every example, then builds and runs each one with a
  // `main`, which passes when it returns 0. A hyphenated package is imported as its dependents
  // write it, and `no_run` examples only compile.
  yield* fs.makeDirectory(join(directory, 'round-shapes/src'), { recursive: true })
  yield* fs.writeFileString(
    join(directory, 'round-shapes/silk.toml'),
    '[package]\nname = "round-shapes"\nversion = "0.1.0"\nkind = "library"\nsilk-version = "0.0.0"\n',
  )
  yield* fs.writeFileString(
    join(directory, 'round-shapes/src/lib.silk'),
    [
      '/// Three times `diameter`.',
      '///',
      '/// ```silk',
      '/// import round_shapes.lib { circumference }',
      '///',
      '/// pub fn main() -> i32 {',
      '///   return circumference(2) - 6',
      '/// }',
      '/// ```',
      '///',
      '/// ```silk',
      '/// import lib { circumference }',
      '/// import silk.core.effect { Effect }',
      '/// import silk.io.writer_native { StdoutWriter }',
      '/// import silk.io.writer { Writer, WriterError }',
      '///',
      '/// pub effect fn main() -> i32 ! WriterError {',
      '///   let mut out = StdoutWriter.make()',
      '///   run Writer.writeAll(b"wrong\\n") |> Effect.provideMut<Writer>(&mut out)',
      '///   return circumference(1)',
      '/// }',
      '/// ```',
      '///',
      '/// ```silk,no_run',
      '/// import lib { circumference }',
      '///',
      '/// pub fn main() -> i32 {',
      '///   return circumference(5)',
      '/// }',
      '/// ```',
      'pub fn circumference(diameter: i32) -> i32 {',
      '  return diameter * 3',
      '}',
      '',
    ].join('\n'),
  )
  const doctests = yield* invoke(
    silk,
    ['doctest', '--stdlib-root', standardLibrary],
    join(directory, 'round-shapes/src'),
    { ...process.env, SILK_CLANG: clang },
  )
  assert.equal(doctests.status, 1, doctests.stderr)
  assert.match(doctests.stdout, /lib\.silk:3 \(byte \d+\): PASSED\n/)
  assert.match(doctests.stdout, /lib\.silk:11 \(byte \d+\): FAILED: the example exited with status 3\nwrong\n/)
  assert.match(doctests.stdout, /lib\.silk:24 \(byte \d+\): PASSED\n/)
  assert.match(doctests.stdout, /Doctest: 3 collected, 2 passed, 0 skipped, 1 failed\./)
  assert.equal(yield* fs.exists(join(directory, 'round-shapes/src/doctest_example.silk')), false)
  // Package commands take --clang as they honor SILK_CLANG, and a Clang that cannot start fails
  // the target with the usual per-target and summary lines.
  const clangTests = yield* invoke(
    silk,
    ['test', '--no-cache', '--stdlib', standardLibrary, '--filter', 'EVEN', '--clang', clang],
    join(directory, 'tested'),
    { ...process.env, SILK_CLANG: sentinel },
  )
  assert.equal(clangTests.status, 0, clangTests.stderr)
  yield* fs.writeFileString(join(directory, 'tested/silk.toml'),
    '[package]\nname = "tested"\nversion = "0.1.0"\nmain = "main.silk"\nkind = "executable"\nsilk-version = "0.0.0"\n')
  yield* fs.writeFileString(join(directory, 'tested/src/main.silk'), 'pub fn main() -> i32 { return 0 }\n')
  const unstartedBuild = yield* invoke(
    silk,
    ['build', '--stdlib', standardLibrary, '--clang', join(directory, 'no-such-clang')],
    join(directory, 'tested'),
    { ...process.env, SILK_CLANG: clang },
  )
  assert.equal(unstartedBuild.status, 2, unstartedBuild.stderr)
  assert.match(unstartedBuild.stderr, /no-such-clang \(from --clang\)/)
  // A link counts nothing, so its failed row has no detail after `failed`.
  assert.match(unstartedBuild.stderr, /^  link      failed +[0-9.ms ]+s$/m)
  assert.doesNotMatch(unstartedBuild.stderr, /failed:/)
  assert.match(unstartedBuild.stderr, /^Failed tested in /m)
  // Source commands construct one package without discovering a nearby manifest.
  const unpackaged = yield* fs.makeTempDirectoryScoped({ prefix: 'silk-unpackaged-' })
  yield* fs.writeFileString(join(unpackaged, 'lone.silk'), 'pub fn main() -> i32 { return 0 }\ntest fn lone() -> () {}\n')
  for (const command of ['build', 'test']) {
    const lone = yield* invoke(silk,
      [command, 'lone.silk', '-o', `lone-${command}`, '--stdlib', standardLibrary], unpackaged,
      { ...process.env, SILK_CLANG: clang })
    assert.equal(lone.status, 0, `${command}: ${lone.stderr}`)
  }
  // Target conditions in ordinary static code omit irrelevant native requirements.
  const otherSystem = hostTarget.includes('apple-darwin') ? 'Linux' : 'Darwin'
  yield* fs.writeFileString(join(unpackaged, 'silk.toml'),
    '[package]\nname = "linked"\nversion = "0.1.0"\nsource = "."\nsilk-version = "0.0.0"\n')
  yield* fs.writeFileString(join(unpackaged, 'main.silk'), 'pub fn main() -> i32 { return 0 }\n')
  yield* writePlan(unpackaged, `  if Target.operatingSystem() == OperatingSystem.${otherSystem} {
    plan = Plan.linkFramework(plan, "Security", Framework.make())
    plan = Plan.linkLibrary(plan, "nosuchlibrary", Library.dynamicSearch())
  }`)
  const skippedInput = yield* invoke(silk, ['build', '--stdlib', standardLibrary], unpackaged, { ...process.env, SILK_CLANG: clang })
  assert.equal(skippedInput.status, 0, skippedInput.stderr)
  // A library's native plan reaches every executable that depends on it, after the
  // executable's own inputs, so the executable's manifest repeats none of it.
  const propagated = yield* fs.makeTempDirectoryScoped({ prefix: 'silk-propagated-' })
  for (const member of ['shim', 'middle', 'app']) yield* fs.makeDirectory(join(propagated, member), { recursive: true })
  yield* fs.writeFileString(join(propagated, 'shim/offset.c'), 'int shim_offset(void) { return 3; }\n')
  const shimObject = yield* invoke(clang, ['-c', '-fPIC', 'offset.c', '-o', 'offset.o'], join(propagated, 'shim'))
  assert.equal(shimObject.status, 0, shimObject.stderr)
  const shimArchive = yield* invoke(join(dirname(clang), 'llvm-ar'), ['rcs', 'libshim.a', 'offset.o'], join(propagated, 'shim'))
  assert.equal(shimArchive.status, 0, shimArchive.stderr)
  yield* fs.writeFileString(join(propagated, 'shim/silk.toml'),
    '[package]\nname = "shim"\nversion = "0.1.0"\nkind = "library"\nsource = "."\nexports = ["Shim"]\nsilk-version = "0.0.0"\n')
  yield* writePlan(join(propagated, 'shim'), '  plan = Plan.linkArchive(plan, sourcePath("libshim.a"))')
  yield* fs.writeFileString(
    join(propagated, 'shim/Shim.silk'),
    'unsafe extern "C" fn shim_offset() -> i32\n\npub fn offset() -> i32 {\n  return unsafe shim_offset()\n}\n',
  )
  // A package between the executable and the library reaches it too, and an input two packages
  // list links once.
  yield* fs.writeFileString(
    join(propagated, 'middle/silk.toml'),
    '[package]\nname = "middle"\nversion = "0.1.0"\nkind = "library"\nsource = "."\nexports = ["Middle"]\nsilk-version = "0.0.0"\n\n[dependencies]\nshim = { path = "../shim" }\n',
  )
  yield* fs.writeFileString(
    join(propagated, 'middle/Middle.silk'),
    'import shim.Shim\n\npub fn doubled() -> i32 {\n  return Shim.offset() * 2\n}\n',
  )
  yield* fs.writeFileString(
    join(propagated, 'app/silk.toml'),
    '[package]\nname = "app"\nversion = "0.1.0"\nsource = "."\nsilk-version = "0.0.0"\n\n[dependencies]\nmiddle = { path = "../middle" }\nshim = { path = "../shim" }\n',
  )
  yield* fs.writeFileString(
    join(propagated, 'app/main.silk'),
    'import middle.Middle\nimport shim.Shim\n\npub fn main() -> i32 {\n  return Middle.doubled() + Shim.offset()\n}\n',
  )
  for (const round of [1, 2]) {
    const linkedApp = yield* invoke(silk, ['run', '--quiet', '--stdlib', standardLibrary], join(propagated, 'app'), { ...process.env, SILK_CLANG: clang })
    assert.equal(linkedApp.status, 9, `round ${round}: ${linkedApp.stderr}`)
  }
  // A dependency cannot read a native input outside its package through a source path.
  yield* writePlan(join(propagated, 'shim'), '  plan = Plan.linkArchive(plan, sourcePath("/tmp/libshim.a"))')
  const refusedDependencyInput = yield* invoke(silk, ['build', '--stdlib', standardLibrary], join(propagated, 'app'), { ...process.env, SILK_CLANG: clang })
  assert.equal(refusedDependencyInput.status, 1, refusedDependencyInput.stderr)
  assert.match(refusedDependencyInput.stderr, /shim\/build\.silk: build\.silk computes no plan:/)
  // A library's native sources compile with Clang into cached objects that reach every
  // executable depending on it. A build that changes nothing reuses the executable without
  // linking; an edit to a header or to one file compiles only the files it reaches; a check
  // compiles nothing; and a flag that loads code or a path outside the package is refused.
  const sourcesRoot = yield* fs.makeTempDirectoryScoped({ prefix: 'silk-native-sources-' })
  for (const member of ['clib/native', 'clib/include', 'app']) yield* fs.makeDirectory(join(sourcesRoot, member), { recursive: true })
  yield* fs.writeFileString(join(sourcesRoot, 'clib/silk.toml'),
    '[package]\nname = "clib"\nversion = "0.1.0"\nkind = "library"\nsource = "."\nexports = ["Clib"]\nsilk-version = "0.0.0"\n')
  const clibPlan = '  plan = Plan.compileNative(plan, "c", sourcePath("native/add.c"), &["-DBASE=40"], &[sourcePath("include")])\n' +
    '  plan = Plan.compileSources(plan, "c", sourcePath("native"), "two*.c", &["-DVALUE=2"], &[])\n'
  yield* writePlan(join(sourcesRoot, 'clib'), clibPlan)
  yield* fs.writeFileString(join(sourcesRoot, 'clib/include/extra.h'), '#define EXTRA 1\n')
  yield* fs.writeFileString(join(sourcesRoot, 'clib/native/add.c'), '#include "extra.h"\n#ifdef VALUE\n#error flags leaked between translation units\n#endif\nint clib_add(int a) { return a + BASE + EXTRA; }\n')
  yield* fs.writeFileString(join(sourcesRoot, 'clib/native/two.c'), '#ifdef BASE\n#error flags leaked between translation units\n#endif\nint clib_two(void) { return VALUE; }\n')
  yield* fs.writeFileString(
    join(sourcesRoot, 'clib/Clib.silk'),
    'unsafe extern "C" fn clib_add(a: i32) -> i32\nunsafe extern "C" fn clib_two() -> i32\n\npub fn value() -> i32 {\n  return unsafe clib_add(unsafe clib_two())\n}\n',
  )
  yield* fs.writeFileString(join(sourcesRoot, 'app/silk.toml'), '[package]\nname = "app"\nversion = "0.1.0"\nsource = "."\nsilk-version = "0.0.0"\n\n[dependencies]\nclib = { path = "../clib" }\n')
  yield* fs.writeFileString(join(sourcesRoot, 'app/main.silk'), 'import clib.Clib\n\npub fn main() -> i32 {\n  return Clib.value()\n}\n')
  const compiledApp = join(sourcesRoot, 'app')
  const sourcesEnvironment = { ...process.env, SILK_CLANG: clang }
  const nativeCache = join(compiledApp, `build/${hostTarget}/dev/app.native`)
  const nativeObjects = Effect.fnUntraced(function* () {
    return (yield* fs.readDirectory(nativeCache)).filter((name) => name.endsWith('.o')).sort()
  })
  const sourcesRun = Effect.fnUntraced(function* (expected: number) {
    const built = yield* invoke(silk, ['build', '--stdlib', standardLibrary, '--timings'], compiledApp, sourcesEnvironment)
    assert.equal(built.status, 0, built.stderr)
    const ran = yield* invoke(join(compiledApp, `build/${hostTarget}/dev/app`), [], compiledApp, sourcesEnvironment)
    assert.equal(ran.status, expected, ran.stderr)
    return built.stdout + built.stderr
  })
  const sourcesChecked = yield* invoke(silk, ['check', '--stdlib', standardLibrary], compiledApp, sourcesEnvironment)
  assert.equal(sourcesChecked.status, 0, sourcesChecked.stderr)
  assert.ok(!(yield* fs.exists(nativeCache)), 'a check compiles no native source')
  yield* sourcesRun(43)
  const firstObjects = yield* nativeObjects()
  assert.equal(firstObjects.length, 2)
  assert.doesNotMatch(yield* sourcesRun(43), /^\s+link\s/m, 'an unchanged rebuild neither compiles nor links')
  yield* fs.writeFileString(join(sourcesRoot, 'clib/include/extra.h'), '#define EXTRA 5\n')
  yield* sourcesRun(47)
  assert.deepEqual(yield* nativeObjects(), firstObjects, 'a header edit recompiles the objects in place')
  yield* fs.writeFileString(join(sourcesRoot, 'clib/native/two.c'), 'int clib_two(void) { return 3; }\n')
  yield* sourcesRun(48)
  const editedNativeObjects = (yield* nativeObjects()).filter((name) => !firstObjects.includes(name))
  assert.equal(editedNativeObjects.length, 1, `an edit to one file compiles one object, added ${editedNativeObjects.join(', ')}`)
  // A file Clang reads through `#embed` and a `..` path is in the object's record, so an edit to it
  // alone compiles the object again (#3152).
  yield* fs.makeDirectory(join(sourcesRoot, 'clib/data'), { recursive: true })
  yield* fs.writeFile(join(sourcesRoot, 'clib/data/blob.bin'), new Uint8Array([3]))
  yield* fs.writeFileString(
    join(sourcesRoot, 'clib/native/two.c'),
    'static const unsigned char blob[] = {\n#embed "../data/blob.bin"\n};\nint clib_two(void) { return blob[0]; }\n',
  )
  yield* sourcesRun(48)
  yield* fs.writeFile(join(sourcesRoot, 'clib/data/blob.bin'), new Uint8Array([4]))
  yield* sourcesRun(49)
  for (const operation of [
    'Plan.cFlag(plan, "-fplugin=evil.so")',
    'Plan.cFlag(plan, "-Wl,-rpath,/tmp")',
    'Plan.compileC(plan, sourcePath("../outside.c"))',
    'Plan.includePath(plan, sourcePath("/usr/include"))',
  ]) {
    yield* writePlan(join(sourcesRoot, 'clib'), `  plan = ${operation}`)
    const refusedSources = yield* invoke(silk, ['build', '--stdlib', standardLibrary], compiledApp, sourcesEnvironment)
    assert.notEqual(refusedSources.status, 0, refusedSources.stderr)
  }
  yield* writePlan(join(sourcesRoot, 'clib'), clibPlan + '  plan = Plan.compileC(plan, sourcePath("native/broken.c"))')
  yield* fs.writeFileString(join(sourcesRoot, 'clib/native/broken.c'), 'int broken(void) { return missing; }\n')
  const brokenSource = yield* invoke(silk, ['build', '--stdlib', standardLibrary], compiledApp, sourcesEnvironment)
  assert.equal(brokenSource.status, 1, brokenSource.stderr)
  assert.match(brokenSource.stderr, /broken\.c:1:27: error: use of undeclared identifier 'missing'/)
  // `[native.archive.<name>]` pins an archive by URL and SHA-256; Plan.archivePath names its files
  // in typed source and link inputs. A build fetches it once into the archive store (here from a
  // file:/// mirror), refuses a wrong digest before extracting anything, fails clearly when
  // SILK_OFFLINE is set and it is missing, and a root or machine override replaces it.
  const vendorArchived = yield* fs.makeTempDirectoryScoped({ prefix: 'silk-native-archive-' })
  for (const member of ['vend-1/include', 'vend-1/lib', 'alt/include', 'alt/lib', 'sys/native', 'app', 'home']) {
    yield* fs.makeDirectory(join(vendorArchived, member), { recursive: true })
  }
  const packVendor = Effect.fnUntraced(function* (root: string, base: number) {
    yield* fs.writeFileString(join(vendorArchived, root, 'include/vend.h'), 'int vend_base(void);\n')
    yield* fs.writeFileString(join(vendorArchived, `${root}.c`), `int vend_base(void) { return ${base}; }\n`)
    const vendorObject = yield* invoke(clang, ['-c', '-fPIC', `${root}.c`, '-o', `${root}.o`], vendorArchived)
    assert.equal(vendorObject.status, 0, vendorObject.stderr)
    const indexed = yield* invoke(join(dirname(clang), 'llvm-ar'), ['rcs', join(root, 'lib/libvend.a'), `${root}.o`], vendorArchived)
    assert.equal(indexed.status, 0, indexed.stderr)
  })
  yield* packVendor('vend-1', 30)
  yield* packVendor('alt', 50)
  const packed = yield* invoke('tar', ['czf', 'vend.tar.gz', 'vend-1'], vendorArchived)
  assert.equal(packed.status, 0, packed.stdout + packed.stderr)
  const vendDigest = createHash('sha256').update(yield* fs.readFile(join(vendorArchived, 'vend.tar.gz'))).digest('hex')
  const sysManifest = (digest: string, url = `file://${join(vendorArchived, 'vend.tar.gz')}`) =>
    '[package]\nname = "sys"\nversion = "0.1.0"\nkind = "library"\nsource = "."\nexports = ["Sys"]\nsilk-version = "0.0.0"\n'
    + `[native.archive.vend]\nurl = "${url}"\nsha256 = "${digest}"\nstrip = 1\n`
  yield* fs.writeFileString(join(vendorArchived, 'sys/silk.toml'), sysManifest(vendDigest))
  const archivePlan = (name = 'vend', path = 'lib/libvend.a') =>
    `  plan = Plan.compileC(plan, sourcePath("native/shim.c"))\n` +
    `  plan = Plan.includePath(plan, Plan.archivePath("vend", "include"))\n` +
    `  plan = Plan.linkArchive(plan, Plan.archivePath("${name}", "${path}"))\n`
  yield* writePlan(join(vendorArchived, 'sys'), archivePlan())
  yield* fs.writeFileString(join(vendorArchived, 'sys/native/shim.c'), '#include "vend.h"\nint shim_value(void) { return vend_base() + 5; }\n')
  yield* fs.writeFileString(join(vendorArchived, 'sys/Sys.silk'), 'unsafe extern "C" fn shim_value() -> i32\n\npub fn value() -> i32 {\n  return unsafe shim_value()\n}\n')
  const appManifest = '[package]\nname = "app"\nversion = "0.1.0"\nsource = "."\nsilk-version = "0.0.0"\n\n[dependencies]\nsys = { path = "../sys" }\n'
  yield* fs.writeFileString(join(vendorArchived, 'app/silk.toml'), appManifest)
  yield* fs.writeFileString(join(vendorArchived, 'app/main.silk'), 'import sys.Sys\n\npub fn main() -> i32 {\n  return Sys.value()\n}\n')
  const archivedApp = join(vendorArchived, 'app')
  const vendorArchiveEnvironment = { ...process.env, SILK_CLANG: clang, SILK_HOME: join(vendorArchived, 'home') }
  const archiveStore = join(vendorArchived, 'home/archives')
  const archivedBuild = Effect.fnUntraced(function* (environment: Record<string, string | undefined>) {
    return yield* invoke(silk, ['build', '--stdlib', standardLibrary], archivedApp, environment)
  })
  const archivedRun = Effect.fnUntraced(function* (expected: number, environment: Record<string, string | undefined> = vendorArchiveEnvironment) {
    const vendorBuilt = yield* archivedBuild(environment)
    assert.equal(vendorBuilt.status, 0, vendorBuilt.stderr)
    const vendorRan = yield* invoke(join(archivedApp, `build/${hostTarget}/dev/app`), [], archivedApp, environment)
    assert.equal(vendorRan.status, expected, vendorRan.stderr)
  })
  // Native code reads the archive, so it is fetched when that code compiles: a build failure (2),
  // not a plan the package cannot compute (1).
  const offline = yield* archivedBuild({ ...vendorArchiveEnvironment, SILK_OFFLINE: '1' })
  assert.equal(offline.status, 2, offline.stderr)
  assert.match(offline.stderr, /archive vend is not in the archive store and SILK_OFFLINE is set/)
  yield* fs.writeFileString(join(vendorArchived, 'sys/silk.toml'), sysManifest('0'.repeat(64)))
  const mismatched = yield* archivedBuild(vendorArchiveEnvironment)
  assert.equal(mismatched.status, 2, mismatched.stderr)
  assert.match(mismatched.stderr, new RegExp(`archive vend from file://.* has SHA-256 ${vendDigest}, but its manifest pins 0{64}; nothing was extracted`))
  assert.ok(!(yield* fs.exists(join(archiveStore, vendDigest))), 'a mismatched archive is never extracted')
  // SILK_ARCHIVE_MIRROR rewrites the URL's prefix, here to a file:/// directory, and the digest is
  // still checked; a malformed entry is refused.
  yield* fs.writeFileString(join(vendorArchived, 'sys/silk.toml'), sysManifest(vendDigest, 'https://archives.invalid/vend.tar.gz'))
  const malformedMirror = yield* archivedBuild({ ...vendorArchiveEnvironment, SILK_ARCHIVE_MIRROR: 'https://archives.invalid/' })
  assert.equal(malformedMirror.status, 2, malformedMirror.stderr)
  assert.match(malformedMirror.stderr, /SILK_ARCHIVE_MIRROR entry https:\/\/archives\.invalid\/ is not <prefix>=<replacement>/)
  yield* archivedRun(35, { ...vendorArchiveEnvironment, SILK_ARCHIVE_MIRROR: `https://archives.invalid/=file://${vendorArchived}/` })
  yield* fs.remove(join(archiveStore, vendDigest), { recursive: true })
  yield* fs.remove(join(archiveStore, `${vendDigest}.fetched`))
  yield* fs.writeFileString(join(vendorArchived, 'sys/silk.toml'), sysManifest(vendDigest))
  yield* archivedRun(35)
  assert.ok(yield* fs.exists(join(archiveStore, vendDigest, 'lib/libvend.a')), 'the archive is extracted below its digest, its top directory stripped')
  yield* archivedRun(35, { ...vendorArchiveEnvironment, SILK_OFFLINE: '1' })
  yield* fs.writeFileString(join(vendorArchived, 'app/silk.toml'), `${appManifest}\n[native.override.vend]\npath = "${join(vendorArchived, 'alt')}"\n`)
  yield* archivedRun(55)
  // A declared archive is named by its bytes in the link stamp: an unchanged rebuild links
  // nothing, and new bytes at the same path link again.
  const archivedExecutable = join(archivedApp, `build/${hostTarget}/dev/app`)
  const archivedAt = (yield* fs.stat(archivedExecutable)).mtime
  yield* archivedRun(55)
  assert.deepEqual((yield* fs.stat(archivedExecutable)).mtime, archivedAt, 'an unchanged build with a declared archive leaves the executable as it was')
  yield* packVendor('alt', 60)
  yield* archivedRun(65)
  yield* packVendor('alt', 50)
  yield* archivedRun(55)
  yield* fs.writeFileString(join(vendorArchived, 'app/silk.toml'), appManifest)
  yield* fs.writeFileString(join(vendorArchived, 'home/native-overrides.toml'), '[native.override.vend]\npath = "../alt"\n')
  yield* archivedRun(55)
  yield* fs.remove(join(vendorArchived, 'home/native-overrides.toml'))
  yield* archivedRun(35)
  for (const [name, path] of [['other', 'lib/libvend.a'], ['vend', '../outside']]) {
    yield* writePlan(join(vendorArchived, 'sys'), archivePlan(name, path))
    const refusedArchive = yield* archivedBuild(vendorArchiveEnvironment)
    assert.equal(refusedArchive.status, 1, refusedArchive.stderr)
    assert.match(refusedArchive.stderr, /sys\/build\.silk: build\.silk computes no plan:/)
  }
  yield* writePlan(join(vendorArchived, 'sys'), archivePlan())
  yield* fs.writeFileString(join(vendorArchived, 'sys/silk.toml'),
    sysManifest(vendDigest).replace('[native.archive.vend]', '[native.archive.vend.targets.no-such-target]'))
  const wrongArchiveTarget = yield* archivedBuild(vendorArchiveEnvironment)
  assert.equal(wrongArchiveTarget.status, 1, wrongArchiveTarget.stderr)
  // A library's build.silk computes a plan during static evaluation: a module generated from a
  // package file, a C source and a system library, which reach the executable depending on it.
  // Editing the file it reads changes the build; a plan that cannot be read, or whose module
  // would shadow a package file, refuses the build and names build.silk.
  const planned = yield* fs.makeTempDirectoryScoped({ prefix: 'silk-build-plan-' })
  for (const member of ['plib/native', 'app']) yield* fs.makeDirectory(join(planned, member), { recursive: true })
  yield* fs.writeFileString(
    join(planned, 'plib/silk.toml'),
    '[package]\nname = "plib"\nversion = "0.1.0"\nkind = "library"\nsource = "."\nexports = ["Plib"]\nsilk-version = "0.0.0"\n',
  )
  const planScript = (body: string) =>
    'import silk.build.plan { Library, Plan }\nimport silk.build.source { Source }\nimport silk.core.static_text { StaticText }\nimport silk.build.write_files { WriteFiles }\nimport silk.build.run { Run }\nimport silk.build.step { sourcePath }\n\n'
      + `static fn plan() -> Plan {\n${body}}\n\npub const PLAN: Plan = plan()\n`
  const workingPlan = planScript(
    '  let mut plan = Plan.empty()\n'
      + '  let files = WriteFiles.empty() |> WriteFiles.literal("base.silk", StaticText.concat("pub const BASE: i32 = ", Source.text("base.txt")))\n  plan = Plan.module(plan, "generated_base", WriteFiles.result(&files, "base.silk"))\n'
      + '  plan = Plan.compileC(plan, sourcePath("native/twice.c"))\n'
      + '  plan = Plan.linkLibrary(plan, "m", Library.dynamicSearch())\n'
      + '  return plan\n',
  )
  yield* fs.writeFileString(join(planned, 'plib/build.silk'), workingPlan)
  yield* fs.writeFileString(join(planned, 'plib/base.txt'), '20\n')
  yield* fs.writeFileString(join(planned, 'plib/native/twice.c'), 'int plib_twice(int a) { return a * 2; }\n')
  yield* fs.writeFileString(
    join(planned, 'plib/Plib.silk'),
    'import generated_base\n\nunsafe extern "C" fn plib_twice(a: i32) -> i32\n\npub fn value() -> i32 {\n  return unsafe plib_twice(generated_base.BASE) + 1\n}\n',
  )
  yield* fs.writeFileString(join(planned, 'app/silk.toml'), '[package]\nname = "app"\nversion = "0.1.0"\nsource = "."\nsilk-version = "0.0.0"\n\n[dependencies]\nplib = { path = "../plib" }\n')
  yield* fs.writeFileString(join(planned, 'app/main.silk'), 'import plib.Plib\n\npub fn main() -> i32 {\n  return Plib.value()\n}\n')
  const plannedApp = join(planned, 'app')
  const planRun = Effect.fnUntraced(function* (expected: number) {
    const built = yield* invoke(silk, ['build', '--stdlib', standardLibrary], plannedApp, sourcesEnvironment)
    assert.equal(built.status, 0, built.stderr)
    const ran = yield* invoke(join(plannedApp, `build/${hostTarget}/dev/app`), [], plannedApp, sourcesEnvironment)
    assert.equal(ran.status, expected, ran.stderr)
  })
  yield* planRun(41)
  yield* fs.writeFileString(join(planned, 'plib/base.txt'), '30\n')
  yield* planRun(61)
  for (const [script, rule] of [
    ['pub const OTHER: i32 = 1\n', /plib\/build\.silk: build\.silk computes no plan: it must declare `pub const PLAN: Plan`/],
    ['pub const PLAN: string = "silk-plan 2\\n"\n', /plib\/build\.silk: build\.silk computes no plan: `PLAN` is not a plan/],
    [planScript('  return Plan.module(Plan.empty(), "../escape", sourcePath("base.txt"))\n'), /build\.silk computes no plan/],
    [planScript('  return Plan.module(Plan.empty(), "missing", WriteFiles.result(&WriteFiles.literal(WriteFiles.empty(), "source.silk", Source.text("absent.txt")), "source.silk"))\n'), /error\[SEM0176\] .*cannot embed "absent\.txt"/],
    [planScript('  return Plan.module(Plan.empty(), "Plib", sourcePath("base.txt"))\n'), /source root/],
  ] as const) {
    yield* fs.writeFileString(join(planned, 'plib/build.silk'), script)
    const refusedPlan = yield* invoke(silk, ['build', '--stdlib', standardLibrary], plannedApp, sourcesEnvironment)
    assert.equal(refusedPlan.status, 1, refusedPlan.stderr)
    assert.match(refusedPlan.stderr, rule)
  }
  const suppliedPlan = yield* fs.makeTempDirectoryScoped({ prefix: 'silk-supplied-plan-' })
  for (const name of ['silk.toml', 'main.silk', 'build.silk']) {
    yield* fs.copyFile(join(repository, 'compiler/fixtures/build-plan', name), join(suppliedPlan, name))
  }
  const suppliedSource = join(directory, 'supplied-answer.silk')
  yield* fs.writeFileString(suppliedSource, 'pub const VALUE: i32 = 42\n')
  const suppliedDefinition = (module: string, permitted: boolean, path = suppliedSource) =>
    `manifest = ${JSON.stringify(join(suppliedPlan, 'silk.toml'))}\nstdlib = ${JSON.stringify(standardLibrary)}\n`
      + '[settings]\nmodules = []\n[settings.profile]\noptimization = "none"\ndebug = false\n'
      + '[settings.native]\nsources = []\nlink = []\n[packages.self]\nexcluded = false\n'
      + `parameters = [{name = "input", module = ${JSON.stringify(module)}, supplied-path = ${permitted}, value = {type = "Text", value = ${JSON.stringify(path)}}}]\n`
  const suppliedDefinitionFile = join(suppliedPlan, 'definition.toml')
  const suppliedRequest = join(suppliedPlan, 'request.toml')
  const resolveSupplied = () => invoke(silk, ['resolve', '--definition', suppliedDefinitionFile, '--output', suppliedRequest], suppliedPlan, sourcesEnvironment)
  yield* fs.writeFileString(suppliedDefinitionFile, suppliedDefinition('build.silk', true))
  const grantedPlan = yield* resolveSupplied()
  assert.equal(grantedPlan.status, 0, grantedPlan.stderr)
  const grantedRequest = yield* fs.readFileString(suppliedRequest)
  assert.match(grantedRequest, /\bparameters = \[\]/, 'plan bindings must not leak into source profiles')
  const grantedCompilation = yield* invoke(silk, ['compile', '--request', suppliedRequest], suppliedPlan, sourcesEnvironment)
  assert.equal(grantedCompilation.status, 0, grantedCompilation.stderr)
  const grantedRun = yield* invoke(join(suppliedPlan, 'artifact'), [], suppliedPlan)
  assert.equal(grantedRun.status, 42, grantedRun.stderr)
  yield* fs.writeFileString(suppliedDefinitionFile, suppliedDefinition('build.silk', false))
  const ungrantedPlan = yield* resolveSupplied()
  assert.equal(ungrantedPlan.status, 1, ungrantedPlan.stderr)
  assert.match(ungrantedPlan.stderr, /only read host paths explicitly supplied/)
  yield* fs.writeFileString(suppliedDefinitionFile, suppliedDefinition('main.silk', true))
  const sourceGrant = yield* resolveSupplied()
  assert.equal(sourceGrant.status, 2, sourceGrant.stderr)
  assert.match(sourceGrant.stderr, /supplied host path bound only to a text parameter of build\.silk/)
  const suppliedDirectory = join(suppliedPlan, 'sdk')
  yield* fs.makeDirectory(suppliedDirectory)
  const suppliedMember = join(suppliedDirectory, 'answer.silk')
  yield* fs.copyFile(suppliedSource, suppliedMember)
  const pathPlan = (yield* fs.readFileString(join(suppliedPlan, 'build.silk')))
    .replace('pub param input:', 'import silk.core.static_text { StaticText }\npub param input:')
    .replace('suppliedPath(input)', 'suppliedPath(StaticText.concat(input, "/answer.silk"))')
  yield* fs.writeFileString(join(suppliedPlan, 'build.silk'), pathPlan)
  yield* fs.writeFileString(suppliedDefinitionFile, suppliedDefinition('build.silk', true, suppliedDirectory))
  const directoryGrant = yield* resolveSupplied()
  assert.equal(directoryGrant.status, 0, directoryGrant.stderr)
  yield* fs.remove(suppliedMember)
  yield* fs.symlink(suppliedSource, suppliedMember)
  const escapedGrant = yield* resolveSupplied()
  assert.equal(escapedGrant.status, 1, escapedGrant.stderr)
  assert.match(escapedGrant.stderr, /only read host paths explicitly supplied/)
  // A later workspace member's failed plan restores every previously published request.
  const planWorkspace = join(directory, 'plan-workspace')
  for (const name of ['first', 'second']) {
    yield* fs.makeDirectory(join(planWorkspace, name), { recursive: true })
    yield* fs.writeFileString(join(planWorkspace, name, 'silk.toml'), `[package]\nname = "${name}"\nsource = "."\nsilk-version = "0.0.0"\n`)
    yield* fs.writeFileString(join(planWorkspace, name, 'main.silk'), 'pub param answer: i32 = 42\npub fn main() -> i32 { return answer }\n')
  }
  yield* fs.writeFileString(join(planWorkspace, 'silk.toml'), '[workspace]\nmembers = ["first", "second"]\n')
  const firstPlan = yield* invoke(silk, ['plan', '--stdlib', standardLibrary], planWorkspace)
  assert.equal(firstPlan.status, 0, firstPlan.stderr)
  const planDirectory = join(planWorkspace, 'build/requests')
  const planFiles = (yield* fs.readDirectory(planDirectory)).filter((name) => name.endsWith('.toml') || name === 'plan.json')
  const publications = new Map<string, string>()
  for (const name of planFiles) publications.set(name, yield* fs.readFileString(join(planDirectory, name)))
  yield* fs.writeFileString(join(planWorkspace, 'first/main.silk'), 'pub param answer: i32 = 24\npub fn main() -> i32 { return answer }\n')
  yield* fs.writeFileString(join(planWorkspace, 'second/build.silk'), 'this is not a valid plan\n')
  const failedPlan = yield* invoke(silk, ['plan', '--stdlib', standardLibrary], planWorkspace)
  assert.notEqual(failedPlan.status, 0, failedPlan.stderr)
  for (const [name, contents] of publications) assert.equal(yield* fs.readFileString(join(planDirectory, name)), contents, `failed plan replaced ${name}`)
  // Import discovery, including imports in generated modules, is the only trigger for loading pins.
  const importsRoot = yield* fs.makeTempDirectoryScoped({ prefix: 'silk-import-discovery-' })
  for (const member of ['app', 'library', 'leaf']) yield* fs.makeDirectory(join(importsRoot, member))
  yield* fs.writeFileString(join(importsRoot, 'app/silk.toml'),
    '[package]\nname="imports-app"\nsource="."\nsilk-version = "0.0.0"\n[dependencies]\nlib={path="../library"}\nunused={path="../missing"}\n')
  yield* fs.writeFileString(join(importsRoot, 'app/main.silk'), 'import lib.Value\npub fn main() -> i32 { return Value.VALUE }\n')
  yield* fs.writeFileString(join(importsRoot, 'library/silk.toml'),
    '[package]\nname="imports-library"\nsource="."\nkind="library"\nexports=["Value"]\nsilk-version = "0.0.0"\n[dependencies]\nleaf={path="../leaf"}\n'
      + 'unused={git="https://github.com/silk-lang/unreachable-test-dependency.git",rev="1111111111111111111111111111111111111111"}\n')
  yield* fs.writeFileString(join(importsRoot, 'library/Value.silk'), 'import generated\npub const VALUE: i32 = generated.VALUE\n')
  yield* fs.writeFileString(join(importsRoot, 'library/build.silk'), [
    'import silk.build.plan { Plan }', 'import silk.build.write_files { WriteFiles }',
    'static fn plan() -> Plan {',
    '  let files = WriteFiles.empty() |> WriteFiles.literal("value.silk", "import leaf.Value\\npub const VALUE: i32 = Value.VALUE\\n")',
    '  return Plan.module(Plan.empty(), "generated", WriteFiles.result(&files, "value.silk"))',
    '}', 'pub const PLAN: Plan = plan()', '',
  ].join('\n'))
  yield* fs.writeFileString(join(importsRoot, 'leaf/silk.toml'),
    '[package]\nname="imports-leaf"\nsource="."\nkind="library"\nexports=["Value"]\nsilk-version = "0.0.0"\n')
  yield* fs.writeFileString(join(importsRoot, 'leaf/Value.silk'), 'pub const VALUE: i32 = 42\n')
  const importsEnvironment = { ...sourcesEnvironment, SILK_OFFLINE: '1' }
  const importsBuilt = yield* invoke(silk, ['build', '--stdlib', standardLibrary], join(importsRoot, 'app'), importsEnvironment)
  assert.equal(importsBuilt.status, 0, importsBuilt.stderr)
  const importsRan = yield* invoke(join(importsRoot, `app/build/${hostTarget}/dev/imports-app`), [], importsRoot)
  assert.equal(importsRan.status, 42, importsRan.stderr)
  const importsDocumented = yield* invoke(silk,
    ['doc', '--stdlib-root', standardLibrary, '--output', join(importsRoot, 'app.docs.json')],
    join(importsRoot, 'app'), importsEnvironment)
  assert.equal(importsDocumented.status, 0, importsDocumented.stdout + importsDocumented.stderr)
  assert.ok(yield* fs.exists(join(importsRoot, 'app.docs.json')), 'documentation uses plans and transitive generated imports')
  const importsRequests = join(importsRoot, 'app/build/requests')
  const importsRequestName = (yield* fs.readDirectory(importsRequests)).find((name) => name.endsWith('.toml'))
  assert.ok(importsRequestName)
  const importsRequest = yield* fs.readFileString(join(importsRequests, importsRequestName))
  assert.ok(importsRequest.includes('imports-leaf') && !importsRequest.includes('unused'), 'only imported pins enter requests')
  // Explicit fetch visits unused pins, even though compiling the selected imports left them alone.
  const fetchAll = yield* invoke(silk, ['fetch'], join(importsRoot, 'app'), importsEnvironment)
  assert.notEqual(fetchAll.status, 0, 'fetch omitted an unused unreachable pin')
  assert.match(fetchAll.stderr, /unused|offline|unreachable/)

  yield* fs.writeFileString(join(importsRoot, 'leaf/silk.toml'),
    (yield* fs.readFileString(join(importsRoot, 'leaf/silk.toml'))) + '[dependencies]\ncycle={path="../app"}\n')
  yield* fs.writeFileString(join(importsRoot, 'leaf/Value.silk'), 'import cycle.main\npub const VALUE: i32 = cycle.VALUE\n')
  const lazyCycle = yield* invoke(silk, ['build', '--stdlib', standardLibrary], join(importsRoot, 'app'), importsEnvironment)
  assert.equal(lazyCycle.status, 2, lazyCycle.stderr)
  assert.match(lazyCycle.stderr, /form a cycle/)
  // A plan's tool step runs a program of the package that writes declared outputs, and a module can
  // be served from one. A dependency's steps run only when the root grants tools on its dependency entry. On
  // Linux 6.7 or newer the step runs under Landlock, which refuses writes outside its output
  // directory, reads outside its inputs and the system, and TCP. An unchanged rerun does not run
  // it; a host without a sandbox always refuses it.
  const sandboxProbe = yield* invoke(silk, ['sandbox-exec', '--read', '/usr', '--read', '/bin',
    '--read', '/lib', '--read', '/lib64', '--', '/bin/true'], directory)
  const landlockNet = sandboxProbe.status === 0
  const sandboxRoot = yield* fs.makeTempDirectoryScoped({ prefix: 'silk-graph-sandbox-' })
  const sandboxProgram = join(directory, 'graph-sandbox-test')
  const sandboxBuilt = yield* invoke(silk, ['build', join(repository, 'compiler/fixtures/build-graph/sandbox.silk'),
    '-o', sandboxProgram, '--stdlib', standardLibrary, '--clang', clang], directory, process.env, 120_000)
  assert.equal(sandboxBuilt.status, 0, sandboxBuilt.stderr)
  const sandboxRan = yield* invoke(sandboxProgram, [], sandboxRoot, { ...process.env, SILK_COMPILER: silk })
  if (landlockNet) assert.equal(sandboxRan.status, 0, sandboxRan.stderr)
  else {
    assert.notEqual(sandboxRan.status, 0, 'confinement must fail closed on a host without a sandbox')
    assert.equal(yield* fs.exists(join(sandboxRoot, 'forbidden')), false)
  }
  const tooled = yield* fs.makeTempDirectoryScoped({ prefix: 'silk-build-tool-' })
  for (const member of ['tlib/tools', 'app']) yield* fs.makeDirectory(join(tooled, member), { recursive: true })
  yield* fs.writeFileString(
    join(tooled, 'tlib/silk.toml'),
    '[package]\nname = "tlib"\nversion = "0.1.0"\nkind = "library"\nsource = "."\nexports = ["Tlib"]\nsilk-version = "0.0.0"\n',
  )
  yield* fs.writeFileString(
    join(tooled, 'tlib/build.silk'),
    planScript(
      '  let generator = Run.command("tools/gen.sh")\n'
        + '    |> Run.input(sourcePath("base.txt"))\n'
        + '    |> Run.output("generated.silk")\n'
        + '  return Plan.module(Plan.empty(), "generated_base", Run.result(&generator, "generated.silk"))\n',
    ),
  )
  const toolScript = (extra: string) =>
    `#!/bin/sh\n${extra}printf 'pub const BASE: i32 = %s\\n' "$(cat "$1")" > "$2"\n`
  const writeTool = (extra: string) =>
    fs.writeFileString(join(tooled, 'tlib/tools/gen.sh'), toolScript(extra)).pipe(Effect.andThen(fs.chmod(join(tooled, 'tlib/tools/gen.sh'), 0o755)))
  yield* writeTool('')
  yield* fs.writeFileString(join(tooled, 'tlib/base.txt'), '20')
  yield* fs.writeFileString(join(tooled, 'tlib/Tlib.silk'), 'import generated_base\n\npub fn value() -> i32 {\n  return generated_base.BASE + 1\n}\n')
  const toolApp = join(tooled, 'app')
  const toolManifest = (authorized: boolean, extra = '') =>
    `[package]\nname = "app"\nversion = "0.1.0"\nsource = "."\nsilk-version = "0.0.0"\n\n[dependencies]\ntlib = { path = "../tlib", tools = ${authorized} }\n${extra}`
  yield* fs.writeFileString(join(toolApp, 'silk.toml'), toolManifest(false))
  yield* fs.writeFileString(join(toolApp, 'main.silk'), 'import tlib.Tlib\n\npub fn main() -> i32 {\n  return Tlib.value()\n}\n')
  const stepBuild = (environment: Record<string, string> = {}) =>
    invoke(silk, ['build', '--stdlib', standardLibrary], toolApp, { ...sourcesEnvironment, ...environment })
  const unlisted = yield* stepBuild()
  assert.equal(unlisted.status, 1, unlisted.stderr)
  assert.match(unlisted.stderr, /tlib\/build\.silk: build\.silk computes no plan: this dependency runs a package tool without permission; add `tools = true`/)
  yield* fs.writeFileString(join(toolApp, 'silk.toml'), toolManifest(true))
  const generatedStamp = Effect.fnUntraced(function* () {
    const cache = join(toolApp, 'build/steps')
    const entries = (yield* fs.readDirectory(cache)).filter((name) => /^[0-9a-f]{64}$/.test(name)).sort()
    const outputs: string[] = []
    for (const entry of entries) {
      const file = join(cache, entry, 'generated.silk')
      if (yield* fs.exists(file)) outputs.push(`${entry}:${yield* fs.readFileString(file)}`)
    }
    return outputs
  })
  const toolRun = Effect.fnUntraced(function* (expected: number, environment: Record<string, string> = {}) {
    const built = yield* stepBuild(environment)
    assert.equal(built.status, 0, built.stderr)
    const ran = yield* invoke(join(toolApp, `build/${hostTarget}/dev/app`), [], toolApp, sourcesEnvironment)
    assert.equal(ran.status, expected, ran.stderr)
    return built.stderr
  })
  if (landlockNet) {
    yield* toolRun(21)
    const firstGenerated = yield* generatedStamp()
    yield* toolRun(21)
    assert.deepEqual(yield* generatedStamp(), firstGenerated, 'an unchanged rerun ran the tool again')
    yield* fs.writeFileString(join(tooled, 'tlib/base.txt'), '30')
    yield* toolRun(31)
    assert.notDeepEqual(yield* generatedStamp(), firstGenerated, 'an edited input did not run the tool again')
    for (const [extra, rule] of [
      ['echo pwned > "$(dirname "$1")/pwned" || exit 3\n', /build process failed with status 3:.*pwned: Permission denied/],
      ['cat "$(dirname "$1")/silk.toml" > /dev/null || exit 4\n', /build process failed with status 4/],
      ['python3 -I -c "import socket; socket.create_connection((\'127.0.0.1\', 9), timeout=3)" 2>&1 | grep -q PermissionError && exit 5\n', /build process failed with status 5/],
    ] as const) {
      yield* writeTool(extra)
      const escapedTool = yield* stepBuild()
      assert.equal(escapedTool.status, 1, escapedTool.stderr)
      assert.match(escapedTool.stderr, rule)
    }
    assert.equal(existsSync(join(tooled, 'tlib/pwned')), false, 'a sandboxed tool wrote outside its output directory')
    yield* writeTool('exit 0\n')
    const silent = yield* stepBuild()
    assert.equal(silent.status, 1, silent.stderr)
    assert.match(silent.stderr, /did not write its declared output generated\.silk/)
    yield* writeTool('')
  }
  const unsandboxedHost = yield* stepBuild({ SILK_NO_TOOL_SANDBOX: '1' })
  assert.equal(unsandboxedHost.status, 1, unsandboxedHost.stderr)
  assert.match(unsandboxedHost.stderr, /package tools require a supported operating-system sandbox/)
  yield* fs.writeFileString(join(toolApp, 'silk.toml'), toolManifest(true, '\n[build]\nunsandboxed-tools = true\n'))
  const deniedEscape = yield* stepBuild({ SILK_NO_TOOL_SANDBOX: '1' })
  assert.notEqual(deniedEscape.status, 0, 'a manifest must never disable build-tool confinement')
  yield* fs.writeFileString(join(toolApp, 'silk.toml'), toolManifest(true))
  const allowedEscape = yield* invoke(silk, ['build', '--stdlib', standardLibrary, '--unsandboxed-tools'], toolApp,
    { ...sourcesEnvironment, SILK_NO_TOOL_SANDBOX: '1' })
  assert.equal(allowedEscape.status, 0, allowedEscape.stderr)
  const confinedAgain = yield* stepBuild({ SILK_NO_TOOL_SANDBOX: '1' })
  assert.equal(confinedAgain.status, 1, confinedAgain.stderr)
  yield* fs.writeFileString(join(toolApp, 'silk.toml'), toolManifest(false))
  const unauthorizedEscape = yield* invoke(silk, ['build', '--stdlib', standardLibrary, '--unsandboxed-tools'], toolApp,
    { ...sourcesEnvironment, SILK_NO_TOOL_SANDBOX: '1' })
  assert.equal(unauthorizedEscape.status, 1, unauthorizedEscape.stderr)
  assert.match(unauthorizedEscape.stderr, /this dependency runs a package tool without permission; add `tools = true`/)
  // A plan's function-order input places the functions it lists first in the executable's code, in its
  // order, and a change to the file alone links again. A path outside the package is refused.
  const ordered = yield* fs.makeTempDirectoryScoped({ prefix: 'silk-ordered-' })
  yield* fs.writeFileString(join(ordered, 'silk.toml'),
    '[package]\nname = "ordered"\nversion = "0.1.0"\nsource = "."\nsilk-version = "0.0.0"\n')
  yield* fs.writeFileString(
    join(ordered, 'main.silk'),
    'fn twice(value: i32) -> i32 {\n  return value * 2\n}\n\npub fn main() -> i32 {\n  return twice(0)\n}\n',
  )
  yield* writePlan(ordered, '  plan = Plan.functionOrder(plan, sourcePath("/tmp/order.txt"))')
  const escapedOrder = yield* invoke(silk, ['build', '--stdlib', standardLibrary], ordered, { ...process.env, SILK_CLANG: clang })
  assert.equal(escapedOrder.status, 1, escapedOrder.stderr)
  assert.match(escapedOrder.stderr, /build\.silk computes no plan:/)
  // The linked executable's Silk functions by the name its symbol table gives them, with their
  // addresses: a declaration as an order file lists it (`ElfNames`), or a runtime `silk_` symbol.
  const functionAddresses = Effect.fnUntraced(function* (executable: string) {
    const listed = yield* invoke(join(dirname(clang), 'llvm-nm'), ['--defined-only', executable], ordered)
    assert.equal(listed.status, 0, listed.stderr)
    const functions: Array<[string, bigint]> = []
    for (const line of listed.stdout.split('\n')) {
      const symbol = /^([0-9a-f]+) [tT] _?(\S+)$/.exec(line)
      if (symbol && (symbol[2].includes('::') || symbol[2].startsWith('silk_'))) functions.push([symbol[2], BigInt(`0x${symbol[1]}`)])
    }
    return functions
  })
  for (const profile of [[], ['--release']]) {
    const executable = join(ordered, `build/${hostTarget}/${profile.length === 0 ? 'dev' : 'release'}/ordered`)
    const orderedBuild = Effect.fnUntraced(function* () {
      const built = yield* invoke(silk, ['build', '--stdlib', standardLibrary, ...profile], ordered, { ...process.env, SILK_CLANG: clang })
      assert.equal(built.status, 0, built.stderr)
      return yield* functionAddresses(executable)
    })
    yield* writePlan(ordered, '')
    const unordered = [...(yield* orderedBuild())].sort((left, right) => (left[1] < right[1] ? -1 : 1))
    // The symbol map's rows, and its declarations as the symbol table names them: without the
    // package's version.
    const symbolMap = (yield* fs.readFileString(`${executable}.symbols`)).split('\n').map((line) => line.split('\t'))
    const named = (declaration: string) => declaration.replace(/^([^@:]*)@[^:]*:/, '$1:')
    const symbolsOf = (name: string) => symbolMap.filter((row) => row.length === 3 && named(row[2]) === name).map((row) => row[0])
    // A function the symbol table names once and the map gives one symbol, so its symbol orders it alone.
    const single = unordered.filter(([name]) =>
      unordered.filter(([other]) => other === name).length === 1 && symbolsOf(name).length === 1)
    assert.ok(single.length > 2, `${profile}: too few Silk functions to order`)
    const placedFirst = (functions: Array<[string, bigint]>, first: string, second: string) => {
      const firstAddress = functions.find(([name]) => name === first)?.[1] ?? 0n
      const secondAddress = functions.find(([name]) => name === second)?.[1] ?? 0n
      assert.ok(firstAddress < secondAddress, `${profile}: ${first} is not placed before ${second}`)
      for (const [name, address] of functions) {
        if (name !== first && name !== second) assert.ok(secondAddress < address, `${profile}: ${name} is placed before the listed functions`)
      }
    }
    // The two such functions linked last, listed in reverse by symbol.
    const last = single[single.length - 1][0]
    const beforeLast = single[single.length - 2][0]
    yield* fs.writeFileString(join(ordered, 'order.txt'), `# startup\n\n  ${symbolsOf(last)[0]}  \n${symbolsOf(beforeLast)[0]}\n`)
    yield* writePlan(ordered, '  plan = Plan.functionOrder(plan, sourcePath("order.txt"))')
    placedFirst(yield* orderedBuild(), last, beforeLast)
    yield* fs.writeFileString(join(ordered, 'order.txt'), `${symbolsOf(beforeLast)[0]}\n${symbolsOf(last)[0]}\n`)
    placedFirst(yield* orderedBuild(), beforeLast, last)
    // A declaration as the symbol table names it orders every symbol of that declaration; an entry
    // that names nothing this build emits is reported as a note. Runtime entries such as
    // `silk_gnu_initialize` keep their symbol and have no declaration.
    const latest = [...unordered].reverse().find(([name]) => name.includes('::'))
    assert.ok(latest !== undefined, `${profile}: no linked function is named by its declaration`)
    const declaration = latest[0]
    yield* fs.writeFileString(join(ordered, 'order.txt'), `${declaration}\nsilk_00000000000000000000000000000000\n`)
    const byDeclaration = yield* invoke(silk, ['build', '--stdlib', standardLibrary, ...profile], ordered, { ...process.env, SILK_CLANG: clang })
    assert.equal(byDeclaration.status, 0, byDeclaration.stderr)
    assert.match(byDeclaration.stderr, /silk: note: 1 of 2 entries in .*order\.txt name no function of this build/)
    const declaredAddresses = yield* functionAddresses(executable)
    let latestDeclared = 0n
    for (const [name, address] of declaredAddresses) if (name === declaration && address > latestDeclared) latestDeclared = address
    for (const [name, address] of declaredAddresses) {
      if (name !== declaration) assert.ok(latestDeclared < address, `${profile}: ${name} is placed before ${declaration}`)
    }
  }
  // Each profile keeps its own cache file, and a file per profile names it, so the next build in
  // either profile prefetches its own file rather than none.
  const orderedCache = compilerCache(join(ordered, 'build/cache/ordered'))
  const orderedEntries = yield* fs.readDirectory(orderedCache)
  const profileImages = orderedEntries.filter((name) => /^semantic-[0-9a-f]{32}$/.test(name)).sort()
  assert.equal(profileImages.length, 2, `expected a cache file per profile, found ${profileImages.join(', ')}`)
  const choices = orderedEntries.filter((name) => /^profile-[0-9a-f]{32}$/.test(name))
  assert.equal(choices.length, 2, `expected a profile record per profile, found ${choices.join(', ')}`)
  const chosen: Array<string> = []
  for (const choice of choices) chosen.push(yield* fs.readFileString(join(orderedCache, choice)))
  assert.deepEqual(chosen.sort(), profileImages, 'each profile record names its own cache file')
  for (const selection of [['--root', 'main.silk'], ['--file', 'src/util/check.txt']]) {
    const refusedTests = yield* invoke(
      silk,
      ['test', '--stdlib', standardLibrary, ...selection],
      join(directory, 'tested'),
      { ...process.env, SILK_CLANG: sentinel },
    )
    assert.equal(refusedTests.status, 2, `test accepted ${selection.join(' ')}`)
  }
  assert.equal(yield* fs.exists(marker), false)
  const repeated = yield* invoke(silk, ['init', 'greeting', '-t', 'minimal'], directory)
  assert.equal(repeated.status, 2, 'init must refuse an existing manifest')
  // A project `build` names its manifest instead of discovering one, and `--release` selects the
  // release output directory; `run` refuses a foreign target before building anything.
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
  // Each compilation names its artifact relative to the working directory, not the project, the
  // base tasks file's build too; standard output stays empty.
  assert.equal(released.stdout, '')
  assert.match(released.stderr, new RegExp(`^Compiling greeting \\(${hostTarget}, release\\)\n`, 'm'))
  assert.match(released.stderr, /^  codegen   [1-9][0-9,]* functions/m)
  assert.match(
    released.stderr,
    new RegExp(`^Finished greeting/build/${hostTarget}/release/greeting in [0-9.ms ]+s\n$`, 'm'),
  )
  assert.equal(
    yield* fs.exists(join(directory, 'greeting/build', hostTarget, 'release/greeting')),
    true,
  )
  const foreignRun = yield* invoke(
    silk,
    ['run', '--manifest-path', manifest, '--target', foreign, '--stdlib', standardLibrary],
    directory,
    { ...process.env, SILK_CLANG: clang },
  )
  // The tasks program may build first, with the real Clang; the program itself is not built.
  assert.equal(foreignRun.status, 2, 'run must refuse a foreign target')
  assert.equal(yield* fs.exists(join(directory, 'greeting/build', foreign, 'dev/greeting')), false)
  // A multi-threaded wasm32 request links one shared memory the host imports, with the request's
  // maximum, and runs its native threads as Workers under the stdlib's Node runner.
  const threads = join(directory, 'threads')
  yield* fs.makeDirectory(threads, { recursive: true })
  yield* fs.writeFileString(
    join(threads, 'silk.toml'),
    '[package]\nname = "threads"\nversion = "0.0.0"\nsilk-version = "0.0.0"\nsource = "."\n',
  )
  yield* fs.writeFileString(
    join(threads, 'main.silk'),
    [
      'import silk.mem.allocator { Allocator, OutOfMemoryError }',
      'import silk.mem.box { Box }',
      'import silk.core.effect { Effect }',
      'import silk.concurrency.thread_native { NativeThread, SpawnError }',
      'effect fn program() -> i32 ! OutOfMemoryError | SpawnError {',
      '  let mut allocator = Allocator.systemAllocatorProvider()',
      '  let owned = run Box<i32>.make(20) |> Effect.provideMut<Allocator>(&mut allocator)',
      '  let first = run NativeThread.spawn(|| -> i32 { return (move owned).into() + 1 })',
      '    |> Effect.provideMut<Allocator>(&mut allocator)',
      '  let second = run NativeThread.spawn(|| -> i32 { return 21 })',
      '    |> Effect.provideMut<Allocator>(&mut allocator)',
      '  return first.join() + second.join()',
      '}',
      'effect fn recover(error: OutOfMemoryError | SpawnError) -> i32 { return -2 }',
      'pub fn main() -> i32 { return run Effect.catchAll(program(), recover) }',
      '',
    ].join('\n'),
  )
  const threaded = yield* compileSettings(threads, 'threads', '[settings.profile]\ntarget = "wasm32-unknown-unknown"\nthreading = "multi"\nmax-memory = 268435456\n')

  assert.equal(threaded.status, 0, threaded.stderr)
  // A Clang older than 22 misreads the bitcode Silk writes, so it is refused.
  const eighteen = join(directory, 'clang-18')
  yield* fs.writeFileString(
    eighteen,
    `#!/bin/sh\nif [ "$1" = --version ]; then echo 'Ubuntu clang version 18.1.3 (1ubuntu1)'; exit 0; fi\nexec ${quote(clang)} "$@"\n`,
  )
  yield* fs.chmod(eighteen, 0o755)
  const tooOld = yield* compileSettings(threads, 'old-clang', '[settings.profile]\ntarget = "wasm32-unknown-unknown"\nthreading = "multi"\nmax-memory = 268435456\n', { ...process.env, SILK_CLANG: eighteen })

  assert.equal(tooOld.status, 2, tooOld.stderr)
  assert.match(
    tooOld.stderr,
    /^silk: Silk builds need Clang 22 or newer, but \S+clang-18 \(from SILK_CLANG\) is Clang 18; set SILK_CLANG or pass --clang the path of a newer Clang$/m,
  )
  // A --clang wrapper that runs $SILK_CLANG sees it, so its version probe answers with that Clang
  // (#3150).
  const wrapper = join(directory, 'clang-wrapper')
  yield* fs.writeFileString(wrapper, '#!/bin/sh\nexec "$SILK_CLANG" "$@"\n')
  yield* fs.chmod(wrapper, 0o755)
  const wrapped = yield* invoke(
    silk,
    ['build', '--manifest-path', manifest, '--stdlib', standardLibrary, '--clang', wrapper],
    directory,
    { ...process.env, SILK_CLANG: eighteen },
  )
  assert.equal(wrapped.status, 2, wrapped.stderr)
  assert.match(
    wrapped.stderr,
    /^silk: Silk builds need Clang 22 or newer, but \S+clang-wrapper \(from --clang\) is Clang 18; set SILK_CLANG or pass --clang the path of a newer Clang$/m,
  )
  // Clang 22 miscompiles AVX-512 mask code (llvm/llvm-project#198220), so a request with avx512vl
  // and avx512dq needs Clang 23.
  const twentyTwo = join(directory, 'clang-22')
  yield* fs.writeFileString(
    twentyTwo,
    `#!/bin/sh\nif [ "$1" = --version ]; then echo 'clang version 22.1.8'; exit 0; fi\nexec ${quote(clang)} "$@"\n`,
  )
  yield* fs.chmod(twentyTwo, 0o755)
  const masks = join(directory, 'masks')
  yield* fs.makeDirectory(masks, { recursive: true })
  yield* fs.writeFileString(
    join(masks, 'silk.toml'),
    '[package]\nname = "masks"\nversion = "0.0.0"\nsilk-version = "0.0.0"\nsource = "."\n',
  )
  yield* fs.writeFileString(join(masks, 'main.silk'), 'pub fn main() -> i32 { return 0 }\n')
  const maskRefused = yield* compileSettings(masks, 'avx', '[settings.profile]\ntarget = "x86_64-unknown-linux-gnu"\ncpu-features = ["avx512vl", "avx512dq"]\n', { ...process.env, SILK_CLANG: twentyTwo })

  assert.equal(maskRefused.status, 2, maskRefused.stderr)
  assert.match(
    maskRefused.stderr,
    /^silk: builds with avx512vl and avx512dq or avx512bw need Clang 23 or newer, but \S+clang-22 \(from SILK_CLANG\) is Clang 22; set SILK_CLANG or pass --clang the path of a newer Clang$/m,
  )
  const threadedPath = compilationPath(threads, 'threads')
  const threadedModule = new WebAssembly.Module(yield* fs.readFile(threadedPath))
  assert.deepEqual(
    WebAssembly.Module.imports(threadedModule)
      .map((entry) => `${entry.module}.${entry.name}`)
      .sort(),
    ['env.memory', 'wasi.thread-spawn'],
  )
  const threadedRun = yield* invoke(
    process.execPath,
    [join(standardLibrary, 'host/wasm-runner.mjs'), threadedPath],
    directory,
    process.env,
  )
  assert.equal(threadedRun.status, 42, threadedRun.stderr)
  // The direct backend links the same shared memory itself, and its threads run the same.
  const direct = yield* compileSettings(threads, 'direct', '[settings.profile]\ntarget = "wasm32-unknown-unknown"\nthreading = "multi"\nmax-memory = 268435456\nbackend = "direct"\n', { ...process.env, SILK_CLANG: '/nonexistent' })

  assert.equal(direct.status, 0, direct.stderr)
  // Each backend keeps its own output directory.
  const directPath = compilationPath(threads, 'direct')
  const directModule = new WebAssembly.Module(yield* fs.readFile(directPath))
  assert.deepEqual(
    WebAssembly.Module.imports(directModule)
      .map((entry) => `${entry.module}.${entry.name}`)
      .sort(),
    ['env.memory', 'wasi.thread-spawn'],
  )
  const directRun = yield* invoke(
    process.execPath,
    [join(standardLibrary, 'host/wasm-runner.mjs'), directPath],
    directory,
    process.env,
  )
  assert.equal(directRun.status, 42, directRun.stderr)
  // The direct backend writes only wasm modules, and a host build with it says so.
  const directHost = yield* invoke(
    silk,
    ['build', '--manifest-path', join('threads', 'silk.toml'), '--backend', 'direct', '--stdlib', standardLibrary],
    directory,
    process.env,
  )
  assert.equal(directHost.status, 1, directHost.stderr)
  assert.match(
    directHost.stderr,
    /^silk: invalid compilation settings: UnsupportedCombination: backend = "direct" builds WebAssembly targets only; choose a wasm target, such as wasm32-wasip1, or backend = "llvm"$/m,
  )
  // Freed memory is reused: 100 threads with 1 MiB stacks and repeated list growth fit in 64 MiB.
  const churn = join(directory, 'churn')
  yield* fs.makeDirectory(churn, { recursive: true })
  yield* fs.writeFileString(
    join(churn, 'silk.toml'),
    '[package]\nname = "churn"\nversion = "0.0.0"\nsilk-version = "0.0.0"\nsource = "."\n',
  )
  yield* fs.writeFileString(
    join(churn, 'main.silk'),
    [
      'import silk.mem.allocator { Allocator, OutOfMemoryError }',
      'import silk.core.effect { Effect }',
      'import silk.collections.list { List }',
      'import silk.concurrency.thread_native { NativeThread, SpawnError }',
      'effect fn fill(count: i32) -> i32 ! OutOfMemoryError ? &mut Allocator {',
      '  let mut values = List<i32>.make()',
      '  let mut at: i32 = 0',
      '  while at < count {',
      '    run List<i32>.append(&mut values, at)',
      '    at = at + 1',
      '  }',
      '  return at',
      '}',
      'effect fn refused(error: OutOfMemoryError) -> i32 { return 0 }',
      'fn work() -> i32 {',
      '  let mut local = Allocator.systemAllocatorProvider()',
      '  return run Effect.catchAll(fill(1000) |> Effect.provideMut<Allocator>(&mut local), refused)',
      '}',
      'effect fn program() -> i32 ! OutOfMemoryError | SpawnError {',
      '  let mut allocator = Allocator.systemAllocatorProvider()',
      '  let mut round: i32 = 0',
      '  while round < 100 {',
      '    let filled = run fill(10000) |> Effect.provideMut<Allocator>(&mut allocator)',
      '    if filled != 10000 { return 1 }',
      '    let worker = run NativeThread.spawn(|| -> i32 { return work() })',
      '      |> Effect.provideMut<Allocator>(&mut allocator)',
      '    if worker.join() != 1000 { return 2 }',
      '    round = round + 1',
      '  }',
      '  return 42',
      '}',
      'effect fn recover(error: OutOfMemoryError | SpawnError) -> i32 { return 3 }',
      'pub fn main() -> i32 { return run Effect.catchAll(program(), recover) }',
      '',
    ].join('\n'),
  )
  const churned = yield* compileSettings(churn, 'churn', '[settings.profile]\ntarget = "wasm32-unknown-unknown"\nthreading = "multi"\nmax-memory = 67108864\n')

  assert.equal(churned.status, 0, churned.stderr)
  const churnRun = yield* invoke(
    process.execPath,
    [
      join(standardLibrary, 'host/wasm-runner.mjs'),
      compilationPath(churn, 'churn'),
    ],
    directory,
    process.env,
  )
  assert.equal(churnRun.status, 42, churnRun.stderr)
  // Arena allocations are adopted storage with their own reclaim function, which wasm32 places at
  // table index 1: dropping two of them must reach that function, not `free` the chunk twice.
  const arena = join(directory, 'arena')
  yield* fs.makeDirectory(arena, { recursive: true })
  yield* fs.writeFileString(
    join(arena, 'silk.toml'),
    '[package]\nname = "arena"\nversion = "0.0.0"\nsilk-version = "0.0.0"\nsource = "."\n',
  )
  yield* fs.writeFileString(
    join(arena, 'main.silk'),
    [
      'import silk.mem.allocator { Allocator, OutOfMemoryError }',
      'import silk.mem.arena { Arena }',
      'import silk.mem.box { Box }',
      'import silk.core.effect { Effect }',
      'effect fn program() -> i32 ! OutOfMemoryError {',
      '  let mut arena = Arena.make(Allocator.systemAllocatorProvider())',
      '  let first = run Box<i32>.make(40) |> Effect.provideMut<Allocator>(&mut arena)',
      '  let second = run Box<i32>.make(2) |> Effect.provideMut<Allocator>(&mut arena)',
      '  let sum = Box<i32>.get(&first)[0] + Box<i32>.get(&second)[0]',
      '  drop first',
      '  drop second',
      '  drop arena',
      '  return sum',
      '}',
      'effect fn recover(error: OutOfMemoryError) -> i32 { return 3 }',
      'pub fn main() -> i32 { return run Effect.catchAll(program(), recover) }',
      '',
    ].join('\n'),
  )
  const arenaBuild = yield* compileSettings(arena, 'arena', '[settings.profile]\ntarget = "wasm32-unknown-unknown"\n')

  assert.equal(arenaBuild.status, 0, arenaBuild.stderr)
  const arenaRun = yield* invoke(
    process.execPath,
    [
      join(standardLibrary, 'host/wasm-runner.mjs'),
      compilationPath(arena, 'arena'),
    ],
    directory,
    process.env,
  )
  assert.equal(arenaRun.status, 42, arenaRun.stderr)
  // The same program in a 64-bit memory, through LLVM and through the direct backend without
  // Clang, runs the same.
  yield* fs.writeFileString(
    join(arena, 'silk.toml'),
    '[package]\nname = "arena"\nversion = "0.0.0"\nsilk-version = "0.0.0"\nsource = "."\n',
  )
  for (const backend of ['llvm', 'direct']) {
    const wideBuild = yield* compileSettings(arena, `wide-${backend}`,
      `[settings.profile]\ntarget = "wasm64-unknown-unknown"\nbackend = "${backend}"\n`,
      { ...process.env, SILK_CLANG: backend === 'llvm' ? clang : '/nonexistent' })
    assert.equal(wideBuild.status, 0, wideBuild.stderr)
    const wideRun = yield* invoke(
      process.execPath,
      [join(standardLibrary, 'host/wasm-runner.mjs'), compilationPath(arena, `wide-${backend}`)],
      directory,
      process.env,
    )
    assert.equal(wideRun.status, 42, `${backend}: ${wideRun.stderr}`)
  }
  // A request's CPU features, large code model and static link reach Clang.
  const argumentLog = join(directory, 'clang-arguments')
  const recorder = join(directory, 'clang-recorder')
  yield* fs.writeFileString(
    recorder,
    `#!/bin/sh\nprintf '%s\\n' "$@" >> ${quote(argumentLog)}\nexec ${quote(clang)} "$@"\n`,
  )
  yield* fs.chmod(recorder, 0o755)
  const x86 = hostTarget.startsWith('x86_64-')
  const tuned = join(directory, 'tuned')
  yield* fs.makeDirectory(join(tuned, 'src'), { recursive: true })
  // The request's AVX passes an exported 256-bit vector in one register, which the default
  // compilation refuses at `silk check` (SEM0244).
  const tunedMain = 'pub fn main() -> i32 {\n  return 0\n}\n'
  const wideExport = x86
    ? 'export "C" fn silk_tuned_wide(values: simd<f32, 8>) -> simd<f32, 8> { return values }\n\n'
    : ''
  yield* fs.writeFileString(join(tuned, 'src/main.silk'), `${wideExport}${tunedMain}`)
  const tunedHeader = '[package]\nname = "tuned"\nversion = "0.1.0"\nmain = "main.silk"\nsilk-version = "0.0.0"\n'
  yield* fs.writeFileString(join(tuned, 'silk.toml'), tunedHeader)
  const tunedBuild = yield* compileSettings(tuned, 'tuned',
    `[settings.profile]\ntarget = "${hostTarget}"\ncpu-features = ["${x86 ? 'avx2' : 'crc'}"]\n${
      x86 ? 'code-model = "large"\n' : ''
    }${process.platform === 'darwin' ? '' : 'link = "static"\n'}`,
    { ...process.env, SILK_CLANG: recorder })
  assert.equal(tunedBuild.status, 0, tunedBuild.stderr)
  const recorded = (yield* fs.readFileString(argumentLog)).split('\n')
  assert.ok(recorded.includes(x86 ? '+avx2' : '+crc'), recorded.join(' '))
  assert.equal(recorded.includes('-mcmodel=large'), x86, recorded.join(' '))
  assert.equal(recorded.includes('-static'), process.platform !== 'darwin', recorded.join(' '))
  // A Linux executable's default relocation is static, so it links without PIE.
  assert.equal(recorded.includes('-no-pie'), process.platform === 'linux', recorded.join(' '))
  const tunedRun = yield* invoke(
    compilationPath(tuned, 'tuned'),
    [],
    tuned,
  )
  assert.equal(tunedRun.status, 0, tunedRun.stderr)
  if (x86) {
    const untuned = yield* invoke(silk, ['check', '--stdlib', standardLibrary], tuned)
    assert.equal(untuned.status, 1, untuned.stderr)
    assert.match(
      untuned.stderr,
      /main\.silk:1:39: error\[SEM0244\] simd<f32, 8> crosses the C boundary in one vector register, which needs the CPU feature `avx`/,
    )
  }
  yield* fs.writeFileString(join(tuned, 'src/main.silk'), tunedMain)
  if (process.platform === 'linux') {
    // A dynamically linked Linux executable loads at a fixed address by default, and as a PIE when
    // its request sets `relocation = "pic"`.
    const relocations = [
      ['fixed', '', true],
      ['movable', 'relocation = "pic"\n', false],
    ] as const
    for (const [name, field, fixed] of relocations) {
      yield* fs.writeFileString(argumentLog, '')
      const relocated = yield* compileSettings(tuned, name,
        `[settings.profile]\ntarget = "${hostTarget}"\n${field}`,
        { ...process.env, SILK_CLANG: recorder })
      assert.equal(relocated.status, 0, relocated.stderr)
      const relocatedArguments = (yield* fs.readFileString(argumentLog)).split('\n')
      assert.equal(relocatedArguments.includes('-fno-pic'), fixed, relocatedArguments.join(' '))
      assert.equal(relocatedArguments.includes('-no-pie'), fixed, relocatedArguments.join(' '))
      assert.ok(!relocatedArguments.includes('-static'), relocatedArguments.join(' '))
      const relocatedPath = compilationPath(tuned, name)
      // ELF e_type 2 is an executable loaded at a fixed address; a PIE is 3.
      assert.equal((yield* fs.readFile(relocatedPath))[16], fixed ? 2 : 3)
      const relocatedRun = yield* invoke(relocatedPath, [], tuned)
      assert.equal(relocatedRun.status, 0, relocatedRun.stderr)
    }
  }
  // Unsupported settings and unknown fields are rejected before the backend runs.
  for (const field of ['sanitizers = ["address"]', 'unwind = "native"', 'opt = "speed"']) {
    const refused = yield* compileSettings(tuned, 'refused', `[settings.profile]\n${field}\n`,
      { ...process.env, SILK_CLANG: sentinel })
    assert.notEqual(refused.status, 0, `${field} must be refused`)
  }
  yield* fs.writeFileString(join(tuned, 'silk.toml'), `${tunedHeader}\n[packge]\nname = "x"\n`)
  const misspelled = yield* invoke(silk, ['check', '--stdlib', standardLibrary], tuned)
  assert.equal(misspelled.status, 2, misspelled.stderr)
  assert.match(misspelled.stderr, /Invalid Silk project manifest .*silk\.toml:7: /)
  // Runtime-name resolution is semantic even though the composition's shape is schema-owned.
  yield* fs.writeFileString(
    join(tuned, 'silk.toml'),
    `${tunedHeader}[unstable]\ncomposition = { runtimes = [{ name = "start", module = "silk/platform/native/start_sync" }], defaults = ["main"] }\n`,
  )
  const unresolvedRuntime = yield* invoke(silk, ['check', '--stdlib', standardLibrary], tuned)
  assert.equal(unresolvedRuntime.status, 2, unresolvedRuntime.stderr)
  assert.match(unresolvedRuntime.stderr, /Invalid Silk project manifest .*silk\.toml:7: /)
  yield* fs.writeFileString(join(tuned, 'silk.toml'), tunedHeader)
  // Without a runtime, an executable that exports no C `main` is refused before Clang links it.
  const mainless = yield* compileSettings(tuned, 'mainless', '[settings.profile]\nruntime = "none"\n', { ...process.env, SILK_CLANG: sentinel })

  assert.equal(mainless.status, 2, mainless.stderr)
  assert.match(mainless.stderr, /runtime = \{ kind = "none" \} has no `main`/)
  // An unknown `[workspace]` field is refused at its line.
  const looseWorkspace = join(directory, 'loose-workspace')
  yield* fs.makeDirectory(looseWorkspace, { recursive: true })
  yield* fs.writeFileString(join(looseWorkspace, 'silk.toml'), '[workspace]\nmembers = []\nfoo = 1\n')
  const looseChecked = yield* invoke(silk, ['check', '--stdlib', standardLibrary], looseWorkspace)
  assert.equal(looseChecked.status, 2, looseChecked.stderr)
  assert.match(looseChecked.stderr, /Invalid Silk project manifest .*silk\.toml:3: /)
  yield* fs.writeFileString(join(tuned, 'silk.toml'), tunedHeader)
  yield* fs.makeDirectory(join(tuned, 'src/silk'), { recursive: true })
  yield* fs.writeFileString(join(tuned, 'src/silk/extra.silk'), 'pub fn hi() -> i32 {\n  return 1\n}\n')
  const reserved = yield* invoke(silk, ['check', '--stdlib', standardLibrary], tuned)
  assert.notEqual(reserved.status, 0, reserved.stderr)
  assert.match(reserved.stderr, /`silk` and `Intrinsic` are reserved module names/)
  assert.equal(yield* fs.exists(marker), false)
  // Definition parameters reach compilation and remain reproducible in saved requests.
  const boundRoot = join(directory, 'bound')
  yield* fs.makeDirectory(join(boundRoot, 'src'), { recursive: true })
  yield* fs.writeFileString(join(boundRoot, 'src/main.silk'),
    'pub param limit: i32 = 1\n\npub fn main() -> i32 { return limit }\n')
  yield* fs.writeFileString(join(boundRoot, 'silk.toml'), '[package]\nname = "bound"\nversion = "0.1.0"\nsilk-version = "0.0.0"\n')
  const parameter = (name: string, value: string) =>
    `[settings.profile]\n[packages.self]\nexcluded = false\nparameters = [{ module = "main.silk", name = "${name}", supplied-path = false, value = ${value} }]\n`
  for (const value of [7, 3]) {
    const bound = yield* compileSettings(boundRoot, `bound-${value}`, parameter('limit', `{ type = "Integer", decimal = "${value}" }`))
    assert.equal(bound.status, 0, bound.stderr)
    const ran = yield* invoke(compilationPath(boundRoot, `bound-${value}`), [], directory)
    assert.equal(ran.status, value, ran.stderr)
  }
  const boundRequest = join(boundRoot, 'build/definitions/bound-7/request.toml')
  const replayedBound = yield* invoke(silk, ['compile', '--request', boundRequest], directory, { ...process.env, SILK_CLANG: clang })
  assert.equal(replayedBound.status, 0, replayedBound.stderr)
  const replayedProgram = yield* invoke(compilationPath(boundRoot, 'bound-7'), [], directory)
  assert.equal(replayedProgram.status, 7, replayedProgram.stderr)
  for (const [name, value] of [['limit', '{ type = "Text", value = "seven" }'], ['limt', '{ type = "Integer", decimal = "3" }']]) {
    const refused = yield* compileSettings(boundRoot, 'bad-parameter', parameter(name, value))
    assert.equal(refused.status, 1, refused.stderr)
    assert.match(refused.stderr, /error\[SEM0214\]/)
  }
  // A dependency's parameters take their defaults when nothing binds them.
  const defaultedRoot = join(directory, 'defaulted')
  yield* fs.makeDirectory(join(defaultedRoot, 'app/src'), { recursive: true })
  yield* fs.makeDirectory(join(defaultedRoot, 'greeter/src'), { recursive: true })
  yield* fs.writeFileString(join(defaultedRoot, 'greeter/silk.toml'),
    '[package]\nname = "greeter"\nversion = "0.1.0"\nkind = "library"\nexports = ["lib"]\nsilk-version = "0.0.0"\n')
  yield* fs.writeFileString(join(defaultedRoot, 'greeter/src/lib.silk'),
    'pub param times: i32 = 5\n\npub fn count() -> i32 {\n  return times\n}\n')
  yield* fs.writeFileString(join(defaultedRoot, 'app/silk.toml'),
    '[package]\nname = "app"\nversion = "0.1.0"\nsilk-version = "0.0.0"\n\n[dependencies]\ngreeter = { path = "../greeter" }\n')
  yield* fs.writeFileString(join(defaultedRoot, 'app/src/main.silk'),
    'import greeter.lib { count }\n\npub fn main() -> i32 {\n  return count()\n}\n')
  const defaultedRun = yield* invoke(silk, ['run', '--stdlib', standardLibrary], join(defaultedRoot, 'app'), { ...process.env, SILK_CLANG: clang })
  assert.equal(defaultedRun.status, 5, defaultedRun.stderr)
  // `[package].source` roots module resolution above the root module's own directory.
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
    '[package]\nname = "rooted"\nversion = "0.1.0"\nmain = "app/main.silk"\nsilk-version = "0.0.0"\n',
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
    '[package]\nname = "silk-numbers"\nversion = "0.2.0"\nsource = "src"\nexports = ["scale"]\nsilk-version = "0.0.0"\n',
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
    `[package]\nname = "app"\nversion = "1.0.0"\nsource = "."\nsilk-version = "0.0.0"\n\n[dependencies]\n${dependency}\n`
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
  // An export may name a directory whose barrel `mod.silk` re-exports a child module, which
  // stays internal (MODULE-007).
  yield* fs.makeDirectory(join(directory, 'packaged/numbers/src/tools'), { recursive: true })
  yield* fs.writeFileString(
    join(directory, 'packaged/numbers/src/tools/double.silk'),
    'pub fn double(value: i32) -> i32 {\n  return value * 2\n}\n',
  )
  yield* fs.writeFileString(
    join(directory, 'packaged/numbers/src/tools/mod.silk'),
    'pub import tools.double { double }\n',
  )
  yield* fs.writeFileString(
    join(directory, 'packaged/numbers/silk.toml'),
    '[package]\nname = "silk-numbers"\nversion = "0.2.0"\nsource = "src"\nexports = ["scale", "tools"]\nsilk-version = "0.0.0"\n',
  )
  yield* fs.writeFileString(
    join(directory, 'packaged/app/main.silk'),
    'import numbers.tools { double }\n\npub fn main() -> i32 {\n  return double(21)\n}\n',
  )
  const barrelled = yield* invoke(
    silk,
    ['run', '--stdlib', standardLibrary],
    join(directory, 'packaged/app'),
    { ...process.env, SILK_CLANG: clang },
  )
  assert.equal(barrelled.status, 42, barrelled.stderr)
  yield* fs.writeFileString(
    join(directory, 'packaged/app/main.silk'),
    'import numbers.scale { scale }\nimport util.digits { base }\n\npub fn main() -> i32 {\n  return scale(base()) + 2\n}\n',
  )
  // A dependency's declarations are checked where they are written, even one the app never calls.
  yield* fs.writeFileString(
    join(directory, 'packaged/numbers/src/scale.silk'),
    'import util.digits { base }\n\npub fn scale(value: i32) -> i32 {\n  return value * base()\n}\n\nfn unused() -> i32 {\n  return true\n}\n',
  )
  const broken = yield* invoke(
    silk,
    ['check', '--stdlib', standardLibrary],
    join(directory, 'packaged/app'),
    { ...process.env, SILK_CLANG: sentinel },
  )
  assert.notEqual(broken.status, 0, 'an error in an uncalled dependency function was not reported')
  assert.match(broken.stderr, /numbers\/src\/scale\.silk:8:10: error\[SEM0129\]/)
  assert.doesNotMatch(broken.stderr, /main\.silk/)
  yield* fs.writeFileString(
    join(directory, 'packaged/numbers/src/scale.silk'),
    'import util.digits { base }\n\npub fn scale(value: i32) -> i32 {\n  return value * base()\n}\n',
  )
  // A module the dependency's manifest does not export stays internal to it.
  yield* fs.writeFileString(
    join(directory, 'packaged/app/peek.silk'),
    'import numbers.util.digits { base }\n\npub fn peek() -> i32 {\n  return base()\n}\n',
  )
  yield* fs.writeFileString(
    join(directory, 'packaged/app/main.silk'),
    'import peek { peek }\n\npub fn main() -> i32 {\n  return peek()\n}\n',
  )
  const internal = yield* invoke(
    silk,
    ['run', '--stdlib', standardLibrary],
    join(directory, 'packaged/app'),
    { ...process.env, SILK_CLANG: sentinel },
  )
  assert.notEqual(internal.status, 0, 'an unexported module was importable')
  assert.match(internal.stderr, /MOD0003/)
  // A dependency name that is also a top-level directory of the source root is refused.
  yield* fs.writeFileString(
    join(directory, 'packaged/app/silk.toml'),
    packagedManifest('util = { path = "../numbers" }'),
  )
  yield* fs.writeFileString(join(directory, 'packaged/app/main.silk'),
    'import util.scale { scale }\npub fn main() -> i32 { return scale(21) }\n')
  const shadowed = yield* invoke(
    silk,
    ['run', '--stdlib', standardLibrary],
    join(directory, 'packaged/app'),
    { ...process.env, SILK_CLANG: sentinel },
  )
  assert.equal(shadowed.status, 2, 'a shadowing dependency name was accepted')
  assert.match(
    shadowed.stderr,
    /Invalid Silk project manifest .*packaged\/app\/silk\.toml:8: /,
  )
  assert.equal(yield* fs.exists(marker), false)
  // A dependency whose silk.toml is not TOML is refused at that manifest's line.
  yield* fs.makeDirectory(join(directory, 'packaged/broken'), { recursive: true })
  yield* fs.writeFileString(join(directory, 'packaged/broken/silk.toml'), '[package]\nname = "broken"\nversion = 1.0\n[x\n')
  yield* fs.writeFileString(join(directory, 'packaged/app/silk.toml'), packagedManifest('broken = { path = "../broken" }'))
  yield* fs.writeFileString(join(directory, 'packaged/app/main.silk'),
    'import broken.value { value }\npub fn main() -> i32 { return value() }\n')
  const notToml = yield* invoke(
    silk,
    ['run', '--stdlib', standardLibrary],
    join(directory, 'packaged/app'),
    { ...process.env, SILK_CLANG: sentinel },
  )
  assert.equal(notToml.status, 2, 'a dependency that is not TOML was accepted')
  assert.match(
    notToml.stderr,
    /Invalid Silk project manifest .*packaged\/broken\/silk\.toml:4: /,
  )
  // A dependency's silk.toml is checked against the manifest schema as the root's is.
  yield* fs.writeFileString(join(directory, 'packaged/broken/silk.toml'), '[package]\nname = "broken"\nkind = "library"\nnmae = "x"\nsilk-version = "0.0.0"\n')
  const unknownField = yield* invoke(
    silk,
    ['run', '--stdlib', standardLibrary],
    join(directory, 'packaged/app'),
    { ...process.env, SILK_CLANG: sentinel },
  )
  assert.equal(unknownField.status, 2, 'a dependency with an unknown manifest field was accepted')
  assert.match(
    unknownField.stderr,
    /Invalid Silk project manifest .*packaged\/broken\/silk\.toml:4: /,
  )
  {
    // A git dependency pinned to a commit reads one package of a multi-package repository, fetched
    // once into $SILK_HOME/git, and builds again from that checkout without the repository.
    const repository = join(directory, 'git/repository')
    yield* fs.makeDirectory(join(repository, 'vector/src'), { recursive: true })
    yield* fs.makeDirectory(join(repository, 'shared'), { recursive: true })
    yield* fs.makeDirectory(join(repository, 'webgpu'), { recursive: true })
    yield* fs.writeFileString(
      join(repository, 'vector/silk.toml'),
      '[package]\nname = "vector"\nversion = "0.1.0"\nsource = "src"\nexports = ["length"]\nsilk-version = "0.0.0"\n\n[dependencies]\nshared = { path = "../shared" }\n',
    )
    yield* fs.writeFileString(
      join(repository, 'vector/src/length.silk'),
      'import shared.base { base }\n\npub fn length() -> i32 {\n  return base() * 2\n}\n',
    )
    yield* fs.writeFileString(
      join(repository, 'shared/silk.toml'),
      '[package]\nname = "shared"\nversion = "0.1.0"\nsource = "."\nexports = ["base"]\nsilk-version = "0.0.0"\n',
    )
    yield* fs.writeFileString(join(repository, 'shared/base.silk'), 'pub fn base() -> i32 {\n  return 21\n}\n')
    // A package the dependency does not reach is never read, so its manifest may be anything.
    yield* fs.writeFileString(join(repository, 'webgpu/silk.toml'), 'not toml [\n')
    const git = (args: ReadonlyArray<string>) => {
      const ran = spawnSync('git', ['-C', repository, ...args], { encoding: 'utf8' })
      assert.equal(ran.status, 0, ran.stderr)
      return ran.stdout.trim()
    }
    git(['init', '--quiet'])
    git(['add', '.'])
    git(['-c', 'user.name=Silk', '-c', 'user.email=silk@example.com', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'packages'])
    const commit = git(['rev-parse', 'HEAD'])
    const silkHome = join(directory, 'git/home')
    const gitManifest = (fields: string) =>
      `[package]\nname = "app"\nversion = "1.0.0"\nsource = "."\nsilk-version = "0.0.0"\n\n[dependencies]\nvector = { ${fields} }\n`
    yield* fs.makeDirectory(join(directory, 'git/app'), { recursive: true })
    yield* fs.writeFileString(
      join(directory, 'git/app/main.silk'),
      'import vector.length { length }\n\npub fn main() -> i32 {\n  return length()\n}\n',
    )
    yield* fs.writeFileString(
      join(directory, 'git/app/silk.toml'),
      gitManifest(`git = "${pathToFileURL(repository).href}", rev = "${commit}", path = "vector"`),
    )
    const fetched = yield* invoke(silk, ['run', '--stdlib', standardLibrary], join(directory, 'git/app'), {
      ...process.env,
      SILK_CLANG: clang,
      SILK_HOME: silkHome,
    })
    assert.equal(fetched.status, 42, fetched.stderr)
    assert.equal(yield* fs.exists(join(silkHome, `git/${commit}.fetched`)), true)
    assert.equal(yield* fs.exists(join(silkHome, `git/${commit}/.git`)), false)
    // A commit the repository cannot serve fails the fetch at the dependency's git line.
    yield* fs.writeFileString(
      join(directory, 'git/app/silk.toml'),
      gitManifest(`git = "${pathToFileURL(repository).href}", rev = "${'0'.repeat(40)}", path = "vector"`),
    )
    const unreachable = yield* invoke(silk, ['check', '--stdlib', standardLibrary], join(directory, 'git/app'), {
      ...process.env,
      SILK_CLANG: sentinel,
      SILK_HOME: silkHome,
    })
    assert.equal(unreachable.status, 2, 'an unreachable commit was accepted')
    assert.match(
      unreachable.stderr,
      /Invalid Silk project manifest .*git\/app\/silk\.toml:8: /,
    )
    yield* fs.writeFileString(
      join(directory, 'git/app/silk.toml'),
      gitManifest(`git = "${pathToFileURL(repository).href}", rev = "${commit}", path = "vector"`),
    )
    yield* fs.remove(repository, { recursive: true })
    const cached = yield* invoke(silk, ['run', '--stdlib', standardLibrary], join(directory, 'git/app'), {
      ...process.env,
      SILK_CLANG: clang,
      SILK_HOME: silkHome,
    })
    assert.equal(cached.status, 42, cached.stderr)
  }
  {
    // A workspace writes shared dependencies once in [workspace.dependencies]; a member takes one
    // by name with { workspace = true } (PACKAGE-008). The repository is itself a workspace whose
    // member takes a sibling that way, so a checkout resolves the entry inside itself.
    const repository = join(directory, 'shared/repository')
    yield* fs.makeDirectory(join(repository, 'lengths'), { recursive: true })
    yield* fs.makeDirectory(join(repository, 'units'), { recursive: true })
    yield* fs.writeFileString(
      join(repository, 'silk.toml'),
      '[workspace]\nmembers = ["lengths", "units"]\n\n[workspace.dependencies]\nunits = { path = "units" }\n',
    )
    yield* fs.writeFileString(
      join(repository, 'lengths/silk.toml'),
      '[package]\nname = "lengths"\nversion = "0.1.0"\nsource = "."\nexports = ["length"]\nsilk-version = "0.0.0"\n\n[dependencies]\nunits = { workspace = true }\n',
    )
    yield* fs.writeFileString(
      join(repository, 'lengths/length.silk'),
      'import units.unit { unit }\n\npub fn length() -> i32 {\n  return unit() + 6\n}\n',
    )
    yield* fs.writeFileString(
      join(repository, 'units/silk.toml'),
      '[package]\nname = "units"\nversion = "0.1.0"\nsource = "."\nexports = ["unit"]\nsilk-version = "0.0.0"\n',
    )
    yield* fs.writeFileString(join(repository, 'units/unit.silk'), 'pub fn unit() -> i32 {\n  return 1\n}\n')
    const git = (args: ReadonlyArray<string>) => {
      const ran = spawnSync('git', ['-C', repository, ...args], { encoding: 'utf8' })
      assert.equal(ran.status, 0, ran.stderr)
      return ran.stdout.trim()
    }
    git(['init', '--quiet'])
    git(['add', '.'])
    git(['-c', 'user.name=Silk', '-c', 'user.email=silk@example.com', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'packages'])
    const commit = git(['rev-parse', 'HEAD'])
    const pin = `git = "${pathToFileURL(repository).href}", rev = "${commit}", path = "lengths"`
    const workspace = join(directory, 'shared/workspace')
    const environment = { ...process.env, SILK_CLANG: clang, SILK_HOME: join(directory, 'shared/home') }
    const refusing = { ...environment, SILK_CLANG: sentinel }
    yield* fs.makeDirectory(join(workspace, 'app'), { recursive: true })
    yield* fs.makeDirectory(join(workspace, 'libs/math'), { recursive: true })
    const root = (lengths: string) =>
      `[workspace]\nmembers = ["app", "libs/*"]\nsilk-version = "${releasePin}"\n\n[workspace.dependencies]\nlengths = { ${lengths} }\nmath = { path = "libs/math" }\n`
    yield* fs.writeFileString(join(workspace, 'silk.toml'), root(pin))
    yield* fs.writeFileString(
      join(workspace, 'libs/math/silk.toml'),
      '[package]\nname = "shared-math"\nversion = "0.1.0"\nsource = "."\nkind = "library"\nmain = "twice.silk"\nexports = ["twice"]\n\n[dependencies]\nlengths = { workspace = true }\n',
    )
    yield* fs.writeFileString(
      join(workspace, 'libs/math/twice.silk'),
      'import lengths.length { length }\n\npub fn twice() -> i32 {\n  return length() * 2\n}\n',
    )
    const member = (dependencies: string) =>
      `[package]\nname = "shared-app"\nversion = "0.1.0"\nsource = "."\n\n[dependencies]\n${dependencies}`
    const taken = 'math = { workspace = true }\nlengths = { workspace = true }\n'
    yield* fs.writeFileString(join(workspace, 'app/silk.toml'), member(taken))
    yield* fs.writeFileString(
      join(workspace, 'app/main.silk'),
      'import lengths.length { length }\nimport math.twice { twice }\n\npub fn main() -> i32 {\n  return twice() + length()\n}\n',
    )
    // The shared path is relative to the workspace root, and the shared pin is fetched once.
    const ran = yield* invoke(silk, ['run', '--stdlib', standardLibrary], join(workspace, 'app'), environment)
    assert.equal(ran.status, 21, ran.stderr)
    // From the root, the members build in dependency order through the shared path entry.
    const all = yield* invoke(silk, ['check', '--stdlib', standardLibrary], workspace, refusing)
    assert.equal(all.status, 0, all.stderr)
    assert.ok(
      all.stderr.indexOf('shared-math') < all.stderr.indexOf('shared-app'),
      `the library member is not checked before the member that takes it:\n${all.stderr}`,
    )
    // An unused workspace dependency is not resolved; importing it reports the bad entry.
    yield* fs.writeFileString(join(workspace, 'app/silk.toml'), member(`${taken}missing = { workspace = true }\n`))
    const unusedMissing = yield* invoke(silk, ['check', '--stdlib', standardLibrary], join(workspace, 'app'), refusing)
    assert.equal(unusedMissing.status, 0, unusedMissing.stderr)
    const appSource = yield* fs.readFileString(join(workspace, 'app/main.silk'))
    yield* fs.writeFileString(join(workspace, 'app/main.silk'), `import missing.lib\n${appSource}`)
    const missing = yield* invoke(silk, ['check', '--stdlib', standardLibrary], join(workspace, 'app'), refusing)
    yield* fs.writeFileString(join(workspace, 'app/main.silk'), appSource)
    assert.equal(missing.status, 2, 'a dependency the workspace does not write was accepted')
    assert.match(missing.stderr, /Invalid Silk project manifest .*shared\/workspace\/app\/silk\.toml:9: /)
    // The entry is written alone.
    yield* fs.writeFileString(
      join(workspace, 'app/silk.toml'),
      member('math = { workspace = true }\nlengths = { workspace = true, package = "lengths" }\n'),
    )
    const extended = yield* invoke(silk, ['check', '--stdlib', standardLibrary], join(workspace, 'app'), refusing)
    assert.equal(extended.status, 2, 'a workspace entry with another field was accepted')
    assert.match(extended.stderr, /Invalid Silk project manifest .*shared\/workspace\/app\/silk\.toml:8: /)
    // A fault in the shared entry names the workspace root's manifest.
    yield* fs.writeFileString(join(workspace, 'app/silk.toml'), member(taken))
    yield* fs.writeFileString(join(workspace, 'silk.toml'), root(pin.replace(commit, 'main')))
    const unpinned = yield* invoke(silk, ['check', '--stdlib', standardLibrary], join(workspace, 'app'), refusing)
    assert.equal(unpinned.status, 2, 'a shared git dependency without a commit was accepted')
    assert.match(unpinned.stderr, /Invalid Silk project manifest .*shared\/workspace\/silk\.toml:6: /)
    yield* fs.writeFileString(join(workspace, 'silk.toml'), root(pin))
    // A package no workspace lists has nothing to take the entry from.
    yield* fs.makeDirectory(join(workspace, 'tool'), { recursive: true })
    yield* fs.writeFileString(
      join(workspace, 'tool/silk.toml'),
      '[package]\nname = "shared-tool"\nversion = "0.1.0"\nsource = "."\nsilk-version = "0.0.0"\n\n[dependencies]\nlengths = { workspace = true }\n',
    )
    yield* fs.writeFileString(join(workspace, 'tool/main.silk'), 'import lengths.length { length }\npub fn main() -> i32 {\n  return length()\n}\n')
    const unlisted = yield* invoke(silk, ['check', '--stdlib', standardLibrary], join(workspace, 'tool'), refusing)
    assert.equal(unlisted.status, 2, 'a package outside the workspace took a workspace dependency')
    assert.match(unlisted.stderr, /Invalid Silk project manifest .*shared\/workspace\/tool\/silk\.toml:8: /)
    yield* fs.remove(join(workspace, 'tool'), { recursive: true })
    // `silk pack` writes the shared pin out, so the archive builds without the workspace.
    const output = join(directory, 'shared/packed')
    const packed = yield* invoke(
      silk,
      ['pack', '-p', 'shared-math', '--output', output, '--stdlib', standardLibrary],
      workspace,
      refusing,
    )
    assert.equal(packed.status, 0, packed.stdout + packed.stderr)
    const listed = spawnSync('tar', ['-xzOf', join(output, 'shared-math-0.1.0.tar.gz'), 'shared-math-0.1.0/silk.toml'], {
      encoding: 'utf8',
    })
    assert.equal(listed.status, 0, listed.stderr)
    assert.ok(listed.stdout.includes(`lengths = { ${pin} }\n`), listed.stdout)
    assert.equal(listed.stdout.includes('workspace'), false, listed.stdout)
    // A shared path dependency is still one an archive cannot carry.
    const carried = yield* invoke(
      silk,
      ['pack', '-p', 'shared-app', '--output', output, '--stdlib', standardLibrary],
      workspace,
      refusing,
    )
    assert.equal(carried.status, 1, 'a package with a shared path dependency was packed')
    assert.match(carried.stderr, /path dependency `math`/)
    // `silk pack --verify` accepts what a signing `silk pack` wrote, and names every fault in a
    // directory that was changed afterwards.
    const keys = join(directory, 'shared/keys')
    const made = yield* invoke(silk, ['pack', '--new-key', join(keys, 'release.key')], workspace, refusing)
    assert.equal(made.status, 0, made.stderr)
    const signed = join(directory, 'shared/signed')
    const signing = yield* invoke(
      silk,
      ['pack', '-p', 'shared-math', '--output', signed, '--sign', join(keys, 'release.key'), '--stdlib', standardLibrary],
      workspace,
      refusing,
    )
    assert.equal(signing.status, 0, signing.stderr)
    const verify = (...more: ReadonlyArray<string>) =>
      invoke(silk, ['pack', '--verify', signed, '--key', join(keys, 'release.pub'), ...more], workspace, refusing)
    const verified = yield* verify()
    assert.equal(verified.status, 0, verified.stderr)
    assert.match(verified.stdout, /^verified shared-math-0\.1\.0\.tar\.gz\n/)
    // Without `--key` the public key is `minisign.pub` in the working directory.
    const unkeyed = yield* invoke(silk, ['pack', '--verify', signed], workspace, refusing)
    assert.equal(unkeyed.status, 2, 'a release was verified without a public key')
    assert.match(unkeyed.stderr, /cannot read the public key .*minisign\.pub; name the key file with --key/)
    yield* fs.copyFile(join(keys, 'release.pub'), join(workspace, 'minisign.pub'))
    const found = yield* invoke(silk, ['pack', '--verify', signed], workspace, refusing)
    assert.equal(found.status, 0, found.stderr)
    yield* fs.remove(join(workspace, 'minisign.pub'))
    const combined = yield* verify('--bin')
    assert.equal(combined.status, 2, '--verify was accepted beside --bin')
    // A file the list does not name, a changed file and a missing signature each fail.
    yield* fs.writeFileString(join(signed, 'extra.txt'), 'not released\n')
    const extra = yield* verify()
    assert.equal(extra.status, 1, 'a file SHA256SUMS does not name was accepted')
    assert.match(extra.stderr, /^silk pack: extra\.txt: SHA256SUMS does not name it$/m)
    yield* fs.remove(join(signed, 'extra.txt'))
    // A signature of nothing the list names, and on Linux a name that only ends like a listed
    // one, are unlisted files too.
    yield* fs.writeFileString(join(signed, 'orphan.minisig'), 'not a signature\n')
    const orphan = yield* verify()
    assert.equal(orphan.status, 1, 'a signature of no listed file was accepted')
    assert.match(orphan.stderr, /^silk pack: orphan\.minisig: SHA256SUMS does not name it$/m)
    assert.equal(orphan.stdout, '', 'a directory with a fault reported a verified file')
    yield* fs.remove(join(signed, 'orphan.minisig'))
    if (process.platform === 'linux') {
      yield* fs.writeFileString(join(signed, 'x\\SHA256SUMS'), 'hidden\n')
      const hidden = yield* verify()
      assert.equal(hidden.status, 1, 'a file named with a backslash was taken for the list')
      yield* fs.remove(join(signed, 'x\\SHA256SUMS'))
    }
    const archive = join(signed, 'shared-math-0.1.0.tar.gz')
    const original = yield* fs.readFile(archive)
    yield* fs.writeFile(archive, new Uint8Array([...original, 0]))
    const changed = yield* verify()
    assert.equal(changed.status, 1, 'a changed archive was accepted')
    assert.match(changed.stderr, /^silk pack: shared-math-0\.1\.0\.tar\.gz: the SHA-256 does not match SHA256SUMS$/m)
    assert.equal(changed.stdout.includes('shared-math-0.1.0.tar.gz\n'), false, changed.stdout)
    yield* fs.writeFile(archive, original)
    yield* fs.remove(`${archive}.minisig`)
    const unsigned = yield* verify()
    assert.equal(unsigned.status, 1, 'an archive without a signature was accepted')
    assert.match(unsigned.stderr, /shared-math-0\.1\.0\.tar\.gz: it has no signature/)
    // A list signed by another key proves nothing, so no file is reported verified.
    const other = yield* invoke(silk, ['pack', '--new-key', join(keys, 'other.key')], workspace, refusing)
    assert.equal(other.status, 0, other.stderr)
    const foreign = yield* invoke(silk, ['pack', '--verify', signed, '--key', join(keys, 'other.pub')], workspace, refusing)
    assert.equal(foreign.status, 1, 'a release signed by another key was accepted')
    assert.match(foreign.stderr, /^silk pack: SHA256SUMS: the signature was made with a different key$/m)
    assert.equal(foreign.stdout, '')
  }
  {
    // A silk.local.toml beside the workspace root swaps every dependency on a package, git ones
    // included, for a local checkout (PACKAGE-009), without fetching it, and the build names it.
    const repository = join(directory, 'override/repository')
    yield* fs.makeDirectory(join(repository, 'units'), { recursive: true })
    yield* fs.writeFileString(
      join(repository, 'units/silk.toml'),
      '[package]\nname = "units"\nversion = "0.1.0"\nsource = "."\nexports = ["unit"]\nsilk-version = "0.0.0"\n',
    )
    yield* fs.writeFileString(join(repository, 'units/unit.silk'), 'pub fn unit() -> i32 {\n  return 1\n}\n')
    const git = (args: ReadonlyArray<string>) => {
      const ran = spawnSync('git', ['-C', repository, ...args], { encoding: 'utf8' })
      assert.equal(ran.status, 0, ran.stderr)
      return ran.stdout.trim()
    }
    git(['init', '--quiet'])
    git(['add', '.'])
    git(['-c', 'user.name=Silk', '-c', 'user.email=silk@example.com', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'units'])
    const commit = git(['rev-parse', 'HEAD'])
    const pin = `units = { git = "${pathToFileURL(repository).href}", rev = "${commit}", path = "units" }\n`
    const local = join(directory, 'override/units-local')
    yield* fs.makeDirectory(local, { recursive: true })
    yield* fs.writeFileString(
      join(local, 'silk.toml'),
      '[package]\nname = "units"\nversion = "0.2.0"\nsource = "."\nexports = ["unit"]\nsilk-version = "0.0.0"\n',
    )
    yield* fs.writeFileString(join(local, 'unit.silk'), 'pub fn unit() -> i32 {\n  return 5\n}\n')
    const workspace = join(directory, 'override/workspace')
    yield* fs.makeDirectory(join(workspace, 'app'), { recursive: true })
    yield* fs.makeDirectory(join(workspace, 'math'), { recursive: true })
    yield* fs.writeFileString(join(workspace, 'silk.toml'), '[workspace]\nmembers = ["app", "math"]\n')
    // Both members pin the git package, so the override settles the diamond on one copy.
    yield* fs.writeFileString(
      join(workspace, 'math/silk.toml'),
      `[package]\nname = "override-math"\nversion = "0.1.0"\nsource = "."\nexports = ["twice"]\nsilk-version = "0.0.0"\n\n[dependencies]\n${pin}`,
    )
    yield* fs.writeFileString(
      join(workspace, 'math/twice.silk'),
      'import units.unit { unit }\n\npub fn twice() -> i32 {\n  return unit() * 2\n}\n',
    )
    yield* fs.writeFileString(
      join(workspace, 'app/silk.toml'),
      `[package]\nname = "override-app"\nversion = "0.1.0"\nsource = "."\nsilk-version = "0.0.0"\n\n[dependencies]\nmath = { path = "../math", package = "override-math" }\n${pin}`,
    )
    yield* fs.writeFileString(
      join(workspace, 'app/main.silk'),
      'import math.twice { twice }\nimport units.unit { unit }\n\npub fn main() -> i32 {\n  return unit() + twice()\n}\n',
    )
    const home = join(directory, 'override/home')
    const environment = { ...process.env, SILK_CLANG: clang, SILK_HOME: home }
    const overrides = join(workspace, 'silk.local.toml')
    const using = '[overrides]\nunits = { path = "../units-local" }\n'
    yield* fs.writeFileString(overrides, using)
    const overridden = yield* invoke(silk, ['run', '--stdlib', standardLibrary], join(workspace, 'app'), environment)
    assert.equal(overridden.status, 15, overridden.stderr)
    assert.match(overridden.stderr, /^silk: note: .*silk\.local\.toml overrides units with \.\.\/units-local$/m)
    assert.equal(yield* fs.exists(join(home, `git/${commit}.fetched`)), false, 'an overridden package was fetched')
    // Removing the file, and writing it again, each change what the next build reads.
    yield* fs.remove(overrides)
    const pinned = yield* invoke(silk, ['run', '--stdlib', standardLibrary], join(workspace, 'app'), environment)
    assert.equal(pinned.status, 3, pinned.stderr)
    assert.equal(pinned.stderr.includes('silk.local.toml'), false, pinned.stderr)
    yield* fs.writeFileString(overrides, using)
    const again = yield* invoke(silk, ['run', '--stdlib', standardLibrary], join(workspace, 'app'), environment)
    assert.equal(again.status, 15, again.stderr)
    // The checkout must be the package it overrides.
    yield* fs.writeFileString(overrides, '[overrides]\nunits = { path = "math" }\n')
    const mismatched = yield* invoke(silk, ['check', '--stdlib', standardLibrary], join(workspace, 'app'), environment)
    assert.equal(mismatched.status, 2, 'an override naming another package was accepted')
    assert.match(mismatched.stderr, /silk\.local\.toml:2: .*names the package `override-math`/)
    // The file holds only [overrides], and each entry only a path to a package.
    yield* fs.writeFileString(overrides, '[dependencies]\nunits = { path = "../units-local" }\n')
    const unknown = yield* invoke(silk, ['check', '--stdlib', standardLibrary], join(workspace, 'app'), environment)
    assert.equal(unknown.status, 2, 'a silk.local.toml table other than [overrides] was accepted')
    assert.match(unknown.stderr, /silk\.local\.toml:1: /)
    yield* fs.writeFileString(overrides, '[overrides]\nunits = { path = "../missing" }\n')
    const missing = yield* invoke(silk, ['check', '--stdlib', standardLibrary], join(workspace, 'app'), environment)
    assert.equal(missing.status, 2, 'an override of a directory without silk.toml was accepted')
    assert.match(missing.stderr, /silk\.local\.toml:2: .*has no silk\.toml/)
  }
  {
    // `[pack.binary]` ships binaries without `--bin`: a tar file with the executable in `bin/`
    // and the included files, or for a target that says so a ZIP file with it at the top.
    const tool = join(directory, 'binary/tool')
    const output = join(directory, 'binary/out')
    const environment = { ...process.env, SILK_CLANG: clang }
    yield* fs.makeDirectory(join(tool, 'src'), { recursive: true })
    yield* fs.makeDirectory(join(tool, 'completions'), { recursive: true })
    const manifest = (more: string) =>
      `[package]\nname = "packed-tool"\nversion = "1.2.0"\nsilk-version = "${releasePin}"\n\n[pack.binary]\ninclude = ["completions", "notes.txt"]\n${more}`
    yield* fs.writeFileString(join(tool, 'silk.toml'), manifest(''))
    yield* fs.writeFileString(join(tool, 'src/main.silk'), 'pub fn main() -> i32 {\n  return 0\n}\n')
    yield* fs.writeFileString(join(tool, 'completions/tool.bash'), 'complete -W "pack" packed-tool\n')
    yield* fs.writeFileString(join(tool, 'notes.txt'), 'notes\n')
    yield* fs.writeFileString(join(tool, 'LICENSE'), 'license\n')
    const packed = yield* invoke(
      silk,
      ['pack', '--json', '--output', output, '--stdlib', standardLibrary],
      tool,
      environment,
      120_000,
    )
    assert.equal(packed.status, 0, packed.stdout + packed.stderr)
    const binaries = JSON.parse(packed.stdout).archives[0].binaries as ReadonlyArray<{ platform: string; path: string }>
    assert.equal(binaries.length, 1, packed.stdout)
    const platform = binaries[0].platform
    const top = `packed-tool-1.2.0-${platform}`
    assert.equal(binaries[0].path, join(output, `${top}.tar.gz`))
    const tarred = spawnSync('tar', ['-tzf', binaries[0].path], { encoding: 'utf8' })
    assert.equal(tarred.status, 0, tarred.stderr)
    assert.deepEqual(tarred.stdout.trim().split('\n'), [
      `${top}/bin/packed-tool`,
      `${top}/LICENSE`,
      `${top}/completions/tool.bash`,
      `${top}/notes.txt`,
    ])
    // The target's own table replaces the format, the layout and the included files.
    yield* fs.writeFileString(
      join(tool, 'silk.toml'),
      manifest(`\n[pack.binary.target.${platform}]\nformat = "zip"\nlayout = "flat"\ninclude = ["notes.txt"]\n`),
    )
    const zipped = yield* invoke(
      silk,
      ['pack', '--json', '--output', output, '--stdlib', standardLibrary],
      tool,
      environment,
      120_000,
    )
    assert.equal(zipped.status, 0, zipped.stderr)
    const archive = JSON.parse(zipped.stdout).archives[0].binaries[0].path as string
    assert.equal(archive, join(output, `${top}.zip`))
    const tested = spawnSync('unzip', ['-t', archive], { encoding: 'utf8' })
    assert.equal(tested.status, 0, tested.stdout + tested.stderr)
    const names = spawnSync('unzip', ['-Z1', archive], { encoding: 'utf8' })
    assert.deepEqual(names.stdout.trim().split('\n'), [`${top}/packed-tool`, `${top}/LICENSE`, `${top}/notes.txt`])
    const modes = spawnSync('unzip', ['-Z', archive], { encoding: 'utf8' })
    assert.match(modes.stdout, /^-rwxr-xr-x .* packed-tool-1\.2\.0-.*\/packed-tool$/m)
    assert.match(modes.stdout, /^-rw-r--r-- .*\/LICENSE$/m)
    // `--list` writes nothing, so it builds nothing.
    const listed = yield* invoke(silk, ['pack', '--list', '--stdlib', standardLibrary], tool, { ...process.env, SILK_CLANG: '/nonexistent' })
    assert.equal(listed.status, 0, listed.stderr)
    // An entry that names nothing is refused with the table it is written in.
    yield* fs.writeFileString(join(tool, 'silk.toml'), manifest('').replace('"notes.txt"', '"missing.txt"'))
    const missing = yield* invoke(silk, ['pack', '--output', output, '--stdlib', standardLibrary], tool, environment, 120_000)
    assert.equal(missing.status, 1, 'an include entry that names nothing was packed')
    assert.match(missing.stderr, /\[pack\.binary\]\.include entry missing\.txt names no file or directory/)
    // An included path at, above or below the executable's is refused, naming its table.
    yield* fs.writeFileString(join(tool, 'bin'), 'a file named as the directory of the executable\n')
    yield* fs.writeFileString(
      join(tool, 'silk.toml'),
      manifest(`\n[pack.binary.target.${platform}]\ninclude = ["bin"]\n`),
    )
    const displaced = yield* invoke(silk, ['pack', '--output', output, '--stdlib', standardLibrary], tool, environment, 120_000)
    assert.equal(displaced.status, 1, 'an included file took the place of the executable directory')
    assert.ok(
      displaced.stderr.includes(`[pack.binary.target.${platform}].include holds bin, which takes the place of the executable at bin/packed-tool`),
      displaced.stderr,
    )
    yield* fs.remove(join(tool, 'bin'))
    // The table is an executable's.
    yield* fs.writeFileString(
      join(tool, 'silk.toml'),
      '[package]\nname = "packed-tool"\nversion = "1.2.0"\nsilk-version = "' + releasePin + '"\nkind = "library"\nmain = "main.silk"\nexports = ["main"]\n\n[pack.binary]\n',
    )
    const library = yield* invoke(silk, ['pack', '--output', output, '--stdlib', standardLibrary], tool, environment, 120_000)
    assert.equal(library.status, 1, 'a library with [pack.binary] was packed')
    assert.match(library.stderr, /\[pack\.binary\] archives an executable, and \[package\]\.kind is library/)
  }
  {
    // `init --template` copies one directory of a GitHub repository, here served from local
    // repositories through git's `insteadOf`, runs its [[post-init]] entries and drops them from the
    // new manifest. A one-segment template is a directory of silk-lang/examples.
    const served = join(directory, 'templates/served')
    const home = join(directory, 'templates/home')
    const silkHome = join(directory, 'templates/silk-home')
    const work = join(directory, 'templates/work')
    const examples = join(served, 'silk-lang/examples.git')
    yield* fs.makeDirectory(join(examples, 'ui/src'), { recursive: true })
    yield* fs.makeDirectory(join(examples, 'ui/scripts'), { recursive: true })
    yield* fs.makeDirectory(join(examples, 'broken'), { recursive: true })
    yield* fs.makeDirectory(home, { recursive: true })
    yield* fs.makeDirectory(work, { recursive: true })
    yield* fs.writeFileString(
      join(home, '.gitconfig'),
      `[url "${pathToFileURL(served).href}/"]\n\tinsteadOf = https://github.com/\n`,
    )
    yield* fs.writeFileString(
      join(examples, 'ui/silk.toml'),
      '[package]\nname = "ui"\nversion = "0.1.0"\nsilk-version = "0.0.1"\ndescription = "A window"\n\n' +
        "[[post-init]]\nrun = ['sh', '-c', 'echo \"plain $# $SILK_VERSION $PATH\"']\n\n" +
        '[[post-init]]\nrun = ["scripts/post-init.sh", "ready"]\narguments = true\n\n' +
        '[[template.next-steps]]\nrun = "silk task dev"\ndescription = "start the dev server"\n\n' +
        '[[template.next-steps]]\nrun = "silk task build --release"\n',
    )
    // A library template without [template] suggests `silk test`; `next-steps = []` suggests nothing.
    yield* fs.makeDirectory(join(examples, 'library/src'), { recursive: true })
    yield* fs.writeFileString(
      join(examples, 'library/silk.toml'),
      '[package]\nname = "library"\nversion = "0.1.0"\nkind = "library"\nexports = ["lib"]\n',
    )
    yield* fs.writeFileString(join(examples, 'library/src/lib.silk'), 'pub fn seven() -> i32 {\n  return 7\n}\n')
    yield* fs.makeDirectory(join(examples, 'quiet/src'), { recursive: true })
    yield* fs.writeFileString(join(examples, 'quiet/silk.toml'), '[package]\nname = "quiet"\n\n[template]\nnext-steps = []\n')
    yield* fs.writeFileString(join(examples, 'quiet/src/main.silk'), 'pub fn main() -> i32 {\n  return 0\n}\n')
    yield* fs.makeDirectory(join(examples, 'garbled'), { recursive: true })
    yield* fs.writeFileString(join(examples, 'garbled/silk.toml'), '[package]\nname = "garbled"\n\n[template]\nnext-steps = [{ run = "silk run" }, "silk test"]\n')
    yield* fs.writeFileString(join(examples, 'ui/src/main.silk'), 'pub fn main() -> i32 {\n  return 7\n}\n')
    yield* fs.writeFileString(
      join(examples, 'ui/scripts/post-init.sh'),
      '#!/bin/sh\ngrep -q post-init silk.toml && exit 4\necho "post-init $*"\nrm scripts/post-init.sh\n',
    )
    yield* fs.chmod(join(examples, 'ui/scripts/post-init.sh'), 0o755)
    // An entry that reaches outside the new project, which the sandbox refuses.
    yield* fs.makeDirectory(join(examples, 'escape'), { recursive: true })
    yield* fs.writeFileString(
      join(examples, 'escape/silk.toml'),
      `[package]\nname = "escape"\n\n[[post-init]]\nrun = ["sh", "-c", "touch '${join(work, 'escaped')}' || exit 5; cat '${join(home, '.gitconfig')}'"]\n`,
    )
    yield* fs.writeFileString(
      join(examples, 'broken/silk.toml'),
      '[package]\nname = "broken"\n\n[[post-init]]\nrun = ["sh", "-c", "touch made; exit 3"]\n',
    )
    const git = (args: ReadonlyArray<string>) => {
      const ran = spawnSync('git', ['-C', examples, ...args], { encoding: 'utf8' })
      assert.equal(ran.status, 0, ran.stderr)
      return ran.stdout.trim()
    }
    git(['init', '--quiet'])
    git(['add', '.'])
    git(['-c', 'user.name=Silk', '-c', 'user.email=silk@example.com', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'templates'])
    git(['tag', 'v1'])
    const commit = git(['rev-parse', 'HEAD'])
    // [[post-init]] entries run in the build tool sandbox; a host without one runs them only with
    // --unsandboxed-post-init.
    const templateEnvironment = { ...process.env, HOME: home, SILK_HOME: silkHome, XDG_CONFIG_HOME: join(home, '.config') }
    const templated = (args: ReadonlyArray<string>, cwd = work) =>
      landlockNet || args[0] === '-l' || args[0] === '--list'
        ? invoke(silk, ['init', ...args], cwd, templateEnvironment)
        : invoke(silk, ['init', args[0], '--unsandboxed-post-init', ...args.slice(1)], cwd, { ...templateEnvironment, SILK_NO_TOOL_SANDBOX: '1' })
    const official = yield* templated(['app', '-t', 'ui', '--', '--dark', 'two words'])
    assert.equal(official.status, 0, official.stderr)
    // Every entry sees the compiler's release in SILK_VERSION and gets only its own arguments; one
    // that sets `arguments = true` also gets the ones after `--`. A sandboxed entry sees a fixed PATH.
    assert.match(official.stdout, landlockNet ? /^plain 0 \d+\.\d+\.\d+\S* \/usr\/local\/bin:\/usr\/bin:\/bin\n/ : /^plain 0 \d+\.\d+\.\d+\S* /)
    // The official example is named by its directory, with its commit shortened; a step's
    // description is lined up beside its command, and a step without one is printed alone.
    assert.match(official.stdout, /\npost-init ready --dark two words\n  Created app from the ui template \([0-9a-f]{7}\)\n\n  Next steps:\n    cd app\n    silk task dev   start the dev server\n    silk task build --release\n$/)
    assert.equal(official.stdout.includes(`(${commit.slice(0, 7)})`), true, official.stdout)
    const manifest = yield* fs.readFileString(join(work, 'app/silk.toml'))
    assert.match(manifest, /^\[package\]\nname = "app"\nversion = "0\.1\.0"\nsilk-version = "[^"]+"\n$/)
    assert.equal(manifest.includes('0.0.1'), false, manifest)
    assert.equal(yield* fs.readFileString(join(work, 'app/.gitignore')), '/build/\n/silk.local.toml\n')
    assert.equal(yield* fs.exists(join(work, 'app/scripts/post-init.sh')), false)
    assert.deepEqual(readdirSync(join(silkHome, 'git')), [], 'a template scratch directory was left behind')
    const ran = yield* invoke(silk, ['run', '--stdlib', standardLibrary], join(work, 'app'), { ...process.env, SILK_CLANG: clang })
    assert.equal(ran.status, 7, ran.stderr)
    // `cd` names the project relative to the working directory, quoted when the shell needs it, and
    // is left out for a project created in the working directory.
    const library = yield* templated(['odd place/lib', '-t', 'library', '--name', 'lib'])
    assert.equal(library.status, 0, library.stderr)
    assert.match(library.stdout, /^  Created odd place\/lib from the library template \([0-9a-f]{7}\)\n\n  Next steps:\n    cd 'odd place\/lib'\n    silk test   run its tests\n$/)
    yield* fs.makeDirectory(join(work, 'here'), { recursive: true })
    const here = yield* templated(['.', '-t', 'library'], join(work, 'here'))
    assert.equal(here.status, 0, here.stderr)
    assert.match(here.stdout, /^  Created here from the library template \([0-9a-f]{7}\)\n\n  Next steps:\n    silk test   run its tests\n$/)
    const quiet = yield* templated(['quiet', '-t', 'quiet'])
    assert.equal(quiet.status, 0, quiet.stderr)
    assert.match(quiet.stdout, /^  Created quiet from the quiet template \([0-9a-f]{7}\)\n$/)
    assert.equal(yield* fs.readFileString(join(work, 'quiet/silk.toml')), `[package]\nname = "quiet"\nsilk-version = "${(yield* fs.readFileString(join(work, 'app/silk.toml'))).match(/silk-version = "([^"]+)"/)![1]}"\n`)
    const garbled = yield* templated(['garbled', '-t', 'garbled'])
    assert.equal(garbled.status, 1, garbled.stderr)
    assert.match(garbled.stderr, /^The template's silk\.toml is invalid: \[template\]\.next-steps\[1\]: /)
    assert.equal(yield* fs.exists(join(work, 'garbled')), false)
    // The full spelling with a tag, and a name; the template's own manifest never names the project.
    const tagged = yield* templated(['named', '-t', 'silk-lang/examples/ui@v1', '--name', 'other'])
    assert.equal(tagged.status, 0, tagged.stderr)
    assert.match(yield* fs.readFileString(join(work, 'named/silk.toml')), /name = "other"/)
    // Initialization never overwrites a file, and a failing entry removes everything it created.
    yield* fs.makeDirectory(join(work, 'taken/src'), { recursive: true })
    yield* fs.writeFileString(join(work, 'taken/src/main.silk'), 'kept\n')
    const collision = yield* templated(['taken', '-t', 'ui'])
    assert.equal(collision.status, 2, collision.stderr)
    assert.match(collision.stderr, /Refusing to overwrite existing project file \S+taken\/src\/main\.silk\n/)
    assert.deepEqual(readdirSync(join(work, 'taken')).sort(), ['src'])
    assert.equal(yield* fs.readFileString(join(work, 'taken/src/main.silk')), 'kept\n')
    // Arguments no entry takes are refused before anything is written.
    const unwanted = yield* templated(['unwanted', '-t', 'broken', '--', 'extra'])
    assert.equal(unwanted.status, 1, unwanted.stderr)
    assert.match(unwanted.stderr, /Template silk-lang\/examples\/broken takes no arguments after `--`: no \[\[post-init\]\] entry of its silk\.toml sets `arguments = true`\n/)
    assert.equal(yield* fs.exists(join(work, 'unwanted')), false)
    if (landlockNet) {
      const escaping = yield* templated(['escaping', '-t', 'escape'])
      assert.equal(escaping.status, 1, escaping.stderr)
      assert.match(escaping.stderr, /failed with status 5\nsilk: the template's \[\[post-init\]\] entry failed, so the project was removed\n/)
      assert.equal(yield* fs.exists(join(work, 'escaped')), false, 'a post-init entry wrote outside the new project')
      assert.equal(yield* fs.exists(join(work, 'escaping')), false)
    } else {
      const warned = yield* templated(['warned', '-t', 'ui'])
      assert.equal(warned.status, 0, warned.stderr)
      assert.match(warned.stderr, /silk: warning: running the template's \[\[post-init\]\] entries without a sandbox \(--unsandboxed-post-init\)\n/)
    }
    const refusedHost = yield* invoke(silk, ['init', 'nosandbox', '-t', 'ui'], work, { ...templateEnvironment, SILK_NO_TOOL_SANDBOX: '1' })
    assert.equal(refusedHost.status, 1, refusedHost.stderr)
    assert.match(refusedHost.stderr, /Template silk-lang\/examples\/ui has \[\[post-init\]\] entries, and this host has no sandbox to run them in .*add --unsandboxed-post-init to run them with your full access\n/)
    assert.equal(yield* fs.exists(join(work, 'nosandbox')), false)
    const failing = yield* templated(['failing', '-t', 'broken'])
    assert.equal(failing.status, 1, failing.stderr)
    assert.match(failing.stderr, /silk: sh -c touch made; exit 3 failed with status 3\nsilk: the template's \[\[post-init\]\] entry failed, so the project was removed\n/)
    assert.equal(yield* fs.exists(join(work, 'failing')), false)
    const missing = yield* templated(['missing', '-t', 'silk-lang/examples/absent@v1'])
    assert.equal(missing.status, 1, missing.stderr)
    assert.match(missing.stderr, /Template silk-lang\/examples\/absent@v1 names no directory of its repository/)
    const rootless = yield* templated(['rootless', '-t', 'silk-lang/examples'])
    assert.equal(rootless.status, 1, rootless.stderr)
    assert.match(rootless.stderr, /Template silk-lang\/examples has no silk\.toml/)
    // `--list` names each directory with a silk.toml by what `--template` takes, with its description.
    const listed = yield* templated(['-l'])
    assert.equal(listed.status, 0, listed.stderr)
    assert.match(listed.stdout, /^Templates in silk-lang\/examples \([0-9a-f]{40}\):\n  broken\n  escape\n  garbled\n  library\n  quiet\n  ui       A window\nCreate a project from one with `silk init <path> --template <name>`\n$/)
    const listedFull = yield* templated(['--list', 'silk-lang/examples/ui@v1'])
    assert.equal(listedFull.status, 0, listedFull.stderr)
    assert.match(listedFull.stdout, /\n  ui@v1  A window\n/)
    // Without a template, a package is the official `default` template; a fetch that fails says why
    // and how to create a project offline.
    const defaulted = yield* templated(['plain'])
    assert.equal(defaulted.status, 1, defaulted.stderr)
    assert.match(defaulted.stderr, /^Template silk-lang\/examples\/default names no directory of its repository; `silk init --list` shows the official templates\n$/)
    const unreachable = yield* invoke(silk, ['init', 'offline', '-t', 'nobody/nothing'], work, { ...process.env, HOME: home, SILK_HOME: silkHome, XDG_CONFIG_HOME: join(home, '.config') })
    assert.equal(unreachable.status, 1, unreachable.stderr)
    assert.match(unreachable.stderr, /^Cannot fetch template nobody\/nothing: git fetch failed: .+\nCheck the template's name and your network connection, or add `-t minimal` to create a minimal project offline\n$/)
    assert.equal(yield* fs.exists(join(work, 'offline')), false)
    const malformed = yield* templated(['bad', '-t', 'silk-lang/examples@a..b'])
    assert.equal(malformed.status, 2, malformed.stderr)
    assert.match(malformed.stderr, /Template revision `a\.\.b` must be a branch, a tag or a full commit hash/)
  }
  // A workspace member builds against a sibling member by path and shares the workspace's output.
  const workspace = join(directory, 'workspace')
  yield* fs.makeDirectory(join(workspace, 'app'), { recursive: true })
  yield* fs.makeDirectory(join(workspace, 'libs/math'), { recursive: true })
  yield* fs.writeFileString(
    join(workspace, 'silk.toml'),
    '[workspace]\nmembers = ["app", "libs/*"]\n',
  )
  yield* fs.writeFileString(
    join(workspace, 'libs/math/silk.toml'),
    '[package]\nname = "math"\nversion = "0.1.0"\nsource = "."\nexports = ["twice"]\nsilk-version = "0.0.0"\n',
  )
  yield* fs.writeFileString(
    join(workspace, 'libs/math/twice.silk'),
    'pub fn twice(value: i32) -> i32 {\n  return value * 2\n}\n',
  )
  yield* fs.writeFileString(
    join(workspace, 'app/silk.toml'),
    '[package]\nname = "workspace-app"\nversion = "0.1.0"\nsource = "."\nsilk-version = "0.0.0"\n\n[dependencies]\nmath = { path = "../libs/math" }\n',
  )
  yield* fs.writeFileString(
    join(workspace, 'app/main.silk'),
    'import math.twice { twice }\n\npub fn main() -> i32 {\n  return twice(4)\n}\n',
  )
  const member = yield* invoke(silk, ['run', '--stdlib', standardLibrary], join(workspace, 'app'), {
    ...process.env,
    SILK_CLANG: clang,
  })
  assert.equal(member.status, 8, member.stderr)
  assert.equal(
    yield* fs.exists(join(workspace, 'build')),
    true,
    'members share the workspace output',
  )
  assert.equal(yield* fs.exists(join(workspace, 'app/build')), false)
  // From the workspace root, `run` runs the one member that has an entry; the library member,
  // which has none, is skipped with a note.
  const virtualRoot = yield* invoke(silk, ['run', '--stdlib', standardLibrary], workspace, {
    ...process.env,
    SILK_CLANG: clang,
  })
  assert.equal(virtualRoot.status, 8, virtualRoot.stderr)
  assert.match(virtualRoot.stderr, /Skipping math: its root module \(\[package\]\.main\) is missing/)
  yield* fs.makeDirectory(join(workspace, 'libs/empty'), { recursive: true })
  const unmanifested = yield* invoke(
    silk,
    ['run', '--stdlib', standardLibrary],
    join(workspace, 'app'),
    { ...process.env, SILK_CLANG: sentinel },
  )
  assert.notEqual(unmanifested.status, 0, 'a member without a manifest was accepted')
  assert.match(unmanifested.stderr, /libs\/empty` names a directory without a silk\.toml/)
  // A package the workspace does not list keeps its own output, and the workspace's broken
  // entries are not its concern.
  yield* fs.makeDirectory(join(workspace, 'tool'), { recursive: true })
  yield* fs.writeFileString(
    join(workspace, 'tool/silk.toml'),
    '[package]\nname = "tool"\nversion = "0.1.0"\nsource = "."\nsilk-version = "0.0.0"\n',
  )
  yield* fs.writeFileString(
    join(workspace, 'tool/main.silk'),
    'pub fn main() -> i32 {\n  return 3\n}\n',
  )
  const outsider = yield* invoke(
    silk,
    ['run', '--stdlib', standardLibrary],
    join(workspace, 'tool'),
    {
      ...process.env,
      SILK_CLANG: clang,
    },
  )
  assert.equal(outsider.status, 3, outsider.stderr)
  assert.equal(yield* fs.exists(join(workspace, 'tool/build')), true)
  assert.equal(yield* fs.exists(marker), false)
  // `init --workspace`, `init` inside it and `add` assemble a workspace from the command line, and
  // the building commands run over its members from the workspace root.
  const managed = join(directory, 'managed')
  const withClang = { ...process.env, SILK_CLANG: clang }
  const managedRoot = yield* invoke(silk, ['init', '--workspace', 'managed'], directory)
  assert.equal(managedRoot.status, 0, managedRoot.stderr)
  // A new workspace has one starter executable member, so it builds and runs at once.
  assert.equal(
    yield* fs.readFileString(join(managed, 'silk.toml')),
    `[workspace]\nmembers = ["app"]\nsilk-version = "${reportedVersion}"\n`,
  )
  assert.equal(managedRoot.stdout, '  Created workspace managed with package app\n\n  Next steps:\n    cd managed\n    silk dev   run it, and run it again when you change it\n')
  assert.equal(yield* fs.exists(join(managed, 'app/src/main.silk')), true)
  assert.equal(yield* fs.exists(join(managed, 'app/.gitignore')), false)
  const starterRun = yield* invoke(silk, ['run', '--stdlib', standardLibrary], managed, withClang)
  assert.equal(starterRun.status, 0, starterRun.stderr)
  assert.match(starterRun.stdout, /Hello, world!/)
  const namedRoot = yield* invoke(silk, ['init', '--workspace', 'named', '--name', 'store'], directory)
  assert.equal(namedRoot.status, 0, namedRoot.stderr)
  assert.equal(
    yield* fs.readFileString(join(directory, 'named/silk.toml')),
    `[workspace]\nmembers = ["store"]\nsilk-version = "${reportedVersion}"\n`,
  )
  assert.match(yield* fs.readFileString(join(directory, 'named/store/silk.toml')), /^name = "store"$/m)
  // The rest of this test assembles its members by hand.
  yield* fs.remove(join(managed, 'app'), { recursive: true })
  yield* fs.remove(join(managed, 'build'), { recursive: true })
  yield* fs.writeFileString(join(managed, 'silk.toml'), '[workspace]\nmembers = []\n')
  const hello = yield* invoke(silk, ['init', 'apps/hello', '-t', 'minimal'], managed)
  assert.equal(hello.status, 0, hello.stderr)
  assert.match(hello.stdout, /^  Created apps\/hello from the minimal template\n  Added apps\/hello to the managed workspace\n\n/)
  const greeting = yield* invoke(silk, ['init', '--lib', 'libs/greeting'], managed)
  assert.equal(greeting.status, 0, greeting.stderr)
  assert.equal(greeting.stdout, '  Created library libs/greeting\n  Added libs/greeting to the managed workspace\n\n  Next steps:\n    cd libs/greeting\n    silk test   run its tests\n')
  assert.equal(
    yield* fs.readFileString(join(managed, 'silk.toml')),
    '[workspace]\nmembers = ["apps/hello", "libs/greeting"]\n',
  )
  // Members build into the workspace's output directory, which only the workspace ignores.
  assert.equal(yield* fs.exists(join(managed, '.gitignore')), true)
  assert.equal(yield* fs.exists(join(managed, 'apps/hello/.gitignore')), false)
  const added = yield* invoke(silk, ['add', '../../libs/greeting'], join(managed, 'apps/hello'))
  assert.equal(added.status, 0, added.stderr)
  assert.match(
    yield* fs.readFileString(join(managed, 'apps/hello/silk.toml')),
    /\n\[dependencies\]\ngreeting = \{ path = "\.\.\/\.\.\/libs\/greeting" \}\n$/,
  )
  const again = yield* invoke(silk, ['add', '../../libs/greeting'], join(managed, 'apps/hello'))
  assert.notEqual(again.status, 0, 'a dependency was added twice')
  assert.match(again.stderr, /already has a dependency of that name/)
  const cycle = yield* invoke(silk, ['add', '../../apps/hello'], join(managed, 'libs/greeting'))
  assert.notEqual(cycle.status, 0, 'a dependency cycle was added')
  assert.match(
    cycle.stderr,
    /dependency `hello`: hello@0\.1\.0 already depends on greeting@0\.1\.0, directly or through other packages, so adding it would form a cycle/,
  )
  assert.doesNotMatch(yield* fs.readFileString(join(managed, 'libs/greeting/silk.toml')), /hello/)
  // A workspace is not a dependency; the refusal names its members rather than blaming its manifest.
  const whole = yield* invoke(silk, ['add', '../..'], join(managed, 'libs/greeting'))
  assert.equal(whole.status, 2, whole.stderr)
  assert.match(
    whole.stderr,
    /dependency `\.\.\/\.\.`: it is a workspace; add one of its members: apps\/hello, libs\/greeting/,
  )
  yield* fs.writeFileString(
    join(managed, 'apps/hello/src/main.silk'),
    'import greeting.lib { add }\n\npub fn main() -> i32 {\n  return add(4, 3)\n}\n',
  )
  const managedBuild = yield* invoke(
    silk,
    ['build', '--stdlib', standardLibrary],
    managed,
    withClang,
  )
  assert.equal(managedBuild.status, 0, managedBuild.stderr + managedBuild.stdout)
  // Members build in dependency order, whatever order `members` lists them in.
  // A library member is only checked; it makes no artifact of its own.
  assert.match(managedBuild.stderr, /^Checking greeting \(.*\)\n[\s\S]*^Compiling hello \(/m)
  assert.match(managedBuild.stderr, /^Finished greeting in [^\n]+$/m)
  // Each artifact is named from the working directory, the workspace root here, not its package.
  assert.match(
    managedBuild.stderr,
    new RegExp(`^Finished build/${hostTarget}/dev/hello in `, 'm'),
  )
  assert.doesNotMatch(managedBuild.stderr, /^Finished \.\./m)
  assert.equal(managedBuild.stdout, '')
  const managedRun = yield* invoke(
    silk,
    ['run', '-p', 'hello', '--stdlib', standardLibrary],
    managed,
    withClang,
  )
  assert.equal(managedRun.status, 7, managedRun.stderr)
  // With one executable member, `run` at the root runs it.
  const onlyRunnable = yield* invoke(silk, ['run', '--stdlib', standardLibrary], managed, withClang)
  assert.equal(onlyRunnable.status, 7, onlyRunnable.stderr)
  // `run` reports its build as `build` does, and a failed one ends with its `Failed` line on
  // standard error; standard output is left to the program. The package's tasks program is
  // built first, with the same Clang, so it is the one that fails here.
  const unlinked = yield* invoke(
    silk,
    ['run', '-p', 'hello', '--stdlib', standardLibrary, '--clang', join(managed, 'no-such-clang')],
    managed,
    withClang,
  )
  assert.equal(unlinked.status, 2, unlinked.stderr)
  assert.equal(unlinked.stdout, '')
  assert.match(unlinked.stderr, /^Compiling hello tasks \(/m)
  assert.match(unlinked.stderr, /^  link      failed +[0-9.ms ]+s$/m)
  assert.match(unlinked.stderr, /^Failed hello in /m)
  assert.doesNotMatch(unlinked.stderr + unlinked.stdout, /Run summary/)
  const other = yield* invoke(silk, ['init', 'apps/other', '-t', 'minimal'], managed)
  assert.equal(other.status, 0, other.stderr)
  const unchosen = yield* invoke(silk, ['run', '--stdlib', standardLibrary], managed, {
    ...process.env,
    SILK_CLANG: sentinel,
  })
  assert.notEqual(unchosen.status, 0, 'run picked one of several members')
  assert.match(unchosen.stderr, /pass --package <name>/)
  const managedTest = yield* invoke(
    silk,
    ['test', '-p', 'greeting', '--no-cache', '--stdlib', standardLibrary],
    managed,
    withClang,
  )
  assert.equal(managedTest.status, 0, managedTest.stderr + managedTest.stdout)
  assert.match(managedTest.stdout, /addsTwoNumbers/)
  // A filter passes when it matches a test in any member, even if other members match none.
  const filteredWorkspace = yield* invoke(
    silk,
    ['test', '--workspace', '--filter', 'addsTwo', '--stdlib', standardLibrary],
    managed,
    withClang,
  )
  assert.equal(filteredWorkspace.status, 0, filteredWorkspace.stderr + filteredWorkspace.stdout)
  assert.match(filteredWorkspace.stdout, /addsTwoNumbers/)
  assert.doesNotMatch(filteredWorkspace.stderr, /no tests matched/)
  const unmatchedWorkspace = yield* invoke(
    silk,
    ['test', '--workspace', '--filter', 'no-such-workspace-test', '--stdlib', standardLibrary],
    managed,
    withClang,
  )
  assert.equal(unmatchedWorkspace.status, 1, unmatchedWorkspace.stderr + unmatchedWorkspace.stdout)
  assert.equal((unmatchedWorkspace.stderr.match(/no tests matched/g) ?? []).length, 1)
  const narrowedWorkspace = yield* invoke(
    silk,
    ['test', '--workspace', '--root', 'src/lib.silk', '--stdlib', standardLibrary],
    managed,
    withClang,
  )
  assert.equal(narrowedWorkspace.status, 2, narrowedWorkspace.stderr + narrowedWorkspace.stdout)
  assert.match(narrowedWorkspace.stderr, /pass --package <name>/)
  // From a member directory, `--workspace` selects every member.
  const managedCheck = yield* invoke(
    silk,
    ['check', '--workspace', '--stdlib', standardLibrary],
    join(managed, 'apps/hello'),
  )
  assert.equal(managedCheck.status, 0, managedCheck.stderr + managedCheck.stdout)
  assert.match(managedCheck.stderr, /^Finished 3 packages in /m)
  const unknownMember = yield* invoke(
    silk,
    ['build', '-p', 'nope', '--stdlib', standardLibrary],
    managed,
  )
  assert.notEqual(unknownMember.status, 0, 'an unknown member was selected')
  assert.match(
    unknownMember.stderr,
    /has no package named `nope`\nsilk: its members are: greeting, hello, other\n/,
  )
  // An imported dependency cycle fails its members; the others still run and the workspace's
  // final line is still written. An unused manifest pin does not enter the compilation graph.
  const greetingManifest = join(managed, 'libs/greeting/silk.toml')
  const acyclic = yield* fs.readFileString(greetingManifest)
  const greetingLibrary = join(managed, 'libs/greeting/src/lib.silk')
  const greetingSource = yield* fs.readFileString(greetingLibrary)
  yield* fs.writeFileString(
    greetingManifest,
    `${acyclic}\n[dependencies]\nhello = { path = "../../apps/hello" }\n`,
  )
  yield* fs.writeFileString(greetingLibrary, `import hello.main\n${greetingSource}`)
  const cyclic = yield* invoke(silk, ['check', '--stdlib', standardLibrary], managed)
  assert.notEqual(cyclic.status, 0, 'a dependency cycle was checked')
  assert.match(cyclic.stderr, /form a cycle/)
  assert.match(cyclic.stderr, /^Checking other \(/m)
  assert.match(cyclic.stderr, /^Failed 2 of 3 packages in [^\n]*\n$/m)
  yield* fs.writeFileString(greetingManifest, acyclic)
  yield* fs.writeFileString(greetingLibrary, greetingSource)
  // `format` and `doc` at the root cover every member.
  const managedFormat = yield* invoke(silk, ['format'], managed)
  assert.equal(managedFormat.status, 0, managedFormat.stderr + managedFormat.stdout)
  const managedFormatCheck = yield* invoke(silk, ['format', '--check'], managed)
  assert.equal(managedFormatCheck.status, 0, managedFormatCheck.stderr + managedFormatCheck.stdout)
  const managedDoc = yield* invoke(silk, ['doc', '--stdlib-root', standardLibrary], managed)
  assert.equal(managedDoc.status, 0, managedDoc.stderr + managedDoc.stdout)
  assert.equal(yield* fs.exists(join(managed, 'build/documentation/greeting.json')), true)
  assert.equal(yield* fs.exists(join(managed, 'build/documentation/hello.json')), true)
  // `format .` and `doctest` at the root also cover every member; a member with no examples
  // passes while another has some.
  const managedFormatDot = yield* invoke(silk, ['format', '--check', '.'], managed)
  assert.equal(managedFormatDot.status, 0, managedFormatDot.stderr + managedFormatDot.stdout)
  assert.match(managedFormatDot.stdout, /apps\/hello\/src\/main\.silk: unchanged/)
  assert.match(managedFormatDot.stdout, /libs\/greeting\/src\//)
  yield* fs.writeFileString(
    greetingLibrary,
    greetingSource +
      [
        '',
        '/// Two times `value`.',
        '///',
        '/// ```silk',
        '/// import greeting.lib { twice }',
        '///',
        '/// pub fn main() -> i32 {',
        '///   return twice(2) - 4',
        '/// }',
        '/// ```',
        'pub fn twice(value: i32) -> i32 {',
        '  return value * 2',
        '}',
        '',
      ].join('\n'),
  )
  const managedDoctest = yield* invoke(
    silk,
    ['doctest', '--stdlib-root', standardLibrary],
    managed,
    withClang,
  )
  assert.equal(managedDoctest.status, 0, managedDoctest.stderr + managedDoctest.stdout)
  assert.match(managedDoctest.stdout, /^Package greeting\n[^\n]*libs\/greeting\/src\/lib\.silk:\d+ \(byte \d+\): PASSED\n/m)
  assert.match(managedDoctest.stdout, /^Package hello\n/m)
  const oneFile = yield* invoke(
    silk,
    ['doc', '--stdlib-root', standardLibrary, '--output', 'x.json'],
    managed,
  )
  assert.notEqual(oneFile.status, 0, 'one --output file was written for a whole workspace')
  const dropped = yield* invoke(silk, ['remove', 'greeting'], join(managed, 'apps/hello'))
  assert.equal(dropped.status, 0, dropped.stderr)
  // The emptied [dependencies] table goes with its last entry.
  assert.doesNotMatch(
    yield* fs.readFileString(join(managed, 'apps/hello/silk.toml')),
    /greeting = |\[dependencies\]/,
  )
  const managedClean = yield* invoke(silk, ['clean'], managed)
  assert.equal(managedClean.status, 0, managedClean.stderr)
  assert.equal(yield* fs.exists(join(managed, 'build')), false)
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
    '[package]\nname = "retained"\nversion = "0.1.0"\nsource = "."\nsilk-version = "0.0.0"\n\n[unstable]\ncomposition = { runtimes = [{ name = "start", module = "support/start" }], defaults = ["start"], retention = [{ module = "support/keep", declaration = "capability" }] }\n',
  )
  const retainedIr = yield* compileSettings(join(directory, 'retained'), 'retained', '[settings]\nemit = "llvm-ir"\n')
  assert.equal(retainedIr.status, 0, retainedIr.stderr)
  const retainedText = yield* fs.readFileString(compilationPath(join(directory, 'retained'), 'retained'))
  assert.match(retainedText, /i32 7177/)
  assert.match(
    retainedText,
    /^@llvm\.used = appending global \[1 x ptr\] \[ptr @[^\]]+\], section "llvm\.metadata"$/m,
  )
  // A `none` runtime request selects no hosted start: the application's own C `main` is the entry.
  yield* fs.makeDirectory(join(directory, 'bare'), { recursive: true })
  yield* fs.writeFileString(
    join(directory, 'bare/main.silk'),
    'export "C" fn start() -> i32 as "main" {\n  return 6\n}\n',
  )
  yield* fs.writeFileString(
    join(directory, 'bare/silk.toml'),
    '[package]\nname = "bare"\nversion = "0.1.0"\nsource = "."\nsilk-version = "0.0.0"\n',
  )
  const bare = yield* compileSettings(join(directory, 'bare'), 'bare', '[settings.profile]\nruntime = "none"\n')

  assert.equal(bare.status, 0, bare.stderr)
  const bareRun = yield* invoke(compilationPath(join(directory, 'bare'), 'bare'), [], directory)
  assert.equal(bareRun.status, 6, bareRun.stderr)
  // Check mode must not rewrite drift; formatting fixes intact inputs without damaging rejected ones.
  const formatting = join(directory, 'formatting')
  yield* fs.makeDirectory(join(formatting, 'src'), { recursive: true })
  yield* fs.writeFileString(
    join(formatting, 'silk.toml'),
    '[package]\nname = "formatting"\nversion = "0.1.0"\nmain = "a.silk"\nsilk-version = "0.0.0"\n',
  )
  yield* fs.writeFileString(join(formatting, 'src/a.silk'), 'pub fn a() -> i32 {\n  return 1\n}\n')
  yield* fs.writeFileString(join(formatting, 'src/b.silk'), 'pub fn b()->i32{return 2}\n')
  yield* fs.writeFileString(join(formatting, 'src/c.silk'), 'pub fn c( {\n')
  const formatChecked = yield* invoke(silk, ['format', '--check'], formatting)
  assert.equal(formatChecked.status, 1, formatChecked.stderr)
  assert.equal(
    yield* fs.readFileString(join(formatting, 'src/b.silk')),
    'pub fn b()->i32{return 2}\n',
  )
  const rewritten = yield* invoke(silk, ['format'], formatting)
  assert.equal(rewritten.status, 1, rewritten.stderr)
  assert.equal(
    yield* fs.readFileString(join(formatting, 'src/b.silk')),
    'pub fn b() -> i32 {\n  return 2\n}\n',
  )
  assert.equal(yield* fs.readFileString(join(formatting, 'src/c.silk')), 'pub fn c( {\n')
  const cleanedByPath = yield* invoke(silk, ['clean', '--manifest-path', manifest], directory)
  assert.equal(cleanedByPath.status, 0, cleanedByPath.stderr)
  assert.equal(yield* fs.exists(join(directory, 'greeting/build')), false)
  // Dependency paths and source files may go through symbolic links, as /tmp does on macOS.
  const throughLinks = join(directory, 'through-links')
  yield* fs.makeDirectory(join(throughLinks, 'real/shared/src'), { recursive: true })
  yield* fs.makeDirectory(join(throughLinks, 'app/src'), { recursive: true })
  yield* fs.writeFileString(
    join(throughLinks, 'real/shared/silk.toml'),
    '[package]\nname = "shared"\nversion = "0.1.0"\nsource = "src"\nexports = ["numbers"]\nsilk-version = "0.0.0"\n',
  )
  yield* fs.writeFileString(
    join(throughLinks, 'real/shared/src/numbers.silk'),
    'pub fn six() -> i32 { return 6 }\n',
  )
  yield* fs.writeFileString(
    join(throughLinks, 'real/helper.silk'),
    'pub fn one() -> i32 { return 1 }\n',
  )
  yield* fs.symlink('real', join(throughLinks, 'via'))
  yield* fs.symlink('../../real/helper.silk', join(throughLinks, 'app/src/helper.silk'))
  yield* fs.writeFileString(
    join(throughLinks, 'app/silk.toml'),
    '[package]\nname = "app"\nversion = "0.1.0"\nsilk-version = "0.0.0"\n\n[dependencies]\nshared = { path = "../via/shared" }\n',
  )
  yield* fs.writeFileString(
    join(throughLinks, 'app/src/main.silk'),
    'import helper { one }\nimport shared.numbers { six }\npub fn main() -> i32 { return one() + six() }\n',
  )
  const linkedRun = yield* invoke(
    silk,
    ['run', '--stdlib', standardLibrary],
    join(throughLinks, 'app'),
    { ...process.env, SILK_CLANG: clang },
  )
  assert.equal(linkedRun.status, 7, linkedRun.stderr)
  // An output path may go through symbolic links too: a relative one, an absolute one, and a
  // chain of them. A link that loops is reported instead of followed forever.
  yield* fs.symlink(join(throughLinks, 'real'), join(throughLinks, 'absolute'))
  yield* fs.symlink('via', join(throughLinks, 'chain'))
  for (const output of ['via/linked', 'absolute/absolute', 'chain/chained']) {
    const built = yield* compileSettings(join(throughLinks, 'app'), basename(output), '',
      { ...process.env, SILK_CLANG: clang }, 'executable', join(throughLinks, output))
    assert.equal(built.status, 0, built.stderr)
    const ran = yield* invoke(join(throughLinks, 'real', basename(output)), [], throughLinks)
    assert.equal(ran.status, 7, ran.stderr)
  }
  yield* fs.symlink('loop', join(throughLinks, 'loop'))
  const looped = yield* compileSettings(join(throughLinks, 'app'), 'looped', '',
    { ...process.env, SILK_CLANG: clang }, 'executable', join(throughLinks, 'loop/program'))
  assert.equal(looped.status, 1, looped.stderr)
  assert.match(looped.stderr, /^silk: cannot create temporary directory: invalid path\n$/)
  // Cleaning removes a link in the build directory itself, never what it points to.
  yield* fs.symlink('../../real', join(throughLinks, 'app/build/escape'))
  const cleanedLinks = yield* invoke(silk, ['clean'], join(throughLinks, 'app'))
  assert.equal(cleanedLinks.status, 0, cleanedLinks.stderr)
  assert.equal(yield* fs.exists(join(throughLinks, 'app/build')), false)
  assert.equal(yield* fs.exists(join(throughLinks, 'real/helper.silk')), true)
  // A link to a missing source file is a missing module, as the file it names is missing.
  yield* fs.symlink('../../real/missing.silk', join(throughLinks, 'app/src/gone.silk'))
  yield* fs.writeFileString(
    join(throughLinks, 'app/src/main.silk'),
    'import gone { x }\npub fn main() -> i32 { return 0 }\n',
  )
  const dangling = yield* invoke(
    silk,
    ['check', '--stdlib', standardLibrary],
    join(throughLinks, 'app'),
  )
  assert.equal(dangling.status, 1, dangling.stderr)
  assert.match(dangling.stderr, /error\[MOD0001\] Unknown module gone$/m)
  // Two commands that build one package at once keep their intermediate files apart, and the
  // run finds a whole executable however the other command's link is going.
  const together = join(directory, 'together')
  yield* fs.makeDirectory(join(together, 'src'), { recursive: true })
  yield* fs.writeFileString(
    join(together, 'silk.toml'),
    '[package]\nname = "together"\nversion = "0.1.0"\nsilk-version = "0.0.0"\n',
  )
  yield* fs.writeFileString(join(together, 'src/main.silk'), 'pub fn main() -> i32 { return 5 }\n')
  const started = (args: ReadonlyArray<string>) =>
    new Promise<{ status: number | null; stderr: string }>((settle) => {
      const child = spawn(silk, [...args, '--stdlib', standardLibrary], {
        cwd: together,
        env: { ...process.env, SILK_CLANG: clang },
      })
      let stderr = ''
      child.stderr.on('data', (chunk) => (stderr += chunk))
      child.on('close', (status) => {
        settleCaches(together)
        settle({ status, stderr })
      })
    })
  for (let round = 0; round < 4; round += 1) {
    yield* fs.remove(join(together, 'build'), { recursive: true, force: true })
    const [built, ran] = yield* Effect.promise(() =>
      Promise.all([started(['build']), started(['run', '--quiet'])]),
    )
    assert.equal(built.status, 0, built.stderr)
    assert.equal(ran.status, 5, ran.stderr)
  }
  const leftover = yield* fs.readDirectory(join(together, 'build', hostTarget, 'dev'))
  assert.deepEqual(leftover.filter((name) => name.startsWith('.silk-')), [])
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
  yield* fs.writeFileString(join(library, 'silk.toml'),
    '[package]\nname = "library"\nversion = "0.1.0"\nmain = "Main.silk"\nkind = "library"\nsilk-version = "0.0.0"\n')
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
  const compiledHelper = yield* invoke(clang, ['-c', '-fPIC', 'offset.c', '-o', 'offset.o'], library)
  assert.equal(compiledHelper.status, 0, compiledHelper.stderr)
  const linkedObject = `[settings.native]\nlink = [{ kind = "object", value = ${encodeJson(join(library, 'offset.o'))}, weak = false, needed = false }]\n`
  const libraryBuild = Effect.fnUntraced(function* (
    name: string, artifact: string, settings = '[settings.profile]\n',
    env: NodeJS.ProcessEnv = { ...process.env, SILK_CLANG: clang },
  ) {
    const built = yield* compileSettings(library, name, settings, env, artifact)
    if (built.status === 0) yield* fs.copyFile(compilationPath(library, name), join(library, name))
    return built
  })
  const object = yield* libraryBuild('silk.o', 'object')
  assert.equal(object.status, 0, object.stderr)
  const relocatable = yield* inspect('silk.o')
  assert.match(relocatable.header, /Type: Relocatable|MH_OBJECT/)
  assert.ok(exported(relocatable.symbols, 'silk_answer'), relocatable.symbols.join('\n'))
  assert.ok(!exported(relocatable.symbols, 'main'), 'an object acquires no startup')
  assert.ok(!exported(relocatable.symbols, 'offset'), 'an undeclared foreign definition stays external')
  const consumer = yield* invoke(clang, ['consumer.c', 'silk.o', 'offset.o', '-o', 'consumer'], library)
  assert.equal(consumer.status, 0, consumer.stderr)
  assert.equal((yield* invoke(join(library, 'consumer'), [], library)).status, 0)
  const merged = yield* libraryBuild('merged.o', 'object', linkedObject)
  assert.equal(merged.status, 0, merged.stderr)
  const mergedSymbols = yield* inspect('merged.o')
  assert.ok(exported(mergedSymbols.symbols, 'silk_answer') && exported(mergedSymbols.symbols, 'offset'))
  const mergedConsumer = yield* invoke(clang, ['consumer.c', 'merged.o', '-o', 'merged-consumer'], library)
  assert.equal(mergedConsumer.status, 0, mergedConsumer.stderr)
  assert.equal((yield* invoke(join(library, 'merged-consumer'), [], library)).status, 0)
  const unmergeable = yield* libraryBuild('unmergeable.o', 'object',
    '[settings.native]\nlink = [{ kind = "library", value = "m", mode = "dynamic", weak = false, needed = false }]\n',
    { ...process.env, SILK_CLANG: sentinel })
  assert.notEqual(unmergeable.status, 0, 'a library input was merged into an object')
  assert.equal(yield* fs.exists(marker), false)
  for (const artifact of ['object', 'static-archive']) {
    for (const [target, machine] of [
      ['x86_64-unknown-linux-gnu', /Format: elf64-x86-64/],
      ['aarch64-unknown-linux-gnu', /Format: elf64-littleaarch64/],
      ['aarch64-apple-darwin', /Format: Mach-O arm64/],
    ] as const) {
      const name = `${artifact}-${target}`
      const crossed = yield* libraryBuild(name, artifact, `[settings.profile]\ntarget = "${target}"\n`)
      assert.equal(crossed.status, 0, crossed.stderr)
      const inspected = yield* inspect(name)
      assert.match(inspected.header, machine)
      assert.ok(exported(inspected.symbols, 'silk_answer'), inspected.symbols.join('\n'))
      assert.ok(!exported(inspected.symbols, 'main'), `${target}: an artifact acquires no startup`)
    }
  }
  // Intermediate emissions retain artifact roots and do not merge native inputs.
  for (const [name, emit] of [['form.ll', 'llvm-ir'], ['form.bc', 'llvm-bitcode'], ['form.s', 'assembly'], ['staged.o', 'object']]) {
    const staged = yield* libraryBuild(name, 'object', `[settings]\nemit = "${emit}"\n${linkedObject}`)
    assert.equal(staged.status, 0, staged.stderr)
  }
  const formText = yield* fs.readFileString(join(library, 'form.ll'))
  assert.match(formText, /^define [^\n]*@"?silk_answer"?\(/m)
  assert.doesNotMatch(formText, /^define [^\n]*@"?main"?\(/m)
  assert.match(yield* fs.readFileString(join(library, 'form.s')), /silk_answer:/)
  assert.equal(Buffer.from(yield* fs.readFile(join(library, 'form.bc'))).subarray(0, 2).toString(), 'BC')
  assert.ok(!exported((yield* inspect('staged.o')).symbols, 'offset'), 'an intermediate emission merged an input')
  const members = Effect.fnUntraced(function* (archive: string) {
    const listed = yield* invoke(join(tools, 'llvm-ar'), ['t', archive], library)
    assert.equal(listed.status, 0, listed.stderr)
    return listed.stdout.split('\n').filter((line) => line.length > 0)
  })
  const { SILK_LLVM_AR: _configuredArchiver, ...inherited } = process.env
  const archiveEnvironment = { ...inherited, SILK_CLANG: clang }
  const bundled = yield* libraryBuild('libsilk.a', 'static-archive', linkedObject, archiveEnvironment)
  assert.equal(bundled.status, 0, bundled.stderr)
  assert.deepEqual(yield* members('libsilk.a'), ['artifact.silk.o', 'offset.o'])
  const bundledConsumer = yield* invoke(clang, ['consumer.c', 'libsilk.a', '-o', 'bundled-consumer'], library)
  assert.equal(bundledConsumer.status, 0, bundledConsumer.stderr)
  assert.equal((yield* invoke(join(library, 'bundled-consumer'), [], library)).status, 0)
  const rebuilt = yield* libraryBuild('libsilk.a', 'static-archive', '[settings.profile]\n', archiveEnvironment)
  assert.equal(rebuilt.status, 0, rebuilt.stderr)
  assert.deepEqual(yield* members('libsilk.a'), ['artifact.silk.o'])
  const archived = yield* inspect('libsilk.a')
  assert.ok(exported(archived.symbols, 'silk_answer') && !exported(archived.symbols, 'main'))
  const archiveConsumer = yield* invoke(clang, ['consumer.c', 'libsilk.a', 'offset.o', '-o', 'archive-consumer'], library)
  assert.equal(archiveConsumer.status, 0, archiveConsumer.stderr)
  assert.equal((yield* invoke(join(library, 'archive-consumer'), [], library)).status, 0)
  const nested = yield* libraryBuild('nested.a', 'static-archive',
    `[settings.native]\nlink = [{ kind = "archive", value = ${encodeJson(join(library, 'libsilk.a'))}, weak = false, needed = false }]\n`,
    { ...process.env, SILK_CLANG: sentinel })
  assert.notEqual(nested.status, 0, 'an archive input was nested in a static archive')
  assert.match(nested.stderr, /a static archive cannot contain the archive/)
  assert.equal(yield* fs.exists(marker), false)
  // A named library is for the final link of the program that uses the archive: it adds no member.
  const mathArchive = yield* libraryBuild('libmath.a', 'static-archive',
    '[settings.native]\nlink = [{ kind = "library", value = "m", mode = "dynamic", weak = false, needed = false }]\n',
    archiveEnvironment)
  assert.equal(mathArchive.status, 0, mathArchive.stderr)
  assert.deepEqual(yield* members('libmath.a'), ['artifact.silk.o'])
  const unarchived = yield* libraryBuild('unarchived.a', 'static-archive', '[settings.profile]\n',
    { ...process.env, SILK_CLANG: clang, SILK_LLVM_AR: sentinel })
  assert.notEqual(unarchived.status, 0, 'a failed archiver reported success')
  assert.equal(yield* fs.exists(compilationPath(library, 'unarchived.a')), false)
  yield* fs.remove(marker)
  // Emitted headers describe the actual aggregate and callback ABI. Platform inputs survive
  // request replay and reach the final binary, including resources and the import library.
  const platformLibrary = join(directory, 'platform-library')
  yield* fs.makeDirectory(platformLibrary)
  const nativeDependency = join(platformLibrary, 'native-dependency')
  yield* fs.makeDirectory(nativeDependency)
  yield* fs.writeFileString(join(nativeDependency, 'silk.toml'),
    '[package]\nname = "native-dependency"\nversion = "0.1.0"\nkind = "library"\nsource = "."\nexports = ["Value"]\nsilk-version = "0.0.0"\n')
  yield* fs.writeFileString(join(nativeDependency, 'Value.silk'),
    'unsafe extern "C" fn native_answer() -> i32\npub fn answer() -> i32 { return unsafe native_answer() }\n')
  yield* fs.writeFileString(join(nativeDependency, 'answer.c'), 'int native_answer(void) { return 42; }\n')
  yield* writePlan(nativeDependency, '  plan = Plan.compileC(plan, sourcePath("answer.c"))')
  yield* fs.writeFileString(join(platformLibrary, 'silk.toml'),
    '[package]\nname = "platform-library"\nversion = "0.1.0"\nkind = "library"\nsource = "."\nmain = "main.silk"\nsilk-version = "0.0.0"\n'
      + '[dependencies]\nnative = { path = "native-dependency" }\n')
  yield* fs.writeFileString(join(platformLibrary, 'main.silk'), [
    'import native.Value',
    'extern "C" struct Pair { a: i32, b: i32 }',
    'export "C" fn pair(value: Pair) -> Pair as "silk_pair" { return Pair { a: value.a + 1, b: value.b + 2 } }',
    '@callbacks("call")',
    'unsafe export "C" fn callback(call: extern "C" fn(i32) -> i32, value: i32) -> i32 as "silk_callback" { return unsafe call(value) }',
    'export "C" fn answer() -> i32 as "silk_answer" { return Value.answer() }',
    '',
  ].join('\n'))
  yield* fs.writeFileString(join(platformLibrary, 'test.rc'), '42 RCDATA { 1, 2, 3, 4 }\n')
  yield* fs.writeFileString(join(platformLibrary, 'test.manifest'),
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0"><assemblyIdentity version="1.0.0.0" processorArchitecture="amd64" name="silk.test" type="win32"/></assembly>')
  for (const [target, name] of [
    [hostTarget, 'host-shared'],
    ['x86_64-pc-windows-msvc', 'windows-shared'],
    ['aarch64-apple-darwin', 'darwin-shared'],
  ]) {
    const header = join(platformLibrary, `${name}.h`)
    let settings = `[settings]\nheader = ${encodeJson(header)}\n`
    if (name === 'windows-shared') settings +=
      `import-library = ${encodeJson(join(platformLibrary, 'api.lib'))}\n[settings.windows]\nsubsystem = "windows"\nmanifest = ${encodeJson(join(platformLibrary, 'test.manifest'))}\nresources = [${encodeJson(join(platformLibrary, 'test.rc'))}]\n`
    if (name === 'darwin-shared') settings += '[settings.macos]\ninstall-name = "@rpath/libsilk.dylib"\n'
    settings += `[settings.profile]\ntarget = "${target}"\noptimization = "speed"\ndebug = false\n`
    const built = yield* compileSettings(platformLibrary, name, settings, undefined, 'loadable-module')
    assert.equal(built.status, 0, built.stderr)
    const artifact = compilationPath(platformLibrary, name)
    if (name === 'host-shared') {
      const contents = yield* fs.readFileString(header)
      const pair = /(\w+) silk_pair\(/.exec(contents)?.[1]
      assert.ok(pair, contents)
      const copied = join(platformLibrary, process.platform === 'darwin' ? 'api.dylib' : 'api.so')
      yield* fs.copyFile(artifact, copied)
      yield* fs.writeFileString(join(platformLibrary, 'client.c'),
        `#include "${name}.h"\nstatic int next(int x) { return x + 1; }\nint main(void) { ${pair} p = silk_pair((${pair}){40, 40}); return p.field_a != 41 || p.field_b != 42 || silk_callback(next, 41) != 42 || silk_answer() != 42; }\n`)
      const client = yield* invoke(clang, ['client.c', copied, `-Wl,-rpath,${platformLibrary}`, '-o', 'client'], platformLibrary)
      assert.equal(client.status, 0, client.stderr)
      assert.equal((yield* invoke(join(platformLibrary, 'client'), [], platformLibrary)).status, 0)
    } else if (name === 'windows-shared') {
      assert.equal(yield* fs.exists(join(platformLibrary, 'api.lib')), true)
      const inspected = yield* invoke(join(tools, 'llvm-readobj'), ['--file-headers', '--coff-resources', '--coff-exports', artifact], platformLibrary)
      assert.equal(inspected.status, 0, inspected.stderr)
      assert.match(inspected.stdout, /IMAGE_SUBSYSTEM_WINDOWS_GUI/)
      assert.match(inspected.stdout, /silk_answer/)
      assert.match(inspected.stdout, /RCDATA|ID: 10/)
      assert.match(inspected.stdout, /MANIFEST|ID: 24/)
    } else {
      const inspected = yield* invoke(join(tools, 'llvm-objdump'), ['--macho', '--dylib-id', artifact], platformLibrary)
      assert.equal(inspected.status, 0, inspected.stderr)
      assert.match(inspected.stdout, /@rpath\/libsilk\.dylib/)
    }
  }
  // Both code generators honor explicit imported shared memory and table exports for reactors.
  yield* fs.writeFileString(join(platformLibrary, 'main.silk'), 'export "C" fn answer() -> i32 as "silk_answer" { return 42 }\n')
  for (const backend of ['llvm', 'direct']) {
    const name = `memory-${backend}`
    const built = yield* compileSettings(platformLibrary, name,
      `[settings.wasm]\nimport-memory = true\nshared-memory = true\nexport-table = true\nexecution-model = "reactor"\n[settings.profile]\ntarget = "wasm32-unknown-unknown"\nbackend = "${backend}"\nmax-memory = 16777216\n`, undefined, 'loadable-module')
    assert.equal(built.status, 0, built.stderr)
    const bytes = yield* fs.readFile(compilationPath(platformLibrary, name))
    const module = yield* Effect.try({ try: () => new WebAssembly.Module(bytes), catch: (cause) => new VerificationError({ message: 'invalid reactor', cause }) })
    assert.ok(WebAssembly.Module.imports(module).some(({ module, name, kind }) => module === 'env' && name === 'memory' && kind === 'memory'))
    assert.ok(WebAssembly.Module.exports(module).some(({ name, kind }) => name === '__indirect_function_table' && kind === 'table'))
    const instance = yield* Effect.try({ try: () => new WebAssembly.Instance(module, { env: { memory: new WebAssembly.Memory({ initial: 256, maximum: 256, shared: true }) } }), catch: (cause) => new VerificationError({ message: 'reactor instantiation failed', cause }) })
    assert.equal((instance.exports.silk_answer as () => number)(), 42)
    assert.equal(instance.exports._start, undefined)
  }
  // A debug build compiles each module's codegen unit to an object of its own, cached by its text,
  // so a rebuild after an edit to one module recompiles that module's unit alone.
  const split = join(directory, 'split')
  yield* fs.makeDirectory(join(split, 'src'), { recursive: true })
  yield* fs.writeFileString(
    join(split, 'silk.toml'),
    '[package]\nname = "split"\nversion = "0.1.0"\nsilk-version = "0.0.0"\n',
  )
  const helperSource = (value: number) => `pub fn value() -> i32 {\n  return ${value}\n}\n`
  yield* fs.writeFileString(join(split, 'src/helper.silk'), helperSource(3))
  yield* fs.writeFileString(
    join(split, 'src/main.silk'),
    'import helper\n\npub fn main() -> i32 {\n  return helper.value() + 4\n}\n',
  )
  const splitEnvironment = { ...process.env, SILK_CLANG: clang }
  // The objects are in the store the outputs of one directory share.
  const unitObjects = join(split, `build/${hostTarget}/dev/units`)
  const objectNames = Effect.fnUntraced(function* () {
    const names = yield* fs.readDirectory(unitObjects)
    return names.filter((name) => name.endsWith('.o')).sort()
  })
  const splitRun = Effect.fnUntraced(function* (expected: number) {
    const ran = yield* invoke(silk, ['run', '--stdlib', standardLibrary], split, splitEnvironment)
    assert.equal(ran.status, expected, ran.stderr)
  })
  yield* splitRun(7)
  const coldObjects = yield* objectNames()
  assert.ok(coldObjects.length > 2, `expected an object per module, found ${coldObjects.join(', ')}`)
  // Every unit that guards a foreign call defines the foreign personality, and the link keeps one
  // copy: Mach-O's compact unwind encodes at most three personalities (#2547).
  const personalitySymbols = yield* invoke(join(tools, 'llvm-nm'), [join(split, `build/${hostTarget}/dev/split`)], split)
  assert.equal(personalitySymbols.status, 0, personalitySymbols.stderr)
  const personalities = personalitySymbols.stdout.split('\n').filter((line) => /\s_?__silk_foreign_personality$/.test(line))
  assert.equal(personalities.length, 1, personalities.join('\n'))
  // The cache keeps each module's LLVM text as a file of its own beside the image, named by its
  // digest, so an unchanged rebuild finds every module's text where the last build left it.
  const packNames = Effect.fnUntraced(function* () {
    const cache = compilerCache(join(split, 'build/cache/split'))
    const folders = (yield* fs.readDirectory(cache)).filter((name) => name.endsWith('.packs'))
    assert.equal(folders.length, 1, `expected one pack folder, found ${folders.join(', ')}`)
    return (yield* fs.readDirectory(join(cache, folders[0]))).sort()
  })
  const coldPacks = yield* packNames()
  assert.ok(coldPacks.length > 2, `expected a pack per module, found ${coldPacks.join(', ')}`)
  // The first rebuild after a cold build already reuses the executable: the cache folder the cold
  // build made is its own output, not a file it read.
  const firstRebuild = yield* invoke(silk, ['build', '--stdlib', standardLibrary, '--timings'], split, splitEnvironment)
  assert.equal(firstRebuild.status, 0, firstRebuild.stderr)
  assert.doesNotMatch(firstRebuild.stdout + firstRebuild.stderr, /^\s+load\s/m, 'the first rebuild after a cold build loads nothing')
  // A load reads an unchanged file's imports from the summaries the last load kept beside the
  // cache instead of parsing the file, so an unchanged rebuild leaves them as they were.
  const importSummaries = join(compilerCache(join(split, 'build/cache/split')), 'imports')
  const summarizedAt = (yield* fs.stat(importSummaries)).mtime
  // An unchanged rebuild links nothing either: the executable stays the file the last link wrote.
  const splitExecutable = join(split, `build/${hostTarget}/dev/split`)
  const linkedAt = (yield* fs.stat(splitExecutable)).mtime
  const symbolMap = `${splitExecutable}.symbols`
  const mappedAt = (yield* fs.stat(symbolMap)).mtime
  yield* splitRun(7)
  assert.deepEqual(yield* objectNames(), coldObjects, 'an unchanged rebuild reuses every object')
  assert.deepEqual((yield* fs.stat(splitExecutable)).mtime, linkedAt, 'an unchanged rebuild leaves the executable as it was')
  assert.deepEqual(yield* packNames(), coldPacks, 'an unchanged rebuild keeps every pack')
  assert.deepEqual((yield* fs.stat(importSummaries)).mtime, summarizedAt, 'an unchanged rebuild keeps the import summaries')
  assert.deepEqual((yield* fs.stat(symbolMap)).mtime, mappedAt, 'an unchanged rebuild leaves the symbol map as it was')
  // A build records every file it read beside the executable, so a rebuild that finds them all
  // unchanged reuses the executable without loading a module.
  const unchanged = yield* invoke(silk, ['build', '--stdlib', standardLibrary, '--timings'], split, splitEnvironment)
  assert.equal(unchanged.status, 0, unchanged.stderr)
  assert.doesNotMatch(unchanged.stdout + unchanged.stderr, /^\s+load\s/m, 'an unchanged rebuild loads nothing')
  assert.ok(yield* fs.exists(`${splitExecutable}.inputs`), 'a build records what it read')
  yield* fs.writeFileString(join(split, 'src/helper.silk'), helperSource(5))
  yield* splitRun(9)
  const editedObjects = yield* objectNames()
  const compiled = editedObjects.filter((name) => !coldObjects.includes(name))
  assert.equal(compiled.length, 1, `an edit to one module compiles one unit, added ${compiled.join(', ')}`)
  assert.equal(editedObjects.length, coldObjects.length + 1)
  const editedPacks = yield* packNames()
  assert.equal(editedPacks.filter((name) => !coldPacks.includes(name)).length, 1, 'an edit to one module writes one pack')
  assert.equal(editedPacks.length, coldPacks.length, 'a build removes the packs no unit names')
  // A wasm32 debug build splits the same way, so an edit compiles one unit and wasm-ld links the
  // objects: one module of a UI page took Clang 85 s after any edit.
  const wasmDirectory = join(split, 'build/wasm32-unknown-unknown/dev')
  const wasmObjects = Effect.fnUntraced(function* () {
    const names = yield* fs.readDirectory(join(wasmDirectory, 'units'))
    return names.filter((name) => name.endsWith('.o')).sort()
  })
  const wasmRun = Effect.fnUntraced(function* (expected: number) {
    const built = yield* invoke(silk, ['build', '--target', 'wasm32-unknown-unknown', '--stdlib', standardLibrary], split, splitEnvironment)
    assert.equal(built.status, 0, built.stderr)
    const module = new WebAssembly.Module(yield* fs.readFile(join(wasmDirectory, 'split.wasm')))
    const main = new WebAssembly.Instance(module, {}).exports.main as () => number
    assert.equal(main(), expected)
  })
  yield* wasmRun(9)
  const coldWasmObjects = yield* wasmObjects()
  assert.ok(coldWasmObjects.length > 2, `expected a wasm object per module, found ${coldWasmObjects.join(', ')}`)
  yield* fs.writeFileString(join(split, 'src/helper.silk'), helperSource(6))
  yield* wasmRun(10)
  const editedWasmObjects = yield* wasmObjects()
  const compiledWasm = editedWasmObjects.filter((name) => !coldWasmObjects.includes(name))
  assert.equal(compiledWasm.length, 1, `an edit to one module compiles one wasm unit, added ${compiledWasm.join(', ')}`)
  yield* fs.writeFileString(join(split, 'src/helper.silk'), helperSource(5))
  // Two programs of a workspace share the objects of the units both hold: the second one built
  // compiles only its own, and each lists what it links so neither build removes the other's.
  const shared = join(directory, 'shared-units')
  for (const member of ['one', 'two']) {
    yield* fs.makeDirectory(join(shared, member, 'src'), { recursive: true })
    yield* fs.writeFileString(join(shared, member, 'silk.toml'), `[package]\nname = "${member}"\nversion = "0.1.0"\nsilk-version = "0.0.0"\n`)
    yield* fs.writeFileString(
      join(shared, member, 'src/main.silk'),
      `pub fn main() -> i32 {\n  return ${member === 'one' ? 1 : 2}\n}\n`,
    )
  }
  yield* fs.writeFileString(join(shared, 'silk.toml'), '[workspace]\nmembers = ["one", "two"]\n')
  const sharedObjects = join(shared, `build/${hostTarget}/dev/units`)
  const sharedNames = Effect.fnUntraced(function* (suffix: string) {
    return (yield* fs.readDirectory(sharedObjects)).filter((name) => name.endsWith(suffix)).sort()
  })
  const builtOne = yield* invoke(silk, ['build', '--stdlib', standardLibrary, '--package', 'one'], shared, splitEnvironment)
  assert.equal(builtOne.status, 0, builtOne.stderr)
  const oneObjects = yield* sharedNames('.o')
  const builtTwo = yield* invoke(silk, ['build', '--stdlib', standardLibrary, '--package', 'two'], shared, splitEnvironment)
  assert.equal(builtTwo.status, 0, builtTwo.stderr)
  const bothObjects = yield* sharedNames('.o')
  const addedByTwo = bothObjects.filter((name) => !oneObjects.includes(name))
  assert.ok(
    addedByTwo.length < oneObjects.length / 2,
    `the second program compiled ${addedByTwo.length} units of its own beside the first one's ${oneObjects.length}`,
  )
  assert.equal((yield* sharedNames('.uses')).length, 2, 'each program lists the objects it links')
  for (const [member, expected] of [['one', 1], ['two', 2]] as const) {
    const ran = yield* invoke(join(shared, `build/${hostTarget}/dev/${member}`), [], shared, splitEnvironment)
    assert.equal(ran.status, expected, ran.stderr)
  }
  // A host that cannot copy its process runs each member in a compiler process of its own, and
  // SILK_MEMBER_PROCESSES asks any host to: the reports read as a run of one member at a time.
  const inProcesses = { ...splitEnvironment, SILK_MEMBER_PROCESSES: '1' }
  const checkedBoth = yield* invoke(silk, ['check', '--workspace', '--stdlib', standardLibrary], shared, inProcesses)
  assert.equal(checkedBoth.status, 0, checkedBoth.stderr)
  const checkedReport = checkedBoth.stdout + checkedBoth.stderr
  assert.ok(checkedReport.indexOf('Finished one') < checkedReport.indexOf('Finished two'), checkedReport)
  assert.match(checkedReport, /Finished 2 packages/)
  // --trace: a compiler writes its own work as OTLP spans and logs (compiler/src/Tracing.silk), on
  // the hosts whose compilers trace. Every process of a command writes one trace: the tree is
  // whole whether a member runs in a copy of the process or in a compiler of its own. Only the
  // command line and a compilation request ask for a trace; the environment does not.
  if (process.platform === 'linux' || process.platform === 'darwin') {
    type TracedSpan = { traceId: string; spanId: string; parentSpanId?: string; name: string; attributes: ReadonlyArray<{ key: string }> }
    const traceFile = join(directory, 'trace.ndjson')
    const readTrace = Effect.fnUntraced(function* () {
      const spans: Array<TracedSpan> = []
      const templates: Array<string> = []
      for (const line of (yield* fs.readFileString(traceFile)).split('\n').filter((text) => text !== '')) {
        const request = (yield* decodeJson(line)) as {
          resourceSpans?: ReadonlyArray<{ scopeSpans: ReadonlyArray<{ spans: ReadonlyArray<TracedSpan> }> }>
          resourceLogs?: ReadonlyArray<{ scopeLogs: ReadonlyArray<{ logRecords: ReadonlyArray<{ attributes: ReadonlyArray<{ key: string; value: { stringValue?: string } }> }> }> }>
        }
        for (const resource of request.resourceSpans ?? []) for (const scope of resource.scopeSpans) spans.push(...scope.spans)
        for (const resource of request.resourceLogs ?? []) {
          for (const scope of resource.scopeLogs) {
            for (const record of scope.logRecords) {
              templates.push(record.attributes.find((attribute) => attribute.key === 'event.template')?.value.stringValue ?? '')
            }
          }
        }
      }
      const known = new Set(spans.map((span) => span.spanId))
      const roots = spans.filter((span) => span.parentSpanId === undefined || !known.has(span.parentSpanId))
      assert.deepEqual(roots.map((span) => span.name), ['silkc'], 'every span but the command\'s own has its parent in the file')
      assert.equal(new Set(spans.map((span) => span.traceId)).size, 1, 'one command is one trace')
      assert.equal(known.size, spans.length, 'no two spans share an identifier')
      return { names: spans.map((span) => span.name), spans, templates }
    })
    const traceOf = Effect.fnUntraced(function* (args: ReadonlyArray<string>, environment: NodeJS.ProcessEnv) {
      yield* fs.remove(traceFile, { force: true })
      yield* fs.remove(join(shared, 'build'), { recursive: true, force: true })
      const ran = yield* invoke(silk, [...args, '--trace', traceFile, '--stdlib', standardLibrary], shared, environment)
      assert.equal(ran.status, 0, ran.stderr)
      assert.doesNotMatch(ran.stderr, /the trace lacks|trace file/)
      settleCaches(shared)
      return yield* readTrace()
    })
    const count = (names: ReadonlyArray<string>, name: string) => names.filter((found) => found === name).length
    const tracedBuild = yield* traceOf(['build', '--package', 'one'], splitEnvironment)
    for (const phase of ['unit.build', 'load', 'parse.file', 'semantic', 'check', 'codegen', 'codegen.walk', 'link', 'object', 'process']) {
      assert.ok(tracedBuild.names.includes(phase), `a build's trace has a ${phase} span`)
    }
    assert.ok(
      tracedBuild.spans.some((span) => span.name === 'parse.file' && span.attributes.some((attribute) => attribute.key === 'module')),
      'a parsed file names its module',
    )
    assert.ok(!tracedBuild.names.some((name) => name.startsWith('query.')), 'query runs have spans only when asked')
    assert.ok(tracedBuild.templates.some((template) => template.startsWith('query.family')), 'a build logs its query families')
    // The request the traced build published, compiled before the next traced command clears
    // `build`.
    const tracedRequests = join(shared, 'build/requests')
    const tracedPublished = (yield* fs.readDirectory(tracedRequests)).find((name) => name.startsWith('one.') && name.endsWith('.toml'))
    assert.ok(tracedPublished, 'a build publishes its request')
    const tracedRequest = yield* fs.readFileString(join(tracedRequests, tracedPublished))
    assert.doesNotMatch(tracedRequest, /^\[trace\]/m, 'a published request asks for no trace')
    // A compilation request asks for a trace with its `trace` record, and the compilation
    // continues the span the record names.
    const traceParent = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01'
    yield* fs.remove(traceFile, { force: true })
    const compiledTraced = yield* invoke(
      silk,
      ['compile', '--request', '-'],
      shared,
      { ...splitEnvironment, SILK_TRACE: join(directory, 'ignored.ndjson') },
      120_000,
      `${tracedRequest}\n[trace]\nfile = ${JSON.stringify(traceFile)}\nparent = "${traceParent}"\n`,
    )
    assert.equal(compiledTraced.status, 0, compiledTraced.stderr)
    assert.equal(yield* fs.exists(join(directory, 'ignored.ndjson')), false, 'the environment asks for no trace')
    const tracedCompile = yield* readTrace()
    const compileRoot = tracedCompile.spans.find((span) => span.name === 'silkc')
    assert.equal(compileRoot?.traceId, '0af7651916cd43dd8448eb211c80319c')
    assert.equal(compileRoot?.parentSpanId, 'b7ad6b7169203331')
    assert.ok(tracedCompile.names.includes('semantic'))
    // A member checked in a copy of the process, then in a compiler of its own.
    const tracedCopies = yield* traceOf(['check', '--no-server', '--workspace', '--trace-queries', '0'], splitEnvironment)
    assert.equal(count(tracedCopies.names, 'unit.check'), 2)
    assert.equal(count(tracedCopies.names, 'silkc'), 1)
    assert.ok(tracedCopies.names.some((name) => name.startsWith('query.')), '--trace-queries gives each query run a span')
    assert.ok(tracedCopies.names.includes('borrow.check'))
    // A threshold leaves out the short query runs, but none that holds a span the trace keeps,
    // such as the parse of a file an import was first to read.
    const tracedSlow = yield* traceOf(['build', '--package', 'two', '--trace-queries=60000000'], splitEnvironment)
    assert.ok(tracedSlow.names.includes('parse.file'))
    assert.ok(tracedSlow.names.filter((name) => name.startsWith('query.')).length < tracedCopies.names.length / 4)
    const tracedProcesses = yield* traceOf(['check', '--no-server', '--workspace'], inProcesses)
    assert.equal(count(tracedProcesses.names, 'unit.check'), 2)
    assert.equal(count(tracedProcesses.names, 'silkc'), 3, 'each member compiler continues the command\'s trace')
    // A traced check of one package does its work in this process, though earlier checks left a
    // server behind.
    const tracedAlone = yield* traceOf(['check', '--package', 'one'], splitEnvironment)
    assert.ok(tracedAlone.names.includes('check'), 'a traced check asks no check server')
  }
  yield* fs.writeFileString(join(shared, 'two/src/main.silk'), 'pub fn main() -> i32 {\n  return missing\n}\n')
  const checkedBroken = yield* invoke(silk, ['check', '--workspace', '--stdlib', standardLibrary], shared, inProcesses)
  assert.equal(checkedBroken.status, 1, checkedBroken.stderr)
  assert.match(checkedBroken.stdout + checkedBroken.stderr, /Failed 1 of 2 packages/)
  // A program checked for the first time starts its walk from the one a sibling program left in
  // the cache: it lowers what it alone reaches and still reports what only it reaches. A workspace
  // check lets one program finish before the others start, so they find its walk.
  const siblings = join(directory, 'siblings')
  yield* fs.makeDirectory(join(siblings, 'spec/src'), { recursive: true })
  yield* fs.writeFileString(join(siblings, 'silk.toml'), '[workspace]\nmembers = ["spec", "one", "two"]\n')
  yield* fs.writeFileString(
    join(siblings, 'spec/silk.toml'),
    '[package]\nname = "spec"\nversion = "0.1.0"\nkind = "library"\nexports = ["lib"]\nsilk-version = "0.0.0"\n',
  )
  yield* fs.writeFileString(
    join(siblings, 'spec/src/lib.silk'),
    [
      'import silk.collections.list { List }',
      'import silk.mem.allocator { Allocator, OutOfMemoryError }',
      '',
      'pub fn sized(static n: i64) -> i64 {',
      '  static if n > 3 { compileError("size too big") }',
      '  return n',
      '}',
      '',
      'pub effect fn kept<T>(value: T) -> usize ! OutOfMemoryError ? &mut Allocator {',
      '  let mut values = List<T>.make()',
      '  run List<T>.append(&mut values, move value)',
      '  return List<T>.length(&values)',
      '}',
      '',
    ].join('\n'),
  )
  const siblingMain = (size: number) =>
    [
      'import silk.core.effect { Effect }',
      'import silk.mem.allocator { Allocator, OutOfMemoryError }',
      'import silk.num.usize',
      'import spec.lib { sized, kept }',
      '',
      'pub effect fn main() -> i32 ! OutOfMemoryError {',
      '  let mut system = Allocator.systemAllocatorProvider()',
      `  let count = run kept<i64>(sized(${size})) |> Effect.provideMut<Allocator>(&mut system)`,
      '  if count != usize.ONE { return 1 }',
      '  return 0',
      '}',
      '',
    ].join('\n')
  for (const member of ['one', 'two']) {
    yield* fs.makeDirectory(join(siblings, member, 'src'), { recursive: true })
    yield* fs.writeFileString(
      join(siblings, member, 'silk.toml'),
      `[package]\nname = "${member}"\nversion = "0.1.0"\nsilk-version = "0.0.0"\n\n[dependencies]\nspec = { path = "../spec" }\n`,
    )
    yield* fs.writeFileString(join(siblings, member, 'src/main.silk'), siblingMain(member === 'one' ? 1 : 2))
  }
  // How many bodies each member's check ran, by member name, from its `--timings` rows.
  const bodyRuns = (report: string) => {
    const runs = new Map<string, number>()
    for (const section of report.split(/^Checking /m).slice(1)) {
      const row = /^\s+\S+\s+\S+\s+([\d,]+)\s+Body$/m.exec(section)
      runs.set(section.slice(0, section.indexOf(' ')), row === null ? 0 : Number(row[1].replaceAll(',', '')))
    }
    return runs
  }
  const checkSiblings = Effect.fnUntraced(function* (selection: ReadonlyArray<string>, environment: typeof splitEnvironment) {
    const checked = yield* invoke(silk, ['check', '--no-server', '--stdlib', standardLibrary, '--timings', ...selection], siblings, environment)
    return { status: checked.status, report: checked.stdout + checked.stderr }
  })
  const coldTwo = yield* checkSiblings(['--package', 'two'], splitEnvironment)
  assert.equal(coldTwo.status, 0, coldTwo.report)
  const coldRuns = bodyRuns(coldTwo.report).get('two') ?? 0
  yield* fs.remove(join(siblings, 'build'), { recursive: true })
  const firstOne = yield* checkSiblings(['--package', 'one'], splitEnvironment)
  assert.equal(firstOne.status, 0, firstOne.report)
  yield* fs.writeFileString(join(siblings, 'two/src/main.silk'), siblingMain(5))
  const refusedTwo = yield* checkSiblings(['--package', 'two'], splitEnvironment)
  assert.equal(refusedTwo.status, 1, refusedTwo.report)
  assert.match(refusedTwo.report, /^two\/src\/main\.silk:8:\d+: error\[SEM0177\] size too big$/m)
  yield* fs.writeFileString(join(siblings, 'two/src/main.silk'), siblingMain(2))
  yield* fs.remove(join(siblings, 'build/cache/two'), { recursive: true })
  const afterOne = yield* checkSiblings(['--package', 'two'], splitEnvironment)
  assert.equal(afterOne.status, 0, afterOne.report)
  const afterRuns = bodyRuns(afterOne.report).get('two') ?? 0
  assert.ok(afterRuns * 3 < coldRuns, `after its sibling the program ran ${afterRuns} bodies, and ${coldRuns} alone`)
  for (const environment of [splitEnvironment, { ...splitEnvironment, SILK_MEMBER_PROCESSES: '1' }]) {
    yield* fs.remove(join(siblings, 'build'), { recursive: true })
    const together = yield* checkSiblings(['--workspace'], environment)
    assert.equal(together.status, 0, together.report)
    const runs = bodyRuns(together.report)
    const first = runs.get('one') ?? 0
    const second = runs.get('two') ?? 0
    assert.ok(second * 3 < first, `checked together, the second program ran ${second} bodies beside the first one's ${first}`)
  }
  // A program built for the first time borrows the build record a sibling program's build left in
  // the cache: it emits what it alone reaches, its executable is byte for byte the one it builds
  // alone, and it keeps a record and packs of its own, so an edit rebuilds what changed without the
  // sibling's cache. A workspace build lets one program finish before the others start, so they
  // find its record.
  const buildSiblings = Effect.fnUntraced(function* (selection: ReadonlyArray<string>) {
    const built = yield* invoke(silk, ['build', '--stdlib', standardLibrary, ...selection], siblings, splitEnvironment)
    assert.equal(built.status, 0, built.stdout + built.stderr)
    return built.stdout + built.stderr
  })
  // How many functions each member's build emitted, by member name, and where it left its executable.
  const emitted = (report: string) => {
    const members = new Map<string, { functions: number; executable: string }>()
    for (const section of report.split(/^Compiling /m).slice(1)) {
      const row = /^\s+codegen\s+([\d,]+) functions?/m.exec(section)
      const finished = /^Finished (\S+) in /m.exec(section)
      assert.ok(finished !== null, report)
      members.set(section.slice(0, section.indexOf(' ')), {
        functions: row === null ? 0 : Number(row[1].replaceAll(',', '')),
        executable: join(siblings, finished[1]),
      })
    }
    return members
  }
  const builtMember = (report: string, member: string) => {
    const built = emitted(report).get(member)
    assert.ok(built !== undefined, report)
    return built
  }
  yield* fs.remove(join(siblings, 'build'), { recursive: true })
  const aloneTwo = builtMember(yield* buildSiblings(['--package', 'two']), 'two')
  const aloneBytes = yield* fs.readFile(aloneTwo.executable)
  yield* fs.remove(join(siblings, 'build'), { recursive: true })
  yield* buildSiblings(['--package', 'one'])
  const borrowedTwo = builtMember(yield* buildSiblings(['--package', 'two']), 'two')
  assert.ok(
    borrowedTwo.functions * 3 < aloneTwo.functions,
    `after its sibling the program emitted ${borrowedTwo.functions} functions, and ${aloneTwo.functions} alone`,
  )
  assert.ok(
    Buffer.from(yield* fs.readFile(borrowedTwo.executable)).equals(Buffer.from(aloneBytes)),
    'a program built after its sibling differs from the one built alone',
  )
  yield* fs.remove(join(siblings, 'build/cache/one'), { recursive: true })
  yield* fs.writeFileString(join(siblings, 'two/src/main.silk'), siblingMain(3))
  const editedTwo = builtMember(yield* buildSiblings(['--package', 'two']), 'two')
  assert.ok(
    editedTwo.functions > 0 && editedTwo.functions <= borrowedTwo.functions,
    `an edit after a borrowed build emitted ${editedTwo.functions} functions, and the borrowed build ${borrowedTwo.functions}`,
  )
  yield* fs.writeFileString(join(siblings, 'two/src/main.silk'), siblingMain(2))
  yield* fs.remove(join(siblings, 'build'), { recursive: true })
  const builtTogether = emitted(yield* buildSiblings(['--workspace']))
  const builtFirst = builtTogether.get('one')?.functions ?? 0
  const builtSecond = builtTogether.get('two')?.functions ?? 0
  assert.ok(
    builtSecond * 3 < builtFirst,
    `built together, the second program emitted ${builtSecond} functions beside the first one's ${builtFirst}`,
  )
  // A test runner borrows its sibling's record too, but lists only its own package's tests: the
  // runner of `two`, which has none, does not run the test of `spec`, whose runner it follows.
  yield* fs.writeFileString(
    join(siblings, 'spec/src/lib.silk'),
    [
      yield* fs.readFileString(join(siblings, 'spec/src/lib.silk')),
      'import silk.testing.testing { AssertionError, Testing }',
      '',
      'test effect fn sizesOne() -> () ! AssertionError<\'static> {',
      '  run Testing.expect(sized(1) == 1, "one is one")',
      '}',
      '',
    ].join('\n'),
  )
  yield* fs.remove(join(siblings, 'build'), { recursive: true })
  for (const [member, discovered] of [['spec', 1], ['two', 0], ['two', 0]] as const) {
    const tested = yield* invoke(silk, ['test', '--package', member, '--stdlib', standardLibrary], siblings, splitEnvironment)
    assert.equal(tested.status, 0, tested.stdout + tested.stderr)
    assert.match(tested.stdout, new RegExp(`, ${discovered} discovered\\)$`, 'm'), tested.stdout + tested.stderr)
  }
  // Each unit carries line tables made from the lines its location markers name, so a function
  // that moves recompiles its unit alone, and the unit's rows name the lines it moved to.
  const rowLines = Effect.fnUntraced(function* (object: string) {
    const dumped = yield* invoke(join(tools, 'llvm-dwarfdump'), ['--debug-line', join(unitObjects, object)], split)
    assert.equal(dumped.status, 0, dumped.stderr)
    assert.match(dumped.stdout, /helper\.silk/)
    const lines = new Set<number>()
    for (const row of dumped.stdout.matchAll(/^0x[0-9a-f]+\s+(\d+)\s+\d+\s/gm)) {
      if (row[1] !== '0') lines.add(Number(row[1]))
    }
    return [...lines].sort()
  })
  assert.deepEqual(yield* rowLines(compiled[0]), [2])
  yield* fs.writeFileString(join(split, 'src/helper.silk'), `// moved\n\n${helperSource(5)}`)
  const moved = yield* invoke(silk, ['build', '--stdlib', standardLibrary, '--timings'], split, splitEnvironment)
  assert.equal(moved.status, 0, moved.stderr)
  assert.match(moved.stdout + moved.stderr, /codegen\s+0 functions\s/, 'a function that only moved is not lowered again')
  yield* splitRun(9)
  const movedObjects = (yield* objectNames()).filter((name) => !editedObjects.includes(name))
  assert.equal(movedObjects.length, 1, `a moved function compiles one unit, added ${movedObjects.join(', ')}`)
  assert.deepEqual(yield* rowLines(movedObjects[0]), [4])
  // A rebuild replays the record the last build left in the cache: an edit to a body lowers only
  // the instances it touched, and an edit that changes what the program reaches walks it again
  // from the record, lowering only the bodies it touched and the ones they newly reach (here the
  // new helper, the body that calls it, and `main`, which resolved a name in the module that gained
  // a declaration). Either way the executable is the one a cold build links. A string constant
  // holding `@` names nothing, so the unit still declares the helper it calls.
  const executable = join(split, `build/${hostTarget}/dev/split`)
  const replayed = Effect.fnUntraced(function* (helper: string, expected: number, lowered: RegExp) {
    yield* fs.writeFileString(join(split, 'src/helper.silk'), helper)
    const built = yield* invoke(silk, ['build', '--stdlib', standardLibrary, '--timings'], split, splitEnvironment)
    assert.equal(built.status, 0, built.stderr)
    assert.match(built.stdout + built.stderr, lowered)
    yield* splitRun(expected)
    const warm = yield* fs.readFile(executable)
    yield* fs.remove(join(split, 'build'), { recursive: true })
    yield* splitRun(expected)
    assert.deepEqual(yield* fs.readFile(executable), warm, 'a replayed build links the executable a cold build links')
  })
  yield* fs.writeFileString(
    join(split, 'src/main.silk'),
    'import helper\n\npub fn main() -> i32 {\n  let marker = b"ptr @"\n  if marker.length == 5 { return helper.value() + 4 }\n  return 0\n}\n',
  )
  yield* splitRun(9)
  yield* replayed(helperSource(6), 10, /codegen\s+1 functions?\s/)
  yield* replayed(`fn other() -> i32 {\n  return 2\n}\n\npub fn value() -> i32 {\n  return other() + 1\n}\n`, 7, /codegen\s+3 functions\s/)
  // A new format template reaches new instances of the effect combinators already on the walk's
  // path, which the rewalk admits through their applications, so an edit to a logged message
  // lowers the instances it changed rather than the whole program.
  const logged = join(directory, 'logged')
  yield* fs.makeDirectory(join(logged, 'src'), { recursive: true })
  yield* fs.writeFileString(join(logged, 'silk.toml'), '[package]\nname = "logged"\nversion = "0.1.0"\nsilk-version = "0.0.0"\n')
  const loggedSource = (message?: string) => 'import silk.core.effect { Effect }\n\n'
    + `effect fn observe() -> () {}\nfn leaf() -> () { drop run Effect.result(observe()) ${message === undefined ? '' : `run Effect.logWarning("${message}", &())`} }\n\npub fn main() -> () { leaf() }\n`
  const loggedExecutable = join(logged, `build/${hostTarget}/dev/logged`)
  const loggedBuild = Effect.fnUntraced(function* (message?: string) {
    const built = yield* invoke(silk, ['build', '--stdlib', standardLibrary, '--timings'], logged, splitEnvironment)
    assert.equal(built.status, 0, built.stderr)
    const ran = yield* invoke(loggedExecutable, [], logged, splitEnvironment)
    assert.equal(ran.status, 0, ran.stderr)
    assert.equal(ran.stderr, message === undefined ? '' : `warning: ${message}\n`, ran.stderr)
    return built.stdout + built.stderr
  })
  yield* fs.writeFileString(join(logged, 'src/main.silk'), loggedSource())
  yield* loggedBuild()
  const originalSymbols = (yield* fs.readFileString(`${loggedExecutable}.symbols`)).trimEnd().split('\n')
  yield* fs.writeFileString(join(logged, 'src/main.silk'), loggedSource('Hello, world!'))
  yield* loggedBuild('Hello, world!')
  const loggedSymbols = new Set((yield* fs.readFileString(`${loggedExecutable}.symbols`)).trimEnd().split('\n'))
  for (const symbol of originalSymbols) assert.ok(loggedSymbols.has(symbol), `adding a log call changed ${symbol}`)
  yield* fs.writeFileString(join(logged, 'src/main.silk'), loggedSource('Hello, edit!'))
  const loweredLog = /^\s+codegen\s+([0-9,]+) functions/m.exec(yield* loggedBuild('Hello, edit!'))
  assert.ok(loweredLog !== null && Number(loweredLog[1].replace(/,/g, '')) < 50, `a message edit lowered ${loweredLog?.[1]} functions`)
  const warmLog = yield* fs.readFile(loggedExecutable)
  yield* fs.remove(join(logged, 'build'), { recursive: true })
  yield* loggedBuild('Hello, edit!')
  assert.deepEqual(yield* fs.readFile(loggedExecutable), warmLog, 'a rewalked build links the executable a cold build links')
  // Adding the first registration changes the layout captured by Execution.make. Its
  // cached definition must gain the retain on that edit and lose it after the reverse edit.
  const inheritance = yield* fs.readFileString(join(repository, 'corpus/native/ambient-logger-inheritance/main.silk'))
  const unprovided = inheritance.replaceAll(' |> Effect.provideAmbient<Logger>(&handle)', '')
  for (const [program, expected] of [[unprovided, 1], [inheritance, 0], [unprovided, 1]] as const) {
    yield* fs.writeFileString(join(logged, 'src/main.silk'), program)
    const built = yield* invoke(silk, ['build', '--stdlib', standardLibrary], logged, splitEnvironment)
    assert.equal(built.status, 0, built.stderr)
    const ran = yield* invoke(loggedExecutable, [], logged, splitEnvironment)
    assert.equal(ran.status, expected, ran.stderr)
  }
  // A whole-module link keeps a stamp too, so an unchanged release rebuild links nothing.
  const releaseBuild = Effect.fnUntraced(function* () {
    const built = yield* invoke(silk, ['build', '--release', '--stdlib', standardLibrary], split, splitEnvironment)
    assert.equal(built.status, 0, built.stderr)
    return built.stderr
  })
  const firstRelease = yield* releaseBuild()
  assert.match(firstRelease, /^  optimize  clang +[0-9.ms ]+s$/m, 'a whole optimized module compiles in its own optimize phase')
  const releaseExecutable = join(split, `build/${hostTarget}/release/split`)
  const releasedAt = (yield* fs.stat(releaseExecutable)).mtime
  yield* releaseBuild()
  assert.deepEqual((yield* fs.stat(releaseExecutable)).mtime, releasedAt, 'an unchanged release rebuild leaves the executable as it was')
  // A release link that runs again, as one with a link input read from outside the build does
  // every time, links the module's cached object instead of optimizing the module again.
  yield* fs.remove(releaseExecutable)
  const relinked = yield* releaseBuild()
  assert.doesNotMatch(relinked, /optimize/, relinked)
  assert.match(relinked, /^  link      clang +[0-9.ms ]+s$/m, relinked)
  assert.equal((yield* invoke(releaseExecutable, [], split, splitEnvironment)).status, 7)
  // Every build names its content-derived symbols beside its output, so a frame an optimized
  // program's backtrace shows by symbol leads to its declaration.
  const releaseMap = yield* fs.readFileString(`${releaseExecutable}.symbols`)
  assert.match(releaseMap, /^silk_[0-9a-f]+\tfunction\tsplit@0\.1\.0:helper\.silk::value$/m, releaseMap)
  // Clang compiling and linking a macOS debug build in one step keeps its DWARF in a dSYM bundle,
  // which the build keeps beside the executable.
  if (process.platform === 'darwin') {
    const debugged = yield* invoke(silk, ['build', '--optimization', 'speed', '--debug', '--stdlib', standardLibrary], split, splitEnvironment)
    assert.equal(debugged.status, 0, debugged.stderr)
    const bundle = join(split, `build/${hostTarget}/release/split.dSYM`)
    assert.ok(yield* fs.exists(bundle), 'a macOS debug build keeps its dSYM bundle beside the executable')
  }
  // Workspace members share one output directory, and each keeps a cache of its own there, so
  // building one member never replaces the cache another member's next build reads.
  const pair = join(directory, 'pair')
  yield* fs.makeDirectory(pair, { recursive: true })
  yield* fs.writeFileString(join(pair, 'silk.toml'), '[workspace]\nmembers = ["first", "second"]\noutput-dir = "build"\n')
  const memberSource = (value: number) => `pub fn main() -> i32 {\n  return ${value}\n}\n`
  for (const member of ['first', 'second']) {
    yield* fs.makeDirectory(join(pair, member, 'src'), { recursive: true })
    yield* fs.writeFileString(join(pair, member, 'silk.toml'), `[package]\nname = "${member}"\nversion = "0.1.0"\nsilk-version = "0.0.0"\n`)
    yield* fs.writeFileString(join(pair, member, 'src/main.silk'), memberSource(1))
  }
  const memberBuild = Effect.fnUntraced(function* (member: string) {
    const built = yield* invoke(silk, ['build', '--package', member, '--stdlib', standardLibrary], pair, splitEnvironment)
    assert.equal(built.status, 0, built.stderr)
  })
  const memberImage = Effect.fnUntraced(function* (member: string) {
    const cache = compilerCache(join(pair, 'build/cache', member))
    const names = (yield* fs.readDirectory(cache)).filter((name) => /^semantic-[0-9a-f]{32}$/.test(name))
    assert.equal(names.length, 1, `expected one semantic cache for ${member}, found ${names.join(', ')}`)
    return join(cache, names[0])
  })
  yield* memberBuild('first')
  const firstImage = yield* memberImage('first')
  const firstWritten = yield* fs.readFile(firstImage)
  yield* memberBuild('second')
  yield* fs.writeFileString(join(pair, 'second/src/main.silk'), memberSource(2))
  yield* memberBuild('second')
  assert.deepEqual(yield* fs.readFile(firstImage), firstWritten, "building another member leaves a member's cache as it was")
  assert.notEqual(yield* memberImage('second'), firstImage)
  // A stored Effect can introduce a NonParking proof without running the Effect.
  // Replay must preserve both the proof and its disappearance after an edit.
  const proofProject = join(directory, 'nonparking-proof')
  yield* fs.makeDirectory(proofProject)
  yield* fs.writeFileString(join(proofProject, 'silk.toml'),
    '[package]\nname = "nonparking-proof"\nversion = "0.1.0"\nsilk-version = "0.0.0"\nsource = "."\n')
  const unselected = yield* fs.readFileString(join(repository, 'corpus/invalid/nonparking-unselected-provider/main.silk'))
  const unconstrained = unselected.replace('hold(closing())', 'closing()')
  for (const source of [unconstrained, unselected, unselected, unconstrained]) {
    yield* fs.writeFileString(join(proofProject, 'main.silk'), source)
    const checked = yield* invoke(silk, ['check', '--roots', '--no-server', '--stdlib', standardLibrary], proofProject, splitEnvironment)
    const output = checked.stdout + checked.stderr
    const refused = source === unselected
    assert.equal(checked.status, refused ? 1 : 0, output)
    assert.match(output, /silk-check-roots modules=1 rejections=\d+ differences=0/, output)
    assert.equal(output.includes('error[SEM0139]'), refused, output)
  }
  // A check replays the escape walks the last check left in the cache. A callback's call into
  // another module of the package is walked below the callback, so an edit there that adds a `run`
  // is reported as a cold check reports it, and an edit that keeps what the walk reads reports
  // nothing.
  const escapes = join(directory, 'escapes')
  yield* fs.makeDirectory(join(escapes, 'src'), { recursive: true })
  yield* fs.writeFileString(
    join(escapes, 'silk.toml'),
    '[package]\nname = "escapes"\nversion = "0.1.0"\nmain = "main.silk"\nsilk-version = "0.0.0"\n',
  )
  yield* fs.writeFileString(
    join(escapes, 'src/main.silk'),
    [
      'import helper',
      'import silk.mem.allocator {Allocator, OutOfMemoryError}',
      'import silk.core.effect {Effect}',
      'import silk.core.result {Result}',
      'import silk.mem.shared {Shared}',
      '',
      'fn use(value: &mut i32) -> i32 {',
      '  return helper.compute() + value.*',
      '}',
      '',
      'effect fn start() -> i32 ! OutOfMemoryError ? &mut Allocator {',
      '  let shared = run Shared<i32>.make(41)',
      '  return shared.withMut(use)',
      '}',
      '',
      'pub fn main() -> i32 {',
      '  let mut allocator = Allocator.systemAllocatorProvider()',
      '  return match move run Effect.result(start() |> Effect.provideMut<Allocator>(&mut allocator)) {',
      '    Result<i32, OutOfMemoryError>.Success {value} => value',
      '    Result<i32, OutOfMemoryError>.Failure {..} => 1',
      '  }',
      '}',
      '',
    ].join('\n'),
  )
  const escapeReports = (output: string) => output.split('\n').filter((line) => /(error|warning)\[/.test(line)).join('\n')
  // These compare a check from the cache with one without it, so no check server answers them.
  const escapeCheck = Effect.fnUntraced(function* (helper: string, expected: string) {
    yield* fs.writeFileString(join(escapes, 'src/helper.silk'), helper)
    const warm = yield* invoke(silk, ['check', '--no-server', '--stdlib', standardLibrary], escapes, splitEnvironment)
    yield* fs.remove(join(escapes, 'build'), { recursive: true })
    const cold = yield* invoke(silk, ['check', '--no-server', '--stdlib', standardLibrary], escapes, splitEnvironment)
    assert.equal(escapeReports(warm.stdout + warm.stderr), escapeReports(cold.stdout + cold.stderr), 'a warm check reports what a cold check reports')
    assert.equal(warm.status, cold.status, warm.stderr)
    assert.match(escapeReports(cold.stdout + cold.stderr), new RegExp(expected))
    // Leave a cache for the next edit.
    yield* invoke(silk, ['check', '--no-server', '--stdlib', standardLibrary], escapes, splitEnvironment)
  })
  const computing = (body: string) => `effect fn tick() -> () {\n  return ()\n}\n\npub fn compute() -> i32 {\n${body}}\n`
  yield* escapeCheck(computing('  return 1\n'), '^$')
  yield* escapeCheck(computing('  return 2\n'), '^$')
  yield* escapeCheck(computing('  run tick()\n  return 1\n'), 'helper\\.silk:6:3: error\\[OWN0016\\]')
  yield* escapeCheck(computing('  return 3\n'), '^$')
  // `Source.read` and `Source.text` embed files of the package at compile time. An edit to an
  // embedded file rebuilds with its new contents, an edit replay reruns only the units that read
  // it, and a path outside the package or naming no file is refused.
  const embeds = join(directory, 'embeds')
  yield* fs.makeDirectory(join(embeds, 'src'), { recursive: true })
  yield* fs.makeDirectory(join(embeds, 'shaders'), { recursive: true })
  yield* fs.writeFileString(join(embeds, 'silk.toml'), '[package]\nname = "embeds"\nversion = "0.1.0"\nsilk-version = "0.0.0"\n')
  yield* fs.writeFile(join(embeds, 'shaders/b.bin'), new Uint8Array([1, 255, 3]))
  const embedMain = (path: string) => 'import silk.build.source { Source }\nimport silk.num.usize\n\npub fn main() -> i32 {\n'
    + `  let bytes = Source.read("${path}")\n  let text = Source.text("shaders/a.wgsl")\n  if bytes[1] != 255 { return 100 }\n`
    + '  return usize.toI32(bytes.length + Intrinsic.stringByteLength(text))\n}\n'
  const embedsExecutable = join(embeds, `build/${hostTarget}/dev/embeds`)
  const embedBuild = Effect.fnUntraced(function* (expected: number) {
    const built = yield* invoke(silk, ['build', '--stdlib', standardLibrary], embeds, splitEnvironment)
    assert.equal(built.status, 0, built.stderr)
    const ran = yield* invoke(embedsExecutable, [], embeds, splitEnvironment)
    assert.equal(ran.status, expected, ran.stderr)
  })
  yield* fs.writeFileString(join(embeds, 'shaders/a.wgsl'), 'abcd')
  yield* fs.writeFileString(join(embeds, 'src/main.silk'), embedMain('shaders/b.bin'))
  yield* embedBuild(7)
  yield* fs.writeFileString(join(embeds, 'shaders/a.wgsl'), 'abcdef')
  yield* embedBuild(9)
  yield* fs.writeFileString(
    join(embeds, 'replay.toml'),
    '[[edit]]\nkind = "embedded"\nmodule = "shaders/a.wgsl"\nfind = "abc"\nreplace = "abcabc"\n',
  )
  const replay = yield* invoke(silk, ['check', '--stdlib', standardLibrary, '--replay', 'replay.toml'], embeds, splitEnvironment)
  assert.equal(replay.status, 0, replay.stdout + replay.stderr)
  const unitsRun = [...(replay.stdout + replay.stderr).matchAll(/silk-replay step=[1-9]\d* .*?units-run=(\d+)/g)].map((match) => Number(match[1]))
  assert.ok(unitsRun.length > 0 && unitsRun.every((units) => units < 10), `an embedded edit reran ${unitsRun.join(', ')} units`)
  const refusedEmbed = Effect.fnUntraced(function* (path: string, message: RegExp) {
    yield* fs.writeFileString(join(embeds, 'src/main.silk'), embedMain(path))
    const built = yield* invoke(silk, ['build', '--stdlib', standardLibrary], embeds, splitEnvironment)
    assert.notEqual(built.status, 0, 'a refused embed fails the build')
    assert.match(built.stdout + built.stderr, message)
  })
  yield* refusedEmbed('shaders/missing.bin', /cannot embed "shaders\/missing\.bin": no such file in package embeds/)
  yield* refusedEmbed('../outside.bin', /cannot embed "\.\.\/outside\.bin": the path must be relative to the package's directory/)
  // `Source.compressed` and `Source.compressedText` keep a file as one Zstandard frame, and the
  // program expands it to the bytes the build read: a file that shrinks, an empty one, and one
  // too short to shrink. Text that is not UTF-8 is refused where it is embedded.
  const embedLong = 'fn shade(position: vec4<f32>) -> vec4<f32> { return position * 0.5; } // λ\n'.repeat(64)
  yield* fs.writeFileString(join(embeds, 'shaders/long.wgsl'), embedLong)
  yield* fs.writeFileString(join(embeds, 'shaders/empty.bin'), '')
  const compressedMain = (text: string) =>
    'import silk.build.source { Compressed, CompressedText, Source }\nimport silk.collections.bytes { Bytes }\n'
    + 'import silk.core.effect { Effect }\nimport silk.mem.allocator { Allocator, OutOfMemoryError }\n'
    + 'import silk.text.string { String }\n\npub effect fn main() -> i32 ! OutOfMemoryError {\n'
    + '  let mut allocator = Allocator.systemAllocatorProvider()\n  let plain = Source.read("shaders/long.wgsl")\n'
    + `  let packed = Source.compressed("shaders/long.wgsl")\n  let text = Source.compressedText("${text}")\n`
    + '  if Compressed.length(&packed) != plain.length || CompressedText.length(&text) != plain.length { return 1 }\n'
    + '  if Compressed.compressedLength(&packed) * 4 > plain.length { return 2 }\n'
    + '  if CompressedText.compressedLength(&text) != Compressed.compressedLength(&packed) { return 3 }\n'
    + '  let bytes = run Compressed.bytes(&packed) |> Effect.provideMut<Allocator>(&mut allocator)\n'
    + '  let expanded = Bytes.asSlice(&bytes)\n  if expanded.length != plain.length { return 4 }\n'
    + '  let mut at: usize = 0\n  while at < plain.length {\n    if expanded[at] != plain[at] { return 5 }\n    at = at + 1\n  }\n'
    + '  let owned = run CompressedText.text(&text) |> Effect.provideMut<Allocator>(&mut allocator)\n'
    + '  let spelled = String.ownedUtf8Bytes(&owned)\n  if spelled.length != plain.length || spelled[plain.length - 3] != 206 { return 6 }\n'
    + '  let empty = Source.compressed("shaders/empty.bin")\n'
    + '  let nothing = run Compressed.bytes(&empty) |> Effect.provideMut<Allocator>(&mut allocator)\n'
    + '  if Compressed.length(&empty) != 0 || Bytes.length(&nothing) != 0 { return 7 }\n'
    + '  let short = Source.compressed("shaders/b.bin")\n'
    + '  let raw = run Compressed.bytes(&short) |> Effect.provideMut<Allocator>(&mut allocator)\n'
    + '  if Bytes.length(&raw) != 3 || Bytes.asSlice(&raw)[1] != 255 { return 8 }\n  return 42\n}\n'
  yield* fs.writeFileString(join(embeds, 'src/main.silk'), compressedMain('shaders/long.wgsl'))
  yield* embedBuild(42)
  yield* fs.writeFileString(join(embeds, 'src/main.silk'), compressedMain('shaders/b.bin'))
  const refusedText = yield* invoke(silk, ['build', '--stdlib', standardLibrary], embeds, splitEnvironment)
  assert.notEqual(refusedText.status, 0, 'compressed text that is not UTF-8 was embedded')
  assert.match(refusedText.stdout + refusedText.stderr, /main\.silk:11:14: error\[SEM0176\] .*cannot embed "shaders\/b\.bin" as text/)
  // A dependency embeds its own files, and the package that depends on it reads them as bytes in
  // a check and in a build: an embedded file is never parsed, so it need not be Silk. A check
  // server reads an embedded file again before each check, from the directory of the package
  // that embeds it.
  const embedLibrary = join(directory, 'embed-library')
  const embedApp = join(directory, 'embed-app')
  yield* fs.makeDirectory(join(embedLibrary, 'src'), { recursive: true })
  yield* fs.makeDirectory(join(embedLibrary, 'js'), { recursive: true })
  yield* fs.makeDirectory(join(embedApp, 'src'), { recursive: true })
  yield* fs.writeFileString(
    join(embedLibrary, 'silk.toml'),
    '[package]\nname = "embed-library"\nversion = "0.1.0"\nsilk-version = "' + releasePin + '"\nkind = "library"\nmain = "library.silk"\nexports = ["library"]\n',
  )
  yield* fs.writeFileString(join(embedLibrary, 'js/index.js'), 'export const hello = () => `hi ${1 + 1}`;\n')
  yield* fs.writeFileString(
    join(embedLibrary, 'src/library.silk'),
    'import silk.build.source { Source }\n\npub fn script() -> &\'static [u8] {\n  return Source.read("js/index.js")\n}\n',
  )
  yield* fs.writeFileString(
    join(embedApp, 'silk.toml'),
    '[package]\nname = "embed-app"\nversion = "0.1.0"\nsilk-version = "0.0.0"\n\n[dependencies]\nlibrary = { path = "../embed-library", package = "embed-library" }\n',
  )
  yield* fs.writeFileString(
    join(embedApp, 'src/main.silk'),
    'import library.library { script }\nimport silk.num.usize\n\npub fn main() -> i32 {\n  return usize.toI32(script().length)\n}\n',
  )
  const embedCheck = Effect.fnUntraced(function* (cwd: string, claim: string) {
    const checked = yield* invoke(silk, ['check', '--stdlib', standardLibrary], cwd, splitEnvironment)
    assert.equal(checked.status, 0, `${claim}: ${checked.stdout}${checked.stderr}`)
  })
  const embedAppRun = Effect.fnUntraced(function* (expected: number) {
    const ran = yield* invoke(silk, ['run', '--stdlib', standardLibrary], embedApp, splitEnvironment)
    assert.equal(ran.status, expected, ran.stderr)
  })
  yield* embedCheck(embedApp, 'a dependency\'s embedded JavaScript was checked as Silk')
  yield* embedAppRun(42)
  yield* embedCheck(embedApp, 'a second check lost a dependency\'s embedded file')
  yield* fs.writeFileString(join(embedLibrary, 'js/index.js'), 'export const hello = () => `hello ${1 + 1}`;\n')
  yield* embedCheck(embedApp, 'a check after an edit lost a dependency\'s embedded file')
  yield* embedAppRun(45)
  yield* embedCheck(embedLibrary, 'a package\'s own embedded file was not read')
  yield* embedCheck(embedLibrary, 'a second check lost a package\'s own embedded file')
  // A check that reused the cache leaves no server behind, so an edit of a module it reused is
  // refused as `--no-server` refuses it; a server a cold check left sweeps a module an edit newly
  // imports (#3116).
  const served = join(directory, 'served-edits')
  yield* fs.makeDirectory(join(served, 'src'), { recursive: true })
  yield* fs.writeFileString(join(served, 'silk.toml'), '[package]\nname = "served-edits"\nversion = "0.1.0"\nsilk-version = "0.0.0"\n')
  yield* fs.writeFileString(join(served, 'src/other.silk'), 'pub fn helper() -> i32 { return 1 }\n')
  yield* fs.writeFileString(
    join(served, 'src/main.silk'),
    'import other\nimport third\npub fn main() -> i32 { return other.helper() - third.t() }\n',
  )
  const servedCheck = Effect.fnUntraced(function* (options: ReadonlyArray<string>) {
    return yield* invoke(silk, ['check', ...options, '--stdlib', standardLibrary], served, splitEnvironment)
  })
  const missingModule = yield* servedCheck(['--no-server'])
  assert.match(missingModule.stdout + missingModule.stderr, /main\.silk:2:8: error\[MOD0001\]/)
  yield* fs.writeFileString(join(served, 'src/main.silk'), 'import other\npub fn main() -> i32 { return other.helper() - 1 }\n')
  const reused = yield* servedCheck([])
  assert.equal(reused.status, 0, reused.stdout + reused.stderr)
  yield* fs.writeFileString(join(served, 'src/other.silk'), 'import third\npub fn helper() -> i32 { return third.t() }\n')
  const servedEdit = yield* servedCheck([])
  assert.match(servedEdit.stdout + servedEdit.stderr, /other\.silk:1:8: error\[MOD0001\]/, 'a check missed an edit of a module the cache answered')
  yield* fs.remove(join(served, 'build'), { recursive: true })
  yield* fs.writeFileString(join(served, 'src/other.silk'), 'pub fn helper() -> i32 { return 1 }\n')
  // Nothing imports `extra` yet; a file added later would change the program's shape instead.
  yield* fs.writeFileString(join(served, 'src/extra.silk'), 'pub fn more() -> i32 { return true }\n')
  const coldServer = yield* servedCheck([])
  assert.equal(coldServer.status, 0, coldServer.stdout + coldServer.stderr)
  yield* fs.writeFileString(join(served, 'src/main.silk'), 'import other\nimport extra\npub fn main() -> i32 { return other.helper() + extra.more() }\n')
  const newlyImported = yield* servedCheck([])
  assert.match(newlyImported.stdout + newlyImported.stderr, /extra\.silk:1:\d+: error\[SEM0129\]/, 'the check server did not sweep a newly imported module')
  // Every check reports a syntax error while it stays, not only the first one after the edit.
  yield* fs.writeFileString(join(served, 'src/extra.silk'), 'pub fn more() -> i32 { return 1 \n')
  for (const attempt of ['first', 'second']) {
    const broken = yield* servedCheck(['--no-server'])
    assert.match(broken.stdout + broken.stderr, /extra\.silk:2:1: error\[PAR0001\]/, `the ${attempt} check missed a syntax error`)
  }
  // A static fn reads the length of an embedded file while the package compiles.
  yield* fs.writeFileString(
    join(embedLibrary, 'src/library.silk'),
    'import silk.build.source { Source }\n\npub fn script() -> &\'static [u8] {\n  return Source.read("js/index.js")\n}\n\n'
      + 'static fn measured() -> usize {\n  return Source.read("js/index.js").length\n}\n\npub fn size() -> usize {\n  return measured()\n}\n',
  )
  yield* fs.writeFileString(
    join(embedApp, 'src/main.silk'),
    'import library.library { script, size }\nimport silk.num.usize\n\npub fn main() -> i32 {\n  if script().length != size() { return 1 }\n  return usize.toI32(size())\n}\n',
  )
  yield* embedAppRun(45)
  // `silk pack` refuses an archive that would lack a file its sources embed, since a package that
  // depends on the archive reads the file from it; naming the file in `include` packs it.
  const embedPack = Effect.fnUntraced(function* () {
    return yield* invoke(
      silk,
      ['pack', '--output', join(directory, 'embed-packed'), '--stdlib', standardLibrary],
      embedLibrary,
      splitEnvironment,
    )
  })
  // Only the modules the package's check reads count: a module nothing imports, as a test module
  // is, may embed a fixture the archive leaves out. `--list` still lists.
  yield* fs.makeDirectory(join(embedLibrary, 'fixtures'), { recursive: true })
  yield* fs.writeFileString(join(embedLibrary, 'fixtures/case.txt'), 'fixture\n')
  yield* fs.writeFileString(
    join(embedLibrary, 'src/tests.silk'),
    'import silk.build.source { Source }\n\npub fn fixture() -> &\'static [u8] { return Source.read("fixtures/case.txt") }\n',
  )
  const embedListed = yield* invoke(silk, ['pack', '--list'], embedLibrary, splitEnvironment)
  assert.equal(embedListed.status, 0, embedListed.stdout + embedListed.stderr)
  assert.match(embedListed.stdout, /^src\/library\.silk$/m)
  const unpacked = yield* embedPack()
  assert.notEqual(unpacked.status, 0, 'an archive without an embedded file was packed')
  assert.match(
    unpacked.stderr,
    /silk pack: embed-library: module library\.silk embeds js\/index\.js, which the archive would not hold; add it to \[package\]\.include/,
  )
  assert.doesNotMatch(unpacked.stderr, /fixtures/)
  yield* fs.writeFileString(
    join(embedLibrary, 'silk.toml'),
    '[package]\nname = "embed-library"\nversion = "0.1.0"\nsilk-version = "' + releasePin + '"\nkind = "library"\nmain = "library.silk"\nexports = ["library"]\ninclude = ["js"]\n',
  )
  const packedEmbed = yield* embedPack()
  assert.equal(packedEmbed.status, 0, packedEmbed.stdout + packedEmbed.stderr)
  yield* Console.log(
    'Native build CLI: exact LLVM output, Clang bypass, --clang, default linking/cleanup, selector validation, project run, clean, init, compilation definitions, requests, bindings, source root, path dependencies, native source globs and per-file flags, native archives, exports, workspaces, silk change release/history/recovery, retention, runtime requests, format reports, installed standard library, clang on PATH, version, help, check, project test, cached codegen units, build replay, check replay, embedded files, compressed embedded files, embedded files of a dependency, object and static library artifacts and emission stages passed',
  )
})
const require = createRequire(new URL('../../package.json', import.meta.url))
const { NodeServices }: typeof import('@effect/platform-node') = await import(
  pathToFileURL(require.resolve('@effect/platform-node')).href
)
await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
