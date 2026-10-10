import * as ConcreteCleanup from './ConcreteCleanup.js'
import type * as OpaqueRealization from './OpaqueRealization.js'
import * as CleanupPlan from './CleanupPlan.js'
import type * as DeclarationIndex from './DeclarationIndex.js'
import * as ExecutionAffinity from './ExecutionAffinity.js'
import type * as ExecutionPackage from './ExecutionPackage.js'
import * as Tir from './Tir.js'
import * as Instances from './Instances.js'
import * as SetOf from './internal/SetOf.js'
import * as Layout from './Layout.js'
import * as LocalSharedOwnership from './LocalSharedOwnership.js'
import * as Mir from './Mir.js'
import * as MirVerification from './MirVerification.js'
import * as MovePath from './MovePath.js'
import * as Ownership from './Ownership.js'
import * as ProvisionalMir from './ProvisionalMir.js'
import type * as SourceSpan from './SourceSpan.js'
import * as Type from './Type.js'

/** Post-normalization MIR-local ownership facts for provisional complete-or-relay control. */

export type BorrowIdentity =
  | { readonly _tag: 'MirLoan'; readonly borrow: Tir.BorrowId }
  | { readonly _tag: 'BorrowedParameter'; readonly parameterOrdinal: number }
  | { readonly _tag: 'BorrowedLocal'; readonly local: Mir.LocalId }

export type Access =
  | { readonly _tag: 'Copy' }
  | {
      readonly _tag: 'BorrowedDependency'
      readonly access: 'Shared' | 'Exclusive'
      readonly root: Mir.LocalId
      readonly loan: BorrowIdentity
    }
  | { readonly _tag: 'AffineTransfer'; readonly cleanup: CleanupPlan.CleanupPlan }

export interface Slot {
  readonly ordinal: number
  readonly local: Mir.LocalId
  readonly type: Mir.Type
  readonly access: Access
  readonly executionAffinity: ExecutionAffinity.ExecutionAffinity
  readonly localSharedObligations: LocalSharedOwnership.ObligationPlan
  readonly initialization?: Mir.DropOperation['initialization']
}

export interface Release {
  readonly local: Mir.LocalId
  readonly cleanup: CleanupPlan.CleanupPlan
  readonly initialization?: Mir.DropOperation['initialization']
}

export interface ResumePlan {
  readonly restores: ReadonlyArray<number>
  readonly loanEnds: ReadonlyArray<BorrowIdentity>
  readonly releases: ReadonlyArray<Release>
}

export interface Plan {
  readonly _tag: 'SuspensionOwnershipPlan'
  readonly point: ProvisionalMir.ControlId
  readonly function: Instances.InstanceKey
  readonly region: Mir.RegionId
  /** Exact lowered call; one authored control may expand into several match-arm calls. */
  readonly operation: Mir.Operation
  readonly span: SourceSpan.SourceSpan
  readonly frame: 'StatefulRelay'
  readonly slots: ReadonlyArray<Slot>
  readonly invocationUses: ReadonlyArray<Mir.InvocationUseRetention>
  readonly success: ResumePlan
  readonly failure: ResumePlan
}

export interface Violation {
  readonly _tag: 'SuspensionOwnershipViolation'
  readonly function: Instances.InstanceKey
  readonly span: SourceSpan.SourceSpan
  readonly detail: string
}

export interface Module {
  readonly _tag: 'SuspensionOwnershipModule'
  readonly module: string
  readonly plans: ReadonlyArray<Plan>
  readonly executionPackages: ReadonlyArray<ExecutionPackageOwnershipPlan>
  readonly violations: ReadonlyArray<Violation>
}

/** One exact compiler-private package slot governed by the canonical ownership planner. */
export interface ExecutionPackageSlot {
  readonly ordinal: number
  readonly role: 'Body' | 'Endpoint' | 'Callback' | 'AllocationAuthority'
  readonly type: Type.Type
  readonly access: Extract<Access, { readonly _tag: 'AffineTransfer' }>
}

/** One terminal package cleanup branch; loans always end before referent cleanup. */
export interface ExecutionPackageCleanup {
  readonly loanEnds: ReadonlyArray<BorrowIdentity>
  readonly releases: ReadonlyArray<ExecutionPackageSlot>
  readonly allocationReleases: 1
}

