import { assert, it } from '@effect/vitest'
import * as ProjectAnalysis from '@silklang/compiler/ProjectAnalysis'
import * as SourceFile from '@silklang/compiler/SourceFile'
import * as SourceResolver from '@silklang/compiler/SourceResolver'
import * as WorkspaceInventory from '@silklang/compiler/WorkspaceInventory'
import * as WorkspaceCatalog from '../src/WorkspaceCatalog.js'
import * as Deferred from 'effect/Deferred'
import * as Arr from 'effect/Array'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Queue from 'effect/Queue'
import * as Result from 'effect/Result'
import * as TestClock from 'effect/testing/TestClock'
import * as Document from '../src/Document.js'
import * as DocumentVersion from '../src/DocumentVersion.js'
import type * as ProjectSnapshot from '../src/ProjectSnapshot.js'
import * as ProjectWorker from '../src/ProjectWorker.js'
import * as SourceEvent from '../src/SourceEvent.js'
import * as SourceLedger from '../src/SourceLedger.js'
import type * as WorkerEpoch from '../src/WorkerEpoch.js'
import * as WorkerProtocol from '../src/WorkerProtocol.js'
import * as WorkspaceEngine from '../src/WorkspaceEngine.js'

const encoder = new TextEncoder()
const uri = 'file:///workspace/Main.silk'
const workspace = 'project:/workspace/silk.toml'

const document = (entry: SourceLedger.Entry): Document.Document =>
  documentIn(entry, workspace, 'Main')

const documentIn = (
  entry: SourceLedger.Entry,
  project: string,
  module: string,
  sourceRoot = '/workspace',
): Document.Document =>
  Document.make({
    uri: entry.uri,
    version: entry.version.value,
    workspace: project,
    sourceRoot,
    module,
    bytes: entry.bytes,
  })

const analyzed = Effect.fnUntraced(function* (
  documents: ReadonlyArray<Document.Document>,
  previous: ReadonlyMap<string, ProjectSnapshot.DocumentSnapshot>,
) {
  if (!Arr.isReadonlyArrayNonEmpty(documents))
    return new Map<string, ProjectSnapshot.DocumentSnapshot>()
  const modules = Arr.map(documents, (self) => self.module)
  const roots = documents.map((self) => SourceFile.make(self.module, self.bytes))
  const previousProject = previous.values().next().value?.project
  const project = yield* (
    previousProject === undefined
      ? ProjectAnalysis.make(modules).pipe(Effect.provide(SourceResolver.overlay(roots)))
      : ProjectAnalysis.revise(previousProject, modules).pipe(
          Effect.provide(SourceResolver.overlay(roots)),
        )
  ).pipe(Effect.provide(SourceResolver.empty))
  const moduleUris = new Map(documents.map((self) => [self.module, self.uri]))
  const inventory = yield* WorkspaceCatalog.defer(Effect.sync(() => WorkspaceInventory.make()))
  const entries: Array<readonly [string, ProjectSnapshot.DocumentSnapshot]> = []
  for (const self of documents) {
    const snapshot = ProjectAnalysis.view(project, self.module)
    if (snapshot !== undefined)
      entries.push([
        self.uri,
        Object.freeze({ document: self, project, snapshot, moduleUris, inventory }),
      ])
  }
  return new Map(entries)
})

const factory = (
  analyze: Parameters<typeof ProjectWorker.makeInProcess>[0]['analyze'] = analyzed,
): ProjectWorker.Factory => ({
  spawn: (epoch) => ProjectWorker.makeInProcess({ epoch, analyze }),
})

const makeEngine = (
  analyze: Parameters<typeof ProjectWorker.makeInProcess>[0]['analyze'] = analyzed,
  policy: Partial<WorkspaceEngine.Policy> = {},
) =>
  WorkspaceEngine.make({
    discover: (entry) => Effect.succeed(document(entry)),
    workerFactory: factory(analyze),
    policy: { debounce: 10, queryDeadline: 100, diagnosticDeadline: 100, ...policy },
  })

const open = (version: number, source: string) =>
  SourceEvent.open(uri, DocumentVersion.make(version), encoder.encode(source))

const change = (version: number, source: string) =>
  SourceEvent.change(uri, DocumentVersion.make(version), encoder.encode(source))

const nextEvent = <K extends WorkspaceEngine.Event['_tag']>(
  engine: WorkspaceEngine.WorkspaceEngine,
  tag: K,
) =>
  Effect.gen(function* () {
    while (true) {
      const event = yield* Queue.take(engine.events)
      if (event._tag === tag) return event
    }
  })

