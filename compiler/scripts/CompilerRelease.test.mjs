import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { assert, it } from './EffectTest.mjs'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Result from 'effect/Result'
import { mock } from 'node:test'
import * as NativeProcess from './NativeProcess.ts'

// CompilerRelease reaches `gh` through NativeProcess.execute; tests swap in a transport handler.
let handler
mock.module('./NativeProcess.ts', {
  exports: {
    ...NativeProcess,
    execute: (...args) => (handler ?? NativeProcess.execute)(...args),
  },
})
const {
  assetIdentity,
  devCounter,
  isManagedMerge,
  maintain,
  managedBranch,
  managedMarker,
  plan,
  publish,
  releaseBody,
  releaseBodyLimit,
} = await import('./CompilerRelease.mjs')

const require = createRequire(new URL('../../package.json', import.meta.url))
const { NodeServices } = await import(pathToFileURL(require.resolve('@effect/platform-node')).href)
const commit = 'a'.repeat(40)
const other = 'b'.repeat(40)
const repository = 'silk-lang/silk'
const tag = (counter, sha) => ({
  ref: `refs/tags/v0.1.0-dev.${counter}+${sha.slice(0, 12)}`,
  object: { type: 'commit', sha },
})
const sealedDescription = (title, body) =>
  `<!-- silk-managed-description: ${createHash('sha256')
    .update(JSON.stringify([title, body]))
    .digest('hex')} -->\n${body}`
const pull = {
  merged_at: '2026-10-19T06:00:00Z',
  merge_commit_sha: commit,
  base: { ref: 'main' },
  head: { ref: managedBranch, sha: other, repo: { full_name: repository } },
  user: { login: 'github-actions[bot]' },
  title: 'Release Silk 0.1.0',
  body: sealedDescription(
    'Release Silk 0.1.0',
    `${managedMarker}\n<!-- silk-managed-head: ${other} -->\nOld release notes.`,
  ),
}
const outcome = (value) => ({
  stdout: Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)),
  stderr: Buffer.alloc(0),
  status: 0,
  signal: null,
  deadline: null,
})
const transport = Effect.fnUntraced(function* (next) {
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      handler = next
    }),
    () =>
      Effect.sync(() => {
        handler = undefined
      }),
  )
})

it.effect('continues past the highest dev tag and keeps a tagged commit at its counter', () =>
  Effect.gen(function* () {
    const tags = [
      tag(2, commit),
      tag(19, other),
      { ref: 'refs/tags/v0.1.0', object: { sha: other } },
    ]
    assert.strictEqual(yield* devCounter(tags, commit), 2)
    assert.strictEqual(yield* devCounter(tags, 'c'.repeat(40)), 20)
    assert.strictEqual(yield* devCounter([], commit), 1)
  }),
)

it.effect('fails closed on conflicting or malformed dev tags', () =>
  Effect.gen(function* () {
    for (const tags of [[tag(2, commit), tag(3, commit)], [tag('9007199254740993', other)]]) {
      const result = yield* Effect.result(devCounter(tags, commit))
      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.strictEqual(result.failure.reason, 'Conflict')
    }
  }),
)

it('recognizes only the exact owned release PR merge, not an edited head or ordinary main commit', () => {
  assert.isTrue(isManagedMerge(pull, commit, repository))
  assert.isFalse(isManagedMerge(pull, other, repository))
  assert.isFalse(isManagedMerge({ ...pull, merged_at: null }, commit, repository))
  assert.isFalse(isManagedMerge({ ...pull, user: { login: 'contributor' } }, commit, repository))
  assert.isFalse(
    isManagedMerge({ ...pull, head: { ...pull.head, sha: commit } }, commit, repository),
  )
  assert.isFalse(
    isManagedMerge(
      { ...pull, head: { ...pull.head, repo: { full_name: 'fork/silk' } } },
      commit,
      repository,
    ),
  )
})

it.effect(
  'nightly never turns the stable merge into a dev, including before its stable publication',
  () =>
    Effect.gen(function* () {
      yield* transport((file, args) =>
        Effect.sync(() => {
          assert.strictEqual(file, 'gh')
          if (args.at(-1).includes(`/commits/${commit}/pulls`)) return outcome([[pull]])
          assert.include(args.at(-1), '/releases?')
          return outcome([[]])
        }),
      )
      assert.deepEqual(yield* plan({ repository, commit, mode: 'dev', event: 'schedule' }), {
        mode: 'none',
      })
      assert.deepEqual(yield* plan({ repository, commit, mode: 'none', event: 'push' }), {
        mode: 'stable',
      })
    }).pipe(Effect.scoped),
)

