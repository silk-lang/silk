import { createHash } from 'node:crypto'
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Option from 'effect/Option'
import * as Path from 'effect/Path'
import type * as PlatformError from 'effect/PlatformError'
import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'
import * as Analysis from '@silklang/compiler/Analysis'
import * as AuthoredIdentity from '@silklang/compiler/AuthoredIdentity'
import * as CompilationProfile from '@silklang/compiler/CompilationProfile'
import type * as ConfigurationError from '@silklang/compiler/ConfigurationError'
import type * as ConfigurationOrigin from '@silklang/compiler/ConfigurationOrigin'
import * as ConfigurationValue from '@silklang/compiler/ConfigurationValue'
import type * as DeclarationFacts from '@silklang/compiler/DeclarationFacts'
import * as FileSourceResolver from '@silklang/compiler/FileSourceResolver'
import * as Instances from '@silklang/compiler/Instances'
import * as Project from '@silklang/compiler/Project'
import * as SourceFile from '@silklang/compiler/SourceFile'
import type * as SourceSpan from '@silklang/compiler/SourceSpan'
import * as StaticValue from '@silklang/compiler/StaticValue'
import * as Stdlib from '@silklang/compiler/Stdlib'
import * as Tir from '@silklang/compiler/Tir'
import * as ToolchainIntegrity from '@silklang/compiler/ToolchainIntegrity'
import * as Type from '@silklang/compiler/Type'
import * as BuildBatch from '../../packages/cli/src/BuildBatch.js'
import * as BuildPlan from '../../packages/cli/src/BuildPlan.js'

/** SourceSnapshot's immutable Git-export contract; publication is a separate capability. */
export const InputSnapshotSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  sourceCommit: Schema.String,
  roots: Schema.Array(Schema.String),
  files: Schema.Array(
    Schema.Struct({ path: Schema.String, mode: Schema.String, sha256: Schema.String }),
  ),
  normalizedDigest: Schema.String,
  compilerDigest: Schema.String,
  stdlibDigest: Schema.String,
  archive: Schema.String,
  archiveSha256: Schema.String,
})
export type InputSnapshot = Schema.Schema.Type<typeof InputSnapshotSchema>

export interface BootstrapClosureInventory {
  readonly directory: string
  readonly inputs: InputSnapshot
  /** Exact verified producer authority, not a claim that a historical N0 analyzed new source. */
  readonly bootstrap: {
    readonly commit: string
    readonly runId: string
    readonly file: string
    readonly sha256: string
    readonly stdlibDigest: string
  }
  readonly profile: {
    readonly name: 'release-with-debug'
    readonly target: string
    readonly optimization: 'speed'
    readonly debug: true
  }
}

export class InventoryError extends Data.TaggedError('BootstrapClosureInventoryError')<{
  readonly operation: string
  readonly message: string
  readonly reason: 'InvalidInput' | 'UnavailableProvenance' | 'WrappedFailure'
  readonly cause?: unknown
}> {}

const invalid = (message: string) =>
  new InventoryError({ operation: 'verify inputs', message, reason: 'InvalidInput' })
const digest = Effect.fnUntraced(function* (bytes: Uint8Array | string) {
  return yield* Effect.try({
    try: () => createHash('sha256').update(bytes).digest('hex'),
    catch: (cause) =>
      new InventoryError({
        operation: 'hash bytes',
        message: 'Could not hash immutable input',
        reason: 'WrappedFailure',
        cause,
      }),
  })
})
const fileDigest = Effect.fnUntraced(function* (files: InputSnapshot['files']) {
  return yield* digest(
    files.map(({ path, mode, sha256 }) => `${path}\0${mode}\0${sha256}\n`).join(''),
  )
})

