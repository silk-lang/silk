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
  statSync,
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
  const verifyingGate = '#!/bin/sh\nprintf "FORMAT_SAFETY checked=1\\n"\n'
  writeFileSync(gate, verifyingGate)
  chmodSync(gate, 0o755)
  const bootstrap = join(temporary, 'bootstrap.mjs')
  writeFileSync(
    bootstrap,
    `import assert from 'node:assert/strict'; assert.deepEqual(process.argv.slice(2), ['build', '--manifest-path', 'compiler/silk.toml', '--optimization', 'release-with-debug']); console.log('rebuilt committed checkout');`,
  )
  const compiler = join(temporary, 'silkc')
  writeFileSync(
    compiler,
    '#!/bin/sh\nprintf "#!/bin/sh\\nexit 42\\n" > program\nchmod +x program\n',
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
  assert.match(result.stdout, /rebuilt committed checkout/)
  assert.match(result.stdout, /PASS trivial-features/)
  assert.match(
    readFileSync(join(temporary, 'formatter-safety.log'), 'utf8'),
    /FORMAT_SAFETY checked=1/,
  )
  // The gate verifies only: a gate that rewrites a tracked source fails before the rebuild.
  writeFileSync(
    gate,
    '#!/bin/sh\nprintf "\\n// formatted witness\\n" >> packages/compiler/stdlib/silk/i32.silk\n',
  )
  const rewritten = invoke()
  assert.notStrictEqual(rewritten.status, 0)
  assert.match(rewritten.stdout + rewritten.stderr, /changed tracked sources/)
  execFileSync('git', ['checkout', '--', 'packages/compiler/stdlib/silk/i32.silk'], {
    cwd: checkout,
  })
  writeFileSync(gate, verifyingGate)
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
if grep -q 'import silk.json_reflect' "$2"; then
  printf '%s\\n' 'SILK_UNSUPPORTED_JSON={"gaps":[{"code":"smoke-gap","reason":"fake compiler gap"}]}' >&2
  exit 1
fi
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
      maxBuffer: 64 * 1024 * 1024,
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
  for (const args of [
    ['--mode', 'unknown'],
    ['corpus'],
    ['--mode', 'corpus', 'extra'],
    ['--mode', 'inventory', 'extra'],
  ]) {
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
  assert.notStrictEqual(invokeCorpus(['--mode', 'corpus-full'], { SILKC: '' }).status, 0)
  assert.strictEqual(readFileSync(calls, 'utf8'), callsBeforeRejections)
  assert.deepStrictEqual(readFileSync(compiler), expectedCompiler)
  assert.deepStrictEqual(sourceDigests(checkout), expectedSources)
  assert.strictEqual(existsSync(sentinel), false)
  // Synthetic producer authority exercises transport, not a real verified CI/run claim.
  // Analyze only this tiny source; no native compiler/process lifecycle runs in inventory mode.
  const inventoryCheckout = join(temporary, 'inventory-checkout')
  mkdirSync(inventoryCheckout)
  execFileSync('tar', ['-x', '-C', inventoryCheckout], {
    input: execFileSync('git', ['archive', 'HEAD', 'packages/compiler/stdlib'], {
      maxBuffer: 64 * 1024 * 1024,
    }),
  })
  mkdirSync(join(inventoryCheckout, 'compiler/src'), { recursive: true })
  writeFileSync(
    join(inventoryCheckout, 'compiler/silk.toml'),
    '[package]\nname = "silk-compiler"\nversion = "0.1.0"\nroot = "src/main.silk"\n[build.composition]\nentry = { kind = "none" }\nruntimes = []\ndefaults = []\nretention = [{ module = "main", declaration = "main" }]\nrequirements = []\n',
  )
  const mainSource = join(inventoryCheckout, 'compiler/src/main.silk')
  writeFileSync(
    mainSource,
    'fn helper(value: i32) -> i32 { return value + 1 }\nexport "C" fn main() -> i32 as "main" { return helper(0) }\n',
  )
  chmodSync(mainSource, 0o644)
  chmodSync(join(inventoryCheckout, 'compiler/silk.toml'), 0o644)
  const inventoryBootstrap = join(temporary, 'inventory-bootstrap.mjs')
  copyFileSync(downloaded, inventoryBootstrap)
  const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
  const inventoryFiles = (directory, relative = '') =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name)
      const name = relative === '' ? entry.name : `${relative}/${entry.name}`
      if (entry.isDirectory()) return inventoryFiles(path, name)
      return [
        {
          path: name,
          mode: (statSync(path).mode & 0o111) === 0 ? '100644' : '100755',
          sha256: hash(readFileSync(path)),
        },
      ]
    })
  const digestFiles = (files) =>
    hash(files.map(({ path, mode, sha256 }) => `${path}\0${mode}\0${sha256}\n`).join(''))
  const requestFile = join(temporary, 'inventory-request.json')
  const makeRequest = () => {
    const files = ['compiler', 'packages/compiler/stdlib']
      .flatMap((root) => inventoryFiles(join(inventoryCheckout, root), root))
      .sort((a, b) => {
        if (a.path < b.path) return -1
        if (a.path > b.path) return 1
        return 0
      })
    // git archive applies tar.umask rather than the exact recorded Git file mode.
    for (const file of files)
      chmodSync(join(inventoryCheckout, file.path), Number.parseInt(file.mode.slice(3), 8))
    const archive = join(inventoryCheckout, 'authored-inputs.tar')
    execFileSync('tar', [
      '-cf',
      archive,
      '-C',
      inventoryCheckout,
      'compiler',
      'packages/compiler/stdlib',
    ])
    const stdlibDigest = digestFiles(
      files.filter((file) => file.path.startsWith('packages/compiler/stdlib/')),
    )
    return {
      schemaVersion: 1,
      directory: inventoryCheckout,
      inputs: {
        schemaVersion: 1,
        sourceCommit: 'a'.repeat(40),
        roots: ['compiler', 'packages/compiler/stdlib'],
        files,
        normalizedDigest: digestFiles(files),
        compilerDigest: digestFiles(files.filter((file) => file.path.startsWith('compiler/'))),
        stdlibDigest,
        archive: 'authored-inputs.tar',
        archiveSha256: hash(readFileSync(archive)),
      },
      bootstrap: {
        commit: 'b'.repeat(40),
        runId: '123',
        file: inventoryBootstrap,
        sha256: hash(readFileSync(inventoryBootstrap)),
        stdlibDigest,
      },
      profile: {
        name: 'release-with-debug',
        target: process.arch === 'arm64' ? 'aarch64-unknown-linux-gnu' : 'x86_64-unknown-linux-gnu',
        optimization: 'speed',
        debug: true,
      },
    }
  }
  const invokeInventory = (request) => {
    writeFileSync(requestFile, JSON.stringify(request))
    return invokeCorpus(['--mode', 'inventory'], { SILK_INVENTORY_REQUEST: requestFile })
  }
  const request = makeRequest()
  const inventorySourcesBefore = sourceDigests(inventoryCheckout)
  const inventory = invokeInventory(request)
  const receipt = JSON.parse(inventory.stdout)
  assert.strictEqual(
    inventory.status,
    0,
    JSON.stringify({
      status: receipt.status,
      failure: receipt.failure,
      diagnostics: receipt.diagnostics,
      selectedStatus: receipt.selected?.status,
      missing: receipt.selected?.missingProvenance,
      ownership: receipt.selected?.unavailableOwnership,
      violations: receipt.selected?.violations,
      stderr: inventory.stderr,
    }),
  )
  assert.strictEqual(receipt.schemaVersion, 1)
  assert.strictEqual(receipt.status, 'Complete')
  assert.strictEqual(receipt.evidence, 'SELECTED_ANALYSIS_CLOSURE_ONLY')
  assert.deepStrictEqual(receipt.inputs, request.inputs)
  assert.deepStrictEqual(receipt.bootstrap, request.bootstrap)
  assert.strictEqual(
    receipt.selected.residualSiteScope,
    'PARENT_INSTANCE_ARTIFACT_AND_ORIGINAL_DECLARATION',
  )
  assert.strictEqual(receipt.selected.executionKeyScope, 'LOCAL_COMPLETE_KEY_RECORDS')
  assert.ok(receipt.selected.selectedAuthoredFunctions.some((fn) => fn.name.spelling === 'main'))
  assert.ok(receipt.selected.reachedExecutionEdges.length > 0)
  assert.strictEqual(receipt.compilation.requestedProfile.target, request.profile.target)
  assert.strictEqual(
    receipt.compilation.requestedProfile.optimization,
    request.profile.optimization,
  )
  assert.strictEqual(receipt.compilation.requestedProfile.debug, request.profile.debug)
  assert.strictEqual(receipt.compilation.requestedComposition.entry.kind, 'none')
  assert.deepStrictEqual(receipt.compilation.requestedComposition.retention, [
    { module: 'main', declaration: 'main' },
  ])
  assert.strictEqual(receipt.compilation.artifact, 'NativeExecutable')
  assert.strictEqual(receipt.compilation.stage, 'final')
  for (const edge of receipt.selected.reachedExecutionEdges) {
    assert.ok(receipt.selected.executionKeys[edge.owner])
    assert.ok(receipt.selected.executionKeys[edge.target])
  }
  assert.deepStrictEqual(sourceDigests(inventoryCheckout), inventorySourcesBefore)
  assert.deepStrictEqual(
    ['compiler', 'packages/compiler/stdlib']
      .flatMap((root) => inventoryFiles(join(inventoryCheckout, root), root))
      .sort((a, b) => a.path.localeCompare(b.path)),
    request.inputs.files.toSorted((a, b) => a.path.localeCompare(b.path)),
  )
  assert.strictEqual(existsSync(join(inventoryCheckout, 'node_modules')), false)
  const unavailable = invokeInventory({
    ...request,
    bootstrap: { ...request.bootstrap, sha256: '0'.repeat(64) },
  })
  assert.notStrictEqual(unavailable.status, 0)
  const unavailableReceipt = JSON.parse(unavailable.stdout)
  assert.strictEqual(unavailableReceipt.status, 'Incomplete')
  assert.strictEqual(unavailableReceipt.failure.stage, 'Verification')
  assert.strictEqual(unavailableReceipt.selected, undefined)
  assert.match(unavailable.stderr, /Incomplete/)
  writeFileSync(mainSource, 'export "C" fn main() -> i32 as "main" { return missing }\n')
  const incomplete = invokeInventory(makeRequest())
  assert.notStrictEqual(incomplete.status, 0)
  const incompleteReceipt = JSON.parse(incomplete.stdout)
  assert.strictEqual(incompleteReceipt.status, 'Incomplete')
  assert.strictEqual(incompleteReceipt.evidence, 'SELECTED_ANALYSIS_CLOSURE_ONLY')
  assert.ok(
    incompleteReceipt.failure !== undefined ||
      incompleteReceipt.diagnostics.some((diagnostic) => diagnostic.severity === 'error'),
  )
  // This is a separate unchanged default-startup request, never a fallback for the
  // explicit C-export fixture or a whole-compiler/native-generation readiness claim.
  writeFileSync(
    join(inventoryCheckout, 'compiler/silk.toml'),
    '[package]\nname = "silk-compiler"\nversion = "0.1.0"\nroot = "src/main.silk"\n',
  )
  writeFileSync(mainSource, 'pub fn main() -> i32 { return 0 }\n')
  const defaultRequest = makeRequest()
  const defaultSourceBefore = sourceDigests(inventoryCheckout)
  const defaultResult = invokeInventory(defaultRequest)
  const defaultReceipt = JSON.parse(defaultResult.stdout)
  assert.deepStrictEqual(defaultReceipt.inputs, defaultRequest.inputs)
  assert.deepStrictEqual(defaultReceipt.bootstrap, defaultRequest.bootstrap)
  assert.strictEqual(defaultReceipt.compilation.requestedProfile.target, request.profile.target)
  assert.strictEqual(
    defaultReceipt.compilation.requestedProfile.optimization,
    request.profile.optimization,
  )
  assert.strictEqual(defaultReceipt.compilation.requestedProfile.debug, request.profile.debug)
  if (defaultReceipt.status === 'Incomplete') {
    assert.notStrictEqual(defaultResult.status, 0)
    assert.ok(defaultReceipt.selected.missingProvenance.length > 0)
    assert.match(defaultResult.stderr, /Incomplete/)
  } else {
    // A corrected collector may legitimately complete this tiny request; historical
    // MissingAuthored receipts stay unchanged and this is still selected-analysis evidence.
    assert.strictEqual(defaultReceipt.status, 'Complete')
    assert.strictEqual(defaultResult.status, 0)
    assert.deepStrictEqual(defaultReceipt.selected.missingProvenance, [])
  }
  assert.deepStrictEqual(sourceDigests(inventoryCheckout), defaultSourceBefore)
  process.stdout.write(
    `Default startup selected inventory observed ${defaultReceipt.status}; strict/native readiness unclaimed\n`,
  )
  const malformed = invokeInventory({ ...request, schemaVersion: 2 })
  assert.notStrictEqual(malformed.status, 0)
  assert.strictEqual(malformed.stdout, '')
  writeFileSync(requestFile, '{broken')
  const malformedJson = invokeCorpus(['--mode', 'inventory'], {
    SILK_INVENTORY_REQUEST: requestFile,
  })
  assert.notStrictEqual(malformedJson.status, 0)
  assert.strictEqual(malformedJson.stdout, '')
  assert.notStrictEqual(
    invokeCorpus(['--mode', 'inventory'], { SILK_INVENTORY_REQUEST: '' }).status,
    0,
  )
  assert.deepStrictEqual(readFileSync(inventoryBootstrap), readFileSync(downloaded))
  assert.strictEqual(readFileSync(calls, 'utf8'), callsBeforeRejections)
  assert.strictEqual(existsSync(sentinel), false)
  process.stdout.write(
    'Standalone formatter, full-pin, complete readonly corpus and inventory modes passed without node_modules; manifest, live pins/stdlib and unchanged inputs verified\n',
  )
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
