import * as ConformanceProof from './ConformanceProof.js'
import type {} from './EntryAssembly.js'
import type { FunctionLowering } from './FunctionLowering.js'
import type * as Tir from './Tir.js'
import * as Instances from './Instances.js'
import type { DelayedEffectState, ProvidedRequirement } from './Lower.js'
import type {} from './LowerExpression.js'
import * as Type from './Type.js'

export const delayedEffectState = (fn: FunctionLowering): DelayedEffectState => ({
  recipes: new Map(fn.effectRecipes),
  loanEnds: new Map(fn.effectLoanEnds),
  loanLocals: new Map(fn.loanLocals),
})

export const restoreDelayedEffectState = (
  fn: FunctionLowering,
  state: DelayedEffectState,
): void => {
  fn.effectRecipes.clear()
  for (const [binding, recipe] of state.recipes) fn.effectRecipes.set(binding, recipe)
  fn.effectLoanEnds.clear()
  for (const [binding, loans] of state.loanEnds) fn.effectLoanEnds.set(binding, loans)
  fn.loanLocals.clear()
  for (const [borrow, local_] of state.loanLocals) fn.loanLocals.set(borrow, local_)
}

export const directForwardedRequirementBinding = (
  instance: Instances.Instance,
): Extract<Tir.Expression, { readonly _tag: 'EffectBindRequirement' }> | undefined => {
  const returned = instance.function.statements.at(-1)
  if (instance.function.statements.length !== 1 || returned?._tag !== 'Return') return undefined
  const block = returned.expression
  if (block._tag !== 'EffectBlock' || block.statements.length !== 2) return undefined
  const binding = block.statements.at(0)
  const completed = block.statements.at(1)
  if (
    binding?._tag !== 'Bind' ||
    binding.initializer._tag !== 'EffectBindRequirement' ||
    binding.initializer.protected._tag !== 'Move' ||
    binding.initializer.protected.subject._tag !== 'ParameterReference' ||
    binding.initializer.protected.subject.parameter.ordinal !== 0 ||
    binding.initializer.provider.parameter?.ordinal !== 1 ||
    completed?._tag !== 'Return' ||
    completed.expression._tag !== 'Run' ||
    completed.expression.subject._tag !== 'BindingReference' ||
    completed.expression.subject.binding.ordinal !== binding.binding.ordinal
  )
    return undefined
  return binding.initializer
}

export const forwardedRequirementBinding = (
  instance: Instances.Instance,
  instances: ReadonlyArray<Instances.Instance>,
  calls: ReadonlyArray<Instances.CallInstance>,
  resolving: ReadonlySet<string> = new Set(),
):
  | {
      readonly instance: Instances.Instance
      readonly binding: Extract<Tir.Expression, { readonly _tag: 'EffectBindRequirement' }>
    }
  | undefined => {
  const direct = directForwardedRequirementBinding(instance)
  if (direct !== undefined) return { instance, binding: direct }
  const key_ = Instances.keyText(instance.key)
  if (resolving.has(key_)) return undefined
  const returned = instance.function.statements.at(-1)
  const block = returned?._tag === 'Return' ? returned.expression : undefined
  const completed = block?._tag === 'EffectBlock' ? block.statements.at(-1) : undefined
  const run = completed?._tag === 'Return' ? completed.expression : undefined
  const nested = run?._tag === 'Run' ? run.subject : undefined
  if (nested?._tag !== 'EffectConstruct' && nested?._tag !== 'Call') return undefined
  const call = Instances.callsAtSite(calls, instance.key, nested.span).at(0)
  const declared = Instances.instancesOf(instances, nested.target)
  const candidates = declared
    .filter(
      (candidate) =>
        call === undefined || Instances.keyText(candidate.key) === Instances.keyText(call.target),
    )
    .sort(
      (left, right) =>
        right.key.typeArguments.filter(Type.isHiddenExecutableArgument).length -
        left.key.typeArguments.filter(Type.isHiddenExecutableArgument).length,
    )
  const searchable = candidates.length === 0 && call !== undefined ? declared : candidates
  return searchable
    .map((candidate) =>
      forwardedRequirementBinding(candidate, instances, calls, new Set(resolving).add(key_)),
    )
    .find((binding) => binding !== undefined)
}

