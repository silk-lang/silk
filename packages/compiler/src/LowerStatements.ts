import * as ConcreteCleanup from './ConcreteCleanup.js'
import type { ExitIndex } from './CleanupEmission.js'
import * as CleanupPlan from './CleanupPlan.js'
import {
  authored,
  bindingAt,
  lowerBorrowedWritePlace,
  cleanupForLocal,
  delayedLoopLoans,
  effectContract,
  emitReleases,
  emitInitializationTransition,
  generated,
  initializationFor,
  initializeBinding,
  lowerWriteSelectors,
  lowerOwnershipPath,
  loanEndOperations,
  ownershipLocal,
  ownerFields,
  orderedCleanup,
  prepareInitialization,
  specializedCleanup,
  transitionAt,
  terminalLoopLoanEndings,
  withDelayedFailureLoanEndings,
  withoutLoanEndings,
} from './CleanupEmission.js'
import type { LoweredExpression } from './EffectLowering.js'
import {
  borrowedWriteRoot,
  endLoans,
  endReturnedViewLoans,
  ownedWriteRoot,
  retainedEffectLoans,
  lowerPlacePath,
} from './EffectLowering.js'
import type {} from './EntryAssembly.js'
import type {} from './Forwarding.js'
import {
  callableRecipe,
  delayedEffectState,
  effectRecipe,
  inlineForwardedRequirement,
  movedEffectRecipe,
  restoreDelayedEffectState,
} from './Forwarding.js'
import type { FunctionLowering } from './FunctionLowering.js'
import * as Tir from './Tir.js'
import * as Layout from './Layout.js'
import * as Instances from './Instances.js'
import type { DelayedEffectState } from './Lower.js'
import { borrowKey, i32, patternKey, spanKey } from './Lower.js'
import type {} from './LowerExpression.js'
import {
  copiedValueType,
  lowerExpression,
  lowerExecution,
  lowerPatternTests,
} from './LowerExpression.js'
import * as Match from './Match.js'
import * as Mir from './Mir.js'
import * as MovePath from './MovePath.js'
import * as Ownership from './Ownership.js'
import type * as SourceSpan from './SourceSpan.js'
import * as Type from './Type.js'
import { callableValueType, effectValueForCall, instanceText } from './ValueType.js'

export interface LoweredPatternSelection {
  readonly result: Mir.LocalId
  readonly bindings: ReadonlyArray<Tir.LocalId>
}

/** Each loan's position in its function's ownership facts, grouped by borrow key. */
const loanOrders = new WeakMap<
  ReadonlyArray<Ownership.LoanFact>,
  ReadonlyMap<
    string,
    ReadonlyArray<{ readonly ordinal: number; readonly loan: Ownership.LoanFact }>
  >
>()

const loanOrder = (loans: ReadonlyArray<Ownership.LoanFact>) => {
  const cached = loanOrders.get(loans)
  if (cached !== undefined) return cached
  const order = new Map<
    string,
    Array<{ readonly ordinal: number; readonly loan: Ownership.LoanFact }>
  >()
  for (const [ordinal, loan] of loans.entries()) {
    const key = borrowKey(loan.id)
    const entries = order.get(key)
    if (entries === undefined) order.set(key, [{ ordinal, loan }])
    else entries.push({ ordinal, loan })
  }
  loanOrders.set(loans, order)
  return order
}

