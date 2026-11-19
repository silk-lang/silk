// Builds `corpus/native` programs for wasm32-wasip1 and runs them: as a differential corpus run of
// one backend and optimization, as a benchmark that measures tracked programs built by both
// backends in several engines, or as a profile of where one program's execution goes. A developer
// tool, not a CI check; see compiler/README.md.
import { createRequire } from 'node:module'
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
import * as WasmEngine from './WasmEngine.ts'
import * as WasmModule from './WasmModule.ts'

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
/**
 * One engine's times for one build in one pass, in milliseconds: the first run of the compiled
 * module, and the median of the `runs - 1` runs after it.
 */
export interface Timing {
  readonly firstMs: number
  readonly steadyMs: number
  readonly runs: number
}
/** One build of a benchmark program. */
export interface Measure {
  readonly bytes: number
  readonly functions: number
  /** The instructions one run executes, in all and by class. The same in every engine and pass. */
  readonly executed: WasmModule.Counts
  /** By engine name, the build's timing in each pass, in order. */
  readonly timings: Readonly<Record<string, ReadonlyArray<Timing>>>
}
export type BenchmarkProgram =
  | { readonly name: string; readonly builds: Readonly<Record<string, Measure>> }
  | { readonly name: string; readonly error: string }
export interface BenchmarkReport {
  readonly schemaVersion: 2
  readonly compiler: string
  readonly engines: ReadonlyArray<string>
  /** How many times the benchmark timed every program, one whole pass after another. */
  readonly passes: number
  readonly programs: ReadonlyArray<BenchmarkProgram>
}
/** Which of a timing's two times: the first run, or the median of the runs after it. */
export type Phase = 'first' | 'steady'
/**
 * The phases worth reporting for an engine. Wasmtime has no first run to tell apart: each of its
 * runs is a new process of the same precompiled code.
 */
export const phases = (engine: string): ReadonlyArray<Phase> => (engine === 'wasmtime' ? ['steady'] : ['steady', 'first'])
/** The optimizations a benchmark builds, each with both backends. */
const optimizations = ['speed', 'size'] as const

const reject = (message: string) => new WasmCorpusError({ message, reason: 'RejectedInput' })
const external = (message: string, cause: unknown) =>
  new WasmCorpusError({
    message: `${message}: ${cause instanceof Error ? cause.message : String(cause)}`,
    reason: 'ExternalFailure',
    cause,
  })
const here = dirname(fileURLToPath(import.meta.url))
const buildTimeoutMs = 600_000
/** Programs whose LLVM time is at or below this are too short for their ratio to mean anything. */
export const ratioFloorMs = 2
/** A benchmark runs each build until two runs after the first have taken 200 ms together. */
const benchmarkRepeat: WasmEngine.Repeat = { steadyRuns: 2, steadyMs: 200 }
/** A profile samples for longer, since a function needs many samples for its share to settle. */
const profileRepeat: WasmEngine.Repeat = { steadyRuns: 2, steadyMs: 1000 }
const programModule = 'memory/driver.silk'

/** Why a program cannot run as a wasm32-wasip1 command under `node:wasi`, if it cannot. */
export const skipReason = (program: Corpus.Program): string | undefined => {
  if (Object.keys(program.cSources).length > 0) return 'links C units'
  if (program.outcome.components !== undefined) return 'binds components'
  if (program.outcome.dynamicLibraries !== undefined) return 'loads dynamic libraries'
  if (program.outcome.expected.kind === 'rejected') return 'is rejected at compile time'
  return undefined
}

/** `text` as a JSON string, cut to 400 characters with a note of how many were left out. */
const quoted = (text: string): string =>
  text.length <= 400 ? JSON.stringify(text) : `${JSON.stringify(text.slice(0, 400))} (${text.length - 400} more characters)`

/** How a run differs from what the program's `outcome.json` and expected output files require. */
export const compareOutcome = (
  program: Corpus.Program,
  invocation: Corpus.Run,
  observed: WasmEngine.Outcome,
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
    return `stdout: expected ${quoted(program.stdout)}, got ${quoted(observed.stdout)}`
  if (!invocation.closeStderr && program.stderr !== undefined && observed.stderr !== program.stderr)
    return `stderr: expected ${quoted(program.stderr)}, got ${quoted(observed.stderr)}`
  return undefined
}

/** The parts of a run that every correct build of a program must agree on, in every engine. */
const signature = (observed: WasmEngine.Outcome): string =>
  JSON.stringify([observed.exit, observed.trap !== null, observed.stdout])

export const geometricMean = (values: ReadonlyArray<number>): number | undefined =>
  values.length === 0
    ? undefined
    : Math.exp(values.reduce((sum, value) => sum + Math.log(value), 0) / values.length)

type Measured = Extract<BenchmarkProgram, { builds: unknown }>
const measured = (program: BenchmarkProgram): program is Measured => 'builds' in program

/** One number of a build, such as a time; undefined where the build has none. */
export type Figure = (measure: Measure) => number | undefined

/** A build's time in an engine in one pass, or its least over the passes when no pass is given. */
export const time =
  (engine: string, phase: Phase, pass?: number): Figure =>
  (measure) => {
    const timings = measure.timings[engine] ?? []
    const values = (pass === undefined ? timings : timings.slice(pass, pass + 1)).map((timing) =>
      phase === 'first' ? timing.firstMs : timing.steadyMs,
    )
    return values.length === 0 ? undefined : Math.min(...values)
  }
const executedInstructions: Figure = (measure) => measure.executed.instructions

/**
 * The direct build's number over the LLVM build's for one optimization; null where the program
 * was not measured, either build is missing, or either number is missing or not positive.
 */
