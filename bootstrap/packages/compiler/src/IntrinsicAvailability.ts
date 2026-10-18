import * as Diagnostic from './Diagnostic.js'
import type * as Instances from './Instances.js'
import * as Intrinsic from './Intrinsic.js'
import type * as Target from './Target.js'

/** A validated, deterministic intrinsic inventory for one execution surface. */
export interface Inventory {
  readonly _tag: 'ValidatedIntrinsicInventory'
  readonly target: Target.Id
  readonly operations: ReadonlyArray<Intrinsic.OperationId>
  readonly calls: ReadonlyArray<Instances.IntrinsicCall>
}

/** Availability planning either publishes a validated inventory or stable source diagnostics. */
export type Selection =
  | { readonly _tag: 'Available'; readonly inventory: Inventory }
  | {
      readonly _tag: 'Unavailable'
      readonly operations: ReadonlyArray<string>
      readonly diagnostics: ReadonlyArray<Diagnostic.Diagnostic>
    }

const operations = (): ReadonlyArray<Intrinsic.Operation> =>
  Intrinsic.all().flatMap((actor) => actor.operations)

const operationKey = (id: Intrinsic.OperationId): string => Intrinsic.operationText(id)

/**
 * Validates only calls retained by executable closure. The optional catalog exists for focused
 * compiler tests; production callers always use the sealed default catalog.
 */
export const select = (
  calls: ReadonlyArray<Instances.IntrinsicCall>,
  target: Target.Target,
  catalog: ReadonlyArray<Intrinsic.Operation> = operations(),
): Selection => {
  const byIdentity = new Map(catalog.map((operation) => [operationKey(operation.id), operation]))
  const retained = new Map<string, Intrinsic.OperationId>()
  const unavailable = new Map<string, Diagnostic.Diagnostic>()
  for (const call of calls) {
    const key = operationKey(call.operation)
    const operation = byIdentity.get(key)
    if (operation === undefined)
      throw new RangeError(`Executable closure retained unknown intrinsic ${key}`)
    retained.set(key, operation.id)
    if (
      (operation.phase === 'StaticOnly' || !operation.targets.includes(target.id)) &&
      !unavailable.has(key)
    )
      unavailable.set(key, Diagnostic.intrinsicTargetUnavailable(key, target.id, call.span))
  }
  if (unavailable.size > 0)
    return {
      _tag: 'Unavailable',
      operations: [...unavailable.keys()].sort(),
      diagnostics: Diagnostic.merge([...unavailable.values()]),
    }
  return {
    _tag: 'Available',
    inventory: {
      _tag: 'ValidatedIntrinsicInventory',
      target: target.id,
      operations: [...retained.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([, id]) => id),
      calls: Array.from(calls),
    },
  }
}
