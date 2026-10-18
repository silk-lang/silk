import * as Emitter from '@silklang/llvm/Emitter'
import type * as NativeDiagnosticOutcome from './NativeDiagnosticOutcome.js'
import * as LlvmType from '@silklang/llvm/Type'
import type * as Value from '@silklang/llvm/Value'
import * as NativeDiagnosticDispatch from './NativeDiagnosticDispatch.js'
import * as NativeDiagnosticFailure from './NativeDiagnosticFailure.js'

/** One invocation's current lexical observer reference; never module or thread-local storage. */
export interface NativeDiagnosticContext {
  readonly builder: Emitter.Module
  readonly body: Emitter.Body
  readonly pointer: LlvmType.Type
  readonly byte: LlvmType.Type
  readonly word: LlvmType.Type
  readonly recordType: LlvmType.Type
  readonly callbackType: LlvmType.Type
  readonly current: Value.Input
  readonly causeType: LlvmType.Type
  readonly incomingObserver: Value.Input
  /** Borrowed input retained by the caller; copied by value, never a pointer to its stack slot. */
  readonly incomingCause: Value.Input
  readonly cause: Value.Input
  /**
   * Slots that provably hold their incoming argument wherever they are read, so reads use the
   * argument directly instead of loading the private, non-escaping slot.
   */
  readonly pinned: Pinning
  /** Outcome slots by local ordinal; `NativeDiagnosticOutcome.bind` assigns them once. */
  readonly outcomes: Map<number, NativeDiagnosticOutcome.NativeDiagnosticOutcome>
  /** Array whose consecutive elements are the outcome slots, in binding order. */
  readonly outcomeArray: { storage: Value.Input | undefined }
  /** Interned artifact-lifetime text shared by repeated sites in this function. */
  readonly literals: Map<string, readonly [Value.Input, Value.Input]>
  /** Callback dispatch invalidates cached source values at the enclosing operation join. */
  readonly sourceState: { dirty: boolean }
  /** The module's out-of-line observer dispatch shared by every event site. */
  readonly dispatch: NativeDiagnosticDispatch.NativeDiagnosticDispatch
}

export interface Pinning {
  observer: boolean
  cause: boolean
}

/** Creates the invocation-local slot initialized from the internal call ABI. */
export const make = (
  builder: Emitter.Module,
  body: Emitter.Body,
  pointer: LlvmType.Type,
  byte: LlvmType.Type,
  word: LlvmType.Type,
  dispatch: NativeDiagnosticDispatch.NativeDiagnosticDispatch,
  initial: Value.Input,
  initialCause?: Value.Input,
): NativeDiagnosticContext => {
  const causeType = NativeDiagnosticFailure.type({ builder, pointer, word })
  const recordType = Emitter.structureType(builder, [pointer, pointer, pointer, pointer, causeType])
  const callbackType = Emitter.functionType(builder, word, [
    pointer,
    pointer,
    byte,
    word,
    word,
    pointer,
    word,
    pointer,
    word,
  ])
  const current = Emitter.alloca(body, pointer, 'diagnostic_observer_slot')
  Emitter.store(body, initial, current)
  const incomingCause = initialCause ?? Emitter.nullValue(builder, causeType)
  const cause = Emitter.alloca(body, causeType, 'diagnostic_cause_slot')
  Emitter.store(body, incomingCause, cause)
  return {
    builder,
    body,
    pointer,
    byte,
    word,
    recordType,
    callbackType,
    current,
    causeType,
    incomingObserver: initial,
    incomingCause,
    cause,
    pinned: { observer: false, cause: false },
    outcomes: new Map<number, NativeDiagnosticOutcome.NativeDiagnosticOutcome>(),
    outcomeArray: { storage: undefined },
    literals: new Map<string, readonly [Value.Input, Value.Input]>(),
    sourceState: { dirty: false },
    dispatch,
  }
}

/**
 * Pins the slots that no lexical scope or recovery region of this invocation rewrites: such a slot
 * holds its incoming argument at every read outside an explicit `unpin` region.
 */
export const pin = (self: NativeDiagnosticContext, pinning: Pinning): void => {
  self.pinned.observer = pinning.observer
  self.pinned.cause = pinning.cause
}

