import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as AddrSpace from './AddrSpace.js'
import * as Alignment from './Alignment.js'
import * as ByteString from './ByteString.js'
import { invalidInput, type LlvmError, wrappedFailure } from './LlvmError.js'

/**
 * Alignment rules for one integer, floating-point, or vector bit width.
 *
 * @category data layouts
 * @since 0.0.0
 */
export interface PrimitiveSpec {
  readonly bitWidth: number
  readonly abiAlignment: Alignment.Alignment
  readonly preferredAlignment: Alignment.Alignment
}

/**
 * The effective ABI and preferred alignments for LLVM aggregate types.
 *
 * **Details**
 *
 * LLVM spells a one-byte aggregate ABI alignment as zero bits. Parsed values expose that spelling
 * as an explicit one-byte alignment. When no rule is present, the effective default is `a:0:64`;
 * when preferred alignment is omitted, it inherits the ABI alignment. If rules repeat, the final
 * rule is authoritative.
 *
 * @category data layouts
 * @since 0.0.0
 */
export interface AggregateSpec {
  readonly abiAlignment: Alignment.Alignment
  readonly preferredAlignment: Alignment.Alignment
}

/**
 * Pointer and index widths for one LLVM address space.
 *
 * @category data layouts
 * @since 0.0.0
 */
export interface PointerSpec {
  readonly addressSpace: AddrSpace.AddrSpace
  readonly bitWidth: number
  readonly abiAlignment: Alignment.Alignment
  readonly preferredAlignment: Alignment.Alignment
  readonly indexBitWidth: number
}

/**
 * Parsed, immutable view of an LLVM target data-layout string.
 *
 * @category data layouts
 * @since 0.0.0
 */
export interface DataLayout {
  readonly _tag: 'DataLayout'
  readonly original: ByteString.ByteString
  readonly endian: 'little' | 'big' | undefined
  /** The integer specifications that occur explicitly in the source layout. */
  readonly integers: ReadonlyArray<PrimitiveSpec>
  /** The effective LLVM integer specifications after explicit same-width overrides. */
  readonly effectiveIntegers: ReadonlyArray<PrimitiveSpec>
  readonly floats: ReadonlyArray<PrimitiveSpec>
  readonly vectors: ReadonlyArray<PrimitiveSpec>
  readonly pointers: ReadonlyArray<PointerSpec>
  readonly aggregate: AggregateSpec
  readonly nativeIntegerWidths: ReadonlyArray<number>
  readonly stackAlignment: Alignment.Alignment
  readonly nonIntegralAddressSpaces: ReadonlyArray<AddrSpace.AddrSpace>
  readonly mangling: string | undefined
  readonly programAddressSpace: AddrSpace.AddrSpace
  readonly globalAddressSpace: AddrSpace.AddrSpace
  readonly allocaAddressSpace: AddrSpace.AddrSpace
  readonly functionPointerAlignment: string | undefined
}

/** @internal */
const oneByteAlignment: Alignment.Alignment = {
  _tag: 'Alignment',
  byteUnits: 1n,
}

/** @internal */
const defaultAggregateSpec: AggregateSpec = {
  abiAlignment: oneByteAlignment,
  preferredAlignment: { _tag: 'Alignment', byteUnits: 8n },
}

/** @internal */
const fixedPrimitiveSpec = (
  bitWidth: number,
  abiByteUnits: bigint,
  preferredByteUnits: bigint,
): PrimitiveSpec => ({
  bitWidth,
  abiAlignment: { _tag: 'Alignment', byteUnits: abiByteUnits },
  preferredAlignment: {
    _tag: 'Alignment',
    byteUnits: preferredByteUnits,
  },
})

/** @internal */
const defaultLargestIntegerSpec = fixedPrimitiveSpec(64, 4n, 8n)

/** @internal */
const defaultIntegerSpecs: ReadonlyArray<PrimitiveSpec> = [
  fixedPrimitiveSpec(8, 1n, 1n),
  fixedPrimitiveSpec(16, 2n, 2n),
  fixedPrimitiveSpec(32, 4n, 4n),
  defaultLargestIntegerSpec,
]

/** @internal */
class DataLayoutParseFailure extends Data.TaggedError('DataLayoutParseFailure')<{
  readonly message: string
  readonly input: unknown
}> {
  constructor(message: string, input: unknown) {
    super({ message, input })
  }
}

