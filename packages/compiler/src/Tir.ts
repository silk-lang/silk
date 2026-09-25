import type * as NativeAssembly from './NativeAssembly.js'
import * as Lifetime from './Lifetime.js'
import * as Constraint from './Constraint.js'
import type * as ConformanceGoal from './ConformanceGoal.js'
import type * as ConformanceProof from './ConformanceProof.js'
import type * as DeclarationFacts from './DeclarationFacts.js'
import * as AuthoredIdentity from './AuthoredIdentity.js'
import type * as Diagnostic from './Diagnostic.js'
import type * as Location from './Location.js'
import * as Intrinsic from './Intrinsic.js'
import * as Match from './Match.js'
import type * as Operator from './Operator.js'
import * as RowAlgebra from './RowAlgebra.js'
import type * as Scalar from './Scalar.js'
import type * as SourceSpan from './SourceSpan.js'
import * as SourceSpanModule from './SourceSpan.js'
import type * as Evaluation from './Evaluation.js'
import type * as StaticText from './StaticText.js'
import * as StaticValue from './StaticValue.js'
import * as Type from './Type.js'
import * as TypeCompatibility from './TypeCompatibility.js'

/**
 * TIR: the resolved, typed semantic representation of elaborated bodies. Core operations carry
 * their resolved type and exact source provenance; unknown facts stay explicit unavailable
 * states and never masquerade as typed operations.
 */

/** A normalized function contract: ordered parameter types and the result type. */
export interface Contract {
  readonly _tag: 'Contract'
  readonly functionKind?: 'Ordinary' | 'Effect'
  readonly unsafe: boolean
  readonly parameters: ReadonlyArray<DeclarationFacts.SemanticType>
  readonly result: DeclarationFacts.SemanticType
  readonly failureRow?: Type.FailureRow
  readonly requirementRow?: Type.RequirementsRow
  readonly constraints: ReadonlyArray<Constraint.Constraint>
}

/** Resolves one symbolic binding selector at a complete application frontier. */
export const selectedRequirement = (
  provider: Extract<Expression, { readonly _tag: 'EffectBindRequirement' }>['provider'],
  substitution: Type.Substitution,
): Type.Requirement | undefined => {
  const selected = Type.substituteRequirementsRow(provider.selected, substitution)
  const concrete = RowAlgebra.concretize(Type.requirementRowPolicy(), selected)
  return concrete._tag === 'Concrete' && concrete.row.members.length === 1
    ? concrete.row.members.at(0)
    : undefined
}

/** The normalized or explicitly unavailable contract of one declaration. */
export type ContractFact =
  | Contract
  /** Derived from a header without a presentation, so the cause is still revision-free. */
  | { readonly _tag: 'Unavailable'; readonly cause?: Diagnostic.Identity<Location.Location> }

/** Private construction identity retained only until direct body construction is complete. */
export interface BindingId {
  readonly _tag: 'TirBinding'
  readonly function: DeclarationFacts.DeclarationId
  readonly ordinal: number
}

/**
 * Where a node comes from, in the authored vocabulary and never in source coordinates.
 *
 * A synthetic node is one the compiler made for an authored position: `role` and `occurrence` tell
 * apart several nodes made for the same position.
 */
export type Origin =
  | { readonly _tag: 'Authored'; readonly anchor: AuthoredIdentity.Anchor }
  | {
      readonly _tag: 'Synthetic'
      readonly anchor: AuthoredIdentity.Anchor
      readonly role: string
      readonly occurrence: number
    }

/**
 * Which typed body this is. "Checking `f`" is not one thing: the generic body is one artifact and
 * each semantic application that must be specialized is another. Provenance never takes part, so
 * two applications with equal static values are the same artifact wherever they were written.
 */
export interface ArtifactId {
  /** The authored owner whose body this is; a compiler-made body is its own owner. */
  readonly owner: AuthoredIdentity.Identity
  readonly request:
    | { readonly _tag: 'Check' }
    /** The canonical key of the application: type and static arguments, evidence, contract row. */
    | { readonly _tag: 'Specialize'; readonly application: string }
  /** The artifact that produced a compiler-made body, which tells apart bodies made per parent. */
  readonly parent?: ArtifactId
}

/** A dense zero-based identity for one node inside a typed artifact. */
export interface NodeId {
  readonly _tag: 'TirNode'
  readonly ordinal: number
}

/** A dense zero-based identity for one parameter, binding, capture, or pattern local. */
export interface LocalId {
  readonly _tag: 'TirLocal'
  readonly ordinal: number
}

/** A node identity that remains unambiguous when it crosses an artifact boundary. */
export interface NodeRef {
  readonly artifact: ArtifactId
  readonly node: NodeId
}

/** A dense reference into a checked body's selected-evidence table. */
export interface EvidenceRef {
  readonly _tag: 'TirEvidence'
  readonly ordinal: number
}

/** The selected proofs one executable node retains outside its compact typed shape. */
export interface SelectedEvidence {
  readonly constraints: ReadonlyArray<Constraint.ConstraintEvidence>
  readonly conformances: ReadonlyArray<ConformanceGoal.Proof>
}

/** A dense reference into a checked body's unavailable-cause table. */
export interface CauseRef {
  readonly _tag: 'TirCause'
  readonly ordinal: number
}

/** Identity and revision-independent origin shared by executable TIR nodes. */
export interface Node {
  /** Present on every published body; omitted only while its private builder owns the node. */
  readonly id?: NodeId
  readonly origin: Origin
}

/** A node after its private builder has assigned its dense artifact-local identity. */
export interface PublishedNode extends Node {
  readonly id: NodeId
  readonly span: SourceSpan.SourceSpan
}

/** One parameter, binding, pattern value, or capture in the body's unified local namespace. */
export interface Local {
  readonly id: LocalId
  readonly kind: 'Parameter' | 'Binding' | 'Pattern' | 'Capture'
  readonly name?: string
  readonly type: Type.Type
  readonly mutability: 'Immutable' | 'Mutable'
  readonly capture?: LocalId
}

/** The canonical text of an artifact identity: the key a body is requested and stored under. */
// Artifact identities are immutable and keyed on every node, borrow, and site lookup.
const artifactKeys = new WeakMap<ArtifactId, string>()

export const artifactKey = (self: ArtifactId): string => {
  let key = artifactKeys.get(self)
  if (key === undefined) {
    key = JSON.stringify([
      AuthoredIdentity.key(self.owner),
      self.request._tag === 'Check' ? null : self.request.application,
      self.parent === undefined ? null : artifactKey(self.parent),
    ])
    artifactKeys.set(self, key)
  }
  return key
}

/** Canonical identity of one executable node across checked artifacts. */
export const nodeRefKey = (self: NodeRef): string =>
  `${artifactKey(self.artifact)}:n${self.node.ordinal}`

/** Tests node identity without consulting source presentation. */
export const nodeRefEquals = (left: NodeRef, right: NodeRef): boolean =>
  left.node.ordinal === right.node.ordinal &&
  artifactKey(left.artifact) === artifactKey(right.artifact)

/** Names a published node from the artifact that owns it. */
export const nodeReference = (artifact: ArtifactId, node: Node): NodeRef => {
  if (node.id === undefined) throw new RangeError('TIR node reference requires a published node')
  return { artifact, node: node.id }
}

export const authored = (anchor: AuthoredIdentity.Anchor): Origin => ({ _tag: 'Authored', anchor })

export const synthetic = (
  anchor: AuthoredIdentity.Anchor,
  role: string,
  occurrence = 0,
): Origin => ({ _tag: 'Synthetic', anchor, role, occurrence })

/** A canonical source-ordered region identity local to one function. */
export interface RegionId {
  readonly _tag: 'TirRegion'
  readonly function: DeclarationFacts.DeclarationId
  readonly ordinal: number
}

/** Compiler-only identity for one explicit call argument borrow. */
export interface BorrowId {
  readonly _tag: 'BorrowId'
  readonly call: NodeRef
  readonly ordinal: number
}

/** Stable compiler-owned identity for one materialized borrowable temporary. */
export interface TemporaryOwnerId {
  readonly _tag: 'TemporaryOwnerId'
  readonly node: NodeRef
}

export const borrowKey = (borrow: BorrowId): string =>
  `${nodeRefKey(borrow.call)}:${borrow.ordinal}`

interface ExecutableNodeSiteId {
  readonly node: NodeRef
  readonly owner?: DeclarationFacts.CanonicalId
  readonly functionOrdinal: number
}

/** Hidden nominal identity for one source Effect construction site. */
export type EffectSiteId =
  | (ExecutableNodeSiteId & {
      readonly _tag: 'EffectSiteId'
      /** Authored Effect-site ordinal, independent of TIR allocation order. */
      readonly ordinal: number
    })
  | {
      readonly _tag: 'EffectSiteId'
      readonly artifact: ArtifactId
      readonly owner?: DeclarationFacts.CanonicalId
      readonly functionOrdinal: number
      readonly root: true
    }

/** Hidden nominal identity for one automatic callable-section construction site. */
export interface CallableSiteId extends ExecutableNodeSiteId {
  readonly _tag: 'CallableSiteId'
  /** Authored anonymous-callable ordinal, independent of TIR allocation order. */
  readonly ordinal: number
}

/** Returns the path- and span-independent structural identity of one executable site. */
export const executableSiteKey = (self: EffectSiteId | CallableSiteId): string => {
  const kind = self._tag === 'EffectSiteId' ? 'effect' : 'callable'
  let identity: string
  if ('root' in self)
    identity =
      self.owner === undefined
        ? `root:${AuthoredIdentity.key(self.artifact.owner)}`
        : `root:declaration:${self.owner.module}:${self.owner.name}`
  else
    identity =
      self.owner === undefined
        ? `${artifactKey(self.node.artifact)}:${self.ordinal}`
        : `declaration:${self.owner.module}:${self.owner.name}:site:${self.ordinal}`
  return `${kind}\u0000${identity}`
}

/** The artifact-local ordinal used only to name compiler-generated declarations. */
export const executableSiteOrdinal = (self: EffectSiteId | CallableSiteId): number =>
  'root' in self ? -1 : self.ordinal

/** Tests structural executable-site identity without consulting diagnostic provenance. */
export const sameExecutableSite = (
  left: EffectSiteId | CallableSiteId,
  right: EffectSiteId | CallableSiteId,
): boolean => executableSiteKey(left) === executableSiteKey(right)

/** Names the implicit Effect environment of an Effect function artifact. */
export const effectRootSite = (
  artifact: ArtifactId,
  functionOrdinal: number,
  owner?: DeclarationFacts.CanonicalId,
): EffectSiteId => ({
  _tag: 'EffectSiteId',
  artifact,
  functionOrdinal,
  root: true,
  ...(owner === undefined ? {} : { owner }),
})

/** Stable hidden Effect site for a compiler-backed selective-catch expression. */
export const effectCatchSite = (
  node: NodeRef,
  owner: DeclarationFacts.CanonicalId,
  functionOrdinal: number,
): EffectSiteId => ({
  _tag: 'EffectSiteId',
  node,
  ordinal: node.node.ordinal,
  owner,
  functionOrdinal,
})

/** Stable hidden Effect site for one compiler-backed Effect-valued builtin call. */
export const builtinEffectSite = (
  node: NodeRef,
  owner: DeclarationFacts.CanonicalId,
  functionOrdinal: number,
): EffectSiteId => ({
  _tag: 'EffectSiteId',
  node,
  ordinal: node.node.ordinal,
  owner,
  functionOrdinal,
})

/** Orders executable sites by their stable structural identities. */
export const compareExecutableSites = (
  left: EffectSiteId | CallableSiteId,
  right: EffectSiteId | CallableSiteId,
): number => executableSiteKey(left).localeCompare(executableSiteKey(right))

/** Presents one structural executable-site identity without embedding control delimiters. */
export const executableSiteLabel = (self: EffectSiteId | CallableSiteId): string =>
  executableSiteKey(self).replaceAll('\u0000', ':')

/** Projects one Effect site into the semantic origin retained by exact representations. */
export const effectRepresentationIdentity = (self: EffectSiteId): string =>
  `effect:${executableSiteKey(self)}`

/** Projects a TIR callable site into the semantic identity retained across specialization. */
export const callableEnvironmentSite = (self: CallableSiteId): Type.CallableEnvironmentSite =>
  Type.callableEnvironmentSite(
    self.owner === undefined ? undefined : { module: self.owner.module, name: self.owner.name },
    self.functionOrdinal,
    self.ordinal,
  )

/** Retains one callable site's complete enclosing executable specialization. */
export const callableEnvironmentIdentity = (
  self: CallableSiteId,
  owner: Type.CallableEnvironmentIdentity['owner'],
): Type.CallableEnvironmentIdentity =>
  Type.callableEnvironmentIdentity(callableEnvironmentSite(self), owner)

/** Derives the canonical hidden runner declaration owned by one effect construction site. */
export const effectRunnerId = (
  owner: DeclarationFacts.CanonicalId,
  site: EffectSiteId,
): DeclarationFacts.CanonicalId => ({
  _tag: 'CanonicalDeclarationId',
  module: owner.module,
  name: `${owner.name}$effect$${executableSiteOrdinal(site)}`,
})

/** Derives the private executable declaration owned by one anonymous callable site. */
export const anonymousCallableId = (
  owner: DeclarationFacts.CanonicalId,
  authoredOrdinal: number,
): DeclarationFacts.CanonicalId => ({
  _tag: 'CanonicalDeclarationId',
  module: owner.module,
  name: `${owner.name}$callable$${authoredOrdinal}`,
})

/** Tests whether a canonical declaration is owned by an anonymous callable expression site. */
export const isAnonymousCallableId = (self: DeclarationFacts.CanonicalId): boolean =>
  /\$callable\$\d+$/.test(self.name)

