import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import type * as DeclarationFacts from './DeclarationFacts.js'
import type * as DeclarationIndex from './DeclarationIndex.js'
import type * as Elaboration from './Elaboration.js'
import type * as NameResolution from './NameResolution.js'
import * as Semantic from './Semantic.js'
import * as SemanticQuery from './SemanticQuery.js'
import * as Storage from './Storage.js'
import * as TirCodec from './TirCodec.js'
import * as ToolchainIntegrity from './ToolchainIntegrity.js'

export const schema = 2
export const addressSchema = 2
const namespace = 'semantic-checked-units-v2'
const utf8 = new TextEncoder()

export interface Config {
  readonly storage: Storage.Service
  readonly compilerIdentity: string
  readonly maximumRecordBytes: number
  readonly codecLimits?: TirCodec.Limits
}

export interface Counters {
  readonly _tag: 'SemanticPersistenceCounters'
  readonly lookups: number
  readonly loaded: number
  readonly missing: number
  readonly rejected: number
  readonly readFailures: number
  readonly published: number
  readonly publicationFailures: number
}

interface MutableCounters {
  lookups: number
  loaded: number
  missing: number
  rejected: number
  readFailures: number
  published: number
  publicationFailures: number
}

export interface Persistence {
  readonly _tag: 'SemanticPersistence'
  readonly config: Config
}

interface Payload {
  readonly schema: number
  readonly addressSchema: number
  readonly compilerIdentity: string
  readonly descriptor: SemanticQuery.Descriptor
  readonly key: string
  readonly fingerprint: string
  readonly observations: ReadonlyArray<SemanticQuery.Observation>
}

/**
 * Optional checked-unit persistence. The frontend resolves it from its environment; a compile
 * without it checks every body. Provide it at the application edge with {@link layer}.
 */
export class SemanticPersistence extends Context.Service<SemanticPersistence, Persistence>()(
  '@silklang/compiler/SemanticPersistence',
) {}

const states = new WeakMap<Persistence, MutableCounters>()
// Records already backed by storage: loaded ones, and ones this process published.
const backed = new WeakSet<SemanticQuery.Completed<unknown>>()
const newline = 0x0a
const record = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const exact = (
  value: Readonly<Record<string, unknown>>,
  fields: ReadonlyArray<string>,
): boolean => {
  const actual = Object.keys(value).sort()
  const expected = [...fields].sort()
  return (
    actual.length === expected.length && actual.every((field, index) => field === expected[index])
  )
}

const digest = ToolchainIntegrity.contentDigest
// A declaration checks differently under profiles that select different headers. One slot per
// (variant, declaration) lets compiles under different profiles share a store without evicting
// each other; validity is still decided by the record's observations, never by the address.
const storageAddress = (
  variant: string,
  descriptor: SemanticQuery.Descriptor,
): Storage.Address => ({
  _tag: 'StorageAddress',
  namespace,
  key: `${digest(`${variant.length}:${variant}${descriptor.address}`)}.json`,
})

const descriptor = (value: unknown): SemanticQuery.Descriptor | undefined => {
  if (!record(value) || !exact(value, ['_tag', 'family', 'schema', 'address', 'reuse']))
    return undefined
  return value['_tag'] === 'SemanticQueryDescriptor' &&
    typeof value['family'] === 'string' &&
    Number.isSafeInteger(value['schema']) &&
    typeof value['address'] === 'string' &&
    (value['reuse'] === 'Revision' || value['reuse'] === 'Session')
    ? (value as unknown as SemanticQuery.Descriptor)
    : undefined
}

const inputAddress = (value: unknown): SemanticQuery.InputAddress | undefined => {
  if (!record(value) || !exact(value, ['_tag', 'family', 'schema', 'address'])) return undefined
  return value['_tag'] === 'SemanticInputAddress' &&
    typeof value['family'] === 'string' &&
    Number.isSafeInteger(value['schema']) &&
    typeof value['address'] === 'string'
    ? (value as unknown as SemanticQuery.InputAddress)
    : undefined
}

const observation = (value: unknown): SemanticQuery.Observation | undefined => {
  if (!record(value) || typeof value['fingerprint'] !== 'string') return undefined
  if (value['_tag'] === 'QueryRead' && exact(value, ['_tag', 'descriptor', 'fingerprint'])) {
    const observed = descriptor(value['descriptor'])
    return observed === undefined
      ? undefined
      : {
          _tag: 'QueryRead',
          descriptor: observed,
          fingerprint: value['fingerprint'],
        }
  }
  if (value['_tag'] === 'InputRead' && exact(value, ['_tag', 'input', 'fingerprint'])) {
    const observed = inputAddress(value['input'])
    return observed === undefined
      ? undefined
      : { _tag: 'InputRead', input: observed, fingerprint: value['fingerprint'] }
  }
  return undefined
}

