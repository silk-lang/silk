import * as assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// Hash every consumer Silk source, including fixture imports and the live stdlib.
const sourceDigests = (directory) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sourceDigests(path)
    if (!entry.name.endsWith('.silk')) return []
    return [[path, createHash('sha256').update(readFileSync(path)).digest('hex')]]
  })

const bundle = resolve('.scratch/selfhost-verification.mjs')
const { runtimeIntrinsicNames } = await import(pathToFileURL(bundle).href)
const temporary = mkdtempSync(join(tmpdir(), 'silk-verification-smoke-'))
try {
  const checkout = join(temporary, 'checkout')
  mkdirSync(checkout)
  const archive = execFileSync(
    'git',
    ['archive', 'HEAD', 'packages/compiler', 'examples', 'openspec'],
    { maxBuffer: 64 * 1024 * 1024 },
  )
  execFileSync('tar', ['-x', '-C', checkout], { input: archive })
  mkdirSync(join(checkout, 'compiler/scripts'), { recursive: true })
  mkdirSync(join(checkout, 'compiler/src/semantic'), { recursive: true })
  const track = join(checkout, 'compiler/scripts/selfhost-track.json')
  const catalog = join(checkout, 'compiler/src/semantic/IntrinsicCatalog.silk')
  writeFileSync(track, JSON.stringify(['trivial-features']))
  writeFileSync(catalog, `let members = b"${runtimeIntrinsicNames.join('|')}"`)
  execFileSync('git', ['init', '-q'], { cwd: checkout })
  execFileSync('git', ['add', '.'], { cwd: checkout })
  const gate = join(
    checkout,
    'compiler/build/llvm/x86_64-unknown-linux-gnu/release-with-debug/silk-format-gate',
  )
  mkdirSync(join(gate, '..'), { recursive: true })
  writeFileSync(
    gate,
    '#!/bin/sh\nprintf "\\n// formatted witness\\n" >> packages/compiler/stdlib/silk/i32.silk\nprintf "formatted checkout\\n"\n',
  )
  chmodSync(gate, 0o755)
  const bootstrap = join(temporary, 'bootstrap.mjs')
  writeFileSync(
    bootstrap,
    `import {readFileSync} from 'node:fs'; import assert from 'node:assert/strict'; assert.deepEqual(process.argv.slice(2), ['build', '--manifest-path', 'compiler/silk.toml', '--optimization', 'release-with-debug']); assert.ok(readFileSync('packages/compiler/stdlib/silk/i32.silk', 'utf8').includes('formatted witness')); console.log('rebuilt formatted checkout');`,
  )
  const compiler = join(temporary, 'silkc')
  writeFileSync(
    compiler,
    '#!/bin/sh\nif ! grep -q "formatted witness" "$6/silk/i32.silk"; then exit 9; fi\nprintf "#!/bin/sh\\nexit 42\\n" > program\nchmod +x program\n',
  )
  chmodSync(compiler, 0o755)
  const downloaded = join(temporary, 'verification.mjs')
  copyFileSync(bundle, downloaded)
  const invoke = () =>
    spawnSync(process.execPath, [downloaded], {
      cwd: checkout,
      env: {
        ...process.env,
        RUNNER_TEMP: temporary,
        SILKC: compiler,
        SILK_BOOTSTRAP: bootstrap,
        SILK_SELFHOST_CORPUS_CASES: 'trivial-features',
        NODE_PATH: '',
        NODE_OPTIONS: '',
      },
      encoding: 'utf8',
      timeout: 30_000,
    })
  const result = invoke()
  assert.strictEqual(result.status, 0, result.stderr)
  assert.match(result.stdout, /rebuilt formatted checkout/)
  assert.match(result.stdout, /PASS trivial-features/)
  assert.match(readFileSync(join(temporary, 'formatter-safety.log'), 'utf8'), /formatted checkout/)
  // The downloaded tooling must validate consumer data, rather than embed main's track.
  writeFileSync(track, JSON.stringify(['trivial-features', 'trivial-features']))
  assert.notStrictEqual(invoke().status, 0)
  writeFileSync(track, JSON.stringify(['trivial-features']))
  writeFileSync(catalog, 'let members = b"invalid"')
  const invalid = invoke()
  assert.notStrictEqual(invalid.status, 0)
  assert.match(invalid.stdout + invalid.stderr, /canonical intrinsic catalog/)
  // Reuse the exact downloaded artifact as a corpus-only checkpoint. It must neither invoke
  // the formatter nor bootstrap nor require bootstrap configuration or repository dependencies.
  assert.strictEqual(existsSync(join(checkout, 'node_modules')), false)
  const sentinel = join(temporary, 'unexpected-lifecycle-call')
  writeFileSync(gate, `#!/bin/sh\nprintf 'formatter' >> '${sentinel}'\nexit 97\n`)
  writeFileSync(
    bootstrap,
    `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(sentinel)}, 'bootstrap'); process.exit(98);`,
  )
  const stdlib = join(checkout, 'packages/compiler/stdlib/silk/i32.silk')
  writeFileSync(stdlib, readFileSync(stdlib, 'utf8') + '\n// consumer corpus stdlib witness\n')
  const calls = join(temporary, 'compiler-calls')
  writeFileSync(
    compiler,
    `#!/bin/sh
if [ "$6" != '${checkout}/packages/compiler/stdlib' ]; then exit 8; fi
if ! grep -q 'consumer corpus stdlib witness' "$6/silk/i32.silk"; then exit 9; fi
printf '%s:%s\\n' "$8" "\${10}" >> '${calls}'
printf '#!/bin/sh\\nexit 42\\n' > program
chmod +x program
`,
  )
  const expectedCompiler = readFileSync(compiler)
  const expectedSources = sourceDigests(checkout)
  const corpusEnvironment = {
    ...process.env,
    SILKC: compiler,
    SILK_SELFHOST_CORPUS_CASES: '',
    NODE_PATH: '',
    NODE_OPTIONS: '',
  }
  delete corpusEnvironment.SILK_BOOTSTRAP
  delete corpusEnvironment.RUNNER_TEMP
  const invokeCorpus = (args = ['--mode', 'corpus'], environment = {}) =>
    spawnSync(process.execPath, [downloaded, ...args], {
      cwd: checkout,
      env: { ...corpusEnvironment, ...environment },
      encoding: 'utf8',
      timeout: 30_000,
    })
  writeFileSync(track, JSON.stringify(['trivial-features', 'scalar-reference-argument-order']))
  const corpus = invokeCorpus()
  assert.strictEqual(corpus.status, 0, corpus.stdout + corpus.stderr)
  assert.match(corpus.stdout, /PASS trivial-features/)
  assert.match(corpus.stdout, /PASS scalar-reference-argument-order/)
  assert.match(corpus.stdout, /pass=2 fail=0 unsupported=0 track=2/)
  assert.strictEqual(readFileSync(calls, 'utf8'), 'none:true\nspeed:false\nspeed:false\n')
  assert.deepStrictEqual(readFileSync(compiler), expectedCompiler)
  assert.deepStrictEqual(sourceDigests(checkout), expectedSources)
  assert.strictEqual(existsSync(sentinel), false)
  // A configured bootstrap executable must still remain untouched in corpus mode.
  assert.strictEqual(invokeCorpus(undefined, { SILK_BOOTSTRAP: bootstrap }).status, 0)
  assert.strictEqual(existsSync(sentinel), false)
  const callsBeforeRejections = readFileSync(calls, 'utf8')
  for (const pins of [
    [],
    ['trivial-features', 'trivial-features'],
    ['trivial-features', 'unknown'],
  ]) {
    writeFileSync(track, JSON.stringify(pins))
    assert.notStrictEqual(invokeCorpus().status, 0)
  }
  writeFileSync(track, JSON.stringify(['trivial-features']))
  for (const args of [['--mode', 'unknown'], ['corpus'], ['--mode', 'corpus', 'extra']]) {
    const rejected = invokeCorpus(args)
    assert.notStrictEqual(rejected.status, 0)
    assert.match(rejected.stdout + rejected.stderr, /Usage:/)
  }
  assert.notStrictEqual(
    invokeCorpus(undefined, { SILK_SELFHOST_CORPUS_CASES: 'trivial-features' }).status,
    0,
  )
  assert.strictEqual(readFileSync(calls, 'utf8'), callsBeforeRejections)
  assert.deepStrictEqual(readFileSync(compiler), expectedCompiler)
  assert.deepStrictEqual(sourceDigests(checkout), expectedSources)
  assert.strictEqual(existsSync(sentinel), false)
  process.stdout.write(
    'Standalone formatter and full-pin corpus modes passed without node_modules; live pins/stdlib and unchanged corpus inputs verified\n',
  )
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
