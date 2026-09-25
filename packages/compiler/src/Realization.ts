import * as CompilerTrace from './CompilerTrace.js'
import * as NativeAssemblyPlanning from './NativeAssemblyPlanning.js'
import type * as ArtifactPlan from './ArtifactPlan.js'
import * as ArtifactComposition from './ArtifactComposition.js'
import type * as ModuleClosure from './ModuleClosure.js'
import * as ModuleSelection from './ModuleSelection.js'
import * as Location from './Location.js'
import * as SemanticContext from './SemanticContext.js'
import * as Effect from 'effect/Effect'
import * as Result from 'effect/Result'
import * as CompilationProfile from './CompilationProfile.js'
import * as ConfigurationError from './ConfigurationError.js'
import * as ProfileBootstrap from './ProfileBootstrap.js'
import type * as DeclarationIndex from './DeclarationIndex.js'
import type * as Elaboration from './Elaboration.js'
import type * as NameResolution from './NameResolution.js'
import type * as TestDiscovery from './TestDiscovery.js'

/**
 * Every diagnostic family judged against reachable concrete instances, collected once so that
 * `realize` and `prepare` cannot drift apart on which checks a specialized program must pass.
 */
const instanceViolationDiagnostics = (
  self: Frontend,
  discovery: Instances.Discovery,
  registry: SemanticContext.Registry,
): ReadonlyArray<Diagnostic.Diagnostic> => {
  return Diagnostic.merge(
    InstanceDiagnostics.violationDiagnostics(discovery, registry),
    InstanceDiagnostics.copyDropViolations(discovery, self.index, registry),
    InstanceDiagnostics.requirementBindingViolations(discovery, self.index),
    InstanceDiagnostics.unlowerableWitnessViolations(discovery, self.index),
    InstanceDiagnostics.storedExecutableViolations(discovery, self.index),
    ExecutableProperty.violationDiagnostics(discovery, self.index, registry),
    DiagnosticObservation.violationDiagnostics(discovery),
  )
}

/** Explicit immutable inputs for constructing the reachable concrete instance graph. */
export interface InstantiationInput {
  readonly rootModule: string
  readonly results: ReadonlyMap<string, Elaboration.Result>
  readonly index: DeclarationIndex.Index
  readonly completion: ProfileBootstrap.Completion
  readonly resolution: NameResolution.Resolution
  readonly composition: ArtifactComposition.Resolved
  readonly testCatalog?: TestDiscovery.Catalog
}

const instantiateWithTrace = (
  input: InstantiationInput,
  trace: CompilerTrace.CompilerTrace,
): Instances.Discovery => {
  const registry = SemanticContext.fromModules(input.results.values())
  return Instances.discover(
    input.rootModule,
    input.results,
    input.index,
    registry,
    input.completion,
    input.resolution,
    input.composition,
    trace,
    input.testCatalog,
  )
}

/** Constructs the portable reachable instance graph without retaining a frontend or presentation registry. */
export const instantiate = Effect.fn('Realization.instantiate')(function* (
  input: InstantiationInput,
): Effect.fn.Return<Instances.Discovery> {
  const trace = yield* CompilerTrace.capture()
  return instantiateWithTrace(input, trace)
})

/** Rejects a pointer-sized exported static that cannot be represented on the selected target. */
const foreignStaticTargetDiagnostics = (
  index: DeclarationIndex.Index,
  target: Target.Target,
  registry: SemanticContext.Registry,
): ReadonlyArray<Diagnostic.Diagnostic> =>
  index.modules.flatMap((module) =>
    module.members.flatMap((member): ReadonlyArray<Diagnostic.Diagnostic> => {
      if (
        member._tag !== 'ForeignStaticDeclaration' ||
        member.direction !== 'Export' ||
        member.declaredType._tag !== 'Resolved' ||
        member.literal?._tag !== 'IntegerLiteral'
      )
        return []
      const scalar =
        typeof member.declaredType.type === 'string'
          ? Scalar.find(member.declaredType.type)
          : undefined
      if (scalar?.spelling !== 'usize' && scalar?.spelling !== 'isize') return []
      const range = Scalar.range(scalar, target.pointerSize === 4 ? 32 : 64)
      if (member.literal.value >= range.minimum && member.literal.value <= range.maximum) return []
      return [
        Diagnostic.invalidConstant(
          `the exported C static initializer is outside ${scalar.spelling} on ${target.id}`,
          registry.spanOf(member.initializer?.anchor ?? member.anchor),
        ),
      ]
    }),
  )

