import * as AuthoredIdentity from './AuthoredIdentity.js'
import * as Mir from './Mir.js'
import * as MirNormalization from './MirNormalization.js'
import * as ExecutableInputView from './ExecutableInputView.js'
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as CompilerTrace from './CompilerTrace.js'
import * as SuspensionMir from './SuspensionMir.js'
import * as CoroutineFrame from './CoroutineFrame.js'
import * as NativeAssembly from './NativeAssembly.js'
import * as MirInitialization from './MirInitialization.js'
import * as MovePath from './MovePath.js'
import * as Lifetime from './Lifetime.js'
import * as CAbi from './CAbi.js'
import type * as CleanupPlan from './CleanupPlan.js'
import * as DeclarationFacts from './DeclarationFacts.js'
import * as ExecutionPackage from './ExecutionPackage.js'
import * as ExecutionTransition from './ExecutionTransition.js'
import * as EffectExecutionContract from './internal/EffectExecutionContract.js'
import * as Tir from './Tir.js'
import * as Instances from './Instances.js'
import * as Layout from './Layout.js'
import * as LayoutVerify from './LayoutVerify.js'
import * as LocalSharedControlBlock from './LocalSharedControlBlock.js'
import * as LocalSharedPayloadCleanup from './LocalSharedPayloadCleanup.js'
import * as Match from './Match.js'
import type {
  CleanupRegion,
  CancellationFinalizer,
  Execution,
  CoroutineFrameRelease,
  EndLoanOperation,
  LocalId,
  LoopId,
  LoopRegion,
  MatchArm,
  MatchOperation,
  MirFunction,
  Module,
  Operation,
  OperationRegion,
  Outcome,
  PlaceSelector,
  Region,
  RegionId,
  Type,
  Violation,
} from './Mir.js'
import {
  acceptsRuntimeOperand,
  callArgumentCompatible,
  executionArgumentCompatible,
  coroutineFrameHeaderRoles,
  diagnosticScopeWords,
  diagnosticOutcomeWords,
  diagnosticOutcomeLocals,
  diagnosticScopeLocals,
  borrowsDescriptor,
  callingShapeEquals,
  executionOperations,
  regionsTree,
  conformanceWitnessMatches,
  isCopy,
  matchesEffectInstance,
  matchesCall,
  matchesInstance,
  matchesInstanceKey,
  runtimeArgumentsEqual,
  operationChildren,
  operationsOf,
  operationTree,
  realizesReturn,
  regionTargets,
  semanticType,
  suspensionLocals,
  topologicalRegions,
  typeText,
} from './Mir.js'
import * as RepresentationField from './RepresentationField.js'
import * as Scalar from './Scalar.js'
import type * as SourceSpan from './SourceSpan.js'
import * as StaticValue from './StaticValue.js'
import type {
  SuspensionBorrowIdentity,
  SuspensionPointId,
  SuspensionProviderArgument,
  SuspensionRunner,
} from './Suspension.js'
import * as SilkType from './Type.js'
import * as TypeCompatibility from './TypeCompatibility.js'

type LoanPathState = 'Dormant' | 'Live' | 'Ended'

interface StructuredCfgPathSemantics<State> {
  readonly initial: ReadonlySet<State>
  readonly before?: (operation: Operation, incoming: ReadonlySet<State>) => ReadonlySet<State>
  readonly after?: (operation: Operation, incoming: ReadonlySet<State>) => ReadonlySet<State>
  readonly enterArm?: (arm: MatchArm, incoming: ReadonlySet<State>) => ReadonlySet<State>
  readonly select?: (
    operation: MatchOperation,
    member: Match.CoverageIdentity,
    incoming: ReadonlySet<State>,
  ) => ReadonlySet<State>
  readonly transfer: (operation: Operation, incoming: ReadonlySet<State>) => ReadonlySet<State>
  readonly terminal: (states: ReadonlySet<State>, outcome?: Outcome) => void
  readonly repeat: (states: ReadonlySet<State>) => ReadonlySet<State>
  readonly merge: (...groups: ReadonlyArray<ReadonlySet<State>>) => ReadonlySet<State>
}

/**
 * Evaluates one finite-state path analysis over every structured MIR control-flow edge. The state
 * semantics remain analysis-owned; branching, guarded matches, loop routing, and terminal failure
 * paths are defined once so validators cannot disagree about reachable paths.
 */
const structuredCfgPathsValid = <State>(
  fn: MirFunction,
  byId: ReadonlyMap<number, Region>,
  loops: ReadonlyMap<number, LoopRegion>,
  semantics: StructuredCfgPathSemantics<State>,
): boolean => {
  let valid = true
  const sequence = (
    operations: ReadonlyArray<Operation>,
    incoming: ReadonlySet<State>,
  ): ReadonlySet<State> => {
    let states = incoming
    for (const operation of operations) {
      states = transfer(operation, states)
      states = semantics.after?.(operation, states) ?? states
    }
    return states
  }
  const execution = (value: Execution, initial: ReadonlySet<State>): ReadonlySet<State> => {
    const regions = new Map(value.regions.map((region) => [region.id.ordinal, region] as const))
    const states = new Map<number, Set<State>>()
    const pending: Array<number> = []
    const completed = new Set<State>()
    const add = (target: RegionId, values: ReadonlySet<State>): void => {
      if (values.size === 0) return
      if (!regions.has(target.ordinal)) {
        enqueue(target, values)
        return
      }
      const existing = states.get(target.ordinal) ?? new Set<State>()
      const size = existing.size
      for (const value of values) existing.add(value)
      states.set(target.ordinal, existing)
      if (existing.size !== size) pending.push(target.ordinal)
    }
    add(value.entry, initial)
    while (pending.length > 0) {
      const ordinal = pending.shift()
      if (ordinal === undefined) continue
      const region = regions.get(ordinal)
      const incoming = states.get(ordinal)
      if (region === undefined || incoming === undefined) continue
      if (region._tag === 'ConditionalRegion') {
        add(region.taken, incoming)
        add(region.otherwise, incoming)
        continue
      }
      if (region._tag === 'LoopRegion') {
        add(region.condition, incoming)
        continue
      }
      const result = sequence(operationsOf(region), incoming)
      const outcome = region.outcome
      if (outcome._tag === 'Complete') for (const state of result) completed.add(state)
      else if (outcome._tag === 'Forward') add(outcome.target, result)
      else if (outcome._tag === 'Return' || outcome._tag === 'Trap')
        semantics.terminal(result, outcome)
      else if (outcome._tag === 'Repeat' || outcome._tag === 'Exit') {
        const loop = loops.get(outcome.loop.ordinal)
        if (loop === undefined) {
          valid = false
          continue
        }
        add(
          outcome._tag === 'Repeat' ? loop.condition : loop.following,
          outcome._tag === 'Repeat' ? semantics.repeat(result) : result,
        )
      } else {
        const loop = [...loops.values()].find(
          (loop) => loop.condition.ordinal === region.id.ordinal,
        )
        if (loop === undefined) {
          valid = false
          continue
        }
        add(loop.body, result)
        add(loop.following, result)
      }
    }
    return completed
  }
  const matchCandidates = (
    operation: MatchOperation,
    candidates: ReadonlyArray<Match.ArmId>,
    ordinal: number,
    incoming: ReadonlySet<State>,
  ): ReadonlySet<State> => {
    const candidate = candidates.at(ordinal)
    if (candidate === undefined) {
      semantics.terminal(incoming)
      return new Set()
    }
    const arm = operation.arms.find((entry) => entry.id.ordinal === candidate.ordinal)
    if (arm === undefined) {
      valid = false
      return new Set()
    }
    const bound = semantics.enterArm?.(arm, incoming) ?? incoming
    const guarded = arm.guard === undefined ? bound : execution(arm.guard.execution, bound)
    const selected = execution(arm.selected.execution, guarded)
    let completed =
      arm.guard === undefined
        ? selected
        : semantics.merge(selected, matchCandidates(operation, candidates, ordinal + 1, guarded))
    if ((arm.tests?.length ?? 0) > 0)
      completed = semantics.merge(
        completed,
        matchCandidates(operation, candidates, ordinal + 1, incoming),
      )
    return completed
  }
  const transfer = (operation: Operation, incoming: ReadonlySet<State>): ReadonlySet<State> => {
    incoming = semantics.before?.(operation, incoming) ?? incoming
    if (operation._tag === 'PropagateEffectFailure') {
      semantics.terminal(incoming)
      return new Set()
    }
    if (
      operation._tag === 'RunEffect' ||
      operation._tag === 'RunEffectValue' ||
      operation._tag === 'RunStaticEffect'
    ) {
      if (SilkType.failureMembers(operation.outcomeType.type).length > 0) {
        semantics.terminal(sequence(operation.failureLoanEnds ?? [], incoming))
      }
      return incoming
    }
    if (operation._tag === 'DiagnosticScope') return execution(operation.body, incoming)
    if (operation._tag === 'Conditional')
      return semantics.merge(
        execution(operation.taken, incoming),
        execution(operation.otherwise, incoming),
      )
    if (operation._tag === 'ShortCircuit')
      return semantics.merge(incoming, execution(operation.right, incoming))
    if (operation._tag === 'Match') {
      if (operation.decisions.length === 0) {
        semantics.terminal(incoming)
        return new Set()
      }
      return semantics.merge(
        ...operation.decisions.map((decision) =>
          matchCandidates(
            operation,
            decision.candidates,
            0,
            semantics.select?.(operation, decision.member, incoming) ?? incoming,
          ),
        ),
      )
    }
    return semantics.transfer(operation, incoming)
  }

  const incoming = new Map<number, Set<State>>()
  const pending: Array<number> = []
  const enqueue = (target: RegionId, states: ReadonlySet<State>): void => {
    if (states.size === 0 || !byId.has(target.ordinal)) return
    const known = incoming.get(target.ordinal) ?? new Set<State>()
    const previous = known.size
    for (const state of states) known.add(state)
    incoming.set(target.ordinal, known)
    if (known.size !== previous) pending.push(target.ordinal)
  }
  const route = (region: OperationRegion | CleanupRegion, states: ReadonlySet<State>): void => {
    const outcome = region.outcome
    if (outcome._tag === 'Forward') enqueue(outcome.target, states)
    else if (outcome._tag === 'Return' || outcome._tag === 'Trap')
      semantics.terminal(states, outcome)
    else if (outcome._tag === 'Repeat') {
      const loop = loops.get(outcome.loop.ordinal)
      if (loop !== undefined) enqueue(loop.condition, semantics.repeat(states))
    } else if (outcome._tag === 'Exit') {
      const loop = loops.get(outcome.loop.ordinal)
      if (loop !== undefined) enqueue(loop.following, states)
    } else {
      const loop =
        (region.ownerLoop === undefined ? undefined : loops.get(region.ownerLoop.ordinal)) ??
        [...loops.values()].find((candidate) => candidate.condition.ordinal === region.id.ordinal)
      if (loop !== undefined) {
        enqueue(loop.body, states)
        enqueue(loop.following, states)
      }
    }
  }

  enqueue(fn.entry, semantics.initial)
  while (pending.length > 0) {
    const ordinal = pending.shift()
    if (ordinal === undefined) continue
    const region = byId.get(ordinal)
    const states = incoming.get(ordinal)
    if (region === undefined || states === undefined) continue
    if (region._tag === 'ConditionalRegion') {
      enqueue(region.taken, states)
      enqueue(region.otherwise, states)
    } else if (region._tag === 'LoopRegion') enqueue(region.condition, states)
    else route(region, sequence(operationsOf(region), states))
  }
  return valid
}

const initializationCache = new WeakMap<
  MirFunction,
  WeakMap<Layout.Plan, MirInitialization.Analysis>
>()

/** Shares path initializedness between MIR verification and post-normalization suspension planning. */
export const initializationOf = (
  fn: MirFunction,
  layout: Layout.Plan,
): MirInitialization.Analysis => {
  const previous = initializationCache.get(fn)?.get(layout)
  if (previous !== undefined) return previous
  const regions = regionsTree(fn.regions)
  const byId = new Map(regions.map((region) => [region.id.ordinal, region]))
  const loops = new Map(
    regions.flatMap((region) =>
      region._tag === 'LoopRegion' ? [[region.loop.ordinal, region] as const] : [],
    ),
  )
  const result = MirInitialization.analyze(fn, layout, operationLocals, (semantics) =>
    structuredCfgPathsValid(fn, byId, loops, semantics),
  )
  const cache =
    initializationCache.get(fn) ?? new WeakMap<Layout.Plan, MirInitialization.Analysis>()
  cache.set(layout, result)
  initializationCache.set(fn, cache)
  return result
}

/** Candidate selection stops when a guard transfers; only a Boolean result can reject it. */
const selectableMatchArms = (operation: MatchOperation): ReadonlySet<number> => {
  const selected = new Set<number>()
  for (const decision of operation.decisions)
    for (const candidate of decision.candidates) {
      const arm = operation.arms.find((arm) => arm.id.ordinal === candidate.ordinal)
      if (arm === undefined) break
      if (arm.guard !== undefined && arm.guard.execution.result === undefined) {
        if ((arm.tests?.length ?? 0) === 0) break
        continue
      }
      selected.add(arm.id.ordinal)
      if (arm.guard === undefined && (arm.tests?.length ?? 0) === 0) break
    }
  return selected
}

interface ExecutionCompletion {
  readonly completes: boolean
  readonly valid: boolean
}

/** Verifies normal-result availability on every reachable completion, including nested transfers. */
const executionCompletion = (
  fn: MirFunction,
  root: Execution,
  forbiddenResult?: LocalId,
  active = new Set<Execution>(),
): ExecutionCompletion => {
  if (active.has(root)) return { completes: false, valid: false }
  active.add(root)
  let valid = true
  let completes = false
  const regions = new Map(root.regions.map((region) => [region.id.ordinal, region] as const))
  const loops = new Map(
    regionsTree(root.regions).flatMap((region) =>
      region._tag === 'LoopRegion' ? [[region.loop.ordinal, region] as const] : [],
    ),
  )
  const ownOperations = new Set(root.regions.flatMap(operationsOf).flatMap(operationTree))
  const enclosingOperations = fn.regions.flatMap(operationsOf).flatMap(operationTree)
  if (root.recoveryOutcome !== undefined) {
    const recovery = root.recoveryOutcome
    valid &&=
      fn.localTypes.at(recovery.ordinal)?._tag === 'EffectOutcome' &&
      enclosingOperations.some(
        (operation) =>
          !ownOperations.has(operation) &&
          operation._tag === 'CatchEffect' &&
          operation.outcome.ordinal === recovery.ordinal,
      )
  }
  const declares = (operation: Operation, local: LocalId): boolean => {
    if ('destination' in operation && operation.destination?.ordinal === local.ordinal) return true
    if (operation._tag === 'UnpackEffectComposite' && operation.matched.ordinal === local.ordinal)
      return true
    if (operation._tag === 'Match')
      return operation.arms.some((arm) =>
        [...arm.bindings, ...arm.cleanupBindings].some(
          (binding) => binding.destination.ordinal === local.ordinal,
        ),
      )
    if (operation._tag === 'CatchEffect')
      return (
        operation.outcome.ordinal === local.ordinal ||
        operation.successValue.ordinal === local.ordinal ||
        operation.failureValue.ordinal === local.ordinal
      )
    return false
  }
  const result = root.result
  const initialized =
    result !== undefined &&
    (result.ordinal < fn.parameterCount ||
      enclosingOperations.some(
        (operation) => !ownOperations.has(operation) && declares(operation, result),
      ))
  const incoming = new Map<number, Set<boolean>>()
  const pending: Array<number> = []
  const enqueue = (target: RegionId, state: boolean): void => {
    if (!regions.has(target.ordinal)) {
      valid = false
      return
    }
    const states = incoming.get(target.ordinal) ?? new Set<boolean>()
    if (states.has(state)) return
    states.add(state)
    incoming.set(target.ordinal, states)
    pending.push(target.ordinal)
  }
  enqueue(root.entry, initialized)
  while (pending.length > 0) {
    const id = pending.shift()
    if (id === undefined) continue
    const region = regions.get(id)
    if (region === undefined) continue
    for (const initial of incoming.get(id) ?? []) {
      if (region._tag === 'ConditionalRegion') {
        enqueue(region.taken, initial)
        enqueue(region.otherwise, initial)
        continue
      }
      if (region._tag === 'LoopRegion') {
        enqueue(region.condition, initial)
        continue
      }
      let available = initial
      let continuing = true
      for (const operation of operationsOf(region)) {
        if (!continuing) {
          valid = false
          break
        }
        const nested = (execution: Execution): boolean => {
          const flow = executionCompletion(
            fn,
            execution,
            'destination' in operation ? operation.destination : undefined,
            active,
          )
          valid &&= flow.valid
          return flow.completes
        }
        if (operation._tag === 'Match') {
          continuing = false
          const selectable = selectableMatchArms(operation)
          for (const arm of operation.arms) {
            const guard = arm.guard === undefined || nested(arm.guard.execution)
            const selected = nested(arm.selected.execution)
            if (selectable.has(arm.id.ordinal) && guard && selected) continuing = true
          }
        } else if (operation._tag === 'DiagnosticScope') {
          continuing = nested(operation.body)
        } else if (operation._tag === 'Conditional') {
          const taken = nested(operation.taken)
          const otherwise = nested(operation.otherwise)
          continuing = taken || otherwise
        } else if (operation._tag === 'ShortCircuit') nested(operation.right)
        else if (operation._tag === 'PropagateEffectFailure') continuing = false
        if (continuing && result !== undefined && declares(operation, result)) available = true
      }
      if (!continuing) continue
      const outcome = region.outcome
      if (outcome._tag === 'Complete') {
        completes = true
        if (!available) valid = false
      } else if (outcome._tag === 'Forward') enqueue(outcome.target, available)
      else if (outcome._tag === 'Yield') {
        const loop = [...loops.values()].find(
          (loop) => loop.condition.ordinal === region.id.ordinal,
        )
        if (loop === undefined) valid = false
        else {
          enqueue(loop.body, available)
          enqueue(loop.following, available)
        }
      } else if (outcome._tag === 'Exit' || outcome._tag === 'Repeat') {
        const loop = loops.get(outcome.loop.ordinal)
        // A target outside this region graph belongs to the enclosing execution and never completes this arm.
        if (loop !== undefined)
          enqueue(outcome._tag === 'Exit' ? loop.following : loop.condition, available)
      }
    }
  }
  if (
    completes !== (result !== undefined) ||
    (result !== undefined && result.ordinal === forbiddenResult?.ordinal)
  )
    valid = false
  active.delete(root)
  return { completes, valid }
}

const mergePathStates = <State>(...groups: ReadonlyArray<ReadonlySet<State>>): ReadonlySet<State> =>
  new Set(groups.flatMap((group) => [...group]))

/**
 * Proves the dynamic lifetime of one statically unique loan over structured operation branches and
 * lexical loop backedges. A path may avoid the loan entirely, but every path that begins it must
 * end it exactly once before terminating, and no loop may execute either endpoint twice.
 */
const loanPathsValid = (
  fn: MirFunction,
  key: string,
  byId: ReadonlyMap<number, Region>,
  loops: ReadonlyMap<number, LoopRegion>,
): boolean => {
  let valid = true
  const terminal = (states: ReadonlySet<LoanPathState>): void => {
    if (states.has('Live')) valid = false
  }
  const endpoint = (
    states: ReadonlySet<LoanPathState>,
    operation: Extract<Operation, { readonly _tag: 'BeginLoan' | 'EndLoan' }>,
  ): ReadonlySet<LoanPathState> => {
    if (borrowKey(operation.borrow) !== key) return states
    const next = new Set<LoanPathState>()
    for (const state of states) {
      if (operation._tag === 'BeginLoan' && state === 'Dormant') next.add('Live')
      else if (operation._tag === 'EndLoan' && state === 'Live') next.add('Ended')
      else valid = false
    }
    return next
  }
  const repeat = (states: ReadonlySet<LoanPathState>): ReadonlySet<LoanPathState> =>
    new Set([...states].map((state) => (state === 'Ended' ? 'Dormant' : state)))
  const transfer = (operation: Operation, incoming: ReadonlySet<LoanPathState>) => {
    if (operation._tag === 'BeginLoan' || operation._tag === 'EndLoan')
      return endpoint(incoming, operation)
    return incoming
  }
  const pathsValid = structuredCfgPathsValid(fn, byId, loops, {
    initial: new Set<LoanPathState>(['Dormant']),
    transfer,
    terminal,
    repeat,
    merge: mergePathStates,
  })
  return valid && pathsValid
}

/**
 * Tracks one direct reborrow relationship as correlated state over the whole control-flow graph.
 * The per-loan lifetime pass above proves each endpoint count; this pass proves that a parent is
 * live whenever its child begins and cannot end while that child remains live, including when the
 * endpoints occur in different regions.
 */
const loanAncestryPathsValid = (
  fn: MirFunction,
  parentKey: string,
  childKey: string,
  byId: ReadonlyMap<number, Region>,
  loops: ReadonlyMap<number, LoopRegion>,
): boolean => {
  const parentBit = 1
  const childBit = 2
  let valid = true
  const endpoint = (
    states: ReadonlySet<number>,
    operation: Extract<Operation, { readonly _tag: 'BeginLoan' | 'EndLoan' }>,
  ): ReadonlySet<number> => {
    const key = borrowKey(operation.borrow)
    if (key !== parentKey && key !== childKey) return states
    const next = new Set<number>()
    for (const state of states) {
      if (key === parentKey) {
        if (operation._tag === 'BeginLoan') next.add(state | parentBit)
        else if ((state & childBit) !== 0) {
          valid = false
          next.add(state & ~parentBit)
        } else next.add(state & ~parentBit)
      } else if (operation._tag === 'BeginLoan') {
        if ((state & parentBit) === 0) valid = false
        next.add(state | childBit)
      } else next.add(state & ~childBit)
    }
    return next
  }
  const transfer = (operation: Operation, incoming: ReadonlySet<number>): ReadonlySet<number> => {
    if (operation._tag === 'BeginLoan' || operation._tag === 'EndLoan')
      return endpoint(incoming, operation)
    return incoming
  }
  const pathsValid = structuredCfgPathsValid(fn, byId, loops, {
    initial: new Set([0]),
    transfer,
    terminal: () => undefined,
    repeat: (states) => states,
    merge: mergePathStates,
  })
  return valid && pathsValid
}

const cyclicOperation = (operation: Operation): boolean => {
  const active = new Set<Operation>()
  const completed = new Set<Operation>()
  const walk = (current: Operation): boolean => {
    if (active.has(current)) return true
    if (completed.has(current)) return false
    active.add(current)
    const cyclic = operationChildren(current).some(walk)
    active.delete(current)
    completed.add(current)
    return cyclic
  }
  return walk(operation)
}

const sameSuspensionPoint = (left: SuspensionPointId, right: SuspensionPointId): boolean =>
  instanceText(left.owner) === instanceText(right.owner) &&
  left.sourceId === right.sourceId &&
  left.spanStart === right.spanStart &&
  left.spanEnd === right.spanEnd &&
  left.ordinal === right.ordinal

const sameLocalSequence = (left: ReadonlyArray<LocalId>, right: ReadonlyArray<LocalId>): boolean =>
  left.length === right.length &&
  left.every((local, ordinal) => local.ordinal === right.at(ordinal)?.ordinal)

const sameEffectContract = (left: SilkType.Effect, right: SilkType.Effect): boolean =>
  SilkType.equals({ ...left, access: 'Shared' }, { ...right, access: 'Shared' })

const sameEffectChannels = (left: SilkType.Effect, right: SilkType.Effect): boolean =>
  SilkType.equals(left.success, right.success) &&
  SilkType.failureMembers(left).length === SilkType.failureMembers(right).length &&
  SilkType.failureMembers(left).every((failure, ordinal) => {
    const candidate = SilkType.failureMembers(right).at(ordinal)
    return candidate !== undefined && SilkType.equals(failure, candidate)
  })

export const suspensionBorrowText = (borrow: SuspensionBorrowIdentity): string => {
  if (borrow._tag === 'MirLoan') return `loan:${borrowKey(borrow.borrow)}`
  if (borrow._tag === 'BorrowedParameter') return `parameter:${borrow.parameterOrdinal}`
  return `local:${borrow.local.ordinal}`
}

const initializationText = (initialization: CoroutineFrameRelease['initialization']): string =>
  initialization === undefined
    ? ''
    : `${MovePath.encodeState(initialization.state)}:${initialization.flags.map((flag) => `${MovePath.key(flag.path)}=%${flag.local.ordinal}`).join(',')}`

export const coroutineFrameReleaseText = (release: CoroutineFrameRelease): string =>
  `${release.local.ordinal}:${release.cleanup._tag}:${SilkType.key(release.cleanup.type)}${initializationText(release.initialization)}`

const providerText = (provider: SuspensionProviderArgument): string =>
  `${SilkType.key(provider.capability)}@${provider.role}:${provider.requirementAccess}:${provider.access}:${SilkType.key(provider.providerType)}:${provider.argument?.ordinal ?? 'none'}:${provider.argumentLane ?? 0}:${provider.witness?._tag ?? 'none'}:${provider.purposes.join('+')}`

const runnerText = (runner: SuspensionRunner): string =>
  [
    runner.classification,
    runner.declaration === undefined ? 'unknown' : targetText(runner.declaration),
    runner.instance === undefined ? 'unknown' : instanceText(runner.instance),
    runner.effectIdentity ?? 'none',
    runner.typeArguments.map(SilkType.genericArgumentKey).join(','),
    SilkType.key({ ...runner.outcome, access: 'Shared' }),
    runner.captures
      .map(
        (capture) =>
          `${capture.ordinal}:${capture.source}:${capture.sourceOrdinal}:${capture.access}:${SilkType.key(capture.type)}`,
      )
      .join(','),
    runner.providers.map(providerText).join(','),
  ].join('|')

const runnerOutcomeMatches = (fn: MirFunction, effect: SilkType.Effect): boolean =>
  fn.result._tag === 'EffectOutcome' &&
  EffectExecutionContract.matches(fn.result.type, effect, fn.effectRunner?.providers ?? [])

const suspensionViolations = (
  fn: MirFunction,
  program: InvocationProgram,
): ReadonlyArray<Violation> => {
  const layout = program.layout
  const violations: Array<Violation> = []
  const projectedProviderValid = (
    provider: SuspensionProviderArgument & { readonly argument: LocalId },
  ): boolean => {
    const runtimeAccess = provider.access === 'Take' ? 'Exclusive' : provider.access
    const argumentType = fn.localTypes.at(provider.argument.ordinal)
    const laneOrdinal = provider.argumentLane ?? 0
    if (!Number.isInteger(laneOrdinal) || laneOrdinal < 0) return false
    if (argumentType?._tag === 'EffectValue') {
      const lane = Layout.effectEnvironmentLanes(layout, argumentType.environment).at(laneOrdinal)
      return (
        lane !== undefined &&
        typeof lane.type !== 'string' &&
        lane.type._tag === 'Address' &&
        SilkType.equals(lane.type.element, provider.providerType)
      )
    }
    if (laneOrdinal !== 0) return false
    return (
      (argumentType?._tag === 'Reference' &&
        (argumentType.type.access === runtimeAccess ||
          (runtimeAccess === 'Shared' && argumentType.type.access === 'Exclusive')) &&
        SilkType.equals(argumentType.type.target, provider.providerType)) ||
      (argumentType?._tag === 'EnvironmentBorrow' &&
        (argumentType.access === runtimeAccess ||
          (runtimeAccess === 'Shared' && argumentType.access === 'Exclusive')) &&
        SilkType.equals(argumentType.type, provider.providerType))
    )
  }
  const invalid = (
    rule: Extract<
      Violation['rule'],
      'InvalidSuspension' | 'InvalidCoroutineFrame' | 'OrphanSuspensionMachinery'
    >,
    detail: string,
    region?: RegionId,
  ): void => {
    violations.push({
      _tag: 'Violation',
      rule,
      function: fn.id,
      ...(region === undefined ? {} : { region }),
      detail,
    })
  }
  const suspension = fn.suspension
  if (suspension === undefined) return []
  for (const local of suspensionLocals(fn))
    if (local.ordinal < 0 || local.ordinal >= fn.localTypes.length)
      invalid(
        'InvalidCoroutineFrame',
        `suspension control references undeclared local %${local.ordinal}`,
      )
  if (suspension.classification === 'Synchronous' && suspension.regions.length > 0)
    invalid('InvalidSuspension', 'synchronous execution contains suspension control')
  const points = new Set<string>()
  for (const region of suspension.regions) {
    const pointKey = `${instanceText(region.point.owner)}:${region.point.sourceId}:${region.point.spanStart}:${region.point.spanEnd}:${region.point.ordinal}`
    if (
      points.has(pointKey) ||
      instanceText(region.point.owner) !== instanceText(fn.instance) ||
      region.point.spanStart < 0 ||
      region.point.spanStart > region.point.spanEnd
    )
      invalid(
        'InvalidSuspension',
        'suspension point identity is duplicate or disagrees with its owner',
      )
    points.add(pointKey)
    if (region._tag === 'SuspendEffectRegion') {
      if (region.transfer._tag !== 'OriginateTransfer')
        invalid('InvalidSuspension', 'explicit suspension must originate one transfer')
      const owning = fn.regions.find(
        (candidate) => candidate.id.ordinal === region.ownerRegion.ordinal,
      )
      const operationPresent =
        owning !== undefined &&
        operationsOf(owning).flatMap(operationTree).includes(region.operation)
      if (!operationPresent)
        invalid(
          'InvalidSuspension',
          'explicit suspension references no operation in its owner region',
        )
      if (!sameEffectContract(region.operation.outcomeType.type, region.deferred.outcome))
        invalid(
          'InvalidSuspension',
          'explicit suspension child outcome disagrees with its run carrier',
        )
      continue
    }
    if (
      region.complete._tag !== 'CompleteInCurrentActivation' ||
      region.relay._tag !== 'RelayExistingTransfer' ||
      region.relay.preserves.join(',') !== 'Child,Origin,TypedOutcome' ||
      region.runner.classification === 'Synchronous'
    )
      invalid(
        'InvalidSuspension',
        'suspendable run must complete locally or relay the unchanged transfer identity',
        region.ownerRegion,
      )
    const owning = fn.regions.find(
      (candidate) => candidate.id.ordinal === region.ownerRegion.ordinal,
    )
    const operationPresent =
      owning !== undefined && operationsOf(owning).flatMap(operationTree).includes(region.operation)
    if (!operationPresent)
      invalid('InvalidSuspension', 'suspendable run references no operation in its owner region')
    const operationOutcome =
      region.operation._tag === 'ExecutionPark'
        ? region.runner.outcome
        : region.operation.outcomeType.type
    if (
      !sameEffectContract(operationOutcome, region.runner.outcome) ||
      !sameEffectChannels(region.completion.outcome, operationOutcome)
    )
      invalid(
        'InvalidSuspension',
        `runner, operation, and completion outcome contracts disagree: operation=${SilkType.encode(operationOutcome)} runner=${SilkType.encode(region.runner.outcome)} completion=${SilkType.encode(region.completion.outcome)}`,
      )
    if (region.operation._tag !== 'ExecutionPark') {
      const effectOperation = region.operation
      const operationRunner =
        effectOperation._tag === 'RunEffect' ? effectOperation.target : effectOperation.runner
      const operationTypeArguments =
        effectOperation._tag === 'RunEffect'
          ? effectOperation.typeArguments
          : effectOperation.runnerTypeArguments
      if (
        region.runner.declaration === undefined ||
        region.runner.declaration.module !== operationRunner.module ||
        region.runner.declaration.name !== operationRunner.name ||
        region.runner.typeArguments.map(SilkType.genericArgumentKey).join(',') !==
          operationTypeArguments.map(SilkType.genericArgumentKey).join(',')
      )
        invalid('InvalidSuspension', 'suspension runner identity disagrees with its exact MIR call')
      if (
        (region.completion._tag === 'Propagate' &&
          (effectOperation._tag === 'CatchEffect' ||
            region.completion.failureMappings.length !==
              SilkType.failureMembers(effectOperation.outcomeType.type).length ||
            region.completion.failureMappings.some((mapping, ordinal) => {
              const source = SilkType.failureMembers(effectOperation.outcomeType.type).at(ordinal)
              const selectedSource = SilkType.failureCarrierMember(
                effectOperation.outcomeType.type,
                mapping.source,
                'OneBased',
              )
              const target = SilkType.failureCarrierMember(
                region.completion.outcome,
                mapping.target,
                'OneBased',
              )
              return (
                mapping.source !== ordinal + 1 ||
                source === undefined ||
                selectedSource === undefined ||
                target === undefined ||
                !SilkType.equals(source, selectedSource) ||
                !SilkType.equals(source, target)
              )
            }))) ||
        (region.completion._tag === 'Reify' &&
          (effectOperation._tag !== 'CatchEffect' ||
            !SilkType.equals(
              region.completion.successType,
              effectOperation.outcomeType.type.success,
            ) ||
            !SilkType.equals(region.completion.failureValueType, effectOperation.failureValueType)))
      )
        invalid('InvalidSuspension', 'typed completion mapping disagrees with its MIR operation')
    }
    for (const provider of region.runner.providers) {
      const argumentValid =
        provider.argument === undefined ||
        projectedProviderValid({ ...provider, argument: provider.argument })
      const purposeValid = provider.purposes.join(',') === 'ChildRequirement'
      if (!argumentValid || !purposeValid)
        invalid(
          'InvalidCoroutineFrame',
          'provider argument has incompatible local, type, or purpose',
        )
    }
    const descriptor = region.relay.state
    if (region.relay.frame === 'MissingOwnershipPlan')
      invalid(
        'InvalidCoroutineFrame',
        'suspendable run has no exact post-normalization ownership plan',
      )
    if (descriptor === undefined) {
      invalid('InvalidCoroutineFrame', 'suspendable invocation omits its coroutine-frame state')
      continue
    }
    if (
      !sameSuspensionPoint(descriptor.point, region.point) ||
      !sameSuspensionPoint(descriptor.success.resume.point, region.point) ||
      !sameSuspensionPoint(descriptor.failure.resume.point, region.point) ||
      descriptor.success.resume.path !== 'Success' ||
      descriptor.failure.resume.path !== 'Failure'
    )
      invalid(
        'InvalidCoroutineFrame',
        'continuation has missing or ambiguous stable resume identities',
      )
    if (
      runnerText(descriptor.runner) !== runnerText(region.runner) ||
      !sameEffectContract(descriptor.outcome, region.runner.outcome)
    )
      invalid('InvalidCoroutineFrame', 'continuation runner or typed outcome is stale')
    const slots = descriptor.slots
    const holders = [
      ...operationLocals(region.operation).filter((local) => {
        if (
          'destination' in region.operation &&
          local.ordinal === region.operation.destination.ordinal
        )
          return false
        if ('outcome' in region.operation && local.ordinal === region.operation.outcome.ordinal)
          return false
        if (
          region.operation._tag === 'CatchEffect' &&
          (local.ordinal === region.operation.successValue.ordinal ||
            local.ordinal === region.operation.failureValue.ordinal)
        )
          return false
        return true
      }),
      ...slots.map((slot) => slot.local),
    ]
    const inputRetention = invocationRetentions(fn, program, holders)
    if (inputRetention.issues.length > 0)
      invalid('InvalidCoroutineFrame', 'continuation invocation borrowed contents remain unproved')
    if (
      inputRetention.retentions.map(invocationRetentionText).sort().join('\n') !==
      (descriptor.invocationUses ?? []).map(invocationRetentionText).sort().join('\n')
    )
      invalid(
        'InvalidCoroutineFrame',
        'continuation loses or fabricates an exact invocation holder dependency',
      )
    const canonicalStates =
      suspension.frame?.states.filter((state) => sameSuspensionPoint(state.point, region.point)) ??
      []
    const canonicalState = canonicalStates.length === 1 ? canonicalStates.at(0) : undefined
    if (
      canonicalState === undefined ||
      inputRetention.retentions.map(invocationRetentionText).sort().join('\n') !==
        (canonicalState.invocationUses ?? []).map(invocationRetentionText).sort().join('\n')
    )
      invalid(
        'InvalidCoroutineFrame',
        'canonical frame loses or fabricates an exact invocation holder dependency',
      )
    for (const retention of inputRetention.retentions)
      for (const dependency of [...retention.dependencies, ...retention.environment])
        for (const referent of dependency.referents)
          if (
            !slots.some((slot) => slot.local.ordinal === referent.root.ordinal) ||
            initializationOf(fn, layout).before.get(region.operation)?.get(referent.root.ordinal)
              ?.initialization === 'Missing'
          )
            invalid(
              'InvalidCoroutineFrame',
              'continuation loses an initialized invocation input external referent owner',
            )
    const orderedReleases = invocationReleaseOrder(
      inputRetention.retentions,
      descriptor.failure.releases,
    )
    if (
      orderedReleases === undefined ||
      orderedReleases.some(
        (release, ordinal) =>
          release.local.ordinal !== descriptor.failure.releases.at(ordinal)?.local.ordinal,
      )
    )
      invalid(
        'InvalidCoroutineFrame',
        'cancellation releases an invocation referent before its owned holder',
      )
    const slotOrdinals = slots.map((slot) => slot.ordinal)
    const localOrdinals = slots.map((slot) => slot.local.ordinal)
    const expectedOrdinals = slots.map((_slot, ordinal) => ordinal)
    if (
      new Set(localOrdinals).size !== localOrdinals.length ||
      slotOrdinals.join(',') !== expectedOrdinals.join(',') ||
      !sameLocalSequence(
        [...region.liveLocals].sort((left, right) => left.ordinal - right.ordinal),
        slots.map((slot) => slot.local),
      )
    )
      invalid(
        'InvalidCoroutineFrame',
        'logical layout omits, duplicates, or reorders a post-normalization live local',
      )
    for (const slot of slots) {
      const declared = fn.localTypes.at(slot.local.ordinal)
      const initialization = initializationOf(fn, layout)
      const expectedState =
        initialization.before.get(region.operation)?.get(slot.local.ordinal) ?? MovePath.make()
      const actualState = slot.initialization?.state ?? MovePath.make()
      const requiredPaths = MovePath.conditionalPaths(expectedState).map(MovePath.key).sort()
      const flags = slot.initialization?.flags ?? []
      const sourceFlags =
        fn.initializationFlags?.find((entry) => entry.root.ordinal === slot.local.ordinal)?.flags ??
        []
      if (
        MovePath.encodeState(expectedState) !== MovePath.encodeState(actualState) ||
        requiredPaths.join(',') !==
          flags
            .map((flag) => MovePath.key(flag.path))
            .sort()
            .join(',') ||
        flags.some(
          (flag) =>
            !sourceFlags.some(
              (source) =>
                source.local.ordinal === flag.local.ordinal &&
                MovePath.key(source.path) === MovePath.key(flag.path),
            ) ||
            !initialization.flagsBefore.get(region.operation)?.has(flag.local.ordinal) ||
            !slots.some(
              (retained) =>
                retained.local.ordinal === flag.local.ordinal && retained.type._tag === 'bool',
            ),
        )
      )
        invalid(
          'InvalidCoroutineFrame',
          `continuation slot %${slot.local.ordinal} loses initializedness or a conditional cleanup flag`,
        )
      let accessValid: boolean
      if (slot.access._tag === 'Copy') {
        accessValid = isCopy(layout, semanticType(slot.type))
      } else if (slot.access._tag === 'BorrowedDependency') {
        accessValid =
          slot.type._tag === 'Reference' ||
          slot.type._tag === 'Slice' ||
          slot.type._tag === 'EnvironmentBorrow'
      } else {
        accessValid = !isCopy(layout, semanticType(slot.type))
      }
      if (
        declared === undefined ||
        !SilkType.equals(semanticType(declared), semanticType(slot.type)) ||
        !accessValid
      )
        invalid(
          'InvalidCoroutineFrame',
          `continuation slot %${slot.local.ordinal} has incompatible type or access`,
        )
    }
    for (const slot of slots) {
      if (slot.access._tag !== 'AffineTransfer') continue
      const releases = descriptor.failure.releases.filter(
        (release) => release.local.ordinal === slot.local.ordinal,
      )
      if (
        releases.length !== 1 ||
        releases.some(
          (release) =>
            initializationText(release.initialization) !== initializationText(slot.initialization),
        )
      )
        invalid(
          'InvalidCoroutineFrame',
          'cancellation loses a retained owner or its initializedness',
        )
    }
    const parkGuardOrdinal =
      region.operation._tag === 'ExecutionPark' ? region.operation.guard.ordinal : undefined
    const expectedRestores =
      parkGuardOrdinal === undefined
        ? expectedOrdinals
        : slots
            .filter((slot) => slot.local.ordinal !== parkGuardOrdinal)
            .map((slot) => slot.ordinal)
    if (
      descriptor.success.restores.join(',') !== expectedRestores.join(',') ||
      descriptor.failure.restores.length !== 0
    )
      invalid('InvalidCoroutineFrame', 'resume path plan is incomplete')
    if (
      descriptor.success.loanEnds.length !== 0 ||
      (parkGuardOrdinal !== undefined
        ? descriptor.success.releases.length !==
            (descriptor.slots.some((slot) => slot.local.ordinal === parkGuardOrdinal) ? 1 : 0) ||
          (descriptor.success.releases.length === 1 &&
            descriptor.success.releases.at(0)?.local.ordinal !== parkGuardOrdinal)
        : descriptor.success.releases.length !== 0)
    )
      invalid('InvalidCoroutineFrame', 'success or failure cleanup plan diverges')
  }
  return violations
}

/** A conditional input remains unresolved until its concrete producer is available. */
export interface InvocationUseIssue {
  readonly _tag: 'InvalidInvocationUse' | 'ConditionalInvocationInput'
  readonly operation: Operation
  readonly detail: string
}

const invocationDefinitions = (fn: MirFunction): ReadonlyMap<number, ReadonlyArray<Operation>> => {
  const definitions = new Map<number, Array<Operation>>()
  const add = (local: LocalId, operation: Operation): void => {
    const current = definitions.get(local.ordinal) ?? []
    if (!current.includes(operation)) current.push(operation)
    definitions.set(local.ordinal, current)
  }
  for (const operation of operations(fn)) {
    if ('destination' in operation && operation.destination !== undefined)
      add(operation.destination, operation)
    if (operation._tag === 'CatchEffect') {
      add(operation.outcome, operation)
      add(operation.successValue, operation)
      add(operation.failureValue, operation)
    } else if (
      operation._tag === 'RunEffect' ||
      operation._tag === 'RunEffectValue' ||
      operation._tag === 'RunStaticEffect' ||
      operation._tag === 'RunEffectComposite'
    )
      add(operation.outcome, operation)
    if (operation._tag === 'Match')
      for (const arm of operation.arms)
        for (const binding of arm.bindings) add(binding.destination, operation)
  }
  return definitions
}

const relatedAuthoredOwners = (
  left: AuthoredIdentity.Identity,
  right: AuthoredIdentity.Identity,
): boolean =>
  left.module === right.module &&
  left.namespace === right.namespace &&
  (left.path.length <= right.path.length
    ? AuthoredIdentity.key(left) ===
      AuthoredIdentity.key({ ...right, path: right.path.slice(0, left.path.length) })
    : AuthoredIdentity.key(right) ===
      AuthoredIdentity.key({ ...left, path: left.path.slice(0, right.path.length) }))

interface RecoveryScope {
  readonly outcome: LocalId
  readonly recipe?: Tir.RecoveryInvocationRecipe
}
const recoveryScopes = (fn: MirFunction): ReadonlyMap<Operation, RecoveryScope> => {
  const scopes = new Map<Operation, RecoveryScope>()
  const visit = (
    execution: Pick<Mir.Execution, 'regions' | 'recoveryOutcome' | 'recoveryInvocation'>,
    inherited?: RecoveryScope,
  ): void => {
    const scope =
      execution.recoveryOutcome === undefined
        ? inherited
        : {
            outcome: execution.recoveryOutcome,
            ...(execution.recoveryInvocation === undefined
              ? {}
              : { recipe: execution.recoveryInvocation }),
          }
    for (const region of regionsTree(execution.regions))
      for (const operation of operationsOf(region)) {
        if (scope !== undefined) scopes.set(operation, scope)
        if (operation._tag === 'DiagnosticScope') visit(operation.body, scope)
        else if (operation._tag === 'Conditional') {
          visit(operation.taken, scope)
          visit(operation.otherwise, scope)
        } else if (operation._tag === 'ShortCircuit') visit(operation.right, scope)
        else if (operation._tag === 'Match')
          for (const arm of operation.arms) {
            if (arm.guard !== undefined) visit(arm.guard.execution, scope)
            visit(arm.selected.execution, scope)
          }
      }
  }
  visit(fn)
  return scopes
}

const invocationCapturedSource = (
  definitions: ReadonlyMap<number, ReadonlyArray<Operation>>,
  container: LocalId,
  ordinal: number,
  parameter: number,
  source?: AuthoredIdentity.Anchor,
  path?: ReadonlyArray<Tir.InvocationCapturePathStep>,
  seen: ReadonlySet<number> = new Set(),
): LocalId | undefined => {
  if (seen.has(container.ordinal)) return undefined
  const next = new Set([...seen, container.ordinal])
  const candidates = definitions.get(container.ordinal) ?? []
  if (candidates.length !== 1) return undefined
  const definition = candidates.at(0)
  if (definition?._tag === 'Move')
    return invocationCapturedSource(
      definitions,
      definition.source,
      ordinal,
      parameter,
      source,
      path,
      next,
    )
  if (definition?._tag !== 'MakeCallable') return undefined
  const step = path?.at(0)
  if (step !== undefined) {
    if (
      definition.type.site === undefined ||
      Tir.executableSiteKey(step.site) !== Tir.executableSiteKey(definition.type.site)
    )
      return undefined
    if (step._tag === 'Base')
      return definition.base === undefined
        ? undefined
        : invocationCapturedSource(
            definitions,
            definition.base,
            ordinal,
            parameter,
            source,
            path?.slice(1),
            next,
          )
    const capture = definition.captures.find((capture) => capture.ordinal === step.ordinal)
    if (capture === undefined) return undefined
    if ((path?.length ?? 0) > 1)
      return invocationCapturedSource(
        definitions,
        capture.source,
        ordinal,
        parameter,
        source,
        path?.slice(1),
        next,
      )
    return capture.parameterOrdinal === parameter &&
      source !== undefined &&
      capture.sourceOrigin !== undefined &&
      AuthoredIdentity.anchorKey(source) === AuthoredIdentity.anchorKey(capture.sourceOrigin)
      ? capture.source
      : undefined
  }
  const matches = definition.captures.filter(
    (capture) => capture.ordinal === ordinal && capture.parameterOrdinal === parameter,
  )
  const capture = matches.at(0)
  if (matches.length === 1 && capture !== undefined)
    return source !== undefined &&
      capture.sourceOrigin !== undefined &&
      AuthoredIdentity.anchorKey(source) === AuthoredIdentity.anchorKey(capture.sourceOrigin)
      ? capture.source
      : undefined
  return definition.base === undefined
    ? undefined
    : invocationCapturedSource(definitions, definition.base, ordinal, parameter, source, path, next)
}

/** Checked incoming section storage is authority only at its actual authored parameter boundary. */
const invocationHeaderCapture = (
  fn: MirFunction,
  input: Mir.InvocationUse['inputs'][number],
):
  | {
      readonly contents: ReadonlyArray<
        Mir.InvocationUseRetention['dependencies'][number]['contents'][number]
      >
      readonly conditional: boolean
    }
  | undefined => {
  if (input.capture === undefined || input.header === undefined || fn.sourceOwner === undefined)
    return undefined
  const definitions = invocationDefinitions(fn)
  const actualContainer = fn.localTypes.at(input.argument.ordinal)
  if (actualContainer?._tag !== 'CallableValue') return undefined
  let declared = input.argument
  const seen = new Set<number>()
  for (;;) {
    if (seen.has(declared.ordinal)) return undefined
    seen.add(declared.ordinal)
    const candidates = definitions.get(declared.ordinal) ?? []
    if (candidates.length === 0) break
    const producer = candidates.length === 1 ? candidates.at(0) : undefined
    if (producer?._tag !== 'Move') return undefined
    const previous = fn.localTypes.at(producer.source.ordinal)
    if (previous?._tag !== 'CallableValue' || !SilkType.equals(previous.type, actualContainer.type))
      return undefined
    declared = producer.source
  }
  if (declared.ordinal >= fn.parameterCount) return undefined
  const capture = input.capture
  const declaredHeaders = fn.sourceParameters ?? []
  if (
    new Set(declaredHeaders.map((parameter) => parameter.local.ordinal)).size !==
      declaredHeaders.length ||
    new Set(declaredHeaders.map((parameter) => parameter.parameter)).size !== declaredHeaders.length
  )
    return undefined
  const headers = declaredHeaders.filter(
    (parameter) =>
      parameter.local.ordinal === declared.ordinal &&
      parameter.parameter === input.header?.parameter &&
      AuthoredIdentity.anchorKey(parameter.source) ===
        AuthoredIdentity.anchorKey(input.header.source),
  )
  const header = headers.length === 1 ? headers.at(0) : undefined
  const container = fn.localTypes.at(declared.ordinal)
  if (
    header === undefined ||
    container?._tag !== 'CallableValue' ||
    !SilkType.isCallable(header.type) ||
    !SilkType.equals(header.type, container.type) ||
    header.source.owner.module !== fn.sourceOwner.module ||
    !Number.isSafeInteger(header.parameter) ||
    header.parameter < 0
  )
    return undefined
  const schema = header.type.schema
  const field = container.environment?.fields.at(input.capture)
  if (
    schema === undefined ||
    field === undefined ||
    field.ordinal !== input.capture ||
    field.parameterOrdinal !== input.parameter ||
    !SilkType.equals(field.type, input.type) ||
    !SilkType.invocationAdapterValid(
      header.type.invocationUse,
      header.type.parameters.length,
      schema,
    )
  )
    return undefined
  const originalInputs =
    schema.invocationAdapter?.originalInputs ?? SilkType.callableInputOrdinals(schema.contract)
  const visible =
    schema.invocationAdapter?.parameters ??
    Array.from({ length: header.type.parameters.length }, (_, ordinal) => ordinal)
  if (
    originalInputs === undefined ||
    !originalInputs.includes(input.parameter) ||
    visible.includes(input.parameter)
  )
    return undefined
  // The incoming boundary's canonical flattened field is the path. An old formation path and
  // anchor remain provenance; neither manufactures a captured local or a second cleanup owner.
  const retained = SilkType.retention(input.type)
  return {
    conditional: retained.unknown.length !== 0,
    contents: retained.regions.map((region) => ({
      parameter: header.parameter,
      path: [{ _tag: 'Capture', ordinal: capture }],
      type: input.type,
      region,
    })),
  }
}

/** Authenticates real call operands and selected recovery branches before any retention proof. */
export const invocationUseIssues = (
  fn: MirFunction,
  program: InvocationProgram,
): ReadonlyArray<InvocationUseIssue> => {
  const issues: Array<InvocationUseIssue> = []
  const definitions = invocationDefinitions(fn)
  const recoveries = recoveryScopes(fn)
  const sourceOfFailure = (
    local: LocalId,
    outcome: LocalId,
    seen: ReadonlySet<number> = new Set(),
  ): boolean => {
    if (seen.has(local.ordinal)) return false
    const candidates = definitions.get(local.ordinal) ?? []
    if (candidates.length !== 1) return false
    const definition = candidates.at(0)
    if (definition?._tag === 'CatchEffect')
      return (
        definition.outcome.ordinal === outcome.ordinal &&
        definition.failureValue.ordinal === local.ordinal
      )
    const next = new Set([...seen, local.ordinal])
    if (definition?._tag === 'Move' || definition?._tag === 'ConvertUnion')
      return sourceOfFailure(definition.source, outcome, next)
    if (definition?._tag === 'Match')
      return (
        definition.arms.some((arm) =>
          arm.bindings.some((binding) => binding.destination.ordinal === local.ordinal),
        ) && sourceOfFailure(definition.scrutinee, outcome, next)
      )
    return false
  }
  for (const actualOperation of operations(fn)) {
    if (
      actualOperation._tag === 'MakeEffect' &&
      actualOperation.invocationSource !== undefined &&
      !MirNormalization.invocationConstructionValid(program, actualOperation)
    ) {
      issues.push({
        _tag: 'InvalidInvocationUse',
        operation: actualOperation,
        detail: 'folded invocation loses its exact actual constructor proof',
      })
      continue
    }
    const operation =
      actualOperation._tag === 'MakeEffect' ? actualOperation.invocationSource : actualOperation
    if (operation === undefined) continue
    if (operation._tag !== 'Call' && operation._tag !== 'ApplyCallable') continue
    const invocation = operation.invocationUse
    if (invocation === undefined) {
      if (operation._tag === 'ApplyCallable' && operation.callableType.invocationUse !== undefined)
        issues.push({
          _tag: 'InvalidInvocationUse',
          operation,
          detail: 'marked callable application omits its actual invocation inputs',
        })
      continue
    }
    const invalid = (detail: string): void => {
      issues.push({ _tag: 'InvalidInvocationUse', operation, detail })
    }
    if (operation._tag === 'Call') {
      const targets = program.functions.filter((target) =>
        matchesCall(
          target,
          operation.target,
          operation.typeArguments,
          operation.staticArguments,
          operation.type,
        ),
      )
      const target = targets.length === 1 ? targets.at(0) : undefined
      if (
        target === undefined ||
        target.parameterCount !== operation.arguments.length ||
        !operation.arguments.every((argument, ordinal) => {
          const actual = fn.localTypes.at(argument.ordinal)
          const expected = target.localTypes.at(ordinal)
          return (
            actual !== undefined &&
            expected !== undefined &&
            callArgumentCompatible(actual, expected)
          )
        })
      )
        invalid(
          'invocation original call loses its unique selected target or actual input contract',
        )
    } else {
      if (
        operation.access !== operation.callableType.mode ||
        operation.arguments.length !== operation.callableType.parameters.length ||
        !operation.arguments.every((argument, ordinal) => {
          const actual = fn.localTypes.at(argument.ordinal)
          const expected = operation.callableType.parameters.at(ordinal)
          return (
            actual !== undefined &&
            expected !== undefined &&
            acceptsRuntimeOperand(semanticType(actual), expected)
          )
        })
      )
        invalid(
          'invocation original callable loses its actual mode or complete visible input contract',
        )
      if (operation.realization === 'DirectErasedSection') {
        const targetId =
          operation.target?._tag === 'DeclarationCallableTarget'
            ? operation.target.declaration
            : undefined
        const targets =
          targetId === undefined
            ? []
            : program.functions.filter((target) =>
                matchesCall(target, targetId, operation.typeArguments, undefined, operation.type),
              )
        const target = targets.length === 1 ? targets.at(0) : undefined
        const supplied = new Map<number, LocalId>()
        const coordinates = operation.callableType.schema?.invocationAdapter?.parameters
        for (const [ordinal, argument] of operation.arguments.entries())
          supplied.set(coordinates?.at(ordinal) ?? ordinal, argument)
        for (const capture of operation.captures) {
          if (supplied.has(capture.parameterOrdinal))
            invalid('invocation original target input is supplied twice')
          supplied.set(capture.parameterOrdinal, capture.source)
        }
        if (
          operation.callable !== undefined ||
          target === undefined ||
          supplied.size !== target.parameterCount ||
          [...supplied].some(([ordinal, local]) => {
            const actual = fn.localTypes.at(local.ordinal)
            const expected = target?.localTypes.at(ordinal)
            return (
              actual === undefined ||
              expected === undefined ||
              !callArgumentCompatible(actual, expected)
            )
          })
        )
          invalid('invocation erased original target loses complete actual parameter wiring')
      }
    }
    if (
      fn.sourceOwner === undefined ||
      invocation.owner.module !== fn.sourceOwner.module ||
      invocation.owner.name !== fn.sourceOwner.name ||
      invocation.lifetime._tag !== 'LocalLifetime' ||
      invocation.lifetime.owner.module !== invocation.owner.module ||
      invocation.lifetime.owner.name !== invocation.owner.name ||
      invocation.origin.owner.module !== invocation.owner.module ||
      invocation.binder._tag !== 'BoundLifetime' ||
      invocation.result.ordinal !== operation.destination.ordinal
    )
      invalid('invocation identity, source owner, or actual returned local is stale')
    if (operation._tag === 'ApplyCallable' && operation.callableType.invocationUse !== undefined) {
      const actual =
        operation.callable === undefined ? undefined : fn.localTypes.at(operation.callable.ordinal)
      const actualTarget = actual?._tag === 'CallableValue' ? actual.target : operation.target
      const targetId =
        actualTarget?._tag === 'DeclarationCallableTarget' ? actualTarget.declaration : undefined
      const targets =
        targetId === undefined
          ? []
          : program.functions.filter((target) =>
              matchesCall(
                target,
                targetId,
                actual?._tag === 'CallableValue'
                  ? (actual.typeArguments ?? [])
                  : operation.typeArguments,
                undefined,
                operation.type,
              ),
            )
      const selected = targets.length === 1 ? targets.at(0) : undefined
      // A parameter descriptor may carry the required callable view. Only a concrete
      // environment or the uniquely selected source header supplies the offered designation.
      const originalDesignation =
        actual?._tag === 'CallableValue' && actual.environment !== undefined
          ? actual.environment.callable.type.invocationUse?.lifetime
          : selected?.sourceInvocationUse?.lifetime
      if (
        originalDesignation?._tag === 'BoundLifetime' &&
        !Lifetime.equals(originalDesignation, invocation.binder)
      )
        invalid('invocation loses its authentic offered original use binder')
      if (invocation.kind === 'Recovery' && originalDesignation === undefined) {
        const requiredBinder = recoveries.get(actualOperation)?.recipe?.binder
        if (requiredBinder === undefined || !Lifetime.equals(requiredBinder, invocation.binder))
          invalid('recovery invocation loses its checked original required use binder')
      }
      if (invocation.kind === 'Source') {
        const required = fn.sourceParameters?.find(
          (parameter) => parameter.local.ordinal === operation.callable?.ordinal,
        )?.contract
        const requiredBinder =
          (actual?._tag === 'CallableValue'
            ? actual.type.schema?.invocationAdapter?.binder
            : undefined) ??
          (required !== undefined && SilkType.isCallable(required)
            ? required.invocationUse?.lifetime
            : undefined)
        if (
          requiredBinder?._tag === 'BoundLifetime' &&
          originalDesignation === undefined &&
          !Lifetime.equals(requiredBinder, invocation.binder)
        )
          invalid('invocation loses its checked original required use binder')
      }
      const usage = operation.callableType.invocationUse
      if (
        !SilkType.invocationUseValid(
          usage,
          operation.callableType.parameters.length,
          operation.callableType.lifetimeBinders,
          { state: SilkType.invocationUseState(operation.callableType) },
        ) ||
        !(
          Lifetime.equals(usage.lifetime, invocation.binder) ||
          Lifetime.equals(usage.lifetime, invocation.lifetime)
        )
      )
        invalid('invocation selected lifetime does not open its actual callable designation')
    }
    if (
      SilkType.freeLifetimes(semanticType(operation.type)).some((lifetime) =>
        Lifetime.atoms(lifetime).some((atom) => Lifetime.equals(atom, invocation.binder)),
      )
    )
      invalid('actual invocation result retains its unopened rigid designation')
    if (
      new Set(invocation.inputs.map((input) => input.parameter)).size !== invocation.inputs.length
    )
      invalid('invocation duplicates an original input coordinate')
    const schema = operation._tag === 'ApplyCallable' ? operation.callableType.schema : undefined
    let originalInputs: ReadonlyArray<number> | undefined
    if (operation._tag !== 'ApplyCallable')
      originalInputs = Array.from({ length: operation.arguments.length }, (_, ordinal) => ordinal)
    else if (schema === undefined)
      originalInputs =
        operation.callableType.invocationUse?.parameters ??
        Array.from({ length: operation.callableType.parameters.length }, (_, ordinal) => ordinal)
    else
      originalInputs =
        schema.invocationAdapter?.originalInputs ?? SilkType.callableInputOrdinals(schema.contract)
    if (
      originalInputs === undefined ||
      invocation.inputs.length !== originalInputs.length ||
      originalInputs.some(
        (ordinal) => !invocation.inputs.some((input) => input.parameter === ordinal),
      ) ||
      (schema !== undefined &&
        !SilkType.invocationAdapterValid(
          operation._tag === 'ApplyCallable' ? operation.callableType.invocationUse : undefined,
          operation.arguments.length,
          schema,
        ))
    )
      invalid('invocation fails complete original target input coverage')
    const coordinates =
      operation._tag === 'ApplyCallable'
        ? operation.callableType.schema?.invocationAdapter?.parameters
        : undefined
    for (const [ordinal, argument] of operation.arguments.entries()) {
      const original = coordinates?.at(ordinal) ?? ordinal
      if (
        !invocation.inputs.some(
          (input) =>
            input.capture === undefined &&
            input.parameter === original &&
            input.argument.ordinal === argument.ordinal,
        )
      )
        invalid('invocation operand loses its exact original target parameter coordinate')
    }
    if (operation._tag === 'ApplyCallable') {
      for (const capture of operation.captures.filter((capture) =>
        originalInputs?.includes(capture.parameterOrdinal),
      ))
        if (
          !invocation.inputs.some(
            (input) =>
              input.capture === undefined &&
              input.parameter === capture.parameterOrdinal &&
              input.argument.ordinal === capture.source.ordinal,
          )
        )
          invalid('invocation omits a directly retained original captured input')
    }
    const visible = invocation.inputs.filter(
      (input) =>
        input.capture === undefined &&
        operation.arguments.some((argument) => argument.ordinal === input.argument.ordinal),
    )
    if (
      operation.arguments.some(
        (argument) => !visible.some((input) => input.argument.ordinal === argument.ordinal),
      )
    )
      invalid('invocation omits an actual supplied operand')
    for (const input of invocation.inputs) {
      if (
        !Number.isSafeInteger(input.parameter) ||
        input.parameter < 0 ||
        (invocation.kind === 'Source' && input.source === undefined) ||
        (input.capture === undefined &&
          input.source !== undefined &&
          !relatedAuthoredOwners(input.source.owner, invocation.origin.owner))
      )
        invalid('invocation input loses its original coordinate or authored source')
      let actual = input.argument
      if (input.capture !== undefined) {
        const container = fn.localTypes.at(input.argument.ordinal)
        const field =
          container?._tag === 'CallableValue'
            ? container.environment?.fields.at(input.capture)
            : undefined
        const captured = invocationCapturedSource(
          definitions,
          input.argument,
          input.capture,
          input.parameter,
          input.source,
          input.capturePath,
        )
        const incoming = invocationHeaderCapture(fn, input)
        if (
          operation._tag !== 'ApplyCallable' ||
          operation.callable?.ordinal !== input.argument.ordinal ||
          field === undefined ||
          field.parameterOrdinal !== input.parameter ||
          !SilkType.equals(field.type, input.type) ||
          (captured === undefined && incoming === undefined)
        ) {
          invalid('invocation captured input lacks its exact retained callable slot producer')
          continue
        }
        if (captured === undefined) {
          if (incoming?.conditional)
            issues.push({
              _tag: 'ConditionalInvocationInput',
              operation,
              detail:
                'incoming captured input retains an unresolved exact-header contents obligation',
            })
          continue
        }
        actual = captured
      } else if (
        !operation.arguments.some((argument) => argument.ordinal === input.argument.ordinal)
      ) {
        const capture =
          operation._tag === 'ApplyCallable'
            ? operation.captures.find(
                (capture) =>
                  capture.parameterOrdinal === input.parameter &&
                  capture.source.ordinal === input.argument.ordinal,
              )
            : undefined
        if (
          capture === undefined ||
          capture.sourceOrigin === undefined ||
          input.source === undefined ||
          AuthoredIdentity.anchorKey(capture.sourceOrigin) !==
            AuthoredIdentity.anchorKey(input.source)
        ) {
          invalid('invocation input is not an authenticated direct stored original capture')
          continue
        }
      }
      const actualType = fn.localTypes.at(actual.ordinal)
      if (actualType === undefined || !SilkType.equals(semanticType(actualType), input.type))
        invalid('invocation input type disagrees with its actual MIR local')
      if (
        SilkType.retention(input.type).unknown.length > 0 &&
        SilkType.retention(semanticType(operation.type)).regions.some((region) =>
          Lifetime.equals(region, invocation.lifetime),
        )
      )
        issues.push({
          _tag: 'ConditionalInvocationInput',
          operation,
          detail: 'generic invocation contents retain an unresolved exact-input obligation',
        })
    }
    if (invocation.kind === 'Recovery') {
      const scope = recoveries.get(actualOperation)
      const recipe = scope?.recipe
      const input = invocation.inputs.find(
        (input) => input.capture === undefined && input.parameter === 0,
      )
      if (
        operation._tag !== 'ApplyCallable' ||
        scope === undefined ||
        recipe === undefined ||
        input === undefined ||
        !sourceOfFailure(input.argument, scope.outcome) ||
        !Lifetime.equals(recipe.lifetime, invocation.lifetime) ||
        recipe.owner.module !== invocation.owner.module ||
        recipe.owner.name !== invocation.owner.name ||
        AuthoredIdentity.anchorKey(recipe.origin) !==
          AuthoredIdentity.anchorKey(invocation.origin) ||
        !SilkType.equals(recipe.selected, input.type)
      )
        invalid('recovery invocation is not owned by the actual selected caught failure branch')
    }
  }
  return issues
}

type InvocationDependency = Mir.InvocationUseRetention['dependencies'][number]
type InvocationContents = InvocationDependency['contents'][number]

/** Canonical source authority for a header parameter's external borrowed contents. */
const invocationHeaderContents = (
  fn: MirFunction,
  program: InvocationProgram,
  parameter: number,
): ReadonlyArray<InvocationContents> | undefined => {
  const layout = program.layout
  const declared = fn.localTypes.at(parameter)
  const sourceOwner = fn.sourceOwner
  if (parameter >= fn.parameterCount || declared === undefined || sourceOwner === undefined)
    return undefined
  const contents: Array<InvocationContents> = []
  const active = new Set<string>()
  const visit = (type: SilkType.Type, path: InvocationContents['path']): boolean => {
    const key = SilkType.key(type)
    if (active.has(key)) return false
    const retention = SilkType.retention(type)
    if (retention.unknown.length > 0) return false
    if (retention.regions.length === 0) return true
    if (
      SilkType.isReference(type) ||
      SilkType.isSlice(type) ||
      SilkType.isString(type) ||
      SilkType.isCallable(type) ||
      SilkType.isEffect(type) ||
      SilkType.isRepresented(type)
    ) {
      // A checked header denotes an external referent, never a local cell allocated by this body.
      if (
        retention.regions.some((region) =>
          operations(fn).some(
            (operation) =>
              ((operation._tag === 'Call' || operation._tag === 'ApplyCallable') &&
                operation.invocationUse !== undefined &&
                Lifetime.equals(region, operation.invocationUse.lifetime)) ||
              (operation._tag === 'MakeEffect' &&
                operation.invocationSource?.invocationUse !== undefined &&
                Lifetime.equals(region, operation.invocationSource.invocationUse.lifetime)),
          ),
        )
      )
        return false
      contents.push(...retention.regions.map((region) => ({ parameter, path, type, region })))
      return true
    }
    active.add(key)
    const entry = Layout.entry(layout, type)
    const representation = entry?.representation
    // Physical entries erase lifetime coordinates. They cannot supply a different instance's
    // semantic field regions; the checked incoming contract is the authority for that domain.
    if (
      SilkType.isNominal(type) &&
      entry !== undefined &&
      (!SilkType.equals(entry.type, type) || representation?._tag === 'Reference')
    ) {
      contents.push(
        ...retention.regions
          .slice()
          .sort((left, right) => Lifetime.key(left).localeCompare(Lifetime.key(right)))
          .map((region, component) => ({
            parameter,
            path: [...path, { _tag: 'DeclaredContents' as const, component }],
            type,
            region,
          })),
      )
      active.delete(key)
      return true
    }
    const before = contents.length
    let valid = false
    if (representation?._tag === 'Aggregate')
      valid = representation.fields.every((field) =>
        visit(field.type, [...path, { _tag: 'Field', field: field.id }]),
      )
    else if (representation?._tag === 'Repeated' && SilkType.isFixedArray(type))
      valid = Array.from({ length: representation.length }, (_, index) =>
        visit(type.element, [...path, { _tag: 'Element', index }]),
      ).every(Boolean)
    else if (representation?._tag === 'Union' && SilkType.isUnion(type))
      valid = representation.members.every((member) => {
        const actual = type.members.filter(
          (candidate) => SilkType.runtimeKey(candidate) === SilkType.runtimeKey(member.type),
        )
        const selected = actual.length === 1 ? actual.at(0) : undefined
        return (
          selected !== undefined &&
          visit(selected, [...path, { _tag: 'Variant', ordinal: member.ordinal }])
        )
      })
    else if (representation?._tag === 'NominalUnion')
      valid = representation.variants.every((variant) =>
        variant.fields.every((field) =>
          visit(field.type, [
            ...path,
            { _tag: 'Variant', ordinal: variant.ordinal },
            { _tag: 'Field', field: field.id },
          ]),
        ),
      )
    if (
      valid &&
      !retention.regions.every((region) =>
        contents.slice(before).some((content) => Lifetime.equals(content.region, region)),
      )
    ) {
      // Known nominal storage can hide retained contents behind its declared contract. Unknown
      // generic contents were rejected above; a named region is not an empty-storage certificate.
      if (SilkType.isNominal(type) && entry !== undefined) {
        contents.push(
          ...retention.regions
            .filter(
              (region) =>
                !contents.slice(before).some((content) => Lifetime.equals(content.region, region)),
            )
            .sort((left, right) => Lifetime.key(left).localeCompare(Lifetime.key(right)))
            .map((region, component) => ({
              parameter,
              path: [...path, { _tag: 'DeclaredContents' as const, component }],
              type,
              region,
            })),
        )
      } else valid = false
    }
    active.delete(key)
    return valid
  }
  if (declared._tag === 'EffectValue' && declared.inputView !== undefined) {
    const physical = ExecutableInputView.physical(program, declared)
    const headers =
      fn.sourceParameters?.filter(
        (header) =>
          header.local.ordinal === parameter && SilkType.equals(header.type, declared.type),
      ) ?? []
    const header = headers.at(0)
    if (
      physical === undefined ||
      headers.length !== 1 ||
      header === undefined ||
      header.source.owner.module !== sourceOwner.module ||
      declared.inputView.view.target.module !== sourceOwner.module ||
      declared.inputView.view.target.name !== sourceOwner.name ||
      header.parameter !== declared.inputView.view.parameter.ordinal ||
      AuthoredIdentity.anchorKey(header.source) !==
        AuthoredIdentity.anchorKey(declared.inputView.view.parameter.source)
    )
      return undefined
    // An incoming closure's authenticated original fields denote external borrowed
    // contents. The contextual success/failure channels cannot manufacture them.
    return physical.environment.fields.every((field) =>
      visit(field.type, [{ _tag: 'Capture', ordinal: field.ordinal }]),
    )
      ? contents
      : undefined
  }
  return visit(semanticType(declared), []) ? contents : undefined
}

export interface InvocationRetentionAnalysis {
  readonly retentions: ReadonlyArray<Mir.InvocationUseRetention>
  readonly issues: ReadonlyArray<InvocationUseIssue>
}

type InvocationProgram = Pick<Mir.Module, 'layout' | 'functions' | 'executableInputViews'>

type InvocationChannel = 'Value' | 'Success' | 'Failure'

/** Real returned producer edges, expressed in the selected body's incoming parameter coordinates. */
const invocationReturnedParameters = (
  program: InvocationProgram,
  fn: MirFunction,
  channel: InvocationChannel,
  active: ReadonlySet<MirFunction> = new Set(),
): ReadonlySet<number> | undefined => {
  if (active.has(fn) || fn.sourceOwner === undefined) return undefined
  const nextFunctions = new Set([...active, fn])
  const definitions = invocationDefinitions(fn)
  const parameters = new Set<number>()
  const walk = (
    local: LocalId,
    selected: InvocationChannel,
    seen: ReadonlySet<number>,
  ): boolean => {
    if (seen.has(local.ordinal)) return false
    const type = fn.localTypes.at(local.ordinal)
    if (type === undefined) return false
    if (
      type._tag !== 'EffectOutcome' &&
      SilkType.retention(semanticType(type)).regions.length === 0 &&
      SilkType.retention(semanticType(type)).unknown.length === 0
    )
      return true
    const candidates = definitions.get(local.ordinal) ?? []
    if (local.ordinal < fn.parameterCount && candidates.length === 0) {
      parameters.add(local.ordinal)
      return true
    }
    if (candidates.length !== 1) return false
    const definition = candidates.at(0)
    const next = new Set([...seen, local.ordinal])
    const descend = (value: LocalId, kind: InvocationChannel = 'Value'): boolean =>
      walk(value, kind, next)
    if (definition?._tag === 'PackEffectOutcome')
      return (
        (selected === 'Failure' && definition.tag === 0) ||
        (selected === 'Success' && definition.tag !== 0) ||
        descend(definition.source)
      )
    if (definition?._tag === 'PackEffectFailureUnion')
      return selected === 'Success' || descend(definition.source)
    if (
      definition?._tag === 'Move' ||
      definition?._tag === 'ConvertUnion' ||
      definition?._tag === 'Project' ||
      definition?._tag === 'PackEffectComposite' ||
      definition?._tag === 'UnpackEffectComposite'
    )
      return descend(definition.source, selected)
    if (definition?._tag === 'UnpackEffectSuccess') return descend(definition.source, 'Success')
    if (definition?._tag === 'BeginLoan') {
      const root = fn.localTypes.at(definition.root.ordinal)
      // A returned loan of this body's own storage cannot become a caller header authority.
      return (
        !borrowsDescriptor(definition) &&
        (root?._tag === 'Reference' ||
          root?._tag === 'Slice' ||
          root?._tag === 'EnvironmentBorrow') &&
        descend(definition.root)
      )
    }
    if (definition?._tag === 'Construct' || definition?._tag === 'ConstructUnionVariant')
      return definition.fields.every((field) => descend(field.value))
    if (definition?._tag === 'ConstructArray')
      return definition.elements.every((element) => descend(element))
    if (definition?._tag === 'MakeEffect' || definition?._tag === 'MakeCallable')
      return (
        (definition._tag !== 'MakeCallable' ||
          definition.base === undefined ||
          descend(definition.base)) &&
        definition.captures.every((capture) => descend(capture.source))
      )
    if (definition?._tag === 'Match') {
      const arms = definition.arms.filter((arm) =>
        selectableMatchArms(definition).has(arm.id.ordinal),
      )
      if (
        arms.some((arm) =>
          arm.bindings.some((binding) => binding.destination.ordinal === local.ordinal),
        )
      )
        return descend(definition.scrutinee)
      return (
        definition.destination?.ordinal === local.ordinal &&
        arms.every(
          (arm) =>
            arm.selected.execution.result !== undefined &&
            descend(arm.selected.execution.result, selected),
        )
      )
    }
    if (definition?._tag === 'Call') {
      const targets = program.functions.filter((target) =>
        matchesCall(
          target,
          definition.target,
          definition.typeArguments,
          definition.staticArguments,
          definition.type,
        ),
      )
      const target = targets.length === 1 ? targets.at(0) : undefined
      if (
        target === undefined ||
        target.parameterCount !== definition.arguments.length ||
        !definition.arguments.every((argument, ordinal) => {
          const actual = fn.localTypes.at(argument.ordinal)
          const expected = target.localTypes.at(ordinal)
          return (
            actual !== undefined &&
            expected !== undefined &&
            callArgumentCompatible(actual, expected)
          )
        })
      )
        return false
      const returned = invocationReturnedParameters(program, target, selected, nextFunctions)
      return (
        returned !== undefined &&
        [...returned].every((ordinal) => {
          const argument = definition.arguments.at(ordinal)
          return argument !== undefined && descend(argument)
        })
      )
    }
    if (definition?._tag === 'RunEffect' || definition?._tag === 'RunStaticEffect') {
      const inputs =
        definition._tag === 'RunEffect'
          ? definition.arguments
          : [...definition.captures.map((capture) => capture.source), ...definition.arguments]
      const targets = program.functions.filter((target) =>
        matchesEffectInstance(
          target,
          definition._tag === 'RunEffect' ? definition.target : definition.runner,
          definition._tag === 'RunEffect'
            ? definition.typeArguments
            : definition.runnerTypeArguments,
          definition._tag === 'RunEffect'
            ? definition.staticArguments
            : definition.runnerStaticArguments,
          definition.outcomeType.type,
        ),
      )
      const target = targets.length === 1 ? targets.at(0) : undefined
      if (
        target === undefined ||
        target.parameterCount !== inputs.length ||
        !inputs.every((argument, ordinal) => {
          const actual = fn.localTypes.at(argument.ordinal)
          const expected = target.localTypes.at(ordinal)
          return (
            actual !== undefined &&
            expected !== undefined &&
            executionArgumentCompatible(actual, expected)
          )
        })
      )
        return false
      const returned = invocationReturnedParameters(
        program,
        target,
        local.ordinal === definition.destination.ordinal ? 'Success' : selected,
        nextFunctions,
      )
      return (
        returned !== undefined &&
        [...returned].every((ordinal) => {
          const argument = inputs.at(ordinal)
          return argument !== undefined && descend(argument)
        })
      )
    }
    if (definition?._tag === 'RunEffectValue' || definition?._tag === 'CatchEffect') {
      const effect = fn.localTypes.at(definition.effect.ordinal)
      const fields = effect?._tag === 'EffectValue' ? effect.environment.fields : undefined
      const physicalOutcome = ExecutableInputView.outcome(
        program,
        effect,
        definition.outcomeType.type,
      )
      const targets = program.functions.filter(
        (target) =>
          physicalOutcome !== undefined &&
          matchesEffectInstance(
            target,
            definition.runner,
            definition.runnerTypeArguments,
            definition.runnerStaticArguments,
            physicalOutcome,
            definition._tag === 'RunEffectValue' ? definition.providers : undefined,
          ),
      )
      const target = targets.length === 1 ? targets.at(0) : undefined
      if (
        target === undefined ||
        fields === undefined ||
        target.parameterCount !== fields.length + definition.arguments.length ||
        !fields.every((field, ordinal) => {
          const expected = target.localTypes.at(ordinal)
          return expected !== undefined && acceptsRuntimeOperand(field.type, semanticType(expected))
        }) ||
        !definition.arguments.every((argument, ordinal) => {
          const actual = fn.localTypes.at(argument.ordinal)
          const expected = target.localTypes.at(fields.length + ordinal)
          return (
            actual !== undefined &&
            expected !== undefined &&
            callArgumentCompatible(actual, expected)
          )
        })
      )
        return false
      let kind = selected
      if (definition._tag === 'CatchEffect') {
        if (local.ordinal === definition.failureValue.ordinal) kind = 'Failure'
        else if (local.ordinal === definition.successValue.ordinal) kind = 'Success'
      } else if (local.ordinal === definition.destination.ordinal) kind = 'Success'
      const returned = invocationReturnedParameters(program, target, kind, nextFunctions)
      return (
        returned !== undefined &&
        [...returned].every((ordinal) => {
          if (ordinal >= fields.length) {
            const argument = definition.arguments.at(ordinal - fields.length)
            return argument !== undefined && descend(argument)
          }
          const capture = invocationEffectCapture(fn, definition.effect, ordinal)
          if (capture !== undefined) return descend(capture.source)
          // An incoming checked Effect is external declared contents authority. This denotes its
          // environment storage, not a proof fabricated from its success or failure channel type.
          return (
            definition.effect.ordinal < fn.parameterCount &&
            (definitions.get(definition.effect.ordinal) ?? []).length === 0 &&
            descend(definition.effect)
          )
        })
      )
    }
    return false
  }
  const roots = outcomes(fn).filter(
    (outcome): outcome is Extract<Outcome, { readonly _tag: 'Return' }> =>
      outcome._tag === 'Return',
  )
  if (roots.length === 0 || !roots.every((outcome) => walk(outcome.value, channel, new Set())))
    return undefined
  if (
    channel === 'Failure' &&
    !operations(fn)
      .filter((operation) => operation._tag === 'PropagateEffectFailure')
      .every((operation) => walk(operation.source, 'Value', new Set()))
  )
    return undefined
  return parameters
}

/** Resolves one physical environment field only through an actual selected Effect producer. */
const invocationEffectCapture = (
  fn: MirFunction,
  effect: LocalId,
  ordinal: number,
  seen: ReadonlySet<number> = new Set(),
): { readonly source: LocalId; readonly access: SilkType.CaptureAccess } | undefined => {
  if (seen.has(effect.ordinal)) return undefined
  const definitions = invocationDefinitions(fn).get(effect.ordinal) ?? []
  const definition = definitions.length === 1 ? definitions.at(0) : undefined
  if (definition?._tag === 'MakeEffect') return definition.captures.at(ordinal)
  if (definition?._tag === 'Move')
    return invocationEffectCapture(
      fn,
      definition.source,
      ordinal,
      new Set([...seen, effect.ordinal]),
    )
  return undefined
}

/** Traces an incoming Effect through actual descriptor-preserving affine transfers. */
const invocationIncomingEffect = (fn: MirFunction, effect: LocalId): LocalId | undefined => {
  const definitions = invocationDefinitions(fn)
  let local = effect
  const seen = new Set<number>()
  for (;;) {
    if (seen.has(local.ordinal)) return undefined
    seen.add(local.ordinal)
    const candidates = definitions.get(local.ordinal) ?? []
    if (candidates.length === 0) return local.ordinal < fn.parameterCount ? local : undefined
    const move = candidates.length === 1 ? candidates.at(0) : undefined
    if (move?._tag !== 'Move') return undefined
    const actual = fn.localTypes.at(local.ordinal)
    const previous = fn.localTypes.at(move.source.ordinal)
    if (
      actual?._tag !== 'EffectValue' ||
      previous?._tag !== 'EffectValue' ||
      !SilkType.equals(actual.type, previous.type) ||
      !Tir.sameExecutableSite(actual.site, previous.site) ||
      Instances.keyText(actual.environment.instance) !==
        Instances.keyText(previous.environment.instance)
    )
      return undefined
    local = move.source
  }
}

/** Follows real holder and input producers; type regions never manufacture a local loan root. */
export const invocationRetentions = (
  fn: MirFunction,
  program: InvocationProgram,
  holders: ReadonlyArray<LocalId>,
): InvocationRetentionAnalysis => {
  const definitions = invocationDefinitions(fn)
  const retentions: Array<Mir.InvocationUseRetention> = []
  const issues: Array<InvocationUseIssue> = []
  const collect = (
    local: LocalId,
    referents: Array<InvocationDependency['referents'][number]>,
    contents: Array<InvocationContents>,
    seen: ReadonlySet<number>,
    operation: Operation,
  ): void => {
    if (seen.has(local.ordinal)) {
      issues.push({
        _tag: 'InvalidInvocationUse',
        operation,
        detail: 'invocation input producer cycle is unresolved',
      })
      return
    }
    const declared = fn.localTypes.at(local.ordinal)
    if (declared === undefined) {
      issues.push({
        _tag: 'InvalidInvocationUse',
        operation,
        detail: 'invocation input has no declared storage type',
      })
      return
    }
    const retention = SilkType.retention(semanticType(declared))
    if (retention.unknown.length > 0) {
      issues.push({
        _tag: 'ConditionalInvocationInput',
        operation,
        detail: 'invocation input borrowed contents need concrete realization',
      })
      return
    }
    if (retention.regions.length === 0) return
    const next = new Set([...seen, local.ordinal])
    const candidates = definitions.get(local.ordinal) ?? []
    if (local.ordinal < fn.parameterCount && candidates.length === 0) {
      const header = invocationHeaderContents(fn, program, local.ordinal)
      if (header === undefined)
        issues.push({
          _tag: 'InvalidInvocationUse',
          operation,
          detail: 'invocation input lacks canonical external header contents authority',
        })
      else contents.push(...header)
      return
    }
    if (candidates.length !== 1) {
      issues.push({
        _tag: 'InvalidInvocationUse',
        operation,
        detail: 'invocation input has ambiguous stored producers',
      })
      return
    }
    const definition = candidates.at(0)
    if (definition?._tag === 'BeginLoan') {
      const rootType = fn.localTypes.at(definition.root.ordinal)
      if (
        !borrowsDescriptor(definition) &&
        (rootType?._tag === 'Reference' ||
          rootType?._tag === 'Slice' ||
          rootType?._tag === 'EnvironmentBorrow')
      )
        collect(definition.root, referents, contents, next, operation)
      else
        referents.push({
          root: definition.root,
          loan: { _tag: 'MirLoan', borrow: definition.borrow },
        })
      return
    }
    if (
      definition?._tag === 'Move' ||
      definition?._tag === 'ConvertUnion' ||
      definition?._tag === 'Project' ||
      definition?._tag === 'PackEffectComposite' ||
      definition?._tag === 'UnpackEffectComposite' ||
      definition?._tag === 'UnpackEffectSuccess'
    ) {
      collect(definition.source, referents, contents, next, operation)
      return
    }
    if (definition?._tag === 'Construct' || definition?._tag === 'ConstructUnionVariant') {
      for (const field of definition.fields)
        collect(field.value, referents, contents, next, operation)
      return
    }
    if (definition?._tag === 'ConstructArray') {
      for (const element of definition.elements)
        collect(element, referents, contents, next, operation)
      return
    }
    if (definition?._tag === 'MakeEffect' || definition?._tag === 'MakeCallable') {
      if (definition._tag === 'MakeCallable' && definition.base !== undefined)
        collect(definition.base, referents, contents, next, operation)
      for (const capture of definition.captures) {
        if (capture.access === 'Shared' || capture.access === 'Exclusive')
          referents.push({
            root: capture.source,
            loan: { _tag: 'BorrowedLocal', local: capture.source },
          })
        collect(capture.source, referents, contents, next, operation)
      }
      return
    }
    if (definition?._tag === 'Match') {
      const selected = selectableMatchArms(definition)
      if (
        definition.arms.some(
          (arm) =>
            selected.has(arm.id.ordinal) &&
            arm.bindings.some((binding) => binding.destination.ordinal === local.ordinal),
        )
      ) {
        collect(definition.scrutinee, referents, contents, next, operation)
        return
      }
    }
    if (definition?._tag === 'Call') {
      const targets = program.functions.filter((target) =>
        matchesCall(
          target,
          definition.target,
          definition.typeArguments,
          definition.staticArguments,
          definition.type,
        ),
      )
      const target = targets.length === 1 ? targets.at(0) : undefined
      const returned =
        target === undefined ? undefined : invocationReturnedParameters(program, target, 'Value')
      if (
        target !== undefined &&
        target.parameterCount === definition.arguments.length &&
        returned !== undefined &&
        definition.arguments.every((argument, ordinal) => {
          const actual = fn.localTypes.at(argument.ordinal)
          const expected = target.localTypes.at(ordinal)
          return (
            actual !== undefined &&
            expected !== undefined &&
            callArgumentCompatible(actual, expected)
          )
        })
      ) {
        for (const ordinal of returned) {
          const argument = definition.arguments.at(ordinal)
          if (argument !== undefined) collect(argument, referents, contents, next, operation)
        }
        return
      }
    }
    if (definition?._tag === 'CatchEffect' && definition.failureValue.ordinal === local.ordinal) {
      const effect = fn.localTypes.at(definition.effect.ordinal)
      const physicalOutcome = ExecutableInputView.outcome(
        program,
        effect,
        definition.outcomeType.type,
      )
      const targets = program.functions.filter(
        (target) =>
          physicalOutcome !== undefined &&
          matchesEffectInstance(
            target,
            definition.runner,
            definition.runnerTypeArguments,
            definition.runnerStaticArguments,
            physicalOutcome,
          ),
      )
      const target = targets.length === 1 ? targets.at(0) : undefined
      const returned =
        target === undefined ? undefined : invocationReturnedParameters(program, target, 'Failure')
      const fields = effect?._tag === 'EffectValue' ? effect.environment.fields : undefined
      if (
        target !== undefined &&
        fields !== undefined &&
        returned !== undefined &&
        target.parameterCount === fields.length + definition.arguments.length &&
        fields.every((field, ordinal) => {
          const expected = target.localTypes.at(ordinal)
          return expected !== undefined && acceptsRuntimeOperand(field.type, semanticType(expected))
        }) &&
        definition.arguments.every((argument, ordinal) => {
          const actual = fn.localTypes.at(argument.ordinal)
          const expected = target.localTypes.at(fields.length + ordinal)
          return (
            actual !== undefined &&
            expected !== undefined &&
            callArgumentCompatible(actual, expected)
          )
        })
      ) {
        for (const ordinal of returned) {
          if (ordinal < fields.length) {
            const capture = invocationEffectCapture(fn, definition.effect, ordinal)
            if (capture === undefined) {
              const incoming = invocationIncomingEffect(fn, definition.effect)
              const physical =
                effect?._tag === 'EffectValue'
                  ? ExecutableInputView.physical(program, effect)
                  : undefined
              const incomingContents =
                incoming === undefined
                  ? undefined
                  : invocationHeaderContents(fn, program, incoming.ordinal)
              const field = physical?.environment.fields.at(ordinal)
              if (
                physical !== undefined &&
                field !== undefined &&
                incomingContents !== undefined &&
                field.ordinal === ordinal &&
                physicalOutcome !== undefined &&
                sameEffectChannels(physicalOutcome, physical.environment.effect)
              ) {
                const selectedContents = incomingContents.filter((content) => {
                  const path = content.path.at(0)
                  return path?._tag === 'Capture' && path.ordinal === ordinal
                })
                if (
                  SilkType.retention(field.type).regions.every((region) =>
                    selectedContents.some((content) => Lifetime.equals(content.region, region)),
                  )
                ) {
                  contents.push(...selectedContents)
                  continue
                }
              }
              const external = incoming !== undefined
              const declaredRegions =
                effect === undefined ? [] : SilkType.retention(semanticType(effect)).regions
              if (
                external &&
                retention.regions.every((region) =>
                  declaredRegions.some((declared) => Lifetime.equals(region, declared)),
                )
              ) {
                // The selected runner's returned producer reaches this genuine incoming Effect
                // field. Its checked external environment supplies contents, never its channel.
                collect(incoming ?? definition.effect, referents, contents, next, operation)
                continue
              }
              issues.push({
                _tag: 'InvalidInvocationUse',
                operation,
                detail:
                  'caught failure retained contents have no unique original Effect field producer',
              })
              continue
            }
            if (capture.access === 'Shared' || capture.access === 'Exclusive')
              referents.push({
                root: capture.source,
                loan: { _tag: 'BorrowedLocal', local: capture.source },
              })
            collect(capture.source, referents, contents, next, operation)
          } else {
            const argument = definition.arguments.at(ordinal - fields.length)
            if (argument !== undefined) collect(argument, referents, contents, next, operation)
          }
        }
        return
      }
    }
    issues.push({
      _tag: 'InvalidInvocationUse',
      operation,
      detail: 'invocation input borrowed contents have no authenticated concrete producer',
    })
  }
  const visited = new Set<string>()
  const visit = (holder: LocalId, local: LocalId, seen: ReadonlySet<number>): void => {
    const key = `${holder.ordinal}:${local.ordinal}`
    if (visited.has(key)) return
    visited.add(key)
    if (seen.has(local.ordinal)) return
    const next = new Set([...seen, local.ordinal])
    const candidates = definitions.get(local.ordinal) ?? []
    if (candidates.length !== 1) return
    const actualDefinition = candidates.at(0)
    if (
      actualDefinition?._tag === 'MakeEffect' &&
      actualDefinition.invocationSource !== undefined &&
      !MirNormalization.invocationConstructionValid(program, actualDefinition)
    ) {
      issues.push({
        _tag: 'InvalidInvocationUse',
        operation: actualDefinition,
        detail: 'folded holder has no authentic invocation constructor proof',
      })
      return
    }
    const definition =
      actualDefinition?._tag === 'MakeEffect' && actualDefinition.invocationSource !== undefined
        ? actualDefinition.invocationSource
        : actualDefinition
    if (
      (definition?._tag === 'Call' || definition?._tag === 'ApplyCallable') &&
      definition.invocationUse !== undefined
    ) {
      const invocation = definition.invocationUse
      const resultType = fn.localTypes.at(invocation.result.ordinal)
      const retained =
        resultType === undefined ? undefined : SilkType.retention(semanticType(resultType))
      if (
        retained === undefined ||
        !retained.regions.some(
          (region) =>
            Lifetime.equals(region, invocation.lifetime) ||
            invocation.inputs.some((input) =>
              SilkType.retention(input.type).regions.some((member) =>
                Lifetime.equals(region, member),
              ),
            ),
        )
      )
        return
      const dependencies = invocation.inputs.map((input): InvocationDependency => {
        const referents: Array<InvocationDependency['referents'][number]> = []
        const contents: Array<InvocationContents> = []
        const actual =
          input.capture === undefined
            ? input.argument
            : invocationCapturedSource(
                definitions,
                input.argument,
                input.capture,
                input.parameter,
                input.source,
                input.capturePath,
              )
        if (actual === undefined) {
          const incoming = invocationHeaderCapture(fn, input)
          if (incoming === undefined)
            issues.push({
              _tag: 'InvalidInvocationUse',
              operation: definition,
              detail: 'invocation capture source is not uniquely authenticated',
            })
          else {
            contents.push(...incoming.contents)
            if (incoming.conditional)
              issues.push({
                _tag: 'ConditionalInvocationInput',
                operation: definition,
                detail:
                  'incoming captured input retains an unresolved exact-header contents obligation',
              })
          }
        } else collect(actual, referents, contents, new Set(), definition)
        return {
          parameter: input.parameter,
          ...(input.capture === undefined ? {} : { capture: input.capture }),
          argument: input.argument,
          ...(input.capturePath === undefined ? {} : { capturePath: input.capturePath }),
          referents,
          contents,
        }
      })
      const environment: Array<Mir.InvocationUseRetention['environment'][number]> = []
      if (definition._tag === 'ApplyCallable') {
        const sources = [
          ...(definition.callable === undefined ? [] : [definition.callable]),
          ...definition.captures.map((capture) => capture.source),
        ]
        for (const argument of sources) {
          const referents: Array<InvocationDependency['referents'][number]> = []
          const contents: Array<InvocationContents> = []
          collect(argument, referents, contents, new Set(), definition)
          if (referents.length > 0 || contents.length > 0)
            environment.push({ argument, referents, contents })
        }
      }
      retentions.push({ invocation, holder, dependencies, environment })
      return
    }
    if (
      definition?._tag === 'Move' ||
      definition?._tag === 'ConvertUnion' ||
      definition?._tag === 'Project' ||
      definition?._tag === 'PackEffectComposite' ||
      definition?._tag === 'UnpackEffectComposite' ||
      definition?._tag === 'UnpackEffectSuccess'
    )
      visit(holder, definition.source, next)
    else if (definition?._tag === 'MakeEffect' || definition?._tag === 'MakeCallable') {
      if (definition._tag === 'MakeCallable' && definition.base !== undefined)
        visit(holder, definition.base, next)
      for (const capture of definition.captures) visit(holder, capture.source, next)
    } else if (definition?._tag === 'Construct' || definition?._tag === 'ConstructUnionVariant')
      for (const field of definition.fields) visit(holder, field.value, next)
    else if (definition?._tag === 'ConstructArray')
      for (const element of definition.elements) visit(holder, element, next)
    else if (definition?._tag === 'Call' || definition?._tag === 'ApplyCallable') {
      // Actual operand edges preserve a nested holder through an ordinary checked forwarding call.
      for (const argument of definition.arguments) visit(holder, argument, next)
      if (definition._tag === 'ApplyCallable') {
        if (definition.callable !== undefined) visit(holder, definition.callable, next)
        for (const capture of definition.captures) visit(holder, capture.source, next)
      }
    } else if (definition?._tag === 'Match') {
      const selected = selectableMatchArms(definition)
      for (const arm of definition.arms)
        if (selected.has(arm.id.ordinal)) {
          if (
            definition.destination?.ordinal === local.ordinal &&
            arm.selected.execution.result !== undefined
          )
            visit(holder, arm.selected.execution.result, next)
          if (arm.bindings.some((binding) => binding.destination.ordinal === local.ordinal))
            visit(holder, definition.scrutinee, next)
        }
    }
  }
  for (const holder of holders) visit(holder, holder, new Set())
  return { retentions, issues }
}

/** Function-owned invocation scopes cannot leave through a public return or failure boundary. */
export const invocationEscapeIssues = (
  fn: MirFunction,
  program: InvocationProgram,
): ReadonlyArray<InvocationUseIssue> => {
  const issues: Array<InvocationUseIssue> = []
  for (const region of regionsTree(fn.regions)) {
    if (region._tag !== 'OperationRegion' && region._tag !== 'CleanupRegion') continue
    const values = region.outcome._tag === 'Return' ? [region.outcome.value] : []
    for (const operation of operationsOf(region))
      if (operation._tag === 'PropagateEffectFailure') values.push(operation.source)
    for (const value of values) {
      const type = fn.localTypes.at(value.ordinal)
      if (type === undefined) continue
      const regions = SilkType.retention(semanticType(type)).regions
      for (const retention of invocationRetentions(fn, program, [value]).retentions) {
        const invocation = retention.invocation
        if (
          fn.sourceOwner !== undefined &&
          invocation.owner.module === fn.sourceOwner.module &&
          invocation.owner.name === fn.sourceOwner.name &&
          regions.some((region) => Lifetime.equals(region, invocation.lifetime))
        ) {
          const actual = operations(fn).find(
            (operation) =>
              ((operation._tag === 'Call' || operation._tag === 'ApplyCallable') &&
                operation.invocationUse === invocation) ||
              (operation._tag === 'MakeEffect' &&
                operation.invocationSource?.invocationUse === invocation &&
                MirNormalization.invocationConstructionValid(program, operation)),
          )
          if (actual !== undefined)
            issues.push({
              _tag: 'InvalidInvocationUse',
              operation: actual,
              detail:
                'function-owned invocation computation escapes its source use and cleanup scope',
            })
        }
      }
    }
  }
  return issues
}

/** Orders owned holder cleanup before owners of its external referents; cycles refuse. */
export const invocationReleaseOrder = <Release extends { readonly local: LocalId }>(
  retentions: ReadonlyArray<Mir.InvocationUseRetention>,
  releases: ReadonlyArray<Release>,
): ReadonlyArray<Release> | undefined => {
  const pending = Array.from(releases)
  if (new Set(pending.map((release) => release.local.ordinal)).size !== pending.length)
    return undefined
  const follows = new Map<number, Set<number>>()
  for (const retention of retentions)
    for (const dependency of [...retention.dependencies, ...retention.environment])
      for (const referent of dependency.referents) {
        if (retention.holder.ordinal === referent.root.ordinal) return undefined
        const predecessors = follows.get(referent.root.ordinal) ?? new Set<number>()
        predecessors.add(retention.holder.ordinal)
        follows.set(referent.root.ordinal, predecessors)
      }
  const ordered: Array<Release> = []
  while (pending.length > 0) {
    const index = pending.findIndex(
      (release) =>
        !pending.some((other) => follows.get(release.local.ordinal)?.has(other.local.ordinal)),
    )
    if (index < 0) return undefined
    const release = pending.splice(index, 1).at(0)
    if (release !== undefined) ordered.push(release)
  }
  return ordered
}

const invocationContentsPartKey = (part: InvocationContents['path'][number]) => {
  if (part._tag === 'Field') return [part._tag, DeclarationFacts.fieldIdKey(part.field)]
  if (part._tag === 'Element') return [part._tag, part.index]
  if (part._tag === 'DeclaredContents') return [part._tag, part.component]
  return [part._tag, part.ordinal]
}

const invocationRetentionText = (retention: Mir.InvocationUseRetention): string =>
  JSON.stringify([
    retention.holder.ordinal,
    retention.invocation.kind,
    retention.invocation.owner,
    AuthoredIdentity.anchorKey(retention.invocation.origin),
    Lifetime.key(retention.invocation.binder),
    Lifetime.key(retention.invocation.lifetime),
    retention.invocation.result.ordinal,
    retention.invocation.inputs.map((input) => [
      input.parameter,
      input.capture ?? null,
      input.header === undefined
        ? null
        : [input.header.parameter, AuthoredIdentity.anchorKey(input.header.source)],
      input.capturePath?.map((step) => [
        step._tag,
        Tir.executableSiteKey(step.site),
        step._tag === 'Capture' ? step.ordinal : null,
      ]) ?? null,
      input.argument.ordinal,
      SilkType.key(input.type),
      input.source === undefined ? null : AuthoredIdentity.anchorKey(input.source),
    ]),
    retention.environment.map((environment) => [
      environment.argument.ordinal,
      environment.referents.map((referent) => [
        referent.root.ordinal,
        suspensionBorrowText(referent.loan),
      ]),
      environment.contents.map((content) => [
        content.parameter,
        content.path.map(invocationContentsPartKey),
        SilkType.key(content.type),
        Lifetime.key(content.region),
      ]),
    ]),
    retention.dependencies.map((dependency) => [
      dependency.parameter,
      dependency.capture ?? null,
      dependency.capturePath?.map((step) => [
        step._tag,
        Tir.executableSiteKey(step.site),
        step._tag === 'Capture' ? step.ordinal : null,
      ]) ?? null,
      dependency.argument.ordinal,
      dependency.referents.map((referent) => [
        referent.root.ordinal,
        suspensionBorrowText(referent.loan),
      ]),
      dependency.contents.map((content) => [
        content.parameter,
        content.path.map(invocationContentsPartKey),
        SilkType.key(content.type),
        Lifetime.key(content.region),
      ]),
    ]),
  ])

/** Source-stable operations across canonical topological region order. */
export const operations = (self: MirFunction): ReadonlyArray<Operation> =>
  topologicalRegions(self).flatMap((region) => operationsOf(region).flatMap(operationTree))

export const outcomes = (self: MirFunction): ReadonlyArray<Outcome> =>
  topologicalRegions(self).flatMap((region) => outcomeOf(region) ?? [])

const outcomeOf = (region: Region): Outcome | undefined =>
  region._tag === 'OperationRegion' || region._tag === 'CleanupRegion' ? region.outcome : undefined

/** Every local named by one operation, including definitions and structured child results. */
const cancellationFinalizerLocals = (finalizer: CancellationFinalizer): ReadonlyArray<LocalId> => [
  ...(finalizer._tag === 'EffectCancellationFinalizer'
    ? [finalizer.effect]
    : [finalizer.resource, finalizer.release]),
  ...finalizer.arguments,
]

/** Locals read while arming a cancellation action; an owned resource is only retained, not read. */
const cancellationFinalizerAccesses = (
  finalizer: CancellationFinalizer,
): ReadonlyArray<LocalId> => [
  ...(finalizer._tag === 'EffectCancellationFinalizer' ? [finalizer.effect] : [finalizer.release]),
  ...finalizer.arguments,
]

export const operationLocals = (operation: Operation): ReadonlyArray<LocalId> => {
  switch (operation._tag) {
    case 'SetInitialized':
      return [operation.flag]
    case 'ForeignStaticLoad':
    case 'ForeignFunctionAddress':
    case 'Literal':
    case 'EnumConstant':
    case 'StaticView':
    case 'StaticString':
      return [operation.destination]
    case 'SliceView':
      return [operation.destination, operation.slice, operation.offset, operation.length]
    case 'StringFromUtf8Unchecked':
      return [operation.destination, operation.bytes]
    case 'StringUtf8Bytes':
    case 'StringByteLength':
      return [operation.destination, operation.string]
    case 'StringEqualsExact':
    case 'EnumEquality':
      return [operation.destination, operation.left, operation.right]
    case 'EnumValue':
      return [operation.destination, operation.source]
    case 'PackEffectComposite':
      return [operation.destination, operation.source]
    case 'UnpackEffectComposite':
      return [operation.destination, operation.matched, operation.source]
    case 'Binary':
      return [operation.destination, operation.left, operation.right]
    case 'ConvertInteger':
    case 'ConvertScalar':
    case 'ReinterpretScalar':
      return [operation.destination, operation.source]
    case 'FloatUnary':
    case 'FloatTranscendental':
      return [operation.destination, operation.source]
    case 'CheckedScalar':
      return [
        operation.destination,
        operation.valid,
        operation.value,
        ...operation.operands,
        operation.present,
        operation.absent,
      ]
    case 'ValidateLayout':
      return [operation.destination, operation.bytes, operation.alignment]
    case 'RepeatLayout':
      return [operation.destination, operation.layout, operation.count]
    case 'Allocate':
      return [operation.destination, operation.layout]
    case 'ForeignIndirectCall':
      return [operation.destination, operation.callee, ...operation.arguments]
    case 'NativeAssembly':
    case 'ForeignCall':
      return [operation.destination, ...operation.arguments]
    case 'RawBufferFrom':
      return [operation.destination, operation.allocation, operation.count]
    case 'SharedFromAllocation':
      return [operation.destination, operation.allocation, operation.value]
    case 'ExecutionFromAllocation':
      return [
        operation.destination,
        operation.allocation,
        operation.body,
        operation.endpoint,
        operation.callback,
      ]
    case 'ExecutionDrive':
      return [
        operation.destination,
        operation.result,
        operation.execution,
        operation.branch,
        operation.onComplete,
        operation.onSuspend,
      ]
    case 'ExecutionNotifyInitial':
      return [operation.destination, operation.execution]
    case 'ExecutionWake':
      return [operation.destination, operation.wake]
    case 'ExecutionPark':
      return [operation.destination, operation.guard, operation.register]
    case 'SharedClone':
      return [operation.destination, operation.self]
    case 'SharedWithMut':
      return [
        operation.destination,
        operation.payload,
        operation.self,
        operation.use,
        operation.onConflict,
      ]
    case 'RawBufferCount':
      return [operation.destination, operation.buffer]
    case 'RawBufferSlot':
      return [operation.destination, operation.buffer, operation.index]
    case 'RawBufferRead':
      return [operation.destination, operation.buffer, operation.index]
    case 'RawBufferView':
      return [operation.destination, operation.buffer, operation.offset, operation.length]
    case 'RawBufferCopy':
      return [
        operation.destination,
        operation.buffer,
        operation.offset,
        operation.source,
        operation.length,
      ]
    case 'RawBufferFill':
      return [
        operation.destination,
        operation.buffer,
        operation.offset,
        operation.length,
        operation.value,
      ]
    case 'PointerNull':
      return [operation.destination]
    case 'DiagnosticUnhandled':
      return [operation.destination]
    case 'PointerAddress':
    case 'PointerIsNull':
    case 'PointerRead':
      return [operation.destination, operation.pointer]
    case 'PointerBytes':
    case 'PointerReinterpret':
    case 'PointerRequalify':
    case 'PointerFromStorage':
      return [operation.destination, operation.source]
    case 'PointerAt':
      return [operation.destination, operation.pointer, operation.count]
    case 'PointerWrite':
      return [operation.destination, operation.pointer, operation.value]
    case 'SlotWrite':
      return [operation.destination, operation.slot, operation.value]
    case 'SlotTake':
    case 'SlotCopy':
      return [operation.destination, operation.slot]
    case 'SlotDrop':
      return [operation.destination, operation.slot]
    case 'Move':
      return [operation.destination, operation.source]
    case 'BeginLoan':
      return [operation.destination, operation.root, ...selectorLocals(operation.selectors)]
    case 'EndLoan':
      return [operation.slice]
    case 'SliceLength':
      return [operation.destination, operation.slice]
    case 'ConvertUnion':
      return [operation.destination, operation.source]
    case 'Call':
      return [operation.destination, ...operation.arguments]
    case 'MakeEffect':
      return [
        operation.destination,
        ...operation.captures.map((capture) => capture.source),
        ...(operation.invocationSource === undefined
          ? []
          : operationLocals(operation.invocationSource)),
      ]
    case 'MakeCallable':
      return [
        operation.destination,
        ...(operation.base === undefined ? [] : [operation.base]),
        ...operation.captures.map((capture) => capture.source),
      ]
    case 'ApplyCallable':
      return [
        operation.destination,
        ...(operation.callable === undefined ? [] : [operation.callable]),
        ...operation.captures.map((capture) => capture.source),
        ...operation.arguments,
      ]
    case 'PackEffectOutcome':
    case 'PackEffectFailureUnion':
    case 'UnpackEffectSuccess':
      return [operation.destination, operation.source]
    case 'PropagateEffectFailure':
      return [
        operation.source,
        operation.outcome,
        ...(operation.releases ?? []).map((release) => release.local),
      ]
    case 'RunEffect':
      return [operation.destination, operation.outcome, ...operation.arguments]
    case 'RunEffectValue':
      return [
        operation.destination,
        operation.outcome,
        operation.effect,
        ...operation.arguments,
        ...(operation.cancellationFinalizer === undefined
          ? []
          : cancellationFinalizerLocals(operation.cancellationFinalizer)),
      ]
    case 'RunEffectComposite':
      return [
        operation.destination,
        operation.outcome,
        operation.effect,
        ...operation.alternatives.flatMap((alternative) => alternative.arguments),
      ]
    case 'RunStaticEffect':
      return [
        operation.destination,
        operation.outcome,
        ...operation.captures.map((capture) => capture.source),
        ...operation.arguments,
      ]
    case 'CatchEffect':
      return [
        operation.destination,
        operation.outcome,
        operation.successValue,
        operation.failureValue,
        operation.effect,
        ...operation.arguments,
        ...(operation.cancellationFinalizer === undefined
          ? []
          : cancellationFinalizerLocals(operation.cancellationFinalizer)),
      ]
    case 'Construct':
    case 'ConstructUnionVariant':
      return [operation.destination, ...operation.fields.map((field) => field.value)]
    case 'ConstructArray':
      return [operation.destination, ...operation.elements]
    case 'Project':
      return [operation.destination, operation.source]
    case 'ReadPlace':
      return [operation.destination, operation.root, ...selectorLocals(operation.selectors)]
    case 'CheckPlace':
      return [operation.root, ...selectorLocals(operation.selectors)]
    case 'WritePlace':
      return [operation.root, operation.source, ...selectorLocals(operation.selectors)]
    case 'Drop':
      return [
        operation.local,
        ...selectorLocals(operation.selectors ?? []),
        ...(operation.initialization?.flags.map((flag) => flag.local) ?? []),
      ]
    case 'Match':
      return [
        ...(operation.destination === undefined ? [] : [operation.destination]),
        operation.scrutinee,
        ...selectorLocals(operation.selectors ?? []),
        ...operation.arms.flatMap((arm) => [
          ...arm.bindings.map((binding) => binding.destination),
          ...(arm.guard?.execution.result === undefined ? [] : [arm.guard.execution.result]),
          ...(arm.selected.execution.result === undefined ? [] : [arm.selected.execution.result]),
          ...(arm.guard?.execution.recoveryOutcome === undefined
            ? []
            : [arm.guard.execution.recoveryOutcome]),
          ...(arm.selected.execution.recoveryOutcome === undefined
            ? []
            : [arm.selected.execution.recoveryOutcome]),
          ...arm.cleanupBindings.map((binding) => binding.destination),
          ...arm.selected.cleanup.map((entry) => entry.destination),
        ]),
      ]
    case 'DiagnosticScope':
      return [
        operation.destination,
        operation.state,
        operation.observer,
        ...(operation.body.result === undefined ? [] : [operation.body.result]),
        ...(operation.body.recoveryOutcome === undefined ? [] : [operation.body.recoveryOutcome]),
      ]
    case 'Conditional':
      return [
        operation.destination,
        operation.condition,
        ...(operation.taken.result === undefined ? [] : [operation.taken.result]),
        ...(operation.otherwise.result === undefined ? [] : [operation.otherwise.result]),
        ...(operation.taken.recoveryOutcome === undefined ? [] : [operation.taken.recoveryOutcome]),
        ...(operation.otherwise.recoveryOutcome === undefined
          ? []
          : [operation.otherwise.recoveryOutcome]),
      ]
    case 'ShortCircuit':
      return [
        operation.destination,
        operation.left,
        ...(operation.right.result === undefined ? [] : [operation.right.result]),
        ...(operation.right.recoveryOutcome === undefined ? [] : [operation.right.recoveryOutcome]),
      ]
  }
}

const localUses = (region: Region): ReadonlyArray<LocalId> => [
  ...operationsOf(region).flatMap(operationTree).flatMap(operationLocals),
  ...(region._tag === 'ConditionalRegion' ? [region.condition] : []),
  ...(region._tag === 'LoopRegion' ? [region.conditionValue] : []),
  ...(outcomeOf(region)?._tag === 'Return'
    ? [(outcomeOf(region) as Extract<Outcome, { readonly _tag: 'Return' }>).value]
    : []),
]

const selectorLocals = (selectors: ReadonlyArray<PlaceSelector>): ReadonlyArray<LocalId> =>
  selectors.flatMap((selector) => {
    if (selector._tag === 'ElementSelector' && selector.index._tag === 'Runtime') {
      return [selector.index.local]
    }
    if (selector._tag === 'SliceElementSelector') return [selector.index]
    return []
  })

const samePlaceSelector = (left: PlaceSelector, right: PlaceSelector): boolean => {
  if (left._tag !== right._tag) return false
  if (left._tag === 'VariantSelector' && right._tag === 'VariantSelector')
    return left.ordinal === right.ordinal
  if (left._tag === 'FieldSelector' && right._tag === 'FieldSelector')
    return DeclarationFacts.sameFieldId(left.field, right.field)
  if (left._tag === 'SliceElementSelector' && right._tag === 'SliceElementSelector')
    return left.index.ordinal === right.index.ordinal && left.access === right.access
  if (left._tag !== 'ElementSelector' || right._tag !== 'ElementSelector') return false
  if (left.length !== right.length || left.index._tag !== right.index._tag) return false
  return left.index._tag === 'Proven' && right.index._tag === 'Proven'
    ? left.index.value === right.index.value
    : left.index._tag === 'Runtime' &&
        right.index._tag === 'Runtime' &&
        left.index.local.ordinal === right.index.local.ordinal
}

const samePlaceSelectors = (
  left: ReadonlyArray<PlaceSelector>,
  right: ReadonlyArray<PlaceSelector>,
): boolean =>
  left.length === right.length &&
  left.every((selector, ordinal) => {
    const candidate = right.at(ordinal)
    return candidate !== undefined && samePlaceSelector(selector, candidate)
  })

const placeType = (
  fn: MirFunction,
  layout: Layout.Plan,
  root: LocalId,
  selectors: ReadonlyArray<PlaceSelector>,
  dereferenceReference = false,
): DeclarationFacts.SemanticType | undefined => {
  const rootType = fn.localTypes.at(root.ordinal)
  let current = rootType === undefined ? undefined : semanticType(rootType)
  let variant:
    | Extract<Layout.Representation, { readonly _tag: 'NominalUnion' }>['variants'][number]
    | undefined
  // A reference root reads and writes through the borrow, so the place is on its target.
  if (
    current !== undefined &&
    SilkType.isReference(current) &&
    (selectors.length > 0 || dereferenceReference)
  ) {
    current = current.target
  }
  for (const selector of selectors) {
    if (selector._tag === 'VariantSelector') {
      if (current === undefined) return undefined
      if (SilkType.isUnion(current)) {
        current = current.members.at(selector.ordinal)
      } else {
        const representation = Layout.entry(layout, current)?.representation
        if (representation?._tag !== 'NominalUnion') return undefined
        variant = representation.variants.find(
          (candidate) => candidate.ordinal === selector.ordinal,
        )
        if (variant === undefined) return undefined
      }
      continue
    }
    if (selector._tag === 'FieldSelector') {
      const entry =
        current !== undefined && SilkType.isNominal(current)
          ? Layout.entry(layout, current)
          : undefined
      const fields =
        variant?.fields ??
        (entry?.representation._tag === 'Aggregate' ? entry.representation.fields : [])
      const field = fields.find((candidate) =>
        DeclarationFacts.sameFieldId(candidate.id, selector.field),
      )
      current = field?.type
      variant = undefined
      continue
    }
    if (selector._tag === 'SliceElementSelector') {
      if (
        current === undefined ||
        !SilkType.isSlice(current) ||
        current.access !== selector.access ||
        fn.localTypes.at(selector.index.ordinal)?._tag !== 'usize'
      ) {
        return undefined
      }
      current = current.element
      continue
    }
    if (
      current === undefined ||
      !SilkType.isFixedArray(current) ||
      current.length !== selector.length
    ) {
      return undefined
    }
    if (selector.index._tag === 'Proven') {
      if (selector.index.value < 0 || selector.index.value >= selector.length) return undefined
    } else if (fn.localTypes.at(selector.index.local.ordinal)?._tag !== 'usize') return undefined
    current = current.element
  }
  return current
}

const fieldPathType = (
  layout: Layout.Plan,
  root: DeclarationFacts.SemanticType,
  path: ReadonlyArray<DeclarationFacts.FieldId>,
): DeclarationFacts.SemanticType | undefined => {
  return Layout.coveragePath(layout, root, Match.structuralMember(root), path)?.type
}

const coverageFieldPathType = (
  layout: Layout.Plan,
  member: Match.CoverageIdentity,
  path: ReadonlyArray<DeclarationFacts.FieldId>,
): DeclarationFacts.SemanticType | undefined => {
  return Layout.coveragePath(layout, Match.sourceType(member), member, path)?.type
}

const sameMembers = (
  left: ReadonlyArray<SilkType.Type>,
  right: ReadonlyArray<SilkType.Type>,
): boolean =>
  left.length === right.length &&
  left.every((member, ordinal) => {
    const candidate = right.at(ordinal)
    return candidate !== undefined && SilkType.equals(member, candidate)
  })

const sameCoverage = (
  left: ReadonlyArray<Match.CoverageIdentity>,
  right: ReadonlyArray<Match.CoverageIdentity>,
): boolean =>
  left.length === right.length &&
  left.every((member, ordinal) => {
    const candidate = right.at(ordinal)
    return candidate !== undefined && Match.identityEquals(member, candidate, 'Runtime')
  })

const enumRepresentationMatches = (
  left: Extract<Layout.Representation, { readonly _tag: 'ScalarEnum' }>,
  right: Extract<Layout.Representation, { readonly _tag: 'ScalarEnum' }>,
): boolean =>
  left.enum.module === right.enum.module &&
  left.enum.name === right.enum.name &&
  left.scalar === right.scalar &&
  left.bits === right.bits &&
  left.signedness === right.signedness &&
  left.members.length === right.members.length &&
  left.members.every((member, ordinal) => {
    const candidate = right.members.at(ordinal)
    return (
      candidate !== undefined &&
      member.member.enum.module === candidate.member.enum.module &&
      member.member.enum.name === candidate.member.enum.name &&
      member.member.name === candidate.member.name &&
      member.discriminant === candidate.discriminant
    )
  })

export const targetText = (target: DeclarationFacts.CanonicalId): string =>
  `${target.module}.${target.name}`

export const callableTargetText = (target: Tir.CallableTarget): string =>
  target._tag === 'DeclarationCallableTarget'
    ? targetText(target.declaration)
    : `${target.actor}.${target.operation}`

const storedCallableTargetText = (target: SilkType.CallableIdentityArgument['target']): string =>
  callableTargetText(Tir.callableTargetFromIdentity(target))

export const storedExecutableText = (
  stored: NonNullable<
    Extract<Operation, { readonly _tag: 'Construct' }>['fields'][number]['stored']
  >,
): string =>
  stored._tag === 'StoredCallableField'
    ? storedCallableTargetText(stored.realization.target)
    : targetText(stored.realization.runner)

const borrowKey = (borrow: Tir.BorrowId): string => Tir.borrowKey(borrow)

export const instanceText = Instances.keyText

const localText = (local: LocalId): string => `%${local.ordinal}`

// MIR verifies physical contracts after source lifetime obligations have been discharged.
const sameRuntimeType = (left: SilkType.Type, right: SilkType.Type): boolean =>
  SilkType.runtimeKey(left) === SilkType.runtimeKey(right)

const cleanupTypes = (cleanup: CleanupPlan.CleanupPlan): ReadonlyArray<SilkType.Type> => {
  switch (cleanup._tag) {
    case 'NoCleanup':
    case 'ParameterCleanup':
    case 'AllocationCleanup':
      return [cleanup.type]
    case 'RawBufferCleanup':
      return [cleanup.type, ...cleanupTypes(cleanup.allocation)]
    case 'LocalSharedCoreCleanup':
      return [cleanup.type, cleanup.element, ...cleanupTypes(cleanup.allocation)]
    case 'ExecutionCleanup':
      return [cleanup.type, ...cleanupTypes(cleanup.allocation)]
    case 'WakeCleanup':
      return [cleanup.type, ...cleanupTypes(cleanup.allocation)]
    case 'HookCleanup':
      return [cleanup.type, ...cleanupTypes(cleanup.inner)]
    case 'StructCleanup':
      return [cleanup.type, ...cleanup.fields.flatMap((field) => cleanupTypes(field.cleanup))]
    case 'NominalUnionCleanup':
      return [
        cleanup.type,
        ...cleanup.variants.flatMap((variant) =>
          variant.fields.flatMap((field) => cleanupTypes(field.cleanup)),
        ),
      ]
    case 'ArrayCleanup':
      return [cleanup.type, ...cleanupTypes(cleanup.element)]
    case 'UnionCleanup':
      return [cleanup.type, ...cleanup.cases.flatMap((entry) => cleanupTypes(entry.cleanup))]
    case 'CallableCleanup':
    case 'EffectCleanup':
      return [cleanup.type, ...cleanup.slots.flatMap((slot) => cleanupTypes(slot.cleanup))]
    case 'EffectCompositeCleanup':
      return [
        cleanup.type,
        ...cleanup.alternatives.flatMap((alternative) => cleanupTypes(alternative)),
      ]
    case 'RepresentedCallableCleanup':
    case 'RepresentedEffectCleanup':
      return [cleanup.type, cleanup.contract]
  }
}

type EffectEnvironment = Extract<Layout.EffectEnvironment, { readonly _tag: 'EffectEnvironment' }>

const effectEnvironmentByIdentity = (
  layout: Layout.Plan,
  identity: string,
): EffectEnvironment | undefined =>
  layout.effectEnvironments.find(
    (candidate): candidate is EffectEnvironment =>
      candidate._tag === 'EffectEnvironment' &&
      (Instances.effectIdentity(candidate.instance, candidate.site) === identity ||
        candidate.successEffectIdentity === identity),
  )

// Offsets must mirror the runner ABI exactly, so the count comes from the same Layout helper
// that materializes environment lanes for cleanup emission and the backends — never re-derived.
const effectFieldLaneCount = (layout: Layout.Plan, field: Layout.EffectEnvironmentField): number =>
  Layout.effectFieldLanes(layout, field).length

const callableEnvironmentCleanupValid = (
  layout: Layout.Plan,
  identity: SilkType.CallableIdentityArgument,
  expectedType: SilkType.Callable,
  cleanup: CleanupPlan.CleanupPlan,
  active: ReadonlySet<string>,
): boolean => {
  const environment = Layout.callableEnvironmentMatching(layout, identity)
  if (environment === undefined || cleanup._tag !== 'CallableCleanup') return false
  const environmentIdentity = Instances.callableEnvironmentIdentity(environment.callable)
  const key = `callable:${SilkType.callableEnvironmentKey(environmentIdentity)}`
  if (active.has(key)) return false
  const expected = [...environment.fields]
    .reverse()
    .filter((field) => field.access === 'Take' && !isCopy(layout, field.type))
  const next = new Set(active).add(key)
  return (
    SilkType.equals(cleanup.type, expectedType) &&
    cleanup.environment._tag === 'CallableEnvironmentIdentity' &&
    SilkType.equalsCallableEnvironmentIdentity(cleanup.environment.identity, environmentIdentity) &&
    cleanup.slots.length === expected.length &&
    cleanup.slots.every((slot, ordinal) => {
      const field = expected.at(ordinal)
      return (
        field !== undefined &&
        slot.ordinal === field.ordinal &&
        cleanupMatchesSemanticType(layout, slot.cleanup, field.type, next)
      )
    })
  )
}

const executableFieldCleanupValid = (
  layout: Layout.Plan,
  field: Layout.EffectEnvironmentField,
  cleanup: CleanupPlan.CleanupPlan,
  active: ReadonlySet<string>,
): boolean => {
  if (field.effectIdentity !== undefined) {
    const environment = effectEnvironmentByIdentity(layout, field.effectIdentity)
    return (
      environment !== undefined &&
      effectEnvironmentCleanupValid(layout, field.effectIdentity, environment, cleanup, active)
    )
  }
  if (field.callableIdentity !== undefined && SilkType.isCallable(field.type))
    return callableEnvironmentCleanupValid(
      layout,
      field.callableIdentity,
      field.type,
      cleanup,
      active,
    )
  return cleanupMatchesSemanticType(layout, cleanup, field.type, active)
}

const effectEnvironmentCleanupValid = (
  layout: Layout.Plan,
  identity: string,
  environment: EffectEnvironment,
  cleanup: CleanupPlan.CleanupPlan,
  active: ReadonlySet<string>,
): boolean => {
  const key = `effect:${identity}`
  if (active.has(key))
    return cleanup._tag === 'NoCleanup' && SilkType.equals(cleanup.type, environment.effect)
  const next = new Set(active).add(key)
  let laneOffset = 0
  const expected = environment.fields.flatMap((field, ordinal) => {
    const laneCount = effectFieldLaneCount(layout, field)
    const currentOffset = laneOffset
    laneOffset += laneCount
    const noCleanup: CleanupPlan.CleanupPlan = {
      _tag: 'NoCleanup',
      type: field.type,
    }
    return field.representation === 'Borrow' ||
      executableFieldCleanupValid(layout, field, noCleanup, next)
      ? []
      : [{ field, ordinal, laneOffset: currentOffset, laneCount }]
  })
  if (expected.length === 0)
    return cleanup._tag === 'NoCleanup' && SilkType.equals(cleanup.type, environment.effect)
  return (
    cleanup._tag === 'EffectCleanup' &&
    SilkType.equals(cleanup.type, environment.effect) &&
    Tir.sameExecutableSite(cleanup.site, environment.site) &&
    cleanup.slots.length === expected.length &&
    cleanup.slots.every((slot, ordinal) => {
      const candidate = [...expected].reverse().at(ordinal)
      return (
        candidate !== undefined &&
        slot.ordinal === candidate.ordinal &&
        slot.laneOffset === candidate.laneOffset &&
        slot.laneCount === candidate.laneCount &&
        executableFieldCleanupValid(layout, candidate.field, slot.cleanup, next)
      )
    })
  )
}

const cleanupMatchesSemanticType = (
  layout: Layout.Plan,
  cleanup: CleanupPlan.CleanupPlan,
  type: DeclarationFacts.SemanticType,
  seen: ReadonlySet<string> = new Set(),
): boolean => {
  if (SilkType.isRepresented(type)) {
    if (isCopy(layout, type) && cleanup._tag === 'NoCleanup' && SilkType.equals(cleanup.type, type))
      return true
    const composite = type.representation.argument
    if (SilkType.isCompositeEffectRepresentationArgument(composite)) {
      if (
        cleanup._tag !== 'EffectCompositeCleanup' ||
        !SilkType.equals(cleanup.type, type) ||
        cleanup.alternatives.length !== composite.alternatives.length
      )
        return false
      return composite.alternatives.every((alternative, ordinal) => {
        if (!SilkType.isEffectIdentityArgument(alternative.identity)) return false
        const identity = alternative.identity
        const environment = layout.effectEnvironments.find(
          (candidate): candidate is EffectEnvironment =>
            candidate._tag === 'EffectEnvironment' &&
            Tir.effectRepresentationIdentity(candidate.site) === identity.identity &&
            identity.owner !== undefined &&
            candidate.instance.declaration.module === identity.owner.declaration.module &&
            candidate.instance.declaration.name === identity.owner.declaration.name &&
            candidate.instance.typeArguments.length === identity.owner.typeArguments.length &&
            candidate.instance.typeArguments.every((argument, argumentOrdinal) => {
              const expected = identity.owner?.typeArguments.at(argumentOrdinal)
              return expected !== undefined && SilkType.equalsGenericArgument(argument, expected)
            }) &&
            candidate.instance.staticArguments.length ===
              identity.owner.staticArgumentKeys.length &&
            candidate.instance.staticArguments.every(
              (argument, argumentOrdinal) =>
                StaticValue.key(argument) ===
                identity.owner?.staticArgumentKeys.at(argumentOrdinal),
            ),
        )
        const selected = cleanup.alternatives.at(ordinal)
        return (
          environment !== undefined &&
          selected !== undefined &&
          effectEnvironmentCleanupValid(
            layout,
            Instances.effectIdentity(environment.instance, environment.site),
            environment,
            selected,
            seen,
          )
        )
      })
    }
    const entry = Layout.entry(layout, type)
    const executable = entry?.executable
    if (executable?._tag === 'Callable')
      return (
        (cleanup._tag === 'CallableCleanup' || cleanup._tag === 'NoCleanup') &&
        TypeCompatibility.isCompatible(TypeCompatibility.check(type.contract, cleanup.type))
      )
    if (executable?._tag === 'Effect')
      return (
        (cleanup._tag === 'EffectCleanup' || cleanup._tag === 'NoCleanup') &&
        TypeCompatibility.isCompatible(TypeCompatibility.check(type.contract, cleanup.type))
      )
    const representation = entry?.representation
    const contractValid = TypeCompatibility.isCompatible(
      TypeCompatibility.check(type.contract, cleanup.type),
    )
    if (representation?._tag === 'CallableEnvironment')
      return (cleanup._tag === 'CallableCleanup' || cleanup._tag === 'NoCleanup') && contractValid
    if (representation?._tag === 'StoredEffectEnvironment')
      return (
        contractValid &&
        (cleanup._tag === 'EffectCleanup'
          ? storedEffectCleanupPlanValid(layout, type, representation, cleanup)
          : cleanup._tag === 'NoCleanup' &&
            representation.realization.cleanup.unrunLanes.length === 0)
      )
    return false
  }
  // Layout fields and hooks share canonical runtime identity across erased lifetime origins.
  if (isCopy(layout, type) && !SilkType.isUnion(type))
    return cleanup._tag === 'NoCleanup' && sameRuntimeType(cleanup.type, type)
  if (!sameRuntimeType(cleanup.type, type)) return false
  if (
    SilkType.isBuiltin(type) ||
    SilkType.isString(type) ||
    SilkType.isNever(type) ||
    SilkType.isSlice(type) ||
    SilkType.isReference(type) ||
    SilkType.isEffect(type) ||
    SilkType.isCallable(type)
  )
    return cleanup._tag === 'NoCleanup'
  if (SilkType.equals(type, SilkType.allocation)) return cleanup._tag === 'AllocationCleanup'
  if (SilkType.isRawBuffer(type)) return cleanup._tag === 'RawBufferCleanup'
  if (SilkType.isSharedCore(type)) {
    const element = SilkType.typeArgumentAt(type, 0)
    return (
      cleanup._tag === 'LocalSharedCoreCleanup' &&
      element !== undefined &&
      sameRuntimeType(cleanup.element, element) &&
      cleanup.allocation._tag === 'AllocationCleanup'
    )
  }
  if (SilkType.isExecution(type))
    return cleanup._tag === 'ExecutionCleanup' && cleanup.allocation._tag === 'AllocationCleanup'
  if (SilkType.isWake(type))
    return cleanup._tag === 'WakeCleanup' && cleanup.allocation._tag === 'AllocationCleanup'
  if (SilkType.isFixedArray(type))
    return (
      cleanup._tag === 'ArrayCleanup' &&
      cleanup.length === type.length &&
      cleanupMatchesSemanticType(layout, cleanup.element, type.element, seen)
    )
  if (SilkType.isUnion(type))
    return (
      cleanup._tag === 'UnionCleanup' &&
      cleanup.cases.length === type.members.length &&
      cleanup.cases.every((entry, ordinal) => {
        const member = type.members.at(ordinal)
        return (
          member !== undefined &&
          entry.ordinal === ordinal &&
          sameRuntimeType(entry.member, member) &&
          cleanupMatchesSemanticType(layout, entry.cleanup, member, seen)
        )
      })
    )
  if (!SilkType.isNominal(type)) return cleanup._tag === 'NoCleanup'
  const key = SilkType.runtimeKey(type)
  if (seen.has(key)) return cleanup._tag === 'NoCleanup'
  const representation = Layout.entry(layout, type)?.representation
  if (representation?._tag === 'NominalUnion') {
    const requiredHook = representation.cleanupHook
    if (requiredHook !== undefined) {
      if (
        cleanup._tag !== 'HookCleanup' ||
        cleanup.hook.module !== requiredHook.hook.module ||
        cleanup.hook.name !== requiredHook.hook.name ||
        cleanup.typeArguments.length !== requiredHook.typeArguments.length ||
        !cleanup.typeArguments.every((argument, ordinal) => {
          const expected = requiredHook.typeArguments.at(ordinal)
          return (
            expected !== undefined &&
            SilkType.runtimeGenericArgumentKey(argument) ===
              SilkType.runtimeGenericArgumentKey(expected)
          )
        })
      )
        return false
    } else if (cleanup._tag === 'HookCleanup') return false
    const concrete = cleanup._tag === 'HookCleanup' ? cleanup.inner : cleanup
    if (
      concrete._tag !== 'NominalUnionCleanup' ||
      concrete.variants.length !== representation.variants.length
    )
      return false
    const next = new Set(seen).add(key)
    return concrete.variants.every((variant, ordinal) => {
      const expected = representation.variants.at(ordinal)
      return (
        expected !== undefined &&
        variant.ordinal === expected.ordinal &&
        variant.variant.union.module === expected.variant.union.module &&
        variant.variant.union.name === expected.variant.union.name &&
        variant.variant.name === expected.variant.name &&
        variant.fields.length === expected.fields.length &&
        variant.fields.every((field, fieldOrdinal) => {
          const expectedField = expected.fields.at(fieldOrdinal)
          return (
            expectedField !== undefined &&
            DeclarationFacts.sameFieldId(field.field, expectedField.id) &&
            cleanupMatchesSemanticType(layout, field.cleanup, expectedField.type, next)
          )
        })
      )
    })
  }
  if (representation?._tag !== 'Aggregate') return cleanup._tag === 'NoCleanup'
  const requiredHook = representation.cleanupHook
  if (requiredHook !== undefined) {
    if (
      cleanup._tag !== 'HookCleanup' ||
      cleanup.hook.module !== requiredHook.hook.module ||
      cleanup.hook.name !== requiredHook.hook.name ||
      cleanup.typeArguments.length !== requiredHook.typeArguments.length ||
      !cleanup.typeArguments.every((argument, ordinal) => {
        const expected = requiredHook.typeArguments.at(ordinal)
        return (
          expected !== undefined &&
          SilkType.runtimeGenericArgumentKey(argument) ===
            SilkType.runtimeGenericArgumentKey(expected)
        )
      })
    )
      return false
  } else if (cleanup._tag === 'HookCleanup') return false
  const concrete = cleanup._tag === 'HookCleanup' ? cleanup.inner : cleanup
  if (concrete._tag !== 'StructCleanup' || concrete.fields.length !== representation.fields.length)
    return false
  const next = new Set(seen).add(key)
  return concrete.fields.every((field, ordinal) => {
    const expected = representation.fields.at(ordinal)
    return (
      expected !== undefined &&
      DeclarationFacts.sameFieldId(field.field, expected.id) &&
      cleanupMatchesSemanticType(layout, field.cleanup, expected.type, next)
    )
  })
}

const storedEffectCleanupPlanValid = (
  layout: Layout.Plan,
  type: SilkType.Represented,
  representation: Extract<Layout.Representation, { readonly _tag: 'StoredEffectEnvironment' }>,
  cleanup: Extract<CleanupPlan.CleanupPlan, { readonly _tag: 'EffectCleanup' }>,
): boolean => {
  if (!Tir.sameExecutableSite(cleanup.site, representation.realization.site)) return false
  const shape = Layout.callingShape(layout, type)?.tree
  if (shape?._tag !== 'EffectEnvironmentShape') return false
  const ranges = representation.fields.map((field, ordinal) => {
    const fieldShape = shape.fields.at(ordinal)
    const laneOffset = shape.fields
      .slice(0, ordinal)
      .reduce((total, candidate) => total + candidate.shape.laneCount, 0)
    return { field, fieldShape, laneOffset }
  })
  const expected = [...representation.realization.cleanup.unrunLanes].reverse().flatMap((owned) => {
    const range = ranges.find((candidate) => candidate.field.capture === owned)
    return range === undefined ? [] : [{ owned, ...range }]
  })
  const active = new Set([`effect:${representation.realization.runnerIdentity}`])
  return (
    expected.length === representation.realization.cleanup.unrunLanes.length &&
    cleanup.slots.length === expected.length &&
    cleanup.slots.every((slot, ordinal) => {
      const candidate = expected.at(ordinal)
      return (
        candidate !== undefined &&
        candidate.fieldShape !== undefined &&
        slot.ordinal === candidate.owned &&
        slot.laneOffset === candidate.laneOffset &&
        slot.laneCount === candidate.fieldShape.shape.laneCount &&
        executableFieldCleanupValid(layout, candidate.field, slot.cleanup, active)
      )
    })
  )
}

const storedEffectCleanupValid = (
  layout: Layout.Plan,
  dropped: Extract<Type, { readonly _tag: 'EffectValue' }> | undefined,
  cleanup: Extract<CleanupPlan.CleanupPlan, { readonly _tag: 'EffectCleanup' }>,
): boolean => {
  const storage = dropped?.storage
  const representation =
    storage === undefined ? undefined : Layout.entry(layout, storage.type)?.representation
  return (
    storage !== undefined &&
    representation?._tag === 'StoredEffectEnvironment' &&
    storedEffectCleanupPlanValid(layout, storage.type, representation, cleanup)
  )
}

/**
 * Whether a callable construction names exactly the environment it realizes.
 *
 * With an environment, the target arguments are that environment's identity followed by the
 * identities of the callables it captured. The identity segment is checked as the environment's
 * own callable identity, where a section binder owned by the constructed target is closed; every
 * captured identity is checked on its own. Nothing else admits a section binder.
 */
const constructionTargetArgumentsConcrete = (
  operation: Extract<Operation, { readonly _tag: 'MakeCallable' }>,
): boolean => {
  const environment = operation.type.environment
  if (environment === undefined)
    return operation.typeArguments.every(SilkType.isRuntimeConcreteGenericArgument)
  const expected = Layout.callableTargetArguments(environment)
  if (
    !Tir.sameCallableTarget(operation.target, environment.callable.target) ||
    expected.length !== operation.typeArguments.length ||
    expected.some(
      (argument, ordinal) =>
        SilkType.genericArgumentKey(argument) !==
        SilkType.genericArgumentKey(operation.typeArguments[ordinal] ?? argument),
    )
  )
    return false
  const identityLength = environment.callable.typeArguments.length
  return (
    SilkType.isRuntimeConcreteGenericArgument(
      SilkType.callableIdentityArgument(
        '',
        Tir.callableTargetIdentity(operation.target),
        operation.typeArguments.slice(0, identityLength),
      ),
    ) &&
    operation.typeArguments.slice(identityLength).every(SilkType.isRuntimeConcreteGenericArgument)
  )
}

/**
 * The hidden callable identity an instance key carries for one callable parameter.
 *
 * Mirrors Instances.parameterCallableIdentity on a lowered function: callable parameters are
 * those whose type is a callable contract, and the key names their identities in parameter order
 * among its callable identity arguments.
 */
const parameterCallableIdentity = (
  fn: MirFunction,
  ordinal: number,
): SilkType.CallableIdentityArgument | undefined => {
  const callables = fn.localTypes
    .slice(0, fn.parameterCount)
    .flatMap((type, parameter) => (SilkType.isCallable(semanticType(type)) ? [parameter] : []))
  const position = callables.indexOf(ordinal)
  return position < 0
    ? undefined
    : fn.instance.typeArguments.filter(SilkType.isCallableIdentityArgument).at(position)
}

/** A captured callable names exactly the identity its invoked parameter position carries. */
const capturedIdentityMatches = (
  field: Layout.CallableEnvironmentField,
  expected: SilkType.CallableIdentityArgument | undefined,
): boolean => {
  if (field.representation !== 'Callable' && field.callableIdentity === undefined) return true
  return (
    field.callableIdentity !== undefined &&
    expected !== undefined &&
    SilkType.genericArgumentKey(field.callableIdentity) === SilkType.genericArgumentKey(expected)
  )
}

/** Whether a captured environment field passes to its parameter as the backend passes it. */
const capturedFieldPasses = (
  field: Layout.CallableEnvironmentField,
  parameter: DeclarationFacts.SemanticType,
): boolean => {
  if (field.representation === 'Borrow')
    return (
      SilkType.isReference(parameter) &&
      parameter.access === field.access &&
      acceptsRuntimeOperand(field.type, parameter.target)
    )
  if (field.representation === 'Callable') return acceptsRuntimeOperand(field.type, parameter)
  // Layout stores a shared or exclusive capture by value only when the captured value is itself a
  // reference or slice (`Layout.borrowedCapture`); the backend passes it as stored, so its own
  // access must be the captured access.
  const descriptorAccess =
    SilkType.isReference(field.type) || SilkType.isSlice(field.type) ? field.type.access : undefined
  return (
    (field.access === 'Take' ||
      field.access === 'Copy' ||
      ((field.access === 'Shared' || field.access === 'Exclusive') &&
        descriptorAccess === field.access)) &&
    acceptsRuntimeOperand(field.type, parameter)
  )
}

/**
 * Whether an application invokes a section environment named before its application.
 *
 * The environment's identity keeps the section's unapplied binders, so its value type cannot
 * describe any one application. The application instead names the complete instance it invokes;
 * that instance must instantiate the environment identity exactly, accept every captured field in
 * its captured parameter position as the backend passes it, and its remaining parameters and
 * result are the application's contract.
 */
const invokesPreApplicationEnvironment = (
  self: Module,
  operation: Extract<Operation, { readonly _tag: 'ApplyCallable' }>,
  source: Type | undefined,
): boolean => {
  if (
    operation.realization !== 'Environment' ||
    operation.callable === undefined ||
    operation.target !== undefined ||
    operation.captures.length > 0 ||
    source?._tag !== 'CallableValue' ||
    source.environment === undefined
  )
    return false
  const environment = source.environment
  const target = environment.callable.target
  if (target._tag !== 'DeclarationCallableTarget' || !Tir.sameCallableTarget(source.target, target))
    return false
  const identityTarget = Tir.callableTargetIdentity(target)
  const identity = environment.callable.typeArguments
  if (
    !SilkType.namesUnappliedSection(SilkType.callableIdentityArgument('', identityTarget, identity))
  )
    return false
  const invoked = self.functions.find((candidate) =>
    matchesInstance(candidate, target.declaration, operation.typeArguments),
  )
  if (
    invoked === undefined ||
    !SilkType.instantiatesSectionIdentity(identityTarget, identity, operation.typeArguments)
  )
    return false
  const captured = environment.fields.map((field) => field.parameterOrdinal)
  if (
    new Set(captured).size !== captured.length ||
    captured.some((ordinal) => ordinal < 0 || ordinal >= invoked.parameterCount)
  )
    return false
  const remaining = Array.from({ length: invoked.parameterCount }, (_, ordinal) => ordinal).filter(
    (ordinal) => !captured.includes(ordinal),
  )
  // The declared result names the same contract as the realized value; an Effect result's run
  // access and lifetime proofs are non-runtime facts (matchesCall pins its realization).
  const declared = operation.callableType.result
  const realized = semanticType(operation.type)
  return (
    (SilkType.isEffect(declared) && SilkType.isEffect(realized)
      ? EffectExecutionContract.equals(declared, realized)
      : SilkType.runtimeKey(declared) === SilkType.runtimeKey(realized)) &&
    operation.callableType.parameters.length === remaining.length &&
    remaining.every((ordinal, position) => {
      const parameter = invoked.localTypes.at(ordinal)
      const applied = operation.callableType.parameters.at(position)
      return (
        parameter !== undefined &&
        applied !== undefined &&
        SilkType.runtimeKey(applied) === SilkType.runtimeKey(semanticType(parameter))
      )
    }) &&
    environment.fields.every((field) => {
      const parameter = invoked.localTypes.at(field.parameterOrdinal)
      return (
        parameter !== undefined &&
        capturedFieldPasses(field, semanticType(parameter)) &&
        capturedIdentityMatches(field, parameterCallableIdentity(invoked, field.parameterOrdinal))
      )
    }) &&
    matchesCall(invoked, target.declaration, operation.typeArguments, undefined, operation.type) &&
    operation.access === source.type.mode &&
    operation.callableType.unsafe === source.type.unsafe
  )
}

const operationTypes = (operation: Operation): ReadonlyArray<DeclarationFacts.SemanticType> => {
  switch (operation._tag) {
    case 'SetInitialized':
      return ['bool']
    case 'ForeignStaticLoad':
    case 'ForeignFunctionAddress':
    case 'Literal':
    case 'EnumConstant':
    case 'StaticView':
    case 'Binary':
    case 'ValidateLayout':
    case 'RepeatLayout':
    case 'Allocate':
    case 'NativeAssembly':
    case 'ForeignIndirectCall':
    case 'ForeignCall':
    case 'Project':
    case 'ReadPlace':
    case 'CheckPlace':
      return [semanticType(operation.type)]
    case 'StaticString':
      return [operation.type.type]
    case 'PackEffectComposite':
      return [semanticType(operation.type)]
    case 'UnpackEffectComposite':
      return [semanticType(operation.type), 'bool']
    case 'StringFromUtf8Unchecked':
      return [SilkType.slice('Shared', 'u8', operation.type.type.lifetime), operation.type.type]
    case 'StringUtf8Bytes':
      return [semanticType(operation.type)]
    case 'StringByteLength':
    case 'StringEqualsExact':
      return [semanticType(operation.type)]
    case 'EnumValue':
      return [
        SilkType.nominal(operation.enum.module, operation.enum.name),
        semanticType(operation.type),
      ]
    case 'EnumEquality':
      return [SilkType.nominal(operation.enum.module, operation.enum.name), 'bool']
    case 'ConvertInteger':
    case 'ConvertScalar':
    case 'ReinterpretScalar':
    case 'FloatUnary':
    case 'FloatTranscendental':
      return [semanticType(operation.sourceType), semanticType(operation.type)]
    case 'CheckedScalar':
      return [
        semanticType(operation.sourceType),
        semanticType(operation.valueType),
        semanticType(operation.type),
        'bool',
        ...cleanupTypes(operation.presentCleanup),
        ...cleanupTypes(operation.absentCleanup),
      ]
    case 'RawBufferFrom':
      return [semanticType(operation.type), operation.element]
    case 'SharedFromAllocation':
      return [semanticType(operation.type), operation.element]
    case 'ExecutionFromAllocation':
      return [
        semanticType(operation.type),
        operation.plan.specialization.result,
        operation.plan.specialization.body,
        operation.plan.specialization.endpoint,
        operation.plan.specialization.callback,
        ...cleanupTypes(operation.bodyCleanup),
        ...cleanupTypes(operation.endpointCleanup),
        ...cleanupTypes(operation.callbackCleanup),
      ]
    case 'ExecutionDrive':
      return [
        semanticType(operation.type),
        ...cleanupTypes(operation.completionCleanup),
        ...cleanupTypes(operation.suspensionCleanup),
      ]
    case 'ExecutionNotifyInitial':
      return [semanticType(operation.type)]
    case 'ExecutionWake':
      return [semanticType(operation.type), SilkType.wake]
    case 'ExecutionPark':
      return [
        semanticType(operation.type),
        ...cleanupTypes(operation.guardCleanup),
        ...cleanupTypes(operation.registerCleanup),
        ...operation.registrationTypeArguments.filter(SilkType.isTypeArgument),
      ]
    case 'SharedClone':
      return [semanticType(operation.type), operation.element]
    case 'SharedWithMut':
      return [
        semanticType(operation.type),
        operation.element,
        operation.useType,
        operation.conflictType,
        ...cleanupTypes(operation.useCleanup),
        ...cleanupTypes(operation.conflictCleanup),
      ]
    case 'RawBufferCount':
      return [semanticType(operation.type)]
    case 'RawBufferSlot':
    case 'RawBufferRead':
    case 'SliceView':
    case 'RawBufferView':
    case 'RawBufferCopy':
    case 'SlotWrite':
    case 'SlotTake':
    case 'SlotCopy':
      return [semanticType(operation.type), operation.element]
    case 'RawBufferFill':
      return [semanticType(operation.type)]
    case 'DiagnosticUnhandled':
      return [semanticType(operation.type)]
    case 'PointerNull':
    case 'PointerBytes':
    case 'PointerReinterpret':
    case 'PointerRequalify':
    case 'PointerFromStorage':
    case 'PointerAt':
    case 'PointerRead':
      return [semanticType(operation.type)]
    case 'PointerAddress':
    case 'PointerIsNull':
    case 'PointerWrite':
      return []
    case 'SlotDrop':
      return [semanticType(operation.type), operation.element, ...cleanupTypes(operation.cleanup)]
    case 'BeginLoan':
      return [semanticType(operation.sourceType), semanticType(operation.type)]
    case 'SliceLength':
      return [semanticType(operation.type)]
    case 'EndLoan':
      return []
    case 'Call':
      return [
        semanticType(operation.type),
        ...operation.typeArguments.filter(SilkType.isTypeArgument),
      ]
    case 'MakeEffect':
      return [
        semanticType(operation.type),
        ...operation.runnerTypeArguments.filter(SilkType.isTypeArgument),
        ...(operation.invocationSource === undefined
          ? []
          : operationTypes(operation.invocationSource)),
      ]
    case 'MakeCallable':
      // A construction's environment identity is checked as that identity; its ordinary arguments
      // count as open types only when that check fails.
      return constructionTargetArgumentsConcrete(operation)
        ? [semanticType(operation.type)]
        : [semanticType(operation.type), ...operation.typeArguments.filter(SilkType.isTypeArgument)]
    case 'ApplyCallable':
      return [
        operation.callableType,
        semanticType(operation.type),
        ...operation.typeArguments.filter(SilkType.isTypeArgument),
      ]
    case 'PackEffectOutcome':
    case 'PackEffectFailureUnion':
    case 'UnpackEffectSuccess':
      return [semanticType(operation.type)]
    case 'PropagateEffectFailure':
      return [semanticType(operation.sourceType), semanticType(operation.propagationType)]
    case 'RunEffect':
      return [
        semanticType(operation.outcomeType),
        ...(operation.propagationType === undefined
          ? []
          : [semanticType(operation.propagationType)]),
        semanticType(operation.type),
        ...operation.typeArguments.filter(SilkType.isTypeArgument),
      ]
    case 'RunEffectValue':
      return [
        semanticType(operation.outcomeType),
        ...(operation.propagationType === undefined
          ? []
          : [semanticType(operation.propagationType)]),
        semanticType(operation.type),
        ...operation.runnerTypeArguments.filter(SilkType.isTypeArgument),
        ...(operation.runnerBase?.typeArguments.filter(SilkType.isTypeArgument) ?? []),
        ...operation.providers.flatMap((provider) => [provider.capability, provider.providerType]),
        ...(operation.cancellationFinalizer === undefined
          ? []
          : [
              semanticType(operation.cancellationFinalizer.outcomeType),
              ...operation.cancellationFinalizer.runnerTypeArguments.filter(
                SilkType.isTypeArgument,
              ),
              ...(operation.cancellationFinalizer._tag === 'ResourceCancellationFinalizer'
                ? operation.cancellationFinalizer.releaseTypeArguments.filter(
                    SilkType.isTypeArgument,
                  )
                : []),
            ]),
      ]
    case 'RunEffectComposite':
      return [
        semanticType(operation.outcomeType),
        ...(operation.propagationType === undefined
          ? []
          : [semanticType(operation.propagationType)]),
        semanticType(operation.type),
        ...operation.alternatives.flatMap((alternative) => [
          semanticType(alternative.type),
          ...alternative.runnerTypeArguments.filter(SilkType.isTypeArgument),
        ]),
      ]
    case 'RunStaticEffect':
      return [
        semanticType(operation.outcomeType),
        ...(operation.propagationType === undefined
          ? []
          : [semanticType(operation.propagationType)]),
        semanticType(operation.type),
        ...operation.runnerTypeArguments.filter(SilkType.isTypeArgument),
      ]
    case 'CatchEffect':
      return [
        semanticType(operation.outcomeType),
        operation.failureValueType,
        ...operation.runnerTypeArguments.filter(SilkType.isTypeArgument),
        ...(operation.cancellationFinalizer === undefined
          ? []
          : [
              semanticType(operation.cancellationFinalizer.outcomeType),
              ...operation.cancellationFinalizer.runnerTypeArguments.filter(
                SilkType.isTypeArgument,
              ),
              ...(operation.cancellationFinalizer._tag === 'ResourceCancellationFinalizer'
                ? operation.cancellationFinalizer.releaseTypeArguments.filter(
                    SilkType.isTypeArgument,
                  )
                : []),
            ]),
      ]
    case 'Construct':
    case 'ConstructUnionVariant':
    case 'ConstructArray':
      return [semanticType(operation.type)]
    case 'ConvertUnion':
      return [semanticType(operation.sourceType), semanticType(operation.targetType)]
    case 'WritePlace':
      return [semanticType(operation.rootType), semanticType(operation.type)]
    case 'Match':
      return [
        semanticType(operation.scrutineeType),
        semanticType(operation.type),
        ...operation.members.map(Match.sourceType),
        ...operation.arms.flatMap((arm) => [
          ...(arm.member === undefined ? [] : [Match.sourceType(arm.member)]),
          ...arm.before.map(Match.sourceType),
          ...arm.after.map(Match.sourceType),
          ...arm.bindings.map((binding) => semanticType(binding.type)),
          ...(arm.guard === undefined
            ? []
            : executionOperations(arm.guard.execution).flatMap(operationTypes)),
          ...executionOperations(arm.selected.execution).flatMap(operationTypes),
          ...arm.selected.cleanup.flatMap((entry) => cleanupTypes(entry.cleanup)),
        ]),
      ]
    case 'DiagnosticScope':
      return [
        semanticType(operation.type),
        ...cleanupTypes(operation.stateCleanup),
        ...cleanupTypes(operation.observerCleanup),
        ...executionOperations(operation.body).flatMap(operationTypes),
      ]
    case 'Conditional':
      return [
        semanticType(operation.type),
        ...executionOperations(operation.taken).flatMap(operationTypes),
        ...executionOperations(operation.otherwise).flatMap(operationTypes),
      ]
    case 'ShortCircuit':
      return [
        semanticType(operation.type),
        ...executionOperations(operation.right).flatMap(operationTypes),
      ]
    case 'Move':
      return []
    case 'Drop':
      return cleanupTypes(operation.cleanup)
  }
}

interface ActiveLoan {
  readonly operation: Extract<Operation, { readonly _tag: 'BeginLoan' }>
  readonly root: LocalId
  readonly selectors: ReadonlyArray<PlaceSelector>
  readonly parent?: string
}

const loanPlacesOverlap = (
  left: ReadonlyArray<PlaceSelector>,
  right: ReadonlyArray<PlaceSelector>,
): boolean => {
  for (const [ordinal, selector] of left.entries()) {
    const other = right.at(ordinal)
    if (other === undefined) return true
    if (selector._tag === 'FieldSelector' && other._tag === 'FieldSelector') {
      if (!DeclarationFacts.sameFieldId(selector.field, other.field)) return false
    } else if (
      selector._tag === 'ElementSelector' &&
      other._tag === 'ElementSelector' &&
      selector.index._tag === 'Proven' &&
      other.index._tag === 'Proven'
    ) {
      if (selector.index.value !== other.index.value) return false
    } else if (!samePlaceSelector(selector, other)) return true
  }
  return true
}

const accessedOwnerLocals = (operation: Operation): ReadonlyArray<LocalId> => {
  switch (operation._tag) {
    case 'SetInitialized':
      return []
    case 'ForeignStaticLoad':
    case 'ForeignFunctionAddress':
      return []
    case 'StringFromUtf8Unchecked':
      return [operation.bytes]
    case 'StringUtf8Bytes':
    case 'StringByteLength':
      return [operation.string]
    case 'StringEqualsExact':
    case 'EnumEquality':
      return [operation.left, operation.right]
    case 'EnumValue':
      return [operation.source]
    case 'PackEffectComposite':
    case 'UnpackEffectComposite':
      return [operation.source]
    case 'Binary':
      return [operation.left, operation.right]
    case 'ConvertInteger':
    case 'ConvertScalar':
    case 'ReinterpretScalar':
    case 'FloatUnary':
    case 'FloatTranscendental':
      return [operation.source]
    case 'CheckedScalar':
      return [...operation.operands, operation.present, operation.absent]
    case 'ValidateLayout':
      return [operation.bytes, operation.alignment]
    case 'RepeatLayout':
      return [operation.layout, operation.count]
    case 'Allocate':
      return [operation.layout]
    case 'ForeignIndirectCall':
      return [operation.callee, ...operation.arguments]
    case 'NativeAssembly':
    case 'ForeignCall':
      return operation.arguments
    case 'RawBufferFrom':
      return [operation.allocation, operation.count]
    case 'SharedFromAllocation':
      return [operation.allocation, operation.value]
    case 'ExecutionFromAllocation':
      return [operation.allocation, operation.body, operation.endpoint, operation.callback]
    case 'ExecutionDrive':
      return [operation.execution, operation.branch, operation.onComplete, operation.onSuspend]
    case 'ExecutionNotifyInitial':
      return [operation.execution]
    case 'ExecutionWake':
      return [operation.wake]
    case 'ExecutionPark':
      return [operation.register]
    case 'SharedClone':
      return [operation.self]
    case 'SharedWithMut':
      return [operation.self, operation.use, operation.onConflict]
    case 'RawBufferCount':
      return [operation.buffer]
    case 'RawBufferSlot':
      return [operation.buffer, operation.index]
    case 'RawBufferRead':
      return [operation.buffer, operation.index]
    case 'SliceView':
      return [operation.slice, operation.offset, operation.length]
    case 'RawBufferView':
      return [operation.buffer, operation.offset, operation.length]
    case 'RawBufferCopy':
      return [operation.buffer, operation.offset, operation.source, operation.length]
    case 'RawBufferFill':
      return [operation.buffer, operation.offset, operation.length, operation.value]
    case 'PointerNull':
      return []
    case 'DiagnosticUnhandled':
      return []
    case 'PointerAddress':
    case 'PointerIsNull':
    case 'PointerRead':
      return [operation.pointer]
    case 'PointerBytes':
    case 'PointerReinterpret':
    case 'PointerRequalify':
    case 'PointerFromStorage':
      return [operation.source]
    case 'PointerAt':
      return [operation.pointer, operation.count]
    case 'PointerWrite':
      return [operation.pointer, operation.value]
    case 'SlotWrite':
      return [operation.slot, operation.value]
    case 'SlotTake':
    case 'SlotCopy':
    case 'SlotDrop':
      return [operation.slot]
    case 'Move':
      return [operation.source]
    case 'ConvertUnion':
      return [operation.source]
    case 'Call':
      return operation.arguments
    case 'MakeEffect':
      return [
        ...operation.captures.map((capture) => capture.source),
        ...(operation.invocationSource === undefined
          ? []
          : operationLocals(operation.invocationSource).filter(
              (local) => local.ordinal !== operation.destination.ordinal,
            )),
      ]
    case 'MakeCallable':
      return [
        ...(operation.base === undefined ? [] : [operation.base]),
        ...operation.captures.map((capture) => capture.source),
      ]
    case 'ApplyCallable':
      return [
        ...(operation.callable === undefined ? [] : [operation.callable]),
        ...operation.captures.map((capture) => capture.source),
        ...operation.arguments,
      ]
    case 'PackEffectOutcome':
    case 'PackEffectFailureUnion':
    case 'UnpackEffectSuccess':
      return [operation.source]
    case 'PropagateEffectFailure':
      return [operation.source, ...(operation.releases ?? []).map((release) => release.local)]
    case 'RunEffect':
      return operation.arguments
    case 'RunEffectValue':
      return [
        operation.effect,
        ...operation.arguments,
        ...(operation.cancellationFinalizer === undefined
          ? []
          : cancellationFinalizerAccesses(operation.cancellationFinalizer)),
      ]
    case 'RunEffectComposite':
      return [
        operation.effect,
        ...operation.alternatives.flatMap((alternative) => alternative.arguments),
      ]
    case 'RunStaticEffect':
      return [...operation.captures.map((capture) => capture.source), ...operation.arguments]
    case 'CatchEffect':
      return [
        operation.effect,
        ...operation.arguments,
        ...(operation.cancellationFinalizer === undefined
          ? []
          : cancellationFinalizerAccesses(operation.cancellationFinalizer)),
      ]
    case 'Construct':
    case 'ConstructUnionVariant':
      return operation.fields.map((field) => field.value)
    case 'ConstructArray':
      return operation.elements
    case 'Project':
      return [operation.source]
    case 'ReadPlace':
    case 'CheckPlace':
    case 'WritePlace':
      return [operation.root]
    case 'Drop':
      return [operation.local]
    case 'Match':
      return [operation.scrutinee]
    case 'DiagnosticScope':
      return [operation.state, operation.observer]
    case 'Conditional':
      return [operation.condition]
    case 'ShortCircuit':
      return [operation.left]
    case 'Literal':
    case 'EnumConstant':
    case 'StaticView':
    case 'StaticString':
    case 'BeginLoan':
    case 'EndLoan':
    case 'SliceLength':
      return []
  }
}

const loanViolations = (
  fn: MirFunction,
  layout: Layout.Plan,
  region: Region,
  roots: ReadonlyArray<Operation>,
  globalBeginnings: ReadonlyMap<string, Extract<Operation, { readonly _tag: 'BeginLoan' }>>,
  globalEndings: ReadonlySet<string>,
): ReadonlyArray<Violation> => {
  const violations: Array<Violation> = []
  const invalid = (detail: string): void => {
    violations.push({
      _tag: 'Violation',
      rule: 'InvalidLoan',
      function: fn.id,
      region: region.id,
      detail,
    })
  }
  const process = (
    sequence: ReadonlyArray<Operation>,
    inherited: ReadonlyMap<string, ActiveLoan>,
  ): void => {
    const active = new Map(inherited)
    const inheritedKeys = new Set(inherited.keys())
    const completed = new Set<string>()
    const endLoan = (
      operation: EndLoanOperation,
      currentActive: Map<string, ActiveLoan>,
      currentCompleted: Set<string>,
    ): void => {
      const key = borrowKey(operation.borrow)
      const loan = currentActive.get(key)
      const beginning = loan?.operation ?? globalBeginnings.get(key)
      const liveChild = [...currentActive.values()].some((candidate) => candidate.parent === key)
      if (
        beginning === undefined ||
        // Endpoint multiplicity is proved by loanPathsValid over the CFG. Nested execution
        // traversal can visit mutually exclusive endings in the same structural sequence.
        beginning.destination.ordinal !== operation.slice.ordinal ||
        liveChild
      ) {
        invalid(`loan ${key} has a missing, duplicate, premature, or mismatched ending`)
      } else {
        currentActive.delete(key)
        currentCompleted.add(key)
      }
    }
    for (const operation of sequence) {
      if (operation._tag === 'BeginLoan') {
        const key = borrowKey(operation.borrow)
        const source = fn.localTypes.at(operation.root.ordinal)
        const destination = fn.localTypes.at(operation.destination.ordinal)
        const sourceSemantic = semanticType(operation.sourceType)
        const selectedSource = placeType(fn, layout, operation.root, operation.selectors)
        const rootMatchesSource =
          selectedSource !== undefined &&
          SilkType.runtimeKey(selectedSource) === SilkType.runtimeKey(sourceSemantic)
        const borrowed = operation.type.type
        const descriptor = borrowsDescriptor(operation)
        const sourceElement =
          operation.sourceType._tag === 'FixedArray' || operation.sourceType._tag === 'Slice'
            ? operation.sourceType.type.element
            : undefined
        const sourceReferenceTarget =
          operation.sourceType._tag === 'Reference' && !descriptor
            ? operation.sourceType.type.target
            : undefined
        const parent = descriptor
          ? undefined
          : [...active.entries()].find(
              ([, loan]) => loan.operation.destination.ordinal === operation.root.ordinal,
            )
        const reborrowSource =
          !descriptor &&
          (operation.sourceType._tag === 'Slice' || operation.sourceType._tag === 'Reference')
        const reborrowValid = reborrowSource
          ? operation.reborrow &&
            operation.suspendsParent === (operation.sourceType.type.access === 'Exclusive')
          : !operation.reborrow && !operation.suspendsParent
        const parentValid =
          parent === undefined ||
          (reborrowSource &&
            parent[1].operation.access === operation.sourceType.type.access &&
            operation.suspendsParent === (parent[1].operation.access === 'Exclusive'))
        if (
          active.has(key) ||
          completed.has(key) ||
          source === undefined ||
          destination === undefined ||
          !rootMatchesSource ||
          (destination._tag !== 'Slice' && destination._tag !== 'Reference') ||
          !SilkType.equals(destination.type, borrowed) ||
          borrowed.access !== operation.access ||
          (SilkType.isSlice(borrowed)
            ? sourceElement === undefined || !SilkType.equals(borrowed.element, sourceElement)
            : !sameRuntimeType(borrowed.target, sourceReferenceTarget ?? sourceSemantic)) ||
          (reborrowSource &&
            operation.sourceType.type.access === 'Shared' &&
            operation.access === 'Exclusive') ||
          !reborrowValid ||
          !parentValid
        ) {
          invalid(`loan ${key} has inconsistent root, slice type, access, or reborrow facts`)
        }
        const root = parent?.[1].root ?? operation.root
        const selectors = [...(parent?.[1].selectors ?? []), ...operation.selectors]
        const conflicts = [...active.entries()].some(([candidateKey, candidate]) => {
          if (candidate.root.ordinal !== root.ordinal) return false
          if (parent?.[0] === candidateKey && operation.suspendsParent) return false
          if (!loanPlacesOverlap(candidate.selectors, selectors)) return false
          return candidate.operation.access === 'Exclusive' || operation.access === 'Exclusive'
        })
        if (conflicts) invalid(`loan ${key} conflicts with an active loan of %${root.ordinal}`)
        active.set(key, {
          operation,
          root,
          selectors,
          ...(parent === undefined ? {} : { parent: parent[0] }),
        })
        continue
      }
      if (operation._tag === 'EndLoan') {
        endLoan(operation, active, completed)
        continue
      }

      if (
        operation._tag === 'RunEffect' ||
        operation._tag === 'RunEffectValue' ||
        operation._tag === 'RunStaticEffect'
      ) {
        const failureActive = new Map(active)
        const failureCompleted = new Set(completed)
        for (const ending of operation.failureLoanEnds ?? [])
          endLoan(ending, failureActive, failureCompleted)
      }

      for (const local of accessedOwnerLocals(operation)) {
        const loan = [...active.values()].find(
          (candidate) =>
            candidate.root.ordinal === local.ordinal &&
            ((operation._tag !== 'ReadPlace' &&
              operation._tag !== 'CheckPlace' &&
              operation._tag !== 'WritePlace') ||
              loanPlacesOverlap(candidate.selectors, operation.selectors)),
        )
        if (loan !== undefined) {
          invalid(
            `${operation._tag} accesses owner %${local.ordinal} while loan ${borrowKey(loan.operation.borrow)} is live`,
          )
        }
        const suspended = [...active.values()].find(
          (candidate) =>
            candidate.parent !== undefined &&
            active.get(candidate.parent)?.operation.destination.ordinal === local.ordinal,
        )
        if (suspended !== undefined) {
          invalid(`${operation._tag} accesses a suspended parent slice %${local.ordinal}`)
        }
      }
      if (operation._tag === 'SliceLength') {
        const suspended = [...active.values()].some(
          (candidate) =>
            candidate.parent !== undefined &&
            active.get(candidate.parent)?.operation.destination.ordinal === operation.slice.ordinal,
        )
        if (suspended)
          invalid(`SliceLength accesses suspended parent slice %${operation.slice.ordinal}`)
      }
      if (operation._tag === 'Match') {
        for (const arm of operation.arms) {
          if (arm.guard !== undefined) process(executionOperations(arm.guard.execution), active)
          process(executionOperations(arm.selected.execution), active)
        }
      }
      if (operation._tag === 'DiagnosticScope')
        process(executionOperations(operation.body), new Map(active))
      if (operation._tag === 'Conditional') {
        process(executionOperations(operation.taken), new Map(active))
        process(executionOperations(operation.otherwise), new Map(active))
      }
    }
    for (const [key] of active) {
      if (!inheritedKeys.has(key) && !globalEndings.has(key)) {
        invalid(`loan ${key} has no ending in its operation sequence`)
      }
    }
  }
  process(roots, new Map())
  return violations
}

const suspensionTypes = (fn: MirFunction): ReadonlyArray<SilkType.Type> =>
  (fn.suspension?.regions ?? []).flatMap((region) => {
    const runner = region._tag === 'SuspendEffectRegion' ? region.deferred : region.runner
    const runnerTypes = [
      ...runner.typeArguments.filter(SilkType.isTypeArgument),
      runner.outcome,
      ...runner.captures.map((capture) => capture.type),
      ...runner.providers.flatMap((provider) => [provider.capability, provider.providerType]),
    ]
    if (region._tag === 'SuspendEffectRegion') return runnerTypes
    const completionTypes =
      region.completion._tag === 'Propagate'
        ? [region.completion.outcome]
        : [
            region.completion.outcome,
            region.completion.successType,
            region.completion.failureValueType,
          ]
    const descriptor = region.relay.state
    if (descriptor === undefined) return [...runnerTypes, ...completionTypes]
    const releases = [...descriptor.success.releases, ...descriptor.failure.releases]
    return [
      ...runnerTypes,
      ...completionTypes,
      descriptor.outcome,
      ...descriptor.slots.flatMap((slot) => [
        semanticType(slot.type),
        ...(slot.access._tag === 'AffineTransfer' ? cleanupTypes(slot.access.cleanup) : []),
      ]),
      ...releases.flatMap((release) => cleanupTypes(release.cleanup)),
    ]
  })

const coroutineFrameLayoutViolations = (self: Module): ReadonlyArray<Violation> => {
  const invalid = (detail: string, fn?: MirFunction): Violation =>
    fn === undefined
      ? { _tag: 'Violation', rule: 'InvalidCoroutineFrame', detail }
      : { _tag: 'Violation', rule: 'InvalidCoroutineFrame', function: fn.id, detail }
  const descriptors = self.functions.flatMap((fn) =>
    fn.suspension?.frame === undefined ? [] : [{ fn, descriptor: fn.suspension.frame }],
  )
  if (descriptors.length === 0)
    return self.coroutineFrames === undefined
      ? []
      : [invalid('MIR without frames retains a coroutine-frame layout plan')]
  if (self.coroutineFrames === undefined)
    return [invalid('frame-producing suspension has no target-layout plan')]
  const violations: Array<Violation> = []
  if (self.coroutineFrames.target.id !== self.layout.target.id)
    violations.push(invalid('coroutine-frame layout disagrees with the MIR target'))
  const matched = new Set<number>()
  for (const { fn, descriptor } of descriptors) {
    const candidates = self.coroutineFrames.entries
      .map((entry, ordinal) => ({ entry, ordinal }))
      .filter(({ entry }) => instanceText(entry.function) === instanceText(descriptor.function))
    const selected = candidates.at(0)
    if (selected === undefined || candidates.length !== 1) {
      violations.push(invalid('coroutine-frame descriptor must own exactly one maximum layout', fn))
      continue
    }
    matched.add(selected.ordinal)
    const entry = selected.entry
    const wordSize = self.layout.target.pointerSize
    const wordAlignment = self.layout.target.pointerAlignment
    const roles = coroutineFrameHeaderRoles(self)
    const headerValid =
      entry.header.length === roles.length &&
      entry.header.every(
        (field, ordinal) =>
          field.role === roles.at(ordinal) &&
          field.offset === ordinal * wordSize &&
          field.size === wordSize &&
          field.alignment === wordAlignment,
      )
    const offsets = new Map<number, number>()
    const slots = new Map(
      descriptor.states.flatMap((state) =>
        state.slots.map((slot) => [slot.local.ordinal, slot] as const),
      ),
    )
    let payloadCursor = roles.length * wordSize
    for (const [local, slot] of [...slots].sort(([left], [right]) => left - right)) {
      const physical = CoroutineFrame.storageOf(self, slot)
      if (physical === undefined || physical.alignment < 1 || physical.size < 0) continue
      const offset = Math.ceil(payloadCursor / physical.alignment) * physical.alignment
      offsets.set(local, offset)
      payloadCursor = offset + physical.size
    }
    const stateValid = descriptor.states.every((state) => {
      const candidates = entry.states.filter((layout) =>
        sameSuspensionPoint(layout.point, state.point),
      )
      const layout = candidates.at(0)
      if (layout === undefined || candidates.length !== 1) return false
      let cursor = roles.length * wordSize
      let alignment: number = wordAlignment
      const payloadValid =
        layout.payload.length === state.slots.length &&
        layout.payload.every((field, ordinal) => {
          const slot = state.slots.at(ordinal)
          if (slot === undefined) return false
          const physical = CoroutineFrame.storageOf(self, slot)
          if (physical === undefined) return false
          const offset = offsets.get(slot.local.ordinal)
          if (offset === undefined || offset < cursor) return false
          const valid =
            field.slot === slot.ordinal &&
            field.local.ordinal === slot.local.ordinal &&
            SilkType.equals(semanticType(field.type), semanticType(slot.type)) &&
            field.access._tag === slot.access._tag &&
            initializationText(field.initialization) === initializationText(slot.initialization) &&
            field.offset === offset &&
            field.size === physical.size &&
            field.alignment === physical.alignment &&
            field.padding === offset - cursor
          cursor = offset + physical.size
          alignment = Math.max(alignment, physical.alignment)
          return valid
        })
      const size = Math.ceil(cursor / alignment) * alignment
      const retained = new Set(state.slots.map((slot) => slot.local.ordinal))
      const finalizer = state.cancellationFinalizer
      const finalizerEffect =
        finalizer?._tag === 'EffectCancellationFinalizer'
          ? fn.localTypes.at(finalizer.effect.ordinal)
          : undefined
      const finalizerRelease =
        finalizer?._tag === 'ResourceCancellationFinalizer'
          ? fn.localTypes.at(finalizer.release.ordinal)
          : undefined
      const finalizerResource =
        finalizer?._tag === 'ResourceCancellationFinalizer'
          ? fn.localTypes.at(finalizer.resource.ordinal)
          : undefined
      const resourceReleaseParameter =
        finalizerRelease?._tag === 'CallableValue'
          ? finalizerRelease.type.parameters.at(0)
          : undefined
      const finalizerRunner =
        finalizer === undefined
          ? undefined
          : self.functions.find((candidate) =>
              matchesEffectInstance(
                candidate,
                finalizer.runner,
                finalizer.runnerTypeArguments,
                finalizer.runnerStaticArguments,
                finalizer.outcomeType.type,
              ),
            )
      const retainedOrZeroLane = (local: LocalId): boolean => {
        if (retained.has(local.ordinal)) return true
        const type = fn.localTypes.at(local.ordinal)
        if (type === undefined) return false
        if (type._tag === 'EffectValue')
          return Layout.effectEnvironmentLanes(self.layout, type.environment).length === 0
        if (type._tag === 'CallableValue')
          return (
            type.environment === undefined ||
            Layout.callableEnvironmentLanes(self.layout, type.environment).length === 0
          )
        return (Layout.callingShape(self.layout, semanticType(type))?.lanes.length ?? 0) === 0
      }
      const finalizerValid =
        finalizer === undefined ||
        (finalizer._tag === 'EffectCancellationFinalizer'
          ? finalizerEffect?._tag === 'EffectValue' &&
            SilkType.equals(finalizerEffect.type, finalizer.outcomeType.type) &&
            finalizerRunner !== undefined &&
            retainedOrZeroLane(finalizer.effect) &&
            finalizer.arguments.every(retainedOrZeroLane)
          : finalizerRelease?._tag === 'CallableValue' &&
            finalizerResource !== undefined &&
            finalizerResource._tag !== 'EffectOutcome' &&
            resourceReleaseParameter !== undefined &&
            SilkType.isReference(resourceReleaseParameter) &&
            resourceReleaseParameter.access === 'Exclusive' &&
            SilkType.runtimeKey(resourceReleaseParameter.target) ===
              SilkType.runtimeKey(semanticType(finalizerResource)) &&
            SilkType.isEffect(finalizerRelease.type.result) &&
            // Applying a reusable effect function constructs one affine Effect value. The selected
            // runner therefore records `Take` even when the callable declaration returns `Shared`;
            // access is compile-time ownership and is absent from the emitted outcome ABI.
            SilkType.runtimeKey({
              ...finalizer.outcomeType.type,
              access: finalizerRelease.type.result.access,
            }) === SilkType.runtimeKey(finalizerRelease.type.result) &&
            finalizerRunner !== undefined &&
            retainedOrZeroLane(finalizer.resource) &&
            retainedOrZeroLane(finalizer.release) &&
            finalizer.arguments.every(retainedOrZeroLane))
      return (
        payloadValid &&
        finalizerValid &&
        layout.size === size &&
        layout.alignment === alignment &&
        layout.tailPadding === size - cursor
      )
    })
    const maximumAlignment = Math.max(
      wordAlignment,
      ...entry.states.map((state) => state.alignment),
    )
    const payloadEnd = Math.max(roles.length * wordSize, ...entry.states.map((state) => state.size))
    const descriptorStart = Math.ceil(payloadEnd / wordAlignment) * wordAlignment
    const scopes = diagnosticScopeLocals(fn)
    const scopesValid =
      entry.diagnosticScopes.length === scopes.length &&
      entry.diagnosticScopes.every(
        (field, ordinal) =>
          field.scope.ordinal === scopes.at(ordinal)?.ordinal &&
          field.offset === descriptorStart + ordinal * wordSize * diagnosticScopeWords,
      )
    const outcomesStart = descriptorStart + scopes.length * wordSize * diagnosticScopeWords
    const outcomes = diagnosticOutcomeLocals(self, fn)
    const outcomesValid =
      entry.diagnosticOutcomes.length === outcomes.length &&
      entry.diagnosticOutcomes.every(
        (field, ordinal) =>
          field.outcome.ordinal === outcomes.at(ordinal)?.ordinal &&
          field.offset === outcomesStart + ordinal * wordSize * diagnosticOutcomeWords,
      )
    const maximumSize =
      Math.ceil(
        (outcomesStart + outcomes.length * wordSize * diagnosticOutcomeWords) / maximumAlignment,
      ) * maximumAlignment
    if (
      !headerValid ||
      !stateValid ||
      !scopesValid ||
      !outcomesValid ||
      entry.states.length !== descriptor.states.length ||
      entry.alignment !== maximumAlignment ||
      entry.size !== maximumSize
    )
      violations.push(
        invalid('coroutine-frame maximum layout or one of its states is not canonical', fn),
      )
  }
  if (matched.size !== self.coroutineFrames.entries.length)
    violations.push(invalid('coroutine-frame layout plan contains a stale or duplicate entry'))
  return violations
}
type PropagatingRun = Extract<
  Operation,
  {
    readonly _tag: 'RunEffect' | 'RunEffectValue' | 'RunEffectComposite' | 'RunStaticEffect'
  }
>

/** Validates the one canonical success/failure outcome boundary shared by every run form. */
const runPropagationValid = (
  layout: Layout.Plan,
  fn: MirFunction,
  operation: PropagatingRun,
): boolean => {
  const failures = SilkType.failureMembers(operation.outcomeType.type)
  const propagation = operation.propagationType
  if (failures.length === 0)
    return (
      propagation === undefined &&
      operation.tagMappings.length === 0 &&
      operation.propagationLaneCount === 0 &&
      (operation.failureLoanEnds?.length ?? 0) === 0
    )
  if (propagation === undefined) return false
  const shape = Layout.callingShape(layout, propagation.type)
  return (
    SilkType.equals(semanticType(fn.result), propagation.type) &&
    shape?.laneCount === operation.propagationLaneCount &&
    operation.tagMappings.length === failures.length &&
    operation.tagMappings.every((mapping, sourceOrdinal) => {
      const expectedSource = failures.at(sourceOrdinal)
      const source = SilkType.failureCarrierMember(
        operation.outcomeType.type,
        mapping.source,
        'OneBased',
      )
      const target = SilkType.failureCarrierMember(propagation.type, mapping.target, 'OneBased')
      return (
        mapping.source === sourceOrdinal + 1 &&
        expectedSource !== undefined &&
        source !== undefined &&
        target !== undefined &&
        SilkType.equals(source, expectedSource) &&
        SilkType.runtimeKey(source) === SilkType.runtimeKey(target)
      )
    })
  )
}

const verifyCache = new WeakMap<Module, ReadonlyArray<Violation>>()

/**
 * Verification is pure over an immutable Module, and the same module is routinely verified more
 * than once (tests assert emptiness, then LLVM emission re-verifies before lowering), so the result
 * is cached per module identity.
 */
/** The structural reason one pointer operation disagrees with its operand types, if any. */
const pointerOperationViolation = (
  layout: Layout.Plan,
  fn: MirFunction,
  operation: Extract<
    Operation,
    {
      readonly _tag:
        | 'PointerNull'
        | 'PointerIsNull'
        | 'PointerAddress'
        | 'PointerReinterpret'
        | 'PointerRequalify'
        | 'PointerBytes'
        | 'PointerFromStorage'
        | 'PointerAt'
        | 'PointerRead'
        | 'PointerWrite'
    }
  >,
): string | undefined => {
  const destination = fn.localTypes.at(operation.destination.ordinal)
  const pointerAt = (local: LocalId): SilkType.Pointer | undefined => {
    const type = fn.localTypes.at(local.ordinal)
    return type?._tag === 'Pointer' ? type.type : undefined
  }
  switch (operation._tag) {
    case 'PointerNull':
      return destination?._tag === 'Pointer' &&
        operation.type.type.nullable &&
        SilkType.equals(destination.type, operation.type.type)
        ? undefined
        : 'Pointer null lost its nullable destination'
    case 'PointerAddress':
      return pointerAt(operation.pointer) !== undefined && destination?._tag === 'usize'
        ? undefined
        : 'Pointer address lost its pointer operand or usize destination'
    case 'PointerIsNull':
      return pointerAt(operation.pointer) !== undefined && destination?._tag === 'bool'
        ? undefined
        : 'Pointer null test lost its pointer operand or bool destination'
    case 'PointerBytes': {
      const source = pointerAt(operation.source)
      return source !== undefined &&
        !source.mutable &&
        source.nullable &&
        source.extent === 'Single' &&
        source.alignment === 'Natural' &&
        source.addressSpace === 0 &&
        destination?._tag === 'Pointer' &&
        SilkType.equals(destination.type, operation.type.type) &&
        destination.type.pointee === 'u8' &&
        !destination.type.mutable &&
        destination.type.nullable &&
        destination.type.extent === 'Many' &&
        destination.type.alignment === 'Natural' &&
        destination.type.addressSpace === source.addressSpace
        ? undefined
        : 'Pointer byte projection lost its readonly byte view or source qualifiers'
    }
    case 'PointerReinterpret':
    case 'PointerRequalify': {
      const source = pointerAt(operation.source)
      return source !== undefined &&
        destination?._tag === 'Pointer' &&
        SilkType.equals(destination.type, operation.type.type) &&
        (operation._tag === 'PointerReinterpret'
          ? source.mutable === destination.type.mutable &&
            source.nullable === destination.type.nullable &&
            source.extent === destination.type.extent
          : SilkType.equals(source.pointee, destination.type.pointee)) &&
        source.addressSpace === destination.type.addressSpace
        ? undefined
        : 'Pointer qualification changed its invariant pointee or address space'
    }
    case 'PointerFromStorage': {
      const source = fn.localTypes.at(operation.source.ordinal)
      let borrowed:
        | { readonly pointee: SilkType.Type; readonly access: SilkType.BorrowAccess }
        | undefined
      if (source?._tag === 'Reference')
        borrowed = { pointee: source.type.target, access: source.type.access }
      else if (source?._tag === 'Slice')
        borrowed = { pointee: source.type.element, access: source.type.access }
      else if (source !== undefined) {
        const semantic = semanticType(source)
        const pointee = SilkType.isSlot(semantic) ? SilkType.typeArgumentAt(semantic, 1) : undefined
        if (pointee !== undefined) borrowed = { pointee, access: 'Exclusive' }
      }
      return borrowed !== undefined &&
        destination?._tag === 'Pointer' &&
        SilkType.equals(destination.type, operation.type.type) &&
        SilkType.equals(operation.type.type.pointee, borrowed.pointee) &&
        operation.type.type.mutable === (borrowed.access === 'Exclusive') &&
        operation.type.type.alignment === 'Natural' &&
        operation.type.type.addressSpace === 0 &&
        operation.type.type.nullable === (source?._tag === 'Slice') &&
        operation.type.type.extent === (source?._tag === 'Slice' ? 'Many' : 'Single')
        ? undefined
        : 'Pointer formation lost its borrowed source, pointee, or mutability agreement'
    }
    case 'PointerAt': {
      const pointer = pointerAt(operation.pointer)
      return pointer !== undefined &&
        !pointer.nullable &&
        pointer.extent === 'Many' &&
        pointer.alignment === 'Natural' &&
        SilkType.equals(SilkType.pointer({ ...pointer, extent: 'Single' }), operation.type.type) &&
        fn.localTypes.at(operation.count.ordinal)?._tag === 'usize' &&
        destination?._tag === 'Pointer' &&
        SilkType.equals(destination.type, operation.type.type)
        ? undefined
        : 'Pointer offset lost its pointer operand, usize count, or result agreement'
    }
    case 'PointerRead': {
      const pointer = pointerAt(operation.pointer)
      return pointer !== undefined &&
        !pointer.nullable &&
        pointer.extent === 'Single' &&
        destination !== undefined &&
        SilkType.equals(semanticType(destination), pointer.pointee) &&
        SilkType.equals(semanticType(operation.type), pointer.pointee) &&
        isCopy(layout, pointer.pointee)
        ? undefined
        : 'Pointer read lost its pointer operand, Copy pointee, or result agreement'
    }
    case 'PointerWrite': {
      const pointer = pointerAt(operation.pointer)
      const value = fn.localTypes.at(operation.value.ordinal)
      return pointer !== undefined &&
        pointer.mutable &&
        !pointer.nullable &&
        pointer.extent === 'Single' &&
        value !== undefined &&
        SilkType.equals(semanticType(value), pointer.pointee) &&
        destination?._tag === 'Nominal' &&
        SilkType.equals(destination.type, SilkType.unit) &&
        isCopy(layout, pointer.pointee)
        ? undefined
        : 'Pointer write lost its *mut pointer operand, Copy pointee, value, or unit destination'
    }
  }
}

/** An explicit compiler-invariant audit rejected a lowered program. */
export class MirVerificationError extends Data.TaggedError('MirVerificationError')<{
  readonly operation: 'MirVerification.check'
  readonly message: string
  readonly violations: ReadonlyArray<Violation>
}> {}

/** Optional traced audit for compiler development and callers constructing MIR directly. */
export const check = Effect.fn('MirVerification.check')(function* (
  self: Module,
): Effect.fn.Return<void, MirVerificationError> {
  yield* Effect.annotateCurrentSpan({
    'module.name': self.module,
    'functions.count': self.functions.length,
  })
  const violations = yield* verify(self)
  if (violations.length > 0)
    return yield* new MirVerificationError({
      operation: 'MirVerification.check',
      message: 'MIR verification failed',
      violations,
    })
})

/** Returns compiler-invariant violations without emitting code. */
export const verify = Effect.fn('MirVerification.verify')(function* (
  self: Module,
): Effect.fn.Return<ReadonlyArray<Violation>> {
  const trace = yield* CompilerTrace.capture()
  let cached = verifyCache.get(self)
  if (cached === undefined) {
    cached = yield* computeVerify(self, trace)
    verifyCache.set(self, cached)
  }
  return cached
})

const computeVerify = Effect.fnUntraced(function* (
  self: Module,
  trace: CompilerTrace.CompilerTrace,
): Effect.fn.Return<ReadonlyArray<Violation>> {
  const violations: Array<Violation> = (yield* LayoutVerify.verify(self.layout)).map(
    (violation) => ({
      _tag: 'Violation' as const,
      rule: 'InvalidLayout' as const,
      detail: `${violation.rule}: ${violation.detail}`,
    }),
  )
  violations.push(
    ...trace('MirVerification.verifyCoroutineFrames', () => coroutineFrameLayoutViolations(self)),
  )
  const { sameDeclaration, foreignStaticInitializerValid } = trace(
    'MirVerification.verifyModule',
    () => {
      for (const fn of self.functions) {
        for (const local of fn.localTypes) {
          if (
            (local._tag !== 'EffectValue' && local._tag !== 'CallableValue') ||
            local.inputView === undefined
          )
            continue
          const valid =
            local._tag === 'EffectValue' && ExecutableInputView.physical(self, local) !== undefined
          if (!valid)
            violations.push({
              _tag: 'Violation',
              rule:
                local._tag === 'EffectValue'
                  ? 'InvalidEffectOperation'
                  : 'InvalidCallableOperation',
              function: fn.id,
              detail:
                'executable input view lacks its original checked call edge or physical producer',
            })
        }
        const operations = fn.regions.flatMap(operationsOf).flatMap(operationTree)
        for (const operation of operations) {
          if (operation._tag !== 'NativeAssembly') continue
          const destination = fn.localTypes[operation.destination.ordinal]
          if (
            destination === undefined ||
            !SilkType.equals(semanticType(destination), semanticType(operation.type))
          )
            violations.push({
              _tag: 'Violation',
              rule: 'InvalidNativeAssembly',
              function: fn.id,
              detail: 'assembly destination must have the declared result type',
            })
          const operands = operation.arguments.flatMap((argument) => {
            const type = fn.localTypes[argument.ordinal]
            return type === undefined ? [] : [semanticType(type)]
          })
          for (const detail of NativeAssembly.violations(
            operation.assembly,
            semanticType(operation.type),
            operands,
            self.layout.target,
          ))
            violations.push({
              _tag: 'Violation',
              rule: 'InvalidNativeAssembly',
              function: fn.id,
              detail,
            })
          const owner = fn.regions.find((region) => operationsOf(region).includes(operation))
          if (
            operation.assembly.noReturn &&
            (owner?._tag !== 'OperationRegion' ||
              owner.outcome._tag !== 'Trap' ||
              owner.operations.at(-1) !== operation)
          )
            violations.push({
              _tag: 'Violation',
              rule: 'InvalidNativeAssembly',
              function: fn.id,
              detail: 'terminal assembly must end its region without a continuation',
            })
        }
        if (fn.machine !== undefined) {
          const assembly = operations[0]
          if (
            !NativeAssembly.available(self.layout.target) ||
            fn.parameterCount !== 0 ||
            !SilkType.equals(semanticType(fn.result), SilkType.unit) ||
            operations.length !== 1 ||
            assembly?._tag !== 'NativeAssembly' ||
            !assembly.assembly.noReturn ||
            !assembly.assembly.sideEffects ||
            assembly.arguments.length !== 0 ||
            fn.regions.some(
              (region) => region._tag !== 'OperationRegion' || region.outcome._tag !== 'Trap',
            )
          )
            violations.push({
              _tag: 'Violation',
              rule: 'InvalidMachineFunction',
              function: fn.id,
              detail:
                'naked function requires exactly one operand-free terminal assembly operation',
            })
        }
      }

      const retained = new Set<string>()
      for (const root of self.retainedRoots ?? []) {
        const key = Instances.keyText(root)
        if (retained.has(key) || !self.functions.some((fn) => matchesInstanceKey(fn, root)))
          violations.push({
            _tag: 'Violation',
            rule: 'InvalidArtifactRoot',
            detail: 'Retained roots must uniquely identify emitted function instances',
          })
        retained.add(key)
      }
      for (const record of [...self.foreignCalls, ...self.foreignExports]) {
        if (!CAbi.isCanonicalSignature(record.signature, self.layout.target))
          violations.push({
            _tag: 'Violation',
            rule: 'InvalidForeignOperation',
            detail: `Foreign signature ${record.symbol} has noncanonical target ABI facts`,
          })
      }

      const sameDeclaration = (
        left: DeclarationFacts.CanonicalId,
        right: DeclarationFacts.CanonicalId,
      ): boolean => left.module === right.module && left.name === right.name
      const declarationKey = (declaration: DeclarationFacts.CanonicalId): string =>
        `${declaration.module}\u0000${declaration.name}`
      const exportInventoryCanonical = self.foreignExports.every((record, ordinal) => {
        const previous = ordinal === 0 ? undefined : self.foreignExports.at(ordinal - 1)
        if (previous === undefined) return true
        return (
          previous.declaration.module.localeCompare(record.declaration.module) < 0 ||
          (previous.declaration.module === record.declaration.module &&
            (previous.declarationSpan.start < record.declarationSpan.start ||
              (previous.declarationSpan.start === record.declarationSpan.start &&
                previous.declarationSpan.end < record.declarationSpan.end)))
        )
      })
      const exportDeclarations = new Set<string>()
      if (!exportInventoryCanonical) {
        violations.push({
          _tag: 'Violation',
          rule: 'InvalidForeignOperation',
          detail: 'Foreign export inventory is duplicated or outside canonical declaration order',
        })
      }
      for (const record of self.foreignExports) {
        const key = declarationKey(record.declaration)
        const declarationUnique = !exportDeclarations.has(key)
        exportDeclarations.add(key)
        const implementation = self.functions.find((candidate) =>
          matchesInstanceKey(candidate, record.key),
        )
        const implementationType =
          implementation === undefined
            ? undefined
            : SilkType.foreignFunction(
                implementation.localTypes.slice(0, implementation.parameterCount).map(semanticType),
                semanticType(implementation.result),
                record.type.contract,
                record.type,
              )
        const signatureAdmitted =
          record.type.parameters.every((parameter, ordinal) =>
            SilkType.isReference(parameter)
              ? record.type.contract.borrow.includes(ordinal)
              : CAbi.admit(parameter, 'Parameter')._tag === 'Admitted',
          ) && CAbi.admit(record.type.result, 'Result')._tag === 'Admitted'
        const signature = signatureAdmitted
          ? CAbi.signature(
              record.type.parameters,
              record.type.result,
              self.layout.target,
              record.type.contract,
            )
          : undefined
        if (
          !declarationUnique ||
          !sameDeclaration(record.key.declaration, record.declaration) ||
          (self.layout.target.kind === 'Native' &&
            (implementationType === undefined ||
              !SilkType.equals(implementationType, record.type))) ||
          signature === undefined ||
          CAbi.signatureKey(record.signature) !== CAbi.signatureKey(signature)
        ) {
          violations.push({
            _tag: 'Violation',
            rule: 'InvalidForeignOperation',
            detail: `Foreign export ${record.symbol} does not match one unique canonical implementation`,
          })
        }
      }
      const foreignStaticInitializerValid = (record: Module['foreignStatics'][number]): boolean => {
        if (record.direction === 'Import') return record.literal === undefined
        const scalar = typeof record.type === 'string' ? Scalar.find(record.type) : undefined
        if (record.literal?._tag === 'IntegerLiteral' && scalar?.category === 'Integer') {
          const range = Scalar.range(scalar, self.layout.target.pointerSize === 4 ? 32 : 64)
          return record.literal.value >= range.minimum && record.literal.value <= range.maximum
        }
        if (record.literal?._tag === 'FloatingLiteral' && scalar?.category === 'Floating') {
          const value = Number(record.literal.spelling)
          return (
            Number.isFinite(value) &&
            (scalar.spelling !== 'f32' || Number.isFinite(Math.fround(value)))
          )
        }
        return false
      }
      const foreignStaticLoads = self.functions.flatMap((fn) =>
        operations(fn).filter(
          (operation): operation is Extract<Operation, { readonly _tag: 'ForeignStaticLoad' }> =>
            operation._tag === 'ForeignStaticLoad',
        ),
      )
      const staticDeclarations = new Set<string>()
      const staticInventoryCanonical = self.foreignStatics.every((record, ordinal) => {
        const previous = ordinal === 0 ? undefined : self.foreignStatics.at(ordinal - 1)
        if (previous === undefined) return true
        return (
          previous.declarationSpan.sourceId.localeCompare(record.declarationSpan.sourceId) < 0 ||
          (previous.declarationSpan.sourceId === record.declarationSpan.sourceId &&
            (previous.declarationSpan.start < record.declarationSpan.start ||
              (previous.declarationSpan.start === record.declarationSpan.start &&
                previous.declarationSpan.end < record.declarationSpan.end)))
        )
      })
      if (!staticInventoryCanonical) {
        violations.push({
          _tag: 'Violation',
          rule: 'InvalidForeignOperation',
          detail: 'Foreign static inventory is duplicated or outside canonical source order',
        })
      }
      for (const record of self.foreignStatics) {
        const key = declarationKey(record.declaration)
        const declarationUnique = !staticDeclarations.has(key)
        staticDeclarations.add(key)
        const retainedImportValid =
          record.direction === 'Export' ||
          foreignStaticLoads.some((operation) =>
            sameDeclaration(operation.declaration, record.declaration),
          )
        if (
          CAbi.admit(record.type, 'Parameter')._tag === 'NotAdmitted' ||
          !declarationUnique ||
          !foreignStaticInitializerValid(record) ||
          !retainedImportValid
        ) {
          violations.push({
            _tag: 'Violation',
            rule: 'InvalidForeignOperation',
            detail: `Foreign static ${record.symbol} has an invalid ${record.direction.toLowerCase()} type, initializer, or reachability record`,
          })
        }
      }
      const expectedAuthorities = self.layout.executionPackages.plans.length
      if (
        self.executionTransitions.length !== expectedAuthorities ||
        self.executionTransitions.some(
          (authority, ordinal) =>
            authority.package !== ordinal ||
            authority.root !== ordinal + 1 ||
            authority.readiness !==
              self.layout.executionPackages.plans.at(ordinal)?.readinessStorage ||
            ExecutionTransition.verifyAuthority(authority).length > 0,
        )
      ) {
        violations.push({
          _tag: 'Violation',
          rule: 'InvalidExecutionOperation',
          detail: 'execution transition authority is incomplete or non-canonical',
        })
      }
      const staticData = self.staticData ?? []
      const staticTableValid = staticData.every((data, ordinal) => {
        const previous = ordinal === 0 ? undefined : staticData.at(ordinal - 1)
        const expectedId = `${data.kind === 'Text' ? 'text' : 'bytes'}:${data.bytes
          .map((byte) => byte.toString(16).padStart(2, '0'))
          .join('')}`
        return (
          (previous === undefined || previous.id < data.id) &&
          data.id === expectedId &&
          data.utf8 === (data.kind === 'Text') &&
          data.bytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
        )
      })
      const placements = self.layout.staticData ?? []
      const placementMatches =
        placements.length === staticData.length &&
        placements.every((placement, ordinal) => placement.data.id === staticData.at(ordinal)?.id)
      if (!staticTableValid || !placementMatches) {
        violations.push({
          _tag: 'Violation',
          rule: 'InvalidSliceOperation',
          detail: 'static-data table is non-canonical or disagrees with target placement',
        })
      }
      const originReachable = SuspensionMir.originReachableFunctions(self)
      const orphanRelay = self.functions
        .flatMap((fn) =>
          (fn.suspension?.regions ?? []).flatMap((region) => {
            if (
              region._tag !== 'RunSuspendableEffectRegion' ||
              // Parking originates an external transfer in this execution. Its suspension region
              // carries continuation state, but it does not call a separate child runner.
              region.operation._tag === 'ExecutionPark'
            )
              return []
            const declaration = region.runner.declaration
            return declaration === undefined ||
              !self.functions.some(
                (candidate) =>
                  originReachable.has(instanceText(candidate.instance)) &&
                  matchesInstance(
                    candidate,
                    declaration,
                    region.runner.typeArguments,
                    region.runner.instance?.staticArguments ?? [],
                  ),
              )
              ? [{ fn, region }]
              : []
          }),
        )
        .at(0)
      if (orphanRelay !== undefined)
        violations.push({
          _tag: 'Violation',
          rule: 'OrphanSuspensionMachinery',
          function: orphanRelay.fn.id,
          detail: `suspendable relay through ${orphanRelay.region.runner.declaration === undefined ? 'an unknown runner' : targetText(orphanRelay.region.runner.declaration)} belongs to a function with no reachable explicit transfer origin (origin-reachable: ${
            self.functions
              .filter((fn) => originReachable.has(instanceText(fn.instance)))
              .map((fn) => targetText(fn.id))
              .join(', ') || 'none'
          })`,
        })
      for (const root of self.foreignExports.map((item) => item.key)) {
        if (!self.functions.some((fn) => matchesInstanceKey(fn, root)))
          violations.push({
            _tag: 'Violation',
            rule: 'InvalidArtifactRoot',
            detail: `artifact root ${instanceText(root)} has no retained function`,
          })
      }
      const sharedElements = [
        ...new Map(
          self.layout.entries.flatMap((entry) => {
            if (!SilkType.isSharedCore(entry.type)) return []
            const element = SilkType.typeArgumentAt(entry.type, 0)
            return element === undefined ? [] : [[SilkType.key(element), element] as const]
          }),
        ).values(),
      ].sort((left, right) => SilkType.key(left).localeCompare(SilkType.key(right)))
      const payloadCleanupHelpers = self.functions.filter(
        (fn) =>
          fn.id.module === LocalSharedPayloadCleanup.declaration.module &&
          fn.id.name === LocalSharedPayloadCleanup.declaration.name,
      )
      for (const element of sharedElements) {
        const helpers = payloadCleanupHelpers.filter((fn) =>
          matchesInstance(fn, LocalSharedPayloadCleanup.declaration, [element]),
        )
        const helper = helpers.at(0)
        const parameter = helper?.localTypes.at(0)
        if (
          helpers.length !== 1 ||
          helper === undefined ||
          helper.parameterCount !== 1 ||
          parameter === undefined ||
          !SilkType.equals(semanticType(parameter), element) ||
          helper.result._tag !== 'i32' ||
          helper.suspension !== undefined
        ) {
          violations.push({
            _tag: 'Violation',
            rule: 'InvalidLocalSharedOperation',
            localSharedReason: 'CleanupContract',
            ...(helper === undefined ? {} : { function: helper.id }),
            detail: `local-shared payload ${SilkType.encode(element)} must resolve to one synchronous single-parameter cleanup helper`,
          })
        }
      }
      if (payloadCleanupHelpers.length !== sharedElements.length) {
        violations.push({
          _tag: 'Violation',
          rule: 'InvalidLocalSharedOperation',
          localSharedReason: 'CleanupContract',
          detail: 'local-shared payload cleanup helper inventory is stale or contains duplicates',
        })
      }
      return { sameDeclaration, foreignStaticInitializerValid }
    },
  )
  const instanceKeys = new Set<string>()
  const verifyFunction = (fn: Module['functions'][number]): void => {
    const allRegions = regionsTree(fn.regions)
    const caughtOutcomes = new Map(
      fn.regions
        .flatMap(operationsOf)
        .flatMap(operationTree)
        .filter((operation) => operation._tag === 'CatchEffect')
        .map((operation) => [operation.outcome.ordinal, operation] as const),
    )
    const descriptorUses = new Map<number, Set<Operation>>()
    const propagatedOutcomeOwners = new Map(
      [...caughtOutcomes.values()].map((caught) => [
        caught.failureValue.ordinal,
        caught.outcome.ordinal,
      ]),
    )
    for (const operation of fn.regions.flatMap(operationsOf).flatMap(operationTree)) {
      if (operation._tag !== 'Match') continue
      const owner = propagatedOutcomeOwners.get(operation.scrutinee.ordinal)
      if (owner === undefined) continue
      for (const arm of operation.arms)
        for (const binding of arm.bindings)
          propagatedOutcomeOwners.set(binding.destination.ordinal, owner)
    }
    const controlLocals = new Set<number>()
    for (const region of allRegions) {
      for (const operation of operationsOf(region).flatMap(operationTree))
        for (const local of operationLocals(operation)) {
          const uses = descriptorUses.get(local.ordinal) ?? new Set<Operation>()
          uses.add(operation)
          descriptorUses.set(local.ordinal, uses)
        }
      const outcome = outcomeOf(region)
      if (outcome?._tag === 'Return') controlLocals.add(outcome.value.ordinal)
      if (region._tag === 'ConditionalRegion') controlLocals.add(region.condition.ordinal)
      if (region._tag === 'LoopRegion') controlLocals.add(region.conditionValue.ordinal)
    }
    violations.push(
      ...[...invocationUseIssues(fn, self), ...invocationEscapeIssues(fn, self)].map(
        (issue): Violation => ({
          _tag: 'Violation',
          rule: 'InvalidCoroutineFrame',
          function: fn.id,
          provenance: issue.operation.provenance,
          detail: issue.detail,
        }),
      ),
    )
    violations.push(...suspensionViolations(fn, self))
    const currentInstance = instanceText(fn.instance)
    const concreteTypes = [
      ...fn.instance.typeArguments.filter(SilkType.isTypeArgument),
      ...fn.localTypes.map(semanticType),
      semanticType(fn.result),
      ...fn.regions.flatMap(operationsOf).flatMap(operationTree).flatMap(operationTypes),
      ...suspensionTypes(fn),
    ]
    if (
      fn.instance.declaration.module !== fn.id.module ||
      fn.instance.declaration.name !== fn.id.name ||
      fn.instance.typeArguments.some(
        (argument) => !SilkType.isRuntimeConcreteGenericArgument(argument),
      ) ||
      concreteTypes.some((type) => !SilkType.isRuntimeConcrete(type)) ||
      instanceKeys.has(currentInstance)
    ) {
      violations.push({
        _tag: 'Violation',
        rule: 'InvalidInstance',
        function: fn.id,
        detail: instanceKeys.has(currentInstance)
          ? 'function repeats an existing concrete instance key'
          : 'function instance identity is inconsistent or retains an open type parameter',
      })
    }
    instanceKeys.add(currentInstance)
    const missingTypes = new Set(
      [...fn.localTypes, fn.result]
        .filter((type) => type._tag !== 'CallableValue')
        .map(semanticType)
        .filter(
          (type) =>
            Layout.entry(self.layout, type) === undefined &&
            Layout.callingShape(self.layout, type) === undefined,
        )
        .map(SilkType.key),
    )
    for (const type of [...missingTypes].sort()) {
      violations.push({
        _tag: 'Violation',
        rule: 'MissingTypeLayout',
        function: fn.id,
        detail: `function references ${type} without a layout entry`,
      })
    }

    const byId = new Map<number, Region>()
    for (const region of allRegions) {
      if (byId.has(region.id.ordinal)) {
        violations.push({
          _tag: 'Violation',
          rule: 'DuplicateRegionIdentity',
          function: fn.id,
          region: region.id,
          detail: `region r${region.id.ordinal} is declared more than once`,
        })
      } else byId.set(region.id.ordinal, region)
    }
    if (!byId.has(fn.entry.ordinal)) {
      violations.push({
        _tag: 'Violation',
        rule: 'MissingEntryRegion',
        function: fn.id,
        detail: `entry region r${fn.entry.ordinal} is missing`,
      })
    }
    for (const region of allRegions) {
      for (const [target] of regionTargets(region)) {
        if (!byId.has(target.ordinal)) {
          violations.push({
            _tag: 'Violation',
            rule: 'UnknownRegionTarget',
            function: fn.id,
            region: region.id,
            detail: `region references missing r${target.ordinal}`,
          })
        }
      }
    }

    const color = new Map<number, 0 | 1 | 2>()
    // Explicit stack: region depth is authored statement count, not JavaScript stack depth.
    const visit = (root: Region): void => {
      const pending: Array<{ readonly region: Region; readonly targets: Array<RegionId> }> = [
        { region: root, targets: regionTargets(root).map(([target]) => target) },
      ]
      color.set(root.id.ordinal, 1)
      while (pending.length > 0) {
        const frame = pending.at(-1)
        if (frame === undefined) break
        const target = frame.targets.shift()
        if (target === undefined) {
          color.set(frame.region.id.ordinal, 2)
          pending.pop()
          continue
        }
        const targetRegion = byId.get(target.ordinal)
        if (targetRegion === undefined) continue
        if (color.get(target.ordinal) === 1) {
          violations.push({
            _tag: 'Violation',
            rule: 'StructuralCycle',
            function: fn.id,
            region: frame.region.id,
            detail: `structural edge r${frame.region.id.ordinal} -> r${target.ordinal} forms a cycle`,
          })
        } else if (color.get(target.ordinal) !== 2) {
          color.set(target.ordinal, 1)
          pending.push({
            region: targetRegion,
            targets: regionTargets(targetRegion).map(([candidate]) => candidate),
          })
        }
      }
    }
    for (const region of [...allRegions].sort((a, b) => a.id.ordinal - b.id.ordinal)) {
      if (color.get(region.id.ordinal) === undefined) visit(region)
    }

    const loopRegions = allRegions.filter(
      (region): region is LoopRegion => region._tag === 'LoopRegion',
    )
    const loops = new Map<number, LoopRegion>()
    for (const region of loopRegions) loops.set(region.loop.ordinal, region)
    const loopIdCounts = new Map<number, number>()
    for (const loop of loopRegions)
      loopIdCounts.set(loop.loop.ordinal, (loopIdCounts.get(loop.loop.ordinal) ?? 0) + 1)
    const conditionOwners = new Map<number, Array<LoopRegion>>()
    for (const loop of loopRegions) {
      const owners = conditionOwners.get(loop.condition.ordinal) ?? []
      owners.push(loop)
      conditionOwners.set(loop.condition.ordinal, owners)
    }
    for (const loop of loopRegions) {
      const condition = byId.get(loop.condition.ordinal)
      const owners = conditionOwners.get(loop.condition.ordinal) ?? []
      if (
        loopIdCounts.get(loop.loop.ordinal) !== 1 ||
        owners.length !== 1 ||
        condition?._tag !== 'OperationRegion' ||
        condition.outcome._tag !== 'Yield' ||
        condition.ownerLoop?.ordinal !== loop.loop.ordinal
      ) {
        violations.push({
          _tag: 'Violation',
          rule: 'InvalidLoopTarget',
          function: fn.id,
          region: loop.id,
          detail: `loop${loop.loop.ordinal} must own one unique yielding operation condition`,
        })
      }
    }
    for (const region of allRegions) {
      const outcome = outcomeOf(region)
      if (outcome?._tag !== 'Yield') continue
      const owners = conditionOwners.get(region.id.ordinal) ?? []
      if (
        region._tag !== 'OperationRegion' ||
        owners.length !== 1 ||
        region.ownerLoop?.ordinal !== owners.at(0)?.loop.ordinal
      ) {
        violations.push({
          _tag: 'Violation',
          rule: 'InvalidLoopTarget',
          function: fn.id,
          region: region.id,
          detail: 'yield must be the uniquely owned operation condition of one lexical loop',
        })
      }
    }
    const loanBeginnings = new Map<string, number>()
    const loanEndings = new Map<string, number>()
    const localSharedLoans = new Map<
      string,
      {
        readonly count: number
        readonly operation: Extract<Operation, { readonly _tag: 'SharedWithMut' }>
      }
    >()
    const localUseCounts = new Map<number, number>()
    const successPathOperations = (operation: Operation): ReadonlyArray<Operation> => {
      if (operation._tag === 'DiagnosticScope')
        return [operation, ...executionOperations(operation.body).flatMap(successPathOperations)]
      if (operation._tag === 'Conditional') {
        return [
          operation,
          ...executionOperations(operation.taken).flatMap(successPathOperations),
          ...executionOperations(operation.otherwise).flatMap(successPathOperations),
        ]
      }
      if (operation._tag === 'ShortCircuit') {
        return [operation, ...executionOperations(operation.right).flatMap(successPathOperations)]
      }
      if (operation._tag === 'Match') {
        return [
          operation,
          ...operation.arms.flatMap((arm) => [
            ...(arm.guard === undefined
              ? []
              : executionOperations(arm.guard.execution).flatMap(successPathOperations)),
            ...executionOperations(arm.selected.execution).flatMap(successPathOperations),
          ]),
        ]
      }
      return [operation]
    }
    for (const operation of fn.regions.flatMap(operationsOf).flatMap(successPathOperations))
      for (const local of operation._tag === 'PropagateEffectFailure'
        ? [operation.source]
        : accessedOwnerLocals(operation))
        localUseCounts.set(local.ordinal, (localUseCounts.get(local.ordinal) ?? 0) + 1)
    const globalBeginnings = new Map<string, Extract<Operation, { readonly _tag: 'BeginLoan' }>>()
    for (const region of fn.regions) {
      for (const operation of operationsOf(region).flatMap(operationTree)) {
        if (operation._tag === 'BeginLoan') {
          const key = borrowKey(operation.borrow)
          loanBeginnings.set(key, (loanBeginnings.get(key) ?? 0) + 1)
          globalBeginnings.set(key, operation)
        } else if (operation._tag === 'EndLoan') {
          const key = borrowKey(operation.borrow)
          loanEndings.set(key, (loanEndings.get(key) ?? 0) + 1)
        } else if (operation._tag === 'SharedWithMut') {
          const key = borrowKey(operation.loan)
          const current = localSharedLoans.get(key)
          localSharedLoans.set(key, {
            count: (current?.count ?? 0) + 1,
            operation: current?.operation ?? operation,
          })
        }
      }
    }
    for (const [key, loan] of localSharedLoans) {
      if (loan.count !== 1 || loanBeginnings.has(key) || loanEndings.has(key)) {
        violations.push({
          _tag: 'Violation',
          rule: 'InvalidLocalSharedOperation',
          localSharedReason: 'AccessContract',
          function: fn.id,
          provenance: loan.operation.provenance,
          detail: `local-shared callback loan ${key} must identify exactly one closed access operation`,
        })
      }
    }
    const globalEndings = new Set(loanEndings.keys())
    for (const key of new Set([...loanBeginnings.keys(), ...loanEndings.keys()])) {
      const endings = loanEndings.get(key) ?? 0
      if (loanBeginnings.get(key) !== 1 || endings < 1 || !loanPathsValid(fn, key, byId, loops)) {
        violations.push({
          _tag: 'Violation',
          rule: 'InvalidLoan',
          function: fn.id,
          detail: `loan ${key} must begin once and end exactly once on every terminating path`,
        })
      }
    }
    const beginningsByDestination = new Map<
      number,
      readonly [string, Extract<Operation, { readonly _tag: 'BeginLoan' }>]
    >()
    for (const [key, beginning] of globalBeginnings)
      beginningsByDestination.set(beginning.destination.ordinal, [key, beginning])
    for (const [childKey, child] of globalBeginnings) {
      const parent = beginningsByDestination.get(child.root.ordinal)
      if (
        parent !== undefined &&
        parent[0] !== childKey &&
        !loanAncestryPathsValid(fn, parent[0], childKey, byId, loops)
      ) {
        violations.push({
          _tag: 'Violation',
          rule: 'InvalidLoan',
          function: fn.id,
          detail: `reborrow ${childKey} must remain within parent loan ${parent[0]} on every path`,
        })
      }
    }
    const isAncestor = (owner: LoopId | undefined, target: LoopId): boolean => {
      let current = owner
      const seen = new Set<number>()
      while (current !== undefined && !seen.has(current.ordinal)) {
        if (current.ordinal === target.ordinal) return true
        seen.add(current.ordinal)
        current = loops.get(current.ordinal)?.parent
      }
      return false
    }
    for (const region of allRegions) {
      if (fn.regions.includes(region)) continue
      const outcome = outcomeOf(region)
      if (region.ownerLoop !== undefined && !loops.has(region.ownerLoop.ordinal))
        violations.push({
          _tag: 'Violation',
          rule: 'InvalidLexicalOwner',
          function: fn.id,
          region: region.id,
          detail: 'nested execution references a missing lexical loop owner',
        })
      if (
        (outcome?._tag === 'Repeat' || outcome?._tag === 'Exit') &&
        !isAncestor(region.ownerLoop, outcome.loop)
      )
        violations.push({
          _tag: 'Violation',
          rule: 'InvalidLoopTarget',
          function: fn.id,
          region: region.id,
          detail: 'nested execution transfers to a non-ancestor loop',
        })
      if (outcome?._tag === 'Return') {
        const returned = fn.localTypes.at(outcome.value.ordinal)
        if (
          returned === undefined ||
          (returned._tag !== 'Bottom' && !realizesReturn(returned, fn.result))
        )
          violations.push({
            _tag: 'Violation',
            rule: 'InvalidReturn',
            function: fn.id,
            region: region.id,
            detail: 'nested execution return disagrees with the enclosing function contract',
          })
      }
    }
    for (const region of fn.regions) {
      violations.push(
        ...loanViolations(
          fn,
          self.layout,
          region,
          operationsOf(region),
          globalBeginnings,
          globalEndings,
        ),
      )
      if (region.ownerLoop !== undefined && !loops.has(region.ownerLoop.ordinal)) {
        violations.push({
          _tag: 'Violation',
          rule: 'InvalidLexicalOwner',
          function: fn.id,
          region: region.id,
          detail: `owner loop loop${region.ownerLoop.ordinal} is missing`,
        })
      }
      const outcome = outcomeOf(region)
      if (outcome?._tag === 'Return') {
        const returned = fn.localTypes.at(outcome.value.ordinal)
        if (
          returned !== undefined &&
          returned._tag !== 'Bottom' &&
          !realizesReturn(returned, fn.result)
        ) {
          violations.push({
            _tag: 'Violation',
            rule: 'InvalidReturn',
            function: fn.id,
            region: region.id,
            detail: `return local ${localText(outcome.value)} has ${SilkType.encode(semanticType(returned))}, expected ${SilkType.encode(semanticType(fn.result))}`,
          })
        }
      }
      if (
        (outcome?._tag === 'Repeat' || outcome?._tag === 'Exit') &&
        !isAncestor(region.ownerLoop, outcome.loop)
      ) {
        violations.push({
          _tag: 'Violation',
          rule: 'InvalidLoopTarget',
          function: fn.id,
          region: region.id,
          detail: `${outcome._tag.toLowerCase()} targets non-ancestor loop${outcome.loop.ordinal}`,
        })
      }
      for (const used of localUses(region)) {
        if (used.ordinal < 0 || used.ordinal >= fn.localTypes.length) {
          violations.push({
            _tag: 'Violation',
            rule: 'UndeclaredLocal',
            function: fn.id,
            region: region.id,
            detail: `references undeclared local %${used.ordinal}`,
          })
        }
      }
      for (const rootOperation of operationsOf(region)) {
        if (cyclicOperation(rootOperation)) {
          violations.push({
            _tag: 'Violation',
            rule: 'CyclicMatchOperation',
            function: fn.id,
            region: region.id,
            detail: 'nested match operations contain a structural cycle',
          })
        }
      }
      const operations = operationsOf(region).flatMap(operationTree)
      for (const [index, operation] of operations.entries()) {
        const invalidString = (detail: string): void => {
          violations.push({
            _tag: 'Violation',
            rule: 'InvalidStringOperation',
            function: fn.id,
            region: region.id,
            detail,
          })
        }
        const heldStringLoansValid = (
          heldLoans: ReadonlyArray<Tir.BorrowId>,
          source?: LocalId,
        ): boolean => {
          const keys = heldLoans.map(borrowKey)
          return (
            new Set(keys).size === keys.length &&
            heldLoans.every((borrow) => {
              const key = borrowKey(borrow)
              const beginning = globalBeginnings.get(key)
              return (
                beginning !== undefined &&
                globalEndings.has(key) &&
                (source === undefined || beginning.destination.ordinal === source.ordinal)
              )
            })
          )
        }
        if (operation._tag === 'StaticString') {
          const destination = fn.localTypes.at(operation.destination.ordinal)
          const data = self.staticData?.find((candidate) => candidate.id === operation.data)
          if (
            destination?._tag !== 'String' ||
            operation.type._tag !== 'String' ||
            !Lifetime.equals(operation.type.type.lifetime, Lifetime.staticLifetime) ||
            data?.kind !== 'Text' ||
            !data.utf8 ||
            data.bytes.length !== operation.byteLength
          ) {
            invalidString(
              'static string disagrees with its UTF-8 data, byte length, or string destination',
            )
          }
        }
        if (operation._tag === 'StringFromUtf8Unchecked') {
          const bytes = fn.localTypes.at(operation.bytes.ordinal)
          const destination = fn.localTypes.at(operation.destination.ordinal)
          if (
            bytes?._tag !== 'Slice' ||
            !SilkType.equals(
              bytes.type,
              SilkType.slice('Shared', 'u8', operation.type.type.lifetime),
            ) ||
            destination?._tag !== 'String' ||
            operation.type._tag !== 'String' ||
            operation.authorization !== 'Unsafe' ||
            !heldStringLoansValid(operation.heldLoans, operation.bytes)
          ) {
            invalidString(
              'unchecked formation requires unsafe authorization, one shared byte view, retained backing loans, and a string destination',
            )
          }
        }
        if (operation._tag === 'StringUtf8Bytes') {
          const string = fn.localTypes.at(operation.string.ordinal)
          const destination = fn.localTypes.at(operation.destination.ordinal)
          if (
            string?._tag !== 'String' ||
            destination?._tag !== 'Slice' ||
            !SilkType.equals(destination.type, operation.type.type) ||
            operation.type.type.access !== 'Shared' ||
            operation.type.type.element !== 'u8' ||
            !heldStringLoansValid(operation.heldLoans)
          ) {
            invalidString(
              'UTF-8 byte viewing requires a string source, an immutable byte-view destination, and retained backing loans',
            )
          }
        }
        if (operation._tag === 'StringByteLength') {
          const string = fn.localTypes.at(operation.string.ordinal)
          const destination = fn.localTypes.at(operation.destination.ordinal)
          if (string?._tag !== 'String' || destination?._tag !== 'usize') {
            invalidString('string byte length requires a string source and usize destination')
          }
        }
        if (operation._tag === 'StringEqualsExact') {
          const left = fn.localTypes.at(operation.left.ordinal)
          const right = fn.localTypes.at(operation.right.ordinal)
          const destination = fn.localTypes.at(operation.destination.ordinal)
          if (left?._tag !== 'String' || right?._tag !== 'String' || destination?._tag !== 'bool') {
            invalidString(
              'exact string equality requires two string operands and a bool destination',
            )
          }
        }
        if (
          operation._tag === 'EnumConstant' ||
          operation._tag === 'EnumValue' ||
          operation._tag === 'EnumEquality'
        ) {
          const enumType = SilkType.nominal(operation.enum.module, operation.enum.name)
          const layoutEntry = Layout.entry(self.layout, enumType)
          const canonical =
            layoutEntry?.representation._tag === 'ScalarEnum'
              ? layoutEntry.representation
              : undefined
          const destination = fn.localTypes.at(operation.destination.ordinal)
          let valid =
            canonical !== undefined &&
            enumRepresentationMatches(operation.representation, canonical) &&
            operation.representation.enum.module === operation.enum.module &&
            operation.representation.enum.name === operation.enum.name
          if (operation._tag === 'EnumConstant') {
            const declared = canonical?.members.find(
              (member) =>
                member.member.enum.module === operation.member.enum.module &&
                member.member.enum.name === operation.member.enum.name &&
                member.member.name === operation.member.name,
            )
            valid =
              valid &&
              operation.type._tag === 'Enum' &&
              enumRepresentationMatches(operation.type.representation, operation.representation) &&
              SilkType.equals(operation.type.type, enumType) &&
              destination?._tag === 'Enum' &&
              SilkType.equals(destination.type, enumType) &&
              declared !== undefined &&
              declared.discriminant === operation.discriminant
          } else if (operation._tag === 'EnumValue') {
            const source = fn.localTypes.at(operation.source.ordinal)
            valid =
              valid &&
              source?._tag === 'Enum' &&
              SilkType.equals(source.type, enumType) &&
              enumRepresentationMatches(source.representation, operation.representation) &&
              destination?._tag === operation.representation.scalar &&
              operation.type._tag === operation.representation.scalar
          } else {
            const left = fn.localTypes.at(operation.left.ordinal)
            const right = fn.localTypes.at(operation.right.ordinal)
            valid =
              valid &&
              left?._tag === 'Enum' &&
              right?._tag === 'Enum' &&
              SilkType.equals(left.type, enumType) &&
              SilkType.equals(right.type, enumType) &&
              enumRepresentationMatches(left.representation, operation.representation) &&
              enumRepresentationMatches(right.representation, operation.representation) &&
              destination?._tag === 'bool' &&
              operation.type._tag === 'bool'
          }
          if (!valid)
            violations.push({
              _tag: 'Violation',
              rule: 'InvalidEnumOperation',
              function: fn.id,
              region: region.id,
              detail: `${operation._tag} disagrees with its canonical enum identity, member, discriminant, or representation lane`,
            })
        }
        if (operation._tag === 'StaticView') {
          const destination = fn.localTypes.at(operation.destination.ordinal)
          const data = self.staticData?.find((candidate) => candidate.id === operation.data)
          if (
            destination === undefined ||
            destination._tag !== 'Slice' ||
            !SilkType.equals(destination.type, operation.type.type) ||
            operation.type.type.access !== 'Shared' ||
            operation.type.type.element !== 'u8' ||
            data === undefined ||
            data.bytes.length !== operation.length
          ) {
            violations.push({
              _tag: 'Violation',
              rule: 'InvalidSliceOperation',
              function: fn.id,
              region: region.id,
              detail: 'static view disagrees with its immutable bytes, length, or destination',
            })
          }
        }
        if (operation._tag === 'Literal') {
          const destination = fn.localTypes.at(operation.destination.ordinal)
          const semantic = semanticType(operation.type)
          const value = BigInt(operation.value)
          const scalar = typeof semantic === 'string' ? Scalar.find(semantic) : undefined
          const pointerBits = self.layout.target.pointerSize === 4 ? 32 : 64
          let validValue = false
          if (scalar?.category === 'Integer') {
            const range = Scalar.range(scalar, pointerBits)
            validValue = value >= range.minimum && value <= range.maximum
          } else if (scalar?.category === 'Boolean') {
            validValue = value === 0n || value === 1n
          } else if (scalar?.category === 'Character') {
            // A Unicode scalar value: inside the range and outside the surrogate hole.
            validValue =
              value >= 0n && value <= 0x10ffffn && !(value >= 0xd800n && value <= 0xdfffn)
          } else if (scalar?.category === 'Floating') {
            validValue = value >= 0n && value < 1n << BigInt(Scalar.bits(scalar, pointerBits))
          }
          if (
            destination === undefined ||
            !SilkType.equals(semanticType(destination), semantic) ||
            !validValue
          ) {
            violations.push({
              _tag: 'Violation',
              rule: 'InvalidIntegerOperation',
              function: fn.id,
              region: region.id,
              detail: `literal ${operation.value.toString()} disagrees with its destination or target range`,
            })
          }
        }
        if (operation._tag === 'Binary') {
          const left = fn.localTypes.at(operation.left.ordinal)
          const right = fn.localTypes.at(operation.right.ordinal)
          const destination = fn.localTypes.at(operation.destination.ordinal)
          const operand = left === undefined ? undefined : semanticType(left)
          const comparison =
            operation.operator === 'Equals' ||
            operation.operator === 'NotEquals' ||
            operation.operator === 'LessThan' ||
            operation.operator === 'LessOrEqual' ||
            operation.operator === 'GreaterThan' ||
            operation.operator === 'GreaterOrEqual' ||
            operation.operator === 'TotalOrder'
          const scalar = typeof operand === 'string' ? Scalar.find(operand) : undefined
          const supportsOperation =
            scalar?.category === 'Integer' ||
            (scalar?.category === 'Floating' &&
              (comparison ||
                operation.operator === 'Add' ||
                operation.operator === 'Subtract' ||
                operation.operator === 'Multiply' ||
                operation.operator === 'Divide' ||
                operation.operator === 'Remainder')) ||
            (scalar?.category === 'Boolean' &&
              (operation.operator === 'Equals' || operation.operator === 'NotEquals')) ||
            (scalar?.category === 'Character' && comparison && operation.operator !== 'TotalOrder')
          const expectedResult = comparison ? 'bool' : operand
          if (
            operand === undefined ||
            right === undefined ||
            destination === undefined ||
            !SilkType.equals(semanticType(right), operand) ||
            !supportsOperation ||
            expectedResult === undefined ||
            !SilkType.equals(semanticType(operation.type), expectedResult) ||
            !SilkType.equals(semanticType(destination), expectedResult)
          ) {
            violations.push({
              _tag: 'Violation',
              rule: 'InvalidIntegerOperation',
              function: fn.id,
              region: region.id,
              detail: `${operation.operator} has inconsistent operand or result types`,
            })
          }
        }
        if (operation._tag === 'ConvertInteger') {
          const source = fn.localTypes.at(operation.source.ordinal)
          const destination = fn.localTypes.at(operation.destination.ordinal)
          const sourceScalar = Scalar.find(operation.sourceType._tag)
          const targetScalar = Scalar.find(operation.type._tag)
          if (
            sourceScalar?.category !== 'Integer' ||
            targetScalar?.category !== 'Integer' ||
            source === undefined ||
            destination === undefined ||
            !SilkType.equals(semanticType(source), operation.sourceType._tag) ||
            !SilkType.equals(semanticType(destination), operation.type._tag)
          )
            violations.push({
              _tag: 'Violation',
              rule: 'InvalidIntegerOperation',
              function: fn.id,
              region: region.id,
              detail: 'integer conversion has inconsistent source or destination types',
            })
        }
        if (
          operation._tag === 'ConvertScalar' ||
          operation._tag === 'ReinterpretScalar' ||
          operation._tag === 'FloatUnary' ||
          operation._tag === 'FloatTranscendental'
        ) {
          const source = fn.localTypes.at(operation.source.ordinal)
          const destination = fn.localTypes.at(operation.destination.ordinal)
          const sourceScalar = Scalar.find(operation.sourceType._tag)
          const targetScalar = Scalar.find(operation.type._tag)
          const pointerBits = self.layout.target.pointerSize === 4 ? 32 : 64
          const reinterpretable =
            operation._tag !== 'ReinterpretScalar' ||
            (sourceScalar !== undefined &&
              targetScalar !== undefined &&
              Scalar.bits(sourceScalar, pointerBits) === Scalar.bits(targetScalar, pointerBits) &&
              sourceScalar.category !== targetScalar.category)
          const unary =
            operation._tag !== 'FloatUnary' ||
            (sourceScalar?.category === 'Floating' &&
              (operation.operation === 'Negate' || operation.operation === 'Sqrt'
                ? targetScalar?.spelling === sourceScalar.spelling
                : targetScalar?.category === 'Boolean'))
          const transcendental =
            operation._tag !== 'FloatTranscendental' ||
            (sourceScalar?.category === 'Floating' &&
              targetScalar?.spelling === sourceScalar.spelling &&
              (operation.operation === 'Sin' || operation.operation === 'Cos'))
          if (
            sourceScalar === undefined ||
            targetScalar === undefined ||
            sourceScalar.category === 'Boolean' ||
            (operation._tag !== 'FloatUnary' && targetScalar.category === 'Boolean') ||
            source === undefined ||
            destination === undefined ||
            !SilkType.equals(semanticType(source), operation.sourceType._tag) ||
            !SilkType.equals(semanticType(destination), operation.type._tag) ||
            !reinterpretable ||
            !unary ||
            !transcendental
          )
            violations.push({
              _tag: 'Violation',
              rule: 'InvalidIntegerOperation',
              function: fn.id,
              region: region.id,
              detail: `${operation._tag} has inconsistent source or destination types`,
            })
        }
        if (operation._tag === 'CheckedScalar') {
          const destination = fn.localTypes.at(operation.destination.ordinal)
          const valid = fn.localTypes.at(operation.valid.ordinal)
          const value = fn.localTypes.at(operation.value.ordinal)
          const present = fn.localTypes.at(operation.present.ordinal)
          const absent = fn.localTypes.at(operation.absent.ordinal)
          const operands = operation.operands.map((operand) => fn.localTypes.at(operand.ordinal))
          const sourceScalar = Scalar.find(operation.sourceType._tag)
          const valueScalar = Scalar.find(operation.valueType._tag)
          const characterConversion =
            operation.operation === 'CheckedConvertToChar' &&
            sourceScalar?.spelling === 'u32' &&
            valueScalar?.category === 'Character'
          const integerOperation =
            sourceScalar?.category === 'Integer' && valueScalar?.category === 'Integer'
          if (
            (!characterConversion && !integerOperation) ||
            destination === undefined ||
            valid?._tag !== 'bool' ||
            value?._tag !== operation.valueType._tag ||
            present?._tag !== 'CallableValue' ||
            absent?._tag !== 'CallableValue' ||
            operands.length < 1 ||
            operands.some(
              (operand) =>
                operand === undefined ||
                !SilkType.equals(semanticType(operand), operation.sourceType._tag),
            ) ||
            !SilkType.equals(semanticType(destination), semanticType(operation.type)) ||
            present.type.parameters.length !== 1 ||
            !SilkType.equals(present.type.parameters[0] ?? 'never', operation.valueType._tag) ||
            !SilkType.equals(present.type.result, semanticType(operation.type)) ||
            absent.type.parameters.length !== 0 ||
            !SilkType.equals(absent.type.result, semanticType(operation.type))
          )
            violations.push({
              _tag: 'Violation',
              rule: 'InvalidIntegerOperation',
              function: fn.id,
              region: region.id,
              detail: 'checked scalar operation has inconsistent operands or carrier result',
            })
        }
        if (operation._tag === 'ValidateLayout' || operation._tag === 'RepeatLayout') {
          const destination = fn.localTypes.at(operation.destination.ordinal)
          const left = fn.localTypes.at(
            operation._tag === 'ValidateLayout'
              ? operation.bytes.ordinal
              : operation.layout.ordinal,
          )
          const right = fn.localTypes.at(
            operation._tag === 'ValidateLayout'
              ? operation.alignment.ordinal
              : operation.count.ordinal,
          )
          const expectedMembers = [
            SilkType.layout,
            operation._tag === 'ValidateLayout'
              ? SilkType.invalidAlignment
              : SilkType.layoutOverflow,
          ].sort(SilkType.compare)
          const validLeft =
            operation._tag === 'ValidateLayout'
              ? left?._tag === 'usize'
              : left?._tag === 'Nominal' && SilkType.equals(left.type, SilkType.layout)
          if (
            !validLeft ||
            right?._tag !== 'usize' ||
            destination?._tag !== 'Union' ||
            !SilkType.equals(destination.type, operation.type.type) ||
            !sameMembers(operation.type.type.members, expectedMembers)
          ) {
            violations.push({
              _tag: 'Violation',
              rule: 'InvalidLayoutOperation',
              function: fn.id,
              region: region.id,
              detail: `${operation._tag} has inconsistent operands or validation result`,
            })
          }
        }
        if (operation._tag === 'Allocate') {
          const layout = fn.localTypes.at(operation.layout.ordinal)
          const destination = fn.localTypes.at(operation.destination.ordinal)
          const expectedFailure = SilkType.failureCarrierMember(
            operation.propagationType.type,
            operation.failureTag,
            'OneBased',
          )
          if (
            layout?._tag !== 'Nominal' ||
            !SilkType.equals(layout.type, SilkType.layout) ||
            destination?._tag !== 'Nominal' ||
            !SilkType.equals(destination.type, SilkType.allocation) ||
            !SilkType.equals(operation.type.type, SilkType.allocation) ||
            !SilkType.equals(operation.failure, SilkType.storageFailure) ||
            expectedFailure === undefined ||
            !SilkType.equals(expectedFailure, operation.failure) ||
            !SilkType.equals(semanticType(fn.result), operation.propagationType.type)
          )
            violations.push({
              _tag: 'Violation',
              rule: 'InvalidAllocationOperation',
              function: fn.id,
              region: region.id,
              detail:
                'allocation does not preserve Layout, Allocation, or sealed storage-failure contracts',
            })
        }
        if (operation._tag === 'ForeignStaticLoad') {
          const record = self.foreignStatics.find((candidate) =>
            sameDeclaration(candidate.declaration, operation.declaration),
          )
          const destination = fn.localTypes.at(operation.destination.ordinal)
          if (
            record === undefined ||
            record.symbol !== operation.symbol ||
            record.direction !== operation.direction ||
            !SilkType.equals(record.type, semanticType(operation.type)) ||
            destination === undefined ||
            !SilkType.equals(semanticType(destination), record.type) ||
            !foreignStaticInitializerValid(record)
          ) {
            violations.push({
              _tag: 'Violation',
              rule: 'InvalidForeignOperation',
              function: fn.id,
              region: region.id,
              detail: `Foreign static load ${operation.symbol} does not match its declaration inventory`,
            })
          }
        }
        if (operation._tag === 'ForeignFunctionAddress') {
          const declaration =
            operation.target._tag === 'DeclarationCallableTarget'
              ? operation.target.declaration
              : undefined
          const record = self.foreignExports.find(
            (candidate) =>
              declaration !== undefined &&
              sameDeclaration(candidate.declaration, declaration) &&
              candidate.symbol === operation.symbol,
          )
          const destination = fn.localTypes.at(operation.destination.ordinal)
          const implementation =
            record === undefined
              ? undefined
              : self.functions.find((candidate) => matchesInstanceKey(candidate, record.key))
          const implementationParameters =
            implementation?.localTypes.slice(0, implementation.parameterCount).map(semanticType) ??
            []
          const implementationType =
            implementation === undefined
              ? undefined
              : SilkType.foreignFunction(
                  implementationParameters,
                  semanticType(implementation.result),
                  record?.type.contract,
                  record?.type,
                )
          const signatureAdmitted =
            operation.type.type.parameters.every((parameter, ordinal) =>
              SilkType.isReference(parameter)
                ? operation.type.type.contract.borrow.includes(ordinal)
                : CAbi.admit(parameter, 'Parameter')._tag === 'Admitted',
            ) && CAbi.admit(operation.type.type.result, 'Result')._tag === 'Admitted'
          const signature = signatureAdmitted
            ? CAbi.signature(
                operation.type.type.parameters,
                operation.type.type.result,
                self.layout.target,
                operation.type.type.contract,
              )
            : undefined
          if (
            record === undefined ||
            !sameDeclaration(record.key.declaration, record.declaration) ||
            (self.layout.target.kind === 'Native' &&
              (implementationType === undefined ||
                !SilkType.equals(implementationType, record.type))) ||
            !TypeCompatibility.isCompatible(
              TypeCompatibility.check(operation.type.type, record.type),
            ) ||
            signature === undefined ||
            CAbi.signatureKey(record.signature) !== CAbi.signatureKey(signature) ||
            destination?._tag !== 'ForeignFunction' ||
            !SilkType.equals(destination.type, operation.type.type)
          ) {
            violations.push({
              _tag: 'Violation',
              rule: 'InvalidForeignOperation',
              function: fn.id,
              region: region.id,
              detail: `Foreign function address ${operation.symbol} does not match its export inventory`,
            })
          }
        }
        if (operation._tag === 'ForeignCall' || operation._tag === 'ForeignIndirectCall') {
          const target = self.layout.target
          const classKey = (
            type: Type | undefined,
            position: CAbi.Position,
          ): string | undefined => {
            if (type === undefined) return undefined
            const semantic = semanticType(type)
            return CAbi.admit(semantic, position)._tag === 'Admitted'
              ? CAbi.typeText(CAbi.classify(semantic, target, position))
              : undefined
          }
          const variadicArguments =
            operation._tag === 'ForeignCall' ? operation.variadicArguments : []
          const resultKey = CAbi.typeText(operation.signature.result)
          const argumentsValid =
            operation.signature.parameters.length + variadicArguments.length ===
              operation.arguments.length &&
            (operation.signature.variadic || variadicArguments.length === 0) &&
            variadicArguments.every((argument, ordinal) => {
              const local = operation.arguments.at(operation.signature.parameters.length + ordinal)
              const actual = local === undefined ? undefined : fn.localTypes.at(local.ordinal)
              const expected =
                actual === undefined
                  ? undefined
                  : CAbi.promoteVariadic(semanticType(actual), target)
              return (
                expected !== undefined &&
                CAbi.isCanonical(argument.source, target) &&
                CAbi.isCanonical(argument.promoted, target) &&
                CAbi.typeText(expected.source) === CAbi.typeText(argument.source) &&
                CAbi.typeText(expected.promoted) === CAbi.typeText(argument.promoted)
              )
            }) &&
            operation.signature.parameters.every((parameter, ordinal) => {
              const argument = operation.arguments.at(ordinal)
              const actual = argument === undefined ? undefined : fn.localTypes.at(argument.ordinal)
              if (parameter._tag === 'Pointer') {
                // Argument conversion may only weaken qualifiers; the pointee remains invariant.
                const semantic = actual === undefined ? undefined : semanticType(actual)
                if (
                  semantic !== undefined &&
                  SilkType.isReference(semantic) &&
                  operation.signature.contract.borrow.includes(ordinal)
                )
                  return (
                    parameter.type.extent === 'Single' &&
                    !parameter.type.nullable &&
                    parameter.type.mutable === (semantic.access === 'Exclusive') &&
                    SilkType.key(semantic.target) === SilkType.key(parameter.type.pointee)
                  )
                return (
                  semantic !== undefined &&
                  SilkType.isPointer(semantic) &&
                  SilkType.pointerQualifiersWeaken(semantic, parameter.type) &&
                  SilkType.key(semantic.pointee) === SilkType.key(parameter.type.pointee)
                )
              }
              return classKey(actual, 'Parameter') === CAbi.typeText(parameter)
            })
          const callee =
            operation._tag === 'ForeignIndirectCall'
              ? fn.localTypes.at(operation.callee.ordinal)
              : undefined
          const calleeValid =
            operation._tag !== 'ForeignIndirectCall' ||
            (callee?._tag === 'ForeignFunction' &&
              CAbi.signatureKey(
                CAbi.signature(
                  callee.type.parameters,
                  callee.type.result,
                  target,
                  callee.type.contract,
                ),
              ) === CAbi.signatureKey(operation.signature))
          if (
            !calleeValid ||
            !CAbi.isCanonicalSignature(operation.signature, target) ||
            !argumentsValid ||
            classKey(fn.localTypes.at(operation.destination.ordinal), 'Result') !== resultKey ||
            classKey(operation.type, 'Result') !== resultKey
          ) {
            violations.push({
              _tag: 'Violation',
              rule: 'InvalidForeignCall',
              function: fn.id,
              region: region.id,
              detail: `Foreign call ${operation._tag === 'ForeignCall' ? operation.symbol : 'indirect'} does not match its classified C signature ${CAbi.signatureKey(operation.signature)}`,
            })
          }
        }
        if (operation._tag === 'RawBufferFrom') {
          const allocation = fn.localTypes.at(operation.allocation.ordinal)
          const count = fn.localTypes.at(operation.count.ordinal)
          const destination = fn.localTypes.at(operation.destination.ordinal)
          const elementLayout = Layout.entry(self.layout, operation.element)
          const expectedStride =
            elementLayout === undefined
              ? undefined
              : Math.ceil(elementLayout.size / elementLayout.alignment) * elementLayout.alignment
          if (
            allocation?._tag !== 'Nominal' ||
            !SilkType.equals(allocation.type, SilkType.allocation) ||
            count?._tag !== 'usize' ||
            destination?._tag !== 'Nominal' ||
            !SilkType.isRawBuffer(destination.type) ||
            !SilkType.equals(destination.type, operation.type.type) ||
            !SilkType.equals(destination.type.arguments[0], operation.element) ||
            expectedStride === undefined ||
            operation.stride !== expectedStride ||
            operation.elementAlignment !== elementLayout?.alignment
          ) {
            violations.push({
              _tag: 'Violation',
              rule: 'InvalidRawStorageOperation',
              function: fn.id,
              region: region.id,
              detail:
                'RawBuffer construction lost allocation, count, element, or layout provenance',
            })
          }
        }
        if (operation._tag === 'SharedFromAllocation') {
          const allocation = fn.localTypes.at(operation.allocation.ordinal)
          const value = fn.localTypes.at(operation.value.ordinal)
          const destination = fn.localTypes.at(operation.destination.ordinal)
          const elementLayout = Layout.entry(self.layout, operation.element)
          const expected =
            elementLayout === undefined
              ? undefined
              : LocalSharedControlBlock.plan(self.layout.target, operation.element, elementLayout)
          const sameSpan = (left: SourceSpan.SourceSpan, right: SourceSpan.SourceSpan): boolean =>
            left.sourceId === right.sourceId && left.start === right.start && left.end === right.end
          const allocationFact = self.layout.localSharedAllocationProvenance.facts.at(
            operation.allocationFact,
          )
          if (
            allocation?._tag !== 'Nominal' ||
            !SilkType.equals(allocation.type, SilkType.allocation) ||
            value === undefined ||
            !SilkType.equals(semanticType(value), operation.element) ||
            destination?._tag !== 'Nominal' ||
            !SilkType.isSharedCore(destination.type) ||
            !SilkType.equals(destination.type, operation.type.type) ||
            !SilkType.equals(destination.type.arguments[0], operation.element) ||
            operation.allocationAccess !== 'Take' ||
            operation.valueAccess !== 'Take' ||
            localUseCounts.get(operation.allocation.ordinal) !== 1 ||
            localUseCounts.get(operation.value.ordinal) !== 1 ||
            !Number.isSafeInteger(operation.allocationFact) ||
            operation.allocationFact < 0 ||
            allocationFact === undefined ||
            !sameSpan(allocationFact.expression.span, operation.provenance.span) ||
            !SilkType.equals(allocationFact.element, operation.element) ||
            !sameSpan(allocationFact.span, operation.allocationProvenance) ||
            expected?._tag !== 'LocalSharedControlBlockPlan' ||
            !LocalSharedControlBlock.equals(expected, operation.block) ||
            !LocalSharedControlBlock.equals(operation.allocationBlock, operation.block)
          )
            violations.push({
              _tag: 'Violation',
              rule: 'InvalidLocalSharedOperation',
              localSharedReason: 'InitializationContract',
              function: fn.id,
              region: region.id,
              provenance: operation.provenance,
              detail: `Local-shared initialization lost allocation, element, target-layout, or control-block provenance (uses=${localUseCounts.get(operation.allocation.ordinal) ?? 0}/${localUseCounts.get(operation.value.ordinal) ?? 0})`,
            })
        }
        if (operation._tag === 'ExecutionFromAllocation') {
          const matchesSpan = (
            left: SourceSpan.SourceSpan,
            right: SourceSpan.SourceSpan,
          ): boolean =>
            left.sourceId === right.sourceId && left.start === right.start && left.end === right.end
          const allocation = fn.localTypes.at(operation.allocation.ordinal)
          const body = fn.localTypes.at(operation.body.ordinal)
          const endpoint = fn.localTypes.at(operation.endpoint.ordinal)
          const callback = fn.localTypes.at(operation.callback.ordinal)
          const destination = fn.localTypes.at(operation.destination.ordinal)
          const result = SilkType.isExecution(operation.type.type)
            ? SilkType.typeArgumentAt(operation.type.type, 0)
            : undefined
          const canonical = self.layout.executionPackages.plans.find(
            (candidate) => candidate.provenance === operation.plan.provenance,
          )
          const allocationFact = self.layout.localSharedAllocationProvenance.executionFacts.at(
            operation.allocationFact,
          )
          const factResult = allocationFact?.arguments.at(0)
          const factBodyArgument = allocationFact?.arguments.at(1)
          const factEndpoint = allocationFact?.arguments.at(2)
          const factCallbackArgument = allocationFact?.arguments.at(3)
          const factBody =
            factBodyArgument === undefined ? undefined : SilkType.representedType(factBodyArgument)
          const factCallback =
            factCallbackArgument === undefined
              ? undefined
              : SilkType.representedType(factCallbackArgument)
          const bodyType = body === undefined ? undefined : semanticType(body)
          const plannedBodyType = SilkType.isRepresented(operation.plan.specialization.body)
            ? operation.plan.specialization.body.contract
            : operation.plan.specialization.body
          const bodyMatches =
            bodyType !== undefined &&
            SilkType.isEffect(bodyType) &&
            SilkType.isEffect(plannedBodyType)
              ? SilkType.representationAdmissibility(plannedBodyType, bodyType)._tag === 'Admitted'
              : bodyType !== undefined && SilkType.equals(bodyType, plannedBodyType)
          if (
            allocation?._tag !== 'Nominal' ||
            !SilkType.equals(allocation.type, SilkType.allocation) ||
            body === undefined ||
            endpoint === undefined ||
            callback === undefined ||
            destination?._tag !== 'Nominal' ||
            !SilkType.isExecution(destination.type) ||
            !SilkType.equals(destination.type, operation.type.type) ||
            result === undefined ||
            !SilkType.equals(result, operation.plan.specialization.result) ||
            !bodyMatches ||
            !SilkType.equals(semanticType(endpoint), operation.plan.specialization.endpoint) ||
            !SilkType.equals(
              semanticType(callback),
              SilkType.isRepresented(operation.plan.specialization.callback)
                ? operation.plan.specialization.callback.contract
                : operation.plan.specialization.callback,
            ) ||
            canonical === undefined ||
            !ExecutionPackage.equals(canonical, operation.plan) ||
            operation.plan.target !== self.layout.target.id ||
            !Number.isSafeInteger(operation.allocationFact) ||
            operation.allocationFact < 0 ||
            allocationFact === undefined ||
            !matchesSpan(allocationFact.expression.span, operation.provenance.span) ||
            !matchesSpan(allocationFact.span, operation.allocationProvenance) ||
            factResult === undefined ||
            !SilkType.isTypeArgument(factResult) ||
            !SilkType.equals(factResult, operation.plan.specialization.result) ||
            factBody === undefined ||
            !SilkType.equals(factBody, operation.plan.specialization.body) ||
            factEndpoint === undefined ||
            !SilkType.isTypeArgument(factEndpoint) ||
            !SilkType.equals(factEndpoint, operation.plan.specialization.endpoint) ||
            factCallback === undefined ||
            !SilkType.equals(factCallback, operation.plan.specialization.callback) ||
            operation.allocationAccess !== 'Take' ||
            operation.bodyAccess !== 'Take' ||
            operation.endpointAccess !== 'Take' ||
            operation.callbackAccess !== 'Take' ||
            localUseCounts.get(operation.allocation.ordinal) !== 1 ||
            localUseCounts.get(operation.body.ordinal) !== 1 ||
            localUseCounts.get(operation.endpoint.ordinal) !== 1 ||
            localUseCounts.get(operation.callback.ordinal) !== 1
          )
            violations.push({
              _tag: 'Violation',
              rule: 'InvalidExecutionOperation',
              function: fn.id,
              region: region.id,
              provenance: operation.provenance,
              detail:
                'Execution initialization lost exact package, input type, target, or consuming ownership provenance',
            })
        }
        if (operation._tag === 'ExecutionDrive') {
          const execution = fn.localTypes.at(operation.execution.ordinal)
          const branch = fn.localTypes.at(operation.branch.ordinal)
          const complete = fn.localTypes.at(operation.onComplete.ordinal)
          const suspend = fn.localTypes.at(operation.onSuspend.ordinal)
          const destination = fn.localTypes.at(operation.destination.ordinal)
          const resultLocal = fn.localTypes.at(operation.result.ordinal)
          const result =
            execution?._tag === 'Nominal' && SilkType.isExecution(execution.type)
              ? SilkType.typeArgumentAt(execution.type, 0)
              : undefined
          const completeSemantic = complete === undefined ? undefined : semanticType(complete)
          const completeActual =
            completeSemantic !== undefined && SilkType.isRepresented(completeSemantic)
              ? completeSemantic.contract
              : completeSemantic
          const suspendSemantic = suspend === undefined ? undefined : semanticType(suspend)
          const suspendActual =
            suspendSemantic !== undefined && SilkType.isRepresented(suspendSemantic)
              ? suspendSemantic.contract
              : suspendSemantic
          const completeContract =
            branch === undefined ||
            result === undefined ||
            completeActual === undefined ||
            !SilkType.isCallable(completeActual)
              ? undefined
              : SilkType.callable(
                  [semanticType(branch), result],
                  SilkType.unit,
                  completeActual,
                  'Take',
                )
          const suspendContract =
            branch === undefined ||
            result === undefined ||
            suspendActual === undefined ||
            !SilkType.isCallable(suspendActual)
              ? undefined
              : SilkType.callable(
                  [semanticType(branch), SilkType.execution(result)],
                  SilkType.unit,
                  suspendActual,
                  'Take',
                )
          const driveCallbackCleanupValid = (
            local: Type | undefined,
            cleanup: CleanupPlan.CleanupPlan,
          ): boolean => {
            if (local?._tag !== 'CallableValue') return false
            const fields =
              local.environment?.fields
                .filter((field) => field.access === 'Take' && !isCopy(self.layout, field.type))
                .reverse() ?? []
            if (local.environment === undefined)
              return cleanup._tag === 'NoCleanup' && SilkType.equals(cleanup.type, local.type)
            return (
              cleanup._tag === 'CallableCleanup' &&
              SilkType.equals(cleanup.type, local.type) &&
              cleanup.environment._tag === 'CallableEnvironmentIdentity' &&
              SilkType.equalsCallableEnvironmentIdentity(
                cleanup.environment.identity,
                Instances.callableEnvironmentIdentity(local.environment.callable),
              ) &&
              cleanup.slots.length === fields.length &&
              cleanup.slots.every((slot, ordinal) => {
                const field = fields.at(ordinal)
                return (
                  field !== undefined &&
                  slot.ordinal === field.ordinal &&
                  cleanupMatchesSemanticType(self.layout, slot.cleanup, field.type)
                )
              })
            )
          }
          if (
            execution?._tag !== 'Nominal' ||
            !SilkType.isExecution(execution.type) ||
            branch === undefined ||
            complete === undefined ||
            suspend === undefined ||
            destination?._tag !== 'Nominal' ||
            !SilkType.equals(destination.type, SilkType.unit) ||
            resultLocal === undefined ||
            result === undefined ||
            !SilkType.equals(semanticType(resultLocal), result) ||
            completeContract === undefined ||
            suspendContract === undefined ||
            completeActual === undefined ||
            suspendActual === undefined ||
            !acceptsRuntimeOperand(completeActual, completeContract) ||
            !acceptsRuntimeOperand(suspendActual, suspendContract) ||
            !driveCallbackCleanupValid(complete, operation.completionCleanup) ||
            !driveCallbackCleanupValid(suspend, operation.suspensionCleanup) ||
            operation.executionAccess !== 'Take' ||
            operation.branchAccess !== 'Take' ||
            operation.completionAccess !== 'Take' ||
            operation.suspensionAccess !== 'Take' ||
            localUseCounts.get(operation.execution.ordinal) !== 1 ||
            localUseCounts.get(operation.branch.ordinal) !== 1 ||
            localUseCounts.get(operation.onComplete.ordinal) !== 1 ||
            localUseCounts.get(operation.onSuspend.ordinal) !== 1
          )
            violations.push({
              _tag: 'Violation',
              rule: 'InvalidExecutionOperation',
              function: fn.id,
              region: region.id,
              provenance: operation.provenance,
              detail:
                'Execution drive lost its affine Execution, branch state, or exact take-once outcome contracts',
            })
        }
        if (operation._tag === 'ExecutionNotifyInitial') {
          const executionType = fn.localTypes.at(operation.execution.ordinal)
          const destination = fn.localTypes.at(operation.destination.ordinal)
          if (
            executionType?._tag !== 'Reference' ||
            executionType.type.access !== 'Exclusive' ||
            !SilkType.isExecution(executionType.type.target) ||
            operation.type._tag !== 'Nominal' ||
            !SilkType.equals(operation.type.type, SilkType.unit) ||
            destination?._tag !== 'Nominal' ||
            !SilkType.equals(destination.type, SilkType.unit) ||
            !SilkType.equals(destination.type, operation.type.type) ||
            operation.executionAccess !== 'Exclusive'
          )
            violations.push({
              _tag: 'Violation',
              rule: 'InvalidExecutionOperation',
              function: fn.id,
              region: region.id,
              provenance: operation.provenance,
              detail: 'initial readiness requires one exclusive Execution reference',
            })
        }
        if (operation._tag === 'ExecutionWake') {
          const wake = fn.localTypes.at(operation.wake.ordinal)
          const destination = fn.localTypes.at(operation.destination.ordinal)
          if (
            wake?._tag !== 'Nominal' ||
            !SilkType.isWake(wake.type) ||
            destination?._tag !== 'Nominal' ||
            !SilkType.equals(destination.type, SilkType.unit) ||
            operation.wakeAccess !== 'Take' ||
            localUseCounts.get(operation.wake.ordinal) !== 1
          )
            violations.push({
              _tag: 'Violation',
              rule: 'InvalidExecutionOperation',
              function: fn.id,
              region: region.id,
              provenance: operation.provenance,
              detail: 'Wake signal lost its sole affine generation authority or unit result',
            })
        }
        if (operation._tag === 'ExecutionPark') {
          const register = fn.localTypes.at(operation.register.ordinal)
          const guard = fn.localTypes.at(operation.guard.ordinal)
          const destination = fn.localTypes.at(operation.destination.ordinal)
          const registerSemantic = register === undefined ? undefined : semanticType(register)
          const registerActual =
            registerSemantic !== undefined && SilkType.isRepresented(registerSemantic)
              ? registerSemantic.contract
              : registerSemantic
          const expected =
            guard === undefined ||
            registerActual === undefined ||
            !SilkType.isCallable(registerActual)
              ? undefined
              : SilkType.callable([SilkType.wake], semanticType(guard), registerActual, 'Take')
          const callableCleanupValid = (
            local: Extract<Type, { readonly _tag: 'CallableValue' }>,
            cleanup: CleanupPlan.CleanupPlan,
          ): boolean => {
            const fields =
              local.environment?.fields
                .filter((field) => field.access === 'Take' && !isCopy(self.layout, field.type))
                .reverse() ?? []
            if (local.environment === undefined)
              return cleanup._tag === 'NoCleanup' && SilkType.equals(cleanup.type, local.type)
            return (
              cleanup._tag === 'CallableCleanup' &&
              SilkType.equals(cleanup.type, local.type) &&
              cleanup.environment._tag === 'CallableEnvironmentIdentity' &&
              SilkType.equalsCallableEnvironmentIdentity(
                cleanup.environment.identity,
                Instances.callableEnvironmentIdentity(local.environment.callable),
              ) &&
              cleanup.slots.length === fields.length &&
              cleanup.slots.every((slot, ordinal) => {
                const field = fields.at(ordinal)
                return (
                  field !== undefined &&
                  slot.ordinal === field.ordinal &&
                  cleanupMatchesSemanticType(self.layout, slot.cleanup, field.type)
                )
              })
            )
          }
          const registerCleanupValid =
            register?._tag === 'CallableValue' &&
            callableCleanupValid(register, operation.registerCleanup)
          const guardCleanupValid =
            guard?._tag === 'CallableValue'
              ? callableCleanupValid(guard, operation.guardCleanup)
              : guard !== undefined &&
                cleanupMatchesSemanticType(self.layout, operation.guardCleanup, semanticType(guard))
          if (
            register?._tag !== 'CallableValue' ||
            guard === undefined ||
            guard._tag === 'EffectOutcome' ||
            destination?._tag !== 'Nominal' ||
            !SilkType.equals(destination.type, SilkType.unit) ||
            registerActual === undefined ||
            expected === undefined ||
            !TypeCompatibility.isCompatible(TypeCompatibility.check(registerActual, expected)) ||
            !guardCleanupValid ||
            !registerCleanupValid ||
            operation.registerAccess !== 'Take' ||
            localUseCounts.get(operation.register.ordinal) !== 1
          )
            violations.push({
              _tag: 'Violation',
              rule: 'InvalidExecutionOperation',
              function: fn.id,
              region: region.id,
              provenance: operation.provenance,
              detail:
                'Execution park lost its take-once Wake registration, retained guard, or unit result',
            })
        }
        if (operation._tag === 'SharedClone') {
          const selfType = fn.localTypes.at(operation.self.ordinal)
          const selfElement =
            selfType?._tag === 'Reference' && SilkType.isSharedCore(selfType.type.target)
              ? SilkType.typeArgumentAt(selfType.type.target, 0)
              : undefined
          const destination = fn.localTypes.at(operation.destination.ordinal)
          const elementLayout = Layout.entry(self.layout, operation.element)
          const expected =
            elementLayout === undefined
              ? undefined
              : LocalSharedControlBlock.plan(self.layout.target, operation.element, elementLayout)
          if (
            selfType?._tag !== 'Reference' ||
            selfType.type.access !== 'Shared' ||
            !SilkType.isSharedCore(selfType.type.target) ||
            selfElement === undefined ||
            !SilkType.equals(selfElement, operation.element) ||
            destination?._tag !== 'Nominal' ||
            !SilkType.isSharedCore(destination.type) ||
            !SilkType.equals(destination.type, operation.type.type) ||
            !SilkType.equals(destination.type.arguments[0], operation.element) ||
            expected?._tag !== 'LocalSharedControlBlockPlan' ||
            !LocalSharedControlBlock.equals(expected, operation.block)
          )
            violations.push({
              _tag: 'Violation',
              rule: 'InvalidLocalSharedOperation',
              localSharedReason: 'CloneContract',
              function: fn.id,
              region: region.id,
              provenance: operation.provenance,
              detail: 'Local-shared clone lost its borrowed core, element, or target count plan',
            })
        }
        if (operation._tag === 'SharedWithMut') {
          const selfType = fn.localTypes.at(operation.self.ordinal)
          const use = fn.localTypes.at(operation.use.ordinal)
          const conflict = fn.localTypes.at(operation.onConflict.ordinal)
          const destination = fn.localTypes.at(operation.destination.ordinal)
          const payload = fn.localTypes.at(operation.payload.ordinal)
          const selfElement =
            selfType?._tag === 'Reference' && SilkType.isSharedCore(selfType.type.target)
              ? SilkType.typeArgumentAt(selfType.type.target, 0)
              : undefined
          const elementLayout = Layout.entry(self.layout, operation.element)
          const expected =
            elementLayout === undefined
              ? undefined
              : LocalSharedControlBlock.plan(self.layout.target, operation.element, elementLayout)
          const useContract =
            use?._tag !== 'CallableValue' || payload?._tag !== 'Reference'
              ? undefined
              : SilkType.callable(
                  [SilkType.reference('Exclusive', operation.element, payload.type.lifetime)],
                  semanticType(operation.type),
                  use.type,
                  'Take',
                )
          const conflictContract =
            conflict?._tag !== 'CallableValue'
              ? undefined
              : SilkType.callable([], semanticType(operation.type), conflict.type, 'Take')
          const takeUse =
            use?._tag === 'CallableValue' ? { ...use.type, mode: 'Take' as const } : undefined
          const takeConflict =
            conflict?._tag === 'CallableValue'
              ? { ...conflict.type, mode: 'Take' as const }
              : undefined
          const retainsRestrictedLoan = (local: Type): boolean => {
            if (SilkType.containsBorrowWrapper(semanticType(local))) return true
            if (local._tag === 'CallableValue' || local._tag === 'EffectValue')
              return (
                local.environment?.fields.some((field) =>
                  SilkType.containsBorrowWrapper(field.type),
                ) ?? false
              )
            if (local._tag === 'EffectComposite')
              return local.alternatives.some(retainsRestrictedLoan)
            return false
          }
          const callableCleanupValid = (
            local: Extract<Type, { readonly _tag: 'CallableValue' }>,
            cleanup: CleanupPlan.CleanupPlan,
          ): boolean => {
            const fields =
              local.environment?.fields
                .filter((field) => field.access === 'Take' && !isCopy(self.layout, field.type))
                .reverse() ?? []
            if (local.environment === undefined)
              return cleanup._tag === 'NoCleanup' && SilkType.equals(cleanup.type, local.type)
            return (
              cleanup._tag === 'CallableCleanup' &&
              SilkType.equals(cleanup.type, local.type) &&
              cleanup.environment._tag === 'CallableEnvironmentIdentity' &&
              SilkType.equalsCallableEnvironmentIdentity(
                cleanup.environment.identity,
                Instances.callableEnvironmentIdentity(local.environment.callable),
              ) &&
              cleanup.slots.length === fields.length &&
              cleanup.slots.every((slot, ordinal) => {
                const field = fields.at(ordinal)
                return (
                  field !== undefined &&
                  slot.ordinal === field.ordinal &&
                  cleanupMatchesSemanticType(self.layout, slot.cleanup, field.type)
                )
              })
            )
          }
          if (
            selfType?._tag !== 'Reference' ||
            selfType.type.access !== 'Shared' ||
            !SilkType.isSharedCore(selfType.type.target) ||
            selfElement === undefined ||
            !SilkType.equals(selfElement, operation.element) ||
            use?._tag !== 'CallableValue' ||
            conflict?._tag !== 'CallableValue' ||
            destination === undefined ||
            payload?._tag !== 'Reference' ||
            payload.type.access !== 'Exclusive' ||
            !SilkType.equals(payload.type.target, operation.element) ||
            operation.payload.ordinal === operation.destination.ordinal ||
            !SilkType.equals(semanticType(destination), semanticType(operation.type)) ||
            retainsRestrictedLoan(destination) ||
            takeUse === undefined ||
            takeConflict === undefined ||
            !TypeCompatibility.isCompatible(TypeCompatibility.check(takeUse, operation.useType)) ||
            !TypeCompatibility.isCompatible(
              TypeCompatibility.check(takeConflict, operation.conflictType),
            ) ||
            useContract === undefined ||
            !SilkType.equals(operation.useType, useContract) ||
            conflictContract === undefined ||
            !SilkType.equals(operation.conflictType, conflictContract) ||
            !callableCleanupValid(use, operation.useCleanup) ||
            !callableCleanupValid(conflict, operation.conflictCleanup) ||
            expected?._tag !== 'LocalSharedControlBlockPlan' ||
            !LocalSharedControlBlock.equals(expected, operation.block) ||
            operation.retainedLoans.length !== 0
          )
            violations.push({
              _tag: 'Violation',
              rule: 'InvalidLocalSharedOperation',
              localSharedReason: 'AccessContract',
              function: fn.id,
              region: region.id,
              provenance: operation.provenance,
              detail:
                'Local-shared access lost its core, take-once callback, result, cleanup, or target-layout contract',
            })
        }
        if (
          operation._tag === 'PointerNull' ||
          operation._tag === 'PointerIsNull' ||
          operation._tag === 'PointerAddress' ||
          operation._tag === 'PointerReinterpret' ||
          operation._tag === 'PointerRequalify' ||
          operation._tag === 'PointerBytes' ||
          operation._tag === 'PointerFromStorage' ||
          operation._tag === 'PointerAt' ||
          operation._tag === 'PointerRead' ||
          operation._tag === 'PointerWrite'
        ) {
          const detail = pointerOperationViolation(self.layout, fn, operation)
          if (detail !== undefined)
            violations.push({
              _tag: 'Violation',
              rule: 'InvalidPointerOperation',
              function: fn.id,
              region: region.id,
              provenance: operation.provenance,
              detail,
            })
        }
        if (operation._tag === 'RawBufferCount') {
          const buffer = fn.localTypes.at(operation.buffer.ordinal)
          const destination = fn.localTypes.at(operation.destination.ordinal)
          if (
            buffer?._tag !== 'Reference' ||
            !SilkType.isRawBuffer(buffer.type.target) ||
            destination?._tag !== 'usize'
          )
            violations.push({
              _tag: 'Violation',
              rule: 'InvalidRawStorageOperation',
              function: fn.id,
              region: region.id,
              detail: 'RawBuffer.count lost its borrowed buffer or usize result',
            })
        }
        if (operation._tag === 'RawBufferSlot') {
          const buffer = fn.localTypes.at(operation.buffer.ordinal)
          const index = fn.localTypes.at(operation.index.ordinal)
          const destination = fn.localTypes.at(operation.destination.ordinal)
          const bufferElement =
            buffer?._tag === 'Reference' && SilkType.isRawBuffer(buffer.type.target)
              ? buffer.type.target.arguments[0]
              : undefined
          if (
            buffer?._tag !== 'Reference' ||
            buffer.type.access !== 'Exclusive' ||
            index?._tag !== 'usize' ||
            destination?._tag !== 'Nominal' ||
            !SilkType.isSlot(destination.type) ||
            bufferElement === undefined ||
            !SilkType.equals(bufferElement, operation.element) ||
            !SilkType.equals(destination.type.arguments[1], operation.element)
          )
            violations.push({
              _tag: 'Violation',
              rule: 'InvalidRawStorageOperation',
              function: fn.id,
              region: region.id,
              detail:
                'Slot projection lost its exclusive buffer, bounds operand, or element provenance',
            })
        }
        if (operation._tag === 'RawBufferRead') {
          const buffer = fn.localTypes.at(operation.buffer.ordinal)
          const index = fn.localTypes.at(operation.index.ordinal)
          const destination = fn.localTypes.at(operation.destination.ordinal)
          const bufferElement =
            buffer?._tag === 'Reference' && SilkType.isRawBuffer(buffer.type.target)
              ? buffer.type.target.arguments[0]
              : undefined
          if (
            buffer?._tag !== 'Reference' ||
            buffer.type.access !== 'Shared' ||
            index?._tag !== 'usize' ||
            destination === undefined ||
            bufferElement === undefined ||
            !SilkType.equals(bufferElement, operation.element) ||
            !SilkType.equals(semanticType(destination), operation.element) ||
            !isCopy(self.layout, operation.element)
          )
            violations.push({
              _tag: 'Violation',
              rule: 'InvalidRawStorageOperation',
              function: fn.id,
              region: region.id,
              detail:
                'RawBuffer.read lost its shared buffer, bounds, Copy element, or result provenance',
            })
        }
        if (operation._tag === 'SliceView') {
          const source = fn.localTypes.at(operation.slice.ordinal)
          const destination = fn.localTypes.at(operation.destination.ordinal)
          const elementLayout = Layout.entry(self.layout, operation.element)
          const stride =
            elementLayout === undefined
              ? undefined
              : Math.ceil(elementLayout.size / elementLayout.alignment) * elementLayout.alignment
          if (
            source?._tag !== 'Slice' ||
            source.type.access !== 'Shared' ||
            destination?._tag !== 'Slice' ||
            !sameRuntimeType(source.type, operation.type.type) ||
            !SilkType.equals(destination.type, operation.type.type) ||
            !SilkType.equals(source.type.element, operation.element) ||
            fn.localTypes.at(operation.offset.ordinal)?._tag !== 'usize' ||
            fn.localTypes.at(operation.length.ordinal)?._tag !== 'usize' ||
            operation.stride !== stride ||
            !heldStringLoansValid(operation.heldLoans)
          ) {
            violations.push({
              _tag: 'Violation',
              rule: 'InvalidRawStorageOperation',
              function: fn.id,
              region: region.id,
              detail:
                'Slice view lost its shared source shape, bounds, element layout, or backing loans',
            })
          }
        }
        if (operation._tag === 'RawBufferView') {
          const buffer = fn.localTypes.at(operation.buffer.ordinal)
          const offset = fn.localTypes.at(operation.offset.ordinal)
          const length = fn.localTypes.at(operation.length.ordinal)
          const destination = fn.localTypes.at(operation.destination.ordinal)
          const bufferElement =
            buffer?._tag === 'Reference' && SilkType.isRawBuffer(buffer.type.target)
              ? buffer.type.target.arguments[0]
              : undefined
          const elementLayout = Layout.entry(self.layout, operation.element)
          const expectedStride =
            elementLayout === undefined
              ? undefined
              : Math.ceil(elementLayout.size / elementLayout.alignment) * elementLayout.alignment
          if (
            buffer?._tag !== 'Reference' ||
            buffer.type.access !== operation.access ||
            offset?._tag !== 'usize' ||
            length?._tag !== 'usize' ||
            destination?._tag !== 'Slice' ||
            destination.type.access !== operation.access ||
            bufferElement === undefined ||
            !SilkType.equals(bufferElement, operation.element) ||
            !SilkType.equals(destination.type.element, operation.element) ||
            operation.stride !== expectedStride
          ) {
            violations.push({
              _tag: 'Violation',
              rule: 'InvalidRawStorageOperation',
              function: fn.id,
              region: region.id,
              detail:
                'RawBuffer view lost its borrowed buffer, initialized range, element, access, or layout provenance',
            })
          }
        }
        if (operation._tag === 'RawBufferCopy') {
          const buffer = fn.localTypes.at(operation.buffer.ordinal)
          const offset = fn.localTypes.at(operation.offset.ordinal)
          const source = fn.localTypes.at(operation.source.ordinal)
          const length = fn.localTypes.at(operation.length.ordinal)
          const destination = fn.localTypes.at(operation.destination.ordinal)
          const bufferElement =
            buffer?._tag === 'Reference' && SilkType.isRawBuffer(buffer.type.target)
              ? buffer.type.target.arguments[0]
              : undefined
          const elementLayout = Layout.entry(self.layout, operation.element)
          const expectedStride =
            elementLayout === undefined
              ? undefined
              : Math.ceil(elementLayout.size / elementLayout.alignment) * elementLayout.alignment
          if (
            buffer?._tag !== 'Reference' ||
            buffer.type.access !== 'Exclusive' ||
            offset?._tag !== 'usize' ||
            length?._tag !== 'usize' ||
            source?._tag !== 'Slice' ||
            source.type.access !== 'Shared' ||
            destination?._tag !== 'Nominal' ||
            !SilkType.equals(destination.type, SilkType.unit) ||
            bufferElement === undefined ||
            !SilkType.equals(bufferElement, operation.element) ||
            !SilkType.equals(source.type.element, operation.element) ||
            operation.stride !== expectedStride ||
            operation.retainsSource !== isCopy(self.layout, operation.element)
          ) {
            violations.push({
              _tag: 'Violation',
              rule: 'InvalidRawStorageOperation',
              function: fn.id,
              region: region.id,
              detail:
                'RawBuffer copy lost its exclusive destination, shared source range, element, or layout provenance',
            })
          }
        }
        if (operation._tag === 'RawBufferFill') {
          const buffer = fn.localTypes.at(operation.buffer.ordinal)
          const offset = fn.localTypes.at(operation.offset.ordinal)
          const length = fn.localTypes.at(operation.length.ordinal)
          const value = fn.localTypes.at(operation.value.ordinal)
          const destination = fn.localTypes.at(operation.destination.ordinal)
          const bufferElement =
            buffer?._tag === 'Reference' && SilkType.isRawBuffer(buffer.type.target)
              ? buffer.type.target.arguments[0]
              : undefined
          if (
            buffer?._tag !== 'Reference' ||
            buffer.type.access !== 'Exclusive' ||
            offset?._tag !== 'usize' ||
            length?._tag !== 'usize' ||
            value?._tag !== 'u8' ||
            destination?._tag !== 'Nominal' ||
            !SilkType.equals(destination.type, SilkType.unit) ||
            bufferElement === undefined ||
            !SilkType.equals(bufferElement, 'u8')
          ) {
            violations.push({
              _tag: 'Violation',
              rule: 'InvalidRawStorageOperation',
              function: fn.id,
              region: region.id,
              detail: 'RawBuffer fill lost its exclusive byte buffer, range, or byte value',
            })
          }
        }
        if (
          operation._tag === 'SlotWrite' ||
          operation._tag === 'SlotTake' ||
          operation._tag === 'SlotCopy' ||
          operation._tag === 'SlotDrop'
        ) {
          const slot = fn.localTypes.at(operation.slot.ordinal)
          const destination = fn.localTypes.at(operation.destination.ordinal)
          const slotElement =
            slot?._tag === 'Nominal' && SilkType.isSlot(slot.type)
              ? slot.type.arguments[1]
              : undefined
          const unitResult =
            operation._tag === 'SlotTake' || operation._tag === 'SlotCopy'
              ? true
              : destination?._tag === 'Nominal' && SilkType.equals(destination.type, SilkType.unit)
          const takeResult =
            !(operation._tag === 'SlotTake' || operation._tag === 'SlotCopy') ||
            (destination !== undefined &&
              SilkType.equals(semanticType(destination), operation.element) &&
              (operation._tag !== 'SlotCopy' || isCopy(self.layout, operation.element)))
          const writeValue =
            operation._tag !== 'SlotWrite' ||
            (() => {
              const value = fn.localTypes.at(operation.value.ordinal)
              return value !== undefined && SilkType.equals(semanticType(value), operation.element)
            })()
          if (
            slotElement === undefined ||
            !SilkType.equals(slotElement, operation.element) ||
            !unitResult ||
            !takeResult ||
            !writeValue
          )
            violations.push({
              _tag: 'Violation',
              rule: 'InvalidRawStorageOperation',
              function: fn.id,
              region: region.id,
              detail: `${operation._tag} lost its slot, element, value, or result provenance`,
            })
        }
        if (operation._tag === 'SliceLength') {
          const slice = fn.localTypes.at(operation.slice.ordinal)
          const destination = fn.localTypes.at(operation.destination.ordinal)
          if (
            slice === undefined ||
            !SilkType.isSlice(semanticType(slice)) ||
            destination?._tag !== 'usize'
          ) {
            violations.push({
              _tag: 'Violation',
              rule: 'InvalidSliceOperation',
              function: fn.id,
              region: region.id,
              detail: 'slice length requires one logical slice local and one usize destination',
            })
          }
        }
        if (
          operation._tag === 'DiagnosticUnhandled' &&
          (operation.type._tag !== 'usize' ||
            fn.localTypes.at(operation.destination.ordinal)?._tag !== 'usize')
        )
          violations.push({
            _tag: 'Violation',
            rule: 'InvalidEffectOperation',
            function: fn.id,
            region: region.id,
            detail: 'terminal observation requires one usize destination',
          })
        if (
          operation._tag === 'Conditional' ||
          operation._tag === 'ShortCircuit' ||
          operation._tag === 'DiagnosticScope'
        ) {
          let branches: ReadonlyArray<Execution>
          let validRecovery: boolean
          if (operation._tag === 'Conditional') {
            branches = [operation.taken, operation.otherwise]
            const recovered = operation.otherwise.recoveryOutcome
            validRecovery =
              operation.taken.recoveryOutcome === undefined &&
              (recovered === undefined ||
                caughtOutcomes.get(recovered.ordinal)?.destination.ordinal ===
                  operation.condition.ordinal)
          } else if (operation._tag === 'DiagnosticScope') {
            branches = [operation.body]
            validRecovery = operation.body.recoveryOutcome === undefined
          } else {
            branches = [operation.right]
            validRecovery = operation.right.recoveryOutcome === undefined
          }
          if (!validRecovery)
            violations.push({
              _tag: 'Violation',
              rule: 'InvalidEffectOperation',
              function: fn.id,
              region: region.id,
              detail: 'recovery scope is not the selected failure branch of its caught outcome',
            })
          if (
            branches.some((branch) => !executionCompletion(fn, branch, operation.destination).valid)
          )
            violations.push({
              _tag: 'Violation',
              rule: 'InvalidMatchJoin',
              function: fn.id,
              region: region.id,
              detail: 'conditional execution has an unavailable or inconsistent normal result',
            })
        }
        if (operation._tag === 'Match') {
          let completes = false
          const selectable = selectableMatchArms(operation)
          for (const arm of operation.arms) {
            const recovered = arm.selected.execution.recoveryOutcome
            if (
              arm.guard?.execution.recoveryOutcome !== undefined ||
              (recovered !== undefined &&
                caughtOutcomes.get(recovered.ordinal)?.failureValue.ordinal !==
                  operation.scrutinee.ordinal)
            )
              violations.push({
                _tag: 'Violation',
                rule: 'InvalidEffectOperation',
                function: fn.id,
                region: region.id,
                detail: 'recovery scope does not select the matched caught failure',
              })
            const guard =
              arm.guard === undefined
                ? { completes: true, valid: true }
                : executionCompletion(fn, arm.guard.execution)
            const body = executionCompletion(fn, arm.selected.execution, operation.destination)
            if (selectable.has(arm.id.ordinal) && guard.completes && body.completes)
              completes = true
            if (!guard.valid || !body.valid)
              violations.push({
                _tag: 'Violation',
                rule: 'InvalidMatchJoin',
                function: fn.id,
                region: region.id,
                detail: `arm #${arm.id.ordinal} has an unavailable normal result or executes continuation work after transfer`,
              })
          }
          if (completes !== (operation.destination !== undefined))
            violations.push({
              _tag: 'Violation',
              rule: 'InvalidMatchJoin',
              function: fn.id,
              region: region.id,
              detail: 'match join destination disagrees with its normally completing paths',
            })
          const source = fn.localTypes.at(operation.scrutinee.ordinal)
          const selectedSource = placeType(
            fn,
            self.layout,
            operation.scrutinee,
            operation.selectors ?? [],
            operation.access === 'Shared' || operation.access === 'Exclusive',
          )
          const destination =
            operation.destination === undefined
              ? undefined
              : fn.localTypes.at(operation.destination.ordinal)
          const plannedScrutinee = Layout.callingShape(
            self.layout,
            semanticType(operation.scrutineeType),
          )
          const plannedResult = Layout.callingShape(self.layout, semanticType(operation.type))
          const enumScrutineeValid =
            operation.scrutineeType._tag !== 'Enum' ||
            (selectedSource !== undefined &&
              SilkType.equals(selectedSource, operation.scrutineeType.type) &&
              Layout.entry(self.layout, operation.scrutineeType.type)?.representation._tag ===
                'ScalarEnum')
          if (
            source === undefined ||
            !enumScrutineeValid ||
            (destination === undefined && operation.type._tag !== 'Bottom') ||
            selectedSource === undefined ||
            !sameRuntimeType(selectedSource, semanticType(operation.scrutineeType)) ||
            (destination !== undefined &&
              !sameRuntimeType(semanticType(destination), semanticType(operation.type))) ||
            !sameRuntimeType(
              operation.scrutineeShape.type,
              semanticType(operation.scrutineeType),
            ) ||
            !sameRuntimeType(operation.resultShape.type, semanticType(operation.type)) ||
            plannedScrutinee === undefined ||
            plannedResult === undefined ||
            !callingShapeEquals(plannedScrutinee, operation.scrutineeShape) ||
            !callingShapeEquals(plannedResult, operation.resultShape)
          ) {
            violations.push({
              _tag: 'Violation',
              rule: 'InvalidMatchLayout',
              function: fn.id,
              region: region.id,
              detail: 'match scrutinee or join disagrees with its locals or compiler layout',
            })
          }

          const coverage = Match.cover(
            operation.members,
            operation.arms.map((arm) => ({
              ...(arm.member === undefined ? {} : { member: arm.member }),
              universal: arm.universal,
              guarded: arm.guard !== undefined,
              tests: arm.tests ?? [],
            })),
            'Runtime',
          )
          const enumRepresentation =
            operation.scrutineeType._tag === 'Enum'
              ? operation.scrutineeType.representation
              : undefined
          const enumMembers =
            enumRepresentation === undefined
              ? undefined
              : enumRepresentation.members.map((member) =>
                  Match.enumMember(enumRepresentation.enum, member.member),
                )
          const enumCoverageValid =
            enumMembers === undefined ||
            (sameCoverage(operation.members, enumMembers) &&
              operation.members.every((member) => member._tag === 'EnumMember') &&
              operation.arms.every(
                (arm) => arm.member === undefined || arm.member._tag === 'EnumMember',
              ))
          const plannedMembers = Layout.coverageMembers(operation.scrutineeShape)
          const decisionsValid =
            coverage.exhaustive &&
            enumCoverageValid &&
            (operation.scrutineeType._tag === 'Enum' ||
              sameCoverage(operation.members, plannedMembers)) &&
            operation.decisions.length === operation.members.length &&
            operation.decisions.every((decision, ordinal) => {
              const member = operation.members.at(ordinal)
              const expected = operation.arms.filter(
                (arm) =>
                  arm.universal ||
                  (arm.member !== undefined &&
                    member !== undefined &&
                    Match.selects(arm.member, member, 'Runtime')),
              )
              return (
                member !== undefined &&
                Match.identityEquals(decision.member, member, 'Runtime') &&
                decision.candidates.length === expected.length &&
                decision.candidates.every(
                  (candidate, candidateOrdinal) =>
                    candidate.ordinal === expected.at(candidateOrdinal)?.id.ordinal,
                )
              )
            }) &&
            operation.arms.every((arm, ordinal) => {
              const transition = coverage.transitions.at(ordinal)
              return (
                transition?.reachable === true &&
                sameCoverage(arm.before, transition.before) &&
                sameCoverage(arm.after, transition.after)
              )
            })
          if (!decisionsValid) {
            violations.push({
              _tag: 'Violation',
              rule: 'InvalidMatchDecision',
              function: fn.id,
              region: region.id,
              detail: 'match decisions disagree with canonical members or source coverage order',
            })
          }

          for (const arm of operation.arms) {
            const pathProven = (
              selectors: ReadonlyArray<PlaceSelector>,
              tests: NonNullable<(typeof arm)['tests']>,
            ): boolean => {
              const prefix = operation.selectors?.length ?? 0
              return selectors.every((selector, ordinal) => {
                if (
                  selector._tag !== 'VariantSelector' ||
                  !selectors.slice(prefix, ordinal).some((part) => part._tag === 'FieldSelector')
                )
                  return true
                return tests.some(
                  (test) =>
                    test.member._tag === 'NominalUnionVariant' &&
                    test.member.variantOrdinal === selector.ordinal &&
                    samePlaceSelectors(test.selectors, selectors.slice(0, ordinal)),
                )
              })
            }
            for (const [testOrdinal, test] of (arm.tests ?? []).entries()) {
              const resolved =
                arm.member === undefined
                  ? undefined
                  : Layout.coveragePath(
                      self.layout,
                      semanticType(operation.scrutineeType),
                      arm.member,
                      test.path,
                    )
              const planned =
                resolved === undefined ? undefined : Layout.callingShape(self.layout, resolved.type)
              const expected: ReadonlyArray<PlaceSelector> = [
                ...(operation.selectors ?? []),
                ...(resolved?.selectors ?? []).map((selector): PlaceSelector =>
                  selector._tag === 'Variant'
                    ? {
                        _tag: 'VariantSelector',
                        ordinal: selector.ordinal,
                        provenance: operation.provenance,
                      }
                    : {
                        _tag: 'FieldSelector',
                        field: selector.field,
                        provenance: operation.provenance,
                      },
                ),
              ]
              if (
                planned === undefined ||
                !callingShapeEquals(planned, test.shape) ||
                !sameCoverage(Layout.coverageMembers(planned), test.domain) ||
                !test.domain.some((member) => Match.selects(test.member, member, 'Runtime')) ||
                !samePlaceSelectors(expected, test.selectors) ||
                !pathProven(expected, (arm.tests ?? []).slice(0, testOrdinal))
              ) {
                violations.push({
                  _tag: 'Violation',
                  rule: 'InvalidMatchDecision',
                  function: fn.id,
                  region: region.id,
                  detail: 'nested pattern test disagrees with its canonical path or domain',
                })
              }
            }
            for (const binding of [...arm.bindings, ...arm.cleanupBindings]) {
              const localType = fn.localTypes.at(binding.destination.ordinal)
              const selected =
                arm.member === undefined
                  ? fieldPathType(self.layout, semanticType(operation.scrutineeType), binding.path)
                  : coverageFieldPathType(self.layout, arm.member, binding.path)
              const resolvedPath =
                arm.member === undefined
                  ? undefined
                  : Layout.coveragePath(
                      self.layout,
                      semanticType(operation.scrutineeType),
                      arm.member,
                      binding.path,
                    )
              const bindingSelectors: ReadonlyArray<PlaceSelector> = [
                ...(operation.selectors ?? []),
                ...(resolvedPath?.selectors ?? []).map((selector): PlaceSelector =>
                  selector._tag === 'Variant'
                    ? {
                        _tag: 'VariantSelector',
                        ordinal: selector.ordinal,
                        provenance: operation.provenance,
                      }
                    : {
                        _tag: 'FieldSelector',
                        field: selector.field,
                        provenance: operation.provenance,
                      },
                ),
              ]
              if (
                !pathProven(bindingSelectors, arm.tests ?? []) ||
                localType === undefined ||
                selected === undefined ||
                !sameRuntimeType(semanticType(localType), semanticType(binding.type)) ||
                !sameRuntimeType(selected, semanticType(binding.type)) ||
                ('access' in binding && binding.access !== operation.access)
              ) {
                violations.push({
                  _tag: 'Violation',
                  rule: 'InvalidMatchBinding',
                  function: fn.id,
                  region: region.id,
                  detail: `arm #${arm.id.ordinal} has an invalid pattern path, type, or access`,
                })
              }
            }
            if (
              arm.guard?.execution.result !== undefined &&
              fn.localTypes.at(arm.guard.execution.result.ordinal)?._tag !== 'bool'
            ) {
              violations.push({
                _tag: 'Violation',
                rule: 'InvalidMatchGuard',
                function: fn.id,
                region: region.id,
                detail: `arm #${arm.id.ordinal} guard does not produce bool`,
              })
            }
            const resultType =
              arm.selected.execution.result === undefined
                ? undefined
                : fn.localTypes.at(arm.selected.execution.result.ordinal)
            if (
              (arm.selected.execution.result !== undefined && resultType === undefined) ||
              (selectable.has(arm.id.ordinal) &&
                resultType !== undefined &&
                resultType._tag !== 'Bottom' &&
                !sameRuntimeType(semanticType(resultType), semanticType(operation.type)))
            ) {
              violations.push({
                _tag: 'Violation',
                rule: 'InvalidMatchJoin',
                function: fn.id,
                region: region.id,
                detail: `arm #${arm.id.ordinal} result does not match the join destination`,
              })
            }
            const cleanupValid =
              arm.selected.access === operation.access &&
              arm.selected.endBorrow ===
                ((operation.access === 'Shared' || operation.access === 'Exclusive') &&
                  !operation.retainsBindings) &&
              (operation.access === 'Move'
                ? arm.selected.cleanup.every((entry) => {
                    const selected =
                      arm.member === undefined
                        ? fieldPathType(
                            self.layout,
                            semanticType(operation.scrutineeType),
                            entry.path,
                          )
                        : coverageFieldPathType(self.layout, arm.member, entry.path)
                    const destinationType = fn.localTypes.at(entry.destination.ordinal)
                    const path = Layout.coveragePath(
                      self.layout,
                      semanticType(operation.scrutineeType),
                      arm.member ?? Match.structuralMember(semanticType(operation.scrutineeType)),
                      entry.path,
                    )
                    const selectors: ReadonlyArray<PlaceSelector> = [
                      ...(operation.selectors ?? []),
                      ...(path?.selectors ?? []).map((selector): PlaceSelector =>
                        selector._tag === 'Variant'
                          ? {
                              _tag: 'VariantSelector',
                              ordinal: selector.ordinal,
                              provenance: operation.provenance,
                            }
                          : {
                              _tag: 'FieldSelector',
                              field: selector.field,
                              provenance: operation.provenance,
                            },
                      ),
                    ]
                    return (
                      path !== undefined &&
                      pathProven(selectors, arm.tests ?? []) &&
                      selected !== undefined &&
                      destinationType !== undefined &&
                      SilkType.equals(semanticType(destinationType), entry.cleanup.type) &&
                      (arm.member?._tag === 'NominalUnionVariant'
                        ? cleanupMatchesSemanticType(self.layout, entry.cleanup, selected)
                        : SilkType.equals(selected, entry.cleanup.type))
                    )
                  })
                : arm.selected.cleanup.length === 0)
            if (!cleanupValid) {
              violations.push({
                _tag: 'Violation',
                rule: 'InvalidMatchOwnership',
                function: fn.id,
                region: region.id,
                detail: `arm #${arm.id.ordinal} has invalid selection ownership or cleanup`,
              })
            }
          }
        }
        if (operation._tag === 'ConvertUnion') {
          const source = fn.localTypes.at(operation.source.ordinal)
          const destination = fn.localTypes.at(operation.destination.ordinal)
          const compatibility = TypeCompatibility.check(
            operation.sourceSemantic,
            operation.targetType.type,
          )
          const mappingsValid =
            compatibility._tag === operation.conversion &&
            compatibility.mappings.length === operation.mappings.length &&
            compatibility.mappings.every((mapping, ordinal) => {
              const actual = operation.mappings.at(ordinal)
              return (
                actual !== undefined &&
                mapping.sourceOrdinal === actual.sourceOrdinal &&
                mapping.targetOrdinal === actual.targetOrdinal &&
                SilkType.equals(mapping.source, actual.source) &&
                SilkType.equals(mapping.target, actual.target)
              )
            })
          const valid =
            source !== undefined &&
            destination !== undefined &&
            SilkType.equals(semanticType(source), semanticType(operation.sourceType)) &&
            SilkType.equals(semanticType(destination), operation.targetType.type) &&
            mappingsValid &&
            sameRuntimeType(operation.sourceShape.type, operation.sourceSemantic) &&
            (sameRuntimeType(operation.sourceSemantic, semanticType(operation.sourceType)) ||
              SilkType.haveSameRepresentationShape(
                operation.sourceSemantic,
                semanticType(operation.sourceType),
              )) &&
            sameRuntimeType(operation.targetShape.type, operation.targetType.type) &&
            (() => {
              const sourceShape = Layout.callingShape(self.layout, operation.sourceShape.type)
              const targetShape = Layout.callingShape(self.layout, operation.targetShape.type)
              return (
                sourceShape !== undefined &&
                targetShape !== undefined &&
                callingShapeEquals(sourceShape, operation.sourceShape) &&
                callingShapeEquals(targetShape, operation.targetShape)
              )
            })()
          if (!valid) {
            violations.push({
              _tag: 'Violation',
              rule: 'InvalidAggregateOperation',
              function: fn.id,
              region: region.id,
              detail: 'union conversion disagrees with its locals, mapping, or layout shapes',
            })
          }
        }
        if (operation._tag === 'Drop') {
          const dropped = fn.localTypes.at(operation.local.ordinal)
          const cleanup = operation.cleanup
          const droppedSemantic = placeType(
            fn,
            self.layout,
            operation.local,
            operation.selectors ?? [],
          )
          const cleanupTypeMatches =
            droppedSemantic !== undefined &&
            // Layout fields are shared by runtime shape and may retain another specialization's
            // proof lifetime. Cleanup must agree on runtime ownership, not that cached lifetime.
            (sameRuntimeType(droppedSemantic, cleanup.type) ||
              (dropped?._tag === 'CallableValue' &&
                dropped.storage !== undefined &&
                SilkType.equals(dropped.storage.realization.contract, cleanup.type)) ||
              (dropped?._tag === 'EffectValue' &&
                dropped.storage !== undefined &&
                SilkType.equals(dropped.storage.realization.contract, cleanup.type)) ||
              (SilkType.isEffect(droppedSemantic) &&
                SilkType.isEffect(cleanup.type) &&
                (() => {
                  const cleanupEffect = cleanup.type
                  return (
                    SilkType.equals(droppedSemantic.success, cleanupEffect.success) &&
                    SilkType.failureMembers(droppedSemantic).length ===
                      SilkType.failureMembers(cleanupEffect).length &&
                    SilkType.failureMembers(droppedSemantic).every((failure, ordinal) => {
                      const expected = SilkType.failureMembers(cleanupEffect).at(ordinal)
                      return expected !== undefined && SilkType.equals(failure, expected)
                    })
                  )
                })()))
          const unionCasesValid =
            cleanup._tag !== 'UnionCleanup' ||
            (cleanup.cases.length === cleanup.type.members.length &&
              cleanup.cases.every((member, ordinal) => {
                const expected = cleanup.type.members.at(ordinal)
                return (
                  expected !== undefined &&
                  member.ordinal === ordinal &&
                  SilkType.equals(member.member, expected)
                )
              }))
          const callableCleanupValid =
            cleanup._tag !== 'CallableCleanup' ||
            (dropped?._tag === 'CallableValue' &&
              dropped.environment !== undefined &&
              dropped.site !== undefined &&
              cleanup.environment._tag === 'CallableEnvironmentIdentity' &&
              SilkType.equalsCallableEnvironmentIdentity(
                cleanup.environment.identity,
                Instances.callableEnvironmentIdentity(dropped.environment.callable),
              ) &&
              (() => {
                const expected = dropped.environment.fields
                  .filter((field) => field.access === 'Take' && !isCopy(self.layout, field.type))
                  .map((field) => field.ordinal)
                  .reverse()
                return (
                  expected.length === cleanup.slots.length &&
                  expected.every((ordinal, slot) => cleanup.slots.at(slot)?.ordinal === ordinal)
                )
              })())
          const effectCleanupValid =
            cleanup._tag !== 'EffectCleanup' ||
            (dropped?._tag === 'EffectValue' &&
              (dropped.storage === undefined
                ? Tir.sameExecutableSite(cleanup.site, dropped.site)
                : storedEffectCleanupValid(self.layout, dropped, cleanup)))
          const compositeCleanupValid =
            cleanup._tag !== 'EffectCompositeCleanup' ||
            (dropped?._tag === 'EffectComposite' &&
              cleanup.alternatives.length === dropped.alternatives.length)
          const storedAggregateCleanupValid =
            droppedSemantic !== undefined &&
            (!SilkType.containsEffectRepresentation(droppedSemantic) ||
              cleanupMatchesSemanticType(self.layout, cleanup, droppedSemantic))
          const localSharedElement =
            droppedSemantic !== undefined && SilkType.isSharedCore(droppedSemantic)
              ? SilkType.typeArgumentAt(droppedSemantic, 0)
              : undefined
          const localSharedLayout =
            localSharedElement === undefined
              ? undefined
              : Layout.entry(self.layout, localSharedElement)
          const expectedLocalSharedBlock =
            localSharedElement === undefined || localSharedLayout === undefined
              ? undefined
              : LocalSharedControlBlock.plan(
                  self.layout.target,
                  localSharedElement,
                  localSharedLayout,
                )
          const localSharedCleanupValid =
            localSharedElement === undefined ||
            (droppedSemantic !== undefined &&
              cleanupMatchesSemanticType(self.layout, cleanup, droppedSemantic) &&
              operation.localShared !== undefined &&
              SilkType.equals(operation.localShared.element, localSharedElement) &&
              expectedLocalSharedBlock?._tag === 'LocalSharedControlBlockPlan' &&
              LocalSharedControlBlock.equals(operation.localShared.block, expectedLocalSharedBlock))
          if (
            dropped === undefined ||
            !cleanupTypeMatches ||
            !unionCasesValid ||
            !callableCleanupValid ||
            !effectCleanupValid ||
            !compositeCleanupValid ||
            !storedAggregateCleanupValid ||
            !localSharedCleanupValid
          ) {
            violations.push({
              _tag: 'Violation',
              rule:
                localSharedElement === undefined
                  ? 'InvalidAggregateOperation'
                  : 'InvalidLocalSharedOperation',
              ...(localSharedElement === undefined
                ? {}
                : {
                    localSharedReason: 'CleanupContract' as const,
                    provenance: operation.provenance,
                  }),
              function: fn.id,
              region: region.id,
              detail: 'drop cleanup disagrees with its local type or canonical union cases',
            })
          }
        }
        if (operation._tag === 'Construct') {
          const layout = Layout.entry(self.layout, operation.type.type)
          const expected =
            layout?.representation._tag === 'Aggregate' ? layout.representation.fields : []
          const valid =
            expected.length === operation.fields.length &&
            operation.fields.every((field, ordinal) => {
              const declared = expected.at(ordinal)
              const valueType = fn.localTypes.at(field.value.ordinal)
              const storedCallableValid =
                field.stored?._tag === 'StoredCallableField' &&
                declared !== undefined &&
                valueType?._tag === 'CallableValue' &&
                sameRuntimeType(field.stored.type, declared.type) &&
                TypeCompatibility.isCompatible(
                  TypeCompatibility.check(valueType.type, field.stored.realization.contract),
                ) &&
                Tir.matchesCallableTargetIdentity(
                  valueType.target,
                  field.stored.realization.target,
                ) &&
                RepresentationField.belongsTo(field.stored.realization.field, field.field) &&
                field.stored.realization.instance.module === operation.type.type.module &&
                field.stored.realization.instance.name === operation.type.type.name
              const storedEffectValid =
                field.stored?._tag === 'StoredEffectField' &&
                declared !== undefined &&
                valueType?._tag === 'EffectValue' &&
                sameRuntimeType(field.stored.type, declared.type) &&
                TypeCompatibility.isCompatible(
                  TypeCompatibility.check(valueType.type, field.stored.realization.contract),
                ) &&
                Tir.sameExecutableSite(valueType.site, field.stored.realization.site) &&
                Tir.effectRunnerId(valueType.environment.instance.declaration, valueType.site)
                  .module === field.stored.realization.runner.module &&
                Tir.effectRunnerId(valueType.environment.instance.declaration, valueType.site)
                  .name === field.stored.realization.runner.name &&
                RepresentationField.belongsTo(field.stored.realization.field, field.field) &&
                field.stored.realization.instance.module === operation.type.type.module &&
                field.stored.realization.instance.name === operation.type.type.name
              return (
                declared !== undefined &&
                declared.id.ordinal === field.field.ordinal &&
                valueType !== undefined &&
                ((field.stored === undefined &&
                  sameRuntimeType(semanticType(valueType), declared.type)) ||
                  storedCallableValid ||
                  storedEffectValid)
              )
            })
          if (!valid) {
            violations.push({
              _tag: 'Violation',
              rule: 'InvalidAggregateOperation',
              function: fn.id,
              region: region.id,
              detail: `construction of ${typeText(operation.type)} does not match its canonical fields`,
            })
          }
        }
        if (operation._tag === 'ConstructUnionVariant') {
          const layout = Layout.entry(self.layout, operation.type.type)
          const representation =
            layout?.representation._tag === 'NominalUnion' ? layout.representation : undefined
          const expected = representation?.variants.find(
            (variant) =>
              variant.ordinal === operation.variantOrdinal &&
              variant.variant.union.module === operation.variant.union.module &&
              variant.variant.union.name === operation.variant.union.name &&
              variant.variant.name === operation.variant.name,
          )
          const valid =
            representation !== undefined &&
            expected !== undefined &&
            representation.union.module === operation.type.type.module &&
            representation.union.name === operation.type.type.name &&
            expected.fields.length === operation.fields.length &&
            operation.fields.every((field, ordinal) => {
              const declared = expected.fields.at(ordinal)
              const valueType = fn.localTypes.at(field.value.ordinal)
              const storedCallableValid =
                field.stored?._tag === 'StoredCallableField' &&
                declared !== undefined &&
                valueType?._tag === 'CallableValue' &&
                sameRuntimeType(field.stored.type, declared.type) &&
                TypeCompatibility.isCompatible(
                  TypeCompatibility.check(valueType.type, field.stored.realization.contract),
                ) &&
                Tir.matchesCallableTargetIdentity(
                  valueType.target,
                  field.stored.realization.target,
                ) &&
                RepresentationField.belongsTo(field.stored.realization.field, field.field) &&
                field.stored.realization.instance.module === operation.type.type.module &&
                field.stored.realization.instance.name === operation.type.type.name
              const storedEffectValid =
                field.stored?._tag === 'StoredEffectField' &&
                declared !== undefined &&
                valueType?._tag === 'EffectValue' &&
                sameRuntimeType(field.stored.type, declared.type) &&
                TypeCompatibility.isCompatible(
                  TypeCompatibility.check(valueType.type, field.stored.realization.contract),
                ) &&
                Tir.sameExecutableSite(valueType.site, field.stored.realization.site) &&
                Tir.effectRunnerId(valueType.environment.instance.declaration, valueType.site)
                  .module === field.stored.realization.runner.module &&
                Tir.effectRunnerId(valueType.environment.instance.declaration, valueType.site)
                  .name === field.stored.realization.runner.name &&
                RepresentationField.belongsTo(field.stored.realization.field, field.field) &&
                field.stored.realization.instance.module === operation.type.type.module &&
                field.stored.realization.instance.name === operation.type.type.name
              return (
                declared !== undefined &&
                DeclarationFacts.sameFieldId(declared.id, field.field) &&
                valueType !== undefined &&
                ((field.stored === undefined &&
                  sameRuntimeType(semanticType(valueType), declared.type)) ||
                  storedCallableValid ||
                  storedEffectValid)
              )
            })
          if (!valid) {
            violations.push({
              _tag: 'Violation',
              rule: 'InvalidAggregateOperation',
              function: fn.id,
              region: region.id,
              detail: `construction of ${typeText(operation.type)}.${operation.variant.name} does not match its canonical variant layout`,
            })
          }
        }
        if (operation._tag === 'ConstructArray') {
          const semantic = operation.type.type
          const destination = fn.localTypes.at(operation.destination.ordinal)
          const valid =
            operation.elements.length === semantic.length &&
            destination !== undefined &&
            sameRuntimeType(semanticType(destination), semantic) &&
            operation.elements.every((element) => {
              const elementType = fn.localTypes.at(element.ordinal)
              return (
                elementType !== undefined &&
                sameRuntimeType(semanticType(elementType), semantic.element)
              )
            })
          if (!valid) {
            violations.push({
              _tag: 'Violation',
              rule: 'InvalidAggregateOperation',
              function: fn.id,
              region: region.id,
              detail: `construction of ${typeText(operation.type)} does not match its canonical element count or type`,
            })
          }
        }
        if (operation._tag === 'Project') {
          const sourceType = fn.localTypes.at(operation.source.ordinal)
          const sourceLayout =
            sourceType?._tag === 'Nominal' ? Layout.entry(self.layout, sourceType.type) : undefined
          const field =
            sourceLayout?.representation._tag === 'Aggregate'
              ? sourceLayout.representation.fields.find(
                  (candidate) => candidate.id.ordinal === operation.field.ordinal,
                )
              : undefined
          if (field === undefined || !sameRuntimeType(field.type, semanticType(operation.type))) {
            violations.push({
              _tag: 'Violation',
              rule: 'InvalidAggregateOperation',
              function: fn.id,
              region: region.id,
              detail: `projection field #${operation.field.ordinal} does not match its source type`,
            })
          }
        }
        if (operation._tag === 'ReadPlace' || operation._tag === 'CheckPlace') {
          const selected = placeType(fn, self.layout, operation.root, operation.selectors, true)
          const root = fn.localTypes.at(operation.root.ordinal)
          const rootSemantic = root === undefined ? undefined : semanticType(root)
          const referenceAccess =
            rootSemantic !== undefined && SilkType.isReference(rootSemantic)
              ? rootSemantic.access
              : undefined
          const sliceSelector = operation.selectors.find(
            (selector) => selector._tag === 'SliceElementSelector',
          )
          const borrowedAccesses = [
            ...(referenceAccess === undefined ? [] : [referenceAccess]),
            ...operation.selectors.flatMap((selector) =>
              selector._tag === 'SliceElementSelector' ? [selector.access] : [],
            ),
          ]
          const pairedReplacement =
            operation._tag === 'ReadPlace' && operation.consume === true
              ? operations.at(index + 1)
              : undefined
          const consumingReadValid =
            operation._tag !== 'ReadPlace' ||
            operation.consume !== true ||
            borrowedAccesses.length === 0 ||
            (borrowedAccesses.every((access) => access === 'Exclusive') &&
              pairedReplacement?._tag === 'WritePlace' &&
              pairedReplacement.root.ordinal === operation.root.ordinal &&
              samePlaceSelectors(pairedReplacement.selectors, operation.selectors))
          const sharedMatchProjection =
            operation._tag === 'ReadPlace' &&
            operation.consume !== true &&
            operations.filter((candidate) =>
              accessedOwnerLocals(candidate).some(
                (local) => local.ordinal === operation.destination.ordinal,
              ),
            ).length === 1 &&
            operations.some(
              (candidate) =>
                candidate._tag === 'Match' &&
                candidate.scrutinee.ordinal === operation.destination.ordinal &&
                (candidate.access === 'Shared' || candidate.access === 'Exclusive'),
            )
          // A read whose value is never accessed as an owner and is only borrowed shared observes
          // the place without claiming it: it cannot be moved, dropped, or written through, so a
          // non-Copy element reaches an interface witness without being duplicated in any sense a
          // later release could notice. This is the same license the shared match projection has.
          const sharedBorrowProjection =
            operation._tag === 'ReadPlace' &&
            operation.consume !== true &&
            operations.every(
              (candidate) =>
                !accessedOwnerLocals(candidate).some(
                  (local) => local.ordinal === operation.destination.ordinal,
                ),
            ) &&
            operations.some(
              (candidate) =>
                candidate._tag === 'BeginLoan' &&
                candidate.access === 'Shared' &&
                candidate.root.ordinal === operation.destination.ordinal,
            )
          // Loading an exclusive descriptor to access its referent is a reborrow, not an
          // owning copy. The temporary cannot escape, transfer, or be used as a value.
          const referenceViewProjection =
            operation._tag === 'ReadPlace' &&
            SilkType.isReference(selected ?? 'never') &&
            operation.type._tag === 'Reference' &&
            !controlLocals.has(operation.destination.ordinal) &&
            [...(descriptorUses.get(operation.destination.ordinal) ?? [])].every((candidate) => {
              if (candidate === operation) return true
              if (
                !operationLocals(candidate).some(
                  (local) => local.ordinal === operation.destination.ordinal,
                )
              )
                return true
              return (
                (candidate._tag === 'ReadPlace' ||
                  candidate._tag === 'CheckPlace' ||
                  candidate._tag === 'WritePlace' ||
                  (candidate._tag === 'BeginLoan' && !borrowsDescriptor(candidate))) &&
                candidate.root.ordinal === operation.destination.ordinal &&
                (candidate._tag !== 'WritePlace' ||
                  candidate.source.ordinal !== operation.destination.ordinal)
              )
            })
          const callableViewProjection =
            operation._tag === 'ReadPlace' &&
            operation.consume !== true &&
            operation.type._tag === 'CallableValue' &&
            operation.type.storage !== undefined &&
            operations.filter((candidate) =>
              accessedOwnerLocals(candidate).some(
                (local) => local.ordinal === operation.destination.ordinal,
              ),
            ).length === 1 &&
            operations.some(
              (candidate) =>
                candidate._tag === 'ApplyCallable' &&
                candidate.callable?.ordinal === operation.destination.ordinal &&
                (candidate.access === 'Shared' || candidate.access === 'Exclusive'),
            )
          const effectViewProjection =
            operation._tag === 'ReadPlace' &&
            operation.consume !== true &&
            operation.type._tag === 'EffectValue' &&
            operation.type.storage !== undefined &&
            (operation.type.type.access === 'Shared' ||
              operation.type.type.access === 'Exclusive') &&
            operations.filter((candidate) =>
              accessedOwnerLocals(candidate).some(
                (local) => local.ordinal === operation.destination.ordinal,
              ),
            ).length === 1 &&
            operations.some(
              (candidate) =>
                candidate._tag === 'RunEffectValue' &&
                candidate.effect.ordinal === operation.destination.ordinal,
            )
          if (
            selected === undefined ||
            !sameRuntimeType(selected, semanticType(operation.type)) ||
            !consumingReadValid ||
            (operation._tag === 'ReadPlace' &&
              !isCopy(self.layout, selected) &&
              operation.consume !== true &&
              !sharedMatchProjection &&
              !sharedBorrowProjection &&
              !referenceViewProjection &&
              !callableViewProjection &&
              !effectViewProjection)
          ) {
            violations.push({
              _tag: 'Violation',
              rule:
                sliceSelector === undefined ? 'InvalidAggregateOperation' : 'InvalidSliceOperation',
              function: fn.id,
              region: region.id,
              detail: !consumingReadValid
                ? 'consuming borrowed ReadPlace is not followed by a same-place replacement through exclusive access'
                : `${operation._tag} does not match its root, selectors, or type`,
            })
          }
        }
        if (operation._tag === 'WritePlace') {
          const selected = placeType(fn, self.layout, operation.root, operation.selectors, true)
          const source = fn.localTypes.at(operation.source.ordinal)
          const root = fn.localTypes.at(operation.root.ordinal)
          const rootSemantic = root === undefined ? undefined : semanticType(root)
          const sliceSelector = operation.selectors.find(
            (selector) => selector._tag === 'SliceElementSelector',
          )
          const checked = operations
            .slice(0, index)
            .some(
              (candidate) =>
                candidate._tag === 'CheckPlace' &&
                candidate.root.ordinal === operation.root.ordinal &&
                samePlaceSelectors(candidate.selectors, operation.selectors),
            )
          if (
            selected === undefined ||
            source === undefined ||
            root === undefined ||
            !checked ||
            !sameRuntimeType(selected, semanticType(operation.type)) ||
            !sameRuntimeType(semanticType(source), selected) ||
            !SilkType.equals(semanticType(root), semanticType(operation.rootType)) ||
            (rootSemantic !== undefined &&
              SilkType.isReference(rootSemantic) &&
              rootSemantic.access !== 'Exclusive') ||
            (sliceSelector !== undefined && sliceSelector.access !== 'Exclusive')
          ) {
            violations.push({
              _tag: 'Violation',
              rule: 'InvalidWrite',
              function: fn.id,
              region: region.id,
              detail: 'write lacks a matching precheck or has inconsistent root/source/place types',
            })
          }
        }
        if (operation._tag === 'Call') {
          const target = self.functions.find((candidate) =>
            matchesCall(
              candidate,
              operation.target,
              operation.typeArguments,
              operation.staticArguments,
              operation.type,
            ),
          )
          const valid =
            target !== undefined &&
            target.parameterCount === operation.arguments.length &&
            operation.arguments.every((argument, ordinal) => {
              const actual = fn.localTypes.at(argument.ordinal)
              const expected = target?.localTypes.at(ordinal)
              return (
                actual !== undefined &&
                expected !== undefined &&
                callArgumentCompatible(actual, expected)
              )
            }) &&
            matchesCall(
              target,
              operation.target,
              operation.typeArguments,
              operation.staticArguments,
              operation.type,
            )
          if (!valid) {
            const argumentsDetail = operation.arguments
              .map((argument, ordinal) => {
                const actual = fn.localTypes.at(argument.ordinal)
                const expected = target?.localTypes.at(ordinal)
                return `${ordinal}:${actual === undefined ? 'missing' : SilkType.encode(semanticType(actual))}->${expected === undefined ? 'missing' : SilkType.encode(semanticType(expected))}`
              })
              .join(', ')
            violations.push({
              _tag: 'Violation',
              rule: 'InvalidCallShape',
              function: fn.id,
              region: region.id,
              detail: `call ${targetText(operation.target)} does not match its logical contract (${argumentsDetail || 'no arguments'}; result=${SilkType.encode(semanticType(operation.type))}->${target === undefined ? 'missing' : SilkType.encode(semanticType(target.result))})`,
            })
          }
        }
        if (operation._tag === 'MakeCallable') {
          const destination = fn.localTypes.at(operation.destination.ordinal)
          const environment = operation.type.environment
          const fields = environment?.fields ?? []
          // A spliced base contributes the leading fields; its own environment must be the
          // exact prefix of the new one, both in count and in every field's shape.
          const base =
            operation.base === undefined ? undefined : fn.localTypes.at(operation.base.ordinal)
          let baseFields: ReadonlyArray<Layout.CallableEnvironmentField> | undefined
          if (operation.base === undefined) baseFields = []
          else if (base?._tag === 'CallableValue') baseFields = base.environment?.fields ?? []
          const baseValid =
            baseFields !== undefined &&
            (operation.base === undefined ||
              (base?._tag === 'CallableValue' &&
                Tir.sameCallableTarget(base.target, operation.target) &&
                baseFields.every((field, ordinal) => {
                  const target = fields.at(ordinal)
                  return (
                    target !== undefined &&
                    target.ordinal === field.ordinal &&
                    target.parameterOrdinal === field.parameterOrdinal &&
                    target.access === field.access &&
                    SilkType.equals(target.type, field.type)
                  )
                })))
          const capturesValid =
            baseValid &&
            operation.captures.length + (baseFields?.length ?? 0) === fields.length &&
            operation.captures.every((capture, offset) => {
              const ordinal = (baseFields?.length ?? 0) + offset
              const field = fields.at(ordinal)
              const source = fn.localTypes.at(capture.source.ordinal)
              return (
                field !== undefined &&
                source !== undefined &&
                capture.ordinal === field.ordinal &&
                capture.parameterOrdinal === field.parameterOrdinal &&
                capture.access === field.access &&
                acceptsRuntimeOperand(semanticType(source), field.type)
              )
            })
          const valid =
            destination?._tag === 'CallableValue' &&
            SilkType.equals(destination.type, operation.type.type) &&
            Tir.sameCallableTarget(destination.target, operation.target) &&
            Tir.sameCallableTarget(operation.type.target, operation.target) &&
            constructionTargetArgumentsConcrete(operation) &&
            (environment === undefined
              ? operation.captures.length === 0
              : capturesValid &&
                Tir.sameCallableTarget(environment.callable.target, operation.target) &&
                environment.callable.mode === operation.type.type.mode)
          if (!valid) {
            violations.push({
              _tag: 'Violation',
              rule: 'InvalidCallableOperation',
              function: fn.id,
              region: region.id,
              detail: 'callable construction disagrees with its identity, slots, or layout',
            })
          }
        }
        if (operation._tag === 'ApplyCallable') {
          const destination = fn.localTypes.at(operation.destination.ordinal)
          const source =
            operation.callable === undefined
              ? undefined
              : fn.localTypes.at(operation.callable.ordinal)
          const argumentsValid =
            operation.arguments.length === operation.callableType.parameters.length &&
            operation.arguments.every((argument, ordinal) => {
              const actual = fn.localTypes.at(argument.ordinal)
              const expected = operation.callableType.parameters.at(ordinal)
              return (
                actual !== undefined &&
                expected !== undefined &&
                acceptsRuntimeOperand(semanticType(actual), expected)
              )
            })
          const environmentForm =
            operation.realization === 'Environment' &&
            operation.callable !== undefined &&
            operation.target === undefined &&
            operation.captures.length === 0 &&
            source?._tag === 'CallableValue' &&
            TypeCompatibility.isCompatible(
              TypeCompatibility.check(source.type, operation.callableType),
            )
          const directDeclaration =
            operation.target?._tag === 'DeclarationCallableTarget'
              ? operation.target.declaration
              : undefined
          const directTarget =
            directDeclaration === undefined
              ? undefined
              : self.functions.find((candidate) =>
                  matchesInstance(candidate, directDeclaration, operation.typeArguments),
                )
          const directCapturesValid =
            operation.captures.length === 0 ||
            (operation.target?._tag === 'BuiltinCallableTarget'
              ? operation.captures.every(
                  (capture, ordinal, captures) =>
                    fn.localTypes.at(capture.source.ordinal) !== undefined &&
                    captures.findIndex(
                      (candidate) => candidate.parameterOrdinal === capture.parameterOrdinal,
                    ) === ordinal,
                )
              : directTarget !== undefined &&
                operation.captures.every((capture) => {
                  const sourceType = fn.localTypes.at(capture.source.ordinal)
                  const parameterType = directTarget.localTypes.at(capture.parameterOrdinal)
                  return (
                    sourceType !== undefined &&
                    parameterType !== undefined &&
                    acceptsRuntimeOperand(semanticType(sourceType), semanticType(parameterType))
                  )
                }))
          const directForm =
            operation.realization === 'DirectErasedSection' &&
            operation.callable === undefined &&
            operation.target !== undefined &&
            directCapturesValid
          const preApplicationForm = invokesPreApplicationEnvironment(self, operation, source)
          const valid =
            destination !== undefined &&
            SilkType.equals(semanticType(destination), semanticType(operation.type)) &&
            operation.access === operation.callableType.mode &&
            operation.typeArguments.every(SilkType.isRuntimeConcreteGenericArgument) &&
            argumentsValid &&
            (environmentForm || directForm || preApplicationForm)
          if (!valid) {
            violations.push({
              _tag: 'Violation',
              rule: 'InvalidCallableOperation',
              function: fn.id,
              region: region.id,
              detail: `callable application disagrees with its mode, arguments, realization, or result (destination=${destination !== undefined && SilkType.equals(semanticType(destination), semanticType(operation.type))}, mode=${operation.access}/${operation.callableType.mode}:${operation.access === operation.callableType.mode}, source=${source?._tag === 'CallableValue' ? source.type.mode : 'none'}, types=${operation.typeArguments.every(SilkType.isRuntimeConcreteGenericArgument)}, arguments=${argumentsValid}, environment=${environmentForm}, direct=${directForm}, preApplication=${preApplicationForm}, captures=${directCapturesValid})`,
            })
          }
        }
        if (operation._tag === 'PackEffectOutcome') {
          const destination = fn.localTypes.at(operation.destination.ordinal)
          const source = fn.localTypes.at(operation.source.ordinal)
          const payload =
            operation.tag === 0
              ? operation.type.type.success
              : SilkType.failureCarrierMember(operation.type.type, operation.tag, 'OneBased')
          if (
            destination?._tag !== 'EffectOutcome' ||
            source === undefined ||
            payload === undefined ||
            !SilkType.equals(destination.type, operation.type.type) ||
            (source._tag !== 'Bottom' &&
              SilkType.runtimeKey(semanticType(source)) !== SilkType.runtimeKey(payload))
          )
            violations.push({
              _tag: 'Violation',
              rule: 'InvalidEffectOperation',
              function: fn.id,
              region: region.id,
              detail: 'effect outcome tag, payload, or destination type is inconsistent',
            })
        }
        if (operation._tag === 'PackEffectFailureUnion') {
          const destination = fn.localTypes.at(operation.destination.ordinal)
          const source = fn.localTypes.at(operation.source.ordinal)
          const mappingsValid =
            operation.mappings.length === operation.sourceType.type.members.length &&
            operation.mappings.every((mapping, sourceOrdinal) => {
              const sourceMember = SilkType.failureCarrierMember(
                operation.sourceType.type,
                mapping.source,
                'ZeroBased',
              )
              const targetFailure = SilkType.failureCarrierMember(
                operation.type.type,
                mapping.target,
                'OneBased',
              )
              return (
                mapping.source === sourceOrdinal &&
                sourceMember !== undefined &&
                targetFailure !== undefined &&
                SilkType.equals(sourceMember, targetFailure)
              )
            })
          if (
            destination?._tag !== 'EffectOutcome' ||
            source?._tag !== 'Union' ||
            !SilkType.equals(destination.type, operation.type.type) ||
            !SilkType.equals(source.type, operation.sourceType.type) ||
            !mappingsValid
          )
            violations.push({
              _tag: 'Violation',
              rule: 'InvalidEffectOperation',
              function: fn.id,
              region: region.id,
              detail: 'effect failure-union mappings do not preserve E members',
            })
        }
        if (operation._tag === 'PropagateEffectFailure') {
          const source = fn.localTypes.at(operation.source.ordinal)
          const outcome = fn.localTypes.at(operation.outcome.ordinal)
          const semanticSource = semanticType(operation.sourceType)
          const sourceMembers = SilkType.isUnion(semanticSource)
            ? semanticSource.members
            : [semanticSource]
          const propagationShape = Layout.callingShape(self.layout, operation.propagationType.type)
          const mappingsValid =
            operation.tagMappings.length === sourceMembers.length &&
            operation.tagMappings.every((mapping, sourceOrdinal) => {
              const expectedSource = sourceMembers.at(sourceOrdinal)
              const sourceMember = SilkType.failureCarrierMember(
                semanticType(operation.sourceType),
                mapping.source,
                'ZeroBased',
              )
              const targetFailure = SilkType.failureCarrierMember(
                operation.propagationType.type,
                mapping.target,
                'OneBased',
              )
              return (
                mapping.source === sourceOrdinal &&
                expectedSource !== undefined &&
                sourceMember !== undefined &&
                targetFailure !== undefined &&
                SilkType.equals(sourceMember, expectedSource) &&
                SilkType.equals(sourceMember, targetFailure)
              )
            })
          if (
            source === undefined ||
            outcome?._tag !== 'EffectOutcome' ||
            propagatedOutcomeOwners.get(operation.source.ordinal) !== operation.outcome.ordinal ||
            !sourceMembers.every((member) =>
              SilkType.failureMembers(outcome.type).some((failure) =>
                SilkType.equals(member, failure),
              ),
            ) ||
            !SilkType.equals(semanticType(source), semanticType(operation.sourceType)) ||
            !SilkType.equals(semanticType(fn.result), operation.propagationType.type) ||
            propagationShape?.laneCount !== operation.propagationLaneCount ||
            !SilkType.isNever(operation.type.type) ||
            !mappingsValid
          )
            violations.push({
              _tag: 'Violation',
              rule: 'InvalidEffectOperation',
              function: fn.id,
              region: region.id,
              detail: 'failure propagation does not preserve canonical outcome contracts',
            })
        }
        if (operation._tag === 'UnpackEffectSuccess') {
          const source = fn.localTypes.at(operation.source.ordinal)
          const destination = fn.localTypes.at(operation.destination.ordinal)
          if (
            source?._tag !== 'EffectOutcome' ||
            destination === undefined ||
            !SilkType.equals(source.type.success, semanticType(destination)) ||
            !SilkType.equals(semanticType(operation.type), semanticType(destination))
          )
            violations.push({
              _tag: 'Violation',
              rule: 'InvalidEffectOperation',
              function: fn.id,
              region: region.id,
              detail: 'effect success projection does not match its outcome contract',
            })
        }
        if (operation._tag === 'UnpackEffectComposite') {
          const source = fn.localTypes.at(operation.source.ordinal)
          const destination = fn.localTypes.at(operation.destination.ordinal)
          const selected =
            source?._tag === 'EffectComposite'
              ? source.alternatives.at(operation.alternative)
              : undefined
          if (
            selected === undefined ||
            destination?._tag !== 'EffectValue' ||
            fn.localTypes.at(operation.matched.ordinal)?._tag !== 'bool' ||
            !SilkType.equals(destination.type, operation.type.type) ||
            !SilkType.equals(selected.type, operation.type.type) ||
            !Tir.sameExecutableSite(selected.site, operation.type.site)
          )
            violations.push({
              _tag: 'Violation',
              rule: 'InvalidEffectOperation',
              function: fn.id,
              region: region.id,
              detail: 'Effect choice projection does not preserve its selected exact alternative',
            })
        }
        if (operation._tag === 'PackEffectComposite') {
          const source = fn.localTypes.at(operation.source.ordinal)
          const destination = fn.localTypes.at(operation.destination.ordinal)
          const selected = operation.type.alternatives.at(operation.alternative)
          if (
            source?._tag !== 'EffectValue' ||
            destination?._tag !== 'EffectComposite' ||
            selected === undefined ||
            !SilkType.equals(destination.type, operation.type.type) ||
            !SilkType.equals(source.type, selected.type) ||
            !Tir.sameExecutableSite(source.site, selected.site)
          )
            violations.push({
              _tag: 'Violation',
              rule: 'InvalidEffectOperation',
              function: fn.id,
              region: region.id,
              detail: 'Effect composite packing does not preserve its selected exact alternative',
            })
        }
        if (operation._tag === 'RunEffect') {
          const target = self.functions.find((candidate) =>
            matchesEffectInstance(
              candidate,
              operation.target,
              operation.typeArguments,
              operation.staticArguments,
              operation.outcomeType.type,
            ),
          )
          let detail: string | undefined
          if (target === undefined) detail = 'run target specialization is missing'
          else if (!runnerOutcomeMatches(target, operation.outcomeType.type))
            detail = 'run target outcome disagrees with the operation outcome'
          else if (!runPropagationValid(self.layout, fn, operation))
            detail = 'run propagation does not preserve canonical outcome contracts'
          if (detail !== undefined)
            violations.push({
              _tag: 'Violation',
              rule: 'InvalidEffectOperation',
              function: fn.id,
              region: region.id,
              detail,
            })
        }
        if (operation._tag === 'RunEffectValue') {
          const effect = fn.localTypes.at(operation.effect.ordinal)
          const physicalOutcome = ExecutableInputView.outcome(
            self,
            effect,
            operation.outcomeType.type,
          )
          const outcome = fn.localTypes.at(operation.outcome.ordinal)
          const destination = fn.localTypes.at(operation.destination.ordinal)
          const runner = self.functions.find(
            (candidate) =>
              physicalOutcome !== undefined &&
              matchesEffectInstance(
                candidate,
                operation.runner,
                operation.runnerTypeArguments,
                operation.runnerStaticArguments,
                physicalOutcome,
                operation.providers,
              ),
          )
          const suspensionRegion = fn.suspension?.regions.find(
            (candidate) =>
              candidate.operation._tag === 'RunEffectValue' &&
              (candidate._tag === 'RunSuspendableEffectRegion'
                ? candidate.runner.declaration?.module === operation.runner.module &&
                  candidate.runner.declaration.name === operation.runner.name
                : candidate.deferred.declaration?.module === operation.runner.module &&
                  candidate.deferred.declaration.name === operation.runner.name),
          )
          const suspensionRunner =
            suspensionRegion?._tag === 'RunSuspendableEffectRegion'
              ? suspensionRegion.runner
              : suspensionRegion?.deferred
          const propagationValid = runPropagationValid(self.layout, fn, operation)
          const effectValue = effect?._tag === 'EffectValue' ? effect : undefined
          const stored = effectValue?.storage
          const storedContractValid =
            stored === undefined ||
            (effectValue !== undefined &&
              SilkType.equals(effectValue.type, stored.realization.contract) &&
              effectValue.type.access === stored.realization.access &&
              SilkType.failureMembers(effectValue.type).length ===
                stored.realization.rows.failures.length &&
              SilkType.failureMembers(effectValue.type).every((failure, ordinal) => {
                const expected = stored.realization.rows.failures.at(ordinal)
                return expected !== undefined && SilkType.equals(failure, expected)
              }) &&
              SilkType.requirementMembers(effectValue.type).length ===
                stored.realization.rows.requirements.length &&
              SilkType.requirementMembers(effectValue.type).every((requirement, ordinal) => {
                const expected = stored.realization.rows.requirements.at(ordinal)
                return (
                  expected !== undefined &&
                  requirement.access === expected.access &&
                  requirement.role === expected.role &&
                  SilkType.equals(requirement.capability, expected.capability)
                )
              }))
          const staticRunnerValid =
            stored === undefined && operation.runnerBase === undefined
              ? true
              : (() => {
                  if (effectValue === undefined) return false
                  const base = operation.runnerBase
                  const selectedBase = base?.declaration ?? operation.runner
                  const selectedArguments = base?.typeArguments ?? operation.runnerTypeArguments
                  const selectedStaticArguments =
                    base?.staticArguments ?? operation.runnerStaticArguments ?? []
                  const expectedBase =
                    stored?.realization.runner ??
                    Tir.effectRunnerId(
                      effectValue.environment.instance.declaration,
                      effectValue.site,
                    )
                  const expectedRunnerInstance =
                    stored?.realization.runnerInstance ?? effectValue.environment.instance
                  const expectedBaseArguments =
                    stored?.realization.runnerArguments ??
                    effectValue.environment.instance.typeArguments
                  const expectedStaticArguments = expectedRunnerInstance.staticArguments
                  const baseMatches =
                    selectedBase.module === expectedBase.module &&
                    selectedBase.name === expectedBase.name &&
                    selectedArguments.length === expectedBaseArguments.length &&
                    selectedArguments.every((argument, ordinal) => {
                      const expected = expectedBaseArguments.at(ordinal)
                      return (
                        expected !== undefined && SilkType.equalsGenericArgument(argument, expected)
                      )
                    }) &&
                    selectedStaticArguments.length === expectedStaticArguments.length &&
                    selectedStaticArguments.every((argument, ordinal) => {
                      const expected = expectedStaticArguments.at(ordinal)
                      return expected !== undefined && StaticValue.equals(argument, expected)
                    })
                  const expectedRequirements =
                    stored?.realization.rows.requirements ??
                    SilkType.requirementMembers(effectValue.type)
                  const requirementsMatch =
                    operation.providers.length === expectedRequirements.length &&
                    operation.providers.every((provider, ordinal) => {
                      const requirement = expectedRequirements.at(ordinal)
                      const argumentType =
                        provider.argument === undefined
                          ? undefined
                          : fn.localTypes.at(provider.argument.ordinal)
                      const semanticArgument =
                        argumentType === undefined ? undefined : semanticType(argumentType)
                      return (
                        requirement !== undefined &&
                        provider.role === requirement.role &&
                        provider.requirementAccess === requirement.access &&
                        SilkType.equals(provider.capability, requirement.capability) &&
                        // The row is exact, but its admitted witness can come from another
                        // proof-only lifetime context of this shared physical runner.
                        SilkType.runtimeKey(provider.witness.capability) ===
                          SilkType.runtimeKey(provider.capability) &&
                        SilkType.equals(provider.witness.provider, provider.providerType) &&
                        (requirement.access === 'Shared' ||
                          provider.access === 'Exclusive' ||
                          provider.access === 'Take') &&
                        (provider.argument === undefined ||
                          (semanticArgument !== undefined &&
                            SilkType.isReference(semanticArgument) &&
                            semanticArgument.access ===
                              (provider.access === 'Take' ? 'Exclusive' : provider.access) &&
                            SilkType.equals(semanticArgument.target, provider.providerType)))
                      )
                    })
                  const runtimeArguments = operation.providers.flatMap((provider) =>
                    provider.argument === undefined ? [] : [provider.argument],
                  )
                  const argumentsMatch =
                    runtimeArguments.length === operation.arguments.length &&
                    runtimeArguments.every(
                      (argument, ordinal) =>
                        argument.ordinal === operation.arguments.at(ordinal)?.ordinal,
                    )
                  const wrapperShapeMatches =
                    runner !== undefined &&
                    runner.parameterCount ===
                      effectValue.environment.fields.length + operation.arguments.length
                  const runnerBinding = runner?.effectRunner
                  const wrapperBindingMatches =
                    runnerBinding !== undefined &&
                    runnerBinding.base.declaration.module === selectedBase.module &&
                    runnerBinding.base.declaration.name === selectedBase.name &&
                    // Generated runners share machine code across invocation lifetimes. The
                    // stored contract/base above still checks the exact call's semantic arguments.
                    runtimeArgumentsEqual(runnerBinding.base.typeArguments, selectedArguments) &&
                    runnerBinding.providers.length === operation.providers.length &&
                    runnerBinding.providers.every((bound, ordinal) => {
                      const claimed = operation.providers.at(ordinal)
                      return (
                        claimed !== undefined &&
                        bound.role === claimed.role &&
                        bound.access === claimed.access &&
                        SilkType.equals(bound.capability, claimed.capability) &&
                        SilkType.equals(bound.providerType, claimed.providerType) &&
                        conformanceWitnessMatches(bound.witness, claimed.witness)
                      )
                    })
                  return (
                    baseMatches &&
                    requirementsMatch &&
                    argumentsMatch &&
                    wrapperShapeMatches &&
                    wrapperBindingMatches &&
                    (operation.providers.length === 0
                      ? operation.runnerBase === undefined
                      : operation.runnerBase !== undefined)
                  )
                })()
          const valid =
            effectValue !== undefined &&
            outcome?._tag === 'EffectOutcome' &&
            destination !== undefined &&
            SilkType.equals(effectValue.type, operation.outcomeType.type) &&
            SilkType.equals(outcome.type, operation.outcomeType.type) &&
            SilkType.equals(semanticType(destination), semanticType(operation.type)) &&
            ((runner !== undefined &&
              physicalOutcome !== undefined &&
              runnerOutcomeMatches(runner, physicalOutcome)) ||
              (suspensionRunner !== undefined &&
                SilkType.equals(suspensionRunner.outcome, operation.outcomeType.type))) &&
            storedContractValid &&
            staticRunnerValid &&
            propagationValid
          if (!valid)
            violations.push({
              _tag: 'Violation',
              rule: 'InvalidEffectOperation',
              function: fn.id,
              region: region.id,
              detail: `Effect value run disagrees with its static runner, exact rows, access, outcome, or propagation contract (target=${targetText(operation.runner)}, effect=${effectValue !== undefined}, runner=${runner !== undefined}, suspension-runner=${suspensionRunner !== undefined}, stored-contract=${storedContractValid}, static-runner=${staticRunnerValid}, propagation=${propagationValid})`,
            })
        }
        if (operation._tag === 'RunEffectComposite') {
          const effect = fn.localTypes.at(operation.effect.ordinal)
          const outcome = fn.localTypes.at(operation.outcome.ordinal)
          const destination = fn.localTypes.at(operation.destination.ordinal)
          const alternativesValid =
            effect?._tag === 'EffectComposite' &&
            operation.alternatives.length === effect.alternatives.length &&
            operation.alternatives.every((alternative, ordinal) => {
              const expected = effect.alternatives.at(ordinal)
              const runner = self.functions.find((candidate) =>
                matchesEffectInstance(
                  candidate,
                  alternative.runner,
                  alternative.runnerTypeArguments,
                  alternative.runnerStaticArguments,
                  alternative.type.type,
                ),
              )
              const sourceFailures = SilkType.failureMembers(alternative.type.type)
              const mappingsValid =
                alternative.tagMappings.length === sourceFailures.length &&
                alternative.tagMappings.every((mapping, sourceOrdinal) => {
                  const source = sourceFailures.at(sourceOrdinal)
                  const target = SilkType.failureCarrierMember(
                    operation.outcomeType.type,
                    mapping.target,
                    'OneBased',
                  )
                  return (
                    mapping.source === sourceOrdinal + 1 &&
                    source !== undefined &&
                    target !== undefined &&
                    SilkType.equals(source, target)
                  )
                })
              const inputs = [
                ...alternative.type.environment.fields.map((_, inputOrdinal) => ({
                  _tag: 'Capture' as const,
                  ordinal: inputOrdinal,
                })),
                ...alternative.arguments.map((argument) => ({
                  _tag: 'Local' as const,
                  local: argument,
                })),
              ]
              const parametersValid =
                runner !== undefined &&
                runner.parameterCount === inputs.length &&
                inputs.every((input, inputOrdinal) => {
                  const actual =
                    input._tag === 'Capture'
                      ? alternative.type.environment.fields.at(input.ordinal)?.type
                      : (() => {
                          const localType = fn.localTypes.at(input.local.ordinal)
                          return localType === undefined ? undefined : semanticType(localType)
                        })()
                  const expectedType = runner.localTypes.at(inputOrdinal)
                  return (
                    actual !== undefined &&
                    expectedType !== undefined &&
                    acceptsRuntimeOperand(actual, semanticType(expectedType))
                  )
                })
              return (
                expected !== undefined &&
                SilkType.equals(expected.type, alternative.type.type) &&
                Tir.sameExecutableSite(expected.site, alternative.type.site) &&
                runner !== undefined &&
                runnerOutcomeMatches(runner, alternative.type.type) &&
                parametersValid &&
                mappingsValid
              )
            })
          if (
            effect?._tag !== 'EffectComposite' ||
            outcome?._tag !== 'EffectOutcome' ||
            destination === undefined ||
            !SilkType.equals(effect.contract, operation.outcomeType.type) ||
            !SilkType.equals(outcome.type, operation.outcomeType.type) ||
            !SilkType.equals(semanticType(destination), semanticType(operation.type)) ||
            !alternativesValid ||
            !runPropagationValid(self.layout, fn, operation)
          )
            violations.push({
              _tag: 'Violation',
              rule: 'InvalidEffectOperation',
              function: fn.id,
              region: region.id,
              detail:
                'Effect composite run disagrees with its alternatives, joined outcome, or propagation contract',
            })
        }
        if (operation._tag === 'RunStaticEffect') {
          const outcome = fn.localTypes.at(operation.outcome.ordinal)
          const destination = fn.localTypes.at(operation.destination.ordinal)
          const inputs = [
            ...operation.captures.map((capture) => capture.source),
            ...operation.arguments,
          ]
          const runner = self.functions.find(
            (candidate) =>
              matchesEffectInstance(
                candidate,
                operation.runner,
                operation.runnerTypeArguments,
                operation.runnerStaticArguments,
                operation.outcomeType.type,
              ) && runnerOutcomeMatches(candidate, operation.outcomeType.type),
          )
          const parametersValid =
            runner !== undefined &&
            runner.parameterCount === inputs.length &&
            inputs.every((input, ordinal) => {
              const actual = fn.localTypes.at(input.ordinal)
              const expected = runner.localTypes.at(ordinal)
              return (
                actual !== undefined &&
                expected !== undefined &&
                executionArgumentCompatible(actual, expected)
              )
            })
          const propagationValid = runPropagationValid(self.layout, fn, operation)
          const runnerResultValid =
            runner !== undefined && runnerOutcomeMatches(runner, operation.outcomeType.type)
          const outcomeValid =
            outcome?._tag === 'EffectOutcome' &&
            SilkType.equals(outcome.type, operation.outcomeType.type)
          const destinationValid =
            destination !== undefined &&
            SilkType.equals(semanticType(destination), semanticType(operation.type))
          if (
            !runnerResultValid ||
            !outcomeValid ||
            !destinationValid ||
            !parametersValid ||
            !propagationValid
          )
            violations.push({
              _tag: 'Violation',
              rule: 'InvalidNormalization',
              function: fn.id,
              region: region.id,
              detail: `direct static Effect run disagrees: ${[
                runnerResultValid ? undefined : 'runner',
                outcomeValid ? undefined : 'outcome',
                destinationValid ? undefined : 'destination',
                parametersValid
                  ? undefined
                  : `parameters (${inputs
                      .map((input, ordinal) => {
                        const actual = fn.localTypes.at(input.ordinal)
                        const expected = runner?.localTypes.at(ordinal)
                        return `${actual === undefined ? '<missing>' : SilkType.encode(semanticType(actual))} -> ${expected === undefined ? '<missing>' : SilkType.encode(semanticType(expected))}`
                      })
                      .join(', ')})`,
                propagationValid ? undefined : 'propagation',
              ]
                .filter((part): part is string => part !== undefined)
                .join(', ')}`,
            })
        }
        if (operation._tag === 'CatchEffect') {
          const effect = fn.localTypes.at(operation.effect.ordinal)
          const physicalOutcome = ExecutableInputView.outcome(
            self,
            effect,
            operation.outcomeType.type,
          )
          const runner = self.functions.find(
            (candidate) =>
              physicalOutcome !== undefined &&
              matchesEffectInstance(
                candidate,
                operation.runner,
                operation.runnerTypeArguments,
                operation.runnerStaticArguments,
                physicalOutcome,
              ),
          )
          const destination = fn.localTypes.at(operation.destination.ordinal)
          const outcome = fn.localTypes.at(operation.outcome.ordinal)
          const success = fn.localTypes.at(operation.successValue.ordinal)
          const failure = fn.localTypes.at(operation.failureValue.ordinal)
          const expectedFailureValue = SilkType.failureValue(
            SilkType.failureMembers(operation.outcomeType.type),
          )
          const disagreements = [
            runner !== undefined &&
            physicalOutcome !== undefined &&
            runnerOutcomeMatches(runner, physicalOutcome)
              ? undefined
              : `runner(${runner?.result._tag === 'EffectOutcome' ? SilkType.encode(runner.result.type) : (runner?.result._tag ?? 'missing')} != ${SilkType.encode(operation.outcomeType.type)})`,
            effect?._tag === 'EffectValue' &&
            SilkType.equals(effect.type, operation.outcomeType.type)
              ? undefined
              : 'effect',
            outcome?._tag === 'EffectOutcome' &&
            SilkType.equals(outcome.type, operation.outcomeType.type)
              ? undefined
              : 'outcome',
            destination?._tag === 'bool' ? undefined : 'destination',
            success !== undefined &&
            SilkType.equals(semanticType(success), operation.outcomeType.type.success)
              ? undefined
              : 'success',
            failure !== undefined && SilkType.equals(semanticType(failure), expectedFailureValue)
              ? undefined
              : 'failure',
            SilkType.equals(operation.failureValueType, expectedFailureValue)
              ? undefined
              : 'failure-value',
            SilkType.equals(operation.successShape.type, operation.outcomeType.type.success)
              ? undefined
              : 'success-shape',
            SilkType.runtimeKey(operation.outcomeShape.type) ===
            SilkType.runtimeKey(operation.outcomeType.type)
              ? undefined
              : 'outcome-shape',
            SilkType.runtimeKey(operation.failureValueShape.type) ===
            SilkType.runtimeKey(expectedFailureValue)
              ? undefined
              : 'failure-shape',
          ].filter((disagreement): disagreement is string => disagreement !== undefined)
          if (disagreements.length > 0) {
            violations.push({
              _tag: 'Violation',
              rule: 'InvalidEffectOperation',
              function: fn.id,
              region: region.id,
              detail: `effect result runner, channel data, or calling shapes disagree: ${disagreements.join(', ')}`,
            })
          }
        }
      }
    }
    if (
      !violations.some(
        (violation) =>
          violation.function?.module === fn.id.module && violation.function.name === fn.id.name,
      )
    ) {
      violations.push(
        ...trace('MirVerification.verifyInitialization', () => initializationOf(fn, self.layout))
          .violations,
      )
    }
  }
  for (const [ordinal, fn] of self.functions.entries()) {
    trace('MirVerification.verifyFunction', () => verifyFunction(fn), {
      'function.module': fn.id.module,
      'function.name': fn.id.name,
      'function.ordinal': ordinal,
      'regions.count': fn.regions.length,
    })
  }
  trace('MirVerification.verifyNormalization', () => {
    for (const verdict of self.normalization ?? []) {
      const candidates = self.functions.filter(
        (candidate) =>
          candidate.id.module === verdict.function.module &&
          candidate.id.name === verdict.function.name,
      )
      const fn = candidates.find((candidate) => {
        const region = regionsTree(candidate.regions).find(
          (candidateRegion) => candidateRegion.id.ordinal === verdict.region.ordinal,
        )
        return region !== undefined && candidate.localTypes.at(verdict.local.ordinal) !== undefined
      })
      const region =
        fn === undefined
          ? undefined
          : regionsTree(fn.regions).find(
              (candidate) => candidate.id.ordinal === verdict.region.ordinal,
            )
      const local = fn?.localTypes.at(verdict.local.ordinal)
      const synchronous = verdict._tag === 'Rejected' || verdict.guards.includes('Synchronous')
      if (fn === undefined || region === undefined || local === undefined || !synchronous) {
        violations.push({
          _tag: 'Violation',
          rule: 'InvalidNormalization',
          ...(fn === undefined ? {} : { function: fn.id }),
          ...(region === undefined ? {} : { region: region.id }),
          detail: 'normalization verdict has dangling identities or lacks its synchronous proof',
        })
      }
    }
  })
  return violations
})
