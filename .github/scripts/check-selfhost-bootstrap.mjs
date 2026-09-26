import { execFileSync } from 'node:child_process'

const [base, head, main] = process.argv.slice(2)
if (!base || !head || !main) {
  process.stderr.write('usage: node check-selfhost-bootstrap.mjs <base> <head> <main>\n')
  process.exit(2)
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()
const isAncestor = (ancestor, descendant) => {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const guardedPaths = [
  'packages/',
  'scripts/',
  'config/',
  '.github/actions/setup-linux-llvm/',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'turbo.json',
  'tsconfig.base.json',
  '.npmrc',
  '.node-version',
]

const mainCommit = git('rev-parse', '--verify', `${main}^{commit}`)
const baseCommit = git('rev-parse', '--verify', `${base}^{commit}`)
const headCommit = git('rev-parse', '--verify', `${head}^{commit}`)
const forkPoint = git('merge-base', baseCommit, headCommit)

const commits = git('rev-list', '--reverse', `${forkPoint}..${headCommit}`)
  .split('\n')
  .filter(Boolean)
for (const commit of commits) {
  const [, firstParent, ...otherParents] = git('rev-list', '--parents', '-n', '1', commit).split(
    ' ',
  )
  if (!firstParent) continue

  const changed = git('diff', '--name-only', firstParent, commit, '--', ...guardedPaths)
  if (!changed || isAncestor(commit, mainCommit)) continue

  const mainParent = otherParents.find((parent) => isAncestor(parent, mainCommit))
  const isCleanMainSync =
    mainParent &&
    isAncestor(forkPoint, firstParent) &&
    !git('diff', '--name-only', mainParent, commit, '--', ...guardedPaths)
  const isCleanBaseSync = otherParents.some(
    (parent) =>
      isAncestor(parent, baseCommit) &&
      !git('diff', '--name-only', parent, commit, '--', ...guardedPaths),
  )
  if (isCleanMainSync || isCleanBaseSync) continue

  process.stderr.write(
    `Bootstrap inputs changed outside main-first synchronization in ${commit}:\n${changed}\n`,
  )
  process.stderr.write('Land the repair on main, then merge that main history into selfhost.\n')
  process.exit(1)
}

process.stdout.write(`Bootstrap provenance checked across ${commits.length} commit(s).\n`)
