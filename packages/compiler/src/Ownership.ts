import type * as AuthoredHir from './AuthoredHir.js'
import * as AuthoredIdentity from './AuthoredIdentity.js'
import * as BodyQuery from './BodyQuery.js'
import * as Result from 'effect/Result'
import * as CleanupPlan from './CleanupPlan.js'
import * as ConformanceProof from './ConformanceProof.js'
import * as DeclarationFacts from './DeclarationFacts.js'
import type * as DeclarationIndex from './DeclarationIndex.js'
import * as Diagnostic from './Diagnostic.js'
import * as Elaboration from './Elaboration.js'
import * as LoanView from './LoanView.js'
import * as ExecutionAffinity from './ExecutionAffinity.js'
import * as FieldRealization from './FieldRealization.js'
import * as Tir from './Tir.js'
import * as TypeInference from './internal/TypeInference.js'
import * as LocalSharedOwnership from './LocalSharedOwnership.js'
import * as Match from './Match.js'
import * as SemanticContext from './SemanticContext.js'
import * as Semantic from './Semantic.js'
import * as MovePath from './MovePath.js'
import * as LifetimeFlow from './LifetimeFlow.js'
import * as Lifetime from './Lifetime.js'
import type * as SourceSpan from './SourceSpan.js'
import * as Type from './Type.js'

/**
 * The ownership and scope phase over typed TIR. It runs once per declaration and is a producer:
 * ownership facts plus the target-neutral cleanup plan MIR lowering consumes to insert drops.
 * Bindings cover parameters and `let` statements; an explicit `move` consumes its binding even
 * for copyable types, and later uses are `OWN0001` violations.
 */

/** The ownership category of one binding. Nominal structs are whole-value move-only owners. */
export type OwnershipCategory =
  | { readonly _tag: 'Copyable' }
  | { readonly _tag: 'MoveOnly'; readonly type: DeclarationFacts.SemanticType }
  | { readonly _tag: 'Unavailable' }

/** Where one binding was introduced: a parameter or a `let` statement. */
export type BindingSite =
  | { readonly _tag: 'Parameter'; readonly parameter: Tir.LocalId }
  | { readonly _tag: 'Let'; readonly binding: Tir.LocalId }
  | { readonly _tag: 'Pattern'; readonly binding: Tir.LocalId }
  | { readonly _tag: 'Temporary'; readonly owner: Tir.TemporaryOwnerId }

const ownedWriteSite = (root: Tir.OwnedWriteRoot): BindingSite => {
  if (root._tag === 'ParameterWriteRoot') return { _tag: 'Parameter', parameter: root.parameter }
  if (root._tag === 'PatternWriteRoot') return { _tag: 'Pattern', binding: root.binding }
  return { _tag: 'Let', binding: root.binding }
}

/** One binding's ownership fact: site, category, live range, and consuming move if any. */
export interface BindingFact {
  readonly _tag: 'Binding'
  readonly ordinal: number
  readonly site: BindingSite
  readonly name: string | undefined
  readonly mutability: 'Immutable' | 'Mutable'
  readonly category: OwnershipCategory
  readonly executionAffinity: ExecutionAffinity.ExecutionAffinity
  readonly localSharedObligations: LocalSharedOwnership.ObligationPlan
  readonly type?: DeclarationFacts.SemanticType
  readonly cleanup: CleanupPlan.CleanupPlan
  readonly liveFrom: SourceSpan.SourceSpan
  readonly liveTo: SourceSpan.SourceSpan
  readonly movedAt?: SourceSpan.SourceSpan
  readonly place?: { readonly root: BindingSite; readonly path: MovePath.Path }
}

const supportsExclusiveAccess = (
  binding: Pick<BindingFact, 'mutability' | 'type'> | undefined,
): boolean =>
  binding?.mutability === 'Mutable' ||
  (binding?.type !== undefined &&
    (Type.isReference(binding.type) || Type.isSlice(binding.type)) &&
    binding.type.access === 'Exclusive')

/** One ordered release of an owned binding at a structured exit. */
export interface Release {
  readonly ordinal: number
  readonly _tag: 'Release'
  readonly binding: BindingFact
  readonly fields: ReadonlyArray<DeclarationFacts.FieldId>
  readonly cleanup: CleanupPlan.CleanupPlan
  readonly initialization: MovePath.State
}

/** A deterministic compiler-only identity for one lexical borrowed-view loan. */
export type BorrowId = Tir.BorrowId

/** One concrete validity dependency, retaining its precise known subplace. */
export interface LoanReferent {
  readonly root: BindingSite
  readonly path: ReadonlyArray<ReferentSelector>
}

export type ReferentSelector =
  | Extract<LoanView.Selector, { readonly _tag: 'Field' }>
  | (Omit<Extract<LoanView.Selector, { readonly _tag: 'Index' }>, 'index'> & {
      readonly index?: LoanView.Expression
    })
  | (Omit<Extract<LoanView.Selector, { readonly _tag: 'SliceIndex' }>, 'index'> & {
      readonly index?: LoanView.Expression
    })

/** Canonical subplace identity for inspection and dependency-set normalization. */
export const referentKey = (self: LoanReferent): string =>
  `${siteKey(self.root)}/${self.path
    .map((selector) => {
      if (selector._tag === 'Field') return MovePath.key(fieldSelectors(selector.field))
      return selector._tag === 'Index' && selector.bounds._tag === 'Proven'
        ? `i${selector.bounds.index}`
        : 'i*'
    })
    .join('/')}`

export const referentsOverlap = (left: LoanReferent, right: LoanReferent): boolean => {
  if (!sameSite(left.root, right.root)) return false
  for (const [ordinal, selector] of left.path.entries()) {
    const other = right.path.at(ordinal)
    if (other === undefined) return true
    if (
      selector._tag === 'Field' &&
      other._tag === 'Field' &&
      DeclarationFacts.fieldIdKey(selector.field) !== DeclarationFacts.fieldIdKey(other.field)
    )
      return false
    if (
      selector._tag === 'Index' &&
      other._tag === 'Index' &&
      selector.bounds._tag === 'Proven' &&
      other.bounds._tag === 'Proven' &&
      selector.bounds.index !== other.bounds.index
    )
      return false
  }
  return true
}

export interface LoanFact {
  readonly _tag: 'Loan'
  readonly id: BorrowId
  readonly root: BindingSite
  readonly referents: ReadonlyArray<LoanReferent>
  readonly access: Type.BorrowAccess
  readonly origin:
    | 'FixedArrayBorrow'
    | 'SliceReborrow'
    | 'ValueBorrow'
    | 'ValueReborrow'
    | 'EffectCapture'
    | 'CallableCapture'
    | 'ReturnedCallableCapture'
    | 'InterfaceOperand'
    | 'ReturnedView'
  readonly parent?: BindingSite
  readonly suspendsParent: boolean
  readonly startRegion: Tir.RegionId
  readonly endRegion: Tir.RegionId
  readonly startSpan: SourceSpan.SourceSpan
  readonly endSpan: SourceSpan.SourceSpan
  /** The retained storage is used by a destructor, so expression completion cannot end this loan. */
  readonly cleanupOnly?: boolean
}

/** One write that displaces a live value: lowering cleans the displaced value before the commit. */
export interface ReplacementFact {
  readonly _tag: 'Replacement'
  readonly region: Tir.RegionId
  readonly type: DeclarationFacts.SemanticType
  readonly cleanup: CleanupPlan.CleanupPlan
  readonly span: SourceSpan.SourceSpan
  readonly initialization: MovePath.State
}

/** One committed ownership transition; lowering preserves its selected path and presence flags. */
export interface PlaceTransition {
  readonly root: BindingSite
  readonly path: MovePath.Path
  readonly kind: 'Move' | 'Write' | 'Drop'
  readonly span: SourceSpan.SourceSpan
  readonly before: MovePath.State
  readonly after: MovePath.State
}

/** One compiler-planned slot in a concrete callable section environment. */
export interface CallableEnvironmentSlot {
  readonly ordinal: number
  readonly parameterOrdinal: number
  readonly access: Type.CaptureAccess
  readonly type?: DeclarationFacts.SemanticType
  readonly cleanup: CleanupPlan.CleanupPlan
  readonly executionAffinity: ExecutionAffinity.ExecutionAffinity
  readonly localSharedObligations: LocalSharedOwnership.ObligationPlan
}

/** Ownership facts for one hidden callable section environment. */
export interface CallableEnvironmentFact {
  readonly _tag: 'CallableEnvironment'
  readonly site: Tir.CallableSiteId
  readonly mode: Type.CallableMode
  readonly slots: ReadonlyArray<CallableEnvironmentSlot>
  readonly executionAffinity: ExecutionAffinity.ExecutionAffinity
  readonly localSharedObligations: LocalSharedOwnership.ObligationPlan
  readonly retainedDependencies: ReadonlyArray<number>
  readonly dropOrder: ReadonlyArray<number>
  readonly span: SourceSpan.SourceSpan
}

/**
 * Returns owned entries in deterministic last-acquired-first-released order,
 * deduplicated by ordinal so no release is double-issued.
 */
export const inReleaseOrder = <T extends { readonly ordinal: number }>(
  entries: ReadonlyArray<T>,
): ReadonlyArray<T> =>
  [...entries]
    .reverse()
    .filter(
      (entry, ordinal, all) =>
        all.findIndex((candidate) => candidate.ordinal === entry.ordinal) === ordinal,
    )

/** An evaluated owned operand abandoned before its parent can consume it. */
export interface TemporaryRelease {
  readonly ordinal: number
  readonly span: SourceSpan.SourceSpan
  readonly type: Type.Type
  readonly cleanup: CleanupPlan.CleanupPlan
}

/** Cleanup of an active match payload at an enclosing transfer. */
export interface MatchRelease {
  readonly ordinal: number
  readonly id: Match.MatchId
  readonly arm: Match.ArmId
  readonly cleanup: MatchOwnership['arms'][number]['cleanup']
}

/** One structured exit path with its ordered (last-acquired, first-released) releases. */
export interface ExitPlan {
  readonly _tag: 'Exit'
  readonly kind:
    | 'Return'
    | 'ScopeEnd'
    | 'ArmEnd'
    | 'LoopFallthrough'
    | 'Break'
    | 'Continue'
    | 'Propagation'
  readonly span: SourceSpan.SourceSpan
  readonly region?: Tir.RegionId
  readonly arm?: 'Taken' | 'Otherwise'
  readonly target?: Tir.LoopId
  readonly loanEnds: ReadonlyArray<BorrowId>
  readonly releases: ReadonlyArray<Release>
  readonly temporaries: ReadonlyArray<TemporaryRelease>
  readonly matches: ReadonlyArray<MatchRelease>
}

/** The finite owner-liveness states used to establish one deterministic loop header. */
export interface LoopFixedPoint {
  readonly _tag: 'LoopFixedPoint'
  readonly loop: Tir.LoopId
  readonly span: SourceSpan.SourceSpan
  readonly incoming: ReadonlyArray<BindingSite>
  readonly repeating: ReadonlyArray<ReadonlyArray<BindingSite>>
  readonly following: ReadonlyArray<BindingSite>
  readonly compatible: boolean
  readonly iterations: number
}

/** The closed outcome of checking one function. */
export type Verdict =
  | { readonly _tag: 'Satisfied' }
  | { readonly _tag: 'Violation'; readonly cause: Diagnostic.Identity }
  | { readonly _tag: 'Unavailable'; readonly cause?: Diagnostic.CauseIdentity }

/** Actual source ownership operations performed while checking one body. */
export interface Work {
  readonly pathChecks: number
  readonly shapeComputations: number
  readonly shapeCacheHits: number
  readonly shapeProjectionSteps: number
  readonly initializationJoins: number
  readonly loanAccessChecks: number
  readonly cleanupPlanQueries: number
}

/** One function's ownership facts and its target-neutral cleanup plan. */
export interface FunctionOwnership {
  readonly _tag: 'FunctionOwnership'
  readonly work?: Work
  readonly cleanupLifetimeWork?: {
    readonly liveness?: Lifetime.Work
    readonly validity?: Lifetime.Work
  }
  readonly declaration: DeclarationFacts.DeclarationFact
  /**
   * Bindings this function's own statements introduce: parameters, `let` statements, and match
   * patterns the enclosing flow reaches. Deliberately excludes deferred effect bodies, so it is
   * not the whole set of bindings the function owns — an `effect fn` is entirely a deferred
   * body, and publishes little beyond its parameters here. Read {@link allBindings} instead
   * whenever completeness matters; reach for this field only to ask the narrower question of
   * what the enclosing flow itself introduced.
   */
  readonly bindings: ReadonlyArray<BindingFact>
  /**
   * Bindings owned by deferred effect bodies: published separately because their releases lower
   * through the body's compiled runner, not through the enclosing function's statements. An
   * `effect fn`'s whole body is deferred, so its `let` and pattern bindings arrive here rather
   * than in {@link FunctionOwnership.bindings}.
   */
  readonly deferredBindings: ReadonlyArray<BindingFact>
  readonly exits: ReadonlyArray<ExitPlan>
  readonly fixedPoints: ReadonlyArray<LoopFixedPoint>
  readonly matches: ReadonlyArray<MatchOwnership>
  readonly callables: ReadonlyArray<CallableEnvironmentFact>
  readonly loans: ReadonlyArray<LoanFact>
  readonly replacements: ReadonlyArray<ReplacementFact>
  readonly transitions: ReadonlyArray<PlaceTransition>
  readonly verdict: Verdict
}

/**
 * Every binding one function owns, enclosing statements and deferred effect bodies alike. The
 * two fact sets are published apart because their releases lower through different bodies, so a
 * consumer asking "what does this function own?" — cleanup emission, drop lowering — must join
 * them rather than read {@link FunctionOwnership.bindings} and silently miss an `effect fn`'s
 * entire body.
 */
export const allBindings = (
  ownership: FunctionOwnership | undefined,
): ReadonlyArray<BindingFact> =>
  ownership === undefined ? [] : [...ownership.bindings, ...ownership.deferredBindings]

export interface MatchOwnership {
  readonly _tag: 'MatchOwnership'
  readonly id: Match.MatchId
  readonly access: Match.Access
  readonly span: SourceSpan.SourceSpan
  readonly arms: ReadonlyArray<{
    readonly id: Match.ArmId
    readonly member?: Match.CoverageIdentity
    readonly universal: boolean
    readonly provisionalGuard: boolean
    readonly bindings: ReadonlyArray<BindingSite>
    readonly cleanup: ReadonlyArray<{
      readonly path: ReadonlyArray<DeclarationFacts.FieldId>
      readonly cleanup: CleanupPlan.CleanupPlan
    }>
  }>
}

/** One module's ownership fact table and its phase diagnostics. */
export interface ModuleOwnership {
  readonly _tag: 'OwnershipFacts'
  readonly module: string
  readonly functions: ReadonlyArray<FunctionOwnership>
  readonly diagnostics: ReadonlyArray<Diagnostic.Diagnostic>
}

const satisfied: Verdict = { _tag: 'Satisfied' }

const copyable: OwnershipCategory = { _tag: 'Copyable' }

const categoryOf = (
  index: DeclarationIndex.Index,
  type: DeclarationFacts.SemanticType | undefined,
  assumptions: ReadonlySet<string> = new Set(),
): OwnershipCategory => {
  if (type === undefined) {
    return { _tag: 'Unavailable' }
  }
  if (
    (Type.isEffect(type) && type.access === 'Shared') ||
    (Type.isCallable(type) && type.mode === 'Shared') ||
    ConformanceProof.copyType(index, type, assumptions)
  ) {
    return copyable
  }
  return { _tag: 'MoveOnly', type }
}

export const siteKey = (site: BindingSite): string => {
  if (site._tag === 'Parameter') {
    return `p${site.parameter.ordinal}`
  }
  if (site._tag === 'Let') {
    return `b${site.binding.ordinal}`
  }
  if (site._tag === 'Pattern') {
    return `l${site.binding.ordinal}`
  }
  return `t${Tir.nodeRefKey(site.owner.node)}`
}

interface MutableBinding {
  readonly ordinal: number
  readonly site: BindingSite
  readonly name: string | undefined
  readonly mutability: 'Immutable' | 'Mutable'
  readonly liveFrom: SourceSpan.SourceSpan
  readonly category: OwnershipCategory
  readonly type?: DeclarationFacts.SemanticType
  readonly cause?: Diagnostic.CauseIdentity
  readonly executionAffinity?: ExecutionAffinity.ExecutionAffinity
  readonly localSharedObligations?: LocalSharedOwnership.ObligationPlan
  readonly cleanup?: CleanupPlan.CleanupPlan
  liveTo: SourceSpan.SourceSpan
  movedAt?: SourceSpan.SourceSpan
  readonly matchAccess?: Match.Access
  readonly place?: { readonly root: BindingSite; readonly path: MovePath.Path }
}

interface ExpressionExecution {
  readonly regions: Array<{ readonly region: Tir.RegionId; readonly frame: number }>
  readonly guard: boolean
  readonly frames: Array<Array<string>>
  readonly loopScopes: ReadonlyArray<{ readonly loop: Tir.LoopId; readonly frame: number }>
  readonly temporaries: Array<{ readonly frame: number; readonly release: TemporaryRelease }>
  readonly matches: Array<{ readonly frame: number; readonly release: MatchRelease }>
}

interface CheckState {
  readonly work: {
    pathChecks: number
    shapeComputations: number
    shapeCacheHits: number
    shapeProjectionSteps: number
    initializationJoins: number
    loanAccessChecks: number
    cleanupPlanQueries: number
  }
  nextAcquisition: number
  readonly index: DeclarationIndex.Index
  readonly causes: Elaboration.BodyResults['causes']
  readonly copyAssumptions: ReadonlySet<string>
  readonly bindings: Map<string, MutableBinding>
  readonly order: Array<MutableBinding>
  readonly diagnostics: Array<Diagnostic.Diagnostic>
  readonly matches: Array<MatchOwnership>
  readonly callables: Array<CallableEnvironmentFact>
  readonly replacements: Array<ReplacementFact>
  execution: ExpressionExecution | undefined
  readonly checkMatch: (
    live: FlowState,
    expression: Extract<Tir.Expression, { readonly _tag: 'Match' }>,
    consuming: boolean,
    guard: boolean,
    escaping: boolean,
  ) => boolean
  readonly propagation: (
    live: FlowState,
    expression: Extract<Tir.Expression, { readonly _tag: 'Run' }>,
  ) => void
  readonly transitions: Array<PlaceTransition>
  readonly shapes: Map<string, MovePath.ShapeOf>
}

const unavailableCause = (
  state: CheckState,
  expression: Extract<Tir.Expression, { readonly _tag: 'Unavailable' }>,
): Diagnostic.CauseIdentity | undefined =>
  expression.cause === undefined ? undefined : state.causes.at(expression.cause.ordinal)

type FlowState = Map<string, MovePath.State>
type ReadonlyFlowState = ReadonlyMap<string, MovePath.State>

const present = (live: ReadonlyFlowState, key: string): boolean => {
  const value = live.get(key)
  return value !== undefined && value.initialization !== 'Missing'
}

const shapeOf = (state: CheckState, site: BindingSite): MovePath.ShapeOf => {
  const key = siteKey(site)
  const existing = state.shapes.get(key)
  if (existing !== undefined) return existing
  const root = state.bindings.get(key)?.type
  const cache = new Map<string, MovePath.Shape | undefined>()
  interface ProjectedType {
    readonly type: Type.Type | undefined
    readonly variantFields?: ReadonlyArray<DeclarationFacts.FieldFact>
  }
  const projected = new Map<string, ProjectedType>([['', { type: root }]])
  const projectType = (path: MovePath.Path): ProjectedType => {
    const pathKey = MovePath.key(path)
    const cached = projected.get(pathKey)
    if (cached !== undefined) return cached
    const selector = path.at(-1)
    if (selector === undefined) return { type: root }
    const parent = projectType(path.slice(0, -1))
    const type = parent.type
    state.work.shapeProjectionSteps += 1
    let result: ProjectedType = { type: undefined }
    if (type !== undefined) {
      if (selector._tag === 'ConstantIndex') {
        result = { type: Type.isFixedArray(type) ? type.element : undefined }
      } else if (selector._tag === 'Variant' && Type.isUnion(type)) {
        result = { type: type.members.at(selector.ordinal) }
      } else if (Type.isNominal(type)) {
        const declaration = DeclarationFacts.byCanonical(state.index, {
          _tag: 'CanonicalDeclarationId',
          module: type.module,
          name: type.name,
        })
        if (declaration?._tag === 'StructDeclaration' || declaration?._tag === 'UnionDeclaration') {
          if (selector._tag === 'Variant') {
            const fields =
              declaration._tag === 'UnionDeclaration'
                ? declaration.variants.find((variant) => variant.id.ordinal === selector.ordinal)
                    ?.fields
                : undefined
            result = fields === undefined ? { type: undefined } : { type, variantFields: fields }
          } else {
            const fields =
              parent.variantFields ??
              (declaration._tag === 'StructDeclaration' ? declaration.fields : [])
            const field = fields.find((candidate) => candidate.id.ordinal === selector.ordinal)
            const substitution = TypeInference.substitution(
              declaration.typeParameters.map((parameter) => parameter.type),
              type.arguments,
            )
            result = {
              type:
                field?.declaredType._tag === 'Resolved' && substitution !== undefined
                  ? Type.substitute(field.declaredType.type, substitution)
                  : undefined,
            }
          }
        }
      }
    }
    projected.set(pathKey, result)
    return result
  }
  const resolveShape: MovePath.ShapeOf = (path) => {
    const pathKey = MovePath.key(path)
    if (cache.has(pathKey)) {
      state.work.shapeCacheHits += 1
      return cache.get(pathKey)
    }
    state.work.shapeComputations += 1
    const { type, variantFields } = projectType(path)
    let shape: MovePath.Shape | undefined
    if (variantFields !== undefined) {
      shape = {
        _tag: 'Fields',
        fields: variantFields.map((field) => field.id.ordinal),
        dropBoundary: false,
      }
    } else if (type === undefined) {
      shape = path.length === 0 ? { _tag: 'Leaf' } : undefined
    } else if (Type.isFixedArray(type)) {
      shape = { _tag: 'Array', length: type.length }
    } else if (Type.isUnion(type)) {
      shape = {
        _tag: 'Variants',
        variants: type.members.map((_, ordinal) => ordinal),
        dropBoundary: false,
      }
    } else if (Type.isNominal(type)) {
      const declaration = DeclarationFacts.byCanonical(state.index, {
        _tag: 'CanonicalDeclarationId',
        module: type.module,
        name: type.name,
      })
      const dropBoundary =
        ConformanceProof.witness(state.index, type, Type.dropCapability)?._tag ===
        'SourceConformanceWitness'
      if (declaration?._tag === 'StructDeclaration')
        shape = {
          _tag: 'Fields',
          fields: declaration.fields.map((field) => field.id.ordinal),
          dropBoundary,
        }
      else if (declaration?._tag === 'UnionDeclaration')
        shape = {
          _tag: 'Variants',
          variants: declaration.variants.map((variant) => variant.id.ordinal),
          dropBoundary,
        }
      else shape = { _tag: 'Leaf' }
    } else shape = { _tag: 'Leaf' }
    cache.set(pathKey, shape)
    return shape
  }
  state.shapes.set(key, resolveShape)
  return resolveShape
}

