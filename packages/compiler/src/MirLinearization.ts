import type { ControlProvenance } from './Backend.js'
import type * as DeclarationFacts from './DeclarationFacts.js'
import type * as Layout from './Layout.js'
import * as Match from './Match.js'
import * as Mir from './Mir.js'

export type LinearTerminator =
  | { readonly _tag: 'Return'; readonly value: Mir.LocalId; readonly provenance: Mir.Provenance }
  | Extract<Mir.Operation, { readonly _tag: 'PropagateEffectFailure' }>
  | { readonly _tag: 'Jump'; readonly target: Mir.RegionId; readonly provenance: Mir.Provenance }
  | {
      readonly _tag: 'Branch'
      readonly condition: Mir.LocalId
      readonly taken: Mir.RegionId
      readonly otherwise: Mir.RegionId
      readonly provenance: Mir.Provenance
    }
  | {
      readonly _tag: 'MatchBranch'
      readonly scrutinee: Mir.LocalId
      readonly selectors?: ReadonlyArray<Mir.PlaceSelector>
      readonly shape: Layout.CallingShape
      readonly member: Match.CoverageIdentity
      readonly taken: Mir.RegionId
      readonly otherwise: Mir.RegionId
      readonly provenance: Mir.Provenance
    }
  | {
      readonly _tag: 'EnumMatchBranch'
      readonly scrutinee: Mir.LocalId
      readonly selectors?: ReadonlyArray<Mir.PlaceSelector>
      readonly discriminant: bigint
      readonly type: Extract<Mir.Type, { readonly _tag: 'Enum' }>
      readonly representation: Extract<Layout.Representation, { readonly _tag: 'ScalarEnum' }>
      readonly taken: Mir.RegionId
      readonly otherwise: Mir.RegionId
      readonly provenance: Mir.Provenance
    }
  | { readonly _tag: 'Trap'; readonly reason: string; readonly provenance: Mir.Provenance }

export type LinearOperation =
  | Exclude<
      Mir.Operation,
      {
        readonly _tag:
          | 'Match'
          | 'Conditional'
          | 'ShortCircuit'
          | 'CheckedScalar'
          | 'DiagnosticScope'
          | 'PropagateEffectFailure'
      }
    >
  | {
      readonly _tag: 'EnterDiagnosticScope'
      /** Stable function-local identity shared with the matching leave operation. */
      readonly scope: Mir.LocalId
      readonly state: Mir.LocalId
      readonly observer: Mir.LocalId
      readonly provenance: Mir.Provenance
    }
  | {
      readonly _tag: 'LeaveDiagnosticScope'
      readonly scope: Mir.LocalId
      readonly provenance: Mir.Provenance
    }
  | {
      /** Successful selected recovery consumes the protected outcome before later source work. */
      readonly _tag: 'ReleaseDiagnosticOutcome'
      readonly outcome: Mir.LocalId
      readonly provenance: Mir.Provenance
    }
  | {
      readonly _tag: 'CheckedScalarOutcome'
      readonly operation: Extract<Mir.Operation, { readonly _tag: 'CheckedScalar' }>['operation']
      readonly valid: Mir.LocalId
      readonly value: Mir.LocalId
      readonly operands: ReadonlyArray<Mir.LocalId>
      readonly sourceType: Mir.ScalarType
      readonly valueType: Mir.ScalarType
      readonly provenance: Mir.Provenance
    }
  | {
      readonly _tag: 'BindMatch'
      readonly scrutinee: Mir.LocalId
      readonly selectors?: ReadonlyArray<Mir.PlaceSelector>
      readonly shape: Layout.CallingShape
      readonly member: Match.CoverageIdentity
      readonly destination: Mir.LocalId
      readonly path: ReadonlyArray<DeclarationFacts.FieldId>
      readonly type: Mir.Type
      readonly provenance: Mir.Provenance
    }

export const isLinearOperation = (
  operation: Mir.Operation | LinearOperation,
): operation is LinearOperation =>
  operation._tag !== 'Match' &&
  operation._tag !== 'Conditional' &&
  operation._tag !== 'ShortCircuit' &&
  operation._tag !== 'CheckedScalar' &&
  operation._tag !== 'DiagnosticScope' &&
  operation._tag !== 'PropagateEffectFailure'

export const linearOperations = (
  operations: ReadonlyArray<Mir.Operation | LinearOperation>,
): ReadonlyArray<LinearOperation> => {
  const linear = operations.filter(isLinearOperation)
  if (linear.length !== operations.length)
    throw new RangeError('LLVM control expansion retained a structured operation')
  return linear
}