export const forwardedCallableParameter = (
  fn: FunctionLowering,
  instance: Instances.Instance,
  resolving: ReadonlySet<string> = new Set(),
): number | undefined => {
  const key_ = Instances.keyText(instance.key)
  if (resolving.has(key_)) return undefined
  const leading = instance.function.statements.slice(0, -1)
  const returned = instance.function.statements.at(-1)
  if (
    instance.function.contract._tag !== 'Contract' ||
    instance.function.contract.parameters.length !== 1 ||
    returned?._tag !== 'Return' ||
    leading.some((statement) => statement._tag !== 'Bind')
  )
    return undefined
  const next = new Set(resolving).add(key_)
  const forwardedBindings = new Set<number>()
  const expression = (
    current: Tir.Expression,
    resolvingBindings: ReadonlySet<number> = new Set(),
  ): number | undefined => {
    if (current._tag === 'Move') return expression(current.subject, resolvingBindings)
    if (current._tag === 'ParameterReference') return current.parameter.ordinal
    if (current._tag === 'BindingReference') {
      const ordinal = current.binding.ordinal
      if (resolvingBindings.has(ordinal)) return undefined
      const binding = leading.find(
        (statement) => statement._tag === 'Bind' && statement.binding.ordinal === ordinal,
      )
      if (binding?._tag !== 'Bind') return undefined
      forwardedBindings.add(ordinal)
      return expression(binding.initializer, new Set(resolvingBindings).add(ordinal))
    }
    if (current._tag !== 'Call') return undefined
    const target = Instances.instancesOf(fn.instances, current.target).at(0)
    const forwarded =
      target === undefined ? undefined : forwardedCallableParameter(fn, target, next)
    const argument = forwarded === undefined ? undefined : current.arguments.at(forwarded)
    return argument === undefined ? undefined : expression(argument, resolvingBindings)
  }
  const forwarded = expression(returned.expression)
  return forwarded === undefined ||
    leading.some(
      (statement) => statement._tag !== 'Bind' || !forwardedBindings.has(statement.binding.ordinal),
    )
    ? undefined
    : forwarded
}

const forwardedReferenceProvider = (
  fn: FunctionLowering,
  provider: Tir.Expression,
  access: 'Shared' | 'Exclusive' | 'Take',
  providerType: Type.Type,
):
  | {
      readonly parameter: Extract<
        Tir.Expression,
        { readonly _tag: 'ParameterReference' }
      >['parameter']
      readonly captureAccess: 'Copy' | 'Take'
    }
  | undefined => {
  const source = provider._tag === 'Move' ? provider.subject : provider
  if (access === 'Take' || source._tag !== 'ParameterReference') return undefined
  const type = fn.semantic(source.type)
  if (!Type.isReference(type) || type.access !== access || !Type.equals(type.target, providerType))
    return undefined
  return {
    parameter: source.parameter,
    captureAccess: provider._tag === 'Move' ? 'Take' : 'Copy',
  }
}

