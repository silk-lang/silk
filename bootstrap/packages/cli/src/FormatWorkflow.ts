import * as FormattedDocument from '@silklang/compiler/FormattedDocument'
import * as Lexer from '@silklang/compiler/Lexer'
import * as Parser from '@silklang/compiler/Parser'
import * as Project from '@silklang/compiler/Project'
import * as SourceFile from '@silklang/compiler/SourceFile'
import * as Formatter from '@silklang/formatter/Formatter'
import * as FormatterError from '@silklang/formatter/FormatterError'
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Path from 'effect/Path'
import type * as PlatformError from 'effect/PlatformError'
import * as Result from 'effect/Result'

export interface Options extends Project.LoadOptions {
  readonly paths?: ReadonlyArray<string>
  readonly check?: boolean
}

export type Outcome =
  | { readonly _tag: 'Unchanged'; readonly path: string }
  | { readonly _tag: 'Changed'; readonly path: string; readonly written: boolean }
  | {
      readonly _tag: 'Damaged'
      readonly path: string
      readonly error: FormatterError.FormatterError
    }
  | {
      readonly _tag: 'Failed'
      readonly path: string
      readonly message: string
      readonly cause: unknown
    }

export interface Summary {
  readonly _tag: 'FormatSummary'
  readonly check: boolean
  readonly sourceRoot: string
  readonly outcomes: ReadonlyArray<Outcome>
}

export type FormatWorkflowErrorReason =
  | { readonly _tag: 'ProjectFailure'; readonly error: Project.ProjectError }
  | { readonly _tag: 'OutsideSourceRoot'; readonly sourceRoot: string }
  | { readonly _tag: 'InvalidSelection'; readonly detail: string }
  | { readonly _tag: 'WrappedFailure'; readonly cause: unknown }

/** Project discovery or deterministic source selection failed before per-file formatting. */
export class FormatWorkflowError extends Data.TaggedError('FormatWorkflowError')<{
  readonly operation: 'FormatWorkflow.run' | 'FormatWorkflow.select'
  readonly path: string
  readonly message: string
  readonly reason: FormatWorkflowErrorReason
}> {}

const isWithin = (root: string, candidate: string, path: Path.Path): boolean => {
  const relative = path.relative(root, candidate)
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

const wrappedSelectionFailure = (
  selectedPath: string,
  message: string,
  cause: unknown,
): FormatWorkflowError =>
  new FormatWorkflowError({
    operation: 'FormatWorkflow.select',
    path: selectedPath,
    message,
    reason: { _tag: 'WrappedFailure', cause },
  })

const invalidSelection = (selectedPath: string, detail: string): FormatWorkflowError =>
  new FormatWorkflowError({
    operation: 'FormatWorkflow.select',
    path: selectedPath,
    message: `Invalid format selection ${selectedPath}: ${detail}`,
    reason: { _tag: 'InvalidSelection', detail },
  })

const outsideSourceRoot = (selectedPath: string, sourceRoot: string): FormatWorkflowError =>
  new FormatWorkflowError({
    operation: 'FormatWorkflow.select',
    path: selectedPath,
    message: `Format selection ${selectedPath} is outside source root ${sourceRoot}`,
    reason: { _tag: 'OutsideSourceRoot', sourceRoot },
  })

const walk = Effect.fnUntraced(function* (
  directory: string,
  sourceRoot: string,
): Effect.fn.Return<ReadonlyArray<string>, FormatWorkflowError, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const names = yield* fileSystem
    .readDirectory(directory)
    .pipe(
      Effect.mapError((cause) =>
        wrappedSelectionFailure(directory, `Cannot read source directory ${directory}`, cause),
      ),
    )
  const selected: Array<string> = []
  for (const name of names.sort()) {
    const candidate = path.resolve(directory, name)
    const canonical = yield* fileSystem
      .realPath(candidate)
      .pipe(
        Effect.mapError((cause) =>
          wrappedSelectionFailure(candidate, `Cannot resolve source path ${candidate}`, cause),
        ),
      )
    if (canonical !== candidate) continue
    if (!isWithin(sourceRoot, canonical, path)) continue
    const info = yield* fileSystem
      .stat(canonical)
      .pipe(
        Effect.mapError((cause) =>
          wrappedSelectionFailure(canonical, `Cannot inspect source path ${canonical}`, cause),
        ),
      )
    if (info.type === 'Directory') selected.push(...(yield* walk(canonical, sourceRoot)))
    else if (info.type === 'File' && path.extname(canonical) === '.silk') selected.push(canonical)
  }
  return selected
})