const discoverInstances = Effect.fn('Realization.discoverInstances')(function* (
  self: Frontend,
  targetSelection: Target.Selection,
  completion: ProfileBootstrap.Completion | undefined,
  specializationInvalid: boolean,
  prepareForEmission: boolean,
  report: Array<PhaseReport.PhaseReport>,
  options: Options,
) {
  const trace = yield* CompilerTrace.capture()
  const instances = PhaseReport.measureInto(
    report,
    'instance-discovery',
    self.results.size,
    () =>
      targetSelection._tag === 'Unavailable' ||
      completion === undefined ||
      self.composition === undefined ||
      (!prepareForEmission && specializationInvalid)
        ? Instances.invalid(self.closure.rootModule)
        : instantiateWithTrace(
            {
              rootModule: self.closure.rootModule,
              results: self.results,
              index: self.index,
              completion,
              resolution: self.resolution,
              composition: self.composition,
              ...(self.testCatalog === undefined ? {} : { testCatalog: self.testCatalog }),
            },
            trace,
          ),
    (value) => value.instances.length,
    (value) => value.violations.length,
    { ...options, counters: (value) => value.counters },
  )
  yield* Effect.annotateCurrentSpan({
    'modules.count': self.results.size,
    'instances.count': instances.instances.length,
    'violations.count': instances.violations.length,
    ...instances.counters,
  })
  return instances
})

const collectInstanceDiagnostics = Effect.fn('Realization.collectInstanceDiagnostics')(
  (
    self: Frontend,
    instances: Instances.Discovery,
    foreignStaticDiagnostics: ReadonlyArray<Diagnostic.Diagnostic>,
    registry: SemanticContext.Registry,
  ) =>
    Effect.sync(() => {
      const declarationDiagnosticKeys = new Set(
        self.diagnostics.map(
          (diagnostic) =>
            `${diagnostic.phase}\u0000${diagnostic.code}\u0000${diagnostic.span.sourceId}\u0000${diagnostic.span.start}\u0000${diagnostic.span.end}`,
        ),
      )
      const residualizationDiagnostics = instances.residualizationDiagnostics.filter(
        (diagnostic) =>
          !declarationDiagnosticKeys.has(
            `${diagnostic.phase}\u0000${diagnostic.code}\u0000${diagnostic.span.sourceId}\u0000${diagnostic.span.start}\u0000${diagnostic.span.end}`,
          ),
      )
      return Diagnostic.merge(
        self.diagnostics,
        residualizationDiagnostics,
        instanceViolationDiagnostics(self, instances, registry),
        foreignStaticDiagnostics,
      )
    }),
)

const buildTargetLayout = Effect.fn('Realization.buildTargetLayout')(function* (
  self: Frontend,
  index: DeclarationIndex.Index,
  instances: Instances.Discovery,
  targetSelection: Target.Selection,
  analysisUnavailable: AnalysisUnavailable | undefined,
  prepareForEmission: boolean,
  registry: SemanticContext.Registry,
) {
  const selection = targetSelection
  if (selection._tag === 'Unavailable')
    return { _tag: 'Unavailable' as const, selection, error: selection.error }
  if (prepareForEmission) {
    const availability = IntrinsicAvailability.select(instances.intrinsics, selection.target)
    if (availability._tag === 'Unavailable')
      return {
        _tag: 'IntrinsicUnavailable' as const,
        selection,
        error: Target.unavailableInventory(selection.target, availability.operations),
      }
  }
  if (analysisUnavailable !== undefined)
    return {
      _tag: 'AnalysisUnavailable' as const,
      selection,
      error: analysisUnavailable,
    }
  const opaqueRealizations = OpaqueRealization.catalogOf(self)
  const catalog = yield* Layout.computeTypes(selection.target, index, registry, opaqueRealizations)
  return {
    _tag: 'Available' as const,
    selection,
    target: selection.target,
    catalog,
    layout: yield* Layout.computeRuntime(catalog, instances, index, opaqueRealizations),
  }
})

export type MirAdmission =
  | { readonly _tag: 'Admitted' }
  | { readonly _tag: 'Rejected'; readonly diagnostics: ReadonlyArray<Diagnostic.Diagnostic> }