export const ratio = (program: BenchmarkProgram, optimization: Optimization, figure: Figure): number | null => {
  if (!measured(program)) return null
  const llvmBuild = program.builds[buildKey({ backend: 'llvm', optimization })]
  const directBuild = program.builds[buildKey({ backend: 'direct', optimization })]
  const llvm = llvmBuild === undefined ? undefined : figure(llvmBuild)
  const direct = directBuild === undefined ? undefined : figure(directBuild)
  if (llvm === undefined || direct === undefined || llvm <= 0 || direct <= 0) return null
  return direct / llvm
}

/**
 * A program's direct/LLVM time ratio in an engine in each of `passes` passes, in order. Null
 * unless every pass timed both builds and the LLVM build took longer than `ratioFloorMs`: a
 * program counts in a pass only if it counts in all of them, so that a mean over programs and the
 * mean of each pass are taken over the same programs.
 */
export const passRatios = (
  program: BenchmarkProgram,
  optimization: Optimization,
  engine: string,
  phase: Phase,
  passes: number,
): ReadonlyArray<number> | null => {
  if (!measured(program) || passes < 1) return null
  const llvm = program.builds[buildKey({ backend: 'llvm', optimization })]
  const each: Array<number> = []
  for (let pass = 0; pass < passes; pass++) {
    const llvmMs = llvm === undefined ? undefined : time(engine, phase, pass)(llvm)
    const entry = ratio(program, optimization, time(engine, phase, pass))
    if (llvmMs === undefined || llvmMs <= ratioFloorMs || entry === null) return null
    each.push(entry)
  }
  return each
}

/**
 * The direct/LLVM time ratio of one program in one engine: the geometric mean of the ratios
 * `passRatios` gives, and null where it gives none. A pass times the two builds one right after
 * the other, so what the machine's other work does to both cancels in the pass's ratio, which the
 * ratio of two best times would not ensure.
 */
export const timeRatio = (
  program: BenchmarkProgram,
  optimization: Optimization,
  engine: string,
  phase: Phase,
  passes: number,
): number | null => {
  const each = passRatios(program, optimization, engine, phase, passes)
  return each === null ? null : (geometricMean(each) ?? null)
}

/** The geometric mean of the programs' ratios that `of` gives, and how many programs have one. */
export const meanRatio = (
  programs: ReadonlyArray<BenchmarkProgram>,
  of: (program: BenchmarkProgram) => number | null,
): { readonly mean: number | undefined; readonly count: number } => {
  const ratios = programs.flatMap((program) => {
    const entry = of(program)
    return entry === null ? [] : [entry]
  })
  return { mean: geometricMean(ratios), count: ratios.length }
}

/** How far measurements of the same thing lie apart. */
export interface Noise {
  /** The geometric mean, over the things measured, of the greatest measurement over the least, less one. */
  readonly typical: number
  /** The largest such difference, and the thing that showed it. */
  readonly worst: number
  readonly where: string
}
const between = (things: ReadonlyArray<{ readonly where: string; readonly values: ReadonlyArray<number> }>): Noise | undefined => {
  const spreads = things
    .filter((thing) => thing.values.length >= 2)
    .map((thing) => ({ where: thing.where, spread: Math.max(...thing.values) / Math.min(...thing.values) }))
  const typical = geometricMean(spreads.map((entry) => entry.spread))
  const worst = spreads.reduce<(typeof spreads)[number] | undefined>(
    (most, entry) => (most === undefined || entry.spread > most.spread ? entry : most),
    undefined,
  )
  return typical === undefined || worst === undefined ? undefined : { typical: typical - 1, worst: worst.spread - 1, where: worst.where }
}

/**
 * How far an engine's times of the same build differ from pass to pass, over builds timed in
 * every pass and slower than `ratioFloorMs` in each. Undefined with fewer than two passes. It
 * measures the machine: a time from another benchmark run differs by this much with no change to
 * the compiler.
 */
export const timeNoise = (report: BenchmarkReport, engine: string, phase: Phase): Noise | undefined =>
  between(
    report.programs.filter(measured).flatMap((program) =>
      Object.entries(program.builds).flatMap(([key, measure]) => {
        const values = (measure.timings[engine] ?? []).map((timing) => (phase === 'first' ? timing.firstMs : timing.steadyMs))
        return values.length === report.passes && values.every((value) => value > ratioFloorMs)
          ? [{ where: `${program.name} ${key}`, values }]
          : []
      }),
    ),
  )

/**
 * How far an engine's direct/LLVM ratio of the same program differs from pass to pass, over the
 * programs and optimizations that have a ratio in every pass, as `passRatios` decides. Undefined
 * with fewer than two passes. A change in a ratio that is smaller than this is not a result.
 */
export const ratioNoise = (report: BenchmarkReport, engine: string, phase: Phase): Noise | undefined =>
  between(
    report.programs.flatMap((program) =>
      optimizations.flatMap((optimization) => {
        const each = passRatios(program, optimization, engine, phase, report.passes)
        return each === null ? [] : [{ where: `${program.name} ${optimization}`, values: each }]
      }),
    ),
  )

const milliseconds = (ms: number): string => (ms < 100 ? ms.toFixed(2) : ms.toFixed(1))
const times = (value: number | null | undefined): string => (value === null || value === undefined ? '-' : `${value.toFixed(2)}x`)
const share = (value: number): string => `${(value * 100).toFixed(1)}%`
const percent = (before: number, after: number): string => {
  const change = (after / before - 1) * 100
  return `${change > 0 ? '+' : ''}${change.toFixed(1)}%`
}
const row = (cells: ReadonlyArray<string>): string => `| ${cells.join(' | ')} |`
const rule = (count: number): string => row(Array.from({ length: count }, () => '---'))
const table = (header: ReadonlyArray<string>, rows: ReadonlyArray<ReadonlyArray<string>>): string =>
  [row(header), rule(header.length), ...rows.map(row)].join('\n')
/** The label of a mean of time ratios, which counts a program only if `passRatios` gives it ratios. */
const timeMeanLabel = `geometric mean, LLVM > ${ratioFloorMs} ms in every pass`

