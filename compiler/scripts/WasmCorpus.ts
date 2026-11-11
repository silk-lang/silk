// Builds `corpus/native` programs for wasm32-wasip1 and runs them under `node:wasi`: as a
// differential corpus run of one backend and optimization, or as a benchmark that times tracked
// programs built by both backends. A developer tool, not a CI check; see compiler/README.md.
import { createRequire } from 'node:module'
import { performance } from 'node:perf_hooks'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import * as Console from 'effect/Console'
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Schema from 'effect/Schema'
import * as Corpus from '../../corpus/corpus.mjs'
import * as NativeProcess from './NativeProcess.ts'

export class WasmCorpusError extends Data.TaggedError('WasmCorpusError')<{
  readonly message: string
  readonly reason: 'RejectedInput' | 'ExternalFailure'
  readonly cause?: unknown
}> {}

export type Backend = 'direct' | 'llvm'
export type Optimization = 'none' | 'speed' | 'size'
/** One way to build a program: a backend and an optimization level. */
export interface Build {
  readonly backend: Backend
  readonly optimization: Optimization
}
/** The four builds a benchmark compares, LLVM before direct for each optimization. */
export const benchmarkBuilds: ReadonlyArray<Build> = [
  { backend: 'llvm', optimization: 'speed' },
  { backend: 'direct', optimization: 'speed' },
  { backend: 'llvm', optimization: 'size' },
  { backend: 'direct', optimization: 'size' },
]
export const buildKey = (build: Build): string => `${build.backend}-${build.optimization}`

/**
 * One program's corpus result: `PASS`, `FAIL` (built, but a run had the wrong outcome), `BUILD`
 * (the build failed) or `SKIP` (the program cannot run as a wasm32-wasip1 command).
 */
export interface ProgramResult {
  readonly name: string
  readonly status: 'PASS' | 'FAIL' | 'BUILD' | 'SKIP'
  readonly reason?: string
  /** Execution time of the runs, in milliseconds, for a passing program. */
  readonly ms?: number
  /** Module size in bytes, for a passing program. */
  readonly bytes?: number
}
/** What one run of a module did, as the runner observed it. */
export interface Observed {
  readonly exit: number | null
  readonly trap: string | null
  readonly stdout: string
  readonly stderr: string
  readonly ms: number
}
/** One build of a benchmark program. `ms` sums the best time of each corpus run. */
export interface Measure {
  readonly ms: number
  readonly bytes: number
  readonly functions: number
}
export type BenchmarkProgram =
  | { readonly name: string; readonly builds: Readonly<Record<string, Measure>> }
  | { readonly name: string; readonly error: string }
export interface BenchmarkReport {
  readonly schemaVersion: 1
  readonly compiler: string
  readonly runs: number
  readonly programs: ReadonlyArray<BenchmarkProgram>
}

const reject = (message: string) => new WasmCorpusError({ message, reason: 'RejectedInput' })
const external = (message: string, cause: unknown) =>
  new WasmCorpusError({
    message: `${message}: ${cause instanceof Error ? cause.message : String(cause)}`,
    reason: 'ExternalFailure',
    cause,
  })
const here = dirname(fileURLToPath(import.meta.url))
const buildTimeoutMs = 600_000
const runTimeoutMs = 300_000
/** Programs whose LLVM time is at or below this are too short for their ratio to mean anything. */
export const ratioFloorMs = 2
const programModule = 'memory/driver.silk'

/** Why a program cannot run as a wasm32-wasip1 command under `node:wasi`, if it cannot. */
export const skipReason = (program: Corpus.Program): string | undefined => {
  if (Object.keys(program.cSources).length > 0) return 'links C units'
  if (program.outcome.components !== undefined) return 'binds components'
  if (program.outcome.dynamicLibraries !== undefined) return 'loads dynamic libraries'
  if (program.outcome.expected.kind === 'rejected') return 'is rejected at compile time'
  return undefined
}

