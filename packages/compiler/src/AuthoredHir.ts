import type * as AuthoredIdentity from './AuthoredIdentity.js'
import type * as AuthoredPool from './AuthoredPool.js'

/** A source-independent path within one logical authored owner. */
export type Anchor = AuthoredIdentity.Anchor

/** A lexical binder reference may capture a binder in an enclosing owner. */
export interface LexicalReference {
  readonly _tag: 'LexicalReference'
  readonly owner: AuthoredIdentity.Identity
  readonly path: ReadonlyArray<AuthoredIdentity.LocalSegment>
}

/** Synthetic origins refer to authored structure, never to a source offset. */
export type Origin =
  | { readonly _tag: 'Authored' }
  | {
      readonly _tag: 'Synthetic'
      readonly anchor: Anchor
      readonly role: string
      readonly occurrence: number
    }

export interface Cause {
  readonly _tag: 'Cause'
  readonly anchor: Anchor
  readonly code: string
}

export interface Node {
  readonly anchor: Anchor
  readonly origin: Origin
  /** Lexical/lowering damage, distinct from deferred semantic rejection. */
  readonly causes: ReadonlyArray<Cause>
}

export type RecoveryCauses = readonly [Cause, ...Array<Cause>]

export type Name =
  | (Node & { readonly _tag: 'Name'; readonly text: AuthoredPool.TextRef })
  | (Node & { readonly _tag: 'MissingName'; readonly causes: RecoveryCauses })
  | (Node & {
      readonly _tag: 'InvalidName'
      readonly causes: RecoveryCauses
      readonly spelling: AuthoredPool.TextRef
    })

export interface Path extends Node {
  readonly _tag: 'Path'
  readonly segments: ReadonlyArray<Name>
}

export type Access = 'Shared' | 'Mutable'
export type CallableMode = 'Shared' | 'Mutable' | 'Once'

export type GenericParameter = Node &
  (
    | {
        readonly _tag: 'TypeParameter'
        readonly name: Name
        readonly bounds: ReadonlyArray<Type | Lifetime>
      }
    | { readonly _tag: 'RowParameter'; readonly name: Name }
    | {
        readonly _tag: 'LifetimeParameter'
        readonly name: Name
        readonly bounds: ReadonlyArray<Type | Lifetime>
        /** Explicit bounded invocation-use role; absent on ordinary data lifetime binders. */
        readonly invocationUse?: boolean
      }
  )

export interface Lifetime extends Node {
  readonly _tag: 'Lifetime'
  readonly name: Name
}

export type GenericArgument = Type | Lifetime | RequirementSelector

export interface RequirementSelector extends Node {
  readonly _tag: 'RequirementSelector'
  readonly subject: Type
  readonly role: Path
}

export interface TypeArguments extends Node {
  readonly _tag: 'TypeArguments'
  readonly arguments: ReadonlyArray<GenericArgument>
  /** undefined and an explicitly empty environment remain distinct. */
  readonly environment: ReadonlyArray<Lifetime> | undefined
  readonly failures: Type | undefined
  readonly requirements: RequirementRow | undefined
}

export interface Requirement extends Node {
  readonly _tag: 'Requirement'
  /** Subtraction selectors can omit the borrow marker. */
  readonly access: Access | undefined
  readonly capability: Type
  readonly role: Path | undefined
}

export type RowOperand = Type | Requirement

export interface RequirementRow extends Node {
  readonly _tag: 'RequirementRow'
  readonly members: ReadonlyArray<RowOperand>
}

export interface PointerQualifier extends Node {
  readonly _tag: 'PointerQualifier'
  readonly name: Name
  readonly value: IntegerLiteral | MissingExpression | InvalidExpression
}

