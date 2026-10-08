import * as Layer from 'effect/Layer'
import * as Exit from 'effect/Exit'
import * as CompilationProfile from '../../dist/CompilationProfile.js'
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
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process'
import * as Analysis from '../../dist/Analysis.js'
import * as SourceFile from '../../dist/SourceFile.js'
import * as SourceResolver from '../../dist/SourceResolver.js'

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
        '../../../../openspec/changes/archive/2026-09-10-native-assembly-entry-contracts/supplies.json',
      ),
    ),
  )
  const uapi = yield* Schema.decodeEffect(
    Schema.fromJsonString(
      Schema.Struct({
        x86_64: Schema.Record(Schema.String, Schema.String),
        aarch64: Schema.Record(Schema.String, Schema.String),
        shared: Schema.Record(Schema.String, Schema.String),
      }),
    ),
  )(
    yield* fs.readFileString(
      join(
        directory,
        '../../../../openspec/changes/archive/2026-09-10-native-assembly-entry-contracts/assembly-supplies.json',
      ),
    ),
  )
  const output = resolve(directory, '../../../../.scratch/native-assembly')
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
            message: `${command} ${args.join(' ')} exited ${code}: ${stdout}${stderr}`,
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
  const version = (yield* run(clang, ['--version'])).stdout
  if (!version.includes('clang version 22.1.8'))
    return yield* new ConformanceError({ message: 'LLVM 22.1.8 is required' })
  const report = { schema: 1, compiler: version, lto: 'rejected', lanes: [] }
  if (
    !Exit.isFailure(
      yield* Effect.exit(
        CompilationProfile.decode({ target: 'x86_64-unknown-linux-gnu', lto: true }),
      ),
    )
  )
    return yield* new ConformanceError({ message: 'Unsupported LTO was accepted' })
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
  ]) {
    const image = `silk-jul124-conformance:${architecture}`
    if (
      (yield* run('docker', ['image', 'inspect', image, '--format', '{{.Id}}'])).stdout.trim() !==
      digest
    )
      return yield* new ConformanceError({ message: `Unpinned ${image}` })
    const docker = Effect.fnUntraced(function* (
      /** @type {readonly string[]} */ args,
      expected = 0,
    ) {
      return yield* run(
        'docker',
        [
          'run',
          '--rm',
          '--ulimit',
          'core=0',
          '--platform',
          `linux/${architecture}`,
          '-v',
          `${output}:/fixtures`,
          image,
          ...args,
        ],
        expected,
      )
    })
    for (const [name, version] of Object.entries(supplies.gnu.packages)) {
      if ((yield* docker(['dpkg-query', '-W', '-f=${Version}', name])).stdout !== version)
        return yield* new ConformanceError({ message: `Unpinned package ${name}` })
    }
    for (const [header, expected] of Object.entries({
      ...supplies.gnu.headers,
      ...uapi.shared,
      ...(architecture === 'amd64' ? uapi.x86_64 : uapi.aarch64),
    })) {
      if ((yield* docker(['sha256sum', header])).stdout.split(' ')[0] !== expected)
        return yield* new ConformanceError({ message: `Unpinned header ${header}` })
    }
    const source = yield* fs.readFile(join(directory, `${architecture}.silk`))
    for (const mode of ['debug', 'release']) {
      const name = `${architecture}-${mode}`
      const lane = join(output, name)
      const mounted = `/fixtures/${name}`
      yield* fs.makeDirectory(lane, { recursive: true })
      const analysis = yield* Analysis.makeRealized({
        root: 'assembly',
        configuration: {
          profile: {
            target,
            artifact: 'object',
            runtime: { kind: 'none' },
            entry: { kind: 'none' },
            optimization: mode === 'debug' ? 'none' : 'speed',
            debug: mode === 'debug',
          },
        },
      }).pipe(
        Effect.provide(
          SourceResolver.overlay([SourceFile.make('assembly', source)]).pipe(
            Layer.provideMerge(SourceResolver.empty),
          ),
        ),
      )
      if (Analysis.diagnostics(analysis).length > 0)
        return yield* new ConformanceError({
          message: yield* encode(Analysis.diagnostics(analysis)),
        })
      const artifact = yield* Analysis.codegen(analysis, { mode })
      yield* fs.writeFile(join(lane, 'silk.bc'), artifact.bitcode)
      yield* fs.writeFileString(join(lane, 'silk.ll'), artifact.ir)
      yield* fs.copyFile(join(directory, 'consumer.c'), join(lane, 'consumer.c'))
      yield* fs.copyFile(join(directory, 'entry.c'), join(lane, 'entry.c'))
      yield* run(opt, ['-passes=verify', '-disable-output', join(lane, 'silk.bc')])
      yield* run(opt, ['-passes=verify', '-disable-output', join(lane, 'silk.ll')])
      yield* run(clang, [
        '--no-default-config',
        `--target=${target}`,
        mode === 'debug' ? '-O0' : '-O2',
        '-fPIC',
        '-c',
        join(lane, 'silk.bc'),
        '-o',
        join(lane, 'silk.o'),
      ])
      const disassembly = (yield* run(objdump, ['-d', '--no-show-raw-insn', join(lane, 'silk.o')]))
        .stdout
      yield* fs.writeFileString(join(lane, 'disassembly.txt'), disassembly)
      const entry = disassembly.split('<native_entry>:')[1]?.split(/\n\s*\n/)[0]
      const instructions = entry
        ?.split('\n')
        .filter((line) => /^\s*[0-9a-f]+:/.test(line))
        .map((line) => line.replace(/^\s*[0-9a-f]+:\s*/, ''))
      const expected =
        architecture === 'amd64'
          ? [/^movq?\s+%rsp, %rdi$/, /^callq?\s+/, /^ud2$/]
          : [/^mov\s+x0, sp$/, /^bl\s+/, /^brk\s+/]
      if (
        instructions === undefined ||
        expected.some((pattern, index) => !pattern.test(instructions[index] ?? '')) ||
        instructions.slice(3).some((line) => !/^(ud2|nop|nopl|nopw|brk)\b/.test(line))
      )
        return yield* new ConformanceError({
          message: `Unexpected naked entry instructions: ${instructions?.join('; ') ?? 'missing'}`,
        })
      yield* docker([
        'gcc',
        '-Wall',
        '-Wextra',
        '-Werror',
        `${mounted}/consumer.c`,
        `${mounted}/entry.c`,
        `${mounted}/silk.o`,
        '-o',
        `${mounted}/consumer`,
      ])
      yield* docker([`${mounted}/consumer`])
      yield* docker([`${mounted}/consumer`, 'trap'], 74)
      yield* docker([
        'gcc',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-nostartfiles',
        '-Wl,-e,native_entry',
        `${mounted}/entry.c`,
        `${mounted}/silk.o`,
        '-o',
        `${mounted}/entry`,
      ])
      yield* docker([`${mounted}/entry`], 23)
      report.lanes.push({
        target,
        mode,
        image: digest,
        source: yield* hash(source),
        object: yield* hash(yield* fs.readFile(join(lane, 'silk.o'))),
        arithmetic: 'passed',
        pointerMemory: 'passed',
        syscall: 'getpid compared with libc and UAPI number',
        terminalTrap: 'SIGILL/SIGTRAP handler exited 74',
        processEntry: 23,
        nakedInstructions: instructions,
      })
      yield* Console.log(`passed ${name}`)
    }
  }
  yield* fs.writeFileString(join(output, 'results.json'), yield* encode(report))
})
NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer)))
