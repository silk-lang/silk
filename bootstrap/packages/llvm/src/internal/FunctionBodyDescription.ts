import type * as Alignment from '../Alignment.js'
import type * as ByteString from '../ByteString.js'
import type * as MemoryAccess from '../MemoryAccess.js'
import type * as LocalName from './LocalName.js'
import type * as MetadataDescription from './MetadataDescription.js'

export type Operand =
  | { readonly _tag: 'Local'; readonly value: number }
  | { readonly _tag: 'Constant'; readonly constant: number }

export interface FastMath {
  readonly allowReassociation: boolean
  readonly noNaNs: boolean
  readonly noInfinities: boolean
  readonly noSignedZeros: boolean
  readonly allowReciprocal: boolean
  readonly allowContract: boolean
  readonly approximateFunctions: boolean
}

export type IntegerBinaryKind =
  | 'add'
  | 'sub'
  | 'mul'
  | 'udiv'
  | 'sdiv'
  | 'urem'
  | 'srem'
  | 'shl'
  | 'lshr'
  | 'ashr'
  | 'and'
  | 'or'
  | 'xor'

export type FloatingBinaryKind = 'fadd' | 'fsub' | 'fmul' | 'fdiv' | 'frem'
export type BinaryKind = IntegerBinaryKind | FloatingBinaryKind

export interface IntegerFlags {
  readonly noSignedWrap: boolean
  readonly noUnsignedWrap: boolean
  readonly exact: boolean
}

export type IntegerPredicate =
  | 'eq'
  | 'ne'
  | 'ugt'
  | 'uge'
  | 'ult'
  | 'ule'
  | 'sgt'
  | 'sge'
  | 'slt'
  | 'sle'

export type FloatingPredicate =
  | 'false'
  | 'oeq'
  | 'ogt'
  | 'oge'
  | 'olt'
  | 'ole'
  | 'one'
  | 'ord'
  | 'ueq'
  | 'ugt'
  | 'uge'
  | 'ult'
  | 'ule'
  | 'une'
  | 'uno'
  | 'true'

export type CastKind =
  | 'trunc'
  | 'zext'
  | 'sext'
  | 'fptoui'
  | 'fptosi'
  | 'uitofp'
  | 'sitofp'
  | 'fptrunc'
  | 'fpext'
  | 'ptrtoint'
  | 'inttoptr'
  | 'bitcast'
  | 'addrspacecast'

export type TailKind = 'none' | 'tail' | 'musttail' | 'notail'

export interface MemoryInfo {
  readonly kind: MemoryAccess.Kind
  readonly alignment: Alignment.Alignment
  readonly syncScope: MemoryAccess.SyncScope
  readonly ordering: MemoryAccess.AtomicOrdering
}

export interface OperandBundle {
  readonly tag: ByteString.ByteString
  readonly operands: ReadonlyArray<Operand>
}

interface ResultInstruction {
  readonly result: number
}

interface VoidInstruction {
  readonly result: undefined
}

