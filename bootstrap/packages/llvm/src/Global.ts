import * as Effect from 'effect/Effect'
import * as Result from 'effect/Result'
import type * as Builder from './Builder.js'
import * as ByteString from './ByteString.js'
import * as BuilderState from './internal/BuilderState.js'
import * as CanonicalKey from './internal/CanonicalKey.js'
import type * as GlobalDescription from './internal/GlobalDescription.js'
import * as GlobalState from './internal/GlobalState.js'
import type * as Handle from './internal/Handle.js'
import { invalidInput, invalidState, type LlvmError } from './LlvmError.js'
import * as Metadata from './Metadata.js'

/**
 * Opaque identity shared by variables, aliases, and functions in the module symbol table.
 *
 * @category globals
 * @since 0.0.0
 */
export interface Global extends Handle.Handle<'Global'> {}

/**
 * LLVM linkage accepted by global declarations.
 *
 * @category globals
 * @since 0.0.0
 */
export type Linkage = GlobalDescription.Linkage
/**
 * LLVM symbol visibility accepted by global declarations.
 *
 * @category globals
 * @since 0.0.0
 */
export type Visibility = GlobalDescription.Visibility
/**
 * Runtime preemption behavior for a global symbol.
 *
 * @category globals
 * @since 0.0.0
 */
export type Preemption = GlobalDescription.Preemption
/**
 * Platform DLL import/export storage class.
 *
 * @category globals
 * @since 0.0.0
 */
export type DllStorage = GlobalDescription.DllStorage
/**
 * Whether address significance is local, global, or ordinary.
 *
 * @category globals
 * @since 0.0.0
 */
export type UnnamedAddress = GlobalDescription.UnnamedAddress
/**
 * Common creation and update properties shared by every global actor.
 *
 * @category globals
 * @since 0.0.0
 */
export type Options = GlobalState.CommonOptions

/**
 * Read-only common properties and concrete actor kind of a global symbol.
 *
 * @category globals
 * @since 0.0.0
 */
export interface Properties extends GlobalDescription.Common {
  readonly kind: GlobalDescription.GlobalDescription['kind']
}

/**
 * Looks up an active global by its exact byte name.
 *
 * **Details**
 *
 * Variables, aliases, and functions share this lookup table. Renamed, removed, and replaced source
 * names are absent. The returned handle is the common global identity; use {@link kind} to inspect
 * its actor category when the declaration type is not already known.
 * JavaScript names are encoded as UTF-8; byte strings preserve an exact lookup key. A missing name
 * returns `undefined`.
 *
 * **Example** (Looking up a global)
 *
 * Find the shared global identity created for a variable.
 *
 * ```ts
 * import * as Effect from 'effect/Effect'
 * import * as Builder from '@silklang/llvm/Builder'
 * import * as Global from '@silklang/llvm/Global'
 * import * as Type from '@silklang/llvm/Type'
 * import * as Variable from '@silklang/llvm/Variable'
 *
 * const matches = await Effect.runPromise(Effect.gen(function* () {
 *   const builder = yield* Builder.make()
 *   const i32 = yield* Type.integer(builder, 32)
 *   const variable = yield* Variable.make(builder, 'answer', i32)
 *   const expected = yield* Variable.global(builder, variable)
 *   return (yield* Global.lookup(builder, 'answer')) === expected
 * }))
 * // matches === true
 * ```
 *
 * @category globals
 * @since 0.0.0
 */
export const lookup = Effect.fnUntraced(function* (
  builder: Builder.Builder,
  name: ByteString.ByteString | Uint8Array | string,
): Effect.fn.Return<Global | undefined, LlvmError> {
  const value = ByteString.coerce(name)
  return yield* BuilderState.mutate(builder, 'Global.lookup', (state) =>
    Result.gen(function* () {
      const index = state.globals.entries.keys.get(CanonicalKey.bytes(value))
      if (index === undefined) return undefined
      const resolved = yield* GlobalState.resolveIndex(state, index, 'Global.lookup')
      const description = state.globals.entries.descriptions[resolved]
      return description === undefined || description.deleted
        ? undefined
        : yield* GlobalState.handleAt(state, resolved, 'Global.lookup')
    }),
  )
})

