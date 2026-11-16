// Build tooling creates explicit requests. Source-file commands deliberately have no package context.
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as NativeProcess from './NativeProcess.ts'

export class CompilationBuildError extends Data.TaggedError('CompilationBuildError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

export interface Options {
  readonly compiler: string
  readonly manifest: string
  readonly output: string
  readonly stdlib: string
  readonly target?: string
  readonly optimization: string
  readonly debug: boolean
  readonly emit: string
}

/** Writes the definition beside its artifact and returns the two compiler invocations. */
export const prepare = Effect.fn('CompilationBuild.prepare')(function* (options: Options) {
  const fs = yield* FileSystem.FileSystem
  const definition = `${options.output}.definition.toml`
  const request = `${options.output}.request.toml`
  const quote = JSON.stringify
  const text = [
    `manifest = ${quote(options.manifest)}`,
    'artifact = "executable"',
    `stdlib = ${quote(options.stdlib)}`,
    '[settings]',
    'modules = []',
    `emit = ${quote(options.emit)}`,
    '[settings.profile]',
    `optimization = ${quote(options.optimization)}`,
    `debug = ${options.debug}`,
    ...(options.target === undefined ? [] : [`target = ${quote(options.target)}`]),
    '[settings.native]',
    'sources = []',
    'link = []',
    '',
  ].join('\n')
  yield* fs.writeFileString(definition, text, { flag: 'wx' })
  return [
    ['resolve', '--definition', definition, '--output', request, '--artifact', options.output],
    ['compile', '--request', request],
  ]
})

/** Resolves the definition and compiles its request with inherited process output. */
export const build = Effect.fn('CompilationBuild.build')(function* (options: Options) {
  const commands = yield* prepare(options)
  for (const args of commands) {
    const result = yield* NativeProcess.execute(options.compiler, args, {
      cwd: dirname(options.manifest), stdio: 'inherit',
    })
    if (result.status !== 0 || result.signal !== null)
      return yield* new CompilationBuildError({ message: `${args[0]} failed (${result.signal ?? result.status})` })
  }
})

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const cli = Effect.gen(function* () {
    const { values } = yield* Effect.try({
      try: () => parseArgs({ options: {
        compiler: { type: 'string' }, manifest: { type: 'string' }, output: { type: 'string' },
        stdlib: { type: 'string' }, target: { type: 'string' }, optimization: { type: 'string', default: 'none' },
        debug: { type: 'string', default: 'true' }, emit: { type: 'string', default: 'final' },
      } }),
      catch: (cause) => new CompilationBuildError({ message: 'invalid compilation build arguments', cause }),
    })
    if (!values.compiler || !values.manifest || !values.output || !values.stdlib || !['true', 'false'].includes(values.debug))
      return yield* new CompilationBuildError({ message: '--compiler, --manifest, --output and --stdlib are required; --debug accepts true or false' })
    yield* build({ compiler: resolve(values.compiler), manifest: resolve(values.manifest),
      output: resolve(values.output), stdlib: resolve(values.stdlib), target: values.target,
      optimization: values.optimization, debug: values.debug === 'true', emit: values.emit })
  })
  const require = createRequire(new URL('../../package.json', import.meta.url))
  const { NodeServices }: typeof import('@effect/platform-node') = await import(pathToFileURL(require.resolve('@effect/platform-node')).href)
  await Effect.runPromise(cli.pipe(Effect.provide(NodeServices.layer), Effect.catch((error) => Effect.sync(() => {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  }))))
}
