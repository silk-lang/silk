import * as CleanupPlan from './CleanupPlan.js'
import type * as DeclarationFacts from './DeclarationFacts.js'
import * as Mir from './Mir.js'
import * as ProvisionalMir from './ProvisionalMir.js'
import * as Tir from './Tir.js'
import * as Type from './Type.js'
import * as FunctionIndex from './internal/FunctionIndex.js'

/**
 * Shared, backend-neutral normalization of representation-only Effect construction and dispatch.
 * The deliberately small first slice never clones control flow or transfers affine ownership.
 */

interface ConstructorShape {
  readonly fn: Mir.MirFunction
  readonly construction: Extract<Mir.Operation, { readonly _tag: 'MakeEffect' }>
}

const sameRegion = (left: Mir.RegionId, right: Mir.RegionId): boolean =>
  left.ordinal === right.ordinal

/**
 * A constructor is one effect construction returned as is. Its function either returns the
 * construction from the entry region or forwards to one cleanup region that only drops parameters
 * whose cleanup has no effect: a service operation's outer function ends by dropping its borrowed
 * `self`, and that drop is nothing the fold could lose.
 */
const constructorShape = (fn: Mir.MirFunction | undefined): ConstructorShape | undefined => {
  if (fn === undefined || fn.regions.length === 0 || fn.regions.length > 2) return undefined
  const region = fn.regions.at(0)
  if (
    region?._tag !== 'OperationRegion' ||
    !sameRegion(region.id, fn.entry) ||
    region.operations.length !== 1
  )
    return undefined
  const construction = region.operations.at(0)
  if (construction?._tag !== 'MakeEffect') return undefined
  if (fn.regions.length === 1) {
    return region.outcome._tag === 'Return' &&
      region.outcome.value.ordinal === construction.destination.ordinal
      ? { fn, construction }
      : undefined
  }
  const cleanup = fn.regions.at(1)
  if (
    region.outcome._tag !== 'Forward' ||
    cleanup?._tag !== 'CleanupRegion' ||
    !sameRegion(region.outcome.target, cleanup.id) ||
    cleanup.outcome._tag !== 'Return' ||
    cleanup.outcome.value.ordinal !== construction.destination.ordinal ||
    !cleanup.releases.every(
      (release) =>
        release._tag === 'Drop' &&
        release.local.ordinal < fn.parameterCount &&
        !CleanupPlan.hasEffect(release.cleanup),
    )
  )
    return undefined
  return { fn, construction }
}

/** The region guard a fold proved: one region, or one trailing cleanup region of trivial drops. */
type ConstructorGuard = 'SingleRegion' | 'TrivialCleanup'

const constructorGuardOf = (shape: ConstructorShape): ConstructorGuard =>
  shape.fn.regions.length === 1 ? 'SingleRegion' : 'TrivialCleanup'

const directTarget = (
  functions: FunctionIndex.FunctionIndex<Mir.MirFunction>,
  operation: Extract<Mir.Operation, { readonly _tag: 'Call' | 'ApplyCallable' }>,
): ConstructorShape | undefined => {
  if (operation.invocationUse !== undefined) {
    let declaration: Mir.MirFunction['id'] | undefined
    if (operation._tag === 'Call') declaration = operation.target
    else if (operation.target?._tag === 'DeclarationCallableTarget')
      declaration = operation.target.declaration
    if (declaration === undefined) return undefined
    const candidates = FunctionIndex.mirInstances(
      functions,
      declaration,
      operation.typeArguments,
      operation._tag === 'Call' ? operation.staticArguments : undefined,
    ).filter((candidate) =>
      Mir.matchesCall(
        candidate,
        declaration,
        operation.typeArguments,
        operation._tag === 'Call' ? operation.staticArguments : undefined,
        operation.type,
      ),
    )
    return candidates.length === 1 ? constructorShape(candidates.at(0)) : undefined
  }
  if (operation._tag === 'Call') {
    return constructorShape(
      FunctionIndex.mirInstances(
        functions,
        operation.target,
        operation.typeArguments,
        operation.staticArguments,
      ).find((candidate) =>
        Mir.matchesCall(
          candidate,
          operation.target,
          operation.typeArguments,
          operation.staticArguments,
          operation.type,
        ),
      ),
    )
  }
  const target = operation.target
  if (target?._tag !== 'DeclarationCallableTarget') return undefined
  return constructorShape(
    FunctionIndex.mirInstances(functions, target.declaration, operation.typeArguments).at(0),
  )
}

