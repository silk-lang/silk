import * as Diagnostic from './Diagnostic.js'
import * as Tir from './Tir.js'
import * as Instances from './Instances.js'
import * as Type from './Type.js'

/** Resolves the executed callback body; constructing a lazy result is not executing it. */
const callbackInstance = (
  discovery: Instances.Discovery,
  argument: Type.GenericArgument,
): Instances.Instance | undefined => {
  if (!Type.isExactRepresentationArgument(argument)) return undefined
  const identity = argument.identity
  if (identity._tag !== 'CallableIdentityArgument' || identity.target._tag !== 'Declaration')
    return undefined
  const target = identity.target
  return discovery.instances.find(
    (candidate) =>
      candidate.key.declaration.module === target.module &&
      candidate.key.declaration.name === target.name &&
      Type.runtimeArgumentKeys(candidate.key.typeArguments).join('\0') ===
        Type.runtimeArgumentKeys(identity.typeArguments).join('\0'),
  )
}

/** Rejects suspension and recursive observation in the executed observer callback closure. */
export const violationDiagnostics = (
  discovery: Instances.Discovery,
): ReadonlyArray<Diagnostic.Diagnostic> => {
  const diagnostics = discovery.contextFreeTerminalObservations.map(
    Diagnostic.missingDiagnosticContext,
  )
  if (
    !discovery.intrinsics.some(
      (call) =>
        call.operation.actor === 'Intrinsic' && call.operation.name === 'observeDiagnostics',
    )
  )
    return Diagnostic.merge(diagnostics)
  for (const instance of discovery.instances) {
    for (const statement of instance.function.statements) {
      for (const root of Tir.statementExpressions(statement)) {
        for (const expression of Tir.expressionTree(root)) {
          if (
            expression._tag !== 'BuiltinCall' ||
            expression.operation !== 'EffectObserveDiagnostics'
          )
            continue
          const callback = expression.typeArguments.at(3)
          const target =
            callback === undefined
              ? undefined
              : callbackInstance(
                  discovery,
                  Type.substituteGenericArgument(
                    callback,
                    instance.substitution,
                    instance.specialization.compatibility,
                  ),
                )
          const summary =
            target === undefined
              ? undefined
              : Instances.executionSuspensionOf(discovery, target.key)
          const observes =
            target !== undefined &&
            discovery.observingExecutions.some(
              (key) => Instances.keyText(key) === Instances.keyText(target.key),
            )
          if (summary?.availability === 'Complete' && summary.modes.length === 0 && !observes)
            continue
          const incoming = discovery.calls.find(
            (call) => Instances.keyText(call.target) === Instances.keyText(instance.key),
          )
          let reason: string
          if (summary === undefined || summary.availability !== 'Complete')
            reason = 'callback execution closure is unavailable'
          else if (observes) reason = 'callback execution recursively observes diagnostics'
          else reason = summary.modes.join(', ')
          diagnostics.push(
            Diagnostic.invalidDiagnosticObserver(
              reason,
              incoming?.span ?? expression.arguments.at(1)?.span ?? expression.span,
            ),
          )
        }
      }
    }
  }
  return Diagnostic.merge(diagnostics)
}