export type Type = Node &
  (
    | { readonly _tag: 'NamedType'; readonly path: Path; readonly mode: CallableMode | undefined }
    | { readonly _tag: 'AppliedType'; readonly target: Type; readonly arguments: TypeArguments }
    | {
        readonly _tag: 'FixedArrayType'
        readonly element: Type
        readonly length: IntegerLiteral | MissingExpression | InvalidExpression
      }
    | {
        readonly _tag: 'SliceType'
        readonly element: Type
        readonly access: Access
        readonly lifetime: Lifetime | undefined
      }
    | {
        readonly _tag: 'ReferenceType'
        readonly referent: Type
        readonly access: Access
        readonly lifetime: Lifetime | undefined
        readonly role: Name | undefined
      }
    | {
        readonly _tag: 'PointerType'
        readonly pointee: Type
        readonly access: Access
        readonly nullable: boolean
        readonly multiplicity: 'Single' | 'Many'
        readonly qualifiers: ReadonlyArray<PointerQualifier>
      }
    | {
        readonly _tag: 'CallableType'
        readonly mode: CallableMode
        readonly unsafe: boolean
        readonly binders: ReadonlyArray<GenericParameter>
        readonly environment: Lifetime | undefined
        readonly parameters: ReadonlyArray<Type>
        readonly result: Type
      }
    | {
        readonly _tag: 'ForeignFunctionType'
        readonly abi: TextLiteral | MissingExpression | InvalidExpression
        readonly binders: ReadonlyArray<GenericParameter>
        readonly parameters: ReadonlyArray<Type>
        readonly result: Type
        readonly properties: ReadonlyArray<PropertyClause>
      }
    | { readonly _tag: 'ExactRepresentationType'; readonly subject: Type }
    | {
        readonly _tag: 'OpaqueResultType'
        readonly binders: ReadonlyArray<GenericParameter>
        readonly result: Type
      }
    | { readonly _tag: 'UnitType' }
    | { readonly _tag: 'UnionType'; readonly members: ReadonlyArray<RowOperand> }
    | { readonly _tag: 'RowWithout'; readonly source: RowOperand; readonly removed: RowOperand }
    | { readonly _tag: 'MissingType'; readonly causes: RecoveryCauses }
    | {
        readonly _tag: 'InvalidType'
        readonly causes: RecoveryCauses
        readonly retained: ReadonlyArray<Type>
      }
  )

export type Constraint = Node &
  (
    | {
        readonly _tag: 'MembershipConstraint'
        readonly subject: RowOperand
        readonly source: RowOperand
      }
    | {
        readonly _tag: 'ProviderConstraint'
        readonly provider: Type
        readonly selected: RowOperand
        readonly source: RowOperand
      }
  )

export interface Parameter extends Node {
  readonly _tag: 'Parameter'
  readonly name: Name
  readonly type: Type
  readonly mode: 'Value' | 'Mutable' | 'Static'
}

export interface CallableContract extends Node {
  readonly _tag: 'CallableContract'
  readonly generics: ReadonlyArray<GenericParameter>
  readonly parameters: ReadonlyArray<Parameter>
  readonly variadic: boolean
  readonly result: Type | undefined
  readonly failures: Type | undefined
  readonly requirements: RequirementRow | undefined
  readonly constraints: ReadonlyArray<Constraint>
  readonly effect: boolean
  /** Whether this named function was marked for test discovery. */
  readonly test: boolean
  readonly environment: ReadonlyArray<Lifetime> | undefined
  readonly unsafe: boolean
  readonly static: boolean
  /**
   * Where each written modifier keyword sits, so a diagnostic about one modifier names that word
   * rather than the whole header. Present exactly when the matching flag is set; a flag a header
   * only implies carries no anchor.
   */
  readonly effectAnchor: Anchor | undefined
  readonly testAnchor: Anchor | undefined
  readonly unsafeAnchor: Anchor | undefined
  readonly staticAnchor: Anchor | undefined
  /** The written binder list including its brackets, so a diagnostic can name the list as a whole. */
  readonly genericsAnchor: Anchor | undefined
  /**
   * The written failure row including its `!` marker. `failures` holds only the row's type, whose
   * own anchor stops short of the marker.
   */
  readonly failuresAnchor: Anchor | undefined
  /**
   * The written `where` clause including its keyword. `constraints` holds only the individual
   * constraints, whose anchors stop short of the keyword.
   */
  readonly constraintsAnchor: Anchor | undefined
}

export interface Property extends Node {
  readonly _tag: 'Property'
  readonly name: Name
  readonly value: Expression
}

/** Preserve clause order and duplicate keys for semantic validation. */
export interface PropertyClause extends Node {
  readonly _tag: 'PropertyClause'
  readonly namespace: Name
  readonly operation: Name
  readonly properties: ReadonlyArray<Property>
}

export interface IntegerLiteral extends Node {
  readonly _tag: 'IntegerLiteral'
  readonly value: bigint
  readonly radix: 2 | 8 | 10 | 16
  readonly suffix: AuthoredPool.TextRef | undefined
}

export interface TextLiteral extends Node {
  readonly _tag: 'TextLiteral'
  readonly value: AuthoredPool.TextRef
}

export interface DurationComponent extends Node {
  readonly _tag: 'DurationComponent'
  readonly magnitude: bigint
  readonly unit: 'w' | 'd' | 'h' | 'm' | 's' | 'ms' | 'us' | 'ns'
}