export const lowerPatternSelection = (
  fn: FunctionLowering,
  selection: Tir.PatternSelection,
  result: 'Unit' | 'Bool',
): LoweredPatternSelection | 'Transferred' | undefined => {
  if (selection.subject._tag === 'Unavailable') return undefined
  const borrowed = selection.access === 'Shared' || selection.access === 'Exclusive'
  const place = borrowed ? lowerPlacePath(fn, selection.subject) : undefined
  if (place === 'Transferred') return place
  let subject: LoweredExpression | undefined
  if (borrowed) subject = place === undefined ? undefined : { result: place.root }
  else subject = lowerExpression(fn, selection.subject)
  if (subject === 'Transferred') return subject
  const semanticSubject = fn.semantic(selection.subject.type)
  const subjectType = fn.type(selection.subject.type)
  // Statement selections need only one compiler-private branch bit. Keeping that result as bool
  // avoids manufacturing a source-visible unit value and gives both statement forms one lowering.
  const resultSemantic = 'bool' as const
  const resultType = fn.type(resultSemantic)
  if (subject === undefined || subjectType === undefined || resultType === undefined)
    return undefined
  if (selection.members.some((member) => member._tag === 'EnumMember')) return undefined
  const specializeMember = (candidate: Match.CoverageIdentity): Match.CoverageIdentity => {
    if (candidate._tag === 'StructuralTypeMember')
      return Match.structuralMember(fn.semantic(candidate.type))
    if (candidate._tag !== 'NominalUnionVariant') return candidate
    const type = fn.semantic(candidate.type)
    return Type.isNominal(type)
      ? Match.nominalUnionVariant(
          fn.semantic(candidate.root),
          type,
          candidate.variant,
          candidate.variantOrdinal,
        )
      : candidate
  }
  const members = selection.members.map(specializeMember)
  const member = selection.member === undefined ? undefined : specializeMember(selection.member)
  const literal = (value: boolean): LoweredExpression | undefined =>
    lowerExpression(fn, {
      _tag: 'BooleanLiteral' as const,
      value,
      type: 'bool' as const,
      span: selection.span,
      origin: selection.origin,
    })
  const bindingIds = selection.bindings.map((binding) => binding.id)

  if (result === 'Unit' && !selection.irrefutable) return undefined
  const subjectShape = Layout.callingShape(fn.layout, semanticSubject)
  const resultShape = Layout.callingShape(fn.layout, resultSemantic)
  if (subjectShape === undefined || resultShape === undefined) return undefined
  const ownership = fn.ownership?.matches.find((candidate) =>
    Tir.nodeRefEquals(candidate.id.node, selection.id.node),
  )
  const selectedBindings: Array<Mir.MatchBinding> = []
  for (const binding of selection.bindings) {
    const type =
      binding.access === 'Shared' || binding.access === 'Exclusive'
        ? {
            _tag: 'EnvironmentBorrow' as const,
            type: fn.semantic(binding.type),
            access: binding.access,
          }
        : fn.type(binding.type)
    if (type === undefined) return undefined
    const destination = fn.alloc(type)
    fn.patternLocals.set(patternKey(binding.id), destination)
    selectedBindings.push({
      id: binding.id,
      destination,
      path: binding.path,
      type,
      access: binding.access,
      provenance: authored(binding.span),
    })
  }
  const [selectedResult, selectedOperations] = fn.capture(() => literal(true))
  if (selectedResult === undefined || selectedResult === 'Transferred') return selectedResult
  const tests = lowerPatternTests(
    fn,
    semanticSubject,
    member,
    selection.tests ?? [],
    place?.selectors ?? [],
    specializeMember,
  )
  if (tests === undefined) return undefined
  const selectedAfter = Match.cover(
    members,
    [
      {
        ...(member === undefined ? {} : { member }),
        universal: selection.universal,
        guarded: false,
        tests,
      },
    ],
    'Runtime',
  ).missing
  const ownedArm = ownership?.arms.find(
    (candidate) => candidate.id.ordinal === selection.arm.ordinal,
  )
  const finalizedSelectedOperations = [...selectedOperations]
  const cleanup: Array<Mir.MatchArm['selected']['cleanup'][number]> = []
  for (const release of ownedArm?.cleanup ?? []) {
    const plan = specializedCleanup(fn, release.cleanup)
    if (plan._tag === 'NoCleanup') continue
    if (release.path.length === 0 && Type.equals(plan.type, semanticSubject)) {
      finalizedSelectedOperations.push({
        _tag: 'Drop',
        local: subject.result,
        cleanup: plan,
        provenance: authored(selection.span),
      })
      continue
    }
    const type = fn.type(plan.type)
    if (type === undefined) return undefined
    cleanup.push({
      destination: fn.alloc(type),
      path: release.path,
      cleanup: plan,
    })
  }
  const selectedExecution = lowerExecution(fn, selection.span, () => {
    for (const binding of selection.bindings)
      initializeBinding(fn, { _tag: 'Pattern', binding: binding.id }, selection.span)
    for (const operation of finalizedSelectedOperations) fn.emit(operation)
    return selectedResult
  })
  if (selectedExecution === undefined) return undefined
  const selectedArm: Mir.MatchArm = {
    id: selection.arm,
    tests,
    ...(member === undefined ? {} : { member }),
    universal: selection.universal,
    before: members,
    after: selectedAfter,
    bindings: selectedBindings,
    cleanupBindings: [],
    selected: {
      access: selection.access,
      execution: selectedExecution,
      cleanup: cleanup,
      endBorrow: false,
    },
    provenance: authored(selection.span),
  }
  const fallbackId: Match.ArmId = {
    _tag: 'MatchArmId',
    match: selection.id,
    ordinal: 1,
  }
  const fallbackExecution = lowerExecution(fn, selection.span, () => literal(false))
  if (fallbackExecution === undefined) return undefined
  const fallbackArm: Mir.MatchArm = {
    id: fallbackId,
    universal: true,
    before: selectedAfter,
    after: [],
    bindings: [],
    cleanupBindings: [],
    selected: {
      access: selection.access,
      execution: fallbackExecution,
      cleanup: [],
      endBorrow: false,
    },
    provenance: authored(selection.span),
  }
  const needsFallback = result !== 'Unit' && !selection.universal && !selection.irrefutable
  const arms = needsFallback ? [selectedArm, fallbackArm] : [selectedArm]
  const destination = fn.alloc(resultType)
  fn.emit({
    _tag: 'Match' as const,
    id: selection.id,
    destination,
    scrutinee: subject.result,
    ...(place === undefined ? {} : { selectors: place.selectors }),
    scrutineeType: subjectType,
    scrutineeShape: subjectShape,
    access: selection.access,
    retainsBindings: true,
    members,
    decisions: members.map((candidate) => {
      let candidates: ReadonlyArray<Match.ArmId>
      if (selection.universal) {
        candidates = [selection.arm]
      } else if (member === undefined || !Match.selects(member, candidate, 'Runtime')) {
        candidates = [fallbackId]
      } else {
        candidates = needsFallback ? [selection.arm, fallbackId] : [selection.arm]
      }
      return { member: candidate, candidates: candidates }
    }),
    arms,
    type: resultType,
    resultShape,
    provenance: authored(selection.span),
  })
  return { result: destination, bindings: bindingIds }
}

export const lowerSequence = (
  fn: FunctionLowering,
  statements: ReadonlyArray<Tir.Statement>,
  exits: ExitIndex,
  ownerLoop: Mir.LoopId | undefined,
  terminal: Mir.Outcome,
  reserved?: Mir.RegionId,
  armExit?: Ownership.ExitPlan,
): Mir.RegionId | undefined => {
  const id = reserved ?? fn.reserve()
  // Iterative: a sequence is as long as the author wrote it, so its length must not become
  // JavaScript stack depth. Only nested blocks recurse.
  let region = id
  const initialization = prepareInitialization(fn)
  if (initialization.length > 0) {
    region = fn.reserve()
    fn.publish({
      _tag: 'OperationRegion',
      id,
      operations: initialization,
      outcome: {
        _tag: 'Forward',
        target: region,
        provenance: generated(fn.registry.spanOf(fn.owner.function.declaration.anchor)),
      },
    })
  }
  for (const statement of statements) {
    const previousLoop = fn.ownerLoop
    fn.ownerLoop = ownerLoop
    const following = lowerStatement(fn, statement, exits, ownerLoop, terminal, region)
    fn.ownerLoop = previousLoop
    if (following === undefined) {
      fn.recordLoweringFailure('Statement', statement._tag, statement.span)
      return undefined
    }
    if (following === 'Terminated') return id
    region = following
  }
  const [, releases] = fn.capture(() => emitReleases(fn, armExit))
  if (releases.length > 0) {
    fn.publish({
      _tag: 'CleanupRegion',
      id: region,
      ...ownerFields(ownerLoop),
      releases: releases.flatMap((operation) =>
        operation._tag === 'Drop' || operation._tag === 'EndLoan' ? [operation] : [],
      ),
      outcome: terminal,
    })
  } else {
    fn.publish({
      _tag: 'OperationRegion',
      id: region,
      ...ownerFields(ownerLoop),
      operations: [],
      outcome: terminal,
    })
  }
  return id
}

// Drop and expression statements end the loans whose end span is the statement's span. Scanning
// every loan of the function per statement is quadratic in body size, and ownership facts are
// immutable, so each function groups its loans by end span once, keeping ownership order.
const loansByEndSpan = new WeakMap<
  Ownership.FunctionOwnership,
  ReadonlyMap<string, ReadonlyArray<Ownership.LoanFact>>
>()

