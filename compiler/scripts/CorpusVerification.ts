import * as Config from 'effect/Config'
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Path from 'effect/Path'
import type * as PlatformError from 'effect/PlatformError'
import * as Schema from 'effect/Schema'
import type { CorpusProgram } from '../../packages/compiler/test/support/corpus.js'
import { runCorpus } from './runSelfhostCorpus.js'

export interface CorpusVerification {
  readonly repository: string
  readonly compiler: string
}

export class VerificationError extends Data.TaggedError('CorpusVerificationError')<{
  readonly operation: string
  readonly message: string
  readonly reason:
    | { readonly _tag: 'InvalidInput' }
    | { readonly _tag: 'Exit'; readonly code: number }
    | { readonly _tag: 'WrappedFailure'; readonly cause: unknown }
}> {}

/** Materialize authored fixtures before a caller performs any source formatting. */
export const materialize = Effect.fn('CorpusVerification.materialize')(
  function* (): Effect.fn.Return<ReadonlyArray<CorpusProgram>, VerificationError> {
    const { nativeCorpus } = yield* Effect.tryPromise({
      try: () => import('../../packages/compiler/test/support/corpus.js'),
      catch: (cause) =>
        new VerificationError({
          operation: 'materialize corpus',
          message: 'Could not materialize native corpus scenarios',
          reason: { _tag: 'WrappedFailure', cause },
        }),
    })
    return nativeCorpus
  },
)

/** Resolve the consuming checkout's promises and reject omissions before any compiler runs. */
export const readPins = Effect.fn('CorpusVerification.readPins')(function* (
  self: CorpusVerification,
  corpus: ReadonlyArray<CorpusProgram>,
): Effect.fn.Return<
  ReadonlyArray<string>,
  VerificationError | PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path
> {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const source = yield* fs.readFileString(
    path.join(self.repository, 'compiler/scripts/selfhost-track.json'),
  )
  const pins = yield* Schema.decodeEffect(
    Schema.fromJsonString(Schema.NonEmptyArray(Schema.NonEmptyString)),
  )(source).pipe(
    Effect.mapError(
      (cause) =>
        new VerificationError({
          operation: 'read selfhost track',
          message: 'Invalid selfhost corpus track',
          reason: { _tag: 'WrappedFailure', cause },
        }),
    ),
  )
  const names = new Set(corpus.map((program) => program.name))
  if (new Set(pins).size !== pins.length || names.size !== corpus.length)
    return yield* new VerificationError({
      operation: 'read selfhost track',
      message: 'Duplicate selfhost corpus names',
      reason: { _tag: 'InvalidInput' },
    })
  const missing = pins.filter((name) => !names.has(name))
  if (missing.length > 0)
    return yield* new VerificationError({
      operation: 'read selfhost track',
      message: `Selfhost track names absent from corpus: ${missing.join(', ')}`,
      reason: { _tag: 'InvalidInput' },
    })
  return pins
})

/** Execute materialized scenarios; formatter callers retain the regular runner's selection policy. */
export const execute = Effect.fn('CorpusVerification.execute')(function* (
  self: CorpusVerification,
  corpus: ReadonlyArray<CorpusProgram>,
  required: ReadonlyArray<string>,
  selected?: ReadonlyArray<string>,
): Effect.fn.Return<
  void,
  VerificationError | PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path
> {
  const path = yield* Path.Path
  const result = yield* Effect.try({
    try: () =>
      runCorpus(
        self.compiler,
        corpus,
        required,
        selected,
        path.join(self.repository, 'packages/compiler/stdlib'),
      ),
    catch: (cause) =>
      new VerificationError({
        operation: 'run native corpus',
        message: 'Native corpus execution failed',
        reason: { _tag: 'WrappedFailure', cause },
      }),
  })
  if (result !== 0)
    return yield* new VerificationError({
      operation: 'verify native corpus',
      message: `Native corpus verification exited with ${result}`,
      reason: { _tag: 'Exit', code: result },
    })
})

/** Verify every live pin with the supplied compiler, without formatting or rebuilding it. */
export const run = Effect.fn('CorpusVerification.run')(function* (
  self: CorpusVerification,
  corpus: ReadonlyArray<CorpusProgram>,
): Effect.fn.Return<
  void,
  VerificationError | PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path
> {
  const pins = yield* readPins(self, corpus)
  yield* execute(self, corpus, pins, pins)
})

/** Corpus checkpoints require an explicit compiler and reject all subset configuration. */
export const runConfigured = Effect.fn('CorpusVerification.runConfigured')(
  function* (): Effect.fn.Return<
    void,
    Config.ConfigError | VerificationError | PlatformError.PlatformError,
    FileSystem.FileSystem | Path.Path
  > {
    const path = yield* Path.Path
    const compiler = yield* Config.NonEmptyString('SILKC')
    const selection = yield* Config.String('SILK_SELFHOST_CORPUS_CASES').pipe(
      Config.withDefault(''),
    )
    if (selection !== '')
      return yield* new VerificationError({
        operation: 'configure corpus checkpoint',
        message: 'SILK_SELFHOST_CORPUS_CASES is not allowed for full-pin corpus verification',
        reason: { _tag: 'InvalidInput' },
      })
    const corpus = yield* materialize()
    return yield* run({ repository: path.resolve('.'), compiler }, corpus)
  },
)
