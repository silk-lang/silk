import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as Result from 'effect/Result'
import type * as Builder from './Builder.js'
import * as ByteString from './ByteString.js'
import type * as Constant from './Constant.js'
import * as DIFlags from './DIFlags.js'
import * as DISPFlags from './DISPFlags.js'
import * as BuilderState from './internal/BuilderState.js'
import * as CanonicalKey from './internal/CanonicalKey.js'
import * as Handle from './internal/Handle.js'
import * as IntegerInput from './internal/IntegerInput.js'
import * as MetadataDescription from './internal/MetadataDescription.js'
import type { Metadata } from './internal/MetadataHandle.js'
import * as MetadataTable from './internal/MetadataTable.js'
import * as ResolveActor from './internal/resolveActor.js'
import { invalidInput, type LlvmError } from './LlvmError.js'
import type * as Variable from './Variable.js'

export type { Metadata }

/**
 * Debug metadata constructors return absence when the builder is in strip mode.
 *
 * @category metadata
 * @since 0.0.0
 */
export type Optional = Metadata | undefined
/**
 * Forward-reference category used to validate recursive metadata resolution.
 *
 * @category metadata
 * @since 0.0.0
 */
export type Category = MetadataDescription.Category
/**
 * DWARF basic-type encoding accepted by {@link basicType}.
 *
 * @category metadata
 * @since 0.0.0
 */
export type BasicEncoding = MetadataDescription.BasicEncoding
/**
 * String encoding accepted by {@link stringType}.
 *
 * @category metadata
 * @since 0.0.0
 */
export type StringEncoding = MetadataDescription.StringEncoding
/**
 * Composite debug type family accepted by {@link compositeType}.
 *
 * @category metadata
 * @since 0.0.0
 */
export type CompositeKind = MetadataDescription.CompositeKind
/**
 * Derived debug type family accepted by {@link derivedType}.
 *
 * @category metadata
 * @since 0.0.0
 */
export type DerivedKind = MetadataDescription.DerivedKind

/**
 * Optional optimization, enumeration, and global lists for a compile unit.
 *
 * @category metadata
 * @since 0.0.0
 */
export interface CompileUnitOptions {
  readonly optimized?: boolean
  readonly enums?: Optional
  readonly globals?: Optional
}

/**
 * Source, type, flag, and compile-unit links for a debug subprogram.
 *
 * @category metadata
 * @since 0.0.0
 */
export interface SubprogramOptions {
  readonly linkageName?: Metadata
  readonly line?: number
  readonly scopeLine?: number
  readonly type?: Optional
  readonly diFlags?: DIFlags.DIFlags
  readonly spFlags?: DISPFlags.DISPFlags
  readonly compileUnit?: Optional
}

/**
 * Shared source and layout fields for composite debug types.
 *
 * @category metadata
 * @since 0.0.0
 */
export interface CompositeTypeOptions {
  readonly name?: Metadata
  readonly file?: Optional
  readonly scope?: Optional
  readonly line?: number
  readonly underlyingType?: Optional
  readonly sizeInBits?: bigint | number
  readonly alignInBits?: bigint | number
  readonly fields?: Optional
  readonly flags?: DIFlags.DIFlags
}

/**
 * Dynamic location, length, layout, and encoding fields for a string debug type.
 *
 * @category metadata
 * @since 0.0.0
 */
export interface StringTypeOptions {
  readonly name?: Metadata
  readonly stringLength?: Optional
  readonly stringLengthExpression?: Optional
  readonly stringLocationExpression?: Optional
  readonly sizeInBits?: bigint | number
  readonly alignInBits?: bigint | number
  readonly encoding?: StringEncoding
}

/**
 * Composite fields plus bit offset for pointer, member, and typedef debug types.
 *
 * @category metadata
 * @since 0.0.0
 */
export interface DerivedTypeOptions extends CompositeTypeOptions {
  readonly offsetInBits?: bigint | number
}

/**
 * Shared source, scope, type, and flag fields for local debug variables.
 *
 * @category metadata
 * @since 0.0.0
 */
export interface VariableOptions {
  readonly name?: Metadata
  readonly file?: Optional
  readonly scope?: Optional
  readonly line?: number
  readonly type?: Optional
  readonly flags?: DIFlags.DIFlags
}

/**
 * Local-variable fields plus linkage and IR-variable association for a debug global.
 *
 * @category metadata
 * @since 0.0.0
 */
export interface GlobalVariableOptions extends VariableOptions {
  readonly linkageName?: Metadata
  readonly variable?: Variable.Variable
  readonly local?: boolean
}

/** @internal */
const metadataKey = (node: MetadataDescription.Node): string =>
  JSON.stringify(node, (_name, value) => (typeof value === 'bigint' ? `bigint:${value}` : value))

/** @internal */
const resolve = (
  builder: Builder.Builder,
  state: BuilderState.MutableState,
  owner: BuilderState.State['owner'],
  self: Metadata,
  operation: string,
): Result.Result<
  { readonly index: number; readonly entry: MetadataDescription.Entry },
  LlvmError
> =>
  Result.map(
    ResolveActor.resolve(builder, owner, self, 'Metadata', state.metadata.entries, operation),
    ({ index, description }) => ({ index, entry: description }),
  )

/**
 * Resolves optional metadata to its table index for low-level actor and serializer integrations.
 *
 * @category metadata
 * @since 0.0.0
 */
