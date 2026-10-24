// Types a program into the language server one character at a time, as an editor does: an
// incremental change per key and a completion request after each identifier character. Checks
// that the server stays up, answers every request, how slow the slowest answer is, and that the
// final diagnostics match `silk check`.
//
// node fuzz/lsp-typing.mjs <package> <file to type> [start text file]
// The package's src/main.silk is replaced. With a start text, typing happens at its `@@` marker.
import { startServer, uriOf } from '../lsp.mjs'
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [pkg, typedFile, startFile] = process.argv.slice(2)
const h = { home: process.env.HOME, silkHome: join(process.env.HOME, '.silk') }
const file = join(pkg, 'src/main.silk')
const typed = readFileSync(typedFile, 'utf8')
const start = startFile ? readFileSync(startFile, 'utf8') : '@@'
const at = start.indexOf('@@')
const before = start.slice(0, at)
const after = start.slice(at + 2)
writeFileSync(file, before + after)
const uri = uriOf(file)

const server = startServer(h, pkg)
const init = await server.initialize(pkg)
const sync = init.capabilities.textDocumentSync
const incremental = (typeof sync === 'object' ? sync.change : sync) === 2
server.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'silk', version: 1, text: before + after } })
await server.diagnostics(uri, 120000)

// Line and character of the end of `text`, in UTF-16 units.
function endOf(text) {
  const lines = text.split('\n')
  return { line: lines.length - 1, character: lines.at(-1).length }
}
let version = 1
let current = before
const slowest = { completion: 0, hover: 0 }
let requests = 0
const startAll = Date.now()
// If the server dies, the text typed so far goes to SILK_LSP_TYPING_DUMP (default lsp-typing-crash.silk).
process.on('uncaughtException', (error) => {
  writeFileSync(process.env.SILK_LSP_TYPING_DUMP ?? 'lsp-typing-crash.silk', current + after)
  console.error(`stopped after ${current.length - before.length} typed characters\n${error.stack}`)
  process.exit(1)
})
for (const ch of typed) {
  const position = endOf(current)
  current += ch
  version++
  const change = incremental ? { range: { start: position, end: position }, text: ch } : { text: current + after }
  server.notify('textDocument/didChange', { textDocument: { uri, version }, contentChanges: [change] })
  if (/[A-Za-z_.]/.test(ch)) {
    const doc = { textDocument: { uri }, position: endOf(current) }
    const t = Date.now()
    await server.request('textDocument/completion', doc, 30000)
    slowest.completion = Math.max(slowest.completion, Date.now() - t)
    requests++
    if (requests % 20 === 0) {
      const t2 = Date.now()
      await server.request('textDocument/hover', doc, 30000)
      slowest.hover = Math.max(slowest.hover, Date.now() - t2)
    }
  }
}
const typedMs = Date.now() - startAll
// Drop diagnostics for earlier versions, then wait for the final one.
server.messages.splice(0)
server.notify('textDocument/didSave', { textDocument: { uri } })
let last
for (;;) {
  const message = await server.waitFor((m) => m.method === 'textDocument/publishDiagnostics' && m.params.uri === uri, 'final diagnostics', 60000)
  last = message.params
  if (last.version === undefined || last.version >= version) break
}
writeFileSync(file, current + after)
const check = spawnSync('silk', ['check', '--quiet'], { cwd: pkg, encoding: 'utf8', env: process.env })
const want = [...check.stderr.matchAll(/^src\/main\.silk:(\d+):\d+: error\[(\w+)\]/gm)].map((m) => `${m[1]}:${m[2]}`).sort()
const got = last.diagnostics.filter((d) => d.severity === 1 || d.severity === undefined).map((d) => `${d.range.start.line + 1}:${d.code}`).sort()
console.log(JSON.stringify({ incremental, characters: [...typed].length, completions: requests, typedMs, slowest, final: got, check: want, same: JSON.stringify(got) === JSON.stringify(want) }))
await server.shutdown()
const stderr = server.stderr()
if (stderr) console.log('stderr:', stderr.slice(0, 800))
