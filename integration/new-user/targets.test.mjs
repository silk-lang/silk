// The Targets and profiles page: --target, cross-compiling to an object, optimization and named
// profiles, the fields a profile takes, and the values and combinations it refuses.
import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { existsSync, initPackage, join, read, sharedHome, show, silk, write } from './lib.mjs'

const h = sharedHome()
let serial = 0
const host = 'x86_64-unknown-linux-gnu'

// A fresh package whose silk.toml gets `extra` appended.
function tiny(extra = '') {
  const dir = initPackage(h, `tiny-${++serial}`)
  if (extra !== '') write(join(dir, 'silk.toml'), `${read(join(dir, 'silk.toml'))}\n${extra}`)
  return dir
}

const lineOf = (text, needle) => text.slice(0, text.indexOf(needle)).split('\n').length

test('an unknown target is refused with exit 2', () => {
  const result = silk(h, ['build', '--target', 'riscv64'], { cwd: tiny() })
  assert.equal(result.status, 2, show(result))
  assert.match(result.stderr, /Unsupported target riscv64/)
})

test('an executable for another Linux target is refused, an object builds', () => {
  const dir = tiny()
  const refused = silk(h, ['build', '--target', 'aarch64-unknown-linux-gnu'], { cwd: dir })
  assert.notEqual(refused.status, 0, show(refused))
  assert.match(refused.stderr, new RegExp(`Cannot link an executable for target aarch64-unknown-linux-gnu on host ${host}`))
  write(join(dir, 'silk.toml'), `${read(join(dir, 'silk.toml'))}\n[build]\nstage = "object"\n`)
  const built = silk(h, ['build', '--target', 'aarch64-unknown-linux-gnu'], { cwd: dir })
  assert.equal(built.status, 0, show(built))
  const object = join(dir, `build/llvm/aarch64-unknown-linux-gnu/debug/${dir.split('/').at(-1)}.o`)
  assert.ok(existsSync(object), show(built))
  const kind = spawnSync('file', [object], { encoding: 'utf8' }).stdout
  assert.match(kind, /ELF 64-bit LSB relocatable, ARM aarch64/)
})

// The program `silk init` writes logs through silk/os_logger, which wasm32 lacks, so use a bare main.
test('check takes --target more than once and runs once per target', () => {
  const dir = tiny()
  write(join(dir, 'src/main.silk'), 'pub fn main() -> i32 {\n  return 0\n}\n')
  const targets = ['aarch64-apple-darwin', 'aarch64-unknown-linux-gnu', 'wasm32-unknown-unknown']
  const result = silk(h, ['check', ...targets.flatMap((t) => ['--target', t])], { cwd: dir })
  assert.equal(result.status, 0, show(result))
  for (const t of targets) assert.match(result.stderr, new RegExp(`Checking tiny-\\d+ \\(${t}\\)`))
  assert.equal(result.stderr.match(/^Finished tiny-\d+ in /gm)?.length, 3, show(result))
})

test('release and named profiles build into their own directories', () => {
  const dir = tiny(`[profiles.fast]\ntarget = "${host}"\noptimization = "speed"\ndebug = false\n`)
  const name = dir.split('/').at(-1)
  const release = silk(h, ['build', '--release'], { cwd: dir })
  assert.equal(release.status, 0, show(release))
  assert.match(release.stderr, new RegExp(`Compiling ${name} \\(${host}, release\\)`))
  assert.ok(existsSync(join(dir, `build/llvm/${host}/release/${name}`)))
  const fast = silk(h, ['build', '--profile', 'fast'], { cwd: dir })
  assert.equal(fast.status, 0, show(fast))
  assert.match(fast.stderr, new RegExp(`Compiling ${name} \\(${host}, fast\\)`))
  assert.ok(existsSync(join(dir, `build/llvm/${host}/fast/${name}`)))
  const run = spawnSync(join(dir, `build/llvm/${host}/fast/${name}`), { encoding: 'utf8' })
  assert.equal(run.status, 0)
})

test('[build].profile makes a named profile the default', () => {
  const dir = tiny(`[build]\nprofile = "fast"\n\n[profiles.fast]\ntarget = "${host}"\n`)
  const result = silk(h, ['build'], { cwd: dir })
  assert.equal(result.status, 0, show(result))
  assert.match(result.stderr, /, fast\)/)
})