/**
 * Reads a global's current byte-exact name.
 *
 * @category globals
 * @since 0.0.0
 */
export const name = Effect.fnUntraced(function* (
  builder: Builder.Builder,
  self: Global,
): Effect.fn.Return<ByteString.ByteString, LlvmError> {
  return yield* BuilderState.mutate(builder, 'Global.name', (state, owner) =>
    Result.gen(function* () {
      return (yield* GlobalState.resolve(builder, state, owner, self, 'Global.name')).description
        .name
    }),
  )
})

/**
 * Identifies whether a global currently represents a variable, alias, or function.
 *
 * @category globals
 * @since 0.0.0
 */
export const kind = Effect.fnUntraced(function* (
  builder: Builder.Builder,
  self: Global,
): Effect.fn.Return<GlobalDescription.GlobalDescription['kind'], LlvmError> {
  return yield* BuilderState.mutate(builder, 'Global.kind', (state, owner) =>
    Result.gen(function* () {
      return (yield* GlobalState.resolve(builder, state, owner, self, 'Global.kind')).description
        .kind
    }),
  )
})

/**
 * Reads an immutable snapshot of a global's common properties.
 *
 * @category globals
 * @since 0.0.0
 */
export const properties = Effect.fnUntraced(function* (
  builder: Builder.Builder,
  self: Global,
): Effect.fn.Return<Properties, LlvmError> {
  return yield* BuilderState.mutate(builder, 'Global.properties', (state, owner) =>
    Result.gen(function* () {
      const description = (yield* GlobalState.resolve(
        builder,
        state,
        owner,
        self,
        'Global.properties',
      )).description
      return {
        name: description.name,
        addressSpace: description.addressSpace,
        linkage: description.linkage,
        visibility: description.visibility,
        preemption: description.preemption,
        dllStorage: description.dllStorage,
        unnamedAddress: description.unnamedAddress,
        section: description.section,
        alignment: description.alignment,
        kind: description.kind,
      }
    }),
  )
})

/**
 * Atomically moves a global to a new non-empty, unoccupied symbol name.
 *
 * **Gotchas**
 *
 * Empty names, collisions, inactive handles, and cross-builder handles fail with
 * {@link LlvmError} without mutating the global.
 *
 * @category globals
 * @since 0.0.0
 */
export const rename = Effect.fnUntraced(function* (
  builder: Builder.Builder,
  self: Global,
  nextName: ByteString.ByteString | Uint8Array | string,
): Effect.fn.Return<void, LlvmError> {
  const requested = ByteString.coerce(nextName)
  yield* BuilderState.mutate(builder, 'Global.rename', (state, owner) =>
    Result.gen(function* () {
      const { description, index } = yield* GlobalState.resolve(
        builder,
        state,
        owner,
        self,
        'Global.rename',
      )
      if (requested.bytes.length === 0) {
        return yield* Result.fail(
          invalidInput({
            operation: 'Global.rename',
            message: 'Renaming requires an explicit non-empty global name',
            input: nextName,
          }),
        )
      }
      const nextKey = CanonicalKey.bytes(requested)
      const occupied = state.globals.entries.keys.get(nextKey)
      if (
        occupied !== undefined &&
        (yield* GlobalState.resolveIndex(state, occupied, 'Global.rename')) !== index
      ) {
        return yield* Result.fail(
          invalidState({
            operation: 'Global.rename',
            message: 'LLVM global name is already occupied',
            state: nextName,
          }),
        )
      }
      state.globals.entries.keys.delete(CanonicalKey.bytes(description.name))
      state.globals.entries.keys.set(nextKey, index)
      state.globals.entries.descriptions[index] = { ...description, name: requested }
    }),
  )
})

