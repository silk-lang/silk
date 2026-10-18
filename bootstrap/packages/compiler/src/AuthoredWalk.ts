import type * as AuthoredHir from './AuthoredHir.js'
import * as AuthoredIdentity from './AuthoredIdentity.js'
import type * as DeclarationFacts from './DeclarationFacts.js'
import type * as SemanticContext from './SemanticContext.js'

/**
 * Traversal of one authored body in document order.
 *
 * Body analysis needs three things syntax used to provide by walking children: the block a
 * declaration's body owns, every statement below it, and the anchors of every node in preorder.
 * Authored HIR exposes each construct's parts as named fields, so traversal is a closed dispatch
 * over the vocabulary rather than an untyped child scan.
 */

const emptyBlock = (anchor: AuthoredHir.Anchor): AuthoredHir.Block => ({
  _tag: 'Block',
  anchor,
  origin: { _tag: 'Authored' },
  causes: [],
  statements: [],
})

/**
 * The canonical module name semantic comparisons use.
 *
 * `presentation.sourceId` is the loaded source's id, which fixtures and virtual sources spell with
 * a scheme (`tir://x.silk`). Declaration identities, name resolution and visibility all key on the
 * authored owner's canonical module name, so semantic comparisons must read it from the module.
 */
export const moduleName = (context: SemanticContext.SemanticContext): string =>
  context.module.owner.module

type CallableExpression = Extract<AuthoredHir.Expression, { readonly _tag: 'CallableExpression' }>

/** Every owner a module names, keyed by `AuthoredIdentity.key`. */
interface OwnerIndex {
  readonly declarations: ReadonlyMap<string, AuthoredHir.Declaration>
  readonly callables: ReadonlyMap<string, CallableExpression>
}

// Authored modules are never edited after lowering, and body analysis resolves one owner per
// analyzed body (twice per anonymous callable), so each module's owners are indexed once instead
// of rescanning every declaration and body per lookup.
const ownerIndexes = new WeakMap<AuthoredHir.Module, OwnerIndex>()

const ownerIndex = (module: AuthoredHir.Module): OwnerIndex => {
  const cached = ownerIndexes.get(module)
  if (cached !== undefined) return cached
  const declarations = new Map<string, AuthoredHir.Declaration>()
  const callables = new Map<string, CallableExpression>()
  const pending = [...module.declarations]
  while (pending.length > 0) {
    const declaration = pending.pop()
    if (declaration === undefined) break
    const key = AuthoredIdentity.key(declaration.owner)
    if (!declarations.has(key)) declarations.set(key, declaration)
    if (declaration.body._tag === 'MembersBody') pending.push(...declaration.body.members)
    else if (declaration.body._tag === 'ConditionalBody') {
      pending.push(declaration.body.thenBranch)
      if (declaration.body.elseBranch !== undefined) pending.push(declaration.body.elseBranch)
    }
  }
  const visit = (block: AuthoredHir.Block): void => {
    for (const callable of callableExpressions(block)) {
      const key = AuthoredIdentity.key(callable.anchor.owner)
      if (!callables.has(key)) callables.set(key, callable)
      visit(callable.body)
    }
  }
  for (const block of callableBlocks(module)) visit(block)
  const index: OwnerIndex = { declarations, callables }
  ownerIndexes.set(module, index)
  return index
}

/** The authored declaration one owner identity names, at any nesting depth of the module. */
export const declarationOf = (
  module: AuthoredHir.Module,
  owner: AuthoredIdentity.Identity,
): AuthoredHir.Declaration | undefined =>
  ownerIndex(module).declarations.get(AuthoredIdentity.key(owner))

/** The authored block a callable declaration elaborates, empty when the body is absent. */
export const bodyBlock = (
  context: SemanticContext.SemanticContext,
  declaration: DeclarationFacts.DeclarationFact,
): AuthoredHir.Block => {
  const found = declarationOf(context.module, declaration.owner)
  if (found !== undefined)
    return found.body._tag === 'CallableBody' && found.body.block !== undefined
      ? found.body.block
      : emptyBlock(declaration.anchor)
  // Hidden declarations belong to anonymous callables, which are nested owners inside a body.
  return callableOf(context.module, declaration.owner)?.body ?? emptyBlock(declaration.anchor)
}

