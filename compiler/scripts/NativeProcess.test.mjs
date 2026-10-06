import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Config from 'effect/Config'
import * as Exit from 'effect/Exit'
import * as Cause from 'effect/Cause'
import * as Fiber from 'effect/Fiber'
import * as FileSystem from 'effect/FileSystem'
import * as NativeProcess from './NativeProcess.ts'

const require = createRequire(new URL('../../packages/cli/package.json', import.meta.url))
/** @type {typeof import('../../packages/cli/node_modules/@effect/platform-node/dist/index.js')} */
const { NodeServices } = await import(pathToFileURL(require.resolve('@effect/platform-node')).href)

const fixture = Effect.fnUntraced(
  /** @param {(root:string,fs:import('effect/FileSystem').FileSystem) => import('effect/Effect').Effect<void,import('./NativeProcess.ts').NativeProcessError|import('effect/PlatformError').PlatformError|import('effect/Config').ConfigError,import('effect/FileSystem').FileSystem|import('effect/Scope').Scope>} */
  function* (use) {
    const fs = yield* FileSystem.FileSystem
    const root = yield* fs.makeTempDirectoryScoped({ prefix: 'silk-process-deadline-' })
    yield* use(root, fs)
  },
)
const executable = Effect.fnUntraced(
  /** @param {import('effect/FileSystem').FileSystem} fs @param {string} file @param {string} body */
  function* (fs, file, body) {
    yield* fs.writeFileString(file, `#!${process.execPath}\n${body}\n`, { flag: 'wx' })
    yield* fs.chmod(file, 0o755)
  },
)