/** How a run differs from what the program's `outcome.json` and expected output files require. */
export const compareOutcome = (
  program: Corpus.Program,
  invocation: Corpus.Run,
  observed: Observed,
): string | undefined => {
  const expected = program.outcome.expected
  if (expected.kind === 'trap') {
    if (observed.trap === null && observed.exit === 0) return 'expected a trap, exited 0'
  } else if (expected.kind === 'completes') {
    if (observed.trap !== null) return `trapped: ${observed.trap}`
    if (observed.exit === null || (observed.exit & 0xff) !== (expected.exitCode & 0xff))
      return `exit ${observed.exit}, expected ${expected.exitCode}`
  } else return 'a native program must complete or trap'
  if (program.stdout !== undefined && observed.stdout !== program.stdout)
    return `stdout: expected ${JSON.stringify(program.stdout.slice(0, 80))}, got ${JSON.stringify(observed.stdout.slice(0, 80))}`
  if (!invocation.closeStderr && program.stderr !== undefined && observed.stderr !== program.stderr)
    return `stderr: expected ${JSON.stringify(program.stderr.slice(0, 80))}, got ${JSON.stringify(observed.stderr.slice(0, 80))}`
  return undefined
}

/** The parts of a run that every correct build of a program must agree on. */
const signature = (observed: Observed): string =>
  JSON.stringify([observed.exit, observed.trap !== null, observed.stdout])

const leb = (bytes: Uint8Array, at: number): { value: number; next: number } | undefined => {
  let value = 0
  for (let shift = 0, next = at; shift < 35 && next < bytes.length; shift += 7) {
    const byte = bytes[next++] ?? 0
    value += (byte & 0x7f) * 2 ** shift
    if ((byte & 0x80) === 0) return { value, next }
  }
  return undefined
}
/** The number of functions a core wasm module defines, or undefined if it is malformed. */
export const wasmFunctionCount = (bytes: Uint8Array): number | undefined => {
  const header = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]
  if (bytes.length < header.length || header.some((byte, at) => bytes[at] !== byte))
    return undefined
  for (let at = header.length; at < bytes.length; ) {
    const id = bytes[at] ?? 0
    const size = leb(bytes, at + 1)
    if (size === undefined || size.next + size.value > bytes.length) return undefined
    if (id === 3) return leb(bytes, size.next)?.value
    at = size.next + size.value
  }
  return 0
}

export const geometricMean = (values: ReadonlyArray<number>): number | undefined =>
  values.length === 0
    ? undefined
    : Math.exp(values.reduce((sum, value) => sum + Math.log(value), 0) / values.length)

const measured = (program: BenchmarkProgram): program is Extract<BenchmarkProgram, { builds: unknown }> =>
  'builds' in program

/** The direct/LLVM time ratio per program for one optimization; null where a build is missing. */
export const timeRatio = (
  program: BenchmarkProgram,
  optimization: Optimization,
): { readonly ratio: number; readonly llvmMs: number } | null => {
  if (!measured(program)) return null
  const llvm = program.builds[buildKey({ backend: 'llvm', optimization })]
  const direct = program.builds[buildKey({ backend: 'direct', optimization })]
  if (llvm === undefined || direct === undefined || llvm.ms <= 0) return null
  return { ratio: direct.ms / llvm.ms, llvmMs: llvm.ms }
}

/** Geometric mean of the direct/LLVM ratio over programs whose LLVM time exceeds `ratioFloorMs`. */
export const meanRatio = (
  programs: ReadonlyArray<BenchmarkProgram>,
  optimization: Optimization,
): { readonly mean: number | undefined; readonly count: number } => {
  const ratios = programs
    .map((program) => timeRatio(program, optimization))
    .filter((entry) => entry !== null && entry.llvmMs > ratioFloorMs)
    .map((entry) => entry?.ratio ?? 1)
  return { mean: geometricMean(ratios), count: ratios.length }
}

const milliseconds = (ms: number): string => (ms < 100 ? ms.toFixed(2) : ms.toFixed(1))
const times = (ratio: number | undefined): string => (ratio === undefined ? '-' : `${ratio.toFixed(2)}x`)
const percent = (before: number, after: number): string => {
  const change = (after / before - 1) * 100
  return `${change > 0 ? '+' : ''}${change.toFixed(1)}%`
}
const row = (cells: ReadonlyArray<string>): string => `| ${cells.join(' | ')} |`
const rule = (count: number): string => row(Array.from({ length: count }, () => '---'))

