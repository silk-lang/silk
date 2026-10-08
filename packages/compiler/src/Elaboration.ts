import * as Location from './Location.js'
import type * as NativeAssembly from './NativeAssembly.js'
import type * as AuthoredHir from './AuthoredHir.js'
import * as AuthoredIdentity from './AuthoredIdentity.js'
import * as AuthoredLowering from './AuthoredLowering.js'
import * as SemanticContext from './SemanticContext.js'
import type * as CompilerTrace from './CompilerTrace.js'
import * as Semantic from './Semantic.js'
import * as BodyQuery from './BodyQuery.js'
import * as BodyBuilder from './BodyBuilder.js'
import * as LifetimeFlow from './LifetimeFlow.js'
import { dual } from 'effect/Function'
import type * as CallableContract from './CallableContract.js'
import * as ConformanceProof from './ConformanceProof.js'
import type * as ConformanceGoal from './ConformanceGoal.js'
import type * as Constraint from './Constraint.js'
import * as DeclarationFacts from './DeclarationFacts.js'
import type * as DeclarationIndex from './DeclarationIndex.js'
import * as Diagnostic from './Diagnostic.js'
import * as Tir from './Tir.js'
import type * as Intrinsic from './Intrinsic.js'
import type * as Match from './Match.js'
import type * as NameResolution from './NameResolution.js'
import type * as Operator from './Operator.js'
import * as Scalar from './Scalar.js'
import * as SourceSpan from './SourceSpan.js'
import type * as Evaluation from './Evaluation.js'
import type * as StaticText from './StaticText.js'
import type * as StaticValue from './StaticValue.js'
import * as Lifetime from './Lifetime.js'
import * as SemanticDisplay from './SemanticDisplay.js'
import * as Type from './Type.js'
import * as TypeCompatibility from './TypeCompatibility.js'

/** The only semantic type recognized by the first analysis slice. */
export type SemanticType = DeclarationFacts.SemanticType

/** A deterministic declaration identity local to one analyzed source snapshot. */
export type DeclarationId = DeclarationFacts.DeclarationId

/** A deterministic parameter identity nested under its owning function declaration. */
export type ParameterId = DeclarationFacts.ParameterId

/** A declaration name supplied by syntax or explicitly unavailable after recovery. */
export type DeclaredName = DeclarationFacts.DeclaredName

/** The resolved, unresolved, or syntax-unavailable declared return type. */
export type DeclaredTypeFact = DeclarationFacts.DeclaredTypeFact

/** The declared type fact attached to a function return. */
export type ReturnTypeFact = DeclarationFacts.ReturnTypeFact

/** One ordered parameter declaration with exact concrete provenance. */
export type ParameterFact = DeclarationFacts.ParameterFact

/** The closed result of looking up a parameter spelling within one function. */
export type ParameterLookup = DeclarationFacts.ParameterLookup

/** One `let` binding declaration with its inferred type and initializer facts. */
export interface BindingDeclarationFact {
  readonly _tag: 'BindingFact'
  readonly id: Tir.BindingId
  readonly name: DeclaredName
  readonly phase: 'Runtime' | 'Static'
  readonly mutability: 'Immutable' | 'Mutable'
  readonly declaredType?: DeclaredTypeFact
  readonly inferredType: ExpressionTypeFact
  readonly initializer: Tir.Expression
  readonly staticValue?: StaticValue.Value
  /** This binding is one immutable element selected by an expanded `static for`. */
  readonly staticIteration?: true
  /** Exact callable value captured when this binding was initialized, before later source writes. */
  readonly exactCallable?: Extract<
    ExpressionDecision,
    { readonly _tag: 'FunctionItem' | 'CallableSection' }
  >
  /** Whether the initialized value has one compile-time concrete callable representation. */
  readonly concreteCallableIdentity?: true
  readonly anchor: AuthoredHir.Anchor
}

/** One independently elaborated lexical scope produced by a selected static iteration. */
export interface StaticIterationScopeFact {
  readonly _tag: 'StaticIterationScope'
  readonly ordinal: number
  readonly binding: BindingDeclarationFact
  readonly statements: ReadonlyArray<Tir.Statement>
  readonly staticIterations: ReadonlyArray<StaticIterationFact>
}

/** The authored static iteration plus its target-selected semantic expansion. */
export interface StaticIterationFact {
  readonly _tag: 'StaticIteration'
  readonly iterable: Tir.Expression
  readonly state: 'Deferred' | 'Rejected' | 'Expanded'
  readonly scopes: ReadonlyArray<StaticIterationScopeFact>
  readonly anchor: AuthoredHir.Anchor
}

/** A bare identifier resolved against enclosing parameters and preceding bindings. */
export type ParameterReferenceFact =
  | {
      readonly _tag: 'Resolved'
      readonly spelling: string
      readonly anchor: AuthoredHir.Anchor
      readonly parameter: ParameterFact
    }
  | {
      readonly _tag: 'ResolvedBinding'
      readonly spelling: string
      readonly anchor: AuthoredHir.Anchor
      readonly binding: BindingDeclarationFact
    }
  | {
      readonly _tag: 'ResolvedPattern'
      readonly spelling: string
      readonly anchor: AuthoredHir.Anchor
      readonly binding: PatternBindingFact
    }
  | {
      readonly _tag: 'Missing'
      readonly spelling: string
      readonly anchor: AuthoredHir.Anchor
      readonly cause?: Diagnostic.Identity<Location.Location>
    }
  | {
      readonly _tag: 'Ambiguous'
      readonly spelling: string
      readonly anchor: AuthoredHir.Anchor
      readonly parameters: ReadonlyArray<ParameterFact>
    }
  | {
      readonly _tag: 'Unavailable'
      readonly anchor: AuthoredHir.Anchor
    }

/** The available, out-of-range, or syntax-unavailable integer-expression fact. */
export type IntegerExpressionDecision =
  | {
      readonly _tag: 'Available'
      readonly type: SemanticType
      readonly value: bigint
      readonly anchor: AuthoredHir.Anchor
    }
  | {
      readonly _tag: 'OutOfRange'
      readonly type: SemanticType
      readonly spelling: string
      readonly anchor: AuthoredHir.Anchor
    }
  | {
      readonly _tag: 'Unavailable'
      readonly anchor: AuthoredHir.Anchor
    }

/** One fixed-`u64` duration expression after exact nanosecond scaling. */
export interface DurationExpressionDecision {
  readonly _tag: 'Duration'
  readonly value?: bigint
  readonly spelling?: string
  readonly type: ExpressionTypeFact
  readonly anchor: AuthoredHir.Anchor
}

export type FloatingExpressionDecision =
  | {
      readonly _tag: 'Available'
      readonly type: Scalar.FloatSpelling
      readonly bits: bigint
      readonly spelling: string
      readonly anchor: AuthoredHir.Anchor
    }
  | { readonly _tag: 'Unavailable'; readonly anchor: AuthoredHir.Anchor }

export interface StaticTextExpressionDecision {
  readonly _tag: 'StaticText'
  readonly data?: StaticText.Data
  readonly type: ExpressionTypeFact
  /**
   * The authored text literal this fact wraps directly, when it wraps one.
   *
   * Caller provenance for a compile error points inside the literal the caller wrote, which is a
   * narrower position than the expression the fact is anchored to once the value flows through a
   * parameter. Only a fact built straight from a literal can name it.
   */
  readonly literal?: AuthoredHir.Anchor
  readonly anchor: AuthoredHir.Anchor
}

/** One character literal carrying the single Unicode scalar value its body denotes. */
export interface CharacterExpressionDecision {
  readonly _tag: 'Character'
  readonly value?: number
  readonly type: ExpressionTypeFact
  readonly anchor: AuthoredHir.Anchor
}

/** One dedicated selected compile-time failure expression. */
export interface CompileErrorExpressionDecision {
  readonly _tag: 'CompileError'
  readonly message: Tir.Expression
  readonly type: ExpressionTypeFact
  readonly anchor: AuthoredHir.Anchor
}

/** A call callee resolved against top-level declarations or unavailable after syntax recovery. */
export type CallReferenceFact =
  | {
      readonly _tag: 'Resolved'
      readonly spelling: string
      readonly anchor: AuthoredHir.Anchor
      readonly declaration: DeclarationFact
    }
  | {
      readonly _tag: 'ResolvedBuiltin'
      readonly assembly?: NativeAssembly.NativeAssembly
      readonly spelling: string
      readonly anchor: AuthoredHir.Anchor
      readonly actor: string
      readonly operation: Tir.BuiltinOperation
      readonly intrinsic: Intrinsic.OperationId
      readonly parameters: ReadonlyArray<SemanticType>
      readonly result: SemanticType
      readonly unsafe: boolean
    }
  | {
      readonly _tag: 'ResolvedEnumOperation'
      readonly spelling: string
      readonly anchor: AuthoredHir.Anchor
      readonly operation: DeclarationFacts.EnumAssociatedOperationFact
    }
  | {
      readonly _tag: 'ResolvedEnumEquality'
      readonly spelling: string
      readonly anchor: AuthoredHir.Anchor
      readonly enum: DeclarationFacts.CanonicalId
      readonly operator: 'Equals' | 'NotEquals'
    }
  | {
      readonly _tag: 'ResolvedIntrinsicContract'
      readonly spelling: string
      readonly anchor: AuthoredHir.Anchor
      readonly intrinsic: Intrinsic.Operation
      readonly contract: CallableContract.CallableContract
    }
  | {
      readonly _tag: 'ResolvedServiceOperation'
      readonly spelling: string
      readonly anchor: AuthoredHir.Anchor
      readonly service: DeclarationFacts.ServiceFact
      readonly operation: DeclarationFacts.ServiceOperationFact
    }
  /**
   * One statically selected interface operation. The normalized capability and provider identify
   * the conformance question; which implementation runs is the witness's answer at specialization,
   * not one this reference records.
   */
  | {
      readonly _tag: 'ResolvedInterfaceOperation'
      readonly spelling: string
      readonly anchor: AuthoredHir.Anchor
      readonly capability: Type.Nominal
      readonly provider: Type.Type
      readonly operation: string
      readonly declaration: DeclarationFacts.ServiceOperationFact
      readonly interfaceContract: DeclarationFacts.InterfaceOperationApplicationFact
      readonly parameters: ReadonlyArray<SemanticType>
      readonly result: SemanticType
    }
  | {
      readonly _tag: 'Missing'
      readonly spelling: string
      readonly anchor: AuthoredHir.Anchor
      readonly cause?: Diagnostic.Identity<Location.Location>
    }
  | {
      readonly _tag: 'Ambiguous'
      readonly spelling: string
      readonly anchor: AuthoredHir.Anchor
      readonly declarations: ReadonlyArray<DeclarationFact>
      readonly cause?: Diagnostic.Identity<Location.Location>
    }
  | {
      readonly _tag: 'Unavailable'
      readonly anchor: AuthoredHir.Anchor
    }

/** Exact qualifier and member spellings retained beside semantic reference resolution. */
export type ReferencePathFact =
  | {
      readonly _tag: 'ReferencePath'
      readonly qualifierSpelling?: string
      readonly qualifierAnchor?: AuthoredHir.Anchor
      readonly memberSpelling: string
      readonly memberAnchor: AuthoredHir.Anchor
    }
  | { readonly _tag: 'UnavailableReferencePath'; readonly anchor: AuthoredHir.Anchor }

/** Exact source tokens and catalog identity for one recognized intrinsic member path. */
export type IntrinsicReferenceFact =
  | {
      readonly _tag: 'ResolvedIntrinsicReference'
      readonly actor: Intrinsic.Actor
      readonly operation: Intrinsic.Operation
      readonly actorAnchor: AuthoredHir.Anchor
      readonly operationAnchor: AuthoredHir.Anchor
    }
  | {
      readonly _tag: 'ResolvedCapabilityOperationReference'
      readonly actor: DeclarationFacts.StructFact | Intrinsic.Actor
      readonly operation: Intrinsic.Operation
      readonly actorAnchor: AuthoredHir.Anchor
      readonly operationAnchor: AuthoredHir.Anchor
    }
  | { readonly _tag: 'UnavailableIntrinsicReference'; readonly anchor: AuthoredHir.Anchor }

/** The available or unavailable type of one returned expression. */
export type ExpressionTypeFact =
  | { readonly _tag: 'Available'; readonly type: SemanticType }
  | { readonly _tag: 'Unavailable' }

/** One bare identifier expression with its local reference and type facts. */
export interface IdentifierExpressionDecision {
  readonly _tag: 'Identifier'
  readonly reference: ParameterReferenceFact
  /** Concrete compile-time value retained while residualizing a runtime specialization. */
  readonly staticValue?: StaticValue.Value
  readonly type: ExpressionTypeFact
  readonly originalType?: SemanticType
  readonly invocationSource?: Tir.StoredInvocationSource
  readonly anchor: AuthoredHir.Anchor
}

/** One `move <place>` expression with its consuming subject fact. */
export interface MoveExpressionDecision {
  readonly _tag: 'Move'
  readonly subject: Tir.Expression
  readonly exactCallable?: Extract<
    ExpressionDecision,
    { readonly _tag: 'FunctionItem' | 'CallableSection' }
  >
  readonly concreteCallableIdentity?: true
  readonly type: ExpressionTypeFact
  readonly originalType?: SemanticType
  readonly invocationSource?: Tir.StoredInvocationSource
  readonly anchor: AuthoredHir.Anchor
}

export type BorrowSelectorFact =
  | {
      readonly _tag: 'Field'
      readonly field: DeclarationFacts.FieldId
      readonly span: SourceSpan.SourceSpan
      readonly at?: AuthoredHir.Anchor
    }
  | {
      readonly _tag: 'Index'
      readonly index: Tir.Expression
      readonly array: Type.FixedArray
      readonly bounds: Extract<BoundsFact, { readonly _tag: 'Proven' | 'Runtime' }>
      readonly span: SourceSpan.SourceSpan
      readonly at?: AuthoredHir.Anchor
    }
  | {
      readonly _tag: 'SliceIndex'
      readonly index: Tir.Expression
      readonly slice: Type.Slice
      readonly span: SourceSpan.SourceSpan
      readonly at?: AuthoredHir.Anchor
    }

