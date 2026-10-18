import type * as ModuleClosure from '@silklang/compiler/ModuleClosure'
import * as ConfigurationOrigin from '@silklang/compiler/ConfigurationOrigin'
import type * as ArtifactPlan from '@silklang/compiler/ArtifactPlan'
import type * as ProjectProfile from '@silklang/compiler/ProjectProfile'
import { join } from 'node:path'
import * as ArtifactKind from '@silklang/compiler/ArtifactKind'
import * as NativeToolchain from '@silklang/compiler/NativeToolchain'
import type * as NativeLinkInput from '@silklang/compiler/NativeLinkInput'
import * as Project from '@silklang/compiler/Project'
import * as Target from '@silklang/compiler/Target'
import * as ToolchainPlan from '@silklang/compiler/ToolchainPlan'
import * as Data from 'effect/Data'
import * as Result from 'effect/Result'

export type Purpose = 'build' | 'run' | 'test'

export interface BuildPlan {
  readonly _tag: 'BuildPlan'
  readonly project: Project.Project
  readonly target: Target.Target
  readonly artifactKind: ArtifactKind.ArtifactKind
  readonly stage?: ArtifactPlan.Stage
  readonly configuration?: ProjectProfile.Profile
  readonly optimization: ToolchainPlan.OptimizationProfile
  readonly destination: string
  readonly toolchain: NativeToolchain.Toolchain
  /** The manifest's ordered native inputs for a native target; empty for WebAssembly. */
  readonly nativeLinkInputs: ReadonlyArray<NativeLinkInput.NativeLinkInput>
}

export type BuildPlanErrorReason =
  | { readonly _tag: 'UnsupportedProfileArtifact'; readonly artifact: string }
  | { readonly _tag: 'InvalidPackageName'; readonly name: string }
  | { readonly _tag: 'NonExecutableRunArtifact'; readonly artifactKind: ArtifactKind.ArtifactKind }
  | {
      readonly _tag: 'IncompatibleArtifactTarget'
      readonly artifactKind: ArtifactKind.ArtifactKind
      readonly target: Target.Id
    }
  | { readonly _tag: 'NativeInputsForWebAssembly'; readonly target: Target.Id }
  | {
      readonly _tag: 'UnsupportedNativePlan'
      readonly plan: ToolchainPlan.UnsupportedNativePlan
    }
  | { readonly _tag: 'ForeignRunTarget'; readonly target: Target.Id; readonly host: Target.Id }
  | { readonly _tag: 'HostUnavailable'; readonly error: Target.TargetError }

/** Project target/optimization selection cannot produce the requested workflow. */
export class BuildPlanError extends Data.TaggedError('BuildPlanError')<{
  readonly operation: 'BuildPlan.make'
  readonly message: string
  readonly reason: BuildPlanErrorReason
}> {}

export interface Options {
  readonly target: Target.Target
  readonly configuration?: ProjectProfile.Profile
  readonly optimization: ToolchainPlan.OptimizationProfile
  readonly purpose?: Purpose
  readonly clang?: string
  readonly llvmAr?: string
}

