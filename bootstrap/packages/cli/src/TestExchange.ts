import * as Crypto from 'effect/Crypto'
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import type * as PlatformError from 'effect/PlatformError'

export const version = 1
export const compactBytes = 256
export const hardMaximumBytes = 16 * 1024 * 1024

export type Mode = 'PerTest' | 'Uncached'
export type PlanAction = 'Execute' | 'Cached'
export type Disposition = 'Cached' | 'Passed' | 'Failed'

export interface PlanEntry {
  readonly declarationIdentity: string
  readonly executionIdentity: string | undefined
  readonly action: PlanAction
}

export interface PerTestPlan {
  readonly _tag: 'PerTest'
  readonly nonce: Uint8Array
  readonly entries: ReadonlyArray<PlanEntry>
}

export interface UncachedPlan {
  readonly _tag: 'Uncached'
  readonly nonce: Uint8Array
  readonly catalogDigest: Uint8Array
  readonly discovered: bigint
}

export type Plan = PerTestPlan | UncachedPlan

export interface Counts {
  readonly discovered: bigint
  readonly selected: bigint
  readonly cached: bigint
  readonly executed: bigint
  readonly passed: bigint
  readonly failed: bigint
}

export interface ReceiptEntry {
  readonly ordinal: bigint
  readonly declarationIdentity: string
  readonly executionIdentity: string | undefined
  readonly disposition: Disposition
}

export interface PerTestReceipt {
  readonly _tag: 'PerTest'
  readonly nonce: Uint8Array
  readonly planDigest: Uint8Array
  readonly entries: ReadonlyArray<ReceiptEntry>
  readonly counts: Counts
  readonly status: number
}

export interface UncachedReceipt {
  readonly _tag: 'Uncached'
  readonly nonce: Uint8Array
  readonly planDigest: Uint8Array
  readonly counts: Counts
  readonly status: number
}

export type Receipt = PerTestReceipt | UncachedReceipt

export type ExchangeErrorReason =
  | { readonly _tag: 'InvalidPlan'; readonly detail: string }
  | { readonly _tag: 'InvalidReceipt'; readonly detail: string }
  | { readonly _tag: 'CryptoFailure'; readonly cause: PlatformError.PlatformError }

export class ExchangeError extends Data.TaggedError('ExchangeError')<{
  readonly operation:
    | 'TestExchange.nonce'
    | 'TestExchange.catalogDigest'
    | 'TestExchange.planDigest'
    | 'TestExchange.encodePlan'
    | 'TestExchange.decodePlan'
    | 'TestExchange.encodeReceipt'
    | 'TestExchange.admitReceipt'
  readonly message: string
  readonly reason: ExchangeErrorReason
}> {}

const planMagic = Uint8Array.from([0x53, 0x4c, 0x4b, 0x54, 0x50, 0x4c, 0x4e, 0x31])
const receiptMagic = Uint8Array.from([0x53, 0x4c, 0x4b, 0x54, 0x52, 0x43, 0x50, 0x31])
const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder('utf-8', { fatal: true })
const perTestMode = 1
const uncachedMode = 2
const perTestHeaderBytes = 56n
const perTestReceiptHeaderBytes = 88n
const receiptTrailerBytes = 52n
const maximumSafeSize = BigInt(Number.MAX_SAFE_INTEGER)

const invalid = (
  operation: ExchangeError['operation'],
  kind: 'InvalidPlan' | 'InvalidReceipt',
  detail: string,
): ExchangeError =>
  new ExchangeError({
    operation,
    message: `${operation} rejected ${kind === 'InvalidPlan' ? 'a plan' : 'a receipt'}: ${detail}`,
    reason: { _tag: kind, detail },
  })

const cryptoFailure = (
  operation: ExchangeError['operation'],
  cause: PlatformError.PlatformError,
): ExchangeError =>
  new ExchangeError({
    operation,
    message: `${operation} could not complete its cryptographic binding`,
    reason: { _tag: 'CryptoFailure', cause },
  })

const digest = Effect.fnUntraced(function* (
  operation: ExchangeError['operation'],
  bytes: Uint8Array,
): Effect.fn.Return<Uint8Array, ExchangeError, Crypto.Crypto> {
  const crypto = yield* Crypto.Crypto
  return yield* crypto.digest('SHA-256', bytes).pipe(
    Effect.map((value) => Uint8Array.from(value)),
    Effect.mapError((cause) => cryptoFailure(operation, cause)),
  )
})

