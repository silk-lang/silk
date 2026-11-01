import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { assert, it } from './EffectTest.mjs'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Result from 'effect/Result'
import * as NativeProcess from './NativeProcess.ts'
const require = createRequire(new URL('../../package.json', import.meta.url))
/** @type {typeof import('@effect/platform-node')} */
const { NodeServices } = await import(pathToFileURL(require.resolve('@effect/platform-node')).href)
import * as ReleaseArchive from './ReleaseArchive.ts'

const directory = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), 'silk-release-'))),
  (root) => Effect.sync(() => rmSync(root, { recursive: true, force: true })),
)

it.effect('installs the compiler as bin/silkc and the silk tool as bin/silk beside lib/silk/stdlib, reproducibly', () =>
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
    writeFileSync(join(root, 'compiler'), '#!/bin/sh\necho silkc\n')
    writeFileSync(join(root, 'tool'), '#!/bin/sh\necho silk\n')
    mkdirSync(join(root, 'first'))
    mkdirSync(join(root, 'second'))
    const options = {
      compiler: join(root, 'compiler'),
      tool: join(root, 'tool'),
      standardLibrary: join(root, 'stdlib'),
      target: 'x86_64-unknown-linux-gnu',
      version: '1.2.3-rc.2+release.build',
    }
    const first = yield* ReleaseArchive.write({ ...options, outputDirectory: join(root, 'first') })
    const second = yield* ReleaseArchive.write({
      ...options,
      outputDirectory: join(root, 'second'),
    })
    assert.strictEqual(
      first,
      join(root, 'first/silk-1.2.3-rc.2+release.build-x86_64-unknown-linux-gnu.tar.gz'),
    )
    assert.deepStrictEqual(readFileSync(first), readFileSync(second))
    execFileSync('tar', ['-xzf', first, '-C', root])
    const top = join(root, 'silk-1.2.3-rc.2+release.build-x86_64-unknown-linux-gnu')
    assert.deepStrictEqual((yield* fs.readDirectory(top)).sort(), ['bin', 'lib'])
    assert.deepStrictEqual(yield* fs.readDirectory(join(top, 'lib/silk')), ['stdlib'])
    assert.strictEqual(readFileSync(join(top, 'bin/silkc'), 'utf8'), '#!/bin/sh\necho silkc\n')
    assert.strictEqual(statSync(join(top, 'bin/silkc')).mode & 0o777, 0o755)
    assert.deepStrictEqual((yield* fs.readDirectory(join(top, 'bin'))).sort(), ['silk', 'silkc'])
    assert.strictEqual(readFileSync(join(top, 'bin/silk'), 'utf8'), '#!/bin/sh\necho silk\n')
    assert.strictEqual(statSync(join(top, 'bin/silk')).mode & 0o777, 0o755)
    assert.strictEqual(statSync(join(top, 'lib/silk/stdlib/manifest.json')).mode & 0o777, 0o644)
    assert.strictEqual(
      readFileSync(join(top, 'lib/silk/stdlib', deep, 'option.silk'), 'utf8'),
      'pub union Option {}\n',
    )
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
)

it('names an archive by its exact version including build metadata', () => {
  assert.strictEqual(
    ReleaseArchive.name('0.1.0-dev.8624+5081812', 'aarch64-apple-darwin'),
    'silk-0.1.0-dev.8624+5081812-aarch64-apple-darwin',
  )
  assert.strictEqual(
    ReleaseArchive.name('0.1.0', 'x86_64-unknown-linux-gnu'),
    'silk-0.1.0-x86_64-unknown-linux-gnu',
  )
})

it.effect('rejects malformed versions before reading inputs or writing archive paths', () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const root = yield* fs.makeTempDirectoryScoped({ prefix: 'silk-archive-version-' })
    for (const version of [
      '',
      'v1.2.3',
      '01.2.3',
      '1.02.3',
      '1.2.03',
      '1.2.3-01',
      '1.2.3-beta.01',
      '1.2',
      '1.2.3-',
      '1.2.3+',
      '1.2.3-beta..1',
      '1.2.3+build..1',
      '1.2.3+build+other',
      '../../escape',
      '1.2.3/../../escape',
      '1.2.3\\escape',
      '1.2.3\n',
    ]) {
      const result = yield* Effect.result(
        ReleaseArchive.write({
          compiler: join(root, 'missing-compiler'),
          tool: join(root, 'missing-tool'),
          standardLibrary: join(root, 'missing-stdlib'),
          target: 'aarch64-apple-darwin',
          version,
          outputDirectory: root,
        }),
      )
      assert.isTrue(Result.isFailure(result), version)
      if (Result.isFailure(result)) assert.strictEqual(result.failure._tag, 'ReleaseArchiveError')
    }
    assert.deepEqual(yield* fs.readDirectory(root), [])
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
)

