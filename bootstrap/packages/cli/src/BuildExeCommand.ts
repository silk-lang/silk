import * as ProjectOptions from './ProjectOptions.js'
import * as PlatformSupply from '@silklang/compiler/PlatformSupply'
import * as ProjectProfile from '@silklang/compiler/ProjectProfile'
import * as ConfigurationOrigin from '@silklang/compiler/ConfigurationOrigin'
import * as Schema from 'effect/Schema'
import type * as HeapObservation from '@silklang/compiler/HeapObservation'
import * as NativeToolchain from '@silklang/compiler/NativeToolchain'
import * as SourceEntry from '@silklang/compiler/SourceEntry'
import * as Target from '@silklang/compiler/Target'
import type * as ToolchainPlan from '@silklang/compiler/ToolchainPlan'
import * as Console from 'effect/Console'
import * as Effect from 'effect/Effect'
import type * as FileSystem from 'effect/FileSystem'
import * as Option from 'effect/Option'
import type * as Path from 'effect/Path'
import * as Result from 'effect/Result'
import { Argument, Command, Flag } from 'effect/unstable/cli'
import * as CommandExit from './CommandExit.js'
import * as Workflow from './Workflow.js'

const targetIds = Target.all.map((candidate) => candidate.id)
const profiles = ['debug', 'release', 'release-with-debug'] as const

const source = Argument.File('source', { mustExist: true }).pipe(
  Argument.withDescription('The root source file to compile.'),
)

const sourceRoot = Flag.String('source-root').pipe(
  Flag.withDescription('Source root used for canonical module resolution.'),
  Flag.optional,
)

const output = Flag.String('output').pipe(
  Flag.withAlias('o'),
  Flag.withDescription('Destination path for the linked executable.'),
  Flag.withDefault('a.out'),
)

const target = Flag.Literals('target', targetIds).pipe(
  Flag.withDescription('Compilation target. Defaults to the host target.'),
  Flag.optional,
)

const optimization = Flag.Literals('optimization', profiles).pipe(
  Flag.withDescription('Optimization mode.'),
  Flag.optional,
)

const profileInput = Flag.String('profile-input').pipe(
  Flag.withDescription('Complete logical profile as JSON.'),
  Flag.optional,
)

const platformSupply = Flag.String('platform-supply').pipe(
  Flag.withDescription('Physical platform supply request as JSON.'),
  Flag.optional,
)

const clang = Flag.String('clang').pipe(
  Flag.withDescription('Path to the Clang executable used for object emission and linking.'),
  Flag.withDefault('clang'),
)

const saveTemps = Flag.Boolean('save-temps').pipe(
  Flag.withDescription('Keep the build scope intermediates for inspection.'),
  Flag.withDefault(false),
)

const timings = Flag.Boolean('timings').pipe(
  Flag.withDescription('Print the per-phase timing and memory report.'),
  Flag.withDefault(false),
)

export interface Options {
  readonly verifyIr?: boolean
  readonly source: string
  readonly sourceRoot: string | undefined
  readonly output: string
  readonly target: string | undefined
  readonly profileInput?: string
  readonly platformSupply?: string
  readonly optimization?: ToolchainPlan.OptimizationProfile | undefined
  readonly clang: string
  readonly saveTemps: boolean
  readonly timings: boolean
}

/** Compiles an explicitly selected root source outside the project manifest workflow. */
export const run = Effect.fn('BuildExeCommand.run')(function* (
  options: Options,
): Effect.fn.Return<
  Workflow.ExitStatus,
  never,
  FileSystem.FileSystem | HeapObservation.HeapObservation | Path.Path
> {
  let configuration: ProjectProfile.Profile | undefined
  if (options.profileInput !== undefined) {
    if (options.target !== undefined || options.optimization !== undefined) {
      yield* Console.error('--profile-input conflicts with --target and --optimization')
      return 2
    }
    const decoded = yield* Effect.result(
      Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(options.profileInput).pipe(
        Effect.flatMap((value) =>
          ProjectProfile.decode(value, ConfigurationOrigin.literal('build-exe')),
        ),
      ),
    )
    if (Result.isFailure(decoded)) {
      yield* Console.error('Invalid complete compilation profile')
      return 2
    }
    configuration = decoded.success
    if (configuration.input.artifact !== 'executable') {
      yield* Console.error('build-exe requires an executable profile')
      return 2
    }
  }
  const selectedTarget = configuration?.input.target ?? options.target
  const selected =
    selectedTarget === undefined ? NativeToolchain.hostSelection() : Target.select(selectedTarget)
  if (selected._tag === 'Unavailable' || !Target.isNative(selected.target)) {
    yield* Console.error(
      selected._tag === 'Unavailable'
        ? selected.error.message
        : `build-exe requires a native target; received ${selected.target.id}`,
    )
    return 2
  }
  let supplyRequest: PlatformSupply.Request | undefined
  if (options.platformSupply !== undefined) {
    const decoded = yield* Effect.result(
      Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(options.platformSupply).pipe(
        Effect.flatMap((value) => PlatformSupply.decode(value, 'build-exe --platform-supply')),
      ),
    )
    if (Result.isFailure(decoded)) {
      yield* Console.error('Invalid physical platform supply request')
      return 2
    }
    supplyRequest = decoded.success
  }
  const loaded = yield* Effect.result(SourceEntry.select(options.source, options.sourceRoot))
  if (Result.isFailure(loaded)) {
    yield* Console.error(loaded.failure.message)
    return 2
  }
  const attempted = yield* Workflow.compile({
    entry: loaded.success,
    ...(options.target === undefined ? {} : { target: options.target }),
    ...(options.optimization === undefined ? {} : { optimization: options.optimization }),
    ...(configuration === undefined
      ? {}
      : {
          configuration: {
            package: 'silk-build-exe@0.0.0',
            profile: configuration.input,
            bindings: configuration.bindings,
          },
        }),
    artifactKind: 'NativeExecutable',
    packageName: 'silk-build-exe',
    destination: options.output,
    toolchain: {
      _tag: 'Toolchain',
      clang: options.clang,
      llvmAr: 'llvm-ar',
      ...(supplyRequest === undefined ? {} : { platform: supplyRequest }),
    },
    scopeName: 'silk-build-exe',
    saveTemps: options.saveTemps,
    verifyIr: options.verifyIr ?? false,
    timings: options.timings,
  })
  return attempted.status
})

export const command = Command.make(
  'build-exe',
  {
    source,
    sourceRoot,
    output,
    target,
    optimization,
    profileInput,
    platformSupply,
    clang,
    saveTemps,
    verifyIr: ProjectOptions.verifyIr,
    timings,
  },
  Effect.fnUntraced(function* (config) {
    const status = yield* run({
      source: config.source,
      sourceRoot: Option.getOrUndefined(config.sourceRoot),
      output: config.output,
      target: Option.getOrUndefined(config.target),
      optimization: Option.getOrUndefined(config.optimization),
      ...Option.match(config.profileInput, {
        onNone: () => ({}),
        onSome: (value) => ({ profileInput: value }),
      }),
      ...Option.match(config.platformSupply, {
        onNone: () => ({}),
        onSome: (value) => ({ platformSupply: value }),
      }),
      clang: config.clang,
      saveTemps: config.saveTemps,
      verifyIr: config.verifyIr,
      timings: config.timings,
    })
    yield* CommandExit.complete(status)
  }),
).pipe(Command.withDescription('Build one rooted Silk source graph into a native executable.'))
