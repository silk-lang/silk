import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as Config from 'effect/Config'
import * as Effect from 'effect/Effect'

const runtime = process.argv[2] ?? process.execPath
const native = process.argv.includes('--native')
const nativePath = Effect.runSync(Config.String('PATH').pipe(Config.withDefault('')))
const location = spawnSync(runtime, ['--print', 'process.execPath'], { encoding: 'utf8' })
assert.ifError(location.error)
assert.equal(location.status, 0, location.stderr)
const executable = location.stdout.trim()
// Copy only the published asset out of the workspace. A relative import, node_modules lookup,
// or stdlib filesystem dependency must fail here, even when it works in the build checkout.
const directory = await mkdtemp(join(tmpdir(), 'silk-bundle-'))
try {
  const bundle = join(directory, 'silk.mjs')
  await copyFile(new URL('../dist/silk.mjs', import.meta.url), bundle)
  const cli = (...args) => {
    const nativeCommand = args[0] === 'run' || args[0] === 'test'
    const result = spawnSync(executable, [bundle, ...args], {
      cwd: directory,
      encoding: 'utf8',
      timeout: 120_000,
      // Frontend and bitcode commands must also work without any external compiler on PATH.
      env: {
        ...process.env,
        PATH: nativeCommand ? nativePath : '',
        NODE_PATH: '',
        NODE_OPTIONS: '',
        NO_COLOR: '1',
      },
    })
    assert.ifError(result.error)
    assert.equal(
      result.status,
      0,
      `${runtime} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`,
    )
    return result.stdout
  }

  assert.match(cli('--help'), /Silk bootstrap compiler/)
  cli('init', 'hello')
  const project = join(directory, 'hello')
  const manifest = join(project, 'silk.toml')
  const original = await readFile(manifest, 'utf8')
  const entry = join(project, 'src/main.silk')
  await writeFile(
    entry,
    `import Greeting { message }\n${(await readFile(entry, 'utf8')).replace('"Hello, world!"', 'message()')}`,
  )
  await writeFile(
    join(project, 'src/Greeting.silk'),
    'pub static fn message() -> string<\'static> { return "Hello, world!" }\n',
  )
  cli('check', '--manifest-path', manifest)
  // Documentation is target-neutral; select a source without the host logger's target selection.
  await writeFile(
    join(project, 'src/Documentation.silk'),
    'import silk.result { Result }\npub fn answer() -> i32 { return 42 }\n',
  )
  await writeFile(manifest, original.replace('src/main.silk', 'src/Documentation.silk'))
  cli('doc', '--manifest-path', manifest, '--output', 'documentation.json')
  JSON.parse(await readFile(join(project, 'documentation.json'), 'utf8'))
  await writeFile(manifest, `${original}\n[build]\nstage = "llvm-bitcode"\n`)
  cli('build', '--manifest-path', manifest)
  const artifacts = await readdir(join(project, 'build'), { recursive: true })
  const bitcode = artifacts.find((path) => path.endsWith('hello.bc'))
  assert.ok(bitcode, 'The standalone compiler must emit LLVM bitcode')
  assert.deepEqual(
    (await readFile(join(project, 'build', bitcode))).subarray(0, 4),
    Buffer.from([0x42, 0x43, 0xc0, 0xde]),
  )
  if (native) {
    await writeFile(manifest, original)
    assert.match(cli('run', '--manifest-path', manifest), /Hello, world!/)
    await writeFile(join(project, 'src/BundleCases.silk'), 'test fn bundleWitness() -> () {}\n')
    assert.match(
      cli('test', '--manifest-path', manifest, '--root', 'src/BundleCases.silk', '--no-cache'),
      /bundleWitness/,
    )
  }
  process.stdout.write(
    `Standalone bundle passed with ${runtime}${native ? ' (including native execution)' : ''}\n`,
  )
} finally {
  await rm(directory, { recursive: true, force: true })
}
