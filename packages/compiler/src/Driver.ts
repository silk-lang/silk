import * as MirVerification from './MirVerification.js'
import * as HelperCapability from './HelperCapability.js'
import * as NativeRequirementBinding from './NativeRequirementBinding.js'
import * as ArtifactPlan from './ArtifactPlan.js'
import { NodeServices } from '@effect/platform-node'
import * as Config from 'effect/Config'
import * as Result from 'effect/Result'
import * as ForeignContract from './ForeignContract.js'
import * as Data from 'effect/Data'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Option from 'effect/Option'
import * as ArtifactKind from './ArtifactKind.js'
import * as AbiManifest from './AbiManifest.js'
import * as Backend from './Backend.js'
import * as CHeader from './CHeader.js'
import * as Diagnostic from './Diagnostic.js'
import * as HeapObservation from './HeapObservation.js'
import * as LlvmBackend from './LlvmBackend.js'
import type * as ModuleClosure from './ModuleClosure.js'
import * as NativeLinkInput from './NativeLinkInput.js'
import * as NativeToolchain from './NativeToolchain.js'
import * as ObjectEmission from './ObjectEmission.js'
import * as Linker from './Linker.js'
import type * as NativeLinkPlan from './NativeLinkPlan.js'
import * as PhaseReport from './PhaseReport.js'
import * as Preparation from './Preparation.js'
import type * as Realization from './Realization.js'
import * as SemanticPersistence from './SemanticPersistence.js'
import * as SourceFile from './SourceFile.js'
import * as SourceResolver from './SourceResolver.js'
import type * as SourceSpan from './SourceSpan.js'
import * as Target from './Target.js'
import * as TestExecution from './TestExecution.js'
import * as ToolchainIntegrity from './ToolchainIntegrity.js'
import * as ToolchainPlan from './ToolchainPlan.js'

/**
 * The end-to-end compiler driver: one orchestration path from a compilation request to a durable
 * native executable or WebAssembly module. The driver invokes backend and finalizer boundaries itself — no external
 * harness performs a stage. Outcomes are closed data naming failing stages with provenance, and
 * every run carries a per-phase report: elapsed time, input and output counts, diagnostic
 * counts, and engine-heap memory totals (the bootstrap approximation of allocator totals).
 */

/** One phase's observability entry. Reports are data, not artifacts — exempt from byte-identity. */
export interface DriverPhaseReport extends Omit<PhaseReport.PhaseReport, 'heapBytes'> {
  readonly heapBytes: number
}

const phaseWithHeap = (entry: PhaseReport.PhaseReport): DriverPhaseReport => {
  if (entry.heapBytes === undefined)
    throw new RangeError(`Driver phase ${entry.phase} lost its engine heap observation`)
  return { ...entry, heapBytes: entry.heapBytes }
}

/**
 * Backend emission is deterministic over the source closure, the target, the emission mode, and
 * the compiler build itself (the determinism suites pin byte-identical artifacts across
 * processes), so its output is content-addressable BEFORE it is produced. This key lets an
 * unchanged compilation skip LLVM emission independently of final-artifact cache eligibility.
 */
const backendEmissionCacheKey = (
  distributionDigest: string,
  backendId: string,
  profileIdentity: string,
  planIdentity: string,
  artifactKind: ArtifactKind.ArtifactKind,
  mode: string,
  sources: ReadonlyMap<string, SourceFile.SourceFile>,
  interfaces: ReadonlyArray<SourceFile.SourceFile>,
): string => {
  const modules = [...sources]
    .map(
      ([module, source]) =>
        `${module}:${ToolchainIntegrity.contentDigest(SourceFile.toUint8Array(source))}`,
    )
    .sort()
  const digest = ToolchainIntegrity.contentDigest(
    [
      'backend-emission-v10',
      distributionDigest,
      backendId,
      profileIdentity,
      planIdentity,
      artifactKind,
      mode,
      ...modules,
      ...interfaces
        .map(
          (source) =>
            `interface:${source.id}:${ToolchainIntegrity.contentDigest(SourceFile.toUint8Array(source))}`,
        )
        .sort(),
    ].join('\u0000'),
  )
  return `backend-${digest}.blob`
}

interface CachedEmissionHeader {
  readonly schema: 7
  readonly module: string
  readonly symbols: Backend.LlvmBitcodeArtifact['symbols']
  readonly nativeRuntimeSymbols: ReadonlyArray<string>
  readonly runtimeFeatures: Backend.LlvmBitcodeArtifact['runtimeFeatures']
  readonly foreignImports: Backend.LlvmBitcodeArtifact['foreignImports']
  readonly foreignExports: Backend.LlvmBitcodeArtifact['foreignExports']
  readonly foreignStatics: Backend.LlvmBitcodeArtifact['foreignStatics']
}

const encodeCachedEmission = (artifact: Backend.LlvmBitcodeArtifact): Uint8Array | undefined => {
  try {
    const header: CachedEmissionHeader = {
      schema: 7,
      module: artifact.module,
      symbols: artifact.symbols,
      nativeRuntimeSymbols: artifact.nativeRuntimeSymbols,
      runtimeFeatures: artifact.runtimeFeatures,
      foreignImports: artifact.foreignImports,
      foreignExports: artifact.foreignExports,
      foreignStatics: artifact.foreignStatics,
    }
    const json = new TextEncoder().encode(JSON.stringify(header))
    const bytes = new Uint8Array(4 + json.length + artifact.bitcode.length)
    new DataView(bytes.buffer).setUint32(0, json.length, true)
    bytes.set(json, 4)
    bytes.set(artifact.bitcode, 4 + json.length)
    return bytes
  } catch {
    // Fail open: an unserializable symbol table only means this compilation is not cached.
    return undefined
  }
}

