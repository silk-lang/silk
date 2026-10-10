import * as AnalysisFixture from './support/AnalysisFixture.js'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Analysis from '../src/Analysis.js'
import * as MirVerification from '../src/MirVerification.js'

const ascii = (value: string): Uint8Array =>
  Uint8Array.from(value, (character) => character.charCodeAt(0))

const codes = (snapshot: Analysis.Snapshot): ReadonlyArray<string> =>
  Analysis.diagnostics(snapshot).map((diagnostic) => diagnostic.code)

it.effect('requires an explicit shared reborrow of an exclusive reference', () =>
  Effect.gen(function* () {
    const source = `fn read(value: &i32) -> i32 { return value.* }
fn rejected(value: &mut i32) -> i32 { return read(move value) }
fn accepted(value: &mut i32) -> i32 { return read(&value.*) }
pub fn main() -> i32 { return 0 }`
    const snapshot = yield* AnalysisFixture.retainingMain('borrow/access-mode', ascii(source))
    assert.deepEqual(
      Analysis.diagnostics(snapshot).map(({ code, span }) => ({
        code,
        start: span.start,
        end: span.end,
      })),
      [
        {
          code: 'SEM0052',
          start: source.indexOf('read(move value)'),
          end: source.indexOf('read(move value)') + 'read(move value)'.length,
        },
      ],
    )
  }),
)

/** A qualified member call accepts a shared borrow argument. */
const shared = `import silk.vector { Vector }

pub fn main() -> i32 {
  let values = Vector.make<i32>()
  let count = Vector.length<i32>(&values)
  drop values
  if count == 0 { return 0 }
  return 1
}`

/** A qualified member call accepts an exclusive borrow argument. */
const exclusive = `import silk.vector { Vector }

pub fn main() -> i32 {
  let mut values = Vector.make<i32>()
  let slice = Vector.asMutSlice<i32>(&mut values)
  drop slice
  let count = Vector.length<i32>(&values)
  drop values
  if count == 0 { return 0 }
  return 1
}`

/** A borrow in a position that wants an owned value is still an invalid borrow position. */
const ownedPosition = `import silk.vector { Vector }

pub fn main() -> i32 {
  let values = Vector.make<i32>()
  let taken = Vector.get<i32>(&values, &values)
  drop taken
  drop values
  return 0
}`

it.effect('accepts a shared borrow through the qualified spelling', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain('borrow/program', ascii(shared))
    assert.deepEqual(codes(snapshot), [])
  }),
)

it.effect('accepts an exclusive borrow through the qualified spelling', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain('borrow/exclusive', ascii(exclusive))
    assert.deepEqual(codes(snapshot), [])
  }),
)

it.effect('still rejects a borrow where the parameter wants an owned value', () =>
  Effect.gen(function* () {
    // `get`'s second parameter is a `usize`, so the natural reference type is incompatible.
    const snapshot = yield* AnalysisFixture.retainingMain('borrow/owned', ascii(ownedPosition))
    assert.deepEqual(codes(snapshot), ['SEM0012'])
  }),
)

it.effect('ends a returned nominal view after matching it through an exclusive reborrow', () =>
  Effect.gen(function* () {
    const source = `import silk.option { Option }
struct Provider {}
struct Connection<P> { value: i32 provider: P }
struct View<'a> { value: &'a i32 }
fn view<'a, P>(self: &'a Connection<P>) -> Option<View<'a>> {
  return Option.some<View<'a>>(View<'a> { value: &self.value })
}
fn valid(value: &View) -> bool { return value.value.* == 0 }
effect fn use<P>(connection: &mut Connection<P>) -> i32 {
  let selected = view(&connection.*)
  match move selected {
    Option.None => { return 1 }
    Option.Some {value} => { if !valid(&value) { return 2 } }
  }
  connection.value = 42
  return connection.value
}
pub fn main() -> i32 {
  let mut connection = Connection<Provider> { value: 0, provider: Provider {} }
  return run use(&mut connection)
}`
    const self = yield* AnalysisFixture.retainingMain(
      'qualified-borrow/nominal-view',
      ascii(source),
    )
    assert.deepEqual(Analysis.diagnostics(self), [])
    assert.deepEqual(yield* MirVerification.verify(Analysis.loweredMir(self)), [])
  }),
)

it.effect('reads sibling fields while constructing a borrowed field slice', () =>
  Effect.gen(function* () {
    const source = `import silk.slice { Slice }
struct Bytes { values: [u8; 4] }
struct Packet { bytes: Bytes offset: usize length: usize }
fn view<'a>(bytes: &'a Bytes) -> &'a [u8] { return &bytes.values }
fn read(packet: &mut Packet) -> usize {
  let selected = Slice.view<u8>(view(&packet.bytes), packet.offset, packet.length - packet.offset)
  return selected.length
}
pub fn main() -> i32 {
  let mut packet = Packet { bytes: Bytes { values: [1, 2, 3, 4] }, offset: 1, length: 4 }
  if read(&mut packet) == 3 { return 42 }
  return 1
}`
    const self = yield* AnalysisFixture.retainingMain('qualified-borrow/field-view', ascii(source))
    assert.deepEqual(Analysis.diagnostics(self), [])
    const mir = Analysis.loweredMir(self)
    assert.deepEqual(yield* MirVerification.verify(mir), [])
    const wholeOwnerRead = {
      ...mir,
      functions: mir.functions.map((fn) => ({
        ...fn,
        regions: fn.regions.map((region) =>
          region._tag !== 'OperationRegion'
            ? region
            : {
                ...region,
                operations: region.operations.map((operation) =>
                  operation._tag !== 'ReadPlace'
                    ? operation
                    : {
                        ...operation,
                        selectors: [],
                      },
                ),
              },
        ),
      })),
    }
    assert.include(
      (yield* MirVerification.verify(wholeOwnerRead)).map((violation) => violation.rule),
      'InvalidLoan',
    )
  }),
)