const modeCode = (mode: Mode): number => (mode === 'PerTest' ? perTestMode : uncachedMode)

const boundedU64 = (value: bigint): boolean => value >= 0n && value <= 0xffff_ffff_ffff_ffffn

const bytesEqual = (left: Uint8Array, right: Uint8Array): boolean => {
  if (left.length !== right.length) return false
  let different = 0
  for (let index = 0; index < left.length; index += 1)
    different |= (left.at(index) ?? 0) ^ (right.at(index) ?? 0)
  return different === 0
}

interface Writer {
  readonly bytes: Uint8Array
  offset: number
}

const writeBytes = (writer: Writer, bytes: Uint8Array): void => {
  writer.bytes.set(bytes, writer.offset)
  writer.offset += bytes.length
}

const writeU8 = (writer: Writer, value: number): void => {
  writer.bytes[writer.offset] = value
  writer.offset += 1
}

const writeU32 = (writer: Writer, value: number): void => {
  for (let index = 0; index < 4; index += 1)
    writeU8(writer, Math.floor(value / 2 ** (index * 8)) % 256)
}

const writeU64 = (writer: Writer, value: bigint): void => {
  for (let index = 0n; index < 8n; index += 1n)
    writeU8(writer, Number((value >> (index * 8n)) & 0xffn))
}

interface Reader {
  readonly bytes: Uint8Array
  offset: number
}

const readBytes = (reader: Reader, length: number): Option.Option<Uint8Array> => {
  if (!Number.isSafeInteger(length) || length < 0 || length > reader.bytes.length - reader.offset)
    return Option.none()
  const result = reader.bytes.slice(reader.offset, reader.offset + length)
  reader.offset += length
  return Option.some(result)
}

const readU8 = (reader: Reader): Option.Option<number> => {
  if (reader.offset >= reader.bytes.length) return Option.none()
  const result = reader.bytes.at(reader.offset)
  if (result === undefined) return Option.none()
  reader.offset += 1
  return Option.some(result)
}

const readU32 = (reader: Reader): Option.Option<number> => {
  const bytes = readBytes(reader, 4)
  if (Option.isNone(bytes)) return Option.none()
  return Option.some(
    (bytes.value.at(0) ?? 0) +
      (bytes.value.at(1) ?? 0) * 2 ** 8 +
      (bytes.value.at(2) ?? 0) * 2 ** 16 +
      (bytes.value.at(3) ?? 0) * 2 ** 24,
  )
}

const readU64 = (reader: Reader): Option.Option<bigint> => {
  const bytes = readBytes(reader, 8)
  if (Option.isNone(bytes)) return Option.none()
  let result = 0n
  for (let index = 0; index < 8; index += 1)
    result |= BigInt(bytes.value.at(index) ?? 0) << BigInt(index * 8)
  return Option.some(result)
}

const decodeText = (bytes: Uint8Array): Option.Option<string> => {
  try {
    return Option.some(textDecoder.decode(bytes))
  } catch (cause) {
    if (cause instanceof TypeError) {
      return Option.none()
    }
    throw cause
  }
}

const readText = (reader: Reader): Option.Option<string> => {
  const length = readU64(reader)
  if (Option.isNone(length) || length.value > maximumSafeSize) return Option.none()
  const bytes = readBytes(reader, Number(length.value))
  return Option.isNone(bytes) ? Option.none() : decodeText(bytes.value)
}

const writeText = (writer: Writer, bytes: Uint8Array): void => {
  writeU64(writer, BigInt(bytes.length))
  writeBytes(writer, bytes)
}

const compactBound = (discovered: bigint): bigint => {
  if (!boundedU64(discovered)) return -1n
  const scaled = 4096n + 256n * discovered
  return scaled < BigInt(hardMaximumBytes) ? scaled : BigInt(hardMaximumBytes)
}

/** Checks both per-test file sizes without narrowing exact unsigned counts. */
export const admitsPerTestSizes = (
  discovered: bigint,
  planBytes: bigint,
  maximumReceiptBytes: bigint,
): boolean => {
  const bound = compactBound(discovered)
  return (
    bound >= 0n &&
    planBytes >= 0n &&
    maximumReceiptBytes >= 0n &&
    planBytes <= bound &&
    maximumReceiptBytes <= bound &&
    planBytes <= maximumSafeSize &&
    maximumReceiptBytes <= maximumSafeSize
  )
}

