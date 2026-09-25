import * as Constraint from './Constraint.js'
import * as StaticValue from './StaticValue.js'
import * as Type from './Type.js'

/** One concrete declaration specialization independent of the phase that discovered it. */
export interface Specialization {
  readonly declaration: {
    readonly module: string
    readonly name: string
  }
  readonly typeArguments: ReadonlyArray<Type.GenericArgument>
  readonly evidence?: ReadonlyArray<string>
  readonly staticArguments?: ReadonlyArray<StaticValue.Value>
}

const keyCache = new WeakMap<Specialization, string>()

/** Returns the canonical identity shared by discovery, proof dependencies, and lowering. */
export const key = (self: Specialization): string => {
  let cached = keyCache.get(self)
  if (cached === undefined) {
    cached = `${self.declaration.module}\u0000${self.declaration.name}\u0000${self.typeArguments
      .map(Type.genericArgumentKey)
      .join(
        '\u0000',
      )}${self.evidence === undefined || self.evidence.length === 0 ? '' : `\u0004${self.evidence.join('\u0000')}`}${
      self.staticArguments === undefined || self.staticArguments.length === 0
        ? ''
        : `\u0001${self.staticArguments.map(StaticValue.key).join('\u0000')}`
    }`
    keyCache.set(self, cached)
  }
  return cached
}

/** Memoized on the specialization object itself, like `Type.key`. */
const cachedRuntimeKey: unique symbol = Symbol('Specialization.runtimeKey')

/** Identifies machine-code specialization while retaining semantic arguments on the value. */
export const runtimeKey = (self: Specialization): string => {
  const cached: unknown = Reflect.get(self, cachedRuntimeKey)
  if (typeof cached === 'string') return cached
  const computed = `${self.declaration.module}\u0000${self.declaration.name}\u0000${Type.runtimeArgumentKeys(self.typeArguments).join('\u0000')}${self.evidence === undefined || self.evidence.length === 0 ? '' : `\u0004${self.evidence.join('\u0000')}`}${self.staticArguments === undefined || self.staticArguments.length === 0 ? '' : `\u0001${self.staticArguments.map(StaticValue.key).join('\u0000')}`}`
  if (Object.isExtensible(self)) Object.defineProperty(self, cachedRuntimeKey, { value: computed })
  return computed
}

/** Applies one concrete executable owner and its substitutions to a retained source type. */
export const specializeType = (
  self: Specialization,
  type: Type.Type,
  substitutions: ReadonlyArray<Type.Substitution>,
): Type.Type =>
  Type.specializeExecutableOwner(
    substitutions.reduce(
      (specialized, substitution) => Type.substitute(specialized, substitution),
      type,
    ),
    {
      declaration: self.declaration,
      typeArguments: self.typeArguments,
      staticArgumentKeys: (self.staticArguments ?? []).map(StaticValue.key),
    },
    Constraint.specializeCallableSchemaExecutableOwner,
  )
