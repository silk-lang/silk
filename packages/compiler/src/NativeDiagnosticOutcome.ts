import * as Emitter from '@silklang/llvm/Emitter'
import type * as Value from '@silklang/llvm/Value'
import * as NativeDiagnosticFailure from './NativeDiagnosticFailure.js'
import type * as NativeValue from './NativeValue.js'
import type * as NativeResult from './NativeResult.js'
import type * as Mir from './Mir.js'
import * as NativeDiagnosticContext from './NativeDiagnosticContext.js'

/** Independent storage for an outcome's owned metadata, never for its source payload. */
export interface NativeDiagnosticOutcome {
  readonly storage: Value.Input
}

type Context = NativeDiagnosticContext.NativeDiagnosticContext

/** Replaces an owned failure with an outward frame while preserving its immutable identity. */
export const propagate = (
  self: NativeDiagnosticOutcome,
  context: Context,
  frame: NativeDiagnosticFailure.NativeDiagnosticFailure['identity'],
) => {
  const failure = NativeDiagnosticFailure.unpack(context, borrow(self, context))
  const propagated = NativeDiagnosticFailure.propagate(failure, context, frame)
  replace(self, context, NativeDiagnosticFailure.pack(propagated, context))
}

/** Produces a failure and attaches the selected same-observer recovery cause, if present. */
export const produce = (
  self: NativeDiagnosticOutcome,
  context: Context,
  identity: NativeDiagnosticFailure.NativeDiagnosticFailure['identity'],
  origin: NativeDiagnosticFailure.NativeDiagnosticFailure['origin'],
) => {
  const failure = NativeDiagnosticFailure.produce(context, identity, origin)
  const cause = NativeDiagnosticFailure.unpack(
    context,
    NativeDiagnosticContext.currentCause(context),
  )
  const owner = Emitter.cast(
    context.body,
    'ptrtoint',
    failure.observer,
    context.word,
    'produced_observer',
  )
  const causeOwner = Emitter.cast(
    context.body,
    'ptrtoint',
    cause.observer,
    context.word,
    'produced_cause_observer',
  )
  const attach = Emitter.block(context.body, 'produced_with_cause')
  const plain = Emitter.block(context.body, 'produced_without_cause')
  const following = Emitter.block(context.body, 'produced_complete')
  const sameOwner = Emitter.integerCompare(
    context.body,
    'eq',
    owner,
    causeOwner,
    'produced_same_observer',
  )
  const observed = Emitter.integerCompare(
    context.body,
    'ne',
    owner,
    Emitter.integerUnsigned(context.builder, context.word, 0n),
    'produced_observed',
  )
  Emitter.conditionalBranch(
    context.body,
    Emitter.binary(context.body, 'and', sameOwner, observed, 'produced_has_cause'),
    attach,
    plain,
  )
  Emitter.setInsertionPoint(context.body, attach)
  const attached = NativeDiagnosticFailure.withCause(failure, context, cause)
  NativeDiagnosticFailure.release(failure, context)
  replace(self, context, NativeDiagnosticFailure.pack(attached, context))
  Emitter.branch(context.body, following)
  Emitter.setInsertionPoint(context.body, plain)
  replace(self, context, NativeDiagnosticFailure.pack(failure, context))
  Emitter.branch(context.body, following)
  Emitter.setInsertionPoint(context.body, following)
}

/** Transfers a complete call result into its owning local before exposing its logical payload. */
export const accept = (
  context: Context | undefined,
  local: Mir.LocalId,
  result: NativeResult.Received,
): NativeValue.NativeValue => {
  const outcome = context?.outcomes.get(local.ordinal)
  if (result.diagnostic !== undefined) {
    if (context === undefined || outcome === undefined)
      throw new RangeError('Native call result lost its diagnostic outcome owner')
    replace(outcome, context, result.diagnostic)
  } else if (context !== undefined && outcome !== undefined) release(outcome, context)
  return 'place' in result ? result.place : { _tag: 'Direct', values: result.values }
}

/** Releases a completed recovery's owned local; unobserved functions have no metadata storage. */
export const releaseLocal = (context: Context | undefined, local: Mir.LocalId) => {
  if (context === undefined) return
  const outcome = context.outcomes.get(local.ordinal)
  if (outcome === undefined) throw new RangeError('Recovery lost its owned diagnostic outcome')
  release(outcome, context)
}

/** Consumes metadata when an independent execution delivers its payload to its outcome callback. */
export const consume = (context: Context | undefined, result: NativeResult.NativeResult) => {
  if (result.diagnostic !== undefined) {
    if (context === undefined)
      throw new RangeError('Native outcome consumption lost its diagnostic context')
    NativeDiagnosticFailure.release(
      NativeDiagnosticFailure.unpack(context, result.diagnostic),
      context,
    )
  }
  return result.values
}

/** Initializes newly acquired storage; resuming an existing frame must not call this. */
export const initialize = (self: NativeDiagnosticOutcome, context: Context) => {
  Emitter.store(context.body, Emitter.nullValue(context.builder, context.causeType), self.storage)
}

/** Borrows the metadata while the slot retains ownership. */
export const borrow = (self: NativeDiagnosticOutcome, context: Context) => {
  return Emitter.load(context.body, context.causeType, self.storage, 'outcome_diagnostic')
}

/** Moves the reference out and clears ownership before any source callback can execute. */
export const take = (self: NativeDiagnosticOutcome, context: Context) => {
  const value = borrow(self, context)
  initialize(self, context)
  return value
}

/** Publishes a transferred reference, then releases the old reference through its own observer. */
export const replace = (self: NativeDiagnosticOutcome, context: Context, value: Value.Input) => {
  const previous = take(self, context)
  Emitter.store(context.body, value, self.storage)
  NativeDiagnosticFailure.release(NativeDiagnosticFailure.unpack(context, previous), context)
}

/** Clears ownership before releasing the reference; empty slots perform no observer callback. */
export const release = (self: NativeDiagnosticOutcome, context: Context) => {
  const previous = take(self, context)
  NativeDiagnosticFailure.release(NativeDiagnosticFailure.unpack(context, previous), context)
}

/** Releases references owned by a lexical observer before that observer's state is destroyed. */
export const releaseForObserver = (
  self: NativeDiagnosticOutcome,
  context: Context,
  observer: Value.Input,
) => {
  const value = borrow(self, context)
  const owner = Emitter.extractValue(context.body, value, [0], 'outcome_observer')
  const selected = Emitter.block(context.body, 'outcome_release_selected')
  const following = Emitter.block(context.body, 'outcome_release_following')
  Emitter.conditionalBranch(
    context.body,
    Emitter.integerCompare(
      context.body,
      'eq',
      Emitter.cast(context.body, 'ptrtoint', owner, context.word, 'outcome_owner_address'),
      Emitter.cast(context.body, 'ptrtoint', observer, context.word, 'outcome_scope_address'),
    ),
    selected,
    following,
  )
  Emitter.setInsertionPoint(context.body, selected)
  release(self, context)
  Emitter.branch(context.body, following)
  Emitter.setInsertionPoint(context.body, following)
}
