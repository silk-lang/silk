// A build with the compiler built for wasm32-wasip1, as the docs site's playground runs it: the
// compiler builds a small program with the direct backend, and the program runs and prints. The
// language server test does not reach the backend, so this is what catches a compiler that only
// fails when it is itself a 32-bit program.
//
//   node compiler/scripts/test-wasm-build.ts <silkc.wasm> <stdlib directory> [version]
//
// `version` is the compiler's release; the program's manifest pins it, as the playground's does.
import { strict as assert } from 'node:assert'
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { WASI } from 'node:wasi'

// Runs `module` as a WASI command with the whole file system visible and its standard output and
// error written to `output`, and answers its exit status.
const run = async (module: Uint8Array, args: ReadonlyArray<string>, output: string): Promise<number> => {
  const fd = openSync(output, 'w')
  try {
    const wasi = new WASI({
      version: 'preview1',
      args: [...args],
      env: {},
      preopens: { '/': '/' },
      stdout: fd,
      stderr: fd,
      returnOnExit: true,
    })
    const compiled = await WebAssembly.compile(module)
    const instance = await WebAssembly.instantiate(compiled, wasi.getImportObject() as WebAssembly.Imports)
    return wasi.start(instance)
  } finally {
    closeSync(fd)
  }
}

const PROGRAM = [
  'import silk.core.effect { Effect }',
  'import silk.io.writer { Writer, WriterError }',
  'import silk.io.writer_native { StdoutWriter }',
  'import silk.text.format { Format }',
  '',
  'fn sum(values: &[i32]) -> i32 {',
  '  let mut total = 0',
  '  let mut index: usize = 0',
  '  while index < values.length {',
  '    total = total + values[index]',
  '    index = index + 1',
  '  }',
  '  return total',
  '}',
  '',
  'pub effect fn main() -> ()',
  '  ! WriterError {',
  '  let mut stdout = StdoutWriter.make()',
  '  let total = sum(&[1, 2, 3, 4])',
  '  run Format.format("Hello from the playground, {}!\\n", &.(total))',
  '    |> Effect.provideMut<Writer>(&mut stdout)',
  '}',
  '',
].join('\n')

const [compilerPath, stdlibPath, version = '0.0.0'] = process.argv.slice(2)
assert.ok(
  compilerPath && stdlibPath,
  'usage: node compiler/scripts/test-wasm-build.ts <silkc.wasm> <stdlib directory> [version]',
)
const root = mkdtempSync(join(tmpdir(), 'silk-wasm-build-'))
try {
  mkdirSync(join(root, 'src'))
  const pin = version.replace(/\+.*$/, '')
  writeFileSync(
    join(root, 'silk.toml'),
    `[package]\nname = "playground"\nversion = "0.0.0"\nsilk-version = "${pin}"\n`,
  )
  const main = join(root, 'src', 'main.silk')
  writeFileSync(main, PROGRAM)
  const built = join(root, 'main.wasm')
  const compilerLog = join(root, 'compiler.txt')
  const compiled = await run(
    readFileSync(resolve(compilerPath)),
    ['silkc', 'build', main, '-o', built, '--target', 'wasm32-wasip1', '--backend', 'direct', '--stdlib', resolve(stdlibPath)],
    compilerLog,
  ).catch((error: unknown) => {
    throw new Error(`the compiler stopped: ${String(error)}\n${readFileSync(compilerLog, 'utf8')}`)
  })
  assert.equal(compiled, 0, `the compiler exits with status 0:\n${readFileSync(compilerLog, 'utf8')}`)
  const programLog = join(root, 'program.txt')
  const ran = await run(readFileSync(built), ['main'], programLog)
  const printed = readFileSync(programLog, 'utf8')
  assert.equal(ran, 0, `the program exits with status 0:\n${printed}`)
  assert.equal(printed, 'Hello from the playground, 10!\n')
  console.log('wasm32-wasip1 compiler: built a program with the direct backend, and it ran')
} finally {
  rmSync(root, { recursive: true, force: true })
}
