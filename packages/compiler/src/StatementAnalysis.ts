import * as OpaqueRealization from './OpaqueRealization.js'
import * as TypeHint from './TypeHint.js'
import * as SemanticOccurrence from './SemanticOccurrence.js'
import * as Location from './Location.js'
import type * as AuthoredHir from './AuthoredHir.js'
import * as AuthoredIdentity from './AuthoredIdentity.js'
import * as AuthoredWalk from './AuthoredWalk.js'
import * as SemanticContext from './SemanticContext.js'
import * as MachineFunction from './MachineFunction.js'
import * as Lifetime from './Lifetime.js'
import * as BodyLifetime from './BodyLifetime.js'
import * as BodyBuilder from './BodyBuilder.js'

const construction = (context: BodyContext): BodyBuilder.BodyBuilder => {
  if (context.resolution.builder === undefined)
    throw new RangeError('function-body analysis requires its TIR builder')
  return context.resolution.builder
}
import * as LifetimeFlow from './LifetimeFlow.js'
import * as NominalVariance from './NominalVariance.js'
import * as TypeOutlives from './TypeOutlives.js'
import { concreteCallableIdentity, exactCallableOf, executableSites } from './CallResolution.js'
import * as DeclarationCollection from './DeclarationCollection.js'
import * as DeclarationFacts from './DeclarationFacts.js'
import * as DeclarationLifetime from './DeclarationLifetime.js'
import * as DeclarationResolution from './DeclarationResolution.js'
import * as Diagnostic from './Diagnostic.js'
import type {
  BindingDeclarationFact,
  DeclarationFact,
  ExpressionDecision,
  PatternSelectionFact,
  PatternBindingFact,
  StaticIterationFact,
} from './Elaboration.js'
import {
  assignmentRoot,
  assignmentRootAccess,
  compatible,
  constructionExpressionAnchor,
  constructionExpressionType,
  declaredReturnTypesCompatible,
  expressionChildren,
  expressionNode,
  isBindingDeclarationFact,
  representationJoinDiagnostic,
  typesCompatible,
  unavailableCompatibility,
  unionConversionDiagnostic,
  visitExpressionDecisions,
  visitStatements,
} from './Elaboration.js'
import type {
  BodyContext,
  FunctionAnalysis,
  ResolutionContext,
  Scope,
} from './ExpressionAnalysis.js'
import {
  analyzeExpression,
  evaluateStatic,
  analyzePattern,
  patternTests,
  bindingName,
  coverageMembersOf,
  containsOrdinaryArm,
  enumFactByType,
  representationOfExpression,
  patternCoverage,
  unsafeCallAuthorized,
} from './ExpressionAnalysis.js'
import * as Tir from './Tir.js'
import type { StatementDraft } from './BodyBuilder.js'
import { directStatementExpressions } from './BodyBuilder.js'
import * as Match from './Match.js'
import * as NameResolution from './NameResolution.js'
import * as SemanticDisplay from './SemanticDisplay.js'
import * as SourceSpan from './SourceSpan.js'
import * as Evaluation from './Evaluation.js'
import * as StaticValue from './StaticValue.js'
import * as Type from './Type.js'
export const unsafeCallDiagnostic = (
  unsafe: boolean,
  spelling: string,
  call: AuthoredHir.Expression,
  callSpan: SourceSpan.SourceSpan,
  resolution: ResolutionContext | undefined,
): Diagnostic.Located | undefined =>
  unsafe && !unsafeCallAuthorized(resolution, call, callSpan)
    ? Diagnostic.missingUnsafeBoundary(spelling, Location.at(call.anchor))
    : undefined

interface StaticIterationElement {
  readonly value: StaticValue.Value
  readonly type: Type.Type
}

/** Opens only the two finite compiler-owned iterable representations admitted by `static for`. */
const staticIterationElements = (
  value: StaticValue.Value,
): ReadonlyArray<StaticIterationElement> | undefined => {
  if (value._tag === 'StaticSequenceValue')
    return value.elements.map((element) => ({ value: element, type: value.elementType }))
  if (value._tag === 'FieldCollectionValue')
    return value.fields.map((field) => ({
      value: field,
      type: StaticValue.fieldDescriptorType(field),
    }))
  if (value._tag === 'TestCollectionValue')
    return value.tests.map((test) => ({ value: test, type: StaticValue.testDescriptorType(test) }))
  return undefined
}

/** `return` with no value returns unit; a synthetic literal stands in for the absent expression. */
const unitValueOf = (
  statement: Extract<AuthoredHir.Statement, { readonly _tag: 'ReturnStatement' }>,
): AuthoredHir.Expression => ({
  _tag: 'UnitLiteral',
  anchor: statement.anchor,
  origin: {
    _tag: 'Synthetic',
    anchor: statement.anchor,
    role: 'value',
    occurrence: 0,
  },
  causes: [],
})

const residualNodeCount = (statements: ReadonlyArray<Tir.Statement>): number => {
  let nodes = 0
  visitStatements(statements, {
    statement: () => {
      nodes += 1
    },
    expression: () => {
      nodes += 1
    },
  })
  return nodes
}

const nestedStaticIterationNodeCount = (iterations: ReadonlyArray<StaticIterationFact>): number =>
  iterations.reduce(
    (total, iteration) =>
      total +
      iteration.scopes.reduce(
        (scopeTotal, scope) => scopeTotal + residualNodeCount(scope.statements),
        0,
      ),
    0,
  )

