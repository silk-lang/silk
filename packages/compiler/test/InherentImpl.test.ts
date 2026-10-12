import * as Layer from 'effect/Layer'
import type * as ModuleClosure from '../src/ModuleClosure.js'
import * as AnalysisFixture from './support/AnalysisFixture.js'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Analysis from '../src/Analysis.js'
import * as SourceFile from '../src/SourceFile.js'
import * as SourceResolver from '../src/SourceResolver.js'
import * as Type from '../src/Type.js'
import * as Lifetime from '../src/Lifetime.js'
import { unreachable } from './support/raise.js'

const ascii = (value: string): Uint8Array =>
  Uint8Array.from(value, (character) => character.charCodeAt(0))

const analyze = (text: string, target?: string) =>
  Analysis.makeRealized({
    root: 'root',
    configuration: AnalysisFixture.configuration('root', target),
  }).pipe(
    Effect.provide(
      SourceResolver.overlay([SourceFile.make('root', ascii(text))]).pipe(
        Layer.provideMerge(SourceResolver.memory(new Map())),
      ),
    ),
  )

const analyzeModules = (
  rootModule: string,
  entries: ReadonlyArray<readonly [string, string]>,
): Effect.Effect<Analysis.Snapshot, ModuleClosure.ModuleClosureError> => {
  const rootText = entries.find(([name]) => name === rootModule)?.[1]
  if (rootText === undefined) throw new RangeError(`Fixture has no root source ${rootModule}`)
  const imports = new Map(
    entries
      .filter(([name]) => name !== rootModule)
      .map(([name, text]) => [name, ascii(text)] as const),
  )
  return Analysis.makeRealized({
    root: rootModule,
    configuration: AnalysisFixture.configuration(rootModule),
  }).pipe(
    Effect.provide(
      SourceResolver.overlay([SourceFile.make(rootModule, ascii(rootText))]).pipe(
        Layer.provideMerge(SourceResolver.memory(imports)),
      ),
    ),
  )
}

const codes = (self: Analysis.SingleRootFrontendSnapshot): ReadonlyArray<string> =>
  Analysis.diagnostics(self).map((diagnostic) => diagnostic.code)

const counter = `pub struct Counter { value: i32 }
impl Counter {
  pub fn zero() -> Self { return Counter { value: 0 } }
  pub fn make(value: i32) -> Self { return Counter { value: value } }
  pub fn read(self: &Self) -> i32 { return self.value }
  pub fn plus(self: Self, amount: i32) -> Self { return Counter { value: self.value + amount } }
}
`

it.effect('classifies inherent receivers and keeps members out of root scope', () =>
  Effect.gen(function* () {
    const self = yield* analyze(`${counter}
pub struct Runner {}
impl Runner { pub fn go(self: i32) -> i32 { return self } }
pub struct Slot {}
impl Slot { pub fn zero() -> i32 { return 42 } }
pub fn main() -> i32 { return Runner.go(Slot.zero()) }`)
    assert.deepEqual(codes(self), [])
    const receiver = (name: string): boolean | undefined => {
      const lookup = Analysis.memberByName(self, 'root', name)
      return lookup._tag === 'Resolved' && lookup.declaration._tag === 'FunctionDeclaration'
        ? lookup.declaration.associatedMember?.receiver
        : undefined
    }
    assert.strictEqual(receiver('Counter.read'), true)
    assert.strictEqual(receiver('Counter.plus'), true)
    assert.strictEqual(receiver('Counter.zero'), false)
    assert.strictEqual(receiver('Runner.go'), false)
    const slot = Analysis.memberByName(self, 'root', 'Slot.zero')
    if (slot._tag !== 'Resolved' || slot.declaration._tag !== 'FunctionDeclaration')
      return unreachable('expected the local builtin-shadowing owner member')
    assert.deepEqual(slot.declaration.associatedMember?.owner, {
      _tag: 'CanonicalDeclarationId',
      module: 'root',
      name: 'Slot',
    })
    assert.strictEqual(Analysis.memberByName(self, 'root', 'read')._tag, 'Missing')
  }),
)