/** The callable site ordinal recorded in an anonymous callable's canonical identity. */
export const anonymousCallableSite = (self: DeclarationFacts.CanonicalId): number | undefined => {
  const match = /\$callable\$(\d+)$/.exec(self.name)
  return match?.[1] === undefined ? undefined : Number(match[1])
}

/**
 * The snapshot-local declaration ordinal of one hidden anonymous body: derived from its enclosing
 * declaration and callable site, never from byte offsets, so trivia edits keep it stable.
 */
export const hiddenDeclarationOrdinal = (enclosing: number, site: number): number =>
  // ponytail: injective while site < 65536 and enclosing < 2^37; sites are per declaration and
  // enclosing ordinals are sequential per snapshot, so both bounds hold by construction.
  0x70000000 + enclosing * 65536 + site

export type CallableTarget =
  | {
      readonly _tag: 'DeclarationCallableTarget'
      readonly declaration: DeclarationFacts.CanonicalId
    }
  | {
      readonly _tag: 'BuiltinCallableTarget'
      readonly actor: string
      readonly operation: BuiltinOperation
      readonly intrinsic: Intrinsic.OperationId
    }

/** Converts the semantic callable identity retained by specialization into its TIR target. */
export const callableTargetFromIdentity = (
  target: Type.CallableIdentityArgument['target'],
): CallableTarget =>
  target._tag === 'Declaration'
    ? {
        _tag: 'DeclarationCallableTarget',
        declaration: {
          _tag: 'CanonicalDeclarationId',
          module: target.module,
          name: target.name,
        },
      }
    : {
        _tag: 'BuiltinCallableTarget',
        actor: target.actor,
        operation: target.operation,
        intrinsic: {
          _tag: 'IntrinsicOperationId',
          actor: target.intrinsic.actor,
          name: target.intrinsic.name,
        },
      }

/** Projects a TIR callable target into the semantic identity retained by specialization. */
export const callableTargetIdentity = (
  self: CallableTarget,
): Type.CallableIdentityArgument['target'] =>
  self._tag === 'DeclarationCallableTarget'
    ? {
        _tag: 'Declaration',
        module: self.declaration.module,
        name: self.declaration.name,
      }
    : {
        _tag: 'Builtin',
        actor: self.actor,
        operation: self.operation,
        intrinsic: {
          actor: self.intrinsic.actor,
          name: self.intrinsic.name,
        },
      }

/** Tests complete structural identity for two TIR callable targets. */
export const sameCallableTarget = (left: CallableTarget, right: CallableTarget): boolean => {
  if (left._tag !== right._tag) return false
  if (left._tag === 'DeclarationCallableTarget' && right._tag === 'DeclarationCallableTarget') {
    return (
      left.declaration.module === right.declaration.module &&
      left.declaration.name === right.declaration.name
    )
  }
  if (left._tag === 'BuiltinCallableTarget' && right._tag === 'BuiltinCallableTarget') {
    return (
      left.actor === right.actor &&
      left.operation === right.operation &&
      left.intrinsic.actor === right.intrinsic.actor &&
      left.intrinsic.name === right.intrinsic.name
    )
  }
  return false
}

/** Tests whether one TIR target is the target retained by a semantic callable identity. */
export const matchesCallableTargetIdentity = (
  self: CallableTarget,
  identity: Type.CallableIdentityArgument['target'],
): boolean => sameCallableTarget(self, callableTargetFromIdentity(identity))

/** A canonical lexical loop identity local to one function. */
export interface LoopId {
  readonly _tag: 'TirLoop'
  readonly function: DeclarationFacts.DeclarationId
  readonly ordinal: number
}

/** The closed built-in operation vocabulary of the compiler-known actors. */
export type BuiltinOperation = Type.BuiltinOperation

export type BoundsMode =
  | { readonly _tag: 'Proven'; readonly index: number; readonly length: number }
  | { readonly _tag: 'Runtime'; readonly length: number }

export type SliceRoot =
  | { readonly _tag: 'BindingSliceRoot'; readonly binding: LocalId }
  | { readonly _tag: 'ParameterSliceRoot'; readonly parameter: LocalId }
  | { readonly _tag: 'PatternSliceRoot'; readonly binding: LocalId }
  | {
      readonly _tag: 'TemporarySliceRoot'
      readonly owner: TemporaryOwnerId
      readonly value: Expression
    }

export type BorrowSelector =
  | {
      readonly _tag: 'Field'
      readonly field: DeclarationFacts.FieldId
      readonly span: SourceSpan.SourceSpan
      readonly at?: AuthoredIdentity.Anchor
    }
  | {
      readonly _tag: 'Index'
      readonly index: Expression
      readonly array: Type.FixedArray
      readonly bounds: BoundsMode
      readonly span: SourceSpan.SourceSpan
      readonly at?: AuthoredIdentity.Anchor
    }
  | {
      readonly _tag: 'SliceIndex'
      readonly index: Expression
      readonly slice: Type.Slice
      readonly span: SourceSpan.SourceSpan
      readonly at?: AuthoredIdentity.Anchor
    }

/** One selector in a writable place, retained in source evaluation order. */
export type WriteSelector =
  | {
      readonly _tag: 'Field'
      readonly field: DeclarationFacts.FieldId
      readonly type: DeclarationFacts.SemanticType
      readonly span: SourceSpan.SourceSpan
      readonly at?: AuthoredIdentity.Anchor
      readonly origin?: Origin
    }
  | {
      readonly _tag: 'Index'
      readonly index: Expression
      readonly array: Type.FixedArray
      readonly bounds: BoundsMode
      readonly type: DeclarationFacts.SemanticType
      readonly span: SourceSpan.SourceSpan
      readonly at?: AuthoredIdentity.Anchor
      readonly origin?: Origin
    }

export type OwnedWriteRoot =
  | { readonly _tag: 'BindingWriteRoot'; readonly binding: LocalId }
  | { readonly _tag: 'PatternWriteRoot'; readonly binding: LocalId }
  | { readonly _tag: 'ParameterWriteRoot'; readonly parameter: LocalId }

/** One complete typed replacement rooted in mutable owned storage. */
export interface OwnedWritePlace {
  readonly _tag: 'WritePlace'
  readonly root: OwnedWriteRoot
  readonly selectors: ReadonlyArray<WriteSelector>
  readonly type: DeclarationFacts.SemanticType
  readonly span: SourceSpan.SourceSpan
  readonly origin: Origin
}

export type BorrowedWriteSelector =
  | {
      readonly _tag: 'SliceIndex'
      readonly index: Expression
      readonly slice: Type.Slice
      readonly type: DeclarationFacts.SemanticType
      readonly span: SourceSpan.SourceSpan
      readonly at?: AuthoredIdentity.Anchor
      readonly origin: Origin
    }
  | Extract<WriteSelector, { readonly _tag: 'Field' | 'Index' }>

export interface BorrowedWritePlace {
  readonly _tag: 'BorrowedWritePlace'
  readonly root: Extract<SliceRoot, { readonly _tag: 'BindingSliceRoot' | 'ParameterSliceRoot' }>
  /** Semantic type of the storage root before the path enters borrowed storage. */
  readonly rootType: DeclarationFacts.SemanticType
  readonly selectors: ReadonlyArray<BorrowedWriteSelector>
  readonly type: DeclarationFacts.SemanticType
  readonly span: SourceSpan.SourceSpan
  readonly origin: Origin
}

export type WritePlace = OwnedWritePlace | BorrowedWritePlace

export interface PatternBinding {
  readonly id: LocalId
  readonly name?: string
  /** Absent for a whole-member binding, which observes or owns the entire selected payload. */
  readonly field?: DeclarationFacts.FieldId
  readonly path: ReadonlyArray<DeclarationFacts.FieldId>
  readonly type: DeclarationFacts.SemanticType
  readonly access: Match.Access
  readonly span: SourceSpan.SourceSpan
  readonly origin: Origin
}

export interface PatternSelection {
  readonly tests?: ReadonlyArray<Match.PatternTest>
  readonly id: Match.MatchId
  readonly arm: Match.ArmId
  readonly access: Match.Access
  readonly subject: Expression
  /**
   * The authored expression matched, borrow included, kept as evidence for loan analysis. `subject`
   * and `access` are what executes.
   */
  readonly source?: Expression
  readonly members: ReadonlyArray<Match.CoverageIdentity>
  readonly member?: Match.CoverageIdentity
  readonly universal: boolean
  readonly bindings: ReadonlyArray<PatternBinding>
  readonly cleanup: ReadonlyArray<ReadonlyArray<DeclarationFacts.FieldId>>
  readonly irrefutable: boolean
  /** Where a loan taken by matching the subject ends. */
  readonly loanEnd: SourceSpan.SourceSpan
  readonly loanEndAt?: AuthoredIdentity.Anchor
  readonly span: SourceSpan.SourceSpan
  readonly origin: Origin
}

/** One typed core semantic operation with exact source provenance. */
/** Expression values and ordinary statement regions stay distinct at match arms. */
export type MatchArmBody =
  | {
      readonly _tag: 'Expression'
      readonly expression: Expression
      readonly type: Type.Type
      readonly span: SourceSpan.SourceSpan
      readonly origin: Origin
    }
  | {
      readonly _tag: 'Block'
      readonly statements: ReadonlyArray<Statement>
      readonly completion: { readonly fallsThrough: boolean }
      readonly type: Type.Type
      readonly span: SourceSpan.SourceSpan
      readonly origin: Origin
    }

/** Frontend-owned representation evidence retained directly on executable TIR. */
export interface ExpressionMetadata {
  readonly representation?: Type.RepresentationArgument
  /** The resolved static declaration whose selected value produced this executable node. */
  readonly constant?: DeclarationFacts.CanonicalId
}

export type Expression = ExpressionNode & Node & ExpressionMetadata