/** Releases both pins for code that temporarily installs another observer or cause. */
export const unpin = (self: NativeDiagnosticContext): Pinning => {
  const previous = { ...self.pinned }
  pin(self, { observer: false, cause: false })
  return previous
}

/** Borrows the selected cause for a nested call without creating an owned reference. */
export const currentCause = (self: NativeDiagnosticContext): Value.Input =>
  self.pinned.cause
    ? self.incomingCause
    : Emitter.load(self.body, self.causeType, self.cause, 'diagnostic_cause')

/** Loads the observer selected at this call site, including any intervening lexical scope. */
export const current = (self: NativeDiagnosticContext): Value.Input =>
  self.pinned.observer
    ? self.incomingObserver
    : Emitter.load(self.body, self.pointer, self.current, 'diagnostic_observer')

/** Borrows the selected failure for terminal observation; unrelated or absent contexts stay silent. */
export const unhandled = (self: NativeDiagnosticContext) => {
  const failure = NativeDiagnosticFailure.unpack(self, currentCause(self))
  const selected = Emitter.integerCompare(
    self.body,
    'eq',
    Emitter.cast(
      self.body,
      'ptrtoint',
      failure.observer,
      self.word,
      'unhandled_cause_owner_address',
    ),
    Emitter.cast(
      self.body,
      'ptrtoint',
      current(self),
      self.word,
      'unhandled_current_observer_address',
    ),
    'unhandled_selected_observer',
  )
  return NativeDiagnosticFailure.unhandled(
    {
      ...failure,
      observer: Emitter.select(
        self.body,
        selected,
        failure.observer,
        Emitter.nullValue(self.builder, self.pointer),
        'unhandled_observer',
      ),
    },
    self,
  )
}

/** Addresses dispatch, state, captures, previous observer, or previous cause in a descriptor. */
export const field = (
  self: NativeDiagnosticContext,
  record: Value.Input,
  ordinal: 0 | 1 | 2 | 3 | 4,
) => {
  const index = Emitter.integerType(self.builder, 32)
  return Emitter.getElementPtr(self.body, self.recordType, record, [
    Emitter.integerUnsigned(self.builder, index, 0n),
    Emitter.integerUnsigned(self.builder, index, BigInt(ordinal)),
  ])
}

/** Dispatches to the observer that owns a retained context, independently of lexical selection. */
export const emitAt = (
  self: NativeDiagnosticContext,
  observer: Value.Input,
  event: 0 | 1 | 2 | 3 | 4 | 5 | 6,
  first: Value.Input,
  second: Value.Input,
  identity: readonly [Value.Input, Value.Input],
  origin: readonly [Value.Input, Value.Input],
) => {
  const handle = NativeDiagnosticDispatch.call(
    self.dispatch,
    self,
    observer,
    event,
    first,
    second,
    identity,
    origin,
  )
  self.sourceState.dirty = true
  return handle
}

/** Dispatches a semantic event to the current observer; disabled observation yields zero. */
export const emit = (
  self: NativeDiagnosticContext,
  event: 0 | 1 | 2 | 3 | 4 | 5 | 6,
  first: Value.Input,
  second: Value.Input,
  identity: readonly [Value.Input, Value.Input],
  origin: readonly [Value.Input, Value.Input],
) => {
  return emitAt(self, current(self), event, first, second, identity, origin)
}

/** Borrows the active cause only from the selected observer's pool for fatal reporting. */
export const fatal = (
  self: NativeDiagnosticContext,
  reason: readonly [Value.Input, Value.Input],
  origin: readonly [Value.Input, Value.Input],
) => {
  const observer = current(self)
  const cause = NativeDiagnosticFailure.unpack(self, currentCause(self))
  const zero = Emitter.integerUnsigned(self.builder, self.word, 0n)
  const selected = Emitter.select(
    self.body,
    Emitter.integerCompare(
      self.body,
      'eq',
      Emitter.cast(self.body, 'ptrtoint', observer, self.word, 'fatal_observer_address'),
      Emitter.cast(self.body, 'ptrtoint', cause.observer, self.word, 'fatal_cause_owner_address'),
      'fatal_cause_owner_matches',
    ),
    cause.handle,
    zero,
    'fatal_cause_handle',
  )
  return emitAt(self, observer, 6, selected, zero, reason, origin)
}
