import * as Layer from 'effect/Layer'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { NodeRuntime, NodeServices } from '@effect/platform-node'
import * as Effect from 'effect/Effect'
import * as Data from 'effect/Data'
import * as FileSystem from 'effect/FileSystem'
import * as Path from 'effect/Path'
import * as Stream from 'effect/Stream'
import * as Console from 'effect/Console'
import * as Schema from 'effect/Schema'
import * as Exit from 'effect/Exit'
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process'
import * as Analysis from '../../dist/Analysis.js'
import * as SourceFile from '../../dist/SourceFile.js'
import * as SourceResolver from '../../dist/SourceResolver.js'
import * as CompilationProfile from '../../dist/CompilationProfile.js'

class ConformanceError extends Data.TaggedError('ConformanceError') {}
const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown, { space: 2 }))
const Supplies = Schema.fromJsonString(
  Schema.Struct({
    darwin: Schema.Struct({
      headers: Schema.Record(Schema.String, Schema.String),
      cxxHeaders: Schema.Record(Schema.String, Schema.String),
    }),
    gnu: Schema.Struct({
      packages: Schema.Record(Schema.String, Schema.String),
      headers: Schema.Record(Schema.String, Schema.String),
    }),
  }),
)
const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const { dirname, join, resolve } = yield* Path.Path
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const directory = dirname(fileURLToPath(import.meta.url))
  const supplies = yield* Schema.decodeEffect(Supplies)(
    yield* fs.readFileString(
      join(
        directory,
        '../../../../openspec/changes/archive/2026-09-10-establish-foreign-call-contracts/supplies.json',
      ),
    ),
  )
  const callbackSupplies = yield* Schema.decodeEffect(
    Schema.fromJsonString(
      Schema.Struct({
        darwin: Schema.Struct({ headers: Schema.Record(Schema.String, Schema.String) }),
        gnu: Schema.Struct({ headers: Schema.Record(Schema.String, Schema.String) }),
      }),
    ),
  )(
    yield* fs.readFileString(
      join(
        directory,
        '../../../../openspec/changes/archive/2026-09-10-synchronous-native-callback-contracts/supplies.json',
      ),
    ),
  )
  const output = resolve(directory, '../../../../.scratch/foreign-contracts')
  yield* fs.makeDirectory(output, { recursive: true })
  const run = Effect.fnUntraced(function* (
    /** @type {string} */ command,
    /** @type {readonly string[]} */ args,
    expected = 0,
  ) {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const child = yield* spawner.spawn(
          ChildProcess.make(command, args, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }),
        )
        const [code, stdout, stderr] = yield* Effect.all(
          [
            child.exitCode,
            Stream.mkString(Stream.decodeText(child.stdout)),
            Stream.mkString(Stream.decodeText(child.stderr)),
          ],
          { concurrency: 'unbounded' },
        )
        if (expected !== undefined && code !== expected)
          return yield* new ConformanceError({
            message: `${command} exited ${code}: ${stdout}${stderr}`,
          })
        return { code, stdout, stderr }
      }),
    )
  })
  const hash = Effect.fnUntraced(function* (/** @type {string | Uint8Array} */ bytes) {
    return yield* Effect.try({
      try: () => createHash('sha256').update(bytes).digest('hex'),
      catch: (cause) => new ConformanceError({ message: 'Cannot hash fixture', cause }),
    })
  })
  const clang = '/opt/homebrew/opt/llvm/bin/clang'
  const opt = '/opt/homebrew/opt/llvm/bin/opt'
  const objdump = '/opt/homebrew/opt/llvm/bin/llvm-objdump'
  const sdk = '/Library/Developer/CommandLineTools/SDKs/MacOSX15.5.sdk'
  const linker = '/opt/homebrew/bin/ld64.lld'
  const version = (yield* run(clang, ['--version'])).stdout
  if (!version.includes('clang version 22.1.8'))
    return yield* new ConformanceError({ message: 'LLVM 22.1.8 is required' })
  for (const [header, digest] of [
    ...Object.entries({ ...supplies.darwin.headers, ...callbackSupplies.darwin.headers }).map(
      ([header, digest]) => [join(sdk, header), digest],
    ),
    ...Object.entries(supplies.darwin.cxxHeaders),
  ]) {
    if ((yield* hash(yield* fs.readFile(header))) !== digest)
      return yield* new ConformanceError({ message: `Unpinned Darwin header ${header}` })
  }
  if (!(yield* run(linker, ['--version'])).stdout.includes('LLD 22.1.8'))
    return yield* new ConformanceError({ message: 'LLD 22.1.8 is required' })
  const source = yield* fs.readFile(join(directory, 'contracts.silk'))
  const fixture = yield* fs.readFile(join(directory, 'contracts.cpp'))
  const report = {
    schema: 1,
    compiler: version,
    source: yield* hash(source),
    fixture: yield* hash(fixture),
    callbacks: yield* hash(yield* fs.readFile(join(directory, 'callbacks.c'))),
    lto: 'rejected',
    lanes: [],
  }
  if (
    !Exit.isFailure(
      yield* Effect.exit(CompilationProfile.decode({ target: 'aarch64-apple-darwin', lto: true })),
    )
  )
    return yield* new ConformanceError({ message: 'Unsupported LTO was accepted' })
  const requested = process.argv.slice(2)
  const lanes = [
    ['aarch64-apple-darwin', undefined, undefined],
    [
      'aarch64-unknown-linux-gnu',
      'arm64',
      'sha256:7cdfd1b2fae658328ccd7edae730e5c9d6e250be2bdac94492305d3eed613fba',
    ],
    [
      'x86_64-unknown-linux-gnu',
      'amd64',
      'sha256:cbe65a6ec0367389496f81bf0534a775801dfc6d8c04ac504e77f14a58f14d4f',
    ],
  ]
  if (requested.some((target) => !lanes.some(([id]) => id === target)))
    return yield* new ConformanceError({ message: 'Unknown native target' })
  for (const [target, architecture, imageId] of lanes) {
    if (requested.length > 0 && !requested.includes(target)) continue
    const image = `silk-jul124-conformance:${architecture}`
    if (
      architecture !== undefined &&
      (yield* run('docker', ['image', 'inspect', image, '--format', '{{.Id}}'])).stdout.trim() !==
        imageId
    )
      return yield* new ConformanceError({ message: `Unpinned image ${image}` })
    const flags = [
      '--no-default-config',
      `--target=${target}`,
      ...(architecture === undefined ? ['-isysroot', sdk, '-mmacosx-version-min=11.0.0'] : []),
    ]
    const docker = Effect.fnUntraced(function* (/** @type {readonly string[]} */ args) {
      return yield* run('docker', [
        'run',
        '--rm',
        '--platform',
        `linux/${architecture}`,
        '-v',
        `${output}:/fixtures`,
        image,
        ...args,
      ])
    })
    if (architecture !== undefined) {
      for (const [name, version] of Object.entries(supplies.gnu.packages)) {
        const actual = (yield* docker(['dpkg-query', '-W', '-f=${Version}', name])).stdout.trim()
        if (actual !== version)
          return yield* new ConformanceError({ message: `Unpinned GNU package ${name}: ${actual}` })
      }
      for (const [header, digest] of Object.entries({
        ...supplies.gnu.headers,
        ...callbackSupplies.gnu.headers,
      })) {
        if (!(yield* docker(['sha256sum', header])).stdout.startsWith(digest))
          return yield* new ConformanceError({ message: `Unpinned GNU header ${header}` })
      }
    }
    for (const mode of ['debug', 'release']) {
      const name = `${target}-${mode}`
      const lane = join(output, name)
      yield* fs.makeDirectory(lane, { recursive: true })
      const snapshot = yield* Analysis.makeRealized({
        root: 'conformance/contracts',
        configuration: {
          profile: {
            target,
            artifact: 'static-archive',
            entry: { kind: 'none' },
            optimization: mode === 'debug' ? 'none' : 'speed',
            debug: mode === 'debug',
            ...(architecture === undefined ? { deployment: '11.0.0' } : {}),
          },
        },
      }).pipe(
        Effect.provide(
          SourceResolver.overlay([SourceFile.make('conformance/contracts', source)]).pipe(
            Layer.provideMerge(SourceResolver.empty),
          ),
        ),
      )
      if (Analysis.diagnostics(snapshot).length > 0)
        return yield* new ConformanceError({
          message: yield* encode(Analysis.diagnostics(snapshot)),
        })
      const artifact = yield* Analysis.codegen(snapshot, { mode }).pipe(
        Effect.tapError((error) => Console.error(error.reason)),
      )
      yield* fs.writeFile(join(lane, 'silk.bc'), artifact.bitcode)
      yield* fs.writeFileString(join(lane, 'silk.ll'), artifact.ir)
      yield* fs.copyFile(join(directory, 'contracts.cpp'), join(lane, 'contracts.cpp'))
      yield* fs.copyFile(join(directory, 'callbacks.c'), join(lane, 'callbacks.c'))
      yield* run(opt, ['-passes=verify', '-disable-output', join(lane, 'silk.bc')])
      yield* run(opt, ['-passes=verify', '-disable-output', join(lane, 'silk.ll')])
      const optimization = mode === 'debug' ? '-O0' : '-O2'
      yield* run(clang, [
        ...flags,
        optimization,
        '-c',
        join(lane, 'silk.bc'),
        '-o',
        join(lane, 'silk.o'),
      ])
      const disassembly = (yield* run(objdump, ['-dr', join(lane, 'silk.o')])).stdout
      const sections = (yield* run(objdump, ['-ht', join(lane, 'silk.o')])).stdout
      if (
        !/eh_frame/.test(sections) ||
        !/__silk_foreign_guard/.test(disassembly) ||
        !/__silk_foreign_personality/.test(sections)
      )
        return yield* new ConformanceError({
          message: `Missing guard or unwind information: ${name}`,
        })
      yield* fs.writeFileString(join(lane, 'object.txt'), sections + disassembly)
      let success
      let indirectThrowing
      let throwing
      let stopped
      if (architecture === undefined) {
        yield* run(clang, [
          ...flags,
          optimization,
          '-std=c11',
          '-Wall',
          '-Wextra',
          '-Werror',
          '-pthread',
          '-c',
          join(lane, 'callbacks.c'),
          '-o',
          join(lane, 'callbacks.o'),
        ])
        yield* run(clang, [
          ...flags,
          optimization,
          '-std=c++17',
          '-Wall',
          '-Wextra',
          '-Werror',
          join(lane, 'contracts.cpp'),
          join(lane, 'silk.o'),
          join(lane, 'callbacks.o'),
          '-pthread',
          '-lc++',
          `--ld-path=${linker}`,
          '-o',
          join(lane, 'contracts'),
        ])
        success = yield* run(join(lane, 'contracts'), [])
        stopped = yield* run(join(lane, 'contracts'), ['stop', 'now'], 23)
        throwing = yield* run('/bin/sh', [
          '-c',
          '"$1" throw; code=$?; printf "exit=%s\\n" "$code"; test "$code" = 132 -o "$code" = 133',
          'fixture',
          join(lane, 'contracts'),
        ])
      } else {
        const base = `/fixtures/${name}`
        yield* docker([
          'gcc',
          optimization,
          '-std=c11',
          '-Wall',
          '-Wextra',
          '-Werror',
          '-pthread',
          '-c',
          `${base}/callbacks.c`,
          '-o',
          `${base}/callbacks.o`,
        ])
        yield* docker([
          'g++',
          optimization,
          '-std=c++17',
          '-Wall',
          '-Wextra',
          '-Werror',
          `${base}/contracts.cpp`,
          `${base}/silk.o`,
          `${base}/callbacks.o`,
          '-pthread',
          '-o',
          `${base}/contracts`,
        ])
        success = yield* docker([`${base}/contracts`])
        stopped = yield* docker([
          '/bin/sh',
          '-c',
          '"$1" stop now; test "$?" = 23',
          'fixture',
          `${base}/contracts`,
        ])
        throwing = yield* docker([
          '/bin/sh',
          '-c',
          '"$1" throw; code=$?; printf "exit=%s\\n" "$code"; test "$code" = 132 -o "$code" = 133',
          'fixture',
          `${base}/contracts`,
        ])
      }
      const indirectArgs = [
        '/bin/sh',
        '-c',
        '"$1" indirect; code=$?; printf "exit=%s\\n" "$code"; test "$code" = 132 -o "$code" = 133',
        'fixture',
        architecture === undefined ? join(lane, 'contracts') : `/fixtures/${name}/contracts`,
      ]
      indirectThrowing =
        architecture === undefined
          ? yield* run(indirectArgs[0], indirectArgs.slice(1))
          : yield* docker(indirectArgs)
      if (
        indirectThrowing.stdout.includes('escaped-to-catch') ||
        indirectThrowing.stdout.includes('unexpected-return')
      )
        return yield* new ConformanceError({ message: `Indirect foreign boundary failed: ${name}` })
      if (
        !success.stdout.includes(
          'contracts-ok callbacks-ok same-thread dynamic-extent nested-storage',
        ) ||
        throwing.stdout.includes('escaped-to-catch') ||
        throwing.stdout.includes('unexpected-return')
      )
        return yield* new ConformanceError({ message: `Foreign boundary failed: ${name}` })
      report.lanes.push({
        target,
        mode,
        image: imageId,
        success,
        throwing,
        indirectThrowing,
        stopped,
        bitcode: yield* hash(artifact.bitcode),
        object: yield* hash(yield* fs.readFile(join(lane, 'silk.o'))),
      })
      yield* Console.log(`${name}: contracts pass; foreign throw terminates before outer catch`)
    }
  }
  yield* fs.writeFileString(join(output, 'report.json'), `${yield* encode(report)}\n`)
})
NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer)))
