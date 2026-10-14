import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { availableParallelism, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import type { CorpusProgram, NativeRun } from '../../packages/compiler/test/support/corpus.js'

export interface Gap {
  readonly code: string
  readonly reason: string
  readonly source?: {
    readonly module: string
    readonly span: { readonly start: number; readonly end: number }
  }
}

export interface BuildDiagnostic {
  readonly code: string
  readonly span: { readonly start: number; readonly end: number }
  /** The logical module the span indexes, such as `memory/driver.silk` or a standard-library module. */
  readonly module: string
}

/** The bodies a successful build left without native borrow checking, in total and per reason. */
export interface BorrowGap {
  readonly total: number
  readonly reasons: Readonly<Record<string, number>>
}

export type CaseResult =
  | { readonly name: string; readonly status: 'pass'; readonly borrowGap?: BorrowGap }
  | {
      readonly name: string
      readonly status: 'fail'
      readonly borrowGap?: BorrowGap
      readonly code: string
      /** Every distinct semantic rejection the build printed, in order; empty for other failures. */
      readonly diagnostics: ReadonlyArray<BuildDiagnostic>
      readonly reason: string
    }
  | { readonly name: string; readonly status: 'unsupported'; readonly gaps: ReadonlyArray<Gap> }

export interface Summary {
  readonly pass: number
  readonly fail: number
  readonly unsupported: number
  readonly failureCounts: ReadonlyArray<{ readonly code: string; readonly count: number }>
  readonly gapCounts: ReadonlyArray<{ readonly code: string; readonly count: number }>
  readonly trackFailures: ReadonlyArray<string>
}

const unsupportedPrefix = 'SILK_UNSUPPORTED_JSON='
const borrowGapPrefix = 'SILK_GAP borrow-check: '
const buildErrorPrefix = 'SILK_BUILD_ERROR='
// A native build of certificate-bounded-decoding takes 28.5-30 s on the hosted Linux runner, so a
// 30 s build deadline timed it out at random; builds get 4x that, while program runs stay short.
const buildTimeoutMs = 120_000
const runTimeoutMs = 30_000

const outputLimit = 4 * 1024 * 1024
// A child that ignores SIGTERM past its deadline gets SIGKILL this much later.
const killGraceMs = 5_000

/** A finished child process, with `error` set when it could not start, timed out, or overflowed. */
interface ProcessResult {
  readonly stdout: string
  readonly stderr: string
  readonly status: number | null
  readonly signal: string | null
  readonly error?: Error
}

/**
 * Runs a child to completion with `spawnSync`'s contract: an empty closed standard input, both
 * outputs captured as UTF-8, and SIGTERM with an `ETIMEDOUT` or `ENOBUFS` error past the deadline
 * or the output limit, then SIGKILL if it outlives the grace period. Unlike `spawnSync`, other
 * cases keep running meanwhile.
 */
const runProcess = (
  command: string,
  args: ReadonlyArray<string>,
  timeout: number,
  cwd?: string,
): Promise<ProcessResult> =>
  new Promise((resolveResult) => {
    const child = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    const output = { stdout: '', stderr: '' }
    let bytes = 0
    let failure: Error | undefined
    let kill: ReturnType<typeof setTimeout> | undefined
    const stop = (code: string): void => {
      failure ??= Object.assign(new Error(`spawn ${command} ${code}`), { code })
      child.kill('SIGTERM')
      kill ??= setTimeout(() => child.kill('SIGKILL'), killGraceMs)
    }
    const timer = setTimeout(() => stop('ETIMEDOUT'), timeout)
    for (const stream of ['stdout', 'stderr'] as const) {
      child[stream].setEncoding('utf8')
      child[stream].on('data', (chunk: string) => {
        output[stream] += chunk
        bytes += Buffer.byteLength(chunk)
        if (bytes > outputLimit) stop('ENOBUFS')
      })
    }
    child.stdin.on('error', () => undefined)
    child.stdin.end()
    child.on('error', (error) => {
      failure ??= error
    })
    child.on('close', (status, signal) => {
      clearTimeout(timer)
      clearTimeout(kill)
      resolveResult({
        ...output,
        status,
        signal,
        ...(failure === undefined ? {} : { error: failure }),
      })
    })
  })

const processFailure = (process: ProcessResult): string => {
  const error = process.error?.message
  const detail = process.stderr.trim()
  return [error, detail, `exit=${process.status ?? 'none'} signal=${process.signal ?? 'none'}`]
    .filter((part) => part !== undefined && part !== '')
    .join('; ')
}

const validSpan = (span: unknown): span is BuildDiagnostic['span'] =>
  typeof span === 'object' &&
  span !== null &&
  'start' in span &&
  'end' in span &&
  typeof span.start === 'number' &&
  typeof span.end === 'number' &&
  Number.isSafeInteger(span.start) &&
  Number.isSafeInteger(span.end) &&
  span.start >= 0 &&
  span.end >= span.start

const validGap = (gap: unknown): gap is Gap => {
  if (
    typeof gap !== 'object' ||
    gap === null ||
    !('code' in gap) ||
    typeof gap.code !== 'string' ||
    gap.code.length === 0 ||
    /^[A-Z]{3}[0-9]{4}$/.test(gap.code) ||
    !('reason' in gap) ||
    typeof gap.reason !== 'string' ||
    gap.reason.length === 0
  )
    return false
  if (!('source' in gap)) return true
  const source = gap.source
  return (
    typeof source === 'object' &&
    source !== null &&
    'module' in source &&
    typeof source.module === 'string' &&
    source.module.length > 0 &&
    'span' in source &&
    validSpan(source.span)
  )
}

/**
 * Reads a successful build's borrow-check gap line,
 * `SILK_GAP borrow-check: N bodies not borrow-checked (reason n, ...; note)`. A line without a
 * per-reason breakdown keeps only its total.
 */
export const parseBorrowGap = (stderr: string): BorrowGap | undefined => {
  const line = stderr.split('\n').find((candidate) => candidate.startsWith(borrowGapPrefix))
  if (line === undefined) return undefined
  const match = /^(\d+) bodies not borrow-checked \(([^)]*)\)$/.exec(
    line.slice(borrowGapPrefix.length),
  )
  if (match === null) throw new Error(`malformed borrow-check gap line: ${line}`)
  const reasons: Record<string, number> = {}
  for (const part of (match[2] ?? '').split(';', 1)[0]?.split(', ') ?? []) {
    const reason = /^([a-z-]+) (\d+)$/.exec(part)
    if (reason !== null) reasons[reason[1] ?? ''] = Number(reason[2])
  }
  return { total: Number(match[1]), reasons }
}

