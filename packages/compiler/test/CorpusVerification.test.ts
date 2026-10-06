import { assert, it } from '@effect/vitest'
import * as NodeServices from '@effect/platform-node/NodeServices'
import * as ConfigProvider from 'effect/ConfigProvider'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Path from 'effect/Path'
import * as Verification from '../../../compiler/scripts/CorpusVerification.js'
import type { CorpusProgram } from './support/corpus.js'

const literal: CorpusProgram = {
  name: 'literal',
  source: 'pub fn main() -> i32 { return 42 }',
  expected: { _tag: 'Completes', result: 42 },
  nativeStdout: 'witness\n',
  nativeStderr: 'stderr witness\n',
  nativeProfiles: [
    { name: 'debug', optimization: 'none', debug: true },
    { name: 'optimized', optimization: 'speed', debug: false },
  ],
  nativeRuns: [{ arguments: ['one'] }, { arguments: ['two'] }],
}

const fixture = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const repository = yield* fs.makeTempDirectoryScoped()
  yield* fs.makeDirectory(path.join(repository, 'compiler/scripts'), { recursive: true })
  yield* fs.makeDirectory(path.join(repository, 'packages/compiler/stdlib/silk'), {
    recursive: true,
  })
  const source = path.join(repository, 'packages/compiler/stdlib/silk/i32.silk')
  yield* fs.writeFileString(source, 'consumer stdlib witness\n')
  const compiler = path.join(repository, 'silkc')
  const compilerSource = `#!/bin/sh
if [ "$6" != '${repository}/packages/compiler/stdlib' ]; then exit 3; fi
if ! grep -q 'consumer stdlib witness' "$6/silk/i32.silk"; then exit 4; fi
printf '%s:%s\\n' "$8" "\${10}" >> "$0.profiles"
cat > program <<'PROGRAM'
#!/bin/sh
printf '%s\\n' "$1" >> '${repository}/invocations'
printf 'witness\\n'
printf 'stderr witness\\n' >&2
exit 42
PROGRAM
chmod +x program
`
  yield* fs.writeFileString(compiler, compilerSource)
  yield* fs.chmod(compiler, 0o755)
  return {
    repository,
    compiler,
    source,
    compilerSource,
    pins: path.join(repository, 'compiler/scripts/selfhost-track.json'),
  }
})

it.effect('verifies all live pins and declared profiles/runs without changing its inputs', () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const self = yield* fixture()
    yield* fs.writeFileString(self.pins, '["literal"]')
    // An unpinned failing case must not execute.
    yield* Verification.run(self, [literal, { ...literal, name: 'unselected', nativeCSources: {} }])
    assert.strictEqual(yield* fs.readFileString(self.compiler), self.compilerSource)
    assert.strictEqual(yield* fs.readFileString(self.source), 'consumer stdlib witness\n')
    assert.strictEqual(
      yield* fs.readFileString(`${self.compiler}.profiles`),
      'none:true\nspeed:false\n',
    )
    assert.strictEqual(
      yield* fs.readFileString(`${self.repository}/invocations`),
      'one\ntwo\none\ntwo\n',
    )
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
)

it.effect('rejects invalid pins before invoking the supplied compiler', () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const self = yield* fixture()
    assert.strictEqual((yield* Effect.result(Verification.run(self, [literal])))._tag, 'Failure')
    for (const pins of ['[]', '["literal","literal"]', '["literal","missing"]', '[""]', 'null']) {
      yield* fs.writeFileString(self.pins, pins)
      assert.strictEqual((yield* Effect.result(Verification.run(self, [literal])))._tag, 'Failure')
      assert.isFalse(yield* fs.exists(`${self.compiler}.profiles`))
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
)

it.effect('fails pinned unsupported and mismatched outcomes', () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const self = yield* fixture()
    yield* fs.writeFileString(self.pins, '["literal"]')
    for (const program of [
      { ...literal, nativeCSources: {} },
      { ...literal, nativeStdout: 'wrong' },
      { ...literal, expected: { _tag: 'Completes', result: 41 } },
    ] satisfies ReadonlyArray<CorpusProgram>) {
      assert.strictEqual((yield* Effect.result(Verification.run(self, [program])))._tag, 'Failure')
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
)

it.effect('requires SILKC and rejects selection configuration before corpus execution', () =>
  Effect.gen(function* () {
    for (const config of [
      {},
      { SILKC: '' },
      { SILKC: 'never-invoke', SILK_SELFHOST_CORPUS_CASES: 'literal' },
      { SILKC: 'never-invoke', SILK_SELFHOST_CORPUS_CASES: ' ' },
    ]) {
      const result = yield* Verification.runConfigured().pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(config)),
        Effect.result,
      )
      assert.strictEqual(result._tag, 'Failure')
    }
  }).pipe(Effect.provide(NodeServices.layer)),
)
