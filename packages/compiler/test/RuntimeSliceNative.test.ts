import * as AnalysisFixture from './support/AnalysisFixture.js'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Analysis from '../src/Analysis.js'
import * as NativeFunction from '../src/NativeFunction.js'
import * as MirLinearization from '../src/MirLinearization.js'
import * as MirVerification from '../src/MirVerification.js'

const ascii = (value: string): Uint8Array =>
  Uint8Array.from(value, (character) => character.charCodeAt(0))

const source = `import silk.usize
struct Pair { left: i32 right: i32 }
fn replace(values: &mut [Pair], index: usize) -> i32 {
  values[index] = Pair { left: 40, right: 2 }
  return usize.toI32(values.length)
}
pub fn main() -> i32 {
  let mut values = [Pair { left: 1, right: 2 }, Pair { left: 3, right: 4 }]
  let length = replace(&mut values, 1)
  return values[1].left + length
}`

it.effect('emits typed pointer lanes and stride-aware storage in native artifacts', () =>
  Effect.gen(function* () {
    const self = yield* AnalysisFixture.retainingMain(
      'runtime-slice-native/main',
      ascii(source),
      'aarch64-apple-darwin',
    )
    assert.deepEqual(Analysis.diagnostics(self), [])
    const artifact = yield* Analysis.codegen(self, { mode: 'release' })

    assert.include(artifact.ir, 'ptr %')
    assert.include(artifact.ir, 'alloca i8')
    assert.include(artifact.ir, 'getelementptr i8')
    assert.include(artifact.ir, 'slice')
    assert.include(artifact.ir, 'store i32')
  }),
)

it.effect('loads a projected slice descriptor and checks its runtime bound before indexing', () =>
  Effect.gen(function* () {
    const self = yield* AnalysisFixture.retainingMain(
      'runtime-slice-native/projected',
      ascii(`struct Pair { left: i32 right: i32 }
struct Holder { padding: i32 values: &[Pair] }
fn read(holder: &Holder, index: usize) -> i32 {
  return holder.values[index].right
}
pub fn main() -> i32 {
  let values = [Pair { left: 1, right: 2 }, Pair { left: 3, right: 4 }]
  let holder = Holder { padding: 9, values: &values }
  let holders = [Holder { padding: 7, values: &values }]
  let index: usize = 0
  let views = &holders
  return read(&holder, 1) + holder.values[0].left + holders[index].values[0].right + views[0].values[1].right
}`),
      'aarch64-apple-darwin',
    )
    assert.deepEqual(Analysis.diagnostics(self), [])
    const artifact = yield* Analysis.codegen(self, { mode: 'debug' })
    assert.match(artifact.ir, /slice[0-9]+_in_bounds = icmp ult i64/)
    assert.match(artifact.ir, /br i1 .*slice[0-9]+_in_bounds/)
    assert.match(artifact.ir, /slice[0-9]+_element_offset = mul i64 .*, 8/)
    assert.match(
      artifact.ir,
      /%slice(\d+)_element = getelementptr i8, ptr %\w+, i64 %slice\1_element_offset/,
    )
    assert.match(
      artifact.ir,
      /%slice(\d+)_selected = getelementptr i8, ptr %slice\1_element, i32 4\n\s+%\w+ = load i32, ptr %slice\1_selected/,
    )
  }),
)

it.effect('rebinds a whole slice descriptor without treating it as an indexed write', () =>
  Effect.gen(function* () {
    const self = yield* AnalysisFixture.retainingMain(
      'runtime-slice-native/rebind',
      ascii(`fn choose(flag: bool) -> u8 {
  let mut view: &[u8] = b"old"
  if flag { view = b"new value" }
  if !flag { view = b"old again" }
  return view[0]
}
pub fn main() -> i32 {
  if choose(true) == 110 && choose(false) == 111 { return 42 }
  return 0
}`),
      'aarch64-apple-darwin',
    )
    assert.deepEqual(Analysis.diagnostics(self), [])
    const mir = Analysis.loweredMir(self)
    assert.deepEqual(yield* MirVerification.verify(mir), [])
    const main = mir.functions.find((fn) => fn.id.name === 'choose')
    assert.ok(main)
    const operations = MirVerification.operations(main)
    assert.isTrue(
      operations.some(
        (operation) =>
          operation._tag === 'CheckPlace' &&
          operation.selectors.length === 0 &&
          main.localTypes.at(operation.root.ordinal)?._tag === 'Slice',
      ),
    )
    assert.isTrue(
      operations.some(
        (operation) =>
          operation._tag === 'WritePlace' &&
          operation.selectors.length === 0 &&
          operation.rootType._tag === 'Slice',
      ),
    )
    const mutable = NativeFunction.discoverRoots(main, MirLinearization.linearize(main)).mutable
    const writes = operations.filter((operation) => operation._tag === 'WritePlace')
    assert.isTrue(writes.every((write) => mutable.has(write.root.ordinal)))
    yield* Analysis.codegen(self, { mode: 'debug' })
  }),
)
