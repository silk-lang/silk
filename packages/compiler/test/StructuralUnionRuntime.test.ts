import * as AnalysisFixture from './support/AnalysisFixture.js'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Analysis from '../src/Analysis.js'
import * as Mir from '../src/Mir.js'
import * as MirVerification from '../src/MirVerification.js'
import * as Type from '../src/Type.js'
import * as TypeCompatibility from '../src/TypeCompatibility.js'

const ascii = (value: string): Uint8Array =>
  Uint8Array.from(value, (character) => character.charCodeAt(0))

const source = `struct A {}
struct B { value: i32 }
struct C { left: i32 right: i32 }
fn accept(value: A | B | C) -> i32 { return 42 }
fn widen(value: A | B) -> i32 { return accept(move value) }
pub fn main() -> i32 { return widen(A {}) }`

it.effect('verifies union conversion with exact executable source identity', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'unions/executable-source',
      ascii(`fn add(left: i32, right: i32) -> i32 { return left + right }
fn selectedCallable() -> typeof(add) | i32 { return add }
fn selectedEffect() -> some<F: Effect<'static; i32>> F | i32 { return effect { return 42 } }
pub fn main() -> i32 { drop selectedCallable() drop selectedEffect() return 42 }`),
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    const program = Analysis.loweredMir(snapshot)
    assert.deepEqual(yield* MirVerification.verify(program), [])
    const conversions = program.functions.flatMap((fn) =>
      MirVerification.operations(fn).filter((operation) => operation._tag === 'ConvertUnion'),
    )
    assert.lengthOf(conversions, 2)
    assert.isTrue(conversions.every((operation) => Type.isRepresented(operation.sourceSemantic)))
    const invalid: Mir.Module = {
      ...program,
      functions: program.functions.map((fn) => ({
        ...fn,
        regions: fn.regions.map((region) =>
          region._tag !== 'OperationRegion'
            ? region
            : {
                ...region,
                operations: region.operations.map((operation) =>
                  operation._tag !== 'ConvertUnion'
                    ? operation
                    : { ...operation, sourceSemantic: 'i32' },
                ),
              },
        ),
      })),
    }
    assert.deepEqual(
      (yield* MirVerification.verify(invalid)).map((violation) => violation.rule),
      ['InvalidAggregateOperation', 'InvalidAggregateOperation'],
    )
  }),
)

it('computes canonical total member mappings', () => {
  const a = Type.nominal('unions/main', 'A')
  const b = Type.nominal('unions/main', 'B')
  const c = Type.nominal('unions/main', 'C')
  const narrow = Type.union([b, a])
  const wide = Type.union([c, a, b])
  assert.strictEqual(narrow._tag, 'Normalized')
  assert.strictEqual(wide._tag, 'Normalized')
  if (
    narrow._tag !== 'Normalized' ||
    wide._tag !== 'Normalized' ||
    !Type.isUnion(narrow.type) ||
    !Type.isUnion(wide.type)
  ) {
    return
  }
  const injection = TypeCompatibility.check(a, narrow.type)
  const widening = TypeCompatibility.check(narrow.type, wide.type)
  const narrowing = TypeCompatibility.check(wide.type, narrow.type)
  assert.strictEqual(injection._tag, 'Inject')
  assert.strictEqual(widening._tag, 'Widen')
  assert.strictEqual(narrowing._tag, 'Incompatible')
  if (widening._tag === 'Widen') {
    assert.deepEqual(
      widening.mappings.map((mapping) => [mapping.sourceOrdinal, mapping.targetOrdinal]),
      [
        [0, 0],
        [1, 1],
      ],
    )
  }
})

it.effect('emits native union conversion artifacts', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'unions/main',
      ascii(source),
      'aarch64-apple-darwin',
    )
    const artifact = yield* Analysis.codegen(snapshot, { mode: 'release' })
    assert.include(artifact.ir, 'union')
  }),
)

it.effect('diagnoses narrowing and non-containing union targets deterministically', () =>
  Effect.gen(function* () {
    const self = yield* AnalysisFixture.retainingMain(
      'union-invalid/main',
      ascii(`struct A {}
struct B {}
struct C {}
fn narrow(value: A | B) -> A { return move value }
fn accept(value: A | B) -> i32 { return 0 }
pub fn main() -> i32 { return accept(C {}) }`),
    )
    assert.deepEqual(
      Analysis.diagnostics(self).map((diagnostic) => diagnostic.code),
      ['SEM0040', 'SEM0040'],
    )
  }),
)
