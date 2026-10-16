import * as AnalysisFixture from './support/AnalysisFixture.js'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Analysis from '../src/Analysis.js'
import * as Mir from '../src/Mir.js'
import * as MirVerification from '../src/MirVerification.js'
import { unreachable } from './support/raise.js'

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

it.effect(
  'ends loans an arm or iteration holds at its end and keeps a joining branch loan held',
  () =>
    Effect.gen(function* () {
      const source = `struct Token { value: i32 }
union Packet { Empty, Ready { left: Token, right: Token } }
struct Holder { value: i32 }
union Choice { Skip, Take }
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
fn firstMatching(entries: &[Token], wanted: i32) -> i32 {
  let mut entry: usize = 0
  while entry < entries.length {
    let candidate = &entries[entry]
    if candidate.value == wanted { return candidate.value }
    entry = entry + 1
  }
  return 0
}
fn tokens(values: &[Token]) -> &[Token] { return values }
struct Shelf {
  items: [Token; 2]
}
fn foundOrBreak(shelf: &Shelf, wanted: i32) -> i32 {
  let found = tokens(&shelf.items)
  let mut entry: usize = 0
  while entry < found.length {
    if found[entry].value == wanted {
      if let Token { value } = &found[entry] { return value }
      break
    }
    entry = entry + 1
  }
  return 0
}
struct Missing {}
effect fn missing() -> never ! Missing { fail Missing {} }
effect fn absent(error: Missing) -> i32 { drop error return 0 }
effect fn lastMatching(shelf: &Shelf, wanted: i32) -> i32 ! Missing {
  let found = tokens(&shelf.items)
  let mut entry: usize = 0
  while entry < found.length {
    if found[entry].value == wanted { return found[entry].value }
    entry = entry + 1
  }
  return run missing()
}
fn returnInArm(shelf: &Shelf) -> i32 {
  let found = tokens(&shelf.items)
  let mut entry: usize = 0
  while entry < found.length {
    let value = found[entry].value
    let choice = Choice.Take
    match move choice {
      Choice.Take => {
        if value == 4 { return value }
      }
      Choice.Skip => {}
    }
    entry = entry + 1
  }
  return 0
}
union Parcel { Empty, Ready { choice: Choice } }
fn returnInNestedArm(shelf: &Shelf) -> i32 {
  let found = tokens(&shelf.items)
  let mut entry: usize = 0
  while entry < found.length {
    let value = found[entry].value
    let packet = Parcel.Ready { choice: Choice.Skip }
    match move packet {
      Parcel.Empty => {}
      Parcel.Ready { choice } => match move choice {
        Choice.Take => { return value }
        Choice.Skip => { return 0 }
      }
    }
    entry = entry + 1
  }
  return 0
}
fn readInIfLet(shelf: &Shelf, wanted: Parcel) -> i32 {
  let found = tokens(&shelf.items)
  if found.length == 0 { return 0 }
  if let Parcel.Ready { choice } = move wanted {
    return found[1].value
  }
  return 1
}
fn copyInto(entry: &mut Holder, output: &mut Token) -> () {
  output.value = entry.value
  return ()
}
fn visit<F: once fn(&mut Holder) -> ()>(holder: &mut Holder, use: F) -> bool {
  if holder.value == 0 { return false }
  use(&mut holder.*)
  return true
}
effect fn finish(holder: &mut Holder, value: i32) -> i32 {
  holder.value = value
  return value
}
effect fn endedInOneArm(holder: &mut Holder, choice: Choice) -> i32 {
  let mut handles = Token { value: 0 }
  let found = visit(&mut holder.*, copyInto(&mut handles))
  if !found { drop handles return 0 }
  let Token { value } = move handles
  return match move choice {
    Choice.Skip => value
    Choice.Take => run finish(move holder, value)
  }
}
pub fn main() -> i32 {
  let tokens = [Token { value: 1 }, Token { value: 2 }]
  let shelf = Shelf { items: [Token { value: 3 }, Token { value: 4 }] }
  let mut holder = Holder { value: 1 }
  let ended = run endedInOneArm(&mut holder, Choice.Take)
  let last = run Intrinsic.catchFailure<Missing>(lastMatching(&shelf, 4), absent)
  return armBinding() + armOuter() + acrossReturn(false) + firstMatching(&tokens, 2) + ended +
    foundOrBreak(&shelf, 3) + last + returnInArm(&shelf) +
    returnInNestedArm(&shelf) + readInIfLet(&shelf, Parcel.Empty)
}`
      const self = yield* AnalysisFixture.retainingMain('qualified-borrow/arm-loans', ascii(source))
      assert.deepEqual(Analysis.diagnostics(self), [])
      const mir = Analysis.loweredMir(self)
      // A loan a statement arm's or a loop body's own binding holds ends with that arm or iteration
      // on its fall-through path, and a loan from before a match that one arm ends is ended by the
      // other joining arms rather than again after the join. A loan a loop ends at its exit also
      // ends at a return in one of its arms, and a return whose value diverges still ends the loans
      // it holds. An \`if let\` selection ends no loan its body still reads.
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

it.effect('drops a borrowed temporary only after every value that may retain its view', () =>
  Effect.gen(function* () {
    const source = `import silk.ownership { Drop }
struct Token { value: i32 }
impl Drop for Token { fn drop(self: &mut Token) -> () { self.value = 0 return () } }
fn make(value: i32) -> Token { return Token { value: value } }
fn identity<'a>(view: &'a [Token]) -> &'a [Token] { return view }
fn read(view: &[Token]) -> i32 { return view[0].value }
struct Holder<'a> { view: &'a [Token] }
impl<'a> Drop for Holder<'a> { fn drop(self: &mut Holder<'a>) -> () { let seen = read(self.view) return () } }
union Packet { Empty, Ready { value: i32 } }
effect fn useHolder<'a>(holder: Holder<'a>) -> i32 { return read(holder.view) }
effect fn useView(view: &[Token]) -> i32 { return read(view) }
effect fn pause() -> i32 { return 1 }
fn identityMut(view: &mut [Token]) -> &mut [Token] { return move view }
fn bump(view: &mut [Token]) -> () { view[0].value = view[0].value + 1  return () }
struct Problem {}
fn shortCircuit(flag: bool) -> bool { return flag || read(&[make(1)]) == 1 }
fn first<'r, 'a>(holders: &'r [Holder<'a>]) -> &'r Holder<'a> { return &holders[0] }
fn reborrowedHolder() -> i32 {
  let values = [make(1)]
  let kept = first(&[Holder { view: &values }])
  return read(kept.view)
}
fn exclusiveAcrossReturn(flag: bool) -> i32 {
  let view = identityMut(&mut [make(5)])
  if flag { return 1 }
  bump(move view)
  return 0
}
fn heldAcrossBranches(flag: bool) -> i32 {
  let view = identity(&[make(5)])
  let mut total = 0
  if flag { return 1 } else { total = 2 }
  return read(view) + total
}
fn holderInArm(p: Packet) -> i32 {
  match move p {
    Packet.Ready { value } => {
      let view = identity(&[make(value)])
      let holder = Holder { view: view }
      let seen = read(holder.view)
    }
    Packet.Empty => {}
  }
  return 0
}
fn returnInArm(p: Packet, flag: bool) -> i32 {
  let mut total = 0
  match move p {
    Packet.Ready { value } => {
      let view = identity(&[make(value)])
      if flag { return 1 }
      total = read(view)
    }
    Packet.Empty => {}
  }
  return total
}
effect fn acrossSuspension(flag: bool) -> i32 {
  let view = identity(&[make(5)])
  if flag { return 1 }
  let paused = run pause()
  return read(view) + paused
}
effect fn acrossFailure(flag: bool) -> i32 ! Problem {
  let view = identity(&[make(5)])
  if flag { fail Problem {} }
  return read(view)
}
effect fn recover(error: Problem) -> i32 { return 0 }
effect fn rejected() -> never ! Problem { fail Problem {} }
effect fn divergingReturn(flag: bool) -> i32 ! Problem {
  let view = identity(&[make(5)])
  if flag { return run rejected() }
  return read(view)
}
fn holderAcrossReturn(flag: bool) -> i32 {
  let holder = Holder { view: &[make(1)] }
  if flag { return 1 }
  return read(holder.view)
}
effect fn heldThroughMatch(p: Packet) -> i32 {
  let holder = Holder { view: identity(&[make(5)]) }
  let paused = match move p { Packet.Ready { value } => run pause()  Packet.Empty => 0 }
  return read(holder.view) + paused
}
fn readInOneArm(p: Packet) -> i32 {
  let view = identity(&[make(5)])
  let mut x = 0
  match move p { Packet.Ready { value } => { x = read(view) }  Packet.Empty => { x = 2 } }
  let other = [make(2)]
  return read(&other) + x
}
effect fn runInOtherArm(p: Packet) -> i32 {
  let view = identity(&[make(5)])
  let held = useView(view)
  let mut x = 0
  match move p { Packet.Empty => { let holder = Holder { view: view } }  Packet.Ready { value } => { x = run held } }
  return x
}
fn acrossReturn(flag: bool) -> i32 {
  let view = identity(&[make(5)])
  if flag { return 1 }
  return read(view)
}
fn usedInBranch(flag: bool) -> i32 {
  let view = identity(&[make(5)])
  if flag { return read(view) }
  let other = [make(2)]
  return read(&other)
}
fn heldInArm(p: Packet) -> i32 {
  let view = identity(&[make(5)])
  match move p {
    Packet.Ready { value } => { let holder = Holder { view: view } }
    Packet.Empty => {}
  }
  return 0
}
effect fn runInBranch(flag: bool) -> i32 {
  let held = useHolder(Holder { view: identity(&[make(5)]) })
  let mut result = 0
  if flag { result = run held }
  return result
}
effect fn runInArm(p: Packet) -> i32 {
  let held = useHolder(Holder { view: identity(&[make(5)]) })
  let mut result = 0
  match move p { Packet.Ready { value } => { result = run held }  Packet.Empty => {} }
  return result
}
fn iterations(count: i32) -> i32 {
  let mut total = 0
  let mut at = 0
  while at < count {
    let view = identity(&[make(at)])
    if at == 3 { break }
    if at == 1 { at = at + 1  continue }
    total = total + read(view)
    at = at + 1
  }
  return total
}
fn condition(count: i32) -> i32 {
  let mut at = 0
  while read(&[make(at)]) < count { at = at + 1 }
  return at
}
fn branchLocal(flag: bool) -> i32 {
  let mut total = 0
  if flag {
    let view = identity(&[make(4)])
    total = read(view)
  } else {
    total = read(&[make(2)])
  }
  return total
}
fn armLocal(p: Packet) -> i32 {
  return match move p {
    Packet.Ready { value } => read(&[make(value)])
    Packet.Empty => 0
  }
}
pub fn main() -> i32 {
  let branch = run runInBranch(false)
  let arm = run runInArm(Packet.Empty)
  let suspended = run acrossSuspension(false)
  let failed = run Intrinsic.catchFailure<Problem>(acrossFailure(false), recover)
  let diverged = run Intrinsic.catchFailure<Problem>(divergingReturn(false), recover)
  let matched = run heldThroughMatch(Packet.Ready { value: 1 })
  let other = run runInOtherArm(Packet.Empty)
  let reviewed = exclusiveAcrossReturn(false) + heldAcrossBranches(false) +
    holderInArm(Packet.Ready { value: 1 }) + returnInArm(Packet.Ready { value: 1 }, false) +
    holderAcrossReturn(false) + readInOneArm(Packet.Ready { value: 1 }) + suspended + failed +
    matched + other + reborrowedHolder() + diverged
  if shortCircuit(false) { return 1 }
  return acrossReturn(false) + usedInBranch(false) + heldInArm(Packet.Empty) + branch + arm +
    iterations(5) + condition(3) + branchLocal(true) + armLocal(Packet.Empty) + reviewed
}`
    const self = yield* AnalysisFixture.retainingMain('qualified-borrow/temporaries', ascii(source))
    assert.deepEqual(Analysis.diagnostics(self), [])
    const mir = Analysis.loweredMir(self)
    assert.deepEqual(yield* MirVerification.verify(mir), [])
    const named = (name: string): Mir.MirFunction =>
      mir.functions.find((fn) => fn.id._tag === 'CanonicalDeclarationId' && fn.id.name === name) ??
      unreachable(`expected ${name}`)
    // Each drop of a borrowed temporary, which carries the span of its `&` operand, is the last
    // release of its sequence, after every binding or effect that may retain the view; one that
    // reaches the end of the function drops at return.
    const temporaryDrops = (fn: Mir.MirFunction) => {
      const sequences = fn.regions.flatMap((region) =>
        region._tag === 'OperationRegion' || region._tag === 'CleanupRegion'
          ? [{ region, operations: Mir.operationsOf(region) }]
          : [],
      )
      const nested = fn.regions
        .flatMap(Mir.operationsOf)
        .flatMap((operation) =>
          operation._tag === 'Match'
            ? operation.arms.flatMap((arm) =>
                arm.selected.execution.regions.flatMap((region) =>
                  region._tag === 'OperationRegion' || region._tag === 'CleanupRegion'
                    ? [{ region, operations: Mir.operationsOf(region) }]
                    : [],
                ),
              )
            : [],
        )
      const all = [...sequences, ...nested]
      const roots = new Set(
        all.flatMap(({ operations }) =>
          operations.flatMap((operation) =>
            operation._tag === 'BeginLoan' ? [operation.root.ordinal] : [],
          ),
        ),
      )
      return all.flatMap(({ region, operations }) =>
        operations.flatMap((operation, position) =>
          operation._tag === 'Drop' &&
          operation.cleanup._tag !== 'NoCleanup' &&
          roots.has(operation.local.ordinal) &&
          source[operation.provenance.span.start - 1] === '&'
            ? [
                {
                  outcome: region.outcome._tag,
                  last: operations
                    .slice(position + 1)
                    .every((later) => later._tag !== 'Drop' && later._tag !== 'EndLoan'),
                },
              ]
            : [],
        ),
      )
    }
    for (const name of [
      'acrossReturn',
      'usedInBranch',
      'heldInArm',
      'runInBranch$effect$-1',
      'runInArm$effect$-1',
    ]) {
      const drops = temporaryDrops(named(name))
      assert.isAbove(drops.length, 0, name)
      for (const drop of drops) assert.deepEqual(drop, { outcome: 'Return', last: true }, name)
    }
    for (const name of ['iterations', 'condition', 'branchLocal', 'armLocal']) {
      const drops = temporaryDrops(named(name))
      assert.isAbove(drops.length, 0, name)
      for (const drop of drops) assert.isTrue(drop.last, name)
    }
    // Releasing a temporary before a read that still uses a view of it is a use after drop: the
    // array under `acrossReturn`'s view, and the holders under `kept`, typed `&'r Holder<'a>` with
    // the temporary's own carried lifetime, which still counts as its view through `'r`.
    const releasedEarly = (name: string) =>
      Effect.gen(function* () {
        const fn = named(name)
        const release =
          fn.regions
            .flatMap(Mir.operationsOf)
            .find((operation) => operation._tag === 'Drop' && operation.hiddenOwner === true) ??
          unreachable(`expected a hidden owner drop in ${name}`)
        const premature: Mir.MirFunction = {
          ...fn,
          regions: fn.regions.map((region) =>
            region._tag === 'OperationRegion' &&
            region.operations.some(
              (operation) =>
                operation._tag === 'Call' &&
                operation.target._tag === 'CanonicalDeclarationId' &&
                operation.target.name === 'read',
            )
              ? { ...region, operations: [release, ...region.operations] }
              : region,
          ),
        }
        const violations = yield* MirVerification.verify({
          ...mir,
          functions: mir.functions.map((candidate) => (candidate === fn ? premature : candidate)),
        })
        return violations.flatMap((violation) =>
          violation.rule === 'UseAfterDrop' ? [violation.detail.split(' ')[0]] : [],
        )
      })
    assert.deepEqual(yield* releasedEarly('acrossReturn'), ['Move'])
    assert.deepEqual(yield* releasedEarly('reborrowedHolder'), ['ReadPlace'])
  }),
)
