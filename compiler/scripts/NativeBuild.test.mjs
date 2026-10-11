import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
const require = createRequire(new URL('../../packages/cli/package.json', import.meta.url))
/** @type {typeof import('../../packages/cli/node_modules/@effect/platform-node/dist/index.js')} */
const { NodeServices } = await import(pathToFileURL(require.resolve('@effect/platform-node')).href)
import * as NativeBuild from './NativeBuild.ts'
import * as SourceSnapshot from './SourceSnapshot.mjs'

const executable = (path, contents, mode = 0o555) => {
  writeFileSync(path, `#!/bin/sh\n${contents}\n`)
  chmodSync(path, mode)
}

const fixture = Effect.fnUntraced(
  /** @param {(inputs: {root:string,options: import('./NativeBuild.ts').BuildOptions,manifest: import('effect/Schema').Schema.Type<typeof SourceSnapshot.InputSnapshotSchema>}) => import('effect/Effect').fn.Return<void,import('./NativeBuild.ts').NativeBuildError|import('effect/PlatformError').PlatformError|import('effect/Schema').SchemaError,import('effect/FileSystem').FileSystem>} run */
  function* (run) {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const root = yield* Effect.acquireRelease(
          Effect.sync(() => mkdtempSync(join(tmpdir(), 'silk-native-receipt-'))),
          (root) => Effect.sync(() => rmSync(root, { recursive: true, force: true })),
        )
        const snapshot = join(root, 'snapshot')
        const inputs = [
          ['compiler/silk.toml', '[package]\nname = "compiler"\nroot = "src/main.silk"\n'],
          ['compiler/src/main.silk', 'pub fn main() -> i32 { return 0 }'],
          [
            'packages/compiler/stdlib/silk/i32.silk',
            'pub fn identity(value: i32) -> i32 { return value }',
          ],
        ]
        const files = inputs.map(([path, bytes]) => {
          const target = join(snapshot, path)
          mkdirSync(dirname(target), { recursive: true })
          writeFileSync(target, bytes)
          chmodSync(target, 0o644)
          return { path, mode: '100644', sha256: SourceSnapshot.hash(bytes) }
        })
        writeFileSync(join(snapshot, 'authored-inputs.tar'), 'fixture archive')
        const manifest = {
          schemaVersion: 1,
          sourceCommit: 'a'.repeat(40),
          roots: SourceSnapshot.roots,
          files,
          normalizedDigest: SourceSnapshot.fileDigest(files),
          compilerDigest: SourceSnapshot.fileDigest(
            files.filter(({ path }) => path.startsWith('compiler/')),
          ),
          stdlibDigest: SourceSnapshot.fileDigest(
            files.filter(({ path }) => path.startsWith('packages/compiler/stdlib/')),
          ),
          archive: 'authored-inputs.tar',
          archiveSha256: SourceSnapshot.hash('fixture archive'),
        }
        const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(manifest)
        writeFileSync(join(snapshot, 'input-snapshot.json'), encoded)
        const timeCommand = join(root, 'time')
        // Inject a measurement command, not a compiler: production uses GNU time's real ru_maxrss.
        executable(
          timeCommand,
          `test "$1" = -f && test "$2" = %M && test "$3" = -o && test "$5" = -- || exit 97
resource="$4"
shift 5
"$@"
status="$?"
if test "$status" = 143; then printf 'Command terminated by signal 15\\n' > "$resource"; fi
printf '1234\\n' >> "$resource"
exit "$status"`,
        )
        const seed = join(root, 'N0')
        const clang = join(root, 'clang-22')
        executable(clang, "printf 'fixture clang version 22\\n'")
        const options = {
          producer: seed,
          producerSha256: '0'.repeat(64),
          producerGeneration: 'seed',
          generation: 'N1',
          clang,
          snapshot,
          outputDirectory: join(root, 'run'),
          timeCommand,
        }
        yield* Effect.gen(() => run({ root, options, manifest }))
      }),
    )
  },
)