export const resolveIndex = (
  builder: Builder.Builder,
  state: BuilderState.MutableState,
  owner: BuilderState.State['owner'],
  self: Optional,
  operation: string,
): Result.Result<number | undefined, LlvmError> =>
  self === undefined
    ? Result.succeed(undefined)
    : Result.map(resolve(builder, state, owner, self, operation), ({ index }) => index)

/** @internal */
const resolveString = (
  builder: Builder.Builder,
  state: BuilderState.MutableState,
  owner: BuilderState.State['owner'],
  self: Optional,
  operation: string,
): Result.Result<number | undefined, LlvmError> =>
  Result.gen(function* () {
    if (self === undefined) return undefined
    const resolved = yield* resolve(builder, state, owner, self, operation)
    if (resolved.entry._tag !== 'String') {
      return yield* Result.fail(
        invalidInput({ operation, message: 'Expected a metadata string', input: self }),
      )
    }
    return resolved.index
  })

/** @internal */
const node = (
  state: BuilderState.MutableState,
  owner: BuilderState.State['owner'],
  value: MetadataDescription.Node,
): Metadata => {
  if (!value.distinct) {
    const key = metadataKey(value)
    const existing = state.metadata.nodeKeys.get(key)
    if (existing !== undefined) {
      const handle = state.metadata.entries.handles[existing]
      if (handle !== undefined) return handle
    }
    const handle = MetadataTable.allocate(state.metadata, owner, { _tag: 'Node', value })
    state.metadata.nodeKeys.set(key, state.metadata.entries.descriptions.length - 1)
    return handle
  }
  return MetadataTable.allocate(state.metadata, owner, { _tag: 'Node', value })
}

/** @internal */
const debugNode = Effect.fnUntraced(function* (
  builder: Builder.Builder,
  operation: string,
  make: (
    state: BuilderState.MutableState,
    owner: BuilderState.State['owner'],
  ) => MetadataDescription.Node | Result.Result<MetadataDescription.Node, LlvmError>,
): Effect.fn.Return<Optional, LlvmError> {
  return yield* BuilderState.mutate(builder, operation, (state, owner) =>
    Result.gen(function* () {
      if (state.strip) return undefined
      const made = make(state, owner)
      const value = Result.isResult(made) ? yield* made : made
      return node(state, owner, value)
    }),
  )
})

/**
 * Interns a byte-exact metadata string; strings are retained even when debug nodes are stripped.
 *
 * @category metadata
 * @since 0.0.0
 */
export const string = Effect.fnUntraced(function* (
  builder: Builder.Builder,
  value: ByteString.ByteString | Uint8Array | string,
): Effect.fn.Return<Metadata, LlvmError> {
  const content = ByteString.coerce(value)
  return yield* BuilderState.mutate(builder, 'Metadata.string', (state, owner) => {
    const key = CanonicalKey.bytes(content)
    const existing = state.metadata.entries.keys.get(key)
    if (existing !== undefined) {
      const handle = state.metadata.entries.handles[existing]
      if (handle !== undefined) return Result.succeed(handle)
    }
    const handle = MetadataTable.allocate(state.metadata, owner, { _tag: 'String', value: content })
    state.metadata.entries.keys.set(key, state.metadata.entries.descriptions.length - 1)
    return Result.succeed(handle)
  })
})

/**
 * Interns a structural metadata tuple, preserving `undefined` elements as LLVM `null`.
 *
 * @category metadata
 * @since 0.0.0
 */
export const tuple = Effect.fnUntraced(function* (
  builder: Builder.Builder,
  elements: ReadonlyArray<Optional> = [],
): Effect.fn.Return<Metadata, LlvmError> {
  return yield* BuilderState.mutate(builder, 'Metadata.tuple', (state, owner) =>
    Result.gen(function* () {
      const resolved: Array<number | undefined> = []
      for (const element of elements) {
        resolved.push(yield* resolveIndex(builder, state, owner, element, 'Metadata.tuple'))
      }
      return node(state, owner, {
        _tag: 'Tuple',
        distinct: false,
        elements: resolved,
      })
    }),
  )
})

/**
 * Allocates a fresh `distinct` tuple even when an equal tuple already exists.
 *
 * @category metadata
 * @since 0.0.0
 */
export const distinctTuple = Effect.fnUntraced(function* (
  builder: Builder.Builder,
  elements: ReadonlyArray<Optional> = [],
): Effect.fn.Return<Metadata, LlvmError> {
  return yield* BuilderState.mutate(builder, 'Metadata.distinctTuple', (state, owner) =>
    Result.gen(function* () {
      const resolved: Array<number | undefined> = []
      for (const element of elements) {
        resolved.push(yield* resolveIndex(builder, state, owner, element, 'Metadata.distinctTuple'))
      }
      return node(state, owner, {
        _tag: 'Tuple',
        distinct: true,
        elements: resolved,
      })
    }),
  )
})

/**
 * Returns the canonical empty structural tuple.
 *
 * @category metadata
 * @since 0.0.0
 */
export const emptyTuple = Effect.fnUntraced(function* (
  builder: Builder.Builder,
): Effect.fn.Return<Metadata, LlvmError> {
  return yield* tuple(builder)
})

/**
 * Interns a metadata wrapper around a builder-owned LLVM constant.
 *
 * @category metadata
 * @since 0.0.0
 */