/** Verify the same bytes and Git modes the seed builder consumed, without writing anything. */
export const verifyInputs = Effect.fn('BootstrapClosureInventory.verifyInputs')(function* (
  self: BootstrapClosureInventory,
): Effect.fn.Return<
  void,
  InventoryError | PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path
> {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  if (
    !/^[0-9a-f]{40}$/.test(self.inputs.sourceCommit) ||
    !/^[0-9a-f]{40}$/.test(self.bootstrap.commit) ||
    !/^[1-9][0-9]*$/.test(self.bootstrap.runId)
  )
    return yield* invalid('Exact source/bootstrap commit and verified run are required')
  if (self.inputs.roots.join('\0') !== 'compiler\0packages/compiler/stdlib')
    return yield* invalid('Inventory requires the authored compiler and complete stdlib roots')
  const sorted = self.inputs.files.toSorted((a, b) => {
    if (a.path < b.path) return -1
    if (a.path > b.path) return 1
    return 0
  })
  if (new Set(sorted.map((file) => file.path)).size !== sorted.length)
    return yield* invalid('Duplicate input paths')
  for (const file of sorted) {
    if (
      file.path.split('/').some((part) => part === '' || part === '.' || part === '..') ||
      file.path.includes('\\') ||
      !self.inputs.roots.some((root) => file.path.startsWith(`${root}/`)) ||
      !['100644', '100755'].includes(file.mode)
    )
      return yield* invalid(`Invalid immutable input path/mode: ${file.path}`)
    const target = path.join(self.directory, file.path)
    const stat = yield* fs.stat(target)
    if (
      stat.type !== 'File' ||
      (stat.mode & 0o777) !== Number.parseInt(file.mode.slice(3), 8) ||
      (yield* digest(yield* fs.readFile(target))) !== file.sha256
    )
      return yield* invalid(`Input changed: ${file.path}`)
  }
  for (const required of [
    'compiler/silk.toml',
    'compiler/src/main.silk',
    'packages/compiler/stdlib/manifest.json',
  ])
    if (!sorted.some((file) => file.path === required))
      return yield* invalid(`Missing authored input: ${required}`)
  if (
    (yield* fileDigest(sorted)) !== self.inputs.normalizedDigest ||
    (yield* fileDigest(sorted.filter((file) => file.path.startsWith('compiler/')))) !==
      self.inputs.compilerDigest ||
    (yield* fileDigest(
      sorted.filter((file) => file.path.startsWith('packages/compiler/stdlib/')),
    )) !== self.inputs.stdlibDigest
  )
    return yield* invalid('Input receipt digests do not match the authored files')
  if (self.bootstrap.stdlibDigest !== self.inputs.stdlibDigest)
    return yield* invalid('Analysis stdlib differs from the verified bootstrap embedded stdlib')
  for (const module of Stdlib.manifest) {
    const file = sorted.find((entry) => entry.path === `packages/compiler/stdlib/${module.path}`)
    if (file === undefined || (yield* digest(module.bytes)) !== file.sha256)
      return yield* invalid(
        `Installed analysis stdlib differs from the authored snapshot: ${module.module}`,
      )
  }
  if ((yield* digest(yield* fs.readFile(self.bootstrap.file))) !== self.bootstrap.sha256)
    return yield* invalid('Verified bootstrap executable bytes changed')
  if (
    self.inputs.archive !== 'authored-inputs.tar' ||
    (yield* digest(yield* fs.readFile(path.join(self.directory, self.inputs.archive)))) !==
      self.inputs.archiveSha256
  )
    return yield* invalid('Authored snapshot archive changed')
})

const span = (value: SourceSpan.SourceSpan) => ({
  sourceId: value.sourceId,
  start: value.start,
  end: value.end,
})
const key = (value: Instances.InstanceKey) => ({
  identity: Instances.keyText(value),
  declaration: value.declaration,
  typeArguments: value.typeArguments.map(Type.encodeGenericArgument),
  staticArguments: value.staticArguments.map(StaticValue.encode),
  contractRow: value.contractRow,
  evidence: value.evidence,
})
const providers = (values: ReadonlyArray<Instances.CallProvider> | undefined) =>
  (values ?? []).map((value) => ({
    capability: Type.encode(value.capability),
    providerType: Type.encode(value.providerType),
    role: value.role,
  }))

export type EncodedInstanceKey = ReturnType<typeof key>
export interface KeyedExecutionEdge {
  readonly kind: Instances.ExecutionEdge['kind']
  readonly owner: EncodedInstanceKey
  readonly target: EncodedInstanceKey
  readonly providers: ReturnType<typeof providers>
}

const executionKeyTable = (edges: ReadonlyArray<KeyedExecutionEdge>) => {
  const executionKeys: Array<EncodedInstanceKey> = []
  const executionKeyIndices = new Map<string, number>()
  const reference = (encoded: EncodedInstanceKey): number => {
    const equality = JSON.stringify(encoded)
    const found = executionKeyIndices.get(equality)
    if (found !== undefined) return found
    const at = executionKeys.length
    executionKeys.push(encoded)
    executionKeyIndices.set(equality, at)
    return at
  }
  const reachedExecutionEdges = edges.map((edge) => ({
    ...edge,
    owner: reference(edge.owner),
    target: reference(edge.target),
  }))
  return {
    executionKeyScope: 'LOCAL_COMPLETE_KEY_RECORDS' as const,
    executionKeys,
    reachedExecutionEdges,
  }
}