const fieldSelectors = (field: DeclarationFacts.FieldId): MovePath.Path =>
  field.owner._tag === 'UnionVariantFieldOwnerId'
    ? [
        { _tag: 'Variant', ordinal: field.owner.variant.ordinal },
        { _tag: 'Field', ordinal: field.ordinal },
      ]
    : [{ _tag: 'Field', ordinal: field.ordinal }]

/** Identifies an owned source place without evaluating it or refining its variant state. */
export const placeOf = (
  expression: Tir.Expression,
): { readonly root: BindingSite; readonly path: MovePath.Path } | undefined => {
  if (expression._tag === 'Project') {
    if (expression.subject._tag !== 'Unavailable' && Type.isReference(expression.subject.type))
      return undefined
    const subject = placeOf(expression.subject)
    return subject === undefined
      ? undefined
      : { root: subject.root, path: [...subject.path, ...fieldSelectors(expression.field)] }
  }
  if (expression._tag === 'IndexPlace') {
    const subject = placeOf(expression.subject)
    return subject === undefined || expression.bounds._tag !== 'Proven'
      ? undefined
      : {
          root: subject.root,
          path: [...subject.path, { _tag: 'ConstantIndex', index: expression.bounds.index }],
        }
  }
  const root = useSite(expression)
  return root === undefined ? undefined : { root, path: [] }
}

const canonicalPlace = (
  state: CheckState,
  place: { readonly root: BindingSite; readonly path: MovePath.Path } | undefined,
): { readonly root: BindingSite; readonly path: MovePath.Path } | undefined => {
  if (place === undefined) return undefined
  const alias = state.bindings.get(siteKey(place.root))?.place
  return alias === undefined
    ? place
    : canonicalPlace(state, { root: alias.root, path: [...alias.path, ...place.path] })
}

const selectorPath = (
  selectors: ReadonlyArray<Tir.BorrowSelector | Tir.WriteSelector>,
): MovePath.Path | undefined => {
  const path: Array<MovePath.Selector> = []
  for (const selector of selectors) {
    if (selector._tag === 'Field') path.push(...fieldSelectors(selector.field))
    else if (selector._tag === 'Index' && selector.bounds._tag === 'Proven')
      path.push({ _tag: 'ConstantIndex', index: selector.bounds.index })
    else return undefined
  }
  return path
}

const placeFailure = (
  state: CheckState,
  binding: MutableBinding,
  error: MovePath.TransitionFailure,
  span: SourceSpan.SourceSpan,
): void => {
  if (
    error._tag === 'DropBoundary' ||
    error._tag === 'InvalidPath' ||
    error._tag === 'UnrefinedVariant'
  )
    state.diagnostics.push(Diagnostic.partialMove(span))
  else
    state.diagnostics.push(
      Diagnostic.useAfterMove(binding.name ?? '?', binding.movedAt ?? binding.liveTo, span),
    )
}

const checkPath = (
  state: CheckState,
  live: FlowState,
  root: BindingSite,
  path: MovePath.Path,
  span: SourceSpan.SourceSpan,
  kind?: 'Move' | 'Drop',
): void => {
  const key = siteKey(root)
  const binding = state.bindings.get(key)
  if (binding === undefined) return
  if (binding.place !== undefined) {
    checkPath(state, live, binding.place.root, [...binding.place.path, ...path], span, kind)
    return
  }
  state.work.pathChecks += 1
  const before = live.get(key) ?? MovePath.make('Missing')
  const shape = shapeOf(state, root)
  if (kind === undefined) {
    const inspected = MovePath.inspect(before, path, shape)
    if (Result.isFailure(inspected)) placeFailure(state, binding, inspected.failure, span)
    else if (!inspected.success.complete)
      state.diagnostics.push(
        Diagnostic.useAfterMove(binding.name ?? '?', binding.movedAt ?? binding.liveTo, span),
      )
    return
  }
  const transition =
    kind === 'Drop'
      ? MovePath.terminate(before, path, shape)
      : MovePath.consume(before, path, shape)
  if (Result.isFailure(transition)) {
    placeFailure(state, binding, transition.failure, span)
    return
  }
  binding.movedAt ??= span
  if (path.length === 0) binding.liveTo = span
  live.set(key, transition.success)
  state.transitions.push({ root, path, kind, span, before, after: transition.success })
}

const joinFlows = (state: CheckState, continuing: ReadonlyArray<ReadonlyFlowState>): FlowState => {
  const joined: FlowState = new Map()
  const keys = new Set(continuing.flatMap((flow) => [...flow.keys()]))
  for (const key of keys) {
    const binding = state.bindings.get(key)
    if (binding === undefined) continue
    const incoming = continuing.map((flow) => flow.get(key) ?? MovePath.make('Missing'))
    const first = incoming.at(0)
    if (first !== undefined && incoming.every((value) => value === first)) {
      joined.set(key, first)
      continue
    }
    state.work.initializationJoins += 1
    joined.set(key, MovePath.join(incoming, shapeOf(state, binding.site)))
  }
  return joined
}

const sameFlow = (left: ReadonlyFlowState, right: ReadonlyFlowState): boolean =>
  left.size === right.size &&
  [...left].every(([key, value]) => {
    const candidate = right.get(key)
    return candidate !== undefined && MovePath.equivalent(value, candidate)
  })

const useSite = (expression: Tir.Expression): BindingSite | undefined => {
  switch (expression._tag) {
    case 'ParameterReference':
      return { _tag: 'Parameter', parameter: expression.parameter }
    case 'BindingReference':
      return { _tag: 'Let', binding: expression.binding }
    case 'PatternBindingReference':
      return { _tag: 'Pattern', binding: expression.binding }
    default:
      return undefined
  }
}

const placeSite = (expression: Tir.Expression): BindingSite | undefined => {
  if (expression._tag === 'Project' || expression._tag === 'IndexPlace') {
    return placeSite(expression.subject)
  }
  return useSite(expression)
}

const retainedBinding = (
  state: CheckState,
  expression: Tir.Expression,
): MutableBinding | undefined => {
  let source: Tir.Expression
  if (expression._tag === 'Move') {
    source = expression.subject
  } else if (expression._tag === 'UnionConvert') {
    source = expression.source
  } else {
    source = expression
  }
  const site = useSite(source)
  return site === undefined ? undefined : state.bindings.get(siteKey(site))
}

const borrowRootType = (state: CheckState, expression: Tir.Expression): Type.Type | undefined => {
  if (expression._tag !== 'SliceBorrow' && expression._tag !== 'ValueBorrow') return undefined
  if (expression.root._tag === 'TemporarySliceRoot')
    return expression.root.value._tag === 'Unavailable' ? undefined : expression.root.value.type
  let site: BindingSite
  if (expression.root._tag === 'BindingSliceRoot') {
    site = { _tag: 'Let', binding: expression.root.binding }
  } else if (expression.root._tag === 'ParameterSliceRoot') {
    site = { _tag: 'Parameter', parameter: expression.root.parameter }
  } else {
    site = { _tag: 'Pattern', binding: expression.root.binding }
  }
  return state.bindings.get(siteKey(site))?.type
}

/**
 * The callable contract one place stores, when the place is a nominal field holding a callable.
 *
 * A monomorphic body projects a `Represented` field and a generic body projects the field's
 * declaration-owned representation bound; both name the same contract, and neither is read from the
 * construction that filled the field. A field of any other type stores no callable.
 */
const storedCallableContract = (place: Tir.Expression): Type.Callable | undefined => {
  if (place._tag !== 'Project') return undefined
  const type = place.type
  if (Type.isRepresented(type)) return Type.isCallable(type.contract) ? type.contract : undefined
  return Type.isCallable(type) ? type : undefined
}

/** The Effect contract one place stores, when the place is a represented nominal field. */
const storedEffectContract = (place: Tir.Expression): Type.Effect | undefined => {
  if (place._tag !== 'Project') return undefined
  const type = place.type
  if (Type.isRepresented(type))
    return Type.isEffect(type.representation.requiredBound)
      ? type.representation.requiredBound
      : undefined
  return undefined
}

/**
 * The strongest aggregate receiver access one place offers the callable it stores.
 *
 * A whole owner offers take access; any borrow the place travels through weakens the whole place to
 * that borrow's access, because the stored environment is only ever reached through it.
 */
const receiverAccess = (
  state: CheckState,
  place: Tir.Expression,
): FieldRealization.ReceiverAccess => {
  if (place._tag !== 'Project' && place._tag !== 'IndexPlace') {
    const site = useSite(place)
    const matchAccess =
      site === undefined ? undefined : state.bindings.get(siteKey(site))?.matchAccess
    return matchAccess === 'Shared' || matchAccess === 'Exclusive' ? matchAccess : 'Take'
  }
  const subject = place.subject
  const subjectType = subject._tag === 'Unavailable' ? undefined : subject.type
  const through: FieldRealization.ReceiverAccess =
    subjectType !== undefined && (Type.isReference(subjectType) || Type.isSlice(subjectType))
      ? subjectType.access
      : 'Take'
  return FieldRealization.weakerAccess(receiverAccess(state, place.subject), through)
}

/**
 * Rejects invoking a stored callable through an aggregate receiver too weak for its mode. The rule
 * itself lives on the shared realization actor, so this pre-specialization rejection and the runtime
 * invocation it protects can never disagree about which receiver admits which mode.
 */
const storedCallableInvocationAccess = (
  state: CheckState,
  callee: Tir.Expression,
  access: Type.CallableMode,
  span: SourceSpan.SourceSpan,
): Diagnostic.Diagnostic | undefined => {
  if (callee._tag !== 'Project') return undefined
  const contract = storedCallableContract(callee)
  if (contract === undefined) return undefined
  const receiver = receiverAccess(state, callee)
  if (FieldRealization.admitsMode(receiver, access)) return undefined
  return Diagnostic.storedCallableInvocationAccess(
    Type.display(callee.nominal),
    `#${callee.field.ordinal}`,
    Type.display(contract),
    receiver,
    access,
    span,
  )
}

/** Rejects running a stored Effect through aggregate access weaker than its representation bound. */
const storedEffectRunAccess = (
  state: CheckState,
  subject: Tir.Expression,
  span: SourceSpan.SourceSpan,
): Diagnostic.Diagnostic | undefined => {
  if (subject._tag !== 'Project') return undefined
  const contract = storedEffectContract(subject)
  if (contract === undefined) return undefined
  const receiver = receiverAccess(state, subject)
  if (FieldRealization.admitsMode(receiver, contract.access)) return undefined
  return Diagnostic.storedEffectRunAccess(
    Type.display(subject.nominal),
    `#${subject.field.ordinal}`,
    Type.display(contract),
    receiver,
    contract.access,
    span,
  )
}

const mergeArmLive = (
  state: CheckState,
  continuing: ReadonlyArray<ReadonlyFlowState>,
  _span: SourceSpan.SourceSpan,
): FlowState => joinFlows(state, continuing)

const checkUse = (
  state: CheckState,
  live: FlowState,
  site: BindingSite,
  span: SourceSpan.SourceSpan,
  consuming: boolean,
): void => checkPath(state, live, site, [], span, consuming ? 'Move' : undefined)

const callableEnvironment = (
  state: CheckState,
  expression: Extract<Tir.Expression, { readonly _tag: 'CallableSection' }>,
): CallableEnvironmentFact => {
  const slots = expression.captures.map((capture): CallableEnvironmentSlot => {
    const type = capture.value._tag === 'Unavailable' ? undefined : capture.value.type
    const cause =
      capture.value._tag === 'Unavailable' ? unavailableCause(state, capture.value) : undefined
    const retained = retainedBinding(state, capture.value)
    const root = borrowRootType(state, capture.value)
    let executionAffinity: ExecutionAffinity.ExecutionAffinity
    if (type === undefined)
      executionAffinity = ExecutionAffinity.ofEnvironment(state.index, [
        cause === undefined ? {} : { cause },
      ])
    else if (root !== undefined)
      executionAffinity = ExecutionAffinity.ofBorrow(state.index, type, root)
    else
      executionAffinity = retained?.executionAffinity ?? ExecutionAffinity.ofType(state.index, type)
    return {
      ordinal: capture.ordinal,
      parameterOrdinal: capture.parameterOrdinal,
      access: capture.access,
      ...(type === undefined ? {} : { type }),
      executionAffinity,
      localSharedObligations:
        capture.access === 'Take' && type !== undefined
          ? (retained?.localSharedObligations ?? LocalSharedOwnership.ofType(state.index, type))
          : LocalSharedOwnership.none,
      cleanup:
        capture.access === 'Take' && type !== undefined
          ? cleanupPlan(state, type)
          : {
              _tag: 'NoCleanup' as const,
              type: type ?? ('i32' as const),
            },
    }
  })
  return {
    _tag: 'CallableEnvironment',
    site: expression.site,
    mode: expression.mode,
    slots,
    executionAffinity: ExecutionAffinity.join(slots.map((slot) => slot.executionAffinity)),
    localSharedObligations: LocalSharedOwnership.combine(
      slots.map((slot) => slot.localSharedObligations),
    ),
    retainedDependencies: expression.retainedDependencies,
    dropOrder: [...slots]
      .reverse()
      .filter((slot) => slot.cleanup._tag !== 'NoCleanup')
      .map((slot) => slot.ordinal),
    span: expression.span,
  }
}

const executableEnvironment = (
  state: CheckState,
  expression: Tir.Expression,
):
  | {
      readonly affinity: ExecutionAffinity.ExecutionAffinity
      readonly obligations: LocalSharedOwnership.ObligationPlan
    }
  | undefined => {
  if (expression._tag === 'CallableSection') {
    const environment = callableEnvironment(state, expression)
    return {
      affinity: environment.executionAffinity,
      obligations: environment.localSharedObligations,
    }
  }
  const retained = retainedBinding(state, expression)
  if (retained?.executionAffinity !== undefined && retained.localSharedObligations !== undefined)
    return {
      affinity: retained.executionAffinity,
      obligations: retained.localSharedObligations,
    }
  if (expression._tag === 'EffectBlock') {
    const captures = expression.captures.map((capture) => {
      let site: BindingSite | undefined
      if (capture.binding !== undefined) {
        site = { _tag: 'Let', binding: capture.binding }
      } else if (capture.pattern !== undefined) {
        site = { _tag: 'Pattern', binding: capture.pattern }
      } else if (capture.parameter !== undefined) {
        site = { _tag: 'Parameter', parameter: capture.parameter }
      } else {
        site = undefined
      }
      return {
        access: capture.access,
        binding: site === undefined ? undefined : state.bindings.get(siteKey(site)),
      }
    })
    return {
      affinity: ExecutionAffinity.join(
        captures.map(
          ({ binding }) =>
            binding?.executionAffinity ??
            (binding?.type === undefined
              ? ExecutionAffinity.ofEnvironment(state.index, [
                  binding?.cause === undefined ? {} : { cause: binding.cause },
                ])
              : ExecutionAffinity.ofType(state.index, binding.type)),
        ),
      ),
      obligations: LocalSharedOwnership.combine(
        captures.map(({ access, binding }) => {
          if (access !== 'Take') {
            return LocalSharedOwnership.none
          }
          return (
            binding?.localSharedObligations ??
            (binding?.type === undefined
              ? LocalSharedOwnership.ofEnvironment(state.index, [
                  binding?.cause === undefined
                    ? { access: 'Take' as const }
                    : { access: 'Take' as const, cause: binding.cause },
                ])
              : LocalSharedOwnership.ofType(state.index, binding.type))
          )
        }),
      ),
    }
  }
  let components: ReadonlyArray<{
    readonly access: Type.CaptureAccess
    readonly type?: Type.Type
    readonly cause?: Diagnostic.CauseIdentity
  }>
  if (expression._tag === 'EffectConstruct' || expression._tag === 'ServiceEffectConstruct') {
    components = expression.arguments.map((argument) => {
      if (argument._tag !== 'Unavailable') return { access: 'Take' as const, type: argument.type }
      if (argument.cause === undefined) return { access: 'Take' as const }
      // ponytail: a CauseRef has always been handed on here where an identity is expected; kept as is.
      return {
        access: 'Take' as const,
        cause: argument.cause as unknown as Diagnostic.CauseIdentity,
      }
    })
  } else {
    components = []
  }
  if (components.length === 0) return undefined
  return {
    affinity: ExecutionAffinity.ofEnvironment(state.index, components),
    obligations: LocalSharedOwnership.ofEnvironment(state.index, components),
  }
}

const callableCleanup = (
  environment: CallableEnvironmentFact,
  type: Type.Callable,
): CleanupPlan.CleanupPlan => ({
  _tag: 'CallableCleanup',
  type,
  environment: { _tag: 'CallableEnvironmentSite', site: environment.site },
  slots: [...environment.slots]
    .reverse()
    .flatMap((slot) =>
      slot.cleanup._tag === 'NoCleanup' ? [] : [{ ordinal: slot.ordinal, cleanup: slot.cleanup }],
    ),
})

/**
 * Checks every operand a place evaluates except its root binding, which the caller uses once with
 * the access the whole place demands. Splitting the walk keeps one use per root, so a consuming
 * invocation cannot report the root twice.
 */
const checkPlaceInterior = (
  state: CheckState,
  live: FlowState,
  place: Tir.Expression,
  guard: boolean,
  escaping: boolean,
): boolean => {
  if (place._tag === 'Project') {
    if (!checkPlaceInterior(state, live, place.subject, guard, escaping)) return false
    return true
  }
  if (place._tag === 'IndexPlace') {
    if (!checkPlaceInterior(state, live, place.subject, guard, escaping)) return false
    if (!checkExpression(state, live, place.index, false, guard, escaping)) return false
    return true
  }
  if (useSite(place) !== undefined) return true
  if (!checkExpression(state, live, place, false, guard, escaping)) return false
  return true
}

const retainTemporary = (state: CheckState, expression: Tir.Expression): void => {
  const execution = state.execution
  if (expression._tag === 'Unavailable' || execution === undefined) return
  const cleanup = cleanupPlan(state, expression.type)
  if (cleanup._tag !== 'NoCleanup')
    execution.temporaries.push({
      frame: execution.frames.length - 1,
      release: {
        ordinal: state.nextAcquisition++,
        span: expression.span,
        type: expression.type,
        cleanup,
      },
    })
}

/** Applies provisional and borrowed pattern rules to direct uses and deferred captures alike. */
const checkPatternUse = (
  state: CheckState,
  live: FlowState,
  site: BindingSite,
  span: SourceSpan.SourceSpan,
  consuming: boolean,
  guard: boolean,
  escaping: boolean,
): void => {
  const binding = state.bindings.get(siteKey(site))
  const moveOnly = binding?.category._tag === 'MoveOnly'
  if (binding?.matchAccess === 'Place') {
    if (consuming && moveOnly)
      state.diagnostics.push(Diagnostic.explicitMoveRequired(binding.name ?? '?', span))
    checkUse(state, live, site, span, false)
    return
  }
  if (guard && consuming && moveOnly) {
    state.diagnostics.push(Diagnostic.guardConsumesPattern(binding?.name ?? '?', span))
    checkUse(state, live, site, span, false)
    return
  }
  if (
    (binding?.matchAccess === 'Shared' || binding?.matchAccess === 'Exclusive') &&
    moveOnly &&
    (consuming || escaping)
  ) {
    state.diagnostics.push(Diagnostic.matchBorrowEscape(binding.name ?? '?', span))
    checkUse(state, live, site, span, false)
    return
  }
  checkUse(state, live, site, span, binding?.matchAccess === 'Move' && consuming && moveOnly)
}

/** Eager operands retain their acquired values until the containing operation completes. */
const checkExpression = (
  state: CheckState,
  live: FlowState,
  expression: Tir.Expression,
  consuming: boolean,
  guard = state.execution?.guard ?? false,
  escaping = false,
): boolean => {
  const execution = state.execution
  const mark = execution?.temporaries.length ?? 0
  if (execution !== undefined && execution.guard !== guard)
    state.execution = { ...execution, guard }
  const completed = checkExpressionOperation(state, live, expression, consuming, guard, escaping)
  state.execution = execution
  if (execution !== undefined) execution.temporaries.length = mark
  if (completed && expression._tag === 'Run') state.propagation(live, expression)
  if (!completed || (expression._tag !== 'Unavailable' && Type.isNever(expression.type)))
    return false
  if (consuming) retainTemporary(state, expression)
  return true
}

