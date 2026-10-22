// A scripted language server session against one prebuilt native compiler: `silk lsp` starts,
// answers the lifecycle requests one at a time with its input still open, publishes syntax
// diagnostics for an open document as it is edited and semantic diagnostics once its module is
// checked, answers the syntax features about it, and stops cleanly.
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
const start = (silk: string, stdlib: string) =>
  Effect.acquireRelease(
    Effect.try({
      try: (): Session => {
        const child = spawn(silk, ['lsp', '--stdlib', stdlib], { stdio: 'pipe' })
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

// The diagnostics published for `uri` at `version` (`undefined` for a closed document), from the
// notifications already read and then from the session.
const diagnosticsFor = (
  session: Session,
  uri: string,
  version: number | undefined,
  read: Array<Record<string, unknown>>,
) =>
  Effect.gen(function* () {
    const matches = (message: Record<string, unknown>) => {
      if (message['method'] !== 'textDocument/publishDiagnostics') return false
      const params = message['params'] as Diagnostics
      return params.uri === uri && params.version === version
    }
    const found = read.findLast(matches)
    if (found !== undefined) return found['params'] as Diagnostics
    while (true) {
      const message = yield* session.receive
      if (matches(message)) return message['params'] as Diagnostics
    }
  })

const change = (session: Session, uri: string, version: number, text: string) =>
  session.send({
    jsonrpc: '2.0',
    method: 'textDocument/didChange',
    params: { textDocument: { uri, version }, contentChanges: [{ text }] },
  })

const program = Effect.gen(function* () {
  const compiler = process.argv[2]
  assert.ok(compiler, 'usage: node test-native-lsp.ts <native-compiler>')
  const silk = resolve(compiler)
  const stdlib = resolve(new URL('../../stdlib', import.meta.url).pathname)

  // The whole lifecycle, each request answered before the next is sent.
  const session = yield* start(silk, stdlib)
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

  // Edits are analyzed before the next request is answered. The fixed text has no syntax errors,
  // so its diagnostics wait for its module's semantic check, which runs once the inbox is dry.
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
  yield* session.send({ jsonrpc: '2.0', id: 3, method: 'textDocument/codeLens' })
  const edited = yield* notificationsUntil(session, 3)
  assert.equal((edited.response['error'] as Record<string, unknown>)['code'], -32601)
  const clean = yield* diagnosticsFor(session, uri, 3, edited.notifications)
  assert.deepEqual(clean.diagnostics, [], 'the fixed text has no diagnostics')

  // A type error is published on its line once the module is checked, and clears when fixed.
  const wrong = fixed.replace('return 0', 'return true')
  yield* change(session, uri, 4, wrong)
  const rejected = yield* diagnosticsFor(session, uri, 4, [])
  assert.deepEqual(
    rejected.diagnostics.map(({ range, code }) => ({ line: range.start.line, code })),
    [{ line: 1, code: 'SEM0129' }],
    JSON.stringify(rejected),
  )
  const counted = yield* request(session, 9, 'silk/statistics', { textDocument: { uri } })
  const counters = counted['result'] as { demands: number; hits: number; runs: number }
  assert.ok(counters.runs > 0 && counters.demands >= counters.hits, JSON.stringify(counted))
  yield* change(session, uri, 5, fixed)
  const accepted = yield* diagnosticsFor(session, uri, 5, [])
  assert.deepEqual(accepted.diagnostics, [], 'the fixed text clears the type error')

  // Hover, go to definition, inlay hints and signature help read the checked store.
  const navigated = [
    '/// Doubles a value.',
    'fn twice(value: i32) -> i32 {',
    '  return value + value',
    '}',
    'pub fn main() -> i32 {',
    '  let doubled = twice(2)',
    '  return doubled - 4',
    '}',
    '',
  ].join('\n')
  yield* change(session, uri, 6, navigated)
  const navigable = yield* diagnosticsFor(session, uri, 6, [])
  assert.deepEqual(navigable.diagnostics, [], JSON.stringify(navigable))
  const call = { textDocument: { uri }, position: { line: 5, character: 17 } }
  const hovered = yield* request(session, 10, 'textDocument/hover', call)
  const shown = (hovered['result'] as { contents: { kind: string; value: string } }).contents
  assert.equal(shown.kind, 'markdown')
  assert.ok(shown.value.includes('fn twice(value: i32) -> i32'), JSON.stringify(hovered))
  assert.ok(shown.value.includes('Doubles a value.'), 'a hover shows the doc comment')
  const local = yield* request(session, 11, 'textDocument/hover', {
    textDocument: { uri },
    position: { line: 6, character: 10 },
  })
  assert.ok(
    (local['result'] as { contents: { value: string } }).contents.value.includes('doubled: i32'),
    JSON.stringify(local),
  )
  const defined = yield* request(session, 12, 'textDocument/definition', call)
  assert.deepEqual(defined['result'], {
    uri,
    range: { start: { line: 1, character: 3 }, end: { line: 1, character: 8 } },
  })
  const hinted = yield* request(session, 13, 'textDocument/inlayHint', {
    textDocument: { uri },
    range: { start: { line: 0, character: 0 }, end: { line: 8, character: 0 } },
  })
  assert.deepEqual(hinted['result'], [
    { position: { line: 5, character: 13 }, label: ': i32', kind: 1 },
  ])
  const helped = yield* request(session, 14, 'textDocument/signatureHelp', {
    textDocument: { uri },
    position: { line: 5, character: 22 },
  })
  const help = helped['result'] as {
    signatures: Array<{ label: string; parameters: Array<{ label: string }> }>
    activeParameter: number
  }
  assert.equal(help.signatures[0]?.label, 'fn twice(value: i32) -> i32', JSON.stringify(helped))
  assert.deepEqual(help.signatures[0]?.parameters, [{ label: 'value: i32' }])
  assert.equal(help.activeParameter, 0)
  yield* change(session, uri, 7, fixed)
  const restored = yield* diagnosticsFor(session, uri, 7, [])
  assert.deepEqual(restored.diagnostics, [])

  // The syntax features read the document's latest text.
  const textDocument = { uri }
  const outline = yield* request(session, 5, 'textDocument/documentSymbol', { textDocument })
  const symbols = outline['result'] as Array<{ name: string; kind: number; range: unknown }>
  assert.deepEqual(
    symbols.map(({ name, kind }) => ({ name, kind })),
    [{ name: 'main', kind: 12 }],
  )
  const folding = yield* request(session, 6, 'textDocument/foldingRange', { textDocument })
  assert.deepEqual(folding['result'], [{ startLine: 0, endLine: 1 }])
  const canonical = yield* request(session, 7, 'textDocument/formatting', {
    textDocument,
    options: { tabSize: 2, insertSpaces: true },
  })
  assert.deepEqual(canonical['result'], [], 'a formatted document needs no edits')
  yield* session.send({
    jsonrpc: '2.0',
    method: 'textDocument/didChange',
    params: {
      textDocument: { uri, version: 8 },
      contentChanges: [{ text: 'pub fn main()->i32{return 0}\n' }],
    },
  })
  yield* session.send({
    jsonrpc: '2.0',
    id: 8,
    method: 'textDocument/formatting',
    params: { textDocument, options: { tabSize: 2, insertSpaces: true } },
  })
  const messy = yield* notificationsUntil(session, 8)
  assert.deepEqual(
    messy.response['result'],
    [
      {
        range: { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } },
        newText: fixed,
      },
    ],
    'formatting replaces the whole document with its canonical text',
  )

  // Closing a document clears its diagnostics.
  yield* session.send({
    jsonrpc: '2.0',
    method: 'textDocument/didClose',
    params: { textDocument: { uri } },
  })
  const cleared = yield* diagnosticsFor(session, uri, undefined, messy.notifications)
  assert.deepEqual(cleared.diagnostics, [])

  const shutdown = yield* request(session, 4, 'shutdown')
  assert.ok('result' in shutdown && shutdown['result'] === null, JSON.stringify(shutdown))
  yield* session.send({ jsonrpc: '2.0', method: 'exit' })
  assert.equal(yield* session.exited, 0, 'exit after shutdown stops the server with status 0')

  // Exit without shutdown, and input that closes before exit, are both status 1.
  const abrupt = yield* start(silk, stdlib)
  yield* abrupt.send({ jsonrpc: '2.0', method: 'exit' })
  assert.equal(yield* abrupt.exited, 1, 'exit before shutdown is status 1')
  const closed = yield* start(silk, stdlib)
  yield* Effect.sync(() => closed.child.stdin.end())
  assert.equal(yield* closed.exited, 1, 'closed input stops the server with status 1')

  yield* Console.log(
    'Native language server: scripted lifecycle, syntax and semantic diagnostics, navigation, and syntax features session passed',
  )
})

const require = createRequire(new URL('../../package.json', import.meta.url))
const { NodeServices }: typeof import('@effect/platform-node') = await import(
  pathToFileURL(require.resolve('@effect/platform-node')).href
)
await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