const perTestSizes = (
  entries: ReadonlyArray<PlanEntry>,
): { readonly plan: bigint; readonly receipt: bigint } => {
  let entriesBytes = 0n
  for (const entry of entries) {
    const declaration = textEncoder.encode(entry.declarationIdentity)
    const execution =
      entry.executionIdentity === undefined
        ? new Uint8Array()
        : textEncoder.encode(entry.executionIdentity)
    entriesBytes += 8n + 8n + BigInt(declaration.length) + 8n + BigInt(execution.length) + 1n
  }
  return {
    plan: perTestHeaderBytes + entriesBytes,
    receipt: perTestReceiptHeaderBytes + entriesBytes + receiptTrailerBytes,
  }
}

/** Selects compact mode unless both complete per-test directions fit their declared bound. */
export const selectMode = (entries: ReadonlyArray<PlanEntry>): Mode => {
  const sizes = perTestSizes(entries)
  return admitsPerTestSizes(BigInt(entries.length), sizes.plan, sizes.receipt)
    ? 'PerTest'
    : 'Uncached'
}

/** Returns the maximum receipt allocation admitted for this already-selected mode. */
export const receiptMaximumBytes = (plan: Plan): number =>
  plan._tag === 'Uncached' ? compactBytes : Number(compactBound(BigInt(plan.entries.length)))

/** Creates a fresh invocation nonce from the active cryptographic service. */
export const nonce = Effect.fn('TestExchange.nonce')(function* (): Effect.fn.Return<
  Uint8Array,
  ExchangeError,
  Crypto.Crypto
> {
  const crypto = yield* Crypto.Crypto
  return yield* crypto.randomBytes(32).pipe(
    Effect.map((value) => Uint8Array.from(value)),
    Effect.mapError((cause) => cryptoFailure('TestExchange.nonce', cause)),
  )
})

/**
 * Hashes catalog-order declaration identities with the compact protocol's exact framing.
 * This protocol digest is distinct from `TestExecution.Manifest.catalogIdentity`.
 */
export const catalogDigest = Effect.fn('TestExchange.catalogDigest')(function* (
  declarationIdentities: ReadonlyArray<string>,
): Effect.fn.Return<Uint8Array, ExchangeError, Crypto.Crypto> {
  const encoded: Array<Uint8Array> = []
  let size = 0
  for (const identity of declarationIdentities) {
    const bytes = textEncoder.encode(identity)
    if (identity.length === 0)
      return yield* invalid(
        'TestExchange.catalogDigest',
        'InvalidPlan',
        'catalog declaration identity is empty',
      )
    if (size > Number.MAX_SAFE_INTEGER - 16 - bytes.length)
      return yield* invalid(
        'TestExchange.catalogDigest',
        'InvalidPlan',
        'catalog framing exceeds the host size range',
      )
    encoded.push(bytes)
    size += 16 + bytes.length
  }
  const framed = yield* Effect.try({
    try: () => new Uint8Array(size),
    catch: (cause) => {
      if (!(cause instanceof RangeError)) throw cause
      return invalid(
        'TestExchange.catalogDigest',
        'InvalidPlan',
        'catalog framing exceeds the runtime allocation range',
      )
    },
  })
  const writer: Writer = { bytes: framed, offset: 0 }
  for (let ordinal = 0; ordinal < encoded.length; ordinal += 1) {
    const identity = encoded.at(ordinal)
    if (identity === undefined)
      return yield* invalid(
        'TestExchange.catalogDigest',
        'InvalidPlan',
        `catalog entry ${ordinal} is missing`,
      )
    writeU64(writer, BigInt(ordinal))
    writeU64(writer, BigInt(identity.length))
    writeBytes(writer, identity)
  }
  return yield* digest('TestExchange.catalogDigest', framed)
})

/** Computes the binding digest of one complete encoded plan. */
export const planDigest = Effect.fn('TestExchange.planDigest')(function* (
  bytes: Uint8Array,
): Effect.fn.Return<Uint8Array, ExchangeError, Crypto.Crypto> {
  return yield* digest('TestExchange.planDigest', bytes)
})

