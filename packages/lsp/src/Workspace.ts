import type * as ModuleClosure from '@silklang/compiler/ModuleClosure'
import * as ConfigurationError from '@silklang/compiler/ConfigurationError'
import * as ConfigurationOrigin from '@silklang/compiler/ConfigurationOrigin'
import * as ProjectProfile from '@silklang/compiler/ProjectProfile'
import * as NativeToolchain from '@silklang/compiler/NativeToolchain'
import * as Analysis from '@silklang/compiler/Analysis'
import * as FileSourceResolver from '@silklang/compiler/FileSourceResolver'
import * as Project from '@silklang/compiler/Project'
import * as ProjectAnalysis from '@silklang/compiler/ProjectAnalysis'
import * as SourceFile from '@silklang/compiler/SourceFile'
import * as SourceOrigin from '@silklang/compiler/SourceOrigin'
import * as SourceResolver from '@silklang/compiler/SourceResolver'
import * as Arr from 'effect/Array'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Path from 'effect/Path'
import * as Result from 'effect/Result'
import * as Document from './Document.js'
import type * as ProjectSnapshot from './ProjectSnapshot.js'
import * as WorkspaceCatalog from './WorkspaceCatalog.js'

export interface Identity {
  readonly workspace: string
  readonly sourceRoot: string
}

export interface Invalidation {
  readonly dirtyPaths: ReadonlyArray<string>
  readonly rediscover: boolean
}

const virtualModule = (uri: string): string => {
  let hash = 2166136261
  for (const character of uri) {
    hash ^= character.codePointAt(0) ?? 0
    hash = Math.imul(hash, 16777619)
  }
  return `virtual/${(hash >>> 0).toString(16)}`
}

/** Locates one document's project source root, falling back to its own directory. */
export const sourceRootOf = Effect.fn('Workspace.sourceRootOf')(function* (
  documentPath: string,
): Effect.fn.Return<string, never, FileSystem.FileSystem | Path.Path> {
  const path = yield* Path.Path
  const directory = path.dirname(documentPath)
  const project = yield* Effect.result(Project.load({ workingDirectory: directory }))
  return Result.isSuccess(project) ? project.success.entry.sourceRoot : directory
})

/** Discovers the stable project or standalone workspace identity for one filesystem path. */
export const identityOf = Effect.fn('Workspace.identityOf')(function* (
  documentPath: string,
): Effect.fn.Return<Identity, never, FileSystem.FileSystem | Path.Path> {
  const path = yield* Path.Path
  const directory = path.dirname(documentPath)
  const project = yield* Effect.result(Project.load({ workingDirectory: directory }))
  return Result.isSuccess(project)
    ? Object.freeze({
        workspace: `project:${project.success.manifestPath}`,
        sourceRoot: project.success.entry.sourceRoot,
      })
    : Object.freeze({ workspace: `standalone:${directory}`, sourceRoot: directory })
})

/** Derives the canonical module identity of one document path under a source root. */
export const moduleOf = Effect.fn('Workspace.moduleOf')(function* (
  sourceRoot: string,
  documentPath: string,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path
  const withoutExtension = (value: string): string =>
    value.endsWith('.silk') ? value.slice(0, -'.silk'.length) : value
  const relative = withoutExtension(path.relative(sourceRoot, documentPath))
  const candidate = relative.split(path.sep).join('/')
  if (SourceResolver.isCanonicalModule(candidate)) return candidate
  const basename = withoutExtension(path.basename(documentPath))
  return SourceResolver.isCanonicalModule(basename) ? basename : 'untitled'
})

/** Opens one synchronized document with its discovered project identity. */
export const open = Effect.fn('Workspace.open')(function* (options: {
  readonly uri: string
  readonly version: number
  readonly bytes: Uint8Array
  readonly configuration?: unknown
}): Effect.fn.Return<Document.Document, never, FileSystem.FileSystem | Path.Path> {
  const path = yield* Path.Path
  const parsedUrl = yield* Effect.try(() => new URL(options.uri)).pipe(Effect.option)
  const documentPath =
    Option.isNone(parsedUrl) || parsedUrl.value.protocol !== 'file:'
      ? Option.none<string>()
      : yield* path.fromFileUrl(parsedUrl.value).pipe(Effect.option)
  if (Option.isNone(documentPath)) {
    return Document.make({
      uri: options.uri,
      version: options.version,
      workspace: `virtual:${options.uri}`,
      module: virtualModule(options.uri),
      sourceRoot: options.uri,
      bytes: options.bytes,
      configuration: options.configuration,
    })
  }
  const identity = yield* identityOf(documentPath.value)
  const module = yield* moduleOf(identity.sourceRoot, documentPath.value)
  return Document.make({
    uri: options.uri,
    version: options.version,
    workspace: identity.workspace,
    module,
    sourceRoot: identity.sourceRoot,
    bytes: options.bytes,
    configuration: options.configuration,
  })
})

