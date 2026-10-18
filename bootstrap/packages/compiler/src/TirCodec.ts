import * as Data from 'effect/Data'
import type * as DeclarationFacts from './DeclarationFacts.js'
import type * as DeclarationIndex from './DeclarationIndex.js'
import * as Elaboration from './Elaboration.js'
import * as LifetimeFlow from './LifetimeFlow.js'
import type * as SemanticContext from './SemanticContext.js'
import * as SourceSpan from './SourceSpan.js'
import * as Tir from './Tir.js'

export const schema = 2

export interface Limits {
  readonly maximumBytes: number
  readonly maximumDepth: number
  readonly maximumCollectionEntries: number
  readonly maximumStringBytes: number
  readonly maximumByteArrayBytes: number
  readonly maximumObjectFields: number
  readonly maximumIdentifier: number
}

export const defaultLimits: Limits = {
  maximumBytes: 64 * 1024 * 1024,
  maximumDepth: 192,
  maximumCollectionEntries: 2_000_000,
  maximumStringBytes: 8 * 1024 * 1024,
  maximumByteArrayBytes: 32 * 1024 * 1024,
  maximumObjectFields: 4096,
  maximumIdentifier: Number.MAX_SAFE_INTEGER,
}

export type RejectionReason =
  | 'MalformedJson'
  | 'IncompatibleSchema'
  | 'Oversize'
  | 'Depth'
  | 'Collection'
  | 'String'
  | 'Bytes'
  | 'Number'
  | 'Tag'
  | 'Fields'
  | 'Identifier'
  | 'Declaration'
  | 'Unit'

export class CodecError extends Data.TaggedError('TirCodecError')<{
  readonly reason: RejectionReason
  readonly message: string
}> {
  constructor(reason: RejectionReason, message: string) {
    super({ reason, message })
  }
}

type Encoded =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<Encoded>
  | { readonly [key: string]: Encoded }

type StableDeclaration =
  | { readonly kind: 'unit'; readonly site: number }
  | { readonly kind: 'named'; readonly module: string; readonly name: string }

/**
 * Composite values live once in `table`; wherever one is a child it appears as the reference `[n]`.
 * A node only references earlier nodes, so the table is a DAG in dependency order. Types repeat at
 * every node of a body, and naming them once is most of the size of a record.
 */
type Reference = readonly [number]

const utf8 = new TextEncoder()
const tag = '$'
const hiddenBase = Tir.hiddenDeclarationOrdinal(0, 0)
const records = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const assertLimit = (value: number, name: keyof Limits): void => {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new CodecError('Identifier', `${name} must be a positive safe integer`)
}

const validateLimits = (limits: Limits): void => {
  for (const [name, value] of Object.entries(limits)) assertLimit(value, name as keyof Limits)
}

const declarationKey = (id: DeclarationFacts.DeclarationId): string =>
  `${id.sourceId.length}:${id.sourceId}:${id.ordinal}`

const stableIdentityOf = (
  value: unknown,
):
  | { readonly id: DeclarationFacts.DeclarationId; readonly module: string; readonly name: string }
  | undefined => {
  if (!records(value) || !records(value['id']) || value['id']['_tag'] !== 'DeclarationId')
    return undefined
  const id = value['id'] as unknown as DeclarationFacts.DeclarationId
  const canonical = value['canonical']
  if (
    records(canonical) &&
    canonical['_tag'] === 'Canonical' &&
    records(canonical['id']) &&
    typeof canonical['id']['module'] === 'string' &&
    typeof canonical['id']['name'] === 'string'
  )
    return { id, module: canonical['id']['module'], name: canonical['id']['name'] }
  const associated = value['associatedMember']
  if (
    records(associated) &&
    records(associated['owner']) &&
    typeof associated['owner']['module'] === 'string' &&
    typeof associated['owner']['name'] === 'string' &&
    typeof associated['name'] === 'string'
  )
    return {
      id,
      module: associated['owner']['module'],
      name: `${associated['owner']['name']}::${associated['name']}`,
    }
  return undefined
}