const decodeCachedEmission = (
  bytes: Uint8Array,
  target: Target.Target,
): Backend.LlvmBitcodeArtifact | undefined => {
  try {
    if (bytes.length < 4) return undefined
    const jsonLength = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true)
    if (4 + jsonLength > bytes.length) return undefined
    const header: CachedEmissionHeader = JSON.parse(
      new TextDecoder().decode(bytes.subarray(4, 4 + jsonLength)),
    )
    if (header.schema !== 7) return undefined
    if (
      ![...header.foreignImports, ...header.foreignExports].every(
        (entry) =>
          typeof entry.variadic === 'boolean' &&
          (!entry.variadic || entry.parameters.length > 0) &&
          ForeignContract.inspect(entry.contract, entry.parameters, entry.result) !== undefined,
      )
    )
      return undefined
    if (header.foreignExports.some((entry) => entry.variadic)) return undefined
    const bitcode = bytes.slice(4 + jsonLength)
    // The driver cache does not expose IR or control-flow inspection to callers.
    return {
      _tag: 'LlvmBitcodeArtifact',
      backend: 'llvm',
      module: header.module,
      target,
      symbols: header.symbols,
      nativeRuntimeSymbols: header.nativeRuntimeSymbols,
      runtimeFeatures: header.runtimeFeatures,
      foreignImports: header.foreignImports,
      foreignExports: header.foreignExports,
      foreignStatics: header.foreignStatics,
      control: [],
      bitcode,
      ir: '',
    }
  } catch {
    return undefined
  }
}

/** One driver request. */
export interface CompileRequest {
  /** Audit compiler MIR invariants before emission/cache reuse. Defaults to false. */
  readonly verifyMir?: boolean
  readonly nativeBindings?: ReadonlyArray<NativeRequirementBinding.NativeRequirementBinding>
  readonly stage?: ArtifactPlan.Stage
  readonly compilation: ModuleClosure.CompilationRequest
  readonly toolchain: NativeToolchain.Toolchain
  readonly optimization?: ToolchainPlan.OptimizationProfile
  readonly artifactKind: ArtifactKind.ArtifactKind
  /** Validated project package name used for durable artifact identities. */
  readonly packageName: string
  readonly destination: string
  /** Supplied behavioral ABI JSON snapshots, validated against visible contracts before cache reuse. */
  readonly foreignInterfaces?: ReadonlyArray<SourceFile.SourceFile>
  /** Ordered, structured native inputs passed after compiler-generated objects. */
  readonly nativeLinkInputs?: ReadonlyArray<NativeLinkInput.NativeLinkInput>
  readonly scopeName?: string
  readonly saveTemps?: boolean
  /** Set false to bypass artifact caches and provided semantic persistence for this request. */
  readonly cache?: boolean
  /** Explicit distribution metadata for embeddings and integrity tests; defaults to this build. */
  readonly distribution?: ToolchainIntegrity.Graph
}

/** A completed compilation with its durable artifact identity and report. */
export interface Compiled {
  readonly stage?: ArtifactPlan.Stage
  readonly artifactPlan?: ArtifactPlan.ArtifactPlan
  readonly nativeBindings?: NativeRequirementBinding.Resolved
  readonly _tag: 'Compiled'
  readonly helpers?: ReadonlyArray<HelperCapability.Report>
  readonly linkPlan?: NativeLinkPlan.NativeLinkPlan
  readonly linkPlanPath?: string
  readonly backend: Backend.Id
  readonly artifactKind: NativeToolchain.FinalArtifact['kind']
  readonly path: string
  readonly target: Target.Target
  readonly symbols: ReadonlyArray<Backend.SymbolEntry>
  readonly foreignImports: ReadonlyArray<Backend.ForeignImport>
  readonly foreignExports: ReadonlyArray<Backend.ForeignExport>
  readonly foreignStatics: ReadonlyArray<Backend.ForeignStatic>
  readonly libraryInterface?: NativeToolchain.LibraryInterfaceArtifacts
  readonly diagnostics: ReadonlyArray<Diagnostic.Diagnostic>
  readonly report: ReadonlyArray<DriverPhaseReport>
  readonly toolchainIdentity: string
  /** Per-test execution identities, present only for a successful discovered-test executable. */
  readonly testManifest?: TestExecution.Manifest
}

/** Target selection stopped compilation before MIR lowering. */
export interface TargetFailed {
  readonly _tag: 'TargetFailed'
  readonly error: Target.TargetError
  readonly diagnostics: ReadonlyArray<Diagnostic.Diagnostic>
  readonly report: ReadonlyArray<DriverPhaseReport>
}

/** Backend capability checks or construction stopped emission. */
export interface BackendFailed {
  readonly _tag: 'BackendFailed'
  readonly error: Backend.BackendError
  readonly diagnostics: ReadonlyArray<Diagnostic.Diagnostic>
  readonly report: ReadonlyArray<DriverPhaseReport>
}

/** An explicitly requested compiler-invariant audit stopped compilation. */
export interface VerificationFailed {
  readonly _tag: 'VerificationFailed'
  readonly error: MirVerification.MirVerificationError
  readonly diagnostics: ReadonlyArray<Diagnostic.Diagnostic>
  readonly report: ReadonlyArray<DriverPhaseReport>
}

