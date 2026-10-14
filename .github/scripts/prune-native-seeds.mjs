// Releases are indivisible. Retain the union of every target's pinned history and 20 newest
// candidates containing that target's asset. Reporting only: this script cannot delete releases.
import { execFileSync } from 'node:child_process'
import { historicalSeeds } from './native-seed-history.mjs'
import * as NativeSeedRetention from './native-seed-retention.mjs'

const [repository, ref, ...extra] = process.argv.slice(2)
if (!repository || !ref || extra.length > 0) {
  process.stderr.write('usage: node prune-native-seeds.mjs <repository> <selfhost-ref>\n')
  process.exit(2)
}
const newest = 20
const targets = ['x86_64-unknown-linux-gnu', 'aarch64-unknown-linux-gnu', 'aarch64-apple-darwin']
const pinPath = 'compiler/native-seed.json'
const candidateTag = /^native-seed-[a-f0-9]{40}$/
const run = (command, args) => execFileSync(command, args, { encoding: 'utf8' }).trim()
const lines = (text) => text.split('\n').filter(Boolean)
const currentPin = JSON.parse(run('git', ['show', `${ref}:${pinPath}`]))
if (currentPin.schemaVersion !== 2 || Object.keys(currentPin.seeds).length === 0) {
  process.stderr.write(`${ref}:${pinPath} must name per-target native seed releases\n`)
  process.exit(1)
}
const current = Object.entries(currentPin.seeds)
for (const [target, seed] of current) {
  if (
    !targets.includes(target) ||
    seed.target !== target ||
    !candidateTag.test(seed.tag) ||
    seed.tag !== `native-seed-${seed.sourceCommit}` ||
    seed.asset !== `silk-compiler-${target}`
  ) {
    process.stderr.write(`Invalid current native seed for ${target}\n`)
    process.exit(1)
  }
}
const historyPins = new Map(targets.map((target) => [target, new Set()]))
// Only absent pre-pin files are ignored; malformed history and failed Git commands fail the report.
for (const commit of lines(run('git', ['rev-list', ref, '--', pinPath]))) {
  const paths = run('git', ['ls-tree', '--name-only', commit, '--', pinPath])
  if (!paths) continue
  const pin = JSON.parse(run('git', ['show', `${commit}:${pinPath}`]))
  for (const seed of historicalSeeds(pin)) {
    if (candidateTag.test(seed.tag) && historyPins.has(seed.target))
      historyPins.get(seed.target).add(seed.tag)
  }
}
const releases = lines(
  run('gh', [
    'api',
    '--paginate',
    `repos/${repository}/releases`,
    '--jq',
    '.[] | select(.prerelease) | {tag: .tag_name, created: .created_at, assets: [.assets[].name]} | @json',
  ]),
)
  .map((line) => JSON.parse(line))
  .filter(({ tag }) => candidateTag.test(tag))
  .sort((a, b) => b.created.localeCompare(a.created))
const reasons = NativeSeedRetention.reasons(releases, historyPins, current, newest)
const published = new Map(releases.map((release) => [release.tag, release]))
const missing = [...reasons.keys()].filter((tag) => !published.has(tag))
const pruned = releases.filter(({ tag }) => !reasons.has(tag))
const report = [
  '### Native seed retention (report only)',
  '',
  `${releases.length} candidates; keeping ${releases.length - pruned.length}, would delete ${pruned.length}.`,
  '',
  ...targets.map(
    (target) =>
      `- ${target}: current pin ${currentPin.seeds[target] ? `\`${currentPin.seeds[target].tag}\`` : 'not yet pinned'}.`,
  ),
  '',
  '| Release | Created | Targets | Decision |',
  '| --- | --- | --- | --- |',
  ...releases.map(
    ({ tag, created, assets }) =>
      `| \`${tag}\` | ${created} | ${targets.filter((target) => assets.includes(`silk-compiler-${target}`)).join(', ')} | ${reasons.has(tag) ? `keep: ${reasons.get(tag).join('; ')}` : 'would delete'} |`,
  ),
  ...missing.map((tag) => `| \`${tag}\` | missing | | kept tag names no published release |`),
  '',
].join('\n')
process.stdout.write(report)
// Every active target's asset must exist, not merely its release tag.
for (const [target, seed] of current) {
  if (!published.get(seed.tag)?.assets.includes(seed.asset)) {
    process.stderr.write(`The current ${target} pin ${seed.tag} names no published seed asset\n`)
    process.exitCode = 1
  }
}
