import * as AuthoredIdentity from './AuthoredIdentity.js'
import type * as DeclarationFacts from './DeclarationFacts.js'
import * as Diagnostic from './Diagnostic.js'
import type * as Elaboration from './Elaboration.js'
import * as SemanticContext from './SemanticContext.js'
import type * as SourceSpan from './SourceSpan.js'
import * as Tir from './Tir.js'
import * as Type from './Type.js'

export type FlowItemState = 'Connected' | 'Stopped' | 'Branched' | 'Unmatched'
export type FlowNodeKind =
  | 'Argument'
  | 'Parameter'
  | 'Reference'
  | 'ReturnedValue'
  | 'CallResult'
  | 'FunctionReturn'
  | 'Terminal'

export interface FlowGroup {
  readonly _tag: 'FlowGroup'
  readonly id: string
  readonly label: string
  readonly detail: string
  readonly depth: number
  readonly ordinal: number
  readonly parentId: string | undefined
  readonly state: FlowItemState
  readonly span: SourceSpan.SourceSpan
  readonly nodeIds: ReadonlyArray<string>
  readonly edgeIds: ReadonlyArray<string>
}

export interface FlowNode {
  readonly _tag: 'FlowNode'
  readonly id: string
  readonly groupId: string
  readonly kind: FlowNodeKind
  readonly label: string
  readonly detail: string
  readonly depth: number
  readonly ordinal: number | undefined
  readonly state: FlowItemState
  readonly span: SourceSpan.SourceSpan
}

export interface FlowEdge {
  readonly _tag: 'FlowEdge'
  readonly id: string
  readonly groupId: string
  readonly from: string
  readonly to: string
  readonly label: string
  readonly depth: number
  readonly state: FlowItemState
  readonly span: SourceSpan.SourceSpan
}

export interface FlowModel {
  readonly _tag: 'FlowModel'
  readonly status: 'Complete' | 'Incomplete' | 'Empty'
  readonly summary: string
  readonly groups: ReadonlyArray<FlowGroup>
  readonly nodes: ReadonlyArray<FlowNode>
  readonly edges: ReadonlyArray<FlowEdge>
}

interface GroupDraft {
  readonly id: string
  readonly label: string
  readonly detail: string
  readonly depth: number
  readonly ordinal: number
  readonly parentId: string | undefined
  readonly state: FlowItemState
  readonly span: SourceSpan.SourceSpan
  readonly nodeIds: Array<string>
  readonly edgeIds: Array<string>
}

interface ProjectionDraft {
  readonly groups: Array<GroupDraft>
  readonly nodes: Array<FlowNode>
  readonly edges: Array<FlowEdge>
}

interface Projection {
  readonly groupId: string
  readonly resultId?: string
  readonly complete: boolean
}

const emptyModel = (): FlowModel => ({
  _tag: 'FlowModel',
  status: 'Empty',
  summary: 'No call expression is available for data-flow projection.',
  groups: [],
  nodes: [],
  edges: [],
})

const canonicalEqual = (
  left: DeclarationFacts.CanonicalId,
  right: DeclarationFacts.CanonicalId,
): boolean => left.module === right.module && left.name === right.name

const bodyFor = (
  analysis: Elaboration.Result,
  target: DeclarationFacts.CanonicalId,
): Elaboration.CheckedBody | undefined =>
  analysis.bodies.find(
    (body) =>
      body.declaration.canonical._tag === 'Canonical' &&
      canonicalEqual(body.declaration.canonical.id, target),
  )

const parameterName = (parameter: Elaboration.ParameterFact): string =>
  parameter.name._tag === 'Present' ? parameter.name.spelling : `parameter #${parameter.id.ordinal}`

