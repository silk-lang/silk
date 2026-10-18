import type * as Value from '@silklang/llvm/Value'
import * as Layout from './Layout.js'
import * as Mir from './Mir.js'
import type * as NativePlace from './NativePlace.js'
import * as NativeType from './NativeType.js'

/** Direct payloads are bounded primitives; recursively growing values reside in typed places. */
export type NativeValue =
  | { readonly _tag: 'Empty' }
  | { readonly _tag: 'Direct'; readonly values: ReadonlyArray<Value.Input> }
  | NativePlace.NativePlace

export type Classification = 'Empty' | 'Direct' | 'Place' | 'BorrowedPlace'

/** Classifies by semantic representation, never by a benchmark-selected width threshold. */
export const classify = (layout: Layout.Plan, type: Mir.Type): Classification => {
  if (type._tag === 'EnvironmentBorrow') return 'BorrowedPlace'
  if (type._tag === 'Bottom') return 'Empty'
  switch (type._tag) {
    case 'EffectValue':
    case 'CallableValue':
    case 'EffectOutcome':
    case 'EffectComposite':
    case 'FixedArray':
    case 'Union':
      return NativeType.addressLayout(layout, type)?.size === 0 ? 'Empty' : 'Place'
    case 'Nominal': {
      const entry = Layout.entry(layout, Mir.semanticType(type))
      if (entry?.size === 0) return 'Empty'
      // Runtime-owned opaque handles have a scalar address representation despite nominal identity.
      const shape = Layout.callingShape(layout, Mir.semanticType(type))
      return shape?.tree._tag === 'AddressShape' ? 'Direct' : 'Place'
    }
    case 'Enum':
    case 'String':
    case 'Slice':
    case 'Reference':
    case 'Pointer':
    case 'ForeignFunction':
      return 'Direct'
    default:
      return scalar(type)
  }
}

// This parameter is an exhaustiveness check: a newly added aggregate MIR variant must
// choose its representation above rather than silently inheriting the scalar policy.
const scalar = (_type: Mir.ScalarType): Classification => 'Direct'
