import * as Option from 'effect/Option'
import type * as AuthoredHir from './AuthoredHir.js'
import type * as SemanticContext from './SemanticContext.js'
import * as AuthoredIdentity from './AuthoredIdentity.js'
import type * as DeclarationLifetime from './DeclarationLifetime.js'
import * as Lifetime from './Lifetime.js'
import * as SourceAction from './SourceAction.js'
import * as SourceSpan from './SourceSpan.js'
import type * as SyntaxFile from './SyntaxFile.js'
import * as SyntaxTree from './SyntaxTree.js'
import type * as Token from './Token.js'
import * as Type from './Type.js'

/** A complete header expansion planned against one immutable analyzed source. */
export interface LifetimeElision {
  readonly descriptor: SourceAction.Descriptor
  readonly plan: SourceAction.ChangePlan
}

const significant = (token: Token.Token): boolean =>
  !['Whitespace', 'LineComment', 'DocComment', 'ModuleDocComment', 'EndOfFile'].includes(token.kind)

/**
 * The innermost syntax node of one presented span.
 *
 * This refactor edits text at byte offsets inside a header — after the `&` of a borrow, inside a
 * type-argument list — so it needs the concrete syntax the way the formatter does. It never reads
 * meaning from those bytes: every region, binder and contract below comes from the semantic
 * elaboration, and syntax only says where the text goes.
 */
const nodeAt = (
  root: SyntaxTree.Node,
  span: SourceSpan.SourceSpan,
): SyntaxTree.Node | undefined => {
  let found: SyntaxTree.Node | undefined
  const visit = (node: SyntaxTree.Node): void => {
    if (node.span.start > span.start || node.span.end < span.end) return
    found = node
    for (const child of node.children) if (SyntaxTree.isNode(child)) visit(child)
  }
  visit(root)
  return found
}

/** Every authored annotation below one declaration header, paired with its anchor key. */
const annotations = (
  declaration: AuthoredHir.Declaration,
): ReadonlyMap<string, AuthoredHir.Type> => {
  const found = new Map<string, AuthoredHir.Type>()
  const visit = (type: AuthoredHir.Type | AuthoredHir.Lifetime): void => {
    if (type._tag === 'Lifetime') return
    found.set(AuthoredIdentity.anchorKey(type.anchor), type)
    for (const child of children(type)) visit(child)
  }
  for (const type of headerTypes(declaration.header)) visit(type)
  return found
}

const operandType = (operand: AuthoredHir.RowOperand): AuthoredHir.Type =>
  operand._tag === 'Requirement' ? operand.capability : operand

/** The annotation a generic argument contributes to the search for an authored position. */
const argumentTypes = (argument: AuthoredHir.GenericArgument): ReadonlyArray<AuthoredHir.Type> => {
  if (argument._tag === 'Lifetime') return []
  if (argument._tag === 'RequirementSelector') return [argument.subject]
  return [argument]
}

const headerTypes = (header: AuthoredHir.DeclarationHeader): ReadonlyArray<AuthoredHir.Type> => {
  const found: Array<AuthoredHir.Type> = []
  if ('contract' in header) {
    const contract = header.contract
    for (const generic of contract.generics)
      if (generic._tag !== 'RowParameter')
        for (const bound of generic.bounds) if (bound._tag !== 'Lifetime') found.push(bound)
    for (const parameter of contract.parameters) found.push(parameter.type)
    if (contract.result !== undefined) found.push(contract.result)
    if (contract.failures !== undefined) found.push(contract.failures)
    for (const member of contract.requirements?.members ?? []) found.push(operandType(member))
    for (const constraint of contract.constraints)
      if (constraint._tag === 'ProviderConstraint') found.push(constraint.provider)
  }
  if ('generics' in header)
    for (const generic of header.generics)
      if (generic._tag !== 'RowParameter')
        for (const bound of generic.bounds) if (bound._tag !== 'Lifetime') found.push(bound)
  if (header._tag === 'StructHeader') for (const field of header.fields) found.push(field.type)
  if (header._tag === 'UnionHeader')
    for (const variant of header.variants)
      for (const field of variant.fields) found.push(field.type)
  if (header._tag === 'TupleHeader') found.push(...header.elements)
  if (header._tag === 'AliasHeader') found.push(header.target)
  if (header._tag === 'ConstantHeader' && header.type !== undefined) found.push(header.type)
  if (header._tag === 'PackageParameterHeader') found.push(header.type)
  if (header._tag === 'StaticHeader') found.push(header.type)
  if (header._tag === 'ImplHeader') {
    found.push(header.subject)
    if (header.target !== undefined) found.push(header.target)
  }
  return found
}