export interface LinearBlock {
  readonly id: Mir.RegionId
  readonly origin: Mir.RegionId
  readonly kind: 'Normal' | 'Cleanup'
  readonly operations: ReadonlyArray<LinearOperation>
  readonly terminator: LinearTerminator
  /** Lexically active selected failures, outermost first; payload values remain separate. */
  readonly recoveryOutcomes?: ReadonlyArray<Mir.LocalId>
  /** Observation that clears any cause inherited by this function before these local scopes. */
  readonly recoveryBoundary?: Mir.LocalId
}

export interface StructuredBlock {
  readonly id: Mir.RegionId
  readonly origin: Mir.RegionId
  readonly kind: 'Normal' | 'Cleanup'
  readonly operations: ReadonlyArray<Mir.Operation>
  readonly terminator: LinearTerminator
}

export const destinationOf = (operation: LinearOperation): Mir.LocalId | undefined => {
  switch (operation._tag) {
    case 'SetInitialized':
      return operation.flag
    case 'Literal':
    case 'EnumConstant':
    case 'EnumValue':
    case 'EnumEquality':
    case 'StaticString':
    case 'StringFromUtf8Unchecked':
    case 'StringUtf8Bytes':
    case 'StringByteLength':
    case 'StringEqualsExact':
    case 'Binary':
    case 'ConvertInteger':
    case 'Move':
    case 'BeginLoan':
    case 'SliceLength':
    case 'ConvertUnion':
    case 'Call':
    case 'MakeEffect':
    case 'MakeCallable':
    case 'ApplyCallable':
    case 'PackEffectOutcome':
    case 'PackEffectFailureUnion':
    case 'UnpackEffectSuccess':
    case 'RunEffect':
    case 'RunEffectValue':
    case 'RunStaticEffect':
    case 'CatchEffect':
    case 'Construct':
    case 'ConstructUnionVariant':
    case 'ConstructArray':
    case 'Project':
    case 'ReadPlace':
    case 'ValidateLayout':
    case 'RepeatLayout':
    case 'Allocate':
    case 'NativeAssembly':
    case 'ForeignIndirectCall':
    case 'ForeignCall':
    case 'RawBufferFrom':
    case 'SharedFromAllocation':
    case 'ExecutionFromAllocation':
    case 'ExecutionDrive':
    case 'ExecutionRelinquish':
    case 'ExecutionCurrent':
    case 'ExecutionRefOf':
    case 'ExecutionLoad':
    case 'ExecutionStore':
    case 'ExecutionNotify':
    case 'ExecutionLive':
    case 'SharedClone':
    case 'SharedWithMut':
    case 'RawBufferCount':
    case 'RawBufferSlot':
    case 'RawBufferRead':
    case 'SliceView':
    case 'RawBufferView':
    case 'RawBufferCopy':
    case 'RawBufferFill':
    case 'PointerNull':
    case 'DiagnosticUnhandled':
    case 'PointerAddress':
    case 'PointerIsNull':
    case 'PointerBytes':
    case 'PointerReinterpret':
    case 'PointerRequalify':
    case 'PointerFromStorage':
    case 'PointerAt':
    case 'PointerRead':
    case 'PointerWrite':
    case 'SlotWrite':
    case 'SlotTake':
    case 'SlotCopy':
    case 'SlotDrop':
      return operation.destination
    case 'CheckedScalarOutcome':
      return operation.value
    case 'BindMatch':
      return operation.destination
    case 'CheckPlace':
    case 'WritePlace':
    case 'EndLoan':
    case 'Drop':
    case 'EnterDiagnosticScope':
    case 'LeaveDiagnosticScope':
    case 'ReleaseDiagnosticOutcome':
      return undefined
  }
}

export const opensRuntimeContinuation = (operation: LinearOperation): boolean =>
  operation._tag === 'Allocate' ||
  operation._tag === 'RawBufferFrom' ||
  operation._tag === 'SharedFromAllocation' ||
  operation._tag === 'ExecutionFromAllocation' ||
  operation._tag === 'ExecutionDrive' ||
  operation._tag === 'ExecutionRelinquish' ||
  operation._tag === 'ExecutionCurrent' ||
  operation._tag === 'ExecutionRefOf' ||
  operation._tag === 'ExecutionLoad' ||
  operation._tag === 'ExecutionStore' ||
  operation._tag === 'ExecutionNotify' ||
  operation._tag === 'ExecutionLive' ||
  operation._tag === 'SharedClone' ||
  operation._tag === 'SharedWithMut' ||
  operation._tag === 'RawBufferSlot' ||
  operation._tag === 'RawBufferRead' ||
  operation._tag === 'SliceView' ||
  operation._tag === 'RawBufferView' ||
  operation._tag === 'RawBufferCopy' ||
  operation._tag === 'RawBufferFill' ||
  operation._tag === 'RunEffect' ||
  operation._tag === 'RunEffectValue' ||
  operation._tag === 'RunEffectComposite' ||
  operation._tag === 'RunStaticEffect' ||
  operation._tag === 'CatchEffect' ||
  (operation._tag === 'Binary' &&
    operation.operator !== 'Equals' &&
    operation.operator !== 'NotEquals' &&
    operation.operator !== 'LessThan' &&
    operation.operator !== 'LessOrEqual' &&
    operation.operator !== 'GreaterThan' &&
    operation.operator !== 'GreaterOrEqual') ||
  ((operation._tag === 'BeginLoan' ||
    operation._tag === 'ReadPlace' ||
    operation._tag === 'CheckPlace' ||
    operation._tag === 'WritePlace') &&
    operation.selectors.some(
      (selector) =>
        selector._tag === 'SliceElementSelector' ||
        (selector._tag === 'ElementSelector' && selector.index._tag === 'Runtime'),
    ))

