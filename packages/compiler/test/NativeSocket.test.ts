import * as Layer from 'effect/Layer'
import { readFileSync } from 'node:fs'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Analysis from '../src/Analysis.js'
import * as SourceFile from '../src/SourceFile.js'
import * as SourceResolver from '../src/SourceResolver.js'
import * as MirVerification from '../src/MirVerification.js'
import * as AnalysisFixture from './support/AnalysisFixture.js'
import * as Stdlib from '../src/Stdlib.js'
import { unreachable } from './support/raise.js'
import {
  nativeSocketAcceptanceSource,
  nativeSocketCorpusProgram,
  nativeSocketDarwinWitnessSource,
  nativeSocketGnuWitnessSource,
} from './support/nativeSocketAcceptance.js'
import { relinquishedReleases } from './support/relinquishedFrames.js'

const implementation = readFileSync(
  new URL('../stdlib/silk/native_socket.silk', import.meta.url),
  'utf8',
)
const reference = readFileSync(
  new URL('../../../apps/docs/content/reference/native-socket-connections.md', import.meta.url),
  'utf8',
)
const encoder = new TextEncoder()

it.effect(
  'realizes GNU socket boundaries and guarded acquisition cancellation',
  () =>
    Effect.gen(function* () {
      const sourceId = 'native-socket/gnu-boundaries'
      const snapshot = yield* Analysis.makeRealized({
        root: sourceId,
        configuration: AnalysisFixture.configuration(sourceId, 'x86_64-unknown-linux-gnu', [
          'runResolved',
          'runUnixRetry',
          'parkedOwnedAcquisition',
        ]),
      }).pipe(
        Effect.provide(
          SourceResolver.overlay([
            SourceFile.make(sourceId, encoder.encode(nativeSocketAcceptanceSource)),
          ]).pipe(Layer.provideMerge(SourceResolver.empty)),
        ),
      )
      assert.deepEqual(Analysis.diagnostics(snapshot), [])
      assert.deepEqual(yield* MirVerification.verify(Analysis.loweredMir(snapshot)), [])
      const actorSymbols = Analysis.instancesOf(snapshot)
        .foreignCalls.map((call) => call.symbol)
        .filter(
          (symbol) =>
            !symbol.startsWith('silk_socket_') && symbol !== 'malloc' && symbol !== 'free',
        )
        .sort()
      assert.deepEqual(actorSymbols, [
        '__errno_location',
        'close',
        'connect',
        'getsockopt',
        'poll',
        'recv',
        'send',
        'setsockopt',
        'shutdown',
        'socket',
      ])
      if (snapshot.mir._tag === 'Available') {
        const parks = relinquishedReleases(snapshot.mir.value)
        assert.isAtLeast(parks.length, 1)
        assert.isTrue(parks.some((releases) => releases.length > 0))
      }
    }),
  120000,
)

it('exports one profile-agnostic native corpus program with independent ABI witnesses', () => {
  assert.strictEqual(nativeSocketCorpusProgram.name, 'native-socket-connections')
  assert.strictEqual(nativeSocketCorpusProgram.expected.result, 42)
  assert.include(nativeSocketCorpusProgram.nativeSource, 'connectResolved(')
  assert.include(nativeSocketCorpusProgram.nativeSource, 'connectResolvedOwned(')
  assert.include(nativeSocketCorpusProgram.nativeSource, 'connectUnix(')
  assert.include(nativeSocketCorpusProgram.nativeSource, 'connectUnixOwned(')
  assert.include(implementation, 'close$NOCANCEL')
  assert.include(implementation, 'return 9223372036854775807')
  assert.strictEqual(implementation.match(/if requested > maxTransfer\(\)/g)?.length, 2)
  assert.include(nativeSocketDarwinWitnessSource, 'sun_path) == 104')
  assert.include(nativeSocketDarwinWitnessSource, 'SSIZE_MAX == INTPTR_MAX')
  assert.include(nativeSocketGnuWitnessSource, 'sun_path) == 108')
  assert.include(nativeSocketGnuWitnessSource, 'SSIZE_MAX == INTPTR_MAX')
})

