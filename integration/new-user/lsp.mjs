// A small language-server client that talks to `silk lsp` the way an editor does: the server
// is started from PATH in the package folder, with no `--stdlib`, and gets file URIs.
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { userEnv } from './lib.mjs'

export function startServer(h, cwd, args = []) {
  const child = spawn('silk', ['lsp', ...args], { cwd, env: userEnv(h), stdio: 'pipe' })
  let pending = Buffer.alloc(0)
  const messages = []
  const waiters = []
  let stderr = ''
  let closed = false
  child.stderr.on('data', (chunk) => (stderr += chunk))
  child.stdout.on('data', (chunk) => {
    pending = Buffer.concat([pending, chunk])
    for (;;) {
      const end = pending.indexOf('\r\n\r\n')
      if (end < 0) break
      const length = Number(/Content-Length: (\d+)/i.exec(pending.subarray(0, end).toString())[1])
      if (pending.length < end + 4 + length) break
      messages.push(JSON.parse(pending.subarray(end + 4, end + 4 + length).toString()))
      pending = pending.subarray(end + 4 + length)
    }
    wake()
  })
  const exited = new Promise((done) => child.on('close', (code, signal) => {
    closed = true
    wake()
    done({ code, signal })
  }))
  function wake() {
    for (const waiter of waiters.splice(0)) waiter()
  }
  function send(message) {
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }))
    child.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]))
  }
  // Waits for the first unread message that `match` accepts, answering server requests such as
  // `workspace/configuration` with nothing on the way.
  async function waitFor(match, what, timeout = 30_000) {
    const deadline = Date.now() + timeout
    for (;;) {
      const index = messages.findIndex(match)
      if (index >= 0) return messages.splice(index, 1)[0]
      for (const message of messages) {
        if (message.id !== undefined && message.method !== undefined && !message.answered) {
          message.answered = true
          send({ id: message.id, result: null })
        }
      }
      if (closed) throw new Error(`silk lsp exited while waiting for ${what}\n${stderr}`)
      const left = deadline - Date.now()
      if (left <= 0) throw new Error(`timed out waiting for ${what}\n${stderr}`)
      await new Promise((done) => {
        const timer = setTimeout(done, left)
        waiters.push(() => {
          clearTimeout(timer)
          done()
        })
      })
    }
  }
  let nextId = 1
  async function request(method, params, timeout) {
    const id = nextId++
    send({ id, method, params })
    const reply = await waitFor((message) => message.id === id && message.method === undefined, method, timeout)
    if (reply.error !== undefined) throw new Error(`${method} failed: ${JSON.stringify(reply.error)}`)
    return reply.result
  }
  function notify(method, params) {
    send({ method, params })
  }
  // The next publishDiagnostics for `uri`.
  function diagnostics(uri, timeout) {
    return waitFor((message) => message.method === 'textDocument/publishDiagnostics' && message.params.uri === uri, `diagnostics for ${uri}`, timeout).then((message) => message.params.diagnostics)
  }
  async function initialize(root) {
    const result = await request('initialize', {
      processId: process.pid,
      rootUri: pathToFileURL(root).href,
      workspaceFolders: [{ uri: pathToFileURL(root).href, name: 'root' }],
      capabilities: {
        textDocument: {
          hover: { contentFormat: ['markdown', 'plaintext'] },
          completion: { completionItem: { snippetSupport: false } },
          publishDiagnostics: {},
          synchronization: { didSave: true },
        },
        window: { showMessage: {} },
        workspace: { configuration: true, workspaceFolders: true },
      },
    })
    notify('initialized', {})
    return result
  }
  async function shutdown() {
    await request('shutdown', null)
    notify('exit', null)
    return exited
  }
  return { child, send, request, notify, diagnostics, initialize, shutdown, waitFor, messages, exited, stderr: () => stderr }
}

// The LSP position of the first `needle` in `text`, plus `offset` characters.
export function positionOf(text, needle, offset = 0) {
  const at = text.indexOf(needle)
  if (at < 0) throw new Error(`${needle} not in text`)
  const before = text.slice(0, at + offset).split('\n')
  return { line: before.length - 1, character: before.at(-1).length }
}

export const uriOf = (path) => pathToFileURL(path).href
