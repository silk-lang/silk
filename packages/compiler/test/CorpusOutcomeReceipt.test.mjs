import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Result from 'effect/Result'
import { read } from '../../../compiler/scripts/CorpusOutcomeReceipt.ts'

const program = (name, streams = {}) => ({
  name,
  profiles: [{ name: 'optimized', optimization: 'speed', debug: false }],
  runs: [{ arguments: [], closeStderr: false }],
  expected: { _tag: 'Completes', result: 17 },
  ...streams,
})
const manifest = {
  schemaVersion: 1,
  mode: 'corpus-full',
  required: ['pin'],
  programs: [
    {
      ...program('pin', { stdout: '', stderr: '' }),
      profiles: [
        { name: 'debug', optimization: 'none', debug: true },
        { name: 'optimized', optimization: 'speed', debug: false },
      ],
      runs: [{ arguments: ['input'], closeStderr: true }],
    },
    program('observed'),
    { ...program('gap'), expected: { _tag: 'Trap' } },
  ],
}
const expected = { manifest, selection: 'full' }

const transcript = (authority = manifest, statuses = {}, selection = 'full') => {
  const names = authority.programs
    .map((p) => p.name)
    .filter((name) => selection === 'full' || authority.required.includes(name))
  const observed = names.map((name) => ({ name, status: statuses[name] ?? 'PASS' }))
  const lines =
    selection === 'full' ? [`SELFHOST_CORPUS_MANIFEST=${JSON.stringify(authority)}`] : []
  lines.push(
    ...names.map((name) => `SELFHOST_CASE_TIMING=${JSON.stringify({ name, elapsedMs: 2 })}`),
  )
  lines.push(
    ...observed.map(({ name, status }) => {
      if (status === 'PASS') return `PASS ${name}`
      return status === 'FAIL'
        ? `FAIL ${name}: code=TEST span=unavailable mismatch`
        : `UNSUPPORTED ${name}: GAP: missing capability`
    }),
  )
  const count = (status) => observed.filter((outcome) => outcome.status === status).length
  lines.push(
    `Selfhost corpus: pass=${count('PASS')} fail=${count('FAIL')} unsupported=${count('UNSUPPORTED')} track=${authority.required.length}`,
  )
  if (count('FAIL')) lines.push(`Selfhost failure TEST: ${count('FAIL')}`)
  if (count('UNSUPPORTED')) lines.push(`Selfhost gap GAP: ${count('UNSUPPORTED')}`)
  return lines.join('\n') + '\n'
}

const result = (output, authority = expected, previous) =>
  Effect.result(read(authority, output, previous))
const rejects = Effect.fn(
  /**
   * @param {string} output
   * @param {import('../../../compiler/scripts/CorpusOutcomeReceipt.js').Expected} authority
   * @param {import('../../../compiler/scripts/CorpusOutcomeReceipt.js').Previous} [previous]
   */
  function* (output, authority = expected, previous) {
    const answer = yield* result(output, authority, previous)
    assert.isTrue(Result.isFailure(answer))
    if (!Result.isFailure(answer)) throw new Error('Expected rejected receipt')
    assert.strictEqual(answer.failure._tag, 'CorpusOutcomeReceiptError')
    return answer.failure
  },
)

it.effect('reads complete ordered full and pin-only receipts without compiler execution', () =>
  Effect.gen(function* () {
    const current = yield* read(expected, transcript(manifest, { gap: 'UNSUPPORTED' }))
    assert.deepEqual(
      current.outcomes.map(({ name, status }) => ({ name, status })),
      [
        { name: 'pin', status: 'PASS' },
        { name: 'observed', status: 'PASS' },
        { name: 'gap', status: 'UNSUPPORTED' },
      ],
    )
    assert.deepEqual(current.summary, { pass: 2, fail: 0, unsupported: 1, track: 1 })
    assert.deepEqual(
      current.timings.map((timing) => timing.name),
      ['pin', 'observed', 'gap'],
    )
    assert.strictEqual(Object.hasOwn(current.manifest.programs[1], 'stdout'), false)
    assert.strictEqual(current.manifest.programs[0].stdout, '')
    assert.isTrue(
      Object.isFrozen(current) &&
        Object.isFrozen(current.outcomes[0]) &&
        Object.isFrozen(current.manifest.programs[0].runs[0]),
    )
    assert.strictEqual(Object.isFrozen(manifest), false)
    const pins = yield* read({ manifest, selection: 'pins' }, transcript(manifest, {}, 'pins'))
    assert.deepEqual(
      pins.outcomes.map((outcome) => outcome.name),
      ['pin'],
    )
    assert.deepEqual(pins.summary, { pass: 1, fail: 0, unsupported: 0, track: 1 })
    assert.strictEqual(pins.selection, 'pins')
  }),
)

