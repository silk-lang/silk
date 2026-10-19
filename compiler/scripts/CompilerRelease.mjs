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
const reservationPrefix = 'refs/silk/compiler-dev-reservation/'
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

/** Internal refs survive deleted drafts without appearing as tags/releases; counters are global. */
export const reservation = Effect.fn('CompilerRelease.reservation')(function* (refs, commit) {
  let maximum = 0
  let existing
  for (const ref of refs) {
    if (!ref.ref.startsWith(reservationPrefix)) continue
    const suffix = ref.ref.slice(reservationPrefix.length)
    if (!/^[1-9][0-9]*$/.test(suffix) || !Number.isSafeInteger(Number(suffix)))
      return yield* invalid(`Malformed dev reservation: ${ref.ref}`)
    const counter = Number(suffix)
    maximum = Math.max(maximum, counter)
    if (ref.object.sha === commit) {
      if (existing !== undefined) return yield* invalid('Commit has conflicting dev reservations')
      existing = counter
    }
  }
  if (existing === undefined && !Number.isSafeInteger(maximum + 1))
    return yield* invalid('Dev reservation counter exhausted')
  return { counter: existing ?? maximum + 1, exists: existing !== undefined }
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
  const refs = yield* pages(
    repository,
    `git/matching-refs/${reservationPrefix.slice('refs/'.length)}?per_page=100`,
  )
  const selected = yield* reservation(refs, commit)
  if (!selected.exists)
    yield* api(repository, 'git/refs', 'POST', {
      ref: `${reservationPrefix}${selected.counter}`,
      sha: commit,
    })
  return { mode, counter: selected.counter }
})

export const maintain = Effect.fn('CompilerRelease.maintain')(function* ({ repository, compiler }) {
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
  yield* command(compiler, ['changes', '--dir', 'compiler', 'version'])
  const release = yield* json(
    yield* command(compiler, ['changes', '--dir', 'compiler', 'release', '--json']),
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
  // GITHUB_TOKEN pushes/PR updates do not produce normal workflow events.
  yield* command('gh', [
    'workflow',
    'run',
    'selfhost.yml',
    '--repo',
    repository,
    '--ref',
    managedBranch,
  ])
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

/** Projected builds have no committed dev history: validate the immutable native projection instead. */
export const verifyBuild = Effect.fn('CompilerRelease.verifyBuild')(
  function* (compiler, directory) {
    const receipt = yield* verifySnapshot({ directory })
    if (receipt.projection) {
      if ((yield* command(compiler, ['--version'])) !== `silk v${receipt.projection.version}`)
        return yield* invalid('Compiler version differs from its native snapshot projection')
    } else {
      yield* command(compiler, ['changes', '--dir', join(directory, 'compiler'), 'status'])
    }
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
      body: metadata.notes,
      draft: true,
      prerelease: metadata.prerelease,
      make_latest: 'false',
    })
  if (
    release.target_commitish !== metadata.commit ||
    release.body !== metadata.notes ||
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
    } else if (operation === 'maintain') yield* maintain({ repository, compiler: args[0] })
    else if (operation === 'publish')
      yield* publish({ repository, snapshot: args[0], directory: args[1], files: args.slice(2) })
    else if (operation === 'verify-build') yield* verifyBuild(args[0], args[1])
    else return yield* invalid('Expected plan, maintain, publish, or verify-build')
  })
  await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
}
