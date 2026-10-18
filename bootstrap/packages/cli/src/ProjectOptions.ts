import * as Target from '@silklang/compiler/Target'
import type * as ToolchainPlan from '@silklang/compiler/ToolchainPlan'
import * as Data from 'effect/Data'
import * as Result from 'effect/Result'
import { Flag } from 'effect/unstable/cli'

export const profiles = ['debug', 'release', 'release-with-debug'] as const
const targetIds = ['host', ...Target.all.map((candidate) => candidate.id)]

export const manifestPath = Flag.String('manifest-path').pipe(
  Flag.withDescription('Path to a Silk project manifest. Disables upward discovery.'),
  Flag.optional,
)

export const targets = Flag.Literals('target', targetIds).pipe(
  Flag.withDescription('Compilation target selector. Repeat to build more than one target.'),
  Flag.atLeast(0),
)

export const profile = Flag.String('profile').pipe(
  Flag.withDescription('Named project compilation profile.'),
  Flag.optional,
)
export const profileInput = Flag.String('profile-input').pipe(
  Flag.withDescription('Complete logical profile as a JSON object.'),
  Flag.optional,
)

export const optimization = Flag.Literals('optimization', profiles).pipe(
  Flag.withDescription('Compilation optimization.'),
  Flag.optional,
)

export const release = Flag.Boolean('release').pipe(
  Flag.withDescription('Build with the release optimization.'),
  Flag.withDefault(false),
)

export const verifyIr = Flag.Boolean('verify-ir').pipe(
  Flag.withDescription('Audit lowered MIR and emitted LLVM IR invariants (compiler development).'),
  Flag.withDefault(false),
)

export const trace = Flag.Boolean('trace').pipe(
  Flag.withDescription('Enable tracing of the compilation process.'),
  Flag.withDefault(false),
)
export const watch = Flag.Boolean('watch').pipe(
  Flag.withDescription('Run again after every change to a project source file.'),
  Flag.withDefault(false),
)

export interface Input {
  readonly verifyIr?: boolean
  readonly manifestPath?: string
  readonly targets?: ReadonlyArray<string>
  readonly profile?: string
  readonly profileInput?: string
  readonly optimization?: ToolchainPlan.OptimizationProfile
  readonly release: boolean
  readonly trace?: boolean
}

export interface ProjectOptions {
  readonly verifyIr?: boolean
  readonly manifestPath?: string
  readonly targets?: ReadonlyArray<string>
  readonly profile?: string
  readonly profileInput?: string
  readonly optimization?: ToolchainPlan.OptimizationProfile
  readonly trace?: boolean
}

/** Project command flags contradict one another. */
export class ProjectOptionsError extends Data.TaggedError('ProjectOptionsError')<{
  readonly operation: 'ProjectOptions.resolve'
  readonly message: string
  readonly reason: { readonly _tag: 'ConflictingProfile'; readonly optimization: string }
}> {}

/** Resolves shared project flags before project discovery or compilation begins. */
export const resolve = (input: Input): Result.Result<ProjectOptions, ProjectOptionsError> => {
  if (input.release && input.optimization !== undefined && input.optimization !== 'release') {
    return Result.fail(
      new ProjectOptionsError({
        operation: 'ProjectOptions.resolve',
        message: `--release conflicts with --optimization ${input.optimization}`,
        reason: { _tag: 'ConflictingProfile', optimization: input.optimization },
      }),
    )
  }
  let optimization = input.optimization
  if (input.release) optimization = 'release'
  return Result.succeed({
    ...(input.verifyIr === undefined ? {} : { verifyIr: input.verifyIr }),
    ...(input.manifestPath === undefined ? {} : { manifestPath: input.manifestPath }),
    ...(input.targets === undefined || input.targets.length === 0
      ? {}
      : { targets: input.targets }),
    ...(optimization === undefined ? {} : { optimization }),
    ...(input.profile === undefined ? {} : { profile: input.profile }),
    ...(input.profileInput === undefined ? {} : { profileInput: input.profileInput }),
    ...(input.trace === undefined ? {} : { trace: input.trace }),
  })
}