export type BorrowRootFact =
  | {
      readonly _tag: 'BindingRoot'
      readonly binding: BindingDeclarationFact
      readonly path: ReadonlyArray<BorrowSelectorFact>
    }
  | {
      readonly _tag: 'ParameterRoot'
      readonly parameter: ParameterFact
      readonly path: ReadonlyArray<BorrowSelectorFact>
    }
  | {
      readonly _tag: 'PatternRoot'
      readonly binding: PatternBindingFact
      readonly path: ReadonlyArray<BorrowSelectorFact>
    }
  | {
      readonly _tag: 'TemporaryRoot'
      readonly owner: Tir.TemporaryOwnerId
      readonly value: Tir.Expression
      readonly path: ReadonlyArray<BorrowSelectorFact>
    }

export type BorrowFormationFact =
  | {
      readonly _tag: 'FixedArrayBorrow'
      readonly root: BorrowRootFact
      readonly array: Type.FixedArray
    }
  | {
      readonly _tag: 'SliceReborrow'
      readonly root: BorrowRootFact
      readonly parent: Type.Slice
      readonly suspendsParent: boolean
    }
  | {
      readonly _tag: 'ValueBorrow'
      readonly root: BorrowRootFact
      readonly source: Type.Type
    }
  | {
      readonly _tag: 'ValueReborrow'
      readonly root: BorrowRootFact
      readonly parent: Type.Reference
      readonly suspendsParent: boolean
    }
  | { readonly _tag: 'Unavailable'; readonly cause?: Diagnostic.Identity<Location.Location> }

/** One explicit whole-root borrowed view. */
export interface BorrowExpressionDecision {
  readonly _tag: 'Borrow'
  readonly access: Type.BorrowAccess
  readonly subject: Tir.Expression
  readonly formation: BorrowFormationFact
  readonly type: ExpressionTypeFact
  readonly anchor: AuthoredHir.Anchor
}

/** One flattened leaf binding introduced by a nominal pattern. */
export interface PatternBindingFact {
  readonly _tag: 'PatternBinding'
  readonly id: Match.BindingId
  readonly name: DeclaredName
  /** Absent for a whole-member binding, which owns the entire matched payload. */
  readonly field?: DeclarationFacts.FieldFact
  readonly path: ReadonlyArray<DeclarationFacts.FieldId>
  readonly type: ExpressionTypeFact
  readonly access: Match.Access
  /** Owned place aliases inherit assignment permission from the matched root. */
  readonly placeMutability?: 'Mutable' | 'Immutable'
  readonly anchor: AuthoredHir.Anchor
}

export type PatternFieldState =
  | { readonly _tag: 'Resolved'; readonly field: DeclarationFacts.FieldFact }
  | { readonly _tag: 'Unknown'; readonly cause: Diagnostic.Identity<Location.Location> }
  | {
      readonly _tag: 'Duplicate'
      readonly field: DeclarationFacts.FieldFact
      readonly cause: Diagnostic.Identity<Location.Location>
    }
  | { readonly _tag: 'Unavailable'; readonly cause?: Diagnostic.Identity<Location.Location> }

export interface PatternFieldFact {
  readonly _tag: 'PatternField'
  readonly name: string | undefined
  readonly state: PatternFieldState
  readonly binding?: PatternBindingFact
  readonly nested?: PatternFact
  readonly anchor: AuthoredHir.Anchor
}

export type PatternFact =
  | {
      readonly _tag: 'UnavailablePattern'
      readonly id: Match.PatternId
      readonly member?: undefined
      readonly bindings: ReadonlyArray<PatternBindingFact>
      readonly omitted: ReadonlyArray<ReadonlyArray<DeclarationFacts.FieldId>>
      readonly complete: false
      readonly anchor: AuthoredHir.Anchor
    }
  | {
      readonly _tag: 'EnumMemberPattern'
      readonly id: Match.PatternId
      readonly enum?: DeclarationFacts.EnumFact
      readonly member?: DeclarationFacts.EnumMemberFact
      readonly coverage?: Match.CoverageIdentity
      readonly qualifierAnchor?: AuthoredHir.Anchor
      readonly memberAnchor?: AuthoredHir.Anchor
      readonly span: SourceSpan.SourceSpan
      readonly bindings: ReadonlyArray<PatternBindingFact>
      readonly omitted: ReadonlyArray<ReadonlyArray<DeclarationFacts.FieldId>>
      readonly complete: boolean
      readonly anchor: AuthoredHir.Anchor
    }
  | {
      readonly _tag: 'IntegerPattern'
      readonly id: Match.PatternId
      readonly value?: bigint
      readonly span: SourceSpan.SourceSpan
      readonly bindings: ReadonlyArray<PatternBindingFact>
      readonly omitted: ReadonlyArray<ReadonlyArray<DeclarationFacts.FieldId>>
      readonly complete: false
      readonly anchor: AuthoredHir.Anchor
    }
  | {
      readonly _tag: 'TypePattern'
      readonly id: Match.PatternId
      readonly member?: Type.Type
      readonly declared: DeclarationFacts.DeclaredTypeFact
      readonly bindings: ReadonlyArray<PatternBindingFact>
      readonly omitted: ReadonlyArray<ReadonlyArray<DeclarationFacts.FieldId>>
      readonly complete: boolean
      readonly anchor: AuthoredHir.Anchor
    }
  | {
      readonly _tag: 'NominalPattern'
      readonly id: Match.PatternId
      readonly target: StructTargetFact
      readonly member?: Type.Nominal
      readonly fields: ReadonlyArray<PatternFieldFact>
      readonly bindings: ReadonlyArray<PatternBindingFact>
      readonly omitted: ReadonlyArray<ReadonlyArray<DeclarationFacts.FieldId>>
      readonly rest: boolean
      readonly complete: boolean
      readonly anchor: AuthoredHir.Anchor
    }
  | {
      readonly _tag: 'UnionVariantPattern'
      readonly id: Match.PatternId
      readonly target: UnionVariantTargetFact
      readonly member?: Type.Nominal
      readonly coverage?: Match.CoverageIdentity
      readonly fields: ReadonlyArray<PatternFieldFact>
      readonly bindings: ReadonlyArray<PatternBindingFact>
      readonly omitted: ReadonlyArray<ReadonlyArray<DeclarationFacts.FieldId>>
      readonly rest: boolean
      readonly complete: boolean
      readonly anchor: AuthoredHir.Anchor
    }
  | {
      readonly _tag: 'UniversalPattern'
      readonly id: Match.PatternId
      readonly bindings: ReadonlyArray<PatternBindingFact>
      readonly omitted: ReadonlyArray<ReadonlyArray<DeclarationFacts.FieldId>>
      readonly anchor: AuthoredHir.Anchor
    }

/** The authored match body, with ordinary blocks retaining their statement region. */
export type MatchArmBodyFact =
  | {
      readonly _tag: 'Expression'
      readonly expression: Tir.Expression
      readonly type: ExpressionTypeFact
      readonly anchor: AuthoredHir.Anchor
    }
  | {
      readonly _tag: 'Block'
      readonly statements: ReadonlyArray<Tir.Statement>
      readonly completion: { readonly fallsThrough: boolean }
      readonly type: ExpressionTypeFact
      readonly anchor: AuthoredHir.Anchor
    }

export interface MatchArmFact {
  readonly tests: ReadonlyArray<Match.PatternTest>
  readonly _tag: 'MatchArm'
  readonly id: Match.ArmId
  readonly pattern: PatternFact
  readonly bindings: ReadonlyArray<PatternBindingFact>
  readonly guard?: Tir.Expression
  readonly body: MatchArmBodyFact
  readonly before: ReadonlyArray<Match.CoverageIdentity>
  readonly after: ReadonlyArray<Match.CoverageIdentity>
  readonly reachable: boolean
  readonly anchor: AuthoredHir.Anchor
}

export interface MatchExpressionDecision {
  readonly _tag: 'Match'
  readonly id: Match.MatchId
  readonly access: Match.Access
  readonly scrutinee: Tir.Expression
  readonly members: ReadonlyArray<Match.CoverageIdentity>
  readonly arms: ReadonlyArray<MatchArmFact>
  readonly exhaustive: boolean
  readonly type: ExpressionTypeFact
  readonly anchor: AuthoredHir.Anchor
}

/** One statement-form pattern decision shared by irrefutable let and refutable if-let. */
export interface PatternSelectionFact {
  readonly tests: ReadonlyArray<Match.PatternTest>
  readonly _tag: 'PatternSelection'
  readonly id: Match.MatchId
  readonly arm: Match.ArmId
  readonly access: Match.Access
  /** Authored initializer, retaining an outer move/borrow for ownership loan analysis. */
  readonly source: Tir.Expression
  readonly subject: Tir.Expression
  readonly members: ReadonlyArray<Match.CoverageIdentity>
  readonly pattern: PatternFact
  readonly bindings: ReadonlyArray<PatternBindingFact>
  readonly irrefutable: boolean
  readonly loanEnd: SourceSpan.SourceSpan
  /** The authored node `loanEnd` presents. */
  readonly loanEndAt: AuthoredHir.Anchor
  readonly anchor: AuthoredHir.Anchor
}

export type StructTargetFact =
  | {
      readonly _tag: 'Resolved'
      readonly struct: DeclarationFacts.StructFact
      readonly type: Type.Nominal
      /** Present for source-named constructors; occurrence-generated literals have no type token. */
      readonly anchor?: AuthoredHir.Anchor
    }
  | { readonly _tag: 'Unavailable'; readonly cause?: Diagnostic.Identity<Location.Location> }

export type UnionVariantTargetFact =
  | {
      readonly _tag: 'Resolved'
      readonly union: DeclarationFacts.UnionFact
      readonly variant: DeclarationFacts.UnionVariantFact
      readonly type: Type.Nominal
      readonly anchor: AuthoredHir.Anchor
    }
  | { readonly _tag: 'Unavailable'; readonly cause?: Diagnostic.Identity<Location.Location> }

export type StructInitializerState =
  | { readonly _tag: 'Resolved'; readonly field: DeclarationFacts.FieldFact }
  | { readonly _tag: 'Unknown'; readonly cause: Diagnostic.Identity<Location.Location> }
  | {
      readonly _tag: 'Duplicate'
      readonly field: DeclarationFacts.FieldFact
      readonly cause: Diagnostic.Identity<Location.Location>
    }
  | {
      readonly _tag: 'TypeMismatch'
      readonly field: DeclarationFacts.FieldFact
      readonly cause: Diagnostic.Identity<Location.Location>
    }
  | {
      readonly _tag: 'Inaccessible'
      readonly field: DeclarationFacts.FieldFact
      readonly cause: Diagnostic.Identity<Location.Location>
    }
  | { readonly _tag: 'Unavailable' }

export interface StructInitializerFact {
  readonly _tag: 'StructInitializer'
  readonly name: string | undefined
  readonly expression: Tir.Expression
  readonly state: StructInitializerState
  /** The written field label, which is where an editor finds this initializer's field. */
  readonly nameAnchor?: AuthoredHir.Anchor
  readonly anchor: AuthoredHir.Anchor
}

export interface StructTypeArgumentFact {
  readonly parameter: Type.Parameter
  readonly argument?: Type.GenericArgument
  readonly source: 'Explicit' | 'Inferred' | 'Unavailable'
  readonly origins: ReadonlyArray<Location.Location>
}

export interface StructLiteralExpressionDecision {
  readonly _tag: 'StructLiteral'
  readonly target: StructTargetFact
  readonly authorized: boolean
  readonly typeArguments: ReadonlyArray<StructTypeArgumentFact>
  readonly initializers: ReadonlyArray<StructInitializerFact>
  readonly fields: ReadonlyArray<{
    readonly field: DeclarationFacts.FieldFact
    readonly initializer: StructInitializerFact
  }>
  readonly type: ExpressionTypeFact
  readonly anchor: AuthoredHir.Anchor
}

export interface UnionVariantExpressionDecision {
  readonly _tag: 'UnionVariant'
  readonly target: UnionVariantTargetFact
  readonly authorized: boolean
  readonly typeArguments: ReadonlyArray<StructTypeArgumentFact>
  readonly initializers: ReadonlyArray<StructInitializerFact>
  readonly fields: ReadonlyArray<{
    readonly field: DeclarationFacts.FieldFact
    readonly initializer: StructInitializerFact
  }>
  readonly type: ExpressionTypeFact
  readonly anchor: AuthoredHir.Anchor
}

export type ProjectionState =
  | { readonly _tag: 'Resolved'; readonly field: DeclarationFacts.FieldFact }
  | { readonly _tag: 'SliceLength' }
  | { readonly _tag: 'Unavailable'; readonly cause?: Diagnostic.Identity<Location.Location> }

export interface FieldProjectionExpressionDecision {
  readonly _tag: 'FieldProjection'
  readonly subject: Tir.Expression
  /** Construction-only summary retained instead of the subject's recursive decision record. */
  readonly root?: AssignmentRootFact
  readonly borrowRoot?: BorrowRootFact
  readonly placeBorrowAccess?: Type.BorrowAccess
  /** Exact compile-time projection retained for residual literal materialization. */
  readonly staticValue?: StaticValue.Value
  readonly nominal?: Type.Nominal
  readonly borrowAccess?: Type.BorrowAccess
  readonly fieldName: string | undefined
  readonly fieldAnchor?: AuthoredHir.Anchor
  readonly state: ProjectionState
  readonly type: ExpressionTypeFact
  readonly anchor: AuthoredHir.Anchor
}

export type ReferentProjectionState =
  | { readonly _tag: 'Resolved'; readonly reference: Type.Reference }
  | { readonly _tag: 'Unavailable'; readonly cause?: Diagnostic.Identity<Location.Location> }

/** One explicit postfix projection from a reference value to its borrowed target place. */
export interface ReferentProjectionExpressionDecision {
  readonly _tag: 'ReferentProjection'
  readonly subject: Tir.Expression
  readonly root?: AssignmentRootFact
  readonly borrowRoot?: BorrowRootFact
  readonly placeBorrowAccess?: Type.BorrowAccess
  readonly reference?: Type.Reference
  readonly borrowAccess?: Type.BorrowAccess
  readonly state: ReferentProjectionState
  readonly type: ExpressionTypeFact
  readonly anchor: AuthoredHir.Anchor
}

