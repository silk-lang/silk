import type * as ByteString from '../ByteString.js'

export type Category = 'any' | 'scope' | 'type' | 'variable' | 'node'

export interface Attachment {
  readonly kind: 'dbg' | 'prof' | 'unpredictable'
  readonly metadata: number
}

export type BasicEncoding = 'boolean' | 'unsigned' | 'signed' | 'float'
export type StringEncoding = 'utf'
export type CompositeKind = 'structure' | 'union' | 'enumeration' | 'array' | 'vector'
export type DerivedKind = 'pointer' | 'member' | 'typedef'

interface NodeBase {
  readonly distinct: boolean
}

export type Node =
  | (NodeBase & {
      readonly _tag: 'Tuple'
      readonly elements: ReadonlyArray<number | undefined>
    })
  | (NodeBase & { readonly _tag: 'Constant'; readonly constant: number })
  | (NodeBase & { readonly _tag: 'Local'; readonly label: ByteString.ByteString })
  | (NodeBase & {
      readonly _tag: 'File'
      readonly filename: number | undefined
      readonly directory: number | undefined
    })
  | (NodeBase & {
      readonly _tag: 'CompileUnit'
      readonly file: number | undefined
      readonly producer: number | undefined
      readonly optimized: boolean
      readonly enums: number | undefined
      readonly globals: number | undefined
    })
  | (NodeBase & {
      readonly _tag: 'Subprogram'
      readonly file: number | undefined
      readonly name: number | undefined
      readonly linkageName: number | undefined
      readonly line: number
      readonly scopeLine: number
      readonly type: number | undefined
      readonly diFlags: number
      readonly spFlags: number
      readonly compileUnit: number | undefined
    })
  | (NodeBase & {
      readonly _tag: 'LexicalBlock'
      readonly scope: number | undefined
      readonly file: number | undefined
      readonly line: number
      readonly column: number
    })
  | (NodeBase & {
      readonly _tag: 'Location'
      readonly line: number
      readonly column: number
      readonly scope: number
      readonly inlinedAt: number | undefined
    })
  | (NodeBase & {
      readonly _tag: 'BasicType'
      readonly name: number | undefined
      readonly sizeInBits: bigint
      readonly encoding: BasicEncoding
    })
  | (NodeBase & {
      readonly _tag: 'StringType'
      readonly name: number | undefined
      readonly stringLength: number | undefined
      readonly stringLengthExpression: number | undefined
      readonly stringLocationExpression: number | undefined
      readonly sizeInBits: bigint
      readonly alignInBits: bigint
      readonly encoding: StringEncoding
    })
  | (NodeBase & {
      readonly _tag: 'CompositeType'
      readonly kind: CompositeKind
      readonly name: number | undefined
      readonly file: number | undefined
      readonly scope: number | undefined
      readonly line: number
      readonly underlyingType: number | undefined
      readonly sizeInBits: bigint
      readonly alignInBits: bigint
      readonly fields: number | undefined
      readonly flags: number
    })
  | (NodeBase & {
      readonly _tag: 'DerivedType'
      readonly kind: DerivedKind
      readonly name: number | undefined
      readonly file: number | undefined
      readonly scope: number | undefined
      readonly line: number
      readonly underlyingType: number | undefined
      readonly sizeInBits: bigint
      readonly alignInBits: bigint
      readonly offsetInBits: bigint
      readonly flags: number
    })
  | (NodeBase & {
      readonly _tag: 'SubroutineType'
      readonly types: number | undefined
      readonly flags: number
    })
  | (NodeBase & {
      readonly _tag: 'Enumerator'
      readonly name: number | undefined
      readonly unsigned: boolean
      readonly bitWidth: number
      readonly value: bigint
    })
  | (NodeBase & {
      readonly _tag: 'Subrange'
      readonly lowerBound: number | undefined
      readonly count: number | undefined
    })
  | (NodeBase & { readonly _tag: 'Expression'; readonly elements: ReadonlyArray<number> })
  | (NodeBase & {
      readonly _tag: 'LocalVariable'
      readonly name: number | undefined
      readonly file: number | undefined
      readonly scope: number | undefined
      readonly line: number
      readonly type: number | undefined
      readonly argument: number
      readonly flags: number
    })
  | (NodeBase & {
      readonly _tag: 'GlobalVariable'
      readonly name: number | undefined
      readonly linkageName: number | undefined
      readonly file: number | undefined
      readonly scope: number | undefined
      readonly line: number
      readonly type: number | undefined
      readonly variable: number | undefined
      readonly local: boolean
    })
  | (NodeBase & {
      readonly _tag: 'GlobalVariableExpression'
      readonly variable: number | undefined
      readonly expression: number | undefined
    })

export type Entry =
  | { readonly _tag: 'String'; readonly value: ByteString.ByteString }
  | { readonly _tag: 'Node'; readonly value: Node }
  | {
      readonly _tag: 'Forward'
      readonly category: Category
      target: number | undefined
    }

export interface Named {
  readonly name: ByteString.ByteString
  readonly operands: ReadonlyArray<number>
}

/** @internal */
export const category = (node: Node): Exclude<Category, 'any'> => {
  switch (node._tag) {
    case 'File':
    case 'CompileUnit':
    case 'Subprogram':
    case 'LexicalBlock':
    case 'Location':
      return 'scope'
    case 'BasicType':
    case 'StringType':
    case 'CompositeType':
    case 'DerivedType':
    case 'SubroutineType':
    case 'Enumerator':
    case 'Subrange':
      return 'type'
    case 'LocalVariable':
    case 'GlobalVariable':
    case 'GlobalVariableExpression':
      return 'variable'
    case 'Tuple':
    case 'Constant':
    case 'Local':
    case 'Expression':
      return 'node'
  }
}

/** @internal */
export const references = (node: Node): ReadonlyArray<number> => {
  const optional = (...values: ReadonlyArray<number | undefined>): Array<number> =>
    values.filter((value): value is number => value !== undefined)
  switch (node._tag) {
    case 'Tuple':
      return optional(...node.elements)
    case 'Constant':
    case 'Local':
    case 'Expression':
      return []
    case 'BasicType':
    case 'Enumerator':
      return optional(node.name)
    case 'StringType':
      return optional(
        node.name,
        node.stringLength,
        node.stringLengthExpression,
        node.stringLocationExpression,
      )
    case 'File':
      return optional(node.filename, node.directory)
    case 'CompileUnit':
      return optional(node.file, node.producer, node.enums, node.globals)
    case 'Subprogram':
      return optional(node.file, node.name, node.linkageName, node.type, node.compileUnit)
    case 'LexicalBlock':
      return optional(node.scope, node.file)
    case 'Location':
      return optional(node.scope, node.inlinedAt)
    case 'CompositeType':
      return optional(node.name, node.file, node.scope, node.underlyingType, node.fields)
    case 'DerivedType':
      return optional(node.name, node.file, node.scope, node.underlyingType)
    case 'SubroutineType':
      return optional(node.types)
    case 'Subrange':
      return optional(node.lowerBound, node.count)
    case 'LocalVariable':
      return optional(node.name, node.file, node.scope, node.type)
    case 'GlobalVariable':
      return optional(node.name, node.linkageName, node.file, node.scope, node.type)
    case 'GlobalVariableExpression':
      return optional(node.variable, node.expression)
  }
}
