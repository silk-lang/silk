import * as Project from '@silklang/compiler/Project'
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Path from 'effect/Path'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export interface InitializeOptions {
  readonly path?: string
  readonly name?: string
  readonly workingDirectory?: string
}

export interface InitializedProject {
  readonly _tag: 'InitializedProject'
  readonly directory: string
  readonly name: string
  readonly manifestPath: string
  readonly entryPath: string
}

export type ProjectInitializerErrorReason =
  | { readonly _tag: 'InvalidPackageName'; readonly name: string; readonly derived: boolean }
  | { readonly _tag: 'Collision'; readonly path: string }
  | { readonly _tag: 'InvalidDirectory'; readonly path: string }
  | { readonly _tag: 'WrappedFailure'; readonly path: string; readonly cause: unknown }

/** Project initialization failed without retaining a partial managed project. */
export class ProjectInitializerError extends Data.TaggedError('ProjectInitializerError')<{
  readonly operation: 'ProjectInitializer.initialize'
  readonly message: string
  readonly reason: ProjectInitializerErrorReason
}> {}

interface Plan {
  readonly directory: string
  readonly name: string
  readonly manifestPath: string
  readonly sourceDirectory: string
  readonly entryPath: string
  readonly ignorePath: string
  readonly directoryExists: boolean
  readonly directoriesToCreate: ReadonlyArray<string>
  readonly sourceDirectoryExists: boolean
  readonly ignore: Uint8Array | undefined
}

interface Journal {
  readonly created: Array<string>
  readonly ignorePath: string
  readonly previousIgnore: Uint8Array | undefined
  ignoreChanged: boolean
  committed: boolean
}

const wrapped = (path: string, cause: unknown): ProjectInitializerError =>
  new ProjectInitializerError({
    operation: 'ProjectInitializer.initialize',
    message: `Cannot initialize Silk project at ${path}`,
    reason: { _tag: 'WrappedFailure', path, cause },
  })

const exists = Effect.fnUntraced(function* (path: string) {
  const fileSystem = yield* FileSystem.FileSystem
  return yield* fileSystem.exists(path).pipe(Effect.mapError((cause) => wrapped(path, cause)))
})

const preflight = Effect.fnUntraced(function* (
  options: InitializeOptions,
): Effect.fn.Return<Plan, ProjectInitializerError, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const directory = path.resolve(options.workingDirectory ?? '.', options.path ?? '.')
  const derived = options.name === undefined
  const name = options.name ?? path.basename(directory)
  if (!Project.isPackageName(name)) {
    return yield* new ProjectInitializerError({
      operation: 'ProjectInitializer.initialize',
      message: derived
        ? `Cannot derive a portable package name from ${path.basename(directory)}; pass --name`
        : `Package name ${name} must start with a lowercase letter and contain only lowercase letters, digits, or hyphens`,
      reason: { _tag: 'InvalidPackageName', name, derived },
    })
  }

  const directoriesToCreate: Array<string> = []
  let existingAncestor = directory
  while (!(yield* exists(existingAncestor))) {
    directoriesToCreate.unshift(existingAncestor)
    const parent = path.dirname(existingAncestor)
    if (parent === existingAncestor) break
    existingAncestor = parent
  }
  const ancestorInfo = yield* fileSystem
    .stat(existingAncestor)
    .pipe(Effect.mapError((cause) => wrapped(existingAncestor, cause)))
  if (ancestorInfo.type !== 'Directory') {
    return yield* new ProjectInitializerError({
      operation: 'ProjectInitializer.initialize',
      message: `Initialization path ancestor ${existingAncestor} is not a directory`,
      reason: { _tag: 'InvalidDirectory', path: existingAncestor },
    })
  }
  const directoryExists = directoriesToCreate.length === 0

  const manifestPath = path.join(directory, Project.manifestName)
  const sourceDirectory = path.join(directory, 'src')
  const entryPath = path.join(sourceDirectory, 'main.silk')
  const ignorePath = path.join(directory, '.gitignore')
  for (const protectedPath of [manifestPath, entryPath]) {
    if (yield* exists(protectedPath)) {
      return yield* new ProjectInitializerError({
        operation: 'ProjectInitializer.initialize',
        message: `Refusing to overwrite existing project file ${protectedPath}`,
        reason: { _tag: 'Collision', path: protectedPath },
      })
    }
  }

  const sourceDirectoryExists = yield* exists(sourceDirectory)
  if (sourceDirectoryExists) {
    const info = yield* fileSystem
      .stat(sourceDirectory)
      .pipe(Effect.mapError((cause) => wrapped(sourceDirectory, cause)))
    if (info.type !== 'Directory') {
      return yield* new ProjectInitializerError({
        operation: 'ProjectInitializer.initialize',
        message: `Managed source path ${sourceDirectory} is not a directory`,
        reason: { _tag: 'Collision', path: sourceDirectory },
      })
    }
  }
  const ignore = (yield* exists(ignorePath))
    ? yield* fileSystem
        .readFile(ignorePath)
        .pipe(Effect.mapError((cause) => wrapped(ignorePath, cause)))
    : undefined
  return {
    directory,
    name,
    manifestPath,
    sourceDirectory,
    entryPath,
    ignorePath,
    directoryExists,
    directoriesToCreate: directoriesToCreate,
    sourceDirectoryExists,
    ignore,
  }
})

