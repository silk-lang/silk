import { existsSync } from 'node:fs'
import { NodeServices } from '@effect/platform-node'
import { assert, it } from '@effect/vitest'
import * as NativeToolchain from '@silklang/compiler/NativeToolchain'
import * as Project from '@silklang/compiler/Project'
import * as Storage from '@silklang/compiler/Storage'
import type * as TestExecution from '@silklang/compiler/TestExecution'
import * as Config from 'effect/Config'
import * as Console from 'effect/Console'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Stream from 'effect/Stream'
import * as SourceSettlement from '../src/SourceSettlement.js'
import * as TestExchange from '../src/TestExchange.js'
import * as TestResult from '../src/TestResult.js'
import * as Workflow from '../src/Workflow.js'
import * as CompilerHost from './CompilerHost.js'
import * as Timeouts from './timeouts.js'

declare const WebAssembly: {
  readonly Module: {
    new (bytes: Uint8Array): object
    readonly imports: (module: object) => ReadonlyArray<unknown>
  }
  readonly Instance: new (module: object) => {
    readonly exports: Readonly<Record<string, unknown>>
  }
}

const source = 'pub fn main() -> i32 { return 42 }'

const llvmWasmRuntimeSource = `import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.u8
import silk.vector { Vector }

effect fn program() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let mut values = Vector.make<i32>()
  let appended = run Vector.append<i32>(&mut values, 41)
    |> Effect.provideMut<Allocator>(&mut allocator)
  let appendedTwo = run Vector.append<i32>(&mut values, 0)
    |> Effect.provideMut<Allocator>(&mut allocator)
  let appendedThree = run Vector.append<i32>(&mut values, 0)
    |> Effect.provideMut<Allocator>(&mut allocator)
  let appendedFour = run Vector.append<i32>(&mut values, 0)
    |> Effect.provideMut<Allocator>(&mut allocator)
  let appendedFive = run Vector.append<i32>(&mut values, 0)
    |> Effect.provideMut<Allocator>(&mut allocator)
  let one = run Effect.suspend(effect { return 1 })
  let text = "silk"
  let bytes = Intrinsic.stringUtf8Bytes(text)
  if !Intrinsic.stringEqualsExact(text, "silk") { return 1 }
  if Intrinsic.stringByteLength(text) != 4 { return 2 }
  if bytes.length != 4 { return 3 }
  if u8.toI32(bytes[0]) != 115 { return 4 }
  if Vector.length<i32>(&values) != 5 { return 5 }
  return Vector.get<i32>(&values, 0) + one
}

effect fn recover(error: OutOfMemoryError) -> i32 { return 2 }

pub fn main() -> i32 { return run Effect.catchAll(program(), recover) }`

const defaultClang = (): string => {
  if (existsSync('/opt/homebrew/opt/llvm/bin/clang')) return '/opt/homebrew/opt/llvm/bin/clang'
  if (existsSync('/usr/local/opt/llvm/bin/clang')) return '/usr/local/opt/llvm/bin/clang'
  return 'clang'
}
const wasmClang = Effect.runSync(
  Config.String('SILK_TEST_CLANG').pipe(Config.withDefault(defaultClang())),
)

const isI32Main = (value: unknown): value is () => number => typeof value === 'function'

const writeFile = Effect.fnUntraced(function* (path: string, text: string) {
  const fileSystem = yield* FileSystem.FileSystem
  const slash = path.lastIndexOf('/')
  if (slash >= 0) yield* fileSystem.makeDirectory(path.slice(0, slash), { recursive: true })
  yield* fileSystem.writeFileString(path, text)
})

const makeProject = Effect.fnUntraced(function* (root: string, program = source) {
  yield* writeFile(
    `${root}/silk.toml`,
    '[package]\nname = "hello"\nversion = "0.1.0"\nroot = "src/Main.silk"\n',
  )
  yield* writeFile(`${root}/src/Main.silk`, program)
})

const options = (workingDirectory: string): Workflow.ProjectSelection => ({
  workingDirectory,
  optimization: 'debug',
})

const executionIdentity = (ordinal: number): string => ordinal.toString(16).padStart(64, '0')

const testInfo = (
  ordinal: number,
  declarationIdentity = `tests/Cases::test${ordinal}`,
): TestExecution.Entry['test'] => ({
  identity: declarationIdentity,
  name: `test${ordinal}`,
  module: 'tests/Cases',
  path: 'tests/Cases.silk',
  line: ordinal + 1,
  column: 1,
  fingerprint: `silk-test-v1:${ordinal}`,
})

const testEntry = (
  ordinal: number,
  eligibility: TestExecution.Eligibility,
  declarationIdentity = `tests/Cases::test${ordinal}`,
): TestExecution.Entry => ({
  test: testInfo(ordinal, declarationIdentity),
  eligibility,
})

const testCatalog = (
  entries: ReadonlyArray<TestExecution.Entry['test']>,
): TestExecution.Catalog => ({
  _tag: 'TestExecutionCatalog',
  entries,
})

const testManifest = (entries: ReadonlyArray<TestExecution.Entry>): TestExecution.Manifest => ({
  _tag: 'TestExecutionManifest',
  catalogIdentity: 'compiler-catalog-identity-is-not-the-exchange-digest',
  environmentIdentity: 'environment',
  entries,
})

