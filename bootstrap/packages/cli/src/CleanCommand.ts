import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import { Command } from 'effect/unstable/cli'
import * as CommandExit from './CommandExit.js'
import * as ProjectOptions from './ProjectOptions.js'
import * as Workflow from './Workflow.js'

export const command = Command.make(
  'clean',
  { manifestPath: ProjectOptions.manifestPath },
  Effect.fnUntraced(function* (config) {
    yield* CommandExit.complete(
      yield* Workflow.clean({
        ...(Option.isNone(config.manifestPath) ? {} : { manifestPath: config.manifestPath.value }),
        optimization: 'debug',
      }),
    )
  }),
).pipe(Command.withDescription('Remove the build artifacts of the nearest Silk project.'))