type ExpressionNode =
  | {
      readonly _tag: 'IntegerLiteral'
      readonly value: bigint
      readonly type: DeclarationFacts.SemanticType
      readonly span: SourceSpan.SourceSpan
      readonly origin: Origin
    }
  | {
      readonly _tag: 'FloatingLiteral'
      readonly bits: bigint
      readonly spelling: string
      readonly type: Scalar.FloatSpelling
      readonly span: SourceSpan.SourceSpan
      readonly origin: Origin
    }
  | {
      readonly _tag: 'StaticStringLiteral'
      readonly data: StaticText.Data
      /** Static-text provenance retained when a residual value is materialized as a literal. */
      readonly textOrigin?: Evaluation.TextOrigin
      readonly type: Type.String
      readonly span: SourceSpan.SourceSpan
      readonly origin: Origin
    }
  | {
      readonly _tag: 'StaticByteViewLiteral'
      readonly data: StaticText.Data
      readonly type: Type.Slice
      readonly span: SourceSpan.SourceSpan
      readonly origin: Origin
    }
  | {
      readonly _tag: 'UnitLiteral'
      readonly type: typeof Type.unit
      readonly span: SourceSpan.SourceSpan
      readonly origin: Origin
    }
  | {
      readonly _tag: 'BooleanLiteral'
      readonly value: boolean
      readonly type: DeclarationFacts.SemanticType
      readonly span: SourceSpan.SourceSpan
      readonly origin: Origin
    }
  | {
      readonly _tag: 'CharacterLiteral'
      readonly value: number
      readonly type: DeclarationFacts.SemanticType
      readonly span: SourceSpan.SourceSpan
      readonly origin: Origin
    }
  | {
      readonly _tag: 'EnumMember'
      readonly enum: DeclarationFacts.CanonicalId
      readonly member: DeclarationFacts.CanonicalEnumMemberId
      readonly discriminant: bigint
      readonly type: Type.Nominal
      readonly span: SourceSpan.SourceSpan
      readonly origin: Origin
    }
  | {
      readonly _tag: 'EnumValue'
      readonly enum: DeclarationFacts.CanonicalId
      readonly value: Expression
      readonly intrinsic: Intrinsic.OperationId
      readonly type: Scalar.EnumRepresentationSpelling
      readonly span: SourceSpan.SourceSpan
      readonly origin: Origin
    }
  | {
      readonly _tag: 'EnumEquality'
      readonly enum: DeclarationFacts.CanonicalId
      readonly left: Expression
      readonly right: Expression
      readonly negated: boolean
      readonly type: 'bool'
      readonly span: SourceSpan.SourceSpan
      readonly origin: Origin
    }
  | {
      /**
       * `compileError(message)`: static structure. It is reached only while a body is evaluated at
       * compile time, so no residual body holds one.
       */
      readonly _tag: 'CompileError'
      readonly message: Expression
      readonly type: DeclarationFacts.SemanticType
      readonly span: SourceSpan.SourceSpan
      readonly origin: Origin
    }
  | {
      /** A call of a `static fn`, with every argument kept: static structure. */
      readonly _tag: 'StaticCall'
      readonly target: DeclarationFacts.CanonicalId
      readonly typeArguments: ReadonlyArray<Type.GenericArgument>
      /** Canonical keys of the evidence the call selected, which are part of its application. */
      readonly evidence: ReadonlyArray<string>
      readonly arguments: ReadonlyArray<Expression>
      /** A rejection already reached while construction selected this call's application. */
      readonly failure?: Evaluation.StaticFailure
      /** Where the text this call returns was written, when construction already knows. */
      readonly text?: Location.Location
      readonly textOrigin?: Evaluation.TextOrigin
      readonly type: DeclarationFacts.SemanticType
      readonly span: SourceSpan.SourceSpan
      readonly origin: Origin
    }
  | {
      /** A compile-time intrinsic (profile facts, reflection, static text and sequences). */
      readonly _tag: 'StaticIntrinsic'
      readonly operation: string
      readonly typeArguments: ReadonlyArray<Type.GenericArgument>
      readonly arguments: ReadonlyArray<Expression>
      readonly type: DeclarationFacts.SemanticType
      readonly span: SourceSpan.SourceSpan
      readonly origin: Origin
    }
  | {
      /** A constant whose value is selected by evaluating its initializer: static structure. */
      readonly _tag: 'ConstantReference'
      readonly declaration: DeclarationFacts.CanonicalId
      readonly type: DeclarationFacts.SemanticType
      readonly span: SourceSpan.SourceSpan
      readonly origin: Origin
    }
  | {
      readonly _tag: 'ParameterReference'
      readonly parameter: LocalId
      readonly type: DeclarationFacts.SemanticType
      readonly span: SourceSpan.SourceSpan
      readonly origin: Origin
    }
  | {
      readonly _tag: 'ForeignStaticLoad'
      readonly declaration: DeclarationFacts.CanonicalId
      readonly direction: 'Import' | 'Export'
      readonly symbol: string
      readonly type: DeclarationFacts.SemanticType
      readonly span: SourceSpan.SourceSpan
      readonly origin: Origin
    }
  | {
      readonly _tag: 'BindingReference'
      readonly binding: LocalId
      readonly type: DeclarationFacts.SemanticType
      readonly span: SourceSpan.SourceSpan
      readonly origin: Origin
    }
  | {
      readonly _tag: 'PatternBindingReference'
      readonly binding: LocalId
      readonly type: DeclarationFacts.SemanticType
      readonly span: SourceSpan.SourceSpan
      readonly origin: Origin
    }
  | {
      readonly _tag: 'Move'
      readonly subject: Expression
      readonly type: DeclarationFacts.SemanticType
      readonly span: SourceSpan.SourceSpan
      readonly origin: Origin
    }
  | {
      /** Atomically reads one writable place and stores a replacement, yielding the old value. */
      readonly _tag: 'Replace'
      readonly place: WritePlace
      readonly value: Expression
      readonly type: DeclarationFacts.SemanticType
      readonly span: SourceSpan.SourceSpan
      readonly origin: Origin
    }
  | {
      readonly _tag: 'UnionConvert'
      readonly source: Expression
      readonly sourceType: Type.Type
      readonly target: Type.StructuralUnion | Type.Effect | Type.Represented
      readonly conversion: 'Inject' | 'Widen' | 'EffectAccess' | 'EffectJoin'
      readonly mappings: ReadonlyArray<TypeCompatibility.MemberMapping>
      readonly access: 'Copy' | 'Owned'
      readonly context:
        | 'Return'
        | 'Argument'
        | 'StructField'
        | 'ArrayElement'
        | 'Assignment'
        | 'Binding'
        | 'MatchArm'
      readonly expectedAt: SourceSpan.SourceSpan
      /** The authored node `expectedAt` presents. */
      readonly expected?: AuthoredIdentity.Anchor
      readonly type: Type.StructuralUnion | Type.Effect | Type.Represented
      readonly span: SourceSpan.SourceSpan
      readonly origin: Origin
    }
  | {
      readonly _tag: 'Match'
      readonly match: Match.MatchId
      readonly access: Match.Access
      readonly scrutinee: Expression
      readonly members: ReadonlyArray<Match.CoverageIdentity>
      readonly arms: ReadonlyArray<{
        readonly tests?: ReadonlyArray<Match.PatternTest>
        readonly id: Match.ArmId
        readonly member?: Match.CoverageIdentity
        /** An integer pattern selects one value; it is static structure with no coverage member. */
        readonly integer?: bigint
        readonly universal: boolean
        readonly bindings: ReadonlyArray<PatternBinding>
        readonly cleanup: ReadonlyArray<ReadonlyArray<DeclarationFacts.FieldId>>
        readonly guard?: Expression
        readonly body: MatchArmBody
        readonly before: ReadonlyArray<Match.CoverageIdentity>
        readonly after: ReadonlyArray<Match.CoverageIdentity>
        readonly reachable: boolean
        readonly span: SourceSpan.SourceSpan
        readonly at?: AuthoredIdentity.Anchor
      }>
      readonly type: DeclarationFacts.SemanticType
      readonly span: SourceSpan.SourceSpan
      readonly origin: Origin
    }
  | {
      /**
       * `&&` and `||`. The left operand always evaluates; the right operand evaluates only when
       * the left one does not already decide the result. The right operand is a pure expression
       * — elaboration rejects an effect site or a move inside it — so skipping it releases
       * nothing and performs nothing.
       */
      readonly _tag: 'ShortCircuit'
      readonly operator: Operator.ShortCircuit
      readonly left: Expression
      readonly right: Expression
      readonly type: DeclarationFacts.SemanticType
      readonly span: SourceSpan.SourceSpan
      readonly origin: Origin
    }
  | {
      readonly _tag: 'Construct'
      readonly nominal: Type.Nominal
      /** Field identities in language evaluation order; `fields` remains canonical storage order. */
      readonly evaluationOrder: ReadonlyArray<DeclarationFacts.FieldId>
      readonly fields: ReadonlyArray<{
        readonly field: DeclarationFacts.FieldId
        readonly value: Expression
      }>
      readonly type: DeclarationFacts.SemanticType
      readonly span: SourceSpan.SourceSpan
      readonly origin: Origin
    }
  | {
      readonly _tag: 'ConstructUnionVariant'
      readonly nominal: Type.Nominal
      readonly variant: DeclarationFacts.CanonicalUnionVariantId
      readonly variantOrdinal: number
      /** Field identities in language evaluation order; `fields` remains variant storage order. */
      readonly evaluationOrder: ReadonlyArray<DeclarationFacts.FieldId>
      readonly fields: ReadonlyArray<{
        readonly field: DeclarationFacts.FieldId
        readonly value: Expression
      }>
      readonly type: DeclarationFacts.SemanticType
      readonly span: SourceSpan.SourceSpan
      readonly origin: Origin
    }
  | {
      readonly _tag: 'ArrayConstruct'
      readonly elements: ReadonlyArray<Expression>
      readonly type: Type.FixedArray
      readonly span: SourceSpan.SourceSpan
      readonly origin: Origin
    }
  | {
      readonly _tag: 'Project'
      readonly subject: Expression
      readonly nominal: Type.Nominal
      readonly field: DeclarationFacts.FieldId
      readonly access: 'CopyRead' | 'ConsumeRequested'
      readonly borrowAccess?: Type.BorrowAccess
      readonly type: DeclarationFacts.SemanticType
      readonly span: SourceSpan.SourceSpan
      readonly origin: Origin
    }
  | {
      /** One explicit place rooted at the target of a reference value. */
      readonly _tag: 'ReferentPlace'
      readonly subject: Expression
      readonly reference: Type.Reference
      readonly access: 'CopyRead'
      readonly borrowAccess: Type.BorrowAccess
      readonly type: DeclarationFacts.SemanticType
      readonly span: SourceSpan.SourceSpan
      readonly origin: Origin
    }
  | {
      readonly _tag: 'IndexPlace'
      readonly subject: Expression
      readonly index: Expression
      readonly array: Type.FixedArray
      readonly access: 'CopyRead' | 'ConsumeRequested'
      readonly bounds: BoundsMode
      readonly type: DeclarationFacts.SemanticType
      readonly span: SourceSpan.SourceSpan
      readonly origin: Origin
    }
  | {
      readonly _tag: 'SliceBorrow'
      /**
       * The authored place this borrows, kept as evidence for loan analysis. It is never
       * evaluated: `root` and `selectors` are what executes.
       */
      readonly place?: Expression
      readonly borrow: BorrowId
      readonly root: SliceRoot
      readonly selectors: ReadonlyArray<BorrowSelector>
      readonly source: Type.FixedArray | Type.Slice
      readonly access: Type.BorrowAccess
      readonly reborrow: boolean
      readonly suspendsParent: boolean
      readonly type: Type.Slice
      readonly span: SourceSpan.SourceSpan
      readonly origin: Origin
    }
  | {
      readonly _tag: 'ValueBorrow'
      /**
       * The authored place this borrows, kept as evidence for loan analysis. It is never
       * evaluated: `root` and `selectors` are what executes.
       */
      readonly place?: Expression
      readonly borrow: BorrowId
      readonly root: SliceRoot
      readonly selectors: ReadonlyArray<BorrowSelector>
      readonly source: Type.Type
      readonly access: Type.BorrowAccess
      readonly reborrow: boolean
      readonly suspendsParent: boolean
      readonly type: Type.Reference
      readonly span: SourceSpan.SourceSpan
      readonly origin: Origin
    }
  | {
      readonly _tag: 'RuntimeStringView'
      readonly source: Expression
      readonly heldLoans: ReadonlyArray<BorrowId>
      readonly type: Type.String
      readonly span: SourceSpan.SourceSpan
      readonly origin: Origin
    }
  | {
      readonly _tag: 'StringEquality'
      readonly left: Expression
      readonly right: Expression
      readonly negated: boolean
      readonly intrinsic: Intrinsic.OperationId
      readonly type: 'bool'
      readonly span: SourceSpan.SourceSpan
      readonly origin: Origin
    }
  | {
      readonly _tag: 'SliceLength'
      readonly slice: Expression
      readonly type: 'usize'
      readonly span: SourceSpan.SourceSpan
      readonly origin: Origin
    }
  | {
      readonly _tag: 'SliceIndexPlace'
      readonly slice: Expression
      readonly index: Expression
      readonly access: Type.Slice['access']
      readonly sourceType: Type.Slice
      readonly type: DeclarationFacts.SemanticType
      readonly span: SourceSpan.SourceSpan
      readonly origin: Origin
    }
  | {
      readonly _tag: 'Call'
      readonly target: DeclarationFacts.CanonicalId
      readonly typeArguments: ReadonlyArray<Type.GenericArgument>
      readonly evidence: EvidenceRef
      /** Symbolic source identities to be checked against the later concrete proof selection. */
      readonly symbolicConformances: ReadonlyArray<ConformanceProof.SymbolicConformanceSelection>
      readonly staticArguments: ReadonlyArray<StaticValue.Value>
      /** Caller-authored origins aligned with static arguments, excluded from instance identity. */
      readonly staticArgumentOrigins?: ReadonlyArray<Evaluation.TextOrigin | undefined>
      readonly arguments: ReadonlyArray<Expression>
      readonly loanEnds: ReadonlyArray<BorrowId>
      /** Direct argument loans deliberately retained by a returned lexical view. */
      readonly heldLoans: ReadonlyArray<BorrowId>
      readonly type: DeclarationFacts.SemanticType
      readonly span: SourceSpan.SourceSpan
      readonly origin: Origin
    }
  | {
      readonly _tag: 'FunctionItem'
      readonly target: CallableTarget
      readonly typeArguments: ReadonlyArray<Type.GenericArgument>
      readonly type: Type.Callable
      readonly span: SourceSpan.SourceSpan
      readonly origin: Origin
    }
  | {
      /** Address of an exact, synchronous, noncapturing `export "C"` function. */
      readonly _tag: 'ForeignFunctionAddress'
      readonly target: CallableTarget
      readonly symbol: string
      readonly type: Type.ForeignFunction
      readonly span: SourceSpan.SourceSpan
      readonly origin: Origin
    }
  | {
      readonly _tag: 'CallableSection'
      readonly site: CallableSiteId
      readonly target: CallableTarget
      readonly remainingParameters: ReadonlyArray<number>
      readonly captures: ReadonlyArray<{
        readonly ordinal: number
        readonly parameterOrdinal: number
        readonly value: Expression
        readonly access: 'Copy' | 'Shared' | 'Exclusive' | 'Take'
      }>
      readonly typeArguments: ReadonlyArray<Type.GenericArgument>
      readonly substitution: Type.Substitution
      readonly retainedDependencies: ReadonlyArray<number>
      readonly mode: Type.CallableMode
      readonly type: Type.Callable
      readonly span: SourceSpan.SourceSpan
      readonly origin: Origin
    }
  | {
      readonly _tag: 'ForeignApply'
      readonly evaluation: 'CalleeThenArguments' | 'LeftThenCallable'
      readonly callee: Expression
      readonly arguments: ReadonlyArray<Expression>
      readonly contract: Type.ForeignFunction
      readonly loanEnds: ReadonlyArray<BorrowId>
      readonly type: DeclarationFacts.SemanticType
      readonly span: SourceSpan.SourceSpan
      readonly origin: Origin
    }
  | {
      readonly _tag: 'CallableApply'
      readonly callee: Expression
      readonly arguments: ReadonlyArray<Expression>
      readonly loanEnds: ReadonlyArray<BorrowId>
      readonly heldLoans: ReadonlyArray<BorrowId>
      readonly access: Type.CallableMode
      readonly substitution: Type.Substitution
      readonly evaluation: 'CalleeThenArguments' | 'LeftThenCallable'
      readonly realization: 'Environment' | 'DirectErasedSection'
      /**
       * Present when the arguments are a proper trailing suffix of the callee's parameters: the
       * application stages a section over the callee value, splicing the callee's environment
       * ahead of the argument captures instead of invoking it. Captures align with `arguments`.
       */
      readonly staged?: {
        readonly site: CallableSiteId
        readonly captures: ReadonlyArray<{
          readonly ordinal: number
          readonly access: 'Copy' | 'Shared' | 'Exclusive' | 'Take'
        }>
      }
      readonly type: DeclarationFacts.SemanticType
      readonly span: SourceSpan.SourceSpan
      readonly origin: Origin
    }
  | {
      readonly _tag: 'EffectConstruct'
      readonly target: DeclarationFacts.CanonicalId
      readonly typeArguments: ReadonlyArray<Type.GenericArgument>
      readonly evidence: EvidenceRef
      readonly symbolicConformances: ReadonlyArray<ConformanceProof.SymbolicConformanceSelection>
      readonly staticArguments: ReadonlyArray<StaticValue.Value>
      /** Caller-authored origins aligned with static arguments, excluded from instance identity. */
      readonly staticArgumentOrigins?: ReadonlyArray<Evaluation.TextOrigin | undefined>
      readonly arguments: ReadonlyArray<Expression>
      readonly loanEnds: ReadonlyArray<BorrowId>
      readonly type: Type.Effect
      readonly span: SourceSpan.SourceSpan
      readonly origin: Origin
    }
  | {
      readonly _tag: 'ServiceEffectConstruct'
      readonly service: Type.Nominal
      readonly operation: string
      readonly role: string
      readonly access: 'Shared' | 'Exclusive'
      readonly typeArguments: ReadonlyArray<Type.GenericArgument>
      readonly staticArguments: ReadonlyArray<StaticValue.Value>
      /** Caller-authored origins aligned with static arguments, excluded from instance identity. */
      readonly staticArgumentOrigins?: ReadonlyArray<Evaluation.TextOrigin | undefined>
      readonly arguments: ReadonlyArray<Expression>
      readonly loanEnds: ReadonlyArray<BorrowId>
      readonly type: Type.Effect
      readonly span: SourceSpan.SourceSpan
      readonly origin: Origin
    }
  | {
      readonly _tag: 'EffectBlock'
      readonly site: EffectSiteId
      readonly statements: ReadonlyArray<Statement>
      readonly captures: ReadonlyArray<{
        readonly pattern?: LocalId
        readonly binding?: LocalId
        readonly parameter?: LocalId
        readonly access: 'Copy' | 'Shared' | 'Exclusive' | 'Take'
        readonly span: SourceSpan.SourceSpan
        readonly at?: AuthoredIdentity.Anchor
        /** The first authored use that captured the local, when one names it. */
        readonly use?: AuthoredIdentity.Anchor
      }>
      readonly type: Type.Effect
      readonly span: SourceSpan.SourceSpan
      readonly origin: Origin
    }
  | {
      readonly _tag: 'Run'
      readonly subject: Expression
      readonly type: DeclarationFacts.SemanticType
      readonly span: SourceSpan.SourceSpan
      readonly origin: Origin
    }
  | {
      /**
       * Member-selective recovery, carrying the four rows the semantic-fact surface records.
       * `residualRow` is the protected row minus `selected`; it is stored rather than derived
       * because no source-level type can spell it.
       */
      readonly _tag: 'EffectCatch'
      readonly intrinsic: Intrinsic.OperationId
      readonly protected: Expression
      readonly handler: Expression
      readonly selected: Type.Type
      readonly protectedRow: Type.FailureRow
      readonly handlerRow: Type.FailureRow
      readonly residualRow: Type.FailureRow
      readonly evidence: EvidenceRef
      readonly type: Type.Effect
      readonly span: SourceSpan.SourceSpan
      readonly origin: Origin
    }
  | {
      readonly _tag: 'EffectBindRequirement'
      readonly protected: Expression
      readonly provider: {
        readonly binding?: LocalId
        readonly parameter?: LocalId
        readonly selected: Type.RequirementsRow
        readonly evidence: EvidenceRef
        readonly capability?: Type.Nominal | Type.Parameter
        readonly providerType: Type.Nominal | Type.Parameter
        readonly witness?: DeclarationFacts.ConformanceWitness
        readonly role?: string
        readonly selectionAccess: 'Shared' | 'Exclusive' | 'Take'
        readonly captureAccess: 'Copy' | 'Shared' | 'Exclusive' | 'Take'
        readonly span: SourceSpan.SourceSpan
        readonly at?: AuthoredIdentity.Anchor
      }
      readonly type: Type.Effect
      readonly span: SourceSpan.SourceSpan
      readonly origin: Origin
    }
  | {
      readonly _tag: 'BuiltinCall'
      readonly assembly?: NativeAssembly.NativeAssembly
      readonly operation: BuiltinOperation
      readonly intrinsic: Intrinsic.OperationId
      /**
       * The bound interface operation an operator inside a generic body spells. Specialization
       * redirects the call to the provider's own function when the conformance maps one, and
       * otherwise keeps the compiler-known operation this node already names.
       */
      readonly interfaceOperation?: {
        readonly capability: Type.Nominal
        readonly provider: Type.Type
        readonly operation: string
        readonly contract: DeclarationFacts.InterfaceOperationApplicationFact
      }
      readonly witnessEffectSite?: EffectSiteId
      readonly typeArguments: ReadonlyArray<Type.GenericArgument>
      readonly arguments: ReadonlyArray<Expression>
      readonly loanEnds: ReadonlyArray<BorrowId>
      readonly heldLoans: ReadonlyArray<BorrowId>
      readonly type: DeclarationFacts.SemanticType
      readonly span: SourceSpan.SourceSpan
      readonly origin: Origin
    }
  /**
   * One statically selected interface-operation call. It records the conformance question rather
   * than an answer: which operation of which normalized interface application, over which provider.
   * The concrete instruction is the one the witness selected for the specialized provider, and only
   * lowering — where the substitution exists — knows it.
   */
  | {
      readonly _tag: 'InterfaceOperationCall'
      /** Written as an operator, whose reference operands are borrowed implicitly. */
      readonly operator?: true
      readonly capability: Type.Nominal
      readonly provider: Type.Type
      readonly operation: string
      readonly contract: DeclarationFacts.InterfaceOperationApplicationFact
      readonly witnessEffectSite?: EffectSiteId
      readonly arguments: ReadonlyArray<Expression>
      readonly loanEnds: ReadonlyArray<BorrowId>
      readonly type: DeclarationFacts.SemanticType
      readonly span: SourceSpan.SourceSpan
      readonly origin: Origin
    }
  | {
      readonly _tag: 'Unavailable'
      /** A checked call whose result contract is unavailable still retains its semantic inputs. */
      readonly call?: {
        readonly target?: DeclarationFacts.CanonicalId
        /** Present for an indirect callable application. */
        readonly callee?: Expression
        readonly arguments: ReadonlyArray<Expression>
        readonly expectedCount?: number
        readonly access?: Type.CallableMode
        readonly evaluation?: 'CalleeThenArguments' | 'LeftThenCallable'
      }
      readonly span: SourceSpan.SourceSpan
      readonly origin: Origin
      readonly cause?: CauseRef
    }

