// GitHub transport and durable orchestration only. Silk owns all version/change semantics.
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Schema from 'effect/Schema'
import * as Console from 'effect/Console'
import * as NativeProcess from './NativeProcess.ts'
import { hash, verifySnapshot } from './SourceSnapshot.mjs'

export class CompilerReleaseError extends Data.TaggedError('CompilerReleaseError') {}
const invalid = (message) => Effect.fail(new CompilerReleaseError({ reason: 'Conflict', message }))
export const managedBranch = 'release/compiler-stable'
export const managedMarker = '<!-- silk-managed-stable-release -->'
// GitHub rejects a release body over 125000 characters with HTTP 422. Prerelease notes collect every
// change since the last stable release, so they can outgrow it; the body then keeps the leading
// whole lines and links to the full pending changes at the release commit.
export const releaseBodyLimit = 125000
// Every release body opens with the commands that install exactly that release.
export const releaseInstall = (repository, metadata) => {
  const raw = `https://raw.githubusercontent.com/${repository}/main`
  const download = `https://github.com/${repository}/releases/download/${encodeURIComponent(metadata.tag)}`
  return [
    '## Install',
    '',
    'macOS (Apple silicon) and Linux (x86-64, ARM64):',
    '',
    '```sh',
    `curl -fsSL ${raw}/install.sh | SILK_RELEASE='${metadata.tag}' sh`,
    '```',
    '',
    'Windows (x86-64), in PowerShell:',
    '',
    '```powershell',
    `$env:SILK_RELEASE = '${metadata.tag}'; irm ${raw}/install.ps1 | iex`,
    '```',
    '',
    `With Scoop: \`scoop install ${download}/silk.json\`. Building programs needs LLVM 22 or newer (Clang, plus LLD on Windows). See [Install](https://github.com/${repository}#install) for PATH setup, Homebrew, mise and signature checks.`,
    '',
    '',
  ].join('\n')
}
export const releaseBody = (repository, metadata) => {
  const install = releaseInstall(repository, metadata)
  if (install.length + metadata.notes.length <= releaseBodyLimit) return install + metadata.notes
  const footer = `\n\n_Notes truncated. Every change in this release is in [compiler/.changes](https://github.com/${repository}/tree/${metadata.commit}/compiler/.changes)._`
  const kept = metadata.notes.slice(0, releaseBodyLimit - install.length - footer.length)
  return install + kept.slice(0, kept.lastIndexOf('\n')).trimEnd() + footer
}
const json = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))
const command = Effect.fnUntraced(function* (executable, args, options = {}) {
  const result = yield* NativeProcess.execute(executable, args, options)
  if (result.status !== 0 || result.signal !== null)
    return yield* invalid(`${executable} ${args[0]} failed: ${result.stderr.toString()}`)
  return result.stdout.toString().trim()
})
const api = Effect.fnUntraced(function* (repository, path, method = 'GET', body) {
  const args = ['api', `repos/${repository}/${path}`, '--method', method]
  if (body !== undefined) args.push('--input', '-')
  const text = yield* command(
    'gh',
    args,
    body === undefined ? {} : { input: Buffer.from(JSON.stringify(body)) },
  )
  return text ? yield* json(text) : null
})
const pages = Effect.fnUntraced(function* (repository, path) {
  const text = yield* command('gh', ['api', '--paginate', '--slurp', `repos/${repository}/${path}`])
  return (yield* json(text)).flat()
})

const headMarker = (head) => `<!-- silk-managed-head: ${head} -->`
const sealDescription = (title, body) =>
  `<!-- silk-managed-description: ${hash(JSON.stringify([title, body]))} -->\n${body}`
