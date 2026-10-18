import * as ArtifactKind from '@silklang/compiler/ArtifactKind'
import * as Schema from 'effect/Schema'
import * as Effect from 'effect/Effect'
import * as ConfigurationOrigin from '@silklang/compiler/ConfigurationOrigin'
import type * as ConfigurationError from '@silklang/compiler/ConfigurationError'
import * as ProjectProfile from '@silklang/compiler/ProjectProfile'
import * as NativeToolchain from '@silklang/compiler/NativeToolchain'
import type * as Project from '@silklang/compiler/Project'
import * as Target from '@silklang/compiler/Target'
import * as TargetSelector from '@silklang/compiler/TargetSelector'
import * as ToolchainPlan from '@silklang/compiler/ToolchainPlan'
import * as Data from 'effect/Data'
import * as Result from 'effect/Result'
import * as BuildPlan from './BuildPlan.js'

/** One preflighted ordered non-empty collection of single-target LLVM plans. */
export interface BuildBatch {
  readonly _tag: 'BuildBatch'
  readonly plans: readonly [BuildPlan.BuildPlan, ...Array<BuildPlan.BuildPlan>]
}

export type BuildBatchErrorReason =
  | { readonly _tag: 'Configuration'; readonly error: ConfigurationError.ConfigurationError }
  | { readonly _tag: 'InvalidProfileInput' }
  | { readonly _tag: 'Target'; readonly error: TargetSelector.TargetSelectorError }
  | { readonly _tag: 'Plan'; readonly error: BuildPlan.BuildPlanError }
  | { readonly _tag: 'EmptyTargets' }

/** A complete project build batch could not pass preflight. */
export class BuildBatchError extends Data.TaggedError('BuildBatchError')<{
  readonly operation: 'BuildBatch.make'
  readonly message: string
  readonly reason: BuildBatchErrorReason
}> {}

export interface Options {
  readonly targets?: ReadonlyArray<string>
  readonly optimization?: ToolchainPlan.OptimizationProfile
  readonly profile?: string
  readonly profileInput?: string
  readonly purpose?: BuildPlan.Purpose
  readonly clang?: string
  readonly llvmAr?: string
}

/** Resolves all targets before returning any executable build work. */
export const make = Effect.fn('BuildBatch.make')(function* (
  project: Project.Project,
  options: Options,
): Effect.fn.Return<BuildBatch, BuildBatchError> {
  const origin = ConfigurationOrigin.literal(project.manifestPath)
  const catalog: ProjectProfile.Catalog = project.profiles ?? {
    profiles: new Map(),
    bindings: [],
    origin,
  }
  const selected = yield* Effect.result(
    Effect.gen(function* () {
      const override =
        options.profileInput === undefined
          ? undefined
          : yield* ProjectProfile.decode(
              yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(
                options.profileInput,
              ).pipe(
                Effect.mapError(
                  () =>
                    new BuildBatchError({
                      operation: 'BuildBatch.make',
                      message: 'Invalid --profile-input JSON',
                      reason: { _tag: 'InvalidProfileInput' },
                    }),
                ),
              ),
              origin,
            )
      const named =
        options.profile ??
        (options.targets === undefined && override === undefined ? catalog.default : undefined)
      if (named !== undefined || override !== undefined) {
        if (options.targets !== undefined || options.optimization !== undefined)
          return yield* new BuildBatchError({
            operation: 'BuildBatch.make',
            message: 'Named/full profiles conflict with target and optimization flags',
            reason: { _tag: 'InvalidProfileInput' },
          })
        return [
          yield* ProjectProfile.select(catalog, {
            ...(named === undefined ? {} : { name: named }),
            ...(override === undefined ? {} : { override }),
          }),
        ]
      }
      const targets = TargetSelector.resolveAll(
        options.targets ??
          (options.purpose === 'run' || options.purpose === 'test'
            ? ['host']
            : project.build.targets),
        NativeToolchain.hostSelection(),
      )
      if (Result.isFailure(targets))
        return yield* new BuildBatchError({
          operation: 'BuildBatch.make',
          message: targets.failure.message,
          reason: { _tag: 'Target', error: targets.failure },
        })
      const profiles: Array<ProjectProfile.Profile> = []
      for (const target of targets.success) {
        const profile = yield* ProjectProfile.select(catalog, { target: target.id })
        profiles.push({
          ...profile,
          input: {
            ...profile.input,
            artifact: ArtifactKind.profileArtifact(
              target.kind === 'WebAssembly'
                ? ArtifactKind.webAssemblyModule
                : project.build.artifact,
            ),
            optimization:
              options.optimization === undefined || options.optimization === 'debug'
                ? 'none'
                : 'speed',
            debug: options.optimization !== 'release',
          },
        })
      }
      return profiles
    }),
  )
  if (Result.isFailure(selected)) {
    if (selected.failure._tag === 'BuildBatchError') return yield* selected.failure
    return yield* new BuildBatchError({
      operation: 'BuildBatch.make',
      message: selected.failure.message,
      reason: { _tag: 'Configuration', error: selected.failure },
    })
  }
  const plans: Array<BuildPlan.BuildPlan> = []
  for (const configuration of selected.success) {
    const target = Target.select(configuration.input.target)
    if (target._tag === 'Unavailable') {
      return yield* new BuildBatchError({
        operation: 'BuildBatch.make',
        message: target.error.message,
        reason: { _tag: 'InvalidProfileInput' },
      })
    }
    const plan = BuildPlan.make(project, {
      target: target.target,
      optimization: ToolchainPlan.optimizationFor(configuration.input),
      configuration,
      ...(options.purpose === undefined ? {} : { purpose: options.purpose }),
      ...(options.clang === undefined ? {} : { clang: options.clang }),
      ...(options.llvmAr === undefined ? {} : { llvmAr: options.llvmAr }),
    })
    if (Result.isFailure(plan)) {
      return yield* new BuildBatchError({
        operation: 'BuildBatch.make',
        message: plan.failure.message,
        reason: { _tag: 'Plan', error: plan.failure },
      })
    }
    plans.push(plan.success)
  }
  const first = plans.at(0)
  if (first === undefined) {
    return yield* new BuildBatchError({
      operation: 'BuildBatch.make',
      message: 'A build batch requires at least one target',
      reason: { _tag: 'EmptyTargets' },
    })
  }
  const ordered: readonly [BuildPlan.BuildPlan, ...Array<BuildPlan.BuildPlan>] = [
    first,
    ...plans.slice(1),
  ]
  return { _tag: 'BuildBatch', plans: ordered }
})
