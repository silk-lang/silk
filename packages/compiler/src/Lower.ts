import * as CompilerTrace from './CompilerTrace.js'
import * as CleanupPlan from './CleanupPlan.js'
import * as ConformanceProof from './ConformanceProof.js'
import * as Diagnostic from './Diagnostic.js'
import type * as DeclarationFacts from './DeclarationFacts.js'
import type * as DeclarationIndex from './DeclarationIndex.js'
import * as ExecutionPackage from './ExecutionPackage.js'
import * as ExecutionTransition from './ExecutionTransition.js'
import * as Tir from './Tir.js'
import * as ExecutableInputView from './ExecutableInputView.js'
import * as Instances from './Instances.js'
import * as Layout from './Layout.js'
import * as LocalSharedControlBlock from './LocalSharedControlBlock.js'
import * as LocalSharedPayloadCleanup from './LocalSharedPayloadCleanup.js'
import type * as Match from './Match.js'
import * as Mir from './Mir.js'
import * as MirVerification from './MirVerification.js'
import type * as OpaqueRealization from './OpaqueRealization.js'
import type * as Ownership from './Ownership.js'
import * as SourceSpan from './SourceSpan.js'
import type * as StaticValue from './StaticValue.js'
import * as Type from './Type.js'

/**
 * Lowering preserves source control as canonical acyclic regions. Repetition is represented by a
 * loop region plus lexical repeat/exit outcomes; backend-private CFGs are derived later.
 */

export const i32: Extract<Mir.Type, { readonly _tag: 'i32' }> = { _tag: 'i32' }
export const usize: Extract<Mir.Type, { readonly _tag: 'usize' }> = { _tag: 'usize' }
export const bool: Extract<Mir.Type, { readonly _tag: 'bool' }> = { _tag: 'bool' }
export const character: Extract<Mir.Type, { readonly _tag: 'char' }> = {
  _tag: 'char',
}

export const mirType = (
  type: Type.Type,
  substitution: Type.Substitution = new Map(),
  layout?: Layout.Plan,
): Mir.Type | undefined => {
  const specialized = Type.substitute(type, substitution)
  if (!Type.isRuntimeConcrete(specialized)) return undefined
  const representation =
    layout === undefined ? undefined : Layout.entry(layout, specialized)?.representation
  if (Type.isNominal(specialized) && representation?._tag === 'ScalarEnum')
    return { _tag: 'Enum', type: specialized, representation }
  if (typeof specialized === 'string') {
    if (Type.isBuiltin(specialized)) return { _tag: specialized }
    if (Type.isNever(specialized)) return { _tag: 'Bottom', type: specialized }
    return undefined
  }
  if (Type.isString(specialized)) return { _tag: 'String', type: specialized }
  if (Type.isNominal(specialized)) return { _tag: 'Nominal', type: specialized }
  if (Type.isFixedArray(specialized)) return { _tag: 'FixedArray', type: specialized }
  if (Type.isSlice(specialized)) return { _tag: 'Slice', type: specialized }
  if (Type.isReference(specialized)) return { _tag: 'Reference', type: specialized }
  if (Type.isPointer(specialized)) return { _tag: 'Pointer', type: specialized }
  if (Type.isForeignFunction(specialized)) return { _tag: 'ForeignFunction', type: specialized }
  if (Type.isUnion(specialized)) return { _tag: 'Union', type: specialized }
  if (Type.isEffect(specialized)) return { _tag: 'EffectOutcome', type: specialized }
  return undefined
}

export const local = (ordinal: number): Mir.LocalId => ({ _tag: 'Local', ordinal })

export const spanKey = (span: SourceSpan.SourceSpan): string => `${span.start}:${span.end}`
export const patternKey = (binding: Match.BindingId | Tir.LocalId): string =>
  binding._tag === 'TirLocal'
    ? `local:${binding.ordinal}`
    : `${Tir.nodeRefKey(binding.arm.match.node)}:${binding.arm.ordinal}:${binding.ordinal}`
export const borrowKey = (borrow: Tir.BorrowId): string => Tir.borrowKey(borrow)