const checkExpressionOperation = (
  state: CheckState,
  live: FlowState,
  expression: Tir.Expression,
  consuming: boolean,
  guard = state.execution?.guard ?? false,
  escaping = false,
): boolean => {
  const argumentConsumes = (argument: Tir.Expression): boolean => {
    if (argument._tag === 'Unavailable') {
      return true
    }
    if (Type.isEffect(argument.type)) {
      return argument.type.access === 'Take'
    }
    if (Type.isCallable(argument.type)) {
      return argument.type.mode === 'Take'
    }
    return true
  }
  switch (expression._tag) {
    case 'ParameterReference':
    case 'BindingReference': {
      const site = useSite(expression)
      if (site === undefined) return true
      const binding = state.bindings.get(siteKey(site))
      if (consuming && binding?.category._tag === 'MoveOnly') {
        state.diagnostics.push(
          Diagnostic.explicitMoveRequired(binding.name ?? '?', expression.span),
        )
      }
      checkUse(state, live, site, expression.span, false)
      return true
    }
    case 'PatternBindingReference': {
      const site = useSite(expression)
      if (site === undefined) return true
      checkPatternUse(state, live, site, expression.span, consuming, guard, escaping)
      return true
    }
    case 'Move': {
      const place = placeOf(expression.subject)
      if (place !== undefined) {
        if (!checkPlaceInterior(state, live, expression.subject, guard, escaping)) return false
        const binding = state.bindings.get(siteKey(place.root))
        if (guard)
          state.diagnostics.push(
            Diagnostic.guardConsumesPattern(binding?.name ?? '?', expression.span),
          )
        else if (binding?.matchAccess === 'Shared' || binding?.matchAccess === 'Exclusive')
          state.diagnostics.push(Diagnostic.matchBorrowEscape(binding.name ?? '?', expression.span))
        else checkPath(state, live, place.root, place.path, expression.span, 'Move')
        return true
      }
      if (expression.subject._tag === 'Project' || expression.subject._tag === 'IndexPlace') {
        if (!checkExpression(state, live, expression.subject, false, guard, escaping)) return false
        state.diagnostics.push(Diagnostic.partialMove(expression.span))
        return true
      }
      if (
        expression.subject._tag === 'ReferentPlace' ||
        expression.subject._tag === 'SliceIndexPlace'
      ) {
        if (!checkExpression(state, live, expression.subject, false, guard, escaping)) return false
        state.diagnostics.push(Diagnostic.borrowedMove(expression.span))
        return true
      }
      const site = useSite(expression.subject)
      if (site?._tag === 'Pattern') {
        if (!checkExpression(state, live, expression.subject, true, guard, escaping)) return false
      } else if (site !== undefined) checkUse(state, live, site, expression.span, true)
      else if (!checkExpression(state, live, expression.subject, true, guard, escaping))
        return false
      return true
    }
    case 'UnionConvert':
      if (
        !checkExpression(
          state,
          live,
          expression.source,
          expression.access === 'Owned',
          guard,
          escaping,
        )
      )
        return false
      return true
    case 'ShortCircuit': {
      if (!checkExpression(state, live, expression.left, false, guard, escaping)) return false
      const rightLive = new Map(live)
      if (checkExpression(state, rightLive, expression.right, false, guard, escaping)) {
        const joined = joinFlows(state, [live, rightLive])
        live.clear()
        for (const [key, initialization] of joined) live.set(key, initialization)
      }
      return true
    }
    case 'Construct':
    case 'ConstructUnionVariant': {
      const fields = new Map(
        expression.fields.map(
          (field) => [DeclarationFacts.fieldIdKey(field.field), field.value] as const,
        ),
      )
      for (const field of expression.evaluationOrder) {
        const value = fields.get(DeclarationFacts.fieldIdKey(field))
        if (value !== undefined)
          if (!checkExpression(state, live, value, true, guard, escaping)) return false
      }
      return true
    }
    case 'ArrayConstruct': {
      for (const element of expression.elements)
        if (!checkExpression(state, live, element, true, guard, escaping)) return false
      return true
    }
    case 'Project': {
      const place = placeOf(expression)
      if (place !== undefined) {
        if (!checkPlaceInterior(state, live, expression, guard, escaping)) return false
        checkPath(state, live, place.root, place.path, expression.span)
        if (
          consuming &&
          categoryOf(state.index, expression.type, state.copyAssumptions)._tag === 'MoveOnly'
        )
          state.diagnostics.push(
            Diagnostic.explicitMoveRequired(
              state.bindings.get(siteKey(place.root))?.name ?? '?',
              expression.span,
            ),
          )
        return true
      }
      if (!checkExpression(state, live, expression.subject, false, guard, escaping)) return false
      if (
        consuming &&
        categoryOf(state.index, expression.type, state.copyAssumptions)._tag === 'MoveOnly'
      ) {
        state.diagnostics.push(Diagnostic.partialMove(expression.span))
      }
      return true
    }
    case 'ReferentPlace': {
      if (!checkExpression(state, live, expression.subject, false, guard, escaping)) return false
      if (
        consuming &&
        categoryOf(state.index, expression.type, state.copyAssumptions)._tag === 'MoveOnly'
      ) {
        state.diagnostics.push(Diagnostic.borrowedMove(expression.span))
      }
      return true
    }
    case 'IndexPlace': {
      const place = placeOf(expression)
      if (place !== undefined) {
        if (!checkPlaceInterior(state, live, expression, guard, escaping)) return false
        checkPath(state, live, place.root, place.path, expression.span)
        if (
          consuming &&
          categoryOf(state.index, expression.type, state.copyAssumptions)._tag === 'MoveOnly'
        )
          state.diagnostics.push(
            Diagnostic.explicitMoveRequired(
              state.bindings.get(siteKey(place.root))?.name ?? '?',
              expression.span,
            ),
          )
        return true
      }
      if (!checkExpression(state, live, expression.subject, false, guard, escaping)) return false
      if (!checkExpression(state, live, expression.index, false, guard, escaping)) return false
      if (
        consuming &&
        categoryOf(state.index, expression.type, state.copyAssumptions)._tag === 'MoveOnly'
      ) {
        state.diagnostics.push(Diagnostic.partialMove(expression.span))
      }
      return true
    }
    case 'SliceBorrow':
    case 'ValueBorrow': {
      if (expression.root._tag === 'TemporarySliceRoot') {
        if (!checkExpression(state, live, expression.root.value, true, guard, escaping))
          return false
        return true
      }
      let site: BindingSite
      if (expression.root._tag === 'BindingSliceRoot') {
        site = { _tag: 'Let', binding: expression.root.binding }
      } else if (expression.root._tag === 'ParameterSliceRoot') {
        site = { _tag: 'Parameter', parameter: expression.root.parameter }
      } else {
        site = { _tag: 'Pattern', binding: expression.root.binding }
      }
      for (const selector of expression.selectors)
        if (
          selector._tag !== 'Field' &&
          !checkExpression(state, live, selector.index, false, guard, escaping)
        )
          return false
      const rootType = state.bindings.get(siteKey(site))?.type
      const path =
        rootType !== undefined && (Type.isReference(rootType) || Type.isSlice(rootType))
          ? []
          : (selectorPath(expression.selectors) ?? [])
      checkPath(state, live, site, path, expression.span)
      return true
    }
    case 'SliceLength':
      if (!checkExpression(state, live, expression.slice, false, guard, escaping)) return false
      return true
    case 'SliceIndexPlace': {
      if (!checkExpression(state, live, expression.slice, false, guard, escaping)) return false
      if (!checkExpression(state, live, expression.index, false, guard, escaping)) return false
      if (
        consuming &&
        categoryOf(state.index, expression.type, state.copyAssumptions)._tag === 'MoveOnly'
      ) {
        state.diagnostics.push(Diagnostic.borrowedMove(expression.span))
      }
      return true
    }
    case 'FunctionItem':
      return true
    case 'CallableSection': {
      const environment = callableEnvironment(state, expression)
      if (
        !state.callables.some((candidate) =>
          Tir.sameExecutableSite(candidate.site, expression.site),
        )
      ) {
        state.callables.push(environment)
      }
      for (const capture of expression.captures) {
        if (
          !checkExpression(state, live, capture.value, capture.access === 'Take', guard, escaping)
        )
          return false
      }
      return true
    }
    case 'CallableApply': {
      const stored = storedCallableInvocationAccess(
        state,
        expression.callee,
        expression.access,
        expression.span,
      )
      if (stored !== undefined) state.diagnostics.push(stored)
      const checkCallee = (): boolean => {
        if (storedCallableContract(expression.callee) !== undefined) {
          const place = placeOf(expression.callee)
          if (expression.access !== 'Take' || stored !== undefined || place === undefined) {
            if (!checkExpression(state, live, expression.callee, false, guard, escaping))
              return false
            return true
          }
          if (!checkPlaceInterior(state, live, expression.callee, guard, escaping)) return false
          checkPath(state, live, place.root, place.path, expression.callee.span, 'Move')
          retainTemporary(state, expression.callee)
          return true
        }
        const site = useSite(expression.callee)
        if (site !== undefined && expression.access === 'Take') {
          checkUse(state, live, site, expression.callee.span, true)
          retainTemporary(state, expression.callee)
          return true
        }
        if (
          !checkExpression(
            state,
            live,
            expression.callee,
            expression.access === 'Take',
            guard,
            escaping,
          )
        )
          return false
        return true
      }
      const checkArguments = (): boolean => {
        for (const [ordinal, argument] of expression.arguments.entries()) {
          // A staged argument is captured into the new environment, not passed to a body.
          const capture = expression.staged?.captures.at(ordinal)
          if (
            !checkExpression(
              state,
              live,
              argument,
              capture === undefined ? argumentConsumes(argument) : capture.access === 'Take',
              guard,
              escaping,
            )
          )
            return false
        }
        return true
      }
      if (expression.evaluation === 'LeftThenCallable') {
        if (!checkArguments()) return false
        if (!checkCallee()) return false
      } else {
        if (!checkCallee()) return false
        if (!checkArguments()) return false
      }
      return true
    }
    case 'BuiltinCall': {
      for (const [ordinal, argument] of expression.arguments.entries()) {
        const operand = expression.interfaceOperation?.contract.operands.at(ordinal)
        const type = operand?.type._tag === 'Resolved' ? operand.type.type : undefined
        if (
          !checkExpression(
            state,
            live,
            argument,
            type !== undefined && !Type.isReference(type) && !Type.isSlice(type),
            guard,
            escaping,
          )
        )
          return false
      }
      return true
    }
    case 'InterfaceOperationCall': {
      for (const [ordinal, argument] of expression.arguments.entries()) {
        const operand = expression.contract.operands.at(ordinal)
        const type = operand?.type._tag === 'Resolved' ? operand.type.type : undefined
        if (
          !checkExpression(
            state,
            live,
            argument,
            type !== undefined && !Type.isReference(type) && !Type.isSlice(type),
            guard,
            escaping,
          )
        )
          return false
      }
      return true
    }
    case 'ForeignApply':
      if (
        expression.evaluation === 'CalleeThenArguments' &&
        !checkExpression(state, live, expression.callee, false, guard, escaping)
      )
        return false
      for (const argument of expression.arguments)
        if (!checkExpression(state, live, argument, argumentConsumes(argument), guard, escaping))
          return false
      if (
        expression.evaluation === 'LeftThenCallable' &&
        !checkExpression(state, live, expression.callee, false, guard, escaping)
      )
        return false
      return true
    case 'Call': {
      for (const argument of expression.arguments)
        if (!checkExpression(state, live, argument, argumentConsumes(argument), guard, escaping))
          return false
      return true
    }
    case 'EffectConstruct': {
      for (const argument of expression.arguments)
        if (!checkExpression(state, live, argument, argumentConsumes(argument), guard, escaping))
          return false
      return true
    }
    case 'ServiceEffectConstruct': {
      for (const argument of expression.arguments)
        if (!checkExpression(state, live, argument, argumentConsumes(argument), guard, escaping))
          return false
      return true
    }
    case 'EffectBlock': {
      for (const capture of expression.captures) {
        let site: BindingSite | undefined
        if (capture.binding !== undefined) {
          site = { _tag: 'Let', binding: capture.binding }
        } else if (capture.pattern !== undefined) {
          site = { _tag: 'Pattern', binding: capture.pattern }
        } else if (capture.parameter !== undefined) {
          site = { _tag: 'Parameter', parameter: capture.parameter }
        } else {
          site = undefined
        }
        if (site?._tag === 'Pattern')
          checkPatternUse(
            state,
            live,
            site,
            capture.span,
            capture.access === 'Take',
            guard,
            escaping,
          )
        else if (site !== undefined)
          checkUse(state, live, site, capture.span, capture.access === 'Take')
      }
      return true
    }
    case 'EffectBindRequirement': {
      if (!checkExpression(state, live, expression.protected, false, guard, escaping)) return false
      let site: BindingSite | undefined
      if (expression.provider.binding !== undefined) {
        site = { _tag: 'Let', binding: expression.provider.binding }
      } else if (expression.provider.parameter !== undefined) {
        site = { _tag: 'Parameter', parameter: expression.provider.parameter }
      } else {
        site = undefined
      }
      if (site !== undefined)
        checkUse(
          state,
          live,
          site,
          expression.provider.span,
          expression.provider.captureAccess === 'Take',
        )
      return true
    }
    case 'EffectCatch':
      // The sealed primitive has the same owned operands as its ordinary callable contract.
      // Visiting both here preserves take-once use checking after elaboration replaces the call
      // with dedicated TIR.
      if (
        !checkExpression(
          state,
          live,
          expression.protected,
          argumentConsumes(expression.protected),
          guard,
          escaping,
        )
      )
        return false
      if (
        !checkExpression(
          state,
          live,
          expression.handler,
          argumentConsumes(expression.handler),
          guard,
          escaping,
        )
      )
        return false
      return true
    case 'Run': {
      const stored = storedEffectRunAccess(state, expression.subject, expression.span)
      if (stored !== undefined) state.diagnostics.push(stored)
      const storedContract = storedEffectContract(expression.subject)
      const place = placeOf(expression.subject)
      if (storedContract?.access === 'Take' && stored === undefined && place !== undefined) {
        if (!checkPlaceInterior(state, live, expression.subject, guard, escaping)) return false
        checkPath(state, live, place.root, place.path, expression.subject.span, 'Move')
        return true
      }
      const site = useSite(expression.subject)
      if (
        site !== undefined &&
        expression.subject._tag !== 'Unavailable' &&
        Type.isEffect(expression.subject.type) &&
        expression.subject.type.access === 'Take'
      ) {
        checkUse(state, live, site, expression.span, true)
      } else if (!checkExpression(state, live, expression.subject, false, guard, escaping))
        return false
      return true
    }
    case 'Match':
      return state.checkMatch(live, expression, consuming, guard, escaping)
    case 'Replace': {
      // The write half mirrors assignment: index selectors evaluate, a projected root must be
      // usable, and a value consuming the root itself is an overlapping assignment. The place
      // stays initialized throughout, so no partial move is recorded.
      for (const selector of expression.place.selectors) {
        if (selector._tag === 'Index' || selector._tag === 'SliceIndex') {
          if (!checkExpression(state, live, selector.index, false)) return false
        }
      }
      let rootSite: BindingSite
      if (expression.place._tag === 'WritePlace') {
        rootSite = ownedWriteSite(expression.place.root)
      } else if (expression.place.root._tag === 'BindingSliceRoot') {
        rootSite = { _tag: 'Let', binding: expression.place.root.binding }
      } else {
        rootSite = {
          _tag: 'Parameter',
          parameter: expression.place.root.parameter,
        }
      }
      let path =
        expression.place._tag === 'WritePlace'
          ? selectorPath(expression.place.selectors)
          : undefined
      const canonical = canonicalPlace(state, { root: rootSite, path: path ?? [] })
      if (canonical !== undefined) {
        rootSite = canonical.root
        if (path !== undefined) path = canonical.path
      }
      const rootKey = siteKey(rootSite)
      const root = state.bindings.get(rootKey)
      checkPath(state, live, rootSite, path ?? [], expression.place.span)
      const transitionMark = state.transitions.length
      if (!checkExpression(state, live, expression.value, true)) return false
      if (
        state.transitions
          .slice(transitionMark)
          .some(
            (transition) =>
              transition.kind !== 'Write' &&
              siteKey(transition.root) === rootKey &&
              (path === undefined || MovePath.overlaps(path, transition.path)),
          )
      ) {
        state.diagnostics.push(Diagnostic.overlappingAssignment(root?.name ?? '?', expression.span))
      }
      return true
    }
    default:
      return true
  }
}

/**
 * The expressions one statement evaluates in its own scope: control-flow bodies are excluded
 * because the statement walker recurses into them itself, and would otherwise observe the same
 * expression twice.
 */
const statementRootExpressions = (statement: Tir.Statement): ReadonlyArray<Tir.Expression> => {
  switch (statement._tag) {
    case 'Bind':
      return [statement.initializer]
    case 'PatternBind':
      return [statement.selection.subject]
    case 'Evaluate':
      return [statement.expression]
    case 'Return':
    case 'Fail':
    case 'Drop':
      return [statement.expression]
    case 'Write':
      return [
        ...statement.place.selectors.flatMap((selector) =>
          selector._tag === 'Index' || selector._tag === 'SliceIndex' ? [selector.index] : [],
        ),
        statement.value,
      ]
    case 'If':
    case 'While':
      return [statement.condition]
    case 'IfLet':
      return [statement.selection.subject]
    default:
      return []
  }
}

/** Effect blocks owned by this expression, stopping at each block: nested blocks belong to it. */
const deferredBlocks = (
  expression: Tir.Expression,
): ReadonlyArray<Extract<Tir.Expression, { readonly _tag: 'EffectBlock' }>> => {
  if (expression._tag === 'EffectBlock') return [expression]
  if (expression._tag === 'Match')
    return [
      expression.scrutinee,
      ...expression.arms.flatMap((arm) => [
        ...(arm.guard === undefined ? [] : [arm.guard]),
        ...(arm.body._tag === 'Expression' ? [arm.body.expression] : []),
      ]),
    ].flatMap(deferredBlocks)
  return Tir.expressionChildren(expression).flatMap(deferredBlocks)
}

const cleanupPlan = (state: CheckState, type: Type.Type): CleanupPlan.CleanupPlan => {
  state.work.cleanupPlanQueries += 1
  return CleanupPlan.cleanupPlan(state.index, type)
}

interface LoanAnalysis {
  readonly loanAccessChecks: number
  readonly loans: ReadonlyArray<LoanFact>
  readonly diagnostics: ReadonlyArray<Diagnostic.Diagnostic>
}

const borrowSite = (root: LoanView.BorrowRoot): BindingSite => {
  if (root._tag === 'BindingRoot') {
    return { _tag: 'Let', binding: root.binding.id }
  }
  if (root._tag === 'ParameterRoot') {
    return { _tag: 'Parameter', parameter: root.parameter.id }
  }
  if (root._tag === 'PatternRoot') {
    return { _tag: 'Pattern', binding: root.binding.id }
  }
  return { _tag: 'Temporary', owner: root.owner }
}

const sameSite = (left: BindingSite, right: BindingSite): boolean =>
  siteKey(left) === siteKey(right)

interface LoanEndpoint {
  readonly region: Tir.RegionId
  readonly span: SourceSpan.SourceSpan
  /**
   * Authored document order of the position this endpoint ends at. Endpoints raised from structured
   * exits carry TIR spans with no authored position and order last, exactly as their span-end did.
   */
  readonly order: number
  readonly cleanupOnly?: boolean
}

