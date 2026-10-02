import * as Effect from 'effect/Effect'
import * as Result from 'effect/Result'
import * as ByteString from './ByteString.js'
import * as DataLayout from './DataLayout.js'
import * as BuilderState from './internal/BuilderState.js'
import * as GlobalTable from './internal/GlobalTable.js'
import * as MetadataTable from './internal/MetadataTable.js'
import * as OwnedHandle from './internal/OwnedHandle.js'
import * as Table from './internal/Table.js'
import type { LlvmError } from './LlvmError.js'

/**
 * An opaque, concurrency-safe owner of LLVM IR state.
 *
 * @category builders
 * @since 0.0.0
 */
export interface Builder {
  readonly _tag: 'Builder'
}

/**
 * Immutable module configuration captured when a {@link Builder} is created.
 *
 * @category builders
 * @since 0.0.0
 */
export interface Options {
  readonly strip?: boolean
  readonly moduleName?: ByteString.ByteString | Uint8Array | string
  readonly sourceFilename?: ByteString.ByteString | Uint8Array | string
  readonly targetTriple?: ByteString.ByteString | Uint8Array | string
  readonly dataLayout?: ByteString.ByteString | Uint8Array | string
  readonly moduleAssembly?: ByteString.ByteString | Uint8Array | string
}

/**
 * Creates the isolated state owner for one LLVM module.
 *
 * **Details**
 *
 * Every type, global, constant, function, local value, and metadata node created from the builder
 * is owner-checked. Mutations pass through one Effect semaphore, so concurrent fibers cannot lose
 * committed updates. Debug information is stripped by default; pass `strip: false` to retain it.
 *
 * Options set module headers, target layout, initial assembly, and the debug-strip policy.
 *
 * **Gotchas**
 *
 * An invalid data layout fails with {@link LlvmError} before the builder is created.
 *
 * **Example** (Creating a module)
 *
 * ```ts
 * import * as Effect from 'effect/Effect'
 * import * as Builder from '@silklang/llvm/Builder'
 * import * as IrText from '@silklang/llvm/IrText'
 *
 * const text = await Effect.runPromise(
 *   Effect.gen(function* () {
 *     const builder = yield* Builder.make({
 *       sourceFilename: 'answer.ll',
 *       targetTriple: 'wasm32-unknown-unknown',
 *     })
 *     return yield* IrText.render(builder)
 *   }),
 * )
 * ```
 *
 * @category builders
 * @since 0.0.0
 */
export const make = Effect.fnUntraced(function* (
  options: Options = {},
): Effect.fn.Return<Builder, LlvmError> {
  const dataLayout = ByteString.coerceOrEmpty(options.dataLayout)
  const layout = yield* DataLayout.parse(dataLayout)
  const self: Builder = { _tag: 'Builder' }
  BuilderState.register(self, {
    owner: OwnedHandle.makeOwner(),
    value: {
      strip: options.strip ?? true,
      moduleName: ByteString.coerceOrEmpty(options.moduleName),
      sourceFilename: ByteString.coerceOrEmpty(options.sourceFilename),
      targetTriple: ByteString.coerceOrEmpty(options.targetTriple),
      dataLayout,
      layout,
      moduleAssembly:
        options.moduleAssembly === undefined
          ? []
          : [ByteString.coerceOrEmpty(options.moduleAssembly)],
      strings: [],
      stringKeys: new Map(),
      types: Table.make(),
      namedTypes: new Map(),
      attributes: Table.make(),
      attributeSets: Table.make(),
      functionAttributeSets: Table.make(),
      constants: Table.make(),
      globals: GlobalTable.make(),
      buildingFunctions: new Set(),
      intrinsics: new Map(),
      integerConstants: new Map(),
      constantOperands: [],
      memoryCallAttributes: new Map(),
      metadata: MetadataTable.make(),
    },
  })
  return self
})

/**
 * Appends one module-level assembly fragment in serialized commit order.
 *
 * @category builders
 * @since 0.0.0
 */
export const appendModuleAssembly = Effect.fnUntraced(function* (
  self: Builder,
  assembly: ByteString.ByteString | Uint8Array | string,
): Effect.fn.Return<void, LlvmError> {
  const value = ByteString.coerceOrEmpty(assembly)
  yield* BuilderState.mutate(self, 'Builder.appendModuleAssembly', (state) => {
    state.moduleAssembly.push(value)
    return Result.succeed(undefined)
  })
})
