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
  const output = path.resolve(
    yield* Config.String('SILK_SUPPLY_OUTPUT').pipe(Config.withDefault('.scratch/llvm-helpers')),
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
        helperHeaders: Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.String)),
      }),
    ),
  )(
    yield* fs.readFileString(
      path.join(
        directory,
        '../../../../openspec/changes/archive/2026-09-10-account-llvm-helper-capabilities/supplies.json',
      ),
    ),
  )
  const headers = pins.helperHeaders[target]
  if (headers === undefined)
    return yield* new ConformanceError({ message: `Missing helper header pins: ${target}` })
  for (const [header, expected] of Object.entries(headers)) {
    const actual = PlatformSupplyResolver.digest(yield* fs.readFile(path.join(root, header)))
    if (actual !== expected)
      return yield* new ConformanceError({ message: `Unpinned helper header: ${header}` })
  }
  const source = yield* fs.readFile(path.join(directory, 'legalization.ll'))
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
        const llvm = path.join(scope.root, 'legalization.ll')
        const bitcode = path.join(scope.root, 'legalization.bc')
        yield* fs.writeFile(llvm, source)
        yield* run(clang, [
          `--target=${target}`,
          '-c',
          '-emit-llvm',
          '-x',
          'ir',
          llvm,
          '-o',
          bitcode,
        ])
        // Synthetic compiler IR has no source foreign or runtime declarations.
        const artifact = {
          target: profile.target,
          bitcode: yield* fs.readFile(bitcode),
          foreignImports: [],
          foreignStatics: [],
          nativeRuntimeSymbols: [],
        }
        const object = yield* ObjectEmission.materialize({
          toolchain: tools,
          scope,
          artifact,
          profile,
        })
        const requested = object.helpers.requirements.map((entry) => entry.contract.symbol).sort()
        const expected = ['fmod', 'fmodf', 'memcmp', 'memcpy', 'memmove', 'memset']
        if (target.includes('apple')) expected.push('bzero')
        else if (optimization === 'speed') expected.push('bcmp')
        if (requested.join(',') !== expected.sort().join(','))
          return yield* new ConformanceError({
            message: `Unexpected legalization requirements: ${requested.join(',')}`,
          })
        // Hosted libc supplies every request, so no source helper object is realized.
        if (object.helpers.requirements.some((entry) => entry.provider.kind !== 'platform'))
          return yield* new ConformanceError({
            message: 'Hosted helper requests did not select the platform C library',
          })
        const hostedSupport = yield* NativeToolchain.compileHelpers(
          tools,
          scope,
          profile,
          object.helpers,
          { _tag: 'Disabled' },
        )
        if (hostedSupport !== undefined)
          return yield* new ConformanceError({
            message: 'A hosted build realized source memory helpers',
          })
        // The same memory requests without libc select the Silk source providers, which are
        // realized optimized for both program modes and must stay freestanding.
        if (object.inventory === undefined)
          return yield* new ConformanceError({ message: 'Missing legalization object inventory' })
        const freestanding = yield* CompilationProfile.normalize({
          ...input,
          libc: 'none',
          artifact: 'object',
          entry: { kind: 'none' },
          runtime: { kind: 'none' },
        })
        const memoryRequests = yield* HelperCapability.reconcile(
          {
            ...object.inventory,
            symbols: object.inventory.symbols.filter((entry) => {
              const symbol = HelperCapability.symbolName(profile.target, entry.name)
              return symbol !== 'fmod' && symbol !== 'fmodf'
            }),
          },
          artifact,
          freestanding,
          object.artifact.path,
          object.helpers.objectDigest,
        )
        const support = yield* NativeToolchain.compileHelpers(
          tools,
          scope,
          freestanding,
          memoryRequests,
          { _tag: 'Disabled' },
        )
        if (
          support === undefined ||
          memoryRequests.requirements.length !== expected.length - 2 ||
          memoryRequests.requirements.some((entry) => entry.provider.kind !== 'source') ||
          !support.object.planned.arguments.includes('-O2') ||
          support.object.helpers === undefined ||
          support.object.helpers.requirements.length !== 0 ||
          support.object.helpers.foreign.length !== 0 ||
          support.object.helpers.runtime.length !== 0
        )
          return yield* new ConformanceError({
            message: 'Source memory providers are not optimized and freestanding',
          })
        const helper = support.object
        const helperInspection = yield* run(inspect, [
          '--symbols',
          '--relocations',
          helper.artifact.path,
        ])
        yield* fs.copyFile(
          helper.artifact.path,
          path.join(output, `${target}-${optimization}-helper.o`),
        )
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
          'independent C helper receiver',
        )
        const destination = path.join(output, `${target}-${optimization}`)
        const sourceDestination = `${destination}-source-helpers`
        const linkExecutable = Effect.fnUntraced(
          function* (
            /** @type {ReadonlyArray<NativeToolchain.PathArtifact>} */ objects,
            /** @type {ReadonlyArray<HelperCapability.Report>} */ helpers,
            /** @type {string} */ executable,
          ) {
            const plan = yield* NativeToolchain.planNativeLink(
              tools,
              scope,
              'NativeExecutable',
              profile,
              [object.artifact, ...objects, c.artifact],
              HelperCapability.linkInputs([object.helpers]),
              executable,
              {
                request: { kind: 'default' },
                composition: { kind: 'default' },
                resolved: { kind: 'default' },
              },
              [object.helpers, ...helpers],
            )
            yield* Linker.link({
              scope,
              plan,
              artifactKind: 'NativeExecutable',
              destination: executable,
              cache: { _tag: 'Disabled' },
            })
            return plan
          },
        )
        const plan = yield* linkExecutable([], [], destination)
        // The receiver also drives the source providers: their object takes the helper symbols.
        const sourcePlan = yield* linkExecutable(
          [helper.artifact],
          [helper.helpers],
          sourceDestination,
        )
        yield* fs.writeFile(`${destination}.ll`, source)
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
          !inspection.stdout.includes('memcpy')
        )
          return yield* new ConformanceError({
            message: 'Object inspection did not verify architecture and helper relocation',
          })
        const execute = Effect.fnUntraced(function* (/** @type {string} */ executable) {
          if (target.includes('apple')) {
            const cwd = yield* fs.makeTempDirectoryScoped({ prefix: 'silk-helper-execution-' })
            return yield* run('/usr/bin/env', ['-C', cwd, executable], 42)
          }
          if (image === '')
            return yield* new ConformanceError({ message: 'Required GNU execution image missing' })
          return yield* run(
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
              `/fixture/${path.basename(executable)}`,
            ],
            42,
          )
        })
        const execution = yield* execute(destination)
        const sourceExecution = yield* execute(sourceDestination)
        return {
          optimization,
          profile: profile.identity,
          plan,
          sourcePlan,
          cCompilation,
          helperInspection,
          inspection,
          assembly,
          execution,
          sourceExecution,
        }
      }),
    )
    report.lanes.push(lane)
    yield* Console.log(
      `${target} ${optimization}: legalization requests accounted to libc; no-libc source providers optimized and audited; C ABI fixture executed against both`,
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
