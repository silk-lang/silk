import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { chmod, copyFile, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { test } from 'node:test'
import * as Config from 'effect/Config'
import * as Effect from 'effect/Effect'

// Mirrors the workspace layout the generator reads: compiler sources and the sibling built
// `@silklang/llvm` JavaScript.
const fixture = async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'silk-toolchain-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const root = join(workspace, 'compiler')
  await mkdir(join(root, 'src'), { recursive: true })
  await mkdir(join(root, 'scripts'))
  await mkdir(join(workspace, 'llvm', 'dist'), { recursive: true })
  for (const script of ['generate-toolchain-integrity.mjs', 'watch-toolchain.mjs'])
    await copyFile(
      new URL(`../packages/compiler/scripts/${script}`, import.meta.url),
      join(root, 'scripts', script),
    )
  const source = join(root, 'src', 'Compiler.ts')
  await writeFile(source, 'export const version = 1\n')
  const encoder = join(workspace, 'llvm', 'dist', 'Encoder.js')
  await writeFile(encoder, 'export const version = 1\n')
  const output = join(root, 'src', 'ToolchainIntegrity.generated.ts')
  const generate = (...args) =>
    execFileSync(
      process.execPath,
      [join(root, 'scripts/generate-toolchain-integrity.mjs'), ...args],
      { stdio: 'pipe' },
    )
  return { root, source, encoder, output, generate }
}

void test('identity bootstraps, stays untouched when current, and detects distribution changes', async (t) => {
  const { source, encoder, output, generate } = await fixture(t)
  generate()
  const metadata = await stat(output)
  generate()
  assert.equal((await stat(output)).mtimeMs, metadata.mtimeMs)
  generate('--check')
  const identities = [await readFile(output, 'utf8')]
  for (const file of [source, encoder]) {
    await writeFile(file, 'export const version = 2\n')
    assert.throws(() => generate('--check'), /Generated toolchain identity is stale/)
    generate()
    identities.push(await readFile(output, 'utf8'))
    generate('--check')
  }
  assert.equal(new Set(identities).size, identities.length)
})

void test('development watcher refreshes identity and terminates with its compiler', async (t) => {
  const { root, source, encoder, output, generate } = await fixture(t)
  await mkdir(join(root, 'bin'))
  const executable = join(root, 'bin', 'tsc')
  await writeFile(
    executable,
    `#!${process.execPath}\nconsole.log('ready'); setInterval(() => {}, 1000)\n`,
  )
  await chmod(executable, 0o755)
  const child = spawn(process.execPath, [join(root, 'scripts/watch-toolchain.mjs')], {
    env: { PATH: `${join(root, 'bin')}:${Effect.runSync(Config.String('PATH'))}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(() => child.kill('SIGTERM'))
  let diagnostics = ''
  child.stderr.setEncoding('utf8').on('data', (text) => (diagnostics += text))
  const eventually = async (condition) => {
    for (let attempt = 0; attempt < 100 && !(await condition()); attempt++) await setTimeout(50)
    assert.ok(await condition())
  }
  const refreshes = async (edit) => {
    const original = await readFile(output, 'utf8')
    await edit()
    await eventually(async () => (await readFile(output, 'utf8')) !== original)
    generate('--check')
  }
  await once(child.stdout, 'data')
  await refreshes(() => writeFile(source, 'export const version = 2\n'))
  await refreshes(() => writeFile(encoder, 'export const version = 2\n'))
  // An llvm build cleans `dist` before re-emitting it: the failed refresh is reported, the session
  // survives, and the recreated directory is watched again.
  await refreshes(async () => {
    await rm(dirname(encoder), { recursive: true })
    await eventually(() => diagnostics.includes('Toolchain identity not refreshed'))
    await mkdir(dirname(encoder))
    await writeFile(encoder, 'export const version = 3\n')
  })
  assert.equal(child.exitCode, null)
  const exited = once(child, 'exit')
  child.kill('SIGTERM')
  assert.deepEqual(await exited, [null, 'SIGTERM'])
})
