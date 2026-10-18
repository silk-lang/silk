import * as CAbi from './CAbi.js'
import type * as DeclarationFacts from './DeclarationFacts.js'
import * as Type from './Type.js'

/** Why one resolved type cannot be an inline field of a C-layout record. */
export type RejectionReason =
  | 'UnsupportedType'
  | 'ZeroLengthArray'
  | 'UnknownRecord'
  | 'GenericRecord'
  | 'SilkLayoutRecord'
  | 'InvalidNestedRecord'
  | 'UnavailableField'

/** The target-independent C object-representation verdict for one resolved field type. */
export type Admission =
  | { readonly _tag: 'Admitted'; readonly type: Type.Type }
  | {
      readonly _tag: 'NotAdmitted'
      readonly type: Type.Type
      readonly reason: RejectionReason
    }

/** Resolves a nominal type to the struct declaration that owns its physical-layout contract. */
export type ResolveStruct = (type: Type.Nominal) => DeclarationFacts.StructFact | undefined

const admitted = (type: Type.Type): Admission => ({ _tag: 'Admitted', type })

const rejected = (type: Type.Type, reason: RejectionReason): Admission => ({
  _tag: 'NotAdmitted',
  type,
  reason,
})

/** The fixed and pointer-sized numeric vocabulary with an unambiguous C object representation. */
const admitsScalar = (type: Type.Builtin): boolean => type !== 'bool' && type !== 'char'

/** Builds a canonical nominal lookup from completed or completing module facts. */
export const resolveFrom = (
  modules: ReadonlyArray<DeclarationFacts.ModuleHeaders>,
): ResolveStruct => {
  const declarations = new Map(
    modules.flatMap((module) =>
      module.structs.flatMap((struct) =>
        struct.canonical._tag === 'Canonical'
          ? [[`${struct.canonical.id.module}\u0000${struct.canonical.id.name}`, struct] as const]
          : [],
      ),
    ),
  )
  return (type) => declarations.get(`${type.module}\u0000${type.name}`)
}

interface ValidationState {
  readonly resolve: ResolveStruct
  readonly visiting: Set<string>
  readonly completed: Map<string, Admission>
}

const validateRecord = (type: Type.Nominal, state: ValidationState): Admission => {
  const key = Type.key(type)
  const completed = state.completed.get(key)
  if (completed !== undefined) return completed
  const declaration = state.resolve(type)
  if (declaration === undefined) return rejected(type, 'UnknownRecord')
  if (declaration.layout._tag !== 'Foreign') return rejected(type, 'SilkLayoutRecord')
  if (declaration.typeParameters.length !== 0 || type.arguments.length !== 0)
    return rejected(type, 'GenericRecord')

  // Inline recursion has no finite C object representation. Declaration completion separately
  // owns the canonical cycle diagnostic; this verdict only withdraws the foreign-layout promise.
  if (state.visiting.has(key)) return rejected(type, 'InvalidNestedRecord')
  state.visiting.add(key)
  for (const field of declaration.fields) {
    if (field.declaredType._tag !== 'Resolved') {
      state.visiting.delete(key)
      const result = rejected(type, 'UnavailableField')
      state.completed.set(key, result)
      return result
    }
    const fieldAdmission = validateType(field.declaredType.type, state)
    if (fieldAdmission._tag === 'NotAdmitted') {
      state.visiting.delete(key)
      const result = rejected(type, 'InvalidNestedRecord')
      state.completed.set(key, result)
      return result
    }
  }
  state.visiting.delete(key)
  const result = admitted(type)
  state.completed.set(key, result)
  return result
}

const validateType = (type: Type.Type, state: ValidationState): Admission => {
  if (Type.isBuiltin(type))
    return admitsScalar(type) ? admitted(type) : rejected(type, 'UnsupportedType')
  // Raw pointers deliberately preserve opaque-pointee interoperability.
  if (Type.isPointer(type)) return admitted(type)
  if (Type.isForeignFunction(type))
    return CAbi.admit(type, 'Parameter')._tag === 'Admitted'
      ? admitted(type)
      : rejected(type, 'UnsupportedType')
  if (Type.isFixedArray(type)) {
    if (type.length === 0) return rejected(type, 'ZeroLengthArray')
    return validateType(type.element, state)._tag === 'Admitted'
      ? admitted(type)
      : rejected(type, 'UnsupportedType')
  }
  if (Type.isNominal(type)) return validateRecord(type, state)
  return rejected(type, 'UnsupportedType')
}

/**
 * Admits one resolved field type into the recursively closed C object subset.
 *
 * Pointer pointees are intentionally not visited: pointers to ordinary records remain valid opaque
 * handles, while only records embedded by value need their own C-layout promise.
 */
export const admit = (type: Type.Type, resolve: ResolveStruct): Admission =>
  validateType(type, {
    resolve,
    visiting: new Set<string>(),
    completed: new Map<string, Admission>(),
  })

/** Validates every resolved field against one shared memoized record walk. */
export const admitFields = (
  self: DeclarationFacts.StructFact,
  resolve: ResolveStruct,
): ReadonlyArray<Admission | undefined> => {
  const state: ValidationState = {
    resolve,
    visiting: new Set<string>(),
    completed: new Map<string, Admission>(),
  }
  return self.fields.map((field) =>
    field.declaredType._tag === 'Resolved'
      ? validateType(field.declaredType.type, state)
      : undefined,
  )
}