export interface ProvidedRequirement {
  readonly capability: Type.Nominal
  readonly providerType: Type.Nominal
  readonly witness: DeclarationFacts.ConformanceWitness
  readonly role: string
  readonly requirementAccess: Type.Requirement['access']
  readonly access: Type.CallableMode
  readonly local?: Mir.LocalId
}

export type ExecutableEffectType = Extract<
  Mir.Type,
  { readonly _tag: 'EffectValue' | 'EffectComposite' }
>

export const specializeProvider = (
  fn: FunctionLowering,
  provider: Extract<Tir.Expression, { readonly _tag: 'EffectBindRequirement' }>['provider'],
): ProvidedRequirement | undefined => {
  const proof = Instances.requirementSelection(fn.owner, provider)
  if (proof === undefined) return undefined
  const selected = proof.selected
  const capability = selected.capability
  const providerType = proof.provider
  if (capability === undefined || !Type.isNominal(capability) || !Type.isNominal(providerType))
    return undefined
  const witness = provider.witness ?? ConformanceProof.witness(fn.index, providerType, capability)
  if (witness === undefined) return undefined
  return {
    capability,
    providerType,
    witness,
    role: selected.role,
    requirementAccess: selected.access,
    access: provider.selectionAccess,
  }
}

import type { FunctionLowering } from './FunctionLowering.js'
export interface DelayedEffectState {
  readonly recipes: ReadonlyMap<number, Tir.Expression>
  readonly loanEnds: ReadonlyMap<number, ReadonlyArray<Tir.BorrowId>>
  readonly loanLocals: ReadonlyMap<string, Mir.LocalId>
}

const withLocalSharedDropPlan = (layout: Layout.Plan, operation: Mir.Operation): Mir.Operation => {
  if (operation._tag === 'Drop' && operation.cleanup._tag === 'LocalSharedCoreCleanup') {
    const elementLayout = Layout.entry(layout, operation.cleanup.element)
    const block =
      elementLayout === undefined
        ? undefined
        : LocalSharedControlBlock.plan(layout.target, operation.cleanup.element, elementLayout)
    return block?._tag !== 'LocalSharedControlBlockPlan'
      ? operation
      : {
          ...operation,
          localShared: { element: operation.cleanup.element, block },
        }
  }
  if (operation._tag === 'DiagnosticScope')
    return {
      ...operation,
      body: Mir.mapExecutionOperations(operation.body, (operations) =>
        operations.map((child) => withLocalSharedDropPlan(layout, child)),
      ),
    }
  if (operation._tag === 'Conditional')
    return {
      ...operation,
      taken: Mir.mapExecutionOperations(operation.taken, (operations) =>
        operations.map((child) => withLocalSharedDropPlan(layout, child)),
      ),
      otherwise: Mir.mapExecutionOperations(operation.otherwise, (operations) =>
        operations.map((child) => withLocalSharedDropPlan(layout, child)),
      ),
    }
  if (operation._tag === 'ShortCircuit')
    return {
      ...operation,
      right: Mir.mapExecutionOperations(operation.right, (operations) =>
        operations.map((child) => withLocalSharedDropPlan(layout, child)),
      ),
    }
  if (operation._tag === 'Match')
    return {
      ...operation,
      arms: operation.arms.map((arm) => ({
        ...arm,
        ...(arm.guard === undefined
          ? {}
          : {
              guard: {
                ...arm.guard,
                execution: Mir.mapExecutionOperations(arm.guard.execution, (operations) =>
                  operations.map((child) => withLocalSharedDropPlan(layout, child)),
                ),
              },
            }),
        selected: {
          ...arm.selected,
          execution: Mir.mapExecutionOperations(arm.selected.execution, (operations) =>
            operations.map((child) => withLocalSharedDropPlan(layout, child)),
          ),
        },
      })),
    }
  if ('releases' in operation && operation.releases !== undefined)
    return {
      ...operation,
      releases: operation.releases.map((release) => {
        const planned = withLocalSharedDropPlan(layout, release)
        return planned._tag === 'Drop' ? planned : release
      }),
    }
  return operation
}