const observedStorage = () => {
  const memory = Storage.memoryService()
  const reads: Array<string> = []
  const publications: Array<string> = []
  return {
    reads,
    publications,
    service: Storage.Storage.of({
      read: (address, maximumBytes) =>
        Effect.sync(() => reads.push(address.key)).pipe(
          Effect.andThen(memory.read(address, maximumBytes)),
        ),
      publish: (address, bytes, maximumBytes) =>
        Effect.sync(() => publications.push(address.key)).pipe(
          Effect.andThen(memory.publish(address, bytes, maximumBytes)),
        ),
    }),
  }
}

const exchangeError = new TestExchange.ExchangeError({
  operation: 'TestExchange.admitReceipt',
  message: 'injected invalid receipt',
  reason: { _tag: 'InvalidReceipt', detail: 'injected' },
})

const counts = {
  discovered: 3n,
  selected: 2n,
  cached: 1n,
  executed: 1n,
  passed: 1n,
  failed: 0n,
} satisfies TestExchange.Counts

it.effect(
  'plans the full compiler manifest in catalog order and reuses eligible keys verbatim',
  () =>
    Effect.gen(function* () {
      const observed = observedStorage()
      const reused = executionIdentity(1)
      const missing = executionIdentity(2)
      yield* TestResult.publishPass(reused).pipe(
        Effect.provideService(Storage.Storage, observed.service),
      )
      observed.reads.length = 0
      observed.publications.length = 0
      const manifest = testManifest([
        testEntry(0, { _tag: 'Eligible', identity: reused }),
        testEntry(1, { _tag: 'Ineligible', reason: { _tag: 'MissingTestRoot' } }),
        testEntry(2, { _tag: 'Eligible', identity: missing }),
      ])
      const prepared = yield* Workflow.prepareTestRun(
        testCatalog(manifest.entries.map((entry) => entry.test)),
        manifest,
      ).pipe(Effect.provideService(Storage.Storage, observed.service))

      assert.strictEqual(prepared.plan._tag, 'PerTest')
      if (prepared.plan._tag !== 'PerTest') return
      assert.deepStrictEqual(
        prepared.plan.entries.map((entry) => ({
          declarationIdentity: entry.declarationIdentity,
          executionIdentity: entry.executionIdentity,
          action: entry.action,
        })),
        [
          {
            declarationIdentity: 'tests/Cases::test0',
            executionIdentity: reused,
            action: 'Cached',
          },
          {
            declarationIdentity: 'tests/Cases::test1',
            executionIdentity: undefined,
            action: 'Execute',
          },
          {
            declarationIdentity: 'tests/Cases::test2',
            executionIdentity: missing,
            action: 'Execute',
          },
        ],
      )
      assert.deepStrictEqual(observed.reads, [reused, missing])
      assert.deepStrictEqual(prepared.events, [])
    }).pipe(Effect.provide(NodeServices.layer)),
)

it.effect('selects compact mode before result lookup for every overflow boundary', () =>
  Effect.gen(function* () {
    const observed = observedStorage()
    const prepare = (manifest: TestExecution.Manifest) =>
      Workflow.prepareTestRun(
        testCatalog(manifest.entries.map((entry) => entry.test)),
        manifest,
      ).pipe(Effect.provideService(Storage.Storage, observed.service))

    const receiptOnlyOverflow = yield* prepare(
      testManifest([
        testEntry(0, { _tag: 'Eligible', identity: executionIdentity(0) }, 'x'.repeat(4124)),
      ]),
    )
    assert.strictEqual(receiptOnlyOverflow.plan._tag, 'Uncached')
    assert.deepStrictEqual(observed.reads, [])
    if (receiptOnlyOverflow.plan._tag !== 'Uncached') return
    const receiptOnlyCompleted = yield* Workflow.completeTestRun(receiptOnlyOverflow.plan, {
      _tag: 'Completed',
      status: 0,
      receipt: {
        _tag: 'Uncached',
        nonce: receiptOnlyOverflow.plan.nonce,
        planDigest: new Uint8Array(32),
        counts: {
          discovered: 1n,
          selected: 1n,
          cached: 0n,
          executed: 1n,
          passed: 1n,
          failed: 0n,
        },
        status: 0,
      },
    }).pipe(Effect.provideService(Storage.Storage, observed.service))
    assert.strictEqual(receiptOnlyCompleted.status, 0)
    assert.deepStrictEqual(observed.publications, [])

    const largeCatalog = testManifest(
      Array.from({ length: 64_000 }, (_, ordinal) =>
        testEntry(
          ordinal,
          { _tag: 'Eligible', identity: executionIdentity(ordinal) },
          `${ordinal.toString().padStart(8, '0')}:${'x'.repeat(232)}`,
        ),
      ),
    )
    const compact = yield* prepare(largeCatalog)
    assert.strictEqual(compact.plan._tag, 'Uncached')
    assert.deepStrictEqual(observed.reads, [])
    if (compact.plan._tag !== 'Uncached') return
    assert.strictEqual(compact.plan.discovered, 64_000n)
    const expectedDigest = yield* TestExchange.catalogDigest(
      largeCatalog.entries.map((entry) => entry.test.identity),
    )
    assert.deepStrictEqual(compact.plan.catalogDigest, expectedDigest)
    const zeroSelected = yield* Workflow.completeTestRun(compact.plan, {
      _tag: 'Completed',
      status: 0,
      receipt: {
        _tag: 'Uncached',
        nonce: compact.plan.nonce,
        planDigest: new Uint8Array(32),
        counts: {
          discovered: 64_000n,
          selected: 0n,
          cached: 0n,
          executed: 0n,
          passed: 0n,
          failed: 0n,
        },
        status: 0,
      },
    }).pipe(Effect.provideService(Storage.Storage, observed.service))
    assert.strictEqual(zeroSelected.status, 0)
    assert.deepStrictEqual(observed.publications, [])
  }).pipe(Effect.provide(NodeServices.layer)),
)