/** One source-ordered array element with contextual compatibility retained independently. */
export interface ArrayElementFact {
  readonly _tag: 'ArrayElement'
  readonly ordinal: number
  readonly expression: Tir.Expression
  readonly expected?: SemanticType
  readonly compatibility:
    | { readonly _tag: 'Compatible' }
    | {
        readonly _tag: 'TypeMismatch'
        readonly expected: SemanticType
        readonly actual: SemanticType
      }
    | { readonly _tag: 'Unavailable' }
  readonly anchor: AuthoredHir.Anchor
}

export type ArrayLiteralState =
  | { readonly _tag: 'Complete'; readonly type: Type.FixedArray }
  | { readonly _tag: 'MissingContext' }
  | { readonly _tag: 'LengthMismatch'; readonly expected: number; readonly actual: number }
  | { readonly _tag: 'IncompatibleElements' }
  | { readonly _tag: 'Unavailable' }

/** One complete-or-unavailable fixed-array literal and every retained element fact. */
export interface ArrayLiteralExpressionDecision {
  readonly _tag: 'ArrayLiteral'
  readonly elements: ReadonlyArray<ArrayElementFact>
  readonly expected?: Type.FixedArray
  readonly elementType?: SemanticType
  readonly length: number
  readonly state: ArrayLiteralState
  readonly type: ExpressionTypeFact
  readonly anchor: AuthoredHir.Anchor
}

export type BoundsFact =
  | { readonly _tag: 'Proven'; readonly index: number; readonly length: number }
  | {
      readonly _tag: 'Invalid'
      readonly index: number
      readonly length: number
      readonly cause: Diagnostic.Identity<Location.Location>
    }
  | { readonly _tag: 'Runtime'; readonly length: number }
  | { readonly _tag: 'RuntimeSlice' }
  | { readonly _tag: 'Unavailable' }

/** One typed checked array-place projection. */
export interface IndexProjectionExpressionDecision {
  readonly _tag: 'IndexProjection'
  readonly subject: Tir.Expression
  readonly index: Tir.Expression
  readonly root?: AssignmentRootFact
  readonly borrowRoot?: BorrowRootFact
  readonly placeBorrowAccess?: Type.BorrowAccess
  readonly array?: Type.FixedArray
  readonly slice?: Type.Slice
  readonly elementType?: SemanticType
  readonly borrowAccess?: Type.BorrowAccess
  readonly access: 'CopyRead' | 'ConsumeRequested'
  readonly bounds: BoundsFact
  readonly type: ExpressionTypeFact
  readonly anchor: AuthoredHir.Anchor
}

/** One `true`/`false` literal expression fact. */
export interface BooleanExpressionDecision {
  readonly _tag: 'Boolean'
  readonly value: boolean
  readonly type: ExpressionTypeFact
  readonly anchor: AuthoredHir.Anchor
}

/** One reference to a typed compile-time scalar declaration. */
export interface ConstantExpressionDecision {
  readonly _tag: 'Constant'
  readonly declaration: DeclarationFacts.ConstantFact
  readonly anchor: AuthoredHir.Anchor
  readonly value?:
    | { readonly _tag: 'Boolean'; readonly value: boolean }
    | {
        readonly _tag: 'Integer'
        readonly value: bigint
        readonly type: SemanticType
      }
    | {
        readonly _tag: 'Floating'
        readonly bits: bigint
        readonly spelling: string
        readonly type: 'f32' | 'f64'
      }
    | { readonly _tag: 'String'; readonly data: StaticText.Data }
    | { readonly _tag: 'Character'; readonly value: number }
  readonly type: ExpressionTypeFact
}

/** One runtime load from a declaration-owned C data symbol. */
export interface ForeignStaticExpressionDecision {
  readonly _tag: 'ForeignStatic'
  readonly declaration: DeclarationFacts.ForeignStaticFact
  readonly anchor: AuthoredHir.Anchor
  readonly type: ExpressionTypeFact
}

/** One compiler-known operand-to-parameter relationship. */
export interface BuiltinArgumentMappingFact {
  readonly _tag: 'BuiltinArgumentMapping'
  readonly argument: ArgumentFact
  readonly ordinal: number
  readonly expected: SemanticType
}

/**
 * `&&` or `||`. Both operands are `bool` and the result is `bool`, but the operator reaches no
 * actor operation: an actor call evaluates both operands, and the right operand here evaluates
 * only when the left one does not already decide the result.
 */
export interface ShortCircuitExpressionDecision {
  readonly _tag: 'ShortCircuit'
  readonly operator: Operator.ShortCircuit
  /** The left operand first, then the conditionally evaluated right operand. */
  readonly arguments: ReadonlyArray<ArgumentFact>
  readonly type: ExpressionTypeFact
  readonly anchor: AuthoredHir.Anchor
}

/** One prefix or infix operator and its canonical builtin resolution. */
export interface OperatorExpressionDecision {
  readonly _tag: 'Operator'
  readonly selectedConformances?: ReadonlyArray<ConformanceGoal.Proof>
  readonly operator: Operator.Prefix | Operator.Infix
  readonly reference: CallReferenceFact
  readonly arguments: ReadonlyArray<ArgumentFact>
  readonly mappings: ReadonlyArray<BuiltinArgumentMappingFact>
  readonly contract: CallContractFact
  readonly interfaceOperation?: InterfaceOperationFact
  readonly witnessEffectSite?: Tir.EffectSiteId
  readonly type: ExpressionTypeFact
  readonly anchor: AuthoredHir.Anchor
}

/**
 * The bound contract one operator resolves through inside a generic body.
 *
 * The operator still elaborates against the compiler-known operation of a stand-in actor, because
 * the operand type is not known until specialization. This records which interface operation the
 * operator spells so specialization can redirect the call to a source witness; a scalar argument
 * keeps the compiler-known operation and never consults it.
 */
export interface InterfaceOperationFact {
  readonly capability: Type.Nominal
  readonly provider: Type.Type
  readonly operation: string
  readonly contract: DeclarationFacts.InterfaceOperationApplicationFact
}

/** One declaration or builtin named as a callable value without invocation. */
export interface FunctionItemExpressionDecision {
  readonly _tag: 'FunctionItem'
  readonly selectedConformances?: ReadonlyArray<ConformanceGoal.Proof>
  readonly reference: CallReferenceFact
  readonly path: ReferencePathFact
  readonly typeArguments: ReadonlyArray<Type.GenericArgument>
  /** Present when contextual typing converts an exported function item to its C address. */
  readonly foreignAddress?: { readonly symbol: string }
  readonly type: ExpressionTypeFact
  readonly anchor: AuthoredHir.Anchor
}

/** One trailing value retained by an automatic trailing-argument section. */
export interface CallableCaptureFact {
  readonly _tag: 'CallableCapture'
  readonly ordinal: number
  readonly parameterOrdinal: number
  readonly expression: Tir.Expression
  readonly access: 'Copy' | 'Shared' | 'Exclusive' | 'Take'
}

/** One implicit lexical capture retained by an anonymous callable construction. */
export interface AnonymousCaptureFact {
  readonly _tag: 'AnonymousCapture'
  readonly reference: BindingDeclarationFact | ParameterFact | PatternBindingFact
  readonly access: CallableCaptureFact['access']
  readonly span: SourceSpan.SourceSpan
  readonly anchor: AuthoredHir.Anchor
}

/** One hidden concrete section construction awaiting an ordered leading parameter prefix. */
export interface CallableSectionExpressionDecision {
  readonly _tag: 'CallableSection'
  /** Original explicit marked input positions, preserved when a section is flattened. */
  readonly invocationParameters?: ReadonlyArray<number>
  readonly selectedConformances?: ReadonlyArray<ConformanceGoal.Proof>
  readonly site: Tir.CallableSiteId
  readonly reference: CallReferenceFact
  readonly path: ReferencePathFact
  readonly remainingParameters: ReadonlyArray<number>
  readonly captures: ReadonlyArray<CallableCaptureFact>
  readonly retainedDependencies: ReadonlyArray<number>
  readonly typeArguments: ReadonlyArray<Type.GenericArgument>
  readonly environmentOwner?: Type.CallableEnvironmentIdentity['owner']
  readonly substitution: Type.Substitution
  readonly mode: Type.CallableMode
  readonly type: ExpressionTypeFact
  readonly anchor: AuthoredHir.Anchor
  /** Source-only provenance for a section whose target is an anonymous callable body. */
  readonly anonymous?: {
    readonly functionKind: 'Ordinary' | 'Effect'
    readonly captures: ReadonlyArray<AnonymousCaptureFact>
  }
}

/** One complete unsafe invocation through a native C function address. */
export interface ForeignApplyExpressionDecision {
  readonly _tag: 'ForeignApply'
  readonly evaluation: 'CalleeThenArguments' | 'LeftThenCallable'
  readonly callee: Tir.Expression
  readonly arguments: ReadonlyArray<ArgumentFact>
  readonly contract: Type.ForeignFunction
  readonly type: ExpressionTypeFact
  readonly anchor: AuthoredHir.Anchor
}

/** One ordinary invocation through a first-class callable expression. */
export interface CallableApplyExpressionDecision {
  readonly _tag: 'CallableApply'
  /** Exact source identity, when semantic application can discharge its generic obligations. */
  readonly sourceTarget?: Extract<CallReferenceFact, { readonly _tag: 'Resolved' }>
  readonly selectedConformances?: ReadonlyArray<ConformanceGoal.Proof>
  readonly invocationUse?: Tir.InvocationUseObligation
  readonly callee: Tir.Expression
  readonly arguments: ReadonlyArray<ArgumentFact>
  readonly mode: Type.CallableMode
  readonly contract?: Type.Callable
  /** Generic evidence learned from the newly supplied callable arguments. */
  readonly substitution: Type.Substitution
  readonly inferredProviderSelectors: ReadonlyArray<InferredProviderSelector>
  /**
   * Present when the supplied arguments are a proper trailing suffix of a callable value's
   * remaining parameters: the application stages a new section over the value instead of
   * invoking it, splicing these captures after the value's own environment.
   */
  readonly staged?: {
    readonly site: Tir.CallableSiteId
    readonly captures: ReadonlyArray<CallableCaptureFact>
  }
  readonly provenance:
    | { readonly _tag: 'DirectCallableApplication' }
    | {
        readonly _tag: 'PipelineCallableApplication'
        readonly left: Tir.Expression
        readonly callable: Tir.Expression
        readonly evaluation: 'LeftThenCallable'
      }
  readonly type: ExpressionTypeFact
  readonly anchor: AuthoredHir.Anchor
}

/** One outer lexical value captured by a lazy effect block. */
export interface EffectCaptureFact {
  readonly _tag: 'EffectCapture'
  readonly reference: BindingDeclarationFact | ParameterFact | PatternBindingFact
  readonly access: 'Copy' | 'Shared' | 'Exclusive' | 'Take'
  readonly span: SourceSpan.SourceSpan
  /** The authored use that `span` presents. */
  readonly anchor: AuthoredHir.Anchor
  /** First lexical identifier occurrence retained for anonymous environment construction. */
  readonly expression?: Tir.Expression
}

/** One existing provider retained by an Effect provision wrapper. */
export interface EffectRequirementBindingFact {
  readonly _tag: 'EffectRequirementBinding'
  readonly reference: BindingDeclarationFact | ParameterFact
  readonly selected: Type.RequirementsRow
  readonly evidence: ReadonlyArray<Constraint.ConstraintEvidence>
  readonly capability?: Type.Nominal | Type.Parameter
  readonly providerType: Type.Nominal | Type.Parameter
  readonly witness?: DeclarationFacts.ConformanceWitness
  readonly role?: string
  /** Fixed provider mode used by requirement selection and runtime service dispatch. */
  readonly selectionAccess: 'Shared' | 'Exclusive' | 'Take'
  /** Ordinary capture access derived from the provider argument expression. */
  readonly captureAccess: 'Copy' | 'Shared' | 'Exclusive' | 'Take'
  readonly span: SourceSpan.SourceSpan
  /** The authored node `span` presents. */
  readonly at: AuthoredHir.Anchor
}

/** One lazy imperative effect block and its capture-derived execution contract. */
export interface EffectExpressionDecision {
  readonly _tag: 'EffectBlock'
  readonly site: Tir.EffectSiteId
  readonly representationOwner?: Type.ExecutableSpecializationOwner
  readonly statements: ReadonlyArray<Tir.Statement>
  readonly captures: ReadonlyArray<EffectCaptureFact>
  readonly bindings: ReadonlyArray<BindingDeclarationFact>
  readonly regions: ReadonlyArray<Tir.RegionId>
  readonly type: ExpressionTypeFact
  readonly anchor: AuthoredHir.Anchor
}

/** One qualified payload-free enum member value with canonical declaration identity. */
export interface EnumMemberExpressionDecision {
  readonly _tag: 'EnumMember'
  readonly enum: DeclarationFacts.EnumFact
  readonly member?: DeclarationFacts.EnumMemberFact
  readonly cause?: Diagnostic.Identity<Location.Location>
  readonly qualifierAnchor: AuthoredHir.Anchor
  readonly memberAnchor: AuthoredHir.Anchor
  readonly type: ExpressionTypeFact
  readonly anchor: AuthoredHir.Anchor
}

/** One declaration-owned projection of an enum member's exact representation value. */
export interface EnumValueExpressionDecision {
  readonly _tag: 'EnumValue'
  readonly operation: DeclarationFacts.EnumAssociatedOperationFact
  readonly argument: Tir.Expression
  readonly qualifierAnchor: AuthoredHir.Anchor
  readonly operationAnchor: AuthoredHir.Anchor
  readonly type: ExpressionTypeFact
  readonly anchor: AuthoredHir.Anchor
}

