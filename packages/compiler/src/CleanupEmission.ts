import * as ConcreteCleanup from './ConcreteCleanup.js'
import * as CleanupPlan from './CleanupPlan.js'
import * as BodyView from './BodyView.js'
import * as DeclarationFacts from './DeclarationFacts.js'
import type * as Match from './Match.js'
import { endLoans } from './EffectLowering.js'
import type {} from './EntryAssembly.js'
import type {} from './Forwarding.js'
import type { FunctionLowering, TemporaryBorrowOwner } from './FunctionLowering.js'
import * as Tir from './Tir.js'
import * as TypeInference from './internal/TypeInference.js'
import * as Instances from './Instances.js'
import * as Layout from './Layout.js'
import type { DelayedEffectState } from './Lower.js'
import { bool, borrowKey, patternKey, spanKey } from './Lower.js'
import type {} from './LowerExpression.js'
import { lowerExpression } from './LowerExpression.js'
import * as Mir from './Mir.js'
import * as MovePath from './MovePath.js'
import * as Ownership from './Ownership.js'
import type * as SourceSpan from './SourceSpan.js'
import * as Type from './Type.js'

export interface ExitIndex {
  readonly returns: ReadonlyMap<string, Ownership.ExitPlan>
  readonly scopeEnds: ReadonlyMap<string, Ownership.ExitPlan>
  readonly armEnds: ReadonlyMap<string, Ownership.ExitPlan>
  readonly loopFallthroughs: ReadonlyMap<number, Ownership.ExitPlan>
  readonly transfers: ReadonlyMap<string, Ownership.ExitPlan>
}

/** Allocates only flags demanded by a conditional ownership fact, before entering any branch. */
export const prepareInitialization = (fn: FunctionLowering): ReadonlyArray<Mir.Operation> => {
  if (fn.initializationStarted) return []
  fn.initializationStarted = true
  const roots = new Map<string, Map<string, MovePath.Path>>()
  const collect = (root: Ownership.BindingSite, state: MovePath.State): void => {
    const key = Ownership.siteKey(root)
    const paths = roots.get(key) ?? new Map<string, MovePath.Path>()
    for (const path of MovePath.conditionalPaths(state)) paths.set(MovePath.key(path), path)
    if (paths.size > 0) roots.set(key, paths)
  }
  for (const exit of fn.ownership?.exits ?? [])
    for (const release of exit.releases) collect(release.binding.site, release.initialization)
  for (const transition of fn.ownership?.transitions ?? []) {
    collect(transition.root, transition.before)
    collect(transition.root, transition.after)
  }
  const operations: Array<Mir.Operation> = []
  for (const [root, paths] of [...roots].sort(([left], [right]) => left.localeCompare(right))) {
    const flags = [...paths]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, path]) => {
        const local = fn.alloc(bool)
        operations.push({
          _tag: 'SetInitialized',
          flag: local,
          initialized: true,
          provenance: generated(fn.registry.spanOf(fn.owner.function.declaration.anchor)),
        })
        return { path, local }
      })
    fn.initializationFlags.set(root, flags)
  }
  for (const binding of fn.ownership?.bindings ?? []) {
    const local = ownershipLocal(fn, binding.site)
    if (local !== undefined) fn.initializationFlagRoots.set(Ownership.siteKey(binding.site), local)
  }
  return operations
}

/** Resets an acquired binding's sparse flags, including on repeated loop entry. */
export const initializeBinding = (
  fn: FunctionLowering,
  root: Ownership.BindingSite,
  span: SourceSpan.SourceSpan,
): void => {
  const local = ownershipLocal(fn, root)
  if (local !== undefined) fn.initializationFlagRoots.set(Ownership.siteKey(root), local)
  for (const flag of fn.initializationFlags.get(Ownership.siteKey(root)) ?? [])
    fn.emit({
      _tag: 'SetInitialized',
      flag: flag.local,
      initialized: true,
      provenance: generated(span),
    })
}

/** Mirrors one committed move/write/drop into the flags its later conditional cleanup observes. */
export const emitInitializationTransition = (
  fn: FunctionLowering,
  transition: Ownership.PlaceTransition,
): void => {
  for (const flag of fn.initializationFlags.get(Ownership.siteKey(transition.root)) ?? []) {
    if (flag.path.length < transition.path.length || !MovePath.overlaps(flag.path, transition.path))
      continue
    fn.emit({
      _tag: 'SetInitialized',
      flag: flag.local,
      initialized: transition.kind === 'Write',
      provenance: generated(transition.span),
    })
  }
}

/** Resolves exact conditional state relative to the local being cleaned, preserving sparse paths. */
export const initializationFor = (
  fn: FunctionLowering,
  root: Ownership.BindingSite,
  state: MovePath.State,
  path: MovePath.Path = [],
): Mir.DropOperation['initialization'] => {
  if (state.initialization === 'Initialized' && state.children.length === 0) return undefined
  const required = new Set(MovePath.conditionalPaths(state).map(MovePath.key))
  const flags = (fn.initializationFlags.get(Ownership.siteKey(root)) ?? []).flatMap((flag) =>
    flag.path.length >= path.length &&
    MovePath.overlaps(flag.path, path) &&
    required.has(MovePath.key(flag.path.slice(path.length)))
      ? [{ path: flag.path.slice(path.length), local: flag.local }]
      : [],
  )
  return { state, flags: flags }
}

