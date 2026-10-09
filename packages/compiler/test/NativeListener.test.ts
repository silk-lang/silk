import { readFileSync } from 'node:fs'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Analysis from '../src/Analysis.js'
import * as MirVerification from '../src/MirVerification.js'
import * as AnalysisFixture from './support/AnalysisFixture.js'

const implementation = readFileSync(
  new URL('../stdlib/silk/native_socket.silk', import.meta.url),
  'utf8',
)
const reference = readFileSync(
  new URL('../../../apps/docs/content/reference/native-socket-listeners.md', import.meta.url),
  'utf8',
)
const encoder = new TextEncoder()

const symbolAndCleanupSource = `import silk.effect {Effect}
import silk.execution { Execution, Wake }
import silk.monotonic_clock {MonotonicClock}
import silk.native_socket {Accepted, ListenOptions, Listener, NativeSocketError, accept, listen, withListener}
import silk.network_address {Endpoint}
import silk.option {Option}
import silk.system_clock {Instant, SystemClock}
import silk.u64

struct ParkGuard {wake: Wake}
impl Drop for ParkGuard {
  fn drop(self: &mut ParkGuard) -> () { return () }
}

fn retainWake(wake: Wake) -> ParkGuard {
  return ParkGuard {wake: move wake}
}

struct ParkingClock {}
impl MonotonicClock for ParkingClock {
  effect fn now(self: &mut Self) -> Instant { return SystemClock.make(0, 0) }
  effect fn getResolution(self: &mut Self) -> u64 { return 1 }
  effect fn waitUntil(self: &mut Self, when: Instant) -> () {
    drop when
    run Execution.park(retainWake)
    return ()
  }
  effect fn waitFor(self: &mut Self, howLong: u64) -> () {
    drop howLong
    run Execution.park(retainWake)
    return ()
  }
}

effect fn acceptOnce(listener: &mut Listener) -> i32
! NativeSocketError
? &mut MonotonicClock {
  let accepted = run accept(&mut listener.*, Option.none<Instant>())
  drop accepted
  return 42
}

pub effect fn main(listener: Listener, endpoint: Endpoint) -> i32 ! NativeSocketError {
  let opened = run listen(endpoint, ListenOptions.defaults())
  drop opened
  let mut clock = ParkingClock {}
  return run withListener<i32, NativeSocketError>(move listener, acceptOnce)
    |> Effect.provideMut<MonotonicClock>(&mut clock)
}
`