/** One semantic expression fact at any returned or argument position. */
export type ExpressionDecision =
  | {
      readonly _tag: 'Integer'
      readonly integer: IntegerExpressionDecision
      readonly type: ExpressionTypeFact
      readonly anchor: AuthoredHir.Anchor
    }
  | DurationExpressionDecision
  | {
      readonly _tag: 'Floating'
      readonly floating: FloatingExpressionDecision
      readonly type: ExpressionTypeFact
      readonly anchor: AuthoredHir.Anchor
    }
  | StaticTextExpressionDecision
  | CharacterExpressionDecision
  | CompileErrorExpressionDecision
  | {
      readonly _tag: 'Unit'
      readonly type: ExpressionTypeFact
      readonly anchor: AuthoredHir.Anchor
    }
  | BooleanExpressionDecision
  | ConstantExpressionDecision
  | ForeignStaticExpressionDecision
  | EnumMemberExpressionDecision
  | EnumValueExpressionDecision
  | IdentifierExpressionDecision
  | MoveExpressionDecision
  | BorrowExpressionDecision
  | MatchExpressionDecision
  | StructLiteralExpressionDecision
  | UnionVariantExpressionDecision
  | ArrayLiteralExpressionDecision
  | FieldProjectionExpressionDecision
  | ReferentProjectionExpressionDecision
  | IndexProjectionExpressionDecision
  | OperatorExpressionDecision
  | ShortCircuitExpressionDecision
  | FunctionItemExpressionDecision
  | CallableSectionExpressionDecision
  | ForeignApplyExpressionDecision
  | CallableApplyExpressionDecision
  | EffectExpressionDecision
  | {
      readonly _tag: 'Run'
      readonly subject: Tir.Expression
      readonly type: ExpressionTypeFact
      readonly anchor: AuthoredHir.Anchor
    }
  | {
      /** `Place.replace(place, value)`: swap one writable place, yielding its old value. */
      readonly _tag: 'PlaceReplace'
      readonly reference: IntrinsicReferenceFact
      readonly destination: Tir.Expression
      readonly root?: AssignmentRootFact
      readonly value: Tir.Expression
      readonly compatible: boolean
      readonly type: ExpressionTypeFact
      readonly anchor: AuthoredHir.Anchor
    }
  | {
      readonly _tag: 'EffectBindRequirement'
      readonly reference: IntrinsicReferenceFact
      readonly protected: Tir.Expression
      readonly provider?: EffectRequirementBindingFact
      readonly type: ExpressionTypeFact
      readonly anchor: AuthoredHir.Anchor
    }
  | {
      /**
       * Member-selective recovery. `protectedRow`, `selected`, `handlerRow`, and `residualRow`
       * are the four rows `bootstrap-semantic-facts` requires this operation to record; the
       * residual is carried explicitly because it has no source-level type to recover it from.
       */
      readonly _tag: 'EffectCatch'
      readonly recoveryInvocation?: Tir.RecoveryInvocationRecipe
      readonly reference: IntrinsicReferenceFact
      readonly protected: Tir.Expression
      readonly handler: Tir.Expression
      readonly selected?: Type.Type
      readonly protectedRow: Type.FailureRow
      readonly handlerRow: Type.FailureRow
      readonly residualRow: Type.FailureRow
      readonly evidence: ReadonlyArray<Constraint.ConstraintEvidence>
      readonly type: ExpressionTypeFact
      readonly anchor: AuthoredHir.Anchor
    }
  | {
      readonly _tag: 'Call'
      /** Selected source evidence retained for generic semantic obligation replay. */
      readonly selectedConformances?: ReadonlyArray<ConformanceGoal.Proof>
      readonly reference: CallReferenceFact
      readonly path: ReferencePathFact
      readonly interfaceApplication?: DeclarationFacts.DeclaredTypeFact
      readonly typeArguments: ReadonlyArray<TypeArgumentFact>
      readonly arguments: ReadonlyArray<ArgumentFact>
      readonly staticArguments?: ReadonlyArray<{
        readonly parameter: ParameterFact
        readonly value: StaticValue.Value
        /** Caller-authored provenance retained outside canonical specialization identity. */
        readonly textOrigin?: Evaluation.TextOrigin
      }>
      /** Complete compile-time result when this call targets a `static fn`. */
      readonly staticValue?: StaticValue.Value
      /** Source text provenance retained separately from the canonical static result. */
      readonly staticTextSpan?: Location.Location
      /** Source-independent origin retained for cached static text results. */
      readonly staticTextOrigin?: Evaluation.TextOrigin
      /** Original compile-time failure when eager static-call evaluation did not complete. */
      readonly staticFailure?: Evaluation.StaticFailure
      readonly mappings: ReadonlyArray<ArgumentMappingFact>
      readonly contract: CallContractFact
      readonly witnessEffectSite?: Tir.EffectSiteId
      readonly type: ExpressionTypeFact
      readonly anchor: AuthoredHir.Anchor
    }

/** Whether a selected result retains any validity requirement carried by an input value. */
export const retainsLifetimes = (
  source: SemanticType,
  result: SemanticType,
  assumptions: Lifetime.Assumptions,
  proves: (longer: Lifetime.Lifetime, shorter: Lifetime.Lifetime) => boolean = (longer, shorter) =>
    Lifetime.outlives(assumptions, longer, shorter),
): boolean => {
  const required = Type.storageLifetimes(result).filter(
    (lifetime) => lifetime._tag !== 'StaticLifetime',
  )
  return (
    required.length > 0 &&
    Type.storageLifetimes(source).some((lifetime) =>
      required.some((output) => proves(lifetime, output)),
    )
  )
}

/** Arguments whose access capability, or owned payload, is retained by the selected result. */
export const retainedResultArguments = (
  self: ExpressionDecision,
  assumptions: Lifetime.Assumptions,
  proves: (longer: Lifetime.Lifetime, shorter: Lifetime.Lifetime) => boolean = (longer, shorter) =>
    Lifetime.outlives(assumptions, longer, shorter),
): ReadonlyArray<ArgumentFact> => {
  if (
    (self._tag !== 'Call' && self._tag !== 'CallableApply' && self._tag !== 'Operator') ||
    self.type._tag !== 'Available'
  )
    return []
  const result = self.type.type
  let invocationUse: Tir.InvocationUseObligation | undefined
  if (self._tag === 'CallableApply') invocationUse = self.invocationUse
  else if (self._tag === 'Call' && self.contract._tag === 'Compatible')
    invocationUse = self.contract.invocationUse
  const retainsInvocation =
    invocationUse !== undefined &&
    Type.storageLifetimes(result).some((lifetime) =>
      Lifetime.atoms(lifetime).some((member) => Lifetime.equals(member, invocationUse.lifetime)),
    )
  return self.arguments.filter((argument) => {
    if (argument.type._tag !== 'Available') return false
    if (
      retainsInvocation &&
      invocationUse?.inputs.some(
        (input) =>
          input.capture === undefined &&
          AuthoredIdentity.anchorKey(input.argument) ===
            AuthoredIdentity.anchorKey(constructionExpressionAnchor(argument.expression)) &&
          argument.type._tag === 'Available' &&
          Type.equals(input.type, argument.type.type),
      )
    )
      return true
    const source = argument.type.type
    // Extracting T from &mut Owner<T> transfers T's external dependencies, not the access
    // capability to Owner's storage. Only the outer borrow can retain that storage loan.
    if (Type.isReference(source) || Type.isSlice(source))
      return Type.storageLifetimes(result).some(
        (output) => output._tag !== 'StaticLifetime' && proves(source.lifetime, output),
      )
    return retainsLifetimes(source, result, assumptions, proves)
  })
}

/** A deterministic argument identity within one caller and concrete call site. */
export interface ArgumentId {
  readonly _tag: 'ArgumentId'
  readonly ordinal: number
}

/** One ordered, syntax-owned call argument. */
export interface ArgumentFact {
  readonly _tag: 'Argument'
  readonly id: ArgumentId
  readonly expression: Tir.Expression
  /** Construction-only loan root needed by intrinsics that project through an argument. */
  readonly borrowRoot?: BorrowRootFact
  readonly type: ExpressionTypeFact
  readonly invocationSource?: Tir.StoredInvocationSource
  readonly anchor: AuthoredHir.Anchor
}

/** One positional argument-to-parameter relationship. */
export interface ArgumentMappingFact {
  readonly _tag: 'ArgumentMapping'
  readonly argument: ArgumentFact
  readonly parameter: ParameterFact
}

/** One source-owned explicit call type argument, resolved canonically when available. */
export interface TypeArgumentFact {
  readonly _tag: 'TypeArgument'
  readonly ordinal: number
  readonly anchor: AuthoredHir.Anchor
  readonly declared: DeclaredTypeFact
  readonly type?: SemanticType | Lifetime.Lifetime | Type.RequirementRowArgument
  /** Canonical role of an access-independent requirement selector such as `T at Role`. */
  readonly requirementRole?: Type.Requirement['role']
}

/** One omitted provider-selector binder and the concrete service selected for it. */
export interface InferredProviderSelector {
  readonly parameter: Type.Parameter
  readonly selected: Type.Requirement
}

/** Why a call contract cannot be established. */
export type UnavailableCallContractReason =
  | { readonly _tag: 'UnavailableCallSyntax'; readonly anchor: AuthoredHir.Anchor }
  | { readonly _tag: 'UnavailableCallTarget'; readonly reference: CallReferenceFact }
  | { readonly _tag: 'UnavailableMappedType'; readonly mapping: ArgumentMappingFact }
  | { readonly _tag: 'UnavailableBuiltinArgument'; readonly argument: ArgumentFact }
  | {
      readonly _tag: 'ArgumentTypeMismatch'
      readonly argument: ArgumentFact
      readonly expected: SemanticType
    }

/** The complete positional contract outcome for one call. */
export type CallContractFact =
  | {
      readonly _tag: 'Compatible'
      readonly inputViews?: ReadonlyArray<Tir.ExecutableInputView>
      readonly invocationUse?: Tir.InvocationUseObligation
      readonly expectedCount: number
      readonly actualCount: number
      readonly typeArguments: ReadonlyArray<Type.GenericArgument>
      readonly substitution: Type.Substitution
      readonly evidence: ReadonlyArray<Constraint.ConstraintEvidence>
      readonly inferredProviderSelectors: ReadonlyArray<InferredProviderSelector>
      /** Open source selections justified by exact bounds of the enclosing generic declaration. */
      readonly symbolicConformances?: ReadonlyArray<ConformanceProof.SymbolicConformanceSelection>
    }
  | {
      readonly _tag: 'ArityMismatch'
      readonly expectedCount: number
      readonly actualCount: number
    }
  | {
      readonly _tag: 'Unavailable'
      readonly reason: UnavailableCallContractReason
      readonly cause?: Diagnostic.Identity<Location.Location>
    }

/** Whether one returned expression is known to match its declared result type. */
export type ReturnCompatibility = { readonly _tag: 'Compatible' } | { readonly _tag: 'Unavailable' }

export type AssignmentRootFact = BindingDeclarationFact | ParameterFact | PatternBindingFact

export type AssignmentRootAccess =
  | 'ImmutableOwned'
  | 'MutableOwned'
  | 'SharedBorrowed'
  | 'ExclusiveBorrowed'

const assignmentPlaceBorrowAccess = (place: ExpressionDecision): Type.BorrowAccess | undefined => {
  if (
    place._tag !== 'FieldProjection' &&
    place._tag !== 'ReferentProjection' &&
    place._tag !== 'IndexProjection'
  ) {
    return undefined
  }
  return place.placeBorrowAccess
}

/** Classifies writable roots without conflating owned binding mutability with pointee access. */
export const assignmentRootAccess = (
  root: AssignmentRootFact,
  place: ExpressionDecision,
): AssignmentRootAccess => {
  if (root._tag === 'PatternBinding')
    return root.access === 'Place' && root.placeMutability === 'Mutable'
      ? 'MutableOwned'
      : 'ImmutableOwned'
  let type: Type.Type | undefined
  if (root._tag === 'ParameterDeclaration') {
    if (root.declaredType._tag === 'Resolved') {
      type = root.declaredType.type
    } else {
      type = undefined
    }
  } else if (root.inferredType._tag === 'Available') {
    type = root.inferredType.type
  } else {
    type = undefined
  }
  const rootBorrowAccess =
    place._tag !== 'Identifier' &&
    type !== undefined &&
    (Type.isSlice(type) || Type.isReference(type))
      ? type.access
      : undefined
  const placeBorrowAccess = assignmentPlaceBorrowAccess(place)
  let borrowAccess: Type.BorrowAccess | undefined
  if (rootBorrowAccess === 'Shared' || placeBorrowAccess === 'Shared') borrowAccess = 'Shared'
  else if (rootBorrowAccess === 'Exclusive' || placeBorrowAccess === 'Exclusive')
    borrowAccess = 'Exclusive'
  if (borrowAccess !== undefined)
    return borrowAccess === 'Exclusive' ? 'ExclusiveBorrowed' : 'SharedBorrowed'
  const mutability = root._tag === 'ParameterDeclaration' ? root.bindingMutability : root.mutability
  return mutability === 'Mutable' ? 'MutableOwned' : 'ImmutableOwned'
}

/** Resolves the mutable root a writable-place expression is anchored to, if any. */
export const assignmentRoot = (fact: ExpressionDecision): AssignmentRootFact | undefined => {
  if (fact._tag === 'Identifier') {
    if (fact.reference._tag === 'ResolvedBinding') return fact.reference.binding
    if (fact.reference._tag === 'Resolved') return fact.reference.parameter
    if (fact.reference._tag === 'ResolvedPattern' && fact.reference.binding.access === 'Place')
      return fact.reference.binding
    return undefined
  }
  if (
    fact._tag === 'FieldProjection' ||
    fact._tag === 'ReferentProjection' ||
    fact._tag === 'IndexProjection'
  ) {
    return fact.root
  }
  return undefined
}

/** One public function declaration and its syntax-owned semantic facts. */
export type DeclarationFact = DeclarationFacts.DeclarationFact

/** One function's declaration, statements, bindings, and compatibility facts. */
export interface FunctionConstruction {
  readonly _tag: 'FunctionConstruction'
  readonly comparisonWork?: Readonly<import('./TypeCompatibility.js').Work>
  readonly lifetimeFlow?: import('./LifetimeFlow.js').LifetimeFlow
  readonly declaration: DeclarationFact
  /** The authored block this body elaborated, absent for a declaration without one. */
  readonly bodyAnchor?: AuthoredHir.Anchor
  readonly statements: ReadonlyArray<Tir.Statement>
  readonly bindings: ReadonlyArray<BindingDeclarationFact>
  readonly regionOrder: ReadonlyArray<Tir.RegionId>
  readonly returnedExpression: Tir.Expression
  readonly returnCompatibility: ReturnCompatibility
  /** The finite composite Effect representation joined across distinct return sites. */
  readonly resultRepresentation?: SemanticType
  readonly generatedAggregates: ReadonlyArray<DeclarationFacts.StructFact>
  /** Static-only authored loops and their independently elaborated target-selected scopes. */
  readonly staticIterations: ReadonlyArray<StaticIterationFact>
  /** Editor-only analysis facts, present when the semantic session serves tooling. */
  readonly tooling?: FunctionTooling
  /** What each returned expression shows about the opaque result this body produces. */
  readonly opaqueEvidence: ReadonlyArray<import('./OpaqueRealization.js').Evidence>
}

