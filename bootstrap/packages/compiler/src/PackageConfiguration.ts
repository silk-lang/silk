import * as SourceResolver from './SourceResolver.js'
import * as Canonical from './internal/Canonical.js'
import * as Effect from 'effect/Effect'
import * as CompilationProfile from './CompilationProfile.js'
import * as ConfigurationError from './ConfigurationError.js'
import * as ConfigurationOrigin from './ConfigurationOrigin.js'
import * as ConfigurationValue from './ConfigurationValue.js'
import type * as DeclarationFacts from './DeclarationFacts.js'
import type * as DeclarationIndex from './DeclarationIndex.js'
import type * as SemanticContext from './SemanticContext.js'
import * as PackageParameter from './PackageParameter.js'
import type * as StaticValue from './StaticValue.js'
import type * as Target from './Target.js'

/** Explicit package ownership of a canonical source module, supplied by the package graph. */
export interface Module {
  readonly canonical: string
  readonly package: string
  readonly module: string
  readonly bytes: Uint8Array
}

/** Project/workspace bindings share a tier; artifact/profile bindings share the higher tier. */
export interface Binding extends CompilationProfile.ParameterIdentity {
  readonly tier: 'project' | 'workspace' | 'artifact' | 'profile'
  readonly value: unknown
  readonly origin: ConfigurationOrigin.ConfigurationOrigin
}

/** A source schema and its selected, checked explicit value, if any. */
export interface Parameter extends CompilationProfile.ParameterIdentity {
  readonly declaration: DeclarationFacts.PackageParameterFact
  readonly schema: PackageParameter.Schema
  readonly origin: ConfigurationOrigin.ConfigurationOrigin
  readonly explicit?: StaticValue.Value
}

/** Resolves source identities and all explicit tiers before any default may execute. */
export const prepare = Effect.fn('PackageConfiguration.prepare')(function* (
  index: DeclarationIndex.Index,
  /** Spans of every loaded module, so a schema's provenance survives without its source. */
  contexts: SemanticContext.Registry,
  target: Target.Target,
  modules: ReadonlyArray<Module>,
  bindings: ReadonlyArray<Binding>,
): Effect.fn.Return<ReadonlyArray<Parameter>, ConfigurationError.ConfigurationError> {
  // Check every provenance first, including superseded values and unknown keys.
  for (const binding of bindings) {
    if (!ConfigurationOrigin.isPublic(binding.origin))
      return yield* ConfigurationError.make(
        'PackageConfiguration.prepare',
        'ForbiddenProvenance',
        'binding',
        [binding.origin],
      )
  }
  const ownership = new Map<string, Module>()
  const identities = new Map<string, Module>()
  for (const module of modules) {
    if (
      !SourceResolver.isCanonicalModule(module.module) ||
      !/^[A-Za-z_][A-Za-z0-9_.-]*@[^/\\\s]+$/.test(module.package)
    )
      return yield* ConfigurationError.make(
        'PackageConfiguration.prepare',
        'InvalidInput',
        'package/module identity',
      )
    const key = `${module.package}/${module.module}`
    const previous = identities.get(key)
    const canonical = ownership.get(module.canonical)
    if (
      (previous !== undefined &&
        (previous.bytes.length !== module.bytes.length ||
          previous.bytes.some((byte, i) => byte !== module.bytes[i]))) ||
      (canonical !== undefined &&
        (canonical.package !== module.package || canonical.module !== module.module))
    )
      return yield* ConfigurationError.make(
        'PackageConfiguration.prepare',
        'PackageIdentityConflict',
        key,
      )
    identities.set(key, module)
    ownership.set(module.canonical, module)
  }
  const context: PackageParameter.Context = { index, target, packages: ownership }
  const parameters = new Map<string, Parameter>()
  for (const module of index.modules) {
    for (const declaration of module.constants) {
      if (declaration._tag !== 'PackageParameterDeclaration') continue
      const owner = ownership.get(module.module)
      if (
        owner === undefined ||
        declaration.name._tag !== 'Present' ||
        declaration.declaredType._tag !== 'Resolved'
      )
        return yield* ConfigurationError.make(
          'PackageConfiguration.prepare',
          'InvalidType',
          'parameter schema',
        )
      const identity = {
        package: owner.package,
        module: owner.module,
        parameter: declaration.name.spelling,
      }
      const key = CompilationProfile.parameterKey(identity)
      const origin = ConfigurationOrigin.snapshot({
        source: `${owner.package}/${owner.module}/${declaration.name.spelling}`,
        provenance: 'literal',
        span: contexts.spanOf(declaration.anchor),
      })
      const schema = yield* PackageParameter.describe(
        context,
        declaration.declaredType.type,
        origin,
      )
      if (declaration.visibility === 'Private' && !declaration.hasDefault)
        return yield* ConfigurationError.make(
          'PackageConfiguration.prepare',
          'MissingParameter',
          origin.source,
          [origin],
        )
      parameters.set(key, { ...identity, declaration, schema, origin })
    }
  }
  const selected = new Map<
    string,
    {
      readonly rank: number
      readonly value: ConfigurationValue.ConfigurationValue
      readonly explicit: StaticValue.Value
      readonly origin: ConfigurationOrigin.ConfigurationOrigin
    }
  >()
  const tiers = new Map<
    string,
    { readonly value: string; readonly origin: ConfigurationOrigin.ConfigurationOrigin }
  >()
  for (const binding of bindings) {
    const key = CompilationProfile.parameterKey(binding)
    const parameter = parameters.get(key)
    if (parameter === undefined)
      return yield* ConfigurationError.make(
        'PackageConfiguration.prepare',
        'UnknownParameter',
        key,
        [binding.origin],
      )
    if (parameter.declaration.visibility !== 'Public')
      return yield* ConfigurationError.make(
        'PackageConfiguration.prepare',
        'PrivateParameter',
        key,
        [binding.origin, parameter.origin],
      )
    const value = yield* ConfigurationValue.decode(binding.value, binding.origin)
    const explicit = yield* PackageParameter.bind(parameter.schema, value, binding.origin, target)
    const canonical = ConfigurationValue.encode(value)
    const rank = binding.tier === 'project' || binding.tier === 'workspace' ? 1 : 2
    const tierKey = `${rank}:${key}`
    const sameTier = tiers.get(tierKey)
    if (sameTier !== undefined)
      return yield* ConfigurationError.make(
        'PackageConfiguration.prepare',
        'ConflictingBindings',
        key,
        [sameTier.origin, binding.origin],
      )
    tiers.set(tierKey, { value: canonical, origin: binding.origin })
    const previous = selected.get(key)
    if (previous === undefined || rank > previous.rank)
      selected.set(key, {
        rank,
        value,
        explicit,
        origin: ConfigurationOrigin.snapshot(binding.origin),
      })
  }
  const output: Array<Parameter> = []
  for (const [key, parameter] of [...parameters].toSorted(([a], [b]) => Canonical.compare(a, b))) {
    const binding = selected.get(key)
    if (binding === undefined && !parameter.declaration.hasDefault)
      return yield* ConfigurationError.make(
        'PackageConfiguration.prepare',
        'MissingParameter',
        key,
        [parameter.origin],
      )
    output.push(
      binding === undefined
        ? parameter
        : { ...parameter, origin: binding.origin, explicit: binding.explicit },
    )
  }
  return output
})