const hasConcreteTarget = (
  functions: FunctionIndex.FunctionIndex<Mir.MirFunction>,
  operation: Extract<Mir.Operation, { readonly _tag: 'Call' | 'ApplyCallable' }>,
): boolean => {
  let declaration: DeclarationFacts.CanonicalId | undefined
  if (operation._tag === 'Call') {
    declaration = operation.target
  } else if (operation.target?._tag === 'DeclarationCallableTarget') {
    declaration = operation.target.declaration
  }
  return (
    declaration !== undefined &&
    FunctionIndex.mirInstances(functions, declaration, operation.typeArguments).length > 0
  )
}

const parametersFor = (
  operation: Extract<Mir.Operation, { readonly _tag: 'Call' | 'ApplyCallable' }>,
  count: number,
): ReadonlyArray<Mir.LocalId> | undefined => {
  if (operation._tag === 'Call')
    return operation.arguments.length === count ? operation.arguments : undefined
  const ordered: Array<Mir.LocalId | undefined> = Array.from({ length: count })
  for (const capture of operation.captures) {
    if (ordered.at(capture.parameterOrdinal) !== undefined) return undefined
    ordered[capture.parameterOrdinal] = capture.source
  }
  for (const argument of operation.arguments) {
    const ordinal = ordered.indexOf(undefined)
    if (ordinal < 0) return undefined
    ordered[ordinal] = argument
  }
  return ordered.every((local) => local !== undefined)
    ? ordered.filter((local): local is Mir.LocalId => local !== undefined)
    : undefined
}

const foldConstructor = (
  shape: ConstructorShape | undefined,
  operation: Mir.Operation,
): Extract<Mir.Operation, { readonly _tag: 'MakeEffect' }> | undefined => {
  if (operation._tag !== 'Call' && operation._tag !== 'ApplyCallable') return undefined
  if (shape === undefined) return undefined
  if (operation.invocationUse !== undefined && operation.type._tag !== 'EffectValue')
    return undefined
  if (
    operation.invocationUse !== undefined &&
    !Mir.realizesReturn(shape.construction.type, operation.type)
  )
    return undefined
  const parameters = parametersFor(operation, shape.fn.parameterCount)
  if (parameters === undefined) return undefined
  const captures = shape.construction.captures.map((capture) => {
    const source = parameters.at(capture.source.ordinal)
    return source === undefined ? undefined : { ...capture, source }
  })
  if (captures.some((capture) => capture === undefined)) return undefined
  return {
    _tag: 'MakeEffect',
    ...(operation.invocationUse === undefined ? {} : { invocationSource: operation }),
    destination: operation.destination,
    runner: shape.construction.runner,
    runnerTypeArguments: shape.construction.runnerTypeArguments,
    captures: captures.filter(
      (
        capture,
      ): capture is Extract<Mir.Operation, { readonly _tag: 'MakeEffect' }>['captures'][number] =>
        capture !== undefined,
    ),
    type:
      operation.invocationUse !== undefined && operation.type._tag === 'EffectValue'
        ? operation.type
        : shape.construction.type,
    provenance: operation.provenance,
  }
}

/** Replays the actual constructor fold before consuming a preserved call-use certificate. */
export const invocationConstructionValid = (
  program: Pick<Mir.Module, 'functions'>,
  construction: Extract<Mir.Operation, { readonly _tag: 'MakeEffect' }>,
): boolean => {
  const source = construction.invocationSource
  if (source === undefined) return true
  if (
    source.invocationUse === undefined ||
    source.destination.ordinal !== construction.destination.ordinal ||
    source.invocationUse.result.ordinal !== construction.destination.ordinal
  )
    return false
  const index = FunctionIndex.make(program.functions, (fn) => fn.id)
  const target = directTarget(index, source)
  const expected = foldConstructor(target, source)
  if (
    expected === undefined ||
    expected.runner.module !== construction.runner.module ||
    expected.runner.name !== construction.runner.name ||
    expected.runnerTypeArguments.length !== construction.runnerTypeArguments.length ||
    !expected.runnerTypeArguments.every((argument, ordinal) => {
      const actual = construction.runnerTypeArguments.at(ordinal)
      return actual !== undefined && Type.equalsGenericArgument(argument, actual)
    }) ||
    expected.captures.length !== construction.captures.length ||
    !expected.captures.every((capture, ordinal) => {
      const actual = construction.captures.at(ordinal)
      return (
        actual !== undefined &&
        capture.source.ordinal === actual.source.ordinal &&
        capture.access === actual.access
      )
    }) ||
    !Type.equals(expected.type.type, construction.type.type) ||
    expected.type.environment !== construction.type.environment ||
    !Tir.sameExecutableSite(expected.type.site, construction.type.site)
  )
    return false
  return true
}