/** Every callable body block a module owns directly, at any declaration nesting depth. */
const callableBlocks = (module: AuthoredHir.Module): ReadonlyArray<AuthoredHir.Block> => {
  const found: Array<AuthoredHir.Block> = []
  const pending = [...module.declarations]
  while (pending.length > 0) {
    const declaration = pending.pop()
    if (declaration === undefined) break
    if (declaration.body._tag === 'CallableBody') {
      if (declaration.body.block !== undefined) found.push(declaration.body.block)
    } else if (declaration.body._tag === 'MembersBody') pending.push(...declaration.body.members)
    else if (declaration.body._tag === 'ConditionalBody') {
      pending.push(declaration.body.thenBranch)
      if (declaration.body.elseBranch !== undefined) pending.push(declaration.body.elseBranch)
    }
  }
  return found
}

/** The anonymous callable one nested owner identity names, at any nesting depth of the module. */
export const callableOf = (
  module: AuthoredHir.Module,
  owner: AuthoredIdentity.Identity,
): CallableExpression | undefined => ownerIndex(module).callables.get(AuthoredIdentity.key(owner))

const blocksOf = (
  statement: AuthoredHir.Statement,
): ReadonlyArray<AuthoredHir.Block | AuthoredHir.Conditional> => {
  switch (statement._tag) {
    case 'ConditionalStatement':
    case 'PatternConditionalStatement':
    case 'StaticConditionalStatement':
      return statement.elseBranch === undefined
        ? [statement.thenBranch]
        : [statement.thenBranch, statement.elseBranch]
    case 'StaticForStatement':
    case 'WhileStatement':
    case 'UnsafeStatement':
      return [statement.body]
    default:
      return []
  }
}

/**
 * Blocks an expression owns within the same authored owner: effect bodies and block-valued match
 * arms. Anonymous callable bodies are nested owners and are deliberately excluded.
 */
const expressionBlocks = (expression: AuthoredHir.Expression): ReadonlyArray<AuthoredHir.Block> => {
  const found: Array<AuthoredHir.Block> = []
  const visit = (current: AuthoredHir.Expression): void => {
    if (current._tag === 'EffectExpression') found.push(current.body)
    if (current._tag === 'MatchExpression')
      for (const arm of current.arms) if (arm.result._tag === 'Block') found.push(arm.result)
    for (const child of expressionChildren(current)) visit(child)
  }
  visit(expression)
  return found
}

/** Every statement below one block, including nested arms and loop bodies, in document order. */
export const statements = (block: AuthoredHir.Block): ReadonlyArray<AuthoredHir.Statement> => {
  const found: Array<AuthoredHir.Statement> = []
  const visitBlock = (current: AuthoredHir.Block | AuthoredHir.Conditional): void => {
    if (current._tag !== 'Block') {
      visitStatement(current)
      return
    }
    for (const statement of current.statements) visitStatement(statement)
  }
  const visitStatement = (statement: AuthoredHir.Statement): void => {
    found.push(statement)
    for (const nested of blocksOf(statement)) visitBlock(nested)
    for (const expression of statementExpressions(statement))
      for (const nested of expressionBlocks(expression)) visitBlock(nested)
  }
  visitBlock(block)
  return found
}

/**
 * Preorder anchors of one authored body, assigning the stable finite lifetime domain.
 *
 * Every position body analysis can request a region for needs a point. That is each statement and
 * the expressions it owns, and also the types a body writes: elision keys a region by the
 * annotation's own anchor, so a written `Opt<&[u8]>` needs points for the applied type and for the
 * slice inside it, not just for the statement around them.
 */
export const anchors = (block: AuthoredHir.Block): ReadonlyArray<AuthoredHir.Anchor> => {
  const found: Array<AuthoredHir.Anchor> = [block.anchor]
  const visitType = (type: AuthoredHir.Type): void => {
    found.push(type.anchor)
    for (const nested of typeChildren(type)) visitType(nested)
  }
  const visitExpression = (expression: AuthoredHir.Expression): void => {
    found.push(expression.anchor)
    // A nested callable owns its body, but what it captures borrows from this body's regions, so
    // its header and body positions belong to the same finite domain.
    if (expression._tag === 'CallableExpression') {
      const contract = expression.contract
      for (const parameter of contract.parameters) visitType(parameter.type)
      if (contract.result !== undefined) visitType(contract.result)
      if (contract.failures !== undefined) visitType(contract.failures)
      for (const member of contract.requirements?.members ?? [])
        for (const type of rowOperandTypes(member)) visitType(type)
      found.push(...anchors(expression.body))
    }
    for (const child of expressionChildren(expression)) visitExpression(child)
  }
  for (const statement of statements(block)) {
    found.push(statement.anchor)
    for (const expression of statementExpressions(statement)) visitExpression(expression)
  }
  for (const type of bodyTypes(block)) visitType(type)
  return found
}

/** A generic argument carries a type unless it is a lifetime. */
const genericArgumentTypes = (
  argument: AuthoredHir.GenericArgument,
): ReadonlyArray<AuthoredHir.Type> => {
  if (argument._tag === 'Lifetime') return []
  if (argument._tag === 'RequirementSelector') return [argument.subject]
  return [argument]
}

