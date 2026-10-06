import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { constants } from 'node:os'
import { performance } from 'node:perf_hooks'
import { basename, dirname } from 'node:path'
import * as Data from 'effect/Data'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'

export class NativeProcessError extends Data.TaggedError('NativeProcessError')<{
  readonly operation: string
  readonly message: string
  readonly reason: 'RejectedInput' | 'ExternalFailure'
  readonly cause?: unknown
  readonly partialOutcome?: ProcessOutcome
}> {}
const failure = (operation: string, cause: unknown): NativeProcessError =>
  new NativeProcessError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
    reason: 'ExternalFailure',
    cause,
  })
export interface Deadline {
  readonly timeoutMs: number
  readonly expired: boolean
}
export interface ProcessOutcome {
  readonly stdout: Buffer
  readonly stderr: Buffer
  readonly status: number | null
  readonly signal: string | null
  readonly deadline: Deadline | null
}
export interface ProcessOptions {
  readonly cwd?: string
  readonly env?: Readonly<Record<string, string | undefined>> | undefined
  readonly stdio?: SpawnOptions['stdio']
  readonly input?: Uint8Array
  readonly timeoutMs?: number | undefined
}
/** A per-child deadline, not a whole-build timer. Omission leaves runtime unbounded. */
export const validateTimeout = Effect.fn('NativeProcess.validateTimeout')(function* (
  timeoutMs: number | undefined,
): Effect.fn.Return<void, NativeProcessError> {
  if (
    timeoutMs !== undefined &&
    (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647)
  )
    return yield* new NativeProcessError({
      operation: 'timeout',
      message: 'timeoutMs must be an integer between 1 and 2147483647',
      reason: 'RejectedInput',
    })
})
interface ChildResource {
  readonly child: ChildProcess
  readonly completion: Promise<ProcessOutcome>
  readonly failureSignal: Deferred.Deferred<NativeProcessError>
  readonly state: {
    closed: boolean
    expired: boolean
    error: NativeProcessError | null
  }
}
// This boundary registers Node's pipe/close events once; inward consumers await one outcome.
const acquire = Effect.fnUntraced(function* (
  file: string,
  args: ReadonlyArray<string>,
  options: ProcessOptions,
) {
  const failureSignal = yield* Deferred.make<NativeProcessError>()
  return yield* Effect.try({
    try: (): ChildResource => {
      const child = spawn(file, args, {
        cwd: options.cwd,
        env: options.env,
        stdio: options.stdio ?? 'pipe',
        detached: process.platform === 'linux',
      })
      const state: ChildResource['state'] = { closed: false, expired: false, error: null }
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      const output = (chunk: Buffer) => stdout.push(chunk)
      const diagnostic = (chunk: Buffer) => stderr.push(chunk)
      const failed = (cause: unknown) => {
        state.error ??= failure('execute', cause)
        Deferred.doneUnsafe(failureSignal, Effect.succeed(state.error))
      }
      const inputFailed = (cause: unknown) => {
        state.error ??= failure('stdin', cause)
        Deferred.doneUnsafe(failureSignal, Effect.succeed(state.error))
      }
      const completion = new Promise<ProcessOutcome>((resolve) => {
        child.stdout?.on('data', output)
        child.stderr?.on('data', diagnostic)
        child.once('error', failed)
        child.stdin?.once('error', inputFailed)
        child.once('close', (status, signal) => {
          state.closed = true
          child.stdout?.removeListener('data', output)
          child.stderr?.removeListener('data', diagnostic)
          child.removeListener('error', failed)
          child.stdin?.removeListener('error', inputFailed)
          resolve({
            stdout: Buffer.concat(stdout),
            stderr: Buffer.concat(stderr),
            status,
            signal,
            deadline:
              options.timeoutMs === undefined
                ? null
                : {
                    timeoutMs: options.timeoutMs,
                    expired: state.expired,
                  },
          })
        })
      })
      return { child, state, completion, failureSignal }
    },
    catch: (cause) => failure('spawn', cause),
  })
})
const kill = Effect.fnUntraced(function* (resource: ChildResource) {
  return yield* Effect.try({
    try: () => {
      const { child } = resource
      if (child.pid === undefined) return
      // Kill the owned Linux group, including compiler grandchildren that still hold pipes.
      if (process.platform === 'linux') process.kill(-child.pid, 'SIGKILL')
      else if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    },
    catch: (cause) => failure('kill', cause),
  }).pipe(
    Effect.catch((error) => {
      // ESRCH means that the owned group has already gone, not a failed deadline action.
      if (error.cause instanceof Error && 'code' in error.cause && error.cause.code === 'ESRCH')
        return Effect.void
      return Effect.sync(() => {
        resource.state.error ??= error
      })
    }),
  )
})
const awaitClose = Effect.fnUntraced(function* (resource: ChildResource) {
  return yield* Effect.tryPromise({
    try: () => resource.completion,
    catch: (cause) => failure('close', cause),
  })
})
const awaitCompletion = Effect.fnUntraced(function* (resource: ChildResource) {
  return yield* Effect.raceFirst(
    awaitClose(resource),
    Effect.gen(function* () {
      yield* Deferred.await(resource.failureSignal)
      yield* kill(resource)
      return yield* awaitClose(resource)
    }),
  )
})
/** Deadline owns kill→close; interruption releases the group but returns no complete evidence. */
export const execute = Effect.fn('NativeProcess.execute')(function* (
  file: string,
  args: ReadonlyArray<string>,
  options: ProcessOptions = {},
): Effect.fn.Return<ProcessOutcome, NativeProcessError> {
  yield* validateTimeout(options.timeoutMs)
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const resource = yield* Effect.acquireRelease(
        acquire(file, args, options),
        Effect.fnUntraced(function* (resource) {
          yield* kill(resource)
          yield* awaitClose(resource).pipe(Effect.ignore)
        }),
      )
      yield* Effect.try({
        try: () => resource.child.stdin?.end(options.input),
        catch: (cause) => failure('stdin', cause),
      }).pipe(
        Effect.catch(
          Effect.fnUntraced(function* (error) {
            resource.state.error ??= error
            yield* kill(resource)
          }),
        ),
      )
      const timeoutMs = options.timeoutMs
      const outcome =
        timeoutMs === undefined
          ? yield* awaitCompletion(resource)
          : yield* Effect.raceFirst(
              awaitCompletion(resource),
              Effect.gen(function* () {
                yield* Effect.sleep(timeoutMs)
                if (!resource.state.closed) {
                  resource.state.expired = true
                  yield* kill(resource)
                }
                return yield* awaitClose(resource)
              }),
            )
      const error = resource.state.error
      if (error !== null)
        return yield* new NativeProcessError({
          operation: error.operation,
          message: error.message,
          reason: error.reason,
          cause: error.cause,
          ...(resource.child.pid === undefined ? {} : { partialOutcome: outcome }),
        })
      return outcome
    }),
  )
})
export interface Invocation {
  readonly command: ReadonlyArray<string>
  readonly cwd: string
  readonly resourceFile: string
  readonly timeCommand: string
  readonly env?: ProcessOptions['env']
  readonly timeoutMs?: number | undefined
}
export interface Measurement {
  readonly command: ReadonlyArray<string>
  readonly measurementCommand: ReadonlyArray<string>
  readonly cwd: string
  readonly linkerEnvironment: { readonly SILKC_CLANG: string } | null
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
export interface RunEvidence {
  readonly measurement: Measurement
  readonly deadline: Deadline | null
  readonly raw: { readonly stdout: Uint8Array; readonly stderr: Uint8Array }
  readonly resources: {
    readonly path: string
    readonly bytes: Uint8Array | null
    readonly error: string | null
  }
}
/** GNU time reports maximum RSS including waited children, not a sum; kill may leave no record. */
export const run = Effect.fn('NativeProcess.run')(function* ({
  command,
  cwd,
  resourceFile,
  timeCommand,
  env,
  timeoutMs,
}: Invocation): Effect.fn.Return<RunEvidence, never, FileSystem.FileSystem> {
  const fs = yield* FileSystem.FileSystem
  const measurementCommand = [timeCommand, '-f', '%M', '-o', resourceFile, '--', ...command]
  const started = yield* Effect.sync(() => performance.now())
  let launched = false
  const result = yield* Effect.gen(function* () {
    yield* validateTimeout(timeoutMs)
    // Directory entries include dangling symlinks, unlike exists/stat of their targets.
    const entries = yield* fs
      .readDirectory(dirname(resourceFile))
      .pipe(Effect.mapError((cause) => failure('resource preflight', cause)))
    if (entries.includes(basename(resourceFile)))
      return yield* new NativeProcessError({
        operation: 'resource preflight',
        reason: 'RejectedInput',
        message: 'GNU time resource file must be fresh',
      })
    launched = true
    const outcome = yield* execute(timeCommand, measurementCommand.slice(1), {
      cwd,
      env,
      timeoutMs,
    })
    return { ...outcome, error: null }
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed({
        ...(error.partialOutcome ?? {
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
          status: null,
          signal: null,
          deadline: null,
        }),
        error: error.message,
      }),
    ),
  )
  const wallTimeMs = (yield* Effect.sync(() => performance.now())) - started
  const record = launched
    ? yield* fs.readFile(resourceFile).pipe(
        Effect.map((bytes) => ({ bytes, error: null })),
        Effect.catch((error) => Effect.succeed({ bytes: null, error: error.message })),
      )
    : { bytes: null, error: 'resource record unavailable: command was not launched' }
  const lines = (record.bytes === null ? '' : Buffer.from(record.bytes).toString('utf8'))
    .trim()
    .split('\n')
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
    measurement: {
      command,
      measurementCommand,
      cwd,
      linkerEnvironment: env?.SILKC_CLANG === undefined ? null : { SILKC_CLANG: env.SILKC_CLANG },
      exitCode: result.status,
      signal,
      stdout: result.stdout.toString('utf8'),
      stderr: result.stderr.toString('utf8'),
      error: result.deadline?.expired
        ? `process deadline exceeded (${result.deadline.timeoutMs} ms)${result.error === null ? '' : `; ${result.error}`}`
        : (result.error ??
          record.error ??
          (validRss ? null : 'invalid GNU time maximum RSS record')),
      wallTimeMs,
      peakRss: {
        value: validRss ? Number(rss) : null,
        unit: 'KiB',
        metric: 'GNU time %M / Linux ru_maxrss',
        scope: 'maximum RSS of the command and waited children; not summed concurrent RSS',
      },
    },
    deadline: result.deadline,
    raw: { stdout: result.stdout, stderr: result.stderr },
    resources: {
      path: resourceFile,
      bytes: record.bytes,
      error: record.error ?? (validRss ? null : 'invalid GNU time maximum RSS record'),
    },
  }
})
export const succeeded = (result: Measurement): boolean =>
  result.error === null && result.exitCode === 0 && result.signal === null