const loansEndingAt = (
  fn: FunctionLowering,
  span: SourceSpan.SourceSpan,
): ReadonlyArray<Ownership.LoanFact> => {
  if (fn.ownership === undefined) return []
  let index = loansByEndSpan.get(fn.ownership)
  if (index === undefined) {
    const groups = new Map<string, Array<Ownership.LoanFact>>()
    for (const loan of fn.ownership.loans) {
      const key = spanKey(loan.endSpan)
      const group = groups.get(key)
      if (group === undefined) groups.set(key, [loan])
      else group.push(loan)
    }
    index = groups
    loansByEndSpan.set(fn.ownership, index)
  }
  return index.get(spanKey(span)) ?? []
}

/**
 * Lowers one statement into the region `id`. Returns the reserved region the next statement
 * continues into, `'Terminated'` when the statement ends its sequence, or `undefined` when the
 * statement cannot be lowered.
 */
const lowerStatement = (
  fn: FunctionLowering,
  statement: Tir.Statement,
  exits: ExitIndex,
  ownerLoop: Mir.LoopId | undefined,
  terminal: Mir.Outcome,
  id: Mir.RegionId,
): Mir.RegionId | 'Terminated' | undefined => {
  const transferred = (operations: ReadonlyArray<Mir.Operation>): 'Terminated' => {
    fn.publish({
      _tag: 'OperationRegion',
      id,
      ...ownerFields(ownerLoop),
      operations,
      outcome: {
        _tag: 'Trap',
        reason: 'unreachable expression continuation',
        provenance: generated(statement.span),
      },
    })
    return 'Terminated'
  }
  if (statement._tag === 'UnavailableStatement') {
    fn.publish({
      _tag: 'OperationRegion',
      id,
      ...ownerFields(ownerLoop),
      operations: [],
      outcome: {
        _tag: 'Trap',
        reason: 'unavailable statement',
        provenance: generated(statement.span),
      },
    })
    return 'Terminated'
  }

  // A body whose every path already returned still receives a synthesized trailing return, and
  // that implicit statement has no value to elaborate: its expression is `Unavailable`. Lowering
  // it as an ordinary return fails the whole body, and EntryAssembly then replaces the function
  // with a trap stub whose parameters are all fabricated as `i32` — so callers already lowered
  // against the real signature disagree with the declaration. The statement is unreachable by
  // construction, so it lowers exactly like any other unavailable statement: a trap.
  if (
    statement._tag === 'Return' &&
    statement.implicit === true &&
    statement.expression._tag === 'Unavailable'
  ) {
    fn.publish({
      _tag: 'OperationRegion',
      id,
      ...ownerFields(ownerLoop),
      operations: [],
      outcome: {
        _tag: 'Trap',
        reason: 'implicit return is unreachable',
        provenance: generated(statement.span),
      },
    })
    return 'Terminated'
  }

  if (statement._tag === 'Bind') {
    const initializerType =
      'type' in statement.initializer ? fn.semantic(statement.initializer.type) : undefined
    const transferredEffect = movedEffectRecipe(fn, statement.initializer)
    if (
      transferredEffect !== undefined &&
      initializerType !== undefined &&
      Type.isEffect(initializerType)
    ) {
      fn.effectRecipes.delete(transferredEffect.source)
      fn.effectLoanEnds.delete(transferredEffect.source)
      fn.effectRecipes.set(statement.binding.ordinal, transferredEffect.recipe)
      if (transferredEffect.loanEnds.length > 0)
        fn.effectLoanEnds.set(statement.binding.ordinal, transferredEffect.loanEnds)
      const following = fn.reserve()
      fn.publish({
        _tag: 'OperationRegion',
        id,
        ...ownerFields(ownerLoop),
        operations: [],
        outcome: {
          _tag: 'Forward',
          target: following,
          provenance: generated(statement.span),
        },
      })
      return following
    }
    const staticCallable = callableRecipe(fn, statement.initializer)
    const staticCallableType =
      staticCallable === undefined ? undefined : fn.semantic(staticCallable.type)
    let callableSchema: Type.CallableSchema | undefined
    if (staticCallableType !== undefined && Type.isCallable(staticCallableType)) {
      callableSchema = staticCallableType.schema
    } else if (initializerType !== undefined && Type.isCallable(initializerType)) {
      callableSchema = initializerType.schema
    }
    if (
      staticCallable !== undefined &&
      callableSchema !== undefined &&
      (callableSchema.constraints.length > 0 || callableSchema.evidence.length > 0) &&
      callableValueType(fn, staticCallable) === undefined
    ) {
      fn.callableRecipes.set(statement.binding.ordinal, statement.initializer)
      const following = fn.reserve()
      fn.publish({
        _tag: 'OperationRegion',
        id,
        ...ownerFields(ownerLoop),
        operations: [],
        outcome: {
          _tag: 'Forward',
          target: following,
          provenance: generated(statement.span),
        },
      })
      return following
    }
    const forwardedRequirement = inlineForwardedRequirement(fn, statement.initializer)
    const forwardedCall =
      forwardedRequirement === undefined
        ? undefined
        : fn.call(
            statement.initializer,
            undefined,
            statement.initializer._tag === 'EffectConstruct'
              ? statement.initializer.typeArguments.map((argument) => fn.semanticArgument(argument))
              : undefined,
            statement.initializer._tag === 'EffectConstruct'
              ? statement.initializer.staticArguments
              : undefined,
          )
    const forwardedResultEffect = forwardedCall?.resultEffect
    const protectedRecipe =
      forwardedRequirement === undefined
        ? undefined
        : effectRecipe(fn, forwardedRequirement.binding.protected)
    const forwardedSemantic =
      'type' in statement.initializer ? fn.semantic(statement.initializer.type) : undefined
    // A borrowed provider can materialize its service Effect at construction through
    // forwardedServiceProvision. Keeping that value only as a recipe loses it when a
    // later combinator (such as catchAll) consumes the binding as an ordinary operand.
    const forwardedRequirementNeedsRecipe =
      forwardedRequirement !== undefined &&
      (forwardedResultEffect === undefined ||
        forwardedCall === undefined ||
        forwardedSemantic === undefined ||
        !Type.isEffect(forwardedSemantic) ||
        effectValueForCall(fn.layout, forwardedCall, forwardedSemantic, fn.providedRequirements) ===
          undefined ||
        (protectedRecipe?._tag === 'ServiceEffectConstruct' &&
          (forwardedRequirement.selection.access === 'Take' ||
            forwardedRequirement.provider._tag !== 'ValueBorrow')) ||
        protectedRecipe !== forwardedRequirement.binding.protected)
    if (
      forwardedRequirementNeedsRecipe ||
      statement.initializer._tag === 'ServiceEffectConstruct' ||
      (statement.initializer._tag === 'EffectConstruct' &&
        (() => {
          const call = fn.call(
            statement.initializer,
            undefined,
            statement.initializer.typeArguments.map((argument) => fn.semanticArgument(argument)),
            statement.initializer.staticArguments,
          )
          return (
            call?.resultEffect === undefined &&
            fn.effectResults.get(
              call === undefined
                ? instanceText(
                    statement.initializer.target,
                    statement.initializer.typeArguments.map((argument) =>
                      fn.semanticArgument(argument),
                    ),
                    statement.initializer.staticArguments,
                  )
                : Instances.keyText(call.target),
            ) === undefined
          )
        })()) ||
      statement.initializer._tag === 'EffectBindRequirement' ||
      (statement.initializer._tag === 'Match' &&
        effectContract(initializerType ?? 'never') !== undefined) ||
      (statement.initializer._tag === 'BuiltinCall' && Type.isEffect(statement.initializer.type))
    ) {
      fn.effectRecipes.set(statement.binding.ordinal, statement.initializer)
      const following = fn.reserve()
      fn.publish({
        _tag: 'OperationRegion',
        id,
        ...ownerFields(ownerLoop),
        operations: [],
        outcome: {
          _tag: 'Forward',
          target: following,
          provenance: generated(statement.span),
        },
      })
      return following
    }
    const [initializer, operations] = fn.capture(() => {
      const lowered = lowerExpression(fn, statement.initializer)
      if (lowered === 'Transferred') return lowered
      if (lowered === undefined) return undefined
      const sourceType = fn.localTypes.at(lowered.result.ordinal)
      const valueType = sourceType === undefined ? i32 : copiedValueType(fn, sourceType)
      if (valueType === undefined) return undefined
      const destination = fn.alloc(valueType)
      fn.emit({
        _tag: 'Move',
        destination,
        source: lowered.result,
        provenance: authored(statement.span),
      })
      const heldLoans = fn.slotLoans.get(lowered.result.ordinal)
      if (heldLoans !== undefined) {
        fn.slotLoans.delete(lowered.result.ordinal)
        fn.slotLoans.set(destination.ordinal, heldLoans)
      }
      fn.bindingLocals.set(statement.binding.ordinal, destination)
      initializeBinding(fn, { _tag: 'Let', binding: statement.binding }, statement.span)
      const destinationType = fn.localTypes.at(destination.ordinal)
      if (destinationType?._tag === 'EffectValue') {
        const retained = retainedEffectLoans(fn, statement.initializer)
        if (retained.length > 0) fn.effectLoanEnds.set(statement.binding.ordinal, retained)
      }
      return destination
    })
    if (initializer === 'Transferred') return transferred(operations)
    if (initializer === undefined) return undefined
    const following = fn.reserve()
    fn.publish({
      _tag: 'OperationRegion',
      id,
      ...ownerFields(ownerLoop),
      operations,
      outcome: {
        _tag: 'Forward',
        target: following,
        provenance: generated(statement.span),
      },
    })
    return following
  }

  if (statement._tag === 'PatternBind') {
    const [selection, operations] = fn.capture(() =>
      lowerPatternSelection(fn, statement.selection, 'Unit'),
    )
    if (selection === 'Transferred') return transferred(operations)
    if (selection === undefined) return undefined
    const following = fn.reserve()
    fn.publish({
      _tag: 'OperationRegion',
      id,
      ...ownerFields(ownerLoop),
      operations,
      outcome: {
        _tag: 'Forward',
        target: following,
        provenance: generated(statement.span),
      },
    })
    return following
  }

  if (statement._tag === 'Evaluate') {
    const [evaluated, operations] = fn.capture(() => lowerExpression(fn, statement.expression))
    if (evaluated === 'Transferred') return transferred(operations)
    if (evaluated === undefined) return undefined
    const following = fn.reserve()
    fn.publish({
      _tag: 'OperationRegion',
      id,
      ...ownerFields(ownerLoop),
      operations,
      outcome: {
        _tag: 'Forward',
        target: following,
        provenance: generated(statement.span),
      },
    })
    return following
  }

  if (statement._tag === 'Write') {
    const place = statement.place
    let transitionRoot: Ownership.BindingSite | undefined
    if (place._tag === 'WritePlace') {
      if (place.root._tag === 'ParameterWriteRoot')
        transitionRoot = { _tag: 'Parameter', parameter: place.root.parameter }
      else if (place.root._tag === 'PatternWriteRoot')
        transitionRoot = { _tag: 'Pattern', binding: place.root.binding }
      else transitionRoot = { _tag: 'Let', binding: place.root.binding }
    }
    const transition = transitionAt(fn, statement.span, 'Write', transitionRoot)
    let root: Mir.LocalId | undefined
    if (place._tag === 'BorrowedWritePlace') root = borrowedWriteRoot(fn, place.root)
    else if (transition !== undefined) root = ownershipLocal(fn, transition.root)
    else root = ownedWriteRoot(fn, place.root)
    let rootType = root === undefined ? undefined : fn.localTypes.at(root.ordinal)
    // A whole callable binding keeps its exact representation; the written value carries the same
    // identity once analysis admitted the write.
    const type =
      fn.type(place.type) ??
      (rootType?._tag === 'CallableValue' && place.selectors.length === 0 ? rootType : undefined)
    const [written, operations] = fn.capture(() => {
      if (root === undefined || rootType === undefined || type === undefined) return false
      let selectors: ReadonlyArray<Mir.PlaceSelector> | 'Transferred' | undefined
      if (place._tag === 'BorrowedWritePlace') {
        const lowered = lowerBorrowedWritePlace(fn, root, place.selectors, place.type, place.span)
        if (lowered === 'Transferred') return lowered
        if (lowered === undefined) return false
        root = lowered.root
        selectors = lowered.selectors
      } else if (transition !== undefined)
        selectors = lowerOwnershipPath(fn, root, transition.path, place.span)
      else selectors = lowerWriteSelectors(fn, place.selectors)
      if (selectors === 'Transferred') return selectors
      if (selectors === undefined) return false
      rootType = fn.localTypes.at(root.ordinal)
      if (rootType === undefined) return false
      fn.emit({
        _tag: 'CheckPlace',
        root,
        selectors,
        type,
        provenance: authored(place.span),
      })
      const value = lowerExpression(fn, statement.value)
      if (value === 'Transferred') return value
      if (value === undefined) return false
      // A live displaced value leaves the place as the replacement commits (the verifier pairs
      // a consuming read with its write), then cleans exactly once through its own plan.
      const replacement = fn.ownership?.replacements.find(
        (candidate) =>
          candidate.span.start === statement.span.start &&
          candidate.span.end === statement.span.end,
      )
      const displacedCleanup =
        replacement === undefined ? undefined : cleanupForLocal(fn, replacement.cleanup, type)
      if (place._tag === 'WritePlace' && displacedCleanup !== undefined) {
        const initialization =
          replacement === undefined || transition === undefined
            ? undefined
            : initializationFor(fn, transition.root, replacement.initialization, transition.path)
        fn.emit({
          _tag: 'Drop',
          local: root,
          selectors,
          cleanup: displacedCleanup,
          ...(initialization === undefined ? {} : { initialization }),
          provenance: authored(statement.span),
        })
      }
      const displaced =
        place._tag === 'BorrowedWritePlace' &&
        displacedCleanup !== undefined &&
        CleanupPlan.hasEffect(displacedCleanup)
          ? fn.alloc(type)
          : undefined
      if (displaced !== undefined) {
        fn.emit({
          _tag: 'ReadPlace',
          destination: displaced,
          root,
          selectors,
          type,
          consume: true,
          provenance: authored(statement.span),
        })
      }
      fn.emit({
        _tag: 'WritePlace',
        root,
        selectors,
        source: value.result,
        rootType,
        type,
        mutable: true,
        replacement: Mir.isCopy(fn.layout, fn.semantic(statement.place.type)) ? 'Copy' : 'Owned',
        commit: 'AfterCleanup',
        provenance: authored(statement.span),
      })
      if (displaced !== undefined && displacedCleanup !== undefined) {
        fn.emit({
          _tag: 'Drop',
          local: displaced,
          cleanup: displacedCleanup,
          provenance: authored(statement.span),
        })
      }
      if (transition !== undefined) emitInitializationTransition(fn, transition)
      endReturnedViewLoans(fn, statement.span)
      return true
    })
    if (written === 'Transferred') return transferred(operations)
    if (!written) return undefined
    const following = fn.reserve()
    fn.publish({
      _tag: 'OperationRegion',
      id,
      ...ownerFields(ownerLoop),
      operations,
      outcome: {
        _tag: 'Forward',
        target: following,
        provenance: generated(statement.span),
      },
    })
    return following
  }

  if (statement._tag === 'Drop') {
    const transition = transitionAt(
      fn,
      statement.span,
      'Drop',
      Ownership.placeOf(statement.expression)?.root,
    )
    if (transition !== undefined && ownershipLocal(fn, transition.root) !== undefined) {
      const root = ownershipLocal(fn, transition.root)
      let type: Mir.Type | undefined
      if (transition.path.length === 0 && root !== undefined) type = fn.localTypes.at(root.ordinal)
      else if ('type' in statement.expression) type = fn.type(statement.expression.type)
      if (root === undefined || type === undefined) return undefined
      const selectors = lowerOwnershipPath(fn, root, transition.path, statement.span)
      if (selectors === undefined) return undefined
      let selected = transition.before
      for (const selector of transition.path)
        selected =
          selected.children.find(
            (child) => MovePath.key([child.selector]) === MovePath.key([selector]),
          )?.state ?? MovePath.make(selected.initialization)
      const initialization = initializationFor(fn, transition.root, selected, transition.path)
      const [, operations] = fn.capture(() => {
        const authoredEndings = loansEndingAt(fn, statement.span).map((loan) => loan.id)
        const retainedEndings =
          transition.root._tag === 'Let' && transition.path.length === 0
            ? (fn.effectLoanEnds.get(transition.root.binding.ordinal) ?? [])
            : []
        endLoans(fn, [...authoredEndings, ...retainedEndings], statement.span)
        if (transition.root._tag === 'Let' && transition.path.length === 0)
          fn.effectLoanEnds.delete(transition.root.binding.ordinal)
        fn.emit({
          _tag: 'Drop',
          local: root,
          selectors,
          cleanup: cleanupForLocal(fn, ConcreteCleanup.forType(fn, Mir.semanticType(type)), type),
          ...(initialization === undefined ? {} : { initialization }),
          provenance: authored(statement.span),
        })
        emitInitializationTransition(fn, transition)
        endReturnedViewLoans(fn, statement.span)
      })
      const following = fn.reserve()
      fn.publish({
        _tag: 'OperationRegion',
        id,
        ...ownerFields(ownerLoop),
        operations,
        outcome: { _tag: 'Forward', target: following, provenance: generated(statement.span) },
      })
      return following
    }
    const droppedExpression =
      statement.expression._tag === 'Move' ? statement.expression.subject : statement.expression
    const droppedRecipe = callableRecipe(fn, droppedExpression)
    const droppedRecipeType =
      droppedRecipe === undefined ? undefined : fn.semantic(droppedRecipe.type)
    if (
      droppedRecipeType !== undefined &&
      Type.isCallable(droppedRecipeType) &&
      droppedRecipeType.schema !== undefined &&
      (droppedRecipeType.schema.constraints.length > 0 ||
        droppedRecipeType.schema.evidence.length > 0)
    ) {
      if (droppedExpression._tag === 'BindingReference')
        fn.callableRecipes.delete(droppedExpression.binding.ordinal)
      const following = fn.reserve()
      fn.publish({
        _tag: 'OperationRegion',
        id,
        ...ownerFields(ownerLoop),
        operations: [],
        outcome: {
          _tag: 'Forward',
          target: following,
          provenance: generated(statement.span),
        },
      })
      return following
    }
    const [lowered, operations] = fn.capture(() => lowerExpression(fn, statement.expression))
    if (lowered === 'Transferred') return transferred(operations)
    if (lowered === undefined) return undefined
    const localType = fn.localTypes.at(lowered.result.ordinal)
    if (localType === undefined) return undefined
    const droppedBinding =
      droppedExpression._tag === 'BindingReference' ? droppedExpression.binding.ordinal : undefined
    const bindingFact =
      droppedBinding !== undefined
        ? bindingAt(fn, { _tag: 'Let', binding: { _tag: 'TirLocal', ordinal: droppedBinding } })
        : undefined
    const ownershipLoanReleases = loansEndingAt(fn, statement.span).flatMap((loan) => {
      const slice = fn.loanLocals.get(borrowKey(loan.id))
      if (slice === undefined) return []
      fn.loanLocals.delete(borrowKey(loan.id))
      return [
        {
          _tag: 'EndLoan' as const,
          borrow: loan.id,
          slice,
          provenance: generated(statement.span),
        },
      ]
    })
    const retainedLoanReleases = (
      droppedBinding === undefined ? [] : (fn.effectLoanEnds.get(droppedBinding) ?? [])
    ).flatMap((borrow) => {
      const slice = fn.loanLocals.get(borrowKey(borrow))
      if (slice === undefined) return []
      fn.loanLocals.delete(borrowKey(borrow))
      return [
        {
          _tag: 'EndLoan' as const,
          borrow,
          slice,
          provenance: generated(statement.span),
        },
      ]
    })
    if (droppedBinding !== undefined) fn.effectLoanEnds.delete(droppedBinding)
    const loanReleases = [...ownershipLoanReleases, ...retainedLoanReleases].filter(
      (release, ordinal, releases) =>
        releases.findIndex(
          (candidate) => borrowKey(candidate.borrow) === borrowKey(release.borrow),
        ) === ordinal,
    )
    const cleanup = fn.reserve()
    const following = fn.reserve()
    fn.publish({
      _tag: 'OperationRegion',
      id,
      ...ownerFields(ownerLoop),
      operations,
      outcome: {
        _tag: 'Forward',
        target: cleanup,
        provenance: generated(statement.span),
      },
    })
    fn.publish({
      _tag: 'CleanupRegion',
      id: cleanup,
      ...ownerFields(ownerLoop),
      releases: [
        ...loanReleases,
        {
          _tag: 'Drop',
          local: lowered.result,
          cleanup: cleanupForLocal(
            fn,
            bindingFact === undefined
              ? ConcreteCleanup.forType(fn, Mir.semanticType(localType))
              : bindingFact.cleanup,
            localType,
          ),
          provenance: authored(statement.span),
        },
      ],
      outcome: {
        _tag: 'Forward',
        target: following,
        provenance: generated(statement.span),
      },
    })
    return following
  }

  if (statement._tag === 'Unsafe') {
    const body = fn.reserve()
    const following = fn.reserve()
    fn.publish({
      _tag: 'OperationRegion',
      id,
      ...ownerFields(ownerLoop),
      operations: [],
      outcome: {
        _tag: 'Forward',
        target: body,
        provenance: authored(statement.span),
      },
    })
    const forward = {
      _tag: 'Forward' as const,
      target: following,
      provenance: generated(statement.span),
    }
    if (
      lowerSequence(
        fn,
        statement.statements,
        exits,
        ownerLoop,
        forward,
        body,
        exits.scopeEnds.get(spanKey(statement.span)),
      ) === undefined
    )
      return undefined
    return following
  }

  if (statement._tag === 'If' || statement._tag === 'IfLet') {
    const [condition, operations] = fn.capture(() =>
      statement._tag === 'If'
        ? lowerExpression(fn, statement.condition)
        : lowerPatternSelection(fn, statement.selection, 'Bool'),
    )
    if (condition === 'Transferred') return transferred(operations)
    if (condition === undefined) return undefined
    const conditional = fn.reserve()
    const taken = fn.reserve()
    const otherwise = fn.reserve()
    const following = fn.reserve()
    fn.publish({
      _tag: 'OperationRegion',
      id,
      ...ownerFields(ownerLoop),
      operations,
      outcome: {
        _tag: 'Forward',
        target: conditional,
        provenance: generated(statement.span),
      },
    })
    fn.publish({
      _tag: 'ConditionalRegion',
      id: conditional,
      ...ownerFields(ownerLoop),
      condition: condition.result,
      taken,
      otherwise,
      following,
      provenance: authored(statement.span),
    })
    const branchState = delayedEffectState(fn)
    const beforeTaken = fn.regionMark()
    const loweredTaken = lowerSequence(
      fn,
      statement.taken,
      exits,
      ownerLoop,
      {
        _tag: 'Forward',
        target: following,
        provenance: generated(statement.span),
      },
      taken,
      exits.armEnds.get(`${spanKey(statement.span)}:Taken`),
    )
    if (loweredTaken === undefined) return undefined
    const takenState = delayedEffectState(fn)
    const takenRegions = fn.regionsPublishedSince(beforeTaken)
    if (statement._tag === 'IfLet')
      for (const binding of statement.selection.bindings)
        fn.patternLocals.delete(patternKey(binding.id))
    restoreDelayedEffectState(fn, branchState)
    const beforeOtherwise = fn.regionMark()
    const loweredOtherwise = lowerSequence(
      fn,
      statement.otherwise,
      exits,
      ownerLoop,
      {
        _tag: 'Forward',
        target: following,
        provenance: generated(statement.span),
      },
      otherwise,
      exits.armEnds.get(`${spanKey(statement.span)}:Otherwise`),
    )
    if (loweredOtherwise === undefined) return undefined
    const otherwiseState = delayedEffectState(fn)
    const otherwiseRegions = fn.regionsPublishedSince(beforeOtherwise)
    restoreDelayedEffectState(fn, branchState)
    // Only loans held by one branch end, in the function's loan order. Visiting the held set
    // keeps each conditional proportional to its live loans rather than to every loan issued
    // anywhere in the function.
    const branchEndings = (
      state: DelayedEffectState,
      other: DelayedEffectState,
    ): ReadonlyArray<Extract<Mir.Operation, { readonly _tag: 'EndLoan' }>> => {
      const order = loanOrder(fn.ownership?.loans ?? [])
      const ending: Array<{ readonly ordinal: number; readonly loan: Ownership.LoanFact }> = []
      for (const key of state.loanLocals.keys())
        if (!other.loanLocals.has(key)) ending.push(...(order.get(key) ?? []))
      return ending
        .sort((left, right) => left.ordinal - right.ordinal)
        .flatMap(({ loan }) => {
          const held = state.loanLocals.get(borrowKey(loan.id))
          return held === undefined
            ? []
            : [
                {
                  _tag: 'EndLoan' as const,
                  borrow: loan.id,
                  slice: held,
                  provenance: generated(statement.span),
                },
              ]
        })
    }
    const takenEndings = branchEndings(takenState, otherwiseState).flatMap((ending) =>
      loanEndOperations(fn, ending),
    )
    const otherwiseEndings = branchEndings(otherwiseState, takenState).flatMap((ending) =>
      loanEndOperations(fn, ending),
    )
    for (const key of branchState.loanLocals.keys()) {
      if (!takenState.loanLocals.has(key) || !otherwiseState.loanLocals.has(key))
        fn.loanLocals.delete(key)
    }
    for (const [regions, releases] of [
      [takenRegions, takenEndings],
      [otherwiseRegions, otherwiseEndings],
    ] as const)
      if (releases.length > 0) {
        const branchEnd = fn.reserve()
        for (const ordinal of regions) {
          const region = fn.regions.at(ordinal)
          if (
            region === undefined ||
            (region._tag !== 'OperationRegion' && region._tag !== 'CleanupRegion') ||
            region.outcome._tag !== 'Forward' ||
            region.outcome.target.ordinal !== following.ordinal
          )
            continue
          fn.regions[ordinal] = {
            ...region,
            outcome: { ...region.outcome, target: branchEnd },
          }
        }
        fn.publish({
          _tag: 'CleanupRegion',
          id: branchEnd,
          ...ownerFields(ownerLoop),
          releases,
          outcome: {
            _tag: 'Forward',
            target: following,
            provenance: generated(statement.span),
          },
        })
      }
    return following
  }

  if (statement._tag === 'While') {
    const loop: Mir.LoopId = { _tag: 'Loop', ordinal: statement.loop.ordinal }
    const entryState = delayedEffectState(fn)
    const [condition, conditionOperations] = fn.capture(() =>
      lowerExpression(fn, statement.condition),
    )
    if (condition === 'Transferred') return transferred(conditionOperations)
    if (condition === undefined) return undefined
    const conditionId = fn.reserve()
    const bodyId = fn.reserve()
    const following = fn.reserve()
    fn.publish({
      _tag: 'LoopRegion',
      id,
      ...ownerFields(ownerLoop),
      loop,
      ...(ownerLoop === undefined ? {} : { parent: ownerLoop }),
      condition: conditionId,
      conditionValue: condition.result,
      body: bodyId,
      following,
      provenance: authored(statement.span),
    })
    fn.publish({
      _tag: 'OperationRegion',
      id: conditionId,
      ownerLoop: loop,
      operations: conditionOperations,
      outcome: { _tag: 'Yield', provenance: generated(statement.span) },
    })
    const repeat = {
      _tag: 'Repeat' as const,
      loop,
      provenance: generated(statement.span),
    }
    const loopState = delayedEffectState(fn)
    const loweredBody = lowerSequence(
      fn,
      statement.body,
      exits,
      loop,
      repeat,
      bodyId,
      exits.loopFallthroughs.get(statement.loop.ordinal),
    )
    if (loweredBody === undefined) return undefined
    const bodyState = delayedEffectState(fn)
    const delayedLoanKeys = new Set(
      [...entryState.loanLocals.keys()].filter((key) => {
        const loan = fn.ownership?.loans.find((candidate) => borrowKey(candidate.id) === key)
        // A terminal body path does not end a destructor's loan on the condition-false path.
        if (loan?.cleanupOnly && loan.endSpan.end > statement.span.end) return false
        return !loopState.loanLocals.has(key) || !bodyState.loanLocals.has(key)
      }),
    )
    const delayedLoans = delayedLoopLoans(fn, delayedLoanKeys, entryState)
    const delayedOwners = new Set(
      [...delayedLoanKeys].flatMap((key) => {
        const owner = fn.temporaryBorrowOwners.get(key)
        return owner === undefined ? [] : [owner.local.ordinal]
      }),
    )
    if (delayedLoanKeys.size > 0) {
      const loopFamily = new Set<number>([loop.ordinal])
      let changed = true
      while (changed) {
        changed = false
        for (const region of fn.regions) {
          if (
            region?._tag !== 'LoopRegion' ||
            region.parent === undefined ||
            !loopFamily.has(region.parent.ordinal) ||
            loopFamily.has(region.loop.ordinal)
          )
            continue
          loopFamily.add(region.loop.ordinal)
          changed = true
        }
      }
      for (const region of fn.regions) {
        if (region === undefined || !loopFamily.has(region.ownerLoop?.ordinal ?? -1)) continue
        if (region._tag === 'OperationRegion') {
          const operations = withDelayedFailureLoanEndings(
            fn,
            withoutLoanEndings(region.operations, delayedLoanKeys, delayedOwners),
            delayedLoans,
          )
          const terminalEndings =
            region.outcome._tag === 'Return' || region.outcome._tag === 'Trap'
              ? terminalLoopLoanEndings(fn, delayedLoans, region.outcome)
              : []
          fn.regions[region.id.ordinal] = {
            ...region,
            operations: [...operations, ...terminalEndings],
          }
        } else if (region._tag === 'CleanupRegion') {
          const releases = withoutLoanEndings(
            region.releases,
            delayedLoanKeys,
            delayedOwners,
          ).flatMap((release) =>
            release._tag === 'Drop' || release._tag === 'EndLoan' ? [release] : [],
          )
          const terminalEndings =
            region.outcome._tag === 'Return' || region.outcome._tag === 'Trap'
              ? terminalLoopLoanEndings(fn, delayedLoans, region.outcome)
              : []
          fn.regions[region.id.ordinal] = {
            ...region,
            releases: orderedCleanup(fn, [...terminalEndings, ...releases]),
          }
        }
      }
    }
    restoreDelayedEffectState(fn, loopState)
    for (const key of delayedLoanKeys) {
      const held = entryState.loanLocals.get(key)
      if (held !== undefined) fn.loanLocals.set(key, held)
    }
    const continuation = delayedLoans.length === 0 ? following : fn.reserve()
    if (delayedLoans.length > 0) {
      const [, releases] = fn.capture(() => {
        for (const loan of delayedLoans) {
          const slice = fn.loanLocals.get(loan.key)
          if (slice === undefined) continue
          fn.emit({
            _tag: 'EndLoan',
            borrow: loan.borrow,
            slice,
            provenance: generated(statement.span),
          })
          fn.loanLocals.delete(loan.key)
        }
      })
      fn.publish({
        _tag: 'CleanupRegion',
        id: following,
        ...ownerFields(ownerLoop),
        releases: releases.flatMap((operation) =>
          operation._tag === 'Drop' || operation._tag === 'EndLoan' ? [operation] : [],
        ),
        outcome: {
          _tag: 'Forward',
          target: continuation,
          provenance: generated(statement.span),
        },
      })
    }
    return continuation
  }

  if (statement._tag === 'Break' || statement._tag === 'Continue') {
    const target: Mir.LoopId = { _tag: 'Loop', ordinal: statement.target.ordinal }
    const outcome: Mir.Outcome = {
      _tag: statement._tag === 'Break' ? ('Exit' as const) : ('Repeat' as const),
      loop: target,
      provenance: authored(statement.span),
    }
    const [, releases] = fn.capture(() =>
      emitReleases(fn, exits.transfers.get(spanKey(statement.span))),
    )
    if (releases.length === 0) {
      fn.publish({
        _tag: 'OperationRegion',
        id,
        ...ownerFields(ownerLoop),
        operations: [],
        outcome,
      })
    } else {
      const cleanup = fn.reserve()
      fn.publish({
        _tag: 'OperationRegion',
        id,
        ...ownerFields(ownerLoop),
        operations: [],
        outcome: {
          _tag: 'Forward',
          target: cleanup,
          provenance: generated(statement.span),
        },
      })
      fn.publish({
        _tag: 'CleanupRegion',
        id: cleanup,
        ...ownerFields(ownerLoop),
        releases: releases.flatMap((operation) =>
          operation._tag === 'Drop' || operation._tag === 'EndLoan' ? [operation] : [],
        ),
        outcome,
      })
    }
    return 'Terminated'
  }

  if (statement._tag === 'Fail') {
    const specializedFailure = fn.semantic(statement.failure)
    const [failedValue, operations] = fn.capture(() => {
      const failed = lowerExpression(fn, statement.expression)
      if (failed === 'Transferred') return failed
      if (failed !== undefined && Type.isNever(specializedFailure)) return 'Transferred'
      const outcomeType = fn.effectOutcome === undefined ? undefined : fn.type(fn.effectOutcome)
      if (failed === undefined || outcomeType?._tag !== 'EffectOutcome') return undefined
      const destination = fn.alloc(outcomeType)
      if (!Type.isUnion(specializedFailure)) {
        const tag = Type.failureMembers(outcomeType.type).findIndex(
          (failure) => Type.runtimeKey(failure) === Type.runtimeKey(specializedFailure),
        )
        if (tag < 0) return undefined
        fn.emit({
          _tag: 'PackEffectOutcome' as const,
          destination,
          source: failed.result,
          tag: tag + 1,
          type: outcomeType,
          provenance: authored(statement.span),
        })
      } else {
        const sourceType = fn.type(specializedFailure)
        if (sourceType?._tag !== 'Union') return undefined
        const mappings = specializedFailure.members.flatMap((member, source) => {
          const target = Type.failureMembers(outcomeType.type).findIndex(
            (failure) => Type.runtimeKey(failure) === Type.runtimeKey(member),
          )
          return target < 0 ? [] : [{ source, target: target + 1 }]
        })
        if (mappings.length !== specializedFailure.members.length) return undefined
        fn.emit({
          _tag: 'PackEffectFailureUnion' as const,
          destination,
          source: failed.result,
          sourceType,
          mappings: mappings,
          type: outcomeType,
          provenance: authored(statement.span),
        })
      }
      return destination
    })
    if (failedValue === 'Transferred') return transferred(operations)
    if (failedValue === undefined) return undefined
    const failureOutcome: Mir.Outcome = {
      _tag: 'Return',
      value: failedValue,
      provenance: authored(statement.span),
    }
    const [, releases] = fn.capture(() =>
      emitReleases(fn, exits.returns.get(spanKey(statement.span))),
    )
    if (releases.length === 0) {
      fn.publish({
        _tag: 'OperationRegion',
        id,
        ...ownerFields(ownerLoop),
        operations,
        outcome: failureOutcome,
      })
    } else {
      const cleanup = fn.reserve()
      fn.publish({
        _tag: 'OperationRegion',
        id,
        ...ownerFields(ownerLoop),
        operations,
        outcome: {
          _tag: 'Forward',
          target: cleanup,
          provenance: generated(statement.span),
        },
      })
      fn.publish({
        _tag: 'CleanupRegion',
        id: cleanup,
        ...ownerFields(ownerLoop),
        releases: releases.flatMap((operation) =>
          operation._tag === 'Drop' || operation._tag === 'EndLoan' ? [operation] : [],
        ),
        outcome: failureOutcome,
      })
    }
    return 'Terminated'
  }

  const [returnedValue, operations] = fn.capture(() => {
    const returned = lowerExpression(fn, statement.expression)
    if (returned === 'Transferred') return returned
    if (returned === undefined) return undefined
    if (fn.effectOutcome === undefined) return returned.result
    const outcomeType = fn.type(fn.effectOutcome)
    if (outcomeType?._tag !== 'EffectOutcome') return undefined
    const destination = fn.alloc(outcomeType)
    fn.emit({
      _tag: 'PackEffectOutcome',
      destination,
      source: returned.result,
      tag: 0,
      type: outcomeType,
      provenance: authored(statement.span),
    })
    return destination
  })
  if (returnedValue === 'Transferred') return transferred(operations)
  if (returnedValue === undefined) return undefined
  const [, releases] = fn.capture(() =>
    emitReleases(fn, exits.returns.get(spanKey(statement.span))),
  )
  const returnedType = fn.localTypes.at(returnedValue.ordinal)
  // A Copy read produces its return value before scope cleanup ends the source local's storage.
  const copyBeforeCleanup =
    returnedType !== undefined &&
    Mir.isCopy(fn.layout, Mir.semanticType(returnedType)) &&
    releases.some(
      (operation) => operation._tag === 'Drop' && operation.local.ordinal === returnedValue.ordinal,
    )
  const result = copyBeforeCleanup ? fn.alloc(returnedType) : returnedValue
  const returnOperations = copyBeforeCleanup
    ? [
        ...operations,
        {
          _tag: 'Move' as const,
          destination: result,
          source: returnedValue,
          provenance: authored(statement.span),
        },
      ]
    : operations
  const returnOutcome: Mir.Outcome = {
    _tag: 'Return',
    value: result,
    provenance: authored(statement.span),
  }
  if (releases.length === 0) {
    fn.publish({
      _tag: 'OperationRegion',
      id,
      ...ownerFields(ownerLoop),
      operations: returnOperations,
      outcome: returnOutcome,
    })
  } else {
    const cleanup = fn.reserve()
    fn.publish({
      _tag: 'OperationRegion',
      id,
      ...ownerFields(ownerLoop),
      operations: returnOperations,
      outcome: {
        _tag: 'Forward',
        target: cleanup,
        provenance: generated(statement.span),
      },
    })
    fn.publish({
      _tag: 'CleanupRegion',
      id: cleanup,
      ...ownerFields(ownerLoop),
      releases: releases.flatMap((operation) =>
        operation._tag === 'Drop' || operation._tag === 'EndLoan' ? [operation] : [],
      ),
      outcome: returnOutcome,
    })
  }
  return 'Terminated'
}