export const constant = Effect.fnUntraced(function* (
  builder: Builder.Builder,
  value: Constant.Constant,
): Effect.fn.Return<Metadata, LlvmError> {
  return yield* BuilderState.mutate(builder, 'Metadata.constant', (state, owner) =>
    Result.gen(function* () {
      return node(state, owner, {
        _tag: 'Constant',
        distinct: false,
        constant: yield* Handle.resolve(builder, owner, value, 'Constant', 'Metadata.constant'),
      })
    }),
  )
})

/**
 * Allocates a distinct opaque local metadata node for a byte-exact label.
 *
 * @category metadata
 * @since 0.0.0
 */
export const local = Effect.fnUntraced(function* (
  builder: Builder.Builder,
  label: ByteString.ByteString | Uint8Array | string,
): Effect.fn.Return<Optional, LlvmError> {
  const value = ByteString.coerce(label)
  return yield* debugNode(builder, 'Metadata.local', () => ({
    _tag: 'Local',
    distinct: true,
    label: value,
  }))
})

/**
 * Allocates a typed forward reference for a recursive metadata graph.
 *
 * **Gotchas**
 *
 * Resolve it exactly once with {@link resolveForward}. Unresolved references are tolerated while
 * unreachable, but text or bitcode output fails if one becomes reachable from an attachment or
 * named metadata root.
 *
 * **Example** (Resolving recursive metadata)
 *
 * ```ts
 * import * as Effect from 'effect/Effect'
 * import * as Builder from '@silklang/llvm/Builder'
 * import * as Metadata from '@silklang/llvm/Metadata'
 *
 * await Effect.runPromise(Effect.gen(function* () {
 *   const builder = yield* Builder.make({ strip: false })
 *   const forward = yield* Metadata.forward(builder, 'node')
 *   if (forward === undefined) return
 *   const recursive = yield* Metadata.distinctTuple(builder, [forward])
 *   yield* Metadata.resolveForward(builder, forward, recursive)
 *   yield* Metadata.named(builder, 'example.recursive', [recursive])
 * }))
 * ```
 *
 * @category metadata
 * @since 0.0.0
 */
export const forward = Effect.fnUntraced(function* (
  builder: Builder.Builder,
  category: Category = 'node',
): Effect.fn.Return<Optional, LlvmError> {
  return yield* BuilderState.mutate(builder, 'Metadata.forward', (state, owner) =>
    Result.succeed(
      state.strip
        ? undefined
        : MetadataTable.allocate(state.metadata, owner, {
            _tag: 'Forward',
            category,
            target: undefined,
          }),
    ),
  )
})

/**
 * Resolves a category-compatible forward to a non-forward target exactly once.
 *
 * @category metadata
 * @since 0.0.0
 */
export const resolveForward = Effect.fnUntraced(function* (
  builder: Builder.Builder,
  self: Metadata,
  target: Metadata,
): Effect.fn.Return<void, LlvmError> {
  yield* BuilderState.mutate(builder, 'Metadata.resolveForward', (state, owner) =>
    Result.gen(function* () {
      const source = yield* resolve(builder, state, owner, self, 'Metadata.resolveForward')
      const destination = yield* resolve(builder, state, owner, target, 'Metadata.resolveForward')
      if (source.entry._tag !== 'Forward') {
        return yield* Result.fail(
          invalidInput({
            operation: 'Metadata.resolveForward',
            message: 'Only a metadata forward reference can be resolved',
            input: self,
          }),
        )
      }
      if (source.entry.target !== undefined) {
        return yield* Result.fail(
          invalidInput({
            operation: 'Metadata.resolveForward',
            message: 'Metadata forward reference has already been resolved',
            input: self,
          }),
        )
      }
      if (destination.entry._tag === 'Forward') {
        return yield* Result.fail(
          invalidInput({
            operation: 'Metadata.resolveForward',
            message: 'A metadata forward reference cannot resolve to another forward reference',
            input: target,
          }),
        )
      }
      if (source.entry.category !== 'any') {
        const actual =
          destination.entry._tag === 'String'
            ? 'string'
            : MetadataDescription.category(destination.entry.value)
        if (
          actual === 'string' ||
          (source.entry.category !== 'node' && source.entry.category !== actual)
        ) {
          return yield* Result.fail(
            invalidInput({
              operation: 'Metadata.resolveForward',
              message: `Metadata forward reference requires ${source.entry.category} metadata`,
              input: { target, actual },
            }),
          )
        }
      }
      source.entry.target = destination.index
    }),
  )
})

/**
 * Creates a structural `DIFile` from optional metadata-string filename and directory values.
 *
 * @category metadata
 * @since 0.0.0
 */
export const file = Effect.fnUntraced(function* (
  builder: Builder.Builder,
  filename?: Metadata,
  directory?: Metadata,
): Effect.fn.Return<Optional, LlvmError> {
  return yield* debugNode(builder, 'Metadata.file', (state, owner) =>
    Result.gen(function* () {
      return {
        _tag: 'File',
        distinct: false,
        filename: yield* resolveString(builder, state, owner, filename, 'Metadata.file'),
        directory: yield* resolveString(builder, state, owner, directory, 'Metadata.file'),
      }
    }),
  )
})

/**
 * Creates a distinct `DICompileUnit`, or returns `undefined` in strip mode.
 *
 * @category metadata
 * @since 0.0.0
 */
