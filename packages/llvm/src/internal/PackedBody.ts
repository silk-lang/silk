import type * as FunctionBodyDescription from './FunctionBodyDescription.js'

/**
 * A committed function body packed into one byte buffer.
 *
 * A module keeps every committed body until it is encoded, and as plain objects those bodies
 * dominated the retained heap of large compilations (one object per instruction, value, operand,
 * name and block). Packing keeps each body as bytes; readers unpack one body at a time.
 *
 * @internal
 */
export interface PackedBody {
  readonly _tag: 'PackedBody'
  readonly bytes: Uint8Array
  readonly blockCount: number
  /** Whether any call or invoke carries an operand bundle. */
  readonly hasOperandBundles: boolean
  /**
   * Metadata referenced by attachments, then by debug locations, in instruction order without
   * repeats: exactly the roots metadata reachability visits for this body.
   */
  readonly metadataRoots: Int32Array
}

// The packed form is a generic structural encoding of the snapshot's plain data, so it cannot drift
// from the description types. Strings and object shapes are defined inline on first use and
// referenced by ordinal afterwards; integers are unsigned LEB128.
const Undefined = 0
const False = 1
const True = 2
const Natural = 3
const Negative = 4
const Double = 5
const NewString = 6
const StringRef = 7
const BigIntValue = 8
const ArrayValue = 9
const NewShape = 10
const ShapeRef = 11
const Bytes = 12

const sameKeys = (left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean => {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1)
    if (left[index] !== right[index]) return false
  return true
}

class Writer {
  bytes = new Uint8Array(1024)
  length = 0
  readonly strings = new Map<string, number>()
  // Shapes by their `_tag`; a tag usually has one shape, so matching compares a few interned keys.
  readonly shapes = new Map<
    unknown,
    Array<{ readonly keys: ReadonlyArray<string>; readonly id: number }>
  >()
  shapeCount = 0
  readonly float = new DataView(new ArrayBuffer(8))

  reserve(count: number): void {
    if (this.length + count <= this.bytes.length) return
    let capacity = this.bytes.length * 2
    while (capacity < this.length + count) capacity *= 2
    const grown = new Uint8Array(capacity)
    grown.set(this.bytes.subarray(0, this.length))
    this.bytes = grown
  }

  byte(value: number): void {
    this.reserve(1)
    this.bytes[this.length++] = value
  }

  natural(value: number): void {
    this.reserve(8)
    let rest = value
    while (rest >= 0x80) {
      this.bytes[this.length++] = (rest % 0x80) | 0x80
      rest = Math.floor(rest / 0x80)
    }
    this.bytes[this.length++] = rest
  }

  string(value: string): void {
    const known = this.strings.get(value)
    if (known !== undefined) {
      this.byte(StringRef)
      this.natural(known)
      return
    }
    this.strings.set(value, this.strings.size)
    this.byte(NewString)
    this.natural(value.length)
    for (let index = 0; index < value.length; index += 1) this.natural(value.charCodeAt(index))
  }

  value(value: unknown): void {
    switch (typeof value) {
      case 'undefined':
        return this.byte(Undefined)
      case 'boolean':
        return this.byte(value ? True : False)
      case 'string':
        return this.string(value)
      case 'bigint':
        this.byte(BigIntValue)
        return this.string(value.toString())
      case 'number':
        if (Number.isSafeInteger(value) && !Object.is(value, -0)) {
          this.byte(value >= 0 ? Natural : Negative)
          return this.natural(Math.abs(value))
        }
        this.byte(Double)
        this.float.setFloat64(0, value)
        this.reserve(8)
        for (let index = 0; index < 8; index += 1)
          this.bytes[this.length++] = this.float.getUint8(index)
        return
      case 'object':
        if (value === null) break
        if (Array.isArray(value)) {
          this.byte(ArrayValue)
          this.natural(value.length)
          for (const item of value) this.value(item)
          return
        }
        return this.record(value)
      default:
        break
    }
    throw new TypeError(`PackedBody cannot pack ${String(value)}`)
  }

