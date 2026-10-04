import type * as ModuleClosure from '@silklang/compiler/ModuleClosure'
import * as Lexer from '@silklang/compiler/Lexer'
import * as ModuleSummary from '@silklang/compiler/ModuleSummary'
import * as Parser from '@silklang/compiler/Parser'
import * as ProjectAnalysis from '@silklang/compiler/ProjectAnalysis'
import * as SourceCatalog from '@silklang/compiler/SourceCatalog'
import * as SourceFile from '@silklang/compiler/SourceFile'
import * as SourceOrigin from '@silklang/compiler/SourceOrigin'
import * as SourceResolver from '@silklang/compiler/SourceResolver'
import * as Stdlib from '@silklang/compiler/Stdlib'
import * as WorkspaceInventory from '@silklang/compiler/WorkspaceInventory'
import * as Arr from 'effect/Array'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Option from 'effect/Option'
import * as Path from 'effect/Path'
import * as Result from 'effect/Result'
import * as Ref from 'effect/Ref'
import * as Fiber from 'effect/Fiber'
import type * as Scope from 'effect/Scope'
import * as Semaphore from 'effect/Semaphore'
import type * as Document from './Document.js'

/** Filesystem hints accumulated for one accepted workspace revision. */
export interface Invalidation {
  readonly dirtyPaths: ReadonlyArray<string>
  readonly rediscover: boolean
}

export interface Request {
  readonly sourceRoot: string
  readonly documents: ReadonlyArray<Document.Document>
  readonly previous?: WorkspaceInventory.WorkspaceInventory
  readonly invalidation: Invalidation
  readonly configuration: ProjectAnalysis.Options
}

interface Counters {
  scanned: number
  reused: number
  revised: number
  removed: number
  summaryElapsedMs: number
}

const analyses = new WeakMap<WorkspaceInventory.WorkspaceInventory, SourceCatalog.Selection>()

const isWithin = (root: string, candidate: string, path: Path.Path): boolean => {
  const relative = path.relative(root, candidate)
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

const moduleOfPath = (root: string, file: string, path: Path.Path): string | undefined => {
  if (!isWithin(root, file, path) || path.extname(file) !== '.silk') return undefined
  const relative = path.relative(root, file).slice(0, -'.silk'.length).split(path.sep).join('/')
  return SourceResolver.isCanonicalModule(relative) ? relative : undefined
}

const walk = Effect.fnUntraced(function* (
  directory: string,
  root: string,
): Effect.fn.Return<ReadonlyArray<string>, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const listed = yield* Effect.result(fileSystem.readDirectory(directory))
  if (Result.isFailure(listed)) return Object.freeze([])
  const files: Array<string> = []
  for (const name of [...listed.success].sort()) {
    const candidate = path.resolve(directory, name)
    const canonical = yield* fileSystem.realPath(candidate).pipe(Effect.option)
    if (
      Option.isNone(canonical) ||
      canonical.value !== candidate ||
      !isWithin(root, canonical.value, path)
    )
      continue
    const info = yield* fileSystem.stat(canonical.value).pipe(Effect.option)
    if (Option.isNone(info)) continue
    if (info.value.type === 'Directory') files.push(...(yield* walk(canonical.value, root)))
    else if (info.value.type === 'File' && path.extname(canonical.value) === '.silk')
      files.push(canonical.value)
  }
  return Object.freeze(files)
})

const summarize = (
  source: SourceFile.SourceFile,
  prior: ModuleSummary.ModuleSummary | undefined,
  counters: Counters,
): ModuleSummary.ModuleSummary => {
  counters.scanned += 1
  if (prior !== undefined && ModuleSummary.matchesSource(prior, source)) {
    counters.reused += 1
    return prior
  }
  const startedAt = performance.now()
  const summary = ModuleSummary.make(Parser.parse(Lexer.lex(source)))
  counters.summaryElapsedMs += performance.now() - startedAt
  counters.revised += 1
  return summary
}