/** Explicit artifact inputs and policy for one MIR lowering request. */
export interface MirLoweringInput {
  readonly instances: Instances.Discovery
  readonly layout: Layout.Plan
  readonly index: DeclarationIndex.Index
  readonly opaqueRealizations: OpaqueRealization.Catalog
  readonly profile?: CompilationProfile.CompilationProfile
  readonly presentation: SemanticContext.Registry
  readonly admission: MirAdmission
  readonly normalization: 'Normalize' | 'Preserve'
  readonly audit: 'None' | 'ForeignPlanning'
}

export interface MirLoweringResult {
  readonly program: Mir.Module | undefined
  readonly diagnostics: ReadonlyArray<Diagnostic.Diagnostic>
}

/** Lowers admitted instance/layout artifacts to MIR with optional target planning audit. */
export const lowerMir = Effect.fn('Mir.lower')(function* (
  input: MirLoweringInput,
): Effect.fn.Return<MirLoweringResult> {
  if (input.admission._tag === 'Rejected')
    return { program: undefined, diagnostics: input.admission.diagnostics }
  const program = yield* lowerProgram(
    input.instances,
    input.layout,
    input.index,
    input.opaqueRealizations,
    input.presentation,
  )
  const provisional = yield* buildProvisionalMir(input.instances, input.layout, input.index)
  const finalized = yield* finalizeMir(
    program,
    provisional,
    input.index,
    input.opaqueRealizations,
    input.profile,
    input.normalization,
  )
  if (finalized.program === undefined || input.audit === 'None') return finalized
  const audit = yield* checkForeignPlanning(finalized.program, input.layout.target)
  return {
    program: audit.length === 0 ? finalized.program : undefined,
    diagnostics: Diagnostic.merge(finalized.diagnostics, audit),
  }
})

const lowerProgram = Effect.fn('Realization.lowerProgram')(function* (
  instances: Instances.Discovery,
  layout: Layout.Plan,
  index: DeclarationIndex.Index,
  opaqueRealizations: OpaqueRealization.Catalog,
  registry: SemanticContext.Registry,
) {
  const trace = yield* CompilerTrace.capture()
  return Lower.lowerProgram(instances, layout, index, opaqueRealizations, registry, trace)
})

const buildProvisionalMir = Effect.fn('Realization.buildProvisionalMir')(
  (instances: Instances.Discovery, layout: Layout.Plan, index: DeclarationIndex.Index) =>
    Effect.sync(() => ProvisionalMir.build(instances, layout, index)),
)

const checkForeignPlanning = Effect.fn('Realization.checkForeignPlanning')(
  (program: Mir.Module, target: Target.Target) =>
    Effect.sync(() => ForeignPlanning.check(program, target)),
)

export function discoverAndLower(
  self: Frontend,
  targetId: string | undefined,
  completion: ProfileBootstrap.Completion | undefined,
  options: Options & {
    readonly artifactKind?: ArtifactKind.ArtifactKind
    readonly optimization?: 'debug' | 'release' | 'release-with-debug'
  },
): Effect.Effect<Realization>
export function discoverAndLower(
  self: Frontend,
  targetId: string | undefined,
  completion: ProfileBootstrap.Completion | undefined,
  options: Options & {
    readonly artifactKind?: ArtifactKind.ArtifactKind
    readonly optimization?: 'debug' | 'release' | 'release-with-debug'
  },
  prepareForEmission: true,
): Effect.Effect<Preparation>
export function discoverAndLower(
  self: Frontend,
  targetId: string | undefined,
  completion: ProfileBootstrap.Completion | undefined,
  options: Options & {
    readonly artifactKind?: ArtifactKind.ArtifactKind
    readonly optimization?: 'debug' | 'release' | 'release-with-debug'
  },
  prepareForEmission = false,
): Effect.Effect<Realization | Preparation> {
  return discoverAndLowerEffect(self, targetId, completion, options, prepareForEmission)
}

