import * as Emitter from '@silklang/llvm/Emitter'
import type * as Constant from '@silklang/llvm/Constant'
import type * as FunctionActor from '@silklang/llvm/Function'
import type * as LlvmType from '@silklang/llvm/Type'
import type * as Backend from './Backend.js'
import type * as Mir from './Mir.js'
import type * as NativeAggregate from './NativeAggregate.js'
import type * as NativeArith from './NativeArith.js'
import type * as NativeCall from './NativeCall.js'
import type * as NativeDebug from './NativeDebug.js'
import type * as NativeForeignOperation from './NativeForeignOperation.js'
import type * as NativeHostFailure from './NativeHostFailure.js'
import type * as NativeLanePointer from './NativeLanePointer.js'
import type * as NativeLoweringContext from './NativeLoweringContext.js'
import type * as NativeOperation from './NativeOperation.js'
import type * as NativeStorage from './NativeStorage.js'
import type * as NativeSuspension from './NativeSuspension.js'
import type * as NativeTermination from './NativeTermination.js'
import type * as NativeType from './NativeType.js'
import type * as NativeDiagnosticScope from './NativeDiagnosticScope.js'

interface OverflowSignature {
  readonly returnType: LlvmType.Type
  readonly parameters: ReadonlyArray<LlvmType.Type>
}

/** Data and cohesive actor contexts shared by native operation emitters. */
export interface Context {
  readonly diagnosticScopes: ReadonlyMap<number, NativeDiagnosticScope.NativeDiagnosticScope>
  readonly runtimeFeatures: Set<Backend.RuntimeFeature>
  readonly builder: Emitter.Module
  readonly body: Emitter.Body
  readonly program: Mir.Module
  readonly entry: NativeLoweringContext.DeclaredFunction
  readonly declared: ReadonlyArray<NativeLoweringContext.DeclaredFunction>
  readonly staticPointers: ReadonlyMap<string, Constant.Constant>
  readonly i32: LlvmType.Type
  readonly f32: LlvmType.Type
  readonly f64: LlvmType.Type
  readonly pointer: LlvmType.Type
  readonly transferStorageSize: number
  readonly childThunkType?: LlvmType.Type
  readonly resumeThunkType?: LlvmType.Type
  readonly usizeType?: LlvmType.Type
  readonly integerTypes: Map<number, LlvmType.Type>
  readonly signedOverflowSignatures: Map<number, OverflowSignature>
  readonly unsignedOverflowSignatures: Map<number, OverflowSignature>
  readonly malloc?: FunctionActor.Function
  readonly free?: FunctionActor.Function
  readonly memcmp?: FunctionActor.Function
  readonly foreignIndirects: ReadonlyMap<string, NativeForeignOperation.Declaration>
  readonly foreignFunctions: ReadonlyMap<string, NativeForeignOperation.Declaration>
  readonly foreignStatics: ReadonlyMap<string, NativeForeignOperation.StaticDeclaration>
  readonly foreignCallbacks: ReadonlyMap<string, Constant.Constant>
  readonly lanePointers: NativeLanePointer.Context
  readonly suspensionRegions: ReadonlyMap<Mir.Operation, Mir.SuspensionRegion>
  readonly types: NativeType.LoweringContext
  readonly storage: NativeStorage.Context
  readonly debug: NativeDebug.LocationContext
  readonly hostFailure: NativeHostFailure.Context
  readonly cleanup: NativeAggregate.Context
  readonly failure: NativeAggregate.FailureContext
  readonly arith: NativeArith.OperationContext
  readonly call: NativeCall.Context
  readonly suspension: NativeSuspension.OperationContext
  readonly termination: NativeTermination.FunctionContext
  readonly state: NativeOperation.State
}