interface OwnershipIndex {
  /** The first binding fact per binding site, as a source-ordered scan would select it. */
  readonly bindings: ReadonlyMap<string, Ownership.BindingFact>
  /** The first pattern binding fact per pattern key, as a source-ordered scan would select it. */
  readonly patterns: ReadonlyMap<string, Ownership.BindingFact>
  /** Source-ordered transitions per kind and span. */
  readonly transitions: ReadonlyMap<string, ReadonlyArray<Ownership.PlaceTransition>>
}

// Every place expression resolves its binding and transition. Scanning all bindings and
// transitions per expression cost about 9 s in the selfhost lowering profile; ownership facts
// are immutable, so each function indexes them once.
const ownershipIndexes = new WeakMap<Ownership.FunctionOwnership, OwnershipIndex>()

const transitionKey = (kind: Ownership.PlaceTransition['kind'], span: SourceSpan.SourceSpan) =>
  `${kind}:${spanKey(span)}`

const ownershipIndex = (ownership: Ownership.FunctionOwnership): OwnershipIndex => {
  const existing = ownershipIndexes.get(ownership)
  if (existing !== undefined) return existing
  const bindings = new Map<string, Ownership.BindingFact>()
  const patterns = new Map<string, Ownership.BindingFact>()
  for (const binding of Ownership.allBindings(ownership)) {
    const key = Ownership.siteKey(binding.site)
    if (!bindings.has(key)) bindings.set(key, binding)
    if (binding.site._tag !== 'Pattern') continue
    const pattern = patternKey(binding.site.binding)
    if (!patterns.has(pattern)) patterns.set(pattern, binding)
  }
  const transitions = new Map<string, Array<Ownership.PlaceTransition>>()
  for (const transition of ownership.transitions) {
    const key = transitionKey(transition.kind, transition.span)
    const group = transitions.get(key)
    if (group === undefined) transitions.set(key, [transition])
    else group.push(transition)
  }
  const index = { bindings, patterns, transitions }
  ownershipIndexes.set(ownership, index)
  return index
}

/** The first binding fact of the function at one binding site. */
export const bindingAt = (
  fn: FunctionLowering,
  site: Ownership.BindingSite,
): Ownership.BindingFact | undefined =>
  fn.ownership === undefined
    ? undefined
    : ownershipIndex(fn.ownership).bindings.get(Ownership.siteKey(site))

/** The first pattern binding fact of the function for one pattern binding identity. */
export const patternBinding = (
  fn: FunctionLowering,
  binding: Match.BindingId | Tir.LocalId,
): Ownership.BindingFact | undefined =>
  fn.ownership === undefined
    ? undefined
    : ownershipIndex(fn.ownership).patterns.get(patternKey(binding))

export const transitionAt = (
  fn: FunctionLowering,
  span: SourceSpan.SourceSpan,
  kind: Ownership.PlaceTransition['kind'],
  root?: Ownership.BindingSite,
): Ownership.PlaceTransition | undefined => {
  if (fn.ownership === undefined) return undefined
  const index = ownershipIndex(fn.ownership)
  const canonicalRoot = (site: Ownership.BindingSite): Ownership.BindingSite => {
    const alias = index.bindings.get(Ownership.siteKey(site))?.place?.root
    return alias === undefined ? site : canonicalRoot(alias)
  }
  const rootKey = root === undefined ? undefined : Ownership.siteKey(canonicalRoot(root))
  return index.transitions
    .get(transitionKey(kind, span))
    ?.find((transition) => rootKey === undefined || Ownership.siteKey(transition.root) === rootKey)
}

/** Resolves a canonical source owner to its retained MIR storage. */
export const ownershipLocal = (
  fn: FunctionLowering,
  site: Ownership.BindingSite,
): Mir.LocalId | undefined => {
  if (site._tag === 'Parameter') return fn.parameterLocals.get(site.parameter.ordinal)
  if (site._tag === 'Let') return fn.bindingLocals.get(site.binding.ordinal)
  if (site._tag === 'Pattern') return fn.patternLocals.get(patternKey(site.binding))
  return undefined
}

/** Publishes sparse flag identities so a suspended frame can retain conditional ownership. */
export const initializationFlagsOf = (
  fn: FunctionLowering,
): NonNullable<Mir.MirFunction['initializationFlags']> =>
  [...fn.initializationFlags].flatMap(([identity, flags]) => {
    const root = fn.initializationFlagRoots.get(identity)
    return root === undefined ? [] : [{ root, flags }]
  })

