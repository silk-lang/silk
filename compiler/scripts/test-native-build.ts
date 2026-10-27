// One prebuilt native compiler exercises its private request/build routes together.
import { strict as assert } from 'node:assert'
import { spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
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
  const locks = caches.flatMap(directories).flatMap((cache) => readdirSync(cache).filter((name) => name.endsWith('.lock')).map((name) => join(cache, name)))
  if (locks.length === 0) return
  const waited = spawnSync('python3', ['-c', 'import fcntl, sys\nfor path in sys.argv[1:]:\n    fcntl.flock(open(path), fcntl.LOCK_SH)', ...locks], { encoding: 'utf8' })
  assert.equal(waited.status, 0, waited.stderr)
}
const invoke = Effect.fnUntraced(function* (
  command: string,
  args: ReadonlyArray<string>,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  timeout = 30_000,
): Effect.fn.Return<SpawnSyncReturns<string>, VerificationError> {
  return yield* Effect.try({
    try: () => {
      const ran = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout })
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
    '[package]\nname = "native-build"\nversion = "0.1.0"\nsource = "."\n',
  )
  const sentinel = join(directory, 'clang-sentinel')
  const marker = join(directory, 'clang-called')
  yield* fs.writeFileString(sentinel, `#!/bin/sh\nprintf called > ${quote(marker)}\nexit 99\n`)
  yield* fs.chmod(sentinel, 0o755)
  // The standard library supplies the catalog runtime that roots the build.
  const standardLibrary = join(repository, 'stdlib')
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
  assert.equal(helpFormat.stdout, 'usage: silk format [paths] [--check] [--manifest-path <path>]\n')
  const helpDocReference = yield* invoke(silk, ['help', 'doc-reference'], directory)
  assert.equal(helpDocReference.status, 0, helpDocReference.stderr)
  assert.match(helpDocReference.stdout, /^usage: silk doc-reference \[--stdlib-root <directory>\] --output/)
  // The project form of `build` comes before the single-file form.
  const helpBuild = yield* invoke(silk, ['help', 'build'], directory)
  assert.equal(helpBuild.status, 0, helpBuild.stderr)
  assert.match(helpBuild.stdout, /^usage: silk build \[--manifest-path <path>\].*\n {7}silk build <source> -o <output>/)
  const helpUnknown = yield* invoke(silk, ['help', 'frobnicate'], directory)
  assert.equal(helpUnknown.status, 2, helpUnknown.stderr)
  assert.match(helpUnknown.stderr, /^silk: unknown command `frobnicate`\nusage: silk <command>/)
  // `silk <command> --help` prints that command's lines of the usage.
  const commandHelp = yield* invoke(silk, ['format', '--help'], directory)
  assert.equal(commandHelp.status, 0, commandHelp.stderr)
  assert.equal(commandHelp.stdout, 'usage: silk format [paths] [--check] [--manifest-path <path>]\n')
  // `run` lists the progress options it accepts.
  const runHelp = yield* invoke(silk, ['run', '--help'], directory)
  assert.equal(runHelp.status, 0, runHelp.stderr)
  assert.match(runHelp.stdout, /^usage: silk run .*\[--progress auto\|live\|plain\|never\] \[--quiet\]/)
  // Toolchains belong to the silk tool, not the compiler: `silk toolchain` and `+<version>` are unknown here.
  const toolchain = yield* invoke(silk, ['toolchain'], directory)
  assert.equal(toolchain.status, 2, toolchain.stderr)
  assert.match(toolchain.stderr, /^silk: unknown command `toolchain`\n/)
  // A command line that does not parse is a usage error, status 2, like format's and doc's.
  const unparsed = yield* invoke(silk, ['check', '--bogus'], directory)
  assert.equal(unparsed.status, 2, unparsed.stderr)
  assert.match(unparsed.stderr, /^silk check: unknown option `--bogus`\nusage: silk check /)
  // A misspelled option is named with the closest one the command takes.
  const relase = yield* invoke(silk, ['check', '--relase'], directory)
  assert.equal(relase.status, 2, relase.stderr)
  assert.match(relase.stderr, /^silk check: unknown option `--relase`; did you mean `--release`\?\n/)
  const combined = yield* invoke(silk, ['init', '--lib', '--workspace'], directory)
  assert.equal(combined.status, 2, combined.stderr)
  assert.match(combined.stderr, /^silk init: `--lib` and `--workspace` cannot be combined/)
  // A lone word that names no file is a mistyped command, not a source to dump.
  const unknown = yield* invoke(silk, ['frobnicate'], directory)
  assert.equal(unknown.status, 2, unknown.stderr)
  assert.match(unknown.stderr, /^silk: unknown command `frobnicate`\n/)
  // A path-like word that names no file reports that file, also as a usage error.
  for (const missing of ['missing.silk', './frob']) {
    const absent = yield* invoke(silk, [missing], directory)
    assert.equal(absent.status, 2, absent.stderr)
    assert.ok(absent.stderr.startsWith(`silk: no such source file \`${missing}\`;`), absent.stderr)
  }
  // Release notes belong to the silk tool (`silk change`), not the compiler.
  const changes = yield* invoke(silk, ['changes'], directory)
  assert.equal(changes.status, 2, changes.stderr)
  assert.match(changes.stderr, /^silk: unknown command `changes`\n/)
  // Build the silk tool with the compiler under test and exercise its linked changes library through
  // the native entry point. No compiler, Git, or other tool is available on this subprocess PATH.
  const silkTool = join(directory, 'silktool')
  const toolBuild = yield* invoke(
    silk,
    ['build', 'src/main.silk', '-o', silkTool, '--stdlib', standardLibrary],
    join(repository, 'tool'),
    { ...process.env, SILK_CLANG: clang },
    600_000,
  )
  assert.equal(toolBuild.status, 0, toolBuild.stderr)
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
    '[package]\nname = "native-release"\nversion = "1.0.0"\n[release]\nversion-file = "src/ReleaseVersion.silk"\n',
  )
  yield* fs.writeFileString(
    join(releaseWorkspace, 'changes/silk.toml'),
    '[package]\nname = "release-consumer"\nversion = "0.1.0"\n\n[dependencies]\nreleased = { path = "../compiler" }\n',
  )
  for (const args of [
    ['change'],
    ['change', '--help'],
    ['change', '--dir', 'compiler', '--help'],
  ]) {
    const help = yield* invoke(silkTool, args, releaseWorkspace, changesEnvironment)
    assert.equal(help.status, 0, help.stderr)
    assert.match(help.stdout, /silk change \[--dir PATH\] patch\|minor\|major/)
    assert.equal(help.stderr, '')
  }
  const missingDirectory = yield* invoke(silkTool,
    ['change', '--dir'],
    releaseWorkspace,
    changesEnvironment,
  )
  assert.equal(missingDirectory.status, 1)
  assert.match(missingDirectory.stderr, /silk change: --dir requires/)
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
    ['reserved input', '()', 'yield', '{x18}', '', 'none', true, '(word,)'],
    ...['x18', 'x19', 'x29', 'x30', 'sp', 'rax'].map((register) =>
      [`clobber ${register}`, '()', 'yield', '', register, 'none', true, '()'] as const),
    ['overlapping clobber', 'u64', 'mov $0, #0', '={x0}', 'x0', 'none', true, '()'],
    ['invalid operand lane', '()', 'yield', '{x0}', '', 'none', true, '(narrow,)'],
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
  // wasm32 links freestanding on any host, with the compiler's own C runtime and no host imports.
  const wasm = yield* invoke(
    silk,
    [...argumentsFor('program.wasm'), '--target', 'wasm32-unknown-unknown'],
    directory,
    { ...process.env, SILK_CLANG: clang },
  )
  assert.equal(wasm.status, 0, wasm.stderr)
  assert.equal(yield* fs.exists(join(directory, 'program.wasm.silk-runtime.c')), false)
  const wasmModule = new WebAssembly.Module(yield* fs.readFile(join(directory, 'program.wasm')))
  assert.deepEqual(WebAssembly.Module.imports(wasmModule), [])
  assert.deepEqual(
    WebAssembly.Module.exports(wasmModule)
      .map((entry) => entry.name)
      .sort(),
    ['main', 'memory'],
    'a module exports only its named C exports and its memory',
  )
  const wasmMain = new WebAssembly.Instance(wasmModule, {}).exports.main as () => number
  assert.equal(wasmMain(), 42)
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
      'import silk.layout { Layout }',
      'import silk.pointer { Pointer }',
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
  assert.match(cleaned.stdout, /^Removed \S+build\n$/)
  const recleaned = yield* invoke(silk, ['clean'], directory)
  assert.equal(recleaned.status, 0, recleaned.stderr)
  assert.match(recleaned.stdout, /^Nothing to clean: \S+build does not exist\n$/)
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
  assert.equal(checked.stderr.match(/^Finished greeting in /gm)?.length, 2, checked.stderr)
  assert.doesNotMatch(checked.stderr, /\x1b/)
  assert.equal(yield* fs.exists(marker), false, 'check must not invoke Clang')
  yield* fs.makeDirectory(join(directory, 'rejected/src'), { recursive: true })
  yield* fs.writeFileString(
    join(directory, 'rejected/silk.toml'),
    '[package]\nname = "rejected"\nversion = "0.1.0"\n',
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
    '[package]\nname = "unknown"\nversion = "0.1.0"\n',
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
    '[package]\nname = "casing"\nversion = "0.1.0"\n',
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
  // A package that cannot be loaded ends its load row as failed and still names itself on its
  // final line.
  yield* fs.makeDirectory(join(directory, 'unexported/src'), { recursive: true })
  yield* fs.writeFileString(
    join(directory, 'unexported/silk.toml'),
    '[package]\nname = "unexported"\nversion = "0.1.0"\nexports = ["nope"]\n',
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
    /^Checking unexported \([^\n]*\)\n  load     failed: 1 error +[0-9.ms ]+s\nInvalid Silk project manifest [^\n]*unexported\/silk\.toml:4: exports of unexported@0\.1\.0: nope is not a module of the package\nFailed unexported in /,
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
    '[package]\nname = "synchronous"\nversion = "0.1.0"\n\n[unstable]\ncomposition = { runtimes = [{ name = "synchronous", module = "silk/native_start_sync" }], defaults = ["synchronous"] }\n',
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
      /^src\/main\.silk:1:8: error\[SEM0225\] Entry point `main` has a result or requirement the selected runtime `silk\/native_start_sync` cannot start/m,
    )
    assert.doesNotMatch(refused.stderr, /native_start_sync\.silk:/)
  }
  // A `main` that returns a borrow such as `string` gets the entry point error once, not the
  // `'static` hint that only leads to it.
  yield* fs.makeDirectory(join(directory, 'textmain/src'), { recursive: true })
  yield* fs.writeFileString(
    join(directory, 'textmain/silk.toml'),
    '[package]\nname = "textmain"\nversion = "0.1.0"\n',
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
    'import silk.effect { Effect }\nimport silk.fiber { Fiber }\nimport silk.logger { Logger, LogError }\nimport silk.monotonic_clock { MonotonicClock }\nimport silk.allocator { OutOfMemoryError }\nimport silk.scheduler { Scheduler, TaskIdExhaustedError }\nimport silk.string { String }\n\n' +
    `effect fn root<'text>(title: string<'text>) -> () ! OutOfMemoryError | TaskIdExhaustedError ? &mut Scheduler | &mut MonotonicClock {\n  ${body}\n  drop fiber\n}\n\npub fn main() -> i32 {\n  return 0\n}\n`
  // A method call that borrows its receiver names the receiver, not the method.
  const boardRoot = (body: string) =>
    'struct Board {\n  pub items: [i32; 2],\n  pub count: usize,\n}\n\nimpl Board {\n  fn add(self: &mut Self, value: i32) -> usize {\n    self.items[0] = value\n    return self.count\n  }\n\n  fn first(self: &Self) -> &i32 {\n    return &self.items[0]\n  }\n}\n\n' +
    `pub fn main() -> i32 {\n  ${body}\n  return 0\n}\n`
  const testRoot = (body: string) =>
    `import silk.testing { AssertionError, Testing }\n\n${body}\npub fn main() -> i32 {\n  return 0\n}\n`
  const subjects: Array<{ name: string; files: Record<string, string>; pattern: RegExp; errors?: number }> = [
    {
      name: 'fiberlogger',
      files: {
        'main.silk': fiberRoot('let fiber = run Fiber<(), LogError>.forkChild(shout())') +
          'effect fn shout() -> () ! LogError ? &mut Logger { run Effect.log("reminder!\\n", &()) }\n',
      },
      pattern: /error\[SEM0076\] The Effect passed here also requires &mut Logger, but the expected Effect may only require &mut Scheduler \| &mut MonotonicClock/,
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
      pattern: /error\[SEM0001\] Unknown type Copy; is `import silk\.ownership \{ Copy \}` missing\?/,
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
        'main.silk': 'import silk.os_logger { StdoutLogger }\n\npub fn main() -> i32 {\n  let l = StdoutLogger.make()\n  drop l.info("x")\n  return 0\n}\n',
      },
      pattern: /error\[SEM0010\] silk\.os_logger\.StdoutLogger has no method `info`/,
    },
    {
      name: 'optionmethod',
      files: {
        'main.silk': 'import silk.option { Option }\n\npub fn main() -> i32 {\n  let o = Option<i32>.some(1)\n  drop o.frob()\n  return 0\n}\n',
      },
      pattern: /error\[SEM0010\] silk\.option\.Option<i32> has no method `frob`/,
    },
    // `==` on two values whose type implements Equal is told to compare shared borrows.
    {
      name: 'borrowedequal',
      files: {
        'main.silk': 'import silk.equal { Equal }\n\nstruct Id { value: i32, }\n\nfn same(left: &Id, right: &Id) -> bool { return left.value == right.value }\n\nimpl Equal for Id { equals: same }\n\npub fn main() -> i32 {\n  let a = Id { value: 1 }\n  let b = Id { value: 1 }\n  if a == b { return 1 }\n  return 0\n}\n',
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
      files: { 'main.silk': 'import silk.i64 { ParseError }\n\npub fn main() -> i32 {\n  return 0\n}\n' },
      pattern: /error\[SEM0015\] `ParseError` is not declared in silk\.i64, which only imports it; import it from silk\.format/,
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
        'main.silk': 'import silk.effect { Effect }\nimport silk.logger { LogError }\nimport silk.option { Option }\nimport silk.os_logger { StdoutLogger }\n\npub effect fn main() -> () ! LogError {\n  let mut logger = StdoutLogger.make()\n  let o = Option<i32>.some(3)\n  run Effect.log("v {o}", &.{ o: move o }) |> Effect.provideMut(&mut logger)\n}\n',
      },
      pattern: /no implementation of `silk\.format\.Display` exists for `silk\.option\.Option<i32>`; it implements `silk\.format\.Debug`, so a template prints it with `\{value:\?\}`/,
    },
    {
      name: 'displaynodebug',
      files: {
        'main.silk': 'import silk.effect { Effect }\nimport silk.logger { LogError }\nimport silk.os_logger { StdoutLogger }\n\nstruct Plain { value: i32, }\n\npub effect fn main() -> () ! LogError {\n  let mut logger = StdoutLogger.make()\n  let p = Plain { value: 1 }\n  run Effect.log("v {p}", &.{ p: move p }) |> Effect.provideMut(&mut logger)\n}\n',
      },
      pattern: /no implementation of `silk\.format\.Display` exists for `main\.Plain`\n/,
    },
    // Operands read through a reference print with their lifetime elided.
    {
      name: 'fieldoperator',
      files: { 'main.silk': "struct W<'t> { text: string<'t>, }\n\nfn f(l: &W, r: &W) -> bool { return l.text < r.text }\n\npub fn main() -> i32 {\n  return 0\n}\n" },
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
      files: { 'main.silk': 'import silk.system_clock { Instant }\n\nfn f(now: &Instant) -> i64 { return now.seconds() }\n\npub fn main() -> i32 {\n  return 0\n}\n' },
      pattern: /error\[SEM0028\] Field `seconds` of silk\.system_clock\.Instant is private; read it with `SystemClock\.seconds\(&value\)` instead/,
    },
    // A provision that matches nothing names the provider, the service and what the Effect requires.
    {
      name: 'providerselector',
      files: { 'main.silk': 'import silk.effect { Effect }\n\nservice Doorbell {\n  effect fn ring() -> () ? &mut Doorbell\n}\n\nstruct Counting { rung: i32, }\n\nimpl Doorbell for Counting {\n  effect fn ring(self: &mut Self) -> () {\n    self.rung = self.rung + 1\n  }\n}\n\neffect fn visit() -> () ? &mut Doorbell {\n  run Doorbell.ring()\n}\n\nimport silk.system_clock { SystemClock }\n\npub effect fn main() -> i32 {\n  let mut bell = Counting { rung: 0 }\n  run visit() |> Effect.provideMut<SystemClock>(&mut bell)\n  return bell.rung\n}\n' },
      pattern: /error\[SEM0123\] The Effect does not require silk\.system_clock\.SystemClock; it requires &mut main\.Doorbell/,
    },
    {
      name: 'providerunimplemented',
      files: { 'main.silk': 'import silk.effect { Effect }\n\nservice Doorbell {\n  effect fn ring() -> () ? &mut Doorbell\n}\n\nstruct Counting { rung: i32, }\n\nimpl Doorbell for Counting {\n  effect fn ring(self: &mut Self) -> () {\n    self.rung = self.rung + 1\n  }\n}\n\neffect fn visit() -> () ? &mut Doorbell {\n  run Doorbell.ring()\n}\n\npub effect fn main() -> i32 {\n  let mut plain = 3\n  run visit() |> Effect.provideMut<Doorbell>(&mut plain)\n  return plain\n}\n' },
      pattern: /error\[SEM0123\] i32 does not implement main\.Doorbell, so it cannot provide it/,
    },
    {
      name: 'providernone',
      files: { 'main.silk': 'import silk.effect { Effect }\n\nservice Doorbell {\n  effect fn ring() -> () ? &mut Doorbell\n}\n\nstruct Counting { rung: i32, }\n\nimpl Doorbell for Counting {\n  effect fn ring(self: &mut Self) -> () {\n    self.rung = self.rung + 1\n  }\n}\n\neffect fn visit() -> () ? &mut Doorbell {\n  run Doorbell.ring()\n}\n\npub effect fn main() -> i32 {\n  let mut plain = 3\n  run visit() |> Effect.provideMut(&mut plain)\n  return plain\n}\n' },
      pattern: /error\[SEM0123\] i32 implements none of the services the Effect requires: &mut main\.Doorbell/,
    },
    // A test cannot declare a requirement row, so SEM0071 there only offers a provider.
    {
      name: 'testrequirement',
      files: { 'main.silk': 'import silk.effect { Effect }\n\nservice Doorbell {\n  effect fn ring() -> () ? &mut Doorbell\n}\n\nstruct Counting { rung: i32, }\n\nimpl Doorbell for Counting {\n  effect fn ring(self: &mut Self) -> () {\n    self.rung = self.rung + 1\n  }\n}\n\neffect fn visit() -> () ? &mut Doorbell {\n  run Doorbell.ring()\n}\n\npub fn main() -> i32 {\n  return 0\n}\n\ntest effect fn rings() -> () {\n  run visit()\n}\n' },
      pattern: /error\[SEM0071\] This `run` needs `&mut Doorbell`, which a test cannot declare; provide it with `\|> Effect\.provideMut\(&mut value\)`/,
    },
    // A conformance member returning another type names both types.
    {
      name: 'witnessresult',
      files: { 'main.silk': 'import silk.system_clock { SystemClock }\n\nstruct Fixed {}\n\nimpl SystemClock for Fixed {\n  effect fn now(self: &mut Self) -> i64 { return 0 }\n  effect fn getResolution(self: &mut Self) -> u64 { return 1 }\n}\n\npub fn main() -> i32 {\n  return 0\n}\n' },
      pattern: /error\[SEM0083\] Invalid conformance: member `now` does not match the operation of `SystemClock`: it returns `i64`, but the operation returns `silk\.system_clock\.Instant`/,
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
      `[package]\nname = "${entry.name}"\nversion = "0.1.0"\n`,
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
    '[package]\nname = "broken"\nversion = "0.1.0"\n',
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
    '[package]\nname = "ownruntime"\nversion = "0.1.0"\n\n[unstable]\ncomposition = { runtimes = [{ name = "start", module = "support/start" }], defaults = ["start"] }\n',
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
    '[package]\nname = "spec"\nversion = "0.1.0"\nsource = "."\nexports = ["sized"]\n',
  )
  yield* fs.writeFileString(
    join(directory, 'staticspec/spec/sized.silk'),
    'pub fn sized(static n: i64) -> i64 {\n  static if n > 3 { compileError("size too big") }\n  return n\n}\n',
  )
  yield* fs.writeFileString(
    join(directory, 'staticspec/app/silk.toml'),
    '[package]\nname = "app"\nversion = "0.1.0"\n\n[dependencies]\nspec = { path = "../spec" }\n',
  )
  yield* fs.writeFileString(
    join(directory, 'staticspec/app/src/main.silk'),
    'import silk.host_input { HostInput }\nimport spec.sized { sized }\n\npub effect fn main() -> i32\n  ? &mut HostInput {\n  if sized(5) != 5 { return 1 }\n  return 0\n}\n',
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
    '[package]\nname = "core"\nversion = "0.1.0"\nsource = "."\nexports = ["Store"]\n',
  )
  yield* fs.writeFileString(
    join(directory, 'privatedep/core/Store.silk'),
    'pub struct Box { value: i32, }\n\npub fn make() -> Box { return Box { value: 1 } }\n\nfn hidden() -> i32 { return 1 }\n\npub fn shown() -> i32 { return hidden() }\n',
  )
  yield* fs.writeFileString(
    join(directory, 'privatedep/app/silk.toml'),
    '[package]\nname = "app"\nversion = "0.1.0"\n\n[dependencies]\ntaskcore = { path = "../core", package = "core" }\n',
  )
  yield* fs.writeFileString(
    join(directory, 'privatedep/app/src/main.silk'),
    'import taskcore.Store\nimport taskcore.Store { hidden }\n\npub fn main() -> i32 {\n  return Store.make().value\n}\n',
  )
  const privateDependency = yield* invoke(silk, ['check', '--stdlib', standardLibrary], join(directory, 'privatedep/app'))
  assert.equal(privateDependency.status, 1, privateDependency.stderr)
  assert.match(privateDependency.stderr, /error\[SEM0015\] `hidden` is private to taskcore\.Store; mark it `pub` there to use it here/)
  assert.match(privateDependency.stderr, /error\[SEM0028\] Field `value` of [A-Za-z.]*Box is private to the module that declares it\n/)
  // A library's types are named with their package, an impl outside the modules IMPL-004 allows
  // names the rule, and a refusal of the library's own generic body is reported once, at its site.
  yield* fs.makeDirectory(join(directory, 'libmsg/geo/src'), { recursive: true })
  yield* fs.makeDirectory(join(directory, 'libmsg/app/src'), { recursive: true })
  yield* fs.writeFileString(join(directory, 'libmsg/silk.toml'), '[workspace]\nmembers = ["geo", "app"]\n')
  yield* fs.writeFileString(
    join(directory, 'libmsg/geo/silk.toml'),
    '[package]\nname = "geo"\nversion = "0.1.0"\nkind = "library"\nexports = ["lib"]\n',
  )
  yield* fs.writeFileString(
    join(directory, 'libmsg/geo/src/lib.silk'),
    'pub interface Shape {\n  fn area(shape: &Self) -> i64\n}\n\npub struct Square {\n  side: i64,\n}\n\npub struct Best<T> {\n  value: T,\n  score: i64,\n}\n\npub fn keep<T>(value: T) -> Best<T> {\n  let best = Best<T> { value: move value, score: 1 }\n  return best\n}\n',
  )
  yield* fs.writeFileString(
    join(directory, 'libmsg/app/silk.toml'),
    '[package]\nname = "app"\nversion = "0.1.0"\n\n[dependencies]\ngeo = { path = "../geo" }\n',
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
    'import silk.format { Debug, Format, Formatter }\nimport silk.writer { Writer, WriterError }\n\npub struct BadSide {}\n\nimpl Debug for BadSide {\n  effect fn debug(self: &Self, formatter: &mut Formatter) -> () ! WriterError ? &mut Writer {\n    return run Format.debugFields(self, "BadSide", &mut formatter)\n  }\n}\n\npub effect fn side(length: i64) -> i64 ! BadSide {\n  if length < 0 { fail BadSide {} }\n  return length\n}\n',
  )
  yield* fs.writeFileString(
    join(directory, 'libmsg/app/src/main.silk'),
    'import geo.lib { BadSide, side }\n\npub effect fn main() -> i32 ! BadSide {\n  let length = run side(-1)\n  return 0\n}\n',
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
  yield* fs.writeFileString(join(directory, 'libmsg/geo/silk.toml'), '[package]\nname = "geo"\nversion = "0.1.0"\n')
  const kindless = yield* invoke(silk, ['check', '--stdlib', standardLibrary], join(directory, 'libmsg'))
  assert.match(
    kindless.stderr,
    /^Skipping geo: its root module \(\[package\]\.main\) is missing\n {2}help: its source root has lib\.silk; a library sets `kind = "library"` and `exports = \["lib"\]` under \[package\]$/m,
  )
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
    ["lendtwice", "fn both(mut f: mut fn(i32) -> i32, mut g: mut fn(i32) -> i32) -> i32 {\n  return f(1) + g(2)\n}\n\npub fn main() -> i32 {\n  let mut total = 0\n  let mut acc = fn(x: i32) -> i32 {\n    total = total + x\n    return total\n  }\n  return both(acc, acc)\n}\n", /src\/main\.silk:11:20: error\[OWN0010\] A mutable borrow of `acc` conflicts with an earlier mutable borrow of it that is still in use/],
    ["closureescape", "struct Base { value: i32, }\n\nimpl Base {\n  fn peek(self: &Self) -> i32 { return self.value }\n}\n\nfn make() -> fn<'static>(i32) -> i32 {\n  let base = Base { value: 2 }\n  return fn(x: i32) -> i32 { return x + base.peek() }\n}\n\npub fn main() -> i32 {\n  return make()(1)\n}\n", /error\[OWN0018\] The returned callable borrows `base`, a local of this function; move it into the callable instead, which makes the result a `once fn<'static>`\n/],
    ["callableresult", "fn adder(n: i32) -> fn(i32) -> i32 {\n  return fn(x: i32) -> i32 { return x + n }\n}\n\npub fn main() -> i32 {\n  return adder(1)(2)\n}\n", /error\[SEM0210\] The result is a callable whose captures could borrow, but the function has no borrowed input they could come from; for a callable that captures only owned data, write `fn<'static>\(\.\.\.\)`, as in `fn<'static>\(i32\) -> i32`\n/],
    ["boundmove", "struct Counter { count: i32, }\n\nimpl Counter {\n  fn peek(self: &Self) -> i32 { return self.count }\n  fn finish(self: Self) -> i32 { return self.count }\n}\n\npub fn main() -> i32 {\n  let counter = Counter { count: 1 }\n  let finish = counter.finish\n  return counter.peek()\n}\n", /error\[OWN0001\] counter was moved and cannot be used again\n/],
    ["callableassign", "struct Counter { count: i32, }\n\nimpl Counter {\n  fn peek(self: &Self) -> i32 { return self.count }\n  fn total(self: &Self) -> i32 { return self.count }\n}\n\npub fn main() -> i32 {\n  let counter = Counter { count: 1 }\n  let mut get = counter.total\n  get = counter.peek\n  return get()\n}\n", /error\[SEM0037\] Every function and closure has its own type, so a binding that holds one cannot be assigned a different one\n/],
    ["plainmismatch", "pub fn main() -> i32 {\n  let count: i32 = \"three\"\n  return count\n}\n", /error\[SEM0037\] Assignment expected i32 but received string<'static>\n/],
    ["ignored", "fn bump(n: i32) -> i32 { return n + 1 }\n\npub fn main() -> i32 {\n  bump(2)\n  return 0\n}\n", /error\[SEM0087\] Expression statement produces i32, but only \(\) or never may be ignored; write `drop` before it to discard the value\n/],
  ]
  const staticCases: Array<[string, string, RegExp]> = [
    ["staticoverflow", "static fn grow(n: u8) -> u8 { return n + 100 }\nconst BIG: u8 = grow(200)\npub fn main() -> i32 { return 0 }\n", /error\[SEM0176\] Static evaluation of `n \+ 100` overflows its integer type\n/],
    ["staticzero", "static fn fib(n: u64) -> u64 { if n < 2 { return n } return fib(n - 1) + fib(n - 2) }\nconst Q: u64 = fib(20) / (fib(0))\npub fn main() -> i32 { return 0 }\n", /error\[SEM0176\] Static evaluation of `fib\(20\) \/ \(fib\(0\)\)` divides by zero\n/],
    ["staticbyte", "import silk.static_text { StaticText }\nstatic fn at(text: string<'static>) -> u8 { return StaticText.byteAt(text, 50) }\nconst L: u8 = at(\"loud!!\")\npub fn main() -> i32 { return 0 }\n", /error\[SEM0176\] Static evaluation stops: index 50 is past the end of the 6-byte text\n/],
    ["staticplain", "fn plain() -> i32 { return 3 }\nstatic fn s() -> i32 { return plain() }\nconst P: i32 = s()\npub fn main() -> i32 { return 0 }\n", /error\[SEM0176\] `plain` is an ordinary fn, so static evaluation cannot call it; mark it `static fn` to call it here\n/],
    ["phasebinding", "import silk.reflect { Reflect }\npub struct Stats { pub hits: i32, }\npub fn main() -> i32 { let f = Reflect.fields<Stats>() return 0 }\n", /error\[SEM0176\] Phase-only values exist only during static evaluation, so a runtime binding of a phase-only value is not allowed\n/],
    ["constcycle", "const A: i32 = B\nconst B: i32 = A\npub fn main() -> i32 { return A }\n", /error\[SEM0223\] `A` and `B` depend on each other in a cycle, so none of them can be resolved\n/],
  ]
  const interopCases: Array<[string, string, RegExp]> = [
    ["safeexport", "export \"C\" fn twice(v: i32) -> i32 {\n  return v * 2\n}\n\npub fn main() -> i32 {\n  return twice(0)\n}\n", /error\[SEM0082\] `twice\(\.\.\.\)` is unsafe; write `unsafe twice\(\.\.\.\)`, or put it in an `unsafe \{ \}` block\n/],
    ["staticread", "export \"C\" static calls: i32 = 4\n\npub fn main() -> i32 {\n  return calls\n}\n", /error\[SEM0082\] Reading `calls` is unsafe; put it in an `unsafe \{ \}` block\n/],
    ["nocallbacks", "unsafe extern \"C\" fn qsort(base: [*]mut u8, count: usize, size: usize, compare: extern \"C\" fn([*]const u8, [*]const u8) -> i32) -> ()\n\nexport \"C\" fn cmp(a: [*]const u8, b: [*]const u8) -> i32 { return 0 }\n\npub fn main() -> i32 {\n  return 0\n}\n", /error\[SEM0187\] A C function-pointer parameter must be named in the declaration's properties; add `with Intrinsic\.foreign\(callbacks: \("compare",\)\)`\n/],
    ["plaincallback", "import silk.pointer { Pointer }\nunsafe extern \"C\" fn qsort(base: ?[*]mut u8, count: usize, size: usize, compare: extern \"C\" fn([*]const u8, [*]const u8) -> i32) -> () with Intrinsic.foreign(callbacks: (\"compare\",))\n\nfn cmp(a: [*]const u8, b: [*]const u8) -> i32 { return 0 }\n\npub fn main() -> i32 {\n  let mut items: [u8; 4] = [3, 1, 2, 0]\n  unsafe qsort(Pointer.fromMutSlice(&mut items), 4, 1, cmp)\n  return 0\n}\n", /error\[SEM0012\] This parameter takes a C function pointer, and a Silk fn has no C address; pass an `export "C" fn` here\n/],
    ["boolstatic", "export \"C\" static calls: bool = false\n\npub fn main() -> i32 {\n  return 0\n}\n", /error\[SEM0187\] A C static holds one C integer, float, or pointer, so it cannot have type bool\n/],
    ["assignstatic", "export \"C\" static calls: i32 = 0\n\npub fn main() -> i32 {\n  unsafe { calls = 1 }\n  return 0\n}\n", /error\[SEM0036\] `calls` is a C static, which Silk code can read but not assign\n/],
  ]
  // Template errors say what the placeholder needs, at the call, with no note into the standard library.
  const templateUse = (call: string) => `import silk.os_writer { StderrWriter }\n\npub fn main() -> i32 {\n  ${call}\n  return 0\n}\n`
  const templateCases: Array<[string, string, RegExp]> = [
    ["lonebrace", templateUse('StderrWriter.print("} {name}\\n", &.{ name: "Ada" })'), /error\[SEM0177\] a lone `\}` in a template must be written `\}\}`, which writes one `\}`\n/],
    ["widthtext", templateUse('StderrWriter.print("{name:>w$}\\n", &.{ name: "Ada", w: "x" })'), /error\[SEM0121\] A width or precision read from a field, as in `\{name:w\$\}`, needs an integer, and this field is `string<'static>`\n/],
    ["radixtext", templateUse('StderrWriter.print("{:x}\\n", &("Ada",))'), /error\[SEM0121\] A `\{:x\}`, `\{:X\}`, `\{:o\}`, or `\{:b\}` placeholder needs an integer, and this value is `string<'static>`\n/],
    ["exponentint", templateUse('StderrWriter.print("{:e}\\n", &(5,))'), /error\[SEM0121\] A `\{:e\}` or `\{:E\}` placeholder needs a float, and this value is `i32`\n/],
    ["unborrowed", templateUse('StderrWriter.print("{}\\n", 5)'), /error\[SEM0012\] This parameter takes a borrow, and this argument is i32; write `&` before it\n/],
    ["surrogate", "pub fn main() -> i32 {\n  let s = \"\\u{D800}\"\n  return 0\n}\n", /error\[SEM0085\] Invalid static literal: `\\u\{D800\}` is a UTF-16 surrogate, which is not a Unicode scalar value\n/],
    ["abovescalar", "pub fn main() -> i32 {\n  let c = '\\u{110000}'\n  return 0\n}\n", /error\[SEM0085\] Invalid static literal: `\\u\{110000\}` is above `\\u\{10FFFF\}`, the largest Unicode scalar value\n/],
    ["notbyte", "pub fn main() -> i32 {\n  let b = b\"\\u{100}\"\n  return 0\n}\n", /error\[SEM0085\] Invalid static literal: `\\u\{100\}` is not a byte; a byte string holds values up to `\\u\{FF\}`, also written `\\xFF`\n/],
    ["badescape", "pub fn main() -> i32 {\n  let s = \"a\\qb\"\n  return 0\n}\n", /error\[SEM0085\] Invalid static literal: `\\q` is not an escape; /],
    ["textlength", "pub fn main() -> i32 {\n  let t = \"abc\"\n  let n = t.length\n  return 0\n}\n", /error\[SEM0026\] A string has no fields; call the `silk\.string` functions on it, as in `String\.byteLength\(text\)` for its length in bytes\n/],
    ["textindex", "pub fn main() -> i32 {\n  let t = \"abc\"\n  let n = t[0]\n  return 0\n}\n", /error\[SEM0032\] A string cannot be indexed, because a character can take more than one byte; read a byte with `String\.utf8Bytes\(text\)\[i\]`, or step through characters with `String\.nextScalar`\n/],
    ["textmethod", "pub fn main() -> i32 {\n  let t = \"abc\"\n  let n = t.startsWith(\"a\")\n  return 0\n}\n", /error\[SEM0010\] A string has no methods; call `String\.startsWith\(text, \.\.\.\)` instead, with `import silk\.string \{ String \}`\n/],
    ["textplus", "pub fn main() -> i32 {\n  let t = \"abc\"\n  let n = t + \"!\"\n  return 0\n}\n", /error\[SEM0135\] Operator \+ does not join strings; build an owned `String` with `String\.copy` and `String\.append`, or write the text with a `Format\.format` template\n/],
    ["reflectimport", "struct P { x: i32 }\n\npub fn main() -> i32 {\n  let mut n = 0\n  static for f in Reflect.fields<P>() { n = n + 1 }\n  return n\n}\n", /error\[SEM0009\] Unknown name Reflect; is `import silk\.reflect \{ Reflect \}` missing\?\n/],
    ["prefixstar", "fn bump(n: &mut i32) -> () {\n  *n = *n + 1\n}\n\npub fn main() -> i32 {\n  let mut x = 1\n  bump(&mut x)\n  return x\n}\n", /error\[PAR0010\] Silk has no prefix `\*`; a dereference follows the value, as in `n\.\* = n\.\* \+ 1`\n/],
    ["floatkey", "import silk.hash { Hash }\nimport silk.hash_map { HashMap }\n\npub fn main() -> i32 {\n  let counts = HashMap<f64, i32>.make(Hash.seed(1))\n  if HashMap<f64, i32>.contains(&counts, 1.5) { return 1 }\n  return 0\n}\n", /error\[SEM0121\] `f64: silk\.hash\.HashKey` cannot be proved: no implementation of `silk\.hash\.HashKey` exists for `f64`\n/],
    ["unordered", "import silk.allocator { Allocator, OutOfMemoryError }\nimport silk.effect { Effect }\nimport silk.list { List }\n\nstruct P { x: i32, }\n\npub effect fn main() -> () ! OutOfMemoryError {\n  let mut allocator = Allocator.systemAllocatorProvider()\n  let mut l = List<P>.make()\n  run List<P>.sort(&mut l) |> Effect.provideMut<Allocator>(&mut allocator)\n}\n", /error\[SEM0121\] `main\.P: silk\.order\.Order` cannot be proved: no implementation of `silk\.order\.Order` exists for `main\.P`\n/],
    ["resultimport", "import silk.effect { Effect }\n\neffect fn parse() -> i32 ! () { return 1 }\n\npub effect fn main() -> i32 {\n  let parsed = run Effect.result(parse())\n  return match move parsed {\n    Result.Success { value } => value\n    _ => 2\n  }\n}\n", /error\[SEM0009\] Unknown name Result; is `import silk\.result \{ Result \}` missing\?\n/],
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
    ["bareblock", "import silk.ownership { Drop }\n\nstruct Tracer { id: i32, log: i32, }\n\nimpl Drop for Tracer {\n  fn drop(self: &mut Tracer) -> () {\n    return ()\n  }\n}\n\nfn tracer(id: i32) -> Tracer { return Tracer { id: id, log: 0 } }\n\nfn consume(t: Tracer) -> () { return () }\n\npub fn main() -> i32 {\n  {\n    let c = tracer(3)\n  }\n  return 0\n}\n", /error\[PAR0010\] Silk has no bare blocks; move these statements into a helper function, whose locals end when it returns\n/],
    ["replaceborrow", "import silk.ownership { Drop }\n\nstruct Tracer { id: i32, log: i32, }\n\nimpl Drop for Tracer {\n  fn drop(self: &mut Tracer) -> () {\n    return ()\n  }\n}\n\nfn tracer(id: i32) -> Tracer { return Tracer { id: id, log: 0 } }\n\nfn consume(t: Tracer) -> () { return () }\n\npub fn main() -> i32 {\n  let mut slot = tracer(1)\n  let old = Intrinsic.replace(&mut slot, tracer(2))\n  return 0\n}\n", /error\[SEM0036\] `Intrinsic\.replace` takes the place to replace, not a borrow of it; drop the `&mut`, as in `Intrinsic\.replace\(slot, value\)`\n/],
    ["droppartial", "import silk.ownership { Drop }\n\nstruct Tracer { id: i32, log: i32, }\n\nimpl Drop for Tracer {\n  fn drop(self: &mut Tracer) -> () {\n    return ()\n  }\n}\n\nfn tracer(id: i32) -> Tracer { return Tracer { id: id, log: 0 } }\n\nfn consume(t: Tracer) -> () { return () }\n\npub fn main() -> i32 {\n  let t = tracer(1)\n  let l = move t.log\n  return 0\n}\n", /error\[OWN0002\] main\.Tracer has a Drop hook, so no part of it can be moved out; move or borrow the whole value, or read a Copy part\n/],
    ["loopmove", "import silk.ownership { Drop }\n\nstruct Tracer { id: i32, log: i32, }\n\nimpl Drop for Tracer {\n  fn drop(self: &mut Tracer) -> () {\n    return ()\n  }\n}\n\nfn tracer(id: i32) -> Tracer { return Tracer { id: id, log: 0 } }\n\nfn consume(t: Tracer) -> () { return () }\n\npub fn main() -> i32 {\n  let outer = tracer(1)\n  let mut i = 0\n  while i < 2 {\n    consume(move outer)\n    i = i + 1\n  }\n  return 0\n}\n", /error\[OWN0005\] `outer` is moved inside this loop, so the next iteration would use it after the move; create it inside the loop, or leave the loop right after moving it\n/],
    ["droptwice", "import silk.ownership { Drop }\n\nstruct Tracer { id: i32, log: i32, }\n\nimpl Drop for Tracer {\n  fn drop(self: &mut Tracer) -> () {\n    return ()\n  }\n}\n\nfn tracer(id: i32) -> Tracer { return Tracer { id: id, log: 0 } }\n\nfn consume(t: Tracer) -> () { return () }\n\npub fn main() -> i32 {\n  let first = tracer(1)\n  drop first\n  drop first\n  return 0\n}\n", /error\[OWN0001\] first was moved and cannot be used again\n/],
    ["dropcopy", "import silk.ownership { Copy, Drop }\n\nstruct Tracer { id: i32, log: i32, }\n\nimpl Copy for Tracer {}\n\nimpl Drop for Tracer {\n  fn drop(self: &mut Tracer) -> () {\n    return ()\n  }\n}\n\nfn tracer(id: i32) -> Tracer { return Tracer { id: id, log: 0 } }\n\nfn consume(t: Tracer) -> () { return () }\n\npub fn main() -> i32 { return 0 }\n", /error\[SEM0083\] Invalid conformance: main\.Tracer has a Drop hook, so it cannot be Copy: every copy would run the hook again\n/],
    ["dropmethod", "import silk.ownership { Drop }\n\nstruct Tracer { id: i32, log: i32, }\n\nimpl Drop for Tracer {\n  fn drop(self: &mut Tracer) -> () {\n    return ()\n  }\n}\n\nfn tracer(id: i32) -> Tracer { return Tracer { id: id, log: 0 } }\n\nfn consume(t: Tracer) -> () { return () }\n\npub fn main() -> i32 {\n  let mut c = tracer(1)\n  c.drop()\n  return 0\n}\n", /error\[SEM0010\] `drop` is not a method; write `drop c` to end the value early, which runs its Drop hook, if it has one\n/],
    ["slicelen", "import silk.usize\n\npub fn main() -> i32 {\n  let bytes: &[u8] = b\"abc\"\n  return usize.toI32(bytes.len)\n}\n", /error\[SEM0027\] &'static \[u8\] has no field `len`; its element count is `\.length`\n/],
    ["tupleordinal", "tuple Range(i32, i32)\n\npub fn main() -> i32 {\n  let r = Range(3, 10)\n  return r.2\n}\n", /error\[SEM0027\] main\.Range has no element `\.2`; it has 2 elements, `\.0` and `\.1`\n/],
    ["tuplearity", "tuple Range(i32, i32)\n\npub fn main() -> i32 {\n  let r = Range(3)\n  return 0\n}\n", /error\[SEM0172\] main\.Range expects 2 tuple elements but received 1\n/],
    ["shiftoperator", "pub fn main() -> i32 {\n  let x = (-8 >> 1)\n  return x\n}\n", /error\[PAR0010\] Silk has no `<<` or `>>`; shift with the functions of the value's type, as in `i32\.shiftLeft\(value, count\)` or `i32\.shiftRight\(value, count\)`\n/],
    ["ascast", "import silk.u8\n\npub fn main() -> i32 {\n  let x = (u8.MAX as i32)\n  return x\n}\n", /error\[PAR0002\] Silk has no `as` cast; convert with a function of the source type/],
    ["tuplefields", "tuple Range(i32, i32)\n\npub fn main() -> i32 {\n  let r = Range { 0: 3, 1: 10 }\n  return 0\n}\n", /error\[PAR0010\] A tuple's elements have no field names; build it by position, as in `Pair\(first, second\)`\n/],
    ["ternary", "pub fn main() -> i32 {\n  let c = true\n  let x = c ? 1 : 2\n  return x\n}\n", /error\[PAR0010\] Silk has no `c \? a : b`; write an `if` with a final `else` as the value, as in `if c \{ a \} else \{ b \}`\n/],
    ["matchthroughborrow", "union Status {\n  Open,\n  Done { day: u32 },\n}\n\nfn mark(status: &Status) -> i32 {\n  return match status.* {\n    Status.Open => 0\n    Status.Done { .. } => 1\n  }\n}\n\npub fn main() -> i32 {\n  let s = Status.Open\n  return mark(&s)\n}\n", /error\[OWN0003\] `match status\.\*` would move `status\.\*` out of a borrow, which cannot give it away; write `match &status\.\*` to look at it\n/],
    ["fieldless", templateUse('StderrWriter.print("{}\\n", &5)'), /error\[SEM0177\] a template with placeholders takes its values as fields, such as `&\.\{name: value\}`, `&\(a, b\)`, or `&\(a,\)` for one value; these arguments have no fields\n/],
  ]
  for (const [name, source, expected] of [...lendCases, ...patternCases, ...staticCases, ...interopCases, ...templateCases]) {
    yield* fs.makeDirectory(join(directory, `${name}/src`), { recursive: true })
    yield* fs.writeFileString(join(directory, `${name}/silk.toml`), `[package]\nname = "${name}"\nversion = "0.1.0"\n`)
    yield* fs.writeFileString(join(directory, `${name}/src/main.silk`), source)
    const checked = yield* invoke(silk, ['check', '--stdlib', standardLibrary], join(directory, name))
    assert.equal(checked.status, 1, checked.stderr)
    assert.match(checked.stderr, expected)
    assert.equal(checked.stderr.match(/error\[/g)?.length, 1, checked.stderr)
    assert.doesNotMatch(checked.stderr, /stdlib\/silk\/format\.silk/, checked.stderr)
  }
  // Parking checks run at build time: each names what parks and the rule it breaks.
  const parkingCases: Array<[string, string, RegExp]> = [
    ["parkfinalizer", "import silk.effect { Effect }\nimport silk.fiber { Fiber }\neffect fn finish() -> () {\n  run Fiber<(), ()>.yieldNow()\n  return ()\n}\neffect fn body() -> i32 { return 3 }\npub fn main() -> i32 {\n  return run Effect.ensuringNonParking(body(), finish())\n}\n", /error\[SEM0139\] `finish` must not park, because this call needs an `Intrinsic\.NonParking` value, but running it can park; move work that can suspend, such as `Effect\.sleep`, out of it\n/],
    ["heldaccess", "import silk.allocator { Allocator, OutOfMemoryError }\nimport silk.effect { Effect }\nimport silk.fiber { Fiber }\nimport silk.shared { Shared }\nstruct Counter { value: i32 }\neffect fn noisy() -> () {\n  run Fiber<(), ()>.yieldNow()\n  return ()\n}\nfn bump(c: &mut Counter) -> i32 {\n  run noisy()\n  c.value = c.value + 1\n  return c.value\n}\neffect fn work() -> i32 ! OutOfMemoryError {\n  let mut allocator = Allocator.systemAllocatorProvider()\n  let shared = run (Shared<Counter>.make(Counter { value: 0 })\n    |> Effect.provideMut<Allocator>(&mut allocator))\n  return Shared<Counter>.withMut<i32>(&shared, bump)\n}\neffect fn recover(error: OutOfMemoryError) -> i32 { return -1 }\npub fn main() -> i32 {\n  return run Effect.catchAll(work(), recover)\n}\n", /error\[OWN0016\] `noisy\(\)` runs an Effect while a local-shared access such as `Shared\.withMut` holds its exclusive borrow; take what you need out of the value, return it, and run the Effect after the access returns\n/],
  ]
  for (const [name, source, expected] of parkingCases) {
    yield* fs.makeDirectory(join(directory, `${name}/src`), { recursive: true })
    yield* fs.writeFileString(join(directory, `${name}/silk.toml`), `[package]\nname = "${name}"\nversion = "0.1.0"\n`)
    yield* fs.writeFileString(join(directory, `${name}/src/main.silk`), source)
    const built = yield* invoke(silk, ['build', '--stdlib', standardLibrary], join(directory, name), { ...process.env, SILK_CLANG: clang })
    assert.equal(built.status, 1, built.stderr)
    assert.match(built.stderr, expected)
  }
  // Silk code may call an `export "C"` function directly, through its C symbol.
  yield* fs.makeDirectory(join(directory, 'callexport/src'), { recursive: true })
  yield* fs.writeFileString(join(directory, 'callexport/silk.toml'), '[package]\nname = "callexport"\nversion = "0.1.0"\n')
  yield* fs.writeFileString(join(directory, 'callexport/src/main.silk'), "export \"C\" fn twice(v: i32) -> i32 {\n  return v * 2\n}\n\npub fn main() -> i32 {\n  return unsafe twice(21)\n}\n")
  const exportCall = yield* invoke(silk, ['run', '--stdlib', standardLibrary], join(directory, 'callexport'), { ...process.env, SILK_CLANG: clang })
  assert.equal(exportCall.status, 42, exportCall.stderr)
  // A shift count out of range is the caller's mistake, so the trap names the caller's line.
  yield* fs.makeDirectory(join(directory, 'shiftcount/src'), { recursive: true })
  yield* fs.writeFileString(join(directory, 'shiftcount/silk.toml'), '[package]\nname = "shiftcount"\nversion = "0.1.0"\n')
  yield* fs.writeFileString(join(directory, 'shiftcount/src/main.silk'), 'import silk.u32\n\nfn count(n: u32) -> u32 { return n + 31 }\n\npub fn main() -> i32 {\n  let shifted = u32.shiftLeft(1, count(1))\n  return u32.toI32(shifted)\n}\n')
  const shiftCount = yield* invoke(silk, ['run', '--stdlib', standardLibrary], join(directory, 'shiftcount'), { ...process.env, SILK_CLANG: clang })
  assert.notEqual(shiftCount.status, 0, shiftCount.stderr)
  assert.match(shiftCount.stderr, /^fatal trap: invalid shift count\n {2}at main\.main \(main:6:17\)$/m)
  // A width or precision field can be any integer, so a bare literal needs no `usize` annotation.
  yield* fs.makeDirectory(join(directory, 'widthint/src'), { recursive: true })
  yield* fs.writeFileString(join(directory, 'widthint/silk.toml'), '[package]\nname = "widthint"\nversion = "0.1.0"\n')
  yield* fs.writeFileString(join(directory, 'widthint/src/main.silk'), 'import silk.os_writer { StderrWriter }\n\npub fn main() -> i32 {\n  StderrWriter.print("[{name:>w$}] [{v:.p$}]\\n", &.{ name: "Ada", w: 5, v: 7, p: 3 })\n  return 0\n}\n')
  const widthInt = yield* invoke(silk, ['run', '--stdlib', standardLibrary], join(directory, 'widthint'), { ...process.env, SILK_CLANG: clang })
  assert.equal(widthInt.status, 0, widthInt.stderr)
  assert.match(widthInt.stderr, /^\[  Ada\] \[007\]$/m)
  // A line that starts with `-1 =>` is the next arm, not a subtraction from the arm before it.
  yield* fs.makeDirectory(join(directory, 'negarm/src'), { recursive: true })
  yield* fs.writeFileString(join(directory, 'negarm/silk.toml'), '[package]\nname = "negarm"\nversion = "0.1.0"\n')
  yield* fs.writeFileString(join(directory, 'negarm/src/main.silk'), "fn pick(n: i32) -> i32 {\n  return match n {\n    7 => 1\n    -1 => 2\n    i32 other => other\n  }\n}\n\npub fn main() -> i32 {\n  return pick(-1) + pick(7) + pick(5)\n}\n")
  const negative = yield* invoke(silk, ['run', '--stdlib', standardLibrary], join(directory, 'negarm'), { ...process.env, SILK_CLANG: clang })
  assert.equal(negative.status, 8, negative.stderr)
  yield* fs.makeDirectory(join(directory, 'lendok/src'), { recursive: true })
  yield* fs.writeFileString(join(directory, 'lendok/silk.toml'), '[package]\nname = "lendok"\nversion = "0.1.0"\n')
  yield* fs.writeFileString(join(directory, 'lendok/src/main.silk'), "fn callMut(mut f: mut fn(i32) -> i32) -> i32 {\n  return f(1)\n}\n\npub fn main() -> i32 {\n  let mut total = 0\n  let mut acc = fn(x: i32) -> i32 {\n    total = total + x\n    return total\n  }\n  let a = callMut(acc)\n  let b = callMut(acc)\n  let c = acc(100)\n  return a + b + c\n}\n")
  const lent = yield* invoke(silk, ['run', '--stdlib', standardLibrary], join(directory, 'lendok'), { ...process.env, SILK_CLANG: clang })
  assert.equal(lent.status, 105, lent.stderr)
  // A syntax error the parser recovered from fails the check phase of a build, before codegen.
  yield* fs.makeDirectory(join(directory, 'unclosed/src'), { recursive: true })
  yield* fs.writeFileString(
    join(directory, 'unclosed/silk.toml'),
    '[package]\nname = "unclosed"\nversion = "0.1.0"\n',
  )
  yield* fs.writeFileString(join(directory, 'unclosed/src/main.silk'), 'pub fn main() -> i32 {\n  return 0\n')
  const unclosed = yield* invoke(
    silk,
    ['build', '--stdlib', standardLibrary, '--progress', 'plain'],
    join(directory, 'unclosed'),
    { ...process.env, SILK_CLANG: clang },
  )
  assert.equal(unclosed.status, 1, unclosed.stderr)
  assert.match(unclosed.stderr, /^ {2}check {4}failed: 1 module, 1 error/m)
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
  // `test` builds the project's runner below <output-dir>/test as an executable, whatever the
  // manifest's artifact, and runs the tests that --file and --filter select; a failing test makes
  // the status 1, and a selection outside the source root is refused before anything is built.
  yield* fs.makeDirectory(join(directory, 'tested/src/util'), { recursive: true })
  yield* fs.writeFileString(
    join(directory, 'tested/silk.toml'),
    '[package]\nname = "tested"\nversion = "0.1.0"\nmain = "main.silk"\nkind = "static-library"\n',
  )
  yield* fs.writeFileString(
    join(directory, 'tested/src/main.silk'),
    'import util.check\n\npub fn answer() -> i32 {\n  return check.half(84)\n}\n\ntest fn rootPasses() -> () {\n}\n',
  )
  yield* fs.writeFileString(
    join(directory, 'tested/src/util/check.silk'),
    'import silk.testing { AssertionError, Testing }\n\npub fn half(value: i32) -> i32 {\n  return value / 2\n}\n\ntest effect fn halvesEvenly() -> () ! AssertionError<\'static> {\n  run Testing.expect(half(84) == 42, "84 halves to 42")\n}\n\ntest effect fn failsOnPurpose() -> () ! AssertionError<\'static> {\n  run Testing.expect(half(3) == 2, "integer division truncates")\n}\n\ntest fn dividesByZero() -> () {\n  let zero: i32 = 0\n  let quotient = half(2) / zero\n}\n',
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
    /1 passed, 0 failed \(0 cached, 1 executed, 1 selected, 4 discovered\)/,
  )
  assert.equal(
    yield* fs.exists(join(directory, 'tested/build/test/llvm', hostTarget, 'debug/tested')),
    true,
  )
  const runnerRecord = join(directory, 'tested/build/test/llvm', hostTarget, 'debug/tested.inputs')
  const firstRecord = yield* fs.readFile(runnerRecord)
  // No test result is stored yet, so a plain `silk test` runs every selected test.
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
  // A selection that matches no test verified nothing, so it fails.
  const unmatchedTests = yield* invoke(
    silk,
    ['test', '--no-cache', '--stdlib', standardLibrary, '--filter', 'zzz'],
    join(directory, 'tested'),
    { ...process.env, SILK_CLANG: clang },
  )
  assert.equal(unmatchedTests.status, 1, unmatchedTests.stderr)
  assert.match(unmatchedTests.stderr, /no tests matched/)
  // A test past its --timeout and a test that overflows the stack each fail with a report naming
  // why, and the remaining tests still run.
  yield* fs.makeDirectory(join(directory, 'stuck/src'), { recursive: true })
  yield* fs.writeFileString(
    join(directory, 'stuck/silk.toml'),
    '[package]\nname = "stuck"\nversion = "0.1.0"\n',
  )
  yield* fs.writeFileString(
    join(directory, 'stuck/src/main.silk'),
    'fn deep(n: i64) -> i64 {\n  if n == 0 { return 0 }\n  return deep(n - 1) + 1\n}\n\npub fn main() -> i32 {\n  return 0\n}\n\ntest fn overflows() {\n  let depth = deep(100000000)\n}\n\ntest fn spins() {\n  let mut i: i64 = 0\n  while i >= 0 {\n    i = i - 1 + 1\n  }\n}\n\ntest fn zFinishes() {\n}\n',
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
    '[package]\nname = "round-shapes"\nversion = "0.1.0"\nkind = "library"\n',
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
      '/// import silk.effect { Effect }',
      '/// import silk.os_writer { StdoutWriter }',
      '/// import silk.writer { Writer, WriterError }',
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
  const unstartedBuild = yield* invoke(
    silk,
    ['build', '--stdlib', standardLibrary, '--clang', join(directory, 'no-such-clang')],
    join(directory, 'tested'),
    { ...process.env, SILK_CLANG: clang },
  )
  assert.equal(unstartedBuild.status, 2, unstartedBuild.stderr)
  assert.match(unstartedBuild.stderr, /no-such-clang \(from --clang\)/)
  // A link counts nothing, so its failed row has no detail after `failed`.
  assert.match(unstartedBuild.stderr, /^  link     failed +[0-9.ms ]+s$/m)
  assert.doesNotMatch(unstartedBuild.stderr, /failed:/)
  assert.match(unstartedBuild.stderr, /^Failed tested in /m)
  // A single-file test without a manifest is refused as a single-file build is.
  // The build directory has a manifest, so the manifest-less source lives in its own directory.
  const unpackaged = yield* fs.makeTempDirectoryScoped({ prefix: 'silk-unpackaged-' })
  yield* fs.writeFileString(join(unpackaged, 'lone.silk'), 'test fn lone() -> () {\n}\n')
  for (const command of ['build', 'test']) {
    const lone = yield* invoke(
      silk,
      [command, 'lone.silk', '-o', 'lone', '--stdlib', standardLibrary, '--no-cache'].slice(
        0,
        command === 'build' ? 6 : 7,
      ),
      unpackaged,
      { ...process.env, SILK_CLANG: clang },
    )
    assert.equal(lone.status, 2, `${command}: ${lone.stderr}`)
    assert.match(lone.stderr, /^No silk\.toml found from /)
  }
  // A native link input refusal names the manifest, the entry and the rule it breaks.
  for (const [entry, rule] of [
    ['{ object = "a.o", library = "m" }', /\[native\]\.link\[0\]: an entry is exactly one/],
    ['{ object = "/tmp/a.o" }', /object \/tmp\/a\.o must be a relative path below the manifest's directory/],
    // Refused only when the link runs, yet named the same way.
    ['{ framework = "Security" }', /\[native\]\.link\[0\]: framework Security links only on macOS targets/],
  ] as const) {
    yield* fs.writeFileString(
      join(unpackaged, 'silk.toml'),
      `[package]\nname = "linked"\nversion = "0.1.0"\nsource = "."\n[native]\nlink = [${entry}]\n`,
    )
    yield* fs.writeFileString(join(unpackaged, 'main.silk'), 'pub fn main() -> i32 {\n  return 0\n}\n')
    const refusedInput = yield* invoke(
      silk,
      ['build', '--stdlib', standardLibrary],
      unpackaged,
      { ...process.env, SILK_CLANG: clang },
    )
    assert.equal(refusedInput.status, 1, refusedInput.stderr)
    assert.match(refusedInput.stderr, /silk: invalid native link input: .*silk\.toml: /)
    assert.match(refusedInput.stderr, rule)
  }
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
  // Each compilation names its artifact relative to the working directory, not the project;
  // standard output stays empty.
  assert.equal(released.stdout, '')
  assert.match(released.stderr, new RegExp(`^Compiling greeting \\(${hostTarget}, release\\)\n`))
  assert.match(released.stderr, /^  codegen  [1-9][0-9,]* functions/m)
  assert.match(
    released.stderr,
    new RegExp(`^Finished greeting/build/llvm/${hostTarget}/release/greeting in [0-9.ms ]+s\n$`, 'm'),
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
  // A named profile builds once in a directory of its own name, so profiles with different
  // package parameters never replace each other's artifact, and conflicts with --release before
  // anything is built.
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
      join(directory, 'greeting/build/llvm', hostTarget, 'fast/greeting'),
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
  // A multi-threaded wasm32 profile links one shared memory the host imports, with the profile's
  // maximum, and runs its native threads as Workers under the stdlib's Node runner.
  const threads = join(directory, 'threads')
  yield* fs.makeDirectory(threads, { recursive: true })
  yield* fs.writeFileString(
    join(threads, 'silk.toml'),
    '[package]\nname = "threads"\nversion = "0.0.0"\nsilk-version = "0.0.0"\nsource = "."\n' +
      '\n[profiles.web]\ntarget = "wasm32-unknown-unknown"\nthreading = "multi"\nmax-memory = "256MiB"\n',
  )
  yield* fs.writeFileString(
    join(threads, 'main.silk'),
    [
      'import silk.allocator { Allocator, OutOfMemoryError }',
      'import silk.box { Box }',
      'import silk.effect { Effect }',
      'import silk.native_thread { NativeThread, SpawnError }',
      'effect fn program() -> i32 ! OutOfMemoryError | SpawnError {',
      '  let mut allocator = Allocator.systemAllocatorProvider()',
      '  let owned = run Box<i32>.make(20) |> Effect.provideMut<Allocator>(&mut allocator)',
      '  let first = run NativeThread.spawn(fn() -> i32 { return (move owned).into() + 1 })',
      '    |> Effect.provideMut<Allocator>(&mut allocator)',
      '  let second = run NativeThread.spawn(fn() -> i32 { return 21 })',
      '    |> Effect.provideMut<Allocator>(&mut allocator)',
      '  return first.join() + second.join()',
      '}',
      'effect fn recover(error: OutOfMemoryError | SpawnError) -> i32 { return -2 }',
      'pub fn main() -> i32 { return run Effect.catchAll(program(), recover) }',
      '',
    ].join('\n'),
  )
  const threaded = yield* invoke(
    silk,
    [
      'build',
      '--manifest-path',
      join('threads', 'silk.toml'),
      '--profile',
      'web',
      '--stdlib',
      standardLibrary,
    ],
    directory,
    { ...process.env, SILK_CLANG: clang },
  )
  assert.equal(threaded.status, 0, threaded.stderr)
  // A Clang older than 22 misreads the bitcode Silk writes, so it is refused.
  const eighteen = join(directory, 'clang-18')
  yield* fs.writeFileString(
    eighteen,
    `#!/bin/sh\nif [ "$1" = --version ]; then echo 'Ubuntu clang version 18.1.3 (1ubuntu1)'; exit 0; fi\nexec ${quote(clang)} "$@"\n`,
  )
  yield* fs.chmod(eighteen, 0o755)
  const tooOld = yield* invoke(
    silk,
    ['build', '--manifest-path', join('threads', 'silk.toml'), '--profile', 'web', '--stdlib', standardLibrary],
    directory,
    { ...process.env, SILK_CLANG: eighteen },
  )
  assert.equal(tooOld.status, 2, tooOld.stderr)
  assert.match(
    tooOld.stderr,
    /^silk: Silk builds need Clang 22 or newer, but \S+clang-18 \(from SILK_CLANG\) is Clang 18; set SILK_CLANG or pass --clang the path of a newer Clang$/m,
  )
  const threadedPath = join(threads, 'build/llvm/wasm32-unknown-unknown/web/threads')
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
  // Freed memory is reused: 100 threads with 1 MiB stacks and repeated list growth fit in 64 MiB.
  const churn = join(directory, 'churn')
  yield* fs.makeDirectory(churn, { recursive: true })
  yield* fs.writeFileString(
    join(churn, 'silk.toml'),
    '[package]\nname = "churn"\nversion = "0.0.0"\nsilk-version = "0.0.0"\nsource = "."\n' +
      '\n[profiles.web]\ntarget = "wasm32-unknown-unknown"\nthreading = "multi"\nmax-memory = "64MiB"\n',
  )
  yield* fs.writeFileString(
    join(churn, 'main.silk'),
    [
      'import silk.allocator { Allocator, OutOfMemoryError }',
      'import silk.effect { Effect }',
      'import silk.list { List }',
      'import silk.native_thread { NativeThread, SpawnError }',
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
      '    let worker = run NativeThread.spawn(fn() -> i32 { return work() })',
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
  const churned = yield* invoke(
    silk,
    [
      'build',
      '--manifest-path',
      join('churn', 'silk.toml'),
      '--profile',
      'web',
      '--stdlib',
      standardLibrary,
    ],
    directory,
    { ...process.env, SILK_CLANG: clang },
  )
  assert.equal(churned.status, 0, churned.stderr)
  const churnRun = yield* invoke(
    process.execPath,
    [
      join(standardLibrary, 'host/wasm-runner.mjs'),
      join(churn, 'build/llvm/wasm32-unknown-unknown/web/churn'),
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
    '[package]\nname = "arena"\nversion = "0.0.0"\nsilk-version = "0.0.0"\nsource = "."\n' +
      '\n[profiles.web]\ntarget = "wasm32-unknown-unknown"\n',
  )
  yield* fs.writeFileString(
    join(arena, 'main.silk'),
    [
      'import silk.allocator { Allocator, OutOfMemoryError }',
      'import silk.arena { Arena }',
      'import silk.box { Box }',
      'import silk.effect { Effect }',
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
  const arenaBuild = yield* invoke(
    silk,
    [
      'build',
      '--manifest-path',
      join('arena', 'silk.toml'),
      '--profile',
      'web',
      '--stdlib',
      standardLibrary,
    ],
    directory,
    { ...process.env, SILK_CLANG: clang },
  )
  assert.equal(arenaBuild.status, 0, arenaBuild.stderr)
  const arenaRun = yield* invoke(
    process.execPath,
    [
      join(standardLibrary, 'host/wasm-runner.mjs'),
      join(arena, 'build/llvm/wasm32-unknown-unknown/web/arena'),
    ],
    directory,
    process.env,
  )
  assert.equal(arenaRun.status, 42, arenaRun.stderr)
  // A profile's CPU features, large code model and static link reach Clang.
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
  // The profile's AVX passes an exported 256-bit vector in one register, which the default
  // profile refuses at `silk check` (SEM0244).
  const tunedMain = 'pub fn main() -> i32 {\n  return 0\n}\n'
  const wideExport = x86
    ? 'export "C" fn silk_tuned_wide(values: simd<f32, 8>) -> simd<f32, 8> { return values }\n\n'
    : ''
  yield* fs.writeFileString(join(tuned, 'src/main.silk'), `${wideExport}${tunedMain}`)
  const tunedHeader = '[package]\nname = "tuned"\nversion = "0.1.0"\nmain = "main.silk"\n'
  yield* fs.writeFileString(
    join(tuned, 'silk.toml'),
    `${tunedHeader}\n[profiles.tuned]\ntarget = "${hostTarget}"\ncpu = { features = ["${x86 ? 'avx2' : 'crc'}"] }\n${
      x86 ? 'code-model = "large"\n' : ''
    }${process.platform === 'darwin' ? '' : 'link = "static"\n'}`,
  )
  const tunedBuild = yield* invoke(
    silk,
    ['build', '--profile', 'tuned', '--stdlib', standardLibrary],
    tuned,
    { ...process.env, SILK_CLANG: recorder },
  )
  assert.equal(tunedBuild.status, 0, tunedBuild.stderr)
  const recorded = (yield* fs.readFileString(argumentLog)).split('\n')
  assert.ok(recorded.includes(x86 ? '+avx2' : '+crc'), recorded.join(' '))
  assert.equal(recorded.includes('-mcmodel=large'), x86, recorded.join(' '))
  assert.equal(recorded.includes('-static'), process.platform !== 'darwin', recorded.join(' '))
  const tunedRun = yield* invoke(
    join(tuned, 'build/llvm', hostTarget, 'tuned/tuned'),
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
    // Static relocation links a dynamically linked executable at a fixed address, without PIE.
    yield* fs.writeFileString(
      join(tuned, 'silk.toml'),
      `${tunedHeader}\n[profiles.fixed]\ntarget = "${hostTarget}"\nrelocation = "static"\n`,
    )
    yield* fs.writeFileString(argumentLog, '')
    const fixedBuild = yield* invoke(
      silk,
      ['build', '--profile', 'fixed', '--stdlib', standardLibrary],
      tuned,
      { ...process.env, SILK_CLANG: recorder },
    )
    assert.equal(fixedBuild.status, 0, fixedBuild.stderr)
    const fixedArguments = (yield* fs.readFileString(argumentLog)).split('\n')
    assert.ok(
      fixedArguments.includes('-fno-pic') && fixedArguments.includes('-no-pie') && !fixedArguments.includes('-static'),
      fixedArguments.join(' '),
    )
    const fixedPath = join(tuned, 'build/llvm', hostTarget, 'fixed/tuned')
    // ELF e_type 2 is an executable loaded at a fixed address; a PIE is 3.
    assert.equal((yield* fs.readFile(fixedPath))[16], 2)
    const fixedRun = yield* invoke(fixedPath, [], tuned)
    assert.equal(fixedRun.status, 0, fixedRun.stderr)
  }
  // Profile fields the native build cannot honor yet, a profile artifact other than the one
  // [package].kind requests, unknown manifest fields and reserved module names are refused
  // before anything is built, naming the manifest line.
  const refusedProfiles = [
    ['sanitizers = ["address"]', /silk\.toml:7: profiles\.p\.sanitizers is not supported by the native compiler yet/],
    ['unwind = "native"', /silk\.toml:7: profiles\.p\.unwind = "native" is not supported by the native compiler yet/],
    ['artifact = "object"', /silk\.toml:7: UnsupportedCombination: profiles\.p\.artifact = "object" differs from \[package\]\.kind = "executable"/],
    ['opt = "speed"', /silk\.toml:7: profiles\.p\.opt is not a supported field/],
  ] as const
  for (const [field, message] of refusedProfiles) {
    yield* fs.writeFileString(
      join(tuned, 'silk.toml'),
      `${tunedHeader}[profiles.p]\ntarget = "${hostTarget}"\n${field}\n`,
    )
    const refusedProfile = yield* invoke(
      silk,
      ['build', '--profile', 'p', '--stdlib', standardLibrary],
      tuned,
      { ...process.env, SILK_CLANG: sentinel },
    )
    assert.equal(refusedProfile.status, 2, `${field} must be refused`)
    assert.match(refusedProfile.stderr, message)
  }
  yield* fs.writeFileString(join(tuned, 'silk.toml'), `${tunedHeader}\n[packge]\nname = "x"\n`)
  const misspelled = yield* invoke(silk, ['check', '--stdlib', standardLibrary], tuned)
  assert.equal(misspelled.status, 2, misspelled.stderr)
  assert.match(misspelled.stderr, /silk\.toml:6: packge is not a supported field/)
  // A quoted profile name, unknown composition fields (also inside its entries), its unsupported
  // requirements and a deployment version on a target that is not Darwin are refused at their
  // manifest line.
  const locatedRefusals = [
    [
      '[unstable]\ncomposition = { runtimes = [{ name = "start", module = "silk/native_start_sync" }], defaults = ["main"] }\n',
      /silk\.toml:6: unstable\.composition\.defaults entry "main" names no runtime in unstable\.composition\.runtimes; it lists "start"/,
    ],
    [
      '[unstable]\ncomposition = { runtimes = [{ name = "start", module = "silk/native_start_sync" }], defaults = ["start"], components = [{ capability = "execution-storage", bindings = [\n  { module = "m", declaration = "f" },\n] }] }\n',
      /silk\.toml:7: unstable\.composition\.components\.bindings entry has no operation/,
    ],
    [
      '[unstable]\ncomposition = { runtimes = [{ name = "start", module = "silk/native_start_sync" }], defaults = ["start"], components = [{ capability = "execution-storage", bindings = [{ operation = "frobnicate", module = "m", declaration = "f" }] }] }\n',
      /silk\.toml:6: unstable\.composition\.components\.bindings\.operation = "frobnicate" is not an operation; use create, acquire, release or destroy/,
    ],
    [
      '[unstable]\ncomposition = { retention = [\n  { module = "main", declaration = "main" },\n], runtimes = [\n  { name = "start", module = "silk/native_start_sync", declaration = "x" },\n], defaults = ["start"] }\n',
      /silk\.toml:9: unstable\.composition\.runtimes\.declaration is not a supported field/,
    ],
    [
      '[unstable]\ncomposition = { components = [{ capability = "other", bindings = [] }] }\n',
      /silk\.toml:6: unstable\.composition\.components\.capability = "other" is not supported by the native compiler/,
    ],
    ['[native]\nplatform-supply = { kind = "native", bogus = 1 }\n', /silk\.toml:6: native\.platform-supply\.bogus is not a supported field/],
    [
      '[config]\nmain.ratio = 1.5\n',
      /silk\.toml:6: InvalidInput: config\.main\.ratio: a package parameter value is an integer, a boolean, a string or an array of them/,
    ],
    ['[config]\nlimit = 1\n', /silk\.toml:6: InvalidInput: config\.limit: name the module before the parameter, as config\.main\.limit/],
    ['[config.main]\nlimit = 1\nratio = 2.5\n', /silk\.toml:7: InvalidInput: config\.main\.ratio: a package parameter value/],
    ['[[build.bindings]]\nparameter = "n"\n', /silk\.toml:5: build\.bindings is an earlier spelling; write config, as config\.main\.limit = 42/],
    ['[profiles.p]\nbindings = []\n', /silk\.toml:6: InvalidInput: profiles\.p\.bindings is an earlier spelling; write config/],
    [
      '[profiles.u]\ntarget = "x86_64-unknown-linux-gnu"\nentry = { kind = "default", bogus = 1 }\n',
      /silk\.toml:7: profiles\.u\.entry\.bogus is not a supported field/,
    ],
    ['[profiles."1fast"]\ntarget = "x86_64-unknown-linux-gnu"\n', /silk\.toml:5: InvalidInput: profiles\.1fast: a profile name is/],
    [
      '[unstable]\ncomposition = { runtimes = [{ name = "start", module = "silk/native_start_sync" }], defaults = ["start"], bogus = 1 }\n',
      /silk\.toml:6: unstable\.composition\.bogus is not a supported field/,
    ],
    [
      '[unstable]\ncomposition = { runtimes = [\n  { name = "start", module = "silk/native_start_sync", bogus = 1 },\n], defaults = ["start"] }\n',
      /silk\.toml:7: unstable\.composition\.runtimes\.bogus is not a supported field/,
    ],
    [
      '[unstable]\ncomposition = { runtimes = [{ name = "start", module = "silk/native_start_sync" }], defaults = ["start"], retention = [{ module = "main", declaration = "main", extra = 1 }] }\n',
      /silk\.toml:6: unstable\.composition\.retention\.extra is not a supported field/,
    ],
    [
      '[unstable]\ncomposition = { runtimes = [{ name = "start", module = "silk/native_start_sync" }], defaults = ["start"], requirements = ["x"] }\n',
      /silk\.toml:6: unstable\.composition\.requirements is not supported by the native compiler yet/,
    ],
    [
      '[profiles.d]\ntarget = "x86_64-unknown-linux-gnu"\ndeployment = "14.0"\n',
      /silk\.toml:7: UnsupportedCombination: profiles\.d\.deployment = "14\.0"/,
    ],
  ] as const
  for (const [tail, message] of locatedRefusals) {
    yield* fs.writeFileString(join(tuned, 'silk.toml'), `${tunedHeader}${tail}`)
    const locatedRefusal = yield* invoke(silk, ['check', '--stdlib', standardLibrary], tuned)
    assert.equal(locatedRefusal.status, 2, locatedRefusal.stderr)
    assert.match(locatedRefusal.stderr, message)
    assert.doesNotMatch(locatedRefusal.stderr, /ARTIFACT-001/)
  }
  // A refused `--profile-input` field is blamed on the flag, not on the manifest.
  yield* fs.writeFileString(join(tuned, 'silk.toml'), tunedHeader)
  const refusedInput = yield* invoke(
    silk,
    ['check', '--profile-input', encodeJson({ target: hostTarget, safety: 'unchecked' }), '--stdlib', standardLibrary],
    tuned,
  )
  assert.equal(refusedInput.status, 2, refusedInput.stderr)
  assert.match(refusedInput.stderr, /^Invalid --profile-input: --profile-input\.safety = "unchecked" is not supported/)
  assert.doesNotMatch(refusedInput.stderr, /silk\.toml/)
  // Without a runtime, an executable that exports no C `main` is refused before Clang links it.
  const mainless = yield* invoke(
    silk,
    ['build', '--profile-input', encodeJson({ target: hostTarget, runtime: { kind: 'none' } }), '--stdlib', standardLibrary],
    tuned,
    { ...process.env, SILK_CLANG: sentinel },
  )
  assert.equal(mainless.status, 2, mainless.stderr)
  assert.match(mainless.stderr, /runtime = \{ kind = "none" \} has no `main`/)
  // An unknown `[workspace]` field is refused at its line.
  const looseWorkspace = join(directory, 'loose-workspace')
  yield* fs.makeDirectory(looseWorkspace, { recursive: true })
  yield* fs.writeFileString(join(looseWorkspace, 'silk.toml'), '[workspace]\nmembers = []\nfoo = 1\n')
  const looseChecked = yield* invoke(silk, ['check', '--stdlib', standardLibrary], looseWorkspace)
  assert.equal(looseChecked.status, 2, looseChecked.stderr)
  assert.match(looseChecked.stderr, /silk\.toml:3: workspace\.foo is not a supported field/)
  yield* fs.writeFileString(join(tuned, 'silk.toml'), tunedHeader)
  yield* fs.makeDirectory(join(tuned, 'src/silk'), { recursive: true })
  yield* fs.writeFileString(join(tuned, 'src/silk/extra.silk'), 'pub fn hi() -> i32 {\n  return 1\n}\n')
  const reserved = yield* invoke(silk, ['check', '--stdlib', standardLibrary], tuned)
  assert.notEqual(reserved.status, 0, reserved.stderr)
  assert.match(reserved.stderr, /`silk` and `Intrinsic` are reserved module names/)
  assert.equal(yield* fs.exists(marker), false)
  // `[config]` values reach the package parameters of every project build.
  yield* fs.makeDirectory(join(directory, 'bound/src'), { recursive: true })
  yield* fs.writeFileString(
    join(directory, 'bound/src/main.silk'),
    'pub param limit: i32 = 1\n\npub fn main() -> i32 {\n  return limit\n}\n',
  )
  yield* fs.writeFileString(
    join(directory, 'bound/silk.toml'),
    '[package]\nname = "bound"\nversion = "0.1.0"\n\n[config]\nmain.limit = 7\n\n[profiles.small]\nconfig.main.limit = 3\n',
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
  const boundProfile = yield* invoke(
    silk,
    ['run', '--profile', 'small', '--stdlib', standardLibrary],
    join(directory, 'bound'),
    { ...process.env, SILK_CLANG: clang },
  )
  assert.equal(boundProfile.status, 3, boundProfile.stderr)
  // A value is checked against the parameter's declared type and refused at its manifest line.
  yield* fs.writeFileString(
    join(directory, 'bound/silk.toml'),
    '[package]\nname = "bound"\nversion = "0.1.0"\n\n[config]\nmain.limit = "seven"\n\n[profiles.small]\nconfig.main.limit = 3\n',
  )
  const mistyped = yield* invoke(silk, ['check', '--stdlib', standardLibrary], join(directory, 'bound'))
  assert.equal(mistyped.status, 1, mistyped.stderr)
  assert.match(mistyped.stderr, /silk\.toml:6: error\[SEM0214\] invalid package parameter binding: the value bound to `limit` does not have its parameter's type/)
  yield* fs.writeFileString(
    join(directory, 'bound/silk.toml'),
    '[package]\nname = "bound"\nversion = "0.1.0"\n\n[config]\nmain.limit = 7\n\n[profiles.small]\nconfig.main.limt = 3\n',
  )
  const misnamed = yield* invoke(silk, ['check', '--profile', 'small', '--stdlib', standardLibrary], join(directory, 'bound'))
  assert.equal(misnamed.status, 1, misnamed.stderr)
  assert.match(misnamed.stderr, /silk\.toml:9: error\[SEM0214\] invalid package parameter binding: module `main\.silk` declares no package parameter `limt`/)
  yield* fs.writeFileString(
    join(directory, 'bound/silk.toml'),
    '[package]\nname = "bound"\nversion = "0.1.0"\n\n[config]\nmain.limit = 7\n',
  )
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
    '[package]\nname = "rooted"\nversion = "0.1.0"\nmain = "app/main.silk"\n',
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
    '[package]\nname = "silk-numbers"\nversion = "0.2.0"\nsource = "src"\nexports = ["scale"]\n',
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
    `[package]\nname = "app"\nversion = "1.0.0"\nsource = "."\n\n[dependencies]\n${dependency}\n`
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
    '[package]\nname = "silk-numbers"\nversion = "0.2.0"\nsource = "src"\nexports = ["scale", "tools"]\n',
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
  const shadowed = yield* invoke(
    silk,
    ['run', '--stdlib', standardLibrary],
    join(directory, 'packaged/app'),
    { ...process.env, SILK_CLANG: sentinel },
  )
  assert.equal(shadowed.status, 2, 'a shadowing dependency name was accepted')
  assert.match(
    shadowed.stderr,
    /Invalid Silk project manifest .*packaged\/app\/silk\.toml:7: dependency `util` of app@1\.0\.0: the name is also/,
  )
  assert.equal(yield* fs.exists(marker), false)
  // A dependency whose silk.toml is not TOML is refused at that manifest's line, with the reason.
  yield* fs.makeDirectory(join(directory, 'packaged/broken'), { recursive: true })
  yield* fs.writeFileString(join(directory, 'packaged/broken/silk.toml'), '[package]\nname = "broken"\nversion = 1.0\n[x\n')
  yield* fs.writeFileString(join(directory, 'packaged/app/silk.toml'), packagedManifest('broken = { path = "../broken" }'))
  const notToml = yield* invoke(
    silk,
    ['run', '--stdlib', standardLibrary],
    join(directory, 'packaged/app'),
    { ...process.env, SILK_CLANG: sentinel },
  )
  assert.equal(notToml.status, 2, 'a dependency that is not TOML was accepted')
  assert.match(
    notToml.stderr,
    /Invalid Silk project manifest .*packaged\/broken\/silk\.toml:4: dependency `broken` of app@1\.0\.0: its silk\.toml is not valid TOML: the line ends before its table header, key or value is complete/,
  )
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
    '[package]\nname = "math"\nversion = "0.1.0"\nsource = "."\nexports = ["twice"]\n',
  )
  yield* fs.writeFileString(
    join(workspace, 'libs/math/twice.silk'),
    'pub fn twice(value: i32) -> i32 {\n  return value * 2\n}\n',
  )
  yield* fs.writeFileString(
    join(workspace, 'app/silk.toml'),
    '[package]\nname = "workspace-app"\nversion = "0.1.0"\nsource = "."\n\n[dependencies]\nmath = { path = "../libs/math" }\n',
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
    '[package]\nname = "tool"\nversion = "0.1.0"\nsource = "."\n',
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
  assert.equal(yield* fs.readFileString(join(managed, 'silk.toml')), '[workspace]\nmembers = ["app"]\n')
  assert.match(managedRoot.stdout, /^Initialized Silk project app at .*\/managed\/app$/m)
  assert.equal(yield* fs.exists(join(managed, 'app/src/main.silk')), true)
  assert.equal(yield* fs.exists(join(managed, 'app/.gitignore')), false)
  const starterRun = yield* invoke(silk, ['run', '--stdlib', standardLibrary], managed, withClang)
  assert.equal(starterRun.status, 0, starterRun.stderr)
  assert.match(starterRun.stdout, /Hello, world!/)
  const namedRoot = yield* invoke(silk, ['init', '--workspace', 'named', '--name', 'store'], directory)
  assert.equal(namedRoot.status, 0, namedRoot.stderr)
  assert.equal(
    yield* fs.readFileString(join(directory, 'named/silk.toml')),
    '[workspace]\nmembers = ["store"]\n',
  )
  assert.match(yield* fs.readFileString(join(directory, 'named/store/silk.toml')), /^name = "store"$/m)
  // The rest of this test assembles its members by hand.
  yield* fs.remove(join(managed, 'app'), { recursive: true })
  yield* fs.remove(join(managed, 'build'), { recursive: true })
  yield* fs.writeFileString(join(managed, 'silk.toml'), '[workspace]\nmembers = []\n')
  const hello = yield* invoke(silk, ['init', 'apps/hello'], managed)
  assert.equal(hello.status, 0, hello.stderr)
  assert.match(hello.stdout, /Added apps\/hello to the workspace members in /)
  const greeting = yield* invoke(silk, ['init', '--lib', 'libs/greeting'], managed)
  assert.equal(greeting.status, 0, greeting.stderr)
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
  assert.match(managedBuild.stderr, /^Finished 2 packages in [^\n]*\n$/m)
  // Each artifact is named from the working directory, the workspace root here, not its package.
  assert.match(
    managedBuild.stderr,
    new RegExp(`^Finished build/llvm/${hostTarget}/debug/hello in `, 'm'),
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
  // standard error; standard output is left to the program.
  const unlinked = yield* invoke(
    silk,
    ['run', '-p', 'hello', '--stdlib', standardLibrary, '--clang', join(managed, 'no-such-clang')],
    managed,
    withClang,
  )
  assert.equal(unlinked.status, 2, unlinked.stderr)
  assert.equal(unlinked.stdout, '')
  assert.match(unlinked.stderr, /^Compiling hello \(/m)
  assert.match(unlinked.stderr, /^  link     failed +[0-9.ms ]+s$/m)
  assert.match(unlinked.stderr, /^Failed hello in /m)
  assert.doesNotMatch(unlinked.stderr + unlinked.stdout, /Run summary/)
  const other = yield* invoke(silk, ['init', 'apps/other'], managed)
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
  // A member that cannot load its dependencies fails on its own; the others still run and the
  // workspace's final line is still written.
  const greetingManifest = join(managed, 'libs/greeting/silk.toml')
  const acyclic = yield* fs.readFileString(greetingManifest)
  yield* fs.writeFileString(
    greetingManifest,
    `${acyclic}\n[dependencies]\nhello = { path = "../../apps/hello" }\n`,
  )
  const cyclic = yield* invoke(silk, ['check', '--stdlib', standardLibrary], managed)
  assert.notEqual(cyclic.status, 0, 'a dependency cycle was checked')
  assert.match(cyclic.stderr, /form a cycle/)
  assert.match(cyclic.stderr, /^Checking other \(/m)
  assert.match(cyclic.stderr, /^Failed 2 of 3 packages in [^\n]*\n$/m)
  yield* fs.writeFileString(greetingManifest, acyclic)
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
  const greetingLibrary = join(managed, 'libs/greeting/src/lib.silk')
  const greetingSource = yield* fs.readFileString(greetingLibrary)
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
    '[package]\nname = "retained"\nversion = "0.1.0"\nsource = "."\n\n[unstable]\ncomposition = { runtimes = [{ name = "start", module = "support/start" }], defaults = ["start"], retention = [{ module = "support/keep", declaration = "capability" }] }\n',
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
    '[package]\nname = "bare"\nversion = "0.1.0"\nsource = "."\n',
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
  // Check mode must not rewrite drift; formatting fixes intact inputs without damaging rejected ones.
  const formatting = join(directory, 'formatting')
  yield* fs.makeDirectory(join(formatting, 'src'), { recursive: true })
  yield* fs.writeFileString(
    join(formatting, 'silk.toml'),
    '[package]\nname = "formatting"\nversion = "0.1.0"\nmain = "a.silk"\n',
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
    '[package]\nname = "shared"\nversion = "0.1.0"\nsource = "src"\nexports = ["numbers"]\n',
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
    '[package]\nname = "app"\nversion = "0.1.0"\n\n[dependencies]\nshared = { path = "../via/shared" }\n',
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
    const built = yield* invoke(
      silk,
      ['build', 'src/main.silk', '-o', join(throughLinks, output), '--stdlib', standardLibrary],
      join(throughLinks, 'app'),
      { ...process.env, SILK_CLANG: clang },
    )
    assert.equal(built.status, 0, built.stderr)
    const ran = yield* invoke(join(throughLinks, 'real', basename(output)), [], throughLinks)
    assert.equal(ran.status, 7, ran.stderr)
  }
  yield* fs.symlink('loop', join(throughLinks, 'loop'))
  const looped = yield* invoke(
    silk,
    [
      'build',
      'src/main.silk',
      '-o',
      join(throughLinks, 'loop/program'),
      '--stdlib',
      standardLibrary,
    ],
    join(throughLinks, 'app'),
    { ...process.env, SILK_CLANG: clang },
  )
  assert.equal(looped.status, 1, looped.stderr)
  assert.match(looped.stderr, /^silk: cannot create temporary directory: /m)
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
    '[package]\nname = "together"\nversion = "0.1.0"\n',
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
  const leftover = yield* fs.readDirectory(join(together, 'build/llvm', hostTarget, 'debug'))
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
  const libraryManifest = (inputs: string, artifact = 'object') =>
    `[package]\nname = "library"\nversion = "0.1.0"\nmain = "Main.silk"\nkind = "${artifact}"\n\n[native]\nlink = [${inputs}]\n`
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
  assert.equal(yield* fs.exists(join(library, 'silk.o.silk.bc')), false)
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
  for (const intermediate of ['libsilk.a.silk.o', 'libsilk.a.silk.bc'])
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
  // A debug build compiles each module's codegen unit to an object of its own, cached by its text,
  // so a rebuild after an edit to one module recompiles that module's unit alone.
  const split = join(directory, 'split')
  yield* fs.makeDirectory(join(split, 'src'), { recursive: true })
  yield* fs.writeFileString(
    join(split, 'silk.toml'),
    '[package]\nname = "split"\nversion = "0.1.0"\n',
  )
  const helperSource = (value: number) => `pub fn value() -> i32 {\n  return ${value}\n}\n`
  yield* fs.writeFileString(join(split, 'src/helper.silk'), helperSource(3))
  yield* fs.writeFileString(
    join(split, 'src/main.silk'),
    'import helper\n\npub fn main() -> i32 {\n  return helper.value() + 4\n}\n',
  )
  const splitEnvironment = { ...process.env, SILK_CLANG: clang }
  const unitObjects = join(split, `build/llvm/${hostTarget}/debug/split.units`)
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
  // The cache keeps each module's LLVM text as a file of its own beside the image, named by its
  // digest, so an unchanged rebuild finds every module's text where the last build left it.
  const packNames = Effect.fnUntraced(function* () {
    const cache = join(split, 'build/cache/split')
    const folders = (yield* fs.readDirectory(cache)).filter((name) => name.endsWith('.packs'))
    assert.equal(folders.length, 1, `expected one pack folder, found ${folders.join(', ')}`)
    return (yield* fs.readDirectory(join(cache, folders[0]))).sort()
  })
  const coldPacks = yield* packNames()
  assert.ok(coldPacks.length > 2, `expected a pack per module, found ${coldPacks.join(', ')}`)
  // A load reads an unchanged file's imports from the summaries the last load kept beside the
  // cache instead of parsing the file, so an unchanged rebuild leaves them as they were.
  const importSummaries = join(split, 'build/cache/split/imports')
  const summarizedAt = (yield* fs.stat(importSummaries)).mtime
  // An unchanged rebuild links nothing either: the executable stays the file the last link wrote.
  const splitExecutable = join(split, `build/llvm/${hostTarget}/debug/split`)
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
  // A rebuild replays the record the last build left in the cache: an edit to a body lowers only
  // the instances it touched, and an edit that changes what the program reaches walks it again
  // from the record, lowering only the bodies it touched and the ones they newly reach (here the
  // new helper, the body that calls it, and `main`, which resolved a name in the module that gained
  // a declaration). Either way the executable is the one a cold build links. A string constant
  // holding `@` names nothing, so the unit still declares the helper it calls.
  const executable = join(split, `build/llvm/${hostTarget}/debug/split`)
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
  yield* fs.writeFileString(join(logged, 'silk.toml'), '[package]\nname = "logged"\nversion = "0.1.0"\n')
  const loggedSource = (message: string) => 'import silk.effect { Effect }\nimport silk.logger { LogError }\n'
    + 'import silk.os_logger { StdoutLogger }\n\npub effect fn main() -> () ! LogError {\n  let mut logger = StdoutLogger.make()\n'
    + `  run Effect.log("${message}\\n", &()) |> Effect.provideMut(&mut logger)\n}\n`
  const loggedExecutable = join(logged, `build/llvm/${hostTarget}/debug/logged`)
  const loggedBuild = Effect.fnUntraced(function* (message: string) {
    const built = yield* invoke(silk, ['build', '--stdlib', standardLibrary, '--timings'], logged, splitEnvironment)
    assert.equal(built.status, 0, built.stderr)
    const ran = yield* invoke(loggedExecutable, [], logged, splitEnvironment)
    assert.equal(ran.stdout, `${message}\n`, ran.stderr)
    return built.stdout + built.stderr
  })
  yield* fs.writeFileString(join(logged, 'src/main.silk'), loggedSource('Hello, world!'))
  yield* loggedBuild('Hello, world!')
  yield* fs.writeFileString(join(logged, 'src/main.silk'), loggedSource('Hello, edit!'))
  const loweredLog = /^\s+codegen\s+([0-9,]+) functions/m.exec(yield* loggedBuild('Hello, edit!'))
  assert.ok(loweredLog !== null && Number(loweredLog[1].replace(/,/g, '')) < 50, `a message edit lowered ${loweredLog?.[1]} functions`)
  const warmLog = yield* fs.readFile(loggedExecutable)
  yield* fs.remove(join(logged, 'build'), { recursive: true })
  yield* loggedBuild('Hello, edit!')
  assert.deepEqual(yield* fs.readFile(loggedExecutable), warmLog, 'a rewalked build links the executable a cold build links')
  // A whole-module link keeps a stamp too, so an unchanged release rebuild links nothing.
  const releaseBuild = Effect.fnUntraced(function* () {
    const built = yield* invoke(silk, ['build', '--release', '--stdlib', standardLibrary], split, splitEnvironment)
    assert.equal(built.status, 0, built.stderr)
  })
  yield* releaseBuild()
  const releaseExecutable = join(split, `build/llvm/${hostTarget}/release/split`)
  const releasedAt = (yield* fs.stat(releaseExecutable)).mtime
  yield* releaseBuild()
  assert.deepEqual((yield* fs.stat(releaseExecutable)).mtime, releasedAt, 'an unchanged release rebuild leaves the executable as it was')
  // Workspace members share one output directory, and each keeps a cache of its own there, so
  // building one member never replaces the cache another member's next build reads.
  const pair = join(directory, 'pair')
  yield* fs.makeDirectory(pair, { recursive: true })
  yield* fs.writeFileString(join(pair, 'silk.toml'), '[workspace]\nmembers = ["first", "second"]\noutput-dir = "build"\n')
  const memberSource = (value: number) => `pub fn main() -> i32 {\n  return ${value}\n}\n`
  for (const member of ['first', 'second']) {
    yield* fs.makeDirectory(join(pair, member, 'src'), { recursive: true })
    yield* fs.writeFileString(join(pair, member, 'silk.toml'), `[package]\nname = "${member}"\nversion = "0.1.0"\n`)
    yield* fs.writeFileString(join(pair, member, 'src/main.silk'), memberSource(1))
  }
  const memberBuild = Effect.fnUntraced(function* (member: string) {
    const built = yield* invoke(silk, ['build', '--package', member, '--stdlib', standardLibrary], pair, splitEnvironment)
    assert.equal(built.status, 0, built.stderr)
  })
  const memberImage = Effect.fnUntraced(function* (member: string) {
    const names = (yield* fs.readDirectory(join(pair, 'build/cache', member))).filter((name) => /^semantic-[0-9a-f]{32}$/.test(name))
    assert.equal(names.length, 1, `expected one semantic cache for ${member}, found ${names.join(', ')}`)
    return join(pair, 'build/cache', member, names[0])
  })
  yield* memberBuild('first')
  const firstImage = yield* memberImage('first')
  const firstWritten = yield* fs.readFile(firstImage)
  yield* memberBuild('second')
  yield* fs.writeFileString(join(pair, 'second/src/main.silk'), memberSource(2))
  yield* memberBuild('second')
  assert.deepEqual(yield* fs.readFile(firstImage), firstWritten, "building another member leaves a member's cache as it was")
  assert.notEqual(yield* memberImage('second'), firstImage)
  // A check replays the escape walks the last check left in the cache. A callback's call into
  // another module of the package is walked below the callback, so an edit there that adds a `run`
  // is reported as a cold check reports it, and an edit that keeps what the walk reads reports
  // nothing.
  const escapes = join(directory, 'escapes')
  yield* fs.makeDirectory(join(escapes, 'src'), { recursive: true })
  yield* fs.writeFileString(
    join(escapes, 'silk.toml'),
    '[package]\nname = "escapes"\nversion = "0.1.0"\nmain = "main.silk"\n',
  )
  yield* fs.writeFileString(
    join(escapes, 'src/main.silk'),
    [
      'import helper',
      'import silk.allocator {Allocator, OutOfMemoryError}',
      'import silk.effect {Effect}',
      'import silk.result {Result}',
      'import silk.shared {Shared}',
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
  const escapeCheck = Effect.fnUntraced(function* (helper: string, expected: string) {
    yield* fs.writeFileString(join(escapes, 'src/helper.silk'), helper)
    const warm = yield* invoke(silk, ['check', '--stdlib', standardLibrary], escapes, splitEnvironment)
    yield* fs.remove(join(escapes, 'build'), { recursive: true })
    const cold = yield* invoke(silk, ['check', '--stdlib', standardLibrary], escapes, splitEnvironment)
    assert.equal(escapeReports(warm.stdout + warm.stderr), escapeReports(cold.stdout + cold.stderr), 'a warm check reports what a cold check reports')
    assert.equal(warm.status, cold.status, warm.stderr)
    assert.match(escapeReports(cold.stdout + cold.stderr), new RegExp(expected))
    // Leave a cache for the next edit.
    yield* invoke(silk, ['check', '--stdlib', standardLibrary], escapes, splitEnvironment)
  })
  const computing = (body: string) => `effect fn tick() -> () {\n  return ()\n}\n\npub fn compute() -> i32 {\n${body}}\n`
  yield* escapeCheck(computing('  return 1\n'), '^$')
  yield* escapeCheck(computing('  return 2\n'), '^$')
  yield* escapeCheck(computing('  run tick()\n  return 1\n'), 'helper\\.silk:6:3: error\\[OWN0016\\]')
  yield* escapeCheck(computing('  return 3\n'), '^$')
  yield* Console.log(
    'Native build CLI: exact LLVM output, Clang bypass, --clang, default linking/cleanup, selector validation, project run, clean, init, manifest flags, named profiles, profile input, bindings, source root, path dependencies, exports, workspaces, silk change release/history/recovery, retention, runtime requests, format reports, installed standard library, clang on PATH, version, help, check, project test, cached codegen units, build replay, check replay, object and static library artifacts and emission stages passed',
  )
})
const require = createRequire(new URL('../../package.json', import.meta.url))
const { NodeServices }: typeof import('@effect/platform-node') = await import(
  pathToFileURL(require.resolve('@effect/platform-node')).href
)
await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