const children = (type: AuthoredHir.Type): ReadonlyArray<AuthoredHir.Type> => {
  switch (type._tag) {
    case 'AppliedType':
      return [
        type.target,
        ...type.arguments.arguments.flatMap(argumentTypes),
        ...(type.arguments.failures === undefined ? [] : [type.arguments.failures]),
        ...(type.arguments.requirements?.members ?? []).map(operandType),
      ]
    case 'FixedArrayType':
    case 'SliceType':
      return [type.element]
    case 'ReferenceType':
      return [type.referent]
    case 'PointerType':
      return [type.pointee]
    case 'CallableType':
    case 'ForeignFunctionType':
      return [...type.parameters, type.result]
    case 'ExactRepresentationType':
      return [type.subject]
    case 'OpaqueResultType':
      return [type.result]
    case 'UnionType':
      return type.members.map(operandType)
    case 'RowWithout':
      return [operandType(type.source), operandType(type.removed)]
    case 'InvalidType':
      return type.retained
    default:
      return []
  }
}

/**
 * Names omitted regions without changing bodies, comments, or authored lifetime choices.
 *
 * `syntax` is the closure module's concrete tree, supplied by the tooling caller: the plan is a
 * text edit, so it needs byte offsets the semantic model deliberately does not carry.
 */