const discoverAndLowerEffect = Effect.fn('Realization.discoverAndLower')(function* (
  self: Frontend,
  targetId: string | undefined,
  completion: ProfileBootstrap.Completion | undefined,
  options: Options,
  prepareForEmission: boolean,
): Effect.fn.Return<Realization | Preparation> {
  yield* Effect.annotateCurrentSpan({
    'root.module': self.closure.rootModule,
    'realization.mode': prepareForEmission ? 'prepare' : 'analyze',
    'mir.normalize': options.normalizeMir !== false,
  })
  const registry = SemanticContext.fromModules(self.closure.modules)
  const report = [...self.report]
  if (prepareForEmission && Diagnostic.hasErrors(self.diagnostics))
    return {
      _tag: 'Rejected',
      diagnostics: self.diagnostics,
      report: report,
    }

  const specializationInvalid =
    Diagnostic.hasGenericSpecializationErrors(self.diagnostics) ||
    hasInvalidGenericBody(self.index, self.diagnostics, registry)
  // Static specialization is target-relative. Resolve the closed target before constructing any
  // executable worklist so no candidate body can observe a missing or host-inferred target.
  const targetSelection = Target.select(targetId)
  const foreignStaticDiagnostics =
    targetSelection._tag === 'Resolved'
      ? foreignStaticTargetDiagnostics(self.index, targetSelection.target, registry)
      : []
  const instances = yield* discoverInstances(
    self,
    targetSelection,
    completion,
    specializationInvalid,
    prepareForEmission,
    report,
    options,
  )
  const realizedIndex: DeclarationIndex.Index = {
    ...self.index,
    generatedAggregates: instances.generatedAggregates,
  }
  const baseDiagnostics = yield* collectInstanceDiagnostics(
    self,
    instances,
    foreignStaticDiagnostics,
    registry,
  )
  if (prepareForEmission && Diagnostic.hasErrors(baseDiagnostics))
    return {
      _tag: 'Rejected',
      diagnostics: baseDiagnostics,
      report: report,
    }
  const foreignDiagnostics =
    !prepareForEmission || targetSelection._tag === 'Unavailable'
      ? []
      : ForeignAvailability.select(instances.foreignCalls, targetSelection.target)
  if (foreignDiagnostics.length > 0)
    return {
      _tag: 'Rejected',
      diagnostics: Diagnostic.merge(baseDiagnostics, foreignDiagnostics),
      report: report,
    }
  const analysisUnavailable = (() => {
    if (prepareForEmission) return undefined
    if (Diagnostic.hasErrors(foreignStaticDiagnostics))
      return new AnalysisUnavailable({
        operation: 'Analysis.realize',
        message:
          'Target-dependent phases are unavailable because an exported C static initializer exceeds the selected target',
      })
    if (specializationInvalid || Diagnostic.hasGenericSpecializationErrors(baseDiagnostics))
      return new AnalysisUnavailable({
        operation: 'Analysis.realize',
        message: 'Target-dependent phases are unavailable for invalid source specialization',
      })
    if (Diagnostic.hasReturnContractErrors(baseDiagnostics))
      return new AnalysisUnavailable({
        operation: 'Analysis.realize',
        message: 'Target-dependent phases are unavailable for an invalid return contract',
      })
    if (Diagnostic.hasInstanceFenceErrors(baseDiagnostics))
      return new AnalysisUnavailable({
        operation: 'Analysis.realize',
        message:
          'Target-dependent phases are unavailable while a reachable construction stores an unsupported executable representation',
      })
    return undefined
  })()

  const targetLayout = yield* PhaseReport.measureEffectInto(
    report,
    'target-layout',
    instances.instances.length,
    buildTargetLayout(
      self,
      realizedIndex,
      instances,
      targetSelection,
      analysisUnavailable,
      prepareForEmission,
      registry,
    ),
    (value) => (value._tag === 'Available' ? value.layout.entries.length : 0),
    (value) => (value._tag === 'Available' ? value.layout.diagnostics.length : 0),
    options,
  )

  if (targetLayout._tag === 'IntrinsicUnavailable')
    return {
      _tag: 'TargetFailed',
      error: targetLayout.error,
      diagnostics: baseDiagnostics,
      report: report,
    }
  if (prepareForEmission && targetLayout._tag === 'Unavailable')
    return {
      _tag: 'TargetFailed',
      error: targetLayout.error,
      diagnostics: baseDiagnostics,
      report: report,
    }
  const diagnostics = Diagnostic.merge(
    baseDiagnostics,
    ...(targetLayout._tag === 'Available' ? [targetLayout.layout.diagnostics] : []),
  )
  if (
    prepareForEmission &&
    targetLayout._tag === 'Available' &&
    Diagnostic.hasErrors(targetLayout.layout.diagnostics)
  )
    return {
      _tag: 'Rejected',
      diagnostics,
      report: report,
    }

  const targetLiteralError =
    !prepareForEmission &&
    targetLayout._tag === 'Available' &&
    Diagnostic.hasErrors(targetLayout.layout.diagnostics)
      ? new AnalysisUnavailable({
          operation: 'Analysis.realize',
          message: 'MIR is unavailable because a usize literal exceeds the selected target',
        })
      : undefined
  const residualizationError = Diagnostic.hasErrors(instances.residualizationDiagnostics)
    ? new AnalysisUnavailable({
        operation: 'Analysis.realize',
        message: 'MIR is unavailable after failed source residualization',
      })
    : undefined
  // Source diagnostics are the recovery result for an invalid program. Keep declaration,
  // instance, and layout facts queryable, but do not demand executable runners from invalid TIR.
  // Valid programs still pass through the complete lowering and verification boundary below.
  const sourceDiagnosticError = Diagnostic.hasErrors(diagnostics)
    ? new AnalysisUnavailable({
        operation: 'Analysis.realize',
        message: 'MIR is unavailable for a program with source diagnostics',
      })
    : undefined
  const finalized =
    targetLayout._tag === 'Available' &&
    targetLiteralError === undefined &&
    residualizationError === undefined &&
    sourceDiagnosticError === undefined
      ? yield* PhaseReport.measureEffectInto(
          report,
          'mir-lowering',
          instances.instances.length,
          Mir.lower({
            instances,
            layout: targetLayout.layout,
            index: realizedIndex,
            opaqueRealizations: OpaqueRealization.catalogOf(self),
            ...(completion === undefined ? {} : { profile: completion.profile }),
            presentation: registry,
            admission: { _tag: 'Admitted' },
            normalization: options.normalizeMir === false ? 'Preserve' : 'Normalize',
            audit: prepareForEmission ? 'ForeignPlanning' : 'None',
          }),
          (value) => value.program?.functions.length ?? 0,
          (value) => value.diagnostics.length,
          options,
        )
      : undefined
  const program = finalized?.program
  const finalizedDiagnostics = Diagnostic.merge(diagnostics, finalized?.diagnostics ?? [])

  if (prepareForEmission) {
    if (Diagnostic.hasErrors(finalizedDiagnostics))
      return {
        _tag: 'Rejected',
        diagnostics: finalizedDiagnostics,
        report: report,
      }
    if (
      targetLayout._tag !== 'Available' ||
      program === undefined ||
      completion === undefined ||
      self.composition === undefined
    )
      throw new RangeError('Driver lowering reached an unavailable target after its gates')
    return {
      _tag: 'Prepared',
      frontend: self,
      composition: self.composition,
      profile: completion.profile,
      instances,
      target: targetLayout.target,
      program,
      diagnostics: finalizedDiagnostics,
      report: report,
    }
  }

  const unavailable =
    targetLayout._tag === 'Unavailable' || targetLayout._tag === 'AnalysisUnavailable'
      ? targetLayout.error
      : undefined
  return {
    instances,
    ...(self.composition === undefined ? {} : { composition: self.composition }),
    ...(completion === undefined ? {} : { profile: completion.profile }),
    target: targetLayout.selection,
    layoutCatalog:
      targetLayout._tag === 'Available'
        ? { _tag: 'Available', value: targetLayout.catalog }
        : { _tag: 'Unavailable', error: targetLayout.error },
    layout:
      targetLayout._tag === 'Available'
        ? { _tag: 'Available', value: targetLayout.layout }
        : { _tag: 'Unavailable', error: targetLayout.error },
    mir:
      program !== undefined
        ? { _tag: 'Available', value: program }
        : {
            _tag: 'Unavailable',
            error:
              targetLiteralError ??
              residualizationError ??
              sourceDiagnosticError ??
              unavailable ??
              new AnalysisUnavailable({
                operation: 'Analysis.realize',
                message: 'MIR is unavailable',
              }),
          },
    diagnostics: finalizedDiagnostics,
    report: [...report],
  }
})

