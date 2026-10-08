import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import { NodeRuntime, NodeServices } from '@effect/platform-node'
import * as Effect from 'effect/Effect'
import * as Config from 'effect/Config'
import * as Data from 'effect/Data'
import * as FileSystem from 'effect/FileSystem'
import * as Path from 'effect/Path'
import * as Stream from 'effect/Stream'
import * as Console from 'effect/Console'
import * as Result from 'effect/Result'
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process'
import * as CompilationProfile from '../../dist/CompilationProfile.js'
import * as NodeHeapObservation from '../../dist/NodeHeapObservation.js'
import * as Analysis from '../../dist/Analysis.js'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import * as PlatformSupplyResolver from '../../dist/PlatformSupplyResolver.js'
import * as NativeToolchain from '../../dist/NativeToolchain.js'
import * as ObjectEmission from '../../dist/ObjectEmission.js'
import * as Linker from '../../dist/Linker.js'
import * as SourceFile from '../../dist/SourceFile.js'
import * as SourceResolver from '../../dist/SourceResolver.js'

class ConformanceError extends Data.TaggedError('ConformanceError') {}
const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const target = yield* Config.String('SILK_SUPPLY_TARGET')
  const clang = yield* Config.String('SILK_SUPPLY_CLANG')
  const llvmAr = yield* Config.String('SILK_SUPPLY_AR')
  const linker = yield* Config.String('SILK_SUPPLY_LINKER')
  const inspect = yield* Config.String('SILK_SUPPLY_READOBJ')
  const root = yield* Config.String('SILK_SUPPLY_ROOT')
  const gcc = yield* Config.String('SILK_SUPPLY_GCC').pipe(Config.withDefault(''))
  const image = yield* Config.String('SILK_SUPPLY_IMAGE').pipe(Config.withDefault(''))
  const output = path.resolve(
    yield* Config.String('SILK_SUPPLY_OUTPUT').pipe(
      Config.withDefault('.scratch/integer-variadics'),
    ),
  )
  yield* fs.makeDirectory(output, { recursive: true })
  const run = Effect.fnUntraced(
    /**
     * @param {string} command
     * @param {ReadonlyArray<string>} args
     * @param {number} expected
     */ function* (command, args, expected = 0) {
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const child = yield* spawner.spawn(
            ChildProcess.make(command, args, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }),
          )
          const [status, stdout, stderr] = yield* Effect.all(
            [
              child.exitCode,
              Stream.mkString(Stream.decodeText(child.stdout)),
              Stream.mkString(Stream.decodeText(child.stderr)),
            ],
            { concurrency: 'unbounded' },
          )
          if (status !== expected)
            return yield* new ConformanceError({
              message: `${command}: expected ${expected}, received ${status}\n${stdout}${stderr}`,
            })
          return { command, arguments: args, status, stdout, stderr }
        }),
      )
    },
  )
  const versions = []
  for (const tool of [clang, llvmAr, linker, inspect]) {
    const result = yield* run(tool, ['--version'])
    if (!(result.stdout + result.stderr).includes('22.1.8'))
      return yield* new ConformanceError({ message: `Required LLVM 22.1.8 tool missing: ${tool}` })
    versions.push(result)
  }
  const invalidLto = yield* Effect.result(CompilationProfile.decode({ target, lto: true }))
  if (!Result.isFailure(invalidLto))
    return yield* new ConformanceError({ message: 'Unverified LTO was accepted' })
  const directory = path.dirname(fileURLToPath(import.meta.url))
  const pins = yield* Schema.decodeEffect(
    Schema.fromJsonString(
      Schema.Struct({
        variadicHeaders: Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.String)),
      }),
    ),
  )(
    yield* fs.readFileString(
      path.join(
        directory,
        '../../../../openspec/changes/archive/2026-09-10-implement-integer-c-variadics/supplies.json',
      ),
    ),
  )
  const headers = pins.variadicHeaders[target]
  if (headers === undefined)
    return yield* new ConformanceError({ message: `Missing header pins for ${target}` })
  for (const [header, expected] of Object.entries(headers)) {
    const bytes = yield* fs.readFile(path.join(root, header))
    const actual = yield* Effect.try({
      try: () => createHash('sha256').update(bytes).digest('hex'),
      catch: (cause) => new ConformanceError({ message: 'Header digest failed', cause }),
    })
    if (actual !== expected)
      return yield* new ConformanceError({ message: `Unpinned variadic header: ${header}` })
  }
  const source = yield* fs.readFile(path.join(directory, 'calls.silk'))
  const receiver = yield* fs.readFileString(path.join(directory, 'receiver.c'))
  const objdump = path.join(path.dirname(inspect), 'llvm-objdump')
  const report = { schema: 1, target, tools: versions, lto: 'rejected', headers, lanes: [] }
  for (const optimization of ['none', 'speed']) {
    const input = {
      target,
      optimization,
      debug: optimization === 'none',
      ...(target.includes('apple') ? { deployment: '11.0.0' } : {}),
    }
    const profile = yield* CompilationProfile.normalize(input)
    const tools = yield* NativeToolchain.resolveToolchain(
      {
        _tag: 'Toolchain',
        clang,
        llvmAr,
        platform: {
          kind: 'explicit',
          target: profile.target.id,
          root,
          linker,
          origin: 'required platform conformance',
          support:
            gcc === ''
              ? []
              : [{ root: gcc, target: profile.target.id, origin: 'pinned GCC12 compiler support' }],
        },
      },
      profile,
    )
    const lane = yield* NativeToolchain.withBuildScope(
      'platform-conformance',
      Effect.fnUntraced(function* (scope) {
        const snapshot = yield* Analysis.makeRealized({
          root: 'conformance/variadics',
          configuration: { profile: input },
        }).pipe(
          Effect.provide(
            SourceResolver.overlay([SourceFile.make('conformance/variadics', source)]).pipe(
              Layer.provideMerge(SourceResolver.empty),
            ),
          ),
        )
        if (Analysis.diagnostics(snapshot).length !== 0)
          return yield* new ConformanceError({
            message: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
              Analysis.diagnostics(snapshot),
            ).pipe(Effect.orDie),
          })
        const artifact = yield* Analysis.codegen(snapshot, {
          mode: optimization === 'none' ? 'debug' : 'release',
        })
        for (const [symbol, fixed] of [
          ['silk_test_varargs', 'i32'],
          ['open', 'ptr, i32'],
          ['openat', 'i32, ptr, i32'],
        ]) {
          if (
            !artifact.ir.includes(`declare i32 @${symbol}(${fixed}, ...)`) ||
            !artifact.ir.includes(`invoke i32 (${fixed}, ...) @${symbol}`)
          )
            return yield* new ConformanceError({
              message: `Missing true variadic declaration/invoke for ${symbol}`,
            })
          if (
            artifact.foreignImports.filter((entry) => entry.symbol === symbol && entry.variadic)
              .length !== 1
          )
            return yield* new ConformanceError({
              message: `Inconsistent declaration inventory for ${symbol}`,
            })
        }
        const object = yield* ObjectEmission.materialize({
          toolchain: tools,
          scope,
          artifact,
          profile,
        })
        const runtime = yield* NativeToolchain.compileRuntime(tools, scope, profile.target)
        const c = yield* NativeToolchain.compileCObject(
          tools,
          scope,
          profile.target,
          'receiver',
          receiver,
        )
        // Recompile the frozen preprocessed translation at the same optimization/debug boundary.
        const translationPath = path.join(scope.root, 'receiver.i')
        yield* fs.writeFileString(translationPath, c.artifact.translation.source)
        const cCompilation = yield* PlatformSupplyResolver.query(
          tools.supply.environment,
          tools.supply.compiler.command,
          [
            ...tools.supply.compilationArguments,
            '-x',
            'cpp-output',
            optimization === 'none' ? '-O0' : '-O2',
            ...(optimization === 'none' ? ['-g'] : []),
            '-c',
            translationPath,
            '-o',
            c.artifact.path,
          ],
          'independent C variadic receiver',
        )
        const destination = path.join(output, `${target}-${optimization}`)
        const plan = yield* NativeToolchain.planNativeLink(
          tools,
          scope,
          'NativeExecutable',
          profile,
          [object.artifact, runtime.artifact, c.artifact],
          [],
          destination,
          {
            request: { kind: 'default' },
            composition: { kind: 'default' },
            resolved: { kind: 'default' },
          },
        )
        yield* Linker.link({
          scope,
          plan,
          artifactKind: 'NativeExecutable',
          destination,
          cache: { _tag: 'Disabled' },
        })
        yield* fs.writeFileString(`${destination}.ll`, artifact.ir)
        yield* fs.copyFile(object.artifact.path, `${destination}.o`)
        const inspection = yield* run(inspect, [
          '--file-header',
          '--symbols',
          '--relocations',
          object.artifact.path,
        ])
        const assembly = yield* run(objdump, ['-dr', object.artifact.path])
        yield* fs.writeFileString(`${destination}.assembly.txt`, assembly.stdout)
        const expectedArchitecture = target.includes('x86_64') ? 'x86_64' : 'aarch64'
        if (
          !inspection.stdout.includes(`Arch: ${expectedArchitecture}`) ||
          !inspection.stdout.includes('silk_test_varargs')
        )
          return yield* new ConformanceError({
            message: 'Object inspection did not verify architecture and receiver relocation',
          })
        let execution
        if (target.includes('apple')) {
          const cwd = yield* fs.makeTempDirectoryScoped({ prefix: 'silk-variadic-execution-' })
          execution = yield* run('/usr/bin/env', ['-C', cwd, destination], 42)
        } else {
          if (image === '')
            return yield* new ConformanceError({ message: 'Required GNU execution image missing' })
          execution = yield* run(
            'docker',
            [
              'run',
              '--rm',
              '--platform',
              target.startsWith('aarch64') ? 'linux/arm64' : 'linux/amd64',
              '-v',
              `${output}:/fixture:ro`,
              '-w',
              '/tmp',
              image,
              `/fixture/${path.basename(destination)}`,
            ],
            42,
          )
        }
        return {
          optimization,
          profile: profile.identity,
          plan,
          cCompilation,
          inspection,
          assembly,
          execution,
        }
      }),
    )
    report.lanes.push(lane)
    yield* Console.log(
      `${target} ${optimization}: true variadic calls compiled, linked, inspected; va_arg and direct open/openat executed`,
    )
  }
  const reportPath = path.join(output, `${target}.json`)
  yield* fs.writeFileString(
    reportPath,
    (yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(report).pipe(Effect.orDie)) +
      '\n',
  )
  yield* Console.log(`Supply evidence: ${reportPath}`)
})
NodeRuntime.runMain(
  program.pipe(
    Effect.scoped,
    Effect.provide(Layer.mergeAll(NodeServices.layer, NodeHeapObservation.layer)),
  ),
)