it.effect('publishes an implicit receiver borrow before assembling a method call', () =>
  Effect.gen(function* () {
    const self = yield* analyze(`pub struct Value { stored: i32 }
impl Value { pub fn read(self: &Self) -> i32 { return self.stored } }
pub fn main(value: Value) -> i32 { return value.read() }`)
    assert.deepEqual(codes(self), [])
  }),
)

it.effect('resolves imported inherent members through their declaring owner', () =>
  Effect.gen(function* () {
    const self = yield* analyzeModules('app', [
      [
        'widgets',
        `pub struct Gadget { pub size: i32 }
impl Gadget {
  pub fn make(size: i32) -> Self { return Gadget { size: size } }
  fn secret() -> i32 { return 1 }
  pub fn width(self: &Self) -> i32 { return self.size }
}
pub fn helper() -> i32 { return 2 }`,
      ],
      [
        'app',
        `import widgets { Gadget }
pub fn main() -> i32 {
  let gadget = Gadget.make(42)
  return Gadget.width(&gadget)
}`,
      ],
    ])
    assert.deepEqual(codes(self), [])
    for (const member of ['Gadget.make', 'Gadget.width']) {
      const resolved = Analysis.memberByName(self, 'widgets', member)
      assert.strictEqual(resolved._tag, 'Resolved', member)
      if (resolved._tag === 'Resolved') {
        assert.strictEqual(resolved.declaration.canonical._tag, 'Canonical')
        if (resolved.declaration.canonical._tag === 'Canonical')
          assert.strictEqual(resolved.declaration.canonical.id.module, 'widgets')
      }
    }
    assert.strictEqual(Analysis.memberByName(self, 'app', 'make')._tag, 'Missing')
  }),
)

it.effect('prefers an inherent member over a matching module projection', () =>
  Effect.gen(function* () {
    const self = yield* analyzeModules('app', [
      [
        'counter',
        `pub struct Counter { value: i32 }
pub fn make() -> Counter { return Counter { value: 1 } }
impl Counter { pub fn make() -> Self { return Counter { value: 42 } } }
pub fn read(counter: &Counter) -> i32 { return counter.value }`,
      ],
      [
        'app',
        `import counter { Counter, read }
pub fn main() -> i32 { let made = Counter.make() return read(&made) }`,
      ],
    ])
    assert.deepEqual(codes(self), [])
    const member = Analysis.memberByName(self, 'counter', 'Counter.make')
    const free = Analysis.memberByName(self, 'counter', 'make')
    assert.strictEqual(member._tag, 'Resolved')
    assert.strictEqual(free._tag, 'Resolved')
    if (member._tag === 'Resolved' && free._tag === 'Resolved')
      assert.notStrictEqual(member.declaration, free.declaration)
  }),
)

it.effect('rejects invalid heads, duplicate members, collisions, and hooks', () =>
  Effect.gen(function* () {
    const specializedSource = `pub union Option<T> { None, Some { pub value: T } }
impl Option<i32> { pub fn special() -> i32 { return 1 } }
pub fn main() -> i32 { return 0 }`
    const specialized = yield* analyze(specializedSource)
    assert.deepEqual(codes(specialized), ['SEM0194'])
    assert.strictEqual(
      Analysis.diagnostics(specialized).at(0)?.span.start,
      specializedSource.indexOf('Option<i32> {'),
    )
    const bounded = yield* analyze(`interface Display { fn display(value: &Self) -> i32 }
pub union Option<T> { None, Some { pub value: T } }
impl<T: Display> Option<T> {
  pub fn show() -> i32 { return 1 }
  pub fn make(value: T) -> Self { return Option.Some { value: move value } }
}
pub fn main() -> i32 { return 0 }`)
    // The rejected head still closes `Self` for its members: the head's diagnostic is the only one.
    assert.deepEqual(codes(bounded), ['SEM0194'])
    const alias = yield* analyze(`pub union Option<T> { None, Some { pub value: T } }
type Maybe = Option<i32>
impl Maybe { pub fn special() -> i32 { return 1 } }
pub fn main() -> i32 { return 0 }`)
    assert.deepEqual(codes(alias), ['SEM0194'])
    const foreign = yield* analyzeModules('app', [
      ['widgets', `pub struct Gadget { pub size: i32 }\n`],
      [
        'app',
        `import widgets { Gadget }\nimpl Gadget { pub fn mine() -> i32 { return 1 } }\npub fn main() -> i32 { return 0 }`,
      ],
    ])
    assert.deepEqual(codes(foreign), ['SEM0194'])
    const duplicate = yield* analyze(`${counter}
impl Counter { pub fn read(self: &Self) -> i32 { return 2 } }
pub fn main() -> i32 { return 0 }`)
    assert.deepEqual(codes(duplicate).filter((code) => code === 'SEM0196').length, 2)
    const collision = yield* analyze(`pub struct Counter { value: i32 }
impl Counter { pub fn value(self: &Self) -> i32 { return self.value } }
pub fn main() -> i32 { return 0 }`)
    assert.deepEqual(codes(collision), ['SEM0195'])
    const hook = yield* analyze(`pub struct Guard { value: i32 }
impl Guard { fn drop(self: &mut Guard) -> () { return () } }
pub fn main() -> i32 { return 0 }`)
    assert.deepEqual(codes(hook), ['SEM0195'])
    const mapped = yield* analyze(`pub struct Guard { value: i32 }
fn make() -> Guard { return Guard { value: 1 } }
impl Guard { make: make }
pub fn main() -> i32 { return 0 }`)
    assert.deepEqual(codes(mapped), ['SEM0195'])
  }),
)

