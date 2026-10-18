import * as Console from 'effect/Console'
import * as Effect from 'effect/Effect'
import type * as FileSystem from 'effect/FileSystem'
import * as Option from 'effect/Option'
import type * as Path from 'effect/Path'
import * as Result from 'effect/Result'
import { Argument, Command, Flag } from 'effect/unstable/cli'
import * as CommandExit from './CommandExit.js'
import * as FormatWorkflow from './FormatWorkflow.js'
import * as ProjectOptions from './ProjectOptions.js'

const paths = Argument.String('path').pipe(
  Argument.withDescription('A source-root .silk file or directory to format.'),
  Argument.variadic(),
)

const check = Flag.Boolean('check').pipe(
  Flag.withDescription('Verify canonical formatting without writing files.'),
  Flag.withDefault(false),
)

export interface Options {
  readonly manifestPath?: string
  readonly paths?: ReadonlyArray<string>
  readonly check?: boolean
}

const diagnosticCodes = (
  outcome: Extract<FormatWorkflow.Outcome, { readonly _tag: 'Damaged' }>,
): string => {
  const reason = outcome.error.reason
  const diagnostics =
    reason._tag === 'OuterSyntax' || reason._tag === 'EmbeddedSyntax' ? reason.diagnostics : []
  return Array.from(new Set(diagnostics.map((diagnostic) => diagnostic.code))).join(', ')
}

const damageLocation = (
  outcome: Extract<FormatWorkflow.Outcome, { readonly _tag: 'Damaged' }>,
): string => {
  const reason = outcome.error.reason
  if (reason._tag === 'OuterSyntax') return ''
  if (reason._tag === 'DocumentationInfrastructure') return ''
  const nested = reason.nestedPath.map((range) => `${range.start}..${range.end}`).join(' -> ')
  return ` at bytes ${reason.fence.start}..${reason.fence.end}${nested === '' ? '' : ` (nested ${nested})`}`
}

/** Renders one per-file outcome after the workflow has fixed deterministic path order. */
export const report = Effect.fn('FormatCommand.report')(function* (
  outcome: FormatWorkflow.Outcome,
  checkOnly: boolean,
) {
  switch (outcome._tag) {
    case 'Unchanged':
      yield* Console.log(`${outcome.path}: unchanged`)
      return
    case 'Changed':
      if (checkOnly) yield* Console.error(`${outcome.path}: needs formatting`)
      else yield* Console.log(`${outcome.path}: formatted`)
      return
    case 'Damaged': {
      const codes = diagnosticCodes(outcome)
      yield* Console.error(
        `${outcome.path}: cannot format damaged source${damageLocation(outcome)}${codes.length === 0 ? '' : ` (${codes})`}`,
      )
      return
    }
    case 'Failed':
      yield* Console.error(`${outcome.path}: ${outcome.message}`)
      return
  }
})

/** Runs project formatting and reports every safely classifiable selected file. */
export const run = Effect.fn('FormatCommand.run')(function* (
  options: Options = {},
): Effect.fn.Return<number, never, FileSystem.FileSystem | Path.Path> {
  const attempted = yield* Effect.result(
    FormatWorkflow.run({
      ...(options.manifestPath === undefined ? {} : { manifestPath: options.manifestPath }),
      ...(options.paths === undefined ? {} : { paths: options.paths }),
      check: options.check ?? false,
    }),
  )
  if (Result.isFailure(attempted)) {
    yield* Console.error(attempted.failure.message)
    return 2
  }
  for (const outcome of attempted.success.outcomes) {
    yield* report(outcome, attempted.success.check)
  }
  return FormatWorkflow.exitStatus(attempted.success)
})

export const command = Command.make(
  'format',
  { manifestPath: ProjectOptions.manifestPath, paths, check },
  Effect.fnUntraced(function* (config) {
    const status = yield* run({
      ...(Option.isNone(config.manifestPath) ? {} : { manifestPath: config.manifestPath.value }),
      paths: config.paths,
      check: config.check,
    })
    yield* CommandExit.complete(status)
  }),
).pipe(Command.withDescription('Format Silk project source into its canonical representation.'))