/** What body analysis publishes only for editors: nothing compiles or executes from it. */
export interface FunctionTooling {
  /** The authored names this body resolves, published for navigation and never executed. */
  readonly occurrences: ReadonlyArray<import('./SemanticOccurrence.js').LocatedOccurrence>
  /** What the body infers that its author did not write, published for editor hints. */
  readonly hints: ReadonlyArray<import('./TypeHint.js').Row>
}

/** Narrows construction-only local metadata recovered from the private body builder. */
export const isBindingDeclarationFact = (value: unknown): value is BindingDeclarationFact =>
  typeof value === 'object' && value !== null && '_tag' in value && value._tag === 'BindingFact'

/** Narrows construction-only parameter metadata recovered from the private body builder. */
export const isParameterFact = (value: unknown): value is ParameterFact =>
  typeof value === 'object' &&
  value !== null &&
  '_tag' in value &&
  value._tag === 'ParameterDeclaration'

/** Narrows construction-only pattern-local metadata recovered from the private body builder. */
export const isPatternBindingFact = (value: unknown): value is PatternBindingFact =>
  typeof value === 'object' && value !== null && '_tag' in value && value._tag === 'PatternBinding'

/** Stable identity of one parent-linked lexical scope in an elaborated function. */
export interface LexicalScopeId {
  readonly _tag: 'LexicalScopeId'
  readonly function: DeclarationId
  readonly ordinal: number
}

/** Names introduced directly by one lexical scope, before parent traversal and shadowing. */
export interface LexicalScopeFact {
  readonly _tag: 'LexicalScope'
  readonly id: LexicalScopeId
  readonly parent?: LexicalScopeId
  /** The scope reaches from the start of `first` to the end of `last`: authored nodes, no offsets. */
  readonly first: AuthoredHir.Anchor
  readonly last: AuthoredHir.Anchor
  readonly parameters: ReadonlyArray<ParameterFact>
  readonly bindings: ReadonlyArray<ScopeBinding>
  readonly patternBindings: ReadonlyArray<PatternBindingFact>
}

/** A local as its scope publishes it: what it is, never how it was initialized. */
export type ScopeBinding = Omit<BindingDeclarationFact, 'initializer' | 'exactCallable'>

/** The closed result of looking up one declaration spelling. */
export type DeclarationLookup = DeclarationFacts.DeclarationLookup

/**
 * What a checked body publishes beside its nodes.
 *
 * Every row names authored nodes and declaration ids, never a position or a header object, so a
 * reused body keeps its results unchanged and each revision presents them again.
 */
export interface BodyResults {
  /** Authoritative selected-evidence payloads, addressed densely by executable nodes. */
  readonly evidence: ReadonlyArray<Tir.SelectedEvidence>
  /** Authoritative revision-free unavailable causes, addressed densely by executable nodes. */
  readonly causes: ReadonlyArray<Diagnostic.Identity<Location.Location>>
  /** Editor-only results, present when the semantic session serves tooling. */
  readonly tooling?: BodyTooling
  /** What each returned expression shows about the opaque result this body produces. */
  readonly opaqueEvidence: ReadonlyArray<import('./OpaqueRealization.js').Evidence>
  /** The finite region proof of the body, which ownership replays at cleanup. */
  readonly lifetimes?: import('./LifetimeFlow.js').LifetimeFlow
  /** Aggregates the body generated, which layout and later stages declare beside source ones. */
  readonly aggregates: ReadonlyArray<DeclarationFacts.StructFact>
  /** The body's half of the module's constrained-callable escape rule. */
  readonly callables: CallableFlow
  /** Why an application of this body must be specialized, when its own statements say so. */
  readonly staticStructure?: StaticStructure
  /** How each authored `static for` ended, outermost first. */
  readonly staticIterations: ReadonlyArray<StaticIterationRow>
}

/**
 * What a checked body publishes only for editors. Every row names authored nodes and declaration
 * ids, so a reused body keeps these unchanged as well.
 */
export interface BodyTooling {
  /** The authored names the body resolves: navigation reads these and never the body. */
  readonly occurrences: ReadonlyArray<import('./SemanticOccurrence.js').LocatedOccurrence>
  /** What the body infers that its author did not write, for editor hints. */
  readonly hints: ReadonlyArray<import('./TypeHint.js').Row>
  /** The body's lexical scopes and the locals each one introduces, for completion and hover. */
  readonly scopes: ReadonlyArray<LexicalScopeFact>
  /** The type each authored expression was given, in source order, for hover. */
  readonly expressionTypes: ReadonlyArray<ExpressionTypeRow>
}

/** One `static for` of a body: whether it was expanded, and the element each expansion bound. */
export interface StaticIterationRow {
  readonly at: AuthoredHir.Anchor
  readonly state: StaticIterationFact['state']
  readonly elements: ReadonlyArray<StaticValue.Value | undefined>
  readonly nested: ReadonlyArray<ReadonlyArray<StaticIterationRow>>
}

/** One typed expression as hover shows it. */
export interface ExpressionTypeRow {
  readonly at: AuthoredHir.Anchor
  readonly type: Type.Type
  readonly presentation?: SemanticDisplay.Presentation
}

/** Static work a body still holds after checking, which only a concrete application resolves. */
export type StaticStructure = 'StaticBinding' | 'UnresolvedConstant' | 'CompileError' | 'StaticCall'

/** One checked body: the declaration it belongs to, its nodes and its results. */
export interface CheckedBody {
  readonly artifact: Tir.ArtifactId
  readonly declaration: DeclarationFact
  /** A compiler-made body (an anonymous callable) that source lookup never finds. */
  readonly hidden: boolean
  /** A `static fn` keeps its static structure here and is never part of the module's runtime TIR. */
  readonly function: Tir.TirFunction
  readonly results: BodyResults
}

/** The complete deterministic elaboration result for all direct bootstrap declarations. */
export interface Result {
  readonly _tag: 'Elaboration'
  /** The authored module this elaboration consumed; reuse keys derive from it. */
  readonly authored: AuthoredLowering.Lowered
  readonly generatedAggregates: ReadonlyArray<DeclarationFacts.StructFact>
  readonly lexicalScopes: ReadonlyArray<LexicalScopeFact>
  readonly tir: Tir.Module
  /** Every checked body of the module, source declarations first and compiler-made ones after. */
  readonly bodies: ReadonlyArray<CheckedBody>
  readonly diagnostics: ReadonlyArray<Diagnostic.Located>
}

/** How many source bodies a module checked: compiler-made bodies are not counted. */
export const sourceBodyCount = (self: Result): number =>
  self.bodies.reduce((sum, body) => sum + (body.hidden ? 0 : 1), 0)

export const compatible: ReturnCompatibility = { _tag: 'Compatible' }
export const unavailableCompatibility: ReturnCompatibility = { _tag: 'Unavailable' }
export const availableI32ExpressionType: ExpressionTypeFact = {
  _tag: 'Available',
  type: 'i32',
}
export const availableUsizeExpressionType: ExpressionTypeFact = {
  _tag: 'Available',
  type: 'usize',
}
export const availableBoolExpressionType: ExpressionTypeFact = {
  _tag: 'Available',
  type: 'bool',
}
export const availableExpressionType = (type: SemanticType): ExpressionTypeFact => {
  if (type === 'i32') {
    return availableI32ExpressionType
  }
  if (type === 'usize') {
    return availableUsizeExpressionType
  }
  if (type === 'bool') {
    return availableBoolExpressionType
  }
  return { _tag: 'Available', type }
}
export const unavailableExpressionType: ExpressionTypeFact = { _tag: 'Unavailable' }

export const typesCompatible = (
  source: SemanticType,
  target: SemanticType,
  context?: TypeCompatibility.Context,
): boolean => TypeCompatibility.isCompatible(TypeCompatibility.check(source, target, context))

export const declaredReturnTypesCompatible = (
  context: SemanticContext.SemanticContext,
  declaration: DeclarationFact,
  expression: ExpressionDecision | Tir.Expression,
  compatibility?: TypeCompatibility.Context,
  builder?: BodyBuilder.BodyBuilder,
): boolean => {
  const selected =
    'origin' in expression && expression._tag === 'Unavailable' && builder !== undefined
      ? (BodyBuilder.semanticOfExpression(builder, expression) ?? expression)
      : expression
  const expressionType = constructionExpressionType(selected)
  if (declaration.returnType._tag !== 'Resolved' || expressionType._tag !== 'Available')
    return false
  const source = expressionType.type
  const target = declaration.returnType.type
  if (typesCompatible(source, target, compatibility)) return true
  const representation = representationOfExpression(context, selected, builder)
  const contract = Type.isRepresented(source) ? source.contract : source
  if (
    declaration.opaqueResult !== undefined &&
    Type.isRepresented(target) &&
    Type.isOpaqueRepresentationArgument(target.representation.argument) &&
    Type.equalsOpaqueFamily(target.representation.argument.family, declaration.opaqueResult.family)
  )
    return representation !== undefined && typesCompatible(contract, target.contract, compatibility)
  if (
    representation !== undefined &&
    (Type.isCallable(contract) || Type.isEffect(contract)) &&
    typesCompatible(Type.represented(contract, contract, representation), target, compatibility)
  )
    return true
  if (
    declaration.opaqueResult !== undefined &&
    Type.isUnion(target) &&
    target.members.some(
      (member) =>
        Type.isRepresented(member) &&
        Type.isOpaqueRepresentationArgument(member.representation.argument) &&
        Type.equalsOpaqueFamily(
          member.representation.argument.family,
          declaration.opaqueResult?.family ?? member.representation.argument.family,
        ) &&
        Type.haveSameRepresentationShape(source, member.contract),
    )
  )
    return true
  if (declaration.opaqueResult !== undefined && Type.haveSameRepresentationShape(source, target))
    return true
  if (!Type.isRepresented(target)) return false
  if (!(Type.isCallable(contract) || Type.isEffect(contract))) return false
  if (representation === undefined) return false
  const represented = Type.represented(
    contract,
    target.representation.requiredBound,
    representation,
  )
  return (
    represented.representation.admissibility._tag !== 'Unavailable' &&
    Type.equalsGenericArgument(representation, target.representation.argument)
  )
}

export const representationJoinDiagnostic = (
  expected: SemanticType,
  actual: SemanticType,
  expectedOrigin: Location.Location,
  actualOrigin: Location.Location,
  span: Location.Location,
): Diagnostic.Located | undefined => {
  const divergence = Type.firstRepresentationDivergence(expected, actual)
  return divergence === undefined
    ? undefined
    : Diagnostic.divergentRepresentationJoin(
        Type.encodeGenericArgument(divergence.left),
        Type.encodeGenericArgument(divergence.right),
        [expectedOrigin, actualOrigin],
        span,
      )
}

export const contextualIntegerCompatible = (
  expression: ExpressionDecision | Tir.Expression,
  target: SemanticType,
  builder?: BodyBuilder.BodyBuilder,
): boolean => {
  const semantic =
    'origin' in expression && builder !== undefined
      ? BodyBuilder.semanticOfExpression(builder, expression)
      : undefined
  if (semantic?._tag === 'Duration') return false
  let value: bigint | undefined
  if (semantic?._tag === 'Integer' && semantic.integer._tag === 'Available')
    value = semantic.integer.value
  else if ('origin' in expression) {
    if (expression._tag === 'IntegerLiteral') value = expression.value
  } else if (expression._tag === 'Integer' && expression.integer._tag === 'Available')
    value = expression.integer.value
  if (value === undefined) return false
  if (typeof target !== 'string' || !Scalar.isIntegerSpelling(target)) return false
  const scalar = Scalar.find(target)
  if (scalar?.category !== 'Integer') return false
  const range = Scalar.range(scalar, 64)
  return value >= range.minimum && value <= range.maximum
}

export const unionConversionDiagnostic = (
  source: SemanticType,
  target: SemanticType,
  span: Location.Location,
  context?: TypeCompatibility.Context,
): Diagnostic.Located | undefined => {
  const compatibility = TypeCompatibility.check(source, target, context)
  return compatibility._tag === 'Incompatible' &&
    (Type.isUnion(source) || Type.isNever(source) || Type.isUnion(target) || Type.isNever(target))
    ? Diagnostic.incompatibleUnionConversion(
        Type.encode(source),
        Type.encode(target),
        compatibility.missing.map(Type.encode),
        span,
      )
    : undefined
}

/** The authored callee of a call, seeing through pipelines to the applied target. */
export const callCallee = (node: AuthoredHir.Expression): AuthoredHir.Expression =>
  node._tag === 'CallExpression' ? node.callee : node

/**
 * The last name a type spells, seeing through an application so that an applied qualifier such as
 * `Holder<i32>` names `Holder` exactly as the bare qualifier `Holder` does.
 */
const qualifierName = (type: AuthoredHir.Type): AuthoredHir.Name | undefined => {
  if (type._tag === 'AppliedType') return qualifierName(type.target)
  return type._tag === 'NamedType' ? type.path.segments.at(-1) : undefined
}

/**
 * The qualifier/member name pair a callee reference spells, taken from the authored vocabulary.
 * Grouped expressions do not exist in authored HIR, so no unwrapping is needed.
 */
export const referenceNames = (node: AuthoredHir.Expression): ReadonlyArray<AuthoredHir.Name> => {
  const callee = callCallee(node)
  if (callee._tag === 'PipelineExpression') return referenceNames(callee.target)
  if (callee._tag === 'IdentifierExpression') return [callee.name]
  if (callee._tag === 'MemberExpression') {
    const qualifier = qualifierName(callee.selector.subject)
    return qualifier === undefined ? [] : [qualifier, callee.selector.member]
  }
  if (callee._tag !== 'FieldExpression') return []
  const qualifier = referenceNames(callee.subject).at(-1)
  return qualifier === undefined ? [] : [qualifier, callee.field]
}