/** @internal */
const reject = (message: string, input: unknown): never => {
  throw new DataLayoutParseFailure(message, input)
}

/**
 * A data layout with no target-specific rules.
 *
 * @category data layouts
 * @since 0.0.0
 */
export const empty: DataLayout = {
  _tag: 'DataLayout',
  original: ByteString.empty,
  endian: undefined,
  integers: [],
  effectiveIntegers: defaultIntegerSpecs,
  floats: [],
  vectors: [],
  pointers: [],
  aggregate: defaultAggregateSpec,
  nativeIntegerWidths: [],
  stackAlignment: Alignment.defaultAlignment,
  nonIntegralAddressSpaces: [],
  mangling: undefined,
  programAddressSpace: AddrSpace.defaultAddrSpace,
  globalAddressSpace: AddrSpace.defaultAddrSpace,
  allocaAddressSpace: AddrSpace.defaultAddrSpace,
  functionPointerAlignment: undefined,
}

/** @internal */
const ascii = (value: ByteString.ByteString): string => {
  let output = ''
  for (const byte of value.bytes) {
    if (byte > 0x7f) reject('data layouts must contain ASCII bytes', value)
    output += String.fromCharCode(byte)
  }
  return output
}

/** @internal */
const natural = (value: string, component: string): number => {
  if (!/^\d+$/.test(value))
    reject(`invalid number in data-layout component ${component}`, component)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) reject(`number is too large in ${component}`, component)
  return parsed
}

/** @internal */
const addressSpace = (value: string, component: string): AddrSpace.AddrSpace => {
  const parsed = natural(value, component)
  if (parsed > 0xff_ffff) reject(`address space is too large in ${component}`, component)
  return { _tag: 'AddrSpace', value: parsed }
}

/** @internal */
const alignmentFromBits = (bits: number, component: string): Alignment.Alignment => {
  if (bits < 8 || bits % 8 !== 0) reject(`invalid bit alignment in ${component}`, component)
  const bytes = BigInt(bits / 8)
  if ((bytes & (bytes - 1n)) !== 0n)
    reject(`alignment is not a power of two in ${component}`, component)
  return { _tag: 'Alignment', byteUnits: bytes }
}

/** @internal */
const bitAlignment = (value: string, component: string): Alignment.Alignment =>
  alignmentFromBits(natural(value, component), component)

/** @internal */
const aggregateBitAlignment = (
  value: string,
  component: string,
  field: 'ABI' | 'preferred',
): Alignment.Alignment => {
  const bits = natural(value, component)
  if (bits > 0xffff)
    reject(`${field} alignment must be a 16-bit integer in ${component}`, component)
  return field === 'ABI' && bits === 0 ? oneByteAlignment : alignmentFromBits(bits, component)
}

/** @internal */
const primitive = (component: string): PrimitiveSpec => {
  const values = component.slice(1).split(':')
  if (values.length < 2 || values.length > 3) reject(`malformed ${component}`, component)
  const bitWidth = natural(values[0] ?? '', component)
  const abiAlignment = bitAlignment(values[1] ?? '', component)
  const preferredAlignment = bitAlignment(values[2] ?? values[1] ?? '', component)
  return { bitWidth, abiAlignment, preferredAlignment }
}

/** @internal */
const aggregate = (component: string): AggregateSpec => {
  const values = component.slice(2).split(':')
  if (values.length < 1 || values.length > 2) reject(`malformed ${component}`, component)
  const abiAlignment = aggregateBitAlignment(values[0] ?? '', component, 'ABI')
  const preferredAlignment =
    values[1] === undefined
      ? abiAlignment
      : aggregateBitAlignment(values[1], component, 'preferred')
  if (Alignment.compare(preferredAlignment, abiAlignment) < 0) {
    reject(`preferred alignment is below ABI alignment in ${component}`, component)
  }
  return { abiAlignment, preferredAlignment }
}

/** @internal */
const pointer = (component: string): PointerSpec => {
  const values = component.slice(1).split(':')
  if (values.length < 3 || values.length > 5) reject(`malformed ${component}`, component)
  const address =
    values[0] === '' ? AddrSpace.defaultAddrSpace : addressSpace(values[0] ?? '', component)
  const bitWidth = natural(values[1] ?? '', component)
  const abiAlignment = bitAlignment(values[2] ?? '', component)
  const preferredAlignment = bitAlignment(values[3] ?? values[2] ?? '', component)
  const indexBitWidth = natural(values[4] ?? values[1] ?? '', component)
  return {
    addressSpace: address,
    bitWidth,
    abiAlignment,
    preferredAlignment,
    indexBitWidth,
  }
}