const sameDescriptor = (left: SemanticQuery.Descriptor, right: SemanticQuery.Descriptor): boolean =>
  left._tag === right._tag &&
  left.family === right.family &&
  left.schema === right.schema &&
  left.address === right.address &&
  left.reuse === right.reuse

// Envelope: `<digest>\n<header JSON>\n<TirCodec bytes>`; the digest covers everything after it, so
// the unit is hashed once as bytes and never re-parsed or re-stringified here.
const encodeEnvelope = (
  self: Persistence,
  completed: SemanticQuery.Completed<Elaboration.CheckedUnit>,
  index: DeclarationIndex.Index,
): Uint8Array => {
  const unit = TirCodec.encode(
    completed.answer,
    index,
    self.config.codecLimits ?? TirCodec.defaultLimits,
  )
  const payload: Payload = {
    schema,
    addressSchema,
    compilerIdentity: self.config.compilerIdentity,
    descriptor: completed.descriptor,
    key: completed.key,
    fingerprint: completed.fingerprint,
    observations: completed.observations,
  }
  const header = utf8.encode(JSON.stringify(payload))
  const body = new Uint8Array(header.length + 1 + unit.length)
  body.set(header)
  body[header.length] = newline
  body.set(unit, header.length + 1)
  const prefix = utf8.encode(`${digest(body)}\n`)
  const bytes = new Uint8Array(prefix.length + body.length)
  bytes.set(prefix)
  bytes.set(body, prefix.length)
  return bytes
}

const decodeEnvelope = (
  self: Persistence,
  bytes: Uint8Array,
  expected: SemanticQuery.Descriptor,
  index: DeclarationIndex.Index,
  declaration: DeclarationFacts.DeclarationFact,
  resolution: NameResolution.Resolution,
): SemanticQuery.Completed<Elaboration.CheckedUnit> | undefined => {
  const digestEnd = bytes.indexOf(newline)
  const headerEnd = bytes.indexOf(newline, digestEnd + 1)
  if (digestEnd < 0 || headerEnd < 0) return undefined
  let raw: unknown
  let expectedDigest: string
  try {
    const text = new TextDecoder('utf-8', { fatal: true })
    expectedDigest = text.decode(bytes.subarray(0, digestEnd))
    raw = JSON.parse(text.decode(bytes.subarray(digestEnd + 1, headerEnd))) as unknown
  } catch {
    return undefined
  }
  if (
    !record(raw) ||
    !exact(raw, [
      'schema',
      'addressSchema',
      'compilerIdentity',
      'descriptor',
      'key',
      'fingerprint',
      'observations',
    ]) ||
    raw['schema'] !== schema ||
    raw['addressSchema'] !== addressSchema ||
    raw['compilerIdentity'] !== self.config.compilerIdentity ||
    typeof raw['key'] !== 'string' ||
    typeof raw['fingerprint'] !== 'string' ||
    !Array.isArray(raw['observations']) ||
    expectedDigest !== digest(bytes.subarray(digestEnd + 1))
  )
    return undefined
  const decodedDescriptor = descriptor(raw['descriptor'])
  if (
    decodedDescriptor === undefined ||
    decodedDescriptor.family !== 'CheckBody' ||
    decodedDescriptor.reuse !== 'Revision' ||
    !sameDescriptor(decodedDescriptor, expected) ||
    raw['key'] !== SemanticQuery.keyOf(expected)
  )
    return undefined
  const observations: Array<SemanticQuery.Observation> = []
  for (const rawObservation of raw['observations']) {
    const decoded = observation(rawObservation)
    if (decoded === undefined) return undefined
    observations.push(decoded)
  }
  const context = resolution.contexts.contexts.get(declaration.owner.module)
  if (context === undefined) return undefined
  try {
    const unit = TirCodec.decode(
      bytes.subarray(headerEnd + 1),
      index,
      declaration,
      context,
      self.config.codecLimits ?? TirCodec.defaultLimits,
    )
    return {
      descriptor: decodedDescriptor,
      key: raw['key'],
      answer: unit,
      fingerprint: raw['fingerprint'],
      observations: observations,
    }
  } catch (error) {
    if (error instanceof TirCodec.CodecError) return undefined
    throw error
  }
}

const mutable = (self: Persistence): MutableCounters => {
  const value = states.get(self)
  if (value === undefined) throw new RangeError('Unknown semantic persistence service')
  return value
}