/** Lifecycle cleanup facts for one exact independently owned package specialization. */
export interface ExecutionPackageOwnershipPlan {
  readonly _tag: 'ExecutionPackageOwnershipPlan'
  readonly package: ExecutionPackage.Plan
  readonly slots: ReadonlyArray<ExecutionPackageSlot>
  readonly logicalRoot: 'ExecutionOwnedPersistent'
  readonly restoration: 'UnstartedOrRelinquishedDrive'
  readonly allocation: 'CountedUntilFinalAuthority'
  readonly completion: ExecutionPackageCleanup
  readonly unstarted: ExecutionPackageCleanup
  readonly relinquished: ExecutionPackageCleanup
}

const executionPackagePlan = (
  index: DeclarationIndex.Index,
  package_: ExecutionPackage.Plan,
): ExecutionPackageOwnershipPlan => {
  const typed = [
    { role: 'Body' as const, type: package_.specialization.body },
    { role: 'Endpoint' as const, type: package_.specialization.endpoint },
    { role: 'Callback' as const, type: package_.specialization.callback },
    { role: 'AllocationAuthority' as const, type: Type.allocation },
  ]
  const slots: ReadonlyArray<ExecutionPackageSlot> = typed.map((slot, ordinal) => ({
    ...slot,
    ordinal,
    access: {
      _tag: 'AffineTransfer' as const,
      cleanup: CleanupPlan.cleanupPlan(index, slot.type),
    },
  }))
  const cleanup = (
    roles: ReadonlyArray<ExecutionPackageSlot['role']>,
  ): ExecutionPackageCleanup => ({
    loanEnds: [],
    releases: roles.flatMap((role) => slots.filter((slot) => slot.role === role)),
    allocationReleases: 1,
  })
  const completion = cleanup(['Callback', 'Endpoint', 'AllocationAuthority'])
  const retained = cleanup(['Callback', 'Endpoint', 'Body', 'AllocationAuthority'])
  return {
    _tag: 'ExecutionPackageOwnershipPlan',
    package: package_,
    slots,
    logicalRoot: 'ExecutionOwnedPersistent',
    restoration: 'UnstartedOrRelinquishedDrive',
    allocation: 'CountedUntilFinalAuthority',
    completion,
    unstarted: retained,
    relinquished: retained,
  }
}

const operationDefinitions = (operation: Mir.Operation): ReadonlySet<number> => {
  const definitions = new Set<number>()
  for (const nested of Mir.operationTree(operation)) {
    if ('destination' in nested && nested.destination !== undefined)
      definitions.add(nested.destination.ordinal)
    if (nested._tag === 'UnpackEffectComposite') definitions.add(nested.matched.ordinal)
    if (
      nested._tag === 'RunEffect' ||
      nested._tag === 'RunEffectValue' ||
      nested._tag === 'RunStaticEffect' ||
      nested._tag === 'CatchEffect'
    )
      definitions.add(nested.outcome.ordinal)
    if (nested._tag === 'CatchEffect') {
      definitions.add(nested.successValue.ordinal)
      definitions.add(nested.failureValue.ordinal)
    }
    if (nested._tag === 'Match')
      for (const arm of nested.arms)
        for (const binding of arm.bindings) definitions.add(binding.destination.ordinal)
  }
  return definitions
}

const withBorrowedRoots = (
  locals: Iterable<number>,
  borrowedRoots: ReadonlyMap<number, number>,
): Set<number> =>
  new Set(
    [...locals].flatMap((local) => {
      const root = borrowedRoots.get(local)
      return root === undefined ? [local] : [local, root]
    }),
  )

const operationInputs = (
  operation: Mir.Operation,
  borrowedRoots: ReadonlyMap<number, number>,
): ReadonlySet<number> => {
  const definitions = operationDefinitions(operation)
  const inputs = Mir.operationTree(operation)
    .flatMap((nested) =>
      nested._tag === 'Drop' &&
      !CleanupPlan.mayReadStorage(nested.cleanup, nested.initialization?.state)
        ? (nested.initialization?.flags.map((flag) => flag.local) ?? [])
        : MirVerification.operationLocals(nested).filter(
            // Propagation reads the payload from source and only metadata from outcome.
            // Diagnostic owners have dedicated frame fields; retaining the erased Effect
            // as ordinary value storage would invent a second owner and has no data layout.
            (local) =>
              nested._tag !== 'PropagateEffectFailure' || local.ordinal !== nested.outcome.ordinal,
          ),
    )
    .map((local) => local.ordinal)
  return new Set(
    [...withBorrowedRoots(inputs, borrowedRoots)].filter((local) => !definitions.has(local)),
  )
}

const transferOperation = (
  operation: Mir.Operation,
  liveAfter: ReadonlySet<number>,
  borrowedRoots: ReadonlyMap<number, number>,
): Set<number> => {
  const definitions = operationDefinitions(operation)
  return SetOf.union(
    operationInputs(operation, borrowedRoots),
    new Set([...liveAfter].filter((local) => !definitions.has(local))),
  )
}

