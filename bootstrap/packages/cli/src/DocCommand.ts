import * as Effect from 'effect/Effect'
import type * as FileSystem from 'effect/FileSystem'
import * as Option from 'effect/Option'
import type * as Path from 'effect/Path'
import { Command, Flag } from 'effect/unstable/cli'
import * as CommandExit from './CommandExit.js'
import * as DocumentationWorkflow from './DocumentationWorkflow.js'
import * as ProjectOptions from './ProjectOptions.js'

const output = Flag.String('output').pipe(
  Flag.withAlias('o'),
  Flag.withDescription('Destination JSON path, relative to the project directory.'),
  Flag.optional,
)

const includePrivate = Flag.Boolean('include-private').pipe(
  Flag.withDescription('Include private declarations and fields in generated documentation.'),
  Flag.withDefault(false),
)

export interface Options extends DocumentationWorkflow.Options {}

export const run = Effect.fn('DocCommand.run')(function* (
  options: Options = {},
): Effect.fn.Return<number, never, FileSystem.FileSystem | Path.Path> {
  return yield* DocumentationWorkflow.run(options)
})

export const command = Command.make(
  'doc',
  { manifestPath: ProjectOptions.manifestPath, output, includePrivate },
  Effect.fnUntraced(function* (config) {
    const status = yield* run({
      ...(Option.isNone(config.manifestPath) ? {} : { manifestPath: config.manifestPath.value }),
      ...(Option.isNone(config.output) ? {} : { output: config.output.value }),
      includePrivate: config.includePrivate,
    })
    yield* CommandExit.complete(status)
  }),
).pipe(Command.withDescription('Generate experimental formatter-neutral documentation JSON.'))