const expressionLabel = (expression: Tir.Expression): string => {
  switch (expression._tag) {
    case 'ParameterReference':
      return `parameter #${expression.parameter.ordinal}`
    case 'BindingReference':
      return `binding #${expression.binding.ordinal}`
    case 'PatternBindingReference':
      return `pattern binding #${expression.binding.ordinal}`
    case 'Call':
      return `${expression.target.name}(…)`
    case 'Move':
      return `move ${expressionLabel(expression.subject)}`
    case 'BooleanLiteral':
      return String(expression.value)
    case 'IntegerLiteral':
      return String(expression.value)
    case 'BuiltinCall':
      return `${expression.operation} expression`
    case 'CallableApply':
      return 'callable result'
    case 'Construct':
      return `${Type.encode(expression.type)} {…}`
    case 'Project':
      return `${expressionLabel(expression.subject)}.${expression.field.ordinal}`
    case 'ArrayConstruct':
      return `[${expression.elements.length} elements]`
    case 'IndexPlace':
      return `${expressionLabel(expression.subject)}[index]`
    case 'Match':
      return 'match result'
    case 'ValueBorrow':
    case 'SliceBorrow':
      return `${expression.access === 'Exclusive' ? '&mut ' : '&'}borrowed value`
    case 'Run':
      return 'run result'
    default:
      return 'unavailable expression'
  }
}

const addNode = (draft: ProjectionDraft, group: GroupDraft, value: FlowNode): void => {
  draft.nodes.push(value)
  group.nodeIds.push(value.id)
}

const addEdge = (draft: ProjectionDraft, group: GroupDraft, value: FlowEdge): void => {
  draft.edges.push(value)
  group.edgeIds.push(value.id)
}

const semanticNode = (
  group: GroupDraft,
  id: string,
  kind: FlowNodeKind,
  label: string,
  detail: string,
  ordinal: number | undefined,
  state: FlowItemState,
  span: SourceSpan.SourceSpan,
): FlowNode => ({
  _tag: 'FlowNode',
  id,
  groupId: group.id,
  kind,
  label,
  detail,
  depth: group.depth,
  ordinal,
  state,
  span,
})

const semanticEdge = (
  group: GroupDraft,
  id: string,
  from: string,
  to: string,
  label: string,
  state: FlowItemState,
  span: SourceSpan.SourceSpan,
): FlowEdge => ({
  _tag: 'FlowEdge',
  id,
  groupId: group.id,
  from,
  to,
  label,
  depth: group.depth,
  state,
  span,
})

const occurrenceTarget = (
  body: Elaboration.CheckedBody,
  expression: Tir.Expression,
): DeclarationFacts.CanonicalId | undefined => {
  const key = AuthoredIdentity.anchorKey(expression.origin.anchor)
  const occurrence = body.results.tooling?.occurrences.find(
    (candidate) =>
      AuthoredIdentity.anchorKey(candidate.at) === key &&
      candidate.resolution._tag === 'Available' &&
      candidate.resolution.identity._tag === 'DeclarationIdentity' &&
      'module' in candidate.resolution.identity.id,
  )
  if (
    occurrence?.resolution._tag !== 'Available' ||
    occurrence.resolution.identity._tag !== 'DeclarationIdentity' ||
    !('module' in occurrence.resolution.identity.id)
  )
    return undefined
  return occurrence.resolution.identity.id
}

const unavailableReason = (
  body: Elaboration.CheckedBody,
  expression: Extract<Tir.Expression, { readonly _tag: 'Unavailable' }>,
): string => {
  if (
    expression.call?.expectedCount !== undefined &&
    expression.call.expectedCount !== expression.call.arguments.length
  )
    return 'ArityMismatch'
  const cause =
    expression.cause === undefined ? undefined : body.results.causes.at(expression.cause.ordinal)
  return cause?.code === Diagnostic.wrongCallArityCode ? 'ArityMismatch' : 'Unavailable'
}

const expressionId = (body: Elaboration.CheckedBody, expression: Tir.Expression): string =>
  `${Tir.artifactKey(body.artifact)}:${expression.id?.ordinal ?? AuthoredIdentity.anchorKey(expression.origin.anchor)}`

const returned = (body: Elaboration.CheckedBody): Tir.Expression => Tir.returned(body.function)