const outcomeUses = (region: Mir.Region): ReadonlySet<number> => {
  if (region._tag === 'ConditionalRegion') return new Set([region.condition.ordinal])
  if (region._tag === 'LoopRegion') return new Set([region.conditionValue.ordinal])
  return region.outcome._tag === 'Return' ? new Set([region.outcome.value.ordinal]) : new Set()
}

const regionOperations = (region: Mir.Region): ReadonlyArray<Mir.Operation> => {
  if (region._tag === 'OperationRegion') {
    return region.operations
  }
  if (region._tag === 'CleanupRegion') {
    return region.releases
  }
  return []
}

const transferSequence = (
  operations: ReadonlyArray<Mir.Operation>,
  liveAfter: ReadonlySet<number>,
  borrowedRoots: ReadonlyMap<number, number>,
): Set<number> => {
  let live = withBorrowedRoots(liveAfter, borrowedRoots)
  for (let ordinal = operations.length - 1; ordinal >= 0; ordinal -= 1) {
    const operation = operations.at(ordinal)
    if (operation !== undefined) live = transferOperation(operation, live, borrowedRoots)
  }
  return live
}

const liveness = (fn: Mir.MirFunction): ReadonlyMap<Mir.Operation, ReadonlySet<number>> => {
  const definitions = definitionMap(fn)
  // A live reference keeps its referent storage live until its last use (including EndLoan).
  // Cleanup is independent: an owner without cleanup still needs storage while a child borrows it.
  const borrowedRoots = new Map(
    fn.localTypes.flatMap((type, ordinal) => {
      if (type._tag !== 'Reference' && type._tag !== 'Slice' && type._tag !== 'EnvironmentBorrow')
        return []
      const root = borrowOf(fn, definitions, { _tag: 'Local', ordinal }).root.ordinal
      return root === ordinal ? [] : [[ordinal, root] as const]
    }),
  )
  const liveAfter = new Map<Mir.Operation, ReadonlySet<number>>()
  const analyzeExecution = (
    execution: Pick<Mir.Execution, 'entry' | 'regions'>,
    following: ReadonlySet<number>,
  ): Set<number> => {
    const loops = new Map(
      Mir.regionsTree(execution.regions).flatMap((region) =>
        region._tag === 'LoopRegion' ? [[region.loop.ordinal, region] as const] : [],
      ),
    )
    const before = new Map<number, Set<number>>()
    const successors = (region: Mir.Region): ReadonlySet<number> => {
      if (region._tag === 'OperationRegion' || region._tag === 'CleanupRegion') {
        const outcome = region.outcome
        if (outcome._tag === 'Complete') return following
        if (outcome._tag === 'Return' || outcome._tag === 'Trap') return new Set()
        if (outcome._tag === 'Exit' || outcome._tag === 'Repeat') {
          const loop = loops.get(outcome.loop.ordinal)
          return loop === undefined
            ? following
            : (before.get((outcome._tag === 'Exit' ? loop.following : loop.condition).ordinal) ??
                new Set())
        }
        if (outcome._tag === 'Yield') {
          const loop = [...loops.values()].find(
            (loop) => loop.condition.ordinal === region.id.ordinal,
          )
          return loop === undefined
            ? following
            : SetOf.union(
                before.get(loop.body.ordinal) ?? new Set(),
                before.get(loop.following.ordinal) ?? new Set(),
              )
        }
      }
      return new Set(
        Mir.regionTargets(region).flatMap(([target]) => [...(before.get(target.ordinal) ?? [])]),
      )
    }
    let changed = true
    while (changed) {
      changed = false
      for (const region of [...Mir.topologicalRegions(execution)].reverse()) {
        const live = transferSequence(
          regionOperations(region),
          SetOf.union(successors(region), outcomeUses(region)),
          borrowedRoots,
        )
        if (!SetOf.equal(live, before.get(region.id.ordinal) ?? new Set())) {
          before.set(region.id.ordinal, live)
          changed = true
        }
      }
    }
    for (const region of Mir.topologicalRegions(execution))
      analyzeSequence(
        regionOperations(region),
        SetOf.union(successors(region), outcomeUses(region)),
      )
    return before.get(execution.entry.ordinal) ?? new Set()
  }
  const analyzeSequence = (
    operations: ReadonlyArray<Mir.Operation>,
    following: ReadonlySet<number>,
  ): Set<number> => {
    let live = withBorrowedRoots(following, borrowedRoots)
    for (let ordinal = operations.length - 1; ordinal >= 0; ordinal -= 1) {
      const operation = operations.at(ordinal)
      if (operation === undefined) continue
      liveAfter.set(operation, new Set(live))
      if (operation._tag === 'Match') {
        const outer = new Set(
          [...live].filter((local) => !operationDefinitions(operation).has(local)),
        )
        for (const arm of operation.arms) {
          const selected = analyzeExecution(
            arm.selected.execution,
            SetOf.union(
              outer,
              new Set(
                arm.selected.execution.result === undefined
                  ? []
                  : [arm.selected.execution.result.ordinal],
              ),
            ),
          )
          if (arm.guard !== undefined)
            analyzeExecution(
              arm.guard.execution,
              SetOf.union(
                selected,
                new Set(
                  arm.guard.execution.result === undefined
                    ? []
                    : [arm.guard.execution.result.ordinal],
                ),
              ),
            )
        }
      } else if (operation._tag === 'DiagnosticScope') {
        const outer = new Set(
          [...live].filter((local) => !operationDefinitions(operation).has(local)),
        )
        outer.add(operation.state.ordinal)
        outer.add(operation.observer.ordinal)
        if (operation.body.result !== undefined) outer.add(operation.body.result.ordinal)
        analyzeExecution(operation.body, outer)
      } else if (operation._tag === 'Conditional') {
        const outer = new Set(
          [...live].filter((local) => !operationDefinitions(operation).has(local)),
        )
        for (const branch of [operation.taken, operation.otherwise])
          analyzeExecution(
            branch,
            SetOf.union(outer, new Set(branch.result === undefined ? [] : [branch.result.ordinal])),
          )
      } else if (operation._tag === 'ShortCircuit') {
        const outer = new Set(
          [...live].filter((local) => !operationDefinitions(operation).has(local)),
        )
        analyzeExecution(
          operation.right,
          SetOf.union(
            outer,
            new Set(operation.right.result === undefined ? [] : [operation.right.result.ordinal]),
          ),
        )
      }
      live = transferOperation(operation, live, borrowedRoots)
    }
    return live
  }

  analyzeExecution(fn, new Set())
  return liveAfter
}

