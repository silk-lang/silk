import { indexExits, loanEndOperations } from './CleanupEmission.js'
import type { ExitIndex } from './CleanupEmission.js'
import type * as CleanupPlan from './CleanupPlan.js'
import * as Constraint from './Constraint.js'
import type * as DeclarationFacts from './DeclarationFacts.js'
import type * as DeclarationIndex from './DeclarationIndex.js'
import type * as SemanticContext from './SemanticContext.js'
import type * as Tir from './Tir.js'
import * as Instances from './Instances.js'
import type * as Layout from './Layout.js'
import type { ExecutableEffectType, ProvidedRequirement } from './Lower.js'
import { borrowKey, local, mirType } from './Lower.js'
import type * as Mir from './Mir.js'
import type * as MovePath from './MovePath.js'
import type * as OpaqueRealization from './OpaqueRealization.js'
import type * as Ownership from './Ownership.js'
import type * as SourceSpan from './SourceSpan.js'
import * as StaticValue from './StaticValue.js'
import * as Type from './Type.js'
import type { GeneratedEffectRunner, SpecializedWitnessEffectTarget } from './ValueType.js'
import {
  representedValueType,
  storedCallableValueType,
  storedEffectValueType,
} from './ValueType.js'

/** Selects one admitted runtime call edge in its lexical provider context. */
export const selectCall = (
  calls: ReadonlyArray<Instances.CallInstance>,
  owner: Instances.InstanceKey,
  expression: { readonly span: SourceSpan.SourceSpan; readonly id?: Tir.NodeId },
  implementation?: DeclarationFacts.CanonicalId,
  typeArguments?: ReadonlyArray<Type.GenericArgument>,
  staticArguments?: ReadonlyArray<StaticValue.Value>,
  providers: ReadonlyArray<Instances.CallProvider> = [],
): Instances.CallInstance | undefined => {
  const atSite = Instances.callsAtSite(calls, owner, expression.span).filter(
    (call) =>
      expression.id === undefined ||
      call.node === undefined ||
      call.node.ordinal === expression.id.ordinal,
  )
  const exactProviders = atSite.filter((call) => Instances.callMatchesProviders(call, providers))
  const usedRuntimeProviderFallback = exactProviders.length === 0
  // Discovery coalesces proof-only lifetimes inside provider types as well as call arguments.
  // Recover only already-admitted physical provider shapes; semantic selection stays exact.
  const exact = usedRuntimeProviderFallback
    ? atSite.filter((call) =>
        (call.providers ?? []).every((expected) => {
          const actual = providers.findLast(
            (candidate) =>
              expected.role === candidate.role &&
              Type.equals(expected.capability, candidate.capability),
          )
          if (actual === undefined) return false
          const expectedRuntime = Type.runtimeArgumentKeys([expected.providerType])
          const actualRuntime = Type.runtimeArgumentKeys([actual.providerType])
          return (
            expectedRuntime.length === actualRuntime.length &&
            expectedRuntime.every((argument, ordinal) => argument === actualRuntime.at(ordinal))
          )
        }),
      )
    : exactProviders
  const selected =
    implementation === undefined
      ? exact
      : exact.filter(
          (call) =>
            call.target.declaration.module === implementation.module &&
            call.target.declaration.name === implementation.name,
        )
  const expected = typeArguments?.filter((argument) => !Type.isHiddenExecutableArgument(argument))
  const exactSpecialized =
    expected === undefined
      ? selected
      : selected.filter((call) => {
          const actual = call.target.typeArguments.filter(
            (argument) => !Type.isHiddenExecutableArgument(argument),
          )
          return (
            actual.length === expected.length &&
            actual.every((argument, ordinal) => {
              const wanted = expected.at(ordinal)
              return wanted !== undefined && Type.equalsGenericArgument(argument, wanted)
            })
          )
        })
  let usedRuntimeFallback = usedRuntimeProviderFallback
  let specialized = exactSpecialized
  if (expected !== undefined && exactSpecialized.length === 0) {
    usedRuntimeFallback = true
    // Runtime instance discovery deliberately coalesces proof-only caller lifetimes. If another
    // proof context supplied the retained call shape, recover only its unique runtime-equivalent
    // visible arguments so lowering also retains its hidden callable and Effect identities.
    // Ambiguous physical targets remain unavailable.
    const expectedRuntime = Type.runtimeArgumentKeys(expected)
    specialized = selected.filter((call) => {
      const actualRuntime = Type.runtimeArgumentKeys(
        call.target.typeArguments.filter((argument) => !Type.isHiddenExecutableArgument(argument)),
      )
      return (
        actualRuntime.length === expectedRuntime.length &&
        actualRuntime.every((argument, ordinal) => argument === expectedRuntime.at(ordinal))
      )
    })
  }
  const staticallySpecialized =
    staticArguments === undefined || staticArguments.length === 0
      ? specialized
      : specialized.filter(
          (call) =>
            call.target.staticArguments.length === staticArguments.length &&
            call.target.staticArguments.every((argument, ordinal) => {
              const wanted = staticArguments.at(ordinal)
              return wanted !== undefined && StaticValue.equals(argument, wanted)
            }),
        )
  if (staticallySpecialized.length === 1) return staticallySpecialized.at(0)
  if (!usedRuntimeFallback || staticallySpecialized.length === 0) return undefined
  const targets = new Map(
    staticallySpecialized.map((call) => [Instances.keyText(call.target), call] as const),
  )
  return targets.size === 1 ? [...targets.values()].at(0) : undefined
}