it.effect('bypasses result reads and writes without disturbing an existing pass record', () =>
  Effect.gen(function* () {
    const observed = observedStorage()
    const identity = executionIdentity(3)
    yield* TestResult.publishPass(identity).pipe(
      Effect.provideService(Storage.Storage, observed.service),
    )
    observed.reads.length = 0
    observed.publications.length = 0
    const catalog = testCatalog([testInfo(0)])
    const first = yield* Workflow.prepareTestRun(catalog).pipe(
      Effect.provideService(Storage.Storage, observed.service),
    )
    const second = yield* Workflow.prepareTestRun(catalog).pipe(
      Effect.provideService(Storage.Storage, observed.service),
    )
    assert.strictEqual(first.plan._tag, 'Uncached')
    assert.strictEqual(second.plan._tag, 'Uncached')
    if (first.plan._tag !== 'Uncached') return
    assert.strictEqual(first.plan.discovered, 1n)
    assert.deepStrictEqual(
      first.plan.catalogDigest,
      yield* TestExchange.catalogDigest(['tests/Cases::test0']),
    )
    assert.deepStrictEqual(observed.reads, [])
    assert.isFalse(
      first.plan.nonce.every((byte, index) => byte === (second.plan.nonce.at(index) ?? -1)),
    )

    const completed = yield* Workflow.completeTestRun(first.plan, {
      _tag: 'Completed',
      status: 0,
      receipt: {
        _tag: 'Uncached',
        nonce: first.plan.nonce,
        planDigest: new Uint8Array(32),
        counts: { ...counts, cached: 0n, executed: 2n },
        status: 0,
      },
    }).pipe(Effect.provideService(Storage.Storage, observed.service))
    assert.strictEqual(completed.status, 0)
    assert.deepStrictEqual(completed.events, [])
    assert.deepStrictEqual(observed.publications, [])
    assert.strictEqual(
      (yield* TestResult.lookup(identity).pipe(
        Effect.provideService(Storage.Storage, observed.service),
      ))._tag,
      'Hit',
    )
  }).pipe(Effect.provide(NodeServices.layer)),
)

it.effect('publishes only executed passes by receipt ordinal and preserves abnormal status', () =>
  Effect.gen(function* () {
    const observed = observedStorage()
    const cached = executionIdentity(4)
    const unselected = executionIdentity(5)
    const passed = executionIdentity(6)
    const plan: TestExchange.PerTestPlan = {
      _tag: 'PerTest',
      nonce: new Uint8Array(32),
      entries: [
        { declarationIdentity: 'cached', executionIdentity: cached, action: 'Cached' },
        { declarationIdentity: 'unselected', executionIdentity: unselected, action: 'Execute' },
        { declarationIdentity: 'passed', executionIdentity: passed, action: 'Execute' },
      ],
    }
    const receipt: TestExchange.PerTestReceipt = {
      _tag: 'PerTest',
      nonce: plan.nonce,
      planDigest: new Uint8Array(32),
      entries: [
        {
          ordinal: 0n,
          declarationIdentity: 'cached',
          executionIdentity: cached,
          disposition: 'Cached',
        },
        {
          ordinal: 2n,
          declarationIdentity: 'passed',
          executionIdentity: passed,
          disposition: 'Passed',
        },
      ],
      counts,
      status: 0,
    }
    const completed = yield* Workflow.completeTestRun(plan, {
      _tag: 'Completed',
      status: 0,
      receipt,
    }).pipe(Effect.provideService(Storage.Storage, observed.service))
    assert.strictEqual(completed.status, 0)
    assert.deepStrictEqual(observed.publications, [passed])

    observed.publications.length = 0
    const invalid = yield* Workflow.completeTestRun(plan, {
      _tag: 'InvalidReceipt',
      status: 2,
      processStatus: 0,
      reason: { _tag: 'ExchangeFailure', error: exchangeError },
    }).pipe(Effect.provideService(Storage.Storage, observed.service))
    assert.strictEqual(invalid.status, 2)
    const abnormal = yield* Workflow.completeTestRun(plan, { _tag: 'Abnormal', status: 9 }).pipe(
      Effect.provideService(Storage.Storage, observed.service),
    )
    assert.strictEqual(abnormal.status, 9)
    assert.deepStrictEqual(observed.publications, [])
  }).pipe(Effect.provide(NodeServices.layer)),
)

