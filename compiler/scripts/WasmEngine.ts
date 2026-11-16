// Runs a wasm32-wasip1 command module in one engine configuration: V8 with only its optimizing
// tier, V8 with only its baseline tier, V8 as it tiers by default, or Wasmtime. Reports what the
// module did and how long each run took.
import { closeSync, openSync } from 'node:fs'
import { createRequire } from 'node:module'
import { performance } from 'node:perf_hooks'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Schema from 'effect/Schema'
import * as NativeProcess from './NativeProcess.ts'
import * as WasmModule from './WasmModule.ts'

export class WasmEngineError extends Data.TaggedError('WasmEngineError')<{
  readonly message: string
  readonly reason: 'RejectedInput' | 'ExternalFailure'
  readonly cause?: unknown
}> {}
const reject = (message: string) => new WasmEngineError({ message, reason: 'RejectedInput' })
const external = (message: string, cause: unknown) =>
  new WasmEngineError({
    message: `${message}: ${cause instanceof Error ? cause.message : String(cause)}`,
    reason: 'ExternalFailure',
    cause,
  })

/**
 * `v8-optimizing` compiles every function with TurboFan before the first run and `v8-baseline`
 * with Liftoff, and neither changes tier afterwards. `v8-tiering` is V8's default: Liftoff
 * compiles a function when it is first called and TurboFan recompiles the hot ones.
 */
export const v8Engines = ['v8-optimizing', 'v8-baseline', 'v8-tiering'] as const
export type V8Engine = (typeof v8Engines)[number]
export const engines = [...v8Engines, 'wasmtime'] as const
export type Engine = (typeof engines)[number]

const v8Flags: Readonly<Record<V8Engine, ReadonlyArray<string>>> = {
  'v8-optimizing': ['--no-liftoff', '--no-wasm-lazy-compilation'],
  'v8-baseline': ['--liftoff-only', '--no-wasm-lazy-compilation'],
  'v8-tiering': [],
}

/** Where Wasmtime is, and a precompiled command that does nothing, to time what a process costs. */
export interface Wasmtime {
  readonly path: string
  readonly empty: string
}

/** What one run of a module did. */
export interface Outcome {
  readonly exit: number | null
  readonly trap: string | null
  readonly stdout: string
  readonly stderr: string
}

/** How long and how often to run a module. */
export interface Repeat {
  /** Runs after the first: at least this many. */
  readonly steadyRuns: number
  /** Runs after the first continue until they have taken this long together. */
  readonly steadyMs: number
}
/** One run and no more. */
export const once: Repeat = { steadyRuns: 0, steadyMs: 0 }

export interface Request {
  readonly module: string
  readonly arguments: ReadonlyArray<string>
  readonly repeat: Repeat
  /** Read this many counters of a counting module, as `WasmModule.counterName` names them. */
  readonly counters?: number
  /** Sample where V8 spends its time; only a V8 engine can. */
  readonly sample?: boolean
}

/**
 * Sampled self time in the module's code, in microseconds over all runs, by the byte offset V8
 * gives for the function. V8's optimizing tier inlines calls, and then charges the callee's time
 * to its caller; its baseline tier does not inline.
 */
export interface Samples {
  readonly functions: ReadonlyArray<readonly [offset: number, microseconds: number]>
}

/** Every run of a request did the same thing, which is `Outcome`; `ms` times each run in order. */
export interface Execution extends Outcome {
  readonly ms: ReadonlyArray<number>
  /** The counters after the first run, when the request asked for them. */
  readonly counters: ReadonlyArray<number>
  readonly samples: Samples | undefined
}

export const median = (values: ReadonlyArray<number>): number | undefined => {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = sorted.length >> 1
  const upper = sorted[middle]
  if (upper === undefined) return undefined
  return sorted.length % 2 === 1 ? upper : ((sorted[middle - 1] ?? upper) + upper) / 2
}

/** A request's first run and the median of the runs after it, which is the first when it ran once. */
export const timing = (ms: ReadonlyArray<number>): { readonly firstMs: number; readonly steadyMs: number } => {
  const firstMs = ms[0] ?? 0
  return { firstMs, steadyMs: median(ms.slice(1)) ?? firstMs }
}