export const compileUnit = Effect.fnUntraced(function* (
  builder: Builder.Builder,
  fileValue: Optional,
  producer?: Metadata,
  options: CompileUnitOptions = {},
): Effect.fn.Return<Optional, LlvmError> {
  return yield* debugNode(builder, 'Metadata.compileUnit', (state, owner) =>
    Result.gen(function* () {
      return {
        _tag: 'CompileUnit',
        distinct: true,
        file: yield* resolveIndex(builder, state, owner, fileValue, 'Metadata.compileUnit'),
        producer: yield* resolveString(builder, state, owner, producer, 'Metadata.compileUnit'),
        optimized: options.optimized ?? false,
        enums: yield* resolveIndex(builder, state, owner, options.enums, 'Metadata.compileUnit'),
        globals: yield* resolveIndex(
          builder,
          state,
          owner,
          options.globals,
          'Metadata.compileUnit',
        ),
      }
    }),
  )
})

/**
 * Creates a distinct `DISubprogram` with source positions, flags, type, and compile-unit links.
 *
 * @category metadata
 * @since 0.0.0
 */
export const subprogram = Effect.fnUntraced(function* (
  builder: Builder.Builder,
  fileValue: Optional,
  name?: Metadata,
  options: SubprogramOptions = {},
): Effect.fn.Return<Optional, LlvmError> {
  return yield* debugNode(builder, 'Metadata.subprogram', (state, owner) =>
    Result.gen(function* () {
      return {
        _tag: 'Subprogram',
        distinct: true,
        file: yield* resolveIndex(builder, state, owner, fileValue, 'Metadata.subprogram'),
        name: yield* resolveString(builder, state, owner, name, 'Metadata.subprogram'),
        linkageName: yield* resolveString(
          builder,
          state,
          owner,
          options.linkageName,
          'Metadata.subprogram',
        ),
        line: options.line ?? 0,
        scopeLine: options.scopeLine ?? options.line ?? 0,
        type: yield* resolveIndex(builder, state, owner, options.type, 'Metadata.subprogram'),
        diFlags: DIFlags.toBitcode(options.diFlags ?? DIFlags.none),
        spFlags: DISPFlags.toBitcode(options.spFlags ?? DISPFlags.none),
        compileUnit: yield* resolveIndex(
          builder,
          state,
          owner,
          options.compileUnit,
          'Metadata.subprogram',
        ),
      }
    }),
  )
})

/**
 * Creates a structural lexical scope nested under another debug scope.
 *
 * @category metadata
 * @since 0.0.0
 */
export const lexicalBlock = Effect.fnUntraced(function* (
  builder: Builder.Builder,
  scope: Optional,
  fileValue: Optional,
  line = 0,
  column = 0,
): Effect.fn.Return<Optional, LlvmError> {
  return yield* debugNode(builder, 'Metadata.lexicalBlock', (state, owner) =>
    Result.gen(function* () {
      return {
        _tag: 'LexicalBlock',
        distinct: false,
        scope: yield* resolveIndex(builder, state, owner, scope, 'Metadata.lexicalBlock'),
        file: yield* resolveIndex(builder, state, owner, fileValue, 'Metadata.lexicalBlock'),
        line,
        column,
      }
    }),
  )
})

/**
 * Creates a structural instruction location with optional inline call-site ancestry.
 *
 * @category metadata
 * @since 0.0.0
 */
export const location = (
  builder: Builder.Builder,
  line: number,
  column: number,
  scope: Metadata,
  inlinedAt?: Metadata,
): Effect.Effect<Optional, LlvmError> =>
  BuilderState.transition(builder, 'Metadata.location', (context) =>
    locationIn(context, line, column, scope, inlinedAt),
  )

/** @internal */
export const locationIn = (
  context: BuilderState.Context,
  line: number,
  column: number,
  scope: Metadata,
  inlinedAt?: Metadata,
): Result.Result<Optional, LlvmError> => {
  const { builder, state, owner } = context
  if (state.strip) return Result.succeed(undefined)
  const scopeIndex = resolve(builder, state, owner, scope, 'Metadata.location')
  if (Result.isFailure(scopeIndex)) return Result.fail(scopeIndex.failure)
  const inlinedIndex = resolveIndex(builder, state, owner, inlinedAt, 'Metadata.location')
  if (Result.isFailure(inlinedIndex)) return Result.fail(inlinedIndex.failure)
  return Result.succeed(
    node(state, owner, {
      _tag: 'Location',
      distinct: false,
      line,
      column,
      scope: scopeIndex.success.index,
      inlinedAt: inlinedIndex.success,
    }),
  )
}

/**
 * Creates a basic debug type from DWARF encoding, optional metadata-string name, and bit size.
 *
 * @category metadata
 * @since 0.0.0
 */
export const basicType = Effect.fnUntraced(function* (
  builder: Builder.Builder,
  encoding: BasicEncoding,
  name: Metadata | undefined,
  sizeInBits: bigint | number,
): Effect.fn.Return<Optional, LlvmError> {
  const exactSize = yield* Effect.fromResult(
    IntegerInput.normalize(sizeInBits, {
      operation: 'Metadata.basicType',
      message: 'Debug type sizes must be unsigned 64-bit integers',
      minimum: 0n,
      maximum: 0xffff_ffff_ffff_ffffn,
    }),
  )
  return yield* debugNode(builder, 'Metadata.basicType', (state, owner) =>
    Result.gen(function* () {
      return {
        _tag: 'BasicType',
        distinct: false,
        encoding,
        name: yield* resolveString(builder, state, owner, name, 'Metadata.basicType'),
        sizeInBits: exactSize,
      }
    }),
  )
})