/** Lossless local references over full already-encoded records; this does not analyze source. */
export const encodeExecutionEdges = Effect.fn('BootstrapClosureInventory.encodeExecutionEdges')(
  function* (
    edges: ReadonlyArray<KeyedExecutionEdge>,
  ): Effect.fn.Return<ReturnType<typeof executionKeyTable>, InventoryError> {
    return yield* Effect.try({
      try: () => executionKeyTable(edges),
      catch: (cause) =>
        new InventoryError({
          operation: 'encode execution edges',
          message: 'Execution key records are unavailable',
          reason: 'WrappedFailure',
          cause,
        }),
    })
  },
)

const authored = (snapshot: Analysis.Snapshot, declaration: DeclarationFacts.DeclarationFact) => {
  const registry = Analysis.nameResolution(snapshot).contexts
  const declarationSpan = registry.spanOf(declaration.anchor)
  if (declaration.name._tag !== 'Present') return undefined
  let tokenName = declaration.name
  const implementation = declaration.conformanceImplementation
  if (implementation !== undefined) {
    const conformances = Analysis.declarationIndex(snapshot)
      .modules.filter((module) => module.module === declaration.id.sourceId)
      .flatMap((module) => module.conformances)
      .filter(
        (conformance) =>
          conformance.module === declaration.id.sourceId &&
          conformance.ordinal === implementation.ordinal,
      )
    const conformance = conformances.at(0)
    if (conformances.length !== 1 || conformance === undefined) return undefined
    const operations = conformance.operations.filter(
      (operation) =>
        operation.form === 'Inline' &&
        operation.name._tag === 'Present' &&
        operation.name.spelling === implementation.operation &&
        AuthoredIdentity.anchorKey(operation.anchor) ===
          AuthoredIdentity.anchorKey(declaration.anchor) &&
        AuthoredIdentity.anchorKey(operation.name.anchor) ===
          AuthoredIdentity.anchorKey(declaration.name.anchor),
    )
    const operation = operations.at(0)
    if (operations.length !== 1 || operation?.name._tag !== 'Present') return undefined
    tokenName = operation.name
  }
  const nameSpan = registry.spanOf(declaration.name.anchor)
  const source = snapshot.closure.sources.get(nameSpan.sourceId)
  if (
    source === undefined ||
    nameSpan.sourceId !== declaration.id.sourceId ||
    nameSpan.sourceId !== declaration.owner.module ||
    declarationSpan.sourceId !== nameSpan.sourceId ||
    !AuthoredIdentity.equals(declaration.anchor.owner, declaration.owner) ||
    !AuthoredIdentity.equals(tokenName.anchor.owner, declaration.owner) ||
    nameSpan.start === nameSpan.end ||
    registry.of(declaration.anchor) === undefined ||
    registry.of(declaration.name.anchor) === undefined
  )
    return undefined
  const spelling = SourceFile.spelling(source, nameSpan)
  if (
    Option.isNone(spelling) ||
    spelling.value !== tokenName.spelling ||
    declarationSpan.start === declarationSpan.end
  )
    return undefined
  return {
    id: declaration.id,
    canonical: declaration.canonical,
    owner: declaration.owner,
    anchor: declaration.anchor,
    declarationSpan: span(declarationSpan),
    lookupName: declaration.name.spelling,
    name: { spelling: spelling.value, anchor: declaration.name.anchor, span: span(nameSpan) },
  }
}

