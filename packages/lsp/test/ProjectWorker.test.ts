import { assert, it } from '@effect/vitest'
import * as ProjectAnalysis from '@silklang/compiler/ProjectAnalysis'
import * as SourceFile from '@silklang/compiler/SourceFile'
import * as SourceResolver from '@silklang/compiler/SourceResolver'
import * as WorkspaceInventory from '@silklang/compiler/WorkspaceInventory'
import * as WorkspaceCatalog from '../src/WorkspaceCatalog.js'
import * as Deferred from 'effect/Deferred'
import * as Arr from 'effect/Array'
import * as Effect from 'effect/Effect'
import * as Inspectable from 'effect/Inspectable'
import * as Result from 'effect/Result'
import { SymbolKind } from 'vscode-languageserver-types'
import type * as Document from '../src/Document.js'
import * as DocumentVersion from '../src/DocumentVersion.js'
import type * as EditorQuery from '../src/EditorQuery.js'
import * as ProjectGeneration from '../src/ProjectGeneration.js'
import type * as ProjectSnapshot from '../src/ProjectSnapshot.js'
import * as ProjectWorker from '../src/ProjectWorker.js'
import * as RequestId from '../src/RequestId.js'
import * as WorkerEpoch from '../src/WorkerEpoch.js'
import * as WorkerProtocol from '../src/WorkerProtocol.js'

const encoder = new TextEncoder()
const uri = 'file:///workspace/Main.silk'
const workspace = 'project:/workspace/silk.toml'

const source = (version: number, text: string): WorkerProtocol.HostMessage => ({
  protocolVersion: WorkerProtocol.version,
  _tag: 'Analyze',
  epoch: WorkerEpoch.initial,
  generation: { _tag: 'ProjectGeneration', value: version },
  sources: [
    {
      uri,
      version: DocumentVersion.make(version),
      workspace,
      sourceRoot: '/workspace',
      module: 'Main',
      bytes: encoder.encode(text),
    },
  ],
  invalidation: { priorityUri: uri, dirtyPaths: [], rediscover: false },
})

const analyze = Effect.fnUntraced(function* (
  documents: ReadonlyArray<Document.Document>,
  previous: ReadonlyMap<string, ProjectSnapshot.DocumentSnapshot>,
) {
  if (!Arr.isReadonlyArrayNonEmpty(documents))
    return new Map<string, ProjectSnapshot.DocumentSnapshot>()
  const modules = Arr.map(documents, (document) => document.module)
  const roots = documents.map((document) => SourceFile.make(document.module, document.bytes))
  const previousProject = previous.values().next().value?.project
  const project = yield* (
    previousProject === undefined
      ? ProjectAnalysis.make(modules).pipe(Effect.provide(SourceResolver.overlay(roots)))
      : ProjectAnalysis.revise(previousProject, modules).pipe(
          Effect.provide(SourceResolver.overlay(roots)),
        )
  ).pipe(Effect.provide(SourceResolver.empty))
  const moduleUris = new Map(documents.map((document) => [document.module, document.uri]))
  const inventory = yield* WorkspaceCatalog.defer(Effect.sync(() => WorkspaceInventory.make()))
  const snapshots: Array<readonly [string, ProjectSnapshot.DocumentSnapshot]> = []
  for (const document of documents) {
    const snapshot = ProjectAnalysis.view(project, document.module)
    if (snapshot !== undefined)
      snapshots.push([
        document.uri,
        Object.freeze({ document, project, snapshot, moduleUris, inventory }),
      ])
  }
  return new Map(snapshots)
})

const take = Effect.fnUntraced(function* (
  worker: ProjectWorker.ProjectWorker,
  tag: WorkerProtocol.WorkerMessage['_tag'],
) {
  while (true) {
    const message = yield* worker.take
    if (message._tag === tag) return message
  }
})