/** One row per program: a number of each of the four builds, with the direct/LLVM ratio after each pair. */
const comparisonTable = (
  programs: ReadonlyArray<Measured>,
  unit: string,
  figure: Figure,
  show: (value: number) => string,
  of: (optimization: Optimization) => (program: BenchmarkProgram) => number | null,
  meanLabel: string,
): string =>
  table(
    ['program', ...optimizations.flatMap((optimization) => [`LLVM ${optimization} ${unit}`, `direct ${optimization} ${unit}`, 'ratio'])],
    [
      ...programs.map((program) => [
        program.name,
        ...optimizations.flatMap((optimization) => [
          ...(['llvm', 'direct'] as const).map((backend) => {
            const measure = program.builds[buildKey({ backend, optimization })]
            const value = measure === undefined ? undefined : figure(measure)
            return value === undefined ? '-' : show(value)
          }),
          times(of(optimization)(program)),
        ]),
      ]),
      [
        meanLabel,
        ...optimizations.flatMap((optimization) => {
          const mean = meanRatio(programs, of(optimization))
          return ['', `${mean.count} programs`, times(mean.mean)]
        }),
      ],
    ],
  )

const noiseCell = (noise: Noise | undefined): string =>
  noise === undefined ? '-' : `${share(noise.typical)} typical, ${share(noise.worst)} at ${noise.where}`

/**
 * The headline of a benchmark as markdown. For each engine, for steady state and for the first
 * run: the geometric mean of the programs' direct/LLVM time ratios, with the least and greatest
 * mean of a single pass when there are several, and how far ratios and times lie apart between
 * passes. Every mean of one cell is over the same programs, those `passRatios` gives ratios for,
 * so the headline lies within the range of the passes. Then the same mean for executed
 * instructions, which no pass changes.
 */
export const summaryTable = (report: BenchmarkReport): string => {
  const programs = report.programs.filter(measured)
  const mean = (optimization: Optimization, engine: string, phase: Phase): string => {
    const all = meanRatio(programs, (program) => timeRatio(program, optimization, engine, phase, report.passes))
    const each = Array.from(
      { length: report.passes },
      (_, pass) =>
        meanRatio(programs, (program) => passRatios(program, optimization, engine, phase, report.passes)?.[pass] ?? null).mean,
    ).filter((value) => value !== undefined)
    const range = each.length < 2 ? '' : ` (${times(Math.min(...each))} to ${times(Math.max(...each))})`
    return `${times(all.mean)}${range}, ${all.count} programs`
  }
  const instructions = (optimization: Optimization): string => {
    const all = meanRatio(programs, (program) => ratio(program, optimization, executedInstructions))
    return `${times(all.mean)}, ${all.count} programs`
  }
  return table(
    ['engine', 'time', 'speed builds, direct/LLVM', 'size builds, direct/LLVM', 'ratios between passes', 'times between passes'],
    [
      ...report.engines.flatMap((engine) =>
        phases(engine).map((phase) => [
          engine,
          phase === 'first' ? 'first run' : 'steady state',
          mean('speed', engine, phase),
          mean('size', engine, phase),
          noiseCell(ratioNoise(report, engine, phase)),
          noiseCell(timeNoise(report, engine, phase)),
        ]),
      ),
      ['executed instructions', '', instructions('speed'), instructions('size'), 'none', 'none'],
    ],
  )
}

/**
 * The benchmark as markdown: the summary, then per engine each program's least steady-state time
 * over the passes with its direct/LLVM time ratio, then executed instructions, module sizes and
 * function counts, then the programs that were not measured and why.
 */
export const benchmarkTable = (report: BenchmarkReport): string => {
  const programs = report.programs.filter(measured)
  const sections = [summaryTable(report)]
  for (const engine of report.engines)
    sections.push(
      `${engine}, steady state:\n\n${comparisonTable(
        programs,
        'ms',
        time(engine, 'steady'),
        milliseconds,
        (optimization) => (program) => timeRatio(program, optimization, engine, 'steady', report.passes),
        timeMeanLabel,
      )}`,
    )
  sections.push(
    `Executed instructions:\n\n${comparisonTable(
      programs,
      'instructions',
      executedInstructions,
      String,
      (optimization) => (program) => ratio(program, optimization, executedInstructions),
      'geometric mean',
    )}`,
  )
  sections.push(
    table(
      ['program', ...benchmarkBuilds.flatMap((build) => [`${buildKey(build)} bytes`, 'functions'])],
      programs.map((program) => [
        program.name,
        ...benchmarkBuilds.flatMap((build) => {
          const measure = program.builds[buildKey(build)]
          return measure === undefined ? ['-', '-'] : [String(measure.bytes), String(measure.functions)]
        }),
      ]),
    ),
  )
  const failed = report.programs.flatMap((program) => ('error' in program ? [program] : []))
  if (failed.length > 0) sections.push(['Not measured:', ...failed.map((program) => `- ${program.name}: ${program.error}`)].join('\n'))
  return `${sections.join('\n\n')}\n`
}

/**
 * What changed since an earlier benchmark, as markdown, over the programs both reports measured.
 * Times of two benchmark runs cannot be compared, since the machine's other work moves them, so
 * per engine both reports timed this shows each program's steady-state direct/LLVM ratio before
 * and after; a change is marked `~` when a pass of one report had a ratio within the other's
 * passes, which makes it noise as far as the two reports can tell. A program without a ratio in
 * every pass of both reports, as `passRatios` decides, shows `-`. Then, exactly, each build's
 * executed instructions and each direct build's module size, and the programs and engines the
 * earlier benchmark did not measure.
 */
