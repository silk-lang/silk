/**
 * Syntax and semantics phases, projected into the shared row grammar.
 *
 * These are pure `snapshot → rows` functions rather than components, which is what lets a pane
 * stay a thin shell: the pane owns scrolling and the cursor, the projection owns what a phase
 * has to say. It also makes each phase testable without rendering anything.
 */

import * as Diagnostic from './Diagnostic.js'
import * as Elaboration from './Elaboration.js'
import type * as Tir from './Tir.js'
import type { FlowModel } from './InspectorFlowModel.js'
import type { RowModel, RowTone, Span } from './InspectorRow.js'
import { spanOf as asSpan } from './InspectorRow.js'
import type * as SemanticContext from './SemanticContext.js'
import * as Match from './Match.js'
import type * as SyntaxFile from './SyntaxFile.js'
import * as SyntaxTree from './SyntaxTree.js'
import * as Type from './Type.js'

const decoder = new TextDecoder()

/** One diagnostic paired with the identity other diagnostics cite it by. */
export interface DiagnosticEntry {
  readonly diagnostic: Diagnostic.Diagnostic
  readonly identity: Diagnostic.Identity
}

/**
 * Every phase's diagnostics in one ordered list.
 *
 * Identity matters because a diagnostic can name another as its cause, and the citation has to
 * survive being merged with diagnostics from other phases — hence identify-then-sort rather than
 * a plain concatenation.
 */
export const diagnosticEntries = (
  ...collections: ReadonlyArray<ReadonlyArray<Diagnostic.Diagnostic>>
): ReadonlyArray<DiagnosticEntry> =>
  collections
    .flatMap((diagnostics) => {
      const identities = Diagnostic.identify(diagnostics)
      return diagnostics.map((diagnostic, index) => ({
        diagnostic,
        identity: identities[index] ?? Diagnostic.identity(diagnostic),
      }))
    })
    .sort((left, right) => Diagnostic.compare(left.diagnostic, right.diagnostic))

/** Trivia is most of a lossless tree's rows and almost never what you are looking at. */
const TRIVIA = new Set(['Whitespace', 'Newline', 'Comment'])

export const isTrivia = (kind: string): boolean => TRIVIA.has(kind)

const sliceOf = (source: SyntaxFile.SyntaxFile['source'], span: Span): string =>
  decoder.decode(source.bytes.slice(span.start, span.end))

export const tokenRows = (
  syntax: SyntaxFile.SyntaxFile,
  showTrivia: boolean,
  filter: string,
): ReadonlyArray<RowModel> => {
  const needle = filter.trim().toLowerCase()
  return (
    syntax.tokens
      // The index is kept from the *unfiltered* stream so a row's number is its real position in
      // the token stream. Numbering after the filter would renumber 1..n on every keystroke and
      // quietly disagree with every other phase's idea of which token this is.
      .map((token, index) => ({ token, index }))
      .filter(({ token }) => (showTrivia ? true : !isTrivia(token.kind)))
      .filter(({ token }) => needle === '' || token.kind.toLowerCase().includes(needle))
      .map(({ token, index }) => {
        const span = asSpan(token.span)
        return {
          key: `${token.kind}-${span.start}-${index}`,
          lead: index + 1,
          dot: 'token' as const,
          label: token.kind,
          detail: JSON.stringify(sliceOf(syntax.source, span)),
          span,
        }
      })
  )
}

/**
 * The lossless concrete tree, flattened to rows with depth as indentation.
 *
 * Missing elements are rendered as real rows rather than being skipped: recovery is the point of
 * the tree being lossless, so a node the parser inserted has to be visible as one — amber, with
 * the zero-width span it was inserted at.
 */