it.effect(
  'rejects unpinned FAIL despite child exit0 while retaining complete red observations',
  () =>
    Effect.gen(function* () {
      const child = {
        exitCode: 0,
        stdout: transcript(manifest, { observed: 'FAIL', gap: 'UNSUPPORTED' }),
      }
      assert.strictEqual(child.exitCode, 0)
      const failure = yield* rejects(child.stdout)
      assert.strictEqual(failure.kind, 'Policy')
      assert.deepEqual(failure.failures, ['observed'])
      assert.deepEqual(failure.pinGaps, [])
      assert.deepEqual(failure.receipt.summary, { pass: 1, fail: 1, unsupported: 1, track: 1 })
      assert.deepEqual(
        failure.receipt.outcomes.map((outcome) => outcome.status),
        ['PASS', 'FAIL', 'UNSUPPORTED'],
      )
      const pin = yield* rejects(transcript(manifest, { pin: 'UNSUPPORTED' }))
      assert.deepEqual(pin.pinGaps, ['pin'])
    }),
)

it.effect('revalidates prior authority and rejects changed or removed prior PASS identities', () =>
  Effect.gen(function* () {
    const previous = { expected, output: transcript() }
    const loss = yield* rejects(
      transcript(manifest, { observed: 'UNSUPPORTED' }),
      expected,
      previous,
    )
    assert.strictEqual(loss.kind, 'Policy')
    assert.deepEqual(loss.lostPasses, ['observed'])
    assert.deepEqual(loss.receipt.summary, { pass: 2, fail: 0, unsupported: 1, track: 1 })
    const removed = {
      ...manifest,
      programs: manifest.programs.filter((p) => p.name !== 'observed'),
    }
    assert.deepEqual(
      (yield* rejects(transcript(removed), { manifest: removed, selection: 'full' }, previous))
        .lostPasses,
      ['observed'],
    )
    const malformed = yield* rejects(transcript(), expected, {
      expected,
      output: transcript().replace('PASS observed\n', ''),
    })
    assert.strictEqual(malformed.phase, 'Previous')
    assert.deepEqual(malformed.receipt.summary, { pass: 3, fail: 0, unsupported: 0, track: 1 })
    const redBaseline = yield* rejects(transcript(), expected, {
      expected,
      output: transcript(manifest, { observed: 'FAIL' }),
    })
    assert.strictEqual(redBaseline.phase, 'Previous')
    assert.strictEqual(redBaseline.kind, 'Policy')
  }),
)

