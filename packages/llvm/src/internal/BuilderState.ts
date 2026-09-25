import * as Effect from 'effect/Effect'
import * as Result from 'effect/Result'
import type * as Alias from '../Alias.js'
import type * as Attribute from '../Attribute.js'
import type * as Builder from '../Builder.js'
import type * as ByteString from '../ByteString.js'
import type * as Constant from '../Constant.js'
import type * as DataLayout from '../DataLayout.js'
import type * as FunctionActor from '../Function.js'
import type * as Global from '../Global.js'
import { invalidState, type LlvmError } from '../LlvmError.js'
import type * as Type from '../Type.js'
import type * as Variable from '../Variable.js'
import type * as AttributeDescription from './AttributeDescription.js'
import type * as ConstantDescription from './ConstantDescription.js'
import type * as FunctionBodyDescription from './FunctionBodyDescription.js'
import type * as GlobalDescription from './GlobalDescription.js'
import * as GlobalTable from './GlobalTable.js'
import type * as MetadataDescription from './MetadataDescription.js'
import * as MetadataTable from './MetadataTable.js'
import type * as OwnedHandle from './OwnedHandle.js'
import * as Table from './Table.js'
import type * as TypeDescription from './TypeDescription.js'

export interface MutableState {
  strip: boolean
  moduleName: ByteString.ByteString
  sourceFilename: ByteString.ByteString
  targetTriple: ByteString.ByteString
  dataLayout: ByteString.ByteString
  layout: DataLayout.DataLayout
  moduleAssembly: Array<ByteString.ByteString>
  strings: Array<ByteString.ByteString>
  stringKeys: Map<string, number>
  types: Table.Table<TypeDescription.Description, Type.Type>
  namedTypes: Map<string, number>
  attributes: Table.Table<AttributeDescription.Description, Attribute.Attribute>
  attributeSets: Table.Table<ReadonlyArray<number>, Attribute.Set>
  functionAttributeSets: Table.Table<
    AttributeDescription.FunctionSetDescription,
    Attribute.FunctionSet
  >
  constants: Table.Table<ConstantDescription.Description, Constant.Constant>
  /** Integer constants keyed by `type * 2 + signed`, then by the validated input value. */
  integerConstants: Map<number, Map<bigint, Constant.Constant>>
  /** One shared function-body operand per constant; instruction descriptions retain operands. */
  constantOperands: Array<FunctionBodyDescription.Operand | undefined>
  /** UTF-8 encodings of local value and block names, shared across function bodies. */
  localNames: Map<string, ByteString.ByteString>
  globals: GlobalTable.GlobalTable
  buildingFunctions: Set<number>
  /** Default intrinsic resolutions keyed by intrinsic id and overload type indices. */
  intrinsics: Map<string, IntrinsicResolution>
  /** Memory-intrinsic call attributes keyed by canonical attribute set and alignments. */
  memoryCallAttributes: Map<string, Attribute.FunctionSet | undefined>
  metadata: MetadataTable.MetadataTable
}

export interface IntrinsicResolution {
  readonly function: FunctionActor.Function
  readonly index: number
  readonly type: number
  readonly attributes: number | undefined
}

export interface State {
  readonly owner: OwnedHandle.Owner
  readonly value: MutableState
}

/** A builder's mutable state with its identity, as seen by one synchronous transition. */
export interface Context {
  readonly builder: Builder.Builder
  readonly state: MutableState
  readonly owner: OwnedHandle.Owner
}

export interface Snapshot {
  readonly owner: OwnedHandle.Owner
  readonly strip: boolean
  readonly moduleName: ByteString.ByteString
  readonly sourceFilename: ByteString.ByteString
  readonly targetTriple: ByteString.ByteString
  readonly dataLayout: ByteString.ByteString
  readonly layout: DataLayout.DataLayout
  readonly moduleAssembly: ReadonlyArray<ByteString.ByteString>
  readonly strings: ReadonlyArray<ByteString.ByteString>
  readonly types: ReadonlyArray<TypeDescription.Description>
  readonly typeHandles: ReadonlyArray<Type.Type>
  readonly attributes: ReadonlyArray<AttributeDescription.Description>
  readonly attributeSets: ReadonlyArray<ReadonlyArray<number>>
  readonly functionAttributeSets: ReadonlyArray<AttributeDescription.FunctionSetDescription>
  readonly constants: ReadonlyArray<ConstantDescription.Description>
  readonly constantHandles: ReadonlyArray<Constant.Constant>
  readonly globals: ReadonlyArray<GlobalDescription.GlobalDescription>
  readonly globalHandles: ReadonlyArray<Global.Global>
  readonly variables: ReadonlyArray<GlobalDescription.VariableDescription>
  readonly variableHandles: ReadonlyArray<Variable.Variable>
  readonly aliases: ReadonlyArray<GlobalDescription.AliasDescription>
  readonly aliasHandles: ReadonlyArray<Alias.Alias>
  readonly functions: ReadonlyArray<GlobalDescription.FunctionDescription>
  readonly functionHandles: ReadonlyArray<FunctionActor.Function>
  readonly metadata: ReadonlyArray<MetadataDescription.Entry>
  readonly namedMetadata: ReadonlyArray<MetadataDescription.Named>
  readonly globalMetadata: ReadonlyArray<ReadonlyArray<MetadataDescription.Attachment>>
}