/** Creates one immutable, already-resolved LLVM build plan. */
export const make = (
  project: Project.Project,
  options: Options,
): Result.Result<BuildPlan, BuildPlanError> => {
  if (!Project.isPackageName(project.name)) {
    return Result.fail(
      new BuildPlanError({
        operation: 'BuildPlan.make',
        message: `Project package name ${project.name} is not portable`,
        reason: { _tag: 'InvalidPackageName', name: project.name },
      }),
    )
  }
  const testPurpose = options.purpose === 'test'
  const configuration =
    testPurpose && options.configuration !== undefined
      ? {
          ...options.configuration,
          input: { ...options.configuration.input, artifact: 'executable' as const },
        }
      : options.configuration
  let artifactKind = Target.isNative(options.target)
    ? project.build.artifact
    : ArtifactKind.webAssemblyModule
  if (testPurpose) artifactKind = ArtifactKind.nativeExecutable
  const logicalArtifact = configuration?.input.artifact
  if (logicalArtifact !== undefined) {
    if (Target.isNative(options.target)) {
      if (logicalArtifact === 'executable') artifactKind = 'NativeExecutable'
      else if (logicalArtifact === 'static-archive') artifactKind = 'NativeStaticLibrary'
      else if (logicalArtifact === 'object') artifactKind = 'NativeObject'
      else artifactKind = 'NativeSharedLibrary'
    }
  }
  const stage = testPurpose ? 'final' : (project.build.stage ?? 'final')
  if (options.purpose === 'run' || testPurpose) {
    if (artifactKind !== 'NativeExecutable' || stage !== 'final') {
      return Result.fail(
        new BuildPlanError({
          operation: 'BuildPlan.make',
          message: `Cannot run ${ArtifactKind.manifestSpelling(artifactKind)} artifact`,
          reason: {
            _tag: 'NonExecutableRunArtifact',
            artifactKind,
          },
        }),
      )
    }
    const host = NativeToolchain.hostSelection()
    if (host._tag === 'Unavailable') {
      return Result.fail(
        new BuildPlanError({
          operation: 'BuildPlan.make',
          message: host.error.message,
          reason: { _tag: 'HostUnavailable', error: host.error },
        }),
      )
    }
    if (options.target.id !== host.target.id) {
      return Result.fail(
        new BuildPlanError({
          operation: 'BuildPlan.make',
          message: `Cannot run target ${options.target.id} on host ${host.target.id}`,
          reason: {
            _tag: 'ForeignRunTarget',
            target: options.target.id,
            host: host.target.id,
          },
        }),
      )
    }
  }

  if (
    !Target.isNative(options.target) &&
    logicalArtifact === undefined &&
    project.build.artifact !== 'NativeExecutable'
  ) {
    return Result.fail(
      new BuildPlanError({
        operation: 'BuildPlan.make',
        message: `Artifact ${ArtifactKind.manifestSpelling(artifactKind)} is incompatible with target ${options.target.id}`,
        reason: {
          _tag: 'IncompatibleArtifactTarget',
          artifactKind,
          target: options.target.id,
        },
      }),
    )
  }
  if (!Target.isNative(options.target) && project.build.nativeLinkInputs.length > 0) {
    return Result.fail(
      new BuildPlanError({
        operation: 'BuildPlan.make',
        message: `Native link inputs are incompatible with target ${options.target.id}`,
        reason: { _tag: 'NativeInputsForWebAssembly', target: options.target.id },
      }),
    )
  }
  const destination = join(
    project.build.outputDirectory,
    ...(testPurpose ? ['test'] : []),
    'llvm',
    options.target.id,
    options.optimization,
    stage === 'final'
      ? ArtifactKind.fileName(artifactKind, project.name, options.target)
      : `${project.name}.${{ 'llvm-ir': 'll', 'llvm-bitcode': 'bc', assembly: 's', object: 'o' }[stage]}`,
  )
  const platformSupply = project.build.platformSupply
  let supplyOptions: Pick<NativeToolchain.Toolchain, 'platform' | 'projectSupply'> = {}
  if (platformSupply !== undefined) {
    if (platformSupply.kind === 'explicit' || platformSupply.kind === 'managed')
      supplyOptions = { projectSupply: platformSupply }
    else supplyOptions = { platform: platformSupply }
  }
  const toolchain = {
    _tag: 'Toolchain' as const,
    clang: options.clang ?? 'clang',
    llvmAr: options.llvmAr ?? 'llvm-ar',
    ...supplyOptions,
  }
  if (Target.isNative(options.target) && artifactKind !== 'WebAssemblyModule') {
    const nativePlan = ToolchainPlan.nativeCommand(
      toolchain,
      artifactKind,
      options.target,
      [],
      project.build.nativeLinkInputs,
      destination,
    )
    if (nativePlan._tag === 'UnsupportedNativePlan') {
      return Result.fail(
        new BuildPlanError({
          operation: 'BuildPlan.make',
          message: `Native link input ${nativePlan.input._tag} is unsupported for ${ArtifactKind.manifestSpelling(artifactKind)} on ${options.target.id}`,
          reason: { _tag: 'UnsupportedNativePlan', plan: nativePlan },
        }),
      )
    }
  }
  return Result.succeed({
    _tag: 'BuildPlan' as const,
    project,
    target: options.target,
    artifactKind,
    stage,
    optimization: options.optimization,
    ...(configuration === undefined ? {} : { configuration }),
    destination,
    toolchain,
    nativeLinkInputs: Target.isNative(options.target) ? project.build.nativeLinkInputs : [],
  })
}

/** Builds the complete logical request shared by project checking, building and running. */
export const compilationConfiguration = (
  self: BuildPlan,
): NonNullable<ModuleClosure.CompilationRequest['configuration']> => ({
  package: `${self.project.name}@${self.project.version}`,
  profile: self.configuration?.input ?? {
    target: self.target.id,
    artifact: ArtifactKind.profileArtifact(self.artifactKind),
    optimization: self.optimization === 'debug' ? 'none' : 'speed',
    debug: self.optimization !== 'release',
  },
  bindings: self.configuration?.bindings ?? [],
  ...(self.project.build.composition === undefined
    ? {}
    : {
        composition: self.project.build.composition,
        compositionOrigin: ConfigurationOrigin.literal(
          `${self.project.manifestPath}:build.composition`,
        ),
      }),
})
