// Multi-module LSP fuzzer: random edits to a library module while the module that imports it
// stays open. Checks the server stays up, republishes the importer's diagnostics after the
// library changes, and that those diagnostics match `silk check` on the same files.
// Usage: node fuzz/lsp-modules.mjs <empty dir> <seed> <steps>
import { startServer, uriOf } from '../lsp.mjs'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [pkg, seedText, stepsText] = process.argv.slice(2)
let seed = Number(seedText)
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648)
const pick = (list) => list[Math.floor(rand() * list.length)]
const h = { home: process.env.HOME, silkHome: join(process.env.HOME, '.silk') }

const files = {
  'silk.toml': '[package]\nname = "modfuzz"\nversion = "0.1.0"\nroot = "src/main.silk"\n',
  'src/main.silk': `import geo.shapes { Square, area, perimeter }
import geo.util { clamp, twice }

pub fn main() -> i32 {
  let square = Square { side: 4 }
  let total = area(&square) + perimeter(&square)
  return clamp(twice(total), 0, 100) - 96
}
`,
  'src/geo/shapes.silk': `import geo.util { twice }

pub struct Square {
  pub side: i32
}

pub fn area(square: &Square) -> i32 {
  return square.side * square.side
}

pub fn perimeter(square: &Square) -> i32 {
  return twice(twice(square.side))
}
`,
  'src/geo/util.silk': `pub fn twice(value: i32) -> i32 {
  return value * 2
}

pub fn clamp(value: i32, low: i32, high: i32) -> i32 {
  if value < low {
    return low
  }
  if value > high {
    return high
  }
  return value
}
`,
}
rmSync(pkg, { recursive: true, force: true })
for (const [name, text] of Object.entries(files)) {
  mkdirSync(join(pkg, name, '..'), { recursive: true })
  writeFileSync(join(pkg, name), text)
}
const cold = pkg + '-cold'
// `silk check` on a copy holding the edited texts; returns `file:line:code` per error.
function checkCodes(texts) {
  rmSync(cold, { recursive: true, force: true })
  cpSync(pkg, cold, { recursive: true })
  for (const [name, text] of Object.entries(texts)) writeFileSync(join(cold, name), text)
  const r = spawnSync('silk', ['check', '--quiet'], { cwd: cold, encoding: 'utf8', env: process.env })
  if (r.status !== 0 && !/error\[/.test(r.stderr)) throw new Error(`silk check failed oddly:\n${r.stderr}`)
  return [...r.stderr.matchAll(/^(src\/[\w/]+\.silk):(\d+):(\d+): error\[(\w+)\]/gm)].map((m) => `${m[1]}:${m[2]}:${m[4]}`).sort()
}
const lspCodes = (name, diags) => diags.filter((d) => d.severity === 1 || d.severity === undefined).map((d) => `${name}:${d.range.start.line + 1}:${d.code}`)

const before = checkCodes({})
if (before.length !== 0) throw new Error(`fixture does not check: ${before}`)
const fragments = ['{', '}', ';', 'pub ', ' x ', 'i64', 'u8', '&', '.', '\n', 'fn ', '0', '-> ', 'é', '//', 'side', 'Square', 'twice']
function mutate(text) {
  const at = Math.floor(rand() * text.length)
  switch (Math.floor(rand() * 6)) {
    case 0: return text.slice(0, at) + text.slice(at + 1 + Math.floor(rand() * 12))
    case 1: return text.slice(0, at) + pick(fragments) + text.slice(at)
    case 2: return text.replace(/\bpub /, '')
    case 3: return text.replace(/\bi32\b/, pick(['i64', 'u8', 'bool']))
    case 4: return text.replace(/\b(area|perimeter|twice|clamp|side|Square)\b/, (name) => name + 'X')
    default: { const lines = text.split('\n'); lines.splice(Math.floor(rand() * lines.length), 1); return lines.join('\n') }
  }
}

const server = startServer(h, pkg)
await server.initialize(pkg)
const uris = {}
for (const name of Object.keys(files).filter((n) => n.endsWith('.silk'))) {
  uris[name] = uriOf(join(pkg, name))
  server.notify('textDocument/didOpen', { textDocument: { uri: uris[name], languageId: 'silk', version: 1, text: files[name] } })
}
const latest = {}
const seen = (name) => {
  for (let i = server.messages.length - 1; i >= 0; i--) {
    const m = server.messages[i]
    if (m.method === 'textDocument/publishDiagnostics' && m.params.uri === uris[name]) return m.params.diagnostics
  }
  return undefined
}
for (const name of Object.keys(uris)) latest[name] = await server.diagnostics(uris[name], 120000)
console.log('initial', Object.values(latest).map((d) => d.length))

const texts = { ...files }
const versions = { 'src/main.silk': 1, 'src/geo/shapes.silk': 1, 'src/geo/util.silk': 1 }
let mismatches = 0
let stale = 0
const steps = Number(stepsText)
for (let step = 0; step < steps; step++) {
  const target = rand() < 0.5 ? 'src/geo/util.silk' : 'src/geo/shapes.silk'
  texts[target] = rand() < 0.2 ? files[target] : mutate(texts[target])
  server.messages.splice(0)
  server.notify('textDocument/didChange', { textDocument: { uri: uris[target], version: ++versions[target] }, contentChanges: [{ text: texts[target] }] })
  latest[target] = await server.diagnostics(uris[target], 60000)
  // Give the server a moment to republish the importers, then compare what it last said.
  const settle = Date.now() + 1500
  while (Date.now() < settle) await new Promise((done) => setTimeout(done, 100))
  const got = []
  if (process.env.LSP_TRACE) for (const m of server.messages) if (m.method === 'textDocument/publishDiagnostics') console.log(`  ${step} ${target} -> ${m.params.uri.split('/src/')[1]} ${JSON.stringify(m.params.diagnostics.map((d) => `${d.range.start.line + 1}:${d.code}`))}`)
  for (const name of Object.keys(uris)) {
    const d = seen(name)
    if (d !== undefined) latest[name] = d
  }
  const want = checkCodes(texts)
  const parsed = !want.some((c) => /:(PAR|LEX)\d+$/.test(c))
  if (!parsed) continue
  // Compare the importer files only: their diagnostics depend on the edited module.
  for (const name of Object.keys(uris)) if (name !== target) got.push(...lspCodes(name, latest[name]))
  // SEM0014 (import of a missing member) never reaches the editor: finding 31.
  const wantOthers = want.filter((c) => !c.startsWith(target + ':')).sort()
  got.sort()
  if (JSON.stringify(wantOthers) !== JSON.stringify(got)) {
    mismatches++
    const dump = join(pkg, `mismatch-${seedText}-${step}`)
    mkdirSync(dump, { recursive: true })
    for (const [name, text] of Object.entries(texts)) if (name.endsWith('.silk')) writeFileSync(join(dump, name.replaceAll('/', '_')), text)
    console.log(`step ${step} (${target}): lsp ${JSON.stringify(got)} check ${JSON.stringify(wantOthers)}`)
    if (got.length === 0 && wantOthers.length > 0) stale++
  }
  if (step % 10 === 0) await server.request('textDocument/hover', { textDocument: { uri: uris['src/main.silk'] }, position: { line: 5, character: 18 } }, 30000)
}
console.log('mismatches', mismatches, 'importer never told', stale)
await server.shutdown()
console.log('stderr:', server.stderr().slice(0, 500))
