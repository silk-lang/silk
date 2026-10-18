import * as Effect from 'effect/Effect'
import * as Result from 'effect/Result'
import type * as Builder from './Builder.js'
import * as ByteString from './ByteString.js'
import type * as Constant from './Constant.js'
import type * as Global from './Global.js'
import * as BuilderState from './internal/BuilderState.js'
import type * as GlobalDescription from './internal/GlobalDescription.js'
import * as GlobalState from './internal/GlobalState.js'
import * as Handle from './internal/Handle.js'
import * as ResolveActor from './internal/resolveActor.js'
import { invalidInput, invalidState, type LlvmError } from './LlvmError.js'
import type * as Metadata from './Metadata.js'
import type * as Type from './Type.js'

/**
 * Opaque builder-owned identity for an LLVM global variable.
 *
 * @category variables
 * @since 0.0.0
 */
export interface Variable extends Handle.Handle<'Variable'> {}

/**
 * LLVM thread-local storage model for a variable.
 *
 * @category variables
 * @since 0.0.0
 */
export type ThreadLocalModel = GlobalDescription.ThreadLocalModel

/**
 * Global and variable-specific creation properties.
 *
 * @category variables
 * @since 0.0.0
 */
export interface Options extends Global.Options {
  readonly initializer?: Constant.Constant
  readonly constant?: boolean
  readonly threadLocal?: ThreadLocalModel
  readonly externallyInitialized?: boolean
  readonly debugExpressions?: ReadonlyArray<Metadata.Metadata>
}

/**
 * Read-only variable-specific properties.
 *
 * @category variables
 * @since 0.0.0
 */
export interface Properties {
  readonly valueType: Type.Type
  readonly initializer: Constant.Constant | undefined
  readonly constant: boolean
  readonly threadLocal: ThreadLocalModel
  readonly externallyInitialized: boolean
  readonly debugExpressions: ReadonlyArray<Metadata.Metadata>
}

/** @internal */
const handleAt = (
  state: BuilderState.MutableState,
  index: number,
  operation: string,
): Result.Result<Variable, LlvmError> => {
  const handle = state.globals.variables.handles[index]
  if (handle === undefined) {
    return Result.fail(
      invalidState({ operation, message: 'Variable table handle is missing', state: index }),
    )
  }
  return Result.succeed(handle)
}

/** @internal */
const resolve = (
  builder: Builder.Builder,
  state: BuilderState.MutableState,
  owner: BuilderState.State['owner'],
  self: Variable,
  operation: string,
): Result.Result<
  { readonly index: number; readonly description: GlobalDescription.VariableDescription },
  LlvmError
> =>
  Result.gen(function* () {
    const { index, description } = yield* ResolveActor.resolve(
      builder,
      owner,
      self,
      'Variable',
      state.globals.variables,
      operation,
    )
    const globalIndex = yield* GlobalState.resolveIndex(state, description.global, operation)
    const global = state.globals.entries.descriptions[globalIndex]
    if (global?.kind !== 'Variable' || global.actorIndex !== index || global.deleted) {
      return yield* Result.fail(
        invalidState({ operation, message: 'Variable handle is no longer active', state: self }),
      )
    }
    return { index, description }
  })

/** @internal */
const initializerIndex = (
  builder: Builder.Builder,
  state: BuilderState.MutableState,
  owner: BuilderState.State['owner'],
  valueType: number,
  initializer: Constant.Constant | undefined,
  operation: string,
): Result.Result<number | undefined, LlvmError> =>
  Result.gen(function* () {
    if (initializer === undefined) return undefined
    const index = yield* Handle.resolve(builder, owner, initializer, 'Constant', operation)
    const constant = state.constants.descriptions[index]
    if (constant?.type !== valueType) {
      return yield* Result.fail(
        invalidInput({
          operation,
          message: 'Variable initializer type does not match its value type',
          input: initializer,
        }),
      )
    }
    return index
  })

/** @internal */
const debugExpressionIndices = (
  builder: Builder.Builder,
  state: BuilderState.MutableState,
  owner: BuilderState.State['owner'],
  values: ReadonlyArray<Metadata.Metadata> | undefined,
  operation: string,
): Result.Result<ReadonlyArray<number>, LlvmError> =>
  Result.gen(function* () {
    if (state.strip || values === undefined) return []
    const indices: Array<number> = []
    for (const value of values) {
      indices.push(yield* Handle.resolve(builder, owner, value, 'Metadata', operation))
    }
    return indices
  })

