// `silk lsp` as an editor starts it: from PATH, in the project folder, with no arguments.
import { strict as assert } from 'node:assert'
import { after, before, test } from 'node:test'
import { compiler, initPackage, join, read, sharedHome, silk, write } from './lib.mjs'
import { positionOf, startServer, uriOf } from './lsp.mjs'

const h = sharedHome()
let dir
let server
let lib

const program = `import silk.effect { Effect }
import silk.logger { LogError }
import silk.os_logger { StdoutLogger }
import util.Text { shout }

fn total(values: &[i32]) -> i32 {
  let mut sum = 0
  let mut at: usize = 0
  while at < values.length {
    sum = sum + values[at]
    at = at + 1
  }
  return sum
}

pub effect fn main() -> ()
  ! LogError {
  let mut logger = StdoutLogger.make()
  let numbers: [i32; 3] = [1, 2, 3]
  let sum = total(&numbers)
  let loudness = shout()
  run Effect.log("{sum} {loudness}\\n", &.{ sum: sum, loudness: loudness }) |> Effect.provideMut(&mut logger)
}
`

before(async () => {
  dir = initPackage(h, 'editor')
  write(join(dir, 'src/main.silk'), program)
  lib = join(dir, 'src/util/Text.silk')
  write(lib, '/// How loud to be.\npub fn shout() -> i32 {\n  return 11\n}\n')
  server = startServer(h, dir)
  await server.initialize(dir)
})

after(async () => {
  if (server !== undefined) await server.shutdown()
})

const uri = () => uriOf(join(dir, 'src/main.silk'))
const at = (text, needle, offset = 1) => ({ textDocument: { uri: uri() }, position: positionOf(text, needle, offset) })
let version = 1
async function open(text) {
  server.notify('textDocument/didOpen', { textDocument: { uri: uri(), languageId: 'silk', version, text } })
  return server.diagnostics(uri())
}
async function change(text) {
  server.notify('textDocument/didChange', { textDocument: { uri: uri(), version: ++version }, contentChanges: [{ text }] })
  return server.diagnostics(uri())
}

test('a clean file opens with no diagnostics', async () => {
  assert.deepEqual(await open(program), [])
})

