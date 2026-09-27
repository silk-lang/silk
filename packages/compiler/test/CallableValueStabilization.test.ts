import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Analysis from '../src/Analysis.js'

const ascii = (value: string): Uint8Array =>
  Uint8Array.from(value, (character) => character.charCodeAt(0))

const codesOf = (name: string, source: string) =>
  Effect.map(Analysis.ofSource(name, ascii(source)), (snapshot) =>
    Analysis.diagnostics(snapshot).map((diagnostic) => diagnostic.code),
  )

it.effect(
  'admits scoped provider callbacks capturing an independently borrowed configuration',
  () =>
    Effect.gen(function* () {
      assert.deepEqual(
        yield* codesOf(
          'callable-stabilization/independent-capture',
          `struct Loan<'provider, P> { provider: &'provider mut P }
struct Owned<P> { provider: P }
struct Route<'configuration> { label: &'configuration i32 }
effect<'env> fn scoped<'env, P: 'env>(provider: P, use: for<'call> once fn<'env>(&'call mut Owned<P>) -> once Effect<'call & 'env; i32>) -> i32 {
  let mut owned = Owned<P> {provider: move provider}
  return run use(&mut owned)
}
effect<'view & 'configuration> fn finish<'configuration, 'view, 'provider: 'view, P>(
  owned: &'view mut Owned<Loan<'provider, P>>, route: Route<'configuration>,
) -> i32 { drop owned return route.label.* }
effect<'provider> fn route<'configuration: 'provider, 'provider, P>(provider: &'provider mut P, route: Route<'configuration>) -> i32 {
  let use = effect fn(owned: &mut Owned<Loan<'provider, P>>) -> i32 {
    return run finish<'configuration, P>(move owned, move route)
  }
  return run scoped(Loan<'provider, P> {provider: move provider}, move use)
}
struct Transferred<'tunnel, P> { value: &'tunnel mut P }
struct TunnelTransport<'view, 'provider: 'view, 'tunnel: 'provider, P> { connection: &'view mut Owned<Loan<'provider, Transferred<'tunnel, P>>> }
fn transport<'view, 'provider: 'view, 'tunnel: 'provider, P>(owned: &'view mut Owned<Loan<'provider, Transferred<'tunnel, P>>>) -> TunnelTransport<'view, 'provider, 'tunnel, P> {
  return TunnelTransport<'view, 'provider, 'tunnel, P> {connection: move owned}
}
effect<'view & 'configuration> fn finishTunnel<'configuration, 'view, 'provider: 'view, 'tunnel: 'provider, P>(
  owned: TunnelTransport<'view, 'provider, 'tunnel, P>, route: Route<'configuration>,
) -> i32 { drop owned return route.label.* }
effect<'provider> fn tunnelRoute<'configuration: 'provider, 'provider, 'tunnel: 'provider, P>(provider: &'provider mut Transferred<'tunnel, P>, route: Route<'configuration>) -> i32 {
  let use = effect fn(owned: &mut Owned<Loan<'provider, Transferred<'tunnel, P>>>) -> i32 {
    let selected = transport(move owned)
    return run finishTunnel<'configuration, P>(move selected, move route)
  }
  return run scoped(Loan<'provider, Transferred<'tunnel, P>> {provider: move provider}, move use)
}
pub fn main() -> i32 { return 0 }`,
        ),
        [],
      )
    }),
)

it.effect('elides nominal input lifetimes in anonymous callable headers', () =>
  Effect.gen(function* () {
    assert.deepEqual(
      yield* codesOf(
        'callable-stabilization/nominal-lifetime-elision',
        `struct Holder<'data, T> { value: &'data T }
fn ordinary(holder: Holder<i32>) -> i32 {
  let read = fn(value: &Holder<i32>) -> i32 { return value.value.* }
  return read(&holder)
}
effect fn effectful(holder: Holder<i32>) -> i32 {
  let read = effect fn(value: &Holder<i32>) -> i32 { return value.value.* }
  return run read(&holder)
}
fn generic<T>(holder: Holder<T>) -> () {
  let inspect = fn(value: &Holder<T>) -> () { drop value }
  inspect(&holder)
}
effect<'env> fn genericEffect<T: 'env, 'env>(holder: Holder<T>) -> () {
  let inspect = effect fn(value: &Holder<T>) -> () { drop value }
  run inspect(&holder)
}
pub fn main() -> i32 { return 0 }`,
      ),
      [],
    )
  }),
)

