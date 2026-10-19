import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
const require = createRequire(new URL('../../package.json', import.meta.url))
/** @type {typeof import('@effect/platform-node')} */
const { NodeServices } = await import(pathToFileURL(require.resolve('@effect/platform-node')).href)
import * as ReleaseArchive from './ReleaseArchive.ts'

const directory = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), 'silk-release-'))),
  (root) => Effect.sync(() => rmSync(root, { recursive: true, force: true })),
)

it.effect('installs the compiler as bin/silk beside lib/silk/stdlib, reproducibly', () =>
  Effect.gen(function* () {
    const root = yield* directory
    const fs = yield* FileSystem.FileSystem
    yield* fs.makeDirectory(join(root, 'changes/src'), { recursive: true })
    yield* fs.writeFileString(join(root, 'changes/src/Command.silk'), 'compiled into silk\n')
    yield* fs.writeFileString(
      join(root, 'silk.toml'),
      '[workspace]\nmembers = ["compiler", "changes"]\n',
    )
    const deep =
      'silk/a-directory-name-long-enough/to-need-the-ustar-prefix-field/beyond-one-hundred-bytes'
    mkdirSync(join(root, 'stdlib', deep), { recursive: true })
    writeFileSync(join(root, 'stdlib/manifest.json'), '{}\n')
    writeFileSync(join(root, 'stdlib', deep, 'option.silk'), 'pub union Option {}\n')
    writeFileSync(join(root, 'compiler'), '#!/bin/sh\necho silk\n')
    mkdirSync(join(root, 'first'))
    mkdirSync(join(root, 'second'))
    const options = {
      compiler: join(root, 'compiler'),
      standardLibrary: join(root, 'stdlib'),
      target: 'x86_64-unknown-linux-gnu',
      version: '0.1.0',
    }
    const first = yield* ReleaseArchive.write({ ...options, outputDirectory: join(root, 'first') })
    const second = yield* ReleaseArchive.write({
      ...options,
      outputDirectory: join(root, 'second'),
    })
    assert.strictEqual(first, join(root, 'first/silk-0.1.0-x86_64-unknown-linux-gnu.tar.gz'))
    assert.deepStrictEqual(readFileSync(first), readFileSync(second))
    execFileSync('tar', ['-xzf', first, '-C', root])
    const top = join(root, 'silk-0.1.0-x86_64-unknown-linux-gnu')
    assert.deepStrictEqual((yield* fs.readDirectory(top)).sort(), ['bin', 'lib'])
    assert.deepStrictEqual(yield* fs.readDirectory(join(top, 'lib/silk')), ['stdlib'])
    assert.strictEqual(readFileSync(join(top, 'bin/silk'), 'utf8'), '#!/bin/sh\necho silk\n')
    assert.strictEqual(statSync(join(top, 'bin/silk')).mode & 0o777, 0o755)
    assert.strictEqual(statSync(join(top, 'lib/silk/stdlib/manifest.json')).mode & 0o777, 0o644)
    assert.strictEqual(
      readFileSync(join(top, 'lib/silk/stdlib', deep, 'option.silk'), 'utf8'),
      'pub union Option {}\n',
    )
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
)

it('names an archive by its version without build metadata', () => {
  assert.strictEqual(
    ReleaseArchive.name('0.1.0-dev.8624+5081812', 'aarch64-apple-darwin'),
    'silk-0.1.0-dev.8624-aarch64-apple-darwin',
  )
  assert.strictEqual(
    ReleaseArchive.name('0.1.0', 'x86_64-unknown-linux-gnu'),
    'silk-0.1.0-x86_64-unknown-linux-gnu',
  )
})

it('refuses a member path that fits no ustar prefix and name split', () => {
  const unsplittable = `${'a'.repeat(160)}/${'b'.repeat(101)}`
  assert.strictEqual(ReleaseArchive.tar([{ _tag: 'Directory', path: unsplittable }]), undefined)
})
