import { readFileSync } from 'node:fs'
import * as Effect from 'effect/Effect'
import * as Corpus from '../../corpus/corpus.mjs'
import { assert, it } from './EffectTest.mjs'
import * as WasmCorpus from './WasmCorpus.ts'
import * as WasmModule from './WasmModule.ts'

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
const observed = (fields) => ({ exit: 0, trap: null, stdout: '', stderr: '', ...fields })

/** Instruction counts with `instructions` in all and `calls` of them calls. */
const counts = (instructions, calls = 0) =>
  Object.fromEntries(WasmModule.counted.map((name) => [name, name === 'instructions' ? instructions : name === 'call' ? calls : 0]))
/**
 * One build of a benchmark program. `steady` gives, by engine, the steady-state time of each pass;
 * each first run takes 1 ms longer than the steady state of its pass.
 */
const measure = (steady, { instructions = 1000, bytes = 100, functions = 10 } = {}) => ({
  bytes,
  functions,
  executed: counts(instructions),
  timings: Object.fromEntries(
    Object.entries(steady).map(([engine, each]) => [engine, each.map((ms) => ({ firstMs: ms + 1, steadyMs: ms, runs: 3 }))]),
  ),
})
/** A program whose builds, by key, have `v8-optimizing` steady-state times in each pass. */
const measured = (name, times, figures = {}) => ({
  name,
  builds: Object.fromEntries(Object.entries(times).map(([key, each]) => [key, measure({ 'v8-optimizing': each }, figures[key])])),
})
const report = (programs, passes = 2, engines = ['v8-optimizing']) => ({ schemaVersion: 2, compiler: 'silkc', engines, passes, programs })
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `expected ${actual} to be ${expected}`)
/** The cells of the table row that starts with `first`. */
const cells = (table, first) => {
  const line = table.split('\n').find((text) => text.startsWith(`| ${first} |`))
  assert.ok(line !== undefined, `no row ${first}`)
  return line.slice(2, -2).split(' | ')
}
/** The markdown table among `text`'s paragraphs whose header contains `header`. */
const tableWith = (text, header) => {
  const found = text.split('\n\n').find((paragraph) => paragraph.startsWith('|') && paragraph.split('\n')[0]?.includes(header))
  assert.ok(found !== undefined, `no table with ${header}`)
  return found
}

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
    assert.equal(
      WasmCorpus.skipReason(program({ outcome: { schemaVersion: 1, expected: { kind: 'rejected' } } })),
      'is rejected at compile time',
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
    // A difference past the start of a long report is shown, and a cut is named.
    const report = `${'x'.repeat(90)}\n`
    const longer = program({ outcome: { schemaVersion: 1, expected: { kind: 'trap' } }, stderr: report })
    assert.match(WasmCorpus.compareOutcome(longer, {}, observed({ exit: 1, stderr: `${report}  at caller\n` })) ?? '', /at caller/)
    assert.match(
      WasmCorpus.compareOutcome(longer, {}, observed({ exit: 1, stderr: 'y'.repeat(500) })) ?? '',
      /\(100 more characters\)/,
    )
    // A run with stderr closed has no stderr to compare.
    assert.equal(WasmCorpus.compareOutcome(traps, { closeStderr: true }, observed({ exit: 1 })), undefined)
  }),
)

it.effect('names builds, and reports no first run for Wasmtime', () =>
  Effect.sync(() => {
    assert.equal(WasmCorpus.buildKey({ backend: 'direct', optimization: 'size' }), 'direct-size')
    assert.deepEqual(WasmCorpus.phases('v8-tiering'), ['steady', 'first'])
    assert.deepEqual(WasmCorpus.phases('wasmtime'), ['steady'])
  }),
)

it.effect('takes the direct over the LLVM number of one optimization, and none where one is missing', () =>
  Effect.sync(() => {
    const bytes = (entry) => entry.bytes
    const both = measured('a', { 'llvm-speed': [10], 'direct-speed': [10] }, { 'llvm-speed': { bytes: 40 }, 'direct-speed': { bytes: 100 } })
    assert.equal(WasmCorpus.ratio(both, 'speed', bytes), 2.5)
    assert.equal(WasmCorpus.ratio(both, 'size', bytes), null)
    assert.equal(WasmCorpus.ratio({ name: 'b', error: 'did not build' }, 'speed', bytes), null)
    const empty = measured('c', { 'llvm-speed': [10], 'direct-speed': [10] }, { 'llvm-speed': { bytes: 0 } })
    assert.equal(WasmCorpus.ratio(empty, 'speed', bytes), null)
    assert.equal(WasmCorpus.geometricMean([]), undefined)
    near(WasmCorpus.geometricMean([2, 8]) ?? 0, 4)
  }),
)