it.effect('degrades optional cache read and publication failures observably', () =>
  Effect.gen(function* () {
    const identity = executionIdentity(7)
    const failing = Storage.Storage.of({
      read: (address) =>
        Effect.fail(
          new Storage.StorageError({
            operation: 'Storage.read',
            namespace: address.namespace,
            key: address.key,
            message: 'injected read failure',
            reason: { _tag: 'ReadFailure', cause: 'injected' },
          }),
        ),
      publish: (address) =>
        Effect.fail(
          new Storage.StorageError({
            operation: 'Storage.publish',
            namespace: address.namespace,
            key: address.key,
            message: 'injected publication failure',
            reason: { _tag: 'PublishFailure', cause: 'injected' },
          }),
        ),
    })
    const manifest = testManifest([testEntry(0, { _tag: 'Eligible', identity })])
    const prepared = yield* Workflow.prepareTestRun(
      testCatalog(manifest.entries.map((entry) => entry.test)),
      manifest,
    ).pipe(Effect.provideService(Storage.Storage, failing))
    assert.strictEqual(prepared.plan._tag, 'PerTest')
    assert.strictEqual(prepared.events[0]?._tag, 'ReadSkipped')
    if (prepared.plan._tag !== 'PerTest') return
    const completed = yield* Workflow.completeTestRun(prepared.plan, {
      _tag: 'Completed',
      status: 0,
      receipt: {
        _tag: 'PerTest',
        nonce: prepared.plan.nonce,
        planDigest: new Uint8Array(32),
        entries: [
          {
            ordinal: 0n,
            declarationIdentity: 'tests/Cases::test0',
            executionIdentity: identity,
            disposition: 'Passed',
          },
        ],
        counts: { ...counts, discovered: 1n, selected: 1n, cached: 0n, executed: 1n },
        status: 0,
      },
    }).pipe(Effect.provideService(Storage.Storage, failing))
    assert.strictEqual(completed.status, 0)
    assert.strictEqual(completed.events[0]?._tag, 'PublicationSkipped')
  }).pipe(Effect.provide(NodeServices.layer)),
)

const silentWatchLayer = (fileSystem: FileSystem.FileSystem) =>
  Layer.succeed(FileSystem.FileSystem, {
    ...fileSystem,
    watch: () => Stream.never,
  })

/** Polls a watch-mode side effect, which lands on a filesystem event rather than a returned value. */
const waitUntil = Effect.fnUntraced(function* (condition: () => boolean) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return
    yield* Effect.sleep('50 millis')
  }
  throw new Error('Timed out waiting for the watch mode to compile again')
})

/**
 * Rewrites a source file until the watch reacts. Filesystem backends may coalesce a save with an
 * adjacent event, so watch behavior tests retry the same finished edit until it is observed.
 */
const editUntilRecompiled = Effect.fnUntraced(function* (
  file: string,
  text: string,
  recompiled: () => boolean,
) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    yield* writeFile(file, text)
    for (let poll = 0; poll < 20; poll += 1) {
      if (recompiled()) return
      yield* Effect.sleep('50 millis')
    }
  }
  throw new Error('Timed out waiting for the watch mode to compile again')
})

/**
 * Waits until the watch mode stops producing passes and returns the count it stopped at, so a
 * test can count the passes one edit produced rather than only the first of them.
 */
const passesSettled = Effect.fnUntraced(function* (passes: ReadonlyArray<unknown>) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const before = passes.length
    yield* Effect.sleep('400 millis')
    if (passes.length === before) return before
  }
  throw new Error('The watch mode never stopped compiling')
})

/**
 * The entry source delivered to one watch-mode compilation callback. Writer-settlement tests
 * observe these bytes directly; separate tests exercise semantic checking and diagnostic recovery.
 */
interface Pass {
  readonly source: string
}

/**
 * Starts a watch whose passes are recorded, then makes one edit and waits for its compilation to
 * finish. Tests that count later passes begin from this known idle, subscribed state.
 */
const watchRecording = Effect.fnUntraced(function* (root: string) {
  const passes: Array<Pass> = []
  const record = Effect.fnUntraced(function* (project: Project.Project) {
    const source = yield* (yield* FileSystem.FileSystem)
      .readFileString(project.entry.path)
      .pipe(Effect.orDie)
    passes.push({ source })
    return 0 as const
  })
  const watching = yield* Effect.forkChild(Workflow.watch(record, options(root)))
  yield* waitUntil(() => passes.length >= 1)
  yield* editUntilRecompiled(
    `${root}/src/Main.silk`,
    'pub fn main() -> i32 { return 11 }',
    () => passes.length >= 2,
  )
  yield* passesSettled(passes)
  return { passes, watching } as const
})

it('waits through a writer paused after truncating a source file', () => {
  // The event debounce expires while the writer is paused after O_TRUNC, so the settle loop's
  // first sample is already empty. The prior compiled snapshot is what makes that transition
  // suspicious; a later observation of the same empty fingerprint must not settle it normally.
  const afterTruncate = SourceSettlement.fromEntryTransition('empty', source.length, 0)
  const whileWriterPaused = SourceSettlement.observe(afterTruncate, 'empty')
  assert.strictEqual(whileWriterPaused._tag, 'Pending')
  if (whileWriterPaused._tag !== 'Pending') return

  const stillPaused = SourceSettlement.observe(whileWriterPaused.settlement, 'empty')
  assert.strictEqual(stillPaused._tag, 'Pending')
  if (stillPaused._tag !== 'Pending') return
  assert.strictEqual(stillPaused.settlement.fingerprint, 'empty')

  const writerFinished = SourceSettlement.observe(stillPaused.settlement, 'complete:new')
  assert.deepStrictEqual(writerFinished, { _tag: 'Changed', fingerprint: 'complete:new' })
  if (writerFinished._tag !== 'Changed') return
  const firstFinishedConfirmation = SourceSettlement.observe(
    SourceSettlement.fromEntryTransition(writerFinished.fingerprint, source.length, source.length),
    'complete:new',
  )
  assert.strictEqual(firstFinishedConfirmation._tag, 'Pending')
  if (firstFinishedConfirmation._tag !== 'Pending') return
  const settled = SourceSettlement.observe(firstFinishedConfirmation.settlement, 'complete:new')
  assert.deepStrictEqual(settled, { _tag: 'Settled', fingerprint: 'complete:new' })
})

