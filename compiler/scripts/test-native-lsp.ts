// A scripted language server session against one prebuilt native compiler: `silk lsp` starts,
// answers the lifecycle requests one at a time with its input still open, publishes syntax
// diagnostics for an open document as it is edited and semantic diagnostics once its module is
// checked, answers the syntax features about it, and stops cleanly. A last session checks code
// nested close to the parser's limit, where a thread with Darwin's default stack overflows.
import { strict as assert } from 'node:assert'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
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

const timeoutMs = 120_000
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
const start = (silk: string, stdlib: string, smallStacks = false, env: NodeJS.ProcessEnv = process.env) =>
  Effect.acquireRelease(
    Effect.try({
      try: (): Session => {
        const child =
          smallStacks && process.platform === 'linux'
            ? spawn('sh', ['-c', 'ulimit -s 512 && exec "$0" lsp --stdlib "$1"', silk, stdlib], {
                stdio: 'pipe',
                env,
              })
            : spawn(silk, ['lsp', '--stdlib', stdlib], { stdio: 'pipe', env })
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
  diagnostics: Array<{
    range: { start: { line: number; character: number }; end: { line: number; character: number } }
    code: string
  }>
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

// Manifest diagnostics use unsaved TOML, not package loading or the Silk parser. This exercises
// the wire boundary (including incremental edit coordinates), which schema unit tests cannot.
const manifestSession = Effect.fnUntraced(function* (
  session: Session,
  directory: string,
  encoding: 'utf-8' | 'utf-16',
) {
  // Escaping the basename also checks that classification happens after URI decoding.
  const uri = pathToFileURL(join(directory, 'silk.toml')).href.replace('silk.toml', '%73ilk.toml')
  const text = 'package = { name = "session", description = "é😀", version = 7 }\n'
  yield* session.send({
    jsonrpc: '2.0',
    method: 'textDocument/didOpen',
    params: { textDocument: { uri, languageId: 'toml', version: 1, text } },
  })
  const opened = yield* diagnosticsFor(session, uri, 1, [])
  const character = encoding === 'utf-8' ? 64 : 61
  assert.deepEqual(
    opened.diagnostics.map(({ code, range }) => ({ code, range })),
    [{
      code: 'MANIFEST_SCHEMA',
      range: {
        start: { line: 0, character },
        end: { line: 0, character: character + 1 },
      },
    }],
    `${encoding}: unsaved manifest value has an encoded range, not Silk syntax diagnostics`,
  )
  const formatting = yield* request(session, 70, 'textDocument/formatting', {
    textDocument: { uri },
    options: { tabSize: 2, insertSpaces: true },
  })
  assert.equal(formatting['result'], null, 'manifest text is never offered Silk formatting')
  yield* session.send({
    jsonrpc: '2.0',
    method: 'textDocument/didChange',
    params: {
      textDocument: { uri, version: 2 },
      contentChanges: [{
        range: {
          start: { line: 0, character },
          end: { line: 0, character: character + 1 },
        },
        text: '"0.1.0"',
      }],
    },
  })
  const valid = yield* diagnosticsFor(session, uri, 2, [])
  assert.deepEqual(valid.diagnostics, [], 'an incremental valid edit clears schema diagnostics')
  yield* change(session, uri, 3, '[package')
  const malformed = yield* diagnosticsFor(session, uri, 3, [])
  assert.deepEqual(malformed.diagnostics.map(({ code }) => code), ['TOML'])
  yield* session.send({
    jsonrpc: '2.0',
    method: 'textDocument/didClose',
    params: { textDocument: { uri } },
  })
  const closed = yield* diagnosticsFor(session, uri, undefined, [])
  assert.deepEqual(closed.diagnostics, [], 'close clears syntax diagnostics without a version')

  const otherUri = pathToFileURL(`${directory}-silk.toml`).href
  yield* session.send({
    jsonrpc: '2.0',
    method: 'textDocument/didOpen',
    params: { textDocument: { uri: otherUri, languageId: 'toml', version: 1, text } },
  })
  const other = yield* diagnosticsFor(session, otherUri, 1, [])
  assert.ok(
    other.diagnostics.every(({ code }) => code !== 'MANIFEST_SCHEMA' && code !== 'TOML'),
    'unrelated TOML files are not manifest documents',
  )
  yield* session.send({
    jsonrpc: '2.0',
    method: 'textDocument/didClose',
    params: { textDocument: { uri: otherUri } },
  })
  assert.deepEqual((yield* diagnosticsFor(session, otherUri, undefined, [])).diagnostics, [])
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
    'import silk.core.option { Option }',
    'pub fn main() -> i32 {',
    '  let none = Option<i32>.none()',
    '  return Option<i32>.unwrapOr(move none, 0)',
    '}',
    '',
  ].join('\n')
  yield* change(session, uri, 7, imported)
  const importing = yield* diagnosticsFor(session, uri, 7, [])
  assert.deepEqual(importing.diagnostics, [], JSON.stringify(importing))
  const member = { textDocument: { uri }, position: { line: 0, character: 27 } }
  const memberShown = yield* request(session, 15, 'textDocument/hover', member)
  assert.ok(
    (memberShown['result'] as { contents: { value: string } }).contents.value.includes(
      'union Option<',
    ),
    JSON.stringify(memberShown),
  )
  const library = pathToFileURL(join(stdlib, 'silk', 'core', 'option.silk')).href
  // The doc comment's code links point at the lines of what they name.
  const documented = (memberShown['result'] as { contents: { value: string } }).contents.value
  const optionLines = readFileSync(join(stdlib, 'silk', 'core', 'option.silk'), 'utf8').split('\n')
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
  const path = { textDocument: { uri }, position: { line: 0, character: 18 } }
  const pathShown = yield* request(session, 17, 'textDocument/hover', path)
  assert.ok(
    (pathShown['result'] as { contents: { value: string } }).contents.value.includes(
      'module `silk.core.option`',
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
  const libraryText = readFileSync(join(stdlib, 'silk', 'core', 'option.silk'), 'utf8')
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
    // The unused locals are warnings published beside the error.
    [
      { line: 13, code: 'SEM0006' },
      { line: 12, code: 'SEM0255' },
      { line: 13, code: 'SEM0255' },
    ],
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

  // Both negotiated encodings must locate non-ASCII manifest fields and apply ranged changes.
  for (const encoding of ['utf-8', 'utf-16'] as const) {
    const manifests = yield* start(silk, stdlib)
    const initialized = yield* request(manifests, 1, 'initialize', {
      processId: null,
      rootUri: null,
      capabilities: { general: { positionEncodings: [encoding] } },
    })
    const result = initialized['result'] as { capabilities: { positionEncoding: string } }
    assert.equal(result.capabilities.positionEncoding, encoding)
    yield* manifests.send({ jsonrpc: '2.0', method: 'initialized', params: {} })
    yield* manifestSession(manifests, directory, encoding)
    yield* request(manifests, 2, 'shutdown')
    yield* manifests.send({ jsonrpc: '2.0', method: 'exit' })
    assert.equal(yield* manifests.exited, 0)
  }
  yield* Console.log('Native manifest LSP: UTF-8/UTF-16 ranges, incremental fixes, syntax, close and TOML isolation passed')

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
    '[package]\nname = "pricing"\nversion = "0.1.0"\nmain = "lib.silk"\nkind = "library"\nexports = ["lib"]\n',
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
    params: { textDocument: { uri: store }, position: { line: 0, character: 32 } },
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


  // Saved requests own parameter values and generated/native inputs. The editor never evaluates
  // the deliberately invalid package plan while reading them, and selects only the plan's set.
  const plannedRoot = join(directory, 'planned')
  yield* Effect.try({
    try: () => {
      cpSync(resolve('compiler/fixtures/compilation-request'), plannedRoot, { recursive: true })
      writeFileSync(join(plannedRoot, 'silk.toml'), '[package]\nname = "request-fixture"\nversion = "0.1.0"\nsource = "."\n[workspace]\nmembers = []\noutput-dir = "editor-output"\n')
      writeFileSync(join(plannedRoot, 'build.silk'), 'this is not a build plan\n')
      writeFileSync(join(plannedRoot, 'main.silk'),
        'import dep.value { answer }\nstatic if answer == 42 { pub fn main() -> i32 { return 0 } } else { pub fn main() -> i32 { return "wrong" } }\n')
      mkdirSync(join(plannedRoot, 'editor-output/requests'), { recursive: true })
    },
    catch: (cause) => new SessionError({ reason: 'Spawn', message: String(cause) }),
  })
  const savedSource = readFileSync(join(plannedRoot, 'main.silk'), 'utf8')
  const savedUri = pathToFileURL(join(plannedRoot, 'main.silk')).href
  const requestsRoot = join(plannedRoot, 'editor-output/requests')
  const savedRequest = readFileSync(join(plannedRoot, 'request.toml'), 'utf8')
    .replaceAll('/REQUEST_ROOT', plannedRoot).replaceAll('/STDLIB_ROOT', stdlib)
    .replace('flags = []', 'flags = ["-DREQUEST_FLAG=1"]')
    .replace('optimization = "none"', 'optimization = "speed"')
    .replace('debug = false', 'debug = true')
    .replace('cpu-features = []', 'cpu = "x86-64-v3"\ncpu-features = []')
  const aRequest = savedRequest.replace('name = "request-fixture"', 'name = "a"')
  const bRequest = savedRequest.replace('name = "request-fixture"', 'name = "b"').replace('decimal = "42"', 'decimal = "24"')
  writeFileSync(join(requestsRoot, 'a.toml'), aRequest)
  writeFileSync(join(requestsRoot, 'b.toml'), bRequest)
  writeFileSync(join(requestsRoot, '0-unplanned.toml'), bRequest)
  writeFileSync(join(requestsRoot, 'plan.json'), JSON.stringify({ version: 1, files: ['a.toml', 'b.toml'] }))
  // Plan authorizations go to the session's own SILK_HOME, never the developer's.
  const silkHome = join(directory, 'silk-home')
  const planned = yield* start(silk, stdlib, false, { ...process.env, SILK_HOME: silkHome })
  yield* request(planned, 1, 'initialize', {
    capabilities: { workspace: { didChangeWatchedFiles: { dynamicRegistration: true } } },
    initializationOptions: { compilation: 'b', workspaceTrusted: false },
  })
  yield* planned.send({ jsonrpc: '2.0', method: 'initialized', params: {} })
  const registration = yield* planned.receive
  assert.equal(registration['method'], 'client/registerCapability')
  yield* planned.send({ jsonrpc: '2.0', id: registration['id'], result: null })
  yield* planned.send({ jsonrpc: '2.0', method: 'textDocument/didOpen',
    params: { textDocument: { uri: savedUri, languageId: 'silk', version: 1, text: savedSource } } })
  const selectedB = yield* diagnosticsFor(planned, savedUri, 1, [])
  assert.ok(selectedB.diagnostics.some(({ code }) => code === 'SEM0129'), JSON.stringify(selectedB))
  const nativeCommands = JSON.parse(readFileSync(join(plannedRoot, 'editor-output/compile_commands.json'), 'utf8')) as Array<{ file: string; arguments: string[] }>
  assert.equal(nativeCommands.length, 2, 'the compilation database includes only the plan request set')
  assert.ok(nativeCommands.every((command) => command.arguments.includes('-DREQUEST_FLAG=1') && command.file === join(plannedRoot, 'native.c')))
  assert.ok(nativeCommands.every((command) => ['-O2', '-g', '-march=x86-64-v3'].every((flag) => command.arguments.includes(flag))))
  yield* planned.send({ jsonrpc: '2.0', method: 'workspace/didChangeConfiguration', params: { settings: { silk: { compilation: 'a' } } } })
  const selectedA = yield* diagnosticsFor(planned, savedUri, 1, [])
  assert.deepEqual(selectedA.diagnostics, [], JSON.stringify(selectedA))
  writeFileSync(join(requestsRoot, 'a.toml'), aRequest.replace('decimal = "42"', 'decimal = "24"'))
  yield* planned.send({ jsonrpc: '2.0', method: 'workspace/didChangeWatchedFiles',
    params: { changes: [{ uri: pathToFileURL(join(requestsRoot, 'a.toml')).href, type: 2 }] } })
  const refreshed = yield* diagnosticsFor(planned, savedUri, 1, [])
  assert.ok(refreshed.diagnostics.some(({ code }) => code === 'SEM0129'), JSON.stringify(refreshed))
  // With no explicit selection, the plan's first compilation is used, not the earlier unrelated file.
  writeFileSync(join(requestsRoot, 'a.toml'), aRequest)
  yield* planned.send({ jsonrpc: '2.0', method: 'workspace/didChangeConfiguration', params: { settings: {} } })
  assert.deepEqual((yield* diagnosticsFor(planned, savedUri, 1, [])).diagnostics, [])
  // Editing a malformed manifest does not invalidate a complete saved compilation request.
  writeFileSync(join(plannedRoot, 'silk.toml'), '[package\n')
  yield* planned.send({ jsonrpc: '2.0', method: 'workspace/didChangeConfiguration', params: { settings: { silk: { compilation: 'a' } } } })
  yield* planned.send({ jsonrpc: '2.0', id: 80, method: 'textDocument/documentSymbol', params: { textDocument: { uri: savedUri } } })
  const malformedManifest = yield* notificationsUntil(planned, 80)
  const staleHints = malformedManifest.notifications.filter((message) => message['method'] === 'window/showMessage')
  assert.equal(staleHints.length, 1, JSON.stringify(malformedManifest))
  assert.match(JSON.stringify(staleHints[0]), /run `silk plan`/)
  assert.deepEqual((yield* diagnosticsFor(planned, savedUri, 1, malformedManifest.notifications)).diagnostics, [])
  unlinkSync(join(plannedRoot, 'silk.toml'))
  yield* planned.send({ jsonrpc: '2.0', method: 'workspace/didChangeConfiguration', params: { settings: { silk: { compilation: 'a' } } } })
  assert.deepEqual((yield* diagnosticsFor(planned, savedUri, 1, [])).diagnostics, [], 'a removed manifest retains the custom output request')
  writeFileSync(join(plannedRoot, 'silk.toml'), '[package]\nname = "request-fixture"\nversion = "0.1.0"\nsource = "."\n[workspace]\nmembers = []\noutput-dir = "editor-output"\n')
  // A custom Plan command is project code, so the server asks before it runs one, and runs it
  // with the developer's permissions once allowed. The answer lives in SILK_HOME, keyed by the
  // repository's common Git directory, so a worktree of the same repository is not asked again.
  const plans = join(silkHome, 'editor-plans')
  const tasksSource = (witness: string) => `
import silk.cli.command { Command, CommandLine }
import silk.cli.task { Task, TaskSet }
import silk.mem.allocator { Allocator, OutOfMemoryError }
import silk.system.filesystem { FileSystem, FileError, Path }
import silk.system.host_input { HostInput }
union Tasks { Plan }
impl CommandLine for Tasks { static fn command() -> Command<Self> { return Command<Self>.make("editor", "Editor plan") } }
impl TaskSet for Tasks {
  effect fn perform(self: Self) -> () ! FileError | OutOfMemoryError ? &mut Allocator | &mut FileSystem {
    drop self
    run FileSystem.writeFileWithParents(&run Path.make(${JSON.stringify(witness)}), b"entered")
  }
}
pub effect fn main() -> i32 ? &mut HostInput { return run Task.main<Tasks>() }
`
  // The plan's witness sits outside the request directory, which a failed plan restores.
  const entered = join(plannedRoot, 'editor-output/steps/plan-entered')
  mkdirSync(join(plannedRoot, '.git'), { recursive: true })
  unlinkSync(join(plannedRoot, 'build.silk'))
  writeFileSync(join(plannedRoot, 'tasks.silk'), tasksSource(entered))
  const asksIn = (notifications: Array<Record<string, unknown>>) =>
    notifications.filter((message) => message['method'] === 'window/showMessageRequest')
  const notesIn = (notifications: Array<Record<string, unknown>>) =>
    notifications.filter((message) => message['method'] === 'window/showMessage')
  yield* planned.send({ jsonrpc: '2.0', method: 'workspace/didChangeConfiguration',
    params: { settings: { workspaceTrusted: true, refreshPlan: true } } })
  yield* planned.send({ jsonrpc: '2.0', id: 81, method: 'textDocument/documentSymbol', params: { textDocument: { uri: savedUri } } })
  const asking = yield* notificationsUntil(planned, 81)
  const asked = asksIn(asking.notifications)
  assert.equal(asked.length, 1, JSON.stringify(asking.notifications))
  assert.equal(asked[0]!['id'], 'silk-plan-0')
  const question = asked[0]!['params'] as { message: string; actions: Array<{ title: string }> }
  assert.deepEqual(question.actions.map(({ title }) => title), ['Allow', 'Not now'])
  assert.ok(question.message.includes(realpathSync(join(plannedRoot, '.git'))), question.message)
  assert.equal(existsSync(entered), false, 'nothing runs before the developer answers')
  const outdatedNotes = notesIn(asking.notifications)
  assert.equal(outdatedNotes.length, 1, JSON.stringify(asking.notifications))
  assert.match(JSON.stringify(outdatedNotes[0]), /tasks\.silk changed/)
  const waiting = yield* diagnosticsFor(planned, savedUri, 1, asking.notifications)
  assert.deepEqual(waiting.diagnostics, [], 'the saved requests stay in use while the question is open')
  // Not now keeps the saved requests and is not asked again in the session.
  yield* planned.send({ jsonrpc: '2.0', id: 'silk-plan-0', result: { title: 'Not now' } })
  yield* planned.send({ jsonrpc: '2.0', method: 'workspace/didChangeConfiguration',
    params: { settings: { workspaceTrusted: true, refreshPlan: true } } })
  yield* planned.send({ jsonrpc: '2.0', id: 82, method: 'textDocument/documentSymbol', params: { textDocument: { uri: savedUri } } })
  const declined = yield* notificationsUntil(planned, 82)
  assert.equal(asksIn(declined.notifications).length, 0, JSON.stringify(declined.notifications))
  assert.equal(notesIn(declined.notifications).length, 0, 'the outdated note is shown once per session')
  assert.equal(existsSync(entered), false)
  assert.equal(existsSync(plans), false, 'Not now records nothing')
  yield* planned.send({ jsonrpc: '2.0', id: 2, method: 'shutdown' })
  yield* notificationsUntil(planned, 2)
  yield* planned.send({ jsonrpc: '2.0', method: 'exit' })
  assert.equal(yield* planned.exited, 0)

  // A new session asks again; Allow records the repository and runs the plan.
  const allowing = yield* start(silk, stdlib, false, { ...process.env, SILK_HOME: silkHome })
  yield* request(allowing, 1, 'initialize', {
    capabilities: {},
    initializationOptions: { workspaceTrusted: true, refreshPlan: true },
  })
  yield* allowing.send({ jsonrpc: '2.0', method: 'initialized', params: {} })
  yield* allowing.send({ jsonrpc: '2.0', method: 'textDocument/didOpen',
    params: { textDocument: { uri: savedUri, languageId: 'silk', version: 1, text: savedSource } } })
  yield* allowing.send({ jsonrpc: '2.0', id: 3, method: 'textDocument/documentSymbol', params: { textDocument: { uri: savedUri } } })
  const reasked = yield* notificationsUntil(allowing, 3)
  assert.equal(asksIn(reasked.notifications).length, 1, JSON.stringify(reasked.notifications))
  yield* allowing.send({ jsonrpc: '2.0', id: 'silk-plan-0', result: { title: 'Allow' } })
  yield* allowing.send({ jsonrpc: '2.0', id: 4, method: 'textDocument/documentSymbol', params: { textDocument: { uri: savedUri } } })
  const allowed = yield* notificationsUntil(allowing, 4)
  assert.equal(asksIn(allowed.notifications).length, 0)
  const records = readdirSync(plans)
  assert.equal(records.length, 1, JSON.stringify(records))
  assert.equal(readFileSync(join(plans, records[0]!), 'utf8'), `git:${realpathSync(join(plannedRoot, '.git'))}\n`)
  assert.ok(existsSync(entered), 'the allowed Plan command ran')
  assert.deepEqual((yield* diagnosticsFor(allowing, savedUri, 1, allowed.notifications)).diagnostics, [])

  // A linked worktree of the same repository shares the authorization.
  const worktreeRoot = join(directory, 'planned-worktree')
  const worktreeEntered = join(worktreeRoot, 'editor-output/steps/plan-entered')
  cpSync(plannedRoot, worktreeRoot, { recursive: true, filter: (path) => !path.endsWith('/.git') })
  rmSync(join(worktreeRoot, 'editor-output/steps'), { recursive: true, force: true })
  mkdirSync(join(plannedRoot, '.git/worktrees/copy'), { recursive: true })
  writeFileSync(join(plannedRoot, '.git/worktrees/copy/commondir'), '../..\n')
  writeFileSync(join(worktreeRoot, '.git'), `gitdir: ${join(plannedRoot, '.git/worktrees/copy')}\n`)
  writeFileSync(join(worktreeRoot, 'tasks.silk'), tasksSource(worktreeEntered))
  const worktreeUri = pathToFileURL(join(worktreeRoot, 'main.silk')).href
  yield* allowing.send({ jsonrpc: '2.0', method: 'textDocument/didOpen',
    params: { textDocument: { uri: worktreeUri, languageId: 'silk', version: 1, text: savedSource } } })
  yield* allowing.send({ jsonrpc: '2.0', id: 5, method: 'textDocument/documentSymbol', params: { textDocument: { uri: worktreeUri } } })
  const shared = yield* notificationsUntil(allowing, 5)
  assert.equal(asksIn(shared.notifications).length, 0, JSON.stringify(shared.notifications))
  assert.ok(existsSync(worktreeEntered), 'the worktree runs its Plan command without a new question')
  assert.equal(readdirSync(plans).length, 1)

  // Without a Plan variant nothing is asked and the tasks program is not even built.
  const tasksBuild = join(plannedRoot, 'editor-output/steps/tasks')
  rmSync(join(plannedRoot, 'editor-output/steps'), { recursive: true, force: true })
  writeFileSync(join(plannedRoot, 'tasks.silk'), tasksSource(entered).replace('union Tasks { Plan }', 'union Tasks { Lint }'))
  yield* allowing.send({ jsonrpc: '2.0', method: 'workspace/didChangeConfiguration',
    params: { settings: { workspaceTrusted: true, refreshPlan: true } } })
  yield* allowing.send({ jsonrpc: '2.0', id: 7, method: 'textDocument/documentSymbol', params: { textDocument: { uri: savedUri } } })
  const builtIn = yield* notificationsUntil(allowing, 7)
  assert.equal(asksIn(builtIn.notifications).length, 0, JSON.stringify(builtIn.notifications))
  assert.equal(existsSync(tasksBuild), false, 'the built-in plan never builds the tasks program')
  assert.equal(existsSync(entered), false)

  // Turning refresh off prevents any run on the next settings change.
  writeFileSync(join(plannedRoot, 'tasks.silk'), tasksSource(entered))
  yield* allowing.send({ jsonrpc: '2.0', method: 'workspace/didChangeConfiguration',
    params: { settings: { workspaceTrusted: true, refreshPlan: false } } })
  assert.deepEqual((yield* diagnosticsFor(allowing, savedUri, 1, [])).diagnostics, [])
  assert.equal(existsSync(entered), false)
  yield* allowing.send({ jsonrpc: '2.0', id: 6, method: 'shutdown' })
  yield* notificationsUntil(allowing, 6)
  yield* allowing.send({ jsonrpc: '2.0', method: 'exit' })
  assert.equal(yield* allowing.exited, 0)

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
    'Native language server: scripted lifecycle, syntax, semantic and manifest diagnostics, navigation, syntax features, and deep nesting sessions passed',
  )
})

const require = createRequire(new URL('../../package.json', import.meta.url))
const { NodeServices }: typeof import('@effect/platform-node') = await import(
  pathToFileURL(require.resolve('@effect/platform-node')).href
)
await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