interface StableEntry {
  readonly id: DeclarationFacts.DeclarationId
  readonly module: string
  readonly name: string
}

const nameKey = (module: string, name: string): string => `${module.length}:${module}:${name}`

const stableIndexes = new WeakMap<DeclarationIndex.Index, ReadonlyArray<StableEntry>>()

/** Every declaration a record may name, under a name unique in this index. */
const stableEntries = (index: DeclarationIndex.Index): ReadonlyArray<StableEntry> => {
  const cached = stableIndexes.get(index)
  if (cached !== undefined) return cached
  const entries: Array<StableEntry> = []
  for (const module of index.modules) {
    for (const declaration of [...module.members, ...module.declarations]) {
      const stable = stableIdentityOf(declaration)
      if (stable !== undefined) entries.push(stable)
    }
    // An operation has no canonical id of its own; its contract's name and its own name give one.
    for (const contract of [...module.interfaces, ...module.services]) {
      if (contract.canonical._tag !== 'Canonical') continue
      for (const operation of contract.operations)
        if (operation.name._tag === 'Present')
          entries.push({
            id: operation.id,
            module: contract.canonical.id.module,
            name: `${contract.canonical.id.name}::${operation.name.spelling}`,
          })
    }
  }
  for (const declaration of index.generatedAggregates.values())
    if (declaration.canonical._tag === 'Canonical')
      entries.push({
        id: declaration.id,
        module: declaration.canonical.id.module,
        name: declaration.canonical.id.name,
      })
  // A name two different declarations share identifies neither; both stay unstable.
  const owners = new Map<string, string>()
  const ambiguous = new Set<string>()
  for (const entry of entries) {
    const key = nameKey(entry.module, entry.name)
    const owner = owners.get(key)
    if (owner === undefined) owners.set(key, declarationKey(entry.id))
    else if (owner !== declarationKey(entry.id)) ambiguous.add(key)
  }
  const result = entries.filter((entry) => !ambiguous.has(nameKey(entry.module, entry.name)))
  stableIndexes.set(index, result)
  return result
}

const declarationIndexes = new WeakMap<
  DeclarationIndex.Index,
  ReadonlyMap<string, StableDeclaration>
>()

const stableDeclarations = (
  index: DeclarationIndex.Index,
): ReadonlyMap<string, StableDeclaration> => {
  const cached = declarationIndexes.get(index)
  if (cached !== undefined) return cached
  const result = new Map<string, StableDeclaration>()
  for (const entry of stableEntries(index))
    result.set(declarationKey(entry.id), { kind: 'named', module: entry.module, name: entry.name })
  declarationIndexes.set(index, result)
  return result
}

const relativeDeclaration = (
  root: DeclarationFacts.DeclarationId,
  id: DeclarationFacts.DeclarationId,
): StableDeclaration | undefined => {
  if (id.sourceId !== root.sourceId) return undefined
  if (id.ordinal === root.ordinal) return { kind: 'unit', site: 0 }
  if (id.ordinal < hiddenBase) return undefined
  const site = (id.ordinal - hiddenBase) % 65536
  const enclosing = (id.ordinal - hiddenBase - site) / 65536
  return enclosing === root.ordinal ? { kind: 'unit', site: site + 1 } : undefined
}

const encodeDeclaration = (declaration: StableDeclaration): Encoded =>
  declaration.kind === 'unit'
    ? { [tag]: 'declaration', kind: 'unit', site: declaration.site }
    : {
        [tag]: 'declaration',
        kind: 'named',
        module: declaration.module,
        name: declaration.name,
      }