interface LocalUse {
  readonly region: Mir.Region
  readonly operation?: Mir.Operation
}

type LocalUseIndex = ReadonlyMap<number, ReadonlyArray<LocalUse>>

/**
 * Collect all local identities in one attribution entry, including metadata. Identity tracking
 * deduplicates shared subgraphs and terminates cycles; it must not be shared between entries,
 * because the same object used by two operations represents two uses.
 */
const localOrdinals = (value: unknown): Set<number> => {
  const ordinals = new Set<number>()
  const seen = new Set<object>()
  const pending: Array<unknown> = [value]
  while (pending.length > 0) {
    const current = pending.pop()
    if (typeof current !== 'object' || current === null || seen.has(current)) continue
    seen.add(current)
    if (
      '_tag' in current &&
      current._tag === 'Local' &&
      'ordinal' in current &&
      typeof current.ordinal === 'number'
    )
      ordinals.add(current.ordinal)
    for (const entry of Object.values(current)) pending.push(entry)
  }
  return ordinals
}

/**
 * One index belongs to the immutable, constructor-folded function, before any direct-run
 * replacements. The measured parser workload scanned 141,151 operations for 1,444 construction
 * queries although those functions contain only 10,191 operations. This operation/reference
 * loop indexes each attribution entry once; queries only filter out their own definition.
 *
 * Nested executions are visited separately by regionsTree. Their enclosing composite operation
 * owns only its explicit input/result references, not all references in its nested regions.
 */
const indexLocalUses = (fn: Mir.MirFunction): LocalUseIndex => {
  const index = new Map<number, Array<LocalUse>>()
  const record = (ordinals: Iterable<number>, use: LocalUse): void => {
    for (const ordinal of ordinals) {
      const uses = index.get(ordinal)
      if (uses === undefined) index.set(ordinal, [use])
      else uses.push(use)
    }
  }
  for (const region of Mir.regionsTree(fn.regions)) {
    if (region._tag === 'OperationRegion') {
      for (const operation of region.operations) {
        let ordinals: Set<number>
        if (operation._tag === 'Match') {
          ordinals = new Set([operation.scrutinee.ordinal])
          for (const arm of operation.arms) {
            const guard = arm.guard?.execution.result
            const selected = arm.selected.execution.result
            if (guard !== undefined) ordinals.add(guard.ordinal)
            if (selected !== undefined) ordinals.add(selected.ordinal)
          }
        } else if (operation._tag === 'Conditional') {
          ordinals = new Set([operation.condition.ordinal])
          if (operation.taken.result !== undefined) ordinals.add(operation.taken.result.ordinal)
          if (operation.otherwise.result !== undefined)
            ordinals.add(operation.otherwise.result.ordinal)
        } else if (operation._tag === 'ShortCircuit') {
          ordinals = new Set([operation.left.ordinal])
          if (operation.right.result !== undefined) ordinals.add(operation.right.result.ordinal)
        } else ordinals = localOrdinals(operation)
        record(ordinals, { region, operation })
      }
      record(localOrdinals(region.outcome), { region })
    } else if (region._tag === 'CleanupRegion') {
      record(localOrdinals([region.releases, region.outcome]), { region })
    } else record(localOrdinals(region), { region })
  }
  return index
}

const usesOf = (
  index: LocalUseIndex,
  definition: Extract<Mir.Operation, { readonly _tag: 'MakeEffect' }>,
): ReadonlyArray<LocalUse> =>
  (index.get(definition.destination.ordinal) ?? []).filter((use) => use.operation !== definition)

const rejection = (
  fn: Mir.MirFunction,
  region: Mir.RegionId,
  construction: Extract<Mir.Operation, { readonly _tag: 'MakeEffect' }>,
  reason: Mir.NormalizationRejection,
): Mir.NormalizationVerdict => ({
  _tag: 'Rejected',
  reason,
  function: fn.id,
  region,
  local: construction.destination,
  provenance: construction.provenance,
})

const suspensionReason = (
  classification: ProvisionalMir.Classification,
): Extract<Mir.NormalizationRejection, 'SuspendableRunner' | 'SuspensionUnknown'> | undefined => {
  if (classification === 'Suspendable') return 'SuspendableRunner'
  if (classification === 'Unknown') return 'SuspensionUnknown'
  return undefined
}

