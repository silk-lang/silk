import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
  /** The logical module the span indexes, such as `main.silk` or a standard-library module. */
  readonly module: string
}

export type CaseResult =
  | { readonly name: string; readonly status: 'pass' }
  | {
      readonly name: string
      readonly status: 'fail'
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
const buildErrorPrefix = 'SILK_BUILD_ERROR='
// A native build of certificate-bounded-decoding takes 28.5-30 s on the hosted Linux runner, so a
// 30 s build deadline timed it out at random; builds get 4x that, while program runs stay short.
const buildTimeoutMs = 120_000
const runTimeoutMs = 30_000

const text = (value: string | null): string => value ?? ''

const processFailure = (process: SpawnSyncReturns<string>): string => {
  const error = process.error?.message
  const detail = text(process.stderr).trim()
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

/** Only B1's machine-readable gap record can classify a failed build as unsupported. */
export const parseUnsupported = (stderr: string): ReadonlyArray<Gap> | undefined => {
  const records = stderr.split('\n').filter((line) => line.startsWith(unsupportedPrefix))
  const record = records[0]
  if (records.length !== 1 || record === undefined) return undefined
  try {
    const value: unknown = JSON.parse(record.slice(unsupportedPrefix.length))
    if (typeof value !== 'object' || value === null || !('gaps' in value)) return undefined
    const gaps = value.gaps
    if (!Array.isArray(gaps) || gaps.length === 0) return undefined
    if (!gaps.every(validGap)) return undefined
    return gaps.map((gap) => ({
      code: gap.code,
      reason: gap.reason,
      ...(gap.source === undefined ? {} : { source: gap.source }),
    }))
  } catch {
    return undefined
  }
}

const parseBuildRecord = (record: string): BuildDiagnostic | undefined => {
  try {
    const value: unknown = JSON.parse(record)
    if (
      typeof value !== 'object' ||
      value === null ||
      !('code' in value) ||
      typeof value.code !== 'string' ||
      value.code.length === 0 ||
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

const unsupportedFixture = (program: CorpusProgram): ReadonlyArray<Gap> => {
  const gaps: Gap[] = []
  if (program.nativeComponents !== undefined)
    gaps.push({
      code: 'CORPUS_COMPONENT_INPUT',
      reason: 'the build CLI cannot supply native runtime components yet',
    })
  if (
    program.nativeCSources !== undefined ||
    program.nativeDynamicLibraries?.some((library) => library !== 'c' && library !== 'm')
  )
    gaps.push({
      code: 'CORPUS_NATIVE_LINK_INPUT',
      reason: 'the build CLI cannot link corpus C objects or libraries beyond libc/libm yet',
    })
  return gaps
}

const writeProgram = (directory: string, program: CorpusProgram): void => {
  const source = join(directory, 'main.silk')
  writeFileSync(source, program.nativeSource ?? program.source)
  writeFileSync(join(directory, 'silk.toml'), '[package]\nname = "corpus"\nroot = "main.silk"\n')
  for (const [module, contents] of Object.entries(program.nativeImports ?? {})) {
    if (module.startsWith('/') || module.split('/').includes('..'))
      throw new Error(`unsafe corpus import path: ${module}`)
    const path = join(directory, `${module}.silk`)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, contents)
  }
}

const runExecutable = (executable: string, invocation: NativeRun): SpawnSyncReturns<string> =>
  invocation.closeStderr
    ? spawnSync(
        'sh',
        [
          '-c',
          'exec 2>&-; exec "$@"',
          'silk-selfhost-corpus',
          executable,
          ...(invocation.arguments ?? []),
        ],
        { encoding: 'utf8', timeout: runTimeoutMs, maxBuffer: 4 * 1024 * 1024 },
      )
    : spawnSync(executable, invocation.arguments ?? [], {
        encoding: 'utf8',
        timeout: runTimeoutMs,
        maxBuffer: 4 * 1024 * 1024,
      })

const compareRun = (
  program: CorpusProgram,
  invocation: NativeRun,
  run: SpawnSyncReturns<string>,
): string | undefined => {
  if (run.error !== undefined) return run.error.message
  if (program.nativeStdout !== undefined && text(run.stdout) !== program.nativeStdout)
    return `stdout: expected ${JSON.stringify(program.nativeStdout)}, got ${JSON.stringify(text(run.stdout))}`
  if (
    !invocation.closeStderr &&
    program.nativeStderr !== undefined &&
    text(run.stderr) !== program.nativeStderr
  )
    return `stderr: expected ${JSON.stringify(program.nativeStderr)}, got ${JSON.stringify(text(run.stderr))}`
  if (program.expected._tag === 'Trap') {
    if (run.signal !== null || (run.status !== null && run.status !== 0)) return undefined
    return 'expected a trap or nonzero exit, got exit 0'
  }
  const expected = program.expected.result & 0xff
  if (run.signal !== null || run.status !== expected)
    return `exit: expected ${expected}, got ${run.status ?? 'none'}${run.signal === null ? '' : ` (signal ${run.signal})`}`
  return undefined
}

export const runCase = (
  silkc: string,
  program: CorpusProgram,
  stdlib = fileURLToPath(new URL('../../packages/compiler/stdlib', import.meta.url)),
): CaseResult => {
  const fixtureGaps = unsupportedFixture(program)
  if (fixtureGaps.length > 0)
    return { name: program.name, status: 'unsupported', gaps: fixtureGaps }

  const directory = mkdtempSync(join(tmpdir(), 'silk-selfhost-corpus-'))
  try {
    writeProgram(directory, program)
    const executable = join(directory, 'program')
    const profiles = program.nativeProfiles ?? [
      { name: 'optimized', optimization: 'speed', debug: false },
    ]
    for (const profile of profiles) {
      const built = spawnSync(
        silkc,
        [
          'build',
          'main.silk',
          '-o',
          'program',
          '--stdlib',
          stdlib,
          '--optimization',
          profile.optimization,
          '--debug',
          String(profile.debug),
        ],
        {
          cwd: directory,
          encoding: 'utf8',
          timeout: buildTimeoutMs,
          maxBuffer: 4 * 1024 * 1024,
        },
      )
      if (built.error !== undefined || built.status !== 0 || built.signal !== null) {
        const stderr = text(built.stderr)
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

      for (const [ordinal, invocation] of (program.nativeRuns ?? [{}]).entries()) {
        const mismatch = compareRun(program, invocation, runExecutable(executable, invocation))
        if (mismatch !== undefined)
          return {
            name: program.name,
            status: 'fail',
            code: 'RUNTIME_MISMATCH',
            diagnostics: [],
            reason: `profile ${profile.name}: run ${ordinal + 1}: ${mismatch}`,
          }
      }
    }
    return { name: program.name, status: 'pass' }
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

/** Runs already-materialized scenarios against the requested compiler and its live standard library. */
export const runCorpus = (
  silkc: string,
  corpus: ReadonlyArray<CorpusProgram>,
  required: ReadonlyArray<string>,
  selected?: ReadonlyArray<string>,
  stdlib?: string,
): number => {
  const selectedSet = selected === undefined ? undefined : new Set(selected)
  const programs =
    selectedSet === undefined ? corpus : corpus.filter((program) => selectedSet.has(program.name))
  if (selectedSet !== undefined && programs.length !== selectedSet.size)
    throw new Error('SILK_SELFHOST_CORPUS_CASES names a program absent from nativeCorpus')
  const track = required.filter((name) => selectedSet === undefined || selectedSet.has(name))
  const executable = silkc.includes('/') ? resolve(silkc) : silkc
  const results = programs.map((program) => {
    const started = performance.now()
    const result = runCase(executable, program, stdlib)
    process.stdout.write(
      `SELFHOST_CASE_TIMING=${JSON.stringify({ name: program.name, elapsedMs: Math.round(performance.now() - started) })}\n`,
    )
    return result
  })
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
