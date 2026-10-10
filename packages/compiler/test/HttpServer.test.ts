import * as Layer from 'effect/Layer'
import { readFileSync } from 'node:fs'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Analysis from '../src/Analysis.js'
import * as Frontend from '../src/Frontend.js'
import * as SourceFile from '../src/SourceFile.js'
import * as SourceResolver from '../src/SourceResolver.js'
import * as AnalysisFixture from './support/AnalysisFixture.js'

const encoder = new TextEncoder()
const reference = readFileSync(
  new URL('../../../apps/docs/content/reference/http-server.md', import.meta.url),
  'utf8',
)

it.effect(
  'checks the reference example and canonical streaming HTTP server surface',
  () =>
    Effect.gen(function* () {
      const example = reference.match(/```silk\n([\s\S]*?)\n```/)?.[1]
      assert.isString(example)
      if (example === undefined) return
      const sourceId = 'http-server/reference-example'
      const snapshot = yield* Frontend.frontend({
        root: sourceId,
        configuration: AnalysisFixture.configuration(sourceId, 'x86_64-unknown-linux-gnu', []),
      }).pipe(
        Effect.provide(
          SourceResolver.overlay([SourceFile.make(sourceId, encoder.encode(example))]).pipe(
            Layer.provideMerge(SourceResolver.empty),
          ),
        ),
      )
      assert.deepEqual(
        snapshot.diagnostics.map((diagnostic) => ({
          code: diagnostic.code,
          message: diagnostic.message,
          sourceId: diagnostic.span.sourceId,
          start: diagnostic.span.start,
          end: diagnostic.span.end,
        })),
        [],
      )
    }),
  120_000,
)

it.effect(
  'publishes native admission only on supported socket targets',
  () =>
    Effect.gen(function* () {
      const source = `import silk.http_server_native {HttpServerNative}
pub fn main() -> i32 { return 42 }`
      const native = yield* AnalysisFixture.retainingMain(
        'http-server/native-admission-linux',
        encoder.encode(source),
        'x86_64-unknown-linux-gnu',
      )
      assert.deepEqual(Analysis.diagnostics(native), [])

      const wasm = yield* AnalysisFixture.retainingMain(
        'http-server/native-admission-wasm',
        encoder.encode(source),
        'wasm32-unknown-unknown',
      )
      const start = source.indexOf('HttpServerNative')
      assert.deepEqual(
        Analysis.diagnostics(wasm).map((diagnostic) => ({
          code: diagnostic.code,
          start: diagnostic.span.start,
          end: diagnostic.span.end,
        })),
        [{ code: 'SEM0014', start, end: start + 'HttpServerNative'.length }],
      )
    }),
  180_000,
)

const ownershipSource = `import silk.http_head {RequestParser}
import silk.result {Result}
import silk.websocket_upgrade {Limits as UpgradeLimits, inspect}
import silk.allocator {Allocator, OutOfMemoryError}
import silk.byte_duplex {ByteDuplex}
import silk.http_server {Connection, Request, ServerError, readSome, withRequest}
import silk.monotonic_clock {MonotonicClock}
import silk.option {Option}
import silk.system_clock {Instant}

fn rebind<'connection, 'transport, P>(connection: &mut Connection<'connection, 'transport, P>) -> () {
  drop connection.channel
  return ()
}

effect fn overlap<'request, 'connection, 'transport, P>(
  request: &mut Request<'request, 'connection, 'transport, P>,
) -> () ! ServerError ? &mut MonotonicClock
where &'transport mut P provides &ByteDuplex from &mut ByteDuplex | &mut MonotonicClock {
  let head = run Request.head(&request.*)
  let mut bytes: [u8; 1] = [0]
  let progress = run readSome(&mut request.*, &mut bytes, Option.none<Instant>())
  drop progress
  drop head
  return ()
}

effect<'call> fn leak<'call, 'request: 'call, 'connection: 'request, 'transport: 'connection, P>(
  request: &'call mut Request<'request, 'connection, 'transport, P>,
) -> &'call mut Request<'request, 'connection, 'transport, P> {
  return move request
}

effect fn escape<'loan, 'connection: 'loan, 'transport: 'connection, P>(
  connection: &'loan mut Connection<'connection, 'transport, P>,
) -> Option<&'loan mut Request<'loan, 'connection, 'transport, P>>
! ServerError | OutOfMemoryError
? &mut Allocator | &mut MonotonicClock
where &'transport mut P provides &ByteDuplex from &mut ByteDuplex | &mut MonotonicClock {
  return run withRequest<&'loan mut Request<'loan, 'connection, 'transport, P>, never>(
    move connection, Option.none<Instant>(), leak,
  )
}

fn retainOffer(mut parser: RequestParser) -> () {
  let head = match move RequestParser.head(&parser) {
    Result.Failure {error} => { drop error return () }
    Result.Success {value} => value
  }
  let offer = match move inspect(&head, UpgradeLimits.default()) {
    Result.Failure {error} => { drop error return () }
    Result.Success {value} => move value
  }
  drop head
  let reset = RequestParser.reset(&mut parser)
  drop reset
  drop offer
  return ()
}
`

it.effect(
  'keeps transport and WebSocket offer loans exclusive and scoped',
  () =>
    Effect.gen(function* () {
      const snapshot = yield* AnalysisFixture.declarations(
        'http-server/ownership',
        encoder.encode(ownershipSource),
      )
      const diagnostics = Analysis.diagnostics(snapshot).map((diagnostic) => ({
        code: diagnostic.code,
        span: ownershipSource.slice(diagnostic.span.start, diagnostic.span.end).trim(),
      }))
      assert.deepEqual(diagnostics, [
        { code: 'SEM0028', span: 'channel' },
        { code: 'OWN0010', span: '&mut request.*' },
        { code: 'SEM0076', span: 'leak' },
        { code: 'SEM0122', span: 'leak' },
        { code: 'OWN0010', span: '&mut parser' },
      ])
    }),
  120_000,
)