/** Resolves canonical field and variant identities through the actual specialized owner type. */
export const lowerOwnershipPath = (
  fn: FunctionLowering,
  root: Mir.LocalId,
  path: MovePath.Path,
  span: SourceSpan.SourceSpan,
): ReadonlyArray<Mir.PlaceSelector> | undefined => {
  const rootType = fn.localTypes.at(root.ordinal)
  if (rootType === undefined) return undefined
  let type: Type.Type = Mir.semanticType(rootType)
  let variantFields: ReadonlyArray<DeclarationFacts.FieldFact> | undefined
  const selectors: Array<Mir.PlaceSelector> = []
  for (const selector of path) {
    if (selector._tag === 'ConstantIndex') {
      if (!Type.isFixedArray(type)) return undefined
      selectors.push({
        _tag: 'ElementSelector',
        length: type.length,
        index: { _tag: 'Proven', value: selector.index },
        provenance: generated(span),
      })
      type = type.element
      continue
    }
    if (selector._tag === 'Variant' && Type.isUnion(type)) {
      const member = type.members.at(selector.ordinal)
      if (member === undefined) return undefined
      selectors.push({
        _tag: 'VariantSelector',
        ordinal: selector.ordinal,
        provenance: generated(span),
      })
      type = member
      continue
    }
    if (!Type.isNominal(type)) return undefined
    const declaration = DeclarationFacts.byCanonical(fn.index, {
      _tag: 'CanonicalDeclarationId',
      module: type.module,
      name: type.name,
    })
    if (declaration?._tag !== 'StructDeclaration' && declaration?._tag !== 'UnionDeclaration')
      return undefined
    if (selector._tag === 'Variant') {
      variantFields =
        declaration._tag === 'UnionDeclaration'
          ? declaration.variants.find((variant) => variant.id.ordinal === selector.ordinal)?.fields
          : undefined
      if (variantFields === undefined) return undefined
      selectors.push({
        _tag: 'VariantSelector',
        ordinal: selector.ordinal,
        provenance: generated(span),
      })
      continue
    }
    const fields =
      variantFields ?? (declaration._tag === 'StructDeclaration' ? declaration.fields : [])
    const field = fields.find((candidate) => candidate.id.ordinal === selector.ordinal)
    const substitution = TypeInference.substitution(
      declaration.typeParameters.map((parameter) => parameter.type),
      type.arguments,
    )
    if (field?.declaredType._tag !== 'Resolved' || substitution === undefined) return undefined
    selectors.push({ _tag: 'FieldSelector', field: field.id, provenance: generated(span) })
    type = Type.substitute(field.declaredType.type, substitution)
    variantFields = undefined
  }
  return selectors
}

export const indexExits = (plan: Ownership.FunctionOwnership | undefined): ExitIndex => {
  const returns = new Map<string, Ownership.ExitPlan>()
  const scopeEnds = new Map<string, Ownership.ExitPlan>()
  const armEnds = new Map<string, Ownership.ExitPlan>()
  const loopFallthroughs = new Map<number, Ownership.ExitPlan>()
  const transfers = new Map<string, Ownership.ExitPlan>()
  for (const exit of plan?.exits ?? []) {
    switch (exit.kind) {
      case 'Return':
        returns.set(spanKey(exit.span), exit)
        break
      case 'ScopeEnd':
        scopeEnds.set(spanKey(exit.span), exit)
        break
      case 'ArmEnd':
        armEnds.set(`${spanKey(exit.span)}:${exit.arm ?? 'Taken'}`, exit)
        break
      case 'LoopFallthrough':
        if (exit.target !== undefined) loopFallthroughs.set(exit.target.ordinal, exit)
        break
      case 'Break':
      case 'Continue':
        transfers.set(spanKey(exit.span), exit)
        break
    }
  }
  return { returns, scopeEnds, armEnds, loopFallthroughs, transfers }
}

export const specializedCleanup = (
  fn: FunctionLowering,
  cleanup: CleanupPlan.CleanupPlan,
): CleanupPlan.CleanupPlan =>
  CleanupPlan.specializeCleanup(cleanup, fn.substitution, (type) =>
    ConcreteCleanup.forType(fn, type),
  )

export const cleanupForLocal = (
  fn: FunctionLowering,
  cleanup: CleanupPlan.CleanupPlan,
  localType: Mir.Type,
): CleanupPlan.CleanupPlan => {
  const specialized = specializedCleanup(fn, cleanup)
  if (localType._tag === 'EffectValue') {
    return ConcreteCleanup.forEffect(fn, localType, new Set())
  }
  if (localType._tag === 'EffectComposite') {
    return {
      _tag: 'EffectCompositeCleanup',
      type: localType.type,
      alternatives: localType.alternatives.map((alternative) =>
        ConcreteCleanup.forEffect(fn, alternative, new Set()),
      ),
    }
  }
  if (localType._tag !== 'CallableValue') {
    return specialized
  }
  if (localType.storage === undefined) return ConcreteCleanup.forCallable(fn, localType)
  if (specialized._tag !== 'CallableCleanup') return specialized
  const fields = localType.environment?.fields ?? []
  return {
    _tag: 'CallableCleanup',
    type: localType.type,
    environment:
      localType.environment === undefined
        ? specialized.environment
        : {
            _tag: 'CallableEnvironmentIdentity',
            identity: Instances.callableEnvironmentIdentity(localType.environment.callable),
          },
    slots: specialized.slots.flatMap((slot) => {
      const field = fields.find((candidate) => candidate.ordinal === slot.ordinal)
      return field === undefined
        ? []
        : [
            {
              ordinal: slot.ordinal,
              cleanup: ConcreteCleanup.forType(fn, field.type),
            },
          ]
    }),
  }
}

/** Materializes hidden-owner cleanup at the final loan ending, including rewritten exits. */
export const loanEndOperations = (
  fn: FunctionLowering,
  ending: Mir.EndLoanOperation,
): ReadonlyArray<Mir.EndLoanOperation | Mir.DropOperation> => {
  const temporary = fn.temporaryBorrowOwners.get(borrowKey(ending.borrow))
  const localType = temporary === undefined ? undefined : fn.localTypes.at(temporary.local.ordinal)
  if (temporary === undefined || localType === undefined) return [ending]
  return [
    ending,
    {
      _tag: 'Drop',
      local: temporary.local,
      cleanup: cleanupForLocal(fn, temporary.cleanup, localType),
      provenance: generated(temporary.span),
    },
  ]
}

const sourceSpanKey = (span: SourceSpan.SourceSpan): string =>
  `${span.sourceId}:${span.start}:${span.end}`

interface ExitSpanIndex {
  /** The first exit temporary per exact source span, in exit order. */
  readonly temporaries: ReadonlyMap<string, Ownership.TemporaryRelease>
  /** The first propagation exit per span range. */
  readonly propagations: ReadonlyMap<string, Ownership.ExitPlan>
}