it('accepts an intentional empty entry at the suspicious-transition budget', () => {
  let observed: SourceSettlement.Observation = {
    _tag: 'Pending',
    settlement: SourceSettlement.fromEntryTransition('empty', source.length, 0),
  }
  for (let sample = 0; sample < SourceSettlement.maximumObservations; sample += 1) {
    if (observed._tag !== 'Pending') break
    observed = SourceSettlement.observe(observed.settlement, 'empty')
  }
  assert.deepStrictEqual(observed, { _tag: 'Settled', fingerprint: 'empty' })
})

it.effect('checks a whole project without creating build artifacts', () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    const root = yield* fileSystem.makeTempDirectoryScoped()
    yield* makeProject(root)
    yield* writeFile(`${root}/src/library/Answer.silk`, 'pub fn answer() -> i32 { return 42 }')
    yield* writeFile(
      `${root}/src/Main.silk`,
      'import library.Answer { answer }\npub fn main() -> i32 { return answer() }',
    )

    const status = yield* Workflow.check(options(root))

    assert.strictEqual(status, 0)
    assert.strictEqual(yield* fileSystem.exists(`${root}/.silk`), false)
  }).pipe(Effect.scoped, Effect.provide(CompilerHost.layer)),
)

it.effect('separates source diagnostics from operational resolver failures during check', () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    const root = yield* fileSystem.makeTempDirectoryScoped()
    yield* makeProject(root, 'pub fn main() -> Mystery { return 42 }')
    assert.strictEqual(yield* Workflow.check(options(root)), 1)

    yield* writeFile(
      `${root}/src/Main.silk`,
      'import unreadable\npub fn main() -> i32 { return 42 }',
    )
    yield* fileSystem.makeDirectory(`${root}/src/unreadable.silk`)
    assert.strictEqual(yield* Workflow.check(options(root)), 2)
    assert.strictEqual(yield* fileSystem.exists(`${root}/.silk`), false)
  }).pipe(Effect.scoped, Effect.provide(CompilerHost.layer)),
)

it.effect(
  'builds a native library with deterministic interface companion paths',
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const root = yield* fileSystem.makeTempDirectoryScoped()
      yield* makeProject(root, 'export "C" fn answer() -> i32 { return 42 }')
      yield* fileSystem.writeFileString(
        `${root}/silk.toml`,
        '[package]\nname = "hello"\nversion = "0.1.0"\nroot = "src/Main.silk"\n\n[build]\nartifact = "shared-library"\n',
      )

      const status = yield* Workflow.build(options(root))
      const project = yield* Project.load({ workingDirectory: root })

      assert.strictEqual(status, 0)
      const host = yield* NativeToolchain.hostTarget()
      const library =
        process.platform === 'darwin' ? `lib${project.name}.dylib` : `lib${project.name}.so`
      assert.strictEqual(
        yield* fileSystem.exists(`${root}/build/llvm/${host.id}/debug/${library}`),
        true,
      )
      assert.strictEqual(
        yield* fileSystem.exists(`${root}/build/llvm/${host.id}/debug/${project.name}.h`),
        true,
      )
      assert.strictEqual(
        yield* fileSystem.exists(`${root}/build/llvm/${host.id}/debug/${project.name}.abi.json`),
        true,
      )
    }).pipe(Effect.scoped, Effect.provide(CompilerHost.layer)),
  Timeouts.nativeBuild,
)

it.effect(
  'builds ordered native and LLVM-Wasm targets to independent artifacts',
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const root = yield* fileSystem.makeTempDirectoryScoped()
      yield* makeProject(root, llvmWasmRuntimeSource)
      yield* fileSystem.writeFileString(
        `${root}/silk.toml`,
        '[package]\nname = "hello"\nversion = "0.1.0"\nroot = "src/Main.silk"\n\n[build]\ntargets = ["host", "wasm32-unknown-unknown"]\n',
      )
      const reports: Array<string> = []
      const reportingConsole: Console.Console = Object.assign(Object.create(console), {
        log: (...args: ReadonlyArray<unknown>) => reports.push(args.join(' ')),
        error: (...args: ReadonlyArray<unknown>) => reports.push(args.join(' ')),
      })
      const status = yield* Workflow.build({ ...options(root), clang: wasmClang }).pipe(
        Effect.provideService(Console.Console, reportingConsole),
      )
      assert.strictEqual(status, 0, reports.join('\n'))
      const host = yield* NativeToolchain.hostTarget()
      assert.strictEqual(
        yield* fileSystem.exists(`${root}/build/llvm/${host.id}/debug/hello`),
        true,
      )
      assert.strictEqual(
        yield* fileSystem.exists(`${root}/build/llvm/wasm32-unknown-unknown/debug/hello.wasm`),
        true,
      )
      const wasmBytes = yield* fileSystem.readFile(
        `${root}/build/llvm/wasm32-unknown-unknown/debug/hello.wasm`,
      )
      const wasmModule = new WebAssembly.Module(Uint8Array.from(wasmBytes))
      assert.deepEqual(WebAssembly.Module.imports(wasmModule), [])
      const wasmInstance = new WebAssembly.Instance(wasmModule)
      const wasmMain = wasmInstance.exports['main']
      assert.isTrue(isI32Main(wasmMain))
      if (isI32Main(wasmMain)) assert.strictEqual(wasmMain(), 42)
      assert.strictEqual(
        yield* fileSystem.exists(`${root}/build/llvm/${host.id}/debug/hello.h`),
        false,
      )
      assert.strictEqual(
        yield* fileSystem.exists(`${root}/build/llvm/${host.id}/debug/hello.abi.json`),
        false,
      )
    }).pipe(Effect.scoped, Effect.provide(CompilerHost.layer)),
  Timeouts.nativeBuild,
)