/** The benchmark as markdown: times with direct/LLVM ratios, then sizes and function counts. */
export const benchmarkTable = (report: BenchmarkReport): string => {
  const programs = report.programs.filter(measured)
  const cell = (program: (typeof programs)[number], build: Build, pick: (measure: Measure) => string) => {
    const measure = program.builds[buildKey(build)]
    return measure === undefined ? '-' : pick(measure)
  }
  const [llvmSpeed, directSpeed, llvmSize, directSize] = benchmarkBuilds as [Build, Build, Build, Build]
  const timeHeader = ['program', 'LLVM speed ms', 'direct speed ms', 'ratio', 'LLVM size ms', 'direct size ms', 'ratio']
  const lines = [row(timeHeader), rule(timeHeader.length)]
  for (const program of programs)
    lines.push(
      row([
        program.name,
        cell(program, llvmSpeed, (measure) => milliseconds(measure.ms)),
        cell(program, directSpeed, (measure) => milliseconds(measure.ms)),
        times(timeRatio(program, 'speed')?.ratio),
        cell(program, llvmSize, (measure) => milliseconds(measure.ms)),
        cell(program, directSize, (measure) => milliseconds(measure.ms)),
        times(timeRatio(program, 'size')?.ratio),
      ]),
    )
  const speed = meanRatio(programs, 'speed')
  const size = meanRatio(programs, 'size')
  lines.push(
    row([
      `geometric mean, LLVM > ${ratioFloorMs} ms`,
      '',
      `${speed.count} programs`,
      times(speed.mean),
      '',
      `${size.count} programs`,
      times(size.mean),
    ]),
  )
  const sizeHeader = ['program', ...benchmarkBuilds.flatMap((build) => [`${buildKey(build)} bytes`, 'functions'])]
  lines.push('', row(sizeHeader), rule(sizeHeader.length))
  for (const program of programs)
    lines.push(
      row([
        program.name,
        ...benchmarkBuilds.flatMap((build) => [
          cell(program, build, (measure) => String(measure.bytes)),
          cell(program, build, (measure) => String(measure.functions)),
        ]),
      ]),
    )
  const failed = report.programs.filter((program) => !measured(program))
  if (failed.length > 0) {
    lines.push('', 'Not measured:')
    for (const program of failed) lines.push(`- ${program.name}: ${'error' in program ? program.error : ''}`)
  }
  return `${lines.join('\n')}\n`
}

/**
 * What changed since an earlier benchmark, as markdown: per program and build the time before and
 * after, then the module size of each direct build, and the geometric mean of the time change.
 */
export const changeTable = (before: BenchmarkReport, after: BenchmarkReport): string => {
  const earlier = new Map(before.programs.filter(measured).map((program) => [program.name, program]))
  const pairs = after.programs.filter(measured).flatMap((program) => {
    const old = earlier.get(program.name)
    return old === undefined ? [] : [{ name: program.name, old: old.builds, now: program.builds }]
  })
  const directs = benchmarkBuilds.filter((build) => build.backend === 'direct')
  const header = [
    'program',
    ...benchmarkBuilds.map((build) => `${buildKey(build)} ms`),
    ...directs.map((build) => `${buildKey(build)} bytes`),
  ]
  const lines = [row(header), rule(header.length)]
  const change = (old: Measure | undefined, now: Measure | undefined, pick: (measure: Measure) => number, show: (value: number) => string) =>
    old === undefined || now === undefined
      ? '-'
      : `${show(pick(old))} → ${show(pick(now))} (${percent(pick(old), pick(now))})`
  for (const { name, old, now } of pairs)
    lines.push(
      row([
        name,
        ...benchmarkBuilds.map((build) =>
          change(old[buildKey(build)], now[buildKey(build)], (measure) => measure.ms, milliseconds),
        ),
        ...directs.map((build) =>
          change(old[buildKey(build)], now[buildKey(build)], (measure) => measure.bytes, String),
        ),
      ]),
    )
  const meanChange = (build: Build) => {
    const ratios = pairs.flatMap(({ old, now }) => {
      const was = old[buildKey(build)]
      const is = now[buildKey(build)]
      return was === undefined || is === undefined || was.ms <= ratioFloorMs ? [] : [is.ms / was.ms]
    })
    const mean = geometricMean(ratios)
    return mean === undefined ? '-' : `${times(mean)} of before`
  }
  lines.push(row([`geometric mean, before > ${ratioFloorMs} ms`, ...benchmarkBuilds.map(meanChange), ...directs.map(() => '')]))
  const absent = after.programs.filter((program) => !earlier.has(program.name)).map((program) => program.name)
  if (absent.length > 0) lines.push('', `Not in the earlier benchmark: ${absent.join(', ')}`)
  return `${lines.join('\n')}\n`
}

