import * as Emitter from '@silklang/llvm/Emitter'
import * as NativeDiagnosticText from './NativeDiagnosticText.js'
import * as NativeDiagnosticOutcome from './NativeDiagnosticOutcome.js'
import * as LlvmBlock from '@silklang/llvm/Block'
import * as FunctionBody from '@silklang/llvm/FunctionBody'
import { type CodegenRequest, type LineTable, symbolFor } from './Backend.js'
import type * as Mir from './Mir.js'
import type * as SourceSpan from './SourceSpan.js'
import * as Type from './Type.js'
import * as NativeDiagnosticContext from './NativeDiagnosticContext.js'

/** Source line lookup and semantic trap sites used while emitting lexical diagnostics. */
export interface ModuleContext {
  readonly trapSites: Array<{ readonly reason: string; readonly origin: string }>
  readonly tables: Map<string, LineTable>
  readonly sources: ReadonlyMap<string, Uint8Array> | undefined
}

/** One lazily filled trap block: the site it reports before trapping. */
export interface TrapState {
  readonly trapBlocks: Array<{ readonly block: LlvmBlock.Block; readonly site: number }>
}

/** Per-function view over the module tables. */
export interface FunctionContext {
  readonly module: ModuleContext
  readonly body: Emitter.Body
  readonly fn: Mir.MirFunction
  readonly state: TrapState
  readonly diagnostic?: NativeDiagnosticContext.NativeDiagnosticContext
}

export const make = (request: CodegenRequest): ModuleContext => ({
  trapSites: [],
  tables: new Map(),
  sources: request.sources,
})

/** Canonical identity of one failure member of an Effect outcome type. */
export const identityOf = (type: Type.Effect | Type.FailureRow, tag: number): string => {
  const failure = Type.failureMembers(type).at(tag - 1)
  if (failure === undefined) throw new RangeError(`Effect failure tag ${tag} has no type identity`)
  return Type.encode(failure)
}

/** A failure propagated out of this function: append its frame to the path. */
export const storePropagated = (
  context: FunctionContext,
  outcome: Mir.LocalId,
  span: SourceSpan.SourceSpan,
): void => {
  if (context.diagnostic !== undefined) {
    const slot = context.diagnostic.outcomes.get(outcome.ordinal)
    if (slot === undefined) throw new RangeError('Failure propagation lost its diagnostic outcome')
    NativeDiagnosticOutcome.propagate(
      slot,
      context.diagnostic,
      NativeDiagnosticText.literal(
        context.diagnostic,
        NativeDiagnosticText.origin(context.module, context.fn, span),
        `${symbolFor(context.fn)}.propagate${outcome.ordinal}.${span.start}.frame`,
      ),
    )
  }
}

/** Creates the block a checked operation branches to when its trap condition holds. */
export const trapBlock = (
  context: FunctionContext,
  reason: string,
  span: SourceSpan.SourceSpan,
): LlvmBlock.Block => {
  let site = 0
  if (context.diagnostic !== undefined) {
    context.module.trapSites.push({
      reason,
      origin: NativeDiagnosticText.origin(context.module, context.fn, span),
    })
    site = context.module.trapSites.length
  }
  const block = Emitter.block(context.body, `trap_site${site}`)
  context.state.trapBlocks.push({ block, site })
  return block
}

/** Delivers the trap site to the lexical source observer before the machine trap. */
const reportTrap = (context: FunctionContext, site: number): void => {
  if (site === 0) return
  const diagnostic = context.diagnostic
  if (diagnostic !== undefined) {
    const entry = context.module.trapSites.at(site - 1)
    if (entry === undefined) throw new RangeError('Diagnostic trap lost its semantic site')
    NativeDiagnosticContext.fatal(
      diagnostic,
      NativeDiagnosticText.literal(diagnostic, entry.reason, `silk.diagnostic.trap${site}.reason`),
      NativeDiagnosticText.literal(diagnostic, entry.origin, `silk.diagnostic.trap${site}.origin`),
    )
    return
  }
}

/** Fills every trap block registered while lowering the function body. */
export const emitTrapBlocks = (context: FunctionContext): void => {
  for (const { block, site } of context.state.trapBlocks) {
    Emitter.setInsertionPoint(context.body, block)
    reportTrap(context, site)
    Emitter.intrinsicCall(context.body, 'trap', [], [])
    Emitter.unreachable(context.body)
  }
}

/** Emits a report call followed by the trap for a terminator that traps unconditionally. */
export const emitTrap = (
  context: FunctionContext,
  reason: string,
  span: SourceSpan.SourceSpan,
): FunctionBody.Instruction => {
  if (context.diagnostic !== undefined) {
    context.module.trapSites.push({
      reason,
      origin: NativeDiagnosticText.origin(context.module, context.fn, span),
    })
    reportTrap(context, context.module.trapSites.length)
  }
  Emitter.intrinsicCall(context.body, 'trap', [], [])
  return Emitter.unreachable(context.body)
}