export type Literal =
  | IntegerLiteral
  | TextLiteral
  | (Node &
      (
        | {
            readonly _tag: 'FloatingLiteral'
            readonly sign: 'Positive' | 'Negative'
            readonly coefficient: bigint
            readonly exponent: bigint
            readonly suffix: AuthoredPool.TextRef | undefined
          }
        | {
            readonly _tag: 'DurationLiteral'
            readonly components: ReadonlyArray<DurationComponent>
          }
        | { readonly _tag: 'BytesLiteral'; readonly value: AuthoredPool.BytesRef }
        | { readonly _tag: 'CharacterLiteral'; readonly scalar: number }
        | { readonly _tag: 'BooleanLiteral'; readonly value: boolean }
        | { readonly _tag: 'UnitLiteral' }
      ))

export interface MissingExpression extends Node {
  readonly _tag: 'MissingExpression'
  readonly causes: RecoveryCauses
}

export interface InvalidExpression extends Node {
  readonly _tag: 'InvalidExpression'
  readonly causes: RecoveryCauses
  readonly retained: ReadonlyArray<Expression>
}

export interface FieldInitializer extends Node {
  readonly _tag: 'FieldInitializer'
  readonly name: Name
  readonly value: Expression
}

export interface MemberSelector extends Node {
  readonly _tag: 'MemberSelector'
  readonly subject: Type
  readonly member: Name
}

export type PrefixOperator = 'Negate' | 'Not' | 'BitwiseNot'
export type InfixOperator =
  | 'Add'
  | 'Subtract'
  | 'Multiply'
  | 'Divide'
  | 'Remainder'
  | 'Equals'
  | 'NotEquals'
  | 'LessThan'
  | 'LessOrEqual'
  | 'GreaterThan'
  | 'GreaterOrEqual'
  | 'And'
  | 'Or'
  | 'BitAnd'
  | 'BitOr'
  | 'BitXor'

export type Expression =
  | Literal
  | MissingExpression
  | InvalidExpression
  | (Node &
      (
        | {
            readonly _tag: 'IdentifierExpression'
            readonly name: Name
            readonly binding: LexicalReference | undefined
          }
        | { readonly _tag: 'MoveExpression'; readonly operand: Expression }
        | {
            readonly _tag: 'BorrowExpression'
            readonly access: Access
            readonly operand: Expression
          }
        | {
            readonly _tag: 'CallableExpression'
            readonly contract: CallableContract
            readonly body: Block
          }
        | { readonly _tag: 'EffectExpression'; readonly body: Block }
        | { readonly _tag: 'RunExpression'; readonly operand: Expression }
        | { readonly _tag: 'UnsafeExpression'; readonly operand: Expression }
        | { readonly _tag: 'CompileErrorExpression'; readonly message: Expression }
        | {
            readonly _tag: 'MatchExpression'
            readonly access: 'Default' | 'Place' | 'Move' | Access
            readonly subject: Expression
            readonly arms: ReadonlyArray<MatchArm>
          }
        | {
            readonly _tag: 'StructExpression'
            readonly type: Type
            readonly fields: ReadonlyArray<FieldInitializer>
          }
        | { readonly _tag: 'TupleExpression'; readonly elements: ReadonlyArray<Expression> }
        | { readonly _tag: 'RecordExpression'; readonly fields: ReadonlyArray<FieldInitializer> }
        | { readonly _tag: 'ArrayExpression'; readonly elements: ReadonlyArray<Expression> }
        | {
            readonly _tag: 'MemberExpression'
            readonly selector: MemberSelector
            readonly fields: ReadonlyArray<FieldInitializer> | undefined
          }
        | { readonly _tag: 'FieldExpression'; readonly subject: Expression; readonly field: Name }
        | {
            readonly _tag: 'OrdinalExpression'
            readonly subject: Expression
            readonly ordinal: IntegerLiteral | MissingExpression | InvalidExpression
          }
        | { readonly _tag: 'ReferentExpression'; readonly subject: Expression }
        | {
            readonly _tag: 'IndexExpression'
            readonly subject: Expression
            readonly index: Expression
          }
        | {
            readonly _tag: 'CallExpression'
            readonly callee: Expression
            readonly generics: TypeArguments | undefined
            readonly arguments: ReadonlyArray<Expression>
          }
        | {
            readonly _tag: 'PrefixExpression'
            readonly operator: PrefixOperator
            /** Where the operator itself is written, so a diagnostic about it names that token. */
            readonly operatorAnchor: Anchor
            readonly operand: Expression
          }
        | {
            readonly _tag: 'InfixExpression'
            readonly operator: InfixOperator
            /** Where the operator itself is written, so a diagnostic about it names that token. */
            readonly operatorAnchor: Anchor
            readonly left: Expression
            readonly right: Expression
          }
        | {
            readonly _tag: 'PipelineExpression'
            readonly input: Expression
            readonly target: Expression
          }
      ))