export const changeTable = (before: BenchmarkReport, after: BenchmarkReport): string => {
  const earlier = new Map(before.programs.filter(measured).map((program) => [program.name, program]))
  const pairs = after.programs.filter(measured).flatMap((program) => {
    const old = earlier.get(program.name)
    return old === undefined ? [] : [{ name: program.name, old, now: program }]
  })
  const change = (was: number | undefined, is: number | undefined, show: (value: number) => string, mark = ''): string =>
    was === undefined || is === undefined ? '-' : `${show(was)} → ${show(is)} (${mark}${percent(was, is)})`
  const meanChange = (changes: ReadonlyArray<number | undefined>): string => {
    const mean = geometricMean(changes.filter((value) => value !== undefined))
    return mean === undefined ? '-' : `${times(mean)} of before`
  }
  const sections: Array<string> = []
  for (const engine of after.engines.filter((name) => before.engines.includes(name))) {
    const cells = optimizations.map((optimization) =>
      pairs.map(({ old, now }) => {
        const from = passRatios(old, optimization, engine, 'steady', before.passes)
        const to = passRatios(now, optimization, engine, 'steady', after.passes)
        const was = from === null ? undefined : geometricMean(from)
        const is = to === null ? undefined : geometricMean(to)
        if (from === null || to === null || was === undefined || is === undefined) return { text: '-', change: undefined }
        const overlap = Math.min(...from) <= Math.max(...to) && Math.min(...to) <= Math.max(...from)
        return { text: change(was, is, times, overlap ? '~' : ''), change: is / was }
      }),
    )
    sections.push(
      `${engine}, steady state, direct/LLVM:\n\n${table(
        ['program', ...optimizations.map((optimization) => `${optimization} builds`)],
        [
          ...pairs.map(({ name }, position) => [name, ...cells.map((column) => column[position]?.text ?? '-')]),
          [timeMeanLabel, ...cells.map((column) => meanChange(column.map((cell) => cell.change)))],
        ],
      )}`,
    )
  }
  const directs = benchmarkBuilds.filter((build) => build.backend === 'direct')
  const bytes: Figure = (measure) => measure.bytes
  const columns = [
    ...benchmarkBuilds.map((build) => ({ build, figure: executedInstructions, name: 'instructions' })),
    ...directs.map((build) => ({ build, figure: bytes, name: 'bytes' })),
  ]
  const numbers = (column: (typeof columns)[number], pair: (typeof pairs)[number]) => {
    const was = pair.old.builds[buildKey(column.build)]
    const is = pair.now.builds[buildKey(column.build)]
    return { was: was && column.figure(was), is: is && column.figure(is) }
  }
  sections.push(
    table(
      ['program', ...columns.map((column) => `${buildKey(column.build)} ${column.name}`)],
      [
        ...pairs.map((pair) => [
          pair.name,
          ...columns.map((column) => {
            const { was, is } = numbers(column, pair)
            return change(was, is, String)
          }),
        ]),
        [
          'geometric mean',
          ...columns.map((column) =>
            meanChange(
              pairs.map((pair) => {
                const { was, is } = numbers(column, pair)
                return was === undefined || is === undefined || was <= 0 ? undefined : is / was
              }),
            ),
          ),
        ],
      ],
    ),
  )
  const unmeasured = after.programs.filter((program) => measured(program) && !earlier.has(program.name)).map((program) => program.name)
  if (unmeasured.length > 0) sections.push(`Not measured in the earlier benchmark: ${unmeasured.join(', ')}`)
  const untimed = after.engines.filter((name) => !before.engines.includes(name))
  if (untimed.length > 0) sections.push(`Not timed in the earlier benchmark: ${untimed.join(', ')}`)
  return `${sections.join('\n\n')}\n`
}

/** One function of a profiled build. */
export interface FunctionProfile {
  /** The function's name, or `#` and its index when the module has no name for it. */
  readonly function: string
  /** Sampled time in the function's own code, in milliseconds per run. */
  readonly selfMs: number
  readonly calls: number
  /** Instructions of its own body one run executes, not those of the functions it calls. */
  readonly instructions: number
}
/** Where one build's execution goes. */
export interface BuildProfile {
  readonly bytes: number
  readonly functions: number
  /** Parameters of the functions the module defines, added up. */
  readonly parameters: number
  /** The mean time of a run while sampling, in milliseconds. */
  readonly runMs: number
  /** The part of `runMs` not sampled in the module's code: WASI calls and the engine. */
  readonly hostMs: number
  /** Instructions the module contains, in all and by class. */
  readonly contains: WasmModule.Counts
  /** Instructions one run executes, in all and by class. */
  readonly executed: WasmModule.Counts
  /** Every function a run called or was sampled in, by decreasing self time. */
  readonly profile: ReadonlyArray<FunctionProfile>
}
export type ProfileProgram =
  | { readonly name: string; readonly llvm: BuildProfile; readonly direct: BuildProfile }
  | { readonly name: string; readonly error: string }
export interface ProfileReport {
  readonly schemaVersion: 1
  readonly compiler: string
  readonly engine: string
  readonly optimization: Optimization
  readonly programs: ReadonlyArray<ProfileProgram>
}

/** The functions among the `top` by self time or by executed instructions, by decreasing self time. */
export const hottest = (profile: ReadonlyArray<FunctionProfile>, top: number): ReadonlyArray<FunctionProfile> => {
  const leading = (pick: (entry: FunctionProfile) => number) =>
    [...profile].sort((left, right) => pick(right) - pick(left)).slice(0, top).filter((entry) => pick(entry) > 0)
  const chosen = new Set([...leading((entry) => entry.selfMs), ...leading((entry) => entry.instructions)])
  return [...chosen].sort((left, right) => right.selfMs - left.selfMs || right.instructions - left.instructions)
}

/**
 * A profile as markdown. Per program: the two builds side by side (run time, size, and each class
 * of instruction as the module contains it and as a run executes it), then each build's hottest
 * `top` functions.
 */
