import type * as AuthoredHir from './AuthoredHir.js'
import * as AuthoredIdentity from './AuthoredIdentity.js'
import * as AuthoredLowering from './AuthoredLowering.js'
import * as CompilerTrace from './CompilerTrace.js'
import * as DeclarationFacts from './DeclarationFacts.js'
import type * as DeclarationIndex from './DeclarationIndex.js'
import * as Elaboration from './Elaboration.js'
import * as ModuleSurface from './ModuleSurface.js'
import * as NameResolution from './NameResolution.js'
import type * as Ownership from './Ownership.js'
import * as SourceSpan from './SourceSpan.js'
import * as Tir from './Tir.js'
import * as TirCodec from './TirCodec.js'
import * as ToolchainIntegrity from './ToolchainIntegrity.js'
import type * as SemanticContext from './SemanticContext.js'

/** Actual source-body query work, independent of module invalidation observations. */
export interface Counters {
  readonly _tag: 'BodyQueryCounters'
  readonly checked: number
  readonly reused: number
  /** Reused bodies whose source moved, so their positions were presented again. */
  readonly presented: number
  readonly ownershipChecked: number
  readonly ownershipReused: number
  readonly recursiveComponents: number
}

interface Entry {
  readonly declaration: DeclarationFacts.DeclarationFact
  /**
   * The authored declaration behind this body. Declaration facts are rebuilt every revision, so
   * only the authored node — which the closure shares whenever a module's source is unchanged —
   * can witness that a body's own input is untouched and its cached positions still hold.
   */
  readonly authoredDeclaration: AuthoredHir.Declaration
  readonly context: SemanticContext.SemanticContext
  readonly index: DeclarationIndex.Index
  /** The checked unit as this revision presents it. Working records are never stored. */
  readonly unit: Elaboration.CheckedUnit
  readonly presentationModules: ReadonlyArray<string>
  readonly calls: ReadonlyArray<string>
}

/** One revision's declaration cache, shared by module elaboration coordinators. */
export interface BodyQuery {
  readonly index: DeclarationIndex.Index
  readonly resolution: NameResolution.Resolution
  readonly currentModules: ReadonlyMap<string, AuthoredLowering.Lowered>
  readonly members: ReadonlyMap<string, DeclarationFacts.MemberFact>
  readonly owners: WeakMap<object, string>
  readonly previous: ReadonlyMap<string, Entry>
  readonly previousModules: ReadonlyMap<string, Elaboration.Result>
  /**
   * Whether each module of this revision shares its authored lowering with the previous revision.
   * A shared lowering is the only evidence that a module's declarations kept their authored
   * positions, because every declaration fact is rebuilt each revision. Resolved for the whole
   * closure up front, so a body may consult a module whose own bodies are not yet checked.
   */
  readonly sharedModules: ReadonlyMap<string, boolean>
  readonly entries: Map<string, Entry>
  readonly reuse: WeakMap<object, { readonly prior: Entry; readonly moved: boolean }>
  readonly parents: WeakMap<object, string>
  readonly work: {
    checked: number
    reused: number
    presented: number
    ownershipChecked: number
    ownershipReused: number
  }
}

const artifacts = new WeakMap<Elaboration.Result, ReadonlyArray<Entry>>()
const records = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isAuthoredAnchor = (value: unknown): value is AuthoredHir.Anchor =>
  records(value) &&
  value._tag === 'AuthoredAnchor' &&
  records(value.owner) &&
  value.owner._tag === 'AuthoredIdentity' &&
  typeof value.owner.namespace === 'string' &&
  typeof value.owner.module === 'string' &&
  Array.isArray(value.owner.path) &&
  Array.isArray(value.path)

/** Visits each object of an immutable graph once, stopping below objects the inspector declines. */
const visit = (value: unknown, inspect: (value: object) => boolean): void => {
  const visited = new WeakSet<object>()
  const walk = (input: unknown): void => {
    if (typeof input !== 'object' || input === null || visited.has(input)) return
    visited.add(input)
    if (!inspect(input)) return
    if (input instanceof Map) {
      for (const [key, child] of input) {
        walk(key)
        walk(child)
      }
    } else if (input instanceof Set || Array.isArray(input)) {
      for (const child of input) walk(child)
    } else if (records(input)) {
      for (const child of Object.values(input)) walk(child)
    }
  }
  walk(value)
}

