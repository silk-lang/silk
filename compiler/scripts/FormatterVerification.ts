import * as Console from 'effect/Console'
import * as Config from 'effect/Config'
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Path from 'effect/Path'
import type * as PlatformError from 'effect/PlatformError'
import * as Stream from 'effect/Stream'
import * as ChildProcess from 'effect/unstable/process/ChildProcess'
import * as ChildProcessSpawner from 'effect/unstable/process/ChildProcessSpawner'
import * as Intrinsic from '../../packages/compiler/src/Intrinsic.js'

/** Canonical runtime members checked against the consuming selfhost checkout. */
export const runtimeIntrinsicNames = Intrinsic.inventory()
  .filter((entry) => entry.phase !== 'StaticOnly')
  .map((entry) => entry.operation.slice('Intrinsic.'.length))
  .sort()

export interface FormatterVerification {
  readonly repository: string
  /** A native formatter safety gate built by the caller from the consuming checkout. */
  readonly gate: string
  readonly safetyLog: string
}

export class VerificationError extends Data.TaggedError('FormatterVerificationError')<{
  readonly message: string
  readonly operation: string
  readonly reason:
    | { readonly _tag: 'InvalidInput' }
    | { readonly _tag: 'Exit'; readonly code: number }
    | { readonly _tag: 'WrappedFailure'; readonly cause: unknown }
}> {}

const capture = Effect.fnUntraced(function* (command: ChildProcess.Command) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const handle = yield* spawner.spawn(command)
  const output = yield* Stream.mkString(Stream.decodeText(handle.stdout))
  const code = yield* handle.exitCode
  return { output, code }
}, Effect.scoped)

/**
 * Verifies the intrinsic catalog and repository formatting without changing the checkout. The
 * corpus has its own modes; this one neither builds a compiler nor runs programs.
 */
export const run = Effect.fn('FormatterVerification.run')(function* (
  self: FormatterVerification,
): Effect.fn.Return<
  void,
  VerificationError | PlatformError.PlatformError,
  FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
> {
  const fs = yield* FileSystem.FileSystem
  const catalog = yield* fs.readFileString(
    `${self.repository}/compiler/src/semantic/IntrinsicCatalog.silk`,
  )
  const members = catalog
    .split('let members = b"')
    .at(1)
    ?.split('"')
    .at(0)
    ?.split('|')
    .filter((name) => name.length > 0)
  if (
    members === undefined ||
    members.length !== runtimeIntrinsicNames.length ||
    members.some((name, index) => name !== runtimeIntrinsicNames[index])
  )
    return yield* new VerificationError({
      operation: 'verify intrinsic catalog',
      message: 'Selfhost runtime members differ from the canonical intrinsic catalog',
      reason: { _tag: 'InvalidInput' },
    })
  const tracked = yield* capture(
    ChildProcess.make('git', ['ls-files', '-z', '--', '*.silk'], {
      cwd: self.repository,
      stderr: 'inherit',
    }),
  )
  if (tracked.code !== 0)
    return yield* new VerificationError({
      message: `Repository source selection exited with ${tracked.code}`,
      operation: 'list repository sources',
      reason: { _tag: 'Exit', code: tracked.code },
    })
  const sources = tracked.output
    .split('\0')
    .filter((source) => source.length > 0)
    .sort()
  const verified = yield* capture(
    ChildProcess.make(self.gate, sources, {
      cwd: self.repository,
      stderr: 'inherit',
    }),
  )
  yield* fs.writeFileString(self.safetyLog, verified.output)
  yield* Console.log(verified.output)
  if (verified.code !== 0)
    return yield* new VerificationError({
      message: `Native formatting safety gate exited with ${verified.code}`,
      operation: 'verify repository formatting',
      reason: { _tag: 'Exit', code: verified.code },
    })
  const changed = yield* capture(
    ChildProcess.make('git', ['diff', '--name-only', '--', ...sources], {
      cwd: self.repository,
      stderr: 'inherit',
    }),
  )
  if (changed.code !== 0 || changed.output.length > 0)
    return yield* new VerificationError({
      message: `Native formatting safety gate changed tracked sources:\n${changed.output}`,
      operation: 'verify repository formatting',
      reason: { _tag: 'InvalidInput' },
    })
})

/** Resolves CI configuration from the repository directory, then runs verification. */
export const runConfigured = Effect.fn('FormatterVerification.runConfigured')(
  function* (): Effect.fn.Return<
    void,
    Config.ConfigError | VerificationError | PlatformError.PlatformError,
    Path.Path | FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
  > {
    const path = yield* Path.Path
    const temporary = yield* Config.String('RUNNER_TEMP')
    return yield* run({
      repository: path.resolve('.'),
      gate: path.resolve(yield* Config.NonEmptyString('SILK_FORMAT_GATE')),
      safetyLog: path.join(temporary, 'formatter-safety.log'),
    })
  },
)