const definitionMap = (fn: Mir.MirFunction): ReadonlyMap<number, Mir.Operation> =>
  new Map(
    MirVerification.operations(fn).flatMap((operation) => [
      ...('destination' in operation ? [[operation.destination.ordinal, operation] as const] : []),
      ...(operation._tag === 'Match'
        ? operation.arms.flatMap((arm) =>
            arm.bindings
              .filter((binding) => binding.type._tag === 'EnvironmentBorrow')
              .map((binding) => [binding.destination.ordinal, operation] as const),
          )
        : []),
    ]),
  )

const borrowOf = (
  fn: Mir.MirFunction,
  definitions: ReadonlyMap<number, Mir.Operation>,
  local: Mir.LocalId,
  seen = new Set<number>(),
): Extract<Access, { readonly _tag: 'BorrowedDependency' }> => {
  const type = fn.localTypes.at(local.ordinal)
  let access: Type.BorrowAccess
  if (type?._tag === 'EnvironmentBorrow') {
    access = type.access
  } else if (type?._tag === 'Reference' || type?._tag === 'Slice') {
    access = type.type.access
  } else {
    access = 'Shared'
  }
  if (
    (type?._tag !== 'Reference' && type?._tag !== 'Slice' && type?._tag !== 'EnvironmentBorrow') ||
    seen.has(local.ordinal)
  )
    return {
      _tag: 'BorrowedDependency',
      access,
      root: local,
      loan: { _tag: 'BorrowedLocal', local },
    }
  const next = new Set(seen).add(local.ordinal)
  const definition = definitions.get(local.ordinal)
  if (definition?._tag === 'Match') {
    const parent = borrowOf(fn, definitions, definition.scrutinee, next)
    return { ...parent, access }
  }
  if (definition?._tag === 'BeginLoan') {
    const parent = borrowOf(fn, definitions, definition.root, next)
    return {
      _tag: 'BorrowedDependency',
      access: definition.access,
      root: parent.root,
      loan: { _tag: 'MirLoan', borrow: definition.borrow },
    }
  }
  if (
    definition?._tag === 'Move' ||
    definition?._tag === 'ConvertUnion' ||
    definition?._tag === 'Project'
  )
    return borrowOf(fn, definitions, definition.source, next)
  if (local.ordinal < fn.parameterCount)
    return {
      _tag: 'BorrowedDependency',
      access,
      root: local,
      loan: { _tag: 'BorrowedParameter', parameterOrdinal: local.ordinal },
    }
  return {
    _tag: 'BorrowedDependency',
    access,
    root: local,
    loan: { _tag: 'BorrowedLocal', local },
  }
}

