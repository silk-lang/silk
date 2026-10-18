import type * as Alignment from '../Alignment.js'
import type * as ByteString from '../ByteString.js'
import type * as MemoryAccess from '../MemoryAccess.js'
import type * as FunctionBodyDescription from './FunctionBodyDescription.js'
import type * as LocalName from './LocalName.js'
import type * as MetadataDescription from './MetadataDescription.js'

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

// The packed form is a dedicated encoding of the snapshot description: integers are unsigned
// LEB128, string unions are ordinals into the tables below, boolean groups are bit sets, and string
// local names are UTF-8, the only spelling their readers observe. Every committed body is packed once and unpacked by each reader, so
// both directions sit on the hot path of large compilations; reconstructing records through fixed
// object literals keeps them monomorphic for the bitcode encoder and verifier.

interface Enumeration<A extends string> {
  readonly values: ReadonlyArray<A>
  readonly ordinals: ReadonlyMap<string, number>
}

const enumeration = <const A extends string>(values: ReadonlyArray<A>): Enumeration<A> => ({
  values,
  ordinals: new Map(values.map((value, ordinal) => [value, ordinal])),
})

const binaryKinds = enumeration<FunctionBodyDescription.BinaryKind>([
  'add',
  'sub',
  'mul',
  'udiv',
  'sdiv',
  'urem',
  'srem',
  'shl',
  'lshr',
  'ashr',
  'and',
  'or',
  'xor',
  'fadd',
  'fsub',
  'fmul',
  'fdiv',
  'frem',
])
const integerPredicates = enumeration<FunctionBodyDescription.IntegerPredicate>([
  'eq',
  'ne',
  'ugt',
  'uge',
  'ult',
  'ule',
  'sgt',
  'sge',
  'slt',
  'sle',
])
const floatingPredicates = enumeration<FunctionBodyDescription.FloatingPredicate>([
  'false',
  'oeq',
  'ogt',
  'oge',
  'olt',
  'ole',
  'one',
  'ord',
  'ueq',
  'ugt',
  'uge',
  'ult',
  'ule',
  'une',
  'uno',
  'true',
])
const castKinds = enumeration<FunctionBodyDescription.CastKind>([
  'trunc',
  'zext',
  'sext',
  'fptoui',
  'fptosi',
  'uitofp',
  'sitofp',
  'fptrunc',
  'fpext',
  'ptrtoint',
  'inttoptr',
  'bitcast',
  'addrspacecast',
])
const tailKinds = enumeration<FunctionBodyDescription.TailKind>([
  'none',
  'tail',
  'musttail',
  'notail',
])
const memoryKinds = enumeration<MemoryAccess.Kind>(['normal', 'volatile'])
const syncScopes = enumeration<MemoryAccess.SyncScope>(['singlethread', 'system'])
const atomicOrderings = enumeration<MemoryAccess.AtomicOrdering>([
  'none',
  'unordered',
  'monotonic',
  'acquire',
  'release',
  'acq_rel',
  'seq_cst',
])
const atomicOperations = enumeration<MemoryAccess.AtomicOperation>([
  'xchg',
  'add',
  'sub',
  'and',
  'nand',
  'or',
  'xor',
  'max',
  'min',
  'umax',
  'umin',
  'fadd',
  'fsub',
  'fmax',
  'fmin',
])
const branchWeights = enumeration<
  Extract<FunctionBodyDescription.Instruction, { readonly _tag: 'ConditionalBranch' }>['weights']
>(['none', 'unpredictable', 'true-likely', 'false-likely'])
const attachmentKinds = enumeration<MetadataDescription.Attachment['kind']>([
  'dbg',
  'prof',
  'unpredictable',
])

// Instruction opcodes; `Compare` takes two, one per predicate family.
const Unary = 0
const Binary = 1
const IntegerCompare = 2
const FloatingCompare = 3
const Select = 4
const Cast = 5
const Freeze = 6
const ExtractValue = 7
const InsertValue = 8
const Alloca = 9
const Load = 10
const Store = 11
const GetElementPtr = 12
const ExtractElement = 13
const InsertElement = 14
const ShuffleVector = 15
const Fence = 16
const CompareExchange = 17
const AtomicRmw = 18
const VaArg = 19
const IndirectBranch = 20
const Branch = 21
const ConditionalBranch = 22
const Switch = 23
const Return = 24
const ReturnVoid = 25
const Unreachable = 26
const Phi = 27
const Call = 28
const LandingPad = 29
const Invoke = 30

