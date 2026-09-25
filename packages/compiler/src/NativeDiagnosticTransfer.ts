import * as Emitter from '@silklang/llvm/Emitter'
import * as LlvmType from '@silklang/llvm/Type'
import type * as Value from '@silklang/llvm/Value'
import * as ContinuationTransfer from './ContinuationTransfer.js'

/** The private transfer's completed-result slot has one producer and one consuming continuation. */
export interface NativeDiagnosticTransfer {
  readonly builder: Emitter.Module
  readonly body: Emitter.Body
  readonly wordSize: number
  readonly transfer: Value.Input
}

const address = (self: NativeDiagnosticTransfer) => {
  return Emitter.getElementPtr(
    self.body,
    Emitter.integerType(self.builder, 8),
    self.transfer,
    [
      Emitter.integerUnsigned(
        self.builder,
        Emitter.integerType(self.builder, 32),
        BigInt(ContinuationTransfer.diagnosticResultOffset(self.wordSize)),
      ),
    ],
    'transfer_diagnostic_ptr',
  )
}

/** Publishes a transferred reference after its predecessor has been consumed. */
export const publish = (self: NativeDiagnosticTransfer, value: Value.Input) => {
  Emitter.store(self.body, value, address(self))
}

/** Moves completed metadata out before another child or resumed frame can publish a result. */
export const take = (self: NativeDiagnosticTransfer, type: LlvmType.Type) => {
  const storage = address(self)
  const value = Emitter.load(self.body, type, storage, 'transfer_diagnostic')
  Emitter.store(self.body, Emitter.nullValue(self.builder, type), storage)
  return value
}