const toolchain = (
  previous: WorkspaceInventory.WorkspaceInventory | undefined,
  counters: Counters,
): Arr.NonEmptyReadonlyArray<ModuleSummary.ModuleSummary> => {
  const prior = previous === undefined ? [] : [...previous.toolchain.values()]
  if (Arr.isReadonlyArrayNonEmpty(prior)) return prior
  return Arr.map(Stdlib.manifest, (entry) =>
    summarize(
      SourceFile.make(entry.module, entry.bytes, SourceOrigin.toolchainFile(entry.sourceUrl.href)),
      undefined,
      counters,
    ),
  )
}

const readSummary = Effect.fnUntraced(function* (
  file: string,
  root: string,
  prior: ReadonlyMap<string, ModuleSummary.ModuleSummary>,
  counters: Counters,
): Effect.fn.Return<
  readonly [string, ModuleSummary.ModuleSummary] | undefined,
  never,
  FileSystem.FileSystem | Path.Path
> {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const module = moduleOfPath(root, file, path)
  if (module === undefined) return undefined
  const bytes = yield* fileSystem.readFile(file).pipe(Effect.option)
  if (Option.isNone(bytes)) return undefined
  const source = SourceFile.make(
    module,
    Uint8Array.from(bytes.value),
    SourceOrigin.projectFile(file),
  )
  return [module, summarize(source, prior.get(module), counters)] as const
})

/** Builds or incrementally revises the header-only project/toolchain inventory. */
export const refresh = Effect.fn('WorkspaceCatalog.refresh')(function* (
  request: Request,
): Effect.fn.Return<
  WorkspaceInventory.WorkspaceInventory,
  ModuleClosure.ModuleClosureError,
  FileSystem.FileSystem | Path.Path | SourceResolver.SourceResolver
> {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const discoveryStartedAt = performance.now()
  const canonicalRoot = yield* fileSystem.realPath(request.sourceRoot).pipe(Effect.option)
  const root = Option.isSome(canonicalRoot) ? canonicalRoot.value : path.resolve(request.sourceRoot)
  const lexicalRoot = path.resolve(request.sourceRoot)
  const previousProject = request.previous?.project ?? new Map()
  const project = new Map(request.previous?.project ?? [])
  const counters: Counters = { scanned: 0, reused: 0, revised: 0, removed: 0, summaryElapsedMs: 0 }
  const openModules = new Set(request.documents.map((document) => document.module))
  const rediscover = request.previous === undefined || request.invalidation.rediscover

  if (rediscover) {
    project.clear()
    const files = yield* walk(root, root)
    for (const file of files) {
      const module = moduleOfPath(root, file, path)
      if (module === undefined || openModules.has(module)) continue
      const loaded = yield* readSummary(file, root, previousProject, counters)
      if (loaded !== undefined) project.set(loaded[0], loaded[1])
    }
    for (const module of previousProject.keys())
      if (!project.has(module) && !openModules.has(module)) counters.removed += 1
  } else {
    for (const dirty of [...new Set(request.invalidation.dirtyPaths)].sort()) {
      const candidate = path.resolve(dirty)
      const module = moduleOfPath(lexicalRoot, candidate, path)
      if (module === undefined || openModules.has(module)) continue
      const canonical = yield* fileSystem.realPath(candidate).pipe(Effect.option)
      const valid =
        Option.isSome(canonical) &&
        moduleOfPath(root, canonical.value, path) === module &&
        isWithin(root, canonical.value, path)
      const loaded = valid
        ? yield* readSummary(canonical.value, root, previousProject, counters)
        : undefined
      if (loaded === undefined) {
        if (project.delete(module)) counters.removed += 1
      } else project.set(loaded[0], loaded[1])
    }
  }

  for (const document of request.documents) {
    const source = SourceFile.make(
      document.module,
      document.bytes,
      SourceOrigin.memory(document.uri),
    )
    project.set(document.module, summarize(source, previousProject.get(document.module), counters))
  }

  const discoveryElapsedMs = performance.now() - discoveryStartedAt
  const bundled = toolchain(request.previous, counters)
  const roots = Arr.map(Arr.appendAll([...project.values()], bundled), (summary) => summary.source)
  const priorAnalysis = request.previous === undefined ? undefined : analyses.get(request.previous)
  const analysis = yield* SourceCatalog.analyze(
    {
      roots: Arr.map(roots, (source) => source.id),
      ...(request.configuration.application === undefined
        ? {}
        : { application: request.configuration.application }),
      ...(request.configuration.configuration === undefined
        ? {}
        : { configuration: request.configuration.configuration }),
      ...(priorAnalysis === undefined ? {} : { previous: priorAnalysis.closure }),
    },
    priorAnalysis?.catalog,
  ).pipe(Effect.provide(SourceResolver.overlay(roots)))
  const catalog =
    request.configuration.configurationError === undefined ? analysis.catalog : undefined
  const selected = catalog?.modules ?? new Map<string, ModuleSummary.ModuleSummary>()
  const inventory = WorkspaceInventory.make({
    project: [...selected].filter(([name]) => !Stdlib.isReserved(name)),
    toolchain: [...selected].filter(([name]) => Stdlib.isReserved(name)),
    ...(catalog === undefined
      ? {}
      : { profile: catalog.profile.identity, identity: catalog.identity }),
    observation: {
      ...counters,
      discoveryElapsedMs,
    },
  })
  analyses.set(inventory, analysis)
  return inventory
})

