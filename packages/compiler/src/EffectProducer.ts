import type * as Instances from './Instances.js'
import * as BodyView from './BodyView.js'
import * as Tir from './Tir.js'
import * as Type from './Type.js'

/** The checked declaration contract of one exact returned Effect producer, before layout. */
export const returnedContract = (
  instance: Instances.Instance,
  block: Extract<Tir.Expression, { readonly _tag: 'EffectBlock' }>,
): Type.Effect | undefined => {
  const terminal = instance.function.statements.at(-1)
  if (terminal?._tag !== 'Return') return undefined
  const returned = terminal.expression
  const bindings =
    returned._tag === 'BindingReference'
      ? instance.function.statements.filter(
          (statement) =>
            statement._tag === 'Bind' && statement.binding.ordinal === returned.binding.ordinal,
        )
      : []
  const binding = bindings.at(0)
  if (
    returned !== block &&
    (bindings.length !== 1 ||
      binding?._tag !== 'Bind' ||
      binding.mutability !== 'Immutable' ||
      binding.initializer !== block)
  )
    return undefined
  const contract = instance.function.contract
  if (
    contract._tag !== 'Contract' ||
    contract.functionKind === 'Effect' ||
    !Type.isEffect(instance.specialization.result) ||
    instance.ownership.verdict._tag !== 'Satisfied' ||
    BodyView.hasUnavailable(instance.view)
  )
    return undefined
  return instance.specialization.result
}