const initialize = (worker: ProjectWorker.ProjectWorker) =>
  worker.send({
    protocolVersion: WorkerProtocol.version,
    _tag: 'Initialize',
    epoch: worker.epoch,
    workspace,
    sourceRoot: '/workspace',
  })

it.effect('owns one compiler snapshot and answers the complete editor query catalog', () =>
  Effect.gen(function* () {
    const worker = yield* ProjectWorker.makeInProcess({
      epoch: WorkerEpoch.initial,
      analyze: Effect.fnUntraced(function* (documents, previous, _invalidation, onProgress) {
        const snapshots = yield* analyze(documents, previous)
        yield* onProgress('ProjectAnalyzed')
        return snapshots
      }),
    })
    yield* initialize(worker)
    assert.strictEqual((yield* take(worker, 'Ready'))._tag, 'Ready')
    const generation = ProjectGeneration.next(ProjectGeneration.initial)
    yield* worker.send(
      source(
        generation.value,
        `fn answer(value: i32) -> i32 { return value }
pub fn main() -> i32 {
  let result = answer(42)
  return result
}`,
      ),
    )
    assert.strictEqual((yield* take(worker, 'Progress'))._tag, 'Progress')
    const progress = yield* worker.take
    assert.deepEqual(progress, {
      protocolVersion: WorkerProtocol.version,
      _tag: 'Progress',
      epoch: WorkerEpoch.initial,
      generation,
      phase: 'ProjectAnalyzed',
    })
    const commit = yield* take(worker, 'Commit')
    assert.strictEqual(commit._tag, 'Commit')

    const range = { start: { line: 0, character: 0 }, end: { line: 4, character: 1 } }
    const item = {
      name: 'main',
      kind: SymbolKind.Function,
      uri,
      range,
      selectionRange: { start: { line: 1, character: 7 }, end: { line: 1, character: 11 } },
    }
    const queries: ReadonlyArray<EditorQuery.EditorQuery> = [
      { _tag: 'Diagnostics', uri, parameters: {} },
      { _tag: 'Hover', uri, parameters: { line: 2, character: 22 } },
      { _tag: 'Completion', uri, parameters: { line: 2, character: 22 } },
      { _tag: 'SignatureHelp', uri, parameters: { line: 2, character: 22 } },
      { _tag: 'CodeActions', uri, parameters: range },
      { _tag: 'ResolveCodeAction', uri, parameters: { title: 'No edit' } },
      { _tag: 'Definition', uri, parameters: { line: 2, character: 17 } },
      {
        _tag: 'References',
        uri,
        parameters: { position: { line: 2, character: 17 }, includeDeclaration: true },
      },
      { _tag: 'PrepareRename', uri, parameters: { line: 2, character: 17 } },
      {
        _tag: 'Rename',
        uri,
        parameters: { position: { line: 2, character: 17 }, newName: 'compute' },
      },
      { _tag: 'InlayHints', uri, parameters: range },
      { _tag: 'Symbols', uri, parameters: undefined },
      { _tag: 'Formatting', uri, parameters: undefined },
      { _tag: 'SemanticTokens', uri, parameters: undefined },
      { _tag: 'FoldingRanges', uri, parameters: undefined },
      { _tag: 'PrepareCallHierarchy', uri, parameters: { line: 1, character: 8 } },
      { _tag: 'IncomingCalls', uri, parameters: item },
      { _tag: 'OutgoingCalls', uri, parameters: item },
      { _tag: 'Inspection', uri, parameters: { uri, view: 'not-a-view' } },
    ]

    let requestId = RequestId.initial
    for (const query of queries) {
      requestId = RequestId.next(requestId)
      yield* worker.send({
        protocolVersion: WorkerProtocol.version,
        _tag: 'Query',
        epoch: worker.epoch,
        generation,
        requestId,
        query,
      })
      const result = yield* take(worker, 'Result')
      if (result._tag !== 'Result') return yield* Effect.die('expected worker query result')
      assert.include(Inspectable.toStringUnknown(result.result), 'Ready')
    }
    yield* worker.shutdown
    assert.strictEqual((yield* take(worker, 'Stopped'))._tag, 'Stopped')
    assert.strictEqual(yield* worker.awaitExit, 0)
  }),
)

