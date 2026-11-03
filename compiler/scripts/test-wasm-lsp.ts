// The language server of the compiler built for wasm32-wasip1, as the docs site's playground runs
// it: one thread that reads standard input between its checks. A scripted session opens a
// document, asks for a hover and a completion, and shuts the server down.
//
//   node compiler/scripts/test-wasm-lsp.ts <silkc.wasm> <stdlib directory>
import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const timeoutMs = 60_000

// The child half: runs the compiler as a WASI command over this process's standard streams.
const serve = async (module: string, args: ReadonlyArray<string>) => {
  const { WASI } = await import('node:wasi')
  const wasi = new WASI({
    version: 'preview1',
    args: ['silkc', ...args],
    env: {},
    preopens: { '/': '/' },
    returnOnExit: true,
  })
  const compiled = await WebAssembly.compile(readFileSync(module))
  const instance = await WebAssembly.instantiate(compiled, wasi.getImportObject() as WebAssembly.Imports)
  process.exitCode = wasi.start(instance)
}

const session = async (module: string, stdlib: string) => {
  const root = mkdtempSync(join(tmpdir(), 'silk-wasm-lsp-'))
  try {
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'silk.toml'), '[package]\nname = "demo"\nversion = "0.0.0"\n')
    const text = [
      'fn twice(value: i32) -> i32 {',
      '  return value * 2',
      '}',
      '',
      'pub fn main() -> i32 {',
      '  let total = twice(21)',
      '  return tw',
      '}',
      '',
    ].join('\n')
    const path = join(root, 'src', 'main.silk')
    writeFileSync(path, text)
    const uri = pathToFileURL(path).href
    const child = spawn(
      process.execPath,
      ['--no-warnings', fileURLToPath(import.meta.url), 'serve', module, 'lsp', '--stdlib', stdlib],
      { stdio: ['pipe', 'pipe', 'inherit'] },
    )
    const send = (message: Record<string, unknown>) => {
      const content = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }))
      child.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${content.length}\r\n\r\n`), content]))
    }
    const responses = new Map<number, Record<string, unknown>>()
    const diagnostics: Array<Record<string, unknown>> = []
    let pending = Buffer.alloc(0)
    const finished = new Promise<number | null>((done, fail) => {
      const timer = setTimeout(() => {
        child.kill()
        fail(new Error(`the session did not finish within ${timeoutMs} ms`))
      }, timeoutMs)
      child.on('exit', (code) => {
        clearTimeout(timer)
        done(code)
      })
    })
    child.stdout.on('data', (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk])
      while (true) {
        const end = pending.indexOf('\r\n\r\n')
        if (end < 0) break
        const header = /Content-Length: (\d+)/i.exec(pending.subarray(0, end).toString())
        assert.ok(header, `response header without a content length: ${pending.toString()}`)
        const length = Number(header[1])
        if (pending.length < end + 4 + length) break
        const message = JSON.parse(pending.subarray(end + 4, end + 4 + length).toString())
        pending = pending.subarray(end + 4 + length)
        if (message.method === 'textDocument/publishDiagnostics') diagnostics.push(message.params)
        if (typeof message.id !== 'number') continue
        responses.set(message.id, message)
        // Each request waits for the one before, as an editor's do while the user types.
        if (message.id === 1) {
          send({ method: 'initialized', params: {} })
          send({
            method: 'textDocument/didOpen',
            params: { textDocument: { uri, languageId: 'silk', version: 1, text } },
          })
          send({
            id: 2,
            method: 'textDocument/hover',
            params: { textDocument: { uri }, position: { line: 5, character: 15 } },
          })
        }
        if (message.id === 2) {
          send({
            id: 3,
            method: 'textDocument/completion',
            params: { textDocument: { uri }, position: { line: 6, character: 11 } },
          })
        }
        if (message.id === 3) send({ id: 4, method: 'shutdown' })
        if (message.id === 4) send({ method: 'exit' })
      }
    })
    send({
      id: 1,
      method: 'initialize',
      params: { processId: null, rootUri: pathToFileURL(root).href, capabilities: {} },
    })
    assert.equal(await finished, 0, 'the server exits with status 0 after shutdown')
    const hover = JSON.stringify(responses.get(2)?.result)
    assert.match(hover, /fn twice\(value: i32\) -> i32/, `hover: ${hover}`)
    const completion = responses.get(3)?.result as { items?: Array<{ label: string }> } | undefined
    assert.ok(
      completion?.items?.some((item) => item.label === 'twice'),
      `completion: ${JSON.stringify(completion)}`,
    )
    assert.ok(
      diagnostics.some((published) => JSON.stringify(published).includes('SEM0006')),
      `diagnostics: ${JSON.stringify(diagnostics)}`,
    )
    console.log('wasm32-wasip1 language server: hover, completion and diagnostics answered')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const [first, ...rest] = process.argv.slice(2)
if (first === 'serve') {
  const [module, ...args] = rest
  assert.ok(module, 'serve takes the module path')
  await serve(module, args)
} else {
  const stdlib = rest[0]
  assert.ok(first && stdlib, 'usage: node compiler/scripts/test-wasm-lsp.ts <silkc.wasm> <stdlib directory>')
  await session(resolve(first), resolve(stdlib))
}