// Local name spellings.
const EmptyName = 0
const TextName = 1
const Bytes = 2

const utf8Encoder = new TextEncoder()
// A leading U+FEFF is part of the name, not a byte-order mark.
const utf8Decoder = new TextDecoder('utf-8', { ignoreBOM: true })

// Value sources.
const ArgumentSource = 0
const InstructionSource = 1
const ForwardSource = 2

const fastMathOf = (set: number): FunctionBodyDescription.FastMath => ({
  allowReassociation: (set & 1) !== 0,
  noNaNs: (set & 2) !== 0,
  noInfinities: (set & 4) !== 0,
  noSignedZeros: (set & 8) !== 0,
  allowReciprocal: (set & 16) !== 0,
  allowContract: (set & 32) !== 0,
  approximateFunctions: (set & 64) !== 0,
})

const integerFlagsOf = (set: number): FunctionBodyDescription.IntegerFlags => ({
  noSignedWrap: (set & 1) !== 0,
  noUnsignedWrap: (set & 2) !== 0,
  exact: (set & 4) !== 0,
})

// Decoded leaf records are immutable and shared, so a body allocates none per instruction.
const fastMathBySet = Array.from({ length: 128 }, (_, set) => fastMathOf(set))
const integerFlagsBySet = Array.from({ length: 8 }, (_, set) => integerFlagsOf(set))

const defaultAlignment: Alignment.Alignment = { _tag: 'Alignment', byteUnits: undefined }

// Alignments are powers of two, so the packed form is the exponent and decoded alignments are
// shared per exponent.
const alignmentExponent = (byteUnits: bigint): number => {
  let exponent = 0
  for (let rest = byteUnits; rest > 1n; rest >>= 1n) exponent += 1
  return exponent
}
const alignments: Array<Alignment.Alignment | undefined> = []
const alignmentOf = (exponent: number): Alignment.Alignment => {
  let alignment = alignments[exponent]
  if (alignment === undefined) {
    alignment = { _tag: 'Alignment', byteUnits: 1n << BigInt(exponent) }
    alignments[exponent] = alignment
  }
  return alignment
}

const noAttachments: ReadonlyArray<MetadataDescription.Attachment> = []

const unknown = (what: string, value: unknown): TypeError =>
  new TypeError(`PackedBody cannot pack ${what} ${String(value)}`)