it.effect(
  'supersedes active analysis, preserves the last commit, and cancels blocked queries',
  () =>
    Effect.gen(function* () {
      const analysisStarted = yield* Deferred.make<void>()
      const releaseAnalysis = yield* Deferred.make<void>()
      const queryStarted = yield* Deferred.make<void>()
      const releaseQuery = yield* Deferred.make<void>()
      const previousVersions: Array<ReadonlyArray<number>> = []
      const worker = yield* ProjectWorker.makeInProcess({
        epoch: WorkerEpoch.initial,
        analyze: Effect.fnUntraced(function* (documents, previous) {
          const current = documents.at(0)
          previousVersions.push([...previous.values()].map((entry) => entry.document.version))
          if (current?.version === 1) {
            yield* Deferred.succeed(analysisStarted, undefined)
            yield* Deferred.await(releaseAnalysis)
          }
          return yield* analyze(documents, previous)
        }),
        beforeQuery: Effect.fnUntraced(function* () {
          yield* Deferred.succeed(queryStarted, undefined)
          yield* Deferred.await(releaseQuery)
        }),
      })
      yield* initialize(worker)
      yield* take(worker, 'Ready')
      yield* worker.send(source(1, 'pub fn main() -> i32 { return 1 }'))
      yield* take(worker, 'Progress')
      yield* Deferred.await(analysisStarted)
      yield* worker.send({
        protocolVersion: WorkerProtocol.version,
        _tag: 'SupersedeAnalysis',
        epoch: worker.epoch,
        generation: ProjectGeneration.next(ProjectGeneration.initial),
      })
      assert.strictEqual((yield* take(worker, 'Superseded'))._tag, 'Superseded')

      const secondGeneration = ProjectGeneration.next(
        ProjectGeneration.next(ProjectGeneration.initial),
      )
      yield* worker.send(source(2, 'pub fn main() -> i32 { return 2 }'))
      yield* take(worker, 'Progress')
      assert.strictEqual((yield* take(worker, 'Commit'))._tag, 'Commit')
      assert.deepEqual(previousVersions, [[], []])

      const requestId = RequestId.next(RequestId.initial)
      yield* worker.send({
        protocolVersion: WorkerProtocol.version,
        _tag: 'Query',
        epoch: worker.epoch,
        generation: secondGeneration,
        requestId,
        query: { _tag: 'Hover', uri, parameters: { line: 0, character: 36 } },
      })
      yield* Deferred.await(queryStarted)
      yield* worker.send({
        protocolVersion: WorkerProtocol.version,
        _tag: 'CancelQuery',
        epoch: worker.epoch,
        requestId,
      })
      assert.isFalse(yield* Deferred.isDone(releaseQuery))
      yield* worker.shutdown
      yield* take(worker, 'Stopped')
    }),
)

it.effect('reports a failed generation and recovers from the last complete commit', () =>
  Effect.gen(function* () {
    const prior: Array<ReadonlyArray<number>> = []
    const worker = yield* ProjectWorker.makeInProcess({
      epoch: WorkerEpoch.initial,
      analyze: Effect.fnUntraced(function* (documents, previous) {
        const current = documents.at(0)
        prior.push([...previous.values()].map((entry) => entry.document.version))
        if (current?.version === 1) return yield* Effect.die(new Error('controlled defect'))
        return yield* analyze(documents, previous)
      }),
    })
    yield* initialize(worker)
    yield* take(worker, 'Ready')
    yield* worker.send(source(1, 'pub fn main() -> i32 { return 1 }'))
    yield* take(worker, 'Progress')
    const failure = yield* take(worker, 'Failure')
    assert.strictEqual(failure._tag, 'Failure')

    yield* worker.send(source(2, 'pub fn main() -> i32 { return 2 }'))
    yield* take(worker, 'Progress')
    assert.strictEqual((yield* take(worker, 'Commit'))._tag, 'Commit')
    assert.deepEqual(prior, [[], []])
    assert.isTrue(Result.isSuccess(WorkerProtocol.decodeWorker(failure)))
    yield* worker.shutdown
    yield* take(worker, 'Stopped')
  }),
)

