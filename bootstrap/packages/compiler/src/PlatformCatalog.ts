import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import * as Target from './Target.js'

const versioned = Schema.Struct({ identity: Schema.String, version: Schema.String })
const scope = Schema.Struct({
  target: Schema.String,
  minimumDeployment: Schema.String,
  maximumDeployment: Schema.optionalKey(Schema.String),
})
const evidence = Schema.Struct({
  claim: Schema.Literals(['Constant', 'Layout', 'Signature', 'Symbol']),
  authority: Schema.String,
  reference: Schema.String,
  fixture: Schema.String,
  status: Schema.Literals(['Planned', 'Verified']),
  result: Schema.optionalKey(Schema.String),
})

/** Descriptive provenance; no field grants source availability or supplies a linker command. */
export const schema = Schema.Struct({
  identity: Schema.String,
  production: Schema.Literals(['HandAuthored', 'Generated', 'Mixed']),
  authorities: Schema.Array(versioned),
  headers: Schema.Array(versioned),
  scope: Schema.Array(scope),
  declarations: Schema.Array(
    Schema.Struct({
      identity: Schema.String,
      targets: Schema.Array(Schema.String),
      evidence: Schema.Array(evidence),
    }),
  ),
  fixtures: Schema.Array(
    Schema.Struct({
      identity: Schema.String,
      version: Schema.String,
      tools: Schema.Array(versioned),
    }),
  ),
  generationInputs: Schema.Array(versioned),
  review: Schema.Struct({
    identity: Schema.String,
    revision: Schema.String,
    updateProcedure: Schema.String,
    driftCheck: Schema.String,
  }),
})

export type PlatformCatalog = typeof schema.Type

/** A malformed or contradictory descriptive record, attributed to its offending field. */
export class PlatformCatalogError extends Data.TaggedError('PlatformCatalogError')<{
  readonly field: string
  readonly message: string
}> {}

const invalid = (field: string, message: string): PlatformCatalogError =>
  new PlatformCatalogError({ field, message })

const versionParts = (value: string): ReadonlyArray<number> | undefined =>
  /^\d+(?:\.\d+){0,3}$/.test(value) && value.split('.').map(Number).every(Number.isSafeInteger)
    ? value.split('.').map(Number)
    : undefined

const ordered = (minimum: ReadonlyArray<number>, maximum: ReadonlyArray<number>): boolean => {
  for (let index = 0; index < Math.max(minimum.length, maximum.length); index += 1) {
    const lower = minimum[index] ?? 0
    const upper = maximum[index] ?? 0
    if (lower !== upper) return lower < upper
  }
  return true
}

/** Validates provenance and claim consistency without resolving or executing any platform supply. */
export const decode = Effect.fn('PlatformCatalog.decode')(function* (
  input: unknown,
): Effect.fn.Return<PlatformCatalog, PlatformCatalogError> {
  const record = yield* Schema.decodeUnknownEffect(schema)(input, {
    onExcessProperty: 'error',
  }).pipe(Effect.mapError((error) => invalid('record', error.message)))
  const textFields = [
    ['identity', record.identity],
    ...Object.entries(record.review).map(([key, value]) => [`review.${key}`, value]),
  ]
  for (const [field, value] of textFields)
    if (value === undefined || value.trim().length === 0)
      return yield* invalid(field ?? 'record', 'Required provenance is empty')
  for (const [field, values] of [
    ['authorities', record.authorities],
    ['headers', record.headers],
    ['fixtures', record.fixtures],
    ['generationInputs', record.generationInputs],
  ] as const) {
    if (field !== 'generationInputs' && values.length === 0)
      return yield* invalid(field, 'At least one versioned provenance record is required')
    const seen = new Set<string>()
    for (const value of values) {
      if (
        value.identity.trim().length === 0 ||
        value.version.trim().length === 0 ||
        seen.has(value.identity)
      )
        return yield* invalid(field, 'Versioned identities must be nonempty and unique')
      seen.add(value.identity)
    }
  }
  if (record.production !== 'HandAuthored' && record.generationInputs.length === 0)
    return yield* invalid('generationInputs', 'Generated content requires pinned generation inputs')
  const targets = new Set<string>()
  if (record.scope.length === 0)
    return yield* invalid('scope', 'A logical target scope is required')
  for (const entry of record.scope) {
    const minimum = versionParts(entry.minimumDeployment)
    const maximum =
      entry.maximumDeployment === undefined ? undefined : versionParts(entry.maximumDeployment)
    if (
      !Target.all.some((target) => target.id === entry.target) ||
      targets.has(entry.target) ||
      minimum === undefined ||
      (entry.maximumDeployment !== undefined &&
        (maximum === undefined || !ordered(minimum, maximum)))
    )
      return yield* invalid(
        'scope',
        'Target scopes must be admitted, unique and have ordered deployment bounds',
      )
    targets.add(entry.target)
  }
  const fixtures = new Set(record.fixtures.map((fixture) => fixture.identity))
  const authorities = new Set(record.authorities.map((authority) => authority.identity))
  for (const fixture of record.fixtures) {
    if (
      fixture.tools.length === 0 ||
      fixture.tools.some((tool) => tool.identity.trim() === '' || tool.version.trim() === '') ||
      new Set(fixture.tools.map((tool) => tool.identity)).size !== fixture.tools.length
    )
      return yield* invalid(
        `fixtures.${fixture.identity}.tools`,
        'Unique pinned fixture tools are required',
      )
  }
  if (record.declarations.length === 0)
    return yield* invalid('declarations', 'An admitted subset is required')
  const declarations = new Set<string>()
  for (const declaration of record.declarations) {
    if (declaration.identity.trim() === '' || declarations.has(declaration.identity))
      return yield* invalid('declarations', 'Declaration identities must be nonempty and unique')
    declarations.add(declaration.identity)
    if (
      declaration.targets.length === 0 ||
      declaration.targets.some((target) => !targets.has(target)) ||
      new Set(declaration.targets).size !== declaration.targets.length
    )
      return yield* invalid(
        `declarations.${declaration.identity}.targets`,
        'Declaration scope must be contained in catalog scope',
      )
    if (declaration.evidence.length === 0)
      return yield* invalid(
        `declarations.${declaration.identity}.evidence`,
        'Admitted declarations require evidence',
      )
    const claims = new Set<string>()
    for (const claim of declaration.evidence) {
      if (
        !authorities.has(claim.authority) ||
        !fixtures.has(claim.fixture) ||
        claim.reference.trim() === '' ||
        claims.has(claim.claim) ||
        (claim.status === 'Verified'
          ? claim.result === undefined || claim.result.trim() === ''
          : claim.result !== undefined)
      )
        return yield* invalid(
          `declarations.${declaration.identity}.evidence`,
          'Evidence must name unique claims, known authority/fixture and an honest execution status',
        )
      claims.add(claim.claim)
    }
  }
  return record
})