/** Resolves explicit or default project source selection into sorted canonical file paths. */
export const select = Effect.fn('FormatWorkflow.select')(function* (
  project: Project.Project,
  paths: ReadonlyArray<string> = [],
  workingDirectory = '.',
): Effect.fn.Return<ReadonlyArray<string>, FormatWorkflowError, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const sourceRoot = yield* fileSystem
    .realPath(project.entry.sourceRoot)
    .pipe(
      Effect.mapError((cause) =>
        wrappedSelectionFailure(
          project.entry.sourceRoot,
          `Cannot resolve source root ${project.entry.sourceRoot}`,
          cause,
        ),
      ),
    )
  if (paths.length === 0) return Array.from(new Set(yield* walk(sourceRoot, sourceRoot))).sort()

  const selected: Array<string> = []
  for (const requested of paths) {
    const absolute = path.resolve(workingDirectory, requested)
    if (!isWithin(path.resolve(project.entry.sourceRoot), absolute, path)) {
      return yield* outsideSourceRoot(absolute, sourceRoot)
    }
    const canonical = yield* fileSystem
      .realPath(absolute)
      .pipe(
        Effect.mapError((cause) =>
          wrappedSelectionFailure(absolute, `Cannot resolve format selection ${absolute}`, cause),
        ),
      )
    if (!isWithin(sourceRoot, canonical, path))
      return yield* outsideSourceRoot(canonical, sourceRoot)
    const info = yield* fileSystem
      .stat(canonical)
      .pipe(
        Effect.mapError((cause) =>
          wrappedSelectionFailure(canonical, `Cannot inspect format selection ${canonical}`, cause),
        ),
      )
    if (info.type === 'Directory') selected.push(...(yield* walk(canonical, sourceRoot)))
    else if (info.type === 'File' && path.extname(canonical) === '.silk') selected.push(canonical)
    else return yield* invalidSelection(canonical, 'expected a directory or an exact .silk file')
  }
  return Array.from(new Set(selected)).sort()
})

const replace = Effect.fnUntraced(function* (
  file: string,
  formatted: Uint8Array,
): Effect.fn.Return<void, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const info = yield* fileSystem.stat(file)
  yield* Effect.acquireUseRelease(
    fileSystem.makeTempFile({
      directory: path.dirname(file),
      prefix: '.silk-format-',
      suffix: '.tmp',
    }),
    (temporary) =>
      Effect.gen(function* () {
        yield* fileSystem.writeFile(temporary, formatted)
        yield* fileSystem.chmod(temporary, info.mode)
        yield* fileSystem.rename(temporary, file)
      }),
    (temporary) =>
      fileSystem
        .remove(path.dirname(temporary), { force: true, recursive: true })
        .pipe(Effect.ignore),
  )
})

const process = Effect.fnUntraced(function* (
  file: string,
  check: boolean,
): Effect.fn.Return<Outcome, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem
  const loaded = yield* Effect.result(fileSystem.readFile(file))
  if (Result.isFailure(loaded)) {
    return {
      _tag: 'Failed' as const,
      path: file,
      message: `Cannot read source file ${file}`,
      cause: loaded.failure,
    }
  }

  const source = SourceFile.make(file, Uint8Array.from(loaded.success))
  const syntax = Parser.parse(Lexer.lex(source))
  const attempted = yield* Effect.result(Formatter.format(syntax))
  if (Result.isFailure(attempted)) {
    return FormatterError.isSourceDamage(attempted.failure)
      ? { _tag: 'Damaged' as const, path: file, error: attempted.failure }
      : {
          _tag: 'Failed' as const,
          path: file,
          message: attempted.failure.message,
          cause: attempted.failure,
        }
  }
  if (!attempted.success.changed) return { _tag: 'Unchanged' as const, path: file }
  if (check) return { _tag: 'Changed' as const, path: file, written: false }

  const committed = yield* Effect.result(
    replace(file, FormattedDocument.toUint8Array(attempted.success)),
  )
  return Result.isFailure(committed)
    ? {
        _tag: 'Failed' as const,
        path: file,
        message: `Cannot commit formatted source file ${file}`,
        cause: committed.failure,
      }
    : { _tag: 'Changed' as const, path: file, written: true }
})

/** Formats or checks every selected source while retaining deterministic per-file outcomes. */
export const run = Effect.fn('FormatWorkflow.run')(function* (
  options: Options = {},
): Effect.fn.Return<Summary, FormatWorkflowError, FileSystem.FileSystem | Path.Path> {
  const project = yield* Project.load(options).pipe(
    Effect.mapError(
      (error) =>
        new FormatWorkflowError({
          operation: 'FormatWorkflow.run',
          path: error.manifestPath,
          message: error.message,
          reason: { _tag: 'ProjectFailure', error },
        }),
    ),
  )
  const files = yield* select(project, options.paths, options.workingDirectory)
  const check = options.check ?? false
  const outcomes = yield* Effect.forEach(files, (file) => process(file, check), {
    concurrency: 1,
  })
  return {
    _tag: 'FormatSummary' as const,
    check,
    sourceRoot: project.entry.sourceRoot,
    outcomes: outcomes,
  }
})

/** Maps a complete formatting summary onto the stable CLI exit classes. */
export const exitStatus = (summary: Summary): 0 | 1 | 2 => {
  if (summary.outcomes.some((outcome) => outcome._tag === 'Failed')) return 2
  if (
    summary.outcomes.some(
      (outcome) => outcome._tag === 'Damaged' || (summary.check && outcome._tag === 'Changed'),
    )
  ) {
    return 1
  }
  return 0
}