/** Completes configuration without performing runtime specialization, shared with project tooling. */
export const configure = Effect.fn('Realization.configure')(function* (
  self: Frontend,
  targetId: string | undefined,
  artifactKind?: ArtifactKind.ArtifactKind,
  optimization?: 'debug' | 'release' | 'release-with-debug',
  override?: ModuleClosure.CompilationRequest['configuration'],
): Effect.fn.Return<{
  readonly frontend: Frontend
  readonly completion?: ProfileBootstrap.Completion
  readonly targetId: string | undefined
}> {
  const configuration = override ?? self.configuration
  const selectedTarget = configuration?.profile.target ?? targetId
  if (Target.select(selectedTarget)._tag === 'Unavailable' || selectedTarget === undefined)
    return { frontend: self, targetId: selectedTarget }
  const operation = Effect.gen(function* () {
    if (
      configuration !== undefined &&
      ((override === undefined && self.requestedTarget !== undefined) || optimization !== undefined)
    )
      return yield* ConfigurationError.make(
        'Realization.bootstrap',
        'ConflictingBindings',
        'target and complete profile selection',
      )
    const artifact =
      artifactKind === undefined ? undefined : ArtifactKind.profileArtifact(artifactKind)
    if (override === undefined && self.configurationError !== undefined)
      return yield* self.configurationError
    const initial =
      override === undefined &&
      self.initialProfile !== undefined &&
      self.initialProfile.target.id === selectedTarget &&
      artifactKind === undefined &&
      optimization === undefined
        ? self.initialProfile
        : yield* CompilationProfile.normalize(
            configuration?.profile ?? {
              target: selectedTarget,
              ...(artifact === undefined ? {} : { artifact }),
              ...(optimization === undefined
                ? {}
                : {
                    optimization: optimization === 'debug' ? 'none' : 'speed',
                    debug: optimization !== 'release',
                  }),
            },
          )
    if (artifact !== undefined && initial.artifact !== artifact)
      return yield* ConfigurationError.make(
        'Realization.bootstrap',
        'UnsupportedCombination',
        'profile artifact and output request',
      )
    const explicitModules = configuration?.modules ?? []
    for (const owner of explicitModules) {
      if (!self.closure.modules.some((module) => module.name === owner.canonical))
        return yield* ConfigurationError.make(
          'Realization.bootstrap',
          'PackageIdentityConflict',
          'unknown module ownership',
        )
    }
    const modules = self.closure.modules.flatMap((module) => {
      const owners = explicitModules.filter((candidate) => candidate.canonical === module.name)
      if (owners.length > 0)
        return owners.map((owner) => ({
          ...owner,
          bytes: module.syntax.source.bytes,
        }))
      const packageName =
        module.syntax.source.origin._tag === 'ToolchainFile' ? 'silk@0.0.0' : configuration?.package
      return packageName === undefined
        ? []
        : [
            {
              canonical: module.name,
              package: packageName,
              module: module.name,
              bytes: module.syntax.source.bytes,
            },
          ]
    })
    const completion = yield* ProfileBootstrap.complete(
      initial,
      { ...self, contexts: SemanticContext.fromModules(self.closure.modules), modules },
      configuration?.bindings,
    )
    if (
      self.selection !== undefined &&
      completion.profile.identity !== self.selection.profile.identity
    )
      return yield* ConfigurationError.make(
        'Realization.bootstrap',
        'ConflictingBindings',
        'profile differs from selected frontend',
      )
    const catalog = yield* ArtifactComposition.decode(
      configuration?.composition ?? ArtifactComposition.defaults(completion.profile),
      configuration?.compositionOrigin,
    )
    const composition = yield* ArtifactComposition.resolve(
      catalog,
      self.closure.rootModule,
      completion.profile,
    )
    const missing = composition.modules.filter((name) => !self.closure.sources.has(name))
    if (missing.length > 0)
      return yield* ConfigurationError.make(
        'Realization.bootstrap',
        'MissingParameter',
        'artifact roots require a new frontend analysis',
        [catalog.origin],
        missing,
      )
    return { completion, composition }
  })
  const result = yield* Effect.result(operation)
  if (Result.isSuccess(result))
    return {
      frontend: OpaqueRealization.withCatalog(
        {
          ...self,
          ...(configuration === undefined ? {} : { configuration }),
          composition: result.success.composition,
        },
        OpaqueRealization.catalogOf(self),
      ),
      completion: result.success.completion,
      targetId: selectedTarget,
    }
  const availability =
    result.failure.staticFailure === undefined
      ? []
      : ModuleSelection.availabilityOrigins(
          self.closure,
          Location.resolve(
            result.failure.staticFailure.span,
            SemanticContext.fromModules(self.closure.modules),
          ).span,
        )
  const failure =
    availability.length === 0
      ? result.failure
      : ConfigurationError.make(
          'Realization.bootstrap',
          'DependencyCycle',
          result.failure.subject,
          [
            ...result.failure.origins,
            ...availability.map((span) => ({
              source: span.sourceId,
              provenance: 'literal' as const,
              span,
            })),
          ],
          ['default requires conditional declaration availability'],
          result.failure.staticFailure,
        )
  // The root module stands for the whole configuration when no origin carries a span.
  const rootContext = SemanticContext.fromModules(self.closure.modules).contexts.get(
    self.closure.rootModule,
  )
  const span =
    failure.origins.find((origin) => origin.span !== undefined)?.span ??
    (rootContext === undefined
      ? undefined
      : rootContext.spanOf({
          _tag: 'AuthoredAnchor',
          owner: rootContext.module.owner,
          path: [],
        }))
  if (span === undefined) throw new RangeError('Profile bootstrap lost root source span')
  return {
    frontend: OpaqueRealization.withCatalog(
      {
        ...self,
        diagnostics: Diagnostic.merge(self.diagnostics, [
          Diagnostic.invalidConfiguration(failure, span),
        ]),
      },
      OpaqueRealization.catalogOf(self),
    ),
    targetId: selectedTarget,
  }
})