const encoder = (
  root: DeclarationFacts.DeclarationId,
  declarations: ReadonlyMap<string, StableDeclaration>,
) => {
  const table: Array<string> = []
  const interned = new Map<string, number>()
  const known = new WeakMap<object, Reference>()
  // Mutable collections decode to fresh instances, so they are never shared.
  const intern = (node: Encoded, share = true): Reference => {
    const text = JSON.stringify(node)
    const existing = share ? interned.get(text) : undefined
    if (existing !== undefined) return [existing]
    if (share) interned.set(text, table.length)
    table.push(text)
    return [table.length - 1]
  }
  const encodeObject = (input: object): Reference => {
    if (SourceSpan.isSourceSpan(input)) return intern({ [tag]: 'span' })
    if (Array.isArray(input)) return intern(input.map(encodeValue))
    if (input instanceof Map)
      return intern(
        {
          [tag]: 'map',
          entries: intern(
            [...input].map(([key, value]) => intern([encodeValue(key), encodeValue(value)])),
          ),
        },
        false,
      )
    if (input instanceof Set)
      return intern({ [tag]: 'set', values: intern([...input].map(encodeValue)) }, false)
    if (input instanceof Uint8Array) return intern({ [tag]: 'bytes', values: [...input] }, false)
    const record = input as Readonly<Record<string, unknown>>
    if (
      record['_tag'] === 'DeclarationId' &&
      typeof record['sourceId'] === 'string' &&
      typeof record['ordinal'] === 'number'
    ) {
      const id = input as DeclarationFacts.DeclarationId
      const stable = relativeDeclaration(root, id) ?? declarations.get(declarationKey(id))
      if (stable === undefined)
        throw new CodecError(
          'Declaration',
          `declaration ${id.sourceId}:${id.ordinal} is not stable`,
        )
      return intern(encodeDeclaration(stable))
    }
    const result: Record<string, Encoded> = {}
    for (const key of Object.keys(record).sort()) {
      const value = record[key]
      if (value !== undefined) result[key] = encodeValue(value)
    }
    return intern(result)
  }
  const encodeValue = (input: unknown): Encoded => {
    if (input === null || typeof input === 'boolean' || typeof input === 'string') return input
    if (typeof input === 'number') {
      if (!Number.isFinite(input))
        throw new CodecError('Number', 'checked unit has non-finite number')
      return input
    }
    if (typeof input === 'bigint') return intern({ [tag]: 'bigint', value: input.toString() })
    if (typeof input !== 'object')
      throw new CodecError('Unit', `checked unit has unsupported ${typeof input}`)
    const seen = known.get(input)
    if (seen !== undefined) return seen
    const reference = encodeObject(input)
    known.set(input, reference)
    return reference
  }
  return { encodeValue, table }
}

const namedIndexes = new WeakMap<
  DeclarationIndex.Index,
  ReadonlyMap<string, DeclarationFacts.DeclarationId>
>()

const namedDeclarations = (
  index: DeclarationIndex.Index,
): ReadonlyMap<string, DeclarationFacts.DeclarationId> => {
  const cached = namedIndexes.get(index)
  if (cached !== undefined) return cached
  const result = new Map<string, DeclarationFacts.DeclarationId>()
  for (const entry of stableEntries(index)) result.set(nameKey(entry.module, entry.name), entry.id)
  namedIndexes.set(index, result)
  return result
}

interface DecodeState {
  entries: number
}

const exactFields = (
  record: Readonly<Record<string, unknown>>,
  fields: ReadonlyArray<string>,
): void => {
  const actual = Object.keys(record).sort()
  const expected = [...fields].sort()
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index]))
    throw new CodecError(
      'Fields',
      `invalid fields for ${typeof record[tag] === 'string' ? record[tag] : 'object'}`,
    )
}