const hiddenOrdinals = Tir.hiddenDeclarationOrdinal(0, 0)
const declarationKey = (sourceId: string, ordinal: number): string => `${sourceId}\u0000${ordinal}`

/**
 * Where each declaration of an earlier revision sits now.
 *
 * ponytail: a declaration id is its position in its module, so inserting a declaration renumbers
 * the ones after it, and a reused body must follow. Ids keyed by authored identity would make this
 * table, and the copy that applies it, unnecessary.
 */
const renumberings = new WeakMap<
  DeclarationIndex.Index,
  WeakMap<DeclarationIndex.Index, ReadonlyMap<string, number>>
>()
const renumberingOf = (
  previous: DeclarationIndex.Index,
  self: BodyQuery,
): ReadonlyMap<string, number> => {
  let known = renumberings.get(previous)
  if (known === undefined) {
    known = new WeakMap()
    renumberings.set(previous, known)
  }
  const cached = known.get(self.index)
  if (cached !== undefined) return cached
  const result = new Map<string, number>()
  for (const [key, before] of membersOf(previous)) {
    const after = self.members.get(key)
    if (after === undefined || !('id' in before) || !('id' in after)) continue
    if (before.id._tag !== 'DeclarationId' || after.id._tag !== 'DeclarationId') continue
    if (before.id.ordinal !== after.id.ordinal)
      result.set(declarationKey(before.id.sourceId, before.id.ordinal), after.id.ordinal)
  }
  known.set(self.index, result)
  return result
}

/** The same value naming every declaration by its current id. Positions are left alone. */
const renumber = <A>(value: A, moved: ReadonlyMap<string, number>): A => {
  if (moved.size === 0) return value
  const copies = new WeakMap<object, unknown>()
  const copy = (input: unknown): unknown => {
    if (typeof input !== 'object' || input === null || SourceSpan.isSourceSpan(input)) return input
    const known = copies.get(input)
    if (known !== undefined) return known
    if (input instanceof Map) {
      const result = new Map<unknown, unknown>()
      copies.set(input, result)
      for (const [key, child] of input) result.set(copy(key), copy(child))
      return result
    }
    if (input instanceof Set) {
      const result = new Set<unknown>()
      copies.set(input, result)
      for (const child of input) result.add(copy(child))
      return result
    }
    if (Array.isArray(input)) {
      const result: Array<unknown> = []
      copies.set(input, result)
      for (const child of input) result.push(copy(child))
      return result
    }
    if (!records(input)) return input
    if (
      input._tag === 'DeclarationId' &&
      typeof input.sourceId === 'string' &&
      typeof input.ordinal === 'number'
    ) {
      // A compiler-made body is numbered from the declaration that encloses it.
      const made = input.ordinal >= hiddenOrdinals
      const site = made ? (input.ordinal - hiddenOrdinals) % 65536 : 0
      const enclosing = made ? (input.ordinal - hiddenOrdinals - site) / 65536 : input.ordinal
      const current = moved.get(declarationKey(input.sourceId, enclosing))
      if (current === undefined) return input
      return {
        ...input,
        ordinal: made ? Tir.hiddenDeclarationOrdinal(current, site) : current,
      }
    }
    const result: Record<string, unknown> = {}
    copies.set(input, result)
    for (const key of Object.keys(input)) result[key] = copy(input[key])
    return result
  }
  return copy(value) as A
}

const memberKey = (value: DeclarationFacts.MemberFact): string =>
  'canonical' in value && value.canonical._tag === 'Canonical'
    ? `${value.canonical.id.module}/${value.canonical.id.name}`
    : `${value._tag}:${AuthoredIdentity.anchorKey(value.anchor)}`

