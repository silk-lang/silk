import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Result from 'effect/Result'
import type * as ArtifactKind from './ArtifactKind.js'
import * as ArtifactPlan from './ArtifactPlan.js'
import * as CompilationProfile from './CompilationProfile.js'
import * as ConfigurationError from './ConfigurationError.js'
import * as Diagnostic from './Diagnostic.js'
import * as ExecutionStorageComponent from './ExecutionStorageComponent.js'
import * as Frontend from './Frontend.js'
import * as Canonical from './internal/Canonical.js'
import type * as ModuleClosure from './ModuleClosure.js'
import type * as Mir from './Mir.js'
import * as OpaqueRealization from './OpaqueRealization.js'
import type * as ProfileBootstrap from './ProfileBootstrap.js'
import * as Realization from './Realization.js'
import * as SourceFile from './SourceFile.js'
import type * as SourceOrigin from './SourceOrigin.js'
import * as SourceResolver from './SourceResolver.js'
import * as ToolchainIntegrity from './ToolchainIntegrity.js'

/**
 * Preparation seals one compilation request into an immutable bundle whose source-discovery
 * guarantees are explicit. Analysis intent closes the frontend and stops; executable intent also
 * closes demanded runtime component sources to a fixed point. Every operation downstream of a
 * bundle is resolver-free: nothing after sealing may resolve, parse or read semantic source.
 */
export type Intent = 'analysis' | 'executable'

export interface Options extends Frontend.Options {
  readonly artifactKind?: ArtifactKind.ArtifactKind
  readonly optimization?: 'debug' | 'release' | 'release-with-debug'
}

/** Why one module entered the sealed closure beyond ordinary import reachability. */
export type ComponentReason = 'composition' | 'execution-storage'

export interface ComponentRoot {
  readonly module: string
  readonly reason: ComponentReason
}

/** The intent-specific manifest every bundle records for tooling and review. */
export interface Manifest {
  readonly _tag: 'PreparationManifest'
  readonly intent: Intent
  readonly root: string
  readonly identity: string
  readonly profile: string | undefined
  readonly target: string | undefined
  readonly modules: ReadonlyArray<{
    readonly name: string
    readonly origin: SourceOrigin.SourceOrigin
    readonly revision: string
    readonly imports: ReadonlyArray<string>
  }>
  readonly components: ReadonlyArray<ComponentRoot>
  /** Source-closed means discovery is complete for the intent, not that every body is valid. */
  readonly status: 'SourceClosed' | 'Partial'
  readonly diagnostics: number
}

interface Sealed {
  readonly identity: string
  readonly frontend: Frontend.Frontend
  readonly components: ReadonlyArray<ComponentRoot>
}

export interface AnalysisBundle extends Sealed {
  readonly _tag: 'AnalysisBundle'
  readonly intent: 'analysis'
}

/** The executable product: analysis-mode realization, or the Driver preparation gate sequence. */
export type ExecutableProduct =
  | { readonly _tag: 'Realized'; readonly value: Realization.Realization }
  | { readonly _tag: 'Prepared'; readonly value: Realization.Preparation }

export interface ExecutableBundle extends Sealed {
  readonly _tag: 'ExecutableBundle'
  readonly intent: 'executable'
  readonly targetId: string | undefined
  readonly completion: ProfileBootstrap.Completion | undefined
  readonly product: ExecutableProduct
}

export type Bundle = AnalysisBundle | ExecutableBundle

/** Component demand is monotone; a bounded iteration count guards against a non-converging catalog. */
const maximumComponentPasses = 8

const identityOf = (
  intent: Intent,
  frontend: Frontend.Frontend,
  components: ReadonlyArray<ComponentRoot>,
): string =>
  Canonical.record('PreparedBundle', [
    intent,
    frontend.closure.rootModule,
    frontend.profile?.identity ?? frontend.initialProfile?.target.id ?? '',
    frontend.selection?.dependencies ?? '',
    frontend.testCatalog?.identity ?? '',
    Canonical.array(components.map((component) => `${component.reason}:${component.module}`)),
    Canonical.array(
      frontend.closure.modules.map(
        (module) => `${module.name}:${module.authored.presentation.revision}`,
      ),
    ),
  ])