export interface LoweringFailure {
  readonly boundary: 'Expression' | 'Statement'
  readonly construct: Tir.Expression['_tag'] | Tir.Statement['_tag']
  readonly provenance: Mir.Provenance
  readonly reason?:
    | {
        readonly _tag: 'WitnessEffectMissingSite'
      }
    | {
        readonly _tag: 'WitnessEffectMissingContract'
      }
    | {
        readonly _tag: 'WitnessEffectMissingTarget'
        readonly site: string
        readonly publishedSites: ReadonlyArray<string>
      }
    | {
        readonly _tag: 'WitnessEffectMissingLayout'
        readonly site: string
        readonly availableSites: ReadonlyArray<string>
      }
    | {
        readonly _tag: 'WitnessEffectOperandLowering'
        readonly site: string
        readonly failure:
          | 'Arity'
          | 'Argument'
          | 'Contract'
          | 'ExpectedType'
          | 'ActualType'
          | 'Incompatible'
        readonly ordinal?: number
      }
}

export class FunctionLowering {
  /** Only the generated primitive runner may emit the terminal suspension origin. */
  builtinEffectRunner = false

  readonly regions: Array<Mir.Region | undefined> = []
  readonly localTypes: Array<Mir.Type> = []
  readonly bindingLocals = new Map<number, Mir.LocalId>()
  readonly parameterLocals = new Map<number, Mir.LocalId>()
  readonly initializationFlags = new Map<
    string,
    ReadonlyArray<{ readonly path: MovePath.Path; readonly local: Mir.LocalId }>
  >()
  readonly initializationFlagRoots = new Map<string, Mir.LocalId>()
  initializationStarted = false
  readonly effectRecipes = new Map<number, Tir.Expression>()
  readonly callableRecipes = new Map<number, Tir.Expression>()
  readonly effectLoanEnds = new Map<number, ReadonlyArray<Tir.BorrowId>>()
  readonly realizedRecipeBorrows = new Set<string>()
  readonly issuedBorrowKeys: Set<string>
  readonly patternLocals = new Map<string, Mir.LocalId>()
  readonly loanLocals = new Map<string, Mir.LocalId>()
  readonly loanIds = new Map<string, Tir.BorrowId>()
  readonly loanParents = new Map<string, string>()
  readonly slotLoans = new Map<number, ReadonlyArray<Tir.BorrowId>>()
  readonly callableDefinitions = new Map<
    number,
    Extract<Mir.Operation, { readonly _tag: 'MakeCallable' }>
  >()
  // Allocation metadata survives branch/loop rewrites; loanLocals tracks path-local liveness.
  readonly temporaryBorrowOwners = new Map<
    string,
    {
      readonly local: Mir.LocalId
      readonly cleanup: CleanupPlan.CleanupPlan
      readonly span: SourceSpan.SourceSpan
    }
  >()
  readonly expressionLocals = new Map<string, Mir.LocalId>()
  readonly matchCleanupLocals = new Map<string, Mir.LocalId>()
  readonly extractedRegions = new Set<number>()
  readonly exits: ExitIndex
  ownerLoop: Mir.LoopId | undefined
  activeRequirements: ReadonlyArray<ProvidedRequirement> | undefined
  private operations: Array<Mir.Operation> = []
  private syntheticBorrowOrdinal = 0
  private replayBorrowSubstitution: Map<string, Tir.BorrowId> | undefined
  private readonly directBorrowSubstitution = new Map<string, Tir.BorrowId>()
  loweringFailure: LoweringFailure | undefined