it.effect('infers open callback rows under quantified borrowed-input lifetime bounds', () =>
  Effect.gen(function* () {
    assert.deepEqual(
      yield* codesOf(
        'callable-stabilization/quantified-open-row',
        `
struct Holder<'data, T> { value: &'data T }
service Logger { effect fn log() -> () ? &Logger }
struct Problem {}
effect fn scope<'env, T, A, E, ?R>(
  holder: &mut Holder<T>,
  use: for<'call, 'view: 'call> once fn<'env>(&'call mut Holder<'view, T>) -> once Effect<'call & 'env; A ! E ? R>,
) -> A ! E ? R { return run use(move holder) }
effect<'env> fn caller<'env, T, C: 'env, A, E, ?R>(
  holder: &mut Holder<T>,
  captured: C,
  work: once fn<'env>() -> once Effect<'env; A ! E | Problem ? R | &Logger>,
) -> A ! E | Problem ? R | &Logger {
  let use = effect fn(value: &mut Holder<T>) -> A ! E | Problem ? R | &Logger {
    drop value
    drop captured
    return run work()
  }
  return run scope(move holder, move use)
}
pub fn main() -> i32 { return 0 }
`,
      ),
      [],
    )
  }),
)

// ISSUE-2: joining two named function items reports SEM0080 instead of invalid MIR.
it.effect('rejects a match that joins two named function items', () =>
  Effect.gen(function* () {
    assert.deepEqual(
      yield* codesOf(
        'callable-stabilization/match-join-named',
        `fn inc(v: i32) -> i32 { return v + 1 }
fn dec(v: i32) -> i32 { return v - 1 }
struct A {}
struct B {}
fn pick(x: A | B) -> i32 {
  let f = match &x {
    A {} => inc
    B {} => dec
  }
  return f(41)
}
pub fn main() -> i32 { return pick(A {}) }`,
      ),
      ['SEM0080'],
    )
  }),
)

it.effect('keeps callable reassignment tied to one construction identity', () =>
  Effect.gen(function* () {
    assert.deepEqual(
      yield* codesOf(
        'callable-stabilization/reassign-named',
        `fn inc(v: i32) -> i32 { return v + 1 }
fn dec(v: i32) -> i32 { return v - 1 }
pub fn main() -> i32 {
  let mut f = inc
  f = dec
  return f(43)
}`,
      ),
      ['SEM0080'],
    )
    assert.deepEqual(
      yield* codesOf(
        'callable-stabilization/reassign-anonymous',
        `pub fn main() -> i32 {
  let a = fn(v: i32) -> i32 { return v + 1 }
  let b = fn(v: i32) -> i32 { return v + 2 }
  let mut choice = a
  choice = b
  return choice(40)
}`,
      ),
      ['SEM0080'],
    )
  }),
)

it.effect('rejects a returned section whose borrow is rooted in a local', () =>
  Effect.gen(function* () {
    assert.deepEqual(
      yield* codesOf(
        'callable-stabilization/escape-local-root',
        `fn read(value: i32, values: &mut [i32]) -> i32 { return value + values[0] }
fn make() -> mut fn<'static>(i32) -> i32 {
  let mut values = [0]
  return read(&mut values)
}
pub fn main() -> i32 { let mut f = make() return f(1) }`,
      ),
      ['OWN0019', 'OWN0018', 'SEM0212'],
    )
  }),
)
