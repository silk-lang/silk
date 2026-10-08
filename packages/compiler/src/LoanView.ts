import type * as AuthoredHir from './AuthoredHir.js'
import * as AuthoredIdentity from './AuthoredIdentity.js'
import * as DeclarationFacts from './DeclarationFacts.js'
import type * as DeclarationIndex from './DeclarationIndex.js'
import * as Lifetime from './Lifetime.js'
import type * as SourceSpan from './SourceSpan.js'
import type * as Tir from './Tir.js'
import * as TirModule from './Tir.js'
import * as Type from './Type.js'

/**
 * Exactly what loan analysis reads of a body.
 *
 * Loan analysis asks a small number of questions of each expression: what kind it is, where it was
 * written, its type, which local it names, how a borrow was formed. This is that vocabulary and
 * nothing else, so the analysis depends on these questions rather than on one body representation.
 */
export type ExpressionType =
  | { readonly _tag: 'Available'; readonly type: DeclarationFacts.SemanticType }
  | { readonly _tag: 'Unavailable' }

interface Base {
  readonly type: ExpressionType
  readonly anchor: AuthoredHir.Anchor
  readonly ref: Tir.NodeRef
}

/** A local as loan analysis names it: its id, its spelling and, for a parameter, its declared type. */
export type Local =
  | {
      readonly _tag: 'BindingFact'
      readonly mutability: 'Immutable' | 'Mutable'
      readonly id: Tir.LocalId
      readonly name: Name
      readonly inferredType: ExpressionType
    }
  | {
      readonly _tag: 'PatternBinding'
      readonly id: Tir.LocalId
      readonly name: Name
      readonly type: ExpressionType
    }
  | {
      readonly _tag: 'ParameterDeclaration'
      readonly id: Tir.LocalId
      readonly name: Name
      readonly declaredType: DeclarationFacts.DeclaredTypeFact
    }

export type Name =
  | { readonly _tag: 'Present'; readonly spelling: string }
  | { readonly _tag: 'Unavailable' }

export type Reference =
  | {
      readonly _tag: 'ResolvedBinding'
      readonly binding: Extract<Local, { readonly _tag: 'BindingFact' }>
      readonly spelling: string
    }
  | {
      readonly _tag: 'ResolvedPattern'
      readonly binding: Extract<Local, { readonly _tag: 'PatternBinding' }>
      readonly spelling: string
    }
  | {
      readonly _tag: 'Resolved'
      readonly parameter: Extract<Local, { readonly _tag: 'ParameterDeclaration' }>
      readonly spelling: string
    }
  | { readonly _tag: 'Missing' | 'Ambiguous' | 'Unavailable' | 'Conflict' | 'Inaccessible' }

/** One step of a borrowed place. Only an index step evaluates anything. */
export type Selector =
  | {
      readonly _tag: 'Field'
      readonly field: DeclarationFacts.FieldId
      readonly span: SourceSpan.SourceSpan
    }
  | {
      readonly _tag: 'Index'
      readonly index: Expression
      readonly array: Type.FixedArray
      readonly bounds:
        | { readonly _tag: 'Proven'; readonly index: number; readonly length: number }
        | { readonly _tag: 'Runtime'; readonly length: number }
      readonly span: SourceSpan.SourceSpan
    }
  | {
      readonly _tag: 'SliceIndex'
      readonly index: Expression
      readonly slice: Type.Slice
      readonly span: SourceSpan.SourceSpan
    }

export type BorrowRoot =
  | {
      readonly _tag: 'BindingRoot'
      readonly binding: { readonly id: Tir.LocalId }
      readonly path: ReadonlyArray<Selector>
    }
  | {
      readonly _tag: 'ParameterRoot'
      readonly parameter: { readonly id: Tir.LocalId }
      readonly path: ReadonlyArray<Selector>
    }
  | {
      readonly _tag: 'PatternRoot'
      readonly binding: { readonly id: Tir.LocalId }
      readonly path: ReadonlyArray<Selector>
    }
  | {
      readonly _tag: 'TemporaryRoot'
      readonly owner: Tir.TemporaryOwnerId
      readonly path: ReadonlyArray<Selector>
    }

export type Formation =
  | { readonly _tag: 'FixedArrayBorrow'; readonly root: BorrowRoot }
  | { readonly _tag: 'ValueBorrow'; readonly root: BorrowRoot }
  | {
      readonly _tag: 'SliceReborrow' | 'ValueReborrow'
      readonly root: BorrowRoot
      readonly suspendsParent: boolean
    }
  | { readonly _tag: 'Unavailable' }

export interface Argument {
  readonly id: { readonly ordinal: number }
  readonly expression: Expression
  /** The actual argument node, before loan-view conversion erases a union adapter. */
  readonly anchor: AuthoredHir.Anchor
  readonly ref: Tir.NodeRef
  readonly type: ExpressionType
}

export type ArmBody =
  | { readonly _tag: 'Expression'; readonly expression: Expression }
  | { readonly _tag: 'Block'; readonly statements: ReadonlyArray<Statement> }