/** Canonical query identity for one source body, independent of declaration ordinal. */
export const identity = (declaration: DeclarationFacts.DeclarationFact): string =>
  memberKey(declaration)

const semanticMemberFingerprint = (member: DeclarationFacts.MemberFact): ReadonlyArray<unknown> => {
  const key = memberKey(member)
  const nominal = new Set<string>()
  visit(member, (value) => {
    if (
      records(value) &&
      value._tag === 'NominalType' &&
      typeof value.module === 'string' &&
      typeof value.name === 'string'
    )
      nominal.add(`${value.module}/${value.name}`)
    return !(records(value) && (value._tag === 'SyntaxNode' || value._tag === 'Token'))
  })
  return [key, ModuleSurface.memberSignature(member), [...nominal].sort()]
}

/** The declaration's direct semantic header input consumed by one checked-unit query. */
const headerFingerprints = new WeakMap<DeclarationFacts.MemberFact, string>()

export const headerFingerprint = (
  _index: DeclarationIndex.Index,
  declaration: DeclarationFacts.MemberFact,
): string => {
  const cached = headerFingerprints.get(declaration)
  if (cached !== undefined) return cached
  const fingerprint = ToolchainIntegrity.contentDigest(
    JSON.stringify(semanticMemberFingerprint(declaration)),
  )
  headerFingerprints.set(declaration, fingerprint)
  return fingerprint
}

const memberCatalogs = new WeakMap<
  DeclarationIndex.Index,
  ReadonlyMap<string, DeclarationFacts.MemberFact>
>()
const membersOf = (
  index: DeclarationIndex.Index,
): ReadonlyMap<string, DeclarationFacts.MemberFact> => {
  const cached = memberCatalogs.get(index)
  if (cached !== undefined) return cached
  const result = new Map(
    index.modules.flatMap((module) =>
      [...module.members, ...module.declarations].map(
        (member) => [memberKey(member), member] as const,
      ),
    ),
  )
  memberCatalogs.set(index, result)
  return result
}

/** Creates a query context from the prior revision's completed module artifacts. */
export const make = (
  index: DeclarationIndex.Index,
  resolution: NameResolution.Resolution,
  previous: Iterable<Elaboration.Result> = [],
  current: Iterable<AuthoredLowering.Lowered> = [],
): BodyQuery => {
  const previousResults = [...previous]
  const currentLowerings = [...current]
  const previousLowerings = new Map(
    previousResults.map((result) => [result.authored.module.owner.module, result.authored]),
  )
  const members = membersOf(index)
  const currentModules = new Map(
    currentLowerings.map((lowered) => [lowered.module.owner.module, lowered] as const),
  )
  const owners = new WeakMap<object, string>()
  for (const [key, member] of members)
    visit(member, (value) => {
      if (records(value) && (value._tag === 'SyntaxNode' || value._tag === 'Token')) return false
      if (
        value === member ||
        (records(value) &&
          typeof value._tag === 'string' &&
          (value._tag.endsWith('Declaration') ||
            value._tag.endsWith('Id') ||
            value._tag === 'AggregateField' ||
            value._tag === 'UnionVariant'))
      )
        owners.set(value, key)
      return true
    })
  return {
    index,
    resolution,
    currentModules,
    members,
    owners,
    previous: new Map(
      previousResults.flatMap((result) =>
        (artifacts.get(result) ?? []).map(
          (entry) => [memberKey(entry.declaration), entry] as const,
        ),
      ),
    ),
    previousModules: new Map(
      previousResults.map((result) => [result.authored.module.owner.module, result]),
    ),
    sharedModules: new Map(
      currentLowerings.map((lowered) => {
        const module = lowered.module.owner.module
        return [module, previousLowerings.get(module) === lowered] as const
      }),
    ),
    entries: new Map(),
    reuse: new WeakMap(),
    parents: new WeakMap(),
    work: {
      checked: 0,
      reused: 0,
      presented: 0,
      ownershipChecked: 0,
      ownershipReused: 0,
    },
  }
}