class Writer {
  bytes = new Uint8Array(1024)
  length = 0

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
    if (!Number.isSafeInteger(value) || value < 0) throw unknown('natural', value)
    this.reserve(8)
    let rest = value
    while (rest >= 0x80) {
      this.bytes[this.length++] = (rest % 0x80) | 0x80
      rest = Math.floor(rest / 0x80)
    }
    this.bytes[this.length++] = rest
  }

  /** An optional natural: zero is absent. */
  optional(value: number | undefined): void {
    this.natural(value === undefined ? 0 : value + 1)
  }

  ordinal<A extends string>(table: Enumeration<A>, value: A): void {
    const ordinal = table.ordinals.get(value)
    if (ordinal === undefined) throw unknown('enumeration value', value)
    this.byte(ordinal)
  }

  naturals(values: ReadonlyArray<number>): void {
    this.natural(values.length)
    for (const value of values) this.natural(value)
  }

  rawBytes(value: ByteString.ByteString): void {
    this.natural(value.bytes.length)
    this.reserve(value.bytes.length)
    for (let index = 0; index < value.bytes.length; index += 1)
      this.bytes[this.length++] = value.bytes[index] ?? 0
  }

  name(value: LocalName.LocalName): void {
    if (typeof value !== 'string') {
      this.byte(Bytes)
      return this.rawBytes(value)
    }
    if (value.length === 0) return this.byte(EmptyName)
    this.byte(TextName)
    // Encode in place past the widest length prefix, then slide the bytes after the real prefix.
    // The reservation covers the prefix too, so writing it never reallocates.
    const start = this.length
    const gap = 8
    this.reserve(gap + value.length * 3)
    const { written } = utf8Encoder.encodeInto(value, this.bytes.subarray(start + gap))
    this.natural(written)
    this.bytes.copyWithin(this.length, start + gap, start + gap + written)
    this.length += written
  }

  /** Locals and constants share one natural: the low bit selects the table. */
  operand(value: FunctionBodyDescription.Operand): void {
    this.natural(value._tag === 'Local' ? value.value * 2 : value.constant * 2 + 1)
  }

  operands(values: ReadonlyArray<FunctionBodyDescription.Operand>): void {
    this.natural(values.length)
    for (const value of values) this.operand(value)
  }

  fastMath(value: FunctionBodyDescription.FastMath): void {
    this.byte(
      (value.allowReassociation ? 1 : 0) |
        (value.noNaNs ? 2 : 0) |
        (value.noInfinities ? 4 : 0) |
        (value.noSignedZeros ? 8 : 0) |
        (value.allowReciprocal ? 16 : 0) |
        (value.allowContract ? 32 : 0) |
        (value.approximateFunctions ? 64 : 0),
    )
  }

  alignment(value: Alignment.Alignment): void {
    this.optional(value.byteUnits === undefined ? undefined : alignmentExponent(value.byteUnits))
  }

  access(value: FunctionBodyDescription.MemoryInfo): void {
    this.ordinal(memoryKinds, value.kind)
    this.alignment(value.alignment)
    this.ordinal(syncScopes, value.syncScope)
    this.ordinal(atomicOrderings, value.ordering)
  }

  bundles(values: ReadonlyArray<FunctionBodyDescription.OperandBundle>): void {
    this.natural(values.length)
    for (const bundle of values) {
      this.rawBytes(bundle.tag)
      this.operands(bundle.operands)
    }
  }

  instruction(value: FunctionBodyDescription.Instruction): void {
    switch (value._tag) {
      case 'Unary':
        this.byte(Unary)
        this.natural(value.result)
        this.operand(value.operand)
        return this.fastMath(value.fastMath)
      case 'Binary':
        this.byte(Binary)
        this.natural(value.result)
        this.ordinal(binaryKinds, value.kind)
        this.operand(value.left)
        this.operand(value.right)
        this.byte(
          (value.integerFlags.noSignedWrap ? 1 : 0) |
            (value.integerFlags.noUnsignedWrap ? 2 : 0) |
            (value.integerFlags.exact ? 4 : 0),
        )
        return this.fastMath(value.fastMath)
      case 'Compare':
        if (value.kind === 'integer') {
          this.byte(IntegerCompare)
          this.natural(value.result)
          this.ordinal(integerPredicates, value.predicate)
        } else {
          this.byte(FloatingCompare)
          this.natural(value.result)
          this.ordinal(floatingPredicates, value.predicate)
        }
        this.operand(value.left)
        this.operand(value.right)
        return this.fastMath(value.fastMath)
      case 'Select':
        this.byte(Select)
        this.natural(value.result)
        this.operand(value.condition)
        this.operand(value.onTrue)
        this.operand(value.onFalse)
        return this.fastMath(value.fastMath)
      case 'Cast':
        this.byte(Cast)
        this.natural(value.result)
        this.ordinal(castKinds, value.kind)
        this.operand(value.operand)
        this.natural(value.destinationType)
        return this.byte((value.noSignedWrap ? 1 : 0) | (value.noUnsignedWrap ? 2 : 0))
      case 'Freeze':
        this.byte(Freeze)
        this.natural(value.result)
        return this.operand(value.operand)
      case 'ExtractValue':
        this.byte(ExtractValue)
        this.natural(value.result)
        this.operand(value.aggregate)
        return this.naturals(value.indices)
      case 'InsertValue':
        this.byte(InsertValue)
        this.natural(value.result)
        this.operand(value.aggregate)
        this.operand(value.element)
        return this.naturals(value.indices)
      case 'Alloca':
        this.byte(Alloca)
        this.natural(value.result)
        this.natural(value.allocationType)
        this.operand(value.count)
        this.natural(value.addressSpace)
        this.alignment(value.alignment)
        return this.byte(value.inAlloca ? 1 : 0)
      case 'Load':
        this.byte(Load)
        this.natural(value.result)
        this.natural(value.valueType)
        this.operand(value.pointer)
        return this.access(value.access)
      case 'Store':
        this.byte(Store)
        this.operand(value.value)
        this.operand(value.pointer)
        return this.access(value.access)
      case 'GetElementPtr':
        this.byte(GetElementPtr)
        this.natural(value.result)
        this.natural(value.sourceType)
        this.operand(value.base)
        this.operands(value.indices)
        this.byte(value.inbounds ? 1 : 0)
        return this.optional(value.inrange)
      case 'ExtractElement':
        this.byte(ExtractElement)
        this.natural(value.result)
        this.operand(value.vector)
        return this.operand(value.index)
      case 'InsertElement':
        this.byte(InsertElement)
        this.natural(value.result)
        this.operand(value.vector)
        this.operand(value.element)
        return this.operand(value.index)
      case 'ShuffleVector':
        this.byte(ShuffleVector)
        this.natural(value.result)
        this.operand(value.left)
        this.operand(value.right)
        return this.operand(value.mask)
      case 'Fence':
        this.byte(Fence)
        this.ordinal(syncScopes, value.syncScope)
        return this.ordinal(atomicOrderings, value.ordering)
      case 'CompareExchange':
        this.byte(CompareExchange)
        this.natural(value.result)
        this.operand(value.pointer)
        this.operand(value.comparison)
        this.operand(value.replacement)
        this.access(value.access)
        this.ordinal(atomicOrderings, value.failureOrdering)
        return this.byte(value.weak ? 1 : 0)
      case 'AtomicRmw':
        this.byte(AtomicRmw)
        this.natural(value.result)
        this.ordinal(atomicOperations, value.operation)
        this.operand(value.pointer)
        this.operand(value.value)
        return this.access(value.access)
      case 'VaArg':
        this.byte(VaArg)
        this.natural(value.result)
        this.operand(value.list)
        return this.natural(value.valueType)
      case 'IndirectBranch':
        this.byte(IndirectBranch)
        this.operand(value.address)
        return this.naturals(value.destinations)
      case 'Branch':
        this.byte(Branch)
        return this.natural(value.destination)
      case 'ConditionalBranch':
        this.byte(ConditionalBranch)
        this.operand(value.condition)
        this.natural(value.onTrue)
        this.natural(value.onFalse)
        return this.ordinal(branchWeights, value.weights)
      case 'Switch':
        this.byte(Switch)
        this.operand(value.value)
        this.natural(value.defaultBlock)
        this.natural(value.cases.length)
        for (const entry of value.cases) {
          this.natural(entry.value)
          this.natural(entry.block)
        }
        this.naturals(value.weights)
        return this.byte(value.sealed ? 1 : 0)
      case 'Return':
        this.byte(Return)
        return this.operand(value.value)
      case 'ReturnVoid':
        return this.byte(ReturnVoid)
      case 'Unreachable':
        return this.byte(Unreachable)
      case 'Phi':
        this.byte(Phi)
        this.natural(value.result)
        this.natural(value.type)
        this.natural(value.incoming.length)
        for (const entry of value.incoming) {
          this.operand(entry.value)
          this.natural(entry.block)
        }
        this.fastMath(value.fastMath)
        return this.byte(value.sealed ? 1 : 0)
      case 'Call':
        this.byte(Call)
        this.optional(value.result)
        this.natural(value.functionType)
        this.operand(value.callee)
        this.operands(value.arguments)
        this.natural(value.callingConvention)
        this.optional(value.attributes)
        this.ordinal(tailKinds, value.tail)
        this.fastMath(value.fastMath)
        return this.bundles(value.operandBundles)
      case 'LandingPad':
        this.byte(LandingPad)
        this.natural(value.result)
        return this.natural(value.type)
      case 'Invoke':
        this.byte(Invoke)
        this.optional(value.result)
        this.natural(value.functionType)
        this.operand(value.callee)
        this.operands(value.arguments)
        this.natural(value.callingConvention)
        this.optional(value.attributes)
        this.fastMath(value.fastMath)
        this.bundles(value.operandBundles)
        this.natural(value.normal)
        return this.natural(value.unwind)
      default: {
        const exhausted: never = value
        throw unknown('instruction', exhausted)
      }
    }
  }

  value(value: FunctionBodyDescription.Value): void {
    this.natural(value.type)
    this.name(value.name)
    const source = value.source
    switch (source._tag) {
      case 'Argument':
        this.byte(ArgumentSource)
        return this.natural(source.index)
      case 'Instruction':
        this.byte(InstructionSource)
        return this.natural(source.instruction)
      case 'Forward':
        this.byte(ForwardSource)
        if (source.resolved === undefined) return this.byte(0)
        this.byte(1)
        return this.operand(source.resolved)
    }
  }

  snapshot(value: FunctionBodyDescription.Snapshot): void {
    this.naturals(value.arguments)
    this.natural(value.blocks.length)
    for (const block of value.blocks) {
      this.name(block.name)
      this.naturals(block.instructions)
      this.naturals(block.predecessors)
    }
    this.natural(value.instructions.length)
    for (const instruction of value.instructions) this.instruction(instruction)
    this.natural(value.values.length)
    for (const entry of value.values) this.value(entry)
    this.natural(value.metadata.length)
    for (const attachments of value.metadata) {
      this.natural(attachments.length)
      for (const attachment of attachments) {
        this.ordinal(attachmentKinds, attachment.kind)
        this.natural(attachment.metadata)
      }
    }
    this.natural(value.debugLocations.length)
    for (const location of value.debugLocations) this.optional(location)
  }
}

