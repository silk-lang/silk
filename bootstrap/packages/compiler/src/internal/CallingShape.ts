import type * as DeclarationFacts from '../DeclarationFacts.js'
import type * as Type from '../Type.js'

export interface CallingLane {
  readonly _tag: 'CallingLane'
  readonly path: ReadonlyArray<Selector>
  readonly type: CallingScalar
}

export interface AddressScalar {
  readonly _tag: 'Address'
  readonly element: DeclarationFacts.SemanticType
  readonly bits: 32 | 64
}

export type CallingScalar = Type.Builtin | AddressScalar

export type Selector =
  | DeclarationFacts.FieldId
  | { readonly _tag: 'ElementSelector'; readonly index: number }
  | { readonly _tag: 'CallableCaptureSelector'; readonly ordinal: number }
  | { readonly _tag: 'EffectCaptureSelector'; readonly ordinal: number }
  | { readonly _tag: 'UnionTagSelector' }
  | { readonly _tag: 'UnionPayloadSelector'; readonly slot: number }
  | { readonly _tag: 'NominalUnionTagSelector' }
  | { readonly _tag: 'NominalUnionPayloadSelector'; readonly slot: number }
  | { readonly _tag: 'SliceAddressSelector' }
  | { readonly _tag: 'SliceLengthSelector' }
  | { readonly _tag: 'StringStorageSelector' }
  | { readonly _tag: 'StringByteLengthSelector' }
  | { readonly _tag: 'ReferenceAddressSelector' }

export type CallingShapeNode =
  | { readonly _tag: 'EmptyShape'; readonly type: Type.Bottom; readonly laneCount: 0 }
  | { readonly _tag: 'ScalarShape'; readonly type: Type.Builtin; readonly laneCount: 1 }
  | {
      readonly _tag: 'ScalarEnumShape'
      readonly type: Type.Nominal
      readonly lane: Type.Builtin
      readonly laneCount: 1
    }
  | {
      readonly _tag: 'ProductShape'
      readonly type: Type.Nominal
      readonly fields: ReadonlyArray<{
        readonly field: DeclarationFacts.FieldId
        readonly shape: CallingShapeNode
      }>
      readonly laneCount: number
    }
  | {
      readonly _tag: 'RepeatedShape'
      readonly type: Type.FixedArray
      readonly length: number
      readonly element: CallingShapeNode
      readonly laneCount: number
    }
  | {
      readonly _tag: 'SliceShape'
      readonly type: Type.Slice
      readonly address: { readonly type: AddressScalar; readonly lane: 0 }
      readonly length: { readonly type: 'usize'; readonly lane: 1 }
      readonly laneCount: 2
    }
  | {
      readonly _tag: 'StringShape'
      readonly type: Type.String
      readonly storage: { readonly type: AddressScalar; readonly lane: 0 }
      readonly byteLength: { readonly type: 'usize'; readonly lane: 1 }
      readonly laneCount: 2
    }
  | {
      readonly _tag: 'ReferenceShape'
      readonly type: Type.Reference
      readonly address: { readonly type: AddressScalar; readonly lane: 0 }
      readonly laneCount: 1
    }
  | {
      readonly _tag: 'AddressShape'
      readonly type: DeclarationFacts.SemanticType
      readonly address: { readonly type: AddressScalar; readonly lane: 0 }
      readonly laneCount: 1
    }
  | {
      readonly _tag: 'CallableEnvironmentShape'
      readonly type: DeclarationFacts.SemanticType
      readonly fields: ReadonlyArray<{ readonly capture: number; readonly shape: CallingShapeNode }>
      readonly laneCount: number
    }
  | {
      readonly _tag: 'EffectEnvironmentShape'
      readonly type: DeclarationFacts.SemanticType
      readonly fields: ReadonlyArray<{ readonly capture: number; readonly shape: CallingShapeNode }>
      readonly laneCount: number
    }
  | {
      readonly _tag: 'SumShape'
      readonly type: Type.StructuralUnion
      readonly tag: { readonly type: 'i32'; readonly lane: 0 }
      readonly payloadLaneCount: number
      readonly payloadTypes: ReadonlyArray<Type.Builtin>
      readonly zeroFill: true
      readonly members: ReadonlyArray<{
        readonly member: Type.Type
        readonly ordinal: number
        readonly shape: CallingShapeNode
        readonly payloadSlots: ReadonlyArray<number>
      }>
      readonly laneCount: number
    }
  | {
      readonly _tag: 'NominalUnionShape'
      readonly type: Type.Nominal
      readonly tag: { readonly type: 'i32'; readonly lane: 0 }
      readonly payloadLaneCount: number
      readonly payloadTypes: ReadonlyArray<Type.Builtin>
      readonly zeroFill: true
      readonly variants: ReadonlyArray<{
        readonly variant: DeclarationFacts.CanonicalUnionVariantId
        readonly ordinal: number
        readonly shape: CallingShapeNode
        readonly payloadSlots: ReadonlyArray<number>
      }>
      readonly laneCount: number
    }
  | {
      readonly _tag: 'OutcomeShape'
      readonly type: Type.Effect
      readonly success: CallingShapeNode
      readonly failures: ReadonlyArray<{
        readonly type: Type.Type
        readonly tag: number
        readonly shape: CallingShapeNode
      }>
      readonly payloadLaneCount: number
      readonly payloadTypes: ReadonlyArray<Type.Builtin>
      readonly laneCount: number
    }
  | {
      readonly _tag: 'EffectCompositeShape'
      readonly type: Type.Represented
      readonly alternativeLaneCounts: ReadonlyArray<number>
      readonly payloadTypes: ReadonlyArray<CallingScalar>
      readonly laneCount: number
    }

export interface CallingShape {
  readonly _tag: 'CallingShape'
  readonly type: DeclarationFacts.SemanticType
  readonly tree: CallingShapeNode
  readonly laneCount: number
  readonly lanes: ReadonlyArray<CallingLane>
}