export type Expression =
  | (Base & {
      readonly _tag:
        | 'Integer'
        | 'Duration'
        | 'Floating'
        | 'Boolean'
        | 'Character'
        | 'Constant'
        | 'ForeignStatic'
        | 'StaticText'
        | 'Unit'
        | 'EnumMember'
        | 'FunctionItem'
    })
  | (Base & { readonly _tag: 'Identifier'; readonly reference: Reference })
  | (Base & { readonly _tag: 'Move' | 'ReferentProjection'; readonly subject: Expression })
  | (Base & {
      readonly _tag: 'FieldProjection'
      readonly subject: Expression
      readonly state:
        | { readonly _tag: 'Resolved'; readonly field: { readonly id: DeclarationFacts.FieldId } }
        | { readonly _tag: 'SliceLength' | 'Unavailable' }
    })
  | (Base & {
      readonly _tag: 'IndexProjection'
      readonly subject: Expression
      readonly index: Expression
      readonly array?: Type.FixedArray
      readonly bounds:
        | { readonly _tag: 'Proven'; readonly index: number; readonly length: number }
        | { readonly _tag: 'Runtime'; readonly length: number }
        | { readonly _tag: 'Invalid' | 'Unavailable' | 'RuntimeSlice' }
    })
  | (Base & {
      readonly _tag: 'Borrow'
      readonly access: Type.BorrowAccess
      readonly subject: Expression
      readonly formation: Formation
    })
  | (Base & {
      readonly _tag: 'StructLiteral' | 'UnionVariant'
      readonly initializers: ReadonlyArray<{
        readonly field: DeclarationFacts.FieldId
        readonly expression: Expression
      }>
    })
  | (Base & {
      readonly _tag: 'ArrayLiteral'
      readonly elements: ReadonlyArray<{ readonly expression: Expression }>
    })
  | (Base & {
      readonly _tag: 'Match'
      readonly scrutinee: Expression
      readonly arms: ReadonlyArray<{ readonly guard?: Expression; readonly body: ArmBody }>
    })
  | (Base & {
      readonly _tag: 'Operator'
      readonly arguments: ReadonlyArray<Argument>
      /** The declared operand types, when the operator is a bound interface operation. */
      readonly interfaceOperation?: {
        readonly contract: {
          readonly operands: ReadonlyArray<{
            readonly type: DeclarationFacts.DeclaredTypeFact
          }>
        }
      }
    })
  | (Base & { readonly _tag: 'ShortCircuit'; readonly arguments: ReadonlyArray<Argument> })
  | (Base & {
      readonly _tag: 'Call'
      readonly arguments: ReadonlyArray<Argument>
      readonly reference: { readonly _tag: string; readonly operation?: unknown }
      /** Direct argument loans the TIR builder proved are retained by this call's result. */
      readonly heldLoans?: ReadonlyArray<Tir.BorrowId>
    })
  | (Base & {
      readonly _tag: 'ForeignApply'
      readonly callee: Expression
      readonly arguments: ReadonlyArray<Argument>
      readonly evaluation: 'CalleeThenArguments' | 'LeftThenCallable'
    })
  | (Base & {
      readonly _tag: 'CallableApply'
      readonly invocationUse?: Tir.InvocationUseObligation
      readonly callee: Expression
      readonly arguments: ReadonlyArray<Argument>
      readonly mode: Type.CallableMode
      readonly staged?: {
        readonly site: Tir.CallableSiteId
        readonly captures: ReadonlyArray<{
          readonly ordinal: number
          readonly parameterOrdinal: number
          readonly argument: import('./AuthoredIdentity.js').Anchor
          readonly type: Type.Type
          readonly access: 'Copy' | 'Shared' | 'Exclusive' | 'Take'
        }>
      }
      readonly provenance: { readonly _tag: string }
    })
  | (Base & {
      readonly _tag: 'CallableSection'
      readonly invocationParameters?: ReadonlyArray<number>
      readonly site: Tir.CallableSiteId
      readonly remainingParameters: ReadonlyArray<number>
      readonly captures: ReadonlyArray<{
        readonly ordinal: number
        readonly parameterOrdinal: number
        readonly argument: Argument
        readonly expression: Expression
        readonly access: 'Copy' | 'Shared' | 'Exclusive' | 'Take'
      }>
    })
  | (Base & {
      readonly _tag: 'EffectBlock'
      readonly captures: ReadonlyArray<{
        readonly reference: Local
        readonly access: 'Copy' | 'Shared' | 'Exclusive' | 'Take'
        readonly span: SourceSpan.SourceSpan
        readonly expression?: { readonly anchor: AuthoredHir.Anchor }
      }>
      readonly bindings: ReadonlyArray<Binding>
      readonly statements: ReadonlyArray<Statement>
    })
  | (Base & { readonly _tag: 'Run'; readonly subject: Expression })
  | (Base & {
      readonly _tag: 'EffectCatch'
      readonly protected: Expression
      readonly handler: Expression
    })
  | (Base & {
      readonly _tag: 'EffectBindRequirement'
      readonly protected: Expression
      readonly provider?: {
        readonly reference: Exclude<Local, { readonly _tag: 'PatternBinding' }>
        readonly captureAccess: 'Copy' | 'Shared' | 'Exclusive' | 'Take'
        readonly span: SourceSpan.SourceSpan
      }
    })
  | (Base & {
      readonly _tag: 'PlaceReplace'
      readonly destination: Expression
      readonly value: Expression
    })
  | (Base & { readonly _tag: 'EnumValue'; readonly argument: Expression })
  | (Base & { readonly _tag: 'CompileError'; readonly message: Expression })

export interface Binding {
  readonly mutability: 'Immutable' | 'Mutable'
  readonly id: Tir.LocalId
  readonly initializer: Expression
  readonly inferredType: ExpressionType
}

interface Selection {
  readonly source: Expression
  readonly loanEnd: SourceSpan.SourceSpan
  readonly anchor: AuthoredHir.Anchor
}