/** The authored declaration behind one indexed declaration; the pipeline lowers every module. */
export const authoredDeclaration = (
  authored: AuthoredLowering.Lowered,
  declaration: DeclarationFacts.DeclarationFact,
) =>
  AuthoredLowering.declarationOf(authored, declaration.owner) ??
  (() => {
    throw new RangeError(`Authored module lost declaration ${memberKey(declaration)}`)
  })()

/** The canonical authored body up to lifetime alpha-renaming: the syntax-free implementation key. */
export const implementationFingerprint = (
  authored: AuthoredLowering.Lowered,
  declaration: DeclarationFacts.DeclarationFact,
): string =>
  ToolchainIntegrity.contentDigest(
    AuthoredLowering.canonicalBody(authored, authoredDeclaration(authored, declaration)),
  )

export const scopeFingerprint = (
  index: DeclarationIndex.Index,
  authored: AuthoredLowering.Lowered,
  declaration: DeclarationFacts.DeclarationFact,
  scope: NameResolution.ModuleScope,
): string => {
  const names = AuthoredLowering.bodyNames(authored, authoredDeclaration(authored, declaration))
  return ToolchainIntegrity.contentDigest(
    JSON.stringify(
      scope.bindings
        .filter((binding) => names.has(binding.spelling))
        .map((binding) => {
          if (binding._tag === 'ModuleNamespace')
            return [binding._tag, binding.spelling, binding.module]
          if (binding._tag !== 'LocalDeclaration' && binding._tag !== 'ImportedMember')
            return [binding._tag, binding.spelling]
          const member = DeclarationFacts.byCanonical(index, binding.declaration)
          return [
            binding._tag,
            binding.spelling,
            binding.declaration.module,
            binding.declaration.name,
            member === undefined ? 'missing' : headerFingerprint(index, member),
          ]
        }),
    ),
  )
}

const collectPresentationModules = (
  self: BodyQuery,
  authored: AuthoredLowering.Lowered,
  declaration: DeclarationFacts.DeclarationFact,
  scope: NameResolution.ModuleScope,
  visited: Set<string>,
  modules: Set<string>,
): void => {
  const body = memberKey(declaration)
  modules.add(declaration.owner.module)
  if (visited.has(body)) return
  visited.add(body)
  const names = AuthoredLowering.bodyNames(authored, authoredDeclaration(authored, declaration))
  for (const binding of scope.bindings) {
    if (
      !names.has(binding.spelling) ||
      (binding._tag !== 'LocalDeclaration' && binding._tag !== 'ImportedMember')
    )
      continue
    modules.add(binding.declaration.module)
    const member = DeclarationFacts.byCanonical(self.index, binding.declaration)
    if (member?._tag !== 'FunctionDeclaration' || member.bodyTemplate === undefined) continue
    const lowered = self.currentModules.get(member.owner.module)
    const nestedScope = NameResolution.scopeOf(self.resolution, member.owner.module)
    if (lowered !== undefined && nestedScope !== undefined)
      collectPresentationModules(self, lowered, member, nestedScope, visited, modules)
  }
}

/** Modules whose current source presentation can appear in this body's projected facts. */
export const presentationModules = (
  self: BodyQuery,
  authored: AuthoredLowering.Lowered,
  declaration: DeclarationFacts.DeclarationFact,
  scope: NameResolution.ModuleScope,
): ReadonlyArray<string> => {
  const modules = new Set<string>()
  collectPresentationModules(self, authored, declaration, scope, new Set(), modules)
  return [...modules].sort()
}

/** Position-independent result identity used for dependent-query cutoffs. */
export const fingerprint = (index: DeclarationIndex.Index, unit: Elaboration.CheckedUnit): string =>
  TirCodec.fingerprint(unit, index, (declaration) => headerFingerprint(index, declaration))

