import * as AuthoredIdentity from './AuthoredIdentity.js'
import * as CallableContract from './CallableContract.js'
import type * as Instances from './Instances.js'
import * as Tir from './Tir.js'
import * as Type from './Type.js'

const nodeKey = (node: Tir.NodeRef): string =>
  `${Tir.artifactKey(node.artifact)}:${node.node.ordinal}`

/** Includes every original producer and capture coordinate, independently of cached type keys. */
export const key = (source: Tir.StoredInvocationSource): string =>
  JSON.stringify([
    source.target.module,
    source.target.name,
    source.producers.map((producer) => [
      nodeKey(producer.node),
      AuthoredIdentity.anchorKey(producer.origin),
      producer.kind,
      producer.binding?.ordinal,
    ]),
    source.originalInputs,
    source.parameters,
    source.captures.map((capture) => [
      capture.parameter,
      capture.capture,
      nodeKey(capture.expression),
      Tir.executableSiteKey(capture.leaf),
      capture.capturePath?.map((step) => [
        step._tag,
        Tir.executableSiteKey(step.site),
        step._tag === 'Capture' ? step.ordinal : undefined,
      ]),
    ]),
    [...source.originalSubstitution].map(([name, argument]) => [
      name,
      Type.genericArgumentKey(argument),
    ]),
  ])

/** Collects actual typed binding statements, including bindings inside delayed source bodies. */
const statements = (roots: ReadonlyArray<Tir.Statement>): ReadonlyArray<Tir.Statement> => {
  const result: Array<Tir.Statement> = []
  const seen = new Set<Tir.Statement>()
  const visit = (items: ReadonlyArray<Tir.Statement>): void => {
    for (const statement of items) {
      if (seen.has(statement)) continue
      seen.add(statement)
      result.push(statement)
      if (statement._tag === 'Unsafe') visit(statement.statements)
      else if (statement._tag === 'While') visit(statement.body)
      else if (statement._tag === 'If' || statement._tag === 'IfLet') {
        visit(statement.taken)
        visit(statement.otherwise)
      }
      for (const expression of Tir.statementExpressions(statement).flatMap(Tir.expressionTree)) {
        if (expression._tag === 'EffectBlock') visit(expression.statements)
        else if (expression._tag === 'Match')
          for (const arm of expression.arms)
            if (arm.body._tag === 'Block') visit(arm.body.statements)
      }
    }
  }
  visit(roots)
  return result
}

