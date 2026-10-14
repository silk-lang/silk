// Run with pnpm exec tsx; the checkpoint runner prints first-profile R3 receipts.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runCorpus } from '/home/user/silk/compiler/scripts/runSelfhostCorpus.ts'
import { nativeCorpus } from '/home/user/silk/packages/compiler/test/support/corpus.ts'

const [silkc, clang, concurrency = '4'] = process.argv.slice(2)
const jobs = Number(concurrency)
if (!silkc || !clang || !Number.isInteger(jobs) || jobs < 1) {
  console.error('Usage: tsx run-corpus.mjs SILKC CLANG [CONCURRENCY]')
  process.exit(2)
}
const required = JSON.parse(readFileSync('/home/user/silk/compiler/scripts/selfhost-track.json', 'utf8'))
if (!Array.isArray(required) || !required.every((entry) => typeof entry === 'string')) {
  throw new TypeError('selfhost-track.json must contain an array of program names')
}
process.env.SILKC_CLANG = resolve(clang)
console.log('Corpus programs', nativeCorpus.length, 'required pins', required.length)
const stdlib = '/home/user/silk/packages/compiler/stdlib'
process.exitCode = await runCorpus(resolve(silkc), nativeCorpus, required, undefined, stdlib, resolve(clang), jobs)