export const treeRows = (
  syntax: SyntaxFile.SyntaxFile,
  showTrivia: boolean,
  filter: string,
): ReadonlyArray<RowModel> => {
  const rows: Array<RowModel> = []
  const needle = filter.trim().toLowerCase()

  const walk = (element: SyntaxTree.Element, depth: number, path: string): void => {
    if (SyntaxTree.isNode(element)) {
      const span = asSpan(element.span)
      rows.push({
        key: `${path}-${element.kind}-${span.start}`,
        depth,
        caret: '▾',
        dot: 'node',
        label: element.kind,
        span,
        head: depth === 0,
      })
      element.children.forEach((child, index) => {
        walk(child, depth + 1, `${path}.${index}`)
      })
      return
    }

    if (SyntaxTree.isToken(element)) {
      if (!showTrivia && isTrivia(element.kind)) return
      const span = asSpan(element.span)
      rows.push({
        key: `${path}-${element.kind}-${span.start}`,
        depth,
        dot: 'token',
        label: element.kind,
        detail: JSON.stringify(sliceOf(syntax.source, span)),
        span,
      })
      return
    }

    const span = asSpan(element.span)
    rows.push({
      key: `${path}-missing-${span.start}`,
      depth,
      dot: 'missing',
      label: element.expected,
      detail: 'missing — inserted by recovery',
      span,
      tone: 'warning',
    })
  }

  walk(syntax.root, 0, 'r')

  // Filtering a tree keeps ancestors of a match, so a hit never appears without the context that
  // explains where it is.
  if (needle === '') return rows
  const kept = new Set<number>()
  const stack: Array<number> = []
  rows.forEach((row, index) => {
    const depth = row.depth ?? 0
    stack.length = depth
    stack[depth] = index
    if (row.label.toLowerCase().includes(needle)) {
      for (const ancestor of stack) if (ancestor !== undefined) kept.add(ancestor)
    }
  })
  return rows.filter((_, index) => kept.has(index))
}

/** Contract types are `Type.Type`, so a struct parameter or result is an object, not a string. */
export const tirContract = (contract: Tir.ContractFact): string => {
  if (contract._tag !== 'Contract') return 'contract unavailable'

  if (contract.functionKind !== 'Effect') {
    return `(${contract.parameters.map(tirTypeText).join(', ')}) -> ${tirTypeText(contract.result)}`
  }
  const failureText =
    contract.failureRow === undefined ? 'empty' : tirTypeText(Type.failureType(contract.failureRow))
  return `effect (${contract.parameters.map(tirTypeText).join(', ')}) -> ${tirTypeText(contract.result)} ! ${failureText}`
}

const tirIdentity = (declaration: Tir.TirFunction['declaration']): string => {
  switch (declaration.canonical._tag) {
    case 'Canonical':
      return declaration.canonical.id.name
    case 'Duplicate':
      return `duplicate of ${declaration.canonical.original.name}`
    case 'Unidentified':
      return 'unidentified'
  }
}

const tirTypeText = (type: Type.Type): string => Type.encode(type)