/** A row operand is a type outright, or a requirement whose capability is one. */
const rowOperandTypes = (operand: AuthoredHir.RowOperand): ReadonlyArray<AuthoredHir.Type> =>
  operand._tag === 'Requirement' ? [operand.capability] : [operand]

/** The types one type owns directly, so elision can reach every nested annotation. */
export const typeChildren = (type: AuthoredHir.Type): ReadonlyArray<AuthoredHir.Type> => {
  switch (type._tag) {
    case 'ReferenceType':
      return [type.referent]
    case 'SliceType':
    case 'FixedArrayType':
      return [type.element]
    case 'PointerType':
      return [type.pointee]
    case 'ExactRepresentationType':
      return [type.subject]
    case 'OpaqueResultType':
      return [type.result]
    case 'UnionType':
      return type.members.flatMap(rowOperandTypes)
    case 'RowWithout':
      return [...rowOperandTypes(type.source), ...rowOperandTypes(type.removed)]
    case 'AppliedType':
      return [
        type.target,
        ...type.arguments.arguments.flatMap(genericArgumentTypes),
        ...(type.arguments.failures === undefined ? [] : [type.arguments.failures]),
        ...(type.arguments.requirements === undefined
          ? []
          : type.arguments.requirements.members.flatMap(rowOperandTypes)),
      ]
    case 'CallableType':
    case 'ForeignFunctionType':
      return [...type.parameters, type.result]
    case 'InvalidType':
      return type.retained.filter((retained): retained is AuthoredHir.Type => 'anchor' in retained)
    default:
      return []
  }
}

/** The expressions one statement owns directly, in evaluation order. */
export const statementExpressions = (
  statement: AuthoredHir.Statement,
): ReadonlyArray<AuthoredHir.Expression> => {
  switch (statement._tag) {
    case 'ExpressionStatement':
      return [statement.expression]
    case 'BindingStatement':
      return [statement.initializer]
    case 'PatternBindingStatement':
      return [statement.initializer]
    case 'AssignmentStatement':
      return [statement.target, statement.value]
    case 'StaticForStatement':
      return [statement.iterable]
    case 'WhileStatement':
      return [statement.condition]
    case 'ConditionalStatement':
    case 'StaticConditionalStatement':
      return [statement.condition]
    case 'PatternConditionalStatement':
      return [statement.subject]
    case 'ReturnStatement':
      return statement.value === undefined ? [] : [statement.value]
    case 'FailStatement':
      return [statement.value]
    case 'DropStatement':
      return [statement.value]
    case 'InvalidStatement':
      return statement.retained.filter(
        (retained): retained is AuthoredHir.Expression =>
          retained._tag !== 'MissingStatement' && !('statements' in retained),
      )
    default:
      return []
  }
}

/** The expressions one expression owns directly, in evaluation order. */
export const expressionChildren = (
  expression: AuthoredHir.Expression,
): ReadonlyArray<AuthoredHir.Expression> => {
  switch (expression._tag) {
    case 'MoveExpression':
    case 'BorrowExpression':
    case 'RunExpression':
    case 'UnsafeExpression':
      return [expression.operand]
    case 'CompileErrorExpression':
      return [expression.message]
    case 'MatchExpression':
      return [
        expression.subject,
        ...expression.arms.flatMap((arm): ReadonlyArray<AuthoredHir.Expression> => [
          ...(arm.guard === undefined ? [] : [arm.guard]),
          ...(arm.result._tag === 'Block' ? [] : [arm.result]),
        ]),
      ]
    case 'StructExpression':
      return expression.fields.map((field) => field.value)
    case 'RecordExpression':
      return expression.fields.map((field) => field.value)
    case 'TupleExpression':
    case 'ArrayExpression':
      return expression.elements
    case 'MemberExpression':
      return expression.fields === undefined ? [] : expression.fields.map((field) => field.value)
    case 'FieldExpression':
    case 'ReferentExpression':
      return [expression.subject]
    case 'OrdinalExpression':
      return [expression.subject]
    case 'IndexExpression':
      return [expression.subject, expression.index]
    case 'CallExpression':
      return [expression.callee, ...expression.arguments]
    case 'PrefixExpression':
      return [expression.operand]
    case 'InfixExpression':
      return [expression.left, expression.right]
    case 'PipelineExpression':
      return [expression.input, expression.target]
    case 'InvalidExpression':
      return expression.retained
    default:
      return []
  }
}