const operationClassification = (
  provisional: ProvisionalMir.Module,
  fn: Mir.MirFunction,
  operation: Extract<
    Mir.Operation,
    { readonly _tag: 'RunEffect' | 'RunEffectValue' | 'CatchEffect' }
  >,
): ProvisionalMir.Classification => {
  if (ProvisionalMir.isOriginOfRun(provisional, fn.instance, operation.provenance.span))
    return 'Suspendable'
  return ProvisionalMir.classificationOfRun(provisional, fn.instance, operation.provenance.span)
}

/**
 * Applies normalization within every explicit execution without flattening its control flow.
 * Unchanged regions, operations, and region lists keep their identity, so a function the
 * transform leaves alone allocates nothing.
 */
const mapRegions = (
  regions: ReadonlyArray<Mir.Region>,
  transform: (region: Mir.Region) => Mir.Region,
): ReadonlyArray<Mir.Region> => {
  const execution = (value: Mir.Execution): Mir.Execution => {
    const mapped = mapRegions(value.regions, transform)
    return mapped === value.regions ? value : { ...value, regions: mapped }
  }
  const operation = (value: Mir.Operation): Mir.Operation => {
    if (value._tag === 'Match') {
      let changed = false
      const arms = value.arms.map((arm) => {
        const guard = arm.guard === undefined ? undefined : execution(arm.guard.execution)
        const selected = execution(arm.selected.execution)
        if (guard === arm.guard?.execution && selected === arm.selected.execution) return arm
        changed = true
        return {
          ...arm,
          ...(guard === undefined ? {} : { guard: { execution: guard } }),
          selected: { ...arm.selected, execution: selected },
        }
      })
      return changed ? { ...value, arms } : value
    }
    if (value._tag === 'DiagnosticScope') {
      const body = execution(value.body)
      return body === value.body ? value : { ...value, body }
    }
    if (value._tag === 'Conditional') {
      const taken = execution(value.taken)
      const otherwise = execution(value.otherwise)
      return taken === value.taken && otherwise === value.otherwise
        ? value
        : { ...value, taken, otherwise }
    }
    if (value._tag === 'ShortCircuit') {
      const right = execution(value.right)
      return right === value.right ? value : { ...value, right }
    }
    return value
  }
  let changed = false
  const mapped = regions.map((region) => {
    let input = region
    if (region._tag === 'OperationRegion') {
      const operations = region.operations.map(operation)
      if (
        operations.some(
          (mappedOperation, ordinal) => mappedOperation !== region.operations.at(ordinal),
        )
      )
        input = { ...region, operations }
    }
    const output = transform(input)
    if (output !== region) changed = true
    return output
  })
  return changed ? mapped : regions
}