class Reader {
  offset = 0

  constructor(readonly bytes: Uint8Array) {}

  byte(): number {
    return this.bytes[this.offset++] ?? 0
  }

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

  optional(): number | undefined {
    const value = this.natural()
    return value === 0 ? undefined : value - 1
  }

  ordinal<A extends string>(table: Enumeration<A>): A {
    const ordinal = this.byte()
    const value = table.values[ordinal]
    if (value === undefined) throw new TypeError(`PackedBody found an unknown ordinal ${ordinal}`)
    return value
  }

  flag(): boolean {
    return this.byte() !== 0
  }

  naturals(): Array<number> {
    const length = this.natural()
    const values: Array<number> = []
    for (let index = 0; index < length; index += 1) values.push(this.natural())
    return values
  }

  rawBytes(): ByteString.ByteString {
    const length = this.natural()
    const bytes = this.bytes.slice(this.offset, this.offset + length)
    this.offset += length
    return { _tag: 'ByteString', bytes }
  }

  name(): LocalName.LocalName {
    const tag = this.byte()
    if (tag === Bytes) return this.rawBytes()
    if (tag === EmptyName) return ''
    const length = this.natural()
    const value = utf8Decoder.decode(this.bytes.subarray(this.offset, this.offset + length))
    this.offset += length
    return value
  }

