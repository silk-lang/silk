import * as Console from 'effect/Console'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Result from 'effect/Result'
import { Command, Flag } from 'effect/unstable/cli'
import * as CommandExit from './CommandExit.js'
import * as ProjectOptions from './ProjectOptions.js'
import * as Workflow from './Workflow.js'

const root = Flag.String('root').pipe(
  Flag.withDescription('Manifest-relative .silk root whose active import graph supplies tests.'),
  Flag.optional,
)

const file = Flag.String('file').pipe(
  Flag.withDescription('Exact project-relative logical source path to select at runtime.'),
  Flag.optional,
)

const filter = Flag.String('filter').pipe(
  Flag.withDescription('Literal ASCII case-insensitive test-name substring to select at runtime.'),
  Flag.optional,
)

const noCache = Flag.Boolean('no-cache').pipe(
  Flag.withDescription('Execute selected tests without reading or writing persistent results.'),
  Flag.withDefault(false),
)

export const command = Command.make(
  'test',
  {
    manifestPath: ProjectOptions.manifestPath,
    targets: ProjectOptions.targets,
    optimization: ProjectOptions.optimization,
    profile: ProjectOptions.profile,
    profileInput: ProjectOptions.profileInput,
    release: ProjectOptions.release,
    verifyIr: ProjectOptions.verifyIr,
    root,
    file,
    filter,
    noCache,
    trace: ProjectOptions.trace,
  },
  Effect.fnUntraced(function* (config) {
    const options = ProjectOptions.resolve({
      ...(Option.isNone(config.manifestPath) ? {} : { manifestPath: config.manifestPath.value }),
      targets: config.targets,
      ...(Option.isNone(config.optimization) ? {} : { optimization: config.optimization.value }),
      ...(Option.isNone(config.profile) ? {} : { profile: config.profile.value }),
      ...(Option.isNone(config.profileInput) ? {} : { profileInput: config.profileInput.value }),
      release: config.release,
      verifyIr: config.verifyIr,
      ...(typeof config.trace === 'undefined' ? {} : { trace: config.trace }),
    })
    if (Result.isFailure(options)) {
      yield* Console.error(options.failure.message)
      return yield* CommandExit.complete(2)
    }
    yield* CommandExit.complete(
      yield* Workflow.test({
        ...options.success,
        ...(Option.isNone(config.root) ? {} : { root: config.root.value }),
        ...(Option.isNone(config.file) ? {} : { file: config.file.value }),
        ...(Option.isNone(config.filter) ? {} : { filter: config.filter.value }),
        cacheResults: !config.noCache,
      }),
    )
  }),
).pipe(Command.withDescription('Build and run tests reachable from one project source root.'))