const states = new WeakMap<Builder.Builder, State>()

const contexts = new WeakMap<Builder.Builder, Context>()

/** @internal */
export const register = (self: Builder.Builder, state: State): void => {
  states.set(self, state)
  contexts.set(self, { builder: self, state: state.value, owner: state.owner })
}

/** @internal */
export const context = (
  self: Builder.Builder,
  operation: string,
): Result.Result<Context, LlvmError> => {
  const found = contexts.get(self)
  return found === undefined
    ? Result.fail(invalidState({ operation, message: 'Unknown LLVM builder value', state: self }))
    : Result.succeed(found)
}

/**
 * Runs one synchronous transition over a builder context as a single suspended step.
 *
 * @internal
 */
export const transition = <A>(
  self: Builder.Builder,
  operation: string,
  f: (context: Context) => Result.Result<A, LlvmError>,
): Effect.Effect<A, LlvmError> =>
  Effect.suspend(() => {
    const found = contexts.get(self)
    return found === undefined
      ? Effect.fail(invalidState({ operation, message: 'Unknown LLVM builder value', state: self }))
      : Effect.fromResult(f(found))
  })

/**
 * Transitions and snapshots are synchronous `Result` computations, so each critical section
 * completes without an interleaving point and the per-operation semaphore permit only added
 * scheduling overhead on the hottest path in the builder: concurrent fibers still observe every
 * mutation as atomic. `mutate` therefore runs as one suspended step.
 *
 * @internal
 */
export const mutate = <A>(
  self: Builder.Builder,
  operation: string,
  transition: (state: MutableState, owner: OwnedHandle.Owner) => Result.Result<A, LlvmError>,
): Effect.Effect<A, LlvmError> =>
  Effect.suspend(() => Effect.fromResult(transitionResult(self, operation, transition)))

/** The synchronous critical section shared by module and fiber-owned body mutations. @internal */
export const transitionResult = <A>(
  self: Builder.Builder,
  operation: string,
  transition: (state: MutableState, owner: OwnedHandle.Owner) => Result.Result<A, LlvmError>,
): Result.Result<A, LlvmError> => {
  const state = states.get(self)
  if (state === undefined)
    return Result.fail(
      invalidState({ operation, message: 'Unknown LLVM builder value', state: self }),
    )
  return transition(state.value, state.owner)
}

/** @internal */
export const snapshot = (
  self: Builder.Builder,
  operation: string,
): Effect.Effect<Snapshot, LlvmError> =>
  Effect.suspend(() => {
    const state = states.get(self)
    if (state === undefined) {
      return Effect.fail(
        invalidState({ operation, message: 'Unknown LLVM builder value', state: self }),
      )
    }
    return Effect.sync(() => ({
      owner: state.owner,
      strip: state.value.strip,
      moduleName: state.value.moduleName,
      sourceFilename: state.value.sourceFilename,
      targetTriple: state.value.targetTriple,
      dataLayout: state.value.dataLayout,
      layout: state.value.layout,
      moduleAssembly: [...state.value.moduleAssembly],
      strings: [...state.value.strings],
      types: Table.freeze(state.value.types).descriptions,
      typeHandles: Table.freeze(state.value.types).handles,
      attributes: Table.freeze(state.value.attributes).descriptions,
      attributeSets: Table.freeze(state.value.attributeSets).descriptions,
      functionAttributeSets: Table.freeze(state.value.functionAttributeSets).descriptions,
      constants: Table.freeze(state.value.constants).descriptions,
      constantHandles: Table.freeze(state.value.constants).handles,
      globals: GlobalTable.freeze(state.value.globals).globals,
      globalHandles: GlobalTable.freeze(state.value.globals).globalHandles,
      variables: GlobalTable.freeze(state.value.globals).variables,
      variableHandles: GlobalTable.freeze(state.value.globals).variableHandles,
      aliases: GlobalTable.freeze(state.value.globals).aliases,
      aliasHandles: GlobalTable.freeze(state.value.globals).aliasHandles,
      functions: GlobalTable.freeze(state.value.globals).functions,
      functionHandles: GlobalTable.freeze(state.value.globals).functionHandles,
      metadata: MetadataTable.freeze(state.value.metadata).descriptions,
      namedMetadata: MetadataTable.freeze(state.value.metadata).named,
      globalMetadata: GlobalTable.freeze(state.value.globals).attachments,
    }))
  })