  operand(): FunctionBodyDescription.Operand {
    const encoded = this.natural()
    const index = Math.floor(encoded / 2)
    return encoded % 2 === 0
      ? { _tag: 'Local', value: index }
      : { _tag: 'Constant', constant: index }
  }

  operands(): Array<FunctionBodyDescription.Operand> {
    const length = this.natural()
    const values: Array<FunctionBodyDescription.Operand> = []
    for (let index = 0; index < length; index += 1) values.push(this.operand())
    return values
  }

  fastMath(): FunctionBodyDescription.FastMath {
    const set = this.byte()
    return fastMathBySet[set] ?? fastMathOf(set)
  }

  integerFlags(): FunctionBodyDescription.IntegerFlags {
    const set = this.byte()
    return integerFlagsBySet[set] ?? integerFlagsOf(set)
  }

  alignment(): Alignment.Alignment {
    const exponent = this.optional()
    return exponent === undefined ? defaultAlignment : alignmentOf(exponent)
  }

  access(): FunctionBodyDescription.MemoryInfo {
    return {
      kind: this.ordinal(memoryKinds),
      alignment: this.alignment(),
      syncScope: this.ordinal(syncScopes),
      ordering: this.ordinal(atomicOrderings),
    }
  }

  bundles(): Array<FunctionBodyDescription.OperandBundle> {
    const length = this.natural()
    const values: Array<FunctionBodyDescription.OperandBundle> = []
    for (let index = 0; index < length; index += 1)
      values.push({ tag: this.rawBytes(), operands: this.operands() })
    return values
  }

