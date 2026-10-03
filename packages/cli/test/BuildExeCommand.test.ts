import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Config from 'effect/Config'
import * as BuildExeCommand from '../src/BuildExeCommand.js'
import * as CompilerHost from './CompilerHost.js'
import * as Timeouts from './timeouts.js'

const defaultClang = (): string => {
  if (existsSync('/opt/homebrew/opt/llvm/bin/clang')) return '/opt/homebrew/opt/llvm/bin/clang'
  if (existsSync('/usr/local/opt/llvm/bin/clang')) return '/usr/local/opt/llvm/bin/clang'
  return 'clang'
}
const clang = Effect.runSync(
  Config.String('SILK_TEST_CLANG').pipe(Config.withDefault(defaultClang())),
)
const root = mkdtempSync(join(tmpdir(), 'silk-build-exe-test-'))

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

const sourceFile = (name: string, text: string): string => {
  const path = join(root, name)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
  return path
}

const run = (source: string, overrides: Partial<BuildExeCommand.Options> = {}) =>
  BuildExeCommand.run({
    source,
    sourceRoot: undefined,
    output: join(root, 'out'),
    target: undefined,
    optimization: 'debug',
    clang,
    saveTemps: false,
    timings: false,
    ...overrides,
  }).pipe(Effect.provide(CompilerHost.layer))

it.effect(
  'resolves nested imports from the source root rather than the importer directory',
  () =>
    Effect.gen(function* () {
      const source = sourceFile(
        'src/app/Main.silk',
        'import compiler.Syntax { answer }\npub fn main() -> i32 { return answer() }',
      )
      sourceFile('src/compiler/Syntax.silk', 'pub fn answer() -> i32 { return 42 }')
      const output = join(root, 'nested-answer')
      const status = yield* run(source, { sourceRoot: join(root, 'src'), output })

      assert.strictEqual(status, 0)
      assert.strictEqual(spawnSync(output).status, 42)
    }),
  Timeouts.nativeBuild,
)

it.effect('returns one for an absent import and leaves no artifact', () =>
  Effect.gen(function* () {
    const source = sourceFile(
      'missing/Main.silk',
      'import absent.Module\npub fn main() -> i32 { return 42 }',
    )
    const output = join(root, 'missing-output')
    const status = yield* run(source, { sourceRoot: join(root, 'missing'), output })
    assert.strictEqual(status, 1)
    assert.strictEqual(existsSync(output), false)
  }),
)

it.effect('returns two for an operational resolver failure and leaves no artifact', () =>
  Effect.gen(function* () {
    const sourceRoot = join(root, 'failed')
    const source = sourceFile(
      'failed/Main.silk',
      'import unreadable\npub fn main() -> i32 { return 42 }',
    )
    mkdirSync(join(sourceRoot, 'unreadable.silk'), { recursive: true })
    const output = join(root, 'failed-output')
    const status = yield* run(source, { sourceRoot, output })
    assert.strictEqual(status, 2)
    assert.strictEqual(existsSync(output), false)
  }),
)

it.effect('returns one for a missing entry or semantic rejection', () =>
  Effect.gen(function* () {
    const noEntry = sourceFile('noentry.silk', 'pub fn other() -> i32 { return 1 }')
    assert.strictEqual(yield* run(noEntry, { output: join(root, 'noentry') }), 1)

    const invalid = sourceFile('bad.silk', 'pub fn main() -> Nope { return 42 }')
    assert.strictEqual(yield* run(invalid, { output: join(root, 'bad') }), 1)
  }),
)

it.effect('returns two when the requested target cannot produce a native executable', () =>
  Effect.gen(function* () {
    const source = sourceFile('wasm.silk', 'pub fn main() -> i32 { return 42 }')
    const status = yield* run(source, {
      output: join(root, 'wasm'),
      target: 'wasm32-unknown-unknown',
    })

    assert.strictEqual(status, 2)
  }),
)