/** One elaborated body statement in source order. */
export type Statement = StatementNode & Node

type StatementNode =
  | {
      readonly _tag: 'UnavailableStatement'
      /** Operands of a write whose place has no lowered form; they still evaluate and hold loans. */
      readonly write?: { readonly destination: Expression; readonly value: Expression }
      readonly region: RegionId
      readonly span: SourceSpan.SourceSpan
      readonly origin: Origin
    }
  | {
      readonly _tag: 'Unsafe'
      readonly statements: ReadonlyArray<Statement>
      readonly region: RegionId
      readonly span: SourceSpan.SourceSpan
      readonly origin: Origin
    }
  | {
      readonly _tag: 'Bind'
      readonly binding: LocalId
      readonly name: string | undefined
      readonly mutability: 'Immutable' | 'Mutable'
      readonly initializer: Expression
      readonly region: RegionId
      readonly span: SourceSpan.SourceSpan
      readonly origin: Origin
    }
  | {
      readonly _tag: 'PatternBind'
      readonly selection: PatternSelection
      readonly region: RegionId
      readonly span: SourceSpan.SourceSpan
      readonly origin: Origin
    }
  | {
      readonly _tag: 'Evaluate'
      readonly expression: Expression
      readonly region: RegionId
      readonly span: SourceSpan.SourceSpan
      readonly origin: Origin
    }
  | {
      readonly _tag: 'If'
      readonly condition: Expression
      readonly taken: ReadonlyArray<Statement>
      readonly otherwise: ReadonlyArray<Statement>
      readonly region: RegionId
      readonly span: SourceSpan.SourceSpan
      readonly origin: Origin
    }
  | {
      readonly _tag: 'IfLet'
      readonly selection: PatternSelection
      readonly taken: ReadonlyArray<Statement>
      readonly otherwise: ReadonlyArray<Statement>
      readonly region: RegionId
      readonly span: SourceSpan.SourceSpan
      readonly origin: Origin
    }
  | {
      readonly _tag: 'Write'
      /** The authored destination, kept as evidence for loan analysis and never evaluated. */
      readonly destination?: Expression
      readonly place: WritePlace
      readonly value: Expression
      readonly region: RegionId
      readonly span: SourceSpan.SourceSpan
      readonly origin: Origin
    }
  | {
      readonly _tag: 'While'
      readonly loop: LoopId
      readonly parent?: LoopId
      readonly condition: Expression
      readonly body: ReadonlyArray<Statement>
      readonly region: RegionId
      readonly span: SourceSpan.SourceSpan
      readonly origin: Origin
    }
  | {
      readonly _tag: 'Break'
      readonly target: LoopId
      readonly region: RegionId
      readonly span: SourceSpan.SourceSpan
      readonly origin: Origin
    }
  | {
      readonly _tag: 'Continue'
      readonly target: LoopId
      readonly region: RegionId
      readonly span: SourceSpan.SourceSpan
      readonly origin: Origin
    }
  | {
      readonly _tag: 'Return'
      readonly expression: Expression
      /** True only for the synthetic completion of a body that falls through. */
      readonly implicit?: true
      readonly region: RegionId
      readonly span: SourceSpan.SourceSpan
      readonly origin: Origin
    }
  | {
      readonly _tag: 'Fail'
      readonly expression: Expression
      readonly failure: Type.Type
      readonly transfer: 'Copy' | 'Move'
      readonly region: RegionId
      readonly span: SourceSpan.SourceSpan
      readonly origin: Origin
    }
  | {
      readonly _tag: 'Drop'
      readonly expression: Expression
      readonly region: RegionId
      readonly span: SourceSpan.SourceSpan
      readonly origin: Origin
    }

/** One elaborated function: its header, normalized contract, and desugared body statements. */
export interface TirFunction {
  readonly _tag: 'TirFunction'
  /** Present on every published body; private construction fills it before publication. */
  readonly artifact?: ArtifactId
  readonly declaration: DeclarationFacts.DeclarationFact
  readonly contract: ContractFact
  readonly entryRegion: RegionId
  readonly regionOrder: ReadonlyArray<RegionId>
  /** Present on every published body; private construction fills it before publication. */
  readonly locals?: ReadonlyArray<Local>
  /** Every executable node in dense artifact-local identity order. */
  readonly nodes?: ReadonlyArray<PublishedNode>
  readonly statements: ReadonlyArray<Statement>
}

/** Reads the identity attached when a private function construction is published. */
export const functionArtifact = (self: TirFunction): ArtifactId => {
  if (self.artifact === undefined) throw new RangeError('TIR function has not been published')
  return self.artifact
}

/** Every numbered semantic node in dense identity order. */
export const nodesOf = (self: TirFunction): ReadonlyArray<PublishedNode> => {
  if (self.nodes !== undefined) return self.nodes
  const nodes: Array<PublishedNode> = []
  const seen = new WeakSet<object>()
  const visit = (input: unknown): void => {
    if (typeof input !== 'object' || input === null || seen.has(input)) return
    if (input instanceof Map || input instanceof Set || SourceSpanModule.isSourceSpan(input)) return
    seen.add(input)
    if (Array.isArray(input)) {
      for (const item of input) visit(item)
      return
    }
    const value = input as Readonly<Record<string, unknown>>
    const id = value['id'] as NodeId | undefined
    if (id?._tag === 'TirNode') nodes[id.ordinal] = value as unknown as PublishedNode
    for (const child of Object.values(value)) visit(child)
  }
  visit(self.statements)
  return nodes
}

/** Resolves an artifact-local node identity without consulting source presentation. */
export const nodeOf = (self: TirFunction, id: NodeId): PublishedNode | undefined =>
  nodesOf(self).at(id.ordinal)

/** Resolves one unified local definition by its dense identity. */
export const localOf = (self: TirFunction, id: LocalId): Local | undefined =>
  self.locals?.at(id.ordinal)

/** The terminal return expression; throws when the body ends in another control-flow shape. */
export const returned = (self: TirFunction): Expression => {
  let statements = self.statements
  let last = statements.at(-1)
  while (last?._tag === 'Unsafe') {
    statements = last.statements
    last = statements.at(-1)
  }
  if (last === undefined || last._tag !== 'Return') {
    throw new RangeError('TIR body must end in a return statement')
  }
  return last.expression
}

/** Every expression directly carried by one statement, nesting through conditionals. */
export const statementExpressions = (statement: Statement): ReadonlyArray<Expression> => {
  switch (statement._tag) {
    case 'UnavailableStatement':
      return statement.write === undefined
        ? []
        : [statement.write.destination, statement.write.value]
    case 'Unsafe':
      return statement.statements.flatMap(statementExpressions)
    case 'Bind':
      return [statement.initializer]
    case 'PatternBind':
      return [statement.selection.subject]
    case 'Evaluate':
      return [statement.expression]
    case 'Write':
      return [
        ...statement.place.selectors.flatMap((selector) =>
          selector._tag === 'Index' || selector._tag === 'SliceIndex' ? [selector.index] : [],
        ),
        statement.value,
      ]
    case 'Return':
      return [statement.expression]
    case 'Fail':
    case 'Drop':
      return [statement.expression]
    case 'Break':
    case 'Continue':
      return []
    case 'While':
      return [statement.condition, ...statement.body.flatMap(statementExpressions)]
    case 'If':
      return [
        statement.condition,
        ...statement.taken.flatMap(statementExpressions),
        ...statement.otherwise.flatMap(statementExpressions),
      ]
    case 'IfLet':
      return [
        statement.selection.subject,
        ...statement.taken.flatMap(statementExpressions),
        ...statement.otherwise.flatMap(statementExpressions),
      ]
  }
}