const analyzeLoans = (
  fn: LoanView.Body,
  index: DeclarationIndex.Index,
  copyAssumptions: ReadonlySet<string>,
  cleanupExits: ReadonlyArray<ExitPlan>,
  context: SemanticContext.SemanticContext,
): LoanAnalysis => {
  let loanAccessChecks = 0
  const loans: Array<LoanFact> = []
  const diagnostics: Array<Diagnostic.Diagnostic> = []

  const directSite = (
    expression: LoanView.Expression,
  ): { readonly site: BindingSite; readonly spelling: string } | undefined => {
    if (
      expression._tag === 'Move' ||
      expression._tag === 'FieldProjection' ||
      expression._tag === 'IndexProjection' ||
      expression._tag === 'ReferentProjection'
    )
      return directSite(expression.subject)
    if (expression._tag !== 'Identifier') return undefined
    if (expression.reference._tag === 'ResolvedBinding') {
      return {
        site: { _tag: 'Let', binding: expression.reference.binding.id },
        spelling: expression.reference.spelling,
      }
    }
    if (expression.reference._tag === 'ResolvedPattern')
      return {
        site: { _tag: 'Pattern', binding: expression.reference.binding.id },
        spelling: expression.reference.spelling,
      }
    if (expression.reference._tag === 'Resolved') {
      return {
        site: { _tag: 'Parameter', parameter: expression.reference.parameter.id },
        spelling: expression.reference.spelling,
      }
    }
    return undefined
  }

  const movedExecutableBindings = (expression: LoanView.Expression): ReadonlyArray<number> => {
    if (expression._tag === 'Move') {
      const site = directSite(expression.subject)?.site
      return site?._tag === 'Let' &&
        expression.subject.type._tag === 'Available' &&
        (Type.isEffect(expression.subject.type.type) ||
          Type.isCallable(expression.subject.type.type) ||
          Type.containsExecutableRepresentation(expression.subject.type.type))
        ? [site.binding.ordinal]
        : movedExecutableBindings(expression.subject)
    }
    if (expression._tag === 'StructLiteral' || expression._tag === 'UnionVariant')
      return expression.initializers.flatMap((initializer) =>
        movedExecutableBindings(initializer.expression),
      )
    if (expression._tag === 'ArrayLiteral')
      return expression.elements.flatMap((element) => movedExecutableBindings(element.expression))
    if (expression._tag === 'EffectCatch')
      return [
        ...movedExecutableBindings(expression.protected),
        ...movedExecutableBindings(expression.handler),
      ]
    if (expression._tag === 'Call')
      return expression.arguments.flatMap((argument) =>
        movedExecutableBindings(argument.expression),
      )
    if (expression._tag === 'CallableApply' || expression._tag === 'ForeignApply')
      return [
        ...movedExecutableBindings(expression.callee),
        ...expression.arguments.flatMap((argument) => movedExecutableBindings(argument.expression)),
      ]
    return []
  }

  // Authored positions order by document order; structured-exit cleanup always follows them.
  const endpointAt = (anchor: AuthoredHir.Anchor, region: Tir.RegionId): LoanEndpoint => ({
    region,
    span: context.spanOf(anchor),
    order: context.orderOf(anchor),
  })
  const cleanupEndpoint = (exit: ExitPlan, region: Tir.RegionId): LoanEndpoint => ({
    region,
    span: exit.span,
    order: Number.MAX_SAFE_INTEGER,
    cleanupOnly: true,
  })
  const runEnds = new Map<number, LoanEndpoint>()
  const callableEnds = new Map<number, LoanEndpoint>()
  const slotEnds = new Map<number, LoanEndpoint>()
  const viewEnds = new Map<number, LoanEndpoint>()
  const laterExecutableEnd = (
    left: LoanEndpoint | undefined,
    right: LoanEndpoint | undefined,
  ): LoanEndpoint | undefined => {
    if (left === undefined) return right
    if (right === undefined) return left
    return left.order > right.order || (left.order === right.order && left.cleanupOnly)
      ? left
      : right
  }
  // A descriptor passed inside a larger expression is used through that expression's completion,
  // not merely while evaluating its identifier. Otherwise a hidden backing owner can be dropped
  // between constructing a call argument and invoking the callee that reads it.
  const scanRunEnds = (
    expression: LoanView.Expression,
    region: Tir.RegionId,
    useAnchor: AuthoredHir.Anchor = expression.anchor,
  ): void => {
    switch (expression._tag) {
      case 'Run': {
        const site = directSite(expression.subject)?.site
        const bindings = [
          ...(site?._tag === 'Let' ? [site.binding.ordinal] : []),
          ...movedExecutableBindings(expression.subject),
        ]
        for (const binding of new Set(bindings)) {
          const previous = runEnds.get(binding)
          if (previous === undefined || previous.order < context.orderOf(expression.anchor)) {
            runEnds.set(binding, endpointAt(expression.anchor, region))
          }
        }
        scanRunEnds(expression.subject, region, useAnchor)
        return
      }
      case 'Move':
        scanRunEnds(expression.subject, region, useAnchor)
        return
      case 'ReferentProjection':
        scanRunEnds(expression.subject, region, useAnchor)
        return
      case 'Borrow':
      case 'FieldProjection':
        scanRunEnds(expression.subject, region, useAnchor)
        return
      case 'IndexProjection':
        scanRunEnds(expression.subject, region, useAnchor)
        scanRunEnds(expression.index, region, useAnchor)
        return
      case 'StructLiteral':
      case 'UnionVariant':
        for (const initializer of expression.initializers)
          scanRunEnds(initializer.expression, region, useAnchor)
        return
      case 'ArrayLiteral':
        for (const element of expression.elements)
          scanRunEnds(element.expression, region, useAnchor)
        return
      case 'Match':
        scanRunEnds(expression.scrutinee, region, useAnchor)
        for (const arm of expression.arms) {
          if (arm.guard !== undefined) scanRunEnds(arm.guard, region, useAnchor)
          if (arm.body._tag === 'Expression') scanRunEnds(arm.body.expression, region, useAnchor)
          else scanStatementRunEnds(arm.body.statements)
        }
        return
      case 'Operator':
      case 'ShortCircuit':
      case 'Call':
        for (const argument of expression.arguments)
          scanRunEnds(argument.expression, region, useAnchor)
        return
      case 'ForeignApply':
        if (expression.evaluation === 'CalleeThenArguments')
          scanRunEnds(expression.callee, region, useAnchor)
        for (const argument of expression.arguments)
          scanRunEnds(argument.expression, region, useAnchor)
        if (expression.evaluation === 'LeftThenCallable')
          scanRunEnds(expression.callee, region, useAnchor)
        return
      case 'CallableApply':
        if (expression.provenance._tag === 'PipelineCallableApplication') {
          for (const argument of expression.arguments)
            scanRunEnds(argument.expression, region, useAnchor)
          scanRunEnds(expression.callee, region, useAnchor)
        } else {
          scanRunEnds(expression.callee, region, useAnchor)
          for (const argument of expression.arguments)
            scanRunEnds(argument.expression, region, useAnchor)
        }
        {
          const site = directSite(expression.callee)?.site
          if (site?._tag === 'Let') {
            const previous = callableEnds.get(site.binding.ordinal)
            if (previous === undefined || previous.order <= context.orderOf(expression.anchor)) {
              callableEnds.set(site.binding.ordinal, endpointAt(expression.anchor, region))
            }
          }
        }
        return
      case 'CallableSection':
        for (const capture of expression.captures)
          scanRunEnds(capture.expression, region, useAnchor)
        return
      case 'PlaceReplace':
        scanRunEnds(expression.destination, region, useAnchor)
        scanRunEnds(expression.value, region, useAnchor)
        return
      case 'EnumValue':
        scanRunEnds(expression.argument, region, useAnchor)
        return
      case 'CompileError':
        scanRunEnds(expression.message, region, useAnchor)
        return
      case 'EffectCatch':
        scanRunEnds(expression.protected, region, useAnchor)
        scanRunEnds(expression.handler, region, useAnchor)
        return
      case 'EffectBindRequirement':
        scanRunEnds(expression.protected, region, useAnchor)
        return
      case 'EffectBlock':
        scanStatementRunEnds(expression.statements)
        return
      case 'FunctionItem':
        return
      case 'Integer':
      case 'Duration':
      case 'Floating':
      case 'Boolean':
      case 'Character':
      case 'Constant':
      case 'ForeignStatic':
      case 'StaticText':
      case 'Unit':
      case 'EnumMember':
        return
      case 'Identifier': {
        const site = directSite(expression)?.site
        if (
          site?._tag === 'Let' &&
          expression.type._tag === 'Available' &&
          Type.isCallable(expression.type.type)
        ) {
          // A later non-invocation use may store or escape the callable. The CallableApply case
          // records the same occurrence again after visiting its callee, so only a last known
          // invocation (or explicit drop) shortens the capture loan.
          callableEnds.delete(site.binding.ordinal)
        }
        if (
          site?._tag === 'Let' &&
          expression.type._tag === 'Available' &&
          Type.isSlot(expression.type.type)
        ) {
          const previous = slotEnds.get(site.binding.ordinal)
          if (previous === undefined || previous.order < context.orderOf(expression.anchor))
            slotEnds.set(site.binding.ordinal, endpointAt(expression.anchor, region))
        }
        if (
          site?._tag === 'Let' &&
          expression.type._tag === 'Available' &&
          Type.storageLifetimes(expression.type.type).length > 0
        ) {
          const previous = viewEnds.get(site.binding.ordinal)
          if (previous === undefined || previous.order < context.orderOf(useAnchor)) {
            viewEnds.set(site.binding.ordinal, endpointAt(useAnchor, region))
          }
        }
        return
      }
      default:
        // Exhaustive so a new expression fact kind cannot silently hide loan-relevant uses.
        expression satisfies never
        return
    }
  }
  const scanStatementRunEnds = (facts: ReadonlyArray<LoanView.Statement>): void => {
    for (const statement of facts) {
      switch (statement._tag) {
        case 'UnsafeStatement':
          scanStatementRunEnds(statement.statements)
          break
        case 'BindStatement':
          scanRunEnds(statement.binding.initializer, statement.region)
          break
        case 'PatternBindStatement':
          scanRunEnds(statement.selection.source, statement.region)
          break
        case 'ExpressionStatement':
          scanRunEnds(statement.expression, statement.region)
          break
        case 'IfStatement':
          scanRunEnds(statement.condition, statement.region)
          scanStatementRunEnds(statement.taken)
          scanStatementRunEnds(statement.otherwise)
          break
        case 'IfLetStatement':
          scanRunEnds(statement.selection.source, statement.region)
          scanStatementRunEnds(statement.taken)
          scanStatementRunEnds(statement.otherwise)
          break
        case 'WriteStatement':
          scanRunEnds(statement.destination, statement.region)
          scanRunEnds(statement.value, statement.region)
          break
        case 'WhileStatement':
          scanRunEnds(statement.condition, statement.region)
          scanStatementRunEnds(statement.body)
          break
        case 'ReturnStatement':
        case 'FailStatement':
          scanRunEnds(statement.expression, statement.region)
          break
        case 'DropStatement': {
          scanRunEnds(statement.expression, statement.region)
          const site = directSite(statement.expression)?.site
          if (site?._tag === 'Let') {
            callableEnds.set(site.binding.ordinal, endpointAt(statement.anchor, statement.region))
          }
          break
        }
        case 'BreakStatement':
        case 'ContinueStatement':
          break
      }
    }
  }
  scanStatementRunEnds(fn.statements)
  // A destructor can observe retained storage after the last authored read.
  for (const exit of cleanupExits) {
    if (exit.region === undefined) continue
    for (const release of exit.releases) {
      if (
        release.binding.site._tag !== 'Let' ||
        LifetimeFlow.cleanupLifetimes(release.cleanup, release.initialization).length === 0
      )
        continue
      // Cleanup observes storage after every authored read, so it supersedes any authored
      // endpoint; between two structured exits the later-ending one still wins.
      const key = release.binding.site.binding.ordinal
      const previous = viewEnds.get(key)
      if (previous === undefined || !previous.cleanupOnly || previous.span.end <= exit.span.end)
        viewEnds.set(key, cleanupEndpoint(exit, exit.region))
    }
  }

  const executableAliases = new Map<number, Set<number>>()
  const captureKey = (anchor: AuthoredHir.Anchor, ordinal: number): string =>
    `${AuthoredIdentity.anchorKey(anchor)}:${ordinal}`
  const returnedCallableCaptures = new Set<string>()
  const bindings = [...fn.bindings]
  LoanView.visitExpressions(fn.statements, (expression) => {
    if (expression._tag === 'EffectBlock') bindings.push(...expression.bindings)
  })
  const bindingInitializers = new Map(
    bindings.map((binding) => [binding.id.ordinal, binding.initializer] as const),
  )
  const returnedCallable = (
    expression: LoanView.Expression,
    seen: ReadonlySet<number> = new Set(),
  ): Extract<LoanView.Expression, { readonly _tag: 'CallableSection' }> | undefined => {
    if (expression._tag === 'Move') return returnedCallable(expression.subject, seen)
    if (expression._tag === 'CallableSection') return expression
    const site = directSite(expression)?.site
    if (site?._tag !== 'Let' || seen.has(site.binding.ordinal)) return undefined
    const initializer = bindingInitializers.get(site.binding.ordinal)
    return initializer === undefined
      ? undefined
      : returnedCallable(initializer, new Set(seen).add(site.binding.ordinal))
  }
  const returnedExpressions = (
    statements: ReadonlyArray<LoanView.Statement>,
  ): ReadonlyArray<LoanView.Expression> =>
    statements.flatMap((statement): ReadonlyArray<LoanView.Expression> => {
      switch (statement._tag) {
        case 'ReturnStatement':
          return [statement.expression]
        case 'UnsafeStatement':
          return returnedExpressions(statement.statements)
        case 'IfStatement':
        case 'IfLetStatement':
          return [
            ...returnedExpressions(statement.taken),
            ...returnedExpressions(statement.otherwise),
          ]
        case 'WhileStatement':
          return returnedExpressions(statement.body)
        default:
          return []
      }
    })
  // The root a captured loan is tied to. A borrow of a borrowed parameter reborrows the caller's
  // loan, so the callable may leave this function with it; only a root this function owns ends here.
  const capturedLoanRoot = (
    expression: LoanView.Expression,
  ): { readonly spelling: string; readonly ownedHere: boolean } | undefined => {
    if (expression._tag === 'Move') return capturedLoanRoot(expression.subject)
    if (expression._tag === 'Borrow') return capturedLoanRoot(expression.subject)
    if (expression._tag !== 'Identifier') return undefined
    if (expression.reference._tag === 'ResolvedBinding')
      return { spelling: expression.reference.spelling, ownedHere: true }
    if (expression.reference._tag !== 'Resolved') return undefined
    const declared = expression.reference.parameter.declaredType
    const borrowedParameter =
      declared._tag === 'Resolved' &&
      (Type.isReference(declared.type) || Type.isSlice(declared.type))
    return { spelling: expression.reference.spelling, ownedHere: !borrowedParameter }
  }
  const diagnosedEscapes = new Set<string>()
  for (const returned of returnedExpressions(fn.statements)) {
    const callable = returnedCallable(returned)
    if (callable === undefined) continue
    for (const capture of callable.captures) {
      if (capture.access !== 'Shared' && capture.access !== 'Exclusive') continue
      const root = capturedLoanRoot(capture.expression)
      if (root !== undefined && !root.ownedHere) continue
      const key = captureKey(capture.expression.anchor, capture.ordinal)
      returnedCallableCaptures.add(key)
      if (diagnosedEscapes.has(key)) continue
      diagnosedEscapes.add(key)
      diagnostics.push(
        Diagnostic.executableBorrowEscape(
          'Callable',
          root?.spelling ?? directSite(capture.expression)?.spelling ?? '?',
          capture.access,
          context.spanOf(capture.expression.anchor),
          context.spanOf(returned.anchor),
        ),
      )
    }
  }
  for (const binding of bindings) {
    const directAlias = directSite(binding.initializer)?.site
    const callableAlias =
      directAlias?._tag === 'Let' &&
      binding.inferredType._tag === 'Available' &&
      Type.isCallable(binding.inferredType.type)
        ? [directAlias.binding.ordinal]
        : []
    for (const source of new Set([
      ...movedExecutableBindings(binding.initializer),
      ...callableAlias,
    ])) {
      const destinations = executableAliases.get(source)
      if (destinations === undefined) executableAliases.set(source, new Set([binding.id.ordinal]))
      else destinations.add(binding.id.ordinal)
    }
  }
  let propagatedExecutableEnd = true
  while (propagatedExecutableEnd) {
    propagatedExecutableEnd = false
    for (const [source, destinations] of executableAliases) {
      for (const destination of destinations) {
        const runEnding = runEnds.get(destination)
        const previousRunEnding = runEnds.get(source)
        if (
          runEnding !== undefined &&
          (previousRunEnding === undefined || previousRunEnding.order < runEnding.order)
        ) {
          runEnds.set(source, runEnding)
          propagatedExecutableEnd = true
        }
        const ending = callableEnds.get(destination)
        const previousEnding = callableEnds.get(source)
        if (
          ending === undefined ||
          (previousEnding !== undefined && previousEnding.order >= ending.order)
        )
          continue
        callableEnds.set(source, ending)
        propagatedExecutableEnd = true
      }
    }
  }

  const assumptions = Lifetime.assumptions(fn.lifetimeFlow?.input.constraints ?? [])
  const returnedArgumentOrdinals = (expression: LoanView.Expression): ReadonlySet<number> =>
    new Set(
      LoanView.retainedResultArguments(expression, assumptions).map(
        (argument) => argument.id.ordinal,
      ),
    )
  const returnedSources = (expression: LoanView.Expression): ReadonlyArray<LoanView.Expression> => {
    const arguments_ = LoanView.retainedResultArguments(expression, assumptions).map(
      (argument) => argument.expression,
    )
    if (
      expression._tag === 'CallableApply' &&
      expression.callee.type._tag === 'Available' &&
      expression.type._tag === 'Available' &&
      LoanView.retainsLifetimes(expression.callee.type.type, expression.type.type, assumptions)
    )
      return [...arguments_, expression.callee]
    return arguments_
  }
  const viewRoots = new Map<number, ReadonlyArray<LoanReferent>>()
  const viewAliases = new Map<number, ReadonlyArray<number>>()
  const rootsOf = (
    root: BindingSite,
    path: ReadonlyArray<ReferentSelector> = [],
  ): ReadonlyArray<LoanReferent> => {
    const sources = root._tag === 'Let' ? viewRoots.get(root.binding.ordinal) : undefined
    return sources === undefined
      ? [{ root, path }]
      : sources.map((source) => ({ root: source.root, path: [...source.path, ...path] }))
  }
  const physicalPlace = (expression: LoanView.Expression): LoanReferent | undefined => {
    if (expression._tag === 'Move') return physicalPlace(expression.subject)
    if (expression._tag === 'Borrow' && expression.formation._tag !== 'Unavailable')
      return { root: borrowSite(expression.formation.root), path: expression.formation.root.path }
    if (expression._tag === 'FieldProjection' && expression.state._tag === 'Resolved') {
      const subject = physicalPlace(expression.subject)
      return subject === undefined
        ? undefined
        : {
            root: subject.root,
            path: [
              ...subject.path,
              {
                _tag: 'Field',
                field: expression.state.field.id,
                span: context.spanOf(expression.anchor),
              },
            ],
          }
    }
    if (
      expression._tag === 'IndexProjection' &&
      expression.array !== undefined &&
      (expression.bounds._tag === 'Proven' || expression.bounds._tag === 'Runtime')
    ) {
      const subject = physicalPlace(expression.subject)
      return subject === undefined
        ? undefined
        : {
            root: subject.root,
            path: [
              ...subject.path,
              {
                _tag: 'Index',
                index: expression.index,
                array: expression.array,
                bounds: expression.bounds,
                span: context.spanOf(expression.anchor),
              },
            ],
          }
    }
    const direct = directSite(expression)?.site
    return direct === undefined ? undefined : { root: direct, path: [] }
  }
  const borrowedRootType = (expression: LoanView.Expression): Type.Type | undefined => {
    if (expression._tag === 'Borrow') return borrowedRootType(expression.subject)
    if (
      expression._tag === 'FieldProjection' ||
      expression._tag === 'IndexProjection' ||
      expression._tag === 'ReferentProjection' ||
      expression._tag === 'Move'
    ) {
      const type = expression.subject.type
      return type._tag === 'Available' && (Type.isReference(type.type) || Type.isSlice(type.type))
        ? type.type
        : borrowedRootType(expression.subject)
    }
    if (expression._tag !== 'Identifier' || expression.type._tag !== 'Available') return undefined
    const type = expression.type.type
    return Type.isReference(type) || Type.isSlice(type) ? type : undefined
  }
  const sourceReferents = (expression: LoanView.Expression): ReadonlyArray<LoanReferent> => {
    if (expression._tag === 'Borrow' && expression.formation._tag !== 'Unavailable') {
      const formation = expression.formation
      const root = borrowSite(formation.root)
      const descriptor =
        expression.type._tag === 'Available' &&
        Type.isReference(expression.type.type) &&
        expression.subject.type._tag === 'Available' &&
        (Type.isReference(expression.subject.type.type) ||
          Type.isSlice(expression.subject.type.type)) &&
        Type.equals(expression.type.type.target, expression.subject.type.type)
      const projectedReferent = !descriptor && borrowedRootType(expression) !== undefined
      // Borrowing a container's own storage is distinct from borrowing the external payload
      // it retains. Only reborrow formations inherit the descriptor's referent authority.
      return projectedReferent ||
        formation._tag === 'ValueReborrow' ||
        formation._tag === 'SliceReborrow'
        ? rootsOf(root, formation.root.path)
        : [{ root, path: formation.root.path }]
    }
    if (fn.lifetimeFlow !== undefined && expression.type._tag === 'Available') {
      const origins = LifetimeFlow.sources(fn.lifetimeFlow, expression.type.type).flatMap(
        (origin) =>
          origin.root === undefined
            ? []
            : rootsOf(
                origin.root,
                (origin.path ?? []).map((selector): ReferentSelector => {
                  if (selector._tag === 'Field') return selector
                  const { index: _index, ...portable } = selector
                  return portable
                }),
              ),
      )
      if (origins.length > 0) return origins
    }
    const returned = returnedSources(expression)
    if (returned.length > 0) return returned.flatMap(sourceReferents)
    const direct = physicalPlace(expression)
    return direct === undefined ? [] : rootsOf(direct.root, direct.path)
  }
  for (const binding of bindings) {
    if (
      binding.inferredType._tag !== 'Available' ||
      Type.storageLifetimes(binding.inferredType.type).length === 0
    )
      continue
    const sources = sourceReferents(binding.initializer)
    if (sources.length > 0) viewRoots.set(binding.id.ordinal, sources)
    const aliases = [binding.initializer, ...returnedSources(binding.initializer)].flatMap(
      (source) => {
        const direct = physicalPlace(source)?.root
        return direct?._tag === 'Let' ? [direct.binding.ordinal] : []
      },
    )
    if (aliases.length > 0) viewAliases.set(binding.id.ordinal, aliases)
    if (
      binding.initializer._tag === 'CallableApply' &&
      binding.initializer.callee.type._tag === 'Available' &&
      LoanView.retainsLifetimes(
        binding.initializer.callee.type.type,
        binding.inferredType.type,
        assumptions,
      )
    ) {
      if (binding.initializer.callee._tag === 'CallableSection')
        for (const capture of binding.initializer.callee.captures) {
          if (
            capture.expression.type._tag === 'Available' &&
            LoanView.retainsLifetimes(
              capture.expression.type.type,
              binding.inferredType.type,
              assumptions,
            )
          )
            returnedCallableCaptures.add(captureKey(capture.expression.anchor, capture.ordinal))
        }
      const callable = directSite(binding.initializer.callee)?.site
      const ending = viewEnds.get(binding.id.ordinal)
      if (callable?._tag === 'Let' && ending !== undefined) {
        const previous = callableEnds.get(callable.binding.ordinal)
        if (
          previous === undefined ||
          previous.order < ending.order ||
          (previous.order === ending.order && ending.cleanupOnly && !previous.cleanupOnly)
        )
          callableEnds.set(callable.binding.ordinal, ending)
      }
    }
  }
  const expressionsByAnchor = new Map<string, LoanView.Expression>()
  LoanView.visitExpressions(fn.statements, (expression) => {
    const key = AuthoredIdentity.anchorKey(expression.anchor)
    // An implicit receiver borrow shares its syntax with its subject. Preserve the borrow's
    // storage provenance instead of replacing it with the subject's retained payload loans.
    if (expressionsByAnchor.get(key)?._tag !== 'Borrow') expressionsByAnchor.set(key, expression)
  })
  const referentsAt = (
    root: BindingSite,
    anchor: AuthoredHir.Anchor | undefined,
  ): ReadonlyArray<LoanReferent> => {
    const expression =
      anchor === undefined ? undefined : expressionsByAnchor.get(AuthoredIdentity.anchorKey(anchor))
    const sources = expression === undefined ? [] : sourceReferents(expression)
    return [
      ...new Map(
        (sources.length === 0 ? rootsOf(root) : sources).map((source) => [
          referentKey(source),
          source,
        ]),
      ).values(),
    ]
  }
  // A descriptor inherits authority from its originating loan; reborrowing uses that capability.
  // An outstanding sibling loan is absent from the descriptor's provenance and still conflicts.
  const grantsParentCapability = (
    loan: LoanFact,
    root: BindingSite,
    anchor: AuthoredHir.Anchor | undefined,
  ): boolean => {
    if (sameSite(loan.root, root) || fn.lifetimeFlow === undefined || anchor === undefined)
      return false
    const expression = expressionsByAnchor.get(AuthoredIdentity.anchorKey(anchor))
    const parent = expression === undefined ? undefined : borrowedRootType(expression)
    return (
      parent !== undefined &&
      LifetimeFlow.sources(fn.lifetimeFlow, parent).some(
        (origin) =>
          origin.span.sourceId === loan.startSpan.sourceId &&
          origin.span.start === loan.startSpan.start &&
          origin.span.end === loan.startSpan.end,
      )
    )
  }
  const loanConflicts = (
    loan: LoanFact,
    root: BindingSite,
    anchor: AuthoredHir.Anchor | undefined,
  ): boolean =>
    !grantsParentCapability(loan, root, anchor) &&
    referentsAt(root, anchor).some((source) =>
      loan.referents.some((referent) => referentsOverlap(referent, source)),
    )

  let propagatedViewEnd = true
  while (propagatedViewEnd) {
    propagatedViewEnd = false
    for (const [alias, sources] of viewAliases)
      for (const source of sources) {
        const ending = viewEnds.get(alias)
        const previous = viewEnds.get(source)
        if (
          ending !== undefined &&
          (previous === undefined ||
            previous.order < ending.order ||
            (previous.order === ending.order && ending.cleanupOnly && !previous.cleanupOnly))
        ) {
          viewEnds.set(source, ending)
          propagatedViewEnd = true
        }
      }
  }

  // An Effect leaving this function may not retain a borrow rooted in storage this function owns:
  // a local owner, an owned parameter, a pattern binding, or a temporary's hidden owner. A reborrow
  // of a borrowed parameter is rooted in the caller and travels freely.
  // Views, Effects, and callables enter an environment by value (their descriptor or handle is
  // copied), so capturing one is not a borrow of the binding that holds it.
  const storedByValue = (type: Type.Type | undefined): boolean =>
    type !== undefined &&
    (Type.isReference(type) || Type.isSlice(type) || Type.isEffect(type) || Type.isCallable(type))
  const ownedParameter = (parameter: Tir.LocalId): boolean => {
    const declared = fn.declaration.parameters.find(
      (candidate) => candidate.id.ordinal === parameter.ordinal,
    )
    const type = declared?.declaredType._tag === 'Resolved' ? declared.declaredType.type : undefined
    return type !== undefined && !storedByValue(type)
  }
  const escapingRoot = (root: BindingSite | undefined): boolean =>
    root !== undefined && (root._tag === 'Parameter' ? ownedParameter(root.parameter) : true)
  interface EscapingCapture {
    readonly spelling: string
    readonly access: 'Shared' | 'Exclusive'
    readonly span: SourceSpan.SourceSpan
    /** Absent for an effect capture, which names its binding rather than an authored expression. */
    readonly anchor?: AuthoredHir.Anchor
  }
  const captureRoots = (
    reference: LoanView.Local,
    access: 'Copy' | 'Shared' | 'Exclusive' | 'Take',
  ): ReadonlyArray<BindingSite> => {
    if (reference._tag === 'BindingFact') {
      const view = viewRoots.get(reference.id.ordinal)
      if (view !== undefined) return view.map((referent) => referent.root)
      const type =
        reference.inferredType._tag === 'Available' ? reference.inferredType.type : undefined
      return (access === 'Shared' || access === 'Exclusive') && !storedByValue(type)
        ? [{ _tag: 'Let', binding: reference.id }]
        : []
    }
    if (reference._tag === 'PatternBinding') {
      const type = reference.type._tag === 'Available' ? reference.type.type : undefined
      return (access === 'Shared' || access === 'Exclusive') && !storedByValue(type)
        ? [{ _tag: 'Pattern', binding: reference.id }]
        : []
    }
    return access === 'Shared' || access === 'Exclusive'
      ? [{ _tag: 'Parameter', parameter: reference.id }]
      : []
  }
  const effectEscapes = (
    expression: LoanView.Expression,
    seen: ReadonlySet<number> = new Set(),
  ): ReadonlyArray<EscapingCapture> => {
    switch (expression._tag) {
      case 'Move':
        return effectEscapes(expression.subject, seen)
      case 'Identifier': {
        const site = directSite(expression)?.site
        if (site?._tag !== 'Let' || seen.has(site.binding.ordinal)) return []
        const initializer = bindingInitializers.get(site.binding.ordinal)
        return initializer === undefined
          ? []
          : effectEscapes(initializer, new Set(seen).add(site.binding.ordinal))
      }
      case 'EffectBlock':
        return expression.captures.flatMap((capture) =>
          captureRoots(capture.reference, capture.access).some(escapingRoot)
            ? [
                {
                  spelling:
                    capture.reference.name._tag === 'Present'
                      ? capture.reference.name.spelling
                      : '?',
                  access: capture.access === 'Exclusive' ? 'Exclusive' : ('Shared' as const),
                  span: capture.span,
                  ...(capture.expression === undefined
                    ? {}
                    : { anchor: capture.expression.anchor }),
                } satisfies EscapingCapture,
              ]
            : [],
        )
      case 'EffectCatch':
        return [
          ...effectEscapes(expression.protected, seen),
          ...effectEscapes(expression.handler, seen),
        ]
      case 'EffectBindRequirement': {
        const provider = expression.provider
        return [
          ...effectEscapes(expression.protected, seen),
          ...(provider !== undefined &&
          captureRoots(provider.reference, provider.captureAccess).some(escapingRoot)
            ? [
                {
                  spelling:
                    provider.reference.name._tag === 'Present'
                      ? provider.reference.name.spelling
                      : '?',
                  access:
                    provider.captureAccess === 'Exclusive' ? 'Exclusive' : ('Shared' as const),
                  span: provider.span,
                } satisfies EscapingCapture,
              ]
            : []),
        ]
      }
      case 'Call': {
        if (expression.type._tag !== 'Available' || !Type.isEffect(expression.type.type)) return []
        return expression.arguments.flatMap((argument) => {
          const candidate = argument.expression
          if (candidate._tag !== 'Borrow' || candidate.formation._tag === 'Unavailable')
            return effectEscapes(candidate, seen)
          return sourceReferents(candidate).some((referent) => escapingRoot(referent.root))
            ? [
                {
                  spelling: directSite(candidate.subject)?.spelling ?? '?',
                  access: candidate.access,
                  span: context.spanOf(candidate.anchor),
                  anchor: candidate.anchor,
                } satisfies EscapingCapture,
              ]
            : []
        })
      }
      default:
        return []
    }
  }
  for (const returned of returnedExpressions(fn.statements)) {
    for (const capture of effectEscapes(returned)) {
      const key =
        capture.anchor === undefined
          ? `${capture.span.sourceId}:${capture.span.start}:${capture.span.end}:0`
          : captureKey(capture.anchor, 0)
      if (diagnosedEscapes.has(key)) continue
      diagnosedEscapes.add(key)
      diagnostics.push(
        Diagnostic.executableBorrowEscape(
          'Effect',
          capture.spelling,
          capture.access,
          capture.span,
          context.spanOf(returned.anchor),
        ),
      )
    }
  }

  const delayedLoansAt = (span: SourceSpan.SourceSpan, write = false): ReadonlyArray<LoanFact> =>
    loans.filter((loan) => {
      const retainedExecutableCapture =
        loan.origin === 'CallableCapture' ||
        loan.origin === 'ReturnedCallableCapture' ||
        loan.origin === 'EffectCapture'
      const retainedThroughAuthoredUse =
        loan.startSpan.sourceId === span.sourceId &&
        loan.startSpan.end <= span.start &&
        span.end <= loan.endSpan.end &&
        loan.endSpan.end > loan.startSpan.end
      // Executable environments retain their captured storage until their computed use/drop end.
      // That ownership fact is stronger than a value-lifetime graph which can stop at an invalid
      // invocation and would otherwise make the capture disappear before the authored use.
      if (retainedExecutableCapture && retainedThroughAuthoredUse) return true
      const live =
        fn.lifetimeFlow === undefined
          ? undefined
          : LifetimeFlow.liveAt(fn.lifetimeFlow, loan.startSpan, span, loan.endSpan, write)
      return live ?? retainedThroughAuthoredUse
    })

  const checkDirectAccess = (
    expression: LoanView.Expression,
    active: ReadonlyArray<LoanFact>,
    access: 'Read' | 'Write' | 'Move',
  ): void => {
    const direct = directSite(expression)
    const place = physicalPlace(expression)
    if (direct === undefined || place === undefined) return
    loanAccessChecks += 1
    const places =
      borrowedRootType(expression) === undefined ? [place] : rootsOf(place.root, place.path)
    const conflict = active.find(
      (loan) =>
        !grantsParentCapability(loan, direct.site, expression.anchor) &&
        (loan.referents.some((referent) =>
          places.some((selected) => referentsOverlap(referent, selected)),
        ) ||
          (loan.suspendsParent && sameSite(loan.root, direct.site))) &&
        (access !== 'Read' || loan.access === 'Exclusive'),
    )
    if (conflict !== undefined) {
      diagnostics.push(
        Diagnostic.ownerAccessDuringLoan(
          direct.spelling,
          access,
          conflict.startSpan,
          context.spanOf(expression.anchor),
        ),
      )
    }
  }

  const naturalAccess = (expression: LoanView.Expression): 'Read' | 'Move' =>
    expression.type._tag === 'Available' &&
    categoryOf(index, expression.type.type, copyAssumptions)._tag === 'MoveOnly'
      ? 'Move'
      : 'Read'

  const inspect = (
    expression: LoanView.Expression,
    region: Tir.RegionId,
    active: ReadonlyArray<LoanFact>,
    access: 'Read' | 'Write' | 'Move' = 'Read',
    delayedEnd?: LoanEndpoint,
  ): void => {
    switch (expression._tag) {
      case 'Integer':
      case 'Boolean':
        return
      case 'Identifier':
        checkDirectAccess(
          expression,
          [...active, ...delayedLoansAt(context.spanOf(expression.anchor), access === 'Write')],
          access,
        )
        return
      case 'Borrow': {
        if (expression.formation._tag === 'Unavailable') return
        const directRoot = borrowSite(expression.formation.root)
        const root = directRoot
        const extended = [...active, ...delayedLoansAt(context.spanOf(expression.anchor))]
        const conflict = extended.find(
          (loan) =>
            loanConflicts(loan, root, expression.anchor) &&
            (loan.access === 'Exclusive' || expression.access === 'Exclusive'),
        )
        if (conflict !== undefined) {
          diagnostics.push(
            Diagnostic.conflictingViewLoan(
              conflict.access,
              expression.access,
              conflict.startSpan,
              context.spanOf(expression.anchor),
            ),
          )
          return
        }
        let origin: LoanFact['origin'] = 'ValueBorrow'
        if (expression.formation._tag === 'FixedArrayBorrow') origin = 'FixedArrayBorrow'
        else if (expression.formation._tag === 'SliceReborrow') origin = 'SliceReborrow'
        else if (expression.formation._tag === 'ValueReborrow') origin = 'ValueReborrow'
        loans.push({
          _tag: 'Loan',
          id: {
            _tag: 'BorrowId',
            call: expression.ref,
            ordinal: 0,
          },
          root,
          access: expression.access,
          origin,
          suspendsParent:
            (expression.formation._tag === 'SliceReborrow' ||
              expression.formation._tag === 'ValueReborrow') &&
            expression.formation.suspendsParent,
          startRegion: region,
          endRegion: delayedEnd?.region ?? region,
          startSpan: context.spanOf(expression.anchor),
          referents: referentsAt(root, expression.anchor),
          endSpan: delayedEnd?.span ?? context.spanOf(expression.anchor),
          cleanupOnly: delayedEnd?.cleanupOnly ?? false,
        })
        return
      }
      case 'Move':
        inspect(expression.subject, region, active, 'Move', delayedEnd)
        return
      case 'ReferentProjection':
        inspect(expression.subject, region, active, access, delayedEnd)
        return
      case 'FieldProjection':
      case 'IndexProjection': {
        const place = physicalPlace(expression)
        if (place === undefined) inspect(expression.subject, region, active, access)
        else {
          checkDirectAccess(
            expression,
            [...active, ...delayedLoansAt(context.spanOf(expression.anchor))],
            access,
          )
          for (const selector of place.path)
            if (selector._tag !== 'Field' && selector.index !== undefined)
              inspect(selector.index, region, active, 'Read')
        }
        if (place === undefined && expression._tag === 'IndexProjection')
          inspect(expression.index, region, active, 'Read')
        return
      }
      // A value stored in an aggregate outlives the expression that built it, so a delayed end the
      // enclosing binding carries reaches the captures stored inside it too. Without this, a
      // borrow captured by a stored callable would be released while the aggregate still holds it.
      case 'StructLiteral':
      case 'UnionVariant':
        for (const initializer of expression.initializers) {
          inspect(
            initializer.expression,
            region,
            active,
            naturalAccess(initializer.expression),
            delayedEnd,
          )
        }
        return
      case 'ArrayLiteral':
        for (const element of expression.elements) {
          inspect(element.expression, region, active, naturalAccess(element.expression), delayedEnd)
        }
        return
      case 'Match':
        inspect(expression.scrutinee, region, active, naturalAccess(expression.scrutinee))
        for (const arm of expression.arms) {
          if (arm.guard !== undefined) inspect(arm.guard, region, active, 'Read')
          if (arm.body._tag === 'Expression') inspect(arm.body.expression, region, active, access)
          else statements(arm.body.statements, active)
        }
        return
      case 'Operator': {
        const callActive: Array<LoanFact> = [...active]
        for (const argument of expression.arguments) {
          const ordinal = argument.id.ordinal
          const candidate = argument.expression
          const operand = expression.interfaceOperation?.contract.operands.at(ordinal)
          const operandType = operand?.type._tag === 'Resolved' ? operand.type.type : undefined
          if (
            operandType === undefined ||
            (!Type.isReference(operandType) && !Type.isSlice(operandType))
          ) {
            inspect(candidate, region, callActive, naturalAccess(candidate))
            continue
          }
          const direct = directSite(candidate)
          if (direct === undefined) {
            inspect(
              candidate,
              region,
              callActive,
              operandType.access === 'Exclusive' ? 'Write' : 'Read',
            )
            continue
          }
          const root = direct.site
          const conflict = callActive.find(
            (loan) =>
              loanConflicts(loan, root, candidate.anchor) &&
              (loan.access === 'Exclusive' || operandType.access === 'Exclusive'),
          )
          if (conflict !== undefined)
            diagnostics.push(
              Diagnostic.conflictingViewLoan(
                conflict.access,
                operandType.access,
                conflict.startSpan,
                context.spanOf(candidate.anchor),
              ),
            )
          const loan: LoanFact = {
            _tag: 'Loan',
            id: {
              _tag: 'BorrowId',
              call: expression.ref,
              ordinal,
            },
            root,
            access: operandType.access,
            origin: 'InterfaceOperand',
            suspendsParent: false,
            startRegion: region,
            endRegion: region,
            startSpan: context.spanOf(candidate.anchor),
            referents: referentsAt(root, candidate.anchor),
            endSpan: context.spanOf(expression.anchor),
          }
          loans.push(loan)
          callActive.push(loan)
        }
        return
      }
      case 'ShortCircuit':
        for (const argument of expression.arguments) {
          inspect(argument.expression, region, active, 'Read')
        }
        return
      case 'FunctionItem':
        return
      case 'CallableSection': {
        const captureActive: Array<LoanFact> = [
          ...active,
          ...delayedLoansAt(context.spanOf(expression.anchor)),
        ]
        for (const capture of expression.captures) {
          const candidate = capture.expression
          if (capture.access !== 'Shared' && capture.access !== 'Exclusive') {
            inspect(candidate, region, captureActive, naturalAccess(candidate))
            continue
          }
          const directRoot =
            candidate._tag === 'Borrow' && candidate.formation._tag !== 'Unavailable'
              ? borrowSite(candidate.formation.root)
              : directSite(candidate)?.site
          const root = directRoot
          if (root === undefined) {
            inspect(candidate, region, captureActive, 'Read')
            continue
          }
          const conflict = captureActive.find(
            (loan) =>
              loanConflicts(loan, root, candidate.anchor) &&
              (loan.access === 'Exclusive' || capture.access === 'Exclusive'),
          )
          if (conflict !== undefined) {
            diagnostics.push(
              Diagnostic.conflictingViewLoan(
                conflict.access,
                capture.access,
                conflict.startSpan,
                context.spanOf(candidate.anchor),
              ),
            )
          }
          const loan: LoanFact = {
            _tag: 'Loan',
            id: {
              _tag: 'BorrowId',
              call: expression.ref,
              ordinal: capture.ordinal,
            },
            root,
            access: capture.access,
            origin: returnedCallableCaptures.has(captureKey(candidate.anchor, capture.ordinal))
              ? 'ReturnedCallableCapture'
              : 'CallableCapture',
            suspendsParent: false,
            startRegion: region,
            endRegion: delayedEnd?.region ?? region,
            startSpan: context.spanOf(candidate.anchor),
            referents: referentsAt(root, candidate.anchor),
            endSpan: delayedEnd?.span ?? context.spanOf(expression.anchor),
            cleanupOnly: delayedEnd?.cleanupOnly ?? false,
          }
          loans.push(loan)
          captureActive.push(loan)
        }
        return
      }
      case 'CallableApply': {
        const callActive: Array<LoanFact> = [
          ...active,
          ...delayedLoansAt(context.spanOf(expression.anchor)),
        ]
        const returnedOrdinal = returnedArgumentOrdinals(expression)
        const inspectCallee = (): void => {
          let access: 'Move' | 'Write' | 'Read' = 'Read'
          if (expression.mode === 'Take') access = 'Move'
          else if (expression.mode === 'Exclusive') access = 'Write'
          inspect(expression.callee, region, active, access, delayedEnd)
        }
        const inspectArguments = (): void => {
          for (const argument of expression.arguments) {
            const argumentOrdinal = argument.id.ordinal
            const candidate = argument.expression
            if (candidate._tag === 'Borrow' && candidate.formation._tag !== 'Unavailable') {
              const directRoot = borrowSite(candidate.formation.root)
              const root = directRoot
              const conflict = callActive.find(
                (loan) =>
                  loanConflicts(loan, root, candidate.anchor) &&
                  (loan.access === 'Exclusive' || candidate.access === 'Exclusive'),
              )
              if (conflict !== undefined) {
                diagnostics.push(
                  Diagnostic.conflictingViewLoan(
                    conflict.access,
                    candidate.access,
                    conflict.startSpan,
                    context.spanOf(candidate.anchor),
                  ),
                )
              }
              // A staged application retains every argument borrow inside the new environment
              // for as long as the resulting callable lives.
              const staged = expression.staged !== undefined
              const returned = staged || returnedOrdinal.has(argumentOrdinal)
              let origin: LoanFact['origin'] = candidate.formation._tag
              if (staged) origin = 'CallableCapture'
              else if (returned) origin = 'ReturnedView'
              const loan: LoanFact = {
                _tag: 'Loan',
                id: {
                  _tag: 'BorrowId',
                  call: expression.ref,
                  ordinal: argumentOrdinal,
                },
                root,
                access: candidate.access,
                origin,
                ...(candidate.formation._tag === 'SliceReborrow' ||
                candidate.formation._tag === 'ValueReborrow'
                  ? { parent: root, suspendsParent: candidate.formation.suspendsParent }
                  : { suspendsParent: false }),
                startRegion: region,
                endRegion: returned ? (delayedEnd?.region ?? region) : region,
                startSpan: context.spanOf(candidate.anchor),
                referents: referentsAt(root, candidate.anchor),
                cleanupOnly: returned && (delayedEnd?.cleanupOnly ?? false),
                endSpan: returned
                  ? (delayedEnd?.span ?? context.spanOf(expression.anchor))
                  : context.spanOf(expression.anchor),
              }
              loans.push(loan)
              callActive.push(loan)
              continue
            }
            let argumentEnd: LoanEndpoint | undefined
            if (argument.type._tag === 'Available' && Type.isEffect(argument.type.type))
              argumentEnd = delayedEnd
            else if (returnedOrdinal.has(argumentOrdinal))
              argumentEnd = delayedEnd ?? endpointAt(expression.anchor, region)
            inspect(candidate, region, callActive, naturalAccess(candidate), argumentEnd)
          }
        }
        if (expression.provenance._tag === 'PipelineCallableApplication') {
          inspectArguments()
          inspectCallee()
        } else {
          inspectCallee()
          inspectArguments()
        }
        return
      }
      case 'ForeignApply':
      case 'Call': {
        if (expression._tag === 'ForeignApply' && expression.evaluation === 'CalleeThenArguments')
          inspect(expression.callee, region, active, 'Read')
        const callActive: Array<LoanFact> = [
          ...active,
          ...delayedLoansAt(context.spanOf(expression.anchor)),
        ]
        const consumesSlot =
          expression._tag === 'Call' &&
          expression.reference._tag === 'ResolvedBuiltin' &&
          (expression.reference.operation === 'SlotWrite' ||
            expression.reference.operation === 'SlotTake' ||
            expression.reference.operation === 'SlotCopy' ||
            expression.reference.operation === 'SlotDrop')
        for (const argument of expression.arguments) {
          const argumentOrdinal = argument.id.ordinal
          const candidate = argument.expression
          const returnedOrdinal = returnedArgumentOrdinals(expression)
          if (candidate._tag !== 'Borrow' || candidate.formation._tag === 'Unavailable') {
            const preservesEffectLifetime =
              argument.type._tag === 'Available' && Type.isEffect(argument.type.type)
            let argumentEnd: LoanEndpoint | undefined
            if (preservesEffectLifetime) argumentEnd = delayedEnd
            else if (returnedOrdinal.has(argumentOrdinal))
              argumentEnd = delayedEnd ?? endpointAt(expression.anchor, region)
            else if (consumesSlot) argumentEnd = endpointAt(expression.anchor, region)
            inspect(candidate, region, callActive, naturalAccess(candidate), argumentEnd)
            continue
          }
          const directRoot = borrowSite(candidate.formation.root)
          const root = directRoot
          const conflict = callActive.find(
            (loan) =>
              loanConflicts(loan, root, candidate.anchor) &&
              (loan.access === 'Exclusive' || candidate.access === 'Exclusive'),
          )
          if (conflict !== undefined) {
            diagnostics.push(
              Diagnostic.conflictingViewLoan(
                conflict.access,
                candidate.access,
                conflict.startSpan,
                context.spanOf(candidate.anchor),
              ),
            )
          }
          const loan: LoanFact = {
            _tag: 'Loan',
            id: {
              _tag: 'BorrowId',
              call: expression.ref,
              ordinal: argumentOrdinal,
            },
            root,
            access: candidate.access,
            origin: returnedOrdinal.has(argumentOrdinal)
              ? 'ReturnedView'
              : candidate.formation._tag,
            ...(candidate.formation._tag === 'SliceReborrow' ||
            candidate.formation._tag === 'ValueReborrow'
              ? { parent: root, suspendsParent: candidate.formation.suspendsParent }
              : { suspendsParent: false }),
            startRegion: region,
            endRegion: returnedOrdinal.has(argumentOrdinal)
              ? (delayedEnd?.region ?? region)
              : region,
            startSpan: context.spanOf(candidate.anchor),
            referents: referentsAt(root, candidate.anchor),
            cleanupOnly: returnedOrdinal.has(argumentOrdinal) && (delayedEnd?.cleanupOnly ?? false),
            endSpan: returnedOrdinal.has(argumentOrdinal)
              ? (delayedEnd?.span ?? context.spanOf(expression.anchor))
              : context.spanOf(expression.anchor),
          }
          loans.push(loan)
          callActive.push(loan)
        }
        if (expression._tag === 'ForeignApply' && expression.evaluation === 'LeftThenCallable')
          inspect(expression.callee, region, callActive, 'Read')
        return
      }
      case 'EffectBlock': {
        const captureActive: Array<LoanFact> = [
          ...active,
          ...delayedLoansAt(context.spanOf(expression.anchor)),
        ]
        const capturedLoans: Array<LoanFact> = []
        for (const [ordinal, capture] of expression.captures.entries()) {
          let root: BindingSite
          if (capture.reference._tag === 'BindingFact')
            root = { _tag: 'Let', binding: capture.reference.id }
          else if (capture.reference._tag === 'PatternBinding')
            root = { _tag: 'Pattern', binding: capture.reference.id }
          else root = { _tag: 'Parameter', parameter: capture.reference.id }
          const candidateAccess = capture.access === 'Exclusive' ? 'Exclusive' : 'Shared'
          const conflict = captureActive.find(
            (loan) =>
              loanConflicts(loan, root, capture.expression?.anchor) &&
              (loan.access === 'Exclusive' || candidateAccess === 'Exclusive'),
          )
          if (conflict !== undefined) {
            diagnostics.push(
              Diagnostic.conflictingViewLoan(
                conflict.access,
                candidateAccess,
                conflict.startSpan,
                capture.span,
              ),
            )
          }
          if (capture.access !== 'Shared' && capture.access !== 'Exclusive') continue
          const loan: LoanFact = {
            _tag: 'Loan',
            id: {
              _tag: 'BorrowId',
              call: expression.ref,
              ordinal,
            },
            root,
            access: capture.access,
            origin: 'EffectCapture',
            suspendsParent: false,
            startRegion: region,
            endRegion: delayedEnd?.region ?? region,
            startSpan: capture.span,
            referents: referentsAt(root, capture.expression?.anchor),
            endSpan: delayedEnd?.span ?? context.spanOf(expression.anchor),
            cleanupOnly: delayedEnd?.cleanupOnly ?? false,
          }
          capturedLoans.push(loan)
          captureActive.push(loan)
        }
        // The deferred body executes through its captured capabilities. Publish those loans only
        // after inspecting the body so its own reads and writes do not conflict with the views
        // that authorize them.
        statements(expression.statements)
        loans.push(...capturedLoans)
        return
      }
      case 'Run':
        inspect(expression.subject, region, active, 'Read', endpointAt(expression.anchor, region))
        return
      case 'EffectBindRequirement': {
        inspect(expression.protected, region, active, 'Read', delayedEnd)
        const provider = expression.provider
        if (
          provider === undefined ||
          provider.captureAccess === 'Copy' ||
          provider.captureAccess === 'Take'
        )
          return
        const root: BindingSite =
          provider.reference._tag === 'BindingFact'
            ? { _tag: 'Let', binding: provider.reference.id }
            : { _tag: 'Parameter', parameter: provider.reference.id }
        const conflict = active.find(
          (loan) =>
            loanConflicts(loan, root, undefined) &&
            (loan.access === 'Exclusive' || provider.captureAccess === 'Exclusive'),
        )
        if (conflict !== undefined)
          diagnostics.push(
            Diagnostic.conflictingViewLoan(
              conflict.access,
              provider.captureAccess,
              conflict.startSpan,
              provider.span,
            ),
          )
        loans.push({
          _tag: 'Loan',
          id: {
            _tag: 'BorrowId',
            call: expression.ref,
            ordinal: 0,
          },
          root,
          access: provider.captureAccess,
          origin: 'EffectCapture',
          suspendsParent: false,
          startRegion: region,
          endRegion: delayedEnd?.region ?? region,
          startSpan: provider.span,
          referents: referentsAt(root, undefined),
          endSpan: delayedEnd?.span ?? context.spanOf(expression.anchor),
          cleanupOnly: delayedEnd?.cleanupOnly ?? false,
        })
        return
      }
      case 'EffectCatch':
        // Catch retains both operands until the resulting Effect runs, just like an ordinary call
        // returning an Effect. Propagate the delayed end so nested borrowed captures remain live.
        inspect(
          expression.protected,
          region,
          active,
          naturalAccess(expression.protected),
          delayedEnd,
        )
        inspect(expression.handler, region, active, naturalAccess(expression.handler), delayedEnd)
        return
    }
  }

  const statements = (
    facts: ReadonlyArray<LoanView.Statement>,
    active: ReadonlyArray<LoanFact> = [],
  ): void => {
    for (const statement of facts) {
      switch (statement._tag) {
        case 'UnsafeStatement':
          statements(statement.statements, active)
          break
        case 'BindStatement': {
          const initializerType = statement.binding.initializer.type
          const fallbackEnd = endpointAt(fn.declaration.anchor, statement.region)
          let bindingEnd: LoanEndpoint | undefined
          if (initializerType._tag === 'Available' && Type.isEffect(initializerType.type))
            bindingEnd =
              runEnds.get(statement.binding.id.ordinal) ??
              callableEnds.get(statement.binding.id.ordinal) ??
              fallbackEnd
          // A binding that stores an executable holds its captured borrows for as long as it
          // holds that environment, whether it is the binding's own value or sits in a field
          // of the aggregate it names.
          else if (
            initializerType._tag === 'Available' &&
            (Type.isCallable(initializerType.type) ||
              Type.containsExecutableRepresentation(initializerType.type))
          )
            bindingEnd =
              laterExecutableEnd(
                runEnds.get(statement.binding.id.ordinal),
                callableEnds.get(statement.binding.id.ordinal),
              ) ?? fallbackEnd
          else if (initializerType._tag === 'Available' && Type.isSlot(initializerType.type))
            bindingEnd = slotEnds.get(statement.binding.id.ordinal) ?? fallbackEnd
          else if (
            initializerType._tag === 'Available' &&
            Type.storageLifetimes(initializerType.type).length > 0
          )
            bindingEnd =
              viewEnds.get(statement.binding.id.ordinal) ??
              endpointAt(statement.binding.initializer.anchor, statement.region)
          inspect(statement.binding.initializer, statement.region, active, 'Read', bindingEnd)
          break
        }
        case 'ExpressionStatement':
          inspect(
            statement.expression,
            statement.region,
            active,
            naturalAccess(statement.expression),
          )
          break
        case 'PatternBindStatement':
          inspect(
            statement.selection.source,
            statement.region,
            active,
            naturalAccess(statement.selection.source),
            {
              region: statement.region,
              span: statement.selection.loanEnd,
              order: context.orderOf(statement.selection.anchor),
            },
          )
          break
        case 'IfStatement':
          inspect(statement.condition, statement.region, active)
          statements(statement.taken, active)
          statements(statement.otherwise, active)
          break
        case 'IfLetStatement':
          inspect(
            statement.selection.source,
            statement.region,
            active,
            naturalAccess(statement.selection.source),
            {
              region: statement.region,
              span: statement.selection.loanEnd,
              order: context.orderOf(statement.selection.anchor),
            },
          )
          statements(statement.taken, active)
          statements(statement.otherwise, active)
          break
        case 'WriteStatement':
          inspect(statement.destination, statement.region, active, 'Write')
          inspect(statement.value, statement.region, active, naturalAccess(statement.value))
          break
        case 'WhileStatement':
          inspect(statement.condition, statement.region, active)
          statements(statement.body, active)
          break
        case 'ReturnStatement':
          inspect(
            statement.expression,
            statement.region,
            active,
            naturalAccess(statement.expression),
          )
          break
        case 'FailStatement':
          inspect(statement.expression, statement.region, active, 'Move')
          break
        case 'DropStatement':
          inspect(statement.expression, statement.region, active, 'Move')
          break
        case 'BreakStatement':
        case 'ContinueStatement':
          break
      }
    }
  }
  statements(fn.statements)
  return {
    loanAccessChecks,
    loans: loans,
    diagnostics: diagnostics,
  }
}