const ownedDescription = (pull) => {
  if (typeof pull.title !== 'string' || typeof pull.body !== 'string') return undefined
  const seal = /^<!-- silk-managed-description: ([0-9a-f]{64}) -->\n/.exec(pull.body)
  if (!seal) return undefined
  const body = pull.body.slice(seal[0].length)
  return seal[1] === hash(JSON.stringify([pull.title, body])) ? body : undefined
}
export const isManagedMerge = (pull, commit, repository) =>
  typeof pull.merged_at === 'string' &&
  pull.merge_commit_sha === commit &&
  pull.base?.ref === 'main' &&
  pull.head?.ref === managedBranch &&
  pull.head?.repo?.full_name === repository &&
  pull.user?.login === 'github-actions[bot]' &&
  pull.body?.includes(managedMarker) &&
  pull.body.includes(headMarker(pull.head.sha))

/**
 * Dev counters come from the published tags: the next counter is one past the highest dev tag,
 * and a commit that already has a dev tag keeps its counter. Main runs share one concurrency lock,
 * so only one release can be in flight, and a run that fails before tagging consumes nothing.
 */
export const devCounter = Effect.fn('CompilerRelease.devCounter')(function* (tags, commit) {
  let maximum = 0
  let existing
  for (const tag of tags) {
    const match = /^refs\/tags\/v[0-9]+\.[0-9]+\.[0-9]+-dev\.([1-9][0-9]*)\+/.exec(tag.ref)
    if (!match) continue
    const counter = Number(match[1])
    if (!Number.isSafeInteger(counter)) return yield* invalid(`Malformed dev tag: ${tag.ref}`)
    maximum = Math.max(maximum, counter)
    if (tag.object?.sha === commit) {
      if (existing !== undefined && existing !== counter)
        return yield* invalid('Commit has conflicting dev tags')
      existing = counter
    }
  }
  if (existing === undefined && !Number.isSafeInteger(maximum + 1))
    return yield* invalid('Dev counter exhausted')
  return existing ?? maximum + 1
})

export const plan = Effect.fn('CompilerRelease.plan')(function* ({
  repository,
  commit,
  mode,
  event,
}) {
  if (!/^[0-9a-f]{40}$/.test(commit)) return yield* invalid('Release source must be a full commit')
  const pulls = yield* pages(repository, `commits/${commit}/pulls?per_page=100`)
  const stableMerge = pulls.some((pull) => isManagedMerge(pull, commit, repository))
  if (event === 'push') mode = stableMerge ? 'stable' : 'none'
  if (!['none', 'dev', 'stable'].includes(mode)) return yield* invalid('Unknown release mode')
  if (mode === 'none' || (mode === 'dev' && stableMerge)) return { mode: 'none' }
  if (mode === 'stable' && !stableMerge)
    return yield* invalid('Stable publication requires the exact managed release PR merge commit')
  const releases = yield* pages(repository, 'releases?per_page=100')
  const published = releases.filter(
    (release) => !release.draft && !release.tag_name.startsWith('bootstrap-native-'),
  )
  // Our releases always pin target_commitish to a full SHA, not a moving branch.
  if (mode === 'dev' && published.some((release) => release.target_commitish === commit))
    return { mode: 'none' }
  if (mode === 'stable') return { mode }
  const tags = yield* pages(repository, 'git/matching-refs/tags/v?per_page=100')
  return { mode, counter: yield* devCounter(tags, commit) }
})

