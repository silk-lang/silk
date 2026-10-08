import * as AuthoredIdentity from './AuthoredIdentity.js'
import type * as CallableContract from './CallableContract.js'
import * as DeclarationFacts from './DeclarationFacts.js'
import type * as DeclarationIndex from './DeclarationIndex.js'
import * as Lifetime from './Lifetime.js'
import type * as Mir from './Mir.js'
import * as Type from './Type.js'
import * as TypeInference from './internal/TypeInference.js'

/** The original named header, with its original argument slots and input coordinates. */
export interface CallableDeclarationView {
  readonly declaration: DeclarationFacts.DeclarationFact
  readonly contract: CallableContract.CallableContract
  readonly substitution: Type.Substitution
  readonly parameters: ReadonlyArray<Type.Type>
  readonly inputs: ReadonlyArray<number>
}

/** Reads source designation; it neither selects a physical body nor proves caller bounds. */
export const original = (
  index: DeclarationIndex.Index,
  actual: Extract<Mir.Type, { readonly _tag: 'CallableValue' }>,
): CallableDeclarationView | undefined => {
  if (
    index.stage !== 'Complete' ||
    actual.target._tag !== 'DeclarationCallableTarget' ||
    actual.environment !== undefined ||
    actual.storage !== undefined ||
    actual.site !== undefined ||
    actual.type.schema !== undefined
  )
    return undefined
  const target = actual.target.declaration
  const declarations = index.modules
    .filter((module) => module.module === target.module)
    .flatMap((module) => module.declarations)
    .filter(
      (declaration) =>
        declaration.canonical._tag === 'Canonical' &&
        declaration.canonical.id.module === target.module &&
        declaration.canonical.id.name === target.name,
    )
  const declaration = declarations.at(0)
  if (
    declarations.length !== 1 ||
    declaration === undefined ||
    declaration.id.sourceId !== target.module ||
    declaration.owner.module !== target.module ||
    AuthoredIdentity.key(declaration.owner) !== AuthoredIdentity.key(declaration.anchor.owner) ||
    declaration.foreign !== undefined ||
    declaration.phase !== 'Runtime' ||
    declaration.returnType._tag !== 'Resolved' ||
    declaration.parameterCount !== declaration.parameters.length ||
    declaration.parameters.some(
      (parameter, ordinal) =>
        parameter.phase !== 'Runtime' ||
        parameter.id.ordinal !== ordinal ||
        parameter.captureAccess !== undefined ||
        parameter.declaredType._tag !== 'Resolved',
    )
  )
    return undefined
  let contract: CallableContract.CallableContract
  try {
    contract = DeclarationFacts.callableContract(declaration)
  } catch (error) {
    if (error instanceof RangeError) return undefined
    throw error
  }
  const arguments_ = actual.typeArguments ?? []
  const substitution = TypeInference.orderedSubstitution(contract.binders, arguments_)
  const inputs = Type.callableInputOrdinals(contract)
  if (
    substitution === undefined ||
    inputs === undefined ||
    inputs.length !== contract.parameters.length ||
    contract.captures.length !== 0 ||
    actual.type.unsafe !== contract.unsafe
  )
    return undefined
  const parameters = contract.parameters.map((parameter) =>
    Type.substitute(parameter.type, substitution),
  )
  if (
    parameters.length !== actual.type.parameters.length ||
    parameters.some((parameter, ordinal) => {
      const selected = actual.type.parameters.at(ordinal)
      return selected === undefined || !Type.equals(parameter, selected)
    })
  )
    return undefined
  const result = Type.substitute(contract.result, substitution)
  if (Type.isEffect(result) && Type.isEffect(actual.type.result)) {
    // Compare semantic channels only. Contextual access and environment shortening belong to
    // the checked caller. Return the original bounds/environment without proving that view here.
    if (
      !Type.equals(
        {
          ...result,
          environment: actual.type.result.environment,
          access: actual.type.result.access,
          lifetimeBounds: actual.type.result.lifetimeBounds ?? [],
          typeOutlives: actual.type.result.typeOutlives ?? [],
        },
        actual.type.result,
      )
    )
      return undefined
  } else if (!Type.equals(result, actual.type.result)) return undefined
  const usage = contract.invocationUse
  if (
    usage !== undefined &&
    (usage.lifetime._tag !== 'BoundLifetime' ||
      usage.lifetime.owner.module !== target.module ||
      usage.lifetime.owner.name !== target.name ||
      actual.type.invocationUse === undefined ||
      !Lifetime.equals(usage.lifetime, actual.type.invocationUse.lifetime) ||
      actual.type.invocationUse.parameters.length !== usage.parameters.length ||
      actual.type.invocationUse.parameters.some(
        (parameter, ordinal) => parameter !== usage.parameters.at(ordinal),
      ) ||
      !Type.invocationUseValid(usage, inputs.length, contract.lifetimeBinders, { state: 'Closed' }))
  )
    return undefined
  // Keep constraints and bounds on the original contract. A contextual marker or a concrete
  // selected lifetime is never promoted into an authored designation or a universal assumption.
  return { declaration, contract, substitution, parameters, inputs }
}
