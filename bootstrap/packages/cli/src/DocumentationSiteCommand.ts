import * as Json from '@silklang/docgen/Json'
import * as Model from '@silklang/docgen/Model'
import * as Site from '@silklang/docgen/Site'
import * as Console from 'effect/Console'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Option from 'effect/Option'
import * as Path from 'effect/Path'
import * as Result from 'effect/Result'
import { Command, Flag } from 'effect/unstable/cli'
import * as CommandExit from './CommandExit.js'

/** The `silk docs-site` command: one documentation JSON file in, one directory of HTML out. */

const input = Flag.String('input').pipe(
  Flag.withAlias('i'),
  Flag.withDescription('Documentation JSON written by `silk doc`.'),
)

const output = Flag.String('output').pipe(
  Flag.withAlias('o'),
  Flag.withDescription('Directory the site is written to.'),
)

const title = Flag.String('title').pipe(
  Flag.withDescription(`Site title. Defaults to "${Site.defaultTitle}".`),
  Flag.optional,
)

const snippetBundle = Flag.String('snippet-bundle').pipe(
  Flag.withDescription('Optional JavaScript bundle that registers the <silk-snippet> element.'),
  Flag.optional,
)

export interface Options {
  readonly input: string
  readonly output: string
  readonly title?: string
  readonly snippetBundle?: string
}

/** Returns the process exit status: 2 for an input or output that could not be used, 0 otherwise. */
export const run = Effect.fn('DocumentationSiteCommand.run')(function* (
  options: Options,
): Effect.fn.Return<number, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path

  const text = yield* Effect.result(fileSystem.readFileString(options.input))
  if (Result.isFailure(text)) {
    yield* Console.error(`Cannot read documentation JSON at ${options.input}`)
    return 2
  }
  const parsed = yield* Effect.result(Json.decode(text.success))
  if (Result.isFailure(parsed)) {
    yield* Console.error(`${options.input} does not hold valid JSON`)
    return 2
  }
  const decoded = Model.decode(parsed.success)
  if (decoded._tag === 'NotDocumentation') {
    yield* Console.error(`${options.input} is not documentation JSON: ${decoded.message}`)
    return 2
  }

  const bundle =
    options.snippetBundle === undefined
      ? undefined
      : yield* Effect.result(fileSystem.readFileString(options.snippetBundle))
  if (bundle !== undefined && Result.isFailure(bundle)) {
    yield* Console.error(`Cannot read snippet bundle at ${options.snippetBundle}`)
    return 2
  }

  const site = Site.render(decoded.documentation, {
    ...(options.title === undefined ? {} : { title: options.title }),
    ...(bundle === undefined ? {} : { snippetBundle: bundle.success }),
  })
  const written = yield* Effect.result(
    Effect.gen(function* () {
      yield* fileSystem.makeDirectory(options.output, { recursive: true })
      for (const file of site.files)
        yield* fileSystem.writeFileString(path.join(options.output, file.path), file.contents)
    }),
  )
  if (Result.isFailure(written)) {
    yield* Console.error(`Cannot write the site to ${options.output}`)
    return 2
  }
  yield* Console.log(
    `Documentation site: ${options.output} (${decoded.documentation.modules.length} modules, ${site.files.length} files)`,
  )
  return 0
})

export const command = Command.make(
  'docs-site',
  { input, output, title, snippetBundle },
  Effect.fnUntraced(function* (config) {
    const status = yield* run({
      input: config.input,
      output: config.output,
      ...(Option.isNone(config.title) ? {} : { title: config.title.value }),
      ...(Option.isNone(config.snippetBundle) ? {} : { snippetBundle: config.snippetBundle.value }),
    })
    yield* CommandExit.complete(status)
  }),
).pipe(
  Command.withDescription('Render a static HTML documentation site from `silk doc` JSON output.'),
)