/** Reads every structured support refusal; internal reason IDs are not language codes. */
export const parseUnsupported = (stderr: string): ReadonlyArray<Gap> | undefined => {
  const records = stderr.split('\n').filter((line) => line.startsWith(unsupportedPrefix))
  if (records.length === 0) return undefined
  const result: Gap[] = []
  const seen = new Set<string>()
  for (const record of records) {
    try {
      const value: unknown = JSON.parse(record.slice(unsupportedPrefix.length))
      if (typeof value !== 'object' || value === null || !('gaps' in value)) return undefined
      const gaps = value.gaps
      if (!Array.isArray(gaps) || gaps.length === 0 || !gaps.every(validGap)) return undefined
      for (const gap of gaps) {
        const copied = {
          code: gap.code,
          reason: gap.reason,
          ...(gap.source === undefined ? {} : { source: gap.source }),
        }
        const key = JSON.stringify(copied)
        if (seen.has(key)) continue
        seen.add(key)
        result.push(copied)
      }
    } catch {
      return undefined
    }
  }
  return result
}

const parseBuildRecord = (record: string): BuildDiagnostic | undefined => {
  try {
    const value: unknown = JSON.parse(record)
    if (
      typeof value !== 'object' ||
      value === null ||
      !('code' in value) ||
      typeof value.code !== 'string' ||
      !/^[A-Z]{3}[0-9]{4}$/.test(value.code) ||
      !('span' in value) ||
      !('module' in value) ||
      typeof value.module !== 'string' ||
      value.module.length === 0
    )
      return undefined
    const span = value.span
    if (!validSpan(span)) return undefined
    return { code: value.code, span: { start: span.start, end: span.end }, module: value.module }
  } catch {
    return undefined
  }
}