const validPlan = (plan: Plan): string | undefined => {
  if (plan.nonce.length !== 32) return 'nonce must contain exactly 32 bytes'
  if (plan._tag === 'Uncached') {
    if (plan.catalogDigest.length !== 32) return 'catalog digest must contain exactly 32 bytes'
    if (!boundedU64(plan.discovered)) return 'discovered count is outside unsigned 64-bit range'
    return undefined
  }
  if (selectMode(plan.entries) !== 'PerTest') return 'per-test directions exceed their bound'
  for (let index = 0; index < plan.entries.length; index += 1) {
    const entry = plan.entries.at(index)
    if (entry === undefined) return `entry ${index} is missing`
    if (entry.declarationIdentity.length === 0)
      return `entry ${index} has an empty declaration identity`
    if (entry.action === 'Cached' && entry.executionIdentity === undefined)
      return `entry ${index} marks an ineligible declaration cached`
  }
  return undefined
}

/** Encodes a complete strict plan, including the exact 256-byte compact representation. */
export const encodePlan = Effect.fn('TestExchange.encodePlan')(function* (
  plan: Plan,
): Effect.fn.Return<Uint8Array, ExchangeError> {
  const problem = validPlan(plan)
  if (problem !== undefined)
    return yield* invalid('TestExchange.encodePlan', 'InvalidPlan', problem)
  if (plan._tag === 'Uncached') {
    const writer: Writer = { bytes: new Uint8Array(compactBytes), offset: 0 }
    writeBytes(writer, planMagic)
    writeU32(writer, version)
    writeU32(writer, uncachedMode)
    writeBytes(writer, plan.nonce)
    writeBytes(writer, plan.catalogDigest)
    writeU64(writer, plan.discovered)
    return writer.bytes
  }
  const sizes = perTestSizes(plan.entries)
  const writer: Writer = { bytes: new Uint8Array(Number(sizes.plan)), offset: 0 }
  writeBytes(writer, planMagic)
  writeU32(writer, version)
  writeU32(writer, perTestMode)
  writeBytes(writer, plan.nonce)
  writeU64(writer, BigInt(plan.entries.length))
  for (let ordinal = 0; ordinal < plan.entries.length; ordinal += 1) {
    const entry = plan.entries.at(ordinal)
    if (entry === undefined)
      return yield* invalid('TestExchange.encodePlan', 'InvalidPlan', `missing entry ${ordinal}`)
    writeU64(writer, BigInt(ordinal))
    writeText(writer, textEncoder.encode(entry.declarationIdentity))
    writeText(
      writer,
      entry.executionIdentity === undefined
        ? new Uint8Array()
        : textEncoder.encode(entry.executionIdentity),
    )
    writeU8(writer, entry.action === 'Execute' ? 0 : 1)
  }
  return writer.bytes
})

const commonPlan = (
  bytes: Uint8Array,
): Option.Option<{
  readonly reader: Reader
  readonly mode: number
  readonly nonce: Uint8Array
}> => {
  const reader: Reader = { bytes, offset: 0 }
  const magic = readBytes(reader, 8)
  const foundVersion = readU32(reader)
  const mode = readU32(reader)
  const foundNonce = readBytes(reader, 32)
  if (
    Option.isNone(magic) ||
    !bytesEqual(magic.value, planMagic) ||
    Option.isNone(foundVersion) ||
    foundVersion.value !== version ||
    Option.isNone(mode) ||
    Option.isNone(foundNonce)
  )
    return Option.none()
  return Option.some({ reader, mode: mode.value, nonce: foundNonce.value })
}

