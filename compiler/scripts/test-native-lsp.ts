// A scripted language server session against one prebuilt native compiler: `silk lsp` starts,
// answers the lifecycle requests one at a time with its input still open, publishes syntax
// diagnostics for an open document as it is edited, and stops cleanly.
import { strict as assert } from 'node:assert'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
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

// Reads messages until the response to request `id`, and returns the notifications before it.
const notificationsUntil = (session: Session, id: number) =>
  Effect.gen(function* () {
    const notifications: Array<Record<string, unknown>> = []
    while (true) {
      const message = yield* session.receive
      if (message['id'] === id) return { response: message, notifications }
      notifications.push(message)
    }
  })

interface Diagnostics {
  uri: string
  version?: number
  diagnostics: Array<{ range: { start: { line: number; character: number } }; code: string }>
}

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

  // An open document in a package gets its syntax diagnostics once the inbox runs dry.
  const directory = mkdtempSync(join(tmpdir(), 'silk-lsp-session-'))
  yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(directory, { recursive: true })))
  writeFileSync(
    join(directory, 'silk.toml'),
    '[package]\nname = "session"\nversion = "0.1.0"\nroot = "main.silk"\n',
  )
  const fixed = 'pub fn main() -> i32 {\n  return 0\n}\n'
  writeFileSync(join(directory, 'main.silk'), fixed)
  const uri = pathToFileURL(join(directory, 'main.silk')).href
  const document = {
    uri,
    languageId: 'silk',
    version: 1,
    text: 'pub fn main( -> i32 {\n  return 0\n}\n',
  }
  yield* session.send({
    jsonrpc: '2.0',
    method: 'textDocument/didOpen',
    params: { textDocument: document },
  })
  const opened = (yield* session.receive) as { method: string; params: Diagnostics }
  assert.equal(opened.method, 'textDocument/publishDiagnostics', JSON.stringify(opened))
  assert.equal(opened.params.uri, uri)
  assert.equal(opened.params.version, 1)
  assert.ok(opened.params.diagnostics.length > 0, JSON.stringify(opened))
  assert.equal(opened.params.diagnostics[0]?.range.start.line, 0, JSON.stringify(opened))

  // Edits are analyzed before the next request is answered.
  for (const [version, text] of [
    [2, '// still\n' + document.text],
    [3, fixed],
  ] as const) {
    yield* session.send({
      jsonrpc: '2.0',
      method: 'textDocument/didChange',
      params: { textDocument: { uri, version }, contentChanges: [{ text }] },
    })
  }
  yield* session.send({ jsonrpc: '2.0', id: 3, method: 'textDocument/hover' })
  const edited = yield* notificationsUntil(session, 3)
  const last = edited.notifications.at(-1) as { params: Diagnostics } | undefined
  assert.ok(last, 'edits publish diagnostics before the next response')
  assert.equal(last.params.version, 3, JSON.stringify(edited.notifications))
  assert.deepEqual(last.params.diagnostics, [], 'the fixed text has no syntax diagnostics')
  assert.equal((edited.response['error'] as Record<string, unknown>)['code'], -32601)

  // Closing a document clears its diagnostics.
  yield* session.send({
    jsonrpc: '2.0',
    method: 'textDocument/didClose',
    params: { textDocument: { uri } },
  })
  const cleared = (yield* session.receive) as { params: Diagnostics }
  assert.equal(cleared.params.uri, uri)
  assert.deepEqual(cleared.params.diagnostics, [])

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
    'Native language server: scripted lifecycle and document diagnostics session passed',
  )
})

const require = createRequire(new URL('../../package.json', import.meta.url))
const { NodeServices }: typeof import('@effect/platform-node') = await import(
  pathToFileURL(require.resolve('@effect/platform-node')).href
)
await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
