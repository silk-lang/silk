import * as MirVerification from '../../dist/MirVerification.js'
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
  const target = yield* Config.String('SILK_SUPPLY_TARGET')
  const clang = yield* Config.String('SILK_SUPPLY_CLANG')
  const llvmAr = yield* Config.String('SILK_SUPPLY_AR')
  const linker = yield* Config.String('SILK_SUPPLY_LINKER')
  const inspect = yield* Config.String('SILK_SUPPLY_READOBJ')
  const root = yield* Config.String('SILK_SUPPLY_ROOT')
  const gcc = yield* Config.String('SILK_SUPPLY_GCC').pipe(Config.withDefault(''))
  const image = yield* Config.String('SILK_SUPPLY_IMAGE').pipe(Config.withDefault(''))
  const bootstrapFaults = yield* Config.Boolean('SILK_STARTUP_FAULTS').pipe(
    Config.withDefault(false),
  )
  const output = path.resolve(
    yield* Config.String('SILK_SUPPLY_OUTPUT').pipe(
      Config.withDefault(
        bootstrapFaults ? '.scratch/hosted-start-faults' : '.scratch/hosted-start',
      ),
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
        '../../../../openspec/changes/archive/2026-09-10-complete-native-runtime-migration',
        bootstrapFaults ? 'startup-supplies.json' : 'storage-supplies.json',
      ),
    ),
  )
  const headers = pins.headers[target]
  if (headers === undefined)
    return yield* new ConformanceError({ message: `Missing entry header pins: ${target}` })
  for (const [header, expected] of Object.entries(headers)) {
    const actual = PlatformSupplyResolver.digest(yield* fs.readFile(path.join(root, header)))
    if (actual !== expected)
      return yield* new ConformanceError({ message: `Unpinned entry header: ${header}` })
  }
  const runtimeSource = yield* fs.readFile(
    path.join(directory, '../../stdlib/silk/native_start.silk'),
  )
  const receiver =
    '#include <stddef.h>\n_Static_assert(sizeof(int) == 4, "C entry int");\nextern int main(int, char **);\nint captured_input(void) { return 42; }\nint (*const verified_entry)(int, char **) = &main;\n'
  const cases = (
    bootstrapFaults
      ? [
          {
            name: 'bootstrap-faults',
            text: yield* fs.readFileString(path.join(directory, 'bootstrap.silk')),
            receiver: yield* fs.readFileString(path.join(directory, 'bootstrap-receiver.c')),
            expected: 42,
          },
        ]
      : [
          { name: 'ordinary', text: 'pub fn main() -> i32 { return 42 }', expected: 42 },
          { name: 'unit', text: 'pub fn main() -> () {}', expected: 0 },
          {
            name: 'suspended',
            text: 'import silk.effect { Effect }\npub fn main() -> i32 { return run Effect.suspend(effect { return 42 }) }',
            expected: 42,
          },
          {
            name: 'host-input',
            text: 'import silk.host_input { HostInput, HostInputError }\nimport silk.effect { Effect }\npub effect fn main() -> () ! HostInputError ? &mut HostInput { let count = run HostInput.argumentCount() let resumed = run Effect.suspend(effect { return run HostInput.argumentCount() }) if count != 1 || resumed != count { let invalid = 1 / 0 } return () }',
            expected: 0,
          },
          {
            name: 'host-input-failure',
            text: 'import silk.host_input { HostInput, HostInputError }\nimport silk.effect { Effect }\neffect fn reading() -> usize ! HostInputError ? &mut HostInput { let count = run HostInput.argumentCount() fail HostInput.inputFailure() }\npub effect fn main() -> () ! HostInputError ? &mut HostInput { let count = run Effect.suspend(reading()) return () }',
            expected: 1,
            errorIdentity: 'silk/host_input.HostInputError',
            errorOrigin: 'entry-conformance/root.reading',
          },
          { name: 'effect-success', text: 'pub effect fn main() -> () {}', expected: 0 },
          {
            name: 'effect-captured',
            text: 'unsafe extern "C" fn captured_input() -> i32\npub fn main() -> Effect<\'static; ()> { let value = unsafe captured_input() return effect { if value != 42 { let invalid = 1 / 0 } return () } }',
            expected: 0,
          },
          {
            name: 'effect-failure',
            errorIdentity: 'entry-conformance/root.Problem',
            errorOrigin: 'entry-conformance/root.main',
            text: 'pub struct Problem {}\npub effect fn main() -> () ! Problem { fail Problem {} }',
            expected: 1,
          },
          {
            name: 'tap-failure',
            errorIdentity: 'entry-conformance/root.Problem',
            errorOrigin: 'entry-conformance/root.failing',
            text: 'import silk.effect { Effect }\npub struct Problem {}\neffect fn failing() -> i32 ! Problem { let resumed = run Effect.suspend(effect { return 42 }) fail Problem {} }\neffect fn forbidden(value: i32) -> i32 { return value / (value - value) }\npub effect fn main() -> () ! Problem { let value = run Effect.tap(failing(), forbidden) return () }',
            expected: 1,
          },
          {
            name: 'mapped-failure',
            errorIdentity: 'entry-conformance/root.Secondary',
            errorOrigin: 'silk/effect.raise',
            causeIdentity: 'entry-conformance/root.Primary',
            causeOrigin: 'entry-conformance/root.failing',
            text: 'import silk.effect { Effect }\npub struct Primary {}\npub struct Secondary { code: i32 }\nstruct Adjustment { offset: i32 }\neffect fn failing() -> i32 ! Primary { let resumed = run Effect.suspend(effect { return 42 }) fail Primary {} }\nfn mapped(error: Primary, adjustment: Adjustment) -> Secondary { return Secondary { code: adjustment.offset } }\nfn forbidden(value: i32) -> i32 { return value / (value - value) }\npub effect fn main() -> () ! Secondary { let value = run Effect.mapBoth(failing(), forbidden, mapped(Adjustment { offset: 42 })) return () }',
            expected: 1,
          },
          {
            name: 'finalized-failure',
            errorIdentity: 'entry-conformance/root.Problem',
            errorOrigin: 'entry-conformance/root.failing',
            forbidCause: true,
            receiver:
              receiver +
              '\nstatic int finalizations;\nvoid mark_finalizer(void) { ++finalizations; }\nvoid check_finalizer(void) { if (finalizations != 1) __builtin_trap(); }\n',
            text: `import silk.effect { Effect }
unsafe extern "C" fn mark_finalizer() -> ()
unsafe extern "C" fn check_finalizer() -> ()
pub struct Problem {}
impl Drop for Problem { fn drop(self: &mut Problem) -> () { unsafe check_finalizer() return () } }
struct Noise {}
effect fn failing() -> i32 ! Problem { run Effect.suspend(effect { return () }) fail Problem {} }
effect fn noise() -> () ! Noise { fail Noise {} }
effect fn ignoreNoise(error: Noise) -> () { return () }
effect fn finalize() -> () {
  run Effect.suspend(effect { return () })
  run Effect.catchAll(noise(), ignoreNoise)
  unsafe mark_finalizer()
  return ()
}
pub effect fn main() -> () ! Problem { let value = run Effect.ensuring(failing(), finalize()) return () }`,
            expected: 1,
          },
        ]
  ).map((fixture) => ({
    ...fixture,
    source: new TextEncoder().encode(fixture.text),
    receiver: 'receiver' in fixture ? fixture.receiver : receiver,
  }))
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
            root: 'entry-conformance/root',
            configuration: {
              profile: {
                ...input,
                artifact: 'object',
                entry: { kind: 'none' },
                runtime: { kind: 'named', name: 'source' },
              },
              composition: {
                runtimes: [{ name: 'source', module: 'silk/native_start' }],
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
              },
            },
          }).pipe(
            Effect.provide(
              SourceResolver.overlay([
                SourceFile.make('entry-conformance/root', fixture.source),
              ]).pipe(Layer.provideMerge(SourceResolver.empty)),
            ),
          )
          const diagnostics = Analysis.diagnostics(snapshot)
          if (diagnostics.length !== 0)
            return yield* new ConformanceError({
              message: diagnostics.map((value) => `${value.code}: ${value.message}`).join('\n'),
            })
          if (snapshot.mir._tag === 'Available') {
            const violations = yield* MirVerification.verify(snapshot.mir.value)
            if (violations.length > 0) {
              const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
                violations,
              )
              return yield* new ConformanceError({ message: `${fixture.name}: ${encoded}` })
            }
          }
          const artifact = yield* Analysis.codegen(snapshot, {
            mode: optimization === 'none' ? 'debug' : 'release',
          })
          if (
            artifact.nativeRuntimeSymbols.some(
              (symbol) => symbol !== 'malloc' && symbol !== 'calloc' && symbol !== 'free',
            ) ||
            /@silk_main[ (]/.test(artifact.ir)
          )
            return yield* new ConformanceError({
              message: `Source entry acquired a generated runtime dependency: ${artifact.nativeRuntimeSymbols.join(', ')}`,
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
            'independent C entry declaration',
          )
          const runtime = yield* NativeToolchain.compileRuntime(tools, scope, profile.target)
          const destination = path.join(output, `${target}-${optimization}-${fixture.name}`)
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
            !inspection.stdout.includes('main') ||
            !inspection.stdout.includes('free')
          )
            return yield* new ConformanceError({
              message: 'Object inspection did not verify architecture and entry relocation',
            })
          let execution
          if (target.includes('apple')) {
            const cwd = yield* fs.makeTempDirectoryScoped({ prefix: 'silk-entry-execution-' })
            execution = yield* run('/usr/bin/env', ['-C', cwd, destination], fixture.expected)
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
              fixture.expected,
            )
          }
          if (execution.stdout !== '')
            return yield* new ConformanceError({ message: `${fixture.name}: unexpected stdout` })
          if ('errorIdentity' in fixture) {
            const prefix = `unhandled error: ${fixture.errorIdentity}\n  at ${fixture.errorOrigin} `
            if (
              !execution.stderr.startsWith(prefix) ||
              execution.stderr.includes('[trace truncated]') ||
              execution.stderr.includes('$provided$') ||
              execution.stderr.includes('$effect$')
            )
              return yield* new ConformanceError({
                message: `${fixture.name}: terminal report lost primary identity or origin: ${execution.stderr}`,
              })
            if ('forbidCause' in fixture && execution.stderr.includes('while handling:'))
              return yield* new ConformanceError({
                message: `${fixture.name}: finalization introduced a selected cause: ${execution.stderr}`,
              })
            if (
              'causeIdentity' in fixture &&
              !execution.stderr.includes(
                `while handling: ${fixture.causeIdentity}\n  at ${fixture.causeOrigin} `,
              )
            )
              return yield* new ConformanceError({
                message: `${fixture.name}: mapped failure lost its selected cause: ${execution.stderr}`,
              })
          } else if (execution.stderr !== '') {
            return yield* new ConformanceError({
              message: `${fixture.name}: unexpected stderr: ${execution.stderr}`,
            })
          }
          return {
            fixture: fixture.name,
            runtime: PlatformSupplyResolver.digest(runtimeSource),
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
      yield* Console.log(`${target} ${optimization} ${fixture.name}: source entry passed`)
    }
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