/** The unavailable MIR state a sealed executable publishes when configuration rejects it. */
export const unavailableMir = (message: string): Targeted<Mir.Module> => ({
  _tag: 'Unavailable',
  error: new AnalysisUnavailable({ operation: 'Analysis.realize', message }),
})

import { AnalysisUnavailable } from './AnalysisUnavailable.js'
import * as ArtifactKind from './ArtifactKind.js'
import * as CoroutineFrame from './CoroutineFrame.js'
import * as Diagnostic from './Diagnostic.js'
import * as DiagnosticObservation from './DiagnosticObservation.js'
import * as ExecutableProperty from './ExecutableProperty.js'
import * as ForeignAvailability from './ForeignAvailability.js'
import * as ForeignPlanning from './ForeignPlanning.js'
import type { Frontend, Options } from './Frontend.js'
import * as InstanceDiagnostics from './InstanceDiagnostics.js'
import * as Instances from './Instances.js'
import * as IntrinsicAvailability from './IntrinsicAvailability.js'
import * as Layout from './Layout.js'
import * as Lower from './Lower.js'
import * as Mir from './Mir.js'
import * as MirNormalization from './MirNormalization.js'
import * as OpaqueRealization from './OpaqueRealization.js'
import * as PhaseReport from './PhaseReport.js'
import * as ProvisionalMir from './ProvisionalMir.js'
import * as Scalar from './Scalar.js'
import * as SuspensionMir from './SuspensionMir.js'
import * as SuspensionOwnership from './SuspensionOwnership.js'
import * as Target from './Target.js'