/** Programs that passed in `before` and do not pass in `after`; programs absent from `after` are not compared. */
export const regressions = (
  before: ReadonlyArray<Pick<ProgramResult, 'name' | 'status'>>,
  after: ReadonlyArray<ProgramResult>,
): ReadonlyArray<ProgramResult> => {
  const passed = new Set(before.filter((result) => result.status === 'PASS').map((result) => result.name))
  return after.filter((result) => result.status !== 'PASS' && passed.has(result.name))
}

export const summary = (results: ReadonlyArray<ProgramResult>): string => {
  const count = (status: ProgramResult['status']) => results.filter((result) => result.status === status).length
  return `PASS ${count('PASS')} FAIL ${count('FAIL')} BUILD ${count('BUILD')} SKIP ${count('SKIP')} of ${results.length}`
}

/** A benchmark track is a nonempty list of distinct names of `corpus/native` programs. */
export const validateTrack = Effect.fn('WasmCorpus.validateTrack')(function* (
  text: string,
  names: ReadonlyArray<string>,
): Effect.fn.Return<ReadonlyArray<string>, WasmCorpusError> {
  const track = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.NonEmptyArray(Schema.NonEmptyString)))(
    text,
  ).pipe(Effect.mapError((cause) => new WasmCorpusError({ message: `benchmark track: ${cause.message}`, reason: 'RejectedInput', cause })))
  const duplicates = track.filter((name, at) => track.indexOf(name) !== at)
  if (duplicates.length > 0) return yield* reject(`benchmark track repeats ${duplicates.join(', ')}`)
  const known = new Set(names)
  const missing = track.filter((name) => !known.has(name))
  if (missing.length > 0) return yield* reject(`benchmark track names absent from the corpus: ${missing.join(', ')}`)
  return track
})

const loadProgram = Effect.fnUntraced(function* (name: string) {
  return yield* Effect.try({
    try: () => Corpus.loadProgram('native', name),
    catch: (cause) => external(`cannot read corpus program ${name}`, cause),
  })
})

/** Lays a program out as a package: its module at `memory/driver.silk` and its imports beside it. */
const writeProgram = Effect.fnUntraced(function* (directory: string, program: Corpus.Program) {
  const fs = yield* FileSystem.FileSystem
  yield* fs.makeDirectory(join(directory, dirname(programModule)), { recursive: true })
  yield* fs.writeFileString(join(directory, programModule), program.source)
  yield* fs.writeFileString(
    join(directory, 'silk.toml'),
    '[package]\nname = "corpus"\nversion = "0.1.0"\nsource = "."\n',
  )
  for (const [module, contents] of Object.entries(program.imports)) {
    if (module.startsWith('/') || module.split('/').includes('..'))
      return yield* reject(`unsafe corpus import path: ${module}`)
    const path = join(directory, `${module}.silk`)
    yield* fs.makeDirectory(dirname(path), { recursive: true })
    yield* fs.writeFileString(path, contents)
  }
})

export interface Toolchain {
  readonly compiler: string
  readonly stdlib: string
}

/** Builds the laid-out program into `output`; fails with the compiler's last lines if it cannot. */
const buildModule = Effect.fnUntraced(function* (
  toolchain: Toolchain,
  directory: string,
  build: Build,
  output: string,
) {
  const built = yield* NativeProcess.execute(
    toolchain.compiler,
    [
      'build',
      programModule,
      '-o',
      output,
      '--target',
      'wasm32-wasip1',
      '--backend',
      build.backend,
      '--optimization',
      build.optimization,
      // Corpus programs keep unused bindings, and a warning fails a build.
      '--ignore-warnings',
      '--stdlib',
      toolchain.stdlib,
    ],
    { cwd: directory, timeoutMs: buildTimeoutMs },
  ).pipe(Effect.mapError((cause) => external('cannot run the compiler', cause)))
  if (built.status === 0 && built.signal === null) return
  const lines = built.stderr.toString('utf8').trim().split('\n')
  const why = built.deadline?.expired ? 'timed out' : lines.slice(-2).join(' | ').slice(0, 300)
  return yield* reject(why)
})