it.effect(
  'retains a successful sibling when another target rejects target-dependent source',
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const root = yield* fileSystem.makeTempDirectoryScoped()
      yield* makeProject(
        root,
        `fn exact() -> usize { return 9007199254740993 }
pub fn main() -> i32 {
  if exact() == 9007199254740993 { return 42 }
  return 0
}`,
      )
      const status = yield* Workflow.build({
        ...options(root),
        targets: ['host', 'wasm32-unknown-unknown'],
      })
      const host = yield* NativeToolchain.hostTarget()
      assert.strictEqual(status, 1)
      assert.strictEqual(
        yield* fileSystem.exists(`${root}/build/llvm/${host.id}/debug/hello`),
        true,
      )
      assert.strictEqual(
        yield* fileSystem.exists(`${root}/build/llvm/wasm32-unknown-unknown/debug/hello.wasm`),
        false,
      )
    }).pipe(Effect.scoped, Effect.provide(CompilerHost.layer)),
  Timeouts.nativeBuild,
)

it.effect('attempts a source rejection and operational failure, preferring exit two', () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    const root = yield* fileSystem.makeTempDirectoryScoped()
    yield* makeProject(
      root,
      `fn exact() -> usize { return 9007199254740993 }
pub fn main() -> i32 {
  if exact() == 9007199254740993 { return 42 }
  return 0
}`,
    )
    const status = yield* Workflow.build({
      ...options(root),
      targets: ['wasm32-unknown-unknown', 'host'],
      clang: '/nonexistent/clang',
    })
    assert.strictEqual(status, 2)
    assert.strictEqual(yield* fileSystem.exists(`${root}/build`), true)
    const host = yield* NativeToolchain.hostTarget()
    assert.strictEqual(yield* fileSystem.exists(`${root}/build/llvm/${host.id}/debug/hello`), false)
  }).pipe(Effect.scoped, Effect.provide(CompilerHost.layer)),
)

it.effect('checks every configured target without creating output', () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    const root = yield* fileSystem.makeTempDirectoryScoped()
    yield* makeProject(root)
    assert.strictEqual(
      yield* Workflow.check({
        ...options(root),
        targets: ['host', 'wasm32-unknown-unknown'],
      }),
      0,
    )
    assert.strictEqual(yield* fileSystem.exists(`${root}/build`), false)
  }).pipe(Effect.scoped, Effect.provide(CompilerHost.layer)),
)

it.effect('returns source and toolchain failure classes without leaving executables', () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    const root = yield* fileSystem.makeTempDirectoryScoped()
    yield* makeProject(root, 'pub fn main() -> Mystery { return 42 }')
    assert.strictEqual(yield* Workflow.build(options(root)), 1)

    yield* writeFile(`${root}/src/Main.silk`, source)
    const project = yield* Project.load({ workingDirectory: root })
    const destination = `${root}/broken-toolchain`
    const attempted = yield* Workflow.compile({
      entry: project.entry,
      optimization: 'debug',
      artifactKind: 'NativeExecutable',
      packageName: 'broken-toolchain',
      destination,
      toolchain: { _tag: 'Toolchain', clang: '/silk-test/missing-clang', llvmAr: 'llvm-ar' },
      scopeName: 'broken-toolchain',
    })
    assert.deepStrictEqual(attempted, { _tag: 'NotBuilt', status: 2 })
    assert.strictEqual(yield* fileSystem.exists(destination), false)
  }).pipe(Effect.scoped, Effect.provide(CompilerHost.layer)),
)

it.effect(
  'builds and returns the compiled program exact exit status',
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const root = yield* fileSystem.makeTempDirectoryScoped()
      yield* makeProject(root)

      const status = yield* Workflow.run(options(root), ['--literal', 'argument'])

      assert.strictEqual(status, 42)
    }).pipe(Effect.scoped, Effect.provide(CompilerHost.layer)),
  Timeouts.nativeBuild,
)

it.effect(
  'removes the build artifacts and keeps the source files',
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const root = yield* fileSystem.makeTempDirectoryScoped()
      yield* makeProject(root)
      assert.strictEqual(yield* Workflow.build(options(root)), 0)
      assert.strictEqual(yield* fileSystem.exists(`${root}/build`), true)

      const status = yield* Workflow.clean(options(root))

      assert.strictEqual(status, 0)
      assert.strictEqual(yield* fileSystem.exists(`${root}/build`), false)
      assert.strictEqual(yield* fileSystem.exists(`${root}/src/Main.silk`), true)
      assert.strictEqual(yield* fileSystem.exists(`${root}/silk.toml`), true)
    }).pipe(Effect.scoped, Effect.provide(CompilerHost.layer)),
  Timeouts.nativeBuild,
)

it.effect('exits zero cleaning a project that was never built', () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    const root = yield* fileSystem.makeTempDirectoryScoped()
    yield* makeProject(root)
    assert.strictEqual(yield* fileSystem.exists(`${root}/build`), false)

    assert.strictEqual(yield* Workflow.clean(options(root)), 0)
    assert.strictEqual(yield* fileSystem.exists(`${root}/src/Main.silk`), true)
  }).pipe(Effect.scoped, Effect.provide(CompilerHost.layer)),
)