const elidedSliceStream = `pub struct SliceStream<A> {
  slice: &[A]
  index: usize
}
impl<A> SliceStream<A> {
  pub fn make(slice: &[A]) -> SliceStream<A> {
    return SliceStream<A> { slice: slice, index: 0 }
  }
}`
const explicitSliceStream = `pub struct SliceStream<'data, A> {
  slice: &'data [A]
  index: usize
}
impl<'data, A> SliceStream<'data, A> {
  pub fn make(slice: &'data [A]) -> Self {
    return SliceStream<'data, A> { slice: slice, index: 0 }
  }
}`
const explicitHeadSliceStream = elidedSliceStream
  .replace('impl<A> SliceStream<A>', "impl<'data, A> SliceStream<'data, A>")
  .replace('make(slice: &[A]) -> SliceStream<A>', "make(slice: &'data [A]) -> Self")
  .replace('return SliceStream<A>', "return SliceStream<'data, A>")
const makeSliceStream = `pub fn main() -> i32 {
  let values = [1, 2, 3]
  let stream = SliceStream.make(&values)
  return 0
}`

for (const [form, declaration, main] of [
  ['elided declaration', elidedSliceStream, 'pub fn main() -> i32 { return 0 }'],
  ['explicit invocation', explicitSliceStream, makeSliceStream],
  ['elided invocation', elidedSliceStream, makeSliceStream],
  ['explicit head with implicit owner', explicitHeadSliceStream, makeSliceStream],
  [
    'explicit nominal result',
    explicitSliceStream.replace('-> Self', "-> SliceStream<'data, A>"),
    makeSliceStream,
  ],
]) {
  it.effect(`preserves inherent constructor lifetime elision: ${form}`, () =>
    Effect.gen(function* () {
      const snapshot = yield* Analysis.ofSource('root', ascii(`${declaration}\n${main}`))
      assert.deepEqual(codes(snapshot), [])
      const lookup = Analysis.memberByName(snapshot, 'root', 'SliceStream.make')
      const member =
        lookup._tag === 'Resolved' && lookup.declaration._tag === 'FunctionDeclaration'
          ? lookup.declaration
          : unreachable('expected a published constructor')
      assert.deepEqual(member.associatedMember?.owner, {
        _tag: 'CanonicalDeclarationId',
        module: 'root',
        name: 'SliceStream',
      })
      const input = member.parameters.at(0)?.declaredType
      const result = member.returnType
      if (input?._tag !== 'Resolved' || result._tag !== 'Resolved')
        return unreachable('expected resolved constructor types')
      assert.deepEqual(Type.freeLifetimes(result.type), Type.freeLifetimes(input.type))
      assert.strictEqual(Type.freeLifetimes(result.type).length, 1)
      assert.strictEqual(
        member.typeParameters.filter((parameter) => parameter.type.kind === 'Lifetime').length,
        1,
      )
    }),
  )
}

