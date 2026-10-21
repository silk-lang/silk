// A scripted language server session against one prebuilt native compiler: `silk lsp` starts,
// answers the lifecycle requests one at a time with its input still open, and stops cleanly.
import { strict as assert } from 'node:assert'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as Console from 'effect/Console'
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'

class SessionError extends Data.TaggedError('LspSessionError')<{
  readonly reason: 'Spawn' | 'Timeout' | 'Closed'
  readonly message: string
}> {}

const timeoutMs = 10_000
const frame = (message: unknown) => {
  const content = Buffer.from(JSON.stringify(message))
  return Buffer.concat([Buffer.from(`Content-Length: ${content.length}\r\n\r\n`), content])
}

interface Session {
  readonly child: ChildProcessWithoutNullStreams
  readonly send: (message: unknown) => Effect.Effect<void>
  readonly receive: Effect.Effect<Record<string, unknown>, SessionError>
  readonly exited: Effect.Effect<number | null, SessionError>
}

// Starts `silk lsp` and reads framed responses as they arrive.
const start = (silk: string) =>
  Effect.acquireRelease(
    Effect.try({
      try: (): Session => {
        const child = spawn(silk, ['lsp'], { stdio: 'pipe' })
        let pending = Buffer.alloc(0)
        const ready: Array<Record<string, unknown>> = []
        const waiting: Array<() => void> = []
        child.stdout.on('data', (chunk: Buffer) => {
          pending = Buffer.concat([pending, chunk])
          while (true) {
            const end = pending.indexOf('\r\n\r\n')
            if (end < 0) break
            const header = /Content-Length: (\d+)/i.exec(pending.subarray(0, end).toString())
            assert.ok(header, `response header without a content length: ${pending.toString()}`)
            const length = Number(header[1])
            if (pending.length < end + 4 + length) break
            ready.push(JSON.parse(pending.subarray(end + 4, end + 4 + length).toString()))
            pending = pending.subarray(end + 4 + length)
          }
          waiting.splice(0).forEach((wake) => wake())
        })
        const status = new Promise<number | null>((done) => child.on('exit', (code) => done(code)))
        const within = <A>(promise: Promise<A>, what: string) =>
          Effect.tryPromise({
            try: () =>
              Promise.race([
                promise,
                new Promise<never>(
                  (_, fail) => void setTimeout(() => fail(new Error(what)), timeoutMs).unref(),
                ),
              ]),
            catch: (cause) =>
              new SessionError({ reason: 'Timeout', message: `${what}: ${String(cause)}` }),
          })
        const next = (): Promise<Record<string, unknown>> => {
          const first = ready.shift()
          if (first !== undefined) return Promise.resolve(first)
          return new Promise((wake) => waiting.push(() => wake(next())))
        }
        return {
          child,
          send: (message) => Effect.sync(() => void child.stdin.write(frame(message))),
          receive: Effect.suspend(() => within(next(), 'no response from silk lsp')),
          exited: within(status, 'silk lsp did not exit'),
        }
      },
      catch: (cause) => new SessionError({ reason: 'Spawn', message: String(cause) }),
    }),
    (session) => Effect.sync(() => session.child.kill()),
  )

const request = (session: Session, id: number, method: string, params?: unknown) =>
  Effect.gen(function* () {
    yield* session.send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })
    const response = yield* session.receive
    assert.equal(response['id'], id, JSON.stringify(response))
    return response
  })

const program = Effect.gen(function* () {
  const compiler = process.argv[2]
  assert.ok(compiler, 'usage: node test-native-lsp.ts <native-compiler>')
  const silk = resolve(compiler)

  // The whole lifecycle, each request answered before the next is sent.
  const session = yield* start(silk)
  const early = yield* request(session, 1, 'textDocument/hover')
  assert.deepEqual(early['error'], { code: -32002, message: 'the server is not initialized' })
  const initialized = yield* request(session, 2, 'initialize', {
    processId: null,
    rootUri: null,
    capabilities: { general: { positionEncodings: ['utf-8', 'utf-16'] } },
  })
  const result = initialized['result'] as {
    capabilities: { positionEncoding: string }
    serverInfo: { name: string }
  }
  assert.equal(result.capabilities.positionEncoding, 'utf-8')
  assert.equal(result.serverInfo.name, 'silk')
  yield* session.send({ jsonrpc: '2.0', method: 'initialized', params: {} })
  const unknown = yield* request(session, 3, 'textDocument/hover')
  assert.equal((unknown['error'] as Record<string, unknown>)['code'], -32601)
  const shutdown = yield* request(session, 4, 'shutdown')
  assert.ok('result' in shutdown && shutdown['result'] === null, JSON.stringify(shutdown))
  yield* session.send({ jsonrpc: '2.0', method: 'exit' })
  assert.equal(yield* session.exited, 0, 'exit after shutdown stops the server with status 0')

  // Exit without shutdown, and input that closes before exit, are both status 1.
  const abrupt = yield* start(silk)
  yield* abrupt.send({ jsonrpc: '2.0', method: 'exit' })
  assert.equal(yield* abrupt.exited, 1, 'exit before shutdown is status 1')
  const closed = yield* start(silk)
  yield* Effect.sync(() => closed.child.stdin.end())
  assert.equal(yield* closed.exited, 1, 'closed input stops the server with status 1')

  yield* Console.log(
    'Native language server: scripted initialize, shutdown and exit session passed',
  )
})

const require = createRequire(new URL('../../package.json', import.meta.url))
const { NodeServices }: typeof import('@effect/platform-node') = await import(
  pathToFileURL(require.resolve('@effect/platform-node')).href
)
await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