const decoder = (
  limits: Limits,
  root: DeclarationFacts.DeclarationFact,
  declarations: ReadonlyMap<string, DeclarationFacts.DeclarationId>,
) => {
  const state: DecodeState = { entries: 0 }
  const count = (amount: number): void => {
    state.entries += amount
    if (state.entries > limits.maximumCollectionEntries)
      throw new CodecError('Collection', 'checked unit exceeds collection bound')
  }
  const decodeDeclaration = (
    record: Readonly<Record<string, unknown>>,
  ): DeclarationFacts.DeclarationId => {
    if (record['kind'] === 'unit') {
      exactFields(record, [tag, 'kind', 'site'])
      const site = record['site']
      if (!Number.isSafeInteger(site) || (site as number) < 0 || (site as number) > 65535)
        throw new CodecError('Identifier', 'invalid unit declaration site')
      return {
        _tag: 'DeclarationId',
        sourceId: root.id.sourceId,
        ordinal:
          site === 0
            ? root.id.ordinal
            : Tir.hiddenDeclarationOrdinal(root.id.ordinal, (site as number) - 1),
      }
    }
    if (record['kind'] !== 'named') throw new CodecError('Declaration', 'unknown declaration kind')
    exactFields(record, [tag, 'kind', 'module', 'name'])
    const module = record['module']
    const name = record['name']
    if (typeof module !== 'string' || typeof name !== 'string')
      throw new CodecError('Declaration', 'malformed named declaration')
    const declaration = declarations.get(nameKey(module, name))
    if (declaration === undefined)
      throw new CodecError('Declaration', `current declaration ${module}.${name} is unavailable`)
    return declaration
  }
  const values: Array<unknown> = []
  const depths: Array<number> = []
  let depth = 0
  const child = (input: unknown): unknown => {
    if (input === null || typeof input === 'boolean') return input
    if (typeof input === 'string') {
      // A string holds at most three UTF-8 bytes per code unit; only a long one needs measuring.
      if (
        input.length * 3 > limits.maximumStringBytes &&
        utf8.encode(input).byteLength > limits.maximumStringBytes
      )
        throw new CodecError('String', 'checked unit string exceeds bound')
      return input
    }
    if (typeof input === 'number') {
      if (!Number.isFinite(input) || Math.abs(input) > limits.maximumIdentifier)
        throw new CodecError('Number', 'checked unit number is outside the supported range')
      return input
    }
    const at: unknown = Array.isArray(input) && input.length === 1 ? input[0] : undefined
    if (typeof at !== 'number' || !Number.isInteger(at) || at < 0 || at >= values.length)
      throw new CodecError('Unit', 'checked unit contains an invalid reference')
    depth = Math.max(depth, (depths[at] ?? 0) + 1)
    return values[at]
  }
  const collection = (input: unknown, kind: string): ReadonlyArray<unknown> => {
    const decoded = child(input)
    if (!Array.isArray(decoded)) throw new CodecError('Collection', `malformed ${kind}`)
    return decoded as ReadonlyArray<unknown>
  }
  const decodeNode = (input: unknown): unknown => {
    if (Array.isArray(input)) {
      count(input.length)
      return input.map(child)
    }
    if (!records(input)) throw new CodecError('Unit', 'checked unit contains unsupported value')
    const keys = Object.keys(input)
    if (keys.length > limits.maximumObjectFields)
      throw new CodecError('Fields', 'checked unit object exceeds field bound')
    count(keys.length)
    const special = input[tag]
    if (special !== undefined) {
      if (typeof special !== 'string') throw new CodecError('Tag', 'non-string codec tag')
      switch (special) {
        case 'bigint': {
          exactFields(input, [tag, 'value'])
          const value = input['value']
          if (typeof value !== 'string' || !/^-?(0|[1-9][0-9]*)$/.test(value))
            throw new CodecError('Number', 'malformed bigint')
          return BigInt(value)
        }
        case 'span':
          exactFields(input, [tag])
          return SourceSpan.fromOffsets('', 0, 0)
        case 'map': {
          exactFields(input, [tag, 'entries'])
          return new Map(
            collection(input['entries'], 'map').map((entry) => {
              if (!Array.isArray(entry) || entry.length !== 2)
                throw new CodecError('Collection', 'malformed map entry')
              return [entry[0], entry[1]] as [unknown, unknown]
            }),
          )
        }
        case 'set':
          exactFields(input, [tag, 'values'])
          return new Set(collection(input['values'], 'set'))
        case 'bytes': {
          exactFields(input, [tag, 'values'])
          const bytes = input['values']
          if (!Array.isArray(bytes) || bytes.length > limits.maximumByteArrayBytes)
            throw new CodecError('Bytes', 'malformed or oversized byte array')
          return Uint8Array.from(
            bytes.map((value) => {
              if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 255)
                throw new CodecError('Bytes', 'invalid byte')
              return value as number
            }),
          )
        }
        case 'declaration':
          return decodeDeclaration(input)
        default:
          throw new CodecError('Tag', `unknown codec tag ${special}`)
      }
    }
    const result: Record<string, unknown> = {}
    for (const key of keys) result[key] = child(input[key])
    // Several validated TIR analysis tables own lazy, non-semantic memo fields. The container is
    // frozen only after those actors rebuild their caches; decoding must not freeze the cache host.
    return result
  }
  /** Decodes the table in order and returns the value `unit` references. */
  return (table: unknown, unit: unknown): unknown => {
    if (!Array.isArray(table)) throw new CodecError('Unit', 'codec table must be an array')
    count(table.length)
    for (const node of table) {
      depth = 0
      values.push(decodeNode(node))
      if (depth > limits.maximumDepth)
        throw new CodecError('Depth', 'checked unit exceeds depth bound')
      depths.push(depth)
    }
    return child(unit)
  }
}