const unacknowledgingWorker = Effect.fnUntraced(function* (
  epoch: WorkerEpoch.WorkerEpoch,
  retired: Array<number>,
): Effect.fn.Return<ProjectWorker.ProjectWorker> {
  const messages = yield* Queue.unbounded<WorkerProtocol.WorkerMessage>()
  const exited = yield* Deferred.make<number>()
  let stopped = false
  const send = Effect.fnUntraced(function* (message: WorkerProtocol.HostMessage) {
    switch (message._tag) {
      case 'Initialize':
        yield* Queue.offer(messages, {
          protocolVersion: WorkerProtocol.version,
          _tag: 'Ready',
          epoch,
        })
        return
      case 'Analyze':
        yield* Queue.offer(messages, {
          protocolVersion: WorkerProtocol.version,
          _tag: 'Progress',
          epoch,
          generation: message.generation,
          phase: 'analysis',
        })
        return
      case 'SupersedeAnalysis':
      case 'Query':
      case 'CancelQuery':
      case 'Shutdown':
        return
    }
  })
  const terminate = Effect.fnUntraced(function* () {
    if (stopped) return
    stopped = true
    retired.push(epoch.value)
    yield* Deferred.succeed(exited, 1)
  })
  return Object.freeze({
    _tag: 'ProjectWorker',
    epoch,
    send,
    take: Queue.take(messages),
    shutdown: send({ protocolVersion: WorkerProtocol.version, _tag: 'Shutdown', epoch }),
    terminate: terminate(),
    awaitExit: Deferred.await(exited),
  })
})

it('accepts source versions synchronously and rejects delayed regressions', () => {
  const ledger = SourceLedger.make()
  const mutable = encoder.encode('version 1')
  const first = SourceLedger.accept(ledger, SourceEvent.open(uri, DocumentVersion.make(1), mutable))
  assert.isTrue(Result.isSuccess(first))
  mutable.fill(0)
  assert.strictEqual(new TextDecoder().decode(SourceLedger.get(ledger, uri)?.bytes), 'version 1')

  for (let version = 2; version <= 100; version += 1) {
    const accepted = SourceLedger.accept(
      ledger,
      SourceEvent.change(uri, DocumentVersion.make(version), encoder.encode(`version ${version}`)),
    )
    assert.isTrue(Result.isSuccess(accepted))
  }
  const delayed = SourceLedger.accept(
    ledger,
    SourceEvent.change(uri, DocumentVersion.make(29), encoder.encode('delayed')),
  )
  assert.isTrue(Result.isFailure(delayed))
  assert.strictEqual(SourceLedger.get(ledger, uri)?.version.value, 100)
  assert.strictEqual(new TextDecoder().decode(SourceLedger.get(ledger, uri)?.bytes), 'version 100')
})

it.effect('captures accepted text immediately and coalesces a burst to the newest generation', () =>
  Effect.gen(function* () {
    const versions: Array<ReadonlyArray<number>> = []
    const engine = yield* makeEngine(
      Effect.fnUntraced(function* (documents, previous) {
        versions.push(documents.map((self) => self.version))
        return yield* analyzed(documents, previous)
      }),
    )
    assert.isTrue(Result.isSuccess(engine.accept(open(1, 'pub fn main() -> i32 { return 1 }'))))
    for (let version = 2; version <= 100; version += 1)
      assert.isTrue(
        Result.isSuccess(
          engine.accept(change(version, `pub fn main() -> i32 { return ${version} }`)),
        ),
      )
    assert.isTrue(engine.accepted([{ uri, version: 100 }]))
    assert.isFalse(engine.accepted([{ uri, version: 99 }]))
    assert.isTrue(Result.isFailure(engine.accept(change(29, 'pub fn main() -> i32 { return 29 }'))))

    yield* Effect.yieldNow
    yield* TestClock.adjust(10)
    yield* nextEvent(engine, 'Committed')
    assert.deepEqual(versions, [[100]])
    const diagnostics = yield* engine.request({ _tag: 'Diagnostics', uri, parameters: {} })
    assert.strictEqual(diagnostics._tag, 'Ready')
    yield* engine.shutdown
  }),
)

it.effect('returns immediately when the current commit has no view for the document', () =>
  Effect.gen(function* () {
    const engine = yield* makeEngine(() => Effect.succeed(new Map()))
    assert.isTrue(Result.isSuccess(engine.accept(open(1, 'pub fn main() -> i32 { return 1 }'))))
    yield* Effect.yieldNow
    yield* TestClock.adjust(10)
    yield* nextEvent(engine, 'Committed')

    const result = yield* engine.request({
      _tag: 'Hover',
      uri,
      parameters: { line: 0, character: 7 },
    })
    assert.strictEqual(result._tag, 'Unavailable')
    yield* engine.shutdown
  }),
)

it.effect('returns immediately when the current generation already failed', () =>
  Effect.gen(function* () {
    const engine = yield* makeEngine(() => Effect.die('controlled analysis defect'), {
      failureLimit: 1,
    })
    assert.isTrue(Result.isSuccess(engine.accept(open(1, 'pub fn main() -> i32 { return 1 }'))))
    yield* Effect.yieldNow
    yield* TestClock.adjust(10)
    yield* nextEvent(engine, 'Failed')

    const result = yield* engine.request({
      _tag: 'Hover',
      uri,
      parameters: { line: 0, character: 7 },
    })
    assert.strictEqual(result._tag, 'AnalysisFailed')
    yield* engine.shutdown
  }),
)