it.effect('rejects every incomplete duplicate malformed unknown reordered protocol record', () =>
  Effect.gen(function* () {
    const valid = transcript()
    const firstTiming = 'SELFHOST_CASE_TIMING={"name":"pin","elapsedMs":2}\n'
    const secondTiming = 'SELFHOST_CASE_TIMING={"name":"observed","elapsedMs":2}\n'
    const mutations = [
      valid.slice(valid.indexOf('\n') + 1),
      valid.replace(firstTiming, firstTiming + firstTiming),
      valid.replace(firstTiming, ''),
      valid.replace(firstTiming, firstTiming.replace('pin', 'unknown')),
      valid.replace('"elapsedMs":2', '"elapsedMs":-1'),
      valid.replace('"elapsedMs":2', '"elapsedMs":0.5'),
      valid.replace('"elapsedMs":2', '"elapsedMs":9007199254740992'),
      valid.replace('"elapsedMs":2', '"elapsedMs":null'),
      valid.replace(firstTiming + secondTiming, secondTiming + firstTiming),
      valid.replace(firstTiming, 'SELFHOST_CASE_TIMING={broken}\n'),
      valid.replace('PASS observed\n', ''),
      valid.replace('PASS observed\n', 'PASS observed\nPASS observed\n'),
      valid.replace('PASS observed', 'PASS unknown'),
      valid.replace('PASS pin\nPASS observed\n', 'PASS observed\nPASS pin\n'),
      valid.replace('PASS observed', 'PASS observed: invented detail'),
      valid.replace('PASS observed', 'FAIL observed'),
      valid.replace('Selfhost corpus: pass=3', 'Selfhost corpus: pass=2'),
      valid.replace('track=1', 'track=0'),
      valid.replace('Selfhost corpus:', 'Selfhost corpus broken:'),
      valid + 'Selfhost corpus: pass=3 fail=0 unsupported=0 track=1\n',
      valid.replace('Selfhost corpus: pass=3 fail=0 unsupported=0 track=1\n', ''),
      valid.slice(0, -1),
      valid + 'unknown record\n',
    ]
    for (const output of mutations) {
      const failure = yield* rejects(output)
      assert.strictEqual(failure.kind, 'Malformed')
      assert.strictEqual(failure.receipt, undefined)
    }
  }),
)

it.effect(
  'matches full current metadata including omitted versus explicitly empty output constraints',
  () =>
    Effect.gen(function* () {
      const changed = [
        { ...manifest, schemaVersion: 2 },
        { ...manifest, required: ['pin', 'pin'] },
        { ...manifest, required: ['unknown'] },
        { ...manifest, programs: [...manifest.programs, manifest.programs[0]] },
        { ...manifest, programs: [] },
        { ...manifest, programs: [program('pin', { stdout: '' }), ...manifest.programs.slice(1)] },
        {
          ...manifest,
          programs: [
            manifest.programs[0],
            { ...manifest.programs[1], stdout: '' },
            manifest.programs[2],
          ],
        },
        {
          ...manifest,
          programs: [{ ...manifest.programs[0], runs: [] }, ...manifest.programs.slice(1)],
        },
        {
          ...manifest,
          programs: [{ ...manifest.programs[0], profiles: [] }, ...manifest.programs.slice(1)],
        },
      ]
      for (const authority of changed) {
        assert.strictEqual((yield* rejects(transcript(authority))).kind, 'Malformed')
      }
      for (const authority of [
        changed[0],
        changed[1],
        changed[2],
        changed[3],
        changed[4],
        changed[7],
        changed[8],
      ]) {
        assert.strictEqual(
          (yield* rejects(transcript(authority), { manifest: authority, selection: 'full' })).kind,
          'Malformed',
        )
      }
    }),
)

it.effect(
  'retains ordinary multiline reason prose and fails closed on protocol-prefix collisions',
  () =>
    Effect.gen(function* () {
      const gap = transcript(manifest, { gap: 'UNSUPPORTED' })
      const prose = gap.replace(
        'missing capability\n',
        'missing capability\nadditional diagnostic detail\n',
      )
      const receipt = yield* read(expected, prose)
      assert.strictEqual(
        receipt.outcomes[2].detail,
        'GAP: missing capability\nadditional diagnostic detail',
      )
      for (const prefix of [
        'PASS observed',
        'Selfhost corpus: pass=2 fail=0 unsupported=1 track=1',
      ]) {
        const collision = gap.replace('missing capability\n', `missing capability\n${prefix}\n`)
        const failure = yield* rejects(collision)
        assert.strictEqual(failure.kind, 'Malformed')
        assert.strictEqual(failure.receipt, undefined)
      }
      for (const output of [
        gap.replace('Selfhost gap GAP: 1\n', ''),
        gap + 'Selfhost gap GAP: 1\n',
        gap.replace('Selfhost gap GAP: 1', 'Selfhost gap GAP: 0'),
        gap.replace('Selfhost gap GAP: 1', 'Selfhost gap GAP: 0.5'),
        transcript(manifest, { observed: 'FAIL' }).replace('Selfhost failure TEST: 1\n', ''),
      ])
        assert.strictEqual((yield* rejects(output)).kind, 'Malformed')
    }),
)
