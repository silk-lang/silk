import * as Target from './Target.js'
import * as ConfigurationValue from './ConfigurationValue.js'
import * as Effect from 'effect/Effect'
import * as CompilationProfile from './CompilationProfile.js'
import * as ConfigurationError from './ConfigurationError.js'
import type * as DeclarationIndex from './DeclarationIndex.js'
import type * as Elaboration from './Elaboration.js'
import * as Canonical from './internal/Canonical.js'
import type * as NameResolution from './NameResolution.js'
import * as PackageConfiguration from './PackageConfiguration.js'
import * as PackageParameter from './PackageParameter.js'
import * as Residualization from './Residualization.js'
import type * as SemanticContext from './SemanticContext.js'
import type * as Evaluation from './Evaluation.js'
import * as CompilerTrace from './CompilerTrace.js'
import type * as StaticValue from './StaticValue.js'

/** The unconditional source graph needed to resolve package defaults before specialization. */
export interface Source {
  readonly index: DeclarationIndex.Index
  readonly contexts: SemanticContext.Registry
  readonly results: ReadonlyMap<string, Elaboration.Result>
  readonly resolution: NameResolution.Resolution
  readonly modules: ReadonlyArray<PackageConfiguration.Module>
}

const failure = (
  parameter: PackageConfiguration.Parameter,
  value: Evaluation.StaticFailure,
  validation: boolean,
) => {
  let code: ConfigurationError.Code = validation ? 'ValidationFailed' : 'InvalidDefault'
  if (value._tag === 'Cycle') code = 'DependencyCycle'
  return ConfigurationError.make(
    'ProfileBootstrap.complete',
    code,
    CompilationProfile.parameterKey(parameter),
    [parameter.origin],
    value._tag === 'Cycle' ? [`${value.declaration.module}/${value.declaration.name}`] : [],
    value,
  )
}

/** A completed profile paired with immutable source-typed values for ordinary specialization. */
export interface Completion {
  readonly bootstrapIdentity: string
  readonly profile: CompilationProfile.CompilationProfile
  readonly values: ReadonlyMap<string, StaticValue.Value>
}

/** Resolves defaults and validates every final value before publishing an immutable profile. */
export const complete = Effect.fn('ProfileBootstrap.complete')(function* (
  initial: CompilationProfile.Initial,
  source: Source,
  bindings: ReadonlyArray<PackageConfiguration.Binding> = [],
): Effect.fn.Return<Completion, ConfigurationError.ConfigurationError> {
  const trace = yield* CompilerTrace.capture()
  yield* Target.validateDescription(initial.target).pipe(
    Effect.mapError(() =>
      ConfigurationError.make('ProfileBootstrap.complete', 'InvalidInput', 'target description'),
    ),
  )
  const parameters = yield* PackageConfiguration.prepare(
    source.index,
    source.contexts,
    initial.target,
    source.modules,
    bindings,
  )
  const explicit = new Map<string, StaticValue.Value>()
  for (const parameter of parameters) {
    const canonical = parameter.declaration.canonical
    if (canonical._tag === 'Canonical' && parameter.explicit !== undefined)
      explicit.set(
        Canonical.record('PackageParameter', [canonical.id.module, canonical.id.name]),
        parameter.explicit,
      )
  }
  // This coordinator is private to the bootstrap. All explicit values exist before any demand;
  // recursive defaults, including demands made by helpers, use the ordinary evaluator's cycle guard.
  const coordinator = Residualization.makeBootstrap(
    initial,
    source.results,
    source.resolution,
    source.index,
    explicit,
    trace,
  )
  const completed: Array<CompilationProfile.Parameter> = []
  const values = new Map<string, StaticValue.Value>()
  for (const parameter of parameters) {
    const evaluated = Residualization.evaluateConstant(coordinator, parameter.declaration)
    if (evaluated._tag === 'Failed') return yield* failure(parameter, evaluated.failure, false)
    const canonical = parameter.declaration.canonical
    if (canonical._tag === 'Canonical')
      values.set(
        Canonical.record('PackageParameter', [canonical.id.module, canonical.id.name]),
        evaluated.value,
      )
    const value = yield* PackageParameter.unbind(
      parameter.schema,
      evaluated.value,
      parameter.origin,
      initial.target,
    )
    completed.push({
      package: parameter.package,
      module: parameter.module,
      parameter: parameter.parameter,
      type: PackageParameter.encode(parameter.schema),
      value,
      origin: parameter.origin,
    })
  }
  for (const parameter of parameters) {
    const evaluated = Residualization.evaluateParameterPredicate(coordinator, parameter.declaration)
    if (evaluated._tag === 'Failed') return yield* failure(parameter, evaluated.failure, true)
    if (evaluated.value._tag !== 'BooleanValue' || !evaluated.value.value)
      return yield* ConfigurationError.make(
        'ProfileBootstrap.complete',
        'ValidationFailed',
        CompilationProfile.parameterKey(parameter),
        [parameter.origin],
      )
  }
  return {
    profile: yield* CompilationProfile.publish(initial, completed),
    values,
    bootstrapIdentity: Canonical.record('ProfileBootstrap.v1', [
      initial.identity,
      Canonical.array(
        completed.map((parameter) =>
          Canonical.record(CompilationProfile.parameterKey(parameter), [
            parameter.type,
            ConfigurationValue.encode(parameter.value),
          ]),
        ),
      ),
      Residualization.dependencies(coordinator),
    ]),
  }
})