export const make = (config: Config): Persistence => {
  const self = { _tag: 'SemanticPersistence' as const, config }
  states.set(self, {
    lookups: 0,
    loaded: 0,
    missing: 0,
    rejected: 0,
    readFailures: 0,
    published: 0,
    publicationFailures: 0,
  })
  return self
}

/** Persistence over whichever byte Storage the environment provides. */
export const layer = (
  config: Omit<Config, 'storage'>,
): Layer.Layer<SemanticPersistence, never, Storage.Storage> =>
  Layer.effect(
    SemanticPersistence,
    Effect.gen(function* () {
      return make({ ...config, storage: yield* Storage.Storage })
    }),
  )

export const counters = (self: Persistence): Counters => ({
  _tag: 'SemanticPersistenceCounters',
  ...mutable(self),
})

const recoverRead = (
  self: Persistence,
  error: Storage.StorageError,
): Effect.Effect<Option.Option<Uint8Array>, Storage.StorageError> => {
  if (error.reason._tag === 'InvalidAddress' || error.reason._tag === 'InvalidLimit')
    return Effect.fail(error)
  const state = mutable(self)
  if (error.reason._tag === 'ReadFailure') state.readFailures += 1
  else state.rejected += 1
  return Effect.succeedNone
}

/** Loads exact CheckBody candidates after current headers and resolution have been rebuilt. */
export const load = Effect.fn('SemanticPersistence.load')(function* (
  self: Persistence,
  variant: string,
  index: DeclarationIndex.Index,
  resolution: NameResolution.Resolution,
  previous?: SemanticQuery.Snapshot,
): Effect.fn.Return<SemanticQuery.Snapshot, Storage.StorageError> {
  const records = new Map(previous?.records ?? [])
  const state = mutable(self)
  for (const module of index.modules) {
    for (const declaration of module.declarations) {
      const expected = Semantic.checkBodyDescriptor(declaration)
      const key = SemanticQuery.keyOf(expected)
      if (records.has(key)) continue
      state.lookups += 1
      const failuresBefore = state.readFailures + state.rejected
      const stored = yield* self.config.storage
        .read(storageAddress(variant, expected), self.config.maximumRecordBytes)
        .pipe(Effect.catchTag('StorageError', (error) => recoverRead(self, error)))
      if (Option.isNone(stored)) {
        if (state.readFailures + state.rejected === failuresBefore) state.missing += 1
        continue
      }
      const completed = decodeEnvelope(self, stored.value, expected, index, declaration, resolution)
      if (completed === undefined) {
        state.rejected += 1
        continue
      }
      state.loaded += 1
      backed.add(completed)
      records.set(key, completed)
    }
  }
  return { _tag: 'SemanticQuerySnapshot', records }
})

const recoverPublish = (
  self: Persistence,
  error: Storage.StorageError,
): Effect.Effect<boolean, Storage.StorageError> => {
  if (error.reason._tag === 'InvalidAddress' || error.reason._tag === 'InvalidLimit')
    return Effect.fail(error)
  mutable(self).publicationFailures += 1
  return Effect.succeed(false)
}

const encodeCandidate = (
  self: Persistence,
  completed: SemanticQuery.Completed<unknown>,
  index: DeclarationIndex.Index,
): Uint8Array | undefined => {
  try {
    return encodeEnvelope(
      self,
      completed as SemanticQuery.Completed<Elaboration.CheckedUnit>,
      index,
    )
  } catch (error) {
    if (error instanceof TirCodec.CodecError) {
      mutable(self).publicationFailures += 1
      return undefined
    }
    throw error
  }
}

/** Publishes only complete revision-reusable CheckBody records after execution has frozen them. */
export const publish = Effect.fn('SemanticPersistence.publish')(function* (
  self: Persistence,
  variant: string,
  snapshot: SemanticQuery.Snapshot,
  index: DeclarationIndex.Index,
): Effect.fn.Return<void, Storage.StorageError> {
  for (const completed of snapshot.records.values()) {
    if (completed.descriptor.family !== 'CheckBody' || completed.descriptor.reuse !== 'Revision')
      continue
    // Reuse keeps the admitted object, so an unchanged record is already what storage holds.
    if (backed.has(completed)) continue
    const bytes = encodeCandidate(self, completed, index)
    if (bytes === undefined) continue
    const published = yield* self.config.storage
      .publish(storageAddress(variant, completed.descriptor), bytes, self.config.maximumRecordBytes)
      .pipe(
        Effect.as(true),
        Effect.catchTag('StorageError', (error) => recoverPublish(self, error)),
      )
    if (published) {
      mutable(self).published += 1
      backed.add(completed)
    }
  }
})