/**
 * Reads every anchored semantic rejection in order, once each. A build walk reports each refused
 * instance, so one rejection can repeat. Any malformed record leaves the build a process failure.
 */
export const parseBuildDiagnostics = (
  stderr: string,
): ReadonlyArray<BuildDiagnostic> | undefined => {
  const records = stderr.split('\n').filter((line) => line.startsWith(buildErrorPrefix))
  if (records.length === 0) return undefined
  const diagnostics: BuildDiagnostic[] = []
  const seen = new Set<string>()
  for (const record of records) {
    const diagnostic = parseBuildRecord(record.slice(buildErrorPrefix.length))
    if (diagnostic === undefined) return undefined
    const key = `${diagnostic.code}@${diagnostic.module}:${diagnostic.span.start}-${diagnostic.span.end}`
    if (seen.has(key)) continue
    seen.add(key)
    diagnostics.push(diagnostic)
  }
  return diagnostics
}

const safeName = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/

/** The C driver the self-hosted compiler links with when `SILKC_CLANG` names none. */
export const defaultCCompiler = '/usr/bin/clang'

/**
 * Compiles each corpus C unit to an object beside the package with the C driver the compiler links
 * with, as the bootstrap's `compileCObject` does, and returns the manifest's link input entries.
 */
const nativeLinkInputs = async (
  directory: string,
  program: CorpusProgram,
  cCompiler: string,
): Promise<ReadonlyArray<string>> => {
  const objects: string[] = []
  for (const [unit, contents] of Object.entries(program.nativeCSources ?? {})) {
    if (!safeName.test(unit)) throw new Error(`unsafe corpus C unit name: ${unit}`)
    writeFileSync(join(directory, `${unit}.c`), contents)
    const compiled = await runProcess(
      cCompiler,
      ['-c', '-x', 'c', `${unit}.c`, '-O2', '-fPIC', '-fvisibility=hidden', '-o', `${unit}.o`],
      buildTimeoutMs,
      directory,
    )
    if (compiled.error !== undefined || compiled.status !== 0 || compiled.signal !== null)
      throw new Error(`C unit ${unit}: ${processFailure(compiled)}`)
    objects.push(`{ object = ${JSON.stringify(`${unit}.o`)} }`)
  }
  const libraries = (program.nativeDynamicLibraries ?? []).map((library) => {
    if (!safeName.test(library)) throw new Error(`unsafe corpus library name: ${library}`)
    return `{ library = ${JSON.stringify(library)}, mode = "dynamic" }`
  })
  return [...objects, ...libraries]
}

interface CatalogRuntime {
  readonly targets: ReadonlyArray<string>
  readonly libc: string
  readonly name: string
  readonly module: string
}

// The native host the harness builds for, with the libc its catalog runtime is keyed by.
const hostTargets: Readonly<Record<string, { readonly target: string; readonly libc: string }>> = {
  'linux-x64': { target: 'x86_64-unknown-linux-gnu', libc: 'gnu' },
  'linux-arm64': { target: 'aarch64-unknown-linux-gnu', libc: 'gnu' },
  'darwin-arm64': { target: 'aarch64-apple-darwin', libc: 'system' },
}