test('hover shows the signature and doc comment of stdlib, own-package and local items', async () => {
  const value = async (needle, offset) => (await server.request('textDocument/hover', at(program, needle, offset)))?.contents?.value ?? ''
  assert.match(await value('Effect.log', 8), /pub effect fn log<Args>\(/)
  assert.match(await value('Effect.log', 8), /Sends one log message/)
  assert.match(await value('total(&numbers)'), /fn total\(values: &\[i32\]\) -> i32/)
  assert.match(await value('shout()'), /pub fn shout\(\) -> i32[\s\S]*How loud to be\./)
  assert.match(await value('StdoutLogger }', 2), /pub struct StdoutLogger/)
})

test('definition opens the declaring file, stdlib included', async () => {
  const local = await server.request('textDocument/definition', at(program, 'total(&numbers)'))
  assert.equal(local.uri, uri())
  const imported = await server.request('textDocument/definition', at(program, 'shout()'))
  assert.equal(imported.uri, uriOf(lib))
  const stdlib = await server.request('textDocument/definition', at(program, 'Effect.log', 8))
  assert.match(stdlib.uri, /\/lib\/silk\/stdlib\/silk\/effect\.silk$/)
})

test('completion after a type offers its functions', async () => {
  const result = await server.request('textDocument/completion', at(program, 'Effect.log', 7))
  const labels = (result.items ?? result).map((item) => item.label)
  for (const label of ['log', 'provideMut', 'result']) assert.ok(labels.includes(label), `${label} in ${labels.join(', ')}`)
})

// While typing, the file has just `Status.` with nothing after the dot yet.
test('completion right after typing a union type and a dot offers its variants', async () => {
  const withUnion = `${program}\nunion Status {\n  Open,\n  Done { day: u32 },\n}\n\nfn opened() -> Status {\n  return Status.\n}\n`
  await change(withUnion)
  try {
    const result = await server.request('textDocument/completion', at(withUnion, 'Status.\n', 7))
    const labels = (result.items ?? result).map((item) => item.label)
    for (const label of ['Open', 'Done']) assert.ok(labels.includes(label), `${label} in ${labels.join(', ')}`)
  } finally {
    await change(program)
  }
})

test('formatting matches silk format', async () => {
  const messy = program.replace('fn total(values: &[i32]) -> i32 {', 'fn   total(values:&[i32])->i32{')
  await change(messy)
  try {
    const edits = await server.request('textDocument/formatting', { textDocument: { uri: uri() }, options: { tabSize: 2, insertSpaces: true } })
    // `silk format` on the same text, in a scratch package, is the expected layout.
    const scratch = initPackage(h, 'editor-format')
    write(join(scratch, 'src/main.silk'), messy)
    write(join(scratch, 'src/util/Text.silk'), read(lib))
    assert.equal(silk(h, ['format'], { cwd: scratch }).status, 0)
    assert.equal(edits.length, 1)
    assert.equal(edits[0].newText, read(join(scratch, 'src/main.silk')))
  } finally {
    await change(program)
  }
})

test('document symbols list the declarations', async () => {
  const symbols = await server.request('textDocument/documentSymbol', { textDocument: { uri: uri() } })
  assert.deepEqual(symbols.map((symbol) => symbol.name), ['total', 'main'])
})

test('an edit that breaks the code publishes the error, and fixing it clears it', async () => {
  const broken = program.replace('let sum = total(&numbers)', 'let sum = totl(&numbers)')
  const diagnostics = await change(broken)
  try {
    assert.equal(diagnostics.length, 1, JSON.stringify(diagnostics))
    assert.equal(diagnostics[0].code, 'SEM0006')
    assert.match(diagnostics[0].message, /totl/)
    assert.deepEqual(diagnostics[0].range.start, positionOf(broken, 'totl', 0))
  } finally {
    assert.deepEqual(await change(program), [])
  }
})

test('hover still works in a function that has an error elsewhere in it', async () => {
  const broken = program.replace('let numbers: [i32; 3] = [1, 2, 3]', 'let oops = nope\n  let numbers: [i32; 3] = [1, 2, 3]')
  await change(broken)
  try {
    const hover = await server.request('textDocument/hover', at(broken, 'total(&numbers)'))
    assert.notEqual(hover, null)
  } finally {
    await change(program)
  }
})

test('hover on a type used as a qualifier shows its doc comment', async () => {
  const hover = await server.request('textDocument/hover', at(program, 'StdoutLogger.make', 3))
  assert.match(hover?.contents?.value ?? '', /A `Logger` provider/)
})

test('importing a name the module lacks is reported on the import line', async () => {
  const broken = program.replace('import silk.logger { LogError }', 'import silk.logger { LogError, Nope }')
  const diagnostics = await change(broken)
  await change(program)
  assert.ok(diagnostics.some((diagnostic) => diagnostic.code === 'SEM0014' && diagnostic.range.start.line === 1), JSON.stringify(diagnostics))
})

test('a missing import member is still reported when the file has other errors', async () => {
  const other = initPackage(h, 'editor-two-errors')
  const file = join(other, 'src/main.silk')
  write(file, 'import silk.list { Nope }\n\npub fn main() -> i32 {\n  return missing()\n}\n')
  const lone = startServer(h, other)
  await lone.initialize(other)
  lone.notify('textDocument/didOpen', { textDocument: { uri: uriOf(file), languageId: 'silk', version: 1, text: read(file) } })
  const diagnostics = await lone.diagnostics(uriOf(file), 120_000)
  await lone.shutdown()
  const codes = diagnostics.map((diagnostic) => `${diagnostic.range.start.line + 1}:${diagnostic.code}`)
  assert.deepEqual(codes.sort(), ['1:SEM0014', '4:SEM0004'])
})

test('a missing pinned toolchain still starts a server that explains it', { skip: compiler === '' ? false : 'SILK_NEW_USER_COMPILER bypasses the pin' }, async () => {
  const other = initPackage(h, 'editor-unpinned')
  const manifest = join(other, 'silk.toml')
  write(manifest, read(manifest).replace(/^silk-version = .*$/m, 'silk-version = "0.3.0"'))
  const lone = startServer(h, other)
  const init = await lone.initialize(other)
  assert.deepEqual(Object.keys(init.capabilities ?? {}).filter((key) => key !== 'positionEncoding'), [])
  const shown = await lone.waitFor((message) => message.method === 'window/showMessage', 'showMessage')
  assert.match(shown.params.message, /silk toolchain install 0\.3\.0|sew use|silk use/)
  const exited = await lone.shutdown()
  assert.equal(exited.code, 0)
  assert.equal(silk(h, ['--version']).status, 0)
})
