import type * as Bitstream from './Bitstream.js'

/** @internal */
const literal = (value: number): Bitstream.AbbrevOp => ({ _tag: 'Literal', value: BigInt(value) })
/** @internal */
const fixed = (width: number): Bitstream.AbbrevOp => ({ _tag: 'Fixed', width })
/** @internal */
const vbr = (width: number): Bitstream.AbbrevOp => ({ _tag: 'Vbr', width })
const array: Bitstream.AbbrevOp = { _tag: 'Array' }
const blob: Bitstream.AbbrevOp = { _tag: 'Blob' }

export const IdentificationVersion: Bitstream.Abbreviation = {
  name: 'IDENTIFICATION_CODE_STRING',
  ops: [literal(1), array, fixed(8)],
}

export const IdentificationEpoch: Bitstream.Abbreviation = {
  name: 'IDENTIFICATION_CODE_EPOCH',
  ops: [literal(2), vbr(6)],
}

export const Identification: Bitstream.Block = {
  id: 13,
  abbreviations: [IdentificationVersion, IdentificationEpoch],
}

export const ModuleVersion: Bitstream.Abbreviation = {
  name: 'MODULE_CODE_VERSION',
  ops: [literal(1), literal(2)],
}

export const ModuleString: Bitstream.Abbreviation = {
  name: 'MODULE_STRING',
  ops: [vbr(4), array, fixed(8)],
}

export const Module: Bitstream.Block = {
  id: 8,
  abbreviations: [ModuleVersion, ModuleString],
}

export const StrtabBlob: Bitstream.Abbreviation = {
  name: 'STRTAB_BLOB',
  ops: [literal(1), blob],
}

export const Strtab: Bitstream.Block = {
  id: 23,
  abbreviations: [StrtabBlob],
}

export const ModuleCode = {
  Triple: 2,
  DataLayout: 3,
  Assembly: 4,
  SourceFilename: 16,
} as const

export const Magic = 0xdec04342