export const expandMatches = (
  fn: Mir.MirFunction,
  input: ReadonlyArray<StructuredBlock>,
): ReadonlyArray<LinearBlock> => {
  let nextRegion =
    Math.max(-1, ...Mir.regionsTree(fn.regions).map((region) => region.id.ordinal)) + 1
  const reserve = (): Mir.RegionId => ({ _tag: 'Region', ordinal: nextRegion++ })
  const blocks: Array<LinearBlock> = []
  let activeRecoveryOutcomes: ReadonlyArray<Mir.LocalId> = []
  let activeRecoveryBoundary: Mir.LocalId | undefined
  const append = (block: LinearBlock): void => {
    blocks.push(
      activeRecoveryOutcomes.length === 0 && activeRecoveryBoundary === undefined
        ? block
        : {
            ...block,
            recoveryOutcomes: activeRecoveryOutcomes,
            ...(activeRecoveryBoundary === undefined
              ? {}
              : { recoveryBoundary: activeRecoveryBoundary }),
          },
    )
  }
  const jump = (target: Mir.RegionId, provenance: Mir.Provenance): LinearTerminator => ({
    _tag: 'Jump',
    target,
    provenance,
  })

  let activeTargets = new Map(fn.regions.map((region) => [region.id.ordinal, region.id] as const))
  let activeLoops = new Map(
    fn.regions.flatMap((region) =>
      region._tag === 'LoopRegion' ? [[region.loop.ordinal, region] as const] : [],
    ),
  )
  const emitExecution = (
    execution: Mir.Execution,
    completionOperations: ReadonlyArray<LinearOperation>,
    completion: LinearTerminator,
    observationBoundary?: Mir.LocalId,
  ): Mir.RegionId => {
    const previousTargets = activeTargets
    const previousLoops = activeLoops
    const previousRecoveryOutcomes = activeRecoveryOutcomes
    const previousRecoveryBoundary = activeRecoveryBoundary
    if (observationBoundary !== undefined) {
      activeRecoveryOutcomes = []
      activeRecoveryBoundary = observationBoundary
    }
    if (execution.recoveryOutcome !== undefined)
      activeRecoveryOutcomes = [...activeRecoveryOutcomes, execution.recoveryOutcome]
    activeTargets = new Map(activeTargets)
    activeLoops = new Map(activeLoops)
    for (const region of execution.regions) {
      activeTargets.set(region.id.ordinal, reserve())
      if (region._tag === 'LoopRegion') activeLoops.set(region.loop.ordinal, region)
    }
    const target = (id: Mir.RegionId): Mir.RegionId => activeTargets.get(id.ordinal) ?? id
    const entry = target(execution.entry)
    for (const region of execution.regions) {
      const id = target(region.id)
      if (region._tag === 'ConditionalRegion') {
        append({
          id,
          origin: region.id,
          kind: 'Normal',
          operations: [],
          terminator: {
            _tag: 'Branch',
            condition: region.condition,
            taken: target(region.taken),
            otherwise: target(region.otherwise),
            provenance: region.provenance,
          },
        })
        continue
      }
      if (region._tag === 'LoopRegion') {
        append({
          id,
          origin: region.id,
          kind: 'Normal',
          operations: [],
          terminator: jump(target(region.condition), region.provenance),
        })
        continue
      }
      const outcome = region.outcome
      let terminator: LinearTerminator
      if (outcome._tag === 'Complete') terminator = completion
      else if (outcome._tag === 'Forward')
        terminator = jump(target(outcome.target), outcome.provenance)
      else if (outcome._tag === 'Return' || outcome._tag === 'Trap') terminator = outcome
      else if (outcome._tag === 'Exit' || outcome._tag === 'Repeat') {
        const loop = activeLoops.get(outcome.loop.ordinal)
        if (loop === undefined) throw new RangeError('Nested execution lost its lexical loop')
        terminator = jump(
          target(outcome._tag === 'Exit' ? loop.following : loop.id),
          outcome.provenance,
        )
      } else {
        const loop = [...activeLoops.values()].find(
          (loop) => loop.condition.ordinal === region.id.ordinal,
        )
        if (loop === undefined) throw new RangeError('Nested execution lost its condition owner')
        terminator = {
          _tag: 'Branch',
          condition: loop.conditionValue,
          taken: target(loop.body),
          otherwise: target(loop.following),
          provenance: outcome.provenance,
        }
      }
      lowerSequence(
        id,
        region.id,
        region._tag === 'CleanupRegion' ? 'Cleanup' : 'Normal',
        [
          ...Mir.operationsOf(region),
          ...(outcome._tag === 'Complete' ? completionOperations : []),
          ...(outcome._tag === 'Complete' && execution.recoveryOutcome !== undefined
            ? [
                {
                  _tag: 'ReleaseDiagnosticOutcome' as const,
                  outcome: execution.recoveryOutcome,
                  provenance: outcome.provenance,
                },
              ]
            : []),
        ],
        terminator,
      )
    }
    activeTargets = previousTargets
    activeLoops = previousLoops
    activeRecoveryOutcomes = previousRecoveryOutcomes
    activeRecoveryBoundary = previousRecoveryBoundary
    return entry
  }

  const lowerSequence = (
    id: Mir.RegionId,
    origin: Mir.RegionId,
    kind: LinearBlock['kind'],
    operations: ReadonlyArray<Mir.Operation | LinearOperation>,
    terminator: LinearTerminator,
  ): void => {
    const specialIndex = operations.findIndex(
      (operation) =>
        operation._tag === 'Match' ||
        operation._tag === 'Conditional' ||
        operation._tag === 'ShortCircuit' ||
        operation._tag === 'CheckedScalar' ||
        operation._tag === 'DiagnosticScope' ||
        operation._tag === 'PropagateEffectFailure',
    )
    if (specialIndex < 0) {
      append({
        id,
        origin,
        kind,
        operations: linearOperations(operations),
        terminator,
      })
      return
    }
    const special = operations.at(specialIndex)
    if (special?._tag === 'DiagnosticScope') {
      const following = reserve()
      const release = reserve()
      const completion: Array<LinearOperation> = []
      if (special.body.result !== undefined)
        completion.push({
          _tag: 'Move',
          destination: special.destination,
          source: special.body.result,
          provenance: special.provenance,
        })
      const cleanup: ReadonlyArray<LinearOperation> = [
        {
          _tag: 'LeaveDiagnosticScope',
          scope: special.destination,
          provenance: special.provenance,
        },
        {
          _tag: 'Drop',
          local: special.observer,
          cleanup: special.observerCleanup,
          provenance: special.provenance,
        },
        {
          _tag: 'Drop',
          local: special.state,
          cleanup: special.stateCleanup,
          provenance: special.provenance,
        },
      ]
      const entry = emitExecution(
        special.body,
        completion,
        jump(release, special.provenance),
        special.destination,
      )
      append({
        id: release,
        origin,
        kind,
        operations: cleanup,
        terminator: jump(following, special.provenance),
      })
      append({
        id,
        origin,
        kind,
        operations: linearOperations([
          ...operations.slice(0, specialIndex),
          {
            _tag: 'EnterDiagnosticScope' as const,
            scope: special.destination,
            state: special.state,
            observer: special.observer,
            provenance: special.provenance,
          },
        ]),
        terminator: jump(entry, special.provenance),
      })
      lowerSequence(following, origin, kind, operations.slice(specialIndex + 1), terminator)
      return
    }
    if (special?._tag === 'PropagateEffectFailure') {
      append({
        id,
        origin,
        kind,
        operations: linearOperations(operations.slice(0, specialIndex)),
        terminator: special,
      })
      return
    }
    if (special?._tag === 'CheckedScalar') {
      const presentType = fn.localTypes.at(special.present.ordinal)
      const absentType = fn.localTypes.at(special.absent.ordinal)
      if (presentType?._tag !== 'CallableValue' || absentType?._tag !== 'CallableValue')
        throw new RangeError('LLVM checked scalar expansion lost its carrier callables')
      const following = reserve()
      const present = reserve()
      const absent = reserve()
      const apply = (
        callable: Mir.LocalId,
        callableType: Extract<Mir.Type, { readonly _tag: 'CallableValue' }>,
        arguments_: ReadonlyArray<Mir.LocalId>,
      ): Extract<Mir.Operation, { readonly _tag: 'ApplyCallable' }> => ({
        _tag: 'ApplyCallable',
        destination: special.destination,
        callable,
        typeArguments:
          callableType.environment?.callable.typeArguments ??
          callableType.storage?.realization.targetArguments ??
          callableType.typeArguments ??
          [],
        captures: [],
        arguments: arguments_,
        callableType: callableType.type,
        access: callableType.type.mode,
        evaluation: 'CalleeThenArguments',
        realization: 'Environment',
        type: special.type,
        provenance: special.provenance,
      })
      const drop = (
        local: Mir.LocalId,
        cleanup: Extract<Mir.Operation, { readonly _tag: 'Drop' }>['cleanup'],
      ): Extract<Mir.Operation, { readonly _tag: 'Drop' }> => ({
        _tag: 'Drop',
        local,
        cleanup,
        provenance: special.provenance,
      })
      append({
        id,
        origin,
        kind,
        operations: linearOperations([
          ...operations.slice(0, specialIndex),
          {
            _tag: 'CheckedScalarOutcome' as const,
            operation: special.operation,
            valid: special.valid,
            value: special.value,
            operands: special.operands,
            sourceType: special.sourceType,
            valueType: special.valueType,
            provenance: special.provenance,
          },
        ]),
        terminator: {
          _tag: 'Branch',
          condition: special.valid,
          taken: present,
          otherwise: absent,
          provenance: special.provenance,
        },
      })
      lowerSequence(following, origin, kind, operations.slice(specialIndex + 1), terminator)
      lowerSequence(
        present,
        origin,
        'Normal',
        [
          drop(special.absent, special.absentCleanup),
          apply(special.present, presentType, [special.value]),
        ],
        jump(following, special.provenance),
      )
      lowerSequence(
        absent,
        origin,
        'Normal',
        [drop(special.present, special.presentCleanup), apply(special.absent, absentType, [])],
        jump(following, special.provenance),
      )
      return
    }
    if (special?._tag === 'Conditional') {
      const following = reserve()
      const branch = (execution: Mir.Execution): Mir.RegionId =>
        emitExecution(
          execution,
          execution.result === undefined
            ? []
            : [
                {
                  _tag: 'Move',
                  destination: special.destination,
                  source: execution.result,
                  provenance: special.provenance,
                },
              ],
          jump(following, special.provenance),
        )
      const taken = branch(special.taken)
      const otherwise = branch(special.otherwise)
      append({
        id,
        origin,
        kind,
        operations: linearOperations(operations.slice(0, specialIndex)),
        terminator: {
          _tag: 'Branch',
          condition: special.condition,
          taken,
          otherwise,
          provenance: special.provenance,
        },
      })
      lowerSequence(following, origin, kind, operations.slice(specialIndex + 1), terminator)
      return
    }
    if (special?._tag === 'ShortCircuit') {
      const following = reserve()
      const evaluateRight = emitExecution(
        special.right,
        special.right.result === undefined
          ? []
          : [
              {
                _tag: 'Move',
                destination: special.destination,
                source: special.right.result,
                provenance: special.provenance,
              },
            ],
        jump(following, special.provenance),
      )
      const decided = reserve()
      append({
        id,
        origin,
        kind,
        operations: linearOperations(operations.slice(0, specialIndex)),
        // `&&` reaches its right operand on a true left operand; `||` on a false one. The other
        // edge writes the operator's decided value without evaluating the right operand at all.
        terminator: {
          _tag: 'Branch',
          condition: special.left,
          taken: special.operator === 'And' ? evaluateRight : decided,
          otherwise: special.operator === 'And' ? decided : evaluateRight,
          provenance: special.provenance,
        },
      })
      lowerSequence(following, origin, kind, operations.slice(specialIndex + 1), terminator)
      append({
        id: decided,
        origin,
        kind: 'Normal',
        operations: [
          {
            _tag: 'Literal' as const,
            destination: special.destination,
            type: special.type,
            value: special.operator === 'And' ? 0 : 1,
            provenance: special.provenance,
          },
        ],
        terminator: jump(following, special.provenance),
      })
      return
    }
    if (special?._tag !== 'Match')
      throw new RangeError('LLVM control expansion lost its special operation')
    const match = special
    const dispatch = reserve()
    const following = reserve()
    append({
      id,
      origin,
      kind,
      operations: linearOperations(operations.slice(0, specialIndex)),
      terminator: jump(dispatch, match.provenance),
    })
    lowerSequence(following, origin, kind, operations.slice(specialIndex + 1), terminator)

    const trap = reserve()
    append({
      id: trap,
      origin,
      kind: 'Normal',
      operations: [],
      terminator: {
        _tag: 'Trap',
        reason: 'exhaustive match rejected every candidate',
        provenance: match.provenance,
      },
    })

    const candidateEntry = (
      member: Match.CoverageIdentity,
      candidates: ReadonlyArray<Match.ArmId>,
      ordinal: number,
    ): Mir.RegionId => {
      const entry = reserve()
      const candidate = candidates.at(ordinal)
      if (candidate === undefined) {
        append({
          id: entry,
          origin,
          kind: 'Normal',
          operations: [],
          terminator: jump(trap, match.provenance),
        })
        return entry
      }
      const arm = match.arms.find((item) => item.id.ordinal === candidate.ordinal)
      if (arm === undefined) throw new RangeError('LLVM match expansion lost a candidate arm')
      const bindingMember =
        arm.member?._tag === 'StructuralTypeMember' && Match.selects(arm.member, member, 'Runtime')
          ? arm.member
          : member
      const bindings: ReadonlyArray<LinearOperation> = [
        ...arm.bindings,
        ...arm.cleanupBindings.map((binding) => ({ ...binding, provenance: arm.provenance })),
      ].map((binding) => ({
        _tag: 'BindMatch' as const,
        scrutinee: match.scrutinee,
        ...(match.selectors === undefined ? {} : { selectors: match.selectors }),
        shape: match.scrutineeShape,
        member: bindingMember,
        destination: binding.destination,
        path: binding.path,
        type: binding.type,
        provenance: binding.provenance,
      }))
      const cleanup = arm.selected.cleanup.flatMap((entry): ReadonlyArray<LinearOperation> => {
        const type = fn.localTypes.at(entry.destination.ordinal)
        if (type === undefined) throw new RangeError('LLVM match cleanup lost its local type')
        return [
          {
            _tag: 'BindMatch' as const,
            scrutinee: match.scrutinee,
            ...(match.selectors === undefined ? {} : { selectors: match.selectors }),
            shape: match.scrutineeShape,
            member: bindingMember,
            destination: entry.destination,
            path: entry.path,
            type,
            provenance: arm.provenance,
          },
          {
            _tag: 'Drop' as const,
            local: entry.destination,
            cleanup: entry.cleanup,
            provenance: arm.provenance,
          },
        ]
      })
      const selected = emitExecution(
        arm.selected.execution,
        [
          ...cleanup,
          ...(match.destination === undefined || arm.selected.execution.result === undefined
            ? []
            : [
                {
                  _tag: 'Move' as const,
                  destination: match.destination,
                  source: arm.selected.execution.result,
                  provenance: arm.provenance,
                },
              ]),
        ],
        jump(following, arm.provenance),
      )
      const tests = arm.tests ?? []
      const bindingEntry = tests.length === 0 ? entry : reserve()
      const fallback =
        arm.guard === undefined && tests.length === 0
          ? undefined
          : candidateEntry(member, candidates, ordinal + 1)
      if (arm.guard === undefined) {
        lowerSequence(bindingEntry, origin, 'Normal', bindings, jump(selected, arm.provenance))
      } else {
        if (fallback === undefined) throw new RangeError('Guarded pattern lost its fallback')
        const completedGuard: LinearTerminator =
          arm.guard.execution.result === undefined
            ? {
                _tag: 'Trap',
                reason: 'noncompleting guard reached completion',
                provenance: arm.provenance,
              }
            : {
                _tag: 'Branch',
                condition: arm.guard.execution.result,
                taken: selected,
                otherwise: fallback,
                provenance: arm.provenance,
              }
        const guard = emitExecution(arm.guard.execution, [], completedGuard)
        lowerSequence(bindingEntry, origin, 'Normal', bindings, jump(guard, arm.provenance))
      }
      const testEntries = tests.map((_, ordinal) => (ordinal === 0 ? entry : reserve()))
      for (const [ordinal, test] of tests.entries()) {
        if (fallback === undefined) throw new RangeError('Nested pattern lost its fallback')
        append({
          id: testEntries.at(ordinal) ?? entry,
          origin,
          kind: 'Normal',
          operations: [],
          terminator: {
            _tag: 'MatchBranch',
            scrutinee: match.scrutinee,
            selectors: test.selectors,
            shape: test.shape,
            member: test.member,
            taken: testEntries.at(ordinal + 1) ?? bindingEntry,
            otherwise: fallback,
            provenance: { span: test.span, generated: false },
          },
        })
      }
      return entry
    }

    const decisionEntries = match.decisions.map((decision) =>
      candidateEntry(decision.member, decision.candidates, 0),
    )
    if (match.scrutineeType._tag === 'Enum') {
      const enumType = match.scrutineeType
      const dispatchIds = match.decisions.map((_, ordinal) =>
        ordinal === 0 ? dispatch : reserve(),
      )
      match.decisions.forEach((decision, ordinal) => {
        if (decision.member._tag !== 'EnumMember')
          throw new RangeError('Verified scalar enum match lost its member identity')
        const member = decision.member.member
        const declared = enumType.representation.members.find(
          (candidate) =>
            candidate.member.enum.module === member.enum.module &&
            candidate.member.enum.name === member.enum.name &&
            candidate.member.name === member.name,
        )
        if (declared === undefined)
          throw new RangeError('Verified scalar enum match lost its declared discriminant')
        append({
          id: dispatchIds.at(ordinal) ?? dispatch,
          origin,
          kind: 'Normal',
          operations: [],
          terminator: {
            _tag: 'EnumMatchBranch',
            scrutinee: match.scrutinee,
            ...(match.selectors === undefined ? {} : { selectors: match.selectors }),
            discriminant: declared.discriminant,
            type: enumType,
            representation: enumType.representation,
            taken: decisionEntries.at(ordinal) ?? trap,
            otherwise: dispatchIds.at(ordinal + 1) ?? trap,
            provenance: match.provenance,
          },
        })
      })
      return
    }
    if (
      match.scrutineeShape.tree._tag !== 'SumShape' &&
      match.scrutineeShape.tree._tag !== 'NominalUnionShape'
    ) {
      const selected = decisionEntries.at(0) ?? trap
      append({
        id: dispatch,
        origin,
        kind: 'Normal',
        operations: [],
        terminator: jump(selected, match.provenance),
      })
      return
    }
    const dispatchIds = match.decisions.map((_, ordinal) => (ordinal === 0 ? dispatch : reserve()))
    match.decisions.forEach((decision, ordinal) => {
      append({
        id: dispatchIds.at(ordinal) ?? dispatch,
        origin,
        kind: 'Normal',
        operations: [],
        terminator: {
          _tag: 'MatchBranch',
          scrutinee: match.scrutinee,
          ...(match.selectors === undefined ? {} : { selectors: match.selectors }),
          shape: match.scrutineeShape,
          member: decision.member,
          taken: decisionEntries.at(ordinal) ?? trap,
          otherwise: dispatchIds.at(ordinal + 1) ?? trap,
          provenance: match.provenance,
        },
      })
    })
  }

  for (const block of input) {
    lowerSequence(block.id, block.origin, block.kind, block.operations, block.terminator)
  }
  const byId = new Map(blocks.map((block) => [block.id.ordinal, block] as const))
  const visited = new Set<number>()
  const ordered: Array<LinearBlock> = []
  const visit = (id: Mir.RegionId): void => {
    if (visited.has(id.ordinal)) return
    visited.add(id.ordinal)
    const block = byId.get(id.ordinal)
    if (block === undefined) return
    ordered.push(block)
    const terminator = block.terminator
    if (terminator._tag === 'Jump') visit(terminator.target)
    if (
      terminator._tag === 'Branch' ||
      terminator._tag === 'MatchBranch' ||
      terminator._tag === 'EnumMatchBranch'
    ) {
      visit(terminator.taken)
      visit(terminator.otherwise)
    }
  }
  visit(fn.entry)
  for (const block of [...blocks].sort((left, right) => left.id.ordinal - right.id.ordinal)) {
    visit(block.id)
  }
  return ordered
}