export const referencePath = (
  context: SemanticContext.SemanticContext,
  node: AuthoredHir.Expression,
): ReferencePathFact => {
  const names = referenceNames(node)
  const member = names.at(-1)
  const qualifier = names.length > 1 ? names.at(0) : undefined
  if (member === undefined) return { _tag: 'UnavailableReferencePath', anchor: node.anchor }
  return {
    _tag: 'ReferencePath',
    ...(qualifier === undefined
      ? {}
      : {
          qualifierSpelling: SemanticContext.nameText(context, qualifier) ?? '',
          qualifierAnchor: qualifier.anchor,
        }),
    memberSpelling: SemanticContext.nameText(context, member) ?? '',
    memberAnchor: member.anchor,
  }
}

export const lookupParameter = DeclarationFacts.lookupParameter

export const lookupDeclaration = DeclarationFacts.lookupDeclaration

export interface IntegerResult {
  readonly fact: IntegerExpressionDecision
  readonly diagnostics: ReadonlyArray<Diagnostic.Located>
}

export interface ExpressionResult {
  readonly fact: ExpressionDecision
  /** The typed node already published while checking this construct. */
  readonly node?: Tir.Expression
  readonly diagnostics: ReadonlyArray<Diagnostic.Located>
  readonly type: SemanticType | undefined
}

/** Reads the typed node construction publishes before it proceeds to the parent construct. */
export const expressionNode = (self: ExpressionResult): Tir.Expression => {
  if (self.node === undefined)
    throw new RangeError('Expression analysis did not publish a TIR node')
  return self.node
}

/** Construction-time type view shared by a shallow decision and an already published child. */
export const constructionExpressionType = (
  self: ExpressionDecision | Tir.Expression,
): ExpressionTypeFact => {
  if (!('origin' in self)) return self.type
  return self._tag === 'Unavailable'
    ? unavailableExpressionType
    : availableExpressionType(self.type)
}

/** Authored position retained by both construction decisions and typed nodes. */
export const constructionExpressionAnchor = (
  self: ExpressionDecision | Tir.Expression,
): AuthoredHir.Anchor => ('origin' in self ? self.origin.anchor : self.anchor)

export interface IdentifierResult {
  readonly fact: IdentifierExpressionDecision
  readonly diagnostics: ReadonlyArray<Diagnostic.Located>
  readonly type: SemanticType | undefined
  readonly anchor: AuthoredHir.Anchor
}

export interface ArgumentsResult {
  readonly facts: ReadonlyArray<ArgumentFact>
  readonly diagnostics: ReadonlyArray<Diagnostic.Located>
}

export const argumentFact = (
  declaration: DeclarationFact,
  context: SemanticContext.SemanticContext,
  call: AuthoredHir.Anchor,
  input: ExpressionResult | ArgumentFact,
  ordinal: number,
): ArgumentFact => {
  const expression = 'fact' in input ? expressionNode(input) : input.expression
  const type = 'fact' in input ? input.fact.type : input.type
  const anchor = 'fact' in input ? input.fact.anchor : input.anchor
  const borrowRoot = (() => {
    if (!('fact' in input)) return input.borrowRoot
    const fact = input.fact
    if (fact._tag === 'Borrow' && fact.formation._tag !== 'Unavailable') return fact.formation.root
    if (
      fact._tag === 'FieldProjection' ||
      fact._tag === 'ReferentProjection' ||
      fact._tag === 'IndexProjection'
    )
      return fact.borrowRoot
    if (fact._tag !== 'Identifier') return undefined
    if (fact.reference._tag === 'ResolvedBinding')
      return {
        _tag: 'BindingRoot' as const,
        binding: fact.reference.binding,
        path: [],
      }
    if (fact.reference._tag === 'Resolved')
      return {
        _tag: 'ParameterRoot' as const,
        parameter: fact.reference.parameter,
        path: [],
      }
    if (fact.reference._tag === 'ResolvedPattern')
      return {
        _tag: 'PatternRoot' as const,
        binding: fact.reference.binding,
        path: [],
      }
    return undefined
  })()
  const invocationSource = (() => {
    if ('fact' in input)
      return input.fact._tag === 'Identifier' || input.fact._tag === 'Move'
        ? input.fact.invocationSource
        : undefined
    return input.invocationSource
  })()
  return {
    _tag: 'Argument',
    id: {
      _tag: 'ArgumentId',
      ordinal,
    },
    expression,
    ...(invocationSource === undefined ? {} : { invocationSource }),
    ...(borrowRoot === undefined ? {} : { borrowRoot }),
    type,
    anchor,
  }
}

import { copyAssumptionsOf } from './CallResolution.js'
import {
  analyzeConstant,
  effectCaptureFacts,
  representationOfExpression,
} from './ExpressionAnalysis.js'
import {
  directExpressionChildren,
  directStatementExpressions,
  staticLowering,
} from './BodyBuilder.js'
export interface FactVisitor {
  readonly statement?: (statement: Tir.Statement) => void
  readonly expression?: (expression: ExpressionDecision) => void
  readonly node?: (expression: Tir.Expression) => void
  readonly descendExpressions?: boolean
  readonly descendEffectBlocks?: boolean
}

/** Direct semantic children in source evaluation order. */
export const expressionChildren = (
  self: ExpressionDecision | Tir.Expression,
): ReadonlyArray<ExpressionDecision | Tir.Expression> =>
  'origin' in self ? Tir.expressionChildren(self) : directExpressionChildren(self)

const visitExpressionDecision = (
  expression: ExpressionDecision | Tir.Expression,
  visitor: FactVisitor,
): void => {
  if ('origin' in expression) {
    visitor.node?.(expression)
    for (const child of Tir.expressionChildren(expression)) visitExpressionDecision(child, visitor)
    return
  }
  visitor.expression?.(expression)
  if (expression._tag === 'Match') {
    visitExpressionDecision(expression.scrutinee, visitor)
    for (const arm of expression.arms) {
      if (arm.guard !== undefined) visitExpressionDecision(arm.guard, visitor)
      if (arm.body._tag === 'Expression') visitExpressionDecision(arm.body.expression, visitor)
      else visitStatements(arm.body.statements, visitor)
    }
    return
  }
  if (expression._tag === 'EffectBlock') {
    if (visitor.descendEffectBlocks !== false) visitStatements(expression.statements, visitor)
    return
  }
  for (const child of directExpressionChildren(expression)) visitExpressionDecision(child, visitor)
}

/** Visits one expression tree in deterministic source order. */
export const visitExpressionDecisions = (
  self: ExpressionDecision | Tir.Expression,
  visitor: FactVisitor,
): void => visitExpressionDecision(self, visitor)

/** Visits statement trees and, by default, every nested expression in source order. */
export const visitStatements = (self: ReadonlyArray<Tir.Statement>, visitor: FactVisitor): void => {
  const descendExpressions = visitor.descendExpressions !== false
  for (const statement of self) {
    visitor.statement?.(statement)
    if (descendExpressions)
      for (const expression of directStatementExpressions(statement))
        visitExpressionDecision(expression, visitor)
    if (statement._tag === 'Unsafe') visitStatements(statement.statements, visitor)
    else if (statement._tag === 'If' || statement._tag === 'IfLet') {
      visitStatements(statement.taken, visitor)
      visitStatements(statement.otherwise, visitor)
    } else if (statement._tag === 'While') visitStatements(statement.body, visitor)
  }
}

const constrainedCallableSchema = (
  expression: ExpressionDecision | Tir.Expression,
): Type.CallableSchema | undefined => {
  const type = constructionExpressionType(expression)
  if (type._tag !== 'Available' || !Type.isCallable(type.type)) return undefined
  const schema = type.type.schema
  return schema !== undefined &&
    (schema.binders.some(
      (binder) => binder.kind !== 'Lifetime' && !schema.substitution.has(Type.key(binder)),
    ) ||
      schema.constraints.length > 0 ||
      schema.evidence.length > 0)
    ? schema
    : undefined
}

const canonicalFunctionKey = (declaration: DeclarationFact): string | undefined =>
  declaration.canonical._tag === 'Canonical'
    ? `${declaration.canonical.id.module}\u0000${declaration.canonical.id.name}`
    : undefined

/** Where a callable value in a relay body comes from, before the module's other relays are known. */
export type CallableSource =
  | { readonly _tag: 'Parameter'; readonly ordinal: number }
  | { readonly _tag: 'Binding'; readonly ordinal: number; readonly source: CallableSource }
  | {
      readonly _tag: 'Call'
      readonly target: string
      readonly arguments: ReadonlyArray<{
        readonly parameter: number
        readonly source: CallableSource
      }>
    }

/** One place a constrained callable value would leave compile time. */
export type CallableEscape =
  | { readonly _tag: 'Value'; readonly at: AuthoredHir.Anchor }
  | {
      readonly _tag: 'Call'
      /** The canonical callee, which may turn out to relay one of its arguments. */
      readonly target?: string
      readonly arguments: ReadonlyArray<{
        readonly parameter: number
        readonly at: AuthoredHir.Anchor
      }>
      /** Set when the call's own result is a constrained callable. */
      readonly result?: AuthoredHir.Anchor
    }

/**
 * How constrained callables move through one body. The escape rule is decided per module, because
 * whether a call relays its argument depends on the callee's body; each body publishes only its
 * own half, so a reused body takes part without being read again.
 */
export interface CallableFlow {
  /**
   * Present when the body is only lexical binds followed by one return. Admitting any other
   * statement would erase observable work when lowering replaces the chain by its originating
   * callable recipe.
   */
  readonly relay?: { readonly leading: ReadonlyArray<number>; readonly source: CallableSource }
  readonly escapes: ReadonlyArray<CallableEscape>
}

const callableSourceOf = (
  current: ExpressionDecision | Tir.Expression,
  builder: BodyBuilder.BodyBuilder,
  bindings: ReadonlySet<number> = new Set(),
  tirBindings: ReadonlyMap<number, Tir.Expression> = new Map(),
  index?: DeclarationIndex.Index,
): CallableSource | undefined => {
  if ('origin' in current) {
    if (current._tag === 'Move')
      return callableSourceOf(current.subject, builder, bindings, tirBindings, index)
    // TIR locals are dense body identities; relays and escapes name declaration identities.
    if (current._tag === 'ParameterReference') {
      const parameter = BodyBuilder.semanticOfLocal(builder, current.parameter)
      return isParameterFact(parameter)
        ? { _tag: 'Parameter', ordinal: parameter.id.ordinal }
        : undefined
    }
    if (current._tag === 'BindingReference') {
      const binding = BodyBuilder.semanticOfLocal(builder, current.binding)
      if (!isBindingDeclarationFact(binding)) return undefined
      const ordinal = binding.id.ordinal
      if (bindings.has(ordinal)) return undefined
      const initializer = tirBindings.get(ordinal)
      if (initializer === undefined) return undefined
      const source = callableSourceOf(
        initializer,
        builder,
        new Set(bindings).add(ordinal),
        tirBindings,
        index,
      )
      return source === undefined ? undefined : { _tag: 'Binding', ordinal, source }
    }
    if (current._tag !== 'Call') return undefined
    const declaration =
      index === undefined ? undefined : DeclarationFacts.byCanonical(index, current.target)
    const parameters =
      declaration?._tag === 'FunctionDeclaration'
        ? declaration.parameters.filter((parameter) => parameter.phase !== 'Static')
        : []
    return {
      _tag: 'Call',
      target: `${current.target.module}\u0000${current.target.name}`,
      arguments: current.arguments.flatMap((argument, position) => {
        const source = callableSourceOf(argument, builder, bindings, tirBindings, index)
        return source === undefined
          ? []
          : [{ parameter: parameters.at(position)?.id.ordinal ?? position, source }]
      }),
    }
  }
  if (current._tag === 'Move')
    return callableSourceOf(current.subject, builder, bindings, tirBindings, index)
  if (current._tag === 'Identifier') {
    if (current.reference._tag === 'Resolved')
      return { _tag: 'Parameter', ordinal: current.reference.parameter.id.ordinal }
    if (current.reference._tag !== 'ResolvedBinding') return undefined
    const ordinal = current.reference.binding.id.ordinal
    if (bindings.has(ordinal)) return undefined
    const source = callableSourceOf(
      current.reference.binding.initializer,
      builder,
      new Set(bindings).add(ordinal),
      tirBindings,
      index,
    )
    return source === undefined ? undefined : { _tag: 'Binding', ordinal, source }
  }
  if (current._tag !== 'Call' || current.reference._tag !== 'Resolved') return undefined
  const target = canonicalFunctionKey(current.reference.declaration)
  if (target === undefined) return undefined
  return {
    _tag: 'Call',
    target,
    arguments: current.mappings.flatMap((mapping) => {
      const source = callableSourceOf(
        mapping.argument.expression,
        builder,
        bindings,
        tirBindings,
        index,
      )
      return source === undefined ? [] : [{ parameter: mapping.parameter.id.ordinal, source }]
    }),
  }
}