/** @internal */
const setGlobalDebugExpressions = (
  state: BuilderState.MutableState,
  global: number,
  expressions: ReadonlyArray<number>,
): void => {
  const attachments = state.globals.attachments[global] ?? []
  state.globals.attachments[global] = [
    ...attachments.filter((attachment) => attachment.kind !== 'dbg'),
    ...expressions.map((metadata) => ({ kind: 'dbg' as const, metadata })),
  ]
}

/**
 * Creates a global variable and its shared global-symbol identity atomically.
 *
 * **Gotchas**
 *
 * The initializer must have exactly the declared value type. Debug expressions are ignored when
 * the builder was created with `strip: true`; all ownership and type failures leave no symbol behind.
 *
 * **Example** (Creating a global variable)
 *
 * ```ts
 * import * as Effect from 'effect/Effect'
 * import * as Builder from '@silklang/llvm/Builder'
 * import * as Constant from '@silklang/llvm/Constant'
 * import * as Type from '@silklang/llvm/Type'
 * import * as Variable from '@silklang/llvm/Variable'
 *
 * const variable = await Effect.runPromise(
 *   Effect.gen(function* () {
 *     const builder = yield* Builder.make()
 *     const i32 = yield* Type.integer(builder, 32)
 *     const zero = yield* Constant.integerUnsigned(builder, i32, 0)
 *     return yield* Variable.make(builder, 'counter', i32, { initializer: zero })
 *   }),
 * )
 * ```
 *
 * @category variables
 * @since 0.0.0
 */
export const make = (
  builder: Builder.Builder,
  name: ByteString.ByteString | Uint8Array | string,
  valueType: Type.Type,
  options: Options = {},
): Effect.Effect<Variable, LlvmError> =>
  BuilderState.transition(builder, 'Variable.make', (context) =>
    makeIn(context, name, valueType, options),
  )

/** @internal */
export const makeIn = (
  context: BuilderState.Context,
  name: ByteString.ByteString | Uint8Array | string,
  valueType: Type.Type,
  options: Options = {},
): Result.Result<Variable, LlvmError> => {
  const { builder, state, owner } = context
  return Result.gen(function* () {
    const typeIndex = yield* Handle.resolve(builder, owner, valueType, 'Type', 'Variable.make')
    const init = yield* initializerIndex(
      builder,
      state,
      owner,
      typeIndex,
      options.initializer,
      'Variable.make',
    )
    const debugExpressions = yield* debugExpressionIndices(
      builder,
      state,
      owner,
      options.debugExpressions,
      'Variable.make',
    )
    const index = state.globals.variables.descriptions.length
    const allocated = yield* GlobalState.allocate(
      state,
      owner,
      ByteString.coerce(name),
      'Variable',
      index,
      options,
      'Variable.make',
    )
    const handle = Handle.make('Variable', owner, index)
    state.globals.variables.descriptions.push({
      _tag: 'Variable',
      global: allocated.index,
      valueType: typeIndex,
      initializer: init,
      constant: options.constant ?? false,
      threadLocal: options.threadLocal ?? 'none',
      externallyInitialized: options.externallyInitialized ?? false,
      debugExpressions,
    })
    setGlobalDebugExpressions(state, allocated.index, debugExpressions)
    state.globals.variables.handles.push(handle)
    return handle
  })
}

/**
 * Adopts an existing generic global as a variable, or returns its existing variable identity.
 *
 * @category variables
 * @since 0.0.0
 */
export const fromGlobal = Effect.fnUntraced(function* (
  builder: Builder.Builder,
  global: Global.Global,
  valueType: Type.Type,
  options: Omit<Options, keyof Global.Options> = {},
): Effect.fn.Return<Variable, LlvmError> {
  return yield* BuilderState.mutate(builder, 'Variable.fromGlobal', (state, owner) =>
    Result.gen(function* () {
      const resolved = yield* GlobalState.resolve(
        builder,
        state,
        owner,
        global,
        'Variable.fromGlobal',
      )
      if (resolved.description.kind === 'Variable') {
        return yield* handleAt(state, resolved.description.actorIndex, 'Variable.fromGlobal')
      }
      const typeIndex = yield* Handle.resolve(
        builder,
        owner,
        valueType,
        'Type',
        'Variable.fromGlobal',
      )
      const index = state.globals.variables.descriptions.length
      const handle = Handle.make('Variable', owner, index)
      const debugExpressions = yield* debugExpressionIndices(
        builder,
        state,
        owner,
        options.debugExpressions,
        'Variable.fromGlobal',
      )
      state.globals.variables.descriptions.push({
        _tag: 'Variable',
        global: resolved.index,
        valueType: typeIndex,
        initializer: yield* initializerIndex(
          builder,
          state,
          owner,
          typeIndex,
          options.initializer,
          'Variable.fromGlobal',
        ),
        constant: options.constant ?? false,
        threadLocal: options.threadLocal ?? 'none',
        externallyInitialized: options.externallyInitialized ?? false,
        debugExpressions,
      })
      setGlobalDebugExpressions(state, resolved.index, debugExpressions)
      state.globals.variables.handles.push(handle)
      state.globals.entries.descriptions[resolved.index] = {
        ...resolved.description,
        kind: 'Variable',
        actorIndex: index,
      }
      return handle
    }),
  )
})