const RunRecord = Schema.fromJsonString(
  Schema.Struct({ exit: Schema.NullOr(Schema.Finite), trap: Schema.NullOr(Schema.String), ms: Schema.Finite }),
)

/**
 * Runs a module once in a fresh Node process. V8 compiles every function with its optimizing
 * tier before the run starts, so the time covers only execution, not compilation or tier-up.
 */
const runModule = Effect.fnUntraced(function* (module: string, invocation: Corpus.Run, record: string) {
  const fs = yield* FileSystem.FileSystem
  yield* fs.remove(record, { force: true })
  const ran = yield* NativeProcess.execute(
    process.execPath,
    [
      '--no-liftoff',
      '--no-wasm-lazy-compilation',
      '--disable-warning=ExperimentalWarning',
      join(here, 'WasmCorpus.ts'),
      'exec',
      module,
      record,
      ...(invocation.arguments ?? []),
    ],
    {
      cwd: dirname(module),
      stdio: ['ignore', 'pipe', invocation.closeStderr ? 'ignore' : 'pipe'],
      timeoutMs: runTimeoutMs,
    },
  ).pipe(Effect.mapError((cause) => external('cannot run node', cause)))
  if (ran.deadline?.expired) return yield* reject(`run timed out after ${runTimeoutMs} ms`)
  const text = yield* fs.readFileString(record).pipe(
    Effect.mapError(() =>
      reject(`runner exited ${ran.signal ?? ran.status}: ${ran.stderr.toString('utf8').trim().split('\n').slice(-1)[0] ?? ''}`.slice(0, 300)),
    ),
  )
  const parsed = yield* Schema.decodeEffect(RunRecord)(text).pipe(
    Effect.mapError((cause) => external('unreadable run record', cause)),
  )
  return {
    ...parsed,
    stdout: ran.stdout.toString('utf8'),
    stderr: ran.stderr.toString('utf8'),
  } satisfies Observed
})

/** Builds and runs each run of one program; never fails, since every outcome is a result. */
export const checkProgram = Effect.fn('WasmCorpus.checkProgram')(function* (
  toolchain: Toolchain,
  build: Build,
  name: string,
) {
  const outcome = Effect.gen(function* () {
    const program = yield* loadProgram(name)
    const skipped = skipReason(program)
    if (skipped !== undefined) return { name, status: 'SKIP', reason: skipped } satisfies ProgramResult
    const fs = yield* FileSystem.FileSystem
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'silk-wasm-corpus-' })
    yield* writeProgram(directory, program)
    const module = join(directory, 'program.wasm')
    const built = yield* buildModule(toolchain, directory, build, module).pipe(
      Effect.map(() => undefined),
      Effect.catch((error) => Effect.succeed(error.message)),
    )
    if (built !== undefined) return { name, status: 'BUILD', reason: built } satisfies ProgramResult
    let ms = 0
    for (const [ordinal, invocation] of (program.outcome.runs ?? [{}]).entries()) {
      const observed = yield* runModule(module, invocation, join(directory, 'run.json'))
      const mismatch = compareOutcome(program, invocation, observed)
      if (mismatch !== undefined)
        return { name, status: 'FAIL', reason: `run ${ordinal + 1}: ${mismatch}` } satisfies ProgramResult
      ms += observed.ms
    }
    const bytes = (yield* fs.readFile(module)).length
    return { name, status: 'PASS', ms, bytes } satisfies ProgramResult
  })
  return yield* Effect.scoped(outcome).pipe(
    Effect.catch((error) => Effect.succeed({ name, status: 'FAIL', reason: error.message } satisfies ProgramResult)),
  )
})

/** Lays out one benchmark program in `directory` and builds it all four ways. */
export const benchmarkProgram = Effect.fn('WasmCorpus.benchmarkProgram')(function* (
  toolchain: Toolchain,
  name: string,
  directory: string,
) {
  const program = yield* loadProgram(name)
  const skipped = skipReason(program)
  if (skipped !== undefined) return yield* reject(`${name} ${skipped}`)
  yield* writeProgram(directory, program)
  const modules = benchmarkBuilds.map((build) => ({ build, module: join(directory, `${buildKey(build)}.wasm`) }))
  for (const { build, module } of modules)
    yield* buildModule(toolchain, directory, build, module).pipe(
      Effect.mapError((error) => reject(`${buildKey(build)} build failed: ${error.message}`)),
    )
  return { program, modules }
})