it.effect('keeps the local pathname reference example executable', () =>
  Effect.gen(function* () {
    const opening = '```silk\n'
    const start = reference.indexOf(opening)
    const end = reference.indexOf('\n```', start + opening.length)
    assert.isAtLeast(start, 0)
    assert.isAbove(end, start)
    const example = reference.slice(start + opening.length, end)
    const snapshot = yield* AnalysisFixture.retainingMain(
      'native-socket/reference-example',
      encoder.encode(`${example}\npub fn main() -> i32 { return 42 }`),
      'x86_64-unknown-linux-gnu',
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    assert.deepEqual(yield* MirVerification.verify(Analysis.loweredMir(snapshot)), [])
  }),
)

const publicSelectionProbe = `
import silk.monotonic_clock {MonotonicClock}
import silk.native_socket {ConnectOptions, Connection, NativeSocketError, connectResolvedOwned, connectUnixOwned}
import silk.network_address {Endpoint}
import silk.option {Option}
import silk.system_clock {Instant}

effect fn acquireResolved(
  endpoints: &[Endpoint],
  options: ConnectOptions,
  deadline: Option<Instant>,
) -> Connection ! NativeSocketError ? &mut MonotonicClock {
  return run connectResolvedOwned(endpoints, options, move deadline)
}

effect fn acquireUnix(
  path: &[u8],
  options: ConnectOptions,
  deadline: Option<Instant>,
) -> Connection ! NativeSocketError ? &mut MonotonicClock {
  return run connectUnixOwned(path, options, move deadline)
}

pub fn main() -> i32 {
  let options = ConnectOptions.defaults()
  drop ConnectOptions.maxAttempts(&options)
  return 42
}
`
const wasmSelectionProbe = `
import silk.native_socket {ConnectOptions}
pub fn main() -> i32 { return 42 }
`

it.effect(
  'selects the public Darwin actor and keeps its unused Wasm import available',
  () =>
    Effect.gen(function* () {
      const darwin = yield* AnalysisFixture.retainingMain(
        'native-socket/public-aarch64-apple-darwin',
        encoder.encode(publicSelectionProbe),
        'aarch64-apple-darwin',
      )
      assert.deepEqual(Analysis.diagnostics(darwin), [])
      const wasm = yield* AnalysisFixture.retainingMain(
        'native-socket/public-wasm32-unknown-unknown',
        encoder.encode(wasmSelectionProbe),
        'wasm32-unknown-unknown',
      )
      assert.deepEqual(Analysis.diagnostics(wasm), [])
      assert.deepEqual(Analysis.instancesOf(wasm).foreignCalls, [])
    }),
  30_000,
)

it.effect('rejects extracting ownership from a borrowed connection', () =>
  Effect.gen(function* () {
    const source = `${implementation}
fn steal(connection: &mut Connection) -> Connection { return move connection.* }
pub fn main() -> i32 { return 42 }
`
    const snapshot = yield* AnalysisFixture.retainingMain(
      'native-socket/ownership-rejection',
      encoder.encode(source),
      'x86_64-unknown-linux-gnu',
    )
    const diagnostics = Analysis.diagnostics(snapshot)
    assert.deepEqual(
      diagnostics.map((diagnostic) => diagnostic.code),
      ['OWN0012'],
    )
    const diagnostic = diagnostics.at(0)
    assert.isDefined(diagnostic)
    if (diagnostic !== undefined)
      assert.strictEqual(
        source.slice(diagnostic.span.start, diagnostic.span.end),
        'move connection.*',
      )
  }),
)

it.effect('rejects reached native connection acquisition on unsupported profiles', () =>
  Effect.gen(function* () {
    const sourceId = 'native-socket/unsupported-acquisition'
    const source = `import silk.native_socket {Connection, ConnectOptions, NativeSocketError, connectResolvedOwned}
import silk.monotonic_clock {MonotonicClock}
import silk.network_address {Endpoint}
import silk.option {Option}
import silk.system_clock {Instant}

pub fn main() -> i32 {
  let endpoints: [Endpoint; 0] = []
  let pending = connectResolvedOwned(&endpoints, ConnectOptions.defaults(), Option.none<Instant>())
  drop pending
  return 42
}`
    const module = Stdlib.find('silk/native_socket') ?? unreachable('expected socket source')
    const text = new TextDecoder().decode(module.bytes)
    const operation = text.indexOf('pub effect fn connectResolvedOwned(')
    const start = text.indexOf('compileError("', operation) + 'compileError("'.length
    const end = text.indexOf('"', start)
    for (const profile of [
      { target: 'wasm32-unknown-unknown' },
      { target: 'x86_64-unknown-linux-gnu', libc: 'none' },
    ] as const) {
      const configuration = AnalysisFixture.configuration(sourceId, profile.target)
      const snapshot = yield* Analysis.makeRealized({
        root: sourceId,
        configuration: { ...configuration, profile: { ...configuration.profile, ...profile } },
      }).pipe(
        Effect.provide(
          SourceResolver.overlay([SourceFile.make(sourceId, encoder.encode(source))]).pipe(
            Layer.provideMerge(SourceResolver.empty),
          ),
        ),
      )
      assert.deepEqual(
        Analysis.diagnostics(snapshot).map((diagnostic) => [
          diagnostic.code,
          diagnostic.span.sourceId,
          diagnostic.span.start,
          diagnostic.span.end,
        ]),
        [['SEM0177', module.module, start, end]],
      )
    }
  }),
)
