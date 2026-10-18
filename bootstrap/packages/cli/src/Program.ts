import * as Data from 'effect/Data'
import type * as Crypto from 'effect/Crypto'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Path from 'effect/Path'
import type * as PlatformError from 'effect/PlatformError'
import * as Result from 'effect/Result'
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process'
import * as TestExchange from './TestExchange.js'

/** Starting or waiting for a compiled program failed before it could report an exit status. */
export class ProgramError extends Data.TaggedError('ProgramError')<{
  readonly operation: 'Program.run' | 'Program.runTest'
  readonly executable: string
  readonly message: string
  readonly reason: { readonly _tag: 'WrappedFailure'; readonly cause: PlatformError.PlatformError }
}> {}

export type InvalidReceiptReason =
  | { readonly _tag: 'FileFailure'; readonly cause: PlatformError.PlatformError }
  | { readonly _tag: 'Oversize'; readonly maximumBytes: number; readonly actualBytes: bigint }
  | { readonly _tag: 'ExchangeFailure'; readonly error: TestExchange.ExchangeError }

export type TestRun =
  | { readonly _tag: 'Completed'; readonly status: number; readonly receipt: TestExchange.Receipt }
  | { readonly _tag: 'Abnormal'; readonly status: number }
  | {
      readonly _tag: 'InvalidReceipt'
      readonly status: 2
      readonly processStatus: number
      readonly reason: InvalidReceiptReason
    }

/** Runs a compiled program with literal arguments and inherited standard streams. */
export const run = Effect.fn('Program.run')(function* (
  executable: string,
  arguments_: ReadonlyArray<string> = [],
): Effect.fn.Return<number, ProgramError, ChildProcessSpawner.ChildProcessSpawner> {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const command = ChildProcess.make(executable, arguments_, {
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  })
  return yield* spawner.exitCode(command).pipe(
    Effect.map(Number),
    Effect.mapError(
      (cause) =>
        new ProgramError({
          operation: 'Program.run',
          executable,
          message: `Cannot run compiled program ${executable}`,
          reason: { _tag: 'WrappedFailure', cause },
        }),
    ),
  )
})

const processError = (executable: string, cause: PlatformError.PlatformError): ProgramError =>
  new ProgramError({
    operation: 'Program.runTest',
    executable,
    message: `Cannot run compiled test program ${executable}`,
    reason: { _tag: 'WrappedFailure', cause },
  })

/** Runs one test executable through a private bounded plan/receipt exchange. */
export const runTest = Effect.fn('Program.runTest')(function* (
  executable: string,
  plan: TestExchange.Plan,
  arguments_: ReadonlyArray<string> = [],
): Effect.fn.Return<
  TestRun,
  ProgramError | TestExchange.ExchangeError,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path | Crypto.Crypto
> {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const encodedPlan = yield* TestExchange.encodePlan(plan)
  const maximumReceiptBytes = TestExchange.receiptMaximumBytes(plan)
  return yield* Effect.acquireUseRelease(
    fileSystem
      .makeTempDirectory({ prefix: 'silk-test-exchange-' })
      .pipe(Effect.mapError((cause) => processError(executable, cause))),
    Effect.fnUntraced(function* (directory): Effect.fn.Return<
      TestRun,
      ProgramError,
      Crypto.Crypto
    > {
      const canonicalDirectory = yield* fileSystem
        .realPath(directory)
        .pipe(Effect.mapError((cause) => processError(executable, cause)))
      const planPath = path.join(canonicalDirectory, 'plan.bin')
      const resultPath = path.join(canonicalDirectory, 'receipt.bin')
      yield* fileSystem
        .writeFile(planPath, encodedPlan)
        .pipe(Effect.mapError((cause) => processError(executable, cause)))
      const command = ChildProcess.make(
        executable,
        [...arguments_, '--silk-test-plan', planPath, '--silk-test-result', resultPath],
        { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' },
      )
      const processStatus = yield* spawner.exitCode(command).pipe(
        Effect.map(Number),
        Effect.mapError((cause) => processError(executable, cause)),
      )
      if (processStatus < 0 || processStatus > 2) return { _tag: 'Abnormal', status: processStatus }
      const metadata = yield* Effect.result(fileSystem.stat(resultPath))
      if (Result.isFailure(metadata))
        return {
          _tag: 'InvalidReceipt',
          status: 2,
          processStatus,
          reason: { _tag: 'FileFailure', cause: metadata.failure },
        }
      if (metadata.success.size > BigInt(maximumReceiptBytes))
        return {
          _tag: 'InvalidReceipt',
          status: 2,
          processStatus,
          reason: {
            _tag: 'Oversize',
            maximumBytes: maximumReceiptBytes,
            actualBytes: metadata.success.size,
          },
        }
      const read = yield* Effect.result(fileSystem.readFile(resultPath))
      if (Result.isFailure(read))
        return {
          _tag: 'InvalidReceipt',
          status: 2,
          processStatus,
          reason: { _tag: 'FileFailure', cause: read.failure },
        }
      const admitted = yield* Effect.result(
        TestExchange.admitReceipt(plan, encodedPlan, read.success, processStatus),
      )
      return Result.isSuccess(admitted)
        ? { _tag: 'Completed', status: processStatus, receipt: admitted.success }
        : {
            _tag: 'InvalidReceipt',
            status: 2,
            processStatus,
            reason: { _tag: 'ExchangeFailure', error: admitted.failure },
          }
    }),
    (directory) =>
      fileSystem.remove(directory, { recursive: true, force: true }).pipe(Effect.ignore),
  )
})