it.effect('published commits are deduplicated, while a tagged draft keeps its counter', () =>
  Effect.gen(function* () {
    let draft = false
    let writes = 0
    yield* transport((file, args) =>
      Effect.sync(() => {
        assert.strictEqual(file, 'gh')
        const path = args.find((value) => value.startsWith('repos/'))
        if (args.includes('POST')) writes++
        if (path.includes('/commits/')) return outcome([[]])
        if (path.includes('/releases?'))
          return outcome([
            [{ draft, tag_name: 'v0.1.0-dev.7+aaaaaaaaaaaa', target_commitish: commit }],
          ])
        if (path.includes('/git/matching-refs/tags/'))
          return outcome([[tag(7, commit), tag(15, other)]])
        assert.fail(`Unexpected transport: ${args.join(' ')}`)
      }),
    )
    assert.deepEqual(yield* plan({ repository, commit, mode: 'dev', event: 'workflow_dispatch' }), {
      mode: 'none',
    })
    draft = true
    assert.deepEqual(yield* plan({ repository, commit, mode: 'dev', event: 'workflow_dispatch' }), {
      mode: 'dev',
      counter: 7,
    })
    assert.strictEqual(writes, 0)
  }).pipe(Effect.scoped),
)

it.effect('plans the next dev counter from tags without writing anything', () =>
  Effect.gen(function* () {
    const tags = [tag(12, other)]
    let writes = 0
    yield* transport((file, args) =>
      Effect.sync(() => {
        assert.strictEqual(file, 'gh')
        const path = args.find((value) => value.startsWith('repos/'))
        if (args.includes('POST') || args.includes('DELETE')) writes++
        if (path.includes('/git/matching-refs/tags/')) return outcome([tags])
        return outcome([[]])
      }),
    )
    const request = { repository, commit, mode: 'dev', event: 'workflow_dispatch' }
    // A run that fails before tagging leaves nothing behind, so the retry gets the same counter.
    assert.deepEqual(yield* plan(request), { mode: 'dev', counter: 13 })
    assert.deepEqual(yield* plan(request), { mode: 'dev', counter: 13 })
    tags.push(tag(13, commit))
    assert.deepEqual(yield* plan({ ...request, commit: 'c'.repeat(40) }), {
      mode: 'dev',
      counter: 14,
    })
    assert.strictEqual(writes, 0)
  }).pipe(Effect.scoped),
)

it('rerun equivalence ignores receipt timing but retains source, compiler and IR identity', () => {
  const receipt = {
    target: 'target',
    inputs: {
      sourceCommit: commit,
      normalizedDigest: 'digest',
      projection: { version: '0.1.0-dev.7+aaaaaaaaaaaa' },
    },
    output: { sha256: 'binary' },
    fixpoint: { producerIrSha256: 'ir', outputIrSha256: 'ir' },
    stages: [{ wallTimeMs: 1 }],
  }
  const identity = (value) =>
    assetIdentity('chain-receipt-target.json', Buffer.from(JSON.stringify(value)))
  assert.strictEqual(identity(receipt), identity({ ...receipt, stages: [{ wallTimeMs: 999 }] }))
  assert.notStrictEqual(
    identity(receipt),
    identity({ ...receipt, inputs: { ...receipt.inputs, sourceCommit: other } }),
  )
  assert.notStrictEqual(
    identity(receipt),
    identity({ ...receipt, output: { sha256: 'different' } }),
  )
  assert.notStrictEqual(
    identity(receipt),
    identity({
      ...receipt,
      fixpoint: { producerIrSha256: 'different', outputIrSha256: 'different' },
    }),
  )
  assert.notStrictEqual(
    assetIdentity('changes-snapshot.toml', Buffer.from('old')),
    assetIdentity('changes-snapshot.toml', Buffer.from('new')),
  )
})

it.effect('refresh refuses a human-edited managed head before changing the branch or PR', () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const humanHead = 'c'.repeat(40)
    const mutations = []
    yield* transport((file, args) =>
      Effect.sync(() => {
        if (file === 'git' && args[0] === 'rev-parse') return outcome(commit)
        if (file === 'git' && args[0] === 'ls-remote')
          return outcome(
            `${args.at(-1) === 'refs/heads/main' ? commit : humanHead}\t${args.at(-1)}`,
          )
        if (file === 'gh' && args.includes('--paginate'))
          return outcome([
            [{ ...pull, number: 1, merged_at: null, head: { ...pull.head, sha: humanHead } }],
          ])
        mutations.push([file, args])
        return outcome('')
      }),
    )
    const result = yield* Effect.result(
      maintain({ repository, tool: '/unused/silk' }).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          readDirectory: () => Effect.succeed(['pending.md']),
        }),
      ),
    )
    assert.isTrue(Result.isFailure(result))
    if (Result.isFailure(result)) assert.strictEqual(result.failure.reason, 'Conflict')
    assert.deepEqual(mutations, [])
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
)