/** Times the built modules one after another, so no build competes with a timed run. */
const timeProgram = Effect.fnUntraced(function* (
  built: Effect.Success<ReturnType<typeof benchmarkProgram>>,
  runs: number,
  directory: string,
) {
  const fs = yield* FileSystem.FileSystem
  const { program, modules } = built
  const invocations = program.outcome.runs ?? [{}]
  const builds: Record<string, Measure> = {}
  let agreed: Array<string> | undefined
  for (const { build, module } of modules) {
    const signatures: Array<string> = []
    let ms = 0
    for (const [ordinal, invocation] of invocations.entries()) {
      let best = Infinity
      for (let attempt = 0; attempt < runs; attempt++) {
        const observed = yield* runModule(module, invocation, join(directory, 'run.json'))
        const mismatch = compareOutcome(program, invocation, observed)
        if (mismatch !== undefined) return yield* reject(`${buildKey(build)} run ${ordinal + 1}: ${mismatch}`)
        if (attempt === 0) signatures.push(signature(observed))
        else if (signature(observed) !== signatures[ordinal])
          return yield* reject(`${buildKey(build)} run ${ordinal + 1} changed outcome between attempts`)
        best = Math.min(best, observed.ms)
      }
      ms += best
    }
    if (agreed === undefined) agreed = signatures
    else if (signatures.some((value, at) => value !== agreed?.[at]))
      return yield* reject(`${buildKey(build)} differs in outcome from ${buildKey(benchmarkBuilds[0] as Build)}`)
    const bytes = yield* fs.readFile(module)
    const functions = wasmFunctionCount(bytes)
    if (functions === undefined) return yield* reject(`${buildKey(build)} is not a core wasm module`)
    builds[buildKey(build)] = { ms, bytes: bytes.length, functions }
  }
  return builds
})

/** Runs the benchmark over `names`: builds `jobs` programs at a time, then times them one at a time. */
export const benchmark = Effect.fn('WasmCorpus.benchmark')(function* (
  toolchain: Toolchain,
  names: ReadonlyArray<string>,
  runs: number,
  jobs: number,
) {
  const fs = yield* FileSystem.FileSystem
  const root = yield* fs.makeTempDirectoryScoped({ prefix: 'silk-wasm-benchmark-' })
  const built = yield* Effect.forEach(
    names,
    (name) => {
      const directory = join(root, name)
      return benchmarkProgram(toolchain, name, directory).pipe(
        Effect.tap(() => Console.log(`built ${name}`)),
        Effect.map((value) => ({ name, directory, value, error: undefined })),
        Effect.catch((error) =>
          Console.log(`not built ${name}: ${error.message}`).pipe(
            Effect.as({ name, directory, value: undefined, error: error.message }),
          ),
        ),
      )
    },
    { concurrency: jobs },
  )
  const programs: Array<BenchmarkProgram> = []
  for (const entry of built) {
    if (entry.value === undefined) {
      programs.push({ name: entry.name, error: entry.error ?? 'not built' })
      continue
    }
    const timed = yield* timeProgram(entry.value, runs, entry.directory).pipe(
      Effect.map((builds): BenchmarkProgram => ({ name: entry.name, builds })),
      Effect.catch((error) => Effect.succeed<BenchmarkProgram>({ name: entry.name, error: error.message })),
    )
    yield* Console.log(`timed ${entry.name}${'error' in timed ? `: ${timed.error}` : ''}`)
    programs.push(timed)
  }
  return { schemaVersion: 1, compiler: toolchain.compiler, runs, programs } satisfies BenchmarkReport
})

/** Checks `names` with one build, `jobs` at a time, printing each result as it finishes. */
export const corpus = Effect.fn('WasmCorpus.corpus')(function* (
  toolchain: Toolchain,
  build: Build,
  names: ReadonlyArray<string>,
  jobs: number,
) {
  const results = yield* Effect.forEach(
    names,
    (name) =>
      checkProgram(toolchain, build, name).pipe(
        Effect.tap((result) =>
          Console.log(
            `${result.status.padEnd(5)} ${name}  ${result.status === 'PASS' ? `${milliseconds(result.ms ?? 0)} ms ${result.bytes} bytes` : (result.reason ?? '')}`,
          ),
        ),
      ),
    { concurrency: jobs },
  )
  return [...results].sort((left, right) => left.name.localeCompare(right.name))
})