const releasesOf = (operation: Mir.Operation): ReadonlyArray<Release> =>
  operation._tag === 'RunEffect' ||
  operation._tag === 'RunEffectValue' ||
  operation._tag === 'RunStaticEffect'
    ? (operation.releases ?? []).map((release) => ({
        local: release.local,
        cleanup: release.cleanup,
        initialization: release.initialization,
      }))
    : []

const accessOf = (
  program: Mir.Module,
  index: DeclarationIndex.Index,
  fn: Mir.MirFunction,
  definitions: ReadonlyMap<number, Mir.Operation>,
  local: Mir.LocalId,
  type: Mir.Type,
  opaqueRealizations: OpaqueRealization.Catalog,
): Access => {
  if (type._tag === 'Reference' || type._tag === 'Slice' || type._tag === 'EnvironmentBorrow') {
    return borrowOf(fn, definitions, local)
  }
  if (Mir.isCopy(program.layout, Mir.semanticType(type))) {
    return { _tag: 'Copy' }
  }
  return {
    _tag: 'AffineTransfer',
    cleanup: ConcreteCleanup.forLocal(
      { index, layout: program.layout, opaqueRealizations, semantic: (type) => type },
      type,
    ),
  }
}

const affinityOf = (
  index: DeclarationIndex.Index,
  fn: Mir.MirFunction,
  type: Mir.Type,
  access: Access,
): ExecutionAffinity.ExecutionAffinity => {
  let retained: ExecutionAffinity.ExecutionAffinity
  if (type._tag === 'EffectValue') {
    retained = ExecutionAffinity.ofEnvironment(
      index,
      type.environment.fields.map((field) => ({ type: field.type })),
    )
  } else if (type._tag === 'CallableValue' && type.environment !== undefined) {
    retained = ExecutionAffinity.ofEnvironment(
      index,
      type.environment.fields.map((field) => ({ type: field.type })),
    )
  } else {
    retained = ExecutionAffinity.ofType(index, Mir.semanticType(type))
  }
  if (access._tag !== 'BorrowedDependency') return retained
  const root = fn.localTypes.at(access.root.ordinal)
  return root === undefined
    ? retained
    : ExecutionAffinity.join([retained, ExecutionAffinity.ofType(index, Mir.semanticType(root))])
}

const obligationsOf = (
  index: DeclarationIndex.Index,
  type: Mir.Type,
): LocalSharedOwnership.ObligationPlan => {
  if (type._tag === 'EffectValue') {
    return LocalSharedOwnership.ofEnvironment(
      index,
      type.environment.fields.map((field) => ({ access: field.access, type: field.type })),
    )
  }
  if (type._tag === 'CallableValue' && type.environment !== undefined) {
    return LocalSharedOwnership.ofEnvironment(
      index,
      type.environment.fields.map((field) => ({ access: field.access, type: field.type })),
    )
  }
  return LocalSharedOwnership.ofType(index, Mir.semanticType(type))
}

