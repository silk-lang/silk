import type * as ByteString from '../ByteString.js'

export type Description =
  | { readonly _tag: 'Flag'; readonly name: ByteString.ByteString }
  | {
      readonly _tag: 'Integer'
      readonly name: ByteString.ByteString
      readonly value: bigint
    }
  | { readonly _tag: 'Type'; readonly name: ByteString.ByteString; readonly type: number }
  | {
      readonly _tag: 'String'
      readonly name: ByteString.ByteString
      readonly value: ByteString.ByteString
    }
  | {
      readonly _tag: 'IntegerList'
      readonly name: ByteString.ByteString
      readonly values: ReadonlyArray<bigint>
    }

export interface FunctionSetDescription {
  readonly functionAttributes: number
  readonly returnAttributes: number
  readonly parameterAttributes: ReadonlyArray<number>
}