const Measure = Schema.Struct({ ms: Schema.Finite, bytes: Schema.Finite, functions: Schema.Finite })
const BenchmarkFile = Schema.fromJsonString(
  Schema.Struct({
    schemaVersion: Schema.Literal(1),
    compiler: Schema.String,
    runs: Schema.Finite,
    programs: Schema.Array(
      Schema.Union([
        Schema.Struct({ name: Schema.String, builds: Schema.Record(Schema.String, Measure) }),
        Schema.Struct({ name: Schema.String, error: Schema.String }),
      ]),
    ),
  }),
)
// A comparison needs only each program's name and status.
const CorpusFile = Schema.fromJsonString(
  Schema.Struct({
    results: Schema.Array(
      Schema.Struct({ name: Schema.String, status: Schema.Literals(['PASS', 'FAIL', 'BUILD', 'SKIP']) }),
    ),
  }),
)
const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown, { space: 2 }))

const readJson = Effect.fnUntraced(function* <S extends Schema.Codec<unknown, string>>(path: string, schema: S) {
  const fs = yield* FileSystem.FileSystem
  const text = yield* fs.readFileString(path).pipe(Effect.mapError((cause) => external(`cannot read ${path}`, cause)))
  return yield* Schema.decodeEffect(schema)(text).pipe(
    Effect.mapError((cause) => new WasmCorpusError({ message: `${path}: ${cause.message}`, reason: 'RejectedInput', cause })),
  )
})
const writeJson = Effect.fnUntraced(function* (path: string, value: unknown) {
  const fs = yield* FileSystem.FileSystem
  const text = yield* encode(value).pipe(Effect.mapError((cause) => external('cannot encode results', cause)))
  yield* fs.writeFileString(path, `${text}\n`).pipe(Effect.mapError((cause) => external(`cannot write ${path}`, cause)))
})

/** The runner a measured run executes in its own process: instantiates, then times `_start` alone. */
const exec = Effect.fnUntraced(function* (module: string, record: string, args: ReadonlyArray<string>) {
  const fs = yield* FileSystem.FileSystem
  const bytes = yield* fs.readFile(module)
  // Imported here, so that only the runner process warns that WASI is experimental.
  const { WASI } = yield* Effect.tryPromise({
    try: () => import('node:wasi'),
    catch: (cause) => external('cannot load node:wasi', cause),
  })
  const wasi = new WASI({ version: 'preview1', args: ['program', ...args], env: {}, returnOnExit: true })
  // Synchronous compilation: a pending asynchronous compile does not keep Node's event loop alive.
  const instance = yield* Effect.try({
    try: () => new WebAssembly.Instance(new WebAssembly.Module(bytes), wasi.getImportObject()),
    catch: (cause) => external('cannot instantiate the module', cause),
  })
  const started = performance.now()
  const ran = yield* Effect.try({
    try: () => ({ exit: wasi.start(instance) ?? 0, trap: null }),
    catch: (cause) => cause,
  }).pipe(
    Effect.catch((cause) =>
      Effect.succeed({ exit: null, trap: cause instanceof Error ? cause.message : String(cause) }),
    ),
  )
  const ms = performance.now() - started
  yield* writeJson(record, { ...ran, ms })
})

const usage = `usage:
  node compiler/scripts/WasmCorpus.ts corpus --compiler <silkc> [--backend direct|llvm] [--optimization none|speed|size]
       [--only a,b] [--jobs N] [--json <file>] [--baseline <earlier corpus json>]
  node compiler/scripts/WasmCorpus.ts bench --compiler <silkc> [--runs N] [--only a,b] [--jobs N]
       [--json <file>] [--baseline <earlier bench json>]`

const positive = (text: string, option: string) => {
  const value = Number(text)
  return Number.isSafeInteger(value) && value > 0 ? Effect.succeed(value) : Effect.fail(reject(`--${option} must be a positive integer`))
}