// Every run site resolved its propagation exit, and every cleanup drop its exit temporary, by
// scanning all exits of the function (part of the ~13 s propagationReleases spent in the
// selfhost lowering profile). Ownership facts are immutable, so each function indexes them once.
const exitSpanIndexes = new WeakMap<Ownership.FunctionOwnership, ExitSpanIndex>()

const exitSpanIndex = (ownership: Ownership.FunctionOwnership): ExitSpanIndex => {
  const existing = exitSpanIndexes.get(ownership)
  if (existing !== undefined) return existing
  const temporaries = new Map<string, Ownership.TemporaryRelease>()
  const propagations = new Map<string, Ownership.ExitPlan>()
  for (const exit of ownership.exits) {
    if (exit.kind === 'Propagation') {
      const key = spanKey(exit.span)
      if (!propagations.has(key)) propagations.set(key, exit)
    }
    for (const release of exit.temporaries) {
      const key = sourceSpanKey(release.span)
      if (!temporaries.has(key)) temporaries.set(key, release)
    }
  }
  const index = { temporaries, propagations }
  exitSpanIndexes.set(ownership, index)
  return index
}

/** Orders hidden storage immediately before its defining binding in acquisition order. */
export const orderedCleanup = (
  fn: FunctionLowering,
  operations: ReadonlyArray<Mir.EndLoanOperation | Mir.DropOperation>,
): ReadonlyArray<Mir.EndLoanOperation | Mir.DropOperation> => {
  const drops = operations.filter((operation) => operation._tag === 'Drop')
  // Each drop scanned every temporary owner and binding for its local. Owners do not change
  // while one cleanup is ordered, so the first owner per local is indexed once per call.
  let temporaries: Map<number, TemporaryBorrowOwner> | undefined
  let bindings: Map<number, Ownership.BindingFact> | undefined
  const acquisitions = drops.map((drop) => {
    if (temporaries === undefined) {
      temporaries = new Map()
      for (const owner of fn.temporaryBorrowOwners.values())
        if (!temporaries.has(owner.local.ordinal)) temporaries.set(owner.local.ordinal, owner)
    }
    const temporary = temporaries.get(drop.local.ordinal)
    let binding: Ownership.BindingFact | undefined
    if (temporary === undefined) {
      if (bindings === undefined) {
        bindings = new Map()
        for (const candidate of Ownership.allBindings(fn.ownership)) {
          const local_ = ownershipLocal(fn, candidate.site)
          if (local_ !== undefined && !bindings.has(local_.ordinal))
            bindings.set(local_.ordinal, candidate)
        }
      }
      binding = bindings.get(drop.local.ordinal)
    } else
      binding = Ownership.allBindings(fn.ownership).find(
        (candidate) =>
          candidate.liveFrom.sourceId === temporary.span.sourceId &&
          candidate.liveFrom.start <= temporary.span.start &&
          candidate.liveFrom.end >= temporary.span.end,
      )
    const release =
      fn.ownership === undefined
        ? undefined
        : exitSpanIndex(fn.ownership).temporaries.get(sourceSpanKey(drop.provenance.span))
    return { drop, ordinal: binding?.ordinal ?? release?.ordinal, temporary }
  })
  // Keep generated releases without a source acquisition in their established relative order.
  const ordered = acquisitions
    .filter((entry) => entry.ordinal !== undefined)
    .sort(
      (left, right) =>
        (right.ordinal ?? 0) - (left.ordinal ?? 0) ||
        Number(left.temporary !== undefined) - Number(right.temporary !== undefined) ||
        (right.temporary?.span.start ?? 0) - (left.temporary?.span.start ?? 0),
    )
  let next = 0
  return [
    ...operations.filter((operation) => operation._tag === 'EndLoan'),
    ...acquisitions.map((entry) =>
      entry.ordinal === undefined ? entry.drop : (ordered[next++]?.drop ?? entry.drop),
    ),
  ]
}

/**
 * The Drop operations a propagating failure must execute before it leaves this function:
 * every owner the ownership phase saw live at the run site, plus generated temporary
 * owners held by active loans. Sites without a local here belong to a different compiled
 * body and are skipped.
 */
export const propagationReleases = (
  fn: FunctionLowering,
  span: SourceSpan.SourceSpan,
): ReadonlyArray<Mir.DropOperation> => {
  const exit =
    fn.ownership === undefined
      ? undefined
      : exitSpanIndex(fn.ownership).propagations.get(spanKey(span))
  const releases = exit === undefined ? [] : [...exitDrops(fn, exit)]
  const retained = new Set(releases.map((release) => release.local.ordinal))
  // Only temporaries held by a live loan release here; with none held the scan is inert.
  const temporaries = fn.loanLocals.size === 0 ? [] : [...fn.temporaryBorrowOwners.entries()]
  for (const [key, temporary] of temporaries.reverse()) {
    if (!fn.loanLocals.has(key)) continue
    if (retained.has(temporary.local.ordinal)) continue
    const localType = fn.localTypes.at(temporary.local.ordinal)
    if (localType === undefined) continue
    releases.push({
      _tag: 'Drop',
      local: temporary.local,
      cleanup: cleanupForLocal(fn, temporary.cleanup, localType),
      provenance: generated(temporary.span),
    })
    retained.add(temporary.local.ordinal)
  }
  return orderedCleanup(fn, releases).flatMap((release) =>
    release._tag === 'Drop' && release.cleanup._tag !== 'NoCleanup' ? [release] : [],
  )
}