const callsOf = (self: BodyQuery, built: Built): ReadonlyArray<string> => {
  const calls = new Set<string>()
  visit(built.unit, (value) => {
    if (
      records(value) &&
      value._tag === 'Call' &&
      records(value.target) &&
      typeof value.target.module === 'string' &&
      typeof value.target.name === 'string'
    ) {
      calls.add(`${value.target.module}/${value.target.name}`)
    } else if (
      records(value) &&
      value._tag === 'CallableSection' &&
      records(value.reference) &&
      records(value.reference.declaration)
    ) {
      const key = self.owners.get(value.reference.declaration)
      if (key !== undefined) calls.add(key)
    }
    return (
      self.owners.get(value) === undefined &&
      !(records(value) && (value._tag === 'SyntaxNode' || value._tag === 'Token'))
    )
  })
  return [...calls].sort()
}

/** What construction hands back for one declaration. */
export interface Built {
  readonly unit: Elaboration.CheckedUnit
}

const present = (
  previous: Elaboration.CheckedUnit,
  moved: ReadonlyMap<string, number>,
  context: SemanticContext.SemanticContext,
  declaration: DeclarationFacts.DeclarationFact,
): Elaboration.CheckedUnit => ({
  diagnostics: renumber(previous.diagnostics, moved),
  bodies: previous.bodies.map((body) =>
    // A source body belongs to this revision's header object, which is never copied; a
    // compiler-made body owns its declaration, which is renumbered with the rest.
    Elaboration.presentBody(
      {
        artifact: body.artifact,
        declaration: body.hidden ? renumber(body.declaration, moved) : declaration,
        hidden: body.hidden,
        function: {
          ...renumber({ ...body.function, declaration: undefined }, moved),
          declaration,
        },
        results: renumber(body.results, moved),
      },
      context,
    ),
  ),
})

const record = (
  self: BodyQuery,
  context: SemanticContext.SemanticContext,
  authored: AuthoredLowering.Lowered,
  declaration: DeclarationFacts.DeclarationFact,
  unit: Elaboration.CheckedUnit,
  presentationModules: ReadonlyArray<string>,
  calls: ReadonlyArray<string>,
): Elaboration.CheckedUnit => {
  const key = memberKey(declaration)
  self.entries.set(key, {
    declaration,
    authoredDeclaration: authoredDeclaration(authored, declaration),
    context,
    index: self.index,
    unit,
    presentationModules,
    calls,
  })
  for (const body of unit.bodies) self.parents.set(body.results.lifetimes ?? body.results, key)
  return unit
}

/** Executes one body after the shared semantic query runtime selected the miss branch. */
export const check = (
  self: BodyQuery,
  context: SemanticContext.SemanticContext,
  authored: AuthoredLowering.Lowered,
  _scope: NameResolution.ModuleScope,
  declaration: DeclarationFacts.DeclarationFact,
  compute: () => Built,
  trace: CompilerTrace.CompilerTrace = CompilerTrace.none,
): Elaboration.CheckedUnit => {
  const key = memberKey(declaration)
  return trace(
    'Semantic.checkBody.execute',
    () => {
      self.work.checked += 1
      const built = compute()
      return record(
        self,
        context,
        authored,
        declaration,
        built.unit,
        presentationModules(self, authored, declaration, _scope),
        callsOf(self, built),
      )
    },
    { body: key },
  )
}

/** Presents a result admitted by the shared validator against this revision's declarations. */
export const reuse = (
  self: BodyQuery,
  context: SemanticContext.SemanticContext,
  authored: AuthoredLowering.Lowered,
  declaration: DeclarationFacts.DeclarationFact,
  admitted: Elaboration.CheckedUnit,
  trace: CompilerTrace.CompilerTrace = CompilerTrace.none,
): Elaboration.CheckedUnit => {
  const key = memberKey(declaration)
  const current = self.entries.get(key)
  if (current !== undefined) return current.unit
  const prior = self.previous.get(key)
  return trace(
    'Semantic.checkBody.reuse',
    () => {
      self.work.reused += 1
      if (prior === undefined) {
        return record(
          self,
          context,
          authored,
          declaration,
          admitted,
          [declaration.owner.module],
          [],
        )
      }
      const declared = authoredDeclaration(authored, declaration)
      const unchanged =
        prior.authoredDeclaration === declared &&
        prior.presentationModules.every((module) => self.sharedModules.get(module) === true)
      const unit = unchanged
        ? admitted
        : present(admitted, renumberingOf(prior.index, self), context, declaration)
      if (!unchanged) self.work.presented += 1
      for (const body of unit.bodies)
        self.reuse.set(body.results.lifetimes ?? body.results, { prior, moved: !unchanged })
      return record(
        self,
        context,
        authored,
        declaration,
        unit,
        prior.presentationModules,
        prior.calls,
      )
    },
    { body: key },
  )
}

