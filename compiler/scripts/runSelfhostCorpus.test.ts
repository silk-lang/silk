import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as assert from 'node:assert/strict'
import { it } from 'node:test'
import type { CorpusProgram } from '../../packages/compiler/test/support/corpus.js'
import { parseUnsupported, runCase, summarize } from './runSelfhostCorpus.js'

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

const compiled = `while [ "$1" != "-o" ]; do shift; done
output="$2"
printf '#!/bin/sh\\nexit 42\\n' > "$output"
chmod +x "$output"`

it('runs a pinned native corpus program through the build command', () => {
  withStub(compiled, (silkc) => {
    assert.deepStrictEqual(runCase(silkc, literal), { name: 'literal', status: 'pass' })
  })
})

it('classifies only a structured build gap as unsupported', () => {
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

it('keeps build and runtime regressions in the failure count', () => {
  withStub('echo "compiler crashed" >&2; exit 2', (silkc) => {
    const result = runCase(silkc, literal)
    assert.strictEqual(result.status, 'fail')
  })
  withStub(compiled.replace('exit 42', 'exit 41'), (silkc) => {
    const result = runCase(silkc, literal)
    assert.deepStrictEqual(result, {
      name: 'literal',
      status: 'fail',
      reason: 'run 1: exit: expected 42, got 41',
    })
  })
})

it('fails the gate only for cases on the ordered selfhost track', () => {
  const results = [
    { name: 'literal', status: 'pass' },
    { name: 'future', status: 'fail', reason: 'not ready' },
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
    gapCounts: [{ code: 'MIR_AGGREGATE', count: 1 }],
    trackFailures: [],
  })
  assert.deepStrictEqual(summarize(results, ['literal', 'later']).trackFailures, ['later'])
})

it('passes native run arguments and closes stderr when requested', () => {
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