export const staticallyForwardedCallableRecipe = (
  fn: FunctionLowering,
  current: Tir.Expression,
  owner: Tir.TirFunction,
  arguments_: ReadonlyArray<Tir.Expression> = [],
  resolving: ReadonlySet<string> = new Set(),
): Extract<Tir.Expression, { readonly _tag: 'CallableSection' }> | undefined => {
  if (current._tag === 'CallableSection') return current
  if (current._tag === 'Move')
    return staticallyForwardedCallableRecipe(fn, current.subject, owner, arguments_, resolving)
  if (current._tag === 'ParameterReference') {
    const argument = arguments_.at(current.parameter.ordinal)
    return argument === undefined
      ? undefined
      : staticallyForwardedCallableRecipe(fn, argument, owner, arguments_, resolving)
  }
  if (current._tag === 'BindingReference') {
    const localBinding = owner.statements.find(
      (statement) =>
        statement._tag === 'Bind' && statement.binding.ordinal === current.binding.ordinal,
    )
    let stored: Tir.Expression | undefined
    if (owner === fn.owner.function) {
      stored = fn.callableRecipes.get(current.binding.ordinal)
    } else if (localBinding?._tag === 'Bind') {
      stored = localBinding.initializer
    } else {
      stored = undefined
    }
    return stored === undefined
      ? undefined
      : staticallyForwardedCallableRecipe(fn, stored, owner, arguments_, resolving)
  }
  if (current._tag !== 'Call') return undefined
  const identity = `${current.target.module}\u0000${current.target.name}`
  if (resolving.has(identity)) return undefined
  const target = Instances.instancesOf(fn.instances, current.target).at(0)
  const forwarded =
    target === undefined ? undefined : forwardedCallableParameter(fn, target, resolving)
  const argument = forwarded === undefined ? undefined : current.arguments.at(forwarded)
  return argument === undefined
    ? undefined
    : staticallyForwardedCallableRecipe(
        fn,
        argument,
        owner,
        arguments_,
        new Set(resolving).add(identity),
      )
}

export const callableRecipe = (
  fn: FunctionLowering,
  expression: Tir.Expression,
  resolving: ReadonlySet<number> = new Set(),
): Extract<Tir.Expression, { readonly _tag: 'CallableSection' }> | undefined => {
  if (expression._tag === 'CallableSection') return expression
  if (expression._tag === 'Move') return callableRecipe(fn, expression.subject, resolving)
  if (expression._tag === 'BindingReference') {
    if (resolving.has(expression.binding.ordinal)) return undefined
    const stored = fn.callableRecipes.get(expression.binding.ordinal)
    return stored === undefined
      ? undefined
      : callableRecipe(fn, stored, new Set(resolving).add(expression.binding.ordinal))
  }
  if (expression._tag === 'Call') {
    const forwarded = staticallyForwardedCallableRecipe(fn, expression, fn.owner.function)
    if (forwarded !== undefined) return forwarded
  }
  if (expression._tag !== 'CallableApply' && expression._tag !== 'Call') return undefined
  const call =
    expression._tag === 'Call'
      ? fn.call(
          expression,
          undefined,
          expression.typeArguments.map((argument) => fn.semanticArgument(argument)),
          expression.staticArguments,
        )
      : fn.call(expression)
  const target =
    (call === undefined ? undefined : Instances.instanceByKey(fn.instances, call.target)) ??
    (expression._tag === 'Call'
      ? Instances.instancesOf(fn.instances, expression.target).at(0)
      : undefined)
  const forwarded = target === undefined ? undefined : forwardedCallableParameter(fn, target)
  const argument = forwarded === undefined ? undefined : expression.arguments.at(forwarded)
  return argument === undefined ? undefined : callableRecipe(fn, argument, resolving)
}

export const effectRecipe = (
  fn: FunctionLowering,
  expression: Tir.Expression,
  resolving: ReadonlySet<number> = new Set(),
): Tir.Expression => {
  if (expression._tag === 'BindingReference') {
    const ordinal = expression.binding.ordinal
    if (resolving.has(ordinal)) return expression
    const stored = fn.effectRecipes.get(ordinal)
    return stored === undefined
      ? expression
      : effectRecipe(fn, stored, new Set(resolving).add(ordinal))
  }
  if (expression._tag === 'Move') {
    const subject = effectRecipe(fn, expression.subject, resolving)
    return subject === expression.subject ? expression : subject
  }
  return expression
}

export const movedEffectRecipe = (
  fn: FunctionLowering,
  expression: Tir.Expression,
):
  | {
      readonly source: number
      readonly recipe: Tir.Expression
      readonly loanEnds: ReadonlyArray<Tir.BorrowId>
    }
  | undefined => {
  if (expression._tag !== 'Move' || expression.subject._tag !== 'BindingReference') return undefined
  const source = expression.subject.binding.ordinal
  const recipe = fn.effectRecipes.get(source)
  return recipe === undefined
    ? undefined
    : {
        source,
        recipe,
        loanEnds: fn.effectLoanEnds.get(source) ?? [],
      }
}

