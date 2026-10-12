// Holds the bodies native borrow checking leaves unchecked to compiler/borrow-check-gap.json.
//
//   check-borrow-gap.mjs corpus <corpus log>
//     Sums the corpus runner's SELFHOST_BORROW_GAP receipts per reason. Any reason above its
//     baseline fails; a reason below it is reported so the baseline can be lowered.
//   check-borrow-gap.mjs self-build <receipt directory>
//     Prints every SILK_GAP borrow-check line the self-build stages wrote, as a receipt.
//
// A retired reason must be zero everywhere: in either mode, any body unchecked for a retired reason
// fails. The self-build totals grow with the compiler, so they are printed, never compared.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const [mode, input] = process.argv.slice(2)
const baseline = JSON.parse(
  readFileSync(new URL('../../compiler/borrow-check-gap.json', import.meta.url), 'utf8'),
)
const retired = new Set(baseline.retired)
const gapPrefix = 'SILK_GAP borrow-check: '
const receiptPrefix = 'SELFHOST_BORROW_GAP='

const parseGap = (line) => {
  const match = /^(\d+) bodies not borrow-checked \(([^)]*)\)$/.exec(line.slice(gapPrefix.length))
  if (match === null) throw new Error(`Malformed borrow-check gap line: ${line}`)
  const reasons = {}
  for (const part of match[2].split(';', 1)[0].split(', ')) {
    const reason = /^([a-z-]+) (\d+)$/.exec(part)
    if (reason !== null) reasons[reason[1]] = Number(reason[2])
  }
  return { total: Number(match[1]), reasons }
}

const failures = []
const checkRetired = (where, reasons) => {
  for (const [reason, count] of Object.entries(reasons))
    if (retired.has(reason) && count > 0)
      failures.push(`${where}: ${count} bodies unchecked for retired reason ${reason}`)
}

if (mode === 'corpus') {
  const totals = {}
  for (const line of readFileSync(input, 'utf8').split('\n')) {
    if (!line.startsWith(receiptPrefix)) continue
    const receipt = JSON.parse(line.slice(receiptPrefix.length))
    checkRetired(receipt.name, receipt.reasons)
    for (const [reason, count] of Object.entries(receipt.reasons))
      totals[reason] = (totals[reason] ?? 0) + count
  }
  const reasons = [...new Set([...Object.keys(baseline.corpus), ...Object.keys(totals)])].sort()
  for (const reason of reasons) {
    const expected = baseline.corpus[reason] ?? 0
    const actual = totals[reason] ?? 0
    console.log(`borrow-check ${reason}: ${actual} (baseline ${expected})`)
    if (actual > expected)
      failures.push(`corpus: ${reason} rose from ${expected} to ${actual} unchecked bodies`)
    else if (actual < expected)
      console.log(
        `::notice title=Borrow-check gap fell::${reason} fell from ${expected} to ${actual}; lower compiler/borrow-check-gap.json`,
      )
  }
} else if (mode === 'self-build') {
  for (const name of readdirSync(input).filter((file) => file.endsWith('-stderr.bin')).sort()) {
    for (const line of readFileSync(join(input, name), 'utf8').split('\n')) {
      if (!line.startsWith(gapPrefix)) continue
      console.log(`${name}: ${line}`)
      checkRetired(name, parseGap(line).reasons)
    }
  }
} else {
  throw new Error('Usage: check-borrow-gap.mjs corpus <log> | self-build <directory>')
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`::error title=Borrow-check gap::${failure}`)
  process.exit(1)
}