  constructor(
    readonly layout: Layout.Plan,
    readonly index: DeclarationIndex.Index,
    readonly registry: SemanticContext.Registry,
    parameterTypes: ReadonlyArray<Mir.Type>,
    readonly ownership: Ownership.FunctionOwnership | undefined,
    readonly substitution: Type.Substitution,
    readonly effectOutcome: Type.Effect | undefined,
    readonly owner: Instances.Instance,
    readonly instances: ReadonlyArray<Instances.Instance>,
    readonly calls: ReadonlyArray<Instances.CallInstance>,
    readonly effectResults: ReadonlyMap<string, ExecutableEffectType>,
    readonly generatedRunners: Array<GeneratedEffectRunner>,
    readonly opaqueRealizations: OpaqueRealization.Catalog,
    readonly providedRequirements: ReadonlyArray<ProvidedRequirement> = [],
    readonly witnessTargets?: ReadonlyArray<SpecializedWitnessEffectTarget>,
  ) {
    this.exits = indexExits(ownership)
    this.issuedBorrowKeys = new Set((ownership?.loans ?? []).map((loan) => borrowKey(loan.id)))
    this.localTypes.push(...parameterTypes)
    parameterTypes.forEach((_, ordinal) => {
      this.parameterLocals.set(ordinal, local(ordinal))
    })
  }

  reserve(): Mir.RegionId {
    const id = { _tag: 'Region' as const, ordinal: this.regions.length }
    this.regions.push(undefined)
    return id
  }

  freshSyntheticBorrow(call: Tir.NodeRef): Tir.BorrowId {
    while (true) {
      const borrow: Tir.BorrowId = {
        _tag: 'BorrowId',
        call,
        ordinal: this.syntheticBorrowOrdinal,
      }
      this.syntheticBorrowOrdinal += 1
      const key = borrowKey(borrow)
      if (this.issuedBorrowKeys.has(key)) continue
      this.issuedBorrowKeys.add(key)
      return borrow
    }
  }

  withRecipeReplay<A>(body: () => A): A {
    if (this.replayBorrowSubstitution !== undefined) return body()
    this.replayBorrowSubstitution = new Map()
    try {
      return body()
    } finally {
      this.replayBorrowSubstitution = undefined
    }
  }

  beginRecipeBorrow(authored: Tir.BorrowId): Tir.BorrowId {
    const key = borrowKey(authored)
    if (this.replayBorrowSubstitution === undefined) {
      const realized = this.realizedRecipeBorrows.has(key)
        ? this.freshSyntheticBorrow(authored.call)
        : authored
      this.issuedBorrowKeys.add(borrowKey(realized))
      this.realizedRecipeBorrows.add(key)
      this.directBorrowSubstitution.set(key, realized)
      return realized
    }
    const existing = this.replayBorrowSubstitution.get(key)
    if (existing !== undefined) return existing
    const realized = this.realizedRecipeBorrows.has(key)
      ? this.freshSyntheticBorrow(authored.call)
      : authored
    this.issuedBorrowKeys.add(borrowKey(realized))
    this.realizedRecipeBorrows.add(key)
    this.replayBorrowSubstitution.set(key, realized)
    return realized
  }

  recipeBorrow(authored: Tir.BorrowId): Tir.BorrowId {
    const key = borrowKey(authored)
    return (
      this.replayBorrowSubstitution?.get(key) ?? this.directBorrowSubstitution.get(key) ?? authored
    )
  }

  publish(region: Mir.Region): void {
    this.regions[region.id.ordinal] = region
  }

  recordLoweringFailure(
    boundary: LoweringFailure['boundary'],
    construct: LoweringFailure['construct'],
    span: SourceSpan.SourceSpan,
    reason?: LoweringFailure['reason'],
  ): void {
    this.loweringFailure ??= {
      boundary,
      construct,
      provenance: { span, generated: false },
      ...(reason === undefined ? {} : { reason }),
    }
  }