export interface CheckedFunction {
  readonly ownership: FunctionOwnership
  readonly diagnostics: ReadonlyArray<Diagnostic.Diagnostic>
}

interface ExitDescriptor {
  readonly kind: ExitPlan['kind']
  readonly span: SourceSpan.SourceSpan
  readonly region?: Tir.RegionId
  readonly arm?: 'Taken' | 'Otherwise'
  readonly target?: Tir.LoopId
  readonly sites: ReadonlyArray<string>
  readonly initialization: ReadonlyFlowState
  readonly temporaries?: ReadonlyArray<TemporaryRelease>
  readonly matches?: ReadonlyArray<MatchRelease>
  readonly loanRegions?: ReadonlyArray<Tir.RegionId>
}

const checkFunction = (
  fn: Tir.TirFunction,
  artifact: Tir.ArtifactId,
  index: DeclarationIndex.Index,
  context: SemanticContext.SemanticContext,
  causes: Elaboration.BodyResults['causes'],
  lifetimes?: LifetimeFlow.LifetimeFlow,
  localSharedBoundaries: ReadonlyArray<SourceSpan.SourceSpan> = [],
  localSharedResultBoundaries: ReadonlyArray<SourceSpan.SourceSpan> = [],
): CheckedFunction => {
  const declaration = fn.declaration
  const copyAssumptions = new Set(
    declaration.typeParameters.flatMap((parameter) =>
      parameter.bounds.some(
        (bound) =>
          bound._tag === 'ResolvedBound' &&
          Type.equals(bound.application.capability, Type.copyCapability),
      )
        ? [Type.key(parameter.type)]
        : [],
    ),
  )
  const state: CheckState = {
    work: {
      pathChecks: 0,
      shapeComputations: 0,
      shapeCacheHits: 0,
      shapeProjectionSteps: 0,
      initializationJoins: 0,
      loanAccessChecks: 0,
      cleanupPlanQueries: 0,
    },
    nextAcquisition: 0,
    index,
    causes,
    copyAssumptions,
    bindings: new Map(),
    order: [],
    diagnostics: [],
    matches: [],
    callables: [],
    replacements: [],
    transitions: [],
    shapes: new Map(),
    execution: undefined,
    checkMatch: (live, expression, consuming, guard, escaping) =>
      checkMatch(live, expression, consuming, guard, escaping),
    propagation: (live, expression) => propagation(live, expression),
  }
  if (localSharedBoundaries.length > 0) {
    const activeBoundaryOperations = (
      expression: Tir.Expression,
    ): ReadonlyArray<Tir.Expression> => {
      if (expression._tag === 'EffectBlock') return []
      return [
        ...(expression._tag === 'Run' ||
        (expression._tag === 'BuiltinCall' && expression.operation === 'ExecutionWake')
          ? [expression]
          : []),
        ...Tir.expressionChildren(expression).flatMap(activeBoundaryOperations),
      ]
    }
    const boundaryOperations = fn.statements
      .flatMap(Tir.statementExpressions)
      .flatMap(activeBoundaryOperations)
    for (const boundary of localSharedBoundaries)
      for (const operation of boundaryOperations)
        state.diagnostics.push(
          Diagnostic.localSharedAccessEscape(
            operation._tag === 'BuiltinCall' && operation.operation === 'ExecutionWake'
              ? 'Callback'
              : 'Suspension',
            operation.span,
            boundary,
          ),
        )
  }

  if (localSharedResultBoundaries.length > 0) {
    const parameter = fn.declaration.parameters.at(0)?.id
    if (parameter !== undefined) {
      const bindings = new Map<number, Tir.Expression>()
      const collectBindings = (statements: ReadonlyArray<Tir.Statement>): void => {
        for (const statement of statements) {
          if (statement._tag === 'Bind')
            bindings.set(statement.binding.ordinal, statement.initializer)
          if (statement._tag === 'Unsafe') collectBindings(statement.statements)
          if (statement._tag === 'If' || statement._tag === 'IfLet') {
            collectBindings(statement.taken)
            collectBindings(statement.otherwise)
          }
          if (statement._tag === 'While') collectBindings(statement.body)
        }
      }
      collectBindings(fn.statements)
      const referencesParameter = (
        expression: Tir.Expression,
        seen = new Set<number>(),
      ): boolean => {
        if (
          expression._tag === 'ParameterReference' &&
          expression.parameter.ordinal === parameter.ordinal
        )
          return true
        if (expression._tag === 'BindingReference') {
          if (seen.has(expression.binding.ordinal)) return false
          const initializer = bindings.get(expression.binding.ordinal)
          return initializer === undefined
            ? false
            : referencesParameter(initializer, new Set(seen).add(expression.binding.ordinal))
        }
        return Tir.expressionChildren(expression).some((child) => referencesParameter(child, seen))
      }
      const exits = (statements: ReadonlyArray<Tir.Statement>): ReadonlyArray<Tir.Expression> =>
        statements.flatMap((statement): ReadonlyArray<Tir.Expression> => {
          switch (statement._tag) {
            case 'Return':
            case 'Fail':
              return [statement.expression]
            case 'Unsafe':
              return exits(statement.statements)
            case 'If':
            case 'IfLet':
              return [...exits(statement.taken), ...exits(statement.otherwise)]
            case 'While':
              return exits(statement.body)
            default:
              return []
          }
        })
      const capturesParameter = (expression: Tir.Expression, seen = new Set<number>()): boolean => {
        if (expression._tag === 'BindingReference') {
          if (seen.has(expression.binding.ordinal)) return false
          const initializer = bindings.get(expression.binding.ordinal)
          return initializer === undefined
            ? false
            : capturesParameter(initializer, new Set(seen).add(expression.binding.ordinal))
        }
        if (
          (expression._tag === 'EffectBlock' || expression._tag === 'CallableSection') &&
          referencesParameter(expression)
        )
          return true
        return Tir.expressionChildren(expression).some((child) => capturesParameter(child, seen))
      }
      const escapeSites = exits(fn.statements).filter((returned) => {
        const capturesRestrictedParameter = capturesParameter(returned)
        if (
          'type' in returned &&
          localSharedResultEscapes({
            resultType: returned.type,
            capturesRestrictedParameter,
            referencesRestrictedParameter: referencesParameter(returned),
          })
        )
          return true
        return false
      })
      for (const boundary of localSharedResultBoundaries) {
        for (const escapeSite of escapeSites)
          state.diagnostics.push(
            Diagnostic.localSharedAccessEscape('Result', escapeSite.span, boundary),
          )
      }
    }
  }

  const initialLive: FlowState = new Map()
  for (const parameter of declaration.parameters) {
    if (parameter.phase === 'Static') continue
    const type =
      parameter.declaredType._tag === 'Resolved' ? parameter.declaredType.type : undefined
    const cause = 'cause' in parameter.declaredType ? parameter.declaredType.cause : undefined
    const binding: MutableBinding = {
      ordinal: state.nextAcquisition++,
      site: {
        _tag: 'Parameter',
        parameter: { _tag: 'TirLocal' as const, ordinal: parameter.id.ordinal },
      },
      name: parameter.name._tag === 'Present' ? parameter.name.spelling : undefined,
      mutability: parameter.bindingMutability,
      liveFrom: context.spanOf(parameter.anchor),
      liveTo: context.spanOf(declaration.anchor),
      category: categoryOf(index, type, copyAssumptions),
      executionAffinity: ExecutionAffinity.ofDeclaredType(index, parameter.declaredType),
      localSharedObligations: LocalSharedOwnership.ofDeclaredType(index, parameter.declaredType),
      ...(type === undefined ? {} : { type }),
      ...(cause === undefined ? {} : { cause }),
    }
    const key = siteKey(binding.site)
    state.bindings.set(key, binding)
    state.order.push(binding)
    initialLive.set(key, MovePath.make())
  }

  const exits: Array<ExitDescriptor> = []
  /** Bindings local to deferred effect bodies: resolvable for releases, never published. */
  const deferredReleaseOrder: Array<MutableBinding> = []
  const continueStates = new Map<number, Array<FlowState>>()
  const breakStates = new Map<number, Array<FlowState>>()
  const fixedPoints: Array<{
    readonly loop: Tir.LoopId
    readonly span: SourceSpan.SourceSpan
    readonly incoming: FlowState
    readonly repeating: ReadonlyArray<FlowState>
    readonly following: FlowState
    readonly compatible: boolean
    readonly iterations: number
  }> = []
  const appendLoopState = (
    states: Map<number, Array<FlowState>>,
    loop: Tir.LoopId,
    live: FlowState,
  ): void => {
    const existing = states.get(loop.ordinal)
    if (existing === undefined) states.set(loop.ordinal, [new Map(live)])
    else existing.push(new Map(live))
  }
  const sameLive = sameFlow
  const intersection = (flows: ReadonlyArray<ReadonlyFlowState>): FlowState =>
    joinFlows(state, flows)
  const frameSitesInnerFirst = (
    frames: ReadonlyArray<ReadonlyArray<string>>,
    live: ReadonlyFlowState,
  ): ReadonlyArray<string> =>
    [...frames]
      .reverse()
      .flatMap((frame) => [...frame].reverse().filter((site) => present(live, site)))

  const checkPatternSubject = (selection: Tir.PatternSelection, live: FlowState): boolean => {
    const temporaryMark = state.execution?.temporaries.length ?? 0
    const subjectType =
      selection.subject._tag === 'Unavailable' ? undefined : selection.subject.type
    const subjectSite = placeSite(selection.subject)
    const subjectBinding =
      subjectSite === undefined ? undefined : state.bindings.get(siteKey(subjectSite))
    if (selection.access === 'Copy') {
      if (!checkExpression(state, live, selection.subject, false)) return false
      if (categoryOf(index, subjectType, copyAssumptions)._tag === 'MoveOnly')
        state.diagnostics.push(
          Diagnostic.explicitMoveRequired(subjectBinding?.name ?? '?', selection.span),
        )
      return true
    }
    if (selection.access === 'Move') {
      const place = placeOf(selection.subject)
      if (place === undefined) {
        if (!checkExpression(state, live, selection.subject, true)) return false
      } else {
        if (
          !checkPlaceInterior(
            state,
            live,
            selection.subject,
            state.execution?.guard ?? false,
            false,
          )
        )
          return false
        checkPath(state, live, place.root, place.path, selection.span, 'Move')
      }
      if (state.execution !== undefined) state.execution.temporaries.length = temporaryMark
      return true
    }
    if (!checkExpression(state, live, selection.subject, false)) return false
    if (selection.access === 'Exclusive') {
      if (subjectSite === undefined)
        state.diagnostics.push(Diagnostic.invalidMatchScrutineePlace('Exclusive', selection.span))
      else if (!supportsExclusiveAccess(subjectBinding))
        state.diagnostics.push(
          Diagnostic.exclusiveMatchRequiresMutable(subjectBinding?.name ?? '?', selection.span),
        )
    }
    return true
  }

  const introducePatternBindings = (
    selection: Tir.PatternSelection,
    live: FlowState,
    frame: Array<string>,
    liveTo: SourceSpan.SourceSpan,
  ): ReadonlyArray<BindingSite> => {
    const sites: Array<BindingSite> = []
    for (const pattern of selection.bindings) {
      const site: BindingSite = { _tag: 'Pattern', binding: pattern.id }
      const mutable: MutableBinding = {
        ordinal: state.nextAcquisition++,
        site,
        name: pattern.name,
        mutability: pattern.access === 'Exclusive' ? 'Mutable' : 'Immutable',
        liveFrom: pattern.span,
        liveTo,
        category: categoryOf(index, pattern.type, copyAssumptions),
        type: pattern.type,
        matchAccess: pattern.access,
      }
      const key = siteKey(site)
      state.bindings.set(key, mutable)
      state.order.push(mutable)
      frame.push(key)
      live.set(key, MovePath.make())
      sites.push(site)
    }
    return sites
  }

  const patternSelectionCleanup = (
    selection: Tir.PatternSelection,
    live: ReadonlyFlowState,
    includeBindings: boolean,
  ): MatchOwnership['arms'][number]['cleanup'] => {
    if (selection.access === 'Move') {
      return [
        ...selection.cleanup.flatMap((path) => {
          const subjectType =
            selection.subject._tag === 'Unavailable' ? undefined : selection.subject.type
          const type = CleanupPlan.cleanupTypeAtPath(
            index,
            selection.member === undefined
              ? (subjectType ?? 'never')
              : Match.sourceType(selection.member),
            path,
          )
          return type === undefined ? [] : [{ path, cleanup: cleanupPlan(state, type) }]
        }),
        ...(includeBindings
          ? selection.bindings.flatMap((binding) => {
              const site: BindingSite = { _tag: 'Pattern', binding: binding.id }
              return present(live, siteKey(site)) &&
                categoryOf(index, binding.type, copyAssumptions)._tag === 'MoveOnly'
                ? [
                    {
                      path: binding.path,
                      cleanup: cleanupPlan(state, binding.type),
                    },
                  ]
                : []
            })
          : []),
      ]
    }
    return []
  }

  const transferCleanup = (
    firstFrame = 0,
  ): Pick<ExitDescriptor, 'temporaries' | 'matches' | 'loanRegions'> => ({
    loanRegions: (state.execution?.regions ?? [])
      .filter((entry) => entry.frame >= firstFrame)
      .map((entry) => entry.region),
    temporaries: [...(state.execution?.temporaries ?? [])]
      .reverse()
      .filter((entry) => entry.frame >= firstFrame)
      .map((entry) => entry.release),
    matches: [...(state.execution?.matches ?? [])]
      .reverse()
      .filter((entry) => entry.frame >= firstFrame)
      .map((entry) => entry.release),
  })
  const propagation = (
    live: FlowState,
    expression: Extract<Tir.Expression, { readonly _tag: 'Run' }>,
  ): void => {
    if (
      expression.subject._tag === 'Unavailable' ||
      !Type.isEffect(expression.subject.type) ||
      Type.isNever(Type.failureType(expression.subject.type))
    )
      return
    // Immediate owned bindings transfer the source value into a provider bracket. That
    // bracket releases on both outcomes: lowering emits the normal drop, while propagation
    // must retain its owner until the protected execution has produced an outcome.
    const failureLive = new Map(live)
    let protectedEffect: Tir.Expression = expression.subject
    while (protectedEffect._tag === 'EffectBindRequirement') {
      const provider = protectedEffect.provider
      if (provider.selectionAccess === 'Take') {
        if (provider.binding !== undefined)
          failureLive.set(siteKey({ _tag: 'Let', binding: provider.binding }), MovePath.make())
        else if (provider.parameter !== undefined)
          failureLive.set(
            siteKey({ _tag: 'Parameter', parameter: provider.parameter }),
            MovePath.make(),
          )
      }
      protectedEffect = protectedEffect.protected
    }
    exits.push({
      kind: 'Propagation',
      span: expression.span,
      sites: frameSitesInnerFirst(state.execution?.frames ?? [], failureLive),
      initialization: new Map(failureLive),
      ...transferCleanup(),
    })
  }
  const walkStatements = (
    statements: ReadonlyArray<Tir.Statement>,
    enclosingSpan: SourceSpan.SourceSpan,
    initial: FlowState,
    frames: Array<Array<string>>,
    loopScopes: ReadonlyArray<{ readonly loop: Tir.LoopId; readonly frame: number }> = [],
  ): { readonly returned: boolean; readonly live: FlowState } => {
    const previous = state.execution
    state.execution = {
      regions: [...(previous?.regions ?? [])],
      guard: previous?.guard ?? false,
      frames,
      loopScopes,
      temporaries: previous?.temporaries ?? [],
      matches: previous?.matches ?? [],
    }
    const result = walkStatementBody(statements, enclosingSpan, initial, frames, loopScopes)
    state.execution = previous
    return result
  }

  const walkStatementBody = (
    statements: ReadonlyArray<Tir.Statement>,
    enclosingSpan: SourceSpan.SourceSpan,
    initial: FlowState,
    frames: Array<Array<string>>,
    loopScopes: ReadonlyArray<{ readonly loop: Tir.LoopId; readonly frame: number }> = [],
  ): { readonly returned: boolean; readonly live: FlowState } => {
    let live = initial
    const evaluate = (expression: Tir.Expression, consuming: boolean): boolean => {
      const mark = state.execution?.temporaries.length ?? 0
      const completed = checkExpression(state, live, expression, consuming)
      if (state.execution !== undefined) state.execution.temporaries.length = mark
      return completed
    }
    for (const statement of statements) {
      state.execution?.regions.push({ region: statement.region, frame: frames.length - 1 })
      // A lazy effect body is walked with its execution deferred: its moves never feed the
      // enclosing flow, and its loop, match, and binding facts are published by lowering
      // through its own compiled body rather than through these facts. Its exit plans DO
      // survive — the body's compiled runner reuses this function's span-keyed exit plans to
      // emit automatic cleanup, and the outer body never looks up a body-statement span.
      for (const block of statementRootExpressions(statement).flatMap(deferredBlocks)) {
        const bodyLive = new Map(live)
        const bodyFrame: Array<string> = []
        for (const capture of block.captures) {
          let site: BindingSite | undefined
          if (capture.binding !== undefined) {
            site = { _tag: 'Let', binding: capture.binding }
          } else if (capture.pattern !== undefined) {
            site = { _tag: 'Pattern', binding: capture.pattern }
          } else if (capture.parameter !== undefined) {
            site = { _tag: 'Parameter', parameter: capture.parameter }
          } else {
            site = undefined
          }
          if (site === undefined) continue
          bodyLive.set(siteKey(site), MovePath.make())
          // A taken capture is owned by the body, so a failure inside it releases the value.
          if (capture.access === 'Take') bodyFrame.push(siteKey(site))
        }
        const marks = {
          exits: exits.length,
          fixedPoints: fixedPoints.length,
          order: state.order.length,
          matches: state.matches.length,
          callables: state.callables.length,
        }
        const enclosingExecution = state.execution
        state.execution = undefined
        walkStatements(block.statements, block.span, bodyLive, [bodyFrame])
        state.execution = enclosingExecution
        deferredReleaseOrder.push(...state.order.slice(marks.order))
        fixedPoints.length = marks.fixedPoints
        state.order.length = marks.order
        state.matches.length = marks.matches
        state.callables.length = marks.callables
      }
      if (statement._tag === 'Unsafe') {
        const scopeFrames = [...frames.map((frame) => [...frame]), []]
        const result = walkStatements(
          statement.statements,
          statement.span,
          new Map(live),
          scopeFrames,
          loopScopes,
        )
        const frame = scopeFrames.at(-1) ?? []
        if (result.returned) return result
        if (frame.length > 0) {
          exits.push({
            kind: 'ScopeEnd' as const,
            span: statement.span,
            region: statement.region,
            sites: [...frame].reverse().filter((site) => present(result.live, site)),
            initialization: new Map(result.live),
          })
        }
        for (const site of frame) result.live.delete(site)
        live = result.live
        continue
      }
      if (statement._tag === 'Bind') {
        if (!evaluate(statement.initializer, true)) return { returned: true, live }
        const type =
          statement.initializer._tag === 'Unavailable' ? undefined : statement.initializer.type
        const environment =
          statement.initializer._tag === 'CallableSection'
            ? callableEnvironment(state, statement.initializer)
            : undefined
        const retained =
          environment === undefined
            ? executableEnvironment(state, statement.initializer)
            : {
                affinity: environment.executionAffinity,
                obligations: environment.localSharedObligations,
              }
        const cause =
          statement.initializer._tag === 'Unavailable'
            ? unavailableCause(state, statement.initializer)
            : undefined
        const binding: MutableBinding = {
          ordinal: state.nextAcquisition++,
          site: { _tag: 'Let', binding: statement.binding },
          name: statement.name,
          mutability: statement.mutability,
          liveFrom: statement.span,
          liveTo: enclosingSpan,
          category: categoryOf(index, type, copyAssumptions),
          ...(retained === undefined
            ? {}
            : {
                executionAffinity: retained.affinity,
                localSharedObligations: retained.obligations,
              }),
          ...(type === undefined ? {} : { type }),
          ...(cause === undefined ? {} : { cause }),
          ...(environment === undefined || type === undefined || !Type.isCallable(type)
            ? {}
            : { cleanup: callableCleanup(environment, type) }),
        }
        const key = siteKey(binding.site)
        state.bindings.set(key, binding)
        state.order.push(binding)
        frames.at(-1)?.push(key)
        live.set(key, MovePath.make())
        continue
      }
      if (statement._tag === 'PatternBind') {
        if (!checkPatternSubject(statement.selection, live)) return { returned: true, live }
        const frame = frames.at(-1) ?? []
        const sites = introducePatternBindings(statement.selection, live, frame, enclosingSpan)
        state.matches.push({
          _tag: 'MatchOwnership',
          id: statement.selection.id,
          access: statement.selection.access,
          span: statement.span,
          arms: [
            {
              id: statement.selection.arm,
              ...(statement.selection.member === undefined
                ? {}
                : { member: statement.selection.member }),
              universal: statement.selection.universal,
              provisionalGuard: false,
              bindings: sites,
              cleanup: patternSelectionCleanup(statement.selection, live, false),
            },
          ],
        })
        continue
      }
      if (statement._tag === 'Evaluate') {
        if (!evaluate(statement.expression, true)) return { returned: true, live }
        continue
      }
      if (statement._tag === 'If') {
        if (!evaluate(statement.condition, false)) return { returned: true, live }
        const continuing: Array<FlowState> = []
        for (const [arm, body] of [
          ['Taken', statement.taken],
          ['Otherwise', statement.otherwise],
        ] as const) {
          const armFrames = [...frames.map((frame) => [...frame]), []]
          const result = walkStatements(body, statement.span, new Map(live), armFrames, loopScopes)
          const frame = armFrames.at(-1) ?? []
          if (!result.returned && frame.length > 0) {
            exits.push({
              kind: 'ArmEnd' as const,
              span: statement.span,
              region: statement.region,
              arm,
              sites: [...frame].reverse().filter((site) => present(result.live, site)),
              initialization: new Map(result.live),
            })
          }
          if (!result.returned) {
            for (const site of frame) result.live.delete(site)
            continuing.push(result.live)
          }
        }
        if (continuing.length === 0) return { returned: true, live }
        live = mergeArmLive(state, continuing, statement.span)
        continue
      }
      if (statement._tag === 'IfLet') {
        if (!checkPatternSubject(statement.selection, live)) return { returned: true, live }
        const continuing: Array<FlowState> = []
        let selectedSites: ReadonlyArray<BindingSite> = []
        for (const [arm, body] of [
          ['Taken', statement.taken],
          ['Otherwise', statement.otherwise],
        ] as const) {
          const armFrames = [...frames.map((frame) => [...frame]), []]
          const armLive = new Map(live)
          if (arm === 'Taken')
            selectedSites = introducePatternBindings(
              statement.selection,
              armLive,
              armFrames.at(-1) ?? [],
              statement.span,
            )
          const result = walkStatements(body, statement.span, armLive, armFrames, loopScopes)
          const frame = armFrames.at(-1) ?? []
          if (!result.returned && frame.length > 0)
            exits.push({
              kind: 'ArmEnd' as const,
              span: statement.span,
              region: statement.region,
              arm,
              sites: [...frame].reverse().filter((site) => present(result.live, site)),
              initialization: new Map(result.live),
            })
          if (!result.returned) {
            for (const site of frame) result.live.delete(site)
            continuing.push(result.live)
          }
        }
        state.matches.push({
          _tag: 'MatchOwnership',
          id: statement.selection.id,
          access: statement.selection.access,
          span: statement.span,
          arms: [
            {
              id: statement.selection.arm,
              ...(statement.selection.member === undefined
                ? {}
                : { member: statement.selection.member }),
              universal: statement.selection.universal,
              provisionalGuard: false,
              bindings: selectedSites,
              cleanup: patternSelectionCleanup(statement.selection, live, false),
            },
          ],
        })
        if (continuing.length === 0) return { returned: true, live }
        live = mergeArmLive(state, continuing, statement.span)
        continue
      }
      if (statement._tag === 'Write') {
        for (const selector of statement.place.selectors) {
          if (selector._tag === 'Index' || selector._tag === 'SliceIndex') {
            if (!evaluate(selector.index, false)) return { returned: true, live }
          }
        }
        let rootSite: BindingSite
        if (statement.place._tag === 'WritePlace') {
          rootSite = ownedWriteSite(statement.place.root)
        } else if (statement.place.root._tag === 'BindingSliceRoot') {
          rootSite = { _tag: 'Let', binding: statement.place.root.binding }
        } else {
          rootSite = {
            _tag: 'Parameter',
            parameter: statement.place.root.parameter,
          }
        }
        let path =
          statement.place._tag === 'WritePlace'
            ? selectorPath(statement.place.selectors)
            : undefined
        const canonical = canonicalPlace(state, { root: rootSite, path: path ?? [] })
        if (canonical !== undefined) {
          rootSite = canonical.root
          if (path !== undefined) path = canonical.path
        }
        const rootKey = siteKey(rootSite)
        const root = state.bindings.get(rootKey)
        const shape = shapeOf(state, rootSite)
        const before = live.get(rootKey) ?? MovePath.make('Missing')
        if (statement.place._tag === 'WritePlace' && path !== undefined) {
          const target = MovePath.inspect(before, path, shape)
          if (Result.isFailure(target) && root !== undefined)
            placeFailure(state, root, target.failure, statement.place.span)
        } else checkUse(state, live, rootSite, statement.place.span, false)
        const transitionMark = state.transitions.length
        if (!evaluate(statement.value, true)) return { returned: true, live }
        const overlaps = state.transitions
          .slice(transitionMark)
          .some(
            (transition) =>
              transition.kind !== 'Write' &&
              siteKey(transition.root) === rootKey &&
              (path === undefined || MovePath.overlaps(path, transition.path)),
          )
        if (overlaps) {
          state.diagnostics.push(
            Diagnostic.overlappingAssignment(root?.name ?? '?', statement.span),
          )
          continue
        }
        const current = live.get(rootKey) ?? MovePath.make('Missing')
        let selected = MovePath.make()
        if (statement.place._tag === 'WritePlace' && path !== undefined) {
          const target = MovePath.inspect(current, path, shape)
          if (Result.isFailure(target)) continue
          selected = target.success.state
        }
        const cleanup = cleanupPlan(state, statement.place.type)
        if (selected.initialization !== 'Missing' && cleanup._tag !== 'NoCleanup')
          state.replacements.push({
            _tag: 'Replacement',
            region: statement.region,
            type: statement.place.type,
            cleanup,
            span: statement.span,
            initialization: selected,
          })
        if (statement.place._tag === 'WritePlace' && path !== undefined) {
          const restored = MovePath.restore(current, path, shape)
          if (Result.isSuccess(restored)) {
            live.set(rootKey, restored.success)
            state.transitions.push({
              root: rootSite,
              path,
              kind: 'Write',
              span: statement.span,
              before: current,
              after: restored.success,
            })
          }
        }
        continue
      }
      if (statement._tag === 'While') {
        // The condition re-runs every iteration, so the loop-header baseline is the state at
        // loop entry: a condition that consumes an owner must show up as a back-edge mismatch.
        const incoming = new Map(live)
        if (!evaluate(statement.condition, false)) return { returned: true, live }
        const previousContinues = continueStates.get(statement.loop.ordinal)?.length ?? 0
        const previousBreaks = breakStates.get(statement.loop.ordinal)?.length ?? 0
        const loopFrames = [...frames.map((frame) => [...frame]), []]
        const loopResult = walkStatements(
          statement.body,
          statement.span,
          new Map(live),
          loopFrames,
          [...loopScopes, { loop: statement.loop, frame: loopFrames.length - 1 }],
        )
        const loopFrame = loopFrames.at(-1) ?? []
        const repeating: Array<FlowState> = [
          ...(continueStates.get(statement.loop.ordinal)?.slice(previousContinues) ?? []),
        ]
        if (!loopResult.returned) {
          exits.push({
            kind: 'LoopFallthrough' as const,
            span: statement.span,
            region: statement.region,
            target: statement.loop,
            initialization: new Map(loopResult.live),
            sites: [...loopFrame].reverse().filter((site) => present(loopResult.live, site)),
          })
          repeating.push(new Map(loopResult.live))
        }
        for (const candidate of repeating) {
          for (const site of loopFrame) candidate.delete(site)
        }
        const compatible = repeating.every((candidate) => sameLive(candidate, incoming))
        if (!compatible) {
          state.diagnostics.push(
            Diagnostic.incompatibleLoopHeader(statement.loop.ordinal, statement.span),
          )
        }
        const exitsFromLoop = breakStates.get(statement.loop.ordinal)?.slice(previousBreaks) ?? []
        for (const candidate of exitsFromLoop) {
          for (const site of loopFrame) candidate.delete(site)
        }
        live = intersection([incoming, ...exitsFromLoop])
        fixedPoints.push({
          loop: statement.loop,
          span: statement.span,
          incoming,
          repeating: repeating.map((candidate) => new Map(candidate)),
          following: new Map(live),
          compatible,
          iterations: repeating.length === 0 ? 1 : 2,
        })
        continue
      }
      if (statement._tag === 'Break' || statement._tag === 'Continue') {
        const targetScope = [...loopScopes]
          .reverse()
          .find((scope) => scope.loop.ordinal === statement.target.ordinal)
        const transferFrames =
          targetScope === undefined ? [frames.at(-1) ?? []] : frames.slice(targetScope.frame)
        const transferSites = [...transferFrames].reverse().flatMap((frame) => [...frame].reverse())
        const sites = transferSites.filter((site) => present(live, site))
        exits.push({
          kind: statement._tag,
          span: statement.span,
          region: statement.region,
          target: statement.target,
          sites,
          initialization: new Map(live),
          ...transferCleanup(targetScope?.frame ?? frames.length - 1),
        })
        const next = new Map(live)
        for (const site of transferSites) next.delete(site)
        appendLoopState(
          statement._tag === 'Break' ? breakStates : continueStates,
          statement.target,
          next,
        )
        return { returned: true, live }
      }
      if (statement._tag === 'Drop') {
        const place = placeOf(statement.expression)
        if (place !== undefined) {
          if (
            !checkPlaceInterior(
              state,
              live,
              statement.expression,
              state.execution?.guard ?? false,
              false,
            )
          )
            return { returned: true, live }
          const binding = state.bindings.get(siteKey(place.root))
          if (state.execution?.guard === true)
            state.diagnostics.push(
              Diagnostic.guardConsumesPattern(binding?.name ?? '?', statement.expression.span),
            )
          else if (
            (binding?.matchAccess === 'Shared' || binding?.matchAccess === 'Exclusive') &&
            binding.category._tag === 'MoveOnly'
          )
            state.diagnostics.push(
              Diagnostic.matchBorrowEscape(binding.name ?? '?', statement.expression.span),
            )
          else checkPath(state, live, place.root, place.path, statement.span, 'Drop')
        } else if (!evaluate(statement.expression, true)) return { returned: true, live }
        continue
      }
      if (statement._tag === 'UnavailableStatement') {
        continue
      }
      if (!evaluate(statement.expression, true)) return { returned: true, live }
      exits.push({
        kind: 'Return' as const,
        span: statement.span,
        region: statement.region,
        sites: frameSitesInnerFirst(frames, live),
        initialization: new Map(live),
        ...transferCleanup(),
      })
      return { returned: true, live }
    }
    return { returned: false, live }
  }

  const checkMatch = (
    live: FlowState,
    expression: Extract<Tir.Expression, { readonly _tag: 'Match' }>,
    consuming: boolean,
    guard: boolean,
    _escaping: boolean,
  ): boolean => {
    const execution = state.execution
    if (execution === undefined) return false
    const scrutineeSite = placeSite(expression.scrutinee)
    const scrutineeType =
      expression.scrutinee._tag === 'Unavailable' ? undefined : expression.scrutinee.type
    const scrutineeBinding =
      scrutineeSite === undefined ? undefined : state.bindings.get(siteKey(scrutineeSite))
    const temporaryMark = execution.temporaries.length
    const scrutineePlace = canonicalPlace(state, placeOf(expression.scrutinee))
    if (expression.access === 'Place') {
      if (scrutineePlace === undefined) {
        state.diagnostics.push(Diagnostic.invalidMatchScrutineePlace('Place', expression.span))
        return false
      }
      if (!checkPlaceInterior(state, live, expression.scrutinee, guard, false)) return false
      const current = live.get(siteKey(scrutineePlace.root)) ?? MovePath.make('Missing')
      const inspected = MovePath.inspect(
        current,
        scrutineePlace.path,
        shapeOf(state, scrutineePlace.root),
      )
      if (Result.isFailure(inspected)) {
        if (scrutineeBinding !== undefined)
          placeFailure(state, scrutineeBinding, inspected.failure, expression.span)
      } else if (inspected.success.discriminant !== 'Initialized' && !inspected.success.complete) {
        state.diagnostics.push(
          Diagnostic.useAfterMove(
            scrutineeBinding?.name ?? '?',
            scrutineeBinding?.movedAt ?? expression.span,
            expression.span,
          ),
        )
      }
    } else if (expression.access === 'Move' && scrutineePlace !== undefined) {
      if (!checkPlaceInterior(state, live, expression.scrutinee, guard, false)) return false
      checkPath(state, live, scrutineePlace.root, scrutineePlace.path, expression.span, 'Move')
    } else {
      if (!checkExpression(state, live, expression.scrutinee, expression.access === 'Move', guard))
        return false
      if (
        expression.access === 'Copy' &&
        categoryOf(index, scrutineeType, copyAssumptions)._tag === 'MoveOnly'
      )
        state.diagnostics.push(
          Diagnostic.explicitMoveRequired(scrutineeBinding?.name ?? '?', expression.span),
        )
      if (expression.access === 'Exclusive') {
        if (scrutineeSite === undefined)
          state.diagnostics.push(
            Diagnostic.invalidMatchScrutineePlace('Exclusive', expression.span),
          )
        else if (!supportsExclusiveAccess(scrutineeBinding))
          state.diagnostics.push(
            Diagnostic.exclusiveMatchRequiresMutable(
              scrutineeBinding?.name ?? '?',
              expression.span,
            ),
          )
      }
    }
    execution.temporaries.length = temporaryMark
    const memberPrefix = (member: Match.CoverageIdentity): MovePath.Path => {
      if (scrutineeType === undefined || !Type.isUnion(scrutineeType)) return []
      const selectedType = member.type
      const ordinal = scrutineeType.members.findIndex((type) => Type.equals(type, selectedType))
      return ordinal < 0 ? [] : [{ _tag: 'Variant', ordinal }]
    }
    const candidateFor = (member: Match.CoverageIdentity): FlowState => {
      const candidate = new Map(live)
      if (expression.access !== 'Place' || scrutineePlace === undefined) return candidate
      const key = siteKey(scrutineePlace.root)
      let current = candidate.get(key) ?? MovePath.make('Missing')
      const shape = shapeOf(state, scrutineePlace.root)
      const prefix = memberPrefix(member)
      const structural = prefix.at(0)
      if (structural?._tag === 'Variant') {
        const refined = MovePath.refine(current, scrutineePlace.path, structural.ordinal, shape)
        if (Result.isSuccess(refined)) current = refined.success
      }
      if (member._tag === 'NominalUnionVariant') {
        const refined = MovePath.refine(
          current,
          [...scrutineePlace.path, ...prefix],
          member.variantOrdinal,
          shape,
        )
        if (Result.isSuccess(refined)) current = refined.success
      }
      candidate.set(key, current)
      return candidate
    }
    const candidates = new Map(
      expression.members.map((member) => [Match.encodeIdentity(member), candidateFor(member)]),
    )
    // A `never` match has no result value to consume. This also covers the non-executable
    // recovery match retained after a rejected result join, whose arms remain available to
    // tooling but must not produce follow-on move diagnostics.
    const consumesArmResult = consuming && !Type.isNever(expression.type)
    const continuing: Array<FlowState> = []
    const armFacts: Array<MatchOwnership['arms'][number]> = []
    for (const arm of expression.arms) {
      if (!arm.reachable) continue
      const selected = expression.members.filter(
        (member) =>
          candidates.has(Match.encodeIdentity(member)) &&
          (arm.universal || (arm.member !== undefined && Match.selects(arm.member, member))),
      )
      if (selected.length === 0) continue
      const armLive = intersection(
        selected.flatMap((member) => {
          const candidate = candidates.get(Match.encodeIdentity(member))
          return candidate === undefined ? [] : [candidate]
        }),
      )
      const sites: Array<BindingSite> = []
      const frame: Array<string> = []
      const frames = [...execution.frames.map((frame) => [...frame]), frame]
      const armExecution: ExpressionExecution = {
        ...execution,
        frames,
        regions: [...execution.regions],
      }
      const matchMark = execution.matches.length
      const payloadType = arm.member === undefined ? scrutineeType : Match.sourceType(arm.member)
      const cleanup: MatchOwnership['arms'][number]['cleanup'] =
        expression.access === 'Move'
          ? arm.cleanup.flatMap((path) => {
              const type = CleanupPlan.cleanupTypeAtPath(index, payloadType, path)
              return type === undefined ? [] : [{ path, cleanup: cleanupPlan(state, type) }]
            })
          : []
      const payloadOrdinal = state.nextAcquisition++
      const placeMutability =
        expression.access === 'Place' && scrutineePlace !== undefined
          ? (state.bindings.get(siteKey(scrutineePlace.root))?.mutability ?? 'Immutable')
          : 'Immutable'
      for (const pattern of arm.bindings) {
        const site: BindingSite = { _tag: 'Pattern', binding: pattern.id }
        const mutable: MutableBinding = {
          ordinal: state.nextAcquisition++,
          site,
          name: pattern.name,
          mutability: pattern.access === 'Exclusive' ? 'Mutable' : placeMutability,
          liveFrom: pattern.span,
          liveTo: arm.span,
          category: categoryOf(index, pattern.type, copyAssumptions),
          type: pattern.type,
          matchAccess: pattern.access,
          ...(expression.access === 'Place' && scrutineePlace !== undefined
            ? {
                place: {
                  root: scrutineePlace.root,
                  path: [
                    ...scrutineePlace.path,
                    ...(arm.member === undefined ? [] : memberPrefix(arm.member)),
                    ...pattern.path.flatMap(fieldSelectors),
                  ],
                },
              }
            : {}),
        }
        const key = siteKey(site)
        state.bindings.set(key, mutable)
        state.order.push(mutable)
        armLive.set(key, MovePath.make())
        sites.push(site)
      }
      state.execution = armExecution
      // Guard bindings are provisional. A guard exit releases the still-whole active payload,
      // while a Boolean false leaves that payload available for a following candidate.
      if (expression.access === 'Move' && payloadType !== undefined)
        execution.matches.push({
          frame: frames.length - 1,
          release: {
            ordinal: payloadOrdinal,
            id: expression.match,
            arm: arm.id,
            cleanup: [{ path: [], cleanup: cleanupPlan(state, payloadType) }],
          },
        })
      const guardCompletes =
        arm.guard === undefined || checkExpression(state, armLive, arm.guard, false, true)
      execution.temporaries.length = temporaryMark
      execution.matches.length = matchMark
      const afterGuard = new Map(armLive)
      for (const site of sites) afterGuard.delete(siteKey(site))
      for (const member of selected) {
        const key = Match.encodeIdentity(member)
        const remains = arm.after.some((candidate) => Match.identityEquals(candidate, member))
        const rejected = (arm.tests?.length ?? 0) > 0 ? candidates.get(key) : undefined
        const guardRejected = arm.guard !== undefined && guardCompletes ? afterGuard : undefined
        const continuations = [rejected, guardRejected].filter(
          (flow): flow is FlowState => flow !== undefined,
        )
        if (remains && continuations.length > 0) candidates.set(key, intersection(continuations))
        else candidates.delete(key)
      }
      let completes = false
      if (guardCompletes) {
        for (const site of sites) {
          const binding = state.bindings.get(siteKey(site))
          if (
            binding?.matchAccess !== 'Shared' &&
            binding?.matchAccess !== 'Exclusive' &&
            binding?.matchAccess !== 'Place'
          )
            frame.push(siteKey(site))
        }
        execution.matches.push({
          frame: frames.length - 1,
          release: {
            ordinal: payloadOrdinal,
            id: expression.match,
            arm: arm.id,
            cleanup,
          },
        })
        if (arm.body._tag === 'Expression') {
          completes = checkExpression(
            state,
            armLive,
            arm.body.expression,
            consumesArmResult,
            guard,
            true,
          )
        } else {
          const result = walkStatements(
            arm.body.statements,
            arm.body.span,
            armLive,
            frames,
            execution.loopScopes,
          )
          completes = !result.returned
          const completedLive = [...result.live]
          armLive.clear()
          for (const [key, initialization] of completedLive) armLive.set(key, initialization)
        }
      }
      execution.temporaries.length = temporaryMark
      execution.matches.length = matchMark
      state.execution = execution
      armFacts.push({
        id: arm.id,
        ...(arm.member === undefined ? {} : { member: arm.member }),
        universal: arm.universal,
        provisionalGuard: arm.guard !== undefined,
        bindings: sites,
        cleanup,
      })
      if (completes) {
        exits.push({
          kind: 'ArmEnd',
          span: arm.span,
          sites: [...frame].reverse().filter((site) => present(armLive, site)),
          initialization: new Map(armLive),
        })
        for (const site of [...frame, ...sites.map(siteKey)]) armLive.delete(site)
        continuing.push(armLive)
      }
    }
    live.clear()
    for (const [site, initialization] of intersection(continuing)) live.set(site, initialization)
    state.matches.push({
      _tag: 'MatchOwnership',
      id: expression.match,
      access: expression.access,
      span: expression.span,
      arms: armFacts,
    })
    return continuing.length > 0
  }

  const rootFrame = state.order
    .filter((binding) => binding.category._tag === 'MoveOnly')
    .map((binding) => siteKey(binding.site))
  const result = walkStatements(fn.statements, context.spanOf(declaration.anchor), initialLive, [
    rootFrame,
  ])
  if (!result.returned) {
    exits.push({
      kind: 'Return' as const,
      span: fn.statements.at(-1)?.span ?? context.spanOf(declaration.anchor),
      sites: frameSitesInnerFirst([rootFrame], result.live),
      initialization: new Map(result.live),
    })
  }

  const bindingFactOf = (binding: MutableBinding): BindingFact => ({
    _tag: 'Binding',
    ordinal: binding.ordinal,
    site: binding.site,
    name: binding.name,
    mutability: binding.mutability,
    category: binding.category,
    executionAffinity:
      binding.executionAffinity ??
      (binding.type === undefined
        ? ExecutionAffinity.ofEnvironment(index, [
            binding.cause === undefined ? {} : { cause: binding.cause },
          ])
        : ExecutionAffinity.ofType(index, binding.type)),
    localSharedObligations:
      binding.localSharedObligations ??
      (binding.type === undefined
        ? LocalSharedOwnership.ofEnvironment(index, [
            binding.cause === undefined
              ? { access: 'Take' as const }
              : { access: 'Take' as const, cause: binding.cause },
          ])
        : LocalSharedOwnership.ofType(index, binding.type)),
    ...(binding.type === undefined ? {} : { type: binding.type }),
    cleanup:
      binding.cleanup ??
      (binding.type === undefined
        ? { _tag: 'NoCleanup' as const, type: 'i32' as const }
        : cleanupPlan(state, binding.type)),
    liveFrom: binding.liveFrom,
    liveTo: binding.liveTo,
    ...(binding.movedAt === undefined ? {} : { movedAt: binding.movedAt }),
    ...(binding.place === undefined ? {} : { place: binding.place }),
  })
  const bindings = state.order.map(bindingFactOf)
  const deferredBindings = deferredReleaseOrder.map(bindingFactOf)
  const bindingBySite = new Map(
    [...bindings, ...deferredBindings].map((binding) => [siteKey(binding.site), binding] as const),
  )

  const cleanupExits = exits.map((exit): ExitPlan => ({
    _tag: 'Exit' as const,
    kind: exit.kind,
    temporaries: exit.temporaries ?? [],
    matches: exit.matches ?? [],
    span: exit.span,
    ...(exit.region === undefined ? {} : { region: exit.region }),
    ...(exit.arm === undefined ? {} : { arm: exit.arm }),
    ...(exit.target === undefined ? {} : { target: exit.target }),
    loanEnds: [],
    releases: exit.sites.flatMap((site): ReadonlyArray<Release> => {
      const fact = bindingBySite.get(site)
      const mutable = state.bindings.get(site)
      if (fact === undefined || mutable === undefined) return []
      // Scope frames track borrowed bindings too, but their owner retains cleanup authority.
      if (mutable.site._tag === 'Parameter') {
        const ordinal = mutable.site.parameter.ordinal
        const access = declaration.parameters.find(
          (parameter) => parameter.id.ordinal === ordinal,
        )?.captureAccess
        if (access === 'Shared' || access === 'Exclusive') return []
      }
      if (
        mutable.matchAccess === 'Shared' ||
        mutable.matchAccess === 'Exclusive' ||
        mutable.matchAccess === 'Place'
      )
        return []
      return [
        {
          _tag: 'Release' as const,
          ordinal: mutable.ordinal,
          binding: fact,
          fields:
            fact.category._tag === 'MoveOnly' && Type.isNominal(fact.category.type)
              ? CleanupPlan.cleanupFields(index, fact.category.type)
              : [],
          cleanup: fact.cleanup,
          initialization: exit.initialization.get(site) ?? MovePath.make('Missing'),
        },
      ]
    }),
  }))

  // Loans are read off the checked body itself; the region proof is the one result construction
  // publishes beside it, extended by the cleanup this pass just planned.
  const loanLifetimes =
    lifetimes === undefined ? undefined : LifetimeFlow.withCleanupUses(lifetimes, cleanupExits)
  const loanAnalysis =
    loanLifetimes === undefined
      ? {
          loanAccessChecks: 0,
          loans: [],
          diagnostics: [],
        }
      : analyzeLoans(
          { ...LoanView.ofTir(fn, index, artifact), lifetimeFlow: loanLifetimes },
          index,
          copyAssumptions,
          cleanupExits,
          context,
        )
  state.work.loanAccessChecks = loanAnalysis.loanAccessChecks
  state.diagnostics.push(...loanAnalysis.diagnostics)
  const exitPlans = cleanupExits.map((plan, ordinal): ExitPlan => {
    const exit = exits.at(ordinal)
    if (exit === undefined) return plan
    return {
      ...plan,
      loanEnds: loanAnalysis.loans
        .filter(
          (loan) =>
            (exit.region !== undefined && loan.endRegion.ordinal === exit.region.ordinal) ||
            ((exit.loanRegions ?? []).some(
              (region) =>
                region.ordinal === loan.endRegion.ordinal ||
                region.ordinal === loan.startRegion.ordinal,
            ) &&
              loan.startSpan.start <= exit.span.start &&
              loan.endSpan.end > exit.span.start),
        )
        .map((loan) => loan.id),
    }
  })

  const firstUnavailable = Tir.firstUnavailable(fn)
  const violation = state.diagnostics.at(0)
  let verdict: Verdict
  if (fn.contract._tag === 'Unavailable') {
    verdict = {
      _tag: 'Unavailable',
      ...(fn.contract.cause === undefined ? {} : { cause: fn.contract.cause }),
    }
  } else if (firstUnavailable !== undefined) {
    const cause =
      firstUnavailable.cause === undefined
        ? undefined
        : state.causes.at(firstUnavailable.cause.ordinal)
    verdict = {
      _tag: 'Unavailable',
      ...(cause === undefined ? {} : { cause }),
    }
  } else if (violation !== undefined) {
    verdict = { _tag: 'Violation', cause: Diagnostic.identity(violation) }
  } else {
    verdict = satisfied
  }

  const checked: CheckedFunction = {
    ownership: {
      _tag: 'FunctionOwnership' as const,
      work: { ...state.work },
      cleanupLifetimeWork:
        loanLifetimes !== lifetimes && loanLifetimes?.solution._tag === 'Solved'
          ? { liveness: loanLifetimes.solution.work }
          : {},
      declaration,
      bindings,
      deferredBindings,
      exits: exitPlans,
      fixedPoints: fixedPoints.map((point) => {
        const sites = (keys: ReadonlyFlowState): ReadonlyArray<BindingSite> =>
          [...keys.keys()].flatMap((key): ReadonlyArray<BindingSite> => {
            const binding = bindingBySite.get(key)
            return binding === undefined ? [] : [binding.site]
          })
        return {
          _tag: 'LoopFixedPoint' as const,
          loop: point.loop,
          span: point.span,
          incoming: sites(point.incoming),
          repeating: point.repeating.map(sites),
          following: sites(point.following),
          compatible: point.compatible,
          iterations: point.iterations,
        }
      }),
      matches: state.matches,
      callables: state.callables,
      loans: loanAnalysis.loans,
      replacements: state.replacements,
      transitions: state.transitions,
      verdict,
    },
    diagnostics: [...state.diagnostics],
  }
  if (lifetimes === undefined || checked.ownership.verdict._tag !== 'Satisfied') return checked
  const cleanup = LifetimeFlow.validateCleanup(lifetimes, checked.ownership, context)
  const firstCleanupViolation = cleanup.diagnostics.at(0)
  return {
    ownership: {
      ...checked.ownership,
      cleanupLifetimeWork: {
        ...checked.ownership.cleanupLifetimeWork,
        ...(cleanup.work === undefined ? {} : { validity: cleanup.work }),
      },
      verdict:
        firstCleanupViolation !== undefined
          ? {
              _tag: 'Violation' as const,
              cause: Diagnostic.identity(firstCleanupViolation),
            }
          : checked.ownership.verdict,
    },
    diagnostics: [...checked.diagnostics, ...cleanup.diagnostics].sort(Diagnostic.compare),
  }
}