it.effect('supersedes a pending request and commits only the newest accepted source', () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const analyzedVersions: Array<number> = []
    const engine = yield* makeEngine(
      Effect.fnUntraced(function* (documents, previous) {
        const version = documents.at(0)?.version
        if (version !== undefined) analyzedVersions.push(version)
        if (version === 1) {
          yield* Deferred.succeed(started, undefined)
          yield* Deferred.await(release)
        }
        return yield* analyzed(documents, previous)
      }),
    )
    assert.isTrue(Result.isSuccess(engine.accept(open(1, 'pub fn main() -> i32 { return 1 }'))))
    yield* Effect.yieldNow
    yield* TestClock.adjust(10)
    yield* Deferred.await(started)
    const pending = yield* Effect.forkChild(
      engine.request({ _tag: 'Hover', uri, parameters: { line: 0, character: 7 } }),
      { startImmediately: true },
    )
    yield* Effect.yieldNow

    assert.isTrue(Result.isSuccess(engine.accept(change(2, 'pub fn main() -> i32 { return 2 }'))))
    assert.strictEqual((yield* Fiber.join(pending))._tag, 'Superseded')
    yield* Effect.yieldNow
    yield* TestClock.adjust(10)
    yield* nextEvent(engine, 'Committed')
    assert.deepEqual(analyzedVersions, [1, 2])
    yield* engine.shutdown
  }),
)

it.effect('supersedes an old-profile analysis and its pending query without a source edit', () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    let target = 'aarch64-apple-darwin'
    const observed: Array<unknown> = []
    const engine = yield* WorkspaceEngine.make({
      discover: (entry) =>
        Effect.succeed(Document.make({ ...document(entry), configuration: { target } })),
      workerFactory: factory(
        Effect.fnUntraced(function* (documents, previous) {
          observed.push(documents[0]?.configuration)
          if (observed.length === 1) {
            yield* Deferred.succeed(started, undefined)
            yield* Deferred.await(release)
          }
          return yield* analyzed(documents, previous)
        }),
      ),
      policy: { debounce: 10, queryDeadline: 100, diagnosticDeadline: 100 },
    })
    engine.accept(open(1, 'pub fn main() -> i32 { return 42 }'))
    yield* Effect.yieldNow
    yield* TestClock.adjust(10)
    yield* Deferred.await(started)
    const pending = yield* Effect.forkChild(
      engine.request({ _tag: 'Diagnostics', uri, parameters: {} }),
      { startImmediately: true },
    )
    target = 'wasm32-unknown-unknown'
    engine.accept(SourceEvent.invalidate([], true))
    assert.strictEqual((yield* Fiber.join(pending))._tag, 'Superseded')
    yield* Effect.yieldNow
    yield* TestClock.adjust(10)
    yield* nextEvent(engine, 'Committed')
    assert.deepEqual(observed, [
      { target: 'aarch64-apple-darwin' },
      { target: 'wasm32-unknown-unknown' },
    ])
    yield* engine.shutdown
  }),
)

it.effect('binds an immediate semantic request to the just-accepted document version', () =>
  Effect.gen(function* () {
    const engine = yield* makeEngine()
    assert.isTrue(Result.isSuccess(engine.accept(open(1, 'pub fn before() -> i32 { return 1 }'))))
    yield* Effect.yieldNow
    yield* TestClock.adjust(10)
    yield* nextEvent(engine, 'Committed')

    assert.isTrue(Result.isSuccess(engine.accept(change(2, 'pub fn after() -> i32 { return 2 }'))))
    const request = yield* Effect.forkChild(
      engine.request({ _tag: 'Symbols', uri, parameters: undefined }),
      { startImmediately: true },
    )
    yield* Effect.yieldNow
    yield* TestClock.adjust(10)
    const outcome = yield* Fiber.join(request)
    assert.strictEqual(outcome._tag, 'Ready')
    if (outcome._tag === 'Ready')
      assert.deepEqual(
        outcome.value.map((item) => item.name),
        ['after'],
      )
    yield* engine.shutdown
  }),
)

it.effect('a query deadline releases only the caller and leaves healthy analysis running', () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const engine = yield* makeEngine(
      Effect.fnUntraced(function* (documents, previous) {
        yield* Deferred.succeed(started, undefined)
        yield* Deferred.await(release)
        return yield* analyzed(documents, previous)
      }),
      { queryDeadline: 20, noProgressLease: 1_000 },
    )
    assert.isTrue(Result.isSuccess(engine.accept(open(1, 'pub fn main() -> i32 { return 1 }'))))
    yield* Effect.yieldNow
    yield* TestClock.adjust(10)
    yield* Deferred.await(started)
    const pending = yield* Effect.forkChild(
      engine.request({ _tag: 'Hover', uri, parameters: { line: 0, character: 7 } }),
      { startImmediately: true },
    )
    yield* TestClock.adjust(20)
    assert.strictEqual((yield* Fiber.join(pending))._tag, 'DeadlineExceeded')

    yield* Deferred.succeed(release, undefined)
    yield* nextEvent(engine, 'Committed')
    const current = yield* engine.request({
      _tag: 'Hover',
      uri,
      parameters: { line: 0, character: 7 },
    })
    assert.strictEqual(current._tag, 'Ready')
    yield* engine.shutdown
  }),
)

it.effect('fiber interruption removes a pending query without affecting the generation', () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const engine = yield* makeEngine(
      Effect.fnUntraced(function* (documents, previous) {
        yield* Deferred.succeed(started, undefined)
        yield* Deferred.await(release)
        return yield* analyzed(documents, previous)
      }),
      { noProgressLease: 1_000 },
    )
    assert.isTrue(Result.isSuccess(engine.accept(open(1, 'pub fn main() -> i32 { return 1 }'))))
    yield* Effect.yieldNow
    yield* TestClock.adjust(10)
    yield* Deferred.await(started)
    const pending = yield* Effect.forkChild(
      engine.request({
        _tag: 'CodeActions',
        uri,
        parameters: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 39 },
        },
      }),
      { startImmediately: true },
    )
    yield* Effect.yieldNow
    yield* Fiber.interrupt(pending)
    yield* Deferred.succeed(release, undefined)
    yield* nextEvent(engine, 'Committed')
    const current = yield* engine.request({ _tag: 'Symbols', uri, parameters: undefined })
    assert.strictEqual(current._tag, 'Ready')
    yield* engine.shutdown
  }),
)

