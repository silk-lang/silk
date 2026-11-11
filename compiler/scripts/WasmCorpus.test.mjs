import { readFileSync } from 'node:fs'
import * as Effect from 'effect/Effect'
import * as Corpus from '../../corpus/corpus.mjs'
import { assert, it } from './EffectTest.mjs'
import * as WasmCorpus from './WasmCorpus.ts'

/** @param {Partial<import('../../corpus/corpus.mjs').Program>} fields */
const program = (fields) => ({
  name: 'p',
  source: '',
  reference: undefined,
  imports: {},
  cSources: {},
  windowsImports: {},
  stdout: undefined,
  stderr: undefined,
  outcome: { schemaVersion: 1, expected: { kind: 'completes', exitCode: 0 } },
  ...fields,
})
const observed = (fields) => ({ exit: 0, trap: null, stdout: '', stderr: '', ms: 1, ...fields })
const measure = (ms, bytes = 100, functions = 10) => ({ ms, bytes, functions })
const report = (programs) => ({ schemaVersion: 1, compiler: 'silkc', runs: 5, programs })
const builds = (llvmSpeed, directSpeed, llvmSize, directSize) => ({
  'llvm-speed': measure(llvmSpeed),
  'direct-speed': measure(directSpeed),
  'llvm-size': measure(llvmSize),
  'direct-size': measure(directSize),
})

it.effect('skips programs that cannot run as a wasip1 command', () =>
  Effect.sync(() => {
    assert.equal(WasmCorpus.skipReason(program({})), undefined)
    assert.equal(WasmCorpus.skipReason(program({ cSources: { helper: 'int f(void);' } })), 'links C units')
    const outcome = { schemaVersion: 1, expected: { kind: 'completes', exitCode: 0 } }
    assert.equal(WasmCorpus.skipReason(program({ outcome: { ...outcome, components: [] } })), 'binds components')
    assert.equal(
      WasmCorpus.skipReason(program({ outcome: { ...outcome, dynamicLibraries: ['libm'] } })),
      'loads dynamic libraries',
    )
  }),
)

it.effect('compares exit status, traps and output against the outcome', () =>
  Effect.sync(() => {
    const completes = program({ outcome: { schemaVersion: 1, expected: { kind: 'completes', exitCode: 300 } }, stdout: 'ok\n' })
    // Exit statuses compare in their low eight bits, as a POSIX parent sees them.
    assert.equal(WasmCorpus.compareOutcome(completes, {}, observed({ exit: 44, stdout: 'ok\n' })), undefined)
    assert.match(WasmCorpus.compareOutcome(completes, {}, observed({ exit: 45, stdout: 'ok\n' })) ?? '', /^exit 45/)
    assert.match(WasmCorpus.compareOutcome(completes, {}, observed({ exit: null, trap: 'unreachable' })) ?? '', /^trapped/)
    assert.match(WasmCorpus.compareOutcome(completes, {}, observed({ exit: 44, stdout: 'no\n' })) ?? '', /^stdout/)
    const traps = program({ outcome: { schemaVersion: 1, expected: { kind: 'trap' } }, stderr: 'panic\n' })
    assert.equal(WasmCorpus.compareOutcome(traps, {}, observed({ exit: null, trap: 'unreachable', stderr: 'panic\n' })), undefined)
    assert.equal(WasmCorpus.compareOutcome(traps, {}, observed({ exit: 1, stderr: 'panic\n' })), undefined)
    assert.match(WasmCorpus.compareOutcome(traps, {}, observed({ exit: 0, stderr: 'panic\n' })) ?? '', /expected a trap/)
    assert.match(WasmCorpus.compareOutcome(traps, {}, observed({ exit: 1, stderr: '' })) ?? '', /^stderr/)
    // A run with stderr closed has no stderr to compare.
    assert.equal(WasmCorpus.compareOutcome(traps, { closeStderr: true }, observed({ exit: 1 })), undefined)
  }),
)

it.effect('counts the functions a module defines', () =>
  Effect.sync(() => {
    const header = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]
    // A type section with one `() -> ()` type, then a function section declaring three functions.
    const types = [0x01, 0x04, 0x01, 0x60, 0x00, 0x00]
    const functions = [0x03, 0x04, 0x03, 0x00, 0x00, 0x00]
    assert.equal(WasmCorpus.wasmFunctionCount(Uint8Array.from([...header, ...types, ...functions])), 3)
    assert.equal(WasmCorpus.wasmFunctionCount(Uint8Array.from([...header, ...types])), 0)
    assert.equal(WasmCorpus.wasmFunctionCount(Uint8Array.from([...header, 0x03, 0x09, 0x01])), undefined)
    assert.equal(WasmCorpus.wasmFunctionCount(Uint8Array.from([0x7f, 0x45, 0x4c, 0x46])), undefined)
  }),
)