export const profileTable = (report: ProfileReport, top: number): string => {
  const sections: Array<string> = []
  for (const program of report.programs) {
    if ('error' in program) {
      sections.push(`${program.name}: not profiled: ${program.error}`)
      continue
    }
    const { llvm, direct } = program
    const pair = (name: string, pick: (build: BuildProfile) => number, show: (value: number) => string) => [
      name,
      show(pick(llvm)),
      show(pick(direct)),
      pick(llvm) > 0 ? times(pick(direct) / pick(llvm)) : '-',
    ]
    sections.push(
      `${program.name}, ${report.optimization} builds, ${report.engine}:\n\n${table(
        ['measure', 'LLVM', 'direct', 'direct/LLVM'],
        [
          pair('run ms', (build) => build.runMs, milliseconds),
          pair('module bytes', (build) => build.bytes, String),
          pair('functions', (build) => build.functions, String),
          pair('parameters per function', (build) => build.parameters / Math.max(1, build.functions), (value) => value.toFixed(2)),
        ],
      )}`,
      table(
        ['instructions', 'LLVM contains', 'direct contains', 'direct/LLVM', 'LLVM executes', 'direct executes', 'direct/LLVM'],
        WasmModule.counted.map((name) => [
          name === 'instructions' ? 'all' : name,
          ...pair('', (build) => build.contains[name], String).slice(1),
          ...pair('', (build) => build.executed[name], String).slice(1),
        ]),
      ),
    )
    for (const [backend, build] of [['LLVM', llvm], ['direct', direct]] as const) {
      const of = (part: number, whole: number): string => (whole > 0 ? share(part / whole) : '-')
      sections.push(
        `${program.name}, ${backend}, hottest functions of ${build.profile.length} that ran:\n\n${table(
          ['function', 'self ms', 'of the run', 'calls', 'instructions', 'of all'],
          [
            ...hottest(build.profile, top).map((entry) => [
              entry.function,
              milliseconds(entry.selfMs),
              of(entry.selfMs, build.runMs),
              String(entry.calls),
              String(entry.instructions),
              of(entry.instructions, build.executed.instructions),
            ]),
            ['outside the module', milliseconds(build.hostMs), of(build.hostMs, build.runMs), '', '', ''],
          ],
        )}`,
      )
    }
  }
  return `${sections.join('\n\n')}\n`
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
    '[package]\nname = "corpus"\nsilk-version = "0.0.0"\nversion = "0.1.0"\nsource = "."\n',
  )
  for (const [module, contents] of Object.entries(program.imports)) {
    if (module.startsWith('/') || module.split('/').includes('..'))
      return yield* reject(`unsafe corpus import path: ${module}`)
    const path = join(directory, dirname(programModule), `${module}.silk`)
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

/** One build of a program: the module, what it contains, and a copy that counts what it executes. */
interface Built {
  readonly build: Build
  readonly path: string
  readonly module: WasmModule.WasmModule
  readonly counting: { readonly path: string; readonly runs: ReadonlyArray<WasmModule.Run> }
}

const v8 = (engine: WasmEngine.V8Engine | WasmEngine.Wasmtime): engine is WasmEngine.V8Engine => typeof engine === 'string'
const engineName = (engine: WasmEngine.V8Engine | WasmEngine.Wasmtime): string => (v8(engine) ? engine : 'wasmtime')

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
      const observed = yield* WasmEngine.run('v8-optimizing', {
        module,
        arguments: invocation.arguments ?? [],
        repeat: WasmEngine.once,
      })
      const mismatch = compareOutcome(program, invocation, observed)
      if (mismatch !== undefined)
        return { name, status: 'FAIL', reason: `run ${ordinal + 1}: ${mismatch}` } satisfies ProgramResult
      ms += WasmEngine.timing(observed.ms).firstMs
    }
    const bytes = (yield* fs.readFile(module)).length
    return { name, status: 'PASS', ms, bytes } satisfies ProgramResult
  })
  return yield* Effect.scoped(outcome).pipe(
    Effect.catch((error) => Effect.succeed({ name, status: 'FAIL', reason: error.message } satisfies ProgramResult)),
  )
})

/** Lays out one program in `directory`, builds it each way in `builds` and reads each module. */
export const buildProgram = Effect.fn('WasmCorpus.buildProgram')(function* (
  toolchain: Toolchain,
  name: string,
  directory: string,
  builds: ReadonlyArray<Build>,
) {
  const fs = yield* FileSystem.FileSystem
  const program = yield* loadProgram(name)
  const skipped = skipReason(program)
  if (skipped !== undefined) return yield* reject(`${name} ${skipped}`)
  yield* writeProgram(directory, program)
  const modules: Array<Built> = []
  for (const build of builds) {
    const path = join(directory, `${buildKey(build)}.wasm`)
    yield* buildModule(toolchain, directory, build, path).pipe(
      Effect.mapError((error) => reject(`${buildKey(build)} build failed: ${error.message}`)),
    )
    const module = yield* WasmModule.decode(yield* fs.readFile(path)).pipe(
      Effect.mapError((error) => reject(`${buildKey(build)}: ${error.message}`)),
    )
    const counting = yield* WasmModule.counting(module)
    const countingPath = join(directory, `${buildKey(build)}.counting.wasm`)
    yield* fs.writeFile(countingPath, counting.bytes)
    modules.push({ build, path, module, counting: { path: countingPath, runs: counting.runs } })
  }
  return { program, modules }
})
type BuiltProgram = Effect.Success<ReturnType<typeof buildProgram>>

/**
 * A check shared by every execution of one program: the function it returns runs each run of the
 * program through `execute`, and fails unless each has the program's expected outcome and agrees
 * with every execution checked before it, whatever the build and engine.
 */
