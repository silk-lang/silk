import type * as AuthoredHir from './AuthoredHir.js'
import * as Diagnostic from './Diagnostic.js'
import * as Location from './Location.js'
import * as MachineFunction from './MachineFunction.js'
import type * as SemanticContext from './SemanticContext.js'
import type * as SourceSpan from './SourceSpan.js'
import * as Effect from 'effect/Effect'
import * as Result from 'effect/Result'
import type * as CompilationProfile from './CompilationProfile.js'
import * as ConfigurationError from './ConfigurationError.js'
import * as ConfigurationOrigin from './ConfigurationOrigin.js'
import * as Canonical from './internal/Canonical.js'

export type Kind =
  | 'library'
  | 'framework'
  | 'startup-object'
  | 'linker-script'
  | 'prebuilt-object'
  | 'prebuilt-archive'

/** Logical dependency constraints, independent of filesystem supply resolution. */
export interface Input {
  readonly kind: Kind
  readonly name: string
  readonly linkage?: 'static' | 'dynamic'
  readonly minimumDeployment?: string
  readonly maximumDeployment?: string
  readonly alternatives?: ReadonlyArray<string>
}

/** The attachment that activates one requirement in a selected artifact. */
export type Scope =
  | { readonly kind: 'artifact' }
  | { readonly kind: 'module'; readonly module: string }
  | { readonly kind: 'declaration'; readonly module: string; readonly declaration: string }

/** One normalized logical fact with current source/configuration provenance. */
export interface NativeRequirement extends Input {
  readonly scope: Scope
  readonly origin: ConfigurationOrigin.ConfigurationOrigin
}

/** The intersection of every active requirement for one logical kind/name. */
export interface Merged extends Input {
  readonly contributions: ReadonlyArray<NativeRequirement>
}

const kinds: ReadonlyArray<Kind> = [
  'library',
  'framework',
  'startup-object',
  'linker-script',
  'prebuilt-object',
  'prebuilt-archive',
]
const fields = ['kind', 'name', 'linkage', 'minimumDeployment', 'maximumDeployment', 'alternatives']

/** Admits logical names without path separators, option prefixes or parent traversal. */
export const isIdentity = (value: string): boolean =>
  /^[A-Za-z0-9_][A-Za-z0-9_.+-]*$/.test(value) && !value.includes('..')

const record = (input: unknown): input is Record<string, unknown> =>
  typeof input === 'object' && input !== null && !Array.isArray(input)

/** Canonicalizes a deployment bound without numeric precision loss. */
export const deployment = (input: string): string | undefined =>
  /^(0|[1-9][0-9]*)(\.(0|[1-9][0-9]*)){0,2}$/.test(input)
    ? [...input.split('.'), '0', '0'].slice(0, 3).join('.')
    : undefined

const compareDeployment = (left: string, right: string): number => {
  const rightParts = right.split('.')
  for (const [index, part] of left.split('.').entries()) {
    const a = BigInt(part)
    const b = BigInt(rightParts[index] ?? '0')
    if (a < b) return -1
    if (a > b) return 1
  }
  return 0
}

/** Decodes an attachment's exact literal/configuration fields. Scope is supplied by its owner. */
const inspect = (
  input: unknown,
  scope: Scope,
  origin: ConfigurationOrigin.ConfigurationOrigin,
): Result.Result<NativeRequirement, ConfigurationError.ConfigurationError> =>
  Result.gen(function* () {
    const invalid = (subject: string) =>
      ConfigurationError.make('NativeRequirement.decode', 'InvalidInput', subject, [origin])
    if (!ConfigurationOrigin.isPublic(origin))
      return yield* Result.fail(
        ConfigurationError.make(
          'NativeRequirement.decode',
          'ForbiddenProvenance',
          'native requirement',
          [origin],
        ),
      )
    if (!record(input) || Object.keys(input).some((key) => !fields.includes(key)))
      return yield* Result.fail(invalid('native requirement fields'))
    const kind = kinds.find((candidate) => candidate === input.kind)
    if (kind === undefined || typeof input.name !== 'string' || !isIdentity(input.name))
      return yield* Result.fail(invalid('native requirement identity'))
    const linkage = input.linkage
    if (
      linkage !== undefined &&
      (kind !== 'library' || (linkage !== 'static' && linkage !== 'dynamic'))
    )
      return yield* Result.fail(invalid('native requirement linkage'))
    const minimumDeployment =
      typeof input.minimumDeployment === 'string' ? deployment(input.minimumDeployment) : undefined
    const maximumDeployment =
      typeof input.maximumDeployment === 'string' ? deployment(input.maximumDeployment) : undefined
    if (
      (input.minimumDeployment !== undefined && minimumDeployment === undefined) ||
      (input.maximumDeployment !== undefined && maximumDeployment === undefined)
    )
      return yield* Result.fail(invalid('native requirement deployment'))
    if (
      minimumDeployment !== undefined &&
      maximumDeployment !== undefined &&
      compareDeployment(minimumDeployment, maximumDeployment) > 0
    )
      return yield* Result.fail(invalid('native requirement deployment interval'))
    let alternatives: ReadonlyArray<string> | undefined
    if (input.alternatives !== undefined) {
      if (!Array.isArray(input.alternatives) || input.alternatives.length === 0)
        return yield* Result.fail(invalid('native requirement alternatives'))
      const names: Array<string> = []
      for (const name of input.alternatives) {
        if (typeof name !== 'string' || !isIdentity(name))
          return yield* Result.fail(invalid('native requirement alternatives'))
        names.push(name)
      }
      alternatives = [...new Set(names)].sort(Canonical.compare)
    }
    return {
      kind,
      name: input.name,
      ...(linkage === undefined ? {} : { linkage }),
      ...(minimumDeployment === undefined ? {} : { minimumDeployment }),
      ...(maximumDeployment === undefined ? {} : { maximumDeployment }),
      ...(alternatives === undefined ? {} : { alternatives }),
      scope: { ...scope },
      origin: ConfigurationOrigin.snapshot(origin),
    }
  })

