import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import type * as PlatformError from 'effect/PlatformError'
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process'

/**
 * The young-generation size, in megabytes per semi-space, that the CLI runs under. Compiling the
 * self-hosted compiler spends about a third of its frontend time in scavenges with V8's default;
 * this size makes that build about a fifth faster for about 1 GB more peak memory.
 */
export const semiSpaceMegabytes = 128

const semiSpaceFlag = '--max-semi-space-size'

/** V8 sizes the young generation at heap creation, so the flag must be on the Node command line. */
export interface Launch {
  readonly executable: string
  readonly executableArguments: ReadonlyArray<string>
  readonly script: string
  readonly arguments: ReadonlyArray<string>
  readonly nodeOptions: string
}

/** Re-executing the CLI under the sized young generation failed before the child reported a status. */
export class LauncherError extends Data.TaggedError('LauncherError')<{
  readonly operation: 'Launcher.relaunch'
  readonly message: string
  readonly reason: { readonly _tag: 'WrappedFailure'; readonly cause: PlatformError.PlatformError }
}> {}

/** Whether a semi-space size is already chosen, on the command line or in `NODE_OPTIONS`. */
export const configured = (self: Launch): boolean =>
  [...self.executableArguments, ...self.nodeOptions.split(/\s+/)].some(
    (argument) => argument === semiSpaceFlag || argument.startsWith(`${semiSpaceFlag}=`),
  )

/** The Node command line that runs the same CLI invocation under the sized young generation. */
export const relaunchArguments = (self: Launch): ReadonlyArray<string> => [
  `${semiSpaceFlag}=${semiSpaceMegabytes}`,
  ...self.executableArguments,
  self.script,
  ...self.arguments,
]

/** Runs the same CLI invocation once more under the sized young generation and returns its status. */
export const relaunch = Effect.fn('Launcher.relaunch')(function* (
  self: Launch,
): Effect.fn.Return<number, LauncherError, ChildProcessSpawner.ChildProcessSpawner> {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const command = ChildProcess.make(self.executable, relaunchArguments(self), {
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  })
  return yield* spawner.exitCode(command).pipe(
    Effect.map(Number),
    Effect.mapError(
      (cause) =>
        new LauncherError({
          operation: 'Launcher.relaunch',
          message: `Cannot relaunch ${self.script} with ${semiSpaceFlag}`,
          reason: { _tag: 'WrappedFailure', cause },
        }),
    ),
  )
})