export interface PatternField extends Node {
  readonly _tag: 'PatternField'
  readonly name: Name
  /** A shorthand is represented by a binding pattern with the same owned name. */
  readonly pattern: Pattern
}

export type Pattern = Node &
  (
    | { readonly _tag: 'EnumPattern'; readonly path: Path }
    | { readonly _tag: 'IntegerPattern'; readonly value: IntegerLiteral }
    | {
        readonly _tag: 'NominalPattern'
        readonly type: Type
        readonly fields: ReadonlyArray<PatternField | RestPattern>
      }
    | {
        readonly _tag: 'BindingPattern'
        readonly type: Type | undefined
        readonly name: Name
      }
    | { readonly _tag: 'UniversalPattern'; readonly name: Name | undefined }
    | {
        readonly _tag: 'VariantPattern'
        readonly selector: MemberSelector
        readonly fields: ReadonlyArray<PatternField | RestPattern> | undefined
      }
    | { readonly _tag: 'MissingPattern'; readonly causes: RecoveryCauses }
    | {
        readonly _tag: 'InvalidPattern'
        readonly causes: RecoveryCauses
        readonly retained: ReadonlyArray<Pattern | Type | Name>
      }
  )

export interface RestPattern extends Node {
  readonly _tag: 'RestPattern'
}

export interface MatchArm extends Node {
  readonly _tag: 'MatchArm'
  readonly pattern: Pattern
  readonly guard: Expression | undefined
  readonly result: Expression | Block
}

export interface Block extends Node {
  readonly _tag: 'Block'
  readonly statements: ReadonlyArray<Statement>
}

export type Conditional = Node &
  (
    | {
        readonly _tag: 'ConditionalStatement'
        readonly condition: Expression
        readonly thenBranch: Block
        readonly elseBranch: Block | Conditional | undefined
      }
    | {
        readonly _tag: 'PatternConditionalStatement'
        readonly pattern: Pattern
        readonly subject: Expression
        readonly thenBranch: Block
        readonly elseBranch: Block | Conditional | undefined
      }
    | {
        readonly _tag: 'StaticConditionalStatement'
        readonly condition: Expression
        readonly thenBranch: Block
        readonly elseBranch: Block | Conditional | undefined
      }
  )

export type Statement =
  | Conditional
  | (Node &
      (
        | { readonly _tag: 'ExpressionStatement'; readonly expression: Expression }
        | {
            readonly _tag: 'BindingStatement'
            readonly name: Name
            readonly mutable: boolean
            readonly static: boolean
            readonly type: Type | undefined
            readonly initializer: Expression
          }
        | {
            readonly _tag: 'PatternBindingStatement'
            readonly pattern: Pattern
            readonly initializer: Expression
          }
        | {
            readonly _tag: 'AssignmentStatement'
            readonly target: Expression
            readonly value: Expression
          }
        | {
            readonly _tag: 'StaticForStatement'
            readonly binding: Name
            readonly iterable: Expression
            readonly body: Block
          }
        | { readonly _tag: 'WhileStatement'; readonly condition: Expression; readonly body: Block }
        | { readonly _tag: 'BreakStatement' }
        | { readonly _tag: 'ContinueStatement' }
        | { readonly _tag: 'ReturnStatement'; readonly value: Expression | undefined }
        | { readonly _tag: 'FailStatement'; readonly move: boolean; readonly value: Expression }
        | { readonly _tag: 'DropStatement'; readonly value: Expression }
        | { readonly _tag: 'UnsafeStatement'; readonly body: Block }
        | { readonly _tag: 'MissingStatement'; readonly causes: RecoveryCauses }
        | {
            readonly _tag: 'InvalidStatement'
            readonly causes: RecoveryCauses
            readonly retained: ReadonlyArray<Statement | Expression>
          }
      ))

export interface ImportMember extends Node {
  readonly _tag: 'ImportMember'
  readonly name: Name
  readonly alias: Name | undefined
}

export interface Field extends Node {
  readonly _tag: 'Field'
  readonly name: Name
  readonly public: boolean
  readonly type: Type
}

export interface EnumMember extends Node {
  readonly _tag: 'EnumMember'
  readonly name: Name
  readonly value: Expression | undefined
}

export interface Variant extends Node {
  readonly _tag: 'Variant'
  readonly name: Name
  readonly fields: ReadonlyArray<Field>
  /**
   * Whether the variant was written with a field block. A variant with no braces is a unit; one
   * with empty braces is a distinct mistake, so `fields` alone cannot tell them apart.
   */
  readonly braces: boolean
}

export interface Linkage extends Node {
  readonly _tag: 'Linkage'
  readonly direction: 'Import' | 'Export'
  readonly abi: TextLiteral | MissingExpression | InvalidExpression
  readonly symbol: TextLiteral | MissingExpression | InvalidExpression | undefined
}

