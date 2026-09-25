import * as ConformanceProof from './ConformanceProof.js'
import type * as DeclarationIndex from './DeclarationIndex.js'
import * as Diagnostic from './Diagnostic.js'
import * as Tir from './Tir.js'
import * as Instances from './Instances.js'
import type * as SourceSpan from './SourceSpan.js'
import * as Type from './Type.js'

type SharedFromAllocation = Extract<Tir.Expression, { readonly _tag: 'BuiltinCall' }>
type ExecutionFromAllocation = Extract<Tir.Expression, { readonly _tag: 'BuiltinCall' }>

interface ConcreteOrigin {
  readonly _tag: 'ConcreteOrigin'
  readonly element: Type.Type
  readonly span: SourceSpan.SourceSpan
}

interface ExecutionOrigin {
  readonly _tag: 'ExecutionOrigin'
  readonly arguments: ReadonlyArray<Type.GenericArgument>
  readonly span: SourceSpan.SourceSpan
}

interface ParameterOrigin {
  readonly _tag: 'ParameterOrigin'
  readonly ordinal: number
}

interface InvalidOrigin {
  readonly _tag: 'InvalidOrigin'
  readonly description: string
  readonly span: SourceSpan.SourceSpan
}

interface ConflictOrigin {
  readonly _tag: 'ConflictOrigin'
  readonly span: SourceSpan.SourceSpan
}

interface UnreachedOrigin {
  readonly _tag: 'UnreachedOrigin'
}

interface ServiceOrigin {
  readonly _tag: 'ServiceOrigin'
  readonly owner: Instances.Instance
  readonly service: Type.Nominal
  readonly operation: string
  readonly role: string
  readonly layout: Origin
  readonly span: SourceSpan.SourceSpan
}

interface ProviderBoundOrigin {
  readonly _tag: 'ProviderBoundOrigin'
  readonly protected: Origin
  readonly owner: Instances.Instance
  readonly provider: Extract<Tir.Expression, { readonly _tag: 'EffectBindRequirement' }>['provider']
  readonly span: SourceSpan.SourceSpan
}

type Origin =
  | ConcreteOrigin
  | ExecutionOrigin
  | ParameterOrigin
  | InvalidOrigin
  | ConflictOrigin
  | UnreachedOrigin
  | ServiceOrigin
  | ProviderBoundOrigin

/** One exact TIR initializer whose allocation originated at `sharedLayout<T>`. */
export interface Fact {
  readonly _tag: 'LocalSharedAllocationProvenanceFact'
  readonly owner: string
  readonly expression: SharedFromAllocation
  readonly element: Type.Type
  readonly span: SourceSpan.SourceSpan
}

/** One exact TIR initializer whose allocation originated at the same execution layout. */
export interface ExecutionFact {
  readonly _tag: 'ExecutionAllocationProvenanceFact'
  readonly owner: string
  readonly expression: ExecutionFromAllocation
  readonly arguments: ReadonlyArray<Type.GenericArgument>
  readonly span: SourceSpan.SourceSpan
}

/** Canonical interprocedural provenance facts retained by target layout planning and MIR lowering. */
export interface Plan {
  readonly _tag: 'LocalSharedAllocationProvenancePlan'
  readonly facts: ReadonlyArray<Fact>
  readonly executionFacts: ReadonlyArray<ExecutionFact>
  readonly diagnostics: ReadonlyArray<Diagnostic.Diagnostic>
}

const unreached: UnreachedOrigin = { _tag: 'UnreachedOrigin' }

const sameSpan = (left: SourceSpan.SourceSpan, right: SourceSpan.SourceSpan): boolean =>
  left.sourceId === right.sourceId && left.start === right.start && left.end === right.end

const sameOrigin = (left: Origin, right: Origin): boolean => {
  if (left._tag !== right._tag) return false
  switch (left._tag) {
    case 'ConcreteOrigin':
      return right._tag === 'ConcreteOrigin' && Type.equals(left.element, right.element)
    case 'ExecutionOrigin':
      return (
        right._tag === 'ExecutionOrigin' &&
        left.arguments.length === right.arguments.length &&
        left.arguments.every((argument, ordinal) => {
          const other = right.arguments.at(ordinal)
          return (
            other !== undefined &&
            Type.genericArgumentKey(argument) === Type.genericArgumentKey(other)
          )
        })
      )
    case 'ParameterOrigin':
      return right._tag === 'ParameterOrigin' && left.ordinal === right.ordinal
    case 'InvalidOrigin':
      return right._tag === 'InvalidOrigin' && left.description === right.description
    case 'ConflictOrigin':
    case 'UnreachedOrigin':
      return true
    case 'ServiceOrigin':
      return (
        right._tag === 'ServiceOrigin' &&
        ownerKey(left.owner) === ownerKey(right.owner) &&
        Type.equals(left.service, right.service) &&
        left.operation === right.operation &&
        left.role === right.role &&
        sameOrigin(left.layout, right.layout)
      )
    case 'ProviderBoundOrigin':
      return (
        right._tag === 'ProviderBoundOrigin' &&
        ownerKey(left.owner) === ownerKey(right.owner) &&
        sameSpan(left.provider.span, right.provider.span) &&
        sameOrigin(left.protected, right.protected)
      )
  }
}

