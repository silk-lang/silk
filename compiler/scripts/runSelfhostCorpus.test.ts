import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as assert from 'node:assert/strict'
import { it } from 'node:test'
import type * as Corpus from '../../corpus/corpus.mjs'
import {
  parseBorrowGap,
  parseBuildDiagnostics,
  parseUnsupported,
  runCase,
  runCorpus,
  summarize,
} from './runSelfhostCorpus.js'

const literal: Corpus.Program = {
  name: 'literal',
  source: 'pub fn main() -> i32 { return 42 }',
  reference: undefined,
  imports: {},
  cSources: {},
  stdout: undefined,
  stderr: undefined,
  outcome: { schemaVersion: 1, expected: { kind: 'completes', exitCode: 42 } },
}

const withOutcome = (
  fields: Omit<Corpus.Outcome, 'schemaVersion' | 'expected'>,
): Corpus.Program => ({
  ...literal,
  outcome: { ...literal.outcome, ...fields },
})

const withStub = async (body: string, run: (path: string) => Promise<void>): Promise<void> => {
  const directory = mkdtempSync(join(tmpdir(), 'silk-selfhost-stub-'))
  try {
    const path = join(directory, 'silkc')
    writeFileSync(path, `#!/bin/sh\n${body}\n`)
    chmodSync(path, 0o755)
    await run(path)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

const compiled = `if [ "$5" != --stdlib ] || [ ! -f "$6/silk/num/i32.silk" ] || ! grep -qxF 'version = "0.1.0"' silk.toml; then exit 4; fi
case "$6" in */) exit 5;; esac
if [ "$1" != build ] || [ "$2" != memory/driver.silk ] || [ ! -f memory/driver.silk ] || [ "$3" != -o ] || [ "$4" != program ]; then exit 3; fi
while [ "$1" != "-o" ]; do shift; done
output="$2"
printf '#!/bin/sh\\nexit 42\\n' > "$output"
chmod +x "$output"`

void it('runs a pinned native corpus program through the build command', async () => {
  await withStub(compiled, async (silkc) => {
    assert.deepStrictEqual(await runCase(silkc, literal), { name: 'literal', status: 'pass' })
    const profiled = withOutcome({
      profiles: [
        { name: 'debug', optimization: 'none', debug: true },
        { name: 'optimized', optimization: 'speed', debug: false },
      ],
    })
    await withStub(
      `if [ "$7" != --optimization ] || [ "$9" != --debug ]; then exit 6; fi
printf '%s:%s\\n' "$8" "\${10}" >> "$0.profiles"
${compiled}`,
      async (profileSilkc) => {
        assert.deepStrictEqual(await runCase(profileSilkc, profiled), {
          name: 'literal',
          status: 'pass',
        })
        assert.strictEqual(
          readFileSync(`${profileSilkc}.profiles`, 'utf8'),
          'none:true\nspeed:false\n',
        )
      },
    )
  })
})

void it('declares compiled corpus C units and libraries as manifest link inputs', async () => {
  const linked: Corpus.Program = {
    ...withOutcome({ dynamicLibraries: ['custom'] }),
    cSources: { fixture: 'int silk_fixture(void) { return 42; }\n' },
  }
  await withStub(
    `[ -s fixture.o ] || exit 7
grep -qxF 'link = [{ object = "fixture.o" }, { library = "custom", mode = "dynamic" }]' silk.toml || exit 8
${compiled}`,
    async (silkc) => {
      assert.deepStrictEqual(await runCase(silkc, linked), { name: 'literal', status: 'pass' })
    },
  )
  await withStub(`grep -q '^link = ' silk.toml && exit 9\n${compiled}`, async (silkc) => {
    assert.deepStrictEqual(await runCase(silkc, literal), { name: 'literal', status: 'pass' })
  })
})

void it('supplies corpus runtime components as the host default composition', async () => {
  const composed: Corpus.Program = {
    ...withOutcome({
      components: [
        {
          capability: 'execution-storage',
          bindings: [{ operation: 'acquire', module: 'test/refusing', declaration: 'refuse' }],
        },
      ],
    }),
    imports: { 'test/refusing': 'pub fn refuse() -> i32 { return 0 }' },
  }
  await withStub(
    `[ -f test/refusing.silk ] || exit 7
grep -qxF 'composition = { runtimes = [{ name = "hosted", module = "silk/platform/native/start" }], defaults = ["hosted"], retention = [], requirements = [], components = [{ capability = "execution-storage", bindings = [{ operation = "acquire", module = "test/refusing", declaration = "refuse" }] }] }' silk.toml || exit 8
${compiled}`,
    async (silkc) => {
      assert.deepStrictEqual(await runCase(silkc, composed), { name: 'literal', status: 'pass' })
    },
  )
  await withStub(`grep -q composition silk.toml && exit 9\n${compiled}`, async (silkc) => {
    assert.deepStrictEqual(await runCase(silkc, literal), { name: 'literal', status: 'pass' })
  })
})

void it('requires the full track in supplied materialized scenarios', async () => {
  await withStub(compiled, async (silkc) => {
    await assert.rejects(
      () => runCorpus(silkc, [literal], ['trivial-features', 'other']),
      /selfhost track names absent from corpus: trivial-features,/,
    )
  })
})

void it('reports concurrent cases in corpus order', async (context) => {
  // The first case builds slowest, so the cases finish in reverse order.
  const programs = ['0.2', '0.1', '0'].map((delay, index) => ({
    ...literal,
    name: `case-${index}`,
    source: delay,
  }))
  // The test runner reports through the same stream, in buffers; the corpus log writes strings.
  const lines: string[] = []
  const write = process.stdout.write.bind(process.stdout)
  context.mock.method(process.stdout, 'write', (chunk: string | Uint8Array) =>
    typeof chunk === 'string' ? lines.push(chunk) > 0 : write(chunk),
  )
  await withStub(`sleep "$(cat memory/driver.silk)"\n${compiled}`, async (silkc) => {
    assert.strictEqual(
      await runCorpus(silkc, programs, ['case-1'], undefined, undefined, undefined, 3),
      0,
    )
  })
  context.mock.restoreAll()
  assert.deepStrictEqual(
    lines.map((line) => line.replace(/"elapsedMs":\d+/, '"elapsedMs":0')),
    [
      ...programs.map(({ name }) => `SELFHOST_CASE_TIMING={"name":"${name}","elapsedMs":0}\n`),
      ...programs.map(({ name }) => `PASS ${name}\n`),
      'Selfhost corpus: pass=3 fail=0 unsupported=0 track=1\n',
    ],
  )
})

void it('classifies only a structured build gap as unsupported', async () => {
  await withStub(
    `echo 'SILK_UNSUPPORTED_JSON={"gaps":[{"code":"MIR_AGGREGATE","reason":"aggregates are not lowered"}]}' >&2
exit 2`,
    async (silkc) => {
      assert.deepStrictEqual(await runCase(silkc, literal), {
        name: 'literal',
        status: 'unsupported',
        gaps: [{ code: 'MIR_AGGREGATE', reason: 'aggregates are not lowered' }],
      })
    },
  )
  assert.strictEqual(parseUnsupported('SILK_UNSUPPORTED_JSON={"gaps":[]}'), undefined)
  assert.strictEqual(parseUnsupported('unsupported: aggregates'), undefined)
})

void it('records the per-reason borrow-check gap of a successful build', async () => {
  assert.deepStrictEqual(
    parseBorrowGap(
      'SILK_GAP borrow-check: 3 bodies not borrow-checked (awaiting 3; native borrow checking is roadmap step 14)\n',
    ),
    { total: 3, reasons: { awaiting: 3 } },
  )
  assert.deepStrictEqual(
    parseBorrowGap(
      'SILK_GAP borrow-check: 4 bodies not borrow-checked (native borrow checking is roadmap step 14)',
    ),
    { total: 4, reasons: {} },
  )
  assert.strictEqual(parseBorrowGap('SILK_GAP test-result-cache: off'), undefined)
  assert.throws(() => parseBorrowGap('SILK_GAP borrow-check: many'))
  await withStub(
    `test "$SILK_RECEIPTS" = 1 && echo 'SILK_GAP borrow-check: 1 bodies not borrow-checked (captures 1; native borrow checking is roadmap step 14)' >&2
${compiled}`,
    async (silkc) => {
      assert.deepStrictEqual(await runCase(silkc, literal), {
        name: 'literal',
        status: 'pass',
        borrowGap: { total: 1, reasons: { captures: 1 } },
      })
    },
  )
})

void it('retains exact gap source locations and rejects malformed location records', () => {
  const gap = {
    code: 'typed-form',
    reason: 'deferred valid form',
    source: { module: 'silk/option.silk', span: { start: 12, end: 27 } },
  }
  const encode = (value: unknown): string =>
    `SILK_UNSUPPORTED_JSON=${JSON.stringify({ gaps: [value] })}`
  assert.deepStrictEqual(parseUnsupported(encode(gap)), [gap])
  for (const span of [
    { start: -1, end: 27 },
    { start: 27, end: 12 },
    { start: 12.5, end: 27 },
    { start: 12, end: '27' },
  ]) {
    assert.strictEqual(
      parseUnsupported(encode({ ...gap, source: { module: 'silk/option.silk', span } })),
      undefined,
    )
  }
  assert.strictEqual(
    parseUnsupported(encode({ ...gap, source: { module: '', span: gap.source.span } })),
    undefined,
  )
})

void it('keeps build and runtime regressions in the failure count', async () => {
  await withStub('echo "compiler crashed" >&2; exit 2', async (silkc) => {
    const result = await runCase(silkc, literal)
    assert.strictEqual(result.status, 'fail')
  })
  await withStub(compiled.replace('exit 42', 'exit 41'), async (silkc) => {
    const result = await runCase(silkc, literal)
    assert.deepStrictEqual(result, {
      name: 'literal',
      status: 'fail',
      code: 'RUNTIME_MISMATCH',
      diagnostics: [],
      reason: 'profile optimized: run 1: exit: expected 42, got 41',
    })
  })
})

void it('fails the gate only for cases on the ordered selfhost track', () => {
  const results = [
    { name: 'literal', status: 'pass' },
    { name: 'future', status: 'fail', code: 'SEM0006', diagnostics: [], reason: 'not ready' },
    {
      name: 'later',
      status: 'unsupported',
      gaps: [{ code: 'MIR_AGGREGATE', reason: 'aggregates are not lowered' }],
    },
  ] as const
  assert.deepStrictEqual(summarize(results, ['literal']), {
    pass: 1,
    fail: 1,
    unsupported: 1,
    failureCounts: [{ code: 'SEM0006', count: 1 }],
    gapCounts: [{ code: 'MIR_AGGREGATE', count: 1 }],
    trackFailures: [],
  })
  assert.deepStrictEqual(summarize(results, ['literal', 'later']).trackFailures, ['later'])
})

void it('passes native run arguments and closes stderr when requested', async () => {
  const argumentAndStderrStub = `while [ "$1" != "-o" ]; do shift; done
output="$2"
cat > "$output" <<'SCRIPT'
#!/bin/sh
if [ "$#" -ne 2 ] || [ "$1" != one ] || [ "$2" != two ]; then exit 1; fi
if printf '' >&2; then exit 2; fi
exit 42
SCRIPT
chmod +x "$output"`
  await withStub(argumentAndStderrStub, async (silkc) => {
    const program = withOutcome({ runs: [{ closeStderr: true, arguments: ['one', 'two'] }] })
    assert.strictEqual((await runCase(silkc, program)).status, 'pass')
    assert.strictEqual(
      (await runCase(silkc, withOutcome({ runs: [{ arguments: ['one', 'two'] }] }))).status,
      'fail',
    )
    assert.strictEqual(
      (await runCase(silkc, withOutcome({ runs: [{ closeStderr: true }] }))).status,
      'fail',
    )
  })
})

void it('retains build diagnostic codes and byte spans without turning rejections into gaps', async () => {
  const record =
    'SILK_BUILD_ERROR={"code":"SEM0006","span":{"start":28,"end":34},"module":"main.silk"}'
  const other =
    'SILK_BUILD_ERROR={"code":"SEM0012","span":{"start":6,"end":9},"module":"silk/uri/uri.silk"}'
  const gaps = 'SILK_UNSUPPORTED_JSON={"gaps":[{"code":"typed-form","reason":"not lowered"}]}'
  await withStub(`echo '${record}' >&2; exit 1`, async (silkc) => {
    const result = await runCase(silkc, literal)
    assert.strictEqual(result.status, 'fail')
    if (result.status !== 'fail') throw new Error('expected rejection')
    assert.strictEqual(result.code, 'SEM0006')
    assert.deepStrictEqual(result.diagnostics, [
      { code: 'SEM0006', span: { start: 28, end: 34 }, module: 'main.silk' },
    ])
    assert.deepStrictEqual(summarize([result], []).failureCounts, [{ code: 'SEM0006', count: 1 }])
  })
  // A build walk prints every refusal beside the gaps it reached; gaps never hide a refusal.
  await withStub(
    `printf '%s\\n' '${record}' '${other}' '${record}' '${gaps}' >&2; exit 1`,
    async (silkc) => {
      const result = await runCase(silkc, literal)
      assert.strictEqual(result.status, 'fail')
      if (result.status !== 'fail') throw new Error('expected rejection')
      assert.strictEqual(result.code, 'SEM0006')
      assert.deepStrictEqual(
        result.diagnostics.map((diagnostic) => diagnostic.code),
        ['SEM0006', 'SEM0012'],
      )
    },
  )
  await withStub(`echo '${gaps}' >&2; exit 1`, async (silkc) => {
    assert.strictEqual((await runCase(silkc, literal)).status, 'unsupported')
  })
  assert.strictEqual(parseBuildDiagnostics('unsupported: aggregates'), undefined)
  assert.strictEqual(
    parseBuildDiagnostics(
      `${record}\nSILK_BUILD_ERROR={"code":"SEM0006","span":{"start":34,"end":28},"module":"main.silk"}`,
    ),
    undefined,
  )
  assert.strictEqual(parseBuildDiagnostics('SILK_BUILD_ERROR=semantic-rejection'), undefined)
  assert.strictEqual(
    parseBuildDiagnostics('SILK_BUILD_ERROR={"code":"SEM0006","span":{"start":28,"end":34}}'),
    undefined,
  )
})

void it('keeps uncoded refusal reasons separate from catalog diagnostics', () => {
  const gap = {
    code: 'StaticRecursionNotProven',
    reason: 'Not supported by this compiler yet: StaticRecursionNotProven',
    source: { module: 'main.silk', span: { start: 1, end: 4 } },
  }
  const record = `SILK_UNSUPPORTED_JSON=${JSON.stringify({ gaps: [gap] })}`
  const backend = { code: 'typed-form', reason: 'Not supported by this compiler yet: typed-form' }
  assert.deepStrictEqual(
    parseUnsupported(
      `${record}\n${record}\nSILK_UNSUPPORTED_JSON=${JSON.stringify({ gaps: [backend] })}`,
    ),
    [gap, backend],
  )
  assert.strictEqual(parseUnsupported(`${record}\nSILK_UNSUPPORTED_JSON=invalid`), undefined)
  assert.strictEqual(
    parseUnsupported(
      `SILK_UNSUPPORTED_JSON=${JSON.stringify({ gaps: [{ ...gap, code: 'SEM0006' }] })}`,
    ),
    undefined,
  )
  assert.strictEqual(
    parseBuildDiagnostics(
      'SILK_BUILD_ERROR={"code":"UnknownName","span":{"start":1,"end":4},"module":"main.silk"}',
    ),
    undefined,
  )
  assert.strictEqual(
    parseBuildDiagnostics(
      'Internal compiler error: MissingRetainedFact; this is a compiler bug, please report',
    ),
    undefined,
  )
})

void it('checks a rejected program against its exact diagnostics', async () => {
  const rejected: Corpus.Program = {
    ...literal,
    name: 'rejected',
    source: 'fn f() -> i32 { return true }\npub fn main() -> i32 { return 0 }',
    outcome: {
      schemaVersion: 1,
      expected: { kind: 'rejected', diagnostics: [{ code: 'SEM0001', span: '1:24-1:28' }] },
    },
  }
  const reporting = (records: string) =>
    `if [ "$1" != build ] || [ "$2" != memory/driver.silk ] || [ "$5" != --stdlib ]; then exit 3; fi
printf '${records}' >&2
exit 1`
  const error = (code: string, start: number, end: number) =>
    `SILK_BUILD_ERROR={"code":"${code}","span":{"start":${start},"end":${end}},"module":"memory/driver.silk"}\\n`
  await withStub(reporting(error('SEM0001', 23, 27)), async (silkc) => {
    assert.deepStrictEqual(await runCase(silkc, rejected), { name: 'rejected', status: 'pass' })
  })
  // A rejection with any other list stays rejected: a parity gap, not a failure.
  await withStub(
    reporting(`${error('SEM0001', 23, 27)}${error('SEM0002', 30, 32)}`),
    async (silkc) => {
      const result = await runCase(silkc, rejected)
      assert.strictEqual(result.status, 'unsupported')
      assert.deepStrictEqual(
        result.status === 'unsupported' ? result.gaps.map((gap) => gap.code) : [],
        ['DIAGNOSTIC_PARITY'],
      )
    },
  )
  await withStub(reporting(error('SEM0001', 22, 27)), async (silkc) => {
    assert.strictEqual((await runCase(silkc, rejected)).status, 'unsupported')
  })
  await withStub(compiled, async (silkc) => {
    const result = await runCase(silkc, rejected)
    assert.strictEqual(result.status, 'fail')
    assert.strictEqual(result.status === 'fail' ? result.code : '', 'ACCEPTED_INVALID')
  })
  // An acceptance claims nothing only where the build left the offending body unchecked: inside
  // that body's block, with a code the build lists for it. `f`'s block is bytes 25-43 and `main`'s
  // 65-77; the stub lists the loan-liveness and region codes.
  const borrowing = (code: string, span: string): Corpus.Program => ({
    ...literal,
    name: 'borrowing',
    source: 'fn f(value: &i32) -> i32 { return value.* }\npub fn main() -> i32 { return 0 }',
    outcome: { schemaVersion: 1, expected: { kind: 'rejected', diagnostics: [{ code, span }] } },
  })
  const inBlock = borrowing('OWN0011', '1:35-1:42')
  const body = (module: string, start: number, end: number) =>
    `SILK_GAP borrow-check body: ${module} ${start}-${end} regions OWN0019,OWN0010,OWN0011,SEM0212\\n`
  for (const [program, bodies, expected] of [
    [inBlock, '', 'ACCEPTED_INVALID'],
    [inBlock, body('memory/driver.silk', 25, 43), 'BORROW_CHECK_GAP'],
    // A checked offending body next to an unchecked helper is a hole, not a gap.
    [inBlock, body('memory/driver.silk', 65, 77), 'ACCEPTED_INVALID'],
    [inBlock, body('other/module.silk', 25, 43), 'ACCEPTED_INVALID'],
    // A code the build does not list, such as a typing or move code, and a diagnostic in the
    // header, came from checkers that ran.
    [borrowing('SEM0001', '1:35-1:42'), body('memory/driver.silk', 25, 43), 'ACCEPTED_INVALID'],
    [borrowing('OWN0003', '1:35-1:42'), body('memory/driver.silk', 25, 43), 'ACCEPTED_INVALID'],
    [borrowing('SEM0212', '1:35-1:42'), body('memory/driver.silk', 25, 43), 'BORROW_CHECK_GAP'],
    // A body whose checks left nothing open lists no codes, so it carries nothing.
    [
      inBlock,
      'SILK_GAP borrow-check body: memory/driver.silk 25-43 regions -\\n',
      'ACCEPTED_INVALID',
    ],
    [borrowing('OWN0011', '1:6-1:11'), body('memory/driver.silk', 25, 43), 'ACCEPTED_INVALID'],
  ] as const)
    await withStub(`printf '${bodies}' >&2\n${compiled}`, async (silkc) => {
      const result = await runCase(silkc, program)
      if (result.status === 'pass') assert.fail('an accepted invalid program cannot pass')
      assert.strictEqual(
        result.status === 'fail' ? result.code : result.gaps.map((gap) => gap.code).join(),
        expected,
      )
    })
})
