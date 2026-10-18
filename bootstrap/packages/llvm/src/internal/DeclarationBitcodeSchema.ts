import type * as Bitstream from './Bitstream.js'

/** @internal */
const literal = (value: number): Bitstream.AbbrevOp => ({ _tag: 'Literal', value: BigInt(value) })
/** @internal */
const fixed = (width: number): Bitstream.AbbrevOp => ({ _tag: 'Fixed', width })
/** @internal */
const vbr = (width: number): Bitstream.AbbrevOp => ({ _tag: 'Vbr', width })
const array: Bitstream.AbbrevOp = { _tag: 'Array' }

export interface ModuleSchema {
  readonly block: Bitstream.Block
  readonly version: Bitstream.Abbreviation
  readonly string: Bitstream.Abbreviation
  readonly variable: Bitstream.Abbreviation
  readonly functionDeclaration: Bitstream.Abbreviation
  readonly alias: Bitstream.Abbreviation
}

/** @internal */
export const module = (typeWidth: number): ModuleSchema => {
  const version: Bitstream.Abbreviation = {
    name: 'MODULE_CODE_VERSION',
    ops: [literal(1), literal(2)],
  }
  const string: Bitstream.Abbreviation = {
    name: 'MODULE_STRING',
    ops: [vbr(4), array, fixed(8)],
  }
  const variable: Bitstream.Abbreviation = {
    name: 'MODULE_CODE_GLOBALVAR',
    ops: [
      literal(7),
      vbr(16),
      vbr(16),
      fixed(typeWidth),
      fixed(26),
      vbr(6),
      fixed(4),
      fixed(6),
      vbr(16),
      fixed(2),
      fixed(3),
      fixed(2),
      fixed(1),
      fixed(2),
      literal(0),
      literal(0),
      fixed(2),
    ],
  }
  const functionDeclaration: Bitstream.Abbreviation = {
    name: 'MODULE_CODE_FUNCTION',
    ops: [
      literal(8),
      vbr(16),
      vbr(16),
      fixed(typeWidth),
      fixed(10),
      fixed(1),
      fixed(4),
      vbr(16),
      fixed(6),
      vbr(16),
      fixed(2),
      literal(0),
      fixed(2),
      literal(0),
      fixed(2),
      literal(0),
      literal(0),
      vbr(6),
      fixed(2),
      fixed(24),
    ],
  }
  const alias: Bitstream.Abbreviation = {
    name: 'MODULE_CODE_ALIAS',
    ops: [
      literal(14),
      vbr(16),
      vbr(16),
      fixed(typeWidth),
      fixed(24),
      vbr(6),
      fixed(4),
      fixed(2),
      fixed(2),
      fixed(3),
      fixed(2),
      fixed(2),
    ],
  }
  return {
    version,
    string,
    variable,
    functionDeclaration,
    alias,
    block: {
      id: 8,
      abbreviations: [version, string, variable, functionDeclaration, alias],
    },
  }
}

export interface TypeSchema {
  readonly block: Bitstream.Block
  readonly numEntry: Bitstream.Abbreviation
  readonly simple: Bitstream.Abbreviation
  readonly opaque: Bitstream.Abbreviation
  readonly integer: Bitstream.Abbreviation
  readonly structAnon: Bitstream.Abbreviation
  readonly structNamed: Bitstream.Abbreviation
  readonly structName: Bitstream.Abbreviation
  readonly array: Bitstream.Abbreviation
  readonly vector: Bitstream.Abbreviation
  readonly pointer: Bitstream.Abbreviation
  readonly target: Bitstream.Abbreviation
  readonly functionType: Bitstream.Abbreviation
}