export const makeExplicit = (
  syntax: SyntaxFile.SyntaxFile,
  context: SemanticContext.SemanticContext,
  declaration: AuthoredHir.Declaration,
  self: DeclarationLifetime.Context,
  executable?: Type.ExecutableLifetimes,
): Option.Option<LifetimeElision> => {
  if (self.diagnostics.length > 0) return Option.none()
  const source = syntax.source
  const declarationSpan = context.spanOf(declaration.header.anchor)
  const declarationNode = nodeAt(syntax.root, declarationSpan)
  if (declarationNode === undefined) return Option.none()
  const insertions = new Map<number, string>()
  const insert = (offset: number, text: string, prepend = false): void => {
    const existing = insertions.get(offset) ?? ''
    insertions.set(offset, prepend ? `${text}${existing}` : `${existing}${text}`)
  }
  const spelling = (span: SourceSpan.SourceSpan): string =>
    String.fromCharCode(...source.bytes.slice(span.start, span.end))
  const listBinders = (node: SyntaxTree.Node, names: ReadonlyArray<string>): boolean => {
    if (names.length === 0) return true
    const list = SyntaxTree.directNode(node, 'TypeParameterList')
    if (list !== undefined) {
      const close = SyntaxTree.directToken(list, 'Greater')
      if (close === undefined) return false
      insert(
        close.span.start,
        `${list.children.some(SyntaxTree.isNode) ? ', ' : ''}${names.join(', ')}`,
      )
      return true
    }
    const name = SyntaxTree.directToken(node, 'Identifier')
    if (name === undefined) return false
    insert(name.span.end, `<${names.join(', ')}>`)
    return true
  }
  const effectKeyword = SyntaxTree.directToken(declarationNode, 'EffectKeyword')
  if (
    executable !== undefined &&
    effectKeyword !== undefined &&
    self.explicitEnvironment === undefined
  )
    insert(effectKeyword.span.end, `<${Lifetime.display(executable.environment)}>`)
  const requiredBounds = new Map<string, Array<Lifetime.Lifetime>>()
  for (const bound of executable?.lifetimeBounds ?? []) {
    const key = Lifetime.key(bound.longer)
    requiredBounds.set(key, [...(requiredBounds.get(key) ?? []), bound.shorter])
  }
  for (const bound of executable?.typeOutlives ?? []) {
    const key = Type.key(bound.type)
    requiredBounds.set(key, [...(requiredBounds.get(key) ?? []), bound.lifetime])
  }
  const boundNames = (key: string): ReadonlyArray<string> => [
    ...new Set((requiredBounds.get(key) ?? []).map(Lifetime.display)),
  ]
  const parameterName = (parameter: Type.Parameter): string => {
    const bounds = boundNames(Type.key(parameter))
    return `${parameter.name}${bounds.length === 0 ? '' : `: ${bounds.join(' + ')}`}`
  }
  const declaredKeys = new Set([
    ...[...self.parameters.values()].map(Type.key),
    ...self.implicit.map((binder) => Type.key(binder.parameter)),
  ])
  const generated = (executable?.lifetimeBinders ?? []).filter(
    (binder) => !declaredKeys.has(Lifetime.key(binder)),
  )
  if (
    !listBinders(declarationNode, [
      ...self.implicit.map((binder) => parameterName(binder.parameter)),
      ...generated.map((binder) => {
        const bounds = boundNames(Lifetime.key(binder))
        return `${Lifetime.display(binder)}${bounds.length === 0 ? '' : `: ${bounds.join(' + ')}`}`
      }),
    ])
  )
    return Option.none()
  const parameterList = SyntaxTree.directNode(declarationNode, 'TypeParameterList')
  for (const node of parameterList?.children ?? []) {
    if (!SyntaxTree.isNode(node) || !['TypeParameter', 'LifetimeParameter'].includes(node.kind))
      continue
    const tokens = SyntaxTree.tokens(node).filter(significant)
    const name = tokens.at(0)
    const last = tokens.at(-1)
    if (name === undefined || last === undefined) return Option.none()
    const parameter = self.parameters.get(spelling(name.span))
    if (parameter === undefined) continue
    const authored = new Set(
      tokens
        .slice(1)
        .filter((token) => token.kind === 'Lifetime')
        .map((token) => spelling(token.span)),
    )
    const missing = boundNames(Type.key(parameter)).filter((name) => !authored.has(name))
    if (missing.length > 0)
      insert(
        last.span.end,
        `${tokens.some((token) => token.kind === 'Colon') ? ' + ' : ': '}${missing.join(' + ')}`,
        true,
      )
  }
  // Each elaborated region names an authored annotation; syntax supplies only its insertion point.
  const authoredTypes = annotations(declaration)
  for (const [key, type] of authoredTypes) {
    const lifetime = self.regions.get(key)
    const node = nodeAt(syntax.root, context.spanOf(type.anchor))
    if (lifetime === undefined || node === undefined) continue
    if (type._tag === 'ReferenceType' || type._tag === 'SliceType') {
      if (type.lifetime !== undefined) continue
      const ampersand = SyntaxTree.directToken(node, 'Ampersand')
      if (ampersand === undefined) return Option.none()
      const next = source.bytes.at(ampersand.span.end)
      insert(
        ampersand.span.end,
        `${Lifetime.display(lifetime)}${next === 32 || next === 9 || next === 10 || next === 13 ? '' : ' '}`,
      )
    } else if (type._tag === 'NamedType' && !self.nominalArguments.has(key)) {
      const token = SyntaxTree.directToken(node, 'Identifier')
      if (token !== undefined && spelling(token.span) === 'string')
        insert(token.span.end, `<${Lifetime.display(lifetime)}>`)
    } else if (type._tag === 'AppliedType' && !self.nominalArguments.has(key)) {
      const list = SyntaxTree.directNode(node, 'TypeArgumentList')
      if (list === undefined || SyntaxTree.directNode(list, 'EffectEnvironment') !== undefined)
        continue
      if (type.arguments.environment !== undefined) continue
      const path = SyntaxTree.directNode(node, 'TypePath')
      const token = path === undefined ? undefined : SyntaxTree.directToken(path, 'Identifier')
      if (token === undefined || spelling(token.span) !== 'Effect') continue
      const open = SyntaxTree.directToken(list, 'Less')
      if (open === undefined) return Option.none()
      insert(open.span.end, `${Lifetime.display(lifetime)}; `)
    }
  }
  for (const [key, type] of authoredTypes) {
    const lifetimes = self.nominalArguments.get(key)
    if (lifetimes === undefined) continue
    const node = nodeAt(syntax.root, context.spanOf(type.anchor))
    if (node === undefined) return Option.none()
    const argumentsText = lifetimes.map(Lifetime.display).join(', ')
    const list = SyntaxTree.directNode(node, 'TypeArgumentList')
    if (list !== undefined) {
      const open = SyntaxTree.directToken(list, 'Less')
      if (open === undefined) return Option.none()
      insert(open.span.end, `${argumentsText}${list.children.some(SyntaxTree.isNode) ? ', ' : ''}`)
    } else {
      const token = SyntaxTree.tokens(node).filter(significant).at(-1)
      if (token === undefined) return Option.none()
      insert(token.span.end, `<${argumentsText}>`)
    }
  }
  for (const [key, type] of authoredTypes) {
    const contract = self.callables.get(key)
    if (contract === undefined) continue
    const node = nodeAt(syntax.root, context.spanOf(type.anchor))
    if (node === undefined) return Option.none()
    const fn = SyntaxTree.directToken(node, 'FnKeyword')
    if (fn === undefined) return Option.none()
    if (SyntaxTree.directNode(node, 'CallableEnvironment') === undefined)
      insert(fn.span.end, `<${Lifetime.display(contract.environment)}>`)
    const list = SyntaxTree.directNode(node, 'LifetimeBinderList')
    const authoredCount =
      list === undefined ? 0 : SyntaxTree.directNodes(list, 'LifetimeParameter').length
    const omitted = contract.lifetimeBinders.slice(authoredCount).map(Lifetime.display)
    if (omitted.length === 0) continue
    if (list === undefined) {
      const first = SyntaxTree.tokens(node).find(significant)
      if (first === undefined) return Option.none()
      insert(first.span.start, `for<${omitted.join(', ')}> `)
    } else {
      const close = SyntaxTree.directToken(list, 'Greater')
      if (close === undefined) return Option.none()
      insert(close.span.start, `${authoredCount === 0 ? '' : ', '}${omitted.join(', ')}`)
    }
  }
  if (insertions.size === 0) return Option.none()
  const edits: Array<SourceAction.Edit> = []
  for (const [offset, replacement] of insertions) {
    const span = SourceSpan.fromOffsets(source.id, offset, offset)
    if (span === undefined) return Option.none()
    edits.push(SourceAction.edit(span, replacement))
  }
  const plan = SourceAction.changePlan({
    preconditions: [SourceAction.precondition(source)],
    changes: [[source.id, edits]],
  })
  return Option.map(plan, (plan) => ({
    descriptor: SourceAction.descriptor({
      key: 'make-lifetimes-explicit',
      title: 'Make lifetimes explicit',
      kind: 'RefactorRewrite',
      target: declarationSpan,
    }),
    plan,
  }))
}