const agreeing = (program: Corpus.Program) => {
  const invocations = program.outcome.runs ?? [{}]
  const agreed: Array<string | undefined> = []
  return Effect.fnUntraced(function* (what: string, execute: (invocation: Corpus.Run) => ReturnType<typeof WasmEngine.run>) {
    const executions: Array<WasmEngine.Execution> = []
    for (const [ordinal, invocation] of invocations.entries()) {
      const execution = yield* execute(invocation)
      const mismatch = compareOutcome(program, invocation, execution)
      if (mismatch !== undefined) return yield* reject(`${what} run ${ordinal + 1}: ${mismatch}`)
      agreed[ordinal] ??= signature(execution)
      if (agreed[ordinal] !== signature(execution))
        return yield* reject(`${what} run ${ordinal + 1} differs in outcome from the first build and engine`)
      executions.push(execution)
    }
    return executions
  })
}

/** What one run of a counting module executes, each run of the program added up. */
const countExecuted = Effect.fnUntraced(function* (built: Built, checked: ReturnType<typeof agreeing>) {
  const executions = yield* checked(`${buildKey(built.build)} counting`, (invocation) =>
    WasmEngine.run('v8-optimizing', {
      module: built.counting.path,
      arguments: invocation.arguments ?? [],
      repeat: WasmEngine.once,
      counters: built.counting.runs.length,
    }),
  )
  const each = yield* Effect.forEach(executions, (execution) =>
    WasmModule.executed(built.module, built.counting.runs, execution.counters),
  )
  return {
    counts: WasmModule.sum(each.map((entry) => [entry.counts, 1] as const)),
    functions: built.module.functions.map((_, position) => ({
      calls: each.reduce((sum, entry) => sum + (entry.functions[position]?.calls ?? 0), 0),
      instructions: each.reduce((sum, entry) => sum + (entry.functions[position]?.instructions ?? 0), 0),
    })),
  }
})

/**
 * One pass over a built program. For each optimization and engine it times the builds one right
 * after the other, so that a pass's direct/LLVM ratio compares times taken seconds apart, and
 * nothing else it starts competes with a timed run. Counts executed instructions when `counted`.
 */
const timeProgram = Effect.fnUntraced(function* (
  built: BuiltProgram,
  engines: ReadonlyArray<WasmEngine.V8Engine | WasmEngine.Wasmtime>,
  counted: boolean,
) {
  const checked = agreeing(built.program)
  const executed: Record<string, WasmModule.Counts> = {}
  const timings: Record<string, Record<string, Timing>> = {}
  if (counted) for (const module of built.modules) executed[buildKey(module.build)] = (yield* countExecuted(module, checked)).counts
  for (const optimization of new Set(built.modules.map((module) => module.build.optimization)))
    for (const engine of engines)
      for (const module of built.modules.filter((candidate) => candidate.build.optimization === optimization)) {
        const key = buildKey(module.build)
        const executions = yield* checked(`${key} in ${engineName(engine)}`, (invocation) =>
          WasmEngine.run(engine, { module: module.path, arguments: invocation.arguments ?? [], repeat: benchmarkRepeat }),
        )
        const each = executions.map((execution) => ({ ...WasmEngine.timing(execution.ms), runs: execution.ms.length }))
        timings[key] = {
          ...timings[key],
          [engineName(engine)]: {
            firstMs: each.reduce((sum, timing) => sum + timing.firstMs, 0),
            steadyMs: each.reduce((sum, timing) => sum + timing.steadyMs, 0),
            runs: Math.min(...each.map((timing) => timing.runs)),
          },
        }
      }
  return { executed, timings }
})

const buildAll = Effect.fnUntraced(function* (
  toolchain: Toolchain,
  names: ReadonlyArray<string>,
  builds: ReadonlyArray<Build>,
  jobs: number,
) {
  const fs = yield* FileSystem.FileSystem
  const root = yield* fs.makeTempDirectoryScoped({ prefix: 'silk-wasm-benchmark-' })
  return yield* Effect.forEach(
    names,
    (name) =>
      buildProgram(toolchain, name, join(root, name), builds).pipe(
        Effect.tap(() => Console.log(`built ${name}`)),
        Effect.map((value) => ({ name, value, error: undefined })),
        Effect.catch((error) =>
          Console.log(`not built ${name}: ${error.message}`).pipe(Effect.as({ name, value: undefined, error: error.message })),
        ),
      ),
    { concurrency: jobs },
  )
})

/**
 * Runs the benchmark over `names`: builds `jobs` programs at a time, then times every program in
 * every engine, `passes` times over. Whole passes follow each other, so that two timings of one
 * build are minutes apart and their difference shows how much the machine's other work moves a
 * time.
 */
export const benchmark = Effect.fn('WasmCorpus.benchmark')(function* (
  toolchain: Toolchain,
  names: ReadonlyArray<string>,
  engines: ReadonlyArray<WasmEngine.V8Engine | WasmEngine.Wasmtime>,
  passes: number,
  jobs: number,
) {
  const built = yield* buildAll(toolchain, names, benchmarkBuilds, jobs)
  const failed = new Map(built.flatMap((entry) => (entry.error === undefined ? [] : [[entry.name, entry.error] as const])))
  const measures = new Map<string, Record<string, Measure>>()
  for (let pass = 0; pass < passes; pass++)
    for (const entry of built) {
      if (entry.value === undefined || failed.has(entry.name)) continue
      const value = entry.value
      const timed = yield* timeProgram(value, engines, pass === 0).pipe(
        Effect.catch((error) => Effect.succeed(error.message)),
      )
      yield* Console.log(`timed ${entry.name}, pass ${pass + 1} of ${passes}${typeof timed === 'string' ? `: ${timed}` : ''}`)
      if (typeof timed === 'string') {
        failed.set(entry.name, timed)
        continue
      }
      const builds = measures.get(entry.name) ?? {}
      for (const module of value.modules) {
        const key = buildKey(module.build)
        const earlier = builds[key]
        const executed = earlier?.executed ?? timed.executed[key]
        if (executed === undefined) continue
        builds[key] = {
          bytes: module.module.bytes.length,
          functions: module.module.functions.length,
          executed,
          timings: Object.fromEntries(
            Object.entries(timed.timings[key] ?? {}).map(([engine, timing]) => [engine, [...(earlier?.timings[engine] ?? []), timing]]),
          ),
        }
      }
      measures.set(entry.name, builds)
    }
  const programs = built.map((entry): BenchmarkProgram => {
    const error = failed.get(entry.name)
    return error === undefined ? { name: entry.name, builds: measures.get(entry.name) ?? {} } : { name: entry.name, error }
  })
  return { schemaVersion: 2, compiler: toolchain.compiler, engines: engines.map(engineName), passes, programs } satisfies BenchmarkReport
})