it.effect(
  'fiber interruption cancels an executing worker query and ignores its late completion',
  () =>
    Effect.gen(function* () {
      const queryStarted = yield* Deferred.make<void>()
      const releaseQuery = yield* Deferred.make<void>()
      let queryCount = 0
      const engine = yield* WorkspaceEngine.make({
        discover: (entry) => Effect.succeed(document(entry)),
        workerFactory: {
          spawn: (epoch) =>
            ProjectWorker.makeInProcess({
              epoch,
              analyze: analyzed,
              beforeQuery: Effect.fnUntraced(function* () {
                queryCount += 1
                if (queryCount !== 1) return
                yield* Deferred.succeed(queryStarted, undefined)
                yield* Deferred.await(releaseQuery)
              }),
            }),
        },
        policy: { debounce: 10, queryDeadline: 100, noProgressLease: 1_000 },
      })
      assert.isTrue(Result.isSuccess(engine.accept(open(1, 'pub fn main() -> i32 { return 1 }'))))
      yield* Effect.yieldNow
      yield* TestClock.adjust(10)
      yield* nextEvent(engine, 'Committed')

      const executing = yield* Effect.forkChild(
        engine.request({ _tag: 'Hover', uri, parameters: { line: 0, character: 7 } }),
        { startImmediately: true },
      )
      yield* Deferred.await(queryStarted)
      yield* Fiber.interrupt(executing)
      yield* Deferred.succeed(releaseQuery, undefined)
      yield* Effect.yieldNow
      const current = yield* engine.request({ _tag: 'Symbols', uri, parameters: undefined })
      assert.strictEqual(current._tag, 'Ready')
      assert.strictEqual(queryCount, 2)
      yield* engine.shutdown
    }),
)

it.effect('coalesces cold discovery and terminally settles provisional requests', () =>
  Effect.gen(function* () {
    const discoveryStarted = yield* Deferred.make<void>()
    const releaseDiscovery = yield* Deferred.make<void>()
    const discoveredVersions: Array<number> = []
    const engine = yield* WorkspaceEngine.make({
      discover: Effect.fnUntraced(function* (entry) {
        discoveredVersions.push(entry.version.value)
        if (discoveredVersions.length === 1) {
          yield* Deferred.succeed(discoveryStarted, undefined)
          yield* Deferred.await(releaseDiscovery)
        }
        return document(entry)
      }),
      workerFactory: factory(),
      policy: { debounce: 10, queryDeadline: 100, diagnosticDeadline: 100 },
    })
    assert.isTrue(Result.isSuccess(engine.accept(open(1, 'pub fn old() -> i32 { return 1 }'))))
    yield* Deferred.await(discoveryStarted)
    const first = yield* Effect.forkChild(
      engine.request({ _tag: 'Hover', uri, parameters: { line: 0, character: 7 } }),
      { startImmediately: true },
    )
    assert.isTrue(Result.isSuccess(engine.accept(change(2, 'pub fn middle() -> i32 { return 2 }'))))
    const middle = yield* Effect.forkChild(
      engine.request({ _tag: 'Diagnostics', uri, parameters: {} }),
      { startImmediately: true },
    )
    assert.isTrue(Result.isSuccess(engine.accept(change(3, 'pub fn newest() -> i32 { return 3 }'))))
    yield* Deferred.succeed(releaseDiscovery, undefined)
    assert.strictEqual((yield* Fiber.join(first))._tag, 'Superseded')
    assert.strictEqual((yield* Fiber.join(middle))._tag, 'Superseded')
    yield* Effect.yieldNow
    yield* TestClock.adjust(10)
    yield* nextEvent(engine, 'Committed')
    assert.deepEqual(discoveredVersions, [1, 3])
    const symbols = yield* engine.request({ _tag: 'Symbols', uri, parameters: undefined })
    assert.strictEqual(symbols._tag, 'Ready')
    if (symbols._tag === 'Ready')
      assert.deepEqual(
        symbols.value.map((item) => item.name),
        ['newest'],
      )
    yield* engine.shutdown
  }),
)

it.effect('discards discovery captured before a profile change at the same source version', () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    let target = 'aarch64-apple-darwin'
    let discoveries = 0
    const observed: Array<unknown> = []
    const engine = yield* WorkspaceEngine.make({
      discover: Effect.fnUntraced(function* (entry) {
        const configuration = { target }
        discoveries += 1
        if (discoveries === 1) {
          yield* Deferred.succeed(started, undefined)
          yield* Deferred.await(release)
        }
        return Document.make({ ...document(entry), configuration })
      }),
      workerFactory: factory(
        Effect.fnUntraced(function* (documents, previous) {
          observed.push(documents[0]?.configuration)
          return yield* analyzed(documents, previous)
        }),
      ),
      policy: { debounce: 10, queryDeadline: 100, diagnosticDeadline: 100 },
    })
    engine.accept(open(1, 'pub fn main() -> i32 { return 42 }'))
    yield* Deferred.await(started)
    target = 'wasm32-unknown-unknown'
    engine.accept(SourceEvent.invalidate([], true))
    yield* Deferred.succeed(release, undefined)
    yield* Effect.yieldNow
    yield* TestClock.adjust(10)
    yield* nextEvent(engine, 'Committed')
    assert.deepEqual(observed, [{ target: 'wasm32-unknown-unknown' }])
    assert.strictEqual(discoveries, 2)
    yield* engine.shutdown
  }),
)