export interface NamedHeader extends Node {
  readonly name: Name
  readonly public: boolean
}

export type DeclarationHeader =
  | (Node &
      (
        | {
            readonly _tag: 'ImportHeader'
            readonly public: boolean
            readonly path: Path
            readonly alias: Name | undefined
            readonly members: ReadonlyArray<ImportMember> | undefined
          }
        | { readonly _tag: 'ConditionalHeader'; readonly condition: Expression }
        | { readonly _tag: 'GroupHeader'; readonly branch: 'Then' | 'Else' }
        | {
            readonly _tag: 'ModulePropertyHeader'
            readonly properties: ReadonlyArray<PropertyClause>
          }
        | {
            readonly _tag: 'ImplHeader'
            readonly generics: ReadonlyArray<GenericParameter>
            readonly subject: Type
            readonly target: Type | undefined
          }
        | { readonly _tag: 'MissingDeclarationHeader'; readonly causes: RecoveryCauses }
        | {
            readonly _tag: 'InvalidDeclarationHeader'
            readonly causes: RecoveryCauses
            readonly retained: ReadonlyArray<DeclarationHeader>
          }
      ))
  | (NamedHeader &
      (
        | {
            readonly _tag: 'FunctionHeader'
            readonly contract: CallableContract
            readonly linkage: Linkage | undefined
            readonly properties: ReadonlyArray<PropertyClause>
          }
        | {
            readonly _tag: 'OperationHeader'
            readonly contract: CallableContract
            readonly operator: Name | undefined
            readonly properties: ReadonlyArray<PropertyClause>
          }
        | { readonly _tag: 'ImplAliasHeader'; readonly target: Path }
        | {
            readonly _tag: 'StructHeader'
            readonly generics: ReadonlyArray<GenericParameter>
            /** The written binder list including its brackets, so a diagnostic can name it whole. */
            readonly genericsAnchor: Anchor | undefined
            readonly fields: ReadonlyArray<Field>
            readonly abi: TextLiteral | MissingExpression | InvalidExpression | undefined
          }
        | {
            readonly _tag: 'TupleHeader'
            readonly generics: ReadonlyArray<GenericParameter>
            readonly elements: ReadonlyArray<Type>
          }
        | {
            readonly _tag: 'EnumHeader'
            readonly representation: Type | undefined
            readonly members: ReadonlyArray<EnumMember>
          }
        | {
            readonly _tag: 'UnionHeader'
            readonly generics: ReadonlyArray<GenericParameter>
            readonly variants: ReadonlyArray<Variant>
          }
        | {
            readonly _tag: 'ServiceHeader'
            readonly generics: ReadonlyArray<GenericParameter>
          }
        | {
            readonly _tag: 'InterfaceHeader'
            readonly generics: ReadonlyArray<GenericParameter>
          }
        | { readonly _tag: 'RoleHeader' }
        | { readonly _tag: 'ConstantHeader'; readonly type: Type | undefined }
        | { readonly _tag: 'PackageParameterHeader'; readonly type: Type }
        | {
            readonly _tag: 'AliasHeader'
            readonly generics: ReadonlyArray<GenericParameter>
            readonly target: Type
          }
        | {
            readonly _tag: 'StaticHeader'
            readonly type: Type
            readonly mutable: boolean
            readonly linkage: Linkage
            readonly properties: ReadonlyArray<PropertyClause>
          }
      ))

/** Child owners keep independent header/body content, including inactive branches. */
export type DeclarationBody =
  | { readonly _tag: 'NoBody' }
  | { readonly _tag: 'CallableBody'; readonly block: Block | undefined }
  | { readonly _tag: 'InitializerBody'; readonly value: Expression | undefined }
  | {
      readonly _tag: 'PackageParameterBody'
      readonly default: Expression | undefined
      readonly validation: Expression | undefined
    }
  | { readonly _tag: 'MembersBody'; readonly members: ReadonlyArray<Declaration> }
  | {
      readonly _tag: 'ConditionalBody'
      readonly thenBranch: Declaration
      readonly elseBranch: Declaration | undefined
    }
  | {
      readonly _tag: 'InvalidDeclarationBody'
      readonly causes: RecoveryCauses
      readonly retained: ReadonlyArray<Declaration | Statement | Expression>
    }

export interface Declaration {
  readonly _tag: 'Declaration'
  readonly owner: AuthoredIdentity.Identity
  readonly header: DeclarationHeader
  readonly body: DeclarationBody
}