const spanKey = (span: SourceSpan.SourceSpan): string => `${span.start}:${span.end}`

/** Where each position of a body moved, read off the same body presented in two revisions. */
const movesOf = (previous: Entry, current: Entry): ReadonlyMap<string, SourceSpan.SourceSpan> => {
  const moves = new Map<string, SourceSpan.SourceSpan>()
  const visited = new WeakSet<object>()
  const walk = (before: unknown, after: unknown): void => {
    if (typeof before !== 'object' || before === null || visited.has(before)) return
    if (typeof after !== 'object' || after === null) return
    visited.add(before)
    if (SourceSpan.isSourceSpan(before)) {
      if (SourceSpan.isSourceSpan(after)) moves.set(spanKey(before), after)
      return
    }
    if (isAuthoredAnchor(before) && isAuthoredAnchor(after)) {
      const beforeSpan = previous.context.spanOf(before)
      const afterSpan = current.context.spanOf(after)
      moves.set(spanKey(beforeSpan), afterSpan)
      return
    }
    if (before instanceof Map || before instanceof Set) return
    if (Array.isArray(before)) {
      if (Array.isArray(after)) for (const [at, item] of before.entries()) walk(item, after[at])
      return
    }
    if (!records(before) || !records(after)) return
    for (const key of Object.keys(before)) walk(before[key], after[key])
  }
  for (const [at, body] of previous.unit.bodies.entries()) {
    walk(body.declaration, current.unit.bodies[at]?.declaration)
    walk(body.function, current.unit.bodies[at]?.function)
    // Ownership also reports at the header: the declaration and each parameter it binds.
    for (const anchor of [
      body.declaration.anchor,
      ...body.declaration.parameters.map((parameter) => parameter.anchor),
    ])
      moves.set(spanKey(previous.context.spanOf(anchor)), current.context.spanOf(anchor))
  }
  return moves
}

/** A proof about a moved body, with each position carried along; absent when one is unknown. */
const moved = <A>(value: A, moves: ReadonlyMap<string, SourceSpan.SourceSpan>): A | undefined => {
  let complete = true
  const copies = new WeakMap<object, unknown>()
  const copy = (input: unknown): unknown => {
    if (typeof input !== 'object' || input === null) return input
    if (SourceSpan.isSourceSpan(input)) {
      let next = moves.get(spanKey(input))
      if (next === undefined) {
        let distance = Number.POSITIVE_INFINITY
        for (const [key, candidate] of moves) {
          if (candidate.sourceId !== input.sourceId) continue
          const separator = key.indexOf(':')
          const beforeStart = Number(key.slice(0, separator))
          const candidateDistance = Math.abs(input.start - beforeStart)
          if (candidateDistance >= distance) continue
          distance = candidateDistance
          const delta = candidate.start - beforeStart
          next = SourceSpan.fromOffsets(input.sourceId, input.start + delta, input.end + delta)
        }
      }
      if (next === undefined) {
        complete = false
      }
      return next ?? input
    }
    const known = copies.get(input)
    if (known !== undefined) return known
    if (input instanceof Map) {
      const result = new Map<unknown, unknown>()
      copies.set(input, result)
      for (const [key, child] of input) result.set(copy(key), copy(child))
      return result
    }
    if (input instanceof Set) {
      const result = new Set<unknown>()
      copies.set(input, result)
      for (const child of input) result.add(copy(child))
      return result
    }
    if (Array.isArray(input)) {
      const result: Array<unknown> = []
      copies.set(input, result)
      for (const child of input) result.push(copy(child))
      return result
    }
    if (!records(input)) return input
    const result: Record<string, unknown> = {}
    copies.set(input, result)
    for (const key of Object.keys(input)) result[key] = copy(input[key])
    return result
  }
  const result = copy(value) as A
  return complete ? result : undefined
}

