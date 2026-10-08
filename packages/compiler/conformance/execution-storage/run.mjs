import * as LifecycleFixture from './LifecycleFixture.mjs'
import * as Analysis from '../../dist/Analysis.js'
import * as SourceFile from '../../dist/SourceFile.js'
import * as SourceResolver from '../../dist/SourceResolver.js'
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
import * as HelperCapability from '../../dist/HelperCapability.js'
import { fileURLToPath } from 'node:url'
import * as PlatformSupplyResolver from '../../dist/PlatformSupplyResolver.js'
import * as NativeToolchain from '../../dist/NativeToolchain.js'
import * as ObjectEmission from '../../dist/ObjectEmission.js'
import * as Linker from '../../dist/Linker.js'

class ConformanceError extends Data.TaggedError('ConformanceError') {}
const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const faults = yield* Config.Boolean('SILK_STORAGE_FAULTS').pipe(Config.withDefault(false))
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
      Config.withDefault('.scratch/execution-storage'),
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
        headers: Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.String)),
      }),
    ),
  )(
    yield* fs.readFileString(
      path.join(
        directory,
        '../../../../openspec/changes/archive/2026-09-10-complete-native-runtime-migration/storage-supplies.json',
      ),
    ),
  )
  const headers = pins.headers[target]
  if (headers === undefined)
    return yield* new ConformanceError({ message: `Missing storage header pins: ${target}` })
  for (const [header, expected] of Object.entries(headers)) {
    const actual = PlatformSupplyResolver.digest(yield* fs.readFile(path.join(root, header)))
    if (actual !== expected)
      return yield* new ConformanceError({ message: `Unpinned storage header: ${header}` })
  }
  const source = yield* fs.readFile(path.join(directory, 'fixture.silk'))
  const receiver =
    (yield* fs.readFileString(path.join(directory, 'layout.c'))) +
    '\n' +
    (yield* fs.readFileString(path.join(directory, faults ? 'fault-receiver.c' : 'receiver.c')))
  const cases = [{ name: 'abi', source, receiver }]
  if (!faults) {
    for (const [name, expected] of [
      ['latched-destroy', 42],
      ['finalized-destroy', 42],
      ['multiple-packages', 42],
      ['suspended-failure', 42],
      ['non-lifo', 240],
    ]) {
      const fixture = yield* fs.readFileString(
        path.join(directory, `${name === 'suspended-failure' ? 'multiple-packages' : name}.silk`),
      )
      const exported = yield* LifecycleFixture.expose(fixture, {
        failure: name === 'suspended-failure',
        reentrant: name !== 'non-lifo',
      })
      cases.push({
        name,
        source: new TextEncoder().encode(exported),
        receiver:
          name !== 'non-lifo'
            ? (yield* fs.readFileString(path.join(directory, 'layout.c'))) +
              '\n' +
              (yield* fs.readFileString(path.join(directory, 'reentrant-receiver.c')))
            : `extern int storage_lifecycle(void);
int main(void) { return storage_lifecycle() == ${expected} ? 42 : 1; }
`,
      })
    }
  }
  const objdump = path.join(path.dirname(inspect), 'llvm-objdump')
  const report = { schema: 1, target, tools: versions, lto: 'rejected', headers, lanes: [] }
  for (const optimization of ['none', 'speed']) {
    const input = {
      target,
      optimization,
      debug: optimization === 'none',
      ...(target.includes('apple') ? { deployment: '11.0.0' } : {}),
    }
    const profile = yield* CompilationProfile.publish(
      yield* CompilationProfile.normalize(input),
      [],
    )
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
    for (const fixture of cases) {
      const lane = yield* NativeToolchain.withBuildScope(
        'platform-conformance',
        Effect.fnUntraced(function* (scope) {
          const snapshot = yield* Analysis.makeRealized({
            root: 'storage-conformance/root',
            configuration: {
              profile: { ...input, artifact: 'object', entry: { kind: 'none' } },
              composition: {
                components: [
                  {
                    capability: 'execution-storage',
                    bindings: ['create', 'acquire', 'release', 'destroy'].map((operation) => ({
                      operation,
                      module: 'silk/execution_storage',
                      declaration: 'silk_execution_storage_' + operation,
                    })),
                  },
                ],
                retention: ['create', 'acquire', 'release', 'destroy'].map((operation) => ({
                  module: 'silk/execution_storage',
                  declaration: 'silk_execution_storage_' + operation,
                })),
              },
            },
          }).pipe(
            Effect.provide(
              SourceResolver.overlay([
                SourceFile.make('storage-conformance/root', fixture.source),
              ]).pipe(Layer.provideMerge(SourceResolver.empty)),
            ),
          )
          const diagnostics = Analysis.diagnostics(snapshot)
          if (diagnostics.length !== 0)
            return yield* new ConformanceError({
              message: diagnostics.map((value) => `${value.code}: ${value.message}`).join('\n'),
            })
          const artifact = yield* Analysis.codegen(snapshot, {
            mode: optimization === 'none' ? 'debug' : 'release',
          })
          if (
            artifact.nativeRuntimeSymbols.some((symbol) =>
              symbol.startsWith('silk_coroutine_frame_'),
            ) ||
            /silk_coroutine_frame_(push|pop)_v1/.test(artifact.ir)
          )
            return yield* new ConformanceError({
              message: 'Source provider acquired the obsolete frame bridge',
            })
          const object = yield* ObjectEmission.materialize({
            toolchain: tools,
            scope,
            artifact,
            profile,
          })
          const c = yield* NativeToolchain.compileCObject(
            tools,
            scope,
            profile.target,
            'receiver',
            fixture.receiver,
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
            'independent C storage receiver',
          )
          const runtime = yield* NativeToolchain.compileRuntime(tools, scope, profile.target)
          const destination = path.join(
            output,
            `${target}-${optimization}-${fixture.name}${faults ? '-faults' : ''}`,
          )
          const plan = yield* NativeToolchain.planNativeLink(
            tools,
            scope,
            'NativeExecutable',
            profile,
            [object.artifact, c.artifact, runtime.artifact],
            HelperCapability.linkInputs([object.helpers]),
            destination,
            {
              request: { kind: 'default' },
              composition: { kind: 'default' },
              resolved: { kind: 'default' },
            },
            [object.helpers],
          )
          yield* Linker.link({
            scope,
            plan,
            artifactKind: 'NativeExecutable',
            destination,
            cache: { _tag: 'Disabled' },
          })
          yield* fs.writeFile(`${destination}.silk`, fixture.source)
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
            !inspection.stdout.includes('malloc') ||
            !inspection.stdout.includes('free')
          )
            return yield* new ConformanceError({
              message: 'Object inspection did not verify architecture and storage relocation',
            })
          let execution
          if (target.includes('apple')) {
            const cwd = yield* fs.makeTempDirectoryScoped({ prefix: 'silk-storage-execution-' })
            execution = yield* run('/usr/bin/env', ['-C', cwd, destination], 42)
          } else {
            if (image === '')
              return yield* new ConformanceError({
                message: 'Required GNU execution image missing',
              })
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
            fixture: fixture.name,
            source: PlatformSupplyResolver.digest(fixture.source),
            artifact: snapshot.artifactPlan?.identity,
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
      yield* Console.log(`${target} ${optimization} ${fixture.name}: source storage passed`)
    }
  }
  const reportPath = path.join(output, `${target}${faults ? '-faults' : ''}.json`)
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
