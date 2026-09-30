import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Attribute from '../src/Attribute.js'
import * as Builder from '../src/Builder.js'
import { LlvmError } from '../src/LlvmError.js'
import * as Type from '../src/Type.js'

it.effect('interns every attribute storage shape and canonicalizes set ordering', () =>
  Effect.gen(function* () {
    const builder = yield* Builder.make()
    const i8 = yield* Type.integer(builder, 8)
    const noAlias = yield* Attribute.flag(builder, 'noalias')
    const dereferenceable = yield* Attribute.integer(builder, 'dereferenceable', 16n)
    const byValue = yield* Attribute.typeAttribute(builder, 'byval', i8)
    const targetCpu = yield* Attribute.string(builder, 'target-cpu', 'generic')
    const initializes = yield* Attribute.integerList(builder, 'initializes', [0n, 8n])
    // Locale collation ignores these distinct bytes; byte-oriented names must still have one
    // canonical set identity regardless of insertion order.
    const nulName = yield* Attribute.string(builder, Uint8Array.of(0), 'value')
    const controlName = yield* Attribute.string(builder, Uint8Array.of(1), 'value')
    const first = yield* Attribute.set(builder, [
      nulName,
      controlName,
      targetCpu,
      noAlias,
      byValue,
      dereferenceable,
      initializes,
    ])
    const second = yield* Attribute.set(builder, [
      controlName,
      nulName,
      initializes,
      dereferenceable,
      byValue,
      noAlias,
      targetCpu,
    ])

    assert.strictEqual(first, second)
    assert.lengthOf(yield* Attribute.entries(builder, first), 7)
  }),
)

it.effect('supports immutable editing and canonical function attribute positions', () =>
  Effect.gen(function* () {
    const builder = yield* Builder.make()
    const cold = yield* Attribute.flag(builder, 'cold')
    const noUnwind = yield* Attribute.flag(builder, 'nounwind')
    const empty = yield* Attribute.set(builder, [])
    const one = yield* Attribute.add(builder, empty, cold)
    const two = yield* Attribute.add(builder, one, noUnwind)
    const backToOne = yield* Attribute.remove(builder, two, noUnwind)
    const first = yield* Attribute.functionSet(builder, {
      functionAttributes: two,
      returnAttributes: empty,
      parameterAttributes: [one],
    })
    const second = yield* Attribute.functionSet(builder, {
      parameterAttributes: [backToOne],
      returnAttributes: empty,
      functionAttributes: yield* Attribute.set(builder, [noUnwind, cold]),
    })

    assert.strictEqual(backToOne, one)
    assert.strictEqual(first, second)
  }),
)

it.effect('rejects conflicting and cross-builder attribute sets', () =>
  Effect.gen(function* () {
    const first = yield* Builder.make()
    const second = yield* Builder.make()
    const left = yield* Attribute.integer(first, 'align', 8)
    const right = yield* Attribute.integer(first, 'align', 16)
    const conflict = yield* Effect.flip(Attribute.set(first, [left, right]))
    const set = yield* Attribute.set(first, [left])
    const ownerError = yield* Effect.flip(Attribute.entries(second, set))

    assert.include(conflict.message, 'conflicting values')
    assert.include(ownerError.message, 'different LLVM builder')
  }),
)

it.effect('validates integer payloads before bigint conversion', () =>
  Effect.gen(function* () {
    const builder = yield* Builder.make()
    for (const value of [1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      assert.instanceOf(yield* Effect.flip(Attribute.integer(builder, 'align', value)), LlvmError)
    }
    for (const value of [-1n, 0x1_0000_0000_0000_0000n]) {
      assert.instanceOf(yield* Effect.flip(Attribute.integer(builder, 'align', value)), LlvmError)
    }
    assert.instanceOf(
      yield* Effect.flip(Attribute.integerList(builder, 'initializes', [0, 1.5])),
      LlvmError,
    )
    assert.instanceOf(
      yield* Effect.flip(
        Attribute.integerList(builder, 'initializes', [0n, 0x1_0000_0000_0000_0000n]),
      ),
      LlvmError,
    )
  }),
)