/** Strictly decodes a complete plan and rejects unknown fields, extra bytes, and invalid padding. */
export const decodePlan = Effect.fn('TestExchange.decodePlan')(function* (
  bytes: Uint8Array,
): Effect.fn.Return<Plan, ExchangeError> {
  if (bytes.length > hardMaximumBytes)
    return yield* invalid('TestExchange.decodePlan', 'InvalidPlan', 'plan exceeds hard bound')
  const common = commonPlan(bytes)
  if (Option.isNone(common))
    return yield* invalid('TestExchange.decodePlan', 'InvalidPlan', 'invalid common header')
  const { mode, nonce: foundNonce, reader } = common.value
  if (mode === uncachedMode) {
    if (bytes.length !== compactBytes)
      return yield* invalid('TestExchange.decodePlan', 'InvalidPlan', 'compact plan size mismatch')
    const catalogDigest = readBytes(reader, 32)
    const discovered = readU64(reader)
    if (Option.isNone(catalogDigest) || Option.isNone(discovered))
      return yield* invalid('TestExchange.decodePlan', 'InvalidPlan', 'truncated compact plan')
    while (reader.offset < bytes.length) {
      const byte = readU8(reader)
      if (Option.isNone(byte) || byte.value !== 0)
        return yield* invalid('TestExchange.decodePlan', 'InvalidPlan', 'nonzero compact padding')
    }
    return {
      _tag: 'Uncached',
      nonce: foundNonce,
      catalogDigest: catalogDigest.value,
      discovered: discovered.value,
    }
  }
  if (mode !== perTestMode)
    return yield* invalid('TestExchange.decodePlan', 'InvalidPlan', 'unknown mode')
  const discovered = readU64(reader)
  if (Option.isNone(discovered) || discovered.value > maximumSafeSize)
    return yield* invalid('TestExchange.decodePlan', 'InvalidPlan', 'invalid discovered count')
  const entries: Array<PlanEntry> = []
  for (let ordinal = 0; ordinal < Number(discovered.value); ordinal += 1) {
    const foundOrdinal = readU64(reader)
    const declaration = readText(reader)
    const execution = readText(reader)
    const action = readU8(reader)
    if (
      Option.isNone(foundOrdinal) ||
      foundOrdinal.value !== BigInt(ordinal) ||
      Option.isNone(declaration) ||
      declaration.value.length === 0 ||
      Option.isNone(execution) ||
      Option.isNone(action) ||
      (action.value !== 0 && action.value !== 1) ||
      (action.value === 1 && execution.value.length === 0)
    )
      return yield* invalid('TestExchange.decodePlan', 'InvalidPlan', `invalid entry ${ordinal}`)
    entries.push({
      declarationIdentity: declaration.value,
      executionIdentity: execution.value.length === 0 ? undefined : execution.value,
      action: action.value === 0 ? 'Execute' : 'Cached',
    })
  }
  if (reader.offset !== bytes.length || selectMode(entries) !== 'PerTest')
    return yield* invalid('TestExchange.decodePlan', 'InvalidPlan', 'extra bytes or oversized plan')
  return { _tag: 'PerTest', nonce: foundNonce, entries }
})

const writeCounts = (writer: Writer, counts: Counts): void => {
  writeU64(writer, counts.discovered)
  writeU64(writer, counts.selected)
  writeU64(writer, counts.cached)
  writeU64(writer, counts.executed)
  writeU64(writer, counts.passed)
  writeU64(writer, counts.failed)
}

const validCounts = (counts: Counts, status: number, mode: Mode): boolean => {
  if (
    !boundedU64(counts.discovered) ||
    !boundedU64(counts.selected) ||
    !boundedU64(counts.cached) ||
    !boundedU64(counts.executed) ||
    !boundedU64(counts.passed) ||
    !boundedU64(counts.failed) ||
    counts.selected > counts.discovered ||
    counts.cached + counts.executed !== counts.selected ||
    counts.passed + counts.failed !== counts.selected ||
    (status !== 0 && status !== 1) ||
    status !== (counts.failed === 0n ? 0 : 1)
  )
    return false
  return mode === 'PerTest' || (counts.cached === 0n && counts.executed === counts.selected)
}

const receiptSize = (receipt: PerTestReceipt): bigint => {
  let size = perTestReceiptHeaderBytes + receiptTrailerBytes
  for (const entry of receipt.entries) {
    const declaration = textEncoder.encode(entry.declarationIdentity)
    const execution =
      entry.executionIdentity === undefined
        ? new Uint8Array()
        : textEncoder.encode(entry.executionIdentity)
    size += 8n + 8n + BigInt(declaration.length) + 8n + BigInt(execution.length) + 1n
  }
  return size
}

const dispositionCode = (disposition: Disposition): number => {
  switch (disposition) {
    case 'Cached':
      return 0
    case 'Passed':
      return 1
    case 'Failed':
      return 2
  }
}

const dispositionOf = (code: number): Disposition => {
  switch (code) {
    case 0:
      return 'Cached'
    case 1:
      return 'Passed'
    default:
      return 'Failed'
  }
}