const more = (repeat: Repeat, ms: ReadonlyArray<number>): boolean => {
  const steady = ms.slice(1)
  return ms.length === 0 || steady.length < repeat.steadyRuns || steady.reduce((sum, value) => sum + value, 0) < repeat.steadyMs
}

const same = (left: Outcome, right: Outcome): boolean =>
  left.exit === right.exit && left.trap === right.trap && left.stdout === right.stdout && left.stderr === right.stderr

const here = dirname(fileURLToPath(import.meta.url))
const runTimeoutMs = 900_000
const sampleMicroseconds = 100

const ServeRequest = Schema.fromJsonString(
  Schema.Struct({
    module: Schema.String,
    arguments: Schema.Array(Schema.String),
    steadyRuns: Schema.Finite,
    steadyMs: Schema.Finite,
    counters: Schema.Finite,
    sample: Schema.Boolean,
    record: Schema.String,
  }),
)
const Record = Schema.fromJsonString(
  Schema.Struct({
    exit: Schema.NullOr(Schema.Finite),
    trap: Schema.NullOr(Schema.String),
    stdout: Schema.String,
    stderr: Schema.String,
    ms: Schema.Array(Schema.Finite),
    counters: Schema.Array(Schema.Finite),
    samples: Schema.NullOr(
      Schema.Struct({
        functions: Schema.Array(Schema.Tuple([Schema.Finite, Schema.Finite])),
      }),
    ),
    unstable: Schema.NullOr(Schema.Finite),
  }),
)

const CpuProfile = Schema.Struct({
  profile: Schema.Struct({
    nodes: Schema.Array(
      Schema.Struct({
        id: Schema.Finite,
        callFrame: Schema.Struct({ url: Schema.String, columnNumber: Schema.Finite }),
      }),
    ),
    samples: Schema.Array(Schema.Finite),
    timeDeltas: Schema.Array(Schema.Finite),
  }),
})

/** Self time per wasm function, which V8 identifies by the offset of its body in the module. */
const samplesOf = (profile: (typeof CpuProfile.Type)['profile']): Samples => {
  const offsets = new Map(
    profile.nodes.flatMap((node) => (node.callFrame.url.startsWith('wasm://') ? [[node.id, node.callFrame.columnNumber] as const] : [])),
  )
  const functions = new Map<number, number>()
  for (const [position, id] of profile.samples.entries()) {
    const offset = offsets.get(id)
    if (offset !== undefined) functions.set(offset, (functions.get(offset) ?? 0) + (profile.timeDeltas[position] ?? 0))
  }
  return { functions: [...functions].sort((left, right) => right[1] - left[1]) }
}

/**
 * What the runner process does: compiles the module once, then instantiates and runs it until the
 * request is satisfied, timing each `_start` alone. Each run writes to files, so that every run's
 * output can be compared with the first.
 */