/**
 * The caller-owned loans live at a run site. A typed failure exits before the success-path
 * operations that normally end them, so the run carries an explicit failure-only cleanup path.
 */
export const dependencyOrderedLoanEndings = (
  fn: FunctionLowering,
  endings: ReadonlyArray<Mir.EndLoanOperation>,
): ReadonlyArray<Mir.EndLoanOperation> => {
  const depth = (key: string): number => {
    let current = fn.loanParents.get(key)
    const seen = new Set<string>([key])
    let result = 0
    while (current !== undefined && !seen.has(current)) {
      seen.add(current)
      result += 1
      current = fn.loanParents.get(current)
    }
    return result
  }
  return [...endings].sort((left, right) => {
    const leftKey = borrowKey(left.borrow)
    const rightKey = borrowKey(right.borrow)
    return depth(rightKey) - depth(leftKey) || leftKey.localeCompare(rightKey)
  })
}

export const propagationLoanEnds = (
  fn: FunctionLowering,
  span: SourceSpan.SourceSpan,
): ReadonlyArray<Mir.EndLoanOperation> =>
  dependencyOrderedLoanEndings(
    fn,
    [...fn.loanLocals.entries()].flatMap(([key, slice]): ReadonlyArray<Mir.EndLoanOperation> => {
      const borrow = fn.loanIds.get(key)
      return borrow === undefined
        ? []
        : [
            {
              _tag: 'EndLoan' as const,
              borrow,
              slice,
              provenance: generated(span),
            },
          ]
    }),
  )

export const emitReleases = (fn: FunctionLowering, exit: Ownership.ExitPlan | undefined): void => {
  const [, endings] = fn.capture(() => {
    for (const borrow of exit?.loanEnds ?? []) {
      const slice = fn.loanLocals.get(borrowKey(borrow))
      if (slice === undefined) continue
      const call = BodyView.node(fn.owner.view, borrow.call)
      if (call === undefined) throw new RangeError('loan refers to a node outside its body')
      fn.emit({
        _tag: 'EndLoan',
        borrow,
        slice,
        provenance: generated(exit?.span ?? call.span),
      })
      fn.loanLocals.delete(borrowKey(borrow))
    }
    if (exit?.kind === 'Return') {
      endLoans(
        fn,
        [...fn.loanLocals.keys()].flatMap((key) => {
          const borrow = fn.loanIds.get(key)
          return borrow === undefined ? [] : [borrow]
        }),
        exit.span,
      )
    }
    for (const release of exit?.releases ?? []) {
      if (release.binding.site._tag !== 'Let') continue
      const ordinal = release.binding.site.binding.ordinal
      endLoans(fn, fn.effectLoanEnds.get(ordinal) ?? [], exit?.span ?? release.binding.liveTo)
      fn.effectLoanEnds.delete(ordinal)
    }
  })
  const cleanup = endings.flatMap((operation) =>
    operation._tag === 'Drop' || operation._tag === 'EndLoan' ? [operation] : [],
  )
  fn.appendCaptured(orderedCleanup(fn, [...cleanup, ...exitDrops(fn, exit)]))
}

/** Resolves every live acquisition category through one reverse acquisition order. */
const exitDrops = (
  fn: FunctionLowering,
  exit: Ownership.ExitPlan | undefined,
): ReadonlyArray<Mir.DropOperation> => {
  const releases: Array<{
    readonly ordinal: number
    readonly local: Mir.LocalId
    readonly cleanup: CleanupPlan.CleanupPlan
    readonly span: SourceSpan.SourceSpan
    readonly initialization?: Mir.DropOperation['initialization']
  }> = []
  for (const release of exit?.releases ?? []) {
    const site = release.binding.site
    let local: Mir.LocalId | undefined
    if (site._tag === 'Parameter') local = fn.parameterLocals.get(site.parameter.ordinal)
    else if (site._tag === 'Temporary') local = undefined
    else if (site._tag === 'Pattern') local = fn.patternLocals.get(patternKey(site.binding))
    else local = fn.bindingLocals.get(site.binding.ordinal)
    if (local !== undefined)
      releases.push({
        ordinal: release.ordinal,
        local,
        cleanup: release.cleanup,
        span: release.binding.liveFrom,
        initialization: initializationFor(fn, release.binding.site, release.initialization),
      })
  }
  for (const selected of exit?.matches ?? []) {
    for (const release of selected.cleanup) {
      const local = fn.matchCleanupLocals.get(matchCleanupKey(selected.arm, release.path))
      const match = BodyView.node(fn.owner.view, selected.id.node)
      if (local !== undefined && match !== undefined)
        releases.push({
          ordinal: selected.ordinal,
          local,
          cleanup: release.cleanup,
          span: exit?.span ?? match.span,
        })
    }
  }
  for (const temporary of exit?.temporaries ?? []) {
    const local = fn.expressionLocals.get(spanKey(temporary.span))
    if (local !== undefined)
      releases.push({
        ordinal: temporary.ordinal,
        local,
        cleanup: temporary.cleanup,
        span: temporary.span,
      })
  }
  return releases
    .sort((left, right) => right.ordinal - left.ordinal)
    .flatMap((release): ReadonlyArray<Mir.DropOperation> => {
      const localType = fn.localTypes.at(release.local.ordinal)
      return localType === undefined
        ? []
        : [
            {
              _tag: 'Drop',
              local: release.local,
              cleanup: cleanupForLocal(fn, release.cleanup, localType),
              ...(release.initialization === undefined
                ? {}
                : { initialization: release.initialization }),
              provenance: generated(release.span),
            },
          ]
    })
}