/** A missing, malformed, or mismatched compiler distribution stopped compilation. */
export interface ToolchainFailed {
  readonly _tag: 'ToolchainFailed'
  readonly expectedIdentity: string
  readonly observedIdentity: string
  readonly failures: ReadonlyArray<ToolchainIntegrity.IntegrityFailure>
  readonly report: ReadonlyArray<DriverPhaseReport>
}

/** Source diagnostics rejected artifact production after the recoverable frontend completed. */
export interface Rejected {
  readonly _tag: 'Rejected'
  readonly sources: ReadonlyMap<string, SourceFile.SourceFile>
  readonly diagnostics: ReadonlyArray<Diagnostic.Diagnostic>
  readonly report: ReadonlyArray<DriverPhaseReport>
}

/** Imported source storage failed operationally after retaining the available frontend facts. */
export class SourceResolutionFailed extends Data.TaggedError('SourceResolutionFailed')<{
  readonly operation: 'Driver.compile'
  readonly message: string
  readonly failures: ReadonlyArray<SourceResolver.SourceResolverError>
  readonly sources: ReadonlyMap<string, SourceFile.SourceFile>
  readonly diagnostics: ReadonlyArray<Diagnostic.Diagnostic>
  readonly report: ReadonlyArray<DriverPhaseReport>
}> {}

/** The closed outcome of one driver run. */
export type Outcome =
  | Compiled
  | Rejected
  | TargetFailed
  | BackendFailed
  | VerificationFailed
  | ToolchainFailed

const commitLibraryInterface = Effect.fnUntraced(function* (
  request: CompileRequest,
  artifactPath: string,
  artifact: Backend.Artifact,
  target: Target.Target,
): Effect.fn.Return<NativeToolchain.LibraryInterfaceArtifacts, NativeToolchain.ToolchainError> {
  return yield* NativeToolchain.commitLibraryInterface(
    artifactPath,
    request.destination,
    request.packageName,
    CHeader.encode(
      CHeader.make(request.packageName, artifact.foreignExports, artifact.foreignStatics),
    ),
    AbiManifest.encode(
      AbiManifest.make(
        target,
        artifact.foreignImports,
        artifact.foreignExports,
        artifact.foreignStatics,
      ),
    ),
  )
})

/**
 * What backend emission and linking need from a prepared program. The frontend and realization
 * results stay local to {@link prepareEmission}, so they are released before the backend runs.
 */
interface Staged {
  readonly _tag: 'Staged'
  readonly sources: ReadonlyMap<string, SourceFile.SourceFile>
  readonly rootSpan: SourceSpan.SourceSpan | undefined
  readonly profile: Prepared['profile']
  readonly target: Target.Target
  readonly program: Prepared['program']
  readonly diagnostics: ReadonlyArray<Diagnostic.Diagnostic>
  readonly artifactPlan: ArtifactPlan.ArtifactPlan
  /** Link-independent test identities, computed before the large backend emission. */
  readonly tests:
    | {
        readonly runner: { readonly identity: string; readonly complete: boolean }
        readonly closures: TestExecution.Closures | undefined
        readonly bootstrapIdentity: string | undefined
      }
    | undefined
}

type Prepared = Extract<Realization.Preparation, { readonly _tag: 'Prepared' }>