/** Module publication owns the pool and every nested immutable semantic record. */
export interface Module {
  readonly _tag: 'AuthoredModule'
  readonly owner: AuthoredIdentity.Identity
  readonly pool: AuthoredPool.Pool
  readonly declarations: ReadonlyArray<Declaration>
}

/** Closed vocabulary used by canonical encoding and publication. */
export type Record =
  | LexicalReference
  | Origin
  | Cause
  | Name
  | Path
  | GenericParameter
  | Lifetime
  | RequirementSelector
  | TypeArguments
  | Requirement
  | RequirementRow
  | PointerQualifier
  | Type
  | Constraint
  | Parameter
  | CallableContract
  | Property
  | PropertyClause
  | Expression
  | DurationComponent
  | FieldInitializer
  | MemberSelector
  | PatternField
  | Pattern
  | RestPattern
  | MatchArm
  | Block
  | Statement
  | ImportMember
  | Field
  | EnumMember
  | Variant
  | Linkage
  | DeclarationHeader
  | DeclarationBody
  | Declaration
  | Module

const nodeFields = ['anchor', 'origin', 'causes'] as const
const namedFields = [...nodeFields, 'name', 'public'] as const

const freezeFieldRegistry = <Registry extends { readonly [key: string]: ReadonlyArray<string> }>(
  registry: Registry,
): Readonly<Registry> => {
  return registry
}