const compositionComponents = (frontend: Frontend.Frontend): ReadonlyArray<ComponentRoot> =>
  (frontend.composition?.modules ?? [])
    .filter((module) => module !== frontend.closure.rootModule)
    .map((module) => ({ module, reason: 'composition' as const }))

const seal = <Tag extends Bundle['_tag']>(bundle: Extract<Bundle, { readonly _tag: Tag }>) =>
  OpaqueRealization.withCatalog(bundle, OpaqueRealization.catalogOf(bundle.frontend)) as Extract<
    Bundle,
    { readonly _tag: Tag }
  >

const programOf = (product: ExecutableProduct): Mir.Module | undefined => {
  if (product._tag === 'Realized')
    return product.value.mir._tag === 'Available' ? product.value.mir.value : undefined
  return product.value._tag === 'Prepared' ? product.value.program : undefined
}

const rootSpan = (frontend: Frontend.Frontend) => {
  const span = frontend.closure.modules.find(
    (module) => module.name === frontend.closure.rootModule,
  )?.syntax.root.span
  if (span === undefined) throw new RangeError('Preparation lost the application source span')
  return span
}

/** Attaches a configuration failure to the product the way each product shape reports rejection. */
const rejectProduct = (
  product: ExecutableProduct,
  frontend: Frontend.Frontend,
  failure: ConfigurationError.ConfigurationError,
  message: string,
): ExecutableProduct => {
  const diagnostic = Diagnostic.invalidConfiguration(failure, rootSpan(frontend))
  if (product._tag === 'Realized')
    return {
      _tag: 'Realized',
      value: {
        ...product.value,
        diagnostics: Diagnostic.merge(product.value.diagnostics, [diagnostic]),
        mir: Realization.unavailableMir(message),
      },
    }
  return {
    _tag: 'Prepared',
    value: {
      _tag: 'Rejected',
      report: product.value.report,
      diagnostics: Diagnostic.merge(product.value.diagnostics, [diagnostic]),
    },
  }
}

const withProgram = (product: ExecutableProduct, program: Mir.Module): ExecutableProduct => {
  if (product._tag === 'Realized')
    return {
      _tag: 'Realized',
      value: { ...product.value, mir: { _tag: 'Available', value: program } },
    }
  if (product.value._tag !== 'Prepared') return product
  return { _tag: 'Prepared', value: { ...product.value, program } }
}

const withArtifactPlan = Effect.fnUntraced(function* (
  product: ExecutableProduct,
  frontend: Frontend.Frontend,
): Effect.fn.Return<ExecutableProduct> {
  const program = programOf(product)
  const prepared =
    product._tag === 'Prepared' && product.value._tag === 'Prepared' ? product.value : undefined
  const profile = product._tag === 'Realized' ? product.value.profile : prepared?.profile
  const composition = product._tag === 'Realized' ? frontend.composition : prepared?.composition
  if (program === undefined || profile === undefined || composition === undefined) return product
  const plan = yield* Effect.result(
    ArtifactPlan.make(
      frontend,
      profile,
      composition,
      program,
      'llvm-bitcode',
      ToolchainIntegrity.installed().digest,
    ),
  )
  if (Result.isFailure(plan))
    return rejectProduct(product, frontend, plan.failure, 'Native requirements are incompatible')
  if (product._tag === 'Realized')
    return {
      _tag: 'Realized',
      value: { ...product.value, artifactPlan: plan.success },
    }
  if (product.value._tag !== 'Prepared') return product
  return {
    _tag: 'Prepared',
    value: { ...product.value, artifactPlan: plan.success },
  }
})

type Ready = Effect.Success<ReturnType<typeof configuredFrontend>>