/** Steps 4-8 of {@link compile}: prepare MIR and run every gate that precedes backend emission. */
const prepareEmission = Effect.fnUntraced(function* (
  request: CompileRequest,
  compilation: ModuleClosure.CompilationRequest,
  targetId: string | undefined,
  stage: ArtifactPlan.Stage,
  report: Array<DriverPhaseReport>,
  heapBytes: () => number,
  distribution: ToolchainIntegrity.Graph,
): Effect.fn.Return<
  Outcome | Staged,
  ModuleClosure.ModuleClosureError | SourceResolutionFailed | NativeToolchain.ToolchainError,
  SourceResolver.SourceResolver
> {
  // 4. Load and parse the transitive module closure, resolve declarations and names, elaborate
  // bodies, and analyze semantics and ownership. Retain its diagnostics and per-phase observations.
  const bundle = yield* Preparation.prepare(compilation, 'executable', {
    heapBytes,
    artifactKind: request.artifactKind,
    ...(request.compilation.configuration === undefined || request.optimization === undefined
      ? {}
      : { optimization: request.optimization }),
    emission: true,
  })
  const frontend = bundle.frontend

  report.push(...frontend.report.map(phaseWithHeap))
  const closure = frontend.closure
  // Imported-source storage failures use the typed Effect error channel and retain all available
  // source facts. Ordinary source diagnostics are handled by the preparation gate below.
  if (closure.resolutionFailures.length > 0) {
    return yield* new SourceResolutionFailed({
      operation: 'Driver.compile',
      message: `Source resolution failed for ${closure.resolutionFailures.length} imported module${closure.resolutionFailures.length === 1 ? '' : 's'}`,
      failures: closure.resolutionFailures,
      sources: closure.sources,
      diagnostics: frontend.diagnostics,
      report: [...report],
    })
  }
  // 5. Reject artifact kinds that cannot be produced for this target. Unresolved targets pass
  // to preparation, which returns the corresponding target failure.
  const artifactTarget = Target.select(targetId)
  if (
    artifactTarget._tag === 'Resolved' &&
    !ArtifactKind.supports(request.artifactKind, artifactTarget.target)
  )
    return {
      _tag: 'TargetFailed',
      error: Target.unavailableArtifact(artifactTarget.target, request.artifactKind),
      diagnostics: frontend.diagnostics,
      report: [...report],
    }
  // The sealed bundle already completed target configuration, instance discovery, MIR lowering
  // and demanded storage components; nothing downstream reopens source discovery.
  const preparation = Preparation.preparation(bundle)
  // Preparation carries the frontend report forward. Replace the earlier frontend entries to
  // avoid counting them twice, while retaining the driver's initial distribution-integrity check.
  const integrityReport = report.at(0)
  report.splice(
    0,
    report.length,
    ...(integrityReport === undefined ? [] : [integrityReport]),
    ...preparation.report.map(phaseWithHeap),
  )
  // Stop before emission when source/configuration diagnostics or target selection reject MIR.
  if (preparation._tag === 'Rejected')
    return {
      _tag: 'Rejected',
      sources: closure.sources,
      diagnostics: preparation.diagnostics,
      report: [...report],
    }
  if (preparation._tag === 'TargetFailed')
    return {
      _tag: 'TargetFailed',
      error: preparation.error,
      diagnostics: preparation.diagnostics,
      report: [...report],
    }
  // 6. Build the logical artifact plan from the prepared program, profile, and composition.
  // It records roots, exports, native requirements, and identity for the requested output stage.
  const { diagnostics, program, target } = preparation
  const plannedArtifact = yield* Effect.result(
    ArtifactPlan.make(
      preparation.frontend,
      preparation.profile,
      preparation.composition,
      program,
      stage,
      distribution.digest,
    ),
  )
  // Attach an invalid artifact configuration to the root source span as a user diagnostic.
  // A missing root span is an internal invariant violation rather than a compilation outcome.
  if (Result.isFailure(plannedArtifact)) {
    const span = closure.modules.find((module) => module.name === closure.rootModule)?.syntax.root
      .span
    if (span === undefined) throw new RangeError('Artifact plan lost application source')
    return {
      _tag: 'Rejected',
      sources: closure.sources,
      diagnostics: Diagnostic.merge(diagnostics, [
        Diagnostic.invalidConfiguration(plannedArtifact.failure, span),
      ]),
      report: [...report],
    }
  }
  const artifactPlan = plannedArtifact.success

  // 7. Decode supplied foreign ABI manifests and compare their contracts with the MIR program.
  // Run this before cache lookup so cached code cannot bypass foreign-interface validation.
  const importedInterfaces: Array<AbiManifest.Imported> = []
  const interfaceDiagnostics: Array<Diagnostic.Diagnostic> = []
  for (const source of request.foreignInterfaces ?? []) {
    const decoded = yield* AbiManifest.decode(source).pipe(Effect.result)
    if (Result.isFailure(decoded)) interfaceDiagnostics.push(decoded.failure)
    else importedInterfaces.push(decoded.success)
  }
  // Combine malformed-manifest and contract-mismatch diagnostics, including manifest sources
  // in the rejected outcome so callers can render their diagnostic spans.
  interfaceDiagnostics.push(...AbiManifest.check(importedInterfaces, program))
  if (interfaceDiagnostics.length > 0)
    return {
      _tag: 'Rejected',
      sources: new Map([
        ...closure.sources,
        ...(request.foreignInterfaces ?? []).map((source) => [source.id, source] as const),
      ]),
      diagnostics: [...diagnostics, ...interfaceDiagnostics],
      report: [...report],
    }
  // 8. Verify that the distribution supports the target's demanded intrinsics and runtime.
  // Missing target operations become TargetFailed; inconsistent distribution data becomes
  // ToolchainFailed. Both stop the pipeline before backend code generation.
  const targetIntegrity = PhaseReport.measureInto(
    report,
    'toolchain-target',
    program.intrinsics.length,
    () => ToolchainIntegrity.validateTarget(distribution, target, program.intrinsics),
    (result) => (result._tag === 'Matched' ? result.runtimeSupport.length : 0),
    (result) => (result._tag === 'Invalid' ? result.failures.length : 0),
    { heapBytes },
  )
  if (targetIntegrity._tag === 'UnsupportedTarget')
    return {
      _tag: 'TargetFailed',
      error: Target.unavailableInventory(target, targetIntegrity.operations),
      diagnostics,
      report: [...report],
    }
  if (targetIntegrity._tag === 'Invalid')
    return {
      _tag: 'ToolchainFailed',
      expectedIdentity: ToolchainIntegrity.installed().digest,
      observedIdentity: distribution.digest,
      failures: targetIntegrity.failures,
      report: [...report],
    }
  // Explicit audits run even when a later emission-cache lookup can reuse the artifact.
  if (request.verifyMir === true) {
    const verified = yield* PhaseReport.measureEffectInto(
      report,
      'mir-verification',
      program.functions.length,
      Effect.result(MirVerification.check(program)),
      (result) => (Result.isSuccess(result) ? program.functions.length : 0),
      (result) => (Result.isFailure(result) ? result.failure.violations.length : 0),
      { heapBytes },
    )
    if (Result.isFailure(verified))
      return {
        _tag: 'VerificationFailed',
        error: verified.failure,
        diagnostics,
        report: [...report],
      }
  }
  const testCatalog = frontend.testCatalog
  const bootstrapIdentity = bundle.completion?.bootstrapIdentity
  const tests =
    stage !== 'final' || !Target.isNative(target) || testCatalog === undefined
      ? undefined
      : {
          runner: yield* TestExecution.runnerIdentity(
            preparation.instances,
            frontend.results,
            testCatalog,
          ),
          closures:
            request.artifactKind === 'NativeExecutable' && bootstrapIdentity !== undefined
              ? yield* TestExecution.closures(testCatalog, preparation.instances, frontend.results)
              : undefined,
          bootstrapIdentity,
        }
  return {
    _tag: 'Staged',
    sources: closure.sources,
    rootSpan: closure.modules.find((module) => module.name === closure.rootModule)?.syntax.root
      .span,
    profile: preparation.profile,
    target,
    program,
    diagnostics,
    artifactPlan,
    tests,
  }
})