const callableFlowOf = (
  fn: FunctionConstruction,
  index: DeclarationIndex.Index,
  builder: BodyBuilder.BodyBuilder,
): CallableFlow => {
  const escapes: Array<CallableEscape> = []
  const tirBindings = new Map<number, Tir.Expression>()
  visitStatements(fn.statements, {
    statement: (statement) => {
      if (statement._tag !== 'Bind') return
      const binding = BodyBuilder.semanticOfLocal(builder, statement.binding)
      if (isBindingDeclarationFact(binding))
        tirBindings.set(binding.id.ordinal, statement.initializer)
    },
    descendExpressions: false,
  })
  const constrainedSchemaOf = (
    expression: ExpressionDecision | Tir.Expression,
  ): Type.CallableSchema | undefined => {
    const direct = constrainedCallableSchema(expression)
    if (direct !== undefined || !('origin' in expression)) return direct
    const semantic = BodyBuilder.semanticOfExpression(builder, expression)
    return semantic === undefined ? undefined : constrainedCallableSchema(semantic)
  }
  const value = (expression: ExpressionDecision | Tir.Expression): void => {
    if (constrainedSchemaOf(expression) !== undefined)
      escapes.push({ _tag: 'Value', at: constructionExpressionAnchor(expression) })
  }
  const expressionEscape = (expression: ExpressionDecision): void => {
    if (expression._tag === 'StructLiteral' || expression._tag === 'UnionVariant') {
      for (const initializer of expression.initializers) value(initializer.expression)
      return
    }
    if (expression._tag === 'ArrayLiteral') {
      for (const element of expression.elements) value(element.expression)
      return
    }
    if (expression._tag === 'CallableSection') {
      for (const capture of expression.captures) value(capture.expression)
      return
    }
    if (expression._tag === 'EffectBlock') {
      for (const capture of expression.captures)
        if (capture.reference._tag === 'BindingFact') value(capture.reference.initializer)
      return
    }
    if (expression._tag === 'Match') {
      value(expression)
      return
    }
    if (expression._tag === 'CallableApply') {
      for (const argument of expression.arguments) value(argument.expression)
      return
    }
    if (expression._tag !== 'Call') return
    const target =
      expression.reference._tag === 'Resolved'
        ? canonicalFunctionKey(expression.reference.declaration)
        : undefined
    const arguments_ = expression.mappings.flatMap((mapping) =>
      constrainedSchemaOf(mapping.argument.expression) === undefined
        ? []
        : [
            {
              parameter: mapping.parameter.id.ordinal,
              at: constructionExpressionAnchor(mapping.argument.expression),
            },
          ],
    )
    const constrained = constrainedSchemaOf(expression) !== undefined
    if (arguments_.length === 0 && !constrained) return
    escapes.push({
      _tag: 'Call',
      ...(target === undefined ? {} : { target }),
      arguments: arguments_,
      ...(constrained ? { result: expression.anchor } : {}),
    })
  }
  const semanticFlowVisitor: FactVisitor = {
    expression: expressionEscape,
    node: (expression) => {
      if (expression._tag !== 'Unavailable') return
      const semantic = BodyBuilder.semanticOfExpression(builder, expression)
      if (semantic !== undefined) visitExpressionDecision(semantic, semanticFlowVisitor)
    },
  }
  visitStatements(fn.statements, {
    statement: (statement) => {
      if (statement._tag === 'Return') value(statement.expression)
      else if (statement._tag === 'Write') value(statement.value)
    },
    expression: expressionEscape,
    node: (expression) => {
      if (expression._tag === 'Unavailable') {
        const semantic = BodyBuilder.semanticOfExpression(builder, expression)
        if (semantic !== undefined) visitExpressionDecision(semantic, semanticFlowVisitor)
        return
      }
      if (expression._tag === 'Construct' || expression._tag === 'ConstructUnionVariant') {
        for (const field of expression.fields) value(field.value)
        return
      }
      if (expression._tag === 'ArrayConstruct') {
        for (const element of expression.elements) value(element)
        return
      }
      if (expression._tag === 'CallableSection') {
        for (const capture of expression.captures) value(capture.value)
        return
      }
      if (expression._tag === 'Match') {
        value(expression)
        return
      }
      if (expression._tag === 'CallableApply') {
        for (const argument of expression.arguments) value(argument)
        return
      }
      if (expression._tag !== 'Call') return
      const declaration = DeclarationFacts.byCanonical(index, expression.target)
      const parameters =
        declaration?._tag === 'FunctionDeclaration'
          ? declaration.parameters.filter((parameter) => parameter.phase !== 'Static')
          : []
      const arguments_ = expression.arguments.flatMap((argument, position) =>
        constrainedSchemaOf(argument) === undefined
          ? []
          : [
              {
                parameter: parameters.at(position)?.id.ordinal ?? position,
                at: constructionExpressionAnchor(argument),
              },
            ],
      )
      const constrained = constrainedSchemaOf(expression) !== undefined
      if (arguments_.length === 0 && !constrained) return
      escapes.push({
        _tag: 'Call',
        target: `${expression.target.module}\u0000${expression.target.name}`,
        arguments: arguments_,
        ...(constrained ? { result: constructionExpressionAnchor(expression) } : {}),
      })
    },
  })
  const leading = fn.statements.slice(0, -1)
  const terminal = fn.statements.at(-1)
  const source =
    fn.declaration.parameters.length === 1 &&
    terminal?._tag === 'Return' &&
    leading.every((statement) => statement._tag === 'Bind')
      ? callableSourceOf(terminal.expression, builder, new Set(), tirBindings, index)
      : undefined
  return {
    ...(source === undefined
      ? {}
      : {
          relay: {
            leading: leading.flatMap((statement) =>
              statement._tag === 'Bind'
                ? (() => {
                    const binding = BodyBuilder.semanticOfLocal(builder, statement.binding)
                    return isBindingDeclarationFact(binding) ? [binding.id.ordinal] : []
                  })()
                : [],
            ),
            source,
          },
        }),
    escapes: escapes,
  }
}

/** The parameter a relay body hands back, once the relays it calls are resolved. */
const relayedParameter = (
  key_: string,
  flows: ReadonlyMap<string, CallableFlow>,
  resolving: ReadonlySet<string> = new Set(),
): number | undefined => {
  const relay = flows.get(key_)?.relay
  if (relay === undefined || resolving.has(key_)) return undefined
  const inner = new Set(resolving).add(key_)
  const visited = new Set<number>()
  const resolve = (source: CallableSource): number | undefined => {
    if (source._tag === 'Parameter') return source.ordinal
    if (source._tag === 'Binding') {
      visited.add(source.ordinal)
      return resolve(source.source)
    }
    const forwarded = relayedParameter(source.target, flows, inner)
    const argument = source.arguments.find((entry) => entry.parameter === forwarded)
    return argument === undefined ? undefined : resolve(argument.source)
  }
  const forwarded = resolve(relay.source)
  return forwarded === undefined || relay.leading.some((ordinal) => !visited.has(ordinal))
    ? undefined
    : forwarded
}

const constrainedCallableEscapeDiagnostics = (
  bodies: ReadonlyArray<CheckedBody>,
): ReadonlyArray<Diagnostic.Located> => {
  const source = bodies.filter((body) => !body.hidden)
  const flows = new Map(
    source.flatMap((body) => {
      const key_ = canonicalFunctionKey(body.declaration)
      return key_ === undefined ? [] : [[key_, body.results.callables] as const]
    }),
  )
  const diagnostics: Array<Diagnostic.Located> = []
  const seen = new Set<string>()
  const reject = (at: AuthoredHir.Anchor): void => {
    const key_ = AuthoredIdentity.anchorKey(at)
    if (seen.has(key_)) return
    seen.add(key_)
    diagnostics.push(Diagnostic.nonConcreteSpecialization('constrained callable', Location.at(at)))
  }
  for (const body of source)
    for (const escape of body.results.callables.escapes) {
      if (escape._tag === 'Value') {
        reject(escape.at)
        continue
      }
      const forwarded =
        escape.target === undefined ? undefined : relayedParameter(escape.target, flows)
      let relayed = false
      for (const argument of escape.arguments)
        if (argument.parameter === forwarded) relayed = true
        else reject(argument.at)
      if (escape.result !== undefined && !relayed) reject(escape.result)
    }
  return diagnostics
}

const lexicalScopesOf = (
  fn: FunctionConstruction,
  builder: BodyBuilder.BodyBuilder,
): ReadonlyArray<LexicalScopeFact> => {
  const scopes: Array<LexicalScopeFact> = []
  {
    let ordinal = 0
    const add = (options: {
      readonly parent?: LexicalScopeId
      readonly first: AuthoredHir.Anchor
      readonly last?: AuthoredHir.Anchor
      readonly parameters?: ReadonlyArray<ParameterFact>
      readonly bindings?: ReadonlyArray<BindingDeclarationFact>
      readonly patternBindings?: ReadonlyArray<PatternBindingFact>
    }): LexicalScopeId => {
      const id = {
        _tag: 'LexicalScopeId' as const,
        function: fn.declaration.id,
        ordinal,
      }
      ordinal += 1
      scopes.push({
        _tag: 'LexicalScope',
        id,
        ...(options.parent === undefined ? {} : { parent: options.parent }),
        first: options.first,
        last: options.last ?? options.first,
        parameters: Array.from(options.parameters ?? []),
        // A scope names its locals; their initializers are working records and stay behind.
        bindings: (options.bindings ?? []).map(
          ({ initializer: _initializer, exactCallable: _exactCallable, ...local }) => local,
        ),
        patternBindings: Array.from(options.patternBindings ?? []),
      })
      return id
    }
    const anchorOf = (statement: Tir.Statement): AuthoredHir.Anchor => statement.origin.anchor
    const extentOf = (
      statements: ReadonlyArray<Tir.Statement>,
      fallback: AuthoredHir.Anchor,
    ): { readonly first: AuthoredHir.Anchor; readonly last: AuthoredHir.Anchor } => {
      const first = statements.at(0)
      const last = statements.at(-1)
      return first === undefined || last === undefined
        ? { first: fallback, last: fallback }
        : { first: anchorOf(first), last: anchorOf(last) }
    }
    let visitStatements: (
      statements: ReadonlyArray<Tir.Statement>,
      parent: LexicalScopeId | undefined,
      fallback: AuthoredHir.Anchor,
    ) => LexicalScopeId
    const visitExpression = (
      expression: ExpressionDecision | Tir.Expression,
      parent: LexicalScopeId,
    ): void => {
      if ('origin' in expression) {
        const semantic = BodyBuilder.semanticOfExpression(builder, expression)
        if (semantic !== undefined) {
          visitExpression(semantic, parent)
          return
        }
        if (expression._tag === 'Match') {
          visitExpression(expression.scrutinee, parent)
          for (const arm of expression.arms) {
            const armScope = add({
              parent,
              first: arm.at ?? expression.origin.anchor,
              last:
                arm.body._tag === 'Expression'
                  ? arm.body.expression.origin.anchor
                  : (arm.body.statements.at(-1)?.origin.anchor ?? arm.body.origin.anchor),
              patternBindings: arm.bindings.flatMap((binding) => {
                const semantic = BodyBuilder.semanticOfLocal(builder, binding.id)
                return isPatternBindingFact(semantic) ? [semantic] : []
              }),
            })
            if (arm.guard !== undefined) visitExpression(arm.guard, armScope)
            if (arm.body._tag === 'Expression') visitExpression(arm.body.expression, armScope)
            else visitStatements(arm.body.statements, armScope, arm.body.origin.anchor)
          }
          return
        }
        if (expression._tag === 'EffectBlock') {
          visitStatements(expression.statements, parent, expression.origin.anchor)
          return
        }
        for (const child of Tir.expressionChildren(expression)) visitExpression(child, parent)
        return
      }
      if (expression._tag === 'Match') {
        visitExpression(expression.scrutinee, parent)
        for (const arm of expression.arms) {
          const armScope = add({
            parent,
            first: arm.anchor,
            last:
              arm.body._tag === 'Expression'
                ? constructionExpressionAnchor(arm.body.expression)
                : (arm.body.statements.at(-1)?.origin.anchor ?? arm.body.anchor),
            patternBindings: arm.bindings,
          })
          if (arm.guard !== undefined) visitExpression(arm.guard, armScope)
          if (arm.body._tag === 'Expression') visitExpression(arm.body.expression, armScope)
          else visitStatements(arm.body.statements, armScope, arm.body.anchor)
        }
        return
      }
      if (expression._tag === 'EffectBlock') {
        visitStatements(expression.statements, parent, expression.anchor)
        return
      }
      for (const child of directExpressionChildren(expression)) visitExpression(child, parent)
    }
    visitStatements = (
      statements: ReadonlyArray<Tir.Statement>,
      parent: LexicalScopeId | undefined,
      fallback: AuthoredHir.Anchor,
    ): LexicalScopeId => {
      const current = add({
        ...(parent === undefined ? {} : { parent }),
        ...extentOf(statements, fallback),
        ...(parent === undefined ? { parameters: fn.declaration.parameters } : {}),
        bindings: statements.flatMap((statement) =>
          statement._tag === 'Bind'
            ? (() => {
                const semantic = BodyBuilder.semanticOfLocal(builder, statement.binding)
                return isBindingDeclarationFact(semantic) ? [semantic] : []
              })()
            : [],
        ),
        patternBindings: statements.flatMap((statement) =>
          statement._tag === 'PatternBind'
            ? statement.selection.bindings.flatMap((binding) => {
                const semantic = BodyBuilder.semanticOfLocal(builder, binding.id)
                return isPatternBindingFact(semantic) ? [semantic] : []
              })
            : [],
        ),
      })
      for (const statement of statements) {
        for (const expression of directStatementExpressions(statement))
          visitExpression(expression, current)
        if (statement._tag === 'Unsafe')
          visitStatements(statement.statements, current, statement.origin.anchor)
        else if (statement._tag === 'If') {
          visitStatements(statement.taken, current, statement.origin.anchor)
          visitStatements(statement.otherwise, current, statement.origin.anchor)
        } else if (statement._tag === 'IfLet') {
          const takenScope = add({
            parent: current,
            first: statement.origin.anchor,
            last: statement.taken.at(-1)?.origin.anchor ?? statement.origin.anchor,
            patternBindings: statement.selection.bindings.flatMap((binding) => {
              const semantic = BodyBuilder.semanticOfLocal(builder, binding.id)
              return isPatternBindingFact(semantic) ? [semantic] : []
            }),
          })
          visitStatements(statement.taken, takenScope, statement.origin.anchor)
          visitStatements(statement.otherwise, current, statement.origin.anchor)
        } else if (statement._tag === 'While')
          visitStatements(statement.body, current, statement.origin.anchor)
      }
      return current
    }
    visitStatements(fn.statements, undefined, fn.declaration.anchor)
  }
  return scopes
}

/** Elaborates every declaration body into immutable facts and the module's TIR. */
export interface Input {
  readonly bodyQuery?: BodyQuery.BodyQuery
  readonly trace?: CompilerTrace.CompilerTrace
  readonly authored: AuthoredLowering.Lowered
  readonly headers: DeclarationFacts.ModuleHeaders
  readonly scope: NameResolution.ModuleScope
  readonly index: DeclarationIndex.Index
  readonly session: Semantic.Session
}

/** The authored block of a callable declaration body, when it has one. */
export const authoredBody = (
  authored: AuthoredLowering.Lowered,
  declaration: DeclarationFact,
): AuthoredHir.Block | undefined => {
  const found = AuthoredLowering.declarationOf(authored, declaration.owner)
  return found?.body._tag === 'CallableBody' ? found.body.block : undefined
}