it.live(
  'checks again after a watched source file changes',
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const root = yield* fileSystem.makeTempDirectoryScoped()
      yield* makeProject(root)
      const passes: Array<Workflow.ExitStatus> = []
      const record = (project: Project.Project, selection: Workflow.ProjectSelection) =>
        Workflow.checkProject(project, selection).pipe(
          Effect.tap((status) => Effect.sync(() => passes.push(status))),
        )

      const watching = yield* Effect.forkChild(Workflow.watch(record, options(root)))
      yield* waitUntil(() => passes.length >= 1)
      yield* editUntilRecompiled(
        `${root}/src/Main.silk`,
        'pub fn main() -> i32 { return 7 }',
        () => passes.length >= 2,
      )
      yield* Fiber.interrupt(watching)

      assert.deepStrictEqual(passes.slice(0, 2), [0, 0])
    }).pipe(Effect.scoped, Effect.provide(CompilerHost.layer)),
  Timeouts.nativeBuild,
)

it.live(
  'settles entry metadata before compiling during watch startup',
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const root = yield* fileSystem.makeTempDirectoryScoped()
      yield* makeProject(root)
      const entry = `${root}/src/Main.silk`
      const replacement = 'pub fn main() -> i32 { return 7 }'
      let injected = false
      const startupEditLayer = Layer.succeed(FileSystem.FileSystem, {
        ...fileSystem,
        stat: (path: string) =>
          fileSystem.stat(path).pipe(
            Effect.tap(() => {
              if (path !== entry || injected) return Effect.void
              injected = true
              return fileSystem.writeFileString(entry, replacement)
            }),
          ),
        watch: () => Stream.never,
      })
      const observed: Array<string> = []
      const record = Effect.fnUntraced(function* (
        project: Project.Project,
        _selection: Workflow.ProjectSelection,
      ) {
        const source = yield* (yield* FileSystem.FileSystem)
          .readFileString(project.entry.path)
          .pipe(Effect.orDie)
        return yield* Effect.sync(() => {
          observed.push(source)
          const status: Workflow.ExitStatus = 0
          return status
        })
      })

      const watching = yield* Effect.forkChild(
        Workflow.watch(record, options(root)).pipe(Effect.provide(startupEditLayer)),
      )
      yield* waitUntil(() => observed.length >= 1)
      yield* Fiber.interrupt(watching)

      assert.deepStrictEqual(observed, [replacement])
    }).pipe(Effect.scoped, Effect.provide(CompilerHost.layer)),
  Timeouts.nativeBuild,
)

it.live(
  'does not lose an edit made during the initial watch pass',
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const root = yield* fileSystem.makeTempDirectoryScoped()
      yield* makeProject(root)
      const replacement = 'pub fn main() -> i32 { return 7 }'
      const observed: Array<string> = []
      const record = Effect.fnUntraced(function* (
        project: Project.Project,
        _selection: Workflow.ProjectSelection,
      ) {
        observed.push(yield* fileSystem.readFileString(project.entry.path))
        if (observed.length === 1) {
          yield* fileSystem.writeFileString(`${root}/src/Main.silk`, replacement)
        }
        const status: Workflow.ExitStatus = 0
        return status
      }, Effect.orDie)

      const watching = yield* Effect.forkChild(
        Workflow.watch(record, options(root)).pipe(Effect.provide(silentWatchLayer(fileSystem))),
      )
      yield* waitUntil(() => observed.length >= 2)
      yield* Fiber.interrupt(watching)

      assert.deepStrictEqual(observed.slice(0, 2), [source, replacement])
    }).pipe(Effect.scoped, Effect.provide(CompilerHost.layer)),
  Timeouts.nativeBuild,
)

it.live(
  'checks again after a nested module in the source graph changes',
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const root = yield* fileSystem.makeTempDirectoryScoped()
      yield* makeProject(
        root,
        'import library.Answer { answer }\npub fn main() -> i32 { return answer() }',
      )
      yield* writeFile(`${root}/src/library/Answer.silk`, 'pub fn answer() -> i32 { return 42 }')
      const passes: Array<Workflow.ExitStatus> = []
      const record = (project: Project.Project, selection: Workflow.ProjectSelection) =>
        Workflow.checkProject(project, selection).pipe(
          Effect.tap((status) => Effect.sync(() => passes.push(status))),
        )

      const watching = yield* Effect.forkChild(Workflow.watch(record, options(root)))
      yield* waitUntil(() => passes.length >= 1)
      yield* editUntilRecompiled(
        `${root}/src/library/Answer.silk`,
        'pub fn answer() -> i32 { return 7 }',
        () => passes.length >= 2,
      )
      yield* Fiber.interrupt(watching)

      assert.deepStrictEqual(passes.slice(0, 2), [0, 0])
    }).pipe(Effect.scoped, Effect.provide(CompilerHost.layer)),
  Timeouts.nativeBuild,
)

/**
 * `fileSystem.writeFileString` is `open(O_TRUNC)`, `write`, `close`, exactly what shell
 * redirection, `sed -i`, and an editor without atomic save do. The watch fires on the truncate, so
 * a watcher that reads on the raw event reads the file at zero length: issue #158 measured 71% of
 * watch-woken reads observing no bytes at all. Every pass here must have read one of the whole
 * programs this test wrote, never a truncated or half-written prefix of one.
 */
