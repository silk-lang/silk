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
import type * as Type from './Type.js'

/**
 * Opaque builder-owned identity for an LLVM global alias.
 *
 * @category aliases
 * @since 0.0.0
 */
export interface Alias extends Handle.Handle<'Alias'> {}

/**
 * Common global properties accepted when creating an alias.
 *
 * @category aliases
 * @since 0.0.0
 */
export interface Options extends Global.Options {}

/** @internal */
const aliaseeIndex = (
  builder: Builder.Builder,
  state: BuilderState.MutableState,
  owner: BuilderState.State['owner'],
  aliasee: Constant.Constant,
  operation: string,
): Result.Result<number, LlvmError> =>
  Result.gen(function* () {
    const index = yield* Handle.resolve(builder, owner, aliasee, 'Constant', operation)
    const constant = state.constants.descriptions[index]
    const type = constant === undefined ? undefined : state.types.descriptions[constant.type]
    if (type?._tag !== 'Pointer') {
      return yield* Result.fail(
        invalidInput({
          operation,
          message: 'An LLVM alias aliasee must have pointer type',
          input: aliasee,
        }),
      )
    }
    return index
  })

/** @internal */
const handleAt = (
  state: BuilderState.MutableState,
  index: number,
  operation: string,
): Result.Result<Alias, LlvmError> => {
  const handle = state.globals.aliases.handles[index]
  if (handle === undefined) {
    return Result.fail(
      invalidState({ operation, message: 'Alias table handle is missing', state: index }),
    )
  }
  return Result.succeed(handle)
}

/** @internal */
const resolve = (
  builder: Builder.Builder,
  state: BuilderState.MutableState,
  owner: BuilderState.State['owner'],
  self: Alias,
  operation: string,
): Result.Result<
  { readonly index: number; readonly description: GlobalDescription.AliasDescription },
  LlvmError
> =>
  Result.gen(function* () {
    const { index, description } = yield* ResolveActor.resolve(
      builder,
      owner,
      self,
      'Alias',
      state.globals.aliases,
      operation,
    )
    const global = state.globals.entries.descriptions[description.global]
    if (global?.kind !== 'Alias' || global.actorIndex !== index || global.deleted) {
      return yield* Result.fail(
        invalidState({ operation, message: 'Alias handle is no longer active', state: self }),
      )
    }
    return { index, description }
  })

/**
 * Creates a named LLVM alias to a pointer-typed constant.
 *
 * **Details**
 *
 * The alias occupies the same module-wide symbol table as variables and functions. `valueType`
 * describes the value visible through the alias, while `aliasee` must be a pointer constant owned
 * by the same builder. Creation is atomic: validation failures leave the symbol table unchanged.
 *
 * JavaScript names are encoded as UTF-8; byte strings preserve an exact global symbol name.
 *
 * **Gotchas**
 *
 * Name collisions, cross-builder handles, and non-pointer aliasees fail with {@link LlvmError}.
 *
 * **Example** (Creating a global alias)
 *
 * Alias a global variable under a second symbol name.
 *
 * ```ts
 * import * as Effect from 'effect/Effect'
 * import * as Alias from '@silklang/llvm/Alias'
 * import * as Builder from '@silklang/llvm/Builder'
 * import * as Constant from '@silklang/llvm/Constant'
 * import * as IrText from '@silklang/llvm/IrText'
 * import * as Type from '@silklang/llvm/Type'
 * import * as Variable from '@silklang/llvm/Variable'
 *
 * const text = await Effect.runPromise(Effect.gen(function* () {
 *   const builder = yield* Builder.make()
 *   const i32 = yield* Type.integer(builder, 32)
 *   const variable = yield* Variable.make(builder, 'answer', i32)
 *   const pointer = yield* Constant.fromGlobal(builder, yield* Variable.global(builder, variable))
 *   yield* Alias.make(builder, 'answer_alias', i32, pointer)
 *   return yield* IrText.render(builder)
 * }))
 * // text includes `@answer_alias = alias i32, ptr @answer`
 * ```
 *
 * @category aliases
 * @since 0.0.0
 */