const runtimeTirFunction = (
  context: SemanticContext.SemanticContext,
  fact: FunctionConstruction,
  index: DeclarationIndex.Index,
  builder: BodyBuilder.BodyBuilder,
): Tir.TirFunction => {
  const originalEntryRegion = fact.regionOrder.at(0) ?? {
    _tag: 'TirRegion' as const,
    function: fact.declaration.id,
    ordinal: 0,
  }
  const baseContract = Tir.contractOf(fact.declaration)
  if (
    fact.declaration.functionKind === 'Effect' &&
    fact.declaration.returnType._tag === 'Resolved' &&
    baseContract._tag === 'Contract'
  ) {
    const referenced = effectCaptureFacts(
      context,
      fact.statements,
      0,
      index,
      copyAssumptionsOf(fact.declaration),
      { builder },
    )
    // Every runtime argument enters the deferred environment at construction, even when the body
    // never reads it. Retaining declaration order also retains reverse-argument cleanup order.
    const referencedParameterOrdinals = new Set(
      referenced.flatMap((capture): ReadonlyArray<number> =>
        capture.reference._tag === 'ParameterDeclaration' ? [capture.reference.id.ordinal] : [],
      ),
    )
    const unreferenced = fact.declaration.parameters.flatMap(
      (parameter): ReadonlyArray<EffectCaptureFact> => {
        if (parameter.phase !== 'Runtime' || referencedParameterOrdinals.has(parameter.id.ordinal))
          return []
        const declared = parameter.declaredType
        return [
          {
            _tag: 'EffectCapture',
            reference: parameter,
            access:
              parameter.captureAccess ??
              (declared._tag === 'Resolved' && Type.isSlice(declared.type)
                ? declared.type.access
                : 'Take'),
            span: context.spanOf(parameter.anchor),
            anchor: parameter.anchor,
          },
        ]
      },
    )
    const captures = [...referenced, ...unreferenced]
      .sort(
        (left, right) =>
          left.reference.id.ordinal - right.reference.id.ordinal ||
          left.span.start - right.span.start,
      )
      .map((capture) => {
        if (capture.reference._tag !== 'ParameterDeclaration') return capture
        const declared = capture.reference.declaredType
        if (declared._tag !== 'Resolved' || Type.isSlice(declared.type)) return capture
        return {
          ...capture,
          access:
            capture.reference.captureAccess ??
            (ConformanceProof.copyType(index, declared.type, copyAssumptionsOf(fact.declaration))
              ? ('Copy' as const)
              : ('Take' as const)),
        }
      })
    const semanticCaptureAccess = (capture: EffectCaptureFact): Type.Effect['access'] | 'Copy' => {
      if (capture.reference._tag !== 'ParameterDeclaration') return capture.access
      const declared = capture.reference.declaredType
      if (declared._tag !== 'Resolved') return capture.access
      if (Type.isEffect(declared.type)) return declared.type.access
      if (Type.isCallable(declared.type)) return declared.type.mode
      if (Type.isReference(declared.type) || Type.isSlice(declared.type))
        return declared.type.access
      return capture.access
    }
    const semanticAccesses = captures.map(semanticCaptureAccess)
    let access: 'Take' | 'Exclusive' | 'Shared'
    if (semanticAccesses.some((capture) => capture === 'Take')) {
      access = 'Take'
    } else if (semanticAccesses.some((capture) => capture === 'Exclusive')) {
      access = 'Exclusive'
    } else {
      access = 'Shared'
    }
    const type = Type.effectWithRows(
      fact.declaration.returnType.type,
      fact.declaration.failureRow.row,
      DeclarationFacts.effectLifetimes(fact.declaration),
      access,
      fact.declaration.requirementRow.row,
    )
    const siteAnchor = fact.bodyAnchor ?? fact.declaration.anchor
    const siteSpan = context.spanOf(siteAnchor)
    const entryRegion: Tir.RegionId = {
      _tag: 'TirRegion',
      function: fact.declaration.id,
      ordinal: Math.max(-1, ...fact.regionOrder.map((region) => region.ordinal)) + 1,
    }
    const effectBlock = BodyBuilder.node(builder, {
      _tag: 'EffectBlock',
      site: Tir.effectRootSite(
        builder.artifact,
        fact.declaration.id.ordinal,
        fact.declaration.canonical._tag === 'Canonical' ? fact.declaration.canonical.id : undefined,
      ),
      statements: fact.statements,
      captures: captures.map((capture) => ({
        ...(capture.reference._tag === 'BindingFact'
          ? { binding: BodyBuilder.localId(builder, capture.reference.id) }
          : {}),
        ...(capture.reference._tag === 'PatternBinding'
          ? { pattern: BodyBuilder.localId(builder, capture.reference.id) }
          : {}),
        ...(capture.reference._tag === 'ParameterDeclaration'
          ? { parameter: BodyBuilder.localId(builder, capture.reference.id) }
          : {}),
        access: capture.access,
        span: capture.span,
      })),
      type,
      span: siteSpan,
      origin: Tir.synthetic(siteAnchor, 'effect-body'),
    }) as Extract<Tir.Expression, { readonly _tag: 'EffectBlock' }>
    return {
      _tag: 'TirFunction',
      declaration: fact.declaration,
      contract: {
        _tag: 'Contract',
        unsafe: baseContract.unsafe,
        parameters: baseContract.parameters,
        result: type,
        constraints: baseContract.constraints,
      },
      entryRegion,
      regionOrder: [entryRegion, ...fact.regionOrder],
      statements: [
        BodyBuilder.node(builder, {
          _tag: 'Return' as const,
          expression: effectBlock,
          region: entryRegion,
          span: siteSpan,
          origin: Tir.synthetic(siteAnchor, 'effect-return'),
        }),
      ],
    }
  }
  return {
    _tag: 'TirFunction',
    declaration: fact.declaration,
    contract: baseContract,
    entryRegion: originalEntryRegion,
    regionOrder: fact.regionOrder,
    statements: fact.statements,
  }
}

/**
 * Everything construction publishes for one source declaration: its own body first, then the
 * compiler-made bodies it produced, and what checking them reported. It is the unit of reuse.
 */
export interface CheckedUnit {
  readonly bodies: ReadonlyArray<CheckedBody>
  readonly diagnostics: ReadonlyArray<Diagnostic.Located>
}

const staticStructureOf = (
  fact: FunctionConstruction,
  index: DeclarationIndex.Index,
): StaticStructure | undefined => {
  let found: StaticStructure | undefined
  const recordNode = (expression: Tir.Expression): void => {
    if (found !== undefined) return
    if (expression._tag === 'ConstantReference') found = 'UnresolvedConstant'
    else if (expression._tag === 'CompileError') found = 'CompileError'
    else if (expression._tag === 'StaticCall') found = 'StaticCall'
    else if (expression._tag === 'Call' || expression._tag === 'EffectConstruct') {
      const declaration = DeclarationFacts.byCanonical(index, expression.target)
      if (
        declaration?._tag === 'FunctionDeclaration' &&
        (declaration.phase === 'Static' ||
          declaration.parameters.some((parameter) => parameter.phase === 'Static'))
      )
        found = 'StaticCall'
    }
  }
  // Runtime publication erases static bindings, so they are read from the construction facts.
  if (fact.bindings.some((binding) => binding.phase === 'Static')) return 'StaticBinding'
  visitStatements(fact.statements, { node: recordNode })
  return found
}

const staticIterationRows = (
  iterations: ReadonlyArray<StaticIterationFact>,
): ReadonlyArray<StaticIterationRow> =>
  iterations.map((iteration) => ({
    at: iteration.anchor,
    state: iteration.state,
    elements: iteration.scopes.map((scope) => scope.binding.staticValue),
    nested: iteration.scopes.map((scope) => staticIterationRows(scope.staticIterations)),
  }))

const expressionTypesOf = (
  fact: FunctionConstruction,
  builder: BodyBuilder.BodyBuilder,
): ReadonlyArray<ExpressionTypeRow> => {
  const rows: Array<ExpressionTypeRow> = []
  visitStatements(fact.statements, {
    node: (expression) => {
      if (expression._tag === 'Unavailable') return
      const semantic = BodyBuilder.semanticOfExpression(builder, expression)
      const presentation =
        semantic?._tag === 'CallableSection' && semantic.anonymous !== undefined
          ? SemanticDisplay.anonymousCallable(semantic, semantic.anonymous)
          : undefined
      rows.push({
        at: expression.origin.anchor,
        type: expression.type,
        ...(presentation === undefined ? {} : { presentation }),
      })
    },
  })
  return rows
}

/** A `static fn` body keeps its static structure: it runs in the evaluator and never at run time. */
const staticTirFunction = (
  context: SemanticContext.SemanticContext,
  fact: FunctionConstruction,
  builder: BodyBuilder.BodyBuilder,
): Tir.TirFunction => ({
  _tag: 'TirFunction',
  declaration: fact.declaration,
  contract: Tir.contractOf(fact.declaration),
  entryRegion: fact.regionOrder.at(0) ?? {
    _tag: 'TirRegion' as const,
    function: fact.declaration.id,
    ordinal: 0,
  },
  regionOrder: fact.regionOrder,
  statements: staticLowering(context, builder).statements(fact.statements),
})

/**
 * A checked body as one revision reads it. The body itself names authored nodes only; every
 * position it shows is stamped here from the node beside it, and its header is this revision's.
 */
export const presentBody = (
  self: CheckedBody,
  context: SemanticContext.SemanticContext,
  declaration: DeclarationFact = self.declaration,
): CheckedBody => {
  const stamped = Tir.stamp(self.results, context.spanOf)
  const results =
    stamped.lifetimes === undefined
      ? stamped
      : {
          ...stamped,
          lifetimes: LifetimeFlow.present(stamped.lifetimes, context),
        }
  return {
    artifact: self.artifact,
    declaration,
    hidden: self.hidden,
    function: Tir.present(self.function, context.spanOf, declaration),
    results,
  }
}

/** Publishes one analyzed body: its nodes, when it runs, and the tables later stages read. */
export const checkedBody = (
  context: SemanticContext.SemanticContext,
  index: DeclarationIndex.Index,
  fact: FunctionConstruction,
  /** Set for a compiler-made body: the artifact whose construction produced it. */
  parent?: Tir.ArtifactId,
  request: Tir.ArtifactId['request'] = { _tag: 'Check' },
  construction?: BodyBuilder.BodyBuilder,
): CheckedBody => {
  const hidden = parent !== undefined
  const artifact: Tir.ArtifactId = {
    owner: fact.declaration.owner,
    request,
    ...(parent === undefined ? {} : { parent }),
  }
  const builder = construction ?? BodyBuilder.make(artifact)
  if (Tir.artifactKey(builder.artifact) !== Tir.artifactKey(artifact))
    throw new RangeError('TIR body builder belongs to another artifact')
  const lowered = BodyBuilder.finish(
    builder,
    fact.declaration.phase === 'Static'
      ? staticTirFunction(context, fact, builder)
      : runtimeTirFunction(context, fact, index, builder),
  )
  const staticStructure = staticStructureOf(fact, index)
  const results: BodyResults = {
    evidence: Array.from(builder.evidence),
    causes: Array.from(builder.causes),
    ...(fact.tooling === undefined
      ? {}
      : {
          tooling: {
            occurrences: fact.tooling.occurrences,
            hints: fact.tooling.hints,
            scopes: lexicalScopesOf(fact, builder),
            expressionTypes: expressionTypesOf(fact, builder),
          },
        }),
    opaqueEvidence: fact.opaqueEvidence,
    ...(fact.lifetimeFlow === undefined ? {} : { lifetimes: fact.lifetimeFlow }),
    aggregates: fact.generatedAggregates,
    callables: callableFlowOf(fact, index, builder),
    ...(staticStructure === undefined ? {} : { staticStructure }),
    staticIterations: staticIterationRows(fact.staticIterations),
  }
  return {
    artifact,
    declaration: fact.declaration,
    hidden,
    function: lowered,
    results,
  }
}

export const elaborateModule = (input: Input): Result => {
  const { authored, headers, scope, index, session } = input
  const context = SemanticContext.make(authored)
  const declarations = headers.declarations
  // A foreign header has a native body: it is indexed and callable but never analyzed here.
  const units = declarations
    .filter((declaration) => declaration.foreign === undefined)
    .map((declaration): CheckedUnit =>
      Semantic.checkBody({
        authored,
        headers,
        scope,
        index,
        session,
        declaration,
        ...(input.bodyQuery === undefined ? {} : { query: input.bodyQuery }),
        ...(input.trace === undefined ? {} : { trace: input.trace }),
      }),
    )
  const constantDiagnostics = headers.constants.flatMap((constant) =>
    constant.name._tag === 'Present'
      ? analyzeConstant(context, constant, constant.name.anchor, true).diagnostics
      : [],
  )
  const all = units.flatMap((unit) => unit.bodies)
  const bodies = [...all.filter((body) => !body.hidden), ...all.filter((body) => body.hidden)]
  const tir: Tir.Module = {
    _tag: 'TirModule',
    module: authored.module.owner.module,
    functions: bodies.flatMap((body) =>
      body.declaration.phase === 'Static' ? [] : [body.function],
    ),
  }

  const result: Result = {
    _tag: 'Elaboration',
    authored,
    generatedAggregates: bodies.flatMap((body) => body.results.aggregates),
    lexicalScopes: bodies.flatMap((body) => body.results.tooling?.scopes ?? []),
    tir,
    bodies,
    diagnostics: [
      ...headers.diagnostics,
      ...constantDiagnostics,
      ...units.flatMap((unit) => unit.diagnostics),
      ...constrainedCallableEscapeDiagnostics(bodies),
    ],
  }
  return result
}

/** Looks up every present declaration with the exact requested spelling. */
export const declarationByName = dual<
  (spelling: string) => (self: Result) => DeclarationLookup,
  (self: Result, spelling: string) => DeclarationLookup
>(2, (self, spelling) =>
  lookupDeclaration(
    self.bodies.flatMap((body) => (body.hidden ? [] : [body.declaration])),
    spelling,
  ),
)

/** Looks up every present parameter with the exact requested spelling in one function. */
export const parameterByName = dual<
  (spelling: string) => (self: DeclarationFact) => ParameterLookup,
  (self: DeclarationFact, spelling: string) => ParameterLookup
>(2, (self, spelling) => lookupParameter(self.parameters, spelling))