const tirExpressionLabel = (expression: Tir.Expression): string => {
  switch (expression._tag) {
    case 'IntegerLiteral':
    case 'BooleanLiteral':
      return `const ${expression.value}`
    case 'ParameterReference':
      return `local l${expression.parameter.ordinal}`
    case 'BindingReference':
      return `local l${expression.binding.ordinal}`
    case 'PatternBindingReference':
      return `pattern b${expression.binding.ordinal}`
    case 'Move':
      return 'move'
    case 'UnionConvert':
      return `${expression.conversion.toLowerCase()} → ${tirTypeText(expression.target)}`
    case 'Match':
      return `match ${expression.access.toLowerCase()} · ${expression.members.map(Match.encodeIdentity).join(' | ')}`
    case 'Construct':
      return `construct ${tirTypeText(expression.nominal)}`
    case 'ConstructUnionVariant':
      return `construct ${tirTypeText(expression.nominal)}.${expression.variant.name}`
    case 'ArrayConstruct':
      return `array ${tirTypeText(expression.type)} · ${expression.elements.length} elements`
    case 'Project':
      return `project ${tirTypeText(expression.nominal)}.#${expression.field.ordinal}`
    case 'IndexPlace':
      return `index ${tirTypeText(expression.array)} · ${expression.bounds._tag.toLowerCase()}`
    case 'SliceBorrow':
      return `${expression.reborrow ? 'reborrow' : 'borrow'} ${expression.access.toLowerCase()} · loan #${expression.borrow.ordinal}`
    case 'SliceLength':
      return 'slice length'
    case 'SliceIndexPlace':
      return `slice index ${expression.access.toLowerCase()}`
    case 'Call':
      return `call ${expression.target.name}${
        expression.typeArguments.length === 0
          ? ''
          : `<${expression.typeArguments.map(Type.encodeGenericArgument).join(', ')}>`
      } · loan ends ${expression.loanEnds.map((loan) => `#${loan.ordinal}`).join(', ') || 'none'}`
    case 'FunctionItem':
      return `function ${expression.target._tag === 'DeclarationCallableTarget' ? expression.target.declaration.name : `${expression.target.actor}.${expression.target.operation}`}`
    case 'CallableSection':
      return `section ${expression.target._tag === 'DeclarationCallableTarget' ? expression.target.declaration.name : `${expression.target.actor}.${expression.target.operation}`} · ${expression.mode.toLowerCase()} · ${expression.captures.length} capture${expression.captures.length === 1 ? '' : 's'}`
    case 'ForeignApply':
      return 'apply native C address'
    case 'CallableApply':
      return `apply callable · ${expression.access.toLowerCase()} · ${expression.evaluation.toLowerCase()}`
    case 'EffectConstruct':
      return `effect recipe ${expression.target.name}${
        expression.typeArguments.length === 0
          ? ''
          : `<${expression.typeArguments.map(Type.encodeGenericArgument).join(', ')}>`
      } · ${expression.type.access.toLowerCase()}`
    case 'EffectBlock':
      return `effect block · ${expression.type.access.toLowerCase()}`
    case 'Run':
      return 'run recipe'
    case 'EffectBindRequirement':
      return expression.provider.capability === undefined
        ? 'bind selected requirement'
        : `bind ${tirTypeText(expression.provider.capability)}@${expression.provider.role ?? 'DefaultRole'}`
    case 'BuiltinCall':
      return `builtin i32.${expression.operation}`
    default:
      return 'unavailable'
  }
}