/** Decodes a logical native requirement at a public Effect boundary. */
export const decode = Effect.fn('NativeRequirement.decode')(function* (
  input: unknown,
  scope: Scope,
  origin: ConfigurationOrigin.ConfigurationOrigin,
): Effect.fn.Return<NativeRequirement, ConfigurationError.ConfigurationError> {
  const result = inspect(input, scope, origin)
  if (Result.isFailure(result)) return yield* result.failure
  return result.success
})

/** Encodes the logical grouping identity without incidental attachment provenance. */
export const key = (self: Input): string => Canonical.record(self.kind, [self.name])

/** Encodes one set of normalized hard constraints independently of source location. */
export const encode = (self: Input): string =>
  Canonical.record('NativeRequirement.v1', [
    key(self),
    self.linkage ?? '',
    self.minimumDeployment ?? '',
    self.maximumDeployment ?? '',
    Canonical.record(
      'alternatives',
      self.alternatives === undefined ? [] : [Canonical.array(self.alternatives)],
    ),
  ])

/** Encodes activation ownership independently of diagnostic location. */
export const scopeKey = (self: Scope): string => {
  if (self.kind === 'artifact') return Canonical.record(self.kind)
  return Canonical.record(
    self.kind,
    self.kind === 'module' ? [self.module] : [self.module, self.declaration],
  )
}

const contributionKey = (self: NativeRequirement): string =>
  Canonical.record('contribution', [
    scopeKey(self.scope),
    encode(self),
    self.origin.source,
    String(self.origin.span?.start ?? -1),
    String(self.origin.span?.end ?? -1),
  ])