const profileBuild = Effect.fnUntraced(function* (
  built: Built,
  engine: WasmEngine.V8Engine,
  checked: ReturnType<typeof agreeing>,
) {
  const key = buildKey(built.build)
  const executed = yield* countExecuted(built, checked)
  const executions = yield* checked(`${key} in ${engine}`, (invocation) =>
    WasmEngine.run(engine, { module: built.path, arguments: invocation.arguments ?? [], repeat: profileRepeat, sample: true }),
  )
  // Self time per run of the program: each of its runs sampled over several runs of the module.
  const self = new Map<number, number>()
  let runMs = 0
  for (const execution of executions) {
    runMs += execution.ms.reduce((sum, value) => sum + value, 0) / execution.ms.length
    for (const [offset, microseconds] of execution.samples?.functions ?? [])
      self.set(offset, (self.get(offset) ?? 0) + microseconds / (1000 * execution.ms.length))
  }
  const profile = built.module.functions.flatMap((entry, position): ReadonlyArray<FunctionProfile> => {
    const ran = executed.functions[position] ?? { calls: 0, instructions: 0 }
    const selfMs = self.get(entry.offset) ?? 0
    return ran.calls === 0 && selfMs === 0 ? [] : [{ function: WasmModule.label(entry), selfMs, ...ran }]
  })
  const inModule = profile.reduce((sum, entry) => sum + entry.selfMs, 0)
  return {
    bytes: built.module.bytes.length,
    functions: built.module.functions.length,
    parameters: built.module.functions.reduce((sum, entry) => sum + entry.parameters, 0),
    runMs,
    hostMs: Math.max(0, runMs - inModule),
    contains: WasmModule.staticCounts(built.module),
    executed: executed.counts,
    profile: profile.sort((left, right) => right.selfMs - left.selfMs || right.instructions - left.instructions),
  } satisfies BuildProfile
})

/**
 * Profiles `names`: builds each with LLVM and the direct backend at `optimization`, counts what a
 * run of each executes per function, and samples where `engine` spends each run's time.
 */