/** LLVM-private flattening of the compiler-owned DAG. Repeat is the only source of a back-edge. */
export const linearize = (fn: Mir.MirFunction): ReadonlyArray<LinearBlock> => {
  const loops = new Map(
    fn.regions.flatMap((region) =>
      region._tag === 'LoopRegion' ? [[region.loop.ordinal, region] as const] : [],
    ),
  )
  const conditionOwners = new Map(
    fn.regions.flatMap((region) =>
      region._tag === 'LoopRegion' ? [[region.condition.ordinal, region] as const] : [],
    ),
  )
  const outcome = (region: Mir.OperationRegion | Mir.CleanupRegion): LinearTerminator => {
    const value = region.outcome
    switch (value._tag) {
      case 'Forward':
      case 'Return':
      case 'Trap':
        return value._tag === 'Forward'
          ? { _tag: 'Jump', target: value.target, provenance: value.provenance }
          : value
      case 'Repeat': {
        const loop = loops.get(value.loop.ordinal)
        if (loop === undefined) throw new RangeError('LLVM linearizer lost repeat loop')
        return { _tag: 'Jump', target: loop.id, provenance: value.provenance }
      }
      case 'Exit': {
        const loop = loops.get(value.loop.ordinal)
        if (loop === undefined) throw new RangeError('LLVM linearizer lost exit loop')
        return { _tag: 'Jump', target: loop.following, provenance: value.provenance }
      }
      case 'Complete':
        throw new RangeError('Function body contains a nested completion outcome')
      case 'Yield': {
        const loop = conditionOwners.get(region.id.ordinal)
        if (loop === undefined) throw new RangeError('LLVM linearizer found unowned yield')
        return {
          _tag: 'Branch',
          condition: loop.conditionValue,
          taken: loop.body,
          otherwise: loop.following,
          provenance: value.provenance,
        }
      }
    }
  }
  const raw = Mir.topologicalRegions(fn).map((region): StructuredBlock => {
    if (region._tag === 'ConditionalRegion') {
      return {
        id: region.id,
        origin: region.id,
        kind: 'Normal',
        operations: [],
        terminator: {
          _tag: 'Branch',
          condition: region.condition,
          taken: region.taken,
          otherwise: region.otherwise,
          provenance: region.provenance,
        },
      }
    }
    if (region._tag === 'LoopRegion') {
      return {
        id: region.id,
        origin: region.id,
        kind: 'Normal',
        operations: [],
        terminator: {
          _tag: 'Jump',
          target: region.condition,
          provenance: region.provenance,
        },
      }
    }
    return {
      id: region.id,
      origin: region.id,
      kind: region._tag === 'CleanupRegion' ? 'Cleanup' : 'Normal',
      operations: region._tag === 'CleanupRegion' ? region.releases : region.operations,
      terminator: outcome(region),
    }
  })
  const incoming = new Map<number, number>()
  for (const edge of Mir.controlEdges(fn)) {
    incoming.set(edge.to.ordinal, (incoming.get(edge.to.ordinal) ?? 0) + 1)
  }
  const byId = new Map(raw.map((block) => [block.id.ordinal, block] as const))
  const regionsById = new Map(fn.regions.map((region) => [region.id.ordinal, region] as const))
  const inlined = new Set<number>()
  const blocks = raw.map((block): StructuredBlock => {
    let operations = [...block.operations]
    let terminator = block.terminator
    const seen = new Set<number>()
    while (terminator._tag === 'Jump' && !seen.has(terminator.target.ordinal)) {
      const target = byId.get(terminator.target.ordinal)
      const targetRegion = regionsById.get(terminator.target.ordinal)
      const inlineable =
        target !== undefined &&
        incoming.get(target.id.ordinal) === 1 &&
        (target.kind === 'Cleanup' || targetRegion?._tag === 'ConditionalRegion')
      if (!inlineable) break
      seen.add(target.id.ordinal)
      inlined.add(target.id.ordinal)
      operations = [...operations, ...target.operations]
      terminator = target.terminator
    }
    return { ...block, operations: operations, terminator }
  })
  const referenced = new Set<number>([fn.entry.ordinal])
  // Structural incoming counts do not include every edge introduced by outcome lowering. Keep an
  // inline candidate when the rewritten graph still names it; otherwise a valid branch can target
  // a block removed by this private optimization.
  for (const block of blocks) {
    const terminator = block.terminator
    if (terminator._tag === 'Jump') referenced.add(terminator.target.ordinal)
    if (
      terminator._tag === 'Branch' ||
      terminator._tag === 'MatchBranch' ||
      terminator._tag === 'EnumMatchBranch'
    ) {
      referenced.add(terminator.taken.ordinal)
      referenced.add(terminator.otherwise.ordinal)
    }
  }
  return expandMatches(
    fn,
    blocks.filter((block) => !inlined.has(block.id.ordinal) || referenced.has(block.id.ordinal)),
  )
}

