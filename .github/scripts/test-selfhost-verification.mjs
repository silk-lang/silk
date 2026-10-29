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

// Hash every consumer Silk source, including fixture imports and the live stdlib.
const sourceDigests = (directory) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sourceDigests(path)
    if (!entry.name.endsWith('.silk')) return []
    return [[path, createHash('sha256').update(readFileSync(path)).digest('hex')]]
  })

const bundle = resolve('.scratch/selfhost-verification.mjs')
// The canonical runtime members the harness checks the catalog against: every operation of the
// checked intrinsic inventory that is not static-only.
const runtimeIntrinsicNames = JSON.parse(
  readFileSync('compiler/fixtures/intrinsic-inventory.json', 'utf8'),
)
  .entries.filter((entry) => entry.phase !== 'StaticOnly')
  .map((entry) => entry.operation.slice('Intrinsic.'.length))
  .sort()
const temporary = mkdtempSync(join(tmpdir(), 'silk-verification-smoke-'))
try {
  const checkout = join(temporary, 'checkout')
  mkdirSync(checkout)
  const archive = execFileSync(
    'git',
    [
      'archive',
      'HEAD',
      'corpus',
      'stdlib',
      'examples',
      'compiler/fixtures/intrinsic-inventory.json',
    ],
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
    'build/llvm/x86_64-unknown-linux-gnu/release-with-debug/silk-format-gate',
  )
  mkdirSync(join(gate, '..'), { recursive: true })
  const verifyingGate = '#!/bin/sh\nprintf "FORMAT_SAFETY checked=1\\n"\n'
  writeFileSync(gate, verifyingGate)
  chmodSync(gate, 0o755)
  const bootstrap = join(temporary, 'bootstrap.mjs')
  const compiler = join(temporary, 'silkc')
  const downloaded = join(temporary, 'verification.mjs')
  copyFileSync(bundle, downloaded)
  // Formatter mode verifies the checkout only: it receives no compiler, bootstrap or corpus input.
  const invoke = (environment = { SILK_FORMAT_GATE: gate }) =>
    spawnSync(process.execPath, [downloaded], {
      cwd: checkout,
      env: {
        ...process.env,
        SILK_COMPILER: '',
        SILK_BOOTSTRAP: '',
        RUNNER_TEMP: temporary,
        NODE_PATH: '',
        NODE_OPTIONS: '',
        ...environment,
      },
      encoding: 'utf8',
      timeout: 30_000,
    })
  const result = invoke()
  assert.strictEqual(result.status, 0, result.stderr)
  assert.doesNotMatch(result.stdout, /PASS |SELFHOST_CASE_TIMING=/)
  assert.match(
    readFileSync(join(temporary, 'formatter-safety.log'), 'utf8'),
    /FORMAT_SAFETY checked=1/,
  )
  assert.notStrictEqual(invoke({}).status, 0)
  // The gate verifies only: a gate that rewrites a tracked source fails.
  writeFileSync(gate, '#!/bin/sh\nprintf "\\n// formatted witness\\n" >> stdlib/silk/num/i32.silk\n')
  const rewritten = invoke()
  assert.notStrictEqual(rewritten.status, 0)
  assert.match(rewritten.stdout + rewritten.stderr, /changed tracked sources/)
  execFileSync('git', ['checkout', '--', 'stdlib/silk/num/i32.silk'], {
    cwd: checkout,
  })
  writeFileSync(gate, verifyingGate)
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
  const stdlib = join(checkout, 'stdlib/silk/num/i32.silk')
  writeFileSync(stdlib, readFileSync(stdlib, 'utf8') + '\n// consumer corpus stdlib witness\n')
  const calls = join(temporary, 'compiler-calls')
  writeFileSync(
    compiler,
    `#!/bin/sh
if [ "$6" != '${checkout}/stdlib' ]; then exit 8; fi
if ! grep -q 'consumer corpus stdlib witness' "$6/silk/num/i32.silk"; then exit 9; fi
printf '%s:%s\\n' "$8" "\${10}" >> '${calls}'
if grep -q 'import silk.json.reflect' "$2"; then
  printf '%s\\n' 'SILK_UNSUPPORTED_JSON={"gaps":[{"code":"smoke-gap","reason":"fake compiler gap"}]}' >&2
  exit 1
fi
printf '#!/bin/sh\\nexit 42\\n' > program
chmod +x program
`,
  )
  chmodSync(compiler, 0o755)
  const expectedCompiler = readFileSync(compiler)
  const expectedSources = sourceDigests(checkout)
  const corpusEnvironment = {
    ...process.env,
    SILK_COMPILER: compiler,
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
      maxBuffer: 64 * 1024 * 1024,
    })
  writeFileSync(track, JSON.stringify(['trivial-features', 'scalar-reference-argument-order']))
  const corpus = invokeCorpus()
  assert.strictEqual(corpus.status, 0, corpus.stdout + corpus.stderr)
  assert.match(corpus.stdout, /PASS trivial-features/)
  assert.match(corpus.stdout, /PASS scalar-reference-argument-order/)
  assert.match(corpus.stdout, /pass=2 fail=0 unsupported=0 track=2/)
  // The two cases build concurrently, so their profile calls may interleave.
  assert.deepStrictEqual(readFileSync(calls, 'utf8').trimEnd().split('\n').sort(), [
    'none:true',
    'speed:false',
    'speed:false',
  ])
  assert.deepStrictEqual(readFileSync(compiler), expectedCompiler)
  assert.deepStrictEqual(sourceDigests(checkout), expectedSources)
  assert.strictEqual(existsSync(sentinel), false)
  // A configured bootstrap executable must still remain untouched in corpus mode.
  assert.strictEqual(invokeCorpus(undefined, { SILK_BOOTSTRAP: bootstrap }).status, 0)
  assert.strictEqual(existsSync(sentinel), false)
  // Full mode uses the same immutable artifact but executes every regular case. The fake
  // compiler intentionally produces unpinned mismatches and an explicit gap; those remain
  // observations here, independently of which fixture inputs the harness supports.
  const full = invokeCorpus(['--mode', 'corpus-full'], { SILK_BOOTSTRAP: bootstrap })
  assert.strictEqual(full.status, 0, full.stdout + full.stderr)
  const prefix = 'SELFHOST_CORPUS_MANIFEST='
  assert.ok(full.stdout.startsWith(prefix))
  const lines = full.stdout.trimEnd().split('\n')
  const manifestRecords = lines.filter((line) => line.startsWith(prefix))
  assert.strictEqual(manifestRecords.length, 1)
  const manifest = JSON.parse(manifestRecords[0].slice(prefix.length))
  assert.strictEqual(manifest.schemaVersion, 1)
  assert.strictEqual(manifest.mode, 'corpus-full')
  assert.deepStrictEqual(manifest.required, ['trivial-features', 'scalar-reference-argument-order'])
  const names = manifest.programs.map((program) => program.name)
  assert.strictEqual(new Set(names).size, names.length)
  assert.ok(names.length > manifest.required.length)
  assert.deepStrictEqual(
    lines
      .filter((line) => /^(PASS|FAIL|UNSUPPORTED) /.test(line))
      .map((line) => line.split(' ')[1].split(':')[0]),
    names,
  )
  assert.deepStrictEqual(
    lines
      .filter((line) => line.startsWith('SELFHOST_CASE_TIMING='))
      .map((line) => JSON.parse(line.slice('SELFHOST_CASE_TIMING='.length)).name),
    names,
  )
  assert.match(full.stdout, /^PASS scalar-reference-read$/m)
  assert.deepStrictEqual(
    manifest.programs.find((program) => program.name === 'scalar-reference-read').profiles,
    [{ name: 'optimized', optimization: 'speed', debug: false }],
  )
  assert.strictEqual(
    Object.hasOwn(
      manifest.programs.find((program) => program.name === 'scalar-reference-read'),
      'stdout',
    ),
    false,
  )
  assert.strictEqual(
    Object.hasOwn(
      manifest.programs.find((program) => program.name === 'scalar-reference-read'),
      'stderr',
    ),
    false,
  )
  assert.deepStrictEqual(
    manifest.programs.find((program) => program.name === 'scalar-reference-argument-order')
      .profiles,
    [
      { name: 'debug', optimization: 'none', debug: true },
      { name: 'optimized', optimization: 'speed', debug: false },
    ],
  )
  assert.deepStrictEqual(
    manifest.programs.find((program) => program.name === 'divide-by-zero-trap').expected,
    { _tag: 'Trap' },
  )
  assert.match(full.stdout, /^FAIL /m)
  assert.match(full.stdout, /^UNSUPPORTED json-reflect: smoke-gap: fake compiler gap$/m)
  assert.deepStrictEqual(readFileSync(downloaded), readFileSync(bundle))
  assert.deepStrictEqual(readFileSync(compiler), expectedCompiler)
  assert.deepStrictEqual(sourceDigests(checkout), expectedSources)
  assert.strictEqual(existsSync(sentinel), false)
  const callsBeforeRejections = readFileSync(calls, 'utf8')
  for (const pins of [
    [],
    ['trivial-features', 'trivial-features'],
    ['trivial-features', 'unknown'],
  ]) {
    writeFileSync(track, JSON.stringify(pins))
    for (const mode of ['corpus', 'corpus-full'])
      assert.notStrictEqual(invokeCorpus(['--mode', mode]).status, 0)
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
  assert.notStrictEqual(
    invokeCorpus(['--mode', 'corpus-full'], { SILK_SELFHOST_CORPUS_CASES: 'trivial-features' })
      .status,
    0,
  )
  assert.notStrictEqual(invokeCorpus(['--mode', 'corpus-full'], { SILK_COMPILER: '' }).status, 0)
  assert.strictEqual(readFileSync(calls, 'utf8'), callsBeforeRejections)
  assert.deepStrictEqual(readFileSync(compiler), expectedCompiler)
  assert.deepStrictEqual(sourceDigests(checkout), expectedSources)
  assert.strictEqual(existsSync(sentinel), false)
  process.stdout.write(
    'Standalone formatter, full-pin, and complete readonly corpus modes passed without node_modules; manifest, live pins/stdlib and unchanged inputs verified\n',
  )
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