/** A generation's lazy catalog; only completed selections are retained for later revisions. */
export interface DeferredInventory {
  readonly get: Effect.Effect<
    WorkspaceInventory.WorkspaceInventory,
    ModuleClosure.ModuleClosureError
  >
  readonly completed: Effect.Effect<Option.Option<WorkspaceInventory.WorkspaceInventory>>
}

/** Shares successful selection while allowing an interrupted query to retry. */
export const defer = Effect.fn('WorkspaceCatalog.defer')(function* (
  select: Effect.Effect<WorkspaceInventory.WorkspaceInventory, ModuleClosure.ModuleClosureError>,
): Effect.fn.Return<DeferredInventory> {
  const completed = yield* Ref.make(Option.none<WorkspaceInventory.WorkspaceInventory>())
  const permit = yield* Semaphore.make(1)
  const get = permit.withPermit(
    Effect.gen(function* () {
      const prior = yield* Ref.get(completed)
      if (Option.isSome(prior)) return prior.value
      const inventory = yield* select
      yield* Ref.set(completed, Option.some(inventory))
      return inventory
    }),
  )
  return Object.freeze({ get, completed: Ref.get(completed) })
})

/** Keeps demand-started selection alive across query cancellation, until its generation closes. */
export const retain = Effect.fn('WorkspaceCatalog.retain')(function* (
  inventory: DeferredInventory,
  scope: Scope.Scope,
): Effect.fn.Return<DeferredInventory> {
  const started = yield* Ref.make(
    Option.none<
      Fiber.Fiber<WorkspaceInventory.WorkspaceInventory, ModuleClosure.ModuleClosureError>
    >(),
  )
  const permit = yield* Semaphore.make(1)
  const start = permit
    .withPermit(
      Effect.gen(function* () {
        const existing = yield* Ref.get(started)
        if (Option.isSome(existing)) return existing.value
        const fiber = yield* Effect.forkIn(inventory.get, scope)
        yield* Ref.set(started, Option.some(fiber))
        return fiber
      }),
    )
    .pipe(Effect.uninterruptible)
  return Object.freeze({
    completed: inventory.completed,
    get: start.pipe(Effect.flatMap(Fiber.join)),
  })
})