it.effect('takes a time ratio within each pass, only where every pass has one above the floor', () =>
  Effect.sync(() => {
    // Pass ratios 2 and 8 give 4; the best times, 10 and 40, would give 4 too, so make them differ.
    const steady = measured('a', { 'llvm-speed': [10, 5], 'direct-speed': [20, 40] })
    assert.deepEqual(WasmCorpus.passRatios(steady, 'speed', 'v8-optimizing', 'steady', 2), [2, 8])
    near(WasmCorpus.timeRatio(steady, 'speed', 'v8-optimizing', 'steady', 2) ?? 0, 4)
    // The first run takes 1 ms longer in these fixtures: 21/11 and 41/6.
    near(WasmCorpus.timeRatio(steady, 'speed', 'v8-optimizing', 'first', 2) ?? 0, Math.sqrt((21 / 11) * (41 / 6)))
    assert.equal(WasmCorpus.timeRatio(steady, 'speed', 'wasmtime', 'steady', 2), null)
    // An LLVM time at the floor in one pass leaves the program out.
    const short = measured('b', { 'llvm-speed': [10, WasmCorpus.ratioFloorMs], 'direct-speed': [20, 20] })
    assert.equal(WasmCorpus.passRatios(short, 'speed', 'v8-optimizing', 'steady', 2), null)
    assert.equal(WasmCorpus.timeRatio(short, 'speed', 'v8-optimizing', 'steady', 2), null)
    near(WasmCorpus.timeRatio(short, 'speed', 'v8-optimizing', 'steady', 1) ?? 0, 2)
    // So does a pass that did not time it.
    assert.equal(WasmCorpus.timeRatio(steady, 'speed', 'v8-optimizing', 'steady', 3), null)
    const unbuilt = measured('c', { 'llvm-speed': [10, 10] })
    assert.equal(WasmCorpus.timeRatio(unbuilt, 'speed', 'v8-optimizing', 'steady', 2), null)
    assert.equal(WasmCorpus.timeRatio({ name: 'd', error: 'llvm-speed build failed' }, 'speed', 'v8-optimizing', 'steady', 2), null)
  }),
)

it.effect('averages the ratios of the programs that have one', () =>
  Effect.sync(() => {
    const ratios = { a: 2, b: 8, c: null }
    const mean = WasmCorpus.meanRatio([{ name: 'a' }, { name: 'b' }, { name: 'c' }], (entry) => ratios[entry.name])
    assert.equal(mean.count, 2)
    near(mean.mean ?? 0, 4)
    assert.deepEqual(WasmCorpus.meanRatio([], () => 1), { mean: undefined, count: 0 })
  }),
)

it.effect('measures how far times and ratios move between passes', () =>
  Effect.sync(() => {
    const programs = [
      // Times 10 and 11, 20 and 30: ratios 2 and 30/11.
      measured('a', { 'llvm-speed': [10, 11], 'direct-speed': [20, 30] }),
      // Times 5 and 5, 20 and 20: ratios 4 and 4.
      measured('b', { 'llvm-speed': [5, 5], 'direct-speed': [20, 20] }),
      // Under the floor in one pass: in neither noise.
      measured('c', { 'llvm-speed': [1, 10], 'direct-speed': [100, 100] }),
      { name: 'd', error: 'did not build' },
    ]
    const times = WasmCorpus.timeNoise(report(programs), 'v8-optimizing', 'steady')
    // c's direct build is above the floor in both passes, so its time counts.
    near(times?.typical ?? 0, (1.1 * 1.5) ** (1 / 5) - 1)
    near(times?.worst ?? 0, 0.5)
    assert.equal(times?.where, 'a direct-speed')
    const ratios = WasmCorpus.ratioNoise(report(programs), 'v8-optimizing', 'steady')
    near(ratios?.typical ?? 0, Math.sqrt(30 / 22) - 1)
    near(ratios?.worst ?? 0, 30 / 22 - 1)
    assert.equal(ratios?.where, 'a speed')
    const once = [measured('a', { 'llvm-speed': [10], 'direct-speed': [20] })]
    assert.equal(WasmCorpus.timeNoise(report(once, 1), 'v8-optimizing', 'steady'), undefined)
    assert.equal(WasmCorpus.ratioNoise(report(once, 1), 'v8-optimizing', 'steady'), undefined)
  }),
)

