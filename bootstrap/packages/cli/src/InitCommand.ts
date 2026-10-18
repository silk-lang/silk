import * as Console from 'effect/Console'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Result from 'effect/Result'
import { Argument, Command, Flag } from 'effect/unstable/cli'
import * as CommandExit from './CommandExit.js'
import * as ProjectInitializer from './ProjectInitializer.js'

const path = Argument.String('path').pipe(
  Argument.withDescription('Project directory. Defaults to the current directory.'),
  Argument.optional,
)

const name = Flag.String('name').pipe(
  Flag.withDescription('Portable package name override.'),
  Flag.optional,
)

export const command = Command.make(
  'init',
  { path, name },
  Effect.fnUntraced(function* (config) {
    const initialized = yield* Effect.result(
      ProjectInitializer.initialize({
        ...(Option.isNone(config.path) ? {} : { path: config.path.value }),
        ...(Option.isNone(config.name) ? {} : { name: config.name.value }),
      }),
    )
    if (Result.isFailure(initialized)) {
      yield* Console.error(initialized.failure.message)
      return yield* CommandExit.complete(2)
    }
    yield* Console.log(
      `Initialized Silk project ${initialized.success.name} at ${initialized.success.directory}`,
    )
    return yield* CommandExit.complete(0)
  }),
).pipe(Command.withDescription('Create a minimal executable Silk project.'))