export const analyzeStatements = (
  context: BodyContext,
  blockNode: AuthoredHir.Block,
  initialScope: Scope,
  loopStack: ReadonlyArray<Tir.LoopId> = [],
  introducedPatterns: ReadonlyArray<PatternBindingFact> = [],
): ReadonlyArray<Tir.Statement> => {
  context = { ...context, resolution: { ...context.resolution, execution: { context, loopStack } } }
  const facts: Array<Tir.Statement> = []
  const statementOptions: BodyBuilder.LowerStatementOptions = {
    context: context.context,
    builder: construction(context),
    ...(context.declaration.phase === 'Static'
      ? { static: construction(context).expressions }
      : { eraseIntrinsicSections: true as const }),
    ...(context.resolution.lifetimeCompatibility === undefined
      ? {}
      : { lifetimeCompatibility: context.resolution.lifetimeCompatibility }),
    ...(context.returnType === undefined ? {} : { resultType: context.returnType }),
    ...(context.declaration.opaqueResult === undefined
      ? {}
      : { opaqueResultFamily: context.declaration.opaqueResult.family }),
    functionId: context.declaration.id,
  }
  const construct = (draft: StatementDraft): Tir.Statement | undefined =>
    BodyBuilder.publishStatements([draft], statementOptions).at(0)
  const append = (draft: StatementDraft): void => {
    const statement = construct(draft)
    if (statement !== undefined) facts.push(statement)
  }
  let scope = initialScope
  const ordinaryControlContext: BodyContext =
    context.declaration.phase !== 'Static' || context.resolution.deferStaticCalls === true
      ? context
      : {
          ...context,
          resolution: { ...context.resolution, deferStaticCalls: true as const },
        }
  const blockBindings = new Map<string, Location.Location>(
    introducedPatterns.flatMap((binding) =>
      binding.name._tag === 'Present'
        ? [[binding.name.spelling, Location.at(binding.name.anchor)] as const]
        : [],
    ),
  )
  const callableWrites = context.resolution.writtenCallableBindings
  const snapshotCallableWrites = (): ReadonlySet<number> => new Set(callableWrites)
  const restoreCallableWrites = (snapshot: ReadonlySet<number>): void => {
    if (callableWrites === undefined) return
    callableWrites.clear()
    for (const ordinal of snapshot) callableWrites.add(ordinal)
  }
  const mergeCallableWrites = (...snapshots: ReadonlyArray<ReadonlySet<number>>): void => {
    restoreCallableWrites(new Set(snapshots.flatMap((snapshot) => [...snapshot])))
  }
  const analyzePath = <A>(initial: ReadonlySet<number>, analyze: () => A) => {
    restoreCallableWrites(initial)
    const value = analyze()
    return { value, writes: snapshotCallableWrites() }
  }
  const replaceMap = <K, V>(target: Map<K, V>, snapshot: ReadonlyMap<K, V>): void => {
    target.clear()
    for (const [key, value] of snapshot) target.set(key, value)
  }
  const staticExpansionCheckpoint = () => ({
    bindings: context.bindings.length,
    regions: context.regions.length,
    loops: context.loops.length,
    staticIterations: context.staticIterations.length,
    nextBindingOrdinal: context.nextBindingOrdinal.value,
    callableWrites: snapshotCallableWrites(),
    generatedAggregates: new Map(context.resolution.generatedAggregates),
    values: new Map(context.staticContext?.values),
    valueSpans: new Map(context.staticContext?.valueSpans),
    valueOrigins: new Map(context.staticContext?.valueOrigins),
    expressionSpans: new Map(context.staticContext?.expressionSpans),
    expressionOrigins: new Map(context.staticContext?.expressionOrigins),
  })
  const restoreStaticExpansion = (
    checkpoint: ReturnType<typeof staticExpansionCheckpoint>,
  ): void => {
    context.bindings.length = checkpoint.bindings
    context.regions.length = checkpoint.regions
    context.loops.length = checkpoint.loops
    context.staticIterations.length = checkpoint.staticIterations
    context.nextBindingOrdinal.value = checkpoint.nextBindingOrdinal
    restoreCallableWrites(checkpoint.callableWrites)
    if (context.resolution.generatedAggregates !== undefined)
      replaceMap(context.resolution.generatedAggregates, checkpoint.generatedAggregates)
    if (context.staticContext !== undefined) {
      replaceMap(context.staticContext.values, checkpoint.values)
      replaceMap(context.staticContext.valueSpans, checkpoint.valueSpans)
      replaceMap(context.staticContext.valueOrigins, checkpoint.valueOrigins)
      replaceMap(context.staticContext.expressionSpans, checkpoint.expressionSpans)
      replaceMap(context.staticContext.expressionOrigins, checkpoint.expressionOrigins)
    }
  }
  const unionWriteStates = (
    ...states: ReadonlyArray<ReadonlySet<number> | undefined>
  ): ReadonlySet<number> | undefined => {
    const present = states.filter((state): state is ReadonlySet<number> => state !== undefined)
    return present.length === 0 ? undefined : new Set(present.flatMap((state) => [...state]))
  }
  interface CallableWriteFlow {
    readonly fallthrough?: ReadonlySet<number>
    readonly continues?: ReadonlySet<number>
    readonly breaks?: ReadonlySet<number>
  }
  const callableBinding = (place: Tir.WritePlace): BindingDeclarationFact | undefined => {
    const local =
      place.root._tag === 'BindingWriteRoot' || place.root._tag === 'BindingSliceRoot'
        ? place.root.binding
        : undefined
    if (local === undefined) return undefined
    const semantic = BodyBuilder.semanticOfLocal(construction(context), local)
    return isBindingDeclarationFact(semantic) ? semantic : undefined
  }
  const expressionWrites = (
    expression: ExpressionDecision | Tir.Expression,
    initial: ReadonlySet<number>,
  ): ReadonlySet<number> => {
    const writes = new Set(initial)
    visitExpressionDecisions(expression, {
      descendEffectBlocks: false,
      statement: (statement) => {
        const binding = statement._tag === 'Write' ? callableBinding(statement.place) : undefined
        if (
          statement._tag === 'Write' &&
          (statement.destination === undefined || !expressionNever(statement.destination)) &&
          !expressionNever(statement.value) &&
          binding?.inferredType._tag === 'Available' &&
          Type.isCallable(binding.inferredType.type)
        )
          writes.add(binding.id.ordinal)
      },
      expression: (candidate) => {
        if (
          candidate._tag === 'PlaceReplace' &&
          !expressionNever(candidate.destination) &&
          !expressionNever(candidate.value) &&
          candidate.root?._tag === 'BindingFact' &&
          candidate.root.inferredType._tag === 'Available' &&
          Type.isCallable(candidate.root.inferredType.type)
        )
          writes.add(candidate.root.id.ordinal)
      },
    })
    return writes
  }
  const callableWriteFlow = (
    statements: ReadonlyArray<Tir.Statement>,
    initial: ReadonlySet<number>,
    targetLoop: Tir.LoopId,
  ): CallableWriteFlow => {
    let fallthrough: ReadonlySet<number> | undefined = new Set(initial)
    let continues: ReadonlySet<number> | undefined
    let breaks: ReadonlySet<number> | undefined
    for (const statement of statements) {
      if (fallthrough === undefined) break
      if (statement._tag === 'Bind') {
        fallthrough = expressionWrites(statement.initializer, fallthrough)
        if (expressionNever(statement.initializer)) fallthrough = undefined
        continue
      }
      if (statement._tag === 'PatternBind') {
        fallthrough = expressionWrites(statement.selection.subject, fallthrough)
        if (expressionNever(statement.selection.subject)) fallthrough = undefined
        continue
      }
      if (statement._tag === 'Evaluate' || statement._tag === 'Drop') {
        fallthrough = expressionWrites(statement.expression, fallthrough)
        if (expressionNever(statement.expression)) fallthrough = undefined
        continue
      }
      if (statement._tag === 'Write') {
        fallthrough = expressionWrites(statement.value, fallthrough)
        if (statement.destination !== undefined)
          fallthrough = expressionWrites(statement.destination, fallthrough)
        const binding = callableBinding(statement.place)
        if (
          binding?.inferredType._tag === 'Available' &&
          Type.isCallable(binding.inferredType.type)
        )
          fallthrough = new Set(fallthrough).add(binding.id.ordinal)
        if (
          (statement.destination !== undefined && expressionNever(statement.destination)) ||
          expressionNever(statement.value)
        )
          fallthrough = undefined
        continue
      }
      if (statement._tag === 'Return' || statement._tag === 'Fail') {
        expressionWrites(statement.expression, fallthrough)
        fallthrough = undefined
        continue
      }
      if (statement._tag === 'Break' || statement._tag === 'Continue') {
        if (statement.target === targetLoop) {
          if (statement._tag === 'Break') breaks = unionWriteStates(breaks, fallthrough)
          else continues = unionWriteStates(continues, fallthrough)
        }
        fallthrough = undefined
        continue
      }
      if (statement._tag === 'Unsafe') {
        const nested = callableWriteFlow(statement.statements, fallthrough, targetLoop)
        fallthrough = nested.fallthrough
        continues = unionWriteStates(continues, nested.continues)
        breaks = unionWriteStates(breaks, nested.breaks)
        continue
      }
      if (statement._tag === 'If' || statement._tag === 'IfLet') {
        const afterCondition = expressionWrites(
          statement._tag === 'If' ? statement.condition : statement.selection.subject,
          fallthrough,
        )
        if (
          expressionNever(
            statement._tag === 'If' ? statement.condition : statement.selection.subject,
          )
        ) {
          fallthrough = undefined
          continue
        }
        const taken = callableWriteFlow(statement.taken, afterCondition, targetLoop)
        const otherwise = callableWriteFlow(statement.otherwise, afterCondition, targetLoop)
        fallthrough = unionWriteStates(taken.fallthrough, otherwise.fallthrough)
        continues = unionWriteStates(continues, taken.continues, otherwise.continues)
        breaks = unionWriteStates(breaks, taken.breaks, otherwise.breaks)
        continue
      }
      if (statement._tag === 'While') {
        const nestedEntry = expressionWrites(statement.condition, fallthrough)
        if (expressionNever(statement.condition)) {
          fallthrough = undefined
          continue
        }
        const nested = callableWriteFlow(statement.body, nestedEntry, statement.loop)
        const nestedBackedge = unionWriteStates(nested.fallthrough, nested.continues)
        fallthrough = unionWriteStates(nestedEntry, nestedBackedge, nested.breaks)
      }
    }
    return {
      ...(fallthrough === undefined ? {} : { fallthrough }),
      ...(continues === undefined ? {} : { continues }),
      ...(breaks === undefined ? {} : { breaks }),
    }
  }

  const nextRegion = (): Tir.RegionId => {
    const region = {
      _tag: 'TirRegion' as const,
      function: context.declaration.id,
      ordinal: (context.regionBase ?? 0) + context.regions.length,
    }
    context.regions.push(region)
    return region
  }

  const staticDiagnostic = (failure: Evaluation.StaticFailure): Diagnostic.Located =>
    Evaluation.diagnostic(failure, context.staticContext?.environment.target ?? 'unselected-target')

  const analyzePatternSelection = (
    element: Extract<
      AuthoredHir.Statement,
      { readonly _tag: 'PatternBindingStatement' | 'PatternConditionalStatement' }
    >,
    selectionScope: Scope,
  ): PatternSelectionFact => {
    const initializerNode =
      element._tag === 'PatternBindingStatement' ? element.initializer : element.subject
    const initializer = analyzeExpression(
      context.context,
      initializerNode,
      context.declarations,
      context.declaration,
      selectionScope,
      context.resolution,
      undefined,
    )
    if (initializer === undefined) {
      throw new RangeError(`Semantic analysis cannot analyze ${initializerNode._tag}`)
    }
    context.diagnostics.push(...initializer.diagnostics)
    let access: Match.Access
    if (initializer.fact._tag === 'Move') {
      access = 'Move'
    } else if (initializer.fact._tag === 'Borrow') {
      access = initializer.fact.access
    } else {
      access = 'Copy'
    }
    const subject =
      initializer.fact._tag === 'Move' || initializer.fact._tag === 'Borrow'
        ? initializer.fact.subject
        : expressionNode(initializer)
    const subjectType = constructionExpressionType(subject)
    const id: Match.MatchId = {
      _tag: 'MatchId',
      node: Tir.nodeReference(construction(context).artifact, subject),
    }
    const arm: Match.ArmId = { _tag: 'MatchArmId', match: id, ordinal: 0 }
    const pattern = analyzePattern(
      context.context,
      element.pattern,
      arm,
      access,
      selectionScope,
      context.resolution,
      context.declaration,
      { pattern: 0, binding: 0, invalid: false },
      subjectType._tag === 'Available' ? subjectType.type : undefined,
    )
    context.diagnostics.push(...pattern.diagnostics)
    const subjectEnum =
      subjectType._tag === 'Available'
        ? enumFactByType(context.resolution.index, subjectType.type)
        : undefined
    let members: ReadonlyArray<Match.CoverageIdentity>
    if (subjectType._tag !== 'Available') {
      members = []
    } else if (subjectEnum === undefined) {
      members = coverageMembersOf(context.resolution.index, subjectType.type)
    } else {
      members = Match.enumMembersOf(subjectEnum)
    }
    let member: Match.CoverageIdentity | undefined
    if (pattern.fact._tag === 'EnumMemberPattern') {
      member = pattern.fact.coverage
    } else if (pattern.fact._tag === 'UnionVariantPattern') {
      member = pattern.fact.coverage
    } else if (
      (pattern.fact._tag === 'NominalPattern' || pattern.fact._tag === 'TypePattern') &&
      pattern.fact.member !== undefined
    ) {
      member = Match.structuralMember(pattern.fact.member)
    } else {
      member = undefined
    }
    if (
      subjectEnum === undefined &&
      member !== undefined &&
      subjectType._tag === 'Available' &&
      !members.some((candidate) => Match.selects(member, candidate))
    ) {
      context.diagnostics.push(
        Diagnostic.matchMemberNotInScrutinee(
          Type.encode(member.type),
          Type.encode(subjectType.type),
          Location.at(pattern.fact.anchor),
        ),
      )
    }
    const tests = patternTests(context.context, context.resolution.index, pattern.fact)
    const coverage = Match.cover(members, [
      {
        ...(member === undefined ? {} : { member }),
        universal: pattern.fact._tag === 'UniversalPattern',
        tests,
        guarded: false,
      },
    ])
    const complete = pattern.fact._tag === 'UniversalPattern' ? true : pattern.fact.complete
    return {
      _tag: 'PatternSelection',
      tests,
      id,
      arm,
      access,
      source: expressionNode(initializer),
      subject,
      members: members,
      pattern: pattern.fact,
      bindings: pattern.fact.bindings,
      irrefutable: coverage.exhaustive && complete,
      loanEnd:
        element._tag === 'PatternBindingStatement'
          ? context.context.spanOf(blockNode.anchor)
          : context.context.spanOf(element.anchor),
      loanEndAt: element._tag === 'PatternBindingStatement' ? blockNode.anchor : element.anchor,
      anchor: element.anchor,
    }
  }

  const analyzeConditional = (
    element: Extract<
      AuthoredHir.Conditional,
      { readonly _tag: 'ConditionalStatement' | 'StaticConditionalStatement' }
    >,
    armScope: Scope,
    armLoopStack: ReadonlyArray<Tir.LoopId>,
  ): Tir.Statement => {
    const region = nextRegion()
    const conditionNode = element.condition
    const condition = analyzeExpression(
      context.context,
      conditionNode,
      context.declarations,
      context.declaration,
      armScope,
      ordinaryControlContext.resolution,
    )
    if (condition === undefined) {
      throw new RangeError(`Semantic analysis cannot analyze ${conditionNode._tag}`)
    }
    context.diagnostics.push(...condition.diagnostics)
    if (
      condition.fact.type._tag === 'Available' &&
      condition.fact.type.type !== 'bool' &&
      !Type.isNever(condition.fact.type.type)
    ) {
      context.diagnostics.push(
        Diagnostic.conditionNotBool(
          Type.encode(condition.fact.type.type),
          Location.at(condition.fact.anchor),
        ),
      )
    }

    const branchEntry = snapshotCallableWrites()
    const taken = analyzePath(branchEntry, () =>
      analyzeStatements(ordinaryControlContext, element.thenBranch, armScope, armLoopStack),
    )
    const otherwise = analyzePath(branchEntry, () =>
      analyzeElseBranch(element.elseBranch, armScope, armLoopStack),
    )
    const takenFallsThrough = returnFlowOf(taken.value, false).fallsThrough
    const otherwiseFallsThrough = returnFlowOf(otherwise.value, false).fallsThrough
    mergeCallableWrites(
      ...(takenFallsThrough ? [taken.writes] : []),
      ...(otherwiseFallsThrough ? [otherwise.writes] : []),
      ...(!takenFallsThrough && !otherwiseFallsThrough ? [branchEntry] : []),
    )
    const statement = construct({
      _tag: 'IfStatement',
      condition: expressionNode(condition),
      taken: [...taken.value],
      otherwise: [...otherwise.value],
      region,
      anchor: element.anchor,
    })
    if (statement === undefined) throw new RangeError('conditional statement was not published')
    return statement
  }

  /** Both authored arms are present; an absent else branch contributes no statements. */
  const analyzeElseBranch = (
    branch: AuthoredHir.Block | AuthoredHir.Conditional | undefined,
    armScope: Scope,
    armLoopStack: ReadonlyArray<Tir.LoopId>,
  ): ReadonlyArray<Tir.Statement> => {
    if (branch === undefined) return []
    if (branch._tag === 'Block')
      return analyzeStatements(ordinaryControlContext, branch, armScope, armLoopStack)
    return branch._tag === 'PatternConditionalStatement'
      ? [analyzePatternConditional(branch, armScope, armLoopStack)]
      : [analyzeConditional(branch, armScope, armLoopStack)]
  }

  const analyzePatternConditional = (
    element: Extract<AuthoredHir.Conditional, { readonly _tag: 'PatternConditionalStatement' }>,
    armScope: Scope,
    armLoopStack: ReadonlyArray<Tir.LoopId>,
  ): Tir.Statement => {
    const region = nextRegion()
    const selection = analyzePatternSelection(element, armScope)
    const takenScope: Scope = {
      parameters: armScope.parameters,
      bindings: armScope.bindings,
      patternBindings: [...armScope.patternBindings, ...selection.bindings],
    }
    const branchEntry = snapshotCallableWrites()
    const taken = analyzePath(branchEntry, () =>
      analyzeStatements(ordinaryControlContext, element.thenBranch, takenScope, armLoopStack),
    )
    const otherwise = analyzePath(branchEntry, () =>
      analyzeElseBranch(element.elseBranch, armScope, armLoopStack),
    )
    const takenFallsThrough = returnFlowOf(taken.value, false).fallsThrough
    const otherwiseFallsThrough = returnFlowOf(otherwise.value, false).fallsThrough
    mergeCallableWrites(
      ...(takenFallsThrough ? [taken.writes] : []),
      ...(otherwiseFallsThrough ? [otherwise.writes] : []),
      ...(!takenFallsThrough && !otherwiseFallsThrough ? [branchEntry] : []),
    )
    const statement = construct({
      _tag: 'IfLetStatement',
      selection,
      taken: [...taken.value],
      otherwise: [...otherwise.value],
      region,
      anchor: element.anchor,
    })
    if (statement === undefined)
      throw new RangeError('pattern conditional statement was not published')
    return statement
  }

  for (const element of blockNode.statements) {
    if (element._tag === 'UnsafeStatement') {
      const region = nextRegion()
      const statements = analyzeStatements(context, element.body, scope, loopStack)
      append({
        _tag: 'UnsafeStatement',
        statements,
        region,
        anchor: element.anchor,
      })
      continue
    }

    if (element._tag === 'BindingStatement') {
      const region = nextRegion()
      const bindingOrdinal = context.nextBindingOrdinal.value
      context.nextBindingOrdinal.value += 1
      const initializerNode = element.initializer
      const declaredSyntax = element.type
      const typeParameters = new Map(
        context.declaration.typeParameters.flatMap((parameter) =>
          parameter.name._tag === 'Present'
            ? [[parameter.name.spelling, parameter.type] as const]
            : [],
        ),
      )
      const analyzedDeclared =
        declaredSyntax === undefined
          ? undefined
          : DeclarationCollection.analyzeDeclaredType(
              context.context,
              declaredSyntax,
              typeParameters,
              false,
              context.resolution.bodyLifetimes === undefined ||
                context.resolution.authoredDeclaration === undefined
                ? undefined
                : DeclarationLifetime.forBody(
                    context.context,
                    context.resolution.bodyLifetimes,
                    context.resolution.authoredDeclaration,
                    typeParameters,
                  ),
            )
      const nameResolution: NameResolution.Resolution = {
        _tag: 'NameResolution',
        modules: [context.resolution.scope],
        contexts: SemanticContext.registry([context.context]),
        diagnostics: [],
      }
      const resolvedDeclared =
        analyzedDeclared === undefined
          ? undefined
          : DeclarationResolution.resolveTypeFact(
              context.context.spanOf,
              context.resolution.index,
              AuthoredWalk.moduleName(context.context),
              analyzedDeclared.fact,
              (module, path) =>
                NameResolution.resolveType(nameResolution, context.resolution.index, module, path),
            )
      if (analyzedDeclared !== undefined) context.diagnostics.push(...analyzedDeclared.diagnostics)
      if (resolvedDeclared !== undefined) context.diagnostics.push(...resolvedDeclared.diagnostics)
      const expected =
        resolvedDeclared?.fact._tag === 'Resolved' ? resolvedDeclared.fact.type : undefined
      const initializer = analyzeExpression(
        context.context,
        initializerNode,
        context.declarations,
        context.declaration,
        scope,
        context.resolution,
        expected,
      )
      if (initializer === undefined) {
        throw new RangeError(`Semantic analysis cannot analyze ${initializerNode._tag}`)
      }
      context.diagnostics.push(...initializer.diagnostics)
      if (
        expected !== undefined &&
        initializer.type !== undefined &&
        !typesCompatible(initializer.type, expected, context.resolution?.lifetimeCompatibility)
      )
        context.diagnostics.push(
          Diagnostic.assignmentTypeMismatch(
            Type.encode(expected),
            Type.encode(initializer.type),
            Location.at(initializerNode.anchor),
          ),
        )

      // Only a `mut Effect` needs a mutable binding: it runs through exclusive access
      // (EFFECT-OWN-002, BORROW-002). Every other recipe binding stays immutable.
      if (
        element.mutable &&
        initializer.type !== undefined &&
        Type.isEffect(initializer.type) &&
        initializer.type.access !== 'Exclusive'
      )
        context.diagnostics.push(Diagnostic.mutableEffectRecipe(Location.at(element.anchor)))

      const name = bindingName(context.context, element.name)
      const exactCallable = exactCallableOf(
        initializer.fact,
        context.resolution.writtenCallableBindings,
      )
      const hasConcreteCallableIdentity = concreteCallableIdentity(
        initializer.fact,
        context.resolution.writtenCallableBindings,
      )
      const phase: 'Runtime' | 'Static' =
        context.declaration.phase === 'Static' || element.static ? 'Static' : 'Runtime'
      const bindingType = expected ?? initializer.type
      if (
        phase === 'Runtime' &&
        bindingType !== undefined &&
        DeclarationFacts.containsStaticPhaseOnly(context.resolution.index, bindingType)
      )
        context.diagnostics.push(
          Diagnostic.staticPhaseViolation(
            'runtime binding of a phase-only value',
            context.staticContext?.environment.target ?? 'unselected-target',
            [],
            Location.at(element.anchor),
          ),
        )
      const evaluated =
        phase === 'Static' &&
        context.staticContext !== undefined &&
        context.resolution.deferStaticCalls !== true &&
        !containsOrdinaryArm(initializerNode)
          ? evaluateStatic(initializer.fact, context.staticContext, context.resolution)
          : undefined
      if (evaluated?._tag === 'Failed')
        context.diagnostics.push(staticDiagnostic(evaluated.failure))
      const staticValue: StaticValue.Value | undefined =
        evaluated?._tag === 'Complete' ? evaluated.value : undefined
      const binding: BindingDeclarationFact = {
        _tag: 'BindingFact',
        id: {
          _tag: 'TirBinding',
          function: context.declaration.id,
          ordinal: bindingOrdinal,
        },
        name,
        phase,
        mutability: element.mutable ? 'Mutable' : 'Immutable',
        ...(resolvedDeclared === undefined ? {} : { declaredType: resolvedDeclared.fact }),
        // A declared union is the binding's type: the initializer injects at the binding boundary.
        inferredType:
          expected !== undefined &&
          Type.isUnion(expected) &&
          initializer.type !== undefined &&
          typesCompatible(initializer.type, expected, context.resolution?.lifetimeCompatibility)
            ? { _tag: 'Available', type: expected }
            : initializer.fact.type,
        initializer: expressionNode(initializer),
        ...(staticValue === undefined ? {} : { staticValue }),
        ...(exactCallable === undefined ? {} : { exactCallable }),
        ...(hasConcreteCallableIdentity ? { concreteCallableIdentity: true as const } : {}),
        anchor: element.anchor,
      }
      BodyBuilder.semanticLocal(construction(context), binding, {
        kind: 'Binding',
        ...(binding.name._tag === 'Present' ? { name: binding.name.spelling } : {}),
        type: binding.inferredType._tag === 'Available' ? binding.inferredType.type : 'never',
        mutability: binding.mutability,
      })
      context.bindings.push(binding)
      if (staticValue !== undefined && context.staticContext !== undefined) {
        const key = Evaluation.localValueKey(binding)
        const localKey = Evaluation.tirLocalKey(
          BodyBuilder.localId(construction(context), binding.id),
        )
        context.staticContext.values.set(key, staticValue)
        context.staticContext.values.set(localKey, staticValue)
        const evaluatedNode = expressionNode(initializer)
        const staticTextSpan = context.staticContext.expressionSpans.get(evaluatedNode)
        if (staticTextSpan !== undefined) {
          context.staticContext.valueSpans.set(key, staticTextSpan)
          context.staticContext.valueSpans.set(localKey, staticTextSpan)
        }
        const staticTextOrigin = context.staticContext.expressionOrigins.get(evaluatedNode)
        if (staticTextOrigin !== undefined) {
          context.staticContext.valueOrigins.set(key, staticTextOrigin)
          context.staticContext.valueOrigins.set(localKey, staticTextOrigin)
        }
      }
      append({ _tag: 'BindStatement', binding, region })

      if (name._tag === 'Present') {
        const originalSpan = blockBindings.get(name.spelling)
        if (originalSpan === undefined) {
          blockBindings.set(name.spelling, Location.at(name.anchor))
          scope = {
            parameters: scope.parameters,
            bindings: [...scope.bindings, binding],
            patternBindings: scope.patternBindings,
          }
        } else {
          context.diagnostics.push(
            Diagnostic.rebindingName(name.spelling, originalSpan, Location.at(name.anchor)),
          )
        }
      }
      continue
    }

    if (element._tag === 'PatternBindingStatement') {
      const region = nextRegion()
      const selection = analyzePatternSelection(element, scope)
      const subjectType = constructionExpressionType(selection.subject)
      if (selection.pattern._tag === 'UniversalPattern') {
        if (subjectType._tag === 'Available')
          context.diagnostics.push(
            Diagnostic.expressionStatementResult(
              SemanticDisplay.type(
                subjectType.type,
                AuthoredWalk.moduleName(context.context),
                context.resolution.scope,
              ),
              Location.at(selection.pattern.anchor),
            ),
          )
      } else if (selection.pattern._tag !== 'UnavailablePattern' && !selection.irrefutable) {
        let selected: Match.CoverageIdentity | undefined
        if (selection.pattern._tag === 'EnumMemberPattern') {
          selected = selection.pattern.coverage
        } else if (selection.pattern._tag === 'UnionVariantPattern') {
          selected = selection.pattern.coverage
        } else if (
          (selection.pattern._tag === 'NominalPattern' ||
            selection.pattern._tag === 'TypePattern') &&
          selection.pattern.member !== undefined
        ) {
          selected = Match.structuralMember(selection.pattern.member)
        } else {
          selected = undefined
        }
        context.diagnostics.push(
          Diagnostic.refutableLetPattern(
            subjectType._tag === 'Available'
              ? SemanticDisplay.type(
                  subjectType.type,
                  AuthoredWalk.moduleName(context.context),
                  context.resolution.scope,
                )
              : '<unavailable>',
            selection.members
              .filter((member) => selected === undefined || !Match.selects(selected, member))
              .map(Match.encodeIdentity),
            Location.at(selection.pattern.anchor),
          ),
        )
      }
      append({
        _tag: 'PatternBindStatement',
        selection,
        region,
        anchor: element.anchor,
      })
      for (const binding of selection.bindings)
        BodyBuilder.semanticLocal(construction(context), binding, {
          kind: 'Pattern',
          ...(binding.name._tag === 'Present' ? { name: binding.name.spelling } : {}),
          type: binding.type._tag === 'Available' ? binding.type.type : 'never',
          mutability: binding.access === 'Place' ? 'Mutable' : 'Immutable',
        })
      for (const binding of selection.bindings) {
        if (binding.name._tag !== 'Present') continue
        const originalSpan = blockBindings.get(binding.name.spelling)
        if (originalSpan === undefined)
          blockBindings.set(binding.name.spelling, Location.at(binding.name.anchor))
      }
      scope = {
        parameters: scope.parameters,
        bindings: scope.bindings,
        patternBindings: [...scope.patternBindings, ...selection.bindings],
      }
      continue
    }

    if (element._tag === 'ExpressionStatement') {
      const region = nextRegion()
      const authoredExpression = element.expression
      const expression = analyzeExpression(
        context.context,
        authoredExpression,
        context.declarations,
        context.declaration,
        scope,
        context.resolution,
      )
      if (expression === undefined) {
        throw new RangeError(`Semantic analysis cannot analyze ${authoredExpression._tag}`)
      }
      context.diagnostics.push(...expression.diagnostics)
      if (
        context.staticContext !== undefined &&
        context.declaration.phase !== 'Static' &&
        expression.fact._tag === 'CompileError'
      ) {
        const evaluated = evaluateStatic(expression.fact, context.staticContext, context.resolution)
        if (evaluated._tag === 'Failed')
          context.diagnostics.push(staticDiagnostic(evaluated.failure))
        append({
          _tag: 'ExpressionStatement',
          expression: expressionNode(expression),
          region,
          anchor: element.anchor,
        })
        continue
      }
      if (
        expression.type !== undefined &&
        !Type.equals(expression.type, Type.unit) &&
        !Type.isNever(expression.type)
      ) {
        context.diagnostics.push(
          Diagnostic.expressionStatementResult(
            SemanticDisplay.type(
              expression.type,
              AuthoredWalk.moduleName(context.context),
              context.resolution.scope,
            ),
            Location.at(authoredExpression.anchor),
          ),
        )
      }
      append({
        _tag: 'ExpressionStatement',
        expression: expressionNode(expression),
        region,
        anchor: element.anchor,
      })
      continue
    }

    if (element._tag === 'StaticForStatement') {
      const checkpoint = staticExpansionCheckpoint()
      const iterableNode = element.iterable
      const iterable = analyzeExpression(
        context.context,
        iterableNode,
        context.declarations,
        context.declaration,
        scope,
        context.resolution,
      )
      if (iterable === undefined)
        throw new RangeError(`Semantic analysis cannot analyze ${iterableNode._tag}`)
      context.diagnostics.push(...iterable.diagnostics)
      const reject = (): void => {
        restoreStaticExpansion(checkpoint)
        context.staticIterations.push({
          _tag: 'StaticIteration',
          iterable: expressionNode(iterable),
          state: 'Rejected',
          scopes: [],
          anchor: element.anchor,
        })
      }
      if (context.staticContext === undefined) {
        context.staticIterations.push({
          _tag: 'StaticIteration',
          iterable: expressionNode(iterable),
          state: 'Deferred',
          scopes: [],
          anchor: element.anchor,
        })
        continue
      }
      if (iterable.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
        reject()
        continue
      }
      const evaluated = evaluateStatic(iterable.fact, context.staticContext, context.resolution)
      if (evaluated._tag === 'Failed') {
        context.diagnostics.push(staticDiagnostic(evaluated.failure))
        reject()
        continue
      }
      const elements = staticIterationElements(evaluated.value)
      if (elements === undefined) {
        context.diagnostics.push(
          Diagnostic.staticPhaseViolation(
            'static for requires a finite static sequence or field collection',
            context.staticContext.environment.target,
            [],
            Location.at(iterableNode.anchor),
          ),
        )
        reject()
        continue
      }
      const name: DeclarationFacts.DeclaredName = bindingName(context.context, element.binding)
      const body = element.body
      const scopes: Array<StaticIterationFact['scopes'][number]> = []
      let failed = false
      for (const [ordinal, current] of elements.entries()) {
        const iterationTrace = Evaluation.appendTrace(
          context.staticContext.trace,
          Evaluation.staticIterationFrame(ordinal, current.value, Location.at(element.anchor)),
        )
        const iterationStaticContext = {
          ...context.staticContext,
          trace: iterationTrace,
        }
        const binding: BindingDeclarationFact = {
          _tag: 'BindingFact',
          id: {
            _tag: 'TirBinding',
            function: context.declaration.id,
            ordinal: context.nextBindingOrdinal.value,
          },
          name,
          phase: 'Static',
          mutability: 'Immutable',
          inferredType: { _tag: 'Available', type: current.type },
          initializer: expressionNode(iterable),
          staticValue: current.value,
          staticIteration: true,
          anchor: element.anchor,
        }
        BodyBuilder.semanticLocal(construction(context), binding, {
          kind: 'Binding',
          ...(binding.name._tag === 'Present' ? { name: binding.name.spelling } : {}),
          type: binding.inferredType._tag === 'Available' ? binding.inferredType.type : 'never',
          mutability: binding.mutability,
        })
        context.nextBindingOrdinal.value += 1
        context.bindings.push(binding)
        context.staticContext.values.set(Evaluation.localValueKey(binding), current.value)
        context.staticContext.values.set(
          Evaluation.tirLocalKey(BodyBuilder.localId(construction(context), binding.id)),
          current.value,
        )
        const diagnosticStart = context.diagnostics.length
        const nestedIterationStart = context.staticIterations.length
        const statements =
          body === undefined
            ? []
            : analyzeStatements(
                {
                  ...context,
                  staticContext: iterationStaticContext,
                  resolution: {
                    ...context.resolution,
                    staticContext: iterationStaticContext,
                  },
                },
                body,
                {
                  parameters: scope.parameters,
                  bindings: [...scope.bindings, binding],
                  patternBindings: scope.patternBindings,
                },
                loopStack,
              )
        if (
          context.diagnostics
            .slice(diagnosticStart)
            .some((diagnostic) => diagnostic.severity === 'error')
        ) {
          failed = true
          break
        }
        const nestedIterations = context.staticIterations.slice(nestedIterationStart)
        context.staticIterations.length = nestedIterationStart
        const residualNodes = Math.max(
          0,
          residualNodeCount(statements) - nestedStaticIterationNodeCount(nestedIterations),
        )
        const chargeFailure = context.staticContext.chargeStaticIteration?.(
          iterationTrace,
          residualNodes,
        )
        if (chargeFailure !== undefined) {
          context.diagnostics.push(staticDiagnostic(chargeFailure))
          failed = true
          break
        }
        if (context.staticContext.chargedStaticIterationNodes !== undefined)
          context.staticContext.chargedStaticIterationNodes.value += residualNodes
        scopes.push({
          _tag: 'StaticIterationScope',
          ordinal,
          binding,
          statements: [...statements],
          staticIterations: nestedIterations,
        })
      }
      if (failed) {
        reject()
        continue
      }
      const iteration: StaticIterationFact = {
        _tag: 'StaticIteration',
        iterable: expressionNode(iterable),
        state: 'Expanded',
        scopes: scopes,
        anchor: element.anchor,
      }
      context.staticIterations.push(iteration)
      for (const iterationScope of scopes) facts.push(...iterationScope.statements)
      continue
    }

    if (element._tag === 'StaticConditionalStatement') {
      if (context.staticContext === undefined) continue
      const conditionNode = element.condition
      const condition = analyzeExpression(
        context.context,
        conditionNode,
        context.declarations,
        context.declaration,
        scope,
        context.resolution,
        'bool',
      )
      if (condition === undefined)
        throw new RangeError(`Semantic analysis cannot analyze ${conditionNode._tag}`)
      context.diagnostics.push(...condition.diagnostics)
      const evaluated = evaluateStatic(condition.fact, context.staticContext, context.resolution)
      if (evaluated._tag === 'Failed') {
        context.diagnostics.push(staticDiagnostic(evaluated.failure))
        continue
      }
      if (evaluated.value._tag !== 'BooleanValue') {
        context.diagnostics.push(
          Diagnostic.staticPhaseViolation(
            'static if condition must evaluate to bool',
            context.staticContext.environment.target,
            [],
            Location.at(conditionNode.anchor),
          ),
        )
        continue
      }
      // Both authored arms are present; selection picks one and the other is not elaborated.
      const branch = evaluated.value.value ? element.thenBranch : element.elseBranch
      // `else static if …` chains the next conditional where a block would be: it is analyzed as
      // that one statement, so its own selection still contributes its returns.
      const selected: AuthoredHir.Block | undefined =
        branch === undefined || branch._tag === 'Block'
          ? branch
          : {
              _tag: 'Block',
              anchor: branch.anchor,
              origin: branch.origin,
              causes: [],
              statements: [branch],
            }
      if (selected !== undefined) {
        const staticContext = {
          ...context.staticContext,
          trace: Evaluation.appendTrace(
            context.staticContext.trace,
            Evaluation.selectedArmFrame(
              evaluated.value.value ? 'Taken' : 'Otherwise',
              Location.at(selected.anchor),
            ),
          ),
        }
        const selectedStatements = analyzeStatements(
          {
            ...context,
            staticContext,
            resolution: { ...context.resolution, staticContext },
          },
          selected,
          scope,
          loopStack,
        )
        facts.push(...selectedStatements)
        const selectedFlow = returnFlowOf(selectedStatements)
        if (
          !selectedFlow.fallsThrough &&
          (selectedFlow.returns.length > 0 ||
            selectedStatements.some((statement) => statement._tag === 'Fail'))
        )
          break
      }
      continue
    }

    if (element._tag === 'ConditionalStatement') {
      facts.push(analyzeConditional(element, scope, loopStack))
      continue
    }

    if (element._tag === 'PatternConditionalStatement') {
      facts.push(analyzePatternConditional(element, scope, loopStack))
      continue
    }

    if (element._tag === 'AssignmentStatement') {
      const region = nextRegion()
      const destinationNode = element.target
      const valueNode = element.value
      const destination = analyzeExpression(
        context.context,
        destinationNode,
        context.declarations,
        context.declaration,
        scope,
        context.resolution,
      )
      if (destination === undefined) {
        throw new RangeError(`Semantic analysis cannot analyze ${destinationNode._tag}`)
      }
      context.diagnostics.push(...destination.diagnostics)
      const root = assignmentRoot(destination.fact)
      const activatedStart = context.resolution.bodyLifetimes?.activatedConstraints.length ?? 0
      const writeCompatibility =
        context.resolution.bodyLifetimes === undefined ||
        context.resolution.lifetimeCompatibility === undefined
          ? context.resolution.lifetimeCompatibility
          : BodyLifetime.activatedCompatibility(
              context.resolution.bodyLifetimes,
              context.resolution.lifetimeCompatibility,
              element.anchor,
              root?.anchor,
            )
      const writeResolution: ResolutionContext = {
        ...context.resolution,
        ...(writeCompatibility === undefined ? {} : { lifetimeCompatibility: writeCompatibility }),
      }
      const value = analyzeExpression(
        context.context,
        valueNode,
        context.declarations,
        context.declaration,
        scope,
        writeResolution,
        destination.type,
      )
      if (value === undefined) {
        throw new RangeError(`Semantic analysis cannot analyze ${valueNode._tag}`)
      }
      context.diagnostics.push(...value.diagnostics)
      const rootAccess =
        root === undefined ? undefined : assignmentRootAccess(root, destination.fact)
      const writableRoot =
        destination.fact._tag !== 'ForeignStatic' &&
        root !== undefined &&
        rootAccess !== 'ImmutableOwned' &&
        rootAccess !== 'SharedBorrowed' &&
        !(
          rootAccess === 'ExclusiveBorrowed' &&
          destination.fact._tag !== 'IndexProjection' &&
          destination.fact._tag !== 'ReferentProjection' &&
          destination.fact._tag !== 'FieldProjection'
        )
      if (destination.fact._tag === 'ForeignStatic') {
        context.diagnostics.push(
          Diagnostic.immutableAssignment(
            destination.fact.declaration.name._tag === 'Present'
              ? destination.fact.declaration.name.spelling
              : '?',
            Location.at(destinationNode.anchor),
          ),
        )
      } else if (root === undefined) {
        if (AuthoredWalk.isAvailable(destinationNode) && destination.diagnostics.length === 0) {
          context.diagnostics.push(
            Diagnostic.invalidAssignmentPlace(Location.at(destinationNode.anchor)),
          )
        }
      } else if (rootAccess === 'ImmutableOwned') {
        context.diagnostics.push(
          Diagnostic.immutableAssignment(
            root.name._tag === 'Present' ? root.name.spelling : '?',
            Location.at(destinationNode.anchor),
          ),
        )
      } else if (
        rootAccess === 'SharedBorrowed' ||
        (rootAccess === 'ExclusiveBorrowed' &&
          destination.fact._tag !== 'IndexProjection' &&
          destination.fact._tag !== 'ReferentProjection' &&
          destination.fact._tag !== 'FieldProjection')
      ) {
        context.diagnostics.push(
          Diagnostic.invalidAssignmentPlace(Location.at(destinationNode.anchor)),
        )
      }
      const compatible =
        destination.type !== undefined &&
        value.type !== undefined &&
        typesCompatible(value.type, destination.type, writeCompatibility)
      if (destination.type !== undefined && value.type !== undefined && !compatible) {
        const expectedOrigin =
          root?._tag === 'BindingFact'
            ? Location.at(constructionExpressionAnchor(root.initializer))
            : Location.at(destinationNode.anchor)
        context.diagnostics.push(
          representationJoinDiagnostic(
            destination.type,
            value.type,
            expectedOrigin,
            Location.at(valueNode.anchor),
            Location.at(valueNode.anchor),
          ) ??
            unionConversionDiagnostic(
              value.type,
              destination.type,
              Location.at(valueNode.anchor),
              context.resolution?.lifetimeCompatibility,
            ) ??
            Diagnostic.assignmentTypeMismatch(
              Type.encode(destination.type),
              Type.encode(value.type),
              Location.at(valueNode.anchor),
            ),
        )
      }
      if (
        root?._tag === 'BindingFact' &&
        root.inferredType._tag === 'Available' &&
        Type.isCallable(root.inferredType.type)
      ) {
        // A callable binding keeps the exact representation it was initialized with; writing a
        // callable of another construction site would erase that identity behind the structural type.
        // Deferred writes inside an Effect body are governed by the captured-callable mutation rule.
        const identityOf = (
          expression: ExpressionDecision | Tir.Expression,
        ): string | undefined => {
          const representation = representationOfExpression(
            context.context,
            expression,
            context.resolution?.builder,
          )
          return representation !== undefined &&
            Type.isExactRepresentationArgument(representation) &&
            Type.isCallableIdentityArgument(representation.identity)
            ? Type.genericArgumentKey(representation.identity)
            : undefined
        }
        const current = identityOf(root.initializer)
        const written = identityOf(value.fact)
        if (
          compatible &&
          !context.effectBlock &&
          destination.fact._tag === 'Identifier' &&
          current !== undefined &&
          written !== undefined &&
          current !== written
        )
          context.diagnostics.push(
            Diagnostic.callableIdentityErasure(Location.at(valueNode.anchor)),
          )
        context.resolution.writtenCallableBindings?.add(root.id.ordinal)
      }
      append({
        _tag: 'WriteStatement',
        destination: expressionNode(destination),
        ...(writableRoot ? { root } : {}),
        value: expressionNode(value),
        compatible,
        lifetimeProof: Lifetime.assumptions(
          compatible
            ? (context.resolution.bodyLifetimes?.activatedConstraints
                .slice(activatedStart)
                .filter(
                  ({ installed }) =>
                    AuthoredIdentity.anchorKey(installed) ===
                    AuthoredIdentity.anchorKey(element.anchor),
                )
                .map(({ bound }) => bound) ?? [])
            : [],
        ).bounds,
        region,
        anchor: element.anchor,
      })
      continue
    }

    if (element._tag === 'WhileStatement') {
      const region = nextRegion()
      const loop = {
        _tag: 'TirLoop' as const,
        function: context.declaration.id,
        ordinal: context.loops.length,
      }
      context.loops.push(loop)
      const bodyNode = element.body
      const loopEntry = snapshotCallableWrites()
      const checkpoint = {
        bindings: context.bindings.length,
        diagnostics: context.diagnostics.length,
        regions: context.regions.length,
        loops: context.loops.length,
        nextBindingOrdinal: context.nextBindingOrdinal.value,
      }
      const analyzeLoopPass = (entry: ReadonlySet<number>) => {
        restoreCallableWrites(entry)
        const conditionNode = element.condition
        const condition = analyzeExpression(
          context.context,
          conditionNode,
          context.declarations,
          context.declaration,
          scope,
          ordinaryControlContext.resolution,
        )
        if (condition === undefined) {
          throw new RangeError(`Semantic analysis cannot analyze ${conditionNode._tag}`)
        }
        context.diagnostics.push(...condition.diagnostics)
        if (
          condition.fact.type._tag === 'Available' &&
          condition.fact.type.type !== 'bool' &&
          !Type.isNever(condition.fact.type.type)
        ) {
          context.diagnostics.push(
            Diagnostic.conditionNotBool(
              Type.encode(condition.fact.type.type),
              Location.at(conditionNode.anchor),
            ),
          )
        }
        const bodyEntry = snapshotCallableWrites()
        const body =
          bodyNode === undefined
            ? []
            : analyzeStatements(ordinaryControlContext, bodyNode, scope, [...loopStack, loop])
        const flow = callableWriteFlow(body, bodyEntry, loop)
        const backedge = unionWriteStates(flow.fallthrough, flow.continues)
        return {
          condition: expressionNode(condition),
          body,
          bodyEntry,
          flow,
          backedge,
        }
      }
      let analyzed = analyzeLoopPass(loopEntry)
      const initialBackedge = analyzed.backedge
      if ([...(initialBackedge ?? [])].some((ordinal) => !loopEntry.has(ordinal))) {
        context.bindings.length = checkpoint.bindings
        context.diagnostics.length = checkpoint.diagnostics
        context.regions.length = checkpoint.regions
        context.loops.length = checkpoint.loops
        context.nextBindingOrdinal.value = checkpoint.nextBindingOrdinal
        const fixedEntry = new Set(loopEntry)
        for (const ordinal of initialBackedge ?? []) fixedEntry.add(ordinal)
        analyzed = analyzeLoopPass(fixedEntry)
      }
      mergeCallableWrites(
        analyzed.bodyEntry,
        ...(analyzed.backedge === undefined ? [] : [analyzed.backedge]),
        ...(analyzed.flow.breaks === undefined ? [] : [analyzed.flow.breaks]),
      )
      const parent = loopStack.at(-1)
      append({
        _tag: 'WhileStatement',
        loop,
        ...(parent === undefined ? {} : { parent }),
        condition: analyzed.condition,
        body: [...analyzed.body],
        region,
        anchor: element.anchor,
      })
      continue
    }

    if (element._tag === 'BreakStatement' || element._tag === 'ContinueStatement') {
      const region = nextRegion()
      const target = loopStack.at(-1)
      if (target === undefined) {
        context.diagnostics.push(
          Diagnostic.transferOutsideLoop(
            element._tag === 'BreakStatement' ? 'break' : 'continue',
            Location.at(element.anchor),
          ),
        )
      }
      append({
        _tag: element._tag,
        ...(target === undefined ? {} : { target }),
        region,
        anchor: element.anchor,
      })
      continue
    }

    if (element._tag === 'ReturnStatement') {
      const region = nextRegion()
      // `return` without a value returns unit; the authored unit literal stands in for it.
      const authoredExpression = element.value ?? unitValueOf(element)
      const expression = analyzeExpression(
        context.context,
        authoredExpression,
        context.declarations,
        context.declaration,
        scope,
        context.resolution,
        !context.effectBlock ? context.returnType : undefined,
      )
      if (expression === undefined) {
        throw new RangeError(`Semantic analysis cannot analyze ${authoredExpression._tag}`)
      }
      context.diagnostics.push(...expression.diagnostics)
      if (
        !context.effectBlock &&
        expression.type !== undefined &&
        Type.isCallable(expression.type) &&
        expression.type.mode !== 'Shared' &&
        !concreteCallableIdentity(expression.fact, context.resolution.writtenCallableBindings)
      ) {
        context.diagnostics.push(
          Diagnostic.unknownOwnedCallableReturn(Location.at(authoredExpression.anchor)),
        )
      }
      append({
        _tag: 'ReturnStatement',
        expression: expressionNode(expression),
        // A trailing block expression carries no `return` keyword, so lowering marks the
        // statement it synthesizes `implicit-return` instead of leaving a token to inspect.
        ...(element.origin._tag === 'Synthetic' && element.origin.role === 'implicit-return'
          ? { implicit: true as const }
          : {}),
        region,
        anchor: element.anchor,
      })
      break
    }

    if (element._tag === 'FailStatement') {
      const region = nextRegion()
      const authoredExpression = element.value
      const expression = analyzeExpression(
        context.context,
        authoredExpression,
        context.declarations,
        context.declaration,
        scope,
        context.resolution,
      )
      if (expression === undefined)
        throw new RangeError(`Semantic analysis cannot analyze ${authoredExpression._tag}`)
      context.diagnostics.push(...expression.diagnostics)
      const validFailure =
        expression.type !== undefined && Type.isFailureValue(expression.type)
          ? expression.type
          : undefined
      if (!context.effectBlock && context.declaration.functionKind !== 'Effect')
        context.diagnostics.push(Diagnostic.failOutsideEffect(Location.at(element.anchor)))
      if (expression.type !== undefined && validFailure === undefined)
        context.diagnostics.push(
          Diagnostic.invalidFailureType(
            Type.encode(expression.type),
            Location.at(authoredExpression.anchor),
          ),
        )
      if (
        !context.effectBlock &&
        validFailure !== undefined &&
        !(Type.isUnion(validFailure) ? validFailure.members : [validFailure]).every((member) =>
          Type.isParameter(member)
            ? Type.failureMemberParameters(context.declaration.failureRow.row).some((parameter) =>
                Type.equals(parameter, member),
              )
            : context.declaration.failureRow.failures.some((candidate) =>
                typesCompatible(member, candidate, context.resolution.lifetimeCompatibility),
              ),
        )
      )
        context.diagnostics.push(
          Diagnostic.undeclaredFailure(
            Type.encode(validFailure),
            Location.at(authoredExpression.anchor),
          ),
        )
      append({
        _tag: 'FailStatement',
        expression: expressionNode(expression),
        ...(expression.type === undefined ? {} : { failure: expression.type }),
        transfer: element.move ? 'Move' : 'Copy',
        region,
        anchor: element.anchor,
      })
      break
    }

    if (element._tag === 'DropStatement') {
      const region = nextRegion()
      const authoredExpression = element.value
      const expression = analyzeExpression(
        context.context,
        authoredExpression,
        context.declarations,
        context.declaration,
        scope,
        context.resolution,
      )
      if (expression === undefined)
        throw new RangeError(`Semantic analysis cannot analyze ${authoredExpression._tag}`)
      context.diagnostics.push(...expression.diagnostics)
      append({
        _tag: 'DropStatement',
        expression: expressionNode(expression),
        region,
        anchor: element.anchor,
      })
    }
  }

  return facts
}