/** Encodes one complete receipt for runner fixtures and source/host conformance tests. */
export const encodeReceipt = Effect.fn('TestExchange.encodeReceipt')(function* (
  receipt: Receipt,
): Effect.fn.Return<Uint8Array, ExchangeError> {
  if (
    receipt.nonce.length !== 32 ||
    receipt.planDigest.length !== 32 ||
    !validCounts(receipt.counts, receipt.status, receipt._tag)
  )
    return yield* invalid(
      'TestExchange.encodeReceipt',
      'InvalidReceipt',
      'invalid binding or counts',
    )
  if (receipt._tag === 'Uncached') {
    const writer: Writer = { bytes: new Uint8Array(compactBytes), offset: 0 }
    writeBytes(writer, receiptMagic)
    writeU32(writer, version)
    writeU32(writer, uncachedMode)
    writeBytes(writer, receipt.nonce)
    writeBytes(writer, receipt.planDigest)
    writeCounts(writer, receipt.counts)
    writeU32(writer, receipt.status)
    return writer.bytes
  }
  if (BigInt(receipt.entries.length) !== receipt.counts.selected)
    return yield* invalid('TestExchange.encodeReceipt', 'InvalidReceipt', 'entry count mismatch')
  const size = receiptSize(receipt)
  if (!admitsPerTestSizes(receipt.counts.discovered, 0n, size))
    return yield* invalid('TestExchange.encodeReceipt', 'InvalidReceipt', 'receipt exceeds bound')
  const writer: Writer = { bytes: new Uint8Array(Number(size)), offset: 0 }
  writeBytes(writer, receiptMagic)
  writeU32(writer, version)
  writeU32(writer, perTestMode)
  writeBytes(writer, receipt.nonce)
  writeBytes(writer, receipt.planDigest)
  writeU64(writer, BigInt(receipt.entries.length))
  for (const entry of receipt.entries) {
    writeU64(writer, entry.ordinal)
    writeText(writer, textEncoder.encode(entry.declarationIdentity))
    writeText(
      writer,
      entry.executionIdentity === undefined
        ? new Uint8Array()
        : textEncoder.encode(entry.executionIdentity),
    )
    writeU8(writer, dispositionCode(entry.disposition))
  }
  writeCounts(writer, receipt.counts)
  writeU32(writer, receipt.status)
  return writer.bytes
})

const readCounts = (reader: Reader): Option.Option<Counts> => {
  const discovered = readU64(reader)
  const selected = readU64(reader)
  const cached = readU64(reader)
  const executed = readU64(reader)
  const passed = readU64(reader)
  const failed = readU64(reader)
  if (
    Option.isNone(discovered) ||
    Option.isNone(selected) ||
    Option.isNone(cached) ||
    Option.isNone(executed) ||
    Option.isNone(passed) ||
    Option.isNone(failed)
  )
    return Option.none()
  return Option.some({
    discovered: discovered.value,
    selected: selected.value,
    cached: cached.value,
    executed: executed.value,
    passed: passed.value,
    failed: failed.value,
  })
}

const matchingEntry = (plan: PerTestPlan, receipt: ReceiptEntry, previous: bigint): boolean => {
  if (receipt.ordinal <= previous || receipt.ordinal >= BigInt(plan.entries.length)) return false
  const planned = plan.entries.at(Number(receipt.ordinal))
  if (planned === undefined) return false
  if (
    planned.declarationIdentity !== receipt.declarationIdentity ||
    planned.executionIdentity !== receipt.executionIdentity
  )
    return false
  return planned.action === 'Cached'
    ? receipt.disposition === 'Cached'
    : receipt.disposition !== 'Cached'
}

