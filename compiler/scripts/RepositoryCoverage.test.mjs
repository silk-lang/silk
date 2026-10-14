import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Result from 'effect/Result'
import * as Coverage from './RepositoryCoverage.ts'
import * as NativeProcess from './NativeProcess.ts'

const require = createRequire(new URL('../../packages/cli/package.json', import.meta.url))
/** @type {typeof import('../../packages/cli/node_modules/@effect/platform-node/dist/index.js')} */
const { NodeServices } = await import(pathToFileURL(require.resolve('@effect/platform-node')).href)
const processOutcome = (status, stderr = '', signal = null) => ({
  status,
  stderr: Buffer.from(stderr),
  stdout: Buffer.alloc(0),
  signal,
  deadline: null,
})

it('discovers exported top-level entries without matching comments, literals, or members', () => {
  assert.isTrue(Coverage.hasMain('pub effect fn main() -> i32 { return 0 }'))
  for (const source of [
    'fn main() -> i32 { return 0 }',
    '// pub fn main() -> i32 {}',
    'let text = "pub fn main() -> i32 {}"',
    'impl Entry { pub fn main() -> i32 { return 0 } }',
  ])
    assert.isFalse(Coverage.hasMain(source))
})

it.effect(
  'extracts both documentation prefixes, tilde fences, and ignore opt-outs with stable IDs',
  () =>
    Effect.gen(function* () {
      const source = [
        '//! ```silk',
        '//! pub fn main() -> i32 { return 42 }',
        '//! ```',
        'pub struct Item {}',
        '  /// ~~~silk',
        '  /// pub fn main() -> i32 { return 0 }',
        '  /// ~~~',
        '  /// ```silk ignore',
        '  /// incomplete fragment',
        '  /// ```',
      ].join('\n')
      const programs = yield* Coverage.docPrograms('example.silk', source)
      assert.deepStrictEqual(
        programs.map(({ id, line }) => ({ id, line })),
        [
          { id: 'example.silk#doc-1', line: 1 },
          { id: 'example.silk#doc-2', line: 5 },
        ],
      )
      const shifted = yield* Coverage.docPrograms('example.silk', '\n' + source)
      assert.deepStrictEqual(
        shifted.map(({ id }) => id),
        programs.map(({ id }) => id),
      )
      assert.strictEqual(programs[1]?.source, 'pub fn main() -> i32 { return 0 }\n')
    }),
)

it.effect(
  'refuses broken or unrecognized documentation fences instead of silently omitting programs',
  () =>
    Effect.gen(function* () {
      for (const source of [
        '//! ```silk\n//! pub fn main() {}',
        '//! ```silk typo\n//! ```',
        '//! > ```silk\n//! > ```',
      ]) {
        const result = yield* Effect.result(Coverage.docPrograms('broken.silk', source))
        assert.isTrue(Result.isFailure(result))
      }
    }),
)

it.effect(
  'discovers new entries and no-main conformance roots while reporting explicit exclusions',
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const root = yield* fs.makeTempDirectoryScoped({ prefix: 'silk-coverage-discovery-' })
      const sources = {
        'examples/new/main.silk': 'pub fn main() -> i32 { return 0 }',
        'examples/new/Util.silk': 'pub fn answer() -> i32 { return 42 }',
        'packages/compiler/conformance/new/library.silk': 'pub fn answer() -> i32 { return 42 }',
        'packages/compiler/test/goldens/canonical.silk': 'pub fn main() -> i32 { return 0 }',
        'packages/compiler/test/fixtures/complete-interface-contracts/provider-equality.silk':
          'fn main() -> i32 { return 0 }',
        'openspec/changes/archive/old/evidence/captured-resource.silk':
          'pub fn main() -> i32 { return 0 }',
        'packages/compiler/stdlib/new.silk':
          '//! ```silk\n//! pub fn main() -> i32 { return 42 }\n//! ```',
      }
      for (const [path, source] of Object.entries(sources)) {
        yield* fs.makeDirectory(join(root, path, '..'), { recursive: true })
        yield* fs.writeFileString(join(root, path), source)
      }
      assert.strictEqual(
        (yield* NativeProcess.execute('git', ['init', '-q'], { cwd: root })).status,
        0,
      )
      assert.strictEqual(
        (yield* NativeProcess.execute('git', ['add', '.'], { cwd: root })).status,
        0,
      )
      const inventory = yield* Coverage.discover(root, new Set())
      assert.deepStrictEqual(
        inventory.programs.map(({ id }) => id),
        [
          'examples/new/main.silk',
          'packages/compiler/conformance/new/library.silk',
          'packages/compiler/stdlib/new.silk#doc-1',
        ],
      )
      assert.strictEqual(inventory.excluded.length, 5)
      assert.isTrue(inventory.excluded.every(({ reason }) => reason.length > 0))
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
)