/**
 * Creates a boolean basic debug type through {@link basicType}.
 *
 * @category metadata
 * @since 0.0.0
 */
export const booleanType = Effect.fnUntraced(function* (
  builder: Builder.Builder,
  name: Metadata | undefined,
  bits: bigint | number,
) {
  return yield* basicType(builder, 'boolean', name, bits)
})
/**
 * Creates an unsigned integer basic debug type through {@link basicType}.
 *
 * @category metadata
 * @since 0.0.0
 */
export const unsignedType = Effect.fnUntraced(function* (
  builder: Builder.Builder,
  name: Metadata | undefined,
  bits: bigint | number,
) {
  return yield* basicType(builder, 'unsigned', name, bits)
})
/**
 * Creates a signed integer basic debug type through {@link basicType}.
 *
 * @category metadata
 * @since 0.0.0
 */
export const signedType = Effect.fnUntraced(function* (
  builder: Builder.Builder,
  name: Metadata | undefined,
  bits: bigint | number,
) {
  return yield* basicType(builder, 'signed', name, bits)
})
/**
 * Creates a floating-point basic debug type through {@link basicType}.
 *
 * @category metadata
 * @since 0.0.0
 */
export const floatingType = Effect.fnUntraced(function* (
  builder: Builder.Builder,
  name: Metadata | undefined,
  bits: bigint | number,
) {
  return yield* basicType(builder, 'float', name, bits)
})

/**
 * Creates an LLVM `DIStringType` carrying explicit UTF text identity.
 *
 * @category metadata
 * @since 0.0.0
 */
export const stringType = Effect.fnUntraced(function* (
  builder: Builder.Builder,
  options: StringTypeOptions = {},
): Effect.fn.Return<Optional, LlvmError> {
  const sizeInBits = yield* Effect.fromResult(
    IntegerInput.normalize(options.sizeInBits ?? 0, {
      operation: 'Metadata.stringType',
      message: 'Debug string type sizes must be unsigned 64-bit integers',
      minimum: 0n,
      maximum: 0xffff_ffff_ffff_ffffn,
    }),
  )
  const alignInBits = yield* Effect.fromResult(
    IntegerInput.normalize(options.alignInBits ?? 0, {
      operation: 'Metadata.stringType',
      message: 'Debug string type alignments must be unsigned 64-bit integers',
      minimum: 0n,
      maximum: 0xffff_ffff_ffff_ffffn,
    }),
  )
  return yield* debugNode(builder, 'Metadata.stringType', (state, owner) =>
    Result.gen(function* () {
      return {
        _tag: 'StringType',
        distinct: false,
        name: yield* resolveString(builder, state, owner, options.name, 'Metadata.stringType'),
        stringLength: yield* resolveIndex(
          builder,
          state,
          owner,
          options.stringLength,
          'Metadata.stringType',
        ),
        stringLengthExpression: yield* resolveIndex(
          builder,
          state,
          owner,
          options.stringLengthExpression,
          'Metadata.stringType',
        ),
        stringLocationExpression: yield* resolveIndex(
          builder,
          state,
          owner,
          options.stringLocationExpression,
          'Metadata.stringType',
        ),
        sizeInBits,
        alignInBits,
        encoding: options.encoding ?? 'utf',
      }
    }),
  )
})

/**
 * Creates a structural composite debug type with source, layout, field, and flag metadata.
 *
 * @category metadata
 * @since 0.0.0
 */
export const compositeType = Effect.fnUntraced(function* (
  builder: Builder.Builder,
  kind: CompositeKind,
  options: CompositeTypeOptions = {},
): Effect.fn.Return<Optional, LlvmError> {
  const sizeInBits = yield* Effect.fromResult(
    IntegerInput.normalize(options.sizeInBits ?? 0, {
      operation: 'Metadata.compositeType',
      message: 'Debug type sizes must be unsigned 64-bit integers',
      minimum: 0n,
      maximum: 0xffff_ffff_ffff_ffffn,
    }),
  )
  const alignInBits = yield* Effect.fromResult(
    IntegerInput.normalize(options.alignInBits ?? 0, {
      operation: 'Metadata.compositeType',
      message: 'Debug type alignments must be unsigned 64-bit integers',
      minimum: 0n,
      maximum: 0xffff_ffff_ffff_ffffn,
    }),
  )
  return yield* debugNode(builder, 'Metadata.compositeType', (state, owner) =>
    Result.gen(function* () {
      return {
        _tag: 'CompositeType',
        distinct: false,
        kind,
        name: yield* resolveString(builder, state, owner, options.name, 'Metadata.compositeType'),
        file: yield* resolveIndex(builder, state, owner, options.file, 'Metadata.compositeType'),
        scope: yield* resolveIndex(builder, state, owner, options.scope, 'Metadata.compositeType'),
        line: options.line ?? 0,
        underlyingType: yield* resolveIndex(
          builder,
          state,
          owner,
          options.underlyingType,
          'Metadata.compositeType',
        ),
        sizeInBits,
        alignInBits,
        fields: yield* resolveIndex(
          builder,
          state,
          owner,
          options.fields,
          'Metadata.compositeType',
        ),
        flags: DIFlags.toBitcode(
          options.flags ?? (kind === 'vector' ? DIFlags.make({ vector: true }) : DIFlags.none),
        ),
      }
    }),
  )
})