/** Fixed field order; consumers never enumerate arbitrary object properties. */
export const fields = freezeFieldRegistry({
  LexicalReference: ['owner', 'path'],
  Authored: [],
  Synthetic: ['anchor', 'role', 'occurrence'],
  Cause: ['anchor', 'code'],
  Name: [...nodeFields, 'text'],
  MissingName: nodeFields,
  InvalidName: [...nodeFields, 'spelling'],
  Path: [...nodeFields, 'segments'],
  TypeParameter: [...nodeFields, 'name', 'bounds'],
  RowParameter: [...nodeFields, 'name'],
  LifetimeParameter: [...nodeFields, 'name', 'bounds', 'invocationUse'],
  Lifetime: [...nodeFields, 'name'],
  RequirementSelector: [...nodeFields, 'subject', 'role'],
  TypeArguments: [...nodeFields, 'arguments', 'environment', 'failures', 'requirements'],
  Requirement: [...nodeFields, 'access', 'capability', 'role'],
  RequirementRow: [...nodeFields, 'members'],
  PointerQualifier: [...nodeFields, 'name', 'value'],
  NamedType: [...nodeFields, 'path', 'mode'],
  AppliedType: [...nodeFields, 'target', 'arguments'],
  FixedArrayType: [...nodeFields, 'element', 'length'],
  SliceType: [...nodeFields, 'element', 'access', 'lifetime'],
  ReferenceType: [...nodeFields, 'referent', 'access', 'lifetime', 'role'],
  PointerType: [...nodeFields, 'pointee', 'access', 'nullable', 'multiplicity', 'qualifiers'],
  CallableType: [...nodeFields, 'mode', 'unsafe', 'binders', 'environment', 'parameters', 'result'],
  ForeignFunctionType: [...nodeFields, 'abi', 'binders', 'parameters', 'result', 'properties'],
  ExactRepresentationType: [...nodeFields, 'subject'],
  OpaqueResultType: [...nodeFields, 'binders', 'result'],
  UnitType: nodeFields,
  UnionType: [...nodeFields, 'members'],
  RowWithout: [...nodeFields, 'source', 'removed'],
  MissingType: nodeFields,
  InvalidType: [...nodeFields, 'retained'],
  MembershipConstraint: [...nodeFields, 'subject', 'source'],
  ProviderConstraint: [...nodeFields, 'provider', 'selected', 'source'],
  Parameter: [...nodeFields, 'name', 'type', 'mode'],
  CallableContract: [
    ...nodeFields,
    'generics',
    'parameters',
    'variadic',
    'result',
    'failures',
    'requirements',
    'constraints',
    'effect',
    'test',
    'environment',
    'unsafe',
    'static',
    'effectAnchor',
    'testAnchor',
    'unsafeAnchor',
    'staticAnchor',
    'genericsAnchor',
    'failuresAnchor',
    'constraintsAnchor',
  ],
  Property: [...nodeFields, 'name', 'value'],
  PropertyClause: [...nodeFields, 'namespace', 'operation', 'properties'],
  IntegerLiteral: [...nodeFields, 'value', 'radix', 'suffix'],
  TextLiteral: [...nodeFields, 'value'],
  FloatingLiteral: [...nodeFields, 'sign', 'coefficient', 'exponent', 'suffix'],
  DurationLiteral: [...nodeFields, 'components'],
  DurationComponent: [...nodeFields, 'magnitude', 'unit'],
  BytesLiteral: [...nodeFields, 'value'],
  CharacterLiteral: [...nodeFields, 'scalar'],
  BooleanLiteral: [...nodeFields, 'value'],
  UnitLiteral: nodeFields,
  MissingExpression: nodeFields,
  InvalidExpression: [...nodeFields, 'retained'],
  FieldInitializer: [...nodeFields, 'name', 'value'],
  MemberSelector: [...nodeFields, 'subject', 'member'],
  IdentifierExpression: [...nodeFields, 'name', 'binding'],
  MoveExpression: [...nodeFields, 'operand'],
  BorrowExpression: [...nodeFields, 'access', 'operand'],
  CallableExpression: [...nodeFields, 'contract', 'body'],
  EffectExpression: [...nodeFields, 'body'],
  RunExpression: [...nodeFields, 'operand'],
  UnsafeExpression: [...nodeFields, 'operand'],
  CompileErrorExpression: [...nodeFields, 'message'],
  MatchExpression: [...nodeFields, 'access', 'subject', 'arms'],
  StructExpression: [...nodeFields, 'type', 'fields'],
  TupleExpression: [...nodeFields, 'elements'],
  RecordExpression: [...nodeFields, 'fields'],
  ArrayExpression: [...nodeFields, 'elements'],
  MemberExpression: [...nodeFields, 'selector', 'fields'],
  FieldExpression: [...nodeFields, 'subject', 'field'],
  OrdinalExpression: [...nodeFields, 'subject', 'ordinal'],
  ReferentExpression: [...nodeFields, 'subject'],
  IndexExpression: [...nodeFields, 'subject', 'index'],
  CallExpression: [...nodeFields, 'callee', 'generics', 'arguments'],
  PrefixExpression: [...nodeFields, 'operator', 'operatorAnchor', 'operand'],
  InfixExpression: [...nodeFields, 'operator', 'operatorAnchor', 'left', 'right'],
  PipelineExpression: [...nodeFields, 'input', 'target'],
  PatternField: [...nodeFields, 'name', 'pattern'],
  EnumPattern: [...nodeFields, 'path'],
  IntegerPattern: [...nodeFields, 'value'],
  NominalPattern: [...nodeFields, 'type', 'fields'],
  BindingPattern: [...nodeFields, 'type', 'name'],
  UniversalPattern: [...nodeFields, 'name'],
  VariantPattern: [...nodeFields, 'selector', 'fields'],
  MissingPattern: nodeFields,
  InvalidPattern: [...nodeFields, 'retained'],
  RestPattern: nodeFields,
  MatchArm: [...nodeFields, 'pattern', 'guard', 'result'],
  Block: [...nodeFields, 'statements'],
  ConditionalStatement: [...nodeFields, 'condition', 'thenBranch', 'elseBranch'],
  PatternConditionalStatement: [...nodeFields, 'pattern', 'subject', 'thenBranch', 'elseBranch'],
  StaticConditionalStatement: [...nodeFields, 'condition', 'thenBranch', 'elseBranch'],
  ExpressionStatement: [...nodeFields, 'expression'],
  BindingStatement: [...nodeFields, 'name', 'mutable', 'static', 'type', 'initializer'],
  PatternBindingStatement: [...nodeFields, 'pattern', 'initializer'],
  AssignmentStatement: [...nodeFields, 'target', 'value'],
  StaticForStatement: [...nodeFields, 'binding', 'iterable', 'body'],
  WhileStatement: [...nodeFields, 'condition', 'body'],
  BreakStatement: nodeFields,
  ContinueStatement: nodeFields,
  ReturnStatement: [...nodeFields, 'value'],
  FailStatement: [...nodeFields, 'move', 'value'],
  DropStatement: [...nodeFields, 'value'],
  UnsafeStatement: [...nodeFields, 'body'],
  MissingStatement: nodeFields,
  InvalidStatement: [...nodeFields, 'retained'],
  ImportMember: [...nodeFields, 'name', 'alias'],
  Field: [...nodeFields, 'name', 'public', 'type'],
  EnumMember: [...nodeFields, 'name', 'value'],
  Variant: [...nodeFields, 'name', 'fields', 'braces'],
  Linkage: [...nodeFields, 'direction', 'abi', 'symbol'],
  ImportHeader: [...nodeFields, 'public', 'path', 'alias', 'members'],
  ConditionalHeader: [...nodeFields, 'condition'],
  GroupHeader: [...nodeFields, 'branch'],
  ModulePropertyHeader: [...nodeFields, 'properties'],
  ImplHeader: [...nodeFields, 'generics', 'subject', 'target'],
  MissingDeclarationHeader: nodeFields,
  InvalidDeclarationHeader: [...nodeFields, 'retained'],
  FunctionHeader: [...namedFields, 'contract', 'linkage', 'properties'],
  OperationHeader: [...namedFields, 'contract', 'operator', 'properties'],
  ImplAliasHeader: [...namedFields, 'target'],
  StructHeader: [...namedFields, 'generics', 'genericsAnchor', 'fields', 'abi'],
  TupleHeader: [...namedFields, 'generics', 'elements'],
  EnumHeader: [...namedFields, 'representation', 'members'],
  UnionHeader: [...namedFields, 'generics', 'variants'],
  ServiceHeader: [...namedFields, 'generics'],
  InterfaceHeader: [...namedFields, 'generics'],
  RoleHeader: namedFields,
  ConstantHeader: [...namedFields, 'type'],
  PackageParameterHeader: [...namedFields, 'type'],
  AliasHeader: [...namedFields, 'generics', 'target'],
  StaticHeader: [...namedFields, 'type', 'mutable', 'linkage', 'properties'],
  NoBody: [],
  CallableBody: ['block'],
  InitializerBody: ['value'],
  PackageParameterBody: ['default', 'validation'],
  MembersBody: ['members'],
  ConditionalBody: ['thenBranch', 'elseBranch'],
  InvalidDeclarationBody: ['causes', 'retained'],
  Declaration: ['owner', 'header', 'body'],
  AuthoredModule: ['owner', 'pool', 'declarations'],
} as const satisfies {
  readonly [Tag in Record['_tag']]: ReadonlyArray<
    Exclude<keyof Extract<Record, { readonly _tag: Tag }>, '_tag'>
  >
})

