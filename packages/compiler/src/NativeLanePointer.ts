import * as Emitter from '@silklang/llvm/Emitter'
import type * as LlvmType from '@silklang/llvm/Type'
import type * as Value from '@silklang/llvm/Value'

export interface Context {
  readonly byteType: LlvmType.Type
  readonly offsetType: LlvmType.Type
}

/** Projects one byte-addressed native lane from a base pointer. */
export const lanePointer = (
  self: Context,
  body: Emitter.Body,
  base: Value.Input,
  offset: number | Value.Input,
  name: string,
) => {
  const index =
    typeof offset === 'number'
      ? Emitter.integerUnsigned(body, self.offsetType, BigInt(offset))
      : offset
  return Emitter.getElementPtr(body, self.byteType, base, [index], name)
}