/**
 * Creates a structure debug type through {@link compositeType}.
 *
 * @category metadata
 * @since 0.0.0
 */
export const structureType = Effect.fnUntraced(function* (
  builder: Builder.Builder,
  options: CompositeTypeOptions = {},
) {
  return yield* compositeType(builder, 'structure', options)
})
/**
 * Creates a union debug type through {@link compositeType}.
 *
 * @category metadata
 * @since 0.0.0
 */
export const unionType = Effect.fnUntraced(function* (
  builder: Builder.Builder,
  options: CompositeTypeOptions = {},
) {
  return yield* compositeType(builder, 'union', options)
})
/**
 * Creates an enumeration debug type through {@link compositeType}.
 *
 * @category metadata
 * @since 0.0.0
 */
export const enumerationType = Effect.fnUntraced(function* (
  builder: Builder.Builder,
  options: CompositeTypeOptions = {},
) {
  return yield* compositeType(builder, 'enumeration', options)
})
/**
 * Creates an array debug type through {@link compositeType}.
 *
 * @category metadata
 * @since 0.0.0
 */
export const arrayType = Effect.fnUntraced(function* (
  builder: Builder.Builder,
  options: CompositeTypeOptions = {},
) {
  return yield* compositeType(builder, 'array', options)
})
/**
 * Creates a vector debug type and supplies `DIFlagVector` unless explicitly overridden.
 *
 * @category metadata
 * @since 0.0.0
 */
export const vectorType = Effect.fnUntraced(function* (
  builder: Builder.Builder,
  options: CompositeTypeOptions = {},
) {
  return yield* compositeType(builder, 'vector', options)
})

/**
 * Creates a structural pointer, member, or typedef debug type with an optional bit offset.
 *
 * @category metadata
 * @since 0.0.0
 */
export const derivedType = Effect.fnUntraced(function* (
  builder: Builder.Builder,
  kind: DerivedKind,
  options: DerivedTypeOptions = {},
): Effect.fn.Return<Optional, LlvmError> {
  const sizeInBits = yield* Effect.fromResult(
    IntegerInput.normalize(options.sizeInBits ?? 0, {
      operation: 'Metadata.derivedType',
      message: 'Debug type sizes must be unsigned 64-bit integers',
      minimum: 0n,
      maximum: 0xffff_ffff_ffff_ffffn,
    }),
  )
  const alignInBits = yield* Effect.fromResult(
    IntegerInput.normalize(options.alignInBits ?? 0, {
      operation: 'Metadata.derivedType',
      message: 'Debug type alignments must be unsigned 64-bit integers',
      minimum: 0n,
      maximum: 0xffff_ffff_ffff_ffffn,
    }),
  )
  const offsetInBits = yield* Effect.fromResult(
    IntegerInput.normalize(options.offsetInBits ?? 0, {
      operation: 'Metadata.derivedType',
      message: 'Debug type offsets must be unsigned 64-bit integers',
      minimum: 0n,
      maximum: 0xffff_ffff_ffff_ffffn,
    }),
  )
  return yield* debugNode(builder, 'Metadata.derivedType', (state, owner) =>
    Result.gen(function* () {
      return {
        _tag: 'DerivedType',
        distinct: false,
        kind,
        name: yield* resolveString(builder, state, owner, options.name, 'Metadata.derivedType'),
        file: yield* resolveIndex(builder, state, owner, options.file, 'Metadata.derivedType'),
        scope: yield* resolveIndex(builder, state, owner, options.scope, 'Metadata.derivedType'),
        line: options.line ?? 0,
        underlyingType: yield* resolveIndex(
          builder,
          state,
          owner,
          options.underlyingType,
          'Metadata.derivedType',
        ),
        sizeInBits,
        alignInBits,
        offsetInBits,
        flags: DIFlags.toBitcode(options.flags ?? DIFlags.none),
      }
    }),
  )
})

/**
 * Creates a pointer debug type through {@link derivedType}.
 *
 * @category metadata
 * @since 0.0.0
 */
export const pointerType = Effect.fnUntraced(function* (
  builder: Builder.Builder,
  options: DerivedTypeOptions = {},
) {
  return yield* derivedType(builder, 'pointer', options)
})
/**
 * Creates a structure-member debug type through {@link derivedType}.
 *
 * @category metadata
 * @since 0.0.0
 */
export const memberType = Effect.fnUntraced(function* (
  builder: Builder.Builder,
  options: DerivedTypeOptions = {},
) {
  return yield* derivedType(builder, 'member', options)
})
/**
 * Creates a typedef debug type through {@link derivedType}.
 *
 * @category metadata
 * @since 0.0.0
 */
export const typedefType = Effect.fnUntraced(function* (
  builder: Builder.Builder,
  options: DerivedTypeOptions = {},
) {
  return yield* derivedType(builder, 'typedef', options)
})

/**
 * Creates a `DISubroutineType` whose tuple convention is return type followed by parameters.
 *
 * @category metadata
 * @since 0.0.0
 */
export const subroutineType = Effect.fnUntraced(function* (
  builder: Builder.Builder,
  types?: Metadata,
  flags: DIFlags.DIFlags = DIFlags.none,
): Effect.fn.Return<Optional, LlvmError> {
  return yield* debugNode(builder, 'Metadata.subroutineType', (state, owner) =>
    Result.gen(function* () {
      return {
        _tag: 'SubroutineType',
        distinct: false,
        types: yield* resolveIndex(builder, state, owner, types, 'Metadata.subroutineType'),
        flags: DIFlags.toBitcode(flags),
      }
    }),
  )
})

