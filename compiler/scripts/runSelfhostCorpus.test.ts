import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as assert from 'node:assert/strict'
import { it } from 'node:test'
import type { CorpusProgram } from '../../packages/compiler/test/support/corpus.js'
import {
  parseBuildDiagnostics,
  parseUnsupported,
  runCase,
  runCorpus,
  summarize,
} from './runSelfhostCorpus.js'

const literal: CorpusProgram = {
  name: 'literal',
  source: 'pub fn main() -> i32 { return 42 }',
  expected: { _tag: 'Completes', result: 42 },
}

const withStub = (body: string, run: (path: string) => void): void => {
  const directory = mkdtempSync(join(tmpdir(), 'silk-selfhost-stub-'))
  try {
    const path = join(directory, 'silkc')
    writeFileSync(path, `#!/bin/sh\n${body}\n`)
    chmodSync(path, 0o755)
    run(path)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

const compiled = `if [ "$5" != --stdlib ] || [ ! -f "$6/silk/i32.silk" ] || [ ! -f silk.toml ]; then exit 4; fi
case "$6" in */) exit 5;; esac
if [ "$1" != build ] || [ "$2" != main.silk ] || [ "$3" != -o ] || [ "$4" != program ]; then exit 3; fi
while [ "$1" != "-o" ]; do shift; done
output="$2"
printf '#!/bin/sh\\nexit 42\\n' > "$output"
chmod +x "$output"`

void it('runs a pinned native corpus program through the build command', () => {
  withStub(compiled, (silkc) => {
    assert.deepStrictEqual(runCase(silkc, literal), { name: 'literal', status: 'pass' })
    const profiled = {
      ...literal,
      nativeProfiles: [
        { name: 'debug', optimization: 'none', debug: true },
        { name: 'optimized', optimization: 'speed', debug: false },
      ],
    } as const
    withStub(
      `if [ "$7" != --optimization ] || [ "$9" != --debug ]; then exit 6; fi
printf '%s:%s\\n' "$8" "\${10}" >> "$0.profiles"
${compiled}`,
      (profileSilkc) => {
        assert.deepStrictEqual(runCase(profileSilkc, profiled), { name: 'literal', status: 'pass' })
        assert.strictEqual(
          readFileSync(`${profileSilkc}.profiles`, 'utf8'),
          'none:true\nspeed:false\n',
        )
      },
    )
  })
})

void it('declares compiled corpus C units and libraries as manifest link inputs', () => {
  const linked = {
    ...literal,
    nativeCSources: { fixture: 'int silk_fixture(void) { return 42; }\n' },
    nativeDynamicLibraries: ['custom'],
  }
  withStub(
    `[ -s fixture.o ] || exit 7
grep -qxF 'native-link-inputs = [{ object = "fixture.o" }, { library = "custom", mode = "dynamic" }]' silk.toml || exit 8
${compiled}`,
    (silkc) => {
      assert.deepStrictEqual(runCase(silkc, linked), { name: 'literal', status: 'pass' })
    },
  )
  withStub(`grep -q native-link-inputs silk.toml && exit 9\n${compiled}`, (silkc) => {
    assert.deepStrictEqual(runCase(silkc, literal), { name: 'literal', status: 'pass' })
  })
})

void it('requires the full track in supplied materialized scenarios', () => {
  withStub(compiled, (silkc) => {
    assert.throws(
      () => runCorpus(silkc, [literal], ['trivial-features', 'other']),
      /selfhost track names absent from corpus: trivial-features,/,
    )
  })
})

void it('classifies only a structured build gap as unsupported', () => {
  withStub(
    `echo 'SILK_UNSUPPORTED_JSON={"gaps":[{"code":"MIR_AGGREGATE","reason":"aggregates are not lowered"}]}' >&2
exit 2`,
    (silkc) => {
      assert.deepStrictEqual(runCase(silkc, literal), {
        name: 'literal',
        status: 'unsupported',
        gaps: [{ code: 'MIR_AGGREGATE', reason: 'aggregates are not lowered' }],
      })
    },
  )
  assert.strictEqual(parseUnsupported('SILK_UNSUPPORTED_JSON={"gaps":[]}'), undefined)
  assert.strictEqual(parseUnsupported('unsupported: aggregates'), undefined)
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

void it('keeps build and runtime regressions in the failure count', () => {
  withStub('echo "compiler crashed" >&2; exit 2', (silkc) => {
    const result = runCase(silkc, literal)
    assert.strictEqual(result.status, 'fail')
  })
  withStub(compiled.replace('exit 42', 'exit 41'), (silkc) => {
    const result = runCase(silkc, literal)
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
    { name: 'future', status: 'fail', code: 'UnknownName', diagnostics: [], reason: 'not ready' },
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
    failureCounts: [{ code: 'UnknownName', count: 1 }],
    gapCounts: [{ code: 'MIR_AGGREGATE', count: 1 }],
    trackFailures: [],
  })
  assert.deepStrictEqual(summarize(results, ['literal', 'later']).trackFailures, ['later'])
})

void it('passes native run arguments and closes stderr when requested', () => {
  const argumentAndStderrStub = `while [ "$1" != "-o" ]; do shift; done
output="$2"
cat > "$output" <<'SCRIPT'
#!/bin/sh
if [ "$#" -ne 2 ] || [ "$1" != one ] || [ "$2" != two ]; then exit 1; fi
if printf '' >&2; then exit 2; fi
exit 42
SCRIPT
chmod +x "$output"`
  withStub(argumentAndStderrStub, (silkc) => {
    const program: CorpusProgram = {
      ...literal,
      nativeRuns: [{ closeStderr: true, arguments: ['one', 'two'] }],
    }
    assert.strictEqual(runCase(silkc, program).status, 'pass')
    assert.strictEqual(
      runCase(silkc, { ...program, nativeRuns: [{ arguments: ['one', 'two'] }] }).status,
      'fail',
    )
    assert.strictEqual(
      runCase(silkc, { ...program, nativeRuns: [{ closeStderr: true }] }).status,
      'fail',
    )
  })
})

void it('retains build diagnostic codes and byte spans without turning rejections into gaps', () => {
  const record =
    'SILK_BUILD_ERROR={"code":"UnknownName","span":{"start":28,"end":34},"module":"main.silk"}'
  const other =
    'SILK_BUILD_ERROR={"code":"TypeMismatch","span":{"start":6,"end":9},"module":"silk/uri.silk"}'
  const gaps = 'SILK_UNSUPPORTED_JSON={"gaps":[{"code":"typed-form","reason":"not lowered"}]}'
  withStub(`echo '${record}' >&2; exit 1`, (silkc) => {
    const result = runCase(silkc, literal)
    assert.strictEqual(result.status, 'fail')
    if (result.status !== 'fail') throw new Error('expected rejection')
    assert.strictEqual(result.code, 'UnknownName')
    assert.deepStrictEqual(result.diagnostics, [
      { code: 'UnknownName', span: { start: 28, end: 34 }, module: 'main.silk' },
    ])
    assert.deepStrictEqual(summarize([result], []).failureCounts, [
      { code: 'UnknownName', count: 1 },
    ])
  })
  // A build walk prints every refusal beside the gaps it reached; gaps never hide a refusal.
  withStub(`printf '%s\\n' '${record}' '${other}' '${record}' '${gaps}' >&2; exit 1`, (silkc) => {
    const result = runCase(silkc, literal)
    assert.strictEqual(result.status, 'fail')
    if (result.status !== 'fail') throw new Error('expected rejection')
    assert.strictEqual(result.code, 'UnknownName')
    assert.deepStrictEqual(
      result.diagnostics.map((diagnostic) => diagnostic.code),
      ['UnknownName', 'TypeMismatch'],
    )
  })
  withStub(`echo '${gaps}' >&2; exit 1`, (silkc) => {
    assert.strictEqual(runCase(silkc, literal).status, 'unsupported')
  })
  assert.strictEqual(parseBuildDiagnostics('unsupported: aggregates'), undefined)
  assert.strictEqual(
    parseBuildDiagnostics(
      `${record}\nSILK_BUILD_ERROR={"code":"UnknownName","span":{"start":34,"end":28},"module":"main.silk"}`,
    ),
    undefined,
  )
  assert.strictEqual(parseBuildDiagnostics('SILK_BUILD_ERROR=semantic-rejection'), undefined)
  assert.strictEqual(
    parseBuildDiagnostics('SILK_BUILD_ERROR={"code":"UnknownName","span":{"start":28,"end":34}}'),
    undefined,
  )
})