/** Compiles one request end to end, writing its final artifact to the durable destination. */
export const compile = Effect.fn('Driver.compile')(
  function* (
    request: CompileRequest,
  ): Effect.fn.Return<
    Outcome,
    ModuleClosure.ModuleClosureError | SourceResolutionFailed | NativeToolchain.ToolchainError,
    SourceResolver.SourceResolver | HeapObservation.HeapObservation
  > {
    // 1. Initialize the shared phase report, heap sampler, compiler distribution, and cache location.
    // Measured stages append timings and counts here; each outcome freezes the report so far.
    const report: Array<DriverPhaseReport> = []
    const heapObservation = yield* HeapObservation.HeapObservation
    const heapBytes = heapObservation.heapBytes
    const distribution = request.distribution ?? ToolchainIntegrity.installed()
    const nativeCacheDirectory = yield* Config.String('SILK_NATIVE_CACHE_DIR').pipe(
      Config.withDefault(''),
      Effect.orDie,
    )
    const artifactStorage =
      request.cache === false
        ? undefined
        : (Option.getOrUndefined(yield* Effect.serviceOption(NativeToolchain.ArtifactStorage)) ??
          (yield* NativeToolchain.defaultArtifactStorage(nativeCacheDirectory).pipe(
            Effect.provide(NodeServices.layer),
          )))

    // 2. Validate distribution metadata without checking source files on disk. Source resolution
    // reads the current files when they are needed, so local standard-library edits work directly.
    const frontendIntegrity = yield* PhaseReport.measureEffectInto(
      report,
      'toolchain-integrity',
      distribution.components.length,
      Effect.sync(() => ToolchainIntegrity.validateFrontend(distribution)),
      (result) => (result._tag === 'Matched' ? distribution.components.length : 0),
      (result) => (result._tag === 'Invalid' ? result.failures.length : 0),
      { heapBytes },
    )
    if (frontendIntegrity._tag === 'Invalid')
      return {
        _tag: 'ToolchainFailed',
        expectedIdentity: ToolchainIntegrity.installed().digest,
        observedIdentity: distribution.digest,
        failures: frontendIntegrity.failures,
        report: [...report],
      }

    // 3. Choose the target: an explicit configuration wins over a target ID, then the host default.
    // Host detection is needed only when the caller supplies neither configuration nor target.
    const hostSelection =
      request.compilation.target === undefined && request.compilation.configuration === undefined
        ? NativeToolchain.hostSelection()
        : undefined
    if (hostSelection?._tag === 'Unavailable')
      return {
        _tag: 'TargetFailed',
        error: hostSelection.error,
        diagnostics: [],
        report: [...report],
      }
    const targetId =
      request.compilation.configuration?.profile.target ??
      request.compilation.target ??
      (hostSelection?._tag === 'Resolved' ? hostSelection.target.id : undefined)
    // Turn a bare target selection into a package profile for the frontend. Preserve an explicit
    // configuration; otherwise derive artifact, optimization, and debug settings from the request.
    const compilation: ModuleClosure.CompilationRequest =
      request.compilation.configuration !== undefined || targetId === undefined
        ? request.compilation
        : {
            root: request.compilation.root,
            ...(request.compilation.discovery === undefined
              ? {}
              : { discovery: request.compilation.discovery }),
            configuration: {
              package: `${request.packageName}@0.0.0`,
              profile: {
                target: targetId,
                artifact: ArtifactKind.profileArtifact(request.artifactKind),
                optimization:
                  request.optimization === undefined || request.optimization === 'debug'
                    ? 'none'
                    : 'speed',
                debug: request.optimization !== 'release',
              },
            },
          }

    const stage = request.stage ?? 'final'
    const staged = yield* prepareEmission(
      request,
      compilation,
      targetId,
      stage,
      report,
      heapBytes,
      distribution,
    )
    if (staged._tag !== 'Staged') return staged
    const { program, target, diagnostics, artifactPlan } = staged
    const backend = LlvmBackend.LlvmBackend
    // 9. Look up LLVM emission independently of the final-artifact cache. The key covers the
    // distribution, backend, profile, artifact plan/kind, mode, source closure, and ABI manifests.
    const mode = staged.profile.debug ? 'debug' : 'release'
    const emissionCache = artifactStorage
    const emissionCacheKey =
      emissionCache === undefined
        ? undefined
        : backendEmissionCacheKey(
            distribution.digest,
            backend.id,
            staged.profile.identity,
            artifactPlan.identity,
            request.artifactKind,
            mode,
            staged.sources,
            request.foreignInterfaces ?? [],
          )
    // Missing or undecodable entries are cache misses; a usable entry restores bitcode and metadata.
    const cachedEmission =
      emissionCache !== undefined && emissionCacheKey !== undefined
        ? decodeCachedEmission(
            (yield* NativeToolchain.readArtifactCache(emissionCache, emissionCacheKey)) ??
              new Uint8Array(0),
            target,
          )
        : undefined
    // Reuse cached emission or ask LLVM to emit the prepared MIR, recording which path ran.
    // Pass source bytes for backend source information and convert BackendError to an outcome.
    // Native toolchain resolution only queries installed tools, so it runs during emission.
    const pendingToolchain =
      stage === 'final' && target.kind === 'Native' && request.artifactKind !== 'WebAssemblyModule'
        ? yield* Effect.forkChild(
            Effect.result(NativeToolchain.resolveToolchain(request.toolchain, staged.profile)),
          )
        : undefined
    const emitted =
      cachedEmission !== undefined
        ? PhaseReport.measureInto(
            report,
            'backend-cache',
            program.functions.length,
            () => ({ _tag: 'Emitted' as const, artifact: cachedEmission }),
            (result) => result.artifact.symbols.length,
            () => 0,
            { heapBytes },
          )
        : yield* PhaseReport.measureEffectInto(
            report,
            'backend',
            program.functions.length,
            Backend.emit(backend, program, {
              mode,
              sources: new Map(
                [...staged.sources].map(([module, source]) => [
                  module,
                  SourceFile.toUint8Array(source),
                ]),
              ),
            }).pipe(
              Effect.map((artifact) => ({ _tag: 'Emitted' as const, artifact })),
              Effect.catchTag('BackendError', (error) =>
                Effect.succeed({ _tag: 'Rejected' as const, error }),
              ),
            ),
            (result) => (result._tag === 'Emitted' ? result.artifact.symbols.length : 0),
            () => 0,
            { heapBytes },
          )
    if (emitted._tag === 'Rejected') {
      return {
        _tag: 'BackendFailed',
        error: emitted.error,
        diagnostics,
        report: [...report],
      }
    }
    // Publish newly emitted bitcode to the emission cache when its metadata can be serialized.
    const artifact = emitted.artifact
    if (
      cachedEmission === undefined &&
      emissionCache !== undefined &&
      emissionCacheKey !== undefined &&
      artifact._tag === 'LlvmBitcodeArtifact'
    ) {
      const encoded = encodeCachedEmission(artifact)
      if (encoded !== undefined)
        yield* NativeToolchain.writeArtifactCache(emissionCache, emissionCacheKey, encoded)
    }

    // 10. An intermediate-stage request ends here: write LLVM IR, bitcode, assembly, or an object
    // to the destination inside a temporary build scope, then return its identity and diagnostics.
    // The scope removes temporary files on exit unless saveTemps is enabled.
    if (stage !== 'final') {
      const path = yield* NativeToolchain.withBuildScope(
        request.scopeName ?? 'representation',
        Effect.fnUntraced(function* (scope: NativeToolchain.BuildScope) {
          return yield* NativeToolchain.emitRepresentation(
            request.toolchain,
            scope,
            artifact,
            staged.profile,
            stage,
            request.destination,
          )
        }),
        { saveTemps: request.saveTemps ?? false },
      )
      return {
        _tag: 'Compiled',
        backend: artifact.backend,
        artifactKind: request.artifactKind,
        stage,
        artifactPlan,
        path,
        target,
        symbols: artifact.symbols,
        foreignImports: artifact.foreignImports,
        foreignExports: artifact.foreignExports,
        foreignStatics: artifact.foreignStatics,
        diagnostics,
        report: [...report],
        toolchainIdentity: distribution.digest,
      }
    }
    // 11. For final artifacts, bind the plan's logical native requirements to caller-supplied
    // physical inputs. Report missing or incompatible bindings against the root source span.
    const bound = yield* Effect.result(
      NativeRequirementBinding.resolve(
        artifactPlan.requirements,
        request.nativeBindings ?? [],
        artifactPlan.form,
      ),
    )
    if (Result.isFailure(bound)) {
      const span = staged.rootSpan
      if (span === undefined)
        throw new RangeError('Native requirement binding lost application source')
      return {
        _tag: 'Rejected',
        sources: staged.sources,
        diagnostics: Diagnostic.merge(diagnostics, [
          Diagnostic.invalidConfiguration(bound.failure, span),
        ]),
        report: [...report],
      }
    }
    // Keep caller link-input order, followed by the inputs supplied by resolved requirements.
    const cacheKind = request.artifactKind
    const scopeName = request.scopeName ?? 'driver'
    const requestedNativeInputs = [...(request.nativeLinkInputs ?? []), ...bound.success.inputs]
    const nativeLinkInputs = requestedNativeInputs
    // A missing request input is linker data, not a cache-key storage failure.
    if (cacheKind !== 'WebAssemblyModule' && nativeLinkInputs.length > 0)
      yield* NativeToolchain.requireLinkInputs(
        request.toolchain,
        cacheKind,
        target,
        [],
        nativeLinkInputs,
        request.destination,
      )
    // 12. Try final WebAssembly artifact reuse using bitcode, profile, toolchain, and runtime source.
    // Native artifacts need a complete physical link plan, so their final-cache lookup happens later.
    const cacheAdmission = NativeToolchain.finalArtifactCacheAdmission(cacheKind)
    const finalArtifactStorage =
      cacheAdmission._tag !== 'Ineligible' &&
      request.cache !== false &&
      artifact._tag === 'LlvmBitcodeArtifact'
        ? artifactStorage
        : undefined
    const runtimeSource = NativeToolchain.artifactRuntimeSource(
      cacheKind,
      artifact.nativeRuntimeSymbols,
    )
    const cacheKey =
      finalArtifactStorage !== undefined && artifact._tag === 'LlvmBitcodeArtifact'
        ? yield* NativeToolchain.wasmArtifactCacheKey(
            request.toolchain,
            staged.profile,
            artifact.bitcode,
            runtimeSource,
          )
        : undefined
    if (
      finalArtifactStorage !== undefined &&
      cacheKey !== undefined &&
      artifact._tag === 'LlvmBitcodeArtifact'
    ) {
      // Validate cached bytes for the requested artifact kind and target before committing them
      // to the durable destination. A miss continues to the build scope below.
      const bytes = yield* NativeToolchain.readArtifactCache(finalArtifactStorage, cacheKey)
      if (bytes !== undefined && NativeToolchain.isCachedArtifact(bytes, cacheKind, target)) {
        const committed = yield* PhaseReport.measureEffectInto(
          report,
          'artifact-cache',
          1,
          NativeToolchain.commitCachedArtifact(bytes, cacheKind, target, request.destination),
          () => 1,
          () => 0,
          { heapBytes },
        )
        // Publish C header and ABI metadata when the restored artifact kind requires an interface.
        const libraryInterface =
          ArtifactKind.isLibrary(cacheKind) || cacheKind === 'NativeObject'
            ? yield* PhaseReport.measureEffectInto(
                report,
                'library-interface',
                artifact.foreignImports.length +
                  artifact.foreignExports.length +
                  artifact.foreignStatics.length,
                commitLibraryInterface(request, committed.path, artifact, target),
                () => 2,
                () => 0,
                { heapBytes },
              )
            : undefined
        return {
          _tag: 'Compiled' as const,
          stage,
          artifactPlan,
          nativeBindings: bound.success,
          backend: artifact.backend,
          artifactKind: committed.kind,
          path: committed.path,
          target: committed.target,
          symbols: artifact.symbols,
          foreignImports: artifact.foreignImports,
          foreignExports: artifact.foreignExports,
          foreignStatics: artifact.foreignStatics,
          ...(libraryInterface === undefined ? {} : { libraryInterface }),
          diagnostics,
          report: [...report],
          toolchainIdentity: distribution.digest,
        }
      }
    }

    // 13. Build a final artifact on a cache miss. All temporary products live in this scope;
    // successful outputs are committed to the destination before scope cleanup runs.
    return yield* NativeToolchain.withBuildScope(
      scopeName,
      (scope) =>
        Effect.gen(function* () {
          // WebAssembly branch: finalize the emitted bitcode with the selected profile and runtime
          // support, commit the module, and cache its bytes when final-artifact caching is enabled.
          if (!Target.isNative(target)) {
            const finalized = yield* PhaseReport.measureEffectInto(
              report,
              'wasm-finalize',
              1,
              NativeToolchain.finalizeWasm(
                request.toolchain,
                scope,
                artifact,
                staged.profile,
                request.destination,
              ),
              () => 1,
              () => 0,
              { heapBytes },
            )
            if (finalArtifactStorage !== undefined && cacheKey !== undefined) {
              yield* NativeToolchain.writeArtifactCache(
                finalArtifactStorage,
                cacheKey,
                finalized.bytes,
              )
            }
            return {
              _tag: 'Compiled' as const,
              stage,
              artifactPlan,
              nativeBindings: bound.success,
              backend: artifact.backend,
              artifactKind: finalized.kind,
              ...(finalized.helpers === undefined ? {} : { helpers: [finalized.helpers] }),
              path: finalized.path,
              target: finalized.target,
              symbols: artifact.symbols,
              foreignImports: artifact.foreignImports,
              foreignExports: artifact.foreignExports,
              foreignStatics: artifact.foreignStatics,
              diagnostics,
              report: [...report],
              toolchainIdentity: distribution.digest,
            }
          }

          // Native branch: guard against a WebAssembly artifact request reaching native emission.
          if (cacheKind === 'WebAssemblyModule')
            return {
              _tag: 'TargetFailed' as const,
              error: Target.unavailableArtifact(target, cacheKind),
              diagnostics,
              report: [...report],
            }

          // Test identities were computed before emission so discovery and elaboration results
          // are no longer retained while the backend builds the LLVM module.
          const tests = staged.tests

          // 14. Resolve the native toolchain for the profile and turn LLVM bitcode into an object.
          // Track both generated object files and any helper capabilities reported by emission.
          const toolchain =
            pendingToolchain === undefined
              ? yield* NativeToolchain.resolveToolchain(request.toolchain, staged.profile)
              : yield* Effect.fromResult(yield* Fiber.join(pendingToolchain))
          const object = yield* PhaseReport.measureEffectInto(
            report,
            'object',
            1,
            ObjectEmission.materialize({
              toolchain,
              scope,
              artifact,
              profile: staged.profile,
            }),
            () => 1,
            () => 0,
            { heapBytes },
          )
          const generatedObjects: Array<NativeToolchain.PathArtifact> = [object.artifact]
          const helpers = object.helpers === undefined ? [] : [object.helpers]
          // Executables and shared libraries need helper implementations at this link step.
          // Compile those helpers and include their required native libraries in the link inputs.
          const final = cacheKind === 'NativeExecutable' || cacheKind === 'NativeSharedLibrary'
          if (final && object.helpers !== undefined) {
            const support = yield* NativeToolchain.compileHelpers(
              toolchain,
              scope,
              staged.profile,
              object.helpers,
            )
            generatedObjects.push(...support.map((entry) => entry.artifact))
            helpers.push(
              ...support.flatMap((entry) => (entry.helpers === undefined ? [] : [entry.helpers])),
            )
          }
          const selectedNativeInputs = final
            ? [...nativeLinkInputs, ...HelperCapability.linkInputs(helpers)]
            : nativeLinkInputs

          // Add the Silk native runtime object only when the emitted program references it.
          if (artifact.nativeRuntimeSymbols.length > 0) {
            const runtime = yield* PhaseReport.measureEffectInto(
              report,
              'runtime',
              1,
              NativeToolchain.compileRuntime(toolchain, scope, target),
              () => 1,
              () => 0,
              { heapBytes },
            )
            generatedObjects.push(runtime.artifact)
          }
          // A standalone object with no additional objects or inputs needs no linker invocation.
          // Commit it directly, publish its C header/ABI manifest, and return the completed result.
          if (
            cacheKind === 'NativeObject' &&
            generatedObjects.length === 1 &&
            nativeLinkInputs.length === 0
          ) {
            const path = yield* NativeToolchain.commitPathRepresentation(
              object.artifact,
              request.destination,
            )
            const libraryInterface = yield* commitLibraryInterface(request, path, artifact, target)
            return {
              _tag: 'Compiled' as const,
              backend: artifact.backend,
              artifactKind: cacheKind,
              stage,
              artifactPlan,
              nativeBindings: bound.success,
              helpers,
              path,
              target,
              symbols: artifact.symbols,
              foreignImports: artifact.foreignImports,
              foreignExports: artifact.foreignExports,
              foreignStatics: artifact.foreignStatics,
              libraryInterface,
              diagnostics,
              report: [...report],
              toolchainIdentity: distribution.digest,
            }
          }
          // 15. Build the complete native link/archive plan, including generated objects, supplied
          // inputs, loader selection, and helpers. Its identity determines final native cache reuse.
          const linkPlan = yield* NativeToolchain.planNativeLink(
            toolchain,
            scope,
            cacheKind,
            staged.profile,
            generatedObjects,
            selectedNativeInputs,
            request.destination,
            artifactPlan.composition.loader,
            helpers,
          )
          const nativeAdmission = NativeToolchain.finalArtifactCacheAdmission(cacheKind, linkPlan)
          const nativeStorage =
            request.cache === false || nativeAdmission._tag !== 'CompleteNativePlan'
              ? undefined
              : artifactStorage
          const nativeKey = `native-${linkPlan.identity}.blob`
          // Linking owns physical-plan validation and optional final-artifact reuse. Helper/runtime
          // preparation stays outside it and remains scoped by this caller-owned build lifetime.
          const measuredLink = yield* PhaseReport.measureEffect(
            'link',
            2,
            Linker.link({
              scope,
              plan: linkPlan,
              artifactKind: cacheKind,
              destination: request.destination,
              cache:
                nativeStorage === undefined
                  ? { _tag: 'Disabled' }
                  : { _tag: 'ReadWrite', store: nativeStorage, key: nativeKey },
            }),
            () => 1,
            () => 0,
            { heapBytes },
          )
          report.push(
            phaseWithHeap({
              ...measuredLink.report,
              phase: measuredLink.value.metadata.reused ? 'artifact-cache' : 'link',
            }),
          )
          const linkedResult = measuredLink.value
          const linked = linkedResult.artifact
          // Publish the inspectable link plan beside the artifact.
          const linkPlanPath = yield* NativeToolchain.commitLinkPlan(
            linkPlan,
            `${request.destination}.link.json`,
          )
          // Libraries and native objects also publish a C header and behavioral ABI manifest.
          const libraryInterface =
            ArtifactKind.isLibrary(cacheKind) || cacheKind === 'NativeObject'
              ? yield* PhaseReport.measureEffectInto(
                  report,
                  'library-interface',
                  artifact.foreignImports.length +
                    artifact.foreignExports.length +
                    artifact.foreignStatics.length,
                  commitLibraryInterface(request, linked.path, artifact, target),
                  () => 2,
                  () => 0,
                  { heapBytes },
                )
              : undefined
          const testManifest =
            tests?.closures !== undefined && tests.bootstrapIdentity !== undefined
              ? TestExecution.make(tests.closures, {
                  profileIdentity: staged.profile.identity,
                  bootstrapIdentity: tests.bootstrapIdentity,
                  runnerIdentity: tests.runner.identity,
                  compilerIdentity: distribution.digest,
                  runtimeIdentity: TestExecution.runtimeIdentity(distribution),
                  nativeIdentity: TestExecution.nativeIdentity(
                    linkPlan,
                    generatedObjects.map((entry) => entry.path),
                    bound.success.identity,
                    HelperCapability.policyIdentity(staged.profile),
                  ),
                  complete: tests.runner.complete,
                })
              : undefined
          // Return the durable artifact together with linkage provenance, foreign symbols,
          // diagnostics, and the complete phase report. Exiting this scope releases temporary files.
          return {
            _tag: 'Compiled' as const,
            linkPlan,
            helpers,
            linkPlanPath,
            stage,
            artifactPlan,
            nativeBindings: bound.success,
            backend: artifact.backend,
            artifactKind: linked.kind,
            path: linked.path,
            target: linked.target,
            symbols: artifact.symbols,
            foreignImports: artifact.foreignImports,
            foreignExports: artifact.foreignExports,
            foreignStatics: artifact.foreignStatics,
            ...(libraryInterface === undefined ? {} : { libraryInterface }),
            ...(testManifest === undefined ? {} : { testManifest }),
            diagnostics,
            report: [...report],
            toolchainIdentity: distribution.digest,
          }
        }),
      { saveTemps: request.saveTemps ?? false },
    )
  },
  // A disabled request sees no cache capability at all, nested helper compiles included.
  (effect, request) =>
    request.cache === false
      ? // Both are optional services, so removing them leaves the requirements unchanged.
        (Effect.updateContext(
          effect,
          Context.omit(SemanticPersistence.SemanticPersistence, NativeToolchain.ArtifactStorage),
        ) as typeof effect)
      : effect,
)