export const tirRows = (
  tir: Tir.Module,
  spans: SemanticContext.Registry,
): ReadonlyArray<RowModel> => {
  const rows: Array<RowModel> = []

  const expression = (node: Tir.Expression, depth: number, path: string): void => {
    const span = asSpan(node.span)
    rows.push({
      key: `${path}-${node._tag}-${span.start}`,
      depth,
      dot: node._tag === 'Unavailable' ? 'warning' : undefined,
      label: tirExpressionLabel(node),
      detail: node._tag === 'Unavailable' ? 'unavailable' : `: ${tirTypeText(node.type)}`,
      span,
      ...(node._tag === 'Unavailable' ? { tone: 'warning' as const } : {}),
    })
    if (node._tag === 'Call' || node._tag === 'EffectConstruct' || node._tag === 'BuiltinCall') {
      node.arguments.forEach((argument, index) => {
        expression(argument, depth + 1, `${path}.${index}`)
      })
    }
    if (node._tag === 'Move' || node._tag === 'Project' || node._tag === 'Run') {
      expression(node.subject, depth + 1, `${path}.s`)
    }
    if (node._tag === 'CallableSection') {
      node.captures.forEach((capture) => {
        expression(capture.value, depth + 1, `${path}.capture${capture.ordinal}`)
      })
    }
    if (node._tag === 'CallableApply' || node._tag === 'ForeignApply') {
      expression(node.callee, depth + 1, `${path}.callee`)
      node.arguments.forEach((argument, index) => {
        expression(argument, depth + 1, `${path}.argument${index}`)
      })
    }
    if (node._tag === 'EffectBindRequirement') {
      expression(node.protected, depth + 1, `${path}.protected`)
    }
    if (node._tag === 'SliceLength') expression(node.slice, depth + 1, `${path}.s`)
    if (node._tag === 'SliceIndexPlace') {
      expression(node.slice, depth + 1, `${path}.s`)
      expression(node.index, depth + 1, `${path}.i`)
    }
    if (node._tag === 'UnionConvert') {
      expression(node.source, depth + 1, `${path}.u`)
    }
    if (node._tag === 'IndexPlace') {
      expression(node.subject, depth + 1, `${path}.s`)
      expression(node.index, depth + 1, `${path}.i`)
    }
    if (node._tag === 'Construct' || node._tag === 'ConstructUnionVariant') {
      // Canonical storage order, one child per field — the reordering from source order is the
      // struct-values pane's story; here the construct is just a typed expression tree.
      node.fields.forEach(({ field, value }) => {
        expression(value, depth + 1, `${path}.f${field.ordinal}`)
      })
    }
    if (node._tag === 'ArrayConstruct') {
      node.elements.forEach((element, index) => {
        expression(element, depth + 1, `${path}.e${index}`)
      })
    }
    if (node._tag === 'Match') {
      expression(node.scrutinee, depth + 1, `${path}.scrutinee`)
      node.arms.forEach((arm) => {
        const armSpan = asSpan(arm.span)
        let selection = 'unknown'
        if (arm.universal) selection = '_'
        else if (arm.member !== undefined) selection = Match.encodeIdentity(arm.member)
        rows.push({
          key: `${path}.arm${arm.id.ordinal}`,
          depth: depth + 1,
          label: `arm #${arm.id.ordinal} ${selection}`,
          detail: `${arm.guard === undefined ? 'selected directly' : 'guarded'} · ${arm.bindings.length} binding${arm.bindings.length === 1 ? '' : 's'} · ${arm.before.map(Match.encodeIdentity).join(' | ') || 'empty'} → ${arm.after.map(Match.encodeIdentity).join(' | ') || 'empty'}`,
          span: armSpan,
        })
        if (arm.guard !== undefined) {
          expression(arm.guard, depth + 2, `${path}.arm${arm.id.ordinal}.guard`)
        }
        if (arm.body._tag === 'Expression')
          expression(arm.body.expression, depth + 2, `${path}.arm${arm.id.ordinal}.body`)
        else
          arm.body.statements.forEach((node, ordinal) =>
            statement(node, depth + 2, `${path}.arm${arm.id.ordinal}.body${ordinal}`),
          )
      })
    }
  }

  const statement = (node: Tir.Statement, depth: number, path: string): void => {
    const span = asSpan(node.span)
    if (node._tag === 'Bind') {
      rows.push({
        key: `${path}-bind-${span.start}`,
        depth,
        label: `bind ${node.mutability.toLowerCase()} b${node.binding.ordinal} ${node.name ?? '∅'}`,
        detail: `r${node.region.ordinal}`,
        span,
      })
      expression(node.initializer, depth + 1, `${path}.i`)
      return
    }
    if (node._tag === 'PatternBind') {
      let selection = 'unknown'
      if (node.selection.universal) selection = '_'
      else if (node.selection.member !== undefined)
        selection = Match.encodeIdentity(node.selection.member)
      rows.push({
        key: `${path}-pattern-bind-${span.start}`,
        depth,
        label: `let pattern ${selection}`,
        detail: `${node.selection.access.toLowerCase()} · ${node.selection.bindings.length} binding${node.selection.bindings.length === 1 ? '' : 's'} · r${node.region.ordinal}`,
        span,
      })
      expression(node.selection.subject, depth + 1, `${path}.subject`)
      return
    }
    if (node._tag === 'If') {
      rows.push({
        key: `${path}-if-${span.start}`,
        depth,
        label: 'if',
        span,
      })
      expression(node.condition, depth + 1, `${path}.c`)
      node.taken.forEach((inner, index) => {
        statement(inner, depth + 1, `${path}.t${index}`)
      })
      node.otherwise.forEach((inner, index) => {
        statement(inner, depth + 1, `${path}.e${index}`)
      })
      return
    }
    if (node._tag === 'IfLet') {
      let selection = 'unknown'
      if (node.selection.universal) selection = '_'
      else if (node.selection.member !== undefined)
        selection = Match.encodeIdentity(node.selection.member)
      rows.push({
        key: `${path}-if-let-${span.start}`,
        depth,
        label: `if let ${selection}`,
        detail: `${node.selection.access.toLowerCase()} · ${node.selection.bindings.length} binding${node.selection.bindings.length === 1 ? '' : 's'} · r${node.region.ordinal}`,
        span,
      })
      expression(node.selection.subject, depth + 1, `${path}.subject`)
      node.taken.forEach((inner, index) => {
        statement(inner, depth + 1, `${path}.t${index}`)
      })
      node.otherwise.forEach((inner, index) => {
        statement(inner, depth + 1, `${path}.e${index}`)
      })
      return
    }
    if (node._tag === 'Write') {
      let root: string
      if (node.place._tag === 'WritePlace') {
        if (node.place.root._tag === 'BindingWriteRoot')
          root = `b${node.place.root.binding.ordinal}`
        else if (node.place.root._tag === 'PatternWriteRoot')
          root = `match-b${node.place.root.binding.ordinal}`
        else root = `p${node.place.root.parameter.ordinal}`
      } else {
        root =
          node.place.root._tag === 'BindingSliceRoot'
            ? `slice-b${node.place.root.binding.ordinal}`
            : `slice-p${node.place.root.parameter.ordinal}`
      }
      rows.push({
        key: `${path}-write-${span.start}`,
        depth,
        label: `write ${root}${node.place.selectors
          .map((selector) =>
            selector._tag === 'Field' ? `.#${selector.field.ordinal}` : '[index]',
          )
          .join('')}`,
        detail: `r${node.region.ordinal}`,
        span,
      })
      for (const [index, selector] of node.place.selectors.entries()) {
        if (selector._tag === 'Index' || selector._tag === 'SliceIndex')
          expression(selector.index, depth + 1, `${path}.s${index}`)
      }
      expression(node.value, depth + 1, `${path}.v`)
      return
    }
    if (node._tag === 'While') {
      rows.push({
        key: `${path}-while-${span.start}`,
        depth,
        label: `while loop${node.loop.ordinal}`,
        detail: `r${node.region.ordinal}${node.parent === undefined ? '' : ` · parent loop${node.parent.ordinal}`}`,
        span,
      })
      expression(node.condition, depth + 1, `${path}.c`)
      node.body.forEach((inner, index) => {
        statement(inner, depth + 1, `${path}.b${index}`)
      })
      return
    }
    if (node._tag === 'Break' || node._tag === 'Continue') {
      rows.push({
        key: `${path}-${node._tag.toLowerCase()}-${span.start}`,
        depth,
        label: `${node._tag.toLowerCase()} loop${node.target.ordinal}`,
        detail: `r${node.region.ordinal}`,
        span,
      })
      return
    }
    if (node._tag === 'Fail') {
      rows.push({
        key: `${path}-fail-${span.start}`,
        depth,
        label: `fail ${tirTypeText(node.failure)}`,
        detail: `r${node.region.ordinal}`,
        span,
        tone: 'warning',
      })
      expression(node.expression, depth + 1, `${path}.f`)
      return
    }
    if (node._tag === 'Unsafe') {
      rows.push({
        key: `${path}-unsafe-${span.start}`,
        depth,
        label: 'unsafe',
        detail: `r${node.region.ordinal}`,
        span,
      })
      node.statements.forEach((inner, index) => {
        statement(inner, depth + 1, `${path}.u${index}`)
      })
      return
    }
    if (node._tag === 'UnavailableStatement') {
      rows.push({
        key: `${path}-unavailable-${span.start}`,
        depth,
        label: 'unavailable statement',
        detail: `r${node.region.ordinal}`,
        span,
        tone: 'warning',
      })
      return
    }
    const terminal = node._tag === 'Evaluate' ? 'evaluate' : node._tag.toLowerCase()
    rows.push({
      key: `${path}-${terminal}-${span.start}`,
      depth,
      label: terminal,
      detail: `r${node.region.ordinal}`,
      span,
    })
    expression(node.expression, depth + 1, `${path}.${terminal.at(0) ?? 'x'}`)
  }

  tir.functions.forEach((fn, index) => {
    const span = asSpan(spans.spanOf(fn.declaration.anchor))
    rows.push({
      key: `fn-${index}`,
      label: `fn#${fn.declaration.id.ordinal} ${tirIdentity(fn.declaration)}`,
      detail: tirContract(fn.contract),
      span,
      head: true,
    })
    fn.statements.forEach((node, statementIndex) => {
      statement(node, 1, `fn${index}.${statementIndex}`)
    })
  })

  return rows
}