interface Pass {
  readonly ready: Ready
  readonly product: ExecutableProduct
}

const configuredFrontend = (
  frontend: Frontend.Frontend,
  target: string | ModuleClosure.CompilationRequest['configuration'] | undefined,
  options: Options,
) =>
  Realization.configure(
    frontend,
    typeof target === 'string' ? target : undefined,
    options.artifactKind,
    options.optimization,
    typeof target === 'object' ? target : undefined,
  )

/** One configure-and-lower pass over a loaded frontend, in the requested product shape. */
const executablePass = Effect.fnUntraced(function* (
  frontend: Frontend.Frontend,
  target: string | ModuleClosure.CompilationRequest['configuration'] | undefined,
  options: Options,
  emission: boolean,
): Effect.fn.Return<Pass> {
  const ready = yield* configuredFrontend(frontend, target, options)
  const product: ExecutableProduct = emission
    ? {
        _tag: 'Prepared',
        value: yield* Realization.discoverAndLower(
          ready.frontend,
          ready.targetId,
          ready.completion,
          options,
          true,
        ),
      }
    : {
        _tag: 'Realized',
        value: yield* Realization.discoverAndLower(
          ready.frontend,
          ready.targetId,
          ready.completion,
          options,
        ),
      }
  return { ready, product }
})

/**
 * Closes runtime component demand to a monotone fixed point: each pass may only add demanded
 * component roots, every module outcome is shared through one resolver snapshot, and a pass that
 * admits nothing new seals. Unused catalog entries are never resolved.
 */
/**
 * Serves sources the sealed frontend already holds from memory, so admitting component roots only
 * resolves the new modules and never reopens a source that discovery has already proven.
 */
const retaining = Effect.fnUntraced(function* <A, E>(
  closure: ModuleClosure.Facts,
  effect: Effect.Effect<A, E, SourceResolver.SourceResolver>,
): Effect.fn.Return<A, E, SourceResolver.SourceResolver> {
  const live = yield* SourceResolver.SourceResolver
  const resolve = Effect.fnUntraced(function* (module: string, standard: boolean) {
    const source = closure.sources.get(module)
    if (source !== undefined)
      return Option.some(SourceResolver.resolved(SourceFile.toUint8Array(source), source.origin))
    return yield* standard ? live.resolveStandardLibrary(module) : live.resolve(module)
  })
  return yield* effect.pipe(
    Effect.provideService(SourceResolver.SourceResolver, {
      ...live,
      resolve: (module) => resolve(module, false),
      resolveStandardLibrary: (module) => resolve(module, true),
    }),
  )
})

