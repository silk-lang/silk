import * as assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

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
  process.stdout.write(
    'Standalone verification passed without node_modules; consumer track/catalog and formatted stdlib verified\n',
  )
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