/** Binds the producer's exact bytes, as the pin or the previous generation's receipt does. */
const fixtureBuild = Effect.fnUntraced(
  /** @param {import('./NativeBuild.ts').BuildOptions} options */ function* (options) {
    return yield* NativeBuild.buildAndSmoke({
      ...options,
      producerSha256: SourceSnapshot.hash(readFileSync(options.producer)),
    })
  },
)

const producer = (smokeBody = 'exit 42', ir = 'compiler IR') => `
test "$1" = build && test "$3" = -o && test "$5" = --emit && test "$7" = --stdlib || exit 91
test -f "$2" && test -f "$8/silk/i32.silk" || exit 92
printf 'N0 %s\\n' "$*" >> "$0.invocations"
if test "$6" = llvm-ir; then printf '${ir}' > "$4"; exit 0; fi
cat > "$4" <<'N1'
#!/bin/sh
test "$1" = build && test "$3" = -o || exit 93
if test "$6" = llvm-ir; then printf '${ir}' > "$4"; exit 0; fi
printf 'N1 %s\\n' "$*" >> "$0.invocations"
cat > "$4" <<'SMOKE'
#!/bin/sh
${smokeBody}
SMOKE
chmod +x "$4"
N1
chmod +x "$4"`

it.layer(NodeServices.layer, { excludeTestServices: true })((it) => {
  it.effect(
    'binds a canonical clang symlink and overrides conflicting ambient linker for every child',
    () =>
      fixture(function* ({ root, options }) {
        const alias = join(root, 'clang')
        symlinkSync('clang-22', alias)
        const check = `test "$SILKC_CLANG" = '${options.clang}' || exit 81\ntest -z "$SILK_PRIVATE_SECRET" && test -z "$SILK_TEST_CLANG" || exit 82`
        executable(
          options.producer,
          `${check}\n${producer(check + '\nexit 42').replace(
            'test "$1" = build && test "$3" = -o || exit 93',
            check + '\ntest "$1" = build && test "$3" = -o || exit 93',
          )}`,
        )
        const result = yield* fixtureBuild({
          ...options,
          clang: alias,
          environment: {
            ...process.env,
            SILKC_CLANG: '/conflicting/clang',
            SILK_TEST_CLANG: '/other/clang',
            SILK_PRIVATE_SECRET: 'unrecorded-private-value',
          },
        })
        assert.strictEqual(result.status, 'passed')
        assert.strictEqual(result.linker.path, options.clang)
        assert.strictEqual(result.linker.requestedPath, alias)
        assert.strictEqual(result.linker.version, 'fixture clang version 22')
        assert.strictEqual(result.linker.sha256, SourceSnapshot.hash(readFileSync(options.clang)))
        for (const stage of result.stages)
          assert.deepStrictEqual(stage.linkerEnvironment, { SILKC_CLANG: options.clang })
        assert.strictEqual(JSON.stringify(result).includes('unrecorded-private-value'), false)
      }),
  )

  it.effect('refuses an unverified producer and unusable clang before a native child', () =>
    Effect.gen(function* () {
      for (const fault of ['producer', 'missing', 'dangling', 'nonexecutable', 'directory']) {
        yield* fixture(function* ({ root, options }) {
          executable(options.producer, producer())
          let clang = options.clang
          if (fault === 'missing') clang = join(root, 'missing')
          if (fault === 'dangling') {
            clang = join(root, 'dangling')
            symlinkSync('absent-target', clang)
          }
          if (fault === 'nonexecutable') chmodSync(clang, 0o444)
          if (fault === 'directory') clang = options.snapshot
          const result = yield* NativeBuild.buildAndSmoke({
            ...options,
            clang,
            producerSha256:
              fault === 'producer'
                ? 'f'.repeat(64)
                : SourceSnapshot.hash(readFileSync(options.producer)),
          })
          assert.strictEqual(result.status, 'failed', fault)
          assert.strictEqual(
            result.failure.stage,
            fault === 'producer' ? 'inputs' : 'linker-preflight',
            fault,
          )
          assert.strictEqual(result.stages.length, 0, fault)
          assert.strictEqual(result.output.sha256, null, fault)
          assert.strictEqual(existsSync(`${options.producer}.invocations`), false, fault)
        })
      }
    }),
  )

  it.effect(
    'fails closed if verified clang bytes or alias binding change during the native build',
    () =>
      Effect.gen(function* () {
        for (const fault of ['bytes', 'alias']) {
          yield* fixture(function* ({ root, options }) {
            const alias = join(root, 'clang')
            symlinkSync('clang-22', alias)
            let mutate = `cp '${options.clang}' '${join(root, 'other-clang')}'\nrm '${alias}'\nln -s other-clang '${alias}'`
            if (fault === 'bytes')
              mutate = `chmod u+w '${options.clang}'\nprintf '# changed\\n' >> '${options.clang}'`
            executable(options.producer, producer() + '\n' + mutate)
            const result = yield* fixtureBuild({ ...options, clang: alias })
            assert.strictEqual(result.status, 'failed')
            assert.strictEqual(result.failure.stage, 'native-build')
            assert.strictEqual(result.stages.length, 1)
            assert.match(result.failure.message, /changed/)
            assert.strictEqual(result.output.sha256, null)
            assert.strictEqual(existsSync(join(options.outputDirectory, 'smoke')), false)
          })
        }
      }),
  )

  it.effect(
    'records exact inputs and proves the distinct newly produced N1 ran trivial-features',
    () =>
      fixture(function* ({ options, manifest }) {
        executable(options.producer, producer())
        const result = yield* fixtureBuild(options)
        assert.strictEqual(result.status, 'passed')
        assert.strictEqual(
          result.producer.sha256,
          SourceSnapshot.hash(readFileSync(options.producer)),
        )
        assert.strictEqual(
          result.output.sha256,
          SourceSnapshot.hash(readFileSync(result.output.path)),
        )
        assert.notStrictEqual(result.output.sha256, result.producer.sha256)
        assert.strictEqual(result.inputs.compiler.sha256, manifest.compilerDigest)
        assert.strictEqual(result.inputs.stdlib.sha256, manifest.stdlibDigest)
        assert.deepStrictEqual(result.inputs.compiler.files, manifest.files.slice(0, 2))
        assert.deepStrictEqual(
          result.stages.map(({ name }) => name),
          ['native-build', 'smoke-build', 'smoke-run'],
        )
        assert.strictEqual(result.stages[0].command[0], options.producer)
        assert.strictEqual(result.stages[1].command[0], result.output.path)
        assert.strictEqual(
          readFileSync(`${options.producer}.invocations`, 'utf8').split('\n').filter(Boolean)
            .length,
          1,
        )
        assert.strictEqual(
          readFileSync(`${result.output.path}.invocations`, 'utf8').split('\n').filter(Boolean)
            .length,
          1,
        )
        assert.strictEqual(result.stages[0].peakRss.value, 1234)
        assert.strictEqual(result.stages[0].peakRss.unit, 'KiB')
        assert.deepStrictEqual(
          Schema.decodeSync(Schema.fromJsonString(Schema.Unknown))(
            readFileSync(join(options.outputDirectory, 'build-receipt.json'), 'utf8'),
          ),
          result,
        )
        assert.strictEqual(
          SourceSnapshot.hash(readFileSync(join(options.outputDirectory, 'smoke/main.silk'))),
          result.smoke.sourceSha256,
        )
      }),
  )

  it.effect('persists exact partial native bytes on deadline without N1 or smoke fallback', () =>
    fixture(function* ({ options }) {
      executable(
        options.producer,
        `printf '\\377out'
printf '\\376err' >&2
sleep 60`,
      )
      const result = yield* fixtureBuild({ ...options, timeoutMs: 250 })
      assert.strictEqual(result.status, 'failed')
      assert.strictEqual(result.failure.stage, 'native-build')
      assert.strictEqual(result.stages.length, 1)
      const stage = result.stages[0]
      assert.match(stage.error, /deadline exceeded/)
      assert.strictEqual(stage.signal, 'SIGKILL')
      assert.strictEqual(result.output.sha256, null)
      assert.strictEqual(existsSync(result.output.path), false)
      assert.strictEqual(existsSync(join(options.outputDirectory, 'smoke')), false)
      assert.deepStrictEqual(stage.command, [
        options.producer,
        'build',
        join(options.snapshot, 'compiler/src/main.silk'),
        '-o',
        result.output.path,
        '--emit',
        'executable',
        '--stdlib',
        join(options.snapshot, 'packages/compiler/stdlib'),
        '--optimization',
        'speed',
        '--debug',
        'false',
      ])
      assert.deepStrictEqual(
        [...readFileSync(join(options.outputDirectory, 'native-build-stdout.bin'))],
        [255, 111, 117, 116],
      )
      assert.deepStrictEqual(
        [...readFileSync(join(options.outputDirectory, 'native-build-stderr.bin'))],
        [254, 101, 114, 114],
      )
      const sidecar = JSON.parse(
        readFileSync(join(options.outputDirectory, 'native-build-process-evidence.json'), 'utf8'),
      )
      assert.deepStrictEqual(sidecar.deadline, { timeoutMs: 250, expired: true })
      assert.strictEqual(sidecar.resources.present, false)
      assert.notStrictEqual(sidecar.resources.error, null)
      assert.deepStrictEqual(
        JSON.parse(readFileSync(join(options.outputDirectory, 'build-receipt.json'), 'utf8')),
        result,
      )
    }),
  )

  it.effect('forwards per-child deadlines to preflight and postflight clang checks', () =>
    Effect.gen(function* () {
      for (const point of ['linker-preflight', 'native-build']) {
        yield* fixture(function* ({ root, options }) {
          const marker = join(root, 'block-version')
          chmodSync(options.clang, 0o755)
          executable(
            options.clang,
            `if test -f '${marker}'; then sleep 60; fi\nprintf 'fixture clang version 22\\n'`,
          )
          if (point === 'linker-preflight') writeFileSync(marker, 'block')
          executable(options.producer, producer() + `\nprintf block > '${marker}'`)
          const result = yield* fixtureBuild({ ...options, timeoutMs: 150 })
          assert.strictEqual(result.status, 'failed')
          assert.strictEqual(result.failure.stage, point)
          assert.strictEqual(result.stages.length, point === 'linker-preflight' ? 0 : 1)
          assert.match(result.failure.message, /cannot read verified clang version/)
          assert.strictEqual(result.output.sha256, null)
          assert.strictEqual(existsSync(join(options.outputDirectory, 'smoke')), false)
        })
      }
    }),
  )

  it.effect('retains actual stage facts when completed evidence cannot be written', () =>
    fixture(function* ({ options }) {
      executable(
        options.producer,
        `mkdir '${join(options.outputDirectory, 'native-build-stdout.bin')}'\nprintf actual\nprintf refused >&2\nexit 2`,
      )
      const result = yield* fixtureBuild(options)
      assert.strictEqual(result.status, 'failed')
      assert.strictEqual(result.failure.stage, 'native-build')
      assert.strictEqual(result.stages.length, 1)
      assert.strictEqual(result.stages[0].exitCode, 2)
      assert.strictEqual(result.stages[0].stdout, 'actual')
      assert.strictEqual(result.stages[0].stderr, 'refused')
      assert.match(result.failure.message, /EISDIR|directory|AlreadyExists/)
      assert.strictEqual(
        existsSync(join(options.outputDirectory, 'native-build-process-evidence.json')),
        false,
      )
      assert.strictEqual(existsSync(join(options.outputDirectory, 'smoke')), false)
      assert.deepStrictEqual(
        JSON.parse(readFileSync(join(options.outputDirectory, 'build-receipt.json'), 'utf8')),
        result,
      )
    }),
  )

  it.effect(
    'retains unexpired deadlines and completed evidence for all three successful stages',
    () =>
      fixture(function* ({ options }) {
        executable(options.producer, producer())
        const result = yield* fixtureBuild({ ...options, timeoutMs: 300 })
        assert.strictEqual(result.status, 'passed')
        for (const stage of result.stages) {
          const sidecar = JSON.parse(
            readFileSync(
              join(options.outputDirectory, `${stage.name}-process-evidence.json`),
              'utf8',
            ),
          )
          assert.deepStrictEqual(sidecar.deadline, { timeoutMs: 300, expired: false })
          assert.strictEqual(sidecar.resources.present, true)
          assert.strictEqual(sidecar.resources.error, null)
          assert.deepStrictEqual(
            readFileSync(join(options.outputDirectory, `${stage.name}-stdout.bin`)),
            Buffer.from(stage.stdout),
          )
          assert.deepStrictEqual(
            readFileSync(join(options.outputDirectory, `${stage.name}-stderr.bin`)),
            Buffer.from(stage.stderr),
          )
          assert.strictEqual('deadline' in stage, false)
          assert.strictEqual('raw' in stage, false)
        }
      }),
  )

  it.effect('preserves a native backend-gap refusal without smoke or recovery', () =>
    fixture(function* ({ options }) {
      executable(
        options.producer,
        'echo \'SILK_UNSUPPORTED_JSON={"gaps":[{"code":"suspension","reason":"park"}]}\' >&2\nexit 2',
      )
      const result = yield* fixtureBuild(options)
      assert.strictEqual(result.status, 'failed')
      assert.strictEqual(result.failure.stage, 'native-build')
      assert.strictEqual(result.stages.length, 1)
      assert.strictEqual(result.stages[0].exitCode, 2)
      assert.match(result.stages[0].stderr, /suspension/)
      assert.strictEqual(existsSync(join(options.outputDirectory, 'smoke')), false)
    }),
  )

  it.effect('rejects a successful producer with no output and records a producer signal', () =>
    Effect.gen(function* () {
      for (const body of ['exit 0', 'kill -TERM $$']) {
        yield* fixture(function* ({ options }) {
          executable(options.producer, body)
          const result = yield* fixtureBuild(options)
          assert.strictEqual(result.status, 'failed')
          assert.strictEqual(result.stages.length, 1)
          if (body.startsWith('kill')) assert.strictEqual(result.stages[0].signal, 'SIGTERM')
          else assert.match(result.failure.message, /ENOENT/)
        })
      }
    }),
  )

  it.effect('rejects failed N1 compilation, missing smoke output, and wrong smoke outcomes', () =>
    Effect.gen(function* () {
      const bodies = [
        producer().replace('test "$1" = build && test "$3" = -o || exit 93', 'exit 7'),
        producer().replace('cat > "$4" <<\'SMOKE\'', 'exit 0\ncat > "$4" <<\'SMOKE\''),
        producer('exit 41'),
        producer('echo unexpected\nexit 42'),
        producer('kill -TERM $$'),
      ]
      for (const [index, body] of bodies.entries()) {
        yield* fixture(function* ({ options }) {
          executable(options.producer, body)
          const result = yield* fixtureBuild(options)
          assert.strictEqual(result.status, 'failed')
          assert.strictEqual(result.failure.stage, index < 2 ? 'smoke-build' : 'smoke-run')
          assert.strictEqual(result.stages.length, index < 2 ? 2 : 3)
        })
      }
    }),
  )

  it.effect('forbids stale output directories and N0 reuse by link', () =>
    Effect.gen(function* () {
      yield* fixture(function* ({ options }) {
        executable(options.producer, producer())
        mkdirSync(options.outputDirectory)
        writeFileSync(join(options.outputDirectory, 'N1'), 'stale output')
        const error = yield* fixtureBuild(options).pipe(Effect.flip)
        assert.match(error.message, /EEXIST|already exists|AlreadyExists/)
        assert.strictEqual(
          readFileSync(join(options.outputDirectory, 'N1'), 'utf8'),
          'stale output',
        )
        assert.strictEqual(existsSync(`${options.producer}.invocations`), false)
      })
      for (const command of ['ln', 'ln -s']) {
        yield* fixture(function* ({ options }) {
          executable(options.producer, `${command} "$0" "$4"`)
          const result = yield* fixtureBuild(options)
          assert.strictEqual(result.status, 'failed')
          assert.strictEqual(result.stages.length, 1)
        })
      }
    }),
  )

  it.effect('rejects writable seeds, changed consumed bytes and unavailable RSS measurement', () =>
    Effect.gen(function* () {
      yield* fixture(function* ({ options }) {
        executable(options.producer, producer(), 0o755)
        const result = yield* fixtureBuild(options)
        assert.match(result.failure.message, /no write permission/)
      })
      yield* fixture(function* ({ options }) {
        executable(options.producer, `printf 'changed' >> "$2"\n${producer()}`)
        const result = yield* fixtureBuild(options)
        assert.strictEqual(result.status, 'failed')
        assert.strictEqual(result.failure.stage, 'native-build')
        assert.match(result.failure.message, /Snapshot bytes or mode changed/)
        assert.strictEqual(result.stages.length, 1)
      })
      yield* fixture(function* ({ options, root }) {
        executable(options.producer, producer())
        const result = yield* fixtureBuild({
          ...options,
          timeCommand: join(root, 'missing-time'),
        })
        assert.strictEqual(result.status, 'failed')
        assert.match(result.stages[0].error, /ENOENT/)
        assert.strictEqual(result.stages[0].peakRss.value, null)
      })
    }),
  )

  it.effect('requires byte-identical compiler IR from both generations at a fixpoint', () =>
    Effect.gen(function* () {
      yield* fixture(function* ({ options }) {
        executable(options.producer, producer())
        const result = yield* fixtureBuild({
          ...options,
          producerGeneration: 'N1',
          generation: 'N2',
          fixpoint: true,
        })
        assert.strictEqual(result.status, 'passed')
        assert.deepStrictEqual(result.stages.map(({ name }) => name).sort(), [
          'N1-ir',
          'N2-ir',
          'native-build',
          'smoke-build',
          'smoke-run',
        ])
        assert.strictEqual(result.stages.at(-1)?.command[0], result.output.path)
        assert.strictEqual(result.fixpoint?.producerIrSha256, SourceSnapshot.hash('compiler IR'))
        assert.strictEqual(result.fixpoint?.outputIrSha256, result.fixpoint?.producerIrSha256)
      })
      yield* fixture(function* ({ options }) {
        executable(
          options.producer,
          producer().replace(
            'if test "$6" = llvm-ir; then printf \'compiler IR\' > "$4"; exit 0; fi\ncat',
            'if test "$6" = llvm-ir; then printf \'older IR\' > "$4"; exit 0; fi\ncat',
          ),
        )
        const result = yield* fixtureBuild({
          ...options,
          producerGeneration: 'N1',
          generation: 'N2',
          fixpoint: true,
        })
        assert.strictEqual(result.status, 'failed')
        assert.strictEqual(result.failure.stage, 'fixpoint')
        assert.strictEqual(result.fixpoint?.producerIrSha256, SourceSnapshot.hash('older IR'))
        assert.strictEqual(result.fixpoint?.outputIrSha256, SourceSnapshot.hash('compiler IR'))
      })
    }),
  )
})