const withLocalSharedDropPlans = (
  layout: Layout.Plan,
  functions: ReadonlyArray<Mir.MirFunction>,
): ReadonlyArray<Mir.MirFunction> =>
  functions.map((fn) => ({
    ...fn,
    regions: fn.regions.map((region) => {
      if (region._tag === 'OperationRegion') {
        return {
          ...region,
          operations: region.operations.map((operation) =>
            withLocalSharedDropPlan(layout, operation),
          ),
        }
      }
      if (region._tag === 'CleanupRegion') {
        return {
          ...region,
          releases: region.releases.map((release) => {
            const planned = withLocalSharedDropPlan(layout, release)
            return planned._tag === 'Drop' || planned._tag === 'EndLoan' ? planned : release
          }),
        }
      }
      return region
    }),
  }))

/**
 * Resolves the hidden package cleanup at the last point where exact MIR executable identities are
 * still available. A represented Effect's semantic type deliberately erases its captured owners;
 * the initializer operation does not. Package release therefore consumes the operation's concrete
 * cleanup proof rather than the symbolic layout placeholder.
 */
const withExecutionPackageCleanups = (
  layout: Layout.Plan,
  functions: ReadonlyArray<Mir.MirFunction>,
): Layout.Plan => {
  const cleanupBySpecialization = new Map<string, ExecutionPackage.CleanupMetadata>()
  for (const fn of functions) {
    for (const operation of MirVerification.operations(fn)) {
      if (operation._tag !== 'ExecutionFromAllocation') continue
      const key = ExecutionPackage.specializationKey(operation.plan.specialization)
      cleanupBySpecialization.set(key, {
        body: operation.bodyCleanup,
        endpoint: operation.endpointCleanup,
        callback: operation.callbackCleanup,
      })
    }
  }
  if (cleanupBySpecialization.size === 0) return layout
  return {
    ...layout,
    executionPackages: {
      ...layout.executionPackages,
      plans: layout.executionPackages.plans.map((plan) => {
        const cleanup = cleanupBySpecialization.get(
          ExecutionPackage.specializationKey(plan.specialization),
        )
        return cleanup === undefined ? plan : { ...plan, cleanup }
      }),
    },
  }
}

import { generated } from './CleanupEmission.js'
import {
  lowerBuiltinEffectRunner,
  lowerCatchEffectRunner,
  lowerEffectRunner,
  lowerInstance,
  lowerWitnessEffectRunner,
  requireGeneratedEffectRunner,
  returnedEffectBlock,
  returnedValueType,
  type UnsupportedFunction,
  unavailableReferencedEffectRunner,
} from './EntryAssembly.js'
import type {} from './Forwarding.js'
import type { GeneratedEffectRunner, SpecializedWitnessEffectTarget } from './ValueType.js'
import { baseRunnerKey, returnedEffectValueType, instanceText } from './ValueType.js'

/**
 * Re-proves source witness effects while their concrete instance context is still authoritative.
 *
 * A generated block runner retains source-authored TIR, whose interface call remains intentionally
 * symbolic. Repeating discovery's declaration substitution here, and carrying that exact target
 * into the runner, prevents lowering's proof-context compatibility from replacing the source
 * conformance identity when its execution boundary is synthesized later.
 */
export const specializedWitnessEffectTargets = (
  index: DeclarationIndex.Index,
  owner: Instances.Instance,
  block: Extract<Tir.Expression, { readonly _tag: 'EffectBlock' }>,
): ReadonlyArray<SpecializedWitnessEffectTarget> =>
  Tir.runtimeExpressionTree(block).flatMap((expression) => {
    if (
      (expression._tag !== 'BuiltinCall' && expression._tag !== 'InterfaceOperationCall') ||
      expression.witnessEffectSite === undefined
    )
      return []
    const bound =
      expression._tag === 'InterfaceOperationCall' ? expression : expression.interfaceOperation
    if (bound === undefined) return []
    const capability = Type.substitute(bound.capability, owner.substitution)
    if (!Type.isNominal(capability)) return []
    const target = ConformanceProof.interfaceWitnessTarget(
      index,
      Type.substitute(bound.provider, owner.substitution),
      capability,
      bound.operation,
      bound.contract,
      owner.substitution,
    )
    return target === undefined ? [] : [{ site: expression.witnessEffectSite, target }]
  })