const checkedUnit = (value: unknown): Elaboration.CheckedUnit => {
  if (!records(value)) throw new CodecError('Unit', 'checked unit root must be an object')
  exactFields(value, ['bodies', 'diagnostics'])
  if (!Array.isArray(value['bodies']) || !Array.isArray(value['diagnostics']))
    throw new CodecError('Unit', 'checked unit has malformed collections')
  if (value['bodies'].length === 0) throw new CodecError('Unit', 'checked unit has no primary body')
  for (const [index, body] of value['bodies'].entries()) {
    if (
      !records(body) ||
      !records(body['declaration']) ||
      !records(body['function']) ||
      !records(body['results'])
    )
      throw new CodecError('Unit', `body ${index} is malformed`)
    if (typeof body['hidden'] !== 'boolean')
      throw new CodecError('Unit', `body ${index} has invalid ownership`)
    const id = body['declaration']['id']
    if (!records(id) || id['_tag'] !== 'DeclarationId')
      throw new CodecError('Declaration', `body ${index} has invalid declaration`)
  }
  return value as unknown as Elaboration.CheckedUnit
}

const validateUnit = (unit: Elaboration.CheckedUnit, limits: Limits): void => {
  const artifacts = new Set<string>()
  for (const [bodyIndex, body] of unit.bodies.entries()) {
    if (
      !Number.isSafeInteger(body.declaration.id.ordinal) ||
      body.declaration.id.ordinal < 0 ||
      body.declaration.id.ordinal > limits.maximumIdentifier
    )
      throw new CodecError('Identifier', `body ${bodyIndex} declaration id is out of range`)
    const artifact = Tir.artifactKey(body.artifact)
    if (artifacts.has(artifact)) throw new CodecError('Unit', `duplicate artifact ${artifact}`)
    if (body.hidden) {
      const parent = body.artifact.parent
      if (parent === undefined || !artifacts.has(Tir.artifactKey(parent)))
        throw new CodecError('Unit', `hidden body ${bodyIndex} has no admitted parent artifact`)
    } else if (body.artifact.parent !== undefined) {
      throw new CodecError('Unit', `source body ${bodyIndex} unexpectedly has a parent artifact`)
    }
    artifacts.add(artifact)
    const nodes = Tir.nodesOf(body.function)
    if (nodes.some((node, ordinal) => node.id.ordinal !== ordinal))
      throw new CodecError('Identifier', `body ${bodyIndex} node table is not contiguous`)
    const locals = body.function.locals
    if (locals === undefined || locals.some((local, ordinal) => local.id.ordinal !== ordinal))
      throw new CodecError('Identifier', `body ${bodyIndex} local table is not contiguous`)
    if (!Array.isArray(body.results.evidence) || !Array.isArray(body.results.causes))
      throw new CodecError('Unit', `body ${bodyIndex} has malformed evidence tables`)
  }
}

