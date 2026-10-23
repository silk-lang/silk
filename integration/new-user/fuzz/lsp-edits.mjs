// LSP edit-sequence fuzzer: random edits to a real program, checking the server stays up,
// answers every request, and its diagnostics match `silk check` on the same text.
import { startServer, uriOf } from '../lsp.mjs'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [pkg, seedText, stepsText, mode] = process.argv.slice(2)
let seed = Number(seedText)
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648)
const pick = (list) => list[Math.floor(rand() * list.length)]
const h = { home: process.env.HOME, silkHome: join(process.env.HOME, '.silk') }
const file = join(pkg, 'src/main.silk')
const original = readFileSync(file, 'utf8')
const uri = uriOf(file)
const cold = pkg + '-cold'

function checkCodes(text) {
  rmSync(cold, { recursive: true, force: true })
  mkdirSync(join(cold, 'src'), { recursive: true })
  cpSync(join(pkg, 'silk.toml'), join(cold, 'silk.toml'))
  writeFileSync(join(cold, 'src/main.silk'), text)
  const r = spawnSync('silk', ['check', '--quiet'], { cwd: cold, encoding: 'utf8', env: process.env })
  return [...r.stderr.matchAll(/^src\/main\.silk:(\d+):(\d+): error\[(\w+)\]/gm)].map((m) => `${m[1]}:${m[3]}`).sort()
}
const lspCodes = (diags) => diags.filter((d) => d.severity === 1 || d.severity === undefined).map((d) => `${d.range.start.line + 1}:${d.code}`).sort()

const fragments = ['{', '}', '(', ')', ';', 'let', ' x ', '"', "'", 'run ', 'move ', '&', '.', '::', '<', '>', '|>', '\n', 'fn ', '0', '-> ', 'é', '\u{1F600}', '\t', '//', '/*', 'b"', '\\']
function mutate(text) {
  const at = Math.floor(rand() * text.length)
  switch (Math.floor(rand() * 6)) {
    case 0: return text.slice(0, at) + text.slice(at + 1 + Math.floor(rand() * 20))
    case 1: return text.slice(0, at) + pick(fragments) + text.slice(at)
    case 2: { const lines = text.split('\n'); const i = Math.floor(rand() * lines.length); lines.splice(i, 0, lines[Math.floor(rand() * lines.length)]); return lines.join('\n') }
    case 3: { const lines = text.split('\n'); lines.splice(Math.floor(rand() * lines.length), 1 + Math.floor(rand() * 3)); return lines.join('\n') }
    case 4: return text.slice(0, at) + text.slice(at, at + 40).split('').reverse().join('') + text.slice(at + 40)
    default: return text.replace(/\b(i32|u8|string|Bytes|List)\b/, pick(['i64', 'u16', 'bool', 'Bytes', 'Nope']))
  }
}

const server = startServer(h, pkg)
const timing = []
async function timed(what, promise) {
  const start = Date.now()
  const value = await promise
  timing.push([what, Date.now() - start])
  return value
}
await server.initialize(pkg)
server.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'silk', version: 1, text: original } })
let first = await server.diagnostics(uri, 120000)
console.log('initial diagnostics', first.length)
let version = 1
let text = original
let mismatches = 0
const steps = Number(stepsText)
for (let step = 0; step < steps; step++) {
  text = rand() < 0.15 ? original : mutate(text)
  server.notify('textDocument/didChange', { textDocument: { uri, version: ++version }, contentChanges: [{ text }] })
  if (mode === 'burst' && step < steps - 1) continue
  const diags = await timed('diagnostics', server.diagnostics(uri, 60000))
  const lines = text.split('\n')
  const line = Math.floor(rand() * lines.length)
  const position = { line, character: Math.floor(rand() * (lines[line].length + 1)) }
  const doc = { textDocument: { uri }, position }
  await timed('hover', server.request('textDocument/hover', doc, 30000))
  await timed('completion', server.request('textDocument/completion', doc, 30000))
  await timed('definition', server.request('textDocument/definition', doc, 30000))
  if (step % 5 === 0) await timed('symbols', server.request('textDocument/documentSymbol', { textDocument: { uri } }, 30000))
  if (step % 5 === 0) await timed('formatting', server.request('textDocument/formatting', { textDocument: { uri }, options: { tabSize: 2, insertSpaces: true } }, 30000))
  if (step % 4 === 0) {
    const want = checkCodes(text)
    const got = lspCodes(diags)
    // With syntax errors the server reports only those (by design), so compare only clean parses.
    const parsed = !got.some((code) => /:(PAR|LEX)/.test(code))
    const known = (codes) => codes.filter((code) => !code.endsWith(':SEM0014'))
    if (parsed && JSON.stringify(known(want)) !== JSON.stringify(known(got))) {
      mismatches++
      const dump = join(pkg, `mismatch-${seedText}-${step}.silk`)
      writeFileSync(dump, text)
      console.log(`step ${step}: lsp ${JSON.stringify(got)} check ${JSON.stringify(want)} (text in ${dump})`)
    }
  }
}
// Back to the original text: diagnostics must match a clean check again.
server.notify('textDocument/didChange', { textDocument: { uri, version: ++version }, contentChanges: [{ text: original }] })
const last = await server.diagnostics(uri, 60000)
console.log('final diagnostics', lspCodes(last), 'check', checkCodes(original))
const max = {}
for (const [what, ms] of timing) max[what] = Math.max(max[what] ?? 0, ms)
console.log('slowest ms', JSON.stringify(max), 'mismatches', mismatches)
await server.shutdown()
console.log('stderr:', server.stderr().slice(0, 500))