/** Capture only the facade's selected Discovery; dense residual nodes are presence, not execution. */
const facts = (snapshot: Analysis.Snapshot) => {
  const discovery = Analysis.instancesOf(snapshot)
  const authoredFunctions = new Map<string, NonNullable<ReturnType<typeof authored>>>()
  const missingProvenance: Array<string> = []
  const instances = discovery.instances.map((instance) => {
    const declaration = Analysis.declarationForIdentity(snapshot, {
      _tag: 'DeclarationIdentity',
      id: instance.function.declaration.id,
    })
    const generated =
      instance.function.artifact?.parent !== undefined ||
      Tir.isAnonymousCallableId(instance.key.declaration)
    const original =
      !generated && declaration?._tag === 'FunctionDeclaration'
        ? authored(snapshot, declaration)
        : undefined
    if (original !== undefined)
      authoredFunctions.set(`${original.id.sourceId}\0${original.id.ordinal}`, original)
    // Compiler-generated declarations have no original index entry and stay explicitly generated.
    if (!generated && original === undefined)
      missingProvenance.push(Instances.keyText(instance.key))
    const artifact = instance.function.artifact
    if (artifact === undefined || instance.function.nodes === undefined)
      missingProvenance.push(Instances.keyText(instance.key))
    const origin = (() => {
      if (generated)
        return { kind: 'Generated' as const, owner: instance.function.declaration.owner }
      if (original === undefined)
        return {
          kind: 'MissingAuthoredProvenance' as const,
          declaration: instance.function.declaration.id,
        }
      return { kind: 'Authored' as const, declaration: original.id }
    })()
    return {
      key: key(instance.key),
      origin,
      artifact,
      originalDeclaration: original?.id,
      originalDeclarationSpan: original?.declarationSpan,
      residualBodySites: Tir.nodesOf(instance.function).map((node) => ({
        evidence: 'PRESENT_IN_SELECTED_RESIDUAL_BODY' as const,
        node: node.id,
        tag: '_tag' in node && typeof node._tag === 'string' ? node._tag : 'Unknown',
        origin: node.origin,
        span: span(node.span),
      })),
    }
  })
  const execution = executionKeyTable(
    discovery.executionEdges.map((edge) => ({
      kind: edge.kind,
      owner: key(edge.owner),
      target: key(edge.target),
      providers: providers(edge.providers),
    })),
  )
  return {
    ...execution,
    // Node identity is (this containing instance key, artifact, node id). Original provenance
    // is also inherited from the parent; no per-node copy changes or weakens that authority.
    residualSiteScope: 'PARENT_INSTANCE_ARTIFACT_AND_ORIGINAL_DECLARATION' as const,
    status:
      !snapshot.diagnostics.some((diagnostic) => diagnostic.severity === 'error') &&
      snapshot.closure.resolutionFailures.length === 0 &&
      snapshot.mir._tag === 'Available' &&
      missingProvenance.length === 0 &&
      discovery.unavailableOwnership.length === 0 &&
      discovery.specializationFailures.length === 0 &&
      discovery.violations.length === 0
        ? ('Complete' as const)
        : ('Incomplete' as const),
    selectedAuthoredFunctions: [...authoredFunctions.values()],
    instances,
    reachedIntrinsics: discovery.intrinsics.map((call) => ({
      operation: call.operation,
      span: span(call.span),
    })),
    retention: discovery.retention.map(key),
    missingProvenance,
    unavailableOwnership: discovery.unavailableOwnership.map((value) => key(value.key)),
    specializationFailures: discovery.specializationFailures.map((value) => key(value.key)),
    violations: discovery.violations.map((value) => ({
      caller: key(value.caller),
      target: key(value.target),
    })),
  }
}
export type SelectedFacts = ReturnType<typeof facts>

/** Useful separately from physical publication and input verification; never certifies bytes itself. */
export const capture = Effect.fn('BootstrapClosureInventory.capture')(function* (
  snapshot: Analysis.Snapshot,
): Effect.fn.Return<SelectedFacts, InventoryError> {
  return yield* Effect.try({
    try: () => facts(snapshot),
    catch: (cause) =>
      new InventoryError({
        operation: 'capture selected facts',
        message: 'Published selected provenance is unavailable',
        reason: 'UnavailableProvenance',
        cause,
      }),
  })
})

