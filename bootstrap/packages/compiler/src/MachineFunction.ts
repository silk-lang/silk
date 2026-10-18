import type * as AuthoredHir from './AuthoredHir.js'
import * as AuthoredWalk from './AuthoredWalk.js'
import * as ConfigurationError from './ConfigurationError.js'
import * as ConfigurationOrigin from './ConfigurationOrigin.js'
import type * as DeclarationFacts from './DeclarationFacts.js'
import * as Diagnostic from './Diagnostic.js'
import * as Location from './Location.js'
import type * as SemanticContext from './SemanticContext.js'
import type * as SourceSpan from './SourceSpan.js'
import * as Type from './Type.js'

/** A compiler-work-free entry body. Both guarantees are inseparable in this initial subset. */
export interface MachineFunction {
  readonly naked: true
  readonly noReturn: true
  readonly span: SourceSpan.SourceSpan
  readonly anchor: AuthoredHir.Anchor
}

const diagnostic = (
  detail: string,
  context: SemanticContext.SemanticContext,
  anchor: AuthoredHir.Anchor,
): Diagnostic.Located => {
  const span = context.spanOf(anchor)
  return Diagnostic.invalidAuthoredConfiguration(
    ConfigurationError.make('MachineFunction.validate', 'InvalidInput', detail, [
      { ...ConfigurationOrigin.literal(span.sourceId), span },
    ]),
    Location.at(anchor),
  )
}

/** The authored property clauses one declaration header carries, empty when it admits none. */
const clausesOf = (
  header: AuthoredHir.DeclarationHeader,
): ReadonlyArray<AuthoredHir.PropertyClause> =>
  header._tag === 'FunctionHeader' ||
  header._tag === 'OperationHeader' ||
  header._tag === 'ModulePropertyHeader'
    ? header.properties
    : []

/** `namespace.operation` of one authored clause, using the pool text behind each name. */
export const clauseOwner = (
  context: SemanticContext.SemanticContext,
  clause: AuthoredHir.PropertyClause,
): string => `${nameText(context, clause.namespace)}.${nameText(context, clause.operation)}`

const nameText = (context: SemanticContext.SemanticContext, name: AuthoredHir.Name): string => {
  if (name._tag === 'Name') return context.textOf(name.text)
  if (name._tag === 'InvalidName') return context.textOf(name.spelling)
  return ''
}

/** Validates the sealed property clause independently of declaration spelling or library ownership. */
export const analyze = (
  context: SemanticContext.SemanticContext,
  declaration: AuthoredHir.Declaration,
): {
  readonly properties?: MachineFunction
  readonly diagnostics: ReadonlyArray<Diagnostic.Located>
} => {
  const clauses = clausesOf(declaration.header).filter(
    (clause) => clauseOwner(context, clause) === 'Intrinsic.machine',
  )
  const clause = clauses[0]
  if (clause === undefined) return { diagnostics: [] }
  const properties = new Set<string>()
  const diagnostics: Array<Diagnostic.Located> = []
  if (clauses.length !== 1)
    diagnostics.push(
      ...clauses.map((entry) =>
        diagnostic('duplicate machine function clause', context, entry.anchor),
      ),
    )
  for (const property of clause.properties) {
    const spelling = nameText(context, property.name)
    // Authored HIR carries the literal's exact value, so admission never re-reads source bytes.
    if (
      (spelling !== 'naked' && spelling !== 'noReturn') ||
      properties.has(spelling) ||
      property.value._tag !== 'BooleanLiteral' ||
      !property.value.value
    )
      diagnostics.push(
        diagnostic(
          'machine properties require naked: true and noReturn: true',
          context,
          property.anchor,
        ),
      )
    properties.add(spelling)
  }
  if (!properties.has('naked') || !properties.has('noReturn'))
    diagnostics.push(
      diagnostic('machine properties require naked and noReturn', context, clause.anchor),
    )
  return diagnostics.length > 0
    ? { diagnostics }
    : {
        properties: {
          naked: true,
          noReturn: true,
          span: context.spanOf(clause.anchor),
          anchor: clause.anchor,
        },
        diagnostics: [],
      }
}

/** The single call one terminal body reduces to, unwrapping the statement forms that only nest. */
const terminalCall = (
  block: AuthoredHir.Block,
): Extract<AuthoredHir.Expression, { readonly _tag: 'CallExpression' }> | undefined => {
  const statement = block.statements.length === 1 ? block.statements[0] : undefined
  if (statement === undefined) return undefined
  if (statement._tag === 'UnsafeStatement') return terminalCall(statement.body)
  let current: AuthoredHir.Expression | undefined
  if (statement._tag === 'ExpressionStatement') current = statement.expression
  else if (statement._tag === 'ReturnStatement') current = statement.value
  while (current?._tag === 'UnsafeExpression') current = current.operand
  return current?._tag === 'CallExpression' ? current : undefined
}

/** The `Namespace.member` a callee names, or `undefined` when it selects nothing nameable. */
const calleePath = (
  context: SemanticContext.SemanticContext,
  callee: AuthoredHir.Expression,
): string | undefined => {
  // `Intrinsic.assembly` lowers as a field of the `Intrinsic` name when nothing marks it a type.
  if (callee._tag === 'FieldExpression' && callee.subject._tag === 'IdentifierExpression')
    return `${nameText(context, callee.subject.name)}.${nameText(context, callee.field)}`
  if (callee._tag !== 'MemberExpression') return undefined
  const subject = callee.selector.subject
  if (subject._tag !== 'NamedType') return undefined
  const namespace = subject.path.segments.map((segment) => nameText(context, segment)).join('.')
  return `${namespace}.${nameText(context, callee.selector.member)}`
}

/** Rejects bodies that could require compiler-created stack state before any lowering occurs. */
export const bodyDiagnostics = (
  context: SemanticContext.SemanticContext,
  declaration: DeclarationFacts.DeclarationFact,
): ReadonlyArray<Diagnostic.Located> => {
  const properties = declaration.machine
  if (properties === undefined) return []
  const rejected = (detail: string) => [diagnostic(detail, context, properties.anchor)]
  if (
    !declaration.unsafe ||
    declaration.phase !== 'Runtime' ||
    declaration.functionKind !== 'Ordinary' ||
    declaration.parameters.length !== 0 ||
    declaration.typeParameters.length !== 0 ||
    declaration.returnType._tag !== 'Resolved' ||
    !Type.equals(declaration.returnType.type, Type.unit)
  )
    return rejected('naked functions require an unsafe monomorphic zero-argument unit signature')
  const call = terminalCall(AuthoredWalk.bodyBlock(context, declaration))
  if (call === undefined)
    return rejected('naked bodies require one terminal operand-free assembly invocation')
  if (calleePath(context, call.callee) !== 'Intrinsic.assembly')
    return rejected('naked bodies admit only Intrinsic.assembly')
  return []
}