  record(value: object): void {
    const fields = value as Readonly<Record<string, unknown>>
    const keys = Object.keys(value)
    // Byte strings (byte-exact local names, bundle tags) store their bytes raw.
    if (
      keys.length === 2 &&
      keys[0] === '_tag' &&
      keys[1] === 'bytes' &&
      fields['_tag'] === 'ByteString' &&
      fields['bytes'] instanceof Uint8Array
    ) {
      const bytes = fields['bytes']
      this.byte(Bytes)
      this.natural(bytes.length)
      this.reserve(bytes.length)
      this.bytes.set(bytes, this.length)
      this.length += bytes.length
      return
    }
    const discriminator = fields['_tag']
    let candidates = this.shapes.get(discriminator)
    if (candidates === undefined) {
      candidates = []
      this.shapes.set(discriminator, candidates)
    }
    let known: { readonly keys: ReadonlyArray<string>; readonly id: number } | undefined
    for (const shape of candidates)
      if (sameKeys(shape.keys, keys)) {
        known = shape
        break
      }
    if (known === undefined) {
      candidates.push({ keys, id: this.shapeCount++ })
      this.byte(NewShape)
      this.natural(keys.length)
      for (const key of keys) this.string(key)
    } else {
      this.byte(ShapeRef)
      this.natural(known.id)
    }
    for (const key of keys) this.value(fields[key])
  }
}

class Reader {
  offset = 0
  readonly strings: Array<string> = []
  readonly shapes: Array<ReadonlyArray<string>> = []
  readonly float = new DataView(new ArrayBuffer(8))

  constructor(readonly bytes: Uint8Array) {}

  natural(): number {
    let result = 0
    let scale = 1
    for (;;) {
      const byte = this.bytes[this.offset++] ?? 0
      result += (byte & 0x7f) * scale
      if (byte < 0x80) return result
      scale *= 0x80
    }
  }

  string(): string {
    const tag = this.bytes[this.offset++]
    if (tag === StringRef) return this.strings[this.natural()] ?? ''
    const length = this.natural()
    let value = ''
    for (let index = 0; index < length; index += 1) value += String.fromCharCode(this.natural())
    this.strings.push(value)
    return value
  }

  value(): unknown {
    const tag = this.bytes[this.offset++]
    switch (tag) {
      case Undefined:
        return undefined
      case False:
        return false
      case True:
        return true
      case Natural:
        return this.natural()
      case Negative:
        return -this.natural()
      case Double:
        for (let index = 0; index < 8; index += 1)
          this.float.setUint8(index, this.bytes[this.offset++] ?? 0)
        return this.float.getFloat64(0)
      case NewString:
      case StringRef:
        this.offset -= 1
        return this.string()
      case BigIntValue:
        return BigInt(this.string())
      case ArrayValue: {
        const length = this.natural()
        const items: Array<unknown> = []
        for (let index = 0; index < length; index += 1) items.push(this.value())
        return items
      }
      case Bytes: {
        const length = this.natural()
        const bytes = this.bytes.slice(this.offset, this.offset + length)
        this.offset += length
        return { _tag: 'ByteString', bytes }
      }
      case NewShape: {
        const count = this.natural()
        const keys: Array<string> = []
        for (let index = 0; index < count; index += 1) keys.push(this.string())
        this.shapes.push(keys)
        return this.record(keys)
      }
      case ShapeRef:
        return this.record(this.shapes[this.natural()] ?? [])
      default:
        throw new TypeError(`PackedBody found an unknown tag ${String(tag)}`)
    }
  }

  record(keys: ReadonlyArray<string>): object {
    const result: Record<string, unknown> = {}
    for (const key of keys) result[key] = this.value()
    return result
  }
}

const metadataRoots = (snapshot: FunctionBodyDescription.Snapshot): Int32Array => {
  const roots = new Set<number>()
  for (const attachments of snapshot.metadata)
    for (const attachment of attachments) roots.add(attachment.metadata)
  for (const location of snapshot.debugLocations) if (location !== undefined) roots.add(location)
  return Int32Array.from(roots)
}

/** Packs one validated body snapshot. @internal */
export const pack = (snapshot: FunctionBodyDescription.Snapshot): PackedBody => {
  const writer = new Writer()
  writer.value(snapshot)
  return {
    _tag: 'PackedBody',
    bytes: writer.bytes.slice(0, writer.length),
    blockCount: snapshot.blocks.length,
    hasOperandBundles: snapshot.instructions.some(
      (instruction) =>
        (instruction._tag === 'Call' || instruction._tag === 'Invoke') &&
        instruction.operandBundles.length > 0,
    ),
    metadataRoots: metadataRoots(snapshot),
  }
}

/**
 * Restores the snapshot a body was packed from. Every call returns fresh objects, so callers
 * unpack a body where they use it rather than retaining the result.
 *
 * @internal
 */
export const unpack = (self: PackedBody): FunctionBodyDescription.Snapshot =>
  // The packed bytes are only ever produced by `pack` from a Snapshot.
  new Reader(self.bytes).value() as FunctionBodyDescription.Snapshot