const originSpan = (origin: Origin): SourceSpan.SourceSpan | undefined =>
  origin._tag === 'ConcreteOrigin' ||
  origin._tag === 'ExecutionOrigin' ||
  origin._tag === 'InvalidOrigin' ||
  origin._tag === 'ConflictOrigin' ||
  origin._tag === 'ServiceOrigin' ||
  origin._tag === 'ProviderBoundOrigin'
    ? origin.span
    : undefined

const mergeOrigin = (left: Origin, right: Origin): Origin => {
  if (left._tag === 'UnreachedOrigin') return right
  if (right._tag === 'UnreachedOrigin' || sameOrigin(left, right)) return left
  const span = originSpan(left) ?? originSpan(right)
  return span === undefined ? unreached : { _tag: 'ConflictOrigin', span }
}

const ownerKey = (instance: Instances.Instance): string => Instances.keyText(instance.key)

const callsByOwnerCache = new WeakMap<
  ReadonlyArray<Instances.CallInstance>,
  Map<string, Array<Instances.CallInstance>>
>()

const callsByOwner = (
  calls: ReadonlyArray<Instances.CallInstance>,
): Map<string, Array<Instances.CallInstance>> => {
  let index = callsByOwnerCache.get(calls)
  if (index === undefined) {
    index = new Map()
    for (const call of calls) {
      const owner = Instances.keyText(call.owner)
      const bucket = index.get(owner)
      if (bucket === undefined) index.set(owner, [call])
      else bucket.push(call)
    }
    callsByOwnerCache.set(calls, index)
  }
  return index
}

const nestedStatements = (
  statements: ReadonlyArray<Tir.Statement>,
): ReadonlyArray<Tir.Statement> => {
  const found: Array<Tir.Statement> = []
  const seen = new Set<Tir.Statement>()
  const visit = (items: ReadonlyArray<Tir.Statement>): void => {
    for (const statement of items) {
      if (seen.has(statement)) continue
      seen.add(statement)
      found.push(statement)
      if (statement._tag === 'Unsafe') visit(statement.statements)
      if (statement._tag === 'If' || statement._tag === 'IfLet') {
        visit(statement.taken)
        visit(statement.otherwise)
      }
      if (statement._tag === 'While') visit(statement.body)
      for (const expression of Tir.statementExpressions(statement).flatMap(Tir.expressionTree)) {
        if (expression._tag === 'EffectBlock') visit(expression.statements)
      }
    }
  }
  visit(statements)
  return found
}

interface ArgumentSource {
  readonly owner: Instances.Instance
  readonly expression: Tir.Expression
}

interface FunctionContext {
  readonly instance: Instances.Instance
  readonly bindings: ReadonlyMap<number, Tir.Expression>
  readonly patternBindings: ReadonlyMap<string, Tir.Expression>
  readonly writtenBindings: ReadonlySet<number>
  readonly writtenParameters: ReadonlySet<number>
}

const patternBindingKey = (
  binding: Extract<Tir.Expression, { readonly _tag: 'PatternBindingReference' }>['binding'],
): string => `${binding.ordinal}`