/** Analyze the unchanged compiler Project with precisely the authored seed CLI build plan. */
const analyzeVerified = Effect.fnUntraced(function* (
  self: BootstrapClosureInventory,
): Effect.fn.Return<
  Inventory,
  | InventoryError
  | PlatformError.PlatformError
  | PlatformError.BadArgument
  | ConfigurationError.ConfigurationError,
  FileSystem.FileSystem | Path.Path
> {
  yield* verifyInputs(self)
  const path = yield* Path.Path
  const projectResult = yield* Effect.result(
    Project.load({ manifestPath: path.join(self.directory, 'compiler/silk.toml') }),
  )
  if (Result.isFailure(projectResult))
    return {
      schemaVersion: 1,
      evidence: 'SELECTED_ANALYSIS_CLOSURE_ONLY',
      status: 'Incomplete',
      inputs: self.inputs,
      bootstrap: self.bootstrap,
      analysisToolchain: ToolchainIntegrity.installed(),
      failure: { stage: 'Project', message: projectResult.failure.message },
    }
  const project = projectResult.success
  const batch = yield* Effect.result(BuildBatch.make(project, { optimization: self.profile.name }))
  if (Result.isFailure(batch))
    return {
      schemaVersion: 1,
      evidence: 'SELECTED_ANALYSIS_CLOSURE_ONLY',
      status: 'Incomplete',
      inputs: self.inputs,
      bootstrap: self.bootstrap,
      analysisToolchain: ToolchainIntegrity.installed(),
      failure: { stage: 'Plan', message: batch.failure.message },
    }
  const [plan] = batch.success.plans
  const configuration = BuildPlan.compilationConfiguration(plan)
  if (
    batch.success.plans.length !== 1 ||
    project.entry.module !== 'main' ||
    plan.target.id !== self.profile.target ||
    configuration.profile.optimization !== self.profile.optimization ||
    configuration.profile.debug !== self.profile.debug ||
    plan.artifactKind !== 'NativeExecutable' ||
    plan.stage !== 'final'
  )
    return yield* invalid('Project plan differs from the exact seed executable profile')
  const request = { root: project.entry.module, configuration }
  const bindings: Array<{
    readonly package: string
    readonly module: string
    readonly parameter: string
    readonly tier: string
    readonly value: string
    readonly origin: ConfigurationOrigin.ConfigurationOrigin
  }> = []
  for (const binding of configuration.bindings ?? []) {
    const value = yield* ConfigurationValue.decode(binding.value, binding.origin)
    bindings.push({
      package: binding.package,
      module: binding.module,
      parameter: binding.parameter,
      tier: binding.tier,
      value: ConfigurationValue.encode(value),
      origin: binding.origin,
    })
  }
  const libraryUrl = yield* path.toFileUrl(
    path.join(self.directory, 'packages/compiler/stdlib') + path.sep,
  )
  const resolver = FileSourceResolver.layer(
    FileSourceResolver.make(project.entry.sourceRoot, { kind: 'files', root: libraryUrl.href }),
  )
  const attempt = yield* Effect.result(
    Effect.gen(function* () {
      const frontend = yield* Analysis.make(request)
      return yield* Analysis.realize(frontend, configuration)
    }).pipe(Effect.provide(resolver)),
  )
  yield* verifyInputs(self)
  if (Result.isFailure(attempt))
    return {
      schemaVersion: 1,
      evidence: 'SELECTED_ANALYSIS_CLOSURE_ONLY',
      status: 'Incomplete',
      inputs: self.inputs,
      bootstrap: self.bootstrap,
      analysisToolchain: ToolchainIntegrity.installed(),
      failure: { stage: 'Analysis', message: attempt.failure.message },
    }
  const snapshot = attempt.success
  const selected = yield* capture(snapshot)
  const consumedSources: Array<{
    readonly module: string
    readonly path: string
    readonly sha256: string
  }> = []
  for (const [module, source] of snapshot.closure.sources) {
    const origin = source.origin
    let file: string | undefined
    if (origin._tag === 'ProjectFile') file = origin.path
    else if (origin._tag === 'ToolchainFile') {
      const url = yield* Effect.try({
        try: () => new URL(origin.uri),
        catch: (cause) =>
          new InventoryError({
            operation: 'resolve source origin',
            message: 'Malformed toolchain source URL',
            reason: 'WrappedFailure',
            cause,
          }),
      })
      file = yield* path.fromFileUrl(url)
    }
    if (file === undefined)
      return yield* invalid(`Consumed module has no physical snapshot provenance: ${module}`)
    const relative = path.relative(self.directory, file).split(path.sep).join('/')
    const sha256 = yield* digest(SourceFile.toUint8Array(source))
    if (!self.inputs.files.some((input) => input.path === relative && input.sha256 === sha256))
      return yield* invalid(`Consumed module is outside the verified snapshot: ${module}`)
    consumedSources.push({ module, path: relative, sha256 })
  }
  const diagnostics = snapshot.diagnostics.map((value) => ({
    code: value.code,
    severity: value.severity,
    span: span(value.span),
  }))
  const complete =
    selected.status === 'Complete' &&
    !snapshot.diagnostics.some((value) => value.severity === 'error') &&
    snapshot.closure.resolutionFailures.length === 0 &&
    snapshot.mir._tag === 'Available' &&
    snapshot.artifactPlan !== undefined &&
    selected.missingProvenance.length === 0 &&
    selected.unavailableOwnership.length === 0 &&
    selected.specializationFailures.length === 0 &&
    selected.violations.length === 0
  return {
    schemaVersion: 1,
    evidence: 'SELECTED_ANALYSIS_CLOSURE_ONLY',
    status: complete ? 'Complete' : 'Incomplete',
    inputs: self.inputs,
    bootstrap: self.bootstrap,
    analysisToolchain: ToolchainIntegrity.installed(),
    compilation: {
      manifest: 'compiler/silk.toml',
      root: request.root,
      requestedProfile: configuration.profile,
      bindings,
      modules: configuration.modules ?? [],
      requestedComposition: configuration.composition,
      requestedCompositionOrigin: configuration.compositionOrigin,
      profile:
        snapshot.profile === undefined
          ? undefined
          : {
              identity: CompilationProfile.encode(snapshot.profile),
              input: CompilationProfile.input(snapshot.profile),
            },
      package: configuration.package,
      artifact: plan.artifactKind,
      stage: plan.stage,
      composition: snapshot.composition,
      artifactIdentity: snapshot.artifactPlan?.identity,
    },
    consumedSources,
    diagnostics,
    selected,
  }
})

