import * as Console from 'effect/Console'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Result from 'effect/Result'
import { Command } from 'effect/unstable/cli'
import * as CommandExit from './CommandExit.js'
import * as ProjectOptions from './ProjectOptions.js'
import * as Workflow from './Workflow.js'

export const command = Command.make(
  'check',
  {
    manifestPath: ProjectOptions.manifestPath,
    targets: ProjectOptions.targets,
    optimization: ProjectOptions.optimization,
    profile: ProjectOptions.profile,
    profileInput: ProjectOptions.profileInput,
    release: ProjectOptions.release,
    watch: ProjectOptions.watch,
  },
  Effect.fnUntraced(function* (config) {
    const options = ProjectOptions.resolve({
      ...(Option.isNone(config.manifestPath) ? {} : { manifestPath: config.manifestPath.value }),
      targets: config.targets,
      ...(Option.isNone(config.optimization) ? {} : { optimization: config.optimization.value }),
      ...(Option.isNone(config.profile) ? {} : { profile: config.profile.value }),
      ...(Option.isNone(config.profileInput) ? {} : { profileInput: config.profileInput.value }),
      release: config.release,
    })
    if (Result.isFailure(options)) {
      yield* Console.error(options.failure.message)
      return yield* CommandExit.complete(2)
    }
    yield* CommandExit.complete(
      config.watch
        ? yield* Workflow.watch(Workflow.checkProject, options.success)
        : yield* Workflow.check(options.success),
    )
  }),
).pipe(Command.withDescription('Analyze the nearest Silk project without producing artifacts.'))
