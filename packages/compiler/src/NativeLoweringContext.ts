import * as Emitter from '@silklang/llvm/Emitter'
import type * as FunctionActor from '@silklang/llvm/Function'
import type * as LlvmType from '@silklang/llvm/Type'
import type * as Value from '@silklang/llvm/Value'
import type * as Backend from './Backend.js'
import type * as Layout from './Layout.js'
import type * as Mir from './Mir.js'
import type * as MirLinearization from './MirLinearization.js'
import type * as NativeResult from './NativeResult.js'
import type * as NativeArgument from './NativeArgument.js'

/** One declared MIR function and its fixed native ABI ownership. */
export interface DeclaredFunction {
  readonly fn: Mir.MirFunction
  readonly symbol: string
  readonly publicSymbol: string
  readonly handle: FunctionActor.Function
  readonly resultType: LlvmType.Type
  readonly emittedResultType: LlvmType.Type
  readonly resultLaneCount: number
  readonly resultStorage?: NativeResult.Storage
  /** Owned failure metadata follows the source result lanes in the private ABI. */
  readonly diagnosticResult?: LlvmType.Type
  readonly suspendable: boolean
  /**
   * Synchronous-signature entry that drives a suspendable function to completion. Present for
   * every suspendable function: the machine entry exposes it under the public symbol, and an
   * ordinary `Call` from a synchronous boundary reaches the suspendable target through it.
   */
  readonly driver?: FunctionActor.Function
  readonly parameterTypes: ReadonlyArray<LlvmType.Type>
  readonly argumentParameters: ReadonlyArray<NativeArgument.Parameter>
  /** Physical observer parameter, followed by a borrowed cause, optional result storage, and suspension lanes. */
  readonly diagnosticParameter?: number
  readonly linear: ReadonlyArray<MirLinearization.LinearBlock>
}

/** Explicit native lowering state shared by the per-function lowering actors. */
export interface LoweringContext {
  readonly builder: Emitter.Module
  readonly body: Emitter.Body
  readonly program: Mir.Module
  readonly request: Backend.CodegenRequest
  readonly layout: Layout.Plan
  readonly types: {
    readonly i8: LlvmType.Type
    readonly i32: LlvmType.Type
    readonly f32: LlvmType.Type
    readonly f64: LlvmType.Type
    readonly pointer: LlvmType.Type
    readonly integers: ReadonlyMap<number, LlvmType.Type>
  }
  readonly lanesFor: (type: Mir.Type) => ReadonlyArray<Layout.CallingLane>
  readonly valueLanesFor: (type: Mir.Type) => ReadonlyArray<Layout.CallingLane>
  readonly laneType: (lane: Layout.CallingLane) => LlvmType.Type
  readonly packedLanes: (
    lanes: ReadonlyArray<Layout.CallingLane>,
    start?: number,
  ) => {
    readonly entries: ReadonlyArray<{ readonly lane: Layout.CallingLane; readonly offset: number }>
    readonly end: number
    readonly alignment: number
  }
  readonly declared: ReadonlyArray<DeclaredFunction>
  readonly entry: DeclaredFunction
  readonly mutableStorage: ReadonlyMap<number, ReadonlyArray<Value.Input>>
}