export type Statement =
  | {
      readonly _tag: 'UnsafeStatement'
      readonly statements: ReadonlyArray<Statement>
      readonly region: Tir.RegionId
      readonly anchor: AuthoredHir.Anchor
    }
  | { readonly _tag: 'BindStatement'; readonly binding: Binding; readonly region: Tir.RegionId }
  | {
      readonly _tag: 'PatternBindStatement'
      readonly selection: Selection
      readonly region: Tir.RegionId
      readonly anchor: AuthoredHir.Anchor
    }
  | {
      readonly _tag: 'ExpressionStatement' | 'ReturnStatement' | 'FailStatement' | 'DropStatement'
      readonly expression: Expression
      readonly region: Tir.RegionId
      readonly anchor: AuthoredHir.Anchor
    }
  | {
      readonly _tag: 'IfStatement'
      readonly condition: Expression
      readonly taken: ReadonlyArray<Statement>
      readonly otherwise: ReadonlyArray<Statement>
      readonly region: Tir.RegionId
      readonly anchor: AuthoredHir.Anchor
    }
  | {
      readonly _tag: 'IfLetStatement'
      readonly selection: Selection
      readonly taken: ReadonlyArray<Statement>
      readonly otherwise: ReadonlyArray<Statement>
      readonly region: Tir.RegionId
      readonly anchor: AuthoredHir.Anchor
    }
  | {
      readonly _tag: 'WriteStatement'
      readonly destination: Expression
      readonly value: Expression
      readonly region: Tir.RegionId
      readonly anchor: AuthoredHir.Anchor
    }
  | {
      readonly _tag: 'WhileStatement'
      readonly condition: Expression
      readonly body: ReadonlyArray<Statement>
      readonly region: Tir.RegionId
      readonly anchor: AuthoredHir.Anchor
    }
  | {
      readonly _tag: 'BreakStatement' | 'ContinueStatement'
      readonly region: Tir.RegionId
      readonly anchor: AuthoredHir.Anchor
    }

/** One body as loan analysis reads it. */
export interface Body {
  readonly declaration: DeclarationFacts.DeclarationFact
  readonly statements: ReadonlyArray<Statement>
  readonly bindings: ReadonlyArray<Binding>
  readonly lifetimeFlow?: import('./LifetimeFlow.js').LifetimeFlow
}

/** The expressions one expression evaluates directly, in the order loan analysis visits them. */
export const children = (self: Expression): ReadonlyArray<Expression> => {
  switch (self._tag) {
    case 'Move':
    case 'ReferentProjection':
    case 'FieldProjection':
    case 'Borrow':
    case 'Run':
      return [self.subject]
    case 'IndexProjection':
      return [self.subject, self.index]
    case 'StructLiteral':
    case 'UnionVariant':
      return self.initializers.map((initializer) => initializer.expression)
    case 'ArrayLiteral':
      return self.elements.map((element) => element.expression)
    case 'Match':
      return [
        self.scrutinee,
        ...self.arms.flatMap((arm) => [
          ...(arm.guard === undefined ? [] : [arm.guard]),
          ...(arm.body._tag === 'Expression' ? [arm.body.expression] : []),
        ]),
      ]
    case 'Operator':
    case 'ShortCircuit':
    case 'Call':
      return self.arguments.map((argument) => argument.expression)
    case 'ForeignApply':
    case 'CallableApply':
      return [self.callee, ...self.arguments.map((argument) => argument.expression)]
    case 'CallableSection':
      return self.captures.map((capture) => capture.expression)
    case 'EffectCatch':
      return [self.protected, self.handler]
    case 'EffectBindRequirement':
      return [self.protected]
    case 'PlaceReplace':
      return [self.destination, self.value]
    case 'EnumValue':
      return [self.argument]
    case 'CompileError':
      return [self.message]
    default:
      return []
  }
}

const statementExpressions = (statement: Statement): ReadonlyArray<Expression> => {
  switch (statement._tag) {
    case 'BindStatement':
      return [statement.binding.initializer]
    case 'PatternBindStatement':
    case 'IfLetStatement':
      return [statement.selection.source]
    case 'ExpressionStatement':
    case 'ReturnStatement':
    case 'FailStatement':
    case 'DropStatement':
      return [statement.expression]
    case 'IfStatement':
    case 'WhileStatement':
      return [statement.condition]
    case 'WriteStatement':
      return [statement.destination, statement.value]
    default:
      return []
  }
}

const visitExpression = (self: Expression, visit: (expression: Expression) => void): void => {
  visit(self)
  if (self._tag === 'Match') {
    visitExpression(self.scrutinee, visit)
    for (const arm of self.arms) {
      if (arm.guard !== undefined) visitExpression(arm.guard, visit)
      if (arm.body._tag === 'Expression') visitExpression(arm.body.expression, visit)
      else visitExpressions(arm.body.statements, visit)
    }
    return
  }
  if (self._tag === 'EffectBlock') {
    visitExpressions(self.statements, visit)
    return
  }
  for (const child of children(self)) visitExpression(child, visit)
}

/** Visits every expression of a body in source order, nested blocks included. */
export const visitExpressions = (
  self: ReadonlyArray<Statement>,
  visit: (expression: Expression) => void,
): void => {
  for (const statement of self) {
    for (const expression of statementExpressions(statement)) visitExpression(expression, visit)
    if (statement._tag === 'UnsafeStatement') visitExpressions(statement.statements, visit)
    else if (statement._tag === 'IfStatement' || statement._tag === 'IfLetStatement') {
      visitExpressions(statement.taken, visit)
      visitExpressions(statement.otherwise, visit)
    } else if (statement._tag === 'WhileStatement') visitExpressions(statement.body, visit)
  }
}

/** Original stored input provenance in one actual callable value graph. */
export interface InvocationRecipe {
  readonly parameters: ReadonlyArray<number>
  readonly captures: ReadonlyArray<{
    readonly parameter: number
    readonly capture: number
    readonly argument: Argument
    readonly leaf: Tir.CallableSiteId
    readonly capturePath?: ReadonlyArray<Tir.InvocationCapturePathStep>
  }>
}