/**
 * Applies only the supplied common properties, preserving every omitted field.
 *
 * @category globals
 * @since 0.0.0
 */
export const configure = Effect.fnUntraced(function* (
  builder: Builder.Builder,
  self: Global,
  options: Options,
): Effect.fn.Return<void, LlvmError> {
  yield* BuilderState.mutate(builder, 'Global.configure', (state, owner) =>
    Result.gen(function* () {
      const { description, index } = yield* GlobalState.resolve(
        builder,
        state,
        owner,
        self,
        'Global.configure',
      )
      state.globals.entries.descriptions[index] = {
        ...description,
        addressSpace: options.addressSpace ?? description.addressSpace,
        linkage: options.linkage ?? description.linkage,
        visibility: options.visibility ?? description.visibility,
        preemption: options.preemption ?? description.preemption,
        dllStorage: options.dllStorage ?? description.dllStorage,
        unnamedAddress: options.unnamedAddress ?? description.unnamedAddress,
        section: options.section ?? description.section,
        alignment: options.alignment ?? description.alignment,
      }
    }),
  )
})

/**
 * Replaces one global metadata attachment kind, or does nothing when debug stripping is enabled.
 *
 * @category globals
 * @since 0.0.0
 */
export const attachMetadata = Effect.fnUntraced(function* (
  builder: Builder.Builder,
  self: Global,
  kind: 'dbg' | 'prof' | 'unpredictable',
  metadata: Metadata.Optional,
): Effect.fn.Return<void, LlvmError> {
  yield* BuilderState.mutate(builder, 'Global.attachMetadata', (state, owner) =>
    Result.gen(function* () {
      if (state.strip || metadata === undefined) return
      const { index } = yield* GlobalState.resolve(
        builder,
        state,
        owner,
        self,
        'Global.attachMetadata',
      )
      const metadataIndex = yield* Metadata.resolveIndex(
        builder,
        state,
        owner,
        metadata,
        'Global.attachMetadata',
      )
      if (metadataIndex === undefined) return
      const current = state.globals.attachments[index] ?? []
      state.globals.attachments[index] = [
        ...current.filter((attachment) => attachment.kind !== kind),
        { kind, metadata: metadataIndex },
      ]
    }),
  )
})

/**
 * Redirects references from one global identity to another and retires the source symbol.
 *
 * **Details**
 *
 * Replacement preserves handle-resolution chains; replacing a global with itself is a no-op.
 *
 * @category globals
 * @since 0.0.0
 */
export const replace = Effect.fnUntraced(function* (
  builder: Builder.Builder,
  self: Global,
  replacement: Global,
): Effect.fn.Return<void, LlvmError> {
  yield* BuilderState.mutate(builder, 'Global.replace', (state, owner) =>
    Result.gen(function* () {
      const source = yield* GlobalState.resolve(builder, state, owner, self, 'Global.replace')
      const target = yield* GlobalState.resolve(
        builder,
        state,
        owner,
        replacement,
        'Global.replace',
      )
      if (source.index === target.index) return
      state.globals.entries.keys.delete(CanonicalKey.bytes(source.description.name))
      state.globals.entries.descriptions[source.index] = {
        ...source.description,
        replacement: target.index,
        deleted: true,
      }
    }),
  )
})

/**
 * Removes a global from lookup and serialization and invalidates its active actor handle.
 *
 * @category globals
 * @since 0.0.0
 */
export const remove = Effect.fnUntraced(function* (
  builder: Builder.Builder,
  self: Global,
): Effect.fn.Return<void, LlvmError> {
  yield* BuilderState.mutate(builder, 'Global.remove', (state, owner) =>
    Result.gen(function* () {
      const { description, index } = yield* GlobalState.resolve(
        builder,
        state,
        owner,
        self,
        'Global.remove',
      )
      state.globals.entries.keys.delete(CanonicalKey.bytes(description.name))
      state.globals.entries.descriptions[index] = { ...description, deleted: true }
    }),
  )
})