/** A resolver serving open-document overlays first, then rooted `.silk` files. */
export const resolver = (
  sourceRoot: string,
  overlays: ReadonlyMap<string, SourceResolver.ResolvedSource>,
): Layer.Layer<SourceResolver.SourceResolver, never, FileSystem.FileSystem | Path.Path> =>
  Layer.effect(
    SourceResolver.SourceResolver,
    Effect.gen(function* () {
      const files = yield* SourceResolver.SourceResolver
      return {
        resolve: Effect.fnUntraced(function* (module: string) {
          const source = overlays.get(module)
          if (source !== undefined) return Option.some(source)
          return yield* files.resolve(module)
        }),
        resolveStandardLibrary: files.resolveStandardLibrary,
      }
    }),
  ).pipe(Layer.provide(FileSourceResolver.layer(FileSourceResolver.make(sourceRoot))))

/** Resolves editor selection with the same catalog and logical normalization as the CLI. */
const configuration = Effect.fnUntraced(function* (
  document: Document.Document,
): Effect.fn.Return<ProjectAnalysis.Options, never, FileSystem.FileSystem | Path.Path> {
  const attempt = yield* Effect.result(
    Effect.gen(function* () {
      const loaded = yield* Effect.result(Project.load({ workingDirectory: document.sourceRoot }))
      const origin = ConfigurationOrigin.literal(document.uri)
      if (Result.isFailure(loaded) && loaded.failure.reason._tag !== 'ManifestNotFound') {
        if (loaded.failure.reason._tag === 'InvalidProfile')
          return yield* loaded.failure.reason.error
        return yield* ConfigurationError.make(
          'Workspace.configuration',
          'InvalidInput',
          'project manifest',
          [origin],
        )
      }
      const project = Result.isSuccess(loaded) ? loaded.success : undefined
      const catalog: ProjectProfile.Catalog = project?.profiles ?? {
        profiles: new Map(),
        bindings: [],
        origin,
      }
      const request = yield* ProjectProfile.selection(document.configuration, origin)
      const host = NativeToolchain.hostSelection()
      const selected = yield* ProjectProfile.select(
        catalog,
        request,
        host._tag === 'Resolved' ? host.target.id : undefined,
      )
      return {
        application: project?.entry.module,
        configuration: {
          ...(project?.build.composition === undefined
            ? {}
            : {
                composition: project.build.composition,
                compositionOrigin: ConfigurationOrigin.literal(
                  `${project.manifestPath}:build.composition`,
                ),
              }),
          package:
            project === undefined ? 'standalone@0.0.0' : `${project.name}@${project.version}`,
          profile: selected.input,
          bindings: selected.bindings,
        },
      }
    }),
  )
  return Result.isSuccess(attempt)
    ? {
        configuration: attempt.success.configuration,
        ...(attempt.success.application === undefined
          ? {}
          : { application: attempt.success.application }),
      }
    : { configurationError: attempt.failure }
})

/** Analyzes one document as its compilation root, seeing sibling open documents. */
export const analyze = Effect.fn('Workspace.analyze')(function* (
  document: Document.Document,
  openDocuments: Iterable<Document.Document>,
): Effect.fn.Return<
  Analysis.FrontendSnapshot,
  ModuleClosure.ModuleClosureError,
  FileSystem.FileSystem | Path.Path
> {
  const overlays = new Map<string, SourceResolver.ResolvedSource>()
  for (const open of openDocuments) {
    if (open.workspace === document.workspace) {
      overlays.set(open.module, SourceResolver.resolved(open.bytes, SourceOrigin.memory(open.uri)))
    }
  }
  overlays.set(
    document.module,
    SourceResolver.resolved(document.bytes, SourceOrigin.memory(document.uri)),
  )
  const selected = yield* configuration(document)
  const project = yield* ProjectAnalysis.make([document.module], selected).pipe(
    Effect.provide(resolver(document.sourceRoot, overlays)),
  )
  const view = ProjectAnalysis.view(project, document.module)
  if (view === undefined) throw new RangeError('Workspace analysis lost its root view')
  return view
})