export const profile = Effect.fn('WasmCorpus.profile')(function* (
  toolchain: Toolchain,
  names: ReadonlyArray<string>,
  optimization: Optimization,
  engine: WasmEngine.V8Engine,
  jobs: number,
) {
  const builds: ReadonlyArray<Build> = [{ backend: 'llvm', optimization }, { backend: 'direct', optimization }]
  const built = yield* buildAll(toolchain, names, builds, jobs)
  const programs: Array<ProfileProgram> = []
  for (const entry of built) {
    const [llvm, direct] = entry.value?.modules ?? []
    if (entry.value === undefined || llvm === undefined || direct === undefined) {
      programs.push({ name: entry.name, error: entry.error ?? 'not built' })
      continue
    }
    const checked = agreeing(entry.value.program)
    const profiled = yield* Effect.all([profileBuild(llvm, engine, checked), profileBuild(direct, engine, checked)]).pipe(
      Effect.map(([left, right]): ProfileProgram => ({ name: entry.name, llvm: left, direct: right })),
      Effect.catch((error) => Effect.succeed<ProfileProgram>({ name: entry.name, error: error.message })),
    )
    yield* Console.log(`profiled ${entry.name}${'error' in profiled ? `: ${profiled.error}` : ''}`)
    programs.push(profiled)
  }
  return { schemaVersion: 1, compiler: toolchain.compiler, engine, optimization, programs } satisfies ProfileReport
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

const Timing = Schema.Struct({ firstMs: Schema.Finite, steadyMs: Schema.Finite, runs: Schema.Finite })
const Counts = Schema.Struct(
  Object.fromEntries(WasmModule.counted.map((name) => [name, Schema.Finite])) as Record<WasmModule.Counted, typeof Schema.Finite>,
)
const Measure = Schema.Struct({
  bytes: Schema.Finite,
  functions: Schema.Finite,
  executed: Counts,
  timings: Schema.Record(Schema.String, Schema.Array(Timing)),
})
const BenchmarkFile = Schema.fromJsonString(
  Schema.Struct({
    schemaVersion: Schema.Literal(2),
    compiler: Schema.String,
    engines: Schema.Array(Schema.String),
    passes: Schema.Finite,
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

const usage = `usage:
  node compiler/scripts/WasmCorpus.ts corpus --compiler <silkc> [--backend direct|llvm] [--optimization none|speed|size]
       [--only a,b] [--jobs N] [--stdlib <dir>] [--json <file>] [--baseline <earlier corpus json>]
  node compiler/scripts/WasmCorpus.ts bench --compiler <silkc> [--engines ${WasmEngine.engines.join(',')}]
       [--wasmtime <wasmtime>] [--passes N] [--only a,b] [--jobs N] [--stdlib <dir>] [--json <file>]
       [--baseline <earlier bench json>]
  node compiler/scripts/WasmCorpus.ts profile --compiler <silkc> [--only a,b] [--optimization speed|size]
       [--engine ${WasmEngine.v8Engines.join('|')}] [--top N] [--jobs N] [--stdlib <dir>] [--json <file>]`

const positive = (text: string, option: string) => {
  const value = Number(text)
  return Number.isSafeInteger(value) && value > 0 ? Effect.succeed(value) : Effect.fail(reject(`--${option} must be a positive integer`))
}
const among = <A extends string>(text: string, choices: ReadonlyArray<A>, option: string) => {
  const found = choices.find((choice) => choice === text)
  return found === undefined ? Effect.fail(reject(`--${option} must be one of ${choices.join(', ')}`)) : Effect.succeed(found)
}
/** A comma-separated list of distinct, nonempty names. */
const names = (text: string, option: string) => {
  const list = text.split(',')
  const repeated = list.filter((name, at) => list.indexOf(name) !== at)
  if (list.some((name) => name === '')) return Effect.fail(reject(`--${option} has an empty name`))
  if (repeated.length > 0) return Effect.fail(reject(`--${option} repeats ${repeated.join(', ')}`))
  return Effect.succeed(list)
}

const options = {
  compiler: { type: 'string' },
  stdlib: { type: 'string' },
  jobs: { type: 'string' },
  json: { type: 'string' },
  only: { type: 'string' },
  baseline: { type: 'string' },
  backend: { type: 'string' },
  optimization: { type: 'string' },
  engines: { type: 'string' },
  wasmtime: { type: 'string' },
  passes: { type: 'string' },
  engine: { type: 'string' },
  top: { type: 'string' },
} as const
/** The options each mode reads; any other is a mistake, such as `--engine` for `--engines`. */
const modeOptions: Readonly<Record<'corpus' | 'bench' | 'profile', ReadonlyArray<keyof typeof options>>> = {
  corpus: ['compiler', 'stdlib', 'jobs', 'json', 'only', 'baseline', 'backend', 'optimization'],
  bench: ['compiler', 'stdlib', 'jobs', 'json', 'only', 'baseline', 'engines', 'wasmtime', 'passes'],
  profile: ['compiler', 'stdlib', 'jobs', 'json', 'only', 'optimization', 'engine', 'top'],
}

const cli = Effect.gen(function* () {
  const { values, positionals } = yield* Effect.try({
    try: () => parseArgs({ allowPositionals: true, options }),
    catch: (cause) => reject(`${cause instanceof Error ? cause.message : String(cause)}\n${usage}`),
  })
  const [mode, ...rest] = positionals
  if ((mode !== 'corpus' && mode !== 'bench' && mode !== 'profile') || rest.length > 0 || values.compiler === undefined)
    return yield* reject(usage)
  const stray = Object.keys(values).filter((name) => !modeOptions[mode].some((option) => option === name))
  if (stray.length > 0) return yield* reject(`the ${mode} mode does not take ${stray.map((name) => `--${name}`).join(', ')}\n${usage}`)
  const toolchain = {
    compiler: resolve(values.compiler),
    stdlib: resolve(values.stdlib ?? join(Corpus.repositoryRoot, 'stdlib')),
  }
  const jobs = yield* positive(values.jobs ?? '2', 'jobs')
  const all = yield* Effect.try({
    try: () => Corpus.programNames('native'),
    catch: (cause) => external('cannot list the corpus programs', cause),
  })
  const only = values.only === undefined ? undefined : yield* names(values.only, 'only')
  const fs = yield* FileSystem.FileSystem
  if (mode === 'corpus') {
    const backend = yield* among(values.backend ?? 'direct', ['direct', 'llvm'], 'backend')
    const optimization = yield* among(values.optimization ?? 'speed', ['none', 'speed', 'size'], 'optimization')
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
  const trackPath = join(here, 'wasm-benchmark-track.json')
  const text = yield* fs.readFileString(trackPath).pipe(Effect.mapError((cause) => external(`cannot read ${trackPath}`, cause)))
  const track = yield* validateTrack(text, all)
  const unknown = (only ?? []).filter((name) => !track.includes(name))
  if (unknown.length > 0) return yield* reject(`not in the benchmark track: ${unknown.join(', ')}`)
  const programs = only ?? track
  if (mode === 'profile') {
    const optimization = yield* among(values.optimization ?? 'speed', ['speed', 'size'], 'optimization')
    const engine = yield* among(values.engine ?? 'v8-baseline', WasmEngine.v8Engines, 'engine')
    const top = yield* positive(values.top ?? '12', 'top')
    const report = yield* Effect.scoped(profile(toolchain, programs, optimization, engine, jobs))
    yield* Console.log(`\n${profileTable(report, top)}`)
    if (values.json !== undefined) yield* writeJson(values.json, report)
    if (report.programs.some((program) => 'error' in program)) yield* Effect.sync(() => { process.exitCode = 1 })
    return
  }
  const passes = yield* positive(values.passes ?? '2', 'passes')
  // Every V8 configuration by default, and Wasmtime when the command says where it is.
  const named =
    values.engines === undefined
      ? [...WasmEngine.v8Engines, ...(values.wasmtime === undefined ? [] : (['wasmtime'] as const))]
      : yield* Effect.forEach(yield* names(values.engines, 'engines'), (name) => among(name, WasmEngine.engines, 'engines'))
  const wasmtimePath = values.wasmtime === undefined ? undefined : resolve(values.wasmtime)
  if (named.includes('wasmtime') && wasmtimePath === undefined) return yield* reject('the wasmtime engine needs --wasmtime <wasmtime>')
  if (!named.includes('wasmtime') && wasmtimePath !== undefined) return yield* reject('--wasmtime is for the wasmtime engine, which --engines leaves out')
  const before = values.baseline === undefined ? undefined : yield* readJson(values.baseline, BenchmarkFile)
  if (before !== undefined && !before.programs.some((program) => measured(program) && programs.includes(program.name)))
    return yield* reject(`${values.baseline} measured none of the programs to benchmark`)
  const report = yield* Effect.scoped(
    Effect.gen(function* () {
      const wasmtime = wasmtimePath === undefined ? undefined : yield* WasmEngine.wasmtime(wasmtimePath)
      const engines = named.flatMap((name) => (name !== 'wasmtime' ? [name] : wasmtime === undefined ? [] : [wasmtime]))
      return yield* benchmark(toolchain, programs, engines, passes, jobs)
    }),
  )
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
