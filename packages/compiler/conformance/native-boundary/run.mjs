import * as Layer from 'effect/Layer'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { NodeRuntime, NodeServices } from '@effect/platform-node'
import * as Data from 'effect/Data'
import * as Schema from 'effect/Schema'
import * as Config from 'effect/Config'
import * as Console from 'effect/Console'
import * as FileSystem from 'effect/FileSystem'
import * as Path from 'effect/Path'
import * as Stream from 'effect/Stream'
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Analysis from '../../dist/Analysis.js'
import * as CompilationProfile from '../../dist/CompilationProfile.js'
import * as NativeToolchain from '../../dist/NativeToolchain.js'
import * as SourceFile from '../../dist/SourceFile.js'
import * as SourceResolver from '../../dist/SourceResolver.js'

class ConformanceError extends Data.TaggedError('ConformanceError') {}
const Supplies = Schema.fromJsonString(
  Schema.Struct({
    silkCompilerTools: Schema.Struct({ clang: Schema.String, lld: Schema.String }),
    darwin: Schema.Struct({
      sdk: Schema.String,
      deploymentTarget: Schema.String,
      headers: Schema.Record(Schema.String, Schema.String),
    }),
    gnu: Schema.Struct({
      packages: Schema.Record(Schema.String, Schema.String),
      headers: Schema.Record(Schema.String, Schema.String),
    }),
  }),
)
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown, { space: 2 }))
const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const { dirname, join, resolve } = yield* Path.Path
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const directory = dirname(fileURLToPath(import.meta.url))
  const suppliesText = yield* fs.readFileString(
    join(
      directory,
      '../../../../openspec/changes/archive/2026-09-10-add-native-pointer-boundary/supplies.json',
    ),
  )
  const supplies = yield* Schema.decodeEffect(Supplies)(suppliesText)
  const argument = process.argv.slice(2)
  const requested =
    argument.length === 0
      ? ['aarch64-apple-darwin', 'aarch64-unknown-linux-gnu', 'x86_64-unknown-linux-gnu']
      : argument
  const lanes = new Map([
    ['aarch64-apple-darwin', { kind: 'darwin' }],
    ['aarch64-unknown-linux-gnu', { kind: 'gnu', architecture: 'arm64' }],
    ['x86_64-unknown-linux-gnu', { kind: 'gnu', architecture: 'amd64' }],
  ])
  if (
    requested.length === 0 ||
    new Set(requested).size !== requested.length ||
    requested.some((target) => !lanes.has(target))
  )
    throw new Error(
      'Supply distinct native target ids. LTO is unsupported; this lane accepts debug and optimized native objects only.',
    )
  const clang = yield* Config.String('SILK_BOUNDARY_CLANG').pipe(
    Config.withDefault('/opt/homebrew/opt/llvm/bin/clang'),
  )
  const darwinLinker = yield* Config.String('SILK_BOUNDARY_LD64').pipe(
    Config.withDefault('/opt/homebrew/bin/ld64.lld'),
  )
  const sdk = yield* Config.String('SILK_BOUNDARY_SDK').pipe(
    Config.withDefault('/Library/Developer/CommandLineTools/SDKs/MacOSX15.5.sdk'),
  )
  const output = resolve(
    yield* Config.String('SILK_BOUNDARY_OUTPUT').pipe(
      Config.withDefault(join(directory, '../../../../.scratch/native-boundary')),
    ),
  )
  yield* fs.makeDirectory(output, { recursive: true })
  const run = Effect.fnUntraced(
    /** @param {string} command @param {ReadonlyArray<string>} args */ function* (command, args) {
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const process = yield* spawner.spawn(
            ChildProcess.make(command, args, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }),
          )
          const [code, stdout, stderr] = yield* Effect.all(
            [
              process.exitCode,
              Stream.mkString(Stream.decodeText(process.stdout)),
              Stream.mkString(Stream.decodeText(process.stderr)),
            ],
            { concurrency: 'unbounded' },
          )
          if (code !== 0)
            return yield* new ConformanceError({
              message: `${command} exited ${code}: ${stdout}${stderr}`,
            })
          if (stderr.length > 0) yield* Console.error(stderr.trim())
          return stdout
        }),
      )
    },
  )
  const digest = Effect.fnUntraced(
    /** @param {Uint8Array} bytes */ function* (bytes) {
      return yield* Effect.try({
        try: () => createHash('sha256').update(bytes).digest('hex'),
        catch: (cause) => new ConformanceError({ message: 'Cannot hash conformance bytes', cause }),
      })
    },
  )
  const compilerVersion = yield* run(clang, ['--version'])
  if (!compilerVersion.includes(`clang version ${supplies.silkCompilerTools.clang}`))
    throw new Error(`Unpinned Silk object compiler: ${compilerVersion}`)
  const source = yield* fs.readFile(join(directory, 'boundary.silk'))
  const fixture = yield* fs.readFile(join(directory, 'boundary.c'))
  const report = {
    schema: 1,
    compilerVersion,
    source: yield* digest(source),
    fixture: yield* digest(fixture),
    lanes: [],
  }
  const lto = yield* Effect.exit(CompilationProfile.decode({ target: requested[0], lto: true }))
  if (!Exit.isFailure(lto)) throw new Error('Compilation profile silently accepted unsupported LTO')
  report.lto = { supported: false, rejectedByCompilationProfile: true }
  for (const target of requested) {
    const lane = lanes.get(target)
    const provenance = { target }
    let docker
    if (lane.kind === 'darwin') {
      for (const [path, expected] of Object.entries(supplies.darwin.headers)) {
        if ((yield* digest(yield* fs.readFile(join(sdk, path)))) !== expected)
          throw new Error(`Unpinned Darwin supply: ${path}`)
      }
      provenance.sdk = supplies.darwin.sdk
      provenance.linker = yield* run(darwinLinker, ['--version'])
      if (!provenance.linker.includes(`LLD ${supplies.silkCompilerTools.lld}`))
        throw new Error('Unpinned Darwin linker')
    } else {
      const image = `silk-jul123-conformance:${lane.architecture}`
      docker = Effect.fnUntraced(
        /** @param {ReadonlyArray<string>} args */ function* (args) {
          return yield* run('docker', [
            'run',
            '--rm',
            '--platform',
            `linux/${lane.architecture}`,
            '-v',
            `${output}:/boundary`,
            '-w',
            '/boundary',
            image,
            ...args,
          ])
        },
      )
      provenance.image = (yield* run('docker', [
        'image',
        'inspect',
        image,
        '--format',
        '{{.Id}}',
      ])).trim()
      for (const [name, expected] of Object.entries(supplies.gnu.packages)) {
        const actual = (yield* docker(['dpkg-query', '-W', '-f=${Version}', name])).trim()
        if (actual !== expected) throw new Error(`Unpinned GNU package ${name}: ${actual}`)
      }
      for (const [path, expected] of Object.entries(supplies.gnu.headers)) {
        if ((yield* docker(['sha256sum', path])).split(/\s/)[0] !== expected)
          throw new Error(`Unpinned GNU header: ${path}`)
      }
      provenance.cCompiler = yield* docker(['gcc', '--version'])
      provenance.linker = yield* docker(['ld', '--version'])
    }
    for (const mode of ['debug', 'release']) {
      const name = `${target}-${mode}`
      const laneOutput = join(output, name)
      yield* fs.makeDirectory(laneOutput, { recursive: true })
      const snapshot = yield* Analysis.makeRealized({
        root: 'conformance/boundary',
        configuration: {
          profile: {
            target,
            ...(lane.kind === 'darwin' ? { deployment: supplies.darwin.deploymentTarget } : {}),
            artifact: 'static-archive',
            entry: { kind: 'none' },
            optimization: mode === 'debug' ? 'none' : 'speed',
            debug: mode === 'debug',
          },
        },
      }).pipe(
        Effect.provide(
          SourceResolver.overlay([SourceFile.make('conformance/boundary', source)]).pipe(
            Layer.provideMerge(SourceResolver.empty),
          ),
        ),
      )
      const diagnostics = Analysis.diagnostics(snapshot)
      if (diagnostics.length !== 0)
        throw new Error(
          yield* encodeJson(
            diagnostics.map((d) => ({ code: d.code, message: d.message, span: d.span })),
          ),
        )
      const artifact = yield* Analysis.codegen(snapshot, { mode })
      if (!/\b(?:load|store)\b[^\n]*align 1\b/.test(artifact.ir))
        throw new Error('Unaligned accesses lost their explicit alignment')
      yield* fs.writeFile(join(laneOutput, 'silk.bc'), artifact.bitcode)
      yield* fs.writeFileString(join(laneOutput, 'silk.ll'), artifact.ir)
      yield* fs.writeFileString(
        join(laneOutput, 'runtime.c'),
        NativeToolchain.artifactRuntimeSource(
          'NativeStaticLibrary',
          artifact.termination,
          artifact.nativeRuntimeSymbols,
        ),
      )
      yield* fs.copyFile(join(directory, 'boundary.c'), join(laneOutput, 'boundary.c'))
      const optimization = mode === 'debug' ? '-O0' : '-O2'
      yield* run(clang, [
        '--no-default-config',
        `--target=${target}`,
        optimization,
        ...(lane.kind === 'darwin'
          ? ['-isysroot', sdk, `-mmacosx-version-min=${supplies.darwin.deploymentTarget}`]
          : []),
        '-c',
        join(laneOutput, 'silk.bc'),
        '-o',
        join(laneOutput, 'silk.o'),
      ])
      let executed
      let inspection
      if (lane.kind === 'darwin') {
        const args = [
          '--no-default-config',
          `--target=${target}`,
          '-isysroot',
          sdk,
          `-mmacosx-version-min=${supplies.darwin.deploymentTarget}`,
          optimization,
        ]
        yield* run(clang, [
          ...args,
          '-std=c11',
          '-Wall',
          '-Wextra',
          '-Werror',
          '-c',
          join(laneOutput, 'boundary.c'),
          '-o',
          join(laneOutput, 'boundary.o'),
        ])
        yield* run(clang, [
          ...args,
          '-c',
          join(laneOutput, 'runtime.c'),
          '-o',
          join(laneOutput, 'runtime.o'),
        ])
        yield* run(clang, [
          ...args,
          `-fuse-ld=${darwinLinker}`,
          join(laneOutput, 'boundary.o'),
          join(laneOutput, 'silk.o'),
          join(laneOutput, 'runtime.o'),
          '-lm',
          '-o',
          join(laneOutput, 'probe'),
        ])
        inspection = yield* run(join(dirname(clang), 'llvm-readobj'), [
          '--file-headers',
          '--symbols',
          '--relocations',
          join(laneOutput, 'silk.o'),
        ])
        executed = yield* run(join(laneOutput, 'probe'), [])
      } else {
        yield* docker([
          'gcc',
          optimization,
          '-std=c11',
          '-Wall',
          '-Wextra',
          '-Werror',
          '-c',
          `${name}/boundary.c`,
          '-o',
          `${name}/boundary.o`,
        ])
        yield* docker(['gcc', optimization, '-c', `${name}/runtime.c`, '-o', `${name}/runtime.o`])
        yield* docker([
          'gcc',
          `${name}/boundary.o`,
          `${name}/silk.o`,
          `${name}/runtime.o`,
          '-lm',
          '-o',
          `${name}/probe`,
        ])
        inspection = yield* docker(['readelf', '-h', '-s', '-r', `${name}/silk.o`])
        executed = yield* docker([`./${name}/probe`])
      }
      if (!executed.startsWith('native boundary passed:'))
        throw new Error(`Unexpected native result: ${executed}`)
      const architectures = new Map([
        ['aarch64-apple-darwin', /Format: Mach-O arm64[\s\S]*Arch: aarch64/],
        ['aarch64-unknown-linux-gnu', /Machine:\s+AArch64/],
        ['x86_64-unknown-linux-gnu', /Machine:\s+Advanced Micro Devices X86-64/],
      ])
      const architecture = architectures.get(target)
      if (architecture === undefined || !architecture.test(inspection))
        throw new Error(`Object architecture does not match ${target}`)
      yield* fs.writeFileString(join(laneOutput, 'object-inspection.txt'), inspection)
      const result = {
        ...provenance,
        mode,
        object: yield* digest(yield* fs.readFile(join(laneOutput, 'silk.o'))),
        output: executed.trim(),
      }
      report.lanes.push(result)
      yield* Console.log(`${target} ${mode}: ${executed}`)
      yield* fs.writeFileString(join(output, 'report.json'), (yield* encodeJson(report)) + '\n')
    }
  }
  if (report.lanes.length !== requested.length * 2)
    throw new Error('Conformance omitted a requested lane')
})
NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer)))