export interface ReturnFlow {
  readonly fallsThrough: boolean
  readonly returns: ReadonlyArray<Extract<Tir.Statement, { readonly _tag: 'Return' }>>
}

export const implicitReturn = (
  statement: Extract<Tir.Statement, { readonly _tag: 'Return' }>,
): boolean => statement.implicit === true

/** Eager expression flow; constructing a callable or Effect never executes its body. */
export const expressionReturnFlow = (
  expression: ExpressionDecision | Tir.Expression,
): ReturnFlow => {
  const returns: Array<Extract<Tir.Statement, { readonly _tag: 'Return' }>> = []
  const visit = (child: ExpressionDecision | Tir.Expression): boolean => {
    const flow = expressionReturnFlow(child)
    returns.push(...flow.returns)
    return flow.fallsThrough
  }
  let fallsThrough = true
  if ('origin' in expression) {
    if (expression._tag === 'EffectBlock') return { fallsThrough, returns: returns }
    if (expression._tag === 'Match') {
      fallsThrough = visit(expression.scrutinee)
      if (fallsThrough) {
        fallsThrough = false
        let remaining = [...expression.members]
        for (const arm of expression.arms) {
          const selected = remaining.filter(
            (candidate) =>
              arm.universal || (arm.member !== undefined && Match.selects(arm.member, candidate)),
          )
          if (!arm.reachable || selected.length === 0) continue
          const guardCompletes = arm.guard === undefined || visit(arm.guard)
          remaining = remaining.filter((candidate) =>
            arm.after.some((member) => Match.identityEquals(candidate, member)),
          )
          if (!guardCompletes && (arm.tests?.length ?? 0) === 0)
            remaining = remaining.filter((candidate) => !selected.includes(candidate))
          if (!guardCompletes) continue
          if (arm.body._tag === 'Expression') {
            if (visit(arm.body.expression)) fallsThrough = true
          } else {
            const flow = returnFlowOf(arm.body.statements, false)
            returns.push(...flow.returns)
            if (flow.fallsThrough) fallsThrough = true
          }
        }
      }
    } else if (expression._tag === 'ShortCircuit') {
      fallsThrough = visit(expression.left)
      if (fallsThrough) visit(expression.right)
    } else {
      for (const child of Tir.expressionChildren(expression)) {
        if (!visit(child)) {
          fallsThrough = false
          break
        }
      }
    }
    const type = constructionExpressionType(expression)
    if (type._tag === 'Available' && Type.isNever(type.type)) fallsThrough = false
    return { fallsThrough, returns: returns }
  }
  if (expression._tag === 'EffectBlock') return { fallsThrough, returns: returns }
  if (expression._tag === 'Match') {
    fallsThrough = visit(expression.scrutinee)
    if (fallsThrough) {
      fallsThrough = false
      let remaining = [...expression.members]
      for (const arm of expression.arms) {
        const member = patternCoverage(arm.pattern)
        const selected = remaining.filter(
          (candidate) =>
            arm.pattern._tag === 'UniversalPattern' ||
            (member !== undefined && Match.selects(member, candidate)),
        )
        if (!arm.reachable || selected.length === 0) continue
        const guardCompletes = arm.guard === undefined || visit(arm.guard)
        remaining = remaining.filter((candidate) =>
          arm.after.some((member) => Match.identityEquals(candidate, member)),
        )
        if (!guardCompletes && arm.tests.length === 0)
          remaining = remaining.filter((candidate) => !selected.includes(candidate))
        if (!guardCompletes) continue
        if (arm.body._tag === 'Expression') {
          if (visit(arm.body.expression)) fallsThrough = true
        } else {
          const flow = returnFlowOf(arm.body.statements, false)
          returns.push(...flow.returns)
          if (flow.fallsThrough) fallsThrough = true
        }
      }
    }
  } else if (expression._tag === 'ShortCircuit') {
    const left = expression.arguments.at(0)?.expression
    fallsThrough = left === undefined || visit(left)
    const right = expression.arguments.at(1)?.expression
    if (fallsThrough && right !== undefined) visit(right)
  } else {
    for (const child of expressionChildren(expression)) {
      if (!visit(child)) {
        fallsThrough = false
        break
      }
    }
  }
  if (expression.type._tag === 'Available' && Type.isNever(expression.type.type))
    fallsThrough = false
  return { fallsThrough, returns: returns }
}

