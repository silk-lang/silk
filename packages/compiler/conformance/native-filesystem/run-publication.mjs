// Native-compiler consumer route: no bootstrap dist, frozen standard library, or pinned sysroot.
import * as Config from 'effect/Config'
import * as Console from 'effect/Console'
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Path from 'effect/Path'
import * as Stream from 'effect/Stream'
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process'
import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { fileURLToPath } from 'node:url'

class PublicationConformanceError extends Data.TaggedError('PublicationConformanceError') {}

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const compiler = yield* Config.String('SILK_COMPILER')
  const clang = yield* Config.String('SILK_CLANG').pipe(Config.withDefault('clang'))
  const directory = path.dirname(fileURLToPath(import.meta.url))
  const repository = path.resolve(directory, '../../../..')
  const output = path.resolve(
    repository,
    yield* Config.String('SILK_PUBLICATION_OUTPUT').pipe(
      Config.withDefault('.scratch/native-filesystem-publication'),
    ),
  )
  const standardLibrary = path.join(repository, 'packages/compiler/stdlib')
  yield* fs.makeDirectory(output, { recursive: true })
  yield* fs.writeFileString(
    path.join(output, 'silk.toml'),
    '[package]\nname = "native-publication-conformance"\nversion = "0.1.0"\nroot = "publication-fixture.silk"\n\n[build]\nartifact = "object"\n',
  )
  yield* fs.copyFile(
    path.join(directory, 'publication-fixture.silk'),
    path.join(output, 'publication-fixture.silk'),
  )
  const run = Effect.fnUntraced(function* (command, args) {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const child = yield* spawner.spawn(
          ChildProcess.make(command, args, {
            cwd: output,
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
        if (status !== 0)
          return yield* new PublicationConformanceError({
            message: `${command} ${args.join(' ')}: status ${status}\n${stdout}${stderr}`,
          })
        if (stdout !== '') yield* Console.log(stdout.trimEnd())
        if (stderr !== '') yield* Console.error(stderr.trimEnd())
        return { command, arguments: args, status, stdout, stderr }
      }),
    )
  })
  if (process.platform !== 'darwin' && process.platform !== 'linux')
    return yield* new PublicationConformanceError({
      message: `Unsupported host: ${process.platform}`,
    })
  const platformArguments =
    process.platform === 'darwin'
      ? ['-isysroot', (yield* run('xcrun', ['--show-sdk-path'])).stdout.trim()]
      : []
  const lanes = []
  for (const optimization of ['none', 'speed']) {
    const prefix = path.join(output, optimization)
    const flag = optimization === 'none' ? '-O0' : '-O2'
    const compile = yield* run(compiler, [
      'build',
      path.join(output, 'publication-fixture.silk'),
      '-o',
      `${prefix}.ll`,
      '--emit',
      'llvm-ir',
      '--stdlib',
      standardLibrary,
      '--optimization',
      optimization,
    ])
    const silkObject = yield* run(clang, [
      ...platformArguments,
      '-Wno-override-module',
      flag,
      '-c',
      `${prefix}.ll`,
      '-o',
      `${prefix}-silk.o`,
    ])
    const cObject = yield* run(clang, [
      ...platformArguments,
      '-std=c11',
      '-Wall',
      '-Wextra',
      '-Werror',
      flag,
      '-c',
      path.join(directory, 'publication-receiver.c'),
      '-o',
      `${prefix}-receiver.o`,
    ])
    const link = yield* run(clang, [
      ...platformArguments,
      `${prefix}-silk.o`,
      `${prefix}-receiver.o`,
      ...(process.platform === 'linux' ? ['-ldl'] : []),
      '-o',
      prefix,
    ])
    const execute = yield* run(prefix, [])
    lanes.push({ optimization, compile, silkObject, cObject, link, execute })
    yield* Console.log(
      `native filesystem publication ${process.platform}/${process.arch} ${optimization}: passed`,
    )
  }
  yield* fs.writeFileString(
    path.join(output, 'publication-evidence.json'),
    JSON.stringify(
      {
        schema: 1,
        compiler,
        standardLibrary,
        host: `${process.platform}/${process.arch}`,
        lanes,
        durabilityLimit:
          'Real fsync calls and ordering; not hardware-cache flush or physical power-loss recovery.',
      },
      null,
      2,
    ) + '\n',
  )
})

NodeRuntime.runMain(program.pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