/** Records or presents an ownership result admitted by the shared semantic query runtime. */
export const acceptOwnership = (
  self: BodyQuery,
  input: Ownership.CheckInput,
  admitted: Ownership.CheckedFunction,
  reused: boolean,
): Ownership.CheckedFunction | undefined => {
  const { lifetimes: proof } = input
  const key = memberKey(input.function.declaration)
  const parent = proof === undefined ? undefined : self.parents.get(proof)
  const current = self.entries.get(parent ?? key)
  const reuse = proof === undefined ? undefined : self.reuse.get(proof)
  const checked =
    !reused || reuse?.moved !== true || current === undefined
      ? admitted
      : moved(admitted, movesOf(reuse.prior, current))
  if (checked === undefined) return undefined
  if (reused) self.work.ownershipReused += 1
  else self.work.ownershipChecked += 1
  return checked
}

/** Complete checked-unit identity that owns a source or compiler-made ownership input. */
export const ownershipRootIdentity = (self: BodyQuery, input: Ownership.CheckInput): string => {
  const proof = input.lifetimes ?? input.function
  return self.parents.get(proof) ?? memberKey(input.function.declaration)
}

/** Attaches current query artifacts to their immutable elaboration boundary for the next revision. */
export const publish = (self: BodyQuery, result: Elaboration.Result): Elaboration.Result => {
  const previous = self.previousModules.get(result.authored.module.owner.module)
  const published =
    previous !== undefined &&
    previous.authored === result.authored &&
    previous.bodies.length === result.bodies.length &&
    result.bodies.every((body, ordinal) => body === previous.bodies[ordinal])
      ? previous
      : result
  artifacts.set(
    published,
    result.bodies.flatMap((body) => {
      const entry = body.hidden ? undefined : self.entries.get(memberKey(body.declaration))
      return entry === undefined ? [] : [entry]
    }),
  )
  return published
}

/** Returns deterministic counters recorded at actual query execution and reuse branches. */
export const counters = (self: BodyQuery): Counters => ({
  _tag: 'BodyQueryCounters',
  ...self.work,
  recursiveComponents: components(self).length,
})

/** Finds actual recursive components in the resolved source-call graph, excluding nominal edges. */
export const components = (self: BodyQuery): ReadonlyArray<ReadonlyArray<string>> => {
  const indices = new Map<string, number>()
  const low = new Map<string, number>()
  const stack: Array<string> = []
  const active = new Set<string>()
  const result: Array<ReadonlyArray<string>> = []
  const visit = (key: string): void => {
    const index = indices.size
    indices.set(key, index)
    low.set(key, index)
    stack.push(key)
    active.add(key)
    for (const dependency of self.entries.get(key)?.calls ?? []) {
      if (!self.entries.has(dependency)) continue
      if (!indices.has(dependency)) {
        visit(dependency)
        low.set(key, Math.min(low.get(key) ?? index, low.get(dependency) ?? index))
      } else if (active.has(dependency))
        low.set(key, Math.min(low.get(key) ?? index, indices.get(dependency) ?? index))
    }
    if (low.get(key) !== index) return
    const component: Array<string> = []
    let member = stack.pop()
    while (member !== undefined) {
      active.delete(member)
      component.push(member)
      if (member === key) break
      member = stack.pop()
    }
    if (component.length > 1 || self.entries.get(key)?.calls.includes(key))
      result.push(component.sort())
  }
  for (const key of [...self.entries.keys()].sort()) if (!indices.has(key)) visit(key)
  return result.sort((left, right) => (left[0] ?? '').localeCompare(right[0] ?? ''))
}