export const expressionNever = (expression: ExpressionDecision | Tir.Expression): boolean =>
  !expressionReturnFlow(expression).fallsThrough

/** Ordinary statements share eager operand transfers with their current execution boundary. */
export const returnFlowOf = (
  body: ReadonlyArray<Tir.Statement>,
  implicitReturnFallsThrough = true,
): ReturnFlow => {
  const returns: Array<Extract<Tir.Statement, { readonly _tag: 'Return' }>> = []
  let fallsThrough = true
  for (const statement of body) {
    if (!fallsThrough) break
    for (const expression of directStatementExpressions(statement)) {
      const flow = expressionReturnFlow(expression)
      returns.push(...flow.returns)
      if (!flow.fallsThrough) {
        fallsThrough = false
        break
      }
    }
    if (!fallsThrough) break
    if (statement._tag === 'Return') {
      if (implicitReturn(statement)) {
        fallsThrough = implicitReturnFallsThrough
        if (!implicitReturnFallsThrough) returns.push(statement)
      } else {
        returns.push(statement)
        fallsThrough = false
      }
    } else if (
      statement._tag === 'Fail' ||
      statement._tag === 'Break' ||
      statement._tag === 'Continue'
    ) {
      fallsThrough = false
    } else if (statement._tag === 'Unsafe') {
      const nested = returnFlowOf(statement.statements, implicitReturnFallsThrough)
      returns.push(...nested.returns)
      fallsThrough = nested.fallsThrough
    } else if (statement._tag === 'If' || statement._tag === 'IfLet') {
      const taken = returnFlowOf(statement.taken, implicitReturnFallsThrough)
      const otherwise = returnFlowOf(statement.otherwise, implicitReturnFallsThrough)
      returns.push(...taken.returns, ...otherwise.returns)
      fallsThrough = taken.fallsThrough || otherwise.fallsThrough
    } else if (statement._tag === 'While') {
      returns.push(...returnFlowOf(statement.body, implicitReturnFallsThrough).returns)
    }
  }
  return { fallsThrough, returns: returns }
}

