import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Result from 'effect/Result'
import { vi } from 'vitest'
import * as NativeProcess from './NativeProcess.ts'
import {
  assetIdentity,
  isManagedMerge,
  maintain,
  managedBranch,
  managedMarker,
  plan,
  publish,
  reservation,
} from './CompilerRelease.mjs'

const require = createRequire(new URL('../../package.json', import.meta.url))
const { NodeServices } = await import(pathToFileURL(require.resolve('@effect/platform-node')).href)
const commit = 'a'.repeat(40)
const other = 'b'.repeat(40)
const repository = 'silk-lang/silk'
const ref = (counter, sha) => ({
  ref: `refs/tags/compiler-dev-reservation/${counter}`,
  object: { type: 'commit', sha },
})
const pull = {
  merged_at: '2026-10-19T06:00:00Z',
  merge_commit_sha: commit,
  base: { ref: 'main' },
  head: { ref: managedBranch, sha: other, repo: { full_name: repository } },
  user: { login: 'github-actions[bot]' },
  body: `${managedMarker}\n<!-- silk-managed-head: ${other} -->`,
}
const outcome = (value) => ({
  stdout: Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)),
  stderr: Buffer.alloc(0),
  status: 0,
  signal: null,
  deadline: null,
})
const transport = Effect.fnUntraced(function* (handler) {
  yield* Effect.acquireRelease(
    Effect.sync(() => vi.spyOn(NativeProcess, 'execute').mockImplementation(handler)),
    (spy) => Effect.sync(() => spy.mockRestore()),
  )
})

it.effect(
  'resumes a commit reservation and allocates above all prior counters, not release count',
  () =>
    Effect.gen(function* () {
      const refs = [ref(2, commit), ref(19, other)]
      assert.deepEqual(yield* reservation(refs, commit), { counter: 2, exists: true })
      assert.deepEqual(yield* reservation(refs, 'c'.repeat(40)), { counter: 20, exists: false })
      assert.deepEqual(yield* reservation([], commit), { counter: 1, exists: false })
    }),
)

it.effect('fails closed on conflicting or malformed durable reservation state', () =>
  Effect.gen(function* () {
    for (const refs of [
      [ref(2, commit), ref(3, commit)],
      [ref('02', commit)],
      [ref('9007199254740992', other)],
    ]) {
      const result = yield* Effect.result(reservation(refs, commit))
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

it.effect('published commits are deduplicated, while drafts reuse their durable counter', () =>
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
        if (path.includes('/git/matching-refs/')) return outcome([[ref(7, commit), ref(15, other)]])
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

it.effect('persists the next counter before returning build authorization', () =>
  Effect.gen(function* () {
    const writes = []
    yield* transport((file, args, options) =>
      Effect.sync(() => {
        assert.strictEqual(file, 'gh')
        const path = args.find((value) => value.startsWith('repos/'))
        if (args.includes('POST')) {
          writes.push(JSON.parse(Buffer.from(options.input).toString()))
          return outcome({})
        }
        if (path.includes('/git/matching-refs/')) return outcome([[ref(12, other)]])
        return outcome([[]])
      }),
    )
    assert.deepEqual(yield* plan({ repository, commit, mode: 'dev', event: 'schedule' }), {
      mode: 'dev',
      counter: 13,
    })
    assert.deepEqual(writes, [{ ref: 'refs/tags/compiler-dev-reservation/13', sha: commit }])
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
      maintain({ repository, compiler: '/unused/native-compiler' }).pipe(
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
