import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Alias from '../src/Alias.js'
import * as Attribute from '../src/Attribute.js'
import * as Builder from '../src/Builder.js'
import * as ByteString from '../src/ByteString.js'
import * as Constant from '../src/Constant.js'
import * as FunctionActor from '../src/Function.js'
import * as Global from '../src/Global.js'
import * as BuilderState from '../src/internal/BuilderState.js'
import { LlvmError } from '../src/LlvmError.js'
import * as Metadata from '../src/Metadata.js'
import * as Type from '../src/Type.js'
import * as Variable from '../src/Variable.js'

it.effect('creates, looks up, renames, configures, and removes ordered globals', () =>
  Effect.gen(function* () {
    const builder = yield* Builder.make()
    const i32 = yield* Type.integer(builder, 32)
    const initializer = yield* Constant.integerUnsigned(builder, i32, 7)
    const variable = yield* Variable.make(builder, 'answer', i32, {
      initializer,
      constant: true,
      linkage: 'internal',
    })
    const global = yield* Variable.global(builder, variable)

    assert.strictEqual(yield* Global.lookup(builder, 'answer'), global)
    assert.strictEqual((yield* Variable.properties(builder, variable)).initializer, initializer)
    assert.strictEqual((yield* Global.properties(builder, global)).linkage, 'internal')
    yield* Global.rename(builder, global, 'renamed')
    assert.isUndefined(yield* Global.lookup(builder, 'answer'))
    assert.strictEqual(yield* Global.lookup(builder, 'renamed'), global)
    yield* Global.remove(builder, global)
    assert.isUndefined(yield* Global.lookup(builder, 'renamed'))
  }),
)

it.effect('rejects duplicate declarations without disturbing the original', () =>
  Effect.gen(function* () {
    const builder = yield* Builder.make()
    const i32 = yield* Type.integer(builder, 32)
    const original = yield* Variable.make(builder, 'occupied', i32)
    const duplicate = yield* Effect.flip(Variable.make(builder, 'occupied', i32))

    assert.include(duplicate.message, 'already occupied')
    assert.strictEqual(
      yield* Global.lookup(builder, 'occupied'),
      yield* Variable.global(builder, original),
    )
  }),
)

it.effect('keeps declaration state unchanged after foreign-handle rejection', () =>
  Effect.gen(function* () {
    const foreignBuilder = yield* Builder.make({ strip: false })
    const foreignI32 = yield* Type.integer(foreignBuilder, 32)
    const foreignConstant = yield* Constant.integerUnsigned(foreignBuilder, foreignI32, 1)
    const foreignMetadata = yield* Metadata.tuple(foreignBuilder)
    const builder = yield* Builder.make()
    const i32 = yield* Type.integer(builder, 32)
    const signature = yield* Type.functionType(builder, i32, [])

    for (const option of ['prefix', 'prologue'] as const) {
      const before = yield* BuilderState.snapshot(builder, 'Global.test')
      const failure = yield* Effect.flip(
        FunctionActor.declare(
          builder,
          option,
          signature,
          option === 'prefix' ? { prefix: foreignConstant } : { prologue: foreignConstant },
        ),
      )

      assert.instanceOf(failure, LlvmError)
      assert.strictEqual(failure.reason._tag, 'InvalidState')
      assert.deepEqual(yield* BuilderState.snapshot(builder, 'Global.test'), before)
      assert.isUndefined(yield* Global.lookup(builder, option))
      const declared = yield* FunctionActor.declare(builder, option, signature)
      assert.strictEqual(
        yield* FunctionActor.declare(
          builder,
          option,
          signature,
          option === 'prefix' ? { prefix: foreignConstant } : { prologue: foreignConstant },
        ),
        declared,
      )
    }

    const retained = yield* Builder.make({ strip: false })
    const retainedI32 = yield* Type.integer(retained, 32)
    const retainedBefore = yield* BuilderState.snapshot(retained, 'Global.test')
    const retainedFailure = yield* Effect.flip(
      Variable.make(retained, 'debug', retainedI32, {
        debugExpressions: [foreignMetadata],
      }),
    )

    assert.instanceOf(retainedFailure, LlvmError)
    assert.strictEqual(retainedFailure.reason._tag, 'InvalidState')
    assert.deepEqual(yield* BuilderState.snapshot(retained, 'Global.test'), retainedBefore)
    assert.isUndefined(yield* Global.lookup(retained, 'debug'))
    yield* Variable.make(retained, 'debug', retainedI32)

    const stripped = yield* Builder.make()
    const strippedI32 = yield* Type.integer(stripped, 32)
    yield* Variable.make(stripped, 'debug', strippedI32, {
      debugExpressions: [foreignMetadata],
    })
  }),
)