it.effect('takes the geometric mean of the ratio over programs above the floor', () =>
  Effect.sync(() => {
    assert.equal(WasmCorpus.geometricMean([]), undefined)
    assert.ok(Math.abs((WasmCorpus.geometricMean([2, 8]) ?? 0) - 4) < 1e-12)
    const programs = [
      { name: 'a', builds: builds(10, 20, 10, 40) },
      { name: 'b', builds: builds(5, 40, 5, 10) },
      // Too short under LLVM speed to count there, but long enough under LLVM size.
      { name: 'c', builds: builds(1, 100, 4, 4) },
      { name: 'd', error: 'did not build' },
    ]
    assert.deepEqual(WasmCorpus.timeRatio(programs[0], 'speed'), { ratio: 2, llvmMs: 10 })
    assert.equal(WasmCorpus.timeRatio(programs[3], 'speed'), null)
    const speed = WasmCorpus.meanRatio(programs, 'speed')
    assert.equal(speed.count, 2)
    assert.ok(Math.abs((speed.mean ?? 0) - 4) < 1e-12)
    const size = WasmCorpus.meanRatio(programs, 'size')
    assert.equal(size.count, 3)
    assert.ok(Math.abs((size.mean ?? 0) - 2) < 1e-12)
  }),
)

it.effect('prints the benchmark as time and size tables', () =>
  Effect.sync(() => {
    const table = WasmCorpus.benchmarkTable(
      report([
        { name: 'a', builds: builds(10, 20, 10, 40) },
        { name: 'b', error: 'llvm-speed build failed' },
      ]),
    )
    const lines = table.split('\n')
    assert.equal(lines[0], '| program | LLVM speed ms | direct speed ms | ratio | LLVM size ms | direct size ms | ratio |')
    assert.equal(lines[1], '| --- | --- | --- | --- | --- | --- | --- |')
    assert.equal(lines[2], '| a | 10.00 | 20.00 | 2.00x | 10.00 | 40.00 | 4.00x |')
    assert.equal(lines[3], '| geometric mean, LLVM > 2 ms |  | 1 programs | 2.00x |  | 1 programs | 4.00x |')
    assert.include(table, '| a | 100 | 10 | 100 | 10 | 100 | 10 | 100 | 10 |')
    assert.include(table, '- b: llvm-speed build failed')
  }),
)

it.effect('prints the change since an earlier benchmark', () =>
  Effect.sync(() => {
    const before = report([{ name: 'a', builds: builds(10, 40, 10, 40) }])
    const after = report([
      { name: 'a', builds: { ...builds(10, 20, 10, 40), 'direct-speed': measure(20, 90) } },
      { name: 'new', builds: builds(1, 1, 1, 1) },
    ])
    const lines = WasmCorpus.changeTable(before, after).split('\n')
    assert.equal(
      lines[2],
      '| a | 10.00 → 10.00 (0.0%) | 40.00 → 20.00 (-50.0%) | 10.00 → 10.00 (0.0%) | 40.00 → 40.00 (0.0%) | 100 → 90 (-10.0%) | 100 → 100 (0.0%) |',
    )
    assert.equal(lines[3], '| geometric mean, before > 2 ms | 1.00x of before | 0.50x of before | 1.00x of before | 1.00x of before |  |  |')
    assert.include(lines, 'Not in the earlier benchmark: new')
  }),
)

it.effect('reports as regressions only programs that passed before and do not now', () =>
  Effect.sync(() => {
    const before = [
      { name: 'kept', status: 'PASS' },
      { name: 'lost', status: 'PASS' },
      { name: 'unrun', status: 'PASS' },
      { name: 'still-failing', status: 'FAIL' },
      { name: 'fixed', status: 'BUILD' },
    ]
    const after = [
      { name: 'kept', status: 'PASS' },
      { name: 'lost', status: 'FAIL', reason: 'exit 1, expected 0' },
      { name: 'still-failing', status: 'BUILD' },
      { name: 'fixed', status: 'PASS' },
      { name: 'new', status: 'FAIL' },
    ]
    assert.deepEqual(
      WasmCorpus.regressions(before, after).map((result) => result.name),
      ['lost'],
    )
    assert.equal(WasmCorpus.summary(after), 'PASS 2 FAIL 2 BUILD 1 SKIP 0 of 5')
  }),
)

it.effect('accepts the tracked benchmark list and rejects malformed ones', () =>
  Effect.gen(function* () {
    const names = Corpus.programNames('native')
    const tracked = readFileSync(new URL('./wasm-benchmark-track.json', import.meta.url), 'utf8')
    const track = yield* WasmCorpus.validateTrack(tracked, names)
    assert.ok(track.length > 0)
    for (const name of track) assert.equal(WasmCorpus.skipReason(Corpus.loadProgram('native', name)), undefined)
    const reason = (text) =>
      WasmCorpus.validateTrack(text, ['a', 'b']).pipe(
        Effect.flip,
        Effect.map((error) => [error.reason, error.message]),
      )
    const [, repeated] = yield* reason('["a", "b", "a"]')
    assert.match(repeated, /repeats a/)
    const [, absent] = yield* reason('["a", "c"]')
    assert.match(absent, /absent from the corpus: c/)
    for (const text of ['[]', '{"programs": ["a"]}', '["a", ""]', 'not json']) {
      const [kind] = yield* reason(text)
      assert.equal(kind, 'RejectedInput')
    }
  }),
)