const sameCapturePath = (
  left: ReadonlyArray<Tir.InvocationCapturePathStep> | undefined,
  right: ReadonlyArray<Tir.InvocationCapturePathStep> | undefined,
): boolean =>
  left === undefined
    ? right === undefined
    : right !== undefined &&
      left.length === right.length &&
      left.every((step, ordinal) => {
        const other = right.at(ordinal)
        return (
          other !== undefined &&
          step._tag === other._tag &&
          TirModule.nodeRefEquals(step.site.node, other.site.node) &&
          TirModule.sameExecutableSite(step.site, other.site) &&
          (step._tag === 'Base' || (other._tag === 'Capture' && step.ordinal === other.ordinal))
        )
      })

/** Authenticates exact checked operands; undefined means a required obligation is malformed. */
export const invocationArguments = (
  self: Extract<Expression, { readonly _tag: 'CallableApply' }>,
  recipe?: InvocationRecipe,
):
  | ReadonlyArray<{
      readonly input: Tir.InvocationUseObligation['inputs'][number]
      readonly argument: Argument
    }>
  | undefined => {
  let contract: Type.Callable | undefined
  if (self.callee.type._tag === 'Available') {
    if (Type.isCallable(self.callee.type.type)) contract = self.callee.type.type
    else if (
      Type.isRepresented(self.callee.type.type) &&
      Type.isCallable(self.callee.type.type.contract)
    )
      contract = self.callee.type.type.contract
  }
  const usage = contract?.invocationUse
  if (self.staged !== undefined) return self.invocationUse === undefined ? [] : undefined
  if (usage === undefined) return self.invocationUse === undefined ? [] : undefined
  const obligation = self.invocationUse
  if (
    obligation === undefined ||
    contract === undefined ||
    usage.lifetime._tag !== 'BoundLifetime' ||
    !Lifetime.equals(usage.lifetime, obligation.binder) ||
    !Type.invocationUseValid(usage, contract.parameters.length, contract.lifetimeBinders, {
      state: Type.invocationUseState(contract),
    }) ||
    (contract.schema !== undefined &&
      !Type.invocationAdapterValid(usage, contract.parameters.length, contract.schema)) ||
    AuthoredIdentity.anchorKey(obligation.origin) !== AuthoredIdentity.anchorKey(self.anchor) ||
    obligation.owner.module !== obligation.lifetime.owner.module ||
    obligation.owner.name !== obligation.lifetime.owner.name ||
    obligation.inputs.length !== self.arguments.length + (recipe?.captures.length ?? 0) ||
    contract.parameters.length !== self.arguments.length
  )
    return undefined
  const parameters = new Set<number>()
  const arguments_ = new Set<string>()
  const actual = new Map<string, Argument>()
  for (const argument of self.arguments) {
    const key = AuthoredIdentity.anchorKey(argument.anchor)
    if (actual.has(key)) return undefined
    actual.set(key, argument)
  }
  const selected: Array<{
    readonly input: Tir.InvocationUseObligation['inputs'][number]
    readonly argument: Argument
  }> = []
  for (const input of obligation.inputs) {
    const key = AuthoredIdentity.anchorKey(input.argument)
    const capture =
      input.capture === undefined
        ? undefined
        : recipe?.captures.find((candidate) => candidate.parameter === input.parameter)
    const argument = input.capture === undefined ? actual.get(key) : capture?.argument
    if (
      !Number.isSafeInteger(input.parameter) ||
      input.parameter < 0 ||
      parameters.has(input.parameter) ||
      arguments_.has(key) ||
      (input.capture === undefined && input.capturePath !== undefined) ||
      (input.capture !== undefined &&
        (!Number.isSafeInteger(input.capture) ||
          input.capture < 0 ||
          capture === undefined ||
          capture.capture !== input.capture ||
          !sameCapturePath(input.capturePath, capture.capturePath) ||
          AuthoredIdentity.anchorKey(capture.argument.anchor) !== key)) ||
      argument === undefined ||
      argument.type._tag !== 'Available' ||
      !Type.equals(argument.type.type, input.type)
    )
      return undefined
    parameters.add(input.parameter)
    arguments_.add(key)
    selected.push({ input, argument })
  }
  return selected
}

/** A result retains a call's exact input authority only when its stored representation contains κ. */
export const retainsInvocationInputs = (
  self: Extract<Expression, { readonly _tag: 'CallableApply' }>,
): boolean => {
  const obligation = self.invocationUse
  return (
    obligation !== undefined &&
    self.type._tag === 'Available' &&
    Type.storageLifetimes(self.type.type).some((lifetime) =>
      Lifetime.atoms(lifetime).some((atom) => Lifetime.equals(atom, obligation.lifetime)),
    )
  )
}

/** Arguments whose access capability, or owned payload, is retained by the selected result. */
export const retainedResultArguments = (
  self: Expression,
  assumptions: Lifetime.Assumptions,
  recipe?: InvocationRecipe,
): ReadonlyArray<Argument> => {
  if (
    (self._tag !== 'Call' && self._tag !== 'CallableApply' && self._tag !== 'Operator') ||
    self.type._tag !== 'Available'
  )
    return []
  const held =
    self._tag === 'Call' && self.heldLoans !== undefined
      ? new Set(self.heldLoans.map((loan) => loan.ordinal))
      : undefined
  const result = self.type.type
  const invoked =
    self._tag === 'CallableApply' && retainsInvocationInputs(self)
      ? invocationArguments(self, recipe)
      : []
  const exact = new Set((invoked ?? []).map(({ argument }) => argument))
  return self.arguments.filter((argument) => {
    if (exact.has(argument)) return true
    // `heldLoans` is authoritative only for a direct borrow operand. A nested call or aggregate
    // can carry its own loans into this result and still needs the ordinary type relation below.
    if (held !== undefined && argument.expression._tag === 'Borrow')
      return held.has(argument.id.ordinal)
    if (argument.type._tag !== 'Available') return false
    const source = argument.type.type
    if (Type.isReference(source) || Type.isSlice(source))
      return Type.storageLifetimes(result).some(
        (output) =>
          output._tag !== 'StaticLifetime' &&
          Lifetime.outlives(assumptions, source.lifetime, output),
      )
    return retainsLifetimes(source, result, assumptions)
  })
}