/**
 * Every diagnostic this compiler publishes is an error — `Diagnostic.severity` is the literal
 * `'error'`. The warning tone stays in the row grammar for recovered tokens, which are the tree's
 * own amber state rather than a diagnostic.
 */
const severityTone = (severity: Diagnostic.Diagnostic['severity']): RowTone =>
  severity === 'error' ? 'error' : 'warning'

/**
 * The value-flow model as rows: each call group, then its nodes and the edges between them.
 *
 * This is the one view that is about *relationships* rather than about a tree, so the edges are
 * rendered as their own rows (`argument #0 → parameter value`) rather than being folded into the
 * node they start from — an edge is a fact the elaborator produced, and it can be unavailable on
 * its own.
 */
export const flowRows = (flow: FlowModel): ReadonlyArray<RowModel> => {
  if (flow.status === 'Empty') return []

  const stateTone = (state: string): RowTone | undefined =>
    state === 'Unavailable' ? 'warning' : undefined

  return flow.groups.flatMap((group) => {
    const groupSpan: Span = asSpan(group.span)
    const rows: Array<RowModel> = [
      {
        key: `flow-${group.id}`,
        depth: Math.min(group.depth, 3),
        label: group.label,
        detail: `${group.state} · ${group.detail}`,
        span: groupSpan,
        head: true,
        ...(stateTone(group.state) === undefined
          ? {}
          : { tone: stateTone(group.state) as RowTone }),
      },
    ]

    for (const node of flow.nodes.filter((candidate) => candidate.groupId === group.id)) {
      const span: Span = asSpan(node.span)
      rows.push({
        key: `flow-${node.id}`,
        depth: Math.min(group.depth, 3) + 1,
        label: node.label,
        detail: `${node.kind} · ${node.detail}`,
        span,
        ...(stateTone(node.state) === undefined ? {} : { tone: stateTone(node.state) as RowTone }),
      })
    }

    for (const edge of flow.edges.filter((candidate) => candidate.groupId === group.id)) {
      const span: Span = asSpan(edge.span)
      rows.push({
        key: `flow-${edge.id}`,
        depth: Math.min(group.depth, 3) + 1,
        label: `→ ${edge.label}`,
        detail: edge.state,
        span,
        ...(stateTone(edge.state) === undefined ? {} : { tone: stateTone(edge.state) as RowTone }),
      })
    }

    return rows
  })
}

