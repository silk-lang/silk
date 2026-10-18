import * as Doctest from '@silklang/docgen/Doctest'
import * as Example from '@silklang/docgen/Example'
import * as Json from '@silklang/docgen/Json'
import * as Report from '@silklang/docgen/Report'
import * as Sources from '@silklang/docgen/Sources'
import * as Stdlib from '@silklang/docgen/Stdlib'
import * as Console from 'effect/Console'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Option from 'effect/Option'
import * as Path from 'effect/Path'
import * as Result from 'effect/Result'
import { Command, Flag } from 'effect/unstable/cli'
import * as CommandExit from './CommandExit.js'

/**
 * The `silk doctest` command.
 *
 * Two inputs are accepted, because the two things worth doctesting are reached differently: a
 * project's documentation is a file `silk doc` wrote, and the standard library is compiler-shipped
 * modules with no project rooting them.
 */

const input = Flag.String('input').pipe(
  Flag.withAlias('i'),
  Flag.withDescription('Documentation JSON written by `silk doc`.'),
  Flag.optional,
)

const sourceRoot = Flag.String('source-root').pipe(
  Flag.withDescription(
    'Directory holding the documented modules, used to turn a byte offset into a line.',
  ),
  Flag.optional,
)

const stdlib = Flag.Boolean('stdlib').pipe(
  Flag.withDescription('Doctest the compiler-shipped standard library instead of a JSON file.'),
  Flag.withDefault(false),
)

const target = Flag.String('target').pipe(
  Flag.withDescription(`Target examples compile against. Defaults to ${Doctest.defaultTarget}.`),
  Flag.optional,
)

/**
 * Reads the modules the collected examples actually came from, at `<root>/<module>.silk`.
 *
 * Reading is effectful and the lookup a report needs is not, so the bytes are gathered up front
 * from the identities present in the documentation rather than fetched per failure. A module that
 * cannot be read is left out, which reports its examples' positions as unavailable instead of
 * failing the run over a file the report only wanted for a line number.
 */
const rootedSources = Effect.fnUntraced(function* (root: string, documentation: unknown) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const identities = new Set(
    Example.collect(documentation).map((example) => example.source.sourceId),
  )
  const bytes = new Map<string, Uint8Array>()
  for (const identity of identities) {
    const read = yield* Effect.result(fileSystem.readFile(path.join(root, `${identity}.silk`)))
    if (Result.isSuccess(read)) bytes.set(identity, read.success)
  }
  const lookup: Sources.Lookup = (sourceId) => bytes.get(sourceId)
  return lookup
})

export interface Options {
  readonly input?: string
  readonly sourceRoot?: string
  readonly stdlib?: boolean
  readonly target?: string
}

/**
 * Runs the workflow and reports it. Returns the process exit status: 2 for an input that could not
 * be read, 1 for a failing example, 0 otherwise.
 */
export const run = Effect.fn('DoctestCommand.run')(function* (
  options: Options = {},
): Effect.fn.Return<number, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem
  if (options.stdlib === true && options.input !== undefined) {
    yield* Console.error('Pass either --stdlib or --input, not both.')
    return 2
  }

  const loaded = yield* Effect.result(
    Effect.gen(function* () {
      if (options.stdlib === true) {
        const documentation: unknown = yield* Stdlib.documentation(
          options.target ?? Doctest.defaultTarget,
        )
        return { documentation, lookup: Stdlib.sources } as const
      }
      if (options.input === undefined)
        return yield* Effect.fail('Pass --input <documentation.json>, or --stdlib.')
      const text = yield* fileSystem
        .readFileString(options.input)
        .pipe(Effect.mapError(() => `Cannot read documentation JSON at ${options.input}`))
      const documentation = yield* Json.decode(text).pipe(
        Effect.mapError(() => `${options.input} does not hold valid JSON`),
      )
      const lookup =
        options.sourceRoot === undefined
          ? Sources.empty
          : yield* rootedSources(options.sourceRoot, documentation)
      return { documentation, lookup } as const
    }),
  )
  if (Result.isFailure(loaded)) {
    yield* Console.error(loaded.failure)
    return 2
  }

  const report = yield* Doctest.run({
    documentation: loaded.success.documentation,
    sources: loaded.success.lookup,
    ...(options.target === undefined ? {} : { target: options.target }),
  })
  const rendered = Report.render(report)
  yield* Doctest.hasFailures(report) ? Console.error(rendered) : Console.log(rendered)
  return Doctest.hasFailures(report) ? 1 : 0
})

export const command = Command.make(
  'doctest',
  { input, sourceRoot, stdlib, target },
  Effect.fnUntraced(function* (config) {
    const status = yield* run({
      ...(Option.isNone(config.input) ? {} : { input: config.input.value }),
      ...(Option.isNone(config.sourceRoot) ? {} : { sourceRoot: config.sourceRoot.value }),
      stdlib: config.stdlib,
      ...(Option.isNone(config.target) ? {} : { target: config.target.value }),
    })
    yield* CommandExit.complete(status)
  }),
).pipe(Command.withDescription('Compile the fenced Silk examples carried by documentation JSON.'))