/** @internal */
const sorted = <A>(values: Iterable<A>, key: (value: A) => number): ReadonlyArray<A> =>
  [...values].sort((left, right) => key(left) - key(right))

/** @internal */
const effectiveIntegerSpecs = (
  explicit: ReadonlyArray<PrimitiveSpec>,
): ReadonlyArray<PrimitiveSpec> => {
  const byWidth = new Map(defaultIntegerSpecs.map((spec) => [spec.bitWidth, spec]))
  for (const spec of explicit) byWidth.set(spec.bitWidth, spec)
  return sorted(byWidth.values(), (spec) => spec.bitWidth)
}

/** @internal */
const parseUnsafe = (original: ByteString.ByteString): DataLayout => {
  if (ByteString.isEmpty(original)) return empty
  let endian: DataLayout['endian']
  let mangling: string | undefined
  let stackAlignment = Alignment.defaultAlignment
  let programAddressSpace = AddrSpace.defaultAddrSpace
  let globalAddressSpace = AddrSpace.defaultAddrSpace
  let allocaAddressSpace = AddrSpace.defaultAddrSpace
  let functionPointerAlignment: string | undefined
  let aggregateSpec = empty.aggregate
  const integers = new Map<number, PrimitiveSpec>()
  const floats = new Map<number, PrimitiveSpec>()
  const vectors = new Map<number, PrimitiveSpec>()
  const pointers = new Map<number, PointerSpec>()
  const nativeIntegerWidths: Array<number> = []
  const nonIntegralAddressSpaces: Array<AddrSpace.AddrSpace> = []

  for (const component of ascii(original).split('-')) {
    if (component === 'e' || component === 'E') {
      endian = component === 'e' ? 'little' : 'big'
    } else if (/^i\d+:/.test(component)) {
      const spec = primitive(component)
      integers.set(spec.bitWidth, spec)
    } else if (/^f\d+:/.test(component)) {
      const spec = primitive(component)
      floats.set(spec.bitWidth, spec)
    } else if (/^v\d+:/.test(component)) {
      const spec = primitive(component)
      vectors.set(spec.bitWidth, spec)
    } else if (/^p\d*:/.test(component)) {
      const spec = pointer(component)
      pointers.set(spec.addressSpace.value, spec)
    } else if (/^n\d+(?::\d+)*$/.test(component)) {
      nativeIntegerWidths.push(
        ...component
          .slice(1)
          .split(':')
          .map((value) => natural(value, component)),
      )
    } else if (/^S\d+$/.test(component)) {
      stackAlignment = bitAlignment(component.slice(1), component)
    } else if (/^ni:\d+(?::\d+)*$/.test(component)) {
      nonIntegralAddressSpaces.push(
        ...component
          .slice(3)
          .split(':')
          .map((value) => addressSpace(value, component)),
      )
    } else if (/^m:[A-Za-z]$/.test(component)) {
      mangling = component.slice(2)
    } else if (/^P\d+$/.test(component)) {
      programAddressSpace = addressSpace(component.slice(1), component)
    } else if (/^G\d+$/.test(component)) {
      globalAddressSpace = addressSpace(component.slice(1), component)
    } else if (/^A\d+$/.test(component)) {
      allocaAddressSpace = addressSpace(component.slice(1), component)
    } else if (/^F[ni]\d+$/.test(component)) {
      functionPointerAlignment = component
    } else if (/^a:\d+(?::\d+)?$/.test(component)) {
      aggregateSpec = aggregate(component)
    } else {
      reject(`unsupported data-layout component ${component}`, component)
    }
  }

  const integerEntries = sorted(integers.values(), (value) => value.bitWidth)
  return {
    _tag: 'DataLayout',
    original,
    endian,
    integers: integerEntries,
    effectiveIntegers: effectiveIntegerSpecs(integerEntries),
    floats: sorted(floats.values(), (value) => value.bitWidth),
    vectors: sorted(vectors.values(), (value) => value.bitWidth),
    pointers: sorted(pointers.values(), (value) => value.addressSpace.value),
    aggregate: aggregateSpec,
    nativeIntegerWidths: [...nativeIntegerWidths].sort((left, right) => left - right),
    stackAlignment,
    nonIntegralAddressSpaces: sorted(nonIntegralAddressSpaces, (value) => value.value),
    mangling,
    programAddressSpace,
    globalAddressSpace,
    allocaAddressSpace,
    functionPointerAlignment,
  }
}