/** The semantic children of one expression, including a lazy block's statement expressions. */
export const expressionChildren = (expression: Expression): ReadonlyArray<Expression> =>
  (() => {
    switch (expression._tag) {
      case 'Move':
      case 'Project':
      case 'ReferentPlace':
      case 'UnionConvert':
        return [expression._tag === 'UnionConvert' ? expression.source : expression.subject]
      case 'RuntimeStringView':
        return [expression.source]
      case 'StringEquality':
      case 'EnumEquality':
      case 'ShortCircuit':
        return [expression.left, expression.right]
      case 'EnumValue':
        return [expression.value]
      case 'Replace':
        return [
          ...expression.place.selectors.flatMap((selector) =>
            selector._tag === 'Index' || selector._tag === 'SliceIndex' ? [selector.index] : [],
          ),
          expression.value,
        ]
      case 'IndexPlace':
        return [expression.subject, expression.index]
      case 'SliceLength':
        return [expression.slice]
      case 'SliceIndexPlace':
        return [expression.slice, expression.index]
      case 'SliceBorrow':
      case 'ValueBorrow':
        return [
          ...(expression.root._tag === 'TemporarySliceRoot' ? [expression.root.value] : []),
          ...expression.selectors.flatMap((selector) =>
            selector._tag === 'Index' || selector._tag === 'SliceIndex' ? [selector.index] : [],
          ),
        ]
      case 'Construct':
      case 'ConstructUnionVariant':
        return expression.fields.map((field) => field.value)
      case 'ArrayConstruct':
        return expression.elements
      case 'Call':
      case 'StaticCall':
      case 'StaticIntrinsic':
      case 'EffectConstruct':
      case 'ServiceEffectConstruct':
      case 'BuiltinCall':
      case 'InterfaceOperationCall':
        return expression.arguments
      case 'CompileError':
        return [expression.message]
      case 'CallableSection':
        return expression.captures.map((capture) => capture.value)
      case 'ForeignApply':
      case 'CallableApply':
        return expression.evaluation === 'LeftThenCallable'
          ? [...expression.arguments, expression.callee]
          : [expression.callee, ...expression.arguments]
      case 'EffectBlock':
        return expression.statements.flatMap(statementExpressions)
      case 'Run':
        return [expression.subject]
      case 'EffectBindRequirement':
        return [expression.protected]
      case 'EffectCatch':
        return [expression.protected, expression.handler]
      case 'Match':
        return [
          expression.scrutinee,
          ...expression.arms.flatMap((arm) => [
            ...(arm.guard === undefined ? [] : [arm.guard]),
            ...(arm.body._tag === 'Expression'
              ? [arm.body.expression]
              : arm.body.statements.flatMap(statementExpressions)),
          ]),
        ]
      case 'Unavailable':
        return expression.call?.arguments ?? []
      default:
        return []
    }
  })()

/** One expression and all of its semantic children in deterministic preorder. */
export const expressionTree = (expression: Expression): ReadonlyArray<Expression> => {
  // One output array: nested flatMap/spread copied every subtree once per ancestor.
  const tree: Array<Expression> = []
  const collect = (node: Expression): void => {
    tree.push(node)
    for (const child of expressionChildren(node)) collect(child)
  }
  collect(expression)
  return tree
}

/** Runtime-bearing expression children; sealed assembly metadata never acquires data storage. */
export const runtimeExpressionTree = (expression: Expression): ReadonlyArray<Expression> => {
  const tree: Array<Expression> = []
  const collect = (node: Expression): void => {
    tree.push(node)
    const children =
      node._tag === 'BuiltinCall' && node.operation === 'NativeAssembly'
        ? node.arguments.slice(6)
        : expressionChildren(node)
    for (const child of children) collect(child)
  }
  collect(expression)
  return tree
}

/** Reachable return operands in this execution boundary, including eager ordinary arms. */
export const returnExpressions = (body: ReadonlyArray<Statement>): ReadonlyArray<Expression> => {
  const returned: Array<Expression> = []
  const expression = (value: Expression): boolean => {
    if (value._tag === 'EffectBlock') return true
    if (value._tag === 'Match') {
      if (!expression(value.scrutinee)) return false
      let completes = false
      let remaining = [...value.members]
      for (const arm of value.arms) {
        const selected = remaining.filter(
          (candidate) =>
            arm.universal || (arm.member !== undefined && Match.selects(arm.member, candidate)),
        )
        if (!arm.reachable || selected.length === 0) continue
        const guardCompletes = arm.guard === undefined || expression(arm.guard)
        remaining = remaining.filter((candidate) =>
          arm.after.some((member) => Match.identityEquals(candidate, member)),
        )
        if (!guardCompletes && (arm.tests?.length ?? 0) === 0)
          remaining = remaining.filter((candidate) => !selected.includes(candidate))
        if (!guardCompletes) continue
        const normal =
          arm.body._tag === 'Expression'
            ? expression(arm.body.expression)
            : statements(arm.body.statements)
        completes ||= normal
      }
      return completes
    }
    if (value._tag === 'ShortCircuit') {
      if (!expression(value.left)) return false
      expression(value.right)
      return true
    }
    for (const child of expressionChildren(value)) if (!expression(child)) return false
    return value._tag === 'Unavailable' || !Type.isNever(value.type)
  }
  const statements = (items: ReadonlyArray<Statement>): boolean => {
    for (const statement of items) {
      if (statement._tag === 'Unsafe') {
        if (!statements(statement.statements)) return false
        continue
      }
      if (statement._tag === 'If' || statement._tag === 'IfLet') {
        if (
          !expression(statement._tag === 'If' ? statement.condition : statement.selection.subject)
        )
          return false
        const taken = statements(statement.taken)
        const otherwise = statements(statement.otherwise)
        if (!taken && !otherwise) return false
        continue
      }
      if (statement._tag === 'While') {
        if (!expression(statement.condition)) return false
        statements(statement.body)
        continue
      }
      for (const child of statementExpressions(statement)) if (!expression(child)) return false
      if (statement._tag === 'Return') {
        returned.push(statement.expression)
        return false
      }
      if (statement._tag === 'Fail' || statement._tag === 'Break' || statement._tag === 'Continue')
        return false
    }
    return true
  }
  statements(body)
  return returned
}

/** The first unavailable expression's cause and span, if the body has one. */
export const firstUnavailable = (
  self: TirFunction,
): { readonly span: SourceSpan.SourceSpan; readonly cause?: CauseRef } | undefined => {
  const walk = (
    expression: Expression,
  ): { readonly span: SourceSpan.SourceSpan; readonly cause?: CauseRef } | undefined => {
    switch (expression._tag) {
      case 'Unavailable':
        return expression
      case 'Move':
      case 'Project':
      case 'ReferentPlace':
        return walk(expression.subject)
      case 'RuntimeStringView':
        return walk(expression.source)
      case 'StringEquality':
      case 'EnumEquality':
      case 'ShortCircuit':
        return walk(expression.left) ?? walk(expression.right)
      case 'EnumValue':
        return walk(expression.value)
      case 'Replace':
        return walk(expression.value)
      case 'UnionConvert':
        return walk(expression.source)
      case 'IndexPlace':
        return walk(expression.subject) ?? walk(expression.index)
      case 'SliceLength':
        return walk(expression.slice)
      case 'SliceIndexPlace':
        return walk(expression.slice) ?? walk(expression.index)
      case 'Construct':
      case 'ConstructUnionVariant': {
        for (const field of expression.fields) {
          const found = walk(field.value)
          if (found !== undefined) return found
        }
        return undefined
      }
      case 'ArrayConstruct': {
        for (const element of expression.elements) {
          const found = walk(element)
          if (found !== undefined) return found
        }
        return undefined
      }
      case 'Call':
      case 'EffectConstruct':
      case 'ServiceEffectConstruct':
      case 'BuiltinCall':
      case 'InterfaceOperationCall': {
        for (const argument of expression.arguments) {
          const found = walk(argument)
          if (found !== undefined) return found
        }
        return undefined
      }
      case 'CallableSection': {
        for (const capture of expression.captures) {
          const found = walk(capture.value)
          if (found !== undefined) return found
        }
        return undefined
      }
      case 'ForeignApply':
      case 'CallableApply': {
        const callee = walk(expression.callee)
        if (callee !== undefined) return callee
        for (const argument of expression.arguments) {
          const found = walk(argument)
          if (found !== undefined) return found
        }
        return undefined
      }
      case 'Run':
        return walk(expression.subject)
      case 'EffectBindRequirement':
        return walk(expression.protected)
      case 'EffectCatch':
        return walk(expression.protected) ?? walk(expression.handler)
      case 'Match': {
        const scrutinee = walk(expression.scrutinee)
        if (scrutinee !== undefined) return scrutinee
        for (const arm of expression.arms) {
          const guard = arm.guard === undefined ? undefined : walk(arm.guard)
          if (guard !== undefined) return guard
          for (const expression of arm.body._tag === 'Expression'
            ? [arm.body.expression]
            : arm.body.statements.flatMap(statementExpressions)) {
            const result = walk(expression)
            if (result !== undefined) return result
          }
        }
        return undefined
      }
      default:
        return undefined
    }
  }
  for (const expression of self.statements.flatMap(statementExpressions)) {
    const found = walk(expression)
    if (found !== undefined) return found
  }
  return undefined
}

export type VerificationIssue =
  | { readonly _tag: 'CyclicExpression'; readonly span: SourceSpan.SourceSpan }
  | { readonly _tag: 'InvalidMatchArmOrder'; readonly span: SourceSpan.SourceSpan }
  | { readonly _tag: 'InvalidMatchCoverage'; readonly span: SourceSpan.SourceSpan }
  | { readonly _tag: 'InvalidMatchGuard'; readonly span: SourceSpan.SourceSpan }
  | { readonly _tag: 'InvalidMatchResult'; readonly span: SourceSpan.SourceSpan }
  | { readonly _tag: 'InvalidPatternBinding'; readonly span: SourceSpan.SourceSpan }
  | { readonly _tag: 'InvalidSliceBorrow'; readonly span: SourceSpan.SourceSpan }
  | { readonly _tag: 'InvalidValueBorrow'; readonly span: SourceSpan.SourceSpan }
  | { readonly _tag: 'InvalidStaticText'; readonly span: SourceSpan.SourceSpan }
  | { readonly _tag: 'InvalidSliceOperation'; readonly span: SourceSpan.SourceSpan }
  | { readonly _tag: 'InvalidStringView'; readonly span: SourceSpan.SourceSpan }
  | { readonly _tag: 'InvalidStringEquality'; readonly span: SourceSpan.SourceSpan }
  | { readonly _tag: 'InvalidEnumValue'; readonly span: SourceSpan.SourceSpan }
  | { readonly _tag: 'InvalidEnumEquality'; readonly span: SourceSpan.SourceSpan }
  | { readonly _tag: 'InvalidLoanEnd'; readonly span: SourceSpan.SourceSpan }
  | { readonly _tag: 'InvalidBorrowedWrite'; readonly span: SourceSpan.SourceSpan }

const sameMembers = (
  left: ReadonlyArray<Match.CoverageIdentity>,
  right: ReadonlyArray<Match.CoverageIdentity>,
): boolean =>
  left.length === right.length &&
  left.every((member, index) => {
    const other = right.at(index)
    return other !== undefined && Match.identityEquals(member, other)
  })