const serve = Effect.fnUntraced(function* (text: string) {
  const fs = yield* FileSystem.FileSystem
  const request = yield* Schema.decodeEffect(ServeRequest)(text).pipe(
    Effect.mapError((cause) => external('unreadable request', cause)),
  )
  const bytes = yield* fs.readFile(request.module).pipe(Effect.mapError((cause) => external('cannot read the module', cause)))
  // Imported here, so that only the runner process warns that WASI is experimental.
  const { WASI } = yield* Effect.tryPromise({
    try: () => import('node:wasi'),
    catch: (cause) => external('cannot load node:wasi', cause),
  })
  // Synchronous compilation: a pending asynchronous compile does not keep Node's event loop alive.
  const module = yield* Effect.try({
    try: () => new WebAssembly.Module(bytes),
    catch: (cause) => external('cannot compile the module', cause),
  })
  const session = request.sample
    ? yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: async () => {
            const inspector = await import('node:inspector/promises')
            const opened = new inspector.Session()
            opened.connect()
            await opened.post('Profiler.enable')
            await opened.post('Profiler.setSamplingInterval', { interval: sampleMicroseconds })
            await opened.post('Profiler.start')
            return opened
          },
          catch: (cause) => external('cannot start the profiler', cause),
        }),
        (opened) => Effect.sync(() => opened.disconnect()),
      )
    : undefined
  const directory = dirname(request.record)
  const output = (name: string) =>
    Effect.acquireRelease(
      Effect.try({
        try: () => openSync(join(directory, name), 'w'),
        catch: (cause) => external(`cannot open ${name}`, cause),
      }),
      (descriptor) => Effect.try(() => closeSync(descriptor)).pipe(Effect.ignore),
    )
  const contents = Effect.fnUntraced(function* (name: string) {
    return yield* fs.readFileString(join(directory, name)).pipe(Effect.mapError((cause) => external(`cannot read ${name}`, cause)))
  })
  const ms: Array<number> = []
  let first: Outcome | undefined
  let counters: ReadonlyArray<number> = []
  let unstable: number | null = null
  while (unstable === null && more({ steadyRuns: request.steadyRuns, steadyMs: request.steadyMs }, ms)) {
    const ran = yield* Effect.scoped(
      Effect.gen(function* () {
        const stdout = yield* output('stdout')
        const stderr = yield* output('stderr')
        return yield* Effect.try({
          try: () => {
            const wasi = new WASI({
              version: 'preview1',
              args: ['program', ...request.arguments],
              env: {},
              returnOnExit: true,
              stdout,
              stderr,
            })
            const instance = new WebAssembly.Instance(module, wasi.getImportObject() as WebAssembly.Imports)
            let exit: number | null = null
            let trap: string | null = null
            const started = performance.now()
            try {
              exit = wasi.start(instance) ?? 0
            } catch (cause) {
              trap = cause instanceof Error ? cause.message : String(cause)
            }
            return { exit, trap, ms: performance.now() - started, exports: instance.exports }
          },
          catch: (cause) => external('cannot instantiate the module', cause),
        })
      }),
    )
    const outcome = { exit: ran.exit, trap: ran.trap, stdout: yield* contents('stdout'), stderr: yield* contents('stderr') }
    if (first === undefined) {
      first = outcome
      counters = Array.from({ length: request.counters }, (_, position) => {
        const counter = ran.exports[WasmModule.counterName(position)]
        return counter instanceof WebAssembly.Global ? Number(counter.value) : Number.NaN
      })
      if (counters.some(Number.isNaN)) return yield* reject('the module does not export the counters asked for')
    } else if (!same(first, outcome)) unstable = ms.length + 1
    ms.push(ran.ms)
  }
  const samples =
    session === undefined
      ? null
      : yield* Effect.tryPromise({
          try: () => session.post('Profiler.stop'),
          catch: (cause) => external('cannot stop the profiler', cause),
        }).pipe(
          Effect.flatMap((stopped) =>
            Schema.decodeUnknownEffect(CpuProfile)(stopped).pipe(Effect.mapError((cause) => external('unreadable profile', cause))),
          ),
          Effect.map((stopped) => samplesOf(stopped.profile)),
        )
  const record = yield* Schema.encodeEffect(Record)({
    ...(first ?? { exit: null, trap: 'did not run', stdout: '', stderr: '' }),
    ms,
    counters,
    samples,
    unstable,
  }).pipe(Effect.mapError((cause) => external('cannot encode the record', cause)))
  yield* fs.writeFileString(request.record, record).pipe(Effect.mapError((cause) => external('cannot write the record', cause)))
})