export const lowerProgram = (
  discovery: Instances.Discovery,
  layout: Layout.Plan,
  index: DeclarationIndex.Index,
  opaqueRealizations: OpaqueRealization.Catalog,
  registry: SemanticContext.Registry,
  trace: CompilerTrace.CompilerTrace = CompilerTrace.none,
): LoweredProgram => {
  const declaredForeignStatics = trace('Lower.collectForeignStatics', () => {
    const declaredForeignStatics = index.modules.flatMap((module) =>
      module.members.flatMap((member) =>
        member._tag === 'ForeignStaticDeclaration' &&
        member.canonical._tag === 'Canonical' &&
        member.declaredType._tag === 'Resolved'
          ? [
              {
                declaration: member.canonical.id,
                declarationSpan: registry.spanOf(member.anchor),
                direction: member.direction,
                symbol: member.foreign.symbol,
                type: member.declaredType.type,
                ...(member.literal === undefined ? {} : { literal: member.literal }),
              },
            ]
          : [],
      ),
    )
    return declaredForeignStatics
  })
  const ownershipOf = (instance: Instances.Instance): Ownership.ModuleOwnership => ({
    _tag: 'OwnershipFacts',
    module: instance.key.declaration.module,
    functions: [instance.ownership],
    diagnostics: [],
  })
  const staticData = trace('Lower.collectStaticData', () => {
    const staticDataById = new Map<
      string,
      Extract<
        Tir.Expression,
        { readonly _tag: 'StaticStringLiteral' | 'StaticByteViewLiteral' }
      >['data']
    >()
    for (const instance of discovery.instances) {
      for (const expression of instance.function.statements
        .flatMap(Tir.statementExpressions)
        .flatMap(Tir.runtimeExpressionTree)) {
        if (
          expression._tag === 'StaticStringLiteral' ||
          expression._tag === 'StaticByteViewLiteral'
        )
          staticDataById.set(expression.data.id, expression.data)
      }
    }
    const staticData = [...staticDataById.values()].sort((left, right) =>
      left.id.localeCompare(right.id),
    )
    return staticData
  })
  // Discovery retains separate proof contexts so every call is checked. Once contracts are
  // concrete, contexts with the same emitted arguments and contract share one machine body.
  const runtimeInstances = trace('Lower.selectRuntimeInstances', () => {
    const runtimeInstances = new Map<string, Instances.Instance>()
    for (const instance of discovery.instances) {
      runtimeInstances.set(Instances.runtimeKeyText(instance.key), instance)
    }
    return runtimeInstances
  })
  const { effectResults, generatedRunners } = trace('Lower.prepareEffectRunners', () => {
    const effectResults = new Map<string, ExecutableEffectType>()
    const ambiguousRuntimeResults = new Set<string>()
    const generatedRunners: Array<GeneratedEffectRunner> = []
    const publishEffectResult = (instance: Instances.Instance, type: ExecutableEffectType) => {
      effectResults.set(Instances.keyText(instance.key), type)
      const runtimeKey = instanceText(
        instance.key.declaration,
        instance.key.typeArguments,
        instance.key.staticArguments,
      )
      if (ambiguousRuntimeResults.has(runtimeKey)) return
      if (effectResults.has(runtimeKey)) {
        effectResults.delete(runtimeKey)
        ambiguousRuntimeResults.add(runtimeKey)
        return
      }
      effectResults.set(runtimeKey, type)
    }
    for (const instance of runtimeInstances.values()) {
      const block = returnedEffectBlock(instance.function)
      const type =
        block === undefined ? undefined : returnedEffectValueType(layout, instance, block)
      if (type !== undefined && block !== undefined) {
        publishEffectResult(instance, type)
        generatedRunners.push({
          _tag: 'BlockEffectRunner',
          id: Tir.effectRunnerId(instance.key.declaration, block.site),
          owner: instance,
          block,
          type,
          specializationKey: baseRunnerKey(instance.key, block.site, type.type),
          providedRequirements: [],
          witnessTargets: specializedWitnessEffectTargets(index, instance, block),
        })
        continue
      }
      const returned = returnedValueType(
        layout,
        opaqueRealizations,
        instance.function,
        instance.substitution,
      )
      if (returned?._tag === 'EffectComposite') publishEffectResult(instance, returned)
    }
    return { effectResults, generatedRunners }
  })
  const unsupported: Array<UnsupportedFunction> = []
  const functions = trace('Lower.lowerInstances', () => {
    const lowered = [...runtimeInstances.values()].map((instance) =>
      trace(
        'Lower.lowerInstance',
        () =>
          lowerInstance(
            instance,
            ownershipOf(instance),
            layout,
            index,
            discovery.instances,
            discovery.calls,
            effectResults,
            generatedRunners,
            opaqueRealizations,
            registry,
          ),
        {
          'function.module': instance.key.declaration.module,
          'function.name': instance.key.declaration.name,
        },
      ),
    )
    const functions: Array<Mir.MirFunction> = []
    for (const result of lowered) {
      if (result._tag === 'UnsupportedFunction') unsupported.push(result)
      else functions.push(result)
    }
    return functions
  })
  trace('Lower.lowerCleanupHelpers', () => {
    const helperSpan = SourceSpan.fromOffsets(discovery.rootModule, 0, 0)
    if (helperSpan === undefined)
      throw new RangeError('Generated local-shared cleanup lost its span')
    const sharedElements = [
      ...new Map(
        layout.entries.flatMap((entry) => {
          if (!Type.isSharedCore(entry.type)) return []
          const element = Type.typeArgumentAt(entry.type, 0)
          // Generic layout entries do not have a runtime payload to clean up.
          return element === undefined || !Type.isRuntimeConcrete(element)
            ? []
            : [[Type.key(element), element] as const]
        }),
      ).values(),
    ].sort((left, right) => Type.key(left).localeCompare(Type.key(right)))
    for (const element of sharedElements) {
      const parameterType = mirType(element)
      if (parameterType === undefined)
        throw new RangeError('Generated local-shared cleanup lost its concrete payload type')
      const parameter = local(0)
      const result = local(1)
      const cleanup = CleanupPlan.cleanupPlan(index, element)
      functions.push({
        _tag: 'MirFunction' as const,
        id: LocalSharedPayloadCleanup.declaration,
        instance: LocalSharedPayloadCleanup.instance(element),
        parameterCount: 1,
        localTypes: [parameterType, i32],
        result: i32,
        entry: { _tag: 'Region' as const, ordinal: 0 },
        regions: [
          {
            _tag: 'OperationRegion' as const,
            id: { _tag: 'Region' as const, ordinal: 0 },
            operations: [
              ...(cleanup._tag === 'NoCleanup'
                ? []
                : [
                    {
                      _tag: 'Drop' as const,
                      local: parameter,
                      cleanup,
                      provenance: generated(helperSpan),
                    },
                  ]),
              {
                _tag: 'Literal' as const,
                destination: result,
                type: i32,
                value: 0n,
                provenance: generated(helperSpan),
              },
            ],
            outcome: {
              _tag: 'Return' as const,
              value: result,
              provenance: generated(helperSpan),
            },
          },
        ],
      })
    }
  })
  const loweredRunners: Array<{
    readonly spec: GeneratedEffectRunner
    readonly runner: Mir.MirFunction
  }> = []
  const unavailableRunners: Array<
    Extract<
      ReturnType<typeof lowerEffectRunner>,
      { readonly _tag: 'UnavailableGeneratedEffectRunner' }
    >
  > = []
  const unresolvedOpenBase = (spec: GeneratedEffectRunner): boolean => {
    return (
      spec.providedRequirements.length === 0 && Type.requirementMembers(spec.type.type).length > 0
    )
  }
  for (let ordinal = 0; ordinal < generatedRunners.length; ordinal += 1) {
    const generated = generatedRunners.at(ordinal)
    if (generated === undefined) continue
    let runner: Mir.MirFunction | undefined
    if (generated._tag === 'BlockEffectRunner') {
      const outcome = trace(
        'Lower.lowerEffectRunner',
        () =>
          lowerEffectRunner(
            generated,
            ownershipOf(generated.owner),
            layout,
            index,
            discovery.instances,
            discovery.calls,
            effectResults,
            generatedRunners,
            opaqueRealizations,
            registry,
          ),
        {
          'function.module': generated.id.module,
          'function.name': generated.id.name,
          'runner.ordinal': ordinal,
        },
      )
      if (outcome._tag === 'LoweredGeneratedEffectRunner') runner = outcome.runner
      else unavailableRunners.push(outcome)
    } else if (generated._tag === 'CatchEffectRunner') {
      runner = trace(
        'Lower.lowerCatchEffectRunner',
        () =>
          lowerCatchEffectRunner(
            generated,
            ownershipOf(generated.owner),
            layout,
            index,
            discovery.instances,
            discovery.calls,
            effectResults,
            generatedRunners,
            opaqueRealizations,
            registry,
          ),
        {
          'function.module': generated.id.module,
          'function.name': generated.id.name,
          'runner.ordinal': ordinal,
        },
      )
    } else if (generated._tag === 'BuiltinEffectRunner') {
      runner = trace(
        'Lower.lowerBuiltinEffectRunner',
        () =>
          lowerBuiltinEffectRunner(
            generated,
            ownershipOf(generated.owner),
            layout,
            index,
            discovery.instances,
            discovery.calls,
            effectResults,
            generatedRunners,
            opaqueRealizations,
            registry,
          ),
        {
          'function.module': generated.id.module,
          'function.name': generated.id.name,
          'runner.ordinal': ordinal,
        },
      )
    } else {
      runner = trace(
        'Lower.lowerWitnessEffectRunner',
        () =>
          lowerWitnessEffectRunner(
            generated,
            ownershipOf(generated.owner),
            layout,
            index,
            discovery.instances,
            discovery.calls,
            effectResults,
            generatedRunners,
            opaqueRealizations,
            registry,
          ),
        {
          'function.module': generated.id.module,
          'function.name': generated.id.name,
          'runner.ordinal': ordinal,
        },
      )
    }
    if (runner !== undefined) loweredRunners.push({ spec: generated, runner })
  }
  // Lowering a provided parent can discover provided children after their open bases were already
  // visited. Filter only after the worklist reaches its fixed point so backends never compile an
  // unreachable open runner that still calls another open runner without provider arguments.
  const runnerKey = (
    declaration: DeclarationFacts.CanonicalId,
    typeArguments: ReadonlyArray<Type.GenericArgument>,
    staticArguments: ReadonlyArray<StaticValue.Value>,
  ): string => instanceText(declaration, typeArguments, staticArguments)
  const retainedRunners = new Set(
    loweredRunners
      .filter(({ spec }) => !unresolvedOpenBase(spec))
      .map(({ spec }) =>
        runnerKey(spec.id, spec.owner.key.typeArguments, spec.owner.key.staticArguments),
      ),
  )
  const retainReferencedRunners = (fn: Mir.MirFunction): boolean => {
    let changed = false
    for (const operation of MirVerification.operations(fn)) {
      if (operation._tag === 'RunEffectComposite') {
        for (const alternative of operation.alternatives) {
          const key = runnerKey(
            alternative.runner,
            alternative.runnerTypeArguments,
            alternative.runnerStaticArguments ?? [],
          )
          if (retainedRunners.has(key)) continue
          retainedRunners.add(key)
          changed = true
        }
        continue
      }
      if (
        operation._tag !== 'RunEffectValue' &&
        operation._tag !== 'RunStaticEffect' &&
        operation._tag !== 'CatchEffect'
      )
        continue
      const key = runnerKey(
        operation.runner,
        operation.runnerTypeArguments,
        operation.runnerStaticArguments ?? [],
      )
      if (!retainedRunners.has(key)) {
        retainedRunners.add(key)
        changed = true
      }
    }
    return changed
  }
  trace('Lower.retainReferencedRunners', () => {
    for (const fn of functions) retainReferencedRunners(fn)
    let retainedChanged = true
    while (retainedChanged) {
      retainedChanged = false
      for (const { spec, runner } of loweredRunners) {
        if (
          !retainedRunners.has(
            runnerKey(spec.id, spec.owner.key.typeArguments, spec.owner.key.staticArguments),
          )
        )
          continue
        if (retainReferencedRunners(runner)) retainedChanged = true
      }
    }
    const unavailable = unavailableReferencedEffectRunner(unavailableRunners, retainedRunners)
    if (unavailable !== undefined) requireGeneratedEffectRunner(unavailable)
    functions.push(
      ...loweredRunners.flatMap(({ spec, runner }) => {
        return retainedRunners.has(
          runnerKey(spec.id, spec.owner.key.typeArguments, spec.owner.key.staticArguments),
        )
          ? [runner]
          : []
      }),
    )
  })
  const finalizedLayout = trace('Lower.finalizeExecutionPackages', () =>
    withExecutionPackageCleanups(layout, functions),
  )
  const foreignStaticUses = new Set(
    functions.flatMap((fn) =>
      Mir.topologicalRegions(fn).flatMap((region) =>
        Mir.operationsOf(region).flatMap((operation) =>
          Mir.operationTree(operation).flatMap((nested) =>
            nested._tag === 'ForeignStaticLoad'
              ? [`${nested.declaration.module}\u0000${nested.declaration.name}`]
              : [],
          ),
        ),
      ),
    ),
  )
  const foreignStatics = declaredForeignStatics
    .filter(
      (record) =>
        record.direction === 'Export' ||
        foreignStaticUses.has(`${record.declaration.module}\u0000${record.declaration.name}`),
    )
    .sort(
      (left, right) =>
        left.declarationSpan.sourceId.localeCompare(right.declarationSpan.sourceId) ||
        left.declarationSpan.start - right.declarationSpan.start ||
        left.declarationSpan.end - right.declarationSpan.end,
    )
  const executableInputViews = ExecutableInputView.catalog(discovery.instances, discovery.calls)
  const program: Mir.Module = {
    _tag: 'MirModule',
    module: discovery.rootModule,
    intrinsics: discovery.intrinsics,
    foreignCalls: discovery.foreignCalls,
    foreignExports: discovery.foreignExports,
    retainedRoots: discovery.retention,
    ...(executableInputViews.length === 0 ? {} : { executableInputViews }),
    foreignStatics,
    layout: finalizedLayout,
    staticData,
    executionTransitions: finalizedLayout.executionPackages.plans.map((plan, ordinal) =>
      ExecutionTransition.authority(ordinal, ordinal + 1, plan.readinessStorage),
    ),
    functions: withLocalSharedDropPlans(layout, functions),
  }
  return {
    program,
    diagnostics: trace('Lower.referencedUnsupportedFunctions', () =>
      referencedUnsupportedFunctions(program, unsupported),
    ),
  }
}