/** Normalizes one target-aware MIR module from exact provisional runner facts. */
export const normalize = (program: Mir.Module, provisional: ProvisionalMir.Module): Mir.Module => {
  if (program.normalization !== undefined) return program
  // A 2,548-function replay spent most normalization time scanning every function for each
  // call. Narrow by declaration once; exact runtime/static matching and first-match order remain.
  const functionIndex = FunctionIndex.make(program.functions, (fn) => fn.id)
  const verdicts: Array<Mir.NormalizationVerdict> = []
  let changed = false
  const functions = program.functions.map((fn) => {
    let functionChanged = false
    const constructorGuards = new Map<number, ConstructorGuard>()
    const foldedRegions = mapRegions(fn.regions, (region) => {
      if (region._tag !== 'OperationRegion') return region
      let regionChanged = false
      const operations = region.operations.map((operation) => {
        const target =
          operation._tag === 'Call' || operation._tag === 'ApplyCallable'
            ? directTarget(functionIndex, operation)
            : undefined
        const targetSuspension =
          target === undefined
            ? undefined
            : suspensionReason(
                ProvisionalMir.classificationOfExecution(provisional, target.fn.instance),
              )
        const folded =
          targetSuspension === undefined ? foldConstructor(target, operation) : undefined
        if (folded === undefined) {
          if (
            (operation._tag === 'Call' || operation._tag === 'ApplyCallable') &&
            operation.type._tag === 'EffectValue'
          ) {
            verdicts.push({
              _tag: 'Rejected',
              reason:
                targetSuspension ??
                (hasConcreteTarget(functionIndex, operation)
                  ? 'ComplexConstructor'
                  : 'DynamicTarget'),
              function: fn.id,
              region: region.id,
              local: operation.destination,
              provenance: operation.provenance,
            })
          }
          return operation
        }
        regionChanged = true
        functionChanged = true
        changed = true
        const guard = target === undefined ? 'SingleRegion' : constructorGuardOf(target)
        constructorGuards.set(folded.destination.ordinal, guard)
        verdicts.push({
          _tag: 'Normalized',
          kind: 'FoldedConstructor',
          function: fn.id,
          region: region.id,
          local: folded.destination,
          guards: ['DirectTarget', guard, 'Synchronous'] as const,
          provenance: folded.provenance,
        })
        return folded
      })
      return regionChanged ? { ...region, operations } : region
    })
    const folded = functionChanged ? { ...fn, regions: foldedRegions } : fn
    for (const region of Mir.regionsTree(folded.regions)) {
      if (region._tag !== 'OperationRegion') continue
      for (const operation of region.operations) {
        if (operation._tag !== 'RunEffect' && operation._tag !== 'CatchEffect') continue
        const reason = suspensionReason(operationClassification(provisional, folded, operation))
        if (reason === undefined) continue
        verdicts.push({
          _tag: 'Rejected',
          reason,
          function: folded.id,
          region: region.id,
          local: operation.destination,
          provenance: operation.provenance,
        })
      }
    }
    let directChanged = false
    let useIndex: LocalUseIndex | undefined
    const directRegions = mapRegions(folded.regions, (region) => {
      if (region._tag !== 'OperationRegion') return region
      const removed = new Set<Mir.Operation>()
      const replacements = new Map<Mir.Operation, Mir.Operation>()
      for (const construction of region.operations) {
        if (construction._tag !== 'MakeEffect') continue
        const uses = usesOf((useIndex ??= indexLocalUses(folded)), construction)
        const use = uses.at(0)
        const run = use?.operation
        const runSuspension =
          run?._tag === 'RunEffectValue'
            ? suspensionReason(operationClassification(provisional, folded, run))
            : undefined
        let reason: Mir.NormalizationRejection | undefined = runSuspension
        if (reason === undefined) {
          // DirectStaticRun removes the holder. Keep source-owned invocation proofs on their
          // actual constructed holder so verification can discharge input validity and cleanup.
          if (construction.invocationSource !== undefined) reason = 'InvocationUse'
          else if (uses.length === 0) reason = 'EffectEscapes'
          else if (uses.length > 1) reason = 'EffectReused'
          else if (use === undefined || !sameRegion(use.region.id, region.id)) {
            reason = 'CrossRegionUse'
          } else if (
            run?._tag !== 'RunEffectValue' ||
            run.effect.ordinal !== construction.destination.ordinal
          ) {
            reason = 'EffectEscapes'
          } else if (
            construction.captures.some(
              (capture, ordinal) =>
                (capture.access !== 'Copy' && capture.access !== 'Shared') ||
                construction.type.environment.fields.at(ordinal)?.representation === 'Borrow',
            )
          ) {
            reason = 'AffineCapture'
          }
        }
        if (reason !== undefined) {
          verdicts.push(rejection(folded, region.id, construction, reason))
          continue
        }
        if (run?._tag !== 'RunEffectValue') continue
        removed.add(construction)
        replacements.set(run, {
          _tag: 'RunStaticEffect',
          destination: run.destination,
          outcome: run.outcome,
          runner: run.runner,
          runnerTypeArguments: run.runnerTypeArguments,
          ...(run.runnerStaticArguments === undefined
            ? {}
            : { runnerStaticArguments: run.runnerStaticArguments }),
          captures: construction.captures.map((capture) => ({
            source: capture.source,
            access: capture.access as 'Copy' | 'Shared',
          })),
          arguments: run.arguments,
          outcomeType: run.outcomeType,
          ...(run.propagationType === undefined ? {} : { propagationType: run.propagationType }),
          tagMappings: run.tagMappings,
          propagationLaneCount: run.propagationLaneCount,
          ...(run.failureLoanEnds === undefined ? {} : { failureLoanEnds: run.failureLoanEnds }),
          ...(run.releases === undefined ? {} : { releases: run.releases }),
          type: run.type,
          provenance: run.provenance,
        })
        verdicts.push({
          _tag: 'Normalized',
          kind: 'DirectStaticRun',
          function: folded.id,
          region: region.id,
          local: run.destination,
          guards: [
            'DirectTarget',
            constructorGuards.get(construction.destination.ordinal) ?? 'SingleRegion',
            'SingleUse',
            'Synchronous',
            'CopyOrShared',
          ] as const,
          provenance: run.provenance,
        })
        directChanged = true
        changed = true
      }
      if (removed.size === 0 && replacements.size === 0) return region
      return {
        ...region,
        operations: region.operations.flatMap((operation) => {
          if (removed.has(operation)) return []
          return [replacements.get(operation) ?? operation]
        }),
      }
    })
    return directChanged ? { ...folded, regions: directRegions } : folded
  })
  return {
    ...program,
    functions: changed ? functions : program.functions,
    normalization: verdicts,
  }
}