const planFor = (
  program: Mir.Module,
  index: DeclarationIndex.Index,
  fn: Mir.MirFunction,
  region: Mir.Region,
  operation: Mir.Operation,
  live: ReadonlySet<number>,
  control: ProvisionalMir.RunControl,
  opaqueRealizations: OpaqueRealization.Catalog,
): Plan | undefined => {
  const definitions = definitionMap(fn)
  const operationDefined = operationDefinitions(operation)
  const states = MirVerification.initializationOf(fn, program.layout).before.get(operation)
  const flagsByRoot = new Map(
    (fn.initializationFlags ?? []).map((entry) => [entry.root.ordinal, entry.flags]),
  )
  const initializationOf = (ordinal: number): Mir.DropOperation['initialization'] => {
    const state = states?.get(ordinal)
    if (
      state === undefined ||
      (state.initialization === 'Initialized' && state.children.length === 0)
    )
      return undefined
    const required = new Set(MovePath.conditionalPaths(state).map(MovePath.key))
    return {
      state,
      flags: (flagsByRoot.get(ordinal) ?? []).filter((flag) =>
        required.has(MovePath.key(flag.path)),
      ),
    }
  }
  const retained = new Set(live)
  const holders = [
    ...MirVerification.operationLocals(operation).filter(
      (local) => !operationDefined.has(local.ordinal),
    ),
    ...[...live].map((ordinal): Mir.LocalId => ({ _tag: 'Local', ordinal })),
  ]
  const invocationUses = MirVerification.invocationRetentions(fn, program, holders).retentions
  for (const retention of invocationUses)
    for (const dependency of [...retention.dependencies, ...retention.environment])
      for (const referent of dependency.referents) retained.add(referent.root.ordinal)

  if ('cancellationFinalizer' in operation && operation.cancellationFinalizer !== undefined) {
    if (operation.cancellationFinalizer._tag === 'EffectCancellationFinalizer')
      retained.add(operation.cancellationFinalizer.effect.ordinal)
    else {
      retained.add(operation.cancellationFinalizer.resource.ordinal)
      retained.add(operation.cancellationFinalizer.release.ordinal)
    }
    for (const argument of operation.cancellationFinalizer.arguments) retained.add(argument.ordinal)
  }
  // A suspended child still uses its borrowed captures even when the parent never
  // reads them again. Follow represented environments to the actual referents;
  // retaining only locals live after the run leaves these pointers on the stack.
  const visited = new Set<number>()
  const retainReferents = (local: Mir.LocalId): void => {
    if (visited.has(local.ordinal)) return
    visited.add(local.ordinal)
    const type = fn.localTypes.at(local.ordinal)
    if (
      type?._tag === 'Reference' ||
      type?._tag === 'Slice' ||
      type?._tag === 'EnvironmentBorrow'
    ) {
      const root = borrowOf(fn, definitions, local).root
      if (root.ordinal !== local.ordinal) retained.add(root.ordinal)
    }
    const definition = definitions.get(local.ordinal)
    if (definition?._tag === 'MakeEffect' || definition?._tag === 'MakeCallable') {
      if (definition._tag === 'MakeCallable' && definition.base !== undefined)
        retainReferents(definition.base)
      for (const [ordinal, capture] of definition.captures.entries()) {
        const borrowsStorage =
          definition._tag === 'MakeEffect'
            ? definition.type.environment.fields.at(ordinal)?.representation === 'Borrow'
            : capture.access === 'Shared' || capture.access === 'Exclusive'
        if (borrowsStorage) retained.add(borrowOf(fn, definitions, capture.source).root.ordinal)
        retainReferents(capture.source)
      }
    } else if (
      definition?._tag === 'Move' ||
      definition?._tag === 'Project' ||
      definition?._tag === 'ConvertUnion' ||
      definition?._tag === 'PackEffectComposite' ||
      definition?._tag === 'UnpackEffectComposite'
    ) {
      retainReferents(definition.source)
    }
  }
  for (const local of MirVerification.operationLocals(operation))
    if (!operationDefined.has(local.ordinal)) retainReferents(local)
  for (const ordinal of live) retainReferents({ _tag: 'Local', ordinal })
  for (const ordinal of retained)
    for (const flag of initializationOf(ordinal)?.flags ?? []) retained.add(flag.local.ordinal)
  const slots: ReadonlyArray<Slot> = [...retained]
    .filter((ordinal) => !operationDefined.has(ordinal))
    .sort((left, right) => left - right)
    .flatMap((ordinal) => {
      const type = fn.localTypes.at(ordinal)
      if (type === undefined) return []
      const local = { _tag: 'Local' as const, ordinal }
      const access = accessOf(program, index, fn, definitions, local, type, opaqueRealizations)
      const executionAffinity = affinityOf(index, fn, type, access)
      const localSharedObligations = obligationsOf(index, type)
      let runtimeLanes: ReturnType<typeof Layout.effectEnvironmentLanes>
      if (type._tag === 'EffectValue') {
        runtimeLanes = Layout.effectEnvironmentLanes(program.layout, type.environment)
      } else if (type._tag === 'CallableValue') {
        if (type.environment === undefined) {
          runtimeLanes = []
        } else {
          runtimeLanes = Layout.callableEnvironmentLanes(program.layout, type.environment)
        }
      } else {
        runtimeLanes = Layout.callingShape(program.layout, Mir.semanticType(type))?.lanes ?? []
      }
      if (
        runtimeLanes.length === 0 &&
        executionAffinity._tag === 'Unrestricted' &&
        localSharedObligations._tag === 'NoLocalSharedObligation'
      )
        return []
      return [
        {
          ordinal: 0,
          local,
          type,
          access,
          executionAffinity,
          localSharedObligations,
          initialization: initializationOf(ordinal),
        },
      ]
    })
    .map((slot, ordinal) => ({ ...slot, ordinal }))
  const releases = releasesOf(operation)
  const borrowed = slots.filter(
    (
      slot,
    ): slot is Slot & {
      readonly access: Extract<Access, { readonly _tag: 'BorrowedDependency' }>
    } => slot.access._tag === 'BorrowedDependency',
  )
  const affine = slots.filter(
    (
      slot,
    ): slot is Slot & { readonly access: Extract<Access, { readonly _tag: 'AffineTransfer' }> } =>
      slot.access._tag === 'AffineTransfer',
  )
  const affineReleases = affine
    .filter((slot) => !releases.some((release) => release.local.ordinal === slot.local.ordinal))
    .map((slot) => ({
      local: slot.local,
      cleanup: slot.access.cleanup,
      initialization: slot.initialization,
      ordinal: slot.local.ordinal,
    }))
  // The returned child/holder owns transferred payloads. Only external referents get extra slots.
  // Its cleanup precedes those owners, including cancellation before the child has completed.
  const unorderedReleases = [...releases, ...Ownership.inReleaseOrder(affineReleases)]
  const releaseOrder = MirVerification.invocationReleaseOrder(invocationUses, unorderedReleases)
  if (releaseOrder === undefined) return undefined
  const loanEnds = Ownership.inReleaseOrder(borrowed).map((slot) => slot.access.loan)
  return {
    _tag: 'SuspensionOwnershipPlan',
    point: control.id,
    function: fn.instance,
    region: region.id,
    operation,
    span: operation.provenance.span,
    // Every suspendable invocation owns one frame. Header-only states are retained because even a
    // final `run` may adapt the child's represented Effect outcome to the caller's result shape.
    frame: 'StatefulRelay',
    slots,
    invocationUses,
    success: {
      restores: slots.map((slot) => slot.ordinal),
      loanEnds: [],
      releases: [],
    },
    failure: { restores: [], loanEnds, releases: releaseOrder },
  }
}