export const callableApplicationArgument = (
  fn: FunctionLowering,
  expression: Extract<Tir.Expression, { readonly _tag: 'CallableApply' }>,
  ordinal: number,
): Tir.Expression | undefined => {
  const section = callableRecipe(fn, expression.callee)
  if (section === undefined) return expression.arguments.at(ordinal)
  const captured = section.captures.find((capture) => capture.parameterOrdinal === ordinal)
  if (captured !== undefined) return captured.value
  const argumentOrdinal = section.remainingParameters.indexOf(ordinal)
  return argumentOrdinal < 0 ? undefined : expression.arguments.at(argumentOrdinal)
}

export const inlineForwardedRequirement = (
  fn: FunctionLowering,
  expression: Tir.Expression,
):
  | {
      readonly binding: Extract<Tir.Expression, { readonly _tag: 'EffectBindRequirement' }>
      readonly provider: Tir.Expression
      readonly selection: Omit<ProvidedRequirement, 'local'>
    }
  | undefined => {
  if (expression._tag !== 'CallableApply' && expression._tag !== 'EffectConstruct') return undefined
  const call =
    expression._tag === 'EffectConstruct'
      ? fn.call(
          expression,
          undefined,
          expression.typeArguments.map((argument) => fn.semanticArgument(argument)),
          expression.staticArguments,
        )
      : fn.call(expression)
  const section =
    expression._tag === 'CallableApply' ? callableRecipe(fn, expression.callee) : undefined
  let declaration:
    | Extract<Tir.Expression, { readonly _tag: 'EffectConstruct' }>['target']
    | undefined
  if (expression._tag === 'EffectConstruct') {
    declaration = expression.target
  } else if (section?.target._tag === 'DeclarationCallableTarget') {
    declaration = section.target.declaration
  } else {
    declaration = undefined
  }
  const candidates =
    declaration === undefined ? [] : Instances.instancesOf(fn.instances, declaration)
  const inferredArguments = (() => {
    if (expression._tag === 'EffectConstruct')
      return expression.typeArguments.map((argument) => fn.semanticArgument(argument))
    if (section === undefined) return undefined
    const candidate = candidates.at(0)
    if (candidate === undefined) return undefined
    const inferred = new Map([...section.substitution, ...expression.substitution])
    const arguments_ = candidate.function.declaration.typeParameters.flatMap((parameter) => {
      const argument = inferred.get(Type.key(parameter.type))
      return argument === undefined ? [] : [fn.semanticArgument(argument)]
    })
    return arguments_.length === candidate.function.declaration.typeParameters.length
      ? arguments_
      : undefined
  })()
  let target: Instances.Instance | undefined
  if (call !== undefined) {
    target = Instances.instanceByKey(fn.instances, call.target)
  } else if (inferredArguments === undefined) {
    target = undefined
  } else {
    target =
      candidates
        .filter((candidate) => {
          const explicit = candidate.key.typeArguments.filter(
            (argument) => !Type.isHiddenExecutableArgument(argument),
          )
          return (
            explicit.length === inferredArguments.length &&
            explicit.every(
              (argument, ordinal) =>
                Type.genericArgumentKey(argument) ===
                Type.genericArgumentKey(inferredArguments.at(ordinal) ?? argument),
            )
          )
        })
        .sort(
          (left, right) =>
            right.key.typeArguments.filter(Type.isHiddenExecutableArgument).length -
            left.key.typeArguments.filter(Type.isHiddenExecutableArgument).length,
        )
        .at(0) ?? (candidates.length === 1 ? candidates.at(0) : undefined)
  }
  let resolved =
    target === undefined ? undefined : forwardedRequirementBinding(target, fn.instances, fn.calls)
  if (resolved !== undefined) target = resolved.instance
  let forwarded = resolved?.binding
  if (target === undefined || forwarded === undefined) {
    const candidate = candidates
      .filter(
        (candidate) => forwardedRequirementBinding(candidate, fn.instances, fn.calls) !== undefined,
      )
      .sort(
        (left, right) =>
          right.key.typeArguments.filter(Type.isHiddenExecutableArgument).length -
          left.key.typeArguments.filter(Type.isHiddenExecutableArgument).length,
      )
      .at(0)
    if (candidate !== undefined) {
      resolved = forwardedRequirementBinding(candidate, fn.instances, fn.calls)
      target = resolved?.instance
      forwarded = resolved?.binding
    }
  }
  if (target === undefined || forwarded === undefined) return undefined
  const protected_ =
    expression._tag === 'CallableApply'
      ? callableApplicationArgument(fn, expression, 0)
      : expression.arguments.at(0)
  const provider =
    expression._tag === 'CallableApply'
      ? callableApplicationArgument(fn, expression, 1)
      : expression.arguments.at(1)
  if (protected_ === undefined || provider === undefined) return undefined
  const borrowedProvider = provider._tag === 'ValueBorrow' ? provider : undefined
  let proof =
    target === undefined || forwarded === undefined
      ? undefined
      : Instances.requirementSelection(target, forwarded.provider)
  if (proof === undefined) {
    for (const candidate of candidates
      .filter((candidate) => candidate !== target)
      .sort(
        (left, right) =>
          right.key.typeArguments.filter(Type.isHiddenExecutableArgument).length -
          left.key.typeArguments.filter(Type.isHiddenExecutableArgument).length,
      )) {
      const candidateResolved = forwardedRequirementBinding(candidate, fn.instances, fn.calls)
      const candidateForwarded = candidateResolved?.binding
      const candidateProof =
        candidateResolved === undefined || candidateForwarded === undefined
          ? undefined
          : Instances.requirementSelection(candidateResolved.instance, candidateForwarded.provider)
      if (
        candidateResolved === undefined ||
        candidateForwarded === undefined ||
        candidateProof === undefined
      )
        continue
      target = candidateResolved.instance
      forwarded = candidateForwarded
      proof = candidateProof
      break
    }
  }
  if (target === undefined || forwarded === undefined || proof === undefined) return undefined
  const referenceProvider = forwardedReferenceProvider(
    fn,
    provider,
    forwarded.provider.selectionAccess,
    proof.provider,
  )
  // Pattern-rooted borrows remain valid here: the inline path lowers the original provider while
  // the selected match arm's ownership place is active, so it does not need a stored binding or
  // parameter identity in the synthetic requirement metadata below.
  if (
    borrowedProvider === undefined &&
    referenceProvider === undefined &&
    forwarded.provider.selectionAccess !== 'Take'
  )
    return undefined
  const selected = proof.selected
  const capability = selected.capability
  const providerType = proof.provider
  const type = fn.semantic(expression.type)
  if (
    capability === undefined ||
    !Type.isNominal(capability) ||
    !Type.isNominal(providerType) ||
    !Type.isEffect(type)
  )
    return undefined
  const witness = ConformanceProof.witness(fn.index, providerType, capability)
  if (witness === undefined) return undefined
  return {
    binding: {
      _tag: 'EffectBindRequirement',
      protected: protected_,
      provider: {
        ...(borrowedProvider?.root._tag === 'BindingSliceRoot'
          ? { binding: borrowedProvider.root.binding }
          : {}),
        ...(borrowedProvider?.root._tag === 'ParameterSliceRoot'
          ? { parameter: borrowedProvider.root.parameter }
          : {}),
        ...(referenceProvider?.parameter === undefined
          ? {}
          : { parameter: referenceProvider.parameter }),
        capability,
        selected: Type.requirementRowArgument([selected]).row,
        evidence: forwarded.provider.evidence,
        providerType,
        witness,
        role: selected.role,
        selectionAccess: forwarded.provider.selectionAccess,
        captureAccess:
          borrowedProvider?.access ?? referenceProvider?.captureAccess ?? ('Take' as const),
        span: provider.span,
      },
      type,
      span: expression.span,
      origin: expression.origin,
    },
    provider,
    selection: {
      capability,
      providerType,
      witness,
      role: selected.role,
      requirementAccess: selected.access,
      access: forwarded.provider.selectionAccess,
    },
  }
}
