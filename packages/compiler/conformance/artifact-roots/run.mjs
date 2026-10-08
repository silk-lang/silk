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
        '../../../../openspec/changes/archive/2026-09-10-explicit-artifact-roots/supplies.json',
      ),
    ),
  )
  const output = resolve(directory, '../../../../.scratch/artifact-roots')
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
    ...Object.entries(supplies.darwin.headers).map(([header, digest]) => [
      join(sdk, header),
      digest,
    ]),
    ...Object.entries(supplies.darwin.cxxHeaders),
  ]) {
    if ((yield* hash(yield* fs.readFile(header))) !== digest)
      return yield* new ConformanceError({ message: `Unpinned Darwin header ${header}` })
  }
  if (!(yield* run(linker, ['--version'])).stdout.includes('LLD 22.1.8'))
    return yield* new ConformanceError({ message: 'LLD 22.1.8 is required' })
  const source = yield* fs.readFile(join(directory, 'application.silk'))
  const fixture = yield* fs.readFile(join(directory, 'consumer.c'))
  const report = {
    schema: 1,
    compiler: version,
    source: yield* hash(source),
    fixture: yield* hash(fixture),
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
      for (const [header, digest] of Object.entries(supplies.gnu.headers)) {
        if (!(yield* docker(['sha256sum', header])).stdout.startsWith(digest))
          return yield* new ConformanceError({ message: `Unpinned GNU header ${header}` })
      }
    }
    for (const mode of ['debug', 'release']) {
      for (const runtime of ['custom', 'none']) {
        const name = `${target}-${mode}-${runtime}`
        const lane = join(output, name)
        yield* fs.makeDirectory(lane, { recursive: true })
        const snapshots = []
        for (const form of ['object', 'static-archive', 'loadable-module']) {
          const snapshot = yield* Analysis.makeRealized({
            root: 'application',
            configuration: {
              profile: {
                target,
                artifact: form,
                runtime:
                  runtime === 'custom' ? { kind: 'named', name: 'selected' } : { kind: 'none' },
                entry: { kind: 'none' },
                optimization: mode === 'debug' ? 'none' : 'speed',
                debug: mode === 'debug',
                ...(architecture === undefined ? { deployment: '11.0.0' } : {}),
              },
              composition: {
                runtimes: [
                  { name: 'selected', module: 'runtime' },
                  { name: 'inactive', module: 'missing' },
                ],
                retention: [{ module: 'application', declaration: 'retained' }],
              },
            },
          }).pipe(
            Effect.provide(
              SourceResolver.overlay([
                SourceFile.make(
                  'application',
                  runtime === 'custom'
                    ? source
                    : new TextEncoder().encode(
                        new TextDecoder().decode(source) +
                          '\nexport "C" fn bridge() -> i32 as "answer" { return answer() }',
                      ),
                ),
              ]).pipe(
                Layer.provideMerge(
                  SourceResolver.memory(
                    new Map([
                      [
                        'runtime',
                        new TextEncoder().encode(
                          'import Intrinsic.application\nexport "C" fn answer() -> i32 { return application.answer() }',
                        ),
                      ],
                    ]),
                  ),
                ),
              ),
            ),
          )
          if (Analysis.diagnostics(snapshot).length > 0)
            return yield* new ConformanceError({
              message: yield* encode(Analysis.diagnostics(snapshot)),
            })
          snapshots.push(snapshot)
        }
        const snapshot = snapshots[0]
        if (snapshot === undefined)
          return yield* new ConformanceError({ message: 'Missing object analysis' })
        const artifact = yield* Analysis.codegen(snapshot, { mode })
        if (!artifact.ir.includes('@llvm.used') || artifact.ir.includes('unrelated'))
          return yield* new ConformanceError({ message: 'Incorrect retained roots' })
        yield* fs.writeFile(join(lane, 'silk.bc'), artifact.bitcode)
        yield* fs.writeFileString(join(lane, 'silk.ll'), artifact.ir)
        yield* fs.copyFile(join(directory, 'consumer.c'), join(lane, 'consumer.c'))
        yield* run(opt, ['-passes=verify', '-disable-output', join(lane, 'silk.bc')])
        const optimization = mode === 'debug' ? '-O0' : '-O2'
        yield* run(clang, [
          ...flags,
          optimization,
          '-fPIC',
          '-c',
          join(lane, 'silk.bc'),
          '-o',
          join(lane, 'silk.o'),
        ])
        const symbols = (yield* run(objdump, ['-ht', join(lane, 'silk.o')])).stdout
        if (
          !symbols.includes('retained') ||
          !symbols.includes('answer') ||
          symbols.includes('unrelated') ||
          symbols.includes('silk_main')
        )
          return yield* new ConformanceError({ message: `Incorrect object roots: ${name}` })
        yield* run('/opt/homebrew/opt/llvm/bin/llvm-ar', [
          'rcs',
          join(lane, 'libsilk.a'),
          join(lane, 'silk.o'),
        ])
        const archive = (yield* run('/opt/homebrew/opt/llvm/bin/llvm-nm', [
          join(lane, 'libsilk.a'),
        ])).stdout
        yield* fs.writeFileString(join(lane, 'objects.txt'), symbols + archive)
        if (architecture === undefined) {
          yield* run(clang, [
            ...flags,
            '-dynamiclib',
            join(lane, 'silk.o'),
            `--ld-path=${linker}`,
            '-o',
            join(lane, 'libsilk.dylib'),
          ])
          for (const library of ['libsilk.a', 'libsilk.dylib']) {
            yield* run(clang, [
              ...flags,
              '-Wall',
              '-Wextra',
              '-Werror',
              join(lane, 'consumer.c'),
              join(lane, library),
              `--ld-path=${linker}`,
              '-o',
              join(lane, 'consumer'),
            ])
            yield* run(join(lane, 'consumer'), [])
          }
        } else {
          const base = `/fixtures/${name}`
          yield* docker(['gcc', '-shared', `${base}/silk.o`, '-o', `${base}/libsilk.so`])
          for (const library of ['libsilk.a', 'libsilk.so']) {
            yield* docker([
              'gcc',
              '-Wall',
              '-Wextra',
              '-Werror',
              `${base}/consumer.c`,
              `${base}/${library}`,
              '-o',
              `${base}/consumer`,
            ])
            yield* docker([`${base}/consumer`])
          }
        }
        yield* fs.writeFileString(
          join(lane, 'plans.json'),
          yield* encode(snapshots.map((entry) => entry.artifactPlan)),
        )
        report.lanes.push({
          target,
          mode,
          runtime,
          object: yield* hash(yield* fs.readFile(join(lane, 'silk.o'))),
          forms: ['object', 'static-archive', 'loadable-module'],
          retained: true,
          archiveConsumer: 'passed',
          moduleConsumer: 'passed',
        })
        yield* Console.log(
          `${name}: object, archive, module, private retention and C consumers passed`,
        )
      }
    }
  }
  yield* fs.writeFileString(join(output, 'results.json'), yield* encode(report))
}).pipe(Effect.provide(NodeServices.layer))
NodeRuntime.runMain(program)