it.effect('atomically supersedes pending work when discovery reassigns a project', () =>
  Effect.gen(function* () {
    let identity = 'project:/workspace/old.silk.toml'
    const analyzedProjects: Array<string> = []
    const engine = yield* WorkspaceEngine.make({
      discover: (entry) => Effect.succeed(documentIn(entry, identity, 'Main')),
      workerFactory: {
        spawn: (epoch) =>
          ProjectWorker.makeInProcess({
            epoch,
            analyze: Effect.fnUntraced(function* (documents, previous) {
              const project = documents.at(0)?.workspace
              if (project !== undefined) analyzedProjects.push(project)
              return yield* analyzed(documents, previous)
            }),
          }),
      },
      policy: { debounce: 10, queryDeadline: 100, diagnosticDeadline: 100 },
    })
    assert.isTrue(Result.isSuccess(engine.accept(open(1, 'pub fn main() -> i32 { return 1 }'))))
    yield* Effect.yieldNow
    yield* TestClock.adjust(10)
    yield* nextEvent(engine, 'Committed')

    identity = 'project:/workspace/new.silk.toml'
    assert.isTrue(
      Result.isSuccess(engine.accept(SourceEvent.invalidate(['/workspace/silk.toml'], true))),
    )
    const pending = yield* Effect.forkChild(
      engine.request({ _tag: 'Diagnostics', uri, parameters: {} }),
      { startImmediately: true },
    )
    yield* Effect.yieldNow
    assert.strictEqual((yield* Fiber.join(pending))._tag, 'Superseded')
    yield* TestClock.adjust(10)
    yield* nextEvent(engine, 'Committed')
    const current = yield* engine.request({ _tag: 'Symbols', uri, parameters: undefined })
    assert.strictEqual(current._tag, 'Ready')
    assert.deepEqual(analyzedProjects, [
      'project:/workspace/old.silk.toml',
      'project:/workspace/new.silk.toml',
    ])
    yield* engine.shutdown
  }),
)

it.effect('allows worker startup beyond the independent retirement deadline', () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    let spawns = 0
    const engine = yield* WorkspaceEngine.make({
      discover: (entry) => Effect.succeed(document(entry)),
      workerFactory: {
        spawn: Effect.fnUntraced(function* (epoch) {
          spawns += 1
          const worker = yield* ProjectWorker.makeInProcess({ epoch, analyze: analyzed })
          return {
            ...worker,
            take: worker.take.pipe(
              Effect.tap(
                Effect.fnUntraced(function* (message) {
                  if (message._tag !== 'Ready') return
                  yield* Deferred.succeed(entered, undefined)
                  yield* Deferred.await(release)
                }),
              ),
            ),
          }
        }),
      },
      policy: { debounce: 10, startupDeadline: 100, retirementDeadline: 10 },
    })
    assert.isTrue(Result.isSuccess(engine.accept(open(1, 'pub fn main() -> i32 { return 42 }'))))
    yield* TestClock.adjust(10)
    yield* Deferred.await(entered)
    yield* TestClock.adjust(20)
    yield* Deferred.succeed(release, undefined)
    yield* nextEvent(engine, 'Committed')
    assert.strictEqual(spawns, 1)
    yield* engine.shutdown
  }),
)

it.effect('retains a healthy worker through cold source-runtime analysis', () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    let spawns = 0
    const engine = yield* WorkspaceEngine.make({
      discover: (entry) => Effect.succeed(document(entry)),
      workerFactory: {
        spawn: (epoch) => {
          spawns += 1
          return ProjectWorker.makeInProcess({
            epoch,
            analyze: Effect.fnUntraced(function* (documents, previous) {
              yield* Deferred.succeed(entered, undefined)
              yield* Deferred.await(release)
              return yield* analyzed(documents, previous)
            }),
          })
        },
      },
      policy: { debounce: 10 },
    })
    assert.isTrue(Result.isSuccess(engine.accept(open(1, 'pub fn main() -> i32 { return 42 }'))))
    yield* TestClock.adjust(10)
    yield* Deferred.await(entered)
    yield* TestClock.adjust(15_000)
    yield* TestClock.adjust(10)
    assert.strictEqual(spawns, 1)
    yield* Deferred.succeed(release, undefined)
    yield* nextEvent(engine, 'Committed')
    assert.strictEqual(spawns, 1)
    yield* engine.shutdown
  }),
)