/** Verifies acyclic expression ownership and the canonical facts carried by structured matches. */
export const verify = (self: Module): ReadonlyArray<VerificationIssue> => {
  const issues: Array<VerificationIssue> = []
  const active = new Set<Expression>()
  const walk = (expression: Expression): void => {
    if (active.has(expression)) {
      issues.push({ _tag: 'CyclicExpression', span: expression.span })
      return
    }
    active.add(expression)
    if (
      (expression._tag === 'StaticStringLiteral' &&
        (expression.data.kind !== 'Text' ||
          !Lifetime.equals(expression.type.lifetime, Lifetime.staticLifetime))) ||
      (expression._tag === 'StaticByteViewLiteral' &&
        (expression.data.kind !== 'Bytes' ||
          !Type.equals(expression.type, Type.slice('Shared', 'u8', Lifetime.staticLifetime))))
    ) {
      issues.push({ _tag: 'InvalidStaticText', span: expression.span })
    }
    if (expression._tag === 'SliceBorrow') {
      const element = Type.isFixedArray(expression.source)
        ? expression.source.element
        : expression.source.element
      if (
        !Type.equals(
          expression.type,
          Type.slice(expression.access, element, expression.type.lifetime),
        ) ||
        expression.reborrow !== Type.isSlice(expression.source) ||
        (Type.isSlice(expression.source) &&
          expression.source.access === 'Shared' &&
          expression.access === 'Exclusive')
      ) {
        issues.push({ _tag: 'InvalidSliceBorrow', span: expression.span })
      }
    }
    if (expression._tag === 'ValueBorrow') {
      const sourceTarget =
        expression.reborrow && Type.isReference(expression.source)
          ? expression.source.target
          : expression.source
      if (
        !Type.equals(
          expression.type,
          Type.reference(expression.access, sourceTarget, expression.type.lifetime),
        ) ||
        expression.type.access !== expression.access ||
        expression.reborrow !== Type.isReference(expression.source) ||
        expression.suspendsParent !==
          (Type.isReference(expression.source) && expression.source.access === 'Exclusive') ||
        (Type.isReference(expression.source) &&
          expression.source.access === 'Shared' &&
          expression.access === 'Exclusive')
      ) {
        issues.push({ _tag: 'InvalidValueBorrow', span: expression.span })
      }
    }
    if (expression._tag === 'RuntimeStringView') {
      const begins = expressionTree(expression.source).flatMap((candidate) =>
        candidate._tag === 'SliceBorrow' || candidate._tag === 'ValueBorrow'
          ? [borrowKey(candidate.borrow)]
          : [],
      )
      const held = expression.heldLoans.map(borrowKey)
      if (
        expression.source._tag === 'Unavailable' ||
        !Type.isString(expression.type) ||
        !Type.equals(
          expression.source.type,
          Type.slice('Shared', 'u8', expression.type.lifetime),
        ) ||
        begins.length !== held.length ||
        begins.some((begin, ordinal) => begin !== held.at(ordinal)) ||
        new Set(held).size !== held.length
      ) {
        issues.push({ _tag: 'InvalidStringView', span: expression.span })
      }
    }
    if (
      expression._tag === 'StringEquality' &&
      (expression.left._tag === 'Unavailable' ||
        expression.right._tag === 'Unavailable' ||
        !Type.isString(expression.left.type) ||
        !Type.isString(expression.right.type) ||
        !Type.equals(expression.type, 'bool') ||
        expression.intrinsic.name !== 'stringEqualsExact')
    ) {
      issues.push({ _tag: 'InvalidStringEquality', span: expression.span })
    }
    if (expression._tag === 'EnumMember') {
      if (
        expression.enum.module !== expression.member.enum.module ||
        expression.enum.name !== expression.member.enum.name ||
        expression.type.module !== expression.enum.module ||
        expression.type.name !== expression.enum.name ||
        expression.type.arguments.length !== 0
      )
        issues.push({ _tag: 'InvalidEnumValue', span: expression.span })
    }
    if (
      expression._tag === 'EnumValue' &&
      (expression.value._tag === 'Unavailable' ||
        !Type.isNominal(expression.value.type) ||
        expression.value.type.module !== expression.enum.module ||
        expression.value.type.name !== expression.enum.name ||
        expression.intrinsic.actor !== 'Intrinsic' ||
        expression.intrinsic.name !== 'enumValue')
    )
      issues.push({ _tag: 'InvalidEnumValue', span: expression.span })
    if (
      expression._tag === 'EnumEquality' &&
      (expression.left._tag === 'Unavailable' ||
        expression.right._tag === 'Unavailable' ||
        !Type.isNominal(expression.left.type) ||
        !Type.isNominal(expression.right.type) ||
        expression.left.type.module !== expression.enum.module ||
        expression.left.type.name !== expression.enum.name ||
        expression.right.type.module !== expression.enum.module ||
        expression.right.type.name !== expression.enum.name ||
        !Type.equals(expression.type, 'bool'))
    )
      issues.push({ _tag: 'InvalidEnumEquality', span: expression.span })
    if (expression._tag === 'SliceLength') {
      if (
        expression.slice._tag === 'Unavailable' ||
        !Type.isSlice(expression.slice.type) ||
        !Type.equals(expression.type, 'usize')
      ) {
        issues.push({ _tag: 'InvalidSliceOperation', span: expression.span })
      }
    }
    if (expression._tag === 'SliceIndexPlace') {
      if (
        expression.slice._tag === 'Unavailable' ||
        !Type.equals(expression.slice.type, expression.sourceType) ||
        expression.index._tag === 'Unavailable' ||
        !Type.equals(expression.index.type, 'usize') ||
        expression.access !== expression.sourceType.access ||
        !Type.equals(expression.type, expression.sourceType.element)
      ) {
        issues.push({ _tag: 'InvalidSliceOperation', span: expression.span })
      }
    }
    if (expression._tag === 'ReferentPlace') {
      const subjectType =
        'type' in expression.subject && typeof expression.subject.type === 'object'
          ? expression.subject.type
          : undefined
      if (
        subjectType === undefined ||
        !Type.isReference(subjectType) ||
        !Type.equals(subjectType, expression.reference) ||
        expression.borrowAccess !== expression.reference.access ||
        !Type.equals(expression.type, expression.reference.target)
      ) {
        issues.push({ _tag: 'InvalidSliceOperation', span: expression.span })
      }
    }
    if (expression._tag === 'Project' && expression.borrowAccess !== undefined) {
      const subjectType =
        'type' in expression.subject && typeof expression.subject.type === 'object'
          ? expression.subject.type
          : undefined
      let inherited: Type.BorrowAccess | undefined
      if (expression.subject._tag === 'SliceIndexPlace') {
        inherited = expression.subject.access
      } else if (expression.subject._tag === 'Project') {
        inherited = expression.subject.borrowAccess
      } else if (subjectType !== undefined && Type.isReference(subjectType)) {
        inherited = subjectType.access
      }
      if (inherited !== expression.borrowAccess) {
        issues.push({ _tag: 'InvalidSliceOperation', span: expression.span })
      }
    }
    if (
      expression._tag === 'Call' ||
      expression._tag === 'BuiltinCall' ||
      expression._tag === 'InterfaceOperationCall' ||
      expression._tag === 'CallableApply' ||
      expression._tag === 'ForeignApply'
    ) {
      const begins = expression.arguments
        .flatMap(expressionTree)
        .filter(
          (
            candidate,
          ): candidate is Extract<Expression, { readonly _tag: 'SliceBorrow' | 'ValueBorrow' }> =>
            (candidate._tag === 'SliceBorrow' || candidate._tag === 'ValueBorrow') &&
            candidate.borrow.call.node.ordinal === expression.id?.ordinal,
        )
        .map((candidate) => borrowKey(candidate.borrow))
      const authoredEnds = [
        ...expression.loanEnds,
        ...(expression._tag === 'InterfaceOperationCall' || expression._tag === 'ForeignApply'
          ? []
          : expression.heldLoans),
      ]
      const ends = authoredEnds
        .filter((borrow) => borrow.call.node.ordinal === expression.id?.ordinal)
        .map(borrowKey)
      if (
        begins.length !== ends.length ||
        begins.some((begin, ordinal) => begin !== ends.at(ordinal)) ||
        new Set(authoredEnds.map(borrowKey)).size !== authoredEnds.length
      ) {
        issues.push({ _tag: 'InvalidLoanEnd', span: expression.span })
      }
    }
    if (expression._tag === 'Match') {
      const coverage = Match.cover(
        expression.members,
        expression.arms.map((arm) => ({
          ...(arm.member === undefined ? {} : { member: arm.member }),
          universal: arm.universal,
          guarded: arm.guard !== undefined,
          tests: arm.tests ?? [],
        })),
      )
      let remaining = [...expression.members]
      for (const [index, arm] of expression.arms.entries()) {
        const selected = remaining.filter(
          (candidate) =>
            arm.universal || (arm.member !== undefined && Match.selects(arm.member, candidate)),
        )
        const executes = selected.length > 0
        const transition = coverage.transitions.at(index)
        remaining = remaining.filter((candidate) =>
          transition?.after.some((member) => Match.identityEquals(candidate, member)),
        )
        if (
          arm.guard !== undefined &&
          arm.guard._tag !== 'Unavailable' &&
          Type.isNever(arm.guard.type) &&
          (arm.tests?.length ?? 0) === 0
        )
          remaining = remaining.filter((candidate) => !selected.includes(candidate))
        if (arm.id.ordinal !== index) {
          issues.push({ _tag: 'InvalidMatchArmOrder', span: arm.span })
        }
        if (
          transition === undefined ||
          transition.reachable !== arm.reachable ||
          !sameMembers(transition.before, arm.before) ||
          !sameMembers(transition.after, arm.after)
        ) {
          issues.push({ _tag: 'InvalidMatchCoverage', span: arm.span })
        }
        if (
          arm.guard !== undefined &&
          (arm.guard._tag === 'Unavailable' ||
            (!Type.equals(arm.guard.type, 'bool') && !Type.isNever(arm.guard.type)))
        ) {
          issues.push({ _tag: 'InvalidMatchGuard', span: arm.guard.span })
        }
        if (
          executes &&
          (arm.guard === undefined ||
            arm.guard._tag === 'Unavailable' ||
            !Type.isNever(arm.guard.type)) &&
          ((arm.body._tag === 'Expression' && arm.body.expression._tag === 'Unavailable') ||
            !TypeCompatibility.isCompatible(
              TypeCompatibility.check(arm.body.type, expression.type),
            ))
        ) {
          issues.push({ _tag: 'InvalidMatchResult', span: arm.body.span })
        }
        for (const binding of arm.bindings) {
          if (
            binding.id.ordinal < 0 ||
            binding.path.length === 0 ||
            binding.access !== expression.access
          ) {
            issues.push({ _tag: 'InvalidPatternBinding', span: binding.span })
          }
        }
      }
    }
    const children = expressionChildren(expression)
    for (const child of children) walk(child)
    active.delete(expression)
  }
  for (const fn of self.functions) {
    const visitedStatements = new Set<Statement>()
    const statements = (body: ReadonlyArray<Statement>): void => {
      for (const statement of body) {
        if (visitedStatements.has(statement)) continue
        visitedStatements.add(statement)
        for (const root of statementExpressions(statement))
          for (const expression of expressionTree(root)) {
            if (expression._tag === 'Match')
              for (const arm of expression.arms) {
                if (arm.body._tag === 'Block') statements(arm.body.statements)
              }
            else if (expression._tag === 'EffectBlock') statements(expression.statements)
          }
        if (statement._tag === 'Write' && statement.place._tag === 'BorrowedWritePlace') {
          const accesses: Array<Type.BorrowAccess> = []
          if (Type.isReference(statement.place.rootType))
            accesses.push(statement.place.rootType.access)
          if (Type.isSlice(statement.place.rootType)) {
            const first = statement.place.selectors.at(0)
            if (
              first?._tag !== 'SliceIndex' ||
              !Type.equals(first.slice, statement.place.rootType)
            ) {
              accesses.push('Shared')
            } else {
              accesses.push(statement.place.rootType.access)
            }
          }
          for (const selector of statement.place.selectors) {
            if (selector._tag === 'SliceIndex') accesses.push(selector.slice.access)
            else if (Type.isReference(selector.type)) accesses.push(selector.type.access)
          }
          const wellFormed = accesses.includes('Exclusive') && !accesses.includes('Shared')
          if (!wellFormed) {
            issues.push({ _tag: 'InvalidBorrowedWrite', span: statement.place.span })
          }
        }
        if (statement._tag === 'Unsafe') statements(statement.statements)
        else if (statement._tag === 'If') {
          statements(statement.taken)
          statements(statement.otherwise)
        } else if (statement._tag === 'While') statements(statement.body)
      }
    }
    statements(fn.statements)
    for (const expression of fn.statements.flatMap(statementExpressions)) walk(expression)
  }
  return issues
}

/** One module's elaborated TIR. */
export interface Module {
  readonly _tag: 'TirModule'
  readonly module: string
  readonly functions: ReadonlyArray<TirFunction>
}

/** Normalizes one header's contract, or keeps it explicitly unavailable with its cause. */
export const contractOf = (declaration: DeclarationFacts.DeclarationFact): ContractFact => {
  const parameters: Array<DeclarationFacts.SemanticType> = []
  for (const parameter of declaration.parameters) {
    if (parameter.phase === 'Static') continue
    if (parameter.declaredType._tag !== 'Resolved') {
      return {
        _tag: 'Unavailable',
        ...(parameter.declaredType._tag === 'Unresolved' &&
        parameter.declaredType.cause !== undefined
          ? { cause: parameter.declaredType.cause }
          : {}),
      }
    }
    parameters.push(parameter.declaredType.type)
  }
  if (declaration.returnType._tag !== 'Resolved') {
    return {
      _tag: 'Unavailable',
      ...(declaration.returnType._tag === 'Unresolved' && declaration.returnType.cause !== undefined
        ? { cause: declaration.returnType.cause }
        : {}),
    }
  }
  return {
    _tag: 'Contract',
    unsafe: declaration.unsafe,
    ...(declaration.functionKind === 'Effect'
      ? {
          functionKind: 'Effect' as const,
          failureRow: declaration.failureRow.row,
          requirementRow: declaration.requirementRow.row,
        }
      : {}),
    parameters: parameters,
    result: declaration.returnType.type,
    constraints: declaration.constraintContracts,
  }
}

/**
 * A node's place in the encoding: the authored node it came from, inside its owner. It names no
 * offset, so the encoding of a body is the same for every spelling of the same authored content.
 */
const anchorText = (anchor: AuthoredIdentity.Anchor | undefined): string =>
  anchor === undefined
    ? '@?'
    : `@${anchor.path.map((part) => `${part.role}#${part.occurrence}`).join('/') || '.'}`

const originText = (origin: Origin): string =>
  origin._tag === 'Authored'
    ? anchorText(origin.anchor)
    : `${anchorText(origin.anchor)}!${origin.role}#${origin.occurrence}`

const identityLabel = (declaration: DeclarationFacts.DeclarationFact): string => {
  switch (declaration.canonical._tag) {
    case 'Canonical':
      return `${declaration.canonical.id.module}.${declaration.canonical.id.name}`
    case 'Duplicate':
      return `duplicate:${declaration.canonical.original.module}.${declaration.canonical.original.name}#${declaration.id.ordinal}`
    case 'Unidentified':
      return `unidentified#${declaration.id.ordinal}`
  }
}

const contractText = (contract: ContractFact): string =>
  contract._tag === 'Contract'
    ? `(${contract.parameters.map(Type.encode).join(', ')}) -> ${Type.encode(contract.result)}`
    : 'contract-unavailable'

const sliceRootText = (root: SliceRoot): string => {
  switch (root._tag) {
    case 'BindingSliceRoot':
      return `l${root.binding.ordinal}`
    case 'ParameterSliceRoot':
      return `l${root.parameter.ordinal}`
    case 'PatternSliceRoot':
      return `l${root.binding.ordinal}`
    case 'TemporarySliceRoot':
      return `t${nodeRefKey(root.owner.node)}`
  }
}