it.effect('keeps elided inherent Self fixed to the owner lifetime', () =>
  Effect.gen(function* () {
    const source = elidedSliceStream.replace('-> SliceStream<A>', '-> Self')
    const snapshot = yield* Analysis.ofSource('root', ascii(source))
    assert.deepEqual(codes(snapshot), ['SEM0129'])
    assert.strictEqual(
      Analysis.diagnostics(snapshot).at(0)?.span.start,
      source.indexOf('SliceStream<A> { slice:'),
    )
    const lookup = Analysis.memberByName(snapshot, 'root', 'SliceStream.make')
    const member =
      lookup._tag === 'Resolved' && lookup.declaration._tag === 'FunctionDeclaration'
        ? lookup.declaration
        : unreachable('expected a published constructor')
    const input = member.parameters.at(0)?.declaredType
    const result = member.returnType
    if (input?._tag !== 'Resolved' || result._tag !== 'Resolved')
      return unreachable('expected resolved constructor types')
    assert.strictEqual(Type.isNominal(result.type), true)
    assert.notDeepEqual(Type.freeLifetimes(result.type), Type.freeLifetimes(input.type))
    assert.strictEqual(
      member.typeParameters.filter((parameter) => parameter.type.kind === 'Lifetime').length,
      2,
    )
  }),
)

it.effect('rejects missing ordinary inherent owner arguments after lifetime elision', () =>
  Effect.gen(function* () {
    const source = `pub struct Holder<A> { value: &A }
impl Holder { pub fn zero() -> i32 { return 0 } }`
    const snapshot = yield* Analysis.ofSource('root', ascii(source))
    assert.deepEqual(codes(snapshot), ['SEM0194'])
    assert.strictEqual(Analysis.diagnostics(snapshot).at(0)?.span.start, source.indexOf('Holder {'))
  }),
)

it.effect('binds a written owner application to the impl binders the member names', () =>
  Effect.gen(function* () {
    const source = `struct Lent<'a, T> { value: &'a T }
impl<'a, T> Lent<'a, T> {
  fn read(lent: &Lent<'a, T>) -> &'a T { return lent.value }
  fn pick<U>(lent: &Lent<'a, T>, other: U) -> &'a T { drop other return lent.value }
}
struct Pair<A, B> {
  left: A
  right: B
}
impl<A, B> Pair<A, B> {
  fn second(value: B) -> B { return move value }
  fn make(left: A, right: B) -> Pair<A, B> { return Pair { left: move left, right: move right } }
}
fn read<'r>(lent: &Lent<'r, i32>) -> &'r i32 { return Lent<i32>.read(lent) }
fn pick<'r>(lent: &Lent<'r, i32>) -> &'r i32 { return Lent<i32>.pick<bool>(lent, true) }
fn second() -> u8 { return Pair<i64, u8>.second(42) }
fn made() -> Pair<i64, u8> { return Pair<i64, u8>.make(1, 2) }
fn partial() -> i32 {
  let pair = Pair<i64>.make(1, 2)
  return 0
}
`
    const snapshot = yield* Analysis.ofSource('root', ascii(source))
    assert.deepEqual(codes(snapshot), ['SEM0051'])
    assert.strictEqual(
      Analysis.diagnostics(snapshot).at(0)?.span.start,
      source.indexOf('Pair<i64>.make'),
    )
  }),
)

it.effect('reports a member list after an unwritten owner whose parameters the member uses', () =>
  Effect.gen(function* () {
    const source = `struct Lent<'a, T> { value: &'a T }
impl<'a, T> Lent<'a, T> {
  fn pick<U>(lent: &Lent<'a, T>, other: U) -> &'a T { drop other return lent.value }
}
struct Pair<A, B> {
  left: A
  right: B
}
impl<A, B> Pair<A, B> {
  fn second(value: B) -> B { return move value }
  fn keep<U>(value: U) -> U { return move value }
}
service Store<T> { effect<'env> fn put<'env>(value: T) -> i32 ? &mut Store<T> }
fn prefixed(small: u8) -> u8 { return Pair.second<u8>(small) }
fn picked<'r>(lent: &Lent<'r, i32>) -> &'r i32 { return Lent.pick<i32, bool>(lent, true) }
fn own<'r>(lent: &Lent<'r, i32>) -> &'r i32 { return Lent.pick<bool>(lent, true) }
fn independent() -> u8 { return Pair.keep<u8>(42) }
fn inferred() -> u8 {
  let small: u8 = 42
  return Pair.second(small)
}
effect fn stored() -> i32 ? &mut Store<i32> { return run Store.put<i32>(5) }
`
    const snapshot = yield* Analysis.ofSource('root', ascii(source))
    assert.deepEqual(codes(snapshot), ['SEM0221', 'SEM0221', 'SEM0221', 'SEM0221'])
    assert.deepEqual(
      Analysis.diagnostics(snapshot).map((diagnostic) => diagnostic.span.start),
      [
        source.indexOf('<u8>(small)'),
        source.indexOf('<i32, bool>'),
        source.indexOf('<bool>(lent'),
        source.indexOf('<i32>(5)'),
      ],
    )
  }),
)