export const retainsLifetimes = (
  source: DeclarationFacts.SemanticType,
  result: DeclarationFacts.SemanticType,
  assumptions: Lifetime.Assumptions,
): boolean => {
  const required = Type.storageLifetimes(result).filter(
    (lifetime) => lifetime._tag !== 'StaticLifetime',
  )
  return (
    required.length > 0 &&
    Type.storageLifetimes(source).some((lifetime) =>
      required.some((output) => Lifetime.outlives(assumptions, lifetime, output)),
    )
  )
}

/**
 * A checked body's nodes as loan analysis reads them.
 *
 * Nodes name locals by id and have conversions as nodes of their own; loan analysis reasons about
 * authored places and the locals behind them. This presents the one as the other: a conversion is
 * the expression it converts, a borrow's subject is the place the node kept as evidence, and a
 * local is found by the id a node names.
 */
export const ofTir = (
  fn: Tir.TirFunction,
  index: DeclarationIndex.Index,
  artifact: Tir.ArtifactId,
): Body => {
  const parameters = new Map<number, Extract<Local, { readonly _tag: 'ParameterDeclaration' }>>(
    fn.declaration.parameters.map((parameter) => [
      parameter.id.ordinal,
      {
        ...parameter,
        id: { _tag: 'TirLocal' as const, ordinal: parameter.id.ordinal },
      },
    ]),
  )
  const bindings = new Map<number, Extract<Local, { readonly _tag: 'BindingFact' }>>()
  const patterns = new Map<string, Extract<Local, { readonly _tag: 'PatternBinding' }>>()
  const patternKey = (id: Tir.LocalId): string => `${id.ordinal}`
  const name = (spelling: string | undefined): Name =>
    spelling === undefined ? { _tag: 'Unavailable' } : { _tag: 'Present', spelling }
  const available = (type: DeclarationFacts.SemanticType): ExpressionType => ({
    _tag: 'Available',
    type,
  })
  const declarePatterns = (found: ReadonlyArray<Tir.PatternBinding>): void => {
    for (const binding of found)
      patterns.set(patternKey(binding.id), {
        _tag: 'PatternBinding',
        id: binding.id,
        name: name(binding.name),
        type: available(binding.type),
      })
  }
  const declare = (statements: ReadonlyArray<Tir.Statement>): void => {
    for (const statement of statements) {
      if (statement._tag === 'Bind')
        bindings.set(statement.binding.ordinal, {
          _tag: 'BindingFact',
          mutability: statement.mutability,
          id: statement.binding,
          name: name(statement.name),
          inferredType:
            statement.initializer._tag === 'Unavailable'
              ? { _tag: 'Unavailable' }
              : available(statement.initializer.type),
        })
      if (statement._tag === 'PatternBind' || statement._tag === 'IfLet')
        declarePatterns(statement.selection.bindings)
      if (statement._tag === 'Unsafe') declare(statement.statements)
      if (statement._tag === 'If' || statement._tag === 'IfLet') {
        declare(statement.taken)
        declare(statement.otherwise)
      }
      if (statement._tag === 'While') declare(statement.body)
      for (const node of tirStatementNodes(statement)) {
        if (node._tag === 'Match')
          for (const arm of node.arms) {
            declarePatterns(arm.bindings)
            if (arm.body._tag === 'Block') declare(arm.body.statements)
          }
        if (node._tag === 'EffectBlock') declare(node.statements)
      }
    }
  }
  declare(fn.statements)

  const views = new WeakMap<Tir.Expression, Expression>()
  const expression = (node: Tir.Expression): Expression => {
    const known = views.get(node)
    if (known !== undefined) return known
    const made = view(node)
    views.set(node, made)
    return made
  }
  // Nodes drop static arguments, and an argument is known by its declared position: a borrow's
  // loan is named by it and a retained argument is found by it.
  const argumentsOf = (
    nodes: ReadonlyArray<Tir.Expression>,
    target?: DeclarationFacts.CanonicalId,
  ): ReadonlyArray<Argument> => {
    const declaration =
      target === undefined ? undefined : DeclarationFacts.byCanonical(index, target)
    const declared =
      declaration?._tag === 'FunctionDeclaration'
        ? declaration.parameters
            .filter((parameter) => parameter.phase !== 'Static')
            .map((parameter) => parameter.id.ordinal)
        : []
    return nodes.map((node, position) => {
      const made = expression(node)
      return {
        id: { ordinal: declared.at(position) ?? position },
        expression: made,
        anchor: node.origin.anchor,
        ref: TirModule.nodeReference(artifact, node),
        type: node._tag === 'Unavailable' ? { _tag: 'Unavailable' } : available(node.type),
      }
    })
  }
  const selector = (self: Tir.BorrowSelector): Selector => {
    if (self._tag === 'Field') return self
    if (self._tag === 'Index') return { ...self, index: expression(self.index) }
    return { ...self, index: expression(self.index) }
  }
  const rootOf = (
    root: Tir.SliceRoot,
    selectors: ReadonlyArray<Tir.BorrowSelector>,
  ): BorrowRoot => {
    const path = selectors.map(selector)
    if (root._tag === 'BindingSliceRoot')
      return { _tag: 'BindingRoot', binding: { id: root.binding }, path }
    if (root._tag === 'ParameterSliceRoot')
      return { _tag: 'ParameterRoot', parameter: { id: root.parameter }, path }
    if (root._tag === 'PatternSliceRoot')
      return { _tag: 'PatternRoot', binding: { id: root.binding }, path }
    return { _tag: 'TemporaryRoot', owner: root.owner, path }
  }
  const localOf = (capture: {
    readonly pattern?: Tir.LocalId
    readonly binding?: Tir.LocalId
    readonly parameter?: Tir.LocalId
  }): Local | undefined => {
    if (capture.binding !== undefined) return bindings.get(capture.binding.ordinal)
    if (capture.pattern !== undefined) return patterns.get(patternKey(capture.pattern))
    return capture.parameter === undefined ? undefined : parameters.get(capture.parameter.ordinal)
  }
  // Every `let` of one body context: nested blocks and match arms share it, an effect block has
  // its own.
  const bindingsOf = (nodes: ReadonlyArray<Tir.Statement>): ReadonlyArray<Binding> => {
    const found: Array<Binding> = []
    const inExpression = (node: Tir.Expression): void => {
      if (node._tag === 'EffectBlock') return
      if (node._tag === 'Match')
        for (const arm of node.arms)
          if (arm.body._tag === 'Block') inStatements(arm.body.statements)
      for (const child of TirModule.expressionChildren(node)) inExpression(child)
    }
    const inStatements = (inner: ReadonlyArray<Tir.Statement>): void => {
      for (const statement of inner) {
        if (statement._tag === 'Bind') {
          const initializer = expression(statement.initializer)
          found.push({
            id: statement.binding,
            mutability: statement.mutability,
            initializer,
            inferredType: initializer.type,
          })
        }
        if (statement._tag === 'Unsafe') inStatements(statement.statements)
        if (statement._tag === 'If' || statement._tag === 'IfLet') {
          inStatements(statement.taken)
          inStatements(statement.otherwise)
        }
        if (statement._tag === 'While') inStatements(statement.body)
        for (const node of directStatementNodes(statement)) inExpression(node)
      }
    }
    inStatements(nodes)
    return found
  }
  const view = (node: Tir.Expression): Expression => {
    if (node.id === undefined) throw new RangeError('loan analysis requires published TIR nodes')
    const base = {
      type: node._tag === 'Unavailable' ? ({ _tag: 'Unavailable' } as const) : available(node.type),
      anchor: node.origin.anchor,
      ref: { artifact, node: node.id },
    }
    switch (node._tag) {
      case 'UnionConvert':
        return expression(node.source)
      case 'RuntimeStringView':
        // A string view is what a builtin call over its bytes returned, and it retains them.
        return {
          ...base,
          _tag: 'Call',
          arguments: argumentsOf([node.source]),
          reference: { _tag: 'ResolvedBuiltin' },
        }
      case 'ParameterReference': {
        const parameter = parameters.get(node.parameter.ordinal)
        return parameter === undefined
          ? { ...base, _tag: 'Identifier', reference: { _tag: 'Unavailable' } }
          : {
              ...base,
              _tag: 'Identifier',
              reference: {
                _tag: 'Resolved',
                parameter,
                spelling: parameter.name._tag === 'Present' ? parameter.name.spelling : '?',
              },
            }
      }
      case 'BindingReference': {
        const binding = bindings.get(node.binding.ordinal)
        return binding === undefined
          ? { ...base, _tag: 'Identifier', reference: { _tag: 'Unavailable' } }
          : {
              ...base,
              _tag: 'Identifier',
              reference: {
                _tag: 'ResolvedBinding',
                binding,
                spelling: binding.name._tag === 'Present' ? binding.name.spelling : '?',
              },
            }
      }
      case 'PatternBindingReference': {
        const binding = patterns.get(patternKey(node.binding))
        return binding === undefined
          ? { ...base, _tag: 'Identifier', reference: { _tag: 'Unavailable' } }
          : {
              ...base,
              _tag: 'Identifier',
              reference: {
                _tag: 'ResolvedPattern',
                binding,
                spelling: binding.name._tag === 'Present' ? binding.name.spelling : '?',
              },
            }
      }
      case 'Move':
        return { ...base, _tag: 'Move', subject: expression(node.subject) }
      case 'ReferentPlace':
        return { ...base, _tag: 'ReferentProjection', subject: expression(node.subject) }
      case 'Project':
        return {
          ...base,
          _tag: 'FieldProjection',
          subject: expression(node.subject),
          state: { _tag: 'Resolved', field: { id: node.field } },
        }
      case 'SliceLength':
        return {
          ...base,
          _tag: 'FieldProjection',
          subject: expression(node.slice),
          state: { _tag: 'SliceLength' },
        }
      case 'IndexPlace':
        return {
          ...base,
          _tag: 'IndexProjection',
          subject: expression(node.subject),
          index: expression(node.index),
          array: node.array,
          bounds: node.bounds,
        }
      case 'SliceIndexPlace':
        return {
          ...base,
          _tag: 'IndexProjection',
          subject: expression(node.slice),
          index: expression(node.index),
          bounds: { _tag: 'RuntimeSlice' },
        }
      case 'ValueBorrow':
      case 'SliceBorrow': {
        const root = rootOf(node.root, node.selectors)
        let formation: Formation
        if (node._tag === 'ValueBorrow')
          formation = node.reborrow
            ? { _tag: 'ValueReborrow', root, suspendsParent: node.suspendsParent }
            : { _tag: 'ValueBorrow', root }
        else
          formation = node.reborrow
            ? { _tag: 'SliceReborrow', root, suspendsParent: node.suspendsParent }
            : { _tag: 'FixedArrayBorrow', root }
        return {
          ...base,
          _tag: 'Borrow',
          access: node.access,
          subject:
            node.place === undefined
              ? {
                  type: { _tag: 'Unavailable' },
                  anchor: base.anchor,
                  ref: base.ref,
                  _tag: 'Integer',
                }
              : expression(node.place),
          formation,
        }
      }
      case 'Construct':
      case 'ConstructUnionVariant':
        return {
          ...base,
          _tag: node._tag === 'Construct' ? 'StructLiteral' : 'UnionVariant',
          initializers: node.fields.map((field) => ({
            field: field.field,
            expression: expression(field.value),
          })),
        }
      case 'ArrayConstruct':
        return {
          ...base,
          _tag: 'ArrayLiteral',
          elements: node.elements.map((element) => ({ expression: expression(element) })),
        }
      case 'Match':
        return {
          ...base,
          _tag: 'Match',
          scrutinee: expression(node.scrutinee),
          arms: node.arms.map((arm) => ({
            ...(arm.guard === undefined ? {} : { guard: expression(arm.guard) }),
            body:
              arm.body._tag === 'Expression'
                ? { _tag: 'Expression' as const, expression: expression(arm.body.expression) }
                : { _tag: 'Block' as const, statements: statements(arm.body.statements) },
          })),
        }
      case 'ShortCircuit':
        return {
          ...base,
          _tag: 'ShortCircuit',
          arguments: argumentsOf([node.left, node.right]),
        }
      case 'EnumEquality':
      case 'StringEquality':
        return { ...base, _tag: 'Operator', arguments: argumentsOf([node.left, node.right]) }
      case 'EnumValue':
        return { ...base, _tag: 'EnumValue', argument: expression(node.value) }
      case 'InterfaceOperationCall':
        return node.operator === true
          ? {
              ...base,
              _tag: 'Operator',
              arguments: argumentsOf(node.arguments),
              interfaceOperation: { contract: node.contract },
            }
          : {
              ...base,
              _tag: 'Call',
              arguments: argumentsOf(node.arguments),
              reference: { _tag: 'ResolvedInterfaceOperation' },
            }
      case 'BuiltinCall':
        return node.interfaceOperation === undefined
          ? {
              ...base,
              _tag: 'Call',
              arguments: argumentsOf(node.arguments),
              reference: { _tag: 'ResolvedBuiltin', operation: node.operation },
            }
          : {
              ...base,
              _tag: 'Operator',
              arguments: argumentsOf(node.arguments),
              interfaceOperation: { contract: node.interfaceOperation.contract },
            }
      case 'Call':
        return {
          ...base,
          _tag: 'Call',
          arguments: argumentsOf(node.arguments, node.target),
          reference: { _tag: 'Resolved' },
          heldLoans: node.heldLoans,
        }
      case 'EffectConstruct':
        return {
          ...base,
          _tag: 'Call',
          arguments: argumentsOf(node.arguments, node.target),
          reference: { _tag: 'Resolved' },
        }
      case 'StaticCall':
      case 'StaticIntrinsic':
      case 'ServiceEffectConstruct':
        return {
          ...base,
          _tag: 'Call',
          arguments: argumentsOf(node.arguments),
          reference: { _tag: 'Resolved' },
        }
      case 'ForeignApply':
        return {
          ...base,
          _tag: 'ForeignApply',
          callee: expression(node.callee),
          arguments: argumentsOf(node.arguments),
          evaluation: node.evaluation,
        }
      case 'CallableApply':
        return {
          ...base,
          _tag: 'CallableApply',
          ...(node.invocationUse === undefined ? {} : { invocationUse: node.invocationUse }),
          callee: expression(node.callee),
          arguments: argumentsOf(node.arguments),
          mode: node.access,
          ...(node.staged === undefined ? {} : { staged: node.staged }),
          provenance: {
            _tag:
              node.evaluation === 'LeftThenCallable'
                ? 'PipelineCallableApplication'
                : 'DirectCallableApplication',
          },
        }
      case 'CallableSection':
        return {
          ...base,
          _tag: 'CallableSection',
          ...(node.invocationParameters === undefined
            ? {}
            : { invocationParameters: node.invocationParameters }),
          site: node.site,
          remainingParameters: node.remainingParameters,
          captures: node.captures.map((capture) => ({
            ordinal: capture.ordinal,
            parameterOrdinal: capture.parameterOrdinal,
            argument: {
              id: { ordinal: capture.parameterOrdinal },
              expression: expression(capture.value),
              anchor: capture.value.origin.anchor,
              ref: TirModule.nodeReference(artifact, capture.value),
              type:
                capture.value._tag === 'Unavailable'
                  ? { _tag: 'Unavailable' }
                  : available(capture.value.type),
            },
            expression: expression(capture.value),
            access: capture.access,
          })),
        }
      case 'EffectBlock':
        return {
          ...base,
          _tag: 'EffectBlock',
          captures: node.captures.flatMap((capture) => {
            const reference = localOf(capture)
            return reference === undefined
              ? []
              : [
                  {
                    reference,
                    access: capture.access,
                    span: capture.span,
                    ...(capture.use === undefined ? {} : { expression: { anchor: capture.use } }),
                  },
                ]
          }),
          bindings: bindingsOf(node.statements),
          statements: statements(node.statements),
        }
      case 'Run':
        return { ...base, _tag: 'Run', subject: expression(node.subject) }
      case 'EffectCatch':
        return {
          ...base,
          _tag: 'EffectCatch',
          protected: expression(node.protected),
          handler: expression(node.handler),
        }
      case 'EffectBindRequirement': {
        const reference = localOf(node.provider)
        return {
          ...base,
          _tag: 'EffectBindRequirement',
          protected: expression(node.protected),
          ...(reference === undefined || reference._tag === 'PatternBinding'
            ? {}
            : {
                provider: {
                  reference,
                  captureAccess: node.provider.captureAccess,
                  span: node.provider.span,
                },
              }),
        }
      }
      case 'Replace':
        return {
          ...base,
          _tag: 'PlaceReplace',
          destination: { ...base, _tag: 'Integer' },
          value: expression(node.value),
        }
      case 'CompileError':
        return { ...base, _tag: 'CompileError', message: expression(node.message) }
      case 'Unavailable':
        return node.call?.callee === undefined
          ? {
              ...base,
              _tag: 'Call',
              arguments: argumentsOf(node.call?.arguments ?? [], node.call?.target),
              reference: { _tag: node.call?.target === undefined ? 'Unavailable' : 'Resolved' },
            }
          : {
              ...base,
              _tag: 'CallableApply',
              callee: expression(node.call.callee),
              arguments: argumentsOf(node.call.arguments),
              mode: node.call.access ?? 'Shared',
              provenance: {
                _tag:
                  node.call.evaluation === 'LeftThenCallable'
                    ? 'PipelineCallableApplication'
                    : 'DirectCallableApplication',
              },
            }
      case 'FunctionItem':
      case 'ForeignFunctionAddress':
        return { ...base, _tag: 'FunctionItem' }
      default:
        return { ...base, _tag: 'Integer' }
    }
  }
  const selectionOf = (selection: Tir.PatternSelection) => ({
    source: expression(selection.source ?? selection.subject),
    loanEnd: selection.loanEnd,
    anchor: selection.origin.anchor,
  })
  const statements = (nodes: ReadonlyArray<Tir.Statement>): ReadonlyArray<Statement> =>
    nodes.flatMap((node): ReadonlyArray<Statement> => {
      const at = { region: node.region, anchor: node.origin.anchor }
      switch (node._tag) {
        case 'UnavailableStatement':
          return node.write === undefined
            ? []
            : [
                {
                  ...at,
                  _tag: 'WriteStatement',
                  destination: expression(node.write.destination),
                  value: expression(node.write.value),
                },
              ]
        case 'Unsafe':
          return [{ ...at, _tag: 'UnsafeStatement', statements: statements(node.statements) }]
        case 'Bind': {
          const initializer = expression(node.initializer)
          return [
            {
              _tag: 'BindStatement',
              binding: {
                id: node.binding,
                mutability: node.mutability,
                initializer,
                inferredType: initializer.type,
              },
              region: node.region,
            },
          ]
        }
        case 'PatternBind':
          return [{ ...at, _tag: 'PatternBindStatement', selection: selectionOf(node.selection) }]
        case 'Evaluate':
          return [{ ...at, _tag: 'ExpressionStatement', expression: expression(node.expression) }]
        case 'Return':
          return [{ ...at, _tag: 'ReturnStatement', expression: expression(node.expression) }]
        case 'Fail':
          return [{ ...at, _tag: 'FailStatement', expression: expression(node.expression) }]
        case 'Drop':
          return [{ ...at, _tag: 'DropStatement', expression: expression(node.expression) }]
        case 'If':
          return [
            {
              ...at,
              _tag: 'IfStatement',
              condition: expression(node.condition),
              taken: statements(node.taken),
              otherwise: statements(node.otherwise),
            },
          ]
        case 'IfLet':
          return [
            {
              ...at,
              _tag: 'IfLetStatement',
              selection: selectionOf(node.selection),
              taken: statements(node.taken),
              otherwise: statements(node.otherwise),
            },
          ]
        case 'Write':
          return [
            {
              ...at,
              _tag: 'WriteStatement',
              destination:
                node.destination === undefined
                  ? {
                      type: { _tag: 'Unavailable' },
                      anchor: at.anchor,
                      ref: TirModule.nodeReference(artifact, node),
                      _tag: 'Integer',
                    }
                  : expression(node.destination),
              value: expression(node.value),
            },
          ]
        case 'While':
          return [
            {
              ...at,
              _tag: 'WhileStatement',
              condition: expression(node.condition),
              body: statements(node.body),
            },
          ]
        case 'Break':
          return [{ ...at, _tag: 'BreakStatement' }]
        case 'Continue':
          return [{ ...at, _tag: 'ContinueStatement' }]
      }
    })
  // An effect function's body is wrapped in the block its callers construct. The wrapper is not
  // authored, so loan analysis reads the body inside it.
  const only = fn.statements.length === 1 ? fn.statements.at(0) : undefined
  const wrapped =
    only?._tag === 'Return' &&
    only.expression._tag === 'EffectBlock' &&
    only.expression.origin._tag === 'Synthetic'
      ? only.expression.statements
      : fn.statements
  return {
    declaration: fn.declaration,
    statements: statements(wrapped),
    bindings: bindingsOf(wrapped),
  }
}

/** The expressions one statement evaluates itself, without the statements nested inside it. */
const directStatementNodes = (statement: Tir.Statement): ReadonlyArray<Tir.Expression> => {
  switch (statement._tag) {
    case 'Bind':
      return [statement.initializer]
    case 'PatternBind':
    case 'IfLet':
      return [statement.selection.subject]
    case 'Evaluate':
    case 'Return':
    case 'Fail':
    case 'Drop':
      return [statement.expression]
    case 'If':
    case 'While':
      return [statement.condition]
    case 'Write':
      return [statement.value]
    default:
      return []
  }
}

/** Every node a statement carries directly, nested expressions included. */
const tirStatementNodes = (statement: Tir.Statement): ReadonlyArray<Tir.Expression> =>
  TirModule.statementExpressions(statement).flatMap(TirModule.expressionTree)