/** Anonymous callables below one body, in traversal order; their ordinal names `$callable$N`. */
export const callableExpressions = (
  block: AuthoredHir.Block,
): ReadonlyArray<CallableExpression> => {
  const found: Array<CallableExpression> = []
  const visit = (expression: AuthoredHir.Expression): void => {
    if (expression._tag === 'CallableExpression') {
      found.push(expression)
      // A nested callable belongs to its own declaration's counter, not this one.
      return
    }
    for (const child of expressionChildren(expression)) visit(child)
  }
  for (const statement of statements(block))
    for (const expression of statementExpressions(statement)) visit(expression)
  return found
}

/** The types one pattern writes, including the annotations its nested fields write. */
const patternTypes = (pattern: AuthoredHir.Pattern): ReadonlyArray<AuthoredHir.Type> => {
  const found: Array<AuthoredHir.Type> = []
  const visit = (current: AuthoredHir.Pattern): void => {
    switch (current._tag) {
      case 'NominalPattern':
        found.push(current.type)
        for (const field of current.fields) if (field._tag === 'PatternField') visit(field.pattern)
        return
      case 'BindingPattern':
        if (current.type !== undefined) found.push(current.type)
        return
      case 'VariantPattern':
        found.push(current.selector.subject)
        for (const field of current.fields ?? [])
          if (field._tag === 'PatternField') visit(field.pattern)
        return
      case 'InvalidPattern':
        for (const retained of current.retained)
          if (retained._tag !== 'Name' && 'statements' in retained === false) {
            if (isPattern(retained)) visit(retained)
            else if (isType(retained)) found.push(retained)
          }
        return
      default:
        return
    }
  }
  visit(pattern)
  return found
}

const patternTags: ReadonlySet<string> = new Set([
  'EnumPattern',
  'IntegerPattern',
  'NominalPattern',
  'BindingPattern',
  'UniversalPattern',
  'VariantPattern',
  'MissingPattern',
  'InvalidPattern',
])

const isPattern = (node: { readonly _tag: string }): node is AuthoredHir.Pattern =>
  patternTags.has(node._tag)

const isType = (node: { readonly _tag: string }): node is AuthoredHir.Type =>
  !patternTags.has(node._tag) && node._tag !== 'Name'

/**
 * Every type one authored body writes, in document order.
 *
 * Lifetime elaboration must reach the annotations a body writes — a call's explicit type
 * arguments, a binding's declared type, a pattern's named type — because each one can elide a
 * region the body owns. Header traversal alone leaves those anchors without a region.
 */
export const bodyTypes = (block: AuthoredHir.Block): ReadonlyArray<AuthoredHir.Type> => {
  const found: Array<AuthoredHir.Type> = []
  const visitExpression = (expression: AuthoredHir.Expression): void => {
    if (expression._tag === 'CallExpression' && expression.generics !== undefined)
      for (const argument of expression.generics.arguments)
        if (argument._tag === 'RequirementSelector') found.push(argument.subject)
        else if (argument._tag !== 'Lifetime') found.push(argument)
    if (expression._tag === 'StructExpression') found.push(expression.type)
    if (expression._tag === 'MemberExpression') found.push(expression.selector.subject)
    if (expression._tag === 'MatchExpression')
      for (const arm of expression.arms) found.push(...patternTypes(arm.pattern))
    // A nested callable's body elides regions in the enclosing declaration's domain.
    if (expression._tag === 'CallableExpression') found.push(...bodyTypes(expression.body))
    for (const child of expressionChildren(expression)) visitExpression(child)
  }
  for (const statement of statements(block)) {
    if (statement._tag === 'BindingStatement' && statement.type !== undefined)
      found.push(statement.type)
    if (statement._tag === 'PatternBindingStatement') found.push(...patternTypes(statement.pattern))
    if (statement._tag === 'PatternConditionalStatement')
      found.push(...patternTypes(statement.pattern))
    for (const expression of statementExpressions(statement)) visitExpression(expression)
  }
  return found
}

/** True when an authored node is not a lexical-recovery placeholder. */
export const isAvailable = (
  node: AuthoredHir.Expression | AuthoredHir.Pattern | AuthoredHir.Type,
): boolean =>
  // Recovery keeps an absent operand as an identifier over a missing name.
  !(node._tag === 'IdentifierExpression' && node.name._tag !== 'Name') &&
  // …and an absent type as a named type over one.
  !(node._tag === 'NamedType' && node.path.segments.some((segment) => segment._tag !== 'Name')) &&
  node._tag !== 'MissingExpression' &&
  node._tag !== 'InvalidExpression' &&
  node._tag !== 'MissingPattern' &&
  node._tag !== 'InvalidPattern' &&
  node._tag !== 'MissingType' &&
  node._tag !== 'InvalidType'