/**
 * Creates a signed or unsigned arbitrary-width enumeration member.
 *
 * @category metadata
 * @since 0.0.0
 */
export const enumerator = Effect.fnUntraced(function* (
  builder: Builder.Builder,
  name: Metadata | undefined,
  value: bigint,
  options: { readonly unsigned?: boolean; readonly bitWidth?: number } = {},
): Effect.fn.Return<Optional, LlvmError> {
  if (options.unsigned === true && value < 0n) {
    return yield* invalidInput({
      operation: 'Metadata.enumerator',
      message: 'An unsigned debug enumerator cannot have a negative value',
      input: value,
    })
  }
  return yield* debugNode(builder, 'Metadata.enumerator', (state, owner) =>
    Result.gen(function* () {
      return {
        _tag: 'Enumerator',
        distinct: false,
        name: yield* resolveString(builder, state, owner, name, 'Metadata.enumerator'),
        unsigned: options.unsigned ?? false,
        bitWidth: options.bitWidth ?? 64,
        value,
      }
    }),
  )
})

/**
 * Creates an array/vector subrange whose lower bound and count are metadata operands.
 *
 * @category metadata
 * @since 0.0.0
 */
export const subrange = Effect.fnUntraced(function* (
  builder: Builder.Builder,
  lowerBound?: Metadata,
  count?: Metadata,
): Effect.fn.Return<Optional, LlvmError> {
  return yield* debugNode(builder, 'Metadata.subrange', (state, owner) =>
    Result.gen(function* () {
      return {
        _tag: 'Subrange',
        distinct: false,
        lowerBound: yield* resolveIndex(builder, state, owner, lowerBound, 'Metadata.subrange'),
        count: yield* resolveIndex(builder, state, owner, count, 'Metadata.subrange'),
      }
    }),
  )
})

/**
 * Creates a structural `DIExpression` from raw DWARF operation operands.
 *
 * @category metadata
 * @since 0.0.0
 */
export const expression = Effect.fnUntraced(function* (
  builder: Builder.Builder,
  elements: ReadonlyArray<number> = [],
): Effect.fn.Return<Optional, LlvmError> {
  return yield* debugNode(builder, 'Metadata.expression', () => ({
    _tag: 'Expression',
    distinct: false,
    elements: [...elements],
  }))
})

/** @internal */
const variableNode = Effect.fnUntraced(function* (
  builder: Builder.Builder,
  operation: string,
  argument: number,
  options: VariableOptions,
): Effect.fn.Return<Optional, LlvmError> {
  return yield* debugNode(builder, operation, (state, owner) =>
    Result.gen(function* () {
      return {
        _tag: 'LocalVariable',
        distinct: false,
        name: yield* resolveString(builder, state, owner, options.name, operation),
        file: yield* resolveIndex(builder, state, owner, options.file, operation),
        scope: yield* resolveIndex(builder, state, owner, options.scope, operation),
        line: options.line ?? 0,
        type: yield* resolveIndex(builder, state, owner, options.type, operation),
        argument,
        flags: DIFlags.toBitcode(options.flags ?? DIFlags.none),
      }
    }),
  )
})

/**
 * Creates a non-parameter local debug variable.
 *
 * @category metadata
 * @since 0.0.0
 */
export const localVariable = (builder: Builder.Builder, options: VariableOptions = {}) =>
  variableNode(builder, 'Metadata.localVariable', 0, options)

/**
 * Creates a local debug variable for a one-based source parameter number.
 *
 * @category metadata
 * @since 0.0.0
 */
export const parameter = (
  builder: Builder.Builder,
  argument: number,
  options: VariableOptions = {},
) => variableNode(builder, 'Metadata.parameter', argument, options)

/**
 * Creates a distinct global debug variable, optionally linked to an IR {@link Variable.Variable}.
 *
 * @category metadata
 * @since 0.0.0
 */
export const globalVariable = Effect.fnUntraced(function* (
  builder: Builder.Builder,
  options: GlobalVariableOptions = {},
): Effect.fn.Return<Optional, LlvmError> {
  return yield* debugNode(builder, 'Metadata.globalVariable', (state, owner) =>
    Result.gen(function* () {
      const variable =
        options.variable === undefined
          ? undefined
          : yield* Handle.resolve(
              builder,
              owner,
              options.variable,
              'Variable',
              'Metadata.globalVariable',
            )
      return {
        _tag: 'GlobalVariable',
        distinct: true,
        name: yield* resolveString(builder, state, owner, options.name, 'Metadata.globalVariable'),
        linkageName: yield* resolveString(
          builder,
          state,
          owner,
          options.linkageName,
          'Metadata.globalVariable',
        ),
        file: yield* resolveIndex(builder, state, owner, options.file, 'Metadata.globalVariable'),
        scope: yield* resolveIndex(builder, state, owner, options.scope, 'Metadata.globalVariable'),
        line: options.line ?? 0,
        type: yield* resolveIndex(builder, state, owner, options.type, 'Metadata.globalVariable'),
        variable,
        local: options.local ?? false,
      }
    }),
  )
})

/**
 * Pairs a global debug variable with its address/value expression.
 *
 * @category metadata
 * @since 0.0.0
 */