const ownershipSource = `import silk.byte_duplex {ByteDuplex, ByteIoError}
import silk.monotonic_clock {MonotonicClock}
import silk.native_socket {Accepted, AcceptedContext, AcceptedView, Connection, Listener, NativeSocketError, PeerAddress, accept, withAccepted, withAcceptedContext, withListener}
import silk.option {Option}
import silk.system_clock {Instant}

impl Copy for Listener {}
impl Copy for Accepted {}

fn rawDescriptor(listener: &Listener) -> i32 {
  return listener.descriptor.fd
}

effect<'call> fn leakListener<'call>(listener: &'call mut Listener) -> &'call mut Listener {
  return move listener
}

effect fn escapeListener<'env>(listener: Listener) -> &'env mut Listener {
  return run withListener<&'env mut Listener, never>(move listener, leakListener)
}

effect<'call> fn leakConnection<'call>(
  view: &'call mut AcceptedView<'call>,
) -> &'call mut Connection {
  return move view.connection
}

effect fn escapeConnection<'env>(accepted: Accepted) -> &'env mut Connection {
  return run withAccepted<&'env mut Connection, never>(move accepted, leakConnection)
}

effect fn overlappingAccepts(listener: &mut Listener) -> ()
! NativeSocketError
? &mut MonotonicClock {
  let first = accept(&mut listener.*, Option.none<Instant>())
  let second = accept(&mut listener.*, Option.none<Instant>())
  drop first
  drop second
  return ()
}

effect<'call> fn useAmbient<'call>(view: &'call mut AcceptedView<'call>) -> ()
! ByteIoError
? &mut ByteDuplex | &mut MonotonicClock {
  drop view
  return run ByteDuplex.flush(Option.none<Instant>())
}

effect fn aliasAmbient(accepted: Accepted) -> ()
! ByteIoError
? &mut ByteDuplex | &mut MonotonicClock {
  return run withAccepted<(), ByteIoError>(move accepted, useAmbient)
}

effect<'call> fn escapeContextConnection<'call>(
  view: &'call mut AcceptedView<'call>,
) -> &'static mut Connection {
  let escaped = &mut view.connection.*
  return move escaped
}

effect<'call> fn escapeContextView<'call>(
  view: &'call mut AcceptedView<'call>,
) -> &'static mut AcceptedView<'static> {
  return move view
}

struct AmbientAcceptedContext {}
impl AmbientAcceptedContext {
  effect<'call> fn use<'call>(
    context: Self,
    view: &'call mut AcceptedView<'call>,
  ) -> () ! ByteIoError ? &mut ByteDuplex | &mut MonotonicClock {
    drop context
    drop view
    return run ByteDuplex.flush(Option.none<Instant>())
  }
}
impl AcceptedContext<
  (),
  ByteIoError,
  never ? &mut ByteDuplex | &mut MonotonicClock
> for AmbientAcceptedContext {
  use: AmbientAcceptedContext.use
}

effect fn aliasAmbientContext(accepted: Accepted) -> ()
! ByteIoError
? &mut ByteDuplex | &mut MonotonicClock {
  return run withAcceptedContext(move accepted, AmbientAcceptedContext {})
}

fn useAfterMove(accepted: Accepted) -> PeerAddress {
  let moved = move accepted
  let peer = Accepted.peer(&accepted)
  drop moved
  return peer
}
`

it.effect(
  'realizes narrow target-specific listener symbols and cancellation cleanup',
  () =>
    Effect.gen(function* () {
      for (const target of ['x86_64-unknown-linux-gnu', 'aarch64-apple-darwin'] as const) {
        const snapshot = yield* AnalysisFixture.retainingMain(
          `native-listener/symbols-${target}`,
          encoder.encode(symbolAndCleanupSource),
          target,
        )
        assert.deepEqual(Analysis.diagnostics(snapshot), [], target)
        assert.deepEqual(yield* MirVerification.verify(Analysis.loweredMir(snapshot)), [], target)
        if (snapshot.mir._tag === 'Available') {
          assert.deepEqual(
            snapshot.mir.value.functions
              .flatMap(MirVerification.operations)
              .filter((operation) => operation._tag === 'ExecutionPark')
              .map((operation) => ({ cleanup: operation.guardCleanup._tag })),
            [{ cleanup: 'HookCleanup' }],
            target,
          )
        }
        const symbols = Analysis.instancesOf(snapshot).foreignCalls.map((call) => call.symbol)
        for (const symbol of ['bind', 'getsockname', 'listen', 'poll', 'setsockopt', 'socket'])
          assert.include(symbols, symbol, `${target}: ${symbol}`)
        assert.include(symbols, target === 'aarch64-apple-darwin' ? 'accept' : 'accept4')
      }
    }),
  120000,
)