const runV8 = Effect.fnUntraced(function* (engine: V8Engine, request: Request) {
  const fs = yield* FileSystem.FileSystem
  const directory = yield* fs
    .makeTempDirectoryScoped({ prefix: 'silk-wasm-run-' })
    .pipe(Effect.mapError((cause) => external('cannot make a run directory', cause)))
  const record = join(directory, 'record.json')
  const text = yield* Schema.encodeEffect(ServeRequest)({
    module: request.module,
    arguments: request.arguments,
    steadyRuns: request.repeat.steadyRuns,
    steadyMs: request.repeat.steadyMs,
    counters: request.counters ?? 0,
    sample: request.sample ?? false,
    record,
  }).pipe(Effect.mapError((cause) => external('cannot encode the request', cause)))
  const ran = yield* NativeProcess.execute(
    process.execPath,
    [...v8Flags[engine], '--disable-warning=ExperimentalWarning', join(here, 'WasmEngine.ts'), text],
    { cwd: dirname(request.module), stdio: ['ignore', 'ignore', 'pipe'], timeoutMs: runTimeoutMs },
  ).pipe(Effect.mapError((cause) => external('cannot run node', cause)))
  if (ran.deadline?.expired) return yield* reject(`run timed out after ${runTimeoutMs} ms`)
  const parsed = yield* fs.readFileString(record).pipe(
    Effect.mapError(() =>
      reject(`runner exited ${ran.signal ?? ran.status}: ${ran.stderr.toString('utf8').trim().split('\n').slice(-1)[0] ?? ''}`.slice(0, 300)),
    ),
    Effect.flatMap((recorded) =>
      Schema.decodeEffect(Record)(recorded).pipe(Effect.mapError((cause) => external('unreadable run record', cause))),
    ),
  )
  if (parsed.unstable !== null) return yield* reject(`run ${parsed.unstable} differs in outcome from the first`)
  const { unstable: _, samples, ...execution } = parsed
  return { ...execution, samples: samples ?? undefined } satisfies Execution
})

/**
 * What a `wasmtime run` process did. Wasmtime exits 134 after a trap and describes the trap on
 * stderr after the program's own output; any other status is the program's.
 */
export const wasmtimeOutcome = (status: number | null, signal: string | null, stdout: string, stderr: string): Outcome => {
  const report = stderr.lastIndexOf('Error: failed to run main module')
  if (status === 134 && report >= 0)
    return { exit: null, trap: stderr.trim().split('\n').slice(-1)[0]?.trim() ?? 'trap', stdout, stderr: stderr.slice(0, report) }
  if (status === null) return { exit: null, trap: `wasmtime killed by ${signal}`, stdout, stderr }
  return { exit: status, trap: null, stdout, stderr }
}

const wasmtimeProcess = Effect.fnUntraced(function* (path: string, compiled: string, args: ReadonlyArray<string>) {
  const started = performance.now()
  const ran = yield* NativeProcess.execute(path, ['run', '--allow-precompiled', '--argv0', 'program', compiled, ...args], {
    cwd: dirname(compiled),
    stdio: ['ignore', 'pipe', 'pipe'],
    timeoutMs: runTimeoutMs,
  }).pipe(Effect.mapError((cause) => external('cannot run wasmtime', cause)))
  const ms = performance.now() - started
  if (ran.deadline?.expired) return yield* reject(`run timed out after ${runTimeoutMs} ms`)
  return { ms, outcome: wasmtimeOutcome(ran.status, ran.signal, ran.stdout.toString('utf8'), ran.stderr.toString('utf8')) }
})

/** Compiles `module` ahead of time, so that no run pays for Cranelift. */
const wasmtimeCompile = Effect.fnUntraced(function* (path: string, module: string, compiled: string) {
  const built = yield* NativeProcess.execute(path, ['compile', module, '-o', compiled], { timeoutMs: runTimeoutMs }).pipe(
    Effect.mapError((cause) => external('cannot run wasmtime', cause)),
  )
  if (built.status !== 0)
    return yield* reject(`wasmtime compile failed: ${built.stderr.toString('utf8').trim().split('\n')[0] ?? ''}`.slice(0, 300))
})

// (module (memory (export "memory") 1) (func (export "_start")))
const emptyCommand = Uint8Array.from([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x04, 0x01, 0x60, 0x00, 0x00, 0x03, 0x02, 0x01, 0x00, 0x05,
  0x03, 0x01, 0x00, 0x01, 0x07, 0x13, 0x02, 0x06, 0x6d, 0x65, 0x6d, 0x6f, 0x72, 0x79, 0x02, 0x00, 0x06, 0x5f, 0x73,
  0x74, 0x61, 0x72, 0x74, 0x00, 0x00, 0x0a, 0x04, 0x01, 0x02, 0x00, 0x0b,
])
/**
 * Checks that the Wasmtime at `path` runs a precompiled command, and keeps an empty one for the
 * scope: `run` times it beside every run, to take a process's own cost off the run's time.
 */