export const maintain = Effect.fn('CompilerRelease.maintain')(function* ({ repository, tool }) {
  const fs = yield* FileSystem.FileSystem
  const pending = (yield* fs.readDirectory('compiler/.changes')).filter((name) =>
    name.endsWith('.md'),
  )
  const base = yield* command('git', ['rev-parse', 'HEAD'])
  const currentMain = (yield* command('git', [
    'ls-remote',
    '--heads',
    'origin',
    'refs/heads/main',
  ])).split(/\s/)[0]
  if (currentMain !== base) return
  const pulls = yield* pages(
    repository,
    `pulls?state=open&head=${encodeURIComponent(`${repository.split('/')[0]}:${managedBranch}`)}&per_page=100`,
  )
  if (pulls.length > 1) return yield* invalid('Multiple managed release PRs')
  const pull = pulls[0]
  const previousDescription = pull && ownedDescription(pull)
  if (pending.length === 0 && !pull) return
  const remote = yield* command('git', [
    'ls-remote',
    '--heads',
    'origin',
    `refs/heads/${managedBranch}`,
  ])
  const oldHead = remote.split(/\s/)[0]
  if (pull && !oldHead) return yield* invalid('Managed release PR branch was removed')
  let preparedHead
  if (oldHead) {
    if (
      pull &&
      (pull.user.login !== 'github-actions[bot]' ||
        previousDescription === undefined ||
        !pull.body?.includes(managedMarker) ||
        !pull.body.includes(headMarker(oldHead)) ||
        pull.head.sha !== oldHead)
    )
      return yield* invalid('Managed release branch or PR was edited; refusing to replace it')
    yield* command('git', ['fetch', 'origin', `refs/heads/${managedBranch}`])
    const author = yield* command('git', ['show', '-s', '--format=%ae', oldHead])
    const committer = yield* command('git', ['show', '-s', '--format=%ce', oldHead])
    const message = yield* command('git', ['show', '-s', '--format=%B', oldHead])
    const parents = (yield* command('git', ['show', '-s', '--format=%P', oldHead])).split(' ')
    if (
      author !== '41898282+github-actions[bot]@users.noreply.github.com' ||
      committer !== author ||
      parents.length !== 1 ||
      !message.endsWith(`Silk-Managed-Release: ${parents[0]}`)
    )
      return yield* invalid('Managed release branch contains unowned changes')
    yield* command('git', ['merge-base', '--is-ancestor', parents[0], base])
    const changed = (yield* command('git', ['diff', '--name-only', parents[0], oldHead])).split(
      '\n',
    )
    if (
      changed.some(
        (path) =>
          ![
            'compiler/silk.toml',
            'compiler/src/ReleaseVersion.silk',
            'compiler/CHANGELOG.md',
          ].includes(path) && !path.startsWith('compiler/.changes/'),
      )
    )
      return yield* invalid('Managed release branch contains changes outside release metadata')
    if (pending.length === 0) {
      if (pull) yield* api(repository, `pulls/${pull.number}`, 'PATCH', { state: 'closed' })
      return
    }
    if (parents[0] === base) preparedHead = oldHead
  }
  yield* command(tool, ['change', '--dir', 'compiler', 'version'])
  const release = yield* json(
    yield* command(tool, ['change', '--dir', 'compiler', 'release', '--json']),
  )
  if (release.prerelease !== false) return yield* invalid('Managed release PR must be stable')
  yield* command('git', [
    'add',
    'compiler/silk.toml',
    'compiler/src/ReleaseVersion.silk',
    'compiler/CHANGELOG.md',
    'compiler/.changes',
  ])
  let head = preparedHead
  if (head) {
    // A push may have succeeded before its metadata PATCH failed. Reproduce the native
    // preparation, prove it is the same tree, then repair metadata without another commit.
    const tree = yield* command('git', ['write-tree'])
    if (tree !== (yield* command('git', ['rev-parse', `${head}^{tree}`])))
      return yield* invalid('Existing managed release tree differs from native preparation')
  } else {
    yield* command('git', [
      '-c',
      'user.name=github-actions[bot]',
      '-c',
      'user.email=41898282+github-actions[bot]@users.noreply.github.com',
      'commit',
      '-m',
      `Release Silk ${release.version}`,
      '-m',
      `Silk-Managed-Release: ${base}`,
    ])
    head = yield* command('git', ['rev-parse', 'HEAD'])
    // Authorize both exact bot heads before moving the branch. A merge racing the refresh
    // still identifies its head; resealing retains human-edit detection on interrupted retries.
    if (pull)
      yield* api(repository, `pulls/${pull.number}`, 'PATCH', {
        body: sealDescription(pull.title, `${previousDescription}\n${headMarker(head)}`),
      })
    yield* command('git', [
      'push',
      `--force-with-lease=refs/heads/${managedBranch}:${oldHead}`,
      'origin',
      `HEAD:refs/heads/${managedBranch}`,
    ])
  }
  const title = `Release Silk ${release.version}`
  const body = sealDescription(
    title,
    `${managedMarker}\n${headMarker(head)}\n${oldHead && oldHead !== head ? headMarker(oldHead) : ''}\nPrepare Silk ${release.version}.\n\nThis PR is refreshed from main while pending changes exist. Review and explicitly merge when ready to announce; merging automatically publishes this exact stable release after all native gates. No release is published by preparing this PR. Do not edit the managed branch, title, or description; add review comments instead.\n\n${release.notes}`,
  )
  if (pull)
    yield* api(repository, `pulls/${pull.number}`, 'PATCH', {
      title,
      body,
    })
  else
    yield* api(repository, 'pulls', 'POST', {
      title,
      body,
      head: managedBranch,
      base: 'main',
      draft: true,
    })
  // The stable merge reruns every native gate on main, so the managed branch is verified only
  // when someone dispatches selfhost.yml on it (see .github/CI.md), not after every refresh.
})