const comparePlan = (left: Plan, right: Plan): number =>
  Instances.keyText(left.function).localeCompare(Instances.keyText(right.function)) ||
  left.span.sourceId.localeCompare(right.span.sourceId) ||
  left.span.start - right.span.start ||
  left.point.ordinal - right.point.ordinal

/** Plans exact post-normalization local ownership for every matched complete-or-relay control. */
export const plan = (
  program: Mir.Module,
  provisional: ProvisionalMir.Module,
  index: DeclarationIndex.Index,
  opaqueRealizations: OpaqueRealization.Catalog,
): Module => {
  const plans: Array<Plan> = []
  const violations: Array<Violation> = []
  for (const fn of program.functions) {
    // Most functions have no relay control. Their fixed-point liveness cannot contribute a plan.
    let live: ReturnType<typeof liveness> | undefined
    for (const region of fn.regions) {
      for (const operation of regionOperations(region).flatMap(Mir.operationTree)) {
        if (
          operation._tag !== 'RunEffect' &&
          operation._tag !== 'RunEffectValue' &&
          operation._tag !== 'CatchEffect' &&
          operation._tag !== 'ExecutionRelinquish'
        )
          continue
        if (
          ProvisionalMir.classificationOfRun(
            provisional,
            fn.instance,
            operation.provenance.span,
          ) === 'Synchronous'
        )
          continue
        const control = ProvisionalMir.controlOfRun(
          provisional,
          fn.instance,
          operation.provenance.span,
        )
        if (control === undefined) {
          violations.push({
            _tag: 'SuspensionOwnershipViolation',
            function: fn.instance,
            span: operation.provenance.span,
            detail: 'suspendable MIR run has no exact provisional control',
          })
          continue
        }
        live ??= liveness(fn)
        const retainedInputs = MirVerification.invocationRetentions(fn, program, [
          ...MirVerification.operationLocals(operation).filter(
            (local) => !operationDefinitions(operation).has(local.ordinal),
          ),
          ...[...(live.get(operation) ?? [])].map((ordinal): Mir.LocalId => ({
            _tag: 'Local',
            ordinal,
          })),
        ])
        const invocationIssues = [
          ...MirVerification.invocationUseIssues(fn, program),
          ...retainedInputs.issues,
        ]
        if (invocationIssues.length > 0) {
          violations.push(
            ...invocationIssues.map((issue): Violation => ({
              _tag: 'SuspensionOwnershipViolation',
              function: fn.instance,
              span: issue.operation.provenance.span,
              detail: issue.detail,
            })),
          )
          continue
        }
        const planned = planFor(
          program,
          index,
          fn,
          region,
          operation,
          live.get(operation) ?? new Set(),
          control,
          opaqueRealizations,
        )
        if (planned === undefined) {
          violations.push({
            _tag: 'SuspensionOwnershipViolation',
            function: fn.instance,
            span: operation.provenance.span,
            detail: 'invocation input cleanup dependencies are cyclic or duplicate',
          })
          continue
        }
        const assignedFlags = MirVerification.initializationOf(fn, program.layout).flagsBefore.get(
          operation,
        )
        if (
          planned.slots.some(
            (slot) =>
              slot.initialization !== undefined &&
              (MovePath.conditionalPaths(slot.initialization.state).length !==
                slot.initialization.flags.length ||
                slot.initialization.flags.some(
                  (flag) =>
                    !assignedFlags?.has(flag.local.ordinal) ||
                    !planned.slots.some(
                      (retained) => retained.local.ordinal === flag.local.ordinal,
                    ),
                )),
          )
        ) {
          violations.push({
            _tag: 'SuspensionOwnershipViolation',
            function: fn.instance,
            span: operation.provenance.span,
            detail:
              'suspended partial ownership requires every conditional initialization flag to be assigned and retained',
          })
          continue
        }
        plans.push(planned)
      }
    }
  }
  return {
    _tag: 'SuspensionOwnershipModule',
    module: program.module,
    plans: plans.sort(comparePlan),
    executionPackages: program.layout.executionPackages.plans.map((package_) =>
      executionPackagePlan(index, package_),
    ),
    violations: violations,
  }
}