/** Every input read by the ownership checker, after callback boundaries are selected. */
export interface CheckInput {
  readonly function: Tir.TirFunction
  readonly artifact: Tir.ArtifactId
  readonly causes: Elaboration.BodyResults['causes']
  /** The region proof published with the body; absent for a body construction never analyzed. */
  readonly lifetimes: LifetimeFlow.LifetimeFlow | undefined
  readonly index: DeclarationIndex.Index
  /** Spans and evaluation order of this function's authored module. */
  readonly context: SemanticContext.SemanticContext
  readonly boundaries: ReadonlyArray<SourceSpan.SourceSpan>
  readonly resultBoundaries: ReadonlyArray<SourceSpan.SourceSpan>
}

/** Resolves ownership inputs without running the checker or reconstructing prior diagnostics. */
export const input = (
  fn: Tir.TirFunction,
  artifact: Tir.ArtifactId,
  lifetimes: LifetimeFlow.LifetimeFlow | undefined,
  index: DeclarationIndex.Index,
  accessBoundaryPlan: LocalSharedAccessBoundaryPlan,
  context: SemanticContext.SemanticContext,
  causes: Elaboration.BodyResults['causes'] = [],
): CheckInput => ({
  function: fn,
  artifact,
  causes,
  lifetimes,
  index,
  context,
  boundaries:
    fn.declaration.canonical._tag === 'Canonical'
      ? (accessBoundaryPlan.boundaries.get(localSharedTargetKey(fn.declaration.canonical.id)) ?? [])
      : [],
  resultBoundaries:
    fn.declaration.canonical._tag === 'Canonical'
      ? (accessBoundaryPlan.resultBoundaries.get(
          localSharedTargetKey(fn.declaration.canonical.id),
        ) ?? [])
      : [],
})