const toml = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(toml).join(', ')}]`
  if (typeof value === 'object' && value !== null) {
    const fields = Object.entries(value).map(([key, field]) => `${key} = ${toml(field)}`)
    return `{ ${fields.join(', ')} }`
  }
  return JSON.stringify(value)
}

/**
 * The `[build].composition` the bootstrap acceptance harness compiles with: the standard library's
 * default runtime for the host, as `ArtifactComposition.defaults` selects it, with the program's
 * runtime components replacing the catalog's.
 */
const componentComposition = (program: CorpusProgram, stdlib: string): string | undefined => {
  if (program.nativeComponents === undefined) return undefined
  const host = hostTargets[`${process.platform}-${process.arch}`]
  if (host === undefined)
    throw new Error(`no native corpus target for ${process.platform}-${process.arch}`)
  const catalog = JSON.parse(readFileSync(join(stdlib, 'compositions.json'), 'utf8')) as {
    readonly runtimes: ReadonlyArray<CatalogRuntime>
  }
  const runtime = catalog.runtimes.find(
    (candidate) => candidate.targets.includes(host.target) && candidate.libc === host.libc,
  )
  if (runtime === undefined) throw new Error(`no catalog runtime for ${host.target}`)
  return toml({
    runtimes: [{ name: runtime.name, module: runtime.module }],
    defaults: [runtime.name],
    retention: [],
    requirements: [],
    components: program.nativeComponents,
  })
}

// The program is the module `memory/driver`, the root the bootstrap harness compiles, so reported
// identities and labels name the same module under both compilers. The manifest's root keeps the
// package directory as the module directory, where the program's imports resolve.
const programModule = 'memory/driver.silk'

const writeProgram = async (
  directory: string,
  program: CorpusProgram,
  cCompiler: string,
  stdlib: string,
): Promise<void> => {
  const source = join(directory, programModule)
  mkdirSync(dirname(source), { recursive: true })
  writeFileSync(source, program.nativeSource ?? program.source)
  const linkInputs = await nativeLinkInputs(directory, program, cCompiler)
  const composition = componentComposition(program, stdlib)
  const build = [
    ...(linkInputs.length === 0 ? [] : [`native-link-inputs = [${linkInputs.join(', ')}]`]),
    ...(composition === undefined ? [] : [`composition = ${composition}`]),
  ]
  writeFileSync(
    join(directory, 'silk.toml'),
    `[package]\nname = "corpus"\nroot = "main.silk"\n${
      build.length === 0 ? '' : `\n[build]\n${build.join('\n')}\n`
    }`,
  )
  for (const [module, contents] of Object.entries(program.nativeImports ?? {})) {
    if (module.startsWith('/') || module.split('/').includes('..'))
      throw new Error(`unsafe corpus import path: ${module}`)
    const path = join(directory, `${module}.silk`)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, contents)
  }
}

const runExecutable = (executable: string, invocation: NativeRun): Promise<ProcessResult> =>
  invocation.closeStderr
    ? runProcess(
        'sh',
        [
          '-c',
          'exec 2>&-; exec "$@"',
          'silk-selfhost-corpus',
          executable,
          ...(invocation.arguments ?? []),
        ],
        runTimeoutMs,
      )
    : runProcess(executable, invocation.arguments ?? [], runTimeoutMs)

const compareRun = (
  program: CorpusProgram,
  invocation: NativeRun,
  run: ProcessResult,
): string | undefined => {
  if (run.error !== undefined) return run.error.message
  if (program.nativeStdout !== undefined && run.stdout !== program.nativeStdout)
    return `stdout: expected ${JSON.stringify(program.nativeStdout)}, got ${JSON.stringify(run.stdout)}`
  if (
    !invocation.closeStderr &&
    program.nativeStderr !== undefined &&
    run.stderr !== program.nativeStderr
  )
    return `stderr: expected ${JSON.stringify(program.nativeStderr)}, got ${JSON.stringify(run.stderr)}`
  if (program.expected._tag === 'Trap') {
    if (run.signal !== null || (run.status !== null && run.status !== 0)) return undefined
    return 'expected a trap or nonzero exit, got exit 0'
  }
  const expected = program.expected.result & 0xff
  if (run.signal !== null || run.status !== expected)
    return `exit: expected ${expected}, got ${run.status ?? 'none'}${run.signal === null ? '' : ` (signal ${run.signal})`}`
  return undefined
}

export const runCase = async (
  silkc: string,
  program: CorpusProgram,
  stdlib = fileURLToPath(new URL('../../packages/compiler/stdlib', import.meta.url)),
  cCompiler = defaultCCompiler,
): Promise<CaseResult> => {
  const directory = mkdtempSync(join(tmpdir(), 'silk-selfhost-corpus-'))
  try {
    await writeProgram(directory, program, cCompiler, stdlib)
    const executable = join(directory, 'program')
    const profiles = program.nativeProfiles ?? [
      { name: 'optimized', optimization: 'speed', debug: false },
    ]
    // Every profile checks the same bodies, so the first build's gap stands for the program.
    let borrowGap: BorrowGap | undefined
    for (const profile of profiles) {
      const built = await runProcess(
        silkc,
        [
          'build',
          programModule,
          '-o',
          'program',
          '--stdlib',
          stdlib,
          '--optimization',
          profile.optimization,
          '--debug',
          String(profile.debug),
        ],
        buildTimeoutMs,
        directory,
      )
      if (built.error !== undefined || built.status !== 0 || built.signal !== null) {
        const stderr = built.stderr
        // A semantic rejection is a failure even when the build also reached gaps beside it.
        const rejected = stderr.split('\n').some((line) => line.startsWith(buildErrorPrefix))
        const gaps = built.error === undefined && !rejected ? parseUnsupported(stderr) : undefined
        if (gaps !== undefined) return { name: program.name, status: 'unsupported', gaps }
        const diagnostics =
          (built.error === undefined ? parseBuildDiagnostics(stderr) : undefined) ?? []
        return {
          name: program.name,
          status: 'fail',
          code: diagnostics[0]?.code ?? 'BUILD_PROCESS_FAILURE',
          diagnostics,
          reason: `profile ${profile.name}: build: ${processFailure(built)}`,
        }
      }
      if (profile === profiles[0]) for (const line of built.stderr.split('\n')) if (line.startsWith('; PROBE R3 ')) console.log(`R3_PROGRAM=${program.name} ${line}`)
      borrowGap ??= parseBorrowGap(built.stderr)

      for (const [ordinal, invocation] of (program.nativeRuns ?? [{}]).entries()) {
        const mismatch = compareRun(
          program,
          invocation,
          await runExecutable(executable, invocation),
        )
        if (mismatch !== undefined)
          return {
            name: program.name,
            status: 'fail',
            ...(borrowGap === undefined ? {} : { borrowGap }),
            code: 'RUNTIME_MISMATCH',
            diagnostics: [],
            reason: `profile ${profile.name}: run ${ordinal + 1}: ${mismatch}`,
          }
      }
    }
    return { name: program.name, status: 'pass', ...(borrowGap === undefined ? {} : { borrowGap }) }
  } catch (error) {
    return {
      name: program.name,
      status: 'fail',
      code: 'CORPUS_RUNNER_FAILURE',
      diagnostics: [],
      reason: error instanceof Error ? error.message : String(error),
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

export const summarize = (
  results: ReadonlyArray<CaseResult>,
  track: ReadonlyArray<string>,
): Summary => {
  const names = new Set(results.map((result) => result.name))
  if (names.size !== results.length) throw new Error('duplicate native corpus program names')
  if (new Set(track).size !== track.length)
    throw new Error('duplicate selfhost track program names')
  const missing = track.filter((name) => !names.has(name))
  if (missing.length > 0)
    throw new Error(`selfhost track names absent from corpus: ${missing.join(', ')}`)
  const trackSet = new Set(track)
  const gapCounts = new Map<string, number>()
  const failureCounts = new Map<string, number>()
  for (const result of results) {
    if (result.status === 'fail')
      failureCounts.set(result.code, (failureCounts.get(result.code) ?? 0) + 1)
    if (result.status !== 'unsupported') continue
    for (const gap of result.gaps) gapCounts.set(gap.code, (gapCounts.get(gap.code) ?? 0) + 1)
  }
  return {
    pass: results.filter((result) => result.status === 'pass').length,
    fail: results.filter((result) => result.status === 'fail').length,
    unsupported: results.filter((result) => result.status === 'unsupported').length,
    failureCounts: [...failureCounts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([code, count]) => ({ code, count })),
    gapCounts: [...gapCounts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([code, count]) => ({ code, count })),
    trackFailures: results
      .filter((result) => trackSet.has(result.name) && result.status !== 'pass')
      .map((result) => result.name),
  }
}

/**
 * Runs already-materialized scenarios against the requested compiler and its live standard library,
 * up to `concurrency` cases at once. Every case owns its directory and processes, so the log is the
 * sequential one: timings, results, and the summary all follow corpus order.
 */
export const runCorpus = async (
  silkc: string,
  corpus: ReadonlyArray<CorpusProgram>,
  required: ReadonlyArray<string>,
  selected?: ReadonlyArray<string>,
  stdlib?: string,
  cCompiler?: string,
  concurrency = availableParallelism(),
): Promise<number> => {
  const selectedSet = selected === undefined ? undefined : new Set(selected)
  const programs =
    selectedSet === undefined ? corpus : corpus.filter((program) => selectedSet.has(program.name))
  if (selectedSet !== undefined && programs.length !== selectedSet.size)
    throw new Error('SILK_SELFHOST_CORPUS_CASES names a program absent from nativeCorpus')
  const track = required.filter((name) => selectedSet === undefined || selectedSet.has(name))
  const executable = silkc.includes('/') ? resolve(silkc) : silkc
  const finished: Array<{ readonly result: CaseResult; readonly elapsedMs: number }> = []
  let reported = 0
  // The workers share one iterator, so each takes the next unstarted case. A timing prints once
  // every earlier case has finished.
  const queue = programs.entries()
  const worker = async (): Promise<void> => {
    for (const [index, program] of queue) {
      const started = performance.now()
      const result = await runCase(executable, program, stdlib, cCompiler)
      finished[index] = { result, elapsedMs: Math.round(performance.now() - started) }
      for (let ready = finished[reported]; ready !== undefined; ready = finished[++reported])
        process.stdout.write(
          `SELFHOST_CASE_TIMING=${JSON.stringify({ name: ready.result.name, elapsedMs: ready.elapsedMs })}\n`,
        )
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker))
  const results = finished.map(({ result }) => result)
  for (const result of results) {
    let detail = ''
    if (result.status === 'fail')
      detail = `: code=${[...new Set(result.diagnostics.map((diagnostic) => diagnostic.code))].join(',') || result.code} span=${result.diagnostics.map((diagnostic) => `${diagnostic.module}:${diagnostic.span.start}-${diagnostic.span.end}`).join(',') || 'unavailable'} ${result.reason}`
    if (result.status === 'unsupported')
      detail = `: ${result.gaps
        .map(
          (gap) =>
            `${gap.code}: ${gap.reason}${gap.source === undefined ? '' : ` [${gap.source.module}:${gap.source.span.start}-${gap.source.span.end}]`}`,
        )
        .join('; ')}`
    process.stdout.write(`${result.status.toUpperCase()} ${result.name}${detail}\n`)
    if (result.status !== 'unsupported' && result.borrowGap !== undefined)
      process.stdout.write(
        `SELFHOST_BORROW_GAP=${JSON.stringify({ name: result.name, ...result.borrowGap })}\n`,
      )
  }
  const summary = summarize(results, track)
  process.stdout.write(
    `Selfhost corpus: pass=${summary.pass} fail=${summary.fail} unsupported=${summary.unsupported} track=${track.length}\n`,
  )
  for (const failure of summary.failureCounts)
    process.stdout.write(`Selfhost failure ${failure.code}: ${failure.count}\n`)
  for (const gap of summary.gapCounts)
    process.stdout.write(`Selfhost gap ${gap.code}: ${gap.count}\n`)
  if (summary.trackFailures.length > 0) {
    process.stderr.write(`Selfhost track failed: ${summary.trackFailures.join(', ')}\n`)
    return 1
  }
  return 0
}