const closeExecutable = Effect.fnUntraced(function* (
  request: ModuleClosure.CompilationRequest,
  load: (
    components: ReadonlyArray<string>,
    previous: Frontend.Frontend | undefined,
  ) => Effect.Effect<
    Frontend.Frontend,
    ModuleClosure.ModuleClosureError,
    SourceResolver.SourceResolver
  >,
  initial: Frontend.Frontend,
  target: string | ModuleClosure.CompilationRequest['configuration'] | undefined,
  options: Options,
  emission: boolean,
): Effect.fn.Return<
  ExecutableBundle,
  ModuleClosure.ModuleClosureError,
  SourceResolver.SourceResolver
> {
  let frontend = initial
  // Composition roots derive from configuration, not from the closure, so one reading suffices.
  let components: ReadonlyArray<ComponentRoot> = compositionComponents(initial)
  let pass = yield* executablePass(frontend, target, options, emission)
  for (let iteration = 0; ; iteration += 1) {
    const program = programOf(pass.product)
    if (program === undefined || !ExecutionStorageComponent.demanded(program)) break
    const composition =
      pass.ready.frontend.composition?.components ??
      (pass.product._tag === 'Prepared' && pass.product.value._tag === 'Prepared'
        ? pass.product.value.composition.components
        : [])
    const selection = yield* Effect.result(ExecutionStorageComponent.select(composition))
    if (Result.isFailure(selection)) {
      pass = {
        ready: pass.ready,
        product: rejectProduct(
          pass.product,
          pass.ready.frontend,
          selection.failure,
          'Execution storage component is unavailable',
        ),
      }
      break
    }
    const demanded = [...new Set(selection.success.bindings.map((binding) => binding.module))]
    const admitted = demanded.filter((module) => !pass.ready.frontend.closure.sources.has(module))
    if (admitted.length === 0) {
      const component = yield* Effect.result(
        ExecutionStorageComponent.resolve(selection.success, program),
      )
      pass = {
        ready: pass.ready,
        product: Result.isFailure(component)
          ? rejectProduct(
              pass.product,
              pass.ready.frontend,
              component.failure,
              'Execution storage component is unavailable',
            )
          : withProgram(pass.product, { ...program, executionStorage: component.success }),
      }
      break
    }
    // Storage demand comes from a fixed catalog, so the loop settles in two passes; the bound only
    // turns a catalog defect into a rejection instead of a hang.
    if (iteration >= maximumComponentPasses) {
      pass = {
        ready: pass.ready,
        product: rejectProduct(
          pass.product,
          pass.ready.frontend,
          ConfigurationError.make(
            'Preparation.prepare',
            'DependencyCycle',
            'runtime component demand',
            [],
            admitted,
          ),
          'Execution storage component demand did not converge',
        ),
      }
      break
    }
    components = [
      ...components,
      ...admitted.map((module) => ({ module, reason: 'execution-storage' as const })),
    ]
    const profile =
      pass.ready.completion?.profile ??
      (pass.product._tag === 'Realized' ? pass.product.value.profile : undefined)
    frontend = yield* retaining(
      pass.ready.frontend.closure,
      load(
        components.map((component) => component.module),
        pass.ready.frontend,
      ),
    )
    pass = yield* executablePass(
      frontend,
      profile === undefined
        ? target
        : { ...pass.ready.frontend.configuration, profile: CompilationProfile.input(profile) },
      options,
      emission,
    )
  }
  const product = yield* withArtifactPlan(pass.product, pass.ready.frontend)
  return seal<'ExecutableBundle'>({
    _tag: 'ExecutableBundle',
    intent: 'executable',
    identity: identityOf('executable', pass.ready.frontend, components),
    frontend: pass.ready.frontend,
    components,
    targetId: pass.ready.targetId,
    completion: pass.ready.completion,
    product,
  })
})

/**
 * Seals one compilation request. Analysis intent performs no instance, layout, MIR or backend
 * work. Executable intent closes demanded component sources before publication. The whole request
 * shares one resolver snapshot, so no module outcome is requested twice.
 */
export const prepare: {
  (
    request: ModuleClosure.CompilationRequest,
    intent: 'analysis',
    options?: Options,
  ): Effect.Effect<AnalysisBundle, ModuleClosure.ModuleClosureError, SourceResolver.SourceResolver>
  (
    request: ModuleClosure.CompilationRequest,
    intent: 'executable',
    options?: Options & { readonly emission?: boolean },
  ): Effect.Effect<
    ExecutableBundle,
    ModuleClosure.ModuleClosureError,
    SourceResolver.SourceResolver
  >
} = (
  request: ModuleClosure.CompilationRequest,
  intent: Intent,
  options: Options & { readonly emission?: boolean } = {},
): Effect.Effect<never, ModuleClosure.ModuleClosureError, SourceResolver.SourceResolver> =>
  prepareEffect(request, intent, options) as Effect.Effect<
    never,
    ModuleClosure.ModuleClosureError,
    SourceResolver.SourceResolver
  >