const analyzeConformance = (text: string) =>
  Analysis.make({ root: 'root' }).pipe(
    Effect.provide(
      SourceResolver.overlay([SourceFile.make('root', ascii(text))]).pipe(
        Layer.provideMerge(SourceResolver.memory(new Map())),
      ),
    ),
  )

it.effect('replays conformance owner lifetimes and inherits them in inline operations', () =>
  Effect.gen(function* () {
    for (const head of [
      "impl<'data, A: Copy> Read<A> for SliceStream<'data, A>",
      'impl<A: Copy> Read<A> for SliceStream<A>',
    ]) {
      const snapshot = yield* analyzeConformance(`${elidedSliceStream}
interface Read<A> { fn first(self: &Self) -> A }
${head} { pub fn first(self: &Self) -> A { let slice = self.slice return slice[0] } }
pub fn main() -> i32 { let values = [1, 2] let stream = SliceStream.make(&values) return Read.first(&stream) }`)
      assert.deepEqual(codes(snapshot), [])
      const conformance =
        snapshot.index.modules.find((module) => module.module === 'root')?.conformances.at(0) ??
        unreachable('expected conformance')
      assert.strictEqual(
        conformance.typeParameters.filter((parameter) => parameter.type.kind === 'Lifetime').length,
        1,
      )
      const provider = conformance.provider
      if (provider._tag !== 'Resolved') return unreachable('expected provider')
      const lifetimes = Type.freeLifetimes(provider.type)
      assert.strictEqual(lifetimes.length, 1)
      const implementation =
        snapshot.index.modules
          .find((module) => module.module === 'root')
          ?.declarations.find(
            (member) => member.conformanceImplementation?.ordinal === conformance.ordinal,
          ) ?? unreachable('expected inline implementation')
      const receiver = implementation.parameters.at(0)?.declaredType
      if (receiver?._tag !== 'Resolved') return unreachable('expected receiver')
      assert.strictEqual(
        Type.freeLifetimes(receiver.type).some((lifetime) =>
          Lifetime.equals(lifetime, lifetimes.at(0) ?? unreachable('expected owner lifetime')),
        ),
        true,
      )
      assert.strictEqual(
        implementation.typeParameters.filter((parameter) => parameter.type.kind === 'Lifetime')
          .length,
        2,
      )
      assert.strictEqual(conformance.requirements.length, 1)
    }
  }),
)

it.effect('keeps ordinary conformance arity and Copy bounds after owner lifetime replay', () =>
  Effect.gen(function* () {
    const aritySource = `struct Holder<A> { value: &A }
interface Read { fn value(self: &Self) -> i32 }
impl Read for Holder { pub fn value(self: &Self) -> i32 { return 0 } }`
    const arity = yield* analyzeConformance(aritySource)
    const diagnostic =
      Analysis.diagnostics(arity).find((entry) => entry.code === 'SEM0051') ??
      unreachable('expected missing ordinary argument diagnostic')
    assert.strictEqual(diagnostic.span.start, aritySource.indexOf('Holder {'))
    const bound = yield* analyzeConformance(`import silk.ownership { Copy }
struct Token { value: i32 }
struct Holder<A> { value: &A }
interface Read { fn value(self: &Self) -> i32 }
impl<A: Copy> Read for Holder<A> { pub fn value(self: &Self) -> i32 { return 0 } }
pub fn main() -> i32 { let token = Token { value: 1 } let holder = Holder { value: &token } return Read.value(&holder) }`)
    assert.strictEqual(codes(bound).includes('SEM0083'), true)
  }),
)
