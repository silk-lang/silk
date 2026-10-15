import * as Target from '../src/Target.js'
import { assert, it } from '@effect/vitest'
import * as Intrinsic from '../src/Intrinsic.js'
import * as Scalar from '../src/Scalar.js'
import * as Type from '../src/Type.js'
import { corpusProgram } from './support/corpus.js'
import { floatOperationMatrix, integerOperationMatrix } from './support/scalarOperationMatrix.js'

it('owns the current scalar vocabulary in stable presentation order', () => {
  assert.deepEqual(
    Scalar.all().map((scalar) => scalar.spelling),
    [
      'bool',
      'u8',
      'u16',
      'u32',
      'u64',
      'usize',
      'i8',
      'i16',
      'i32',
      'i64',
      'isize',
      'f32',
      'f64',
      'char',
    ],
  )
  assert.strictEqual(Scalar.isSpelling('i32'), true)
  assert.strictEqual(Scalar.isSpelling('String'), false)
  assert.strictEqual(Scalar.isSpelling('char'), true)
  assert.strictEqual(Scalar.isCharacterSpelling('char'), true)
  assert.strictEqual(Scalar.isIntegerSpelling('char'), false)
  for (const scalar of Scalar.all()) assert.strictEqual(Scalar.find(scalar.spelling), scalar)
  assert.strictEqual(Scalar.find('String'), undefined)
  assert.notInclude(
    Scalar.integers().map((scalar): string => scalar.spelling),
    'char',
  )
  assert.strictEqual(Type.isBuiltin('usize'), true)
})

it('resolves fixed and target-width scalar facts without phase-specific cases', () => {
  assert.strictEqual(Scalar.bits(Scalar.defaultInteger, 64), 32)
  assert.strictEqual(Scalar.bits(Scalar.pointerInteger, 64), 64)
  assert.deepEqual(Scalar.resolveLayout(Scalar.pointerInteger, Target.aarch64AppleDarwin), {
    size: 8,
    alignment: 8,
  })
  assert.deepEqual(
    Scalar.defaultInteger.operations.map((candidate) => candidate.spelling),
    [
      'negate',
      'wrappingNegate',
      'saturatingNegate',
      'toU8',
      'checkedToU8',
      'toU16',
      'checkedToU16',
      'toU32',
      'checkedToU32',
      'toU64',
      'checkedToU64',
      'toUsize',
      'checkedToUsize',
      'toI8',
      'checkedToI8',
      'toI16',
      'checkedToI16',
      'toI32',
      'checkedToI32',
      'toI64',
      'checkedToI64',
      'toIsize',
      'checkedToIsize',
      'toF32',
      'toF64',
      'add',
      'subtract',
      'multiply',
      'divide',
      'remainder',
      'bitAnd',
      'bitOr',
      'bitXor',
      'bitNot',
      'shiftLeft',
      'shiftRight',
      'rotateLeft',
      'rotateRight',
      'wrappingAdd',
      'wrappingSubtract',
      'wrappingMultiply',
      'saturatingAdd',
      'saturatingSubtract',
      'saturatingMultiply',
      'checkedAdd',
      'checkedSubtract',
      'checkedMultiply',
      'checkedDivide',
      'checkedRemainder',
      'equals',
      'notEquals',
      'lessThan',
      'lessOrEqual',
      'greaterThan',
      'greaterOrEqual',
    ],
  )
  assert.deepEqual(
    Scalar.character.operations.map((candidate) => candidate.spelling),
    [
      'fromU32',
      'toU32',
      'equals',
      'notEquals',
      'lessThan',
      'lessOrEqual',
      'greaterThan',
      'greaterOrEqual',
    ],
  )
  assert.deepEqual(Scalar.character.width, { _tag: 'FixedWidth', bits: 32 })
  assert.deepEqual(Scalar.resolveLayout(Scalar.character, Target.aarch64AppleDarwin), {
    size: 4,
    alignment: 4,
  })
  const intrinsic = Intrinsic.findActor('Intrinsic')
  assert.notStrictEqual(intrinsic, undefined)
  for (const scalar of Scalar.all()) {
    for (const operation of scalar.operations) {
      const resolved = Intrinsic.findOperation(scalar.spelling, operation.spelling)
      assert.notStrictEqual(resolved, undefined)
      assert.strictEqual(resolved?.rule._tag, 'BuiltinRule')
      if (resolved?.rule._tag === 'BuiltinRule')
        assert.strictEqual(resolved.rule.operation, operation.code)
    }
  }
})

// The corpus stores both operation matrices as data; regenerating them from the scalar vocabulary
// must reproduce the checked-in programs byte for byte.
it('keeps the corpus operation matrices generated from the scalar vocabulary', () => {
  assert.strictEqual(corpusProgram('integer-operation-matrix').source, integerOperationMatrix)
  assert.strictEqual(corpusProgram('float-operation-matrix').source, floatOperationMatrix)
})
