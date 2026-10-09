import * as Config from 'effect/Config'
import * as Console from 'effect/Console'
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Path from 'effect/Path'
import type * as PlatformError from 'effect/PlatformError'
import * as Schema from 'effect/Schema'
import type { CorpusProgram } from '../../packages/compiler/test/support/corpus.js'
import { defaultCCompiler, runCorpus } from './runSelfhostCorpus.js'

export interface CorpusVerification {
  readonly repository: string
  readonly compiler: string
  /** The C driver that compiles corpus C units, the one the compiler links with. */
  readonly cCompiler: string
}

/** Reads the compiler's own C driver setting, so corpus objects match its link. */
export const cCompiler = Config.NonEmptyString('SILKC_CLANG').pipe(
  Config.withDefault(defaultCCompiler),
)

/** Ordered regular-corpus authority emitted before any full-corpus outcomes. */
export const Manifest = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  mode: Schema.Literal('corpus-full'),
  required: Schema.NonEmptyArray(Schema.NonEmptyString),
  programs: Schema.Array(
    Schema.Struct({
      name: Schema.NonEmptyString,
      profiles: Schema.Array(
        Schema.Struct({
          name: Schema.NonEmptyString,
          optimization: Schema.Literals(['none', 'speed']),
          debug: Schema.Boolean,
        }),
      ),
      runs: Schema.Array(
        Schema.Struct({ arguments: Schema.Array(Schema.String), closeStderr: Schema.Boolean }),
      ),
      expected: Schema.Union([
        Schema.TaggedStruct('Completes', { result: Schema.Finite }),
        Schema.TaggedStruct('Trap', {}),
      ]),
      stdout: Schema.optionalKey(Schema.String),
      stderr: Schema.optionalKey(Schema.String),
    }),
  ),
})

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
  readonly [string, ...Array<string>],
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
        self.cCompiler,
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

/** Run every regular scenario read-only; unpinned gaps/failures remain ordered observations. */
export const runFull = Effect.fn('CorpusVerification.runFull')(function* (
  self: CorpusVerification,
  corpus: ReadonlyArray<CorpusProgram>,
): Effect.fn.Return<
  void,
  VerificationError | PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path
> {
  const pins = yield* readPins(self, corpus)
  const manifest = yield* Schema.encodeEffect(Schema.fromJsonString(Manifest))({
    schemaVersion: 1,
    mode: 'corpus-full',
    required: pins,
    programs: corpus.map((program) => ({
      name: program.name,
      profiles: program.nativeProfiles ?? [
        { name: 'optimized', optimization: 'speed', debug: false },
      ],
      runs: (program.nativeRuns ?? [{}]).map((run) => ({
        arguments: run.arguments ?? [],
        closeStderr: run.closeStderr ?? false,
      })),
      expected: program.expected,
      ...(program.nativeStdout === undefined ? {} : { stdout: program.nativeStdout }),
      ...(program.nativeStderr === undefined ? {} : { stderr: program.nativeStderr }),
    })),
  }).pipe(
    Effect.mapError(
      (cause) =>
        new VerificationError({
          operation: 'encode corpus manifest',
          message: 'Could not encode the complete corpus manifest',
          reason: { _tag: 'WrappedFailure', cause },
        }),
    ),
  )
  yield* Console.log(`SELFHOST_CORPUS_MANIFEST=${manifest}`)
  yield* execute(self, corpus, pins)
})

/** Corpus checkpoints require an explicit compiler and reject all subset configuration. */
export const runConfigured = Effect.fn('CorpusVerification.runConfigured')(function* (
  mode: 'corpus' | 'corpus-full' = 'corpus',
): Effect.fn.Return<
  void,
  Config.ConfigError | VerificationError | PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path
> {
  const path = yield* Path.Path
  const compiler = yield* Config.NonEmptyString('SILKC')
  const selection = yield* Config.String('SILK_SELFHOST_CORPUS_CASES').pipe(Config.withDefault(''))
  if (selection !== '')
    return yield* new VerificationError({
      operation: 'configure corpus checkpoint',
      message: 'SILK_SELFHOST_CORPUS_CASES is not allowed for corpus verification',
      reason: { _tag: 'InvalidInput' },
    })
  const corpus = yield* materialize()
  const self = { repository: path.resolve('.'), compiler, cCompiler: yield* cCompiler }
  if (mode === 'corpus-full') return yield* runFull(self, corpus)
  return yield* run(self, corpus)
})