export const globalVariableExpression = Effect.fnUntraced(function* (
  builder: Builder.Builder,
  variable?: Metadata,
  expression?: Metadata,
): Effect.fn.Return<Optional, LlvmError> {
  return yield* debugNode(builder, 'Metadata.globalVariableExpression', (state, owner) =>
    Result.gen(function* () {
      return {
        _tag: 'GlobalVariableExpression',
        distinct: false,
        variable: yield* resolveIndex(
          builder,
          state,
          owner,
          variable,
          'Metadata.globalVariableExpression',
        ),
        expression: yield* resolveIndex(
          builder,
          state,
          owner,
          expression,
          'Metadata.globalVariableExpression',
        ),
      }
    }),
  )
})

/**
 * Creates or atomically replaces one named metadata root in the module.
 *
 * @category metadata
 * @since 0.0.0
 */
export const named = Effect.fnUntraced(function* (
  builder: Builder.Builder,
  name: ByteString.ByteString | Uint8Array | string,
  operands: ReadonlyArray<Metadata>,
): Effect.fn.Return<void, LlvmError> {
  const finalName = ByteString.coerce(name)
  yield* BuilderState.mutate(builder, 'Metadata.named', (state, owner) =>
    Result.gen(function* () {
      if (state.strip) return
      const mutableResolved: Array<number> = []
      for (const operand of operands) {
        const index = yield* resolveIndex(builder, state, owner, operand, 'Metadata.named')
        if (index === undefined) {
          return yield* Result.fail(
            invalidInput({
              operation: 'Metadata.named',
              message: 'Named metadata operand unexpectedly resolved to absence',
              input: operand,
            }),
          )
        }
        mutableResolved.push(index)
      }
      const resolved = mutableResolved
      const key = CanonicalKey.bytes(finalName)
      const existing = state.metadata.namedKeys.get(key)
      const description = { name: finalName, operands: resolved }
      if (existing === undefined) {
        state.metadata.namedKeys.set(key, state.metadata.named.length)
        state.metadata.named.push(description)
      } else {
        state.metadata.named[existing] = description
      }
    }),
  )
})

/**
 * Reads the low-level immutable metadata entry for diagnostics and serializer integrations.
 *
 * @category metadata
 * @since 0.0.0
 */
export const inspect = Effect.fnUntraced(function* (
  builder: Builder.Builder,
  self: Metadata,
): Effect.fn.Return<MetadataDescription.Entry, LlvmError> {
  return yield* BuilderState.mutate(builder, 'Metadata.inspect', (state, owner) =>
    Result.map(resolve(builder, state, owner, self, 'Metadata.inspect'), ({ entry }) => entry),
  )
})

/**
 * Iterative metadata graph traversal result used by text and bitcode serializers.
 *
 * @category metadata
 * @since 0.0.0
 */
export interface Reachable {
  readonly entries: ReadonlyArray<number>
  readonly resolved: ReadonlyMap<number, number>
}

/** @internal */
class TraversalFailure extends Data.TaggedError('MetadataTraversalFailure')<{
  readonly message: string
  readonly state: unknown
}> {
  constructor(message: string, state: unknown) {
    super({ message, state })
  }
}

/**
 * Traverses metadata reachable from named roots and attachments without recursion.
 *
 * **Gotchas**
 *
 * This low-level traversal throws a private implementation failure when reachable metadata is
 * malformed. Public renderers translate it once at their Effect boundary.
 *
 * @category metadata
 * @since 0.0.0
 */
export const reachable = (state: BuilderState.Snapshot, operation: string): Reachable => {
  const roots = [
    ...state.namedMetadata.flatMap((named) => named.operands),
    ...state.globalMetadata.flatMap((attachments) =>
      attachments.map((attachment) => attachment.metadata),
    ),
    ...state.functions.flatMap((fn) => {
      const body = fn.body
      return body === undefined
        ? []
        : [
            ...body.metadata.flatMap((attachments) =>
              attachments.map((attachment) => attachment.metadata),
            ),
            ...body.debugLocations.flatMap((location) =>
              location === undefined ? [] : [location],
            ),
          ]
    }),
  ]
  const visited = new Set<number>()
  const resolved = new Map<number, number>()
  const unresolved: Array<number> = []
  const stack = [...roots].reverse()
  while (stack.length > 0) {
    const index = stack.pop()
    if (index === undefined || visited.has(index)) continue
    visited.add(index)
    const entry = state.metadata[index]
    if (entry === undefined) {
      throw new TraversalFailure(`${operation}: reachable metadata entry is missing`, index)
    }
    if (entry._tag === 'Forward') {
      if (entry.target === undefined) unresolved.push(index)
      else {
        resolved.set(index, entry.target)
        stack.push(entry.target)
      }
    } else if (entry._tag === 'Node') {
      const references = MetadataDescription.references(entry.value)
      for (let offset = references.length - 1; offset >= 0; offset -= 1) {
        const reference = references[offset]
        if (reference !== undefined) stack.push(reference)
      }
    }
  }
  if (unresolved.length > 0) {
    throw new TraversalFailure(
      `${operation}: reachable metadata has unresolved forward references: ${unresolved.join(', ')}`,
      { references: unresolved, roots: roots },
    )
  }
  return {
    entries: state.metadata.flatMap((_entry, index) => (visited.has(index) ? [index] : [])),
    resolved,
  }
}
