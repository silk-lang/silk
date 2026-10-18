import type * as ByteString from '../ByteString.js'

export type FloatFormat =
  | 'half'
  | 'bfloat'
  | 'float'
  | 'double'
  | 'x86_fp80'
  | 'fp128'
  | 'ppc_fp128'

export type CastKind = 'trunc' | 'ptrtoint' | 'inttoptr' | 'bitcast' | 'addrspacecast'

export type BinaryKind =
  | 'add'
  | 'add nsw'
  | 'add nuw'
  | 'sub'
  | 'sub nsw'
  | 'sub nuw'
  | 'shl'
  | 'xor'

interface Typed {
  readonly type: number
}

export type Description =
  | (Typed & { readonly _tag: 'Global'; readonly global: number })
  | (Typed & { readonly _tag: 'Integer'; readonly bitPattern: bigint; readonly signed: boolean })
  | (Typed & {
      readonly _tag: 'Float'
      readonly format: FloatFormat
      readonly bits: ByteString.ByteString
    })
  | (Typed & {
      readonly _tag: 'Special'
      readonly kind: 'null' | 'none' | 'zeroinitializer' | 'undef' | 'poison'
    })
  | (Typed & {
      readonly _tag: 'Aggregate'
      readonly kind: 'array' | 'vector' | 'structure' | 'packed-structure'
      readonly elements: ReadonlyArray<number>
    })
  | (Typed & { readonly _tag: 'String'; readonly bytes: ByteString.ByteString })
  | (Typed & { readonly _tag: 'Splat'; readonly value: number })
  | (Typed & { readonly _tag: 'BlockAddress'; readonly function: number; readonly block: number })
  | (Typed & {
      readonly _tag: 'FunctionReference'
      readonly kind: 'dso_local_equivalent' | 'no_cfi'
      readonly function: number
    })
  | (Typed & { readonly _tag: 'Cast'; readonly kind: CastKind; readonly value: number })
  | (Typed & {
      readonly _tag: 'Binary'
      readonly kind: BinaryKind
      readonly left: number
      readonly right: number
    })
  | (Typed & {
      readonly _tag: 'GetElementPtr'
      readonly sourceType: number
      readonly base: number
      readonly indices: ReadonlyArray<number>
      readonly inbounds: boolean
      readonly inrange: number | undefined
    })
  | (Typed & {
      readonly _tag: 'Assembly'
      readonly assembly: ByteString.ByteString
      readonly constraints: ByteString.ByteString
      readonly sideEffect: boolean
      readonly alignStack: boolean
      readonly intelDialect: boolean
      readonly canThrow: boolean
    })