/** @internal */
export const type = (typeWidth: number): TypeSchema => {
  const numEntry = { name: 'TYPE_CODE_NUMENTRY', ops: [literal(1), fixed(32)] }
  const simple = { name: 'TYPE_CODE_SIMPLE', ops: [vbr(4)] }
  const opaque = { name: 'TYPE_CODE_OPAQUE', ops: [literal(6), literal(0)] }
  const integer = { name: 'TYPE_CODE_INTEGER', ops: [literal(7), fixed(28)] }
  const structAnon = {
    name: 'TYPE_CODE_STRUCT_ANON',
    ops: [literal(18), fixed(1), array, fixed(typeWidth)],
  }
  const structNamed = {
    name: 'TYPE_CODE_STRUCT_NAMED',
    ops: [literal(20), fixed(1), array, fixed(typeWidth)],
  }
  const structName = {
    name: 'TYPE_CODE_STRUCT_NAME',
    ops: [literal(19), array, fixed(8)],
  }
  const arrayType = {
    name: 'TYPE_CODE_ARRAY',
    ops: [literal(11), vbr(16), fixed(typeWidth)],
  }
  const vector = {
    name: 'TYPE_CODE_VECTOR',
    ops: [literal(12), vbr(16), fixed(typeWidth)],
  }
  const pointer = { name: 'TYPE_CODE_OPAQUE_POINTER', ops: [literal(25), vbr(4)] }
  const target = {
    name: 'TYPE_CODE_TARGET',
    ops: [literal(26), vbr(4), array, fixed(typeWidth), array, fixed(32)],
  }
  const functionType = {
    name: 'TYPE_CODE_FUNCTION',
    ops: [literal(21), fixed(1), fixed(typeWidth), array, fixed(typeWidth)],
  }
  const block: Bitstream.Block = {
    id: 17,
    abbreviations: [
      numEntry,
      simple,
      opaque,
      integer,
      structAnon,
      structNamed,
      structName,
      arrayType,
      vector,
      pointer,
      target,
      functionType,
    ],
  }
  return {
    block,
    numEntry,
    simple,
    opaque,
    integer,
    structAnon,
    structNamed,
    structName,
    array: arrayType,
    vector,
    pointer,
    target,
    functionType,
  }
}

export interface ConstantsSchema {
  readonly block: Bitstream.Block
  readonly setType: Bitstream.Abbreviation
  readonly nullValue: Bitstream.Abbreviation
  readonly undef: Bitstream.Abbreviation
  readonly poison: Bitstream.Abbreviation
  readonly integer: Bitstream.Abbreviation
  readonly half: Bitstream.Abbreviation
  readonly float: Bitstream.Abbreviation
  readonly double: Bitstream.Abbreviation
  readonly fp80: Bitstream.Abbreviation
  readonly fp128: Bitstream.Abbreviation
  readonly aggregate: Bitstream.Abbreviation
  readonly string: Bitstream.Abbreviation
  readonly cString: Bitstream.Abbreviation
  readonly cast: Bitstream.Abbreviation
  readonly binary: Bitstream.Abbreviation
}

/** @internal */
export const constants = (typeWidth: number): ConstantsSchema => {
  const setType = { name: 'CST_CODE_SETTYPE', ops: [literal(1), fixed(typeWidth)] }
  const nullValue = { name: 'CST_CODE_NULL', ops: [literal(2)] }
  const undef = { name: 'CST_CODE_UNDEF', ops: [literal(3)] }
  const poison = { name: 'CST_CODE_POISON', ops: [literal(26)] }
  const integer = { name: 'CST_CODE_INTEGER', ops: [literal(4), vbr(16)] }
  const half = { name: 'CST_CODE_HALF', ops: [literal(6), fixed(16)] }
  const float = { name: 'CST_CODE_FLOAT', ops: [literal(6), fixed(32)] }
  const double = { name: 'CST_CODE_DOUBLE', ops: [literal(6), vbr(6)] }
  const fp80 = { name: 'CST_CODE_FP80', ops: [literal(6), vbr(6), vbr(6)] }
  const fp128 = { name: 'CST_CODE_FP128', ops: [literal(6), vbr(6), vbr(6)] }
  const aggregate = { name: 'CST_CODE_AGGREGATE', ops: [literal(7), array, fixed(32)] }
  const string = { name: 'CST_CODE_STRING', ops: [literal(8), array, fixed(8)] }
  const cString = { name: 'CST_CODE_CSTRING', ops: [literal(9), array, fixed(8)] }
  const cast = {
    name: 'CST_CODE_CAST',
    ops: [literal(11), fixed(4), fixed(typeWidth), vbr(6)],
  }
  const binary = { name: 'CST_CODE_BINARY', ops: [literal(10), fixed(4), vbr(6), vbr(6)] }
  const block: Bitstream.Block = {
    id: 11,
    abbreviations: [
      setType,
      nullValue,
      undef,
      poison,
      integer,
      half,
      float,
      double,
      fp80,
      fp128,
      aggregate,
      string,
      cString,
      cast,
      binary,
    ],
  }
  return {
    block,
    setType,
    nullValue,
    undef,
    poison,
    integer,
    half,
    float,
    double,
    fp80,
    fp128,
    aggregate,
    string,
    cString,
    cast,
    binary,
  }
}

export const paramattrGroup: Bitstream.Block = { id: 10, abbreviations: [] }

export const paramattrEntry: Bitstream.Abbreviation = {
  name: 'PARAMATTR_CODE_ENTRY',
  ops: [literal(2), array, vbr(8)],
}

export const paramattr: Bitstream.Block = { id: 9, abbreviations: [paramattrEntry] }