/** Plans exact source allocation provenance over specialized TIR, including ordinary calls. */
export const plan = (discovery: Instances.Discovery, index: DeclarationIndex.Index): Plan => {
  const instances = new Map(discovery.instances.map((instance) => [ownerKey(instance), instance]))
  const executionTargetsByOwner = new Map<string, Array<Instances.InstanceKey>>()
  for (const edge of discovery.executionEdges) {
    const owner = Instances.keyText(edge.owner)
    const targets = executionTargetsByOwner.get(owner) ?? []
    targets.push(edge.target)
    executionTargetsByOwner.set(owner, targets)
  }
  const contexts = new Map<string, FunctionContext>()
  for (const instance of discovery.instances) {
    const statements = nestedStatements(instance.function.statements)
    const replacedRoots = statements
      .flatMap(Tir.statementExpressions)
      .flatMap(Tir.expressionTree)
      .flatMap((expression) => (expression._tag === 'Replace' ? [expression.place.root] : []))
    contexts.set(ownerKey(instance), {
      instance,
      bindings: new Map(
        statements.flatMap((statement) =>
          statement._tag === 'Bind'
            ? [[statement.binding.ordinal, statement.initializer] as const]
            : [],
        ),
      ),
      patternBindings: new Map(
        statements
          .flatMap(Tir.statementExpressions)
          .flatMap(Tir.expressionTree)
          .flatMap((expression) =>
            expression._tag === 'Match'
              ? expression.arms.flatMap((arm) =>
                  arm.bindings.map(
                    (binding) => [patternBindingKey(binding.id), expression.scrutinee] as const,
                  ),
                )
              : [],
          ),
      ),
      writtenBindings: new Set([
        ...statements.flatMap((statement) =>
          statement._tag === 'Write' &&
          statement.place._tag === 'WritePlace' &&
          statement.place.root._tag === 'BindingWriteRoot'
            ? [statement.place.root.binding.ordinal]
            : [],
        ),
        ...replacedRoots.flatMap((root) =>
          root._tag === 'BindingWriteRoot' ? [root.binding.ordinal] : [],
        ),
      ]),
      writtenParameters: new Set([
        ...statements.flatMap((statement) =>
          statement._tag === 'Write' &&
          statement.place._tag === 'WritePlace' &&
          statement.place.root._tag === 'ParameterWriteRoot'
            ? [statement.place.root.parameter.ordinal]
            : [],
        ),
        ...replacedRoots.flatMap((root) =>
          root._tag === 'ParameterWriteRoot' ? [root.parameter.ordinal] : [],
        ),
      ]),
    })
  }

  const callAt = (
    instance: Instances.Instance,
    expression: { readonly span: SourceSpan.SourceSpan },
  ): Instances.CallInstance | undefined =>
    (callsByOwner(discovery.calls).get(ownerKey(instance)) ?? []).find((call) =>
      sameSpan(call.span, expression.span),
    )

  const targetAt = (
    instance: Instances.Instance,
    expression: Extract<
      Tir.Expression,
      { readonly _tag: 'Call' | 'EffectConstruct' | 'CallableApply' }
    >,
  ): Instances.Instance | undefined => {
    const recorded = callAt(instance, expression)
    if (recorded !== undefined) return instances.get(Instances.keyText(recorded.target))
    if (expression._tag === 'CallableApply') {
      return undefined
    }
    // A match shares the target's declaration; most unrecorded calls name one with no instance.
    if (Instances.instancesOf(discovery.instances, expression.target).length === 0) return undefined
    const typeArguments = expression.typeArguments.map((argument) =>
      Type.substituteGenericArgument(
        argument,
        instance.substitution,
        instance.specialization.compatibility,
      ),
    )
    const matches = Instances.matchingSpecialization(discovery, {
      declaration: expression.target,
      typeArguments,
    })
    return matches.length === 1 ? matches.at(0) : undefined
  }

  const incoming = new Map<string, Map<number, Array<ArgumentSource>>>()
  for (const caller of discovery.instances) {
    for (const expression of caller.function.statements
      .flatMap(Tir.statementExpressions)
      .flatMap(Tir.expressionTree)) {
      if (
        expression._tag !== 'Call' &&
        expression._tag !== 'EffectConstruct' &&
        expression._tag !== 'CallableApply'
      )
        continue
      const target = targetAt(caller, expression)
      if (target === undefined) continue
      const parameters = incoming.get(ownerKey(target)) ?? new Map<number, Array<ArgumentSource>>()
      incoming.set(ownerKey(target), parameters)
      const add = (ordinal: number, value: Tir.Expression): void => {
        const sources = parameters.get(ordinal) ?? []
        sources.push({ owner: caller, expression: value })
        parameters.set(ordinal, sources)
      }
      if (
        expression._tag === 'CallableApply' &&
        expression.realization === 'DirectErasedSection' &&
        expression.callee._tag === 'CallableSection'
      ) {
        expression.callee.remainingParameters.forEach((parameterOrdinal, ordinal) => {
          const argument = expression.arguments.at(ordinal)
          if (argument !== undefined) add(parameterOrdinal, argument)
        })
        for (const capture of expression.callee.captures)
          add(capture.parameterOrdinal, capture.value)
      } else expression.arguments.forEach((argument, ordinal) => add(ordinal, argument))
    }
  }

  const effectsByIdentity = new Map<string, Instances.EffectInstance>()
  for (const effect of discovery.effects)
    if (!effectsByIdentity.has(effect.identity)) effectsByIdentity.set(effect.identity, effect)

  // Directly forwarded Effects need no materialized environment in discovery.effects. Their
  // concrete construction still reaches this parameter through the ordinary call graph.
  const executionSourcesFrom = (
    instance: Instances.Instance,
    expression: Tir.Expression,
    visited: Set<string>,
  ): ReadonlyArray<Instances.Instance> => {
    const key = `${ownerKey(instance)}:${expression._tag}:${expression.span.start}:${expression.span.end}`
    if (visited.has(key)) return []
    visited.add(key)
    if (expression._tag === 'Move')
      return executionSourcesFrom(instance, expression.subject, visited)
    if (expression._tag === 'UnionConvert')
      return executionSourcesFrom(instance, expression.source, visited)
    if (expression._tag === 'EffectBindRequirement')
      return executionSourcesFrom(instance, expression.protected, visited)
    if (expression._tag === 'BindingReference') {
      const context = contexts.get(ownerKey(instance))
      if (context?.writtenBindings.has(expression.binding.ordinal)) return []
      const initializer = context?.bindings.get(expression.binding.ordinal)
      return initializer === undefined ? [] : executionSourcesFrom(instance, initializer, visited)
    }
    if (expression._tag === 'ParameterReference') {
      const identity = Instances.parameterEffectIdentity(
        instance.function,
        instance.key,
        expression.parameter.ordinal,
      )
      const effect = identity === undefined ? undefined : effectsByIdentity.get(identity)
      const owner =
        effect === undefined ? undefined : instances.get(Instances.keyText(effect.owner))
      return owner === undefined
        ? (incoming.get(ownerKey(instance))?.get(expression.parameter.ordinal) ?? []).flatMap(
            (source) => executionSourcesFrom(source.owner, source.expression, visited),
          )
        : [owner]
    }
    if (
      expression._tag === 'Call' ||
      expression._tag === 'EffectConstruct' ||
      expression._tag === 'CallableApply'
    ) {
      const target = targetAt(instance, expression)
      return target === undefined ? [] : [target]
    }
    return expression._tag === 'EffectBlock' ? [instance] : []
  }

  // A walk from a fresh visited set depends only on the settled call graph; provider
  // reachability repeats it for every service owner it tests.
  const executionSourceWalks = new Map<
    Tir.Expression,
    Map<string, ReadonlyArray<Instances.Instance>>
  >()
  const executionSources = (
    instance: Instances.Instance,
    expression: Tir.Expression,
  ): ReadonlyArray<Instances.Instance> => {
    let byOwner = executionSourceWalks.get(expression)
    if (byOwner === undefined) {
      byOwner = new Map()
      executionSourceWalks.set(expression, byOwner)
    }
    const owner = ownerKey(instance)
    let sources = byOwner.get(owner)
    if (sources === undefined) {
      sources = executionSourcesFrom(instance, expression, new Set())
      byOwner.set(owner, sources)
    }
    return sources
  }

  const summaries = new Map<string, Origin>()
  const summarize = (instance: Instances.Instance, resolving: ReadonlySet<string>): Origin => {
    const identity = ownerKey(instance)
    const cached = summaries.get(identity)
    if (cached !== undefined) return cached
    const returns = Tir.returnExpressions(instance.function.statements)
    const firstReturn = returns.at(0)
    if (firstReturn === undefined) return unreached
    if (resolving.has(identity))
      return {
        _tag: 'InvalidOrigin',
        description: 'recursive or unresolved allocation provenance',
        span: firstReturn.span,
      }
    const parameters = instance.function.declaration.parameters.map((_, ordinal): Origin => ({
      _tag: 'ParameterOrigin',
      ordinal,
    }))
    const result = returns
      .map((expression) =>
        originOf(expression, instance, parameters, new Set([...resolving, identity])),
      )
      .reduce(mergeOrigin, unreached)
    summaries.set(identity, result)
    return result
  }

  const substitute = (origin: Origin, arguments_: ReadonlyArray<Origin>): Origin => {
    if (origin._tag === 'ParameterOrigin') return arguments_.at(origin.ordinal) ?? unreached
    if (origin._tag === 'ServiceOrigin')
      return { ...origin, layout: substitute(origin.layout, arguments_) }
    if (origin._tag === 'ProviderBoundOrigin')
      return { ...origin, protected: substitute(origin.protected, arguments_) }
    return origin
  }

  function originOf(
    expression: Tir.Expression,
    instance: Instances.Instance,
    parameterOrigins: ReadonlyArray<Origin>,
    resolving: ReadonlySet<string>,
    activeBindings = new Set<number>(),
  ): Origin {
    const context = contexts.get(ownerKey(instance))
    if (
      expression._tag === 'ParameterReference' &&
      context?.writtenParameters.has(expression.parameter.ordinal)
    )
      return {
        _tag: 'InvalidOrigin',
        description: 'mutable parameter allocation provenance',
        span: expression.span,
      }
    if (expression._tag === 'ParameterReference')
      return parameterOrigins.at(expression.parameter.ordinal) ?? unreached
    if (expression._tag === 'BindingReference') {
      if (context?.writtenBindings.has(expression.binding.ordinal))
        return {
          _tag: 'InvalidOrigin',
          description: 'mutable allocation provenance',
          span: expression.span,
        }
      if (activeBindings.has(expression.binding.ordinal))
        return {
          _tag: 'InvalidOrigin',
          description: 'recursive allocation provenance',
          span: expression.span,
        }
      const initializer = context?.bindings.get(expression.binding.ordinal)
      return initializer === undefined
        ? {
            _tag: 'InvalidOrigin',
            description: 'unknown allocation provenance',
            span: expression.span,
          }
        : originOf(
            initializer,
            instance,
            parameterOrigins,
            resolving,
            new Set(activeBindings).add(expression.binding.ordinal),
          )
    }
    if (expression._tag === 'PatternBindingReference') {
      const scrutinee = context?.patternBindings.get(patternBindingKey(expression.binding))
      return scrutinee === undefined
        ? {
            _tag: 'InvalidOrigin',
            description: 'unknown pattern allocation provenance',
            span: expression.span,
          }
        : originOf(scrutinee, instance, parameterOrigins, resolving, activeBindings)
    }
    if (expression._tag === 'Move' || expression._tag === 'Run')
      return originOf(expression.subject, instance, parameterOrigins, resolving, activeBindings)
    if (expression._tag === 'UnionConvert')
      return originOf(expression.source, instance, parameterOrigins, resolving, activeBindings)
    if (expression._tag === 'EffectBindRequirement')
      return {
        _tag: 'ProviderBoundOrigin',
        protected: originOf(
          expression.protected,
          instance,
          parameterOrigins,
          resolving,
          activeBindings,
        ),
        owner: instance,
        provider: expression.provider,
        span: expression.span,
      }
    if (expression._tag === 'EffectCatch')
      return originOf(expression.protected, instance, parameterOrigins, resolving, activeBindings)
    if (expression._tag === 'EffectBlock') {
      const returns = Tir.returnExpressions(expression.statements)
      return returns.length === 0
        ? unreached
        : returns
            .map((returned) =>
              originOf(returned, instance, parameterOrigins, resolving, activeBindings),
            )
            .reduce(mergeOrigin, unreached)
    }
    if (expression._tag === 'Match')
      return expression.arms
        .filter((arm) => arm.reachable)
        .map((arm) =>
          arm.body._tag === 'Expression'
            ? originOf(arm.body.expression, instance, parameterOrigins, resolving, activeBindings)
            : unreached,
        )
        .reduce(mergeOrigin, unreached)
    if (expression._tag === 'BuiltinCall' && expression.operation === 'SharedLayout') {
      const raw = expression.typeArguments.at(0)
      return raw !== undefined && Type.isTypeArgument(raw)
        ? {
            _tag: 'ConcreteOrigin',
            element: Type.substitute(
              raw,
              instance.substitution,
              instance.specialization.compatibility,
            ),
            span: expression.span,
          }
        : {
            _tag: 'InvalidOrigin',
            description: 'unknown layout provenance',
            span: expression.span,
          }
    }
    if (expression._tag === 'BuiltinCall' && expression.operation === 'ExecutionLayout')
      return {
        _tag: 'ExecutionOrigin',
        arguments: expression.typeArguments.map((argument) =>
          Type.substituteGenericArgument(
            argument,
            instance.substitution,
            instance.specialization.compatibility,
          ),
        ),
        span: expression.span,
      }
    if (expression._tag === 'BuiltinCall' && expression.operation === 'StorageAcquire') {
      const argument = expression.arguments.at(0)
      return argument === undefined
        ? {
            _tag: 'InvalidOrigin',
            description: 'unknown layout provenance',
            span: expression.span,
          }
        : originOf(argument, instance, parameterOrigins, resolving, activeBindings)
    }
    if (expression._tag === 'ServiceEffectConstruct') {
      if (!Type.equals(expression.type.success, Type.allocation))
        return {
          _tag: 'InvalidOrigin',
          description: 'non-allocation effect provenance',
          span: expression.span,
        }
      const layouts = expression.arguments.filter(
        (argument) =>
          'type' in argument &&
          Type.equals(
            Type.substitute(
              argument.type,
              instance.substitution,
              instance.specialization.compatibility,
            ),
            Type.layout,
          ),
      )
      const layout = layouts.length === 1 ? layouts.at(0) : undefined
      const service = Type.substitute(
        expression.service,
        instance.substitution,
        instance.specialization.compatibility,
      )
      return layout === undefined || !Type.isNominal(service)
        ? {
            _tag: 'InvalidOrigin',
            description: 'unknown allocator layout provenance',
            span: expression.span,
          }
        : {
            _tag: 'ServiceOrigin',
            owner: instance,
            service,
            operation: expression.operation,
            role: expression.role,
            layout: originOf(layout, instance, parameterOrigins, resolving, activeBindings),
            span: expression.span,
          }
    }
    if (expression._tag === 'Call' || expression._tag === 'EffectConstruct') {
      const target = targetAt(instance, expression)
      if (target === undefined)
        return {
          _tag: 'InvalidOrigin',
          description: 'unknown helper allocation provenance',
          span: expression.span,
        }
      const arguments_ = expression.arguments.map((argument) =>
        originOf(argument, instance, parameterOrigins, resolving, activeBindings),
      )
      return substitute(summarize(target, resolving), arguments_)
    }
    if (expression._tag === 'CallableApply') {
      const target = targetAt(instance, expression)
      if (target === undefined)
        return {
          _tag: 'InvalidOrigin',
          description: 'unknown callable allocation provenance',
          span: expression.span,
        }
      const arguments_: Array<Origin> = Array.from(
        { length: target.function.declaration.parameterCount },
        () => unreached,
      )
      if (
        expression.realization === 'DirectErasedSection' &&
        expression.callee._tag === 'CallableSection'
      ) {
        expression.callee.remainingParameters.forEach((parameterOrdinal, ordinal) => {
          const argument = expression.arguments.at(ordinal)
          if (argument !== undefined)
            arguments_[parameterOrdinal] = originOf(
              argument,
              instance,
              parameterOrigins,
              resolving,
              activeBindings,
            )
        })
        for (const capture of expression.callee.captures)
          arguments_[capture.parameterOrdinal] = originOf(
            capture.value,
            instance,
            parameterOrigins,
            resolving,
            activeBindings,
          )
      } else {
        expression.arguments.forEach((argument, ordinal) => {
          arguments_[ordinal] = originOf(
            argument,
            instance,
            parameterOrigins,
            resolving,
            activeBindings,
          )
        })
      }
      return substitute(summarize(target, resolving), arguments_)
    }
    return {
      _tag: 'InvalidOrigin',
      description: 'non-shared layout provenance',
      span: expression.span,
    }
  }

  interface Provider {
    readonly capability: Type.Nominal
    readonly providerType: Type.Nominal
    readonly role: string
    readonly witness: NonNullable<ReturnType<typeof ConformanceProof.witness>>
  }

  const selectedProvider = (
    owner: Instances.Instance,
    provider: ProviderBoundOrigin['provider'],
  ): Provider | undefined => {
    const proof = Instances.requirementSelection(owner, provider)
    if (proof === undefined) return undefined
    const capability = proof.selected.capability
    const providerType = proof.provider
    if (capability === undefined || !Type.isNominal(capability) || !Type.isNominal(providerType))
      return undefined
    const witness = provider.witness ?? ConformanceProof.witness(index, providerType, capability)
    return witness === undefined
      ? undefined
      : {
          capability,
          providerType,
          role: proof.selected.role,
          witness,
        }
  }

  // Every provider binding in the program, and the providers each service owner is reached
  // through: both depend only on the settled discovery graph, so service origins sharing an owner
  // share one program scan.
  let bindRequirementSitesCache:
    | ReadonlyArray<{
        readonly caller: Instances.Instance
        readonly binding: Extract<Tir.Expression, { readonly _tag: 'EffectBindRequirement' }>
      }>
    | undefined
  const bindRequirementSites = () =>
    (bindRequirementSitesCache ??= discovery.instances.flatMap((caller) =>
      caller.function.statements
        .flatMap(Tir.statementExpressions)
        .flatMap(Tir.expressionTree)
        .flatMap((binding) =>
          binding._tag === 'EffectBindRequirement' ? [{ caller, binding }] : [],
        ),
    ))
  const forwardedProviders = new Map<string, ReadonlyArray<Provider>>()

  const sameProvidedOwner = (
    candidate: Instances.InstanceKey['declaration'],
    expected: Instances.InstanceKey['declaration'],
  ): boolean =>
    candidate.module === expected.module &&
    (candidate.name === expected.name || candidate.name.startsWith(`${expected.name}$provided$`))
  // The parameter and binding references each body runs as an Effect, in body order.
  const runSources = new Map<string, ReadonlyArray<Tir.Expression>>()
  const runSourcesOf = (candidate: Instances.Instance): ReadonlyArray<Tir.Expression> => {
    const identity = ownerKey(candidate)
    let sources = runSources.get(identity)
    if (sources === undefined) {
      sources = candidate.function.statements
        .flatMap(Tir.statementExpressions)
        .flatMap(Tir.expressionTree)
        .flatMap((expression) =>
          expression._tag === 'Run'
            ? Tir.expressionTree(expression.subject).filter(
                (nested) =>
                  nested._tag === 'ParameterReference' || nested._tag === 'BindingReference',
              )
            : [],
        )
      runSources.set(identity, sources)
    }
    return sources
  }
  // Per expected owner: nodes whose complete exploration never reached it, and roots proved to
  // reach it. A failed search explores every node it visits, so each is proved unreachable; a
  // successful one proves only its root. Either fact answers later searches exactly.
  const reachability = new Map<
    string,
    { readonly unreachable: Set<string>; readonly reaching: Set<string> }
  >()
  const searchExecutionOwner = (
    candidate: Instances.Instance,
    expected: Instances.Instance,
    seen: Set<string>,
    unreachable: ReadonlySet<string>,
    reaching: ReadonlySet<string>,
  ): boolean => {
    const identity = ownerKey(candidate)
    if (seen.has(identity) || unreachable.has(identity)) return false
    if (
      reaching.has(identity) ||
      identity === ownerKey(expected) ||
      sameProvidedOwner(candidate.key.declaration, expected.key.declaration)
    )
      return true
    // Execution edges include bracket callbacks that ordinary call records omit.
    // The set is shared across sibling branches, not copied per path: a caller fully explored
    // without reaching the owner cannot reach it through another path either, so reachability is
    // unchanged while the walk stays linear in the call graph.
    seen.add(identity)
    if (
      (executionTargetsByOwner.get(identity) ?? []).some((targetKey) => {
        const target = instances.get(Instances.keyText(targetKey))
        return (
          target !== undefined &&
          searchExecutionOwner(target, expected, seen, unreachable, reaching)
        )
      })
    )
      return true
    // Running a captured Effect is an execution edge even when no ordinary call targets its
    // owner. Recovery combinators, for example, execute a protected Effect parameter. Follow
    // its specialized identity rather than recognizing the combinator's declaration spelling.
    // A source wrapper may first store the bound recipe in an immutable local; resolve that
    // binding through the same execution-source graph before following its protected parameter.
    return runSourcesOf(candidate).some((nested) =>
      executionSources(candidate, nested).some((owner) =>
        searchExecutionOwner(owner, expected, seen, unreachable, reaching),
      ),
    )
  }
  const reachesExecutionOwner = (
    candidate: Instances.Instance,
    expected: Instances.Instance,
  ): boolean => {
    const target = ownerKey(expected)
    let known = reachability.get(target)
    if (known === undefined) {
      known = { unreachable: new Set(), reaching: new Set() }
      reachability.set(target, known)
    }
    const seen = new Set<string>()
    const reached = searchExecutionOwner(
      candidate,
      expected,
      seen,
      known.unreachable,
      known.reaching,
    )
    if (reached) known.reaching.add(ownerKey(candidate))
    else for (const identity of seen) known.unreachable.add(identity)
    return reached
  }
  const forwardedTo = (owner: Instances.Instance): ReadonlyArray<Provider> => {
    const identity = ownerKey(owner)
    const cached = forwardedProviders.get(identity)
    if (cached !== undefined) return cached
    const found = bindRequirementSites().flatMap(
      ({ caller, binding: candidate }): ReadonlyArray<Provider> => {
        const reachesOwner = Tir.expressionTree(candidate.protected).some((nested) => {
          if (nested._tag === 'ParameterReference' || nested._tag === 'BindingReference') {
            return executionSources(caller, nested).some((source) =>
              reachesExecutionOwner(source, owner),
            )
          }
          if (
            nested._tag !== 'Call' &&
            nested._tag !== 'EffectConstruct' &&
            nested._tag !== 'CallableApply'
          )
            return false
          const resultEffect = callAt(caller, nested)?.resultEffect
          const effect =
            resultEffect === undefined ? undefined : effectsByIdentity.get(resultEffect)
          if (effect !== undefined && sameProvidedOwner(effect.runner, owner.key.declaration))
            return true
          const target = targetAt(caller, nested)
          return target !== undefined && reachesExecutionOwner(target, owner)
        })
        if (!reachesOwner) return []
        const selected = selectedProvider(caller, candidate.provider)
        return selected === undefined ? [] : [selected]
      },
    )
    forwardedProviders.set(identity, found)
    return found
  }
  const resolve = (origin: Origin, providers: ReadonlyArray<Provider> = []): Origin => {
    if (origin._tag === 'ProviderBoundOrigin') {
      const selected = selectedProvider(origin.owner, origin.provider)
      return resolve(
        origin.protected,
        selected === undefined ? providers : [...providers, selected],
      )
    }
    if (origin._tag !== 'ServiceOrigin') return origin
    const explicitlyBound = [...providers]
      .reverse()
      .find(
        (candidate) =>
          candidate.role === origin.role && Type.equals(candidate.capability, origin.service),
      )
    // An ordinary effect helper executes with the provider bound around the helper construction at
    // its caller. The provider node therefore lives in the caller TIR, while the service operation
    // whose allocation provenance we must prove lives in the callee TIR. Follow that structural
    // call edge instead of requiring the helper to inline or recognizing it by declaration name.
    const forwarded = explicitlyBound === undefined ? forwardedTo(origin.owner) : []
    const candidates =
      explicitlyBound === undefined
        ? forwarded.filter(
            (candidate) =>
              candidate.role === origin.role && Type.equals(candidate.capability, origin.service),
          )
        : [explicitlyBound]
    if (candidates.length === 0)
      return {
        _tag: 'InvalidOrigin',
        description: 'unproved service allocation provenance',
        span: origin.span,
      }
    // One generic ordinary helper may be reached through several lexical provider bindings. Its
    // initializer is safe only when every reaching implementation preserves the requested layout;
    // selecting the first provider would let a valid caller authorize a forged sibling call.
    return candidates
      .map((provider): Origin => {
        if (provider.witness._tag !== 'SourceConformanceWitness')
          return {
            _tag: 'InvalidOrigin',
            description: 'unproved service allocation provenance',
            span: origin.span,
          }
        const implementation = ConformanceProof.witnessOperation(provider.witness, origin.operation)
        const targets =
          implementation === undefined
            ? []
            : Instances.matchingSpecialization(discovery, {
                declaration: implementation,
                typeArguments: provider.witness.typeArguments,
              })
        const target = targets.length === 1 ? targets.at(0) : undefined
        if (target === undefined)
          return {
            _tag: 'InvalidOrigin',
            description: 'unresolved service implementation provenance',
            span: origin.span,
          }
        const arguments_: Array<Origin> = target.specialization.parameters.map(() => ({
          _tag: 'InvalidOrigin' as const,
          description: 'non-layout service parameter provenance',
          span: origin.span,
        }))
        const layoutParameters = target.specialization.parameters.flatMap((parameter, ordinal) =>
          Type.equals(parameter, Type.layout) ? [ordinal] : [],
        )
        const layoutParameter = layoutParameters.length === 1 ? layoutParameters.at(0) : undefined
        if (layoutParameter === undefined)
          return {
            _tag: 'InvalidOrigin',
            description: 'unresolved service layout parameter provenance',
            span: origin.span,
          }
        arguments_[layoutParameter] = origin.layout
        const implementationOrigin = resolve(substitute(summarize(target, new Set()), arguments_))
        return implementationOrigin._tag === 'UnreachedOrigin'
          ? resolve(origin.layout, providers)
          : implementationOrigin
      })
      .reduce(mergeOrigin, unreached)
  }

  const parameterOrigins = new Map<string, Array<Origin>>()
  for (const instance of discovery.instances)
    parameterOrigins.set(
      ownerKey(instance),
      Array.from({ length: instance.function.declaration.parameterCount }, () => unreached),
    )

  let changed = true
  while (changed) {
    changed = false
    for (const [target, parameters] of incoming) {
      const targetParameters = parameterOrigins.get(target)
      if (targetParameters === undefined) continue
      for (const [ordinal, sources] of parameters) {
        for (const source of sources) {
          const previous = targetParameters.at(ordinal)
          const callerParameters = parameterOrigins.get(ownerKey(source.owner))
          if (previous === undefined || callerParameters === undefined) continue
          const next = mergeOrigin(
            previous,
            originOf(
              source.expression,
              source.owner,
              callerParameters,
              new Set([ownerKey(source.owner)]),
            ),
          )
          if (sameOrigin(previous, next)) continue
          targetParameters[ordinal] = next
          changed = true
        }
      }
    }
  }

  const facts: Array<Fact> = []
  const executionFacts: Array<ExecutionFact> = []
  const diagnostics: Array<Diagnostic.Diagnostic> = []
  for (const instance of discovery.instances) {
    const parameters = parameterOrigins.get(ownerKey(instance)) ?? []
    const seen = new Set<Tir.Expression>()
    for (const expression of instance.function.statements
      .flatMap(Tir.statementExpressions)
      .flatMap(Tir.expressionTree)) {
      if (seen.has(expression)) continue
      seen.add(expression)
      if (expression._tag !== 'BuiltinCall' || expression.operation !== 'SharedFromAllocation')
        continue
      const raw = expression.typeArguments.at(0)
      const allocation = expression.arguments.at(0)
      const expected =
        raw !== undefined && Type.isTypeArgument(raw)
          ? Type.substitute(raw, instance.substitution, instance.specialization.compatibility)
          : undefined
      const unresolved =
        allocation === undefined
          ? {
              _tag: 'InvalidOrigin' as const,
              description: 'missing allocation provenance',
              span: expression.span,
            }
          : originOf(allocation, instance, parameters, new Set([ownerKey(instance)]))
      const actual = resolve(unresolved)
      if (
        expected !== undefined &&
        actual._tag === 'ConcreteOrigin' &&
        Type.equals(expected, actual.element)
      ) {
        facts.push({
          _tag: 'LocalSharedAllocationProvenanceFact',
          owner: ownerKey(instance),
          expression,
          element: actual.element,
          span: actual.span,
        })
        continue
      }
      if (expected === undefined) continue
      const span =
        actual._tag === 'ConcreteOrigin' ||
        actual._tag === 'InvalidOrigin' ||
        actual._tag === 'ConflictOrigin'
          ? actual.span
          : (allocation?.span ?? expression.span)
      let description: string
      switch (actual._tag) {
        case 'ConcreteOrigin':
          description = Type.encode(actual.element)
          break
        case 'InvalidOrigin':
          description = actual.description
          break
        case 'ConflictOrigin':
          description = 'conflicting allocation provenance'
          break
        default:
          description = 'unknown allocation provenance'
          break
      }
      diagnostics.push(
        Diagnostic.localSharedLayoutMismatch(
          Type.encode(expected),
          description,
          span,
          expression.span,
        ),
      )
    }
  }
  for (const instance of discovery.instances) {
    const parameters = parameterOrigins.get(ownerKey(instance)) ?? []
    const seen = new Set<Tir.Expression>()
    for (const expression of instance.function.statements
      .flatMap(Tir.statementExpressions)
      .flatMap(Tir.expressionTree)) {
      if (seen.has(expression)) continue
      seen.add(expression)
      if (expression._tag !== 'BuiltinCall' || expression.operation !== 'ExecutionFromAllocation')
        continue
      const expected = expression.typeArguments.map((argument) =>
        Instances.concreteEffectRepresentationArgument(
          instance.function,
          instance.key,
          Type.substituteGenericArgument(
            argument,
            instance.substitution,
            instance.specialization.compatibility,
          ),
        ),
      )
      const allocation = expression.arguments.at(0)
      const unresolved =
        allocation === undefined
          ? {
              _tag: 'InvalidOrigin' as const,
              description: 'missing allocation provenance',
              span: expression.span,
            }
          : originOf(allocation, instance, parameters, new Set([ownerKey(instance)]))
      const actual = resolve(unresolved)
      const actualArguments =
        actual._tag === 'ExecutionOrigin'
          ? actual.arguments.map((argument) =>
              Instances.concreteEffectRepresentationArgument(
                instance.function,
                instance.key,
                argument,
              ),
            )
          : []
      if (
        actual._tag === 'ExecutionOrigin' &&
        expected.length === actualArguments.length &&
        expected.every((argument, ordinal) => {
          const other = actualArguments.at(ordinal)
          return (
            other !== undefined &&
            Type.genericArgumentKey(argument) === Type.genericArgumentKey(other)
          )
        })
      ) {
        executionFacts.push({
          _tag: 'ExecutionAllocationProvenanceFact',
          owner: ownerKey(instance),
          expression,
          arguments: expected,
          span: actual.span,
        })
        continue
      }
      const span = originSpan(actual) ?? allocation?.span ?? expression.span
      let description: string
      switch (actual._tag) {
        case 'ExecutionOrigin':
          description = actual.arguments.map(Type.genericArgumentKey).join(',')
          break
        case 'InvalidOrigin':
          description = actual.description
          break
        case 'ConflictOrigin':
          description = 'conflicting allocation provenance'
          break
        default:
          description = 'unknown allocation provenance'
          break
      }
      diagnostics.push(
        Diagnostic.executionLayoutMismatch(
          expected.map(Type.genericArgumentKey).join(','),
          description,
          span,
          expression.span,
        ),
      )
    }
  }
  return {
    _tag: 'LocalSharedAllocationProvenancePlan',
    facts: facts,
    executionFacts: executionFacts,
    diagnostics: Diagnostic.merge(diagnostics),
  }
}

/** Finds the exact source allocation fact for one specialized TIR initializer. */
export const find = (
  self: Plan,
  owner: Instances.InstanceKey,
  expression: SharedFromAllocation,
): Fact | undefined => {
  const identity = Instances.keyText(owner)
  return self.facts.find((fact) => fact.owner === identity && fact.expression === expression)
}

/** Finds the exact source allocation fact for one specialized execution initializer. */
export const findExecution = (
  self: Plan,
  owner: Instances.InstanceKey,
  expression: ExecutionFromAllocation,
): ExecutionFact | undefined => {
  const identity = Instances.keyText(owner)
  return self.executionFacts.find(
    (fact) => fact.owner === identity && fact.expression === expression,
  )
}

/** Empty provenance surface for hand-built layout plans. */
export const empty = (): Plan => ({
  _tag: 'LocalSharedAllocationProvenancePlan',
  facts: [],
  executionFacts: [],
  diagnostics: [],
})