/** Keeps only statements that can execute, treating an implicit unit completion as a real return. */
export const executableStatements = (
  body: ReadonlyArray<Tir.Statement>,
): ReadonlyArray<Tir.Statement> => {
  const reachable: Array<Tir.Statement> = []
  for (const statement of body) {
    reachable.push(statement)
    if (!returnFlowOf([statement], false).fallsThrough) break
  }
  return reachable
}

/** Callable binding roots written on any reachable path through these already-analyzed facts. */
export const reachableCallableWrites = (
  body: ReadonlyArray<Tir.Statement>,
  builder: BodyBuilder.BodyBuilder,
): ReadonlySet<number> => {
  const writes = new Set<number>()
  const expression = (fact: ExpressionDecision | Tir.Expression): boolean => {
    if ('origin' in fact) {
      if (fact._tag === 'EffectBlock') return true
      for (const child of Tir.expressionChildren(fact)) if (!expression(child)) return false
      if (fact._tag === 'Replace') {
        const binding = callableBinding(fact.place)
        if (
          binding?.inferredType._tag === 'Available' &&
          Type.isCallable(binding.inferredType.type)
        )
          writes.add(binding.id.ordinal)
      }
      return !expressionNever(fact)
    }
    if (fact._tag === 'EffectBlock') return true
    if (fact._tag === 'ShortCircuit') {
      const left = fact.arguments.at(0)?.expression
      if (left !== undefined && !expression(left)) return false
      const right = fact.arguments.at(1)?.expression
      if (right !== undefined) expression(right)
      return !expressionNever(fact)
    }
    if (fact._tag === 'Match') {
      if (!expression(fact.scrutinee)) return false
      let completes = false
      for (const arm of fact.arms) {
        if (!arm.reachable) continue
        if (arm.guard !== undefined && !expression(arm.guard)) continue
        if (
          arm.body._tag === 'Expression'
            ? expression(arm.body.expression)
            : visit(arm.body.statements)
        )
          completes = true
      }
      return completes
    }
    for (const child of expressionChildren(fact)) if (!expression(child)) return false
    if (
      fact._tag === 'PlaceReplace' &&
      fact.root?._tag === 'BindingFact' &&
      fact.root.inferredType._tag === 'Available' &&
      Type.isCallable(fact.root.inferredType.type)
    )
      writes.add(fact.root.id.ordinal)
    return !expressionNever(fact)
  }
  const callableBinding = (place: Tir.WritePlace): BindingDeclarationFact | undefined => {
    const local =
      place.root._tag === 'BindingWriteRoot' || place.root._tag === 'BindingSliceRoot'
        ? place.root.binding
        : undefined
    if (local === undefined) return undefined
    const semantic = BodyBuilder.semanticOfLocal(builder, local)
    return isBindingDeclarationFact(semantic) ? semantic : undefined
  }
  const visit = (statements: ReadonlyArray<Tir.Statement>): boolean => {
    let fallsThrough = true
    for (const statement of statements) {
      if (!fallsThrough) break
      if (statement._tag === 'Bind') {
        fallsThrough = expression(statement.initializer)
      } else if (statement._tag === 'PatternBind') {
        fallsThrough = expression(statement.selection.subject)
      } else if (statement._tag === 'Evaluate' || statement._tag === 'Drop') {
        fallsThrough = expression(statement.expression)
      } else if (statement._tag === 'Write') {
        const destinationContinues =
          statement.destination === undefined || expression(statement.destination)
        if (!destinationContinues) {
          fallsThrough = false
          continue
        }
        const valueContinues = expression(statement.value)
        const binding = callableBinding(statement.place)
        if (
          valueContinues &&
          binding?.inferredType._tag === 'Available' &&
          Type.isCallable(binding.inferredType.type)
        )
          writes.add(binding.id.ordinal)
        fallsThrough = valueContinues
      } else if (statement._tag === 'Return' || statement._tag === 'Fail') {
        expression(statement.expression)
        fallsThrough = false
      } else if (statement._tag === 'Break' || statement._tag === 'Continue') {
        fallsThrough = false
      } else if (statement._tag === 'Unsafe') {
        fallsThrough = visit(statement.statements)
      } else if (statement._tag === 'If' || statement._tag === 'IfLet') {
        const condition =
          statement._tag === 'If' ? statement.condition : statement.selection.subject
        if (!expression(condition)) {
          fallsThrough = false
        } else {
          const takenFallsThrough = visit(statement.taken)
          const otherwiseFallsThrough = visit(statement.otherwise)
          fallsThrough = takenFallsThrough || otherwiseFallsThrough
        }
      } else if (statement._tag === 'While') {
        fallsThrough = expression(statement.condition)
        if (fallsThrough) visit(statement.body)
      }
    }
    return fallsThrough
  }
  visit(body)
  return writes
}