it.effect('retires a no-progress worker and reconstructs the newest source on a replacement', () =>
  Effect.gen(function* () {
    let spawns = 0
    const engine = yield* WorkspaceEngine.make({
      discover: (entry) => Effect.succeed(document(entry)),
      workerFactory: {
        spawn: (epoch) => {
          spawns += 1
          return ProjectWorker.makeInProcess({
            epoch,
            analyze: spawns === 1 ? () => Effect.never : analyzed,
          })
        },
      },
      policy: {
        debounce: 10,
        noProgressLease: 20,
        retirementDeadline: 10,
        queryDeadline: 100,
      },
    })
    assert.isTrue(Result.isSuccess(engine.accept(open(1, 'pub fn main() -> i32 { return 1 }'))))
    yield* Effect.yieldNow
    yield* TestClock.adjust(10)
    yield* Effect.yieldNow
    yield* TestClock.adjust(20)
    yield* Effect.yieldNow
    const failed = yield* nextEvent(engine, 'Failed')
    assert.strictEqual(failed._tag, 'Failed')
    const retired = yield* nextEvent(engine, 'WorkerRetired')
    assert.strictEqual(retired._tag, 'WorkerRetired')
    if (retired._tag === 'WorkerRetired') assert.strictEqual(retired.reason, 'NoProgress')
    yield* Effect.yieldNow
    yield* TestClock.adjust(10)
    yield* nextEvent(engine, 'Committed')
    assert.strictEqual(spawns, 2)
    const result = yield* engine.request({ _tag: 'Symbols', uri, parameters: undefined })
    assert.strictEqual(result._tag, 'Ready')
    yield* engine.shutdown
  }),
)

it.effect(
  'bounds repeated worker defects with a circuit and one half-open attempt per new source',
  () =>
    Effect.gen(function* () {
      let spawns = 0
      let succeeds = false
      const engine = yield* WorkspaceEngine.make({
        discover: (entry) => Effect.succeed(document(entry)),
        workerFactory: {
          spawn: (epoch) => {
            spawns += 1
            return ProjectWorker.makeInProcess({
              epoch,
              analyze: (documents, previous) =>
                succeeds ? analyzed(documents, previous) : Effect.die('controlled worker defect'),
            })
          },
        },
        policy: {
          debounce: 10,
          failureLimit: 3,
          retirementDeadline: 10,
          queryDeadline: 100,
        },
      })
      assert.isTrue(Result.isSuccess(engine.accept(open(1, 'pub fn main() -> i32 { return 1 }'))))
      yield* Effect.yieldNow
      for (let failure = 1; failure <= 3; failure += 1) {
        yield* TestClock.adjust(10)
        yield* nextEvent(engine, 'Failed')
        yield* nextEvent(engine, 'WorkerRetired')
        yield* Effect.yieldNow
      }
      assert.strictEqual(spawns, 3)
      const openCircuit = yield* engine.request({
        _tag: 'Hover',
        uri,
        parameters: { line: 0, character: 7 },
      })
      assert.strictEqual(openCircuit._tag, 'AnalysisFailed')

      assert.isTrue(Result.isSuccess(engine.accept(change(2, 'pub fn main() -> i32 { return 2 }'))))
      yield* Effect.yieldNow
      yield* TestClock.adjust(10)
      yield* nextEvent(engine, 'Failed')
      yield* nextEvent(engine, 'WorkerRetired')
      assert.strictEqual(spawns, 4)

      succeeds = true
      assert.isTrue(Result.isSuccess(engine.accept(change(3, 'pub fn main() -> i32 { return 3 }'))))
      yield* Effect.yieldNow
      yield* TestClock.adjust(10)
      yield* nextEvent(engine, 'Committed')
      assert.strictEqual(spawns, 5)
      const recovered = yield* engine.request({ _tag: 'Symbols', uri, parameters: undefined })
      assert.strictEqual(recovered._tag, 'Ready')
      yield* engine.shutdown
    }),
)

it.effect('forces retirement when superseded work does not acknowledge its lease', () =>
  Effect.gen(function* () {
    let spawns = 0
    const forced: Array<number> = []
    const engine = yield* WorkspaceEngine.make({
      discover: (entry) => Effect.succeed(document(entry)),
      workerFactory: {
        spawn: (epoch) => {
          spawns += 1
          return spawns === 1
            ? unacknowledgingWorker(epoch, forced)
            : ProjectWorker.makeInProcess({ epoch, analyze: analyzed })
        },
      },
      policy: {
        debounce: 10,
        supersededLease: 10,
        retirementDeadline: 10,
        noProgressLease: 1_000,
        queryDeadline: 100,
      },
    })
    assert.isTrue(Result.isSuccess(engine.accept(open(1, 'pub fn main() -> i32 { return 1 }'))))
    yield* Effect.yieldNow
    yield* TestClock.adjust(10)
    yield* Effect.yieldNow
    assert.isTrue(Result.isSuccess(engine.accept(change(2, 'pub fn main() -> i32 { return 2 }'))))
    yield* Effect.yieldNow
    yield* TestClock.adjust(10)
    yield* Effect.yieldNow
    yield* TestClock.adjust(10)
    const retired = yield* nextEvent(engine, 'WorkerRetired')
    assert.strictEqual(retired._tag, 'WorkerRetired')
    if (retired._tag === 'WorkerRetired') assert.strictEqual(retired.reason, 'Superseded')
    assert.deepEqual(forced, [1])
    yield* Effect.yieldNow
    yield* TestClock.adjust(10)
    yield* nextEvent(engine, 'Committed')
    assert.strictEqual(spawns, 2)
    yield* engine.shutdown
  }),
)

