import * as Effect from 'effect/Effect'
import * as ConfigurationError from './ConfigurationError.js'
import * as ConfigurationOrigin from './ConfigurationOrigin.js'
import * as NativeRequirement from './NativeRequirement.js'
import * as SourceResolver from './SourceResolver.js'
import * as Canonical from './internal/Canonical.js'

/** One source declaration implementing an operation of a runtime capability contract. */
export interface Binding {
  readonly operation: string
  readonly module: string
  readonly declaration: string
}

/** Explicit source bindings, independent of application invocation and loader entry. */
export interface Input {
  readonly capability: string
  readonly bindings: ReadonlyArray<Binding>
}

/** A selected component catalog entry; declaration retention requires an actual capability demand. */
export interface RuntimeComponent extends Input {
  readonly origin: ConfigurationOrigin.ConfigurationOrigin
}

const record = (input: unknown): input is Record<string, unknown> =>
  typeof input === 'object' && input !== null && !Array.isArray(input)

/** Decodes source selectors without loading their modules or granting their names compiler privilege. */
export const decode = Effect.fn('RuntimeComponent.decode')(function* (
  input: unknown,
  origin: ConfigurationOrigin.ConfigurationOrigin,
): Effect.fn.Return<RuntimeComponent, ConfigurationError.ConfigurationError> {
  const invalid = (subject: string) =>
    ConfigurationError.make('RuntimeComponent.decode', 'InvalidInput', subject, [origin])
  if (!ConfigurationOrigin.isPublic(origin))
    return yield* ConfigurationError.make(
      'RuntimeComponent.decode',
      'ForbiddenProvenance',
      'runtime component',
      [origin],
    )
  if (
    !record(input) ||
    Object.keys(input).some((key) => key !== 'capability' && key !== 'bindings') ||
    typeof input.capability !== 'string' ||
    !NativeRequirement.isIdentity(input.capability) ||
    !Array.isArray(input.bindings) ||
    input.bindings.length === 0
  )
    return yield* invalid('runtime component fields')
  const bindings: Array<Binding> = []
  const operations = new Set<string>()
  for (const value of input.bindings) {
    if (
      !record(value) ||
      Object.keys(value).some((key) => !['operation', 'module', 'declaration'].includes(key)) ||
      typeof value.operation !== 'string' ||
      !NativeRequirement.isIdentity(value.operation) ||
      typeof value.module !== 'string' ||
      !SourceResolver.isCanonicalModule(value.module) ||
      typeof value.declaration !== 'string' ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value.declaration)
    )
      return yield* invalid('runtime component binding')
    if (operations.has(value.operation))
      return yield* ConfigurationError.make(
        'RuntimeComponent.decode',
        'ConflictingBindings',
        value.operation,
        [origin],
      )
    operations.add(value.operation)
    bindings.push({
      operation: value.operation,
      module: value.module,
      declaration: value.declaration,
    })
  }
  return {
    capability: input.capability,
    bindings: bindings.sort((a, b) => Canonical.compare(a.operation, b.operation)),
    origin: ConfigurationOrigin.snapshot(origin),
  }
})

/** Encodes capability and operation bindings without incidental configuration locations. */
export const encode = (self: Input): string =>
  Canonical.record('RuntimeComponent.v1', [
    self.capability,
    Canonical.array(
      self.bindings
        .map((binding) =>
          Canonical.record('binding', [binding.operation, binding.module, binding.declaration]),
        )
        .sort(Canonical.compare),
    ),
  ])

/** Removes diagnostic provenance for portable project configuration. */
export const input = (self: RuntimeComponent): Input => ({
  capability: self.capability,
  bindings: self.bindings,
})