it.live(
  'compiles the finished file when a burst of saves writes non-atomically',
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const root = yield* fileSystem.makeTempDirectoryScoped()
      yield* makeProject(root)
      const { passes, watching } = yield* watchRecording(root)
      const before = passes.length
      const written = new Set(['pub fn main() -> i32 { return 11 }'])

      for (let write = 0; write < 200; write += 1) {
        const program = `pub fn main() -> i32 { return ${'4'.repeat((write % 8) + 1)} }`
        written.add(program)
        yield* fileSystem.writeFileString(`${root}/src/Main.silk`, program)
      }
      yield* waitUntil(() => passes.length > before)
      yield* passesSettled(passes)
      yield* Fiber.interrupt(watching)

      const observed = passes.slice(before)
      const torn = observed.filter((pass) => !written.has(pass.source))
      assert.deepStrictEqual(
        torn.map((pass) => pass.source.length),
        [],
        `${torn.length} of ${observed.length} passes read a file that was still being written`,
      )
    }).pipe(Effect.scoped, Effect.provide(CompilerHost.layer)),
  Timeouts.nativeBuild,
)

it.live(
  'compiles once for one logical edit',
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const root = yield* fileSystem.makeTempDirectoryScoped()
      yield* makeProject(root)
      const { passes, watching } = yield* watchRecording(root)
      const before = passes.length

      yield* fileSystem.writeFileString(
        `${root}/src/Main.silk`,
        'pub fn main() -> i32 { return 7 }',
      )
      yield* waitUntil(() => passes.length > before)
      const settled = yield* passesSettled(passes)
      yield* Fiber.interrupt(watching)

      assert.strictEqual(settled - before, 1)
    }).pipe(Effect.scoped, Effect.provide(CompilerHost.layer)),
  Timeouts.nativeBuild,
)

/**
 * The settle must coalesce one edit's events without swallowing a second edit: distinct saves are
 * distinct work no matter how quickly they follow one another.
 */
it.live(
  'compiles once per edit for a rapid sequence of distinct edits',
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const root = yield* fileSystem.makeTempDirectoryScoped()
      yield* makeProject(root)
      const { passes, watching } = yield* watchRecording(root)
      const before = passes.length
      const edits = [
        'pub fn main() -> i32 { return 1 }',
        'pub fn main() -> i32 { return 22 }',
        'pub fn main() -> i32 { return 333 }',
        'pub fn main() -> i32 { return 4444 }',
      ]

      for (const [index, edit] of edits.entries()) {
        yield* fileSystem.writeFileString(`${root}/src/Main.silk`, edit)
        yield* waitUntil(() => passes.length >= before + index + 1)
      }
      const settled = yield* passesSettled(passes)
      yield* Fiber.interrupt(watching)

      assert.strictEqual(settled - before, edits.length)
      assert.deepStrictEqual(
        passes.slice(before).map((pass) => pass.source),
        edits,
      )
    }).pipe(Effect.scoped, Effect.provide(CompilerHost.layer)),
  Timeouts.nativeBuild,
)

/**
 * The settle decides that a file stopped changing, never that its contents are plausible. A user
 * who empties a source file has made an edit like any other: it recompiles, and whatever the
 * emptied graph deserves is what gets reported.
 */
it.live(
  'compiles a source file the user emptied on purpose',
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const root = yield* fileSystem.makeTempDirectoryScoped()
      yield* makeProject(root)
      const { passes, watching } = yield* watchRecording(root)
      const before = passes.length

      yield* fileSystem.writeFileString(`${root}/src/Main.silk`, '')
      yield* waitUntil(() => passes.length > before)
      yield* passesSettled(passes)
      yield* Fiber.interrupt(watching)

      assert.deepStrictEqual(
        passes.slice(before).map((pass) => pass.source),
        [''],
      )
    }).pipe(Effect.scoped, Effect.provide(CompilerHost.layer)),
  Timeouts.nativeBuild,
)

it.live(
  'keeps watching after a compilation that reports a diagnostic',
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const root = yield* fileSystem.makeTempDirectoryScoped()
      yield* makeProject(root, 'pub fn main() -> Mystery { return 42 }')
      const passes: Array<Workflow.ExitStatus> = []
      const record = (project: Project.Project, selection: Workflow.ProjectSelection) =>
        Workflow.checkProject(project, selection).pipe(
          Effect.tap((status) => Effect.sync(() => passes.push(status))),
        )

      const watching = yield* Effect.forkChild(Workflow.watch(record, options(root)))
      yield* waitUntil(() => passes.length >= 1)
      assert.strictEqual(passes[0], 1)

      yield* editUntilRecompiled(`${root}/src/Main.silk`, source, () => passes.length >= 2)

      assert.strictEqual(passes[1], 0)
      yield* Fiber.interrupt(watching)
    }).pipe(Effect.scoped, Effect.provide(CompilerHost.layer)),
  Timeouts.nativeBuild,
)

it.effect('reports a missing selected root as an operational failure without output', () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const root = yield* fs.makeTempDirectoryScoped()
    yield* makeProject(root)
    yield* fs.remove(`${root}/src/Main.silk`)
    const project = yield* Project.load({ workingDirectory: root })
    assert.strictEqual(project.entry.module, 'Main')
    assert.strictEqual(yield* Workflow.checkProject(project, options(root)), 2)
    assert.isFalse(yield* fs.exists(`${root}/build`))
  }).pipe(Effect.scoped, Effect.provide(CompilerHost.layer)),
)