const hasIgnoreRule = (bytes: Uint8Array): boolean =>
  decoder.decode(bytes).split(/\r?\n/).includes('/build/')

const ignoreBytes = (previous: Uint8Array | undefined): Uint8Array => {
  if (previous === undefined || previous.length === 0) return encoder.encode('/build/\n')
  if (hasIgnoreRule(previous)) return previous
  const suffix = previous.at(-1) === 10 ? '/build/\n' : '\n/build/\n'
  const appended = new Uint8Array(previous.length + encoder.encode(suffix).length)
  appended.set(previous)
  appended.set(encoder.encode(suffix), previous.length)
  return appended
}

const manifest = (name: string): string =>
  `[package]\nname = "${name}"\nversion = "0.1.0"\nroot = "src/main.silk"\n`

const entry = `import silk.effect { Effect }
import silk.logger { LogError }
import silk.os_logger { StdoutLogger }

pub effect fn main() -> () ! LogError {
  let mut logger = StdoutLogger.make()

  run Effect.log("Hello, world!", &())
    |> Effect.provideMut(&mut logger)
}
`

const rollback = Effect.fnUntraced(function* (journal: Journal) {
  if (journal.committed) return
  const fileSystem = yield* FileSystem.FileSystem
  if (journal.ignoreChanged && journal.previousIgnore !== undefined) {
    yield* fileSystem.writeFile(journal.ignorePath, journal.previousIgnore).pipe(Effect.ignore)
  }
  for (const created of [...journal.created].reverse()) {
    yield* fileSystem.remove(created, { recursive: true, force: true }).pipe(Effect.ignore)
  }
})

/** Safely initializes one executable Silk project and rolls back every partial mutation. */
export const initialize = Effect.fn('ProjectInitializer.initialize')(function* (
  options: InitializeOptions = {},
): Effect.fn.Return<
  InitializedProject,
  ProjectInitializerError,
  FileSystem.FileSystem | Path.Path
> {
  const fileSystem = yield* FileSystem.FileSystem
  const plan = yield* preflight(options)
  const journal: Journal = {
    created: [],
    ignorePath: plan.ignorePath,
    previousIgnore: plan.ignore,
    ignoreChanged: false,
    committed: false,
  }

  return yield* Effect.acquireUseRelease(
    Effect.succeed(journal),
    Effect.fnUntraced(function* (state) {
      if (!plan.directoryExists) {
        state.created.push(...plan.directoriesToCreate)
        yield* fileSystem
          .makeDirectory(plan.directory, { recursive: true })
          .pipe(Effect.mapError((cause) => wrapped(plan.directory, cause)))
      }
      if (!plan.sourceDirectoryExists) {
        state.created.push(plan.sourceDirectory)
        yield* fileSystem
          .makeDirectory(plan.sourceDirectory, { recursive: true })
          .pipe(Effect.mapError((cause) => wrapped(plan.sourceDirectory, cause)))
      }

      const nextIgnore = ignoreBytes(plan.ignore)
      if (plan.ignore === undefined) state.created.push(plan.ignorePath)
      if (plan.ignore === undefined || nextIgnore !== plan.ignore) {
        state.ignoreChanged = plan.ignore !== undefined
        yield* fileSystem
          .writeFile(plan.ignorePath, nextIgnore)
          .pipe(Effect.mapError((cause) => wrapped(plan.ignorePath, cause)))
      }

      state.created.push(plan.manifestPath)
      yield* fileSystem
        .writeFileString(plan.manifestPath, manifest(plan.name))
        .pipe(Effect.mapError((cause) => wrapped(plan.manifestPath, cause)))
      state.created.push(plan.entryPath)
      yield* fileSystem
        .writeFileString(plan.entryPath, entry)
        .pipe(Effect.mapError((cause) => wrapped(plan.entryPath, cause)))
      state.committed = true
      return {
        _tag: 'InitializedProject' as const,
        directory: plan.directory,
        name: plan.name,
        manifestPath: plan.manifestPath,
        entryPath: plan.entryPath,
      }
    }),
    rollback,
  )
})