const cli = Effect.gen(function* () {
  const { values, positionals } = yield* Effect.try({
    try: () =>
      parseArgs({
        allowPositionals: true,
        options: {
          compiler: { type: 'string' },
          stdlib: { type: 'string', default: join(Corpus.repositoryRoot, 'stdlib') },
          backend: { type: 'string', default: 'direct' },
          optimization: { type: 'string', default: 'speed' },
          only: { type: 'string' },
          jobs: { type: 'string', default: '2' },
          runs: { type: 'string', default: '5' },
          json: { type: 'string' },
          baseline: { type: 'string' },
        },
      }),
    catch: (cause) => reject(`${cause instanceof Error ? cause.message : String(cause)}\n${usage}`),
  })
  const [mode, ...rest] = positionals
  if (mode === 'exec') {
    const [module, record, ...args] = rest
    if (module === undefined || record === undefined) return yield* reject('usage: exec <module> <record> [arguments]')
    return yield* exec(module, record, args)
  }
  if ((mode !== 'corpus' && mode !== 'bench') || rest.length > 0 || values.compiler === undefined)
    return yield* reject(usage)
  const toolchain = { compiler: resolve(values.compiler), stdlib: resolve(values.stdlib) }
  const jobs = yield* positive(values.jobs, 'jobs')
  const all = Corpus.programNames('native')
  const only = values.only?.split(',').filter(Boolean)
  const fs = yield* FileSystem.FileSystem
  if (mode === 'corpus') {
    const backend = values.backend
    const optimization = values.optimization
    if (backend !== 'direct' && backend !== 'llvm') return yield* reject('--backend must be direct or llvm')
    if (optimization !== 'none' && optimization !== 'speed' && optimization !== 'size')
      return yield* reject('--optimization must be none, speed or size')
    const unknown = (only ?? []).filter((name) => !all.includes(name))
    if (unknown.length > 0) return yield* reject(`not corpus programs: ${unknown.join(', ')}`)
    const before = values.baseline === undefined ? undefined : yield* readJson(values.baseline, CorpusFile)
    const results = yield* corpus(toolchain, { backend, optimization }, only ?? all, jobs)
    yield* Console.log(`\nbackend=${backend} optimization=${optimization}: ${summary(results)}`)
    if (values.json !== undefined)
      yield* writeJson(values.json, { schemaVersion: 1, compiler: toolchain.compiler, backend, optimization, results })
    if (before === undefined) return
    const lost = regressions(before.results, results)
    const passed = new Set(before.results.filter((result) => result.status === 'PASS').map((result) => result.name))
    for (const result of results.filter((result) => result.status === 'PASS' && !passed.has(result.name)))
      yield* Console.log(`newly passing ${result.name}`)
    for (const result of lost) yield* Console.log(`REGRESSION ${result.name}: ${result.status} ${result.reason ?? ''}`)
    yield* Console.log(`regressions against ${values.baseline}: ${lost.length}`)
    if (lost.length > 0) yield* Effect.sync(() => { process.exitCode = 1 })
    return
  }
  const runs = yield* positive(values.runs, 'runs')
  const trackPath = join(here, 'wasm-benchmark-track.json')
  const text = yield* fs.readFileString(trackPath).pipe(Effect.mapError((cause) => external(`cannot read ${trackPath}`, cause)))
  const track = yield* validateTrack(text, all)
  const unknown = (only ?? []).filter((name) => !track.includes(name))
  if (unknown.length > 0) return yield* reject(`not in the benchmark track: ${unknown.join(', ')}`)
  const before = values.baseline === undefined ? undefined : yield* readJson(values.baseline, BenchmarkFile)
  const report = yield* Effect.scoped(benchmark(toolchain, only ?? track, runs, jobs))
  yield* Console.log(`\n${benchmarkTable(report)}`)
  if (before !== undefined) yield* Console.log(`Change since ${values.baseline}:\n\n${changeTable(before, report)}`)
  if (values.json !== undefined) yield* writeJson(values.json, report)
  if (report.programs.some((program) => 'error' in program)) yield* Effect.sync(() => { process.exitCode = 1 })
})

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const require = createRequire(new URL('../../package.json', import.meta.url))
  const { NodeServices }: typeof import('@effect/platform-node') = await import(
    pathToFileURL(require.resolve('@effect/platform-node')).href
  )
  await Effect.runPromise(
    cli.pipe(
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