const normalizeMir = Effect.fn('Realization.normalizeMir')(
  (
    program: Mir.Module,
    provisional: ProvisionalMir.Module,
    normalization: MirLoweringInput['normalization'],
  ) =>
    Effect.sync(() =>
      normalization === 'Preserve' ? program : MirNormalization.normalize(program, provisional),
    ),
)

const finalizeMir = Effect.fn('Realization.finalizeMir')(function* (
  program: Mir.Module,
  provisional: ProvisionalMir.Module,
  index: DeclarationIndex.Index,
  opaqueRealizations: OpaqueRealization.Catalog,
  profile: CompilationProfile.CompilationProfile | undefined,
  normalization: MirLoweringInput['normalization'],
): Effect.fn.Return<{
  readonly program: Mir.Module | undefined
  readonly diagnostics: ReadonlyArray<Diagnostic.Diagnostic>
}> {
  const normalized = yield* normalizeMir(program, provisional, normalization)
  const ownership = yield* planSuspensionOwnership(
    normalized,
    provisional,
    index,
    opaqueRealizations,
  )
  const diagnostics = [
    ...ownership.violations.map((violation) =>
      Diagnostic.invalidSuspensionOwnership(violation.detail, violation.span),
    ),
    ...(yield* checkNativeAssembly(normalized, profile)),
  ]
  if (diagnostics.length > 0) return { program: undefined, diagnostics }
  if (normalization === 'Preserve') return { program: normalized, diagnostics }
  const suspended = yield* finalizeSuspensionMir(normalized, provisional, ownership, index)
  return { program: yield* applyCoroutineFrames(suspended), diagnostics }
})