/**
 * A diagnostic is two rows, not a card: the message, then its recovery or cause underneath.
 *
 * Severity is carried by the row's left rule rather than by a badge, so a pane full of
 * diagnostics reads as a column of coloured rules — countable at a glance.
 */
export const diagnosticRows = (
  entries: ReadonlyArray<DiagnosticEntry>,
): ReadonlyArray<RowModel> => {
  if (entries.length === 0) {
    return [
      {
        key: 'clean',
        dot: 'ok',
        label: 'no diagnostics',
        detail: 'the program compiles clean for this target and profile',
        tone: 'ok',
      },
    ]
  }

  return entries.flatMap((entry, index) => {
    const diagnostic = entry.diagnostic
    const span: Span = asSpan(diagnostic.span)
    const tone = severityTone(diagnostic.severity)
    const rows: Array<RowModel> = [
      {
        key: `dx-${index}`,
        dot: tone,
        label: diagnostic.code,
        detail: diagnostic.message,
        span,
        tone,
      },
    ]

    const cause = diagnostic.cause
    if (cause !== undefined) {
      const origin = entries.find((candidate) =>
        Diagnostic.identityEquals(candidate.identity, cause),
      )
      rows.push({
        key: `dx-${index}-cause`,
        depth: 1,
        label: `caused by ${cause.code}`,
        detail: origin?.diagnostic.message ?? diagnostic.phase,
        span: asSpan(cause.span),
        tone,
      })
    }

    return rows
  })
}

/** Counts for the app bar and status bar. */
export const diagnosticCounts = (
  entries: ReadonlyArray<DiagnosticEntry>,
): { readonly errors: number; readonly warnings: number } => ({
  errors: entries.filter((entry) => entry.diagnostic.severity === 'error').length,
  warnings: entries.filter((entry) => entry.diagnostic.severity !== 'error').length,
})

export const elaborationSummary = (analysis: Elaboration.Result): string =>
  `${Elaboration.sourceBodyCount(analysis)} fn`