it.effect('rejects affine listener and accepted-owner violations in one analysis snapshot', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.declarations(
      'native-listener/ownership-rejections',
      encoder.encode(ownershipSource),
      'x86_64-unknown-linux-gnu',
    )
    const owners = new Map<string, string>([
      ['impl Copy for Listener {}', 'copyListener'],
      ['impl Copy for Accepted {}', 'copyAccepted'],
      ['descriptor', 'rawDescriptor'],
      ['leakListener', 'escapeListener'],
      ['move view.connection', 'leakConnection'],
      [
        "withAccepted<&'env mut Connection, never>(move accepted, leakConnection)",
        'escapeConnection',
      ],
      ['&mut listener.*', 'overlappingAccepts'],
      ['withAccepted<(), ByteIoError>(move accepted, useAmbient)', 'aliasAmbient'],
      [
        `effect<'call> fn escapeContextConnection<'call>(
  view: &'call mut AcceptedView<'call>,
) -> &'static mut Connection {
  let escaped = &mut view.connection.*
  return move escaped
}`,
        'escapeContextConnection',
      ],
      ['move view', 'escapeContextView'],
      ['withAcceptedContext(move accepted, AmbientAcceptedContext {})', 'aliasAmbientContext'],
      ['&accepted', 'useAfterMove'],
    ])
    assert.deepEqual(
      Analysis.diagnostics(snapshot).map((diagnostic) => {
        const span = ownershipSource.slice(diagnostic.span.start, diagnostic.span.end).trim()
        return { code: diagnostic.code, owner: owners.get(span), span }
      }),
      [
        { code: 'SEM0083', owner: 'copyListener', span: 'impl Copy for Listener {}' },
        { code: 'SEM0083', owner: 'copyAccepted', span: 'impl Copy for Accepted {}' },
        { code: 'SEM0028', owner: 'rawDescriptor', span: 'descriptor' },
        { code: 'SEM0076', owner: 'escapeListener', span: 'leakListener' },
        { code: 'OWN0002', owner: 'leakConnection', span: 'move view.connection' },
        {
          code: 'SEM0074',
          owner: 'escapeConnection',
          span: "withAccepted<&'env mut Connection, never>(move accepted, leakConnection)",
        },
        { code: 'OWN0010', owner: 'overlappingAccepts', span: '&mut listener.*' },
        {
          code: 'SEM0074',
          owner: 'aliasAmbient',
          span: 'withAccepted<(), ByteIoError>(move accepted, useAmbient)',
        },
        {
          code: 'SEM0212',
          owner: 'escapeContextConnection',
          span: `effect<'call> fn escapeContextConnection<'call>(
  view: &'call mut AcceptedView<'call>,
) -> &'static mut Connection {
  let escaped = &mut view.connection.*
  return move escaped
}`,
        },
        { code: 'SEM0129', owner: 'escapeContextView', span: 'move view' },
        {
          code: 'SEM0074',
          owner: 'aliasAmbientContext',
          span: 'withAcceptedContext(move accepted, AmbientAcceptedContext {})',
        },
        { code: 'OWN0001', owner: 'useAfterMove', span: '&accepted' },
      ],
    )
  }),
)

it.effect('realizes the canonical native example and permits unused Wasm imports', () =>
  Effect.gen(function* () {
    const opening = '```silk\n'
    const start = reference.indexOf(opening)
    const end = reference.indexOf('\n```', start + opening.length)
    assert.isAtLeast(start, 0)
    assert.isAbove(end, start)
    const example = reference.slice(start + opening.length, end)
    const native = yield* AnalysisFixture.retainingMain(
      'native-listener/reference-example',
      encoder.encode(`${example}
pub effect fn main() -> i32 ! NativeSocketError {
  let listener = run openLoopback()
  drop listener
  return 42
}`),
      'x86_64-unknown-linux-gnu',
    )
    assert.deepEqual(Analysis.diagnostics(native), [])
    assert.deepEqual(yield* MirVerification.verify(Analysis.loweredMir(native)), [])

    const wasmSource = `import silk.native_socket {Accepted, AcceptedContext, BoundAddress, ListenOptions, Listener, PeerAddress, accept, listen, listenUnix, withAccepted, withAcceptedContext, withListener}
pub fn main() -> i32 { return 42 }`
    const wasm = yield* AnalysisFixture.retainingMain(
      'native-listener/registered-import-wasm',
      encoder.encode(wasmSource),
      'wasm32-unknown-unknown',
    )
    assert.deepEqual(Analysis.diagnostics(wasm), [])
    assert.deepEqual(Analysis.instancesOf(wasm).foreignCalls, [])
  }),
)

it.effect('emits no listener declarations or foreign symbols on WebAssembly', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'native-listener/wasm-exclusion',
      encoder.encode(`${implementation}\npub fn main() -> i32 { return 42 }`),
      'wasm32-unknown-unknown',
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    assert.deepEqual(yield* MirVerification.verify(Analysis.loweredMir(snapshot)), [])
    assert.deepEqual(Analysis.instancesOf(snapshot).foreignCalls, [])
  }),
)
