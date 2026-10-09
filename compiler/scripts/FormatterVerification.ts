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
import * as CorpusVerification from './CorpusVerification.js'

/** Canonical runtime members checked against the consuming selfhost checkout. */
export const runtimeIntrinsicNames = Intrinsic.inventory()
  .filter((entry) => entry.phase !== 'StaticOnly')
  .map((entry) => entry.operation.slice('Intrinsic.'.length))
  .sort()

export interface FormatterVerification {
  readonly repository: string
  readonly node: string
  readonly bootstrap: string
  readonly gate: string
  readonly compiler: string
  readonly cCompiler: string
  readonly safetyLog: string
  readonly selected?: ReadonlyArray<string>
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

/** Verifies the formatted checkout while preserving authored corpus templates as test inputs. */
export const run = Effect.fn('FormatterVerification.run')(function* (
  self: FormatterVerification,
): Effect.fn.Return<
  void,
  VerificationError | CorpusVerification.VerificationError | PlatformError.PlatformError,
  Path.Path | FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
> {
  // Corpus construction uses literal whitespace replacements in authored fixtures.
  // Materialize it once before formatting; its runner still reads the live stdlib.
  const corpus = yield* CorpusVerification.materialize()
  const pins = yield* CorpusVerification.readPins(self, corpus)
  const fs = yield* FileSystem.FileSystem
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
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
  const formatted = yield* capture(
    ChildProcess.make(self.gate, sources, {
      cwd: self.repository,
      stderr: 'inherit',
    }),
  )
  yield* fs.writeFileString(self.safetyLog, formatted.output)
  yield* Console.log(formatted.output)
  if (formatted.code !== 0)
    return yield* new VerificationError({
      message: `Native formatting safety gate exited with ${formatted.code}`,
      operation: 'verify repository formatting',
      reason: { _tag: 'Exit', code: formatted.code },
    })
  const rebuilt = yield* spawner.exitCode(
    ChildProcess.make(
      self.node,
      [
        self.bootstrap,
        'build',
        '--manifest-path',
        'compiler/silk.toml',
        '--optimization',
        'release-with-debug',
      ],
      { cwd: self.repository, stdout: 'inherit', stderr: 'inherit' },
    ),
  )
  if (rebuilt !== 0)
    return yield* new VerificationError({
      message: `Formatted compiler rebuild exited with ${rebuilt}`,
      operation: 'rebuild formatted compiler',
      reason: { _tag: 'Exit', code: rebuilt },
    })
  yield* CorpusVerification.execute(self, corpus, pins, self.selected)
})

/** Resolves CI configuration from the repository directory, then runs verification. */
export const runConfigured = Effect.fn('FormatterVerification.runConfigured')(function* (
  node: string,
): Effect.fn.Return<
  void,
  | Config.ConfigError
  | VerificationError
  | CorpusVerification.VerificationError
  | PlatformError.PlatformError,
  Path.Path | FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
> {
  const path = yield* Path.Path
  const repository = path.resolve('.')
  const temporary = yield* Config.String('RUNNER_TEMP')
  const compiler = yield* Config.String('SILKC')
  const bootstrap = yield* Config.String('SILK_BOOTSTRAP')
  const selection = yield* Config.String('SILK_SELFHOST_CORPUS_CASES').pipe(Config.withDefault(''))
  const selected = selection
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0)
  return yield* run({
    repository,
    node,
    bootstrap,
    gate: path.join(
      repository,
      'compiler/build/llvm/x86_64-unknown-linux-gnu/release-with-debug/silk-format-gate',
    ),
    compiler,
    cCompiler: yield* CorpusVerification.cCompiler,
    safetyLog: path.join(temporary, 'formatter-safety.log'),
    ...(selected.length === 0 ? {} : { selected }),
  })
})
