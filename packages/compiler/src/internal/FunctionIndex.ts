import type * as DeclarationFacts from '../DeclarationFacts.js'
import type * as Instances from '../Instances.js'
import type * as Mir from '../Mir.js'
import type * as NativeLoweringContext from '../NativeLoweringContext.js'
import * as StaticValue from '../StaticValue.js'
import type * as Tir from '../Tir.js'
import * as Type from '../Type.js'
import * as Canonical from './Canonical.js'

/** Source-ordered candidates, indexed without changing declaration or specialization identity. */
export interface FunctionIndex<A> {
  readonly names: ReadonlyMap<string, ReadonlyArray<A>>
  readonly modules: ReadonlyMap<string, ReadonlyMap<string, ReadonlyArray<A>>>
  /** Declaration buckets of concrete functions, refined by instance identity on first query. */
  readonly instances: Map<ReadonlyArray<A>, ReadonlyMap<string, ReadonlyArray<A>>>
}

/** Builds one index for a completed function collection; unresolved declarations are omitted. */
export const make = <A>(
  values: ReadonlyArray<A>,
  declarationOf: (value: A) => DeclarationFacts.CanonicalId | undefined,
): FunctionIndex<A> => {
  const names = new Map<string, Array<A>>()
  const modules = new Map<string, Map<string, Array<A>>>()
  // The cold scalar sweep measured quadratic module-wide .find comparisons. Index each
  // collection once, retaining source order within buckets so first-match behavior is exact.
  for (const value of values) {
    const declaration = declarationOf(value)
    if (declaration === undefined) continue
    const named = names.get(declaration.name) ?? []
    named.push(value)
    names.set(declaration.name, named)
    const module = modules.get(declaration.module) ?? new Map<string, Array<A>>()
    const candidates = module.get(declaration.name) ?? []
    candidates.push(value)
    module.set(declaration.name, candidates)
    modules.set(declaration.module, module)
  }
  return { names, modules, instances: new Map() }
}

/** Returns only this declaration's candidates, in the original collection order. */
export const candidates = <A>(
  self: FunctionIndex<A>,
  declaration: DeclarationFacts.CanonicalId,
): ReadonlyArray<A> => self.modules.get(declaration.module)?.get(declaration.name) ?? []

/**
 * The concrete identity `Mir.matchesInstance` compares within one declaration. Both lists are
 * length-framed, so two identities are equal exactly when every runtime type argument key and
 * static argument key is.
 */
const instanceIdentity = (
  typeArguments: ReadonlyArray<Type.GenericArgument>,
  staticArguments: ReadonlyArray<StaticValue.Value>,
): string =>
  Canonical.record('Instance', [
    Canonical.array(Type.runtimeArgumentKeys(typeArguments)),
    Canonical.array(staticArguments.map(StaticValue.key)),
  ])

/**
 * Narrows one declaration's candidates to those realizing one concrete instance, in collection
 * order. Lowering resolves every call site this way; scanning a generic declaration's whole bucket
 * per site was quadratic in its instance count.
 */
const instanceCandidates = <A>(
  self: FunctionIndex<A>,
  declaration: DeclarationFacts.CanonicalId,
  instanceOf: (value: A) => Instances.InstanceKey,
  typeArguments: ReadonlyArray<Type.GenericArgument>,
  staticArguments: ReadonlyArray<StaticValue.Value>,
): ReadonlyArray<A> => {
  const bucket = candidates(self, declaration)
  if (bucket.length === 0) return bucket
  let refined = self.instances.get(bucket)
  if (refined === undefined) {
    const built = new Map<string, Array<A>>()
    for (const value of bucket) {
      const instance = instanceOf(value)
      const identity = instanceIdentity(instance.typeArguments, instance.staticArguments)
      const group = built.get(identity)
      if (group === undefined) built.set(identity, [value])
      else group.push(value)
    }
    self.instances.set(bucket, built)
    refined = built
  }
  return refined.get(instanceIdentity(typeArguments, staticArguments)) ?? []
}

/** MIR functions realizing one concrete instance of `declaration`, in collection order. */
export const mirInstances = (
  self: FunctionIndex<Mir.MirFunction>,
  declaration: DeclarationFacts.CanonicalId,
  typeArguments: ReadonlyArray<Type.GenericArgument>,
  staticArguments: ReadonlyArray<StaticValue.Value> = [],
): ReadonlyArray<Mir.MirFunction> =>
  instanceCandidates(self, declaration, (fn) => fn.instance, typeArguments, staticArguments)

const tirIndexes = new WeakMap<Tir.Module, FunctionIndex<Tir.TirFunction>>()

const tirIndex = (module: Tir.Module): FunctionIndex<Tir.TirFunction> => {
  const cached = tirIndexes.get(module)
  if (cached !== undefined) return cached
  const index = make(module.functions, (fn) =>
    fn.declaration.canonical._tag === 'Canonical' ? fn.declaration.canonical.id : undefined,
  )
  // TIR module snapshots are immutable. A revised module owns a different index, and weak
  // ownership lets discarded analysis snapshots (including their functions) be collected.
  tirIndexes.set(module, index)
  return index
}

/** Resolves the first canonical function by name in an already-selected TIR module. */
export const tirByName = (
  module: Tir.Module | undefined,
  name: string,
): Tir.TirFunction | undefined =>
  module === undefined ? undefined : tirIndex(module).names.get(name)?.at(0)

/** Resolves the first function with the exact canonical module and declaration name. */
export const tirByCanonical = (
  module: Tir.Module | undefined,
  declaration: DeclarationFacts.CanonicalId,
): Tir.TirFunction | undefined =>
  module === undefined ? undefined : candidates(tirIndex(module), declaration).at(0)

const nativeIndexes = new WeakMap<
  ReadonlyArray<NativeLoweringContext.DeclaredFunction>,
  FunctionIndex<NativeLoweringContext.DeclaredFunction>
>()

/**
 * Narrows native lookup to one concrete instance of `declaration`; callers still apply the exact
 * MIR matcher for result and Effect contracts.
 */
export const nativeInstances = (
  declared: ReadonlyArray<NativeLoweringContext.DeclaredFunction>,
  declaration: DeclarationFacts.CanonicalId,
  typeArguments: ReadonlyArray<Type.GenericArgument>,
  staticArguments: ReadonlyArray<StaticValue.Value> = [],
): ReadonlyArray<NativeLoweringContext.DeclaredFunction> => {
  let index = nativeIndexes.get(declared)
  if (index === undefined) {
    // Native emission starts after declaration is complete; this collection is not appended
    // to while calls are emitted. Never key by symbol spelling or erase static arguments.
    index = make(declared, (entry) => entry.fn.id)
    nativeIndexes.set(declared, index)
  }
  return instanceCandidates(
    index,
    declaration,
    (entry) => entry.fn.instance,
    typeArguments,
    staticArguments,
  )
}
