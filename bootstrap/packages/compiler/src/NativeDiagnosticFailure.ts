import * as Emitter from '@silklang/llvm/Emitter'
import * as LlvmType from '@silklang/llvm/Type'
import type * as Value from '@silklang/llvm/Value'
import * as NativeDiagnosticContext from './NativeDiagnosticContext.js'

/** One owned diagnostic reference with immutable fallback metadata and its originating observer. */
export interface NativeDiagnosticFailure {
  readonly observer: Value.Input
  readonly handle: Value.Input
  readonly identity: readonly [Value.Input, Value.Input]
  readonly origin: readonly [Value.Input, Value.Input]
}

type Context = NativeDiagnosticContext.NativeDiagnosticContext

/** Metadata carries observer and static text addresses, independently of payload storage. */
export const type = (context: Pick<Context, 'builder' | 'pointer' | 'word'>): LlvmType.Type => {
  const { builder, pointer, word } = context
  return Emitter.structureType(builder, [pointer, word, pointer, word, pointer, word])
}

/** Serializes the value without retaining it; the caller must transfer, not duplicate, ownership. */
export const pack = (self: NativeDiagnosticFailure, context: Context) => {
  return Emitter.buildAggregate(
    context.body,
    type(context),
    [self.observer, self.handle, ...self.identity, ...self.origin],
    'diagnostic_failure',
  )
}

/** Restores transferred metadata without interpreting the opaque source handle. */
export const unpack = (context: Context, value: Value.Input): NativeDiagnosticFailure => {
  const field = (ordinal: number) => {
    return Emitter.extractValue(context.body, value, [ordinal], `diagnostic_failure${ordinal}`)
  }
  return {
    observer: field(0),
    handle: field(1),
    identity: [field(2), field(3)] as const,
    origin: [field(4), field(5)] as const,
  }
}

/** Produces one optional source context; identity and origin survive a refused allocation. */
export const produce = (
  context: Context,
  identity: NativeDiagnosticFailure['identity'],
  origin: NativeDiagnosticFailure['origin'],
): NativeDiagnosticFailure => {
  const observer = NativeDiagnosticContext.current(context)
  const zero = Emitter.integerUnsigned(context.builder, context.word, 0n)
  const handle = NativeDiagnosticContext.emitAt(context, observer, 0, zero, zero, identity, origin)
  return { observer, handle, identity, origin }
}

const emptyText = (context: Context) => {
  return [
    Emitter.nullValue(context.builder, context.pointer),
    Emitter.integerUnsigned(context.builder, context.word, 0n),
  ] as const
}

/** Returns another owned reference while preserving the borrowed input and fallback metadata. */
export const retain = (self: NativeDiagnosticFailure, context: Context) => {
  const text = emptyText(context)
  const handle = NativeDiagnosticContext.emitAt(
    context,
    self.observer,
    3,
    self.handle,
    text[1],
    text,
    text,
  )
  return { ...self, handle }
}

/** Consumes exactly one reference through its originating observer, including a zero handle. */
export const release = (self: NativeDiagnosticFailure, context: Context) => {
  const text = emptyText(context)
  NativeDiagnosticContext.emitAt(context, self.observer, 4, self.handle, text[1], text, text)
}

/** Creates an immutable replacement with a caller frame; the original remains owned by the caller. */
export const propagate = (
  self: NativeDiagnosticFailure,
  context: Context,
  frame: NativeDiagnosticFailure['identity'],
) => {
  const text = emptyText(context)
  const handle = NativeDiagnosticContext.emitAt(
    context,
    self.observer,
    1,
    self.handle,
    text[1],
    frame,
    text,
  )
  return { ...self, handle }
}

/** Combines borrowed contexts from one observer without consuming either input. */
export const withCause = (
  self: NativeDiagnosticFailure,
  context: Context,
  cause: NativeDiagnosticFailure,
) => {
  const { body, word } = context
  const accepted = Emitter.block(body, 'diagnostic_cause_owner')
  const invalid = Emitter.block(body, 'diagnostic_cause_invalid_owner')
  Emitter.conditionalBranch(
    body,
    Emitter.integerCompare(
      body,
      'eq',
      Emitter.cast(body, 'ptrtoint', self.observer, word, 'diagnostic_primary_owner'),
      Emitter.cast(body, 'ptrtoint', cause.observer, word, 'diagnostic_cause_owner'),
    ),
    accepted,
    invalid,
  )
  Emitter.setInsertionPoint(body, invalid)
  // A source handle is meaningful only to its originating observer. Crossing this boundary
  // is a compiler ownership defect; never pass another pool's handle to the callback.
  Emitter.intrinsicCall(body, 'trap', [], [])
  Emitter.unreachable(body)
  Emitter.setInsertionPoint(body, accepted)
  const text = emptyText(context)
  const handle = NativeDiagnosticContext.emitAt(
    context,
    self.observer,
    2,
    self.handle,
    cause.handle,
    text,
    text,
  )
  return { ...self, handle }
}

/** Observes a borrowed selected failure after payload cleanup; the caller still owns its handle. */
export const unhandled = (self: NativeDiagnosticFailure, context: Context) => {
  return NativeDiagnosticContext.emitAt(
    context,
    self.observer,
    5,
    self.handle,
    Emitter.integerUnsigned(context.builder, context.word, 0n),
    self.identity,
    self.origin,
  )
}