/** Rebuilds a stored section's lineage from held TIR rather than trusting copied call metadata. */
export const authentic = (
  caller: Instances.Instance,
  view: Tir.ExecutableInputView,
  operand: Tir.Expression,
): boolean => {
  const source = view.invocationSource
  if (source === undefined || !Type.isCallable(view.actual)) return false
  const schema = view.actual.schema
  if (
    schema?.source?.module !== source.target.module ||
    schema.source.name !== source.target.name ||
    view.actual.invocationUse !== undefined ||
    Type.callableInputOrdinals(schema.contract)?.join(',') !== source.originalInputs.join(',') ||
    schema.substitution.size !== source.originalSubstitution.size ||
    [...schema.substitution].some(([name, argument]) => {
      const held = source.originalSubstitution.get(name)
      return held === undefined || !Type.equalsGenericArgument(argument, held)
    })
  )
    return false
  const body = statements(caller.function.statements)
  const producers: Array<Tir.StoredInvocationSource['producers'][number]> = []
  const seen = new Set<Tir.Expression>()
  type Recipe = Pick<Tir.StoredInvocationSource, 'parameters' | 'captures'>
  const record = (
    expression: Tir.Expression,
    kind: Tir.StoredInvocationSource['producers'][number]['kind'],
    binding?: Tir.LocalId,
  ): boolean => {
    if (expression.id === undefined || expression.origin._tag !== 'Authored') return false
    producers.push({
      node: { artifact: caller.view.artifact, node: expression.id },
      origin: expression.origin.anchor,
      kind,
      ...(binding === undefined ? {} : { binding }),
    })
    return true
  }
  const walk = (expression: Tir.Expression): Recipe | undefined => {
    if (seen.has(expression) || expression._tag === 'Unavailable') return undefined
    seen.add(expression)
    if (expression._tag === 'Move') return walk(expression.subject)
    if (expression._tag === 'BindingReference') {
      const bindings = body.filter(
        (statement) =>
          statement._tag === 'Bind' && statement.binding.ordinal === expression.binding.ordinal,
      )
      const binding = bindings.at(0)
      if (
        bindings.length !== 1 ||
        binding?._tag !== 'Bind' ||
        binding.mutability !== 'Immutable' ||
        !record(expression, 'Binding', expression.binding)
      )
        return undefined
      return walk(binding.initializer)
    }
    if (expression._tag === 'CallableApply' && expression.staged !== undefined) {
      if (!record(expression, 'Stage')) return undefined
      const base = walk(expression.callee)
      const stage = expression.staged
      const count = expression.arguments.length
      if (base === undefined || count === 0 || count >= base.parameters.length) return undefined
      const captures: Array<Tir.StoredInvocationSource['captures'][number]> = base.captures.map(
        (capture) => ({
          ...capture,
          capturePath: [
            { _tag: 'Base', site: stage.site },
            ...(capture.capturePath ?? [
              { _tag: 'Capture', site: capture.leaf, ordinal: capture.capture },
            ]),
          ],
        }),
      )
      if (stage.captures.length !== count) return undefined
      for (const [ordinal, capture] of stage.captures.entries()) {
        const argument = expression.arguments.at(ordinal)
        const parameter = base.parameters.at(base.parameters.length - count + ordinal)
        if (
          argument?.id === undefined ||
          argument._tag === 'Unavailable' ||
          parameter === undefined ||
          capture.ordinal !== ordinal ||
          capture.parameterOrdinal !== parameter ||
          AuthoredIdentity.anchorKey(capture.argument) !==
            AuthoredIdentity.anchorKey(argument.origin.anchor) ||
          !Type.equals(capture.type, argument.type)
        )
          return undefined
        captures.push({
          parameter,
          capture: ordinal,
          expression: { artifact: caller.view.artifact, node: argument.id },
          leaf: stage.site,
          capturePath: [{ _tag: 'Capture', site: stage.site, ordinal }],
        })
      }
      return { parameters: base.parameters.slice(0, -count), captures }
    }
    if (expression._tag !== 'CallableSection' && expression._tag !== 'FunctionItem')
      return undefined
    if (
      expression.target._tag !== 'DeclarationCallableTarget' ||
      expression.target.declaration.module !== source.target.module ||
      expression.target.declaration.name !== source.target.name ||
      expression.type.schema === undefined ||
      CallableContract.key(expression.type.schema.contract) !==
        CallableContract.key(schema.contract) ||
      !record(expression, expression._tag === 'CallableSection' ? 'Section' : 'FunctionItem')
    )
      return undefined
    if (expression._tag === 'FunctionItem')
      return { parameters: source.originalInputs, captures: [] }
    const captures: Array<Tir.StoredInvocationSource['captures'][number]> = []
    for (const capture of expression.captures) {
      if (!source.originalInputs.includes(capture.parameterOrdinal)) continue
      if (capture.value.id === undefined) return undefined
      captures.push({
        parameter: capture.parameterOrdinal,
        capture: capture.ordinal,
        expression: { artifact: caller.view.artifact, node: capture.value.id },
        leaf: expression.site,
      })
    }
    return { parameters: expression.remainingParameters, captures }
  }
  const recipe = walk(operand)
  if (recipe === undefined) return false
  const covered = [...recipe.parameters, ...recipe.captures.map((capture) => capture.parameter)]
  if (
    covered.length !== source.originalInputs.length ||
    new Set(covered).size !== covered.length ||
    covered.some((ordinal) => !source.originalInputs.includes(ordinal)) ||
    recipe.parameters.length !== view.actual.parameters.length
  )
    return false
  return key({ ...source, producers, ...recipe }) === key(source)
}