export const make = Effect.fnUntraced(function* (
  builder: Builder.Builder,
  name: ByteString.ByteString | Uint8Array | string,
  valueType: Type.Type,
  aliasee: Constant.Constant,
  options: Options = {},
): Effect.fn.Return<Alias, LlvmError> {
  return yield* BuilderState.mutate(builder, 'Alias.make', (state, owner) =>
    Result.gen(function* () {
      const typeIndex = yield* Handle.resolve(builder, owner, valueType, 'Type', 'Alias.make')
      const target = yield* aliaseeIndex(builder, state, owner, aliasee, 'Alias.make')
      const index = state.globals.aliases.descriptions.length
      const allocated = yield* GlobalState.allocate(
        state,
        owner,
        ByteString.coerce(name),
        'Alias',
        index,
        options,
        'Alias.make',
      )
      const handle = Handle.make('Alias', owner, index)
      state.globals.aliases.descriptions.push({
        _tag: 'Alias',
        global: allocated.index,
        valueType: typeIndex,
        aliasee: target,
      })
      state.globals.aliases.handles.push(handle)
      return handle
    }),
  )
})

/**
 * Adopts an existing generic global as an alias, or returns its existing alias identity.
 *
 * @category aliases
 * @since 0.0.0
 */
export const fromGlobal = Effect.fnUntraced(function* (
  builder: Builder.Builder,
  global: Global.Global,
  valueType: Type.Type,
  aliasee: Constant.Constant,
): Effect.fn.Return<Alias, LlvmError> {
  return yield* BuilderState.mutate(builder, 'Alias.fromGlobal', (state, owner) =>
    Result.gen(function* () {
      const resolved = yield* GlobalState.resolve(builder, state, owner, global, 'Alias.fromGlobal')
      if (resolved.description.kind === 'Alias') {
        return yield* handleAt(state, resolved.description.actorIndex, 'Alias.fromGlobal')
      }
      const index = state.globals.aliases.descriptions.length
      const handle = Handle.make('Alias', owner, index)
      state.globals.aliases.descriptions.push({
        _tag: 'Alias',
        global: resolved.index,
        valueType: yield* Handle.resolve(builder, owner, valueType, 'Type', 'Alias.fromGlobal'),
        aliasee: yield* aliaseeIndex(builder, state, owner, aliasee, 'Alias.fromGlobal'),
      })
      state.globals.aliases.handles.push(handle)
      state.globals.entries.descriptions[resolved.index] = {
        ...resolved.description,
        kind: 'Alias',
        actorIndex: index,
      }
      return handle
    }),
  )
})

/**
 * Replaces an alias target after pointer-type and ownership validation.
 *
 * @category aliases
 * @since 0.0.0
 */
export const setAliasee = Effect.fnUntraced(function* (
  builder: Builder.Builder,
  self: Alias,
  aliasee: Constant.Constant,
): Effect.fn.Return<void, LlvmError> {
  yield* BuilderState.mutate(builder, 'Alias.setAliasee', (state, owner) =>
    Result.gen(function* () {
      const { description, index } = yield* resolve(builder, state, owner, self, 'Alias.setAliasee')
      state.globals.aliases.descriptions[index] = {
        ...description,
        aliasee: yield* aliaseeIndex(builder, state, owner, aliasee, 'Alias.setAliasee'),
      }
    }),
  )
})

/**
 * Returns the shared global-symbol handle for an alias.
 *
 * @category aliases
 * @since 0.0.0
 */
export const global = Effect.fnUntraced(function* (
  builder: Builder.Builder,
  self: Alias,
): Effect.fn.Return<Global.Global, LlvmError> {
  return yield* BuilderState.mutate(builder, 'Alias.global', (state, owner) =>
    Result.gen(function* () {
      const value = (yield* resolve(builder, state, owner, self, 'Alias.global')).description
      return yield* GlobalState.handleAt(state, value.global, 'Alias.global')
    }),
  )
})

/**
 * Reads the current pointer-typed aliasee constant.
 *
 * @category aliases
 * @since 0.0.0
 */
export const aliasee = Effect.fnUntraced(function* (
  builder: Builder.Builder,
  self: Alias,
): Effect.fn.Return<Constant.Constant, LlvmError> {
  return yield* BuilderState.mutate(builder, 'Alias.aliasee', (state, owner) =>
    Result.gen(function* () {
      const description = (yield* resolve(builder, state, owner, self, 'Alias.aliasee')).description
      const constant = state.constants.handles[description.aliasee]
      if (constant === undefined) {
        return yield* Result.fail(
          invalidState({
            operation: 'Alias.aliasee',
            message: 'Alias target constant is missing',
            state: self,
          }),
        )
      }
      return constant
    }),
  )
})
