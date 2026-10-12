// Applies the native seed retention rule from compiler/docs/native-seed-chain.md to the
// `native-seed-<commit>` prereleases. Keeps the release named by the current `selfhost` pin, every
// release named by a pin in effect during the last 30 days of `selfhost` history, and the 20 newest
// candidates. Prints a Markdown report of everything else; deletes it only with --delete.
import { execFileSync } from 'node:child_process'

const usage = 'usage: node prune-native-seeds.mjs <repository> <selfhost-ref> [--delete]\n'
const [repository, ref, ...flags] = process.argv.slice(2)
if (!repository || !ref || flags.some((flag) => flag !== '--delete')) {
  process.stderr.write(usage)
  process.exit(2)
}
const remove = flags.includes('--delete')
const windowDays = 30
const newest = 20
const pinPath = 'compiler/native-seed.json'
const candidateTag = /^native-seed-[a-f0-9]{40}$/

const run = (command, args) => execFileSync(command, args, { encoding: 'utf8' }).trim()
const lines = (text) => text.split('\n').filter(Boolean)

// A historical pin may predate the Release-only shape; only a release tag names a seed.
const pinnedTag = (commit) => {
  try {
    const tag = JSON.parse(run('git', ['show', `${commit}:${pinPath}`])).seed?.tag
    return typeof tag === 'string' && candidateTag.test(tag) ? tag : undefined
  } catch {
    return undefined
  }
}

const since = `${windowDays}.days.ago`
const current = pinnedTag(ref)
if (!current) {
  process.stderr.write(`${ref}:${pinPath} names no native seed release\n`)
  process.exit(1)
}
// Pins in effect during the window: the one in effect when it opened, then every later change.
const opening = lines(run('git', ['rev-list', '-1', `--before=${since}`, ref]))
const changes = lines(run('git', ['rev-list', `--since=${since}`, ref, '--', pinPath]))
const windowPins = new Set(
  [...opening, ...changes].map(pinnedTag).filter((tag) => tag !== undefined),
)

const releases = lines(
  run('gh', [
    'api',
    '--paginate',
    `repos/${repository}/releases`,
    '--jq',
    '.[] | select(.prerelease) | [.tag_name, .created_at] | @tsv',
  ]),
)
  .map((line) => {
    const [tag, created] = line.split('\t')
    return { tag, created }
  })
  .filter(({ tag }) => candidateTag.test(tag))
  .sort((a, b) => b.created.localeCompare(a.created))

const reasons = new Map()
const keep = (tag, reason) => reasons.set(tag, [...(reasons.get(tag) ?? []), reason])
for (const { tag } of releases.slice(0, newest)) keep(tag, `${newest} newest`)
for (const tag of windowPins) keep(tag, `pinned within ${windowDays} days`)
keep(current, 'current pin')

const published = new Set(releases.map(({ tag }) => tag))
const missing = [...reasons.keys()].filter((tag) => !published.has(tag))
const pruned = releases.filter(({ tag }) => !reasons.has(tag))

const decision = (tag) => {
  if (reasons.has(tag)) return `keep: ${reasons.get(tag).join(', ')}`
  return remove ? 'delete' : 'would delete'
}
const report = [
  `### Native seed retention${remove ? '' : ' (dry run)'}`,
  '',
  `${releases.length} candidates; keeping ${releases.length - pruned.length}, ${remove ? 'deleting' : 'would delete'} ${pruned.length}. Current pin: \`${current}\`.`,
  '',
  '| Release | Created | Decision |',
  '| --- | --- | --- |',
  ...releases.map(({ tag, created }) => `| \`${tag}\` | ${created} | ${decision(tag)} |`),
  ...missing.map((tag) => `| \`${tag}\` | missing | kept tag names no published release |`),
  '',
].join('\n')
process.stdout.write(report)

// The current pin must name a published release; otherwise the listing is wrong, so delete nothing.
// An older window pin may name a release already pruned by hand; that is only reported.
if (!published.has(current)) {
  process.stderr.write(`The current pin ${current} names no published release\n`)
  process.exit(1)
}
if (remove)
  for (const { tag } of pruned)
    run('gh', ['release', 'delete', tag, '--repo', repository, '--yes', '--cleanup-tag'])