  capture<A>(body: () => A): readonly [A, ReadonlyArray<Mir.Operation>] {
    const previous = this.operations
    this.operations = []
    const result = body()
    const operations = [...this.operations]
    this.operations = previous
    return [result, operations]
  }

  /** Appends captured operations whose loan bookkeeping has already been applied. */
  appendCaptured(operations: ReadonlyArray<Mir.Operation>): void {
    this.operations.push(...operations)
  }

  /** Captures an eager region graph without changing the enclosing operation sequence. */
  captureExecution(
    body: () => { readonly entry: Mir.RegionId; readonly result?: Mir.LocalId } | undefined,
  ): Mir.Execution | undefined {
    const first = this.regions.length
    const result = body()
    if (result === undefined) return undefined
    const regions: Array<Mir.Region> = []
    for (let ordinal = first; ordinal < this.regions.length; ordinal += 1) {
      const region = this.regions.at(ordinal)
      if (region === undefined) {
        if (!this.extractedRegions.has(ordinal)) return undefined
        continue
      }
      regions.push(region)
      this.extractedRegions.add(ordinal)
      this.regions[ordinal] = undefined
    }
    return { ...result, regions: regions }
  }

  alloc(type: Mir.Type): Mir.LocalId {
    const id = local(this.localTypes.length)
    this.localTypes.push(type)
    return id
  }

  emit(operation: Mir.Operation): void {
    this.operations.push(
      ...(operation._tag === 'EndLoan' ? loanEndOperations(this, operation) : [operation]),
    )
    if (operation._tag === 'BeginLoan') {
      const key = borrowKey(operation.borrow)
      const parent = [...this.loanLocals.entries()].find(
        ([, slice]) => slice.ordinal === operation.root.ordinal,
      )
      if (parent !== undefined) this.loanParents.set(key, parent[0])
      this.loanIds.set(key, operation.borrow)
    } else if (operation._tag === 'EndLoan') {
      this.loanIds.set(borrowKey(operation.borrow), operation.borrow)
    }
    // A staged section's captures are only the tail of its environment, so it never serves as a
    // complete definition for the erased checked-scalar fast path.
    if (operation._tag === 'MakeCallable' && operation.base === undefined)
      this.callableDefinitions.set(operation.destination.ordinal, operation)
    if (operation._tag === 'Move') {
      const definition = this.callableDefinitions.get(operation.source.ordinal)
      if (definition !== undefined)
        this.callableDefinitions.set(operation.destination.ordinal, definition)
    }
  }

  type(type: Type.Type): Mir.Type | undefined {
    const specialized = Type.substitute(
      type,
      this.substitution,
      this.owner.specialization.compatibility,
    )
    return (
      storedCallableValueType(this.layout, specialized) ??
      storedEffectValueType(this.layout, specialized) ??
      representedValueType(this.layout, this.opaqueRealizations, type, this.substitution) ??
      mirType(specialized, new Map(), this.layout)
    )
  }

  semantic(type: Type.Type): Type.Type {
    return Type.substitute(type, this.substitution, this.owner.specialization.compatibility)
  }

  semanticArgument(argument: Type.GenericArgument): Type.GenericArgument {
    return Type.specializeExecutableOwner(
      Type.substituteGenericArgument(
        argument,
        this.substitution,
        this.owner.specialization.compatibility,
      ),
      {
        declaration: this.owner.key.declaration,
        typeArguments: this.owner.key.typeArguments,
        staticArgumentKeys: this.owner.key.staticArguments.map(StaticValue.key),
      },
      Constraint.specializeCallableSchemaExecutableOwner,
    )
  }

  call(
    expression: Tir.Expression,
    implementation?: DeclarationFacts.CanonicalId,
    typeArguments?: ReadonlyArray<Type.GenericArgument>,
    staticArguments?: ReadonlyArray<StaticValue.Value>,
    providers: ReadonlyArray<ProvidedRequirement> = this.providedRequirements,
  ): Instances.CallInstance | undefined {
    return selectCall(
      this.calls,
      this.owner.key,
      expression,
      implementation,
      typeArguments,
      staticArguments,
      providers,
    )
  }
}