const sameBoundarySpans = (
  left: ReadonlyArray<SourceSpan.SourceSpan>,
  right: ReadonlyArray<SourceSpan.SourceSpan>,
): boolean =>
  left.length === right.length &&
  left.every((span, ordinal) => {
    const other = right[ordinal]
    return (
      other !== undefined &&
      span.sourceId === other.sourceId &&
      span.start === other.start &&
      span.end === other.end
    )
  })

/** Requires identical semantic authorities and equal ordered access-boundary spans. */
export const matchesInput = (self: CheckInput, other: CheckInput): boolean =>
  self.function === other.function &&
  Tir.artifactKey(self.artifact) === Tir.artifactKey(other.artifact) &&
  self.causes === other.causes &&
  self.lifetimes === other.lifetimes &&
  self.index === other.index &&
  self.context === other.context &&
  sameBoundarySpans(self.boundaries, other.boundaries) &&
  sameBoundarySpans(self.resultBoundaries, other.resultBoundaries)

/** Executes ownership checking with exactly the supplied semantic authorities. */
export const check = (self: CheckInput): CheckedFunction =>
  checkFunction(
    self.function,
    self.artifact,
    self.index,
    self.context,
    self.causes,
    self.lifetimes,
    self.boundaries,
    self.resultBoundaries,
  )