it.effect('summarizes each engine and phase, and executed instructions', () =>
  Effect.sync(() => {
    const programs = [
      {
        name: 'a',
        builds: {
          'llvm-speed': measure({ 'v8-optimizing': [10, 10], wasmtime: [10, 10] }, { instructions: 100 }),
          'direct-speed': measure({ 'v8-optimizing': [30, 30], wasmtime: [50, 50] }, { instructions: 600 }),
        },
      },
      { name: 'b', error: 'did not build' },
    ]
    const table = WasmCorpus.summaryTable(report(programs, 2, ['v8-optimizing', 'wasmtime']))
    const rows = table.split('\n').slice(2).map((line) => line.slice(2, 2 + line.slice(2).indexOf(' |')))
    assert.deepEqual(rows, ['v8-optimizing', 'v8-optimizing', 'wasmtime', 'executed instructions'])
    const [, phase, speed, size, ratios, times] = cells(table, 'wasmtime')
    assert.equal(phase, 'steady state')
    assert.equal(speed, '5.00x (5.00x to 5.00x), 1 programs')
    assert.equal(size, '-, 0 programs')
    assert.equal(ratios, '0.0% typical, 0.0% at a speed')
    assert.equal(times, '0.0% typical, 0.0% at a llvm-speed')
    assert.deepEqual(cells(table, 'executed instructions').slice(2, 4), ['6.00x, 1 programs', '-, 0 programs'])
  }),
)

it.effect('keeps the summary headline within the range of its passes', () =>
  Effect.sync(() => {
    const programs = [
      // Ratios 2 and 4.
      measured('a', { 'llvm-speed': [10, 10], 'direct-speed': [20, 40] }),
      // Ratio 8 in both passes, but LLVM falls under the floor in the second.
      measured('b', { 'llvm-speed': [10, 1.5], 'direct-speed': [80, 12] }),
    ]
    const speed = cells(WasmCorpus.summaryTable(report(programs)), 'v8-optimizing')[2] ?? ''
    assert.equal(speed, '2.83x (2.00x to 4.00x), 1 programs')
    const [headline, least, greatest] = [...speed.matchAll(/([\d.]+)x/g)].map((match) => Number(match[1]))
    assert.ok(least <= headline && headline <= greatest)
  }),
)

it.effect('prints the benchmark as time, instruction and size tables', () =>
  Effect.sync(() => {
    const table = WasmCorpus.benchmarkTable(
      report([
        measured(
          'a',
          { 'llvm-speed': [12, 10], 'direct-speed': [20, 20], 'llvm-size': [10, 10], 'direct-size': [40, 40] },
          { 'direct-speed': { instructions: 3000, bytes: 90, functions: 9 } },
        ),
        // Too short under LLVM speed to have a time ratio there, though it has an instruction ratio.
        measured('short', { 'llvm-speed': [1, 1], 'direct-speed': [3, 3], 'llvm-size': [10, 10], 'direct-size': [10, 10] }),
        { name: 'b', error: 'llvm-speed build failed' },
      ]),
    )
    assert.include(table, 'v8-optimizing, steady state:\n\n| program | LLVM speed ms |')
    const time = tableWith(table, 'LLVM speed ms')
    const instructions = tableWith(table, 'LLVM speed instructions')
    const sizes = tableWith(table, 'llvm-speed bytes')
    // The least time of the passes, and the mean of the pass ratios: 20/12 and 20/10.
    assert.deepEqual(cells(time, 'a'), ['a', '10.00', '20.00', '1.83x', '10.00', '40.00', '4.00x'])
    assert.deepEqual(cells(time, 'short'), ['short', '1.00', '3.00', '-', '10.00', '10.00', '1.00x'])
    assert.deepEqual(cells(time, 'geometric mean, LLVM > 2 ms in every pass'), [
      'geometric mean, LLVM > 2 ms in every pass',
      '',
      '1 programs',
      '1.83x',
      '',
      '2 programs',
      '2.00x',
    ])
    assert.deepEqual(cells(instructions, 'a').slice(1, 4), ['1000', '3000', '3.00x'])
    assert.deepEqual(cells(instructions, 'geometric mean').slice(2, 4), ['2 programs', '1.73x'])
    assert.deepEqual(cells(sizes, 'a'), ['a', '100', '10', '90', '9', '100', '10', '100', '10'])
    assert.notInclude(sizes, '| b |')
    assert.include(table, 'Not measured:\n- b: llvm-speed build failed\n')
  }),
)