/**
 * Returns the shared global-symbol handle for a variable.
 *
 * @category variables
 * @since 0.0.0
 */
export const global = (
  builder: Builder.Builder,
  self: Variable,
): Effect.Effect<Global.Global, LlvmError> =>
  BuilderState.transition(builder, 'Variable.global', (context) => globalIn(context, self))

/** @internal */
export const globalIn = (
  context: BuilderState.Context,
  self: Variable,
): Result.Result<Global.Global, LlvmError> => {
  const { builder, state, owner } = context
  return Result.gen(function* () {
    const value = (yield* resolve(builder, state, owner, self, 'Variable.global')).description
    return yield* GlobalState.handleAt(state, value.global, 'Variable.global')
  })
}

/**
 * Replaces or removes a variable initializer after exact type and ownership validation.
 *
 * @category variables
 * @since 0.0.0
 */
export const setInitializer = Effect.fnUntraced(function* (
  builder: Builder.Builder,
  self: Variable,
  initializer: Constant.Constant | undefined,
): Effect.fn.Return<void, LlvmError> {
  yield* BuilderState.mutate(builder, 'Variable.setInitializer', (state, owner) =>
    Result.gen(function* () {
      const { description, index } = yield* resolve(
        builder,
        state,
        owner,
        self,
        'Variable.setInitializer',
      )
      state.globals.variables.descriptions[index] = {
        ...description,
        initializer: yield* initializerIndex(
          builder,
          state,
          owner,
          description.valueType,
          initializer,
          'Variable.setInitializer',
        ),
      }
    }),
  )
})

/**
 * Updates variable-only properties while preserving omitted fields and common global settings.
 *
 * @category variables
 * @since 0.0.0
 */
export const configure = Effect.fnUntraced(function* (
  builder: Builder.Builder,
  self: Variable,
  options: Pick<Options, 'constant' | 'threadLocal' | 'externallyInitialized' | 'debugExpressions'>,
): Effect.fn.Return<void, LlvmError> {
  yield* BuilderState.mutate(builder, 'Variable.configure', (state, owner) =>
    Result.gen(function* () {
      const { description, index } = yield* resolve(
        builder,
        state,
        owner,
        self,
        'Variable.configure',
      )
      const debugExpressions =
        options.debugExpressions === undefined
          ? description.debugExpressions
          : yield* debugExpressionIndices(
              builder,
              state,
              owner,
              options.debugExpressions,
              'Variable.configure',
            )
      state.globals.variables.descriptions[index] = {
        ...description,
        constant: options.constant ?? description.constant,
        threadLocal: options.threadLocal ?? description.threadLocal,
        externallyInitialized: options.externallyInitialized ?? description.externallyInitialized,
        debugExpressions,
      }
      setGlobalDebugExpressions(state, description.global, debugExpressions)
    }),
  )
})

/**
 * Reads an immutable snapshot of a variable's value type, initializer, storage, and debug settings.
 *
 * @category variables
 * @since 0.0.0
 */
export const properties = Effect.fnUntraced(function* (
  builder: Builder.Builder,
  self: Variable,
): Effect.fn.Return<Properties, LlvmError> {
  return yield* BuilderState.mutate(builder, 'Variable.properties', (state, owner) =>
    Result.gen(function* () {
      const description = (yield* resolve(builder, state, owner, self, 'Variable.properties'))
        .description
      const valueType = state.types.handles[description.valueType]
      const initializer =
        description.initializer === undefined
          ? undefined
          : state.constants.handles[description.initializer]
      if (
        valueType === undefined ||
        (description.initializer !== undefined && initializer === undefined)
      ) {
        return yield* Result.fail(
          invalidState({
            operation: 'Variable.properties',
            message: 'Variable references a missing table entry',
            state: self,
          }),
        )
      }
      return {
        valueType,
        initializer,
        constant: description.constant,
        threadLocal: description.threadLocal,
        externallyInitialized: description.externallyInitialized,
        debugExpressions: description.debugExpressions.flatMap((index) => {
          const metadata = state.metadata.entries.handles[index]
          return metadata === undefined ? [] : [metadata]
        }),
      }
    }),
  )
})
