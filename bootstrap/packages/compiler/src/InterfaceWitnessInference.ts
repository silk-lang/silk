import * as TypeInference from './internal/TypeInference.js'
import * as Type from './Type.js'

/** One ordered piece of the mapped target contract used to infer its declaration binders. */
export interface Constraint {
  readonly label: string
  readonly pattern: Type.Type
  readonly actual: Type.Type
}

export type Problem =
  | {
      readonly _tag: 'UnresolvedBinder'
      readonly binder: Type.Parameter
    }
  | {
      readonly _tag: 'ConflictingBinder'
      readonly binder: Type.Parameter
      readonly previous: Type.GenericArgument
      readonly conflicting: Type.GenericArgument
      readonly previousConstraint: string
      readonly conflictingConstraint: string
    }
  | {
      readonly _tag: 'IncompatibleConstraint'
      readonly constraint: string
    }
  | {
      readonly _tag: 'IncompatibleArguments'
      readonly binder: Type.Parameter
      readonly argument: Type.GenericArgument
    }

export type Inference =
  | {
      readonly _tag: 'Inferred'
      readonly arguments: ReadonlyArray<Type.GenericArgument>
      readonly substitution: Type.Substitution
    }
  | { readonly _tag: 'Failed'; readonly problem: Problem }

const failed = (problem: Problem): Inference => ({ _tag: 'Failed', problem })

/**
 * Infers one mapped declaration's binders from source-ordered substituted contract constraints.
 *
 * Each constraint is first checked against the evidence accumulated before it. If that fails but
 * the constraint is independently meaningful, the first declaration-ordered binder whose evidence
 * differs is the conflict. This keeps diagnostics stable even when normalized row members have a
 * different internal order from the source declarations that introduced their binders.
 */
export const infer = (
  binders: ReadonlyArray<Type.Parameter>,
  constraints: ReadonlyArray<Constraint>,
): Inference => {
  const inferred = new Map<string, Type.GenericArgument>()
  const sources = new Map<string, string>()
  for (const constraint of constraints) {
    const trial = new Map(inferred)
    const result = TypeInference.inferOpenGenericArguments(
      constraint.pattern,
      constraint.actual,
      trial,
    )
    if (result.matches) {
      for (const binder of binders) {
        const identity = Type.key(binder)
        if (!inferred.has(identity) && trial.has(identity)) sources.set(identity, constraint.label)
      }
      inferred.clear()
      for (const [identity, argument] of trial) inferred.set(identity, argument)
      continue
    }

    const conflict = binders.flatMap((binder) => {
      const found = result.conflicts.find((candidate) => Type.equals(candidate.parameter, binder))
      return found === undefined ? [] : [{ binder, conflict: found }]
    })[0]
    if (conflict !== undefined) {
      const identity = Type.key(conflict.binder)
      const previousSource = sources.get(identity)
      return failed({
        _tag: 'ConflictingBinder',
        binder: conflict.binder,
        previous: conflict.conflict.previous,
        conflicting: conflict.conflict.conflicting,
        previousConstraint: previousSource ?? `${constraint.label} (earlier occurrence)`,
        conflictingConstraint:
          previousSource === undefined
            ? `${constraint.label} (later occurrence)`
            : constraint.label,
      })
    }
    return failed({ _tag: 'IncompatibleConstraint', constraint: constraint.label })
  }

  const unresolved = binders.find((binder) => !inferred.has(Type.key(binder)))
  if (unresolved !== undefined) return failed({ _tag: 'UnresolvedBinder', binder: unresolved })
  const arguments_ = binders.flatMap((binder) => {
    const argument = inferred.get(Type.key(binder))
    return argument === undefined ? [] : [argument]
  })
  const substitution = TypeInference.substitution(binders, arguments_)
  if (substitution === undefined) {
    const incompatible = binders.find((binder, ordinal) => {
      const argument = arguments_.at(ordinal)
      return (
        argument !== undefined && TypeInference.substitution([binder], [argument]) === undefined
      )
    })
    const ordinal = incompatible === undefined ? -1 : binders.indexOf(incompatible)
    const argument = ordinal < 0 ? undefined : arguments_.at(ordinal)
    if (incompatible !== undefined && argument !== undefined)
      return failed({ _tag: 'IncompatibleArguments', binder: incompatible, argument })
    return failed({
      _tag: 'IncompatibleConstraint',
      constraint: 'the complete inferred argument list',
    })
  }
  return { _tag: 'Inferred', arguments: arguments_, substitution }
}