const maintenanceFixture = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem
  const state = {
    head: commit,
    remote: other,
    parent: 'd'.repeat(40),
    commits: 0,
    pull: { ...pull, number: 1, merged_at: null },
    failMetadata: false,
  }
  yield* transport((file, args, options) =>
    Effect.sync(() => {
      if (file === '/silk') {
        if (args[0] !== 'change') throw new Error(`Unexpected silk command: ${args}`)
        if (args.includes('release'))
          return outcome({
            version: '0.2.0',
            prerelease: false,
            notes: 'New behavior and migration guidance.',
          })
        return outcome('')
      }
      if (file === 'git') {
        if (args[0] === 'rev-parse')
          return outcome(args[1] === 'HEAD' ? state.head : 'prepared-tree')
        if (args[0] === 'ls-remote')
          return outcome(
            `${args.at(-1) === 'refs/heads/main' ? commit : state.remote}\t${args.at(-1)}`,
          )
        if (args[0] === 'show') {
          if (args.includes('--format=%P')) return outcome(state.parent)
          if (args.includes('--format=%B'))
            return outcome(`Release Silk\n\nSilk-Managed-Release: ${state.parent}`)
          return outcome('41898282+github-actions[bot]@users.noreply.github.com')
        }
        if (args[0] === 'diff') return outcome('compiler/silk.toml')
        if (args[0] === 'write-tree') return outcome('prepared-tree')
        if (args.includes('commit')) {
          state.head = 'c'.repeat(40)
          state.commits++
        }
        if (args[0] === 'push') {
          state.remote = state.head
          state.parent = commit
        }
        if (['fetch', 'merge-base', 'add', 'push'].includes(args[0]) || args.includes('commit'))
          return outcome('')
        throw new Error(`Unexpected git operation: ${args}`)
      }
      if (file === 'gh' && args.includes('--paginate'))
        return outcome([[{ ...state.pull, head: { ...pull.head, sha: state.remote } }]])
      if (file === 'gh' && args.includes('PATCH')) {
        const patch = JSON.parse(Buffer.from(options.input).toString())
        if (state.failMetadata && patch.title) {
          state.failMetadata = false
          return {
            ...outcome(''),
            status: 1,
            stderr: Buffer.from('interrupted metadata publication'),
          }
        }
        state.pull = { ...state.pull, ...patch }
        return outcome(state.pull)
      }
      throw new Error(`Unexpected process: ${file} ${args}`)
    }),
  )
  const refresh = () =>
    maintain({ repository, tool: '/silk' }).pipe(
      Effect.provideService(FileSystem.FileSystem, {
        ...fs,
        readDirectory: () => Effect.succeed(['pending.md']),
      }),
    )
  return { state, refresh }
})