export const wasmtime = Effect.fn('WasmEngine.wasmtime')(function* (path: string) {
  const fs = yield* FileSystem.FileSystem
  const directory = yield* fs
    .makeTempDirectoryScoped({ prefix: 'silk-wasmtime-' })
    .pipe(Effect.mapError((cause) => external('cannot make a directory', cause)))
  const module = join(directory, 'empty.wasm')
  yield* fs.writeFile(module, emptyCommand).pipe(Effect.mapError((cause) => external('cannot write a module', cause)))
  const empty = join(directory, 'empty.cwasm')
  yield* wasmtimeCompile(path, module, empty)
  const ran = yield* wasmtimeProcess(path, empty, [])
  if (ran.outcome.exit !== 0) return yield* reject(`wasmtime cannot run an empty command: ${ran.outcome.trap ?? ran.outcome.exit}`)
  return { path, empty } satisfies Wasmtime
})

const runWasmtime = Effect.fnUntraced(function* (engine: Wasmtime, request: Request) {
  if (request.sample === true || (request.counters ?? 0) > 0) return yield* reject('only a V8 engine samples or reads counters')
  const fs = yield* FileSystem.FileSystem
  const compiled = `${request.module}.cwasm`
  const present = yield* fs.exists(compiled).pipe(Effect.mapError((cause) => external('cannot look for the compiled module', cause)))
  if (!present) yield* wasmtimeCompile(engine.path, request.module, compiled)
  const processes: Array<number> = []
  const startups: Array<number> = []
  let first: Outcome | undefined
  // What the runs took so far, were a process to cost what the empty command took last.
  const ms = (): ReadonlyArray<number> => processes.map((value) => Math.max(0, value - (startups.at(-1) ?? 0)))
  while (more(request.repeat, ms())) {
    startups.push((yield* wasmtimeProcess(engine.path, engine.empty, [])).ms)
    const ran = yield* wasmtimeProcess(engine.path, compiled, request.arguments)
    if (first === undefined) first = ran.outcome
    else if (!same(first, ran.outcome)) return yield* reject(`run ${processes.length + 1} differs in outcome from the first`)
    processes.push(ran.ms)
  }
  const startup = median(startups) ?? 0
  return {
    ...(first ?? { exit: null, trap: 'did not run', stdout: '', stderr: '' }),
    ms: processes.map((value) => Math.max(0, value - startup)),
    counters: [],
    samples: undefined,
  } satisfies Execution
})

/**
 * Runs a module's `_start` until `request.repeat` is satisfied; fails if a later run's outcome
 * differs from the first's. A V8 engine compiles the module once in one Node process, makes a new
 * instance for each run and times `_start` alone, so with `v8-tiering` the first run includes
 * Liftoff's compilation and later runs use what tiered up. Wasmtime precompiles the module, starts
 * a process for each run and times the process, less the median time of the empty command's
 * process, which it runs before each.
 */
export const run = Effect.fn('WasmEngine.run')(function* (
  engine: V8Engine | Wasmtime,
  request: Request,
): Effect.fn.Return<Execution, WasmEngineError, FileSystem.FileSystem> {
  return yield* typeof engine === 'string' ? Effect.scoped(runV8(engine, request)) : runWasmtime(engine, request)
})

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const require = createRequire(new URL('../../package.json', import.meta.url))
  const { NodeServices }: typeof import('@effect/platform-node') = await import(
    pathToFileURL(require.resolve('@effect/platform-node')).href
  )
  await Effect.runPromise(
    Effect.scoped(serve(process.argv[2] ?? '')).pipe(
      Effect.provide(NodeServices.layer),
      Effect.catch((error) =>
        Effect.sync(() => {
          process.stderr.write(`${error.message}\n`)
          process.exitCode = 2
        }),
      ),
    ),
  )
}