const borrowSelectorsText = (selectors: ReadonlyArray<BorrowSelector>): string =>
  selectors
    .map((selector) => {
      if (selector._tag === 'Field') return `.#${selector.field.ordinal}`
      if (selector._tag === 'SliceIndex') return '[runtime/slice]'
      const index = selector.bounds._tag === 'Proven' ? selector.bounds.index : 'runtime'
      return `[${index}/${selector.array.length}]`
    })
    .join('')

const encodeExpression = (expression: Expression, depth: number): string => {
  const indent = '  '.repeat(depth)
  switch (expression._tag) {
    case 'IntegerLiteral':
      return `${indent}literal ${expression.value} : ${Type.encode(expression.type)}${expression.constant === undefined ? '' : ` constant=${expression.constant.module}::${expression.constant.name}`} ${originText(expression.origin)}`
    case 'ForeignStaticLoad':
      return `${indent}foreign-static ${expression.symbol} : ${Type.encode(expression.type)} ${originText(expression.origin)}`
    case 'ForeignFunctionAddress':
      return `${indent}foreign-address ${expression.symbol} : ${Type.encode(expression.type)} ${originText(expression.origin)}`
    case 'FloatingLiteral':
      return `${indent}literal ${expression.spelling} bits=0x${expression.bits.toString(16)} : ${expression.type} ${originText(expression.origin)}`
    case 'StaticStringLiteral':
      return `${indent}static-string ${expression.data.id} bytes=${expression.data.bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('')} length=${expression.data.bytes.length} provenance=program : string ${originText(expression.origin)}`
    case 'StaticByteViewLiteral':
      return `${indent}static-bytes ${expression.data.id} bytes=${expression.data.bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('')} length=${expression.data.bytes.length} : ${Type.encode(expression.type)} ${originText(expression.origin)}`
    case 'UnitLiteral':
      return `${indent}unit : () ${originText(expression.origin)}`
    case 'BooleanLiteral':
      return `${indent}literal ${expression.value} : ${Type.encode(expression.type)} ${originText(expression.origin)}`
    case 'CharacterLiteral':
      return `${indent}literal U+${expression.value.toString(16).toUpperCase().padStart(4, '0')} : ${Type.encode(expression.type)} ${originText(expression.origin)}`
    case 'ParameterReference':
      return `${indent}local l${expression.parameter.ordinal} : ${Type.encode(expression.type)} ${originText(expression.origin)}`
    case 'BindingReference':
    case 'PatternBindingReference':
      return `${indent}local l${expression.binding.ordinal} : ${Type.encode(expression.type)} ${originText(expression.origin)}`
    case 'Move':
      return [
        `${indent}move : ${Type.encode(expression.type)} ${originText(expression.origin)}`,
        encodeExpression(expression.subject, depth + 1),
      ].join('\n')
    case 'RuntimeStringView':
      return [
        `${indent}runtime-string-view loans=${expression.heldLoans.map(borrowKey).join(',') || 'none'} : string ${originText(expression.origin)}`,
        encodeExpression(expression.source, depth + 1),
      ].join('\n')
    case 'StringEquality':
      return [
        `${indent}string-${expression.negated ? 'not-equals' : 'equals'} intrinsic=${Intrinsic.operationText(expression.intrinsic)} : bool ${originText(expression.origin)}`,
        encodeExpression(expression.left, depth + 1),
        encodeExpression(expression.right, depth + 1),
      ].join('\n')
    case 'ShortCircuit':
      return [
        `${indent}short-circuit ${expression.operator === 'And' ? '&&' : '||'} : ${Type.encode(expression.type)} ${originText(expression.origin)}`,
        encodeExpression(expression.left, depth + 1),
        encodeExpression(expression.right, depth + 1),
      ].join('\n')
    case 'Replace':
      return [
        `${indent}replace : ${Type.encode(expression.type)} ${originText(expression.origin)}`,
        encodeExpression(expression.value, depth + 1),
      ].join('\n')
    case 'Run':
      return [
        `${indent}run : ${Type.encode(expression.type)} ${originText(expression.origin)}`,
        encodeExpression(expression.subject, depth + 1),
      ].join('\n')
    case 'EffectCatch':
      return [
        `${indent}effect-catch intrinsic=${Intrinsic.operationText(expression.intrinsic)} ${Type.encode(expression.selected)} protected=${RowAlgebra.encode(
          Type.failureRowPolicy(),
          expression.protectedRow,
          Type.encode,
          (parameter) => parameter.name,
          (member) => member.parameter.name,
        )} handler=${RowAlgebra.encode(
          Type.failureRowPolicy(),
          expression.handlerRow,
          Type.encode,
          (parameter) => parameter.name,
          (member) => member.parameter.name,
        )} residual=${RowAlgebra.encode(
          Type.failureRowPolicy(),
          expression.residualRow,
          Type.encode,
          (parameter) => parameter.name,
          (member) => member.parameter.name,
        )} : ${Type.encode(expression.type)} ${originText(expression.origin)}`,
        encodeExpression(expression.protected, depth + 1),
        encodeExpression(expression.handler, depth + 1),
      ].join('\n')
    case 'EffectBindRequirement':
      return [
        `${indent}effect-provide ${
          expression.provider.capability === undefined
            ? RowAlgebra.encode(
                Type.requirementRowPolicy(),
                expression.provider.selected,
                (member) => Type.encode(member.capability),
                (parameter) => parameter.name,
                (member) => member.capability.name,
              )
            : Type.encode(expression.provider.capability)
        }@${expression.provider.role ?? 'DefaultRole'} selection=${expression.provider.selectionAccess.toLowerCase()} capture=${expression.provider.captureAccess.toLowerCase()} : ${Type.encode(expression.type)} ${originText(expression.origin)}`,
        encodeExpression(expression.protected, depth + 1),
      ].join('\n')
    case 'EffectBlock':
      return [
        `${indent}effect-block site=${executableSiteLabel(expression.site)} access=${expression.type.access.toLowerCase()} captures=${expression.captures.map((capture) => `l${(capture.pattern ?? capture.binding ?? capture.parameter)?.ordinal ?? '?'}:${capture.access.toLowerCase()}`).join(',') || 'none'} : ${Type.encode(expression.type)} ${originText(expression.origin)}`,
        ...expression.statements.map((statement) => encodeStatement(statement, depth + 1)),
      ].join('\n')
    case 'UnionConvert':
      return [
        `${indent}union-${expression.conversion.toLowerCase()} ${Type.encode(expression.sourceType)} -> ${Type.encode(expression.target)} access=${expression.access} context=${expression.context} expected=${anchorText(expression.expected)} ${originText(expression.origin)}`,
        `${indent}  mapping ${expression.mappings.map((mapping) => `${Type.encode(mapping.source)}#${mapping.sourceOrdinal}->${Type.encode(mapping.target)}#${mapping.targetOrdinal}`).join(', ') || 'empty'}`,
        encodeExpression(expression.source, depth + 1),
      ].join('\n')
    case 'Match':
      return [
        `${indent}match ${expression.access.toLowerCase()} members=${expression.members.map(Match.encodeIdentity).join(',') || 'none'} : ${Type.encode(expression.type)} ${originText(expression.origin)}`,
        `${indent}  scrutinee`,
        encodeExpression(expression.scrutinee, depth + 2),
        ...expression.arms.flatMap((arm) => {
          let pattern = 'unknown'
          if (arm.universal) pattern = '_'
          else if (arm.member !== undefined) pattern = Match.encodeIdentity(arm.member)
          return [
            `${indent}  arm #${arm.id.ordinal} ${pattern} reachable=${arm.reachable} before=${arm.before.map(Match.encodeIdentity).join(',') || 'empty'} after=${arm.after.map(Match.encodeIdentity).join(',') || 'empty'} ${anchorText(arm.at)}`,
            ...arm.bindings.map(
              (binding) =>
                `${indent}    binding #${binding.id.ordinal} ${binding.name ?? '?'} path=${binding.path.map((field) => `#${field.ordinal}`).join('.') || 'root'} access=${binding.access} : ${Type.encode(binding.type)} ${originText(binding.origin)}`,
            ),
            `${indent}    cleanup ${arm.cleanup.map((path) => path.map((field) => `#${field.ordinal}`).join('.') || 'payload').join(',') || 'none'}`,
            ...(arm.guard === undefined
              ? []
              : [`${indent}    guard`, encodeExpression(arm.guard, depth + 3)]),
            `${indent}    result`,
            ...(arm.body._tag === 'Expression'
              ? [encodeExpression(arm.body.expression, depth + 3)]
              : [
                  `${indent}      block completes=${arm.body.completion.fallsThrough}`,
                  ...arm.body.statements.map((statement) => encodeStatement(statement, depth + 3)),
                ]),
          ]
        }),
      ].join('\n')
    case 'Construct':
      return [
        `${indent}construct ${Type.encode(expression.nominal)} : ${Type.encode(expression.type)} ${originText(expression.origin)}`,
        `${indent}  evaluation-order ${expression.evaluationOrder.map((field) => `#${field.ordinal}`).join(', ') || 'empty'}`,
        ...expression.fields.map(
          ({ field, value }) =>
            `${indent}  field #${field.ordinal}\n${encodeExpression(value, depth + 2)}`,
        ),
      ].join('\n')
    case 'ConstructUnionVariant':
      return [
        `${indent}construct-variant ${Type.encode(expression.nominal)}.${expression.variant.name}#${expression.variantOrdinal} : ${Type.encode(expression.type)} ${originText(expression.origin)}`,
        `${indent}  evaluation-order ${expression.evaluationOrder.map((field) => `#${field.ordinal}`).join(', ') || 'empty'}`,
        ...expression.fields.map(
          ({ field, value }) =>
            `${indent}  field #${field.ordinal}\n${encodeExpression(value, depth + 2)}`,
        ),
      ].join('\n')
    case 'ArrayConstruct':
      return [
        `${indent}construct-array ${Type.encode(expression.type)} elements=${expression.elements.length} ${originText(expression.origin)}`,
        ...expression.elements.map(
          (element, index) =>
            `${indent}  element #${index}\n${encodeExpression(element, depth + 2)}`,
        ),
      ].join('\n')
    case 'Project':
      return [
        `${indent}project ${expression.access} ${Type.encode(expression.nominal)}.#${expression.field.ordinal} : ${Type.encode(expression.type)} ${originText(expression.origin)}`,
        encodeExpression(expression.subject, depth + 1),
      ].join('\n')
    case 'ReferentPlace':
      return [
        `${indent}referent ${expression.access} ${expression.borrowAccess.toLowerCase()} source=${Type.encode(expression.reference)} : ${Type.encode(expression.type)} ${originText(expression.origin)}`,
        encodeExpression(expression.subject, depth + 1),
      ].join('\n')
    case 'IndexPlace':
      return [
        `${indent}index ${expression.access} ${Type.encode(expression.array)} bounds=${
          expression.bounds._tag === 'Runtime'
            ? `runtime:${expression.bounds.length}`
            : `proven:${expression.bounds.index}/${expression.bounds.length}`
        } : ${Type.encode(expression.type)} ${originText(expression.origin)}`,
        encodeExpression(expression.subject, depth + 1),
        encodeExpression(expression.index, depth + 1),
      ].join('\n')
    case 'SliceBorrow':
      return `${indent}${expression.reborrow ? 'reborrow-slice' : 'borrow-slice'} l${expression.borrow.ordinal} ${expression.access.toLowerCase()} ${sliceRootText(expression.root)}${borrowSelectorsText(expression.selectors)} source=${Type.encode(expression.source)} : ${Type.encode(expression.type)} suspended=${expression.suspendsParent} ${originText(expression.origin)}`
    case 'ValueBorrow':
      return `${indent}${expression.reborrow ? 'reborrow-value' : 'borrow-value'} l${expression.borrow.ordinal} ${expression.access.toLowerCase()} ${sliceRootText(expression.root)}${borrowSelectorsText(expression.selectors)} source=${Type.encode(expression.source)} : ${Type.encode(expression.type)} suspended=${expression.suspendsParent} ${originText(expression.origin)}`
    case 'SliceLength':
      return [
        `${indent}slice-length : i32 ${originText(expression.origin)}`,
        encodeExpression(expression.slice, depth + 1),
      ].join('\n')
    case 'SliceIndexPlace':
      return [
        `${indent}slice-index ${expression.access.toLowerCase()} bounds=runtime : ${Type.encode(expression.type)} ${originText(expression.origin)}`,
        encodeExpression(expression.slice, depth + 1),
        encodeExpression(expression.index, depth + 1),
      ].join('\n')
    case 'EnumMember':
      return `${indent}enum-member ${expression.member.enum.module}.${expression.member.enum.name}.${expression.member.name} discriminant=${expression.discriminant} : ${Type.encode(expression.type)} ${originText(expression.origin)}`
    case 'EnumValue':
      return [
        `${indent}enum-value ${expression.enum.module}.${expression.enum.name} via ${Intrinsic.operationText(expression.intrinsic)} : ${expression.type} ${originText(expression.origin)}`,
        encodeExpression(expression.value, depth + 1),
      ].join('\n')
    case 'EnumEquality':
      return [
        `${indent}enum-${expression.negated ? 'not-equals' : 'equals'} ${expression.enum.module}.${expression.enum.name} : bool ${originText(expression.origin)}`,
        encodeExpression(expression.left, depth + 1),
        encodeExpression(expression.right, depth + 1),
      ].join('\n')
    case 'FunctionItem':
      return `${indent}function-item ${
        expression.target._tag === 'DeclarationCallableTarget'
          ? `${expression.target.declaration.module}.${expression.target.declaration.name}`
          : `${expression.target.actor}.${expression.target.operation}`
      }<${expression.typeArguments.map(Type.genericArgumentKey).join(',')}> : ${Type.encode(expression.type)} ${originText(expression.origin)}`
    case 'CallableSection':
      return [
        `${indent}callable-section site=${executableSiteLabel(expression.site)} mode=${expression.mode.toLowerCase()} remaining=${expression.remainingParameters.map((ordinal) => `p${ordinal}`).join(',')} target=${
          expression.target._tag === 'DeclarationCallableTarget'
            ? `${expression.target.declaration.module}.${expression.target.declaration.name}`
            : `${expression.target.actor}.${expression.target.operation}`
        } : ${Type.encode(expression.type)} ${originText(expression.origin)}`,
        ...expression.captures.map(
          (capture) =>
            `${indent}  capture #${capture.ordinal}->p${capture.parameterOrdinal} ${capture.access.toLowerCase()}\n${encodeExpression(capture.value, depth + 2)}`,
        ),
      ].join('\n')
    case 'ForeignApply':
      return [
        `${indent}foreign-apply ${Type.encode(expression.contract)} ${originText(expression.origin)}`,
        encodeExpression(expression.callee, depth + 1),
        ...expression.arguments.map((argument) => encodeExpression(argument, depth + 1)),
      ].join('\n')
    case 'CallableApply':
      return [
        `${indent}callable-apply access=${expression.access.toLowerCase()} evaluation=${expression.evaluation} realization=${expression.realization}${expression.staged === undefined ? '' : ` staged=${executableSiteLabel(expression.staged.site)}[${expression.staged.captures.map((capture) => `#${capture.ordinal}:${capture.access.toLowerCase()}`).join(',')}]`} substitution=${[...expression.substitution.entries()].map(([parameter, argument]) => `${parameter}=${Type.encodeGenericArgument(argument)}`).join(',') || 'none'} ends=${expression.loanEnds.map(borrowKey).join(',') || 'none'} held=${expression.heldLoans.map(borrowKey).join(',') || 'none'} : ${Type.encode(expression.type)} ${originText(expression.origin)}`,
        ...(expression.evaluation === 'LeftThenCallable'
          ? [
              ...expression.arguments.map(
                (argument, ordinal) =>
                  `${indent}  argument #${ordinal}\n${encodeExpression(argument, depth + 2)}`,
              ),
              `${indent}  callee`,
              encodeExpression(expression.callee, depth + 2),
            ]
          : [
              `${indent}  callee`,
              encodeExpression(expression.callee, depth + 2),
              ...expression.arguments.map(
                (argument, ordinal) =>
                  `${indent}  argument #${ordinal}\n${encodeExpression(argument, depth + 2)}`,
              ),
            ]),
      ].join('\n')
    case 'Call':
    case 'EffectConstruct':
      return [
        `${indent}${expression._tag === 'EffectConstruct' ? 'effect-' : ''}call ${expression.target.module}.${expression.target.name}${
          expression.typeArguments.length === 0
            ? ''
            : `<${expression.typeArguments.map(Type.encodeGenericArgument).join(', ')}>`
        } evidence=e${expression.evidence.ordinal}${expression.staticArguments.length === 0 ? '' : ` static=${expression.staticArguments.map(StaticValue.presentation).join(',')}`} : ${Type.encode(expression.type)} loan-ends=${expression.loanEnds.map((loan) => `l${loan.ordinal}`).join(',') || 'none'} ${originText(expression.origin)}`,
        ...expression.arguments.map((argument) => encodeExpression(argument, depth + 1)),
      ].join('\n')
    case 'ServiceEffectConstruct':
      return [
        `${indent}service-call ${Type.encode(expression.service)}.${expression.operation}@${expression.role}:${expression.access.toLowerCase()}${expression.staticArguments.length === 0 ? '' : ` static=${expression.staticArguments.map(StaticValue.presentation).join(',')}`} : ${Type.encode(expression.type)} loan-ends=${expression.loanEnds.map((loan) => `l${loan.ordinal}`).join(',') || 'none'} ${originText(expression.origin)}`,
        ...expression.arguments.map((argument) => encodeExpression(argument, depth + 1)),
      ].join('\n')
    case 'BuiltinCall': {
      const first = expression.arguments.at(0)
      const actor =
        first === undefined || first._tag === 'Unavailable' ? '?' : Type.encode(first.type)
      return [
        `${indent}builtin ${actor}.${expression.operation} : ${Type.encode(expression.type)} ${originText(expression.origin)}`,
        ...expression.arguments.map((argument) => encodeExpression(argument, depth + 1)),
      ].join('\n')
    }
    case 'InterfaceOperationCall':
      return [
        `${indent}interface ${Type.encode(expression.capability)}.${expression.operation} over ${Type.encode(expression.provider)} : ${Type.encode(expression.type)} ${originText(expression.origin)}`,
        ...expression.arguments.map((argument) => encodeExpression(argument, depth + 1)),
      ].join('\n')
    case 'CompileError':
      return [
        `${indent}compile-error ${originText(expression.origin)}`,
        encodeExpression(expression.message, depth + 1),
      ].join('\n')
    case 'StaticCall':
      return [
        `${indent}static-call ${expression.target.module}::${expression.target.name}${expression.typeArguments.length === 0 ? '' : `<${expression.typeArguments.map(Type.encodeGenericArgument).join(',')}>`} : ${Type.encode(expression.type)} ${originText(expression.origin)}`,
        ...expression.arguments.map((argument) => encodeExpression(argument, depth + 1)),
      ].join('\n')
    case 'StaticIntrinsic':
      return [
        `${indent}static-intrinsic ${expression.operation}${expression.typeArguments.length === 0 ? '' : `<${expression.typeArguments.map(Type.encodeGenericArgument).join(',')}>`} : ${Type.encode(expression.type)} ${originText(expression.origin)}`,
        ...expression.arguments.map((argument) => encodeExpression(argument, depth + 1)),
      ].join('\n')
    case 'ConstantReference':
      return `${indent}constant ${expression.declaration.module}::${expression.declaration.name} : ${Type.encode(expression.type)} ${originText(expression.origin)}`
    case 'Unavailable':
      return `${indent}unavailable ${originText(expression.origin)}`
  }
}