const projectCall = (
  analysis: Elaboration.Result,
  context: SemanticContext.SemanticContext,
  draft: ProjectionDraft,
  caller: Elaboration.CheckedBody,
  expression: Extract<Tir.Expression, { readonly _tag: 'Call' | 'Unavailable' }>,
  parentId: string | undefined,
  depth: number,
  ordinal: number,
): Projection => {
  const target =
    expression._tag === 'Call'
      ? expression.target
      : (expression.call?.target ?? occurrenceTarget(caller, expression))
  const callee = target === undefined ? undefined : bodyFor(analysis, target)
  const id = `call-${expressionId(caller, expression)}`
  const available = expression._tag === 'Call' && callee !== undefined
  const group: GroupDraft = {
    id,
    label: `${target?.name ?? 'unavailable'} call site`,
    detail: `${caller.declaration.name._tag === 'Present' ? caller.declaration.name.spelling : 'function'} call at [${expression.span.start}, ${expression.span.end})`,
    depth,
    ordinal,
    parentId,
    state: available ? 'Connected' : 'Stopped',
    span: expression.span,
    nodeIds: [],
    edgeIds: [],
  }
  draft.groups.push(group)

  if (expression._tag === 'Unavailable') {
    const reason = unavailableReason(caller, expression)
    const arguments_ = expression.call?.arguments ?? []
    for (const [argumentOrdinal, argument] of arguments_.entries()) {
      const argumentId = `${id}-argument-${argumentOrdinal}`
      addNode(
        draft,
        group,
        semanticNode(
          group,
          argumentId,
          'Argument',
          expressionLabel(argument),
          `Argument #${argumentOrdinal}`,
          argumentOrdinal,
          'Connected',
          argument.span,
        ),
      )
      if (
        argument._tag === 'Call' ||
        (argument._tag === 'Unavailable' && argument.call !== undefined)
      )
        projectCall(analysis, context, draft, caller, argument, id, depth + 1, argumentOrdinal)
    }
    addNode(
      draft,
      group,
      semanticNode(
        group,
        `${id}-terminal`,
        'Terminal',
        `Data flow stops: ${reason}`,
        reason,
        undefined,
        'Stopped',
        expression.span,
      ),
    )
    if (reason === 'ArityMismatch' && callee !== undefined)
      for (const [parameterOrdinal, parameter] of callee.declaration.parameters
        .filter((candidate) => candidate.phase === 'Runtime')
        .entries())
        addNode(
          draft,
          group,
          semanticNode(
            group,
            `${id}-parameter-${parameterOrdinal}`,
            'Parameter',
            parameterName(parameter),
            'No positional argument was supplied.',
            parameterOrdinal,
            'Unmatched',
            context.spanOf(parameter.anchor),
          ),
        )
    return { groupId: id, complete: false }
  }

  const parameters =
    callee?.declaration.parameters.filter((parameter) => parameter.phase === 'Runtime') ?? []
  let complete = callee !== undefined && expression.arguments.length === parameters.length
  const argumentIds: Array<string> = []
  for (const [argumentOrdinal, argument] of expression.arguments.entries()) {
    const argumentId = `${id}-argument-${argumentOrdinal}`
    argumentIds.push(argumentId)
    addNode(
      draft,
      group,
      semanticNode(
        group,
        argumentId,
        'Argument',
        expressionLabel(argument),
        `Argument #${argumentOrdinal}`,
        argumentOrdinal,
        'Connected',
        argument.span,
      ),
    )
    if (argument._tag === 'Call' || argument._tag === 'Unavailable') {
      const nested = projectCall(
        analysis,
        context,
        draft,
        caller,
        argument,
        id,
        depth + 1,
        argumentOrdinal,
      )
      complete = complete && nested.complete
      if (nested.resultId !== undefined)
        addEdge(
          draft,
          group,
          semanticEdge(
            group,
            `${id}-nested-${argumentOrdinal}`,
            nested.resultId,
            argumentId,
            'supplies nested result to',
            'Connected',
            argument.span,
          ),
        )
    }
  }

  for (const [parameterOrdinal, parameter] of parameters.entries()) {
    const parameterId = `${id}-parameter-${parameterOrdinal}`
    const argumentId = argumentIds.at(parameterOrdinal)
    addNode(
      draft,
      group,
      semanticNode(
        group,
        parameterId,
        'Parameter',
        parameterName(parameter),
        `Parameter #${parameterOrdinal}`,
        parameterOrdinal,
        argumentId === undefined ? 'Unmatched' : 'Connected',
        context.spanOf(parameter.anchor),
      ),
    )
    if (argumentId !== undefined)
      addEdge(
        draft,
        group,
        semanticEdge(
          group,
          `${id}-bind-${parameterOrdinal}`,
          argumentId,
          parameterId,
          'binds positionally to',
          'Connected',
          expression.arguments.at(parameterOrdinal)?.span ?? expression.span,
        ),
      )
  }

  if (!complete || callee === undefined) {
    const reason =
      expression.arguments.length === parameters.length ? 'Unavailable' : 'ArityMismatch'
    addNode(
      draft,
      group,
      semanticNode(
        group,
        `${id}-terminal`,
        'Terminal',
        `Data flow stops: ${reason}`,
        reason,
        undefined,
        'Stopped',
        expression.span,
      ),
    )
    return { groupId: id, complete: false }
  }

  const result = returned(callee)
  let producer: string
  if (result._tag === 'ParameterReference') {
    const parameterOrdinal = (callee.function.locals ?? []).findIndex(
      (local) => local.id.ordinal === result.parameter.ordinal,
    )
    const parameterId = `${id}-parameter-${parameterOrdinal}`
    producer = `${id}-reference`
    addNode(
      draft,
      group,
      semanticNode(
        group,
        producer,
        'Reference',
        expressionLabel(result),
        'Callee return reference',
        parameterOrdinal,
        'Connected',
        result.span,
      ),
    )
    addEdge(
      draft,
      group,
      semanticEdge(
        group,
        `${id}-read`,
        parameterId,
        producer,
        'is read by',
        'Connected',
        result.span,
      ),
    )
  } else {
    producer = `${id}-returned`
    addNode(
      draft,
      group,
      semanticNode(
        group,
        producer,
        'ReturnedValue',
        expressionLabel(result),
        'Callee returned value',
        undefined,
        'Connected',
        result.span,
      ),
    )
  }

  const resultId = `${id}-result`
  addNode(
    draft,
    group,
    semanticNode(
      group,
      resultId,
      'CallResult',
      `${expression.target.name} result`,
      Type.encode(expression.type),
      undefined,
      'Connected',
      expression.span,
    ),
  )
  addEdge(
    draft,
    group,
    semanticEdge(
      group,
      `${id}-produces`,
      producer,
      resultId,
      'produces',
      'Connected',
      expression.span,
    ),
  )
  return { groupId: id, resultId, complete: true }
}