/** Encodes one complete checked unit. Positions are omitted and declaration ids use stable names. */
export const encode = (
  unit: Elaboration.CheckedUnit,
  index: DeclarationIndex.Index,
  limits: Limits = defaultLimits,
): Uint8Array => {
  validateLimits(limits)
  const primary = unit.bodies[0]
  if (primary === undefined) throw new CodecError('Unit', 'checked unit has no primary body')
  const { encodeValue, table } = encoder(primary.declaration.id, stableDeclarations(index))
  const root = encodeValue({
    bodies: unit.bodies.map((body) => ({
      artifact: body.artifact,
      declaration: body.declaration,
      hidden: body.hidden,
      function: { ...body.function, declaration: undefined },
      results:
        body.results.lifetimes === undefined
          ? body.results
          : { ...body.results, lifetimes: LifetimeFlow.content(body.results.lifetimes) },
    })),
    diagnostics: unit.diagnostics,
  })
  const bytes = utf8.encode(
    `{"schema":${schema},"table":[${table.join(',')}],"unit":${JSON.stringify(root)}}`,
  )
  if (bytes.byteLength > limits.maximumBytes)
    throw new CodecError('Oversize', 'checked unit exceeds byte bound')
  return bytes
}

/** Canonical, position-free in-process result identity; unavailable external ids remain explicit. */
export const fingerprint = (
  unit: Elaboration.CheckedUnit,
  index: DeclarationIndex.Index,
  declarationFingerprint: (declaration: DeclarationFacts.DeclarationFact) => string,
): string => {
  const primary = unit.bodies[0]
  if (primary === undefined) throw new CodecError('Unit', 'checked unit has no primary body')
  const declarations = stableDeclarations(index)
  const visited = new WeakSet<object>()
  const state: [number, number, number, number, number, number, number, number] = [
    0x811c9dc5, 0x9e3779b9, 0x243f6a88, 0xb7e15162, 0x85ebca6b, 0xc2b2ae35, 0x27d4eb2f, 0x165667b1,
  ]
  const write = (value: number): void => {
    state[0] = Math.imul(state[0] ^ value, 0x01000193) >>> 0
    state[1] = Math.imul(state[1] + value, 0x85ebca6b) >>> 0
    state[2] = Math.imul(state[2] ^ ((value << 16) | (value >>> 16)), 0xc2b2ae35) >>> 0
    state[3] = Math.imul(state[3] + (value ^ 0x9e3779b9), 0x27d4eb2f) >>> 0
    state[4] = Math.imul(state[4] ^ (value + 0x7f4a7c15), 0x165667b1) >>> 0
    state[5] = Math.imul(state[5] + ((value << 13) | (value >>> 19)), 0xd3a2646c) >>> 0
    state[6] = Math.imul(state[6] ^ (value + state[0]), 0xfd7046c5) >>> 0
    state[7] = Math.imul(state[7] + (value ^ state[3]), 0xb55a4f09) >>> 0
  }
  const writeText = (value: string): void => {
    let first = 0x811c9dc5
    let second = 0x9e3779b9
    let third = 0x243f6a88
    let fourth = 0xb7e15162
    for (let offset = 0; offset < value.length; offset += 1) {
      const code = value.charCodeAt(offset)
      first = Math.imul(first ^ code, 0x01000193) >>> 0
      second = Math.imul(second + code, 0x85ebca6b) >>> 0
      third = Math.imul(third ^ ((code << 16) | (code >>> 16)), 0xc2b2ae35) >>> 0
      fourth = Math.imul(fourth + (code ^ 0x9e3779b9), 0x27d4eb2f) >>> 0
    }
    write(value.length)
    write(first)
    write(second)
    write(third)
    write(fourth)
  }
  const writeValue = (input: unknown): void => {
    if (input === null) {
      writeText('null')
      return
    }
    if (typeof input === 'boolean') {
      writeText('boolean')
      write(input ? 1 : 0)
      return
    }
    if (typeof input === 'string') {
      writeText('string')
      writeText(input)
      return
    }
    if (typeof input === 'number') {
      if (!Number.isFinite(input))
        throw new CodecError('Number', 'checked unit has non-finite number')
      writeText('number')
      writeText(String(input))
      return
    }
    if (typeof input === 'bigint') {
      writeText('bigint')
      writeText(String(input))
      return
    }
    if (typeof input !== 'object')
      throw new CodecError('Unit', `checked unit has unsupported ${typeof input}`)
    if (SourceSpan.isSourceSpan(input)) {
      writeText('span')
      return
    }
    if (visited.has(input)) {
      writeText('reference')
      return
    }
    visited.add(input)
    if (Array.isArray(input)) {
      writeText('array')
      write(input.length)
      for (const value of input) writeValue(value)
    } else if (input instanceof Map) {
      writeText('map')
      write(input.size)
      for (const [key, value] of input) {
        writeValue(key)
        writeValue(value)
      }
    } else if (input instanceof Set) {
      writeText('set')
      write(input.size)
      for (const value of input) writeValue(value)
    } else if (input instanceof Uint8Array) {
      writeText('bytes')
      write(input.byteLength)
      for (const value of input) write(value)
    } else {
      const record = input as Readonly<Record<string, unknown>>
      if (
        record['_tag'] === 'DeclarationId' &&
        typeof record['sourceId'] === 'string' &&
        typeof record['ordinal'] === 'number'
      ) {
        const id = input as DeclarationFacts.DeclarationId
        const declaration =
          relativeDeclaration(primary.declaration.id, id) ?? declarations.get(declarationKey(id))
        writeText('declaration')
        if (declaration === undefined) {
          writeText('unstable')
          writeText(id.sourceId)
          write(id.ordinal)
        } else {
          writeText(declaration.kind)
          if (declaration.kind === 'named') {
            writeText(declaration.module)
            writeText(declaration.name)
          } else {
            write(declaration.site)
          }
        }
      } else {
        writeText('object')
        const keys = Object.keys(record)
          .filter((key) => record[key] !== undefined)
          .sort()
        write(keys.length)
        for (const key of keys) {
          const value = record[key]
          writeText(key)
          writeValue(value)
        }
      }
    }
  }
  const semanticUnit = {
    bodies: unit.bodies.map((body) => ({
      artifact: body.artifact,
      declaration: declarationFingerprint(body.declaration),
      hidden: body.hidden,
      function: { ...body.function, artifact: undefined, declaration: undefined },
      results:
        body.results.lifetimes === undefined
          ? body.results
          : { ...body.results, lifetimes: LifetimeFlow.content(body.results.lifetimes) },
    })),
    diagnostics: unit.diagnostics,
  }
  writeValue(semanticUnit)
  return state.map((value) => value.toString(16).padStart(8, '0')).join('')
}