type MissingFields = {
  [Tag in Record['_tag']]: Exclude<
    keyof Extract<Record, { readonly _tag: Tag }>,
    '_tag' | (typeof fields)[Tag][number]
  >
}[Record['_tag']]

/** Adding a semantic field without declaring its encoding order is a type error. */
export const completeFieldOrder: MissingFields extends never ? true : never = true

type OptionalKeys<Value> = {
  [Key in keyof Value]-?: undefined extends Value[Key] ? Key : never
}[keyof Value]

/** Only these declared fields may carry the explicit absence marker. */
export const optionalFields = freezeFieldRegistry({
  LifetimeParameter: ['invocationUse'],
  IdentifierExpression: ['binding'],
  TypeArguments: ['environment', 'failures', 'requirements'],
  Requirement: ['access', 'role'],
  NamedType: ['mode'],
  SliceType: ['lifetime'],
  ReferenceType: ['lifetime', 'role'],
  CallableType: ['environment'],
  CallableContract: [
    'result',
    'failures',
    'requirements',
    'environment',
    'effectAnchor',
    'testAnchor',
    'unsafeAnchor',
    'staticAnchor',
    'genericsAnchor',
    'failuresAnchor',
    'constraintsAnchor',
  ],
  IntegerLiteral: ['suffix'],
  FloatingLiteral: ['suffix'],
  MemberExpression: ['fields'],
  CallExpression: ['generics'],
  BindingPattern: ['type'],
  UniversalPattern: ['name'],
  VariantPattern: ['fields'],
  MatchArm: ['guard'],
  ConditionalStatement: ['elseBranch'],
  PatternConditionalStatement: ['elseBranch'],
  StaticConditionalStatement: ['elseBranch'],
  BindingStatement: ['type'],
  ReturnStatement: ['value'],
  ImportMember: ['alias'],
  EnumMember: ['value'],
  Linkage: ['symbol'],
  ImportHeader: ['alias', 'members'],
  ImplHeader: ['target'],
  FunctionHeader: ['linkage'],
  OperationHeader: ['operator'],
  StructHeader: ['genericsAnchor', 'abi'],
  EnumHeader: ['representation'],
  ConstantHeader: ['type'],
  CallableBody: ['block'],
  InitializerBody: ['value'],
  PackageParameterBody: ['default', 'validation'],
  ConditionalBody: ['elseBranch'],
} as const satisfies {
  readonly [Tag in Record['_tag']]?: ReadonlyArray<
    OptionalKeys<Extract<Record, { readonly _tag: Tag }>>
  >
})

type DeclaredOptional<Tag extends Record['_tag']> = Tag extends keyof typeof optionalFields
  ? (typeof optionalFields)[Tag][number]
  : never

type MissingOptionalFields = {
  [Tag in Record['_tag']]: Exclude<
    OptionalKeys<Extract<Record, { readonly _tag: Tag }>>,
    DeclaredOptional<Tag>
  >
}[Record['_tag']]

/** Keep absence metadata synchronized with every tagged record's field types. */
export const completeOptionalFields: MissingOptionalFields extends never ? true : never = true