/** Projects semantic relationships directly from checked TIR and its supplementary tables. */
export const projectDataFlow = (analysis: Elaboration.Result): FlowModel => {
  const caller = analysis.bodies.find((body) => {
    if (body.hidden) return false
    const expression = returned(body)
    return (
      expression._tag === 'Call' ||
      (expression._tag === 'Unavailable' && expression.call !== undefined)
    )
  })
  if (caller === undefined) return emptyModel()
  const rootExpression = returned(caller)
  if (
    rootExpression._tag !== 'Call' &&
    (rootExpression._tag !== 'Unavailable' || rootExpression.call === undefined)
  )
    return emptyModel()
  const context = SemanticContext.make(analysis.authored)
  const draft: ProjectionDraft = { groups: [], nodes: [], edges: [] }
  const root = projectCall(analysis, context, draft, caller, rootExpression, undefined, 0, 0)
  if (root.resultId !== undefined) {
    const group = draft.groups.find((candidate) => candidate.id === root.groupId)
    if (group !== undefined) {
      const returnId = `${group.id}-caller-return`
      addNode(
        draft,
        group,
        semanticNode(
          group,
          returnId,
          'FunctionReturn',
          'function return',
          'Caller returns the call result.',
          undefined,
          'Connected',
          rootExpression.span,
        ),
      )
      addEdge(
        draft,
        group,
        semanticEdge(
          group,
          `${group.id}-returned-by`,
          root.resultId,
          returnId,
          'is returned by',
          'Connected',
          rootExpression.span,
        ),
      )
    }
  }
  return {
    _tag: 'FlowModel',
    status: root.complete ? 'Complete' : 'Incomplete',
    summary: root.complete
      ? 'Typed TIR connects every projected call argument to its returned result.'
      : 'Typed TIR preserves a stopped or unmatched call boundary.',
    groups: draft.groups.map((group) => ({
      _tag: 'FlowGroup' as const,
      id: group.id,
      label: group.label,
      detail: group.detail,
      depth: group.depth,
      ordinal: group.ordinal,
      parentId: group.parentId,
      state: group.state,
      span: group.span,
      nodeIds: [...group.nodeIds],
      edgeIds: [...group.edgeIds],
    })),
    nodes: [...draft.nodes],
    edges: [...draft.edges],
  }
}
