// Hovers and jumps to the definition at every identifier of one file, as a reader moving the mouse
// over a program would. Reports server errors, slow answers, and identifiers that get no hover.
// Usage: node fuzz/lsp-hover-sweep.mjs <package dir> <file relative to it>
// SWEEP_VERBOSE=1 prints each identifier that gets no hover.
// The server is `silk lsp` from $HOME/.silk/bin; see lsp-modules.mjs for making it a local build.
import { startServer, uriOf } from '../lsp.mjs'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const [pkg, file] = process.argv.slice(2)
const h = { home: process.env.HOME, silkHome: join(process.env.HOME, '.silk') }
const text = readFileSync(join(pkg, file), 'utf8')
const uri = uriOf(join(pkg, file))
const server = startServer(h, pkg)
await server.initialize(pkg)
server.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'silk', version: 1, text } })
const diagnostics = await server.diagnostics(uri, 120_000)
console.log(`diagnostics: ${diagnostics.length}`)

const keywords = new Set(['fn', 'let', 'mut', 'pub', 'return', 'if', 'else', 'while', 'match', 'move', 'run', 'effect', 'struct', 'union', 'enum', 'import', 'as', 'test', 'true', 'false', 'static', 'for', 'in', 'impl', 'interface', 'fail', 'drop', 'const', 'param', 'where', 'self', 'break', 'continue', 'unsafe', 'extern'])
const lines = text.split('\n')
let inString = false
const spots = []
lines.forEach((line, row) => {
  const code = line.replace(/\/\/.*$/, '').replace(/"(?:[^"\\]|\\.)*"/g, (s) => ' '.repeat(s.length))
  for (const m of code.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
    if (keywords.has(m[0])) continue
    spots.push({ row, column: m.index + 1, name: m[0] })
  }
})
let empty = 0
let errors = 0
let slow = 0
const missing = new Map()
for (const spot of spots) {
  const params = { textDocument: { uri }, position: { line: spot.row, character: spot.column } }
  for (const method of ['textDocument/hover', 'textDocument/definition']) {
    const start = Date.now()
    try {
      const result = await server.request(method, params, 30_000)
      const ms = Date.now() - start
      if (ms > 1000) { slow++; console.log(`SLOW ${method} ${spot.name} ${spot.row + 1}:${spot.column}: ${ms} ms`) }
      if (method === 'textDocument/hover' && !(result?.contents?.value)) {
        empty++
        missing.set(spot.name, (missing.get(spot.name) ?? 0) + 1)
        if (process.env.SWEEP_VERBOSE) console.log(`no hover ${spot.name} ${spot.row + 1}:${spot.column}: ${lines[spot.row].trim()}`)
      }
    } catch (error) {
      errors++
      console.log(`ERROR ${method} ${spot.name} ${spot.row + 1}:${spot.column}: ${String(error.message).split('\n')[0]}`)
    }
  }
}
console.log(`spots ${spots.length}, empty hovers ${empty}, errors ${errors}, slow ${slow}`)
console.log('no hover:', [...missing].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([n, c]) => `${n}x${c}`).join(' '))
await server.shutdown()