/**
 * Analyzes all synchronized project roots through one shared immutable compiler frontend.
 * Reports completed stages so the worker watchdog can recognize forward progress during cold analysis.
 */
export const analyzeProject = Effect.fn('Workspace.analyzeProject')(function* (
  documents: ReadonlyArray<Document.Document>,
  previous: ReadonlyMap<string, ProjectSnapshot.DocumentSnapshot> = new Map(),
  invalidation: Invalidation = Object.freeze({
    dirtyPaths: Object.freeze([]),
    rediscover: false,
  }),
  onProgress?: (phase: string) => Effect.Effect<void>,
): Effect.fn.Return<
  ReadonlyMap<string, ProjectSnapshot.DocumentSnapshot>,
  ModuleClosure.ModuleClosureError,
  FileSystem.FileSystem | Path.Path
> {
  if (!Arr.isReadonlyArrayNonEmpty(documents)) return new Map()
  const first = Arr.headNonEmpty(documents)
  const overlays = new Map<string, SourceResolver.ResolvedSource>()
  for (const document of documents) {
    overlays.set(
      document.module,
      SourceResolver.resolved(document.bytes, SourceOrigin.memory(document.uri)),
    )
  }
  const roots = Arr.map(documents, (document) => document.module)
  const previousProject = previous.values().next().value?.project
  const priorCatalog = previous.values().next().value?.inventory
  const previousInventory =
    priorCatalog === undefined ? undefined : Option.getOrUndefined(yield* priorCatalog.completed)
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const selectedConfiguration = yield* configuration(first)
  yield* onProgress?.('ConfigurationSelected') ?? Effect.void
  const inventory = yield* WorkspaceCatalog.defer(
    WorkspaceCatalog.refresh({
      sourceRoot: first.sourceRoot,
      documents,
      configuration: selectedConfiguration,
      ...(previousInventory === undefined ? {} : { previous: previousInventory }),
      invalidation: {
        dirtyPaths: invalidation.dirtyPaths,
        rediscover: invalidation.rediscover,
      },
    }).pipe(
      Effect.provide(resolver(first.sourceRoot, overlays)),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    ),
  )
  const project = yield* (
    previousProject === undefined
      ? ProjectAnalysis.make(roots, selectedConfiguration)
      : ProjectAnalysis.revise(previousProject, roots, selectedConfiguration)
  ).pipe(Effect.provide(resolver(first.sourceRoot, overlays)))
  yield* onProgress?.('ProjectAnalyzed') ?? Effect.void
  const moduleUris = new Map<string, string>()
  for (const module of project.closure.modules) {
    const source = project.closure.sources.get(module.name)
    if (source === undefined) continue
    const uri = yield* uriOf(source, documents)
    if (uri !== undefined) moduleUris.set(module.name, uri)
  }
  return new Map(
    documents.flatMap((document) => {
      const snapshot = ProjectAnalysis.view(project, document.module)
      return snapshot === undefined
        ? []
        : [
            [
              document.uri,
              Object.freeze({ document, project, snapshot, moduleUris, inventory }),
            ] as const,
          ]
    }),
  )
})

/** Maps one module identity back to a document URI for cross-file references. */
export const uriOf = Effect.fn('Workspace.uriOf')(function* (
  source: SourceFile.SourceFile,
  openDocuments: Iterable<Document.Document>,
): Effect.fn.Return<string | undefined, never, Path.Path> {
  for (const open of openDocuments) {
    if (open.module === source.id) return open.uri
  }
  switch (source.origin._tag) {
    case 'Memory':
    case 'ToolchainFile':
      return source.origin.uri
    case 'ProjectFile': {
      const path = yield* Path.Path
      const url = yield* path.toFileUrl(source.origin.path).pipe(Effect.option)
      return Option.isSome(url) ? url.value.href : undefined
    }
  }
})
