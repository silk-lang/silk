import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  nativeCorpus,
  type CorpusProgram,
  type NativeRun,
} from '../../packages/compiler/test/support/corpus.js'
import { selfhostTrack } from './selfhostTrack.js'

export interface Gap {
  readonly code: string
  readonly reason: string
}

export type CaseResult =
  | { readonly name: string; readonly status: 'pass' }
  | { readonly name: string; readonly status: 'fail'; readonly reason: string }
  | { readonly name: string; readonly status: 'unsupported'; readonly gaps: ReadonlyArray<Gap> }

export interface Summary {
  readonly pass: number
  readonly fail: number
  readonly unsupported: number
  readonly gapCounts: ReadonlyArray<{ readonly code: string; readonly count: number }>
  readonly trackFailures: ReadonlyArray<string>
}

const unsupportedPrefix = 'SILK_UNSUPPORTED_JSON='
const processTimeoutMs = 30_000

const text = (value: string | null): string => value ?? ''

const processFailure = (process: SpawnSyncReturns<string>): string => {
  const error = process.error?.message
  const detail = text(process.stderr).trim()
  return [error, detail, `exit=${process.status ?? 'none'} signal=${process.signal ?? 'none'}`]
    .filter((part) => part !== undefined && part !== '')
    .join('; ')
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
    if (
      !gaps.every(
        (gap: unknown) =>
          typeof gap === 'object' &&
          gap !== null &&
          'code' in gap &&
          typeof gap.code === 'string' &&
          gap.code.length > 0 &&
          'reason' in gap &&
          typeof gap.reason === 'string' &&
          gap.reason.length > 0,
      )
    )
      return undefined
    return gaps.map((gap: Gap) => ({ code: gap.code, reason: gap.reason }))
  } catch {
    return undefined
  }
}

const unsupportedFixture = (program: CorpusProgram): ReadonlyArray<Gap> => {
  const gaps: Gap[] = []
  if (program.nativeComponents !== undefined)
    gaps.push({
      code: 'CORPUS_COMPONENT_INPUT',
      reason: 'the build CLI cannot supply native runtime components yet',
    })
  if (program.nativeCSources !== undefined || program.nativeDynamicLibraries !== undefined)
    gaps.push({
      code: 'CORPUS_NATIVE_LINK_INPUT',
      reason: 'the build CLI cannot link corpus C objects or dynamic libraries yet',
    })
  if (program.nativeProfiles?.some((profile) => profile.optimization !== 'speed' || profile.debug))
    gaps.push({
      code: 'CORPUS_BUILD_PROFILE',
      reason: 'the build CLI cannot select the corpus debug or unoptimized profile yet',
    })
  return gaps
}

const writeProgram = (directory: string, program: CorpusProgram): string => {
  const source = join(directory, 'main.silk')
  writeFileSync(source, program.nativeSource ?? program.source)
  for (const [module, contents] of Object.entries(program.nativeImports ?? {})) {
    if (module.startsWith('/') || module.split('/').includes('..'))
      throw new Error(`unsafe corpus import path: ${module}`)
    const path = join(directory, `${module}.silk`)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, contents)
  }
  return source
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
        { encoding: 'utf8', timeout: processTimeoutMs, maxBuffer: 4 * 1024 * 1024 },
      )
    : spawnSync(executable, invocation.arguments ?? [], {
        encoding: 'utf8',
        timeout: processTimeoutMs,
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

export const runCase = (silkc: string, program: CorpusProgram): CaseResult => {
  const fixtureGaps = unsupportedFixture(program)
  if (fixtureGaps.length > 0)
    return { name: program.name, status: 'unsupported', gaps: fixtureGaps }

  const directory = mkdtempSync(join(tmpdir(), 'silk-selfhost-corpus-'))
  try {
    const source = writeProgram(directory, program)
    const executable = join(directory, 'program')
    const built = spawnSync(silkc, ['build', source, '-o', executable], {
      cwd: directory,
      encoding: 'utf8',
      timeout: processTimeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    })
    if (built.error !== undefined || built.status !== 0 || built.signal !== null) {
      const gaps = built.error === undefined ? parseUnsupported(text(built.stderr)) : undefined
      return gaps === undefined
        ? { name: program.name, status: 'fail', reason: `build: ${processFailure(built)}` }
        : { name: program.name, status: 'unsupported', gaps }
    }

    for (const [ordinal, invocation] of (program.nativeRuns ?? [{}]).entries()) {
      const mismatch = compareRun(program, invocation, runExecutable(executable, invocation))
      if (mismatch !== undefined)
        return { name: program.name, status: 'fail', reason: `run ${ordinal + 1}: ${mismatch}` }
    }
    return { name: program.name, status: 'pass' }
  } catch (error) {
    return {
      name: program.name,
      status: 'fail',
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
  for (const result of results) {
    if (result.status !== 'unsupported') continue
    for (const gap of result.gaps) gapCounts.set(gap.code, (gapCounts.get(gap.code) ?? 0) + 1)
  }
  return {
    pass: results.filter((result) => result.status === 'pass').length,
    fail: results.filter((result) => result.status === 'fail').length,
    unsupported: results.filter((result) => result.status === 'unsupported').length,
    gapCounts: [...gapCounts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([code, count]) => ({ code, count })),
    trackFailures: results
      .filter((result) => trackSet.has(result.name) && result.status !== 'pass')
      .map((result) => result.name),
  }
}

const main = (): void => {
  const silkc = process.env.SILKC
  if (silkc === undefined || silkc.length === 0)
    throw new Error('SILKC must name the self-hosted compiler executable')
  const selected = process.env.SILK_SELFHOST_CORPUS_CASES?.split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0)
  const selectedSet = selected === undefined ? undefined : new Set(selected)
  const programs =
    selectedSet === undefined
      ? nativeCorpus
      : nativeCorpus.filter((program) => selectedSet.has(program.name))
  if (selectedSet !== undefined && programs.length !== selectedSet.size)
    throw new Error('SILK_SELFHOST_CORPUS_CASES names a program absent from nativeCorpus')
  const track = selfhostTrack.filter((name) => selectedSet === undefined || selectedSet.has(name))
  const executable = silkc.includes('/') ? resolve(silkc) : silkc
  const results = programs.map((program) => runCase(executable, program))
  for (const result of results) {
    let detail = ''
    if (result.status === 'fail') detail = `: ${result.reason}`
    if (result.status === 'unsupported')
      detail = `: ${result.gaps.map((gap) => `${gap.code}: ${gap.reason}`).join('; ')}`
    process.stdout.write(`${result.status.toUpperCase()} ${result.name}${detail}\n`)
  }
  const summary = summarize(results, track)
  process.stdout.write(
    `Selfhost corpus: pass=${summary.pass} fail=${summary.fail} unsupported=${summary.unsupported} track=${track.length}\n`,
  )
  for (const gap of summary.gapCounts)
    process.stdout.write(`Selfhost gap ${gap.code}: ${gap.count}\n`)
  if (summary.trackFailures.length > 0) {
    process.stderr.write(`Selfhost track failed: ${summary.trackFailures.join(', ')}\n`)
    process.exitCode = 1
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  main()
