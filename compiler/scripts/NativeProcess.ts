import { spawn, type SpawnOptions } from 'node:child_process'
import { constants } from 'node:os'
import { performance } from 'node:perf_hooks'
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'

export class NativeProcessError extends Data.TaggedError('NativeProcessError')<{
  readonly operation: string
  readonly message: string
  readonly cause: unknown
}> {}
const failure = (operation: string, cause: unknown): NativeProcessError =>
  new NativeProcessError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  })
export interface ProcessOutcome {
  readonly stdout: Buffer
  readonly stderr: Buffer
  readonly status: number | null
  readonly signal: string | null
}
export interface ProcessOptions {
  readonly cwd?: string
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly stdio?: SpawnOptions['stdio']
  readonly input?: Uint8Array
}
/** The process owns its children; scope closure also stops interrupted native builds. */
export const execute = Effect.fn('NativeProcess.execute')(function* (
  file: string,
  args: ReadonlyArray<string>,
  options: ProcessOptions = {},
): Effect.fn.Return<ProcessOutcome, NativeProcessError> {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const child = yield* Effect.acquireRelease(
        Effect.try({
          try: () =>
            spawn(file, args, {
              cwd: options.cwd,
              env: options.env,
              stdio: options.stdio ?? 'pipe',
              detached: process.platform === 'linux',
            }),
          catch: (cause) => failure('spawn', cause),
        }),
        (child) =>
          Effect.try({
            try: () => {
              if (child.pid === undefined) return
              // A Linux process group covers clang/llc children even after their parent exited.
              if (process.platform === 'linux') process.kill(-child.pid, 'SIGKILL')
              else if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
            },
            catch: (cause) => failure('release', cause),
          }).pipe(Effect.ignore),
      )
      return yield* Effect.callback<ProcessOutcome, NativeProcessError>((resume) => {
        const stdout: Buffer[] = []
        const stderr: Buffer[] = []
        child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk))
        child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk))
        child.once('error', (cause) => resume(Effect.fail(failure('execute', cause))))
        child.once('close', (status, signal) =>
          resume(
            Effect.succeed({
              stdout: Buffer.concat(stdout),
              stderr: Buffer.concat(stderr),
              status,
              signal,
            }),
          ),
        )
        child.stdin?.once('error', (cause) => resume(Effect.fail(failure('stdin', cause))))
        child.stdin?.end(options.input)
      })
    }),
  )
})
export interface Invocation {
  readonly command: ReadonlyArray<string>
  readonly cwd: string
  readonly resourceFile: string
  readonly timeCommand: string
}
export interface Measurement {
  readonly command: ReadonlyArray<string>
  readonly measurementCommand: ReadonlyArray<string>
  readonly cwd: string
  readonly exitCode: number | null
  readonly signal: string | null
  readonly stdout: string
  readonly stderr: string
  readonly error: string | null
  readonly wallTimeMs: number
  readonly peakRss: {
    readonly value: number | null
    readonly unit: 'KiB'
    readonly metric: string
    readonly scope: string
  }
}
/** GNU time reports kernel maximum RSS, including waited children, not a sum. */
export const run = Effect.fn('NativeProcess.run')(function* ({
  command,
  cwd,
  resourceFile,
  timeCommand,
}: Invocation): Effect.fn.Return<Measurement, never, FileSystem.FileSystem> {
  const fs = yield* FileSystem.FileSystem
  const measurementCommand = [timeCommand, '-f', '%M', '-o', resourceFile, '--', ...command]
  const started = yield* Effect.sync(() => performance.now())
  const result = yield* execute(timeCommand, measurementCommand.slice(1), { cwd }).pipe(
    Effect.map((outcome) => ({ ...outcome, error: null })),
    Effect.catch((error) =>
      Effect.succeed({
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        status: null,
        signal: null,
        error: error.message,
      }),
    ),
  )
  const wallTimeMs = (yield* Effect.sync(() => performance.now())) - started
  const record = yield* fs.readFileString(resourceFile).pipe(
    Effect.map((text) => ({ text, error: null })),
    Effect.catch((error) => Effect.succeed({ text: '', error: error.message })),
  )
  const lines = record.text.trim().split('\n')
  const rss = lines.at(-1)
  const validRss = rss !== undefined && /^\d+$/.test(rss) && Number.isSafeInteger(Number(rss))
  let signal: string | null = result.signal
  const killed = lines.find((line) => /^Command terminated by signal \d+$/.test(line))
  if (killed !== undefined) {
    const number = Number(killed.split(' ').at(-1))
    signal =
      Object.entries(constants.signals).find(([, value]) => value === number)?.[0] ??
      `signal-${number}`
  }
  return {
    command,
    measurementCommand,
    cwd,
    exitCode: result.status,
    signal,
    stdout: result.stdout.toString('utf8'),
    stderr: result.stderr.toString('utf8'),
    error:
      result.error ?? record.error ?? (validRss ? null : 'invalid GNU time maximum RSS record'),
    wallTimeMs,
    peakRss: {
      value: validRss ? Number(rss) : null,
      unit: 'KiB',
      metric: 'GNU time %M / Linux ru_maxrss',
      scope: 'maximum RSS of the command and waited children; not summed concurrent RSS',
    },
  }
})
export const succeeded = (result: Measurement): boolean =>
  result.error === null && result.exitCode === 0 && result.signal === null
