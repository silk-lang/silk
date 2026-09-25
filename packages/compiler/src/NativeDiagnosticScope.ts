import * as Emitter from '@silklang/llvm/Emitter'
import * as NativeDiagnosticOutcome from './NativeDiagnosticOutcome.js'
import * as FunctionIndex from './internal/FunctionIndex.js'
import * as FunctionActor from '@silklang/llvm/Function'
import * as Value from '@silklang/llvm/Value'
import * as Mir from './Mir.js'
import * as NativeCallable from './NativeCallable.js'
import * as NativeDiagnosticContext from './NativeDiagnosticContext.js'
import type * as NativeLoweringContext from './NativeLoweringContext.js'
import type * as NativeOperationContext from './NativeOperationContext.js'
import * as NativeStorage from './NativeStorage.js'
import * as NativePlace from './NativePlace.js'

export interface NativeDiagnosticScope {
  readonly record: Value.Input
  readonly callback: FunctionActor.Function
}

interface Context extends NativeCallable.Context {
  readonly builder: Emitter.Module
  readonly entry: NativeLoweringContext.DeclaredFunction
  readonly declared: ReadonlyArray<NativeLoweringContext.DeclaredFunction>
  readonly diagnostic: NativeDiagnosticContext.NativeDiagnosticContext
}

/** Preallocates synchronous descriptors and adapters borrowing the represented callback owner. */
export const prepare = (context: Context) => {
  const { builder, body, entry, diagnostic } = context
  const scopes = new Map<number, NativeDiagnosticScope>()
  for (const operation of entry.linear.flatMap((block) => block.operations)) {
    if (operation._tag !== 'EnterDiagnosticScope') continue
    const type = entry.fn.localTypes.at(operation.observer.ordinal)
    if (type?._tag !== 'CallableValue' || type.target?._tag !== 'DeclarationCallableTarget')
      throw new RangeError('Diagnostic observer lost its declared callable identity')
    const targetId = type.target.declaration
    const arguments_ =
      type.environment?.callable.typeArguments ??
      type.storage?.realization.targetArguments ??
      type.typeArguments ??
      []
    const target = FunctionIndex.nativeCandidates(context.declared, targetId).find((candidate) =>
      Mir.matchesInstance(candidate.fn, targetId, arguments_),
    )
    if (target === undefined || target.suspendable || target.diagnosticParameter === undefined)
      throw new RangeError('Diagnostic observer lost its direct internal target')
    const callback = Emitter.declareFunction(
      builder,
      `${entry.symbol}$diagnostic${operation.scope.ordinal}`,
      diagnostic.callbackType,
      { linkage: 'internal' },
    )
    Emitter.buildBody(builder, callback, (callbackBody) => {
      Emitter.block(callbackBody, 'entry')
      const environment = Emitter.argument(callbackBody, 0)
      const values = NativePlace.loadLanes(
        NativePlace.make(context.program.layout, type, environment),
        { ...context, body: callbackBody },
        'observer_capture',
      )
      const groups = NativeCallable.capturedArguments(
        { ...context, body: callbackBody },
        type,
        values,
        'observer',
      )
      const arguments_: Array<ReadonlyArray<Value.Input>> = []
      for (const ordinals of [[1], [2], [3], [4], [5, 6], [7, 8]])
        arguments_.push(Array.from(ordinals, (ordinal) => Emitter.argument(callbackBody, ordinal)))
      const operands = Mir.applyOperands(
        groups.map((group) => ({
          parameterOrdinal: group.parameterOrdinal,
          items: group.values,
        })),
        arguments_,
      )
      if (operands.length !== target.diagnosticParameter)
        throw new RangeError('Diagnostic callback adapter lost its source argument lanes')
      const result = Emitter.callDirect(
        callbackBody,
        target.handle,
        [
          ...operands,
          Emitter.nullValue(builder, diagnostic.pointer),
          Emitter.nullValue(builder, diagnostic.causeType),
        ],
        'observer_result',
      )
      if (result === undefined) throw new RangeError('Diagnostic callback returned no handle')
      Emitter.returnValue(callbackBody, result)
    })
    scopes.set(operation.scope.ordinal, {
      record: entry.suspendable
        ? Emitter.nullValue(builder, diagnostic.pointer)
        : Emitter.alloca(body, diagnostic.recordType, `diagnostic_scope${operation.scope.ordinal}`),
      callback,
    })
  }
  return scopes
}

/** Installs or leaves one lexical descriptor without moving the state owner out of its storage. */
export const emit = (
  context: NativeOperationContext.Context,
  operation: Extract<
    import('./MirLinearization.js').LinearOperation,
    { readonly _tag: 'EnterDiagnosticScope' | 'LeaveDiagnosticScope' }
  >,
) => {
  const diagnostic = context.termination.diagnostic
  const scope = context.diagnosticScopes.get(operation.scope.ordinal)
  if (diagnostic === undefined || scope === undefined)
    throw new RangeError('Diagnostic scope lost its invocation storage')
  const { body, builder } = context
  if (operation._tag === 'LeaveDiagnosticScope') {
    for (const outcome of diagnostic.outcomes.values())
      NativeDiagnosticOutcome.releaseForObserver(outcome, diagnostic, scope.record)

    Emitter.store(
      body,
      Emitter.load(
        body,
        diagnostic.pointer,
        NativeDiagnosticContext.field(diagnostic, scope.record, 3),
      ),
      diagnostic.current,
    )
    Emitter.store(
      body,
      Emitter.load(
        body,
        diagnostic.causeType,
        NativeDiagnosticContext.field(diagnostic, scope.record, 4),
      ),
      diagnostic.cause,
    )
    return
  }
  NativeStorage.ensureAddressRoot(context.storage, operation.state)
  const state = NativeStorage.addressOf(context.storage, operation.state)
  NativeStorage.ensureAddressRoot(context.storage, operation.observer)
  const captures = NativeStorage.addressOf(context.storage, operation.observer)
  const fields = [
    Emitter.fromGlobal(builder, Emitter.functionGlobal(builder, scope.callback)),
    state,
    captures,
    NativeDiagnosticContext.current(diagnostic),
    NativeDiagnosticContext.currentCause(diagnostic),
  ]
  for (const ordinal of [0, 1, 2, 3, 4] as const) {
    const value = fields.at(ordinal)
    if (value === undefined) throw new RangeError('Diagnostic descriptor lost a field')
    Emitter.store(body, value, NativeDiagnosticContext.field(diagnostic, scope.record, ordinal))
  }
  Emitter.store(body, scope.record, diagnostic.current)
}