/** Intersects all active facts, reporting every contributor to every contradictory group. */
export const merge = Effect.fn('NativeRequirement.merge')(function* (
  requirements: ReadonlyArray<NativeRequirement>,
  profile: CompilationProfile.Facts,
): Effect.fn.Return<ReadonlyArray<Merged>, ConfigurationError.ConfigurationError> {
  const groups = new Map<string, Array<NativeRequirement>>()
  for (const requirement of requirements) {
    const identity = key(requirement)
    const group = groups.get(identity)
    if (group === undefined) groups.set(identity, [requirement])
    else group.push(requirement)
  }
  const merged: Array<Merged> = []
  const conflicts: Array<NativeRequirement> = []
  const conflictKeys: Array<string> = []
  for (const [identity, entries] of [...groups].sort(([left], [right]) =>
    Canonical.compare(left, right),
  )) {
    const first = entries[0]
    if (first === undefined) continue
    const unique = new Map(entries.map((entry) => [contributionKey(entry), entry]))
    const contributions = [...unique]
      .sort(([left], [right]) => Canonical.compare(left, right))
      .map(([, entry]) => entry)
    const linkages = new Set(
      entries.flatMap((entry) => (entry.linkage === undefined ? [] : [entry.linkage])),
    )
    const minima = entries
      .flatMap((entry) => (entry.minimumDeployment === undefined ? [] : [entry.minimumDeployment]))
      .sort(compareDeployment)
    const maxima = entries
      .flatMap((entry) => (entry.maximumDeployment === undefined ? [] : [entry.maximumDeployment]))
      .sort(compareDeployment)
    const minimumDeployment = minima.at(-1)
    const maximumDeployment = maxima[0]
    let alternatives: ReadonlyArray<string> | undefined
    for (const entry of entries) {
      if (entry.alternatives === undefined) continue
      alternatives =
        alternatives === undefined
          ? entry.alternatives
          : alternatives.filter((name) => entry.alternatives?.includes(name))
    }
    const incompatible =
      linkages.size > 1 ||
      alternatives?.length === 0 ||
      (minimumDeployment !== undefined &&
        maximumDeployment !== undefined &&
        compareDeployment(minimumDeployment, maximumDeployment) > 0) ||
      (minimumDeployment !== undefined &&
        profile.deployment !== undefined &&
        compareDeployment(profile.deployment, minimumDeployment) < 0) ||
      (maximumDeployment !== undefined &&
        profile.deployment !== undefined &&
        compareDeployment(profile.deployment, maximumDeployment) > 0) ||
      (first.kind === 'framework' && profile.target.operatingSystem !== 'darwin') ||
      profile.target.kind !== 'Native'
    if (incompatible) {
      conflicts.push(...contributions)
      conflictKeys.push(identity)
      continue
    }
    const linkage = [...linkages][0]
    merged.push({
      kind: first.kind,
      name: first.name,
      ...(linkage === undefined ? {} : { linkage }),
      ...(minimumDeployment === undefined ? {} : { minimumDeployment }),
      ...(maximumDeployment === undefined ? {} : { maximumDeployment }),
      ...(alternatives === undefined ? {} : { alternatives: [...alternatives] }),
      contributions,
    })
  }
  if (conflicts.length > 0)
    return yield* ConfigurationError.make(
      'NativeRequirement.merge',
      'ConflictingBindings',
      'native requirements',
      conflicts.map((entry) => entry.origin),
      conflictKeys,
    )
  return merged
})

/** The exact text one authored literal denotes; computed operands carry no configuration text. */
const literalText = (
  context: SemanticContext.SemanticContext,
  value: AuthoredHir.Expression,
): string | undefined => (value._tag === 'TextLiteral' ? context.textOf(value.value) : undefined)

/** Validates an active source attachment without executing its expressions. */
export const analyze = (
  context: SemanticContext.SemanticContext,
  clause: AuthoredHir.PropertyClause,
  scope: Scope,
): {
  readonly requirement?: NativeRequirement
  readonly diagnostics: ReadonlyArray<Diagnostic.Located>
} => {
  const diagnostics: Array<Diagnostic.Located> = []
  const clauseSpan = context.spanOf(clause.anchor)
  const at = (span: SourceSpan.SourceSpan): ConfigurationOrigin.ConfigurationOrigin => ({
    source: clauseSpan.sourceId,
    provenance: 'literal',
    span,
  })
  const reject = (subject: string, anchor: AuthoredHir.Anchor): void => {
    const span = context.spanOf(anchor)
    diagnostics.push(
      Diagnostic.invalidAuthoredConfiguration(
        ConfigurationError.make('NativeRequirement.analyze', 'InvalidInput', subject, [at(span)]),
        Location.at(anchor),
      ),
    )
  }
  if (MachineFunction.clauseOwner(context, clause) !== 'Intrinsic.native')
    reject('expected Intrinsic.native', clause.anchor)
  const properties = new Map<string, unknown>()
  for (const property of clause.properties) {
    const name = property.name._tag === 'Name' ? context.textOf(property.name.text) : undefined
    if (name === undefined) continue
    if (properties.has(name)) reject('duplicate native requirement property', property.name.anchor)
    if (!fields.includes(name)) reject('unknown native requirement property', property.name.anchor)
    if (name === 'alternatives') {
      if (property.value._tag !== 'TupleExpression') {
        reject('native requirement alternatives require a nonempty tuple', property.value.anchor)
        continue
      }
      const alternatives: Array<string> = []
      for (const element of property.value.elements) {
        const text = literalText(context, element)
        if (text === undefined)
          reject('native requirement alternative requires text', element.anchor)
        else alternatives.push(text)
      }
      properties.set(name, alternatives)
    } else {
      const text = literalText(context, property.value)
      if (text === undefined)
        reject('native requirement property requires text', property.value.anchor)
      properties.set(name, text)
    }
  }
  if (diagnostics.length > 0) return { diagnostics: diagnostics }
  const result = inspect(Object.fromEntries(properties), scope, at(clauseSpan))
  if (Result.isFailure(result))
    return {
      diagnostics: [
        Diagnostic.invalidAuthoredConfiguration(result.failure, Location.at(clause.anchor)),
      ],
    }
  return { requirement: result.success, diagnostics: [] }
}
