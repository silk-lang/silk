import type * as AddrSpace from '../AddrSpace.js'
import type * as ByteString from '../ByteString.js'

export type SimpleTag =
  | 'Void'
  | 'Half'
  | 'BFloat'
  | 'Float'
  | 'Double'
  | 'X86Fp80'
  | 'Fp128'
  | 'PpcFp128'
  | 'Label'
  | 'Metadata'
  | 'X86Amx'
  | 'Token'

export type Description =
  | { readonly _tag: 'Simple'; readonly tag: SimpleTag }
  | { readonly _tag: 'Integer'; readonly bitWidth: number }
  | { readonly _tag: 'Pointer'; readonly addressSpace: AddrSpace.AddrSpace }
  | {
      readonly _tag: 'Function'
      readonly returnType: number
      readonly parameters: ReadonlyArray<number>
      readonly variadic: boolean
    }
  | {
      readonly _tag: 'Vector'
      readonly child: number
      readonly length: number
      readonly scalable: boolean
    }
  | { readonly _tag: 'Array'; readonly child: number; readonly length: bigint }
  | {
      readonly _tag: 'Structure'
      readonly fields: ReadonlyArray<number>
      readonly packed: boolean
    }
  | {
      readonly _tag: 'NamedStructure'
      readonly name: ByteString.ByteString
      readonly body:
        | { readonly fields: ReadonlyArray<number>; readonly packed: boolean }
        | undefined
    }
  | {
      readonly _tag: 'TargetExtension'
      readonly name: ByteString.ByteString
      readonly types: ReadonlyArray<number>
      readonly integers: ReadonlyArray<bigint>
    }