const borrowText = (borrow: BorrowIdentity): string => {
  if (borrow._tag === 'MirLoan') {
    return `loan:${Tir.borrowKey(borrow.borrow)}`
  }
  if (borrow._tag === 'BorrowedParameter') {
    return `parameter:${borrow.parameterOrdinal}`
  }
  return `local:${borrow.local.ordinal}`
}

/** Deterministic inspection encoding used by fresh-lowering tests. */
export const encode = (self: Module): string =>
  [
    `suspension-ownership ${self.module}`,
    ...self.plans.flatMap((plan_) => [
      `plan ${Instances.keyText(plan_.function)}@${plan_.span.sourceId}:${plan_.span.start}:${plan_.point.ordinal} frame=${plan_.frame.toLowerCase()}`,
      ...plan_.slots.map((slot) => {
        if (slot.access._tag === 'Copy') {
          return `  slot ${slot.ordinal} %${slot.local.ordinal} copy ${Type.encode(Mir.semanticType(slot.type))} affinity=${ExecutionAffinity.encode(slot.executionAffinity)} obligations=${LocalSharedOwnership.encode(slot.localSharedObligations)}`
        }
        if (slot.access._tag === 'BorrowedDependency') {
          return `  slot ${slot.ordinal} %${slot.local.ordinal} borrow:${slot.access.access.toLowerCase()} root=%${slot.access.root.ordinal} ${borrowText(slot.access.loan)} ${Type.encode(Mir.semanticType(slot.type))} affinity=${ExecutionAffinity.encode(slot.executionAffinity)} obligations=${LocalSharedOwnership.encode(slot.localSharedObligations)}`
        }
        return `  slot ${slot.ordinal} %${slot.local.ordinal} move:${slot.access.cleanup._tag} ${Type.encode(Mir.semanticType(slot.type))} affinity=${ExecutionAffinity.encode(slot.executionAffinity)} obligations=${LocalSharedOwnership.encode(slot.localSharedObligations)}`
      }),
    ]),
    ...self.executionPackages.flatMap((plan_) => [
      `execution-package ${plan_.package.provenance} slots=${plan_.slots.length} allocation-releases=1 root=${plan_.logicalRoot.toLowerCase()} restore=${plan_.restoration.toLowerCase()} allocation=${plan_.allocation.toLowerCase()}`,
      ...plan_.slots.map(
        (slot) =>
          `  package-slot ${slot.ordinal} ${slot.role.toLowerCase()} move:${slot.access.cleanup._tag} ${Type.encode(slot.type)}`,
      ),
      `  cleanup completion=${plan_.completion.releases.map((slot) => slot.role.toLowerCase()).join('>')} unstarted=${plan_.unstarted.releases.map((slot) => slot.role.toLowerCase()).join('>')} relinquished=${plan_.relinquished.releases.map((slot) => slot.role.toLowerCase()).join('>')}`,
    ]),
    ...self.violations.map(
      (violation) =>
        `violation ${Instances.keyText(violation.function)}@${violation.span.sourceId}:${violation.span.start} ${violation.detail}`,
    ),
    '',
  ].join('\n')