it.effect('merges simultaneous cold opens for one manifest into one project generation', () =>
  Effect.gen(function* () {
    const utilUri = 'file:///workspace/Util.silk'
    let spawns = 0
    const analyzedModules: Array<ReadonlyArray<string>> = []
    const engine = yield* WorkspaceEngine.make({
      discover: (entry) =>
        Effect.succeed(documentIn(entry, workspace, entry.uri === uri ? 'Main' : 'Util')),
      workerFactory: {
        spawn: (epoch) => {
          spawns += 1
          return ProjectWorker.makeInProcess({
            epoch,
            analyze: Effect.fnUntraced(function* (documents, previous) {
              analyzedModules.push(documents.map((self) => self.module).sort())
              return yield* analyzed(documents, previous)
            }),
          })
        },
      },
      policy: { debounce: 10, queryDeadline: 100 },
    })
    assert.isTrue(Result.isSuccess(engine.accept(open(1, 'pub fn main() -> i32 { return 1 }'))))
    assert.isTrue(
      Result.isSuccess(
        engine.accept(
          SourceEvent.open(
            utilUri,
            DocumentVersion.make(1),
            encoder.encode('pub fn utility() -> i32 { return 2 }'),
          ),
        ),
      ),
    )
    yield* Effect.yieldNow
    yield* TestClock.adjust(10)
    yield* nextEvent(engine, 'Committed')
    assert.strictEqual(spawns, 1)
    assert.deepEqual(analyzedModules, [['Main', 'Util']])
    const utility = yield* engine.request({ _tag: 'Symbols', uri: utilUri, parameters: undefined })
    assert.strictEqual(utility._tag, 'Ready')
    yield* engine.shutdown
  }),
)

it.effect(
  'commits before observer delivery and keeps incremental reuse independent of the stream',
  () =>
    Effect.gen(function* () {
      const priorVersions: Array<ReadonlyArray<number>> = []
      const engine = yield* makeEngine(
        Effect.fnUntraced(function* (documents, previous) {
          priorVersions.push([...previous.values()].map((entry) => entry.document.version))
          return yield* analyzed(documents, previous)
        }),
      )
      assert.isTrue(Result.isSuccess(engine.accept(open(1, 'pub fn first() -> i32 { return 1 }'))))
      yield* Effect.yieldNow
      yield* TestClock.adjust(10)
      yield* Effect.yieldNow
      const first = yield* engine.request({ _tag: 'Symbols', uri, parameters: undefined })
      assert.strictEqual(first._tag, 'Ready')

      assert.isTrue(
        Result.isSuccess(engine.accept(change(2, 'pub fn second() -> i32 { return 2 }'))),
      )
      yield* Effect.yieldNow
      yield* TestClock.adjust(10)
      yield* Effect.yieldNow
      const second = yield* engine.request({ _tag: 'Symbols', uri, parameters: undefined })
      assert.strictEqual(second._tag, 'Ready')
      if (second._tag === 'Ready')
        assert.deepEqual(
          second.value.map((item) => item.name),
          ['second'],
        )
      assert.deepEqual(priorVersions, [[], [1]])
      assert.strictEqual(
        (yield* Queue.clear(engine.events)).filter((event) => event._tag === 'Committed').length,
        2,
      )
      yield* engine.shutdown
    }),
)

it.effect('invalidates only the project containing a changed dependency path', () =>
  Effect.gen(function* () {
    const uriB = 'file:///workspace-b/Main.silk'
    const analyses = new Map<string, number>()
    const engine = yield* WorkspaceEngine.make({
      discover: (entry) => {
        const second = entry.uri === uriB
        return Effect.succeed(
          documentIn(
            entry,
            second ? 'project:/workspace-b/silk.toml' : 'project:/workspace-a/silk.toml',
            'Main',
            second ? '/workspace-b' : '/workspace-a',
          ),
        )
      },
      workerFactory: {
        spawn: (epoch) =>
          ProjectWorker.makeInProcess({
            epoch,
            analyze: Effect.fnUntraced(function* (documents, previous) {
              const project = documents.at(0)?.workspace
              if (project !== undefined) analyses.set(project, (analyses.get(project) ?? 0) + 1)
              return yield* analyzed(documents, previous)
            }),
          }),
      },
      policy: { debounce: 10, queryDeadline: 100 },
    })
    assert.isTrue(Result.isSuccess(engine.accept(open(1, 'pub fn main() -> i32 { return 1 }'))))
    assert.isTrue(
      Result.isSuccess(
        engine.accept(
          SourceEvent.open(
            uriB,
            DocumentVersion.make(1),
            encoder.encode('pub fn main() -> i32 { return 2 }'),
          ),
        ),
      ),
    )
    yield* Effect.yieldNow
    yield* TestClock.adjust(10)
    yield* nextEvent(engine, 'Committed')
    yield* nextEvent(engine, 'Committed')
    assert.deepEqual(
      [...analyses.values()].sort((left, right) => left - right),
      [1, 1],
    )

    assert.isTrue(
      Result.isSuccess(engine.accept(SourceEvent.invalidate(['/workspace-a/Dependency.silk']))),
    )
    yield* Effect.yieldNow
    yield* TestClock.adjust(10)
    const changed = yield* nextEvent(engine, 'Committed')
    assert.strictEqual(changed.workspace, 'project:/workspace-a/silk.toml')
    assert.strictEqual(analyses.get('project:/workspace-a/silk.toml'), 2)
    assert.strictEqual(analyses.get('project:/workspace-b/silk.toml'), 1)
    const healthyB = yield* engine.request({ _tag: 'Symbols', uri: uriB, parameters: undefined })
    assert.strictEqual(healthyB._tag, 'Ready')
    yield* engine.shutdown
  }),
)