interface SourceProof {
  readonly input: CheckInput
  readonly checked: CheckedFunction
}

const sourceProofs = new WeakMap<
  DeclarationIndex.Index,
  WeakMap<Tir.TirFunction, Array<SourceProof>>
>()

/** Reads a result published at the source checker boundary for these exact current inputs. */
export const sourceProof = (self: CheckInput): CheckedFunction | undefined =>
  sourceProofs
    .get(self.index)
    ?.get(self.function)
    ?.find((proof) => matchesInput(proof.input, self))?.checked

const publishSourceProof = (self: CheckInput, checked: CheckedFunction): void => {
  let functions = sourceProofs.get(self.index)
  if (functions === undefined) {
    functions = new WeakMap()
    sourceProofs.set(self.index, functions)
  }
  const proofs = functions.get(self.function) ?? []
  if (!proofs.some((proof) => matchesInput(proof.input, self)))
    proofs.push({ input: self, checked })
  functions.set(self.function, proofs)
}

/** Classifies the result-side ownership facts of one access-scoped callback invocation. */
export const localSharedResultEscapes = (facts: {
  readonly resultType: Type.Type
  readonly capturesRestrictedParameter: boolean
  readonly referencesRestrictedParameter: boolean
}): boolean =>
  Type.containsBorrowWrapper(facts.resultType) ||
  facts.capturesRestrictedParameter ||
  ((Type.isEffect(facts.resultType) ||
    Type.isCallable(facts.resultType) ||
    Type.containsExecutableRepresentation(facts.resultType)) &&
    facts.referencesRestrictedParameter)

/**
 * Exact ordinary callback bodies reached from the sealed local-shared access operation.
 *
 * The callback parameter of an ordinary wrapper earns access-boundary behavior only by forwarding
 * to `SharedWithMut`. Its declaration shape and the spelling of the wrapper are irrelevant.
 */
export interface LocalSharedAccessBoundaryPlan {
  readonly _tag: 'LocalSharedAccessBoundaryPlan'
  readonly boundaries: ReadonlyMap<string, ReadonlyArray<SourceSpan.SourceSpan>>
  readonly resultBoundaries: ReadonlyMap<string, ReadonlyArray<SourceSpan.SourceSpan>>
}

const localSharedTargetKey = (target: DeclarationFacts.CanonicalId): string =>
  `${target.module}\u0000${target.name}`

/** Propagates sealed callback edges through ordinary wrappers across the loaded module closure. */
export const localSharedAccessBoundaryPlan = (
  results: ReadonlyMap<string, Elaboration.Result>,
): LocalSharedAccessBoundaryPlan => {
  const callbackOrdinals = new Map<string, Set<number>>()
  const bindingsByFunction = new Map<Tir.TirFunction, ReadonlyMap<number, Tir.Expression>>()
  const bindingsOf = (fn: Tir.TirFunction): ReadonlyMap<number, Tir.Expression> => {
    const cached = bindingsByFunction.get(fn)
    if (cached !== undefined) return cached
    const bindings = new Map<number, Tir.Expression>()
    const collect = (statements: ReadonlyArray<Tir.Statement>): void => {
      for (const statement of statements) {
        if (statement._tag === 'Bind')
          bindings.set(statement.binding.ordinal, statement.initializer)
        if (statement._tag === 'Unsafe') collect(statement.statements)
        if (statement._tag === 'If' || statement._tag === 'IfLet') {
          collect(statement.taken)
          collect(statement.otherwise)
        }
        if (statement._tag === 'While') collect(statement.body)
      }
    }
    collect(fn.statements)
    bindingsByFunction.set(fn, bindings)
    return bindings
  }
  const parameterOrdinals = (
    expression: Tir.Expression,
    bindings: ReadonlyMap<number, Tir.Expression>,
    seen = new Set<number>(),
  ): ReadonlySet<number> => {
    if (expression._tag === 'ParameterReference') return new Set([expression.parameter.ordinal])
    if (expression._tag === 'Move') return parameterOrdinals(expression.subject, bindings, seen)
    if (expression._tag === 'UnionConvert')
      return parameterOrdinals(expression.source, bindings, seen)
    if (expression._tag === 'CallableSection')
      return new Set(
        expression.captures.flatMap((capture) => [
          ...parameterOrdinals(capture.value, bindings, seen),
        ]),
      )
    if (expression._tag !== 'BindingReference' || seen.has(expression.binding.ordinal))
      return new Set()
    const initializer = bindings.get(expression.binding.ordinal)
    return initializer === undefined
      ? new Set()
      : parameterOrdinals(initializer, bindings, new Set(seen).add(expression.binding.ordinal))
  }
  const functions = [...results.values()].flatMap((result) => result.tir.functions)
  let changed = true
  while (changed) {
    changed = false
    for (const fn of functions) {
      if (fn.declaration.canonical._tag !== 'Canonical') continue
      const owner = localSharedTargetKey(fn.declaration.canonical.id)
      const ordinals = callbackOrdinals.get(owner) ?? new Set<number>()
      const bindings = bindingsOf(fn)
      for (const expression of fn.statements
        .flatMap(Tir.statementExpressions)
        .flatMap(Tir.expressionTree)) {
        let boundaryOrdinals: ReadonlySet<number> | undefined
        let arguments_: ReadonlyArray<Tir.Expression> | undefined
        if (expression._tag === 'BuiltinCall' && expression.operation === 'SharedWithMut') {
          boundaryOrdinals = new Set([1])
          arguments_ = expression.arguments
        } else if (expression._tag === 'Call') {
          boundaryOrdinals = callbackOrdinals.get(localSharedTargetKey(expression.target))
          arguments_ = expression.arguments
        }
        if (boundaryOrdinals === undefined) continue
        for (const boundaryOrdinal of boundaryOrdinals) {
          const argument = arguments_?.at(boundaryOrdinal)
          if (argument === undefined) continue
          for (const ordinal of parameterOrdinals(argument, bindings)) {
            if (ordinals.has(ordinal)) continue
            ordinals.add(ordinal)
            changed = true
          }
        }
      }
      if (ordinals.size > 0) callbackOrdinals.set(owner, ordinals)
    }
  }

  const boundaries = new Map<string, Array<SourceSpan.SourceSpan>>()
  const callableTarget = (
    expression: Tir.Expression,
    bindings: ReadonlyMap<number, Tir.Expression>,
    seen = new Set<number>(),
  ): Tir.CallableTarget | undefined => {
    if (expression._tag === 'FunctionItem' || expression._tag === 'CallableSection')
      return expression.target
    if (expression._tag === 'Move') return callableTarget(expression.subject, bindings, seen)
    if (expression._tag === 'UnionConvert') return callableTarget(expression.source, bindings, seen)
    if (expression._tag !== 'BindingReference' || seen.has(expression.binding.ordinal))
      return undefined
    const initializer = bindings.get(expression.binding.ordinal)
    return initializer === undefined
      ? undefined
      : callableTarget(initializer, bindings, new Set(seen).add(expression.binding.ordinal))
  }
  for (const fn of functions) {
    const bindings = bindingsOf(fn)
    for (const expression of fn.statements
      .flatMap(Tir.statementExpressions)
      .flatMap(Tir.expressionTree)) {
      let ordinals: ReadonlySet<number> | undefined
      let arguments_: ReadonlyArray<Tir.Expression> | undefined
      if (expression._tag === 'BuiltinCall' && expression.operation === 'SharedWithMut') {
        ordinals = new Set([1])
        arguments_ = expression.arguments
      } else if (expression._tag === 'Call') {
        ordinals = callbackOrdinals.get(localSharedTargetKey(expression.target))
        arguments_ = expression.arguments
      }
      if (ordinals === undefined) continue
      for (const ordinal of ordinals) {
        const argument = arguments_?.at(ordinal)
        const target = argument === undefined ? undefined : callableTarget(argument, bindings)
        if (target?._tag !== 'DeclarationCallableTarget') continue
        const key = localSharedTargetKey(target.declaration)
        const existing = boundaries.get(key)
        if (existing === undefined) boundaries.set(key, [expression.span])
        else existing.push(expression.span)
      }
    }
  }
  // Only a callback's result crosses the access boundary. A helper may return an intermediate
  // borrow to that callback, provided the callback consumes it before returning its own result.
  const resultBoundaries = new Map(
    [...boundaries].map(([key, spans]) => [key, [...spans]] as const),
  )
  // Every synchronous helper called by a restricted callback still runs while the original access
  // loan is live, even when it does not receive the borrowed parameter. Propagate the sealed
  // boundary through the complete ordinary call graph so transitive park or wake is judged exactly
  // like direct callback code, independent of helper names.
  changed = true
  while (changed) {
    changed = false
    for (const fn of functions) {
      if (fn.declaration.canonical._tag !== 'Canonical') continue
      const inherited = boundaries.get(localSharedTargetKey(fn.declaration.canonical.id))
      if (inherited === undefined || inherited.length === 0) continue
      for (const expression of fn.statements
        .flatMap(Tir.statementExpressions)
        .flatMap(Tir.expressionTree)) {
        if (expression._tag !== 'Call') continue
        const key = localSharedTargetKey(expression.target)
        const existing = boundaries.get(key) ?? []
        const added = inherited.filter(
          (span) =>
            !existing.some(
              (candidate) =>
                candidate.sourceId === span.sourceId &&
                candidate.start === span.start &&
                candidate.end === span.end,
            ),
        )
        if (added.length === 0) continue
        boundaries.set(key, [...existing, ...added])
        changed = true
      }
    }
  }
  return {
    _tag: 'LocalSharedAccessBoundaryPlan',
    resultBoundaries,
    boundaries: new Map([...boundaries].map(([key, spans]) => [key, spans] as const)),
  }
}

/** Checks every declaration of one elaborated module once, producing its ownership facts. */
export const checkModule = (
  result: Elaboration.Result,
  index: DeclarationIndex.Index,
  accessBoundaryPlan: LocalSharedAccessBoundaryPlan,
  bodyQuery?: BodyQuery.BodyQuery,
  semantic?: Semantic.Session,
): ModuleOwnership => {
  const context = SemanticContext.make(result.authored)
  const checked = result.bodies.flatMap((body) => {
    // A `static fn` runs in the evaluator: it owns nothing at run time.
    if (body.declaration.phase === 'Static') return []
    const fn = body.function
    const selected = input(
      fn,
      body.artifact,
      body.results.lifetimes,
      index,
      accessBoundaryPlan,
      context,
      body.results.causes,
    )
    const compute = () => check(selected)
    const checked =
      semantic === undefined
        ? compute()
        : Semantic.ownership(semantic, bodyQuery, selected, compute)
    publishSourceProof(selected, checked)
    return [checked]
  })
  return {
    _tag: 'OwnershipFacts',
    module: context.presentation.sourceId,
    functions: checked.map((entry) => entry.ownership),
    diagnostics: checked.flatMap((entry) => entry.diagnostics).sort(Diagnostic.compare),
  }
}
