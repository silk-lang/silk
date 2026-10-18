import * as Effect from 'effect/Effect'
import type * as ArtifactComposition from './ArtifactComposition.js'
import * as CAbi from './CAbi.js'
import type * as CompilationProfile from './CompilationProfile.js'
import * as ConfigurationError from './ConfigurationError.js'
import * as ConfigurationOrigin from './ConfigurationOrigin.js'
import type * as Frontend from './Frontend.js'
import * as Instances from './Instances.js'
import type * as Mir from './Mir.js'
import * as NativeLinkInput from './NativeLinkInput.js'
import * as NativeRequirement from './NativeRequirement.js'
import * as SourceFile from './SourceFile.js'
import * as ToolchainIntegrity from './ToolchainIntegrity.js'
import * as Type from './Type.js'
import * as Canonical from './internal/Canonical.js'

/** Requested representation of an independently selected semantic artifact form. */
export type Stage = 'llvm-ir' | 'llvm-bitcode' | 'assembly' | 'object' | 'final'

/** One inspectable source-selected logical artifact, before physical supply discovery. */
export interface ArtifactPlan {
  readonly profile: CompilationProfile.CompilationProfile
  readonly form: CompilationProfile.Artifact
  readonly stage: Stage
  readonly composition: ArtifactComposition.Resolved
  readonly roots: ReadonlyArray<Instances.InstanceKey>
  readonly exports: ReadonlyArray<{
    readonly symbol: string
    readonly declaration: string
    readonly signature: string
  }>
  readonly sources: ReadonlyArray<{ readonly module: string; readonly content: string }>
  readonly requirements: ReadonlyArray<NativeRequirement.Merged>
  readonly compiler: string
  readonly identity: string
}

/** Collects exactly reachable foreign, selected module and artifact-owned requirements. */
export const make = Effect.fn('ArtifactPlan.make')(function* (
  frontend: Frontend.Frontend,
  profile: CompilationProfile.CompilationProfile,
  composition: ArtifactComposition.Resolved,
  program: Mir.Module,
  stage: Stage,
  compiler: string,
): Effect.fn.Return<ArtifactPlan, ConfigurationError.ConfigurationError> {
  const loader = composition.loader.resolved
  if (
    stage === 'final' &&
    ((profile.artifact !== 'executable' && loader.kind === 'named') ||
      (profile.artifact === 'executable' &&
        loader.kind === 'none' &&
        profile.target.operatingSystem === 'darwin'))
  )
    return yield* ConfigurationError.make(
      'ArtifactPlan.make',
      'UnsupportedCombination',
      'loader entry and artifact form',
      [ConfigurationOrigin.literal('profile.entry')],
    )
  const active = frontend.index.modules.flatMap((module) =>
    (module.nativeRequirements ?? []).filter((requirement) => {
      const scope = requirement.scope
      return (
        scope.kind !== 'declaration' ||
        [...program.foreignCalls, ...program.foreignStatics].some(
          (call) =>
            call.declaration.module === scope.module && call.declaration.name === scope.declaration,
        )
      )
    }),
  )
  const requirements = yield* NativeRequirement.merge(
    [...active, ...composition.requirements],
    profile,
  )
  const roots = [
    ...(program.retainedRoots ?? []),
    ...program.foreignExports.map((record) => record.key),
  ].sort((a, b) => Canonical.compare(Instances.keyText(a), Instances.keyText(b)))
  const exports = [
    ...program.foreignExports.map((entry) => ({
      symbol: entry.symbol,
      declaration: Canonical.record('declaration', [
        entry.declaration.module,
        entry.declaration.name,
      ]),
      signature: CAbi.signatureKey(entry.signature),
    })),
    ...program.foreignStatics
      .filter((entry) => entry.direction === 'Export')
      .map((entry) => ({
        symbol: entry.symbol,
        declaration: Canonical.record('declaration', [
          entry.declaration.module,
          entry.declaration.name,
        ]),
        signature: Type.encode(entry.type),
      })),
  ].sort((a, b) => Canonical.compare(a.symbol, b.symbol))
  const sources = frontend.closure.modules
    .map((module) => ({
      module: module.name,
      content: ToolchainIntegrity.contentDigest(SourceFile.toUint8Array(module.syntax.source)),
    }))
    .sort((a, b) => Canonical.compare(a.module, b.module))
  const identity = ToolchainIntegrity.contentDigest(
    Canonical.record('ArtifactPlan.v1', [
      profile.identity,
      profile.artifact,
      stage,
      composition.identity,
      Canonical.array([...new Set(roots.map(Instances.keyText))]),
      Canonical.array(
        exports.map((entry) =>
          Canonical.record(entry.symbol, [entry.declaration, entry.signature]),
        ),
      ),
      Canonical.array(sources.map((source) => Canonical.record(source.module, [source.content]))),
      Canonical.array(
        requirements.map((requirement) =>
          Canonical.record(NativeRequirement.encode(requirement), [
            Canonical.array(
              [
                ...new Set(
                  requirement.contributions.map((entry) =>
                    Canonical.record(NativeRequirement.scopeKey(entry.scope), [
                      NativeRequirement.encode(entry),
                    ]),
                  ),
                ),
              ].sort(Canonical.compare),
            ),
          ]),
        ),
      ),
      compiler,
    ]),
  )
  return {
    profile,
    form: profile.artifact,
    stage,
    composition,
    roots,
    exports,
    sources,
    requirements,
    compiler,
    identity,
  }
})

/** Composes logical identity with explicitly ordered physical inputs for emission/link caches. */
export const physicalIdentity = (
  self: ArtifactPlan,
  inputs: ReadonlyArray<NativeLinkInput.NativeLinkInput>,
): string =>
  ToolchainIntegrity.contentDigest(
    Canonical.record('ArtifactPhysicalInputs.v1', [
      self.identity,
      Canonical.array(inputs.map(NativeLinkInput.encode)),
    ]),
  )