/**
 * Parses the LLVM data-layout subset used by builder layout queries and preserves the original bytes.
 *
 * **Details**
 *
 * Entries are sorted for deterministic lookup. Input may be byte-exact ASCII or a JavaScript
 * string convenience value. Aggregate rules default to `a:0:64`, omitted preferred alignment
 * inherits the ABI alignment, and the final aggregate rule wins when rules repeat.
 *
 * **Gotchas**
 *
 * Unsupported or malformed components fail with {@link LlvmError} instead of being ignored,
 * preventing target-dependent silent guesses.
 *
 * **Example** (Parsing a target layout)
 *
 * ```ts
 * import * as Effect from 'effect/Effect'
 * import * as DataLayout from '@silklang/llvm/DataLayout'
 *
 * const width = await Effect.runPromise(
 *   Effect.gen(function* () {
 *     const layout = yield* DataLayout.parse('e-p:64:64-i32:32')
 *     return DataLayout.pointerSpec(layout)?.bitWidth
 *   }),
 * )
 * // width === 64
 * ```
 *
 * @category data layouts
 * @since 0.0.0
 */
export const parse = Effect.fnUntraced(function* (
  input: ByteString.ByteString | Uint8Array | string,
): Effect.fn.Return<DataLayout, LlvmError> {
  const original = ByteString.coerce(input)
  return yield* Effect.try({
    try: () => parseUnsafe(original),
    catch: (cause) =>
      cause instanceof DataLayoutParseFailure
        ? invalidInput({
            operation: 'DataLayout.parse',
            message: cause.message,
            input: cause.input,
          })
        : wrappedFailure({
            operation: 'DataLayout.parse',
            message: 'LLVM data-layout parsing failed unexpectedly',
            cause,
          }),
  })
})

/**
 * Returns the source layout's exact integer-width rule, or `undefined` if the rule is absent.
 *
 * @category data layouts
 * @since 0.0.0
 */
export const integerSpec = (self: DataLayout, bitWidth: number): PrimitiveSpec | undefined =>
  self.integers.find((spec) => spec.bitWidth === bitWidth)

/**
 * Returns LLVM's effective integer-width rule after it applies defaults and explicit overrides.
 *
 * **Details**
 *
 * Exact widths win. Otherwise the smallest larger width is selected, or the largest width when no
 * larger rule exists.
 *
 * @category data layouts
 * @since 0.0.0
 */
export const effectiveIntegerSpec = (self: DataLayout, bitWidth: number): PrimitiveSpec =>
  self.effectiveIntegers.find((spec) => spec.bitWidth >= bitWidth) ??
  self.effectiveIntegers.at(-1) ??
  defaultLargestIntegerSpec

/**
 * Finds the exact floating-point-width rule, without synthesizing a fallback.
 *
 * @category data layouts
 * @since 0.0.0
 */
export const floatSpec = (self: DataLayout, bitWidth: number): PrimitiveSpec | undefined =>
  self.floats.find((spec) => spec.bitWidth === bitWidth)

/**
 * Finds the exact vector-width rule, without synthesizing a fallback.
 *
 * @category data layouts
 * @since 0.0.0
 */
export const vectorSpec = (self: DataLayout, bitWidth: number): PrimitiveSpec | undefined =>
  self.vectors.find((spec) => spec.bitWidth === bitWidth)

/**
 * Finds a pointer rule for an address space, falling back to address space zero when present.
 *
 * @category data layouts
 * @since 0.0.0
 */
export const pointerSpec = (
  self: DataLayout,
  address: AddrSpace.AddrSpace = AddrSpace.defaultAddrSpace,
): PointerSpec | undefined =>
  self.pointers.find((spec) => spec.addressSpace.value === address.value) ??
  self.pointers.find((spec) => spec.addressSpace.value === 0)

/**
 * Returns the original, byte-exact data-layout spelling.
 *
 * @category data layouts
 * @since 0.0.0
 */
export const render = (self: DataLayout): ByteString.ByteString => self.original
