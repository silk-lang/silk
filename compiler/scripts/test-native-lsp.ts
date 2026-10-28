// A scripted language server session against one prebuilt native compiler: `silk lsp` starts,
// answers the lifecycle requests one at a time with its input still open, publishes syntax
// diagnostics for an open document as it is edited and semantic diagnostics once its module is
// checked, answers the syntax features about it, and stops cleanly. A last session checks code
// nested close to the parser's limit, where a thread with Darwin's default stack overflows.
import { strict as assert } from 'node:assert'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

// Starts `silk lsp` and reads framed responses as they arrive. With `smallStacks`, GNU libc gives
// new threads a 512 KiB stack by default, as Darwin always does, so a thread that only fits the
// platform default fails here as it would on macOS.
const start = (silk: string, stdlib: string, smallStacks = false) =>
  Effect.acquireRelease(
    Effect.try({
      try: (): Session => {
        const child =
          smallStacks && process.platform === 'linux'
            ? spawn('sh', ['-c', 'ulimit -s 512 && exec "$0" lsp --stdlib "$1"', silk, stdlib], {
                stdio: 'pipe',
              })
            : spawn(silk, ['lsp', '--stdlib', stdlib], { stdio: 'pipe' })
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
        // Once its output closes, a server that will never answer fails the read at once.
        let ended: string | undefined
        child.on('close', (code, signal) => {
          ended = `silk lsp stopped with ${signal ?? `status ${code}`}`
          waiting.splice(0).forEach((wake) => wake())
        })
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
          if (ended !== undefined) return Promise.reject(new Error(ended))
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
    capabilities: { positionEncoding: string; experimental: { standardLibrary: string } }
    serverInfo: { name: string }
  }
  assert.equal(result.capabilities.positionEncoding, 'utf-8')
  assert.equal(result.serverInfo.name, 'silk')
  // Clients send the server the library files it names in go to definition.
  assert.equal(result.capabilities.experimental.standardLibrary, pathToFileURL(stdlib).href)
  yield* session.send({ jsonrpc: '2.0', method: 'initialized', params: {} })

  // An open document in a package gets its syntax diagnostics once the inbox runs dry.
  const directory = mkdtempSync(join(tmpdir(), 'silk-lsp-session-'))
  yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(directory, { recursive: true })))
  writeFileSync(
    join(directory, 'silk.toml'),
    '[package]\nname = "session"\nversion = "0.1.0"\nsource = "."\n',
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

  // An import's module path and members hover and go to definition like any other name.
  const imported = [
    'import silk.option { Option }',
    'pub fn main() -> i32 {',
    '  let none = Option<i32>.none()',
    '  return Option<i32>.unwrapOr(move none, 0)',
    '}',
    '',
  ].join('\n')
  yield* change(session, uri, 7, imported)
  const importing = yield* diagnosticsFor(session, uri, 7, [])
  assert.deepEqual(importing.diagnostics, [], JSON.stringify(importing))
  const member = { textDocument: { uri }, position: { line: 0, character: 22 } }
  const memberShown = yield* request(session, 15, 'textDocument/hover', member)
  assert.ok(
    (memberShown['result'] as { contents: { value: string } }).contents.value.includes(
      'union Option<',
    ),
    JSON.stringify(memberShown),
  )
  const library = pathToFileURL(join(stdlib, 'silk', 'option.silk')).href
  // The doc comment's code links point at the lines of what they name.
  const documented = (memberShown['result'] as { contents: { value: string } }).contents.value
  const optionLines = readFileSync(join(stdlib, 'silk', 'option.silk'), 'utf8').split('\n')
  const someLine = optionLines.findIndex((line) => line.includes('pub fn some(')) + 1
  assert.ok(documented.includes(`[\`some\`](${library}#L${someLine})`), documented)
  // A union case resolves too, and nothing is left as a bare bracketed link.
  const caseLine = optionLines.findIndex((line) => line.trim() === 'None,') + 1
  assert.ok(documented.includes(`[\`None\`](${library}#L${caseLine})`), documented)
  assert.ok(!/\[`[^`]*`\](?!\()/.test(documented), documented)
  const memberDefined = (yield* request(session, 16, 'textDocument/definition', member))[
    'result'
  ] as {
    uri: string
    range: { start: { line: number; character: number } }
  }
  assert.equal(memberDefined.uri, library, JSON.stringify(memberDefined))
  const path = { textDocument: { uri }, position: { line: 0, character: 13 } }
  const pathShown = yield* request(session, 17, 'textDocument/hover', path)
  assert.ok(
    (pathShown['result'] as { contents: { value: string } }).contents.value.includes(
      'module `silk.option`',
    ),
    JSON.stringify(pathShown),
  )
  const pathDefined = yield* request(session, 18, 'textDocument/definition', path)
  assert.deepEqual(pathDefined['result'], {
    uri: library,
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
  })

  // A standard-library file opened from there gets the same features, from the package that
  // reads it.
  const libraryText = readFileSync(join(stdlib, 'silk', 'option.silk'), 'utf8')
  yield* session.send({
    jsonrpc: '2.0',
    method: 'textDocument/didOpen',
    params: {
      textDocument: {
        uri: library,
        languageId: 'silk',
        version: 1,
        text: libraryText,
      },
    },
  })
  const libraryChecked = yield* diagnosticsFor(session, library, 1, [])
  assert.deepEqual(libraryChecked.diagnostics, [], JSON.stringify(libraryChecked))
  const returned = libraryText
    .split('\n')
    .findIndex((line) => line.includes('fn none() -> Option<T>'))
  const inLibrary = {
    textDocument: { uri: library },
    position: {
      line: returned,
      character: libraryText.split('\n')[returned]!.indexOf('Option') + 1,
    },
  }
  const libraryShown = yield* request(session, 19, 'textDocument/hover', inLibrary)
  assert.ok(
    (libraryShown['result'] as { contents: { value: string } }).contents.value.includes(
      'union Option<',
    ),
    JSON.stringify(libraryShown),
  )
  const libraryDefined = (yield* request(session, 20, 'textDocument/definition', inLibrary))[
    'result'
  ] as { uri: string }
  assert.equal(libraryDefined.uri, library, JSON.stringify(libraryDefined))
  yield* session.send({
    jsonrpc: '2.0',
    method: 'textDocument/didClose',
    params: { textDocument: { uri: library } },
  })
  yield* diagnosticsFor(session, library, undefined, [])

  // A body with an error still answers for the statements around it, and a type written as a
  // value's qualifier hovers and goes to definition like its declaration.
  const broken = [
    '/// Counts spaces.',
    'fn countSpaces(text: &[u8]) -> i32 {',
    '  return 0',
    '}',
    '/// Writes nowhere.',
    'pub struct Quiet {}',
    'impl Quiet {',
    '  pub fn make() -> Quiet {',
    '    return Quiet {}',
    '  }',
    '}',
    'pub fn main() -> i32 {',
    '  let quiet = Quiet.make()',
    '  let oops = nope',
    '  return countSpaces(b"a b")',
    '}',
    '',
  ].join('\n')
  yield* change(session, uri, 8, broken)
  const unknown = yield* diagnosticsFor(session, uri, 8, [])
  assert.deepEqual(
    unknown.diagnostics.map(({ range, code }) => ({ line: range.start.line, code })),
    [{ line: 13, code: 'SEM0006' }],
    JSON.stringify(unknown),
  )
  const afterError = { textDocument: { uri }, position: { line: 14, character: 12 } }
  const spaces = (yield* request(session, 21, 'textDocument/hover', afterError))['result'] as {
    contents: { value: string }
  } | null
  assert.ok(spaces?.contents.value.includes('Counts spaces.'), JSON.stringify(spaces))
  const spacesAt = yield* request(session, 22, 'textDocument/definition', afterError)
  assert.deepEqual(spacesAt['result'], {
    uri,
    range: { start: { line: 1, character: 3 }, end: { line: 1, character: 14 } },
  })
  const qualifier = { textDocument: { uri }, position: { line: 12, character: 15 } }
  const quiet = (yield* request(session, 23, 'textDocument/hover', qualifier))['result'] as {
    contents: { value: string }
  } | null
  assert.ok(quiet?.contents.value.includes('pub struct Quiet'), JSON.stringify(quiet))
  assert.ok(quiet?.contents.value.includes('Writes nowhere.'), JSON.stringify(quiet))
  const quietAt = yield* request(session, 24, 'textDocument/definition', qualifier)
  assert.deepEqual(quietAt['result'], {
    uri,
    range: { start: { line: 5, character: 11 }, end: { line: 5, character: 16 } },
  })

  // An import of a name its module lacks is reported on the import, as `silk check` reports it.
  yield* change(session, uri, 9, 'import silk.collections.list { Nope }\n' + fixed)
  const missing = yield* diagnosticsFor(session, uri, 9, [])
  assert.deepEqual(
    missing.diagnostics.map(({ range, code }) => ({ line: range.start.line, code })),
    [{ line: 0, code: 'SEM0014' }],
    JSON.stringify(missing),
  )

  yield* change(session, uri, 10, fixed)
  const restored = yield* diagnosticsFor(session, uri, 10, [])
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
      textDocument: { uri, version: 11 },
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

  // In a workspace, a member sees the open text of a member it depends on, and keeps its saved
  // text once it closes. An import's member list completes only what the module exports.
  const members = yield* start(silk, stdlib)
  yield* request(members, 1, 'initialize', { processId: null, rootUri: null, capabilities: {} })
  yield* members.send({ jsonrpc: '2.0', method: 'initialized', params: {} })
  const workspace = mkdtempSync(join(tmpdir(), 'silk-lsp-workspace-'))
  yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(workspace, { recursive: true })))
  writeFileSync(join(workspace, 'silk.toml'), '[workspace]\nmembers = ["pricing", "store"]\n')
  for (const member of ['pricing', 'store']) mkdirSync(join(workspace, member, 'src'), { recursive: true })
  writeFileSync(
    join(workspace, 'pricing', 'silk.toml'),
    '[package]\nname = "pricing"\nversion = "0.1.0"\nmain = "lib.silk"\nkind = "static-library"\nexports = ["lib"]\n',
  )
  writeFileSync(
    join(workspace, 'store', 'silk.toml'),
    '[package]\nname = "store"\nversion = "0.1.0"\n\n[dependencies]\npricing = { path = "../pricing" }\n',
  )
  const priced = 'pub fn add(a: i32, b: i32) -> i32 {\n  return a + b\n}\n'
  const stored = 'import pricing.lib { add }\n\npub fn main() -> i32 {\n  return add(1, 2) - 3\n}\n'
  writeFileSync(join(workspace, 'pricing', 'src', 'lib.silk'), priced)
  writeFileSync(join(workspace, 'store', 'src', 'main.silk'), stored)
  const pricing = pathToFileURL(join(workspace, 'pricing', 'src', 'lib.silk')).href
  const store = pathToFileURL(join(workspace, 'store', 'src', 'main.silk')).href
  for (const [opened, text] of [
    [pricing, priced],
    [store, stored],
  ] as const) {
    yield* members.send({
      jsonrpc: '2.0',
      method: 'textDocument/didOpen',
      params: { textDocument: { uri: opened, languageId: 'silk', version: 1, text } },
    })
    const clean = yield* diagnosticsFor(members, opened, 1, [])
    assert.deepEqual(clean.diagnostics, [], JSON.stringify(clean))
  }
  // The store's diagnostics are published again, at its unchanged version, once it is rechecked.
  const storeProblems = Effect.gen(function* () {
    while (true) {
      const message = yield* members.receive
      const params = message['params'] as Diagnostics | undefined
      if (message['method'] === 'textDocument/publishDiagnostics' && params?.uri === store) {
        return params.diagnostics.map(({ code }) => code)
      }
    }
  })
  yield* change(members, pricing, 2, priced.replace('pub fn', 'fn'))
  assert.deepEqual(yield* storeProblems, ['SEM0015'])
  yield* change(members, pricing, 3, priced)
  assert.deepEqual(yield* storeProblems, [])
  yield* change(members, pricing, 4, priced.replace('pub fn', 'fn'))
  assert.deepEqual(yield* storeProblems, ['SEM0015'])
  yield* members.send({ jsonrpc: '2.0', method: 'textDocument/didSave', params: { textDocument: { uri: pricing } } })
  yield* members.send({ jsonrpc: '2.0', method: 'textDocument/didClose', params: { textDocument: { uri: pricing } } })
  yield* change(members, store, 2, stored + '\n')
  const kept = yield* diagnosticsFor(members, store, 2, [])
  assert.deepEqual(
    kept.diagnostics.map(({ code }) => code),
    ['SEM0015'],
    'a closed member keeps its saved text',
  )
  yield* change(members, store, 3, 'import silk.collections.list { L }\n' + stored)
  yield* diagnosticsFor(members, store, 3, [])
  yield* members.send({
    jsonrpc: '2.0',
    id: 2,
    method: 'textDocument/completion',
    params: { textDocument: { uri: store }, position: { line: 0, character: 20 } },
  })
  const offered = (yield* notificationsUntil(members, 2)).response
  const labels = (offered['result'] as { items: Array<{ label: string }> }).items.map(({ label }) => label)
  assert.deepEqual(labels, ['List'], JSON.stringify(offered))
  // Diagnostics may still be on their way, so the server is left without a shutdown.
  yield* members.send({ jsonrpc: '2.0', method: 'exit' })
  assert.equal(yield* members.exited, 1)


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

  // The compiler thread checks a chain of 119 operators, close to the deepest the parser accepts
  // inside a function body. Ten were enough to overflow Darwin's 512 KiB thread default.
  const deep = yield* start(silk, stdlib, true)
  yield* request(deep, 1, 'initialize', { processId: null, rootUri: null, capabilities: {} })
  yield* deep.send({ jsonrpc: '2.0', method: 'initialized', params: {} })
  const chain = Array.from({ length: 120 }, (_, at) => `value == ${at}`).join(' || ')
  const nested = `fn listed(value: i32) -> bool {\n  return ${chain}\n}\npub fn main() -> i32 {\n  if listed(3) {\n    return 0\n  }\n  return 1\n}\n`
  writeFileSync(join(directory, 'main.silk'), nested)
  yield* deep.send({
    jsonrpc: '2.0',
    method: 'textDocument/didOpen',
    params: { textDocument: { uri, languageId: 'silk', version: 1, text: nested } },
  })
  // Text without syntax errors publishes its diagnostics once its module is checked.
  const checked = yield* diagnosticsFor(deep, uri, 1, [])
  assert.deepEqual(checked.diagnostics, [], JSON.stringify(checked))
  const answered = yield* request(deep, 2, 'textDocument/documentSymbol', { textDocument: { uri } })
  assert.deepEqual(
    (answered['result'] as Array<{ name: string }>).map(({ name }) => name),
    ['listed', 'main'],
  )
  yield* request(deep, 3, 'shutdown')
  yield* deep.send({ jsonrpc: '2.0', method: 'exit' })
  assert.equal(yield* deep.exited, 0, 'deeply nested code is checked without exhausting the stack')

  yield* Console.log(
    'Native language server: scripted lifecycle, syntax and semantic diagnostics, navigation, syntax features, and deep nesting sessions passed',
  )
})

const require = createRequire(new URL('../../package.json', import.meta.url))
const { NodeServices }: typeof import('@effect/platform-node') = await import(
  pathToFileURL(require.resolve('@effect/platform-node')).href
)
await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