it.effect('prints the change since an earlier benchmark', () =>
  Effect.sync(() => {
    const before = report([
      measured('close', { 'llvm-speed': [10, 10], 'direct-speed': [20, 22] }),
      measured('apart', { 'llvm-speed': [10, 10], 'direct-speed': [40, 44] }, { 'direct-speed': { instructions: 4000, bytes: 100 } }),
      { name: 'fixed', error: 'did not build' },
      measured('gone', { 'llvm-speed': [10, 10], 'direct-speed': [20, 20] }),
    ])
    const after = report(
      [
        measured('close', { 'llvm-speed': [10, 10], 'direct-speed': [21, 23] }),
        measured('apart', { 'llvm-speed': [10, 10], 'direct-speed': [20, 22] }, { 'direct-speed': { instructions: 3000, bytes: 90 } }),
        measured('fixed', { 'llvm-speed': [10, 10], 'direct-speed': [20, 20] }),
      ],
      2,
      ['v8-optimizing', 'wasmtime'],
    )
    const table = WasmCorpus.changeTable(before, after)
    assert.include(table, 'v8-optimizing, steady state, direct/LLVM:\n\n| program | speed builds | size builds |')
    assert.notInclude(table, 'wasmtime, steady state')
    const ratios = tableWith(table, 'speed builds')
    const exact = tableWith(table, 'llvm-speed instructions')
    const notes = table.trimEnd().split('\n\n').filter((paragraph) => paragraph.startsWith('Not '))
    // Pass ratios 2 and 2.2 against 2.1 and 2.3 overlap; 4 and 4.4 against 2 and 2.2 do not.
    assert.match(cells(ratios, 'close')[1] ?? '', /^2\.10x → 2\.20x \(~\+4\.\d%\)$/)
    assert.match(cells(ratios, 'apart')[1] ?? '', /^4\.20x → 2\.10x \(-50\.0%\)$/)
    assert.equal(cells(ratios, 'apart')[2], '-')
    assert.deepEqual(cells(exact, 'apart').slice(1, 3), ['1000 → 1000 (0.0%)', '4000 → 3000 (-25.0%)'])
    assert.equal(cells(exact, 'apart')[5], '100 → 90 (-10.0%)')
    for (const name of ['fixed', 'gone']) {
      assert.notInclude(ratios, `| ${name} |`)
      assert.notInclude(exact, `| ${name} |`)
    }
    assert.deepEqual(notes, ['Not measured in the earlier benchmark: fixed', 'Not timed in the earlier benchmark: wasmtime'])
  }),
)

const functionProfile = (name, selfMs, instructions, calls = 1) => ({ function: name, selfMs, calls, instructions })

it.effect('chooses the hottest functions by self time or by executed instructions', () =>
  Effect.sync(() => {
    const profile = [
      functionProfile('slow', 9, 10),
      functionProfile('busy', 1, 900),
      functionProfile('middle', 5, 50),
      functionProfile('cold', 0, 0, 0),
    ]
    assert.deepEqual(
      WasmCorpus.hottest(profile, 1).map((entry) => entry.function),
      ['slow', 'busy'],
    )
    assert.deepEqual(
      WasmCorpus.hottest(profile, 5).map((entry) => entry.function),
      ['slow', 'middle', 'busy'],
    )
  }),
)

it.effect('prints a profile per program and build', () =>
  Effect.sync(() => {
    const build = (runMs, bytes, executed, profile) => ({
      bytes,
      functions: 4,
      parameters: 6,
      runMs,
      hostMs: runMs - profile.reduce((sum, entry) => sum + entry.selfMs, 0),
      contains: counts(executed / 10),
      executed: counts(executed, executed / 100),
      profile,
    })
    const table = WasmCorpus.profileTable(
      {
        schemaVersion: 1,
        compiler: 'silkc',
        engine: 'v8-baseline',
        optimization: 'speed',
        programs: [
          {
            name: 'regex',
            llvm: build(10, 1000, 2000, [functionProfile('#3', 8, 2000)]),
            direct: build(40, 3000, 8000, [functionProfile('#5', 30, 6000, 12), functionProfile('#7', 0, 2000)]),
          },
          { name: 'json', error: 'llvm-speed build failed' },
        ],
      },
      8,
    )
    assert.include(table, 'regex, speed builds, v8-baseline:')
    assert.deepEqual(cells(table, 'run ms'), ['run ms', '10.00', '40.00', '4.00x'])
    assert.deepEqual(cells(table, 'module bytes'), ['module bytes', '1000', '3000', '3.00x'])
    assert.deepEqual(cells(table, 'all'), ['all', '200', '800', '4.00x', '2000', '8000', '4.00x'])
    assert.deepEqual(cells(table, 'call').slice(4), ['20', '80', '4.00x'])
    assert.include(table, 'regex, direct, hottest functions of 2 that ran:')
    assert.deepEqual(cells(table, '#5'), ['#5', '30.00', '75.0%', '12', '6000', '75.0%'])
    assert.deepEqual(cells(table, '#7'), ['#7', '0.00', '0.0%', '1', '2000', '25.0%'])
    const outside = table.split('\n').filter((line) => line.startsWith('| outside the module |'))
    assert.deepEqual(outside, ['| outside the module | 2.00 | 20.0% |  |  |  |', '| outside the module | 10.00 | 25.0% |  |  |  |'])
    assert.include(table, 'json: not profiled: llvm-speed build failed')
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