/** Timing/runner/run-id fields are observational; all source, compiler and IR identities are immutable. */
export const assetIdentity = (name, bytes) => {
  if (name === 'native-seed.json') {
    const value = JSON.parse(Buffer.from(bytes).toString())
    return JSON.stringify(
      Object.fromEntries(
        Object.entries(value.seeds)
          .sort()
          .map(([target, pin]) => [target, { ...pin, runId: undefined }]),
      ),
    )
  }
  if (/^chain-receipt-.*\.json$/.test(name)) {
    const value = JSON.parse(Buffer.from(bytes).toString())
    return JSON.stringify({
      target: value.target,
      inputs: value.inputs,
      output: value.output.sha256,
      fixpoint: value.fixpoint,
    })
  }
  return Buffer.from(bytes).toString('base64')
}

/** A projected build reports its projected version; an unprojected one the version its manifest names. */
export const verifyBuild = Effect.fn('CompilerRelease.verifyBuild')(
  function* (compiler, directory) {
    const fs = yield* FileSystem.FileSystem
    const receipt = yield* verifySnapshot({ directory })
    let version = receipt.projection?.version
    if (!version) {
      const manifest = yield* fs.readFileString(join(directory, 'compiler/silk.toml'))
      const section = /^\[package\][ \t]*\r?\n([\s\S]*?)(?=^\[|$(?![\s\S]))/m.exec(manifest)
      version = section && /^version[ \t]*=[ \t]*(['"])([^'"\r\n]+)\1/m.exec(section[1])?.[2]
      if (!version) return yield* invalid('compiler/silk.toml names no package version')
    }
    if ((yield* command(compiler, ['--version'])) !== `silk v${version}`)
      return yield* invalid('Compiler version differs from its native snapshot')
  },
)

export const publish = Effect.fn('CompilerRelease.publish')(function* ({
  repository,
  snapshot,
  directory,
  files,
}) {
  const fs = yield* FileSystem.FileSystem
  const metadata = yield* json(yield* fs.readFileString(snapshot))
  if (
    metadata.package !== 'silk-compiler' ||
    metadata.tag !== `v${metadata.version}` ||
    !/^[0-9a-f]{40}$/.test(metadata.commit) ||
    typeof metadata.prerelease !== 'boolean'
  )
    return yield* invalid('Invalid native publication metadata')
  const tag = metadata.tag
  const body = releaseBody(repository, metadata)
  const existingRefs = yield* pages(
    repository,
    `git/matching-refs/tags/${encodeURIComponent(tag)}?per_page=100`,
  )
  const ref = existingRefs.find((entry) => entry.ref === `refs/tags/${tag}`)
  if (ref && (ref.object.type !== 'commit' || ref.object.sha !== metadata.commit))
    return yield* invalid('Release tag points at different source')
  if (!ref)
    yield* api(repository, 'git/refs', 'POST', { ref: `refs/tags/${tag}`, sha: metadata.commit })
  const releases = yield* pages(repository, 'releases?per_page=100')
  let release = releases.find((entry) => entry.tag_name === tag)
  if (!release)
    release = yield* api(repository, 'releases', 'POST', {
      tag_name: tag,
      target_commitish: metadata.commit,
      name: `Silk ${metadata.version}`,
      body,
      draft: true,
      prerelease: metadata.prerelease,
      make_latest: 'false',
    })
  if (
    release.target_commitish !== metadata.commit ||
    release.body !== body ||
    release.prerelease !== metadata.prerelease
  )
    return yield* invalid('Existing release metadata differs from reserved publication')
  const assets = yield* pages(repository, `releases/${release.id}/assets?per_page=100`)
  if (assets.some((asset) => !files.includes(asset.name)))
    return yield* invalid('Release contains unexpected assets')
  const temporary = yield* fs.makeTempDirectoryScoped({ prefix: 'silk-release-assets-' })
  for (const name of files) {
    if (name !== name.split('/').pop()) return yield* invalid('Asset names must be basenames')
    const local = yield* fs.readFile(join(directory, name))
    let existing = assets.find((asset) => asset.name === name)
    // GitHub leaves a non-uploaded placeholder after some interrupted transfers.
    // Only that unfinished draft placeholder may be removed; uploaded assets are immutable.
    if (existing?.state === 'starter' && release.draft) {
      yield* api(repository, `releases/assets/${existing.id}`, 'DELETE')
      existing = undefined
    }
    if (existing) {
      yield* command('gh', [
        'release',
        'download',
        tag,
        '--repo',
        repository,
        '--pattern',
        name,
        '--dir',
        temporary,
      ])
      const remote = yield* fs.readFile(join(temporary, name))
      const equal = yield* Effect.try({
        try: () => assetIdentity(name, local) === assetIdentity(name, remote),
        catch: (cause) =>
          new CompilerReleaseError({
            reason: 'Conflict',
            message: 'Malformed immutable release asset',
            cause,
          }),
      })
      if (!equal) return yield* invalid(`Immutable release asset differs: ${name}`)
    } else {
      if (!release.draft)
        return yield* invalid(`Published release is missing ${name}; refusing mutation`)
      // Never --clobber: a racing writer must fail, not overwrite immutable bytes.
      yield* command('gh', ['release', 'upload', tag, join(directory, name), '--repo', repository])
    }
  }
  if (release.draft)
    yield* api(repository, `releases/${release.id}`, 'PATCH', {
      draft: false,
      make_latest: metadata.prerelease ? 'false' : 'true',
    })
  yield* Console.log(`Published immutable ${tag} from ${metadata.commit}`)
})

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const require = createRequire(new URL('../../package.json', import.meta.url))
  const { NodeServices } = await import(
    pathToFileURL(require.resolve('@effect/platform-node')).href
  )
  const [operation, ...args] = process.argv.slice(2)
  const repository = process.env.GITHUB_REPOSITORY
  const program = Effect.gen(function* () {
    if (operation !== 'verify-build' && !repository)
      return yield* invalid('GITHUB_REPOSITORY is required')
    if (operation === 'plan') {
      const result = yield* plan({ repository, commit: args[0], mode: args[1], event: args[2] })
      const fs = yield* FileSystem.FileSystem
      yield* fs.writeFileString(
        process.env.GITHUB_OUTPUT,
        `mode=${result.mode}\ncounter=${result.counter ?? ''}\n`,
        { flag: 'a' },
      )
    } else if (operation === 'maintain') yield* maintain({ repository, tool: args[0] })
    else if (operation === 'publish')
      yield* publish({ repository, snapshot: args[0], directory: args[1], files: args.slice(2) })
    else if (operation === 'verify-build') yield* verifyBuild(args[0], args[1])
    else return yield* invalid('Expected plan, maintain, publish, or verify-build')
  })
  await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
}