export interface Inventory {
  readonly schemaVersion: 1
  readonly evidence: 'SELECTED_ANALYSIS_CLOSURE_ONLY'
  readonly status: 'Complete' | 'Incomplete'
  readonly inputs: InputSnapshot
  readonly bootstrap: BootstrapClosureInventory['bootstrap']
  readonly analysisToolchain: ToolchainIntegrity.Graph
  readonly failure?: { readonly stage: string; readonly message: string }
  readonly compilation?: {
    readonly manifest: string
    readonly root: string
    readonly requestedProfile: CompilationProfile.Input
    readonly bindings: ReadonlyArray<{
      readonly package: string
      readonly module: string
      readonly parameter: string
      readonly tier: string
      readonly value: string
      readonly origin: ConfigurationOrigin.ConfigurationOrigin
    }>
    readonly modules: NonNullable<Analysis.Snapshot['configuration']>['modules']
    readonly requestedComposition: NonNullable<Analysis.Snapshot['configuration']>['composition']
    readonly requestedCompositionOrigin: NonNullable<
      Analysis.Snapshot['configuration']
    >['compositionOrigin']
    readonly profile:
      | { readonly identity: string; readonly input: CompilationProfile.Input }
      | undefined
    readonly package: string | undefined
    readonly artifact: string
    readonly stage: string | undefined
    readonly composition: Analysis.Snapshot['composition']
    readonly artifactIdentity: string | undefined
  }
  readonly consumedSources?: ReadonlyArray<{
    readonly module: string
    readonly path: string
    readonly sha256: string
  }>
  readonly diagnostics?: ReadonlyArray<{
    readonly code: string
    readonly severity: string
    readonly span: ReturnType<typeof span>
  }>
  readonly selected?: SelectedFacts
}

/** Complete means a selected analysis inventory, never executable readiness or strict build success. */
export const analyze = Effect.fn('BootstrapClosureInventory.analyze')(function* (
  self: BootstrapClosureInventory,
): Effect.fn.Return<Inventory, never, FileSystem.FileSystem | Path.Path> {
  const attempted = yield* Effect.result(analyzeVerified(self))
  if (Result.isSuccess(attempted)) return attempted.success
  return {
    schemaVersion: 1,
    evidence: 'SELECTED_ANALYSIS_CLOSURE_ONLY',
    status: 'Incomplete',
    inputs: self.inputs,
    bootstrap: self.bootstrap,
    analysisToolchain: ToolchainIntegrity.installed(),
    failure: { stage: 'Verification', message: attempted.failure.message },
  }
})

/** Explicit codecs above make this JSON transport safe for generic/static arguments and identities. */
export const encode = Effect.fn('BootstrapClosureInventory.encode')(function* (
  self: Inventory,
): Effect.fn.Return<string, InventoryError> {
  return yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(self).pipe(
    Effect.mapError(
      (cause) =>
        new InventoryError({
          operation: 'encode inventory',
          message: 'Inventory is not a JSON transport value',
          reason: 'WrappedFailure',
          cause,
        }),
    ),
  )
})
