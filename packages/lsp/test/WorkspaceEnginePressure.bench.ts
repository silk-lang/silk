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
import * as Console from 'effect/Console'
import * as Fiber from 'effect/Fiber'
import * as Queue from 'effect/Queue'
import * as Result from 'effect/Result'
import * as Document from '../src/Document.js'
import * as DocumentVersion from '../src/DocumentVersion.js'
import type * as ProjectSnapshot from '../src/ProjectSnapshot.js'
import * as ProjectWorker from '../src/ProjectWorker.js'
import type * as QueryOutcome from '../src/QueryOutcome.js'
import * as SourceEvent from '../src/SourceEvent.js'
import type * as SourceLedger from '../src/SourceLedger.js'
import type * as WorkerEpoch from '../src/WorkerEpoch.js'
import * as WorkerProtocol from '../src/WorkerProtocol.js'
import * as WorkspaceEngine from '../src/WorkspaceEngine.js'

const encoder = new TextEncoder()
const editCount = 50
const uri = 'file:///workspace/Main.silk'
const workspace = 'project:/workspace/silk.toml'

const discover = (entry: SourceLedger.Entry): Document.Document =>
  Document.make({
    uri: entry.uri,
    version: entry.version.value,
    workspace,
    module: 'Main',
    sourceRoot: '/workspace',
    bytes: entry.bytes,
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

const noProgressWorker = Effect.fnUntraced(function* (
  epoch: WorkerEpoch.WorkerEpoch,
): Effect.fn.Return<ProjectWorker.ProjectWorker> {
  const messages = yield* Queue.unbounded<WorkerProtocol.WorkerMessage>()
  const exited = Deferred.makeUnsafe<number>()
  let stopped = false
  const send = Effect.fnUntraced(function* (message: WorkerProtocol.HostMessage) {
    if (message._tag === 'Initialize')
      yield* Queue.offer(messages, {
        protocolVersion: WorkerProtocol.version,
        _tag: 'Ready',
        epoch,
      })
    if (message._tag === 'Analyze')
      yield* Queue.offer(messages, {
        protocolVersion: WorkerProtocol.version,
        _tag: 'Progress',
        epoch,
        generation: message.generation,
        phase: 'analysis',
      })
  })
  const terminate = Effect.fnUntraced(function* () {
    if (stopped) return
    stopped = true
    yield* Deferred.succeed(exited, 1)
  })
  return Object.freeze({
    _tag: 'ProjectWorker',
    epoch,
    send,
    take: Queue.take(messages),
    shutdown: Effect.void,
    terminate: terminate(),
    awaitExit: Deferred.await(exited),
  })
})

it.live('reports editor-session pressure without machine-specific thresholds', () =>
  Effect.gen(function* () {
    const startedAt = performance.now()
    const memoryBefore = process.memoryUsage().heapUsed
    let workerSpawns = 0
    let outstandingQueries = 0
    let maximumOutstandingQueries = 0
    const outcomes = new Map<string, number>()
    const workerFactory: ProjectWorker.Factory = {
      spawn: (epoch: WorkerEpoch.WorkerEpoch) => {
        workerSpawns += 1
        return workerSpawns === 1
          ? noProgressWorker(epoch)
          : ProjectWorker.makeInProcess({ epoch, analyze })
      },
    }
    const engine = yield* WorkspaceEngine.make({
      discover: (entry) => Effect.succeed(discover(entry)),
      workerFactory,
      policy: {
        debounce: 1,
        supersededLease: 25,
        noProgressLease: 10_000,
        retirementDeadline: 25,
        queryDeadline: 5_000,
        diagnosticDeadline: 5_000,
      },
    })
    const queryFibers: Array<Fiber.Fiber<QueryOutcome.QueryOutcome<unknown>>> = []

    const track = <A>(request: Effect.Effect<QueryOutcome.QueryOutcome<A>>) =>
      Effect.gen(function* () {
        outstandingQueries += 1
        maximumOutstandingQueries = Math.max(maximumOutstandingQueries, outstandingQueries)
        const outcome = yield* request
        outcomes.set(outcome._tag, (outcomes.get(outcome._tag) ?? 0) + 1)
        outstandingQueries -= 1
        return outcome
      })

    const first = engine.accept(
      SourceEvent.open(
        uri,
        DocumentVersion.make(1),
        encoder.encode('pub fn main() -> i32 { return 1 }'),
      ),
    )
    assert.isTrue(Result.isSuccess(first))

    for (let version = 2; version <= editCount; version += 1) {
      const accepted = engine.accept(
        SourceEvent.change(
          uri,
          DocumentVersion.make(version),
          encoder.encode(`pub fn main() -> i32 { return ${version} }`),
        ),
      )
      assert.isTrue(Result.isSuccess(accepted))
      queryFibers.push(
        yield* Effect.forkChild(
          track(
            engine.request({
              _tag: 'Hover',
              uri,
              parameters: { line: 0, character: 35 },
            }),
          ),
        ),
        yield* Effect.forkChild(
          track(
            engine.request({
              _tag: 'CodeActions',
              uri,
              parameters: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 40 },
              },
            }),
          ),
        ),
      )
      yield* Effect.sleep(1)
    }

    let finalCommitAt = 0
    let workerRetirements = 0
    while (finalCommitAt === 0) {
      const event = yield* Queue.take(engine.events)
      if (event._tag === 'WorkerRetired') workerRetirements += 1
      if (
        event._tag === 'Committed' &&
        event.documents.some((document) => document.uri === uri && document.version === editCount)
      )
        finalCommitAt = performance.now()
    }

    const diagnostic = yield* engine.request({
      _tag: 'Diagnostics',
      uri,
      parameters: {},
    })
    assert.strictEqual(diagnostic._tag, 'Ready')
    if (diagnostic._tag === 'Ready') assert.strictEqual(diagnostic.value.items.length, 0)
    yield* Effect.forEach(queryFibers, Fiber.join, { concurrency: 'unbounded' })
    yield* engine.shutdown

    assert.isAtLeast(workerSpawns, 2)
    assert.isAtLeast(workerRetirements, 1)
    assert.strictEqual(outstandingQueries, 0)
    yield* Console.log(
      Inspectable.toStringUnknown(
        {
          acceptedEdits: editCount,
          workerSpawns,
          workerRetirements,
          maximumOutstandingQueries,
          queryOutcomes: Object.fromEntries(outcomes),
          finalCommitLatencyMs: finalCommitAt - startedAt,
          heapDeltaBytes: process.memoryUsage().heapUsed - memoryBefore,
          pendingGenerationCapacityPerProject: 1,
          finalDiagnosticCount: diagnostic._tag === 'Ready' ? diagnostic.value.items.length : null,
        },
        2,
      ),
    )
  }),
)