export const matchCleanupKey = (
  arm: Match.ArmId,
  path: ReadonlyArray<DeclarationFacts.FieldId>,
): string =>
  `${Tir.nodeRefKey(arm.match.node)}:${arm.ordinal}:${path.map(DeclarationFacts.fieldIdKey).join('/')}`

export const effectContract = (type: Type.Type): Type.Effect | undefined => {
  const contract = Type.isRepresented(type) ? type.contract : type
  return Type.isEffect(contract) ? contract : undefined
}

export const ownerFields = (
  ownerLoop: Mir.LoopId | undefined,
): { readonly ownerLoop?: Mir.LoopId } => (ownerLoop === undefined ? {} : { ownerLoop })

export const generated = (span: SourceSpan.SourceSpan): Mir.Provenance => ({
  span,
  generated: true,
})

export const authored = (span: SourceSpan.SourceSpan): Mir.Provenance => ({
  span,
  generated: false,
})

/** Splits a projected place at stored references so each path addresses one allocation. */
export const lowerReferencePlace = (
  fn: FunctionLowering,
  initialRoot: Mir.LocalId,
  selectors: ReadonlyArray<Mir.PlaceSelector>,
  continuation?: Mir.Provenance,
):
  | { readonly root: Mir.LocalId; readonly selectors: ReadonlyArray<Mir.PlaceSelector> }
  | undefined => {
  const rootType = fn.localTypes.at(initialRoot.ordinal)
  if (rootType === undefined) return undefined
  let current = Mir.semanticType(rootType)
  if (Type.isReference(current)) current = current.target
  let root = initialRoot
  let remaining: Array<Mir.PlaceSelector> = []
  let variant:
    | Extract<Layout.Representation, { readonly _tag: 'NominalUnion' }>['variants'][number]
    | undefined
  const loadReferences = (provenance: Mir.Provenance): boolean => {
    while (Type.isReference(current)) {
      const type = fn.type(current)
      if (type === undefined) return false
      const destination = fn.alloc(type)
      fn.emit({
        _tag: 'ReadPlace',
        destination,
        root,
        selectors: remaining,
        type,
        provenance,
      })
      root = destination
      remaining = []
      current = current.target
    }
    return true
  }
  for (const selector of selectors) {
    if (!loadReferences(selector.provenance)) return undefined
    remaining.push(selector)
    const representation = Layout.entry(fn.layout, current)?.representation
    if (selector._tag === 'VariantSelector') {
      if (Type.isUnion(current)) {
        const member = current.members.at(selector.ordinal)
        if (member === undefined) return undefined
        current = member
      } else {
        variant =
          representation?._tag === 'NominalUnion'
            ? representation.variants.find((candidate) => candidate.ordinal === selector.ordinal)
            : undefined
        if (variant === undefined) return undefined
      }
    } else if (selector._tag === 'FieldSelector') {
      const field = (
        variant?.fields ?? (representation?._tag === 'Aggregate' ? representation.fields : [])
      ).find((candidate) => DeclarationFacts.sameFieldId(candidate.id, selector.field))
      if (field === undefined) return undefined
      current = field.type
      variant = undefined
    } else if (Type.isFixedArray(current) || Type.isSlice(current)) current = current.element
    else return undefined
  }
  if (continuation !== undefined && !loadReferences(continuation)) return undefined
  return { root, selectors: remaining }
}

/** Lowers an owned selector prefix and loads stored references before writing their referents. */
export const lowerBorrowedWritePlace = (
  fn: FunctionLowering,
  initialRoot: Mir.LocalId,
  declared: ReadonlyArray<Tir.BorrowedWriteSelector>,
  result: Type.Type,
  span: SourceSpan.SourceSpan,
):
  | { readonly root: Mir.LocalId; readonly selectors: ReadonlyArray<Mir.PlaceSelector> }
  | 'Transferred'
  | undefined => {
  let root = initialRoot
  let remaining: Array<Mir.PlaceSelector> = []
  let rootType = fn.localTypes.at(root.ordinal)
  while (
    rootType?._tag === 'Reference' &&
    Type.isReference(rootType.type.target) &&
    (declared.length > 0 || Type.runtimeKey(rootType.type.target) !== Type.runtimeKey(result))
  ) {
    const type = fn.type(rootType.type.target)
    if (type === undefined) return undefined
    const destination = fn.alloc(type)
    fn.emit({
      _tag: 'ReadPlace',
      destination,
      root,
      selectors: [],
      type,
      provenance: authored(span),
    })
    root = destination
    rootType = type
  }
  for (const [ordinal, selector] of declared.entries()) {
    // Resolve each selector before evaluating the next index, preserving source evaluation order.
    const lowered = lowerBorrowedWriteSelectors(fn, [selector])
    if (lowered === undefined || lowered === 'Transferred') return lowered
    remaining.push(...lowered)
    let current = selector.type
    while (
      Type.isReference(current) &&
      (ordinal < declared.length - 1 || Type.runtimeKey(current) !== Type.runtimeKey(result))
    ) {
      const type = fn.type(current)
      if (type === undefined) return undefined
      const destination = fn.alloc(type)
      fn.emit({
        _tag: 'ReadPlace',
        destination,
        root,
        selectors: remaining,
        type,
        provenance: authored(selector.span),
      })
      root = destination
      remaining = []
      current = current.target
      if (ordinal < declared.length - 1) break
    }
  }
  return { root, selectors: remaining }
}

