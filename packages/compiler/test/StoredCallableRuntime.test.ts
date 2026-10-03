import * as AnalysisFixture from './support/AnalysisFixture.js'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Analysis from '../src/Analysis.js'
import * as Backend from '../src/Backend.js'
import * as LlvmBackend from '../src/LlvmBackend.js'
import * as NativeToolchain from '../src/NativeToolchain.js'
import * as Target from '../src/Target.js'

const ascii = (value: string): Uint8Array =>
  Uint8Array.from(value, (character) => character.charCodeAt(0))

const lowerStored = Effect.fnUntraced(function* (
  name: string,
  source: string,
  target: Target.Target,
) {
  const snapshot = yield* AnalysisFixture.retainingMain(name, ascii(source), target.id)
  assert.deepEqual(Analysis.diagnostics(snapshot), [], name)
  return { snapshot, module: Analysis.loweredMir(snapshot) }
})

const named = `struct Parser<F: fn<'static>(i32) -> i32> { parse: F }
fn decode(value: i32) -> i32 { return value + 2 }
pub fn main() -> i32 {
  let parser = Parser { parse: decode }
  return parser.parse(40)
}`

const copiedCapture = `import silk.i32
struct Parser<F: fn<'static>(i32) -> i32> { parse: F }
pub fn main() -> i32 {
  let parser = Parser { parse: i32.add(2) }
  return parser.parse(40)
}`

const sharedReuse = `import silk.i32
struct Parser<F: fn<'static>(i32) -> i32> { parse: F }
pub fn main() -> i32 {
  let parser = Parser { parse: i32.add(1) }
  return parser.parse(20) + parser.parse(20)
}`

const nested = `import silk.i32
struct Parser<F: fn<'static>(i32) -> i32> { parse: F }
struct Boxed<F: fn<'static>(i32) -> i32> { inner: Parser<F> }
fn box<F: fn<'static>(i32) -> i32>(inner: Parser<F>) -> Boxed<F> {
  return Boxed<F> { inner: move inner }
}
pub fn main() -> i32 {
  let parser = Parser { parse: i32.add(2) }
  let boxed = box(move parser)
  return boxed.inner.parse(40)
}`

const takeDeclarations = `struct Token { value: i32 }
struct Holder<F: once fn<'static>(i32) -> i32> { step: F }
fn consume(value: i32, token: Token) -> i32 { return value + token.value }
`

const uncalled = `${takeDeclarations}pub fn main() -> i32 {
  let token = Token { value: 2 }
  let holder = Holder { step: consume(move token) }
  return 42
}`

const called = `${takeDeclarations}pub fn main() -> i32 {
  let token = Token { value: 2 }
  let holder = Holder { step: consume(move token) }
  return holder.step(40)
}`

const moved = `${takeDeclarations}fn keep<F: once fn<'static>(i32) -> i32>(holder: Holder<F>) -> i32 {
  return 42
}
pub fn main() -> i32 {
  let token = Token { value: 2 }
  let holder = Holder { step: consume(move token) }
  return keep(move holder)
}`

const scopedBorrow = `struct Holder<'env, F: mut fn<'env>(i32) -> i32> { step: F }
fn write(value: i32, values: &mut [i32]) -> i32 {
  values[0] = value
  return values[0]
}
pub fn main() -> i32 {
  let mut values = [0]
  let mut holder = Holder { step: write(&mut values) }
  let result = holder.step(42)
  drop holder
  return values[0] + result - 42
}`

const specializedCapture = `struct Token<T> { value: T }
struct Holder<'env, F: once fn<'env>(i32) -> i32> { step: F }
fn consume<T>(value: i32, token: Token<T>) -> i32 { return value }
fn apply<T>(token: Token<T>, value: i32) -> i32 {
  let holder = Holder { step: consume<T>(move token) }
  return holder.step(value)
}
pub fn main() -> i32 {
  return apply<i32>(Token<i32> { value: 1 }, 20) + apply<bool>(Token<bool> { value: true }, 22)
}`

const equalShapeSpecializations = `import silk.i32
struct Holder<F: fn<'static>(i32) -> i32> { step: F }
fn apply<T>(marker: T, value: i32) -> i32 {
  let holder = Holder { step: i32.add(1) }
  return holder.step(value)
}
pub fn main() -> i32 { return apply<i32>(0, 20) + apply<bool>(true, 20) }`

const runtimeMatrix = [
  { source: named, target: 'decode' },
  { source: copiedCapture, target: 'silk_i32_add' },
  { source: sharedReuse, target: 'silk_i32_add' },
  { source: nested, target: 'silk_i32_add' },
  { source: uncalled, target: 'consume' },
  { source: called, target: 'consume' },
  { source: moved, target: 'consume' },
  { source: scopedBorrow, target: 'write' },
  { source: specializedCapture, target: 'consume' },
  { source: equalShapeSpecializations, target: 'silk_i32_add' },
] as const

it.effect('lowers the same stored-callable matrix through static native LLVM targets', () =>
  Effect.gen(function* () {
    const target = yield* NativeToolchain.hostTarget()
    for (const [ordinal, testCase] of runtimeMatrix.entries()) {
      const { module } = yield* lowerStored(
        `stored-callable-runtime/native-${ordinal}`,
        testCase.source,
        target,
      )
      const artifact = yield* Backend.emit(LlvmBackend.LlvmBackend, module, {
        mode: 'release',
        verifyIr: true,
      })
      assert.strictEqual(artifact._tag, 'LlvmBitcodeArtifact')
      if (artifact._tag !== 'LlvmBitcodeArtifact') return
      assert.isTrue(artifact.symbols.some((entry) => entry.declaration.name === 'main'))
      assert.notInclude(artifact.ir, '@silk_main')
      assert.include(artifact.ir, testCase.target)
    }
  }),
)