it.effect('classifies unsupported gaps and multiple rejection receipts without losing either', () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(yield* Coverage.classify(processOutcome(0), true), {
      status: 'PASS',
      codes: [],
    })
    const gaps = 'SILK_UNSUPPORTED_JSON={"gaps":[{"code":"typed-form"},{"code":"typed-form"}]}\n'
    assert.deepStrictEqual(yield* Coverage.classify(processOutcome(2, gaps), false), {
      status: 'UNSUPPORTED',
      codes: ['typed-form'],
    })
    const rejections = 'SILK_BUILD_ERROR={"code":"SEM0014"}\nSILK_BUILD_ERROR={"code":"SEM0214"}\n'
    assert.deepStrictEqual(yield* Coverage.classify(processOutcome(1, rejections + gaps), false), {
      status: 'REJECTED',
      codes: ['SEM0014', 'SEM0214'],
      gaps: ['typed-form'],
    })
  }),
)

it.effect('fails infrastructure errors, malformed receipts, and status/receipt disagreements', () =>
  Effect.gen(function* () {
    for (const [outcome, emitted] of [
      [processOutcome(0), false],
      [processOutcome(1, 'linker failed'), false],
      [processOutcome(2, 'SILK_UNSUPPORTED_JSON={"gaps":[]}'), false],
      [processOutcome(2, 'SILK_UNSUPPORTED_JSON=broken'), false],
      [processOutcome(0, 'SILK_BUILD_ERROR={"code":"SEM0014"}'), true],
      [processOutcome(1, '', 'SIGSEGV'), false],
      [{ ...processOutcome(0), deadline: { timeoutMs: 1, expired: true } }, true],
    ])
      assert.isTrue(Result.isFailure(yield* Effect.result(Coverage.classify(outcome, emitted))))
  }),
)

it('fails removed and regressed pins while allowing observations for unpinned programs', () => {
  assert.deepStrictEqual(
    Coverage.regressions(
      [{ id: 'passing' }, { id: 'regressed' }, { id: 'known-gap' }],
      [
        { id: 'passing', status: 'PASS' },
        { id: 'regressed', status: 'UNSUPPORTED' },
        { id: 'known-gap', status: 'REJECTED' },
      ],
      ['passing', 'regressed', 'removed'],
    ),
    ['regressed', 'removed'],
  )
})

it.effect(
  'materializes corpus fixtures and records a complete sweep with pinned passes and observed rejections',
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const root = yield* fs.makeTempDirectoryScoped({ prefix: 'silk-coverage-receipt-' })
      const files = {
        'packages/compiler/test/support/corpus.ts':
          'import { readFileSync } from "node:fs"; export const nativeCorpus = [{ source: readFileSync(new URL("fixture.silk", import.meta.url), "utf8") }]',
        'packages/compiler/test/support/fixture.silk': 'pub fn main() -> i32 { return 7 }',
        'examples/new/main.silk': 'pub fn main() -> i32 { return 42 }',
        'packages/compiler/conformance/new/library.silk': 'pub fn answer() -> i32 { return 42 }',
        'compiler/scripts/repository-coverage-track.json': '["examples/new/main.silk"]',
      }
      for (const [path, source] of Object.entries(files)) {
        yield* fs.makeDirectory(join(root, path, '..'), { recursive: true })
        yield* fs.writeFileString(join(root, path), source)
      }
      for (const args of [
        ['init', '-q'],
        ['add', '.'],
        [
          '-c',
          'user.name=Fixture',
          '-c',
          'user.email=fixture@example.com',
          'commit',
          '-qm',
          'fixture',
        ],
      ])
        assert.strictEqual((yield* NativeProcess.execute('git', args, { cwd: root })).status, 0)
      const compiler = join(root, 'compiler-fixture')
      yield* fs.writeFileString(
        compiler,
        `#!${process.execPath}
import { readFileSync, writeFileSync } from 'node:fs'
if (readFileSync(process.argv[3], 'utf8').includes('pub fn main')) {
  writeFileSync(process.argv[process.argv.indexOf('-o') + 1], 'fixture IR')
} else {
  console.error('SILK_BUILD_ERROR={"code":"SEM0014"}')
  process.exitCode = 1
}
`,
      )
      yield* fs.chmod(compiler, 0o755)
      const output = join(root, 'out')
      const receipt = yield* Coverage.run({ repository: root, compiler, output })
      assert.deepStrictEqual(receipt.summary, { pass: 1, unsupported: 0, rejected: 1, track: 1 })
      assert.deepStrictEqual(receipt.regressions, [])
      assert.strictEqual(receipt.outcomes.length, 2)
      assert.isTrue(
        receipt.excluded.some(({ reason }) => reason.startsWith('Exact source already measured')),
      )
      assert.isTrue(yield* fs.exists(join(output, 'receipt.json')))
      assert.isTrue((yield* fs.readFileString(join(output, 'baseline.md'))).includes('SEM0014'))
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
)