export const lowerWriteSelectors = (
  fn: FunctionLowering,
  selectors: ReadonlyArray<Tir.WriteSelector>,
): ReadonlyArray<Mir.PlaceSelector> | 'Transferred' | undefined => {
  const lowered: Array<Mir.PlaceSelector> = []
  for (const selector of selectors) {
    if (selector._tag === 'Field') {
      lowered.push({
        _tag: 'FieldSelector',
        field: selector.field,
        provenance: authored(selector.span),
      })
      continue
    }
    const index =
      selector.bounds._tag === 'Proven'
        ? { _tag: 'Proven' as const, value: selector.bounds.index }
        : (() => {
            const expression = lowerExpression(fn, selector.index)
            if (expression === 'Transferred') return expression
            return expression === undefined
              ? undefined
              : { _tag: 'Runtime' as const, local: expression.result }
          })()
    if (index === 'Transferred') return index
    if (index === undefined) return undefined
    lowered.push({
      _tag: 'ElementSelector',
      length: selector.array.length,
      index,
      provenance: authored(selector.span),
    })
  }
  return lowered
}

/** Evaluates each borrow selector only after loading the preceding reference boundary. */
export const lowerBorrowPlace = (
  fn: FunctionLowering,
  initialRoot: Mir.LocalId,
  selectors: ReadonlyArray<Tir.BorrowSelector>,
  prefix: ReadonlyArray<Mir.PlaceSelector> = [],
):
  | { readonly root: Mir.LocalId; readonly selectors: ReadonlyArray<Mir.PlaceSelector> }
  | 'Transferred'
  | undefined => {
  let place = { root: initialRoot, selectors: prefix }
  for (const selector of selectors) {
    const preceding = lowerReferencePlace(fn, place.root, place.selectors, authored(selector.span))
    if (preceding === undefined) return undefined
    const selected = lowerBorrowSelector(fn, selector)
    if (selected === undefined || selected === 'Transferred') return selected
    place = { root: preceding.root, selectors: [...preceding.selectors, selected] }
  }
  return place
}

const lowerBorrowSelector = (
  fn: FunctionLowering,
  selector: Tir.BorrowSelector,
): Mir.PlaceSelector | 'Transferred' | undefined => {
  if (selector._tag === 'Field')
    return {
      _tag: 'FieldSelector',
      field: selector.field,
      provenance: authored(selector.span),
    }
  if (selector._tag === 'SliceIndex') {
    const index = lowerExpression(fn, selector.index)
    if (index === 'Transferred') return index
    return index === undefined
      ? undefined
      : {
          _tag: 'SliceElementSelector',
          index: index.result,
          access: selector.slice.access,
          provenance: authored(selector.span),
        }
  }
  const index =
    selector.bounds._tag === 'Proven'
      ? { _tag: 'Proven' as const, value: selector.bounds.index }
      : (() => {
          const expression = lowerExpression(fn, selector.index)
          if (expression === 'Transferred') return expression
          return expression === undefined
            ? undefined
            : { _tag: 'Runtime' as const, local: expression.result }
        })()
  if (index === undefined || index === 'Transferred') return index
  return {
    _tag: 'ElementSelector',
    length: selector.array.length,
    index,
    provenance: authored(selector.span),
  }
}

export const lowerBorrowedWriteSelectors = (
  fn: FunctionLowering,
  selectors: ReadonlyArray<Tir.BorrowedWriteSelector>,
): ReadonlyArray<Mir.PlaceSelector> | 'Transferred' | undefined => {
  const lowered: Array<Mir.PlaceSelector> = []
  for (const selector of selectors) {
    if (selector._tag === 'Field') {
      lowered.push({
        _tag: 'FieldSelector',
        field: selector.field,
        provenance: authored(selector.span),
      })
      continue
    }
    if (selector._tag === 'Index') {
      const index =
        selector.bounds._tag === 'Proven'
          ? { _tag: 'Proven' as const, value: selector.bounds.index }
          : (() => {
              const expression = lowerExpression(fn, selector.index)
              if (expression === 'Transferred') return expression
              return expression === undefined
                ? undefined
                : { _tag: 'Runtime' as const, local: expression.result }
            })()
      if (index === 'Transferred') return index
      if (index === undefined) return undefined
      lowered.push({
        _tag: 'ElementSelector',
        length: selector.array.length,
        index,
        provenance: authored(selector.span),
      })
      continue
    }
    const index = lowerExpression(fn, selector.index)
    if (index === 'Transferred') return index
    if (index === undefined) return undefined
    lowered.push({
      _tag: 'SliceElementSelector',
      index: index.result,
      access: selector.slice.access,
      provenance: authored(selector.span),
    })
  }
  return lowered
}

export const withoutLoanEndings = (
  operations: ReadonlyArray<Mir.Operation>,
  loans: ReadonlySet<string>,
  owners: ReadonlySet<number>,
): ReadonlyArray<Mir.Operation> =>
  operations.flatMap((operation): ReadonlyArray<Mir.Operation> => {
    if (operation._tag === 'EndLoan' && loans.has(borrowKey(operation.borrow))) return []
    if (operation._tag === 'Drop' && owners.has(operation.local.ordinal)) return []
    if (operation._tag === 'DiagnosticScope')
      return [
        {
          ...operation,
          body: Mir.mapExecutionOperations(operation.body, (operations) =>
            withoutLoanEndings(operations, loans, owners),
          ),
        },
      ]
    if (operation._tag === 'Conditional')
      return [
        {
          ...operation,
          taken: Mir.mapExecutionOperations(operation.taken, (operations) =>
            withoutLoanEndings(operations, loans, owners),
          ),
          otherwise: Mir.mapExecutionOperations(operation.otherwise, (operations) =>
            withoutLoanEndings(operations, loans, owners),
          ),
        },
      ]
    if (operation._tag === 'ShortCircuit')
      return [
        {
          ...operation,
          right: Mir.mapExecutionOperations(operation.right, (operations) =>
            withoutLoanEndings(operations, loans, owners),
          ),
        },
      ]
    if (operation._tag === 'Match')
      return [
        {
          ...operation,
          arms: operation.arms.map((arm) => ({
            ...arm,
            ...(arm.guard === undefined
              ? {}
              : {
                  guard: {
                    ...arm.guard,
                    execution: Mir.mapExecutionOperations(arm.guard.execution, (operations) =>
                      withoutLoanEndings(operations, loans, owners),
                    ),
                  },
                }),
            selected: {
              ...arm.selected,
              execution: Mir.mapExecutionOperations(arm.selected.execution, (operations) =>
                withoutLoanEndings(operations, loans, owners),
              ),
            },
          })),
        },
      ]
    return [operation]
  })