/**
 * Where a body that falls off its end is reported: the closing brace, which a presented block
 * span always ends with unless recovery left the block damaged.
 */
const closingBraceSpan = (block: AuthoredHir.Block): Location.Location =>
  block.causes.length > 0 ? Location.at(block.anchor) : Location.endOf(block.anchor)
/**
 * Joins the Effects constructed at distinct return sites of one function into one finite
 * composite representation under the declared contract (EFF-013). A single construction site
 * needs no composite; sites without an exact static representation cannot join and report
 * `SEM0132`.
 */
const returnSiteEffectJoin = (
  context: BodyContext,
  declaration: DeclarationFact,
  returns: ReadonlyArray<Extract<Tir.Statement, { readonly _tag: 'Return' }>>,
): Type.Type | undefined => {
  if (declaration.returnType._tag !== 'Resolved') return undefined
  const declared = declaration.returnType.type
  if (!Type.isEffect(declared) || returns.length < 2) return undefined
  const sites = returns.filter((statement) => {
    const type = constructionExpressionType(statement.expression)
    return type._tag === 'Available' && !Type.isNever(type.type)
  })
  const alternatives: Array<Type.ExactRepresentationArgument> = []
  const missing: Array<Location.Location> = []
  for (const statement of sites) {
    const representation = representationOfExpression(
      context.context,
      statement.expression,
      context.resolution?.builder,
    )
    if (
      representation !== undefined &&
      Type.isExactRepresentationArgument(representation) &&
      Type.isEffectIdentityArgument(representation.identity)
    )
      alternatives.push(representation)
    else if (
      representation !== undefined &&
      Type.isCompositeEffectRepresentationArgument(representation)
    )
      alternatives.push(...representation.alternatives)
    else missing.push(Location.at(constructionExpressionAnchor(statement.expression)))
  }
  const composite = Type.compositeEffectRepresentationArgument(declared, alternatives)
  if (composite.alternatives.length < 2 && missing.length === 0) return undefined
  if (missing.length > 0) {
    if (composite.alternatives.length === 0) return undefined
    for (const span of missing)
      context.diagnostics.push(
        Diagnostic.nonFiniteEffectJoin(
          'every reachable return site must retain one exact static Effect representation',
          span,
        ),
      )
    return undefined
  }
  return Type.represented(declared, declared, composite)
}

