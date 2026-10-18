import type * as DeclarationFacts from './DeclarationFacts.js'
import type * as Tir from './Tir.js'
import type * as Instances from './Instances.js'
import type * as Layout from './Layout.js'
import type * as Mir from './Mir.js'
import type * as Type from './Type.js'

export type SuspensionClassification = 'Synchronous' | 'Suspendable' | 'Unknown'

export interface Capture {
  readonly ordinal: number
  readonly source: 'Binding' | 'Parameter' | 'Pattern'
  readonly sourceOrdinal: number
  readonly access: Type.CaptureAccess
  readonly type: DeclarationFacts.SemanticType
}

export interface Provider {
  readonly capability: Type.Nominal
  readonly providerType: Type.Nominal
  readonly role: string
  readonly requirementAccess: Type.Requirement['access']
  readonly access: Type.CallableMode
  readonly witness?: DeclarationFacts.ConformanceWitness
}

export interface RunnerBase<
  Capture_ extends Capture = Capture,
  Provider_ extends Provider = Provider,
> {
  readonly classification: SuspensionClassification
  readonly declaration?: DeclarationFacts.CanonicalId
  readonly instance?: Instances.InstanceKey
  readonly effectIdentity?: string
  readonly typeArguments: ReadonlyArray<Type.GenericArgument>
  readonly outcome: Type.Effect
  readonly captures: ReadonlyArray<Capture_>
  readonly providers: ReadonlyArray<Provider_>
}

export interface SuspensionPointId {
  readonly _tag: 'SuspensionPointId'
  readonly owner: Instances.InstanceKey
  readonly sourceId: string
  readonly spanStart: number
  readonly spanEnd: number
  readonly ordinal: number
}

export type SuspensionBorrowIdentity =
  | { readonly _tag: 'MirLoan'; readonly borrow: Tir.BorrowId }
  | { readonly _tag: 'BorrowedParameter'; readonly parameterOrdinal: number }
  | { readonly _tag: 'BorrowedLocal'; readonly local: Mir.LocalId }

export interface SuspensionProviderArgument extends Provider {
  readonly argument?: Mir.LocalId
  readonly argumentLane?: number
  readonly witness?: DeclarationFacts.ConformanceWitness
  readonly purposes: readonly ['ChildRequirement']
}

export interface SuspensionRunner extends RunnerBase<Capture, SuspensionProviderArgument> {}

export type SuspensionCompletion =
  | {
      readonly _tag: 'Propagate'
      readonly outcome: Type.Effect
      readonly failureMappings: ReadonlyArray<{ readonly source: number; readonly target: number }>
    }
  | {
      readonly _tag: 'Reify'
      readonly outcome: Type.Effect
      readonly successType: Type.Type
      readonly failureValueType: Type.Type
      readonly successShape: Layout.CallingShape
      readonly outcomeShape: Layout.CallingShape
      readonly failureValueShape: Layout.CallingShape
    }

export type SuspensionRegion =
  | {
      readonly _tag: 'SuspendEffectRegion'
      readonly point: SuspensionPointId
      readonly ownerRegion: Mir.RegionId
      readonly operation: Extract<
        Mir.Operation,
        { readonly _tag: 'RunEffect' | 'RunEffectValue' | 'CatchEffect' }
      >
      readonly deferred: SuspensionRunner
      readonly transfer: { readonly _tag: 'OriginateTransfer' }
      readonly provenance: Mir.Provenance
    }
  | {
      readonly _tag: 'RunSuspendableEffectRegion'
      readonly point: SuspensionPointId
      readonly ownerRegion: Mir.RegionId
      readonly operation: Extract<
        Mir.Operation,
        { readonly _tag: 'RunEffect' | 'RunEffectValue' | 'CatchEffect' | 'ExecutionRelinquish' }
      >
      readonly runner: SuspensionRunner
      readonly completion: SuspensionCompletion
      readonly liveLocals: ReadonlyArray<Mir.LocalId>
      readonly complete: { readonly _tag: 'CompleteInCurrentActivation' }
      readonly relay: {
        readonly _tag: 'RelayExistingTransfer'
        readonly preserves: readonly ['Child', 'Origin', 'TypedOutcome']
        readonly frame: 'StatefulRelay' | 'MissingOwnershipPlan'
        readonly state?: Mir.CoroutineFrameState
      }
      readonly provenance: Mir.Provenance
    }

export interface SuspensionControlEdge {
  readonly _tag: 'SuspensionControlEdge'
  readonly from: SuspensionPointId
  readonly to: Mir.ResumePointId | { readonly _tag: 'RelayExit' }
  readonly kind: 'ResumeSuccess' | 'ResumeFailure' | 'RelayTransfer'
}