export interface DelayedLoopLoan {
  readonly key: string
  readonly borrow: Tir.BorrowId
  readonly slice: Mir.LocalId
}

export const delayedLoopLoans = (
  fn: FunctionLowering,
  keys: ReadonlySet<string>,
  entry: DelayedEffectState,
): ReadonlyArray<DelayedLoopLoan> => {
  return [...keys].flatMap((key): ReadonlyArray<DelayedLoopLoan> => {
    const borrow = fn.loanIds.get(key)
    const slice = entry.loanLocals.get(key)
    return borrow === undefined || slice === undefined ? [] : [{ key, borrow, slice }]
  })
}

export const terminalLoopLoanEndings = (
  fn: FunctionLowering,
  loans: ReadonlyArray<DelayedLoopLoan>,
  outcome: Extract<Mir.Outcome, { readonly _tag: 'Return' | 'Trap' }>,
): ReadonlyArray<Mir.EndLoanOperation | Mir.DropOperation> =>
  loans.flatMap((loan) => {
    const ending: Mir.EndLoanOperation = {
      _tag: 'EndLoan',
      borrow: loan.borrow,
      slice: loan.slice,
      provenance: generated(outcome.provenance.span),
    }
    return outcome._tag === 'Trap' ? [ending] : loanEndOperations(fn, ending)
  })

/** Adds loop-entry loans to failure exits after their authored success endings move past the loop. */
export const withDelayedFailureLoanEndings = (
  fn: FunctionLowering,
  operations: ReadonlyArray<Mir.Operation>,
  loans: ReadonlyArray<DelayedLoopLoan>,
): ReadonlyArray<Mir.Operation> =>
  operations.map((operation): Mir.Operation => {
    if (operation._tag === 'DiagnosticScope')
      return {
        ...operation,
        body: Mir.mapExecutionOperations(operation.body, (operations) =>
          withDelayedFailureLoanEndings(fn, operations, loans),
        ),
      }
    if (operation._tag === 'Conditional')
      return {
        ...operation,
        taken: Mir.mapExecutionOperations(operation.taken, (operations) =>
          withDelayedFailureLoanEndings(fn, operations, loans),
        ),
        otherwise: Mir.mapExecutionOperations(operation.otherwise, (operations) =>
          withDelayedFailureLoanEndings(fn, operations, loans),
        ),
      }
    if (operation._tag === 'ShortCircuit')
      return {
        ...operation,
        right: Mir.mapExecutionOperations(operation.right, (operations) =>
          withDelayedFailureLoanEndings(fn, operations, loans),
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
                    withDelayedFailureLoanEndings(fn, operations, loans),
                  ),
                },
              }),
          selected: {
            ...arm.selected,
            execution: Mir.mapExecutionOperations(arm.selected.execution, (operations) =>
              withDelayedFailureLoanEndings(fn, operations, loans),
            ),
          },
        })),
      }
    if (
      (operation._tag !== 'RunEffect' &&
        operation._tag !== 'RunEffectValue' &&
        operation._tag !== 'RunStaticEffect') ||
      Type.failureMembers(operation.outcomeType.type).length === 0
    )
      return operation
    const existing = new Set(
      (operation.failureLoanEnds ?? []).map((ending) => borrowKey(ending.borrow)),
    )
    const appended = loans.flatMap((loan): ReadonlyArray<Mir.EndLoanOperation> =>
      existing.has(loan.key)
        ? []
        : [
            {
              _tag: 'EndLoan' as const,
              borrow: loan.borrow,
              slice: loan.slice,
              provenance: generated(operation.provenance.span),
            },
          ],
    )
    const releases = [...(operation.releases ?? [])]
    const retained = new Set(releases.map((release) => release.local.ordinal))
    for (const loan of loans) {
      const ending: Mir.EndLoanOperation = {
        _tag: 'EndLoan',
        borrow: loan.borrow,
        slice: loan.slice,
        provenance: generated(operation.provenance.span),
      }
      for (const release of loanEndOperations(fn, ending)) {
        if (
          release._tag !== 'Drop' ||
          release.cleanup._tag === 'NoCleanup' ||
          retained.has(release.local.ordinal)
        )
          continue
        releases.push(release)
        retained.add(release.local.ordinal)
      }
    }
    return appended.length === 0 && releases.length === (operation.releases?.length ?? 0)
      ? operation
      : {
          ...operation,
          failureLoanEnds: dependencyOrderedLoanEndings(fn, [
            ...(operation.failureLoanEnds ?? []),
            ...appended,
          ]),
          releases: orderedCleanup(fn, releases).flatMap((operation) =>
            operation._tag === 'Drop' ? [operation] : [],
          ),
        }
  })