/** Admits one complete receipt only against its exact plan, nonce, digest, mode, and process exit. */
export const admitReceipt = Effect.fn('TestExchange.admitReceipt')(function* (
  plan: Plan,
  encodedPlan: Uint8Array,
  bytes: Uint8Array,
  processStatus: number,
): Effect.fn.Return<Receipt, ExchangeError, Crypto.Crypto> {
  if (bytes.length > receiptMaximumBytes(plan))
    return yield* invalid('TestExchange.admitReceipt', 'InvalidReceipt', 'receipt exceeds bound')
  const expectedDigest = yield* digest('TestExchange.admitReceipt', encodedPlan)
  const reader: Reader = { bytes, offset: 0 }
  const magic = readBytes(reader, 8)
  const foundVersion = readU32(reader)
  const foundMode = readU32(reader)
  const foundNonce = readBytes(reader, 32)
  const foundDigest = readBytes(reader, 32)
  if (
    Option.isNone(magic) ||
    !bytesEqual(magic.value, receiptMagic) ||
    Option.isNone(foundVersion) ||
    foundVersion.value !== version ||
    Option.isNone(foundMode) ||
    foundMode.value !== modeCode(plan._tag) ||
    Option.isNone(foundNonce) ||
    !bytesEqual(foundNonce.value, plan.nonce) ||
    Option.isNone(foundDigest) ||
    !bytesEqual(foundDigest.value, expectedDigest)
  )
    return yield* invalid('TestExchange.admitReceipt', 'InvalidReceipt', 'binding mismatch')
  if (plan._tag === 'Uncached') {
    if (bytes.length !== compactBytes)
      return yield* invalid('TestExchange.admitReceipt', 'InvalidReceipt', 'compact size mismatch')
    const counts = readCounts(reader)
    const status = readU32(reader)
    if (
      Option.isNone(counts) ||
      Option.isNone(status) ||
      counts.value.discovered !== plan.discovered ||
      !validCounts(counts.value, status.value, 'Uncached') ||
      status.value !== processStatus
    )
      return yield* invalid('TestExchange.admitReceipt', 'InvalidReceipt', 'invalid compact counts')
    while (reader.offset < bytes.length) {
      const byte = readU8(reader)
      if (Option.isNone(byte) || byte.value !== 0)
        return yield* invalid('TestExchange.admitReceipt', 'InvalidReceipt', 'nonzero padding')
    }
    return {
      _tag: 'Uncached',
      nonce: foundNonce.value,
      planDigest: foundDigest.value,
      counts: counts.value,
      status: status.value,
    }
  }
  const selected = readU64(reader)
  if (Option.isNone(selected) || selected.value > maximumSafeSize)
    return yield* invalid('TestExchange.admitReceipt', 'InvalidReceipt', 'invalid selected count')
  const entries: Array<ReceiptEntry> = []
  let previous = -1n
  for (let index = 0; index < Number(selected.value); index += 1) {
    const ordinal = readU64(reader)
    const declaration = readText(reader)
    const execution = readText(reader)
    const disposition = readU8(reader)
    if (
      Option.isNone(ordinal) ||
      Option.isNone(declaration) ||
      Option.isNone(execution) ||
      Option.isNone(disposition) ||
      disposition.value > 2
    )
      return yield* invalid('TestExchange.admitReceipt', 'InvalidReceipt', `invalid entry ${index}`)
    const entry: ReceiptEntry = {
      ordinal: ordinal.value,
      declarationIdentity: declaration.value,
      executionIdentity: execution.value.length === 0 ? undefined : execution.value,
      disposition: dispositionOf(disposition.value),
    }
    if (!matchingEntry(plan, entry, previous))
      return yield* invalid(
        'TestExchange.admitReceipt',
        'InvalidReceipt',
        `mismatched entry ${index}`,
      )
    previous = entry.ordinal
    entries.push(entry)
  }
  const counts = readCounts(reader)
  const status = readU32(reader)
  const cached = BigInt(entries.filter((entry) => entry.disposition === 'Cached').length)
  const passed = BigInt(entries.filter((entry) => entry.disposition !== 'Failed').length)
  const failed = BigInt(entries.filter((entry) => entry.disposition === 'Failed').length)
  if (
    Option.isNone(counts) ||
    Option.isNone(status) ||
    reader.offset !== bytes.length ||
    counts.value.discovered !== BigInt(plan.entries.length) ||
    counts.value.selected !== BigInt(entries.length) ||
    counts.value.cached !== cached ||
    counts.value.executed !== BigInt(entries.length) - cached ||
    counts.value.passed !== passed ||
    counts.value.failed !== failed ||
    !validCounts(counts.value, status.value, 'PerTest') ||
    status.value !== processStatus
  )
    return yield* invalid('TestExchange.admitReceipt', 'InvalidReceipt', 'invalid complete counts')
  return {
    _tag: 'PerTest',
    nonce: foundNonce.value,
    planDigest: foundDigest.value,
    entries,
    counts: counts.value,
    status: status.value,
  }
})