/** Strictly decodes and presents one complete unit against the current header and authored spans. */
export const decode = (
  bytes: Uint8Array,
  index: DeclarationIndex.Index,
  declaration: DeclarationFacts.DeclarationFact,
  context: SemanticContext.SemanticContext,
  limits: Limits = defaultLimits,
): Elaboration.CheckedUnit => {
  validateLimits(limits)
  if (bytes.byteLength > limits.maximumBytes)
    throw new CodecError('Oversize', 'checked unit exceeds byte bound')
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
  } catch {
    throw new CodecError('MalformedJson', 'checked unit is not canonical UTF-8 JSON')
  }
  if (!records(parsed)) throw new CodecError('Unit', 'codec root must be an object')
  if (parsed['schema'] !== schema)
    throw new CodecError('IncompatibleSchema', 'codec schema mismatch')
  exactFields(parsed, ['schema', 'table', 'unit'])
  const decodeTable = decoder(limits, declaration, namedDeclarations(index))
  const unit = checkedUnit(decodeTable(parsed['table'], parsed['unit']))
  const bodies = unit.bodies.map((body, bodyIndex) => {
    const owner =
      bodyIndex === 0 ||
      (body.declaration.id.sourceId === declaration.id.sourceId &&
        body.declaration.id.ordinal === declaration.id.ordinal)
        ? declaration
        : body.declaration
    return Elaboration.presentBody(
      {
        artifact: body.artifact,
        declaration: owner,
        hidden: body.hidden,
        function: { ...body.function, declaration: owner },
        results: body.results,
      },
      context,
      owner,
    )
  })
  const presented = { bodies: bodies, diagnostics: unit.diagnostics }
  validateUnit(presented, limits)
  return presented
}