const encodeStatement = (statement: Statement, depth: number): string => {
  const indent = '  '.repeat(depth)
  switch (statement._tag) {
    case 'UnavailableStatement':
      return `${indent}unavailable-statement r${statement.region.ordinal} ${originText(statement.origin)}`
    case 'Unsafe':
      return [
        `${indent}unsafe r${statement.region.ordinal} ${originText(statement.origin)}`,
        ...statement.statements.map((inner) => encodeStatement(inner, depth + 1)),
      ].join('\n')
    case 'Bind':
      return [
        `${indent}bind ${statement.mutability.toLowerCase()} l${statement.binding.ordinal} ${statement.name ?? '?'} r${statement.region.ordinal} ${originText(statement.origin)}`,
        encodeExpression(statement.initializer, depth + 1),
      ].join('\n')
    case 'PatternBind':
      return `${indent}pattern-bind ${statement.selection.access.toLowerCase()} members=${statement.selection.members.map(Match.encodeIdentity).join(',')} r${statement.region.ordinal} ${originText(statement.origin)}`
    case 'Evaluate':
      return [
        `${indent}evaluate r${statement.region.ordinal} ${originText(statement.origin)}`,
        encodeExpression(statement.expression, depth + 1),
      ].join('\n')
    case 'Write': {
      let root: string
      if (statement.place._tag === 'WritePlace') {
        if (statement.place.root._tag === 'BindingWriteRoot')
          root = `b${statement.place.root.binding.ordinal}`
        else if (statement.place.root._tag === 'PatternWriteRoot')
          root = `pattern${statement.place.root.binding.ordinal}`
        else root = `p${statement.place.root.parameter.ordinal}`
      } else {
        root =
          statement.place.root._tag === 'BindingSliceRoot'
            ? `slice-b${statement.place.root.binding.ordinal}`
            : `slice-p${statement.place.root.parameter.ordinal}`
      }
      const selectors = statement.place.selectors
        .map((selector) => {
          if (selector._tag === 'Field') return `.#${selector.field.ordinal}`
          if (selector._tag === 'SliceIndex') return '[runtime/slice]'
          const index = selector.bounds._tag === 'Proven' ? selector.bounds.index : 'runtime'
          return `[${index}/${selector.array.length}]`
        })
        .join('')
      return [
        `${indent}write ${root}${selectors} : ${Type.encode(statement.place.type)} r${statement.region.ordinal} ${originText(statement.origin)}`,
        encodeExpression(statement.value, depth + 1),
      ].join('\n')
    }
    case 'If':
      return [
        `${indent}if r${statement.region.ordinal} ${originText(statement.origin)}`,
        encodeExpression(statement.condition, depth + 1),
        `${indent}then`,
        ...statement.taken.map((inner) => encodeStatement(inner, depth + 1)),
        ...(statement.otherwise.length === 0
          ? []
          : [
              `${indent}else`,
              ...statement.otherwise.map((inner) => encodeStatement(inner, depth + 1)),
            ]),
      ].join('\n')
    case 'IfLet':
      return [
        `${indent}if-let ${statement.selection.access.toLowerCase()} members=${statement.selection.members.map(Match.encodeIdentity).join(',')} r${statement.region.ordinal} ${originText(statement.origin)}`,
        ...statement.taken.map((inner) => encodeStatement(inner, depth + 1)),
        ...statement.otherwise.map((inner) => encodeStatement(inner, depth + 1)),
      ].join('\n')
    case 'While':
      return [
        `${indent}while loop${statement.loop.ordinal} r${statement.region.ordinal}${statement.parent === undefined ? '' : ` parent=loop${statement.parent.ordinal}`} ${originText(statement.origin)}`,
        encodeExpression(statement.condition, depth + 1),
        ...statement.body.map((inner) => encodeStatement(inner, depth + 1)),
      ].join('\n')
    case 'Break':
    case 'Continue':
      return `${indent}${statement._tag.toLowerCase()} loop${statement.target.ordinal} r${statement.region.ordinal} ${originText(statement.origin)}`
    case 'Return':
      return [
        `${indent}return r${statement.region.ordinal} ${originText(statement.origin)}`,
        encodeExpression(statement.expression, depth + 1),
      ].join('\n')
    case 'Fail':
      return [
        `${indent}fail ${Type.encode(statement.failure)} r${statement.region.ordinal} ${originText(statement.origin)}`,
        encodeExpression(statement.expression, depth + 1),
      ].join('\n')
    case 'Drop':
      return [
        `${indent}drop r${statement.region.ordinal} ${originText(statement.origin)}`,
        encodeExpression(statement.expression, depth + 1),
      ].join('\n')
  }
}

/**
 * Deterministic textual encoding of one module's completed TIR for debugging, inspection, and
 * golden tests. No compatibility promise attaches to this format.
 */
export const encode = (self: Module): string =>
  [
    `tir-module ${self.module}`,
    ...self.functions.flatMap((fn) => [
      `fn ${identityLabel(fn.declaration)}${
        fn.declaration.typeParameters.length === 0
          ? ''
          : `<${fn.declaration.typeParameters.map((parameter) => Type.key(parameter.type)).join(',')}>`
      } ${contractText(fn.contract)} entry=r${fn.entryRegion.ordinal} regions=${fn.regionOrder.map((region) => `r${region.ordinal}`).join(',')}`,
      ...fn.statements.map((statement) => encodeStatement(statement, 1)),
    ]),
    '',
  ].join('\n')

/** Each position a body holds, and the authored node beside it that says where it is. */
const presented: ReadonlyArray<readonly [span: string, anchor: string]> = [
  ['span', 'at'],
  ['loanEnd', 'loanEndAt'],
  ['expectedAt', 'expected'],
]

/**
 * Stamps a body's positions for one revision.
 *
 * A checked body names authored nodes. Stages that still work in source coordinates read the spans
 * beside those nodes, and a span is only ever this function of its node and the current
 * presentation: a reused body is presented again and nothing in it is matched against the revision
 * it was built in. The declaration is the current header of the same id.
 *
 * ponytail: walks the whole body, types included; present per node kind if this shows in profiles.
 */
export const present = (
  self: TirFunction,
  spanOf: (anchor: AuthoredIdentity.Anchor) => SourceSpan.SourceSpan,
  declaration: DeclarationFacts.DeclarationFact = self.declaration,
): TirFunction => ({ ...stamp({ ...self, declaration: undefined }, spanOf), declaration })

/** Stamps every position in a value that has its authored node beside it. */
export const stamp = <A>(
  self: A,
  spanOf: (anchor: AuthoredIdentity.Anchor) => SourceSpan.SourceSpan,
): A => {
  const copies = new WeakMap<object, unknown>()
  const visit = (input: unknown): unknown => {
    if (typeof input !== 'object' || input === null) return input
    if (input instanceof Map || input instanceof Set || SourceSpanModule.isSourceSpan(input))
      return input
    const known = copies.get(input)
    if (known !== undefined) return known
    if (Array.isArray(input)) {
      const items: Array<unknown> = []
      copies.set(input, items)
      for (const item of input) items.push(visit(item))
      return items
    }
    const source = input as Readonly<Record<string, unknown>>
    const result: Record<string, unknown> = {}
    copies.set(input, result)
    for (const key of Object.keys(source)) result[key] = visit(source[key])
    const origin = source['origin'] as Origin | undefined
    for (const [span, anchor] of presented) {
      const at = source[anchor] as AuthoredIdentity.Anchor | undefined
      if (at !== undefined && span in source) result[span] = spanOf(at)
    }
    // A node's own position comes from its origin, whatever else it names.
    if (origin?.anchor !== undefined && 'span' in source) result['span'] = spanOf(origin.anchor)
    return result
  }
  // The walk rebuilds the same shape and changes only spans that have an anchor beside them.
  return visit(self) as A
}