it.effect('requires an explicit CLI version and preserves foreign compiler bytes', () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const root = yield* fs.makeTempDirectoryScoped({ prefix: 'silk-archive-cli-' })
    const compiler = join(root, 'foreign-compiler')
    const tool = join(root, 'foreign-tool')
    const standardLibrary = join(root, 'stdlib')
    const output = join(root, 'output')
    yield* fs.writeFileString(compiler, 'foreign executable bytes, not a host program')
    yield* fs.writeFileString(tool, 'foreign tool bytes')
    yield* fs.makeDirectory(standardLibrary)
    yield* fs.writeFileString(join(standardLibrary, 'i32.silk'), 'pub let ZERO = 0\n')
    yield* fs.makeDirectory(output)
    const snapshot = join(root, 'changes-snapshot.toml')
    const snapshotBytes = Buffer.from(
      '# preserved UTF-8 and CRLF: 雪\r\nversion = "2.3.5-beta.0+build.007"\r\n',
    )
    yield* fs.writeFile(snapshot, snapshotBytes)
    const args = [
      fileURLToPath(new URL('./ReleaseArchive.ts', import.meta.url)),
      '--compiler',
      compiler,
      '--tool',
      tool,
      '--stdlib',
      standardLibrary,
      '--target',
      'aarch64-apple-darwin',
      '--output',
      output,
    ]
    const missing = yield* NativeProcess.execute(process.execPath, args)
    assert.strictEqual(missing.status, 1)
    assert.strictEqual(missing.stdout.toString(), '')
    assert.deepEqual(yield* fs.readDirectory(output), [])
    const packaged = yield* NativeProcess.execute(process.execPath, [
      ...args,
      '--version',
      '2.3.5-beta.0+build.007',
      '--snapshot',
      snapshot,
    ])
    assert.strictEqual(packaged.status, 0, packaged.stderr.toString())
    const archive = packaged.stdout.toString().trim()
    assert.strictEqual(
      archive,
      join(output, 'silk-2.3.5-beta.0+build.007-aarch64-apple-darwin.tar.gz'),
    )
    const unpacked = yield* NativeProcess.execute('tar', [
      '-xzOf',
      archive,
      'silk-2.3.5-beta.0+build.007-aarch64-apple-darwin/bin/silkc',
    ])
    assert.strictEqual(unpacked.status, 0, unpacked.stderr.toString())
    assert.strictEqual(unpacked.stdout.toString(), 'foreign executable bytes, not a host program')
    const front = yield* NativeProcess.execute('tar', [
      '-xzOf',
      archive,
      'silk-2.3.5-beta.0+build.007-aarch64-apple-darwin/bin/silk',
    ])
    assert.strictEqual(front.stdout.toString(), 'foreign tool bytes')
    const metadata = yield* NativeProcess.execute('tar', [
      '-xzOf',
      archive,
      'silk-2.3.5-beta.0+build.007-aarch64-apple-darwin/lib/silk/changes-snapshot.toml',
    ])
    assert.strictEqual(metadata.status, 0, metadata.stderr.toString())
    assert.deepStrictEqual(metadata.stdout, snapshotBytes)
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
)

it('refuses a member path that fits no ustar prefix and name split', () => {
  const unsplittable = `${'a'.repeat(160)}/${'b'.repeat(101)}`
  assert.strictEqual(ReleaseArchive.tar([{ _tag: 'Directory', path: unsplittable }]), undefined)
})

it.effect('writes Windows ZIP releases with exe names that an independent ZIP reader extracts', () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const root = yield* fs.makeTempDirectoryScoped({ prefix: 'silk-windows-zip-' })
    const library = join(root, 'stdlib')
    yield* fs.makeDirectory(library)
    yield* fs.writeFileString(join(library, 'snow-雪.silk'), 'Windows UTF-8 names\n')
    yield* fs.writeFileString(join(root, 'compiler'), 'MZ compiler bytes\0\xff')
    yield* fs.writeFileString(join(root, 'tool'), 'MZ tool bytes')
    const archive = yield* ReleaseArchive.write({
      compiler: join(root, 'compiler'), tool: join(root, 'tool'), standardLibrary: library,
      target: 'x86_64-pc-windows-msvc', version: '1.2.3', outputDirectory: root,
    })
    const top = 'silk-1.2.3-x86_64-pc-windows-msvc'
    assert.strictEqual(archive, join(root, `${top}.zip`))
    const expected = {
      [`${top}/bin/silkc.exe`]: 'MZ compiler bytes\0\xff',
      [`${top}/bin/silk.exe`]: 'MZ tool bytes',
      [`${top}/lib/silk/stdlib/snow-雪.silk`]: 'Windows UTF-8 names\n',
    }
    if (process.platform === 'win32') {
      // Windows' inbox tar is libarchive and reads ZIP, unlike GNU tar on the Linux runner.
      for (const [member, content] of Object.entries(expected)) {
        const result = yield* NativeProcess.execute('tar.exe', ['-xOf', archive, member])
        assert.strictEqual(result.status, 0, result.stderr.toString())
        assert.deepEqual(result.stdout, Buffer.from(content))
      }
    } else {
      const result = yield* NativeProcess.execute('python3', ['-c',
        'import sys,zipfile,json,base64; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print(json.dumps({i.filename:base64.b64encode(z.read(i)).decode() for i in z.infolist() if not i.is_dir()}))', archive])
      assert.strictEqual(result.status, 0, result.stderr.toString())
      const files = yield* Effect.try(() => JSON.parse(result.stdout.toString()))
      assert.deepEqual(files, Object.fromEntries(Object.entries(expected).map(([name, content]) =>
        [name, Buffer.from(content).toString('base64')],
      )))
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
)
