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
  let values = Vector<i32>.make()
  let count = Vector<i32>.length(&values)
  drop values
  if count == 0 { return 0 }
  return 1
}`

/** A qualified member call accepts an exclusive borrow argument. */
const exclusive = `import silk.vector { Vector }

pub fn main() -> i32 {
  let mut values = Vector<i32>.make()
  let slice = Vector<i32>.asMutSlice(&mut values)
  drop slice
  let count = Vector<i32>.length(&values)
  drop values
  if count == 0 { return 0 }
  return 1
}`

/** A borrow in a position that wants an owned value is still an invalid borrow position. */
const ownedPosition = `import silk.vector { Vector }

pub fn main() -> i32 {
  let values = Vector<i32>.make()
  let taken = Vector<i32>.get(&values, &values)
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
  return Option<View<'a>>.some(View<'a> { value: &self.value })
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

it.effect('ends loans a match arm holds at the arm and keeps a joining branch loan held', () =>
  Effect.gen(function* () {
    const source = `struct Token { value: i32 }
union Packet { Empty, Ready { left: Token, right: Token } }
fn bump(token: &mut Token) -> () {
  token.value = token.value + 1
  return ()
}
fn armBinding() -> i32 {
  let mut packet = Packet.Ready { left: Token { value: 1 }, right: Token { value: 2 } }
  match &mut packet {
    Packet.Ready { left, .. } => {
      let view = &mut left
      bump(move view)
    }
    Packet.Empty => {}
  }
  return 0
}
fn armOuter() -> i32 {
  let mut token = Token { value: 1 }
  let packet = Packet.Empty
  match &packet {
    Packet.Ready { .. } => {}
    Packet.Empty => {
      let view = &mut token
      bump(move view)
    }
  }
  return token.value
}
fn acrossReturn(flag: bool) -> i32 {
  let mut token = Token { value: 1 }
  let view = &mut token
  if flag { return 1 }
  bump(move view)
  return 0
}
pub fn main() -> i32 { return armBinding() + armOuter() + acrossReturn(false) }`
    const self = yield* AnalysisFixture.retainingMain('qualified-borrow/arm-loans', ascii(source))
    assert.deepEqual(Analysis.diagnostics(self), [])
    const mir = Analysis.loweredMir(self)
    // A loan a statement arm's own binding holds ends with that arm on its fall-through path.
    assert.deepEqual(yield* MirVerification.verify(mir), [])
    // A branch that returns never reaches the join, so the loan the other branch carries into it
    // stays held through the later use and ends only at the function's exits.
    const across = mir.functions.find(
      (fn) => fn.id._tag === 'CanonicalDeclarationId' && fn.id.name === 'acrossReturn',
    )
    assert.isDefined(across)
    const endings = (across?.regions ?? []).flatMap((region) =>
      region._tag === 'OperationRegion' || region._tag === 'CleanupRegion'
        ? (region._tag === 'OperationRegion' ? region.operations : region.releases)
            .filter((operation) => operation._tag === 'EndLoan')
            .map(() => region.outcome._tag)
        : [],
    )
    assert.deepEqual(endings, ['Return', 'Return'])
  }),
)