  instruction(): FunctionBodyDescription.Instruction {
    const opcode = this.byte()
    switch (opcode) {
      case Unary:
        return {
          _tag: 'Unary',
          result: this.natural(),
          kind: 'fneg',
          operand: this.operand(),
          fastMath: this.fastMath(),
        }
      case Binary:
        return {
          _tag: 'Binary',
          result: this.natural(),
          kind: this.ordinal(binaryKinds),
          left: this.operand(),
          right: this.operand(),
          integerFlags: this.integerFlags(),
          fastMath: this.fastMath(),
        }
      case IntegerCompare:
        return {
          _tag: 'Compare',
          result: this.natural(),
          kind: 'integer',
          predicate: this.ordinal(integerPredicates),
          left: this.operand(),
          right: this.operand(),
          fastMath: this.fastMath(),
        }
      case FloatingCompare:
        return {
          _tag: 'Compare',
          result: this.natural(),
          kind: 'floating',
          predicate: this.ordinal(floatingPredicates),
          left: this.operand(),
          right: this.operand(),
          fastMath: this.fastMath(),
        }
      case Select:
        return {
          _tag: 'Select',
          result: this.natural(),
          condition: this.operand(),
          onTrue: this.operand(),
          onFalse: this.operand(),
          fastMath: this.fastMath(),
        }
      case Cast: {
        const result = this.natural()
        const kind = this.ordinal(castKinds)
        const operand = this.operand()
        const destinationType = this.natural()
        const wrap = this.byte()
        return {
          _tag: 'Cast',
          result,
          kind,
          operand,
          destinationType,
          noSignedWrap: (wrap & 1) !== 0,
          noUnsignedWrap: (wrap & 2) !== 0,
        }
      }
      case Freeze:
        return { _tag: 'Freeze', result: this.natural(), operand: this.operand() }
      case ExtractValue:
        return {
          _tag: 'ExtractValue',
          result: this.natural(),
          aggregate: this.operand(),
          indices: this.naturals(),
        }
      case InsertValue:
        return {
          _tag: 'InsertValue',
          result: this.natural(),
          aggregate: this.operand(),
          element: this.operand(),
          indices: this.naturals(),
        }
      case Alloca:
        return {
          _tag: 'Alloca',
          result: this.natural(),
          allocationType: this.natural(),
          count: this.operand(),
          addressSpace: this.natural(),
          alignment: this.alignment(),
          inAlloca: this.flag(),
        }
      case Load:
        return {
          _tag: 'Load',
          result: this.natural(),
          valueType: this.natural(),
          pointer: this.operand(),
          access: this.access(),
        }
      case Store:
        return {
          _tag: 'Store',
          result: undefined,
          value: this.operand(),
          pointer: this.operand(),
          access: this.access(),
        }
      case GetElementPtr:
        return {
          _tag: 'GetElementPtr',
          result: this.natural(),
          sourceType: this.natural(),
          base: this.operand(),
          indices: this.operands(),
          inbounds: this.flag(),
          inrange: this.optional(),
        }
      case ExtractElement:
        return {
          _tag: 'ExtractElement',
          result: this.natural(),
          vector: this.operand(),
          index: this.operand(),
        }
      case InsertElement:
        return {
          _tag: 'InsertElement',
          result: this.natural(),
          vector: this.operand(),
          element: this.operand(),
          index: this.operand(),
        }
      case ShuffleVector:
        return {
          _tag: 'ShuffleVector',
          result: this.natural(),
          left: this.operand(),
          right: this.operand(),
          mask: this.operand(),
        }
      case Fence:
        return {
          _tag: 'Fence',
          result: undefined,
          syncScope: this.ordinal(syncScopes),
          ordering: this.ordinal(atomicOrderings),
        }
      case CompareExchange:
        return {
          _tag: 'CompareExchange',
          result: this.natural(),
          pointer: this.operand(),
          comparison: this.operand(),
          replacement: this.operand(),
          access: this.access(),
          failureOrdering: this.ordinal(atomicOrderings),
          weak: this.flag(),
        }
      case AtomicRmw:
        return {
          _tag: 'AtomicRmw',
          result: this.natural(),
          operation: this.ordinal(atomicOperations),
          pointer: this.operand(),
          value: this.operand(),
          access: this.access(),
        }
      case VaArg:
        return {
          _tag: 'VaArg',
          result: this.natural(),
          list: this.operand(),
          valueType: this.natural(),
        }
      case IndirectBranch:
        return {
          _tag: 'IndirectBranch',
          result: undefined,
          address: this.operand(),
          destinations: this.naturals(),
        }
      case Branch:
        return { _tag: 'Branch', result: undefined, destination: this.natural() }
      case ConditionalBranch:
        return {
          _tag: 'ConditionalBranch',
          result: undefined,
          condition: this.operand(),
          onTrue: this.natural(),
          onFalse: this.natural(),
          weights: this.ordinal(branchWeights),
        }
      case Switch: {
        const value = this.operand()
        const defaultBlock = this.natural()
        const count = this.natural()
        const cases: Array<{ readonly value: number; readonly block: number }> = []
        for (let index = 0; index < count; index += 1)
          cases.push({ value: this.natural(), block: this.natural() })
        return {
          _tag: 'Switch',
          result: undefined,
          value,
          defaultBlock,
          cases,
          weights: this.naturals(),
          sealed: this.flag(),
        }
      }
      case Return:
        return { _tag: 'Return', result: undefined, value: this.operand() }
      case ReturnVoid:
        return { _tag: 'ReturnVoid', result: undefined }
      case Unreachable:
        return { _tag: 'Unreachable', result: undefined }
      case Phi: {
        const result = this.natural()
        const type = this.natural()
        const count = this.natural()
        const incoming: Array<{
          readonly value: FunctionBodyDescription.Operand
          readonly block: number
        }> = []
        for (let index = 0; index < count; index += 1)
          incoming.push({ value: this.operand(), block: this.natural() })
        return {
          _tag: 'Phi',
          result,
          type,
          incoming,
          fastMath: this.fastMath(),
          sealed: this.flag(),
        }
      }
      case Call:
        return {
          _tag: 'Call',
          result: this.optional(),
          functionType: this.natural(),
          callee: this.operand(),
          arguments: this.operands(),
          callingConvention: this.natural(),
          attributes: this.optional(),
          tail: this.ordinal(tailKinds),
          fastMath: this.fastMath(),
          operandBundles: this.bundles(),
        }
      case LandingPad:
        return { _tag: 'LandingPad', result: this.natural(), type: this.natural() }
      case Invoke:
        return {
          _tag: 'Invoke',
          result: this.optional(),
          functionType: this.natural(),
          callee: this.operand(),
          arguments: this.operands(),
          callingConvention: this.natural(),
          attributes: this.optional(),
          fastMath: this.fastMath(),
          operandBundles: this.bundles(),
          normal: this.natural(),
          unwind: this.natural(),
        }
      default:
        throw new TypeError(`PackedBody found an unknown opcode ${opcode}`)
    }
  }