test('a named profile cannot be combined with --release or --target', () => {
  const dir = tiny(`[profiles.fast]\ntarget = "${host}"\n`)
  for (const flags of [['--release'], ['--target', host], ['--optimization', 'release']]) {
    const result = silk(h, ['build', '--profile', 'fast', ...flags], { cwd: dir })
    assert.equal(result.status, 2, show(result))
    assert.match(result.stderr, /Named\/full profiles conflict with target and optimization flags/)
  }
})

test('a profile with cpu features makes Target.hasCpuFeature true', () => {
  const dir = tiny(`[profiles.fast]\ntarget = "${host}"\n\n[profiles.fast.cpu]\nfeatures = ["avx2"]\n`)
  write(join(dir, 'src/main.silk'), 'import silk.target { Target }\n\npub fn main() -> i32 {\n  static if Target.hasCpuFeature("avx2") && Target.hasCpuFeature("sse4.2") {\n    return 7\n  }\n  return 3\n}\n')
  const plain = silk(h, ['run'], { cwd: dir })
  assert.equal(plain.status, 3, show(plain))
  const fast = silk(h, ['run', '--profile', 'fast'], { cwd: dir })
  assert.equal(fast.status, 7, `avx2 implies sse4.2\n${show(fast)}`)
})

test('link = "static" gives a static executable', () => {
  const dir = tiny(`[profiles.fast]\ntarget = "${host}"\nlink = "static"\n`)
  const result = silk(h, ['build', '--profile', 'fast'], { cwd: dir })
  assert.equal(result.status, 0, show(result))
  const binary = join(dir, `build/llvm/${host}/fast/${dir.split('/').at(-1)}`)
  assert.match(spawnSync('file', [binary], { encoding: 'utf8' }).stdout, /statically linked/)
  assert.equal(spawnSync(binary).status, 0)
})

// Each row of the page's tables: a profile body, the field the error points at, and the message.
const refusals = [
  ['sanitizers = ["address"]', 'sanitizers', 'profiles.fast.sanitizers is not supported by the native compiler yet'],
  ['unwind = "native"', 'unwind', 'profiles.fast.unwind = "native" is not supported by the native compiler yet'],
  ['safety = "unchecked"', 'safety', 'profiles.fast.safety = "unchecked" is not supported by the native compiler yet'],
  ['threading = "multi"', 'threading', 'profiles.fast.threading = "multi" is not supported by the native compiler yet'],
  ['entry = { kind = "none" }', 'entry', 'profiles.fast.entry is not supported by the native compiler yet'],
  ['libc = "system"', 'libc', 'UnsupportedCombination: profiles.fast.libc = "system"'],
  ['deployment = "14.0"', 'deployment', 'UnsupportedCombination: profiles.fast.deployment = "14.0"'],
  ['max-memory = "256MiB"', 'max-memory', 'UnsupportedCombination: profiles.fast.max-memory = "256MiB"'],
  ['cpu = { model = "znver3" }', 'cpu', 'UnsupportedCombination: profiles.fast.cpu.model = "znver3"'],
  ['cpu = { features = ["neon"] }', 'cpu', 'UnsupportedCombination: profiles.fast.cpu.features'],
]

for (const [body, field, message] of refusals) {
  test(`a profile with ${body} is refused at its line`, () => {
    const dir = tiny(`[profiles.fast]\ntarget = "${host}"\n${body}\n`)
    const manifest = read(join(dir, 'silk.toml'))
    const result = silk(h, ['build', '--profile', 'fast'], { cwd: dir })
    assert.equal(result.status, 2, show(result))
    const line = lineOf(manifest, `\n${field} `) + 1
    assert.ok(result.stderr.includes(`silk.toml:${line}: ${message}`), `line ${line}: ${message}\n${show(result)}`)
  })
}

// The page names [build].artifact; since the manifest redesign the message names [package].kind.
test('a profile artifact that differs from the package is refused at its line', () => {
  const dir = tiny(`[profiles.fast]\ntarget = "${host}"\nartifact = "object"\n`)
  const manifest = read(join(dir, 'silk.toml'))
  const result = silk(h, ['build', '--profile', 'fast'], { cwd: dir })
  assert.equal(result.status, 2, show(result))
  assert.ok(result.stderr.includes(`silk.toml:${lineOf(manifest, '\nartifact ') + 1}: UnsupportedCombination: profiles.fast.artifact = "object" differs from `), show(result))
  assert.match(result.stderr, /differs from \[(build\]\.artifact|package\]\.kind) = "executable"/)
})