const planSuspensionOwnership = Effect.fn('Realization.planSuspensionOwnership')(
  (
    program: Mir.Module,
    provisional: ProvisionalMir.Module,
    index: DeclarationIndex.Index,
    opaqueRealizations: OpaqueRealization.Catalog,
  ) => Effect.sync(() => SuspensionOwnership.plan(program, provisional, index, opaqueRealizations)),
)

const checkNativeAssembly = Effect.fn('Realization.checkNativeAssembly')(
  (program: Mir.Module, profile: CompilationProfile.CompilationProfile | undefined) =>
    Effect.sync(() => NativeAssemblyPlanning.diagnostics(program, profile)),
)

const finalizeSuspensionMir = Effect.fn('Realization.finalizeSuspensionMir')(
  (
    program: Mir.Module,
    provisional: ProvisionalMir.Module,
    ownership: SuspensionOwnership.Module,
    index: DeclarationIndex.Index,
  ) => Effect.sync(() => SuspensionMir.finalize(program, provisional, ownership, index)),
)

const applyCoroutineFrames = Effect.fn('Realization.applyCoroutineFrames')((program: Mir.Module) =>
  Effect.sync(() => CoroutineFrame.apply(program)),
)

/** An available target-owned artifact or the reason realization could not construct it. */
export type Targeted<A> =
  | { readonly _tag: 'Available'; readonly value: A }
  | {
      readonly _tag: 'Unavailable'
      readonly error: Target.TargetError | AnalysisUnavailable
    }

/** Immutable target/runtime facts derived from exactly one Frontend value. */
export interface Realization {
  readonly composition?: ArtifactComposition.Resolved
  readonly artifactPlan?: ArtifactPlan.ArtifactPlan
  readonly profile?: CompilationProfile.CompilationProfile
  readonly instances: Instances.Discovery
  readonly target: Target.Selection
  readonly layoutCatalog: Targeted<Layout.Catalog>
  readonly layout: Targeted<Layout.Plan>
  readonly mir: Targeted<Mir.Module>
  readonly diagnostics: ReadonlyArray<Diagnostic.Diagnostic>
  readonly report: ReadonlyArray<PhaseReport.PhaseReport>
}

/** Driver-facing runtime preparation that preserves artifact-production gates. */
export type Preparation =
  | {
      readonly _tag: 'Rejected'
      readonly diagnostics: ReadonlyArray<Diagnostic.Diagnostic>
      readonly report: ReadonlyArray<PhaseReport.PhaseReport>
    }
  | {
      readonly _tag: 'TargetFailed'
      readonly error: Target.TargetError
      readonly diagnostics: ReadonlyArray<Diagnostic.Diagnostic>
      readonly report: ReadonlyArray<PhaseReport.PhaseReport>
    }
  | {
      readonly _tag: 'Prepared'
      readonly frontend: Frontend
      readonly composition: ArtifactComposition.Resolved
      readonly artifactPlan?: ArtifactPlan.ArtifactPlan
      readonly profile: CompilationProfile.CompilationProfile
      readonly instances: Instances.Discovery
      readonly target: Target.Target
      readonly program: Mir.Module
      readonly diagnostics: ReadonlyArray<Diagnostic.Diagnostic>
      readonly report: ReadonlyArray<PhaseReport.PhaseReport>
    }

const hasInvalidGenericBody = (
  index: DeclarationIndex.Index,
  diagnostics: ReadonlyArray<Diagnostic.Diagnostic>,
  registry: SemanticContext.Registry,
): boolean =>
  index.modules.some((module) =>
    module.members.some((member) => {
      if (member.typeParameters.length === 0) return false
      const span = registry.spanOf(member.anchor)
      return diagnostics.some(
        (diagnostic) =>
          diagnostic.span.sourceId === span.sourceId &&
          diagnostic.span.start >= span.start &&
          diagnostic.span.end <= span.end,
      )
    }),
  )