  value(): FunctionBodyDescription.Value {
    const type = this.natural()
    const name = this.name()
    const source = this.byte()
    switch (source) {
      case ArgumentSource:
        return { type, name, source: { _tag: 'Argument', index: this.natural() } }
      case InstructionSource:
        return { type, name, source: { _tag: 'Instruction', instruction: this.natural() } }
      case ForwardSource:
        return {
          type,
          name,
          source: { _tag: 'Forward', resolved: this.flag() ? this.operand() : undefined },
        }
      default:
        throw new TypeError(`PackedBody found an unknown value source ${source}`)
    }
  }

  snapshot(): FunctionBodyDescription.Snapshot {
    const argumentValues = this.naturals()
    const blockCount = this.natural()
    const blocks: Array<FunctionBodyDescription.Block> = []
    for (let index = 0; index < blockCount; index += 1)
      blocks.push({
        name: this.name(),
        instructions: this.naturals(),
        predecessors: this.naturals(),
      })
    const instructionCount = this.natural()
    const instructions: Array<FunctionBodyDescription.Instruction> = []
    for (let index = 0; index < instructionCount; index += 1) instructions.push(this.instruction())
    const valueCount = this.natural()
    const values: Array<FunctionBodyDescription.Value> = []
    for (let index = 0; index < valueCount; index += 1) values.push(this.value())
    const metadataCount = this.natural()
    const metadata: Array<ReadonlyArray<MetadataDescription.Attachment>> = []
    for (let index = 0; index < metadataCount; index += 1) {
      const count = this.natural()
      if (count === 0) {
        metadata.push(noAttachments)
        continue
      }
      const attachments: Array<MetadataDescription.Attachment> = []
      for (let entry = 0; entry < count; entry += 1)
        attachments.push({ kind: this.ordinal(attachmentKinds), metadata: this.natural() })
      metadata.push(attachments)
    }
    const locationCount = this.natural()
    const debugLocations: Array<number | undefined> = []
    for (let index = 0; index < locationCount; index += 1) debugLocations.push(this.optional())
    return {
      arguments: argumentValues,
      blocks,
      instructions,
      values,
      metadata,
      debugLocations,
    }
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
  writer.snapshot(snapshot)
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
 * Restores the snapshot a body was packed from. Records are fresh on every call, apart from shared
 * immutable leaves (fast-math and integer flag sets, alignments, and empty attachment
 * lists), so callers unpack a body where they use it rather than retaining the result.
 *
 * @internal
 */
export const unpack = (self: PackedBody): FunctionBodyDescription.Snapshot =>
  new Reader(self.bytes).snapshot()
