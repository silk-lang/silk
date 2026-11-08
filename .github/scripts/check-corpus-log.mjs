// Fails unless a corpus-full log ran at least one case and every case passed or is a known
// unsupported outcome, with no runtime mismatch, runner failure or module-source gap, and every
// program was fully borrow-checked: no build left a body unchecked (a SELFHOST_BORROW_GAP receipt
// with a nonzero total) and no invalid program was accepted only because its errors sat in an
// unchecked body (a SELFHOST_BORROW_CARRY receipt).
// usage: node check-corpus-log.mjs <corpus.log>
import { readFileSync } from 'node:fs'

const lines = readFileSync(process.argv[2], 'utf8').split(/\r?\n/)
const failures = lines.filter((line) => line.startsWith('FAIL '))
if (failures.length > 0) throw new Error(`Corpus failures:\n${failures.join('\n')}`)
if (lines.some((line) => /(?:code=RUNTIME_MISMATCH|code=CORPUS_RUNNER_FAILURE|module-source:)/.test(line)))
  throw new Error('Corpus runtime mismatch, runner failure, or module-source gap')
const unchecked = lines.filter(
  (line) =>
    line.startsWith('SELFHOST_BORROW_CARRY=') ||
    (line.startsWith('SELFHOST_BORROW_GAP=') && JSON.parse(line.slice('SELFHOST_BORROW_GAP='.length)).total !== 0),
)
if (unchecked.length > 0) throw new Error(`Bodies left without borrow checking:\n${unchecked.join('\n')}`)
if (!lines.some((line) => /^(?:PASS|UNSUPPORTED) /.test(line))) throw new Error('The corpus ran no case')
