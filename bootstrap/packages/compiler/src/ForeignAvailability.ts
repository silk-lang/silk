/** Availability and signature coherence for reachable foreign C functions and data. */
import * as CAbi from './CAbi.js'
import * as Diagnostic from './Diagnostic.js'
import type * as Instances from './Instances.js'
import type * as Mir from './Mir.js'
import * as MirVerification from './MirVerification.js'
import type * as SourceSpan from './SourceSpan.js'
import type * as Target from './Target.js'

/** One reachable conversion whose generated export thunk supplies a raw C function address. */
export interface CallbackAddress {
  readonly symbol: string
  readonly span: SourceSpan.SourceSpan
}

/** One reachable MIR load of a C data symbol. */
export interface StaticLoad {
  readonly symbol: string
  readonly span: SourceSpan.SourceSpan
}

/** Collects callback-address operations in deterministic MIR function/operation order. */
export const callbackAddresses = (program: Mir.Module): ReadonlyArray<CallbackAddress> =>
  program.functions.flatMap((fn) =>
    MirVerification.operations(fn).flatMap((operation) =>
      operation._tag === 'ForeignFunctionAddress'
        ? [{ symbol: operation.symbol, span: operation.provenance.span }]
        : [],
    ),
  )

/** Collects reachable data-symbol loads in deterministic MIR function/operation order. */
export const staticLoads = (program: Mir.Module): ReadonlyArray<StaticLoad> =>
  program.functions.flatMap((fn) =>
    MirVerification.operations(fn).flatMap((operation) =>
      operation._tag === 'ForeignStaticLoad'
        ? [{ symbol: operation.symbol, span: operation.provenance.span }]
        : [],
    ),
  )

/**
 * Rejects LLVM emission of a non-native target (one diagnostic per symbol at its first call) and
 * every pair of reachable declarations of one symbol whose classified C signatures differ.
 */
export const select = (
  calls: ReadonlyArray<Instances.ForeignCall>,
  target: Target.Target,
  statics: Mir.Module['foreignStatics'] = [],
  callbacks: ReadonlyArray<CallbackAddress> = [],
  loads: ReadonlyArray<StaticLoad> = [],
): ReadonlyArray<Diagnostic.Diagnostic> => {
  if (calls.length === 0 && statics.length === 0 && callbacks.length === 0 && loads.length === 0)
    return []
  const native = target.kind === 'Native'
  const surface = target.id
  const unavailable = new Map<string, Diagnostic.Diagnostic>()
  for (const call of calls) {
    if (!CAbi.available(target, call.signature))
      if (!unavailable.has(call.symbol))
        unavailable.set(
          call.symbol,
          Diagnostic.foreignFunctionTargetUnavailable(call.symbol, surface, call.callSpan),
        )
  }
  if (!native) {
    for (const callback of callbacks) {
      if (!unavailable.has(callback.symbol)) {
        unavailable.set(
          callback.symbol,
          Diagnostic.foreignFunctionTargetUnavailable(callback.symbol, surface, callback.span),
        )
      }
    }
  }
  if (!native) {
    for (const record of statics) {
      if (!unavailable.has(record.symbol)) {
        unavailable.set(
          record.symbol,
          Diagnostic.foreignStaticTargetUnavailable(record.symbol, surface, record.declarationSpan),
        )
      }
    }
    for (const load of loads) {
      if (!unavailable.has(load.symbol)) {
        unavailable.set(
          load.symbol,
          Diagnostic.foreignStaticTargetUnavailable(load.symbol, surface, load.span),
        )
      }
    }
  }
  const conflicts: Array<Diagnostic.Diagnostic> = []
  for (const [ordinal, call] of calls.entries())
    for (const other of calls.slice(ordinal + 1))
      if (
        other.symbol === call.symbol &&
        CAbi.signatureKey(other.signature) !== CAbi.signatureKey(call.signature)
      )
        conflicts.push(
          Diagnostic.conflictingForeignSignature(
            call.symbol,
            other.declarationSpan,
            call.declarationSpan,
          ),
        )
  return Diagnostic.merge([...unavailable.values()], conflicts)
}
