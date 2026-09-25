import * as Emitter from '@silklang/llvm/Emitter'
import type * as Value from '@silklang/llvm/Value'
import type * as Mir from './Mir.js'
import type * as NativeLoweringContext from './NativeLoweringContext.js'
import type * as NativeSuspension from './NativeSuspension.js'
import * as NativeReturn from './NativeReturn.js'
import * as NativeType from './NativeType.js'
import * as NativeDiagnosticOutcome from './NativeDiagnosticOutcome.js'
import * as NativeDiagnosticText from './NativeDiagnosticText.js'
import * as NativeTermination from './NativeTermination.js'

/** Failure-return state for allocation boundaries. */
export interface Context {
  readonly builder: Emitter.Module
  readonly body: Emitter.Body
  readonly entry: NativeLoweringContext.DeclaredFunction
  readonly types: NativeType.LoweringContext
  readonly suspension: NativeSuspension.ReturnContext
  readonly termination: NativeTermination.FunctionContext
}

/** Emits one host-boundary failure in the function's synchronous or suspension ABI. */
export const emit = (
  context: Context,
  operation: Extract<Mir.Operation, { readonly _tag: 'Allocate' }>,
): void => {
  const lanes = NativeType.lanesFor(context.types, operation.propagationType)
  const values: Array<Value.Input> = []
  for (const [ordinal, lane] of lanes.entries()) {
    values.push(
      Emitter.integerUnsigned(
        context.builder,
        NativeType.laneType(context.types, lane),
        ordinal === 0 ? BigInt(operation.failureTag) : 0n,
      ),
    )
  }
  let metadata: Value.Input | undefined
  if (context.entry.diagnosticResult !== undefined) {
    const diagnostic = context.suspension.diagnostic
    if (diagnostic === undefined)
      throw new RangeError('Allocation failure lost its diagnostic context')
    // Allocation refusal returns immediately. This stack slot cannot survive a suspension
    // or escape the invocation; the completed result takes its reference before cleanup.
    const outcome = {
      storage: Emitter.alloca(
        context.body,
        diagnostic.causeType,
        `allocation_failure${operation.destination.ordinal}`,
      ),
    }
    NativeDiagnosticOutcome.initialize(outcome, diagnostic)
    NativeDiagnosticOutcome.produce(
      outcome,
      diagnostic,
      NativeDiagnosticText.literal(
        diagnostic,
        NativeTermination.identityOf(operation.propagationType.type, operation.failureTag),
        `${context.entry.symbol}.allocation${operation.destination.ordinal}.identity`,
      ),
      NativeDiagnosticText.literal(
        diagnostic,
        NativeDiagnosticText.origin(
          context.termination.module,
          context.entry.fn,
          operation.provenance.span,
        ),
        `${context.entry.symbol}.allocation${operation.destination.ordinal}.origin`,
      ),
    )
    metadata = NativeDiagnosticOutcome.take(outcome, diagnostic)
  }
  NativeReturn.completeResult(
    context.suspension,
    { values: values, ...(metadata === undefined ? {} : { diagnostic: metadata }) },
    `host_failure${operation.destination.ordinal}`,
  )
}