export const analyzeFunctionBody = (
  semantic: SemanticContext.SemanticContext,
  declaration: DeclarationFact,
  declarations: ReadonlyArray<DeclarationFact>,
  resolution: ResolutionContext,
  staticContext?: BodyContext['staticContext'],
  initialScope?: Scope,
): FunctionAnalysis => {
  const builder =
    resolution.builder ?? BodyBuilder.make({ owner: declaration.owner, request: { _tag: 'Check' } })
  for (const parameter of declaration.parameters)
    BodyBuilder.semanticLocal(builder, parameter, {
      kind: 'Parameter',
      ...(parameter.name._tag === 'Present' ? { name: parameter.name.spelling } : {}),
      type: parameter.declaredType._tag === 'Resolved' ? parameter.declaredType.type : 'never',
      mutability: parameter.bindingMutability,
    })
  const returnType =
    declaration.returnType._tag === 'Resolved'
      ? Type.substitute(declaration.returnType.type, staticContext?.typeSubstitution ?? new Map())
      : undefined
  const blockNode = AuthoredWalk.bodyBlock(semantic, declaration)
  const executableSiteOrdinals = executableSites(blockNode)
  const unsafeSpans = AuthoredWalk.statements(blockNode)
    .filter((statement) => statement._tag === 'UnsafeStatement')
    .map((statement) => semantic.spanOf(statement.anchor))
  const nextBindingOrdinal = { value: 0 }
  const declaredOutlives = TypeOutlives.context(resolution.index.modules)
  const inputScope =
    resolution.anonymousDepth === 1
      ? TypeOutlives.withInputs(
          declaredOutlives,
          declaration.parameters.flatMap((parameter) =>
            parameter.declaredType._tag === 'Resolved' ? [parameter.declaredType.type] : [],
          ),
        )
      : declaredOutlives
  const conditionalScope =
    resolution.invocationExpected === undefined
      ? inputScope
      : TypeOutlives.withInvocationInputs(inputScope, resolution.invocationExpected)
  if (conditionalScope === undefined)
    throw new RangeError('Hidden invocation-use context lost its checked contract')
  const outlivesScope = conditionalScope
  const ordinaryBodyLifetimes = BodyLifetime.make(
    declaration.canonical._tag === 'Canonical'
      ? declaration.canonical.id
      : {
          module: AuthoredWalk.moduleName(semantic),
          name: `#${declaration.id.ordinal}`,
        },
    AuthoredWalk.anchors(blockNode),
    outlivesScope.parameterBounds,
  )
  const conditionalBodyLifetimes =
    resolution.invocationExpected === undefined
      ? ordinaryBodyLifetimes
      : BodyLifetime.withInvocationInputs(ordinaryBodyLifetimes, resolution.invocationExpected)
  if (conditionalBodyLifetimes === undefined)
    throw new RangeError('Hidden invocation-use body lost its checked input coordinates')
  const bodyLifetimes = conditionalBodyLifetimes
  const authoredDeclaration = AuthoredWalk.declarationOf(semantic.module, declaration.owner)
  // Occurrences and hints serve only editors, so a build session never collects them.
  const tooling = resolution.semantic.tooling
  const occurrences = new Map<string, SemanticOccurrence.LocatedOccurrence>()
  const publishOccurrence = (occurrence: SemanticOccurrence.LocatedOccurrence): void => {
    occurrences.set(
      `${AuthoredIdentity.anchorKey(occurrence.at)}\u0000${occurrence.role}`,
      occurrence,
    )
  }
  const bodyResolution: ResolutionContext = {
    ...resolution,
    builder,
    ...(authoredDeclaration === undefined ? {} : { authoredDeclaration }),
    unsafeSpans,
    nextBindingOrdinal,
    executableFunction: declaration.id,
    executableSiteOrdinals,
    ...(declaration.canonical._tag === 'Canonical'
      ? { executableOwner: declaration.canonical.id }
      : {}),
    bodyLifetimes,
    lifetimeCompatibility: BodyLifetime.compatibility(
      bodyLifetimes,
      Lifetime.mergeAssumptions(
        Lifetime.assumptions(
          DeclarationFacts.executableLifetimes(declaration).lifetimeBounds ?? [],
        ),
        outlivesScope.assumptions,
      ),
      NominalVariance.derive(resolution.index).summaries,
    ),
    writtenCallableBindings: new Set<number>(),
    ...(tooling
      ? {
          publishExpressionDecision: (decision: ExpressionDecision) => {
            for (const occurrence of SemanticOccurrence.ofExpressionDecision(
              decision,
              resolution.index,
              resolution.scope,
            ))
              publishOccurrence(occurrence)
          },
        }
      : {}),
    generatedAggregates: new Map(),
    ...(staticContext === undefined ? {} : { staticContext }),
  }
  const context: BodyContext = {
    context: semantic,
    declaration,
    declarations,
    bindings: [],
    diagnostics: [],
    regions: [],
    loops: [],
    staticIterations: [],
    resolution: bodyResolution,
    nextBindingOrdinal,
    ...(staticContext === undefined ? {} : { staticContext }),
    ...(returnType === undefined ? {} : { returnType }),
  }
  context.diagnostics.push(...MachineFunction.bodyDiagnostics(semantic, declaration))
  if (declaration.phase === 'Runtime') {
    const target = staticContext?.environment.target ?? 'unselected-target'
    for (const parameter of declaration.parameters) {
      if (
        parameter.phase === 'Runtime' &&
        parameter.declaredType._tag === 'Resolved' &&
        DeclarationFacts.containsStaticPhaseOnly(
          context.resolution.index,
          parameter.declaredType.type,
        )
      )
        context.diagnostics.push(
          Diagnostic.staticPhaseViolation(
            'runtime parameter with a phase-only type',
            target,
            [],
            Location.at(parameter.anchor),
          ),
        )
    }
    if (
      declaration.returnType._tag === 'Resolved' &&
      DeclarationFacts.containsStaticPhaseOnly(
        context.resolution.index,
        declaration.returnType.type,
      )
    )
      context.diagnostics.push(
        Diagnostic.staticPhaseViolation(
          'runtime return with a phase-only type',
          target,
          [],
          Location.at(declaration.returnType.anchor),
        ),
      )
    for (const failure of declaration.failureRow.members) {
      if (
        failure._tag === 'Resolved' &&
        DeclarationFacts.containsStaticPhaseOnly(context.resolution.index, failure.type)
      )
        context.diagnostics.push(
          Diagnostic.staticPhaseViolation(
            'runtime failure with a phase-only type',
            target,
            [],
            Location.at(failure.anchor),
          ),
        )
    }
  }
  const statements = analyzeStatements(
    context,
    blockNode,
    initialScope ?? { parameters: declaration.parameters, bindings: [], patternBindings: [] },
  )
  const hasDeferredStaticControl =
    staticContext === undefined &&
    AuthoredWalk.statements(blockNode).some(
      (statement) =>
        statement._tag === 'StaticConditionalStatement' || statement._tag === 'StaticForStatement',
    )
  type Terminal = Extract<Tir.Statement, { _tag: 'Return' | 'Fail' }>
  const terminalOf = (body: ReadonlyArray<Tir.Statement>): Terminal | undefined => {
    for (const statement of [...body].reverse()) {
      if (statement._tag === 'Return' || statement._tag === 'Fail') return statement
      if (statement._tag === 'Unsafe') {
        const nested = terminalOf(statement.statements)
        if (nested !== undefined) return nested
      } else if (statement._tag === 'If' || statement._tag === 'IfLet') {
        const nested = terminalOf(statement.otherwise) ?? terminalOf(statement.taken)
        if (nested !== undefined) return nested
      }
    }
    return undefined
  }
  const terminal = terminalOf(statements)
  if (terminal === undefined)
    throw new RangeError('Semantic analysis expected a terminal statement')
  const returnFlow = returnFlowOf(statements)
  const staticEvaluationFailureCodes = new Set<Diagnostic.Code>([
    Diagnostic.staticPhaseViolationCode,
    Diagnostic.selectedCompileErrorCode,
    Diagnostic.staticEvaluationCycleCode,
    Diagnostic.staticStepLimitCode,
    Diagnostic.staticCallDepthLimitCode,
    Diagnostic.staticRetainedValueLimitCode,
    Diagnostic.staticResidualGrowthLimitCode,
  ])
  const hasStaticEvaluationFailure = context.diagnostics.some((diagnostic) =>
    staticEvaluationFailureCodes.has(diagnostic.code),
  )
  let validReturnContract = declaration.returnType._tag === 'Resolved'
  if (declaration.returnType._tag === 'Resolved') {
    for (const returned of returnFlow.returns) {
      const returnedExpression =
        'origin' in returned.expression && returned.expression._tag === 'Unavailable'
          ? (BodyBuilder.semanticOfExpression(builder, returned.expression) ?? returned.expression)
          : returned.expression
      const returnedType = constructionExpressionType(returnedExpression)
      if (returnedType._tag !== 'Available') {
        validReturnContract = false
        continue
      }
      const actual = returnedType.type
      if (
        staticContext?.typeSubstitution === undefined
          ? declaredReturnTypesCompatible(
              semantic,
              declaration,
              returnedExpression,
              bodyResolution?.lifetimeCompatibility,
              builder,
            )
          : typesCompatible(
              actual,
              returnType ?? declaration.returnType.type,
              bodyResolution?.lifetimeCompatibility,
            )
      )
        continue
      validReturnContract = false
      context.diagnostics.push(
        representationJoinDiagnostic(
          returnType ?? declaration.returnType.type,
          actual,
          Location.at(declaration.returnType.anchor),
          Location.at(constructionExpressionAnchor(returned.expression)),
          Location.at(constructionExpressionAnchor(returned.expression)),
        ) ??
          unionConversionDiagnostic(
            actual,
            returnType ?? declaration.returnType.type,
            Location.at(constructionExpressionAnchor(returned.expression)),
            bodyResolution?.lifetimeCompatibility,
          ) ??
          Diagnostic.returnTypeMismatch(
            Type.encode(returnType ?? declaration.returnType.type),
            Type.encode(actual),
            Location.at(constructionExpressionAnchor(returned.expression)),
          ),
      )
    }
    if (
      returnFlow.fallsThrough &&
      !Type.equals(returnType ?? declaration.returnType.type, Type.unit) &&
      !hasDeferredStaticControl &&
      !hasStaticEvaluationFailure
    ) {
      validReturnContract = false
      context.diagnostics.push(
        Diagnostic.missingReturn(
          Type.encode(returnType ?? declaration.returnType.type),
          closingBraceSpan(blockNode),
        ),
      )
    }
  }
  const returnCompatibility = validReturnContract ? compatible : unavailableCompatibility
  const resultRepresentation = validReturnContract
    ? returnSiteEffectJoin(context, declaration, returnFlow.returns)
    : undefined
  const lifetimeFlow = LifetimeFlow.analyze(
    declaration,
    statements,
    bodyLifetimes,
    resolution.index,
    semantic,
    builder,
    outlivesScope,
  )
  context.diagnostics.push(...lifetimeFlow.diagnostics)
  BodyBuilder.finalizeReturns(statements, {
    context: semantic,
    builder,
    lifetimeAssumptions: Lifetime.assumptions(lifetimeFlow.input.constraints),
    ...(bodyResolution.lifetimeCompatibility === undefined
      ? {}
      : { lifetimeCompatibility: bodyResolution.lifetimeCompatibility }),
    ...(returnType === undefined ? {} : { resultType: returnType }),
    ...(declaration.opaqueResult === undefined
      ? {}
      : { opaqueResultFamily: declaration.opaqueResult.family }),
    ...(resultRepresentation === undefined ? {} : { resultRepresentation }),
    functionId: declaration.id,
  })
  if (tooling)
    for (const occurrence of SemanticOccurrence.ofStatements(
      statements,
      resolution.index,
      resolution.scope,
      builder,
    ))
      publishOccurrence(occurrence)
  return {
    fact: {
      _tag: 'FunctionConstruction',
      ...(bodyResolution.lifetimeCompatibility === undefined
        ? {}
        : { comparisonWork: { ...bodyResolution.lifetimeCompatibility.work } }),
      lifetimeFlow,
      declaration,
      statements,
      bindings: [...context.bindings],
      regionOrder: [...context.regions],
      returnedExpression: terminal.expression,
      returnCompatibility,
      ...(resultRepresentation === undefined ? {} : { resultRepresentation }),
      generatedAggregates: [...(bodyResolution.generatedAggregates?.values() ?? [])],
      staticIterations: [...context.staticIterations],
      ...(tooling
        ? {
            tooling: {
              occurrences: [...occurrences.values()],
              hints: TypeHint.rows(context.bindings, statements, builder),
            },
          }
        : {}),
      opaqueEvidence: OpaqueRealization.evidenceOfBody(semantic, declaration, statements, builder),
    },
    diagnostics: [...context.diagnostics],
    builder,
  }
}