test('a profile with target = "host" is refused', () => {
  const dir = tiny('[profiles.fast]\ntarget = "host"\n')
  const result = silk(h, ['build', '--profile', 'fast'], { cwd: dir })
  assert.equal(result.status, 2, show(result))
  assert.match(result.stderr, /UnsupportedCombination: profiles\.fast\.target = "host"/)
})

test('a thread sanitizer without threading points at the profile header', () => {
  const dir = tiny(`[profiles.fast]\ntarget = "${host}"\nsanitizers = ["thread"]\n`)
  const manifest = read(join(dir, 'silk.toml'))
  const result = silk(h, ['build', '--profile', 'fast'], { cwd: dir })
  assert.equal(result.status, 2, show(result))
  assert.ok(result.stderr.includes(`silk.toml:${lineOf(manifest, '[profiles.fast]')}: UnsupportedCombination: profiles.fast.threading`), show(result))
})

test('--profile-input names the flag in its errors', () => {
  const dir = tiny()
  for (const [input, message] of [
    [`{"target":"${host}","safety":"unchecked"}`, 'Invalid --profile-input: --profile-input.safety = "unchecked" is not supported by the native compiler yet'],
    [`{"target":"${host}","libc":"system"}`, 'Invalid --profile-input: UnsupportedCombination: --profile-input.libc = "system"'],
    ['{"target":', 'Invalid --profile-input JSON'],
  ]) {
    const result = silk(h, ['build', '--profile-input', input], { cwd: dir })
    assert.equal(result.status, 2, show(result))
    assert.ok(result.stderr.includes(message), `${message}\n${show(result)}`)
  }
})

test('--profile-input builds into the directory of its optimization', () => {
  const dir = tiny()
  const result = silk(h, ['build', '--profile-input', `{"target":"${host}","optimization":"speed","debug":false}`], { cwd: dir })
  assert.equal(result.status, 0, show(result))
  assert.ok(existsSync(join(dir, `build/llvm/${host}/release/${dir.split('/').at(-1)}`)), show(result))
})

test('a wasm32 build runs the program under node', () => {
  const dir = tiny()
  write(join(dir, 'src/main.silk'), 'import silk.target { Target, Arch }\n\npub fn main() -> i32 {\n  static if Target.arch() == Arch.Wasm32 {\n    return 4\n  }\n  return 8\n}\n')
  const result = silk(h, ['build', '--target', 'wasm32-unknown-unknown'], { cwd: dir })
  assert.equal(result.status, 0, show(result))
  const wasm = join(dir, `build/llvm/wasm32-unknown-unknown/debug/${dir.split('/').at(-1)}`)
  assert.ok(existsSync(wasm), show(result))
  const run = spawnSync('node', ['-e', `WebAssembly.instantiate(require('fs').readFileSync(${JSON.stringify(wasm)})).then(({instance}) => process.exit(instance.exports.main()))`])
  assert.equal(run.status, 4, String(run.stderr))
})

// #2298: a debug build that changes nothing writes nothing, for every target.
for (const target of [host, 'wasm32-unknown-unknown', 'wasm32-wasip1']) {
  test(`a no-op build for ${target} writes nothing under build/`, { todo: 'finding 129' }, () => {
    const dir = tiny()
    write(join(dir, 'src/main.silk'), 'pub fn main() -> i32 {\n  return 0\n}\n')
    for (let i = 0; i < 2; i++) assert.equal(silk(h, ['build', '--target', target], { cwd: dir }).status, 0)
    const stamp = Date.now()
    spawnSync('sleep', ['1.1'])
    const result = silk(h, ['build', '--target', target], { cwd: dir })
    assert.equal(result.status, 0, show(result))
    const written = spawnSync('find', [join(dir, 'build'), '-type', 'f', '-newermt', `@${stamp / 1000}`], { encoding: 'utf8' }).stdout.trim()
    assert.equal(written, '', `written by a no-op build:\n${written}\n${show(result)}`)
  })
}
