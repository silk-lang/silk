import { readFileSync } from 'node:fs'

const [logPath] = process.argv.slice(2)
if (!logPath) {
  throw new Error('Expected a test runner log path')
}

const lines = readFileSync(logPath, 'utf8')
  .replaceAll(/\u001b\[[0-9;]*m/g, '')
  .split(/\r?\n/)
// Tests should finish within 1 s; the failing limit leaves headroom so runner noise near the
// target does not fail CI.
const targetMs = 1000
const limitMs = 2000
let pendingName
let measured = 0
const slow = []
const overTarget = []

for (const line of lines) {
  const name = /^\s+([^\s]+::[^\s]+)\s*$/.exec(line)
  if (name) {
    pendingName = name[1]
    continue
  }
  const result = /^\s+(?:PASS|FAIL)\s+(\d+)\s+(ms|us)\s*$/.exec(line)
  if (!result || !pendingName) continue
  const milliseconds = result[2] === 'us' ? Number(result[1]) / 1000 : Number(result[1])
  measured += 1
  if (milliseconds >= limitMs) slow.push(`${pendingName}: ${milliseconds} ms`)
  else if (milliseconds >= targetMs) overTarget.push(`${pendingName}: ${milliseconds} ms`)
  pendingName = undefined
}

if (measured === 0) {
  throw new Error('No per-test timings found in the test runner log')
}
for (const line of overTarget) console.warn(`::warning::Selfhost test over the 1 s target: ${line}`)
if (slow.length > 0) {
  throw new Error(`Selfhost tests took 2 s or longer:\n${slow.join('\n')}`)
}
console.log(`All ${measured} selfhost tests finished under 2 s (${overTarget.length} over the 1 s target)`)