it.effect('refresh preserves human-edited PR descriptions by refusing the update', () =>
  Effect.gen(function* () {
    const { state, refresh } = yield* maintenanceFixture()
    state.pull.body += '\nHuman release instructions.'
    const description = state.pull.body
    const result = yield* Effect.result(refresh())
    assert.isTrue(Result.isFailure(result))
    assert.strictEqual(state.pull.body, description)
    assert.strictEqual(state.remote, other)
    assert.strictEqual(state.commits, 0)
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
)

it.effect('same-head retry repairs interrupted PR metadata without another release commit', () =>
  Effect.gen(function* () {
    const { state, refresh } = yield* maintenanceFixture()
    state.failMetadata = true
    assert.isTrue(Result.isFailure(yield* Effect.result(refresh())))
    const publishedHead = state.remote
    assert.notStrictEqual(publishedHead, other)
    assert.strictEqual(state.pull.title, 'Release Silk 0.1.0')
    state.head = commit
    yield* refresh()
    assert.strictEqual(state.pull.title, 'Release Silk 0.2.0')
    assert.include(state.pull.body, 'New behavior and migration guidance.')
    assert.strictEqual(state.remote, publishedHead)
    assert.strictEqual(state.commits, 1)
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
)

it.effect(
  'an interrupted draft resumes missing uploads without replacing completed immutable assets',
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'silk-publication-test-' })
      const snapshot = join(directory, 'release.json')
      const metadata = {
        package: 'silk-compiler',
        version: '0.1.0-dev.7+aaaaaaaaaaaa',
        tag: 'v0.1.0-dev.7+aaaaaaaaaaaa',
        commit,
        notes: 'Native notes',
        prerelease: true,
      }
      yield* fs.writeFileString(snapshot, JSON.stringify(metadata))
      yield* fs.writeFileString(join(directory, 'compiler'), 'binary')
      yield* fs.writeFileString(join(directory, 'changes-snapshot.toml'), 'immutable snapshot')
      let release
      let tag
      let interrupted = false
      const uploaded = new Map()
      const uploadCounts = new Map()
      yield* transport((file, args, options = {}) =>
        Effect.gen(function* () {
          assert.strictEqual(file, 'gh')
          if (args[0] === 'api') {
            const path = args.find((value) => value.startsWith('repos/'))
            const method = args.includes('--method') ? args[args.indexOf('--method') + 1] : 'GET'
            const body = options.input
              ? JSON.parse(Buffer.from(options.input).toString())
              : undefined
            if (path.includes('/git/matching-refs/')) return outcome([tag ? [tag] : []])
            if (path.endsWith('/git/refs')) {
              tag = { ref: body.ref, object: { type: 'commit', sha: body.sha } }
              return outcome(tag)
            }
            if (path.includes('/releases?')) return outcome([release ? [release] : []])
            if (path.endsWith('/releases') && method === 'POST') {
              release = { ...body, id: 42 }
              return outcome(release)
            }
            if (path.endsWith('/assets?per_page=100'))
              return outcome([[...uploaded.keys()].map((name) => ({ name, state: 'uploaded' }))])
            if (path.endsWith('/releases/42') && method === 'PATCH') {
              release = { ...release, ...body }
              return outcome(release)
            }
          }
          if (args[0] === 'release' && args[1] === 'upload') {
            const path = args[3]
            const name = path.split('/').pop()
            assert.notInclude(args, '--clobber')
            if (name === 'changes-snapshot.toml' && !interrupted) {
              interrupted = true
              return { ...outcome(''), status: 1, stderr: Buffer.from('interrupted upload') }
            }
            uploaded.set(name, yield* fs.readFile(path))
            uploadCounts.set(name, (uploadCounts.get(name) ?? 0) + 1)
            return outcome('')
          }
          if (args[0] === 'release' && args[1] === 'download') {
            const name = args[args.indexOf('--pattern') + 1]
            yield* fs.writeFile(join(args[args.indexOf('--dir') + 1], name), uploaded.get(name))
            return outcome('')
          }
          return yield* Effect.die(`Unexpected transport: ${args.join(' ')}`)
        }),
      )
      const options = {
        repository,
        snapshot,
        directory,
        files: ['compiler', 'changes-snapshot.toml'],
      }
      assert.isTrue(Result.isFailure(yield* Effect.result(publish(options))))
      assert.isTrue(release.draft)
      assert.deepEqual([...uploaded.keys()], ['compiler'])
      yield* publish(options)
      assert.isFalse(release.draft)
      assert.deepEqual(
        [...uploadCounts.entries()],
        [
          ['compiler', 1],
          ['changes-snapshot.toml', 1],
        ],
      )
      // Completed reruns are read-only; changing local bytes cannot overwrite the existing release.
      yield* publish(options)
      yield* fs.writeFileString(join(directory, 'compiler'), 'different binary')
      assert.isTrue(Result.isFailure(yield* Effect.result(publish(options))))
      assert.deepEqual(
        [...uploadCounts.entries()],
        [
          ['compiler', 1],
          ['changes-snapshot.toml', 1],
        ],
      )
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
)

it('release notes over the GitHub body limit keep whole leading lines and link the changes', () => {
  const short = { commit, notes: 'Short notes.' }
  assert.strictEqual(releaseBody(repository, short), 'Short notes.')
  const line = 'A change that every prerelease since the last stable release carries.\n'
  const notes = line.repeat(Math.ceil((releaseBodyLimit * 1.2) / line.length))
  const body = releaseBody(repository, { commit, notes })
  assert.isAtMost(body.length, releaseBodyLimit)
  const [kept, footer] = body.split('\n\n_Notes truncated.')
  assert.isTrue(notes.startsWith(`${kept}\n`))
  assert.include(footer, `https://github.com/${repository}/tree/${commit}/compiler/.changes`)
})