/** One lowered program and the diagnostics for referenced instances lowering cannot support. */
export interface LoweredProgram {
  readonly program: Mir.Module
  readonly diagnostics: ReadonlyArray<Diagnostic.Diagnostic>
}

const declarationText = (declaration: DeclarationFacts.CanonicalId): string =>
  `${declaration.module}\u0000${declaration.name}`

// Every executable reference to a function instance (direct call, callable value, witness slot,
// Effect runner, retained root) carries the instance's canonical declaration id. Walking emitted
// operations and module roots structurally therefore finds every reference kind without
// enumerating them. The match is per declaration, a deliberate superset of the exact instance.
const collectDeclarations = (value: unknown, found: Set<string>): void => {
  if (typeof value !== 'object' || value === null) return
  if (Array.isArray(value)) {
    for (const item of value) collectDeclarations(item, found)
    return
  }
  if (
    '_tag' in value &&
    value._tag === 'CanonicalDeclarationId' &&
    'module' in value &&
    typeof value.module === 'string' &&
    'name' in value &&
    typeof value.name === 'string'
  ) {
    found.add(`${value.module}\u0000${value.name}`)
    return
  }
  for (const nested of Object.values(value)) collectDeclarations(nested, found)
}

/**
 * Diagnoses each unsupported instance that emitted code still references. An unreferenced instance
 * is omitted: discovery can demand a function instance that no emitted code calls.
 */
export const referencedUnsupportedFunctions = (
  program: Mir.Module,
  unsupported: ReadonlyArray<UnsupportedFunction>,
): ReadonlyArray<Diagnostic.Diagnostic> => {
  if (unsupported.length === 0) return []
  const referenced = new Set<string>()
  for (const fn of program.functions) collectDeclarations(fn.regions, referenced)
  collectDeclarations(program.retainedRoots, referenced)
  collectDeclarations(program.foreignExports, referenced)
  return unsupported
    .filter((entry) => referenced.has(declarationText(entry.instance.declaration)))
    .map((entry) => Diagnostic.unsupportedLowering(entry.span))
}
import type * as SemanticContext from './SemanticContext.js'