export const llvmControl = (program: Mir.Module): ReadonlyArray<ControlProvenance> =>
  program.functions.flatMap((fn) =>
    (() => {
      const linear = linearize(fn)
      const origins = new Map<number, Mir.RegionId>()
      for (const block of linear)
        if (!origins.has(block.id.ordinal)) origins.set(block.id.ordinal, block.origin)
      const originOf = (target: Mir.RegionId): Mir.RegionId | undefined =>
        origins.get(target.ordinal)
      return linear.map((block): ControlProvenance => {
        const terminator = block.terminator
        let targets: Array<Mir.RegionId | undefined> = []
        if (terminator._tag === 'Jump') {
          targets = [originOf(terminator.target)]
        } else if (
          terminator._tag === 'Branch' ||
          terminator._tag === 'MatchBranch' ||
          terminator._tag === 'EnumMatchBranch'
        ) {
          targets = [originOf(terminator.taken), originOf(terminator.otherwise)]
        }
        const canonicalTargets = targets.flatMap((target) =>
          target === undefined || target.ordinal === block.origin.ordinal ? [] : [target],
        )
        let construct: ControlProvenance['construct'] = 'LlvmTrap'
        if (terminator._tag === 'Jump') {
          construct = 'LlvmJump'
        } else if (
          terminator._tag === 'Branch' ||
          terminator._tag === 'MatchBranch' ||
          terminator._tag === 'EnumMatchBranch'
        ) {
          construct = 'LlvmBranch'
        } else if (terminator._tag === 'Return' || terminator._tag === 'PropagateEffectFailure') {
          construct = 'LlvmReturn'
        }
        return {
          _tag: 'BackendControlProvenance',
          backend: 'LLVM',
          function: fn.id,
          instance: fn.instance,
          region: block.origin,
          construct,
          targets: canonicalTargets,
          span: terminator.provenance.span,
        }
      })
    })(),
  )