it.effect('runs analysis and queries in a real worker thread and exits after shutdown', () =>
  Effect.gen(function* () {
    const worker = yield* ProjectWorker.makeNode(
      WorkerEpoch.initial,
      new URL('../dist/ProjectWorkerMain.js', import.meta.url),
    )
    yield* initialize(worker)
    assert.strictEqual((yield* take(worker, 'Ready'))._tag, 'Ready')
    const generation = ProjectGeneration.next(ProjectGeneration.initial)
    yield* worker.send(source(generation.value, 'pub fn main() -> i32 { return 42 }'))
    yield* take(worker, 'Progress')
    assert.strictEqual((yield* take(worker, 'Commit'))._tag, 'Commit')
    const requestId = RequestId.next(RequestId.initial)
    yield* worker.send({
      protocolVersion: WorkerProtocol.version,
      _tag: 'Query',
      epoch: worker.epoch,
      generation,
      requestId,
      query: { _tag: 'Hover', uri, parameters: { line: 0, character: 36 } },
    })
    const result = yield* take(worker, 'Result')
    if (result._tag !== 'Result') return yield* Effect.die('expected worker query result')
    assert.include(Inspectable.toStringUnknown(result.result), 'Ready')
    yield* worker.shutdown
    assert.strictEqual((yield* take(worker, 'Stopped'))._tag, 'Stopped')
    assert.strictEqual(yield* worker.awaitExit, 0)
  }).pipe(Effect.scoped),
)

it.effect(
  'forcibly retires a non-cooperative worker and acknowledges its exit',
  () =>
    Effect.gen(function* () {
      const worker = yield* ProjectWorker.makeNode(
        WorkerEpoch.initial,
        new URL('./fixtures/non-cooperative-worker.mjs', import.meta.url),
      )
      yield* initialize(worker)
      yield* take(worker, 'Ready')
      yield* worker.send(source(1, 'pub fn main() -> i32 { return 1 }'))
      yield* take(worker, 'Progress')
      yield* worker.terminate
      assert.notStrictEqual(yield* worker.awaitExit, 0)
    }).pipe(Effect.scoped),
  30_000,
)

it.effect('reports an unavailable root without publishing a successful revision', () =>
  Effect.gen(function* () {
    const worker = yield* ProjectWorker.makeInProcess({
      epoch: WorkerEpoch.initial,
      analyze: () =>
        ProjectAnalysis.make(['missing']).pipe(
          Effect.map(() => new Map<string, ProjectSnapshot.DocumentSnapshot>()),
          Effect.provide(SourceResolver.empty),
        ),
    })
    yield* initialize(worker)
    yield* take(worker, 'Ready')
    yield* worker.send(source(1, 'pub fn main() -> i32 { return 0 }'))
    const failure = yield* take(worker, 'Failure')
    assert.strictEqual(failure._tag, 'Failure')
    if (failure._tag !== 'Failure') return
    assert.strictEqual(failure.generation.value, 1)
    yield* worker.send({
      protocolVersion: WorkerProtocol.version,
      _tag: 'Query',
      epoch: WorkerEpoch.initial,
      generation: { _tag: 'ProjectGeneration', value: 1 },
      requestId: RequestId.initial,
      query: { _tag: 'Diagnostics', uri, parameters: {} },
    })
    const result = yield* take(worker, 'Result')
    assert.strictEqual(result._tag, 'Result')
    if (result._tag === 'Result') assert.deepEqual(result.result, { _tag: 'Unavailable' })
    yield* worker.shutdown
  }).pipe(Effect.scoped),
)