export type Instruction =
  | (ResultInstruction & {
      readonly _tag: 'Unary'
      readonly kind: 'fneg'
      readonly operand: Operand
      readonly fastMath: FastMath
    })
  | (ResultInstruction & {
      readonly _tag: 'Binary'
      readonly kind: BinaryKind
      readonly left: Operand
      readonly right: Operand
      readonly integerFlags: IntegerFlags
      readonly fastMath: FastMath
    })
  | (ResultInstruction & {
      readonly _tag: 'Compare'
      readonly kind: 'integer'
      readonly predicate: IntegerPredicate
      readonly left: Operand
      readonly right: Operand
      readonly fastMath: FastMath
    })
  | (ResultInstruction & {
      readonly _tag: 'Compare'
      readonly kind: 'floating'
      readonly predicate: FloatingPredicate
      readonly left: Operand
      readonly right: Operand
      readonly fastMath: FastMath
    })
  | (ResultInstruction & {
      readonly _tag: 'Select'
      readonly condition: Operand
      readonly onTrue: Operand
      readonly onFalse: Operand
      readonly fastMath: FastMath
    })
  | (ResultInstruction & {
      readonly _tag: 'Cast'
      readonly kind: CastKind
      readonly operand: Operand
      readonly destinationType: number
      readonly noSignedWrap: boolean
      readonly noUnsignedWrap: boolean
    })
  | (ResultInstruction & {
      readonly _tag: 'Freeze'
      readonly operand: Operand
    })
  | (ResultInstruction & {
      readonly _tag: 'ExtractValue'
      readonly aggregate: Operand
      readonly indices: ReadonlyArray<number>
    })
  | (ResultInstruction & {
      readonly _tag: 'InsertValue'
      readonly aggregate: Operand
      readonly element: Operand
      readonly indices: ReadonlyArray<number>
    })
  | (ResultInstruction & {
      readonly _tag: 'Alloca'
      readonly allocationType: number
      readonly count: Operand
      readonly addressSpace: number
      readonly alignment: Alignment.Alignment
      readonly inAlloca: boolean
    })
  | (ResultInstruction & {
      readonly _tag: 'Load'
      readonly valueType: number
      readonly pointer: Operand
      readonly access: MemoryInfo
    })
  | (VoidInstruction & {
      readonly _tag: 'Store'
      readonly value: Operand
      readonly pointer: Operand
      readonly access: MemoryInfo
    })
  | (ResultInstruction & {
      readonly _tag: 'GetElementPtr'
      readonly sourceType: number
      readonly base: Operand
      readonly indices: ReadonlyArray<Operand>
      readonly inbounds: boolean
      readonly inrange: number | undefined
    })
  | (ResultInstruction & {
      readonly _tag: 'ExtractElement'
      readonly vector: Operand
      readonly index: Operand
    })
  | (ResultInstruction & {
      readonly _tag: 'InsertElement'
      readonly vector: Operand
      readonly element: Operand
      readonly index: Operand
    })
  | (ResultInstruction & {
      readonly _tag: 'ShuffleVector'
      readonly left: Operand
      readonly right: Operand
      readonly mask: Operand
    })
  | (VoidInstruction & {
      readonly _tag: 'Fence'
      readonly syncScope: MemoryAccess.SyncScope
      readonly ordering: MemoryAccess.AtomicOrdering
    })
  | (ResultInstruction & {
      readonly _tag: 'CompareExchange'
      readonly pointer: Operand
      readonly comparison: Operand
      readonly replacement: Operand
      readonly access: MemoryInfo
      readonly failureOrdering: MemoryAccess.AtomicOrdering
      readonly weak: boolean
    })
  | (ResultInstruction & {
      readonly _tag: 'AtomicRmw'
      readonly operation: MemoryAccess.AtomicOperation
      readonly pointer: Operand
      readonly value: Operand
      readonly access: MemoryInfo
    })
  | (ResultInstruction & {
      readonly _tag: 'VaArg'
      readonly list: Operand
      readonly valueType: number
    })
  | (VoidInstruction & {
      readonly _tag: 'IndirectBranch'
      readonly address: Operand
      readonly destinations: ReadonlyArray<number>
    })
  | (VoidInstruction & { readonly _tag: 'Branch'; readonly destination: number })
  | (VoidInstruction & {
      readonly _tag: 'ConditionalBranch'
      readonly condition: Operand
      readonly onTrue: number
      readonly onFalse: number
      readonly weights: 'none' | 'unpredictable' | 'true-likely' | 'false-likely'
    })
  | (VoidInstruction & {
      readonly _tag: 'Switch'
      readonly value: Operand
      readonly defaultBlock: number
      readonly cases: ReadonlyArray<{ readonly value: number; readonly block: number }>
      readonly weights: ReadonlyArray<number>
      readonly sealed: boolean
    })
  | (VoidInstruction & { readonly _tag: 'Return'; readonly value: Operand })
  | (VoidInstruction & { readonly _tag: 'ReturnVoid' })
  | (VoidInstruction & { readonly _tag: 'Unreachable' })
  | (ResultInstruction & {
      readonly _tag: 'Phi'
      readonly type: number
      readonly incoming: ReadonlyArray<{ readonly value: Operand; readonly block: number }>
      readonly fastMath: FastMath
      readonly sealed: boolean
    })
  | ({ readonly result: number | undefined } & {
      readonly _tag: 'Call'
      readonly functionType: number
      readonly callee: Operand
      readonly arguments: ReadonlyArray<Operand>
      readonly callingConvention: number
      readonly attributes: number | undefined
      readonly tail: TailKind
      readonly fastMath: FastMath
      readonly operandBundles: ReadonlyArray<OperandBundle>
    })
  | (ResultInstruction & { readonly _tag: 'LandingPad'; readonly type: number })
  | ({ readonly result: number | undefined } & {
      readonly _tag: 'Invoke'
      readonly functionType: number
      readonly callee: Operand
      readonly arguments: ReadonlyArray<Operand>
      readonly callingConvention: number
      readonly attributes: number | undefined
      readonly fastMath: FastMath
      readonly operandBundles: ReadonlyArray<OperandBundle>
      readonly normal: number
      readonly unwind: number
    })

export interface Value {
  readonly type: number
  readonly name: LocalName.LocalName
  readonly source:
    | { readonly _tag: 'Argument'; readonly index: number }
    | { readonly _tag: 'Instruction'; readonly instruction: number }
    | { readonly _tag: 'Forward'; readonly resolved: Operand | undefined }
}

export interface Block {
  readonly name: LocalName.LocalName
  readonly instructions: ReadonlyArray<number>
  readonly predecessors: ReadonlyArray<number>
}

export interface Snapshot {
  readonly arguments: ReadonlyArray<number>
  readonly blocks: ReadonlyArray<Block>
  readonly instructions: ReadonlyArray<Instruction>
  readonly values: ReadonlyArray<Value>
  readonly metadata: ReadonlyArray<ReadonlyArray<MetadataDescription.Attachment>>
  readonly debugLocations: ReadonlyArray<number | undefined>
}

/** @internal */
export const isTerminator = (instruction: Instruction): boolean =>
  instruction._tag === 'Invoke' ||
  instruction._tag === 'Branch' ||
  instruction._tag === 'ConditionalBranch' ||
  instruction._tag === 'Switch' ||
  instruction._tag === 'IndirectBranch' ||
  instruction._tag === 'Return' ||
  instruction._tag === 'ReturnVoid' ||
  instruction._tag === 'Unreachable'
