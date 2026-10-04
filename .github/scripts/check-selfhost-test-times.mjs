import { readFileSync } from 'node:fs'

const [logPath] = process.argv.slice(2)
if (!logPath) {
  throw new Error('Expected a test runner log path')
}

const lines = readFileSync(logPath, 'utf8')
  .replaceAll(/\u001b\[[0-9;]*m/g, '')
  .split(/\r?\n/)
let pendingName
let measured = 0
const slow = []

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
  if (milliseconds >= 1000) slow.push(`${pendingName}: ${milliseconds} ms`)
  pendingName = undefined
}

if (measured === 0) {
  throw new Error('No per-test timings found in the test runner log')
}
if (slow.length > 0) {
  throw new Error(`Selfhost tests took 1 s or longer:\n${slow.join('\n')}`)
}
console.log(`All ${measured} selfhost tests finished under 1 s`)
