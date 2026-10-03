import * as Layer from 'effect/Layer'
import { fileURLToPath } from 'node:url'
import { NodeRuntime, NodeServices } from '@effect/platform-node'
import * as Effect from 'effect/Effect'
import * as Config from 'effect/Config'
import * as Data from 'effect/Data'
import * as FileSystem from 'effect/FileSystem'
import * as Path from 'effect/Path'
import * as Stream from 'effect/Stream'
import * as Console from 'effect/Console'
import * as Schema from 'effect/Schema'
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process'
import * as Analysis from '../../dist/Analysis.js'
import * as SourceFile from '../../dist/SourceFile.js'
import * as SourceResolver from '../../dist/SourceResolver.js'
import * as CompilationProfile from '../../dist/CompilationProfile.js'
import * as NativeToolchain from '../../dist/NativeToolchain.js'
import * as ObjectEmission from '../../dist/ObjectEmission.js'
import * as Linker from '../../dist/Linker.js'
import * as HelperCapability from '../../dist/HelperCapability.js'

class ConformanceError extends Data.TaggedError('ConformanceError') {}
const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown, { space: 2 }))
const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const directory = path.dirname(fileURLToPath(import.meta.url))
  const output = path.resolve(directory, '../../../../.scratch/raw-linux-conformance')
  yield* fs.makeDirectory(output, { recursive: true })
  const run = Effect.fnUntraced(
    /** @param {string} command
     * @param {ReadonlyArray<string>} args
     * @param {number} expected
     */ function* (command, args, expected = 0) {
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const child = yield* spawner.spawn(
            ChildProcess.make(command, args, {
              stdin: 'ignore',
              stdout: 'pipe',
              stderr: 'pipe',
            }),
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
              message: `${command}: expected ${expected}, got ${status}\n${stdout}${stderr}`,
            })
          return { command, args, status, stdout, stderr }
        }),
      )
    },
  )
  const selectedClang = yield* Config.String('SILK_SUPPLY_CLANG').pipe(
    Config.withDefault('/opt/homebrew/opt/llvm/bin/clang'),
  )
  const selectedTarget = yield* Config.String('SILK_SUPPLY_TARGET').pipe(Config.withDefault(''))
  const selectedImage = yield* Config.String('SILK_SUPPLY_IMAGE').pipe(Config.withDefault(''))
  const bin = path.dirname(selectedClang)
  const clang = selectedClang
  const llvmAr = yield* Config.String('SILK_SUPPLY_AR').pipe(
    Config.withDefault(path.join(bin, 'llvm-ar')),
  )
  const linker = yield* Config.String('SILK_SUPPLY_LINKER').pipe(
    Config.withDefault('/opt/homebrew/bin/ld.lld'),
  )
  const readelf = path.join(bin, 'llvm-readelf')
  const objdump = path.join(bin, 'llvm-objdump')
  const versions = []
  for (const tool of [clang, llvmAr, linker, readelf, objdump]) {
    const result = yield* run(tool, ['--version'])
    if (!(result.stdout + result.stderr).includes('22.1.8'))
      return yield* new ConformanceError({ message: `LLVM 22.1.8 required: ${tool}` })
    versions.push(result)
  }
  const source = yield* fs.readFile(path.join(directory, 'program.silk'))
  yield* fs.copyFile(path.join(directory, 'uapi.c'), path.join(output, 'uapi.c'))
  const report = { schema: 1, versions, lanes: [] }
  for (const [target, architecture, digest] of [
    [
      'x86_64-unknown-linux-gnu',
      'amd64',
      'sha256:cbe65a6ec0367389496f81bf0534a775801dfc6d8c04ac504e77f14a58f14d4f',
    ],
    [
      'aarch64-unknown-linux-gnu',
      'arm64',
      'sha256:7cdfd1b2fae658328ccd7edae730e5c9d6e250be2bdac94492305d3eed613fba',
    ],
  ].filter(([target]) => selectedTarget === '' || target === selectedTarget)) {
    const image = selectedImage || `silk-jul124-conformance:${architecture}`
    if (
      selectedImage === '' &&
      (yield* run('docker', ['image', 'inspect', image, '--format', '{{.Id}}'])).stdout.trim() !==
        digest
    )
      return yield* new ConformanceError({ message: `Unpinned image ${image}` })
    const docker = Effect.fnUntraced(
      /** @param {ReadonlyArray<string>} args
       * @param {number} expected
       */ function* (args, expected = 0) {
        return yield* run(
          'docker',
          [
            'run',
            '--rm',
            '--platform',
            `linux/${architecture}`,
            '-v',
            `${output}:/fixtures`,
            image,
            ...args,
          ],
          expected,
        )
      },
    )
    const headers = {
      '/usr/include/linux/auxvec.h':
        'e15aef0147da5423294434cac07f5994870b966b455dbb3f67ade45d4ef678e1',
      '/usr/include/linux/mman.h':
        'a9df78644c9398e535ff0c3233a858f2b0c95c3895ce2b981e792f338a2128fa',
      '/usr/include/asm-generic/mman-common.h':
        'bc57ba898adce4b1659d93715f4de1279ae3b82ffbefb04d0d3f565771dedd9a',
      [architecture === 'amd64'
        ? '/usr/include/x86_64-linux-gnu/asm/unistd_64.h'
        : '/usr/include/asm-generic/unistd.h']:
        architecture === 'amd64'
          ? '73cca9493303afdcdd6d0fa098ae925ecb3d0f2e531a3248b7c83dcac8ea4abb'
          : 'ff11274dc3d4c79f451bf8365a63ab881e639d153050939294cb9c195f78e30d',
    }
    for (const [header, hash] of Object.entries(headers)) {
      const actual = yield* docker(['sha256sum', header])
      if (actual.stdout.split(' ')[0] !== hash)
        return yield* new ConformanceError({ message: `Unpinned UAPI header: ${header}` })
    }
    const uapi = yield* docker([
      'gcc',
      '-std=c11',
      '-Werror',
      '-c',
      '/fixtures/uapi.c',
      '-o',
      `/fixtures/${architecture}-uapi.o`,
    ])
    for (const optimization of ['none', 'speed']) {
      const name = `${architecture}-${optimization}`
      const profileInput = {
        target,
        libc: 'none',
        link: 'static',
        relocation: 'static',
        artifact: 'executable',
        runtime: { kind: 'named', name: 'raw' },
        entry: { kind: 'named', name: '_start' },
        optimization,
        debug: optimization === 'none',
      }
      const analysis = yield* Analysis.makeRealized({
        root: 'raw/application',
        configuration: {
          profile: profileInput,
          composition: { runtimes: [{ name: 'raw', module: 'silk/raw_start' }], defaults: [] },
        },
      }).pipe(
        Effect.provide(
          SourceResolver.overlay([SourceFile.make('raw/application', source)]).pipe(
            Layer.provideMerge(SourceResolver.empty),
          ),
        ),
      )
      const diagnostics = Analysis.diagnostics(analysis)
      if (diagnostics.some((diagnostic) => diagnostic.severity === 'error'))
        return yield* new ConformanceError({ message: yield* encode(diagnostics) })
      const profile = yield* CompilationProfile.publish(
        yield* CompilationProfile.normalize(profileInput),
        [],
      )
      const artifact = yield* Analysis.codegen(analysis, {
        mode: optimization === 'none' ? 'debug' : 'release',
      })
      if (artifact.nativeRuntimeSymbols.length !== 0 || artifact.foreignImports.length !== 0)
        return yield* new ConformanceError({
          message: 'Raw source acquired a hidden runtime or foreign dependency',
        })
      const tools = yield* NativeToolchain.resolveToolchain(
        {
          _tag: 'Toolchain',
          clang,
          llvmAr,
          platform: { kind: 'explicit', target, root: '/', linker, origin: 'raw conformance' },
        },
        profile,
      )
      const lane = yield* NativeToolchain.withBuildScope(
        name,
        Effect.fnUntraced(function* (scope) {
          const object = yield* ObjectEmission.materialize({
            toolchain: tools,
            scope,
            artifact,
            profile,
          })
          const support = yield* NativeToolchain.compileHelpers(
            tools,
            scope,
            profile,
            object.helpers,
            {
              _tag: 'Disabled',
            },
          )
          const helperObjects = support === undefined ? [] : [support.object]
          const destination = path.join(output, name)
          const plan = yield* NativeToolchain.planNativeLink(
            tools,
            scope,
            'NativeExecutable',
            profile,
            [object.artifact, ...helperObjects.map((entry) => entry.artifact)],
            HelperCapability.linkInputs([object.helpers]),
            destination,
            analysis.artifactPlan.composition.loader,
            [object.helpers, ...helperObjects.map((entry) => entry.helpers)],
          )
          yield* Linker.link({
            scope,
            plan,
            artifactKind: 'NativeExecutable',
            destination,
            cache: { _tag: 'Disabled' },
          })
          yield* fs.copyFile(object.artifact.path, `${destination}.o`)
          yield* fs.writeFileString(`${destination}.ll`, artifact.ir)
          const elf = yield* run(readelf, ['-h', '-l', '-d', '-s', destination])
          const undefinedSymbols = yield* run(path.join(bin, 'llvm-nm'), [
            '--undefined-only',
            destination,
          ])
          if (
            !elf.stdout.includes('EXEC (Executable file)') ||
            /INTERP|NEEDED/.test(elf.stdout) ||
            undefinedSymbols.stdout.trim() !== ''
          )
            return yield* new ConformanceError({
              message: 'Raw ELF is not a closed static non-PIE executable',
            })
          const assembly = yield* run(objdump, ['-dr', `${destination}.o`])
          yield* fs.writeFileString(`${destination}.assembly.txt`, assembly.stdout)
          const executed = yield* docker([`/fixtures/${name}`, 'A'], 42)
          if (executed.stdout !== 'raw\n' || executed.stderr !== '')
            return yield* new ConformanceError({
              message: `Unexpected raw output: ${executed.stdout}${executed.stderr}`,
            })
          return {
            name,
            profile: profile.identity,
            plan: plan.identity,
            inputs: plan.inputs,
            helpers: object.helpers,
            elf,
            undefinedSymbols,
            executed,
            uapi,
            headers,
          }
        }),
      )
      report.lanes.push(lane)
      yield* Console.log(`${name}: raw entry, inputs, I/O, mapping and ELF closure passed`)
    }
  }
  if (report.lanes.length === 0)
    return yield* new ConformanceError({ message: 'No supported raw Linux target selected' })
  yield* fs.writeFileString(path.join(output, 'report.json'), yield* encode(report))
})
NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer)))