it.layer(NodeServices.layer, { excludeTestServices: true })((it) => {
  it.effect('returns exact partial bytes and an expired close with absent GNU resource data', () =>
    fixture(function* (root, fs) {
      const time = join(root, 'no-resource-time')
      yield* executable(
        fs,
        time,
        `process.stdout.write(Buffer.from([255,111]));process.stderr.write(Buffer.from([254,101]));setInterval(()=>{},60000)`,
      )
      const command = ['/immutable/N0', 'build', '/snapshot/main.silk']
      const resourceFile = join(root, 'rss')
      const result = yield* NativeProcess.run({
        command,
        cwd: root,
        resourceFile,
        timeCommand: time,
        timeoutMs: 300,
      })
      assert.deepStrictEqual(result.deadline, { timeoutMs: 300, expired: true })
      assert.deepStrictEqual([...result.raw.stdout], [255, 111])
      assert.deepStrictEqual([...result.raw.stderr], [254, 101])
      assert.strictEqual(result.measurement.exitCode, null)
      assert.strictEqual(result.measurement.signal, 'SIGKILL')
      assert.match(result.measurement.error, /deadline exceeded/)
      assert.strictEqual(NativeProcess.succeeded(result.measurement), false)
      assert.strictEqual(result.resources.bytes, null)
      assert.notStrictEqual(result.resources.error, null)
      assert.strictEqual(result.measurement.peakRss.value, null)
      assert.deepStrictEqual(result.measurement.command, command)
      assert.deepStrictEqual(result.measurement.measurementCommand, [
        time,
        '-f',
        '%M',
        '-o',
        resourceFile,
        '--',
        ...command,
      ])
    }),
  )

  it.effect(
    'retains actual GNU time bytes on early exit and preserves nonzero and self-signal outcomes',
    () =>
      fixture(function* (root) {
        const command = [process.execPath, '-e', 'process.stdout.write("early");process.exit(0)']
        const result = yield* NativeProcess.run({
          command,
          cwd: root,
          resourceFile: join(root, 'rss'),
          timeCommand: yield* Config.String('SILK_TEST_GNU_TIME').pipe(
            Config.withDefault('/usr/bin/time'),
          ),
          timeoutMs: 300,
        })
        assert.deepStrictEqual(result.deadline, { timeoutMs: 300, expired: false })
        assert.strictEqual(NativeProcess.succeeded(result.measurement), true)
        assert.strictEqual(result.measurement.stdout, 'early')
        assert.notStrictEqual(result.resources.bytes, null)
        assert.match(Buffer.from(result.resources.bytes).toString('utf8'), /^\d+\n$/)
        assert.notStrictEqual(result.measurement.peakRss.value, null)
        for (const [source, status, signal] of [
          ['process.exit(7)', 7, null],
          ['process.kill(process.pid,"SIGTERM")', null, 'SIGTERM'],
        ]) {
          const result = yield* NativeProcess.execute(process.execPath, ['-e', source], {
            timeoutMs: 300,
          })
          assert.strictEqual(result.status, status)
          assert.strictEqual(result.signal, signal)
          assert.strictEqual(result.deadline.expired, false)
        }
      }),
  )

  it.effect('closes a same-group descendant and inherited pipes on deadline', () =>
    fixture(function* (root) {
      const source = `const {spawn}=require('node:child_process');spawn(process.execPath,['-e','console.log("descendant");setInterval(()=>{},60000)'],{stdio:['ignore','inherit','inherit']});console.log('parent');setInterval(()=>{},60000)`
      const result = yield* NativeProcess.execute(process.execPath, ['-e', source], {
        cwd: root,
        timeoutMs: 350,
      })
      assert.strictEqual(result.deadline.expired, true)
      assert.strictEqual(result.signal, 'SIGKILL')
      assert.deepStrictEqual(result.stdout.toString('utf8').trim().split('\n').sort(), [
        'descendant',
        'parent',
      ])
    }),
  )

  it.effect('rejects an expired deadline even when the direct command already exited zero', () =>
    fixture(function* (root) {
      const source = `const {spawn}=require('node:child_process');spawn(process.execPath,['-e','console.log("held pipe");setInterval(()=>{},60000)'],{stdio:['ignore','inherit','inherit']});process.exit(0)`
      const result = yield* NativeProcess.run({
        command: [process.execPath, '-e', source],
        cwd: root,
        resourceFile: join(root, 'rss'),
        timeCommand: yield* Config.String('SILK_TEST_GNU_TIME').pipe(
          Config.withDefault('/usr/bin/time'),
        ),
        timeoutMs: 350,
      })
      assert.strictEqual(result.deadline.expired, true)
      assert.strictEqual(result.measurement.exitCode, 0)
      assert.strictEqual(result.measurement.signal, null)
      assert.strictEqual(result.measurement.stdout, 'held pipe\n')
      assert.match(result.measurement.error, /deadline exceeded/)
      assert.strictEqual(NativeProcess.succeeded(result.measurement), false)
      assert.notStrictEqual(result.resources.bytes, null)
    }),
  )

  it.effect(
    'rejects invalid deadlines and stale files including dangling symlinks before spawn',
    () =>
      fixture(function* (root, fs) {
        const marker = join(root, 'marker')
        const source = `require('node:fs').writeFileSync(${JSON.stringify(marker)},'spawned')`
        for (const timeoutMs of [0, -1, 1.5, NaN, Infinity, 2147483648]) {
          const error = yield* NativeProcess.execute(process.execPath, ['-e', source], {
            timeoutMs,
          }).pipe(Effect.flip)
          assert.strictEqual(error.reason, 'RejectedInput')
          assert.strictEqual(error.partialOutcome, undefined)
          assert.strictEqual(error.cause, undefined)
        }
        for (const stale of ['file', 'symlink']) {
          const resourceFile = join(root, stale)
          if (stale === 'file') yield* fs.writeFileString(resourceFile, '777\n')
          else yield* fs.symlink(join(root, 'absent'), resourceFile)
          const result = yield* NativeProcess.run({
            command: [process.execPath, '-e', source],
            cwd: root,
            resourceFile,
            timeCommand: yield* Config.String('SILK_TEST_GNU_TIME').pipe(
              Config.withDefault('/usr/bin/time'),
            ),
            timeoutMs: 300,
          })
          assert.match(result.measurement.error, /must be fresh/)
          assert.strictEqual(result.measurement.exitCode, null)
          assert.strictEqual(result.resources.bytes, null)
          assert.strictEqual(result.measurement.peakRss.value, null)
        }
        assert.strictEqual(yield* fs.exists(marker), false)
      }),
  )

  it.effect('retains invalid resource bytes and distinguishes absent-command failure', () =>
    fixture(function* (root, fs) {
      const time = join(root, 'bad-time')
      yield* executable(
        fs,
        time,
        `require('node:fs').writeFileSync(process.argv[5],Buffer.from([255,120]));process.stdout.write('done')`,
      )
      const result = yield* NativeProcess.run({
        command: ['anything'],
        cwd: root,
        resourceFile: join(root, 'rss'),
        timeCommand: time,
      })
      assert.deepStrictEqual([...result.resources.bytes], [255, 120])
      assert.strictEqual(result.measurement.peakRss.value, null)
      assert.match(result.resources.error, /invalid GNU time/)
      assert.strictEqual(result.deadline, null)
      const missing = yield* NativeProcess.run({
        command: ['anything'],
        cwd: root,
        resourceFile: join(root, 'missing-rss'),
        timeCommand: join(root, 'absent'),
      })
      assert.match(missing.measurement.error, /ENOENT/)
      assert.strictEqual(missing.resources.bytes, null)
      assert.strictEqual(missing.deadline, null)
    }),
  )

  it.effect('carries closed-child partial bytes on typed stdin failure', () =>
    fixture(function* (root) {
      const source = `process.stdout.write('retained',()=>process.stderr.write('diagnostic',()=>{require('node:fs').closeSync(0);setInterval(()=>{},60000)}))`
      const error = yield* NativeProcess.execute(process.execPath, ['-e', source], {
        cwd: root,
        input: Buffer.alloc(8 * 1024 * 1024),
      }).pipe(Effect.flip)
      assert.strictEqual(error.operation, 'stdin')
      assert.strictEqual(error.partialOutcome.stdout.toString('utf8'), 'retained')
      assert.strictEqual(error.partialOutcome.stderr.toString('utf8'), 'diagnostic')
      assert.strictEqual(error.partialOutcome.signal, 'SIGKILL')
      assert.strictEqual(error.partialOutcome.deadline, null)
    }),
  )

  it.effect('releases an interrupted child group and returns no completed process value', () =>
    fixture(function* (root, fs) {
      const marker = join(root, 'started')
      const source = `require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},60000)`
      const fiber = yield* NativeProcess.execute(process.execPath, ['-e', source], {
        cwd: root,
        timeoutMs: 300,
      }).pipe(Effect.forkScoped)
      while (!(yield* fs.exists(marker))) yield* Effect.sleep(5)
      const pid = Number(yield* fs.readFileString(marker))
      yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.await(fiber)
      assert.strictEqual(Exit.isFailure(exit), true)
      assert.strictEqual(Cause.hasInterrupts(exit.cause), true)
      const gone = yield* Effect.try({
        try: /** @returns {boolean} */ () => process.kill(-pid, 0),
        catch: (cause) =>
          new NativeProcess.NativeProcessError({
            operation: 'probe',
            reason: 'ExternalFailure',
            message: String(cause),
            cause,
          }),
      }).pipe(Effect.flip)
      assert.instanceOf(gone.cause, Error)
      assert.strictEqual('code' in gone.cause && gone.cause.code, 'ESRCH')
    }),
  )
})
