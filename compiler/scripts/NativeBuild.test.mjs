import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
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
        const options = { seed, snapshot, outputDirectory: join(root, 'run'), timeCommand }
        yield* Effect.gen(() => run({ root, options, manifest }))
      }),
    )
  },
)

const producer = (smokeBody = 'exit 42') => `
test "$1" = build && test "$3" = -o && test "$5" = --stdlib || exit 91
test -f "$2" && test -f "$6/silk/i32.silk" || exit 92
printf 'N0 %s\\n' "$*" >> "$0.invocations"
cat > "$4" <<'N1'
#!/bin/sh
test "$1" = build && test "$3" = -o || exit 93
printf 'N1 %s\\n' "$*" >> "$0.invocations"
cat > "$4" <<'SMOKE'
#!/bin/sh
${smokeBody}
SMOKE
chmod +x "$4"
N1
chmod +x "$4"`

it.layer(NodeServices.layer)((it) => {
  it.effect(
    'records N0 inputs and proves the distinct newly produced N1 ran trivial-features',
    () =>
      fixture(function* ({ options, manifest }) {
        executable(options.seed, producer())
        const result = yield* NativeBuild.buildAndSmoke(options)
        assert.strictEqual(result.status, 'passed')
        assert.strictEqual(result.seed.sha256, SourceSnapshot.hash(readFileSync(options.seed)))
        assert.strictEqual(
          result.output.sha256,
          SourceSnapshot.hash(readFileSync(result.output.path)),
        )
        assert.notStrictEqual(result.output.sha256, result.seed.sha256)
        assert.strictEqual(result.inputs.compiler.sha256, manifest.compilerDigest)
        assert.strictEqual(result.inputs.stdlib.sha256, manifest.stdlibDigest)
        assert.deepStrictEqual(result.inputs.compiler.files, manifest.files.slice(0, 2))
        assert.deepStrictEqual(
          result.stages.map(({ name }) => name),
          ['native-build', 'smoke-build', 'smoke-run'],
        )
        assert.strictEqual(result.stages[0].command[0], options.seed)
        assert.strictEqual(result.stages[1].command[0], result.output.path)
        assert.strictEqual(
          readFileSync(`${options.seed}.invocations`, 'utf8').split('\n').filter(Boolean).length,
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
          Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(
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

  it.effect('preserves native entry-signature refusal without smoke or recovery', () =>
    fixture(function* ({ options }) {
      executable(
        options.seed,
        'echo \'SILK_UNSUPPORTED_JSON={"gaps":[{"code":"entry-signature","reason":"effect entry"}]}\' >&2\nexit 2',
      )
      const result = yield* NativeBuild.buildAndSmoke(options)
      assert.strictEqual(result.status, 'failed')
      assert.strictEqual(result.failure.stage, 'native-build')
      assert.strictEqual(result.stages.length, 1)
      assert.strictEqual(result.stages[0].exitCode, 2)
      assert.match(result.stages[0].stderr, /entry-signature/)
      assert.strictEqual(existsSync(join(options.outputDirectory, 'smoke')), false)
    }),
  )

  it.effect('rejects a successful producer with no output and records a producer signal', () =>
    Effect.gen(function* () {
      for (const body of ['exit 0', 'kill -TERM $$']) {
        yield* fixture(function* ({ options }) {
          executable(options.seed, body)
          const result = yield* NativeBuild.buildAndSmoke(options)
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
          executable(options.seed, body)
          const result = yield* NativeBuild.buildAndSmoke(options)
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
        executable(options.seed, producer())
        mkdirSync(options.outputDirectory)
        writeFileSync(join(options.outputDirectory, 'N1'), 'stale output')
        const error = yield* NativeBuild.buildAndSmoke(options).pipe(Effect.flip)
        assert.match(error.message, /EEXIST|already exists|AlreadyExists/)
        assert.strictEqual(
          readFileSync(join(options.outputDirectory, 'N1'), 'utf8'),
          'stale output',
        )
        assert.strictEqual(existsSync(`${options.seed}.invocations`), false)
      })
      for (const command of ['ln', 'ln -s']) {
        yield* fixture(function* ({ options }) {
          executable(options.seed, `${command} "$0" "$4"`)
          const result = yield* NativeBuild.buildAndSmoke(options)
          assert.strictEqual(result.status, 'failed')
          assert.strictEqual(result.stages.length, 1)
        })
      }
    }),
  )

  it.effect('rejects writable seeds, changed consumed bytes and unavailable RSS measurement', () =>
    Effect.gen(function* () {
      yield* fixture(function* ({ options }) {
        executable(options.seed, producer(), 0o755)
        const result = yield* NativeBuild.buildAndSmoke(options)
        assert.match(result.failure.message, /no write permission/)
      })
      yield* fixture(function* ({ options }) {
        executable(options.seed, `printf 'changed' >> "$2"\n${producer()}`)
        const result = yield* NativeBuild.buildAndSmoke(options)
        assert.strictEqual(result.status, 'failed')
        assert.strictEqual(result.failure.stage, 'native-build')
        assert.match(result.failure.message, /Snapshot bytes or mode changed/)
        assert.strictEqual(result.stages.length, 1)
      })
      yield* fixture(function* ({ options, root }) {
        executable(options.seed, producer())
        const result = yield* NativeBuild.buildAndSmoke({
          ...options,
          timeCommand: join(root, 'missing-time'),
        })
        assert.strictEqual(result.status, 'failed')
        assert.match(result.stages[0].error, /ENOENT/)
        assert.strictEqual(result.stages[0].peakRss.value, null)
      })
    }),
  )
})