const prepareEffect = Effect.fn('Preparation.prepare')(function* (
  request: ModuleClosure.CompilationRequest,
  intent: Intent,
  options: Options & { readonly emission?: boolean },
): Effect.fn.Return<Bundle, ModuleClosure.ModuleClosureError, SourceResolver.SourceResolver> {
  yield* Effect.annotateCurrentSpan({
    'preparation.intent': intent,
    'preparation.root': request.root,
  })
  const load = (components: ReadonlyArray<string>, previous: Frontend.Frontend | undefined) =>
    Frontend.frontend(request, options, components, previous?.closure)
  const frontend = yield* load([], undefined)
  if (intent === 'analysis') {
    const components = compositionComponents(frontend)
    return seal<'AnalysisBundle'>({
      _tag: 'AnalysisBundle',
      intent: 'analysis',
      identity: identityOf('analysis', frontend, components),
      frontend,
      components,
    })
  }
  return yield* closeExecutable(
    request,
    load,
    frontend,
    request.configuration ?? request.target,
    options,
    options.emission === true,
  )
}, SourceResolver.withSnapshot)

/**
 * Starts a new executable preparation from an already sealed frontend. The prior artifact is left
 * untouched; only components the sealed closure lacks are resolved, through the supplied resolver.
 */
export const promote = Effect.fn('Preparation.promote')(function* (
  frontend: Frontend.Frontend,
  target: string | ModuleClosure.CompilationRequest['configuration'] | undefined,
  options: Options & { readonly emission?: boolean } = {},
): Effect.fn.Return<
  ExecutableBundle,
  ModuleClosure.ModuleClosureError,
  SourceResolver.SourceResolver
> {
  const request: ModuleClosure.CompilationRequest = {
    root: frontend.closure.rootModule,
    ...(frontend.configuration === undefined ? {} : { configuration: frontend.configuration }),
    ...(frontend.requestedTarget === undefined ? {} : { target: frontend.requestedTarget }),
    ...(frontend.testCatalog === undefined ? {} : { discovery: frontend.testCatalog.request }),
  }
  const load = (components: ReadonlyArray<string>, previous: Frontend.Frontend | undefined) =>
    Frontend.frontend(
      {
        ...request,
        ...(typeof target === 'object' && target !== undefined ? { configuration: target } : {}),
      },
      options,
      components,
      previous?.closure ?? frontend.closure,
    )
  return yield* closeExecutable(request, load, frontend, target, options, options.emission === true)
}, SourceResolver.withSnapshot)

/** The resolver-free realization of a sealed executable bundle prepared without emission gates. */
export const realization = (
  self: ExecutableBundle,
): Realization.Realization & { readonly frontend: Frontend.Frontend } => {
  if (self.product._tag !== 'Realized')
    throw new RangeError('Executable bundle was prepared for emission; use Preparation.preparation')
  return { ...self.product.value, frontend: self.frontend }
}

/** The resolver-free Driver preparation of a sealed executable bundle prepared for emission. */
export const preparation = (self: ExecutableBundle): Realization.Preparation => {
  if (self.product._tag !== 'Prepared')
    throw new RangeError('Executable bundle was prepared for analysis; use Preparation.realization')
  return self.product.value
}

/** Projects the immutable manifest of a bundle. */
export const manifest = (self: Bundle): Manifest => {
  const frontend = self.frontend
  const partial =
    frontend.closure.resolutionFailures.length > 0 ||
    frontend.closure.missingRoots.length > 0 ||
    frontend.configurationError !== undefined
  return {
    _tag: 'PreparationManifest',
    intent: self.intent,
    root: frontend.closure.rootModule,
    identity: self.identity,
    profile: frontend.profile?.identity,
    target: self._tag === 'ExecutableBundle' ? self.targetId : frontend.requestedTarget,
    modules: frontend.closure.modules.map((module) => ({
      name: module.name,
      origin: module.syntax.source.origin,
      revision: module.authored.presentation.revision,
      imports: module.imports.flatMap((fact) =>
        fact.target._tag === 'Resolved' ? [fact.target.module] : [],
      ),
    })),
    components: self.components,
    status: partial ? 'Partial' : 'SourceClosed',
    diagnostics: frontend.diagnostics.length,
  }
}