it.effect('settles pending discovery and analysis during bounded shutdown', () =>
  Effect.gen(function* () {
    const discoveryStarted = yield* Deferred.make<void>()
    const engine = yield* WorkspaceEngine.make({
      discover: Effect.fnUntraced(function* (_entry) {
        yield* Deferred.succeed(discoveryStarted, undefined)
        return yield* Effect.never
      }),
      workerFactory: factory(),
      policy: { debounce: 10, retirementDeadline: 10, queryDeadline: 100 },
    })
    assert.isTrue(Result.isSuccess(engine.accept(open(1, 'pub fn main() -> i32 { return 1 }'))))
    yield* Deferred.await(discoveryStarted)
    const request = yield* Effect.forkChild(
      engine.request({ _tag: 'Hover', uri, parameters: { line: 0, character: 7 } }),
      { startImmediately: true },
    )
    yield* Effect.yieldNow
    yield* engine.shutdown
    assert.strictEqual((yield* Fiber.join(request))._tag, 'Closed')
    assert.isTrue(Result.isFailure(engine.accept(change(2, 'pub fn main() -> i32 { return 2 }'))))
  }),
)

it.effect('interrupts active analysis and canceled requests exactly once during shutdown', () =>
  Effect.gen(function* () {
    const analysisStarted = yield* Deferred.make<void>()
    const engine = yield* makeEngine(
      Effect.fnUntraced(function* () {
        yield* Deferred.succeed(analysisStarted, undefined)
        return yield* Effect.never
      }),
      { retirementDeadline: 10, noProgressLease: 1_000 },
    )
    assert.isTrue(Result.isSuccess(engine.accept(open(1, 'pub fn main() -> i32 { return 1 }'))))
    yield* Effect.yieldNow
    yield* TestClock.adjust(10)
    yield* Deferred.await(analysisStarted)
    const request = yield* Effect.forkChild(
      engine.request({ _tag: 'Hover', uri, parameters: { line: 0, character: 7 } }),
      { startImmediately: true },
    )
    yield* Effect.yieldNow
    yield* Fiber.interrupt(request)
    yield* engine.shutdown
    yield* engine.shutdown
  }),
)

it.effect('never lets an intermediate spelling become the final diagnostic revision', () =>
  Effect.gen(function* () {
    const engine = yield* makeEngine()
    const source = (line: string) => `import silk.vector { Vector }
fn outer() -> Effect<'static; i32> {
  let n = 123
  return effect { return n }
}
pub fn main() -> i32 {
  let mut m = Vector.make<i32>()
${line}
  return run outer()
}`
    assert.isTrue(Result.isSuccess(engine.accept(open(1, source('')))))
    yield* Effect.yieldNow
    yield* TestClock.adjust(10)
    yield* nextEvent(engine, 'Committed')

    const obsolete: Array<Fiber.Fiber<unknown>> = []
    let version = 1
    for (const spelling of ['  effects', '  effec', '  Effect.']) {
      version += 1
      assert.isTrue(Result.isSuccess(engine.accept(change(version, source(spelling)))))
      obsolete.push(
        yield* Effect.forkChild(engine.request({ _tag: 'Diagnostics', uri, parameters: {} }), {
          startImmediately: true,
        }),
        yield* Effect.forkChild(
          engine.request({ _tag: 'Hover', uri, parameters: { line: 7, character: 5 } }),
          {
            startImmediately: true,
          },
        ),
        yield* Effect.forkChild(
          engine.request({ _tag: 'Completion', uri, parameters: { line: 7, character: 5 } }),
          {
            startImmediately: true,
          },
        ),
        yield* Effect.forkChild(
          engine.request({
            _tag: 'CodeActions',
            uri,
            parameters: { start: { line: 7, character: 0 }, end: { line: 7, character: 10 } },
          }),
          { startImmediately: true },
        ),
      )
      yield* Effect.yieldNow
    }

    version += 1
    assert.isTrue(Result.isSuccess(engine.accept(change(version, source('')))))
    for (const fiber of obsolete) {
      const exit = yield* Fiber.join(fiber)
      assert.isTrue(
        typeof exit === 'object' && exit !== null && '_tag' in exit && exit._tag === 'Superseded',
      )
    }
    const finalPull = yield* Effect.forkChild(
      engine.request({ _tag: 'Diagnostics', uri, parameters: {} }),
      { startImmediately: true },
    )
    yield* Effect.yieldNow
    yield* TestClock.adjust(10)
    const final = yield* Fiber.join(finalPull)
    assert.strictEqual(final._tag, 'Ready')
    if (final._tag === 'Ready') {
      assert.notInclude(final.value.items.map((item) => item.message).join('\n'), 'effec')
      assert.deepEqual(final.value.items, [])
    }
    yield* engine.shutdown
  }),
)
