import * as Elaboration from './Elaboration.js'
import type * as NameResolution from './NameResolution.js'
import * as SemanticDisplay from './SemanticDisplay.js'
import * as SourceSpan from './SourceSpan.js'
import type * as AuthoredHir from './AuthoredHir.js'
import type * as SemanticContext from './SemanticContext.js'
import type * as Tir from './Tir.js'
import * as BodyBuilder from './BodyBuilder.js'
import * as Type from './Type.js'

/** One inferred local-binding type anchored to its exact declared name. */
export interface BindingTypeHint {
  readonly _tag: 'BindingTypeHint'
  readonly span: SourceSpan.SourceSpan
  readonly presentation: SemanticDisplay.Presentation
}

/** One or more omitted provider selectors sharing one call-site insertion point. */
export interface ProviderSelectorTypeHint {
  readonly _tag: 'ProviderSelectorTypeHint'
  readonly span: SourceSpan.SourceSpan
  readonly selected: ReadonlyArray<Type.Requirement>
  readonly presentation: SemanticDisplay.Presentation
}

export type TypeHint = BindingTypeHint | ProviderSelectorTypeHint

const compareText = (left: string, right: string): number => {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

/**
 * The callee an omitted provider selector would be spelled after. The hint is inserted at the
 * end of that reference, which is where the authored argument list opens.
 */
/** The named end of one reference path, which is where the authored argument list opens. */
const pathAnchor = (path: Elaboration.ReferencePathFact): AuthoredHir.Anchor =>
  path._tag === 'ReferencePath' ? path.memberAnchor : path.anchor

const selectorCallee = (
  expression: Elaboration.ExpressionDecision,
  builder?: BodyBuilder.BodyBuilder,
): AuthoredHir.Anchor | undefined => {
  if (expression._tag === 'Call') return pathAnchor(expression.path)
  if (expression._tag !== 'CallableApply') return undefined
  if (expression.provenance._tag === 'DirectCallableApplication')
    return Elaboration.constructionExpressionAnchor(expression.callee)
  const callable = expression.provenance.callable
  if (callable._tag !== 'CallableSection') return undefined
  const semantic =
    builder === undefined ? undefined : BodyBuilder.semanticOfExpression(builder, callable)
  return semantic?._tag === 'CallableSection' ? pathAnchor(semantic.path) : callable.origin.anchor
}

const selectorFacts = (
  expression: Elaboration.ExpressionDecision,
): ReadonlyArray<Elaboration.InferredProviderSelector> => {
  if (expression._tag === 'Call') {
    if (expression.contract._tag === 'Compatible') {
      return expression.contract.inferredProviderSelectors
    }
    return []
  }
  if (expression._tag === 'CallableApply') return expression.inferredProviderSelectors
  return []
}

/**
 * What a body infers that its author did not write, as construction publishes it.
 *
 * Rows name authored nodes, never positions, so a reused body keeps them.
 */
export type Row =
  | {
      readonly _tag: 'Binding'
      readonly at: AuthoredHir.Anchor
      readonly type: Elaboration.SemanticType
    }
  | {
      readonly _tag: 'ProviderSelectors'
      /** The callee the omitted selectors would be spelled after. */
      readonly callee: AuthoredHir.Anchor
      readonly selectors: ReadonlyArray<Elaboration.InferredProviderSelector>
    }

/** The inference rows of one body. */
export const rows = (
  bindings: ReadonlyArray<Elaboration.BindingDeclarationFact>,
  statements: ReadonlyArray<Tir.Statement>,
  builder?: BodyBuilder.BodyBuilder,
): ReadonlyArray<Row> => {
  const found: Array<Row> = []
  for (const binding of bindings)
    if (binding.name._tag === 'Present' && binding.inferredType._tag === 'Available')
      found.push({
        _tag: 'Binding',
        at: binding.name.anchor,
        type: binding.inferredType.type,
      })
  const addSelectors = (expression: Elaboration.ExpressionDecision): void => {
    const selectors = selectorFacts(expression)
    const callee = selectors.length === 0 ? undefined : selectorCallee(expression, builder)
    if (callee !== undefined) found.push({ _tag: 'ProviderSelectors', callee, selectors })
  }
  Elaboration.visitStatements(statements, {
    expression: addSelectors,
    node: (node) => {
      const semantic =
        builder === undefined ? undefined : BodyBuilder.semanticOfExpression(builder, node)
      if (semantic !== undefined) addSelectors(semantic)
    },
  })
  return found
}

/** Projects published inference rows into one half-open byte range. */
export const make = (
  context: SemanticContext.SemanticContext,
  published: ReadonlyArray<Row>,
  module: string,
  scope: NameResolution.ModuleScope | undefined,
  start: number,
  end: number,
): ReadonlyArray<TypeHint> => {
  const seen = new Set<string>()
  const hints: Array<TypeHint> = []
  for (const binding of published) {
    if (binding._tag !== 'Binding') continue
    const span = context.spanOf(binding.at)
    if (span.start < start || span.end > end) continue
    const key = `${span.sourceId}:${span.start}:${span.end}`
    if (seen.has(key)) continue
    seen.add(key)
    hints.push({
      _tag: 'BindingTypeHint',
      span,
      presentation: SemanticDisplay.expressionType(binding.type, module, scope),
    })
  }

  const selectorGroups = new Map<
    string,
    {
      readonly span: SourceSpan.SourceSpan
      readonly selectors: Map<string, Elaboration.InferredProviderSelector>
    }
  >()
  for (const row of published) {
    if (row._tag !== 'ProviderSelectors') continue
    const calleeSpan = context.spanOf(row.callee)
    const span = SourceSpan.fromOffsets(calleeSpan.sourceId, calleeSpan.end, calleeSpan.end)
    if (span === undefined || span.start < start || span.start >= end) continue
    const key = `${span.sourceId}:${span.start}`
    const group = selectorGroups.get(key) ?? { span, selectors: new Map() }
    for (const selector of row.selectors) {
      if (!Type.isNominal(selector.selected.capability)) continue
      group.selectors.set(
        `${Type.key(selector.parameter)}:${Type.key(selector.selected.capability)}@${selector.selected.role}`,
        selector,
      )
    }
    selectorGroups.set(key, group)
  }
  for (const group of selectorGroups.values()) {
    const selectors = [...group.selectors.values()].sort(
      (left, right) =>
        left.parameter.ordinal - right.parameter.ordinal ||
        compareText(Type.key(left.selected.capability), Type.key(right.selected.capability)),
    )
    const selected = selectors.map((selector) => selector.selected)
    if (selected.length === 0) continue
    const text = selectors
      .flatMap((selector) =>
        Type.isNominal(selector.selected.capability)
          ? [
              SemanticDisplay.providerSelector(
                {
                  capability: selector.selected.capability,
                  role: selector.selected.role,
                },
                module,
                scope,
              ).text,
            ]
          : [],
      )
      .join(', ')
    hints.push({
      _tag: 'ProviderSelectorTypeHint',
      span: group.span,
      selected,
      presentation: { _tag: 'ExpressionTypePresentation', text },
    })
  }
  hints.sort(
    (left, right) =>
      left.span.start - right.span.start ||
      left.span.end - right.span.end ||
      compareText(left._tag, right._tag),
  )
  return hints
}