it.effect('creates aliases and atomically converts an existing global category', () =>
  Effect.gen(function* () {
    const builder = yield* Builder.make()
    const i32 = yield* Type.integer(builder, 32)
    const target = yield* Variable.make(builder, 'target', i32)
    const targetPointer = yield* Constant.fromGlobal(
      builder,
      yield* Variable.global(builder, target),
    )
    const source = yield* Variable.make(builder, 'source', i32)
    const sourceGlobal = yield* Variable.global(builder, source)
    const alias = yield* Alias.fromGlobal(builder, sourceGlobal, i32, targetPointer)
    const staleVariable = yield* Effect.flip(Variable.properties(builder, source))

    assert.strictEqual(yield* Alias.aliasee(builder, alias), targetPointer)
    assert.strictEqual(yield* Global.kind(builder, sourceGlobal), 'Alias')
    assert.include(staleVariable.message, 'no longer active')
  }),
)

it.effect('canonicalizes compatible function declarations and round-trips properties', () =>
  Effect.gen(function* () {
    const builder = yield* Builder.make()
    const i32 = yield* Type.integer(builder, 32)
    const type = yield* Type.functionType(builder, i32, [i32])
    const nounwind = yield* Attribute.flag(builder, 'nounwind')
    const attributes = yield* Attribute.functionSet(builder, {
      functionAttributes: yield* Attribute.set(builder, [nounwind]),
    })
    const first = yield* FunctionActor.declare(builder, 'compute', type, {
      callingConvention: 8,
      attributes,
      linkage: 'external',
    })
    const second = yield* FunctionActor.declare(builder, 'compute', type, {
      callingConvention: 8,
      attributes,
    })
    const incompatible = yield* Effect.flip(
      FunctionActor.declare(builder, 'compute', type, { callingConvention: 9 }),
    )

    assert.strictEqual(first, second)
    assert.strictEqual((yield* FunctionActor.properties(builder, first)).attributes, attributes)
    assert.include(incompatible.message, 'incompatible global')
  }),
)

it.effect('preserves exact byte identities across declaration and lookup', () =>
  Effect.gen(function* () {
    const builder = yield* Builder.make()
    const signature = yield* Type.functionType(builder, yield* Type.voidType(builder), [])
    // Cover every byte, including NUL and invalid UTF-8, and distinguish long equal-length
    // names that differ at their interior or final byte.
    const longName = Uint8Array.from({ length: 16_385 }, (_, index) => index % 256)
    const names = [
      Uint8Array.from({ length: 256 }, (_, byte) => byte),
      Uint8Array.of(0x01, 0x23),
      Uint8Array.of(0x12, 0x03),
      longName.subarray(0, 8191),
      longName.subarray(0, 8192),
      longName.subarray(0, 8193),
      longName,
      longName.with(8191, 0),
      longName.with(8192, 0xff),
      longName.with(16_384, 0xff),
    ]
    const handles: Array<FunctionActor.Function> = []
    for (const input of names) {
      const name = ByteString.fromUint8Array(input)
      const fn = yield* FunctionActor.declare(builder, name, signature)
      const global = yield* FunctionActor.global(builder, fn)
      assert.strictEqual(yield* FunctionActor.declare(builder, name, signature), fn)
      assert.strictEqual(yield* Global.lookup(builder, name), global)
      assert.strictEqual(yield* Global.lookup(builder, input), global)
      assert.deepEqual(yield* Global.name(builder, global), name)
      handles.push(fn)
    }
    assert.strictEqual(new Set(handles).size, names.length)
  }),
)

it.effect('replaces globals while preserving stale global indirection', () =>
  Effect.gen(function* () {
    const builder = yield* Builder.make()
    const i8 = yield* Type.integer(builder, 8)
    const first = yield* Variable.global(builder, yield* Variable.make(builder, 'first', i8))
    const second = yield* Variable.global(builder, yield* Variable.make(builder, 'second', i8))
    yield* Global.replace(builder, first, second)

    assert.deepEqual(yield* Global.name(builder, first), yield* Global.name(builder, second))
    assert.isUndefined(yield* Global.lookup(builder, 'first'))
  }),
)
