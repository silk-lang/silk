import type * as HelperCapability from './HelperCapability.js'
import type * as CTranslationUnit from './CTranslationUnit.js'
import type * as ArtifactPlan from './ArtifactPlan.js'
import type * as PlatformSupply from './PlatformSupply.js'
import type * as ToolchainPlan from './ToolchainPlan.js'

/** Scope-owned rewritten script, paired with its original content-accounted input. */
export interface Script {
  readonly path: string
  readonly source: string
}

/** Complete physical accounting consumed by the permanent native final-cache admission rule. */
export interface NativeLinkPlan {
  readonly helpers?: ReadonlyArray<HelperCapability.Report>
  readonly kind: ToolchainPlan.NativeArtifactKind
  readonly translations: ReadonlyArray<CTranslationUnit.CTranslationUnit>
  readonly _tag: 'NativeLinkPlan'
  readonly supply: PlatformSupply.PlatformSupply
  readonly command: ToolchainPlan.PlannedCommand
  readonly query: PlatformSupply.Query | undefined
  readonly inputs: ReadonlyArray<PlatformSupply.File>
  readonly scripts: ReadonlyArray<Script>
  readonly identity: string
  readonly entry: ArtifactPlan.ArtifactPlan['composition']['loader']
  readonly interpreter: string | undefined
  readonly output: string
}
